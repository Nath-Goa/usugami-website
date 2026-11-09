// Files shared to the installed app (Web Share Target, received by sw.js) or opened with it
// (manifest file_handlers, window.launchQueue), routed as the Android app routes files shared to
// it (MainActivity, MainViewModel.share, SharedFiles.kt): images open Images to PDF; Word,
// PowerPoint, Excel and EPUB files their converter; PDFs Choose a tool. Files of several kinds:
// the kind most of them are (PDFs first on a tie), naming the files left out and those that
// can't be opened.
import { t, tp } from './i18n.js';
import { listOfNames } from './names.js';
import { navigate, currentRoute, currentHandle, onRouteChange } from './router.js';

/** The kinds in the order they win a tie (SharedKind's order). */
export const SHARED_KINDS = ['pdf', 'image', 'docx', 'pptx', 'epub', 'xlsx'];

/** Where files of each kind open. */
export const SHARE_TARGETS = {
  pdf: '/choose',
  image: '/tool/images',
  docx: '/tool/word',
  pptx: '/tool/powerpoint',
  epub: '/tool/epub',
  xlsx: '/tool/excel',
};

// The old binary formats are taken too: the converter then says how to make them into ones it reads.
const WORD_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/msword',
]);
const POWERPOINT_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'application/vnd.ms-powerpoint',
]);
const EXCEL_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.template.macroenabled.12',
  'application/vnd.ms-excel',
]);

function kindOfType(type) {
  if (!type) return null;
  const tt = String(type).split(';')[0].trim().toLowerCase();
  if (tt === 'application/pdf' || tt === 'application/x-pdf') return 'pdf';
  if (tt.startsWith('image/')) return 'image';
  if (WORD_TYPES.has(tt)) return 'docx';
  if (POWERPOINT_TYPES.has(tt)) return 'pptx';
  if (tt === 'application/epub+zip') return 'epub';
  if (EXCEL_TYPES.has(tt)) return 'xlsx';
  return null;
}

function kindOfName(name) {
  if (!name) return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).trim().toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['docx', 'docm', 'dotx', 'dotm', 'doc'].includes(ext)) return 'docx';
  if (['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'ppt', 'pps'].includes(ext)) return 'pptx';
  if (ext === 'epub') return 'epub';
  if (['xlsx', 'xlsm', 'xltx', 'xltm', 'xls'].includes(ext)) return 'xlsx';
  return null;
}

/**
 * What a shared file is, from its `type` (such as 'application/pdf'), else its `name`'s
 * extension, else `sharedAs`, the type the whole share was sent as (SharedFiles.kindOf).
 * Types that say nothing about the file ('application/octet-stream', '*\/*') are passed over.
 * @returns {'pdf'|'image'|'docx'|'pptx'|'xlsx'|'epub'|'other'}
 */
export function kindOfShared(type, name, sharedAs) {
  return kindOfType(type) ?? kindOfName(name) ?? kindOfType(sharedAs) ?? 'other';
}

/**
 * The kind a share of files of `kinds` is taken as: the kind most of them are; on a tie PDFs
 * before images, before Word, PowerPoint, EPUB and Excel files (SharedFiles.chosen). Null when
 * none is of a kind Usugami takes.
 * @param {string[]} kinds
 * @returns {string|null}
 */
export function chosenKind(kinds) {
  const counts = new Map();
  for (const k of kinds) if (SHARED_KINDS.includes(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
  let best = null;
  for (const k of SHARED_KINDS) {
    if (counts.has(k) && (best === null || counts.get(k) > counts.get(best))) best = k;
  }
  return best;
}

/**
 * Sorts the files of a share: which kind is taken, the files taken, the names of those Usugami
 * can't open and of those of another kind it left out, and where the taken files open.
 * @template T
 * @param {T[]} items
 * @param {string[]} kinds   each item's kind (kindOfShared or files.js fileKind)
 * @param {(item: T) => string} nameOf
 * @returns {{ kind: string|null, taken: T[], unsupported: string[], otherKind: string[], target: string|null }}
 */
export function sortShared(items, kinds, nameOf) {
  const kind = chosenKind(kinds);
  const taken = [];
  const unsupported = [];
  const otherKind = [];
  items.forEach((item, i) => {
    if (!SHARED_KINDS.includes(kinds[i])) unsupported.push(nameOf(item));
    else if (kinds[i] === kind) taken.push(item);
    else otherKind.push(nameOf(item));
  });
  return { kind, taken, unsupported, otherKind, target: kind ? SHARE_TARGETS[kind] : null };
}

/** A name for a shared file that came without one, to say which it is (MainViewModel.fallbackName). */
export function fallbackName(kind) {
  return { pdf: 'Document.pdf', docx: 'Document.docx', pptx: 'Presentation.pptx', epub: 'Book.epub', xlsx: 'Spreadsheet.xlsx' }[kind] ?? 'File';
}

// ---- Receiving ----

/** The PDFs shared, waiting on Choose a tool. */
let sharedPdfs = [];
/**
 * Files shared that wait until the user leaves the screen showing ({ item, kind }[]): a tool with
 * unsaved work they chose to keep (more shares then join them without asking again, as the app's
 * stayOnPdf), or the first launch's language choice. Null when none wait.
 */
let waiting = null;
/** Files shared while the question about unsaved work is open ({ item, kind }[]), else null. */
let asked = null;
let unwatchRoute = null;

/** The PDFs on Choose a tool (FileItems), in the order they came. */
export function getSharedPdfs() {
  return sharedPdfs.slice();
}

/** Replaces the PDFs on Choose a tool (after one is removed, say). */
export function setSharedPdfs(items) {
  sharedPdfs = items.slice();
}

/** Forgets the PDFs shared: the user left Choose a tool. */
export function clearSharedPdfs() {
  sharedPdfs = [];
}

async function kit() {
  const [ui, files] = await Promise.all([import('./ui.js'), import('./files.js')]);
  return { ui, files };
}

function say(ui, message) {
  try {
    ui.snackbar(message);
  } catch {
    // No snackbar: nothing more to say.
  }
}

/**
 * Opens files shared to or opened with the app, as the Android app does. `files` are File
 * objects or FileItems; `unreadable` counts files that couldn't be read at all.
 * @param {(File|{name:string,type:string,size:number,lastModified:number,bytes:Uint8Array})[]} files
 * @param {{ unreadable?: number }} [options]
 */
export async function receiveFiles(files, { unreadable = 0 } = {}) {
  const { ui, files: fileKit } = await kit();
  let items = [];
  let failed = unreadable;
  const list = Array.from(files ?? []);
  const raw = list.filter((f) => !(f && f.bytes instanceof Uint8Array));
  items = list.filter((f) => f && f.bytes instanceof Uint8Array);
  for (const file of raw) {
    try {
      items.push(...await fileKit.toFileItems([file]));
    } catch {
      failed++;
    }
  }
  const kinds = items.map((item) => {
    let kind = 'other';
    try {
      kind = fileKit.fileKind(item);
    } catch {
      kind = 'other';
    }
    // The old .doc, .ppt and .xls go to their converter, which says how to make them readable.
    return SHARED_KINDS.includes(kind) ? kind : kindOfShared(item.type, item.name);
  });
  items.forEach((item, i) => {
    if (!item.name) item.name = fallbackName(kinds[i]);
  });
  const joining = waiting ?? asked;
  if (joining) {
    // Files wait already (the user kept the tool's work, is being asked about it, or chooses a
    // language first): these join them, with no question, and all are sorted together.
    const sorted = sortShared(items, kinds, (item) => item.name);
    if (sorted.unsupported.length) say(ui, tp('share_unsupported', sorted.unsupported.length, sorted.unsupported.length, listOfNames(sorted.unsupported)));
    if (failed > 0) say(ui, tp('msg_share_unreadable', failed, failed));
    items.forEach((item, i) => {
      if (SHARED_KINDS.includes(kinds[i])) joining.push({ item, kind: kinds[i] });
    });
    return;
  }
  const sorted = sortShared(items, kinds, (item) => item.name);
  if (sorted.unsupported.length) say(ui, tp('share_unsupported', sorted.unsupported.length, sorted.unsupported.length, listOfNames(sorted.unsupported)));
  if (sorted.otherKind.length) say(ui, tp('share_other_kind', sorted.otherKind.length, sorted.otherKind.length, listOfNames(sorted.otherKind)));
  if (failed > 0) say(ui, tp('msg_share_unreadable', failed, failed));
  if (!sorted.target) return;
  await open(sorted.kind, sorted.target, sorted.taken, ui);
}

/** Sorts files that waited ({ item, kind }[]) as one share, naming those of other kinds left out. */
function sortWaited(entries, ui) {
  const sorted = sortShared(entries.map((x) => x.item), entries.map((x) => x.kind), (item) => item.name);
  if (sorted.otherKind.length) say(ui, tp('share_other_kind', sorted.otherKind.length, sorted.otherKind.length, listOfNames(sorted.otherKind)));
  return sorted;
}

/**
 * Keeps files ({ item, kind }[]) until the screen showing is left, then opens what waits: the
 * kind most of them are, the others named (as the app sorts its shared files once it can open
 * them).
 */
function wait(entries, ui) {
  waiting = entries.slice();
  unwatchRoute ??= onRouteChange(() => {
    const w = waiting;
    waiting = null;
    unwatchRoute?.();
    unwatchRoute = null;
    if (!w?.length) return;
    const sorted = sortWaited(w, ui);
    if (sorted.target) setTimeout(() => open(sorted.kind, sorted.target, sorted.taken, ui), 0);
  });
}

/**
 * The addresses showing the screen files shared for `target` open in: Scan document and Images to
 * PDF are one screen (tools/images/index.js), so images shared during a scan join it.
 */
const SAME_SCREEN = {
  '/tool/images': ['/tool/images', '/tool/scan'],
};

/**
 * Opens `target` with the files, in place of the screen showing (as the app's openForShare: Back
 * then leads Home, not to it), asking first when that screen has unsaved work.
 */
async function open(kind, target, files, ui) {
  const route = currentRoute();
  const handle = currentHandle();
  // The first launch asks for the language first: the files wait for the choice.
  if (route?.name === 'language') {
    wait(files.map((item) => ({ item, kind })), ui);
    return;
  }
  const here = !!route && (SAME_SCREEN[target] ?? [target]).includes(route.path);
  // The tool showing takes more files itself (Images to PDF adds shared images to its list).
  if (here && typeof handle?.receiveFiles === 'function') {
    await handle.receiveFiles(files);
    return;
  }
  let unsaved = false;
  try {
    unsaved = !!handle?.hasUnsavedWork?.();
  } catch {
    unsaved = false;
  }
  if (unsaved) {
    // A PDF made and not saved yet is asked about as the app does, rather than changes to it.
    const atResult = route?.step === 'result';
    // Files shared while it is asked join these (the app asks once).
    const all = files.map((item) => ({ item, kind }));
    asked = all;
    let discard = false;
    try {
      discard = await ui.alertDialog({
        title: t(atResult ? 'pdf_discard_title' : 'tool_discard_title'),
        message: t(kind === 'image'
          ? (atResult ? 'pdf_discard_shared_body' : 'pdf_discard_shared_changes')
          : (atResult ? 'share_discard_body' : 'share_discard_changes')),
        confirm: t('discard'),
        dismiss: t('keep'),
        destructive: true,
      });
    } finally {
      asked = null;
    }
    if (!discard) {
      // The files wait until the user leaves this screen.
      wait(all, ui);
      return;
    }
    if (all.length > files.length) {
      const sorted = sortWaited(all, ui);
      if (!sorted.target) return;
      ({ kind, target } = sorted);
      files = sorted.taken;
    }
  }
  if (kind === 'pdf') {
    // PDFs shared while Choose a tool shows join those listed there (the app's addShared).
    sharedPdfs = route?.path === '/choose' ? [...sharedPdfs, ...files] : files.slice();
    navigate('/choose', { force: true, replaceScreen: true });
  } else {
    navigate(target, { files, force: true, replaceScreen: true });
  }
}

/** Where sw.js keeps a share's files: site/app/share/<id>/<n>. */
const shareBase = new URL('../../share/', import.meta.url);

/** The files the service worker kept for a share (sw.js, share target), deleted once read. */
async function takeFromServiceWorker(id) {
  const files = [];
  let unreadable = 0;
  try {
    const cache = await caches.open('usugami-share');
    const indexUrl = new URL(`${id}/index`, shareBase).href;
    const indexResponse = await cache.match(indexUrl);
    const index = indexResponse ? await indexResponse.json() : { files: [], unreadable: 0 };
    unreadable += Number(index.unreadable) || 0;
    for (const entry of index.files ?? []) {
      const url = new URL(`${id}/${Number(entry.i)}`, shareBase).href;
      try {
        const response = await cache.match(url);
        if (!response) {
          unreadable++;
          continue;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        files.push({ name: String(entry.name || ''), type: String(entry.type || ''), size: bytes.length, lastModified: Number(entry.lastModified) || Date.now(), bytes });
      } catch {
        unreadable++;
      }
      await cache.delete(url);
    }
    await cache.delete(indexUrl);
    // Shares never picked up (the app was closed first) don't stay.
    const hourAgo = Date.now() - 3600_000;
    for (const request of await cache.keys()) {
      const m = new URL(request.url).pathname.match(/\/share\/(\d+)-/);
      if (m && Number(m[1]) < hourAgo) await cache.delete(request);
    }
  } catch {
    return { files, unreadable };
  }
  return { files, unreadable };
}

/**
 * Picks up a share the service worker received (the page was opened with ?share=<id>) and files
 * opened with the installed app (launchQueue). Call once the router has started.
 */
export async function initShareInbox() {
  const url = new URL(location.href);
  const id = url.searchParams.get('share');
  if (id) {
    // The address goes back to the app's own, so a reload doesn't look for the share again.
    url.searchParams.delete('share');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    if (/^[\w-]+$/.test(id) && typeof caches !== 'undefined') {
      const { files, unreadable } = await takeFromServiceWorker(id);
      if (files.length || unreadable) await receiveFiles(files, { unreadable });
    }
  }
  if ('launchQueue' in window && typeof window.launchQueue?.setConsumer === 'function') {
    window.launchQueue.setConsumer(async (params) => {
      const handles = params?.files ?? [];
      if (!handles.length) return;
      const files = [];
      let unreadable = 0;
      for (const handle of handles) {
        try {
          files.push(await handle.getFile());
        } catch {
          unreadable++;
        }
      }
      await receiveFiles(files, { unreadable });
    });
  }
}
