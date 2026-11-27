// Reorganize PDF's selected pages (the app's core/PageChoice.kt, with PdfPageSelection.read and
// PdfPageSelection.problem). Pages are known by keys that stay with them wherever they go in the
// list; what the user types and reads are their places in the list as it is now ("2,5-7").
// Places count from 0 here; typed numbers count from 1.
import { UserError } from '../core/errors.js';
import { parsePageSelection, formatPages, PageSelectionError } from './page-selection.js';

// Kotlin's isBlank: empty, or only characters Char.isWhitespace() accepts, which are the Unicode
// space, line and paragraph separators and these control characters. (JavaScript's \s differs: it
// has U+FEFF and lacks U+001C to U+001F.)
const BLANK = /^[\t\n\x0B\f\r\x1C-\x1F\p{Zs}\p{Zl}\p{Zp}]*$/u;

/**
 * The pages `text` names (zero-based, in the order typed, each once): none when it is blank, null
 * while it can't be read, as with a typo, a range half typed or a page the PDF hasn't
 * (PdfPageSelection.read).
 * @param {string} text
 * @param {number} pageCount
 * @returns {number[]|null}
 */
export function readPages(text, pageCount) {
  const typed = String(text ?? '');
  if (BLANK.test(typed)) return [];
  try {
    return parsePageSelection(typed, pageCount);
  } catch (e) {
    // What the parser refuses, a PDF without pages included; anything else is a mistake in the code.
    if (e instanceof UserError) return null;
    throw e;
  }
}

/**
 * Why `text` can't be read as pages of a PDF with `pageCount` pages: the string that says so
 * (pdf_pages_format, pdf_pages_range or pdf_pages_reversed) and its arguments, for
 * t(key, ...args). Null when it is blank or can be read, and for a PDF without pages
 * (PdfPageSelection.problem). The first part that is wrong, from the left, decides.
 * @param {string} text
 * @param {number} pageCount
 * @returns {{ key: string, args: any[] }|null}
 */
export function pagesProblem(text, pageCount) {
  const typed = String(text ?? '');
  if (BLANK.test(typed) || !(pageCount > 0)) return null;
  try {
    parsePageSelection(typed, pageCount);
    return null;
  } catch (e) {
    if (e instanceof PageSelectionError) return { key: e.key, args: e.args };
    throw e;
  }
}

/**
 * The places (zero-based, going up) of the pages of `order` that are in `chosen`.
 * @template K
 * @param {K[]} order    the pages' keys, in the list's order
 * @param {Set<K>} chosen
 * @returns {number[]}
 */
export function places(order, chosen) {
  const found = [];
  if (!chosen.size) return found;
  for (let i = 0; i < order.length; i++) if (chosen.has(order[i])) found.push(i);
  return found;
}

/**
 * `chosen` without the pages no longer in `order`: `chosen` itself when all still are, so nothing
 * is ever added to a selection by the list changing.
 * @template K
 * @param {K[]} order
 * @param {Set<K>} chosen
 * @returns {Set<K>}
 */
export function following(order, chosen) {
  if (!chosen.size) return chosen;
  const left = new Set();
  for (const key of order) if (chosen.has(key)) left.add(key);
  return left.size === chosen.size ? chosen : left;
}

/**
 * What the field shows: `typed` as it is while it names just the pages at `places` (in any order),
 * or can't be read and nothing is selected; otherwise `places` written as ranges.
 * @param {string} typed
 * @param {number[]} places
 * @param {number} pageCount
 * @returns {string}
 */
export function fieldText(typed, places, pageCount) {
  const read = readPages(typed, pageCount);
  let asTyped;
  if (read === null) {
    asTyped = places.length === 0;
  } else {
    const named = new Set(read);
    const selected = new Set(places);
    asTyped = named.size === selected.size && [...named].every((page) => selected.has(page));
  }
  return asTyped ? typed : formatPages(places);
}

/**
 * The selection written as the places of its pages in `order`, as ranges: a few characters however
 * many pages ("1-5000"). What the app keeps in its saved state.
 * @template K
 * @param {K[]} order
 * @param {Set<K>} chosen
 * @returns {string}
 */
export function pack(order, chosen) {
  return formatPages(places(order, chosen));
}

/**
 * The selection pack() wrote, for the same `order`; none if it doesn't fit it.
 * @template K
 * @param {string} text
 * @param {K[]} order
 * @returns {Set<K>}
 */
export function unpack(text, order) {
  if (!order.length) return new Set();
  return new Set((readPages(text, order.length) ?? []).map((place) => order[place]));
}
