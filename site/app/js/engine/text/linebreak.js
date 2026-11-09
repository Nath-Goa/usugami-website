// Where lines may break, after the rules of Unicode's line breaking (UAX #14) that matter for the
// app's languages, as Android's ICU applies them: after spaces, after hyphens and dashes, between
// Chinese and Japanese characters (but not before closing punctuation or small kana), never inside
// a character with its marks; and in Thai and other languages written without spaces, between the
// words Intl.Segmenter finds.
import { graphemes } from './fonts.js';

// Line break classes, of a code point.
const BK = 1, CR = 2, LF = 3, SP = 4, ZW = 5, GL = 6, BA = 7, HY = 8, B2 = 9, CL = 10, CP = 11, OP = 12;
const QU = 13, EX = 14, IS = 15, SY = 16, NS = 17, PR = 18, PO = 19, NU = 20, ID = 21, SA = 22, CM = 23, AL = 24;

const SINGLE = new Map();
const set = (cls, chars) => { for (const ch of chars) SINGLE.set(ch.codePointAt(0), cls); };
set(BK, '\u000B\u000C\u2028\u2029\u0085');
set(CR, '\r');
set(LF, '\n');
set(SP, ' ');
set(ZW, '\u200B');
set(GL, '\u00A0\u202F\u2007\u2011\u0F08\u0F0C\u0F12\u180E\uFEFF\u2060\u034F');
set(BA, '\t\u00AD\u058A\u0964\u0965\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2008\u2009\u200A\u2010\u2012\u2013\u2027\u205F\u3000\u2E0E\u2E0F\u2E10\u2E11\u2E12\u2E13\u2E14\u2E15\u2E17\u2E19\u2E2A\u2E2B\u2E2C\u2E2D\u2E30\u2E31\u2E33\u2E34\u2E3C\u2E3D\u2E3E\u2E40\u2E41\u2E43\u2E44\u2E45\u2E46\u2E47\u2E48\u2E49\u2E4A\u2E4C\u2E4E\u2E4F\u2E5D');
set(HY, '-');
set(B2, '\u2014\u2E3A\u2E3B');
set(CL, '}\u0F3B\u0F3D\u169C\u2046\u207E\u208E\u2309\u230B\u232A\u2769\u276B\u276D\u276F\u2771\u2773\u2775\u27C6\u27E7\u27E9\u27EB\u27ED\u27EF\u2984\u2986\u2988\u298A\u298C\u298E\u2990\u2992\u2994\u2996\u2998\u29D9\u29DB\u29FD\u2E23\u2E25\u2E27\u2E29\u3001\u3002\u3009\u300B\u300D\u300F\u3011\u3015\u3017\u3019\u301B\u301E\u301F\uFD3E\uFE11\uFE12\uFE18\uFE36\uFE38\uFE3A\uFE3C\uFE3E\uFE40\uFE42\uFE44\uFE48\uFE50\uFE52\uFE5A\uFE5C\uFE5E\uFF0C\uFF0E\uFF5D\uFF60\uFF61\uFF63\uFF64');
set(CP, ')]\uFF09\uFF3D');
set(OP, '([{\u00A1\u00BF\u0F3A\u0F3C\u169B\u201A\u201E\u2045\u207D\u208D\u2308\u230A\u2329\u2768\u276A\u276C\u276E\u2770\u2772\u2774\u27C5\u27E6\u27E8\u27EA\u27EC\u27EE\u2983\u2985\u2987\u2989\u298B\u298D\u298F\u2991\u2993\u2995\u2997\u29D8\u29DA\u29FC\u2E18\u2E22\u2E24\u2E26\u2E28\u3008\u300A\u300C\u300E\u3010\u3014\u3016\u3018\u301A\u301D\uFD3F\uFE17\uFE35\uFE37\uFE39\uFE3B\uFE3D\uFE3F\uFE41\uFE43\uFE47\uFE59\uFE5B\uFE5D\uFF08\uFF3B\uFF5B\uFF5F\uFF62');
set(QU, '"\'\u00AB\u00BB\u2018\u2019\u201B\u201C\u201D\u201F\u2039\u203A\u275B\u275C\u275D\u275E\u2E00\u2E01\u2E02\u2E03\u2E04\u2E05\u2E06\u2E07\u2E08\u2E09\u2E0A\u2E0B\u2E0C\u2E0D\u2E1C\u2E1D\u2E20\u2E21');
set(EX, '!?\u05C6\u061B\u061E\u061F\u06D4\u07F9\u0F0D\u0F0E\u0F0F\u0F10\u0F11\u0F14\u1802\u1803\u1808\u1809\u1944\u1945\u2762\u2763\u2CF9\u2CFE\u2E2E\uA60E\uA876\uA877\uFE15\uFE16\uFE56\uFE57\uFF01\uFF1F');
set(IS, ',.:;\u037E\u0589\u060C\u060D\u07F8\u2044\uFE10\uFE13\uFE14');
set(SY, '/');
set(NS, '\u17D6\u203C\u203D\u2047\u2048\u2049\u3005\u301C\u303B\u303C\u309B\u309C\u309D\u309E\u30A0\u30FB\u30FD\u30FE\uA015\uFE54\uFE55\uFF1A\uFF1B\uFF65\uFF9E\uFF9F\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u3095\u3096\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30F5\u30F6\u30FC\uFF67\uFF68\uFF69\uFF6A\uFF6B\uFF6C\uFF6D\uFF6E\uFF6F\uFF70');
set(PR, '+\\$\u00A3\u00A5\u00B1\u20A0\u20A1\u20A2\u20A3\u20A4\u20A5\u20A6\u20A7\u20A8\u20A9\u20AA\u20AB\u20AD\u20AE\u20AF\u20B0\u20B1\u20B2\u20B3\u20B4\u20B5\u20B6\u20B7\u20B8\u20B9\u20BA\u20BB\u20BC\u20BD\u20BE\u20BF\u2116\u2212\u2213\uFE69\uFF04\uFFE1\uFFE5\uFFE6');
set(PO, '%\u00A2\u00B0\u060B\u066A\u2030\u2031\u2032\u2033\u2034\u2035\u2036\u2037\u20A7\u2103\u2109\u2126\uFDFC\uFE6A\uFF05\uFFE0\u20AC');

const MARK = /^[\p{M}\u200C\u200D]$/u;
const DIGIT = /^\p{Nd}$/u;
const PICTO = /^\p{Extended_Pictographic}$/u;

function lineClass(cp) {
  const own = SINGLE.get(cp);
  if (own) return own;
  if (cp < 0x80) return cp >= 0x30 && cp <= 0x39 ? NU : AL;
  const ch = String.fromCodePoint(cp);
  if (MARK.test(ch)) return CM;
  if (DIGIT.test(ch)) return NU;
  if ((cp >= 0x0e00 && cp <= 0x0eff) || (cp >= 0x1000 && cp <= 0x109f) || (cp >= 0x1780 && cp <= 0x17ff) ||
    (cp >= 0x1950 && cp <= 0x19df) || (cp >= 0x1a20 && cp <= 0x1aaf) || (cp >= 0xaa60 && cp <= 0xaadf) || (cp >= 0xa9e0 && cp <= 0xa9ff)) return SA;
  if ((cp >= 0x2e80 && cp <= 0x2fff) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3100 && cp <= 0x31ff) ||
    (cp >= 0x3200 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)) return ID;
  if (PICTO.test(ch)) return ID;
  return AL;
}

const NO_BREAK_BEFORE = new Set([CL, CP, EX, IS, SY, NS, BA, HY, CM, GL]);

/** Whether a line may break between a cluster of class `a` (after `beforeSpaces` when a is SP) and one of class `b`. */
function mayBreak(a, b, beforeSpaces) {
  if (b === SP || b === ZW || b === BK || b === CR || b === LF) return false;
  if (a === ZW) return true;
  if (a === SP) {
    if (b === CL || b === CP || b === EX || b === IS || b === SY) return false;
    return beforeSpaces !== OP;
  }
  if (a === GL || b === GL) return false;
  if (NO_BREAK_BEFORE.has(b)) return false;
  if (a === OP || a === QU || b === QU) return false;
  if (a === B2 && b === B2) return false;
  if (a === HY && b === NU) return false;
  if (a === BA || a === HY || a === B2) return true;
  if (b === B2) return true;
  if (a === ID || b === ID) {
    if (a === PR && b === ID) return false;
    if (a === ID && b === PO) return false;
    return true;
  }
  return false;
}

const BREAKS = new Map();
let wordSegmenter;

/**
 * Where lines may break in `text`: an array as long as text plus one, where [i] is 0 when no
 * line may start at offset i, 1 when one may, and 2 when one must (after a line break). Offsets
 * are UTF-16 indexes, always between clusters.
 */
export function lineBreaks(text) {
  const cached = BREAKS.get(text);
  if (cached) return cached;
  const out = new Uint8Array(text.length + 1);
  const clusters = graphemes(text);
  let at = 0;
  let prev = 0;
  let beforeSpaces = 0;
  let saStart = -1;
  const sa = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const cls = lineClass(c.codePointAt(0));
    if (i > 0) {
      if (prev === BK || prev === LF || prev === CR) out[at] = 2;
      else if (cls === CM) out[at] = 0;
      else if (prev === SA && cls === SA) out[at] = 0; // decided below, by words
      else out[at] = mayBreak(prev, cls, beforeSpaces) ? 1 : 0;
    }
    if (cls === SA) {
      if (saStart < 0) saStart = at;
    } else if (saStart >= 0) {
      sa.push([saStart, at]);
      saStart = -1;
    }
    if (cls !== SP) beforeSpaces = cls;
    if (cls !== CM) prev = cls;
    at += c.length;
  }
  if (saStart >= 0) sa.push([saStart, at]);
  if (sa.length && typeof Intl !== 'undefined' && Intl.Segmenter) {
    wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const [a, b] of sa) {
      for (const seg of wordSegmenter.segment(text.slice(a, b))) {
        if (seg.index > 0) out[a + seg.index] = 1;
      }
    }
  }
  if (BREAKS.size > 2000) BREAKS.clear();
  BREAKS.set(text, out);
  return out;
}

/** Whether `ch` is a space a line can end with, hanging past the edge (as spaces do in Android and Word). */
export function isHangingSpace(ch) {
  return ch === ' ' || ch === '\u3000' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200A' && ch !== '\u2007') || ch === '\u205F';
}
