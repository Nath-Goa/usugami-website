// Small helpers for reading and writing PDF objects with pdf-lib's low-level classes, tolerant of
// the odd values damaged or hand-made PDFs carry (a number where a name should be, a missing
// entry, a reference to nothing).
import {
  PDFName, PDFDict, PDFArray, PDFStream, PDFRef, PDFNumber, PDFString, PDFHexString, PDFBool,
  PDFRawStream, decodePDFRawStream, pdfDocEncodingDecode,
} from '../../lib/pdf-lib.js';

const names = new Map();

/** The PDF name `key` (cached). */
export function N(key) {
  let n = names.get(key);
  if (!n) {
    n = PDFName.of(key);
    names.set(key, n);
  }
  return n;
}

/** `obj` with references followed (a chain of them too, as long as it doesn't loop). */
export function resolve(ctx, obj) {
  for (let i = 0; i < 8 && obj instanceof PDFRef; i++) obj = ctx.lookup(obj);
  return obj instanceof PDFRef ? undefined : obj;
}

/** The value of `key` in `dict` (a dictionary or a stream's), references followed. */
export function get(ctx, dict, key) {
  const d = asDict(dict);
  return d ? resolve(ctx, d.get(N(key))) : undefined;
}

/** A dictionary, a stream's dictionary, or undefined. */
export function asDict(obj) {
  if (obj instanceof PDFDict) return obj;
  if (obj instanceof PDFStream) return obj.dict;
  return undefined;
}

export function getDict(ctx, dict, key) {
  const v = get(ctx, dict, key);
  return v instanceof PDFDict ? v : undefined;
}

export function getArray(ctx, dict, key) {
  const v = get(ctx, dict, key);
  return v instanceof PDFArray ? v : undefined;
}

export function getStream(ctx, dict, key) {
  const v = get(ctx, dict, key);
  return v instanceof PDFStream ? v : undefined;
}

/** A number, or `fallback` when `obj` isn't one. */
export function num(obj, fallback = 0) {
  if (obj instanceof PDFNumber) {
    const n = obj.asNumber();
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function getNum(ctx, dict, key, fallback = 0) {
  return num(get(ctx, dict, key), fallback);
}

/** A name's text without the slash ('Helv'), or undefined. */
export function nameOf(obj) {
  return obj instanceof PDFName ? obj.decodeText() : undefined;
}

export function getName(ctx, dict, key) {
  return nameOf(get(ctx, dict, key));
}

/** The text of a string (PDFDocEncoding or UTF-16), or of a name, or undefined. */
export function textOf(obj) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return obj.decodeText();
    } catch {
      return undefined;
    }
  }
  if (obj instanceof PDFName) return obj.decodeText();
  return undefined;
}

export function getText(ctx, dict, key) {
  return textOf(get(ctx, dict, key));
}

/** A string's raw bytes. */
export function bytesOf(obj) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.asBytes();
  return undefined;
}

export function getBool(ctx, dict, key, fallback = false) {
  const v = get(ctx, dict, key);
  return v instanceof PDFBool ? v.asBoolean() : fallback;
}

/** The numbers of an array (non-numbers become NaN), or undefined. */
export function numbers(ctx, obj) {
  const a = resolve(ctx, obj);
  if (!(a instanceof PDFArray)) return undefined;
  const out = [];
  for (let i = 0; i < a.size(); i++) out.push(num(resolve(ctx, a.get(i)), NaN));
  return out;
}

/** A rectangle as [left, bottom, right, top], normalised; undefined when it isn't four numbers. */
export function rectOf(ctx, obj) {
  const r = numbers(ctx, obj);
  if (!r || r.length < 4 || r.slice(0, 4).some((v) => !Number.isFinite(v))) return undefined;
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/** A matrix [a, b, c, d, e, f]; the identity when missing or malformed. */
export function matrixOf(ctx, obj) {
  const m = numbers(ctx, obj);
  if (!m || m.length < 6 || m.slice(0, 6).some((v) => !Number.isFinite(v))) return [1, 0, 0, 1, 0, 0];
  return m.slice(0, 6);
}

/** The decoded data of a stream, or undefined when its filters can't be undone. */
export function streamData(stream) {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    if (typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
    return stream.getContents();
  } catch {
    return undefined;
  }
}

/** Text kept in a string or a stream (a field's value can be either), as text. */
export function textOrStream(ctx, obj) {
  const v = resolve(ctx, obj);
  const t = textOf(v);
  if (t !== undefined) return t;
  if (v instanceof PDFStream) {
    const data = streamData(v);
    if (!data) return undefined;
    if (data[0] === 0xfe && data[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < data.length; i += 2) s += String.fromCharCode((data[i] << 8) | data[i + 1]);
      return s;
    }
    if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder().decode(data.subarray(3));
    return pdfDocEncodingDecode(data);
  }
  return undefined;
}

/** Latin-1 text of bytes (content streams are bytes; their operators are ASCII). */
export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

/** A number as a content stream writes it: no exponent, at most 4 decimals. */
export function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10000) / 10000;
  if (Math.abs(r) >= 1e9) return String(Math.round(r));
  const s = r.toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** A shallow copy of a dictionary (its values shared, as references or direct objects). */
export function copyDict(ctx, dict) {
  const out = ctx.obj({});
  if (dict) for (const [k, v] of dict.entries()) out.set(k, v);
  return out;
}

/** Sets `key` to `value`, or removes it when value is undefined. */
export function setOrDelete(dict, key, value) {
  if (value === undefined) dict.delete(N(key));
  else dict.set(N(key), value);
}

export { PDFName, PDFDict, PDFArray, PDFStream, PDFRef, PDFNumber, PDFString, PDFHexString, PDFBool };
