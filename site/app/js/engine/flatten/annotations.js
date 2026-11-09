// Looks for comments that come without one (no /AP), made the way PDF viewers draw them, so
// flattening doesn't lose them: shapes, lines, drawings, highlights and other text markup, sticky
// notes, carets, text boxes and stamps. The app's PDFBox has handlers for most of these; where
// pdf.js draws a kind too, its way is followed, so the flattened page looks as it did on screen.
// Each look is drawn in page coordinates: its box is the rectangle it is placed on.
import {
  get, getDict, getArray, getName, getNum, getText, resolve, numbers, fmt, num,
  PDFArray, PDFName,
} from './cos.js';
import { parseDA } from './content.js';
import { standardMetrics } from './fonts.js';
import { WIN_ANSI, glyphToUnicode } from './encodings.js';

const FLAG_NO_ZOOM = 8;

/** A colour array (/C, /IC) as fill and stroke operators, or null for none or transparent. */
function color(ctx, value) {
  const c = resolve(ctx, value);
  if (!(c instanceof PDFArray)) return null;
  const v = [];
  for (let i = 0; i < c.size(); i++) v.push(num(resolve(ctx, c.get(i)), 0));
  const s = v.map(fmt).join(' ');
  if (v.length === 1) return { fill: `${s} g`, stroke: `${s} G` };
  if (v.length === 3) return { fill: `${s} rg`, stroke: `${s} RG` };
  if (v.length === 4) return { fill: `${s} k`, stroke: `${s} K` };
  return null;
}

/** The border: { width, dash } from /BS (or the older /Border), 1 point wide by default. */
function border(ctx, annot) {
  const bs = getDict(ctx, annot, 'BS');
  if (bs) {
    const width = getNum(ctx, bs, 'W', 1);
    const dash = getName(ctx, bs, 'S') === 'D' ? (numbers(ctx, get(ctx, bs, 'D')) ?? [3]) : null;
    return { width: Math.max(0, width), dash };
  }
  const b = numbers(ctx, get(ctx, annot, 'Border'));
  if (b && b.length >= 3 && Number.isFinite(b[2])) {
    const dash = b.length >= 4 ? numbers(ctx, getArray(ctx, annot, 'Border')?.get(3)) : null;
    return { width: Math.max(0, b[2]), dash };
  }
  return { width: 1, dash: null };
}

function strokeSetup(b) {
  const ops = [`${fmt(b.width)} w`];
  if (b.dash && b.dash.length && b.dash.every((d) => Number.isFinite(d) && d >= 0) && b.dash.some((d) => d > 0)) {
    ops.push(`[${b.dash.map(fmt).join(' ')}] 0 d`);
  }
  return ops;
}

const pt = (x, y) => `${fmt(x)} ${fmt(y)}`;

function bounds(points, padding) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs) - padding, Math.min(...ys) - padding, Math.max(...xs) + padding, Math.max(...ys) + padding];
}

function union(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** A closed curve through an ellipse's four sides (Bézier quarter arcs). */
function ellipse(cx, cy, rx, ry) {
  const k = 0.5523;
  return `${pt(cx + rx, cy)} m ${pt(cx + rx, cy + ry * k)} ${pt(cx + rx * k, cy + ry)} ${pt(cx, cy + ry)} c `
    + `${pt(cx - rx * k, cy + ry)} ${pt(cx - rx, cy + ry * k)} ${pt(cx - rx, cy)} c `
    + `${pt(cx - rx, cy - ry * k)} ${pt(cx - rx * k, cy - ry)} ${pt(cx, cy - ry)} c `
    + `${pt(cx + rx * k, cy - ry)} ${pt(cx + rx, cy - ry * k)} ${pt(cx + rx, cy)} c`;
}

/** Text markup's quadrilaterals as [upper-left, upper-right, lower-left, lower-right] corners. */
function quads(ctx, annot, rect) {
  const q = numbers(ctx, get(ctx, annot, 'QuadPoints'));
  const out = [];
  if (q && q.length >= 8) {
    for (let i = 0; i + 7 < q.length; i += 8) {
      const v = q.slice(i, i + 8);
      if (v.some((n) => !Number.isFinite(n))) continue;
      out.push([[v[0], v[1]], [v[2], v[3]], [v[4], v[5]], [v[6], v[7]]]);
    }
  }
  if (!out.length) out.push([[rect[0], rect[3]], [rect[2], rect[3]], [rect[0], rect[1]], [rect[2], rect[1]]]);
  return out;
}

/** A line ending (/LE) at (x, y) for a line coming from (fromX, fromY). */
function lineEnding(style, x, y, fromX, fromY, w, interior) {
  const angle = Math.atan2(y - fromY, x - fromX);
  const at = (dist, turn) => [x + Math.cos(angle + turn) * dist, y + Math.sin(angle + turn) * dist];
  const arrow = 9 * Math.max(w, 1) / Math.cos(Math.PI / 6) / 2;
  const size = 3 * Math.max(w, 1);
  switch (style) {
    case 'OpenArrow':
    case 'ClosedArrow': {
      const a = at(arrow, Math.PI - Math.PI / 6);
      const b = at(arrow, Math.PI + Math.PI / 6);
      const path = `${pt(...a)} m ${pt(x, y)} l ${pt(...b)} l`;
      return style === 'ClosedArrow' ? `${path} h ${interior ? 'b' : 's'}` : `${path} S`;
    }
    case 'ROpenArrow':
    case 'RClosedArrow': {
      const a = at(arrow, -Math.PI / 6);
      const b = at(arrow, Math.PI / 6);
      const path = `${pt(...a)} m ${pt(x, y)} l ${pt(...b)} l`;
      return style === 'RClosedArrow' ? `${path} h ${interior ? 'b' : 's'}` : `${path} S`;
    }
    case 'Circle':
      return `${ellipse(x, y, size, size)} h ${interior ? 'b' : 's'}`;
    case 'Square':
      return `${pt(x - size, y - size)} ${fmt(2 * size)} ${fmt(2 * size)} re ${interior ? 'b' : 's'}`;
    case 'Diamond':
      return `${pt(x, y + size)} m ${pt(x + size, y)} l ${pt(x, y - size)} l ${pt(x - size, y)} l h ${interior ? 'b' : 's'}`;
    case 'Butt': {
      const a = at(size, Math.PI / 2);
      const b = at(size, -Math.PI / 2);
      return `${pt(...a)} m ${pt(...b)} l S`;
    }
    case 'Slash': {
      const a = at(4.5 * Math.max(w, 1), Math.PI / 2 + Math.PI / 6);
      const b = at(4.5 * Math.max(w, 1), -Math.PI / 2 + Math.PI / 6);
      return `${pt(...a)} m ${pt(...b)} l S`;
    }
    default:
      return '';
  }
}

function endings(ctx, annot) {
  const le = getArray(ctx, annot, 'LE');
  if (!le) return ['None', 'None'];
  return [nameAt(ctx, le, 0), nameAt(ctx, le, 1)];
}

function nameAt(ctx, arr, i) {
  const v = resolve(ctx, arr.get(i));
  return v instanceof PDFName ? v.decodeText() : 'None';
}

/** The page-coordinate content and box of a comment with no look of its own, or null. */
function draw(env, annot, subtype, rect) {
  const { ctx } = env;
  const c = color(ctx, get(ctx, annot, 'C'));
  const ic = color(ctx, get(ctx, annot, 'IC'));
  const b = border(ctx, annot);
  const ops = [];
  const resources = {};
  switch (subtype) {
    case 'Square':
    case 'Circle': {
      // As pdf.js: no border and no fill draws nothing (not even a hairline).
      if (b.width === 0 && !ic) return null;
      const w = b.width;
      const box = [rect[0] + w / 2, rect[1] + w / 2, rect[2] - w / 2, rect[3] - w / 2];
      if (box[2] <= box[0] || box[3] <= box[1]) return null;
      ops.push(...strokeSetup(b), c ? c.stroke : '0 G');
      if (ic) ops.push(ic.fill);
      const paint = ic ? (w > 0 ? 'B' : 'f') : 'S';
      if (subtype === 'Square') ops.push(`${pt(box[0], box[1])} ${fmt(box[2] - box[0])} ${fmt(box[3] - box[1])} re ${paint}`);
      else ops.push(`${ellipse((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, (box[2] - box[0]) / 2, (box[3] - box[1]) / 2)} h ${paint}`);
      return { ops, box: rect };
    }
    case 'Line':
    case 'PolyLine':
    case 'Polygon': {
      let points;
      if (subtype === 'Line') {
        const l = numbers(ctx, get(ctx, annot, 'L'));
        if (!l || l.length < 4 || l.slice(0, 4).some((n) => !Number.isFinite(n))) return null;
        points = [[l[0], l[1]], [l[2], l[3]]];
      } else {
        const v = numbers(ctx, get(ctx, annot, 'Vertices'));
        if (!v || v.length < 4) return null;
        points = [];
        for (let i = 0; i + 1 < v.length; i += 2) if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1])) points.push([v[i], v[i + 1]]);
        if (points.length < 2) return null;
      }
      if (b.width === 0 && !(subtype === 'Polygon' && ic)) return null;
      ops.push(...strokeSetup(b), c ? c.stroke : '0 G');
      if (ic) ops.push(ic.fill);
      const path = points.map((p, i) => `${pt(...p)} ${i ? 'l' : 'm'}`).join(' ');
      if (subtype === 'Polygon') ops.push(`${path} h ${ic ? (b.width > 0 ? 'b' : 'f') : 's'}`);
      else ops.push(`${path} S`);
      let reach = b.width / 2;
      if (subtype !== 'Polygon') {
        const [start, end] = endings(ctx, annot);
        const n = points.length;
        const e1 = lineEnding(start, points[0][0], points[0][1], points[1][0], points[1][1], b.width, ic);
        const e2 = lineEnding(end, points[n - 1][0], points[n - 1][1], points[n - 2][0], points[n - 2][1], b.width, ic);
        if (e1 || e2) {
          ops.push('[] 0 d');
          if (e1) ops.push(e1);
          if (e2) ops.push(e2);
          reach += 9 * Math.max(b.width, 1);
        }
      }
      return { ops, box: union(rect, bounds(points, reach)) };
    }
    case 'Ink': {
      const list = getArray(ctx, annot, 'InkList');
      if (!list) return null;
      const paths = [];
      const all = [];
      for (let i = 0; i < list.size(); i++) {
        const v = numbers(ctx, list.get(i));
        if (!v) continue;
        const pts = [];
        for (let k = 0; k + 1 < v.length; k += 2) if (Number.isFinite(v[k]) && Number.isFinite(v[k + 1])) pts.push([v[k], v[k + 1]]);
        if (!pts.length) continue;
        // A dot (one point) is drawn as a very short line so its round cap shows.
        if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);
        paths.push(pts);
        all.push(...pts);
      }
      if (!paths.length || b.width === 0) return null;
      ops.push(...strokeSetup(b), '1 J 1 j', c ? c.stroke : '0 G');
      for (const pts of paths) ops.push(`${pts.map((p, i) => `${pt(...p)} ${i ? 'l' : 'm'}`).join(' ')} S`);
      return { ops, box: union(rect, bounds(all, b.width / 2 + 1)) };
    }
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const qs = quads(ctx, annot, rect);
      const corners = qs.flat();
      if (subtype === 'Highlight') {
        // Multiplied with the page, so the text under it stays readable.
        resources.ExtGState = { GSm: { Type: 'ExtGState', BM: 'Multiply' } };
        ops.push('/GSm gs', c ? c.fill : '1 1 0 rg');
        for (const [ul, ur, ll, lr] of qs) ops.push(`${pt(...ll)} m ${pt(...lr)} l ${pt(...ur)} l ${pt(...ul)} l h f`);
      } else {
        ops.push(c ? c.stroke : '0 G');
        for (const [ul, ur, ll, lr] of qs) {
          if (subtype === 'Underline') {
            ops.push('0.571 w', `${pt(ll[0], ll[1] + 1.3)} m ${pt(lr[0], lr[1] + 1.3)} l S`);
          } else if (subtype === 'StrikeOut') {
            ops.push('1 w', `${pt((ul[0] + ll[0]) / 2, (ul[1] + ll[1]) / 2)} m ${pt((ur[0] + lr[0]) / 2, (ur[1] + lr[1]) / 2)} l S`);
          } else {
            const dy = (ul[1] - ll[1]) / 6;
            let x = ll[0];
            let shift = dy;
            const path = [`${pt(x, ll[1] + shift)} m`];
            for (let steps = 0; x < lr[0] && steps < 5000; steps++) {
              x += 2;
              shift = shift === 0 ? dy : 0;
              path.push(`${pt(x, ll[1] + shift)} l`);
            }
            ops.push('1 w', `${path.join(' ')} S`);
          }
        }
      }
      return { ops, box: union(rect, bounds(corners, 1)), resources };
    }
    case 'Text':
      return noteIcon(ctx, annot, rect, c);
    case 'Caret': {
      ops.push(c ? c.fill : '0 g');
      const [x0, y0, x1, y1] = rect;
      const halfX = (x1 - x0) / 2;
      const halfY = (y1 - y0) / 2;
      ops.push(`${pt(x0, y0)} m ${pt(x0 + halfX, y0)} ${pt(x0 + halfX, y0 + halfY)} ${pt(x0 + halfX, y1)} c `
        + `${pt(x0 + halfX, y0 + halfY)} ${pt(x0 + halfX, y0)} ${pt(x1, y0)} c h f`);
      return { ops, box: rect };
    }
    case 'FreeText':
      return freeText(env, annot, rect, c, b);
    case 'Stamp':
      return stamp(env, annot, rect, c);
    default:
      return null;
  }
}

/** A sticky note's icon (/Name), as Acrobat and PDFBox draw them, filled with its colour. */
function noteIcon(ctx, annot, rect, c) {
  const name = getName(ctx, annot, 'Name') ?? 'Note';
  const w = 18;
  const h = 20;
  // Its upper-left corner stays where it is; the rest is the icon's size, unless it doesn't zoom.
  let box = rect;
  if (!(getNum(ctx, annot, 'F', 0) & FLAG_NO_ZOOM)) box = [rect[0], rect[3] - h, rect[0] + w, rect[3]];
  const ops = ['4 M 1 j 0 J 0.61 w', '0 G', c ? c.fill : '1 g'];
  // Drawn in an 18 by 20 box, fitted to the annotation's box.
  const sx = (box[2] - box[0]) / w;
  const sy = (box[3] - box[1]) / h;
  ops.push(`${fmt(sx)} 0 0 ${fmt(sy)} ${fmt(box[0])} ${fmt(box[1])} cm`);
  const lines = (ys, x0 = w / 4, x1 = w * 3 / 4 - 1) => ys.map((y) => `${pt(x0, y)} m ${pt(x1, y)} l`).join(' ');
  switch (name) {
    case 'Comment':
      ops.push(`${pt(1, 6)} m ${pt(1, 18)} l ${pt(17, 18)} l ${pt(17, 6)} l ${pt(8, 6)} l ${pt(4, 2)} l ${pt(4, 6)} l h B`,
        lines([9, 12, 15], 4, 14), 'S');
      break;
    case 'Key':
      ops.push(`${ellipse(6, 13, 4.5, 4.5)} h B`, `${pt(9, 10)} m ${pt(16, 3)} l ${pt(14, 3)} m ${pt(12, 5)} l S`);
      break;
    case 'Help':
      ops.push(`${ellipse(9, 10, 8, 8)} h B`, '1.5 w 1 J',
        `${pt(6.5, 12.5)} m ${pt(6.5, 15.5)} ${pt(11.5, 15.5)} ${pt(11.5, 12.5)} c ${pt(11.5, 10.5)} ${pt(9, 10.5)} ${pt(9, 8)} c S`,
        `${pt(9, 5.5)} m ${pt(9, 5)} l S`);
      break;
    case 'Insert':
      ops.push(`${pt(1, 2)} m ${pt(9, 18)} l ${pt(17, 2)} l h B`);
      break;
    case 'Check':
      ops.push(`${pt(2, 10)} m ${pt(6, 4)} l ${pt(16, 17)} l ${pt(14, 18)} l ${pt(6, 8)} l ${pt(4, 11)} l h B`);
      break;
    case 'Cross':
      ops.push(`${pt(3, 1)} m ${pt(9, 7)} l ${pt(15, 1)} l ${pt(17, 3)} l ${pt(11, 9)} l ${pt(17, 15)} l ${pt(15, 17)} l `
        + `${pt(9, 11)} l ${pt(3, 17)} l ${pt(1, 15)} l ${pt(7, 9)} l ${pt(1, 3)} l h B`);
      break;
    case 'Circle':
      ops.push(`${ellipse(9, 10, 8, 8)} h B`, `${ellipse(9, 10, 3.5, 3.5)} h S`);
      break;
    case 'Star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = Math.PI / 2 + i * Math.PI / 5;
        const r = i % 2 ? 3.6 : 8.5;
        pts.push(pt(9 + Math.cos(a) * r, 9.5 + Math.sin(a) * r));
      }
      ops.push(`${pts[0]} m ${pts.slice(1).map((p) => `${p} l`).join(' ')} h B`);
      break;
    }
    case 'RightArrow':
    case 'RightPointer':
      ops.push(`${pt(1, 7)} m ${pt(9, 7)} l ${pt(9, 3)} l ${pt(17, 10)} l ${pt(9, 17)} l ${pt(9, 13)} l ${pt(1, 13)} l h B`);
      break;
    case 'UpArrow':
    case 'UpLeftArrow':
      ops.push(`${pt(6, 1)} m ${pt(6, 10)} l ${pt(2, 10)} l ${pt(9, 19)} l ${pt(16, 10)} l ${pt(12, 10)} l ${pt(12, 1)} l h B`);
      break;
    case 'CrossHairs':
      ops.push(`${ellipse(9, 10, 7, 7)} h B`, `${pt(9, 1)} m ${pt(9, 19)} l ${pt(0, 10)} m ${pt(18, 10)} l S`);
      break;
    case 'Paragraph':
    case 'NewParagraph':
      ops.push(`${pt(1, 1)} ${fmt(16)} ${fmt(18)} re B`,
        `${pt(10, 4)} m ${pt(10, 16)} l ${pt(13, 4)} m ${pt(13, 16)} l ${pt(14, 16)} m ${pt(8, 16)} l ${pt(5, 16)} ${pt(5, 11)} ${pt(10, 11)} c S`);
      break;
    default: // Note
      ops.push(`${pt(1, 1)} ${fmt(w - 2)} ${fmt(h - 2)} re`, lines([h / 7 * 2, h / 7 * 3, h / 7 * 4, h / 7 * 5]), 'B');
  }
  return { ops, box };
}

/** Text drawn with a standard font: the text's bytes (characters it lacks become '?') and its width. */
function standardText(font, text) {
  const afm = standardMetrics(font);
  let hex = '';
  let width = 0;
  for (const ch of text) {
    let code = WIN_ANSI.findIndex((n, i) => i >= 32 && n && glyphToUnicode(n) === ch);
    if (code < 0 && ch === '\xa0') code = 32;
    if (code < 0) code = 63;
    hex += code.toString(16).padStart(2, '0');
    width += afm.CharWidths[WIN_ANSI[code]] ?? 500;
  }
  return { hex, width };
}

/** Breaks `text` into lines of at most `maxWidth` at `size` in a standard font. */
function wrapStandard(font, text, size, maxWidth) {
  const out = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const longer = line ? `${line} ${word}` : word;
      if (line && standardText(font, longer).width * size / 1000 > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = longer;
      }
    }
    out.push(line);
  }
  return out;
}

/** A text box comment: its text in its /DA size and colour, in Helvetica, inside its border. */
function freeText(env, annot, rect, c, b) {
  const { ctx } = env;
  const text = getText(ctx, annot, 'Contents') ?? '';
  const da = parseDA(getText(ctx, annot, 'DA'));
  const size = da.size > 0 ? da.size : 12;
  const ops = [];
  const fontRef = env.standardFont('Helvetica');
  const resources = { Font: { Helv: fontRef } };
  if (c) ops.push(c.fill, `${pt(rect[0], rect[1])} ${fmt(rect[2] - rect[0])} ${fmt(rect[3] - rect[1])} re f`);
  const textColor = da.color ? `${da.color.args.map(fmt).join(' ')} ${da.color.op}` : '0 g';
  if (b.width > 0 && getDict(ctx, annot, 'BS')) {
    const stroke = textColor.replace(/ (g|rg|k)$/, (m) => m.toUpperCase());
    ops.push(...strokeSetup(b), stroke,
      `${pt(rect[0] + b.width / 2, rect[1] + b.width / 2)} ${fmt(rect[2] - rect[0] - b.width)} ${fmt(rect[3] - rect[1] - b.width)} re S`);
  }
  const padding = 2 + b.width;
  const inner = rect[2] - rect[0] - 2 * padding;
  const q = getNum(ctx, annot, 'Q', 0);
  const afm = standardMetrics('Helvetica');
  const lines = wrapStandard('Helvetica', text, size, inner);
  ops.push('q', `${pt(rect[0], rect[1])} ${fmt(rect[2] - rect[0])} ${fmt(rect[3] - rect[1])} re W n`, 'BT', `/Helv ${fmt(size)} Tf`, textColor);
  let y = rect[3] - padding - afm.Ascender / 1000 * size;
  for (const line of lines) {
    const { hex, width } = standardText('Helvetica', line);
    const w = width * size / 1000;
    const x = rect[0] + padding + (q === 1 ? (inner - w) / 2 : q === 2 ? inner - w : 0);
    ops.push(`1 0 0 1 ${pt(x, y)} Tm <${hex}> Tj`);
    y -= size * 1.15;
  }
  ops.push('ET', 'Q');
  // Its callout line, if it has one.
  const cl = numbers(ctx, get(ctx, annot, 'CL'));
  if (cl && cl.length >= 4 && cl.every(Number.isFinite)) {
    const pts = [];
    for (let i = 0; i + 1 < cl.length; i += 2) pts.push([cl[i], cl[i + 1]]);
    ops.push(textColor.replace(/ (g|rg|k)$/, (m) => m.toUpperCase()), `${fmt(Math.max(b.width, 1))} w`,
      `${pts.map((p, i) => `${pt(...p)} ${i ? 'l' : 'm'}`).join(' ')} S`);
    return { ops, box: union(rect, bounds(pts, Math.max(b.width, 1))), resources };
  }
  return { ops, box: rect, resources };
}

/** A rubber stamp with no look: its name ("Approved") in capitals in a rounded frame. */
function stamp(env, annot, rect, c) {
  const { ctx } = env;
  const raw = getName(ctx, annot, 'Name') ?? 'Draft';
  const label = raw.replace(/^SB/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
  const stroke = c ? c.stroke : '0.75 0.1 0.1 RG';
  const fill = c ? c.fill : '0.75 0.1 0.1 rg';
  const w = rect[2] - rect[0];
  const h = rect[3] - rect[1];
  const line = Math.max(1, Math.min(w, h) / 15);
  const font = 'Helvetica-Bold';
  const { hex, width } = standardText(font, label);
  const size = Math.max(1, Math.min((h - 4 * line) * 0.7, (w - 6 * line) / Math.max(width / 1000, 0.001)));
  const r = Math.min(w, h) / 6;
  const x0 = rect[0] + line / 2;
  const y0 = rect[1] + line / 2;
  const x1 = rect[2] - line / 2;
  const y1 = rect[3] - line / 2;
  const k = 0.5523 * r;
  const ops = [stroke, fill, `${fmt(line)} w`,
    `${pt(x0 + r, y0)} m ${pt(x1 - r, y0)} l ${pt(x1 - r + k, y0)} ${pt(x1, y0 + r - k)} ${pt(x1, y0 + r)} c `
    + `${pt(x1, y1 - r)} l ${pt(x1, y1 - r + k)} ${pt(x1 - r + k, y1)} ${pt(x1 - r, y1)} c `
    + `${pt(x0 + r, y1)} l ${pt(x0 + r - k, y1)} ${pt(x0, y1 - r + k)} ${pt(x0, y1 - r)} c `
    + `${pt(x0, y0 + r)} l ${pt(x0, y0 + r - k)} ${pt(x0 + r - k, y0)} ${pt(x0 + r, y0)} c S`,
    'BT', `/HeBo ${fmt(size)} Tf`,
    `1 0 0 1 ${pt(rect[0] + (w - width / 1000 * size) / 2, rect[1] + (h - 0.72 * size) / 2)} Tm <${hex}> Tj`, 'ET'];
  return { ops, box: rect, resources: { Font: { HeBo: env.standardFont(font) } } };
}

/**
 * A look for comment `annot` (of /Subtype `subtype`, on rectangle `rect`) that has none:
 * { raw, box } where raw is the new appearance stream (registered, its box in page coordinates)
 * and box the rectangle it is to be placed on. Null when the kind isn't one drawn this way or
 * there is nothing to draw.
 */
export function constructAppearance(env, annot, subtype, rect) {
  const { ctx } = env;
  let made;
  try {
    made = draw(env, annot, subtype, rect);
  } catch {
    return null;
  }
  if (!made || !made.ops.length) return null;
  const box = made.box;
  if (!(box[2] - box[0] > 0) || !(box[3] - box[1] > 0)) return null;
  const stream = ctx.flateStream(made.ops.join('\n') + '\n', {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: box, Resources: made.resources ?? {},
  });
  return { raw: ctx.register(stream), box };
}

