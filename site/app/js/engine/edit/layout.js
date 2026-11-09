// Edit PDF's items and their geometry: a port of the app's PageEdits.kt (PageItem, EditLayout,
// EditStyle) with SignatureLayout.inkBounds. Text, pen and highlighter strokes, shapes and pictures
// put on top of a page. The preview on the screen and the saved PDF both draw them from what is
// here, so they match.
//
// Coordinates are points on the page as it is shown (crop box, turned by /Rotate), from the shown
// page's top-left corner with y down, as on a screen.
//
// Items are frozen plain objects; every change makes a new one (copy()), so the history can keep
// the lists as they were.

/** What a shape draws. */
export const ShapeKind = Object.freeze({ RECTANGLE: 'rectangle', ELLIPSE: 'ellipse', LINE: 'line', ARROW: 'arrow' });

/** The handles a chosen item shows, to change its size or shape by dragging. */
export const Handle = Object.freeze({
  TOP_LEFT: 'top-left', TOP_RIGHT: 'top-right', BOTTOM_LEFT: 'bottom-left', BOTTOM_RIGHT: 'bottom-right',
  START: 'start', END: 'end',
});

/** The smallest a shape, picture or drawing gets, in points. */
export const MIN_SIZE = 8;

/** Font sizes text can have, in points. */
export const MIN_TEXT = 6;
export const MAX_TEXT = 96;

/** Line widths of pens and shapes, and of highlighters, in points. */
export const PEN_WIDTHS = Object.freeze({ min: 0.5, max: 20 });
export const HIGHLIGHTER_WIDTHS = Object.freeze({ min: 4, max: 40 });

/** How see-through a highlighter is: the share of its colour laid on the page. */
export const HIGHLIGHTER_ALPHA = 0.55;

/** How far apart, at least, paintedAreas() cuts a slanting line or a curve, in points. */
export const PAINT_STEP = 6;

/** Each move button moves the chosen item by this share of the page's shorter side. */
export const NUDGE = 0.02;

/**
 * The PDF can take this many items, with at most this many points in their strokes: the app keeps
 * its items in the state Android saves, which must stay small, and the web app keeps the same limits.
 */
export const MAX_EDIT_ITEMS = 300;
export const MAX_INK_POINTS = 20_000;

/** Ellipses are drawn with four cubic curves; this places their control points. */
const KAPPA = 0.5522848;

/** At most this many pieces to a line, and halvings of a curve, in paintedAreas(). */
const MAX_PIECES = 256;
const MAX_HALVINGS = 6;

/** Half the angle between an arrow's barbs, in radians (30°). */
const ARROW_ANGLE = 0.5235988;

/** Edit PDF's colours (EditColor), with their string keys. */
export const EDIT_COLORS = Object.freeze([
  Object.freeze({ id: 'black', color: '#000000', label: 'color_black' }),
  Object.freeze({ id: 'blue', color: '#1565c0', label: 'color_blue' }),
  Object.freeze({ id: 'red', color: '#d32f2f', label: 'color_red' }),
  Object.freeze({ id: 'green', color: '#2e7d32', label: 'color_green' }),
  Object.freeze({ id: 'yellow', color: '#ffe600', label: 'color_yellow' }),
  Object.freeze({ id: 'white', color: '#ffffff', label: 'color_white' }),
]);

/**
 * The colours, line widths and font size the next item of each kind gets (EditStyle). Changing an
 * item's changes these too, so the next one matches.
 */
export const DEFAULT_STYLE = Object.freeze({
  textColor: '#000000',
  textSize: 14,
  penColor: '#1565c0',
  penWidth: 2.5,
  highlighterColor: '#ffe600',
  highlighterWidth: 14,
  shapeColor: '#d32f2f',
  shapeWidth: 2.5,
});

// ---- Items ----

const freezeItem = (item) => Object.freeze(item);

/**
 * Text in lines (split at line breaks), left-aligned, its box's top-left corner at (x, y).
 * unitWidth and unitHeight are the box's size at a font size of one point (text.js unitSize()); the
 * box is `size` times that.
 */
export function textItem({ id, page, x, y, text, size, color = '#000000', unitWidth, unitHeight }) {
  return freezeItem({ type: 'text', id, page, x, y, text: String(text), size, color, unitWidth, unitHeight });
}

/**
 * A finger's stroke: `points` are its points' coordinates in turn (x0, y0, x1, y1, …), drawn as the
 * smooth curve a signature is drawn with (outline()), `width` points wide. A highlighter stroke is
 * see-through and darkens what is under it, like a marker.
 */
export function inkItem({ id, page, points, width, color, highlighter = false }) {
  const list = Array.from(points ?? [], Number);
  if (list.length < 2 || list.length % 2 !== 0) throw new RangeError('A stroke needs whole points');
  return freezeItem({ type: 'ink', id, page, points: Object.freeze(list), width, color, highlighter: !!highlighter });
}

/**
 * A rectangle or an ellipse in the box from (x1, y1) to (x2, y2) (x1 ≤ x2, y1 ≤ y2), outlined
 * `width` points wide or filled; or a line or an arrow from (x1, y1) to (x2, y2), the arrow's head
 * at the end.
 */
export function shapeItem({ id, page, kind, x1, y1, x2, y2, width, color, filled = false }) {
  return freezeItem({ type: 'shape', id, page, kind, x1, y1, x2, y2, width, color, filled: !!filled });
}

/**
 * A picture (pictures.js importPicture()) in the box at (x, y), width × height points, which has the
 * picture's shape as it shows upright. picture.jpeg says whether to store it as JPEG (photos) or
 * losslessly, with any transparency (drawings and screenshots).
 */
export function pictureItem({ id, page, picture, x, y, width, height }) {
  return freezeItem({ type: 'picture', id, page, picture, x, y, width, height });
}

/** `item` with `changes`, as a new item. */
export function copy(item, changes) {
  const next = { ...item, ...changes };
  if (next.type === 'ink' && changes.points) next.points = Object.freeze(Array.from(changes.points, Number));
  return freezeItem(next);
}

export const isBox = (item) => item.type === 'shape' && (item.kind === ShapeKind.RECTANGLE || item.kind === ShapeKind.ELLIPSE);

/** Filled shapes have no outline. */
export const strokeWidth = (item) => (isBox(item) && item.filled ? 0 : item.width);

/** Whether two items are the same in every way (Kotlin's data class equality); a picture by its picture. */
export function sameItem(a, b) {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** Whether two lists hold the same items in the same order. */
export function sameItems(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameItem(a[i], b[i])) return false;
  return true;
}

/** Whether `list` holds an item the same as `item`. */
export const contains = (list, item) => list.some((x) => sameItem(x, item));

// ---- Geometry of items ----

const area = (x, y, width, height) => ({ x, y, width, height });

/**
 * What a signature's strokes cover (SignatureLayout.inkBounds): the smoothed curve's own extremes,
 * widened by the pen. Null for no points.
 */
export function inkBounds(strokes, penWidth) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x, y) => {
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  };
  for (const stroke of strokes) {
    const count = Math.floor(stroke.length / 2);
    if (count === 0) continue;
    let startX = stroke[0];
    let startY = stroke[1];
    include(startX, startY);
    for (let i = 1; i < count - 1; i++) {
      const controlX = stroke[2 * i];
      const controlY = stroke[2 * i + 1];
      const endX = (controlX + stroke[2 * i + 2]) / 2;
      const endY = (controlY + stroke[2 * i + 3]) / 2;
      include(endX, endY);
      // Where the curve turns along x, and along y, if it does between its ends.
      for (const t of [turn(startX, controlX, endX), turn(startY, controlY, endY)]) {
        if (t != null) include(quadraticAt(startX, controlX, endX, t), quadraticAt(startY, controlY, endY, t));
      }
      startX = endX;
      startY = endY;
    }
    include(stroke[2 * count - 2], stroke[2 * count - 1]);
  }
  if (left > right) return null;
  return area(left - penWidth / 2, top - penWidth / 2, right - left + penWidth, bottom - top + penWidth);
}

const quadraticAt = (start, control, end, t) => (1 - t) * (1 - t) * start + 2 * t * (1 - t) * control + t * t * end;

function turn(start, control, end) {
  const bend = start - 2 * control + end;
  if (bend === 0) return null;
  const t = (start - control) / bend;
  return t > 0 && t < 1 ? t : null;
}

/** What `item` covers on the page, ink included: { x, y, width, height }. */
export function bounds(item) {
  switch (item.type) {
    case 'text': return area(item.x, item.y, item.unitWidth * item.size, item.unitHeight * item.size);
    case 'picture': return area(item.x, item.y, item.width, item.height);
    case 'ink': return inkBounds([item.points], item.width);
    case 'shape': {
      const pad = strokeWidth(item) / 2;
      let left = Math.min(item.x1, item.x2);
      let top = Math.min(item.y1, item.y2);
      let right = Math.max(item.x1, item.x2);
      let bottom = Math.max(item.y1, item.y2);
      if (item.kind === ShapeKind.ARROW) {
        const head = arrowHead(item.x1, item.y1, item.x2, item.y2, item.width);
        left = Math.min(left, head[0], head[2]);
        right = Math.max(right, head[0], head[2]);
        top = Math.min(top, head[1], head[3]);
        bottom = Math.max(bottom, head[1], head[3]);
      }
      return area(left - pad, top - pad, right - left + 2 * pad, bottom - top + 2 * pad);
    }
    default: throw new TypeError('Not an Edit PDF item');
  }
}

/** What a stroke's curve itself covers, without the pen's width. */
export const curveBounds = (item) => inkBounds([item.points], 0);

/** `item` moved by (dx, dy), anywhere (see moved() for a move kept on the page). */
export function shifted(item, dx, dy) {
  switch (item.type) {
    case 'text':
    case 'picture':
      return copy(item, { x: item.x + dx, y: item.y + dy });
    case 'ink':
      return copy(item, { points: item.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) });
    case 'shape':
      return copy(item, { x1: item.x1 + dx, y1: item.y1 + dy, x2: item.x2 + dx, y2: item.y2 + dy });
    default: throw new TypeError('Not an Edit PDF item');
  }
}

/** `item` `factor` times as big, about the point (cx, cy). Line widths stay as they are. */
export function scaled(item, factor, cx, cy) {
  const sx = (x) => cx + (x - cx) * factor;
  const sy = (y) => cy + (y - cy) * factor;
  switch (item.type) {
    case 'text': return copy(item, { x: sx(item.x), y: sy(item.y), size: item.size * factor });
    case 'picture': return copy(item, { x: sx(item.x), y: sy(item.y), width: item.width * factor, height: item.height * factor });
    case 'ink': return copy(item, { points: item.points.map((v, i) => (i % 2 === 0 ? sx(v) : sy(v))) });
    case 'shape': return copy(item, { x1: sx(item.x1), y1: sy(item.y1), x2: sx(item.x2), y2: sy(item.y2) });
    default: throw new TypeError('Not an Edit PDF item');
  }
}

// ---- Paths ----
// A path is a list of steps: ['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2, x, y] (a cubic Bézier
// curve from the current point), ['Z'].

/**
 * The path of a stroke or a shape (EditLayout.outline). A stroke follows the curve a signature
 * does: from its first point it bends through each point in turn to the midpoint between it and
 * the next, then goes straight to the last point; a stroke of one point is a dot (a line of no
 * length, which the pen's round end draws as one). Text and pictures have none.
 */
export function outline(item) {
  if (item.type === 'ink') return strokePath(item.points);
  if (item.type !== 'shape') return [];
  const { x1, y1, x2, y2 } = item;
  switch (item.kind) {
    case ShapeKind.RECTANGLE: return [['M', x1, y1], ['L', x2, y1], ['L', x2, y2], ['L', x1, y2], ['Z']];
    case ShapeKind.ELLIPSE: return ellipse(x1, y1, x2, y2);
    case ShapeKind.LINE: return [['M', x1, y1], ['L', x2, y2]];
    case ShapeKind.ARROW: {
      const head = arrowHead(x1, y1, x2, y2, item.width);
      return [['M', x1, y1], ['L', x2, y2], ['M', head[0], head[1]], ['L', x2, y2], ['L', head[2], head[3]]];
    }
    default: return [];
  }
}

function strokePath(points) {
  const count = points.length / 2;
  let x = points[0];
  let y = points[1];
  const ops = [['M', x, y]];
  for (let i = 1; i < count - 1; i++) {
    const cx = points[2 * i];
    const cy = points[2 * i + 1];
    const ex = (cx + points[2 * i + 2]) / 2;
    const ey = (cy + points[2 * i + 3]) / 2;
    ops.push(quadratic(x, y, cx, cy, ex, ey));
    x = ex;
    y = ey;
  }
  ops.push(['L', points[2 * count - 2], points[2 * count - 1]]);
  return ops;
}

/** The quadratic curve from (x0, y0) to (x, y) bending towards (cx, cy), as the cubic curve it is. */
export function quadratic(x0, y0, cx, cy, x, y) {
  return ['C', x0 + 2 / 3 * (cx - x0), y0 + 2 / 3 * (cy - y0), x + 2 / 3 * (cx - x), y + 2 / 3 * (cy - y), x, y];
}

/** The ellipse in the box from (left, top) to (right, bottom), clockwise from its top. */
export function ellipse(left, top, right, bottom) {
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const kx = (right - left) / 2 * KAPPA;
  const ky = (bottom - top) / 2 * KAPPA;
  return [
    ['M', cx, top],
    ['C', cx + kx, top, right, cy - ky, right, cy],
    ['C', right, cy + ky, cx + kx, bottom, cx, bottom],
    ['C', cx - kx, bottom, left, cy + ky, left, cy],
    ['C', left, cy - ky, cx - kx, top, cx, top],
    ['Z'],
  ];
}

/**
 * The ends of an arrow's two barbs [x, y, x, y], which meet at its tip (x2, y2). They are longer
 * for a thicker line, but at most half as long as the arrow.
 */
export function arrowHead(x1, y1, x2, y2, width) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0) return [x2, y2, x2, y2];
  const barb = Math.min(Math.max(10, 4 * width), length / 2);
  const ux = (x1 - x2) / length;
  const uy = (y1 - y2) / length;
  const c = Math.cos(ARROW_ANGLE);
  const s = Math.sin(ARROW_ANGLE);
  return [
    x2 + barb * (ux * c - uy * s), y2 + barb * (ux * s + uy * c),
    x2 + barb * (ux * c + uy * s), y2 + barb * (-ux * s + uy * c),
  ];
}

/**
 * Where `item` puts ink on the page as shown, as boxes that together cover it: its bounds for text,
 * a picture or a filled box; for a stroke, an outline, a line or an arrow, small boxes along its
 * path, as wide as its line, so what lies inside an outline or beside a stroke isn't counted as
 * under it. Each box is at most about PAINT_STEP or the line's width across in its shorter direction.
 */
export function paintedAreas(item) {
  let width;
  if (item.type === 'ink') width = item.width;
  else if (item.type === 'shape') {
    if (isBox(item) && item.filled) return [bounds(item)];
    width = item.width;
  } else return [bounds(item)];
  const pad = width / 2;
  const step = Math.max(width, PAINT_STEP);
  const areas = [];
  const box = (left, top, right, bottom) => areas.push(area(left - pad, top - pad, right - left + 2 * pad, bottom - top + 2 * pad));
  const line = (x0, y0, x1, y1) => {
    // Pieces of a slanting line, each with a box that hugs it; one box for a level one.
    const pieces = Math.min(MAX_PIECES, Math.max(1, Math.ceil(Math.min(Math.abs(x1 - x0), Math.abs(y1 - y0)) / step)));
    for (let i = 0; i < pieces; i++) {
      const ax = x0 + (x1 - x0) * i / pieces;
      const ay = y0 + (y1 - y0) * i / pieces;
      const bx = x0 + (x1 - x0) * (i + 1) / pieces;
      const by = y0 + (y1 - y0) * (i + 1) / pieces;
      box(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
    }
  };
  const cubic = (p, depth) => {
    // A curve lies within its points and control points; halved until that is small.
    const left = Math.min(p[0], p[2], p[4], p[6]);
    const top = Math.min(p[1], p[3], p[5], p[7]);
    const right = Math.max(p[0], p[2], p[4], p[6]);
    const bottom = Math.max(p[1], p[3], p[5], p[7]);
    if (depth >= MAX_HALVINGS || Math.min(right - left, bottom - top) <= step) {
      box(left, top, right, bottom);
      return;
    }
    const mid = (a, b) => [(p[a] + p[b]) / 2, (p[a + 1] + p[b + 1]) / 2];
    const ab = mid(0, 2);
    const bc = mid(2, 4);
    const cd = mid(4, 6);
    const abc = [(ab[0] + bc[0]) / 2, (ab[1] + bc[1]) / 2];
    const bcd = [(bc[0] + cd[0]) / 2, (bc[1] + cd[1]) / 2];
    const middle = [(abc[0] + bcd[0]) / 2, (abc[1] + bcd[1]) / 2];
    cubic([p[0], p[1], ab[0], ab[1], abc[0], abc[1], middle[0], middle[1]], depth + 1);
    cubic([middle[0], middle[1], bcd[0], bcd[1], cd[0], cd[1], p[6], p[7]], depth + 1);
  };
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (const op of outline(item)) {
    switch (op[0]) {
      case 'M': startX = op[1]; startY = op[2]; x = op[1]; y = op[2]; break;
      case 'L': line(x, y, op[1], op[2]); x = op[1]; y = op[2]; break;
      case 'C': cubic([x, y, op[1], op[2], op[3], op[4], op[5], op[6]], 0); x = op[5]; y = op[6]; break;
      case 'Z': line(x, y, startX, startY); x = startX; y = startY; break;
      default: break;
    }
  }
  return areas;
}

// ---- Size, moves and handles ----

/**
 * How big `item` is, for the size slider: a text's font size; otherwise the longer side of what it
 * covers (without line widths), or a line's length.
 */
export function size(item) {
  switch (item.type) {
    case 'text': return item.size;
    case 'ink': { const b = curveBounds(item); return Math.max(b.width, b.height); }
    case 'shape': return isBox(item) ? Math.max(item.x2 - item.x1, item.y2 - item.y1) : Math.hypot(item.x2 - item.x1, item.y2 - item.y1);
    case 'picture': return Math.max(item.width, item.height);
    default: throw new TypeError('Not an Edit PDF item');
  }
}

/**
 * The sizes `item` can have on a page pageWidth × pageHeight points big: { min, max }, from small to
 * as big as fits on the page. A text's are font sizes.
 */
export function sizeRange(item, pageWidth, pageHeight) {
  const now = size(item);
  const b = bounds(item);
  const fits = now * Math.min(pageWidth / b.width, pageHeight / b.height);
  if (item.type === 'text') return { min: MIN_TEXT, max: Math.max(MIN_TEXT, Math.min(MAX_TEXT, fits)) };
  const least = Math.min(MIN_SIZE, now);
  return { min: least, max: Math.max(least, fits) };
}

/** `item` made `wanted` big (see size()) about its centre, then moved as little as needed to be on the page. */
export function resized(item, wanted, pageWidth, pageHeight) {
  const current = size(item);
  if (!(current > 0)) return item;
  const b = bounds(item);
  return onPage(scaled(item, wanted / current, b.x + b.width / 2, b.y + b.height / 2), pageWidth, pageHeight);
}

/** `item` moved as little as needed to be wholly on the page; one bigger than the page is centred on it. */
export function onPage(item, pageWidth, pageHeight) {
  const [dx, dy] = clampMove(bounds(item), 0, 0, pageWidth, pageHeight);
  return dx === 0 && dy === 0 ? item : shifted(item, dx, dy);
}

/**
 * How far something covering `b` can move by (dx, dy) and stay on the page: [dx, dy], shortened
 * where it would cross an edge.
 */
export function clampMove(b, dx, dy, pageWidth, pageHeight) {
  const axis = (start, length, delta, page) => {
    // Something bigger than the page is centred on it.
    if (length >= page) return (page - length) / 2 - start;
    return Math.min(Math.max(start + delta, 0), page - length) - start;
  };
  return [axis(b.x, b.width, dx, pageWidth), axis(b.y, b.height, dy, pageHeight)];
}

/** `item` moved by (dx, dy), but no further than keeps it on the page. */
export function moved(item, dx, dy, pageWidth, pageHeight) {
  const [x, y] = clampMove(bounds(item), dx, dy, pageWidth, pageHeight);
  return shifted(item, x, y);
}

/** Where `item`'s handles are: [[handle, x, y], …]. */
export function handles(item) {
  if (item.type === 'text' || item.type === 'ink') {
    const b = bounds(item);
    return [[Handle.BOTTOM_RIGHT, b.x + b.width, b.y + b.height]];
  }
  if (item.type === 'picture') return corners(item.x, item.y, item.x + item.width, item.y + item.height);
  if (isBox(item)) return corners(item.x1, item.y1, item.x2, item.y2);
  return [[Handle.START, item.x1, item.y1], [Handle.END, item.x2, item.y2]];
}

const corners = (left, top, right, bottom) => [
  [Handle.TOP_LEFT, left, top], [Handle.TOP_RIGHT, right, top],
  [Handle.BOTTOM_LEFT, left, bottom], [Handle.BOTTOM_RIGHT, right, bottom],
];

const directionX = (handle) => (handle === Handle.TOP_RIGHT || handle === Handle.BOTTOM_RIGHT ? 1 : -1);
const directionY = (handle) => (handle === Handle.BOTTOM_LEFT || handle === Handle.BOTTOM_RIGHT ? 1 : -1);

/** The corner of the box opposite `handle`: the one that stays put while it is dragged. */
const opposite = (handle, left, top, right, bottom) => [directionX(handle) > 0 ? left : right, directionY(handle) > 0 ? top : bottom];

/**
 * The dragged corner at (x, y), at least MIN_SIZE from the fixed corner (fx, fy) on each side. It
 * may cross to the other side of the fixed corner, as when a box is turned inside out.
 */
function away(fx, fy, x, y, handle) {
  const axis = (fixed, at, preferred) => {
    const d = at - fixed;
    if (Math.abs(d) >= MIN_SIZE) return at;
    const s = d !== 0 ? Math.sign(d) : preferred;
    return fixed + s * MIN_SIZE;
  };
  return [axis(fx, x, directionX(handle)), axis(fy, y, directionY(handle))];
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * `start` (the item as it was when the drag began) with `handle` dragged to (x, y), kept on the
 * page. A box's corner moves while the opposite corner stays; a picture keeps its shape; a line's
 * end moves; text and drawings grow or shrink from their top-left corner.
 */
export function dragHandle(start, handle, x, y, pageWidth, pageHeight) {
  const px = clamp(x, 0, pageWidth);
  const py = clamp(y, 0, pageHeight);
  if (start.type === 'shape') {
    if (isBox(start)) {
      const [fx, fy] = opposite(handle, start.x1, start.y1, start.x2, start.y2);
      const [ex, ey] = away(fx, fy, px, py, handle);
      return copy(start, { x1: Math.min(fx, ex), y1: Math.min(fy, ey), x2: Math.max(fx, ex), y2: Math.max(fy, ey) });
    }
    return handle === Handle.START ? copy(start, { x1: px, y1: py }) : copy(start, { x2: px, y2: py });
  }
  if (start.type === 'picture') {
    const [fx, fy] = opposite(handle, start.x, start.y, start.x + start.width, start.y + start.height);
    const aspect = start.width / start.height;
    const sx = directionX(handle);
    const sy = directionY(handle);
    // Room on the page beyond the fixed corner, in the direction the handle points.
    const roomX = sx > 0 ? pageWidth - fx : fx;
    const roomY = sy > 0 ? pageHeight - fy : fy;
    const wanted = Math.max(sx * (px - fx), sy * (py - fy) * aspect);
    const smallest = Math.max(MIN_SIZE, MIN_SIZE * aspect);
    const least = Math.min(smallest, start.width);
    const width = clamp(wanted, least, Math.max(Math.min(roomX, roomY * aspect), least));
    const height = width / aspect;
    const left = sx > 0 ? fx : fx - width;
    const top = sy > 0 ? fy : fy - height;
    return copy(start, { x: left, y: top, width, height });
  }
  // Text and drawings grow from the top-left corner of what they cover, by how far the handle moved
  // along the box's diagonal: dragging left shrinks even a one-line text, and a little drift across
  // a flat stroke barely changes its size.
  const b = bounds(start);
  const diagonal = b.width * b.width + b.height * b.height;
  const factor = diagonal > 0 ? ((px - b.x) * b.width + (py - b.y) * b.height) / diagonal : 1;
  const most = Math.min((pageWidth - b.x) / b.width, (pageHeight - b.y) / b.height);
  const least = start.type === 'text' ? MIN_TEXT / start.size : Math.min(1, MIN_SIZE / Math.max(1, size(start)));
  const upper = start.type === 'text' ? Math.min(most, MAX_TEXT / start.size) : most;
  return scaled(start, clamp(factor, least, Math.max(least, upper)), b.x, b.y);
}

// ---- Touches ----

/** The shortest distance from (x, y) to the line segment from (x1, y1) to (x2, y2). */
export function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp(((x - x1) * dx + (y - y1) * dy) / lengthSquared, 0, 1);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** Whether a touch at (x, y) is on `item`, or within `reach` points of what it draws. */
export function hits(item, x, y, reach) {
  if (item.type === 'text' || item.type === 'picture') {
    const b = bounds(item);
    return x >= b.x - reach && x <= b.x + b.width + reach && y >= b.y - reach && y <= b.y + b.height + reach;
  }
  if (item.type === 'ink') {
    const p = item.points;
    const near = item.width / 2 + reach;
    if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= near;
    for (let i = 0; i < p.length / 2 - 1; i++) {
      if (distanceToSegment(x, y, p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3]) <= near) return true;
    }
    return false;
  }
  const near = strokeWidth(item) / 2 + reach;
  switch (item.kind) {
    case ShapeKind.RECTANGLE: {
      const inside = x >= item.x1 - near && x <= item.x2 + near && y >= item.y1 - near && y <= item.y2 + near;
      // An outlined box is picked up by its outline, so what it frames can still be tapped.
      const hollow = item.x2 - item.x1 > 2 * near && item.y2 - item.y1 > 2 * near &&
        x > item.x1 + near && x < item.x2 - near && y > item.y1 + near && y < item.y2 - near;
      return inside && (item.filled || !hollow);
    }
    case ShapeKind.ELLIPSE: {
      const rx = (item.x2 - item.x1) / 2;
      const ry = (item.y2 - item.y1) / 2;
      const dx = x - (item.x1 + rx);
      const dy = y - (item.y1 + ry);
      const inEllipse = (a, b) => a > 0 && b > 0 && (dx / a) * (dx / a) + (dy / b) * (dy / b) <= 1;
      return inEllipse(rx + near, ry + near) && (item.filled || !inEllipse(rx - near, ry - near));
    }
    case ShapeKind.LINE:
      return distanceToSegment(x, y, item.x1, item.y1, item.x2, item.y2) <= near;
    case ShapeKind.ARROW: {
      const head = arrowHead(item.x1, item.y1, item.x2, item.y2, item.width);
      return distanceToSegment(x, y, item.x1, item.y1, item.x2, item.y2) <= near ||
        distanceToSegment(x, y, head[0], head[1], item.x2, item.y2) <= near ||
        distanceToSegment(x, y, head[2], head[3], item.x2, item.y2) <= near;
    }
    default: return false;
  }
}

/**
 * The item a touch at (x, y) picks among `items` (those on one page, drawn in order): the chosen one
 * (id `chosen`) if it is touched, so it can be dragged out from under others; otherwise the topmost
 * one touched; null for none.
 */
export function pick(items, x, y, reach, chosen) {
  const current = items.find((it) => it.id === chosen);
  if (current && hits(current, x, y, reach)) return current;
  for (let i = items.length - 1; i >= 0; i--) if (hits(items[i], x, y, reach)) return items[i];
  return null;
}

// ---- New items ----

/** A new shape of `kind` in the middle of the page: a box a third of its shorter side wide, or a line as long. */
export function newShape(id, page, kind, filled, width, color, pageWidth, pageHeight) {
  const side = Math.min(pageWidth, pageHeight) / 3;
  const cx = pageWidth / 2;
  const cy = pageHeight / 2;
  if (kind === ShapeKind.RECTANGLE || kind === ShapeKind.ELLIPSE) {
    const height = kind === ShapeKind.RECTANGLE ? side * 0.6 : side;
    return shapeItem({ id, page, kind, x1: cx - side / 2, y1: cy - height / 2, x2: cx + side / 2, y2: cy + height / 2, width, color, filled });
  }
  return shapeItem({ id, page, kind, x1: cx - side / 2, y1: cy, x2: cx + side / 2, y2: cy, width, color });
}

/**
 * New text in the middle of the page, at font size `fontSize`, or smaller if that is too wide for the
 * page. unitWidth and unitHeight are as in textItem().
 */
export function newText(id, page, text, fontSize, color, unitWidth, unitHeight, pageWidth, pageHeight) {
  const fits = Math.min(0.9 * pageWidth / unitWidth, 0.9 * pageHeight / unitHeight);
  const chosen = Math.max(Math.min(fontSize, fits), MIN_TEXT);
  const item = textItem({
    id, page, x: (pageWidth - unitWidth * chosen) / 2, y: (pageHeight - unitHeight * chosen) / 2,
    text, size: chosen, color, unitWidth, unitHeight,
  });
  return onPage(item, pageWidth, pageHeight);
}

/**
 * `item`, new, moved down and to the right in small steps while it would be centred on one of
 * `others` on its page, so a second shape or text added in the middle of the page doesn't hide the first.
 */
export function clearOf(item, others, pageWidth, pageHeight) {
  const step = 0.04 * Math.min(pageWidth, pageHeight);
  const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const taken = others.filter((o) => o.page === item.page).map((o) => centre(bounds(o)));
  let placed = item;
  for (let i = 0; i < 10; i++) {
    const [cx, cy] = centre(bounds(placed));
    if (!taken.some(([x, y]) => Math.abs(x - cx) < 1 && Math.abs(y - cy) < 1)) return placed;
    placed = moved(placed, step, step, pageWidth, pageHeight);
  }
  return placed;
}

/** A new picture `aspect` (width over height) in shape, in the middle of the page and half as wide or tall. */
export function newPicture(id, page, picture, aspect, pageWidth, pageHeight) {
  const width = Math.min(pageWidth / 2, pageHeight / 2 * aspect);
  const height = width / aspect;
  return pictureItem({ id, page, picture, x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
}

/** How many points the strokes among `items` have. */
export function inkPoints(items) {
  let n = 0;
  for (const it of items) if (it.type === 'ink') n += it.points.length / 2;
  return n;
}

/**
 * The string key (and argument) of what a screen reader calls `item` (EditPdfOptions.describe):
 * ['edit_item_text', text], ['edit_item_drawing'], ['edit_picture'], ['edit_item_filled_rectangle'], …
 */
export function describeKey(item) {
  switch (item.type) {
    case 'text': return ['edit_item_text', item.text];
    case 'ink': return [item.highlighter ? 'edit_item_highlight' : 'edit_item_drawing'];
    case 'picture': return ['edit_picture'];
    case 'shape':
      switch (item.kind) {
        case ShapeKind.RECTANGLE: return [item.filled ? 'edit_item_filled_rectangle' : 'edit_item_rectangle'];
        case ShapeKind.ELLIPSE: return [item.filled ? 'edit_item_filled_ellipse' : 'edit_item_ellipse'];
        case ShapeKind.LINE: return ['edit_item_line'];
        default: return ['edit_item_arrow'];
      }
    default: return ['edit_picture'];
  }
}

/**
 * The matrix (a, b, c, d, e, f, as for a PDF cm operator) taking points on a page as shown, from its
 * top-left corner with y down, to the page's own coordinates (PageFrame.topLeftMatrix), for a crop
 * box [left, bottom, width, height] turned `rotation` degrees.
 */
export function topLeftMatrix(left, bottom, width, height, rotation) {
  const r = ((rotation % 360) + 360) % 360;
  let m;
  switch (r) {
    case 90: m = [0, 1, -1, 0, left + width, bottom]; break;
    case 180: m = [-1, 0, 0, -1, left + width, bottom + height]; break;
    case 270: m = [0, -1, 1, 0, left, bottom + height]; break;
    default: m = [1, 0, 0, 1, left, bottom];
  }
  const shownHeight = r === 90 || r === 270 ? width : height;
  return [m[0], m[1], -m[2], -m[3], m[4] + m[2] * shownHeight, m[5] + m[3] * shownHeight];
}

/** The page's own coordinates of the shown point (x, y), measured from the top-left corner with y down. */
export function fromTopLeft(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

/**
 * The page rectangle [left, bottom, right, top] that the shown rectangle covers once `matrix` takes
 * it to the page (Flattening.pageArea).
 */
export function pageArea(matrix, x, y, width, height) {
  const xs = [];
  const ys = [];
  for (const [cx, cy] of [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]) {
    xs.push(matrix[0] * cx + matrix[2] * cy + matrix[4]);
    ys.push(matrix[1] * cx + matrix[3] * cy + matrix[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
