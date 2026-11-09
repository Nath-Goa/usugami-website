// Word to PDF: a Word document (.docx) read and laid out on the device, as the app's
// DocxConverter.kt does it. Nothing is uploaded.
//
// What converts: page size and margins (per section, portrait or landscape); paragraphs with their
// alignment, spacing, indents and line spacing, shading, borders, "keep with next" and page breaks
// before; text that is bold, italic, underlined, struck through, coloured, highlighted, raised or
// lowered, in capitals, or any size; Word's styles (document defaults, paragraph and character
// styles, headings, Title, table styles' borders and spacing) and theme fonts; bulleted and
// numbered lists, at every level, with their restarts; tables, with their column widths, merged
// cells, borders and shading, header rows repeated on each page, and rows split across pages;
// pictures, in the text or floating, turned or flipped, and in groups and drawing canvases; picture
// watermarks; page and section breaks; headers and footers (first-page and even-page ones too) with
// page numbers in their format; tab stops with their leaders; the text of text boxes, equations and
// fields; links, which stay clickable (to web addresses, and to bookmarks inside the document).
//
// What is simplified, as in the app: the bundled fonts stand in for the document's, so lines can
// break in other places than in Word. Text doesn't wrap around floating pictures: they go on lines
// of their own, or over the text when Word puts them in front of or behind it. Text boxes' text
// follows the paragraph they're anchored to. Columns become a single column; charts, SmartArt and
// pictures the browser can't decode (such as EMF and WMF) become light grey boxes. Footnotes,
// endnotes, comments and deleted text are left out.
import { OfficePackage } from './ooxml.js';
import { OfficePdf, OfficeImages } from './office-pdf.js';
import { OfficeTheme } from './drawingml.js';
import { OfficeEmbeddedContent } from './problems.js';
import { DocxStyles, DocxNumbering } from './docx-styles.js';
import { Reader, readSections, readEvenAndOddHeaders, bookmarkNames, shows } from './docx-read.js';
import { DocxLayout, Flow } from './docx-layout.js';
import { officeOutputName } from './index.js';
import { checkCancelled } from '../../core/errors.js';

/**
 * Converts a Word document into a PDF.
 * @param {{ name: string, bytes: Uint8Array }} input   a .docx (checked by verifyOfficeFile already when called through convertOffice)
 * @param {{ name?: string }} [options]   `name`: the PDF's name as typed, without ".pdf" (default: the document's own)
 * @param {{ onProgress?: (done: number, total: number|null, info?: { compressing: boolean }) => void, signal?: AbortSignal }} [hooks]
 *   onProgress(page, null) as each page is started (the page count isn't known until the end), then
 *   onProgress(pages, pages, { compressing: true }) while the PDF is saved.
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: 'application/pdf', pageCount: number }>}
 * Throws OfficeEmbeddedContent for a document whose text is kept as a web page or RTF file inside
 * it, ZipError or XmlError for a damaged file, UserError('web_fonts_unavailable') when the fonts
 * can't be loaded, CancelledError when `hooks.signal` aborts.
 */
export async function convertDocx(input, options = {}, hooks = {}) {
  const { signal, onProgress } = hooks;
  checkCancelled(signal);
  const pkg = await OfficePackage.open(input.bytes, { signal });
  try {
    const pdf = await OfficePdf.create();
    const images = new OfficeImages(pkg, pdf.doc, { signal });
    const main = pkg.mainPart() ?? 'word/document.xml';
    const theme = await OfficeTheme.read(pkg, pkg.targetOfType(main, '/theme'));
    const styles = await DocxStyles.read(pkg, pkg.targetOfType(main, '/styles'), theme);
    const numbering = await DocxNumbering.read(pkg, pkg.targetOfType(main, '/numbering'), theme, styles);
    checkCancelled(signal);
    const root = await pkg.xml(main);
    const sections = readSections(pkg, main, root);
    const evenAndOddHeaders = await readEvenAndOddHeaders(pkg, main);
    const ctx = {
      pkg, theme, styles, numbering, images, pdf, sections, evenAndOddHeaders, signal, onProgress,
      bookmarks: bookmarkNames(root),
    };
    const layout = new DocxLayout(ctx);
    const flow = new Flow(layout);
    const reader = new Reader(ctx, main);
    let shown = false;
    if (root) {
      for (const body of root.children('body')) {
        for (const x of body.children()) {
          await layout.breathe();
          const items = [];
          reader.block(x, null, (item) => items.push(item));
          for (const item of items) {
            if (!shown) shown = shows(item);
            await flow.add(item);
          }
        }
      }
    }
    // A body kept as a web page or RTF file inside the document (w:altChunk), as some apps export
    // to Word, isn't read: the file is refused with a message rather than becoming a blank PDF.
    if (!shown && reader.altChunks > 0) throw new OfficeEmbeddedContent();
    await flow.finish();
    const { bytes, pageCount } = await pdf.finish({ onProgress, signal });
    return { name: officeOutputName(input, 'word', options?.name ?? null), bytes, type: 'application/pdf', pageCount };
  } finally {
    pkg.close();
  }
}
