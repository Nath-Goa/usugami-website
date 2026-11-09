// Getting text recognition ready: the first time, its engine and language data (several MB) come
// from this site, with progress, before a Tesseract worker starts. The worker then loads the same
// files, from the browser's cache.
import { createOcrWorker, OCR_LANGS } from '../../lib/tesseract.js';
import { UserError, CancelledError } from '../../core/errors.js';

const VENDOR = new URL('../../../vendor/tesseract/', import.meta.url);
const FONT_URL = new URL('../../../fonts/UsugamiOcr-Regular.ttf', import.meta.url);

/**
 * About how large each file is, for progress when the server doesn't say (a compressed response
 * gives no size before it is unpacked). Progress never goes past what has arrived.
 */
const APPROXIMATE_SIZES = {
  'worker.min.js': 111_000,
  core: 3_900_000,
  eng: 2_953_000,
  fra: 707_000,
  spa: 2_100_000,
  hin: 1_390_000,
  font: 18_500,
};

/**
 * How long getting ready may go without any progress before it counts as failed (usually: no
 * internet), as for the app's downloads (STALL_TIMEOUT in OcrEngineFactory.kt).
 */
export const STALL_TIMEOUT = 60_000;

/** The files fully loaded in this tab, which aren't fetched again for progress. */
const loaded = new Set();

let fontBytesPromise = null;

/** The text layer's glyph-less font (fonts/UsugamiOcr-Regular.ttf), fetched once. */
export function ocrFontBytes() {
  if (!fontBytesPromise) {
    fontBytesPromise = fetch(FONT_URL)
      .then((r) => {
        if (!r.ok) throw new UserError('ocr_problem_failed');
        return r.arrayBuffer();
      })
      .then((b) => new Uint8Array(b))
      .catch((e) => {
        fontBytesPromise = null;
        throw e instanceof UserError ? e : new UserError('ocr_problem_download');
      });
  }
  return fontBytesPromise;
}

/** The Tesseract engine build the worker picks for this browser (as tesseract.js's getCore does). */
export async function coreFileName() {
  const valid = (bytes) => {
    try {
      return WebAssembly.validate(new Uint8Array(bytes));
    } catch {
      return false;
    }
  };
  // The same feature tests as wasm-feature-detect's relaxedSimd() and simd().
  if (valid([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11])) {
    return 'tesseract-core-relaxedsimd-lstm.wasm.js';
  }
  if (valid([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])) {
    return 'tesseract-core-simd-lstm.wasm.js';
  }
  return 'tesseract-core-lstm.wasm.js';
}

/** What text recognition in `lang` needs from this site, with about how large each file is. */
export async function filesFor(lang) {
  const codes = (OCR_LANGS[lang] ?? OCR_LANGS.en).split('+');
  return [
    { url: new URL('worker.min.js', VENDOR).href, size: APPROXIMATE_SIZES['worker.min.js'] },
    { url: new URL(`core/${await coreFileName()}`, VENDOR).href, size: APPROXIMATE_SIZES.core },
    ...codes.map((code) => ({ url: new URL(`lang/${code}.traineddata.gz`, VENDOR).href, size: APPROXIMATE_SIZES[code] ?? 2_000_000 })),
    { url: FONT_URL.href, size: APPROXIMATE_SIZES.font, font: true },
  ];
}

/**
 * Fetches `files` that this tab hasn't loaded yet, all at once, calling onProgress(bytes, total)
 * as they arrive (total is an estimate until every size is known; never below bytes). The bytes
 * are dropped, as the worker fetches the files itself, from the cache; the font is kept.
 * Throws UserError('ocr_problem_download') without a connection (or when nothing arrives for
 * `stallTimeout`), UserError('ocr_problem_failed') when the site doesn't have a file,
 * CancelledError when `signal` is aborted.
 */
export async function download(files, { onProgress, signal, stallTimeout = STALL_TIMEOUT } = {}) {
  const todo = files.filter((f) => !loaded.has(f.url));
  if (!todo.length) {
    if (files.some((f) => f.font)) await ocrFontBytes();
    return;
  }
  if (signal?.aborted) throw new CancelledError();
  const controller = new AbortController();
  let stalled = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let lastByte = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastByte > stallTimeout) {
      stalled = true;
      controller.abort();
    }
  }, Math.min(1000, stallTimeout));
  const totals = todo.map((f) => f.size);
  const done = todo.map(() => 0);
  let lastReport = 0;
  const report = (force) => {
    const now = Date.now();
    lastByte = now;
    if (!onProgress || (!force && now - lastReport < 50)) return;
    lastReport = now;
    const got = done.reduce((a, b) => a + b, 0);
    const total = todo.reduce((sum, f, i) => sum + Math.max(totals[i], done[i]), 0);
    onProgress(got, Math.max(got, total));
  };
  report(true);
  try {
    await Promise.all(todo.map(async (file, i) => {
      let response;
      try {
        response = await fetch(file.url, { signal: controller.signal });
      } catch (e) {
        throw failure(e, signal, stalled);
      }
      if (!response.ok) throw new UserError('ocr_problem_failed');
      const length = Number(response.headers.get('content-length'));
      if (!response.headers.get('content-encoding') && length > 0) totals[i] = length;
      const parts = file.font ? [] : null;
      try {
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          for (;;) {
            const { done: finished, value } = await reader.read();
            if (finished) break;
            done[i] += value.byteLength;
            parts?.push(value);
            report(false);
          }
        } else {
          const bytes = new Uint8Array(await response.arrayBuffer());
          done[i] = bytes.byteLength;
          parts?.push(bytes);
        }
      } catch (e) {
        throw failure(e, signal, stalled);
      }
      totals[i] = done[i];
      if (file.font) {
        const bytes = new Uint8Array(done[i]);
        let at = 0;
        for (const p of parts) {
          bytes.set(p, at);
          at += p.byteLength;
        }
        fontBytesPromise = Promise.resolve(bytes);
      }
      loaded.add(file.url);
      report(true);
    }));
  } catch (e) {
    // One file failing stops the others.
    controller.abort();
    throw e;
  } finally {
    clearInterval(watchdog);
    signal?.removeEventListener('abort', abort);
  }
}

function failure(e, signal, stalled) {
  if (stalled) return new UserError('ocr_problem_download');
  if (signal?.aborted || e?.name === 'AbortError') return new CancelledError();
  if (e instanceof UserError) return e;
  return new UserError('ocr_problem_download');
}

/**
 * Starts a Tesseract worker for `lang`. `logger` receives tesseract.js's progress messages. A
 * start that makes no progress for STALL_TIMEOUT fails (tesseract.js waits forever when a file
 * can't be loaded). If `signal` is aborted meanwhile, this throws CancelledError at once and the
 * worker is ended as soon as it exists.
 */
export function startWorker(lang, { logger, signal, stallTimeout = STALL_TIMEOUT } = {}) {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let last = Date.now();
    const finish = (error, worker) => {
      if (settled) return false;
      settled = true;
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(worker);
      return true;
    };
    const onAbort = () => finish(new CancelledError());
    const timer = setInterval(() => {
      if (Date.now() - last > stallTimeout) finish(new UserError('ocr_problem_download'));
    }, Math.min(1000, stallTimeout));
    signal?.addEventListener('abort', onAbort, { once: true });
    let created;
    try {
      created = createOcrWorker(lang, {
        logger: (message) => {
          last = Date.now();
          logger?.(message);
        },
      });
    } catch (e) {
      finish(startFailure(e));
      return;
    }
    Promise.resolve(created).then(
      (worker) => {
        if (!finish(null, worker)) worker.terminate().catch(() => {});
      },
      (e) => finish(startFailure(e)),
    );
  });
}

function startFailure(e) {
  if (e instanceof UserError || e instanceof CancelledError) return e;
  const message = String(e?.message ?? e ?? '');
  return new UserError(/network|fetch|load/i.test(message) ? 'ocr_problem_download' : 'ocr_problem_failed');
}
