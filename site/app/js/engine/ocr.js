// Text recognition (OCR) for "Make text searchable (OCR)" in Images to PDF and Scan document: reads
// the words on page images with Tesseract (LSTM models for English, French, Spanish, and Hindi
// with English) and adds them to the PDF as an invisible text layer (PdfOcr.kt in the app).
// Everything runs in this browser; the engine and language data come from this site.
//
//   const recognizer = await createRecognizer('en', { onProgress, signal });
//   try {
//     for (const p of pages) {
//       const recognition = await recognizer.recognize(p.image, { signal });
//       lines += await addTextLayer(pdfDoc, p.page, recognition, p.placement);
//     }
//   } finally {
//     recognizer.terminate();
//   }
import { UserError, CancelledError, checkCancelled } from '../core/errors.js';
import { download, filesFor, startWorker } from './ocr/loader.js';
import { preparePicture, reducedCopy, canvasPpm, toPpm } from './ocr/picture.js';
import { linesFromBlocks, readingScore } from './ocr/lines.js';
import { OCR_LANGUAGES } from './ocr/languages.js';

export { addTextLayer, printable } from './ocr/text-layer.js';
export { ocrScale } from './ocr/scale.js';
export { OCR_LANGUAGES, OCR_LANGUAGE_NAMES, defaultOcrLanguage } from './ocr/languages.js';

/**
 * A page read with less mean confidence than this (0 to 100) is tried turned too: a page
 * photographed upside down or sideways is then read the right way up (as Usugami OCR does).
 */
const TRY_TURNS_BELOW = 70;

/** Turns are tried on a copy this many pixels on its long side, which is quick to read. */
const TRIAL_SIDE = 1600;

/** A turn is taken only when it reads clearly better than the page as it is, and fairly well. */
const TURN_MARGIN = 1.5;
const TURN_MIN_CONFIDENCE = 60;

/**
 * Turns are tried only when the page as it is reads as this many letters or digits at least, in
 * words read with this mean confidence: a picture without text (a photo, a speckled surface)
 * reads as a few stray marks of almost no confidence, and trying turns on it only takes longer.
 * Text the wrong way up reads as letters of some confidence.
 */
const TRY_TURNS_MIN_LETTERS = 12;
const TRY_TURNS_MIN_WORD_CONFIDENCE = 25;

/**
 * Gets text recognition in `lang` ('en', 'fr', 'es' or 'hi'; Hindi also reads English) ready and
 * returns a recognizer that reads page after page with one worker. The first time, the engine and
 * the language's data are downloaded from this site: onProgress(bytes, total) reports it (total
 * is an estimate until the sizes are known). Cancellable with `signal`, also while reading.
 * @param {string} lang
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ language: string, recognize(image, options?): Promise<Recognition>, terminate(): void }>}
 * @throws UserError('ocr_problem_download') without a connection, UserError('ocr_problem_failed')
 *   when the engine can't start, CancelledError when cancelled
 */
export async function createRecognizer(lang, { onProgress, signal } = {}) {
  const language = OCR_LANGUAGES.includes(lang) ? lang : 'en';
  checkCancelled(signal);
  if (typeof WebAssembly !== 'object' || typeof Worker === 'undefined') throw new UserError('ocr_problem_failed');
  await download(await filesFor(language), { onProgress, signal });
  checkCancelled(signal);

  let worker = null;
  let starting = null;
  let generation = 0; // which start is wanted: one superseded meanwhile is ended
  let closed = false;
  let current = null; // the reading in progress: { onProgress, fail(error) }
  let queue = Promise.resolve();

  const logger = (m) => {
    if (m?.status === 'recognizing text' && current?.onProgress) current.onProgress(Math.max(0, Math.min(1, m.progress || 0)), 1);
  };

  const stop = () => {
    const w = worker;
    worker = null;
    starting = null;
    generation++;
    if (w) w.terminate().catch(() => {});
  };

  const adopt = (w) => {
    const native = w.worker;
    if (native) {
      // A failed job only rejects its promise (startWorker gives tesseract.js an errorHandler).
      // A worker that dies (out of memory, say) answers nothing more.
      native.addEventListener('error', (event) => {
        event.preventDefault?.();
        if (worker === w) worker = null;
        w.terminate().catch(() => {});
        current?.fail(new UserError('ocr_failed'));
      });
    }
    return w;
  };

  const ensureWorker = (callSignal) => {
    if (worker) return Promise.resolve(worker);
    if (!starting) {
      const wanted = generation;
      const unwanted = (w) => {
        if (!closed && wanted === generation) return false;
        w.terminate().catch(() => {});
        return true;
      };
      starting = startWorker(language, { logger, signal }).then(async (w) => {
        if (unwanted(w)) throw new CancelledError();
        await w.setParameters({
          // Tesseract's own notes (such as "Line cannot be recognized" for a speck) would go to
          // the console as errors.
          debug_file: '/dev/null',
          // The Hindi data never reads the digit 1 (lest a danda be taken for one), which would
          // turn the English and numbers Hindi mode keeps into 2079 for 2019; the danda still reads as ।.
          tessedit_char_blacklist: '',
        }).catch(() => {});
        if (unwanted(w)) throw new CancelledError();
        worker = adopt(w);
        starting = null;
        return worker;
      }, (e) => {
        if (wanted === generation) starting = null;
        throw e;
      });
    }
    return abortable(starting, callSignal);
  };

  const onAbort = () => {
    closed = true;
    current?.fail(new CancelledError());
    stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Ready before any PDF work, so a problem is reported straight away (as ensureReady in the app).
  await ensureWorker();

  /** One reading by the worker of a PPM picture; cancelling ends the worker. */
  const read = (ppm, callSignal, onPageProgress) => new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      callSignal?.removeEventListener('abort', abortCall);
      if (current === job) current = null;
      if (error) reject(error);
      else resolve(value);
    };
    const abortCall = () => {
      finish(new CancelledError());
      // The worker can't stop a reading half way: a new one starts for the next page.
      stop();
    };
    const job = { onProgress: onPageProgress, fail: (e) => finish(e) };
    if (closed || signal?.aborted || callSignal?.aborted) {
      finish(new CancelledError());
      return;
    }
    callSignal?.addEventListener('abort', abortCall, { once: true });
    ensureWorker(callSignal).then((w) => {
      if (done) return;
      current = job;
      w.recognize(ppm, {}, { blocks: true, text: false }).then(
        (result) => finish(null, result?.data ?? {}),
        () => finish(new UserError('ocr_failed')),
      );
    }, (e) => finish(e));
  });

  const recognizeNow = async (image, { signal: callSignal, onProgress: onPageProgress } = {}) => {
    if (closed || signal?.aborted) throw new CancelledError();
    checkCancelled(callSignal);
    let picture;
    try {
      picture = await preparePicture(image, { signal: callSignal });
    } catch (e) {
      throw e instanceof UserError || e instanceof CancelledError ? e : new UserError('ocr_failed');
    }
    try {
      let full = await canvasPpm(picture.canvas);
      const pass = (pixels, turns, progress) => read(
        turns ? toPpm(pixels.rgb, pixels.width, pixels.height, turns).ppm : pixels.ppm, callSignal, progress,
      );
      const upright = await pass(full, 0, onPageProgress);
      let best = { data: upright, turns: 0 };
      if (shouldTryTurns(upright)) {
        const turns = await bestTurn(picture, pass, callSignal);
        if (turns) {
          const turned = await pass(full, turns, null);
          if (readingScore(turned.blocks) > readingScore(upright.blocks)) best = { data: turned, turns };
        }
      }
      full = null;
      const turned = best.turns % 2 === 1;
      const lines = linesFromBlocks(best.data.blocks, {
        width: turned ? picture.height : picture.width,
        height: turned ? picture.width : picture.height,
        quarterTurns: best.turns,
        scale: picture.scale,
      });
      onPageProgress?.(1, 1);
      return {
        width: picture.sourceWidth,
        height: picture.sourceHeight,
        // How far the picture was turned, clockwise, to read its text upright.
        turned: best.turns * 90,
        confidence: Math.round(Number(best.data.confidence) || 0),
        text: lines.map((l) => l.text).join('\n'),
        lines,
      };
    } finally {
      picture.release();
    }
  };

  return {
    language,
    /**
     * Reads `image` (an ImageBitmap, canvas, OffscreenCanvas, Blob, ImageData or <img>): see
     * docs/api/ocr.md for the Recognition it returns. Pages are read one at a time, in order.
     */
    recognize(image, options = {}) {
      const run = queue.then(() => recognizeNow(image, options));
      queue = run.catch(() => {});
      return run;
    },
    /** Ends the worker. Recognizing afterwards throws CancelledError. */
    terminate() {
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      current?.fail(new CancelledError());
      stop();
    },
  };
}

/** Whether a reading is poor enough that the page may lie turned, and found letters to read. */
function shouldTryTurns(data) {
  if ((Number(data.confidence) || 0) >= TRY_TURNS_BELOW) return false;
  let letters = 0;
  let words = 0;
  let confidence = 0;
  for (const block of data.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        for (const word of line?.words ?? []) {
          const found = ((word?.text ?? '').match(/[\p{L}\p{N}]/gu) ?? []).length;
          if (!found) continue;
          letters += found;
          words++;
          confidence += Number(word.confidence) || 0;
        }
      }
    }
  }
  return letters >= TRY_TURNS_MIN_LETTERS && confidence / words >= TRY_TURNS_MIN_WORD_CONFIDENCE;
}

/**
 * The quarter turns (1, 2 or 3) that read a small copy of the page clearly better than it reads
 * as it is, or 0. Upside down is tried first, the most likely after upright.
 */
async function bestTurn(picture, pass, signal) {
  const small = reducedCopy(picture.canvas, TRIAL_SIDE);
  if (!small) return 0;
  try {
    const pixels = await canvasPpm(small.canvas);
    const scores = [];
    for (const turns of [0, 2, 1, 3]) {
      checkCancelled(signal);
      const data = await pass(pixels, turns, null);
      scores.push({ turns, score: readingScore(data.blocks), confidence: Number(data.confidence) || 0 });
    }
    const upright = scores[0];
    const best = scores.slice(1).reduce((a, b) => (b.score > a.score ? b : a));
    return best.score > upright.score * TURN_MARGIN && best.confidence >= TURN_MIN_CONFIDENCE ? best.turns : 0;
  } finally {
    small.release();
  }
}

/** `promise`, or CancelledError as soon as `signal` is aborted. */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ text: string, confidence: number, corners: Point[], baseline: Point[] }} RecognizedWord
 * @typedef {{ text: string, confidence: number, corners: Point[], baseline: Point[], words: RecognizedWord[] }} RecognizedLine
 * @typedef {{ width: number, height: number, turned: number, confidence: number, text: string, lines: RecognizedLine[] }} Recognition
 */
