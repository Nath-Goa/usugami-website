// A picked image's pixels for the PDF builder: decoded by the browser (or handed over already
// decoded), with how they are turned, drawn at any smaller size as the app's PdfExporter.decode
// draws them (stepping down by halves first so large reductions don't alias).
import { UserError } from '../../core/errors.js';
import { encodeGrayJpeg } from './encode.js';
import {
  imageFileType, storedSize, exifOrientation, withExifOrientation,
} from './jpeg.js';
import { fromExif, swapsAxes, inverse, then } from './image-transform.js';
import { IMAGE_MIME } from './image-type.js';
import { imageTransform } from './page-layout.js';
import {
  newCanvas, context2d, sourceSize, isImageData, imageDataToCanvas,
} from './canvas.js';

let exifProbe = null;

/**
 * Whether createImageBitmap turns a photo as its EXIF orientation says (current browsers do; some
 * older ones gave the pixels as stored). Found once, with a 2 x 1 JPEG marked as turned a quarter.
 */
export function bitmapsFollowExif() {
  exifProbe ??= (async () => {
    try {
      const jpeg = withExifOrientation(encodeGrayJpeg({ width: 2, height: 1, pixels: Uint8Array.of(0, 255) }, 90), 6);
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      const turned = bitmap.width === 1 && bitmap.height === 2;
      bitmap.close?.();
      return turned;
    } catch {
      return true;
    }
  })();
  return exifProbe;
}

/** A canvas or ImageBitmap's memory given back. */
export function release(pixels) {
  if (!pixels) return;
  try {
    if (typeof ImageBitmap !== 'undefined' && pixels instanceof ImageBitmap) pixels.close();
    else if ('width' in pixels && typeof pixels.getContext === 'function') {
      pixels.width = 0;
      pixels.height = 0;
    }
  } catch {
    // Already released.
  }
}

async function decodeWithImageElement(blob) {
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) return null;
    // Drawn once onto a canvas, so the object URL can go.
    const canvas = newCanvas(img.naturalWidth, img.naturalHeight);
    context2d(canvas).drawImage(img, 0, 0);
    return canvas;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Opens a page's image for drawing.
 * @param {object} item a page as buildImagesPdf takes it ({ name, bytes?, source?, exifOrientation?, rotation? })
 * @param {{ sizeHint?: (fullWidth: number, fullHeight: number, exif: number) => [number, number] | null }} [options]
 *   sizeHint: the size the picture will be drawn at, given its full size as stored; when much
 *   smaller, the browser is asked to decode it smaller, which needs far less memory for a big photo
 * @returns {Promise<PageSource>}
 *
 * PageSource: { type, bytes, exif (how the stored picture is turned: item.exifOrientation, else as
 * its file says), pixels (ImageBitmap or canvas), width, height (of pixels), fullWidth, fullHeight
 * (the picture's full size in the pixels' orientation), transform (from the pixels to the page as
 * shown: their orientation, then the user's rotation), shownWidth, shownHeight (full size as
 * shown), draw(w, h), close() }. close() gives back what was decoded for the page: an ImageBitmap
 * from `bytes` or from a `source` function, never a picture handed over as it is.
 */
export async function openPageSource(item, { sizeHint } = {}) {
  const bytes = item.bytes ?? null;
  const type = bytes ? imageFileType(bytes) : null;
  // How the file says it is turned (what a decoder may apply), and how the caller says it is.
  const fileExif = bytes ? exifOrientation(bytes) : 1;
  const exif = item.exifOrientation ?? fileExif;
  const rotation = item.rotation ?? 0;
  const stored2shown = imageTransform(exif, rotation);
  let pixels = null;
  // From the pixels as decoded to the picture as stored.
  let pixels2stored = fromExif(1);
  let fullWidth;
  let fullHeight;
  let owned = false;

  if (item.source) {
    let source = typeof item.source === 'function' ? await item.source() : item.source;
    if (!source) throw new UserError('msg_image_unreadable', item.name);
    if (isImageData(source)) {
      source = imageDataToCanvas(source);
      owned = true;
    } else {
      // Made for this page by the caller's function: given back once the page is made.
      owned = typeof item.source === 'function' && typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap;
    }
    const size = sourceSize(source);
    if (!(size.width > 0 && size.height > 0)) throw new UserError('msg_image_unreadable', item.name);
    pixels = source;
    fullWidth = size.width;
    fullHeight = size.height;
  } else {
    if (!bytes || !bytes.length) throw new UserError('msg_image_unreadable', item.name);
    const blob = new Blob([bytes], { type: IMAGE_MIME[type] ?? 'application/octet-stream' });
    const stored = storedSize(bytes);
    const follows = await bitmapsFollowExif();
    // The picture's size as the browser gives it: turned by its EXIF orientation where it follows it.
    const turns = follows && swapsAxes(fromExif(fileExif));
    const asDecoded = stored ? (turns ? [stored.height, stored.width] : [stored.width, stored.height]) : null;
    const wanted = stored && sizeHint ? sizeHint(stored.width, stored.height, exif) : null;
    let bitmap = null;
    let shrunk = false;
    if (asDecoded && wanted) {
      // Decoded at the nearest larger power-of-two reduction, as Android's inSampleSize does.
      let sample = 1;
      while (stored.width / (sample * 2) >= wanted[0] && stored.height / (sample * 2) >= wanted[1]) sample *= 2;
      if (sample > 1) {
        try {
          bitmap = await createImageBitmap(blob, {
            resizeWidth: Math.max(1, Math.ceil(asDecoded[0] / sample)),
            resizeHeight: Math.max(1, Math.ceil(asDecoded[1] / sample)),
            resizeQuality: 'high',
          });
          shrunk = true;
        } catch {
          bitmap = null;
        }
      }
    }
    if (!bitmap) {
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        bitmap = await decodeWithImageElement(blob);
      }
    }
    if (!bitmap || !(bitmap.width > 0 && bitmap.height > 0)) {
      release(bitmap);
      throw new UserError('msg_image_unreadable', item.name);
    }
    pixels = bitmap;
    owned = true;
    // Whether the decoder turned it: told by its size when the turn swaps the sides, else as found.
    let turned = follows && fileExif !== 1;
    if (stored && swapsAxes(fromExif(fileExif)) && stored.width !== stored.height && !shrunk) {
      turned = bitmap.width === stored.height && bitmap.height === stored.width;
    }
    // Turned by the decoder as the file says: undo that to get back to the picture as stored.
    if (turned) pixels2stored = inverse(fromExif(fileExif));
    const full = stored ? (turned && swapsAxes(fromExif(fileExif)) ? [stored.height, stored.width] : [stored.width, stored.height]) : [bitmap.width, bitmap.height];
    [fullWidth, fullHeight] = full;
  }

  const transform = then(pixels2stored, stored2shown);
  const width = sourceSize(pixels).width;
  const height = sourceSize(pixels).height;
  const swap = swapsAxes(transform);
  return {
    type,
    bytes,
    exif,
    rotation,
    pixels,
    width,
    height,
    fullWidth,
    fullHeight,
    transform,
    shownWidth: swap ? fullHeight : fullWidth,
    shownHeight: swap ? fullWidth : fullHeight,
    /** The pixels drawn `w` x `h` (in their own orientation) on a new canvas; as they are when either side is already no larger. */
    draw(w, h) {
      return resized(pixels, width, height, w, h);
    },
    close() {
      if (owned) release(pixels);
      pixels = null;
    },
  };
}

/** `source` (w0 x h0) smoothly scaled to w x h; steps down by halves first so large reductions don't alias. */
export function resized(source, w0, h0, w, h) {
  if (w0 <= w || h0 <= h) {
    const canvas = newCanvas(w0, h0);
    context2d(canvas).drawImage(source, 0, 0);
    return canvas;
  }
  let current = source;
  let cw = w0;
  let ch = h0;
  while (Math.floor(cw / 2) >= w && Math.floor(ch / 2) >= h) {
    const half = newCanvas(Math.floor(cw / 2), Math.floor(ch / 2));
    const ctx = context2d(half);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, cw, ch, 0, 0, half.width, half.height);
    if (current !== source) release(current);
    current = half;
    cw = half.width;
    ch = half.height;
  }
  const out = newCanvas(w, h);
  const ctx = context2d(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, cw, ch, 0, 0, w, h);
  if (current !== source) release(current);
  return out;
}

/**
 * The picture `source` (w x h, as stored) as shown: turned by `transform` onto a canvas, at most
 * `maxSide` pixels on its long side. On white, so transparency reads as paper.
 */
export function renderShown(source, w, h, transform, { maxSide = Infinity, dom = false } = {}) {
  const swap = swapsAxes(transform);
  let sw = swap ? h : w;
  let sh = swap ? w : h;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  sw = Math.max(1, Math.round(sw * scale));
  sh = Math.max(1, Math.round(sh * scale));
  const canvas = newCanvas(sw, sh, { dom });
  const ctx = context2d(canvas, { willRead: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sw, sh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const t = transform;
  // A stored pixel (x, y) is at (s, t) = (x / w, y / h); shown at (a s + b t + c, d s + e t + f).
  ctx.setTransform((sw * t.a) / w, (sh * t.d) / w, (sw * t.b) / h, (sh * t.e) / h, sw * t.c, sh * t.f);
  ctx.drawImage(source, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}
