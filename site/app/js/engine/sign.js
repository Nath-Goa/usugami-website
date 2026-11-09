// Sign PDF: a signature drawn by hand goes on a page as a picture with a see-through background,
// exactly where the preview put it on the page as it is shown (turned, cropped). A port of the
// app's Signature.kt (the drawing and its picture), core/SignatureLayout.kt (where it goes, how
// big) and PdfToolsEngine.sign. It is a picture of a handwritten signature, never a certified
// digital one. No UI here: the screen is js/tools/sign/.
import { loadPdf, savePdf } from './pdf-common.js';
import { PDFName, PDFDict, PDFArray, PDFStream, PDFRef, PDFNumber } from '../lib/pdf-lib.js';
import { UserError, PasswordError, CancelledError, checkCancelled } from '../core/errors.js';
import { sanitizeName } from '../core/names.js';
import { yieldToUI } from '../core/dom.js';

// -----------------------------------------------------------------------------------------------
// SignatureLayout.kt

/**
 * The pad is PAD_WIDTH by PAD_HEIGHT units; strokes are kept in these units, so a drawing keeps
 * its place whatever size the pad is shown at. The pen is PEN_WIDTH units wide (about 3 dp on a
 * pad as wide as a phone).
 */
export const PAD_WIDTH = 1000;
export const PAD_HEIGHT = 500;
export const PEN_WIDTH = 9;

/** The smallest a signature gets, in points: half an inch on its longer side. */
export const MIN_SIDE_POINTS = 36;
/** A new signature is this share of the page's shorter side wide (2.6 inches on A4)… */
export const DEFAULT_WIDTH = 0.32;
/** …unless that makes it taller than this share of the page… */
export const DEFAULT_MAX_HEIGHT = 0.12;
/** …and it sits this share of the shorter side from the bottom and right edges. */
export const DEFAULT_MARGIN = 0.08;
/** The picture's resolution, sharp in print… */
export const DPI = 300;
/** …but never more pixels than this on its longer side. */
export const MAX_PIXELS = 2400;

/** Points closer together than this, in pad units, are dropped while drawing (Signature.MIN_STEP). */
export const MIN_STEP = 2;
/** More points than this are ignored: a signature never needs them (Signature.MAX_POINTS). */
export const MAX_POINTS = 5000;

/** The inks, as ARGB (SignatureInk): black, and the blue of a ballpoint pen. */
export const INKS = Object.freeze({ black: 0xff000000, blue: 0xff1a3c9c });

/** An ink's colour as CSS ('#1a3c9c'). */
export function inkColor(ink) {
  const argb = INKS[ink] ?? INKS.black;
  return '#' + (argb & 0xffffff).toString(16).padStart(6, '0');
}

/** The point at `t` of the quadratic curve from `start` to `end` bending towards `control`, on one axis. */
function quadratic(start, control, end, t) {
  return (1 - t) * (1 - t) * start + 2 * t * (1 - t) * control + t * t * end;
}

/** Where that curve turns back on this axis, if it does strictly between its ends. */
function turn(start, control, end) {
  const bend = start - 2 * control + end;
  if (bend === 0) return null;
  const t = (start - control) / bend;
  return t > 0 && t < 1 ? t : null;
}

/**
 * What `strokes` cover in pad units (y down), the pen's width included: { x, y, width, height },
 * or null without a point. Each stroke is its points' coordinates in turn: x0, y0, x1, y1, …
 * The pen follows the smoothed curve (see traceSignature), whose own extremes are measured, so
 * the picture is trimmed to the ink.
 */
export function inkBounds(strokes, penWidth = PEN_WIDTH) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x, y) => {
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  };
  for (const s of strokes ?? []) {
    const count = s.length >> 1;
    if (count === 0) continue;
    let startX = s[0];
    let startY = s[1];
    include(startX, startY);
    for (let i = 1; i < count - 1; i++) {
      const controlX = s[2 * i];
      const controlY = s[2 * i + 1];
      const endX = (controlX + s[2 * i + 2]) / 2;
      const endY = (controlY + s[2 * i + 3]) / 2;
      include(endX, endY);
      for (const t of [turn(startX, controlX, endX), turn(startY, controlY, endY)]) {
        if (t != null) include(quadratic(startX, controlX, endX, t), quadratic(startY, controlY, endY, t));
      }
      startX = endX;
      startY = endY;
    }
    include(s[2 * count - 2], s[2 * count - 1]);
  }
  if (left > right) return null;
  return { x: left - penWidth / 2, y: top - penWidth / 2, width: right - left + penWidth, height: bottom - top + penWidth };
}

function positive(...values) {
  if (!values.every((v) => Number.isFinite(v) && v > 0)) throw new RangeError('Sizes must be positive');
}

/**
 * The widths, as shares of the page's width, that a signature of `aspect` (width over height) can
 * have on a page `shownWidth` × `shownHeight` points as shown: [smallest, largest], from half an
 * inch on its longer side up to as big as the page.
 */
export function widthRange(shownWidth, shownHeight, aspect) {
  positive(shownWidth, shownHeight, aspect);
  const most = Math.min(1, (shownHeight * aspect) / shownWidth);
  return [Math.min((MIN_SIDE_POINTS * Math.min(1, aspect)) / shownWidth, most), most];
}

/** The signature's height as a share of the page's height when it is `width` of its width. */
export function heightShare(width, shownWidth, shownHeight, aspect) {
  return (width * shownWidth) / aspect / shownHeight;
}

/** `placement` with its width in widthRange, moved as little as needed to be wholly on the page. */
export function clampPlacement(placement, shownWidth, shownHeight, aspect) {
  const [least, most] = widthRange(shownWidth, shownHeight, aspect);
  const coerce = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : (lo + hi) / 2));
  const width = coerce(placement.width, least, most);
  const height = Math.min(1, heightShare(width, shownWidth, shownHeight, aspect));
  return {
    centerX: coerce(placement.centerX, width / 2, 1 - width / 2),
    centerY: coerce(placement.centerY, height / 2, 1 - height / 2),
    width,
  };
}

/** Where a signature starts out: in the lower right of the page, about as big as a real one. */
export function defaultPlacement(shownWidth, shownHeight, aspect) {
  positive(shownWidth, shownHeight, aspect);
  const shorter = Math.min(shownWidth, shownHeight);
  const width = Math.min(DEFAULT_WIDTH * shorter, DEFAULT_MAX_HEIGHT * shownHeight * aspect);
  const height = width / aspect;
  const margin = DEFAULT_MARGIN * shorter;
  return clampPlacement({
    centerX: (shownWidth - margin - width / 2) / shownWidth,
    centerY: (shownHeight - margin - height / 2) / shownHeight,
    width: width / shownWidth,
  }, shownWidth, shownHeight, aspect);
}

/**
 * Where the PDF draws the signature: { x, y, width, height } in points on the page as shown,
 * from its bottom-left corner with y up; x and y are the signature's bottom-left corner.
 */
export function pdfArea(placement, shownWidth, shownHeight, aspect) {
  const width = placement.width * shownWidth;
  const height = width / aspect;
  return { x: placement.centerX * shownWidth - width / 2, y: (1 - placement.centerY) * shownHeight - height / 2, width, height };
}

/** The picture's size in pixels, [width, height], for a signature `widthPoints` × `heightPoints` big. */
export function pixels(widthPoints, heightPoints) {
  positive(widthPoints, heightPoints);
  const perPoint = Math.min(DPI / 72, MAX_PIXELS / Math.max(widthPoints, heightPoints));
  return [Math.max(1, Math.round(widthPoints * perPoint)), Math.max(1, Math.round(heightPoints * perPoint))];
}

// -----------------------------------------------------------------------------------------------
// Signature.kt

/** Each signature's ink bounds, worked out once. */
const measured = new WeakMap();

/**
 * A signature drawn by hand: `strokes` in pad units, each its points' coordinates in turn
 * (x0, y0, x1, y1, …), in `ink` ('black' or 'blue'). Immutable. The screen keeps one in memory
 * for the visit only; it is only ever written to a file inside a signed PDF.
 */
export class Signature {
  constructor(strokes = [], ink = 'black') {
    this.strokes = Object.freeze((strokes ?? []).map((s) => Object.freeze(Array.from(s ?? [], Number).filter(Number.isFinite))));
    this.ink = Object.hasOwn(INKS, ink) ? ink : 'black';
    Object.freeze(this);
  }

  /** What the strokes cover, the pen included ({ x, y, width, height }); null while nothing is drawn. */
  get bounds() {
    if (!measured.has(this)) measured.set(this, inkBounds(this.strokes));
    return measured.get(this);
  }

  get isEmpty() {
    return this.strokes.every((s) => s.length < 2);
  }

  /** Width over height of what is drawn (1 while nothing is). */
  get aspect() {
    const b = this.bounds;
    return b ? b.width / b.height : 1;
  }

  get pointCount() {
    return this.strokes.reduce((n, s) => n + (s.length >> 1), 0);
  }

  /** This signature with one more stroke. */
  plus(stroke) {
    return new Signature([...this.strokes, stroke], this.ink);
  }

  withInk(ink) {
    return new Signature(this.strokes, ink);
  }

  cleared() {
    return new Signature([], this.ink);
  }

  toJSON() {
    return { strokes: this.strokes.map((s) => [...s]), ink: this.ink };
  }

  /** A Signature from one, or from a plain { strokes, ink } (null for nothing). */
  static from(value) {
    if (value instanceof Signature) return value;
    if (!value || typeof value !== 'object') return null;
    return new Signature(Array.isArray(value.strokes) ? value.strokes : [], value.ink);
  }
}

/** Whether a stroke is a dot: one point, or the same point over and over. */
function isDot(s) {
  for (let i = 2; i + 1 < s.length; i += 2) if (s[i] !== s[0] || s[i + 1] !== s[1]) return false;
  return true;
}

/**
 * Traces the smooth curve along `strokes` onto `target` (a canvas context or a Path2D): from each
 * stroke's first point it bends through each point in turn to the midpoint between it and the
 * next, then goes straight to the last point (Signature.smoothPath; inkBounds measures this
 * curve). Dots (one-point strokes) aren't traced: they are returned as [x, y], to be drawn as
 * round as the pen's end, which canvases don't all do for a line of no length.
 */
export function traceSignature(target, strokes) {
  const dots = [];
  for (const s of strokes) {
    const count = s.length >> 1;
    if (count === 0) continue;
    if (isDot(s)) {
      dots.push([s[0], s[1]]);
      continue;
    }
    target.moveTo(s[0], s[1]);
    for (let i = 1; i < count - 1; i++) {
      const x = s[2 * i];
      const y = s[2 * i + 1];
      target.quadraticCurveTo(x, y, (x + s[2 * i + 2]) / 2, (y + s[2 * i + 3]) / 2);
    }
    target.lineTo(s[2 * count - 2], s[2 * count - 1]);
  }
  return dots;
}

/**
 * Draws `strokes` on a 2D canvas context, in pad units (set the context's transform first), with
 * the pen: PEN_WIDTH wide, round ends and joins, in `color` (CSS).
 */
export function drawSignature(ctx, strokes, color) {
  ctx.save();
  ctx.lineWidth = PEN_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.beginPath();
  const dots = traceSignature(ctx, strokes);
  ctx.stroke();
  if (dots.length) {
    ctx.beginPath();
    for (const [x, y] of dots) {
      ctx.moveTo(x + PEN_WIDTH / 2, y);
      ctx.arc(x, y, PEN_WIDTH / 2, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

const num = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

/**
 * The signature as SVG path data in pad units: `line` for the strokes (draw it with
 * stroke-width PEN_WIDTH, round caps and joins) and `dots` for the dots (fill it).
 */
export function signaturePathData(strokes) {
  const parts = [];
  const target = {
    moveTo: (x, y) => parts.push(`M${num(x)} ${num(y)}`),
    quadraticCurveTo: (cx, cy, x, y) => parts.push(`Q${num(cx)} ${num(cy)} ${num(x)} ${num(y)}`),
    lineTo: (x, y) => parts.push(`L${num(x)} ${num(y)}`),
  };
  const dots = traceSignature(target, strokes);
  const r = PEN_WIDTH / 2;
  const dotData = dots.map(([x, y]) => `M${num(x - r)} ${num(y)}a${r} ${r} 0 1 0 ${PEN_WIDTH} 0a${r} ${r} 0 1 0 ${-PEN_WIDTH} 0z`).join('');
  return { line: parts.join(''), dots: dotData };
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/**
 * The signature as a picture `width` pixels wide, trimmed to what is drawn (Signature.render):
 * { width, height, alpha } with `alpha` one byte per pixel saying how much ink is there. Every
 * pixel has the ink's colour; only the alpha draws the strokes, so nothing darkens the edges.
 */
export function renderSignature(signature, width) {
  const sig = Signature.from(signature);
  const ink = sig?.bounds;
  if (!ink) throw new RangeError('Nothing drawn');
  width = Math.max(1, Math.round(width));
  const scale = width / ink.width;
  const height = Math.max(1, Math.round(ink.height * scale));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No canvas');
  ctx.setTransform(scale, 0, 0, scale, -ink.x * scale, -ink.y * scale);
  drawSignature(ctx, sig.strokes, '#000000');
  const data = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = data[j];
  if (canvas.width) {
    // Let the browser free the pixels at once.
    canvas.width = 0;
    canvas.height = 0;
  }
  return { width, height, alpha };
}

// -----------------------------------------------------------------------------------------------
// The page as a viewer shows it (PageFrame in PageStamps.kt), read the way pdf.js reads it, so the
// preview (drawn by pdf.js) and the signed page agree.

const N = (k) => PDFName.of(k);
const LETTER = [0, 0, 612, 792];

function lookup(ctx, v) {
  return v instanceof PDFRef ? ctx.lookup(v) : v;
}

/** An inheritable entry of a page (MediaBox, CropBox, Rotate, Resources): the nearest one. */
function inherited(ctx, node, key) {
  let d = node;
  for (let depth = 0; d instanceof PDFDict && depth < 100; depth++) {
    const v = d.get(N(key));
    if (v !== undefined) return lookup(ctx, v);
    d = lookup(ctx, d.get(N('Parent')));
  }
  return undefined;
}

/** A box entry, normalized ([left, bottom, right, top]), or null when missing, malformed or empty. */
function boxOf(ctx, node, key) {
  const a = inherited(ctx, node, key);
  if (!(a instanceof PDFArray) || a.size() !== 4) return null;
  const n = [];
  for (let i = 0; i < 4; i++) {
    const v = lookup(ctx, a.get(i));
    if (!(v instanceof PDFNumber) || !Number.isFinite(v.asNumber())) return null;
    n.push(v.asNumber());
  }
  const box = [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
  return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null;
}

/**
 * Page `index` of a pdf-lib document as a viewer shows it: its crop box (within its media box)
 * turned clockwise by its /Rotate. Returns { left, bottom, width, height, rotation, shownWidth,
 * shownHeight, matrix } where matrix [a, b, c, d, e, f] (as for a PDF `cm`) takes points on the
 * page as shown (origin at its bottom-left corner, y up) to the page's own coordinates.
 */
export function pageFrame(doc, index) {
  const ctx = doc.context;
  const node = doc.getPage(index).node;
  const media = boxOf(ctx, node, 'MediaBox') ?? LETTER;
  const crop = boxOf(ctx, node, 'CropBox');
  let view = media;
  if (crop) {
    const box = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])];
    if (box[2] - box[0] > 0 && box[3] - box[1] > 0) view = box;
  }
  const r = inherited(ctx, node, 'Rotate');
  let rotation = r instanceof PDFNumber ? r.asNumber() : 0;
  rotation = Number.isFinite(rotation) && rotation % 90 === 0 ? ((rotation % 360) + 360) % 360 : 0;
  return frameOf(view[0], view[1], view[2] - view[0], view[3] - view[1], rotation);
}

/** A PageFrame from its crop box and rotation (0, 90, 180 or 270). */
export function frameOf(left, bottom, width, height, rotation) {
  const sideways = rotation === 90 || rotation === 270;
  let matrix;
  if (rotation === 0) matrix = [1, 0, 0, 1, left, bottom];
  // The shown bottom-left corner is the box's bottom-right corner, and shown x runs up the page.
  else if (rotation === 90) matrix = [0, 1, -1, 0, left + width, bottom];
  else if (rotation === 180) matrix = [-1, 0, 0, -1, left + width, bottom + height];
  // The shown bottom-left corner is the box's top-left corner, and shown x runs down the page.
  else matrix = [0, -1, 1, 0, left, bottom + height];
  return {
    left, bottom, width, height, rotation,
    shownWidth: sideways ? height : width,
    shownHeight: sideways ? width : height,
    matrix,
  };
}

/** The page rectangle [left, bottom, right, top] that a rectangle covers once matrix `m` takes it there. */
export function pageArea(m, x, y, width, height) {
  const corners = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]];
  const xs = corners.map(([cx, cy]) => m[0] * cx + m[2] * cy + m[4]);
  const ys = corners.map(([cx, cy]) => m[1] * cx + m[3] * cy + m[5]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// -----------------------------------------------------------------------------------------------
// PdfToolsEngine.sign

/** A number as a content stream writes it: no exponent, at most 4 decimals. */
function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10000) / 10000;
  if (Math.abs(r) >= 1e9) return String(Math.round(r));
  const s = r.toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * The signature's picture as an image XObject in `doc`: the ink's colour everywhere (DeviceRGB),
 * its strokes in an 8-bit soft mask, both compressed without loss (as PDFBox's LosslessFactory).
 */
function signatureImage(doc, signature, widthPx) {
  const { width, height, alpha } = renderSignature(signature, widthPx);
  const argb = INKS[signature.ink];
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = r;
    rgb[i + 1] = g;
    rgb[i + 2] = b;
  }
  const ctx = doc.context;
  const common = { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, BitsPerComponent: 8 };
  const mask = ctx.register(ctx.flateStream(alpha, { ...common, ColorSpace: 'DeviceGray' }));
  return { ref: ctx.register(ctx.flateStream(rgb, { ...common, ColorSpace: 'DeviceRGB', SMask: mask })), width, height };
}

/** Puts `ref` in the page's own XObject resources (a copy of the ones it shares) and returns its name. */
function addXObject(ctx, node, ref) {
  const shared = inherited(ctx, node, 'Resources');
  const resources = ctx.obj({});
  if (shared instanceof PDFDict) for (const [k, v] of shared.entries()) resources.set(k, v);
  const xobjects = ctx.obj({});
  const old = lookup(ctx, resources.get(N('XObject')));
  if (old instanceof PDFDict) for (const [k, v] of old.entries()) xobjects.set(k, v);
  let i = 1;
  while (xobjects.has(N(`Im${i}`))) i++;
  xobjects.set(N(`Im${i}`), ref);
  resources.set(N('XObject'), xobjects);
  node.set(N('Resources'), resources);
  return `Im${i}`;
}

/**
 * Adds `body` after the page's content, with the content before it kept in a q … Q of its own:
 * the page's drawing may leave the graphics state scaled, turned or clipped (as PDFBox's
 * PDPageContentStream with resetContext does).
 */
function appendContent(ctx, node, body) {
  const contents = node.get(N('Contents'));
  const existing = lookup(ctx, contents);
  let items = [];
  if (existing instanceof PDFArray) for (let i = 0; i < existing.size(); i++) items.push(existing.get(i));
  else if (existing instanceof PDFStream) items = [contents instanceof PDFRef ? contents : ctx.register(existing)];
  if (!items.length) {
    node.set(N('Contents'), ctx.register(ctx.flateStream(body)));
    return;
  }
  const before = ctx.register(ctx.stream('q\n'));
  const after = ctx.register(ctx.flateStream('Q\n' + body));
  node.set(N('Contents'), ctx.obj([before, ...items, after]));
}

/** Whether the page lists annotations at all (only then can any be under the signature). */
function hasAnnotations(ctx, node) {
  const a = lookup(ctx, node.get(N('Annots')));
  return a instanceof PDFArray && a.size() > 0;
}

/**
 * Signs page `options.page` (from 0) of a PDF: draws `options.signature` where
 * `options.placement` ({ centerX, centerY, width }, shares of the page as shown) puts it, or in
 * the lower right when it is null, as a picture with a see-through background, trimmed to the
 * ink, at 300 dpi (at most 2400 pixels on its longer side). Form fields and comments under it
 * become part of the page first, so it lies over them as the preview shows.
 *
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {{ signature: Signature | { strokes: number[][], ink: 'black'|'blue' }, page: number,
 *           placement?: { centerX: number, centerY: number, width: number } | null, name?: string }} options
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: 'application/pdf', pageCount: number }>}
 */
export async function signPdf(input, options = {}, { onProgress, signal } = {}) {
  const steps = 5;
  const progress = (done) => onProgress?.(done, steps);
  checkCancelled(signal);
  const signature = Signature.from(options.signature);
  try {
    if (!signature || signature.isEmpty) throw new UserError('pdf_process_failed');
    const doc = await loadPdf(input.bytes, input.password ? { password: input.password } : {});
    checkCancelled(signal);
    progress(1);
    // What pdf-lib reads leniently from a file that isn't really a PDF has no pages (or no page tree).
    let count = 0;
    try { count = doc.getPageCount(); } catch { count = 0; }
    if (count === 0) throw new UserError('pdf_import_failed');
    const index = options.page;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new UserError('pdf_process_failed');
    const ctx = doc.context;
    const node = doc.getPage(index).node;
    const frame = pageFrame(doc, index);
    const { shownWidth: width, shownHeight: height } = frame;
    const aspect = signature.aspect;
    const wanted = options.placement && typeof options.placement === 'object' ? options.placement : defaultPlacement(width, height, aspect);
    const place = clampPlacement(wanted, width, height, aspect);
    const area = pdfArea(place, width, height, aspect);
    await yieldToUI();
    checkCancelled(signal);
    const image = signatureImage(doc, signature, pixels(area.width, area.height)[0]);
    checkCancelled(signal);
    progress(2);
    // It goes over the form fields and comments under it, as the preview shows it.
    if (hasAnnotations(ctx, node)) {
      const { bakeUnder } = await import('./flatten.js');
      try {
        await bakeUnder(doc, index, [pageArea(frame.matrix, area.x, area.y, area.width, area.height)], { signal });
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        // Annotations that can't be read stay as they are, as the app leaves them.
      }
    }
    checkCancelled(signal);
    progress(3);
    const name = addXObject(ctx, node, image.ref);
    appendContent(ctx, node, [
      `${frame.matrix.map(fmt).join(' ')} cm`,
      'q',
      `${fmt(area.width)} 0 0 ${fmt(area.height)} ${fmt(area.x)} ${fmt(area.y)} cm`,
      `/${name} Do`,
      'Q',
    ].join('\n') + '\n');
    progress(4);
    await yieldToUI();
    checkCancelled(signal);
    const bytes = await savePdf(doc);
    checkCancelled(signal);
    progress(5);
    return {
      name: sanitizeName(options.name, 'Signed') + '.pdf',
      bytes,
      type: 'application/pdf',
      pageCount: doc.getPageCount(),
    };
  } catch (e) {
    if (e instanceof UserError || e instanceof PasswordError || e instanceof CancelledError) throw e;
    throw new UserError('pdf_process_failed');
  }
}
