// Characters none of the bundled fonts has (Chinese, Japanese, Korean, emoji, Arabic, Thai and
// others) are drawn by the browser with the device's own fonts, into a picture placed in the line
// like a letter, so they still show. The PDF keeps their text too, as invisible text over the
// picture (see canvas.js), so they can still be searched and copied.

import { resolveStyle, missingCharacters } from './fonts.js';

const CSS_FAMILY = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' };
const MEASURE_PX = 100;

let shared = null;

/** A small 2D canvas for measuring and drawing, or null where the browser has none (a worker without OffscreenCanvas). */
function scratch(width = 8, height = 8) {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      return c;
    }
  } catch {
    // No canvas: nothing can be drawn.
  }
  return null;
}

function measurer() {
  if (shared) return shared;
  const canvas = scratch();
  shared = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;
  return shared;
}

function cssFont(px, kind, bold, italic) {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px ${CSS_FAMILY[kind] ?? 'sans-serif'}`;
}

const metricsCache = new Map();

/**
 * How the browser draws `text` (characters of one style without a bundled font): its advance,
 * the font's ascent and descent, and its ink, all in ems; null when the browser can't draw here.
 */
export function fallbackMetrics(text, kind, bold, italic, rtl = false) {
  const key = `${kind}${bold ? 1 : 0}${italic ? 1 : 0}${rtl ? 1 : 0}\u0001${text}`;
  if (metricsCache.has(key)) return metricsCache.get(key);
  const ctx = measurer();
  let m = null;
  if (ctx) {
    ctx.font = cssFont(MEASURE_PX, kind, bold, italic);
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const t = ctx.measureText(text);
    const inkA = t.actualBoundingBoxAscent ?? MEASURE_PX * 0.88;
    const inkD = t.actualBoundingBoxDescent ?? MEASURE_PX * 0.12;
    m = {
      width: t.width / MEASURE_PX,
      ascent: (Number.isFinite(t.fontBoundingBoxAscent) ? t.fontBoundingBoxAscent : Math.max(inkA, MEASURE_PX * 0.88)) / MEASURE_PX,
      descent: (Number.isFinite(t.fontBoundingBoxDescent) ? t.fontBoundingBoxDescent : Math.max(inkD, MEASURE_PX * 0.12)) / MEASURE_PX,
      inkLeft: -(t.actualBoundingBoxLeft ?? 0) / MEASURE_PX,
      inkRight: (t.actualBoundingBoxRight ?? t.width) / MEASURE_PX,
      inkTop: inkA / MEASURE_PX,
      inkBottom: inkD / MEASURE_PX,
    };
  }
  if (metricsCache.size > 5000) metricsCache.clear();
  metricsCache.set(key, m);
  return m;
}

const bitmapCache = new Map();

/**
 * `text` drawn by the browser at `pxPerEm` pixels per em: { width, height (pixels), rgba
 * (Uint8ClampedArray), left, top (where the origin is in it, in ems from its top-left corner),
 * emoji } or null when there is no ink. Emoji keep their colours; other text is drawn black, and
 * only its coverage (alpha) is used, so any colour can be put on it.
 */
export function fallbackBitmap(text, kind, bold, italic, rtl, pxPerEm, emoji) {
  const key = `${kind}${bold ? 1 : 0}${italic ? 1 : 0}${rtl ? 1 : 0}${emoji ? 1 : 0}/${pxPerEm}\u0001${text}`;
  if (bitmapCache.has(key)) return bitmapCache.get(key);
  const m = fallbackMetrics(text, kind, bold, italic, rtl);
  let out = null;
  if (m) {
    const pad = 2;
    const left = Math.max(0, -m.inkLeft) * pxPerEm;
    const w = Math.ceil((Math.max(m.inkRight, m.width) - Math.min(0, m.inkLeft)) * pxPerEm) + 2 * pad;
    const top = Math.max(m.inkTop, 0) * pxPerEm;
    const h = Math.ceil((Math.max(m.inkTop, 0) + Math.max(m.inkBottom, 0)) * pxPerEm) + 2 * pad;
    if (w > 2 * pad && h > 2 * pad && w < 16384 && h < 16384) {
      const canvas = scratch(w, h);
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.font = cssFont(pxPerEm, kind, bold, italic);
        ctx.direction = rtl ? 'rtl' : 'ltr';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#000';
        ctx.fillText(text, pad + left, pad + top);
        const data = ctx.getImageData(0, 0, w, h).data;
        let ink = false;
        for (let i = 3; i < data.length; i += 4) if (data[i]) { ink = true; break; }
        if (ink) out = { key, width: w, height: h, rgba: data, left: (pad + left) / pxPerEm, top: (pad + top) / pxPerEm, emoji: !!emoji, pxPerEm };
      }
    }
  }
  // Kept to about 48 MB of pixels: a long Chinese document draws thousands of different characters.
  cachedBytes += out ? out.rgba.length : 0;
  if (cachedBytes > 48e6) {
    bitmapCache.clear();
    cachedBytes = out ? out.rgba.length : 0;
  }
  bitmapCache.set(key, out);
  return out;
}
let cachedBytes = 0;

/**
 * Pixels per em to draw text of `size` points at, sharp at any zoom a reader would use: text sizes
 * as 1-bit masks (small in the PDF; viewers smooth them as they scale them down), large sizes and
 * emoji with smooth edges.
 */
export function fallbackResolution(size, mask = false) {
  if (mask) return size <= 24 ? 160 : 240;
  return size <= 16 ? 96 : size <= 48 ? 192 : 384;
}

/** Whether text of `size` points (as drawn) without colours of its own goes into the PDF as a 1-bit mask. */
export function usesMask(size, emoji) {
  return !emoji && size <= 48;
}

const drawable = new Map();

// Characters no font has: noncharacters and the last private-use code points, in the first plane
// and beyond. Chromium and WebKit on Windows draw every missing character as the same box. Firefox
// draws a box with the character's code in hex inside (four digits in the first plane, six beyond,
// in boxes that can differ in width), and Safari on Apple devices the Last Resort font's box for
// the character's block: those boxes differ inside, but have the advance, the size and the frame
// of one of these.
const NO_FONT = ['\u{FDD0}', '\u{FFFF}', '\u{1FFFE}', '\u{10FFFD}', '\u{FFFFD}'];
// Characters drawn on their own, unlike marks, joiners and selectors, which change the character
// before them: in a cluster, each of these is checked alone too.
const STANDS_ALONE = /^[\p{L}\p{N}\p{S}\p{P}\p{Co}\p{Cn}]$/u;
const BOX_PX = 40;
const missingBoxes = new Map();

/**
 * Whether the browser has a font for `cluster`: it draws it, and not as the box a missing
 * character gets. As in the app (WatermarkText.canDraw), each character of the cluster that is
 * drawn on its own must have a glyph too. Assumed true where nothing can be measured.
 */
export function browserCanDraw(cluster, kind = 'sans') {
  const key = kind + '\u0001' + cluster;
  if (drawable.has(key)) return drawable.get(key);
  const ctx = measurer();
  let ok = true;
  if (ctx) {
    ok = !looksMissing(ctx, cluster, kind);
    const parts = [...cluster];
    // A missing letter with a mark over it, or among others, doesn't look like the box alone.
    if (ok && parts.length > 1) ok = parts.every((ch) => !STANDS_ALONE.test(ch) || browserCanDraw(ch, kind));
  }
  if (drawable.size > 5000) drawable.clear();
  drawable.set(key, ok);
  return ok;
}

/** Whether `text` draws nothing, or the box a missing character gets. */
function looksMissing(ctx, text, kind) {
  const mine = drawn(ctx, text, kind);
  if (!mine) return true;
  for (const box of boxesFor(ctx, kind)) {
    if (sameAlpha(box.alpha, mine.alpha)) return true;
    if (box.framed && sameFrame(box, mine)) return true;
  }
  return false;
}

/** The boxes this browser draws for characters no font has, in `kind`'s font; measured once. */
function boxesFor(ctx, kind) {
  let boxes = missingBoxes.get(kind);
  if (!boxes) {
    boxes = [];
    for (const ch of NO_FONT) {
      const box = drawn(ctx, ch, kind);
      if (!box) continue;
      box.framed = framed(box);
      if (box.framed) box.edge = edge(box);
      boxes.push(box);
    }
    missingBoxes.set(kind, boxes);
  }
  return boxes;
}

/**
 * `text` drawn at BOX_PX pixels per em: { alpha (coverage, a byte a pixel), size (the square's
 * side), advance, bounds ([left, top, right, bottom], the pixels with ink, inclusive) }, or null
 * without ink.
 */
function drawn(ctx, text, kind) {
  const size = 2 * BOX_PX;
  const canvas = ctx.canvas;
  if (canvas.width < size || canvas.height < size) {
    canvas.width = size;
    canvas.height = size;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = cssFont(BOX_PX, kind, false, false);
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  ctx.fillText(text, 4, BOX_PX * 1.3);
  const advance = ctx.measureText(text).width;
  const data = ctx.getImageData(0, 0, size, size).data;
  const alpha = new Uint8Array(size * size);
  let left = size;
  let top = size;
  let right = -1;
  let bottom = -1;
  for (let i = 0; i < alpha.length; i++) {
    const a = data[i * 4 + 3];
    alpha[i] = a;
    if (!a) continue;
    const x = i % size;
    const y = (i - x) / size;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    bottom = y;
  }
  return right < 0 ? null : { alpha, size, advance, bounds: [left, top, right, bottom] };
}

/** The pixels along the edge of `box`'s ink, where a box drawn for a missing character has its frame. */
function edge(box) {
  const [left, top, right, bottom] = box.bounds;
  const at = [];
  for (let x = left; x <= right; x++) at.push(top * box.size + x, bottom * box.size + x);
  for (let y = top + 1; y < bottom; y++) at.push(y * box.size + left, y * box.size + right);
  return at;
}

/** Whether `box` is a frame: ink along most of each side of its bounds (not a filled or bare shape). */
function framed(box) {
  const [left, top, right, bottom] = box.bounds;
  // Too small to tell a frame from a stroke.
  if (right - left < 4 || bottom - top < 4) return false;
  const inked = (from, step, count) => {
    let n = 0;
    for (let i = 0; i < count; i++) if (box.alpha[from + i * step]) n++;
    return n >= 0.6 * count;
  };
  const w = right - left + 1;
  const h = bottom - top + 1;
  return inked(top * box.size + left, 1, w) && inked(bottom * box.size + left, 1, w)
    && inked(top * box.size + left, box.size, h) && inked(top * box.size + right, box.size, h);
}

/**
 * Whether `mine` is drawn as `box` is but for what its frame holds: the same advance, ink in
 * exactly the same place and the same frame. No real glyph matches a missing box that closely.
 */
function sameFrame(box, mine) {
  if (Math.abs(box.advance - mine.advance) > 0.01) return false;
  if (box.bounds.some((v, i) => v !== mine.bounds[i])) return false;
  // A little leeway for edges smoothed on the graphics card.
  return box.edge.every((i) => Math.abs(box.alpha[i] - mine.alpha[i]) <= 8);
}

function sameAlpha(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Whether every character of `text` can be drawn in `style`: by a bundled font, or else by the
 * browser (WatermarkText.canDraw: the watermark and Edit PDF's text say so when it can't).
 */
export function canDraw(text, style = {}) {
  const r = resolveStyle(style);
  for (const cluster of missingCharacters(String(text ?? ''), r)) {
    if (!browserCanDraw(cluster, r.kind)) return false;
  }
  return true;
}
