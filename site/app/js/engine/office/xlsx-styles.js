// A workbook's cell formats and shared strings: a port of the app's XlsxStyles.kt. Colours are ARGB
// numbers (0 to 0xFFFFFFFF, never negative), sizes are points.
import { SheetColors, SheetStrings } from './xlsx-model.js';
import { trim, toDoubleOrNull, isBlank } from './xlsx-numbers-kt.js';
import { OfficeTooLarge } from './problems.js';

const f = Math.fround;

/** Android's Color.BLACK and Color.WHITE, as ARGB. */
export const BLACK = 0xff000000;
export const WHITE = 0xffffffff;

// ---------------------------------------------------------------------------------------------
// Colours

/**
 * A colour as a spreadsheet's styles give it: as RGB, by theme colour or by its number in the
 * palette, lightened or darkened by `tint`. `auto` is the automatic colour.
 */
export class SheetColor {
  constructor(rgb, theme, indexed, tint, auto) {
    this.rgb = rgb;
    this.theme = theme;
    this.indexed = indexed;
    this.tint = tint;
    this.auto = auto;
  }

  /** Reads a colour element (color, fgColor, bgColor...), an XmlNode. */
  static read(x) {
    const t = x.attr('tint');
    const tint = t == null ? null : toDoubleOrNull(trim(t));
    return new SheetColor(
      SheetColors.rgb(x.attr('rgb')),
      x.intAttr('theme'),
      x.intAttr('indexed'),
      tint != null && Number.isFinite(tint) ? tint : 0,
      x.flag('auto', false),
    );
  }
}

/**
 * Turns SheetColors into ARGB, with the workbook's theme, and with the palette its styles give when
 * they give one (only old files do), else Excel's own.
 */
export class SheetPalette {
  constructor(theme, custom) {
    this.theme = theme;
    this.custom = custom;
  }

  /** `color` as ARGB; null for the automatic colour or one that can't be read. */
  argb(color) {
    if (color == null || color.auto) return null;
    let base = color.rgb;
    if (base == null && color.theme != null) {
      const key = SheetColors.themeKey(color.theme);
      if (key != null) base = this.theme.colors.get(key) ?? null;
    }
    if (base == null && color.indexed != null) {
      const i = color.indexed;
      base = (i >= 0 && i < this.custom.length ? this.custom[i] : null) ?? SheetColors.indexed(i);
    }
    if (base == null) return null;
    return SheetColors.tint(base, color.tint);
  }
}

// ---------------------------------------------------------------------------------------------
// Fonts

/** A font as a cell draws it, with everything resolved. Size in points. */
export class SheetFont {
  constructor(name, size, bold, italic, underline, strike, color, baseline, doubleUnderline = false) {
    this.name = name;
    this.size = size;
    this.bold = bold;
    this.italic = italic;
    this.underline = underline;
    this.strike = strike;
    this.color = color;
    /** 1 for superscript, -1 for subscript. */
    this.baseline = baseline;
    /** Underlined twice, as totals often are. */
    this.doubleUnderline = doubleUnderline;
    // Equal fonts share their measuring (the app's data class equality, as a HashMap key).
    this.key = [name ?? '', size, bold ? 1 : 0, italic ? 1 : 0, underline ? 1 : 0, strike ? 1 : 0, color, baseline, doubleUnderline ? 1 : 0].join('|');
  }

  /** The text engine's style for this font (OfficeText.kt's TextStyle). */
  get style() {
    return { font: this.name, size: this.size, bold: this.bold, italic: this.italic, underline: this.underline, strike: this.strike, color: this.color, baseline: this.baseline };
  }

  copy(changes = {}) {
    const c = { ...this, ...changes };
    return new SheetFont(c.name, c.size, c.bold, c.italic, c.underline, c.strike, c.color, c.baseline, c.doubleUnderline);
  }
}

/** Excel's own default, for a file that gives none. */
SheetFont.DEFAULT = new SheetFont('Calibri', 11, false, false, false, false, BLACK, 0);

/**
 * Font properties as a style or a run of rich text gives them; null means "as the font
 * underneath": the default font for a style's, the cell's font for a run's.
 */
export class FontProps {
  constructor({ name = null, size = null, bold = null, italic = null, underline = null, strike = null, color = null, baseline = null, scheme = null, doubleUnderline = null } = {}) {
    this.name = name;
    this.size = size;
    this.bold = bold;
    this.italic = italic;
    this.underline = underline;
    this.strike = strike;
    this.color = color;
    this.baseline = baseline;
    /** "minor" or "major": the theme's body or heading font, for a font named by the theme alone. */
    this.scheme = scheme;
    this.doubleUnderline = doubleUnderline;
  }

  /** These properties over `base`, with colours from `palette` and theme fonts from `theme`. */
  over(base, palette, theme) {
    const themed = this.scheme != null ? (this.scheme === 'major' ? theme.majorFont : theme.minorFont) : null;
    const argb = palette.argb(this.color);
    return new SheetFont(
      this.name ?? themed ?? base.name,
      this.size ?? base.size,
      this.bold ?? base.bold,
      this.italic ?? base.italic,
      this.underline ?? base.underline,
      this.strike ?? base.strike,
      argb ?? (this.color != null ? BLACK : base.color),
      this.baseline ?? base.baseline,
      this.doubleUnderline ?? base.doubleUnderline,
    );
  }

  /** Reads a font element (styles' font, or a run's rPr), an XmlNode. */
  static read(x) {
    const p = {};
    for (const c of x.children()) {
      switch (c.name) {
        case 'name':
        case 'rFont': {
          const v = c.attr('val');
          p.name = v != null && !isBlank(v) ? v : null;
          break;
        }
        case 'sz': {
          const v = c.attr('val');
          const d = v == null ? null : toDoubleOrNull(trim(v));
          const s = d == null ? null : f(d);
          p.size = s != null && Number.isFinite(s) && s > 0 ? Math.min(409, Math.max(1, s)) : null;
          break;
        }
        case 'b': p.bold = c.flag(); break;
        case 'i': p.italic = c.flag(); break;
        case 'u': {
          const kind = c.attr('val');
          p.underline = kind !== 'none';
          p.doubleUnderline = kind === 'double' || kind === 'doubleAccounting';
          break;
        }
        case 'strike': p.strike = c.flag(); break;
        case 'color': p.color = SheetColor.read(c); break;
        case 'vertAlign': {
          const v = c.attr('val');
          p.baseline = v === 'superscript' ? 1 : v === 'subscript' ? -1 : 0;
          break;
        }
        case 'scheme': {
          const v = c.attr('val');
          p.scheme = v === 'major' || v === 'minor' ? v : null;
          break;
        }
        default: break;
      }
    }
    return new FontProps(p);
  }
}

// ---------------------------------------------------------------------------------------------
// Borders and alignment

/**
 * A line along a side of a cell: `width` in points, `dashes` its lengths on and off in points
 * (null for a solid line), and `double` for two thin lines `width` apart.
 */
export class CellLine {
  constructor(width, color, dashes, double = false) {
    this.width = width;
    this.color = color;
    this.dashes = dashes;
    this.double = double;
  }

  /**
   * The line of border style `style` in `color`; null for none. Widths are about Excel's in
   * print, where a thin line is the finest it draws but hairlines.
   */
  static of(style, color) {
    const L = (w, d, double) => new CellLine(f(w), color, d ? d.map(f) : null, double);
    switch (style) {
      case 'hair': return L(0.3);
      case 'thin': return L(0.6);
      case 'medium': return L(1.4);
      case 'thick': return L(2.2);
      case 'double': return L(2, null, true);
      case 'dotted': return L(0.6, [0.75, 0.75]);
      case 'dashed': return L(0.6, [2.25, 0.75]);
      case 'mediumDashed': return L(1.4, [6.75, 2.25]);
      case 'dashDot': return L(0.6, [6.75, 2.25, 2.25, 2.25]);
      case 'mediumDashDot':
      case 'slantDashDot': return L(1.4, [6.75, 2.25, 2.25, 2.25]);
      case 'dashDotDot': return L(0.6, [6.75, 2.25, 2.25, 2.25, 2.25, 2.25]);
      case 'mediumDashDotDot': return L(1.4, [6.75, 2.25, 2.25, 2.25, 2.25, 2.25]);
      default: return null;
    }
  }
}

/** The lines around a cell, and across it (diagonalUp from bottom left to top right). Null sides have none. */
export class CellBorders {
  constructor(left, top, right, bottom, diagonalUp, diagonalDown) {
    this.left = left;
    this.top = top;
    this.right = right;
    this.bottom = bottom;
    this.diagonalUp = diagonalUp;
    this.diagonalDown = diagonalDown;
  }
}

/** How a cell's text lines up across it. GENERAL puts text on the left, numbers on the right and TRUE or FALSE in the middle. */
export const SheetAlign = Object.freeze({
  GENERAL: 'general', LEFT: 'left', CENTER: 'center', RIGHT: 'right', FILL: 'fill', JUSTIFY: 'justify', CENTER_ACROSS: 'centerContinuous', DISTRIBUTED: 'distributed',
});

/** How a cell's text lines up from top to bottom. */
export const SheetVAlign = Object.freeze({ TOP: 'top', CENTER: 'center', BOTTOM: 'bottom', JUSTIFY: 'justify', DISTRIBUTED: 'distributed' });

const HORIZONTAL = new Map([
  ['left', SheetAlign.LEFT], ['center', SheetAlign.CENTER], ['right', SheetAlign.RIGHT], ['fill', SheetAlign.FILL],
  ['justify', SheetAlign.JUSTIFY], ['centerContinuous', SheetAlign.CENTER_ACROSS], ['distributed', SheetAlign.DISTRIBUTED],
]);
const VERTICAL = new Map([
  ['top', SheetVAlign.TOP], ['center', SheetVAlign.CENTER], ['justify', SheetVAlign.JUSTIFY], ['distributed', SheetVAlign.DISTRIBUTED],
]);

/** A cell format (an entry of cellXfs), with everything it refers to resolved. */
export class CellFormat {
  constructor({ numberFormat, font, fill, borders, horizontal, vertical, wrap, indent, shrink, rotation }) {
    this.numberFormat = numberFormat;
    this.font = font;
    this.fill = fill;
    this.borders = borders;
    this.horizontal = horizontal;
    this.vertical = vertical;
    this.wrap = wrap;
    /** Steps of three spaces' width in from the side the text lines up with. */
    this.indent = indent;
    this.shrink = shrink;
    /** Degrees: 1 to 90 turn the text up, 91 to 180 turn it down by the amount over 90, and 255 stacks its letters. */
    this.rotation = rotation;
    /** Whether a cell in this format shows on paper even when empty. */
    this.showsEmpty = fill != null || borders != null;
    /** Whether its text goes on several lines in its cell, as wrapped and justified text does. */
    this.wraps = wrap || horizontal === SheetAlign.JUSTIFY || horizontal === SheetAlign.DISTRIBUTED
      || vertical === SheetVAlign.JUSTIFY || vertical === SheetVAlign.DISTRIBUTED;
  }
}

/** Each list in styles.xml is read up to this, past Excel's own limit of 64,000 formats: more come only from a crafted file. */
const MAX_ENTRIES = 65536;

const at = (list, i) => (i != null && i >= 0 && i < list.length ? list[i] : null);

/**
 * A spreadsheet's cell formats (styles.xml): number formats, fonts, fills, borders, and the
 * cellXfs that combine them with alignment. Cells refer to formats by their place in cellXfs.
 * Differential formats (conditional formatting, table styles) aren't read.
 */
export class SheetStyles {
  constructor(formats, defaultFont, palette) {
    this.formats = formats;
    this.defaultFont = defaultFont;
    this.palette = palette;
  }

  /** Cell format `index`; the first one (the Normal style) for one that doesn't exist. */
  format(index) {
    return (index >= 0 && index < this.formats.length ? this.formats[index] : null) ?? this.formats[0];
  }

  /**
   * Reads styles.xml at `path` of `pkg`, with built-in number formats as `numbers` (CellNumbers)
   * writes them; a workbook without one gets Excel's defaults. Throws XmlError for a damaged part.
   */
  static async read(pkg, path, theme, numbers) {
    const numFmts = new Map();
    const fonts = [];
    const fills = [];
    const borders = [];
    const styleXfs = [];
    const cellXfs = [];
    const custom = [];
    const x = path != null ? await pkg.xml(path) : null;
    if (x) {
      for (const c of x.children()) {
        switch (c.name) {
          case 'numFmts':
            for (const n of c.children()) {
              const id = n.intAttr('numFmtId');
              const code = n.attr('formatCode');
              if (n.name === 'numFmt' && id != null && code != null && numFmts.size < MAX_ENTRIES) numFmts.set(id, SheetStrings.unescape(code));
            }
            break;
          case 'fonts':
            for (const n of c.children()) if (n.name === 'font' && fonts.length < MAX_ENTRIES) fonts.push(FontProps.read(n));
            break;
          case 'fills':
            for (const n of c.children()) if (n.name === 'fill' && fills.length < MAX_ENTRIES) fills.push(readFill(n));
            break;
          case 'borders':
            for (const n of c.children()) if (n.name === 'border' && borders.length < MAX_ENTRIES) borders.push(readBorder(n));
            break;
          case 'cellStyleXfs':
            for (const n of c.children()) if (n.name === 'xf' && styleXfs.length < MAX_ENTRIES) styleXfs.push(readXf(n));
            break;
          case 'cellXfs':
            for (const n of c.children()) if (n.name === 'xf' && cellXfs.length < MAX_ENTRIES) cellXfs.push(readXf(n));
            break;
          case 'colors':
            for (const n of c.children()) {
              if (n.name !== 'indexedColors') continue;
              for (const r of n.children()) if (r.name === 'rgbColor' && custom.length < MAX_ENTRIES) custom.push(SheetColors.rgb(r.attr('rgb')) ?? BLACK);
            }
            break;
          default: break;
        }
      }
    }
    const palette = new SheetPalette(theme, custom);
    const defaultFont = fonts.length
      ? fonts[0].over(SheetFont.DEFAULT.copy({ name: theme.minorFont ?? SheetFont.DEFAULT.name }), palette, theme)
      : SheetFont.DEFAULT;
    const resolvedFonts = fonts.map((p) => p.over(defaultFont, palette, theme));
    const resolvedFills = fills.map((fill) => fillColor(fill, palette));
    const resolvedBorders = borders.map((b) => resolveBorder(b, palette));
    const xfs = cellXfs.length ? cellXfs : [{ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, styleXf: 0, alignment: null }];
    const formats = xfs.map((xf) => {
      const alignment = xf.alignment ?? at(styleXfs, xf.styleXf)?.alignment ?? null;
      return new CellFormat({
        numberFormat: numFmts.get(xf.numFmtId) ?? numbers.builtIn(xf.numFmtId),
        font: at(resolvedFonts, xf.fontId) ?? defaultFont,
        fill: at(resolvedFills, xf.fillId),
        borders: at(resolvedBorders, xf.borderId),
        horizontal: alignment?.horizontal ?? SheetAlign.GENERAL,
        vertical: alignment?.vertical ?? SheetVAlign.BOTTOM,
        wrap: alignment?.wrap === true,
        indent: alignment?.indent ?? 0,
        shrink: alignment?.shrink === true,
        rotation: alignment?.rotation ?? 0,
      });
    });
    return new SheetStyles(formats, defaultFont, palette);
  }
}

function readXf(x) {
  let alignment = null;
  for (const c of x.children()) {
    if (c.name !== 'alignment') continue;
    alignment = {
      horizontal: HORIZONTAL.get(c.attr('horizontal')) ?? SheetAlign.GENERAL,
      vertical: VERTICAL.get(c.attr('vertical')) ?? SheetVAlign.BOTTOM,
      wrap: c.flag('wrapText', false),
      indent: Math.min(250, Math.max(0, c.intAttr('indent') ?? 0)),
      shrink: c.flag('shrinkToFit', false),
      rotation: c.intAttr('textRotation') ?? 0,
    };
  }
  return {
    numFmtId: x.intAttr('numFmtId') ?? 0,
    fontId: x.intAttr('fontId') ?? 0,
    fillId: x.intAttr('fillId') ?? 0,
    borderId: x.intAttr('borderId') ?? 0,
    styleXf: x.intAttr('xfId') ?? 0,
    alignment,
  };
}

function readFill(x) {
  let pattern = null;
  let fg = null;
  let bg = null;
  const gradient = [];
  for (const c of x.children()) {
    if (c.name === 'patternFill') {
      pattern = c.attr('patternType') ?? 'none';
      for (const d of c.children()) {
        if (d.name === 'fgColor') fg = SheetColor.read(d);
        else if (d.name === 'bgColor') bg = SheetColor.read(d);
      }
    } else if (c.name === 'gradientFill') {
      for (const stop of c.children()) {
        if (stop.name !== 'stop') continue;
        for (const d of stop.children()) if (d.name === 'color') gradient.push(SheetColor.read(d));
      }
    }
  }
  return { pattern, fg, bg, gradient };
}

/** How much of a pattern its foreground covers. */
function patternShare(pattern) {
  switch (pattern) {
    case 'solid': return 1;
    case 'gray0625': return f(0.0625);
    case 'gray125': return f(0.125);
    case 'lightGray': return f(0.25);
    case 'mediumGray': return f(0.5);
    case 'darkGray': return f(0.75);
    default: return pattern.startsWith('light') ? f(0.25) : f(0.5);
  }
}

/**
 * The colour a fill shows, or null for none. Patterns are shown as the blend of their two colours
 * they look like from a little way off; a gradient as the colour halfway along it.
 */
function fillColor(fill, palette) {
  if (fill.gradient.length) {
    const first = palette.argb(fill.gradient[0]) ?? WHITE;
    const last = palette.argb(fill.gradient[fill.gradient.length - 1]) ?? WHITE;
    return blend(first, last, f(0.5));
  }
  if (fill.pattern == null || fill.pattern === 'none') return null;
  const share = patternShare(fill.pattern);
  // A pattern's automatic foreground is black, its automatic background white.
  const fg = palette.argb(fill.fg) ?? BLACK;
  if (share === 1) return fg;
  return blend(palette.argb(fill.bg) ?? WHITE, fg, share);
}

/** The colour `share` of the way from `from` to `to`, opaque (Kotlin's Float arithmetic). */
function blend(from, to, share) {
  const keep = f(1 - share);
  const channel = (shift) => {
    const v = Math.trunc(f(f(((from >>> shift) & 0xff) * keep) + f(((to >>> shift) & 0xff) * share)));
    return Math.min(255, Math.max(0, v));
  };
  return (0xff000000 | (channel(16) << 16) | (channel(8) << 8) | channel(0)) >>> 0;
}

function readBorder(x) {
  const sides = new Map();
  const up = x.flag('diagonalUp', false);
  const down = x.flag('diagonalDown', false);
  for (const c of x.children()) {
    let side;
    switch (c.name) {
      case 'left': case 'start': side = 'left'; break;
      case 'right': case 'end': side = 'right'; break;
      case 'top': case 'bottom': case 'diagonal': side = c.name; break;
      default: continue;
    }
    const style = c.attr('style');
    if (style == null || style === 'none') continue;
    let color = null;
    for (const d of c.children()) if (d.name === 'color') color = SheetColor.read(d);
    sides.set(side, [style, color]);
  }
  return { sides, up, down };
}

function resolveBorder(border, palette) {
  const line = (side) => {
    const s = border.sides.get(side);
    return s ? CellLine.of(s[0], palette.argb(s[1]) ?? BLACK) : null;
  };
  const diagonal = line('diagonal');
  const result = new CellBorders(line('left'), line('top'), line('right'), line('bottom'), border.up ? diagonal : null, border.down ? diagonal : null);
  const any = [result.left, result.top, result.right, result.bottom, result.diagonalUp, result.diagonalDown].some((l) => l != null);
  return any ? result : null;
}

// ---------------------------------------------------------------------------------------------
// Text

/** What a cell holds (XlsxSheet.kt's CellKind). A formula whose file keeps no value for it shows the formula itself. */
export const CellKind = Object.freeze({ NUMBER: 'number', TEXT: 'text', BOOLEAN: 'boolean', ERROR: 'error', FORMULA: 'formula' });

/** A cell's text, with the look of each run when it is rich text (`runs` null when it is all in the cell's font). */
export class SheetText {
  constructor(text, runs = null) {
    this.text = text;
    this.runs = runs;
  }
}

/** A run of rich text: characters `start` until `end`, in `font` (FontProps) over the cell's own. */
export class TextRun {
  constructor(start, end, font) {
    this.start = start;
    this.end = end;
    this.font = font;
  }
}

/** About 48 MB of text: more than any workbook a phone can lay out holds. */
export const MAX_SHARED_CHARS = 24000000;

/**
 * A workbook's shared strings (sharedStrings.xml), which text cells refer to by number. Rich text
 * keeps its runs; phonetic guides are left out.
 */
export class SharedStrings {
  constructor(texts, runs) {
    this.texts = texts;
    this.runs = runs;
  }

  get size() {
    return this.texts.length;
  }

  /** String `index`, or null when there's no such string. */
  get(index) {
    if (!(index >= 0 && index < this.texts.length)) return null;
    return new SheetText(this.texts[index], this.runs.get(index) ?? null);
  }

  /**
   * Reads sharedStrings.xml at `path`. Throws OfficeTooLarge once their characters pass
   * MAX_SHARED_CHARS, rather than running out of memory. `pace` (a Pace) lets the page breathe.
   */
  static async read(pkg, path, pace) {
    const x = path != null ? await pkg.xml(path) : null;
    if (!x) return SharedStrings.NONE;
    const texts = [];
    const runs = new Map();
    let chars = 0;
    for (const c of x.children()) {
      if (c.name !== 'si') continue;
      if (pace.check()) await pace.breathe();
      const item = readItem(c);
      chars += item.text.length;
      if (chars > MAX_SHARED_CHARS) throw new OfficeTooLarge();
      if (item.runs) runs.set(texts.length, item.runs);
      texts.push(item.text);
    }
    return new SharedStrings(texts, runs);
  }
}

SharedStrings.NONE = new SharedStrings([], new Map());

/** Reads a string item (si, or an inline string's is), an XmlNode. */
export function readItem(x) {
  let text = '';
  const runs = [];
  for (const c of x.children()) {
    if (c.name === 't') {
      text += SheetStrings.unescape(c.text());
    } else if (c.name === 'r') {
      let font = null;
      const start = text.length;
      for (const d of c.children()) {
        if (d.name === 'rPr') font = FontProps.read(d);
        else if (d.name === 't') text += SheetStrings.unescape(d.text());
      }
      if (font != null && text.length > start) runs.push(new TextRun(start, text.length, font));
    }
  }
  return new SheetText(text, runs.length ? runs : null);
}
