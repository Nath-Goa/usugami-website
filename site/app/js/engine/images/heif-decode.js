// HEIC photos decoded with libheif (vendor/libheif), for browsers that can't decode them (all but
// Safari). libheif and its WebAssembly (inside the bundle: nothing is fetched) load only when a
// HEIC photo is added. The decoding runs in a worker (heif-worker.js) so the page stays responsive;
// where workers can't load modules, it runs here instead.

let library = null;

/** libheif, loaded once. */
function libheif() {
  if (!library) {
    library = import('../../../vendor/libheif/libheif-bundle.mjs')
      .then(({ default: factory }) => factory({ print() {}, printErr() {} }))
      .then((lib) => (lib.ready ? lib.ready.then(() => lib) : lib));
    library.catch(() => { library = null; });
  }
  return library;
}

/**
 * The HEIF file in `bytes` decoded: its main picture, turned and mirrored as the file says (libheif
 * applies its irot and imir), as RGBA pixels. Rejects when it can't be decoded.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray, alpha: boolean }>}
 */
export async function decodeHeifPixels(bytes) {
  const lib = await libheif();
  const decoder = new lib.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(bytes);
    const image = images.find((i) => i.is_primary()) ?? images[0];
    if (!image) throw new Error('No picture in the HEIF file');
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0 && height > 0) || width * height > MAX_HEIF_PIXELS) throw new Error('HEIF picture too large');
    const data = new Uint8ClampedArray(width * height * 4);
    const shown = await new Promise((resolve) => image.display({ data, width, height }, resolve));
    if (!shown) throw new Error('HEIF picture could not be decoded');
    return { width, height, data, alpha: image.has_alpha_channel() };
  } finally {
    for (const i of images) i.free();
    if (decoder.decoder) lib.heif_context_free(decoder.decoder);
    decoder.decoder = null;
  }
}

/** Larger than any phone's photo (200 megapixels and more), smaller than what would crash a tab. */
const MAX_HEIF_PIXELS = 220_000_000;

let worker = null;
let workerFailed = false;
let idle = 0;
let nextId = 1;
const waiting = new Map();

/** The worker, started when first needed and stopped a while after its last picture. */
function heifWorker() {
  if (workerFailed || typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./heif-worker.js', import.meta.url), { type: 'module' });
    } catch {
      workerFailed = true;
      return null;
    }
    worker.onmessage = (e) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data.result);
      stopLater();
    };
    worker.onerror = (e) => {
      // A worker that can't start (module workers unsupported, say): decode here from now on.
      e.preventDefault?.();
      workerFailed = true;
      const jobs = [...waiting.values()];
      waiting.clear();
      worker?.terminate();
      worker = null;
      for (const job of jobs) decodeHeifPixels(job.bytes).then(job.resolve, job.reject);
    };
  }
  clearTimeout(idle);
  return worker;
}

function stopLater() {
  clearTimeout(idle);
  if (waiting.size) return;
  // libheif's memory grows with the largest photo: give it back once photos stop coming.
  idle = setTimeout(() => {
    if (waiting.size || !worker) return;
    worker.terminate();
    worker = null;
  }, 15_000);
}

/**
 * As decodeHeifPixels(), in a worker when possible. `bytes` is copied, so it stays usable.
 * @param {Uint8Array} bytes
 * @param {{ signal?: AbortSignal }} [options]
 */
export function decodeHeif(bytes, { signal } = {}) {
  const w = heifWorker();
  if (!w) return decodeHeifPixels(bytes);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const copy = bytes.slice();
    const give = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    // A worker the browser stops (out of memory) never answers: the photo then counts as unreadable.
    const timer = setTimeout(() => {
      if (!waiting.delete(id)) return;
      reject(new Error('HEIF decoding took too long'));
      worker?.terminate();
      worker = null;
    }, HEIF_TIMEOUT);
    waiting.set(id, { resolve: give(resolve), reject: give(reject), bytes });
    signal?.addEventListener('abort', () => {
      if (!waiting.delete(id)) return;
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Cancelled'));
      stopLater();
    }, { once: true });
    w.postMessage({ id, bytes: copy }, [copy.buffer]);
  });
}

/** Far longer than a phone takes for the largest photo. */
const HEIF_TIMEOUT = 180_000;
