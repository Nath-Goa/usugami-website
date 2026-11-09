// Canvas helpers shared by the page looks, the encoders and the PDF builder: making canvases (an
// OffscreenCanvas where the browser has one with a 2D context), reading pixels, and pausing long work.
import { UserError, checkCancelled } from '../../core/errors.js';

let offscreen2d = null;

/** Whether OffscreenCanvas can draw in 2D here (Safari before 16.4 can't). */
function hasOffscreen2d() {
  if (offscreen2d == null) {
    try {
      offscreen2d = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d');
    } catch {
      offscreen2d = false;
    }
  }
  return offscreen2d;
}

/**
 * A new canvas `width` x `height`: an HTMLCanvasElement when `dom` is true (to show in the page) or
 * there is no OffscreenCanvas, otherwise an OffscreenCanvas.
 */
export function newCanvas(width, height, { dom = false } = {}) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if ((dom || !hasOffscreen2d()) && typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (hasOffscreen2d()) return new OffscreenCanvas(w, h);
  throw new UserError('msg_out_of_memory');
}

/**
 * The canvas's 2D context. A canvas too large for the browser has none: that is reported as
 * UserError('msg_out_of_memory'), which the builder answers by halving the picture.
 */
export function context2d(canvas, { willRead = false } = {}) {
  let ctx = null;
  try {
    ctx = canvas.getContext('2d', willRead ? { willReadFrequently: true } : undefined);
  } catch {
    ctx = null;
  }
  if (!ctx) throw new UserError('msg_out_of_memory');
  return ctx;
}

/** The pixel size of an ImageData, canvas, ImageBitmap, <img>, VideoFrame or { width, height } source. */
export function sourceSize(source) {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
    return { width: source.displayWidth, height: source.displayHeight };
  }
  return { width: source.width, height: source.height };
}

/** Whether `source` is pixels in an ImageData (or an object shaped like one). */
export function isImageData(source) {
  return (typeof ImageData !== 'undefined' && source instanceof ImageData) ||
    (source && typeof source === 'object' && source.data instanceof Uint8ClampedArray && source.width > 0 && source.height > 0);
}

/** `source`'s pixels as ImageData (RGBA, not premultiplied). ImageData is returned as it is. */
export function toImageData(source) {
  if (isImageData(source)) return source;
  const { width, height } = sourceSize(source);
  if (!(width > 0 && height > 0)) throw new RangeError('The picture has no pixels');
  const canvas = newCanvas(width, height);
  const ctx = context2d(canvas, { willRead: true });
  ctx.drawImage(source, 0, 0);
  try {
    return ctx.getImageData(0, 0, width, height);
  } catch (e) {
    if (e instanceof RangeError) throw new UserError('msg_out_of_memory');
    throw e;
  }
}

/** A new ImageData `width` x `height` (made without a canvas where the constructor exists). */
export function newImageData(width, height) {
  try {
    if (typeof ImageData !== 'undefined') return new ImageData(width, height);
  } catch (e) {
    if (e instanceof RangeError) throw new UserError('msg_out_of_memory');
    throw e;
  }
  return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' };
}

/** `imageData` on a canvas of its own (an HTMLCanvasElement when `dom`). */
export function imageDataToCanvas(imageData, { dom = false } = {}) {
  const canvas = newCanvas(imageData.width, imageData.height, { dom });
  const ctx = context2d(canvas);
  ctx.putImageData(imageData instanceof ImageData ? imageData : new ImageData(imageData.data, imageData.width, imageData.height), 0, 0);
  return canvas;
}

/** The canvas encoded as `type` (e.g. 'image/jpeg') at `quality` (0 to 1). */
export async function canvasToBlob(canvas, type, quality) {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new UserError('msg_out_of_memory'))), type, quality);
  });
}

/**
 * Lets the browser paint and handle input. scheduler.yield where there is one; otherwise a timer,
 * as Firefox runs message-channel tasks ahead of everything else, painting included.
 */
export function pause() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs a generator of long pixel work (it yields every few dozen rows) to its end at once, and
 * returns what it returns.
 */
export function runSync(gen) {
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}

/**
 * Runs a generator of long pixel work, pausing for the browser every `slice` milliseconds and
 * stopping with CancelledError when `signal` is aborted.
 */
export async function runAsync(gen, { signal, slice = 24 } = {}) {
  let started = performance.now();
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
    if (performance.now() - started > slice) {
      checkCancelled(signal);
      await pause();
      checkCancelled(signal);
      started = performance.now();
    }
  }
}
