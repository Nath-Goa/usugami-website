// Reading order of a line of glyphs given left to right as drawn. PDF makers draw Hebrew and
// Arabic from left to right too (a word's last letter first), so, as the app does with Java's
// Bidi, the drawn text is put through the Unicode bidirectional algorithm, which turns text in the
// order it is drawn back into the order it is read. This is the algorithm without explicit
// embeddings (PDF text rarely has them), which is all a line of drawn glyphs needs.

const R = /[\u{590}-\u{5FF}\u{7C0}-\u{85F}\u{FB1D}-\u{FB4F}\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const AL = /[\u{600}-\u{65F}\u{66D}-\u{6EF}\u{6FA}-\u{7BF}\u{860}-\u{8FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}]/u;
const AN = /[\u{660}-\u{669}\u{66B}\u{66C}]/u;
const EN = /[0-9\u{B2}\u{B3}\u{B9}\u{6F0}-\u{6F9}\u{2070}-\u{2079}\u{2080}-\u{2089}\u{FF10}-\u{FF19}]/u;
const ES = /[+\-\u{207A}\u{207B}\u{208A}\u{208B}\u{2212}\u{FB29}\u{FE62}\u{FE63}\u{FF0B}\u{FF0D}]/u;
const ET = /[#$%\u{A2}-\u{A5}\u{B0}\u{B1}\u{66A}\u{2030}-\u{2034}\u{20A0}-\u{20CF}\u{2212}\u{212E}\u{FF03}-\u{FF05}]/u;
const CS = /[,./:\u{A0}\u{60C}\u{202F}\u{2044}\u{FE50}\u{FE52}\u{FE55}\u{FF0C}\u{FF0E}\u{FF0F}\u{FF1A}]/u;
const NSM = /[\p{Mn}\p{Me}]/u;
const WS = /[\s\p{Zs}]/u;
const LETTER = /[\p{L}\p{Mc}]/u;

/** The bidirectional class of a character, simplified. */
function bidiClass(ch) {
  if (R.test(ch)) return 'R';
  if (AL.test(ch)) return 'AL';
  if (AN.test(ch)) return 'AN';
  if (EN.test(ch)) return 'EN';
  if (ES.test(ch)) return 'ES';
  if (ET.test(ch)) return 'ET';
  if (CS.test(ch)) return 'CS';
  if (NSM.test(ch)) return 'NSM';
  if (WS.test(ch)) return 'WS';
  if (LETTER.test(ch)) return 'L';
  return 'ON';
}

/** Whether `text` has any right-to-left letters or Arabic digits (Java's Bidi.requiresBidi). */
export function requiresBidi(text) {
  for (const ch of text) {
    const c = bidiClass(ch);
    if (c === 'R' || c === 'AL' || c === 'AN') return true;
  }
  return false;
}

/**
 * The embedding level of each code unit of `text`, a single paragraph whose direction comes from
 * its first strong letter (left to right if it has none).
 */
export function levels(text) {
  const classes = [];
  for (const ch of text) {
    const c = bidiClass(ch);
    // One class for each code unit, as positions in the text count them.
    for (let k = 0; k < ch.length; k++) classes.push(c);
  }
  const n = classes.length;
  let base = 0;
  for (const c of classes) {
    if (c === 'L') break;
    if (c === 'R' || c === 'AL') {
      base = 1;
      break;
    }
  }
  const sor = base ? 'R' : 'L';
  const t = classes.slice();
  // W1: a mark takes the class of what it marks.
  for (let i = 0; i < n; i++) if (t[i] === 'NSM') t[i] = i > 0 ? t[i - 1] : sor;
  // W2: European digits after Arabic letters are Arabic digits.
  let lastStrong = sor;
  for (let i = 0; i < n; i++) {
    if (t[i] === 'L' || t[i] === 'R' || t[i] === 'AL') lastStrong = t[i];
    else if (t[i] === 'EN' && lastStrong === 'AL') t[i] = 'AN';
  }
  // W3
  for (let i = 0; i < n; i++) if (t[i] === 'AL') t[i] = 'R';
  // W4: a single separator between two numbers of one kind joins them.
  for (let i = 1; i < n - 1; i++) {
    if (t[i] === 'ES' && t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN';
    else if (t[i] === 'CS' && t[i - 1] === t[i + 1] && (t[i - 1] === 'EN' || t[i - 1] === 'AN')) t[i] = t[i - 1];
  }
  // W5: terminators next to European digits are part of them.
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'ET') continue;
    let j = i;
    while (j < n && t[j] === 'ET') j++;
    if ((i > 0 && t[i - 1] === 'EN') || (j < n && t[j] === 'EN')) for (let k = i; k < j; k++) t[k] = 'EN';
    i = j - 1;
  }
  // W6: other separators and terminators are neutral.
  for (let i = 0; i < n; i++) if (t[i] === 'ES' || t[i] === 'ET' || t[i] === 'CS') t[i] = 'ON';
  // W7: European digits after left-to-right letters are left to right.
  lastStrong = sor;
  for (let i = 0; i < n; i++) {
    if (t[i] === 'L' || t[i] === 'R') lastStrong = t[i];
    else if (t[i] === 'EN' && lastStrong === 'L') t[i] = 'L';
  }
  // N1, N2: neutrals between two of one direction take it, others the paragraph's.
  const strong = (c) => (c === 'L' ? 'L' : (c === 'R' || c === 'EN' || c === 'AN') ? 'R' : null);
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'ON' && t[i] !== 'WS') continue;
    let j = i;
    while (j < n && (t[j] === 'ON' || t[j] === 'WS')) j++;
    const before = i > 0 ? strong(t[i - 1]) : sor;
    const after = j < n ? strong(t[j]) : sor;
    const dir = before === after ? before : sor;
    for (let k = i; k < j; k++) t[k] = dir;
    i = j - 1;
  }
  // I1, I2
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = t[i];
    if (base === 0) out[i] = c === 'R' ? 1 : (c === 'AN' || c === 'EN') ? 2 : 0;
    else out[i] = c === 'L' || c === 'EN' || c === 'AN' ? 2 : 1;
  }
  return out;
}

/** The visual-to-logical order (and back) for items with `levels` (Java's Bidi.reorderVisually). */
export function reorderVisually(itemLevels) {
  const order = itemLevels.map((_, i) => i);
  if (!itemLevels.length) return order;
  const highest = Math.max(...itemLevels);
  let lowestOdd = Infinity;
  for (const l of itemLevels) if (l % 2 === 1 && l < lowestOdd) lowestOdd = l;
  for (let level = highest; level >= lowestOdd && level > 0; level--) {
    let i = 0;
    while (i < order.length) {
      if (itemLevels[order[i]] >= level) {
        let j = i;
        while (j < order.length && itemLevels[order[j]] >= level) j++;
        const run = order.slice(i, j).reverse();
        order.splice(i, j - i, ...run);
        i = j;
      } else {
        i++;
      }
    }
  }
  return order;
}

const MIRRORS = new Map();
for (const [a, b] of ['()', '[]', '{}', '<>', '\u{AB}\u{BB}', '\u{2039}\u{203A}', '\u{2045}\u{2046}', '\u{207D}\u{207E}', '\u{208D}\u{208E}', '\u{3008}\u{3009}', '\u{300A}\u{300B}', '\u{300C}\u{300D}', '\u{300E}\u{300F}', '\u{3010}\u{3011}', '\u{3014}\u{3015}', '\u{3016}\u{3017}', '\u{3018}\u{3019}', '\u{301A}\u{301B}', '\u{FD3E}\u{FD3F}', '\u{FF08}\u{FF09}', '\u{FF3B}\u{FF3D}', '\u{FF5B}\u{FF5D}', '\u{FF1C}\u{FF1E}']) {
  MIRRORS.set(a, b);
  MIRRORS.set(b, a);
}

/** `text` with each character that has a mirror image (a bracket, say) turned into it. */
export function mirror(text) {
  let out = '';
  for (const ch of text) out += MIRRORS.get(ch) ?? ch;
  return out;
}

/** What the bidirectional algorithm takes for the end of a paragraph. */
const PARAGRAPH_BREAKS = new RegExp('[\\n\\r\\u001C-\\u001E\\u0085\\u2029]', 'g');

/** U+FFFC, which stands for an object in text. */
const OBJECT_CHARACTER = '\u{FFFC}';

/**
 * `line`'s glyphs (objects with `unicode`, or null between two words), given left to right as
 * drawn, in the order they are read, each as [glyph, mirrored]: whether it is in right-to-left
 * text and so drawn as the mirror image of what it says, as a bracket is. A line with no
 * right-to-left letters stays as it is. A glyph moves as a whole, so one that reads as several
 * letters (a ligature) keeps them in order.
 */
export function readingOrder(line) {
  let drawn = '';
  const starts = [];
  for (const glyph of line) {
    starts.push(drawn.length);
    // A word break is a space, and a glyph that reads as nothing an object (a neutral).
    drawn += glyph === null ? ' ' : (glyph.unicode || OBJECT_CHARACTER);
  }
  // All one paragraph.
  drawn = drawn.replace(PARAGRAPH_BREAKS, ' ');
  if (!requiresBidi(drawn)) return line.map((g) => [g, false]);
  const all = levels(drawn);
  const itemLevels = line.map((_, i) => all[starts[i]]);
  return reorderVisually(itemLevels).map((i) => [line[i], (itemLevels[i] & 1) === 1]);
}
