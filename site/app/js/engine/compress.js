// Compress PDF: the app's PdfToolsEngine.compress. Only images are made smaller: text stays text and
// drawings stay drawings. Each image is shrunk to the level's resolution for the largest space it
// fills on a page (and never past what the largest page needs, as in the app), stored again as JPEG
// at the level's quality, and kept as it was unless that is smaller. A PDF that doesn't get at
// least 1% smaller is handed back as it was, unless it had a password, was locked against changes
// (an owner password) or carried Usugami's own watermark: then it is always saved again, without
// them, as every tool's PDFs are (the app's compressTo).
import { PDFName, PDFArray, PDFNumber, PDFRef } from '../lib/pdf-lib.js';
import { loadPdf, savePdf, wasEncrypted, wasUnmarked } from './pdf-common.js';
import { UserError, PasswordError, CancelledError, checkCancelled } from '../core/errors.js';
import { sanitizeName, withSuffix, baseName, namesArg } from '../core/names.js';
import { savedPercent } from './images/page-layout.js';
import { pause } from './images/canvas.js';
import { findImages, measureImages } from './compress/placements.js';
import { examine, readImage, encodeImage, imageStream } from './compress/image.js';
import { viewerPages, wasMended } from './flatten/pages.js';

/**
 * The levels (the app's PdfCompression): the most pixels per inch an image keeps where it is shown,
 * and the JPEG quality it is stored with. Labels and summaries are strings.xml keys.
 */
export const LEVELS = {
  less: { dpi: 200, quality: 85, label: 'compression_less', summary: 'compression_less_summary' },
  recommended: { dpi: 150, quality: 68, label: 'compression_recommended', summary: 'compression_recommended_summary' },
  extreme: { dpi: 100, quality: 48, label: 'compression_extreme', summary: 'compression_extreme_summary' },
};

/** The levels in the order the app shows them, and the one it starts on. */
export const LEVEL_ORDER = ['less', 'recommended', 'extreme'];
export const DEFAULT_LEVEL = 'recommended';

/** No image is kept larger than this on its long side (the app's limit). */
export const MAX_IMAGE_SIDE = 4000;

/** Letter, the page size PDFBox gives a page without a media box. */
const DEFAULT_MEDIA_BOX = [0, 0, 612, 792];

export { savedPercent };

/**
 * The name the app gives a compressed PDF before the user types another (no extension):
 * "Report.pdf" becomes "Report_compressed".
 * @param {{ name?: string }} input
 */
export function defaultCompressName(input) {
  return withSuffix(baseName(input?.name ?? ''), '_compressed', 'Usugami');
}

/**
 * The size an image `width` x `height` is stored at: shrunk (never enlarged) to `dpi` for the
 * largest space it fills (`extent`: points of the page one of its pixels covers there; 0 when
 * unknown), and never past `maxDimension` pixels on its long side.
 * @returns {[number, number]}
 */
export function targetSize(width, height, extent, dpi, maxDimension) {
  let scale = Math.min(1, maxDimension / Math.max(width, height));
  if (extent > 0) scale = Math.min(scale, (extent * dpi) / 72);
  if (scale >= 1) return [width, height];
  return [Math.max(1, Math.floor(width * scale + 1e-9)), Math.max(1, Math.floor(height * scale + 1e-9))];
}

/**
 * The app's limit for a PDF: the largest page side at the level's resolution, at most 4000 pixels.
 * @param {number} maxPageSide in points
 */
export function maxDimensionFor(maxPageSide, dpi) {
  return Math.min(MAX_IMAGE_SIDE, Math.max(1, Math.floor((maxPageSide * dpi) / 72)));
}

/**
 * Compresses a PDF.
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {{ level?: 'less'|'recommended'|'extreme', name?: string, fileName?: string }} [options]
 *   name (or fileName): the new PDF's name as typed, without .pdf (default defaultCompressName(input))
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: 'application/pdf', pageCount: number,
 *   keptOriginal: boolean, originalSize: number, imagesReduced: number }>}
 */
export async function compressPdf(input, options = {}, hooks = {}) {
  const levelId = options.level ?? DEFAULT_LEVEL;
  const level = LEVELS[levelId];
  if (!level) throw new RangeError(`Unknown compression level ${levelId}`);
  const { onProgress, signal } = hooks;
  const typed = options.name ?? options.fileName ?? input.outputName ?? defaultCompressName(input);
  const name = `${sanitizeName(typed, 'Compressed')}.pdf`;
  const original = input.bytes;
  const hasPassword = typeof input.password === 'string' && input.password !== '';
  checkCancelled(signal);

  const doc = await loadPdf(original, { password: hasPassword ? input.password : undefined });
  checkCancelled(signal);
  // The pages viewers find, a damaged page tree mended first (as the app mends it when the PDF is
  // picked); without pages that can be found it is as damaged as one that can't be read.
  const pages = viewerPages(doc);
  const pageCount = pages.length;
  let bytes;
  let imagesReduced = 0;
  try {
    const ctx = doc.context;
    const maxPageSide = pages.reduce((m, page) => Math.max(m, pageSide(ctx, page.node)), 0);
    const maxDimension = maxDimensionFor(maxPageSide, level.dpi);
    const images = findImages(ctx, pages);
    const total = pages.length + images.size + 1;
    let done = 0;
    onProgress?.(0, total);
    await measureImages(ctx, pages, images, { signal, onPage: () => onProgress?.(++done, total) });

    let started = performance.now();
    for (const entry of images.values()) {
      checkCancelled(signal);
      if (await reduce(ctx, entry, level, maxDimension, signal)) imagesReduced++;
      onProgress?.(++done, total);
      if (performance.now() - started > 24) {
        await pause();
        started = performance.now();
      }
    }
    checkCancelled(signal);
    bytes = await savePdf(doc);
    checkCancelled(signal);
    onProgress?.(total, total);
  } catch (e) {
    if (e instanceof UserError || e instanceof PasswordError || e?.name === 'CancelledError') throw e;
    throw new UserError('pdf_process_failed');
  }
  // A saving under 1% isn't worth a re-encoded copy: the original is kept, and says so. Not one
  // restricted by an owner password, which every tool takes off, nor one with Usugami's own
  // watermark, which no tool keeps (the app's asItIs); nor one whose page tree had to be mended,
  // which the app keeps only as its mended copy.
  const keptOriginal = !hasPassword && !wasEncrypted(doc) && !wasUnmarked(doc) && !wasMended(doc)
    && savedPercent(original.length, bytes.length) == null;
  return {
    name,
    bytes: keptOriginal ? original.slice() : bytes,
    type: 'application/pdf',
    pageCount,
    keptOriginal,
    originalSize: original.length,
    imagesReduced,
  };
}

/**
 * What the result screen says under a compressed PDF (the app's ResultScreen): how much smaller it
 * got, or that its original was kept; null when neither (a PDF that had a password and didn't get
 * smaller). `compressed_from` takes the original size formatted with formatSize, then the percent.
 * @param {{ bytes: Uint8Array, originalSize: number, keptOriginal: boolean }} file
 * @returns {{ key: 'compressed_from', originalSize: number, percent: number } | { key: 'original_kept' } | null}
 */
export function compressDetail(file) {
  const percent = savedPercent(file.originalSize, file.bytes.length);
  if (percent != null) return { key: 'compressed_from', originalSize: file.originalSize, percent };
  return file.keptOriginal ? { key: 'original_kept' } : null;
}

/**
 * The app's messages after Compress PDF, for one PDF (runCompress) or several (runCompressAll), in
 * the order it shows them. Each is { key, args } for t(key, ...args), or { key, count, args } for
 * tp(key, count, ...args). Give it every PDF's outcome, in order; cancelled ones are left out.
 * @param {{ name: string, result?: { bytes: Uint8Array, originalSize: number, keptOriginal: boolean }, error?: Error }[]} outcomes
 * @returns {{ key: string, count?: number, args: any[] }[]}
 */
export function compressNotes(outcomes) {
  const notSmaller = (r) => savedPercent(r.originalSize, r.bytes.length) == null;
  if (outcomes.length === 1) {
    const [{ result, error }] = outcomes;
    if (error) {
      if (error instanceof CancelledError) return [];
      return [{ key: error instanceof UserError ? error.key : 'pdf_process_failed', args: error instanceof UserError ? error.args : [] }];
    }
    // Kept as it was, or (with a password, which can't be kept) no smaller: said, or the result
    // would look as if nothing had happened.
    if (notSmaller(result)) return [{ key: result.keptOriginal ? 'pdf_no_reduction' : 'pdf_not_smaller', args: [] }];
    return [];
  }
  const failed = outcomes.filter((o) => o.error && !(o.error instanceof CancelledError)).map((o) => o.name);
  // A PDF kept as it was says so under its name; those with a password that came out no smaller are named.
  const unchanged = outcomes.filter((o) => o.result && !o.result.keptOriginal && notSmaller(o.result)).map((o) => o.name);
  const messages = [];
  if (failed.length) messages.push({ key: 'batch_failed', count: failed.length, args: [failed.length, namesArg(failed)] });
  if (unchanged.length) messages.push({ key: 'batch_not_smaller', count: unchanged.length, args: [unchanged.length, namesArg(unchanged)] });
  return messages;
}

/**
 * Shrinks one image and puts the smaller copy where the old one was used, when it is smaller.
 * An image that can't be read faithfully, or doesn't get smaller, is left as it is.
 * @returns {Promise<boolean>} whether it was replaced
 */
async function reduce(ctx, entry, level, maxDimension, signal) {
  try {
    const facts = examine(ctx, entry.stream);
    if (!facts.ok) return false;
    const [width, height] = targetSize(facts.width, facts.height, entry.unknown ? 0 : entry.extent, level.dpi, maxDimension);
    const cs = facts.colourSpace;
    const components = cs.palette ? cs.palette.components : cs.components;
    const shrinks = width < facts.width || height < facts.height;
    // CMYK and other colour spaces a JPEG can't hold here are only worth storing again when smaller.
    if (components !== 1 && components !== 3 && !shrinks) return false;
    const read = await readImage(ctx, facts, width, height, { signal, rgba: true });
    if (!read) return false;
    // Reading the pixels back took a while: the page paints before they are stored again.
    checkCancelled(signal);
    await pause();
    const encoded = await encodeImage(read.rgba ?? read.pixels, width, height, read.components, {
      quality: level.quality,
      deviceRgb: cs.palette ? cs.palette.deviceRgb : cs.deviceRgb,
      decode: cs.palette ? undefined : facts.decode,
      signal,
    });
    if (encoded.bytes.length >= facts.data.length) return false;
    const ref = ctx.register(imageStream(ctx, entry.stream, facts, encoded, width, height));
    for (const use of entry.uses) use.xobjects.set(use.name, ref);
    return true;
  } catch (e) {
    if (e?.name === 'CancelledError') throw e;
    // As in the app: an image that can't be decoded or is too large for memory stays as it is.
    return false;
  }
}

/** The longer side of a page's media box (inherited, Letter when missing), in points. */
function pageSide(ctx, node) {
  let box = DEFAULT_MEDIA_BOX;
  try {
    const value = node.getInheritableAttribute(PDFName.of('MediaBox'));
    const array = value instanceof PDFRef ? ctx.lookup(value) : value;
    if (array instanceof PDFArray && array.size() >= 4) {
      const n = array.asArray().slice(0, 4).map((v) => {
        const x = v instanceof PDFRef ? ctx.lookup(v) : v;
        return x instanceof PDFNumber ? x.asNumber() : NaN;
      });
      if (n.every(Number.isFinite)) box = n;
    }
  } catch {
    // A damaged tree: the default size.
  }
  return Math.max(Math.abs(box[2] - box[0]), Math.abs(box[3] - box[1]));
}
