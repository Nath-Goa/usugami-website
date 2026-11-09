// Laying a Word document out on pages: a port of the layout half of the app's DocxConverter.kt
// (its Flow, paragraphBlock, tableBlock, stack and floating pictures). What docx-read.js read goes
// on pages one block after another: paragraphs with their spacing, "keep with next" and page breaks
// before, tables split across pages with their header rows repeated, pictures in the text and
// floating, headers and footers with their page numbers, sections with their own page sizes.
// Lengths are points (the app's tenths of a point aside).
import { RichText, layoutParagraph, LineSpacing, lineScale, measureText } from '../text/index.js';
import { StackBlock, Spaced } from './blocks.js';
import { Border, CellBox, RowBlock, TableBlock } from './tables.js';
import { TableColumns, ListNumbering } from './office-formats.js';
import { OfficeColors } from './colors.js';
import { inlinePicture } from './office-pdf.js';
import { Borders } from './docx-styles.js';
import { DocPara, DocTable, PAGE_BREAK, SECTION_END, Reader, hasPageNumber, picturesOf, MAX_COLUMNS } from './docx-read.js';
import { checkCancelled } from '../../core/errors.js';
import { pause } from './pause.js';

const WHITE = 0xffffffff;
const EPS = 1e-6;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A page's number, and how its section writes page numbers. */
export class PageNumber {
  constructor(value, format) {
    this.value = value;
    this.format = format;
  }

  text(own) {
    return ListNumbering.format(this.value, own ?? this.format);
  }
}

/** A picture on a line of its own, `x` points in from the left edge it's drawn at. */
export class FloatBlock {
  constructor(picture, width, height, x) {
    this.picture = picture;
    this.width = width;
    this.height = height;
    this.x = x;
  }

  draw(canvas, x, y) {
    this.picture.draw(canvas, { x: x + this.x, y, width: this.width, height: this.height });
  }

  split(space, force = false) {
    return force ? [this, null] : null;
  }
}

/**
 * A block (a paragraph) with bookmarks at its top: drawn the first time, its page gets a named
 * destination for each, so the document's links to them (a table of contents) go there.
 */
class Marked {
  constructor(block, names, dests) {
    this.block = block;
    this.names = names;
    this.dests = dests;
    this.height = block.height;
  }

  get firstLineHeight() {
    return typeof this.block.firstLineHeight === 'number' ? this.block.firstLineHeight : this.block.height;
  }

  draw(canvas, x, y) {
    for (const name of this.names) {
      if (this.dests.has(name)) continue;
      this.dests.add(name);
      canvas.addDestination(name, 0, y);
    }
    this.block.draw(canvas, x, y);
  }

  split(space, force = false) {
    const parts = this.block.split(space, force);
    if (!parts) return null;
    return [new Marked(parts[0], this.names, this.dests), parts[1]];
  }
}

/** The height of a block's first line: a paragraph's, or the whole block's. */
function firstLineOf(block) {
  return typeof block.firstLineHeight === 'number' ? block.firstLineHeight : block.height;
}

/** Space before a paragraph, in points, with room for its top border. */
export function spaceBefore(p) {
  const b = p.borderTop;
  return (p.before ?? 0) + (b && b[0].width > 0 ? b[0].width + b[1] : 0);
}

/** Space after a paragraph, in points, with room for its bottom border. */
export function spaceAfter(p) {
  const b = p.borderBottom;
  return (p.after ?? 0) + (b && b[0].width > 0 ? b[0].width + b[1] : 0);
}

function rule(border) {
  return border && border[0].width > 0 ? { width: border[0].width, color: border[0].color, gap: border[1] } : null;
}

/** The colour to draw `style` in on `behind` (the shading under it, if any): white for automatic text on dark. */
function colorOn(style, behind) {
  const under = style.background ?? behind;
  return style.autoColor && under != null && OfficeColors.isDark(under) ? WHITE : style.color;
}

/** A label's or space's width as Android's Paint.measureText gives it: spaces at its end count. */
async function measured(text, style) {
  return (await measureText(text.replace(/ /g, ' '), style)).width;
}

/** Lets the browser paint and answer input in a new task, not a timer (see pause.js). */
const yieldNow = pause;

/** Loads the pictures `item` draws (each once, however often it is asked). */
async function loadPictures(item) {
  for (const picture of picturesOf(item)) await picture.load?.();
}

/**
 * Lays out what docx-read.js reads. `ctx`: { pkg, theme, styles, numbering, images, bookmarks,
 * pdf (an OfficePdf), sections, evenAndOddHeaders, signal, onProgress }.
 */
export class DocxLayout {
  constructor(ctx) {
    this.ctx = ctx;
    this.dests = new Set();
    this.lastBreath = 0;
  }

  /** Stops when cancelled, and now and then lets the page draw and answer the user. */
  async breathe() {
    checkCancelled(this.ctx.signal);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastBreath > 25) {
      await yieldNow();
      this.lastBreath = typeof performance !== 'undefined' ? performance.now() : Date.now();
      checkCancelled(this.ctx.signal);
    }
  }

  /** `p` laid out `width` points wide on page `page`, on `behind` (the shading under it, if any). */
  async paragraphBlock(p, width, page, maxHeight, behind) {
    for (const i of p.inlines) if (i.kind === 'picture') await i.picture.load?.();
    const shade = p.props.shading ?? behind;
    const rich = new RichText({ behind: shade });
    for (const inline of p.inlines) {
      if (inline.kind === 'text') {
        rich.append(inline.text, inline.link ? { ...inline.style, link: inline.link } : inline.style);
      } else if (inline.kind === 'page') {
        rich.append(page.text(inline.format), inline.style);
      } else if (inline.kind === 'picture') {
        // Pictures bigger than the space for text are shrunk to fit, keeping their shape.
        const w = inline.width;
        const h = inline.height;
        const scale = Math.min(1, width / w, (maxHeight * 0.95) / h);
        rich.appendObject(inlinePicture(inline.picture, Math.max(0.1, w * scale), Math.max(0.1, h * scale)), inline.style);
      }
    }
    const props = p.props;
    const left = props.left ?? 0;
    const firstStart = left + (props.firstLine ?? 0);
    const defaultTab = 36;
    const set = props.tabs?.set ?? [];
    let textStart = firstStart;
    let label = null;
    if (p.label) {
      const end = firstStart + await measured(p.label, p.labelStyle);
      switch (p.labelSuffix) {
        case 'space': textStart = end + await measured(' ', p.labelStyle); break;
        case 'nothing': textStart = end; break;
        // A tab: to the hanging indent if the label ends before it, else to the next tab stop.
        default:
          textStart = end < left - 0.1 ? left : set.find((t) => t > end + 0.1) ?? Math.ceil((end + 0.1) / defaultTab) * defaultTab;
          break;
      }
      label = { text: p.label, style: { ...p.labelStyle, color: colorOn(p.labelStyle, shade), autoColor: false }, x: firstStart };
    }
    const rtl = props.rtl === true;
    const align = props.align ?? 'start';
    // Word's stops: left, right, centre and decimal, with their leaders (dots in a table of contents).
    // In a right-to-left paragraph they're plain left stops.
    const aligned = props.tabs?.aligned ?? new Map();
    const stops = set.map((pos) => (rtl ? pos : { pos, align: aligned.get(pos)?.align ?? 'left', leader: aligned.get(pos)?.leader ?? null }));
    const spec = {
      text: rich,
      base: p.mark,
      width,
      align,
      firstIndent: textStart,
      indent: left,
      rightIndent: props.right ?? 0,
      spacing: props.line ?? LineSpacing.SINGLE,
      lineScale: lineScale(p.mark),
      label,
      rtl,
      // A paragraph starting with Hebrew or Arabic is still left to right unless it's set otherwise.
      directionFromText: false,
      // In a right-to-left paragraph, Word's left indent and hanging indent are on the right.
      mirrored: rtl,
      background: props.shading,
      tabs: stops,
      defaultTab,
      avoidSingleLines: props.widowControl !== false,
      ruleAbove: rule(props.borderTop),
      ruleBelow: rule(props.borderBottom),
    };
    // Word measures tab stops from the margin; lines measure them from where their text starts. A
    // one-line paragraph (a header, a contents line) whose first line starts further in has its stops
    // brought that much nearer, so its text lands where Word puts it.
    const shift = Math.max(0, textStart - left);
    if (shift > 0 && aligned.size && !rtl && align !== 'center' && align !== 'end' && rich.text.includes('\t') && !rich.text.includes('\n')) {
      const shifted = await layoutParagraph({ ...spec, tabs: stops.map((s) => ({ ...s, pos: s.pos - shift })) });
      if (shifted.lineCount === 1) return this.marked(shifted, p);
    }
    return this.marked(await layoutParagraph(spec), p);
  }

  marked(block, p) {
    return p.bookmarks?.length ? new Marked(block, p.bookmarks, this.dests) : block;
  }

  /**
   * `items` one under another `width` points wide, as in a table cell or a header, on `behind` (the
   * shading under them, if any). Floating pictures go on lines of their own, but those in front of
   * or behind the text go to `overlays` when it's given.
   */
  async stack(items, width, page, maxHeight, behind, overlays = null) {
    const placed = [];
    for (const item of items) {
      // A table cell can hold a whole report: Cancel is heard while it's laid out.
      await this.breathe();
      if (item instanceof DocPara) {
        await loadPictures(item);
        for (const f of item.floats) {
          if (f.overText && overlays) overlays.push(f);
          else placed.push(new Spaced(this.floatBlock(f, width, maxHeight, 0), 0, 0));
        }
        const block = await this.paragraphBlock(item, width, page, maxHeight, behind);
        placed.push(new Spaced(block, spaceBefore(item.props), spaceAfter(item.props)));
      } else if (item instanceof DocTable) {
        placed.push(new Spaced(await this.tableBlock(item, width, page, maxHeight, behind), 0, 0));
      }
    }
    return new StackBlock(placed);
  }

  /**
   * A floating picture on a line of its own, `width` points wide at most and `maxHeight` high,
   * shrunk to fit keeping its shape. `pageLeft` is the left margin, for pictures placed from the page's edge.
   */
  floatBlock(f, width, maxHeight, pageLeft) {
    const scale = Math.min(1, width / f.width, maxHeight / f.height);
    const w = Math.max(0.1, f.width * scale);
    const h = Math.max(0.1, f.height * scale);
    let x;
    switch (f.h.align) {
      case 'center': x = (width - w) / 2; break;
      case 'right': case 'outside': x = width - w; break;
      case 'left': case 'inside': x = 0; break;
      default: x = f.h.from === 'page' ? f.h.offset - pageLeft : f.h.offset; break;
    }
    return new FloatBlock(f.picture, w, h, clamp(x, Math.min(0, width - w), Math.max(0, width - w)));
  }

  /** `t` laid out in `available` points, on `behind` (the shading under it, if any). */
  async tableBlock(t, available, page, maxHeight, behind) {
    if (!t.rows.length) return new StackBlock([]);
    const { styles } = this.ctx;
    for (const row of t.rows) for (const cell of row.cells) for (const c of cell.content) await loadPictures(c);
    const styleId = t.props.style ?? styles.defaultTableStyle;
    const props = t.props.over(styles.table(styleId));
    const borders = props.borders ?? new Borders();
    const margins = [0, 1, 2, 3].map((i) => props.margins?.[i] ?? (i % 2 === 0 ? 5.4 : 0));
    let columns = 0;
    for (const row of t.rows) {
      let n = row.gridBefore;
      for (const cell of row.cells) n += cell.span;
      columns = Math.max(columns, Math.min(MAX_COLUMNS, n));
    }
    const preferred = props.width != null ? (props.widthShare ? props.width * available : props.width) : null;
    // A little wider than the text is fine: Word lets tables reach into the margin.
    const widths = TableColumns.widths(t.grid, columns, available * 1.04, preferred);
    const tableWidth = widths.reduce((s, w) => s + w, 0);
    // A right-to-left table has its first column on the right, and its indent from the right.
    const rtl = props.rtl === true;
    let x;
    if (props.align === 'center') x = (available - tableWidth) / 2;
    else if (props.align === 'end') x = rtl ? 0 : available - tableWidth;
    else x = rtl ? available - tableWidth - (props.indent ?? 0) : props.indent ?? 0;
    const starts = [0];
    for (const w of widths) starts.push(starts[starts.length - 1] + w);
    const at = (i) => starts[clamp(i, 0, starts.length - 1)];
    // Which grid columns each row's cells start at, to find cells merged with the one below.
    const cellColumns = t.rows.map((row) => {
      let col = row.gridBefore;
      return row.cells.map((cell) => {
        const start = col;
        col = Math.min(MAX_COLUMNS, col + cell.span);
        return start;
      });
    });
    const mergedBelow = (r, col) => {
      const next = t.rows[r + 1];
      if (!next) return false;
      const i = cellColumns[r + 1].indexOf(col);
      return i >= 0 && next.cells[i].vMerge === 'continue';
    };
    const rows = [];
    for (let r = 0; r < t.rows.length; r++) {
      // A table thousands of rows long takes seconds to lay out: Cancel is heard meanwhile.
      await this.breathe();
      const row = t.rows[r];
      const cells = [];
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        const col = Math.min(cellColumns[r][i], columns - 1);
        const end = Math.min(col + cell.span, columns);
        const inherited = new Borders({
          top: r === 0 ? borders.top : borders.insideH,
          bottom: r === t.rows.length - 1 ? borders.bottom : borders.insideH,
          left: col === 0 ? borders.left : borders.insideV,
          right: end >= columns ? borders.right : borders.insideV,
        });
        const own = (cell.borders ?? new Borders()).over(inherited);
        const m = [0, 1, 2, 3].map((k) => cell.margins?.[k] ?? margins[k]);
        const cellWidth = at(end) - at(col);
        const continued = cell.vMerge === 'continue';
        const content = continued || !cell.content.length ? null
          : await this.stack(cell.content, Math.max(0.1, cellWidth - m[0] - m[2]), page, maxHeight, cell.fill ?? behind);
        cells.push(new CellBox({
          x: rtl ? x + tableWidth - at(end) : x + at(col),
          width: cellWidth,
          content,
          fill: cell.fill,
          top: continued ? Border.NONE : own.top,
          // A right-to-left table's left borders and margins are on the cells' right (their start).
          left: rtl ? own.right : own.left,
          bottom: mergedBelow(r, cellColumns[r][i]) ? Border.NONE : own.bottom,
          right: rtl ? own.left : own.right,
          verticalAlign: cell.verticalAlign,
          padLeft: rtl ? m[2] : m[0],
          padTop: m[1],
          padRight: rtl ? m[0] : m[2],
          padBottom: m[3],
        }));
      }
      rows.push(new RowBlock(cells, row.height ?? 0, row.exact));
    }
    let headerRows = 0;
    while (headerRows < t.rows.length && t.rows[headerRows].header) headerRows++;
    if (headerRows >= t.rows.length) headerRows = 0;
    return new TableBlock(rows, headerRows, 0);
  }
}

/**
 * A block waiting to go on the page, with its spacing and what it keeps with. One with the page's
 * number in it is laid out again by `renumbered` for the page it starts on, once that is known.
 */
class Placed {
  constructor(block, { before = 0, after = 0, style = null, contextual = false, keepNext = false, overlays = [], renumbered = null } = {}) {
    this.block = block;
    this.before = before;
    this.after = after;
    this.style = style;
    this.contextual = contextual;
    this.keepNext = keepNext;
    this.overlays = overlays;
    this.renumbered = renumbered;
  }
}

/** Lays the document out page after page. */
export class Flow {
  /** `layout`: a DocxLayout. */
  constructor(layout) {
    this.layout = layout;
    this.ctx = layout.ctx;
    this.sectionIndex = 0;
    this.section = this.ctx.sections[0];
    this.canvas = null;
    this.top = 0;
    this.bottom = 0;
    this.y = 0;
    this.shownNumber = 0;
    this.pageInSection = 0;
    this.empty = true;
    // A paragraph at the top of the page keeps its space before only after an explicit break, as in Word.
    this.keepSpaceBefore = true;
    this.lastAfter = 0;
    this.lastStyle = null;
    this.lastContextual = false;
    this.pending = [];
    /** Headers' and footers' items by part, and their laid-out blocks when they have no page number. */
    this.headers = new Map();
    this.headerBlocks = new Map();
  }

  get left() { return this.section.left; }
  get textWidth() { return this.section.width - this.section.left - this.section.right; }
  get textHeight() { return this.section.height - this.section.top - this.section.bottom; }
  get pageNumber() { return new PageNumber(this.shownNumber, this.section.pageFormat); }

  async add(item) {
    const L = this.layout;
    if (item instanceof DocPara) {
      await loadPictures(item);
      if (item.props.pageBreakBefore === true && !this.empty && this.canvas) await this.newPage(false);
      for (const f of item.floats) if (!f.overText) await this.place(new Placed(L.floatBlock(f, this.textWidth, this.textHeight, this.left)));
      const p = item.props;
      const block = await L.paragraphBlock(item, this.textWidth, this.pageNumber, this.textHeight, null);
      const renumbered = hasPageNumber(item) ? (page) => L.paragraphBlock(item, this.textWidth, page, this.textHeight, null) : null;
      await this.place(new Placed(block, {
        before: spaceBefore(p),
        after: spaceAfter(p),
        style: p.style ?? this.ctx.styles.defaultParagraphStyle,
        contextual: p.contextual === true,
        keepNext: p.keepNext === true,
        overlays: item.floats.filter((f) => f.overText),
        renumbered,
      }));
    } else if (item instanceof DocTable) {
      const block = await L.tableBlock(item, this.textWidth, this.pageNumber, this.textHeight, null);
      const renumbered = hasPageNumber(item) ? (page) => L.tableBlock(item, this.textWidth, page, this.textHeight, null) : null;
      await this.place(new Placed(block, { renumbered }));
    } else if (item === PAGE_BREAK) {
      await this.flushPending();
      await this.ensurePage();
      await this.newPage(false);
    } else if (item === SECTION_END) {
      await this.nextSection();
    }
  }

  async place(item) {
    // Headings go with what follows them: they move on to the next page together.
    if (item.keepNext && this.pending.length < 4) {
      this.pending.push(item);
      return;
    }
    if (this.pending.length) {
      await this.ensurePage();
      let need = item.before + Math.min(item.block.height, 40);
      for (const w of this.pending) need += w.before + w.block.height + w.after;
      if (!this.empty && this.y + need > this.bottom + EPS && need <= this.textHeight) await this.newPage(true);
      await this.flushPending();
    }
    await this.put(item);
  }

  async flushPending() {
    const waiting = this.pending;
    this.pending = [];
    for (const item of waiting) await this.put(item);
  }

  async put(item) {
    await this.ensurePage();
    let after = this.lastAfter;
    let before = item.before;
    if (item.style != null && item.style === this.lastStyle) {
      if (item.contextual) before = 0;
      if (this.lastContextual) after = 0;
    }
    // At the top of a page, the space before is kept as far as the paragraph still fits under it
    // (or, for one longer than the page, its first line): more would put the text below the page,
    // or split a short paragraph that fits.
    const room = this.bottom - this.y;
    const kept = item.block.height <= room + EPS ? item.block.height : firstLineOf(item.block);
    let gap = this.empty ? (this.keepSpaceBefore ? Math.min(before, Math.max(0, room - kept)) : 0) : before + after;
    let block = item.renumbered ? await item.renumbered(this.pageNumber) : item.block;
    let first = true;
    for (;;) {
      const space = this.bottom - this.y - gap;
      if (block.height <= space + EPS) {
        this.draw(block, item, gap, first);
        this.y += gap + block.height;
        break;
      }
      const forced = this.empty;
      const parts = block.split(space, forced);
      if (parts == null || (forced && !(parts[0].height > 0) && parts[1] && !(parts[1].height < block.height))) {
        if (forced) {
          // Nothing fits even on an empty page (only a crafted block would): drawn as it is.
          this.draw(block, item, gap, first);
          this.y += gap + block.height;
          break;
        }
        await this.newPage(true);
        gap = 0;
        if (first && item.renumbered) block = await item.renumbered(this.pageNumber);
        continue;
      }
      this.draw(parts[0], item, gap, first);
      first = false;
      const rest = parts[1];
      if (rest == null) {
        this.y += gap + parts[0].height;
        break;
      }
      await this.newPage(true);
      gap = 0;
      block = rest;
    }
    this.empty = false;
    this.lastAfter = item.after;
    this.lastStyle = item.style;
    this.lastContextual = item.contextual;
  }

  draw(block, item, gap, first) {
    const c = this.canvas;
    if (!c) return;
    // Pictures behind the text go under the paragraph they're anchored to, the others over it.
    if (first) for (const o of item.overlays) if (o.behind) this.drawOverlay(c, o, this.y + gap);
    block.draw(c, this.left, this.y + gap);
    if (first) for (const o of item.overlays) if (!o.behind) this.drawOverlay(c, o, this.y + gap);
  }

  /** A picture in front of or behind the text, where Word puts it on the page. */
  drawOverlay(c, f, paragraphTop) {
    const s = this.section;
    const w = f.width;
    const h = f.height;
    const pageW = s.width;
    const pageH = s.height;
    let x0;
    let extentX;
    switch (f.h.from) {
      case 'page': [x0, extentX] = [0, pageW]; break;
      case 'leftMargin': case 'insideMargin': [x0, extentX] = [0, this.left]; break;
      case 'rightMargin': case 'outsideMargin': [x0, extentX] = [pageW - s.right, s.right]; break;
      default: [x0, extentX] = [this.left, this.textWidth]; break;
    }
    let y0;
    let extentY;
    switch (f.v.from) {
      case 'page': [y0, extentY] = [0, pageH]; break;
      case 'margin': case 'insideMargin': case 'outsideMargin': [y0, extentY] = [s.top, this.textHeight]; break;
      case 'topMargin': [y0, extentY] = [0, s.top]; break;
      case 'bottomMargin': [y0, extentY] = [pageH - s.bottom, s.bottom]; break;
      default: [y0, extentY] = [paragraphTop, 0]; break;
    }
    let x;
    switch (f.h.align) {
      case 'center': x = x0 + (extentX - w) / 2; break;
      case 'right': case 'outside': x = x0 + extentX - w; break;
      case 'left': case 'inside': x = x0; break;
      default: x = x0 + f.h.offset; break;
    }
    let y;
    switch (f.v.align) {
      case 'center': y = y0 + (extentY - h) / 2; break;
      case 'bottom': case 'outside': y = y0 + extentY - h; break;
      case 'top': case 'inside': y = y0; break;
      default: y = y0 + f.v.offset; break;
    }
    f.picture.draw(c, { x, y, width: w, height: h });
  }

  async ensurePage() {
    if (!this.canvas) await this.startPage();
  }

  async newPage(natural) {
    this.finishPage();
    await this.startPage();
    this.keepSpaceBefore = !natural;
  }

  async startPage() {
    await this.layout.breathe();
    const s = this.section;
    if (this.pageInSection === 0 && s.pageStart != null) this.shownNumber = s.pageStart - 1;
    this.shownNumber++;
    this.pageInSection++;
    const c = this.ctx.pdf.startPage(s.width, s.height);
    this.canvas = c;
    this.ctx.onProgress?.(this.ctx.pdf.pageCount + 1, null);
    this.top = s.top;
    this.bottom = s.height - s.bottom;
    await this.drawHeaderAndFooter(c);
    this.y = this.top;
    this.empty = true;
    this.lastAfter = 0;
    this.lastStyle = null;
  }

  finishPage() {
    if (!this.canvas) return;
    this.ctx.pdf.finishPage();
    this.canvas = null;
  }

  async nextSection() {
    await this.flushPending();
    const next = this.ctx.sections[++this.sectionIndex];
    if (!next) return;
    const s = this.section;
    const samePage = next.type === 'continuous' && next.width === s.width && next.height === s.height;
    if (!samePage) {
      this.finishPage();
      // A section starting on an odd (or even) page: when its first page's number wouldn't be, a
      // blank page of the section before goes first, as in Word.
      const parity = next.type === 'oddPage' ? 1 : next.type === 'evenPage' ? 0 : null;
      const number = next.pageStart ?? this.shownNumber + 1;
      if (parity != null && this.ctx.pdf.pageCount > 0 && ((number % 2) + 2) % 2 !== parity) {
        await this.startPage();
        this.finishPage();
      }
    }
    this.section = next;
    if (!samePage) {
      this.pageInSection = 0;
      this.keepSpaceBefore = true;
    }
  }

  async drawHeaderAndFooter(c) {
    const s = this.section;
    // Odd and even go by the number the page shows, as in Word; an even page without a header of its own has none.
    const kind = s.titlePage && this.pageInSection === 1 ? 'first' : this.ctx.evenAndOddHeaders && this.shownNumber % 2 === 0 ? 'even' : 'default';
    const header = s.headers.get(kind);
    const footer = s.footers.get(kind);
    const headerOverlays = [];
    const footerOverlays = [];
    const head = header != null ? await this.headerBlock(header, headerOverlays) : null;
    const foot = footer != null ? await this.headerBlock(footer, footerOverlays) : null;
    const headerAt = s.headerDistance;
    const footerAt = s.height - s.footerDistance - (foot?.height ?? 0);
    // Their pictures in front of or behind the text, such as a letterhead or a watermark, take no
    // room and go under everything, as in Word.
    for (const f of headerOverlays) this.drawOverlay(c, f, headerAt);
    for (const f of footerOverlays) this.drawOverlay(c, f, footerAt);
    if (head) {
      head.draw(c, this.left, headerAt);
      this.top = Math.max(this.top, headerAt + head.height);
    }
    if (foot) {
      foot.draw(c, this.left, footerAt);
      this.bottom = Math.min(this.bottom, footerAt);
    }
    // However tall they are, the text keeps at least an inch of the page.
    if (this.bottom - this.top < 72) {
      this.top = s.top;
      this.bottom = s.height - s.bottom;
    }
  }

  /** A header or footer, laid out for this page (its page number); its pictures over the text go to `overlays`. */
  async headerBlock(part, overlays) {
    let items = this.headers.get(part);
    if (!items) {
      items = [];
      const x = await this.ctx.pkg.xml(part);
      if (x) new Reader(this.ctx, part).blocks(x, null, (it) => items.push(it));
      this.headers.set(part, items);
    }
    if (!items.length) return null;
    // One without the page's number is the same on every page of a size: laid out once.
    const numbered = items.some(hasPageNumber);
    const key = `${part}\u0000${this.textWidth}\u0000${this.textHeight}`;
    if (!numbered) {
      const kept = this.headerBlocks.get(key);
      if (kept) {
        overlays.push(...kept.overlays);
        return kept.block;
      }
    }
    const own = [];
    const block = await this.layout.stack(items, this.textWidth, this.pageNumber, this.textHeight, null, own);
    overlays.push(...own);
    if (!numbered) this.headerBlocks.set(key, { block, overlays: own });
    return block;
  }

  async finish() {
    await this.flushPending();
    await this.ensurePage();
    this.finishPage();
  }
}
