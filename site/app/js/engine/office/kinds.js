// Word, PowerPoint, Excel and EPUB to PDF: the kinds of document, their choices, the names the
// PDFs get and the app's message keys (OfficeConverter.kt, OfficeOptions.kt, PdfToolsViewModel's
// messages). Nothing here reads a file, so the converter screens load it at once and the engine
// (./index.js, which re-exports all of this) only when a file is checked or converted.
import { UserError } from '../../core/errors.js';
import { baseName, sanitizeName, uniqueNames } from '../../core/names.js';
import { OfficeFileProblem, officeReasonKey } from './problems.js';

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
