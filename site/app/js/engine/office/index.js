// Word, PowerPoint, Excel and EPUB to PDF: what every converter screen calls (the app's
// OfficeConverter.kt, with OfficeOptions.kt's choices and PdfToolsViewModel's messages). It checks
// the file as the app does when one is picked, loads the kind's converter (./docx.js, ./pptx.js,
// ./xlsx.js, ./epub.js) only when needed, names the PDF, and turns every failure into the app's
// message for that kind of file.
import { UserError, PasswordError, checkCancelled } from '../../core/errors.js';
import { fileKind } from '../../core/files.js';
import { baseName, sanitizeName, uniqueNames } from '../../core/names.js';
import { OfficeFileType, OfficeContainer } from './office-formats.js';
import { verifyOfficePackage } from './ooxml.js';
import { ZipArchive, ZipError } from './zip.js';
import { OfficeFileProblem, OfficeNotRecognized, OfficeNothingToConvert, officeReasonKey } from './problems.js';

/**
 * The kinds of document converted (OfficeKind): the file extension, the name a PDF gets when it
 * has none of its own, the file picker's kind (core/files.js), and the converter module.
 */
export const OFFICE_KINDS = Object.freeze({
  word: Object.freeze({ id: 'word', extension: 'docx', fallbackName: 'Document', accept: 'docx', module: './docx.js', convert: 'convertDocx' }),
  powerpoint: Object.freeze({ id: 'powerpoint', extension: 'pptx', fallbackName: 'Presentation', accept: 'pptx', module: './pptx.js', convert: 'convertPptx' }),
  excel: Object.freeze({ id: 'excel', extension: 'xlsx', fallbackName: 'Spreadsheet', accept: 'xlsx', module: './xlsx.js', convert: 'convertXlsx' }),
  epub: Object.freeze({ id: 'epub', extension: 'epub', fallbackName: 'Book', accept: 'epub', module: './epub.js', convert: 'convertEpub' }),
});

const KIND_OF_FILE = { docx: 'word', pptx: 'powerpoint', xlsx: 'excel', epub: 'epub' };

/**
 * The kind of document `fileItem` is ('word', 'powerpoint', 'excel', 'epub'), by its content, then
 * its name and type, as core/files.js tells (old .doc, .ppt and .xls files count as their kind, so
 * converting one says how to save it in the new format); null for anything else.
 */
export function officeKindOf(fileItem) {
  return KIND_OF_FILE[fileKind(fileItem)] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Options

/** The papers a book can be laid out on (BookPageOptions): A5, about a paperback's, or A4 for printing. */
export const BOOK_PAGES = Object.freeze([
  Object.freeze({ value: 'a5', label: 'size_a5' }),
  Object.freeze({ value: 'a4', label: 'size_a4' }),
]);

/** The papers a workbook's sheets can be put on (SheetPapers): null keeps each sheet's own. */
export const SHEET_PAPERS = Object.freeze([
  Object.freeze({ value: null, label: 'sheet_as_file' }),
  Object.freeze({ value: 'a4', label: 'size_a4' }),
  Object.freeze({ value: 'letter', label: 'size_letter' }),
  Object.freeze({ value: 'legal', label: 'size_legal' }),
  Object.freeze({ value: 'a3', label: 'size_a3' }),
  Object.freeze({ value: 'a5', label: 'size_a5' }),
]);

/** Portrait (false) or landscape (true) for every sheet (SheetOrientations): null keeps each sheet's own. */
export const SHEET_ORIENTATIONS = Object.freeze([
  Object.freeze({ value: null, label: 'sheet_as_file' }),
  Object.freeze({ value: false, label: 'orientation_portrait' }),
  Object.freeze({ value: true, label: 'orientation_landscape' }),
]);

const DEFAULTS = Object.freeze({
  word: Object.freeze({}),
  powerpoint: Object.freeze({}),
  // A book is laid out on A5 pages unless A4 is chosen.
  epub: Object.freeze({ bookPage: 'a5' }),
  // SheetOptions: each sheet's own paper and orientation, wide sheets shrunk to the page's width,
  // and no gridlines but those the sheets print.
  excel: Object.freeze({ paper: null, landscape: null, fitWidth: true, gridlines: false }),
});

/** The options a converter starts with for `kind` (a new object each time). */
export function defaultOfficeOptions(kind) {
  const d = DEFAULTS[kind];
  if (!d) throw new RangeError(`Unknown kind of document: ${kind}`);
  return { ...d };
}

/** `options` for `kind` with every field checked and the defaults filled in (unknown fields kept). */
export function officeOptions(kind, options = {}) {
  const out = { ...defaultOfficeOptions(kind), ...(options ?? {}) };
  if (kind === 'epub' && !BOOK_PAGES.some((p) => p.value === out.bookPage)) out.bookPage = DEFAULTS.epub.bookPage;
  if (kind === 'excel') {
    if (!SHEET_PAPERS.some((p) => p.value === out.paper)) out.paper = null;
    if (out.landscape !== true && out.landscape !== false) out.landscape = null;
    out.fitWidth = out.fitWidth !== false;
    out.gridlines = out.gridlines === true;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Names

/**
 * The name (with ".pdf") the PDF made of `input` gets: `typed` when given, else the file's own
 * name without its extension ("Report.docx" becomes "Report.pdf"), made safe.
 */
export function officeOutputName(input, kind, typed = null) {
  const fallback = OFFICE_KINDS[kind]?.fallbackName ?? 'Document';
  const name = typed != null && String(typed).trim() !== '' ? typed : baseName(input?.name ?? '');
  return `${sanitizeName(name, fallback)}.pdf`;
}

/**
 * The names the PDFs made of several files together get (convertEach): each its own (or the one
 * typed for it, from `typed`, an array matching `inputs`), told apart when two ask for one name.
 */
export function officeOutputNames(inputs, kind, typed = []) {
  const fallback = OFFICE_KINDS[kind]?.fallbackName ?? 'Document';
  const wanted = inputs.map((input, i) => (typed?.[i] != null && String(typed[i]).trim() !== '' ? typed[i] : baseName(input?.name ?? '')));
  return uniqueNames(wanted, fallback).map((n) => `${n}.pdf`);
}

// ---------------------------------------------------------------------------------------------
// Errors

/**
 * The strings.xml key for `error` (thrown by verifyOfficeFile or convertOffice) about a file of
 * `kind`: of one file, or with `many` of several. Errors that aren't about the file give
 * 'office_convert_failed' ("Couldn't convert this file. Check the file and free storage.").
 */
export function officeErrorKey(error, kind, many = false) {
  if (error instanceof OfficeFileProblem) return officeReasonKey(error, kind, many);
  if (error instanceof UserError) return many && error.manyKey ? error.manyKey : error.key;
  return 'office_convert_failed';
}

/** A UserError for `problem`, a file of `kind`: its key of one file, and `manyKey` of several. */
function problemError(problem, kind) {
  const e = new UserError(officeReasonKey(problem, kind));
  e.manyKey = officeReasonKey(problem, kind, true);
  e.problem = problem.problem;
  e.cause = problem;
  return e;
}

function failed(cause) {
  const e = new UserError('office_convert_failed');
  e.cause = cause;
  return e;
}

const isCancel = (e) => e?.name === 'CancelledError';

// ---------------------------------------------------------------------------------------------
// Checking and converting

/** The kind's converter module, loaded once. */
const modules = new Map();
function converterModule(kind) {
  const k = OFFICE_KINDS[kind];
  let m = modules.get(kind);
  if (!m) {
    m = import(new URL(k.module, import.meta.url).href);
    // A module that failed to load (offline, say) is tried again next time.
    m.catch(() => modules.delete(kind));
    modules.set(kind, m);
  }
  return m;
}

/**
 * Throws an OfficeFileProblem unless `bytes` is a `kind` file that can be converted: OfficeConverter.verify.
 * Word, PowerPoint and Excel files: an old binary file or a password-protected one gets its own
 * problem, anything else that isn't that kind's package OfficeNotRecognized. E-books: a zip, which
 * the EPUB converter's own verifyEpub(input, hooks) checks further when it has one.
 */
async function verify(kind, input, hooks) {
  const bytes = input?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw new OfficeNotRecognized();
  if (kind !== 'epub') return verifyOfficePackage(bytes, kind, hooks);
  if (OfficeFileType.container(bytes.subarray(0, 8)) !== OfficeContainer.ZIP) throw new OfficeNotRecognized();
  let mod = null;
  try {
    mod = await converterModule('epub');
  } catch {
    mod = null;
  }
  if (typeof mod?.verifyEpub === 'function') {
    try {
      await mod.verifyEpub(input, hooks);
    } catch (e) {
      if (isCancel(e) || e instanceof OfficeFileProblem || e instanceof UserError) throw e;
      throw new OfficeNotRecognized();
    }
    return;
  }
  try {
    ZipArchive.open(bytes);
  } catch {
    throw new OfficeNotRecognized();
  }
}

/**
 * Checks that `input` ({ name, bytes }) is a `kind` file that can be converted, as the app checks a
 * file when it is picked or shared. Resolves when it is; throws UserError with the app's message
 * otherwise (its `key` for one file, `manyKey` for several; for example 'office_legacy_word' "This is
 * an old Word file (.doc). Save it as .docx in Word or another app, then try again."), or
 * CancelledError.
 */
export async function verifyOfficeFile(kind, input, hooks = {}) {
  if (!OFFICE_KINDS[kind]) throw new RangeError(`Unknown kind of document: ${kind}`);
  checkCancelled(hooks.signal);
  try {
    await verify(kind, input, hooks);
  } catch (e) {
    if (isCancel(e) || e instanceof UserError) throw e;
    throw problemError(e instanceof OfficeFileProblem ? e : new OfficeNotRecognized(), kind);
  }
}

/** A converter's result as { bytes, pageCount }. */
function resultOf(out) {
  if (out instanceof Uint8Array) return { bytes: out, pageCount: undefined };
  if (out && out.bytes instanceof Uint8Array) return { ...out };
  return null;
}

/**
 * Converts `input` ({ name, bytes }), a `kind` file ('word', 'powerpoint', 'excel', 'epub'), into a
 * PDF. `options`: the kind's (see defaultOfficeOptions), plus `name` (the PDF's name as typed,
 * without ".pdf"; default the file's own). `hooks`: { onProgress(done, total, info), signal }:
 * `done` of `total` pages, slides or chapters (total null for Word, whose page count isn't known
 * until the end), then `info.compressing` as the PDF is saved.
 * Resolves to an OutputFile { name, bytes, type: 'application/pdf', pageCount }. Throws UserError
 * with the app's message (see officeErrorKey), or CancelledError.
 */
export async function convertOffice(kind, input, options = {}, hooks = {}) {
  const k = OFFICE_KINDS[kind];
  if (!k) throw new RangeError(`Unknown kind of document: ${kind}`);
  const { signal } = hooks;
  const opts = officeOptions(kind, options);
  const name = officeOutputName(input, kind, opts.name ?? null);
  await verifyOfficeFile(kind, input, hooks);
  let result;
  try {
    const mod = await converterModule(kind);
    const convert = mod?.[k.convert];
    if (typeof convert !== 'function') throw new Error(`${k.module} has no ${k.convert}()`);
    checkCancelled(signal);
    result = resultOf(await convert({ name: input.name, bytes: input.bytes }, opts, hooks));
    checkCancelled(signal);
    if (!result || !result.bytes.length) throw new Error(`${k.convert}() gave no PDF`);
    if (result.pageCount === 0) throw new OfficeNothingToConvert();
  } catch (e) {
    if (isCancel(e) || e instanceof PasswordError) throw e;
    if (e instanceof OfficeFileProblem) throw problemError(e, kind);
    if (e instanceof UserError) throw e;
    // A workbook part too large to inflate is a workbook too large to convert, as the app says.
    if (e instanceof ZipError && e.reason === 'too-large' && kind === 'excel') throw problemError({ problem: 'too-large' }, kind);
    throw failed(e);
  }
  return { name, bytes: result.bytes, type: 'application/pdf', pageCount: result.pageCount };
}

export {
  OfficeFileProblem, OfficeLegacyFormat, OfficeEncrypted, OfficeNotRecognized, OfficeNothingToConvert,
  OfficeTooLarge, OfficeEmbeddedContent, EpubProtected, officeReasonKey,
} from './problems.js';
