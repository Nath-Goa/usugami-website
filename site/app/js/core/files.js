// Picked, dropped, pasted and shared files as FileItems ({ name, type, size, lastModified, bytes }),
// and what kind of file each one is: by its content first (ImageFileType.kt, the ZIP formats), then
// by its name and its type (SharedFiles.kt).
// Images to PDF's own: how images are told apart and the types its picker offers, from
// image-type.js, which has no imports, so app start doesn't load decode.js and its ~50 kB.
import { imageFileType, IMAGE_HEADER_BYTES, IMAGE_MIME, IMAGE_ACCEPT } from '../engine/images/image-type.js';

const WORD_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/msword',
];
const POWERPOINT_TYPES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'application/vnd.ms-powerpoint',
];
const EXCEL_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.template.macroenabled.12',
  'application/vnd.ms-excel',
];

const EXTENSIONS = {
  pdf: ['pdf'],
  image: ['jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp', 'avif'],
  docx: ['docx', 'docm', 'dotx', 'dotm', 'doc'],
  pptx: ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'ppt', 'pps'],
  epub: ['epub'],
  xlsx: ['xlsx', 'xlsm', 'xltx', 'xltm', 'xls'],
};

const dotted = (kind) => EXTENSIONS[kind].map((e) => '.' + e).join(',');

/**
 * The accept attribute of the file picker for each kind: the types the app's pickers ask for,
 * and the extensions too, as some systems know a file only by its name. The images' list starts
 * with image/*, so a phone offers its gallery, then names Images to PDF's types (ImageStore's
 * pickableTypes: HEIC, HEIF and AVIF too, which some pickers leave out of image/*).
 */
export const ACCEPT = {
  pdf: 'application/pdf,' + dotted('pdf'),
  image: 'image/*,' + IMAGE_ACCEPT,
  docx: [WORD_TYPES[0], WORD_TYPES[1], 'application/vnd.ms-word.document.macroEnabled.12', 'application/msword', dotted('docx')].join(','),
  pptx: [POWERPOINT_TYPES[0], POWERPOINT_TYPES[1], 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', 'application/vnd.ms-powerpoint', dotted('pptx')].join(','),
  xlsx: [EXCEL_TYPES[0], EXCEL_TYPES[1], 'application/vnd.ms-excel.sheet.macroEnabled.12', 'application/vnd.ms-excel.template.macroEnabled.12', 'application/vnd.ms-excel', dotted('xlsx')].join(','),
  epub: 'application/epub+zip,' + dotted('epub'),
};

/** The MIME type a file of each kind is saved and shared as, when nothing better is known. */
const KIND_TYPES = {
  pdf: 'application/pdf',
  docx: WORD_TYPES[0],
  pptx: POWERPOINT_TYPES[0],
  xlsx: EXCEL_TYPES[0],
  epub: 'application/epub+zip',
};

/**
 * How long a cancelled pick waits for files that may follow it: Firefox (as Playwright drives it)
 * sends change up to half a second after cancel while the page is busy. A real cancel shows
 * nothing either way, so waiting longer costs nothing.
 */
const CANCEL_GRACE_MS = 1500;

/**
 * The accept attribute for `accept` (a kind or an accept string) where the picker opens. On
 * Android the EPUB picker also offers "binary data", as the app's (OfficeKind.pickerTypes): some
 * file providers don't know EPUB, and the content says whether a file is an e-book. Elsewhere that
 * type would offer every .bin and .exe file.
 */
function acceptFor(accept) {
  const known = ACCEPT[accept];
  if (accept === 'epub' && /Android/i.test(globalThis.navigator?.userAgent ?? '')) return 'application/epub+zip,application/octet-stream,' + dotted('epub');
  return known ?? accept ?? '';
}

/**
 * Opens the system's file picker and resolves with the files chosen, as FileItems (empty when the
 * picker is cancelled). Call it straight from a click: browsers open pickers only then.
 * `accept` is a kind ('pdf', 'image', 'docx', 'pptx', 'xlsx', 'epub') or an accept string;
 * capture 'environment' opens the phone's camera app instead (on computers, the picker).
 * @param {{ accept?: string, multiple?: boolean, capture?: 'environment'|'user' }} [options]
 * @returns {Promise<FileItem[]>}
 */
export function pickFiles({ accept = 'pdf', multiple = false, capture } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = acceptFor(accept);
  input.multiple = !!multiple;
  if (capture) {
    // The attribute, not the property: browsers without camera capture have no such property.
    input.setAttribute('capture', capture);
    if (!accept || accept === 'image') input.accept = 'image/*';
  }
  // Some browsers only open a picker that is in the page.
  input.hidden = true;
  input.setAttribute('aria-hidden', 'true');
  input.tabIndex = -1;
  document.body.append(input);
  return new Promise((resolve) => {
    let done = false;
    let cancelTimer = 0;
    const finish = async (files) => {
      if (done) return;
      done = true;
      clearTimeout(cancelTimer);
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files?.length ? await toFileItems(files) : []);
    };
    input.addEventListener('change', () => finish(input.files));
    // A cancel can come just before the change that brings the files (Firefox, as Playwright drives
    // it, sends both when files are chosen): the files win if they arrive within a moment.
    input.addEventListener('cancel', () => {
      if (input.files?.length) { finish(input.files); return; }
      clearTimeout(cancelTimer);
      cancelTimer = setTimeout(() => finish(input.files?.length ? input.files : null), CANCEL_GRACE_MS);
    });
    // Browsers without the cancel event: the page gets the focus back once the picker closes.
    // Waits a while, as the change event follows the focus on slow phones.
    const onFocus = () => setTimeout(() => { if (!input.files?.length) finish(null); }, 1500);
    if (!('oncancel' in input)) window.addEventListener('focus', onFocus);
    // Nothing is awaited before this: browsers open a picker only within the tap that asked.
    input.click();
  });
}

/**
 * Reads files (a FileList, File[] or DataTransferItemList's files) into FileItems, in their order.
 * A file that can't be read (deleted meanwhile, or a folder) is left out; `onUnreadable(files)` is
 * told of those left out.
 * @returns {Promise<FileItem[]>}
 */
export async function toFileItems(files, { onUnreadable } = {}) {
  const list = Array.from(files ?? []);
  const items = [];
  const unreadable = [];
  for (const file of list) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const item = { name: file.name || 'file', type: file.type || '', size: bytes.length, lastModified: file.lastModified || Date.now(), bytes };
      // A ZIP (Word, PowerPoint, Excel, EPUB) is read with fflate, loaded only when one comes.
      if (isZip(bytes)) await loadZipReader();
      if (!item.type) item.type = typeOfKind(fileKind(item), item.bytes);
      items.push(item);
    } catch {
      unreadable.push(file);
    }
  }
  if (unreadable.length) onUnreadable?.(unreadable);
  return items;
}

// fflate (about 90 kB) is loaded once a ZIP is picked, dropped, pasted or shared, not at start.
let fflate = null;
let fflateLoading = null;

/** Loads fflate for zipKind; a failure leaves the reading of the ZIP's directory alone. */
function loadZipReader() {
  fflateLoading ??= import('../lib/fflate.js').then((m) => { fflate = m; }, () => { fflateLoading = null; });
  return fflateLoading;
}

const isZip = (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);

/** A FileItem made from bytes (for files made in the app, or in tests). */
export function fileItem(name, bytes, type = '') {
  const item = { name, type, size: bytes.length, lastModified: Date.now(), bytes };
  if (!type) item.type = typeOfKind(fileKind(item), bytes);
  return item;
}

function typeOfKind(kind, bytes) {
  if (kind === 'image') return IMAGE_MIME[imageType(bytes)] ?? '';
  return KIND_TYPES[kind] ?? '';
}

/**
 * What kind of file `item` is: 'pdf', 'image', 'docx', 'pptx', 'xlsx', 'epub' or 'other'. Its
 * content decides first (a PDF named photo.jpg is a PDF), then its name's extension, then its type.
 * Word, PowerPoint and Excel files of the old binary formats (.doc, .ppt, .xls) count as their
 * kind too, as in the app: the converter then says how to make them into ones it reads.
 * @param {{ name?: string, type?: string, bytes?: Uint8Array }} item
 * @returns {'pdf'|'image'|'docx'|'pptx'|'xlsx'|'epub'|'other'}
 */
export function fileKind(item) {
  return kindOfContent(item?.bytes) ?? kindOfName(item?.name) ?? kindOfType(item?.type) ?? 'other';
}

/** The kind the bytes of a file show it is, or null when they don't say (an OLE file, text, ...). */
export function kindOfContent(bytes) {
  if (!bytes?.length) return null;
  if (isPdf(bytes)) return 'pdf';
  if (imageType(bytes)) return 'image';
  if (isZip(bytes)) return zipKind(bytes);
  return null;
}

/** The kind a file's name says, by its extension (SharedFiles.kindOfName), or null. */
export function kindOfName(name) {
  if (!name) return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).trim().toLowerCase();
  for (const [kind, list] of Object.entries(EXTENSIONS)) if (list.includes(ext)) return kind;
  return null;
}

/**
 * The kind a MIME type says (SharedFiles.kindOfType), whatever its case and parameters; null for
 * types that say nothing about the file, such as application/octet-stream.
 */
export function kindOfType(type) {
  if (!type) return null;
  const t = type.split(';')[0].trim().toLowerCase();
  if (t === 'application/pdf' || t === 'application/x-pdf') return 'pdf';
  if (t.startsWith('image/')) return 'image';
  if (WORD_TYPES.includes(t)) return 'docx';
  if (POWERPOINT_TYPES.includes(t)) return 'pptx';
  if (t === 'application/epub+zip') return 'epub';
  if (EXCEL_TYPES.includes(t)) return 'xlsx';
  return null;
}

const KIND_ORDER = ['pdf', 'image', 'docx', 'pptx', 'epub', 'xlsx'];

/**
 * The kind files of several `kinds` are taken as (SharedFiles.chosen): the kind most of them are,
 * and when as many are of two kinds, PDFs before images, and images before Word, PowerPoint, EPUB
 * and Excel files. Null when none is of a kind the app takes.
 */
export function chosenKind(kinds) {
  const counts = new Map();
  for (const k of kinds) if (KIND_ORDER.includes(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
  let best = null;
  for (const k of KIND_ORDER) if (counts.has(k) && (best == null || counts.get(k) > counts.get(best))) best = k;
  return best;
}

/** Whether the file is a PDF: "%PDF-" near its start, where readers look for it. */
function isPdf(bytes) {
  const end = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= end; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
  }
  return false;
}

/**
 * The type of image the bytes start (ImageFileType.of, engine/images/image-type.js's
 * imageFileType): 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heif' (HEIC and other HEIF files, as
 * phones save photos) or 'avif'; null when none of these.
 * @param {Uint8Array} bytes  the file, or at least its first 64 bytes
 */
export function imageType(bytes) {
  if (!bytes?.length) return null;
  return imageFileType(bytes.subarray(0, IMAGE_HEADER_BYTES));
}

/** Largest [Content_Types].xml or mimetype entry read: a real one is a few kilobytes. */
const MAX_ENTRY = 1 << 20;

/**
 * Which ZIP-based format the archive is: an EPUB names its type in a "mimetype" entry; Word,
 * PowerPoint and Excel files name their main part's type in [Content_Types].xml (embedded charts
 * and workbooks are listed there too, so only a main part counts), or else have the main part
 * itself. Null for other ZIP files and for damaged ones.
 */
function zipKind(bytes) {
  const names = [];
  let entries;
  try {
    entries = fflate ? fflate.unzipSync(bytes, {
      filter: (f) => {
        names.push(f.name);
        return (f.name === 'mimetype' || f.name === '[Content_Types].xml') && f.originalSize <= MAX_ENTRY;
      },
    }) : storedEntries(bytes, names);
  } catch {
    return null;
  }
  if (!entries) return null;
  const mimetype = entries.mimetype && latin1(entries.mimetype).trim();
  if (mimetype === 'application/epub+zip') return 'epub';
  const types = entries['[Content_Types].xml'] ? new TextDecoder().decode(entries['[Content_Types].xml']) : '';
  for (const m of types.matchAll(/ContentType\s*=\s*["']([^"']*\.main\+xml)["']/gi)) {
    const t = m[1].toLowerCase();
    if (/wordprocessingml|ms-word/.test(t)) return 'docx';
    if (/presentationml|ms-powerpoint/.test(t)) return 'pptx';
    if (/spreadsheetml|ms-excel/.test(t)) return 'xlsx';
  }
  const has = (n) => names.some((x) => x.toLowerCase() === n);
  if (has('word/document.xml')) return 'docx';
  if (has('ppt/presentation.xml')) return 'pptx';
  if (has('xl/workbook.xml')) return 'xlsx';
  if (has('meta-inf/container.xml') && names.some((x) => /\.opf$/i.test(x))) return 'epub';
  return null;
}

/**
 * Without fflate (a FileItem not made by toFileItems): the ZIP's names from its central directory,
 * into `names`, and its mimetype and [Content_Types].xml entries when they are stored as they are
 * (an EPUB's mimetype always is). Compressed ones are left out: the main part's name still tells.
 * Null for a damaged ZIP (or a ZIP64 one).
 */
function storedEntries(bytes, names) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    names.push(name);
    if ((name === 'mimetype' || name === '[Content_Types].xml') && method === 0 && size <= MAX_ENTRY && local + 30 <= bytes.length) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + size <= bytes.length) entries[name] = bytes.subarray(start, start + size);
    }
    at += 46 + skip;
  }
  return entries;
}

function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/** The first 256 bytes, one character each. */
function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length && i < 256; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
