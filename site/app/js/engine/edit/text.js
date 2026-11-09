// Edit PDF's text (PageText.kt): laid out and drawn by the text engine, on the screen and in the PDF
// alike, so the PDF has the text exactly where the preview showed it. It stays real text that can be
// searched and selected, with only the letters used embedded.
import { ensureFonts, fontsReady, measureTextSync, fileMetrics, canDraw } from '../text/index.js';

/** Text is laid out and drawn at this size, in points, and scaled to its own. */
export const REFERENCE = 100;

/** Longer text is cut (the app keeps every text box in the state Android saves). */
export const TEXT_MAX_LENGTH = 500;

/** How text is drawn: the sans-serif family (Typeface.SANS_SERIF), at REFERENCE. */
export const TEXT_STYLE = Object.freeze({ family: 'sans-serif', size: REFERENCE });

/** The main font's line, per point of size: what Android's Paint.fontMetrics gives for it. */
const BASE = fileMetrics('NotoSans-Regular.ttf');

/**
 * `text` in lines, left-aligned, at REFERENCE, in `color`: each line's baseline is `ascent` plus
 * `lineHeight` for each line above it, below the top of the box, which is width × height.
 * Needs the fonts loaded (textLayout() loads them).
 * @returns {{ lines: Array<{ text: string, layout: object|null }>, width: number, ascent: number, lineHeight: number, height: number }}
 */
export function textLayoutSync(text, color = '#000000') {
  const style = { ...TEXT_STYLE, color };
  const lines = String(text).split('\n');
  let top = -BASE.ascent * REFERENCE;
  let bottom = BASE.descent * REFERENCE;
  let width = 0;
  const out = [];
  for (const line of lines) {
    if (!line) {
      out.push({ text: line, layout: null });
      continue;
    }
    const m = measureTextSync(line, style);
    // Scripts drawn from another font, such as Devanagari, can reach higher or lower than the main
    // font says; their own letters set the line height then.
    if (m.ink.bottom > m.ink.top) {
      top = Math.min(top, m.ink.top);
      bottom = Math.max(bottom, m.ink.bottom);
    }
    width = Math.max(width, m.width);
    out.push({ text: line, layout: m.layout });
  }
  const lineHeight = bottom - top;
  return { lines: out, width: Math.max(width, 1), ascent: -top, lineHeight, height: lineHeight * lines.length };
}

/** textLayoutSync(), once the fonts `text` needs are loaded. Rejects with UserError('web_fonts_unavailable') offline. */
export async function textLayout(text, color = '#000000') {
  await ensureFonts(String(text), TEXT_STYLE);
  return textLayoutSync(text, color);
}

/**
 * textLayoutSync() if the fonts `text` needs are loaded already, else null (without loading them):
 * for a screen that must draw at once, such as when the text's colour changes.
 */
export function textLayoutNow(text, color = '#000000') {
  return fontsReady(String(text), TEXT_STYLE) ? textLayoutSync(text, color) : null;
}

/** The box `text` needs at a font size of one point: [unitWidth, unitHeight] (see textItem()). */
export async function unitSize(text) {
  const layout = await textLayout(text);
  return [layout.width / REFERENCE, layout.height / REFERENCE];
}

/**
 * Whether every character of `text` that needs drawing can be drawn: by a bundled font, or else by
 * the browser (PageText.canDraw). Known without loading any font.
 */
export function canDrawText(text) {
  return canDraw(String(text), TEXT_STYLE);
}

/**
 * Draws `item` (a text item) with `layout` (textLayoutSync(item.text, item.color)) on `target`, a
 * PdfCanvas or a screen canvas's 2D context, in points on the page as shown.
 */
export function drawText(target, item, layout) {
  const k = item.size / REFERENCE;
  target.save();
  target.translate(item.x, item.y);
  target.scale(k, k);
  layout.lines.forEach((line, i) => {
    if (!line.layout) return;
    const baseline = layout.ascent + i * layout.lineHeight;
    line.layout.draw(target, 0, baseline - line.layout.firstBaseline);
  });
  target.restore();
}
