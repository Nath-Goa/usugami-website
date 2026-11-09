// The pages of a PDF as viewers find them, for Flatten PDF and Compress PDF. The app mends a damaged
// page tree when a PDF is picked (PdfToolsEngine.inspect, repairPageTree), so its tools work on the
// pages the previews show. Here the screens show the mended view (core/pdfdoc.js) but hand the
// engines the PDF as picked: they mend it again as they read it. pdf-lib's own getPages() would
// overflow its stack on a tree that loops, throw on a lone page in the tree's place, and skip a
// page that lacks its /Type.
import { PDFPage, PDFPageLeaf, PDFPageTree, PDFDict, PDFName, PDFRef } from '../../lib/pdf-lib.js';
import { repairPageTree, setPages } from '../cleanup.js';
import { UserError } from '../../core/errors.js';

// The documents whose page tree viewerPages had to change.
const mendedDocs = new WeakSet();

/**
 * The pages of `doc` in order, as pdf-lib PDFPage objects, its page tree mended first when it would
 * be read otherwise than viewers read it (laid out again flat, a page without its type given one),
 * so pdf-lib's own getPages() and getPageCount() find the same pages afterwards. Throws
 * UserError('pdf_import_failed') for a PDF without pages that can be found.
 * @param {import('../../lib/pdf-lib.js').PDFDocument} doc
 * @returns {import('../../lib/pdf-lib.js').PDFPage[]}
 */
export function viewerPages(doc) {
  const ctx = doc.context;
  let pages;
  let changed;
  try {
    ({ pages, changed } = repairPageTree(doc));
    // A page held inline in the tree needs an object of its own to be found by.
    if (pages.some((p) => !p.ref)) {
      setPages(doc, pages);
      pages = repairPageTree(doc).pages;
      changed = true;
    }
  } catch (e) {
    // No catalog or page tree to speak of: as damaged as a file that isn't a PDF.
    if (e instanceof UserError) throw e;
    throw new UserError('pdf_import_failed');
  }
  // A root without its type, or one made for a lone page in the tree's place, is a plain
  // dictionary: pdf-lib finds pages only through a tree of its own.
  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  const root = rootRef instanceof PDFRef ? ctx.lookup(rootRef) : undefined;
  if (root instanceof PDFDict && !(root instanceof PDFPageTree)) {
    ctx.assign(rootRef, PDFPageTree.fromMapWithContext(new Map(root.entries()), ctx));
    changed = true;
  }
  const out = pages.map(({ ref, dict }) => {
    let leaf = dict;
    if (!(dict instanceof PDFPageLeaf)) {
      // A page that lacked its /Type was read as a plain dictionary.
      leaf = PDFPageLeaf.fromMapWithContext(new Map(dict.entries()), ctx);
      ctx.assign(ref, leaf);
      changed = true;
    }
    return PDFPage.of(leaf, ref, doc);
  });
  if (changed) mendedDocs.add(doc);
  return out;
}

/**
 * Whether viewerPages had to mend `doc`'s page tree: the bytes it was read from are then read
 * otherwise by PDF libraries than by viewers, and aren't handed back as they were.
 */
export function wasMended(doc) {
  return mendedDocs.has(doc);
}
