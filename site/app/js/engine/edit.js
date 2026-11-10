// Edit PDF's engine: draws text, pen and highlighter strokes, shapes and pictures into a PDF's
// pages as ordinary page content, in the order they were added, exactly where the preview showed
// them on each page as it is shown (turned or cropped too). A port of PageEditing.kt and the edit
// parts of PdfToolsEngine.kt; the items and their geometry are engine/edit/layout.js (PageEdits.kt).
//
// Strokes and shapes become vector paths with round ends and corners, text becomes real text (see
// edit/text.js) and pictures become images (edit/pictures.js). Form fields and comments under an
// item's ink (not those inside an outline or beside a stroke) become part of the page first, so the
// item covers them as the preview showed. Pages without items aren't touched.
import { loadPdf, savePdf } from './pdf-common.js';
import { UserError, checkCancelled } from '../core/errors.js';
import { yieldToUI } from '../core/dom.js';
import { sanitizeName } from '../core/names.js';
import { PdfCanvas, pageFrame } from './text/index.js';
import { paintedAreas, pageArea } from './edit/layout.js';
import { textLayout, canDrawText, TEXT_MAX_LENGTH } from './edit/text.js';
import { pdfImage } from './edit/pictures.js';
import { drawItem } from './edit/draw.js';
import { viewerPages } from './flatten/pages.js';

export * from './edit/layout.js';
export { EditHistory, MAX_UNDO } from './edit/history.js';
export {
  REFERENCE, TEXT_MAX_LENGTH, TEXT_STYLE, textLayout, textLayoutSync, textLayoutNow, unitSize, canDrawText, drawText,
} from './edit/text.js';
export {
  importPicture, decodePicture, pdfImage, pdfLongSide, PHOTO_DPI, LOSSLESS_DPI, MAX_SIDE, JPEG_QUALITY, PREVIEW_SIDE,
} from './edit/pictures.js';
export { drawItem, drawLiveStroke, tracePath } from './edit/draw.js';

/**
 * The size of each of the PDF's pages as shown, in points, and where its crop box is: what the
 * preview draws the page at, so items go where they show on it.
 * @param {{ bytes: Uint8Array, password?: string }} input
 * @returns {Promise<Array<{ width: number, height: number, rotation: number, box: number[], matrix: number[] }>>}
 *   box: the crop box [left, bottom, right, top] in the page's own coordinates; matrix: shown → page
 */
export async function shownPageSizes(input) {
  const doc = await loadPdf(input.bytes, input.password ? { password: input.password } : {});
  return pagesOf(doc).map((page) => {
    const f = pageFrame(page);
    const crop = page.getCropBox();
    return { width: f.width, height: f.height, rotation: f.rotation, box: [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height], matrix: f.matrix };
  });
}

/**
 * The pages of `doc` as viewers and the preview find them, a damaged page tree mended first (as
 * Flatten PDF and Compress PDF read it): pdf-lib's own getPages() skips a page that lacks its
 * /Type, and an item would then land on the page after the one it was put on. A PDF without pages
 * that can be found can't be opened (UserError('pdf_import_failed')).
 */
function pagesOf(doc) {
  try {
    return viewerPages(doc);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError('pdf_import_failed');
  }
}

/** Whether a page has annotations (comments, form fields, links) at all. */
function hasAnnotations(page) {
  try {
    const annots = page.node.Annots();
    return !!annots && annots.size() > 0;
  } catch {
    return false;
  }
}

/**
 * Draws Edit PDF's items on the input PDF's pages and saves it as a new PDF without a password.
 * Items on pages the PDF doesn't have are left out. Throws UserError('watermark_no_font') if no
 * font can draw some of the text, UserError('edit_picture_failed') for a picture that can't be read,
 * UserError('pdf_import_failed') for a PDF pdf-lib can't open, and PasswordError.
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {{ items: object[], name?: string }} options  name: the new file's name (no .pdf needed)
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: 'application/pdf', pageCount: number }>}
 */
export async function editPages(input, options = {}, hooks = {}) {
  const { onProgress, signal } = hooks;
  const items = options.items ?? [];
  checkCancelled(signal);
  const doc = await loadPdf(input.bytes, input.password ? { password: input.password } : {});
  const pages = pagesOf(doc);
  const count = pages.length;
  const kept = items.filter((it) => Number.isInteger(it.page) && it.page >= 0 && it.page < count);
  if (!kept.length) throw new RangeError('Edit PDF has nothing to draw');

  // The text first: refused before anything is drawn if it can't be, its fonts loaded once.
  const layouts = new Map();
  for (const item of kept) {
    if (item.type !== 'text') continue;
    const text = item.text.slice(0, TEXT_MAX_LENGTH);
    if (!canDrawText(text)) throw new UserError('watermark_no_font');
    const key = `${item.color}\n${text}`;
    if (!layouts.has(key)) layouts.set(key, await textLayout(text, item.color));
    checkCancelled(signal);
  }

  const total = kept.length + 1;
  let done = 0;
  onProgress?.(0, total);
  const images = new Map();
  const pictures = new Map();
  // Pages in the order their first item was added, each page's items in the order they were added.
  const byPage = new Map();
  for (const item of kept) {
    if (!byPage.has(item.page)) byPage.set(item.page, []);
    byPage.get(item.page).push(item);
  }
  for (const [index, onPage] of byPage) {
    checkCancelled(signal);
    const page = pages[index];
    const frame = pageFrame(page);
    // The items go over the form fields and comments under their ink, as the preview shows them.
    if (hasAnnotations(page)) {
      const inked = onPage.flatMap((item) => paintedAreas(item).map((a) => pageArea(frame.matrix, a.x, a.y, a.width, a.height)));
      const { bakeUnder } = await import('./flatten.js');
      await bakeUnder(doc, index, inked, { signal });
    }
    for (const item of onPage) {
      if (item.type === 'picture' && !pictures.has(item.id)) pictures.set(item.id, await pdfImage(doc, item, images, { signal }));
      checkCancelled(signal);
    }
    // Added after the page's own drawing, which the canvas wraps in q/Q, so whatever state that
    // leaves behind can't move or recolour what is added.
    const canvas = new PdfCanvas(page);
    const look = {
      text: (item) => layouts.get(`${item.color}\n${item.text.slice(0, TEXT_MAX_LENGTH)}`),
      picture: (item) => pictures.get(item.id),
    };
    for (const item of onPage) {
      drawItem(canvas, item, look);
      onProgress?.(++done, total);
    }
    await yieldToUI();
  }
  checkCancelled(signal);
  const bytes = await savePdf(doc);
  checkCancelled(signal);
  onProgress?.(total, total);
  return {
    name: sanitizeName(options.name ?? '', 'Edited') + '.pdf',
    bytes,
    type: 'application/pdf',
    pageCount: count,
  };
}
