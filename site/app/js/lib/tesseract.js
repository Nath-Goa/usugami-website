// Tesseract (text recognition), served from site/app/vendor and loaded only when OCR is used.
const vendor = new URL('../../vendor/tesseract/', import.meta.url);

/** Tesseract's language codes for the app's text languages. Hindi mode also reads English. */
export const OCR_LANGS = { en: 'eng', fr: 'fra', es: 'spa', hi: 'hin+eng' };

/**
 * A Tesseract worker for one of the app's text languages ('en', 'fr', 'es', 'hi'). Everything
 * it needs (worker, engine, language data) comes from this site. Call worker.terminate() when done.
 *
 * - `logger(message)`: tesseract.js's progress messages.
 * - `errorHandler(error)`: given, a failed job's error goes to it (as well as rejecting the job's
 *   promise) instead of being thrown in the worker's message handler, where nothing can catch it.
 * - `config`: Tesseract parameters set when the engine starts (createWorker's 4th argument), for
 *   those that can't be changed later with setParameters.
 * Each is passed on only when given, so tesseract.js's defaults hold otherwise.
 * @param {string} lang
 * @param {{ logger?: (m: object) => void, errorHandler?: (e: any) => void, config?: object }} [options]
 */
export async function createOcrWorker(lang, { logger, errorHandler, config } = {}) {
  const { createWorker, OEM } = (await import('../../vendor/tesseract/tesseract.esm.min.js')).default;
  const options = {
    workerPath: new URL('worker.min.js', vendor).href,
    corePath: new URL('core/', vendor).href,
    langPath: new URL('lang', vendor).href,
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
    ...(logger ? { logger } : {}),
    ...(errorHandler ? { errorHandler } : {}),
  };
  const langs = OCR_LANGS[lang] ?? 'eng';
  return config ? createWorker(langs, OEM.LSTM_ONLY, options, config) : createWorker(langs, OEM.LSTM_ONLY, options);
}
