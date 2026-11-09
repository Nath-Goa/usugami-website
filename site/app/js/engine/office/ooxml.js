// Office Open XML files (.docx, .pptx, .xlsx): a zip of XML parts linked by relationships, read as
// the app's Ooxml.kt reads them. Parts are checked by the guard (xml-guard.js) and then parsed by
// the browser's DOMParser; elements are matched by their local name and vocabulary (Ns), whatever
// prefix the file uses, with the transitional and the strict namespaces both understood.
import { ZipArchive } from './zip.js';
import { decodeXml, guardXml, guardXmlAsync, XmlTokenGuard, XmlError, MAX_RUN } from './xml-guard.js';
import { OfficeUnits, OfficeFileType, OfficeContainer } from './office-formats.js';
import { OfficeEncrypted, OfficeLegacyFormat, OfficeNotRecognized } from './problems.js';
import { trim, toIntOrNull, toDoubleOrNull, toInt } from './xlsx-numbers-kt.js';
import { checkCancelled } from '../../core/errors.js';

export { XmlError } from './xml-guard.js';

// ---------------------------------------------------------------------------------------------
// Vocabularies

/** Which vocabulary an element comes from. Element names repeat between them (w:p, a:p, p:sp...). */
export const Ns = Object.freeze({
  WORD: 'WORD',
  DRAWING: 'DRAWING',
  SLIDE: 'SLIDE',
  WORD_DRAWING: 'WORD_DRAWING',
  PICTURE: 'PICTURE',
  COMPATIBILITY: 'COMPATIBILITY',
  MATH: 'MATH',
  VML: 'VML',
  SHEET: 'SHEET',
  OTHER: 'OTHER',
});

const known = new Map();

/** The vocabulary of a namespace URI. */
export function namespaceOf(uri) {
  if (!uri) return Ns.OTHER;
  let ns = known.get(uri);
  if (ns) return ns;
  if (uri.endsWith('/wordprocessingml/2006/main') || uri.endsWith('/ooxml/wordprocessingml/main')) ns = Ns.WORD;
  else if (uri.endsWith('/drawingml/2006/main') || uri.endsWith('/ooxml/drawingml/main')) ns = Ns.DRAWING;
  else if (uri.endsWith('/presentationml/2006/main') || uri.endsWith('/ooxml/presentationml/main')) ns = Ns.SLIDE;
  else if (uri.endsWith('wordprocessingDrawing')) ns = Ns.WORD_DRAWING;
  else if (uri.endsWith('/drawingml/2006/picture') || uri.endsWith('/ooxml/drawingml/picture')) ns = Ns.PICTURE;
  else if (uri.endsWith('/markup-compatibility/2006')) ns = Ns.COMPATIBILITY;
  else if (uri.endsWith('/officeDocument/2006/math') || uri.endsWith('/ooxml/officeDocument/math')) ns = Ns.MATH;
  else if (uri === 'urn:schemas-microsoft-com:vml') ns = Ns.VML;
  else if (uri.endsWith('/spreadsheetml/2006/main') || uri.endsWith('/ooxml/spreadsheetml/main')) ns = Ns.SHEET;
  else ns = Ns.OTHER;
  if (known.size < 1000) known.set(uri, ns);
  return ns;
}

// ---------------------------------------------------------------------------------------------
// Elements

const XMLNS = 'http://www.w3.org/2000/xmlns/';
const LONG_MAX = 9223372036854775807;

/** Kotlin's String.toLongOrNull (as a JavaScript number, exact up to 2^53). */
function toLongOrNull(s) {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Math.abs(n) > LONG_MAX ? null : n;
}

/** Kotlin's Double.toLong(): towards zero, NaN as 0, held to 64 bits. */
function toLong(x) {
  if (Number.isNaN(x)) return 0;
  if (x >= LONG_MAX) return LONG_MAX;
  if (x <= -LONG_MAX) return -LONG_MAX;
  return Math.trunc(x) || 0;
}

/**
 * An element of a part, as the app's OfficeXml reads it: its local `name`, its vocabulary `ns`,
 * attributes by local name, and its children. `el` is the DOM element (for speed in large parts).
 */
export class XmlNode {
  constructor(el, depth = 1) {
    this.el = el;
    this.depth = depth;
  }

  /** The element's local name ("p" for w:p). */
  get name() {
    return this.el.localName;
  }

  get uri() {
    return this.el.namespaceURI ?? '';
  }

  get ns() {
    return namespaceOf(this.el.namespaceURI);
  }

  /** Whether this is the element `name` (of vocabulary `ns`, when given). */
  is(name, ns) {
    return this.el.localName === name && (ns == null || namespaceOf(this.el.namespaceURI) === ns);
  }

  /** An attribute's value by its local name, whatever its prefix (namespace declarations aside); null when missing. */
  attr(local) {
    const attrs = this.el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.localName === local && a.namespaceURI !== XMLNS) return a.value;
    }
    return null;
  }

  /** A relationship id attribute (r:id, r:embed...): only one in the relationships namespace counts. */
  relId(local = 'id') {
    const attrs = this.el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.localName === local && (a.namespaceURI ?? '').includes('relationships')) return a.value;
    }
    return null;
  }

  /** A whole-number attribute (a decimal one cut towards zero), or null. */
  intAttr(local) {
    const v = this.attr(local);
    if (v == null) return null;
    const t = trim(v);
    const i = toIntOrNull(t);
    if (i != null) return i;
    const d = toDoubleOrNull(t);
    return d == null ? null : toInt(d);
  }

  /** As intAttr, for numbers past 32 bits (EMUs). */
  longAttr(local) {
    const v = this.attr(local);
    if (v == null) return null;
    const t = trim(v);
    const i = toLongOrNull(t);
    if (i != null) return i;
    const d = toDoubleOrNull(t);
    return d == null ? null : toLong(d);
  }

  /** A number attribute as Kotlin's toFloatOrNull reads it, or null. */
  floatAttr(local) {
    const v = this.attr(local);
    if (v == null) return null;
    const d = toDoubleOrNull(v);
    return d == null ? null : Math.fround(d);
  }

  /** A percentage attribute in thousandths of a percent, also as Strict Open XML writes it ("90%"). */
  percentAttr(local) {
    return OfficeUnits.percentage(this.attr(local));
  }

  /**
   * An on/off property such as w:b: on unless its value says otherwise ("0", "false", "off",
   * "none"). Missing from the element altogether means `missing`.
   */
  flag(local = 'val', missing = true) {
    const v = this.attr(local);
    if (v == null) return missing;
    switch (trim(v).toLowerCase()) {
      case '0': case 'false': case 'off': case 'none': return false;
      default: return true;
    }
  }

  /** The child elements, in order; only those named `name` when given. */
  children(name) {
    const out = [];
    const d = this.depth + 1;
    for (let c = this.el.firstElementChild; c; c = c.nextElementSibling) {
      if (name == null || c.localName === name) out.push(new XmlNode(c, d));
    }
    return out;
  }

  /** The first child element named `name` (of vocabulary `ns`, when given), or null. */
  child(name, ns) {
    for (let c = this.el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === name && (ns == null || namespaceOf(c.namespaceURI) === ns)) return new XmlNode(c, this.depth + 1);
    }
    return null;
  }

  /**
   * Calls `enter(node)` at each element inside this one, in document order, going on into an
   * element's own children only when `enter` returns true for it (return false, or nothing, for an
   * element read already or to be skipped). Uses no more stack however deep it goes.
   */
  descendants(enter) {
    const stack = [];
    let c = this.el.firstElementChild;
    let depth = this.depth + 1;
    while (c || stack.length) {
      if (!c) {
        [c, depth] = stack.pop();
        continue;
      }
      const into = enter(new XmlNode(c, depth)) === true && c.firstElementChild;
      if (into) {
        stack.push([c.nextElementSibling, depth]);
        c = c.firstElementChild;
        depth++;
      } else {
        c = c.nextElementSibling;
      }
    }
  }

  /** The text directly inside this element (such as w:t's), CDATA included, not its children's. */
  text() {
    let out = '';
    for (let n = this.el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || n.nodeType === 4) out += n.nodeValue;
    }
    return out;
  }

  /** All the text inside this element, its children's too. */
  allText() {
    return this.el.textContent ?? '';
  }

  /** The parent element, or null at the root. */
  get parent() {
    const p = this.el.parentElement;
    return p ? new XmlNode(p, this.depth - 1) : null;
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing

function parseChecked(text) {
  if (typeof DOMParser === 'undefined') throw new Error('Reading Office files needs a page (DOMParser)');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root) throw new XmlError('Empty Office part');
  // Chrome and Safari put a parsererror element into the document, Firefox makes it the root.
  if (root.localName === 'parsererror' || doc.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'parsererror').length) {
    throw new XmlError("Office part that isn't well-formed XML");
  }
  return new XmlNode(root, 1);
}

/**
 * Parses one part (its bytes, or text) after the guard's checks, and returns its root element.
 * `doctype`: 'refuse' (the default, as for Office parts) or 'remove' (a DOCTYPE is left out
 * unread). Throws XmlError for a part that is refused or isn't well-formed.
 */
export function parseXml(input, { doctype } = {}) {
  return parseChecked(guardXml(decodeXml(input), { doctype }));
}

/** As parseXml, pausing while a large part is checked, and stopping when `signal` is aborted. */
export async function parseXmlAsync(input, { doctype, signal } = {}) {
  const text = await guardXmlAsync(decodeXml(input), { doctype, signal });
  checkCancelled(signal);
  return parseChecked(text);
}

/**
 * The root element of a part, read from its start only: { name, ns, uri }. Throws XmlError when
 * the start is refused (a DOCTYPE, say) or holds no element. `more(n)` gives the part's first `n`
 * bytes (all of it when shorter), and is asked again for more when the root's tag is long.
 */
export async function rootElementOf(more) {
  for (let n = 64 * 1024; ; n *= 4) {
    const head = await more(n);
    if (head == null) return null;
    const complete = head.length < n;
    const text = decodeXml(head);
    const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const guard = new XmlTokenGuard();
    guard.feed(t);
    if (guard.rootEnd >= 0) {
      let tag = t.slice(guard.rootStart, guard.rootEnd);
      if (!tag.endsWith('/>')) tag = `${tag.slice(0, -1)}/>`;
      const root = parseChecked(tag);
      return { name: root.name, ns: root.ns, uri: root.uri };
    }
    if (complete || n > MAX_RUN) throw new XmlError('Empty Office part');
  }
}

// ---------------------------------------------------------------------------------------------
// Packages

/**
 * The most an XML part may inflate to before it is parsed. The browser's document of a part takes
 * several times its size in memory, so a phone (a device saying it has 4 GB or less) parses less.
 */
export const MAX_XML_BYTES = (() => {
  const memory = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  return memory && memory <= 4 ? 64 * 1024 * 1024 : 160 * 1024 * 1024;
})();

/** A relationship: its `type` URI, its `target` (a part path inside the package, or a URL), `external`. */
export class Relationship {
  constructor(type, target, external) {
    this.type = type;
    this.target = target;
    this.external = external;
  }
}

/** A relationship target resolved against the folder `dir` of the part it's from. */
function resolve(dir, target) {
  const segments = [];
  if (!target.startsWith('/')) segments.push(...dir.split('/').filter((s) => s));
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length) segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

/**
 * An Office Open XML file: a zip of XML parts, linked by relationships. Only read, never extracted.
 * Part names are case-insensitive, as in OOXML. Reading can be stopped through `signal`.
 */
export class OfficePackage {
  /**
   * Opens the zip in `bytes`. Throws ZipError when it can't be read as one. `limits`: those of
   * ZipArchive.open, and `xmlBytes` (at most MAX_XML_BYTES) for each XML part.
   */
  static async open(bytes, { signal, limits } = {}) {
    checkCancelled(signal);
    return new OfficePackage(ZipArchive.open(bytes, { limits }), { signal, xmlBytes: limits?.xmlBytes });
  }

  constructor(zip, { signal, xmlBytes } = {}) {
    this.zip = zip;
    this.signal = signal;
    this.xmlBytes = Math.min(MAX_XML_BYTES, xmlBytes ?? MAX_XML_BYTES);
    this.rels = new Map();
  }

  has(path) {
    return this.zip.has(path);
  }

  /** The bytes of part `path`, or null when there's no such part. */
  bytes(path) {
    return this.zip.bytes(path, { signal: this.signal });
  }

  bytesSync(path) {
    return this.zip.bytesSync(path);
  }

  /**
   * The root element of part `path`, or null when there's no such part. Throws XmlError, and
   * ZipError ('too-large' past MAX_XML_BYTES).
   */
  async xml(path) {
    const b = await this.zip.bytes(path, { signal: this.signal, limit: this.xmlBytes });
    if (b == null) return null;
    return parseXmlAsync(b, { signal: this.signal });
  }

  /** As xml(), without pausing: for the small parts. */
  xmlSync(path) {
    const b = this.zip.bytesSync(path, { limit: this.xmlBytes });
    if (b == null) return null;
    return parseXml(b);
  }

  /** The root element's name and vocabulary of part `path`, from its start only, or null without the part. */
  async root(path) {
    if (!this.zip.has(path)) return null;
    return rootElementOf((n) => this.zip.bytes(path, { signal: this.signal, maxBytes: n }));
  }

  /** The relationships of `part` (such as "word/document.xml"; "" for the package's own), by id. */
  relationships(part) {
    const key = part.toLowerCase();
    const cached = this.rels.get(key);
    if (cached) return cached;
    const slash = part.lastIndexOf('/');
    const dir = slash < 0 ? '' : part.slice(0, slash);
    const relsPath = `${dir ? `${dir}/` : ''}_rels/${part.slice(slash + 1)}.rels`;
    const found = new Map();
    const x = this.xmlSync(relsPath);
    if (x) {
      for (const c of x.children('Relationship')) {
        checkCancelled(this.signal);
        const id = c.attr('Id');
        const target = c.attr('Target');
        if (id != null && target != null) {
          const external = c.attr('TargetMode') === 'External';
          found.set(id, new Relationship(c.attr('Type') ?? '', external ? target : resolve(dir, target), external));
        }
      }
    }
    this.rels.set(key, found);
    return found;
  }

  /** The part relationship `id` of `part` points to, if it is inside the package; else null. */
  target(part, id) {
    if (id == null) return null;
    const r = this.relationships(part).get(id);
    return r && !r.external ? r.target : null;
  }

  /** The first part `part` links to with a relationship type ending in `typeSuffix`, such as "/slideLayout". */
  targetOfType(part, typeSuffix) {
    for (const r of this.relationships(part).values()) if (!r.external && r.type.endsWith(typeSuffix)) return r.target;
    return null;
  }

  /** The document's main part ("word/document.xml", "ppt/presentation.xml", "xl/workbook.xml"), from the package relationships. */
  mainPart() {
    return this.targetOfType('', '/officeDocument');
  }

  close() {
    this.zip.close();
    this.rels.clear();
  }
}

/** The root element each kind's main part has. */
const MAIN_ROOT = {
  word: ['document', Ns.WORD],
  powerpoint: ['presentation', Ns.SLIDE],
  excel: ['workbook', Ns.SHEET],
};

/**
 * Throws an OfficeFileProblem unless `bytes` is a `kind` file ('word', 'powerpoint' or 'excel')
 * that can be converted, as OfficeConverter.verify checks it: an old binary file or a
 * password-protected one gets its own problem; anything else that isn't that kind's zip with that
 * kind's main part is OfficeNotRecognized. Only the start of the main part is read.
 */
export async function verifyOfficePackage(bytes, kind, { signal } = {}) {
  if (!bytes || bytes.length < 8) throw new OfficeNotRecognized();
  const container = OfficeFileType.container(bytes.subarray(0, 8));
  if (container === OfficeContainer.COMPOUND) throw OfficeFileType.isEncryptedPackage(bytes) ? new OfficeEncrypted() : new OfficeLegacyFormat();
  if (container === OfficeContainer.OTHER) throw new OfficeNotRecognized();
  const [name, ns] = MAIN_ROOT[kind] ?? [];
  let matches = false;
  try {
    const pkg = await OfficePackage.open(bytes, { signal });
    const main = pkg.mainPart();
    const root = main ? await pkg.root(main) : null;
    matches = root != null && root.name === name && root.ns === ns;
  } catch (e) {
    if (e?.name === 'CancelledError') throw e;
    matches = false;
  }
  if (!matches) throw new OfficeNotRecognized();
}
