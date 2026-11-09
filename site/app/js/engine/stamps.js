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
import { parsePageSelection } from './page-selection.js';
import { repairPageTree, setPages, boxesOf, rotationOf, ticker } from './cleanup.js';
import {
  PdfCanvas, createFormCanvas, measureText, measureTextSync, ensureFonts, canDraw, pageFrame, fileMetrics,
} from './text/index.js';
import { UserError, checkCancelled } from '../core/errors.js';
import { sanitizeName, withSuffix, baseName, uniqueNames } from '../core/names.js';

// ---------------------------------------------------------------------------------------------
// The page as shown (PageStamps.kt's PageFrame)

const floorMod = (a, b) => ((a % b) + b) % b;

/**
 * A page as a viewer shows it: its crop box (`left`, `bottom`, `width`, `height`, in the page's
 * own coordinates) turned clockwise by `rotation`, the page's /Rotate. Numbers and watermarks are
 * laid out on the shown page, whose origin is its bottom-left corner as shown, with y up; `matrix`
 * takes those points to the page's own coordinates.
 */
export class PageFrame {
  constructor(left, bottom, width, height, rotation = 0) {
    const r = floorMod(Number(rotation), 360);
    if (!Number.isInteger(r) || r % 90 !== 0) throw new RangeError(`Rotation must be a multiple of 90, not ${rotation}`);
    this.left = left;
    this.bottom = bottom;
    this.width = width;
    this.height = height;
    /** 0, 90, 180 or 270. */
    this.rotation = r;
  }

  get sideways() { return this.rotation === 90 || this.rotation === 270; }
  get shownWidth() { return this.sideways ? this.height : this.width; }
  get shownHeight() { return this.sideways ? this.width : this.height; }

  /** [a, b, c, d, e, f] as in a PDF `cm` operator: page x = a·x + c·y + e and page y = b·x + d·y + f. */
  get matrix() {
    const { left, bottom, width, height } = this;
    switch (this.rotation) {
      case 0: return [1, 0, 0, 1, left, bottom];
      // The shown bottom-left corner is the box's bottom-right corner, and shown x runs up the page.
      case 90: return [0, 1, -1, 0, left + width, bottom];
      case 180: return [-1, 0, 0, -1, left + width, bottom + height];
      // The shown bottom-left corner is the box's top-left corner, and shown x runs down the page.
      default: return [0, -1, 1, 0, left, bottom + height];
    }
  }

  /** The same, for points measured from the shown top-left corner with y down (as on a canvas). */
  get topLeftMatrix() {
    const [a, b, c, d, e, f] = this.matrix;
    const h = this.shownHeight;
    return [a, b, -c, -d, e + c * h, f + d * h];
  }

  /** The page's own coordinates [x, y] of the shown point (`x`, `y`), origin bottom-left, y up. */
  toPage(x, y) {
    const m = this.matrix;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /** The shown point [x, y] (origin at its bottom-left corner, y up) at the page's own coordinates. */
  toShown(x, y) {
    const dx = x - this.left;
    const dy = y - this.bottom;
    switch (this.rotation) {
      case 0: return [dx, dy];
      case 90: return [dy, this.width - dx];
      case 180: return [this.width - dx, this.height - dy];
      default: return [this.height - dy, dx];
    }
  }
}

/**
 * The frame of a page dictionary of `doc`, as viewers read it: its crop box (inherited, cut to the
 * media box) and its turn (anything but a quarter turn counts as none, as pdf.js reads it).
 */
export function frameOfPage(doc, pageDict) {
  const { crop } = boxesOf(doc.context, pageDict);
  return new PageFrame(crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1], rotationOf(doc.context, pageDict));
}

// ---------------------------------------------------------------------------------------------
// Page numbers (PageStamps.kt's PageNumberPosition, PageNumberSize and PageNumbers)

/** Where page numbers go on the shown page: row (top or not) and column (0 left, 1 centre, 2 right). */
export const PAGE_NUMBER_POSITIONS = Object.freeze({
  'top-left': Object.freeze({ top: true, column: 0 }),
  'top-center': Object.freeze({ top: true, column: 1 }),
  'top-right': Object.freeze({ top: true, column: 2 }),
  'bottom-left': Object.freeze({ top: false, column: 0 }),
  'bottom-center': Object.freeze({ top: false, column: 1 }),
  'bottom-right': Object.freeze({ top: false, column: 2 }),
});

/** Font size of page numbers, in points. */
export const PAGE_NUMBER_SIZES = Object.freeze({ small: 9, medium: 12, large: 16 });

/** The screen's choices to start with, as the app's. */
export const DEFAULT_POSITION = 'bottom-center';
export const DEFAULT_SIZE = 'medium';

/** 'bottom-right', the app's 'BOTTOM_RIGHT' or a { top, column } object, as { top, column }. */
function positionOf(position) {
  if (position && typeof position === 'object' && 'top' in position) return position;
  const key = String(position ?? DEFAULT_POSITION).toLowerCase().replace(/_/g, '-');
  const p = PAGE_NUMBER_POSITIONS[key];
  if (!p) throw new RangeError(`No page number position ${position}`);
  return p;
}

/** 'small' | 'medium' | 'large' (or the app's names, or points) as points. */
function sizeOf(size) {
  if (typeof size === 'number' && size > 0) return size;
  const points = PAGE_NUMBER_SIZES[String(size ?? DEFAULT_SIZE).toLowerCase()];
  if (!points) throw new RangeError(`No page number size ${size}`);
  return points;
}

const isBlank = (text) => !/\S/.test(String(text ?? ''));

/**
 * The pages, zero-based, that get a number: all but those in `skip`, written like "1" or
 * "1-2,5" (blank skips none). Throws PageSelectionError (a UserError) for input it can't use.
 * Each page shows its own page number, so skipping a cover leaves page 2 numbered "2".
 * @param {string} skip
 * @param {number} pageCount
 * @returns {number[]}
 */
export function numberedPages(skip, pageCount) {
  if (!(pageCount > 0)) throw new RangeError('A PDF has at least one page');
  const all = Array.from({ length: pageCount }, (_, i) => i);
  if (isBlank(skip)) return all;
  const skipped = new Set(parsePageSelection(skip, pageCount));
  return all.filter((i) => !skipped.has(i));
}

/**
 * The pages to number in each of several PDFs of `pageCounts` pages, all skipping the pages in
 * `skip`, as numberedPages does for one. The pages to skip are read against the longest PDF: "4"
 * is fine while one of them has a page 4, and a shorter one has no page 4 to skip. A PDF with
 * every page skipped has none to number (an empty list).
 * @param {string} skip
 * @param {number[]} pageCounts
 * @returns {number[][]}
 */
export function numberedEach(skip, pageCounts) {
  if (!pageCounts?.length || !pageCounts.every((n) => n > 0)) throw new RangeError('Each PDF has at least one page');
  const longest = numberedPages(skip, Math.max(...pageCounts));
  return pageCounts.map((count) => longest.filter((i) => i < count));
}

/** Distance from the shown page's edges to the number: half an inch, less on small pages. */
export function numberMargin(shownWidth, shownHeight) {
  return Math.min(36, 0.06 * Math.min(shownWidth, shownHeight));
}

/**
 * Where the number's baseline starts on the shown page, [x, y] from its bottom-left corner with y
 * up. `textWidth` is the number's width and `textHeight` the height of its digits above the
 * baseline. A number at the bottom sits on the margin; one at the top hangs from it.
 */
export function numberOrigin(position, shownWidth, shownHeight, textWidth, textHeight) {
  const p = positionOf(position);
  const margin = numberMargin(shownWidth, shownHeight);
  let x;
  if (p.column === 0) x = margin;
  else if (p.column === 1) x = (shownWidth - textWidth) / 2;
  else x = shownWidth - margin - textWidth;
  const y = p.top ? shownHeight - margin - textHeight : margin;
  return [x, y];
}

/** How page numbers are drawn: the bundled sans-serif (the app draws Helvetica), black. */
export function numberStyle(size = DEFAULT_SIZE) {
  return { family: 'sans-serif', size: sizeOf(size), color: '#000000' };
}

// ---------------------------------------------------------------------------------------------
// Watermarks (Watermark.kt and PageStamps.kt's WatermarkLayout)

/** Watermark colours (Watermark.kt's WatermarkColor), as CSS colours. */
export const WATERMARK_COLORS = Object.freeze({
  gray: '#757575',
  black: '#000000',
  red: '#d32f2f',
  blue: '#1565c0',
  green: '#2e7d32',
});

/** How much of the page shows through the watermark (WatermarkOpacity): the watermark's alpha. */
export const WATERMARK_OPACITIES = Object.freeze({ translucent: 0.3, semi: 0.6, opaque: 1 });

export const DEFAULT_COLOR = 'gray';
export const DEFAULT_OPACITY = 'translucent';

/** Longest watermark text, in UTF-16 units as the app counts: longer would make the stamp wider than viewers accept. */
export const WATERMARK_MAX_LENGTH = 80;

/** Along the diagonal, the text spans at most this share of it. */
export const WATERMARK_MAX_SPAN = 0.7;

/** The text is at most this share of the page's shorter side tall, so a short word isn't huge. */
export const WATERMARK_MAX_HEIGHT = 0.18;

/** Text size the stamp is drawn at, in points; it is scaled to fit each page. */
const STAMP_SIZE = 100;

/** Points of room around the ink, as the app's stamp page has. */
const STAMP_PAD = 2;

function colorOf(color) {
  if (color == null) return WATERMARK_COLORS[DEFAULT_COLOR];
  const named = WATERMARK_COLORS[String(color).toLowerCase()];
  return named ?? color;
}

function alphaOf(opacity) {
  if (typeof opacity === 'number' && opacity >= 0 && opacity <= 1) return opacity;
  const a = WATERMARK_OPACITIES[String(opacity ?? DEFAULT_OPACITY).toLowerCase()];
  if (a === undefined) throw new RangeError(`No watermark opacity ${opacity}`);
  return a;
}

/** How the watermark is drawn (WatermarkText.paint): bold sans-serif at 100 points, in `color`. */
export function watermarkStyle(color = DEFAULT_COLOR) {
  return { family: 'sans-serif', bold: true, size: STAMP_SIZE, color: colorOf(color) };
}

/**
 * Whether a font (bundled, or the browser's) has every character of `text` that needs drawing
 * (WatermarkText.canDraw). Spaces, joiners and variation selectors need none.
 */
export function canDrawWatermark(text) {
  return canDraw(String(text ?? ''), watermarkStyle());
}

/**
 * Centred, along the diagonal from the shown bottom-left corner to the top-right one
 * (WatermarkLayout.place): how to draw a stamp of `stampWidth` × `stampHeight` on the shown page,
 * centred on (centerX, centerY) from its bottom-left corner with y up, turned anticlockwise by
 * `degrees` and scaled by `scale`.
 * @returns {{ centerX: number, centerY: number, degrees: number, scale: number }}
 */
export function placeWatermark(shownWidth, shownHeight, stampWidth, stampHeight) {
  if (!(shownWidth > 0 && shownHeight > 0 && stampWidth > 0 && stampHeight > 0)) throw new RangeError('Sizes must be positive');
  const diagonal = Math.hypot(shownWidth, shownHeight);
  const scale = Math.min(WATERMARK_MAX_SPAN * diagonal / stampWidth, WATERMARK_MAX_HEIGHT * Math.min(shownWidth, shownHeight) / stampHeight);
  const degrees = Math.atan2(shownHeight, shownWidth) * 180 / Math.PI;
  return { centerX: shownWidth / 2, centerY: shownHeight / 2, degrees, scale };
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
// Names (PdfToolsViewModel.defaultName, the engine's FileNames.uniqueNames)

const SUFFIX = { 'page-numbers': '_numbered', watermark: '_watermarked' };
const FALLBACK = { 'page-numbers': 'Numbered', watermark: 'Watermarked' };
/** What the PDFs made together are called, as a ZIP file of them is. */
export const BATCH_NAMES = Object.freeze({ 'page-numbers': 'Numbered_PDFs', watermark: 'Watermarked_PDFs' });

function toolKey(tool) {
  const key = String(tool).toLowerCase().replace(/_/g, '-');
  if (!(key in SUFFIX)) throw new RangeError(`No tool ${tool}`);
  return key;
}

/**
 * The name `tool`'s PDF of `input` gets unless another is typed (no extension):
 * defaultName('page-numbers', { name: 'Report.pdf' }) is 'Report_numbered'.
 * @param {'page-numbers'|'watermark'} tool
 * @param {{ name?: string }} [input]
 */
export function defaultName(tool, input) {
  const base = input?.name ? baseName(input.name) : 'Usugami';
  return withSuffix(base, SUFFIX[toolKey(tool)], 'Usugami');
}

/** The names, as typed, made safe and told apart for PDFs made together ("Report", "report (2)"). */
export function outputNames(tool, names) {
  return uniqueNames(names, FALLBACK[toolKey(tool)]);
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
  const name = sanitizeName(options.fileName ?? defaultName('page-numbers', input), FALLBACK['page-numbers']);
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
  const name = sanitizeName(options.fileName ?? defaultName('watermark', input), FALLBACK.watermark);
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
