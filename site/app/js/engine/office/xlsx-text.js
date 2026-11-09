// The text of a sheet's cells: what each shows, how much room it takes, and drawing it. A port of
// the CellTexts class of the app's XlsxText.kt (its CellNumbers is in xlsx-numbers.js).
//
// The bundled fonts stand in for the workbook's, drawn narrower or wider to the width of the font
// they stand in for (SheetUnits.digitEm), so text fits its cells, wraps and runs on into the next
// ones about where it does in Excel. Lengths are points, the origin is the top-left corner.
import { SheetUnits } from './xlsx-model.js';
import { SheetAlign, SheetVAlign, CellKind } from './xlsx-styles.js';
import {
  RichText, layoutParagraphSync, measureTextSync, ensureFonts, fontsReady, officeLineHeight, lineScale,
  digitWidth, resolveStyle, fileMetrics,
} from '../text/index.js';
import { mainFile, loadedFont } from '../text/fonts.js';

const f = Math.fround;

/** The room left and right of a cell's text, as Excel leaves it: 2 pixels. */
export const PAD = 1.5;

/** Text on the bottom line of a cell stays a pixel above it. */
const BOTTOM_PAD = 0.75;

/** textRotation for letters stacked one under another. */
export const STACKED = 255;

/** A number shows if it is this much narrower than its cell, in points, even if it takes some of the padding. */
const NUMBER_SLACK = 1;

/** How far, in points, text can reach past its box without being cut off: less than a pixel. */
const SLACK = 0.5;

/** Fill alignment repeats text across a cell: no cell is wider than this many repeats of a letter. */
const MAX_REPEATS = 2000;

/** The most characters a cell holds in Excel. */
export const MAX_CELL_CHARS = 32767;

/** Characters drawn beyond those that show, for the letters' shapes where they are cut off. */
const EXTRA_CHARS = 8;

/** Where each of two underlines starts below the baseline, and how thick it is, in shares of the font's size. */
const UNDERLINE_FIRST = 0.08;
const UNDERLINE_SECOND = 0.18;
const UNDERLINE_THICKNESS = 0.05;

/** Characters every bundled font has, so a text of only these needs nothing but its style's own font. */
const LATIN = /^[\x20-\x7e\xa0-\xff]*$/;

/** Letters written right to left, or marks that turn text so. */
const RIGHT_TO_LEFT = /[֐-ࣿיִ-﷿ﹰ-ﻼ‏‫‮⁧\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

/** A rectangle { left, top, right, bottom }. */
export const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

/** The part `a` and `b` share, or null when they don't overlap (Android's RectF.intersect). */
export function intersect(a, b) {
  if (!(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)) return null;
  return rect(Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
}

/** Thrown by measuring before the fonts a text needs are loaded: await CellTexts.ensure() and try again. */
export class FontsNeeded extends Error {
  constructor(runs) {
    super('Fonts needed');
    this.name = 'FontsNeeded';
    this.runs = runs;
  }
}

/**
 * What a cell shows: its `text` (a string, or a RichText with each run's look for rich text), its
 * cell's `font` and the `color` to draw in, and how it lines up across the cell, General resolved.
 * `number`: a number, date or time, which never runs on into the next cells and shows as #### when
 * too wide.
 */
export class ShownText {
  constructor(text, font, color, align, number, rich) {
    this.text = text;
    this.font = font;
    this.color = color;
    this.align = align;
    this.number = number;
    this.rich = rich;
    this.ready = false;
  }

  /** The characters, without their looks. */
  get plain() {
    return this.rich ? this.text.text : this.text;
  }

  get isEmpty() {
    return this.plain.length === 0;
  }
}

/**
 * The text of a sheet's cells. `styles`: SheetStyles; `theme`: OfficeTheme; `numbers`: CellNumbers;
 * `date1904`: the workbook's date system.
 */
export class CellTexts {
  constructor(styles, theme, numbers, date1904) {
    this.styles = styles;
    this.theme = theme;
    this.numbers = numbers;
    this.date1904 = date1904;
    /** One step of a cell's indent: three spaces of the default font. */
    this.indentStep = f(f(7.5 * styles.defaultFont.size) / 11);
    this.lineStyles = new Map();
    this.runStyles = new Map();
    this.scales = new Map();
    this.widths = new Map();
  }

  // ---- Fonts and sizes ----

  /**
   * How much wider or narrower the bundled font is drawn so its digits are as wide as the Office
   * font's (the app measures the phone font's "0" the same way): 1 for a font it doesn't know.
   */
  widthScale(font) {
    const key = `${font.name ?? ''}|${font.bold ? 1 : 0}|${font.italic ? 1 : 0}`;
    let s = this.scales.get(key);
    if (s === undefined) {
      const office = SheetUnits.digitEm(font.name);
      const phone = digitWidth({ font: font.name, bold: font.bold, italic: font.italic });
      s = office == null ? 1 : phone > 0 ? Math.min(1.25, Math.max(0.75, office / phone)) : 1;
      this.scales.set(key, s);
    }
    return s;
  }

  /**
   * The style text on one line is drawn in (the app's Paint for the font): superscript and
   * subscript are drawn smaller but not raised or dropped, as Canvas.drawText draws them.
   */
  lineStyle(font) {
    let s = this.lineStyles.get(font.key);
    if (!s) {
      const drawn = font.baseline !== 0 ? f(font.size * f(0.65)) : font.size;
      s = { font: font.name, size: drawn, bold: font.bold, italic: font.italic, underline: font.underline, strike: font.strike, color: font.color, scaleX: this.widthScale(font) };
      this.lineStyles.set(font.key, s);
    }
    return s;
  }

  /** The style of a run of a paragraph in `font` (raised or dropped when superscript or subscript). */
  runStyle(font, color = font.color) {
    const key = `${font.key}#${color}`;
    let s = this.runStyles.get(key);
    if (!s) {
      s = { ...font.style, color, scaleX: this.widthScale(font) };
      this.runStyles.set(key, s);
    }
    return s;
  }

  /** How tall a line of `font` is, in points, as Excel fits rows to it: 15 points for Calibri 11. */
  lineHeight(font) {
    return f(font.size * this.lineFactor(font));
  }

  lineFactor(font) {
    return f(f(officeLineHeight(font.name)) + f(0.14));
  }

  /** The width of "0" in `font` on one line, in points. */
  digit(font) {
    const s = this.lineStyle(font);
    return digitWidth(s) * resolveStyle(s).drawnSize;
  }

  /** The runs whose fonts `shown` needs. */
  runsOf(shown) {
    if (shown.rich) {
      const r = shown.text;
      // Turned rich text is drawn all in the cell's font.
      return [...r.spans.map((sp) => ({ text: r.text.slice(sp.start, sp.end), style: sp.style })), { text: r.text, style: this.lineStyle(shown.font) }];
    }
    const style = this.lineStyle(shown.font);
    return [{ text: shown.text, style }, { text: '#0', style }];
  }

  /** Whether the fonts `shown` needs are loaded. */
  ready(shown) {
    if (shown.ready) return true;
    for (const run of this.runsOf(shown)) if (!quickReady(run.text, run.style)) return false;
    shown.ready = true;
    return true;
  }

  /** Loads the fonts the shown texts need. */
  async ensure(showns) {
    const runs = [];
    for (const s of showns) if (s && !this.ready(s)) runs.push(...this.runsOf(s));
    if (runs.length) await ensureFonts(runs);
  }

  require(shown) {
    if (!this.ready(shown)) throw new FontsNeeded(this.runsOf(shown));
  }

  // ---- What a cell shows ----

  /**
   * What `cell` (a SheetCell) shows in `format` (a CellFormat), or null when it holds nothing. A
   * number is written as its format says, with no more characters than fit `width` points when its
   * format is General. Text stops at Excel's limit of MAX_CELL_CHARS characters.
   */
  shown(cell, format, width) {
    const kind = cell.kind;
    if (kind == null) return null;
    // A cell is shown at its column's width and, when it starts a merged block, at the block's.
    const cache = cell.shownCache ?? (cell.shownCache = []);
    for (let i = 0; i < cache.length; i += 3) if (cache[i] === width && cache[i + 1] === format) return cache[i + 2];
    const s = this.makeShown(cell, format, width);
    if (cache.length >= 6) cache.splice(0, 3);
    cache.push(width, format, s);
    return s;
  }

  makeShown(cell, format, width) {
    const font = format.font;
    switch (cell.kind) {
      case CellKind.NUMBER: {
        const digit = this.digit(font);
        const room = width - 2 * PAD - format.indent * this.indentStep;
        const maxChars = digit > 0 ? Math.min(11, Math.max(1, Math.floor(room / digit))) : 11;
        const { text, colour } = this.numbers.format(cell.number, format.numberFormat, this.date1904, maxChars);
        return new ShownText(text, font, colour ?? font.color, resolve(format.horizontal, SheetAlign.RIGHT), true, false);
      }
      case CellKind.TEXT:
      case CellKind.FORMULA: {
        const value = cell.text;
        if (!value) return null;
        const runs = value.runs;
        const held = value.text.length > MAX_CELL_CHARS ? value.text.slice(0, MAX_CELL_CHARS) : value.text;
        if (runs == null || cell.kind === CellKind.FORMULA) {
          const { text, colour } = this.numbers.formatText(held, format.numberFormat);
          return new ShownText(lines(text, format.wraps), font, colour ?? font.color, resolve(format.horizontal, SheetAlign.LEFT), false, false);
        }
        return new ShownText(this.richText(held, runs, font, format.wraps), font, font.color, resolve(format.horizontal, SheetAlign.LEFT), false, true);
      }
      case CellKind.BOOLEAN:
        return new ShownText(cell.number !== 0 ? 'TRUE' : 'FALSE', font, font.color, resolve(format.horizontal, SheetAlign.CENTER), false, false);
      case CellKind.ERROR:
        return new ShownText(cell.text?.text ?? '', font, font.color, resolve(format.horizontal, SheetAlign.CENTER), false, false);
      default:
        return null;
    }
  }

  /** Rich text: each run in its own font over the cell's, the text between runs in the cell's. */
  richText(text, runs, cellFont, wraps) {
    const shown = lines(text, wraps);
    const rich = new RichText();
    let at = 0;
    const piece = (end, font) => {
      if (end <= at) return;
      rich.append(shown.slice(at, end), this.runStyle(font));
      at = end;
    };
    const clamp = (v) => Math.min(shown.length, Math.max(at, v));
    for (const run of [...runs].sort((a, b) => a.start - b.start)) {
      piece(clamp(run.start), cellFont);
      piece(clamp(run.end), run.font.over(cellFont, this.styles.palette, this.theme));
    }
    piece(shown.length, cellFont);
    return rich;
  }

  // ---- Measuring ----

  /** How wide `text` is on one line in `style`, in points. */
  measureWidth(text, style) {
    const key = `${resolveKey(style)}\u0001${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      w = measureTextSync(text, style).width;
      if (this.widths.size >= 20000) this.widths.clear();
      this.widths.set(key, w);
    }
    return w;
  }

  /** How wide `shown` is on one line, in points. */
  width(shown) {
    this.require(shown);
    if (shown.rich) return layoutParagraphSync({ text: shown.text, width: Infinity, directionFromText: true }).contentWidth;
    return this.measureWidth(shown.text, this.lineStyle(shown.font));
  }

  /** How tall `shown` is in a cell `boxWidth` points wide, wrapped as `format` wraps it, in points: what a row grows to fit. */
  height(shown, format, boxWidth) {
    if (format.wraps || format.rotation === STACKED) return this.paragraph(shown, format, this.room(shown, format, boxWidth)).height;
    if (shown.rich) return this.paragraph(shown, format, this.width(shown) + 1).height;
    return this.lineHeight(shown.font);
  }

  /** How wide the text of a cell `boxWidth` points wide can be: its width less the padding and indent. */
  room(shown, format, boxWidth) {
    const indent = shown.align === SheetAlign.LEFT || shown.align === SheetAlign.RIGHT ? format.indent * this.indentStep : 0;
    return Math.max(1, boxWidth - 2 * PAD - indent);
  }

  /** `shown` as a paragraph `width` points wide, its lines as tall as in Excel. */
  paragraph(shown, format, width) {
    this.require(shown);
    const style = this.runStyle(shown.font, shown.color);
    let text;
    if (shown.rich) {
      text = shown.text;
    } else {
      // Stacked letters go one under another. (The text engine breaks lines after a hyphen between
      // letters itself, which the app has to ask Android for.)
      const content = format.rotation === STACKED ? Array.from(shown.text).join('\n') : shown.text;
      text = new RichText().append(content, style);
    }
    let align = 'start';
    if (format.rotation === STACKED || shown.align === SheetAlign.CENTER || shown.align === SheetAlign.CENTER_ACROSS) align = 'center';
    else if (shown.align === SheetAlign.RIGHT) align = 'end';
    else if (shown.align === SheetAlign.JUSTIFY || shown.align === SheetAlign.DISTRIBUTED) align = 'justify';
    return layoutParagraphSync({
      text,
      base: style,
      // Laid out to whole tenths of a point, as the app's layout units.
      width: Math.max(1, Math.trunc(width * 10)) / 10,
      align,
      lineScale: lineScale(style, this.lineFactor(shown.font)),
      avoidSingleLines: false,
    });
  }

  // ---- Drawing ----

  /**
   * Draws `shown` in `box` (the cell, the merged cells or the cells its text runs on into), lined
   * up as `format` says, and cut off at `clip`. Rectangles are { left, top, right, bottom }.
   */
  draw(canvas, shown, format, box, clip) {
    if (shown.isEmpty) return;
    const visible = intersect(box, clip);
    if (!visible) return;
    this.require(shown);
    const indent = format.indent * this.indentStep;
    const left = box.left + PAD + (shown.align === SheetAlign.LEFT ? indent : 0);
    const right = box.right - PAD - (shown.align === SheetAlign.RIGHT ? indent : 0);
    if (format.rotation === STACKED || format.wraps) {
      const block = this.paragraph(shown, format, this.room(shown, format, box.right - box.left));
      const top = topOf(format.vertical, box, block.height);
      drawIn(canvas, visible, rect(left, top, left + block.width, top + block.height), () => block.draw(canvas, left, top));
    } else if (format.rotation >= 1 && format.rotation <= 180) {
      drawIn(canvas, visible, null, () => this.drawTurned(canvas, shown, format, box, visible));
    } else {
      this.drawLine(canvas, shown, format, box, left, right, visible);
    }
  }

  /** Text on one line, which may run on past its cell (the box then holds the cells it runs into). */
  drawLine(canvas, shown, format, box, left, right, visible) {
    const room = right - left;
    const boxWidth = box.right - box.left;
    let text = shown.rich ? null : shown.text;
    let width = this.width(shown);
    let style = this.lineStyle(shown.font);
    // The bundled fonts are near the workbook's widths but not on them: a number a little wider
    // than the room inside the cell's padding still shows, using the padding.
    const squeezed = shown.number && width > room && width <= boxWidth - NUMBER_SLACK;
    if (shown.number && width > room && !squeezed) {
      // A number that doesn't fit shows as #, as many as fit, as in Excel.
      const hash = this.measureWidth('#', style);
      text = '#'.repeat(hash > 0 ? Math.max(1, Math.min(MAX_REPEATS, Math.floor(room / hash))) : 1);
      width = this.measureWidth(text, style);
    } else if (format.horizontal === SheetAlign.FILL && width > 0 && !shown.rich) {
      // Fill repeats the text across the cell, as many whole times as fit.
      const times = Math.min(Math.max(1, Math.floor(room / width)), MAX_REPEATS);
      text = text.repeat(times);
      width *= times;
    } else if (format.shrink && width > room && room > 0) {
      style = { ...style, size: style.size * Math.max(0.1, room / width) };
      width = room;
    }
    if (shown.color !== shown.font.color && !shown.rich) style = { ...style, color: shown.color };
    // Underlined twice: the two lines are drawn here, below the text, rather than the style's one.
    const twice = shown.font.doubleUnderline && !shown.rich;
    if (twice) style = { ...style, underline: false };
    let x;
    if (squeezed) x = box.left + (boxWidth - width) / 2;
    else if (shown.align === SheetAlign.RIGHT) x = right - width;
    else if (shown.align === SheetAlign.CENTER || shown.align === SheetAlign.CENTER_ACROSS) x = (box.left + box.right - width) / 2;
    else x = left;
    if (shown.rich) {
      const block = this.paragraph(new ShownText(shown.text, shown.font, shown.color, SheetAlign.LEFT, shown.number, true), format, Math.ceil(width) + 1);
      const top = topOf(format.vertical, box, block.height);
      const outside = x < visible.left - SLACK || x + width > visible.right + SLACK;
      let items = block.items(x, top);
      if (outside) items = partShown(items, shown.plain, visible.left, visible.right);
      drawIn(canvas, visible, rect(x, top, x + width, top + block.height), () => canvas.drawItems(items));
      return;
    }
    const height = this.lineHeight(shown.font);
    const r = resolveStyle(style);
    const descent = fileMetrics(r.stack[0].file).descent * r.drawnSize;
    const baseline = topOf(format.vertical, box, height) + height - descent;
    const m = measureTextSync(text, style);
    // What it draws: the letters' ink, which can stand out of the line a little.
    const bounds = rect(Math.min(x, x + m.ink.left), baseline + m.ink.top, Math.max(x + width, x + m.ink.right), baseline + m.ink.bottom);
    const inside = bounds.left >= visible.left - SLACK && bounds.right <= visible.right + SLACK;
    let items = m.layout.items(x, baseline - m.layout.firstBaseline);
    if (!inside) items = partShown(items, text, visible.left, visible.right);
    drawIn(canvas, visible, bounds, () => {
      canvas.drawItems(items);
      if (twice) drawUnderlines(canvas, r, x, x + width, baseline);
    });
  }

  /** Text turned up or down by the format's rotation, drawn about the middle of its cell, of which `visible` shows. */
  drawTurned(canvas, shown, format, box, visible) {
    const degrees = format.rotation <= 90 ? -format.rotation : format.rotation - 90;
    let style = this.lineStyle(shown.font);
    if (shown.color !== shown.font.color) style = { ...style, color: shown.color };
    const text = shown.plain;
    const m = measureTextSync(text, style);
    const r = resolveStyle(style);
    const fm = fileMetrics(r.stack[0].file);
    const ascent = fm.ascent * r.drawnSize;
    const descent = fm.descent * r.drawnSize;
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    // Turned, the text shows no further from the middle than the visible corner furthest from it.
    const reach = Math.max(
      Math.hypot(visible.left - cx, visible.top - cy), Math.hypot(visible.right - cx, visible.top - cy),
      Math.hypot(visible.left - cx, visible.bottom - cy), Math.hypot(visible.right - cx, visible.bottom - cy),
    );
    const x = cx - m.width / 2;
    const baseline = cy + (ascent - descent) / 2;
    let items = m.layout.items(x, baseline - m.layout.firstBaseline);
    if (m.width / 2 > reach) items = partShown(items, text, cx - reach, cx + reach);
    canvas.save();
    canvas.translate(cx, cy);
    canvas.rotate((degrees * Math.PI) / 180);
    canvas.translate(-cx, -cy);
    canvas.drawItems(items);
    canvas.restore();
  }
}

/** The format's alignment, General standing for `general`. */
function resolve(align, general) {
  return align === SheetAlign.GENERAL ? general : align;
}

/**
 * `text` with its line breaks as a cell shows them: only wrapped text goes on several lines; in
 * other cells a line break shows as a space. Tabs show as spaces too. The length stays the same,
 * so rich text's runs still fit it.
 */
export function lines(text, wraps) {
  if (!/[\n\r\t]/.test(text)) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\r') out += i + 1 < text.length && text[i + 1] === '\n' ? ' ' : wraps ? '\n' : ' ';
    else if (c === '\n') out += wraps ? '\n' : ' ';
    else if (c === '\t') out += ' ';
    else out += c;
  }
  return out;
}

/** Where text `height` points tall starts down `box`, as `vertical` lines it up. */
function topOf(vertical, box, height) {
  switch (vertical) {
    case SheetVAlign.CENTER: return (box.top + box.bottom - height) / 2;
    case SheetVAlign.BOTTOM: return box.bottom - height - BOTTOM_PAD;
    default: return box.top;
  }
}

/**
 * Runs `draw`, cut off at `visible` unless what it draws (`bounds`, null when not known) is inside
 * it already. Most cells' text is, and cutting off each would make the PDF larger and slower.
 */
function drawIn(canvas, visible, bounds, draw) {
  const inside = bounds != null && bounds.left >= visible.left - SLACK && bounds.right <= visible.right + SLACK
    && bounds.top >= visible.top - SLACK && bounds.bottom <= visible.bottom + SLACK;
  if (inside) {
    draw();
    return;
  }
  canvas.save();
  canvas.beginPath();
  canvas.rect(visible.left, visible.top, visible.right - visible.left, visible.bottom - visible.top);
  canvas.clip();
  draw();
  canvas.restore();
}

/**
 * The drawing `items` of a line of `text` with only the letters that can show between `left` and
 * `right`, and a few more each side for the shapes of those cut off (the app's partShown): a long
 * text in a narrow cell doesn't put all its letters into the PDF. Right-to-left text is kept whole,
 * as its order on the page isn't its order in the text.
 */
function partShown(items, text, left, right) {
  if (text.length <= 2 * EXTRA_CHARS || RIGHT_TO_LEFT.test(text)) return items;
  const out = [];
  for (const it of items) {
    if (it.kind === 'glyphs' && !it.actualText) {
      const pad = EXTRA_CHARS * it.size * it.scaleX;
      const keep = [];
      for (let i = 0; i < it.gid.length; i++) {
        const gx = it.x + it.gx[i];
        if (gx >= left - pad - it.size * it.scaleX && gx <= right + pad) keep.push(i);
      }
      if (keep.length === it.gid.length) out.push(it);
      else if (keep.length) {
        const pick = (a) => keep.map((i) => a[i]);
        out.push({ ...it, gid: pick(it.gid), gx: pick(it.gx), gdx: pick(it.gdx), gdy: pick(it.gdy), gtext: pick(it.gtext), gextra: pick(it.gextra) });
      }
    } else if (it.kind === 'fallback') {
      const pad = EXTRA_CHARS * it.size;
      if (it.x + it.width >= left - pad && it.x <= right + pad) out.push(it);
    } else {
      out.push(it);
    }
  }
  return out;
}

/** Two lines under text in style `r` (resolved) from `left` to `right` on `baseline`, as Excel underlines twice. */
function drawUnderlines(canvas, r, left, right, baseline) {
  const size = r.drawnSize;
  const c = r.color;
  canvas.fillStyle = `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
  for (const below of [UNDERLINE_FIRST, UNDERLINE_SECOND]) canvas.fillRect(left, baseline + size * below, right - left, size * UNDERLINE_THICKNESS);
}

/** A key telling styles apart for measuring. */
function resolveKey(style) {
  return `${style.font ?? ''}|${style.size}|${style.bold ? 1 : 0}|${style.italic ? 1 : 0}|${style.scaleX ?? 1}|${style.baseline ?? 0}`;
}

/** Whether `text` in `style` can be laid out now: quickly for Latin text, else by the text engine. */
function quickReady(text, style) {
  if (!loadedFont(mainFile(style))) return false;
  if (LATIN.test(text)) return true;
  return fontsReady(text, style);
}
