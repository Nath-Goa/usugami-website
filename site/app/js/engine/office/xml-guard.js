// What an Office part must pass before the browser's XML parser sees it: a port of the app's
// core/XmlTokenGuard.kt, with the reading rules of its OfficeXml (Ooxml.kt).
//
// The browser's DOMParser works in one call that nothing can stop, so markup that no Office file
// has is refused first, by counting as the app counts:
// - a tag, or text between tags (with the comments, CDATA and instructions in it), longer than
//   MAX_RUN characters; text broken up by comments more than MAX_COPIED characters' worth;
// - more than MAX_ATTRIBUTES attributes on the elements open at once, a tag's own among them;
// - an XML declaration with more than its three attributes, or one naming an encoding in which the
//   bytes could mean something else (UTF-16 after an 8-bit declaration), which Office never writes;
// - a DOCTYPE (whose entities could expand into gigabytes), or any other declaration but a comment
//   or CDATA;
// - elements nested more than MAX_NESTING deep.
// Elements nested deeper than MAX_DEPTH, which the app skips, are cut out of the text, so the
// browser's parser (which gives up at a few thousand levels) reads the rest as the app does.
import { checkCancelled } from '../../core/errors.js';

/** Far longer than any text or tag Office writes: a cell holds 32,767 characters at most. */
export const MAX_RUN = 8 * 1024 * 1024;

/** Text joined across comments, copied in all: a few times MAX_RUN. */
export const MAX_COPIED = 4 * MAX_RUN;

/** Far more than Office writes: a few dozen on one element, under a hundred on all those open at once. */
export const MAX_ATTRIBUTES = 4096;

/** Version, encoding and standalone. */
export const DECLARATION_ATTRIBUTES = 3;

/** As long as the app's parser reads an XML declaration. */
export const MAX_DECLARATION = 8192;

/** Far deeper than Office nests anything: elements deeper than this are left out, as in the app. */
export const MAX_DEPTH = 256;

/** How deep a part can nest at all, elements past MAX_DEPTH being left out. */
export const MAX_NESTING = 64 * MAX_DEPTH;

/**
 * A part that can't be read: refused by the guard, or not well-formed XML (the app's IOException,
 * which makes the file count as damaged).
 */
export class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

/** The same class, by the name of the guard. */
export { XmlError as XmlGuardError };

// What the character being read is part of.
const TEXT = 0;
const OPENED = 1; // just after "<", before it is known what it opens
const ELEMENT = 2;
const END_TAG = 3;
const BANG = 4; // just after "<!": a comment or CDATA follows
const OPENING = 5; // the rest of "<!--" or "<![CDATA["
const COMMENT = 6;
const CDATA = 7;
const INSTRUCTION = 8;
const XML_NAME = 9; // after a "<?" at the part's very start: "xml " makes it the declaration
const DECLARATION = 10;
const DOCTYPE = 11; // a DOCTYPE being left out (only with { doctype: 'remove' })

const LT = 60; // <
const GT = 62; // >
const SLASH = 47;
const BANG_CH = 33; // !
const QUESTION = 63;
const QUOTE = 34;
const APOS = 39;
const EQUALS = 61;
const DASH = 45;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const SPACE = 32;
const XML_WORD = 'xml ';

/**
 * The guard, fed the part's characters in order (in one go or in slices of the same string, with
 * positions counted from its start). After end(): `cuts` lists the [start, end) ranges to leave
 * out (elements too deep, the XML declaration, a DOCTYPE when allowed), and `rootStart`/`rootEnd`
 * locate the root element's start tag.
 */
export class XmlTokenGuard {
  /** `doctype`: 'refuse' (Office parts, the default) or 'remove' (left out unread, as e-books need). */
  constructor({ doctype = 'refuse' } = {}) {
    this.removeDoctype = doctype === 'remove';
    this.markup = TEXT;
    this.atStart = true;
    this.opensPart = false;
    this.expected = '';
    this.matched = 0;
    this.then = TEXT;
    this.closing = 0;
    this.run = 0;
    this.copied = 0;
    this.quote = 0;
    this.slash = false;
    this.attributes = 0;
    this.open = 0;
    this.inScope = 0;
    this.scopes = [];
    this.lt = -1;
    this.cuts = [];
    this.cutDepth = -1;
    this.cutStart = 0;
    this.rootStart = -1;
    this.rootEnd = -1;
    this.declStart = -1;
    this.doctypeBrackets = 0;
    this.doctypeQuote = 0;
    this.length = 0;
  }

  /** Reads text[from..to). Throws XmlError when the part goes past a limit. */
  feed(text, from = 0, to = text.length) {
    let i = from;
    while (i < to) {
      const c = text.charCodeAt(i);
      const first = this.atStart;
      this.atStart = false;
      // The text between tags, the bulk of most parts, is passed over in one step.
      if (this.markup === TEXT && c !== LT) {
        let j = text.indexOf('<', i);
        if (j < 0 || j > to) j = to;
        this.run += j - i;
        if (this.run > MAX_RUN) throw new XmlError('Office part with a tag or text too long to read');
        i = j;
        continue;
      }
      if ((this.markup === ELEMENT || this.markup === DECLARATION) && this.quote !== 0 && c !== this.quote) {
        let j = text.indexOf(this.quote === QUOTE ? '"' : "'", i);
        if (j < 0 || j > to) j = to;
        this.run += j - i;
        if (this.run > MAX_RUN) throw new XmlError('Office part with a tag or text too long to read');
        i = j;
        continue;
      }
      if (++this.run > MAX_RUN) throw new XmlError('Office part with a tag or text too long to read');
      switch (this.markup) {
        case TEXT:
          // c is "<"
          this.markup = OPENED;
          this.opensPart = first;
          this.lt = i;
          break;
        case OPENED:
          this.opened(c, i);
          break;
        case ELEMENT:
        case DECLARATION:
          this.tag(c, i);
          break;
        case END_TAG:
          if (c === GT) this.endTag(i);
          break;
        case BANG:
          if (c === DASH) this.expect('-', COMMENT);
          else if (c === OPEN_BRACKET) this.expect('CDATA[', CDATA);
          else if (this.removeDoctype && (c === 68 || c === 100) /* D, d */) {
            this.markup = DOCTYPE;
            this.doctypeBrackets = 0;
            this.doctypeQuote = 0;
          } else throw new XmlError("Office part with a DOCTYPE or declaration Office doesn't write");
          break;
        case OPENING:
          // The parser fails on anything else here too.
          if (c !== this.expected.charCodeAt(this.matched)) throw new XmlError('Office part with a broken comment or CDATA');
          if (++this.matched === this.expected.length) {
            this.markup = this.then;
            this.closing = 0;
          }
          break;
        case COMMENT:
          this.special(c, DASH, 2);
          break;
        case CDATA:
          this.special(c, CLOSE_BRACKET, 2);
          break;
        case INSTRUCTION:
          this.special(c, QUESTION, 1);
          break;
        case XML_NAME: {
          const lower = c >= 65 && c <= 90 ? c + 32 : c;
          if (lower === XML_WORD.charCodeAt(this.matched)) {
            if (++this.matched === XML_WORD.length) {
              this.startTag(DECLARATION);
              this.declStart = this.lt;
            }
          } else {
            this.markup = INSTRUCTION;
            this.closing = 0;
            this.special(c, QUESTION, 1);
          }
          break;
        }
        case DOCTYPE:
          this.doctype(c, i);
          break;
        default:
          break;
      }
      i++;
    }
    this.length = Math.max(this.length, to);
  }

  /** The part has been read to its end. */
  end() {
    if (this.cutDepth >= 0) {
      this.cuts.push([this.cutStart, this.length]);
      this.cutDepth = -1;
    }
    return this;
  }

  opened(c, i) {
    if (c === SLASH) {
      this.markup = END_TAG;
      this.run = 0;
      this.copied = 0;
    } else if (c === BANG_CH || c === QUESTION) {
      // Text before and after this is joined, the text so far copied each time.
      this.copied += this.run;
      if (this.copied > MAX_COPIED) throw new XmlError('Office part with text broken up too often to read');
      if (c === BANG_CH) {
        this.markup = BANG;
      } else if (this.opensPart) {
        this.markup = XML_NAME;
        this.matched = 0;
      } else {
        this.markup = INSTRUCTION;
        this.closing = 0;
      }
    } else {
      this.startTag(ELEMENT);
      this.run = 0;
      this.copied = 0;
      // An element as deep as the app reads no further: it goes, with all it holds.
      if (this.cutDepth < 0 && this.open >= MAX_DEPTH) {
        this.cutDepth = this.open;
        this.cutStart = this.lt;
      }
      if (this.rootStart < 0) this.rootStart = this.lt;
    }
  }

  expect(text, next) {
    this.markup = OPENING;
    this.expected = text;
    this.matched = 0;
    this.then = next;
  }

  startTag(kind) {
    this.markup = kind;
    this.attributes = 0;
    this.quote = 0;
    this.slash = false;
  }

  /** c in a start tag or the XML declaration, where quotes are tracked and each "=" outside them is an attribute. */
  tag(c, i) {
    if (this.quote !== 0) {
      if (c === this.quote) this.quote = 0;
    } else if (c === QUOTE || c === APOS) {
      this.quote = c;
      this.slash = false;
    } else if (c === EQUALS) {
      this.attributes++;
      if (this.markup === DECLARATION) {
        if (this.attributes > DECLARATION_ATTRIBUTES) throw new XmlError('Office part with too many attributes in its XML declaration');
      } else if (this.inScope + this.attributes > MAX_ATTRIBUTES) {
        throw new XmlError('Office part with too many attributes on its open elements');
      }
      this.slash = false;
    } else if (c === SLASH) {
      this.slash = true;
    } else if (c === GT) {
      if (this.markup === ELEMENT) {
        if (this.open + 1 > MAX_NESTING) throw new XmlError('Office part nested too deeply');
        if (this.rootEnd < 0) this.rootEnd = i + 1;
        if (!this.slash) this.push();
        else if (this.cutDepth >= 0 && this.cutDepth === this.open) this.endCut(i);
      } else if (this.declStart >= 0) {
        // The declaration's encoding has been dealt with already: the browser is given text.
        this.cuts.push([this.declStart, i + 1]);
        this.declStart = -1;
      }
      this.markup = TEXT;
      this.run = 0;
      this.copied = 0;
    } else if (c > SPACE) {
      this.slash = false;
    }
  }

  /** The start tag just read leaves its element open, with its attributes in scope until it ends. */
  push() {
    this.open++;
    if (this.attributes === 0) return;
    this.scopes.push(this.open, this.attributes);
    this.inScope += this.attributes;
  }

  /** An end tag closes the innermost open element, taking its attributes out of scope. */
  endTag(i) {
    if (this.open > 0) {
      const s = this.scopes;
      if (s.length > 0 && s[s.length - 2] === this.open) {
        this.inScope -= s[s.length - 1];
        s.length -= 2;
      }
      this.open--;
      if (this.cutDepth >= 0 && this.open === this.cutDepth) this.endCut(i);
    }
    this.markup = TEXT;
    this.run = 0;
    this.copied = 0;
  }

  endCut(i) {
    this.cuts.push([this.cutStart, i + 1]);
    this.cutDepth = -1;
  }

  /** c in a comment, CDATA or instruction, which ends at a ">" after `count` of `closer` in a row. */
  special(c, closer, count) {
    if (c === GT && this.closing >= count) {
      this.markup = TEXT;
      return;
    }
    this.closing = c === closer ? this.closing + 1 : 0;
  }

  /** A DOCTYPE being left out: it ends at a ">" outside quotes and its internal subset. */
  doctype(c, i) {
    if (this.doctypeQuote !== 0) {
      if (c === this.doctypeQuote) this.doctypeQuote = 0;
    } else if (c === QUOTE || c === APOS) {
      this.doctypeQuote = c;
    } else if (c === OPEN_BRACKET) {
      this.doctypeBrackets++;
    } else if (c === CLOSE_BRACKET) {
      if (this.doctypeBrackets > 0) this.doctypeBrackets--;
    } else if (c === GT && this.doctypeBrackets === 0) {
      if (this.cutDepth < 0) this.cuts.push([this.lt, i + 1]);
      this.markup = TEXT;
    }
  }
}

/** `text` without the ranges in `cuts` (sorted or not, overlapping or not). */
export function withoutCuts(text, cuts) {
  if (!cuts.length) return text;
  const sorted = cuts.slice().sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [start, end] of sorted) {
    if (end <= at) continue;
    if (start > at) parts.push(text.slice(at, start));
    at = Math.max(at, end);
  }
  parts.push(text.slice(at));
  return parts.join('');
}

/**
 * `text` checked by the guard, without what the browser's parser mustn't be given: elements
 * nested deeper than MAX_DEPTH, the XML declaration, and (with { doctype: 'remove' }) a DOCTYPE.
 * Throws XmlError.
 */
export function guardXml(text, options = {}) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const guard = new XmlTokenGuard(options);
  guard.feed(t);
  guard.end();
  return withoutCuts(t, guard.cuts);
}

/** As guardXml, in slices with pauses between them, so a large part doesn't freeze the page. */
export async function guardXmlAsync(text, { signal, doctype } = {}) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const guard = new XmlTokenGuard({ doctype });
  const SLICE = 4 * 1024 * 1024;
  for (let from = 0; from < t.length; from += SLICE) {
    guard.feed(t, from, Math.min(t.length, from + SLICE));
    if (from + SLICE < t.length) {
      await pause();
      checkCancelled(signal);
    }
  }
  guard.end();
  return withoutCuts(t, guard.cuts);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------------------------
// Encodings

/** Encodings with one byte to each ASCII character, in which the counting holds. */
const EIGHT_BIT = /^(?:utf-?8|(?:us-)?ascii|iso[-_]?8859[-_]\d+|latin-?1|(?:windows|cp)-?125\d)$/i;

/**
 * The part's bytes as text, read as the app's parser reads them: UTF-32 or UTF-16 when the part
 * starts with a byte order mark or a "<" in one of them, else 8-bit, in the encoding its XML
 * declaration names (UTF-8 when it names none). A declaration naming an encoding in which those
 * bytes could mean something else is refused (XmlError), as is one too long to read.
 */
export function decodeXml(bytes) {
  if (typeof bytes === 'string') return bytes;
  const n = bytes.length;
  const start = n >= 4 ? ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0 : -1;
  if (start === 0x0000feff) return utf32(bytes, true, 4);
  if (start === 0xfffe0000) return utf32(bytes, false, 4);
  if (start === 0x0000003c) return utf32(bytes, true, 0);
  if (start === 0x3c000000) return utf32(bytes, false, 0);
  if (start === 0x003c003f) return new TextDecoder('utf-16be').decode(bytes);
  if (start === 0x3c003f00) return new TextDecoder('utf-16le').decode(bytes);
  if (start >= 0 && start >>> 16 === 0xfeff) return new TextDecoder('utf-16be').decode(bytes);
  if (start >= 0 && start >>> 16 === 0xfffe) return new TextDecoder('utf-16le').decode(bytes);
  if (start >= 0 && start >>> 8 === 0xefbbbf) return new TextDecoder('utf-8').decode(bytes);
  let label = 'utf-8';
  if (start === 0x3c3f786d) {
    // "<?xm": the parser reads the encoding the declaration names.
    let end = -1;
    for (let i = 0; i < Math.min(n, MAX_DECLARATION + 1); i++) {
      if (bytes[i] === GT) { end = i; break; }
    }
    if (end < 0 && n > MAX_DECLARATION) throw new XmlError('Office part with an XML declaration too long to read');
    if (end >= 0) {
      let declaration = '';
      for (let i = 0; i <= end; i++) declaration += String.fromCharCode(bytes[i]);
      label = encodingLabel(declaration);
    }
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    throw new XmlError(`Office part in an encoding that can't be read (${label})`);
  }
}

/** The TextDecoder label for the encoding a declaration names; refuses one that isn't 8-bit. */
function encodingLabel(declaration) {
  let at = declaration.indexOf('encoding');
  if (at < 0) return 'utf-8';
  while (at < declaration.length && declaration[at] !== '"' && declaration[at] !== "'") at++;
  // Without a quoted name the parser fails on the declaration itself.
  if (at >= declaration.length) return 'utf-8';
  const end = declaration.indexOf(declaration[at], at + 1);
  if (end < 0) return 'utf-8';
  const name = declaration.slice(at + 1, end);
  if (!EIGHT_BIT.test(name)) throw new XmlError("Office part in an encoding Office doesn't write");
  const lower = name.toLowerCase();
  if (/^utf-?8$/.test(lower)) return 'utf-8';
  if (/ascii$/.test(lower) || /^latin-?1$/.test(lower)) return 'windows-1252';
  const iso = /^iso[-_]?8859[-_](\d+)$/.exec(lower);
  if (iso) return `iso-8859-${Number(iso[1])}`;
  const win = /^(?:windows|cp)-?125(\d)$/.exec(lower);
  return `windows-125${win[1]}`;
}

function utf32(bytes, bigEndian, skip) {
  const parts = [];
  let chunk = [];
  for (let i = skip; i + 3 < bytes.length; i += 4) {
    const cp = bigEndian
      ? ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0
      : ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0;
    chunk.push(cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp);
    if (chunk.length >= 8192) {
      parts.push(String.fromCodePoint(...chunk));
      chunk = [];
    }
  }
  if (chunk.length) parts.push(String.fromCodePoint(...chunk));
  return parts.join('');
}
