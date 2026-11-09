// Opening a picked PDF for a screen: its password asked for when it has one (PdfToolScreen's
// PasswordDialog, again when it is wrong), its pages counted as the tools count them
// (PdfToolsEngine.inspect), and its pages drawn by pdf.js as thumbnails (PdfThumbnail.kt): at the
// screen's pixel density, a few at a time, cached, and dropped when no longer wanted. What is drawn
// is the PDF's view (PdfToolsEngine.previewView): the PDF itself, or, when its page tree had to be
// mended or it carries Usugami's own mark, a copy without them, so the pages show as the tools find
// them and as they come out.
import { PasswordError, UserError, CancelledError, checkCancelled } from './errors.js';
import { passwordDialog, snackbar } from './ui.js';
import { t } from './i18n.js';
import { listOfNames } from './names.js';

let sourceSeq = 0;

// pdf.js (about 460 kB) is loaded once a PDF is opened, not with the screen: a tool shows its
// "Choose PDF" card without waiting for it.
let pdfjsModule = null;

/**
 * Starts loading pdf.js, if it isn't loaded yet, without waiting for it: a tool calls it as it
 * shows, so a PDF picked a moment later opens at once. Resolves with lib/pdfjs.js's module.
 * @returns {Promise<{ openPdfJs: Function, pdfjsLib: object }>}
 */
export function preloadPdfJs() {
  if (!pdfjsModule) {
    pdfjsModule = import('../lib/pdfjs.js');
    // Tried again next time (the network came back, say); a tool that doesn't wait isn't told.
    pdfjsModule.catch(() => { pdfjsModule = null; });
  }
  return pdfjsModule;
}

/**
 * Opens a PDF FileItem. When it needs a password and `ask` is true (the default), asks for it as
 * the app does: a wrong one says so and asks again; Cancel resolves with null. With ask false it
 * throws PasswordError instead. `password`, else the item's own `password` (Choose a tool keeps
 * the one typed for a shared PDF there), is tried first; when it doesn't open the PDF, the dialog
 * says so and asks. Aborting `signal` while the dialog is open closes it (null).
 * Throws UserError('pdf_import_failed') for a file that isn't a PDF or is too damaged to read, and
 * UserError('pdf_certificate_unsupported') for one locked with a certificate.
 * @param {FileItem & { password?: string }} item
 * @param {{ ask?: boolean, password?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<PdfSource|null>}
 */
export async function openPdf(item, { ask = true, password, signal } = {}) {
  checkCancelled(signal);
  const first = password ?? (item.password ? String(item.password) : undefined);
  let opened = null;
  let used = '';
  try {
    opened = await openView(item.bytes, first, signal);
    used = first ?? '';
  } catch (e) {
    if (!(e instanceof PasswordError)) throw e;
    if (!ask) throw new PasswordError(first != null && first !== '' && e.wrong);
    // Settled once the dialog has gone: a password still being tried then opens nothing.
    let settled = false;
    const chosen = await passwordDialog({
      fileName: item.name,
      wrong: first != null && first !== '',
      signal,
      check: async (p) => {
        try {
          const result = await openView(item.bytes, p);
          if (settled || signal?.aborted) {
            destroyDoc(result.doc);
            return false;
          }
          opened = result;
          return true;
        } catch (err) {
          if (err instanceof PasswordError) return false;
          throw err;
        }
      },
    });
    settled = true;
    if (chosen == null) {
      if (opened) destroyDoc(opened.doc);
      return null;
    }
    used = chosen;
  }
  if (signal?.aborted) {
    destroyDoc(opened.doc);
    throw new CancelledError();
  }
  return makeSource(item, opened, used);
}

/**
 * Opens several PDFs one after another, asking for each one's password in turn (as the app asks
 * for the locked PDFs picked together, in the order picked). A PDF whose password dialog is
 * cancelled is left out quietly; those that can't be opened are left out and, with report (the
 * default), named in a snackbar with the reason, those with the same reason together.
 * @returns {Promise<{ sources: PdfSource[], failed: { item: FileItem, error: Error }[] }>}
 */
export async function openPdfs(items, { ask = true, report = true, signal } = {}) {
  const sources = [];
  const failed = [];
  for (const item of items) {
    if (signal?.aborted) break;
    try {
      const source = await openPdf(item, { ask, signal });
      if (source) sources.push(source);
    } catch (error) {
      if (error instanceof CancelledError) break;
      failed.push({ item, error });
    }
  }
  if (report && failed.length) reportFileProblems(failed.map((f) => ({ name: f.item.name, error: f.error })));
  return { sources, failed };
}

/**
 * Says what went wrong with each of several files, naming them (PdfToolsViewModel.sayOf): files
 * with the same problem are named together in one snackbar, worded for one file or for several
 * (the string key, or key + '_many' when there is one). Errors that aren't UserErrors count as
 * `fallback` (pdf_import_failed).
 * @param {{ name: string, error: Error }[]} problems
 */
export function reportFileProblems(problems, { fallback = 'pdf_import_failed' } = {}) {
  const groups = new Map();
  for (const { name, error } of problems) {
    const key = error instanceof UserError ? error.key : fallback;
    if (!groups.has(key)) groups.set(key, { names: [], args: error instanceof UserError ? error.args : [] });
    groups.get(key).names.push(name);
  }
  for (const [key, { names, args }] of groups) {
    let text = t(key, ...args);
    if (names.length > 1) {
      const many = t(key + '_many', ...args);
      if (many && many !== key + '_many') text = many;
    }
    snackbar(t('file_problem', listOfNames(names), text));
  }
}

function isPasswordException(e, pdfjsLib) {
  return e?.name === 'PasswordException' || (!!pdfjsLib?.PasswordException && e instanceof pdfjsLib.PasswordException);
}

/** The error to show for a PDF pdf.js couldn't open. */
function openError(e, bytes) {
  if (e instanceof UserError || e instanceof CancelledError) return e;
  if (indexOfAscii(bytes, 'Adobe.PubSec') >= 0 || indexOfAscii(bytes, 'Adobe.PPKLite') >= 0 && indexOfAscii(bytes, '/Encrypt') >= 0) {
    return new UserError('pdf_certificate_unsupported');
  }
  return new UserError('pdf_import_failed');
}

/**
 * Opens the PDF with `password` (undefined: none) as the screen shows it: pdf.js on the PDF itself,
 * or on its view (see viewOf) when it needs one. Resolves with { doc, pageCount, viewBytes } (null
 * viewBytes: the PDF itself is shown). Throws PasswordError (wrong: a password was given and
 * refused) when it needs another password, and the UserError to show when it can't be opened.
 */
async function openView(bytes, password, signal) {
  let lib;
  try {
    lib = await preloadPdfJs();
  } catch {
    throw new UserError('pdf_import_failed');
  }
  checkCancelled(signal);
  const { openPdfJs, pdfjsLib } = lib;
  let doc;
  try {
    doc = await openPdfJs(bytes, password != null ? { password } : {});
  } catch (e) {
    if (isPasswordException(e, pdfjsLib)) throw new PasswordError(password != null && e.code === pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD);
    throw openError(e, bytes);
  }
  try {
    checkCancelled(signal);
    const view = await viewOf(bytes, password, doc.numPages, signal);
    if (!view) {
      if (!doc.numPages) throw new UserError('pdf_import_failed');
      return { doc, pageCount: doc.numPages, viewBytes: null };
    }
    if (!view.bytes) return { doc, pageCount: view.pageCount, viewBytes: null };
    let shown;
    try {
      shown = await openPdfJs(view.bytes);
    } catch {
      // The copy can't be read back: the PDF itself is shown, its pages counted as the tools count them.
      return { doc, pageCount: view.pageCount, viewBytes: null };
    }
    destroyDoc(doc);
    return { doc: shown, pageCount: view.pageCount, viewBytes: view.bytes };
  } catch (e) {
    destroyDoc(doc);
    throw e;
  }
}

/**
 * Reads the PDF as every tool will (pdf-lib, engine/pdf-common.js's loadPdf), with its page tree
 * mended as the tools mend it (PdfToolsEngine.inspect) and without Usugami's own mark (as
 * PdfToolsEngine.previewView): { pageCount, bytes }, bytes being a copy without the password, the
 * mark and the damage when any of them had to go, else null (nothing is saved again). `shown` is
 * the number of pages pdf.js found: a copy is also made when it differs. Null when pdf-lib can't
 * read it at all: the screen shows it as pdf.js reads it, and the tool says what is wrong once it
 * works on it. Throws PasswordError(true) for a password pdf.js took and pdf-lib doesn't.
 */
async function viewOf(bytes, password, shown, signal) {
  const [common, { repairPageTree }] = await Promise.all([import('../engine/pdf-common.js'), import('../engine/cleanup.js')]);
  let doc;
  try {
    // Read in parts of PARSE_SPEED objects, so a large PDF lets the screen in between.
    doc = await common.loadPdf(bytes, { ...(password != null ? { password } : {}), parseSpeed: PARSE_SPEED });
  } catch (e) {
    // The tools would refuse it too, as the app's inspect does.
    if (e instanceof PasswordError && password) throw new PasswordError(true);
    return null;
  }
  checkCancelled(signal);
  let pages;
  let changed;
  try {
    ({ pages, changed } = repairPageTree(doc));
  } catch {
    return null;
  }
  // loadPdf takes Usugami's mark off as it reads (and says so); where it doesn't, it is taken off
  // here. The mark's streams name it in their dictionaries, which are never compressed: a PDF
  // without the name has no mark, and needs neither the module nor a walk through its pages.
  let unmarked = typeof common.wasUnmarked === 'function' && !!common.wasUnmarked(doc);
  if (!unmarked && indexOfAscii(bytes, MARK_NAME) >= 0) {
    const unmark = await markRemover();
    try {
      unmarked = !!unmark?.(doc);
    } catch {
      // Left on: the pages still show.
    }
  }
  if (!changed && !unmarked && pages.length === shown) return { pageCount: pages.length, bytes: null };
  checkCancelled(signal);
  return { pageCount: pages.length, bytes: await common.savePdf(doc) };
}

/** pdf-lib's "Fast" parse speed: objects read between letting the screen in. */
const PARSE_SPEED = 1500;
const MARK_NAME = 'UsugamiMark';
let markModule = null;

/** engine/page-mark.js's unmark(doc), or null while there is none. */
function markRemover() {
  markModule ??= import('../engine/page-mark.js').then((m) => (typeof m.unmark === 'function' ? m.unmark : null), () => null);
  return markModule;
}

// ---------------------------------------------------------------------------------------------
// Drawing pages: a few at a time, the latest asked for first (the pages scrolled to), and those no
// longer wanted are never drawn.

const MAX_RENDERS = 2;
const queue = [];
let running = 0;

function enqueue(job, urgent) {
  return new Promise((resolve, reject) => {
    const entry = { job, resolve, reject, urgent: !!urgent };
    // Taken from the end: urgent work first, then the thumbnail asked for last.
    if (urgent) queue.push(entry); else queue.splice(Math.max(0, queue.length - countUrgent()), 0, entry);
    pump();
  });
}

function countUrgent() {
  let n = 0;
  for (let i = queue.length - 1; i >= 0 && queue[i].urgent; i--) n++;
  return n;
}

function pump() {
  while (running < MAX_RENDERS && queue.length) {
    const { job, resolve, reject } = queue.pop();
    running++;
    Promise.resolve().then(job).then(resolve, reject).finally(() => {
      running--;
      pump();
    });
  }
}

// The thumbnails drawn lately, by PDF, page and size, so scrolling back or moving a page shows them at once.
const CACHE_BYTES = 48 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

function cacheGet(key) {
  const c = cache.get(key);
  if (!c) return null;
  cache.delete(key);
  cache.set(key, c);
  return c;
}

function cachePut(key, canvas) {
  const size = canvas.width * canvas.height * 4;
  if (size > CACHE_BYTES / 4) return;
  if (cache.has(key)) cacheBytes -= cache.get(key).width * cache.get(key).height * 4;
  cache.set(key, canvas);
  cacheBytes += size;
  for (const [k, c] of cache) {
    if (cacheBytes <= CACHE_BYTES) break;
    cache.delete(k);
    cacheBytes -= c.width * c.height * 4;
  }
}

function cacheDrop(prefix) {
  for (const [k, c] of [...cache]) {
    if (k.startsWith(prefix)) {
      cache.delete(k);
      cacheBytes -= c.width * c.height * 4;
    }
  }
}

function copyCanvas(c) {
  const out = document.createElement('canvas');
  out.width = c.width;
  out.height = c.height;
  out.className = 'ui-page-canvas';
  out.getContext('2d').drawImage(c, 0, 0);
  return out;
}

/** The device's pixels per CSS pixel, kept to 3: more draws pages no sharper, only slower. */
function density() {
  return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}

/** Largest picture drawn, in pixels: a page's side and its area. */
const MAX_SIDE = 4096;
const MAX_AREA = 16_000_000;

/** Fails with CancelledError once `signal` is aborted. */
function aborted(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new CancelledError());
    else signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
  });
}

function makeSource(item, { doc, pageCount, viewBytes }, password) {
  const id = ++sourceSeq;
  const prefix = `${id}#`;
  const sizes = new Map();
  // Thumbnails being drawn, by key, shared by those asking for the same one.
  const pending = new Map();
  let closed = false;

  const drawPage = async (index, pxWidth, pxHeight, signal) => {
    checkCancelled(signal);
    if (closed) throw new CancelledError();
    const page = await doc.getPage(index + 1);
    checkCancelled(signal);
    const base = page.getViewport({ scale: 1 });
    let scale = Math.min(pxWidth / base.width, pxHeight / base.height);
    scale = Math.min(scale, MAX_SIDE / base.width, MAX_SIDE / base.height, Math.sqrt(MAX_AREA / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    canvas.className = 'ui-page-canvas';
    // With alpha, as an opaque canvas makes Chromium draw text with coloured (LCD) smoothing, which
    // shows as coloured fringes; pdf.js then draws on this same context. White paper first.
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvas, viewport, background: '#ffffff' });
    const stop = () => task.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await task.promise;
    } catch (e) {
      if (signal?.aborted || e?.name === 'RenderingCancelledException') throw new CancelledError();
      throw e;
    } finally {
      signal?.removeEventListener('abort', stop);
      // pdf.js keeps a drawn page's operator list and its decoded images (full size: a scanned page
      // is tens of MB) until the page is cleaned up. The canvas has what is needed; the cache keeps
      // the thumbnails. While another drawing of the page is under way it waits for that one.
      cleanUp(page);
    }
    return canvas;
  };

  const source = {
    id,
    item,
    name: item.name,
    size: item.bytes.length,
    /** The PDF as picked, for the engines (Compress PDF keeps it as it is). */
    bytes: item.bytes,
    password,
    /** Its pages as the tools find them (a damaged page tree mended). */
    pageCount,
    /** What the previews show: `bytes` itself, or a copy without the password, Usugami's mark and a damaged page tree. */
    viewBytes: viewBytes ?? item.bytes,
    /** The password viewBytes opens with: '' for a copy. */
    viewPassword: viewBytes ? '' : password,
    /** Whether viewBytes is such a copy. */
    hasView: !!viewBytes,

    /** The pdf.js document (PDFDocumentProxy) of what the previews show, open until close(). */
    async pdfjs() {
      if (closed) throw new Error('PdfSource is closed');
      return doc;
    },

    /**
     * Page `index` (from 0) as it is shown (its crop box, turned by its rotation) on white, drawn to
     * fit a box `cssWidth` CSS pixels wide and (by default) 4/3 as tall, at the screen's density.
     * Cached; several asking for one page share its drawing; aborting `signal` drops the request.
     * @returns {Promise<HTMLCanvasElement>} a canvas of its own each time
     */
    thumbnail(index, cssWidth, { signal, maxCssHeight } = {}) {
      if (closed) return Promise.reject(new CancelledError());
      const d = density();
      const pxW = Math.max(16, Math.round(cssWidth * d));
      const pxH = Math.max(16, Math.round((maxCssHeight ?? cssWidth * 4 / 3) * d));
      const key = `${prefix}${index}@${pxW}x${pxH}`;
      const hit = cacheGet(key);
      if (hit) return Promise.resolve(copyCanvas(hit));
      if (signal?.aborted) return Promise.reject(new CancelledError());
      let p = pending.get(key);
      // One given up on by everyone who asked is being stopped: this request draws it anew.
      if (!p || p.controller.signal.aborted) {
        const controller = new AbortController();
        const entry = { waiters: 0, controller };
        entry.promise = enqueue(async () => {
          if (controller.signal.aborted) throw new CancelledError();
          const canvas = await drawPage(index, pxW, pxH, controller.signal);
          if (!closed) cachePut(key, canvas);
          return canvas;
        }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
        // Nobody may be waiting by the time it fails; that is no error of the page's.
        entry.promise.catch(() => {});
        pending.set(key, entry);
        p = entry;
      }
      p.waiters++;
      const mine = p;
      const release = () => {
        mine.waiters--;
        if (mine.waiters <= 0) mine.controller.abort();
      };
      signal?.addEventListener('abort', release, { once: true });
      return Promise.race([mine.promise, aborted(signal)]).then((canvas) => {
        signal?.removeEventListener('abort', release);
        return copyCanvas(canvas);
      }, (e) => {
        signal?.removeEventListener('abort', release);
        throw e;
      });
    },

    /**
     * Page `index` drawn afresh for a larger preview, not cached: to fit `cssWidth` × `maxCssHeight`
     * CSS pixels (or at `scale` pixels per point), ahead of any thumbnails waiting.
     */
    render(index, { cssWidth, maxCssHeight, scale, signal } = {}) {
      if (closed) return Promise.reject(new CancelledError());
      const d = density();
      return enqueue(async () => {
        if (scale) {
          const page = await doc.getPage(index + 1);
          const base = page.getViewport({ scale: 1 });
          return drawPage(index, base.width * scale, base.height * scale, signal);
        }
        const w = Math.max(16, Math.round((cssWidth ?? 400) * d));
        const hpx = Math.max(16, Math.round((maxCssHeight ?? 1e5) * d));
        return drawPage(index, w, hpx, signal);
      }, true);
    },

    /**
     * Page `index`'s size in points as it is shown: width and height with its rotation applied,
     * rotation (0, 90, 180 or 270), and viewWidth/viewHeight, its crop box before turning.
     */
    async pageSize(index) {
      if (sizes.has(index)) return { ...sizes.get(index) };
      const page = await doc.getPage(index + 1);
      const [x1, y1, x2, y2] = page.view;
      const w = Math.abs(x2 - x1);
      const hgt = Math.abs(y2 - y1);
      const rotation = ((page.rotate % 360) + 360) % 360;
      const turned = rotation % 180 !== 0;
      const size = { width: turned ? hgt : w, height: turned ? w : hgt, rotation, viewWidth: w, viewHeight: hgt };
      sizes.set(index, size);
      return { ...size };
    },

    /** Frees pdf.js's copy and the thumbnails; the source can't draw anything afterwards. */
    close() {
      if (closed) return;
      closed = true;
      for (const p of pending.values()) p.controller.abort();
      pending.clear();
      cacheDrop(prefix);
      destroyDoc(doc);
    },

    get closed() { return closed; },
  };
  return source;
}

/** Frees what pdf.js keeps of a page it has drawn (see drawPage); never fails. */
function cleanUp(page) {
  try {
    page.cleanup();
  } catch {
    // The document is being closed.
  }
}

/** Where `text` (ASCII) first is in `bytes`, or -1. */
function indexOfAscii(bytes, text) {
  const first = text.charCodeAt(0);
  const n = text.length;
  outer: for (let i = bytes.indexOf(first); i >= 0 && i <= bytes.length - n; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < n; j++) if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/**
 * Lets pdf.js free a document and its worker. pdf.js 6's PDFDocumentProxy has no destroy() of its
 * own: its loading task does it.
 */
function destroyDoc(doc) {
  try {
    doc?.loadingTask?.destroy()?.catch?.(() => {});
  } catch {
    // Already gone.
  }
}
