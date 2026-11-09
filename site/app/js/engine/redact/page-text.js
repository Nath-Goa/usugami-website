// A page's text for Find text (the app's core PageText): each character knows the glyph it came
// from. Letters are compared ignoring case and accents (é finds e), and every gap between words or
// lines is a single space, so a phrase is found across a line break. Letter-spaced text, such as a
// name in a heading set in S P A C E D capitals, is read with a gap between each two letters, and a
// word that breaks after a hyphen at the end of a line with a line break after the hyphen: a match
// may cross those (see Builder.gap and Builder.lineBreak).

const SPACE = 0;
const GAP = 1;
const HYPHEN_BREAK = 2;
const SOFT_HYPHEN = '\u{AD}';

/** ‘ ’ ‚ ‛, the modifier letters apostrophe, prime and turned comma, the prime and the grave accent. */
const APOSTROPHES = '‘’‚‛ʼʹʻ′`';
/** Letters with a stroke, which don't split into a letter and an accent, and their plain letters. */
const STROKED = 'łŁøØđĐħĦŧŦ';
const UNSTROKED = 'lLoOdDhHtT';

// Java's Character.isWhitespace: separators but the no-break ones, and some ASCII controls.
const WHITESPACE = /[\t\n\u000B\f\r\u001C-\u001F]|(?![\u{A0}\u{2007}\u{202F}])[\p{Zs}\p{Zl}\p{Zp}]/u;
const FORMAT_OR_CONTROL = /[\p{Cf}\u0000-\u001F\u007F-\u009F]/u;

/**
 * `text` as Find text compares it: compatibility forms split up (the ligature ﬁ becomes f and i),
 * Latin, Greek and Cyrillic accents dropped, invisible format characters dropped, every kind of
 * space a plain one, typographic apostrophes, quotes, hyphens and dashes the plain ones a phone's
 * keyboard types, letters with a stroke the plain letter (Walesa finds Wałęsa), and ß, œ and æ the
 * two letters they are often typed as (Strasse finds Straße).
 */
export function fold(text) {
  // An acute accent on its own would split into a space and the accent that goes on a letter.
  const split = text.replaceAll('´', "'").normalize('NFKD');
  let out = '';
  // Code unit by code unit, as the app does, so each still knows its glyph.
  for (let i = 0; i < split.length; i++) {
    const c = split[i];
    const code = c.charCodeAt(0);
    if (code >= 0x300 && code <= 0x36F) continue;
    if (WHITESPACE.test(c)) { out += ' '; continue; }
    if (FORMAT_OR_CONTROL.test(c)) continue;
    if (APOSTROPHES.includes(c)) { out += "'"; continue; }
    const stroked = STROKED.indexOf(c);
    if (stroked >= 0) { out += UNSTROKED[stroked]; continue; }
    if (code >= 0x201C && code <= 0x201F) { out += '"'; continue; }
    if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) { out += '-'; continue; }
    if (c === 'ß' || c === 'ẞ') { out += 'ss'; continue; }
    if (c === 'œ' || c === 'Œ') { out += 'oe'; continue; }
    if (c === 'æ' || c === 'Æ') { out += 'ae'; continue; }
    out += c;
  }
  return out;
}

/** `query` folded like page text, with its spaces trimmed and each run of them made one. */
export function normalize(query) {
  return fold(query).replace(/^ +| +$/g, '').replace(/ +/g, ' ');
}

/** Kotlin's Char.equals(other, ignoreCase = true): the same letter in either case. */
export function sameChar(a, b) {
  if (a === b) return true;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  if (ua.length === 1 && ub.length === 1 && ua === ub) return true;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la.length === 1 && lb.length === 1 && la === lb;
}

/** Whether `text` contains `part`, ignoring case letter by letter (Kotlin's contains(ignoreCase = true)). */
export function containsIgnoringCase(text, part) {
  if (!part.length) return true;
  outer: for (let i = 0; i + part.length <= text.length; i++) {
    for (let j = 0; j < part.length; j++) if (!sameChar(text[i + j], part[j])) continue outer;
    return true;
  }
  return false;
}

/** Builds a page's text, glyph by glyph, as text extraction reads it. */
export class PageTextBuilder {
  constructor() {
    this.chars = [];
    this.owners = [];
    /** For each space, whether it is a GAP or a HYPHEN_BREAK. */
    this.kinds = [];
    /** Whether the last glyph read as nothing but a soft hyphen, the hyphen of a word broken at a line's end. */
    this.softHyphen = false;
  }

  #append(c, owner, kind = SPACE) {
    this.chars.push(c);
    this.owners.push(owner);
    this.kinds.push(kind);
    this.softHyphen = false;
  }

  get #last() { return this.chars[this.chars.length - 1]; }

  /** Adds glyph `index`, which reads as `unicode`. */
  glyph(index, unicode) {
    const folded = fold(unicode);
    for (const c of folded.split('')) {
      if (c === ' ') this.space();
      else this.#append(c, index);
    }
    if (!folded.length && unicode.includes(SOFT_HYPHEN)) this.softHyphen = true;
  }

  /** A break between words. */
  space() {
    if (!this.chars.length) return;
    if (this.#last === ' ') this.kinds[this.kinds.length - 1] = SPACE;
    else this.#append(' ', -1);
  }

  /**
   * A gap between two glyphs where the PDF has no space: a break between words, or the spacing
   * between the letters of letter-spaced text. Between two lone letters it may be either, so a
   * match may cross it; elsewhere it is a space.
   */
  gap() {
    if (this.chars.length && this.#last !== ' ') this.#append(' ', -1, GAP);
  }

  /**
   * A break between lines. After a hyphen it may break a word, so a match may cross it, and the
   * hyphen too; otherwise it is a space.
   */
  lineBreak() {
    if (!this.chars.length) return;
    const last = this.chars.length - 1;
    if (this.chars[last] === ' ') {
      // Several breaks in a row (a line's and a paragraph's) are one.
      if (this.kinds[last] === GAP) this.kinds[last] = SPACE;
    } else if (this.softHyphen || this.chars[last] === '-') {
      this.#append(' ', -1, HYPHEN_BREAK);
    } else {
      this.#append(' ', -1);
    }
  }

  /** The text read so far, with what a match may cross where it has none of its letters. */
  build() {
    const { chars, owners, kinds } = this;
    const length = chars.length;
    // A word that is a single glyph (one that reads as several letters too) between two spaces.
    const lone = (from, step) => {
      let k = from;
      while (k >= 0 && k < length && chars[k] !== ' ') {
        if (owners[k] !== owners[from]) return false;
        k += step;
      }
      return k !== from;
    };
    const inWord = new Uint8Array(length);
    for (let k = 0; k < length; k++) {
      if (kinds[k] === GAP && chars[k] === ' ') inWord[k] = lone(k - 1, -1) && lone(k + 1, 1) ? 1 : 0;
      else if (kinds[k] === HYPHEN_BREAK && chars[k] === ' ') inWord[k] = 1;
      else inWord[k] = chars[k] === '-' && k + 1 < length && kinds[k + 1] === HYPHEN_BREAK && chars[k + 1] === ' ' ? 1 : 0;
    }
    return new PageText(chars.join(''), Int32Array.from(owners), inWord);
  }
}

export class PageText {
  constructor(text, owners, inWord) {
    this.text = text;
    this.owners = owners;
    this.inWord = inWord;
  }

  /** For each place `query` is found, in order, the glyphs it covers, in reading order. */
  find(query) {
    const wanted = normalize(query);
    if (!wanted.length) return [];
    const { text, owners } = this;
    const found = [];
    let i = 0;
    while (i < text.length) {
      let end = this.#matchAt(i, wanted);
      if (end < 0) {
        i++;
        continue;
      }
      // A match that crosses a gap or a hyphen break can take the first letters of another right
      // after it, which then wouldn't be found ("Bo-" and "Bob"): one that starts before it ends
      // is part of it.
      let crossed = end - i > wanted.length;
      let start = i + 1;
      while (crossed && start < end) {
        const next = this.#matchAt(start, wanted);
        if (next > end) {
          end = next;
          crossed = next - start > wanted.length;
        }
        start++;
      }
      const glyphs = [];
      const seen = new Set();
      for (let k = i; k < end; k++) {
        if (owners[k] >= 0 && !seen.has(owners[k])) {
          seen.add(owners[k]);
          glyphs.push(owners[k]);
        }
      }
      if (glyphs.length) found.push(glyphs);
      i = end;
    }
    return found;
  }

  /**
   * Where a match of `wanted` that starts at `start` ends, exclusive, or -1 if there is none. A gap
   * between two lone letters, and a line break after a hyphen and that hyphen, may come between
   * two of its letters where it has none of them.
   */
  #matchAt(start, wanted) {
    const { text, inWord } = this;
    let k = start;
    for (let j = 0; j < wanted.length; j++) {
      const c = wanted[j];
      if (j > 0) while (k < text.length && inWord[k] && !sameChar(text[k], c)) k++;
      if (k === text.length || !sameChar(text[k], c)) return -1;
      k++;
    }
    return k;
  }
}
