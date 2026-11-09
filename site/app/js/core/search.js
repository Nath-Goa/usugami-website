// Finding tools by what is typed into Home's search field (ToolSearch.kt). Each word typed must
// begin a word of the tool's name, its description or its hidden keywords, in any order, so
// "red siz" finds "reduce size". Case and accents don't matter ("resume" finds "résumé"), and
// neither does the Devanagari nukta or candrabindu, which people often leave out or swap for an
// anusvara ("जोडें" finds "जोड़ें").

const NUKTA = 0x093c;
const CANDRABINDU = 0x0901;
const ANUSVARA = 'ं';

const FORMAT = /^\p{Cf}$/u;
const WORD_CHAR = /^[\p{L}\p{Nd}\p{M}]$/u;

/**
 * The words of `text`, folded for comparing: in lower case, without accents, split at anything
 * that isn't a letter, digit or vowel sign (spaces, commas, hyphens, apostrophes, dots).
 * @param {string} text
 * @returns {string[]}
 */
export function words(text) {
  // Lower case first: a few capitals (such as the Turkish dotted İ) only lose their accent once
  // lowered. NFKD then splits é into e and its accent, and ligatures and full-width forms into
  // plain letters.
  const decomposed = String(text ?? '').toLowerCase().normalize('NFKD');
  let folded = '';
  for (const ch of decomposed) {
    const c = ch.codePointAt(0);
    // Accents of Latin letters, the nukta and zero-width joiners are dropped. Other scripts'
    // marks, like Devanagari vowel signs, are part of their word.
    if ((c >= 0x0300 && c <= 0x036f) || c === NUKTA || FORMAT.test(ch)) continue;
    if (c === CANDRABINDU) folded += ANUSVARA;
    else if (WORD_CHAR.test(ch)) folded += ch;
    else folded += ' ';
  }
  return folded.split(' ').filter((w) => w.length > 0);
}

/** Whether each of `wanted` begins one of `list`. */
function covers(list, wanted) {
  return wanted.every((want) => list.some((w) => w.startsWith(want)));
}

/**
 * Whether every word of `query` begins a word of `text`. A query without words matches nothing.
 * @param {string} query
 * @param {string} text
 */
export function matches(query, text) {
  const wanted = words(query);
  return wanted.length > 0 && covers(words(text), wanted);
}

/**
 * The `items` that `query` finds, in their order, except that those found by their name alone
 * come before those found through `moreText` (their description and keywords). A query without
 * words, such as only spaces or punctuation, finds none.
 * @template T
 * @param {T[]} items
 * @param {string} query
 * @param {(item: T) => string} name
 * @param {(item: T) => string} moreText
 * @returns {T[]}
 */
export function search(items, query, name, moreText) {
  const wanted = words(query);
  if (!wanted.length) return [];
  const byName = [];
  const byMore = [];
  for (const item of items) {
    const nameWords = words(name(item));
    if (covers(nameWords, wanted)) byName.push(item);
    else if (covers(nameWords.concat(words(moreText(item))), wanted)) byMore.push(item);
  }
  return byName.concat(byMore);
}
