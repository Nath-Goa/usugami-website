// Redacted pages as pictures (the app's Redactor.replaceWithPicture and encode): each page with
// boxes is drawn at 200 dpi, as viewers show it (its comments and filled-in fields included), the
// boxes are painted solid black into the picture, and the page's content is replaced by it.
import { pdfjsLib } from '../../lib/pdfjs.js';
import { zlibSync } from '../../lib/fflate.js';
import { checkCancelled } from '../../core/errors.js';
import { yieldToUI } from '../../core/dom.js';
import { N, pageView, PDFNumber } from './objects.js';
import { pixelSize, pixelBounds } from './boxes.js';

const { AnnotationMode } = pdfjsLib;

/** JPEG quality for pages that are mostly photographs. */
const JPEG_QUALITY = 0.9;

/**
 * Pages are kept lossless (PNG-style) unless that takes more than this many times the space of a
 * JPEG: text and line art then stay perfectly crisp, while scans and photos use JPEG.
 */
const LOSSLESS_ALLOWANCE = 1.5;

/** What a redacted page keeps besides its size, turn, picture and parent: the other page boxes and its unit. */
const KEPT_PAGE_KEYS = ['Type', 'Parent', 'BleedBox', 'TrimBox', 'ArtBox', 'UserUnit'];

/** A canvas of `width` × `height` pixels, offscreen where the browser can. */
export function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Frees a canvas's memory now rather than when it is collected. */
export function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Draws `page` (a pdf.js page) as shown, exactly `width` × `height` pixels, on white, with its
 * annotations' appearances, as viewers show them, into `canvas` (a new one by default).
 * Cancelled with `signal`.
 */
export async function renderShown(page, frame, width, height, signal, canvas = makeCanvas(width, height)) {
  // With an alpha channel, so text is smoothed in grey: an opaque canvas may smooth it in colour.
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  // Exactly as big as the page is, so boxes placed on the page itself are over what they hide.
  const viewport = page.getViewport({ scale: 1 / (page.userUnit || 1) });
  const task = page.render({
    canvasContext: context,
    canvas,
    viewport,
    transform: [width / frame.shownWidth, 0, 0, height / frame.shownHeight, 0, 0],
    intent: 'display',
    annotationMode: AnnotationMode.ENABLE,
    background: '#ffffff',
  });
  const abort = () => task.cancel();
  signal?.addEventListener('abort', abort);
  try {
    await task.promise;
  } catch (e) {
    releaseCanvas(canvas);
    checkCancelled(signal);
    throw e;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return { canvas, context };
}

/** Draws `page` with `boxes` solid black: { canvas, context, width, height }. */
export async function renderRedacted(page, frame, boxes, signal) {
  const [width, height] = pixelSize(frame.shownWidth, frame.shownHeight);
  const { canvas, context } = await renderShown(page, frame, width, height, signal);
  // Whole pixels, without smoothing: every pixel a box touches is fully black.
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = '#000000';
  for (const box of boxes) {
    const [left, top, right, bottom] = pixelBounds(box, width, height);
    if (right > left && bottom > top) context.fillRect(left, top, right - left, bottom - top);
  }
  return { canvas, context, width, height };
}

async function toJpeg(canvas) {
  const blob = typeof canvas.convertToBlob === 'function'
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    : await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No JPEG'))), 'image/jpeg', JPEG_QUALITY));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Whether every pixel is a shade of grey (the picture is opaque). */
function isGray(data, signal) {
  for (let i = 0, row = 0; i < data.length; i += 4) {
    if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) return false;
    if ((++row & 0xFFFFF) === 0) checkCancelled(signal);
  }
  return true;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const signedAbs = (v) => {
  const b = v & 0xFF;
  return b < 128 ? b : 256 - b;
};

/**
 * One row through the PNG filter that leaves the smallest sum of values (as the app's
 * RasterEncoder.filterRow): writes the filter's number and the filtered row into `out` at `at`.
 */
function filterRow(row, prior, bpp, out, at, scratch) {
  const n = row.length;
  const sums = [0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = row[i];
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prior[i];
    const c = i >= bpp ? prior[i - bpp] : 0;
    const vSub = (x - a) & 0xFF;
    const vUp = (x - b) & 0xFF;
    const vAvg = (x - ((a + b) >>> 1)) & 0xFF;
    const vPaeth = (x - paeth(a, b, c)) & 0xFF;
    scratch[1][i] = vSub;
    scratch[2][i] = vUp;
    scratch[3][i] = vAvg;
    scratch[4][i] = vPaeth;
    sums[0] += signedAbs(x);
    sums[1] += signedAbs(vSub);
    sums[2] += signedAbs(vUp);
    sums[3] += signedAbs(vAvg);
    sums[4] += signedAbs(vPaeth);
  }
  let best = 0;
  for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
  out[at] = best;
  out.set(best === 0 ? row : scratch[best], at + 1);
}

/** The picture's rows through the PNG filters (FlateDecode with /Predictor 15 before deflating). */
async function filtered(data, width, height, gray, signal) {
  const bpp = gray ? 1 : 3;
  const rowBytes = width * bpp;
  const out = new Uint8Array((rowBytes + 1) * height);
  let previous = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  const scratch = [null, new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes)];
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) {
      checkCancelled(signal);
      if ((y & 255) === 0 && y > 0) await yieldToUI();
    }
    let p = y * width * 4;
    if (gray) {
      for (let x = 0; x < width; x++, p += 4) current[x] = data[p];
    } else {
      for (let x = 0, i = 0; x < width; x++, p += 4) {
        current[i++] = data[p];
        current[i++] = data[p + 1];
        current[i++] = data[p + 2];
      }
    }
    filterRow(current, previous, bpp, out, y * (rowBytes + 1), scratch);
    [previous, current] = [current, previous];
  }
  return out;
}

/** Deflates `bytes` (zlib format, as FlateDecode reads it), giving up past `cap` bytes: null then. */
async function deflateCapped(bytes, cap, signal) {
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > cap) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
        checkCancelled(signal);
      }
    } catch (e) {
      checkCancelled(signal);
      throw e;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
  const out = zlibSync(bytes, { level: 6 });
  return out.length > cap ? null : out;
}

/**
 * The picture as an image XObject's stream: lossless, in grey when it has no colour, unless a
 * JPEG is much smaller (a photo or a scan), which then stands in at high quality.
 */
export async function encodePicture(doc, picture, signal) {
  const { canvas, context, width, height } = picture;
  const jpeg = await toJpeg(canvas);
  checkCancelled(signal);
  const data = context.getImageData(0, 0, width, height).data;
  const gray = isGray(data, signal);
  const rows = await filtered(data, width, height, gray, signal);
  const lossless = await deflateCapped(rows, Math.floor(jpeg.length * LOSSLESS_ALLOWANCE), signal);
  checkCancelled(signal);
  const ctx = doc.context;
  if (!lossless) {
    return ctx.stream(jpeg, {
      Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
      BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode',
    });
  }
  return ctx.stream(lossless, {
    Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
    BitsPerComponent: 8, ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB', Filter: 'FlateDecode',
    DecodeParms: { Predictor: 15, Colors: gray ? 1 : 3, BitsPerComponent: 8, Columns: width },
  });
}

/** A number as a content stream writes it: no exponent, no needless digits. */
export function pdfNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Makes `image` (an image XObject stream) the only content of page `node`, covering it as shown
 * (`frame`). Only the page's size and turn stay, with its other page boxes and unit; everything
 * else it had (its text, resources, annotations, thumbnail, metadata) goes with its content.
 */
export function replaceWithPicture(doc, node, frame, image) {
  const ctx = doc.context;
  // Its media box as viewers read it (US Letter when it has none that works).
  const { media } = pageView(ctx, node);
  const kept = KEPT_PAGE_KEYS.map((key) => [key, node.get(N(key))]).filter(([, v]) => v !== undefined);
  for (const key of node.keys()) node.delete(key);
  for (const [key, value] of kept) node.set(N(key), value);
  node.set(N('MediaBox'), ctx.obj(media));
  node.set(N('CropBox'), ctx.obj(frame.area));
  node.set(N('Rotate'), PDFNumber.of(frame.rotation));
  const imageRef = ctx.register(image);
  node.set(N('Resources'), ctx.obj({ XObject: { Im0: imageRef } }));
  const m = frame.matrix.map(pdfNumber).join(' ');
  const content = `q ${m} cm ${pdfNumber(frame.shownWidth)} 0 0 ${pdfNumber(frame.shownHeight)} 0 0 cm /Im0 Do Q`;
  node.set(N('Contents'), ctx.register(ctx.flateStream(content)));
}

