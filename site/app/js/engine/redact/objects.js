// Small helpers for reading a PDF's objects with pdf-lib, the way the app reads them with PDFBox:
// references resolved, strings decoded, nothing thrown for objects of an unexpected kind.
import {
  PDFName, PDFRef, PDFDict, PDFArray, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFNumber,
  decodePDFRawStream,
} from '../../lib/pdf-lib.js';

export const N = (name) => PDFName.of(name);

/** `obj` with a reference followed (only one level: pdf-lib never stores a reference to a reference). */
export function resolve(ctx, obj) {
  return obj instanceof PDFRef ? ctx.lookup(obj) : obj;
}

/** dict[key] resolved, or undefined. */
export function get(dict, key) {
  if (!(dict instanceof PDFDict)) return undefined;
  try {
    return dict.lookup(N(key));
  } catch {
    return undefined;
  }
}

export const isDict = (o) => o instanceof PDFDict;
export const isArray = (o) => o instanceof PDFArray;
export const isStream = (o) => o instanceof PDFStream;

export function getDict(dict, key) {
  const v = get(dict, key);
  return v instanceof PDFDict ? v : null;
}

/** A dictionary, or the dictionary of a stream. */
export function dictOf(obj) {
  if (obj instanceof PDFStream) return obj.dict;
  return obj instanceof PDFDict ? obj : null;
}

export function getArray(dict, key) {
  const v = get(dict, key);
  return v instanceof PDFArray ? v : null;
}

/** The name dict[key] is, without its slash, or null. */
export function getName(dict, key) {
  const v = get(dict, key);
  return v instanceof PDFName ? nameOf(v) : null;
}

export function nameOf(name) {
  try {
    return name.decodeText();
  } catch {
    return name.asString().slice(1);
  }
}

export function getNumber(dict, key, fallback = undefined) {
  const v = get(dict, key);
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

/** A PDF text string's text, or null if `obj` isn't a string. */
export function textOf(obj) {
  if (!(obj instanceof PDFString || obj instanceof PDFHexString)) return null;
  try {
    return obj.decodeText();
  } catch {
    return null;
  }
}

/** The string dict[key] says, or null (PDFBox's getString). */
export function getString(dict, key) {
  return textOf(get(dict, key));
}

/** The numbers of an array, or null if it isn't one of `count` numbers. */
export function numbers(ctx, array, count) {
  const a = resolve(ctx, array);
  if (!(a instanceof PDFArray) || (count != null && a.size() !== count)) return null;
  const out = [];
  for (let i = 0; i < a.size(); i++) {
    const v = resolve(ctx, a.get(i));
    if (!(v instanceof PDFNumber)) return null;
    out.push(v.asNumber());
  }
  return out.every(Number.isFinite) ? out : null;
}

/** The items of an array, resolved. */
export function items(ctx, array) {
  const a = resolve(ctx, array);
  if (!(a instanceof PDFArray)) return [];
  const out = [];
  for (let i = 0; i < a.size(); i++) out.push(resolve(ctx, a.get(i)));
  return out;
}

/** A stream's decoded bytes; throws if its filters can't be undone. */
export function streamBytes(stream) {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  // Streams pdf-lib made itself (content streams, flate streams).
  if (typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
  return stream.getContents();
}

/** A page attribute that may be inherited from the page tree (MediaBox, CropBox, Rotate, Resources). */
export function inherited(ctx, node, key) {
  let current = node;
  for (let depth = 0; current instanceof PDFDict && depth < 64; depth++) {
    const v = get(current, key);
    if (v !== undefined) return v;
    current = get(current, 'Parent');
  }
  return undefined;
}

/**
 * A page's crop box as viewers show it, and its turn, worked out as pdf.js does: the media box
 * (US Letter if it has none), the crop box cut to it, and /Rotate a multiple of 90 or else 0.
 * Returns { view: [x0, y0, x1, y1], rotate }.
 */
export function pageView(ctx, node) {
  const rect = (key) => {
    const r = numbers(ctx, inherited(ctx, node, key), 4);
    if (!r) return null;
    const box = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null;
  };
  const media = rect('MediaBox') ?? [0, 0, 612, 792];
  const crop = rect('CropBox') ?? media;
  let view = media;
  const cut = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])];
  if (cut[2] - cut[0] > 0 && cut[3] - cut[1] > 0) view = cut;
  const r = resolve(ctx, inherited(ctx, node, 'Rotate'));
  let rotate = r instanceof PDFNumber ? r.asNumber() : 0;
  if (!Number.isFinite(rotate) || rotate % 90 !== 0) rotate = 0;
  rotate = ((rotate % 360) + 360) % 360;
  return { view, rotate, media };
}


export { PDFName, PDFRef, PDFDict, PDFArray, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFNumber };
