// Lengths, points and pieces along a PdfPath, as Android's PathMeasure gives them (DrawingML.kt
// draws arrowheads with it): a path's contours, each from a moveTo, of non-zero length.
import { PdfPath } from '../text/canvas.js';

/** Samples per curve: plenty for lengths and points to be exact to a hundredth of a point at page sizes. */
const SAMPLES = 48;

function cubicAt(s, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * s[0] + b * s[2] + c * s[4] + d * s[6], a * s[1] + b * s[3] + c * s[5] + d * s[7]];
}

function cubicTangent(s, t) {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  return [
    a * (s[2] - s[0]) + b * (s[4] - s[2]) + c * (s[6] - s[4]),
    a * (s[3] - s[1]) + b * (s[5] - s[3]) + c * (s[7] - s[5]),
  ];
}

/** The part of cubic `s` (8 numbers) from t0 to t1, as 8 numbers. */
function subCubic(s, t0, t1) {
  const split = (c, t) => {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = c;
    const ax = x0 + (x1 - x0) * t, ay = y0 + (y1 - y0) * t;
    const bx = x1 + (x2 - x1) * t, by = y1 + (y2 - y1) * t;
    const cx = x2 + (x3 - x2) * t, cy = y2 + (y3 - y2) * t;
    const dx = ax + (bx - ax) * t, dy = ay + (by - ay) * t;
    const ex = bx + (cx - bx) * t, ey = by + (cy - by) * t;
    const fx = dx + (ex - dx) * t, fy = dy + (ey - dy) * t;
    return [[x0, y0, ax, ay, dx, dy, fx, fy], [fx, fy, ex, ey, cx, cy, x3, y3]];
  };
  if (t1 < 1) s = split(s, t1)[0];
  if (t0 > 0) s = split(s, t1 > 0 ? t0 / t1 : 0)[1];
  return s;
}

/** The contours of `path`'s commands, each a list of line and curve segments with their lengths. */
function contoursOf(path, forceClosed) {
  const contours = [];
  let current = null;
  let start = null;
  let at = null;
  const finish = () => {
    if (current && forceClosed && !current.closed && at && start && (at[0] !== start[0] || at[1] !== start[1])) {
      addLine(current, at, start);
    }
    if (current && current.length > 0) contours.push(current);
    current = null;
  };
  const begin = (p) => {
    finish();
    current = { segments: [], length: 0, closed: false };
    start = p;
    at = p;
  };
  for (const c of path.cmds) {
    if (c[0] === 'M') {
      begin([c[1], c[2]]);
    } else if (c[0] === 'L') {
      if (!current) begin(at ?? [c[1], c[2]]);
      const p = [c[1], c[2]];
      addLine(current, at, p);
      at = p;
    } else if (c[0] === 'C') {
      if (!current) begin(at ?? [c[1], c[2]]);
      const s = [at[0], at[1], c[1], c[2], c[3], c[4], c[5], c[6]];
      addCurve(current, s);
      at = [c[5], c[6]];
    } else if (c[0] === 'Z') {
      if (current) {
        if (at[0] !== start[0] || at[1] !== start[1]) addLine(current, at, start);
        current.closed = true;
        const s = start;
        finish();
        // A line after a close starts a new contour at the same start.
        at = s;
        start = s;
      }
    }
  }
  finish();
  return contours;
}

function addLine(contour, p0, p1) {
  const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (!(length > 0)) return;
  contour.segments.push({ kind: 'L', p0, p1, from: contour.length, length });
  contour.length += length;
}

function addCurve(contour, s) {
  const ts = [0];
  const ds = [0];
  let prev = [s[0], s[1]];
  let total = 0;
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const p = cubicAt(s, t);
    total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    ts.push(t);
    ds.push(total);
    prev = p;
  }
  if (!(total > 0)) return;
  contour.segments.push({ kind: 'C', s, ts, ds, from: contour.length, length: total });
  contour.length += total;
}

/** The parameter t of curve segment `seg` at `d` points along it. */
function curveT(seg, d) {
  const { ts, ds } = seg;
  if (d <= 0) return 0;
  if (d >= seg.length) return 1;
  let lo = 0;
  let hi = ds.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ds[mid] < d) lo = mid;
    else hi = mid;
  }
  const span = ds[hi] - ds[lo];
  return ts[lo] + (span > 0 ? ((d - ds[lo]) / span) * (ts[hi] - ts[lo]) : 0);
}

/**
 * A PdfPath measured as Android's PathMeasure measures one: `length` of the current contour,
 * nextContour() to move on, getPosTan(distance) and getSegment(start, stop, into).
 */
export class PathMeasure {
  constructor(path, forceClosed = false) {
    this.contours = path instanceof PdfPath || path?.cmds ? contoursOf(path, forceClosed) : [];
    this.index = 0;
  }

  get contour() {
    return this.contours[this.index] ?? null;
  }

  /** The current contour's length (0 when there's none). */
  get length() {
    return this.contour?.length ?? 0;
  }

  /** Whether the current contour is closed. */
  get isClosed() {
    return !!this.contour?.closed;
  }

  /** Moves to the next contour; false when there's none. */
  nextContour() {
    if (this.index >= this.contours.length) return false;
    this.index++;
    return this.index < this.contours.length;
  }

  /** The segment of the current contour at `d` points along it (clamped), and how far into it. */
  locate(d) {
    const c = this.contour;
    if (!c || !c.segments.length) return null;
    const dist = Math.max(0, Math.min(c.length, d));
    let seg = c.segments[c.segments.length - 1];
    for (const s of c.segments) {
      if (dist <= s.from + s.length) {
        seg = s;
        break;
      }
    }
    return { seg, into: dist - seg.from };
  }

  /** The point at `distance` along the current contour and the unit direction there: { x, y, tx, ty }, or null. */
  getPosTan(distance) {
    const found = this.locate(distance);
    if (!found) return null;
    const { seg, into } = found;
    if (seg.kind === 'L') {
      const k = Math.max(0, Math.min(1, into / seg.length));
      const dx = seg.p1[0] - seg.p0[0];
      const dy = seg.p1[1] - seg.p0[1];
      return { x: seg.p0[0] + dx * k, y: seg.p0[1] + dy * k, tx: dx / seg.length, ty: dy / seg.length };
    }
    const t = curveT(seg, into);
    const [x, y] = cubicAt(seg.s, t);
    let [tx, ty] = cubicTangent(seg.s, t);
    let l = Math.hypot(tx, ty);
    if (!(l > 1e-9)) {
      // Control points on an end: the direction is the chord's just beside it.
      const p = cubicAt(seg.s, t < 0.5 ? t + 1e-3 : t - 1e-3);
      [tx, ty] = t < 0.5 ? [p[0] - x, p[1] - y] : [x - p[0], y - p[1]];
      l = Math.hypot(tx, ty) || 1;
    }
    return { x, y, tx: tx / l, ty: ty / l };
  }

  /**
   * Appends the part of the current contour from `start` to `stop` points along it to `into` (a
   * PdfPath), beginning with a moveTo when `startWithMoveTo`. Curves stay curves. False when
   * there's nothing to append.
   */
  getSegment(start, stop, into, startWithMoveTo = true) {
    const c = this.contour;
    if (!c) return false;
    const from = Math.max(0, start);
    const to = Math.min(c.length, stop);
    if (!(from < to)) return false;
    let first = true;
    for (const seg of c.segments) {
      const s0 = seg.from;
      const s1 = seg.from + seg.length;
      if (s1 < from || s0 > to) continue;
      const a = Math.max(from, s0) - s0;
      const b = Math.min(to, s1) - s0;
      if (seg.kind === 'L') {
        const k0 = a / seg.length;
        const k1 = b / seg.length;
        const dx = seg.p1[0] - seg.p0[0];
        const dy = seg.p1[1] - seg.p0[1];
        if (first) {
          if (startWithMoveTo) into.moveTo(seg.p0[0] + dx * k0, seg.p0[1] + dy * k0);
          else into.lineTo(seg.p0[0] + dx * k0, seg.p0[1] + dy * k0);
          first = false;
        }
        into.lineTo(seg.p0[0] + dx * k1, seg.p0[1] + dy * k1);
      } else {
        const piece = subCubic(seg.s, curveT(seg, a), curveT(seg, b));
        if (first) {
          if (startWithMoveTo) into.moveTo(piece[0], piece[1]);
          else into.lineTo(piece[0], piece[1]);
          first = false;
        }
        into.bezierCurveTo(piece[2], piece[3], piece[4], piece[5], piece[6], piece[7]);
      }
    }
    return !first;
  }
}
