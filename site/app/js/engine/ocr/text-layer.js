// The invisible, searchable text layer over a page image (PdfOcr.writeTextLayer in the app): each
// word drawn in rendering mode 3 (neither filled nor stroked) with the glyph-less font
// fonts/UsugamiOcr-Regular.ttf, from where its baseline starts, turned to the line's angle, as
// tall as the line and stretched to the word's width. One font covers Latin and Devanagari, so
// Hindi mode keeps English words too. The font has no shaping tables, so the glyphs stay in the
// order the text is read (Devanagari in logical order) and search and copy give back the text.
import {
  beginText, endText, setTextRenderingMode, TextRenderingMode, setFontAndSize, setCharacterSqueeze,
  setCharacterSpacing, setTextMatrix, showText, pushGraphicsState, popGraphicsState, PDFArray,
} from '../../lib/pdf-lib.js';
import fontkit, { create as createFontkitFont } from '../../lib/fontkit.js';
import { UserError } from '../../core/errors.js';
import { ocrFontBytes } from './loader.js';

/** The text is this share of its line's height, as in the app. */
const SIZE_OF_HEIGHT = 0.9;

/** Never smaller than this, in points (the app's minimum). */
const MIN_SIZE = 3;

/** How far text may be stretched or squeezed to its width, as a factor (20 to 200% in the app). */
const MIN_STRETCH = 0.2;
const MAX_STRETCH = 2;

/**
 * A line this close to level (or to a quarter turn), in radians (0.3 degrees), is written exactly
 * so, each word from its own point of the line's baseline. Viewers then keep each word's own
 * stretch on one line; along a tilted line, pdf.js (Firefox's viewer) takes words stretched
 * differently for separate lines, so a tilted line has one stretch for all its words.
 */
const LEVEL = (0.3 * Math.PI) / 180;

/**
 * Each word ends at least this share of the text size before the next word starts: a viewer
 * finding the next word any closer (or overlapping) drops the space between them.
 */
const WORD_GAP = 0.15;

let glyphsPromise = null;

/** The font as fontkit reads it, for knowing which characters it has. */
function ocrGlyphs() {
  if (!glyphsPromise) {
    glyphsPromise = ocrFontBytes().then((bytes) => createFontkitFont(bytes)).catch((e) => {
      glyphsPromise = null;
      throw e;
    });
  }
  return glyphsPromise;
}

/** The OCR font embedded once per document (subset at saving to the glyphs used). */
const embedded = new WeakMap();

function ocrFont(pdfDoc) {
  let entry = embedded.get(pdfDoc);
  if (!entry) {
    entry = (async () => {
      const [bytes, glyphs] = await Promise.all([ocrFontBytes(), ocrGlyphs()]);
      pdfDoc.registerFontkit(fontkit);
      const font = await pdfDoc.embedFont(bytes, { subset: true });
      return { font, glyphs };
    })();
    entry.catch(() => embedded.delete(pdfDoc));
    embedded.set(pdfDoc, entry);
  }
  return entry;
}

/**
 * Characters that are never drawn (joiners, direction marks, the soft hyphen, variation
 * selectors): fontkit writes each as a space, which search and copy would then find, so they are
 * left out. The same list fontkit's layout uses (Unicode's Default_Ignorable_Code_Point, as
 * HarfBuzz has it).
 */
export function isDefaultIgnorable(cp) {
  if (cp >> 16 === 0) {
    switch (cp >> 8) {
      case 0x00: return cp === 0x00ad;
      case 0x03: return cp === 0x034f;
      case 0x06: return cp === 0x061c;
      case 0x17: return cp >= 0x17b4 && cp <= 0x17b5;
      case 0x18: return cp >= 0x180b && cp <= 0x180e;
      case 0x20: return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f);
      case 0xfe: return (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff;
      case 0xff: return cp >= 0xfff0 && cp <= 0xfff8;
      default: return false;
    }
  }
  if (cp >> 16 === 1) return cp >= 0x1bca0 && cp <= 0x1bca3 ? true : cp >= 0x1d173 && cp <= 0x1d17a;
  if (cp >> 16 === 0xe) return true;
  return false;
}

/**
 * `text` as a font can write it (PdfOcr.printable): a character it has no glyph for is written in
 * its compatibility form (NFKC) when the font has that, such as "u" for a mathematical italic u
 * (the font has no characters beyond U+FFFF), or else as a space. Characters that are never drawn
 * are left out (isDefaultIgnorable).
 * @param {string} text
 * @param {(codePoint: number) => boolean} hasGlyph
 * @returns {string}
 * @example printable('① 12 mm \u{1D462}', (cp) => cp < 0x10000) // '① 12 mm u'
 */
export function printable(text, hasGlyph) {
  const writable = (characters) => [...characters].every((c) => hasGlyph(c.codePointAt(0)));
  let out = '';
  for (const character of String(text ?? '')) {
    const cp = character.codePointAt(0);
    if (isDefaultIgnorable(cp)) continue;
    if (writable(character)) {
      out += character;
    } else {
      const compatible = character.normalize('NFKC');
      const usable = compatible !== character && compatible.trim() !== ''
        && [...compatible].every((c) => !isDefaultIgnorable(c.codePointAt(0))) && writable(compatible);
      out += usable ? compatible : ' ';
    }
  }
  return out;
}

/**
 * Turns `placement` into a function from a point of the image (s across, t down, each 0 to 1) to
 * the page, in points from its bottom-left corner: a rectangle { x, y, width, height } in pdf-lib
 * coordinates that the image fills, upright; or an object with toPage(s, t) => [x, y] (the images
 * engine's imagePlacement, for an image drawn turned).
 */
export function pageMapping(placement) {
  if (placement && typeof placement.toPage === 'function') {
    return (s, t) => {
      const p = placement.toPage(s, t);
      return Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y };
    };
  }
  const { x, y, width, height } = placement ?? {};
  if (![x, y, width, height].every(Number.isFinite) || !(width > 0 && height > 0)) {
    throw new TypeError('addTextLayer: placement must be { x, y, width, height } or have toPage()');
  }
  return (s, t) => ({ x: x + s * width, y: y + height - t * height });
}

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const num = (n) => Math.round(n * 1000) / 1000 + 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Adds `recognition`'s text to `page` of `pdfDoc` as an invisible text layer over where the image
 * was read: see docs/api/ocr.md. The page's existing content is wrapped in q/Q first, so nothing
 * it leaves changed moves the text. Returns how many lines were written (lines with nothing the
 * font can write are left out).
 * @param {import('../../lib/pdf-lib.js').PDFDocument} pdfDoc
 * @param {import('../../lib/pdf-lib.js').PDFPage} page
 * @param {object} recognition what recognizer.recognize() returned, or { lines: [{ text, corners }] }
 * @param {{ x: number, y: number, width: number, height: number } | { toPage(s: number, t: number): number[] }} placement
 * @param {number} [imageWidth] pixels across the picture the points are in, when `recognition` has no width
 * @param {number} [imageHeight] pixels down, when `recognition` has no height
 * @returns {Promise<number>}
 */
export async function addTextLayer(pdfDoc, page, recognition, placement, imageWidth, imageHeight) {
  // A Recognition's points are in the pixels of the picture it read, whatever size the PDF keeps
  // the image at; the size given is for lines that come without one.
  const width = recognition?.width > 0 ? recognition.width : imageWidth;
  const height = recognition?.height > 0 ? recognition.height : imageHeight;
  if (!(width > 0 && height > 0)) throw new TypeError('addTextLayer: the image size is missing');
  const toPage = pageMapping(placement);
  const lines = (recognition?.lines ?? []).filter((l) => l && (l.text ?? '').trim() !== '');
  if (!lines.length) return 0;
  let entry;
  try {
    entry = await ocrFont(pdfDoc);
  } catch (e) {
    throw e instanceof UserError ? e : new UserError('ocr_failed');
  }
  const { font, glyphs } = entry;
  const hasGlyph = (cp) => glyphs.hasGlyphForCodePoint(cp);
  const map = (p) => toPage(p.x / width, p.y / height);

  const ops = [];
  let written = 0;
  let key = null;
  const fontKey = () => {
    // Added only when there is text to write, so a page without any keeps its resources as they were.
    if (!key) key = page.node.newFontDictionary('OCR', font.ref);
    return key;
  };
  let stretch = 1;
  let spacing = 0;
  for (const line of lines) {
    const runs = lineRuns(line, map, printableFor(hasGlyph));
    if (!runs) continue;
    const size = Math.max(MIN_SIZE, runs.height * SIZE_OF_HEIGHT);
    const spaceWidth = font.widthOfTextAtSize(' ', size);
    const level = snapToQuarterTurn(runs.angle);
    const angle = level ?? runs.angle;
    const cos = level == null ? Math.cos(angle) : Math.round(Math.cos(angle));
    const sin = level == null ? Math.sin(angle) : Math.round(Math.sin(angle));
    const along = (p, from) => (p.x - from.x) * cos + (p.y - from.y) * sin;
    const words = runs.words.map((w) => ({ ...w, length: Math.max(0, along(w.end, w.start)), width: font.widthOfTextAtSize(w.text, size) }));
    // How far each word may reach: up to a little before the next one starts.
    const room = words.map((w, i) => (i + 1 < words.length ? along(words[i + 1].start, w.start) - WORD_GAP * size : Infinity));
    const fit = (w) => (w.width > 0 ? w.length / w.width : 1);
    const within = (w, i, scale) => {
      const most = w.width > 0 ? room[i] / w.width : Infinity;
      // Where words touch, the space may be lost rather than the word shrunk to nothing.
      return most >= scale * 0.5 ? Math.min(scale, most) : scale;
    };
    let scales;
    if (level != null) {
      scales = words.map((w, i) => within(w, i, fit(w)));
    } else {
      const total = words.reduce((sum, w) => sum + w.width, 0);
      let common = total > 0 ? words.reduce((sum, w) => sum + w.length, 0) / total : 1;
      words.forEach((w, i) => {
        common = within(w, i, common);
      });
      scales = words.map(() => common);
    }
    ops.push(setFontAndSize(fontKey(), num(size)));
    words.forEach((w, i) => {
      const scale = clamp(scales[i], MIN_STRETCH, MAX_STRETCH);
      if (num(scale * 100) !== num(stretch * 100)) ops.push(setCharacterSqueeze(num(scale * 100)));
      stretch = scale;
      if (spacing !== 0) ops.push(setCharacterSpacing(0));
      spacing = 0;
      ops.push(
        setTextMatrix(num(cos), num(sin), num(-sin), num(cos), num(w.start.x), num(w.start.y)),
        showText(font.encodeText(w.text)),
      );
      if (i + 1 < words.length) {
        // A space after the word, as wide as the gap to the next word, so search and copy find
        // one space between them and selecting runs on from one to the next.
        const gap = along(words[i + 1].start, w.start) - w.width * scale;
        spacing = num(gap / scale - spaceWidth);
        if (spacing !== 0) ops.push(setCharacterSpacing(spacing));
        ops.push(showText(font.encodeText(' ')));
      }
    });
    written++;
  }
  if (!written) return 0;
  const content = [
    pushGraphicsState(),
    beginText(),
    setTextRenderingMode(TextRenderingMode.Invisible),
    ...ops,
    endText(),
    popGraphicsState(),
  ];
  const ref = pdfDoc.context.register(pdfDoc.context.contentStream(content));
  // Whatever the page's own content leaves changed (a transformation, say) is undone first, as
  // PDFBox's resetContext does in the app.
  page.node.normalize();
  const contents = page.node.Contents();
  if (contents instanceof PDFArray && contents.size() > 0) {
    page.node.wrapContentStreams(pdfDoc.context.getPushGraphicsStateContentStream(), pdfDoc.context.getPopGraphicsStateContentStream());
  }
  page.node.addContentStream(ref);
  return written;
}

/** `angle` made a whole quarter turn (0, 90, 180 or -90 degrees) when within LEVEL of one; else null. */
export function snapToQuarterTurn(angle) {
  const quarter = Math.PI / 2;
  const nearest = Math.round(angle / quarter) * quarter;
  return Math.abs(angle - nearest) <= LEVEL ? nearest : null;
}

function printableFor(hasGlyph) {
  return (text) => printable(text, hasGlyph);
}

/**
 * Where a line's words go on the page: each word's printable text with the start and end of its
 * baseline, the line's height and its angle, in points and radians. A line without words (as the
 * app's OcrLine) is one run from its bottom-left corner along its top edge, as in the app. Null
 * when nothing is left.
 */
export function lineRuns(line, map, toPrintable) {
  const corners = Array.isArray(line.corners) && line.corners.length === 4 ? line.corners.map(map) : null;
  if (!corners) return null;
  const [topLeft, topRight, , bottomLeft] = corners;
  const height = distance(topLeft, bottomLeft);
  const words = [];
  const sources = Array.isArray(line.words) && line.words.length ? line.words : null;
  if (sources) {
    for (const word of sources) {
      const text = toPrintable(word.text);
      if (text.trim() === '') continue;
      let start;
      let end;
      if (Array.isArray(word.baseline) && word.baseline.length === 2) {
        [start, end] = word.baseline.map(map);
      } else if (Array.isArray(word.corners) && word.corners.length === 4) {
        const c = word.corners.map(map);
        start = c[3];
        end = { x: c[3].x + (c[1].x - c[0].x), y: c[3].y + (c[1].y - c[0].y) };
      } else {
        continue;
      }
      if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) continue;
      words.push({ text, start, end });
    }
  } else {
    // The text starts at the bottom-left corner and runs along the top edge, so a line on a tilted
    // photo gets its real size and angle, not its upright bounds'.
    const text = toPrintable(line.text);
    if (text.trim() !== '') {
      words.push({
        text,
        start: bottomLeft,
        end: { x: bottomLeft.x + (topRight.x - topLeft.x), y: bottomLeft.y + (topRight.y - topLeft.y) },
      });
    }
  }
  if (!words.length || !Number.isFinite(height)) return null;
  // The line's direction: along its baseline, or its top edge.
  let from = topLeft;
  let to = topRight;
  if (Array.isArray(line.baseline) && line.baseline.length === 2) [from, to] = line.baseline.map(map);
  let angle = Math.atan2(to.y - from.y, to.x - from.x);
  if (!Number.isFinite(angle) || (to.x === from.x && to.y === from.y)) {
    angle = Math.atan2(words[0].end.y - words[0].start.y, words[0].end.x - words[0].start.x);
  }
  return { height, words, angle };
}
