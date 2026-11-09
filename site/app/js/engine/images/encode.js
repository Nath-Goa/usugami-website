// Image encoders for PDF image XObjects: JPEG in colour (the browser's encoder, as the app uses
// Android's) and in grey (one 8-bit component, so a PDF stores it as DeviceGray: the app's
// GrayJpeg.kt), and lossless Flate with PNG row filters (RasterEncoder.kt).
import { zlibSync } from '../../lib/fflate.js';
import { BitWriter } from './bit-writer.js';
import { stripJpeg } from './jpeg.js';
import {
  newCanvas, context2d, isImageData, sourceSize, imageDataToCanvas, canvasToBlob, toImageData, runSync, runAsync,
} from './canvas.js';

/**
 * Encodes a picture as JPEG, transparency flattened onto white, without metadata.
 * @param {ImageData|HTMLCanvasElement|OffscreenCanvas|ImageBitmap|HTMLImageElement|{ width, height, pixels: Uint8Array }} source
 *   the last form is a grey picture, a byte a pixel
 * @param {{ quality?: number, gray?: boolean, signal?: AbortSignal }} [options] quality 1 to 100
 *   (as Android's Bitmap.compress, default 75); gray: a one-component JPEG (DeviceGray in a PDF),
 *   the picture's brightness taken as (77 R + 150 G + 29 B) / 256 on white, made pausing for the
 *   browser now and then (and stopping with CancelledError when `signal` is aborted)
 * @returns {Promise<Uint8Array>}
 */
export async function encodeJpeg(source, { quality = 75, gray = false, signal } = {}) {
  const q = Math.round(quality);
  if (!(q >= 1 && q <= 100)) throw new RangeError(`Quality ${quality}`);
  if (source && source.pixels instanceof Uint8Array && !source.data) {
    if (gray) return runAsync(grayJpegGen(source, q), { signal });
    source = grayToImageData(source);
  }
  if (gray) return runAsync(grayJpegGen(grayOf(toImageData(source)), q), { signal });
  const { width, height } = sourceSize(source);
  const canvas = newCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  // ImageData replaces pixels rather than drawing over them, so it goes through a canvas of its own.
  ctx.drawImage(isImageData(source) ? imageDataToCanvas(source) : source, 0, 0);
  const blob = await canvasToBlob(canvas, 'image/jpeg', q / 100);
  return stripJpeg(new Uint8Array(await blob.arrayBuffer()));
}

/** A grey picture's pixels as opaque RGBA ImageData. */
function grayToImageData({ width, height, pixels }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < pixels.length; p++, i += 4) {
    data[i] = data[i + 1] = data[i + 2] = pixels[p];
    data[i + 3] = 255;
  }
  return new ImageData(data, width, height);
}

/** The brightness of each pixel of RGBA `imageData`, flattened onto white: { width, height, pixels }. */
export function grayOf(imageData) {
  const { width, height, data } = imageData;
  const pixels = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < pixels.length; p++, i += 4) {
    const a = data[i + 3];
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (a !== 255) {
      r = Math.trunc((r * a + 255 * (255 - a) + 127) / 255);
      g = Math.trunc((g * a + 255 * (255 - a) + 127) / 255);
      b = Math.trunc((b * a + 255 * (255 - a) + 127) / 255);
    }
    pixels[p] = (r * 77 + g * 150 + b * 29) >> 8;
  }
  return { width, height, pixels };
}

// ---- Grey JPEG ----

/** The natural position of each coefficient in zigzag order. */
const ZIGZAG = Int32Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** The JPEG standard's luminance quantization table (Annex K.1), natural order. */
const LUMINANCE = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

/** C(u) cos((2x + 1) u π / 16), C(0) = 1 / √2 and 1 otherwise. */
const COS = Float64Array.from({ length: 64 }, (_, i) => {
  const u = Math.floor(i / 8);
  const x = i % 8;
  return (u === 0 ? 1 / Math.sqrt(2) : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
});

/** The standard luminance table scaled for `quality` as libjpeg does, in natural order. */
export function quantization(quality) {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - 2 * quality;
  return Int32Array.from(LUMINANCE, (v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/**
 * Baseline JPEG of a grey picture: one 8-bit component, the standard luminance table scaled for
 * `quality` as libjpeg scales it (so it means what it does for colour JPEGs), and Huffman tables
 * made for the picture (as libjpeg's optimize_coding makes them); no metadata.
 * @param {{ width: number, height: number, pixels: Uint8Array }} image a byte a pixel, 0 black
 * @param {number} quality 1 to 100
 * @returns {Uint8Array}
 */
export function encodeGrayJpeg(image, quality) {
  return runSync(grayJpegGen(image, quality));
}

/** encodeGrayJpeg as a generator that yields every 8 rows of blocks (see canvas.js runAsync). */
export function* grayJpegGen(image, quality) {
  const { width, height, pixels } = image;
  if (!(quality >= 1 && quality <= 100)) throw new RangeError(`Quality ${quality}`);
  if (!(width > 0 && height > 0) || width > 65535 || height > 65535) throw new RangeError(`A JPEG can't be ${width} x ${height}`);
  const table = quantization(quality);
  // What each DCT coefficient is divided by, in natural order, with the DCT's own scale in it.
  const divisors = Float64Array.from(table, (v) => v * 4);
  const blocksAcross = (width + 7) >> 3;
  const blocksDown = (height + 7) >> 3;
  // Every block's coefficients, in zigzag order: the Huffman tables are made from all of them
  // before any is written.
  const coefficients = new Int16Array(blocksAcross * blocksDown * 64);
  const block = new Float64Array(64);
  const temp = new Float64Array(64);
  for (let by = 0; by < blocksDown; by++) {
    if ((by & 7) === 0) yield;
    for (let bx = 0; bx < blocksAcross; bx++) {
      // The block's pixels, centred on 0; the edge's pixels repeat past the picture.
      for (let v = 0; v < 8; v++) {
        const y = Math.min(by * 8 + v, height - 1) * width;
        for (let u = 0; u < 8; u++) {
          const x = Math.min(bx * 8 + u, width - 1);
          block[v * 8 + u] = pixels[y + x] - 128;
        }
      }
      forwardDct(block, temp);
      const start = (by * blocksAcross + bx) * 64;
      for (let k = 0; k < 64; k++) {
        const natural = ZIGZAG[k];
        coefficients[start + k] = Math.round(block[natural] / divisors[natural]);
      }
    }
  }
  yield;
  const dcCounts = new Int32Array(257);
  const acCounts = new Int32Array(257);
  forEachSymbol(coefficients, (s) => { dcCounts[s]++; }, (s) => { acCounts[s]++; }, null);
  const dc = optimalHuffmanTable(dcCounts);
  const ac = optimalHuffmanTable(acCounts);
  yield;
  const out = new BitWriter(Math.max(4096, (width * height) >> 3));
  forEachSymbol(
    coefficients,
    (s) => out.write(dc.codes[s], dc.lengths[s]),
    (s) => out.write(ac.codes[s], ac.lengths[s]),
    (bits, size) => out.write(bits, size),
  );
  const data = stuffed(out.finish(true));
  const head = header(width, height, table, dc, ac);
  const jpeg = new Uint8Array(head.length + data.length + 2);
  jpeg.set(head, 0);
  jpeg.set(data, head.length);
  jpeg[jpeg.length - 2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;
  return jpeg;
}

/** The number of bits `value`'s magnitude needs (its JPEG category). */
const magnitude = (value) => 32 - Math.clz32(value < 0 ? -value : value);

/** `value`'s `size` bits as JPEG writes them: negative values as their one's complement. */
const amplitude = (value, size) => (value >= 0 ? value : (value - 1) & ((1 << size) - 1));

/**
 * Goes through the Huffman symbols the blocks are coded with, in order: each block's DC difference's
 * size (dc), then its AC coefficients' run and size, 16 zeros (0xF0) and the end of the block (0x00)
 * (ac), and the bits that follow a symbol (extra, when given).
 */
function forEachSymbol(coefficients, dc, ac, extra) {
  let previousDc = 0;
  for (let start = 0; start < coefficients.length; start += 64) {
    const value = coefficients[start];
    const difference = value - previousDc;
    previousDc = value;
    const size = magnitude(difference);
    dc(size);
    if (extra && size > 0) extra(amplitude(difference, size), size);
    let zeros = 0;
    for (let k = 1; k < 64; k++) {
      const c = coefficients[start + k];
      if (c === 0) {
        zeros++;
        continue;
      }
      while (zeros >= 16) {
        ac(0xf0);
        zeros -= 16;
      }
      const s = magnitude(c);
      ac((zeros << 4) | s);
      if (extra) extra(amplitude(c, s), s);
      zeros = 0;
    }
    if (zeros > 0) ac(0x00);
  }
}

/** SOI, DQT, SOF0, DHT (DC and AC) and SOS for one component. */
function header(width, height, table, dc, ac) {
  const parts = [[0xff, 0xd8]];
  const marker = (type, body) => parts.push([0xff, type, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
  marker(0xdb, Array.from({ length: 65 }, (_, i) => (i === 0 ? 0 : table[ZIGZAG[i - 1]])));
  marker(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  marker(0xc4, [0x00, ...dc.definition(), 0x10, ...ac.definition()]);
  marker(0xda, [1, 1, 0, 0, 63, 0]);
  return Uint8Array.from(parts.flat());
}

/** A 0xFF byte in the coded data is followed by 0x00, so it can't be taken for a marker. */
function stuffed(data) {
  let extra = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0xff) extra++;
  if (extra === 0) return data;
  const out = new Uint8Array(data.length + extra);
  let j = 0;
  for (let i = 0; i < data.length; i++) {
    out[j++] = data[i];
    if (data[i] === 0xff) out[j++] = 0;
  }
  return out;
}

/** The 8 x 8 DCT of `block` (row after row), in place: 4 times the JPEG coefficient. */
function forwardDct(block, temp) {
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * COS[u * 8 + x];
      temp[y * 8 + u] = sum;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += temp[y * 8 + x] * COS[v * 8 + y];
      block[v * 8 + x] = sum;
    }
  }
}

/**
 * A JPEG Huffman table: how many codes there are of each length 1 to 16 (counts), the symbols in
 * code order (symbols), and each symbol's code and its length (JPEG Annex C).
 */
export function huffmanTable(counts, symbols) {
  const codes = new Int32Array(256);
  const lengths = new Int32Array(256);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let n = 0; n < counts[length - 1]; n++) {
      codes[symbols[k]] = code;
      lengths[symbols[k]] = length;
      code++;
      k++;
    }
    code <<= 1;
  }
  return {
    counts,
    symbols,
    codes,
    lengths,
    /** The table as a DHT segment gives it, after its class and number. */
    definition: () => [...counts, ...symbols],
  };
}

/**
 * The best table for symbols used frequency[s] times each (indexes 0 to 255; index 256 must be 0),
 * with no code longer than 16 bits and none all ones: libjpeg's jpeg_gen_optimal_table (Annex K.2).
 */
export function optimalHuffmanTable(frequency) {
  const freq = new Float64Array(257);
  for (let i = 0; i < Math.min(257, frequency.length); i++) freq[i] = frequency[i];
  // A symbol no one uses keeps every real code from being all ones.
  freq[256] = 1;
  const size = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);
  for (;;) {
    // The two least frequent symbols left (the later of equals first).
    let c1 = -1;
    let v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] !== 0 && freq[i] <= v) { v = freq[i]; c1 = i; }
    let c2 = -1;
    v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] !== 0 && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
    if (c2 < 0) break;
    freq[c1] += freq[c2];
    freq[c2] = 0;
    size[c1]++;
    while (others[c1] >= 0) {
      c1 = others[c1];
      size[c1]++;
    }
    others[c1] = c2;
    size[c2]++;
    while (others[c2] >= 0) {
      c2 = others[c2];
      size[c2]++;
    }
  }
  const bits = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (size[i] > 0) bits[size[i]]++;
  // Codes longer than 16 bits moved up the tree.
  for (let i = 32; i >= 17; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  // The made-up symbol's code goes.
  let longest = 16;
  while (bits[longest] === 0) longest--;
  bits[longest]--;
  const symbols = [];
  for (let length = 1; length <= 32; length++) for (let symbol = 0; symbol <= 255; symbol++) if (size[symbol] === length) symbols.push(symbol);
  return huffmanTable(Array.from({ length: 16 }, (_, i) => bits[i + 1]), symbols);
}

// ---- Lossless Flate ----

/** Whether every pixel of RGBA `data`, once flattened onto white, is a shade of grey. */
export function isGray(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) {
      if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) return false;
    } else {
      const r = Math.trunc((d[i] * a + 255 * (255 - a) + 127) / 255);
      if (r !== Math.trunc((d[i + 1] * a + 255 * (255 - a) + 127) / 255) || r !== Math.trunc((d[i + 2] * a + 255 * (255 - a) + 127) / 255)) return false;
    }
  }
  return true;
}

/**
 * The FlateDecode stream body for RGBA `imageData` flattened onto white, as grey (one byte a pixel,
 * the red channel) or RGB, through the PNG row filters. The image dictionary needs
 * /DecodeParms << /Predictor 15 /Colors (1|3) /BitsPerComponent 8 /Columns width >>.
 */
export function flateRaster(imageData, gray) {
  const { width, height, data } = imageData;
  const bpp = gray ? 1 : 3;
  const rowBytes = width * bpp;
  const filtered = new Uint8Array((rowBytes + 1) * height);
  let previous = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
  const flat = (v, a) => (a === 255 ? v : Math.trunc((v * a + 255 * (255 - a) + 127) / 255));
  for (let y = 0; y < height; y++) {
    let i = y * width * 4;
    if (gray) {
      for (let x = 0; x < width; x++, i += 4) current[x] = flat(data[i], data[i + 3]);
    } else {
      for (let x = 0, j = 0; x < width; x++, i += 4) {
        const a = data[i + 3];
        current[j++] = flat(data[i], a);
        current[j++] = flat(data[i + 1], a);
        current[j++] = flat(data[i + 2], a);
      }
    }
    const filter = filterRow(current, previous, bpp, candidates);
    const at = y * (rowBytes + 1);
    filtered[at] = filter;
    filtered.set(candidates[filter], at + 1);
    const swap = previous;
    previous = current;
    current = swap;
  }
  return zlibSync(filtered, { level: 6 });
}

/**
 * The FlateDecode stream body for a black-and-white BitImage, its rows as they are (a bit a pixel)
 * through the PNG filters. The image dictionary needs /DecodeParms << /Predictor 15 /Colors 1
 * /BitsPerComponent 1 /Columns width >>.
 */
export function flateBits(image) {
  const { rowBytes, height, data } = image;
  const filtered = new Uint8Array((rowBytes + 1) * height);
  let previous = new Uint8Array(rowBytes);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
  for (let y = 0; y < height; y++) {
    const current = data.subarray(y * rowBytes, (y + 1) * rowBytes);
    const filter = filterRow(current, previous, 1, candidates);
    const at = y * (rowBytes + 1);
    filtered[at] = filter;
    filtered.set(candidates[filter], at + 1);
    previous = current;
  }
  return zlibSync(filtered, { level: 9 });
}

/**
 * Fills `candidates` with the row under each PNG filter (None, Sub, Up, Average, Paeth) and returns
 * the one with the smallest sum of absolute values (the libpng heuristic).
 */
export function filterRow(row, prior, bpp, candidates) {
  const [none, sub, up, avg, paeth] = candidates;
  let sumNone = 0;
  let sumSub = 0;
  let sumUp = 0;
  let sumAvg = 0;
  let sumPaeth = 0;
  // A byte's distance from 0 as a signed byte.
  const signed = (v) => (v & 0x80 ? 256 - (v & 0xff) : v & 0xff);
  for (let i = 0; i < row.length; i++) {
    const x = row[i];
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prior[i];
    const c = i >= bpp ? prior[i - bpp] : 0;
    const vNone = x;
    const vSub = (x - a) & 0xff;
    const vUp = (x - b) & 0xff;
    const vAvg = (x - ((a + b) >>> 1)) & 0xff;
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    const vPaeth = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    none[i] = vNone;
    sub[i] = vSub;
    up[i] = vUp;
    avg[i] = vAvg;
    paeth[i] = vPaeth;
    sumNone += signed(vNone);
    sumSub += signed(vSub);
    sumUp += signed(vUp);
    sumAvg += signed(vAvg);
    sumPaeth += signed(vPaeth);
  }
  let best = 0;
  let bestSum = sumNone;
  if (sumSub < bestSum) { best = 1; bestSum = sumSub; }
  if (sumUp < bestSum) { best = 2; bestSum = sumUp; }
  if (sumAvg < bestSum) { best = 3; bestSum = sumAvg; }
  if (sumPaeth < bestSum) best = 4;
  return best;
}
