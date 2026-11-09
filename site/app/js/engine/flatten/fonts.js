// The fonts a form's fields are drawn in: their own font resources (/DR), read well enough to turn
// a field's text into character codes, measure it and place it, as PDFBox does when it draws a
// field. A character the font can't show (Hindi in a Latin-only font, the rupee sign in
// Helvetica) throws CannotDraw, so the field can be left for viewers to draw instead of being
// drawn blank or wrong.
import { StandardFontEmbedder, parseToUnicode } from '../../lib/pdf-lib.js';
import fontkit from '../../lib/fontkit.js';
import { STANDARD, MAC_ROMAN, WIN_ANSI, SYMBOL, ZAPF_DINGBATS, glyphToUnicode } from './encodings.js';
import {
  get, getDict, getArray, getStream, getName, getNum, getText, numbers, resolve, streamData,
  nameOf, num, PDFArray, PDFName,
} from './cos.js';

/** Text a field's font can't show, or a font that can't be used to draw at all. */
export class CannotDraw extends Error {
  constructor(message) {
    super(message);
    this.name = 'CannotDraw';
  }
}

const STANDARD_14 = new Set([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats',
]);

/** The names Acrobat gives the standard fonts in forms' resources. */
const ACROBAT_NAMES = {
  Helv: 'Helvetica', HeBo: 'Helvetica-Bold', HeOb: 'Helvetica-Oblique', HeBO: 'Helvetica-BoldOblique',
  TiRo: 'Times-Roman', TiBo: 'Times-Bold', TiIt: 'Times-Italic', TiBI: 'Times-BoldItalic',
  Cour: 'Courier', CoBo: 'Courier-Bold', CoOb: 'Courier-Oblique', CoBO: 'Courier-BoldOblique',
  Symb: 'Symbol', ZaDb: 'ZapfDingbats',
};

/**
 * The standard 14 font a font name stands for ('ArialMT' and 'Arial,Bold' are Helvetica and
 * Helvetica-Bold to PDF viewers), or null.
 */
export function standard14(baseFont) {
  if (!baseFont) return null;
  const name = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/\s+/g, '');
  if (STANDARD_14.has(name)) return name;
  const lower = name.toLowerCase();
  let family;
  if (/^(helvetica|arial)/.test(lower)) family = 'Helvetica';
  else if (/^courier/.test(lower)) family = 'Courier';
  else if (/^times/.test(lower)) family = 'Times';
  else if (/^symbol/.test(lower)) return 'Symbol';
  else if (/^(zapfdingbats|dingbats)/.test(lower)) return 'ZapfDingbats';
  else return null;
  // Only the plain families and their styles: not "ArialNarrow" or "HelveticaNeue".
  const rest = lower.replace(/^(helvetica|arial|courier(new)?|times(newroman)?)(ps)?(mt)?/, '');
  if (!/^([,-]?(bold|italic|oblique|bolditalic|boldoblique|roman|regular)?(mt)?)$/.test(rest)) return null;
  const bold = rest.includes('bold');
  const italic = /italic|oblique/.test(rest);
  if (family === 'Times') return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : 'Times-Roman');
  return family + (bold ? (italic ? '-BoldOblique' : '-Bold') : (italic ? '-Oblique' : ''));
}

/** The standard font Acrobat's short resource name stands for ('Helv': Helvetica), or null. */
export function acrobatFont(resourceName) {
  return ACROBAT_NAMES[resourceName] ?? (STANDARD_14.has(resourceName) ? resourceName : null);
}

const afms = new Map();
function afm(name) {
  let font = afms.get(name);
  if (!font) {
    font = StandardFontEmbedder.for(name).font;
    afms.set(name, font);
  }
  return font;
}

const ENCODINGS = {
  StandardEncoding: STANDARD, MacRomanEncoding: MAC_ROMAN, WinAnsiEncoding: WIN_ANSI,
};

function parseFont(bytes) {
  try {
    const font = fontkit.create(bytes);
    // A collection or a font fontkit only half reads is no use here.
    return font && typeof font.layout === 'function' && font.unitsPerEm > 0 ? font : null;
  } catch {
    return null;
  }
}

/** Metrics in thousandths of the font size, falling back on Helvetica's when the font has none. */
function metrics(ctx, descriptor, standard, program) {
  const helvetica = afm('Helvetica');
  const fromAfm = standard ? afm(standard) : null;
  const scale = program ? 1000 / program.unitsPerEm : 1;
  const pick = (key, afmKey, programValue, fallback) => {
    const v = descriptor ? getNum(ctx, descriptor, key, 0) : 0;
    if (v) return v;
    if (fromAfm && fromAfm[afmKey]) return fromAfm[afmKey];
    if (programValue) return programValue * scale;
    return fallback;
  };
  let bbox = descriptor ? numbers(ctx, get(ctx, descriptor, 'FontBBox')) : undefined;
  if (!bbox || bbox.length < 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[3] - bbox[1] <= 0) {
    if (fromAfm) bbox = fromAfm.FontBBox;
    else if (program?.bbox && program.bbox.maxY > program.bbox.minY) bbox = [program.bbox.minX, program.bbox.minY, program.bbox.maxX, program.bbox.maxY].map((v) => v * scale);
    else bbox = helvetica.FontBBox;
  }
  return {
    bboxHeight: bbox[3] - bbox[1],
    capHeight: pick('CapHeight', 'CapHeight', program?.capHeight, helvetica.CapHeight),
    ascent: pick('Ascent', 'Ascender', program?.ascent, helvetica.Ascender),
    descent: pick('Descent', 'Descender', program?.descent, helvetica.Descender),
  };
}

/** A font with one byte per character: Type1, TrueType and their kin. */
class SimpleFont {
  constructor(ctx, dict) {
    const subtype = getName(ctx, dict, 'Subtype') ?? 'Type1';
    const baseFont = getName(ctx, dict, 'BaseFont') ?? '';
    const descriptor = getDict(ctx, dict, 'FontDescriptor');
    const fontFile = descriptor && (getStream(ctx, descriptor, 'FontFile') || getStream(ctx, descriptor, 'FontFile2') || getStream(ctx, descriptor, 'FontFile3'));
    const embedded = !!fontFile;
    const standard = !embedded ? standard14(baseFont) : null;
    this.afm = standard ? afm(standard) : null;
    // TrueType and OpenType programs can be read for their glyphs; Type1 and bare CFF can't here.
    const fontFile3Type = fontFile && getName(ctx, fontFile, 'Subtype');
    this.program = fontFile && (getStream(ctx, descriptor, 'FontFile2') === fontFile || fontFile3Type === 'OpenType')
      ? parseFont(streamData(fontFile)) : null;
    const flags = descriptor ? getNum(ctx, descriptor, 'Flags', 0) : 0;
    const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;

    // The glyph name each code draws.
    let base;
    if (standard === 'Symbol') base = SYMBOL;
    else if (standard === 'ZapfDingbats') base = ZAPF_DINGBATS;
    else if (subtype === 'TrueType' && symbolic && this.program && !get(ctx, dict, 'Encoding')) {
      base = this.builtInEncoding();
      this.builtIn = true;
    } else base = STANDARD;
    const encoding = get(ctx, dict, 'Encoding');
    let names = base;
    if (encoding instanceof PDFName) {
      names = ENCODINGS[nameOf(encoding)] ?? base;
    } else if (encoding && typeof encoding.get === 'function') {
      const baseName = getName(ctx, encoding, 'BaseEncoding');
      names = (baseName && ENCODINGS[baseName]) || base;
      const differences = getArray(ctx, encoding, 'Differences');
      if (differences) {
        names = names.slice();
        let code = 0;
        for (let i = 0; i < differences.size(); i++) {
          const item = resolve(ctx, differences.get(i));
          const n = num(item, NaN);
          if (Number.isFinite(n)) code = Math.trunc(n);
          else if (item instanceof PDFName) {
            if (code >= 0 && code < 256) names[code] = nameOf(item);
            code++;
          }
        }
      }
    }
    this.names = names;
    this.toCode = new Map();
    for (let code = 0; code < 256; code++) {
      const text = glyphToUnicode(names[code]);
      if (text && [...text].length === 1 && !this.toCode.has(text)) this.toCode.set(text, code);
    }
    // A code whose glyph the font program doesn't have draws nothing, or a box.
    this.charSet = null;
    const charSet = descriptor && getText(ctx, descriptor, 'CharSet');
    if (charSet && !this.program && !this.afm) this.charSet = new Set(charSet.split('/').filter(Boolean));

    this.programCmap = false;
    if (this.program) {
      try {
        this.programCmap = this.program.characterSet.length > 0;
      } catch {
        this.programCmap = false;
      }
    }
    this.widths = numbers(ctx, get(ctx, dict, 'Widths'));
    this.firstChar = getNum(ctx, dict, 'FirstChar', 0);
    this.missingWidth = descriptor ? getNum(ctx, descriptor, 'MissingWidth', NaN) : NaN;
    this.embedded = embedded;
    this.metrics = metrics(ctx, descriptor, standard, this.program);
  }

  /** What a symbolic TrueType font without an /Encoding draws for each code, by its glyphs' names. */
  builtInEncoding() {
    const names = new Array(256).fill('');
    for (let code = 0; code < 256; code++) {
      for (const cp of [code, 0xf000 + code, 0xf100 + code, 0xf200 + code]) {
        let glyph;
        try {
          glyph = this.program.glyphForCodePoint(cp);
        } catch {
          glyph = null;
        }
        if (glyph && glyph.id > 0) {
          names[code] = glyph.name || (code >= 32 && code < 127 ? glyphNameOfAscii(code) : '');
          break;
        }
      }
    }
    return names;
  }

  hasGlyph(code, char) {
    const name = this.names[code];
    if (this.afm) return this.afm.CharWidths[name] !== undefined;
    if (this.builtIn) return !!name;
    if (this.programCmap) {
      try {
        return this.program.hasGlyphForCodePoint(char.codePointAt(0));
      } catch {
        return false;
      }
    }
    if (this.charSet) return this.charSet.has(name);
    // A font the PDF doesn't carry is drawn by viewers in a font of their own: trust its encoding.
    if (!this.embedded) return true;
    return name === 'space' || this.width(code) > 0;
  }

  width(code) {
    const w = this.widths;
    const i = code - this.firstChar;
    if (w && i >= 0 && i < w.length) return Number.isFinite(w[i]) ? w[i] : 0;
    if (w && Number.isFinite(this.missingWidth)) return this.missingWidth;
    if (this.afm) return this.afm.CharWidths[this.names[code]] ?? 0;
    if (this.program) {
      try {
        const glyph = this.program.glyphForCodePoint(glyphToUnicode(this.names[code]).codePointAt(0) ?? code);
        if (glyph?.id > 0) return glyph.advanceWidth * 1000 / this.program.unitsPerEm;
      } catch {
        // fall through to Helvetica's width
      }
    }
    return afm('Helvetica').CharWidths[this.names[code]] ?? 0;
  }

  /** Codes for `text` (as hex) and its width in thousandths of the font size; throws CannotDraw. */
  encode(text) {
    let hex = '';
    let width = 0;
    for (const char of text) {
      let code = this.toCode.get(char);
      // A no-break space is drawn as a space.
      if (code === undefined && char === '\xa0') code = this.toCode.get(' ');
      if (code === undefined || !this.hasGlyph(code, char)) {
        throw new CannotDraw(`No glyph for U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
      }
      hex += code.toString(16).padStart(2, '0');
      width += this.width(code);
    }
    return { hex, width };
  }
}

function glyphNameOfAscii(code) {
  return STANDARD[code] || '';
}

/** A composite font (Type0) with an embedded TrueType program and two bytes per glyph (Identity-H). */
class Type0Font {
  constructor(ctx, dict) {
    if (getName(ctx, dict, 'Encoding') !== 'Identity-H') throw new CannotDraw('Only Identity-H composite fonts');
    const descendants = getArray(ctx, dict, 'DescendantFonts');
    const cidFont = descendants && resolve(ctx, descendants.get(0));
    if (!cidFont || getName(ctx, cidFont, 'Subtype') !== 'CIDFontType2') throw new CannotDraw('Only TrueType composite fonts');
    const descriptor = getDict(ctx, cidFont, 'FontDescriptor');
    const file = descriptor && getStream(ctx, descriptor, 'FontFile2');
    this.program = file ? parseFont(streamData(file)) : null;
    if (!this.program) throw new CannotDraw('Composite font not embedded');
    // Glyph to CID: the CIDToGIDMap read backwards (Identity when there is none).
    const map = get(ctx, cidFont, 'CIDToGIDMap');
    this.gidToCid = null;
    if (map && typeof map.getContents === 'function') {
      const data = streamData(map);
      if (data) {
        this.gidToCid = new Map();
        for (let cid = 0; cid * 2 + 1 < data.length; cid++) {
          const gid = (data[cid * 2] << 8) | data[cid * 2 + 1];
          if (gid && !this.gidToCid.has(gid)) this.gidToCid.set(gid, cid);
        }
      }
    }
    // Widths by CID: [first [w1 w2 ...]] and [first last w].
    this.defaultWidth = getNum(ctx, cidFont, 'DW', 1000);
    this.widthOf = new Map();
    const w = getArray(ctx, cidFont, 'W');
    if (w) {
      let i = 0;
      while (i < w.size() && this.widthOf.size < 70000) {
        const first = num(resolve(ctx, w.get(i)), NaN);
        const next = resolve(ctx, w.get(i + 1));
        if (!Number.isFinite(first)) break;
        if (next instanceof PDFArray) {
          for (let k = 0; k < next.size(); k++) this.widthOf.set(first + k, num(resolve(ctx, next.get(k)), this.defaultWidth));
          i += 2;
        } else {
          const last = num(next, NaN);
          const width = num(resolve(ctx, w.get(i + 2)), this.defaultWidth);
          if (!Number.isFinite(last)) break;
          for (let cid = first; cid <= last && cid - first < 70000; cid++) this.widthOf.set(cid, width);
          i += 3;
        }
      }
    }
    // Text to CID from the font's ToUnicode map, for a program whose own character map is missing.
    this.fromUnicode = new Map();
    const toUnicode = getStream(ctx, dict, 'ToUnicode');
    if (toUnicode) {
      try {
        const data = streamData(toUnicode);
        if (data) {
          for (const [code, text] of parseToUnicode(data)) if (!this.fromUnicode.has(text)) this.fromUnicode.set(text, code);
        }
      } catch {
        // No ToUnicode then.
      }
    }
    this.metrics = metrics(ctx, descriptor, null, this.program);
  }

  cidOf(gid) {
    if (!this.gidToCid) return gid;
    return this.gidToCid.get(gid);
  }

  pdfWidth(cid) {
    return this.widthOf.get(cid) ?? this.defaultWidth;
  }

  /**
   * Codes for `text` and its width in thousandths of the font size; throws CannotDraw. Shaped
   * text also gets draw(size): the operators that place each glyph where shaping put it, since
   * the font's /W widths (what viewers advance by) needn't match a shaped run's advances.
   */
  encode(text) {
    let cids = null;
    let placed = null;
    try {
      // Shaped, so scripts such as Devanagari get their conjuncts and vowel signs right.
      const run = this.program.layout(text);
      if (run.glyphs.every((g) => g.id > 0)) {
        cids = run.glyphs.map((g) => this.cidOf(g.id));
        if (cids.some((c) => c === undefined)) cids = null;
        else {
          const scale = 1000 / this.program.unitsPerEm;
          placed = run.positions.map((p) => ({ advance: p.xAdvance * scale, x: p.xOffset * scale, y: p.yOffset * scale }));
        }
      }
    } catch {
      cids = null;
    }
    if (!cids) {
      cids = [];
      for (const char of text) {
        const cid = this.fromUnicode.get(char);
        if (cid === undefined) throw new CannotDraw(`No glyph for U+${char.codePointAt(0).toString(16).toUpperCase()}`);
        cids.push(cid);
      }
      placed = null;
    }
    const hexOf = (cid) => cid.toString(16).padStart(4, '0');
    const hex = cids.map(hexOf).join('');
    if (!placed) return { hex, width: cids.reduce((w, cid) => w + this.pdfWidth(cid), 0) };
    const width = placed.reduce((w, p) => w + p.advance, 0);
    const draw = (size) => {
      // TJ numbers move the next glyph left by thousandths of the font size: each glyph lands
      // at its shaped place (pen + x offset) whatever /W says; a raised glyph gets a text rise.
      const groups = [];
      let pen = 0;
      let at = 0; // where the next glyph would land after TJ's own advances
      cids.forEach((cid, i) => {
        const want = pen + placed[i].x;
        const rise = Math.round(placed[i].y / 1000 * size * 100) / 100;
        let group = groups[groups.length - 1];
        if (!group || group.rise !== rise) {
          group = { rise, items: [] };
          groups.push(group);
        }
        const move = Math.round((at - want) * 100) / 100;
        if (move) group.items.push(String(move));
        group.items.push(`<${hexOf(cid)}>`);
        at = want + this.pdfWidth(cid);
        pen += placed[i].advance;
      });
      const anyRise = groups.some((g) => g.rise);
      return groups.map((g) => `${anyRise ? `${g.rise} Ts ` : ''}[${g.items.join(' ')}] TJ`).join(' ') + (anyRise ? ' 0 Ts' : '');
    };
    return { hex, width, draw };
  }
}

/**
 * The font of font dictionary `dict`, ready to draw a field's text: { encode(text) → { hex, width },
 * metrics: { bboxHeight, capHeight, ascent, descent } } (widths and metrics in thousandths of
 * the font size). Throws CannotDraw for fonts that can't be used (Type3, CJK fonts not carried).
 * Fonts are read once per `cache` (a WeakMap).
 */
export function formFont(ctx, dict, cache) {
  if (cache?.has(dict)) {
    const known = cache.get(dict);
    if (known instanceof Error) throw known;
    return known;
  }
  let font;
  try {
    const subtype = getName(ctx, dict, 'Subtype');
    if (subtype === 'Type3') throw new CannotDraw('Type3 fonts');
    font = subtype === 'Type0' ? new Type0Font(ctx, dict) : new SimpleFont(ctx, dict);
  } catch (e) {
    const error = e instanceof CannotDraw ? e : new CannotDraw(e?.message ?? 'Unreadable font');
    cache?.set(dict, error);
    throw error;
  }
  cache?.set(dict, font);
  return font;
}

/** The width of a standard font's glyph and the font's metrics, for drawing with it directly. */
export function standardMetrics(name) {
  return afm(name);
}
