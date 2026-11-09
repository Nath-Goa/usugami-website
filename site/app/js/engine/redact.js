// Redact PDF: true removal, not a black box on top (the app's Redactor and PdfToolsEngine.redact).
//
// Each page with a box is drawn as a picture at 200 dpi, as viewers show it (comments and filled-in
// fields included), the boxes are painted solid black into the picture, and the page's content is
// replaced by that picture at the same size: the text, images and drawings under the boxes are no
// longer in the file at all. Pages without boxes stay as they are, unless they keep part of what a
// box hides out of sight. Then whatever else could still hold the hidden content goes: document
// details, bookmarks, tags, attached files, scripts, and the comments and form fields of the
// redacted pages.
//
// Find text boxes a word or phrase on every page, ignoring case and accents, across line breaks,
// letter-spaced and broken after a hyphen, and also finds it in what comments, links and form
// fields say where no page shows it.
import { openPdfJs } from '../lib/pdfjs.js';
import { loadPdf, savePdf, wasUnmarked } from './pdf-common.js';
import { UserError, PasswordError, CancelledError, checkCancelled } from '../core/errors.js';
import { yieldToUI } from '../core/dom.js';
import { pageGlyphs, findOnPage, pageTextOf } from './redact/glyphs.js';
import { findInComments, removeLeaks } from './redact/leaks.js';
import { ContentReader, drawnBy, emptyUnused } from './redact/content.js';
import { keepingHidden } from './redact/hidden.js';
import { renderRedacted, renderShown, encodePicture, replaceWithPicture, releaseCanvas } from './redact/picture.js';
import { pageView, get, items, PDFDict } from './redact/objects.js';
import { normalize } from './redact/page-text.js';
import { sanitize, redactedName } from './redact/names.js';
import { repairPageTree } from './cleanup.js';
import {
  PageFrame, clamp, same, boxToRect, rectToBox, makeBox, MAX_BOXES,
} from './redact/boxes.js';

export {
  DPI, MAX_PIXELS, MIN_SIZE, STEP, MAX_BOXES, TEXT_MARGIN,
  makeBox, between, clamp, moved, resized, withCorner, defaultBox, pixelSize, pixelBounds,
  hit, findBox, same, pack, unpack, boxToRect, rectToBox, PageFrame,
} from './redact/boxes.js';
export { redactedName } from './redact/names.js';
export { normalize as normalizeQuery } from './redact/page-text.js';

/** Opens `input` with pdf.js; PasswordError when its password is missing or wrong. */
async function openView(input, failure) {
  try {
    return await openPdfJs(input.bytes, { password: input.password ?? undefined });
  } catch (e) {
    if (e?.name === 'PasswordException') throw new PasswordError(e.code === 2);
    throw new UserError(failure);
  }
}

/** Frees what pdf.js holds for a document (pdf.js 6 has no destroy() on the document itself). */
async function closeView(pdf) {
  try {
    await pdf.loadingTask.destroy();
  } catch {
    // Already closed.
  }
}

/** Each page's frame as viewers show it, from a pdf.js page. */
const frameOf = (page) => PageFrame.fromView(page.view, page.rotate);

/**
 * The page dictionaries of `doc` (pdf-lib), in order, as viewers find them: { nodes, mended }. A
 * damaged page tree (one that miscounts, loops, has a page without its type, or a lone page in the
 * tree's place), which pdf-lib would read otherwise than viewers do, is mended first, as the app
 * mends it when a PDF is opened (PdfToolsEngine.inspect; cleanup.js' repairPageTree), so the pages
 * Redact changes are those the preview shows. `mended` says whether it had to be. A PDF without
 * pages (no catalog, no /Kids) fails as a damaged one, never with a TypeError or a stack overflow.
 */
function pageNodes(doc) {
  try {
    const { pages, changed } = repairPageTree(doc);
    return { nodes: pages.map((p) => p.dict), mended: changed };
  } catch {
    throw new UserError('pdf_import_failed');
  }
}

/**
 * What pdf.js reads of `input`: what the screen's previews show (PdfToolsEngine.previewView), so
 * Find text and the pictures see the pages as the preview does. A PdfSource has it: `viewBytes`,
 * opened with `viewPassword` (without the password, Usugami's mark and a damaged page tree). A
 * plain input ({ bytes, password }) is read as it is, unless its page tree has to be mended or it
 * carries Usugami's mark: then a copy without them, made as core/pdfdoc.js makes the view.
 * `reading` is the input's pdf-lib reading when there is one ({ doc, mended }; null: pdf-lib can't
 * read it), so it isn't read twice for nothing. pdf-lib's own copy needs none of this: loadPdf
 * takes the mark off in memory, and pageNodes mends the tree.
 */
async function shownOf(input, reading) {
  if (input?.viewBytes instanceof Uint8Array) {
    return { bytes: input.viewBytes, password: input.viewPassword || undefined };
  }
  if (reading === null || (reading && !reading.mended && !wasUnmarked(reading.doc))) return input;
  try {
    // A fresh copy: the one being redacted mustn't be saved half-way.
    const copy = await loadPdf(input.bytes, { password: input.password ?? undefined });
    const { changed } = repairPageTree(copy);
    if (!changed && !wasUnmarked(copy)) return input;
    return { bytes: await savePdf(copy) };
  } catch {
    // pdf-lib can't read it: pdf.js reads the PDF itself, and says what is wrong with it.
    return input;
  }
}

/**
 * Every page's frame as shown (its crop box turned by its /Rotate), for drawing boxes over a
 * preview and for turning boxes into PDF user space and back: [{ left, bottom, width, height,
 * rotation, shownWidth, shownHeight }]. `source` is a pdf.js document (PdfSource.pdfjs()) or an
 * input { bytes, password } (or a PdfSource: its view is read, as the previews show it).
 */
export async function pageFrames(source) {
  const own = !(source && typeof source.getPage === 'function');
  const pdf = own ? await openView(await shownOf(source), 'pdf_import_failed') : source;
  try {
    const frames = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      let page;
      try {
        page = await pdf.getPage(i);
      } catch {
        // pdf.js can't find the page (a page tree that loops, say).
        throw new UserError('pdf_import_failed');
      }
      frames.push(frameOf(page).toJSON());
    }
    return frames;
  } finally {
    if (own) await closeView(pdf);
  }
}

/**
 * Draws page `pageIndex` of a pdf.js document as shown, as the redacted picture will be (comments
 * and filled-in fields included), `cssWidth` CSS pixels wide (sharp on high-density screens).
 * Returns the canvas, with `frame` (the page's frame) set on it. Boxes (fractions of the page)
 * drawn over it at left × width, top × height cover exactly what they will hide.
 */
export async function renderPreview(pdf, pageIndex, cssWidth, { signal, pixelRatio } = {}) {
  const page = await pdf.getPage(pageIndex + 1);
  const frame = frameOf(page);
  const ratio = pixelRatio ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  const width = Math.max(1, Math.round(cssWidth * ratio));
  const height = Math.max(1, Math.round((width * frame.shownHeight) / frame.shownWidth));
  // An element the screen can show.
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  let canvas;
  try {
    ({ canvas } = await renderShown(page, frame, width, height, signal, element));
  } finally {
    // pdf.js would otherwise keep the page's decoded images and drawing until the PDF is closed
    // (tens of megabytes a page for a scan); it waits for any other drawing of the page to end.
    try {
      page.cleanup();
    } catch {
      // The PDF was closed meanwhile.
    }
  }
  canvas.style.width = `${cssWidth}px`;
  canvas.frame = frame.toJSON();
  return canvas;
}

/**
 * Every place `query` is found in `input`, on every page: [{ pageIndex, rect, box, match }], one
 * entry for each line of each match, in page order. `rect` is { x, y, width, height } in the
 * page's own, unturned coordinates (PDF user space); `box` is the same as fractions of the page as
 * shown ({ page, left, top, right, bottom }); `match` numbers the matches (one match may have
 * several lines), for "Found 3 matches". A comment, link or form field whose text has `query`
 * where no page shows it gets a small box, so that its page is redacted and it goes. Text that is
 * a picture (a scan) has nothing to find. Throws PasswordError, or UserError('redact_find_failed').
 *
 * @param {{ name?: string, bytes: Uint8Array, password?: string, viewBytes?: Uint8Array, viewPassword?: string }} input
 *   a FileItem, or a PdfSource (its viewBytes are what pdf.js reads)
 * @param {string} query
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 */
export async function findText(input, query, hooks = {}) {
  const { onProgress, signal } = hooks;
  if (!normalize(String(query ?? '')).length) return [];
  checkCancelled(signal);
  // pdf-lib's reading, its page tree mended: for what comments, links and fields say (in the PDF's
  // objects, not on its pages). Null for a PDF pdf.js reads but pdf-lib can't (damaged, or
  // encrypted in a way it doesn't know): its pages are still searched.
  const read = async () => {
    try {
      const doc = await loadPdf(input.bytes, { password: input.password ?? undefined });
      return { doc, ...pageNodes(doc) };
    } catch {
      return null;
    }
  };
  // A PdfSource has its view: pdf-lib reads the PDF once pdf.js is done with it, so the two aren't
  // in memory together. A plain input is read first, to know whether pdf.js needs a mended copy.
  let reading = input?.viewBytes instanceof Uint8Array ? undefined : await read();
  checkCancelled(signal);
  const pdf = await openView(await shownOf(input, reading), 'redact_find_failed');
  const inText = [];
  const frames = [];
  try {
    const total = pdf.numPages;
    for (let i = 0; i < total; i++) {
      checkCancelled(signal);
      const page = await pdf.getPage(i + 1);
      const frame = frameOf(page);
      frames.push(frame);
      let glyphs = [];
      try {
        glyphs = await pageGlyphs(page);
      } catch {
        // A page pdf.js can't read has no text to find.
      }
      checkCancelled(signal);
      inText.push(...findOnPage(glyphs, frame, i, query));
      page.cleanup();
      onProgress?.(i + 1, total);
      await yieldToUI();
    }
  } catch (e) {
    if (e instanceof CancelledError || e instanceof PasswordError) throw e;
    throw new UserError('redact_find_failed');
  } finally {
    await closeView(pdf);
  }
  // What comments, links and fields say: in the PDF's objects, not on its pages. The view has the
  // same pages, in the same order.
  if (reading === undefined) reading = await read();
  checkCancelled(signal);
  let inComments = [];
  if (reading) {
    try {
      const { doc, nodes } = reading;
      const pages = new Set(inText.map((m) => m[0].page));
      const frameAt = (i) => frames[i] ?? (() => {
        const { view, rotate } = pageView(doc.context, nodes[i]);
        return PageFrame.fromView(view, rotate);
      })();
      const commentFrames = nodes.map((_, i) => frameAt(i));
      inComments = findInComments(doc, commentFrames, query, pages, () => checkCancelled(signal), nodes)
        .filter((m) => m[0].page < frames.length);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      // Comments too damaged to read: the pages were still searched.
    }
  }
  const all = [...inText, ...inComments].map((boxes, i) => ({ boxes, i }));
  // In page order, as they are on each page (a stable sort).
  all.sort((a, b) => a.boxes[0].page - b.boxes[0].page || a.i - b.i);
  const out = [];
  all.forEach(({ boxes }, match) => {
    for (const box of boxes) out.push({ pageIndex: box.page, rect: boxToRect(frames[box.page], box), box, match });
  });
  return out;
}

/**
 * Adds what findText found to `existing` boxes (fractions, { page, left, top, right, bottom }) as
 * the app does: boxes already there aren't added again. Returns { boxes, added, matches, pages,
 * tooMany }: the boxes to keep (unchanged when tooMany: more than MAX_BOXES), how many were new,
 * how many matches were found (for redact_found), and the pages they are on.
 */
export function addFound(existing, found) {
  const fresh = [];
  for (const { box } of found) {
    if (!existing.some((b) => same(b, box)) && !fresh.some((b) => same(b, box))) fresh.push(box);
  }
  const matches = new Set(found.map((f) => f.match)).size;
  const pages = [...new Set(found.map((f) => f.pageIndex))].sort((a, b) => a - b);
  const tooMany = existing.length + fresh.length > MAX_BOXES;
  return { boxes: tooMany ? existing : [...existing, ...fresh], added: tooMany ? 0 : fresh.length, matches, pages, tooMany };
}

/**
 * The boxes asked for, as [{ page, item }]: from a Map or an object keyed by page index, or an
 * array of entries ({ pageIndex, rect } as findText gives, { pageIndex, box }, or boxes with a page).
 */
function entriesOf(spec) {
  const out = [];
  const addAll = (page, list) => {
    for (const item of Array.isArray(list) ? list : [list]) if (item) out.push({ page: Number(page), item });
  };
  if (spec instanceof Map) {
    for (const [page, list] of spec) addAll(page, list);
  } else if (Array.isArray(spec)) {
    for (const entry of spec) {
      if (!entry) continue;
      const page = entry.pageIndex ?? entry.page;
      if (entry.rect) out.push({ page, item: entry.rect });
      else if (entry.box) out.push({ page, item: entry.box });
      else out.push({ page, item: entry });
    }
  } else if (spec && typeof spec === 'object') {
    for (const [page, list] of Object.entries(spec)) if (/^\d+$/.test(page)) addAll(page, list);
  }
  return out.filter(({ page }) => Number.isInteger(page) && page >= 0);
}

/** An entry as a box on its page, cut to it and at least the smallest size, or null. */
function toBox(frame, page, item) {
  const finite = (...v) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
  if ('left' in item && 'top' in item && 'right' in item && 'bottom' in item) {
    if (!finite(item.left, item.top, item.right, item.bottom)) return null;
    return clamp(makeBox(page, Math.min(item.left, item.right), Math.min(item.top, item.bottom), Math.max(item.left, item.right), Math.max(item.top, item.bottom)));
  }
  if (!finite(item.x, item.y, item.width, item.height)) return null;
  const x0 = Math.min(item.x, item.x + item.width);
  const y0 = Math.min(item.y, item.y + item.height);
  return clamp(rectToBox(frame, page, { x: x0, y: y0, width: Math.abs(item.width), height: Math.abs(item.height) }));
}

/**
 * Redacts `input`: each page with boxes becomes a picture of itself with the boxes solid black,
 * and what else could leak the hidden content is removed. Returns the OutputFile
 * { name, bytes, type: 'application/pdf', pageCount, redactedPages, picturedPages }.
 *
 * `boxesByPage`: the boxes, as a Map or object from page index (zero-based) to a list of
 * rectangles in PDF user space ({ x, y, width, height }) or of boxes as fractions of the page as
 * shown ({ left, top, right, bottom }); or a list of findText's entries. It may also be
 * { boxes, searched, name }, with `searched` (what Find text looked for: form fields holding it
 * that no page shows go too) and `name` (the new PDF's name, without .pdf; "<name>_redacted" by
 * default). Those two may be given in `hooks` instead.
 *
 * @param {{ name?: string, bytes: Uint8Array, password?: string, viewBytes?: Uint8Array, viewPassword?: string }} input
 *   a FileItem, or a PdfSource (its viewBytes are what pdf.js reads)
 * @param {object} boxesByPage
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal, searched?: string[], name?: string }} [hooks]
 */
export async function redactPdf(input, boxesByPage, hooks = {}) {
  const { onProgress, signal } = hooks;
  const options = boxesByPage && !Array.isArray(boxesByPage) && !(boxesByPage instanceof Map) && 'boxes' in boxesByPage ? boxesByPage : { boxes: boxesByPage };
  const searched = [...(options.searched ?? hooks.searched ?? [])].map(String);
  const wanted = options.name ?? hooks.name;
  const name = `${sanitize(wanted ?? redactedName(input.name ?? ''), 'Redacted')}.pdf`;
  const check = () => checkCancelled(signal);
  check();

  // pdf-lib's copy, which becomes the new PDF, is the PDF itself (Usugami's mark taken off in
  // memory, its page tree mended); pdf.js draws the pictures from what the preview showed.
  const doc = await loadPdf(input.bytes, { password: input.password ?? undefined });
  check();
  const { nodes, mended } = pageNodes(doc);
  const shown = await shownOf(input, { doc, mended });
  check();
  const pdf = await openView(shown, 'pdf_import_failed');
  try {
    if (pdf.numPages !== nodes.length) throw new UserError('pdf_import_failed');
    const viewPages = new Map();
    const viewPage = async (index) => {
      if (!viewPages.has(index)) viewPages.set(index, await pdf.getPage(index + 1));
      return viewPages.get(index);
    };
    const frames = new Map();
    const frameAt = (index) => {
      if (!frames.has(index)) {
        const { view, rotate } = pageView(doc.context, nodes[index]);
        frames.set(index, PageFrame.fromView(view, rotate));
      }
      return frames.get(index);
    };

    // The boxes, on the pages as shown, as the preview had them.
    const byPage = new Map();
    for (const { page, item } of entriesOf(options.boxes)) {
      if (page >= nodes.length) continue;
      if (!frames.has(page) || !viewPages.has(page)) frames.set(page, frameOf(await viewPage(page)));
      const box = toBox(frames.get(page), page, item);
      if (!box) continue;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page).push(box);
    }
    if (!byPage.size) throw new RangeError('Redact PDF needs at least one box on a page of the PDF');

    const reader = new ContentReader(doc);
    // Pages that would keep out of sight what the boxes hide become pictures too, without boxes.
    const pictured = [...new Set([...byPage.keys(), ...keepingHidden(reader, nodes, byPage, frameAt, check)])].sort((a, b) => a - b);
    const total = pictured.length + 2;
    onProgress?.(1, total);
    const redactedPages = new Set();
    const removedAnnotations = new Set();
    const drawnThere = new Set();
    for (const index of pictured) {
      check();
      const node = nodes[index];
      if (byPage.has(index)) redactedPages.add(node);
      for (const a of items(doc.context, get(node, 'Annots'))) if (a instanceof PDFDict) removedAnnotations.add(a);
      drawnBy(reader, node, drawnThere);
    }
    await yieldToUI();

    let done = 1;
    for (const index of pictured) {
      check();
      const page = await viewPage(index);
      const frame = frameOf(page);
      let picture;
      try {
        picture = await renderRedacted(page, frame, byPage.get(index) ?? [], signal);
      } catch (e) {
        check();
        throw new UserError('redact_page_failed');
      }
      try {
        const image = await encodePicture(doc, picture, signal);
        replaceWithPicture(doc, nodes[index], frame, image);
      } finally {
        releaseCanvas(picture.canvas);
      }
      page.cleanup();
      viewPages.delete(index);
      onProgress?.(++done, total);
      await yieldToUI();
    }

    // Images and forms that only the pages now pictures drew must not stay behind, as they would
    // where pages share one list of resources: they are emptied in place.
    const isPictured = new Set(pictured);
    const stay = nodes.filter((_, i) => !isPictured.has(i));
    emptyUnused(reader, drawnThere, stay, check);
    check();
    removeLeaks(doc, redactedPages, removedAnnotations, searched, nodes);
    check();
    const bytes = await savePdf(doc);
    check();
    onProgress?.(total, total);
    return {
      name,
      bytes,
      type: 'application/pdf',
      pageCount: nodes.length,
      redactedPages: [...byPage.keys()].sort((a, b) => a - b),
      picturedPages: pictured,
    };
  } finally {
    await closeView(pdf);
  }
}

/** Each page's text as Find text reads it (from what the preview shows), for checks: [text, ...]. */
export async function readPageTexts(input) {
  const pdf = await openView(await shownOf(input), 'redact_find_failed');
  try {
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      let page;
      try {
        page = await pdf.getPage(i);
      } catch {
        throw new UserError('redact_find_failed');
      }
      out.push(pageTextOf(await pageGlyphs(page), frameOf(page)));
      page.cleanup();
    }
    return out;
  } finally {
    await closeView(pdf);
  }
}

