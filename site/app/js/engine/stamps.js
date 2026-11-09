// Add page numbers and Add watermark: the app's PageStamps.kt (where numbers and watermarks go on
// a page as it is shown), Watermark.kt (the watermark's text, colours and opacities) and the
// page-number and watermark parts of PdfToolsEngine.kt and PdfToolsViewModel.kt.
//
// Both draw on each page as a viewer shows it: its crop box (cut to the media box), turned by its
// /Rotate, so a number put at the bottom of a page turned sideways is still at the bottom the
// reader sees. The text is real text drawn with the text engine (engine/text/), and the page's own
// drawing is wrapped in q/Q first, so whatever state it leaves set can't move or recolour it.
import { PDFName, PDFPage, PDFPageLeaf } from '../lib/pdf-lib.js';
import { loadPdf, savePdf } from './pdf-common.js';
import { repairPageTree, setPages, boxesOf, rotationOf, ticker } from './cleanup.js';
import {
  PdfCanvas, createFormCanvas, measureText, measureTextSync, ensureFonts, canDraw, pageFrame, fileMetrics,
} from './text/index.js';
import { UserError, checkCancelled } from '../core/errors.js';
import { sanitizeName } from '../core/names.js';
import {
  PageFrame, DEFAULT_COLOR, WATERMARK_MAX_LENGTH, STAMP_PAD, FALLBACK_NAMES, positionOf, alphaOf,
  numberOrigin, numberStyle, numberedPages, watermarkStyle, placeWatermark, defaultName,
} from './stamps-layout.js';

// The layout, the choices and the names (no pdf-lib), for the screens to load on their own.
export * from './stamps-layout.js';

// ---------------------------------------------------------------------------------------------
// The page as a PDF has it, and the watermark's text (the rest is stamps-layout.js)

/**
 * The frame of a page dictionary of `doc`, as viewers read it: its crop box (inherited, cut to the
 * media box) and its turn (anything but a quarter turn counts as none, as pdf.js reads it).
 */
export function frameOfPage(doc, pageDict) {
  const { crop } = boxesOf(doc.context, pageDict);
  return new PageFrame(crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1], rotationOf(doc.context, pageDict));
}

/**
 * Whether a font (bundled, or the browser's) has every character of `text` that needs drawing
 * (WatermarkText.canDraw). Spaces, joiners and variation selectors need none.
 */
export function canDrawWatermark(text) {
  return canDraw(String(text ?? ''), watermarkStyle());
}

/**
 * The watermark's stamp (WatermarkText.render): `text` (trimmed) laid out in `color`, in a box just
 * around its ink with 2 points to spare, as the app's one-page stamp PDF. Throws
 * UserError('watermark_no_font') when no font can draw some of it (or it draws nothing), and
 * RangeError for blank or over-long text. Loads the fonts it needs (UserError
 * 'web_fonts_unavailable' when they can't be fetched).
 * @returns {Promise<{ text, style, width, height, x, baseline, layout }>} width × height in points; the
 *   text's pen starts at (x, baseline) from the box's top-left corner, y down
 */
export async function watermarkStamp(text, color = DEFAULT_COLOR) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || trimmed.length > WATERMARK_MAX_LENGTH) throw new RangeError(`Watermark text must have 1 to ${WATERMARK_MAX_LENGTH} characters`);
  const style = watermarkStyle(color);
  if (!canDraw(trimmed, style)) throw new UserError('watermark_no_font');
  const m = await measureText(trimmed, style);
  // Whole points, as Android's getTextBounds rounds the ink out to whole pixels.
  const left = Math.floor(m.ink.left);
  const top = Math.floor(m.ink.top);
  const right = Math.ceil(m.ink.right);
  const bottom = Math.ceil(m.ink.bottom);
  if (!(right > left && bottom > top) || ![left, top, right, bottom].every(Number.isFinite)) throw new UserError('watermark_no_font');
  return {
    text: trimmed,
    style,
    width: right - left + 2 * STAMP_PAD,
    height: bottom - top + 2 * STAMP_PAD,
    x: STAMP_PAD - left,
    baseline: STAMP_PAD - top,
    layout: m.layout,
  };
}

/** Draws the stamp's text with its box's top-left corner at (x, y), on a PdfCanvas or a screen canvas's 2D context. */
export function drawStamp(target, stamp, x = 0, y = 0) {
  stamp.layout.draw(target, x + stamp.x, y + stamp.baseline - stamp.layout.firstBaseline);
}

/**
 * Draws the watermark on a screen canvas's 2D context covering a page shown `width` × `height`
 * (in the context's units), as the PDF will have it: at the same place and angle, as big compared
 * with the page (WatermarkPreview). Opacity is left to the caller (the preview fades the layer as a
 * whole, as the PDF's transparency group does).
 */
export function paintWatermark(ctx, stamp, width, height) {
  if (!stamp || !(width > 0 && height > 0)) return;
  const p = placeWatermark(width, height, stamp.width, stamp.height);
  ctx.save();
  // The layout's y points up; the screen's points down, so the turn is the other way.
  ctx.translate(p.centerX, height - p.centerY);
  ctx.rotate(-p.degrees * Math.PI / 180);
  ctx.scale(p.scale, p.scale);
  drawStamp(ctx, stamp, -stamp.width / 2, -stamp.height / 2);
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Opening and drawing

function checkInput(input) {
  if (!input || !(input.bytes instanceof Uint8Array)) throw new TypeError('input.bytes must be a Uint8Array');
}

/** The pages of `doc` as viewers find them (a damaged tree mended), as pdf-lib pages to draw on. */
function pagesOf(doc) {
  const ctx = doc.context;
  let pages;
  try {
    pages = repairPageTree(doc).pages;
    // A page held inline in the tree needs an object of its own to draw on.
    if (pages.some((p) => !p.ref)) {
      setPages(doc, pages);
      pages = repairPageTree(doc).pages;
    }
  } catch (e) {
    // No catalog or page tree to speak of: as a file that isn't a PDF.
    if (e instanceof UserError) throw e;
    throw new UserError('pdf_import_failed');
  }
  return pages.map(({ ref, dict }) => {
    let leaf = dict;
    if (!(dict instanceof PDFPageLeaf)) {
      // A page that lacked its /Type was read as a plain dictionary.
      leaf = PDFPageLeaf.fromMapWithContext(new Map(dict.entries()), ctx);
      ctx.assign(ref, leaf);
    }
    return { page: PDFPage.of(leaf, ref, doc), dict: leaf };
  });
}

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
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/**
 * A canvas on `page` whose units are points of the page as shown, from its top-left corner with y
 * down, by `frame` (the crop box cut to the media box, as viewers show it).
 */
function shownCanvas(doc, page, dict, frame) {
  let base;
  try {
    base = pageFrame(page, 'page').matrix;
  } catch {
    // A media box pdf-lib can't read: the one viewers take for it, written out.
    const { media } = boxesOf(doc.context, dict);
    dict.set(PDFName.of('MediaBox'), doc.context.obj(media));
    base = pageFrame(page, 'page').matrix;
  }
  const canvas = new PdfCanvas(page, { frame: 'page' });
  const m = mul(frame.topLeftMatrix, inv(base));
  canvas.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  return canvas;
}

const usable = (frame) => frame.shownWidth > 0 && frame.shownHeight > 0 && Number.isFinite(frame.shownWidth) && Number.isFinite(frame.shownHeight);

function output(name, bytes, pageCount, input) {
  return {
    name: name + '.pdf',
    bytes,
    type: 'application/pdf',
    pageCount,
    ...(input.password ? { passwordRemoved: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The engines

/**
 * Writes on pages of `input` its own page number, as text, at `position` on the page as it is
 * shown (PdfToolsEngine.addPageNumbers). The pages are `pages` (zero-based), or all but those in
 * `skip` ("1" or "1-2,5"), read against `skipAgainst` pages (several PDFs read them against the
 * longest) or the PDF's own count. Throws UserError('page_numbers_all_skipped') when no page is
 * left to number, PageSelectionError for `skip` it can't use.
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {{ pages?: number[], skip?: string, skipAgainst?: number, position?: string, size?: string|number, fileName?: string }} options
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<OutputFile>}
 */
export async function addPageNumbers(input, options = {}, hooks = {}) {
  checkInput(input);
  const tick = ticker(hooks.signal);
  const position = positionOf(options.position);
  const style = numberStyle(options.size);
  const name = sanitizeName(options.fileName ?? defaultName('page-numbers', input), FALLBACK_NAMES['page-numbers']);
  checkCancelled(hooks.signal);
  const doc = await loadPdf(input.bytes, { password: input.password || undefined });
  await tick();
  const pages = pagesOf(doc);
  let chosen;
  if (Array.isArray(options.pages)) {
    chosen = [...new Set(options.pages)].filter((i) => Number.isInteger(i) && i >= 0 && i < pages.length).sort((a, b) => a - b);
  } else {
    chosen = numberedPages(options.skip ?? '', Math.max(pages.length, options.skipAgainst ?? 0)).filter((i) => i < pages.length);
  }
  if (!chosen.length) throw new UserError('page_numbers_all_skipped');
  await ensureFonts('0123456789', style);
  // Digits are as tall as capitals.
  const digitHeight = fileMetrics('NotoSans-Regular.ttf').capHeight * style.size;
  const total = chosen.length + 1;
  for (let n = 0; n < chosen.length; n++) {
    await tick();
    const index = chosen[n];
    const { page, dict } = pages[index];
    const frame = frameOfPage(doc, dict);
    if (usable(frame)) {
      const label = String(index + 1);
      const width = measureTextSync(label, style).width;
      const [x, y] = numberOrigin(position, frame.shownWidth, frame.shownHeight, width, digitHeight);
      shownCanvas(doc, page, dict, frame).fillText(label, x, frame.shownHeight - y, style);
    }
    hooks.onProgress?.(n + 1, total);
  }
  await tick();
  const bytes = await savePdf(doc);
  checkCancelled(hooks.signal);
  hooks.onProgress?.(total, total);
  return output(name, bytes, pages.length, input);
}

/**
 * Draws `text` large, diagonally across the middle of every page as it is shown, in `color`
 * ('gray', 'black', 'red', 'blue', 'green' or a CSS colour) with `opacity` ('translucent',
 * 'semi', 'opaque' or an alpha), as real text (PdfToolsEngine.addWatermark). The text is drawn once,
 * in a form all pages show. `stamp` (from watermarkStamp) may be given to reuse one made for
 * several PDFs. Throws UserError('watermark_no_font') before opening the PDF when no font can draw
 * the text.
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {{ text: string, color?: string, opacity?: string|number, fileName?: string, stamp?: object }} options
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<OutputFile>}
 */
export async function addWatermark(input, options = {}, hooks = {}) {
  checkInput(input);
  const tick = ticker(hooks.signal);
  const alpha = alphaOf(options.opacity);
  const stamp = options.stamp ?? await watermarkStamp(options.text, options.color);
  const name = sanitizeName(options.fileName ?? defaultName('watermark', input), FALLBACK_NAMES.watermark);
  checkCancelled(hooks.signal);
  const doc = await loadPdf(input.bytes, { password: input.password || undefined });
  await tick();
  const pages = pagesOf(doc);
  // As a transparency group, the opacity applies to the watermark as a whole.
  const form = createFormCanvas(doc, stamp.width, stamp.height);
  drawStamp(form, stamp, 0, 0);
  const total = pages.length + 1;
  for (let i = 0; i < pages.length; i++) {
    await tick();
    const { page, dict } = pages[i];
    const frame = frameOfPage(doc, dict);
    if (usable(frame)) {
      const place = placeWatermark(frame.shownWidth, frame.shownHeight, stamp.width, stamp.height);
      const canvas = shownCanvas(doc, page, dict, frame);
      canvas.globalAlpha = alpha;
      canvas.translate(place.centerX, frame.shownHeight - place.centerY);
      canvas.rotate(-place.degrees * Math.PI / 180);
      canvas.scale(place.scale, place.scale);
      canvas.drawForm(form, -stamp.width / 2, -stamp.height / 2, stamp.width, stamp.height);
    }
    hooks.onProgress?.(i + 1, total);
  }
  await tick();
  const bytes = await savePdf(doc);
  checkCancelled(hooks.signal);
  hooks.onProgress?.(total, total);
  return output(name, bytes, pages.length, input);
}
