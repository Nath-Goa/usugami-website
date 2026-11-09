// Canvas helpers shared by image import and cropping: canvases that work on the page and in
// workers, encoding them, reading their pixels, and giving their memory back (Safari on iPhones
// limits the memory all canvases together may use).

/** A canvas `width` × `height`: an element on the page, an OffscreenCanvas in a worker. */
export function makeCanvas(width, height) {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return new OffscreenCanvas(width, height);
}

/** Gives the canvas's memory back now, rather than when it is collected. */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * A 2D context for `canvas`; throws when the browser can't make one this large (Safari on iPhones
 * refuses canvases over about 16.7 million pixels).
 */
export function context2d(canvas, options) {
  const ctx = canvas.getContext('2d', options);
  if (!ctx) throw new RangeError('No canvas of ' + canvas.width + ' × ' + canvas.height);
  return ctx;
}

/**
 * `canvas` encoded as 'jpeg' (at `quality`, 0..1) or 'png', as bytes. Throws when the browser
 * can't (out of memory, or a canvas too large: it then gives nothing, or an empty picture).
 */
export async function encodeCanvas(canvas, format, quality) {
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = typeof canvas.convertToBlob === 'function'
    ? await canvas.convertToBlob({ type, quality })
    : await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob || blob.size === 0 || (blob.type && blob.type !== type)) throw new Error('The picture could not be encoded');
  return new Uint8Array(await blob.arrayBuffer());
}

/** The RGBA pixels of `source` (an ImageBitmap, canvas or image) as ImageData. */
export function pixelsOf(source, width = source.width, height = source.height) {
  const canvas = makeCanvas(width, height);
  try {
    const ctx = context2d(canvas, { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    releaseCanvas(canvas);
  }
}

/** Lets the browser paint and handle input during long work. */
export function yieldNow() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
