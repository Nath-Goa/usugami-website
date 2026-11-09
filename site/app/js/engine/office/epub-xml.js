// XML as e-books write it, read forgivingly, one event at a time: the app's LenientXml (EpubBook.kt)
// over Android's XmlPullParser in its relaxed mode. HTML's named characters (&nbsp;, &eacute;...)
// are known, mismatched or unclosed tags are tolerated, attributes may be unquoted or have no value,
// and the DOCTYPE is dropped before parsing, so nothing it declares can expand. Namespaces aren't
// processed: elements and attributes are matched by their local names (localName(), attr()).
//
// The browser's DOMParser is no use here: it refuses a whole chapter for one stray "&", where the
// app reads on, and it can't be paused or stopped. This reads the bytes a megabyte at a time, so a
// long chapter never has to be one string, and the readers above it pause and check for
// cancelling between events.
import { XmlPrefix, HtmlEntities } from './epub-formats.js';

export const END_DOCUMENT = 1;
export const START_TAG = 2;
export const END_TAG = 3;
export const TEXT = 4;

/** Bytes looked at for the character set, and characters for the DOCTYPE and root element (LenientXml.HEAD). */
const HEAD = 8192;

/** Bytes decoded at a time. */
const CHUNK = 1 << 20;

/** What was read is dropped from the buffer once this much of it has been. */
const COMPACT = 1 << 20;

/** Text comes in parts of about this many characters at most, however long it runs between tags. */
const TEXT_PART = 1 << 16;

/** No tag is longer: a crafted one, megabytes of attributes, ends the document instead. */
const MAX_TAG = 1 << 20;

/** A document that can't be read further (the app's IOException or XmlPullParserException). */
export class XmlReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlReadError';
  }
}

const isSpaceCode = (c) => c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x0c;
const isNameStart = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0x3a || c >= 0x80;

const REFERENCE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z_:][A-Za-z0-9._:-]*);/g;

/**
 * `raw` with its character references replaced: numeric ones, XML's five and HTML's named ones.
 * Unknown names, and an "&" that starts none ("Tom & Jerry"), stay as written, as the relaxed parser
 * keeps them.
 */
export function decodeReferences(raw) {
  if (!raw.includes('&')) return raw;
  const all = HtmlEntities.all;
  return raw.replace(REFERENCE, (match, ref) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const digits = ref.slice(hex ? 2 : 1);
      const cp = digits.length > 8 ? NaN : parseInt(digits, hex ? 16 : 10);
      if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    return all.get(ref) ?? match;
  });
}

/**
 * A pull parser over `bytes` (a Uint8Array), as LenientXml.parser makes one: next() moves to the
 * next event and returns its type (START_TAG, END_TAG, TEXT, END_DOCUMENT); then `name`, `attrs`
 * ([[name, value], ...]), `text` and `depth` describe it, as XmlPullParser's getters do. Text is
 * coalesced across references, CDATA, comments and processing instructions. An element written
 * <x/> gives a START_TAG and an END_TAG. Depth counts as the app's parser counts it: every start
 * tag opens a level (HTML-style <br> too), every end tag closes one, whatever its name, and an end
 * tag with nothing open is skipped.
 *
 * The constructor throws XmlReadError when no root element starts in the first 8,192 characters,
 * or a DOCTYPE there doesn't end; next() throws it for a document broken beyond what is forgiven
 * (a tag, comment or CDATA section the file ends inside).
 */
export class LenientXml {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
    const head = this.bytes.subarray(0, HEAD);
    const charset = XmlPrefix.charset(head, head.length);
    try {
      this.decoder = new TextDecoder(charset);
    } catch {
      this.decoder = new TextDecoder('utf-8');
    }
    this.offset = 0;
    this.decoded = false;
    this.buf = '';
    this.pos = 0;
    while (this.buf.length <= HEAD && this.fill());
    let start = this.buf;
    if (start.charCodeAt(0) === 0xfeff) start = start.slice(1);
    const prefix = XmlPrefix.stripDoctype(start.slice(0, HEAD));
    if (prefix == null) throw new XmlReadError('No root element near the start, or an unfinished DOCTYPE');
    this.buf = prefix + start.slice(HEAD);
    this.level = 0;
    this.pendingEnd = null;
    this.type = 0;
    this.name = null;
    this.attrs = null;
    this.text = null;
    this.depth = 0;
  }

  /** The element's name without its prefix ("dc:title" is "title"). */
  localName() {
    const n = this.name ?? '';
    const colon = n.indexOf(':');
    return colon >= 0 ? n.slice(colon + 1) : n;
  }

  /** An attribute by its local name, whatever its prefix (href and xlink:href alike); null when it has none. */
  attr(local) {
    const attrs = this.attrs;
    if (!attrs) return null;
    const suffix = ':' + local;
    for (const [name, value] of attrs) if (name === local || name.endsWith(suffix)) return value;
    return null;
  }

  /** Decodes more of the bytes onto the buffer; false when there are none left. */
  fill() {
    if (this.decoded) return false;
    const end = Math.min(this.bytes.length, this.offset + CHUNK);
    const last = end >= this.bytes.length;
    this.buf += this.decoder.decode(this.bytes.subarray(this.offset, end), { stream: !last });
    this.offset = end;
    if (last) this.decoded = true;
    return true;
  }

  /** The character code at `i` in the buffer, decoding more as needed; -1 past the end of the file. */
  code(i) {
    while (i >= this.buf.length) if (!this.fill()) return -1;
    return this.buf.charCodeAt(i);
  }

  startsWith(s) {
    if (this.code(this.pos + s.length - 1) < 0) return false;
    return this.buf.startsWith(s, this.pos);
  }

  /** Where `delim` starts at or after `from`, decoding more as needed; -1 when the file ends first. */
  find(delim, from) {
    let at = this.buf.indexOf(delim, from);
    while (at < 0) {
      const searched = Math.max(from, this.buf.length - delim.length + 1);
      if (!this.fill()) return -1;
      at = this.buf.indexOf(delim, searched);
    }
    return at;
  }

  set(type, name, attrs, text, depth) {
    this.type = type;
    this.name = name;
    this.attrs = attrs;
    this.text = text;
    this.depth = depth;
    return type;
  }

  /** Moves to the next event and returns its type. */
  next() {
    if (this.pendingEnd != null) {
      const name = this.pendingEnd;
      this.pendingEnd = null;
      return this.set(END_TAG, name, null, null, this.level--);
    }
    let text = null;
    const textEvent = () => this.set(TEXT, null, null, text, this.level);
    for (;;) {
      if (this.pos > COMPACT) {
        this.buf = this.buf.slice(this.pos);
        this.pos = 0;
      }
      const c = this.code(this.pos);
      if (c < 0) return text != null ? textEvent() : this.set(END_DOCUMENT, null, null, null, 0);
      if (c !== 0x3c) {
        text = (text ?? '') + this.readText();
        if (text.length >= TEXT_PART) return textEvent();
        continue;
      }
      const c1 = this.code(this.pos + 1);
      if (c1 === 0x21) {
        if (this.startsWith('<!--')) {
          this.skipPast('-->', 4);
        } else if (this.startsWith('<![CDATA[')) {
          text = (text ?? '') + this.readUntil(']]>', 9);
          if (text.length >= TEXT_PART) return textEvent();
        } else {
          this.skipDeclaration();
        }
        continue;
      }
      if (c1 === 0x3f) {
        this.skipPast('?>', 2);
        continue;
      }
      if (c1 === 0x2f) {
        if (text != null) return textEvent();
        const name = this.readEndTag();
        // An end tag with nothing open (or no name) is left out.
        if (name === '' || this.level === 0) continue;
        return this.set(END_TAG, name, null, null, this.level--);
      }
      if (isNameStart(c1)) {
        if (text != null) return textEvent();
        return this.readStartTag();
      }
      // A "<" that starts no markup is text.
      text = (text ?? '') + '<';
      this.pos++;
    }
  }

  /** Text up to the next "<" (or a part of a long run of it), its references replaced. */
  readText() {
    let end = this.buf.indexOf('<', this.pos);
    while (end < 0 && this.buf.length - this.pos < TEXT_PART && this.fill()) end = this.buf.indexOf('<', this.pos);
    if (end < 0) {
      end = this.buf.length;
      if (!this.decoded) {
        // A part ends without cutting a reference, a character in two or a CR LF line break.
        const amp = this.buf.lastIndexOf('&', end - 1);
        if (amp > this.pos && end - amp < 48 && !this.buf.slice(amp, end).includes(';')) end = amp;
        const last = this.buf.charCodeAt(end - 1);
        if (end - 1 > this.pos && ((last >= 0xd800 && last <= 0xdbff) || last === 0x0d)) end--;
      }
    }
    const raw = this.buf.slice(this.pos, end);
    this.pos = end;
    return decodeReferences(raw);
  }

  skipPast(delim, from) {
    const at = this.find(delim, this.pos + from);
    if (at < 0) throw new XmlReadError(`Unexpected end of file before ${delim}`);
    this.pos = at + delim.length;
  }

  readUntil(delim, from) {
    const at = this.find(delim, this.pos + from);
    if (at < 0) throw new XmlReadError(`Unexpected end of file before ${delim}`);
    const out = this.buf.slice(this.pos + from, at);
    this.pos = at + delim.length;
    return out;
  }

  /** A DOCTYPE (after the start) or other declaration, skipped to its ">", brackets and quotes minded. */
  skipDeclaration() {
    let i = this.pos + 2;
    let quote = 0;
    let depth = 0;
    for (;;) {
      const c = this.code(i);
      if (c < 0) throw new XmlReadError('Unexpected end of file in a declaration');
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) quote = c;
      else if (c === 0x5b) depth++;
      else if (c === 0x5d) depth = Math.max(0, depth - 1);
      else if (c === 0x3e && depth === 0) break;
      i++;
      if (i - this.pos > MAX_TAG * 8) throw new XmlReadError('Declaration too long');
    }
    this.pos = i + 1;
  }

  readEndTag() {
    let i = this.pos + 2;
    const start = i;
    let c;
    while ((c = this.code(i)) >= 0 && !isSpaceCode(c) && c !== 0x3e) {
      i++;
      if (i - this.pos > MAX_TAG) throw new XmlReadError('Tag too long');
    }
    const name = this.buf.slice(start, i);
    while ((c = this.code(i)) >= 0 && c !== 0x3e) {
      i++;
      if (i - this.pos > MAX_TAG) throw new XmlReadError('Tag too long');
    }
    if (c < 0) throw new XmlReadError('Unexpected end of file in an end tag');
    this.pos = i + 1;
    return name;
  }

  readStartTag() {
    const from = this.pos;
    const tooLong = (i) => {
      if (i - from > MAX_TAG) throw new XmlReadError('Tag too long');
    };
    let i = from + 1;
    let c;
    while ((c = this.code(i)) >= 0 && !isSpaceCode(c) && c !== 0x2f && c !== 0x3e) {
      i++;
      tooLong(i);
    }
    const name = this.buf.slice(from + 1, i);
    const attrs = [];
    let selfClosing = false;
    for (;;) {
      while (isSpaceCode((c = this.code(i)))) i++;
      if (c < 0) throw new XmlReadError('Unexpected end of file in a tag');
      if (c === 0x3e) {
        i++;
        break;
      }
      if (c === 0x2f) {
        if (this.code(i + 1) === 0x3e) {
          selfClosing = true;
          i += 2;
          break;
        }
        i++;
        continue;
      }
      const nameStart = i;
      while ((c = this.code(i)) >= 0 && !isSpaceCode(c) && c !== 0x3d && c !== 0x3e && !(c === 0x2f && this.code(i + 1) === 0x3e)) {
        i++;
        tooLong(i);
      }
      const attrName = this.buf.slice(nameStart, i);
      while (isSpaceCode((c = this.code(i)))) i++;
      let value;
      if (c === 0x3d) {
        i++;
        while (isSpaceCode((c = this.code(i)))) i++;
        if (c === 0x22 || c === 0x27) {
          const quote = c;
          const valueStart = ++i;
          while ((c = this.code(i)) >= 0 && c !== quote) {
            i++;
            tooLong(i);
          }
          if (c < 0) throw new XmlReadError('Unexpected end of file in an attribute');
          value = this.buf.slice(valueStart, i);
          i++;
        } else {
          // Unquoted, as the relaxed parser takes it: up to white space or the tag's end.
          const valueStart = i;
          while ((c = this.code(i)) >= 0 && !isSpaceCode(c) && c !== 0x3e) {
            i++;
            tooLong(i);
          }
          value = this.buf.slice(valueStart, i);
        }
        value = decodeReferences(value.replace(/[\t\n\r]/g, ' '));
      } else {
        // An attribute without a value (<nav hidden>) has its own name as its value.
        value = attrName;
      }
      if (attrName) attrs.push([attrName, value]);
      tooLong(i);
    }
    this.pos = i;
    this.level++;
    if (selfClosing) this.pendingEnd = name;
    return this.set(START_TAG, name, attrs, null, this.level);
  }
}

/**
 * A LenientXml over `bytes`, or null when it can't start (no root element near the start, or an
 * unfinished DOCTYPE): LenientXml.parser's IOException.
 */
export function lenientXml(bytes) {
  try {
    return new LenientXml(bytes);
  } catch (e) {
    if (e instanceof XmlReadError) return null;
    throw e;
  }
}
