// The fonts text is drawn with. The app draws with the phone's fonts; the web app brings its own
// (Noto, in site/app/fonts/) so every device draws the same letters. As in the app (OfficeText.kt's
// OfficeFonts), an Office font such as Calibri or Times New Roman becomes the nearest of these, in
// the same weight and slant, and characters a font lacks (Hindi, for one) come from another font.
// Characters none of them has (Chinese, Japanese, Korean, emoji and others) are drawn by the browser
// (see fallback.js).
import fontkit from '../../lib/fontkit.js';
import { UserError } from '../../core/errors.js';
import { fontHas } from './coverage.js';
import { parseColor, isDark, BLACK, WHITE } from './color.js';

const FONT_DIR = new URL('../../../fonts/', import.meta.url);

/** The font files of each family, by style. Monospace and Hindi have no italics: they are slanted. */
const FILES = {
  sans: { regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf', italic: 'NotoSans-Italic.ttf', boldItalic: 'NotoSans-BoldItalic.ttf' },
  serif: { regular: 'NotoSerif-Regular.ttf', bold: 'NotoSerif-Bold.ttf', italic: 'NotoSerif-Italic.ttf', boldItalic: 'NotoSerif-BoldItalic.ttf' },
  mono: { regular: 'NotoSansMono-Regular.ttf', bold: 'NotoSansMono-Bold.ttf' },
  devaSans: { regular: 'NotoSansDevanagari-Regular.ttf', bold: 'NotoSansDevanagari-Bold.ttf' },
  devaSerif: { regular: 'NotoSerifDevanagari-Regular.ttf', bold: 'NotoSerifDevanagari-Bold.ttf' },
};

/**
 * Each file's metrics per 1000 units of size, so line heights are known before a font is
 * downloaded: ascent, descent (both positive), underline position (negative: below the baseline)
 * and thickness, strikeout position and thickness, cap height, x-height, the width of "0".
 * tests/text.test.mjs checks them against the fonts.
 */
export const FONT_METRICS = {
  'NotoSans-Regular.ttf': [1069, 293, -100, 50, 322, 50, 714, 536, 572],
  'NotoSans-Bold.ttf': [1069, 293, -100, 50, 328, 50, 714, 546, 572],
  'NotoSans-Italic.ttf': [1069, 293, -100, 50, 322, 50, 714, 536, 551],
  'NotoSans-BoldItalic.ttf': [1069, 293, -100, 50, 328, 50, 714, 546, 551],
  'NotoSerif-Regular.ttf': [1069, 293, -100, 50, 322, 50, 714, 536, 559],
  'NotoSerif-Bold.ttf': [1069, 293, -100, 50, 322, 50, 714, 536, 565],
  'NotoSerif-Italic.ttf': [1069, 293, -100, 50, 322, 50, 714, 536, 559],
  'NotoSerif-BoldItalic.ttf': [1069, 293, -100, 50, 322, 50, 714, 536, 565],
  'NotoSansMono-Regular.ttf': [1069, 293, -100, 50, 322, 50, 714, 536, 600],
  'NotoSansMono-Bold.ttf': [1069, 293, -100, 50, 328, 50, 714, 546, 600],
  'NotoSansDevanagari-Regular.ttf': [896, 408, -100, 50, 322, 50, 622, 536, 551],
  'NotoSansDevanagari-Bold.ttf': [896, 408, -100, 50, 322, 50, 622, 536, 567],
  'NotoSerifDevanagari-Regular.ttf': [930, 625, -100, 50, 374, 50, 715, 623, 559],
  'NotoSerifDevanagari-Bold.ttf': [930, 625, -100, 50, 375, 50, 715, 625, 565],
};

/** Every bundled font file text can be drawn with. */
export const FONT_FILES = Object.keys(FONT_METRICS);

/** How far a slanted (synthesized) italic leans: as Android's, a quarter of the height. */
export const ITALIC_SKEW = 0.25;

/** How much narrower the condensed family is drawn than the regular one (Android's Roboto Condensed is about this). */
export const CONDENSED_SCALE = 0.9;

// ---- Office fonts (OfficeText.kt, OfficeFonts) ----

const MONO = ['courier', 'consolas', 'lucida console', 'monaco', 'menlo', 'monospace', 'source code', 'inconsolata', 'cascadia', 'fira code'];
const SERIF = [
  'times', 'cambria', 'georgia', 'garamond', 'palatino', 'book antiqua', 'bookman', 'century', 'baskerville',
  'constantia', 'bodoni', 'didot', 'minion', 'merriweather', 'lora', 'serif', 'perpetua', 'goudy', 'caslon',
  'charter', 'rockwell', 'sylfaen', 'high tower', 'californian', 'cochin', 'hoefler',
];
const SCRIPT = ['script', 'handwriting', 'brush', 'kunstler', 'vivaldi', 'chancery', 'corsiva'];
// "Mono" in a name, written apart or not ("Roboto Mono", "DejaVuSansMono"), but not Monotype's ("Monotype Corsiva").
const MONO_NAME = /mono(?!type)/;

/**
 * The phone's font family closest to the Office font `name`, as the app names them: 'monospace',
 * 'serif', 'cursive', 'casual', 'sans-serif-light', 'sans-serif-condensed' or 'sans-serif'.
 */
export function officeFamily(name, bold = false) {
  const n = String(name ?? '').toLowerCase();
  // Names as PostScript writes them run their words together ("SourceCodePro-Regular").
  const joined = n.replaceAll(' ', '');
  if (MONO.some((m) => joined.includes(m.replaceAll(' ', ''))) || MONO_NAME.test(n)) return 'monospace';
  // Century Gothic and Franklin Gothic are sans fonts, whatever "century" says.
  if (!n.includes('sans') && !n.includes('gothic') && SERIF.some((s) => n.includes(s))) return 'serif';
  if (SCRIPT.some((s) => n.includes(s))) return 'cursive';
  if (n.includes('comic')) return 'casual';
  if (!bold && (n.includes('light') || n.includes('thin'))) return 'sans-serif-light';
  if (n.includes('narrow') || n.includes('condensed')) return 'sans-serif-condensed';
  return 'sans-serif';
}

/**
 * The height of a single-spaced line in the Office font `name`, per point of font size, as Word
 * lays it out. The fonts here have their own heights (the serif one is much taller than Cambria),
 * so lines are scaled to the Office font's, and pages break about where they do in Word.
 */
export function officeLineHeight(name) {
  const n = String(name ?? '').toLowerCase();
  if (n.includes('calibri') || n.includes('verdana') || n.includes('aptos')) return 1.22;
  if (n.includes('segoe')) return 1.33;
  if (n.includes('tahoma') || n.includes('century gothic')) return 1.21;
  if (n.includes('times') || n.includes('arial') || n.includes('helvetica') || n.includes('liberation')) return 1.15;
  if (n.includes('georgia') || n.includes('courier')) return 1.14;
  if (n.includes('garamond')) return 1.12;
  return 1.17;
}

/**
 * Which of the bundled families a family name means: 'sans', 'serif' or 'mono', whether it is
 * always italic (cursive stands in as serif italic, the nearest to a script), and how narrow it is.
 */
export function familyKind(family) {
  const f = String(family ?? 'sans-serif').toLowerCase().trim();
  switch (f) {
    case 'serif': return { kind: 'serif', italic: false, scaleX: 1 };
    case 'monospace': case 'mono': return { kind: 'mono', italic: false, scaleX: 1 };
    case 'cursive': return { kind: 'serif', italic: true, scaleX: 1 };
    case 'sans-serif-condensed': return { kind: 'sans', italic: false, scaleX: CONDENSED_SCALE };
    // casual, sans-serif-light, sans-serif, system-ui and anything else.
    default: return { kind: 'sans', italic: false, scaleX: 1 };
  }
}

/** The font file and whether it is slanted, for one family and style. */
function fileFor(set, bold, italic) {
  if (italic && set.italic) return { file: bold ? set.boldItalic : set.italic, slant: false };
  return { file: bold ? set.bold : set.regular, slant: italic };
}

/**
 * The fonts, in order, that a style's characters are drawn from: its own family first, then
 * Hindi, then any other bundled font with the character (see pickFont). Entries are
 * { file, slant } where slant means the italic is synthesized by leaning the letters.
 */
export function fontStack(style) {
  const { kind, bold, italic } = style;
  const key = `${kind}/${bold ? 1 : 0}${italic ? 1 : 0}`;
  let stack = stacks.get(key);
  if (stack) return stack;
  const own = FILES[kind];
  const deva = kind === 'serif' ? FILES.devaSerif : FILES.devaSans;
  const others = ['sans', 'serif', 'mono'].filter((k) => k !== kind).map((k) => FILES[k]);
  const otherDeva = kind === 'serif' ? FILES.devaSans : FILES.devaSerif;
  stack = [own, deva, ...others, otherDeva].map((set) => fileFor(set, bold, italic));
  stacks.set(key, stack);
  return stack;
}
const stacks = new Map();

// ---- Characters ----

const NO_GLYPH = /^[\s\p{Zs}\p{Zl}\p{Zp}\p{Cc}\p{Cf}]$/u;

/** Spaces, joiners and variation selectors change how text is drawn but have no glyph of their own. */
export function needsGlyph(cp) {
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return false;
  return !NO_GLYPH.test(String.fromCodePoint(cp));
}

const EMOJI_LOOK = /\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\uFE0F|\u20E3/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

/**
 * Whether a cluster (one user-perceived character) is an emoji, drawn in its own colours by the
 * browser. A pictograph asked to look like text (U+2764 alone, or with U+FE0E) is a letter.
 */
export function isEmoji(cluster) {
  if (cluster.includes('\uFE0E')) return false;
  return EMOJI_LOOK.test(cluster) || (cluster.includes('\u200D') && PICTOGRAPH.test(cluster));
}

/**
 * The first font of `stack` that has every character of `cluster` that needs a glyph, else the
 * first with its first such character, else null: the browser draws it then.
 */
export function pickFont(stack, cluster) {
  const cps = [];
  for (const ch of cluster) {
    const cp = ch.codePointAt(0);
    if (needsGlyph(cp)) cps.push(cp);
  }
  if (!cps.length) return stack[0];
  if (isEmoji(cluster)) return null;
  for (const entry of stack) if (cps.every((cp) => fontHas(entry.file, cp))) return entry;
  for (const entry of stack) if (fontHas(entry.file, cps[0])) return entry;
  return null;
}

// ---- Styles (OfficeText.kt, TextStyle) ----

/**
 * A text style with everything worked out: its family and font files, the size drawn (smaller
 * for superscript and small capitals), letter spacing, raise or drop, colours and lines.
 * `style` fields (all optional): font (an Office font name), family ('sans-serif', 'serif',
 * 'monospace', 'cursive', 'casual', 'sans-serif-light', 'sans-serif-condensed'), size (points,
 * default 11), bold, italic, underline (true or 'double'), strike, color, background, baseline
 * (1 superscript, -1 subscript), caps, smallCaps, spacing (extra points between letters), scaleX
 * (width, 1 = as designed), autoColor, link ({ url } or { dest }), features (OpenType, e.g.
 * { liga: false }), lang. `behind` is the shading under the text, for autoColor.
 */
export function resolveStyle(style = {}, behind = null) {
  if (style && style.__resolved) return style;
  const s = style ?? {};
  const size = finite(s.size, 11);
  const baseline = s.baseline === 'super' ? 1 : s.baseline === 'sub' ? -1 : Math.sign(finite(s.baseline, 0));
  const smallCaps = !!s.smallCaps;
  const bold = !!s.bold;
  const family = s.family ?? officeFamily(s.font, bold);
  const fk = familyKind(family);
  const italic = !!s.italic || fk.italic;
  const drawnSize = Math.max(0.1, size * (baseline !== 0 ? 0.65 : smallCaps ? 0.8 : 1));
  const own = parseColor(s.color) ?? BLACK;
  const background = parseColor(s.background);
  const under = background ?? parseColor(behind);
  const color = s.autoColor && under && isDark(under) ? WHITE : own;
  const spacing = finite(s.spacing, 0);
  return {
    __resolved: true,
    font: s.font ?? null,
    family,
    kind: fk.kind,
    size,
    drawnSize,
    bold,
    italic,
    underline: s.underline === 'double' ? 'double' : !!s.underline,
    strike: !!s.strike,
    color,
    background: background && background.a > 0 ? background : null,
    baseline,
    // Raised by a third of the size, or dropped by a seventh, as in the app.
    shift: baseline === 1 ? -size * 0.33 : baseline === -1 ? size * 0.14 : 0,
    caps: !!s.caps,
    smallCaps,
    // Android's letter spacing is in ems of the size drawn.
    letterSpacing: spacing !== 0 && size > 0 ? (spacing / size) * drawnSize : 0,
    scaleX: Math.max(0.01, finite(s.scaleX, 1)) * fk.scaleX,
    link: s.link ?? null,
    features: s.features ?? null,
    lang: s.lang ?? null,
    stack: fontStack({ kind: fk.kind, bold, italic }),
  };
}

function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The style's own (first) font file. */
export function mainFile(style) {
  return resolveStyle(style).stack[0].file;
}

/** Metrics of a font file in ems: { ascent, descent, underlinePosition, underlineThickness, strikePosition, strikeThickness, capHeight, xHeight, digit }. */
export function fileMetrics(file) {
  const m = FONT_METRICS[file];
  if (!m) {
    const loaded = loadedFont(file);
    if (loaded) return loaded.metrics;
    return { ascent: 1.069, descent: 0.293, underlinePosition: -0.1, underlineThickness: 0.05, strikePosition: 0.322, strikeThickness: 0.05, capHeight: 0.714, xHeight: 0.536, digit: 0.572 };
  }
  return {
    ascent: m[0] / 1000, descent: m[1] / 1000, underlinePosition: m[2] / 1000, underlineThickness: m[3] / 1000,
    strikePosition: m[4] / 1000, strikeThickness: m[5] / 1000, capHeight: m[6] / 1000, xHeight: m[7] / 1000, digit: m[8] / 1000,
  };
}

/** The height of a line in the style's own font, per point of font size (OfficeFonts.phoneLineHeight). */
export function phoneLineHeight(style) {
  const m = fileMetrics(mainFile(style));
  const h = m.ascent + m.descent;
  return h > 0.5 ? h : 1.17;
}

/**
 * How much to scale a style's lines so they are as tall as in Office, where single spacing is
 * `officeHeight` per point (OfficeFonts.lineScale): between 0.7 and 1.4.
 */
export function lineScale(style, officeHeight = officeLineHeight(style?.font)) {
  return Math.min(1.4, Math.max(0.7, officeHeight / phoneLineHeight(style)));
}

/** The width of the digit "0" in the style's own font, as a share of its size. */
export function digitWidth(style) {
  const r = resolveStyle(style);
  return fileMetrics(r.stack[0].file).digit * r.scaleX;
}

/**
 * How much wider (or narrower) to draw the style's text so its digits are as wide as the Office
 * font's, whose digits are `officeDigitEm` of its size (SheetUnits.digitEm): 1 when that is
 * unknown, else between 0.75 and 1.25 (XlsxText.kt's widthScale). Use it as the style's scaleX.
 */
export function widthScale(officeDigitEm, style) {
  if (officeDigitEm == null || !(officeDigitEm > 0)) return 1;
  const phone = fileMetrics(resolveStyle(style).stack[0].file).digit;
  return phone > 0 ? Math.min(1.25, Math.max(0.75, officeDigitEm / phone)) : 1;
}

// ---- Loading ----

const loading = new Map();
const loaded = new Map();
let nextId = 1;

/** A font file read with fontkit, with the metrics the layout needs. */
export class LoadedFont {
  constructor(file, fk) {
    this.file = file;
    this.fk = fk;
    this.id = nextId++;
    const upm = fk.unitsPerEm || 1000;
    this.upm = upm;
    const os2 = fk['OS/2'];
    this.metrics = {
      ascent: fk.ascent / upm,
      descent: -fk.descent / upm,
      underlinePosition: (fk.underlinePosition || -upm / 10) / upm,
      underlineThickness: (fk.underlineThickness || upm / 20) / upm,
      strikePosition: (os2?.yStrikeoutPosition || upm * 0.3) / upm,
      strikeThickness: (os2?.yStrikeoutSize || upm / 20) / upm,
      capHeight: (fk.capHeight || fk.ascent * 0.7) / upm,
      xHeight: (fk.xHeight || fk.ascent * 0.5) / upm,
      digit: (fk.glyphForCodePoint(0x30)?.advanceWidth ?? upm / 2) / upm,
    };
    this.postscriptName = String(fk.postscriptName || file.replace(/\.[a-z]+$/i, '')).replace(/[^A-Za-z0-9-]/g, '');
    this.italicAngle = fk.italicAngle || 0;
    this.fixedPitch = !!fk.post?.isFixedPitch || /mono/i.test(file);
    this.serif = /serif/i.test(file);
    this.bold = (os2?.usWeightClass ?? 400) >= 600;
    const b = fk.bbox;
    this.bbox = [b.minX, b.minY, b.maxX, b.maxY].map((v) => (v * 1000) / upm);
    const space = fk.glyphForCodePoint(0x20);
    this.spaceGid = space && space.id ? space.id : 0;
    this.spaceAdvance = (space?.advanceWidth ?? upm / 4) / upm;
    // A glyph without ink: invisible text (see pdffont.js) is drawn with it.
    this.blankGid = space && space.id && !(space.path?.commands?.length) ? space.id : findBlank(fk);
    this.advances = new Map();
    this.paths = new Map();
  }

  /** The advance of glyph `gid`, in ems. */
  advance(gid) {
    let a = this.advances.get(gid);
    if (a === undefined) {
      a = (this.fk.getGlyph(gid)?.advanceWidth ?? 0) / this.upm;
      this.advances.set(gid, a);
    }
    return a;
  }

  /** Whether the font has a glyph for `cp`. */
  has(cp) {
    return this.fk.hasGlyphForCodePoint(cp);
  }

  /** The outline of glyph `gid` as fontkit path commands, in font units (y up). */
  outline(gid) {
    let p = this.paths.get(gid);
    if (!p) {
      p = this.fk.getGlyph(gid)?.path?.commands ?? [];
      this.paths.set(gid, p);
    }
    return p;
  }
}

function findBlank(fk) {
  for (let gid = 1; gid < Math.min(fk.numGlyphs, 10); gid++) {
    const g = fk.getGlyph(gid);
    if (g && !(g.path?.commands?.length)) return gid;
  }
  return 0;
}

/**
 * Loads a bundled font file (fetched once, then cached). Throws UserError('web_fonts_unavailable')
 * when it can't be fetched (offline before the app was saved for offline use, say).
 */
export function loadFont(file) {
  const done = loaded.get(file);
  if (done) return Promise.resolve(done);
  let p = loading.get(file);
  if (!p) {
    p = (async () => {
      let bytes;
      try {
        const res = await fetch(new URL(file, FONT_DIR));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch {
        loading.delete(file);
        throw new UserError('web_fonts_unavailable');
      }
      const font = new LoadedFont(file, fontkit.create(bytes));
      loaded.set(file, font);
      return font;
    })();
    loading.set(file, p);
  }
  return p;
}

/** A font file already loaded, or null. */
export function loadedFont(file) {
  return loaded.get(file) ?? null;
}

/**
 * Loads every font `text` needs in `style` (an object as for resolveStyle, or a list of
 * { text, style } runs). Call it before the synchronous layout functions; the async ones call it.
 */
export async function ensureFonts(text, style) {
  const files = new Set();
  const runs = Array.isArray(text) ? text : [{ text, style }];
  for (const run of runs) {
    const r = resolveStyle(run.style ?? style);
    files.add(r.stack[0].file);
    for (const cluster of graphemes(String(run.text ?? ''))) {
      const entry = pickFont(r.stack, cluster);
      if (entry) files.add(entry.file);
    }
  }
  await Promise.all([...files].map(loadFont));
}

/** Whether every font `text` needs in `style` is loaded. */
export function fontsReady(text, style) {
  const r = resolveStyle(style);
  if (!loaded.has(r.stack[0].file)) return false;
  for (const cluster of graphemes(String(text ?? ''))) {
    const entry = pickFont(r.stack, cluster);
    if (entry && !loaded.has(entry.file)) return false;
  }
  return true;
}

// ---- Clusters ----

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** `text` split into user-perceived characters (grapheme clusters). */
export function graphemes(text) {
  if (!text) return [];
  if (segmenter) {
    const out = [];
    for (const s of segmenter.segment(text)) out.push(s.segment);
    return joinConjuncts(out);
  }
  // Older browsers: a character and the marks and joiners after it.
  return joinConjuncts(text.match(/(?:\r\n|\P{M}(?:\p{M}|\u200D\P{M}?|[\uFE00-\uFE0F])*|\p{M}+)/gsu) ?? []);
}

/** Devanagari letters joined by a virama are one cluster (Unicode 15.1 counts them so; older browsers don't). */
function joinConjuncts(parts) {
  for (let i = parts.length - 1; i > 0; i--) {
    const prev = parts[i - 1];
    if (/[\u0900-\u097F]\u094D[\u200C\u200D]?$/.test(prev) && /^[\u0915-\u0939\u0958-\u095F\u0978-\u097F]/.test(parts[i])) {
      parts.splice(i - 1, 2, prev + parts[i]);
    }
  }
  return parts;
}

// ---- What can be drawn ----

/**
 * The characters (clusters) of `text` that no bundled font has, which the browser draws instead
 * (as pictures, see fallback.js).
 */
export function missingCharacters(text, style) {
  const r = resolveStyle(style);
  const out = [];
  for (const cluster of graphemes(String(text ?? ''))) {
    if (!pickFont(r.stack, cluster)) out.push(cluster);
  }
  return out;
}
