// Finds a sheet of paper on a photo: a port of PageOutline.kt (PageDetection), with the convex hull
// of TextDetection.kt (MinAreaRect.convexHull). Pure code on pixel arrays, no DOM: it also runs in
// a worker (outline-worker.js) and in Node.
//
// It looks on a small copy of the photo, in two ways.
//
// By brightness: the bright region a page makes on a darker table (Otsu's threshold, then the
// largest bright region), its convex hull, the four-cornered shape that covers most of the hull, and
// each side then fitted to the page's edge so rounded or folded corners and a finger on the page
// don't pull the corners in.
//
// By its edges, as document scanners do: the photo's edges (Canny's), the long straight ones among
// them (a Hough transform), and the four of those that best make a page's outline, its sides lying
// on edges from corner to corner and ending at the corners. This asks nothing of the page's
// brightness, so it also finds a white page on a white desk by the faint shadow along its edges, a
// page on a brighter table, and in colour a page that differs from the desk only in its colour.
//
// Each outline gets a confidence of its own kind, and the surer one is the page; when they are as
// sure, the one by edges, whose sides are fitted to the edges themselves. Its sides then move in to
// just inside the paper, past the blur of its edge and the shadow it casts, so no strip of the desk
// shows along the straightened page.
import { ordered } from './crop-quad.js';

// The app works in 32-bit floats here and there; Math.fround rounds as they do.
const F = Math.fround;
const F_1E_4 = F(1e-4);
const F_1E_6 = F(1e-6);
const F_0_1 = F(0.1);
const F_0_01 = F(0.01);
/** Java's Math.toDegrees and Math.toRadians factors, so angles round as the app's do. */
const RADIANS_TO_DEGREES = 57.29577951308232;
const DEGREES_TO_RADIANS = 0.017453292519943295;

/** The search runs on a copy at most this many pixels on its long side. */
export const WORK_SIDE = 400;

/** Below this confidence, the outline is a guess. */
export const CONFIDENT = 0.5;

/**
 * @typedef {{ quad: {x: number, y: number}[], confidence: number, confident: boolean }} PageOutline
 * A page found on a photo: its corners (fractions of the photo's size, in a page's corner order) and
 * how sure the search is, from 0 (a guess) to 1. Only a `confident` outline is worth starting from.
 */

function outline(quad, confidence) {
  return { quad, confidence, confident: confidence >= CONFIDENT };
}

/**
 * The page on a colour photo (`rgba`: 4 bytes a pixel, row by row, as ImageData has it), `width` ×
 * `height` pixels, or null when nothing like a page stands out. Edges are looked for in each colour,
 * so a white page on a pale blue desk, nearly as bright, stands out by its colour.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {PageOutline|null}
 */
export function findPage(rgba, width, height) {
  checkSize(rgba.length, 4, width, height);
  return find(shrinkRgba(rgba, width, height));
}

/**
 * As findPage() on a grey photo: `luma` holds each pixel's brightness (0..255), row by row.
 * @param {Uint8Array|Uint8ClampedArray} luma
 * @returns {PageOutline|null}
 */
export function findPageInLuma(luma, width, height) {
  checkSize(luma.length, 1, width, height);
  return find(shrink(luma, width, height));
}

function checkSize(length, perPixel, width, height) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && length === width * height * perPixel)) {
    throw new RangeError('Bad image size');
  }
}

/**
 * A small copy of a photo: its brightness, one level (0..255) per pixel, and the levels of each of
 * its colours (or the brightness alone). { width, height, levels: Int32Array, channels: Int32Array[] }
 */
function grey(width, height, levels, channels = [levels]) {
  return { width, height, levels, channels };
}

/** How many pixels across and down make one of the small copy's. */
function factorFor(width, height) {
  return Math.max(1, Math.ceil(Math.max(width, height) / WORK_SIDE));
}

/** `luma` averaged down to at most WORK_SIDE pixels on its long side (which also evens out noise). */
export function shrink(luma, width, height) {
  const factor = factorFor(width, height);
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  const sums = new Int32Array(w * h);
  const counts = new Int32Array(w * h);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / factor) * w;
    const from = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + Math.floor(x / factor);
      sums[i] += luma[from + x];
      counts[i]++;
    }
  }
  const levels = new Int32Array(w * h);
  for (let i = 0; i < levels.length; i++) levels[i] = Math.trunc(sums[i] / counts[i]);
  return grey(w, h, levels);
}

/** `rgba`'s colours averaged down as shrink() does, with their brightness. */
function shrinkRgba(rgba, width, height) {
  const factor = factorFor(width, height);
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  const n = w * h;
  const sr = new Int32Array(n);
  const sg = new Int32Array(n);
  const sb = new Int32Array(n);
  const counts = new Int32Array(n);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / factor) * w;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      const i = row + Math.floor(x / factor);
      sr[i] += rgba[o];
      sg[i] += rgba[o + 1];
      sb[i] += rgba[o + 2];
      counts[i]++;
    }
  }
  const red = new Int32Array(n);
  const green = new Int32Array(n);
  const blue = new Int32Array(n);
  const luma = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    red[i] = Math.trunc(sr[i] / counts[i]);
    green[i] = Math.trunc(sg[i] / counts[i]);
    blue[i] = Math.trunc(sb[i] / counts[i]);
    luma[i] = (red[i] * 77 + green[i] * 150 + blue[i] * 29) >> 8;
  }
  return grey(w, h, luma, [red, green, blue]);
}

/**
 * The surer of the outlines found by edges and by brightness on `image`, the one by edges if as
 * sure, its sides then moved in to just inside the paper (inside()).
 */
function find(image) {
  if (image.width < 8 || image.height < 8) return null;
  let page = null;
  for (const found of [byLines(image), byBrightness(image)]) {
    if (found && (page == null || found.confidence > page.confidence)) page = found;
  }
  if (!page) return null;
  return outline(inside(page.quad, image), page.confidence);
}

// ---- Points and lines ----

function distance(a, b) {
  return F(Math.hypot(F(a.x - b.x), F(a.y - b.y)));
}

/**
 * A straight line through `point` along the unit vector (`dx`, `dy`). Its numbers are 32-bit floats
 * (Math.fround), as the app's are, so the same photo gives the same corners.
 */
class Line {
  constructor(point, dx, dy) {
    this.point = { x: F(point.x), y: F(point.y) };
    this.dx = F(dx);
    this.dy = F(dy);
  }

  /** Where this line crosses `other`, or null if they are (nearly) parallel. */
  meet(other) {
    const det = F(F(this.dx * other.dy) - F(this.dy * other.dx));
    if (Math.abs(det) < F_1E_4) return null;
    const t = F(F(F(F(other.point.x - this.point.x) * other.dy) - F(F(other.point.y - this.point.y) * other.dx)) / det);
    return { x: F(this.point.x + F(t * this.dx)), y: F(this.point.y + F(t * this.dy)) };
  }

  /** The line closest to `points` (total least squares: along their main direction). */
  static fit(points) {
    let cx = 0;
    let cy = 0;
    for (const p of points) {
      cx += p.x;
      cy += p.y;
    }
    cx /= points.length;
    cy /= points.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of points) {
      const x = p.x - cx;
      const y = p.y - cy;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return new Line({ x: cx, y: cy }, Math.cos(angle), Math.sin(angle));
  }
}

/** Andrew's monotone chain; collinear points are dropped. */
export function convexHull(points) {
  const seen = new Set();
  const unique = [];
  for (const p of points) {
    const key = p.x + ',' + p.y;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }
  const sorted = unique.sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (sorted.length < 3) return sorted;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const hull = [];
  for (const p of sorted) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
    hull.push(p);
  }
  const lowerSize = hull.length + 1;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const p = sorted[i];
    while (hull.length >= lowerSize && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
    hull.push(p);
  }
  hull.pop();
  return hull;
}

// ---- Moving the sides in to the paper ----

/**
 * `quad` with each side moved in to where the paper starts. Either search puts a side along the
 * middle of the page's edge: the step from the desk to the paper, blurred over a pixel or two, and on
 * a light desk the shadow line a page casts; and a side may lie a pixel or two askew of the edge.
 * Left there, a thin strip of desk shows along the straightened page. How far in the paper starts
 * along each side is measured on `image` (insets()), and each end of a side moves in at most
 * MAX_INSET pixels, so the page's own margins stay. The corners stay on the image.
 */
function inside(quad, image) {
  const w = image.width;
  const h = image.height;
  const [xs, ys] = pixels(quad, w, h);
  if (area(xs, ys) <= 0) return quad;
  // Into the page from each side: to its right when the corners go clockwise.
  const turn = (xs[1] - xs[0]) * (ys[2] - ys[1]) - (ys[1] - ys[0]) * (xs[2] - xs[1]) > 0 ? 1 : -1;
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const length = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    if (length < 1) return quad;
    const dx = (xs[j] - xs[i]) / length;
    const dy = (ys[j] - ys[i]) / length;
    const inX = -dy * turn;
    const inY = dx * turn;
    const [first, last] = insets(image, xs[i], ys[i], dx, dy, inX, inY, length);
    const ax = xs[i] + first * inX;
    const ay = ys[i] + first * inY;
    const bx = xs[j] + last * inX;
    const by = ys[j] + last * inY;
    const moved = Math.hypot(bx - ax, by - ay);
    if (moved < 1) return quad;
    sides.push(new Line({ x: ax, y: ay }, (bx - ax) / moved, (by - ay) / moved));
  }
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const corner = sides[(i + 3) % 4].meet(sides[i]);
    if (!corner) return quad;
    // Sides nearly in a line meet far along them: such a corner stays where it was.
    if (Math.hypot(corner.x - xs[i], corner.y - ys[i]) > 4 * MAX_INSET) return quad;
    corners.push({ x: clamp01(F(corner.x / w)), y: clamp01(F(corner.y / h)) });
  }
  return corners;
}

/**
 * How far in from a side the paper starts on `image`, in its pixels, at the side's two ends: the
 * side goes from (`x`, `y`) `length` pixels along (`dx`, `dy`), and into the page along (`inX`,
 * `inY`). It is measured in a few stretches along the side (paperStart()). The line that best fits
 * where the paper starts in those away from the corners, moved in to the one furthest in, gives the
 * ends; and an end moves in further where the paper starts further in near it, as by a corner a
 * little rounded or curled. Each end moves in between 0 and MAX_INSET.
 */
function insets(image, x, y, dx, dy, inX, inY, length) {
  const stretch = length * (1 - 2 * END_SHARE) / STRETCHES;
  // Where along the side each stretch's middle is, and how far in its paper starts.
  const middles = [];
  const starts = [];
  for (let s = 0; s < STRETCHES; s++) {
    const from = length * END_SHARE + s * stretch;
    const start = paperStart(image, x, y, dx, dy, inX, inY, from, from + stretch);
    if (start == null) continue;
    middles.push(from + stretch / 2);
    starts.push(start);
  }
  let first = 0;
  let last = 0;
  if (starts.length) {
    const meanAlong = mean(middles);
    const meanStart = mean(starts);
    let spread = 0;
    let together = 0;
    for (let s = 0; s < starts.length; s++) {
      spread += (middles[s] - meanAlong) * (middles[s] - meanAlong);
      together += (middles[s] - meanAlong) * (starts[s] - meanStart);
    }
    const slope = spread > 0 ? together / spread : 0;
    const fitted = (along) => meanStart + slope * (along - meanAlong);
    let furthest = -Infinity;
    for (let s = 0; s < starts.length; s++) furthest = Math.max(furthest, starts[s] - fitted(middles[s]));
    first = fitted(0) + furthest;
    last = fitted(length) + furthest;
  }
  // Near each end, far enough from the corner that the shade across the side is clear of the other
  // side's edge.
  const clear = PAPER_TO + OUTSIDE;
  const end = length * END_SHARE;
  const atFirst = paperStart(image, x, y, dx, dy, inX, inY, clear, end);
  if (atFirst != null) first = Math.max(first, atFirst);
  const atLast = paperStart(image, x, y, dx, dy, inX, inY, length - end, length - clear);
  if (atLast != null) last = Math.max(last, atLast);
  return [clamp(first, 0, MAX_INSET), clamp(last, 0, MAX_INSET)];
}

/**
 * How far in from a side the paper starts on `image` along the stretch of it `from` .. `to` pixels
 * along: the side goes from (`x`, `y`) along (`dx`, `dy`), and into the page along (`inX`, `inY`).
 * The shade across the side is compared with the paper's a little further in: the paper starts where
 * three quarters of the stretch are as near the paper's shade, in every colour, as its own grain and
 * a small share of the step at its edge, from there on in. Null when the stretch is too short, or
 * doesn't come to the paper's shade before PAPER_FROM (a hand over the edge, print close to it).
 */
function paperStart(image, x, y, dx, dy, inX, inY, from, to) {
  const w = image.width;
  const h = image.height;
  const channels = image.channels;
  const depths = Math.trunc((PAPER_TO + OUTSIDE) / INSET_STEP) + 1;
  const depth = (k) => k * INSET_STEP - OUTSIDE;
  const firstPaper = Math.trunc((PAPER_FROM + OUTSIDE) / INSET_STEP);
  const onEdge = Math.trunc(OUTSIDE / INSET_STEP);
  const along = [];
  for (let t = from + 0.5; t < to; t += 1) {
    const px = x + t * dx;
    const py = y + t * dy;
    if (px >= 0 && py >= 0 && px <= w && py <= h) along.push(t);
  }
  const n = along.length;
  if (n < MIN_STRETCH) return null;
  // Each colour's level at each depth and point along the stretch.
  const levels = channels.map(() => new Float32Array(depths * n));
  for (let k = 0; k < depths; k++) {
    for (let p = 0; p < n; p++) {
      const px = x + along[p] * dx + depth(k) * inX;
      const py = y + along[p] * dy + depth(k) * inY;
      for (let c = 0; c < channels.length; c++) levels[c][k * n + p] = sampled(channels[c], w, h, px, py);
    }
  }
  const paper = levels.map((l) => l.slice(firstPaper * n, depths * n).sort()[Math.trunc((depths - firstPaper) * n / 2)]);
  // How far from the paper's shade three quarters of the stretch are, at each depth.
  const off = new Float64Array(depths);
  const apart = new Float64Array(n);
  for (let k = 0; k < depths; k++) {
    for (let p = 0; p < n; p++) {
      let most = -Infinity;
      for (let c = 0; c < channels.length; c++) most = Math.max(most, Math.abs(levels[c][k * n + p] - paper[c]));
      apart[p] = most;
    }
    off[k] = apart.slice().sort()[Math.trunc(3 * n / 4)];
  }
  // As near as the paper's own grain is to its shade, and a small share of the step at its edge; or
  // as near as is too little to see.
  const grain = off.slice(firstPaper, depths).sort()[Math.trunc((depths - firstPaper) / 2)];
  let step = -Infinity;
  for (let k = 0; k <= onEdge; k++) step = Math.max(step, off[k]);
  const close = Math.max(INSET_LEVELS, grain + INSET_SHARE * step);
  let start = firstPaper;
  while (start > onEdge && off[start - 1] <= close) start--;
  return start === firstPaper ? null : depth(start);
}

/** `channel`'s level at (`x`, `y`) on a `w` × `h` image (pixel centres at .5), in a straight line between pixels. */
function sampled(channel, w, h, x, y) {
  const fx = clamp(x - 0.5, 0, w - 1);
  const fy = clamp(y - 0.5, 0, h - 1);
  const x0 = Math.min(Math.trunc(fx), w - 2);
  const y0 = Math.min(Math.trunc(fy), h - 2);
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * w + x0;
  const top = channel[i] + (channel[i + 1] - channel[i]) * tx;
  const bottom = channel[i + w] + (channel[i + w + 1] - channel[i + w]) * tx;
  return top + (bottom - top) * ty;
}

// ---- By brightness ----

/** Each level 0..255 on a logarithmic scale, also 0..255. */
const LOG_LEVELS = Int32Array.from({ length: 256 }, (_, i) => Math.round(255 * Math.log(1 + i) / Math.log(256)));

/** The page as the bright region on `image`, or null if there is none large enough. */
export function byBrightness(image) {
  const w = image.width;
  const h = image.height;
  // On a log scale a shadow darkens the paper and the table by the same step, so the split between
  // them stays where it is instead of cutting off the paper in shadow.
  const levels = new Int32Array(image.levels.length);
  for (let i = 0; i < levels.length; i++) levels[i] = LOG_LEVELS[image.levels[i]];
  const threshold = otsu(levels);
  if (threshold == null) return null;
  const bright = new Uint8Array(levels.length);
  for (let i = 0; i < levels.length; i++) bright[i] = levels[i] > threshold ? 1 : 0;
  const open = opened(bright, w, h);
  const page = largestRegion(open, w, h);
  if (!page) return null;
  // The page with its holes (the print on it) filled: everything the outside can't reach.
  const out = outside(page, w, h);
  let filledArea = 0;
  for (let i = 0; i < out.length; i++) if (!out[i]) filledArea++;
  if (filledArea < MIN_AREA * w * h) return null;

  const edge = edgePoints(out, w, h);
  const hull = convexHull(edge);
  if (hull.length < 4) return null;
  const corners = refined(hull, largestQuad(hull), edge, w, h);

  const quad = ordered(corners.map((p) => ({ x: clamp01(F(p.x / w)), y: clamp01(F(p.y / h)) })));
  return outline(quad, brightnessConfidence(quad, image, page, out, filledArea));
}

/**
 * Otsu's threshold: the level that best splits the image into a dark and a bright part. Null for an
 * image that is (nearly) one flat shade.
 */
export function otsu(levels) {
  const histogram = new Float64Array(256);
  for (let i = 0; i < levels.length; i++) histogram[levels[i]]++;
  const total = levels.length;
  let sum = 0;
  for (let i = 0; i <= 255; i++) sum += i * histogram[i];
  const average = sum / total;
  let variance = 0;
  for (let i = 0; i <= 255; i++) variance += (i - average) * (i - average) * histogram[i];
  if (variance / total < MIN_VARIANCE) return null;
  let below = 0;
  let belowSum = 0;
  let best = -1;
  let threshold = 0;
  for (let t = 0; t <= 254; t++) {
    below += histogram[t];
    if (below === 0) continue;
    const above = total - below;
    if (above === 0) break;
    belowSum += t * histogram[t];
    const difference = belowSum / below - (sum - belowSum) / above;
    const between = below * above * difference * difference;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** `mask` eroded then dilated (3 × 3): thin bright bridges, such as a cable touching the page, go. */
function opened(mask, w, h) {
  const pass = (source, keep) => {
    const out = new Uint8Array(source.length);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(y - 1, 0) * w;
      const y1 = y * w;
      const y2 = Math.min(y + 1, h - 1) * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(x - 1, 0);
        const x2 = Math.min(x + 1, w - 1);
        const s = source[y0 + x0] + source[y0 + x] + source[y0 + x2] +
          source[y1 + x0] + source[y1 + x] + source[y1 + x2] +
          source[y2 + x0] + source[y2 + x] + source[y2 + x2];
        out[y1 + x] = keep ? (s === 9 ? 1 : 0) : (s > 0 ? 1 : 0);
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/** A growable stack of ints without boxing. */
class IntStack {
  constructor() {
    this.values = new Int32Array(256);
    this.size = 0;
  }

  push(v) {
    if (this.size === this.values.length) {
      const bigger = new Int32Array(this.size * 2);
      bigger.set(this.values);
      this.values = bigger;
    }
    this.values[this.size++] = v;
  }

  pop() {
    return this.values[--this.size];
  }
}

/** The largest 4-connected region of `mask`, or null if it has none. */
function largestRegion(mask, w, h) {
  const label = new Int32Array(mask.length);
  const stack = new IntStack();
  let bestLabel = 0;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] !== 0) continue;
    next++;
    let size = 0;
    stack.size = 0;
    stack.push(start);
    label[start] = next;
    while (stack.size > 0) {
      const i = stack.pop();
      size++;
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && mask[i - 1] && label[i - 1] === 0) { label[i - 1] = next; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && label[i + 1] === 0) { label[i + 1] = next; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && label[i - w] === 0) { label[i - w] = next; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && label[i + w] === 0) { label[i + w] = next; stack.push(i + w); }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = next;
    }
  }
  if (bestLabel === 0) return null;
  const region = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) region[i] = label[i] === bestLabel ? 1 : 0;
  return region;
}

/** The pixels outside `region` that the image's edges reach without crossing it (4-connected). */
function outside(region, w, h) {
  const reached = new Uint8Array(region.length);
  const stack = new IntStack();
  const push = (i) => {
    if (!region[i] && !reached[i]) {
      reached[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.size > 0) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return reached;
}

/**
 * The filled page's outermost pixels: the first and last of each row and of each column, at the
 * pixels' centres. Enough for its convex hull, and dense along every side for fitting lines.
 */
function edgePoints(out, w, h) {
  const points = [];
  for (let y = 0; y < h; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (!out[y * w + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      points.push({ x: first + 0.5, y: y + 0.5 });
      if (last !== first) points.push({ x: last + 0.5, y: y + 0.5 });
    }
  }
  for (let x = 0; x < w; x++) {
    let first = -1;
    let last = -1;
    for (let y = 0; y < h; y++) {
      if (!out[y * w + x]) {
        if (first < 0) first = y;
        last = y;
      }
    }
    if (first >= 0) {
      points.push({ x: x + 0.5, y: first + 0.5 });
      if (last !== first) points.push({ x: x + 0.5, y: last + 0.5 });
    }
  }
  return points;
}

function triangle(a, b, c) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
}

/**
 * Which four corners of `hull` (a convex polygon) make the largest four-cornered shape: their
 * indices in the hull's order, each later one past the hull's end counting on from n. For each
 * diagonal i–k, the best third and fourth corners lie on either side and only move forwards as k
 * does, so this takes n² steps.
 */
export function largestQuad(hull) {
  const n = hull.length;
  if (n < 4) throw new RangeError('A hull of at least 4 points is needed');
  const p = (i) => hull[i % n];
  let best = -1;
  let corners = [0, 1, 2, 3];
  for (let i = 0; i < n; i++) {
    let j = i + 1;
    let l = i + 3;
    for (let k = i + 2; k <= i + n - 2; k++) {
      while (j + 1 < k && triangle(p(i), p(j + 1), p(k)) >= triangle(p(i), p(j), p(k))) j++;
      if (l <= k) l = k + 1;
      while (l + 1 < i + n && triangle(p(k), p(l + 1), p(i)) >= triangle(p(k), p(l), p(i))) l++;
      const a = triangle(p(i), p(j), p(k)) + triangle(p(k), p(l), p(i));
      if (a > best) {
        best = a;
        corners = [i, j, k, l];
      }
    }
  }
  return corners;
}

/**
 * The page's corners: where its sides meet. Each side of the four-cornered shape (`corners` of
 * `hull`) lies along the longest stretch of the hull between its corners, which a folded or rounded
 * corner doesn't bend; the line that best fits the page's `edge` points along that stretch (away
 * from the corners) is the side. A corner that would move far stays where it was.
 */
function refined(hull, corners, edge, w, h) {
  const n = hull.length;
  const p = (i) => hull[i % n];
  const lines = [null, null, null, null];
  for (let side = 0; side < 4; side++) {
    const from = corners[side];
    const to = side === 3 ? corners[0] + n : corners[side + 1];
    // The longest stretch of the hull along this side.
    let longest = from;
    for (let k = from; k < to; k++) if (distance(p(k), p(k + 1)) > distance(p(longest), p(longest + 1))) longest = k;
    const start = p(longest);
    const stretch = distance(start, p(longest + 1));
    if (stretch < 2) continue;
    const ux = F(F(p(longest + 1).x - start.x) / stretch);
    const uy = F(F(p(longest + 1).y - start.y) / stretch);
    const along = (q) => F(F(F(q.x - start.x) * ux) + F(F(q.y - start.y) * uy));
    const first = along(p(from));
    const last = along(p(to));
    const margin = F(F_0_1 * F(last - first));
    const reach = F(1.5 + F(F_0_01 * F(last - first)));
    const near = edge.filter((q) => {
      const t = along(q);
      return t > F(first + margin) && t < F(last - margin) &&
        Math.abs(F(F(-F(q.x - start.x) * uy) + F(F(q.y - start.y) * ux))) <= reach;
    });
    lines[side] = near.length >= 6 ? Line.fit(near) : new Line(start, ux, uy);
  }
  const limit = F(F_0_1 * F(Math.hypot(w, h)));
  return [0, 1, 2, 3].map((i) => {
    const corner = p(corners[i]);
    const before = lines[(i + 3) % 4];
    const after = lines[i];
    const meet = before && after ? before.meet(after) : null;
    return meet && distance(meet, corner) <= limit ? meet : corner;
  });
}

/**
 * How sure an outline found by brightness is, from 0 to 1. A page is large enough on the photo,
 * fills its outline (a four-cornered shape, unlike a round plate or a hand), is clearly brighter than
 * what is around it, doesn't run off the photo (a corner out of the frame is a guess) and its corners
 * aren't squashed flat.
 */
function brightnessConfidence(quad, image, page, out, filledArea) {
  const w = image.width;
  const h = image.height;
  const [xs, ys] = pixels(quad, w, h);
  const quadArea = area(xs, ys);
  if (quadArea <= 0) return 0;
  const fill = ramp(Math.min(quadArea, filledArea) / Math.max(quadArea, filledArea), 0.82, 0.94);

  let pageSum = 0;
  let pageCount = 0;
  let aroundSum = 0;
  let aroundCount = 0;
  for (let i = 0; i < page.length; i++) {
    if (page[i]) {
      pageSum += image.levels[i];
      pageCount++;
    } else if (out[i]) {
      aroundSum += image.levels[i];
      aroundCount++;
    }
  }
  if (pageCount === 0 || aroundCount === 0) return 0;
  const contrast = ramp(pageSum / pageCount - aroundSum / aroundCount, 18, 45);

  // How much of the page lies along the photo's edges, where it may go on out of the frame.
  let perimeter = 0;
  for (let i = 0; i < 4; i++) perimeter += Math.hypot(xs[(i + 1) % 4] - xs[i], ys[(i + 1) % 4] - ys[i]);
  let along = 0;
  for (let x = 0; x < w; x++) {
    if (!out[x]) along++;
    if (!out[(h - 1) * w + x]) along++;
  }
  for (let y = 1; y < h - 1; y++) {
    if (!out[y * w]) along++;
    if (!out[y * w + w - 1]) along++;
  }
  const inFrame = 1 - ramp(along / perimeter, 0.03, 0.2);
  return F(shape(xs, ys, w, h) * fill * contrast * inFrame);
}

// ---- By edges ----

const ANGLES = 180;
/** Scratch space for score(), which runs for every four lines tried. */
const PAST_START = new Float64Array(4);
const PAST_END = new Float64Array(4);
const COS = Float32Array.from({ length: ANGLES }, (_, a) => Math.cos(a * DEGREES_TO_RADIANS));
const SIN = Float32Array.from({ length: ANGLES }, (_, a) => Math.sin(a * DEGREES_TO_RADIANS));

/**
 * The page as four straight edges that make a page's outline on `image`, or null if no four do.
 * Every four of the image's long straight edges (straightEdges()) that make a four-cornered shape
 * are scored by how much of its sides lies on their edges, less what doesn't; the best few are
 * fitted to their edges and weighed (edgeConfidence()), and of those about as sure as the surest,
 * the best scored is the page.
 */
function byLines(image) {
  const w = image.width;
  const h = image.height;
  const edges = findEdges(w, h, image.channels);
  const lines = straightEdges(edges);
  const n = lines.length;
  // Where each two lines meet at a page's corner: at an angle a corner can have, on the image (NaN
  // where they don't). Flat arrays: the search below looks them up hundreds of thousands of times.
  const meetX = new Float64Array(n * n).fill(NaN);
  const meetY = new Float64Array(n * n).fill(NaN);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = lines[i];
      const b = lines[j];
      if (Math.abs(F(F(a.dx * b.dy) - F(a.dy * b.dx))) < SIN_CORNER) continue;
      const corner = a.meet(b);
      if (!corner) continue;
      if (corner.x < -OFF_IMAGE || corner.y < -OFF_IMAGE || corner.x > w + OFF_IMAGE || corner.y > h + OFF_IMAGE) continue;
      meetX[i * n + j] = meetX[j * n + i] = corner.x;
      meetY[i * n + j] = meetY[j * n + i] = corner.y;
    }
  }
  // Pairs of lines that could be opposite sides: running roughly the same way, and apart.
  const minGap = MIN_GAP * Math.min(w, h);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = lines[i];
      const b = lines[j];
      if (Math.abs(F(F(a.dx * b.dy) - F(a.dy * b.dx))) > SIN_OPPOSITE) continue;
      // How far apart they are across the image's middle.
      const middle = a.point(a.along(w / 2, h / 2));
      if (Math.abs(F(F(F(b.nx * middle.x) + F(b.ny * middle.y)) - b.rho)) >= minGap) pairs.push(i * n + j);
    }
  }
  // Straight edges every way (a pile of sticks, a wire basket) make many pairs, and the shapes tried
  // grow as the square of their number: then only the pairs whose edges run longest unbroken, as a
  // page's sides do, are tried.
  let tried = pairs;
  if (pairs.length > MAX_PAIRS) {
    const runs = pairs.map((pair) => lines[Math.floor(pair / n)].longestRun + lines[pair % n].longestRun);
    tried = pairs.map((_, k) => k).sort((p, q) => runs[q] - runs[p]).slice(0, MAX_PAIRS)
      .sort((p, q) => p - q).map((k) => pairs[k]);
  }
  const count = tried.length;
  const first = new Int32Array(count);
  const second = new Int32Array(count);
  for (let p = 0; p < count; p++) {
    first[p] = Math.floor(tried[p] / n);
    second[p] = tried[p] % n;
  }
  const best = [];
  const cx = new Float64Array(4);
  const cy = new Float64Array(4);
  const sides = new Int32Array(4);
  const lowest = () => (best.length < CANDIDATES ? -Infinity : best[best.length - 1].score);
  for (let p = 0; p < count; p++) {
    const i = first[p];
    const j = second[p];
    for (let q = p + 1; q < count; q++) {
      const k = first[q];
      const l = second[q];
      // Clockwise or not, the sides in order round the shape: i, k, j, l.
      cx[0] = meetX[l * n + i];
      if (cx[0] !== cx[0]) continue;
      cx[1] = meetX[i * n + k];
      if (cx[1] !== cx[1]) continue;
      cx[2] = meetX[k * n + j];
      if (cx[2] !== cx[2]) continue;
      cx[3] = meetX[j * n + l];
      if (cx[3] !== cx[3]) continue;
      cy[0] = meetY[l * n + i];
      cy[1] = meetY[i * n + k];
      cy[2] = meetY[k * n + j];
      cy[3] = meetY[j * n + l];
      sides[0] = i;
      sides[1] = k;
      sides[2] = j;
      sides[3] = l;
      const s = score(sides, lines, cx, cy, w, h);
      if (s == null) continue;
      if (best.length < CANDIDATES || s > lowest()) {
        best.push({ score: s, sides: Array.from(sides) });
        best.sort((u, v) => v.score - u.score);
        if (best.length > CANDIDATES) best.pop();
      }
    }
  }
  const outlines = [];
  for (const { sides } of best) {
    const found = fitted(sides.map((s) => lines[s]), edges);
    if (!found) continue;
    const quad = ordered(found.map((c) => ({ x: clamp01(F(c.x / w)), y: clamp01(F(c.y / h)) })));
    outlines.push(outline(quad, edgeConfidence(quad, edges, image.levels)));
  }
  // Of outlines about as sure as the surest, the best scored: its sides have the most edge.
  if (!outlines.length) return null;
  const surest = Math.max(...outlines.map((o) => o.confidence));
  return outlines.find((o) => o.confidence >= F(surest - NEARLY_AS_SURE));
}

/**
 * How well four `lines` in order round a shape (`sides`, meeting at corners `xs`, `ys`, the first
 * between the last side and the first) make a page's outline on a `w` × `h` image: how much of each side, between
 * its corners, lies on its edge, less how much doesn't. Null when they don't make a page's shape: not
 * convex, or too small.
 */
function score(sides, lines, xs, ys, w, h) {
  let sign = 0;
  for (let s = 0; s < 4; s++) {
    const t = (s + 1) % 4;
    const u = (s + 2) % 4;
    const cross = (xs[t] - xs[s]) * (ys[u] - ys[t]) - (ys[t] - ys[s]) * (xs[u] - xs[t]);
    const turn = cross > 0 ? 1 : -1;
    if (sign === 0) sign = turn;
    else if (turn !== sign) return null;
  }
  if (area(xs, ys) < MIN_AREA * w * h) return null;
  let total = 0;
  const pastStart = PAST_START;
  const pastEnd = PAST_END;
  for (let s = 0; s < 4; s++) {
    const line = lines[sides[s]];
    const from = line.along(xs[s], ys[s]);
    const to = line.along(xs[(s + 1) % 4], ys[(s + 1) % 4]);
    const length = Math.abs(F(to - from));
    const supported = line.supported(Math.min(from, to), Math.max(from, to));
    total += 2 * supported - length;
    // How much of the line goes on past either corner, as in edgeConfidence().
    const reach = clamp(F(F_0_1 * length), 5, 15);
    const forward = to > from ? 1 : -1;
    const startNear = F(from - forward * 2);
    const startFar = F(from - F(forward * reach));
    pastStart[s] = F(line.supported(Math.min(startFar, startNear), Math.max(startFar, startNear)) / F(reach - 2));
    const endNear = F(to + forward * 2);
    const endFar = F(to + F(forward * reach));
    pastEnd[s] = F(line.supported(Math.min(endNear, endFar), Math.max(endNear, endFar)) / F(reach - 2));
  }
  // A square of a grid, with lines crossing at its corners, isn't worth weighing.
  let crossed = 0;
  for (let s = 0; s < 4; s++) if (Math.min(pastEnd[(s + 3) % 4], pastStart[s]) >= ON_PAST) crossed++;
  return crossed >= 3 ? null : total;
}

/**
 * The corners of the shape four lines in order round it (`sides`) make, each line first fitted to
 * the edge pixels along it between its corners (away from them), so a line that carries on past the
 * page doesn't tilt its side. Null when two sides don't meet.
 */
function fitted(sides, edges) {
  const rough = [];
  for (let i = 0; i < 4; i++) {
    const c = sides[(i + 3) % 4].meet(sides[i]);
    if (!c) return null;
    rough.push(c);
  }
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const line = sides[s];
    const from = line.along(rough[s].x, rough[s].y);
    const to = line.along(rough[(s + 1) % 4].x, rough[(s + 1) % 4].y);
    const start = Math.min(from, to);
    const length = Math.abs(F(to - from));
    const points = [];
    const end = F(start + F(F(1 - F_END_SHARE) * length));
    const [offX, offY] = probes(line.nx, line.ny);
    for (let t = F(start + F(F_END_SHARE * length)); t <= end; t = F(t + 1)) {
      const p = line.point(t);
      const i = edges.nearestWith(p.x, p.y, line.nx, line.ny, offX, offY);
      if (i >= 0) points.push({ x: i % edges.width + 0.5, y: Math.floor(i / edges.width) + 0.5 });
    }
    lines.push(points.length >= 6 ? Line.fit(points) : new Line(line.point(start), line.dx, line.dy));
  }
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const c = lines[(i + 3) % 4].meet(lines[i]);
    if (!c) return null;
    corners.push(c);
  }
  return corners;
}

/**
 * The image's long straight edges that may be a page's sides: the peaks of a Hough transform in
 * which each edge pixel votes for the lines through it within a few degrees of its edge's way, each
 * then fitted to the edge pixels along it.
 */
function straightEdges(edges) {
  const w = edges.width;
  const h = edges.height;
  const offset = w;
  const size = 2 * w + h + 2;
  const votes = new Int32Array(ANGLES * size);
  const { on, ux, uy } = edges;
  for (let i = 0; i < on.length; i++) {
    if (!on[i]) continue;
    const x = i % w + 0.5;
    const y = Math.floor(i / w) + 0.5;
    const angle = Math.round(Math.atan2(uy[i], ux[i]) * RADIANS_TO_DEGREES);
    for (let spread = -SPREAD; spread <= SPREAD; spread++) {
      // The angle round to 0..179 (it is within -184..184).
      let a = angle + spread;
      if (a < 0) a += ANGLES;
      if (a < 0) a += ANGLES;
      if (a >= ANGLES) a -= ANGLES;
      if (a >= ANGLES) a -= ANGLES;
      const rho = Math.round(F(F(x * COS[a]) + F(y * SIN[a]))) + offset;
      votes[a * size + rho]++;
    }
  }
  const least = Math.max(MIN_VOTES, Math.trunc(MIN_LINE * Math.min(w, h)));
  const peaks = [];
  for (let a = 0; a < ANGLES; a++) {
    for (let r = 0; r < size; r++) {
      const v = votes[a * size + r];
      if (v < least) continue;
      let peak = true;
      for (let da = -PEAK_WINDOW; da <= PEAK_WINDOW && peak; da++) {
        const b = a + da;
        if (b < 0 || b >= ANGLES) continue;
        for (let dr = -PEAK_WINDOW; dr <= PEAK_WINDOW; dr++) {
          const s = r + dr;
          if (s < 0 || s >= size) continue;
          if (votes[b * size + s] > v) {
            peak = false;
            break;
          }
        }
      }
      if (peak) peaks.push(a * size + r);
    }
  }
  peaks.sort((p, q) => votes[q] - votes[p]);
  const ways = Array.from({ length: ANGLES / WAY }, () => []);
  for (const peak of peaks) {
    const a = Math.floor(peak / size);
    const oneWay = ways[Math.floor(a / WAY)];
    if (oneWay.length === MAX_PEAKS_ONE_WAY) continue;
    const line = new StraightEdge(COS[a], SIN[a], peak % size - offset, edges).fitted(edges);
    if (ways.some((way) => way.some((other) => other.isNear(line)))) continue;
    oneWay.push(line);
  }
  // Lines of print, rows of keys, a grid of wires or tiles: many long lines one way. Only the most
  // unbroken few of each way are kept, and the outermost two either side, as a page's sides lie
  // outside the lines of print on it however many and strong those are.
  const lines = [];
  for (const oneWay of ways) {
    const across = oneWay.slice().sort((p, q) => p.rho - q.rho);
    const outermost = [...new Set([...across.slice(0, 2), ...across.slice(-2)])];
    lines.push(...outermost);
    lines.push(...oneWay.filter((l) => !outermost.includes(l))
      .sort((p, q) => q.longestRun - p.longestRun).slice(0, MAX_ONE_WAY - outermost.length));
  }
  return lines;
}

/**
 * A straight line x·nx + y·ny = rho across an image (pixel centres at .5), with where along it the
 * image's `edges` run along it. Points on it are at a distance t along (dx, dy) from its point
 * nearest the image's top-left corner.
 */
class StraightEdge {
  constructor(nx, ny, rho, edges) {
    this.nx = F(nx);
    this.ny = F(ny);
    this.rho = F(rho);
    this.dx = -this.ny;
    this.dy = this.nx;
    this.ox = F(this.rho * this.nx);
    this.oy = F(this.rho * this.ny);
    // Where the line crosses the image.
    let from = -Infinity;
    let to = Infinity;
    const clip = (origin, step, size) => {
      if (Math.abs(step) < F_1E_6) {
        if (origin < 0 || origin > size) to = from;
        return;
      }
      const a = F(-origin / step);
      const b = F(F(size - origin) / step);
      from = Math.max(from, Math.min(a, b));
      to = Math.min(to, Math.max(a, b));
    };
    clip(this.ox, this.dx, edges.width);
    clip(this.oy, this.dy, edges.height);
    this.start = Number.isFinite(from) ? from : 0;
    const count = Number.isFinite(from) && to > from ? Math.trunc(F(to - from)) : 0;
    const onEdge = new Int32Array(count + 1);
    let run = 0;
    let gap = 0;
    let longest = 0;
    const [offX, offY] = probes(this.nx, this.ny);
    const { start, ox, oy, dx, dy } = this;
    for (let k = 0; k < count; k++) {
      const t = F(F(start + k) + 0.5);
      const on = edges.nearestWith(F(ox + F(t * dx)), F(oy + F(t * dy)), nx, ny, offX, offY) >= 0;
      onEdge[k + 1] = onEdge[k] + (on ? 1 : 0);
      // Runs of edge with gaps of a pixel or two in them.
      if (on) {
        run += gap + 1;
        gap = 0;
      } else if (++gap > 2) {
        run = 0;
        gap = 0;
      }
      longest = Math.max(longest, run);
    }
    this.onEdge = onEdge;
    /** The longest stretch of the line on its edge: a page's side is long and unbroken, a row of keys or words isn't. */
    this.longestRun = longest;
  }

  /** The point `t` along the line. */
  point(t) {
    return { x: F(this.ox + F(t * this.dx)), y: F(this.oy + F(t * this.dy)) };
  }

  /** How far along the line the point (`x`, `y`) lies. */
  along(x, y) {
    return F(F(x * this.dx) + F(y * this.dy));
  }

  /** How many whole pixels of the line from `from` to `to` lie on its edge. */
  supported(from, to) {
    const last = this.onEdge.length - 1;
    const a = clamp(Math.trunc(F(from - this.start)), 0, last);
    const b = clamp(Math.trunc(F(to - this.start)), 0, last);
    return this.onEdge[b] - this.onEdge[a];
  }

  /** Where this line crosses `other`, or null if they are (nearly) parallel. */
  meet(other) {
    return new Line(this.point(0), this.dx, this.dy).meet(new Line(other.point(0), other.dx, other.dy));
  }

  /** Whether `other` is (nearly) the same line: within 3° and 4 pixels across the image. */
  isNear(other) {
    if (Math.abs(F(F(this.dx * other.dy) - F(this.dy * other.dx))) > SIN_SAME) return false;
    const same = F(F(this.dx * other.dx) + F(this.dy * other.dy)) > 0 ? 1 : -1;
    return Math.abs(F(this.rho - same * other.rho)) <= SAME_RHO;
  }

  /** This line fitted to the edge pixels along it. */
  fitted(edges) {
    const points = [];
    const [offX, offY] = probes(this.nx, this.ny);
    for (let k = 0; k < this.onEdge.length - 1; k++) {
      if (this.onEdge[k + 1] === this.onEdge[k]) continue;
      const p = this.point(F(F(this.start + k) + 0.5));
      const i = edges.nearestWith(p.x, p.y, this.nx, this.ny, offX, offY);
      if (i >= 0) points.push({ x: i % edges.width + 0.5, y: Math.floor(i / edges.width) + 0.5 });
    }
    if (points.length < 6) return this;
    const line = Line.fit(points);
    let fx = -line.dy;
    let fy = line.dx;
    if (F(F(fx * this.nx) + F(fy * this.ny)) < 0) {
      fx = -fx;
      fy = -fy;
    }
    return new StraightEdge(fx, fy, F(F(line.point.x * fx) + F(line.point.y * fy)), edges);
  }
}

/** The steps ACROSS a line with the unit normal (`nx`, `ny`), in 32-bit floats: [x steps, y steps]. */
function probes(nx, ny) {
  const offX = new Float64Array(ACROSS.length);
  const offY = new Float64Array(ACROSS.length);
  for (let k = 0; k < ACROSS.length; k++) {
    offX[k] = F(ACROSS[k] * nx);
    offY[k] = F(ACROSS[k] * ny);
  }
  return [offX, offY];
}

/**
 * Edges on an image: which pixels lie on one, and there the direction across it, from darker to
 * brighter (a unit vector ux, uy).
 */
class Edges {
  constructor(width, height, on, ux, uy) {
    this.width = width;
    this.height = height;
    this.on = on;
    this.ux = ux;
    this.uy = uy;
  }

  /**
   * Whether an edge running along a line with the unit normal (`nx`, `ny`) passes within two pixels,
   * across the line, of the point (`x`, `y`).
   */
  along(x, y, nx, ny) {
    return this.nearest(x, y, nx, ny) >= 0;
  }

  /** The edge pixel nearest to (`x`, `y`) that along() finds, or -1. */
  nearest(x, y, nx, ny) {
    const [offX, offY] = probes(nx, ny);
    return this.nearestWith(x, y, nx, ny, offX, offY);
  }

  /** As nearest(), with the steps across the line (probes(nx, ny)) worked out once for many points. */
  nearestWith(x, y, nx, ny, offX, offY) {
    const w = this.width;
    const h = this.height;
    const on = this.on;
    for (let k = 0; k < offX.length; k++) {
      const px = Math.floor(F(x + offX[k]));
      const py = Math.floor(F(y + offY[k]));
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = py * w + px;
      if (on[i] && Math.abs(F(F(this.ux[i] * nx) + F(this.uy[i] * ny))) >= COS_ALONG) return i;
    }
    return -1;
  }
}

/**
 * The edges on a `width` × `height` image whose colours are `channels`, by Canny's method: the image
 * smoothed a little (a 5 × 5 Gaussian), its gradient (Sobel's, in whichever colour changes most),
 * only the pixels where the gradient peaks across an edge, and of those the strong ones and the
 * weaker ones that continue them. How strong is strong follows the image: a few times its median
 * gradient, so the grain of a table doesn't count but the faint edge of a white page on a smooth
 * white desk does.
 */
function findEdges(width, height, channels) {
  const n = width * height;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const strength = new Float32Array(n);
  for (const channel of channels) {
    const smooth = blurred(channel, width, height);
    for (let y = 0; y < height; y++) {
      const up = Math.max(y - 1, 0) * width;
      const row = y * width;
      const down = Math.min(y + 1, height - 1) * width;
      for (let x = 0; x < width; x++) {
        const left = Math.max(x - 1, 0);
        const right = Math.min(x + 1, width - 1);
        // Summed in 32-bit floats, in the app's order: ties between neighbours then fall the same way.
        const dx = F(F(F(F(F(smooth[up + right] + 2 * smooth[row + right]) + smooth[down + right]) -
          smooth[up + left]) - 2 * smooth[row + left]) - smooth[down + left]);
        const dy = F(F(F(F(F(smooth[down + left] + 2 * smooth[down + x]) + smooth[down + right]) -
          smooth[up + left]) - 2 * smooth[up + x]) - smooth[up + right]);
        const squared = F(F(dx * dx) + F(dy * dy));
        if (squared > strength[row + x]) {
          strength[row + x] = squared;
          gx[row + x] = dx;
          gy[row + x] = dy;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) strength[i] = Math.sqrt(strength[i]);

  // Only where the gradient peaks across the edge (looking along it, to the nearest 45°).
  const peaks = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const m = strength[i];
      if (m === 0) continue;
      const ax = Math.abs(gx[i]);
      const ay = Math.abs(gy[i]);
      let step;
      if (ay <= F(ax * TAN_22_5)) step = 1;
      else if (ax <= F(ay * TAN_22_5)) step = width;
      else if ((gx[i] > 0) === (gy[i] > 0)) step = width + 1;
      else step = width - 1;
      if (m >= strength[i - step] && m > strength[i + step]) peaks[i] = m;
    }
  }

  const high = Math.max(MIN_STRONG_EDGE, NOISE_TIMES * median(strength));
  const low = F(high * WEAK_EDGE);
  const on = new Uint8Array(n);
  const stack = new IntStack();
  for (let start = 0; start < n; start++) {
    if (on[start] || peaks[start] < high) continue;
    on[start] = 1;
    stack.push(start);
    while (stack.size > 0) {
      const i = stack.pop();
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (!on[j] && peaks[j] >= low) {
            on[j] = 1;
            stack.push(j);
          }
        }
      }
    }
  }
  const ux = new Float32Array(n);
  const uy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    ux[i] = gx[i] / strength[i];
    uy[i] = gy[i] / strength[i];
  }
  return new Edges(width, height, on, ux, uy);
}

/** `levels` smoothed by a 5 × 5 Gaussian (1 4 6 4 1 across and down), the border repeated beyond the image. */
function blurred(levels, w, h) {
  const across = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const at = (dx) => levels[row + Math.min(w - 1, Math.max(0, x + dx))];
      across[row + x] = (at(-2) + 4 * at(-1) + 6 * at(0) + 4 * at(1) + at(2)) / 16;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = Math.max(0, y - 2) * w;
    const r1 = Math.max(0, y - 1) * w;
    const r2 = y * w;
    const r3 = Math.min(h - 1, y + 1) * w;
    const r4 = Math.min(h - 1, y + 2) * w;
    for (let x = 0; x < w; x++) {
      out[r2 + x] = F(F(F(F(across[r0 + x] + 4 * across[r1 + x]) + F(6 * across[r2 + x])) + 4 * across[r3 + x]) + across[r4 + x]) / 16;
    }
  }
  return out;
}

/** The median of `values`, none of them negative, rounded down to a whole number. */
function median(values) {
  const histogram = new Int32Array(2048);
  for (let i = 0; i < values.length; i++) histogram[Math.min(Math.trunc(values[i]), histogram.length - 1)]++;
  let count = 0;
  for (let i = 0; i < histogram.length; i++) {
    count += histogram[i];
    if (2 * count >= values.length) return i;
  }
  return 0;
}

/**
 * How sure an outline found by `edges` is, from 0 to 1, without asking the page to be brighter than
 * what is around it. Its sides run along edges that run the same way (all of each side but its ends
 * and a hand over part of it); its corners are where those edges stop (where lines go on past the
 * corners, the outline is a tile, a square of a grid or a stripe between lines of print); its sides
 * aren't lines drawn or printed on paper (a box on a form photographed close up, by the `levels`
 * either side of them); and as for brightness it is large enough, doesn't run along the photo's
 * border and its corners aren't squashed flat.
 */
function edgeConfidence(quad, edges, levels) {
  const w = edges.width;
  const h = edges.height;
  const [xs, ys] = pixels(quad, w, h);
  if (area(xs, ys) <= 0) return 0;

  // Which way is into the page from each side: to its right when the corners go clockwise.
  const turn = (xs[1] - xs[0]) * (ys[2] - ys[1]) - (ys[1] - ys[0]) * (xs[2] - xs[1]) > 0 ? 1 : -1;
  const level = (x, y) => levels[clamp(Math.trunc(y), 0, h - 1) * w + clamp(Math.trunc(x), 0, w - 1)];
  const onBorderAt = (p) => p.x < BORDER || p.y < BORDER || p.x > w - BORDER || p.y > h - BORDER;
  let weakest = 1;
  let hitsAll = 0;
  let samples = 0;
  let onBorder = 0;
  let drawn = 0;
  const pastStart = [0, 0, 0, 0];
  const pastEnd = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const length = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    if (length < 1) return 0;
    const dx = F((xs[j] - xs[i]) / length);
    const dy = F((ys[j] - ys[i]) / length);
    const inX = -dy * turn;
    const inY = dx * turn;
    const at = (t) => ({ x: F(xs[i] + dx * t), y: F(ys[i] + dy * t) });
    const [offX, offY] = probes(-dy, dx);
    let hits = 0;
    let count = 0;
    let gap = 0;
    let longestGap = 0;
    for (let t = END_SHARE * length; t <= (1 - END_SHARE) * length; t += 1) {
      const p = at(t);
      if (edges.nearestWith(p.x, p.y, -dy, dx, offX, offY) >= 0) {
        hits++;
        gap = 0;
      } else {
        gap++;
        longestGap = Math.max(longestGap, gap);
      }
      if (onBorderAt(p)) onBorder++;
      // A line drawn or printed on paper is darker than both sides of it, which are alike; a page's
      // edge steps from one shade to another, or on a white desk is a faint shadow.
      let line = 255;
      for (let k = -2; k <= 2; k++) line = Math.min(line, level(F(p.x + F(k * inX)), F(p.y + F(k * inY))));
      const outer = level(F(p.x - F(DRAWN_SIDE * inX)), F(p.y - F(DRAWN_SIDE * inY)));
      const inner = level(F(p.x + F(DRAWN_SIDE * inX)), F(p.y + F(DRAWN_SIDE * inY)));
      const dip = Math.min(outer, inner) - line;
      if (dip >= DRAWN_DIP && 2 * Math.abs(outer - inner) < dip) drawn++;
      count++;
    }
    samples += count;
    hitsAll += hits;
    // A hand or a cup over the page hides one stretch of a side; edges missing all along it (a line
    // of print, a curve's chord) are another matter.
    if (count > 0) weakest = Math.min(weakest, (hits + longestGap) / count);
    // Whether this side's edge goes on past either end.
    const reach = clamp(length * 0.1, 5, 15);
    const beyond = (from, step) => {
      // From a corner on the photo's border, it may well go on off the photo.
      if (onBorderAt(at(from))) return 1;
      let found = 0;
      let tries = 0;
      for (let s = from + step * 2; Math.abs(s - from) <= reach; s += step) {
        const p = at(s);
        if (p.x >= 0 && p.y >= 0 && p.x < w && p.y < h) {
          tries++;
          if (edges.nearestWith(p.x, p.y, -dy, dx, offX, offY) >= 0) found++;
        }
      }
      return tries === 0 ? 0 : found / tries;
    };
    pastStart[i] = beyond(0, -1);
    pastEnd[i] = beyond(length, 1);
  }
  // A page's sides end at its corners. Where both sides go on past a corner, it is a crossing of
  // lines (tiles, a grid; one may be chance), where a side goes on past both its corners it is a
  // longer line (a table's edge), and where the sides either side of one go on past it, it is a line
  // across something larger (a fold, a line of print, the half of a block of tiles).
  const crossedAll = [0, 1, 2, 3].map((s) => Math.min(pastEnd[(s + 3) % 4], pastStart[s])).sort((p, q) => p - q);
  const crossed = crossedAll[2];
  let open = -Infinity;
  for (let s = 0; s < 4; s++) {
    open = Math.max(open, Math.max(Math.min(pastStart[s], pastEnd[s]), Math.min(pastEnd[(s + 3) % 4], pastStart[(s + 1) % 4])));
  }
  // Most of the outline on edges, and each side on them for much of its length: a hand may cover
  // part of a side.
  const share = hitsAll / Math.max(samples, 1);
  const support = ramp(share, 0.6, 0.85) * ramp(weakest, 0.75, 0.9);
  const inFrame = 1 - ramp(onBorder / Math.max(samples, 1), 0.03, 0.2);
  const cornersScore = (1 - ramp(crossed, 0.4, 0.7)) * (1 - ramp(open, 0.3, 0.6));
  const page = 1 - ramp(drawn / Math.max(samples, 1), 0.3, 0.6);
  return F(shape(xs, ys, w, h) * support * inFrame * cornersScore * page);
}

// ---- Shapes ----

/** `quad`'s corners in pixels of a `w` × `h` image: x and y. */
function pixels(quad, w, h) {
  return [quad.map((p) => p.x * w), quad.map((p) => p.y * h)];
}

/**
 * How much a page with corners at `xs`, `ys` on a `w` × `h` image looks like one by its shape: 0 when
 * it is too small to be what was photographed or a corner is squashed flat, 1 when it is large
 * enough with corners near right angles.
 */
function shape(xs, ys, w, h) {
  const size = ramp(area(xs, ys) / (w * h), MIN_AREA, GOOD_AREA);
  let angles = 1;
  for (let i = 0; i < 4; i++) {
    const prev = (i + 3) % 4;
    const next = (i + 1) % 4;
    const ax = xs[prev] - xs[i];
    const ay = ys[prev] - ys[i];
    const bx = xs[next] - xs[i];
    const by = ys[next] - ys[i];
    const cos = (ax * bx + ay * by) / (Math.sqrt(ax * ax + ay * ay) * Math.sqrt(bx * bx + by * by));
    const degrees = Math.acos(clamp(cos, -1, 1)) * 180 / Math.PI;
    angles = Math.min(angles, ramp(degrees, 35, 50) * (1 - ramp(degrees, 130, 145)));
  }
  return size * angles;
}

/** The area of the four-cornered shape with corners at `xs`, `ys`. */
function area(xs, ys) {
  let twice = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    twice += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return Math.abs(twice) / 2;
}

/** 0 below `low`, 1 above `high`, in a straight line between. */
function ramp(value, low, high) {
  return clamp((value - low) / (high - low), 0, 1);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function mean(values) {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}


// ---- Constants (the app's) ----

/** A page covering less of the photo than this isn't looked for. */
const MIN_AREA = 0.08;
/** A page covering at least this much of the photo is large enough to be sure of. */
const GOOD_AREA = 0.2;
/** An image whose brightness varies less than this (its variance) has nothing to find. */
const MIN_VARIANCE = 30;

/** tan 22.5°: a gradient within 22.5° of across or down counts as across or down. */
const TAN_22_5 = F(0.41421357);
/** A strong edge is this many times the image's median gradient, */
const NOISE_TIMES = 4;
/** and never weaker than this (Sobel's gradient, 0..1443), below which JPEG's own noise lies. */
const MIN_STRONG_EDGE = 12;
/** A weak edge, kept where it continues a strong one, is at least this share of a strong one. */
const WEAK_EDGE = F(0.4);
/** An edge runs along a line when the brightness changes across the line, within about 25°. */
const COS_ALONG = F(0.9);
/** The share of a side's length at either end where a corner may be rounded or folded. */
const END_SHARE = 0.08;
const F_END_SHARE = F(END_SHARE);
/** A side's point this close to the photo's border (in its small copy's pixels) lies along it. */
const BORDER = 2;
/** How far across a line (in pixels, nearest first) an edge pixel may be and still lie on it. */
const ACROSS = [0, -1, 1, -2, 2];

/** An edge pixel votes for the Hough lines within this many degrees of its edge's way. */
const SPREAD = 4;
/** A peak of votes is the most within this many degrees and pixels of it. */
const PEAK_WINDOW = 3;
/** A straight edge is at least this long, and this share of the image's short side. */
const MIN_VOTES = 12;
const MIN_LINE = 0.08;
/** Of the straight edges within each WAY degrees, so many of the longest are looked at, */
const MAX_PEAKS_ONE_WAY = 40;
/** and so many tried as sides. */
const MAX_ONE_WAY = 16;
const WAY = 15;
/** Two lines within sin⁻¹ of this (3°) and this many pixels of each other are one. */
const SIN_SAME = F(0.05);
const SAME_RHO = 4;
/** Opposite sides of a page differ in direction by at most sin⁻¹ of this (35°, as photographed at a slant), */
const SIN_OPPOSITE = F(0.57);
/** sides meeting at a corner by at least sin⁻¹ of this (40°), */
const SIN_CORNER = F(0.64);
/** and opposite sides are at least this share of the image's short side apart. */
const MIN_GAP = 0.15;
/** At most so many pairs of opposite sides are tried (a busy photo has a few hundred). */
const MAX_PAIRS = 1000;
/** A page's corner may be this many pixels off the image. */
const OFF_IMAGE = 3;
/** So many of the best-scored outlines are fitted and weighed. */
const CANDIDATES = 8;
/** A line goes on past a corner when this share of it lies on its edge there. */
const ON_PAST = F(0.7);
/** Outlines this much less sure than the surest are as good as it. */
const NEARLY_AS_SURE = F(0.1);
/** A line this much darker than the paper DRAWN_SIDE pixels either side of it is drawn on it. */
const DRAWN_DIP = 35;
const DRAWN_SIDE = 4;

/**
 * A found side moves in at most this many pixels (1% of the small copy's long side) to leave the
 * desk out: a page's margins are wider.
 */
const MAX_INSET = 4;
/** The paper's shade by a side is taken from as far in as a side may move, past the blur of its edge, */
const PAPER_FROM = MAX_INSET;
const PAPER_TO = 6;
/** and the step at its edge from this many pixels out. */
const OUTSIDE = 2;
/** How far in the paper starts is looked for in steps this many pixels apart, */
const INSET_STEP = 0.25;
/** along each of this many stretches of a side, each at least this many pixels long. */
const STRETCHES = 4;
const MIN_STRETCH = 6;
/** The paper starts where its shade is within its grain and this share of the step at the edge, */
const INSET_SHARE = 0.1;
/** or within this many levels, too few to see. */
const INSET_LEVELS = 4;
