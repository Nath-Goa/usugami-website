// Images added to Images to PDF and Scan document: picked, taken with the camera, shared, dropped
// or pasted. A port of the import half of ImageStore.kt and ImageOrientation.kt.
//
// Each image becomes a StoredImage: a JPEG or PNG copy, upright, without hidden metadata, which the
// rest of the app reads. A JPEG or PNG already upright is kept as it is, less its metadata
// (location, camera details, comments, and the video part of a motion photo after its end); any
// other (a turned photo, HEIC, AVIF, WebP, BMP, GIF, a very large photo) is decoded and stored
// again: a photo as a JPEG, and a picture with transparency or one kept without loss (a PNG, a
// lossless WebP, a BMP, the first frame of a GIF) as a PNG. Its EXIF orientation is applied, so
// the copy is upright, and storing it again leaves all its metadata behind.
import { imageFileType, isLossyOpaqueWebp, IMAGE_HEADER_BYTES, WEBP_HEADER_BYTES, IMAGE_MIME } from './image-type.js';
import { readImageInfo, withoutExifOrientation, strippedJpeg, strippedPng } from './image-meta.js';
import { fromExif, swapsAxes, canvasMatrix, rotation as turn, floorMod } from './image-transform.js';
import { decodeHeif } from './heif-decode.js';
import { makeCanvas, releaseCanvas, context2d, encodeCanvas } from './image-canvas.js';
import { UserError, CancelledError, checkCancelled } from '../../core/errors.js';

export { imageFileType, isLossyOpaqueWebp, IMAGE_HEADER_BYTES, WEBP_HEADER_BYTES, IMAGE_MIME } from './image-type.js';

/**
 * At most this many pixels are kept of an image stored again: a 24-megapixel photo whole, a
 * 50-megapixel one at half its size (ImageStore.MAX_CONVERTED_PIXELS).
 */
export const MAX_PIXELS = 25_000_000;

/** How many times smaller than planned an image is decoded, at most, while memory runs out. */
const MAX_SHRINK = 32;

/** High, as the PDF is made from this copy and compresses it again. */
export const CONVERTED_JPEG_QUALITY = 0.95;

/**
 * Images claiming more pixels than this aren't decoded: more than any phone's photo (200
 * megapixels), and what a crafted file claims to make a browser run out of memory.
 */
const MAX_DECODE_PIXELS = 220_000_000;

/** The image types the file picker offers (ImageStore.pickableTypes), as an accept attribute. */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/bmp,image/x-ms-bmp,image/gif,image/heic,image/heif,image/avif,.jpg,.jpeg,.png,.webp,.bmp,.gif,.heic,.heif,.avif';

/**
 * @typedef {object} StoredImage
 * @property {string} name       its name: the file's, or Photo_ and when it was taken (photoName())
 * @property {Uint8Array} bytes  the stored copy: a JPEG or PNG, upright, without hidden metadata
 * @property {'image/jpeg'|'image/png'} type
 * @property {'jpeg'|'png'} format
 * @property {number} width      its size in pixels, upright
 * @property {number} height
 * @property {'jpeg'|'png'|'webp'|'bmp'|'gif'|'heif'|'avif'} sourceType  the kind of file it came from
 * @property {Date|null} taken   when the photo was taken (EXIF DateTimeOriginal), if it says
 */

/**
 * @typedef {{ status: 'added', image: StoredImage } | { status: 'unsupported', sourceType: string|null }
 *   | { status: 'failed', sourceType: string|null }} ImportResult
 * As the app's ImageStore.ImportResult: Added, Unsupported (none of the image types Usugami takes,
 * or AVIF in a browser that can't decode it) or Failed (damaged, or too large to decode).
 */

/** Thrown inside when the browser can't decode a type of image at all. */
class UnsupportedImage extends Error {}

/**
 * Takes in one image the user added: checks it is one Usugami takes, by its first bytes, and makes
 * its StoredImage. Never rejects for a bad file: the result says what happened.
 * @param {{ name: string, bytes: Uint8Array, lastModified?: number }} file  a FileItem
 * @param {{ signal?: AbortSignal }} [hooks]
 * @returns {Promise<ImportResult>}
 */
export async function importImage(file, { signal } = {}) {
  checkCancelled(signal);
  const bytes = file.bytes;
  const sourceType = imageFileType(bytes.subarray(0, IMAGE_HEADER_BYTES));
  if (!sourceType) return { status: 'unsupported', sourceType: null };
  try {
    const image = await storeImage(bytes, sourceType, signal);
    image.name = photoName(file.name, image.taken ?? (file.lastModified > 0 ? new Date(file.lastModified) : null));
    return { status: 'added', image };
  } catch (e) {
    if (e instanceof CancelledError || signal?.aborted) throw new CancelledError();
    if (e instanceof UnsupportedImage) return { status: 'unsupported', sourceType };
    return { status: 'failed', sourceType };
  }
}

/**
 * Takes in several images, one after another, in their order, as the app's importImages: the
 * images added, and how many were skipped as unsupported or couldn't be read, with the messages to
 * show for them (string keys and counts, for tp()). `onProgress(done, total)` follows.
 * @param {Array<{ name: string, bytes: Uint8Array, lastModified?: number }>} files
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal, onImage?: (image: StoredImage|null, index: number) => void }} [hooks]
 * @returns {Promise<{ images: StoredImage[], unsupported: number, failed: number, messages: Array<{ key: string, count: number }> }>}
 */
export async function importImages(files, { onProgress, signal, onImage } = {}) {
  const images = [];
  let unsupported = 0;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    checkCancelled(signal);
    const result = await importImage(files[i], { signal });
    if (result.status === 'added') images.push(result.image);
    else if (result.status === 'unsupported') unsupported++;
    else failed++;
    onImage?.(result.status === 'added' ? result.image : null, i);
    onProgress?.(i + 1, files.length);
  }
  const messages = [];
  if (unsupported > 0) messages.push({ key: await unsupportedMessageKey(), count: unsupported });
  if (failed > 0) messages.push({ key: 'msg_failed_import', count: failed });
  return { images, unsupported, failed, messages };
}

/**
 * The plural string for images skipped as of a type Usugami can't read, naming those this browser
 * reads (as the app names those its Android version reads): 'msg_skipped_unsupported', or
 * 'web_skipped_unsupported_no_avif' in a browser that can't decode AVIF.
 * @returns {Promise<string>}
 */
export async function unsupportedMessageKey() {
  return (await canDecodeAvif()) ? 'msg_skipped_unsupported' : 'web_skipped_unsupported_no_avif';
}

/** The StoredImage of `bytes`, an image of `type`; its name is set by the caller. */
async function storeImage(bytes, type, signal) {
  const info = readImageInfo(bytes, type);
  if (info.width * info.height > MAX_DECODE_PIXELS) throw new RangeError('Too many pixels');

  // A JPEG or PNG already upright and not too large is kept as it is, less its metadata.
  if ((type === 'jpeg' || type === 'png') && info.orientation === 1 &&
      info.width > 0 && info.height > 0 && info.width * info.height <= MAX_PIXELS) {
    const kept = type === 'jpeg' ? strippedJpeg(bytes) : strippedPng(bytes);
    if (kept) {
      // Decoded once, small, so a damaged file is found now rather than when the PDF is made.
      const check = await decodeBitmap(kept, type, { resize: tiny(info.width, info.height), signal });
      check.bitmap.close?.();
      return {
        name: '', bytes: kept, type: IMAGE_MIME[type], format: type,
        width: info.width, height: info.height, sourceType: type, taken: info.taken,
      };
    }
  }

  // Anything else is decoded and stored again, upright.
  const lossless = type === 'png' || type === 'bmp' || type === 'gif' ||
    (type === 'webp' && !isLossyOpaqueWebp(bytes.subarray(0, WEBP_HEADER_BYTES))) ||
    ((type === 'heif' || type === 'avif') && info.alpha);
  const clean = withoutExifOrientation(bytes, type, info);
  const upright = fromExif(info.orientation);
  // The size it decodes at, before it is turned upright. A HEIF or AVIF file that turns its picture
  // itself decodes turned: its size is known once decoded.
  let size = !info.turnedByFile && info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null;
  // Made smaller still, a power of two, each time memory or the canvas runs out.
  let shrink = 1;
  for (;;) {
    checkCancelled(signal);
    const decoded = await decodeBitmap(clean, type, { resize: size && scaled(size, shrink), signal });
    try {
      size ??= { width: decoded.bitmap.width, height: decoded.bitmap.height };
      const { width, height } = scaled(size, shrink) ?? size;
      const format = lossless || decoded.alpha ? 'png' : 'jpeg';
      checkCancelled(signal);
      const out = await drawn(decoded.bitmap, upright, width, height, format);
      return {
        name: '', bytes: out, type: IMAGE_MIME[format], format,
        width: swapsAxes(upright) ? height : width,
        height: swapsAxes(upright) ? width : height,
        sourceType: type, taken: info.taken,
      };
    } catch (e) {
      // Out of memory, or a canvas too large for this browser: smaller, as the app does.
      if (!(e instanceof RangeError) || shrink >= MAX_SHRINK || signal?.aborted) throw e;
      shrink *= 2;
    } finally {
      decoded.bitmap.close?.();
    }
  }
}

/**
 * `size` reduced by halving (at least `shrink` times) until it has at most MAX_PIXELS, as Android's
 * inSampleSize does; null when it stays as it is.
 */
function scaled(size, shrink = 1) {
  let sample = shrink;
  while (Math.floor(size.width / sample) * Math.floor(size.height / sample) > MAX_PIXELS) sample *= 2;
  if (sample === 1) return null;
  return { width: Math.max(1, Math.floor(size.width / sample)), height: Math.max(1, Math.floor(size.height / sample)) };
}

/** `bitmap` (`width` × `height` once scaled) turned upright and encoded as `format`. */
async function drawn(bitmap, upright, width, height, format) {
  const outWidth = swapsAxes(upright) ? height : width;
  const outHeight = swapsAxes(upright) ? width : height;
  const canvas = makeCanvas(outWidth, outHeight);
  try {
    let ctx;
    try {
      ctx = context2d(canvas, { alpha: format === 'png' });
    } catch (e) {
      throw new RangeError(e.message);
    }
    if (format === 'jpeg') {
      // A JPEG has no transparency: what shows through is white, as on the PDF's page.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outWidth, outHeight);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const [a, b, c, d, e, f] = canvasMatrix(upright, bitmap.width, bitmap.height, outWidth, outHeight);
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(bitmap, 0, 0);
    try {
      return await encodeCanvas(canvas, format, format === 'jpeg' ? CONVERTED_JPEG_QUALITY : undefined);
    } catch (e) {
      throw new RangeError(e.message);
    }
  } finally {
    releaseCanvas(canvas);
  }
}

/** A size about 64 pixels on the long side with the shape of `width` × `height`. */
function tiny(width, height) {
  const scale = Math.min(1, 64 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * `bytes`, an image of `type`, decoded by the browser (libheif for HEIC where the browser can't),
 * at `resize` if given: { bitmap: ImageBitmap, alpha: boolean (known to have transparency) }.
 * Throws UnsupportedImage for AVIF in a browser without AVIF.
 */
async function decodeBitmap(bytes, type, { resize, signal } = {}) {
  const blob = new Blob([bytes], { type: IMAGE_MIME[type] });
  try {
    return { bitmap: await bitmapOf(blob, resize), alpha: false };
  } catch (e) {
    checkCancelled(signal);
    if (type === 'heif') {
      const pixels = await decodeHeif(bytes, { signal });
      checkCancelled(signal);
      const data = new ImageData(pixels.data, pixels.width, pixels.height);
      return { bitmap: await bitmapOf(data, resize), alpha: pixels.alpha };
    }
    if (type === 'avif' && !(await canDecodeAvif())) throw new UnsupportedImage('AVIF');
    throw e;
  }
}

/** createImageBitmap at `resize` ({ width, height }), also where the browser can't resize while decoding. */
async function bitmapOf(source, resize) {
  if (!resize) return createImageBitmap(source);
  let bitmap;
  try {
    bitmap = await createImageBitmap(source, { resizeWidth: resize.width, resizeHeight: resize.height, resizeQuality: 'high' });
  } catch {
    bitmap = await createImageBitmap(source);
  }
  if (bitmap.width === resize.width && bitmap.height === resize.height) return bitmap;
  // The options were ignored: scaled here.
  try {
    const canvas = makeCanvas(resize.width, resize.height);
    try {
      const ctx = context2d(canvas);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, resize.width, resize.height);
      return await createImageBitmap(canvas);
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    bitmap.close?.();
  }
}

let avifSupport = null;

/** Whether this browser decodes AVIF images (all current ones do; Safari before 16 doesn't). */
export function canDecodeAvif() {
  if (!avifSupport) {
    const probe = Uint8Array.from(atob(AVIF_PROBE), (c) => c.charCodeAt(0));
    avifSupport = createImageBitmap(new Blob([probe], { type: 'image/avif' }))
      .then((b) => {
        b.close?.();
        return true;
      }, () => false);
  }
  return avifSupport;
}

/** A small AVIF picture (the app's test image turned.avif), to try the browser on. */
const AVIF_PROBE = 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAEdAAAATAAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAAB0aXBycAAAAFRpcGNvAAAAFGlzcGUAAAAAAAAAgAAAAEAAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAAAlpcm90AwAAABhpcG1hAAAAAAAAAAEAAQUBAoMEhQAAAFRtZGF0EgAKCRgZf/7RAQ0GhDI9EQP7+1SAQQQfIABAz8wb/kUwvzHbeKHPFL1S9DY8Bip8BzL35Sh3nO0SdQZzkP32JIDznLA8bgUv4Q35IA==';

// ---- Names ----

/**
 * Whether `name` is no name worth keeping: what a camera app or a photo picker gives a photo whose
 * real name it hides, such as "image.jpg" (a photo just taken, on an iPhone), "image (2).jpg", or
 * a number ("1000000163.jpg", the Android photo picker's; a camera's time in milliseconds).
 */
export function isUnnamedPhoto(name) {
  const n = (name ?? '').trim();
  return n === '' || /^\d+(\.[A-Za-z0-9]+)?$/.test(n) || /^image(?: ?\(\d+\))?(\.[A-Za-z0-9]+)?$/i.test(n);
}

/**
 * The name an added image goes by (ImageStore.displayName and datedName): the file's own, or for a
 * photo without one (isUnnamedPhoto()) "Photo_" and the date and time it was taken, `taken` (else
 * now), with its extension, as a photo taken from Usugami is named after when it was taken. The PDF
 * of one photo is named after it.
 * @param {string} name   the file's name
 * @param {Date|null} [taken]
 * @returns {string}      e.g. 'Photo_20240501_134512.jpg'
 */
export function photoName(name, taken = null, now = new Date()) {
  const own = (name ?? '').split('/').pop().trim();
  if (!isUnnamedPhoto(own)) return own;
  const time = taken && !Number.isNaN(taken.getTime()) && taken.getTime() > 0 ? taken : now;
  const dot = own.lastIndexOf('.');
  const extension = dot >= 0 && dot < own.length - 1 ? own.slice(dot) : '';
  const two = (v) => String(v).padStart(2, '0');
  return 'Photo_' + time.getFullYear() + two(time.getMonth() + 1) + two(time.getDate()) + '_' +
    two(time.getHours()) + two(time.getMinutes()) + two(time.getSeconds()) + extension;
}

// ---- Reading stored images back ----

/**
 * A StoredImage (or a cropped page) decoded for showing, looking for its page or cropping: at most
 * `maxSide` pixels on its long side (as it is when smaller), turned `rotation` degrees clockwise (a
 * multiple of 90), as PageCropper.upright makes it. Throws UserError('msg_image_unreadable', name)
 * when it can't be decoded.
 * @param {{ bytes: Uint8Array, type?: string, format?: string, width: number, height: number, name?: string }} image
 * @param {{ maxSide?: number, rotation?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<ImageBitmap>}
 */
export async function loadImage(image, { maxSide = Infinity, rotation = 0, signal } = {}) {
  checkCancelled(signal);
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const type = image.format ?? (image.type === 'image/png' ? 'png' : 'jpeg');
  let bitmap;
  try {
    bitmap = (await decodeBitmap(image.bytes, type, { resize: scale < 1 ? { width, height } : null, signal })).bitmap;
  } catch (e) {
    if (e instanceof CancelledError || signal?.aborted) throw new CancelledError();
    throw new UserError('msg_image_unreadable', image.name ?? '');
  }
  if (floorMod(rotation, 360) === 0) return bitmap;
  const t = turn(rotation);
  try {
    const outWidth = swapsAxes(t) ? bitmap.height : bitmap.width;
    const outHeight = swapsAxes(t) ? bitmap.width : bitmap.height;
    const canvas = makeCanvas(outWidth, outHeight);
    try {
      const ctx = context2d(canvas);
      ctx.setTransform(...canvasMatrix(t, bitmap.width, bitmap.height));
      ctx.drawImage(bitmap, 0, 0);
      return await createImageBitmap(canvas);
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    bitmap.close?.();
  }
}
