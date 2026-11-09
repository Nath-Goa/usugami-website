// Where each glyph of a page is, for Find text. pdf.js's text content gives runs of text, not
// glyphs, so this follows the page's operator list (its content and its annotations' appearances,
// as pdf.js draws them) the way pdf.js's canvas does, glyph by glyph, with each glyph's own advance.
// Then, as the app's PDFBox text stripper does, the glyphs are read into lines and words, and a
// gap where the PDF has no space is told from the spacing of letter-spaced text.
import { pdfjsLib } from '../../lib/pdfjs.js';
import { multiply, IDENTITY, boxesFor } from './boxes.js';
import { PageTextBuilder } from './page-text.js';
import { readingOrder, mirror } from './bidi.js';

const { OPS, AnnotationMode } = pdfjsLib;

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const FONT_IDENTITY = [0.001, 0, 0, 0.001, 0, 0];

/** The font boxes of Helvetica, Times and Courier, regular and bold (from their font metrics). */
const STANDARD_BOXES = {
  'sans-serif': [[-166, -225, 1000, 931], [-170, -228, 1003, 962]],
  serif: [[-168, -218, 1000, 898], [-168, -218, 1000, 935]],
  monospace: [[-23, -250, 715, 805], [-113, -250, 749, 801]],
};

/** How long to wait for pdf.js to hand over a font before reading on with typical measures. */
const FONT_WAIT_MS = 15000;

/**
 * How far a font reaches above and below the baseline, in ems: the higher of its ascent and its
 * bounding box's top, so accents on capitals are covered, and the lower of its descent and its
 * bounding box's bottom. Values out of reason give way to typical ones (as the app's fontExtent).
 */
function fontExtent(font) {
  if (!font || typeof font !== 'object') return { ascent: 1, descent: -0.3, height: 0.6 };
  const fm = font.fontMatrix ?? FONT_IDENTITY;
  const sy = Math.abs(fm[3]) || 0.001;
  const ascents = [];
  const descents = [];
  if (typeof font.ascent === 'number') ascents.push(font.ascent);
  if (typeof font.descent === 'number') descents.push(font.descent);
  let bbox = font.bbox;
  // pdf.js keeps no box for the standard fonts: theirs, as PDF readers know them.
  if (!(bbox && bbox.length === 4 && bbox[3] > bbox[1])) bbox = STANDARD_BOXES[font.fallbackName]?.[font.bold ? 1 : 0];
  let height = 0.6;
  if (bbox && bbox.length === 4) {
    ascents.push(bbox[3] * sy);
    descents.push(bbox[1] * sy);
    // Text extraction takes half the font's box as a glyph's height.
    const half = ((bbox[3] - bbox[1]) * sy) / 2;
    if (half >= 0.3 && half <= 1) height = half;
  }
  const ascent = Math.max(...ascents.filter((a) => a >= 0.5 && a <= 1.3), -Infinity);
  const descent = Math.min(...descents.filter((d) => d >= -0.5 && d <= -0.05), Infinity);
  return {
    ascent: Number.isFinite(ascent) ? ascent : 1,
    descent: Number.isFinite(descent) ? descent : -0.3,
    height,
  };
}

/** The fonts the operator list sets, once pdf.js has them ready. */
async function loadFonts(page, opList) {
  const ids = new Set();
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] === OPS.setFont) ids.add(argsArray[i][0]);
    else if (fnArray[i] === OPS.setGState) {
      for (const [key, value] of argsArray[i][0] ?? []) if (key === 'Font' && Array.isArray(value)) ids.add(value[0]);
    }
  }
  const fonts = new Map();
  await Promise.all([...ids].map((id) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), FONT_WAIT_MS);
    try {
      page.commonObjs.get(id, (font) => {
        clearTimeout(timer);
        resolve(font);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  }).then((font) => fonts.set(id, font))));
  return fonts;
}

/**
 * The glyphs pdf.js draws on a page, its annotations' appearances included, in drawing order:
 * [{ unicode, points (four corners, user space: start and end at the descent, start and end at
 * the ascent), origin, end, up (one em up, as a vector), spaceWidth, height (text extraction's
 * glyph height), chars }], everything in the page's own coordinates (PDF user space).
 */
export async function pageGlyphs(page) {
  const opList = await page.getOperatorList({ intent: 'display', annotationMode: AnnotationMode.ENABLE });
  const fonts = await loadFonts(page, opList);
  const extents = new Map();
  const extentOf = (font) => {
    if (!extents.has(font)) extents.set(font, fontExtent(font));
    return extents.get(font);
  };
  // Each font's space width, in ems, once one of its spaces has been seen.
  const spaces = new Map();
  const glyphs = [];

  const fresh = (ctm) => ({
    ctm, textMatrix: null, x: 0, y: 0, lineX: 0, lineY: 0, charSpacing: 0, wordSpacing: 0,
    textHScale: 1, leading: 0, font: null, fontSize: 0, fontDirection: 1, fontMatrix: FONT_IDENTITY, textRise: 0,
  });
  let st = fresh(IDENTITY);
  const stack = [];
  const annotationDepths = [];

  const setFont = (id, size) => {
    const font = fonts.get(id);
    st.font = font && typeof font === 'object' ? font : null;
    st.fontMatrix = st.font?.fontMatrix ?? FONT_IDENTITY;
    if (size < 0) {
      st.fontSize = -size;
      st.fontDirection = -1;
    } else {
      st.fontSize = size;
      st.fontDirection = 1;
    }
  };
  const moveText = (tx, ty) => {
    st.x = st.lineX += tx;
    st.y = st.lineY += ty;
  };

  const showText = (items) => {
    const font = st.font;
    const fontSize = st.fontSize;
    if (!fontSize) return;
    const fd = st.fontDirection;
    const hs = st.textHScale * fd;
    const fm = st.fontMatrix;
    const type3 = !!font?.isType3Font;
    const vertical = !type3 && !!font?.vertical;
    const spacingDir = font?.vertical ? 1 : -1;
    const extent = extentOf(font);
    const base = multiply(st.ctm, multiply(st.textMatrix ?? IDENTITY, [1, 0, 0, 1, st.x, st.y + st.textRise]));
    // Glyphs are placed in a local space: pdf.js's canvas space (y down) for fonts it draws, the
    // font's own (y up) for Type 3 fonts.
    const local = multiply(base, type3 ? [hs, 0, 0, fd, 0, 0] : (fd > 0 ? [hs, 0, 0, -1, 0, 0] : [hs, 0, 0, 1, 0, 0]));
    const upSign = type3 ? 1 : -1;
    const was = fontSize * (fm[0] || 0.001);
    const alongUnit = Math.hypot(local[0], local[1]);
    let spaceEm = spaces.get(font);
    let x = 0;
    for (const glyph of items) {
      if (typeof glyph === 'number') {
        x += (spacingDir * glyph * fontSize) / 1000;
        continue;
      }
      if (!glyph || typeof glyph !== 'object') continue;
      const spacing = (glyph.isSpace ? st.wordSpacing : 0) + st.charSpacing;
      const unicode = typeof glyph.unicode === 'string' ? glyph.unicode : '';
      const width = Number.isFinite(glyph.width) ? glyph.width : 0;
      if ((glyph.isSpace || unicode === ' ') && width > 0 && spaceEm === undefined) {
        spaceEm = width * (fm[0] || 0.001);
        spaces.set(font, spaceEm);
      }
      let points, origin, end, up, advance;
      const asc = extent.ascent * fontSize * upSign;
      const desc = extent.descent * fontSize * upSign;
      if (type3) {
        const w = (fm[0] * width + fm[2] * 0) * fontSize;
        points = [[x, desc], [x + w, desc], [x, asc], [x + w, asc]];
        origin = [x, 0];
        end = [x + w, 0];
        up = [x, fontSize];
        advance = w + spacing;
      } else if (vertical) {
        const vmetric = Array.isArray(glyph.vmetric) ? glyph.vmetric : [-1000, width / 2, 880];
        const vx = -vmetric[1] * was;
        const vy = vmetric[2] * was;
        const down = -vmetric[0] * was;
        const across = (width || -vmetric[0]) * was;
        const baseline = x + vy;
        points = [[vx, baseline + desc], [vx + across, baseline + desc], [vx, baseline + asc], [vx + across, baseline + asc]];
        origin = [0, x];
        end = [0, x + down];
        up = [fontSize, x];
        advance = down - spacing * fd;
      } else {
        const w = width * was;
        points = [[x, desc], [x + w, desc], [x, asc], [x + w, asc]];
        origin = [x, 0];
        end = [x + w, 0];
        up = [x, -fontSize];
        advance = w + spacing * fd;
      }
      const o = apply(local, origin[0], origin[1]);
      const u = apply(local, up[0], up[1]);
      glyphs.push({
        unicode,
        points: points.map(([px, py]) => apply(local, px, py)),
        origin: o,
        end: apply(local, end[0], end[1]),
        up: [u[0] - o[0], u[1] - o[1]],
        spaceWidth: (spaceEm ?? 0.25) * fontSize * alongUnit,
        height: extent.height,
        chars: Math.max(1, unicode.length),
      });
      x += advance;
    }
    if (type3 || !vertical) st.x += x * hs;
    else st.y -= x;
  };

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const args = argsArray[i] ?? [];
    switch (fnArray[i]) {
      case OPS.save:
        stack.push({ ...st });
        break;
      case OPS.restore:
        if (stack.length > (annotationDepths[annotationDepths.length - 1] ?? 0)) st = stack.pop();
        break;
      case OPS.transform:
        st.ctm = multiply(st.ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ...st });
        if (args[0]) st.ctm = multiply(st.ctm, Array.from(args[0]));
        break;
      case OPS.paintFormXObjectEnd:
      case OPS.endGroup:
        if (stack.length) st = stack.pop();
        break;
      case OPS.beginGroup:
        stack.push({ ...st });
        break;
      case OPS.beginAnnotation: {
        // Drawn from the page's own coordinates, whatever state the page's content left.
        annotationDepths.push(stack.length);
        stack.push({ ...st });
        const transform = args[2] ?? IDENTITY;
        const matrix = args[3] ?? IDENTITY;
        st = fresh(multiply(multiply(IDENTITY, Array.from(transform)), Array.from(matrix)));
        break;
      }
      case OPS.endAnnotation: {
        const depth = annotationDepths.pop() ?? 0;
        while (stack.length > depth + 1) stack.pop();
        if (stack.length > depth) st = stack.pop();
        break;
      }
      case OPS.beginText:
        st.textMatrix = null;
        st.x = st.lineX = 0;
        st.y = st.lineY = 0;
        break;
      case OPS.setTextMatrix: {
        const m = args.length === 1 ? Array.from(args[0]) : args.slice(0, 6);
        st.textMatrix = m;
        st.x = st.lineX = 0;
        st.y = st.lineY = 0;
        break;
      }
      case OPS.moveText:
        moveText(args[0], args[1]);
        break;
      case OPS.setLeadingMoveText:
        st.leading = args[1];
        moveText(args[0], args[1]);
        break;
      case OPS.setLeading:
        st.leading = -args[0];
        break;
      case OPS.nextLine:
        moveText(0, st.leading);
        break;
      case OPS.setCharSpacing:
        st.charSpacing = args[0];
        break;
      case OPS.setWordSpacing:
        st.wordSpacing = args[0];
        break;
      case OPS.setHScale:
        st.textHScale = args[0] / 100;
        break;
      case OPS.setTextRise:
        st.textRise = args[0];
        break;
      case OPS.setFont:
        setFont(args[0], args[1]);
        break;
      case OPS.setGState:
        for (const [key, value] of args[0] ?? []) if (key === 'Font' && Array.isArray(value)) setFont(value[0], value[1]);
        break;
      case OPS.showText:
        showText(args[0] ?? []);
        break;
      default:
        break;
    }
  }
  return glyphs;
}

// ---- Reading glyphs as text ----

const SPACING_TOLERANCE = 0.5;
const AVERAGE_CHAR_TOLERANCE = 0.3;

/**
 * Each glyph placed on the page as shown (points from its top-left corner, y down), with text
 * extraction's measures in the direction its line runs (0, 90, 180 or 270 degrees, clockwise).
 */
function onShownPage(glyphs, frame) {
  const sh = frame.shownHeight;
  const shown = ([x, y]) => {
    const [sx, sy] = frame.toShown(x, y);
    return [sx, sh - sy];
  };
  const out = [];
  for (const g of glyphs) {
    const points = g.points.map(shown);
    const origin = shown(g.origin);
    const end = shown(g.end);
    const tip = shown([g.origin[0] + g.up[0], g.origin[1] + g.up[1]]);
    const up = [tip[0] - origin[0], tip[1] - origin[1]];
    if (![...points.flat(), ...origin, ...end, ...up].every(Number.isFinite)) continue;
    let bx = end[0] - origin[0];
    let by = end[1] - origin[1];
    if (Math.hypot(bx, by) < 1e-9) {
      bx = -up[1];
      by = up[0];
    }
    const dir = ((Math.round(Math.atan2(by, bx) / (Math.PI / 2)) % 4) + 4) % 4;
    const cos = [1, 0, -1, 0][dir];
    const sin = [0, 1, 0, -1][dir];
    const along = ([x, y]) => x * cos + y * sin;
    const acrossOf = ([x, y]) => -x * sin + y * cos;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    // Whether the line runs across the page as shown, from the direction of the advance (or of "up").
    const dx = end[0] - origin[0];
    const dy = end[1] - origin[1];
    const across = dx !== 0 || dy !== 0 ? Math.abs(dx) >= Math.abs(dy) : Math.abs(up[1]) >= Math.abs(up[0]);
    const em = Math.hypot(up[0], up[1]);
    out.push({
      unicode: g.unicode,
      chars: g.chars,
      box: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys), across },
      x: origin[0],
      y: origin[1],
      dir,
      xAdj: along(origin),
      yAdj: acrossOf(origin),
      width: Math.abs(along(end) - along(origin)),
      height: g.height * em,
      spaceWidth: g.spaceWidth,
    });
  }
  return out;
}

/** Whether a glyph that reads as `unicode` is an accent drawn on its own (PDFBox's isDiacritic). */
function isDiacritic(unicode) {
  if (unicode.length !== 1 || unicode === 'ー') return false;
  return /[\p{Mn}\p{Sk}\p{Lm}]/u.test(unicode);
}

/** Whether glyph b sits over a (PDFBox's TextPosition.contains), as an accent over its letter. */
function contains(a, b) {
  const aStart = a.xAdj;
  const aEnd = a.xAdj + a.width;
  const bStart = b.xAdj;
  const bEnd = b.xAdj + b.width;
  if (bEnd <= aStart || bStart >= aEnd) return false;
  if (b.yAdj + b.height < a.yAdj - a.height || b.yAdj - b.height > a.yAdj) return false;
  if (bStart > aStart && bEnd > aEnd) return (aEnd - bStart) / (a.width || 1) > 0.15;
  if (bStart < aStart && bEnd < aEnd) return (bEnd - aStart) / (a.width || 1) > 0.15;
  return true;
}

/**
 * The glyphs as text extraction keeps them: a glyph drawn twice in the same place (fake bold) once,
 * and an accent drawn on its own merged into the letter under it.
 */
function kept(glyphs) {
  const out = [];
  const seen = new Map();
  for (const g of glyphs) {
    const tolerance = g.width / g.chars / 3;
    const cell = (v) => Math.floor(v);
    let duplicate = false;
    const reach = Math.ceil(tolerance);
    if (reach <= 8) {
      for (let dx = -reach; dx <= reach && !duplicate; dx++) {
        for (let dy = -reach; dy <= reach && !duplicate; dy++) {
          for (const [x, y] of seen.get(`${g.unicode}|${cell(g.x) + dx}|${cell(g.y) + dy}`) ?? []) {
            if (Math.abs(x - g.x) <= tolerance && Math.abs(y - g.y) <= tolerance) {
              duplicate = true;
              break;
            }
          }
        }
      }
    } else {
      for (const [key, list] of seen) {
        if (!key.startsWith(`${g.unicode}|`)) continue;
        if (list.some(([x, y]) => Math.abs(x - g.x) <= tolerance && Math.abs(y - g.y) <= tolerance)) {
          duplicate = true;
          break;
        }
      }
    }
    if (duplicate) continue;
    const key = `${g.unicode}|${cell(g.x)}|${cell(g.y)}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push([g.x, g.y]);
    const previous = out[out.length - 1];
    if (previous && isDiacritic(g.unicode) && contains(previous, g)) continue;
    if (previous && isDiacritic(previous.unicode) && contains(g, previous)) out.pop();
    out.push(g);
  }
  return out;
}

/** Whether a line with baseline y2 and height h2 is one a glyph at y1, h1 tall is on (PDFBox's overlap). */
function overlap(y1, height1, y2, height2) {
  return Math.abs(y1 - y2) < 0.1 || (y2 <= y1 && y2 >= y1 - height1) || (y1 <= y2 && y1 >= y2 - height2);
}

/** PDFBox's TextPositionComparator: by direction, then by line, then along it. */
function compareByPosition(a, b) {
  if (a.dir !== b.dir) return a.dir - b.dir;
  const aTop = a.yAdj - a.height;
  const bTop = b.yAdj - b.height;
  const yDifference = Math.abs(a.yAdj - b.yAdj);
  if (yDifference < 0.1 || (b.yAdj >= aTop && b.yAdj <= a.yAdj) || (a.yAdj >= bTop && a.yAdj <= b.yAdj)) return a.xAdj - b.xAdj;
  return a.yAdj < b.yAdj ? -1 : 1;
}

/**
 * The glyphs in lines, as text extraction reads them: [[glyph or null (a gap where a new word
 * would start), ...], ...].
 */
function lines(glyphs) {
  const out = [];
  let line = [];
  let last = null;
  let maxY = -Infinity;
  let maxHeight = -1;
  let endOfLastX = null;
  let lastWordSpacing = -1;
  let previousAverage = -1;
  for (const g of glyphs) {
    const wordSpacing = g.spaceWidth;
    let deltaSpace;
    if (!wordSpacing || Number.isNaN(wordSpacing)) deltaSpace = Infinity;
    else if (lastWordSpacing < 0) deltaSpace = wordSpacing * SPACING_TOLERANCE;
    else deltaSpace = ((wordSpacing + lastWordSpacing) / 2) * SPACING_TOLERANCE;
    const average = previousAverage < 0 ? g.width / g.chars : (previousAverage + g.width / g.chars) / 2;
    const deltaChar = average * AVERAGE_CHAR_TOLERANCE;
    let expected = endOfLastX === null ? null : endOfLastX + Math.min(deltaSpace, deltaChar);
    if (last) {
      if (g.dir !== last.dir || !overlap(g.yAdj, g.height, maxY, maxHeight)) {
        out.push(line);
        line = [];
        expected = null;
        maxY = -Infinity;
        maxHeight = -1;
      }
      if (expected !== null && expected < g.xAdj && !last.unicode.endsWith(' ')) line.push(null);
    }
    if (g.yAdj >= maxY) maxY = g.yAdj;
    endOfLastX = g.xAdj + g.width;
    line.push(g);
    maxHeight = Math.max(maxHeight, g.height);
    last = g;
    lastWordSpacing = wordSpacing;
    previousAverage = average;
  }
  if (line.length) out.push(line);
  return out;
}

/** The page's text as Find text reads it, from glyphs in the order given, and the glyphs it names. */
function readText(glyphs) {
  const builder = new PageTextBuilder();
  const order = [];
  lines(glyphs).forEach((line, index) => {
    if (index > 0) builder.lineBreak();
    for (const [glyph, mirrored] of readingOrder(line)) {
      // Text extraction found a gap there, with no space in the text: between two words, or
      // between two letters of letter-spaced text.
      if (glyph === null) {
        builder.gap();
        continue;
      }
      builder.glyph(order.length, mirrored ? mirror(glyph.unicode) : glyph.unicode);
      order.push(glyph);
    }
  });
  return { text: builder.build(), order };
}

/**
 * Every place `query` is found on a page, as boxes (fractions of the page as shown) over each line
 * of each match: [[box, ...], ...]. The text is read twice: in the order the PDF draws it, which
 * keeps a column's lines together so a phrase is found across a line break, and sorted by
 * position along each direction, which reads text that runs up or down the page as shown.
 * Matches found both ways count once.
 */
export function findOnPage(glyphs, frame, pageIndex, query) {
  const placed = kept(onShownPage(glyphs, frame));
  const found = new Map();
  for (const sorted of [false, true]) {
    const list = sorted ? placed.slice().sort(compareByPosition) : placed;
    const { text, order } = readText(list);
    for (const match of text.find(query)) {
      const shapes = match.map((i) => order[i].box);
      if (!shapes.length) continue;
      const boxes = boxesFor(pageIndex, shapes, frame.shownWidth, frame.shownHeight);
      // Rounded to a thousandth of a point or so: the same glyphs give the same boxes.
      const key = boxes.map((b) => [b.page, ...[b.left, b.top, b.right, b.bottom].map((v) => Math.trunc(Math.fround(v * 1e5)))].join(',')).join(';');
      if (!found.has(key)) found.set(key, boxes);
    }
  }
  return [...found.values()];
}

/** The page's text as Find text reads it in drawing order (for tests and checks). */
export function pageTextOf(glyphs, frame) {
  return readText(kept(onShownPage(glyphs, frame))).text.text;
}
