// The picture text recognition reads: the page image as the page shows it, in colour, on white, at
// the size the app reads it (PdfOcr.shownImage), as a PPM file Tesseract reads without decoding a
// PNG or JPEG first.
import { UserError, checkCancelled } from '../../core/errors.js';
import { ocrScale } from './scale.js';

/**
 * The long side, in pixels, images are read at (PdfOcr.READ_SIDE): 27 MB for a 4:3 photo, and no
 * more for a longer picture.
 */
export const READ_SIDE = 3000;

/** Smaller images are enlarged at most this many times (PdfOcr.MAX_ENLARGE). */
export const MAX_ENLARGE = 2.5;

/** Below this, a shortage of memory is reported rather than read even smaller (PdfOcr.MIN_READ_SIDE). */
export const MIN_READ_SIDE = 750;

/** Narrower pictures are read on white, made larger to the right and below (as for ML Kit in the app). */
export const MIN_SIDE = 32;

/** Rows copied out of the canvas at a time, so a large page needs no second full-size copy. */
const BAND = 256;

let offscreen = null;

/** Lets the browser paint and handle input. */
function pause() {
  const s = globalThis.scheduler;
  if (s && typeof s.yield === 'function') return s.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canUseOffscreen() {
  if (offscreen == null) {
    try {
      offscreen = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d');
    } catch {
      offscreen = false;
    }
  }
  return offscreen;
}

function newCanvas(width, height) {
  if (canUseOffscreen()) return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') throw new UserError('ocr_failed');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Frees a canvas's pixels now (Safari counts canvas memory until the canvas is collected). */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // An OffscreenCanvas handed to a worker can't be resized; it is freed with it.
  }
}

/**
 * Something drawImage can draw, with its size: the image as given, or a Blob decoded (turned as
 * its EXIF orientation says). `close` frees what was decoded here.
 */
export async function drawable(image) {
  if (image && typeof Blob !== 'undefined' && image instanceof Blob) {
    const bitmap = await decodeBlob(image);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  }
  if (typeof ImageData !== 'undefined' && image instanceof ImageData) {
    const bitmap = await createImageBitmap(image).catch(() => null);
    if (!bitmap) throw new UserError('ocr_failed');
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  }
  const width = image?.naturalWidth || image?.videoWidth || image?.width || 0;
  const height = image?.naturalHeight || image?.videoHeight || image?.height || 0;
  if (!(width > 0 && height > 0)) throw new UserError('ocr_failed');
  return { source: image, width, height, close() {} };
}

async function decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') {
    for (const options of [{ imageOrientation: 'from-image' }, undefined]) {
      try {
        const bitmap = await createImageBitmap(blob, options);
        if (bitmap.width > 0 && bitmap.height > 0) return bitmap;
      } catch {
        // Next way.
      }
    }
  }
  // Safari before 15 decodes some types only in an <img>.
  if (typeof Image !== 'undefined' && typeof URL?.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        const bitmap = await createImageBitmap(img).catch(() => null);
        if (bitmap) return bitmap;
      }
    } catch {
      // Not an image this browser can show.
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  throw new UserError('ocr_failed');
}

/**
 * The picture to read for `image`: drawn on white at the size OcrScale gives (READ_SIDE on its long
 * side, enlarged at most MAX_ENLARGE times), at least MIN_SIDE pixels on each side. If the browser
 * can't make a canvas that large, it is read smaller, down to MIN_READ_SIDE.
 * @returns {Promise<{ canvas, width: number, height: number, scale: number,
 *   sourceWidth: number, sourceHeight: number, release(): void }>} width and height are the
 *   canvas's (with any padding); scale is its pixels per pixel of `image`.
 */
export async function preparePicture(image, { signal, readSide = READ_SIDE, maxEnlarge = MAX_ENLARGE } = {}) {
  checkCancelled(signal);
  const src = await drawable(image);
  try {
    checkCancelled(signal);
    let scale = ocrScale(src.width, src.height, readSide, maxEnlarge);
    for (;;) {
      const width = Math.max(1, Math.round(src.width * scale));
      const height = Math.max(1, Math.round(src.height * scale));
      const canvas = drawOnWhite(src.source, width, height);
      if (canvas) {
        return {
          canvas,
          width: canvas.width,
          height: canvas.height,
          scale,
          sourceWidth: src.width,
          sourceHeight: src.height,
          release: () => releaseCanvas(canvas),
        };
      }
      if (Math.max(width, height) <= MIN_READ_SIDE) throw new UserError('ocr_failed');
      scale /= 2;
    }
  } finally {
    src.close();
  }
}

/** `source` drawn `width` x `height` on white, padded to MIN_SIDE; null if the browser can't. */
function drawOnWhite(source, width, height) {
  let canvas = null;
  try {
    canvas = newCanvas(Math.max(MIN_SIDE, width), Math.max(MIN_SIDE, height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    // A canvas over the browser's limit can draw nothing without saying so: reading a pixel fails then.
    ctx.getImageData(0, 0, 1, 1);
    return canvas;
  } catch {
    releaseCanvas(canvas);
    return null;
  }
}

/** A copy of `canvas` at most `longSide` pixels on its long side (for trying turns quickly). */
export function reducedCopy(canvas, longSide) {
  const factor = Math.min(1, longSide / Math.max(canvas.width, canvas.height));
  if (factor >= 1) return { canvas, factor: 1, release() {} };
  const copy = drawOnWhite(canvas, Math.max(1, Math.round(canvas.width * factor)), Math.max(1, Math.round(canvas.height * factor)));
  if (!copy) return null;
  return { canvas: copy, factor: copy.width / canvas.width, release: () => releaseCanvas(copy) };
}

/**
 * The canvas as a binary PPM (P6), and its pixels within it (red, green, blue bytes, row by row),
 * which toPpm can turn.
 * @returns {{ ppm: Uint8Array, rgb: Uint8Array, width: number, height: number }}
 */
export async function canvasPpm(canvas) {
  const { width, height } = canvas;
  const header = ppmHeader(width, height);
  const ppm = new Uint8Array(header.length + width * height * 3);
  ppm.set(header);
  const rgb = ppm.subarray(header.length);
  await fillRgb(canvas, rgb);
  return { ppm, rgb, width, height };
}

function ppmHeader(width, height) {
  return new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
}

/** Copies the canvas's pixels into `rgb` as red, green, blue bytes, row by row. */
async function fillRgb(canvas, rgb) {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let j = 0;
  let since = Date.now();
  for (let y = 0; y < height; y += BAND) {
    // A large page takes a moment: the screen keeps answering meanwhile.
    if (Date.now() - since > 30) {
      await pause();
      since = Date.now();
    }
    const rows = Math.min(BAND, height - y);
    const data = ctx.getImageData(0, y, width, rows).data;
    // Drawn on white, so every pixel is opaque already.
    for (let i = 0; i < data.length; i += 4) {
      rgb[j++] = data[i];
      rgb[j++] = data[i + 1];
      rgb[j++] = data[i + 2];
    }
  }
}

/**
 * A binary PPM (P6) of `rgb` (`width` x `height`), turned `quarterTurns` times clockwise.
 * @returns {{ ppm: Uint8Array, width: number, height: number }} the size as turned
 */
export function toPpm(rgb, width, height, quarterTurns = 0) {
  const k = ((quarterTurns % 4) + 4) % 4;
  const w = k % 2 ? height : width;
  const h = k % 2 ? width : height;
  const header = ppmHeader(w, h);
  const ppm = new Uint8Array(header.length + width * height * 3);
  ppm.set(header);
  const base = header.length;
  if (k === 0) {
    ppm.set(rgb, base);
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let tx;
        let ty;
        if (k === 1) {
          tx = height - 1 - y;
          ty = x;
        } else if (k === 2) {
          tx = width - 1 - x;
          ty = height - 1 - y;
        } else {
          tx = y;
          ty = width - 1 - x;
        }
        const from = (y * width + x) * 3;
        const to = base + (ty * w + tx) * 3;
        ppm[to] = rgb[from];
        ppm[to + 1] = rgb[from + 1];
        ppm[to + 2] = rgb[from + 2];
      }
    }
  }
  return { ppm, width: w, height: h };
}
