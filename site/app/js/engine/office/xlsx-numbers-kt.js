// Text and number rules of the Android app's Kotlin (on the JVM), which the spreadsheet code was
// written against: what counts as a digit, a letter or white space, and which strings read as
// numbers. JavaScript's own rules differ in small ways (trim(), parseInt(), Number()), and matching
// them keeps a workbook's cells looking the same in the app and on the web.

const ND = /\p{Nd}/u;
const LETTER = /\p{L}/u;
const SPACE = /[\t\n\v\f\r\x1c-\x1f\p{Zs}\u2028\u2029]/u;

/** Whether the one UTF-16 unit `c` is a decimal digit in any script (Kotlin's Char.isDigit). */
export function isDigit(c) {
  return c !== undefined && c.length === 1 && ND.test(c);
}

/** Whether `c` is a letter in any script (Kotlin's Char.isLetter). */
export function isLetter(c) {
  return c !== undefined && c.length === 1 && LETTER.test(c);
}

export function isLetterOrDigit(c) {
  return isLetter(c) || isDigit(c);
}

/** Kotlin's Char.isWhitespace: Java's white space and space characters, no-break spaces included. */
export function isWhitespace(c) {
  return c !== undefined && c.length === 1 && SPACE.test(c);
}

/** Kotlin's String.trim(): white space as isWhitespace counts it, from both ends. */
export function trim(s) {
  let start = 0;
  let end = s.length;
  while (start < end && isWhitespace(s[start])) start++;
  while (end > start && isWhitespace(s[end - 1])) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/** Kotlin's String.isBlank(): empty, or white space only. */
export function isBlank(s) {
  for (let i = 0; i < s.length; i++) if (!isWhitespace(s[i])) return false;
  return true;
}

/** Kotlin's Char.lowercaseChar(): one character for one, unchanged when its small letter is longer. */
export function lowercaseChar(c) {
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
}

/**
 * The value of the one UTF-16 unit `c` as a digit in `radix`, or -1, as Java's Character.digit:
 * decimal digits of any script, Latin letters and their full-width forms from 10 up.
 */
export function digitOf(c, radix) {
  if (c === undefined || c.length !== 1) return -1;
  const code = c.charCodeAt(0);
  let value = -1;
  if (code >= 0x30 && code <= 0x39) value = code - 0x30;
  else if (code >= 0x41 && code <= 0x5a) value = code - 0x41 + 10;
  else if (code >= 0x61 && code <= 0x7a) value = code - 0x61 + 10;
  else if (code >= 0xff21 && code <= 0xff3a) value = code - 0xff21 + 10;
  else if (code >= 0xff41 && code <= 0xff5a) value = code - 0xff41 + 10;
  else if (ND.test(c)) {
    // Unicode keeps each script's digits together, 0 to 9 in order.
    let k = 0;
    while (k < 10 && code - k - 1 >= 0 && ND.test(String.fromCharCode(code - k - 1))) k++;
    value = k % 10;
  }
  return value < radix ? value : -1;
}

const INT_MAX = 2147483647;

/**
 * Kotlin's String.toIntOrNull(radix): an optional + or -, then digits as digitOf reads them; null
 * when anything else is there or the number doesn't fit in 32 bits.
 */
export function toIntOrNull(s, radix = 10) {
  if (typeof s !== 'string' || s.length === 0) return null;
  let start = 0;
  let negative = false;
  if (s[0] < '0') {
    if (s.length === 1) return null;
    if (s[0] === '-') negative = true;
    else if (s[0] !== '+') return null;
    start = 1;
  }
  let n = 0;
  for (let i = start; i < s.length; i++) {
    const d = digitOf(s[i], radix);
    if (d < 0) return null;
    n = n * radix + d;
    if (n > INT_MAX + (negative ? 1 : 0)) return null;
  }
  return negative ? -n || 0 : n;
}

// Java's grammar for a double, as Kotlin screens it before Double.parseDouble.
const DIGITS = '[0-9]+';
const EXP = `[eE][+-]?${DIGITS}`;
// The digits after the point come only with the point: were they optional on their own, a long run
// of digits could be split between the two parts in as many ways as it has digits, and a value that
// isn't a number after all (a hundred thousand digits and a letter) would take minutes to refuse.
const DECIMAL = `(?:${DIGITS}(?:\\.[0-9]*)?(?:${EXP})?|\\.${DIGITS}(?:${EXP})?)`;
const HEX = '0[xX](?:([0-9a-fA-F]+)\\.?|([0-9a-fA-F]*)\\.([0-9a-fA-F]+))[pP]([+-]?[0-9]+)';
const DOUBLE = new RegExp(`^[\\x00-\\x20]*([+-]?)(?:(NaN)|(Infinity)|(${DECIMAL})[fFdD]?|(?:${HEX})[fFdD]?)[\\x00-\\x20]*$`);

/**
 * Kotlin's String.toDoubleOrNull() on the JVM: white space or control characters around, a sign,
 * NaN, Infinity, decimals with an exponent, hexadecimal floats (0x1.8p1), and a d or f at the end.
 */
export function toDoubleOrNull(s) {
  if (typeof s !== 'string') return null;
  const m = DOUBLE.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  if (m[2]) return NaN;
  if (m[3]) return sign * Infinity;
  if (m[4] !== undefined) return sign * Number(m[4]);
  // A hexadecimal float: its digits, as a whole number, times a power of two.
  const whole = m[5] ?? m[6] ?? '';
  const fraction = m[7] ?? '';
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return sign * 0;
  // 56 bits of mantissa are more than a double keeps; the digits after them only move the exponent.
  const kept = digits.slice(0, 14);
  const exponent = Number(m[8]) - 4 * fraction.length + 4 * (digits.length - kept.length);
  const e = Math.max(-2200, Math.min(2200, exponent));
  // Scaled in two steps, so neither power of two overflows on its own.
  return sign * parseInt(kept, 16) * 2 ** Math.trunc(e / 2) * 2 ** (e - Math.trunc(e / 2));
}

/** Kotlin's Double.toInt(): towards zero, NaN as 0, and held to 32 bits. */
export function toInt(x) {
  if (Number.isNaN(x)) return 0;
  if (x >= INT_MAX) return INT_MAX;
  if (x <= -INT_MAX - 1) return -INT_MAX - 1;
  return Math.trunc(x) || 0;
}

/** Kotlin's Double.roundToInt(): half up, held to 32 bits; NaN as 0, where Kotlin would stop. */
export function roundToInt(x) {
  if (Number.isNaN(x)) return 0;
  if (x >= INT_MAX) return INT_MAX;
  if (x <= -INT_MAX - 1) return -INT_MAX - 1;
  return Math.round(x) || 0;
}

/** Kotlin's coerceIn for numbers: NaN stays NaN, as there. */
export function coerceIn(x, min, max) {
  return x < min ? min : x > max ? max : x;
}

/** A whole number of characters from an argument that may be anything: `fallback` when it isn't a number. */
export function intArg(x, fallback) {
  if (typeof x !== 'number' || Number.isNaN(x)) return fallback;
  return toInt(x);
}
