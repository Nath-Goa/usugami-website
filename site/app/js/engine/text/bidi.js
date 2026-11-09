// Right-to-left text, the basics of Unicode's bidirectional algorithm: Hebrew and Arabic letters
// read right to left, numbers and Latin inside them left to right, and the spaces and punctuation
// between take the direction around them. (Embeddings, isolates and mirrored brackets beyond the
// common ones are left out.)

const L = 0, R = 1, EN = 2, AN = 3, NSM = 4, N = 5;

function bidiType(cp) {
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x6f0 && cp <= 0x6f9) || cp === 0xb2 || cp === 0xb3 || cp === 0xb9 || (cp >= 0x2070 && cp <= 0x2079) || (cp >= 0x2080 && cp <= 0x2089) || (cp >= 0xff10 && cp <= 0xff19)) return EN;
  if ((cp >= 0x660 && cp <= 0x669) || (cp >= 0x66b && cp <= 0x66c)) return AN;
  if ((cp >= 0x590 && cp <= 0x8ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefe) || (cp >= 0x10800 && cp <= 0x10fff) || (cp >= 0x1e800 && cp <= 0x1efff) || cp === 0x200f) {
    // Marks inside these blocks follow the letter before them.
    if (MARK.test(String.fromCodePoint(cp))) return NSM;
    return R;
  }
  const ch = String.fromCodePoint(cp);
  if (MARK.test(ch)) return NSM;
  if (LETTER.test(ch) || cp === 0x200e) return L;
  return N;
}
const MARK = /\p{M}/u;
const LETTER = /[\p{L}\p{Nd}\p{Nl}\p{Mc}\p{So}]/u;

/** Whether `text` has any right-to-left letter. */
export function hasRtl(text) {
  return /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE\u200F]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u.test(text);
}

/** The direction of `text`'s first letter: true right to left, false left to right, null when it has none. */
export function firstStrong(text) {
  for (const ch of text) {
    const t = bidiType(ch.codePointAt(0));
    if (t === L) return false;
    if (t === R) return true;
  }
  return null;
}

/**
 * The embedding level of each UTF-16 unit of `text` (even: left to right, odd: right to left),
 * in a paragraph that reads right to left when `rtl`.
 */
export function bidiLevels(text, rtl) {
  const n = text.length;
  const levels = new Uint8Array(n);
  const base = rtl ? 1 : 0;
  if (!rtl && !hasRtl(text)) return levels;
  // Types per code point, then per unit.
  const types = [];
  const starts = [];
  let lastStrong = rtl ? R : L;
  for (let i = 0; i < n;) {
    const cp = text.codePointAt(i);
    let t = bidiType(cp);
    if (t === NSM) t = types.length ? types[types.length - 1] : (rtl ? R : L);
    // A European number after a right-to-left letter reads as an Arabic one (left to right, inside the right-to-left text).
    if (t === EN && lastStrong === R) t = AN;
    if (t === L || t === R) lastStrong = t;
    types.push(t);
    starts.push(i);
    i += cp > 0xffff ? 2 : 1;
  }
  const m = types.length;
  const dir = (t) => (t === L ? L : t === R || t === AN ? R : t === EN ? (rtl ? R : L) : -1);
  const lvl = new Uint8Array(m);
  for (let k = 0; k < m; k++) {
    const t = types[k];
    if (t === L) lvl[k] = base === 0 ? 0 : 2;
    else if (t === R) lvl[k] = 1;
    else if (t === EN || t === AN) lvl[k] = base === 0 ? (t === AN ? 2 : 0) : 2;
  }
  // Neutrals between letters of one direction take it; others the paragraph's.
  for (let k = 0; k < m;) {
    if (types[k] !== N) {
      k++;
      continue;
    }
    let e = k;
    while (e < m && types[e] === N) e++;
    const before = k > 0 ? dir(types[k - 1]) : base === 1 ? R : L;
    const after = e < m ? dir(types[e]) : base === 1 ? R : L;
    const d = before === after ? before : base === 1 ? R : L;
    const level = d === R ? (base === 1 ? 1 : 1) : base === 1 ? 2 : 0;
    for (let j = k; j < e; j++) lvl[j] = level;
    k = e;
  }
  for (let k = 0; k < m; k++) {
    const end = k + 1 < m ? starts[k + 1] : n;
    for (let i = starts[k]; i < end; i++) levels[i] = lvl[k];
  }
  return levels;
}

/** The visual order of items with these levels (rule L2: reverse each run at or above each level). */
export function visualOrder(levels) {
  const order = [...levels.keys()];
  if (!levels.length) return order;
  let max = 0;
  let minOdd = 255;
  for (const l of levels) {
    if (l > max) max = l;
    if (l & 1 && l < minOdd) minOdd = l;
  }
  for (let level = max; level >= minOdd && level > 0; level--) {
    for (let i = 0; i < order.length;) {
      if (levels[order[i]] >= level) {
        let j = i;
        while (j < order.length && levels[order[j]] >= level) j++;
        const part = order.slice(i, j).reverse();
        order.splice(i, j - i, ...part);
        i = j;
      } else i++;
    }
  }
  return order;
}

const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '\u00AB': '\u00BB', '\u00BB': '\u00AB', '\u2039': '\u203A', '\u203A': '\u2039' };

/** `text` with brackets turned round, as they show in right-to-left text. */
export function mirrored(text) {
  return text.replace(/[()[\]{}<>\u00AB\u00BB\u2039\u203A]/g, (c) => MIRROR[c]);
}
