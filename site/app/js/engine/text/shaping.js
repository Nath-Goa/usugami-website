// Shaping: a run of text in one font turned into positioned glyphs with fontkit (Devanagari
// conjuncts and vowel signs, kerning and ligatures, as the font gives them), and each glyph given
// the text it stands for, so copying and searching the PDF give the text back in its own order.
//
// In Hindi the glyphs aren't in the order of the letters: in "नि" the vowel sign ि is drawn before
// न. A PDF maps each glyph code to text, and viewers read the codes in drawing order; so the codes
// here aren't the glyph numbers but numbers handed out per (glyph, text) pair (see pdffont.js), and
// in "नि" the glyph ि is given the text "न" and the glyph न the text "ि": read in drawing order they
// give "नि". Combining marks (\p{Mn}) are never given to a glyph that takes up room, as pdf.js
// counts such glyphs as zero-width: they go to an invisible zero-width glyph after it instead.

const MN = /\p{Mn}/u;
// Joiners, soft hyphens and other format characters show nothing; viewers drop a glyph whose text ends with one.
const DROP = /[\p{Cf}\p{Cc}]/gu;

const cache = new Map();
const MAX_CACHE = 30000;

/**
 * `text` (one run in one font and direction) shaped with `font` (a LoadedFont). Lengths are in
 * ems. Returns {
 *   font, text, rtl, n (glyphs), width,
 *   gid, adv, dx, dy: per glyph in drawing order (left to right),
 *   gtext: the text each glyph stands for (null: none; it is drawn as an outline),
 *   extra: text put on an invisible zero-width glyph right after the glyph (or null),
 *   clusters: [{ start, end, g0, g1 }] in reading order: text offsets and the glyphs [g0, g1) that draw them,
 *   complex: whether glyphs and letters don't simply follow each other (wrapped in ActualText),
 * }. Results are cached.
 */
export function shape(font, text, { rtl = false, features = null, lang = null } = {}) {
  const fkey = features ? JSON.stringify(features) : '';
  const key = `${font.id}\u0001${rtl ? 1 : 0}${fkey}\u0001${lang ?? ''}\u0001${text}`;
  let s = cache.get(key);
  if (s) return s;
  s = shapeNow(font, text, rtl, features, lang);
  if (cache.size >= MAX_CACHE) {
    let drop = MAX_CACHE >> 2;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--drop <= 0) break;
    }
  }
  cache.set(key, s);
  return s;
}

function shapeNow(font, text, rtl, features, lang) {
  const fk = font.fk;
  let glyphs;
  let positions;
  try {
    const run = fk.layout(text, features ?? undefined, undefined, lang ?? undefined, rtl ? 'rtl' : 'ltr');
    glyphs = run.glyphs;
    positions = run.positions;
  } catch {
    // A font table fontkit can't use: one glyph per character, unshaped.
    glyphs = [];
    positions = [];
    for (const ch of text) {
      const g = fk.glyphForCodePoint(ch.codePointAt(0));
      glyphs.push(g);
      positions.push({ xAdvance: g.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 });
    }
    if (rtl) {
      glyphs.reverse();
      positions.reverse();
    }
  }
  // fontkit draws joiners and other invisible characters as zero-width spaces: leave them out.
  const keep = [];
  for (let i = 0; i < glyphs.length; i++) {
    if (positions[i].xAdvance === 0 && glyphs[i].id === font.spaceGid) continue;
    keep.push(i);
  }
  const n = keep.length;
  const upm = font.upm;
  const gid = new Uint16Array(n);
  const adv = new Float32Array(n);
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const cps = new Array(n);
  let width = 0;
  for (let k = 0; k < n; k++) {
    const i = keep[k];
    const g = glyphs[i];
    const p = positions[i];
    gid[k] = g.id;
    adv[k] = p.xAdvance / upm;
    dx[k] = (p.xOffset || 0) / upm;
    dy[k] = (p.yOffset || 0) / upm;
    cps[k] = g.codePoints ?? [];
    width += adv[k];
  }
  const mapped = mapText(text, cps, adv, rtl);
  return { font, text, rtl, n, width, gid, adv, dx, dy, ...mapped };
}

/**
 * Which text each glyph stands for. `cps` are the code points fontkit says each glyph comes from,
 * `adv` their advances; glyphs are in drawing order (reversed for right-to-left).
 */
export function mapText(text, cps, adv, rtl = false) {
  const n = cps.length;
  // The text's code points and where each starts.
  const chars = [];
  const offs = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    chars.push(cp);
    offs.push(i);
    i += cp > 0xffff ? 2 : 1;
  }
  offs.push(text.length);
  const m = chars.length;
  // Work in reading order.
  const order = [...Array(n).keys()];
  if (rtl) order.reverse();
  // Each glyph covers the first unused characters of the text with its code points.
  const used = new Uint8Array(m);
  const lo = new Int32Array(n).fill(0x7fffffff);
  const hi = new Int32Array(n).fill(-1);
  const count = new Int32Array(n);
  let low = 0;
  for (let k = 0; k < n; k++) {
    const g = order[k];
    for (const cp of cps[g]) {
      for (let j = low; j < m; j++) {
        if (!used[j] && chars[j] === cp) {
          used[j] = 1;
          if (j < lo[k]) lo[k] = j;
          if (j > hi[k]) hi[k] = j;
          count[k]++;
          break;
        }
      }
    }
    while (low < m && used[low]) low++;
  }
  // A cluster ends between glyphs k-1 and k when everything before covers only earlier text.
  const suffixMin = new Int32Array(n + 1).fill(0x7fffffff);
  for (let k = n - 1; k >= 0; k--) suffixMin[k] = Math.min(suffixMin[k + 1], lo[k]);
  const clusters = [];
  let start = 0; // first glyph (reading order) of the cluster
  let tStart = 0; // first character
  let max = -1;
  for (let k = 0; k < n; k++) {
    if (hi[k] > max) max = hi[k];
    const end = k === n - 1;
    if (end || (max >= tStart && max < suffixMin[k + 1])) {
      const tEnd = end ? m : max + 1;
      clusters.push({ k0: start, k1: k + 1, t0: tStart, t1: tEnd });
      start = k + 1;
      tStart = tEnd;
    }
  }
  if (!n && m) clusters.push({ k0: 0, k1: 0, t0: 0, t1: m });
  // Characters before the first glyph's (a mark at the very start) join the first cluster.
  const gtext = new Array(n).fill(null);
  const extra = new Array(n).fill(null);
  let complex = false;
  const out = [];
  for (const c of clusters) {
    const units = [];
    for (let j = c.t0; j < c.t1; j++) {
      const s = String.fromCodePoint(chars[j]).replace(DROP, '');
      if (s) units.push(s);
    }
    const k = c.k1 - c.k0;
    if (k > 1 || units.length > 1) complex = true;
    const glyphIdx = [];
    for (let q = c.k0; q < c.k1; q++) glyphIdx.push(order[q]);
    // Text pieces in drawing order: for right-to-left, the glyphs' drawing order is reversed.
    const drawOrder = rtl ? glyphIdx.slice().reverse() : glyphIdx;
    const pieces = k === 1 ? [units.join('')] : distribute(units, drawOrder.map((g) => adv[g] > 0), drawOrder.map((g) => count[order.indexOf(g)]));
    drawOrder.forEach((g, q) => {
      let piece = pieces[q] ?? '';
      if (!piece) {
        gtext[g] = null;
        complex = true;
        return;
      }
      if (adv[g] > 0) {
        // A mark goes on an invisible glyph after it, so the glyph keeps its width in viewers.
        const at = firstMark(piece);
        if (at > 0) {
          extra[g] = piece.slice(at);
          piece = piece.slice(0, at);
          complex = true;
        }
      }
      gtext[g] = piece;
    });
    const g0 = Math.min(...glyphIdx);
    const g1 = Math.max(...glyphIdx) + 1;
    out.push({ start: offs[c.t0], end: offs[c.t1], g0: k ? g0 : 0, g1: k ? g1 : 0 });
  }
  return { gtext, extra, clusters: out, complex };
}

function firstMark(s) {
  let i = 0;
  for (const ch of s) {
    if (MN.test(ch)) return i;
    i += ch.length;
  }
  return -1;
}

/**
 * Cuts `units` (the cluster's characters, in reading order) into one piece per glyph (in drawing
 * order), so that read one after another they give the text: a glyph with width gets a piece that
 * doesn't start with a mark, a zero-width one a piece with a mark, and each about as many
 * characters as it draws (`own`).
 */
function distribute(units, spacing, own) {
  const k = spacing.length;
  const n = units.length;
  // Text with no glyph at all (a lone soft hyphen or joiner) has nothing to give it to.
  if (k === 0) return [];
  const isMark = units.map((u) => MN.test(u));
  if (k > 6 || n > 14) {
    // Too many to try every way: one character for each glyph, the rest on the last.
    return spacing.map((_, i) => (i < k - 1 ? units[i] ?? '' : units.slice(k - 1).join('')));
  }
  let best = null;
  let bestScore = Infinity;
  const cuts = new Array(k + 1);
  cuts[0] = 0;
  cuts[k] = n;
  const score = () => {
    let s = 0;
    for (let i = 0; i < k; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (spacing[i]) {
        if (a === b) s += 10;
        else if (isMark[a]) s += 6;
      } else if (a === b) {
        s += 4;
      } else {
        let mark = false;
        for (let j = a; j < b; j++) if (isMark[j]) mark = true;
        if (!mark) s += 2;
      }
      s += Math.abs(b - a - own[i]) * 0.5;
    }
    return s;
  };
  const walk = (i) => {
    if (i === k) {
      const s = score();
      if (s < bestScore) {
        bestScore = s;
        best = cuts.slice();
      }
      return;
    }
    for (let c = cuts[i - 1]; c <= n; c++) {
      cuts[i] = c;
      walk(i + 1);
    }
  };
  if (k === 1) best = [0, n];
  else walk(1);
  const pieces = [];
  for (let i = 0; i < k; i++) pieces.push(units.slice(best[i], best[i + 1]).join(''));
  return pieces;
}
