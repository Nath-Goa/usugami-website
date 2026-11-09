// Pictures put on pages in Edit PDF (PagePictures.kt). A picked picture is taken in as Images to PDF
// takes in an image (engine/images/decode.js: upright, without hidden metadata, HEIC too), and
// kept in memory while the tool is open. In the PDF a photo goes in as JPEG, any other picture
// losslessly with its transparency, sharp at the size it is drawn but no larger.
import { UserError, CancelledError, checkCancelled } from '../../core/errors.js';
import { embedImage } from '../text/index.js';

/** Kinds of picture stored as JPEG; the rest are stored losslessly. */
const PHOTO_TYPES = new Set(['jpeg', 'heif', 'avif']);

/** Photos go in at this resolution of the size they are drawn at… */
export const PHOTO_DPI = 300;

/** …and other pictures, stored losslessly and so bigger, at this one… */
export const LOSSLESS_DPI = 200;

/** …but never more pixels than this on their longer side. */
export const MAX_SIDE = 2400;

/** JPEG quality of photos, as the app's 85. */
export const JPEG_QUALITY = 0.85;

/** Pictures are shown on the screen at most this many pixels on their longer side. */
export const PREVIEW_SIDE = 1024;

let pictureSeq = 0;

/**
 * @typedef {object} Picture
 * @property {number} id
 * @property {string} name
 * @property {{ bytes: Uint8Array, type: string, format?: string, width: number, height: number }} image
 *   the stored copy: a JPEG or PNG, upright
 * @property {number} width   its size in pixels, upright
 * @property {number} height
 * @property {boolean} jpeg   a photo, stored as JPEG; otherwise lossless with any transparency
 */

/**
 * Takes in the picture `file` (a FileItem). Resolves to a Picture, or null if it isn't a picture
 * this browser can read.
 * @param {{ name: string, bytes: Uint8Array, lastModified?: number }} file
 * @param {{ signal?: AbortSignal }} [hooks]
 * @returns {Promise<Picture|null>}
 */
export async function importPicture(file, { signal } = {}) {
  checkCancelled(signal);
  let images = null;
  try {
    images = await import('../images/decode.js');
  } catch {
    images = null;
  }
  if (images?.importImage) {
    const result = await images.importImage(file, { signal });
    if (result.status !== 'added') return null;
    const image = result.image;
    if (!(image.width > 0 && image.height > 0)) return null;
    // Photos stay photos; drawings, screenshots and pictures with transparency stay lossless. A
    // WebP file can be either: its header says which.
    const header = file.bytes.subarray(0, images.WEBP_HEADER_BYTES ?? 65536);
    const jpeg = PHOTO_TYPES.has(image.sourceType) || (image.sourceType === 'webp' && !!images.isLossyOpaqueWebp?.(header));
    return { id: ++pictureSeq, name: image.name ?? file.name, image, width: image.width, height: image.height, jpeg };
  }
  // Without the images engine: what the browser decodes itself, turned as its EXIF says.
  return importDirectly(file, signal);
}

async function importDirectly(file, signal) {
  const type = sniff(file.bytes);
  if (!type) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([file.bytes], { type }));
  } catch {
    checkCancelled(signal);
    return null;
  }
  const { width, height } = bitmap;
  bitmap.close?.();
  checkCancelled(signal);
  if (!(width > 0 && height > 0)) return null;
  const jpeg = type === 'image/jpeg' || type === 'image/avif' || type === 'image/heic';
  return { id: ++pictureSeq, name: file.name, image: { bytes: file.bytes, type, width, height }, width, height, jpeg };
}

/** The image type of `bytes` by their first bytes, or null. */
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') return /avi[fs]/.test(ascii(8, 12)) ? 'image/avif' : 'image/heic';
  return null;
}

/**
 * `picture` decoded, upright, with its longer side at most `longSide` pixels (as it is when smaller).
 * Rejects with UserError('edit_picture_failed') when it can't be decoded.
 * @returns {Promise<ImageBitmap>}
 */
export async function decodePicture(picture, longSide, { signal } = {}) {
  checkCancelled(signal);
  const { image } = picture;
  const scale = Math.min(1, longSide / Math.max(picture.width, picture.height));
  const width = Math.max(1, Math.round(picture.width * scale));
  const height = Math.max(1, Math.round(picture.height * scale));
  const blob = new Blob([image.bytes], { type: image.type || 'image/png' });
  try {
    let bitmap = scale < 1
      ? await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }).catch(() => createImageBitmap(blob))
      : await createImageBitmap(blob);
    if (scale < 1 && (bitmap.width !== width || bitmap.height !== height)) {
      // The browser ignored the size asked for: scaled here.
      const canvas = makeCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      bitmap = await createImageBitmap(canvas);
    }
    checkCancelled(signal);
    return bitmap;
  } catch (e) {
    if (e instanceof CancelledError || signal?.aborted) throw new CancelledError();
    throw new UserError('edit_picture_failed');
  }
}

/** The longer side, in pixels, `item`'s picture goes into the PDF at: sharp at the size it is drawn. */
export function pdfLongSide(item) {
  const dpi = item.picture.jpeg ? PHOTO_DPI : LOSSLESS_DPI;
  return Math.min(MAX_SIDE, Math.max(1, Math.round(Math.max(item.width, item.height) / 72 * dpi)));
}

/**
 * `item`'s picture as an image of `doc` (text engine embedImage(): { ref, width, height }), sharp at
 * the size it is drawn: a photo as JPEG (what shows through it white), any other picture losslessly,
 * with its transparency. `cache` (a Map) reuses one image for the same picture at the same size.
 */
export async function pdfImage(doc, item, cache, { signal } = {}) {
  const longSide = pdfLongSide(item);
  const key = `${item.picture.id}@${longSide}`;
  if (cache?.has(key)) return cache.get(key);
  const bitmap = await decodePicture(item.picture, Math.min(longSide, Math.max(item.picture.width, item.picture.height)), { signal });
  let info;
  try {
    if (item.picture.jpeg) {
      const canvas = makeCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, 0, 0);
      info = embedImage(doc, canvas, { format: 'jpeg', quality: JPEG_QUALITY });
    } else {
      info = embedImage(doc, bitmap, { format: 'png' });
    }
  } finally {
    bitmap.close?.();
  }
  if (!info) throw new UserError('edit_picture_failed');
  cache?.set(key, info);
  return info;
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}
