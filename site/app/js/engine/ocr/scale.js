// The size pictures are read at (OcrScale in the app's core/TextDetection.kt).

/** The most pixels on a side a picture is read with. */
export const MAX_SIDE = 8192;

/**
 * The scale for reading a `width` x `height` picture: to `longSide` pixels on its long side,
 * enlarged at most `maxEnlarge` times. A larger picture is only shrunk as far as it needs to have
 * no more pixels than a 4:3 one of that size: shrunk to its long side, a long screenshot's text
 * would be a few pixels high. Never more than MAX_SIDE pixels on a side.
 * @param {number} width
 * @param {number} height
 * @param {number} longSide
 * @param {number} maxEnlarge at least 1
 * @returns {number}
 * @example ocrScale(4000, 3000, 3000, 2.5) // 0.75
 */
export function ocrScale(width, height, longSide, maxEnlarge) {
  if (!(width > 0 && height > 0 && longSide > 0 && maxEnlarge >= 1)) throw new RangeError('Bad size');
  const long = Math.max(width, height);
  const bySide = longSide / long;
  const scale = bySide >= 1
    ? Math.min(bySide, maxEnlarge)
    : Math.min(1, Math.max(bySide, Math.sqrt((longSide * (longSide * 0.75)) / (width * height))));
  return Math.min(scale, MAX_SIDE / long);
}
