// Reading PDF streams: the standard filters (Flate, LZW, RunLength, ASCIIHex, ASCII85) and the
// PNG and TIFF predictors, as viewers read them. Flate, the usual last filter, is inflated in
// pieces, so a big image is read a few rows at a time and the page can paint in between; the
// others are small or rare and are read whole. Damaged data gives what could be read, and says so.
import { Inflate } from '../../lib/fflate.js';
import { PDFName, PDFArray, PDFDict, PDFNumber, PDFRef } from '../../lib/pdf-lib.js';
import { checkCancelled } from '../../core/errors.js';
import { pause } from '../images/canvas.js';

/** Short names inline images use, as PDF 32000-1 table 94 lists them. */
const ALIASES = {
  AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode',
  RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode',
};

/** The filters read here (DCTDecode is left to the browser's JPEG decoder). */
export const READABLE = new Set(['FlateDecode', 'LZWDecode', 'RunLengthDecode', 'ASCIIHexDecode', 'ASCII85Decode']);

/** Data that can't be read as its filters say, or that grows past what is allowed. */
export class StreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StreamError';
  }
}

const lookup = (ctx, v) => {
  for (let i = 0; i < 8 && v instanceof PDFRef; i++) v = ctx.lookup(v);
  return v instanceof PDFRef ? undefined : v;
};

/**
 * A stream's filters in the order they are undone, each `{ name, params }`: names written out in
 * full, `params` its /DecodeParms dictionary or undefined. Throws StreamError when /Filter isn't
 * a name or an array of names.
 * @param {object} ctx pdf-lib's PDFContext
 * @param {PDFDict} dict the stream's dictionary
 */
export function filtersOf(ctx, dict) {
  const f = lookup(ctx, dict.get(PDFName.of('Filter')));
  const p = lookup(ctx, dict.get(PDFName.of('DecodeParms')) ?? dict.get(PDFName.of('DP')));
  if (f == null) return [];
  const names = f instanceof PDFArray ? f.asArray().map((v) => lookup(ctx, v)) : [f];
  const params = p instanceof PDFArray ? p.asArray().map((v) => lookup(ctx, v)) : [p];
  return names.map((n, i) => {
    if (!(n instanceof PDFName)) throw new StreamError('Filter is not a name');
    const raw = n.decodeText();
    const param = params[i];
    return { name: ALIASES[raw] ?? raw, params: param instanceof PDFDict ? param : undefined };
  });
}

/** An integer entry of a parameters dictionary, or `fallback`. */
export function paramInt(ctx, params, key, fallback) {
  const v = params ? lookup(ctx, params.get(PDFName.of(key))) : undefined;
  return v instanceof PDFNumber && Number.isFinite(v.asNumber()) ? Math.trunc(v.asNumber()) : fallback;
}

/**
 * Undoes `filters` on `data`, handing the result to `sink` in pieces (`sink.push(chunk)`, which
 * returns true when it has all it wants; each chunk is only good during the call). Resolves to
 * `{ complete }`: false when the data ended early or was damaged (what could be read was pushed).
 * @param {object} ctx pdf-lib's PDFContext (for parameters given by reference)
 * @param {Uint8Array} data the stream's bytes as stored
 * @param {{ name: string, params?: PDFDict }[]} filters from filtersOf, all of them READABLE
 * @param {{ push(chunk: Uint8Array): boolean|void }} sink
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [options] maxBytes: StreamError past this
 *   many bytes before the last filter (a small stream can inflate to gigabytes)
 */
export async function decodeTo(ctx, data, filters, sink, { maxBytes = 1 << 28, signal } = {}) {
  let bytes = data;
  let complete = true;
  // All but the last filter are undone whole: in real files they are ASCII armour around Flate.
  for (let i = 0; i < filters.length - 1; i++) {
    const out = new Collector(maxBytes);
    const r = await decodeOne(ctx, bytes, filters[i], out, signal, maxBytes);
    if (out.overflow) throw new StreamError('Stream too large');
    complete = complete && r.complete;
    bytes = out.result();
  }
  if (!filters.length) {
    sink.push(bytes);
    return { complete };
  }
  const r = await decodeOne(ctx, bytes, filters[filters.length - 1], sink, signal, maxBytes);
  return { complete: complete && r.complete };
}

/**
 * The whole decoded stream as one array, at most `maxBytes` long. Resolves to `{ bytes, complete }`;
 * StreamError when it would be longer.
 */
export async function decodeAll(ctx, data, filters, { maxBytes = 1 << 28, signal } = {}) {
  const out = new Collector(maxBytes);
  const { complete } = await decodeTo(ctx, data, filters, out, { maxBytes, signal });
  if (out.overflow) throw new StreamError('Stream too large');
  return { bytes: out.result(), complete };
}

/** Collects pushed chunks into one array, stopping past `max` bytes. */
class Collector {
  constructor(max) {
    this.max = max;
    this.chunks = [];
    this.size = 0;
    this.overflow = false;
  }

  push(chunk) {
    if (this.size + chunk.length > this.max) {
      this.overflow = true;
      return true;
    }
    this.chunks.push(chunk.slice());
    this.size += chunk.length;
    return false;
  }

  result() {
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

async function decodeOne(ctx, bytes, filter, sink, signal, maxBytes) {
  if (!READABLE.has(filter.name)) throw new StreamError(`Unsupported filter ${filter.name}`);
  const predictor = paramInt(ctx, filter.params, 'Predictor', 1);
  const usesPredictor = (filter.name === 'FlateDecode' || filter.name === 'LZWDecode') && predictor > 1;
  const target = usesPredictor ? predictorSink(ctx, filter.params, sink) : sink;
  let complete;
  switch (filter.name) {
    case 'FlateDecode':
      complete = (await inflateTo(bytes, target, signal)).complete;
      break;
    case 'LZWDecode': {
      const r = lzwDecode(bytes, paramInt(ctx, filter.params, 'EarlyChange', 1) !== 0, maxBytes);
      await pushInSlices(target, r.bytes, signal);
      complete = r.complete;
      break;
    }
    case 'RunLengthDecode': {
      const r = runLengthDecode(bytes, maxBytes);
      await pushInSlices(target, r.bytes, signal);
      complete = r.complete;
      break;
    }
    case 'ASCIIHexDecode':
      await pushInSlices(target, asciiHexDecode(bytes), signal);
      complete = true;
      break;
    default: {
      const r = ascii85Decode(bytes);
      await pushInSlices(target, r.bytes, signal);
      complete = r.complete;
    }
  }
  if (usesPredictor) complete = target.finish() && complete;
  return { complete };
}

/** Passes `bytes` on in pieces, pausing for the browser between them now and then. */
async function pushInSlices(sink, bytes, signal) {
  const slice = 1 << 18;
  let started = performance.now();
  for (let at = 0; at < bytes.length; at += slice) {
    if (sink.push(bytes.subarray(at, Math.min(bytes.length, at + slice)))) return;
    if (performance.now() - started > 24) {
      checkCancelled(signal);
      await pause();
      checkCancelled(signal);
      started = performance.now();
    }
  }
}

/**
 * Inflates zlib (or, as some writers store it, raw deflate) data in pieces, pausing for the browser
 * every ~24 ms. Resolves to `{ complete }`: whether the deflate data reached its last block.
 */
export async function inflateTo(bytes, sink, signal) {
  let body = bytes;
  if (bytes.length >= 2 && (bytes[0] & 0x0f) === 8 && (bytes[0] >> 4) <= 7 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) {
    // A preset dictionary (FDICT) isn't something PDF writers use: such data can't be read.
    if (bytes[1] & 0x20) return { complete: false };
    body = bytes.subarray(2);
  }
  let stopped = false;
  let ended = false;
  const inflater = new Inflate();
  inflater.ondata = (chunk, final) => {
    if (final) ended = true;
    if (!stopped && chunk.length && sink.push(chunk)) stopped = true;
  };
  const slice = 1 << 15;
  let started = performance.now();
  try {
    for (let at = 0; at < body.length && !stopped && !ended; at += slice) {
      inflater.push(body.subarray(at, Math.min(body.length, at + slice)), false);
      if (performance.now() - started > 24) {
        checkCancelled(signal);
        await pause();
        checkCancelled(signal);
        started = performance.now();
      }
    }
    if (!stopped && !ended) inflater.push(new Uint8Array(0), true);
  } catch (e) {
    if (e?.name === 'CancelledError') throw e;
    // Damaged or cut short: what was inflated has been passed on.
  }
  return { complete: ended || stopped };
}

/**
 * LZW as PDF uses it (codes of 9 to 12 bits, 256 clears the table, 257 ends; with `earlyChange`
 * the code length grows one code early, the default). Stops after `max` bytes. Returns
 * `{ bytes, complete }`.
 */
export function lzwDecode(data, earlyChange = true, max = Infinity) {
  const early = earlyChange ? 1 : 0;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Int32Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }
  // Grown as needed, so a big stream doesn't take three times its size before anything is read.
  let out = new Uint8Array(Math.max(1024, Math.min(data.length * 3, 1 << 24)));
  let size = 0;
  const ensure = (n) => {
    if (size + n <= out.length) return;
    let cap = out.length * 2;
    while (cap < size + n) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, size));
    out = bigger;
  };
  const emit = (code) => {
    const n = length[code];
    ensure(n);
    for (let i = size + n - 1, c = code; i >= size; i--, c = prefix[c]) out[i] = suffix[c];
    size += n;
  };
  let next = 258;
  let bits = 9;
  let previous = -1;
  let buffer = 0;
  let count = 0;
  let pos = 0;
  let complete = false;
  for (;;) {
    while (count < bits && pos < data.length) {
      buffer = ((buffer << 8) | data[pos++]) >>> 0;
      count += 8;
    }
    if (count < bits || size > max) break;
    const code = (buffer >>> (count - bits)) & ((1 << bits) - 1);
    count -= bits;
    buffer &= (1 << count) - 1;
    if (code === 256) {
      next = 258;
      bits = 9;
      previous = -1;
      continue;
    }
    if (code === 257) {
      complete = true;
      break;
    }
    if (previous < 0) {
      if (code > 255) break;
      emit(code);
      previous = code;
      continue;
    }
    let head;
    let unseen = false;
    if (code < next) {
      emit(code);
      head = first[code];
    } else if (code === next && next < 4096) {
      // A code used in the step that makes it (the string before it plus its own first byte).
      head = first[previous];
      unseen = true;
    } else {
      break;
    }
    if (next < 4096) {
      prefix[next] = previous;
      suffix[next] = head;
      first[next] = first[previous];
      length[next] = length[previous] + 1;
      next++;
    }
    if (unseen) emit(code);
    previous = code;
    if (next + early >= (1 << bits) && bits < 12) bits++;
  }
  return { bytes: out.slice(0, size), complete };
}

/**
 * RunLengthDecode: a length byte, then that many bytes plus one, or one byte repeated 257 − length
 * times; 128 ends. Stops after `max` bytes.
 */
export function runLengthDecode(data, max = Infinity) {
  let size = 0;
  let i = 0;
  let complete = false;
  let out = new Uint8Array(Math.max(1024, data.length * 2));
  const ensure = (n) => {
    if (size + n <= out.length) return;
    let cap = out.length * 2;
    while (cap < size + n) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, size));
    out = bigger;
  };
  while (i < data.length && size <= max) {
    const n = data[i++];
    if (n === 128) {
      complete = true;
      break;
    }
    if (n < 128) {
      const end = Math.min(data.length, i + n + 1);
      ensure(end - i);
      out.set(data.subarray(i, end), size);
      size += end - i;
      i = end;
    } else {
      if (i >= data.length) break;
      const count = 257 - n;
      ensure(count);
      out.fill(data[i++], size, size + count);
      size += count;
    }
  }
  return { bytes: out.slice(0, size), complete: complete || i >= data.length };
}

const isSpace = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

/** ASCIIHexDecode: pairs of hex digits up to '>', white space ignored, a lone last digit followed by 0. */
export function asciiHexDecode(data) {
  const out = new Uint8Array((data.length >> 1) + 1);
  let size = 0;
  let high = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break;
    let v;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
    else continue;
    if (high < 0) high = v;
    else {
      out[size++] = (high << 4) | v;
      high = -1;
    }
  }
  if (high >= 0) out[size++] = high << 4;
  return out.slice(0, size);
}

/** ASCII85Decode: groups of five characters '!' to 'u' for four bytes, 'z' for four zeros, up to '~>'. */
export function ascii85Decode(data) {
  const out = new Uint8Array(Math.ceil((data.length * 4) / 5) + 8);
  let size = 0;
  const group = new Array(5);
  let n = 0;
  let complete = false;
  let i = 0;
  // An optional "<~" opening, as some writers put it.
  while (i < data.length && isSpace(data[i])) i++;
  if (data[i] === 0x3c && data[i + 1] === 0x7e) i += 2;
  for (; i < data.length; i++) {
    const c = data[i];
    if (isSpace(c)) continue;
    if (c === 0x7e) {
      complete = true;
      break;
    }
    if (c === 0x7a && n === 0) {
      size += 4; // already zeros
      continue;
    }
    if (c < 0x21 || c > 0x75) break;
    group[n++] = c - 0x21;
    if (n === 5) {
      let v = 0;
      for (let k = 0; k < 5; k++) v = v * 85 + group[k];
      out[size++] = (v >>> 24) & 0xff;
      out[size++] = (v >>> 16) & 0xff;
      out[size++] = (v >>> 8) & 0xff;
      out[size++] = v & 0xff;
      n = 0;
    }
  }
  if (n > 1) {
    for (let k = n; k < 5; k++) group[k] = 84;
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + group[k];
    for (let k = 0; k < n - 1; k++) out[size++] = (v >>> (24 - 8 * k)) & 0xff;
  }
  return { bytes: out.slice(0, size), complete: complete || i >= data.length };
}

/**
 * A sink that undoes a PNG (Predictor 10 to 15) or TIFF (Predictor 2) predictor on what is pushed
 * into it before passing whole rows on to `sink`. Its finish() says whether the data ended at the
 * end of a row.
 */
export function predictorSink(ctx, params, sink) {
  const predictor = paramInt(ctx, params, 'Predictor', 1);
  const colors = paramInt(ctx, params, 'Colors', 1);
  const bpc = paramInt(ctx, params, 'BitsPerComponent', 8);
  const columns = paramInt(ctx, params, 'Columns', 1);
  if (!(colors >= 1 && colors <= 32) || ![1, 2, 4, 8, 16].includes(bpc) || !(columns >= 1) || columns * colors * bpc > 8 * (1 << 27)) {
    throw new StreamError('Bad predictor parameters');
  }
  if (predictor !== 2 && predictor < 10) throw new StreamError(`Unknown predictor ${predictor}`);
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const png = predictor >= 10;
  const inRow = png ? rowBytes + 1 : rowBytes;
  const pending = new Uint8Array(inRow);
  let filled = 0;
  let prior = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  let stopped = false;
  const row = () => {
    if (png) {
      unfilterPng(pending[0], pending.subarray(1), prior, current, bpp);
    } else {
      current.set(pending);
      undoTiff(current, colors, bpc, columns);
    }
    if (sink.push(current)) stopped = true;
    const swap = prior;
    prior = current;
    current = swap;
  };
  return {
    push(chunk) {
      let at = 0;
      while (at < chunk.length && !stopped) {
        const take = Math.min(inRow - filled, chunk.length - at);
        pending.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === inRow) {
          filled = 0;
          row();
        }
      }
      return stopped;
    },
    finish() {
      return filled === 0;
    },
  };
}

/** Undoes one PNG filter (`type` 0 to 4) of row `raw` into `out`, `prior` being the row above. */
export function unfilterPng(type, raw, prior, out, bpp) {
  const n = raw.length;
  switch (type) {
    case 0:
      out.set(raw);
      break;
    case 1:
      for (let i = 0; i < n; i++) out[i] = (raw[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) out[i] = (raw[i] + prior[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < n; i++) out[i] = (raw[i] + (((i >= bpp ? out[i - bpp] : 0) + prior[i]) >> 1)) & 0xff;
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? out[i - bpp] : 0;
        const b = prior[i];
        const c = i >= bpp ? prior[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        out[i] = (raw[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      break;
    default:
      throw new StreamError(`Unknown PNG filter ${type}`);
  }
}

/** Undoes TIFF predictor 2 in place: each sample is stored as its difference from the one to its left. */
export function undoTiff(row, colors, bpc, columns) {
  if (bpc === 8) {
    for (let i = colors; i < columns * colors; i++) row[i] = (row[i] + row[i - colors]) & 0xff;
    return;
  }
  if (bpc === 16) {
    for (let i = colors; i < columns * colors; i++) {
      const at = i * 2;
      const prev = (row[at - 2 * colors] << 8) | row[at - 2 * colors + 1];
      const v = (((row[at] << 8) | row[at + 1]) + prev) & 0xffff;
      row[at] = v >> 8;
      row[at + 1] = v & 0xff;
    }
    return;
  }
  const mask = (1 << bpc) - 1;
  const get = (k) => (row[(k * bpc) >> 3] >> (8 - bpc - ((k * bpc) & 7))) & mask;
  const set = (k, v) => {
    const byte = (k * bpc) >> 3;
    const shift = 8 - bpc - ((k * bpc) & 7);
    row[byte] = (row[byte] & ~(mask << shift)) | ((v & mask) << shift);
  };
  for (let k = colors; k < columns * colors; k++) set(k, get(k) + get(k - colors));
}
