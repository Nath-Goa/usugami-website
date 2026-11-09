// pdf.js, served from site/app/vendor, set up to load its worker, character maps, standard fonts
// and decoders from this site only.
import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';

const vendor = new URL('../../vendor/pdfjs/', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', vendor).href;

export { pdfjsLib };

// One worker thread for every PDF open. Left to itself pdf.js starts a worker (loading and
// compiling its 1.3 MB script) for each document: ten PDFs in Merge PDF were ten threads and
// 130 MB more. With a worker passed in, a document's loadingTask.destroy() frees that document
// only, and the worker stays for the next.
let shared = null;

/** The shared pdf.js worker, made again if it has gone (destroyed, or its thread failed). */
export function pdfWorker() {
  if (shared && !shared.destroyed) return shared;
  const worker = new pdfjsLib.PDFWorker({ name: 'usugami' });
  shared = worker;
  // A thread that fails (a document too large for it, say) isn't used for the next one.
  worker.promise.then(() => {
    worker.port?.addEventListener?.('error', () => { if (shared === worker) shared = null; });
  }, () => { if (shared === worker) shared = null; });
  return worker;
}

/**
 * Opens a PDF with pdf.js. pdf.js takes over (detaches) the buffer it is given, so this passes a
 * copy and `bytes` stays usable. Rejects with a pdfjsLib.PasswordException when a password is
 * needed or wrong (code 1 = needed, 2 = wrong); what a failed open held is freed then.
 *
 * pdf.js 6's PDFDocumentProxy has no destroy(): free it with `doc.loadingTask.destroy()` when done.
 * Every document shares one worker thread (pdfWorker()), unless `worker` is given.
 *
 * Any other getDocument option can be given (e.g. `fontExtraProperties: true`) and is passed
 * through; the site's own (where the worker, character maps, fonts and decoders come from) hold
 * unless given too.
 * @param {Uint8Array} bytes
 * @param {{ password?: string, [option: string]: any }} [options]
 * @returns {Promise<object>} the PDFDocumentProxy
 */
export function openPdfJs(bytes, { password, ...more } = {}) {
  const task = pdfjsLib.getDocument({
    cMapUrl: new URL('cmaps/', vendor).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', vendor).href,
    wasmUrl: new URL('wasm/', vendor).href,
    iccUrl: new URL('iccs/', vendor).href,
    useWorkerFetch: true,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: false,
    // worker: null gives the document a worker of its own.
    worker: 'worker' in more ? more.worker : pdfWorker(),
    ...more,
    // Always a copy, so the caller's bytes aren't detached.
    data: bytes.slice(),
    password,
  });
  // pdf.js doesn't free a document that failed to open (a damaged file, a password needed or
  // wrong): its copy of the file would stay in the worker until the page is closed.
  return task.promise.catch((error) => {
    task.destroy().catch(() => {});
    throw error;
  });
}
