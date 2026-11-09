// The redacted PDF's name, as the app makes it (FileNames.sanitize and withSuffix): "Report.pdf"
// becomes "Report_redacted.pdf"; a long name is cut, not its "_redacted".

const MAX_UTF8_BYTES = 200;
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001F\u007F]/g;
const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?= *(\.|$))/i;
const encoder = new TextEncoder();
const utf8Size = (text) => encoder.encode(text).length;
const isSpace = (c) => /\s/u.test(c);

function trimEnd(text) {
  let end = text.length;
  while (end > 0 && (isSpace(text[end - 1]) || text[end - 1] === '.')) end--;
  return text.slice(0, end);
}

function trimStart(text) {
  let start = 0;
  while (start < text.length && (isSpace(text[start]) || text[start] === '.')) start++;
  return text.slice(start);
}

/** `text` cut to at most maxBytes bytes of UTF-8 between whole characters as people see them. */
function truncateUtf8(text, maxBytes) {
  if (utf8Size(text) <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
    : [...text];
  for (const g of graphemes) {
    const size = utf8Size(g);
    if (bytes + size > maxBytes) break;
    out += g;
    bytes += size;
  }
  if (out) return out;
  // The first character alone is too long: whole code points of it, then.
  for (const cp of text) {
    const size = utf8Size(cp);
    if (bytes + size > maxBytes) break;
    out += cp;
    bytes += size;
  }
  return out;
}

/** User input made a safe PDF base name, without ".pdf" (FileNames.sanitize). */
export function sanitize(input, fallback) {
  let name = trimEnd(String(input ?? '').trim().replace(ILLEGAL, '_'));
  if (name.toLowerCase().endsWith('.pdf')) name = name.slice(0, -4);
  name = trimStart(trimEnd(name));
  name = trimEnd(truncateUtf8(name, MAX_UTF8_BYTES));
  name = name.replace(WINDOWS_DEVICE, '$1_');
  return name || fallback;
}

/** `base` made safe and followed by `suffix`, cutting `base` rather than `suffix` when too long. */
export function withSuffix(base, suffix, fallback) {
  const room = MAX_UTF8_BYTES - utf8Size(suffix);
  return sanitize(trimEnd(truncateUtf8(sanitize(base, fallback), room)) + suffix, fallback);
}

/** A file's name without its extension: "IMG_1234.jpg" → "IMG_1234". */
export function baseName(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** The name Redact PDF suggests for `fileName`'s result, without ".pdf": "Report_redacted". */
export function redactedName(fileName) {
  return withSuffix(baseName(fileName || 'Usugami'), '_redacted', 'Usugami');
}
