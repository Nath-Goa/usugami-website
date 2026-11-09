// Loading and saving PDFs with pdf-lib, the same way for every tool.
import {
  PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFStream, EncryptedPDFError,
} from '../lib/pdf-lib.js';
import { PasswordError, UserError } from '../core/errors.js';
import { unmark as takeMarkOff } from './page-mark.js';

// What loadPdf found, by document: Compress PDF can't keep such a PDF as it was.
const unmarkedDocs = new WeakSet();
const encryptedDocs = new WeakSet();

/**
 * Opens a PDF for changing. Password-protected PDFs are decrypted with `password`; the PDFs made
 * from them have no password (as in the app). Throws PasswordError when the password is missing or
 * wrong, and UserError('pdf_import_failed') when the file can't be read as a PDF, also one pdf-lib
 * opens but that has no catalog to read ('%PDF-1.4' and nothing more, a /Root that is a number).
 * No fontkit is registered: an engine that embeds a font with pdf-lib registers it itself, so the
 * other tools don't load it.
 *
 * Usugami's own mark (engine/page-mark.js), which a PDF it made before may carry, is taken off in
 * memory (PdfToolsEngine.loadUnmarked): what a tool makes then starts without it, also where a
 * page's content is copied into one stream, and gets the mark the setting asks for once it is made
 * (the result screen puts it on), or none, so marks never stack. `unmark: false` leaves it on.
 * `parseSpeed`: objects read before pdf-lib lets the screen in (pdf-lib's default when not given).
 * @param {Uint8Array} bytes
 * @param {{ password?: string, unmark?: boolean, parseSpeed?: number }} [options]
 */
export async function loadPdf(bytes, { password, unmark = true, parseSpeed } = {}) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, {
      ...(password != null ? { password } : {}),
      ...(parseSpeed != null ? { parseSpeed } : {}),
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(e?.message ?? '')) {
      // Encrypted with an empty user password (only an owner password): opens without asking.
      if (password == null) {
        const opened = await loadPdf(bytes, { password: '', unmark, parseSpeed });
        encryptedDocs.add(opened);
        return opened;
      }
      throw new PasswordError(false);
    }
    if (/password/i.test(e?.message ?? '')) throw new PasswordError(password != null && password !== '');
    throw new UserError('pdf_import_failed');
  }
  // pdf-lib looks for a catalog when the trailer names none; without one there is nothing to read.
  if (!(doc.catalog instanceof PDFDict)) throw new UserError('pdf_import_failed');
  if (password != null && password !== '') encryptedDocs.add(doc);
  if (unmark) {
    let found = false;
    try {
      found = takeMarkOff(doc);
    } catch {
      // A page tree too broken to walk: the tool says so when it works on it.
    }
    if (found) unmarkedDocs.add(doc);
  }
  return doc;
}

/** Whether loadPdf took Usugami's mark off `doc` (a PDF Usugami made with its mark on). */
export function wasUnmarked(doc) {
  return unmarkedDocs.has(doc);
}

/**
 * Whether `doc` was encrypted when loadPdf read it: opened with a password, or only restricted by
 * an owner password (opened without asking). pdf-lib forgets it once the PDF is decrypted.
 */
export function wasEncrypted(doc) {
  return encryptedDocs.has(doc);
}

/** Whether `bytes` is a PDF that needs a password to open (an empty user password counts as none). */
export async function needsPassword(bytes) {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
    return false;
  } catch (e) {
    if (!(e instanceof EncryptedPDFError || /encrypt/i.test(e?.message ?? ''))) return false;
    try {
      await PDFDocument.load(bytes, { password: '', updateMetadata: false, throwOnInvalidObject: false });
      return false;
    } catch {
      return true;
    }
  }
}

/**
 * A new, empty PDF. No fontkit is registered (see loadPdf): `doc.registerFontkit(fontkit)` before
 * `doc.embedFont(bytes)`, as engine/ocr/text-layer.js does.
 */
export async function createPdf() {
  return PDFDocument.create({ updateMetadata: false });
}

/**
 * Saves `doc` as the bytes of a new PDF: without a password, without objects nothing refers to
 * any more (pages deleted, the old encryption dictionary, old cross-reference streams), and with
 * Usugami as its producer. `objectsPerTick`: objects written before pdf-lib lets the screen in
 * (pdf-lib's default when not given).
 */
export async function savePdf(doc, { prune = true, objectStreams = true, objectsPerTick } = {}) {
  doc.setProducer('Usugami');
  if (prune) pruneUnreferenced(doc);
  return doc.save({
    useObjectStreams: objectStreams,
    addDefaultPage: false,
    updateFieldAppearances: false,
    ...(objectsPerTick != null ? { objectsPerTick } : {}),
  });
}

/** Removes every indirect object that can't be reached from the trailer (Root, Info). */
export function pruneUnreferenced(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [];
  const visit = (obj) => {
    if (obj instanceof PDFRef) {
      const key = obj.tag;
      if (seen.has(key)) return;
      seen.add(key);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) visit(v);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) visit(obj.get(i));
    } else if (obj instanceof PDFStream) {
      visit(obj.dict);
    }
  };
  const trailer = ctx.trailerInfo;
  for (const v of [trailer.Root, trailer.Info]) if (v) visit(v);
  while (stack.length) visit(stack.pop());
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) ctx.delete(ref);
  }
}

export { PDFName };
