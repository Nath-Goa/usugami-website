// File names, as the app makes them (FileNames.kt): safe on every file system, never too long,
// and unique among files made together.

/** Leaves room for " (99).pdf" within the usual 255-byte limit of file systems. */
const MAX_UTF8_BYTES = 200;

/** Characters that file systems or storage providers reject, and control characters. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/**
 * Windows' device names, which it won't give a file, in any case and whatever follows a dot
 * ("nul.pdf" and "Con.notes.pdf" too), so such a file can't be copied to a PC or unzipped there.
 */
const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?= *(\.|$))/i;

/**
 * Kotlin's Char.isWhitespace (Java's Character.isWhitespace or isSpaceChar): spaces, the no-break
 * spaces too, and line breaks.
 */
const KOTLIN_SPACE = /^[\t\n\u000b\f\r\u001c-\u001f\p{Zs}\p{Zl}\p{Zp}]$/u;

const encoder = new TextEncoder();

/** How many bytes `text` takes in UTF-8. */
export function utf8Size(text) {
  return encoder.encode(text).length;
}

const isSpace = (ch) => KOTLIN_SPACE.test(ch);
const isTrimmed = (ch) => isSpace(ch) || ch === '.';

/** Without spaces and dots at the end. */
function trimEnd(text) {
  const chars = Array.from(text);
  while (chars.length && isTrimmed(chars[chars.length - 1])) chars.pop();
  return chars.join('');
}

/** Without spaces and dots at the start. */
function trimStart(text) {
  const chars = Array.from(text);
  let i = 0;
  while (i < chars.length && isTrimmed(chars[i])) i++;
  return chars.slice(i).join('');
}

/** Kotlin's String.trim(): drops whitespace (Char.isWhitespace) at both ends. */
function kotlinTrim(text) {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && isSpace(chars[start])) start++;
  while (end > start && isSpace(chars[end - 1])) end--;
  return chars.slice(start, end).join('');
}

/** The characters of `text` as people see them: a letter with its accents, a whole emoji. */
function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * `text` cut to at most `maxBytes` bytes of UTF-8 between whole characters as people see them.
 * Only a single such character too long for the limit is cut inside, between code points.
 */
function truncateUtf8(text, maxBytes) {
  if (utf8Size(text) <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const g of graphemes(text)) {
    const size = utf8Size(g);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += g;
  }
  if (out) return out;
  for (const cp of Array.from(text)) {
    const size = utf8Size(cp);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += cp;
  }
  return out;
}

/**
 * Turns user input into a safe PDF base name (no extension): characters that file systems reject
 * become '_', surrounding spaces and dots are trimmed, a trailing ".pdf" is dropped and the result
 * is kept to 200 bytes. A name Windows keeps for a device gets '_' after it ("CON" becomes "CON_").
 * Returns `fallback` for a name that ends up empty.
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeName(name, fallback) {
  // The end is trimmed before the extension check too, so "Report.pdf." loses its ".pdf" as well.
  let out = trimEnd(kotlinTrim(String(name ?? '')).replace(ILLEGAL, '_'));
  if (out.toLowerCase().endsWith('.pdf')) out = out.slice(0, -4);
  out = trimStart(trimEnd(out));
  out = trimEnd(truncateUtf8(out, MAX_UTF8_BYTES));
  out = out.replace(WINDOWS_DEVICE, '$1_');
  return out || fallback;
}

/**
 * `base` made safe (with `fallback` for a blank one) and followed by `suffix`, such as
 * "Report_redacted". When the two are too long together, `base` is cut rather than `suffix`.
 * `spare` bytes more are left free, for an ending still to be added.
 */
export function withSuffix(base, suffix, fallback, spare = 0) {
  const room = MAX_UTF8_BYTES - spare - utf8Size(suffix);
  return sanitizeName(trimEnd(truncateUtf8(sanitizeName(base, fallback), room)) + suffix, fallback);
}

/**
 * Names for files made together from one `base`, each followed by its own suffix, such as
 * "Report_1_1-3" and "Report_2_4-6". A long base is cut once, so the names all begin alike.
 */
export function withSuffixes(base, suffixes, fallback) {
  const longest = suffixes.reduce((m, s) => Math.max(m, utf8Size(s)), 0);
  return suffixes.map((s) => withSuffix(base, s, fallback, longest - utf8Size(s)));
}

/**
 * The file name without its extension: "IMG_1234.jpg" gives "IMG_1234", ".hidden" stays.
 * @param {string} fileName
 */
export function baseName(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** `name` ending in ".pdf" (added unless it already ends so, in any case). */
export function withPdfExtension(name) {
  return /\.pdf$/i.test(name) ? name : name + '.pdf';
}

/**
 * `base` if it is not in `taken` (ignoring case), otherwise "base (2)", "base (3)", ...
 * (FileNames.unique; also exported as `unique`).
 * @param {string} base
 * @param {Iterable<string>} taken
 */
export function uniqueName(base, taken) {
  const lower = new Set(Array.from(taken, (n) => n.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  let n = 2;
  while (lower.has(`${base} (${n})`.toLowerCase())) n++;
  return `${base} (${n})`;
}

/**
 * Names for files made together, in order: each made safe (`fallback` for a blank one) and unique
 * among them, ignoring case. Two PDFs both named "Report" become "Report" and "Report (2)".
 * @param {string[]} names
 * @param {string} fallback
 * @returns {string[]}
 */
export function uniqueNames(names, fallback) {
  const taken = new Set();
  return names.map((name) => {
    const unique = uniqueName(sanitizeName(name, fallback), taken);
    taken.add(unique);
    return unique;
  });
}

/** FileNames.unique, by the app's name: the same as uniqueName. */
export const unique = uniqueName;

/** FileNames.sanitize, by the app's name: the same as sanitizeName. */
export const sanitize = sanitizeName;

/**
 * The app's FileNames under its own names, shaped as engine/organize.js's `fileNames` (which
 * works the same): { sanitize, withSuffix, withSuffixes, unique, baseName }, plus uniqueNames.
 */
export const fileNames = Object.freeze({ sanitize: sanitizeName, withSuffix, withSuffixes, unique: uniqueName, baseName, uniqueNames });

/** 'Usugami_20261031_172104': the name the app gives a new PDF (no extension). */
export function defaultPdfName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Usugami_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const isDigit = (c) => c >= '0' && c <= '9';

/**
 * Orders names the way people expect: "IMG_2" before "IMG_10", ignoring case (NaturalOrder).
 * Use as a sort comparator: names.sort(naturalCompare).
 */
export function naturalCompare(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a[i];
    const cb = b[j];
    if (isDigit(ca) && isDigit(cb)) {
      const startA = i;
      const startB = j;
      while (i < a.length && isDigit(a[i])) i++;
      while (j < b.length && isDigit(b[j])) j++;
      const numA = a.slice(startA, i).replace(/^0+/, '');
      const numB = b.slice(startB, j).replace(/^0+/, '');
      if (numA.length !== numB.length) return numA.length - numB.length;
      if (numA !== numB) return numA < numB ? -1 : 1;
    } else {
      const la = ca.toLowerCase();
      const lb = cb.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      i++;
      j++;
    }
  }
  const rest = (a.length - i) - (b.length - j);
  if (rest !== 0) return rest;
  return a === b ? 0 : (a < b ? -1 : 1);
}
