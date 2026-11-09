// A worksheet read for printing: its rows and cells, column widths and row heights, merged cells,
// pictures, page breaks and print setup. A port of the app's XlsxSheet.kt. Sizes are points, rows
// and columns are counted from 0.
import { SheetRefs, SheetRange, SheetUnits, SheetDates, SheetFormulas, SheetPaper, SheetStrings } from './xlsx-model.js';
import { trim, toIntOrNull, toDoubleOrNull, toInt } from './xlsx-numbers-kt.js';
import { OfficeUnits } from './office-formats.js';
import { readFill } from './drawingml.js';
import { OfficeTooLarge } from './problems.js';
import { CellKind, SheetText, readItem } from './xlsx-styles.js';
import { XmlNode } from './ooxml.js';
import { CellTexts, PAD, STACKED, FontsNeeded, rect } from './xlsx-text.js';
import { ensureFonts } from '../text/index.js';

export { CellKind } from './xlsx-styles.js';

const f = Math.fround;
const { MAX_ROWS, MAX_COLUMNS } = SheetRefs;

/** Excel's tallest row. */
export const MAX_ROW_HEIGHT = 409.5;

/** Excel keeps each header and footer to 255 characters; one far longer, in a crafted file, would take long to lay out. */
const MAX_HEADER_CHARS = 1024;

/** Far more blocks of cells than a conditional format has, unless crafted. */
const MAX_HIDDEN_RANGES = 10000;

const PAGE_SETUP_KEYS = ['paperSize', 'paperWidth', 'paperHeight', 'scale', 'fitToWidth', 'fitToHeight', 'orientation', 'pageOrder', 'firstPageNumber', 'useFirstPageNumber'];

// ---------------------------------------------------------------------------------------------
// Reading elements quickly: a sheet can have millions of cells. These read as XmlNode does.

const XMLNS = 'http://www.w3.org/2000/xmlns/';

/** An attribute by its local name, whatever its prefix, or null. */
function attrOf(el, local) {
  const v = el.getAttribute(local);
  if (v !== null) return v;
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (a.localName === local && a.namespaceURI !== XMLNS) return a.value;
  }
  return null;
}

/** A whole-number attribute (a decimal one cut towards zero), or null: XmlNode.intAttr. */
function intAttrOf(el, local) {
  const v = attrOf(el, local);
  if (v == null) return null;
  if (/^[0-9]{1,9}$/.test(v)) return +v;
  const t = trim(v);
  const i = toIntOrNull(t);
  if (i != null) return i;
  const d = toDoubleOrNull(t);
  return d == null ? null : toInt(d);
}

/** An on/off attribute: XmlNode.flag. */
function flagOf(el, local, missing) {
  const v = attrOf(el, local);
  if (v == null) return missing;
  switch (trim(v).toLowerCase()) {
    case '0': case 'false': case 'off': case 'none': return false;
    default: return true;
  }
}

/** The text directly inside an element: XmlNode.text. */
function textOf(el) {
  let out = '';
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 || n.nodeType === 4) out += n.nodeValue;
  return out;
}

/** Kotlin's toFloatOrNull of a trimmed attribute. */
function floatOf(v) {
  if (v == null) return null;
  const d = toDoubleOrNull(trim(v));
  return d == null ? null : f(d);
}

/** Kotlin's toLongOrNull (EMUs). */
function longOf(s) {
  const i = toIntOrNull(s);
  if (i != null) return i;
  return /^[+-]?[0-9]{1,18}$/.test(s) ? Number(s) : null;
}

const NUMBER = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/** Kotlin's binarySearch: the index of `key`, or -(insertion point) - 1. */
export function binarySearch(a, key, from = 0, to = a.length) {
  let low = from;
  let high = to - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const v = a[mid];
    if (v < key) low = mid + 1;
    else if (v > key) high = mid - 1;
    else return mid;
  }
  return -(low + 1);
}

// ---------------------------------------------------------------------------------------------
// Rows and cells

/**
 * A cell as read: its `column` (from 0), its format's place in cellXfs, and what it holds: nothing
 * (`kind` null, a cell with only a format), a `number` (TRUE is 1), or `text` (a SheetText).
 */
export class SheetCell {
  constructor(column, format, kind, number = 0, text = null) {
    this.column = column;
    this.format = format;
    this.kind = kind;
    this.number = number;
    this.text = text;
  }
}

/**
 * A row as read: its `index` (from 0), its cells in order, the format its empty cells take
 * (`format` -1 for none), and its own height in points when it gives one (`custom` when set by hand).
 */
export class SheetRow {
  constructor(index, cells, format, height, custom, hidden) {
    this.index = index;
    this.cells = cells;
    this.format = format;
    this.height = height;
    this.custom = custom;
    this.hidden = hidden;
  }
}

/** One cell per column, the last read of each, in order of their columns. */
function inColumnOrder(cells) {
  const byColumn = new Map();
  for (const c of cells) byColumn.set(c.column, c);
  return [...byColumn.values()].sort((a, b) => a.column - b.column);
}

/**
 * Reads a worksheet's rows, one row element at a time. Rows and cells without a reference follow
 * the ones before them, and a column given more than once in a row keeps its last cell. The first
 * cell of a formula shared by a block of cells is kept, for the others.
 */
export class RowReader {
  constructor(strings, date1904) {
    this.strings = strings;
    this.date1904 = date1904;
    this.shared = new Map();
    this.next = 0;
  }

  /** The index of row element `el`, from 0. */
  indexOf(el) {
    const r = intAttrOf(el, 'r');
    const i = r == null ? null : r - 1;
    return i != null && i >= 0 && i < MAX_ROWS ? i : Math.min(this.next, MAX_ROWS - 1);
  }

  /** Reads row element `el` (a DOM element). */
  read(el) {
    const index = this.indexOf(el);
    this.next = index + 1;
    const ht = floatOf(attrOf(el, 'ht'));
    const height = ht != null && Number.isFinite(ht) && ht >= 0 ? Math.min(ht, MAX_ROW_HEIGHT) : null;
    const custom = flagOf(el, 'customHeight', false);
    const hidden = flagOf(el, 'hidden', false);
    const format = flagOf(el, 'customFormat', false) ? intAttrOf(el, 's') ?? -1 : -1;
    let cells = [];
    let column = 0;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName !== 'c') continue;
      const at = this.columnOf(c, column);
      column = at + 1;
      if (at >= MAX_COLUMNS) continue;
      const cell = this.readCell(c, index, at);
      if (cells.length && cells[cells.length - 1].column === at) cells[cells.length - 1] = cell;
      else cells.push(cell);
      // Columns out of order can come again and again, in a crafted file: each keeps its last cell.
      if (cells.length > 2 * MAX_COLUMNS) cells = inColumnOrder(cells);
    }
    // Cells are in order in any file Excel can open; one that isn't is put in order.
    for (let i = 1; i < cells.length; i++) {
      if (cells[i - 1].column >= cells[i].column) {
        cells = inColumnOrder(cells);
        break;
      }
    }
    return new SheetRow(index, cells, format, height, custom, hidden);
  }

  /**
   * Goes past row element `el` without reading it all, as read() would leave the reader: its
   * index, the shared formulas it starts, and the cells of `anchors` (packed references) put in
   * `kept`. Returns its index.
   */
  skim(el, anchors, kept) {
    const index = this.indexOf(el);
    this.next = index + 1;
    let column = 0;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName !== 'c') continue;
      const at = this.columnOf(c, column);
      column = at + 1;
      if (at >= MAX_COLUMNS) continue;
      const key = SheetRefs.pack(index, at);
      if (anchors.has(key)) {
        kept.set(key, this.readCell(c, index, at));
        continue;
      }
      for (let d = c.firstElementChild; d; d = d.nextElementSibling) {
        if (d.localName !== 'f' || attrOf(d, 't') !== 'shared') continue;
        const group = attrOf(d, 'si');
        const text = group == null ? '' : trim(SheetStrings.unescape(textOf(d)));
        if (text) this.shared.set(group, [index, at, text]);
      }
    }
    return index;
  }

  columnOf(c, running) {
    const ref = attrOf(c, 'r');
    const packed = ref == null ? null : SheetRefs.cell(ref);
    return packed == null ? running : SheetRefs.columnOf(packed);
  }

  readCell(c, row, column) {
    const s = intAttrOf(c, 's');
    const format = s != null && s >= 0 ? s : 0;
    const type = attrOf(c, 't');
    let value = null;
    let formula = null;
    let inline = null;
    for (let d = c.firstElementChild; d; d = d.nextElementSibling) {
      switch (d.localName) {
        case 'v': value = textOf(d); break;
        case 'f': formula = this.readFormula(d, row, column); break;
        case 'is': inline = readItem(new XmlNode(d)); break;
        default: break;
      }
    }
    const v = value;
    const text = (t) => new SheetCell(column, format, CellKind.TEXT, 0, t);
    const plain = (t) => text(new SheetText(SheetStrings.unescape(t), null));
    let held = null;
    switch (type) {
      case 's': {
        const i = v == null ? null : toIntOrNull(trim(v));
        const t = i == null ? null : this.strings.get(i);
        held = t ? text(t) : null;
        break;
      }
      case 'inlineStr':
        held = inline ? text(inline) : v != null ? plain(v) : null;
        break;
      case 'str':
        held = v != null ? plain(v) : null;
        break;
      case 'b':
        if (v != null) {
          const t = trim(v);
          held = new SheetCell(column, format, CellKind.BOOLEAN, t === '1' || t.toLowerCase() === 'true' ? 1 : 0);
        }
        break;
      case 'e':
        held = v != null ? new SheetCell(column, format, CellKind.ERROR, 0, new SheetText(trim(v), null)) : null;
        break;
      case 'd':
        if (v != null) {
          const serial = SheetDates.serial(v, this.date1904);
          held = serial != null ? new SheetCell(column, format, CellKind.NUMBER, serial) : plain(v);
        }
        break;
      default:
        // A value kept but empty is a formula's empty text: the cell shows nothing, but isn't empty.
        if (v != null) {
          const n = NUMBER.test(v) ? v : trim(v);
          const d = NUMBER.test(n) ? Number(n) : toDoubleOrNull(n);
          held = d != null && Number.isFinite(d) ? new SheetCell(column, format, CellKind.NUMBER, d) : plain(n);
        }
        break;
    }
    if (held) return held;
    // A formula without a value kept for it shows as itself, rather than leave the cell blank.
    if (formula != null) return new SheetCell(column, format, CellKind.FORMULA, 0, new SheetText(`=${formula}`, null));
    return new SheetCell(column, format, null);
  }

  /** A cell's formula: its own, or the shared one moved to it. */
  readFormula(d, row, column) {
    const group = attrOf(d, 't') === 'shared' ? attrOf(d, 'si') : null;
    const text = trim(SheetStrings.unescape(textOf(d)));
    if (group == null) return text || null;
    if (text) {
      this.shared.set(group, [row, column, text]);
      return text;
    }
    const first = this.shared.get(group);
    if (!first) return null;
    return SheetFormulas.shift(first[2], row - first[0], column - first[1]);
  }
}

// ---------------------------------------------------------------------------------------------
// Columns and rows

/**
 * Every column's width in points (0 when hidden), and the format its empty cells take (-1 for
 * none). Kept for the columns up to the last that differs from those after it, which all have
 * `tailWidth` and `tailFormat`.
 */
export class ColumnWidths {
  constructor(widths, formats, tailWidth, tailFormat) {
    this.widths = widths;
    this.formats = formats;
    this.tailWidth = tailWidth;
    this.tailFormat = tailFormat;
    const o = new Float64Array(widths.length + 1);
    for (let i = 0; i < widths.length; i++) o[i + 1] = o[i] + widths[i];
    this.offsets = o;
  }

  width(column) {
    if (column < 0 || column >= MAX_COLUMNS) return 0;
    return column < this.widths.length ? this.widths[column] : this.tailWidth;
  }

  format(column) {
    if (column < 0 || column >= MAX_COLUMNS) return -1;
    return column < this.formats.length ? this.formats[column] : this.tailFormat;
  }

  /** How far `column`'s left edge is from the sheet's, in points. */
  offset(column) {
    const c = Math.min(MAX_COLUMNS, Math.max(0, column));
    const n = this.widths.length;
    return c <= n ? this.offsets[c] : this.offsets[n] + (c - n) * this.tailWidth;
  }

  /** The column `x` points from the sheet's left edge is in. */
  columnAt(x) {
    const n = this.widths.length;
    const end = this.offsets[n];
    if (x >= end) {
      if (this.tailWidth <= 0) return MAX_COLUMNS - 1;
      return Math.trunc(Math.min(n + Math.floor((x - end) / this.tailWidth), MAX_COLUMNS - 1));
    }
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (this.offsets[mid] <= x) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}

/**
 * Every row's height in points (0 when hidden): rows listed with their own height, the others the
 * sheet's default. Kept as sorted arrays, so a sheet with a million rows takes a few megabytes.
 */
export class RowHeights {
  constructor(rows, heights, fallback) {
    this.rows = rows;
    this.heights = heights;
    this.default = fallback;
    // For each listed row, the heights of the listed rows before it less the default's.
    const e = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) e[i + 1] = e[i] + heights[i] - fallback;
    this.extra = e;
  }

  height(row) {
    const i = binarySearch(this.rows, row);
    return i >= 0 ? this.heights[i] : this.default;
  }

  /** How far `row`'s top edge is from the sheet's, in points. */
  offset(row) {
    let i = binarySearch(this.rows, row);
    if (i < 0) i = -i - 1;
    return this.default * row + this.extra[i];
  }

  /** The row `y` points from the sheet's top edge is in. */
  rowAt(y) {
    let low = 0;
    let high = MAX_ROWS - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (this.offset(mid) <= y) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}

/** A picture on a sheet: part `path`, cropped by `crop` ([l, t, r, b] shares) as in Office, in `rect` ({ left, top, right, bottom } points from the sheet's top left corner). */
export class SheetPicture {
  constructor(path, crop, r) {
    this.path = path;
    this.crop = crop;
    this.rect = r;
  }
}

/** Margins in points. */
export class SheetMargins {
  constructor(left, right, top, bottom, header, footer) {
    this.left = left;
    this.right = right;
    this.top = top;
    this.bottom = bottom;
    this.header = header;
    this.footer = footer;
  }
}

/** Which columns each row has something on paper in, for leaving out pages with nothing on them. */
export class RowContent {
  constructor(rows, first, last) {
    this.rows = rows;
    this.first = first;
    this.last = last;
  }

  start(top) {
    const i = binarySearch(this.rows, top);
    return i >= 0 ? i : -i - 1;
  }

  /** Whether any row from `top` to `bottom` has something in a column from `left` to `right`. */
  any(top, bottom, left, right) {
    for (let i = this.start(top); i < this.rows.length && this.rows[i] <= bottom; i++) {
      if (this.first[i] <= right && this.last[i] >= left) return true;
    }
    return false;
  }

  /** Calls `action(row, first, last)` for each row from `top` to `bottom` with something, in order. */
  forEach(top, bottom, action) {
    for (let i = this.start(top); i < this.rows.length && this.rows[i] <= bottom; i++) action(this.rows[i], this.first[i], this.last[i]);
  }
}

/**
 * Everything a worksheet's pages are laid out from, read in a first pass through it: its columns
 * and rows, the cells with anything on paper (`used`), merged cells, pictures, page breaks and how
 * it prints (`setup`: paper as [short, long] or null for US Letter, landscape (null: portrait),
 * scale, fitToPage with fitWidth by fitHeight, margins, centring, page order, first page number,
 * header and footer).
 */
export class SheetPlan {
  constructor(fields) {
    Object.assign(this, fields);
  }
}

/**
 * The cells rows grow to fit: runs of cells side by side in a row that need the same height, from
 * column `first` to `last`.
 */
class Fits {
  constructor() {
    this.rows = [];
    this.first = [];
    this.last = [];
    this.heights = [];
  }

  /** The cell at `row` and `column` needs `height` points. */
  add(row, column, height) {
    const n = this.rows.length;
    if (n > 0 && this.rows[n - 1] === row && this.last[n - 1] === column - 1 && this.heights[n - 1] === height) {
      this.last[n - 1] = column;
      return;
    }
    this.rows.push(row);
    this.first.push(column);
    this.last.push(column);
    this.heights.push(height);
  }

  /** The runs' places, by row: as read in any file Excel can open, sorted in one that isn't. */
  inRowOrder() {
    const n = this.rows.length;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = 1; i < n; i++) {
      if (this.rows[i - 1] > this.rows[i]) return order.sort((a, b) => this.rows[a] - this.rows[b]);
    }
    return order;
  }
}

const CUSTOM = 1;
const HIDDEN = 2;

/**
 * The first pass through a worksheet (plan): everything but drawing. Rows whose height wasn't set
 * by hand grow to fit their wrapped text and larger fonts, as Excel fits them. Pictures are read
 * from the sheet's drawing; charts and shapes are left out. A sheet with more row elements than a
 * sheet has rows, which only a crafted file has, is refused as OfficeTooLarge.
 */
export class SheetPlanner {
  /** `texts`: CellTexts; `pace`: a Pace. */
  constructor(pkg, styles, strings, texts, theme, date1904, pace) {
    this.pkg = pkg;
    this.styles = styles;
    this.strings = strings;
    this.texts = texts;
    this.theme = theme;
    this.date1904 = date1904;
    this.pace = pace;
  }

  /** Plans sheet `name`, the worksheet part `part`. Resolves to a SheetPlan. */
  async plan(name, part) {
    const styles = this.styles;
    const defaultFont = styles.defaultFont;
    const digit = SheetUnits.digitWidth(defaultFont.name, defaultFont.size);
    let defaultWidth = SheetUnits.defaultColumnPoints(8, digit);
    let defaultHeight = null;
    let zeroHeight = false;
    const columnSpans = [];
    const columnWidths = [];
    const columnHidden = [];
    const rowIndices = [];
    const rowHeights = [];
    const rowFlags = [];
    const fits = new Fits();
    const contentRows = [];
    const contentFirst = [];
    const contentLast = [];
    let used = null;
    const merges = new Map();
    const valuesHidden = [];
    const rowBreaks = new Set();
    const columnBreaks = new Set();
    let drawing = null;
    let fitToPage = false;
    let gridlinesShown = true;
    let reach = -1;
    let printOptions = [false, false, false];
    let margins = new SheetMargins(f(0.7) * 72, f(0.7) * 72, f(0.75) * 72, f(0.75) * 72, f(0.3) * 72, f(0.3) * 72);
    let setupAttrs = new Map();
    let headerFooter = null;
    let columns = null;
    const reader = new RowReader(this.strings, this.date1904);

    const buildColumns = () => {
      if (columns) return columns;
      let size = 0;
      for (const span of columnSpans) size = Math.max(size, span[1] + 1);
      const tail = f(defaultWidth);
      const widths = new Float32Array(size).fill(tail);
      const formats = new Int32Array(size).fill(-1);
      for (let i = 0; i < columnSpans.length; i++) {
        const span = columnSpans[i];
        const width = columnHidden[i] ? 0 : columnWidths[i] ?? tail;
        widths.fill(width, span[0], span[1] + 1);
        formats.fill(span[2], span[0], span[1] + 1);
      }
      // The columns after those defined are as wide as the default, unless the last ones defined
      // reach the sheet's end; at the end, those like the columns after them are kept as one.
      const reachesEnd = size === MAX_COLUMNS;
      const tailWidth = reachesEnd ? widths[size - 1] : tail;
      const tailFormat = reachesEnd ? formats[size - 1] : -1;
      let kept = size;
      while (kept > 0 && widths[kept - 1] === tailWidth && formats[kept - 1] === tailFormat) kept--;
      columns = new ColumnWidths(widths.slice(0, kept), formats.slice(0, kept), tailWidth, tailFormat);
      return columns;
    };

    const x = await this.pkg.xml(part);
    if (x) {
      for (const c of x.children()) {
        switch (c.name) {
          case 'sheetPr':
            for (const d of c.children()) if (d.name === 'pageSetUpPr') fitToPage = d.flag('fitToPage', false);
            break;
          case 'sheetViews':
            for (const d of c.children()) if (d.name === 'sheetView') gridlinesShown = d.flag('showGridLines', true);
            break;
          case 'sheetFormatPr': {
            const h = floatOf(c.attr('defaultRowHeight'));
            if (h != null && Number.isFinite(h) && h > 0) defaultHeight = Math.min(h, MAX_ROW_HEIGHT);
            zeroHeight = c.flag('zeroHeight', false);
            const base = c.intAttr('baseColWidth');
            const w = c.attr('defaultColWidth');
            const given = w == null ? null : toDoubleOrNull(trim(w));
            defaultWidth = given != null && Number.isFinite(given) && given >= 0 ? SheetUnits.columnPoints(given, digit) : SheetUnits.defaultColumnPoints(base ?? 8, digit);
            break;
          }
          case 'cols':
            for (const d of c.children()) {
              // Excel writes one for each column at most: any more come from a crafted file.
              if (d.name !== 'col' || columnSpans.length >= MAX_COLUMNS) continue;
              const minAttr = d.intAttr('min');
              if (minAttr == null) continue;
              const min = minAttr - 1;
              const max = Math.min((d.intAttr('max') ?? min + 1) - 1, MAX_COLUMNS - 1);
              if (!(min >= 0 && min <= max)) continue;
              const wv = d.attr('width');
              const wd = wv == null ? null : toDoubleOrNull(trim(wv));
              const width = wd != null && Number.isFinite(wd) ? wd : null;
              columnSpans.push([min, max, d.intAttr('style') ?? -1]);
              columnWidths.push(width != null ? f(SheetUnits.columnPoints(width, digit)) : null);
              columnHidden.push(d.flag('hidden', false) || (width != null && width <= 0));
            }
            break;
          case 'sheetData': {
            const widths = buildColumns();
            const fallbackHeight = defaultHeight ?? this.rowHeightFor(defaultFont);
            for (let el = c.el.firstElementChild; el; el = el.nextElementSibling) {
              if (el.localName !== 'row') continue;
              if (this.pace.check()) await this.pace.breathe();
              const row = reader.read(el);
              rowIndices.push(row.index);
              rowHeights.push(row.height ?? NaN);
              rowFlags.push((row.custom ? CUSTOM : 0) | (row.hidden ? HIDDEN : 0));
              if (rowIndices.length > MAX_ROWS) throw new OfficeTooLarge();
              let m;
              try {
                m = this.measureRow(row, widths, fallbackHeight);
              } catch (e) {
                if (!(e instanceof FontsNeeded)) throw e;
                m = await this.measured(() => this.measureRow(row, widths, fallbackHeight));
              }
              for (const [column, height] of m.fits) fits.add(row.index, column, height);
              if (m.first >= 0) {
                // Text running on past the row's last cell with something in it prints there too.
                reach = Math.max(reach, m.reach);
                contentRows.push(row.index);
                contentFirst.push(m.first);
                contentLast.push(Math.max(m.last, m.reach));
                const cells = new SheetRange(row.index, m.first, row.index, m.last);
                used = used ? used.union(cells) : cells;
              }
            }
            break;
          }
          case 'mergeCells':
            for (const d of c.children()) {
              if (d.name !== 'mergeCell') continue;
              const ref = d.attr('ref');
              const range = ref == null ? null : SheetRefs.range(ref);
              if (range) {
                const key = `${range.firstRow},${range.firstColumn},${range.lastRow},${range.lastColumn}`;
                if (!merges.has(key)) merges.set(key, range);
              }
            }
            break;
          case 'conditionalFormatting': {
            const hidden = readValuesHidden(c);
            if (hidden) valuesHidden.push(...hidden);
            break;
          }
          case 'printOptions':
            printOptions = [c.flag('horizontalCentered', false), c.flag('verticalCentered', false), c.flag('gridLines', false)];
            break;
          case 'pageMargins': {
            const inches = (key, fallback) => {
              const v = floatOf(c.attr(key));
              return f((v != null && Number.isFinite(v) && v >= 0 ? Math.min(v, 20) : f(fallback)) * 72);
            };
            margins = new SheetMargins(inches('left', 0.7), inches('right', 0.7), inches('top', 0.75), inches('bottom', 0.75), inches('header', 0.3), inches('footer', 0.3));
            break;
          }
          case 'pageSetup':
            setupAttrs = new Map();
            for (const key of PAGE_SETUP_KEYS) {
              const v = c.attr(key);
              if (v != null) setupAttrs.set(key, v);
            }
            break;
          case 'headerFooter':
            headerFooter = readHeaderFooter(c);
            break;
          case 'rowBreaks':
            for (const d of c.children()) {
              const id = d.name === 'brk' ? d.intAttr('id') : null;
              if (id != null && id > 0) rowBreaks.add(id);
            }
            break;
          case 'colBreaks':
            for (const d of c.children()) {
              const id = d.name === 'brk' ? d.intAttr('id') : null;
              if (id != null && id > 0) columnBreaks.add(id);
            }
            break;
          case 'drawing':
            drawing = this.pkg.target(part, c.relId());
            break;
          default: break;
        }
      }
    }
    const widths = buildColumns();
    const listedDefault = defaultHeight ?? this.rowHeightFor(defaultFont);
    const fallback = zeroHeight ? 0 : listedDefault;
    const blocks = [...merges.values()];
    const rows = await this.rowHeights(rowIndices, rowHeights, rowFlags, fits, blocks, fallback, listedDefault);
    const pictures = drawing ? await this.readPictures(drawing, widths, rows) : [];
    const content = rowContent(contentRows, contentFirst, contentLast);
    // A merged block prints whole when anything in it does, such as a title centred across it.
    for (const merge of blocks) {
      if (this.pace.check()) await this.pace.breathe();
      if (content.any(merge.firstRow, merge.lastRow, merge.firstColumn, merge.lastColumn)) used = used ? used.union(merge) : merge;
    }
    // Text running on past the last column with anything in it still prints: the area reaches as far.
    if (used && reach > used.lastColumn) used = new SheetRange(used.firstRow, used.firstColumn, used.lastRow, reach);
    for (const picture of pictures) {
      const covered = pictureCells(picture, rows, widths);
      used = used ? used.union(covered) : covered;
    }
    return new SheetPlan({
      name,
      part,
      columns: widths,
      rows,
      used,
      merges: blocks,
      pictures,
      setup: pageSetup(setupAttrs, fitToPage, margins, printOptions, headerFooter),
      rowBreaks,
      columnBreaks,
      content,
      gridlinesShown,
      gridlinesPrinted: printOptions[2],
      valuesHidden,
    });
  }

  /** Runs `measure` (which may need fonts the text engine hasn't loaded) until the fonts are there. */
  async measured(measure) {
    for (let tries = 0; ; tries++) {
      try {
        return measure();
      } catch (e) {
        if (!(e instanceof FontsNeeded) || tries >= 4) throw e;
        await ensureFonts(e.runs);
      }
    }
  }

  /**
   * What row `row` puts on paper: its first and last columns with something (-1 when none), the
   * heights its cells need ([column, height] pairs, for fits), and how far its text runs on.
   */
  measureRow(row, widths, fallbackHeight) {
    const styles = this.styles;
    let first = -1;
    let last = -1;
    const needs = [];
    for (const cell of row.cells) {
      const format = styles.format(cell.format);
      // Hidden cells print nothing, so they don't make a page.
      if ((cell.kind == null && !format.showsEmpty) || row.hidden || widths.width(cell.column) <= 0) continue;
      if (first < 0) first = cell.column;
      last = cell.column;
      if (cell.kind != null && !row.custom) {
        const h = this.fitting(cell, format, widths.width(cell.column), row.height != null);
        if (h != null && h > f((row.height ?? fallbackHeight) + f(0.1))) needs.push([cell.column, h]);
      }
    }
    const reach = first >= 0 ? this.overflowReach(row, widths) : -1;
    return { first, last, fits: needs, reach };
  }

  /**
   * The last column the text of `row`'s cells runs on into, past their own, or -1 when none does.
   * Merged cells, read later, aren't known yet: the column found is at most as far as the text
   * could run. A hidden column's text doesn't print, so it doesn't run on, but it still stops the
   * text of the cells before it.
   */
  overflowReach(row, widths) {
    const styles = this.styles;
    const texts = this.texts;
    let reach = -1;
    let nextFilled = MAX_COLUMNS;
    for (let k = row.cells.length - 1; k >= 0; k--) {
      const cell = row.cells[k];
      if (cell.kind == null) continue;
      const blocked = nextFilled;
      nextFilled = cell.column;
      if ((cell.kind !== CellKind.TEXT && cell.kind !== CellKind.FORMULA) || blocked === cell.column + 1) continue;
      const format = styles.format(cell.format);
      if (format.wraps || format.shrink || format.rotation !== 0) continue;
      const width = widths.width(cell.column);
      if (width <= 0) continue;
      const shown = texts.shown(cell, format, width);
      if (!shown) continue;
      if (shown.align !== 'left' && shown.align !== 'center') continue;
      const need = texts.width(shown) + 2 * PAD + format.indent * texts.indentStep;
      if (need <= width) continue;
      const start = widths.offset(cell.column);
      const end = shown.align === 'center' ? start + (width + need) / 2 : start + need;
      reach = Math.max(reach, Math.min(blocked - 1, widths.columnAt(end)));
    }
    return reach;
  }

  /**
   * How tall `cell`'s row has to be for its text, in points, when it is text that wraps, rich text
   * or text larger than the default font; null for a cell that fits any row the default font fits.
   * A row whose file gives its height (`sized`) has been fitted by Excel already: only text that
   * wraps is measured there, as the bundled fonts can wrap it onto more lines.
   */
  fitting(cell, format, width, sized) {
    const wraps = format.wraps || format.rotation === STACKED;
    if (sized && !wraps) return null;
    const rich = cell.text?.runs != null;
    if (!wraps && !rich && format.font.size <= this.styles.defaultFont.size) return null;
    if (format.rotation >= 1 && format.rotation <= 180) return null;
    const shown = this.texts.shown(cell, format, width);
    if (!shown || shown.isEmpty) return null;
    return this.texts.height(shown, format, width);
  }

  /** The height Excel gives a row in `font` when the sheet doesn't say: a line's, in whole pixels. */
  rowHeightFor(font) {
    return f(Math.round(f(this.texts.lineHeight(font) / f(0.75))) * f(0.75));
  }

  /**
   * Every row's height: hidden rows none, rows set by hand as set, the others as given (or the
   * default) but at least as tall as their cells need (fits), except cells merged with others,
   * which Excel doesn't fit rows to.
   */
  async rowHeights(indices, heights, flags, fits, merges, fallback, listedDefault) {
    // How tall each row with cells to fit needs to be, in order of the rows, found by going down the
    // rows and the merged blocks together: each block is kept from its first row until past its last.
    const neededRows = [];
    const neededHeights = [];
    const blocks = merges.filter((m) => m.firstRow !== m.lastRow || m.firstColumn !== m.lastColumn).sort((a, b) => a.firstRow - b.firstRow);
    let over = [];
    let nextBlock = 0;
    for (const i of fits.inRowOrder()) {
      const row = fits.rows[i];
      if (neededRows.length === 0 || neededRows[neededRows.length - 1] !== row) {
        if (this.pace.check()) await this.pace.breathe();
        over = over.filter((b) => b.lastRow >= row);
        while (nextBlock < blocks.length && blocks[nextBlock].firstRow <= row) {
          if (blocks[nextBlock].lastRow >= row) over.push(blocks[nextBlock]);
          nextBlock++;
        }
        neededRows.push(row);
        neededHeights.push(0);
      }
      if (merged(fits.first[i], fits.last[i], over)) continue;
      const last = neededHeights.length - 1;
      neededHeights[last] = Math.max(neededHeights[last], fits.heights[i]);
    }
    const count = indices.length;
    // Rows are in order in any file Excel can open; those of one that isn't are put in order.
    let order = null;
    for (let i = 1; i < count; i++) {
      if (indices[i - 1] > indices[i]) {
        order = Array.from({ length: count }, (_, k) => k).sort((a, b) => indices[a] - indices[b]);
        break;
      }
    }
    const rows = [];
    const values = [];
    let nextNeeded = 0;
    for (let k = 0; k < count; k++) {
      const i = order ? order[k] : k;
      const row = indices[i];
      if (rows.length > 0 && rows[rows.length - 1] === row) continue;
      while (nextNeeded < neededRows.length && neededRows[nextNeeded] < row) nextNeeded++;
      const needed = nextNeeded < neededRows.length && neededRows[nextNeeded] === row ? neededHeights[nextNeeded] : 0;
      const flag = flags[i];
      const given = heights[i];
      let height;
      if (flag & HIDDEN) height = 0;
      else if (flag & CUSTOM) height = Number.isNaN(given) ? listedDefault : given;
      else height = Math.max(Number.isNaN(given) ? listedDefault : given, needed);
      rows.push(row);
      values.push(Math.min(height, MAX_ROW_HEIGHT));
    }
    return new RowHeights(Int32Array.from(rows), Float32Array.from(values), fallback);
  }

  /**
   * The pictures in drawing part `path`, placed by their anchors: between two cells, from a cell
   * with a size, or at a place on the sheet. Charts, shapes and groups are left out.
   */
  async readPictures(path, columns, rows) {
    const pictures = [];
    const scheme = (name) => this.theme.colors.get(name) ?? null;
    const x = await this.pkg.xml(path);
    if (!x) return pictures;
    for (const a of x.children()) {
      const anchor = a.name;
      if (anchor !== 'twoCellAnchor' && anchor !== 'oneCellAnchor' && anchor !== 'absoluteAnchor') continue;
      let from = null;
      let to = null;
      let size = null;
      let image = null;
      const marker = (m) => {
        let column = 0;
        let columnOffset = 0;
        let row = 0;
        let rowOffset = 0;
        for (const d of m.children()) {
          const value = trim(d.text());
          switch (d.name) {
            case 'col': { const v = toIntOrNull(value); column = v == null ? 0 : Math.min(MAX_COLUMNS - 1, Math.max(0, v)); break; }
            case 'colOff': columnOffset = longOf(value) ?? 0; break;
            case 'row': { const v = toIntOrNull(value); row = v == null ? 0 : Math.min(MAX_ROWS - 1, Math.max(0, v)); break; }
            case 'rowOff': rowOffset = longOf(value) ?? 0; break;
            default: break;
          }
        }
        return [columns.offset(column) + OfficeUnits.emu(columnOffset), rows.offset(row) + OfficeUnits.emu(rowOffset)];
      };
      const picture = (pic) => {
        for (const d of pic.children()) {
          if (d.name !== 'blipFill') continue;
          const fill = readFill(d, this.pkg, path, scheme);
          if (fill?.type === 'image') image = fill;
        }
      };
      for (const d of a.children()) {
        switch (d.name) {
          case 'from': from = marker(d); break;
          case 'to': to = marker(d); break;
          case 'pos': from = [OfficeUnits.emu(d.longAttr('x') ?? 0), OfficeUnits.emu(d.longAttr('y') ?? 0)]; break;
          case 'ext': size = [OfficeUnits.emu(d.longAttr('cx') ?? 0), OfficeUnits.emu(d.longAttr('cy') ?? 0)]; break;
          case 'pic': picture(d); break;
          case 'AlternateContent':
            for (const choice of d.children()) {
              if (image != null) continue;
              for (const e of choice.children()) if (e.name === 'pic') picture(e);
            }
            break;
          default: break;
        }
      }
      if (!from || !image) continue;
      const end = anchor === 'twoCellAnchor' ? to : size ? [from[0] + size[0], from[1] + size[1]] : null;
      if (!end || end[0] <= from[0] || end[1] <= from[1]) continue;
      pictures.push(new SheetPicture(image.path, image.crop, rect(f(from[0]), f(from[1]), f(end[0]), f(end[1]))));
    }
    return pictures;
  }
}

/** The cells picture `picture` covers. */
export function pictureCells(picture, rows, columns) {
  const r = picture.rect;
  return new SheetRange(
    rows.rowAt(r.top), columns.columnAt(r.left),
    rows.rowAt(Math.max(r.top, f(r.bottom - f(0.01)))), columns.columnAt(Math.max(r.left, f(r.right - f(0.01)))),
  );
}

/** Whether every column from `first` to `last` is in one of the merged blocks `over`. */
function merged(first, last, over) {
  let column = first;
  while (column <= last) {
    const block = over.find((b) => column >= b.firstColumn && column <= b.lastColumn);
    if (!block) return false;
    column = block.lastColumn + 1;
  }
  return true;
}

/** Which columns each row has something in, in the order of the rows, as RowContent looks them up. */
function rowContent(rows, first, last) {
  let sorted = true;
  for (let i = 1; i < rows.length; i++) if (rows[i - 1] >= rows[i]) { sorted = false; break; }
  if (sorted) return new RowContent(Int32Array.from(rows), Int32Array.from(first), Int32Array.from(last));
  // Rows out of order, in a file Excel wouldn't write.
  const order = Array.from({ length: rows.length }, (_, i) => i).sort((a, b) => rows[a] - rows[b]);
  return new RowContent(Int32Array.from(order, (i) => rows[i]), Int32Array.from(order, (i) => first[i]), Int32Array.from(order, (i) => last[i]));
}

/**
 * The cells whose values a conditional format (`x`, an XmlNode) hides: those of a data bar or an
 * icon set set to show only the bar or the icon. Null when it hides none.
 */
function readValuesHidden(x) {
  const ranges = x.attr('sqref');
  let hides = false;
  for (const rule of x.children()) {
    if (rule.name !== 'cfRule') continue;
    for (const d of rule.children()) if ((d.name === 'dataBar' || d.name === 'iconSet') && !d.flag('showValue', true)) hides = true;
  }
  if (!hides || ranges == null) return null;
  return ranges.split(' ').filter((s) => s.length > 0).slice(0, MAX_HIDDEN_RANGES).map((s) => SheetRefs.range(s)).filter((r) => r != null);
}

/** A sheet's header and footer texts (in Excel's codes, such as "&CPage &P"), and when each applies. */
function readHeaderFooter(x) {
  const texts = new Map();
  for (const d of x.children()) texts.set(d.name, SheetStrings.unescape(d.text().slice(0, MAX_HEADER_CHARS)));
  const get = (k) => texts.get(k) ?? null;
  return {
    oddHeader: get('oddHeader'),
    oddFooter: get('oddFooter'),
    evenHeader: get('evenHeader'),
    evenFooter: get('evenFooter'),
    firstHeader: get('firstHeader'),
    firstFooter: get('firstFooter'),
    differentFirst: x.flag('differentFirst', false),
    differentOddEven: x.flag('differentOddEven', false),
    scaleWithDoc: x.flag('scaleWithDoc', true),
  };
}

/** How a sheet prints, as its file says. */
function pageSetup(attrs, fitToPage, margins, options, headerFooter) {
  const int = (key) => {
    const v = attrs.get(key);
    return v == null ? null : toIntOrNull(trim(v));
  };
  const width = SheetPaper.length(attrs.get('paperWidth') ?? null);
  const height = SheetPaper.length(attrs.get('paperHeight') ?? null);
  const code = int('paperSize');
  const paper = width != null && height != null ? [Math.min(width, height), Math.max(width, height)] : code != null ? SheetPaper.size(code) : null;
  const orientation = attrs.get('orientation');
  const landscape = orientation === 'landscape' ? true : orientation === 'portrait' ? false : null;
  const first = attrs.get('useFirstPageNumber');
  const useFirst = first === '1' || first === 'true';
  return {
    paper,
    landscape,
    scale: Math.min(400, Math.max(10, int('scale') ?? 100)),
    fitToPage,
    fitWidth: Math.max(0, int('fitToWidth') ?? 1),
    fitHeight: Math.max(0, int('fitToHeight') ?? 1),
    margins,
    centerHorizontally: options[0],
    centerVertically: options[1],
    downThenOver: attrs.get('pageOrder') !== 'overThenDown',
    firstPageNumber: useFirst ? int('firstPageNumber') : null,
    headerFooter,
  };
}

export { CellTexts };
