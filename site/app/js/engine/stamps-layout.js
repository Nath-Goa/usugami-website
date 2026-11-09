// Add page numbers and Add watermark without the PDF part (no pdf-lib, no text engine): where
// numbers and watermarks go on a page as it is shown (the app's PageStamps.kt), the choices and their
// defaults (Watermark.kt), the pages to number and the names of the PDFs made. The screens need only
// this until a PDF is made; engine/stamps.js re-exports all of it with the engines.
import { parsePageSelection } from './page-selection.js';
import { withSuffix, baseName, uniqueNames } from '../core/names.js';

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
export function positionOf(position) {
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
export const STAMP_PAD = 2;

function colorOf(color) {
  if (color == null) return WATERMARK_COLORS[DEFAULT_COLOR];
  const named = WATERMARK_COLORS[String(color).toLowerCase()];
  return named ?? color;
}

/** 'translucent' | 'semi' | 'opaque' (or an alpha 0..1) as the watermark's alpha. */
export function alphaOf(opacity) {
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

// ---------------------------------------------------------------------------------------------
// Names (PdfToolsViewModel.defaultName, the engine's FileNames.uniqueNames)

const SUFFIX = { 'page-numbers': '_numbered', watermark: '_watermarked' };
/** The name a PDF gets when the one typed ends up empty. */
export const FALLBACK_NAMES = Object.freeze({ 'page-numbers': 'Numbered', watermark: 'Watermarked' });
const FALLBACK = FALLBACK_NAMES;
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
