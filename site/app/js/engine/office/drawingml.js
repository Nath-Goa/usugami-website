// DrawingML, the drawing vocabulary Word, PowerPoint and Excel share: themes, colours, fills,
// outlines and arrowheads, preset and freeform shapes, and their transforms, drawn on a PdfCanvas
// (engine/text). A port of the app's DrawingML.kt, with the shape drawing and the a:xfrm and
// a:custGeom reading of PptxConverter.kt that any converter drawing shapes needs.
//
// Lengths are points, the origin is the top-left corner and y goes down. Rectangles are
// { x, y, width, height } (an OfficeRect), or { left, top, right, bottom } (Android's RectF).
// Colours are ARGB numbers (see colors.js).
import { PdfPath } from '../text/canvas.js';
import { OfficeColors } from './colors.js';
import { OfficeUnits, OfficeRect } from './office-formats.js';
import { PathMeasure } from './path-measure.js';
import { toDoubleOrNull, trim } from './xlsx-numbers-kt.js';

const f = Math.fround;

/** `r` as { x, y, width, height }, from an OfficeRect or a RectF-like { left, top, right, bottom }. */
export function box(r) {
  if (r == null) return { x: 0, y: 0, width: 0, height: 0 };
  if (typeof r.left === 'number' && typeof r.right === 'number' && !(r instanceof OfficeRect)) {
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  }
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

// ---------------------------------------------------------------------------------------------
// Themes

/**
 * A theme (theme1.xml): the colour scheme (a Map from "dk1", "accent1"... to ARGB colours) and the
 * heading ("major") and body ("minor") fonts that documents refer to by name.
 */
export class OfficeTheme {
  constructor(colors, majorFont, minorFont) {
    this.colors = colors;
    this.majorFont = majorFont;
    this.minorFont = minorFont;
  }

  /** A theme font reference such as "+mn-lt" or "minorHAnsi", or `name` itself. */
  font(name) {
    if (name == null) return null;
    if (name.startsWith('+mj') || name.startsWith('major')) return this.majorFont;
    if (name.startsWith('+mn') || name.startsWith('minor')) return this.minorFont;
    return name;
  }

  /** A scheme colour by name ("accent1"), or null. */
  color(name) {
    return this.colors.get(name) ?? null;
  }

  /**
   * Reads the theme at `path` of `pkg` (an OfficePackage); Office's default theme when `path` is
   * null or there's no such part. Throws XmlError for a damaged theme, as the app.
   */
  static async read(pkg, path) {
    const x = path != null ? await pkg.xml(path) : null;
    if (!x) return OfficeTheme.DEFAULT;
    const colors = new Map(OfficeTheme.DEFAULT.colors);
    let major = null;
    let minor = null;
    for (const elements of x.children('themeElements')) {
      for (const part of elements.children()) {
        if (part.name === 'clrScheme') {
          for (const entry of part.children()) {
            for (const c of entry.children()) {
              const color = readColor(c, () => null);
              if (color != null) colors.set(entry.name, color);
            }
          }
        } else if (part.name === 'fontScheme') {
          for (const which of part.children()) {
            for (const font of which.children('latin')) {
              const face = font.attr('typeface') || null;
              if (which.name === 'majorFont') major = face;
              else if (which.name === 'minorFont') minor = face;
            }
          }
        }
      }
    }
    return new OfficeTheme(colors, major ?? OfficeTheme.DEFAULT.majorFont, minor ?? OfficeTheme.DEFAULT.minorFont);
  }
}

/** Office's own default theme, for documents without one. */
OfficeTheme.DEFAULT = new OfficeTheme(
  new Map([
    ['dk1', 0xff000000], ['lt1', 0xffffffff], ['dk2', 0xff44546a], ['lt2', 0xffe7e6e6],
    ['accent1', 0xff4472c4], ['accent2', 0xffed7d31], ['accent3', 0xffa5a5a5],
    ['accent4', 0xffffc000], ['accent5', 0xff5b9bd5], ['accent6', 0xff70ad47],
    ['hlink', 0xff0563c1], ['folHlink', 0xff954f72],
  ]),
  'Calibri Light',
  'Calibri',
);

// ---------------------------------------------------------------------------------------------
// Colours

const VALUELESS_MODIFIERS = new Set(['inv', 'gray', 'comp']);

/**
 * Reads the DrawingML colour element `x` (a:srgbClr, a:schemeClr, a:sysClr, a:prstClr,
 * a:scrgbClr, a:hslClr), with its modifiers (lighter, darker, transparent...). `scheme(name)`
 * gives a scheme colour by name (or null). Null for an element that isn't a colour.
 */
export function readColor(x, scheme) {
  let base;
  switch (x.name) {
    case 'srgbClr': base = OfficeColors.hex(x.attr('val')); break;
    case 'schemeClr': {
      const v = x.attr('val');
      base = v != null ? scheme(v) ?? null : null;
      break;
    }
    case 'sysClr': base = OfficeColors.hex(x.attr('lastClr')) ?? (x.attr('val') === 'window' ? 0xffffffff : 0xff000000); break;
    case 'prstClr': base = OfficeColors.preset(x.attr('val')); break;
    case 'scrgbClr': {
      const c = (name) => {
        const v = Math.trunc(f(f(f(x.percentAttr(name) ?? 0) / 100000) * 255));
        return v < 0 ? 0 : v > 255 ? 255 : v;
      };
      base = ((0xff << 24) | (c('r') << 16) | (c('g') << 8) | c('b')) >>> 0;
      break;
    }
    case 'hslClr': base = OfficeColors.modify(0xff808080, []); break;
    default: return null;
  }
  const modifiers = [];
  for (const m of x.children()) {
    const value = m.percentAttr('val');
    if (value != null) modifiers.push([m.name, value]);
    // The changes that take no value: the inverse, grey and complementary colours.
    else if (VALUELESS_MODIFIERS.has(m.name)) modifiers.push([m.name, 0]);
  }
  return base == null ? null : OfficeColors.modify(base, modifiers);
}

/** The colour among `x`'s children (the last, when there are several), or null. */
function childColor(x, scheme) {
  let color = null;
  for (const c of x.children()) {
    const v = readColor(c, scheme);
    if (v != null) color = v;
  }
  return color;
}

// ---------------------------------------------------------------------------------------------
// Fills and outlines

/**
 * What fills a shape, a background or a table cell: { type: 'none' }, { type: 'solid', color },
 * { type: 'gradient', stops: [[position 0..1, color]...], angle (degrees, clockwise from
 * left-to-right), radial }, or { type: 'image', path, crop ([left, top, right, bottom] shares cut
 * off) or null, tile }.
 */
export const Fill = Object.freeze({
  NONE: Object.freeze({ type: 'none' }),
  solid: (color) => ({ type: 'solid', color }),
  gradient: (stops, angle, radial) => ({ type: 'gradient', stops, angle, radial }),
  image: (path, crop = null, tile = false) => ({ type: 'image', path, crop, tile }),

  /** A single colour standing in for `fill`, for text contrast and the like; null for none. */
  mainColor(fill) {
    if (fill?.type === 'solid') return fill.color;
    if (fill?.type === 'gradient') return fill.stops[0]?.[1] ?? null;
    return null;
  },
});

/**
 * Reads the fill element `x` (a:solidFill, a:gradFill, a:blipFill, a:noFill, a:pattFill), or
 * returns null for anything else (a:grpFill too: the caller decides what a group's fill is).
 * `pkg` and `part` (the part `x` is in) find a picture's part.
 */
export function readFill(x, pkg, part, scheme) {
  switch (x.name) {
    case 'noFill':
      return Fill.NONE;
    case 'solidFill': {
      const color = childColor(x, scheme);
      return color != null ? Fill.solid(color) : Fill.NONE;
    }
    case 'pattFill': {
      let color = null;
      for (const c of x.children('fgClr')) {
        const v = childColor(c, scheme);
        if (v != null) color = v;
      }
      return color != null ? Fill.solid(color) : Fill.NONE;
    }
    case 'gradFill': {
      const stops = [];
      let angle = 90;
      let radial = false;
      for (const c of x.children()) {
        if (c.name === 'gsLst') {
          for (const gs of c.children()) {
            const pos = f(f(gs.percentAttr('pos') ?? 0) / 100000);
            for (const col of gs.children()) {
              const v = readColor(col, scheme);
              if (v != null) stops.push([pos, v]);
            }
          }
        } else if (c.name === 'lin') {
          angle = f(f(c.intAttr('ang') ?? 0) / 60000);
        } else if (c.name === 'path') {
          radial = true;
        }
      }
      if (!stops.length) return Fill.NONE;
      return Fill.gradient(stops.slice().sort((a, b) => a[0] - b[0]), angle, radial);
    }
    case 'blipFill': {
      let path = null;
      let crop = null;
      let tile = false;
      for (const c of x.children()) {
        if (c.name === 'blip') {
          path = pkg ? pkg.target(part, c.relId('embed')) : null;
        } else if (c.name === 'srcRect') {
          const share = (k) => f(f(c.percentAttr(k) ?? 0) / 100000);
          const v = [share('l'), share('t'), share('r'), share('b')];
          crop = v.some((s) => s !== 0) ? v : null;
        } else if (c.name === 'tile') {
          tile = true;
        }
      }
      return path != null ? Fill.image(path, crop, tile) : Fill.NONE;
    }
    default:
      return null;
  }
}

/**
 * An arrowhead (a:headEnd, a:tailEnd): its `type` (triangle, stealth, arrow, diamond or oval),
 * and its `width` and `length` as multiples of the line's width.
 */
export class LineEnd {
  constructor(type, width, length) {
    this.type = type;
    this.width = width;
    this.length = length;
  }
}

/** A shape's outline: `color` (null for none), `width` in points, `dashed`, and arrowheads `head` and `tail`. */
export class Outline {
  constructor(color, width, dashed, head = null, tail = null) {
    this.color = color;
    this.width = width;
    this.dashed = dashed;
    this.head = head;
    this.tail = tail;
  }

  copy(changes = {}) {
    return Object.assign(new Outline(this.color, this.width, this.dashed, this.head, this.tail), changes);
  }
}

Outline.NONE = Object.freeze(new Outline(null, 0, false));

/** Reads a:ln, `x` being it. */
export function readOutline(x, scheme) {
  const width = f(f(x.longAttr('w') ?? 9525) / 12700);
  let color = null;
  let none = false;
  let dashed = false;
  let head = null;
  let tail = null;
  for (const c of x.children()) {
    switch (c.name) {
      case 'noFill': none = true; break;
      case 'solidFill': {
        const v = childColor(c, scheme);
        if (v != null) color = v;
        break;
      }
      case 'gradFill':
        for (const list of c.children('gsLst')) {
          for (const gs of list.children()) {
            for (const col of gs.children()) if (color == null) color = readColor(col, scheme);
          }
        }
        break;
      case 'prstDash': {
        const v = c.attr('val');
        dashed = v != null && v !== 'solid';
        break;
      }
      case 'headEnd': case 'tailEnd': {
        const type = c.attr('type');
        if (type != null && type !== 'none') {
          const size = (key) => { const v = c.attr(key); return v === 'sm' ? 2 : v === 'lg' ? 5 : 3; };
          const end = new LineEnd(type, size('w'), size('len'));
          if (c.name === 'headEnd') head = end;
          else tail = end;
        }
        break;
      }
      default: break;
    }
  }
  return none ? Outline.NONE : new Outline(color, width, dashed, head, tail);
}

// ---------------------------------------------------------------------------------------------
// Painting

/** Clamps a gradient stop's place into 0..1, as the canvas needs it. */
const place = (p) => (p > 0 ? (p < 1 ? p : 1) : 0);

/** The canvas gradient for `fill` over the rectangle `r`, as DrawingML.kt's gradient(). */
export function gradientFor(canvas, fill, r) {
  const b = box(r);
  const stops = fill.stops.length === 1 ? [[0, fill.stops[0][1]], [1, fill.stops[0][1]]] : fill.stops;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  let g;
  if (fill.radial) {
    g = canvas.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, Math.max(b.width, b.height) / 2));
  } else {
    const angle = (fill.angle * Math.PI) / 180;
    const dx = (Math.cos(angle) * b.width) / 2;
    const dy = (Math.sin(angle) * b.height) / 2;
    g = canvas.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  }
  for (const [pos, color] of stops) g.addColorStop(place(pos), color >>> 0);
  return g;
}

/**
 * Paints `fill` over `path` (a PdfPath) in `bounds`; pictures are drawn by `picture(fill)`, which
 * returns a loaded Picture (or null to leave it out), clipped to the path.
 */
export function fillShape(canvas, fill, path, bounds, picture) {
  switch (fill?.type) {
    case 'solid':
      canvas.fillStyle = fill.color >>> 0;
      canvas.fill(path);
      break;
    case 'gradient':
      canvas.fillStyle = gradientFor(canvas, fill, bounds);
      canvas.fill(path);
      break;
    case 'image': {
      const image = picture?.(fill);
      if (!image) return;
      canvas.save();
      canvas.clip(path);
      image.draw(canvas, box(bounds));
      canvas.restore();
      break;
    }
    default:
      break;
  }
}

function setStroke(canvas, color, width) {
  canvas.strokeStyle = color >>> 0;
  canvas.lineWidth = width;
  // Android's Paint: butt ends, mitred joins with a limit of 4.
  canvas.lineCap = 'butt';
  canvas.lineJoin = 'miter';
  canvas.miterLimit = 4;
}

/** Draws `outline` along `path`. */
export function strokeShape(canvas, outline, path) {
  const color = outline?.color;
  if (color == null || !(outline.width > 0)) return;
  setStroke(canvas, color, outline.width);
  canvas.setLineDash(outline.dashed ? [4 * outline.width, 3 * outline.width] : []);
  canvas.stroke(path);
  if (outline.dashed) canvas.setLineDash([]);
}

/**
 * Draws `outline` along `path`, an open line, with its arrowheads. Under a pointed arrowhead the
 * line stops short, so it doesn't show past the arrowhead's sides.
 */
export function strokeLine(canvas, outline, path) {
  const color = outline?.color;
  const measure = new PathMeasure(path);
  const length = measure.length;
  // Arrowheads go on a single line, not on one in pieces.
  if (color == null || (outline.head == null && outline.tail == null) || !(length > 0) || new PathMeasure(path).nextContour()) {
    return strokeShape(canvas, outline, path);
  }
  // Sized from the line's width, as Office does, but never smaller than for a thin line.
  const base = Math.max(outline.width, 2);
  const inset = (end) => (end && (end.type === 'triangle' || end.type === 'stealth') ? (end.length * base) / 2 : 0);
  const from = inset(outline.head);
  const trimmed = new PdfPath();
  measure.getSegment(from, Math.max(from, length - inset(outline.tail)), trimmed, true);
  strokeShape(canvas, outline, trimmed);
  const draw = (end, distance, sign) => {
    const at = measure.getPosTan(distance);
    if (!at) return;
    // The tip at the line's end, pointing on along the line.
    const { x, y } = at;
    const dx = at.tx * sign;
    const dy = at.ty * sign;
    const long = end.length * base;
    const half = (end.width * base) / 2;
    const arrow = new PdfPath();
    if (end.type === 'oval') {
      const radius = (long / 2 + half) / 2;
      arrow.ellipse(x, y, radius, radius, 0, 0, 2 * Math.PI);
      arrow.closePath();
    } else if (end.type === 'diamond') {
      arrow.moveTo(x + (dx * long) / 2, y + (dy * long) / 2);
      arrow.lineTo(x - dy * half, y + dx * half);
      arrow.lineTo(x - (dx * long) / 2, y - (dy * long) / 2);
      arrow.lineTo(x + dy * half, y - dx * half);
      arrow.closePath();
    } else {
      const backX = x - dx * long;
      const backY = y - dy * long;
      arrow.moveTo(backX - dy * half, backY + dx * half);
      arrow.lineTo(x, y);
      arrow.lineTo(backX + dy * half, backY - dx * half);
      // A stealth arrowhead is notched; an open one is two strokes.
      if (end.type === 'stealth') arrow.lineTo(x - dx * long * 0.6, y - dy * long * 0.6);
      if (end.type !== 'arrow') arrow.closePath();
    }
    if (end.type === 'arrow') {
      setStroke(canvas, color, outline.width);
      canvas.lineJoin = 'round';
      canvas.setLineDash([]);
      canvas.stroke(arrow);
    } else {
      canvas.fillStyle = color >>> 0;
      canvas.fill(arrow);
    }
  };
  if (outline.head) draw(outline.head, 0, -1);
  if (outline.tail) draw(outline.tail, length, 1);
}

// ---------------------------------------------------------------------------------------------
// Preset shapes

function adjustValue(adjust, key) {
  if (!adjust) return undefined;
  if (adjust instanceof Map) return adjust.get(key);
  return Object.prototype.hasOwnProperty.call(adjust, key) ? adjust[key] : undefined;
}

/**
 * The outline of a preset shape (a:prstGeom's prst) in `r`, as a PdfPath. The common shapes and
 * connectors are drawn as they are; others become their bounding rectangle, with rounded corners
 * when the name suggests them. `adjust` (a Map or an object) holds the shape's adjustments (a:gd),
 * in 1/100,000ths.
 */
export function presetPath(name, r, adjust = null) {
  const b = box(r);
  const p = new PdfPath();
  const L = b.x;
  const T = b.y;
  const w = b.width;
  const h = b.height;
  const R = L + w;
  const B = T + h;
  const ss = Math.min(w, h);
  const adj = (key, fallback) => f(f(adjustValue(adjust, key) ?? fallback) / 100000);
  const poly = (...pts) => {
    p.moveTo(L + pts[0] * w, T + pts[1] * h);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(L + pts[i] * w, T + pts[i + 1] * h);
    p.closePath();
  };
  const oval = () => {
    p.ellipse(L + w / 2, T + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, 2 * Math.PI);
    p.closePath();
  };
  const rect = () => {
    p.moveTo(L, T);
    p.lineTo(R, T);
    p.lineTo(R, B);
    p.lineTo(L, B);
    p.closePath();
  };
  const roundRect = (radius) => {
    if (w <= 0 || h <= 0) return rect();
    p.roundRect(L, T, w, h, Math.max(0, radius));
  };
  switch (name) {
    case 'ellipse': case 'flowChartConnector':
      oval();
      break;
    case 'roundRect': case 'flowChartAlternateProcess':
      roundRect(ss * adj('adj', 16667));
      break;
    case 'triangle': case 'flowChartExtract':
      poly(adj('adj', 50000), 0, 1, 1, 0, 1);
      break;
    case 'rtTriangle':
      poly(0, 0, 1, 1, 0, 1);
      break;
    case 'diamond': case 'flowChartDecision':
      poly(0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5);
      break;
    case 'parallelogram': case 'flowChartInputOutput': {
      const a = (ss * adj('adj', 25000)) / w;
      poly(a, 0, 1, 0, 1 - a, 1, 0, 1);
      break;
    }
    case 'trapezoid': {
      const a = (ss * adj('adj', 25000)) / w;
      poly(a, 0, 1 - a, 0, 1, 1, 0, 1);
      break;
    }
    case 'hexagon': {
      const a = (ss * adj('adj', 25000)) / w;
      poly(a, 0, 1 - a, 0, 1, 0.5, 1 - a, 1, a, 1, 0, 0.5);
      break;
    }
    case 'octagon': {
      const a = ss * adj('adj', 29289);
      const ax = a / w;
      const ay = a / h;
      poly(ax, 0, 1 - ax, 0, 1, ay, 1, 1 - ay, 1 - ax, 1, ax, 1, 0, 1 - ay, 0, ay);
      break;
    }
    case 'pentagon':
      poly(0.5, 0, 1, 0.38, 0.81, 1, 0.19, 1, 0, 0.38);
      break;
    case 'homePlate': {
      const a = (ss * adj('adj', 50000)) / w;
      poly(0, 0, 1 - a, 0, 1, 0.5, 1 - a, 1, 0, 1);
      break;
    }
    case 'chevron': {
      const a = (ss * adj('adj', 50000)) / w;
      poly(0, 0, 1 - a, 0, 1, 0.5, 1 - a, 1, 0, 1, a, 0.5);
      break;
    }
    case 'rightArrow': case 'leftArrow': {
      const shaft = adj('adj1', 50000);
      const head = (ss * adj('adj2', 50000)) / w;
      const t = (1 - shaft) / 2;
      if (name === 'rightArrow') poly(0, t, 1 - head, t, 1 - head, 0, 1, 0.5, 1 - head, 1, 1 - head, 1 - t, 0, 1 - t);
      else poly(1, t, head, t, head, 0, 0, 0.5, head, 1, head, 1 - t, 1, 1 - t);
      break;
    }
    case 'upArrow': case 'downArrow': {
      const shaft = adj('adj1', 50000);
      const head = (ss * adj('adj2', 50000)) / h;
      const t = (1 - shaft) / 2;
      if (name === 'downArrow') poly(t, 0, 1 - t, 0, 1 - t, 1 - head, 1, 1 - head, 0.5, 1, 0, 1 - head, t, 1 - head);
      else poly(t, 1, 1 - t, 1, 1 - t, head, 1, head, 0.5, 0, 0, head, t, head);
      break;
    }
    case 'star5': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const angle = ((-90 + i * 36) * Math.PI) / 180;
        const radius = i % 2 === 0 ? 0.5 : 0.19;
        pts.push(0.5 + radius * Math.cos(angle), 0.5 + radius * 1.05 * Math.sin(angle) + 0.03);
      }
      poly(...pts);
      break;
    }
    case 'plus': {
      const a = ss * adj('adj', 25000);
      const ax = a / w;
      const ay = a / h;
      poly(ax, 0, 1 - ax, 0, 1 - ax, ay, 1, ay, 1, 1 - ay, 1 - ax, 1 - ay, 1 - ax, 1, ax, 1, ax, 1 - ay, 0, 1 - ay, 0, ay, ax, ay);
      break;
    }
    case 'line': case 'straightConnector1':
      p.moveTo(L, T);
      p.lineTo(R, B);
      break;
    case 'lineInv':
      p.moveTo(L, B);
      p.lineTo(R, T);
      break;
    // Elbow and curved connectors, as Office's preset shape definitions draw them: open lines.
    case 'bentConnector2':
      p.moveTo(L, T);
      p.lineTo(R, T);
      p.lineTo(R, B);
      break;
    case 'bentConnector3': {
      const x1 = L + w * adj('adj1', 50000);
      p.moveTo(L, T);
      p.lineTo(x1, T);
      p.lineTo(x1, B);
      p.lineTo(R, B);
      break;
    }
    case 'bentConnector4': {
      const x1 = L + w * adj('adj1', 50000);
      const y2 = T + h * adj('adj2', 50000);
      p.moveTo(L, T);
      p.lineTo(x1, T);
      p.lineTo(x1, y2);
      p.lineTo(R, y2);
      p.lineTo(R, B);
      break;
    }
    case 'bentConnector5': {
      const x1 = L + w * adj('adj1', 50000);
      const y2 = T + h * adj('adj2', 50000);
      const x3 = L + w * adj('adj3', 50000);
      p.moveTo(L, T);
      p.lineTo(x1, T);
      p.lineTo(x1, y2);
      p.lineTo(x3, y2);
      p.lineTo(x3, B);
      p.lineTo(R, B);
      break;
    }
    case 'curvedConnector2':
      p.moveTo(L, T);
      p.bezierCurveTo(L + w / 2, T, R, T + h / 2, R, B);
      break;
    case 'curvedConnector3': {
      const x2 = L + w * adj('adj1', 50000);
      p.moveTo(L, T);
      p.bezierCurveTo((L + x2) / 2, T, x2, T + h / 4, x2, T + h / 2);
      p.bezierCurveTo(x2, T + (h * 3) / 4, (x2 + R) / 2, B, R, B);
      break;
    }
    case 'curvedConnector4': {
      const x2 = L + w * adj('adj1', 50000);
      const x3 = (R + x2) / 2;
      const y4 = T + h * adj('adj2', 50000);
      const y1 = (T + y4) / 2;
      p.moveTo(L, T);
      p.bezierCurveTo((L + x2) / 2, T, x2, (T + y1) / 2, x2, y1);
      p.bezierCurveTo(x2, (y1 + y4) / 2, (x2 + x3) / 2, y4, x3, y4);
      p.bezierCurveTo((x3 + R) / 2, y4, R, (B + y4) / 2, R, B);
      break;
    }
    case 'curvedConnector5': {
      const x3 = L + w * adj('adj1', 50000);
      const x6 = L + w * adj('adj3', 50000);
      const x1 = (x3 + x6) / 2;
      const y4 = T + h * adj('adj2', 50000);
      const y1 = (T + y4) / 2;
      const y5 = (B + y4) / 2;
      p.moveTo(L, T);
      p.bezierCurveTo((L + x3) / 2, T, x3, (T + y1) / 2, x3, y1);
      p.bezierCurveTo(x3, (y1 + y4) / 2, (x3 + x1) / 2, y4, x1, y4);
      p.bezierCurveTo((x6 + x1) / 2, y4, x6, (y5 + y4) / 2, x6, y5);
      p.bezierCurveTo(x6, (y5 + B) / 2, (x6 + R) / 2, B, R, B);
      break;
    }
    case 'snip1Rect': case 'snip2SameRect': case 'round1Rect': case 'round2SameRect': case 'snipRoundRect': case 'round2DiagRect':
      roundRect(ss * f(0.16667));
      break;
    default:
      rect();
  }
  return p;
}

/** The preset shapes presetPath draws as themselves (others are rectangles). */
export const PRESET_SHAPES = Object.freeze([
  'ellipse', 'flowChartConnector', 'roundRect', 'flowChartAlternateProcess', 'triangle', 'flowChartExtract', 'rtTriangle',
  'diamond', 'flowChartDecision', 'parallelogram', 'flowChartInputOutput', 'trapezoid', 'hexagon', 'octagon', 'pentagon',
  'homePlate', 'chevron', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'star5', 'plus', 'flowChartPredefinedProcess',
  'line', 'straightConnector1', 'lineInv', 'bentConnector2', 'bentConnector3', 'bentConnector4', 'bentConnector5',
  'curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5', 'snip1Rect', 'snip2SameRect',
  'round1Rect', 'round2SameRect', 'snipRoundRect', 'round2DiagRect', 'rect',
]);

/** Whether a preset shape is a line, with nothing to fill. (A flowchart's connector is a circle.) */
export function isLineShape(name) {
  return name != null && (name === 'line' || name === 'lineInv' || name.startsWith('straightConnector') || name.startsWith('bentConnector') || name.startsWith('curvedConnector'));
}

// ---------------------------------------------------------------------------------------------
// Transforms

/**
 * Reads a:xfrm (or p:xfrm), `x` being it: { rect (an OfficeRect in points), rotation (degrees
 * clockwise), flipH, flipV, child } where child is { offset: [x, y], extent: [width, height] } for
 * a group's a:chOff and a:chExt, or null.
 */
export function readXfrm(x) {
  const rotation = f(f(x.intAttr('rot') ?? 0) / 60000);
  const flipH = x.flag('flipH', false);
  const flipV = x.flag('flipV', false);
  let off = [0, 0];
  let ext = [0, 0];
  let chOff = [0, 0];
  let chExt = null;
  const pair = (c, a, b) => [OfficeUnits.emu(c.longAttr(a) ?? 0), OfficeUnits.emu(c.longAttr(b) ?? 0)];
  for (const c of x.children()) {
    if (c.name === 'off') off = pair(c, 'x', 'y');
    else if (c.name === 'ext') ext = pair(c, 'cx', 'cy');
    else if (c.name === 'chOff') chOff = pair(c, 'x', 'y');
    else if (c.name === 'chExt') chExt = pair(c, 'cx', 'cy');
  }
  return { rect: new OfficeRect(off[0], off[1], ext[0], ext[1]), rotation, flipH, flipV, child: chExt ? { offset: chOff, extent: chExt } : null };
}

/** An adjustment of a:avLst (a:gd name="adj" fmla="val 25000"): [name, value], or null. */
export function readGuide(x) {
  if (x.name !== 'gd') return null;
  const formula = x.attr('fmla');
  if (formula == null) return null;
  const t = trim(formula.startsWith('val ') ? formula.slice(4) : formula);
  if (!/^[+-]?\d+$/.test(t)) return null;
  const name = x.attr('name');
  return name == null ? null : [name, Number(t)];
}

/** The adjustments of a:prstGeom (`x`), as a Map. */
export function readAdjustments(x) {
  const out = new Map();
  for (const list of x.children('avLst')) {
    for (const gd of list.children()) {
      const g = readGuide(gd);
      if (g) out.set(g[0], g[1]);
    }
  }
  return out;
}

/** Turns the canvas `degrees` clockwise about (cx, cy), as Android's canvas.rotate(degrees, px, py). */
export function rotateAbout(canvas, degrees, cx, cy) {
  if (!degrees) return;
  canvas.translate(cx, cy);
  canvas.rotate((degrees * Math.PI) / 180);
  canvas.translate(-cx, -cy);
}

/** Scales the canvas about (cx, cy), as Android's canvas.scale(sx, sy, px, py). */
export function scaleAbout(canvas, sx, sy, cx, cy) {
  canvas.translate(cx, cy);
  canvas.scale(sx, sy);
  canvas.translate(-cx, -cy);
}

/** `path` mirrored in `r` (across its middle) horizontally and/or vertically, as a new PdfPath. */
export function flipped(path, flipH, flipV, r) {
  if (!flipH && !flipV) return path;
  const b = box(r);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const sx = flipH ? -1 : 1;
  const sy = flipV ? -1 : 1;
  const out = new PdfPath();
  out.addPath(path, [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Freeform shapes

/**
 * Reads a:custGeom's paths (`x` being it): [{ w, h, commands: number[][], kinds: string[],
 * filled, stroked }]. None when they can't be drawn here: points given by formulas need
 * PowerPoint's shape-guide engine, and such shapes are left out (their text still shows).
 */
export function readCustom(x) {
  const paths = [];
  let usable = true;
  const num = (v) => {
    if (v == null) return null;
    const d = toDoubleOrNull(v);
    return d == null ? null : f(d);
  };
  for (const list of x.children('pathLst')) {
    for (const p of list.children()) {
      if (p.name !== 'path') continue;
      const w = p.longAttr('w') ?? 0;
      const h = p.longAttr('h') ?? 0;
      const filled = p.attr('fill') !== 'none';
      const stroked = p.flag('stroke');
      const commands = [];
      const kinds = [];
      for (const c of p.children()) {
        const kind = c.name;
        const values = [];
        if (kind === 'arcTo') {
          for (const key of ['wR', 'hR', 'stAng', 'swAng']) {
            const v = num(c.attr(key));
            if (v == null) usable = false;
            else values.push(v);
          }
        }
        for (const pt of c.children('pt')) {
          const px = num(pt.attr('x'));
          const py = num(pt.attr('y'));
          if (px == null || py == null) usable = false;
          else values.push(px, py);
        }
        kinds.push(kind);
        commands.push(values);
      }
      paths.push({ w, h, commands, kinds, filled, stroked });
    }
  }
  return usable ? paths : [];
}

/**
 * The freeform paths of a shape drawn in `r`, as [PdfPath, filled, stroked] triples, mirrored by
 * the shape's flips. A path without a size of its own is in the shape's EMUs before its group
 * scales it: `groupX` and `groupY` are how much the group stretches it (1 outside groups).
 */
export function customPaths(paths, r, { flipH = false, flipV = false } = {}, groupX = 1, groupY = 1) {
  const b = box(r);
  return paths.map((p) => {
    const sx = p.w > 0 ? b.width / p.w : groupX / OfficeUnits.EMU_PER_POINT;
    const sy = p.h > 0 ? b.height / p.h : groupY / OfficeUnits.EMU_PER_POINT;
    const path = new PdfPath();
    let cx = 0;
    let cy = 0;
    const px = (v, i) => b.x + v[i] * sx;
    const py = (v, i) => b.y + v[i] * sy;
    p.kinds.forEach((kind, k) => {
      const v = p.commands[k] ?? [];
      switch (kind) {
        case 'moveTo':
          if (v.length >= 2) { path.moveTo(px(v, 0), py(v, 1)); cx = v[0]; cy = v[1]; }
          break;
        case 'lnTo':
          if (v.length >= 2) { path.lineTo(px(v, 0), py(v, 1)); cx = v[0]; cy = v[1]; }
          break;
        case 'cubicBezTo':
          if (v.length >= 6) { path.bezierCurveTo(px(v, 0), py(v, 1), px(v, 2), py(v, 3), px(v, 4), py(v, 5)); cx = v[4]; cy = v[5]; }
          break;
        case 'quadBezTo':
          if (v.length >= 4) { path.quadraticCurveTo(px(v, 0), py(v, 1), px(v, 2), py(v, 3)); cx = v[2]; cy = v[3]; }
          break;
        case 'arcTo':
          if (v.length >= 4) {
            const [wR, hR] = v;
            const start = v[2] / 60000;
            const sweep = v[3] / 60000;
            const rad = (start * Math.PI) / 180;
            const centerX = cx - wR * Math.cos(rad);
            const centerY = cy - hR * Math.sin(rad);
            // Android's Path.arcTo(oval, start, sweep): a line to the arc's start, then the arc
            // (nothing for an oval turned inside out).
            const rx = wR * sx;
            const ry = hR * sy;
            if (rx >= 0 && ry >= 0) {
              const s = rad;
              const sw = (Math.max(-360, Math.min(360, sweep)) * Math.PI) / 180;
              path.ellipse(b.x + centerX * sx, b.y + centerY * sy, rx, ry, 0, s, s + sw, sw < 0);
            }
            const end = ((start + sweep) * Math.PI) / 180;
            cx = centerX + wR * Math.cos(end);
            cy = centerY + hR * Math.sin(end);
          }
          break;
        case 'close':
          path.closePath();
          break;
        default:
          break;
      }
    });
    return [flipped(path, flipH, flipV, b), p.filled, p.stroked];
  });
}

// ---------------------------------------------------------------------------------------------
// Shapes

/**
 * Draws a shape's fill and outline, or a picture, as PptxConverter.drawShape does once it knows
 * them. `shape`:
 * - `rect`: where it goes (points), `rotation` (degrees clockwise), `flipH`, `flipV`;
 * - `picture: true` for a picture (p:pic): its image fill is drawn in the geometry, mirrored by
 *   the flips; otherwise a shape: the geometry is filled (lines aren't) and outlined;
 * - `geometry`: the preset name (null: a rectangle), `adjust` (Map), `custom` (readCustom's paths,
 *   or null), `groupScale` ([x, y], how much its group stretches it);
 * - `fill` (a Fill or null), `line` (an Outline or null).
 * `picture(fill, rect)` gives the loaded Picture for an image fill (office-pdf.js's
 * `images.picture(...)` made beforehand), or null.
 * The canvas is left turned as the shape is, for its text: call this between save() and restore().
 */
export function drawShape(canvas, shape, { picture } = {}) {
  const r = box(shape.rect);
  const rotation = shape.rotation ?? 0;
  if (rotation) rotateAbout(canvas, rotation, r.x + r.width / 2, r.y + r.height / 2);
  const geometry = shape.geometry ?? null;
  const adjust = shape.adjust ?? null;
  const flipH = !!shape.flipH;
  const flipV = !!shape.flipV;
  const imageOf = (fill) => picture?.(fill, r) ?? null;
  if (shape.picture) {
    if (shape.fill?.type === 'image') {
      canvas.save();
      if (flipH) scaleAbout(canvas, -1, 1, r.x + r.width / 2, r.y + r.height / 2);
      if (flipV) scaleAbout(canvas, 1, -1, r.x + r.width / 2, r.y + r.height / 2);
      canvas.clip(presetPath(geometry, r, adjust));
      imageOf(shape.fill)?.draw(canvas, r);
      canvas.restore();
    }
    strokeShape(canvas, shape.line, presetPath(geometry, r, adjust));
    return;
  }
  const custom = shape.custom?.length ? shape.custom : null;
  const [gx, gy] = shape.groupScale ?? [1, 1];
  const paths = custom
    ? customPaths(custom, r, { flipH, flipV }, gx, gy)
    : [[flipped(presetPath(geometry, r, adjust), flipH, flipV, r), true, true]];
  paths.forEach(([path, filled, stroked], i) => {
    if (filled && !isLineShape(geometry)) fillShape(canvas, shape.fill, path, r, imageOf);
    if (!stroked) return;
    // A line that isn't closed can have arrowheads.
    const open = custom ? custom[i].kinds[custom[i].kinds.length - 1] !== 'close' : isLineShape(geometry);
    if (open) strokeLine(canvas, shape.line, path);
    else strokeShape(canvas, shape.line, path);
  });
}
