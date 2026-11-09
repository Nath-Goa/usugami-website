// Where an image goes on its page, how much it is shrunk for the compression level, and where a
// point of it lands: the app's PageLayout.kt, Compression.kt and ImagePlacement, and PdfSyntax.number.

import { transformOf, inverse, pdfMatrix } from './image-transform.js';

const mm = (value) => (value * 72) / 25.4;

/** Paper sizes in PDF points (1/72 inch), portrait. 'fit' makes every page the size of its image. */
export const PAGE_SIZES = {
  fit: { shortSide: 0, longSide: 0, label: 'size_fit' },
  a4: { shortSide: mm(210), longSide: mm(297), label: 'size_a4' },
  letter: { shortSide: 612, longSide: 792, label: 'size_letter' },
  legal: { shortSide: 612, longSide: 1008, label: 'size_legal' },
  a3: { shortSide: mm(297), longSide: mm(420), label: 'size_a3' },
  a5: { shortSide: mm(148), longSide: mm(210), label: 'size_a5' },
};

export const ORIENTATIONS = ['auto', 'portrait', 'landscape'];

/** Margin around the image, in points on a fixed paper size. */
export const MARGINS = {
  none: 0,
  small: 18, // 1/4 inch
  big: 54, // 3/4 inch
};

/** How hard images are compressed: the most pixels per inch kept on the page, and the JPEG quality. */
export const COMPRESSION = {
  less: { dpi: 200, jpegQuality: 85 },
  recommended: { dpi: 150, jpegQuality: 75 },
  extreme: { dpi: 100, jpegQuality: 55 },
};

/** The app's defaults (LayoutSettings, SettingsStore). */
export const DEFAULT_LAYOUT = { pageSize: 'a4', orientation: 'portrait', margin: 'none' };

/** Largest page side Acrobat and most viewers accept (200 inches). */
export const MAX_PAGE_SIDE = 14400;

/** Smallest page side Acrobat accepts. */
export const MIN_PAGE_SIDE = 3;

/** `settings` with every field checked and defaulted: { pageSize, orientation, margin }. */
export function layoutSettings(settings = {}) {
  const pageSize = settings.pageSize ?? DEFAULT_LAYOUT.pageSize;
  const orientation = settings.orientation ?? DEFAULT_LAYOUT.orientation;
  const margin = settings.margin ?? DEFAULT_LAYOUT.margin;
  if (!(pageSize in PAGE_SIZES)) throw new RangeError(`Unknown page size ${pageSize}`);
  if (!ORIENTATIONS.includes(orientation)) throw new RangeError(`Unknown orientation ${orientation}`);
  if (!(margin in MARGINS)) throw new RangeError(`Unknown margin ${margin}`);
  return { pageSize, orientation, margin };
}

/**
 * Lays out one image on its page. `imageWidth` and `imageHeight` are the pixel size of the image
 * as it will appear (after EXIF orientation and the user's rotation).
 * @returns {{ pageWidth: number, pageHeight: number, imageX: number, imageY: number,
 *   imageWidth: number, imageHeight: number, imageTop: number }} points, x and y from the bottom-left
 */
export function computeLayout(imageWidth, imageHeight, settings = {}) {
  if (!(imageWidth > 0 && imageHeight > 0)) throw new RangeError(`Invalid image size ${imageWidth}x${imageHeight}`);
  const s = layoutSettings(settings);
  const g = s.pageSize === 'fit' ? fit(imageWidth, imageHeight, s.margin) : onPaper(imageWidth, imageHeight, s);
  g.imageTop = g.pageHeight - g.imageY - g.imageHeight;
  return g;
}

/**
 * One pixel becomes one point. The margin scales with the image so a "small" border looks the same
 * on a 500 px image as on a 4000 px one (relative to an A4 page's short side). An image more than
 * 4800 times longer than wide gets the longest page there can be, as wide as the smallest, with the
 * image centred across it.
 */
function fit(w, h, margin) {
  const m = (MARGINS[margin] / PAGE_SIZES.a4.shortSide) * Math.min(w, h);
  const pageW = w + 2 * m;
  const pageH = h + 2 * m;
  let scale = Math.min(1, MAX_PAGE_SIDE / Math.max(pageW, pageH));
  if (Math.min(pageW, pageH) * scale < MIN_PAGE_SIDE) {
    scale = Math.min(MIN_PAGE_SIDE / Math.min(pageW, pageH), MAX_PAGE_SIDE / Math.max(pageW, pageH));
  }
  const width = Math.max(pageW * scale, MIN_PAGE_SIDE);
  const height = Math.max(pageH * scale, MIN_PAGE_SIDE);
  return {
    pageWidth: width,
    pageHeight: height,
    imageX: m * scale + (width - pageW * scale) / 2,
    imageY: m * scale + (height - pageH * scale) / 2,
    imageWidth: w * scale,
    imageHeight: h * scale,
  };
}

/** Fits the image inside the margins of a fixed paper size, keeping its aspect ratio, centred. */
function onPaper(w, h, settings) {
  const landscape = settings.orientation === 'auto' ? w > h : settings.orientation === 'landscape';
  const size = PAGE_SIZES[settings.pageSize];
  const pageW = landscape ? size.longSide : size.shortSide;
  const pageH = landscape ? size.shortSide : size.longSide;
  const m = MARGINS[settings.margin];
  const scale = Math.min((pageW - 2 * m) / w, (pageH - 2 * m) / h);
  const drawnW = w * scale;
  const drawnH = h * scale;
  return { pageWidth: pageW, pageHeight: pageH, imageX: (pageW - drawnW) / 2, imageY: (pageH - drawnH) / 2, imageWidth: drawnW, imageHeight: drawnH };
}

/**
 * The factor (at most 1, never enlarging) to shrink an image by so it has no more than the
 * compression level's resolution on the page. `shownWidth`/`shownHeight` are its pixel size as it
 * appears on the page.
 */
export function scaleFor(shownWidth, shownHeight, settings, compression) {
  const level = COMPRESSION[compression];
  if (!level) throw new RangeError(`Unknown compression ${compression}`);
  const s = layoutSettings(settings);
  if (s.pageSize === 'fit') {
    // Fit pages take their size from the pixels, so judge the image as if it filled A4: each side
    // keeps at least as many pixels as A4's side would at this resolution. Capping only the long
    // side would crush a long screenshot to a sliver no one could read.
    const longCap = ((PAGE_SIZES.a4.longSide / 72) * level.dpi) / Math.max(shownWidth, shownHeight);
    const shortCap = ((PAGE_SIZES.a4.shortSide / 72) * level.dpi) / Math.min(shownWidth, shownHeight);
    return Math.min(1, Math.max(longCap, shortCap));
  }
  const placedWidthInches = computeLayout(shownWidth, shownHeight, s).imageWidth / 72;
  return Math.min(1, (placedWidthInches * level.dpi) / shownWidth);
}

/** `width` x `height` scaled by `scale`, each side at least one pixel (Kotlin's roundToInt). */
export function scaledSize(width, height, scale) {
  return [Math.max(1, roundToInt(width * scale)), Math.max(1, roundToInt(height * scale))];
}

/**
 * How much smaller `now` bytes are than `original`, in whole percent; null unless that is at least
 * 1%, so a PDF is never said to be "0% smaller".
 */
export function savedPercent(original, now) {
  if (original <= 0 || now >= original) return null;
  const percent = Math.floor(((original - now) * 100) / original);
  return percent >= 1 ? percent : null;
}

/** Kotlin's roundToInt: halves round up (towards positive infinity). */
function roundToInt(v) {
  return Math.floor(v + 0.5);
}

// ---- Where an image goes ----

// The eight turns and flips of an image are image-transform.js's (ImageTransform.kt).
export { IDENTITY, swapsAxes, fromExif, pdfMatrix } from './image-transform.js';

/** EXIF orientation first (1 to 8, default upright), then the user's clockwise rotation. */
export function imageTransform(exifOrientation = 1, rotationDegrees = 0) {
  return transformOf(exifOrientation, rotationDegrees);
}

/**
 * Where an image went on its page: the page and the rectangle the image fills (`geometry`), drawn
 * turned by `transform` (EXIF orientation, then the user's rotation).
 */
export function imagePlacement(geometry, t) {
  const matrix = pdfMatrix(t, geometry.imageX, geometry.imageY, geometry.imageWidth, geometry.imageHeight);
  const stored = inverse(t);
  return {
    geometry,
    transform: t,
    matrix,
    /**
     * Where the page shows the point (s, t) of the image as it appears there (upright and turned
     * as the user chose; s across and t down, each 0 to 1), in points from the page's bottom-left
     * corner. The point goes back to the image as stored and through the matrix, so it lands
     * exactly where the PDF draws it.
     */
    toPage(s, tt) {
      const u = stored.a * s + stored.b * tt + stored.c;
      // An image XObject fills the unit square with its first row at the top.
      const v = 1 - (stored.d * s + stored.e * tt + stored.f);
      return [matrix[0] * u + matrix[2] * v + matrix[4], matrix[1] * u + matrix[3] * v + matrix[5]];
    },
  };
}

/**
 * Formats a real number the way PDF expects it: '.' as decimal separator, no exponent, at most four
 * decimals (PdfSyntax.number).
 */
export function pdfNumber(value) {
  if (!Number.isFinite(value)) throw new RangeError(`PDF numbers must be finite: ${value}`);
  const scaled = Math.round(value * 10000);
  if (scaled === 0) return '0';
  const magnitude = Math.abs(scaled);
  let s = scaled < 0 ? '-' : '';
  s += Math.floor(magnitude / 10000);
  const fraction = magnitude % 10000;
  if (fraction !== 0) s += '.' + String(fraction).padStart(4, '0').replace(/0+$/, '');
  return s;
}

/** `value` rounded to the four decimals a PDF number is written with. */
export function pdfRound(value) {
  return Number(pdfNumber(value));
}
