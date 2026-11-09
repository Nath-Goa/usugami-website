// What EPUB to PDF needs to read books: a port of the app's core/EpubFormats.kt (HtmlEntities,
// EpubPaths, EpubProtection, XmlPrefix, HtmlText, and the small CSS engine: CssSelector, CssNode,
// CssSheet, SimpleCss, CssValues), with the bits of Kotlin's number and character rules it relies on.
import { ListNumbering } from './office-formats.js';

const Format = ListNumbering.Format;

// ---------------------------------------------------------------------------------------------
// Kotlin's rules, where the app's results depend on them

const JAVA_FLOAT = /^[\x00-\x20]*[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[fFdD]?[\x00-\x20]*$/;

/** Kotlin's String.toFloatOrNull (Java's float syntax: "1e3", "600f", "NaN"...). */
export function ktFloat(text) {
  if (text == null) return null;
  const s = String(text);
  if (!JAVA_FLOAT.test(s)) return null;
  const t = s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[fFdD]$/, '');
  return Number(t.replace(/^\+/, ''));
}

/** Kotlin's String.toIntOrNull: an optional sign and decimal digits, null past Int's range. */
export function ktInt(text) {
  if (text == null) return null;
  const s = String(text);
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** Kotlin's Float.toInt(): towards zero, NaN as 0, kept within Int's range. */
export function ktToInt(x) {
  if (Number.isNaN(x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x);
}

/** Kotlin's Char.isWhitespace: Java's white space and every Unicode space separator (the no-break space too). */
export function isKtWhitespace(c) {
  const code = typeof c === 'number' ? c : c.charCodeAt(0);
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d) || (code >= 0x1c && code <= 0x1f);
  if (code < 0x85) return false;
  if (code === 0xfeff) return false;
  return /\s/.test(String.fromCharCode(code));
}

/** Kotlin's trim(): white space as isKtWhitespace has it, from both ends. */
export function ktTrim(text) {
  let a = 0;
  let b = text.length;
  while (a < b && isKtWhitespace(text.charCodeAt(a))) a++;
  while (b > a && isKtWhitespace(text.charCodeAt(b - 1))) b--;
  return a === 0 && b === text.length ? text : text.slice(a, b);
}

/** Java's regex \s: the six ASCII white space characters. */
const JAVA_SPACE = /[ \t\n\x0B\f\r]+/;

/** The code point that ends just before `index` in `text` (Character.codePointBefore). */
export function codePointBefore(text, index) {
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  }
  return low;
}

/**
 * A breather for long work: `await breathe()` lets the page paint and handle input when `ms`
 * milliseconds have passed since it last did, and costs nothing otherwise.
 */
export function breather(ms = 25) {
  let last = performance.now();
  return async () => {
    const now = performance.now();
    if (now - last < ms) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    last = performance.now();
  };
}

// ---------------------------------------------------------------------------------------------
// HtmlEntities

let entities = null;

/**
 * HTML's named character references, such as &nbsp; and &eacute;. E-books are XHTML, which is XML,
 * and XML defines only five of them; books use the rest anyway, so the reader is taught all of
 * HTML 4's (253, with &apos;): a Map of name → text.
 */
export const HtmlEntities = Object.freeze({
  get all() {
    if (!entities) entities = build();
    return entities;
  },
});

function build() {
  const map = new Map();
  const run = (names, first) => names.split(' ').forEach((name, i) => map.set(name, String.fromCodePoint(first + i)));
  // Latin-1, from U+00A0 to U+00FF in order.
  run(
    'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute ' +
      'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig ' +
      'Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash ' +
      'Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc ' +
      'euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml ' +
      'yacute thorn yuml',
    0xa0,
  );
  run('Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho', 913);
  run('Sigma Tau Upsilon Phi Chi Psi Omega', 931);
  run('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega', 945);
  const others = 'quot 34 amp 38 apos 39 lt 60 gt 62 OElig 338 oelig 339 Scaron 352 scaron 353 Yuml 376 fnof 402 circ 710 tilde 732 ' +
    'thetasym 977 upsih 978 piv 982 ensp 8194 emsp 8195 thinsp 8201 zwnj 8204 zwj 8205 lrm 8206 rlm 8207 ndash 8211 ' +
    'mdash 8212 lsquo 8216 rsquo 8217 sbquo 8218 ldquo 8220 rdquo 8221 bdquo 8222 dagger 8224 Dagger 8225 bull 8226 ' +
    'hellip 8230 permil 8240 prime 8242 Prime 8243 lsaquo 8249 rsaquo 8250 oline 8254 frasl 8260 euro 8364 image 8465 ' +
    'weierp 8472 real 8476 trade 8482 alefsym 8501 larr 8592 uarr 8593 rarr 8594 darr 8595 harr 8596 crarr 8629 ' +
    'lArr 8656 uArr 8657 rArr 8658 dArr 8659 hArr 8660 forall 8704 part 8706 exist 8707 empty 8709 nabla 8711 ' +
    'isin 8712 notin 8713 ni 8715 prod 8719 sum 8721 minus 8722 lowast 8727 radic 8730 prop 8733 infin 8734 ang 8736 ' +
    'and 8743 or 8744 cap 8745 cup 8746 int 8747 there4 8756 sim 8764 cong 8773 asymp 8776 ne 8800 equiv 8801 ' +
    'le 8804 ge 8805 sub 8834 sup 8835 nsub 8836 sube 8838 supe 8839 oplus 8853 otimes 8855 perp 8869 sdot 8901 ' +
    'lceil 8968 rceil 8969 lfloor 8970 rfloor 8971 lang 9001 rang 9002 loz 9674 spades 9824 clubs 9827 hearts 9829 diams 9830';
  const parts = others.split(' ');
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i], String.fromCodePoint(Number(parts[i + 1])));
  return map;
}

// ---------------------------------------------------------------------------------------------
// EpubPaths

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/** Paths inside an EPUB (a zip), as its files link to each other. */
export const EpubPaths = Object.freeze({
  /**
   * The zip path and fragment that `href` points to from the file `base` (such as
   * "OEBPS/text/ch1.xhtml"), as [path, fragment or null]. Null for links out of the book (http:,
   * mailto:, data:...).
   */
  resolve(base, href) {
    const trimmed = ktTrim(String(href ?? ''));
    if (!trimmed) return null;
    if (SCHEME.test(trimmed)) return null;
    const hash = trimmed.indexOf('#');
    let link = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
    const q = link.indexOf('?');
    if (q >= 0) link = link.slice(0, q);
    const fragment = hash >= 0 ? EpubPaths.decode(trimmed.slice(hash + 1)) || null : null;
    // "#note" alone points into the same file.
    if (!link) return [base, fragment];
    const segments = [];
    if (!link.startsWith('/')) {
      const slash = base.lastIndexOf('/');
      if (slash >= 0) for (const s of base.slice(0, slash).split('/')) if (s) segments.push(s);
    }
    for (const segment of EpubPaths.decode(link).split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (segments.length) segments.pop();
      } else segments.push(segment);
    }
    return [segments.join('/'), fragment];
  },

  /** %-escapes decoded as UTF-8. Unlike URLDecoder, "+" stays a plus. */
  decode(text) {
    if (!text.includes('%')) return text;
    const bytes = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '%' && i + 2 < text.length) {
        const value = ktHex(text.slice(i + 1, i + 3));
        if (value != null) {
          bytes.push(value & 0xff);
          i += 3;
          continue;
        }
      }
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      for (const b of utf8.encode(ch)) bytes.push(b);
      i += ch.length;
    }
    return utf8Decoder.decode(new Uint8Array(bytes));
  },
});

/** Kotlin's toIntOrNull(16) of two characters (a sign counts, as there). */
function ktHex(two) {
  if (!/^[+-]?[0-9a-fA-F]+$/.test(two) || /^[+-]$/.test(two)) return null;
  return parseInt(two, 16);
}

// ---------------------------------------------------------------------------------------------
// EpubProtection

/**
 * The ways books hide embedded fonts (IDPF's and Adobe's). They scramble fonts only, which Usugami
 * doesn't use, so a book that has only these isn't protected.
 */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

/** Whether an EPUB is protected with DRM, from the files in its META-INF folder. */
export const EpubProtection = Object.freeze({
  /**
   * `rights` when the book has META-INF/rights.xml (Adobe's DRM) or a Readium LCP licence;
   * `algorithms` are those META-INF/encryption.xml lists. Anything but font obfuscation is DRM.
   */
  isProtected(rights, algorithms) {
    return !!rights || algorithms.some((a) => !FONT_OBFUSCATION.has(ktTrim(String(a))));
  },
});

// ---------------------------------------------------------------------------------------------
// XmlPrefix

const DECLARED = /^[ \t\n\x0B\f\r]*<\?xml[^>]*encoding[ \t\n\x0B\f\r]*=[ \t\n\x0B\f\r]*["']([A-Za-z0-9._:-]+)["']/;

/** Whether the browser can decode text in the character set `name`. */
function supported(name) {
  try {
    new TextDecoder(name);
    return true;
  } catch {
    return false;
  }
}

/** The start of an XML file, looked at before it is parsed. */
export const XmlPrefix = Object.freeze({
  /** The character set of an XML file that starts with `head` (its first `length` bytes): from its byte order mark or declaration. */
  charset(head, length = head.length) {
    const at = (i) => (i < length && i < head.length ? head[i] : -1);
    if (at(0) === 0xfe && at(1) === 0xff) return 'UTF-16BE';
    if (at(0) === 0xff && at(1) === 0xfe) return 'UTF-16LE';
    // UTF-16 without a byte order mark: "<?" with zero bytes between.
    if (at(0) === 0 && at(1) === 0x3c) return 'UTF-16BE';
    if (at(0) === 0x3c && at(1) === 0) return 'UTF-16LE';
    const n = Math.min(length, head.length, 200);
    let text = '';
    for (let i = 0; i < n; i++) text += String.fromCharCode(head[i]);
    if (text.startsWith('ï»¿')) text = text.slice(3);
    const declared = DECLARED.exec(text)?.[1];
    return declared && supported(declared) ? declared : 'UTF-8';
  },

  /**
   * `text` (the start of a file) without its DOCTYPE, so nothing it declares is ever expanded.
   * Null when a DOCTYPE starts but doesn't end within `text`, or when the root element doesn't
   * start within it (a DOCTYPE could still follow).
   */
  stripDoctype(text) {
    const start = text.search(/<!DOCTYPE/i);
    let stripped = text;
    if (start >= 0) {
      let i = start + 9;
      let quote = '';
      let depth = 0;
      let end = -1;
      while (i < text.length) {
        const c = text[i];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth = Math.max(0, depth - 1);
        else if (c === '>' && depth === 0) {
          end = i;
          break;
        }
        i++;
      }
      if (end < 0) return null;
      stripped = text.slice(0, start) + text.slice(end + 1);
    }
    // The root element must start here; comments and processing instructions may come first.
    let i = 0;
    for (;;) {
      i = stripped.indexOf('<', i);
      if (i < 0 || i + 1 >= stripped.length) return null;
      const next = stripped[i + 1];
      if (next === '_' || /\p{L}/u.test(next)) return stripped;
      if (stripped.startsWith('<!--', i)) {
        const e = stripped.indexOf('-->', i);
        if (e < 0) return null;
        i = e + 3;
      } else if (next === '?') {
        const e = stripped.indexOf('?>', i);
        if (e < 0) return null;
        i = e + 2;
      } else return null;
    }
  },
});

// ---------------------------------------------------------------------------------------------
// HtmlText

const isSpace = (c) => c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x0c;
const HANGUL = /^\p{Script=Hangul}$/u;
const WIDE_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]$/u;

/** Text in HTML, where runs of spaces and line breaks show as one space. */
export const HtmlText = Object.freeze({
  /**
   * `text` with each run of white space as one space, and leading white space dropped when the
   * text so far ends in a space (`afterSpace`). No-break spaces stay. A line break between two
   * Chinese or Japanese characters goes, as CSS has it: those languages don't put spaces between
   * words, and their books often break a paragraph's lines in the file. `before` is the character
   * the text so far ends in (0 for none), for a break at the start of `text`, as after an end tag.
   */
  collapse(text, afterSpace, before = 0) {
    let out = '';
    let space = afterSpace;
    let i = 0;
    const n = text.length;
    let from = 0;
    while (i < n) {
      if (!isSpace(text.charCodeAt(i))) {
        i++;
        space = false;
        continue;
      }
      if (i > from) out += text.slice(from, i);
      const start = i;
      let lineBreak = false;
      while (i < n && isSpace(text.charCodeAt(i))) {
        const c = text.charCodeAt(i);
        if (c === 0x0a || c === 0x0d) lineBreak = true;
        i++;
      }
      from = i;
      const previous = start > 0 ? codePointBefore(text, start) : before;
      const joined = lineBreak && i < n && HtmlText.isWide(previous) && HtmlText.isWide(text.codePointAt(i));
      if (!joined) {
        if (!space) out += ' ';
        space = true;
      }
    }
    if (n > from) out += text.slice(from, n);
    return out;
  },

  /**
   * Whether `text` ends in a line break after a Chinese or Japanese character (`before` when it's
   * all white space). collapse() can't see the text after it, so makes a space of it: one that
   * goes if the text after it, in the next element, starts with such a character.
   */
  endsInWideBreak(text, before) {
    let i = text.length;
    let lineBreak = false;
    while (i > 0 && isSpace(text.charCodeAt(i - 1))) {
      const c = text.charCodeAt(i - 1);
      if (c === 0x0a || c === 0x0d) lineBreak = true;
      i--;
    }
    return lineBreak && HtmlText.isWide(i > 0 ? codePointBefore(text, i) : before);
  },

  /** Whether `code` is a wide Chinese or Japanese character or punctuation mark (Korean is written with spaces). */
  isWide(code) {
    if (!(code >= 0x2e80)) return false;
    if (code > 0x10ffff) return false;
    const s = String.fromCodePoint(code);
    if (HANGUL.test(s)) return false;
    if (WIDE_SCRIPT.test(s)) return true;
    // Blocks of wide punctuation and marks that Chinese and Japanese share, such as 。 and ー.
    return (code >= 0x3000 && code <= 0x30ff) || (code >= 0xfe10 && code <= 0xfe1f) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xffef);
  },

  /** A fixed-layout page's size from its viewport, such as "width=1200, height=1600": [width, height] or null. */
  viewport(content) {
    const values = new Map();
    for (const part of String(content ?? '').split(/[,;]/)) {
      const kv = part.split('=');
      if (kv.length !== 2) continue;
      const f = ktFloat(ktTrim(kv[1]));
      values.set(ktTrim(kv[0]).toLowerCase(), f == null ? null : ktToInt(f));
    }
    const width = values.get('width');
    const height = values.get('height');
    if (!(width > 0) || !(height > 0)) return null;
    return [width, height];
  },

  /** A list label's format for CSS's list-style-type, or for an ol element's type attribute. Null for none. */
  listFormat(value, ordered) {
    switch (value == null ? null : ktTrim(String(value))) {
      case 'none': return null;
      case 'disc': case 'circle': case 'square': return Format.BULLET;
      case 'decimal': case '1': return Format.DECIMAL;
      case 'decimal-leading-zero': return Format.DECIMAL_ZERO;
      case 'lower-alpha': case 'lower-latin': case 'a': return Format.LOWER_LETTER;
      case 'upper-alpha': case 'upper-latin': case 'A': return Format.UPPER_LETTER;
      case 'lower-roman': case 'i': return Format.LOWER_ROMAN;
      case 'upper-roman': case 'I': return Format.UPPER_ROMAN;
      default: return ordered ? Format.DECIMAL : Format.BULLET;
    }
  },

  /**
   * Column widths for a table whose columns hold `weights` of text (such as their longest cell's
   * length), sharing `available`: half of it evenly, half by the text, so a column with a lot of
   * text gets more room without squeezing the others to nothing.
   */
  columnWidths(weights, available) {
    if (!weights.length) return [];
    let total = 0;
    for (const w of weights) total += Math.max(1, w);
    return weights.map((w) => (0.5 / weights.length + (0.5 * Math.max(1, w)) / total) * available);
  },
});

// ---------------------------------------------------------------------------------------------
// CSS

/** One part of a CSS selector, such as p.note or #title: a tag (null for any), an id and classes. */
export class CssCompound {
  constructor(tag, id, classes) {
    this.tag = tag;
    this.id = id;
    this.classes = classes;
  }

  matches(node) {
    if (this.tag != null && this.tag !== node.tag) return false;
    if (this.id != null && this.id !== node.id) return false;
    for (const c of this.classes) if (!node.classes.has(c)) return false;
    return true;
  }
}

/**
 * How far up a descendant selector looks for its ancestor: deeper than any book nests, and it keeps
 * a crafted file of a million nested elements from taking hours.
 */
const MAX_ANCESTORS = 4096;

/**
 * A CSS selector Usugami understands: compounds joined by descendant (' ') or child ('>')
 * combinators, outermost first. Others (attributes, pseudo-classes, siblings) are left out.
 */
export class CssSelector {
  constructor(parts, combinators) {
    this.parts = parts;
    this.combinators = combinators;
    /** Ids count 100, classes 10 and tags 1, as in CSS. */
    this.specificity = parts.reduce((n, p) => n + (p.id != null ? 100 : 0) + p.classes.length * 10 + (p.tag != null ? 1 : 0), 0);
  }

  get key() {
    return this.parts[this.parts.length - 1];
  }

  matches(node) {
    const parts = this.parts;
    if (!parts[parts.length - 1].matches(node)) return false;
    let current = node;
    for (let i = parts.length - 2; i >= 0; i--) {
      const part = parts[i];
      if (this.combinators[i] === '>') {
        const up = current?.parent;
        current = up && part.matches(up) ? up : null;
      } else {
        let up = current?.parent;
        let steps = 0;
        while (up && !part.matches(up) && ++steps < MAX_ANCESTORS) up = up.parent;
        current = up && steps < MAX_ANCESTORS ? up : null;
      }
      if (!current) return false;
    }
    return true;
  }
}

/** An element as CSS sees it, with its parent: `classes` a Set. */
export class CssNode {
  constructor(tag, id, classes, parent) {
    this.tag = tag;
    this.id = id;
    this.classes = classes instanceof Set ? classes : new Set(classes ?? []);
    this.parent = parent ?? null;
  }
}

export class CssRule {
  constructor(selector, declarations, order) {
    this.selector = selector;
    this.declarations = declarations;
    this.order = order;
  }
}

/** Declarations: property name → value, in an object with no prototype (any name is safe in it). */
const declarationMap = () => Object.create(null);

/** A style sheet's rules, found by the tag, class or id they end with. */
export class CssSheet {
  constructor(rules) {
    this.byTag = new Map();
    this.byClass = new Map();
    this.byId = new Map();
    const add = (map, key, rule) => {
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      list.push(rule);
    };
    for (const rule of rules) {
      const key = rule.selector.key;
      if (key.id != null) add(this.byId, key.id, rule);
      else if (key.classes.length) add(this.byClass, key.classes[0], rule);
      else add(this.byTag, key.tag ?? '*', rule);
    }
  }

  get isEmpty() {
    return !this.byTag.size && !this.byClass.size && !this.byId.size;
  }

  /** The rules that apply to `node`. */
  matching(node) {
    const found = [];
    const push = (list) => { if (list) for (const r of list) found.push(r); };
    push(this.byTag.get(node.tag));
    push(this.byTag.get('*'));
    for (const c of node.classes) push(this.byClass.get(c));
    if (node.id != null) push(this.byId.get(node.id));
    return found.filter((r) => r.selector.matches(node));
  }

  /**
   * The declarations for `node` from `sheets` (in the order the document links them), then its
   * own style attribute `inline`: each later or more specific one wins.
   */
  static cascade(node, sheets, inline) {
    const result = declarationMap();
    const rules = [];
    let sheetIndex = 0;
    for (const sheet of sheets) {
      for (const rule of sheet.matching(node)) rules.push([rule.selector.specificity, sheetIndex * 1000000 + rule.order, rule]);
      sheetIndex++;
    }
    rules.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, , rule] of rules) Object.assign(result, rule.declarations);
    if (inline != null && ktTrim(inline) !== '') Object.assign(result, SimpleCss.declarations(inline));
    return result;
  }
}

const LIST_TYPES = new Set([
  'none', 'disc', 'circle', 'square', 'decimal', 'decimal-leading-zero', 'lower-alpha', 'lower-latin', 'upper-alpha',
  'upper-latin', 'lower-roman', 'upper-roman', 'lower-greek', 'armenian', 'georgian',
]);
const IMPORTANT = /!\s*important/gi;
const COMPOUND = /^([a-zA-Z][a-zA-Z0-9-]*|\*)?((?:[.#][a-zA-Z_][a-zA-Z0-9_-]*)*)$/;
const PIECE = /[.#][a-zA-Z_][a-zA-Z0-9_-]*/g;

/** Just enough CSS for e-books: rules with simple selectors and their declarations. */
export const SimpleCss = Object.freeze({
  /** A CssSheet of the style sheet `text`. */
  parse(text) {
    const css = withoutComments(String(text ?? ''));
    const rules = [];
    let i = 0;
    let order = 0;
    while (i < css.length) {
      const open = css.indexOf('{', i);
      if (open < 0) break;
      const prelude = css.slice(i, open);
      // The block, with any blocks nested in it (@media rules hold whole rules).
      let depth = 1;
      let j = open + 1;
      while (j < css.length && depth > 0) {
        const c = css.charCodeAt(j);
        if (c === 0x7b) depth++;
        else if (c === 0x7d) depth--;
        j++;
      }
      const body = css.slice(open + 1, Math.max(j - 1, open + 1));
      i = j;
      // At-rules (@font-face, @page, @media...) are left out, statements such as @import too.
      const start = ktTrim(prelude.slice(prelude.lastIndexOf(';') + 1));
      if (start.startsWith('@') || !start) continue;
      const declarations = SimpleCss.declarations(body);
      if (!Object.keys(declarations).length) continue;
      for (const selectorText of start.split(',')) {
        const selector = SimpleCss.selector(selectorText);
        if (!selector) continue;
        rules.push(new CssRule(selector, declarations, order++));
      }
    }
    return new CssSheet(rules);
  },

  /**
   * The declarations of a rule or style attribute, by lowercase name, with !important dropped. The
   * shorthands read (margin, list-style) come as the properties they set, and page-break-before
   * and -after as break-before and -after, so that a later or more specific rule setting either
   * form wins, as in CSS.
   */
  declarations(block) {
    const out = declarationMap();
    for (const part of String(block).split(';')) {
      const colon = part.indexOf(':');
      if (colon <= 0) continue;
      const name = ktTrim(part.slice(0, colon)).toLowerCase();
      const value = ktTrim(part.slice(colon + 1).replace(IMPORTANT, ''));
      if (!name || !value) continue;
      switch (name) {
        case 'margin': {
          const v = CssValues.verticalMargins(value);
          const h = CssValues.horizontalMargins(value);
          if (!v || !h) continue;
          out['margin-top'] = v[0];
          out['margin-right'] = h[1];
          out['margin-bottom'] = v[1];
          out['margin-left'] = h[0];
          break;
        }
        case 'list-style': {
          // Its type, if it gives one; the rest (position, picture) isn't read.
          const type = value.toLowerCase().split(JAVA_SPACE).find((t) => LIST_TYPES.has(t));
          if (type) out['list-style-type'] = type;
          break;
        }
        case 'page-break-before':
        case 'page-break-after':
          out[name.slice(5)] = value;
          break;
        default:
          out[name] = value;
      }
    }
    return out;
  },

  /** A selector such as "div.poem > p", or null for one Usugami doesn't understand. */
  selector(text) {
    const tokens = ktTrim(String(text)).replaceAll('>', ' > ').split(JAVA_SPACE).filter((t) => t);
    if (!tokens.length) return null;
    const parts = [];
    const combinators = [];
    let child = false;
    for (const token of tokens) {
      if (token === '>') {
        if (!parts.length || child) return null;
        child = true;
        continue;
      }
      if (parts.length) combinators.push(child ? '>' : ' ');
      child = false;
      const part = compound(token);
      if (!part) return null;
      parts.push(part);
    }
    if (child) return null;
    return new CssSelector(parts, combinators);
  },
});

/** `text` with each comment as a space; one that isn't closed runs to the end. Read in one pass, however crafted. */
function withoutComments(text) {
  if (!text.includes('/*')) return text;
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf('/*', i);
    if (start < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, start) + ' ';
    const end = text.indexOf('*/', start + 2);
    if (end < 0) break;
    i = end + 2;
  }
  return out;
}

function compound(token) {
  // In an e-book, the root element is <html>.
  if (token.toLowerCase() === ':root') return new CssCompound('html', null, []);
  const match = COMPOUND.exec(token);
  if (!match) return null;
  const tagText = (match[1] ?? '').toLowerCase();
  const tag = tagText && tagText !== '*' ? tagText : null;
  let id = null;
  const classes = [];
  for (const piece of (match[2] ?? '').match(PIECE) ?? []) {
    const name = piece.slice(1);
    if (piece[0] === '#') id = name;
    else classes.push(name);
  }
  return new CssCompound(tag, id, classes);
}

const LENGTH = /^(-?\d*\.?\d+)\s*(em|rem|ex|px|pt|pc|in|cm|mm|%)?$/;
const MAX_LENGTH = 64;
const BREAKS = new Set(['always', 'page', 'left', 'right', 'recto', 'verso']);
const MONO_NAMES = ['courier', 'mono', 'consolas', 'menlo', 'monaco'];
const SANS_NAMES = ['arial', 'helvetica', 'verdana', 'roboto', 'open sans', 'tahoma', 'calibri'];
const SERIF_NAMES = ['times', 'georgia', 'garamond', 'palatino', 'baskerville', 'book', 'minion', 'caslon', 'charter', 'cambria'];

/** CSS values, in points. Books are written for a 16 px default font; Usugami's is `base` points. */
export const CssValues = Object.freeze({
  /**
   * A length such as "1.5em", "12px" or "5%". `em` is the element's font size, `base` the book's,
   * `percentOf` what 100% is (null when percentages don't apply), `rem` the root element's font
   * size. Absolute units scale with the book's font, as 16 px (12 pt) is to `base`.
   */
  length(value, em, base, percentOf = null, rem = base) {
    if (value == null) return null;
    // No length is longer: a crafted one, thousands of digits long, would keep the pattern busy.
    const text = ktTrim(String(value)).toLowerCase();
    if (text.length > MAX_LENGTH) return null;
    const match = LENGTH.exec(text);
    if (!match) return null;
    const number = ktFloat(match[1]);
    if (number == null) return null;
    const scale = base / 12;
    switch (match[2]) {
      case 'em': return number * em;
      case 'rem': return number * rem;
      case 'ex': return number * em * 0.5;
      case 'px': return number * 0.75 * scale;
      case 'pt': return number * scale;
      case 'pc': return number * 12 * scale;
      case 'in': return number * 72 * scale;
      case 'cm': return ((number * 72) / 2.54) * scale;
      case 'mm': return ((number * 72) / 25.4) * scale;
      case '%': return percentOf == null ? null : (number / 100) * percentOf;
      default: return number === 0 ? 0 : null;
    }
  },

  /**
   * A font-size: relative to `parent`, keywords and absolute sizes relative to `base`, rem to `rem`;
   * kept between 0.6 and 3 times `base`.
   */
  fontSize(value, parent, base, rem = base) {
    const v = anyFontSize(value, parent, base, rem);
    return v == null ? null : Math.min(base * 3, Math.max(base * 0.6, v));
  },

  /**
   * The font size rem lengths are of: the root (html) element's `value`, as fontSize reads it, but
   * not kept as close to `base`, as books often set it small (62.5%, or 10px) to write sizes in rems
   * of ten pixels.
   */
  rootSize(value, base) {
    const v = anyFontSize(value, base, base, base);
    return v == null ? null : Math.min(base * 10, Math.max(base * 0.1, v));
  },

  /** Whether a font-weight is bold; null when it doesn't say. */
  bold(value) {
    if (value == null) return null;
    const v = ktTrim(String(value)).toLowerCase();
    if (v === 'bold' || v === 'bolder') return true;
    if (v === 'normal' || v === 'lighter') return false;
    const n = ktInt(v);
    return n == null ? null : n >= 600;
  },

  /** The vertical part of a margin shorthand: its [top, bottom] values. */
  verticalMargins(shorthand) {
    const parts = shorthandParts(shorthand);
    if (!parts) return null;
    if (parts.length <= 2) return [parts[0], parts[0]];
    return [parts[0], parts[2]];
  },

  /** The horizontal part of a margin shorthand: its [left, right] values. */
  horizontalMargins(shorthand) {
    const parts = shorthandParts(shorthand);
    if (!parts) return null;
    if (parts.length === 1) return [parts[0], parts[0]];
    if (parts.length <= 3) return [parts[1], parts[1]];
    return [parts[3], parts[1]];
  },

  /** The generic family ('serif', 'sans-serif' or 'monospace') for a font-family list, or null when none is clear. */
  fontFamily(value) {
    for (const raw of String(value ?? '').split(',')) {
      const name = ktTrim(raw).replace(/^["']+|["']+$/g, '').toLowerCase();
      if (!name) continue;
      if (name === 'monospace' || MONO_NAMES.some((m) => name.includes(m))) return 'monospace';
      if (name.includes('sans') || SANS_NAMES.some((m) => name.includes(m))) return 'sans-serif';
      if (name.includes('serif') || SERIF_NAMES.some((m) => name.includes(m))) return 'serif';
    }
    return null;
  },

  /** Whether a page-break-before/after or break-before/after value asks for a new page. */
  pageBreak(value) {
    return value != null && BREAKS.has(ktTrim(String(value)).toLowerCase());
  },

  /** The writing mode `css` sets, under any of the names books give it, such as "vertical-rl"; null when it sets none. */
  writingMode(css) {
    const v = css['writing-mode'] ?? css['-epub-writing-mode'] ?? css['-webkit-writing-mode'];
    return v == null ? null : ktTrim(v).toLowerCase();
  },

  /**
   * `css` written for lines running down the page in `mode` (as Japanese and Chinese books often
   * are), for lines running across it, as Usugami lays every book out: the margins before and after
   * the lines (right and left, the other way round from the left) become those above and below them,
   * and those at their start and end (top and bottom) those on the left and right. Other modes'
   * CSS is left as it is.
   */
  acrossFromVertical(css, mode) {
    let fromRight;
    if (mode === 'vertical-rl' || mode === 'tb-rl' || mode === 'tb') fromRight = true;
    else if (mode === 'vertical-lr' || mode === 'tb-lr') fromRight = false;
    else return css;
    if (!Object.keys(css).some((k) => k.startsWith('margin-'))) return css;
    const out = Object.assign(declarationMap(), css);
    for (const side of ['top', 'right', 'bottom', 'left']) delete out[`margin-${side}`];
    if (css['margin-top'] != null) out['margin-left'] = css['margin-top'];
    if (css['margin-bottom'] != null) out['margin-right'] = css['margin-bottom'];
    const before = css[fromRight ? 'margin-right' : 'margin-left'];
    if (before != null) out['margin-top'] = before;
    const after = css[fromRight ? 'margin-left' : 'margin-right'];
    if (after != null) out['margin-bottom'] = after;
    return out;
  },
});

function shorthandParts(shorthand) {
  if (shorthand == null) return null;
  const parts = ktTrim(String(shorthand)).split(JAVA_SPACE);
  if (!parts.length || !parts[0]) return null;
  return parts;
}

function anyFontSize(value, parent, base, rem) {
  if (value == null) return null;
  const v = ktTrim(String(value)).toLowerCase();
  switch (v) {
    case 'xx-small': return base * 0.6;
    case 'x-small': return base * 0.75;
    case 'small': return base * 0.89;
    case 'medium': return base;
    case 'large': return base * 1.2;
    case 'x-large': return base * 1.5;
    case 'xx-large': return base * 2;
    case 'smaller': return parent * 0.83;
    case 'larger': return parent * 1.2;
    default: return CssValues.length(v, parent, base, parent, rem);
  }
}
