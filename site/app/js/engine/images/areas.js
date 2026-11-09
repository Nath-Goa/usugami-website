// Rectangles on a PDF page, as [left, bottom, right, top], and the matrices that move them, as
// [a, b, c, d, e, f]: the six numbers of a PDF `cm` operator (x' = a x + c y + e, y' = b x + d y + f).
// A port of Areas.kt.

/** The bounds of `area` once `m` has moved it. */
export function mapped(m, area) {
  const corners = [[area[0], area[1]], [area[2], area[1]], [area[0], area[3]], [area[2], area[3]]];
  const xs = corners.map(([x, y]) => m[0] * x + m[2] * y + m[4]);
  const ys = corners.map(([x, y]) => m[1] * x + m[3] * y + m[5]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The matrix that undoes `m`; null if `m` squashes everything onto a line or a point. */
export function inverted(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0 || !Number.isFinite(det)) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  const e = -(a * m[4] + c * m[5]);
  const f = -(b * m[4] + d * m[5]);
  return [a, b, c, d, e, f];
}

/** Where `a` and `b` overlap; null if they don't, or only along an edge. */
export function intersection(a, b) {
  const left = Math.max(a[0], b[0]);
  const bottom = Math.max(a[1], b[1]);
  const right = Math.min(a[2], b[2]);
  const top = Math.min(a[3], b[3]);
  return left < right && bottom < top ? [left, bottom, right, top] : null;
}

/** Whether `inner` lies within `outer`, reaching at most `slack` beyond its edges. */
export function inside(inner, outer, slack = 0) {
  return inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack &&
    inner[2] <= outer[2] + slack && inner[3] <= outer[3] + slack;
}
