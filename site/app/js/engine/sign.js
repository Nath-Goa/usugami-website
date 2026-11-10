// Sign PDF: a signature drawn by hand goes on a page as a picture with a see-through background,
// exactly where the preview put it on the page as it is shown (turned, cropped). A port of the
// app's Signature.kt (the drawing and its picture), core/SignatureLayout.kt (where it goes, how
// big) and PdfToolsEngine.sign. It is a picture of a handwritten signature, never a certified
// digital one. No UI here: the screen is js/tools/sign/.
import { loadPdf, savePdf } from './pdf-common.js';
import { PDFName, PDFDict, PDFArray, PDFStream, PDFRef, PDFNumber } from '../lib/pdf-lib.js';
import { UserError, PasswordError, CancelledError, checkCancelled } from '../core/errors.js';
import { sanitizeName } from '../core/names.js';
import { yieldToUI } from '../core/dom.js';
// With the engine, not when a page with form fields or comments is first signed: the device may
// be offline by then.
import { bakeUnder } from './flatten.js';
import { Signature, INKS, clampPlacement, defaultPlacement, pdfArea, pixels, renderSignature } from './signature.js';

// The signature, its picture and its place (no pdf-lib), for the screen to load on its own.
export * from './signature.js';

// -----------------------------------------------------------------------------------------------
// The page as a viewer shows it (PageFrame in PageStamps.kt), read the way pdf.js reads it, so the
// preview (drawn by pdf.js) and the signed page agree.

const N = (k) => PDFName.of(k);
const LETTER = [0, 0, 612, 792];

function lookup(ctx, v) {
  return v instanceof PDFRef ? ctx.lookup(v) : v;
}

/** An inheritable entry of a page (MediaBox, CropBox, Rotate, Resources): the nearest one. */
function inherited(ctx, node, key) {
  let d = node;
  for (let depth = 0; d instanceof PDFDict && depth < 100; depth++) {
    const v = d.get(N(key));
    if (v !== undefined) return lookup(ctx, v);
    d = lookup(ctx, d.get(N('Parent')));
  }
  return undefined;
}

/** A box entry, normalized ([left, bottom, right, top]), or null when missing, malformed or empty. */
function boxOf(ctx, node, key) {
  const a = inherited(ctx, node, key);
  if (!(a instanceof PDFArray) || a.size() !== 4) return null;
  const n = [];
  for (let i = 0; i < 4; i++) {
    const v = lookup(ctx, a.get(i));
    if (!(v instanceof PDFNumber) || !Number.isFinite(v.asNumber())) return null;
    n.push(v.asNumber());
  }
  const box = [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
  return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null;
}

/**
 * Page `index` of a pdf-lib document as a viewer shows it: its crop box (within its media box)
 * turned clockwise by its /Rotate. Returns { left, bottom, width, height, rotation, shownWidth,
 * shownHeight, matrix } where matrix [a, b, c, d, e, f] (as for a PDF `cm`) takes points on the
 * page as shown (origin at its bottom-left corner, y up) to the page's own coordinates.
 */
export function pageFrame(doc, index) {
  const ctx = doc.context;
  const node = doc.getPage(index).node;
  const media = boxOf(ctx, node, 'MediaBox') ?? LETTER;
  const crop = boxOf(ctx, node, 'CropBox');
  let view = media;
  if (crop) {
    const box = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])];
    if (box[2] - box[0] > 0 && box[3] - box[1] > 0) view = box;
  }
  const r = inherited(ctx, node, 'Rotate');
  let rotation = r instanceof PDFNumber ? r.asNumber() : 0;
  rotation = Number.isFinite(rotation) && rotation % 90 === 0 ? ((rotation % 360) + 360) % 360 : 0;
  return frameOf(view[0], view[1], view[2] - view[0], view[3] - view[1], rotation);
}

/** A PageFrame from its crop box and rotation (0, 90, 180 or 270). */
export function frameOf(left, bottom, width, height, rotation) {
  const sideways = rotation === 90 || rotation === 270;
  let matrix;
  if (rotation === 0) matrix = [1, 0, 0, 1, left, bottom];
  // The shown bottom-left corner is the box's bottom-right corner, and shown x runs up the page.
  else if (rotation === 90) matrix = [0, 1, -1, 0, left + width, bottom];
  else if (rotation === 180) matrix = [-1, 0, 0, -1, left + width, bottom + height];
  // The shown bottom-left corner is the box's top-left corner, and shown x runs down the page.
  else matrix = [0, -1, 1, 0, left, bottom + height];
  return {
    left, bottom, width, height, rotation,
    shownWidth: sideways ? height : width,
    shownHeight: sideways ? width : height,
    matrix,
  };
}

/** The page rectangle [left, bottom, right, top] that a rectangle covers once matrix `m` takes it there. */
export function pageArea(m, x, y, width, height) {
  const corners = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]];
  const xs = corners.map(([cx, cy]) => m[0] * cx + m[2] * cy + m[4]);
  const ys = corners.map(([cx, cy]) => m[1] * cx + m[3] * cy + m[5]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// -----------------------------------------------------------------------------------------------
// PdfToolsEngine.sign

/** A number as a content stream writes it: no exponent, at most 4 decimals. */
function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10000) / 10000;
  if (Math.abs(r) >= 1e9) return String(Math.round(r));
  const s = r.toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * The signature's picture as an image XObject in `doc`: the ink's colour everywhere (DeviceRGB),
 * its strokes in an 8-bit soft mask, both compressed without loss (as PDFBox's LosslessFactory).
 */
function signatureImage(doc, signature, widthPx) {
  const { width, height, alpha } = renderSignature(signature, widthPx);
  const argb = INKS[signature.ink];
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = r;
    rgb[i + 1] = g;
    rgb[i + 2] = b;
  }
  const ctx = doc.context;
  const common = { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, BitsPerComponent: 8 };
  const mask = ctx.register(ctx.flateStream(alpha, { ...common, ColorSpace: 'DeviceGray' }));
  return { ref: ctx.register(ctx.flateStream(rgb, { ...common, ColorSpace: 'DeviceRGB', SMask: mask })), width, height };
}

/** Puts `ref` in the page's own XObject resources (a copy of the ones it shares) and returns its name. */
function addXObject(ctx, node, ref) {
  const shared = inherited(ctx, node, 'Resources');
  const resources = ctx.obj({});
  if (shared instanceof PDFDict) for (const [k, v] of shared.entries()) resources.set(k, v);
  const xobjects = ctx.obj({});
  const old = lookup(ctx, resources.get(N('XObject')));
  if (old instanceof PDFDict) for (const [k, v] of old.entries()) xobjects.set(k, v);
  let i = 1;
  while (xobjects.has(N(`Im${i}`))) i++;
  xobjects.set(N(`Im${i}`), ref);
  resources.set(N('XObject'), xobjects);
  node.set(N('Resources'), resources);
  return `Im${i}`;
}

/**
 * Adds `body` after the page's content, with the content before it kept in a q … Q of its own:
 * the page's drawing may leave the graphics state scaled, turned or clipped (as PDFBox's
 * PDPageContentStream with resetContext does).
 */
function appendContent(ctx, node, body) {
  const contents = node.get(N('Contents'));
  const existing = lookup(ctx, contents);
  let items = [];
  if (existing instanceof PDFArray) for (let i = 0; i < existing.size(); i++) items.push(existing.get(i));
  else if (existing instanceof PDFStream) items = [contents instanceof PDFRef ? contents : ctx.register(existing)];
  if (!items.length) {
    node.set(N('Contents'), ctx.register(ctx.flateStream(body)));
    return;
  }
  const before = ctx.register(ctx.stream('q\n'));
  const after = ctx.register(ctx.flateStream('Q\n' + body));
  node.set(N('Contents'), ctx.obj([before, ...items, after]));
}

/** Whether the page lists annotations at all (only then can any be under the signature). */
function hasAnnotations(ctx, node) {
  const a = lookup(ctx, node.get(N('Annots')));
  return a instanceof PDFArray && a.size() > 0;
}

/**
 * Signs page `options.page` (from 0) of a PDF: draws `options.signature` where
 * `options.placement` ({ centerX, centerY, width }, shares of the page as shown) puts it, or in
 * the lower right when it is null, as a picture with a see-through background, trimmed to the
 * ink, at 300 dpi (at most 2400 pixels on its longer side). Form fields and comments under it
 * become part of the page first, so it lies over them as the preview shows.
 *
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {{ signature: Signature | { strokes: number[][], ink: 'black'|'blue' }, page: number,
 *           placement?: { centerX: number, centerY: number, width: number } | null, name?: string }} options
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: 'application/pdf', pageCount: number }>}
 */
export async function signPdf(input, options = {}, { onProgress, signal } = {}) {
  const steps = 5;
  const progress = (done) => onProgress?.(done, steps);
  checkCancelled(signal);
  const signature = Signature.from(options.signature);
  try {
    if (!signature || signature.isEmpty) throw new UserError('pdf_process_failed');
    const doc = await loadPdf(input.bytes, input.password ? { password: input.password } : {});
    checkCancelled(signal);
    progress(1);
    // What pdf-lib reads leniently from a file that isn't really a PDF has no pages (or no page tree).
    let count = 0;
    try { count = doc.getPageCount(); } catch { count = 0; }
    if (count === 0) throw new UserError('pdf_import_failed');
    const index = options.page;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new UserError('pdf_process_failed');
    const ctx = doc.context;
    const node = doc.getPage(index).node;
    const frame = pageFrame(doc, index);
    const { shownWidth: width, shownHeight: height } = frame;
    const aspect = signature.aspect;
    const wanted = options.placement && typeof options.placement === 'object' ? options.placement : defaultPlacement(width, height, aspect);
    const place = clampPlacement(wanted, width, height, aspect);
    const area = pdfArea(place, width, height, aspect);
    await yieldToUI();
    checkCancelled(signal);
    const image = signatureImage(doc, signature, pixels(area.width, area.height)[0]);
    checkCancelled(signal);
    progress(2);
    // It goes over the form fields and comments under it, as the preview shows it.
    if (hasAnnotations(ctx, node)) {
      try {
        await bakeUnder(doc, index, [pageArea(frame.matrix, area.x, area.y, area.width, area.height)], { signal });
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        // Annotations that can't be read stay as they are, as the app leaves them.
      }
    }
    checkCancelled(signal);
    progress(3);
    const name = addXObject(ctx, node, image.ref);
    appendContent(ctx, node, [
      `${frame.matrix.map(fmt).join(' ')} cm`,
      'q',
      `${fmt(area.width)} 0 0 ${fmt(area.height)} ${fmt(area.x)} ${fmt(area.y)} cm`,
      `/${name} Do`,
      'Q',
    ].join('\n') + '\n');
    progress(4);
    await yieldToUI();
    checkCancelled(signal);
    const bytes = await savePdf(doc);
    checkCancelled(signal);
    progress(5);
    return {
      name: sanitizeName(options.name, 'Signed') + '.pdf',
      bytes,
      type: 'application/pdf',
      pageCount: doc.getPageCount(),
    };
  } catch (e) {
    if (e instanceof UserError || e instanceof PasswordError || e instanceof CancelledError) throw e;
    throw new UserError('pdf_process_failed');
  }
}
