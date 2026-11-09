// A DCTDecode image read by the browser's JPEG decoder, as a PDF viewer reads it: only grey and
// three-component JPEGs of 8 bits, coded as browsers decode them, whose colour transform is the one
// a viewer applies. The EXIF orientation and ICC profile a JPEG may carry are taken out first:
// viewers ignore both (the PDF's own colour space and placement count), browsers would apply them.
import { parseJpeg } from '../images/jpeg.js';
import { newCanvas, context2d } from '../images/canvas.js';
import { release } from '../images/page-source.js';
import { WorkBudget } from './budget.js';

/** SOF0, SOF1, SOF2: Huffman-coded baseline, extended and progressive, which every browser decodes. */
const DECODABLE_FRAMES = new Set([0xc0, 0xc1, 0xc2]);

/**
 * What a JPEG's header says about it, or null when it can't be read: `{ width, height, components,
 * precision, frameMarker, componentIds, hasAdobeMarker, hasJfifMarker, adobeTransform }`
 * (adobeTransform: the Adobe marker's transform byte, or -1 without one).
 */
export function jpegFacts(bytes) {
  let info;
  try {
    info = parseJpeg(bytes);
  } catch {
    return null;
  }
  return { ...info, adobeTransform: adobeTransform(bytes) };
}

/**
 * Whether the browser and a PDF viewer agree on a three-component JPEG's colours: whether its
 * components are YCbCr to turn into RGB. Browsers follow libjpeg (a JFIF marker first, then the
 * Adobe marker, then components named R, G, B); viewers the PDF rules (the Adobe marker first, then
 * the image's /ColorTransform, then the names).
 * @param {object} facts from jpegFacts
 * @param {number|undefined} colorTransform the /DecodeParms /ColorTransform, if given
 */
export function transformsAgree(facts, colorTransform) {
  if (facts.components !== 3) return true;
  const named = facts.componentIds[0] === 0x52 && facts.componentIds[1] === 0x47 && facts.componentIds[2] === 0x42;
  let browser;
  if (facts.hasJfifMarker) browser = true;
  else if (facts.adobeTransform >= 0) browser = facts.adobeTransform !== 0;
  else browser = !named;
  let viewer;
  if (facts.adobeTransform >= 0) viewer = facts.adobeTransform !== 0;
  else if (colorTransform === 0 || colorTransform === 1) viewer = colorTransform === 1;
  else viewer = !named;
  return browser === viewer;
}

/** Whether the browser can decode this JPEG as a viewer would show it with `components` colour components. */
export function canDecode(facts, components, width, height, colorTransform) {
  return !!facts && DECODABLE_FRAMES.has(facts.frameMarker) && facts.precision === 8 &&
    (facts.components === 1 || facts.components === 3) && facts.components === components &&
    facts.width === width && facts.height === height && transformsAgree(facts, colorTransform);
}

/** The Adobe (APP14) marker's transform byte, or -1 when there is none. */
function adobeTransform(bytes) {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return -1;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return -1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return -1;
    if (marker === 0xee && length >= 14 && bytes[i + 4] === 0x41 && bytes[i + 5] === 0x64 && bytes[i + 6] === 0x6f &&
        bytes[i + 7] === 0x62 && bytes[i + 8] === 0x65) {
      return bytes[i + 15];
    }
    i += 2 + length;
  }
  return -1;
}

/**
 * The JPEG without what browsers would act on and PDF viewers ignore: APP1 to APP13 and APP15
 * (EXIF with its orientation, XMP, ICC profiles in APP2...) and comments. JFIF (APP0), the Adobe
 * marker (APP14), the tables, the frame and the scans are copied as they are.
 */
export function jpegForDecoding(bytes) {
  const parts = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) break;
    const end = Math.min(bytes.length, i + 2 + length);
    const dropped = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!dropped) parts.push(bytes.subarray(i, end));
    i = end;
  }
  // The scans, and anything after them, as they are.
  parts.push(bytes.subarray(i));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Decodes a JPEG (`width` x `height`) and shrinks it to `outWidth` x `outHeight`, as opaque RGBA
 * ImageData (rows from the top; a grey JPEG has R = G = B). Resolves to null when the browser can't
 * decode it at the size it says it is. Where the browser can, it decodes and shrinks the picture away
 * from the page (createImageBitmap's resize, the same pixels as a smooth canvas draw in Chrome), so
 * the page itself only reads the pixels back.
 * @returns {Promise<ImageData|null>}
 */
export async function decodeJpegImage(bytes, { width, height }, outWidth, outHeight) {
  const blob = new Blob([jpegForDecoding(bytes)], { type: 'image/jpeg' });
  let bitmap = null;
  if (outWidth !== width || outHeight !== height) {
    bitmap = await bitmapOf(blob, { resizeWidth: outWidth, resizeHeight: outHeight, resizeQuality: 'high' });
    // A browser that ignores the resize (Safari) gives the picture at its own size, shrunk below.
    const asked = bitmap && bitmap.width === outWidth && bitmap.height === outHeight;
    if (bitmap && !asked && (bitmap.width !== width || bitmap.height !== height)) {
      release(bitmap);
      bitmap = null;
    }
  }
  if (!bitmap) {
    bitmap = await bitmapOf(blob, {});
    if (!bitmap) return null;
    if (bitmap.width !== width || bitmap.height !== height) {
      release(bitmap);
      return null;
    }
  }
  let canvas = null;
  try {
    canvas = shrink(bitmap, outWidth, outHeight);
    return context2d(canvas, { willRead: true }).getImageData(0, 0, outWidth, outHeight);
  } finally {
    release(canvas);
    release(bitmap);
  }
}

/**
 * The decoded picture, or null when the browser can't decode it (or has no memory for it). A JPEG
 * has no transparency, so premultiplying changes nothing; asking Chrome not to makes it convert the
 * picture on the page's own thread.
 */
async function bitmapOf(blob, options) {
  try {
    return await createImageBitmap(blob, options);
  } catch {
    return null;
  }
}

/**
 * Decodes a JPEG (`width` x `height`, `components` 1 or 3) and shrinks it to `outWidth` x
 * `outHeight`, as 8-bit components (`components` a pixel, rows from the top). Resolves to null when
 * the browser can't decode it at the size it says it is. The components are copied out a slice at a
 * time, letting the page paint meanwhile (`signal` stops it with CancelledError).
 * @returns {Promise<Uint8Array|null>}
 */
export async function decodeJpeg(bytes, { width, height, components }, outWidth, outHeight, { signal } = {}) {
  const image = await decodeJpegImage(bytes, { width, height }, outWidth, outHeight);
  if (!image) return null;
  const data = image.data;
  const pixels = new Uint8Array(outWidth * outHeight * components);
  const budget = new WorkBudget(signal);
  await budget.check();
  await budget.each(outWidth * outHeight, (from, to) => {
    if (components === 1) {
      for (let p = from, i = from * 4; p < to; p++, i += 4) pixels[p] = data[i];
    } else {
      for (let p = from * 3, i = from * 4, end = to * 3; p < end; p += 3, i += 4) {
        pixels[p] = data[i];
        pixels[p + 1] = data[i + 1];
        pixels[p + 2] = data[i + 2];
      }
    }
  });
  return pixels;
}

/**
 * `source` drawn at exactly w x h on a new canvas, smoothly: halved step by step first, so a large
 * reduction doesn't alias.
 */
export function shrink(source, w, h) {
  let current = source;
  let cw = source.width;
  let ch = source.height;
  while (Math.floor(cw / 2) >= w && Math.floor(ch / 2) >= h && (cw > w * 2 || ch > h * 2)) {
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
  const ctx = context2d(out, { willRead: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, cw, ch, 0, 0, w, h);
  if (current !== source) release(current);
  return out;
}
