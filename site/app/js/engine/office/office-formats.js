// Measurements, numbering, symbols, columns, tab stops, page breaks, groups and table styles of
// Word, PowerPoint and Excel files: a port of the app's core/OfficeFormats.kt (its OfficeColors
// part is colors.js). Pure functions: no DOM, nothing to load. (The converter screens import this
// module before a file is picked, so it must not pull in the text engine and its fonts.)
import { trim, toIntOrNull, toDoubleOrNull, toInt, roundToInt, digitOf } from './xlsx-numbers-kt.js';

const f = Math.fround;

// ---------------------------------------------------------------------------------------------
// OfficeUnits

/**
 * Measurements in Word and PowerPoint files, as points (1/72 inch). Word uses twentieths of a point
 * (twips) and half-points; DrawingML uses English Metric Units, 12,700 to the point.
 */
export const OfficeUnits = Object.freeze({
  EMU_PER_POINT: 12700,

  emu(value) {
    return f(f(Number(value)) / 12700);
  },

  twips(value) {
    return f(f(Number(value)) / 20);
  },

  halfPoints(value) {
    return f(f(Number(value)) / 2);
  },

  /**
   * A DrawingML percentage in thousandths of a percent (90000 is 90%): as Office writes it, or as
   * Strict Open XML writes it ("90%"). Null when `text` is neither.
   */
  percentage(text) {
    if (text == null) return null;
    const t = trim(String(text));
    if (t.endsWith('%')) {
      const d = toDoubleOrNull(trim(t.slice(0, -1)));
      return d != null && Number.isFinite(d) ? roundToInt(d * 1000) : null;
    }
    const i = toIntOrNull(t);
    if (i != null) return i;
    const d = toDoubleOrNull(t);
    return d == null ? null : toInt(d);
  },

  /**
   * A length from a VML style such as "width:120pt" or "1.5in", in points. Bare numbers are
   * pixels at 96 dpi, as in CSS. Null when `text` isn't a length.
   */
  cssLength(text) {
    const s = String(text ?? '');
    // No length is longer: a crafted one, thousands of digits long, would keep the pattern busy.
    if (s.length > 64) return null;
    const m = /^[ \t\n\x0B\f\r]*(-?\d*\.?\d+)[ \t\n\x0B\f\r]*(pt|in|cm|mm|px|pc|emu)?[ \t\n\x0B\f\r]*$/.exec(s.toLowerCase());
    if (!m) return null;
    const number = f(Number(m[1]));
    if (!Number.isFinite(number)) return null;
    switch (m[2]) {
      case 'pt': return number;
      case 'in': return f(number * 72);
      case 'cm': return f(f(number * 72) / f(2.54));
      case 'mm': return f(f(number * 72) / f(25.4));
      case 'pc': return f(number * 12);
      case 'emu': return f(number / 12700);
      default: return f(number * f(0.75));
    }
  },

  /**
   * The declarations of a VML or CSS style attribute, such as "width:120pt;height:40pt", by
   * lowercase name, in an object without a prototype (so any name is safe as a key).
   */
  cssStyle(style) {
    const out = Object.create(null);
    for (const part of String(style ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon <= 0) continue;
      out[trim(part.slice(0, colon)).toLowerCase()] = trim(part.slice(colon + 1));
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------------
// OfficeFileType

/** What kind of file a Word, PowerPoint or Excel document turned out to be, from its first bytes. */
export const OfficeContainer = Object.freeze({
  /** A zip: the Office Open XML formats (.docx, .pptx, .xlsx). */
  ZIP: 'zip',
  /** An OLE compound file: the old binary formats (.doc, .ppt, .xls), or a password-protected new one. */
  COMPOUND: 'compound',
  /** Neither, such as an RTF or HTML file renamed to .doc. */
  OTHER: 'other',
});

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const COMPOUND_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENCRYPTED_PACKAGE = utf16le('EncryptedPackage');

function utf16le(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) out[2 * i] = s.charCodeAt(i);
  return out;
}

function startsWith(bytes, prefix) {
  if (!bytes || bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

export const OfficeFileType = Object.freeze({
  /** The container `header` (the file's first bytes, at least eight) starts. */
  container(header) {
    if (startsWith(header, ZIP_MAGIC)) return OfficeContainer.ZIP;
    if (startsWith(header, COMPOUND_MAGIC)) return OfficeContainer.COMPOUND;
    return OfficeContainer.OTHER;
  },

  /**
   * Whether a compound file holds an encrypted Office Open XML package, which is how Word,
   * PowerPoint and Excel save a document with a password. Its directory names a stream
   * "EncryptedPackage", written in UTF-16LE.
   */
  isEncryptedPackage(compound) {
    return OfficeFileType.contains(compound, ENCRYPTED_PACKAGE);
  },

  /** Whether `needle` occurs in `bytes`. */
  contains(bytes, needle) {
    if (!needle.length) throw new RangeError('needle must not be empty');
    const first = needle[0];
    const last = bytes.length - needle.length;
    outer: for (let start = bytes.indexOf(first); start >= 0 && start <= last; start = bytes.indexOf(first, start + 1)) {
      for (let k = 1; k < needle.length; k++) if (bytes[start + k] !== needle[k]) continue outer;
      return true;
    }
    return false;
  },
});

// ---------------------------------------------------------------------------------------------
// ListNumbering

const Format = Object.freeze({
  DECIMAL: 'DECIMAL',
  DECIMAL_ZERO: 'DECIMAL_ZERO',
  LOWER_LETTER: 'LOWER_LETTER',
  UPPER_LETTER: 'UPPER_LETTER',
  LOWER_ROMAN: 'LOWER_ROMAN',
  UPPER_ROMAN: 'UPPER_ROMAN',
  BULLET: 'BULLET',
  NONE: 'NONE',
});

const NUMERALS = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];

function letters(value) {
  // A page or list can start at any number: a huge one would make a label millions of letters long.
  if (!(value >= 1 && value <= 780)) return String(value);
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.trunc((value - 1) / 26) + 1);
}

function roman(value) {
  if (!(value >= 1 && value <= 3999)) return String(value);
  let rest = value;
  let out = '';
  for (const [n, s] of NUMERALS) {
    while (rest >= n) {
      out += s;
      rest -= n;
    }
  }
  return out;
}

/** Numbers for numbered lists, as Word and PowerPoint write them. */
export const ListNumbering = Object.freeze({
  Format,
  /** The formats in the app's order (Format.entries). */
  FORMATS: Object.freeze(Object.values(Format)),

  /** Word's w:numFmt. Formats Usugami doesn't know, such as Chinese counting, become decimal. */
  wordFormat(numFmt) {
    switch (numFmt) {
      case 'decimalZero': return Format.DECIMAL_ZERO;
      case 'lowerLetter': return Format.LOWER_LETTER;
      case 'upperLetter': return Format.UPPER_LETTER;
      case 'lowerRoman': return Format.LOWER_ROMAN;
      case 'upperRoman': return Format.UPPER_ROMAN;
      case 'bullet': return Format.BULLET;
      case 'none': return Format.NONE;
      default: return Format.DECIMAL;
    }
  },

  /**
   * `value` written in `format`. Letters go a…z, then aa…zz and on to 30 z's (780), as in Word;
   * roman numerals stop at 3999. Beyond those, as for 0 and less, the number is written in digits.
   */
  format(value, format) {
    switch (format) {
      case Format.DECIMAL: return String(value);
      case Format.DECIMAL_ZERO: return value >= 0 && value <= 9 ? `0${value}` : String(value);
      case Format.LOWER_LETTER: return letters(value);
      case Format.UPPER_LETTER: return letters(value).toUpperCase();
      case Format.LOWER_ROMAN: return roman(value).toLowerCase();
      case Format.UPPER_ROMAN: return roman(value);
      default: return '';
    }
  },

  /**
   * Word's level text, such as "%1." or "%1.%2)", with each %n replaced by the number of level n
   * (1-based) from `counters`, written in that level's format from `formats`.
   */
  wordLabel(levelText, counters, formats) {
    let out = '';
    let i = 0;
    while (i < levelText.length) {
      const c = levelText[i];
      const digit = c === '%' && i + 1 < levelText.length ? digitOf(levelText[i + 1], 10) : -1;
      if (digit >= 1 && digit <= counters.length) {
        out += ListNumbering.format(counters[digit - 1], formats[digit - 1] ?? Format.DECIMAL);
        i += 2;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  },

  /**
   * The number format a Word field's "\*" switch asks for, as in "PAGE \* roman": roman numerals or
   * letters, in lower case when the switch is, or arabic. Null when there's no such switch.
   */
  fieldFormat(instruction) {
    const re = /\\\*[ \t\n\x0B\f\r]*(\w+)/g;
    let found = null;
    for (const m of String(instruction).matchAll(re)) {
      if (['roman', 'alphabetic', 'arabic'].includes(m[1].toLowerCase())) {
        found = m[1];
        break;
      }
    }
    if (found == null) return null;
    const lower = found === found.toLowerCase();
    switch (found.toLowerCase()) {
      case 'roman': return lower ? Format.LOWER_ROMAN : Format.UPPER_ROMAN;
      case 'alphabetic': return lower ? Format.LOWER_LETTER : Format.UPPER_LETTER;
      default: return Format.DECIMAL;
    }
  },

  /**
   * A PowerPoint autonumber scheme such as "arabicPeriod" or "alphaLcParenBoth": [format, prefix,
   * suffix] (Kotlin's Triple).
   */
  powerPointScheme(scheme) {
    const s = scheme ?? '';
    let format = Format.DECIMAL;
    if (s.startsWith('alphaLc')) format = Format.LOWER_LETTER;
    else if (s.startsWith('alphaUc')) format = Format.UPPER_LETTER;
    else if (s.startsWith('romanLc')) format = Format.LOWER_ROMAN;
    else if (s.startsWith('romanUc')) format = Format.UPPER_ROMAN;
    let prefix = '';
    let suffix = '.';
    if (s.endsWith('ParenBoth')) [prefix, suffix] = ['(', ')'];
    else if (s.endsWith('ParenR')) suffix = ')';
    else if (s.endsWith('Plain')) suffix = '';
    else if (s.endsWith('Minus')) suffix = ' -';
    return [format, prefix, suffix];
  },
});

// ---------------------------------------------------------------------------------------------
// SymbolFonts

const WINGDINGS = new Map([
  [0xa7, '▪'], // small square
  [0xd8, '➢'], // arrowhead
  [0xfc, '✓'], // check mark
  [0xfb, '✗'], // cross
  [0x76, '❖'], // diamond of four
  [0x6e, '■'], // black square
  [0x6f, '□'], // white square
  [0x71, '❑'], // shadowed square
  [0x6c, '●'], // black circle
  [0xa1, '○'], // white circle
  [0x77, '⬥'], // diamond
  [0xe0, '→'], // right arrow
  [0xe8, '➔'], // heavy right arrow
  [0xf0, '⇨'], // white right arrow
]);
const SYMBOL = new Map([[0xb7, '•'], [0x2d, '–'], [0xae, '→'], [0xd8, '¬'], [0xa8, '♦']]);

/** Wingdings beyond the bullets: check boxes, and a few others found in forms. */
const WINGDINGS_SYMBOLS = new Map([
  [0xa8, '◻'], // empty check box
  [0xfe, '☑'], // check box with a tick
  [0xfd, '☒'], // check box with a cross
  [0x78, '⌧'], // check box with a cross, filled
  [0x70, '□'], // white square
  [0x75, '◆'], // black diamond
  [0x4a, '☺'], // smiling face
  [0x4c, '☹'], // frowning face
  [0x28, '☎'], // telephone
]);

const WINGDINGS_2 = new Map([
  [0x4f, '✗'], // cross
  [0x50, '✓'], // tick
  [0x51, '☒'], // check box with a cross
  [0x52, '☑'], // check box with a tick
  [0x53, '☒'],
  [0x54, '☒'],
  [0xa3, '□'], // empty check box
]);

/** The Symbol font's characters that aren't the ASCII ones at the same place: Adobe's Symbol encoding. */
const SYMBOL_TEXT = new Map(Object.entries({
  0x22: 0x2200, 0x24: 0x2203, 0x27: 0x220b, 0x2a: 0x2217, 0x2d: 0x2212, 0x40: 0x2245,
  // Greek capitals
  0x41: 0x0391, 0x42: 0x0392, 0x43: 0x03a7, 0x44: 0x0394, 0x45: 0x0395, 0x46: 0x03a6,
  0x47: 0x0393, 0x48: 0x0397, 0x49: 0x0399, 0x4a: 0x03d1, 0x4b: 0x039a, 0x4c: 0x039b,
  0x4d: 0x039c, 0x4e: 0x039d, 0x4f: 0x039f, 0x50: 0x03a0, 0x51: 0x0398, 0x52: 0x03a1,
  0x53: 0x03a3, 0x54: 0x03a4, 0x55: 0x03a5, 0x56: 0x03c2, 0x57: 0x03a9, 0x58: 0x039e,
  0x59: 0x03a8, 0x5a: 0x0396, 0x5c: 0x2234, 0x5e: 0x22a5, 0x60: 0x203e,
  // Greek small letters
  0x61: 0x03b1, 0x62: 0x03b2, 0x63: 0x03c7, 0x64: 0x03b4, 0x65: 0x03b5, 0x66: 0x03c6,
  0x67: 0x03b3, 0x68: 0x03b7, 0x69: 0x03b9, 0x6a: 0x03d5, 0x6b: 0x03ba, 0x6c: 0x03bb,
  0x6d: 0x03bc, 0x6e: 0x03bd, 0x6f: 0x03bf, 0x70: 0x03c0, 0x71: 0x03b8, 0x72: 0x03c1,
  0x73: 0x03c3, 0x74: 0x03c4, 0x75: 0x03c5, 0x76: 0x03d6, 0x77: 0x03c9, 0x78: 0x03be,
  0x79: 0x03c8, 0x7a: 0x03b6, 0x7e: 0x223c,
  0xa0: 0x20ac, 0xa1: 0x03d2, 0xa2: 0x2032, 0xa3: 0x2264, 0xa4: 0x2044, 0xa5: 0x221e,
  0xa6: 0x0192, 0xa7: 0x2663, 0xa8: 0x2666, 0xa9: 0x2665, 0xaa: 0x2660, 0xab: 0x2194,
  0xac: 0x2190, 0xad: 0x2191, 0xae: 0x2192, 0xaf: 0x2193, 0xb0: 0x00b0, 0xb1: 0x00b1,
  0xb2: 0x2033, 0xb3: 0x2265, 0xb4: 0x00d7, 0xb5: 0x221d, 0xb6: 0x2202, 0xb7: 0x2022,
  0xb8: 0x00f7, 0xb9: 0x2260, 0xba: 0x2261, 0xbb: 0x2248, 0xbc: 0x2026, 0xbd: 0x23d0,
  0xbe: 0x23af, 0xbf: 0x21b5, 0xc0: 0x2135, 0xc1: 0x2111, 0xc2: 0x211c, 0xc3: 0x2118,
  0xc4: 0x2297, 0xc5: 0x2295, 0xc6: 0x2205, 0xc7: 0x2229, 0xc8: 0x222a, 0xc9: 0x2283,
  0xca: 0x2287, 0xcb: 0x2284, 0xcc: 0x2282, 0xcd: 0x2286, 0xce: 0x2208, 0xcf: 0x2209,
  0xd0: 0x2220, 0xd1: 0x2207, 0xd2: 0x00ae, 0xd3: 0x00a9, 0xd4: 0x2122, 0xd5: 0x220f,
  0xd6: 0x221a, 0xd7: 0x22c5, 0xd8: 0x00ac, 0xd9: 0x2227, 0xda: 0x2228, 0xdb: 0x21d4,
  0xdc: 0x21d0, 0xdd: 0x21d1, 0xde: 0x21d2, 0xdf: 0x21d3, 0xe0: 0x25ca, 0xe1: 0x27e8,
  0xe2: 0x00ae, 0xe3: 0x00a9, 0xe4: 0x2122, 0xe5: 0x2211, 0xe6: 0x239b, 0xe7: 0x239c,
  0xe8: 0x239d, 0xe9: 0x23a1, 0xea: 0x23a2, 0xeb: 0x23a3, 0xec: 0x23a7, 0xed: 0x23a8,
  0xee: 0x23a9, 0xef: 0x23aa, 0xf1: 0x27e9, 0xf2: 0x222b, 0xf3: 0x2320, 0xf4: 0x23ae,
  0xf5: 0x2321, 0xf6: 0x239e, 0xf7: 0x239f, 0xf8: 0x23a0, 0xf9: 0x23a4, 0xfa: 0x23a5,
  0xfb: 0x23a6, 0xfc: 0x23ab, 0xfd: 0x23ac, 0xfe: 0x23ad,
}).map(([k, v]) => [Number(k), String.fromCodePoint(v)]));

const firstCodePoint = (text) => text.codePointAt(0);

/**
 * Bullets written in symbol fonts. Word and PowerPoint draw many bullets with characters of Symbol
 * or Wingdings, whose shapes aren't the letters' usual ones; the device doesn't have those fonts, so
 * the common ones become the matching Unicode characters, and any other one a plain bullet.
 */
export const SymbolFonts = Object.freeze({
  /**
   * `text` as it should show. A character in the private-use range F000–F0FF stands for that
   * font's character at its low byte, as Word writes symbols.
   */
  bullet(font, text) {
    if (!text) return text ?? '';
    const name = (font ?? '').toLowerCase();
    const symbolFont = name.startsWith('wingdings') || name === 'symbol' || name.startsWith('webdings');
    const code = firstCodePoint(text);
    const privateUse = code >= 0xf000 && code <= 0xf0ff;
    if (!symbolFont && !privateUse) return text;
    const low = privateUse ? code - 0xf000 : code;
    if (name === 'symbol' || (privateUse && !name.startsWith('wingdings'))) return SYMBOL.get(low) ?? '•';
    if (name.startsWith('wingdings')) return WINGDINGS.get(low) ?? '•';
    return '•';
  },

  /**
   * A character Word inserts with Insert > Symbol (w:sym), `text` in `font`, as it should show:
   * Symbol's Greek letters, maths and arrows, and Wingdings' check boxes, ticks and bullets. A
   * character of a symbol font that isn't known becomes U+FFFD, never a bullet.
   */
  character(font, text) {
    if (!text) return text ?? '';
    const name = trim(font ?? '').toLowerCase();
    const code = firstCodePoint(text);
    const privateUse = code >= 0xf000 && code <= 0xf0ff;
    const low = privateUse ? code - 0xf000 : code;
    const dingbats = name.startsWith('wingdings') || name.startsWith('webdings');
    if (!privateUse && (low > 0xff || (!dingbats && name !== 'symbol'))) return text;
    let out;
    if (name === 'wingdings') out = WINGDINGS.get(low) ?? WINGDINGS_SYMBOLS.get(low);
    else if (name === 'wingdings 2') out = WINGDINGS_2.get(low);
    else if (dingbats) out = undefined;
    // Symbol, or a private-use character in another font: Word's symbols are Symbol's.
    else out = SYMBOL_TEXT.get(low) ?? (low >= 0x20 && low <= 0x7e ? String.fromCharCode(low) : undefined);
    return out ?? '�';
  },

  /**
   * A run of text in `font` as it should show, as character() maps it: every character when `font`
   * is Symbol, Wingdings or Webdings, and in any font the private-use characters F000–F0FF that
   * stand for a symbol font's: `symbol`'s (PowerPoint's a:sym) when given. Spaces and line breaks stay.
   */
  text(font, text, symbol = null) {
    const s = text ?? '';
    const name = trim(font ?? '').toLowerCase();
    const symbolFont = name === 'symbol' || name.startsWith('wingdings') || name.startsWith('webdings');
    let hasPrivate = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xf000 && c <= 0xf0ff) { hasPrivate = true; break; }
    }
    if (!symbolFont && !hasPrivate) return s;
    let out = '';
    for (const char of s) {
      const code = char.codePointAt(0);
      if (code <= 0x20) out += char;
      else if (code >= 0xf000 && code <= 0xf0ff) out += SymbolFonts.character(symbol ?? font, char);
      else if (symbolFont) out += SymbolFonts.character(font, char);
      else out += char;
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------------
// TableColumns

/** Column widths of a table. */
export const TableColumns = Object.freeze({
  /**
   * Widths for `count` columns from the table's grid (`grid`, as saved by Word or PowerPoint),
   * scaled down to `available` if wider. Without a usable grid the columns share `preferred`
   * (or `available`) equally. A grid with fewer columns than `count` gets the missing ones at the
   * average width.
   */
  widths(grid, count, available, preferred = null) {
    const n = Math.max(count, grid.length, 1);
    const usable = grid.filter((w) => w > 0);
    let widths;
    if (!usable.length) {
      const total = Math.min(preferred != null && preferred > 0 ? preferred : available, available);
      widths = Array.from({ length: n }, () => f(total / n));
    } else {
      const average = f(usable.reduce((s, w) => s + w, 0) / usable.length);
      widths = Array.from({ length: n }, (_, i) => (grid[i] > 0 ? grid[i] : average));
    }
    let total = 0;
    for (const w of widths) total = f(total + w);
    return total > available && total > 0 ? widths.map((w) => f(f(w * available) / total)) : widths;
  },
});

// ---------------------------------------------------------------------------------------------
// TabStops

/** A Word tab stop that the text after the tab ends at (RIGHT) or is centred on (CENTER), rather than starts at. */
export const TabAlign = Object.freeze({ RIGHT: 'RIGHT', CENTER: 'CENTER' });

const distinct = (list) => [...new Set(list)];

/**
 * A Word paragraph's, list level's or style's own tab stops, in points: those it sets (`set`), and
 * those it clears (w:tab w:val="clear") of the stops it would inherit (`cleared`). Those of the set
 * stops that are right or centre stops are in `aligned` (a Map from position to TabAlign); the
 * others are left stops.
 */
export class TabStops {
  constructor(set, cleared = [], aligned = new Map()) {
    this.set = set;
    this.cleared = cleared;
    this.aligned = aligned instanceof Map ? aligned : new Map(Object.entries(aligned ?? {}).map(([k, v]) => [Number(k), v]));
  }

  /** These over `base`'s (its style's, say): as in Word, the stops `base` has, but those cleared here, and these. */
  over(base) {
    if (base == null) return this;
    const aligned = new Map();
    for (const [k, v] of base.aligned) if (!this.cleared.includes(k) && !this.set.includes(k)) aligned.set(k, v);
    for (const [k, v] of this.aligned) aligned.set(k, v);
    return new TabStops(
      distinct([...base.set.filter((s) => !this.cleared.includes(s)), ...this.set]).sort((a, b) => a - b),
      distinct([...this.cleared, ...base.cleared].filter((s) => !this.set.includes(s))),
      aligned,
    );
  }

  /**
   * Where each tab of a line takes the text after it, as Word puts it: at a left stop, ending at a
   * right one, centred on a centre one, and past the stops at the next of every `defaultTab`.
   * `start` is where the line's text starts and `widths` the width of each piece of text between its
   * tabs (the first before any); `scale` turns these stops' points into the same units.
   */
  positions(start, widths, defaultTab, scale = 1) {
    const out = [];
    let x = f(start + (widths[0] ?? 0));
    for (const width of widths.slice(1)) {
      const stop = this.set.find((s) => f(s * scale) > f(x + 1));
      let at;
      if (stop === undefined) {
        at = f(f(Math.floor(x / defaultTab) + 1) * defaultTab);
      } else {
        const align = this.aligned.get(stop);
        if (align === TabAlign.RIGHT) at = f(f(stop * scale) - width);
        else if (align === TabAlign.CENTER) at = f(f(stop * scale) - f(width / 2));
        else at = f(stop * scale);
      }
      const placed = Math.max(at, f(x + 1));
      out.push(placed);
      x = f(placed + width);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// PageBreaking

/** Bottoms are measured in floating point: a line this little past the space left still fits. */
const BREAK_EPS = 1e-6;

/**
 * Where a paragraph of text is split between two pages: OfficeFormats.kt's PageBreaking, the same
 * rule as the text engine's linesThatFit (text/layout.js), ported here so this module loads nothing.
 */
export const PageBreaking = Object.freeze({
  /**
   * How many of a paragraph's lines go on this page when `space` is left, given each line's bottom
   * measured from the paragraph's top (`lineBottoms`, increasing). Like Word's widow and orphan
   * control (when `avoidSingleLines`): a single first line isn't left alone at the bottom of the
   * page, and a single last line isn't carried alone to the next one. 0: the whole paragraph moves
   * to the next page. With `force` (nothing else is on the page) at least one line stays. Lines
   * that follow on from lines laid out before them (`keepFirst` false) or go on in lines laid out
   * after them (`keepLast` false) are like any other lines there: a single one is left alone.
   */
  linesThatFit(lineBottoms, space, avoidSingleLines, force, keepFirst = true, keepLast = true) {
    const bottoms = Array.from(lineBottoms);
    const count = bottoms.length;
    let fit = 0;
    for (const b of bottoms) if (b <= space + BREAK_EPS) fit++;
    if (avoidSingleLines && fit >= 1 && fit < count) {
      if (keepLast && fit === count - 1) fit -= 1;
      if (keepFirst && fit === 1) fit = 0;
    }
    return force ? Math.max(fit, Math.min(1, count)) : fit;
  },
});

// ---------------------------------------------------------------------------------------------
// OfficeRect and GroupFrame

/** A rectangle in a slide's or group's coordinates, in points. */
export class OfficeRect {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  get centerX() {
    return this.x + this.width / 2;
  }

  get centerY() {
    return this.y + this.height / 2;
  }

  get left() { return this.x; }
  get top() { return this.y; }
  get right() { return this.x + this.width; }
  get bottom() { return this.y + this.height; }

  copy({ x = this.x, y = this.y, width = this.width, height = this.height } = {}) {
    return new OfficeRect(x, y, width, height);
  }

  equals(other) {
    return other != null && other.x === this.x && other.y === this.y && other.width === this.width && other.height === this.height;
  }
}

/**
 * How a group shape places its children: their coordinates (`childOffset`, `childExtent`, each
 * [x, y]) are stretched onto the group's own rectangle (`frame`), and mirrored in it when the group
 * is flipped (`flipH`, `flipV`).
 */
export class GroupFrame {
  constructor(frame, childOffset, childExtent, flipH = false, flipV = false) {
    this.frame = frame;
    this.childOffset = childOffset;
    this.childExtent = childExtent;
    this.flipH = flipH;
    this.flipV = flipV;
    this.scaleX = Math.abs(childExtent[0]) > 0 ? f(frame.width / childExtent[0]) : 1;
    this.scaleY = Math.abs(childExtent[1]) > 0 ? f(frame.height / childExtent[1]) : 1;
  }

  /** Where a child at `rect`, in the group's child coordinates, lands. */
  place(rect) {
    const fr = this.frame;
    const x = f(fr.x + f(f(rect.x - this.childOffset[0]) * this.scaleX));
    const y = f(fr.y + f(f(rect.y - this.childOffset[1]) * this.scaleY));
    const width = f(rect.width * this.scaleX);
    const height = f(rect.height * this.scaleY);
    const cx = f(fr.x + f(fr.width / 2));
    const cy = f(fr.y + f(fr.height / 2));
    return new OfficeRect(
      this.flipH ? f(f(f(2 * cx) - x) - width) : x,
      this.flipV ? f(f(f(2 * cy) - y) - height) : y,
      width,
      height,
    );
  }

  /**
   * A child's own turn (`rotation`, degrees clockwise) and flips as they show once the group's flips
   * mirror it: [rotation, flipH, flipV]. Each flip of the group adds one to the child's, and a single
   * mirroring turns it the other way.
   */
  mirror(rotation, flipH, flipV) {
    return [this.flipH !== this.flipV ? -rotation : rotation, flipH !== this.flipH, flipV !== this.flipV];
  }
}

// ---------------------------------------------------------------------------------------------
// SlideTableStyles

/**
 * PowerPoint table styles (Light Style 1, Medium Style 2...): which of a style's parts apply to a
 * cell, and which of a part's borders draws each of the cell's edges.
 */
export const SlideTableStyles = Object.freeze({
  /**
   * The parts that apply to the cell in `row` of `rows` covering columns `start` until `end` of
   * `columns`, weakest first, for a table with `flags` (firstRow, bandRow...: a Set or an array).
   * Banded rows and columns start after a header row or column.
   */
  parts(flags, row, rows, start, end, columns) {
    const has = (name) => (flags instanceof Set ? flags.has(name) : flags.includes(name));
    const parts = ['wholeTbl'];
    const bodyRow = has('firstRow') ? row - 1 : row;
    const bodyColumn = has('firstCol') ? start - 1 : start;
    if (has('bandRow') && bodyRow >= 0) parts.push(bodyRow % 2 === 0 ? 'band1H' : 'band2H');
    if (has('bandCol') && bodyColumn >= 0) parts.push(bodyColumn % 2 === 0 ? 'band1V' : 'band2V');
    if (has('lastCol') && end >= columns) parts.push('lastCol');
    if (has('firstCol') && start === 0) parts.push('firstCol');
    if (has('lastRow') && row === rows - 1) parts.push('lastRow');
    if (has('firstRow') && row === 0) parts.push('firstRow');
    return parts;
  },

  /**
   * The border of part `part` that draws a cell's `side` edge ('left', 'top', 'right' or 'bottom'):
   * the side itself where the edge is on the outline of what the part covers, its insideH or
   * insideV within it. `outer`: the edge is on the table's outline.
   */
  border(part, side, outer) {
    const horizontal = side === 'top' || side === 'bottom';
    let onOutline;
    switch (part) {
      case 'firstRow': case 'lastRow': case 'band1H': case 'band2H': onOutline = horizontal || outer; break;
      case 'firstCol': case 'lastCol': case 'band1V': case 'band2V': onOutline = !horizontal || outer; break;
      default: onOutline = outer;
    }
    return onOutline ? side : horizontal ? 'insideH' : 'insideV';
  },
});

// ---------------------------------------------------------------------------------------------
// Paper

const mm = (x) => (x * 72) / 25.4;

/** The app's PageSize papers, portrait, in points: { width, height }. */
export const PAPER_SIZES = Object.freeze({
  a4: Object.freeze({ width: mm(210), height: mm(297) }),
  letter: Object.freeze({ width: 612, height: 792 }),
  legal: Object.freeze({ width: 612, height: 1008 }),
  a3: Object.freeze({ width: mm(297), height: mm(420) }),
  a5: Object.freeze({ width: mm(148), height: mm(210) }),
});

/**
 * A paper's size in points ('a4', 'letter', 'legal', 'a3', 'a5'), turned to landscape when asked;
 * null for an unknown id.
 */
export function paperSize(id, landscape = false) {
  const p = PAPER_SIZES[id];
  if (!p) return null;
  return landscape ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}
