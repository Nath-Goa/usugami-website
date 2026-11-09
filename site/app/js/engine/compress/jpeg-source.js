// A DCTDecode image read by the browser's JPEG decoder, as a PDF viewer reads it: only grey and
// three-component JPEGs of 8 bits, coded as browsers decode them, whose colour transform is the one
// a viewer applies. The EXIF orientation and ICC profile a JPEG may carry are taken out first:
// viewers ignore both (the PDF's own colour space and placement count), browsers would apply them.
import { parseJpeg } from '../images/jpeg.js';
import { newCanvas, context2d } from '../images/canvas.js';
import { release } from '../images/page-source.js';

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
 * Decodes a JPEG (`width` x `height`, `components` 1 or 3) and shrinks it to `outWidth` x
 * `outHeight`, as 8-bit components (`components` a pixel, rows from the top). Resolves to null when
 * the browser can't decode it at the size it says it is.
 * @returns {Promise<Uint8Array|null>}
 */
export async function decodeJpeg(bytes, { width, height, components }, outWidth, outHeight) {
  const blob = new Blob([jpegForDecoding(bytes)], { type: 'image/jpeg' });
  let bitmap = null;
  // Decoded at a power-of-two reduction when much smaller is wanted, as Android's inSampleSize does.
  let sample = 1;
  while (width / (sample * 2) >= outWidth && height / (sample * 2) >= outHeight) sample *= 2;
  if (sample > 1) {
    try {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: Math.max(outWidth, Math.ceil(width / sample)),
        resizeHeight: Math.max(outHeight, Math.ceil(height / sample)),
        resizeQuality: 'high',
        premultiplyAlpha: 'none',
      });
    } catch {
      bitmap = null;
    }
  }
  if (!bitmap) {
    try {
      bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
    } catch {
      return null;
    }
    if (bitmap.width !== width || bitmap.height !== height) {
      release(bitmap);
      return null;
    }
  }
  let canvas = null;
  try {
    canvas = shrink(bitmap, outWidth, outHeight);
    const data = context2d(canvas, { willRead: true }).getImageData(0, 0, outWidth, outHeight).data;
    const pixels = new Uint8Array(outWidth * outHeight * components);
    if (components === 1) {
      for (let p = 0, i = 0; p < pixels.length; p++, i += 4) pixels[p] = data[i];
    } else {
      for (let p = 0, i = 0; p < pixels.length; p += 3, i += 4) {
        pixels[p] = data[i];
        pixels[p + 1] = data[i + 1];
        pixels[p + 2] = data[i + 2];
      }
    }
    return pixels;
  } finally {
    release(canvas);
    release(bitmap);
  }
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
