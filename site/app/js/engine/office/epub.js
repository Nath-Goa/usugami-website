// EPUB e-books to PDF: a port of the app's EpubConverter.kt (and the EPUB parts of
// OfficeConverter.kt). The book's documents are laid out in reading order, each starting on a new
// page, on A5 or A4 pages with book-like margins and type. The cover comes first, on a page of its
// own; the table of contents becomes the PDF's bookmarks; the title, author and language go into
// the PDF. Fixed-layout books (comics, picture books) get one page per document, as best they can.
// See epub-html.js for what is read from each document.
//
// index.js (convertOffice('epub', ...)) is the way in for screens: it checks the file with
// verifyEpub, calls convertEpub and turns every problem into the app's message.
import { ZipArchive } from './zip.js';
import { OfficePdf, OfficeImages, ImagePicture } from './office-pdf.js';
import { StackBlock, Spaced } from './blocks.js';
import { Border, CellBox, RowBlock, TableBlock } from './tables.js';
import { OfficeNothingToConvert } from './problems.js';
import { paperSize } from './office-formats.js';
import { officeOutputName } from './index.js';
import { EpubBook, rethrowCancel } from './epub-book.js';
import { XhtmlReader, BookPara, BookImage, BookTable, BookRule, BookBreak, Align } from './epub-html.js';
import { SimpleCss, HtmlText, breather } from './epub-formats.js';
import { layoutParagraph, measureText, fitPictures } from '../text/layout.js';
import { addOutline } from '../text/canvas.js';
import { firstStrong } from '../text/bidi.js';
import { imageFileType, IMAGE_MIME } from '../images/image-type.js';
import { readImageInfo } from '../images/image-meta.js';
import { checkCancelled } from '../../core/errors.js';

const BUFFER = 48;
const FIXED_BUFFER = 1000;
const MAX_CSS = 512 * 1024;
const BORDER = 0xff9e9e9e;
const HEADER = 0xfff0f0f0;
const MAX_TITLE = 500;
/** How deep bookmarks go: deeper than any book's contents, and a crafted one can't exhaust the stack. */
const MAX_OUTLINE_DEPTH = 64;
/** The start of a picture read for its size; more only when its size comes later in the file. */
const IMAGE_HEAD = 256 * 1024;

/** A bookmark in the PDF: its title, the page (0-based) and how far down it, in PDF points from the bottom. */
export class OutlineItem {
  constructor(title, page, top, children) {
    this.title = title;
    this.page = page;
    this.top = top;
    this.children = children;
  }
}

/** What goes into the PDF besides its pages: bookmarks, and the book's title, author and language. */
export class BookInfo {
  constructor(outline, title, author, language) {
    this.outline = outline;
    this.title = title;
    this.author = author;
    this.language = language;
  }

  /** Writes this into `doc` (a pdf-lib document), which has the book's pages. */
  applyTo(doc) {
    const pages = doc.getPageCount();
    if (this.outline.length && pages > 0) {
      const item = (it) => ({
        title: it.title.slice(0, MAX_TITLE),
        page: Math.min(pages - 1, Math.max(0, it.page)),
        top: Math.round(it.top),
        children: it.children.map(item),
      });
      addOutline(doc, this.outline.map(item));
    }
    if (this.title != null) doc.setTitle(this.title.slice(0, MAX_TITLE));
    if (this.author != null) doc.setAuthor(this.author.slice(0, MAX_TITLE));
    if (this.language != null) doc.setLanguage(this.language.slice(0, 35));
  }
}

/** A picture on a line of its own, `x` points from the left. */
class PictureBlock {
  constructor(picture, width, height, x) {
    this.picture = picture;
    this.width = width;
    this.height = height;
    this.x = x;
  }

  draw(canvas, x, y) {
    this.picture.draw(canvas, { x: x + this.x, y, width: this.width, height: this.height });
  }

  split(space, force) {
    return force ? [this, null] : null;
  }
}

/** A short centred line, as books show a horizontal rule. */
class RuleBlock {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  draw(canvas, x, y) {
    canvas.save();
    canvas.strokeStyle = BORDER;
    canvas.lineWidth = 0.6;
    canvas.lineCap = 'butt';
    canvas.setLineDash([]);
    const middle = y + this.height / 2;
    canvas.beginPath();
    canvas.moveTo(x + this.width * 0.35, middle);
    canvas.lineTo(x + this.width * 0.65, middle);
    canvas.stroke();
    canvas.restore();
  }

  split(space, force) {
    return force ? [this, null] : null;
  }
}

class Placed {
  constructor(block, before, keepNext, ids) {
    this.block = block;
    this.before = before;
    this.keepNext = keepNext;
    this.ids = ids;
  }
}

/** The ids of the elements starting with this entry and, for a table, those in its cells: they lead to its top. */
function allIds(entry) {
  const out = [];
  const stack = [entry];
  while (stack.length) {
    const e = stack.pop();
    out.push(...e.ids);
    if (e.item instanceof BookTable) {
      const inner = [];
      for (const row of e.item.rows) for (const cell of row) for (const it of cell.items) inner.push(it);
      for (let i = inner.length - 1; i >= 0; i--) stack.push(inner[i]);
    }
  }
  return out;
}

const putIfAbsent = (map, key, value) => {
  if (!map.has(key)) map.set(key, value);
};

/**
 * Lays a book out into `pdf` (an OfficePdf): the app's EpubConverter. `pageSize` is
 * { width, height } in points, portrait; `check()` throws to cancel; `progress(chapter, total)`;
 * `signal` (optional) stops reading the zip.
 */
export class EpubConverter {
  constructor(zip, book, pdf, images, pageSize, check, progress, signal = null) {
    this.zip = zip;
    this.signal = signal;
    this.book = book;
    this.pdf = pdf;
    this.images = images;
    this.check = check;
    this.progress = progress;
    const shortSide = Math.min(pageSize.width, pageSize.height);
    const longSide = Math.max(pageSize.width, pageSize.height);
    const small = shortSide < 500;
    this.portrait = [shortSide, longSide];
    /** The book's font size, in points: a paperback's on A5, a little bigger on A4. */
    this.base = small ? 11 : 12;
    this.marginX = small ? 44 : 66;
    this.marginTop = small ? 46 : 64;
    this.marginBottom = small ? 52 : 72;
    this.pageW = shortSide;
    this.pageH = longSide;
    this.anchors = new Map();
    this.headings = [];
    this.sheets = new Map();
    this.sizes = new Map();
    this.coverDrawn = false;
    this.coverDocument = null;
    this.breathe = breather();

    // Pages
    this.canvas = null;
    this.top = 0;
    this.bottom = 0;
    this.y = 0;
    this.empty = true;
    /** At the top of a page, space before a block is kept only after a break the book asked for. */
    this.keepSpaceBefore = true;
    this.breakBeforeNext = false;
    this.pending = [];
    this.documentPath = '';
    /** A document whose first block hasn't been placed yet, and earlier ones that had nothing to show. */
    this.documentStart = null;
    this.emptyDocuments = [];
  }

  get textW() {
    return this.pageW - 2 * this.marginX;
  }

  get textH() {
    return this.pageH - this.marginTop - this.marginBottom;
  }

  get left() {
    return this.marginX;
  }

  /** Converts the book; returns what goes into the PDF besides the pages (a BookInfo). */
  async convert() {
    // Documents read only when linked to (notes, say) go after the main text, rather than nowhere.
    const spine = this.book.spine;
    const documents = [...spine.filter((d) => d.linear), ...spine.filter((d) => !d.linear)];
    const coverPath = this.book.coverImage;
    const cover = coverPath && (await this.imageSize(coverPath)) ? coverPath : null;
    for (let index = 0; index < documents.length; index++) {
      this.check();
      this.progress(index + 1, documents.length);
      await this.convertDocument(documents[index], index === 0, cover);
      await this.breathe();
    }
    this.finish();
    if (this.pdf.pageCount === 0) throw new OfficeNothingToConvert();
    if (this.coverDocument != null && this.coverDrawn) putIfAbsent(this.anchors, this.coverDocument, { page: 0, top: this.pageH });
    const toc = await this.book.toc(this.zip, this.check);
    let outline = this.outline(toc, 0);
    if (!outline.length) {
      outline = [];
      for (const [path, title] of this.headings) {
        const a = this.anchors.get(path);
        if (a) outline.push(new OutlineItem(title, a.page, a.top, []));
      }
    }
    return new BookInfo(outline, this.book.title, this.book.creator, this.book.language);
  }

  outline(entries, depth) {
    const out = [];
    for (const entry of entries) {
      const children = depth < MAX_OUTLINE_DEPTH ? this.outline(entry.children, depth + 1) : [];
      const path = entry.path;
      const anchor = path == null ? null : (entry.fragment != null ? this.anchors.get(`${path}#${entry.fragment}`) : null) ?? this.anchors.get(path) ?? null;
      // An entry that leads nowhere in the PDF gives way to its children.
      if (!anchor || !entry.title) out.push(...children);
      else out.push(new OutlineItem(entry.title, anchor.page, anchor.top, children));
    }
    return out;
  }

  async convertDocument(document, first, cover) {
    if (document.mediaType.startsWith('image/')) {
      // A picture straight in the reading order, as some comics have.
      const pixels = await this.imageSize(document.path);
      if (!pixels) return;
      if (document.path === cover) {
        // The cover again, read only when linked to: it is drawn already.
        if (!document.linear && this.coverDrawn) {
          this.coverDocument = document.path;
          return;
        }
        this.coverDrawn = true;
      }
      this.startDocument(document.path);
      await this.fullPage(document.path, pixels[0], pixels[1], []);
      return;
    }
    const buffered = first || !document.linear || document.fixed;
    let buffer = [];
    let streaming = !buffered;
    const showsCover = () => buffer.some((e) => e.item instanceof BookImage && e.item.path === cover);
    // The first document shows the cover, or it goes on a page of its own before it.
    const coverFirst = async () => {
      if (first && cover != null && !this.coverDrawn) {
        if (showsCover()) this.coverDrawn = true;
        else await this.drawCover(cover);
      }
    };
    const stream = async () => {
      await coverFirst();
      streaming = true;
      this.startDocument(document.path);
      const held = buffer;
      buffer = [];
      for (const entry of held) await this.add(entry);
    };
    if (streaming) this.startDocument(document.path);
    const reader = new XhtmlReader(
      document.path, this.base, this.textW, (path) => this.sheet(path), (path) => this.imageSize(path), this.images, this.check,
      async (entry) => {
        if (streaming) {
          await this.add(entry);
        } else {
          buffer.push(entry);
          // A long document is no cover or picture page: on with it, without holding it all. A
          // fixed-layout page is held whole, to be shrunk onto its page, unless it is a book's worth.
          if (buffer.length > (document.fixed ? FIXED_BUFFER : BUFFER)) await stream();
        }
      },
    );
    const bytes = await this.read(document.path);
    if (bytes) await reader.read(bytes);
    if (reader.firstHeading != null) this.headings.push([document.path, reader.firstHeading]);
    if (streaming) return;
    const content = buffer.filter((e) => e.item !== BookBreak);
    const picturesOnly = content.length > 0 && content.every((e) => e.item instanceof BookImage);
    if (!document.linear && picturesOnly && content.every((e) => e.item.path === cover) && this.coverDrawn) {
      // A cover page read only when linked to: the cover is drawn already.
      this.coverDocument = document.path;
    } else if (document.fixed) {
      await coverFirst();
      this.startDocument(document.path);
      await this.fixedPage(content, reader.viewport);
    } else if (first && picturesOnly) {
      // The cover page: its pictures fill the page. Pictures that aren't the cover (a title page,
      // say) get the cover before them, as a first document of text does.
      await coverFirst();
      this.startDocument(document.path);
      for (const entry of content) await this.fullPage(entry.item.path, entry.item.width, entry.item.height, entry.ids);
    } else {
      await stream();
    }
    if (first && showsCover()) this.coverDocument = document.path;
  }

  /** A document's bytes, or null when it can't be read (a damaged entry: no fault of the book's other documents). */
  async read(path) {
    try {
      return await this.zip.bytes(path, { signal: this.signal });
    } catch (e) {
      rethrowCancel(e);
      return null;
    }
  }

  async drawCover(path) {
    const pixels = await this.imageSize(path);
    if (!pixels) return;
    await this.fullPage(path, pixels[0], pixels[1], []);
    this.coverDrawn = true;
  }

  /** The style sheet at `path` (its first 512 KB), or null. */
  sheet(path) {
    let found = this.sheets.get(path);
    if (!found) {
      found = (async () => {
        try {
          const bytes = await this.zip.bytes(path, { maxBytes: MAX_CSS });
          if (!bytes) return null;
          let text = new TextDecoder('utf-8').decode(bytes);
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
          return SimpleCss.parse(text);
        } catch (e) {
          rethrowCancel(e);
          return null;
        }
      })();
      this.sheets.set(path, found);
    }
    return found;
  }

  /** The size in pixels of the picture at `path`, [width, height], or null when it can't be drawn (an SVG, say). */
  imageSize(path) {
    let found = this.sizes.get(path);
    if (!found) {
      found = pictureSize(this.zip, path).catch((e) => {
        rethrowCancel(e);
        return null;
      });
      this.sizes.set(path, found);
    }
    return found;
  }

  // ---- Pages ----

  startDocument(path) {
    this.flushPending();
    if (this.documentStart != null) this.emptyDocuments.push(this.documentStart);
    this.documentStart = path;
    this.documentPath = path;
    this.breakBeforeNext = true;
  }

  async add(entry) {
    this.check();
    if (entry.item === BookBreak) {
      this.flushPending();
      this.breakBeforeNext = true;
      return;
    }
    const block = await this.block(entry.item, this.textW);
    if (!block) return;
    const ids = allIds(entry).map((id) => `${this.documentPath}#${id}`);
    const keepNext = entry.item instanceof BookPara && entry.item.heading > 0;
    this.place(new Placed(block, entry.before, keepNext, ids));
    await this.breathe();
  }

  place(item) {
    if (this.breakBeforeNext) {
      this.breakBeforeNext = false;
      if (this.canvas && !this.empty) this.newPage(false);
      this.keepSpaceBefore = true;
    }
    // Headings go with what follows them: they move on to the next page together.
    if (item.keepNext && this.pending.length < 4) {
      this.pending.push(item);
      return;
    }
    if (this.pending.length) {
      this.ensurePage();
      let need = item.before + Math.min(item.block.height, this.base * 4);
      for (const p of this.pending) need += p.before + p.block.height;
      if (!this.empty && this.y + need > this.bottom && need <= this.textH) this.newPage(true);
      this.flushPending();
    }
    this.put(item);
  }

  flushPending() {
    const waiting = this.pending;
    this.pending = [];
    for (const item of waiting) this.put(item);
  }

  put(item) {
    this.ensurePage();
    let gap = this.empty ? (this.keepSpaceBefore ? Math.min(item.before, this.textH / 3) : 0) : item.before;
    let block = item.block;
    let first = true;
    for (;;) {
      const space = this.bottom - this.y - gap;
      if (block.height <= space + 0.001) {
        this.draw(block, item, gap, first);
        this.y += gap + block.height;
        break;
      }
      let parts = block.split(space, this.empty);
      // Nothing fits on an empty page: the block goes on it anyway, rather than on page after page.
      if (!parts && this.empty) parts = [block, null];
      if (!parts) {
        this.newPage(true);
        gap = 0;
        continue;
      }
      this.draw(parts[0], item, gap, first);
      first = false;
      const rest = parts[1];
      if (!rest) {
        this.y += gap + parts[0].height;
        break;
      }
      this.newPage(true);
      gap = 0;
      block = rest;
    }
    this.empty = false;
  }

  draw(block, item, gap, first) {
    const c = this.canvas;
    if (!c) return;
    if (first) this.mark(item.ids, this.y + gap);
    block.draw(c, this.left, this.y + gap);
  }

  /** Remembers where the elements `ids` start (`at` points down the page), and the document, for bookmarks. */
  mark(ids, at) {
    const page = this.pdf.pageCount;
    if (this.documentStart != null) {
      const start = { page, top: this.pageH };
      putIfAbsent(this.anchors, this.documentStart, start);
      for (const d of this.emptyDocuments) putIfAbsent(this.anchors, d, start);
      this.emptyDocuments = [];
      this.documentStart = null;
    }
    if (ids.length) {
      const anchor = { page, top: this.pageH - at };
      for (const id of ids) putIfAbsent(this.anchors, id, anchor);
    }
  }

  ensurePage() {
    if (!this.canvas) this.startPage();
  }

  newPage(natural) {
    this.finishPage();
    this.startPage();
    this.keepSpaceBefore = !natural;
  }

  startPage() {
    this.check();
    this.canvas = this.pdf.startPage(this.pageW, this.pageH);
    this.top = this.marginTop;
    this.bottom = this.pageH - this.marginBottom;
    this.y = this.top;
    this.empty = true;
  }

  finishPage() {
    if (!this.canvas) return;
    this.canvas = null;
    this.pdf.finishPage();
  }

  finish() {
    this.flushPending();
    this.finishPage();
    if (this.documentStart != null) this.emptyDocuments.push(this.documentStart);
    this.documentStart = null;
    if (this.pdf.pageCount > 0) {
      for (const d of this.emptyDocuments) putIfAbsent(this.anchors, d, { page: this.pdf.pageCount - 1, top: this.pageH });
    }
    this.emptyDocuments = [];
  }

  /** A picture filling a page of its own, such as the cover: `width` × `height` in any unit, for its shape. */
  async fullPage(path, width, height, ids) {
    this.flushPending();
    this.finishPage();
    const scale = Math.min(this.pageW / width, this.pageH / height);
    const w = width * scale;
    const h = height * scale;
    const x = (this.pageW - w) / 2;
    const yTop = (this.pageH - h) / 2;
    const picture = await new ImagePicture(this.images, path, w, h, null).load();
    const c = this.pdf.startPage(this.pageW, this.pageH);
    this.canvas = c;
    this.mark(ids.map((id) => `${this.documentPath}#${id}`), 0);
    picture.draw(c, { x, y: yTop, width: w, height: h });
    this.finishPage();
    this.breakBeforeNext = false;
    this.empty = true;
  }

  /**
   * A fixed-layout document on one page: a single picture fills it; anything else is laid out and,
   * when it doesn't fit, shrunk until it does. The page turns sideways for a landscape `viewport`.
   */
  async fixedPage(content, viewport) {
    this.flushPending();
    this.finishPage();
    const landscape = viewport != null && viewport[0] > viewport[1];
    this.pageW = landscape ? this.portrait[1] : this.portrait[0];
    this.pageH = landscape ? this.portrait[0] : this.portrait[1];
    try {
      if (!content.length) return;
      const single = content.length === 1 && content[0].item instanceof BookImage ? content[0].item : null;
      if (single) {
        await this.fullPage(single.path, single.width, single.height, content[0].ids);
        return;
      }
      const textWidth = this.textW;
      const textHeight = this.textH;
      let width = textWidth;
      let stack = await this.stack(content, width);
      let scale = 1;
      if (stack.height > textHeight) {
        scale = textHeight / stack.height;
        width = textWidth / scale;
        stack = await this.stack(content, width);
        scale = Math.min(textWidth / width, textHeight / Math.max(0.1, stack.height));
      }
      this.startPage();
      const ids = [];
      for (const e of content) for (const id of allIds(e)) ids.push(`${this.documentPath}#${id}`);
      this.mark(ids, this.top);
      const c = this.canvas;
      c.save();
      c.translate(this.left, this.top);
      c.scale(scale, scale);
      stack.draw(c, 0, 0);
      c.restore();
      this.finishPage();
      this.breakBeforeNext = false;
    } finally {
      this.pageW = this.portrait[0];
      this.pageH = this.portrait[1];
    }
  }

  // ---- Blocks ----

  async stack(entries, width) {
    const items = [];
    for (const e of entries) {
      const b = await this.block(e.item, width);
      if (b) items.push(new Spaced(b, e.before, 0));
    }
    return new StackBlock(items);
  }

  async block(item, width) {
    if (item instanceof BookPara) return this.paragraph(item, width);
    if (item instanceof BookImage) return this.picture(item, width);
    if (item instanceof BookTable) return this.table(item, width);
    if (item instanceof BookRule) return new RuleBlock(width, this.base * 1.2);
    return null;
  }

  async paragraph(item, width) {
    const s = item.style;
    const text = item.text;
    // Right to left as the book says, or as its first letter reads, which is how the layout takes it.
    const rtl = s.rtl || firstStrong(text.text) === true;
    // Indents on the side the paragraph starts and ends on. One that reads right to left starts on
    // the right: its list and quote indents, its first line's indent and its label go there (see
    // the layout's `mirrored`), while margins stay on their side.
    const start = rtl ? s.right - s.end + s.start : s.left;
    const end = rtl ? s.left - s.start + s.end : s.right;
    let label = null;
    if (item.label) {
      const [labelText, style] = item.label;
      const measured = await measureText(labelText, style);
      const x = start - measured.width - style.size * 0.45;
      label = { text: labelText, style, x: Math.max(0, x) };
    }
    const firstIndent = Math.max(0, start + s.textIndent);
    // Left and right are the other way round from the start and end of a paragraph that reads right to left.
    let align = s.align;
    if (rtl && s.physical) {
      if (align === Align.START) align = Align.END;
      else if (align === Align.END) align = Align.START;
    }
    const pictures = text.pictures;
    if (pictures.length) await Promise.all(pictures.map((p) => p.load()));
    return layoutParagraph({
      // A picture in a line of text is never wider than the line, as e-book readers show it.
      text: fitPictures(text.rich(), width - Math.max(firstIndent, start) - end),
      base: item.base,
      width,
      align,
      firstIndent,
      indent: start,
      rightIndent: end,
      label,
      rtl: s.rtl,
      mirrored: rtl,
    });
  }

  async picture(item, width) {
    const s = item.style;
    const available = Math.max(1, width - s.left - s.right);
    let w = Math.min(available, item.share != null ? item.share * available : item.width);
    let h = (item.height * w) / Math.max(0.001, item.width);
    const most = this.textH * 0.98;
    if (h > most) {
      w *= most / h;
      h = most;
    }
    const x = s.left + (available - w) / 2;
    const picture = await new ImagePicture(this.images, item.path, w, h, null).load();
    return new PictureBlock(picture, Math.max(0.1, w), Math.max(0.1, h), x);
  }

  async table(item, width) {
    const s = item.style;
    let most = 1;
    for (const row of item.rows) {
      let n = 0;
      for (const cell of row) n += cell.span;
      most = Math.max(most, n);
    }
    const columns = Math.min(64, Math.max(1, most));
    // Columns share the width by how much text they hold.
    const weights = new Array(columns).fill(0);
    const occupied = new Array(columns).fill(0);
    const placedRows = item.rows.map((row) => {
      let c = 0;
      const placed = [];
      for (const cell of row) {
        while (c < columns && occupied[c] > 0) c++;
        if (c >= columns) continue;
        const span = Math.min(cell.span, columns - c);
        let length = 0;
        for (const e of cell.items) length += e.item instanceof BookPara ? e.item.text.length : 12;
        for (let k = c; k < c + span; k++) weights[k] = Math.max(weights[k], Math.min(length, 400) / span);
        if (cell.rowSpan > 1) for (let k = c; k < c + span; k++) occupied[k] = cell.rowSpan;
        placed.push([c, span, cell]);
        c += span;
      }
      for (let k = 0; k < columns; k++) if (occupied[k] > 0) occupied[k]--;
      return placed;
    });
    const available = Math.max(1, width - s.left - s.right);
    const widths = HtmlText.columnWidths(weights, available);
    const starts = [0];
    for (const w of widths) starts.push(starts[starts.length - 1] + w);
    const pad = this.base * 0.3;
    const border = new Border(0.5, BORDER);
    const rows = [];
    for (const row of placedRows) {
      const cells = [];
      for (const [at, span, cell] of row) {
        const cellWidth = starts[at + span] - starts[at];
        const inner = Math.max(0.1, cellWidth - 2 * pad);
        const content = [];
        for (const e of cell.items) {
          const b = await this.block(e.item, inner);
          if (b) content.push(new Spaced(b, e.before, 0));
        }
        cells.push(new CellBox({
          x: s.left + starts[at], width: cellWidth, content: content.length ? new StackBlock(content) : null,
          fill: cell.header ? HEADER : null, top: border, left: border, bottom: border, right: border,
          verticalAlign: 0, padLeft: pad, padTop: pad, padRight: pad, padBottom: pad,
        }));
      }
      rows.push(new RowBlock(cells, 0, false));
    }
    let headerRows = 0;
    while (headerRows < item.rows.length && item.rows[headerRows].length && item.rows[headerRows].every((c) => c.header)) headerRows++;
    if (headerRows >= item.rows.length) headerRows = 0;
    return new TableBlock(rows, headerRows, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Pictures' sizes

/**
 * The size in pixels of the picture `path` in `zip` as [width, height], read from its header (as
 * Android's BitmapFactory reads bounds), or null when it isn't one the browser can draw: SVG
 * drawings, damaged files, and HEIF or AVIF pictures this browser can't decode.
 */
async function pictureSize(zip, path) {
  let bytes = await zip.bytes(path, { maxBytes: IMAGE_HEAD });
  if (!bytes || !bytes.length) return null;
  const type = imageFileType(bytes.subarray(0, 64));
  if (!type) return null;
  let info = readImageInfo(bytes, type);
  if (!(info.width > 0 && info.height > 0) && bytes.length >= IMAGE_HEAD) {
    bytes = await zip.bytes(path);
    info = readImageInfo(bytes, type);
  }
  let size = info.width > 0 && info.height > 0 ? [info.width, info.height] : null;
  // Formats not every browser decodes, and headers that didn't say: decoded once to see.
  if (!size || type === 'heif' || type === 'avif') {
    if (bytes.length >= IMAGE_HEAD) bytes = (await zip.bytes(path)) ?? bytes;
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: IMAGE_MIME[type] }));
      size ??= [bitmap.width, bitmap.height];
      bitmap.close?.();
    } catch {
      return null;
    }
  }
  return size && size[0] > 0 && size[1] > 0 ? size : null;
}

// ---------------------------------------------------------------------------------------------
// The way in

/** The page a book is laid out on: 'a5' (the default, about a paperback's) or 'a4'. */
function bookPage(options) {
  const id = options?.pageSize ?? options?.bookPage;
  return id === 'a4' ? 'a4' : 'a5';
}

/**
 * The app's check of an e-book when it is picked or shared (EpubBook.read): resolves when `input`
 * ({ name, bytes }) is an EPUB that can be converted. Throws EpubProtected (DRM),
 * OfficeNotRecognized (not an EPUB, or damaged) or OfficeNothingToConvert (nothing in its reading
 * order), from problems.js; CancelledError when `hooks.signal` aborts.
 */
export async function verifyEpub(input, hooks = {}) {
  const check = () => checkCancelled(hooks.signal);
  const zip = ZipArchive.open(input.bytes);
  try {
    await EpubBook.read(zip, check);
  } finally {
    zip.close();
  }
}

/**
 * Converts the e-book `input` ({ name, bytes }) into a PDF on `options.pageSize` ('a5', the default,
 * or 'a4'; `bookPage`, as index.js passes it, is read too), named `options.name` (without ".pdf";
 * default the book's file name). `hooks`: { onProgress(chapter, chapters), signal }; last comes
 * onProgress(pages, pages, { compressing: true }) while the PDF is saved.
 * Resolves to an OutputFile { name, bytes, type: 'application/pdf', pageCount }. Throws the
 * problems.js errors (EpubProtected, OfficeNotRecognized, OfficeNothingToConvert), ZipError for a
 * zip that can't be read, CancelledError; convertOffice('epub', ...) turns these into the app's
 * messages.
 */
export async function convertEpub(input, options = {}, hooks = {}) {
  const { signal, onProgress } = hooks;
  const check = () => checkCancelled(signal);
  check();
  const zip = ZipArchive.open(input.bytes);
  try {
    const book = await EpubBook.read(zip, check);
    const pdf = await OfficePdf.create();
    const images = new OfficeImages(zip, pdf.doc, { signal });
    const converter = new EpubConverter(zip, book, pdf, images, paperSize(bookPage(options)), check, (chapter, total) => onProgress?.(chapter, total), signal);
    const info = await converter.convert();
    check();
    info.applyTo(pdf.doc);
    const { bytes, pageCount } = await pdf.finish({ onProgress, signal });
    return { name: officeOutputName(input, 'epub', options?.name ?? null), bytes, type: 'application/pdf', pageCount };
  } finally {
    zip.close();
  }
}
