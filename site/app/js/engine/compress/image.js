// One image XObject made smaller: what can be read faithfully (as a viewer reads it) is shrunk to
// the size it needs and stored again, in the same colour space with the same /Decode, its soft mask
// or stencil mask kept as it is. Grey (one component) and three-component images become JPEGs;
// others (CMYK, DeviceN), which a browser can't store as JPEG, are stored losslessly when shrunk.
import {
  PDFName, PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFBool,
} from '../../lib/pdf-lib.js';
import { zlibSync } from '../../lib/fflate.js';
import { encodeJpeg, filterRow } from '../images/encode.js';
import { newImageData } from '../images/canvas.js';
import { filtersOf, decodeAll, paramInt, READABLE, StreamError } from './filters.js';
import { readSamples } from './samples.js';
import { jpegFacts, canDecode, decodeJpeg } from './jpeg-source.js';

/** Images whose stored data is smaller than this are left alone: there is little to gain (the app's rule). */
export const MIN_IMAGE_BYTES = 2048;

/** Images with more pixels than this are left as they are, so a hostile one can't exhaust memory or time. */
export const MAX_IMAGE_PIXELS = 100_000_000;

/** What the new image keeps of the old one's dictionary, beyond how its data is stored. */
const KEPT_KEYS = ['SMask', 'Mask', 'Interpolate', 'Intent', 'OC', 'StructParent', 'ID', 'Name', 'Measure', 'PtData'];

const name = (key) => PDFName.of(key);

const lookup = (ctx, v) => {
  for (let i = 0; i < 8 && v instanceof PDFRef; i++) v = ctx.lookup(v);
  return v instanceof PDFRef ? undefined : v;
};

const nameOf = (v) => (v instanceof PDFName ? v.decodeText() : undefined);

const intOf = (ctx, v) => {
  const n = lookup(ctx, v);
  return n instanceof PDFNumber && Number.isInteger(n.asNumber()) ? n.asNumber() : undefined;
};

/**
 * An image's colour space as far as it matters here: `{ components, deviceRgb, palette? }`, or null
 * for one that can't be kept (a pattern, an unknown name, a damaged array). `palette`, for
 * Indexed: `{ base (the base colour space object as stored), components, deviceRgb, hival, lookup }`, where
 * `lookup` is the table's object (a string or a stream), read later.
 */
export function colourSpaceOf(ctx, value, depth = 0) {
  const cs = lookup(ctx, value);
  if (depth > 3 || cs == null) return null;
  const device = (n) => {
    switch (n) {
      case 'DeviceGray': case 'G': case 'CalGray': return { components: 1, deviceRgb: false };
      case 'DeviceRGB': case 'RGB': return { components: 3, deviceRgb: true };
      case 'CalRGB': case 'Lab': return { components: 3, deviceRgb: false };
      case 'DeviceCMYK': case 'CMYK': return { components: 4, deviceRgb: false };
      default: return null;
    }
  };
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    return n === 'CalGray' || n === 'CalRGB' || n === 'Lab' ? null : device(n);
  }
  if (!(cs instanceof PDFArray) || cs.size() < 1) return null;
  const family = nameOf(lookup(ctx, cs.get(0)));
  switch (family) {
    case 'DeviceGray': case 'DeviceRGB': case 'DeviceCMYK': case 'G': case 'RGB': case 'CMYK':
      return cs.size() === 1 ? device(family) : null;
    case 'CalGray': case 'CalRGB': case 'Lab':
      return lookup(ctx, cs.get(1)) instanceof PDFDict ? device(family) : null;
    case 'ICCBased': {
      const stream = lookup(ctx, cs.get(1));
      if (!(stream instanceof PDFStream)) return null;
      let n = intOf(ctx, stream.dict.get(name('N')));
      if (n == null) n = colourSpaceOf(ctx, stream.dict.get(name('Alternate')), depth + 1)?.components;
      return n === 1 || n === 3 || n === 4 ? { components: n, deviceRgb: false } : null;
    }
    case 'Separation':
      return cs.size() >= 4 ? { components: 1, deviceRgb: false } : null;
    case 'DeviceN': {
      const inks = lookup(ctx, cs.get(1));
      const n = inks instanceof PDFArray ? inks.size() : 0;
      return n >= 1 && n <= 32 && cs.size() >= 4 ? { components: n, deviceRgb: false } : null;
    }
    case 'Indexed': case 'I': {
      if (cs.size() < 4) return null;
      const baseValue = cs.get(1);
      const base = colourSpaceOf(ctx, baseValue, depth + 1);
      const hival = intOf(ctx, cs.get(2));
      if (!base || base.palette || hival == null || hival < 0 || hival > 255) return null;
      const table = lookup(ctx, cs.get(3));
      if (!(table instanceof PDFString || table instanceof PDFHexString || table instanceof PDFStream)) return null;
      return { components: 1, deviceRgb: false, palette: { base: baseValue, components: base.components, deviceRgb: base.deviceRgb, hival, lookup: table } };
    }
    default:
      return null;
  }
}

/**
 * Whether the image can be read and stored again here, and how: `{ ok: true, ...facts }` or
 * `{ ok: false, reason }`. The reasons are for tests and debugging, never shown.
 * @param {object} ctx pdf-lib's PDFContext
 * @param {PDFStream} stream the image XObject
 */
export function examine(ctx, stream) {
  const dict = stream.dict;
  const get = (key) => lookup(ctx, dict.get(name(key)));
  if (get('ImageMask') instanceof PDFBool && get('ImageMask').asBoolean()) return { ok: false, reason: 'stencil mask' };
  // Colour-key masking picks pixels by their exact stored values, which a JPEG doesn't keep.
  if (get('Mask') instanceof PDFArray) return { ok: false, reason: 'colour key mask' };
  const smask = get('SMask');
  // A matte means the colours were blended with it at the soft mask's size: they must stay together.
  if (smask instanceof PDFStream && smask.dict.get(name('Matte')) != null) return { ok: false, reason: 'matte' };
  if (dict.get(name('F')) != null) return { ok: false, reason: 'external data' };
  const data = stream.getContents();
  if (data.length < MIN_IMAGE_BYTES) return { ok: false, reason: 'small' };
  const width = intOf(ctx, dict.get(name('Width')));
  const height = intOf(ctx, dict.get(name('Height')));
  if (!(width > 0 && height > 0) || width > 65535 || height > 65535) return { ok: false, reason: 'size' };
  if (width * height > MAX_IMAGE_PIXELS) return { ok: false, reason: 'too many pixels' };
  let filters;
  try {
    filters = filtersOf(ctx, dict);
  } catch {
    return { ok: false, reason: 'filters' };
  }
  const dct = filters.length > 0 && filters[filters.length - 1].name === 'DCTDecode';
  const before = dct ? filters.slice(0, -1) : filters;
  if (!before.every((f) => READABLE.has(f.name))) return { ok: false, reason: `filter ${filters.map((f) => f.name).join(' ')}` };
  const colourSpace = colourSpaceOf(ctx, dict.get(name('ColorSpace')));
  if (!colourSpace) return { ok: false, reason: 'colour space' };
  let bpc = intOf(ctx, dict.get(name('BitsPerComponent')));
  if (dct) {
    // The JPEG's own precision counts; a palette makes no sense with one.
    if (colourSpace.palette || colourSpace.components > 3) return { ok: false, reason: 'jpeg components' };
    bpc = 8;
  } else if (![1, 2, 4, 8, 16].includes(bpc) || (colourSpace.palette && bpc === 16)) {
    return { ok: false, reason: 'bits per component' };
  }
  // Bilevel images (scans of text, line art): a JPEG would blur them and is seldom smaller.
  if (bpc === 1) return { ok: false, reason: 'one bit' };
  const decode = get('Decode');
  let decodeValues;
  if (decode != null) {
    if (!(decode instanceof PDFArray)) return { ok: false, reason: 'decode' };
    decodeValues = decode.asArray().map((v) => {
      const n = lookup(ctx, v);
      return n instanceof PDFNumber ? n.asNumber() : NaN;
    });
    const wanted = colourSpace.palette ? 2 : 2 * colourSpace.components;
    if (decodeValues.length < wanted || decodeValues.slice(0, wanted).some((v) => !Number.isFinite(v))) return { ok: false, reason: 'decode' };
    decodeValues = decodeValues.slice(0, wanted);
  }
  const colorTransform = dct ? paramInt(ctx, filters[filters.length - 1].params, 'ColorTransform', undefined) : undefined;
  return {
    ok: true, data, width, height, bpc, filters, before, dct, colourSpace, decode: decodeValues, colorTransform,
  };
}

/**
 * The image's pixels at `outWidth` x `outHeight`: 8-bit components of its colour space (for an
 * Indexed one, of its base), or null when they can't be read as a viewer would read them.
 * @returns {Promise<{ pixels: Uint8Array, components: number } | null>}
 */
export async function readImage(ctx, facts, outWidth, outHeight, { signal } = {}) {
  const { data, width, height, bpc, before, dct, colourSpace } = facts;
  if (dct) {
    let bytes = data;
    if (before.length) {
      const r = await decodeAll(ctx, data, before, { maxBytes: data.length * 64 + (1 << 20), signal });
      if (!r.complete) return null;
      bytes = r.bytes;
    }
    const jpeg = jpegFacts(bytes);
    if (!canDecode(jpeg, colourSpace.components, width, height, facts.colorTransform)) return null;
    const pixels = await decodeJpeg(bytes, { width, height, components: jpeg.components }, outWidth, outHeight);
    return pixels ? { pixels, components: jpeg.components } : null;
  }
  let palette;
  if (colourSpace.palette) {
    const p = colourSpace.palette;
    let table;
    if (p.lookup instanceof PDFStream) {
      const r = await decodeAll(ctx, p.lookup.getContents(), filtersOf(ctx, p.lookup.dict), { maxBytes: 1 << 16, signal });
      table = r.bytes;
    } else {
      table = p.lookup.asBytes();
    }
    palette = { table, components: p.components, hival: p.hival, decode: facts.decode };
  }
  const expected = Math.ceil((width * colourSpace.components * bpc) / 8) * height;
  if (expected > 1 << 30) return null;
  const r = await readSamples(ctx, data, facts.filters, {
    width, height, bpc, components: colourSpace.components, outWidth, outHeight, palette,
  }, { signal });
  if (!r.complete) return null;
  return { pixels: r.pixels, components: palette ? palette.components : colourSpace.components };
}

/** Whether every pixel of RGB `pixels` is grey, give or take what a JPEG's colour rounding leaves. */
export function isGreyRgb(pixels, tolerance = 3) {
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (Math.abs(r - g) > tolerance || Math.abs(g - b) > tolerance || Math.abs(r - b) > tolerance) return false;
  }
  return true;
}

/**
 * The new image's data and how it is stored: `{ bytes, filter, params?, components, grey }`.
 * One component: a one-component JPEG. Three: a colour JPEG, or a grey one when the colour space
 * is DeviceRGB, there is no /Decode and every pixel is grey. Others: Flate with PNG predictors.
 */
export async function encodeImage(pixels, width, height, components, { quality, deviceRgb, decode, signal }) {
  if (components === 1) {
    return { bytes: await encodeJpeg({ width, height, pixels }, { quality, gray: true, signal }), filter: 'DCTDecode', components, grey: false };
  }
  if (components === 3) {
    if (deviceRgb && !decode && isGreyRgb(pixels)) {
      const grey = new Uint8Array(width * height);
      for (let p = 0, i = 0; p < grey.length; p++, i += 3) grey[p] = (pixels[i] * 77 + pixels[i + 1] * 150 + pixels[i + 2] * 29) >> 8;
      return { bytes: await encodeJpeg({ width, height, pixels: grey }, { quality, gray: true, signal }), filter: 'DCTDecode', components: 1, grey: true };
    }
    const imageData = newImageData(width, height);
    const d = imageData.data;
    for (let p = 0, i = 0; i < d.length; p += 3, i += 4) {
      d[i] = pixels[p];
      d[i + 1] = pixels[p + 1];
      d[i + 2] = pixels[p + 2];
      d[i + 3] = 255;
    }
    return { bytes: await encodeJpeg(imageData, { quality, signal }), filter: 'DCTDecode', components, grey: false };
  }
  return { bytes: flateComponents(pixels, width, height, components), filter: 'FlateDecode', components, grey: false };
}

/** zlib data of 8-bit rows of `components` components through the PNG filters (Predictor 15). */
export function flateComponents(pixels, width, height, components) {
  const rowBytes = width * components;
  const filtered = new Uint8Array((rowBytes + 1) * height);
  let previous = new Uint8Array(rowBytes);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
  for (let y = 0; y < height; y++) {
    const current = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    const filter = filterRow(current, previous, components, candidates);
    const at = y * (rowBytes + 1);
    filtered[at] = filter;
    filtered.set(candidates[filter], at + 1);
    previous = current;
  }
  return zlibSync(filtered, { level: 6 });
}

/**
 * The new image XObject: `encoded` (from encodeImage) at `width` x `height`, in the old image's
 * colour space (its base for an Indexed one, DeviceGray for a grey DeviceRGB one) with its /Decode,
 * keeping its masks and what else matters to how and when it is shown (KEPT_KEYS).
 */
export function imageStream(ctx, original, facts, encoded, width, height) {
  const dict = ctx.obj({});
  for (const key of KEPT_KEYS) {
    const v = original.dict.get(name(key));
    if (v !== undefined) dict.set(name(key), v);
  }
  dict.set(name('Type'), name('XObject'));
  dict.set(name('Subtype'), name('Image'));
  dict.set(name('Width'), PDFNumber.of(width));
  dict.set(name('Height'), PDFNumber.of(height));
  dict.set(name('BitsPerComponent'), PDFNumber.of(8));
  const cs = facts.colourSpace;
  if (encoded.grey) dict.set(name('ColorSpace'), name('DeviceGray'));
  else if (cs.palette) dict.set(name('ColorSpace'), cs.palette.base);
  else dict.set(name('ColorSpace'), original.dict.get(name('ColorSpace')));
  if (facts.decode && !cs.palette && !encoded.grey) dict.set(name('Decode'), ctx.obj(facts.decode));
  dict.set(name('Filter'), name(encoded.filter));
  if (encoded.filter === 'FlateDecode') {
    dict.set(name('DecodeParms'), ctx.obj({ Predictor: 15, Colors: encoded.components, BitsPerComponent: 8, Columns: width }));
  }
  return PDFRawStream.of(dict, encoded.bytes);
}

export { StreamError };
