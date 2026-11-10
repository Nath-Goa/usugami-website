// PdfCanvas: drawing into a PDF page the way a 2D canvas draws (CanvasRenderingContext2D's names
// and meaning), with its origin at the top-left corner of the page as shown and lengths in points,
// as the app draws its PDFs with Android's Canvas. Text stays real text: selectable, searchable,
// with only the glyphs used of each font embedded. Pictures become JPEG (or lossless, with
// transparency) images; shapes stay sharp paths.
import { PDFImage, PDFName, PDFString, PDFHexString, PDFRef, PDFDict, PDFArray, PDFPage } from '../../lib/pdf-lib.js';
import { docState, track, finishText } from './docstate.js';
import { embeddedFont, utf16Hex } from './pdffont.js';
import { parseColor, BLACK } from './color.js';
import { resolveStyle, ensureFonts, fontsReady, graphemes, ITALIC_SKEW } from './fonts.js';
import { measureTextSync } from './layout.js';
import { fallbackBitmap, fallbackResolution, usesMask } from './fallback.js';
import { UserError } from '../../core/errors.js';

export { finishText };

// ---- Numbers and matrices ----

function n(v) {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(4);
  let end = s.length;
  while (s.charCodeAt(end - 1) === 48) end--;
  if (s.charCodeAt(end - 1) === 46) end--;
  const out = s.slice(0, end);
  return out === '-0' ? '0' : out;
}

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** m1 then m2: the matrix applying m1 first. */
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function isIdentity(m) {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

function mat(m) {
  return `${n(m[0])} ${n(m[1])} ${n(m[2])} ${n(m[3])} ${n(m[4])} ${n(m[5])}`;
}

/**
 * The matrix taking points on a page as shown (crop box turned by /Rotate), from its top-left
 * corner with y down, to the page's own coordinates; and the shown size (PageEdits.kt's topLeftMatrix).
 */
export function pageFrame(page, frame = 'shown') {
  let box;
  let rotation = 0;
  if (frame === 'page') box = page.getMediaBox();
  else {
    box = shownBox(page);
    rotation = ((page.getRotation().angle % 360) + 360) % 360;
    if (rotation % 90) rotation = 0;
  }
  const { x: left, y: bottom, width, height } = box;
  let m;
  switch (rotation) {
    case 90: m = [0, 1, -1, 0, left + width, bottom]; break;
    case 180: m = [-1, 0, 0, -1, left + width, bottom + height]; break;
    case 270: m = [0, -1, 1, 0, left, bottom + height]; break;
    default: m = [1, 0, 0, 1, left, bottom];
  }
  const sideways = rotation === 90 || rotation === 270;
  const shownWidth = sideways ? height : width;
  const shownHeight = sideways ? width : height;
  const topLeft = [m[0], m[1], -m[2], -m[3], m[4] + m[2] * shownHeight, m[5] + m[3] * shownHeight];
  return { matrix: topLeft, width: shownWidth, height: shownHeight, rotation, box: [left, bottom, left + width, bottom + height] };
}

/**
 * The part of `page` viewers show: its crop box cut to its media box, or the whole media box when
 * that leaves nothing (a crop box beside the page, or an empty one).
 */
function shownBox(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const side = (b) => [Math.min(b.x, b.x + b.width), Math.min(b.y, b.y + b.height), Math.max(b.x, b.x + b.width), Math.max(b.y, b.y + b.height)];
  const m = side(media);
  const c = side(crop);
  const cut = [Math.max(c[0], m[0]), Math.max(c[1], m[1]), Math.min(c[2], m[2]), Math.min(c[3], m[3])];
  const [left, bottom, right, top] = cut[2] - cut[0] > 0 && cut[3] - cut[1] > 0 ? cut : m;
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

// ---- Paths ----

/**
 * A path made with the same calls as a canvas path (moveTo, lineTo, arc, rect, ...), for
 * fill(path), stroke(path) and clip(path); like Path2D, it is placed by the transform current
 * when it is drawn.
 */
export class PdfPath {
  constructor(path) {
    this.cmds = path instanceof PdfPath ? path.cmds.slice() : [];
    this.cur = path instanceof PdfPath && path.cur ? [...path.cur] : null;
    this.startPt = path instanceof PdfPath && path.startPt ? [...path.startPt] : null;
    this.m = IDENTITY;
  }

  _pt(x, y) {
    return this.m === IDENTITY ? [x, y] : apply(this.m, x, y);
  }

  addPath(path, transform) {
    if (!(path instanceof PdfPath)) return;
    const t = transform ? toMatrix(transform) : IDENTITY;
    for (const c of path.cmds) {
      if (c[0] === 'Z') this.cmds.push(['Z']);
      else {
        const pts = [];
        for (let i = 1; i < c.length; i += 2) {
          const [x, y] = apply(t, c[i], c[i + 1]);
          pts.push(...this._pt(x, y));
        }
        this.cmds.push([c[0], ...pts]);
      }
    }
    this.cur = null;
  }

  moveTo(x, y) {
    if (!finite(x, y)) return;
    const p = this._pt(x, y);
    this.cmds.push(['M', p[0], p[1]]);
    this.cur = p;
    this.startPt = p;
  }

  lineTo(x, y) {
    if (!finite(x, y)) return;
    if (!this.cur) return this.moveTo(x, y);
    const p = this._pt(x, y);
    this.cmds.push(['L', p[0], p[1]]);
    this.cur = p;
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    if (!finite(c1x, c1y, c2x, c2y, x, y)) return;
    if (!this.cur) this.moveTo(c1x, c1y);
    const a = this._pt(c1x, c1y);
    const b = this._pt(c2x, c2y);
    const p = this._pt(x, y);
    this.cmds.push(['C', a[0], a[1], b[0], b[1], p[0], p[1]]);
    this.cur = p;
  }

  quadraticCurveTo(cx, cy, x, y) {
    if (!finite(cx, cy, x, y)) return;
    if (!this.cur) this.moveTo(cx, cy);
    const q = this._pt(cx, cy);
    const p = this._pt(x, y);
    const s = this.cur;
    // As a cubic: control points two thirds of the way to the quadratic's.
    this.cmds.push(['C', s[0] + (2 / 3) * (q[0] - s[0]), s[1] + (2 / 3) * (q[1] - s[1]), p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1]), p[0], p[1]]);
    this.cur = p;
  }

  closePath() {
    if (!this.cur) return;
    this.cmds.push(['Z']);
    this.cur = this.startPt;
  }

  rect(x, y, w, h) {
    if (!finite(x, y, w, h)) return;
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
    this.moveTo(x, y);
  }

  roundRect(x, y, w, h, radii = 0) {
    if (!finite(x, y, w, h)) return;
    let r = Array.isArray(radii) ? radii : [radii];
    r = r.map((v) => (typeof v === 'number' ? { x: v, y: v } : { x: v?.x ?? 0, y: v?.y ?? 0 }));
    if (r.some((v) => v.x < 0 || v.y < 0)) throw new RangeError('Radii must be non-negative');
    let [tl, tr, br, bl] =
      r.length === 1 ? [r[0], r[0], r[0], r[0]] :
      r.length === 2 ? [r[0], r[1], r[0], r[1]] :
      r.length === 3 ? [r[0], r[1], r[2], r[1]] : [r[0], r[1], r[2], r[3]];
    // A negative width or height draws the rectangle the other way, as the canvas does.
    if (w < 0) { x += w; w = -w; [tl, tr, br, bl] = [tr, tl, bl, br]; }
    if (h < 0) { y += h; h = -h; [tl, tr, br, bl] = [bl, br, tr, tl]; }
    const scale = Math.min(1, w / (tl.x + tr.x || 1), w / (bl.x + br.x || 1), h / (tl.y + bl.y || 1), h / (tr.y + br.y || 1));
    for (const v of [tl, tr, br, bl]) { v.x *= scale; v.y *= scale; }
    this.moveTo(x + tl.x, y);
    this.lineTo(x + w - tr.x, y);
    this.ellipse(x + w - tr.x, y + tr.y, tr.x, tr.y, 0, -Math.PI / 2, 0);
    this.lineTo(x + w, y + h - br.y);
    this.ellipse(x + w - br.x, y + h - br.y, br.x, br.y, 0, 0, Math.PI / 2);
    this.lineTo(x + bl.x, y + h);
    this.ellipse(x + bl.x, y + h - bl.y, bl.x, bl.y, 0, Math.PI / 2, Math.PI);
    this.lineTo(x, y + tl.y);
    this.ellipse(x + tl.x, y + tl.y, tl.x, tl.y, 0, Math.PI, 1.5 * Math.PI);
    this.closePath();
    this.moveTo(x, y);
  }

  arc(x, y, r, start, end, ccw = false) {
    if (r < 0) throw new RangeError('The radius must be non-negative');
    this.ellipse(x, y, r, r, 0, start, end, ccw);
  }

  ellipse(x, y, rx, ry, rotation, start, end, ccw = false) {
    if (!finite(x, y, rx, ry, rotation, start, end)) return;
    if (rx < 0 || ry < 0) throw new RangeError('The radii must be non-negative');
    const TAU = Math.PI * 2;
    let sweep;
    if (!ccw && end - start >= TAU) sweep = TAU;
    else if (ccw && start - end >= TAU) sweep = -TAU;
    else {
      sweep = end - start;
      if (!ccw) {
        sweep %= TAU;
        if (sweep < 0) sweep += TAU;
      } else {
        sweep %= TAU;
        if (sweep > 0) sweep -= TAU;
      }
    }
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const at = (t) => {
      const px = rx * Math.cos(t);
      const py = ry * Math.sin(t);
      return [x + px * cos - py * sin, y + px * sin + py * cos];
    };
    const p0 = at(start);
    if (this.cur) this.lineTo(p0[0], p0[1]);
    else this.moveTo(p0[0], p0[1]);
    if (sweep === 0) return;
    const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / parts;
    const k = (4 / 3) * Math.tan(step / 4);
    let t = start;
    for (let i = 0; i < parts; i++) {
      const t2 = t + step;
      const c1 = [rx * (Math.cos(t) - k * Math.sin(t)), ry * (Math.sin(t) + k * Math.cos(t))];
      const c2 = [rx * (Math.cos(t2) + k * Math.sin(t2)), ry * (Math.sin(t2) - k * Math.cos(t2))];
      const e = at(t2);
      const rot = (p) => [x + p[0] * cos - p[1] * sin, y + p[0] * sin + p[1] * cos];
      const a = rot(c1);
      const b = rot(c2);
      this.bezierCurveTo(a[0], a[1], b[0], b[1], e[0], e[1]);
      t = t2;
    }
  }

  arcTo(x1, y1, x2, y2, r) {
    if (!finite(x1, y1, x2, y2, r)) return;
    if (r < 0) throw new RangeError('The radius must be non-negative');
    if (!this.cur) this.moveTo(x1, y1);
    // The current point, in the coordinates the points are given in.
    const im = this.m === IDENTITY ? IDENTITY : inv(this.m);
    if (!im) return;
    const [x0, y0] = apply(im, this.cur[0], this.cur[1]);
    const d1x = x0 - x1, d1y = y0 - y1, d2x = x2 - x1, d2y = y2 - y1;
    const l1 = Math.hypot(d1x, d1y);
    const l2 = Math.hypot(d2x, d2y);
    const cross = d1x * d2y - d1y * d2x;
    if ((x0 === x1 && y0 === y1) || (x1 === x2 && y1 === y2) || r === 0 || Math.abs(cross) < 1e-12 || !l1 || !l2) {
      this.lineTo(x1, y1);
      return;
    }
    const angle = Math.acos(Math.max(-1, Math.min(1, (d1x * d2x + d1y * d2y) / (l1 * l2))));
    const dist = r / Math.tan(angle / 2);
    const t1 = [x1 + (d1x / l1) * dist, y1 + (d1y / l1) * dist];
    const t2 = [x1 + (d2x / l2) * dist, y1 + (d2y / l2) * dist];
    // The centre is r away from both lines, on the inside of the corner.
    const bis = [d1x / l1 + d2x / l2, d1y / l1 + d2y / l2];
    const bl = Math.hypot(bis[0], bis[1]);
    const cd = r / Math.sin(angle / 2);
    const c = [x1 + (bis[0] / bl) * cd, y1 + (bis[1] / bl) * cd];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const a1 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    this.lineTo(t1[0], t1[1]);
    this.ellipse(c[0], c[1], r, r, 0, a0, a1, cross > 0);
  }
}

function finite(...v) {
  return v.every(Number.isFinite);
}

function toMatrix(t) {
  if (Array.isArray(t)) return t;
  return [t.a ?? t.m11 ?? 1, t.b ?? t.m12 ?? 0, t.c ?? t.m21 ?? 0, t.d ?? t.m22 ?? 1, t.e ?? t.m41 ?? 0, t.f ?? t.m42 ?? 0];
}

// ---- Gradients ----

/** A gradient, as createLinearGradient / createRadialGradient give it. */
export class PdfGradient {
  constructor(type, coords) {
    this.type = type;
    this.coords = coords;
    this.stops = [];
  }

  addColorStop(offset, color) {
    if (!(offset >= 0 && offset <= 1)) throw new RangeError('The offset must be between 0 and 1');
    const c = parseColor(color);
    if (!c) throw new SyntaxError(`Not a colour: ${color}`);
    this.stops.push({ offset, color: c });
    this.stops.sort((a, b) => a.offset - b.offset);
    this.key = null;
  }
}

const BLENDS = {
  'source-over': 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken',
  lighten: 'Lighten', 'color-dodge': 'ColorDodge', 'color-burn': 'ColorBurn', 'hard-light': 'HardLight',
  'soft-light': 'SoftLight', difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue',
  saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
};

// ---- Fonts as CSS writes them ----

const GENERIC = { serif: 'serif', 'sans-serif': 'sans-serif', monospace: 'monospace', cursive: 'cursive', fantasy: 'sans-serif', 'system-ui': 'sans-serif', 'ui-sans-serif': 'sans-serif', 'ui-serif': 'serif', 'ui-monospace': 'monospace' };

/** A CSS font shorthand ('italic bold 12px serif', px meaning points here) as a text style. */
export function parseCssFont(css) {
  const m = /^\s*((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded)\s+)*)([\d.]+)(px|pt|em|rem|%)?(?:\/[^\s]+)?\s+(.+)$/i.exec(String(css ?? ''));
  if (!m) return null;
  const words = m[1].toLowerCase().split(/\s+/).filter(Boolean);
  let size = parseFloat(m[2]);
  if (m[3] === 'em' || m[3] === 'rem') size *= 10;
  if (m[3] === '%') size *= 0.1;
  const families = m[4].split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, ''));
  let family = null;
  let font = null;
  for (const f of families) {
    const g = GENERIC[f.toLowerCase()];
    if (g) { family = g; break; }
    if (!font) font = f;
  }
  const weight = words.find((w) => /^(bold|bolder|[1-9]00)$/.test(w));
  return {
    size,
    bold: !!weight && (weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600),
    italic: words.includes('italic') || words.includes('oblique'),
    smallCaps: words.includes('small-caps'),
    ...(family ? { family } : { font }),
    ...(words.some((w) => w.endsWith('condensed')) ? { family: 'sans-serif-condensed' } : {}),
  };
}

// ---- Resources ----

/**
 * A page's or form's resources. Names are the same for the same object everywhere in the PDF:
 * pdf.js keeps a font across a form's edge when its name and size match, so a name must never
 * mean two fonts.
 */
class Resources {
  constructor(context, dict, shared) {
    this.ctx = context;
    this.dict = dict;
    this.names = new Map();
    this.shared = shared;
  }

  sub(category) {
    const key = PDFName.of(category);
    let d = this.dict.lookup(key);
    if (!(d instanceof PDFDict)) {
      d = this.ctx.obj({});
      this.dict.set(key, d);
    }
    return d;
  }

  /** The resource name `value` (a ref, or a direct object) has in `category`, added on first use. */
  name(category, prefix, value, key = value) {
    const k = category + '\u0001' + (key instanceof PDFRef ? key.tag : key);
    let name = this.names.get(k);
    if (name) return name;
    const d = this.sub(category);
    const shared = this.shared;
    shared.resValues ??= new Map();
    shared.resNames ??= new Map();
    shared.resCounters ??= new Map();
    // The same object for the same key, whichever canvas asks.
    if (!(value instanceof PDFRef)) {
      if (shared.resValues.has(k)) value = shared.resValues.get(k);
      else shared.resValues.set(k, value);
    }
    name = shared.resNames.get(k);
    if (!name) {
      const i = (shared.resCounters.get(prefix) ?? 0) + 1;
      shared.resCounters.set(prefix, i);
      name = prefix + i;
      shared.resNames.set(k, name);
    }
    // A page of another PDF may use the name already, for something else.
    while (d.has(PDFName.of(name)) && d.get(PDFName.of(name)) !== value) name += 'x';
    d.set(PDFName.of(name), value);
    this.names.set(k, name);
    return name;
  }
}

// ---- The canvas ----

function defaultState() {
  return {
    ctm: IDENTITY,
    fill: BLACK,
    stroke: BLACK,
    alpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    dash: [],
    dashOffset: 0,
    font: '10px sans-serif',
    fontStyle: { size: 10, family: 'sans-serif' },
    textAlign: 'start',
    textBaseline: 'alphabetic',
    direction: 'inherit',
    letterSpacing: 0,
    composite: 'source-over',
    smoothing: true,
  };
}

function freshEmitted() {
  return { fill: undefined, stroke: undefined, gs: undefined, lw: undefined, cap: undefined, join: undefined, miter: undefined, dash: undefined };
}

const CAPS = { butt: 0, round: 1, square: 2 };
const JOINS = { miter: 0, round: 1, bevel: 2 };

/**
 * A canvas drawing into a PDF page (or a form XObject, see createFormCanvas). Its origin is the
 * top-left corner of the page as shown (crop box, turned as /Rotate turns it), y goes down, and
 * one unit is one point. Options: frame 'shown' (default) or 'page' (the media box, unturned).
 */
export class PdfCanvas {
  constructor(target, { frame = 'shown', _form = null } = {}) {
    if (_form) {
      this.doc = _form.doc;
      this.page = null;
      this.form = _form;
      this.base = [1, 0, 0, -1, 0, _form.height];
      this.width = _form.width;
      this.height = _form.height;
      this.res = new Resources(this.doc.context, _form.resources, docState(this.doc));
    } else {
      if (!(target instanceof PDFPage) && !(target && target.node && target.doc)) throw new TypeError('PdfCanvas needs a pdf-lib PDFPage');
      this.doc = target.doc;
      this.page = target;
      this.form = null;
      const f = pageFrame(target, frame);
      this.base = f.matrix;
      this.width = f.width;
      this.height = f.height;
      this.rotation = f.rotation;
      // Normalizing wraps the page's own drawing in q/Q, so what it leaves set can't move or recolour this.
      const { Resources: resources } = target.node.normalizedEntries();
      this.res = new Resources(this.doc.context, resources, docState(this.doc));
    }
    this.state = defaultState();
    this.stack = [];
    this.emitted = freshEmitted();
    this.emittedStack = [];
    this.path = new PdfPath();
    this.imageFormat = 'auto';
    this.imageQuality = 0.85;
    this.closed = true;
    this.out = null;
    this.gsCache = new Map();
    docState(this.doc).canvases.add(this);
    this._open();
  }

  _open() {
    if (!this.closed) return;
    this.closed = false;
    this.out = [];
    this.stack = [];
    this.emitted = freshEmitted();
    this.emittedStack = [];
    if (!this.form) {
      this.ref = this.doc.context.nextRef();
      this.page.node.addContentStream(this.ref);
    } else if (this.form.parts) {
      this.form.parts.push(this.out);
    }
    this.out.push('q', `${mat(this.base)} cm`);
    if (this.form && !this.form.parts) this.form.parts = [this.out];
  }

  _w(s) {
    if (this.closed) this._open();
    this.out.push(s);
  }

  /**
   * Writes what has been drawn into the PDF. The PDF's save does this; drawing again afterwards
   * starts a new content stream on the page, with the current styles and transform but without
   * the clipping and save() levels before it.
   */
  close() {
    if (this.closed) return;
    const out = this.out;
    for (let i = 0; i <= this.stack.length; i++) out.push('Q');
    this.closed = true;
    this.stack = [];
    this.emittedStack = [];
    // Content holds nested lists where text waited for its fonts.
    if (this.form) this.form.write();
    else this.doc.context.assign(this.ref, this.doc.context.flateStream(flat(out)));
    this.out = null;
  }

  // ---- State ----

  /**
   * Saves the state (q). Returns the save count before it, as Android's Canvas.save() does, for
   * restoreToCount().
   */
  save() {
    const count = this.saveCount;
    this._w('q');
    this.stack.push({ ...this.state, dash: this.state.dash.slice() });
    this.emittedStack.push({ ...this.emitted });
    return count;
  }

  /**
   * How many states are saved, counted as Android's Canvas.getSaveCount(): 1 with none saved, one
   * more for each save() not yet restored.
   */
  get saveCount() {
    return this.stack.length + 1;
  }

  /**
   * Restores saved states until `count` is left (Android's Canvas.restoreToCount): with the count
   * saveCount gave (or save() returned) before some drawing, everything that drawing saved and
   * left unrestored is undone, as when it fails partway. Below 1 counts as 1.
   */
  restoreToCount(count) {
    const keep = Math.max(1, Math.floor(Number(count) || 1));
    while (this.stack.length + 1 > keep) this.restore();
  }

  restore() {
    if (!this.stack.length) return;
    this._w('Q');
    this.state = this.stack.pop();
    this.emitted = this.emittedStack.pop();
  }

  reset() {
    while (this.stack.length) this.restore();
    this.state = defaultState();
    this.path = new PdfPath();
  }

  translate(x, y) {
    if (finite(x, y)) this.state.ctm = mul([1, 0, 0, 1, x, y], this.state.ctm);
  }

  rotate(angle) {
    if (!Number.isFinite(angle)) return;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.state.ctm = mul([c, s, -s, c, 0, 0], this.state.ctm);
  }

  scale(x, y = x) {
    if (finite(x, y)) this.state.ctm = mul([x, 0, 0, y, 0, 0], this.state.ctm);
  }

  transform(a, b, c, d, e, f) {
    if (finite(a, b, c, d, e, f)) this.state.ctm = mul([a, b, c, d, e, f], this.state.ctm);
  }

  setTransform(a, b, c, d, e, f) {
    if (a === undefined) return this.resetTransform();
    const m = typeof a === 'object' ? toMatrix(a) : [a, b, c, d, e, f];
    if (finite(...m)) this.state.ctm = m;
  }

  resetTransform() {
    this.state.ctm = IDENTITY;
  }

  /** The current transform, as { a, b, c, d, e, f }. */
  getTransform() {
    const [a, b, c, d, e, f] = this.state.ctm;
    return typeof DOMMatrix !== 'undefined' ? new DOMMatrix([a, b, c, d, e, f]) : { a, b, c, d, e, f };
  }

  get fillStyle() { return this.state.fillCss ?? this.state.fill; }
  set fillStyle(v) {
    if (v instanceof PdfGradient) { this.state.fill = v; this.state.fillCss = v; return; }
    const c = parseColor(v);
    if (c) { this.state.fill = c; this.state.fillCss = v; }
  }

  get strokeStyle() { return this.state.strokeCss ?? this.state.stroke; }
  set strokeStyle(v) {
    if (v instanceof PdfGradient) { this.state.stroke = v; this.state.strokeCss = v; return; }
    const c = parseColor(v);
    if (c) { this.state.stroke = c; this.state.strokeCss = v; }
  }

  get globalAlpha() { return this.state.alpha; }
  set globalAlpha(v) { if (v >= 0 && v <= 1) this.state.alpha = v; }

  get globalCompositeOperation() { return this.state.composite; }
  set globalCompositeOperation(v) { if (v in BLENDS) this.state.composite = v; }

  get lineWidth() { return this.state.lineWidth; }
  set lineWidth(v) { if (v > 0 && Number.isFinite(v)) this.state.lineWidth = v; }

  get lineCap() { return this.state.lineCap; }
  set lineCap(v) { if (v in CAPS) this.state.lineCap = v; }

  get lineJoin() { return this.state.lineJoin; }
  set lineJoin(v) { if (v in JOINS) this.state.lineJoin = v; }

  get miterLimit() { return this.state.miterLimit; }
  set miterLimit(v) { if (v > 0 && Number.isFinite(v)) this.state.miterLimit = v; }

  get lineDashOffset() { return this.state.dashOffset; }
  set lineDashOffset(v) { if (Number.isFinite(v)) this.state.dashOffset = v; }

  setLineDash(segments) {
    if (!Array.isArray(segments) || segments.some((s) => !(s >= 0) || !Number.isFinite(s))) return;
    this.state.dash = segments.length % 2 ? [...segments, ...segments] : segments.slice();
  }

  getLineDash() {
    return this.state.dash.slice();
  }

  get imageSmoothingEnabled() { return this.state.smoothing; }
  set imageSmoothingEnabled(v) { this.state.smoothing = !!v; }

  get font() { return this.state.font; }
  set font(v) {
    const f = parseCssFont(v);
    if (f) { this.state.font = String(v); this.state.fontStyle = f; }
  }

  get textAlign() { return this.state.textAlign; }
  set textAlign(v) { if (['start', 'end', 'left', 'right', 'center'].includes(v)) this.state.textAlign = v; }

  get textBaseline() { return this.state.textBaseline; }
  set textBaseline(v) { if (['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'].includes(v)) this.state.textBaseline = v; }

  get direction() { return this.state.direction; }
  set direction(v) { if (['ltr', 'rtl', 'inherit'].includes(v)) this.state.direction = v; }

  get letterSpacing() { return `${this.state.letterSpacing}px`; }
  set letterSpacing(v) {
    const x = parseFloat(v);
    if (Number.isFinite(x)) this.state.letterSpacing = x;
  }

  // ---- Paths ----

  beginPath() {
    this.path = new PdfPath();
    this.path.m = this.state.ctm;
  }

  _p() {
    this.path.m = this.state.ctm;
    return this.path;
  }

  moveTo(x, y) { this._p().moveTo(x, y); }
  lineTo(x, y) { this._p().lineTo(x, y); }
  bezierCurveTo(a, b, c, d, e, f) { this._p().bezierCurveTo(a, b, c, d, e, f); }
  quadraticCurveTo(a, b, c, d) { this._p().quadraticCurveTo(a, b, c, d); }
  arc(x, y, r, s, e, ccw) { this._p().arc(x, y, r, s, e, ccw); }
  arcTo(x1, y1, x2, y2, r) { this._p().arcTo(x1, y1, x2, y2, r); }
  ellipse(x, y, rx, ry, rot, s, e, ccw) { this._p().ellipse(x, y, rx, ry, rot, s, e, ccw); }
  rect(x, y, w, h) { this._p().rect(x, y, w, h); }
  roundRect(x, y, w, h, r) { this._p().roundRect(x, y, w, h, r); }
  closePath() { this._p().closePath(); }

  /** The path's commands in base (canvas) coordinates: the current path, or a PdfPath placed by the current transform. */
  _cmds(path) {
    if (!(path instanceof PdfPath)) return this.path.cmds;
    if (isIdentity(this.state.ctm)) return path.cmds;
    const m = this.state.ctm;
    return path.cmds.map((c) => {
      if (c[0] === 'Z') return c;
      const out = [c[0]];
      for (let i = 1; i < c.length; i += 2) out.push(...apply(m, c[i], c[i + 1]));
      return out;
    });
  }

  _writePath(cmds, m = null) {
    const parts = [];
    for (const c of cmds) {
      if (c[0] === 'Z') { parts.push('h'); continue; }
      const pts = [];
      for (let i = 1; i < c.length; i += 2) {
        const [x, y] = m ? apply(m, c[i], c[i + 1]) : [c[i], c[i + 1]];
        pts.push(n(x), n(y));
      }
      parts.push(`${pts.join(' ')} ${c[0] === 'M' ? 'm' : c[0] === 'L' ? 'l' : 'c'}`);
    }
    this._w(parts.join('\n'));
  }

  _args(pathOrRule, rule) {
    if (pathOrRule instanceof PdfPath) return { path: pathOrRule, rule: rule === 'evenodd' ? 'evenodd' : 'nonzero' };
    return { path: null, rule: pathOrRule === 'evenodd' ? 'evenodd' : 'nonzero' };
  }

  fill(pathOrRule, rule) {
    const { path, rule: r } = this._args(pathOrRule, rule);
    const cmds = this._cmds(path);
    if (!cmds.length) return;
    const paint = this.state.fill;
    if (paint instanceof PdfGradient) return this._gradientFill(cmds, r, paint);
    if (!this._setFill(paint)) return;
    this._writePath(cmds);
    this._w(r === 'evenodd' ? 'f*' : 'f');
  }

  stroke(path) {
    const cmds = this._cmds(path instanceof PdfPath ? path : null);
    if (!cmds.length) return;
    const paint = this.state.stroke;
    if (paint instanceof PdfGradient) {
      if (!this._setStrokePattern(paint)) return;
    } else if (!this._setStroke(paint)) return;
    this._setLineState();
    const m = this.state.ctm;
    if (isIdentity(m)) {
      this._writePath(cmds);
      this._w('S');
      return;
    }
    // Line widths and dashes are measured in the transformed space, as the canvas measures them.
    const im = inv(m);
    if (!im) return;
    this._w(`q ${mat(m)} cm`);
    this._writePath(cmds, im);
    this._w('S Q');
  }

  clip(pathOrRule, rule) {
    const { path, rule: r } = this._args(pathOrRule, rule);
    const cmds = this._cmds(path);
    if (!cmds.length) {
      // Clipping to nothing hides everything after it.
      this._w('0 0 m h W n');
      return;
    }
    this._writePath(cmds);
    this._w(r === 'evenodd' ? 'W* n' : 'W n');
  }

  fillRect(x, y, w, h) {
    const p = new PdfPath();
    p.rect(x, y, w, h);
    this.fill(p);
  }

  strokeRect(x, y, w, h) {
    const p = new PdfPath();
    p.rect(x, y, w, h);
    this.stroke(p);
  }

  /** A PDF page can't be made see-through again, so this paints the rectangle white (the paper). */
  clearRect(x, y, w, h) {
    const p = new PdfPath();
    p.rect(x, y, w, h);
    const keep = this.state.fill;
    const alpha = this.state.alpha;
    const comp = this.state.composite;
    this.state.fill = { r: 1, g: 1, b: 1, a: 1 };
    this.state.alpha = 1;
    this.state.composite = 'source-over';
    this.fill(p);
    this.state.fill = keep;
    this.state.alpha = alpha;
    this.state.composite = comp;
  }

  // ---- Paint state ----

  /** Sets the fill and stroke alphas and the blend mode (an ExtGState shared across the PDF). */
  _gs(fillAlpha, strokeAlpha) {
    const bm = BLENDS[this.state.composite] ?? 'Normal';
    const key = `${fillAlpha}|${strokeAlpha}|${bm}`;
    if (this.emitted.gs === key) return;
    let name = this.gsCache.get(key);
    if (!name) {
      const dict = { Type: 'ExtGState', ca: fillAlpha, CA: strokeAlpha, BM: bm };
      name = this.res.name('ExtGState', 'UG', this.doc.context.obj(dict), 'gs' + key);
      this.gsCache.set(key, name);
    }
    this._w(`/${name} gs`);
    this.emitted.gs = key;
  }

  _alphaKey(a) {
    return Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000;
  }

  /** Sets the fill colour; false when it draws nothing. */
  _setFill(c, alphaScale = 1) {
    const a = this._alphaKey(c.a * this.state.alpha * alphaScale);
    if (a <= 0) return false;
    this._gs(a, this.emitted.gs ? Number(this.emitted.gs.split('|')[1]) : 1);
    const key = `${n(c.r)} ${n(c.g)} ${n(c.b)} rg`;
    if (this.emitted.fill !== key) {
      this._w(key);
      this.emitted.fill = key;
    }
    return true;
  }

  _setStroke(c) {
    const a = this._alphaKey(c.a * this.state.alpha);
    if (a <= 0) return false;
    this._gs(this.emitted.gs ? Number(this.emitted.gs.split('|')[0]) : 1, a);
    const key = `${n(c.r)} ${n(c.g)} ${n(c.b)} RG`;
    if (this.emitted.stroke !== key) {
      this._w(key);
      this.emitted.stroke = key;
    }
    return true;
  }

  _setLineState() {
    const s = this.state;
    const e = this.emitted;
    if (e.lw !== s.lineWidth) { this._w(`${n(s.lineWidth)} w`); e.lw = s.lineWidth; }
    if (e.cap !== s.lineCap) { this._w(`${CAPS[s.lineCap]} J`); e.cap = s.lineCap; }
    if (e.join !== s.lineJoin) { this._w(`${JOINS[s.lineJoin]} j`); e.join = s.lineJoin; }
    if (e.miter !== s.miterLimit) { this._w(`${n(s.miterLimit)} M`); e.miter = s.miterLimit; }
    const dash = `[${s.dash.map(n).join(' ')}] ${n(s.dashOffset)} d`;
    if (e.dash !== dash) { this._w(dash); e.dash = dash; }
  }

  // ---- Gradients ----

  createLinearGradient(x0, y0, x1, y1) {
    return new PdfGradient('linear', [x0, y0, x1, y1]);
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    if (r0 < 0 || r1 < 0) throw new RangeError('The radii must be non-negative');
    return new PdfGradient('radial', [x0, y0, r0, x1, y1, r1]);
  }

  /** A PDF shading for the gradient's colours (or its alphas, as greys, when `alpha`). */
  _shading(g, alpha = false) {
    const ctx = this.doc.context;
    let stops = g.stops.slice();
    if (stops[0].offset > 0) stops.unshift({ offset: 0, color: stops[0].color });
    if (stops[stops.length - 1].offset < 1) stops.push({ offset: 1, color: stops[stops.length - 1].color });
    const c = (s) => (alpha ? [s.color.a] : [s.color.r, s.color.g, s.color.b]);
    const fns = [];
    const bounds = [];
    const encode = [];
    for (let i = 0; i < stops.length - 1; i++) {
      fns.push(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: c(stops[i]), C1: c(stops[i + 1]), N: 1 }));
      if (i > 0) bounds.push(Math.min(1, Math.max(bounds[bounds.length - 1] ?? 0, stops[i].offset)));
      encode.push(0, 1);
    }
    const fn = fns.length === 1 ? fns[0] : ctx.obj({ FunctionType: 3, Domain: [0, 1], Functions: fns, Bounds: bounds, Encode: encode });
    return ctx.register(ctx.obj({
      ShadingType: g.type === 'linear' ? 2 : 3,
      ColorSpace: alpha ? 'DeviceGray' : 'DeviceRGB',
      Coords: g.coords,
      Function: fn,
      Extend: [true, true],
    }));
  }

  _gradientFill(cmds, rule, g) {
    if (!g.stops.length) return;
    if (g.stops.length === 1) {
      if (!this._setFill(g.stops[0].color)) return;
      this._writePath(cmds);
      this._w(rule === 'evenodd' ? 'f*' : 'f');
      return;
    }
    const alphas = g.stops.map((s) => s.color.a);
    const same = alphas.every((a) => a === alphas[0]);
    const m = this.state.ctm;
    const a = this._alphaKey((same ? alphas[0] : 1) * this.state.alpha);
    if (a <= 0) return;
    this._gs(a, this.emitted.gs ? Number(this.emitted.gs.split('|')[1]) : 1);
    const sh = this.res.name('Shading', 'US', this._shading(g));
    this._w('q');
    this._writePath(cmds);
    this._w(rule === 'evenodd' ? 'W* n' : 'W n');
    this._w(`${mat(m)} cm`);
    if (!same) {
      // Varying transparency: the alphas, as a grey shading, become a soft mask.
      const bbox = this._userBox(cmds, m);
      const ctx = this.doc.context;
      const maskShading = this._shading(g, true);
      const group = ctx.register(ctx.flateStream('/Sh sh', {
        Type: 'XObject', Subtype: 'Form', BBox: bbox, Group: { S: 'Transparency', CS: 'DeviceGray' },
        Resources: { Shading: { Sh: maskShading } },
      }));
      const gs = this.res.name('ExtGState', 'UG', ctx.obj({ Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: group } }), `mask${group.tag}`);
      this._w(`/${gs} gs`);
    }
    this._w(`/${sh} sh`);
    this._w('Q');
  }

  /** The bounds of `cmds` (base coordinates) in the space `m` maps to them, a little larger. */
  _userBox(cmds, m) {
    const im = inv(m) ?? IDENTITY;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cmds) {
      for (let i = 1; i < c.length; i += 2) {
        const [x, y] = apply(im, c[i], c[i + 1]);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    if (x0 === Infinity) return [0, 0, 1, 1];
    return [x0 - 1, y0 - 1, x1 + 1, y1 + 1].map((v) => Math.round(v * 100) / 100);
  }

  _setStrokePattern(g) {
    if (!g.stops.length) return false;
    if (g.stops.length === 1) return this._setStroke(g.stops[0].color);
    const a = this._alphaKey(g.stops[0].color.a * this.state.alpha);
    this._gs(this.emitted.gs ? Number(this.emitted.gs.split('|')[0]) : 1, a);
    const ctx = this.doc.context;
    const pattern = ctx.register(ctx.obj({ PatternType: 2, Shading: this._shading(g), Matrix: mul(this.state.ctm, this.base).map((v) => Math.round(v * 10000) / 10000) }));
    const name = this.res.name('Pattern', 'UP', pattern);
    this._w(`/Pattern CS /${name} SCN`);
    this.emitted.stroke = 'pattern ' + name;
    return true;
  }

  _setFillPattern(g) {
    const a = this._alphaKey(g.stops[0].color.a * this.state.alpha);
    this._gs(a, this.emitted.gs ? Number(this.emitted.gs.split('|')[1]) : 1);
    const ctx = this.doc.context;
    const pattern = ctx.register(ctx.obj({ PatternType: 2, Shading: this._shading(g), Matrix: mul(this.state.ctm, this.base).map((v) => Math.round(v * 10000) / 10000) }));
    const name = this.res.name('Pattern', 'UP', pattern);
    this._w(`/Pattern cs /${name} scn`);
    this.emitted.fill = 'pattern ' + name;
    return true;
  }

  // ---- Images ----

  /**
   * Draws a picture, as the canvas's drawImage does: (image, dx, dy), (image, dx, dy, dw, dh) or
   * (image, sx, sy, sw, sh, dx, dy, dw, dh). `image` is an ImageBitmap, canvas, OffscreenCanvas,
   * loaded HTMLImageElement, ImageData, a pdf-lib PDFImage (doc.embedJpg / embedPng), or what
   * embedImage() returned. A picture is put in the PDF once however often it is drawn.
   */
  drawImage(image, ...a) {
    const info = this._imageInfo(image);
    if (!info) return;
    let sx = 0, sy = 0, sw = info.width, sh = info.height, dx, dy, dw, dh;
    if (a.length === 2) {
      [dx, dy] = a;
      dw = info.width;
      dh = info.height;
    } else if (a.length === 4) {
      [dx, dy, dw, dh] = a;
    } else if (a.length === 8) {
      [sx, sy, sw, sh, dx, dy, dw, dh] = a;
    } else {
      throw new TypeError('drawImage takes 2, 4 or 8 numbers after the image');
    }
    if (!finite(dx, dy, dw, dh, sx, sy, sw, sh) || !dw || !dh || !sw || !sh) return;
    const a0 = this._alphaKey(this.state.alpha);
    if (a0 <= 0) return;
    this._gs(a0, this.emitted.gs ? Number(this.emitted.gs.split('|')[1]) : 1);
    const name = this.res.name('XObject', 'UI', info.ref);
    const m = this.state.ctm;
    this._w('q');
    if (!isIdentity(m)) this._w(`${mat(m)} cm`);
    const cropped = sx !== 0 || sy !== 0 || sw !== info.width || sh !== info.height;
    if (cropped) this._w(`${n(dx)} ${n(dy)} ${n(dw)} ${n(dh)} re W n`);
    const kx = dw / sw;
    const ky = dh / sh;
    const x = dx - sx * kx;
    const y = dy - sy * ky;
    const W = info.width * kx;
    const H = info.height * ky;
    this._w(`${n(W)} 0 0 ${n(-H)} ${n(x)} ${n(y + H)} cm /${name} Do Q`);
  }

  _imageInfo(image) {
    if (!image) return null;
    if (image instanceof PDFImage) return { ref: image.ref, width: image.width, height: image.height };
    if (image.ref instanceof PDFRef && image.width > 0) return image;
    return embedImage(this.doc, image, { format: this.imageFormat, quality: this.imageQuality });
  }

  /** Draws a form made with createFormCanvas, its top-left corner at (x, y), at its size or w × h. */
  drawForm(form, x = 0, y = 0, w, h) {
    const f = form instanceof PdfCanvas ? form.form : form;
    if (!f) return;
    const a0 = this._alphaKey(this.state.alpha);
    if (a0 <= 0) return;
    this._gs(a0, a0);
    const name = this.res.name('XObject', 'UF', f.ref);
    const W = w ?? f.width;
    const H = h ?? f.height;
    const m = this.state.ctm;
    this._w('q');
    if (!isIdentity(m)) this._w(`${mat(m)} cm`);
    this._w(`${n(W / f.width)} 0 0 ${n(-H / f.height)} ${n(x)} ${n(y + H)} cm /${name} Do Q`);
  }

  // ---- Text ----

  /** The canvas's text style: its font, with letter spacing, plus `extra` (a style object). */
  _textStyle(extra) {
    const s = { ...this.state.fontStyle };
    if (this.state.letterSpacing) s.spacing = this.state.letterSpacing;
    if (extra) Object.assign(s, extra);
    return s;
  }

  /**
   * Draws one line of text, as the canvas does: at (x, y) by textAlign and textBaseline, in
   * fillStyle and font; maxWidth squeezes it narrower. With a style object as the fourth
   * argument (see resolveStyle in fonts.js; its color defaults to fillStyle), it is drawn in that.
   * The fonts load if they need to: the text is drawn into its place in the page once they have.
   */
  fillText(text, x, y, maxWidthOrStyle) {
    this._text(String(text ?? ''), x, y, maxWidthOrStyle, false);
  }

  /** As fillText, with the letters' outlines stroked (strokeStyle, lineWidth). */
  strokeText(text, x, y, maxWidthOrStyle) {
    this._text(String(text ?? ''), x, y, maxWidthOrStyle, true);
  }

  _text(text, x, y, arg, strokeIt) {
    if (!text || !finite(x, y)) return;
    // The canvas draws line breaks as spaces.
    text = text.replace(/[\n\r\t\f\v]/g, ' ');
    const extra = arg && typeof arg === 'object' ? arg : null;
    const maxWidth = typeof arg === 'number' ? arg : undefined;
    const style = this._textStyle(extra);
    const paint = strokeIt ? this.state.stroke : (extra && extra.color != null ? parseColor(extra.color) : this.state.fill);
    if (!(paint instanceof PdfGradient)) style.color = paint ?? BLACK;
    const draw = () => {
      const r = resolveStyle(style);
      let m = measureTextSync(text, r);
      if (maxWidth !== undefined && maxWidth >= 0 && m.width > maxWidth) {
        m = measureTextSync(text, resolveStyle({ ...style, scaleX: ((style.scaleX ?? 1) * maxWidth) / Math.max(m.width, 1e-9) }));
      }
      const rtl = this.state.direction === 'rtl';
      const align = this.state.textAlign;
      const w = m.width;
      let dx = 0;
      if (align === 'center') dx = -w / 2;
      else if (align === 'right' || (align === 'end' && !rtl) || (align === 'start' && rtl)) dx = -w;
      const asc = m.ascent;
      const desc = m.descent;
      let dy = 0;
      switch (this.state.textBaseline) {
        case 'top': dy = asc; break;
        case 'hanging': dy = asc * 0.8; break;
        case 'middle': dy = (asc - desc) / 2; break;
        case 'bottom': case 'ideographic': dy = -desc; break;
        default: dy = 0;
      }
      const layout = m.layout;
      const items = layout.items(x + dx, y + dy - layout.firstBaseline);
      this.drawItems(items, { stroke: strokeIt, paint: paint instanceof PdfGradient ? paint : null });
    };
    if (fontsReady(text, style)) draw();
    else this._deferred(() => ensureFonts(text, style), draw);
  }

  /** Runs `draw` once `wait()` resolves, its output going where it would have gone now. */
  _deferred(wait, draw) {
    if (this.closed) this._open();
    const slot = [];
    this.out.push(slot);
    const snapshot = { ...this.state, dash: this.state.dash.slice() };
    track(this.doc, Promise.resolve(wait()).then(() => {
      const keep = { out: this.out, state: this.state, emitted: this.emitted, closed: this.closed };
      this.out = slot;
      this.closed = false;
      this.state = snapshot;
      this.emitted = freshEmitted();
      slot.push('q');
      try {
        draw();
      } finally {
        slot.push('Q');
        this.out = keep.out;
        this.state = keep.state;
        this.emitted = keep.emitted;
        this.closed = keep.closed;
      }
    }));
  }

  /** The canvas's measureText: a TextMetrics-like object for one line in the current font. Needs its fonts loaded. */
  measureText(text) {
    const style = this._textStyle(null);
    if (!fontsReady(text, style)) throw new Error('measureText needs its fonts loaded first: await ensureFonts(text, style)');
    const m = measureTextSync(String(text ?? ''), style);
    const align = this.state.textAlign;
    const rtl = this.state.direction === 'rtl';
    const x0 = align === 'center' ? m.width / 2 : align === 'right' || (align === 'end' && !rtl) || (align === 'start' && rtl) ? m.width : 0;
    return {
      width: m.width,
      actualBoundingBoxLeft: x0 - m.ink.left,
      actualBoundingBoxRight: m.ink.right - x0,
      actualBoundingBoxAscent: -m.ink.top,
      actualBoundingBoxDescent: m.ink.bottom,
      fontBoundingBoxAscent: m.ascent,
      fontBoundingBoxDescent: m.descent,
      emHeightAscent: m.ascent,
      emHeightDescent: m.descent,
      alphabeticBaseline: 0,
      hangingBaseline: m.ascent * 0.8,
      ideographicBaseline: -m.descent,
    };
  }

  /**
   * Draws a ParagraphLayout (layout.js) with its top-left corner at (x, y), in the current
   * transform and global alpha. Same as layout.draw(canvas, x, y).
   */
  drawLayout(layout, x = 0, y = 0) {
    this.drawItems(layout.items(x, y));
  }

  /** Draws layout items (ParagraphLayout.items()). */
  drawItems(items, { stroke = false, paint = null } = {}) {
    for (const it of items) {
      switch (it.kind) {
        case 'rect': {
          const p = new PdfPath();
          p.rect(it.x, it.y, it.w, it.h);
          this._fillWith(p, it.color);
          break;
        }
        case 'line': {
          const keep = { ...this.state };
          this.state.stroke = it.color;
          this.state.lineWidth = it.width;
          this.state.dash = [];
          this.state.lineCap = 'butt';
          const p = new PdfPath();
          p.moveTo(it.x1, it.y1);
          p.lineTo(it.x2, it.y2);
          this.stroke(p);
          this.state = keep;
          break;
        }
        case 'glyphs':
          this._glyphs(it, stroke, paint);
          break;
        case 'fallback':
          this._fallback(it);
          break;
        case 'object':
          it.obj.draw?.(this, { x: it.x, y: it.y, width: it.w, height: it.h });
          break;
        case 'link':
          this.link(it.x, it.y, it.w, it.h, it.link);
          break;
        default:
          break;
      }
    }
  }

  _fillWith(path, color) {
    const keep = this.state.fill;
    this.state.fill = color;
    this.fill(path);
    this.state.fill = keep;
  }

  _textPaint(color, stroke, paint) {
    if (paint) return stroke ? this._setStrokePattern(paint) : this._setFillPattern(paint);
    return stroke ? this._setStroke(color) : this._setFill(color);
  }

  /** Writes a glyph run as PDF text (see pdffont.js for the codes and the text they map to). */
  _glyphs(run, stroke = false, paint = null) {
    if (!run.gid.length) return;
    if (!this._textPaint(run.color, stroke, paint)) return;
    if (stroke) this._setLineState();
    const ef = embeddedFont(this.doc, run.font);
    const S = run.size;
    const hs = run.scaleX;
    const skew = run.slant ? ITALIC_SKEW : 0;
    const m = this.state.ctm;
    const wrap = !isIdentity(m);
    const ops = [];
    if (wrap) ops.push(`q ${mat(m)} cm`);
    // Copying and searching take the run's own text where its glyphs reorder or join letters.
    if (run.actualText) ops.push(`/Span <</ActualText <FEFF${utf16Hex(run.actualText)}>>> BDC`);
    let fontName = null;
    let tj = [];
    let cur = 0;
    let rise = 0;
    let open = false;
    const flush = () => {
      if (tj.length) ops.push(`[${tj.join('')}] TJ`);
      tj = [];
    };
    // Letter spacing counts as part of each letter's width, so viewers read spaced-out words as words.
    const spacing = run.letterSpacing ? (run.letterSpacing / S) * 1000 : 0;
    const begin = (t) => {
      ops.push('BT');
      if (stroke) ops.push('1 Tr');
      ops.push(`${n(hs)} 0 ${n(skew)} -1 ${n(run.x + t * hs)} ${n(run.y)} Tm`);
      cur = t;
      fontName = null;
      rise = 0;
      open = true;
    };
    const end = () => {
      if (!open) return;
      flush();
      if (rise) ops.push('0 Ts');
      if (stroke) ops.push('0 Tr');
      ops.push('ET');
      open = false;
    };
    const setFont = (f) => {
      const name = this.res.name('Font', 'UT', f.ref);
      if (name !== fontName) {
        flush();
        ops.push(`/${name} ${n(S)} Tf`);
        fontName = name;
      }
    };
    for (let i = 0; i < run.gid.length; i++) {
      // Where the glyph goes along the text line, in unscaled points.
      const t = (run.gx[i] + run.gdx[i]) / hs;
      const text = run.gtext[i];
      if (text == null) {
        // A glyph standing for no text (a dotted circle shaping put in, say): drawn as its outline.
        end();
        this._outline(ops, run, i, S, hs, skew);
        continue;
      }
      const own = run.font.advance(run.gid[i]);
      const g = ef.code(run.gid[i], text, spacing && own > 0 ? own * 1000 + spacing : undefined);
      if (!open) begin(t);
      setFont(g.font);
      const dyi = run.gdy[i];
      if (Math.abs(dyi - rise) > 1e-4) {
        flush();
        ops.push(`${n(dyi)} Ts`);
        rise = dyi;
      }
      const adj = ((cur - t) / S) * 1000;
      if (Math.abs(adj) > 0.01) tj.push(n(Math.round(adj * 100) / 100));
      cur = t;
      tj.push(`<${g.code.toString(16).padStart(4, '0')}>`);
      cur += (g.width / 1000) * S;
      const extra = run.gextra[i];
      if (extra) {
        // The glyph's marks, on an invisible glyph of no width right after it.
        const c = ef.code(run.font.blankGid, extra, 0);
        setFont(c.font);
        tj.push(`<${c.code.toString(16).padStart(4, '0')}>`);
      }
    }
    end();
    if (run.actualText) ops.push('EMC');
    if (wrap) ops.push('Q');
    this._w(ops.join('\n'));
  }

  /** A glyph's outline as a filled path, placed as the text would place it. */
  _outline(ops, run, i, S, hs, skew) {
    const cmds = run.font.outline(run.gid[i]);
    if (!cmds.length) return;
    const k = S / run.font.upm;
    const ox = run.x + run.gx[i] + run.gdx[i];
    const oy = run.y - run.gdy[i];
    const parts = [`q ${n(k * hs)} 0 ${n(skew * k)} ${n(-k)} ${n(ox)} ${n(oy)} cm`];
    let last = [0, 0];
    for (const c of cmds) {
      const a = c.args;
      switch (c.command) {
        case 'moveTo': parts.push(`${n(a[0])} ${n(a[1])} m`); last = [a[0], a[1]]; break;
        case 'lineTo': parts.push(`${n(a[0])} ${n(a[1])} l`); last = [a[0], a[1]]; break;
        case 'quadraticCurveTo': {
          const [qx, qy, x, y] = a;
          parts.push(`${n(last[0] + (2 / 3) * (qx - last[0]))} ${n(last[1] + (2 / 3) * (qy - last[1]))} ${n(x + (2 / 3) * (qx - x))} ${n(y + (2 / 3) * (qy - y))} ${n(x)} ${n(y)} c`);
          last = [x, y];
          break;
        }
        case 'bezierCurveTo': parts.push(`${a.map(n).join(' ')} c`); last = [a[4], a[5]]; break;
        case 'closePath': parts.push('h'); break;
        default: break;
      }
    }
    parts.push('f Q');
    ops.push(parts.join('\n'));
  }

  /** Characters no bundled font has: the browser's drawing of them, with their text invisible over it. */
  _fallback(it) {
    const m = this.state.ctm;
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const mask = usesMask(it.size * scale, it.emoji);
    const px = fallbackResolution(it.size * scale, mask);
    const bmp = fallbackBitmap(it.text, it.family, it.bold, it.italic, it.rtl, px, it.emoji);
    const S = it.size;
    const hs = it.scaleX;
    if (bmp) {
      // A mask is painted in the fill colour; other pictures carry their colours.
      const info = mask ? fallbackMask(this.doc, bmp) : fallbackImage(this.doc, bmp, it.emoji ? null : it.color);
      const drawn = mask ? this._setFill(it.color) : this._alphaKey(this.state.alpha) > 0;
      if (drawn) {
        if (!mask) this._gs(this._alphaKey(this.state.alpha), this.emitted.gs ? Number(this.emitted.gs.split('|')[1]) : 1);
        const name = this.res.name('XObject', 'UI', info.ref);
        const W = (bmp.width / bmp.pxPerEm) * S * hs;
        const H = (bmp.height / bmp.pxPerEm) * S;
        const x = it.x + (it.letterSpacing * hs) / 2 - bmp.left * S * hs;
        const y = it.y - bmp.top * S;
        this._w('q');
        if (!isIdentity(m)) this._w(`${mat(m)} cm`);
        this._w(`${n(W)} 0 0 ${n(-H)} ${n(x)} ${n(y + H)} cm /${name} Do Q`);
      }
    }
    // The text, invisible, as wide as the picture, so it can be found and copied.
    const font = it.carrier;
    if (!font || !it.width) return;
    const ef = embeddedFont(this.doc, font);
    let text = it.text.replace(/[\p{Cc}]/gu, '');
    if (!text) return;
    // Viewers read a line's text in the order it is drawn, left to right, and turn right-to-left
    // runs back to reading order themselves (pdf.js does, as for any PDF made from visual glyphs):
    // so a right-to-left run's text goes in drawing order, whole characters reversed.
    if (it.rtl) text = graphemes(text).reverse().join('');
    const { font: f, code } = ef.code(font.blankGid, text, (it.width / (S * hs)) * 1000);
    const name = this.res.name('Font', 'UT', f.ref);
    const ops = [];
    if (!isIdentity(m)) ops.push(`q ${mat(m)} cm`);
    ops.push('BT', '3 Tr', `/${name} ${n(S)} Tf`, `${n(hs)} 0 0 -1 ${n(it.x)} ${n(it.y)} Tm`, `[<${code.toString(16).padStart(4, '0')}>] TJ`, '0 Tr', 'ET');
    if (!isIdentity(m)) ops.push('Q');
    this._w(ops.join('\n'));
  }

  // ---- Links and destinations ----

  /** The page's own coordinates of canvas point (x, y), in the current transform. */
  toPage(x, y) {
    return apply(this.base, ...apply(this.state.ctm, x, y));
  }

  /**
   * Makes the rectangle (in the current transform) a link: to `target.url` (or a string URL), to
   * the named destination `target.dest` (see addDestination), or to page `target.page`
   * (0-based) at `target.y` points from the top of that page as shown. Links can't go in forms.
   */
  link(x, y, w, h, target) {
    if (!this.page || !finite(x, y, w, h) || !target) return;
    const action = linkAction(this.doc, target);
    if (!action) return;
    const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => this.toPage(px, py));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v * 100) / 100);
    if (rect[2] - rect[0] < 0.01 || rect[3] - rect[1] < 0.01) return;
    const ctx = this.doc.context;
    const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], F: 4, P: this.page.ref, ...action }));
    this.page.node.addAnnot(annot);
  }

  /** Names the point (x, y) of this page (current transform) as destination `name`, for links and bookmarks. */
  addDestination(name, x = 0, y = 0) {
    if (!this.page) return;
    const [left, top] = this.toPage(x, y);
    addNamedDestination(this.doc, String(name), this.page, left, top);
  }
}

// ---- Pictures in the PDF ----

/**
 * Puts a picture into `doc` once (by object, so drawing it again reuses it) and returns
 * { ref, width, height } for drawImage. Opaque pictures become JPEG (format 'auto' or 'jpeg',
 * at `quality`), pictures with transparency lossless with a soft mask (or 'png' for lossless
 * always). JPEG encoding finishes in the background before the PDF is saved.
 */
export function embedImage(doc, image, { format = 'auto', quality = 0.85 } = {}) {
  const s = docState(doc);
  const cached = typeof image === 'object' ? s.images.get(image) : null;
  if (cached && cached.format === format) return cached;
  const pixels = readPixels(image);
  if (!pixels) return null;
  const { width, height, data, canvas } = pixels;
  const ctx = doc.context;
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = true; break; }
  const ref = ctx.nextRef();
  const rgb = () => {
    const out = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      out[j] = data[i];
      out[j + 1] = data[i + 1];
      out[j + 2] = data[i + 2];
    }
    return out;
  };
  const base = { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 };
  if (alpha || format === 'png' || !canvas) {
    const dict = { ...base };
    if (alpha) {
      const a = new Uint8Array(width * height);
      for (let i = 3, j = 0; i < data.length; i += 4, j++) a[j] = data[i];
      dict.SMask = ctx.register(ctx.flateStream(a, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
    }
    ctx.assign(ref, ctx.flateStream(rgb(), dict));
  } else {
    track(doc, (async () => {
      let bytes = null;
      try {
        const blob = canvas.convertToBlob
          ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
          : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.type === 'image/jpeg') bytes = new Uint8Array(await blob.arrayBuffer());
      } catch {
        bytes = null;
      }
      if (bytes) ctx.assign(ref, ctx.stream(bytes, { ...base, Filter: 'DCTDecode' }));
      else ctx.assign(ref, ctx.flateStream(rgb(), base));
    })());
  }
  const info = { ref, width, height, format };
  if (typeof image === 'object') s.images.set(image, info);
  return info;
}

/** The pixels of a picture source: { width, height, data (RGBA), canvas }. */
function readPixels(image) {
  const pixelsOnly = image && image.data && typeof image.getContext !== 'function' && image.naturalWidth === undefined;
  if (pixelsOnly && image.width > 0 && image.height > 0 && image.data.length === image.width * image.height * 4) {
    return { width: image.width, height: image.height, data: image.data, canvas: toCanvas(image) };
  }
  const w = image?.naturalWidth || image?.videoWidth || image?.displayWidth || image?.width;
  const h = image?.naturalHeight || image?.videoHeight || image?.displayHeight || image?.height;
  if (!(w > 0 && h > 0)) return null;
  const canvas = makeCanvas(w, h);
  if (!canvas) return null;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(image, 0, 0, w, h);
  const data = c.getImageData(0, 0, w, h).data;
  return { width: w, height: h, data, canvas };
}

function toCanvas(imageData) {
  const canvas = makeCanvas(imageData.width, imageData.height);
  if (!canvas) return null;
  try {
    const data = imageData instanceof ImageData ? imageData : new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
    canvas.getContext('2d').putImageData(data, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

function makeCanvas(w, h) {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
  } catch {
    // No canvas here.
  }
  return null;
}

/** A fallback drawing (fallback.js) as a 1-bit image mask, painted in the fill colour; made once per PDF. */
function fallbackMask(doc, bmp) {
  const s = docState(doc);
  s.fallbackMasks ??= new Map();
  let info = s.fallbackMasks.get(bmp.key);
  if (info) return info;
  const { width, height, rgba } = bmp;
  const row = (width + 7) >> 3;
  const bits = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= 128) bits[y * row + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const ctx = doc.context;
  info = { ref: ctx.register(ctx.flateStream(bits, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ImageMask: true, BitsPerComponent: 1, Decode: [1, 0], Interpolate: true })) };
  s.fallbackMasks.set(bmp.key, info);
  return info;
}

/** The image of a fallback drawing (fallback.js) in `color` (null: its own colours), made once per PDF. */
function fallbackImage(doc, bmp, color) {
  const s = docState(doc);
  let byColor = s.fallbackImages.get(bmp.key);
  if (!byColor) {
    byColor = new Map();
    s.fallbackImages.set(bmp.key, byColor);
  }
  const key = color ? `${color.r},${color.g},${color.b},${color.a}` : '';
  let info = byColor.get(key);
  if (info) return info;
  const ctx = doc.context;
  const { width, height, rgba } = bmp;
  if (!byColor.mask) {
    const a = new Uint8Array(width * height);
    for (let i = 3, j = 0; i < rgba.length; i += 4, j++) a[j] = rgba[i];
    byColor.mask = ctx.register(ctx.flateStream(a, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  }
  const rgb = new Uint8Array(width * height * 3);
  if (color) {
    const r = Math.round(color.r * 255), g = Math.round(color.g * 255), b = Math.round(color.b * 255);
    for (let j = 0; j < rgb.length; j += 3) { rgb[j] = r; rgb[j + 1] = g; rgb[j + 2] = b; }
  } else {
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  }
  const dict = { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: byColor.mask, Interpolate: true };
  info = { ref: ctx.register(ctx.flateStream(rgb, dict)) };
  if (color && color.a < 1) {
    // A see-through colour: the mask's alpha scaled.
    const a = new Uint8Array(width * height);
    for (let i = 3, j = 0; i < rgba.length; i += 4, j++) a[j] = Math.round(rgba[i] * color.a);
    const mask = ctx.register(ctx.flateStream(a, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
    info = { ref: ctx.register(ctx.flateStream(rgb, { ...dict, SMask: mask })) };
  }
  byColor.set(key, info);
  return info;
}

// ---- Forms ----

/**
 * A canvas drawing into a new form XObject `width` × `height` points (origin top-left, y down),
 * to be drawn on pages with canvas.drawForm(form, x, y, w, h) as often as needed: a watermark
 * drawn once and put on every page, say.
 */
export function createFormCanvas(doc, width, height) {
  const ctx = doc.context;
  const form = {
    doc, width, height, ref: ctx.nextRef(), resources: ctx.obj({}), parts: null,
    write() {
      const content = (this.parts ?? []).map((p) => flat(p)).join('\n');
      // A transparency group: drawn see-through, it fades as a whole, as a canvas drawn with globalAlpha does.
      ctx.assign(this.ref, ctx.flateStream(content, {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: this.resources,
        Group: { S: 'Transparency', CS: 'DeviceRGB' },
      }));
    },
  };
  // Written now as well, empty: savePdf drops what nothing reaches before the content is written,
  // and the pictures and shadings the form uses are reached through it.
  form.write();
  const canvas = new PdfCanvas(null, { _form: form });
  return canvas;
}

function flat(parts) {
  let s = '';
  for (const p of parts) {
    if (Array.isArray(p)) {
      if (p.length) s += flat(p);
    } else s += p + '\n';
  }
  return s;
}

// ---- Links, destinations and bookmarks ----

function linkAction(doc, target) {
  if (typeof target === 'string') target = { url: target };
  if (target.url) {
    const url = String(target.url).trim();
    // Only links a reader can follow safely: no scripts or data hidden in the PDF.
    if (!/^(https?:|mailto:|tel:|ftp:)/i.test(url)) return null;
    return { A: doc.context.obj({ S: 'URI', URI: PDFString.of(asciiUrl(url)) }) };
  }
  if (target.dest != null) return { Dest: PDFHexString.fromText(String(target.dest)) };
  if (Number.isInteger(target.page)) {
    const dest = explicitDest(doc, target.page, target.y ?? 0, target.x);
    return dest ? { Dest: dest } : null;
  }
  return null;
}

function asciiUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return encodeURI(url);
  }
}

/**
 * The pages of `doc`. A page tree that loops or is damaged makes pdf-lib overflow its stack or
 * throw a TypeError: that is a PDF that can't be opened, UserError('pdf_import_failed').
 */
function pagesOf(doc) {
  try {
    return doc.getPages();
  } catch {
    throw new UserError('pdf_import_failed');
  }
}

/** [page /XYZ left top null] for a point on page `index`, `y` points from the top of the page as shown. */
function explicitDest(doc, index, y = 0, x = null) {
  const pages = pagesOf(doc);
  if (!pages.length) return null;
  const page = pages[Math.max(0, Math.min(pages.length - 1, index))];
  const f = pageFrame(page);
  const [left, top] = apply(f.matrix, x ?? 0, y);
  return doc.context.obj([page.ref, PDFName.of('XYZ'), x == null ? null : Math.round(left * 100) / 100, Math.round(top * 100) / 100, null]);
}

/** Names a point (page coordinates) of `page` (a PDFPage) as destination `name`. */
export function addNamedDestination(doc, name, page, left, top) {
  const s = docState(doc);
  s.dests.push({ name, page, left, top });
  s.writeDests ??= () => writeDests(doc, s);
}

function writeDests(doc, s) {
  if (!s.dests.length) return;
  const ctx = doc.context;
  const catalog = doc.catalog;
  let names = catalog.lookup(PDFName.of('Names'));
  if (!(names instanceof PDFDict)) {
    names = ctx.obj({});
    catalog.set(PDFName.of('Names'), names);
  }
  const entries = new Map();
  const old = names.lookup(PDFName.of('Dests'));
  if (old instanceof PDFDict) {
    const arr = old.lookup(PDFName.of('Names'));
    if (arr instanceof PDFArray) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const k = arr.lookup(i);
        if (k && typeof k.decodeText === 'function') entries.set(k.decodeText(), arr.get(i + 1));
      }
    }
  }
  for (const d of s.dests) {
    entries.set(d.name, ctx.obj([d.page.ref, PDFName.of('XYZ'), Math.round(d.left * 100) / 100, Math.round(d.top * 100) / 100, null]));
  }
  // Name trees are sorted by their names' bytes (UTF-16 here).
  const sorted = [...entries.keys()].sort((a, b) => (utf16Hex(a) < utf16Hex(b) ? -1 : utf16Hex(a) > utf16Hex(b) ? 1 : 0));
  const arr = [];
  for (const k of sorted) arr.push(PDFHexString.fromText(k), entries.get(k));
  names.set(PDFName.of('Dests'), ctx.obj({ Names: arr }));
}

/**
 * Bookmarks (the PDF's outline), from a tree of items as the EPUB table of contents gives them:
 * { title, page (0-based), top (PDF points from the page's bottom, as the app's OutlineItem) or
 * y (points from the top of the page as shown), or dest (a named destination); children, open }.
 * Top-level items show; their children are folded unless `open`. Replaces any outline the PDF had.
 */
export function addOutline(doc, items) {
  const ctx = doc.context;
  const pages = pagesOf(doc);
  const list = (items ?? []).filter((it) => it && it.title != null);
  if (!list.length || !pages.length) return null;
  const rootRef = ctx.nextRef();
  const dest = (it) => {
    if (it.dest != null) return PDFHexString.fromText(String(it.dest));
    const page = pages[Math.max(0, Math.min(pages.length - 1, it.page | 0))];
    let top;
    if (typeof it.top === 'number') top = it.top;
    else {
      const f = pageFrame(page);
      top = apply(f.matrix, 0, it.y ?? 0)[1];
    }
    return ctx.obj([page.ref, PDFName.of('XYZ'), 0, Math.round(top), null]);
  };
  // Returns how many items show below `parent` when it is open.
  const build = (children, parentRef) => {
    const refs = children.map(() => ctx.nextRef());
    let visible = 0;
    children.forEach((it, i) => {
      const kids = (it.children ?? []).filter((c) => c && c.title != null);
      const dict = {
        Title: PDFHexString.fromText(String(it.title).slice(0, 500)),
        Parent: parentRef,
        Dest: dest(it),
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < refs.length - 1) dict.Next = refs[i + 1];
      if (kids.length) {
        const below = build(kids, refs[i]);
        dict.First = below.first;
        dict.Last = below.last;
        dict.Count = it.open ? below.count : -below.count;
        if (it.open) visible += below.count;
      }
      visible++;
      ctx.assign(refs[i], ctx.obj(dict));
    });
    return { first: refs[0], last: refs[refs.length - 1], count: visible };
  };
  const top = build(list, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  return rootRef;
}
