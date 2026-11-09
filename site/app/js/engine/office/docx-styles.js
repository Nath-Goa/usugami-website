// Formatting in Word files: a port of the app's DocxStyles.kt. Run (character) and paragraph
// formatting, table formatting and borders, the styles part (document defaults, paragraph,
// character and table styles, each possibly based on another), and lists (numbering.xml) with their
// running counts. Lengths are points; colours ARGB numbers. A null field means "not set here": it
// comes from further up (the style, the style it's based on, the document defaults).
import { OfficeColors } from './colors.js';
import { ListNumbering, SymbolFonts, TabStops } from './office-formats.js';
import { Border } from './tables.js';
import { LineSpacing } from '../text/layout.js';
import { trim } from './xlsx-numbers-kt.js';

export { Border } from './tables.js';

const BLACK = 0xff000000;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Kotlin's String.toIntOrNull(16): an optional sign and hex digits, within 32 bits. */
export function hexInt(text) {
  if (text == null || !/^[+-]?[0-9a-fA-F]+$/.test(text)) return null;
  const v = parseInt(text, 16);
  return v > 2147483647 || v < -2147483648 ? null : v;
}

// ---------------------------------------------------------------------------------------------
// Run formatting

const RUN_FIELDS = [
  'font', 'size', 'bold', 'italic', 'underline', 'strike', 'color', 'background', 'baseline', 'caps', 'smallCaps',
  'hidden', 'spacing', 'style', 'sizeCs', 'boldCs', 'italicCs', 'complex', 'rtl',
];

/**
 * Run (character) formatting from a Word file. `underline` is true, 'double' or false; `style` is
 * the character style (w:rStyle), for direct formatting only; `sizeCs`, `boldCs` and `italicCs` are
 * complex-script text's (see ComplexScript); `complex` and `rtl` mark all of a run as complex script.
 */
export class RunProps {
  constructor(fields = {}) {
    for (const k of RUN_FIELDS) this[k] = fields[k] ?? null;
  }

  /** These properties, with `base`'s where these aren't set. */
  over(base) {
    if (base == null) return this;
    const out = new RunProps();
    for (const k of RUN_FIELDS) out[k] = this[k] ?? base[k];
    return out;
  }

  /** This with some fields changed (Kotlin's copy). */
  copy(changes) {
    const out = new RunProps(this);
    for (const k of Object.keys(changes)) out[k] = changes[k];
    return out;
  }

  /** Whether Word formats all of the run as complex-script text. */
  get allComplex() {
    return this.complex === true || this.rtl === true;
  }

  /** The text engine's style for this run (TextStyle): Word's own default of 10 points when no size is given. */
  toStyle(theme) {
    return {
      font: theme.font(this.font) ?? theme.minorFont,
      size: this.size ?? 10,
      bold: this.bold === true,
      italic: this.italic === true,
      underline: this.underline === 'double' ? 'double' : this.underline === true,
      strike: this.strike === true,
      color: this.color ?? BLACK,
      background: this.background ?? null,
      baseline: this.baseline ?? 0,
      caps: this.caps === true,
      smallCaps: this.smallCaps === true,
      spacing: this.spacing ?? 0,
      // Word's automatic colour: black, but white on dark shading.
      autoColor: this.color == null,
    };
  }

  /** How complex-script text looks: with its own size, bold and italic, or, when the file gives none, the other text's. */
  toComplexStyle(theme) {
    return {
      ...this.toStyle(theme),
      size: this.sizeCs ?? this.size ?? 10,
      bold: (this.boldCs ?? this.bold) === true,
      italic: (this.italicCs ?? this.italic) === true,
    };
  }

  /** Reads w:rPr (`x` being it). */
  static read(x, theme) {
    const p = new RunProps();
    for (const c of x.children()) {
      switch (c.name) {
        case 'rStyle': p.style = c.attr('val'); break;
        case 'rFonts': p.font = c.attr('ascii') ?? c.attr('asciiTheme') ?? c.attr('hAnsi') ?? c.attr('hAnsiTheme') ?? c.attr('cs') ?? c.attr('eastAsia'); break;
        case 'b': p.bold = c.flag(); break;
        case 'i': p.italic = c.flag(); break;
        case 'u': {
          const v = c.attr('val');
          // Any underline but "none"; double ones are drawn double.
          p.underline = v == null || v !== 'none' ? (v === 'double' ? 'double' : true) : false;
          break;
        }
        case 'strike': case 'dstrike': p.strike = c.flag(); break;
        case 'caps': p.caps = c.flag(); break;
        case 'smallCaps': p.smallCaps = c.flag(); break;
        case 'vanish': p.hidden = c.flag(); break;
        case 'sz': { const v = c.intAttr('val'); if (v != null) p.size = v / 2; break; }
        case 'szCs': { const v = c.intAttr('val'); if (v != null) p.sizeCs = v / 2; break; }
        case 'bCs': p.boldCs = c.flag(); break;
        case 'iCs': p.italicCs = c.flag(); break;
        case 'cs': p.complex = c.flag(); break;
        case 'rtl': p.rtl = c.flag(); break;
        case 'color': {
          const color = OfficeColors.hex(c.attr('val')) ?? themeColor(c, theme);
          if (color != null) p.color = color;
          break;
        }
        case 'highlight': p.background = OfficeColors.highlight(c.attr('val')) ?? p.background; break;
        case 'shd': {
          const fill = OfficeColors.hex(c.attr('fill'));
          if (fill != null) p.background = p.background ?? fill;
          break;
        }
        case 'vertAlign': {
          const v = c.attr('val');
          p.baseline = v === 'superscript' ? 1 : v === 'subscript' ? -1 : 0;
          break;
        }
        case 'spacing': { const v = c.intAttr('val'); if (v != null) p.spacing = v / 20; break; }
        default: break;
      }
    }
    return p;
  }
}

/** A w:color given only as a theme colour, such as "accent1", with its shade or tint. */
function themeColor(x, theme) {
  const name = x.attr('themeColor');
  if (name == null) return null;
  const key = {
    text1: 'dk1', dark1: 'dk1', background1: 'lt1', light1: 'lt1', text2: 'dk2', dark2: 'dk2',
    background2: 'lt2', light2: 'lt2', hyperlink: 'hlink', followedHyperlink: 'folHlink',
  }[name] ?? name;
  const color = theme.colors.get(key);
  if (color == null) return null;
  const shade = hexInt(x.attr('themeShade'));
  const tint = hexInt(x.attr('themeTint'));
  if (shade != null) return OfficeColors.modify(color, [['lumMod', Math.trunc((shade * 100000) / 255)]]);
  if (tint != null) {
    return OfficeColors.modify(color, [['lumMod', Math.trunc((tint * 100000) / 255)], ['lumOff', Math.trunc(((255 - tint) * 100000) / 255)]]);
  }
  return color;
}

/** Whether two text styles look the same. */
export function sameStyle(a, b) {
  if (a === b) return true;
  for (const k of Object.keys(a)) if (a[k] !== b[k]) return false;
  return Object.keys(a).length === Object.keys(b).length;
}

// ---------------------------------------------------------------------------------------------
// Complex scripts

const COMPLEX = new RegExp(`^[${[
  'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Nko', 'Samaritan', 'Mandaic', 'Devanagari', 'Bengali', 'Gurmukhi',
  'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar',
  'Khmer', 'Mongolian',
].map((s) => `\\p{Script=${s}}`).join('')}]$`, 'u');
const NEUTRAL = /^[\p{Script=Common}\p{Script=Inherited}\p{Script=Unknown}]$/u;

/**
 * The text Word formats as complex script, with a run's w:szCs, w:bCs and w:iCs (and all of a run
 * marked w:cs or w:rtl): the letters of right-to-left scripts and of the scripts of South and
 * South-East Asia. Spaces, digits, punctuation and combining marks go with the letters before them,
 * or, at the start, after them.
 */
export const ComplexScript = Object.freeze({
  /** True for a complex-script letter, false for another, null for one that goes with its neighbours. */
  kind(ch) {
    if (NEUTRAL.test(ch)) return null;
    return COMPLEX.test(ch);
  },

  /**
   * Hands `part(text, isComplex)` the pieces of `text`, and returns whether its last letters are
   * complex script (null when it has none). `before` is whether the run's text before it ended in
   * complex-script letters, which spaces and such at its start go with.
   */
  split(text, before, part) {
    let current = before;
    let from = 0;
    let i = 0;
    while (i < text.length) {
      const cp = text.codePointAt(i);
      const kind = ComplexScript.kind(String.fromCodePoint(cp));
      if (kind != null && kind !== current) {
        if (current != null && i > from) {
          part(text.slice(from, i), current);
          from = i;
        }
        current = kind;
      }
      i += cp > 0xffff ? 2 : 1;
    }
    if (from < text.length) part(text.slice(from), current ?? false);
    return current;
  },
});

// ---------------------------------------------------------------------------------------------
// Paragraph formatting

const PARA_FIELDS = [
  'style', 'align', 'before', 'after', 'line', 'left', 'right', 'firstLine', 'numId', 'level', 'keepNext',
  'pageBreakBefore', 'contextual', 'widowControl', 'shading', 'rtl', 'tabs', 'mark', 'borderTop', 'borderBottom',
];

/**
 * Paragraph formatting from a Word file. `align` is 'start', 'center', 'end' or 'justify'; `line` a
 * LineSpacing; `firstLine` positive when the first line starts further in, negative when it hangs
 * out (as list items do); `tabs` its own TabStops (adding to those it inherits); `mark` the
 * paragraph mark's RunProps (an empty paragraph's height comes from it); `borderTop` and
 * `borderBottom` [Border, distance from the text].
 */
export class ParaProps {
  constructor(fields = {}) {
    for (const k of PARA_FIELDS) this[k] = fields[k] ?? null;
  }

  over(base) {
    if (base == null) return this;
    const out = new ParaProps();
    for (const k of PARA_FIELDS) out[k] = this[k] ?? base[k];
    out.tabs = this.tabs ? this.tabs.over(base.tabs) : base.tabs;
    out.mark = this.mark ? this.mark.over(base.mark) : base.mark;
    return out;
  }

  copy(changes) {
    const out = new ParaProps(this);
    for (const k of Object.keys(changes)) out[k] = changes[k];
    return out;
  }

  /** Reads w:pPr (`x` being it). `section(x)` is called with a w:sectPr inside it. */
  static read(x, theme, section = () => {}) {
    const p = new ParaProps();
    for (const c of x.children()) {
      switch (c.name) {
        case 'pStyle': p.style = c.attr('val'); break;
        case 'jc': p.align = alignOf(c.attr('val')); break;
        case 'spacing': {
          const rule = c.attr('lineRule');
          const auto = rule == null || rule === 'auto';
          const v = c.intAttr('line');
          const line = v == null ? null : auto ? LineSpacing.multiple(v / 240) : rule === 'exact' ? LineSpacing.exact(v / 20) : LineSpacing.atLeast(v / 20);
          const before = c.intAttr('before');
          const after = c.intAttr('after');
          p.before = c.flag('beforeAutospacing', false) ? 14 : before != null ? before / 20 : p.before;
          p.after = c.flag('afterAutospacing', false) ? 14 : after != null ? after / 20 : p.after;
          p.line = line ?? p.line;
          break;
        }
        case 'ind': {
          const left = c.intAttr('left') ?? c.intAttr('start');
          const right = c.intAttr('right') ?? c.intAttr('end');
          const hanging = c.intAttr('hanging');
          const first = c.intAttr('firstLine');
          p.left = left != null ? left / 20 : p.left;
          p.right = right != null ? right / 20 : p.right;
          p.firstLine = hanging != null ? -hanging / 20 : first != null ? first / 20 : p.firstLine;
          break;
        }
        case 'numPr': {
          let numId = p.numId;
          let level = p.level;
          for (const n of c.children()) {
            if (n.name === 'numId') numId = n.intAttr('val');
            else if (n.name === 'ilvl') level = n.intAttr('val');
          }
          p.numId = numId;
          p.level = level;
          break;
        }
        case 'keepNext': p.keepNext = c.flag(); break;
        case 'pageBreakBefore': p.pageBreakBefore = c.flag(); break;
        case 'contextualSpacing': p.contextual = c.flag(); break;
        case 'widowControl': p.widowControl = c.flag(); break;
        case 'bidi': p.rtl = c.flag(); break;
        case 'shd': p.shading = OfficeColors.hex(c.attr('fill')); break;
        case 'pBdr': {
          let top = p.borderTop;
          let bottom = p.borderBottom;
          for (const b of c.children()) {
            const style = b.attr('val');
            const border = style == null || style === 'nil' || style === 'none' ? Border.NONE
              : new Border(clamp((b.intAttr('sz') ?? 4) / 8, 0.25, 6), OfficeColors.hex(b.attr('color')) ?? BLACK);
            const space = clamp(b.intAttr('space') ?? 0, 0, 31);
            if (b.name === 'top') top = [border, space];
            else if (b.name === 'bottom') bottom = [border, space];
          }
          p.borderTop = top;
          p.borderBottom = bottom;
          break;
        }
        case 'tabs': p.tabs = readTabs(c); break;
        case 'rPr': p.mark = RunProps.read(c, theme); break;
        case 'sectPr': section(c); break;
        default: break;
      }
    }
    return p;
  }
}

function alignOf(v) {
  switch (v) {
    case 'center': return 'center';
    case 'right': case 'end': return 'end';
    case 'both': case 'distribute': case 'justify': case 'thaiDistribute': case 'lowKashida': case 'mediumKashida': case 'highKashida':
      return 'justify';
    default: return 'start';
  }
}

const LEADERS = new Set(['dot', 'hyphen', 'underscore', 'heavy', 'middleDot']);

/**
 * w:tabs: the stops a paragraph sets and clears, in points. As TabStops' `aligned` entries, every
 * stop that isn't a plain left one: { align: 'right' | 'center' | 'decimal' | 'left', leader }.
 */
export function readTabs(x) {
  const stops = [];
  const cleared = [];
  const aligned = new Map();
  for (const t of x.children('tab')) {
    const pos = t.intAttr('pos');
    if (pos == null) continue;
    const at = pos / 20;
    const leaderName = t.attr('leader');
    const leader = LEADERS.has(leaderName) ? leaderName : null;
    switch (t.attr('val')) {
      case 'clear': cleared.push(at); break;
      case 'right': case 'end': stops.push(at); aligned.set(at, { align: 'right', leader }); break;
      case 'center': stops.push(at); aligned.set(at, { align: 'center', leader }); break;
      case 'decimal': stops.push(at); aligned.set(at, { align: 'decimal', leader }); break;
      default:
        stops.push(at);
        if (leader) aligned.set(at, { align: 'left', leader });
        break;
    }
  }
  return new TabStops([...new Set(stops)].sort((a, b) => a - b), cleared, aligned);
}

// ---------------------------------------------------------------------------------------------
// Borders and tables

/** The borders of a table or a cell (Borders); null sides aren't set here. */
export class Borders {
  constructor({ top = null, left = null, bottom = null, right = null, insideH = null, insideV = null } = {}) {
    this.top = top;
    this.left = left;
    this.bottom = bottom;
    this.right = right;
    this.insideH = insideH;
    this.insideV = insideV;
  }

  over(base) {
    if (base == null) return this;
    return new Borders({
      top: this.top ?? base.top, left: this.left ?? base.left, bottom: this.bottom ?? base.bottom,
      right: this.right ?? base.right, insideH: this.insideH ?? base.insideH, insideV: this.insideV ?? base.insideV,
    });
  }

  /** Reads w:tblBorders or w:tcBorders. */
  static read(x) {
    const b = new Borders();
    for (const c of x.children()) {
      const style = c.attr('val');
      const border = style == null || style === 'nil' || style === 'none' ? Border.NONE : new Border(
        clamp((c.intAttr('sz') ?? 4) / 8, 0.25, 6) * (style === 'double' ? 1.5 : 1),
        OfficeColors.hex(c.attr('color')) ?? BLACK,
      );
      switch (c.name) {
        case 'top': b.top = border; break;
        case 'left': case 'start': b.left = border; break;
        case 'bottom': b.bottom = border; break;
        case 'right': case 'end': b.right = border; break;
        case 'insideH': b.insideH = border; break;
        case 'insideV': b.insideV = border; break;
        default: break;
      }
    }
    return b;
  }
}

/**
 * Table formatting, from w:tblPr or a table style's: `margins` [left, top, right, bottom] (each
 * possibly null), `indent`, `align`, preferred `width` (points, or a share of the text's width when
 * `widthShare`), `rtl` (w:bidiVisual: the first column on the right).
 */
export class TableProps {
  constructor({ style = null, borders = null, margins = null, indent = null, align = null, width = null, widthShare = false, rtl = null } = {}) {
    this.style = style;
    this.borders = borders;
    this.margins = margins;
    this.indent = indent;
    this.align = align;
    this.width = width;
    this.widthShare = widthShare;
    this.rtl = rtl;
  }

  over(base) {
    if (base == null) return this;
    return new TableProps({
      style: this.style ?? base.style,
      borders: this.borders ? this.borders.over(base.borders) : base.borders,
      margins: this.margins ? [0, 1, 2, 3].map((i) => this.margins[i] ?? base.margins?.[i] ?? null) : base.margins,
      indent: this.indent ?? base.indent,
      align: this.align ?? base.align,
      width: this.width ?? base.width,
      widthShare: this.width != null ? this.widthShare : base.widthShare,
      rtl: this.rtl ?? base.rtl,
    });
  }

  static read(x) {
    const t = new TableProps();
    for (const c of x.children()) {
      switch (c.name) {
        case 'tblStyle': t.style = c.attr('val'); break;
        case 'tblBorders': t.borders = Borders.read(c); break;
        case 'tblCellMar': t.margins = TableProps.readMargins(c); break;
        case 'tblInd': { const w = c.intAttr('w'); t.indent = w != null ? w / 20 : null; break; }
        case 'jc': {
          const v = c.attr('val');
          t.align = v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'end' : 'start';
          break;
        }
        case 'bidiVisual': t.rtl = c.flag(); break;
        case 'tblW': {
          const type = c.attr('type');
          if (type === 'pct') {
            const w = c.attr('w');
            if (w != null) {
              const n = floatOrNull(w.endsWith('%') ? w.slice(0, -1) : w);
              if (n != null) {
                t.width = w.endsWith('%') ? n / 100 : n / 5000;
                t.widthShare = true;
              }
            }
          } else if (type === 'dxa' || type == null) {
            const w = c.intAttr('w');
            if (w != null && w > 0) {
              t.width = w / 20;
              t.widthShare = false;
            }
          }
          break;
        }
        default: break;
      }
    }
    return t;
  }

  /** w:tblCellMar or w:tcMar: [left, top, right, bottom] in points (null where not given). */
  static readMargins(x) {
    const m = [null, null, null, null];
    for (const c of x.children()) {
      const w = c.intAttr('w');
      if (w == null) continue;
      const value = w / 20;
      switch (c.name) {
        case 'left': case 'start': m[0] = value; break;
        case 'top': m[1] = value; break;
        case 'right': case 'end': m[2] = value; break;
        case 'bottom': m[3] = value; break;
        default: break;
      }
    }
    return m;
  }
}

/** Kotlin's String.toFloatOrNull, roughly: a decimal number, else null. */
function floatOrNull(s) {
  const t = trim(s);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(t)) return null;
  const v = Number(t.replace(/[fFdD]$/, ''));
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Styles

class StyleDef {
  constructor(type, basedOn, para, run, table, isDefault) {
    this.type = type;
    this.basedOn = basedOn;
    this.para = para;
    this.run = run;
    this.table = table;
    this.isDefault = isDefault;
  }
}

/** Word's styles (styles.xml): document defaults, then paragraph, character and table styles, each possibly based on another. */
export class DocxStyles {
  constructor(styles, defaultRun, defaultPara, theme) {
    this.styles = styles;
    this.defaultRun = defaultRun;
    this.defaultPara = defaultPara;
    this.theme = theme;
    this.defaultParagraphStyle = null;
    this.defaultTableStyle = null;
    for (const [id, s] of styles) {
      if (this.defaultParagraphStyle == null && s.type === 'paragraph' && s.isDefault) this.defaultParagraphStyle = id;
      if (this.defaultTableStyle == null && s.type === 'table' && s.isDefault) this.defaultTableStyle = id;
    }
    this.paraCache = new Map();
    this.runCache = new Map();
    this.tableCache = new Map();
  }

  /** Everything a style and the styles it's based on set, nearest first (at most 31 deep, and never round in a circle). */
  chain(id) {
    const out = [];
    let next = id;
    const seen = new Set();
    while (next != null && !seen.has(next) && seen.size < 31) {
      seen.add(next);
      const style = this.styles.get(next);
      if (!style) break;
      out.push(style);
      next = style.basedOn;
    }
    return out;
  }

  para(id) {
    const key = id ?? '';
    let v = this.paraCache.get(key);
    if (!v) {
      v = this.chain(id).reduce((acc, s) => acc.over(s.para), new ParaProps());
      this.paraCache.set(key, v);
    }
    return v;
  }

  run(id) {
    const key = id ?? '';
    let v = this.runCache.get(key);
    if (!v) {
      v = this.chain(id).reduce((acc, s) => acc.over(s.run), new RunProps());
      this.runCache.set(key, v);
    }
    return v;
  }

  table(id) {
    const key = id ?? '';
    let v = this.tableCache.get(key);
    if (!v) {
      v = this.chain(id).reduce((acc, s) => acc.over(s.table), new TableProps());
      this.tableCache.set(key, v);
    }
    return v;
  }

  /**
   * A paragraph's formatting: `direct`, then its style, inside a table the table style, then the
   * document defaults. Table style formatting gives way to a paragraph style, but not to the
   * default paragraph style ("Normal"), as in Word.
   */
  resolvePara(direct, tableStyle) {
    const id = direct.style ?? this.defaultParagraphStyle;
    const own = this.para(id);
    const table = tableStyle != null ? this.para(tableStyle) : null;
    const styled = table != null && id === this.defaultParagraphStyle ? table.over(own) : own.over(table);
    return direct.over(styled).over(this.defaultPara);
  }

  /** The run formatting a paragraph's text starts from: its style's, then the table style's, then the defaults. */
  paragraphRun(paraStyle, tableStyle) {
    const id = paraStyle ?? this.defaultParagraphStyle;
    const own = this.run(id);
    const table = tableStyle != null ? this.run(tableStyle) : null;
    const styled = table != null && id === this.defaultParagraphStyle ? table.over(own) : own.over(table);
    return styled.over(this.defaultRun);
  }

  /** Reads the styles part at `path` of `pkg` (no styles when `path` is null or missing). Throws XmlError for a damaged part. */
  static async read(pkg, path, theme) {
    const styles = new Map();
    let defaultRun = new RunProps();
    let defaultPara = new ParaProps();
    const x = path != null ? await pkg.xml(path) : null;
    if (x) {
      for (const c of x.children()) {
        if (c.name === 'docDefaults') {
          for (const d of c.children()) {
            if (d.name === 'rPrDefault') for (const r of d.children('rPr')) defaultRun = RunProps.read(r, theme);
            else if (d.name === 'pPrDefault') for (const r of d.children('pPr')) defaultPara = ParaProps.read(r, theme);
          }
        } else if (c.name === 'style') {
          const id = c.attr('styleId');
          if (id == null) continue;
          const type = c.attr('type') ?? 'paragraph';
          const isDefault = c.flag('default', false);
          let basedOn = null;
          let para = new ParaProps();
          let run = new RunProps();
          let table = null;
          for (const s of c.children()) {
            if (s.name === 'basedOn') basedOn = s.attr('val');
            else if (s.name === 'pPr') para = ParaProps.read(s, theme);
            else if (s.name === 'rPr') run = RunProps.read(s, theme);
            else if (s.name === 'tblPr') table = TableProps.read(s);
          }
          // As in a Kotlin HashMap, a style given twice is its last definition, kept in its first place.
          styles.set(id, new StyleDef(type, basedOn, para, run, table, isDefault));
        }
      }
    }
    return new DocxStyles(styles, defaultRun, defaultPara, theme);
  }
}

// ---------------------------------------------------------------------------------------------
// Lists

/**
 * One level of a Word list: how its number or bullet looks (`format`, `text` such as "%1."), where
 * it starts, its indents (`para`) and look (`run`), what comes between the number and the text
 * (`suffix`: 'tab', 'space' or 'nothing'), and `legal` (every level's number written in arabic).
 */
export class ListLevel {
  constructor(format, text, start, para, run, suffix, legal = false) {
    this.format = format;
    this.text = text;
    this.start = start;
    this.para = para;
    this.run = run;
    this.suffix = suffix;
    this.legal = legal;
  }
}

const Format = ListNumbering.Format;

/** Word's lists (numbering.xml), and their running counts. Lists sharing a definition continue each other's numbering unless they restart it, as in Word. */
export class DocxNumbering {
  constructor(abstracts, nums, overrides) {
    this.abstracts = abstracts;
    this.nums = nums;
    this.overrides = overrides;
    this.counters = new Map();
  }

  /** The ListLevel of list `numId` at `level`, or null. */
  level(numId, level) {
    const num = this.nums.get(numId);
    if (!num) return null;
    return this.overrides.get(numId)?.get(level) ?? this.abstracts.get(num[0])?.get(level) ?? null;
  }

  /** The next label of list `numId` at `level`, counting it. Null when there's no such list. */
  next(numId, level) {
    const lvl = this.level(numId, level);
    if (!lvl) return null;
    const [abstractId, starts] = this.nums.get(numId);
    const key = starts.size === 0 && !(this.overrides.get(numId)?.size > 0) ? `a${abstractId}` : `n${numId}`;
    let counter = this.counters.get(key);
    if (!counter) {
      counter = new Array(9).fill(-1);
      this.counters.set(key, counter);
    }
    const at = clamp(level, 0, 8);
    const startOf = (l) => starts.get(l) ?? this.level(numId, l)?.start ?? 1;
    counter[at] = counter[at] < 0 ? startOf(at) : counter[at] + 1;
    for (let deeper = at + 1; deeper < 9; deeper++) counter[deeper] = -1;
    for (let above = 0; above < at; above++) if (counter[above] < 0) counter[above] = startOf(above);
    if (lvl.format === Format.BULLET) return SymbolFonts.bullet(lvl.run.font, lvl.text);
    if (lvl.format === Format.NONE && !lvl.text.includes('%')) return lvl.text;
    const formats = [];
    for (let l = 0; l <= at; l++) {
      const format = this.level(numId, l)?.format ?? Format.DECIMAL;
      formats.push(lvl.legal && format !== Format.NONE ? Format.DECIMAL : format);
    }
    return ListNumbering.wordLabel(lvl.text, counter.slice(0, at + 1), formats);
  }

  /** Reads numbering.xml at `path`; `styles` has the numbering styles lists can be defined through. */
  static async read(pkg, path, theme, styles) {
    const x = path != null ? await pkg.xml(path) : null;
    if (!x) return new DocxNumbering(new Map(), new Map(), new Map());
    const abstracts = new Map();
    const nums = new Map();
    const overrides = new Map();
    // Lists defined through a numbering style: the definition that is the style's, by style, and
    // the definitions that only point to a style, with their style.
    const styleDefinitions = new Map();
    const linked = new Map();
    for (const c of x.children()) {
      if (c.name === 'abstractNum') {
        const id = c.intAttr('abstractNumId');
        if (id == null) continue;
        const levels = new Map();
        for (const l of c.children()) {
          if (l.name === 'lvl') {
            const read = readLevel(l, theme);
            if (read) levels.set(read[0], read[1]);
          } else if (l.name === 'styleLink') {
            const v = l.attr('val');
            if (v != null) styleDefinitions.set(v, id);
          } else if (l.name === 'numStyleLink') {
            const v = l.attr('val');
            if (v != null) linked.set(id, v);
          }
        }
        abstracts.set(id, levels);
      } else if (c.name === 'num') {
        const id = c.intAttr('numId');
        if (id == null) continue;
        let abstractId = -1;
        const starts = new Map();
        const levels = new Map();
        for (const n of c.children()) {
          if (n.name === 'abstractNumId') abstractId = n.intAttr('val') ?? -1;
          else if (n.name === 'lvlOverride') {
            const level = n.intAttr('ilvl') ?? 0;
            for (const o of n.children()) {
              if (o.name === 'startOverride') {
                const v = o.intAttr('val');
                if (v != null) starts.set(level, v);
              } else if (o.name === 'lvl') {
                const read = readLevel(o, theme);
                if (read) levels.set(level, read[1]);
              }
            }
          }
        }
        nums.set(id, [abstractId, starts]);
        if (levels.size) overrides.set(id, levels);
      }
    }
    // A list pointing to a numbering style takes its levels, and its count, from the style's definition.
    for (const [numId, num] of [...nums]) {
      const style = linked.get(num[0]);
      if (style == null) continue;
      const fromStyle = styles?.para(style)?.numId;
      const definition = styleDefinitions.get(style) ?? (fromStyle != null ? nums.get(fromStyle)?.[0] ?? null : null);
      if (definition != null && definition !== num[0]) nums.set(numId, [definition, num[1]]);
    }
    return new DocxNumbering(abstracts, nums, overrides);
  }
}

function readLevel(x, theme) {
  const level = x.intAttr('ilvl');
  if (level == null) return null;
  let format = Format.DECIMAL;
  let text = `%${level + 1}.`;
  let start = 1;
  let para = new ParaProps();
  let run = new RunProps();
  let suffix = 'tab';
  let legal = false;
  for (const c of x.children()) {
    switch (c.name) {
      case 'numFmt': format = ListNumbering.wordFormat(c.attr('val')); break;
      case 'lvlText': text = c.attr('val') ?? ''; break;
      case 'start': start = c.intAttr('val') ?? 1; break;
      case 'suff': suffix = c.attr('val') ?? 'tab'; break;
      case 'isLgl': legal = c.flag(); break;
      case 'pPr': para = ParaProps.read(c, theme); break;
      case 'rPr': run = RunProps.read(c, theme); break;
      default: break;
    }
  }
  return [level, new ListLevel(format, text, start, para, run, suffix, legal)];
}
