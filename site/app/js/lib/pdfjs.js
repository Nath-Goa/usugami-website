// pdf.js, served from site/app/vendor, set up to load its worker, character maps, standard fonts
// and decoders from this site only.
import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';

const vendor = new URL('../../vendor/pdfjs/', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', vendor).href;

export { pdfjsLib };

/**
 * Opens a PDF with pdf.js. pdf.js takes over (detaches) the buffer it is given, so this passes a
 * copy and `bytes` stays usable. Rejects with a pdfjsLib.PasswordException when a password is
 * needed or wrong (code 1 = needed, 2 = wrong).
 *
 * pdf.js 6's PDFDocumentProxy has no destroy(): free it with `doc.loadingTask.destroy()` when done.
 *
 * Any other getDocument option can be given (e.g. `fontExtraProperties: true`) and is passed
 * through; the site's own (where the worker, character maps, fonts and decoders come from) hold
 * unless given too.
 * @param {Uint8Array} bytes
 * @param {{ password?: string, [option: string]: any }} [options]
 * @returns {Promise<object>} the PDFDocumentProxy
 */
export function openPdfJs(bytes, { password, ...more } = {}) {
  return pdfjsLib.getDocument({
    cMapUrl: new URL('cmaps/', vendor).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', vendor).href,
    wasmUrl: new URL('wasm/', vendor).href,
    iccUrl: new URL('iccs/', vendor).href,
    useWorkerFetch: true,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: false,
    ...more,
    // Always a copy, so the caller's bytes aren't detached.
    data: bytes.slice(),
    password,
  }).promise;
}
