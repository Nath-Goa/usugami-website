// Page numbers as people type them on the PDF screens: "1,3,5-8" for a list of pages and
// "1-3;5;7-9" for Split's separate ranges (the app's PdfPageSelection.kt). Typed numbers count from
// 1; the page indexes returned count from 0.
import { UserError } from '../core/errors.js';

/** Why typed pages can't be used, and the string that says so (strings.xml). */
const PROBLEM_KEYS = {
  FORMAT: 'pdf_pages_format',
  RANGES_FORMAT: 'pdf_ranges_format',
  OUT_OF_RANGE: 'pdf_pages_range',
  REVERSED: 'pdf_pages_reversed',
  CHUNK_SIZE: 'pdf_pages_chunk',
  ALL_PAGES: 'pdf_need_page',
};

/** The problems whose message names the page count ("Pages must be between 1 and 6."). */
const NAMES_COUNT = new Set(['OUT_OF_RANGE', 'CHUNK_SIZE']);

/**
 * Page input the screens can't use. `problem` says why ('FORMAT', 'RANGES_FORMAT', 'OUT_OF_RANGE',
 * 'REVERSED', 'CHUNK_SIZE' or 'ALL_PAGES'); as a UserError, its key and args are the message to show.
 */
export class PageSelectionError extends UserError {
  constructor(problem, pageCount) {
    super(PROBLEM_KEYS[problem], ...(NAMES_COUNT.has(problem) ? [pageCount] : []));
    this.name = 'PageSelectionError';
    this.problem = problem;
    this.pageCount = pageCount;
  }
}

// Java's \s and \d, as the app's regular expression has them: ASCII only.
const RANGE = /^[ \t\n\x0B\f\r]*(\d+)[ \t\n\x0B\f\r]*(?:-[ \t\n\x0B\f\r]*(\d+)[ \t\n\x0B\f\r]*)?$/;
const INT_MAX = 2147483647;

function checkCount(pageCount) {
  // A screen asking about a PDF without pages: as the app's "Check the page numbers" message.
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new UserError('pdf_invalid_pages');
}

/** A whole number as Kotlin's toIntOrNull reads it: null when it doesn't fit in an Int. */
function toInt(digits) {
  const value = Number(digits);
  return Number.isSafeInteger(value) && value <= INT_MAX ? value : null;
}

/** The pages of one part, like "3" or "2-5", zero-based. */
function range(text, pageCount) {
  const match = RANGE.exec(text);
  if (!match) throw new PageSelectionError('FORMAT', pageCount);
  // A number too long for an Int is out of range too.
  const first = toInt(match[1]);
  if (first === null) throw new PageSelectionError('OUT_OF_RANGE', pageCount);
  let last = first;
  if (match[2] !== undefined) {
    last = toInt(match[2]);
    if (last === null) throw new PageSelectionError('OUT_OF_RANGE', pageCount);
  }
  if (first >= 1 && first <= pageCount && last >= 1 && last < first) throw new PageSelectionError('REVERSED', pageCount);
  if (first < 1 || first > pageCount || last < first || last > pageCount) throw new PageSelectionError('OUT_OF_RANGE', pageCount);
  const pages = [];
  for (let page = first; page <= last; page++) pages.push(page - 1);
  return pages;
}

/**
 * The pages typed like "5,1,3-4" (Split's "Selected pages"), zero-based, in the order typed and
 * each once: [4, 0, 2, 3]. Throws PageSelectionError for input it can't use.
 * @param {string} text
 * @param {number} pageCount
 * @returns {number[]}
 */
export function parsePageSelection(text, pageCount) {
  checkCount(pageCount);
  const result = new Set();
  for (const part of String(text ?? '').split(',')) {
    for (const page of range(part, pageCount)) result.add(page);
  }
  return [...result];
}

/**
 * Split's custom ranges typed like "1-2;5;3-4", each a list of zero-based pages: [[0, 1], [4], [2, 3]].
 * Input typed like a page list ("1-3,5") is told how ranges are separated ('RANGES_FORMAT').
 * @param {string} text
 * @param {number} pageCount
 * @returns {number[][]}
 */
export function parseRanges(text, pageCount) {
  checkCount(pageCount);
  return String(text ?? '').split(';').map((part) => {
    try {
      return range(part, pageCount);
    } catch (e) {
      if (e instanceof PageSelectionError && e.problem === 'FORMAT') throw new PageSelectionError('RANGES_FORMAT', pageCount);
      throw e;
    }
  });
}

/**
 * The pages to delete, typed like "2,5-7": zero-based, in order, each once. Throws
 * PageSelectionError with 'ALL_PAGES' when it names every page: a PDF keeps at least one.
 * @param {string} text
 * @param {number} pageCount
 * @returns {number[]}
 */
export function pagesToDelete(text, pageCount) {
  const pages = parsePageSelection(text, pageCount).sort((a, b) => a - b);
  if (pages.length === pageCount) throw new PageSelectionError('ALL_PAGES', pageCount);
  return pages;
}

/**
 * The pages in chunks of `pagesPerFile` (Split's "Fixed chunks"), the last one shorter if need be:
 * 5 pages by 2 are [[0, 1], [2, 3], [4]]. `pagesPerFile` may be the text typed ("5"); anything but a
 * whole number from 1 to `pageCount` throws PageSelectionError with 'CHUNK_SIZE'.
 * @param {number} pageCount
 * @param {number|string} pagesPerFile
 * @returns {number[][]}
 */
export function fixedChunks(pageCount, pagesPerFile) {
  checkCount(pageCount);
  const size = typeof pagesPerFile === 'string' ? parseCount(pagesPerFile) : pagesPerFile;
  if (!Number.isInteger(size) || size < 1 || size > pageCount) throw new PageSelectionError('CHUNK_SIZE', pageCount);
  const chunks = [];
  for (let start = 0; start < pageCount; start += size) {
    const chunk = [];
    for (let page = start; page < Math.min(start + size, pageCount); page++) chunk.push(page);
    chunks.push(chunk);
  }
  return chunks;
}

/** "Pages per PDF" as typed: trimmed, read as a whole number (Kotlin's toIntOrNull), or 0. */
function parseCount(text) {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return 0;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && Math.abs(value) <= INT_MAX ? value : 0;
}

/** Joins the zero-based pages of `pages`, in its order, as one-based numbers with runs going up as ranges. */
function writeRuns(pages) {
  const parts = [];
  let start = 0;
  while (start < pages.length) {
    let end = start;
    while (end + 1 < pages.length && pages[end + 1] === pages[end] + 1) end++;
    parts.push(end === start ? `${pages[start] + 1}` : `${pages[start] + 1}-${pages[end] + 1}`);
    start = end + 1;
  }
  return parts.join(',');
}

/**
 * Zero-based `pages` written the way people type them, sorted, each once, runs as ranges: pages
 * 1, 4, 5 and 6 become "2,5-7". Blank for no pages. Delete pages' field shows the pages tapped so.
 * @param {Iterable<number>} pages
 * @returns {string}
 */
export function formatPages(pages) {
  return writeRuns([...new Set(pages)].sort((a, b) => a - b));
}

/**
 * Like formatPages, but in the order given, as Split's "Selected pages" keeps it (tapping a page
 * adds it at the end): pages 9, 0, 1, 2 and 4 become "10,1-3,5". Only runs going up become ranges.
 * @param {number[]} pages
 * @returns {string}
 */
export function formatPagesInOrder(pages) {
  return writeRuns([...pages]);
}
