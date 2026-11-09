// The pieces of a workbook that aren't number formats (the app's Spreadsheets.kt): cell references
// and ranges, print areas and titles, column widths, splitting a sheet into pages, paper sizes,
// colours, dates of type "d", escaped text, shared formulas, and headers and footers.
// Pure functions: no DOM, nothing thrown for any input.
import {
  trim, isDigit, isLetter, isLetterOrDigit, digitOf, toIntOrNull, toDoubleOrNull, toInt, roundToInt, coerceIn,
} from './xlsx-numbers-kt.js';
import { daysFromCivil } from './xlsx-numbers.js';

/** A block of cells: rows and columns counted from 0, both ends included. */
export class SheetRange {
  constructor(firstRow, firstColumn, lastRow, lastColumn) {
    this.firstRow = firstRow;
    this.firstColumn = firstColumn;
    this.lastRow = lastRow;
    this.lastColumn = lastColumn;
  }

  contains(row, column) {
    return row >= this.firstRow && row <= this.lastRow && column >= this.firstColumn && column <= this.lastColumn;
  }

  /** The smallest range holding this one and `other`. */
  union(other) {
    return new SheetRange(
      Math.min(this.firstRow, other.firstRow), Math.min(this.firstColumn, other.firstColumn),
      Math.max(this.lastRow, other.lastRow), Math.max(this.lastColumn, other.lastColumn),
    );
  }

  /** The cells this range and `other` share, or null when they share none. */
  intersect(other) {
    const top = Math.max(this.firstRow, other.firstRow);
    const left = Math.max(this.firstColumn, other.firstColumn);
    const bottom = Math.min(this.lastRow, other.lastRow);
    const right = Math.min(this.lastColumn, other.lastColumn);
    return top <= bottom && left <= right ? new SheetRange(top, left, bottom, right) : null;
  }

  equals(other) {
    return other instanceof SheetRange && other.firstRow === this.firstRow && other.firstColumn === this.firstColumn
      && other.lastRow === this.lastRow && other.lastColumn === this.lastColumn;
  }
}

// ---------------------------------------------------------------------------------------------
// Cell references

/** The most rows and columns a sheet has: row 1,048,576 and column XFD. */
const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;
const PACK = 1048576;

/** A letter A-Z or a-z as 1 to 26, or 0. */
function letterValue(c) {
  const code = c.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 64;
  if (code >= 97 && code <= 122) return code - 96;
  return 0;
}

/** The column `letters` name ("A", "AB", "XFD", any case), counted from 0; null when it isn't a column. */
function column(letters) {
  if (typeof letters !== 'string' || letters.length === 0 || letters.length > 3) return null;
  let n = 0;
  for (const c of letters) {
    const digit = c.length === 1 ? letterValue(c) : 0;
    if (!digit) return null;
    n = n * 26 + digit;
  }
  return n - 1 < MAX_COLUMNS ? n - 1 : null;
}

/** Column `index` (from 0) as its letters. */
function columnName(index) {
  let out = '';
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * A cell reference such as "B3" or "$B$3": its row and column from 0, packed by pack(). Null when
 * `ref` isn't one. Read once for every cell of a sheet, so it is parsed by hand.
 */
function cell(ref) {
  if (typeof ref !== 'string') return null;
  let i = 0;
  const n = ref.length;
  if (i < n && ref[i] === '$') i++;
  let col = 0;
  let letters = 0;
  while (i < n) {
    const digit = letterValue(ref[i]);
    if (!digit) break;
    col = col * 26 + digit;
    letters++;
    i++;
  }
  if (letters === 0 || letters > 3 || col > MAX_COLUMNS) return null;
  if (i < n && ref[i] === '$') i++;
  if (i >= n) return null;
  let row = 0;
  while (i < n) {
    const code = ref.charCodeAt(i);
    if (code < 48 || code > 57 || row > MAX_ROWS) return null;
    row = row * 10 + (code - 48);
    i++;
  }
  if (row < 1 || row > MAX_ROWS) return null;
  return pack(row - 1, col - 1);
}

/** A row and column held in one number, as cell() gives them (row × 2^20 + column). */
function pack(row, col) {
  return row * PACK + col;
}

function rowOf(packed) {
  return Math.floor(packed / PACK);
}

function columnOf(packed) {
  return packed % PACK;
}

function removeDollar(s) {
  return s.startsWith('$') ? s.slice(1) : s;
}

/** A row number 1..MAX_ROWS as Kotlin's toIntOrNull reads it, or null. */
function rowNumber(text) {
  const n = toIntOrNull(text);
  return n !== null && n >= 1 && n <= MAX_ROWS ? n : null;
}

/**
 * A range such as "A1:C5" or "$A$1", whole columns ("A:C", "$B:$B") or whole rows ("1:3"), with
 * its corners in either order. Null when `ref` is none of these.
 */
function range(ref) {
  if (typeof ref !== 'string') return null;
  const parts = trim(ref).split(':');
  if (parts.length > 2 || parts.some((p) => p.length === 0)) return null;
  const first = removeDollar(parts[0]);
  const last = removeDollar(parts[parts.length - 1]);
  const a = cell(parts[0]);
  if (a !== null) {
    const b = cell(parts[parts.length - 1]);
    if (b === null) return null;
    return new SheetRange(
      Math.min(rowOf(a), rowOf(b)), Math.min(columnOf(a), columnOf(b)),
      Math.max(rowOf(a), rowOf(b)), Math.max(columnOf(a), columnOf(b)),
    );
  }
  if (parts.length !== 2) return null;
  const fromColumn = column(first);
  const toColumn = column(last);
  if (fromColumn !== null && toColumn !== null) {
    return new SheetRange(0, Math.min(fromColumn, toColumn), MAX_ROWS - 1, Math.max(fromColumn, toColumn));
  }
  const fromRow = rowNumber(first);
  const toRow = rowNumber(last);
  if (fromRow !== null && toRow !== null) {
    return new SheetRange(Math.min(fromRow, toRow) - 1, 0, Math.max(fromRow, toRow) - 1, MAX_COLUMNS - 1);
  }
  return null;
}

/**
 * The areas a defined name's formula refers to, each { sheet, range } with the sheet it names
 * (unquoted, or null when it names none): "Sheet1!$A$1:$F$20,Sheet1!$H$1:$J$5" has two. Parts that
 * aren't ranges (a #REF! left by a deleted sheet, say) are left out.
 */
function areas(formula) {
  if (typeof formula !== 'string') return [];
  const out = [];
  let text = trim(formula);
  if (text.startsWith('=')) text = text.slice(1);
  for (const part of splitOutsideQuotes(text, ',')) {
    const bang = lastIndexOutsideQuotes(part, '!');
    const sheet = bang < 0 ? null : unquote(trim(part.slice(0, bang)));
    const r = range(trim(part.slice(bang + 1)));
    if (r) out.push({ sheet, range: r });
  }
  return out;
}

/** A sheet name as written in a reference: 'It''s here' is It's here. */
function unquote(name) {
  return name.length >= 2 && name.startsWith("'") && name.endsWith("'") ? name.slice(1, -1).replaceAll("''", "'") : name;
}

function splitOutsideQuotes(text, separator) {
  const parts = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") quoted = !quoted;
    else if (c === separator && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function lastIndexOutsideQuotes(text, char) {
  let quoted = false;
  let found = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") quoted = !quoted;
    else if (c === char && !quoted) found = i;
  }
  return found;
}

/**
 * Cell references as spreadsheets write them: "B3", "$A$1:$F$20", whole columns ("A:C"), whole rows
 * ("1:3"), and the areas of a defined name, such as "'Sales 2024'!$A$1:$F$20,'Sales 2024'!$H$1:$J$5".
 */
export const SheetRefs = Object.freeze({
  MAX_ROWS, MAX_COLUMNS, column, columnName, cell, pack, rowOf, columnOf, range, areas,
});

// ---------------------------------------------------------------------------------------------
// Sizes

/** Calibri 11's widest digit, 7 pixels, as Excel measures it. */
const DIGIT_WIDTH = 7;

/** A column `width` as a file stores it, in points, for a default font whose widest digit is `digitWidth` pixels. */
function columnPoints(width, digitWidth = DIGIT_WIDTH) {
  if (!(width > 0)) return 0;
  const pixels = Math.floor(((256 * Math.min(width, 255) + Math.floor(128 / digitWidth)) / 256) * digitWidth);
  return pixels * 0.75;
}

/**
 * The default column width of a sheet that gives only how many digits fit (`baseWidth`, 8 when
 * it doesn't say): those digits and 5 pixels of padding, rounded up to 8 pixels, as Excel draws it.
 * Calibri 11's columns are 64 pixels wide this way.
 */
function defaultColumnPoints(baseWidth, digitWidth = DIGIT_WIDTH) {
  return Math.ceil((coerceIn(toInt(baseWidth), 0, 255) * digitWidth + 5) / 8) * 8 * 0.75;
}

/**
 * The widest digit of the default font `name` at `size` points, in pixels at 96 dpi, as Excel
 * measures it for column widths: 7 for Calibri 11, Aptos Narrow 11 and Arial 10.
 */
function digitWidth(name, size) {
  // A size that isn't a number (only a broken file gives one) counts as the smallest, where Kotlin would stop.
  const s = Number.isNaN(size) ? 1 : coerceIn(size, 1, 409);
  return Math.max(roundToInt(s * 96 / 72 * (digitEm(name) ?? 0.55)), 1);
}

/**
 * How wide the digits of the Office font `name` are, as a share of its size; null for a font
 * Usugami doesn't know. Fonts on the device are drawn narrower or wider by the ratio, so that text
 * takes the room in its cells that it takes in Excel.
 */
function digitEm(name) {
  const n = (name ?? '').toLowerCase();
  const has = (s) => n.includes(s);
  if (has('calibri') || has('aptos narrow') || has('carlito')) return 0.507;
  if (has('aptos')) return 0.55;
  if (has('arial narrow')) return 0.456;
  if (has('arial') || has('helvetica') || has('liberation sans') || has('arimo')) return 0.556;
  if (has('times') || has('liberation serif') || has('tinos')) return 0.5;
  if (has('cambria') || has('caladea')) return 0.556;
  if (has('garamond')) return 0.47;
  if (has('book antiqua') || has('palatino')) return 0.5;
  if (has('georgia')) return 0.61;
  if (has('verdana')) return 0.636;
  if (has('tahoma')) return 0.546;
  if (has('segoe ui')) return 0.559;
  if (has('trebuchet')) return 0.524;
  if (has('century gothic')) return 0.551;
  if (has('courier') || has('consolas') || has('lucida console') || has('mono')) return 0.6;
  return null;
}

/**
 * Sizes in spreadsheets. Column widths are counted in characters of the default font's widest digit
 * (with a few pixels of padding), which Excel turns into whole pixels at 96 dpi; a pixel is 0.75 points.
 */
export const SheetUnits = Object.freeze({ DIGIT_WIDTH, columnPoints, defaultColumnPoints, digitWidth, digitEm });

// ---------------------------------------------------------------------------------------------
// Pages

/** Excel's smallest and largest print scales, in percent. */
const MIN_SCALE = 10;
const MAX_SCALE = 400;
const EPSILON = 1e-6;

function walk(sizes, space, scale, breaks, titleSize, titleEnd, start) {
  if (!sizes || sizes.length === 0) return;
  const hasBreaks = breaks != null && breaks.size > 0;
  let used = 0;
  let room = 0;
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i] * scale;
    if (i === 0 || (hasBreaks && breaks.has(i)) || (used > 0 && used + size > room + EPSILON)) {
      start(i);
      room = i > titleEnd ? space - titleSize * scale : space;
      used = 0;
    }
    used += size;
  }
}

function asSet(breaks) {
  if (breaks instanceof Set) return breaks;
  return breaks ? new Set(breaks) : new Set();
}

/**
 * Splits `sizes` (the printed rows' heights or columns' widths, in points before `scale`) into
 * bands that each fit in `space` points: a single row or column too big for a page gets one of its
 * own. A page breaks before each index in `breaks`. A band starting after `titleEnd` has
 * `titleSize` points less room, which the repeated title rows or columns take; with a `titleEnd`
 * below 0 every band has. Returns the first index of each band.
 */
function bands(sizes, space, { scale = 1, breaks, titleSize = 0, titleEnd = -1 } = {}) {
  const starts = [];
  walk(sizes, space, scale, asSet(breaks), titleSize, titleEnd, (i) => starts.push(i));
  return starts;
}

/** How many bands bands() makes, without keeping them. */
function count(sizes, space, { scale = 1, breaks, titleSize = 0, titleEnd = -1 } = {}) {
  let n = 0;
  walk(sizes, space, scale, asSet(breaks), titleSize, titleEnd, () => n++);
  return n;
}

function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * The scale, in whole percent, at which `widths` fit `pagesWide` pages of `width` points and
 * `heights` fit `pagesTall` pages of `height` (0 leaves that side free), as Excel's "Fit to" does:
 * the largest up to `most` percent (100, as it only ever shrinks), and never less than
 * MIN_SCALE. `columnTitle` and `rowTitle` are the repeated titles' [size, end] (see bands()).
 */
function fitScale(widths, heights, width, height, pagesWide, pagesTall, {
  columnBreaks, rowBreaks, columnTitle = [0, -1], rowTitle = [0, -1], most = 100,
} = {}) {
  const cBreaks = asSet(columnBreaks);
  const rBreaks = asSet(rowBreaks);
  const fits = (percent) => {
    const s = percent / 100;
    if (pagesWide > 0 && count(widths, width, { scale: s, breaks: cBreaks, titleSize: columnTitle[0], titleEnd: columnTitle[1] }) > pagesWide) return false;
    if (pagesTall > 0 && count(heights, height, { scale: s, breaks: rBreaks, titleSize: rowTitle[0], titleEnd: rowTitle[1] }) > pagesTall) return false;
    return true;
  };
  const limit = coerceIn(toInt(most), MIN_SCALE, MAX_SCALE);
  // A first guess from the totals; then a percent at a time, as bands break between whole rows.
  let guess = limit;
  if (pagesWide > 0) {
    const total = sum(widths);
    if (total > 0) guess = Math.min(guess, width * pagesWide / total * 100);
  }
  if (pagesTall > 0) {
    const total = sum(heights);
    if (total > 0) guess = Math.min(guess, height * pagesTall / total * 100);
  }
  let percent = coerceIn(toInt(Math.floor(guess + EPSILON)), MIN_SCALE, limit);
  while (percent > MIN_SCALE && !fits(percent)) percent--;
  return percent;
}

/**
 * `pages`, each a [row band, column band], in the order they print: down the sheet and then over
 * to the next columns, as Excel prints by default, or over and then down.
 */
function order(pages, downThenOver) {
  const list = [...pages];
  return downThenOver
    ? list.sort((a, b) => a[1] - b[1] || a[0] - b[0])
    : list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Splitting a printed sheet into pages, and how much it is shrunk to fit them. */
export const SheetPages = Object.freeze({ MIN_SCALE, MAX_SCALE, bands, count, fitScale, order });

// ---------------------------------------------------------------------------------------------
// Paper

const inches = (w, h) => [w * 72, h * 72];
const mm = (w, h) => [w * 72 / 25.4, h * 72 / 25.4];

const SIZES = new Map(Object.entries({
  1: inches(8.5, 11), 2: inches(8.5, 11), 3: inches(11, 17), 4: inches(11, 17),
  5: inches(8.5, 14), 6: inches(5.5, 8.5), 7: inches(7.25, 10.5), 8: mm(297, 420),
  9: mm(210, 297), 10: mm(210, 297), 11: mm(148, 210), 12: mm(257, 364),
  13: mm(182, 257), 14: inches(8.5, 13), 15: mm(215, 275), 16: inches(10, 14),
  17: inches(11, 17), 18: inches(8.5, 11), 19: inches(3.875, 8.875), 20: inches(4.125, 9.5),
  21: inches(4.5, 10.375), 22: inches(4.75, 11), 23: inches(5, 11.5), 24: inches(17, 22),
  25: inches(22, 34), 26: inches(34, 44), 27: mm(110, 220), 28: mm(162, 229),
  29: mm(324, 458), 30: mm(229, 324), 31: mm(114, 162), 32: mm(114, 229),
  33: mm(250, 353), 34: mm(176, 250), 35: mm(176, 125), 36: mm(110, 230),
  37: inches(3.875, 7.5), 38: inches(3.625, 6.5), 39: inches(14.875, 11), 40: inches(8.5, 12),
  41: inches(8.5, 13), 43: mm(100, 148), 66: mm(420, 594), 70: mm(105, 148),
}).map(([code, [a, b]]) => [Number(code), Object.freeze([Math.min(a, b), Math.max(a, b)])]));

/** An inch: no paper is smaller. */
const MIN_SIDE = 72;

/** 200 inches, the longest page PDF readers show. */
const MAX_SIDE = 14400;

/** Paper size `code`'s [short side, long side] in points, or null for a code Usugami doesn't know. */
function size(code) {
  return SIZES.get(code) ?? null;
}

/**
 * A length as pageSetup's paperWidth and paperHeight write it, such as "210mm" or "8.5in", in
 * points; null when it isn't one, or is shorter than MIN_SIDE or longer than MAX_SIDE, which
 * only a crafted file asks for.
 */
function length(text) {
  if (typeof text !== 'string') return null;
  const t = trim(text).toLowerCase();
  if (t.length < 2 || t.length > 32) return null;
  let cut = t.length;
  while (cut > 0 && isLetter(t[cut - 1])) cut--;
  const unit = t.slice(cut);
  const number = toDoubleOrNull(trim(t.slice(0, cut)));
  if (number === null || !(number > 0) || !Number.isFinite(number)) return null;
  let points;
  if (unit === 'mm') points = number * 72 / 25.4;
  else if (unit === 'cm') points = number * 72 / 2.54;
  else if (unit === 'in') points = number * 72;
  else if (unit === 'pt') points = number;
  else return null;
  return points >= MIN_SIDE && points <= MAX_SIDE ? points : null;
}

/** Paper sizes by the number Excel gives them (pageSetup's paperSize), in points, the short side first. */
export const SheetPaper = Object.freeze({ MIN_SIDE, MAX_SIDE, size, length });

// ---------------------------------------------------------------------------------------------
// Colours

const PALETTE = [
  0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff,
  0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff,
  0x800000, 0x008000, 0x000080, 0x808000, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
  0x9999ff, 0x993366, 0xffffcc, 0xccffff, 0x660066, 0xff8080, 0x0066cc, 0xccccff,
  0x000080, 0xff00ff, 0xffff00, 0x00ffff, 0x800080, 0x800000, 0x008080, 0x0000ff,
  0x00ccff, 0xccffff, 0xccffcc, 0xffff99, 0x99ccff, 0xff99cc, 0xcc99ff, 0xffcc99,
  0x3366ff, 0x33cccc, 0x99cc00, 0xffcc00, 0xff9900, 0xff6600, 0x666699, 0x969696,
  0x003366, 0x339966, 0x003300, 0x333300, 0x993300, 0x993366, 0x333399, 0x333333,
];

const opaque = (rgb) => (rgb | 0xff000000) >>> 0;

/** Indexed colour `index` of the default palette, as ARGB: 64 is the text colour (black), 65 the background (white). */
function indexed(index) {
  if (Number.isInteger(index) && index >= 0 && index < PALETTE.length) return opaque(PALETTE[index]);
  if (index === 64) return opaque(0x000000);
  if (index === 65) return opaque(0xffffff);
  return null;
}

const THEME_KEYS = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/**
 * The theme colour a spreadsheet means by number `index`: Excel counts the first four in another
 * order than the theme lists them (background before text).
 */
function themeKey(index) {
  return THEME_KEYS[index] ?? null;
}

const f32 = Math.fround;

/** Kotlin's Float.mod: the remainder with the sign of the divisor. */
function fmod(x, m) {
  const r = f32(x % m);
  return r !== 0 && (r < 0) !== (m < 0) ? f32(r + m) : r;
}

function toHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = f32(f32(max + min) / 2);
  if (max === min) return [0, 0, l];
  const d = f32(max - min);
  const s = l > 0.5 ? f32(d / f32(f32(2 - max) - min)) : f32(d / f32(max + min));
  let h;
  if (max === r) h = f32(f32(f32(g - b) / d) + (g < b ? 6 : 0));
  else if (max === g) h = f32(f32(f32(b - r) / d) + 2);
  else h = f32(f32(f32(r - g) / d) + 4);
  return [f32(h / 6), s, l];
}

function fromHsl(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? f32(l * f32(1 + s)) : f32(f32(l + s) - f32(l * s));
  const p = f32(f32(2 * l) - q);
  const third = f32(1 / 3);
  const hue = (t0) => {
    const t = fmod(t0, 1);
    if (t < f32(1 / 6)) return f32(p + f32(f32(f32(q - p) * 6) * t));
    if (t < 0.5) return q;
    if (t < f32(2 / 3)) return f32(p + f32(f32(f32(q - p) * f32(f32(2 / 3) - t)) * 6));
    return p;
  };
  return [hue(f32(h + third)), hue(h), hue(f32(h - third))];
}

/**
 * DrawingML's lumMod and lumOff on `argb`, as OfficeColors.modify works them out, in 32-bit floats
 * as the app does so that the rounding comes out the same.
 */
function modifyLuminance(argbValue, modifiers) {
  const v32 = argbValue >>> 0;
  const a = f32(((v32 >>> 24) & 0xff) / 255);
  let r = f32(((v32 >>> 16) & 0xff) / 255);
  let g = f32(((v32 >>> 8) & 0xff) / 255);
  let b = f32((v32 & 0xff) / 255);
  for (const [name, raw] of modifiers) {
    const v = f32(raw / 100000);
    const hsl = toHsl(r, g, b);
    if (name === 'lumMod') hsl[2] = f32(hsl[2] * v);
    else hsl[2] = f32(hsl[2] + v);
    hsl[1] = coerceIn(hsl[1], 0, 1);
    hsl[2] = coerceIn(hsl[2], 0, 1);
    [r, g, b] = fromHsl(hsl[0], hsl[1], hsl[2]);
  }
  const channel = (x) => Math.round(f32(coerceIn(x, 0, 1) * 255));
  return ((channel(a) << 24) | (channel(r) << 16) | (channel(g) << 8) | channel(b)) >>> 0;
}

/**
 * `argb` made lighter (a `tint` up to 1) or darker (down to -1), as Excel tints a colour: its
 * lightness is moved that share of the way towards white or black.
 */
function tint(argbValue, amount) {
  if (amount === 0 || Number.isNaN(amount) || typeof amount !== 'number') return argbValue;
  const t = coerceIn(amount, -1, 1);
  const modifiers = t < 0
    ? [['lumMod', roundToInt((1 + t) * 100000)]]
    : [['lumMod', roundToInt((1 - t) * 100000)], ['lumOff', roundToInt(t * 100000)]];
  return modifyLuminance(argbValue, modifiers);
}

/** "4472C4" (with or without #) as an opaque ARGB colour, or null, as OfficeColors.hex reads it. */
function hex(text) {
  if (typeof text !== 'string') return null;
  let t = trim(text);
  if (t.startsWith('#')) t = t.slice(1);
  if (t.length !== 6) return null;
  let value = 0;
  for (const c of t) {
    const d = digitOf(c, 16);
    if (d < 0) return null;
    value = value * 16 + d;
  }
  return opaque(value);
}

/**
 * An "rgb" attribute such as "FF4472C4", or "4472C4", as an opaque ARGB colour. Excel ignores
 * the alpha byte, which some apps write as 00.
 */
function rgb(text) {
  if (typeof text !== 'string') return null;
  const t = trim(text);
  if (t.length === 8) return hex(t.slice(2));
  if (t.length === 6) return hex(t);
  return null;
}

/**
 * Colours as spreadsheets give them: by number from a palette of 64, by theme, with a tint. Colours
 * are ARGB numbers, 0 to 0xFFFFFFFF (opaque red is 0xFFFF0000).
 */
export const SheetColors = Object.freeze({ indexed, themeKey, tint, rgb, hex });

// ---------------------------------------------------------------------------------------------
// Dates

const ISO = /^(?:(\d{4})-(\d{2})-(\d{2}))?(?:T?(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/;
const DAYS_1904 = daysFromCivil(1904, 1, 1);
const DAYS_1899_12_31 = daysFromCivil(1899, 12, 31);

/**
 * An ISO 8601 date and time as a cell of type "d" holds it ("2024-03-15", "2024-03-15T10:30:00",
 * or a time alone, "10:30:00"), as the number Excel stores for it; null when it isn't one.
 */
function serial(iso, date1904 = false) {
  if (typeof iso !== 'string') return null;
  let text = trim(iso);
  if (text.endsWith('Z')) text = text.slice(0, -1);
  if (!text) return null;
  const m = ISO.exec(text);
  if (!m) return null;
  const [, y = '', mo = '', d = '', h = '', mi = '', s = ''] = m;
  let days = 0;
  if (y) {
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const sinceEpoch = daysFromCivil(year, month, day);
    if (date1904) {
      days = sinceEpoch - DAYS_1904;
    } else {
      // Excel counts a 29 February 1900 that never was, so later dates are a day further on.
      const from = sinceEpoch - DAYS_1899_12_31;
      days = from >= 60 ? from + 1 : from;
    }
  }
  if (h) {
    const seconds = Number(h) * 3600 + Number(mi) * 60 + (s ? Number(s) : 0);
    days += seconds / 86400;
  }
  return days;
}

/** Dates in spreadsheets: numbers of days from the start of 1900 (or of 1904, in old Mac files). */
export const SheetDates = Object.freeze({ serial });

// ---------------------------------------------------------------------------------------------
// Text

/** `text` with each _xHHHH_ turned back into its character (_x005F_ is the underscore itself). */
function unescape(text) {
  if (typeof text !== 'string') return '';
  if (!text.includes('_x')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '_' && i + 6 < text.length && text[i + 1] === 'x' && text[i + 6] === '_') {
      const code = toIntOrNull(text.slice(i + 2, i + 6), 16);
      if (code !== null) {
        // As Kotlin's Int.toChar(): the low 16 bits.
        out += String.fromCharCode(code & 0xffff);
        i += 7;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Text in spreadsheets. Excel writes characters XML can't hold as _xHHHH_: a carriage return is _x000D_. */
export const SheetStrings = Object.freeze({ unescape });

// ---------------------------------------------------------------------------------------------
// Formulas

const REFERENCE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;

/** `word` moved, when it is a cell reference such as B3, $B3, B$3 or $B$3; null when it is something else. */
function shiftReference(word, rows, columns) {
  const m = REFERENCE.exec(word);
  if (!m) return null;
  const [, absColumn, letters, absRow, digits] = m;
  const col = column(letters);
  if (col === null) return null;
  const row = Number(digits);
  if (row < 1 || row > MAX_ROWS) return null;
  const newColumn = absColumn ? col : col + columns;
  const newRow = absRow ? row : row + rows;
  if (newColumn < 0 || newColumn >= MAX_COLUMNS || newRow < 1 || newRow > MAX_ROWS) return '#REF!';
  return absColumn + columnName(newColumn) + absRow + newRow;
}

/**
 * `formula`, written for the first cell of a shared formula, as it reads `rows` rows down and
 * `columns` columns across from it: its relative references move, the absolute parts ($A$1)
 * don't, and text in quotes, sheet names and function names stay as they are. A reference moved
 * off the sheet becomes #REF!, as in Excel.
 */
function shift(formula, rows, columns) {
  if (typeof formula !== 'string') return '';
  if (rows === 0 && columns === 0) return formula;
  let out = '';
  const n = formula.length;
  let i = 0;
  while (i < n) {
    const c = formula[i];
    if (c === '"' || c === "'") {
      // Text, or a quoted sheet name: to the matching quote, a doubled quote being part of it.
      let end = i + 1;
      while (end < n) {
        if (formula[end] === c) {
          if (end + 1 < n && formula[end + 1] === c) end += 2;
          else break;
        } else end++;
      }
      end = Math.min(n, end + 1);
      out += formula.slice(i, end);
      i = end;
    } else if (isDigit(c)) {
      const start = i;
      while (i < n && (isDigit(formula[i]) || formula[i] === '.')) i++;
      if (i < n && (formula[i] === 'E' || formula[i] === 'e') && i + 1 < n
        && (isDigit(formula[i + 1]) || formula[i + 1] === '+' || formula[i + 1] === '-')) {
        i += 2;
        while (i < n && isDigit(formula[i])) i++;
      }
      out += formula.slice(start, i);
    } else if (c === '$' || isLetter(c) || c === '_') {
      const start = i;
      while (i < n && (isLetterOrDigit(formula[i]) || formula[i] === '$' || formula[i] === '_' || formula[i] === '.')) i++;
      const word = formula.slice(start, i);
      const next = i < n ? formula[i] : ' ';
      // A function's name, or the sheet a reference is on, isn't a reference.
      out += next === '(' || next === '!' ? word : (shiftReference(word, rows, columns) ?? word);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Formulas, for the cells whose file keeps a formula but not the value it last gave, which then show
 * the formula itself. A formula shared by a block of cells is written once, for its first cell.
 */
export const SheetFormulas = Object.freeze({ shift });

// ---------------------------------------------------------------------------------------------
// Headers and footers

/**
 * A piece of a header or footer in one look: { text, bold, italic, underline, strike, baseline
 * (1 superscript, -1 subscript, 0), size (points, or null for the default), font (or null), color
 * (an RGB number without alpha, or null for black) }.
 */
export function headerRun(text, look = {}) {
  return {
    text,
    bold: look.bold ?? false,
    italic: look.italic ?? false,
    underline: look.underline ?? false,
    strike: look.strike ?? false,
    baseline: look.baseline ?? 0,
    size: look.size ?? null,
    font: look.font ?? null,
    color: look.color ?? null,
  };
}

/**
 * The left, centre and right parts of `code`, each a list of runs (see headerRun); text before any
 * &L, &C or &R is the centre's. `fields` is { page, pages, sheet, file, date, time }: what the codes
 * stand for on one page.
 */
function parts(code, fields) {
  const result = [[], [], []];
  if (typeof code !== 'string') return result;
  const f = { page: 1, pages: 1, sheet: '', file: '', date: '', time: '', ...fields };
  let part = 1;
  let look = headerRun('');
  let text = '';
  const flush = () => {
    if (text) result[part].push({ ...look, text });
    text = '';
  };
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c !== '&' || i + 1 >= n) {
      text += c;
      i++;
      continue;
    }
    const next = code[i + 1];
    i += 2;
    if (next === '&') {
      text += '&';
    } else if (next === 'L' || next === 'C' || next === 'R') {
      // Each part starts in the default look.
      flush();
      part = 'LCR'.indexOf(next);
      look = headerRun('');
    } else if (next === 'P') {
      // The page number, perhaps with an offset: &P+1, &P-2.
      let offset = 0;
      if (i < n && (code[i] === '+' || code[i] === '-')) {
        const sign = code[i] === '-' ? -1 : 1;
        let j = i + 1;
        while (j < n && j - i <= 4 && isDigit(code[j])) j++;
        const value = toIntOrNull(code.slice(i + 1, j));
        if (value !== null) offset = sign * value;
        if (j > i + 1) i = j;
      }
      text += String(Number(f.page) + offset);
    } else if (next === 'N') {
      text += String(f.pages);
    } else if (next === 'D') {
      text += String(f.date);
    } else if (next === 'T') {
      text += String(f.time);
    } else if (next === 'A') {
      text += String(f.sheet);
    } else if (next === 'F') {
      text += String(f.file);
    } else if (next === 'B') {
      flush();
      look = { ...look, bold: !look.bold };
    } else if (next === 'I') {
      flush();
      look = { ...look, italic: !look.italic };
    } else if (next === 'U' || next === 'E') {
      flush();
      look = { ...look, underline: !look.underline };
    } else if (next === 'S') {
      flush();
      look = { ...look, strike: !look.strike };
    } else if (next === 'X') {
      flush();
      look = { ...look, baseline: look.baseline === 1 ? 0 : 1 };
    } else if (next === 'Y') {
      flush();
      look = { ...look, baseline: look.baseline === -1 ? 0 : -1 };
    } else if (next === '"') {
      flush();
      let end = code.indexOf('"', i);
      if (end < 0) end = n;
      const inner = code.slice(i, end);
      const comma = inner.indexOf(',');
      const font = trim(comma < 0 ? inner : inner.slice(0, comma));
      const style = comma < 0 ? '' : inner.slice(comma + 1).toLowerCase();
      look = {
        ...look,
        font: font && font !== '-' ? font : look.font,
        bold: style.includes('bold') || (look.bold && !style),
        italic: style.includes('italic') || style.includes('oblique') || (look.italic && !style),
      };
      i = Math.min(n, end + 1);
    } else if (isDigit(next)) {
      flush();
      let j = i - 1;
      while (j < n && j - (i - 1) < 3 && isDigit(code[j])) j++;
      const value = toIntOrNull(code.slice(i - 1, j));
      if (value !== null && value >= 1 && value <= 409) look = { ...look, size: value };
      i = j;
    } else if (next === 'K') {
      flush();
      const value = code.slice(i, Math.min(n, i + 6));
      if (value.length === 6 && [...value].every((ch) => digitOf(ch, 16) >= 0)) look = { ...look, color: toIntOrNull(value, 16) };
      i = Math.min(n, i + 6);
    }
    // Pictures (&G), the file's folder (&Z), outline and shadow: nothing to show.
  }
  flush();
  return result;
}

/**
 * Headers and footers as spreadsheets write them: codes such as "&LPage &P of &N&R&D" for a left
 * part with the page number and a right one with the date. A part's text can change look as it goes:
 * &B bold, &I italic, &U underline, &S strikethrough, &X and &Y raised and lowered, &"Arial,Bold" a
 * font, &12 a size, &KFF0000 a colour. Pictures (&G) are left out.
 */
export const SheetHeaders = Object.freeze({ parts });
