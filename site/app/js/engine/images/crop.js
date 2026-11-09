// Cropping pages out of photos: finds the page on one, gives the corners the crop screen starts
// from, and straightens the page inside the corners into a picture of its own. A port of
// PageCropper.kt (with PageLooks.straightened), on the StoredImages of decode.js, which are
// upright already.
//
// The corner and size rules (CropQuad, PageCrop) are in crop-quad.js and exported here too.
import {
  outputSize, storedCorners, isUsable, isWhole, inset, transformed, ordered, MAX_SIDE, INSET,
} from './crop-quad.js';
import { findPage, CONFIDENT } from './outline.js';
import { rotation, inverse, IDENTITY } from './image-transform.js';
import { loadImage, IMAGE_MIME } from './decode.js';
import { readImageInfo } from './image-meta.js';
import { straightenOnto } from './crop-warp.js';
import { makeCanvas, releaseCanvas, context2d, encodeCanvas, pixelsOf } from './image-canvas.js';
import { UserError, CancelledError, checkCancelled } from '../../core/errors.js';

export * from './crop-quad.js';
export { CONFIDENT } from './outline.js';
export { setGpuWarp, warpsOnGpu } from './crop-warp.js';

/** The search for the page looks at a copy about this many pixels on its long side. */
export const SEARCH_SIDE = 800;

/** A cropped JPEG page is saved at this quality (PageCropper.JPEG_QUALITY). */
export const JPEG_QUALITY = 0.92;

// ---- Finding the page ----

/**
 * The page on `image` (a StoredImage), as the automatic search finds it, or null when nothing like
 * one stands out (PageCropper.findPage). The search sees the photo's colours, so a page that differs
 * from the desk only in colour stands out. It runs in a worker when it can. As in the app, a search
 * that fails gives null (the corners then start inset); an image that can't be decoded rejects with
 * UserError('msg_image_unreadable', name).
 * @param {{ bytes: Uint8Array, format?: string, type?: string, width: number, height: number, name?: string }} image
 * @param {{ signal?: AbortSignal }} [hooks]
 * @returns {Promise<import('./outline.js').PageOutline|null>}
 */
export async function findPageOnImage(image, { signal } = {}) {
  const bitmap = await loadImage(image, { maxSide: SEARCH_SIDE, signal });
  let pixels;
  try {
    pixels = pixelsOf(bitmap);
  } catch {
    return null;
  } finally {
    bitmap.close?.();
  }
  checkCancelled(signal);
  try {
    return await detect(pixels.data, pixels.width, pixels.height, signal);
  } catch (e) {
    if (e instanceof CancelledError || signal?.aborted) throw new CancelledError();
    return null;
  }
}

/**
 * Where the crop screen's corners start for an image, from what findPageOnImage() found
 * (MainViewModel.openCrop): on the page when it was found for sure, else PageCrop.INSET in from
 * each edge. `foundPage` says which, for the screen's hint (crop_found or crop_not_found). The
 * corners are also what Reset goes back to.
 * @param {import('./outline.js').PageOutline|null} outline
 * @returns {{ corners: {x: number, y: number}[], foundPage: boolean }}
 */
export function startingCorners(outline) {
  const found = outline && outline.confidence >= CONFIDENT ? outline.quad : null;
  return { corners: found ?? inset(INSET), foundPage: found != null };
}

/**
 * `quad` (corners on the image upright) as the crop screen shows them on the image turned `turn`
 * degrees clockwise (MainViewModel.CropSession.shown).
 */
export function shownQuad(quad, turn) {
  return ordered(transformed(quad, rotation(turn)));
}

/**
 * `quad`, as the crop screen shows the image turned `turn` degrees clockwise, on the image upright
 * (MainViewModel.CropSession.upright).
 */
export function uprightQuad(quad, turn) {
  return ordered(transformed(quad, inverse(rotation(turn))));
}

let detector = null;
let detectorFailed = false;
let detectorIdle = 0;
let nextJob = 1;
const jobs = new Map();

/** The page on RGBA pixels, in the worker when there is one, else here. */
function detect(rgba, width, height, signal) {
  const worker = detectionWorker();
  if (!worker) return Promise.resolve(findPage(rgba, width, height));
  return new Promise((resolve, reject) => {
    const id = nextJob++;
    jobs.set(id, { resolve, reject, rgba, width, height });
    signal?.addEventListener('abort', () => {
      if (jobs.delete(id)) reject(new CancelledError());
    }, { once: true });
    // A copy goes, so the pixels stay here for the search without a worker if it fails to start.
    const copy = rgba.slice();
    worker.postMessage({ id, rgba: copy, width, height }, [copy.buffer]);
  });
}

function detectionWorker() {
  if (detectorFailed || typeof Worker === 'undefined') return null;
  clearTimeout(detectorIdle);
  if (detector) return detector;
  try {
    detector = new Worker(new URL('./outline-worker.js', import.meta.url), { type: 'module' });
  } catch {
    detectorFailed = true;
    return null;
  }
  detector.onmessage = (e) => {
    const job = jobs.get(e.data.id);
    if (!job) return;
    jobs.delete(e.data.id);
    if (e.data.error) job.reject(new Error(e.data.error));
    else job.resolve(e.data.outline);
    idleLater();
  };
  detector.onerror = (e) => {
    // Module workers unsupported here: the search runs on the page from now on.
    e.preventDefault?.();
    detectorFailed = true;
    detector?.terminate();
    detector = null;
    const waiting = [...jobs.values()];
    jobs.clear();
    for (const job of waiting) {
      try {
        job.resolve(findPage(job.rgba, job.width, job.height));
      } catch (error) {
        job.reject(error);
      }
    }
  };
  return detector;
}

function idleLater() {
  clearTimeout(detectorIdle);
  if (jobs.size) return;
  detectorIdle = setTimeout(() => {
    if (jobs.size || !detector) return;
    detector.terminate();
    detector = null;
  }, 30_000);
}

// ---- Cropping ----

/** One crop at a time, as the app's crop thread: they share the graphics context and memory. */
let queue = Promise.resolve();

/**
 * The page inside `quad` (corners on `image` as it shows upright) straightened onto a rectangle the
 * page's shape (outputSize(): at most MAX_SIDE pixels on its long side), in `image`'s format (a JPEG
 * at JPEG_QUALITY, a PNG keeping its transparency; anything else on white), with no metadata
 * (PageCropper.crop). Only the part of the photo inside the corners is decoded, no larger than the
 * page needs; if memory runs short, the page is made smaller.
 *
 * Throws UserError('crop_not_a_page') when the corners don't make a page (check isUsable() first,
 * as the crop screen does; the whole image needs no cropping), and UserError('crop_failed') when it
 * can't be cropped.
 * @param {{ bytes: Uint8Array, format?: 'jpeg'|'png', type?: string, width: number, height: number }} image
 * @param {{x: number, y: number}[]} quad
 * @param {{ signal?: AbortSignal, maxSide?: number }} [hooks]
 * @returns {Promise<{ bytes: Uint8Array, type: 'image/jpeg'|'image/png', format: 'jpeg'|'png', width: number, height: number }>}
 */
export function cropImage(image, quad, { signal, maxSide = MAX_SIDE } = {}) {
  const run = queue.then(() => cropAtSizes(image, quad, maxSide, signal));
  queue = run.catch(() => {});
  return run;
}

async function cropAtSizes(image, quad, maxSide, signal) {
  checkCancelled(signal);
  if (!isWhole(quad) && !isUsable(quad, image.width, image.height)) throw new UserError('crop_not_a_page');
  let side = maxSide;
  for (;;) {
    try {
      return await cropAt(image, quad, side, signal);
    } catch (e) {
      if (e instanceof CancelledError || signal?.aborted) throw new CancelledError();
      if (e instanceof UserError) throw e;
      // Out of memory or canvas: smaller, down to a few hundred pixels, as the app does.
      if (!(e instanceof RangeError) || side < 500) throw new UserError('crop_failed');
      side = Math.floor(side / 2);
    }
  }
}

async function cropAt(image, quad, maxSide, signal) {
  const format = image.format ?? (image.type === 'image/png' ? 'png' : 'jpeg');
  const [outWidth, outHeight] = outputSize(quad, image.width, image.height, maxSide);
  const [fullWidth, fullHeight] = outputSize(quad, image.width, image.height, Infinity);
  // The stored image's pixels around the page, read at a power-of-two reduction that keeps at least
  // the pixels the page needs.
  const corners = storedCorners(quad, IDENTITY, image.width, image.height);
  const xs = [corners[0], corners[2], corners[4], corners[6]];
  const ys = [corners[1], corners[3], corners[5], corners[7]];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const left = clamp(Math.floor(Math.min(...xs)), 0, image.width - 1);
  const top = clamp(Math.floor(Math.min(...ys)), 0, image.height - 1);
  const right = clamp(Math.ceil(Math.max(...xs)), 1, image.width);
  const bottom = clamp(Math.ceil(Math.max(...ys)), 1, image.height);
  if (right - left < 1 || bottom - top < 1) throw new UserError('crop_failed');
  let sample = 1;
  const reduction = Math.max(fullWidth / outWidth, fullHeight / outHeight);
  while (sample * 2 <= reduction) sample *= 2;
  const region = await decodeRegion(image, format, left, top, right - left, bottom - top, sample, signal);
  try {
    checkCancelled(signal);
    const scaleX = region.width / (right - left);
    const scaleY = region.height / (bottom - top);
    const source = corners.map((v, i) => (i % 2 === 0 ? (v - left) * scaleX : (v - top) * scaleY));
    // A PNG keeps its transparency; anything else is on white, as in the PDF.
    const transparent = format === 'png' && readImageInfo(image.bytes, 'png').alpha;
    let page;
    try {
      page = await straightenOnto(region, source, outWidth, outHeight, { transparent, signal });
    } catch (e) {
      if (e instanceof RangeError || e instanceof CancelledError) throw e;
      throw new UserError('crop_failed');
    }
    try {
      checkCancelled(signal);
      let bytes;
      try {
        bytes = await encodeCanvas(page, format, format === 'jpeg' ? JPEG_QUALITY : undefined);
      } catch (e) {
        throw new RangeError(e.message);
      }
      return { bytes, type: IMAGE_MIME[format], format, width: outWidth, height: outHeight };
    } finally {
      releaseCanvas(page);
    }
  } finally {
    region.close?.();
  }
}

/**
 * The part (`left`, `top`, `width` × `height`) of `image` decoded, reduced `sample` times: an
 * ImageBitmap. The whole image is decoded where the browser can't decode a part of it.
 */
async function decodeRegion(image, format, left, top, width, height, sample, signal) {
  const blob = new Blob([image.bytes], { type: IMAGE_MIME[format] });
  const size = sample > 1
    ? { resizeWidth: Math.max(1, Math.round(width / sample)), resizeHeight: Math.max(1, Math.round(height / sample)), resizeQuality: 'high' }
    : {};
  try {
    return await createImageBitmap(blob, left, top, width, height, size);
  } catch {
    checkCancelled(signal);
  }
  let whole;
  try {
    whole = await createImageBitmap(blob);
  } catch {
    throw new UserError('crop_failed');
  }
  try {
    const w = size.resizeWidth ?? width;
    const h = size.resizeHeight ?? height;
    const canvas = makeCanvas(w, h);
    try {
      const ctx = context2d(canvas);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(whole, left, top, width, height, 0, 0, w, h);
      return await createImageBitmap(canvas);
    } catch (e) {
      throw new RangeError(e.message);
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    whole.close?.();
  }
}

// ---- Straightening a preview ----

/**
 * The page inside `quad` (corners on `source`, in a page's order) straightened onto a rectangle the
 * page's shape, at most `maxSide` pixels on its long side, on white, as cropImage() makes it
 * (PageLooks.straightened): for showing a page before it is cropped, on Filters. Null when the
 * corners can't be mapped onto a rectangle.
 * @param {ImageBitmap|HTMLCanvasElement|OffscreenCanvas} source
 * @param {{x: number, y: number}[]} quad
 * @param {number} maxSide
 * @returns {Promise<HTMLCanvasElement|OffscreenCanvas|null>}
 */
export async function straighten(source, quad, maxSide, { signal } = {}) {
  const [width, height] = outputSize(quad, source.width, source.height, maxSide);
  const corners = [];
  for (const p of quad) corners.push(p.x * source.width, p.y * source.height);
  try {
    return await straightenOnto(source, corners, width, height, { transparent: false, signal });
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return null;
  }
}
