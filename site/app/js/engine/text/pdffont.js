// Fonts embedded in a PDF as Type 0 (CID) fonts with only the glyphs drawn (a subset), as Android's
// PDF backend embeds them. Codes aren't glyph numbers: each (glyph, text, width) drawn gets its own
// code, mapped to the glyph by CIDToGIDMap and to its text by ToUnicode, so the same glyph can
// stand for different text where shaping reorders or joins letters (see shaping.js), and invisible
// text can be given any width (over pictures of characters the fonts lack, see canvas.js).
import { PDFString } from '../../lib/pdf-lib.js';
import { docState } from './docstate.js';

const MAX_CODES = 0xfffe;

/** The font `font` (a LoadedFont) as embedded in `doc`, made on first use. */
export function embeddedFont(doc, font) {
  const s = docState(doc);
  let f = s.fonts.get(font.id);
  if (!f) {
    f = new EmbeddedFont(doc, font, s);
    s.fonts.set(font.id, f);
  }
  return f;
}

class EmbeddedFont {
  constructor(doc, font, state) {
    this.doc = doc;
    this.font = font;
    const ctx = doc.context;
    this.ctx = ctx;
    this.ref = ctx.nextRef();
    this.refs = { cid: ctx.nextRef(), desc: ctx.nextRef(), file: ctx.nextRef(), toUnicode: ctx.nextRef(), map: ctx.nextRef() };
    this.codes = new Map();
    this.gids = [0];
    this.widths = [0];
    this.texts = [null];
    this.subset = font.fk.createSubset();
    this.tag = subsetTag(++state.tags, font.postscriptName);
    this.written = 0;
    // Another font object takes over when one runs out of codes (a very long document in many scripts).
    this.next = null;
  }

  /**
   * The code to draw glyph `gid` with, standing for `text`, `width` thousandths of an em wide
   * (default: the glyph's own advance). Returns { font: the EmbeddedFont to use, code, width }.
   */
  code(gid, text, width) {
    const w = width == null ? Math.round(this.font.advance(gid) * 100000) / 100 : Math.round(width * 100) / 100;
    const key = `${gid}|${w}|${text}`;
    const known = this.codes.get(key);
    if (known) return { font: this, code: known, width: w };
    if (this.gids.length > MAX_CODES) {
      if (!this.next) {
        this.next = new EmbeddedFont(this.doc, this.font, docState(this.doc));
        docState(this.doc).fonts.set(`${this.font.id}+${this.next.tag}`, this.next);
      }
      return this.next.code(gid, text, width);
    }
    const code = this.gids.length;
    this.gids.push(this.subset.includeGlyph(gid));
    this.widths.push(w);
    this.texts.push(text);
    this.codes.set(key, code);
    return { font: this, code, width: w };
  }

  /** Writes (or writes again, with the glyphs added since) the font's objects into the PDF. */
  write() {
    if (this.written === this.gids.length) return;
    this.written = this.gids.length;
    const ctx = this.ctx;
    const f = this.font;
    const bytes = this.subset.encode();
    const fontFile = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const name = `${this.tag}+${f.postscriptName}`;
    const n = this.gids.length;
    // CIDToGIDMap: two bytes per code, the glyph's number in the subset.
    const map = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      map[2 * i] = this.gids[i] >> 8;
      map[2 * i + 1] = this.gids[i] & 255;
    }
    const m = f.metrics;
    let flags = 4;
    if (f.fixedPitch) flags |= 1;
    if (f.serif) flags |= 2;
    if (f.italicAngle) flags |= 64;
    ctx.assign(this.refs.file, ctx.flateStream(fontFile, { Length1: fontFile.length }));
    ctx.assign(this.refs.desc, ctx.obj({
      Type: 'FontDescriptor',
      FontName: name,
      Flags: flags,
      FontBBox: f.bbox.map(Math.round),
      ItalicAngle: f.italicAngle,
      Ascent: Math.round(m.ascent * 1000),
      Descent: -Math.round(m.descent * 1000),
      CapHeight: Math.round(m.capHeight * 1000),
      XHeight: Math.round(m.xHeight * 1000),
      StemV: f.bold ? 140 : 80,
      FontFile2: this.refs.file,
    }));
    ctx.assign(this.refs.map, ctx.flateStream(map));
    ctx.assign(this.refs.toUnicode, ctx.flateStream(toUnicodeCMap(this.texts)));
    ctx.assign(this.refs.cid, ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: name,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: this.refs.desc,
      DW: 0,
      W: [1, this.widths.slice(1)],
      CIDToGIDMap: this.refs.map,
    }));
    ctx.assign(this.ref, ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: name,
      Encoding: 'Identity-H',
      DescendantFonts: [this.refs.cid],
      ToUnicode: this.refs.toUnicode,
    }));
  }
}

/** Six capital letters marking a subset (PDF's "ABCDEF+Name"), different for each font in a PDF. */
function subsetTag(n, name) {
  let h = 2166136261 ^ n;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (n * 7919), 2246822507) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + n * 31 + i * 17;
  }
  return tag;
}

function hex4(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

/** UTF-16BE of `s` in hex. */
export function utf16Hex(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i));
  return out;
}

function toUnicodeCMap(texts) {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  const entries = [];
  for (let i = 1; i < texts.length; i++) {
    const t = texts[i];
    if (t) entries.push(`<${hex4(i)}> <${utf16Hex(t)}>`);
  }
  for (let i = 0; i < entries.length; i += 100) {
    const block = entries.slice(i, i + 100);
    lines.push(`${block.length} beginbfchar`, ...block, 'endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}
