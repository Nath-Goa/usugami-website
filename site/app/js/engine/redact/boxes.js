// Redact PDF's boxes and the geometry around them (the app's core Redaction.kt, Areas.kt and
// PageFrame). A box is kept as fractions of its page as shown: the page's crop box turned by its
// /Rotate, with left and right measured from its left edge and top and bottom from its top edge,
// as on a screen. The preview and the saved picture both work from these, whatever size each is
// drawn at.

/** Redacted pages are drawn at this resolution, where even small print stays easy to read… */
export const DPI = 200;
/** …but with at most this many pixels, so that a poster-sized page still fits in memory. */
export const MAX_PIXELS = 12_000_000;
/** The smallest a box gets, as a share of the page's width and of its height. */
export const MIN_SIZE = 0.005;
/** Each arrow or size button moves or changes a box by this share of the page. */
export const STEP = 0.005;
/** More boxes than this aren't kept (strings redact_too_many and redact_find_too_many). */
export const MAX_BOXES = 2000;
/** A box Find text puts around a line of a match reaches this share of the line's height beyond its letters. */
export const TEXT_MARGIN = 0.15;

// Kotlin keeps these as 32-bit floats; rounding to them keeps results (and "same") as in the app.
const f = Math.fround;
const clampTo = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
// Kotlin's coerceIn throws when lo > hi; here the range just collapses to lo.
const coerce = (v, lo, hi) => (hi < lo ? lo : clampTo(v, lo, hi));

/**
 * A box on page `page` (zero-based): { page, left, top, right, bottom }, fractions of the page as
 * shown, top-left origin.
 */
export function makeBox(page, left, top, right, bottom) {
  return { page, left: f(left), top: f(top), right: f(right), bottom: f(bottom) };
}

export const boxWidth = (box) => box.right - box.left;
export const boxHeight = (box) => box.bottom - box.top;

/** The box with corners (x0, y0) and (x1, y1), in either order, cut to the page. */
export function between(page, x0, y0, x1, y1) {
  return makeBox(
    page,
    clampTo(Math.min(x0, x1), 0, 1),
    clampTo(Math.min(y0, y1), 0, 1),
    clampTo(Math.max(x0, x1), 0, 1),
    clampTo(Math.max(y0, y1), 0, 1),
  );
}

/** `box` at least MIN_SIZE wide and tall, moved as little as needed to be wholly on the page. */
export function clamp(box) {
  const width = f(clampTo(f(box.right - box.left), MIN_SIZE, 1));
  const height = f(clampTo(f(box.bottom - box.top), MIN_SIZE, 1));
  const left = f(coerce(box.left, 0, f(1 - width)));
  const top = f(coerce(box.top, 0, f(1 - height)));
  return makeBox(box.page, left, top, left + width, top + height);
}

/** `box` moved by dx and dy, the same size, stopping at the edges of the page. */
export function moved(box, dx, dy) {
  return clamp(makeBox(box.page, box.left + dx, box.top + dy, box.right + dx, box.bottom + dy));
}

/** `box` made dw wider and dh taller around its centre, at least MIN_SIZE, on the page. */
export function resized(box, dw, dh) {
  const width = f(clampTo(f(boxWidth(box) + dw), MIN_SIZE, 1));
  const height = f(clampTo(f(boxHeight(box) + dh), MIN_SIZE, 1));
  const cx = f((box.left + box.right) / 2);
  const cy = f((box.top + box.bottom) / 2);
  return clamp(makeBox(box.page, cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2));
}

/** `box` with its bottom-right corner dragged to (right, bottom); its top-left corner stays. */
export function withCorner(box, right, bottom) {
  return clamp(makeBox(
    box.page, box.left, box.top,
    coerce(right, f(box.left + MIN_SIZE), 1),
    coerce(bottom, f(box.top + MIN_SIZE), 1),
  ));
}

/**
 * A new box for the "Add box" button on a page shownWidth × shownHeight points big: two inches
 * wide and a line of text tall, centred across the page. `offset`, the number of boxes already on
 * the page, moves it down a little each time, so boxes don't land on each other.
 */
export function defaultBox(page, shownWidth, shownHeight, offset) {
  if (!(shownWidth > 0 && shownHeight > 0)) throw new RangeError('The page must have a size');
  const width = Math.min(f(144 / shownWidth), 0.6);
  const height = Math.min(f(24 / shownHeight), 0.2);
  const floorMod = ((offset % 1000) + 1000) % 1000;
  const centerY = f(0.2 + f(f(floorMod * f(0.07)) + f(0.3)) % f(0.6));
  return clamp(makeBox(page, 0.5 - width / 2, centerY - height / 2, 0.5 + width / 2, centerY + height / 2));
}

/** How many pixels wide and tall a page shownWidth × shownHeight points big is drawn: [w, h]. */
export function pixelSize(shownWidth, shownHeight) {
  if (!(shownWidth > 0 && shownHeight > 0)) throw new RangeError('The page must have a size');
  const perPoint = Math.min(f(DPI / 72), f(Math.sqrt(MAX_PIXELS / (shownWidth * shownHeight))));
  return [Math.max(1, Math.round(f(shownWidth * perPoint))), Math.max(1, Math.round(f(shownHeight * perPoint)))];
}

/**
 * The pixels `box` covers in a picture of its page width × height pixels big, as [left, top,
 * right, bottom] (right and bottom exclusive). Rounded outwards: a pixel the box only partly
 * covers is blacked out too.
 */
export function pixelBounds(box, width, height) {
  return [
    clampTo(Math.floor(f(box.left * width)), 0, width),
    clampTo(Math.floor(f(box.top * height)), 0, height),
    clampTo(Math.ceil(f(box.right * width)), 0, width),
    clampTo(Math.ceil(f(box.bottom * height)), 0, height),
  ];
}

/**
 * The index in `boxes` of the box on `page` at (x, y), counting a box as reachX and reachY bigger
 * on each side, so a thin box is easy to tap; -1 for none. Of boxes on top of each other, the
 * smallest wins, so a small box inside a big one can still be picked.
 */
export function hit(boxes, page, x, y, reachX, reachY) {
  let best = -1;
  let bestArea = Infinity;
  boxes.forEach((box, index) => {
    if (box.page !== page) return;
    if (x < box.left - reachX || x > box.right + reachX || y < box.top - reachY || y > box.bottom + reachY) return;
    const area = boxWidth(box) * boxHeight(box);
    if (area < bestArea) {
      best = index;
      bestArea = area;
    }
  });
  return best;
}

const equal = (a, b) => a.page === b.page && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

/**
 * Where box `was`, at `index` when it was touched, is in `boxes` now: still at `index`, or moved up
 * the list because a box before it was deleted meanwhile; -1 once it has been changed or deleted.
 */
export function findBox(boxes, index, was) {
  if (boxes[index] && equal(boxes[index], was)) return index;
  return boxes.findIndex((b) => equal(b, was));
}

/** Whether a and b are the same box, give or take a rounding error. */
export function same(a, b) {
  return a.page === b.page && Math.abs(a.left - b.left) < 1e-4 && Math.abs(a.top - b.top) < 1e-4 &&
    Math.abs(a.right - b.right) < 1e-4 && Math.abs(a.bottom - b.bottom) < 1e-4;
}

/** `boxes` as numbers, five for each, for keeping in a setting or a URL. */
export function pack(boxes) {
  const values = new Float32Array(boxes.length * 5);
  boxes.forEach((box, i) => values.set([box.page, box.left, box.top, box.right, box.bottom], 5 * i));
  return Array.from(values);
}

/** The boxes `pack` made `values` from. */
export function unpack(values) {
  const out = [];
  for (let i = 0; i + 5 <= values.length; i += 5) {
    out.push(makeBox(Math.round(values[i]), values[i + 1], values[i + 2], values[i + 3], values[i + 4]));
  }
  return out;
}

/**
 * `address` (where a link leads, or a file's name) as it is kept and as a person reads it: its
 * %-escapes turned into the letters they stand for, with "+" left as it is and read as a space.
 */
export function addressForms(address) {
  if (!address.includes('%') && !address.includes('+')) return [address];
  return [...new Set([address, unescaped(address, false), unescaped(address, true)])];
}

function unescaped(address, plusIsSpace) {
  let out = '';
  const bytes = [];
  const letters = () => {
    if (!bytes.length) return;
    out += new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
    bytes.length = 0;
  };
  let i = 0;
  while (i < address.length) {
    const c = address[i];
    if (c === '%' && i + 2 < address.length) {
      const high = hexDigit(address[i + 1]);
      const low = hexDigit(address[i + 2]);
      if (high >= 0 && low >= 0) {
        bytes.push(high * 16 + low);
        i += 3;
        continue;
      }
    }
    letters();
    out += plusIsSpace && c === '+' ? ' ' : c;
    i++;
  }
  letters();
  return out;
}

function hexDigit(c) {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 87;
  if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 55;
  return -1;
}

/**
 * Boxes over the glyphs of one match of Find text, given in reading order on a page shownWidth ×
 * shownHeight points big: one box for each line the match is on, reaching TEXT_MARGIN of the
 * line's height beyond the letters. A glyph is { left, top, right, bottom, across } in points from
 * the shown page's top-left corner; `across` says whether its line runs across the page.
 */
export function boxesFor(page, glyphs, shownWidth, shownHeight) {
  if (!(shownWidth > 0 && shownHeight > 0)) throw new RangeError('The page must have a size');
  const lines = [];
  for (const glyph of glyphs) {
    const line = lines[lines.length - 1];
    if (line && sameLine(line[line.length - 1], glyph)) line.push(glyph);
    else lines.push([glyph]);
  }
  return lines.map((line) => {
    const left = Math.min(...line.map((g) => g.left));
    const top = Math.min(...line.map((g) => g.top));
    const right = Math.max(...line.map((g) => g.right));
    const bottom = Math.max(...line.map((g) => g.bottom));
    const thickness = line[0].across ? bottom - top : right - left;
    const pad = Math.max(0.5, TEXT_MARGIN * thickness);
    return clamp(between(page, (left - pad) / shownWidth, (top - pad) / shownHeight, (right + pad) / shownWidth, (bottom + pad) / shownHeight));
  });
}

/** Whether b carries on the line a is on: the same direction, side by side, not far apart. */
function sameLine(a, b) {
  if (a.across !== b.across) return false;
  const [aStart, aEnd, aLow, aHigh] = a.across ? [a.left, a.right, a.top, a.bottom] : [a.top, a.bottom, a.left, a.right];
  const [bStart, bEnd, bLow, bHigh] = a.across ? [b.left, b.right, b.top, b.bottom] : [b.top, b.bottom, b.left, b.right];
  const thickness = Math.max(aHigh - aLow, bHigh - bLow);
  const overlap = Math.min(aHigh, bHigh) - Math.max(aLow, bLow);
  if (overlap < 0.5 * Math.min(aHigh - aLow, bHigh - bLow)) return false;
  const gap = Math.max(bStart - aEnd, aStart - bEnd);
  return gap <= 3 * thickness;
}

// ---- Areas: rectangles on a page as [left, bottom, right, top], matrices as [a, b, c, d, e, f] ----

/** The bounds of `area` once matrix m has moved it. */
export function mapped(m, area) {
  const xs = [];
  const ys = [];
  for (const [x, y] of [[area[0], area[1]], [area[2], area[1]], [area[0], area[3]], [area[2], area[3]]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The matrix that undoes m; null if m squashes everything onto a line or a point. */
export function inverted(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0 || !Number.isFinite(det)) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Where a and b overlap; null if they don't, or only along an edge. */
export function intersection(a, b) {
  const left = Math.max(a[0], b[0]);
  const bottom = Math.max(a[1], b[1]);
  const right = Math.min(a[2], b[2]);
  const top = Math.min(a[3], b[3]);
  return left < right && bottom < top ? [left, bottom, right, top] : null;
}

/** Whether `inner` lies within `outer`, reaching at most `slack` beyond its edges. */
export function inside(inner, outer, slack = 0) {
  return inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack && inner[2] <= outer[2] + slack && inner[3] <= outer[3] + slack;
}

/** m1 × m2: m2 applied first, then m1 (as pdf.js's Util.transform and canvas transform()). */
export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** The bounds of the rectangle at (x, y), width × height, once moved by m. */
export function pageArea(m, x, y, width, height) {
  return mapped(m, [x, y, x + width, y + height]);
}

/**
 * A page as a viewer shows it: its crop box (left, bottom, width, height, in the page's own
 * coordinates) turned clockwise by `rotation` (0, 90, 180 or 270).
 */
export class PageFrame {
  constructor(left, bottom, width, height, rotation = 0) {
    this.left = left;
    this.bottom = bottom;
    this.width = width;
    this.height = height;
    const r = ((Math.round(rotation) % 360) + 360) % 360;
    this.rotation = r % 90 === 0 ? r : 0;
  }

  /** From pdf.js's page.view ([x0, y0, x1, y1]) and page.rotate. */
  static fromView(view, rotation) {
    return new PageFrame(view[0], view[1], view[2] - view[0], view[3] - view[1], rotation);
  }

  get sideways() { return this.rotation === 90 || this.rotation === 270; }
  get shownWidth() { return this.sideways ? this.height : this.width; }
  get shownHeight() { return this.sideways ? this.width : this.height; }

  /** a, b, c, d, e, f as in a PDF `cm` operator: page x = a·x + c·y + e and page y = b·x + d·y + f. */
  get matrix() {
    const { left, bottom, width, height } = this;
    switch (this.rotation) {
      case 90: return [0, 1, -1, 0, left + width, bottom];
      case 180: return [-1, 0, 0, -1, left + width, bottom + height];
      case 270: return [0, -1, 1, 0, left, bottom + height];
      default: return [1, 0, 0, 1, left, bottom];
    }
  }

  /** The page's own coordinates of the shown point (x, y), origin bottom-left, y up. */
  toPage(x, y) {
    const m = this.matrix;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /** The shown point (origin at its bottom-left corner, y up) at the page's own coordinates (x, y). */
  toShown(x, y) {
    const dx = x - this.left;
    const dy = y - this.bottom;
    switch (this.rotation) {
      case 90: return [dy, this.width - dx];
      case 180: return [this.width - dx, this.height - dy];
      case 270: return [this.height - dy, dx];
      default: return [dx, dy];
    }
  }

  /** The crop box as [left, bottom, right, top]. */
  get area() {
    return [this.left, this.bottom, this.left + this.width, this.bottom + this.height];
  }

  /** A plain object for passing around: { left, bottom, width, height, rotation, shownWidth, shownHeight }. */
  toJSON() {
    const { left, bottom, width, height, rotation, shownWidth, shownHeight } = this;
    return { left, bottom, width, height, rotation, shownWidth, shownHeight };
  }
}

/** A PageFrame from a plain frame object (as toJSON gives) or a PageFrame itself. */
export function asFrame(frame) {
  if (frame instanceof PageFrame) return frame;
  return new PageFrame(frame.left, frame.bottom, frame.width, frame.height, frame.rotation);
}

/**
 * `box` (fractions of the shown page) as a rectangle in the page's own, unturned coordinates
 * (PDF user space): { x, y, width, height }, (x, y) its lower-left corner.
 */
export function boxToRect(frameLike, box) {
  const frame = asFrame(frameLike);
  const sw = frame.shownWidth;
  const sh = frame.shownHeight;
  const [x0, y0] = frame.toPage(box.left * sw, (1 - box.top) * sh);
  const [x1, y1] = frame.toPage(box.right * sw, (1 - box.bottom) * sh);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** A rectangle in PDF user space ({ x, y, width, height }) as a box on page `page`, cut to the page. */
export function rectToBox(frameLike, page, rect) {
  const frame = asFrame(frameLike);
  const sw = frame.shownWidth;
  const sh = frame.shownHeight;
  const [x0, y0] = frame.toShown(rect.x, rect.y);
  const [x1, y1] = frame.toShown(rect.x + rect.width, rect.y + rect.height);
  return between(page, x0 / sw, 1 - y0 / sh, x1 / sw, 1 - y1 / sh);
}
