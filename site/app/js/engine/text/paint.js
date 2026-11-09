// Drawing laid-out text on a screen canvas (a CanvasRenderingContext2D), with the very glyph
// outlines the PDF gets, so a preview shows exactly what the PDF will (as the app's previews draw
// with the same Paint as its PDFs).
import { cssColor } from './color.js';
import { fallbackBitmap, fallbackResolution } from './fallback.js';
import { ITALIC_SKEW } from './fonts.js';

const paths = new Map();

function glyphPath(font, gid) {
  const key = font.id * 65536 + gid;
  let p = paths.get(key);
  if (p === undefined) {
    const glyph = font.fk.getGlyph(gid);
    const d = glyph?.path?.toSVG?.() ?? '';
    p = d && typeof Path2D !== 'undefined' ? new Path2D(d) : null;
    if (paths.size > 20000) paths.clear();
    paths.set(key, p);
  }
  return p;
}

/** Draws a ParagraphLayout with its top-left corner at (x, y) on a 2D canvas context. */
export function paintLayout(ctx, layout, x = 0, y = 0) {
  paintItems(ctx, layout.items(x, y));
}

/** Draws layout items (ParagraphLayout.items()) on a 2D canvas context. */
export function paintItems(ctx, items) {
  for (const it of items) {
    switch (it.kind) {
      case 'rect':
        ctx.fillStyle = cssColor(it.color);
        ctx.fillRect(it.x, it.y, it.w, it.h);
        break;
      case 'line':
        ctx.save();
        ctx.strokeStyle = cssColor(it.color);
        ctx.lineWidth = it.width;
        ctx.beginPath();
        ctx.moveTo(it.x1, it.y1);
        ctx.lineTo(it.x2, it.y2);
        ctx.stroke();
        ctx.restore();
        break;
      case 'glyphs':
        paintGlyphs(ctx, it);
        break;
      case 'fallback':
        paintFallback(ctx, it);
        break;
      case 'object':
        it.obj.draw?.(ctx, { x: it.x, y: it.y, width: it.w, height: it.h });
        break;
      default:
        break;
    }
  }
}

function paintGlyphs(ctx, run) {
  const k = run.size / run.font.upm;
  const skew = run.slant ? ITALIC_SKEW : 0;
  ctx.save();
  ctx.fillStyle = cssColor(run.color);
  for (let i = 0; i < run.gid.length; i++) {
    const p = glyphPath(run.font, run.gid[i]);
    if (!p) continue;
    ctx.save();
    ctx.translate(run.x + run.gx[i] + run.gdx[i], run.y - run.gdy[i]);
    ctx.transform(k * run.scaleX, 0, skew * k, -k, 0, 0);
    ctx.fill(p);
    ctx.restore();
  }
  ctx.restore();
}

const tinted = new Map();

function paintFallback(ctx, it) {
  const scale = Math.hypot(...matrixScale(ctx));
  const px = fallbackResolution(it.size * Math.max(1, scale / Math.SQRT2));
  const bmp = fallbackBitmap(it.text, it.family, it.bold, it.italic, it.rtl, px, it.emoji);
  if (!bmp) return;
  const image = bitmapCanvas(bmp, it.emoji ? null : it.color);
  if (!image) return;
  const S = it.size;
  ctx.drawImage(image, it.x - bmp.left * S * it.scaleX, it.y - bmp.top * S, (bmp.width / bmp.pxPerEm) * S * it.scaleX, (bmp.height / bmp.pxPerEm) * S);
}

function matrixScale(ctx) {
  try {
    const m = ctx.getTransform();
    return [Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)];
  } catch {
    return [1, 1];
  }
}

/** The fallback picture as a canvas, in `color` (or its own colours). */
function bitmapCanvas(bmp, color) {
  const key = bmp;
  let byColor = tinted.get(key);
  if (!byColor) {
    byColor = new Map();
    if (tinted.size > 500) tinted.clear();
    tinted.set(key, byColor);
  }
  const ck = color ? cssColor(color) : '';
  if (byColor.has(ck)) return byColor.get(ck);
  let canvas = null;
  try {
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const c = canvas.getContext('2d');
    const data = new ImageData(new Uint8ClampedArray(bmp.rgba), bmp.width, bmp.height);
    if (color) {
      // The browser's drawing gives the shape; the text's colour fills it.
      const px = data.data;
      const r = Math.round(color.r * 255);
      const g = Math.round(color.g * 255);
      const b = Math.round(color.b * 255);
      for (let i = 0; i < px.length; i += 4) {
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = Math.round(px[i + 3] * color.a);
      }
    }
    c.putImageData(data, 0, 0);
  } catch {
    canvas = null;
  }
  byColor.set(ck, canvas);
  return canvas;
}
