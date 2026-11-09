// Where a page's four corners are on an image, and how a page cropped from it comes out: a port of
// PageCrop.kt (CropPoint, CropQuad and PageCrop).
//
// A point is { x, y }, fractions of the image's width and height (x from the left, y from the top,
// 0..1). A quad is an array of four points going round the page clockwise as it shows, from its
// top-left (TOP_LEFT, TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT). Quads are never changed in place:
// every function returns a new one.
import { rotation, inverse, floorMod } from './image-transform.js';

export const TOP_LEFT = 0;
export const TOP_RIGHT = 1;
export const BOTTOM_RIGHT = 2;
export const BOTTOM_LEFT = 3;

/** The sides, each from the corner of the same number to the next: see movedSide(). */
export const TOP_SIDE = 0;
export const RIGHT_SIDE = 1;
export const BOTTOM_SIDE = 2;
export const LEFT_SIDE = 3;

/** The shortest side, in pixels of the image, that a cropped page can have. */
export const MIN_SIDE = 16;

/** Cropped pages are at most this many pixels on their long side: plenty for a PDF page. */
export const MAX_SIDE = 3000;

/** Where a page's corners start when none was found on the image: this far in from each edge. */
export const INSET = 0.08;

/**
 * A side less than about 10 degrees from the side being moved counts as parallel to it: its corner
 * would race along it, far further than the drag.
 */
const MIN_SLANT = 0.17;

/** How far past the image's edge, as a fraction of it, a sliding corner still counts as on it. */
const EDGE = 1e-6;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** A quad from eight numbers: x and y of each corner in turn. */
export function quadOf(...xy) {
  const v = xy.length === 1 ? xy[0] : xy;
  return [0, 1, 2, 3].map((i) => ({ x: v[2 * i], y: v[2 * i + 1] }));
}

/** The whole image. */
export const WHOLE = Object.freeze(quadOf(0, 0, 1, 0, 1, 1, 0, 1).map(Object.freeze));

/** The image less `fraction` of its width and height on every side. */
export function inset(fraction) {
  const far = 1 - fraction;
  return quadOf(fraction, fraction, far, fraction, far, far, fraction, far);
}

/** Whether `quad` is the whole image (or as good as: within `tolerance` of each corner). */
export function isWhole(quad, tolerance = 0.002) {
  return isCloseTo(quad, WHOLE, tolerance);
}

/** Whether each corner of `quad` is within `tolerance` of `other`'s. */
export function isCloseTo(quad, other, tolerance = 1e-4) {
  for (let i = 0; i < 4; i++) {
    if (Math.abs(quad[i].x - other[i].x) > tolerance || Math.abs(quad[i].y - other[i].y) > tolerance) return false;
  }
  return true;
}

/** `quad` with corner `index` moved to (`x`, `y`), kept on the image. */
export function withCorner(quad, index, x, y) {
  return quad.map((p, i) => (i === index ? { x: clamp01(x), y: clamp01(y) } : { x: p.x, y: p.y }));
}

/** `quad` with corner `index` moved by (`dx`, `dy`), kept on the image. */
export function movedCorner(quad, index, dx, dy) {
  return withCorner(quad, index, quad[index].x + dx, quad[index].y + dy);
}

/**
 * Side `side` (from corner `side` to the next, clockwise: TOP_SIDE and so on) dragged by (`dx`,
 * `dy`), as fractions of the image, on an image `width` × `height` pixels. Only the part of the drag
 * across the side counts: the side moves parallel to itself, and its two corners slide along the
 * sides beside it, as a page's edge does. When a side beside it is (nearly) parallel to it, or a
 * corner would leave the image that way, both corners move straight across instead. The corners
 * stay on the image.
 */
export function movedSide(quad, side, dx, dy, width, height) {
  const first = side;
  const second = (side + 1) % 4;
  // In pixels: a fraction of the width and one of the height aren't the same length.
  const xs = quad.map((p) => p.x * width);
  const ys = quad.map((p) => p.y * height);
  const sideX = xs[second] - xs[first];
  const sideY = ys[second] - ys[first];
  const length = Math.hypot(sideX, sideY);
  // A side with no length has no direction: its corners just follow the drag.
  if (length < 1e-9) return movedCorner(movedCorner(quad, first, dx, dy), second, dx, dy);
  const normalX = -sideY / length;
  const normalY = sideX / length;
  const across = dx * width * normalX + dy * height * normalY;

  // Where a corner goes sliding along its other side, the one to `other`, for the side to move
  // across: null when that side is nearly parallel to the one moved, or the corner would leave
  // the image.
  const slid = (corner, other) => {
    const alongX = xs[corner] - xs[other];
    const alongY = ys[corner] - ys[other];
    const alongLength = Math.hypot(alongX, alongY);
    if (alongLength < 1e-9) return null;
    const slant = (alongX * normalX + alongY * normalY) / alongLength;
    if (Math.abs(slant) < MIN_SLANT) return null;
    const t = across / (slant * alongLength);
    const x = (xs[corner] + t * alongX) / width;
    const y = (ys[corner] + t * alongY) / height;
    return x >= -EDGE && x <= 1 + EDGE && y >= -EDGE && y <= 1 + EDGE ? { x: clamp01(x), y: clamp01(y) } : null;
  };
  const a = slid(first, (side + 3) % 4);
  const b = slid(second, (side + 2) % 4);
  if (a && b) return withCorner(withCorner(quad, first, a.x, a.y), second, b.x, b.y);
  const shiftX = across * normalX / width;
  const shiftY = across * normalY / height;
  return movedCorner(movedCorner(quad, first, shiftX, shiftY), second, shiftX, shiftY);
}

/**
 * The same corners on the image turned `degrees` clockwise (a multiple of 90): each goes where the
 * turn takes it, and is named for where it lands, so a quarter turn makes corner i corner i + 1
 * (and side i side i + 1). Turning back gives the same corners again.
 */
export function turned(quad, degrees) {
  const quarters = Math.floor(floorMod(degrees, 360) / 90);
  const moved = transformed(quad, rotation(degrees));
  return [0, 1, 2, 3].map((i) => moved[floorMod(i - quarters, 4)]);
}

/** Each corner put where `transform` (an image-transform.js transform) takes it, in the same order. */
export function transformed(quad, t) {
  return quad.map((p) => ({ x: t.a * p.x + t.b * p.y + t.c, y: t.d * p.x + t.e * p.y + t.f }));
}

/**
 * The same four points in order round the page, clockwise as it shows, from the one nearest the
 * image's top-left: the order a page's corners have, whichever were dragged where.
 */
export function ordered(quad) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  // Clockwise on the screen, where y points down, is the angle growing.
  const round = quad.map((p) => ({ p, angle: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((u, v) => u.angle - v.angle).map((e) => e.p);
  let first = 0;
  for (let i = 1; i < 4; i++) if (round[i].x + round[i].y < round[first].x + round[first].y) first = i;
  return [0, 1, 2, 3].map((i) => ({ x: round[(first + i) % 4].x, y: round[(first + i) % 4].y }));
}

/**
 * Whether the corners make a page shape on a `width` × `height` image: they go round a convex shape
 * (in either direction) and its sides are at least `minSide` pixels long.
 */
export function isUsable(quad, width, height, minSide = MIN_SIDE) {
  const xs = quad.map((p) => p.x * width);
  const ys = quad.map((p) => p.y * height);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const k = (i + 2) % 4;
    if (Math.hypot(xs[j] - xs[i], ys[j] - ys[i]) < minSide) return false;
    const cross = (xs[j] - xs[i]) * (ys[k] - ys[j]) - (ys[j] - ys[i]) * (xs[k] - xs[j]);
    // A corner with its sides (almost) in a line isn't a corner.
    if (Math.abs(cross) < 1e-6 * width * height) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * The size [width, height] of the page in `quad` once straightened, from an image `width` ×
 * `height` pixels as it shows. Its shape comes from the average lengths of its opposite edges (the
 * far edge of a page photographed at a slant looks shorter than it is, the near one longer), and it
 * is as large as its longest edges, so no detail is lost; then it is shrunk to `maxSide` on its
 * long side.
 */
export function outputSize(quad, width, height, maxSide = MAX_SIDE) {
  const length = (a, b) => Math.hypot((quad[a].x - quad[b].x) * width, (quad[a].y - quad[b].y) * height);
  const top = length(TOP_LEFT, TOP_RIGHT);
  const bottom = length(BOTTOM_LEFT, BOTTOM_RIGHT);
  const left = length(TOP_LEFT, BOTTOM_LEFT);
  const right = length(TOP_RIGHT, BOTTOM_RIGHT);
  const w = (top + bottom) / 2;
  const h = (left + right) / 2;
  if (w <= 0 || h <= 0) return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  const grow = Math.max(Math.max(top, bottom) / w, Math.max(left, right) / h);
  const scale = Math.min(grow, maxSide / Math.max(w, h));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

/**
 * The corners of `quad` (on the image as it shows upright) on the image as stored, in its pixels:
 * [x0, y0, x1, y1, …] in the page's corner order, for a `storedWidth` × `storedHeight` image shown
 * upright by the transform `upright` (its EXIF orientation).
 */
export function storedCorners(quad, upright, storedWidth, storedHeight) {
  const stored = transformed(quad, inverse(upright));
  const out = new Array(8);
  for (let i = 0; i < 4; i++) {
    out[2 * i] = stored[i].x * storedWidth;
    out[2 * i + 1] = stored[i].y * storedHeight;
  }
  return out;
}
