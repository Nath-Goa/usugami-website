// The result screen (ui/ResultScreen.kt) and the ways a finished file leaves the app: opened in a
// new tab, shared (Web Share, where the browser can share files), downloaded ("Save to Downloads"),
// saved with the browser's "Save as" picker or into a folder where it has them, or several put
// in one ZIP file (data/ResultZip.kt, core/ZipArchive.kt). Every file saved goes on Recent files.
// At its top, the Usugami watermark's switch (core/result-mark.js): the PDFs show, open, share and
// save with the mark the setting asks for.
import { h, clear, yieldToUI, ensureCss } from './dom.js';
import { t, tp, formatSize, loadStrings } from './i18n.js';
import { icon } from './icons.js';
import { sanitizeName } from './names.js';
import { topBar, button, menu, snackbar, alertDialog, progressDialog, uid } from './ui.js';
import { UserError, CancelledError, checkCancelled } from './errors.js';
import {
  ResultMarker, markCard, drawFirstPage, getMarkSetting, wantedMark, setMarkOn, setMarkStyle, onMarkSettingChange,
} from './result-mark.js';

const PDF = 'application/pdf';
const ZIP = 'application/zip';

// The watermark card's styles and strings, ready by the time a result shows (the shell loads the
// strings at start too).
if (typeof document !== 'undefined') ensureCss(new URL('../../css/mark.css', import.meta.url));
loadStrings('mark').catch(() => {});

/** How long a change of the watermark settles before the PDFs are rewritten (ResultMarker.SETTLE_MS). */
const SETTLE_MS = 250;

// ---------------------------------------------------------------------------------------------
// What this browser can do

/** Whether this browser can share files (with the Web Share API), as far as can be told up front. */
export function canShareFiles(files) {
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    const probe = files?.length ? files.map(asFile) : [new File([new Uint8Array(1)], 'Usugami.pdf', { type: PDF })];
    return navigator.canShare({ files: probe });
  } catch {
    return false;
  }
}

/** Whether this browser has a "Save as" picker (showSaveFilePicker). */
export function canSaveAs() {
  return typeof window.showSaveFilePicker === 'function';
}

/** Whether this browser can save into a folder the user picks (showDirectoryPicker). */
export function canSaveToFolder() {
  return typeof window.showDirectoryPicker === 'function';
}

function asFile(file) {
  return new File([file.bytes], file.name, { type: file.type || PDF, lastModified: Date.now() });
}

/** Puts a saved file on Recent files, if the shell's list is there; a failure there doesn't matter. */
async function addToRecent(file) {
  try {
    const recent = await import('./recent.js');
    await recent.addRecent({ name: file.name, type: file.type || PDF, bytes: file.bytes, size: file.bytes.length });
  } catch {
    // No list in this browser (private mode, say): the file is saved all the same.
  }
}

// ---------------------------------------------------------------------------------------------
// Opening, sharing, saving

const objectUrls = new Set();

function objectUrl(file) {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.type || PDF }));
  objectUrls.add(url);
  // A tab opened on it may still be loading: let it go after a while.
  setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url); }, 5 * 60 * 1000);
  return url;
}

/**
 * Saves `file` ({ name, bytes, type }) into the browser's downloads, under its name, and lists it
 * on Recent files. The browser picks a free name if one is taken ("Report (1).pdf").
 * @returns {Promise<void>}
 */
export async function download(file) {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.type || PDF }));
  const a = h('a', { href: url, download: file.name, rel: 'noopener', style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  await addToRecent(file);
}

/**
 * Opens `file` in a new browser tab (its own PDF viewer). Call it straight from a click, as
 * browsers open tabs only then. A ZIP file is downloaded instead. Returns false when the browser
 * blocked the tab (a snackbar then says so).
 */
export function openFile(file) {
  if ((file.type || '').toLowerCase() === ZIP) {
    download(file);
    return true;
  }
  const tab = window.open(objectUrl(file), '_blank');
  if (!tab) snackbar(t('web_open_blocked'));
  return !!tab;
}

/**
 * Shares files with another app (Web Share API). Resolves true when shared, false when the share
 * sheet was closed. Throws UserError('web_share_failed') when the browser can't share them.
 */
export async function share(files) {
  const list = files.map(asFile);
  if (typeof navigator.share !== 'function' || !navigator.canShare?.({ files: list })) throw new UserError('web_share_failed');
  try {
    await navigator.share({ files: list });
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return false;
    if (e?.name === 'NotAllowedError') throw Object.assign(new UserError('web_share_failed'), { notAllowed: true });
    throw new UserError('web_share_failed');
  }
}

function pickerType(file) {
  const type = (file.type || PDF).toLowerCase();
  const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? (type === ZIP ? '.zip' : '.pdf')).toLowerCase();
  return { accept: { [type]: [ext] } };
}

/**
 * Saves `file` where the user chooses with the browser's "Save as" picker, and lists it on Recent
 * files. Where there is no picker it is downloaded instead. Resolves true when saved, false when the
 * picker was cancelled.
 */
export async function saveAs(file) {
  if (!canSaveAs()) {
    await download(file);
    return true;
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: file.name, types: [pickerType(file)], id: 'usugami-save', startIn: 'downloads' });
  } catch (e) {
    if (e?.name === 'AbortError') return false;
    throw e;
  }
  await writeTo(handle, file.bytes);
  await addToRecent({ ...file, name: handle.name || file.name });
  return true;
}

async function writeTo(handle, bytes) {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (e) {
    // A file left half written (the disk filled up) would look like a good one.
    try { await writable.abort(); } catch { /* already closed */ }
    throw e;
  }
}

/** `name` if no file in `dir` has it, otherwise "base (1).ext", "base (2).ext", ... as Android names copies. */
async function freeName(dir, name) {
  const exists = async (n) => {
    try {
      await dir.getFileHandle(n);
      return true;
    } catch (e) {
      if (e?.name === 'NotFoundError') return false;
      if (e?.name === 'TypeMismatchError') return true;
      throw e;
    }
  };
  if (!(await exists(name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 10000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

/**
 * Saves each of `files` into a folder the user picks (showDirectoryPicker), a file whose name is
 * taken there getting " (1)" after its name, and lists each on Recent files. Where the browser
 * can't, each is downloaded instead. Resolves with the folder and the names given, or null when
 * cancelled. `earlier` is what an earlier save of the same files returned: saving into that folder
 * again copies only the files that have gone from it since, rather than adding "Name (1).pdf".
 * @returns {Promise<{ dir: FileSystemDirectoryHandle|null, names: string[] }|null>}
 */
export async function saveToFolder(files, { earlier } = {}) {
  if (!canSaveToFolder()) {
    for (const f of files) await download(f);
    return { dir: null, names: files.map((f) => f.name) };
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'usugami-folder', startIn: 'downloads' });
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
  let skip = null;
  if (earlier?.dir && earlier.names?.length === files.length) {
    try {
      if (await earlier.dir.isSameEntry(dir)) skip = earlier.names;
    } catch {
      // Can't tell: everything is saved.
    }
  }
  const names = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const already = skip?.[i];
    if (already) {
      try {
        await dir.getFileHandle(already);
        names.push(already);
        continue;
      } catch {
        // Gone from the folder since: saved again.
      }
    }
    const name = await freeName(dir, f.name);
    const handle = await dir.getFileHandle(name, { create: true });
    await writeTo(handle, f.bytes);
    await addToRecent({ ...f, name });
    names.push(name);
  }
  return { dir, names };
}

// ---------------------------------------------------------------------------------------------
// ZIP files (ZipArchive.kt): each file stored as it is (PDFs are compressed already), in order,
// with names made unique ignoring case and without folders.

/**
 * The names files get inside a ZIP file (ZipArchive.entryNames): their own, with folder separators
 * replaced, made unique ignoring case ("a.pdf", then "A (2).pdf").
 */
export function entryNames(names) {
  const taken = new Set();
  return names.map((raw) => {
    const name = String(raw).replace(/[/\\]/g, '_').trim() || 'file';
    let candidate = name;
    if (taken.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = name.slice(base.length);
      let n = 2;
      while (taken.has(`${base} (${n})${ext}`.toLowerCase())) n++;
      candidate = `${base} (${n})${ext}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** The ZIP file's name (ResultZip.fileName): the run's, made safe, such as "Report_split.zip". */
export function zipFileName(name) {
  return `${sanitizeName(name ?? '', 'Usugami')}.zip`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(crc, bytes, start, end) {
  let c = crc;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const CHUNK = 1 << 20;

/**
 * Writes the ZIP file. `step()` runs between chunks of 1 MB (to yield, and to stop when cancelled),
 * and `progress(p)` follows the bytes read, as ZipProgress: each file is read twice, once for its
 * checksum and once to copy it.
 */
function* writeZip(files, names) {
  const enc = new TextEncoder();
  const { time, day } = dosTime(new Date());
  const heads = names.map((n) => enc.encode(n));
  let size = 22;
  for (let i = 0; i < files.length; i++) size += 30 + heads[i].length + files[i].bytes.length + 46 + heads[i].length;
  if (files.length > 0xffff || size > 0xffffffff) throw new UserError('zip_failed');
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const totalBytes = files.reduce((s, f) => s + f.bytes.length, 0) * 2;
  let bytes = 0;
  let at = 0;
  const offsets = [];
  const crcs = [];
  for (let i = 0; i < files.length; i++) {
    const data = files[i].bytes;
    let crc = 0xffffffff;
    for (let p = 0; p < data.length; p += CHUNK) {
      const end = Math.min(data.length, p + CHUNK);
      crc = crcUpdate(crc, data, p, end);
      bytes += end - p;
      yield { files: i, totalFiles: files.length, bytes, totalBytes };
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    crcs.push(crc);
    offsets.push(at);
    // Local file header: stored, names in UTF-8 (flag 11), sizes and checksum up front.
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 0x0800, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, time, true);
    view.setUint16(at + 12, day, true);
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, data.length, true);
    view.setUint32(at + 22, data.length, true);
    view.setUint16(at + 26, heads[i].length, true);
    view.setUint16(at + 28, 0, true);
    out.set(heads[i], at + 30);
    at += 30 + heads[i].length;
    for (let p = 0; p < data.length; p += CHUNK) {
      const end = Math.min(data.length, p + CHUNK);
      out.set(data.subarray(p, end), at);
      at += end - p;
      bytes += end - p;
      yield { files: i, totalFiles: files.length, bytes, totalBytes };
    }
    yield { files: i + 1, totalFiles: files.length, bytes, totalBytes };
  }
  const cdStart = at;
  for (let i = 0; i < files.length; i++) {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, time, true);
    view.setUint16(at + 14, day, true);
    view.setUint32(at + 16, crcs[i], true);
    view.setUint32(at + 20, files[i].bytes.length, true);
    view.setUint32(at + 24, files[i].bytes.length, true);
    view.setUint16(at + 28, heads[i].length, true);
    view.setUint16(at + 30, 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, 0, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(heads[i], at + 46);
    at += 46 + heads[i].length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, files.length, true);
  view.setUint16(at + 10, files.length, true);
  view.setUint32(at + 12, at - cdStart, true);
  view.setUint32(at + 16, cdStart, true);
  view.setUint16(at + 20, 0, true);
  return out;
}

/**
 * One ZIP file of `files`, named after the run (`zipName`, such as "Report_split" →
 * "Report_split.zip"), each file stored as it is.
 * @returns {OutputFile} { name, bytes, type: 'application/zip' }
 */
export function zipFiles(files, zipName) {
  const gen = writeZip(files, entryNames(files.map((f) => f.name)));
  let r = gen.next();
  while (!r.done) r = gen.next();
  return { name: zipFileName(zipName), bytes: r.value, type: ZIP };
}

/**
 * zipFiles without holding up the screen: yields to it between chunks, reports progress as
 * onProgress({ files, totalFiles, bytes, totalBytes, fraction }), and stops with CancelledError
 * once `signal` is aborted.
 * @returns {Promise<OutputFile>}
 */
export async function zipFilesAsync(files, zipName, { onProgress, signal } = {}) {
  const gen = writeZip(files, entryNames(files.map((f) => f.name)));
  let r = gen.next();
  let last = performance.now();
  while (!r.done) {
    checkCancelled(signal);
    const p = r.value;
    onProgress?.({ ...p, fraction: p.totalBytes > 0 ? Math.min(1, p.bytes / p.totalBytes) : 0 });
    if (performance.now() - last > 30) {
      await yieldToUI();
      last = performance.now();
    }
    r = gen.next();
  }
  checkCancelled(signal);
  return { name: zipFileName(zipName), bytes: r.value, type: ZIP };
}

// ---------------------------------------------------------------------------------------------
// The result screen

const pageCounts = new WeakMap();

/** The number of pages of a PDF output, counted by pdf.js once (and only when asked). */
async function countPages(file) {
  if (typeof file.pageCount === 'number') return file.pageCount;
  if (pageCounts.has(file)) return pageCounts.get(file);
  const promise = (async () => {
    const { openPdfJs } = await import('../lib/pdfjs.js');
    const doc = await openPdfJs(file.bytes);
    const n = doc.numPages;
    doc.loadingTask?.destroy();
    return n;
  })().catch(() => null);
  pageCounts.set(file, promise);
  return promise;
}

/** How much smaller Compress PDF made a file (Compressor.savedPercent): at least 1%, or null. */
export function savedPercent(original, now) {
  if (!(original > 0) || now >= original) return null;
  const pct = Math.floor(((original - now) * 100) / original);
  return pct >= 1 ? pct : null;
}

/** Waits `ms`, or stops with CancelledError once `signal` is aborted. */
function settle(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Shows the result screen in `root` (emptied first), as the app's: "Done" with a back arrow
 * ("Back to editing", onBack), a check mark and "Your PDF is ready" (or "Your PDFs are ready"),
 * the Usugami watermark's switch, each file with its pages and size and what `details(file)` says
 * (else, from a file's originalSize or keptOriginal, how much smaller it got or that its original
 * was kept), then:
 * - one file: Open and Share, Save to Downloads, Save as…
 * - several: Share all, Save to Downloads, Save to folder…, Share or save as ZIP (Share ZIP,
 *   Save ZIP to Downloads, Save ZIP as…), and each file its own Open, Share and Save.
 * Share shows only where the browser can share files, Save as… and Save to folder… only where it
 * has those pickers. "Not saved yet…" shows until every file is saved; Start over asks first
 * until then. `message` is a note under the files; passwordRemoved adds "The new PDF has no
 * password." `zipName` names the ZIP file (the run's name, such as "Report_split").
 *
 * The Usugami watermark (core/result-mark.js), when some file is a PDF: the PDFs get the mark if
 * it is on ("Adding the Usugami watermark…" while that takes a while; its Cancel goes back to
 * editing, as cancelling the run does). Turned on, off or changed here (or anywhere else), the same
 * PDFs change after a moment, while Open, Share and Save wait; turned off, they are again the files
 * as they were made, byte for byte. Copies saved before a change stay as they were: the result
 * counts as not saved again. `onReady(files)` is called once the PDFs are as the setting asks, with
 * the files as they show (in the order given); not if the screen goes first.
 *
 * Returns the screen: el.isSaved(), el.destroy(), el.files (the files as they show now, which
 * Open, Share, Save and the ZIP file use), el.ready (a promise of them once ready), el.markCard.
 */
export function showResult(root, {
  files, title, message, details, onStartOver, onBack, zipName, passwordRemoved = false, heading, onReady,
} = {}) {
  clear(root);
  const marker = new ResultMarker(files);
  // A result shown again shows at once the version it had, when that is what the setting asks for.
  marker.useKnown(wantedMark());
  const current = () => marker.files;
  const single = files.length === 1;
  const shareable = canShareFiles();
  const savedNames = new Set();
  let saved = false;
  let busy = false;
  let zipping = false;
  let marking = false;
  let inFolder = null;
  let destroyed = false;
  let unsavedTimer = 0;
  const rows = [];
  // Saving waits for a save, a ZIP file or the watermark; sharing for a ZIP file or the watermark;
  // opening for the watermark.
  const busyButtons = [];
  const zipBlocked = [];
  const markBlocked = [];

  const bar = topBar({
    title: title ?? t('result_title'),
    onBack: onBack ? () => { if (!busy) onBack(); } : null,
    backLabel: t('back_to_editing'),
  });
  const headingId = uid('result');
  const check = h('div', { class: 'ui-result-check', 'aria-hidden': 'true' }, icon('check_circle', { size: 64 }));
  const headingEl = h('h2', { class: 'ui-result-heading', id: headingId, tabindex: '-1' }, heading ?? t(single ? 'result_heading_one' : 'result_heading_many'));
  const list = h('ul', { class: 'ui-result-files', 'aria-labelledby': headingId });
  // Near the top, above the PDFs and what can be done with them: it changes them.
  const card = marker.hasPdfs ? markCard({
    setting: getMarkSetting(),
    onOn: (on) => { if (!busy && !zipping) setMarkOn(on); },
    onStyle: (style) => { if (!busy && !zipping) setMarkStyle(style); },
    page: async () => drawFirstPage(await marker.firstMade()),
  }) : null;
  const content = h('div', { class: 'ui-result-content' }, check, headingEl, card, list);
  const screen = h('div', { class: 'ui-result' }, bar, h('div', { class: 'ui-result-scroll' }, content));
  let startOver = null;
  let pendingFollow = false;

  const refresh = () => {
    for (const btn of busyButtons) btn.disabled = busy || zipping || marking;
    for (const btn of zipBlocked) btn.disabled = zipping || marking;
    for (const btn of markBlocked) btn.disabled = marking;
    if (bar.back) bar.back.disabled = busy;
    if (startOver) startOver.disabled = busy;
    card?.setEnabled(!busy && !zipping);
  };
  const setBusy = (b) => {
    busy = b;
    refresh();
    // A change of the setting made elsewhere meanwhile.
    if (!busy && !zipping && pendingFollow) follow({ wait: false });
  };
  const setZipping = (z) => {
    zipping = z;
    setBusy(busy);
  };
  const setMarking = (m) => {
    marking = m;
    card?.setWorking(m);
    refresh();
  };

  // The app keeps a result through Android stopping it (KeptResult); a browser keeps nothing
  // through a reload, so closing or reloading the tab asks first while the result isn't saved.
  const guard = (e) => {
    if (!screen.isConnected || saved) {
      window.removeEventListener('beforeunload', guard);
      return;
    }
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', guard);

  const markSaved = (saving) => {
    for (const f of saving) savedNames.add(f);
    if (!single) for (const r of rows) r.setSaved(savedNames.has(r.file));
    if (!saved && current().every((f) => savedNames.has(f))) {
      saved = true;
      window.removeEventListener('beforeunload', guard);
      notSaved.classList.add('is-gone');
      clearTimeout(unsavedTimer);
      unsavedTimer = setTimeout(() => { notSaved.hidden = true; }, 260);
    }
  };

  /** The PDFs changed: the copies saved before are of them as they were, so the result isn't saved. */
  const unsave = () => {
    savedNames.clear();
    inFolder = null;
    for (const r of rows) r.setSaved(false);
    if (!saved) return;
    saved = false;
    window.addEventListener('beforeunload', guard);
    clearTimeout(unsavedTimer);
    notSaved.hidden = false;
    requestAnimationFrame(() => notSaved.classList.remove('is-gone'));
  };

  /** Runs a save: the other buttons wait, a failure says so. */
  const run = async (fn, failure = 'msg_save_failed') => {
    if (busy || marking) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof CancelledError)) snackbar(e instanceof UserError ? t(e.key, ...e.args) : t(failure));
    } finally {
      setBusy(false);
    }
  };

  const doShare = async (sharing) => {
    if (marking) return;
    try {
      await share(sharing);
    } catch (e) {
      snackbar(t(e instanceof UserError ? e.key : 'web_share_failed'));
    }
  };

  const saveDownloads = (saving) => run(async () => {
    for (let i = 0; i < saving.length; i++) {
      await download(saving[i]);
      // Browsers take downloads one at a time better than at once.
      if (i < saving.length - 1) await new Promise((r) => setTimeout(r, 250));
    }
    markSaved(saving);
    snackbar(saving.length === 1 ? t('msg_saved_downloads', saving[0].name) : tp('msg_saved_downloads_many', saving.length, saving.length));
  });

  const saveOneAs = (file) => run(async () => {
    if (await saveAs(file)) {
      markSaved([file]);
      snackbar(t('msg_saved'));
    }
  });

  const saveAllToFolder = () => run(async () => {
    const saving = current();
    // Saving into the same folder again copies only what has gone from it, as the app does.
    const r = await saveToFolder(saving, { earlier: inFolder });
    if (!r) return;
    inFolder = r;
    markSaved(saving);
    snackbar(tp('msg_saved_folder', saving.length, saving.length));
  });

  const zipThen = async (then) => {
    if (zipping) {
      snackbar(t('zip_busy'));
      return;
    }
    if (marking) return;
    const inside = current();
    const controller = new AbortController();
    setZipping(true);
    const dialog = progressDialog({ title: t('zip_making'), onCancel: () => controller.abort() });
    let zip = null;
    try {
      zip = await zipFilesAsync(inside, zipName, {
        signal: controller.signal,
        onProgress: (p) => dialog.update(p.fraction, tp('progress_files', p.totalFiles, p.files, p.totalFiles)),
      });
    } catch (e) {
      if (!(e instanceof CancelledError)) snackbar(t('zip_failed'));
    } finally {
      dialog.close();
    }
    // Still the ZIP file's work until it is saved or shared: a change of the watermark waits.
    try {
      if (zip) await then(zip, inside);
    } finally {
      setZipping(false);
    }
  };

  const zipShare = () => zipThen(async (zip) => {
    try {
      await share([zip]);
    } catch (e) {
      // Made too slowly for the browser to still count the tap: one more tap shares it.
      if (e.notAllowed) snackbar(t('web_zip_ready'), { action: t('share'), onAction: () => doShare([zip]) });
      else snackbar(t('web_share_failed'));
    }
  });
  const zipDownload = () => zipThen((zip, inside) => run(async () => {
    await download(zip);
    markSaved(inside);
    snackbar(t('msg_saved_downloads', zip.name));
  }, 'zip_failed'));
  const zipSaveAs = () => zipThen((zip, inside) => run(async () => {
    if (await saveAs(zip)) {
      markSaved(inside);
      snackbar(t('msg_saved'));
    }
  }, 'zip_failed'));

  // The files
  for (const file of files) {
    const row = fileRow(file, {
      single, shareable, details,
      onOpen: () => { if (!marking) openFile(row.file); },
      onShare: () => doShare([row.file]),
      onSave: (anchor) => {
        if (marking) return;
        if (!canSaveAs()) { saveDownloads([row.file]); return; }
        menu(anchor, [
          { label: t('save_to_downloads'), icon: 'download', onClick: () => saveDownloads([row.file]) },
          { label: t('save_as'), icon: 'save_as', onClick: () => saveOneAs(row.file) },
        ]);
      },
    });
    if (row.openButton) markBlocked.push(row.openButton);
    if (row.saveButton) busyButtons.push(row.saveButton);
    if (row.shareButton) zipBlocked.push(row.shareButton);
    rows.push(row);
    list.append(row.el);
  }

  const note = [message, passwordRemoved ? tp('pdf_password_removed', files.length) : null].filter(Boolean).join(' ');
  if (note) content.append(h('p', { class: 'ui-result-note' }, note));

  // The buttons
  const actions = h('div', { class: 'ui-result-actions' });
  if (single) {
    const open = button({ label: t('open'), icon: 'open_in_new', variant: 'filled', onClick: () => { if (!marking) openFile(current()[0]); } });
    markBlocked.push(open);
    const pair = h('div', { class: 'ui-result-pair' }, open);
    if (shareable) {
      const shareBtn = button({ label: t('share'), icon: 'share', variant: 'tonal', onClick: () => doShare(current()) });
      zipBlocked.push(shareBtn);
      pair.append(shareBtn);
    }
    actions.append(pair);
    const dl = button({ label: t('save_to_downloads'), icon: 'download', variant: 'outlined', onClick: () => saveDownloads(current()) });
    busyButtons.push(dl);
    actions.append(dl);
    if (canSaveAs()) {
      const as = button({ label: t('save_as'), icon: 'save_as', variant: 'outlined', onClick: () => saveOneAs(current()[0]) });
      busyButtons.push(as);
      actions.append(as);
    }
  } else {
    if (shareable) {
      const all = button({ label: t('share_all'), icon: 'share', variant: 'filled', onClick: () => doShare(current()) });
      zipBlocked.push(all);
      actions.append(all);
    }
    const dl = button({ label: t('save_to_downloads'), icon: 'download', variant: shareable ? 'outlined' : 'filled', onClick: () => saveDownloads(current()) });
    busyButtons.push(dl);
    actions.append(dl);
    if (canSaveToFolder()) {
      const fold = button({ label: t('save_all_to_folder'), icon: 'save_as', variant: 'outlined', onClick: saveAllToFolder });
      busyButtons.push(fold);
      actions.append(fold);
    }
    const zipBtn = button({ label: t('zip_button'), icon: 'folder_zip', variant: 'outlined' });
    zipBtn.setAttribute('aria-haspopup', 'menu');
    zipBtn.setAttribute('aria-expanded', 'false');
    zipBtn.addEventListener('click', () => {
      if (marking) return;
      const items = [];
      if (shareable) items.push({ label: t('zip_share'), icon: 'share', onClick: zipShare });
      items.push({ label: t('web_zip_download'), icon: 'download', onClick: zipDownload });
      if (canSaveAs()) items.push({ label: t('zip_save'), icon: 'save_as', onClick: zipSaveAs });
      menu(zipBtn, items);
    });
    busyButtons.push(zipBtn);
    actions.append(zipBtn);
  }
  content.append(actions);

  const notSaved = h('p', { class: 'ui-result-unsaved' }, t('not_saved_note'));
  content.append(notSaved);

  if (onStartOver) {
    startOver = button({ label: t('start_over'), icon: 'restart_alt', variant: 'text', cls: 'ui-result-startover' });
    startOver.addEventListener('click', async () => {
      if (busy) return;
      if (!saved) {
        const ok = await alertDialog({ title: t('start_over_title'), message: t('not_saved_note'), confirm: t('start_over'), dismiss: t('cancel') });
        if (!ok) return;
      }
      onStartOver();
    });
    content.append(startOver);
  }

  root.append(screen);
  // A screen reader starts at "Your PDF is ready".
  const focusHeading = () => headingEl.focus({ preventScroll: true });
  requestAnimationFrame(focusHeading);

  // Pages are counted for the files on screen, a few at a time.
  const pending = rows.filter((r) => r.needsCount);
  if (pending.length) {
    let next = 0;
    const work = async () => {
      while (next < pending.length && screen.isConnected) {
        const r = pending[next++];
        const n = await countPages(r.file);
        r.setPages(n);
      }
    };
    setTimeout(() => { work(); work(); }, 0);
  }

  // ---- The Usugami watermark on the PDFs ----

  let job = null;
  let readyDone = false;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  // Always after showResult has returned, so the screen calling it has the result screen by then.
  const finishReady = () => {
    if (readyDone || destroyed) return;
    readyDone = true;
    queueMicrotask(() => {
      if (destroyed) return;
      const shown = current();
      resolveReady(shown);
      onReady?.(shown);
    });
  };

  /**
   * Brings the PDFs to the mark the setting asks for (ResultMarker.follow): at once for the PDFs
   * just made (`first`, with "Adding the Usugami watermark…" while it takes a while), otherwise a
   * moment after the change (`wait`), so a quick run of changes rewrites them once. A change while
   * one is under way replaces it.
   */
  function follow({ first = false, wait = true } = {}) {
    if (destroyed) return;
    job?.controller.abort();
    job = null;
    // Not while the PDFs, or a ZIP file of them, are being saved: once that is done.
    if (busy || zipping) {
      pendingFollow = true;
      return;
    }
    pendingFollow = false;
    const wanted = wantedMark();
    if (marker.isAt(wanted)) {
      setMarking(false);
      finishReady();
      return;
    }
    const controller = new AbortController();
    const mine = { controller };
    job = mine;
    setMarking(true);
    const dialog = first && marker.marksAny(wanted)
      ? progressDialog({ title: t('mark_adding'), cancellable: !!onBack, onCancel: () => controller.abort() })
      : null;
    (async () => {
      let outcome = null;
      try {
        if (wait) await settle(SETTLE_MS, controller.signal);
        outcome = await marker.bringTo(wanted, {
          signal: controller.signal,
          // One after another when there are several: "PDF 2 of 5" and its name.
          onFile: (i, n, name) => dialog?.update(n > 1 ? i / n : null, n > 1 ? t('batch_progress', i + 1, n) : undefined, n > 1 ? name : undefined),
        });
      } catch (e) {
        if (!(e instanceof CancelledError)) outcome = { changed: false, failed: true };
      } finally {
        if (dialog) await dialog.close();
      }
      if (job !== mine || destroyed) return;
      job = null;
      setMarking(false);
      if (controller.signal.aborted) {
        // Cancelled while the PDFs just made got the mark: they aren't the result, as in the app.
        if (first) onBack?.();
        return;
      }
      if (outcome?.changed) {
        const shown = current();
        rows.forEach((r, i) => r.update(shown[i]));
        if (!first) unsave();
      }
      if (outcome?.failed) snackbar(t('mark_failed'));
      if (dialog) focusHeading();
      finishReady();
    })();
  }

  let seenConnected = false;
  const stopListening = card ? onMarkSettingChange((setting) => {
    if (screen.isConnected) seenConnected = true;
    else if (seenConnected) {
      // Taken off the page without destroy(): it follows the setting no more.
      stopListening();
      return;
    }
    card.setSetting(setting);
    follow({ wait: true });
  }) : () => {};

  refresh();
  if (card) follow({ first: true, wait: false });
  else finishReady();

  screen.isSaved = () => saved;
  screen.destroy = () => {
    destroyed = true;
    job?.controller.abort();
    job = null;
    stopListening();
    window.removeEventListener('beforeunload', guard);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    screen.remove();
  };
  Object.defineProperty(screen, 'files', { get: current, configurable: true });
  screen.ready = ready;
  screen.markCard = card;
  return screen;
}

/** What the result screen says under a file by itself: how much smaller it got, or that its original was kept. */
function defaultExtra(file) {
  const pct = savedPercent(file.originalSize, file.bytes.length);
  if (pct != null) return t('compressed_from', formatSize(file.originalSize), pct);
  if (file.keptOriginal) return t('original_kept');
  return null;
}

/**
 * One file of the result: its icon, name, pages and size, and for several its own buttons.
 * row.update(file) shows another version of it (the watermark put on or taken off).
 */
function fileRow(file, { single, shareable, details, onOpen, onShare, onSave }) {
  const isPdf = (file.type || PDF) === PDF;
  const sizeLine = h('span', { class: 'ui-result-details' });
  const extraEl = h('span', { class: 'ui-result-extra' });
  const savedMark = h('span', { class: 'ui-result-saved' }, icon('check', { size: 16 }), h('span', {}, t('msg_saved')));
  savedMark.hidden = true;
  const text = h('div', { class: 'ui-result-text' }, h('span', { class: 'ui-result-name' }, file.name), sizeLine, savedMark);
  const lead = h('span', { class: 'ui-result-icon', 'aria-hidden': 'true' }, icon(isPdf ? 'picture_as_pdf' : (file.type === ZIP ? 'folder_zip' : 'description'), { size: 32 }));
  const top = h('div', { class: 'ui-result-row-top' }, lead, text);
  const li = h('li', { class: 'ui-result-file' }, top);
  const row = { el: li, file, needsCount: isPdf && typeof file.pageCount !== 'number' };
  let pages = typeof file.pageCount === 'number' ? file.pageCount : null;
  const render = () => {
    const size = row.file.bytes.length;
    sizeLine.textContent = pages != null ? t('result_details', tp('page_count', pages, pages), formatSize(size)) : formatSize(size);
    const extra = details ? details(row.file) : defaultExtra(row.file);
    // In the row only while there is something to say.
    if (!extra) {
      extraEl.remove();
      return;
    }
    extraEl.textContent = extra;
    extraEl.classList.toggle('is-plain', !!row.file.keptOriginal && !details);
    if (extraEl.parentNode !== text) sizeLine.after(extraEl);
  };
  render();
  row.setPages = (n) => {
    pages = n;
    render();
  };
  row.setSaved = (b) => { savedMark.hidden = !b; };
  row.update = (next) => {
    row.file = next;
    render();
  };
  if (!single) {
    // Under the details, so a long name or a long translation wraps the buttons instead.
    row.openButton = button({ label: t('open'), icon: 'open_in_new', variant: 'text', ariaLabel: t('open_file', file.name), onClick: onOpen });
    const buttons = h('div', { class: 'ui-result-row-buttons' }, row.openButton);
    if (shareable) {
      row.shareButton = button({ label: t('share'), icon: 'share', variant: 'text', ariaLabel: t('share_file', file.name), onClick: onShare });
      buttons.append(row.shareButton);
    }
    row.saveButton = button({ label: t('save'), icon: 'download', variant: 'text', ariaLabel: t('save_file', file.name) });
    row.saveButton.addEventListener('click', () => onSave(row.saveButton));
    buttons.append(row.saveButton);
    li.append(buttons);
  }
  return row;
}
