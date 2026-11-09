// Where an annotation's appearance goes when it is drawn into the page itself, as Flatten PDF does:
// the rule viewers use to show it (PDF 32000-1, 12.5.5). A port of the app's AppearancePlacement.

const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * The a, b, c, d, e, f to concatenate (`cm`) before drawing the appearance with `Do`: its box
 * `bbox` (left, bottom, right, top), turned by its own matrix `formMatrix` (which `Do` applies
 * itself, so it isn't part of the result), fitted onto the annotation's rectangle `rect`.
 * @param {number[]} rect      [left, bottom, right, top] on the page, in either order
 * @param {number[]} bbox      the appearance's /BBox
 * @param {number[]} [formMatrix] the appearance's /Matrix
 * @returns {number[]}
 */
export function placementMatrix(rect, bbox, formMatrix = IDENTITY) {
  if (rect.length !== 4 || bbox.length !== 4 || formMatrix.length !== 6) throw new RangeError('rect, bbox and matrix sizes');
  const [a, b, c, d, e, f] = formMatrix;
  // The box's corners, through the form's matrix; their bounds are what is fitted.
  const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]];
  const xs = corners.map(([x, y]) => a * x + c * y + e);
  const ys = corners.map(([x, y]) => b * x + d * y + f);
  const left = Math.min(...xs);
  const bottom = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - bottom;
  const rectLeft = Math.min(rect[0], rect[2]);
  const rectBottom = Math.min(rect[1], rect[3]);
  // A box with no width or height is drawn at its size rather than stretched to infinity.
  const scaleX = width > 0 ? (Math.max(rect[0], rect[2]) - rectLeft) / width : 1;
  const scaleY = height > 0 ? (Math.max(rect[1], rect[3]) - rectBottom) / height : 1;
  return [scaleX, 0, 0, scaleY, rectLeft - left * scaleX, rectBottom - bottom * scaleY];
}

/** Multiplies two matrices: `m` then `n` (the result maps a point through m, then n). */
export function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/**
 * The page's own coordinates (left, bottom, right, top) of what the rectangle at (x, y), width by
 * height, covers once `m` (a, b, c, d, e, f, as for a PDF `cm` operator) takes it there.
 */
export function pageArea(m, x, y, width, height) {
  const corners = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]];
  const xs = corners.map(([cx, cy]) => m[0] * cx + m[2] * cy + m[4]);
  const ys = corners.map(([cx, cy]) => m[1] * cx + m[3] * cy + m[5]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
