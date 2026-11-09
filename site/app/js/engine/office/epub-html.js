// One XHTML document of a book, read forgivingly into the items a page is made of: a port of the
// app's EpubHtml.kt (BlockStyle, the Book* items and XhtmlReader). Items are handed on as they are
// read, so a long chapter needn't be held whole. Lengths are in points.
import { ListNumbering } from './office-formats.js';
import {
  CssNode, CssSheet, CssValues, EpubPaths, HtmlText, SimpleCss, ktInt, ktFloat, ktTrim, isKtWhitespace,
  codePointBefore, breather,
} from './epub-formats.js';
import { LenientXml, START_TAG, END_TAG, TEXT, END_DOCUMENT } from './epub-xml.js';
import { ImagePicture } from './office-pdf.js';
import { RichText, OBJECT } from '../text/layout.js';
import { resolveStyle } from '../text/fonts.js';
import { rethrowCancel } from './epub-book.js';

const Format = ListNumbering.Format;

/** How a paragraph's lines sit across: 'start', 'center', 'end' or 'justify' (the app's Align). */
export const Align = Object.freeze({ START: 'start', CENTER: 'center', END: 'end', JUSTIFY: 'justify' });

/**
 * Where a block of a book goes across the page, from its HTML and CSS. Indents in points: `left`
 * and `right` hold `start` and `end`, the indents of lists and block quotes, which go on the side a
 * paragraph starts and ends on (right and left for one that reads right to left). `align`'s start
 * and end are the left and right when `physical` (CSS's text-align: left and right), the
 * paragraph's own start and end otherwise.
 */
export class BlockStyle {
  constructor(align, left, right, textIndent, rtl, physical = false, start = 0, end = 0) {
    this.align = align;
    this.left = left;
    this.right = right;
    this.textIndent = textIndent;
    this.rtl = rtl;
    this.physical = physical;
    this.start = start;
    this.end = end;
  }
}

/**
 * A paragraph's text as it is read: runs of text (and inline pictures) with their resolved styles,
 * turned into the text engine's RichText by rich().
 */
export class BookText {
  constructor() {
    this.text = '';
    /** [{ start, end, style, obj? }] */
    this.runs = [];
  }

  get length() {
    return this.text.length;
  }

  /** Whether there's anything but spaces: an inline picture counts. */
  get hasContent() {
    const t = this.text;
    for (let i = 0; i < t.length; i++) if (!isKtWhitespace(t.charCodeAt(i))) return true;
    return false;
  }

  append(s, style) {
    if (!s) return;
    const start = this.text.length;
    this.text += s;
    const last = this.runs[this.runs.length - 1];
    if (last && !last.obj && last.style === style && last.end === start) last.end = this.text.length;
    else this.runs.push({ start, end: this.text.length, style });
  }

  /** A picture (or any other object) drawn inline, as one character. */
  appendObject(obj, style) {
    const start = this.text.length;
    this.text += OBJECT;
    this.runs.push({ start, end: start + 1, style, obj });
  }

  /** Cuts the text to its first `length` characters. */
  truncate(length) {
    if (length >= this.text.length) return;
    this.text = this.text.slice(0, length);
    while (this.runs.length && this.runs[this.runs.length - 1].start >= length) this.runs.pop();
    const last = this.runs[this.runs.length - 1];
    if (last && last.end > length) last.end = length;
  }

  toString() {
    return this.text;
  }

  /** The pictures in the text, to load before it is laid out. */
  get pictures() {
    return this.runs.filter((r) => r.obj?.picture).map((r) => r.obj.picture);
  }

  /** The text engine's RichText of it. */
  rich() {
    const rich = new RichText();
    for (const r of this.runs) {
      if (r.obj) rich.appendObject(r.obj, r.style);
      else rich.append(this.text.slice(r.start, r.end), r.style);
    }
    return rich;
  }
}

/** A paragraph, heading (`heading` 1 to 6) or list item (with its `label`: [text, style]). */
export class BookPara {
  constructor(text, style, base, label, heading) {
    this.text = text;
    this.style = style;
    this.base = base;
    this.label = label;
    this.heading = heading;
  }
}

/** A picture on a line of its own: `width` × `height` points at its natural size, or a `share` of the width the CSS asks for. */
export class BookImage {
  constructor(path, width, height, share, style) {
    this.path = path;
    this.width = width;
    this.height = height;
    this.share = share;
    this.style = style;
  }
}

export class BookTable {
  constructor(rows, style) {
    this.rows = rows;
    this.style = style;
  }
}

export class BookCell {
  constructor(items, span, rowSpan, header) {
    this.items = items;
    this.span = span;
    this.rowSpan = rowSpan;
    this.header = header;
  }
}

/** A horizontal rule (hr), often a scene break. */
export class BookRule {
  constructor(style) {
    this.style = style;
  }
}

/** A page break the book's CSS asks for. */
export const BookBreak = Object.freeze({ break: true });

/** An item with the space to leave above it, in points, and the ids of the elements that start with it. */
export class BookEntry {
  constructor(item, before, ids) {
    this.item = item;
    this.before = before;
    this.ids = ids;
  }
}

const SPLIT_AT = 12000;
const MAX_STYLE = 256 * 1024;
const HIGHLIGHT = 0xfffff59d;
const BULLETS = ['•', '◦', '▪'];
const EMPTY = Object.freeze(Object.create(null));

/** Elements that are always empty. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SKIPPED = new Set([
  'script', 'noscript', 'template', 'iframe', 'video', 'audio', 'canvas', 'button', 'select', 'textarea',
  'map', 'rt', 'rp', 'datalist', 'dialog', 'colgroup', 'title',
  // A formula's TeX or other source beside the MathML shown, and MathML in epub:switch, whose fallback is shown.
  'annotation', 'annotation-xml', 'case',
]);
const BLOCKS = new Set([
  'html', 'body', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre',
  'section', 'article', 'aside', 'header', 'footer', 'nav', 'figure', 'figcaption', 'address', 'center', 'main', 'hgroup',
  'details', 'summary', 'fieldset', 'legend', 'form', 'table', 'caption', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
  'listing', 'xmp', 'plaintext',
]);
const IGNORED = new Set(['wbr', 'col', 'input', 'area', 'source', 'track', 'embed', 'param', 'meta', 'link', 'base']);
const BOLD = new Set(['b', 'strong', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th', 'dt']);
const ITALIC = new Set(['i', 'em', 'cite', 'dfn', 'var', 'address']);
const MONO = new Set(['code', 'tt', 'kbd', 'samp', 'pre', 'listing', 'xmp', 'plaintext']);
const PRE = new Set(['pre', 'listing', 'xmp', 'plaintext']);
const CENTERED = new Set(['center', 'th', 'caption', 'figcaption']);
const UA_SIZES = {
  h1: 1.8, h2: 1.5, h3: 1.25, h4: 1.1, h5: 1, h6: 0.9,
  small: 0.85, big: 1.15, figcaption: 0.9, code: 0.92, tt: 0.92, kbd: 0.92, samp: 0.92, pre: 0.9,
};
/** Space above and below, in em of the element's own font size. */
const UA_MARGINS = {
  p: 0.5, h1: 0.8, h2: 0.8, h3: 0.8, h4: 0.8, h5: 0.8, h6: 0.8,
  blockquote: 0.6, ul: 0.5, ol: 0.5, dl: 0.5, li: 0.15, pre: 0.5, figure: 0.6, address: 0.5, fieldset: 0.5,
};
/** Indents on the start side (for block quotes, both sides), in em: see BlockStyle. */
const UA_INDENTS = { blockquote: 1.5, ul: 1.8, ol: 1.8, dd: 1.8, figure: 0 };
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);

/** Formatting inherited from the elements around. Sizes and indents in points. */
class Inherited {
  constructor(fields) {
    this.font = 'serif';
    this.size = 11;
    this.bold = false;
    this.italic = false;
    this.underline = false;
    this.strike = false;
    this.baseline = 0;
    this.highlight = false;
    this.align = Align.START;
    /** Whether `align` is CSS's left or right: see BlockStyle.physical. */
    this.physical = false;
    this.textIndent = 0;
    this.left = 0;
    this.right = 0;
    /** The parts of `left` and `right` that go on a paragraph's start and end side: see BlockStyle. */
    this.start = 0;
    this.end = 0;
    this.pre = false;
    this.rtl = false;
    this.heading = 0;
    this.listFormat = Format.BULLET;
    Object.assign(this, fields);
    this.style = null;
  }

  copy(changes) {
    const out = Object.assign(Object.create(Inherited.prototype), this, changes);
    out.style = null;
    return out;
  }

  /** The text style (resolved for the text engine), made once. */
  text() {
    this.style ??= resolveStyle({
      font: this.font, size: this.size, bold: this.bold, italic: this.italic, underline: this.underline,
      strike: this.strike, baseline: this.baseline, background: this.highlight ? HIGHLIGHT : null,
    });
    return this.style;
  }

  /** A list label's style: the text's, without lines or a raise. */
  labelStyle() {
    return resolveStyle({
      font: this.font, size: this.size, bold: this.bold, italic: this.italic, underline: false,
      strike: false, baseline: 0, background: this.highlight ? HIGHLIGHT : null,
    });
  }
}

class Frame {
  constructor(node, inherited, block, end = null) {
    this.node = node;
    this.inherited = inherited;
    this.block = block;
    this.end = end;
  }
}

/** Kotlin's toIntOrNull of a trimmed attribute. */
const intAttr = (v) => (v == null ? null : ktInt(ktTrim(v)));

/**
 * Reads one XHTML document of a book, forgivingly, into BookEntry items handed to `sink` as they
 * are read, so a long chapter needn't fit in memory. Understood: headings, paragraphs, line breaks,
 * bold, italic, underlined and struck text, superscripts, lists, block quotes, definition lists,
 * preformatted text, simple tables, pictures (also in SVG covers), rules, and links as text; from
 * CSS (linked, in style elements or attributes, with simple selectors): text-align, font-weight,
 * font-style, font-size, font-family's generic family, text-decoration, text-indent, vertical
 * margins and side margins, display:none, list-style-type, white-space and page breaks. Scripts,
 * forms, audio and video are left out.
 *
 * new XhtmlReader(path, base, textWidth, sheet, imageSize, images, check, sink):
 *   path        the document's path in the book (links and pictures are found from it)
 *   base        the book's font size, in points
 *   textWidth   the width of the text, in points: what CSS percentages are of
 *   sheet       async (path) => CssSheet | null: a linked style sheet
 *   imageSize   async (path) => [width, height] pixels, or null when it can't be drawn (such as SVG)
 *   images      the OfficeImages pictures in text are drawn from (null when imageSize always gives null)
 *   check       () => void, throws to cancel
 *   sink        async (BookEntry) => void
 */
export class XhtmlReader {
  constructor(path, base, textWidth, sheet, imageSize, images, check, sink) {
    this.path = path;
    this.base = base;
    this.textWidth = textWidth;
    this.sheetSource = sheet ?? (async () => null);
    this.sizeSource = imageSize ?? (async () => null);
    this.images = images;
    this.check = check ?? (() => {});
    this.sink = sink;
    this.sheetCache = new Map();
    this.sizeCache = new Map();
    this.breathe = breather();

    /** A fixed-layout page's size, from the viewport in the document's head: [width, height] or null. */
    this.viewport = null;
    /** The document's first main heading (h1 to h3), for bookmarks when the book has no table of contents. */
    this.firstHeading = null;

    this.root = new Inherited({ font: 'serif', size: base });
    this.frames = [];
    this.sheets = [];
    /** How the document's lines run, as its root or body says (see CssValues.acrossFromVertical); null when neither says. */
    this.writingMode = null;
    /** The html element's font size, which rem lengths are of, and its style attribute. */
    this.rem = base;
    this.rootStyle = null;

    // Parts of the document that are skipped or read differently, by how deep in them the reader is.
    this.skip = 0;
    this.headDepth = 0;
    this.svgDepth = 0;
    this.styleDepth = 0;
    this.styleText = '';

    // The paragraph being read.
    this.para = null;
    this.paraStyle = this.root;
    this.paraIds = [];
    this.paraContinued = false;
    this.afterSpace = true;
    /** Where the paragraph ends in a space made of a line break after a Chinese or Japanese character; -1 when it doesn't. */
    this.wideBreakAt = -1;

    /** Space before the next item, the largest of the margins met since the last one (as CSS collapses them). */
    this.space = 0;
    this.pendingIds = [];
    this.label = null;
    this.lists = [];
    this.tables = [];
    /** Where items go inside table cells and captions; the sink otherwise. */
    this.sinks = [];
    this.outbox = [];
    this.sinkFailure = null;
  }

  /** Reads the document from `bytes`. A part that can't be parsed ends it: what came before is kept. */
  async read(bytes) {
    try {
      const p = new LenientXml(bytes);
      let events = 0;
      for (;;) {
        if (++events % 256 === 0) {
          this.check();
          await this.breathe();
        }
        const type = p.next();
        if (type === END_DOCUMENT) break;
        if (type === START_TAG) {
          await this.prefetch(p);
          this.start(p);
        } else if (type === END_TAG) {
          this.end(p.localName().toLowerCase());
        } else if (type === TEXT) {
          this.text(p.text);
        }
        if (this.outbox.length) await this.drain();
      }
    } catch (e) {
      rethrowCancel(e);
      // The pages couldn't be made (the fonts couldn't be loaded, say): that's no fault of the document's.
      if (e === this.sinkFailure) throw e;
      // Malformed beyond what the parser forgives.
    }
    this.skip = 0;
    this.headDepth = 0;
    this.svgDepth = 0;
    this.styleDepth = 0;
    while (this.frames.length) this.frames.pop().end?.();
    this.flushPara();
    await this.drain();
  }

  /** Hands what was read to the sink; its failures read() lets through rather than taking them for the document's. */
  async drain() {
    const out = this.outbox;
    let i = 0;
    try {
      while (i < out.length) await this.sink(out[i++]);
    } catch (e) {
      this.sinkFailure = e;
      throw e;
    } finally {
      out.splice(0, i);
    }
  }

  /** Loads the style sheet or picture size a start tag needs, so start() can find it at once. */
  async prefetch(p) {
    if (this.skip > 0 || this.styleDepth > 0) return;
    const tag = p.localName().toLowerCase();
    if (tag === 'link') {
      if (!isStyleSheet(p)) return;
      const target = linkTarget(this.path, p.attr('href'));
      if (target != null && !this.sheetCache.has(target)) this.sheetCache.set(target, (await this.sheetSource(target)) ?? null);
    } else if (tag === 'img' || tag === 'image' || tag === 'object') {
      for (const name of ['src', 'href', 'data']) {
        const target = linkTarget(this.path, p.attr(name));
        if (target != null && !this.sizeCache.has(target)) this.sizeCache.set(target, (await this.sizeSource(target)) ?? null);
      }
    }
  }

  imageSize(target) {
    return this.sizeCache.get(target) ?? null;
  }

  get current() {
    const f = this.frames;
    return f.length ? f[f.length - 1].inherited : this.root;
  }

  get currentBlock() {
    const f = this.frames;
    for (let i = f.length - 1; i >= 0; i--) if (f[i].block) return f[i].inherited;
    return this.root;
  }

  start(p) {
    const tag = p.localName().toLowerCase();
    // An empty element written HTML-style (<br>, <meta>) has no end tag: it isn't counted.
    if (this.skip > 0) {
      if (!VOID.has(tag)) this.skip++;
      return;
    }
    if (this.styleDepth > 0) {
      this.styleDepth++;
      return;
    }
    if (tag === 'style') {
      this.styleDepth = 1;
      this.styleText = '';
      return;
    }
    // A missing </head> doesn't hide the body.
    if (this.headDepth > 0 && tag === 'body') this.headDepth = 0;
    if (this.headDepth > 0) {
      if (!VOID.has(tag)) this.headDepth++;
      this.head(tag, p);
      return;
    }
    if (tag === 'head') {
      this.headDepth = 1;
      return;
    }
    if (this.svgDepth > 0) {
      this.svgDepth++;
      if (tag === 'image') this.image(p, this.current, EMPTY, true);
      return;
    }
    if (tag === 'body') this.restyleRoot();
    const parent = this.frames[this.frames.length - 1] ?? null;
    const inheritedFrom = this.current;
    const idText = p.attr('id');
    const id = idText != null && ktTrim(idText) ? ktTrim(idText) : null;
    const classes = new Set((p.attr('class') ?? '').split(/[ \t\n]/).filter((c) => c));
    const node = new CssNode(tag, id, classes, parent?.node ?? null);
    const inline = p.attr('style');
    if (tag === 'html') this.rootStyle = inline;
    const cascaded = !this.sheets.length && (inline == null || !ktTrim(inline)) ? EMPTY : CssSheet.cascade(node, this.sheets, inline);
    // A book written in columns down the page says so on its root or body; its margins are then turned to suit lines across it.
    if (tag === 'html' || tag === 'body') {
      const mode = CssValues.writingMode(cascaded);
      if (mode != null) this.writingMode = mode;
    }
    const css = CssValues.acrossFromVertical(cascaded, this.writingMode);
    const display = css.display != null ? css.display.toLowerCase() : null;
    // An empty element (a hidden picture, say) has no inside to skip: it is just left out.
    if (SKIPPED.has(tag) || display === 'none' || p.attr('hidden') != null) {
      if (!VOID.has(tag)) this.skip = 1;
      return;
    }
    // Older books mark places with <a name="...">, which links lead to as they do to an id.
    const anchors = [];
    if (id != null) anchors.push(id);
    const nameText = p.attr('name');
    const name = nameText != null ? ktTrim(nameText) : null;
    if (name && tag === 'a' && name !== id) anchors.push(name);
    let block;
    if (display === 'block' || display === 'list-item' || display === 'table' || display === 'flex' || display === 'grid') block = true;
    else if (display === 'inline' || display === 'inline-block') block = false;
    else block = BLOCKS.has(tag);
    if (anchors.length) {
      // A block (or rule) starts below the paragraph being read: that one ends first, so its place isn't taken for the block's.
      if (block || tag === 'hr') this.flushPara();
      (this.para ? this.paraIds : this.pendingIds).push(...anchors);
    }
    if (tag === 'svg') {
      this.svgDepth = 1;
      return;
    }
    const inherited = this.inherit(tag, inheritedFrom, css, p, block);
    switch (tag) {
      case 'img':
        this.image(p, inherited, css, false);
        return;
      case 'br':
        this.startPara();
        this.para.append('\n', inheritedFrom.text());
        this.afterSpace = true;
        // Text split into lines with line breaks (a whole book in one paragraph, say) goes on as a new paragraph at one.
        if (this.para.length > SPLIT_AT) this.flushPara(true);
        return;
      case 'hr':
        this.flushPara();
        this.space = Math.max(this.space, 0.5 * inherited.size);
        this.emit(new BookRule(this.blockStyle(inherited)));
        this.space = Math.max(this.space, 0.5 * inherited.size);
        return;
      case 'object': {
        // An object shows its picture when it is one that can be drawn; else, as in a browser, what
        // it holds in its place (the PNG or the words standing in for an SVG chart, say).
        const data = p.attr('data');
        const target = data != null ? EpubPaths.resolve(this.path, data)?.[0] : null;
        if (target != null && this.imageSize(target) != null) {
          this.image(p, inherited, css, false, data);
          this.skip = 1;
          return;
        }
        break;
      }
      case 'q':
        this.appendText('“', inherited);
        this.frames.push(new Frame(node, inherited, false, () => this.appendText('”', inherited)));
        return;
      default:
        if (IGNORED.has(tag)) return;
    }
    const table = this.tables[this.tables.length - 1] ?? null;
    if (tag === 'table') {
      this.startTable(node, inherited, css);
    } else if (tag === 'tr' && table) {
      if (table.row?.length) table.rows.push(table.row);
      table.row = [];
      this.frames.push(new Frame(node, inherited, true, () => {
        this.flushPara();
        if (table.row?.length) table.rows.push(table.row);
        table.row = null;
      }));
    } else if ((tag === 'td' || tag === 'th') && table) {
      this.startCell(node, inherited, p, table, tag === 'th');
    } else if (tag === 'caption' && table) {
      this.flushPara();
      this.sinks.push(table.caption);
      this.frames.push(new Frame(node, inherited, true, () => {
        this.flushPara();
        this.sinks.pop();
      }));
    } else if (tag === 'ul' || tag === 'ol') {
      const ordered = tag === 'ol';
      const type = css['list-style-type'];
      const format = (type != null ? HtmlText.listFormat(type, ordered) : null) ??
        (isListNone(css) ? null : HtmlText.listFormat(ordered ? p.attr('type') : null, ordered));
      this.lists.push({ format, counter: (intAttr(p.attr('start')) ?? 1) - 1 });
      this.startBlock(node, inherited.copy({ listFormat: format }), css, tag, () => this.lists.pop());
    } else if (tag === 'li') {
      const list = this.lists[this.lists.length - 1] ?? null;
      const type = css['list-style-type'];
      const format = (type != null ? HtmlText.listFormat(type, list?.format !== Format.BULLET) : null) ??
        (isListNone(css) ? null : inheritedFrom.listFormat);
      this.startBlock(node, inherited, css, tag, () => {
        this.label = null;
      });
      const counter = intAttr(p.attr('value')) ?? (list?.counter ?? 0) + 1;
      if (list) list.counter = counter;
      let text = null;
      if (format === Format.BULLET) text = BULLETS[Math.min(BULLETS.length - 1, Math.max(0, this.lists.length - 1))];
      else if (format != null && format !== Format.NONE) text = ListNumbering.format(counter, format) + '.';
      this.label = text != null ? [text, inherited.labelStyle()] : null;
    } else if (block) {
      this.startBlock(node, inherited, css, tag);
    } else {
      this.frames.push(new Frame(node, inherited, false));
    }
  }

  /**
   * The end of element `name`. An empty element (img, br...) has nothing to end: HTML-style, it has
   * no end tag, and the parser then gives its parent's end tag first; anything malformed files put
   * inside one is read as if outside it.
   */
  end(name) {
    if (this.skip > 0) {
      if (!VOID.has(name)) this.skip--;
      return;
    }
    if (this.styleDepth > 0) {
      if (--this.styleDepth === 0) {
        const parsed = SimpleCss.parse(this.styleText);
        if (!parsed.isEmpty) this.sheets.push(parsed);
        this.styleText = '';
      }
      return;
    }
    if (this.headDepth > 0) {
      if (name === 'head') this.headDepth = 0;
      else if (!VOID.has(name)) this.headDepth--;
      return;
    }
    if (this.svgDepth > 0) {
      this.svgDepth--;
      return;
    }
    if (VOID.has(name)) return;
    this.frames.pop()?.end?.();
  }

  /**
   * The html element's font size and writing mode, read again once the head's style sheets are (it
   * starts before them): the body's sizes, in rems or not, are of it, and its margins follow the mode.
   */
  restyleRoot() {
    const i = this.frames.findIndex((f) => f.node.tag === 'html');
    if (i < 0) return;
    const frame = this.frames[i];
    const css = CssSheet.cascade(frame.node, this.sheets, this.rootStyle);
    const mode = CssValues.writingMode(css);
    if (mode != null) this.writingMode = mode;
    const size = css['font-size'];
    const rem = CssValues.rootSize(size, this.base);
    if (rem == null) return;
    this.rem = rem;
    const fs = CssValues.fontSize(size, this.base, this.base);
    if (fs != null) this.frames[i] = new Frame(frame.node, frame.inherited.copy({ size: fs }), frame.block, frame.end);
  }

  head(tag, p) {
    if (tag === 'link') {
      // An alternate style sheet (a book's horizontal look besides its vertical one, say) is only for readers to pick.
      if (!isStyleSheet(p)) return;
      const target = linkTarget(this.path, p.attr('href'));
      const sheet = target != null ? this.sheetCache.get(target) : null;
      if (sheet && !sheet.isEmpty) this.sheets.push(sheet);
    } else if (tag === 'meta') {
      if ((p.attr('name') ?? '').toLowerCase() === 'viewport') this.viewport = HtmlText.viewport(p.attr('content'));
    }
  }

  text(raw) {
    if (this.styleDepth > 0) {
      if (this.styleText.length < MAX_STYLE) this.styleText += raw;
      return;
    }
    if (this.skip > 0 || this.headDepth > 0 || this.svgDepth > 0) return;
    const inherited = this.current;
    if (inherited.pre) {
      const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      // Like a long paragraph, long preformatted text goes on as a new one, at a line's end.
      this.append(text, '\n', inherited);
      return;
    }
    this.appendText(raw, inherited);
  }

  appendText(raw, inherited) {
    const sofar = this.para;
    const before = !sofar || !sofar.length ? 0 : codePointBefore(sofar.text, sofar.length);
    const text = HtmlText.collapse(raw, this.afterSpace || !sofar, before);
    if (!text) return;
    // A line break that ended the text before, in another element, goes too between Chinese or Japanese characters.
    if (sofar && this.wideBreakAt >= 0 && this.wideBreakAt === sofar.length - 1 && HtmlText.isWide(text.codePointAt(0))) sofar.truncate(this.wideBreakAt);
    // A paragraph as long as a few pages goes on as a new one, after a space: laying out a huge one is slow.
    this.append(text, ' ', inherited);
    this.wideBreakAt = HtmlText.endsInWideBreak(raw, before) && this.para ? this.para.length - 1 : -1;
  }

  /**
   * Adds `text` to the paragraph. Once that is longer than SPLIT_AT, it goes on as a new
   * paragraph after the next `breakAfter`, even in the middle of `text` (a whole chapter can be one).
   */
  append(text, breakAfter, inherited) {
    let from = 0;
    while (from < text.length) {
      this.startPara();
      const rich = this.para;
      const at = text.indexOf(breakAfter, from + Math.max(0, SPLIT_AT - rich.length));
      const to = at < 0 ? text.length : at + 1;
      rich.append(text.slice(from, to), inherited.text());
      this.afterSpace = text[to - 1] === breakAfter;
      if (rich.length > SPLIT_AT && this.afterSpace) this.flushPara(true);
      from = to;
    }
  }

  startPara() {
    if (this.para) return;
    this.para = new BookText();
    this.paraStyle = this.currentBlock;
    this.afterSpace = true;
  }

  /** Ends the paragraph being read; a `continued` one goes on in a new paragraph, without indent or space. */
  flushPara(continued = false) {
    const rich = this.para;
    if (!rich) return;
    this.para = null;
    this.wideBreakAt = -1;
    const t = rich.text;
    let end = t.length;
    while (end > 0 && (t[end - 1] === ' ' || t[end - 1] === '\n')) end--;
    rich.truncate(end);
    this.pendingIds.push(...this.paraIds);
    this.paraIds = [];
    const style = this.paraStyle;
    const wasContinued = this.paraContinued;
    this.paraContinued = false;
    // Only white space: nothing to show. A no-break space alone keeps an empty line, as books use it.
    if (!shows(rich.text)) return;
    if (wasContinued) this.space = 0;
    this.emit(new BookPara(rich, this.blockStyle(style, !wasContinued), style.text(), this.label, style.heading));
    this.label = null;
    if (this.firstHeading == null && style.heading >= 1 && style.heading <= 3) {
      const heading = ktTrim(HtmlText.collapse(rich.text, true));
      if (heading) this.firstHeading = heading;
    }
    if (continued) {
      this.para = new BookText();
      this.paraStyle = style;
      this.paraContinued = true;
    }
  }

  emit(item) {
    const ids = this.pendingIds.length ? this.pendingIds.splice(0) : [];
    const entry = new BookEntry(item, this.space, ids);
    this.space = 0;
    const sink = this.sinks[this.sinks.length - 1];
    if (sink) sink.push(entry);
    else this.outbox.push(entry);
  }

  pageBreak() {
    this.flushPara();
    // Not inside a table: a cell can't be split that way.
    if (this.sinks.length) return;
    this.outbox.push(new BookEntry(BookBreak, 0, []));
    this.space = 0;
  }

  blockStyle(style, indent = true) {
    return new BlockStyle(style.align, style.left, style.right, indent ? style.textIndent : 0, style.rtl, style.physical, style.start, style.end);
  }

  startBlock(node, inherited, css, tag, onEnd = null) {
    this.flushPara();
    const em = inherited.size;
    // A list in a list has no space of its own around it. (The list starting is on the list of lists already.)
    const nested = (tag === 'ul' || tag === 'ol') && this.lists.length > 1;
    const ua = nested ? 0 : own(UA_MARGINS, tag) ?? 0;
    const [top, bottom] = this.margins(css, em, ua * em, tag === 'li' ? 0 : ua * em);
    if (CssValues.pageBreak(css['break-before'])) this.pageBreak();
    this.space = Math.max(this.space, top);
    const breakAfter = CssValues.pageBreak(css['break-after']);
    this.frames.push(new Frame(node, inherited, true, () => {
      this.flushPara();
      onEnd?.();
      this.space = Math.max(this.space, bottom);
      if (breakAfter) this.pageBreak();
    }));
  }

  margins(css, em, top, bottom) {
    let t = top;
    let b = bottom;
    // The margin shorthand comes as its sides (SimpleCss), so the cascade decides each.
    const mt = CssValues.length(css['margin-top'], em, this.base, null, this.rem);
    if (mt != null) t = mt;
    const mb = CssValues.length(css['margin-bottom'], em, this.base, null, this.rem);
    if (mb != null) b = mb;
    // Negative margins and huge ones (some books push a title down with a third of a page) are tamed.
    const most = this.base * 8;
    return [Math.min(most, Math.max(0, t)), Math.min(most, Math.max(0, b))];
  }

  startTable(node, inherited, css) {
    this.flushPara();
    if (CssValues.pageBreak(css['break-before'])) this.pageBreak();
    const em = inherited.size;
    const [top, bottom] = this.margins(css, em, 0.8 * em, 0.8 * em);
    this.space = Math.max(this.space, top);
    // Kept for the table (or its caption): its cells start without space of their own.
    const before = this.space;
    const state = { rows: [], row: null, caption: [] };
    this.tables.push(state);
    this.frames.push(new Frame(node, inherited, true, () => {
      this.flushPara();
      if (state.row?.length) state.rows.push(state.row);
      this.tables.pop();
      this.space = Math.max(this.space, before);
      for (const entry of state.caption) {
        this.pendingIds.unshift(...entry.ids);
        this.space = Math.max(this.space, entry.before);
        this.emit(entry.item);
      }
      if (state.rows.length) this.emit(new BookTable(state.rows, this.blockStyle(inherited)));
      this.space = Math.max(this.space, bottom);
    }));
  }

  startCell(node, inherited, p, table, header) {
    this.flushPara();
    const items = [];
    this.sinks.push(items);
    this.space = 0;
    const span = Math.min(64, Math.max(1, intAttr(p.attr('colspan')) ?? 1));
    const rowSpan = Math.min(1000, Math.max(1, intAttr(p.attr('rowspan')) ?? 1));
    // A cell's text is indented from the cell, not from the page.
    this.frames.push(new Frame(node, inherited.copy({ left: 0, right: 0, start: 0, end: 0, textIndent: 0 }), true, () => {
      this.flushPara();
      this.sinks.pop();
      this.space = 0;
      (table.row ?? (table.row = [])).push(new BookCell(items, span, rowSpan, header));
    }));
  }

  /** A picture: an img, an SVG image (`fromSvg`) or an object, whose `source` is given. */
  image(p, inherited, css, fromSvg, source = null) {
    const src = source ?? (fromSvg ? p.attr('href') : p.attr('src') ?? p.attr('href'));
    if (src == null) return;
    const target = EpubPaths.resolve(this.path, src)?.[0] ?? null;
    const pixels = target != null ? this.imageSize(target) : null;
    if (target == null || pixels == null) {
      // Not a picture in the book that can be drawn (an SVG, or one written into the page as
      // data: or kept on the web): its description stands in, if it has one.
      const alt = p.attr('alt');
      const text = alt != null ? ktTrim(alt) : '';
      if (text) this.appendText(` ${text} `, inherited.copy({ italic: true }));
      return;
    }
    // Pictures are as big as at 16 px to the font size the book was written for.
    const scale = this.base / 16;
    let width = pixels[0] * scale;
    let height = pixels[1] * scale;
    let share = null;
    if (!fromSvg) {
      const cssWidth = css.width ?? pixelAttr(p.attr('width'));
      const cssHeight = css.height ?? pixelAttr(p.attr('height'));
      const widthText = cssWidth != null ? ktTrim(cssWidth) : null;
      const percent = widthText != null && widthText.endsWith('%') ? ktFloat(ktTrim(widthText.slice(0, -1))) : null;
      const wl = cssWidth != null ? CssValues.length(cssWidth, inherited.size, this.base, null, this.rem) : null;
      const w = wl != null && wl > 0 ? wl : null;
      const hl = cssHeight != null && !ktTrim(cssHeight).endsWith('%') ? CssValues.length(cssHeight, inherited.size, this.base, null, this.rem) : null;
      const h = hl != null && hl > 0 ? hl : null;
      if (percent != null && percent > 0) {
        share = Math.min(1, Math.max(0.05, percent / 100));
      } else if (w != null) {
        height *= w / width;
        width = w;
      } else if (h != null) {
        width *= h / height;
        height = h;
      }
    }
    // A small picture in a line of text, such as a symbol, stays in the line.
    const rich = this.para;
    if (rich && share == null && height <= inherited.size * 2.2 && rich.hasContent) {
      const picture = new ImagePicture(this.images, target, width, height, null);
      // As big as the app's PictureSpan, in whole tenths of a point.
      const w = Math.max(0.1, Math.trunc(width * 10) / 10);
      const h = Math.max(0.1, Math.trunc(height * 10) / 10);
      rich.appendObject({
        width: w,
        height: h,
        picture,
        draw(target2, rect) {
          picture.draw(target2, rect);
        },
      }, inherited.text());
      this.afterSpace = false;
      return;
    }
    this.flushPara();
    // A little room around it, as most books' style sheets give pictures.
    this.space = Math.max(this.space, 0.5 * inherited.size);
    this.emit(new BookImage(target, width, height, share, this.blockStyle(this.currentBlock)));
    this.space = Math.max(this.space, 0.5 * inherited.size);
  }

  inherit(tag, parent, css, p, block) {
    const base = this.base;
    const rem = this.rem;
    const textWidth = this.textWidth;
    let size = parent.size * (own(UA_SIZES, tag) ?? 1);
    const fs = CssValues.fontSize(css['font-size'], parent.size, base, rem);
    if (fs != null) size = fs;
    let bold = parent.bold || BOLD.has(tag);
    const b = CssValues.bold(css['font-weight']);
    if (b != null) bold = b;
    let italic = parent.italic || ITALIC.has(tag);
    const fontStyle = css['font-style'] != null ? ktTrim(css['font-style']).toLowerCase() : null;
    if (fontStyle === 'italic' || fontStyle === 'oblique') italic = true;
    else if (fontStyle === 'normal') italic = false;
    let underline = parent.underline || tag === 'u' || tag === 'ins';
    let strike = parent.strike || tag === 's' || tag === 'strike' || tag === 'del';
    const decoration = (css['text-decoration'] ?? css['text-decoration-line'])?.toLowerCase();
    if (decoration != null) {
      if (decoration.includes('none')) {
        underline = false;
        strike = false;
      }
      if (decoration.includes('underline')) underline = true;
      if (decoration.includes('line-through')) strike = true;
    }
    let font = MONO.has(tag) ? 'monospace' : parent.font;
    const family = CssValues.fontFamily(css['font-family']);
    if (family != null) font = family;
    let baseline = tag === 'sup' ? 1 : tag === 'sub' ? -1 : parent.baseline;
    const vertical = css['vertical-align'] != null ? ktTrim(css['vertical-align']).toLowerCase() : null;
    if (vertical === 'super') baseline = 1;
    else if (vertical === 'sub') baseline = -1;
    else if (vertical === 'baseline') baseline = 0;
    let align = CENTERED.has(tag) ? Align.CENTER : parent.align;
    let physical = parent.physical && !CENTERED.has(tag);
    const alignText = css['text-align'] ?? p.attr('align');
    if (alignText != null) {
      const a = ktTrim(alignText).toLowerCase();
      switch (a) {
        case 'center': case 'middle': align = Align.CENTER; break;
        case 'right': case 'end': align = Align.END; break;
        case 'justify': align = Align.JUSTIFY; break;
        case 'left': case 'start': align = Align.START; break;
        default: break;
      }
      // Left and right stay where they are in a paragraph that reads right to left; start and end don't.
      if (a === 'left' || a === 'right') physical = true;
      else if (a === 'center' || a === 'middle' || a === 'justify' || a === 'start' || a === 'end') physical = false;
    }
    let textIndent = parent.textIndent;
    const ti = CssValues.length(css['text-indent'], size, base, textWidth, rem);
    if (ti != null) textIndent = Math.min(textWidth / 3, Math.max(-textWidth / 3, ti));
    let left = parent.left;
    let right = parent.right;
    let start = parent.start;
    let end = parent.end;
    if (block) {
      const indent = (own(UA_INDENTS, tag) ?? 0) * size;
      left += indent;
      start += indent;
      if (tag === 'blockquote') {
        right += indent;
        end += indent;
      }
      const ml = CssValues.length(css['margin-left'], size, base, textWidth, rem);
      if (ml != null && ml > 0) left += ml;
      const mr = CssValues.length(css['margin-right'], size, base, textWidth, rem);
      if (mr != null && mr > 0) right += mr;
      // Always room for the text: no more than half the width in indents.
      const most = textWidth * 0.5;
      if (left + right > most) {
        const shrink = most / (left + right);
        left *= shrink;
        right *= shrink;
        start *= shrink;
        end *= shrink;
      }
    }
    let pre = parent.pre || PRE.has(tag);
    const whiteSpace = css['white-space'] != null ? ktTrim(css['white-space']).toLowerCase() : null;
    if (whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'pre-line' || whiteSpace === 'break-spaces') pre = true;
    else if (whiteSpace === 'normal' || whiteSpace === 'nowrap') pre = false;
    const dir = p.attr('dir') != null ? ktTrim(p.attr('dir')).toLowerCase() : null;
    const rtl = dir === 'rtl' ? true : dir === 'ltr' ? false : parent.rtl;
    const heading = tag.length === 2 && tag[0] === 'h' && tag[1] >= '1' && tag[1] <= '6' ? tag.charCodeAt(1) - 48 : parent.heading;
    return parent.copy({
      font, size, bold, italic, underline, strike, baseline, highlight: parent.highlight || tag === 'mark', align, physical,
      textIndent, left, right, start, end, pre, rtl, heading,
    });
  }
}

/** Whether a link element is a style sheet in use (an alternate one is only for readers to pick). */
function isStyleSheet(p) {
  const rel = p.attr('rel');
  if (rel == null) return false;
  const parts = rel.toLowerCase().split(' ');
  return parts.includes('stylesheet') && !parts.includes('alternate');
}

function linkTarget(path, href) {
  return href != null ? EpubPaths.resolve(path, href)?.[0] ?? null : null;
}

/** An img's width or height attribute as CSS: bare digits are pixels. */
function pixelAttr(value) {
  if (value == null) return null;
  const v = ktTrim(value);
  return v && /^\p{Nd}+$/u.test(v) ? `${v}px` : v;
}

const isListNone = (css) => css['list-style-type'] != null && ktTrim(css['list-style-type']) === 'none';

/** Whether text has anything to show: a character other than white space, or a no-break space. */
function shows(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!isKtWhitespace(c) || c === 0xa0) return true;
  }
  return false;
}
