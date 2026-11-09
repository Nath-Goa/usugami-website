// Sign PDF's signature without the PDF part (no pdf-lib): the drawing and its picture (the app's
// Signature.kt) and where it goes and how big (core/SignatureLayout.kt). The screen needs only this
// until the PDF is signed; engine/sign.js re-exports all of it with signPdf.

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
