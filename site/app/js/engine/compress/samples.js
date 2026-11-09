// An image's samples (its filters undone) read row by row and shrunk on the way by averaging, so a
// big image never needs its full size in memory: 1, 2, 4, 8 or 16 bits a component, any number of
// components, or palette indexes looked up in an Indexed colour space's table.
import { decodeTo } from './filters.js';
import { checkCancelled } from '../../core/errors.js';

/**
 * Reads an image's samples, shrunk to `outWidth` x `outHeight`, as 8 bits a component: each output
 * pixel the average of the source pixels it covers. Component values are scaled from `bpc` bits to
 * 8 (the image's /Decode still applies to them as it did). With `palette`, each sample is an index:
 * `palette.decode` ([dmin, dmax]) maps it, then the table gives the base colour space's components.
 * Resolves to `{ pixels, complete }`; `complete` is false when the data ran out before the last row.
 * @param {object} ctx pdf-lib's PDFContext
 * @param {Uint8Array} data the stream's bytes as stored
 * @param {Array} filters from filtersOf (none of them DCTDecode)
 * @param {{ width: number, height: number, bpc: number, components: number, outWidth: number,
 *   outHeight: number, palette?: { table: Uint8Array, components: number, hival: number, decode?: number[] } }} image
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function readSamples(ctx, data, filters, image, { signal } = {}) {
  const { width, height, bpc, components, outWidth, outHeight, palette } = image;
  const rowBytes = Math.ceil((width * components * bpc) / 8);
  const out = palette ? palette.components : components;
  const values = new Uint8Array(width * out);
  const pixels = new Uint8Array(outWidth * outHeight * out);
  const unpack = unpacker(width, components, bpc, palette, values);
  const same = outWidth === width && outHeight === height;

  // Which output column and row each source column and row falls in, and how many fall in each.
  const columnOf = new Int32Array(width);
  const columns = new Int32Array(outWidth);
  for (let x = 0; x < width; x++) {
    columnOf[x] = Math.min(outWidth - 1, Math.floor((x * outWidth) / width));
    columns[columnOf[x]]++;
  }
  const rowOf = (y) => Math.min(outHeight - 1, Math.floor((y * outHeight) / height));
  const band = same ? null : new Float64Array(outWidth * out);
  let bandRow = 0;
  let bandRows = 0;
  const flush = () => {
    const base = bandRow * outWidth * out;
    for (let x = 0, i = 0; x < outWidth; x++) {
      const n = columns[x] * bandRows;
      for (let c = 0; c < out; c++, i++) {
        pixels[base + i] = n ? Math.round(band[i] / n) : 0;
        band[i] = 0;
      }
    }
    bandRows = 0;
  };

  const row = new Uint8Array(rowBytes);
  let filled = 0;
  let y = 0;
  const takeRow = () => {
    unpack(row);
    if (same) {
      pixels.set(values, y * width * out);
    } else {
      const target = rowOf(y);
      if (target !== bandRow && bandRows) flush();
      bandRow = target;
      for (let x = 0, s = 0; x < width; x++) {
        const d = columnOf[x] * out;
        for (let c = 0; c < out; c++) band[d + c] += values[s++];
      }
      bandRows++;
    }
    y++;
  };
  const sink = {
    push(chunk) {
      let at = 0;
      while (at < chunk.length && y < height) {
        const take = Math.min(rowBytes - filled, chunk.length - at);
        row.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === rowBytes) {
          filled = 0;
          takeRow();
        }
      }
      return y >= height;
    },
  };
  await decodeTo(ctx, data, filters, sink, { signal });
  checkCancelled(signal);
  if (!same && bandRows) flush();
  return { pixels, complete: y >= height };
}

/**
 * A function that turns one row of stored samples into 8-bit component values in `values`
 * (`palette` components a pixel for indexed images, else `components`).
 */
function unpacker(width, components, bpc, palette, values) {
  const count = width * components;
  if (palette) {
    const { table, components: n, hival, decode } = palette;
    const max = (1 << bpc) - 1;
    // Each possible sample's colour, worked out once.
    const colours = new Uint8Array((max + 1) * n);
    for (let v = 0; v <= max; v++) {
      let index = v;
      if (decode) index = Math.round(decode[0] + (v * (decode[1] - decode[0])) / max);
      index = Math.max(0, Math.min(hival, index));
      for (let c = 0; c < n; c++) colours[v * n + c] = table[index * n + c] ?? 0;
    }
    if (bpc === 8) {
      return (row) => {
        for (let x = 0, o = 0; x < width; x++) {
          const at = row[x] * n;
          for (let c = 0; c < n; c++) values[o++] = colours[at + c];
        }
      };
    }
    return (row) => {
      for (let x = 0, o = 0; x < width; x++) {
        const at = sampleAt(row, x, bpc) * n;
        for (let c = 0; c < n; c++) values[o++] = colours[at + c];
      }
    };
  }
  if (bpc === 8) return (row) => values.set(row.subarray(0, count));
  if (bpc === 16) {
    return (row) => {
      for (let k = 0; k < count; k++) values[k] = Math.round(((row[2 * k] << 8) | row[2 * k + 1]) / 257);
    };
  }
  const scale = 255 / ((1 << bpc) - 1);
  return (row) => {
    for (let k = 0; k < count; k++) values[k] = Math.round(sampleAt(row, k, bpc) * scale);
  };
}

/** Sample number `k` of a row of `bpc`-bit samples (most significant bits first). */
function sampleAt(row, k, bpc) {
  const bit = k * bpc;
  return (row[bit >> 3] >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
}
