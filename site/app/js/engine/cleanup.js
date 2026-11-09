// Making pages that leave a PDF really gone (the app's PageCleanup.kt and XObjectCleanup.kt).
//
// Pages taken out of a document can still be reached through bookmarks, links, named destinations,
// form fields and the tags of an accessible PDF, and everything that can be reached is saved. A
// deleted page, with its text and pictures, would then still be inside the file. This cuts those
// links. Pictures only removed pages drew are emptied, since pages that stay may still list them
// (pages often share one list of resources), and the tags of what was on removed pages go.
//
// It also holds what the organize tools share: reading the page tree as viewers do, laying pages
// out again, and copying objects from one PDF into another without what must stay behind.
import {
  PDFArray, PDFDict, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFRawStream,
  PDFString, PDFHexString, PDFPageLeaf, decodePDFRawStream,
} from '../lib/pdf-lib.js';
import { Inflate, Unzlib } from '../lib/fflate.js';
import { checkCancelled, UserError } from '../core/errors.js';

// ---------------------------------------------------------------------------------------------
// Small helpers over pdf-lib's objects

const names = new Map();
/** PDFName.of, kept: the same few names are looked up very often. */
export function nm(text) {
  let name = names.get(text);
  if (!name) names.set(text, (name = PDFName.of(text)));
  return name;
}

/** Bookmarks, fields, tags and forms nest; a damaged file could make them loop or nest without end. */
export const MAX_DEPTH = 64;

/** `value` itself, or the object it refers to. */
export function resolve(ctx, value) {
  return value instanceof PDFRef ? ctx.lookup(value) : value;
}

export function dictOf(ctx, value) {
  const v = resolve(ctx, value);
  return v instanceof PDFDict ? v : undefined;
}

export function arrayOf(ctx, value) {
  const v = resolve(ctx, value);
  return v instanceof PDFArray ? v : undefined;
}

export function streamOf(ctx, value) {
  const v = resolve(ctx, value);
  return v instanceof PDFStream ? v : undefined;
}

export function nameOf(ctx, value) {
  const v = resolve(ctx, value);
  return v instanceof PDFName ? v : undefined;
}

export function numberOf(ctx, value) {
  const v = resolve(ctx, value);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

/** A string, hex string or name as text, or undefined. */
export function textOf(ctx, value) {
  const v = resolve(ctx, value);
  try {
    if (v instanceof PDFString || v instanceof PDFHexString || v instanceof PDFName) return v.decodeText();
  } catch {
    // Text that can't be decoded is as good as none.
  }
  return undefined;
}

/** A dictionary, or a stream's dictionary. */
function entriesHolder(value) {
  if (value instanceof PDFDict) return value;
  if (value instanceof PDFStream) return value.dict;
  return undefined;
}

const isName = (ctx, value, text) => nameOf(ctx, value) === nm(text);

/**
 * The document's catalog (its root dictionary). pdf-lib opens a file that has none, or something
 * else in its place ('%PDF-1.4' and nothing more, a /Root that isn't a dictionary), and leaves
 * `doc.catalog` undefined or not a dictionary: such a file can't be read as a PDF, so this throws
 * UserError('pdf_import_failed') rather than let a TypeError reach the screen.
 */
export function catalogOf(doc) {
  const catalog = doc?.catalog;
  if (!(catalog instanceof PDFDict)) throw new UserError('pdf_import_failed');
  return catalog;
}

/**
 * A loop that checks for cancelling and lets the browser draw now and then (every 30 ms of work).
 * A timer, not core/dom.js's yieldToUI(): Chromium's scheduler.yield() runs the work on ahead of
 * drawing, and yielding this often with it left Split's progress undrawn on a long PDF.
 */
export function ticker(signal) {
  let last = performance.now();
  return async () => {
    checkCancelled(signal);
    if (performance.now() - last > 30) {
      await new Promise((ok) => setTimeout(ok, 0));
      last = performance.now();
      checkCancelled(signal);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The page tree

const LETTER = [0, 0, 612, 792];

/**
 * The value of `key` for `page`, its own or inherited from the page tree above it (as stored: a
 * reference stays a reference). Each level is read once, so a tree leading back into itself ends.
 */
export function inherited(ctx, page, key) {
  const seen = new Set();
  let node = page;
  for (let depth = 0; node && depth <= MAX_DEPTH && !seen.has(node); depth++) {
    seen.add(node);
    const value = node.get(key);
    if (value !== undefined) return value;
    node = dictOf(ctx, node.get(nm('Parent')));
  }
  return undefined;
}

/** The page's resources, its own or inherited; undefined if it has none. */
export function resourcesOf(ctx, page) {
  return dictOf(ctx, inherited(ctx, page, nm('Resources')));
}

/** The page's turn as viewers read it: 0, 90, 180 or 270 (anything not a quarter turn is 0). */
export function rotationOf(ctx, page) {
  const value = numberOf(ctx, inherited(ctx, page, nm('Rotate')));
  if (value === undefined) return 0;
  const r = Math.trunc(value);
  return r % 90 === 0 ? ((r % 360) + 360) % 360 : 0;
}

/** A box ([x1 y1 x2 y2]) as numbers, lower left first; undefined if it isn't one. */
export function boxOf(ctx, value) {
  const array = arrayOf(ctx, value);
  if (!array || array.size() < 4) return undefined;
  const n = [0, 1, 2, 3].map((i) => numberOf(ctx, array.get(i)));
  if (n.some((v) => v === undefined || !Number.isFinite(v))) return undefined;
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

/** The page's media box (US Letter if it has none) and crop box (cut to the media box), as numbers. */
export function boxesOf(ctx, page) {
  const media = boxOf(ctx, inherited(ctx, page, nm('MediaBox'))) ?? LETTER;
  const asked = boxOf(ctx, inherited(ctx, page, nm('CropBox')));
  let crop = media;
  if (asked) {
    const c = [Math.max(asked[0], media[0]), Math.max(asked[1], media[1]), Math.min(asked[2], media[2]), Math.min(asked[3], media[3])];
    crop = c[2] > c[0] && c[3] > c[1] ? c : media;
  }
  return { media, crop };
}

/**
 * The pages of `doc` as viewers find them: walking the page tree, entering each part of it once,
 * and taking what ends each branch for a page (the app's repairPageTree). Returns
 * `{ pages: [{ ref, dict }], sound }`: `sound` is false when the tree miscounts, leads back into
 * itself, ends a branch with something other than a page, or its pages and parts don't name the
 * part that holds them; such a tree should be laid out again (`setPages`) before it is saved.
 */
export function readPages(doc) {
  const ctx = doc.context;
  const rootRaw = catalogOf(doc).get(nm('Pages'));
  const root = dictOf(ctx, rootRaw);
  if (!root) throw new UserError('pdf_import_failed');
  // A lone page in the tree's place, which is read as a tree holding it.
  if (isName(ctx, root.get(nm('Type')), 'Page')) {
    return { pages: [{ ref: rootRaw instanceof PDFRef ? rootRaw : null, dict: root }], sound: false };
  }
  const pages = [];
  const seen = new Set([root]);
  const sound = walkPageTree(ctx, root, seen, pages, 0);
  return { pages, sound };
}

function walkPageTree(ctx, node, seen, pages, depth) {
  // Only a crafted file nests its page tree this deep.
  if (depth > 512) throw new UserError('pdf_import_failed');
  const first = pages.length;
  let sound = true;
  const kids = arrayOf(ctx, node.get(nm('Kids')));
  for (let i = 0; kids && i < kids.size(); i++) {
    const raw = kids.get(i);
    const kid = dictOf(ctx, raw);
    if (!kid) continue;
    if (dictOf(ctx, kid.get(nm('Parent'))) !== node) sound = false;
    const type = nameOf(ctx, kid.get(nm('Type')));
    if (type === nm('Pages') || kid.has(nm('Kids'))) {
      // A part of the tree, as PDF libraries tell them from pages.
      if (seen.has(kid)) sound = false;
      else {
        seen.add(kid);
        if (!walkPageTree(ctx, kid, seen, pages, depth + 1)) sound = false;
      }
    } else if (type === undefined || type === nm('Page')) {
      pages.push({ ref: raw instanceof PDFRef ? raw : null, dict: kid });
    } else {
      sound = false;
    }
  }
  return sound && numberOf(ctx, node.get(nm('Count'))) === pages.length - first;
}

/**
 * Mends a page tree that libraries would read otherwise than viewers do (see readPages): a page
 * without its type gets it, and an unsound tree is laid out again flat with the pages found. Returns
 * `{ pages, changed }`, the pages as readPages gives them. Throws UserError('pdf_import_failed')
 * for a PDF without pages.
 */
export function repairPageTree(doc) {
  const { pages, sound } = readPages(doc);
  if (!pages.length) throw new UserError('pdf_import_failed');
  let changed = false;
  for (const { dict } of pages) {
    if (dict.has(nm('Type'))) continue;
    dict.set(nm('Type'), nm('Page'));
    changed = true;
  }
  if (!sound) {
    setPages(doc, pages);
    changed = true;
  }
  return { pages: readPages(doc).pages, changed };
}

/**
 * Gives `page` its own size, crop, turn and resources where it inherited them from the page tree,
 * which it would lose when moved: US Letter and empty resources if it has none at all.
 */
export function ownInherited(ctx, page) {
  const media = inherited(ctx, page, nm('MediaBox'));
  page.set(nm('MediaBox'), boxOf(ctx, media) ? media : ctx.obj(LETTER));
  const crop = inherited(ctx, page, nm('CropBox'));
  if (crop !== undefined && boxOf(ctx, crop)) page.set(nm('CropBox'), crop);
  if (inherited(ctx, page, nm('Rotate')) !== undefined) page.set(nm('Rotate'), PDFNumber.of(rotationOf(ctx, page)));
  if (!page.has(nm('Resources'))) {
    let resources = inherited(ctx, page, nm('Resources'));
    if (!(resources instanceof PDFRef) && !(resources instanceof PDFDict)) resources = PDFDict.withContext(ctx);
    page.set(nm('Resources'), resources);
  }
}

/**
 * Makes `pages` ([{ ref, dict }]) the document's pages, in order, all straight under the page
 * tree's root. Each first gets what it inherited where it was (ownInherited). A page listed twice
 * must be two objects; a page without a reference gets one.
 */
export function setPages(doc, pages) {
  const ctx = doc.context;
  // Resources inherited from a level of the tree held inline would be written out once per page.
  for (const { dict } of pages) {
    const holder = inheritedHolder(ctx, dict, nm('Resources'));
    if (holder && holder !== dict && holder.get(nm('Resources')) instanceof PDFDict) {
      holder.set(nm('Resources'), ctx.register(holder.get(nm('Resources'))));
    }
  }
  for (const { dict } of pages) ownInherited(ctx, dict);
  const catalog = catalogOf(doc);
  let rootRef = catalog.get(nm('Pages'));
  let root = dictOf(ctx, rootRef);
  if (!root || !isName(ctx, root.get(nm('Type')), 'Pages')) {
    // A lone page, or something else, in the tree's place: the pages get a proper root.
    root = PDFDict.withContext(ctx);
    root.set(nm('Type'), nm('Pages'));
    rootRef = undefined;
  }
  if (!(rootRef instanceof PDFRef)) {
    rootRef = ctx.register(root);
    catalog.set(nm('Pages'), rootRef);
  }
  const kids = PDFArray.withContext(ctx);
  for (const page of pages) {
    if (!page.ref) page.ref = ctx.register(page.dict);
    page.dict.set(nm('Parent'), rootRef);
    kids.push(page.ref);
  }
  root.set(nm('Kids'), kids);
  root.set(nm('Count'), PDFNumber.of(pages.length));
}

function inheritedHolder(ctx, page, key) {
  const seen = new Set();
  let node = page;
  for (let depth = 0; node && depth <= MAX_DEPTH && !seen.has(node); depth++) {
    seen.add(node);
    if (node.get(key) !== undefined) return node;
    node = dictOf(ctx, node.get(nm('Parent')));
  }
  return undefined;
}

/** The annotations on `page` (a page dictionary), added to `into`. */
export function annotationsOf(ctx, page, into) {
  const annotations = arrayOf(ctx, page.get(nm('Annots')));
  for (let i = 0; annotations && i < annotations.size(); i++) {
    const annotation = dictOf(ctx, annotations.get(i));
    if (annotation) into.add(annotation);
  }
  return into;
}

// ---------------------------------------------------------------------------------------------
// Name and number trees, and destinations

/**
 * Every [key, value] pair of the name tree (`entries` 'Names') or number tree ('Nums') at `node`,
 * values as stored. Each node is read once; a damaged one is skipped.
 */
export function treePairs(ctx, node, entries = 'Names') {
  const pairs = [];
  const seen = new Set();
  const visit = (value, depth) => {
    const dict = dictOf(ctx, value);
    if (!dict || depth > MAX_DEPTH || seen.has(dict)) return;
    seen.add(dict);
    const list = arrayOf(ctx, dict.get(nm(entries)));
    for (let i = 0; list && i + 1 < list.size(); i += 2) pairs.push([resolve(ctx, list.get(i)), list.get(i + 1)]);
    const kids = arrayOf(ctx, dict.get(nm('Kids')));
    for (let i = 0; kids && i < kids.size(); i++) visit(kids.get(i), depth + 1);
  };
  visit(node, 0);
  return pairs;
}

const destCache = new WeakMap();

/** The document's named destinations, by name: from its /Names /Dests tree, then its /Dests dictionary. */
function namedDestinations(doc) {
  let cached = destCache.get(doc);
  if (cached) return cached;
  const ctx = doc.context;
  const tree = new Map();
  const old = new Map();
  try {
    const namesDict = dictOf(ctx, catalogOf(doc).get(nm('Names')));
    for (const [key, value] of treePairs(ctx, namesDict?.get(nm('Dests')))) {
      const text = textOf(ctx, key);
      if (text !== undefined && !tree.has(text)) tree.set(text, value);
    }
    const dests = dictOf(ctx, catalogOf(doc).get(nm('Dests')));
    for (const [key, value] of dests ? dests.entries() : []) old.set(key.decodeText(), value);
  } catch {
    // A damaged entry among the names: those that can be read still count.
  }
  cached = { tree, old };
  destCache.set(doc, cached);
  return cached;
}

/**
 * The explicit destination ([page /XYZ ...], an array) that `dest` gives: itself, or what the name
 * it gives stands for. Undefined if it isn't one or can't be found.
 */
export function explicitDestination(doc, dest) {
  const ctx = doc.context;
  let value = resolve(ctx, dest);
  if (value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName) {
    const text = textOf(ctx, value);
    const { tree, old } = namedDestinations(doc);
    value = resolve(ctx, tree.get(text) ?? old.get(text));
  }
  if (value instanceof PDFDict) value = resolve(ctx, value.get(nm('D')));
  return value instanceof PDFArray && value.size() > 0 ? value : undefined;
}

/** Where `dict` (a link, a bookmark) leads: its /Dest, or its GoTo action's. Undefined if neither. */
export function destinationOf(ctx, dict) {
  const dest = dict.get(nm('Dest'));
  if (dest !== undefined) return dest;
  const action = dictOf(ctx, dict.get(nm('A')));
  if (action && isName(ctx, action.get(nm('S')), 'GoTo')) return action.get(nm('D'));
  return undefined;
}

/**
 * The page `dest` leads to, among `pages` (the document's, as readPages gives them): a page
 * dictionary, or undefined. A page number in place of the page, as some PDFs have, counts too.
 */
export function destinationPage(doc, pages, dest) {
  const array = explicitDestination(doc, dest);
  if (!array) return undefined;
  const first = resolve(doc.context, array.get(0));
  if (first instanceof PDFDict) return first;
  if (first instanceof PDFNumber) return pages[first.asNumber()]?.dict;
  return undefined;
}

/**
 * For copying a link, bookmark or action out of `doc`: a copy of `dict` whose destination by name is
 * the destination itself (the names don't come along, or would clash with another PDF's), or `dict`
 * itself when it has none.
 */
export function withExplicitDestination(doc, dict) {
  const ctx = doc.context;
  let key;
  if (dict.has(nm('Dest'))) key = nm('Dest');
  else if (dict.has(nm('D')) && isName(ctx, dict.get(nm('S')), 'GoTo')) key = nm('D');
  if (!key) return dict;
  const value = resolve(ctx, dict.get(key));
  if (!(value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName)) return dict;
  const explicit = explicitDestination(doc, value);
  if (!explicit) return dict;
  const copy = dict.clone(ctx);
  copy.set(key, explicit);
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Copying objects into another PDF

/** Arrays whose entries are a list: an entry cut is left out rather than made null. */
const LIST_KEYS = new Set(['Kids', 'Annots', 'Fields', 'CO']);

/**
 * Copies objects of one PDF (`src`, a PDFContext) into another (`dest`), each object once, however
 * often it is reached. Following references never recurses, so long chains (bookmarks thousands
 * long) can't overflow the stack.
 *
 * Options:
 * - `redirect(obj)`: for a dictionary or stream about to be copied, a PDFRef of `dest` to use
 *   instead (a page copied already), `null` to cut every reference to it (a dictionary entry goes, an
 *   array entry becomes null or, in lists such as /Kids, goes), or undefined to copy it.
 * - `transform(dict)`: the dictionary to copy in place of `dict` (a link with its destination
 *   written out, say), or `dict` itself.
 * Stream contents are shared, not copied: the source is never changed.
 */
export class Copier {
  constructor(src, dest, { redirect, transform } = {}) {
    this.src = src;
    this.dest = dest;
    this.redirect = redirect;
    this.transform = transform;
    this.refs = new Map();
    this.queue = [];
  }

  /** The copy of `value` (anything a PDF holds), or undefined if it is cut. */
  copy(value) {
    const out = this.value(value, undefined);
    this.drain();
    return out;
  }

  /**
   * Copies `obj` as the object `srcRef` stands for, so that references to `srcRef` lead to the copy:
   * for an object copied otherwise than it is (a bookmark without its siblings, say). Returns its ref.
   */
  copyAs(srcRef, obj) {
    let destRef = this.refs.get(srcRef);
    if (!destRef) {
      destRef = this.dest.nextRef();
      if (srcRef) this.refs.set(srcRef, destRef);
    }
    this.dest.assign(destRef, this.direct(obj));
    this.drain();
    return destRef;
  }

  /** Makes references to `srcRef` lead to `destRef`, an object made otherwise. */
  map(srcRef, destRef) {
    this.refs.set(srcRef, destRef);
  }

  /** The copy of each entry of `dict` (but those in `skip`), set on `target`, a dictionary of `dest`. */
  copyEntries(dict, target, skip = new Set()) {
    const source = this.transform ? this.transform(dict) : dict;
    for (const [key, value] of source.entries()) {
      if (skip.has(key.decodeText())) continue;
      const copied = this.value(value, key);
      if (copied !== undefined) target.set(key, copied);
    }
    this.drain();
    return target;
  }

  value(value, key) {
    if (value instanceof PDFRef) return this.ref(value);
    if (value instanceof PDFDict || value instanceof PDFStream) {
      const to = this.redirect?.(value);
      if (to === null) return undefined;
      if (to) return to;
      return this.direct(value);
    }
    if (value instanceof PDFArray) return this.array(value, key);
    return value;
  }

  ref(ref) {
    if (this.refs.has(ref)) return this.refs.get(ref) ?? undefined;
    const target = this.src.lookup(ref);
    if (target === undefined || target === PDFNull) {
      this.refs.set(ref, null);
      return undefined;
    }
    if (target instanceof PDFDict || target instanceof PDFStream) {
      const to = this.redirect?.(target);
      if (to !== undefined) {
        this.refs.set(ref, to);
        return to ?? undefined;
      }
    }
    const destRef = this.dest.nextRef();
    this.refs.set(ref, destRef);
    this.queue.push([target, destRef]);
    return destRef;
  }

  direct(obj) {
    if (obj instanceof PDFStream) {
      const dict = this.dictCopy(obj.dict);
      const contents = obj instanceof PDFRawStream ? obj.contents : obj.getContents();
      return PDFRawStream.of(dict, contents);
    }
    if (obj instanceof PDFDict) return this.dictCopy(obj);
    if (obj instanceof PDFArray) return this.array(obj, undefined);
    return obj;
  }

  dictCopy(dict) {
    const source = this.transform ? this.transform(dict) : dict;
    const out = PDFDict.withContext(this.dest);
    for (const [key, value] of source.entries()) {
      const copied = this.value(value, key);
      if (copied !== undefined) out.set(key, copied);
    }
    return out;
  }

  array(array, key) {
    const out = PDFArray.withContext(this.dest);
    const list = key && LIST_KEYS.has(key.decodeText());
    for (let i = 0; i < array.size(); i++) {
      const copied = this.value(array.get(i), undefined);
      if (copied !== undefined) out.push(copied);
      else if (!list) out.push(PDFNull);
    }
    return out;
  }

  drain() {
    while (this.queue.length) {
      const [target, destRef] = this.queue.pop();
      this.dest.assign(destRef, this.direct(target));
    }
  }
}

/** A new page dictionary of `ctx` (pdf-lib's own kind, so its page tools work on it). */
export function newPage(ctx) {
  const page = PDFPageLeaf.fromMapWithContext(new Map(), ctx, false);
  page.set(nm('Type'), nm('Page'));
  return page;
}

/**
 * Copies `page` (a page of `copier.src`) as the page `destRef` of `copier.dest`, under `parentRef`:
 * all it holds and what it inherited where it was, with `resources` in place of its own if given.
 * `skip` lists keys left out (beside /Parent).
 */
export function copyPage(copier, page, destRef, parentRef, { resources, skip = [] } = {}) {
  const ctx = copier.src;
  const dict = page.clone(ctx);
  // What it inherited, made its own while it is still where it was.
  const media = inherited(ctx, page, nm('MediaBox'));
  dict.set(nm('MediaBox'), boxOf(ctx, media) ? media : ctx.obj(LETTER));
  const crop = inherited(ctx, page, nm('CropBox'));
  if (crop !== undefined && boxOf(ctx, crop)) dict.set(nm('CropBox'), crop);
  if (inherited(ctx, page, nm('Rotate')) !== undefined) dict.set(nm('Rotate'), PDFNumber.of(rotationOf(ctx, page)));
  const own = resources ?? inherited(ctx, page, nm('Resources'));
  if (own !== undefined) dict.set(nm('Resources'), own);
  else dict.set(nm('Resources'), PDFDict.withContext(ctx));
  const target = newPage(copier.dest);
  copier.copyEntries(dict, target, new Set(['Parent', 'Type', ...skip]));
  target.set(nm('Parent'), parentRef);
  copier.dest.assign(destRef, target);
  return target;
}

// ---------------------------------------------------------------------------------------------
// Reading content streams

/** Decoded content larger than this is taken for unreadable rather than filling memory. */
const MAX_DECODED = 128 * 1024 * 1024;

function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

class TooLarge extends Error {}

/** Inflates `data` (zlib or raw deflate), fed a little at a time so that a small bomb fails early. */
function inflate(data, zlib) {
  if (!data.length) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  const onData = (chunk) => {
    total += chunk.length;
    if (total > MAX_DECODED) throw new TooLarge('Stream too large');
    chunks.push(chunk);
  };
  const inflater = zlib ? new Unzlib(onData) : new Inflate(onData);
  const step = 16 * 1024;
  for (let at = 0; at < data.length; at += step) {
    inflater.push(data.subarray(at, Math.min(at + step, data.length)), at + step >= data.length);
  }
  return concat(chunks, total);
}

function inflateAny(data) {
  const header = data.length > 1 && (data[0] & 15) === 8 && ((data[0] << 8) | data[1]) % 31 === 0;
  if (!header) return inflate(data, false);
  try {
    return inflate(data, true);
  } catch (e) {
    if (e instanceof TooLarge) throw e;
    // Some makers leave out the checksum at the end, or cut the stream short of it.
    return inflate(data.subarray(2), false);
  }
}

/** The decoded bytes of `stream`. Throws when they can't be read faithfully. */
export function decodeStream(ctx, stream) {
  let bytes = stream.getContents();
  const filterValue = resolve(ctx, stream.dict.get(nm('Filter')));
  const parmsValue = resolve(ctx, stream.dict.get(nm('DecodeParms')));
  const filters = filterValue instanceof PDFArray ? filterValue.asArray().map((f) => resolve(ctx, f)) : filterValue ? [filterValue] : [];
  const parms = parmsValue instanceof PDFArray ? parmsValue.asArray().map((p) => resolve(ctx, p)) : [parmsValue];
  filters.forEach((filter, i) => {
    if (!(filter instanceof PDFName)) throw new Error('Bad filter');
    const parm = parms[i] instanceof PDFDict ? parms[i] : undefined;
    // A predictor isn't undone by the decoders used here: the content would come out wrong.
    if ((numberOf(ctx, parm?.get(nm('Predictor'))) ?? 1) > 1) throw new Error('Predictor');
    const name = filter.decodeText();
    if (name === 'FlateDecode' || name === 'Fl') {
      bytes = inflateAny(bytes);
    } else {
      const dict = PDFDict.withContext(ctx);
      dict.set(nm('Filter'), filter);
      if (parm) dict.set(nm('DecodeParms'), parm);
      bytes = decodePDFRawStream(PDFRawStream.of(dict, bytes)).decode();
      if (bytes.length > MAX_DECODED) throw new Error('Stream too large');
    }
  });
  return bytes;
}

/** The page's content, decoded: its stream, or its streams one after another. */
function pageContent(ctx, page) {
  const contents = resolve(ctx, page.get(nm('Contents')));
  if (contents === undefined || contents === PDFNull) return new Uint8Array(0);
  const streams = contents instanceof PDFArray ? contents.asArray().map((s) => resolve(ctx, s)) : [contents];
  const parts = [];
  let total = 0;
  for (const stream of streams) {
    if (stream === undefined || stream === PDFNull) continue;
    if (!(stream instanceof PDFStream)) throw new Error('Bad contents');
    const bytes = decodeStream(ctx, stream);
    // Streams of one page are read as one, with a space between them.
    parts.push(bytes, SPACE);
    total += bytes.length + 1;
  }
  return concat(parts, total);
}

const SPACE = new Uint8Array([0x20]);
const WHITE = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITE[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const OTHER = Symbol('operand');

/**
 * Reads the content stream `bytes` and calls `visit(operator, operands)` for each operator, its
 * operands being the names before it (PDFName) or OTHER for anything else. Strings, arrays,
 * dictionaries and inline images are stepped over.
 */
export function scanContent(bytes, visit) {
  const n = bytes.length;
  let i = 0;
  let operands = [];
  let depth = 0;
  while (i < n) {
    const c = bytes[i];
    if (WHITE[c]) { i++; continue; }
    if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
      if (depth === 0) operands.push(PDFName.of(latin1(bytes, i + 1, j)));
      i = j;
      continue;
    }
    if (c === 0x28) {
      i = skipString(bytes, i);
      if (depth === 0) operands.push(OTHER);
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) { depth++; i += 2; continue; }
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
      if (depth === 0) operands.push(OTHER);
      continue;
    }
    if (c === 0x3e) {
      if (bytes[i + 1] === 0x3e) {
        depth = Math.max(0, depth - 1);
        i += 2;
        if (depth === 0) operands.push(OTHER);
      } else i++;
      continue;
    }
    if (c === 0x5b) { depth++; i++; continue; }
    if (c === 0x5d) {
      depth = Math.max(0, depth - 1);
      i++;
      if (depth === 0) operands.push(OTHER);
      continue;
    }
    if (DELIM[c]) { i++; continue; }
    let j = i;
    while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
    const start = i;
    i = j;
    if (depth > 0) continue;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      operands.push(OTHER);
      continue;
    }
    const token = latin1(bytes, start, j);
    if (token === 'true' || token === 'false' || token === 'null') {
      operands.push(OTHER);
      continue;
    }
    if (token === 'BI') {
      i = skipInlineImage(bytes, i);
      operands = [];
      continue;
    }
    visit(token, operands);
    operands = [];
  }
}

function latin1(bytes, from, to) {
  if (to - from < 4096) return String.fromCharCode.apply(null, bytes.subarray(from, to));
  let s = '';
  for (let k = from; k < to; k++) s += String.fromCharCode(bytes[k]);
  return s;
}

function skipString(bytes, i) {
  let nesting = 0;
  for (; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x5c) i++;
    else if (c === 0x28) nesting++;
    else if (c === 0x29 && --nesting === 0) return i + 1;
  }
  return bytes.length;
}

/** Steps over an inline image (BI ... ID data EI), from just after its BI. */
function skipInlineImage(bytes, i) {
  const n = bytes.length;
  // Its dictionary, token by token up to ID.
  while (i < n) {
    const c = bytes[i];
    if (WHITE[c]) { i++; continue; }
    if (c === 0x28) { i = skipString(bytes, i); continue; }
    if (c === 0x2f) {
      i++;
      while (i < n && !WHITE[bytes[i]] && !DELIM[bytes[i]]) i++;
      continue;
    }
    if (DELIM[c]) { i++; continue; }
    let j = i;
    while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
    const isId = j - i === 2 && c === 0x49 && bytes[i + 1] === 0x44;
    i = j;
    if (isId) {
      // One white-space character separates ID from the data.
      i++;
      break;
    }
  }
  // Its data, up to an EI standing alone and followed by what looks like content again.
  for (; i < n - 1; i++) {
    if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x49) continue;
    if (i > 0 && !WHITE[bytes[i - 1]]) continue;
    if (i + 2 < n && !WHITE[bytes[i + 2]]) continue;
    let plain = true;
    for (let k = i + 2; k < Math.min(n, i + 12); k++) {
      if (bytes[k] > 0x7e || (bytes[k] < 0x20 && !WHITE[bytes[k]])) { plain = false; break; }
    }
    if (plain) return i + 2;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Images and forms pages draw (XObjectCleanup.kt)

const isImage = (ctx, stream) => isName(ctx, stream.dict.get(nm('Subtype')), 'Image');
const isForm = (ctx, stream) => isName(ctx, stream.dict.get(nm('Subtype')), 'Form');

/**
 * Adds to `into` every image, form and (tiling) pattern stream reachable from `start`, not
 * following links up to pages (/Parent, /P).
 */
export function collect(ctx, start, into) {
  const seen = new Set();
  const pending = [];
  const first = resolve(ctx, start);
  if (first !== undefined) pending.push(first);
  while (pending.length) {
    const item = pending.pop();
    if (seen.has(item)) continue;
    seen.add(item);
    if (item instanceof PDFStream) {
      if (isImage(ctx, item) || isForm(ctx, item) || item.dict.has(nm('PatternType'))) into.add(item);
    }
    const dict = entriesHolder(item);
    if (dict) {
      for (const [key, value] of dict.entries()) {
        if (key === nm('Parent') || key === nm('P')) continue;
        const v = resolve(ctx, value);
        if (v instanceof PDFDict || v instanceof PDFStream || v instanceof PDFArray) pending.push(v);
      }
    } else if (item instanceof PDFArray) {
      for (let i = 0; i < item.size(); i++) {
        const v = resolve(ctx, item.get(i));
        if (v instanceof PDFDict || v instanceof PDFStream || v instanceof PDFArray) pending.push(v);
      }
    }
  }
  return into;
}

/** Forms nested deeper than this in each other are taken for unreadable content. */
const MAX_FORM_DEPTH = 50;

/**
 * Finds the images and forms a page's content draws, those inside forms included, and the patterns
 * it paints with and the soft masks of the graphics states it sets, with all they hold: those draw
 * content of their own, text too. Adds them to `drawn`, and the resources of the forms it draws to
 * `contexts`. Throws when the content can't be read.
 */
class DrawnXObjects {
  constructor(ctx, drawn, contexts) {
    this.ctx = ctx;
    this.drawn = drawn;
    this.contexts = contexts;
    // The patterns and graphics states already followed: a page may set the same one thousands of times.
    this.followed = new Set();
    // Each form is read once with each list of resources it is drawn with.
    this.forms = new Map();
  }

  processPage(page) {
    const resources = resourcesOf(this.ctx, page);
    this.process(pageContent(this.ctx, page), resources, 0);
  }

  process(bytes, resources, depth) {
    const ctx = this.ctx;
    scanContent(bytes, (op, operands) => {
      if (op === 'Do') {
        const name = operands[0];
        if (!(name instanceof PDFName)) return;
        const xobject = streamOf(ctx, dictOf(ctx, resources?.get(nm('XObject')))?.get(name));
        if (!xobject) return;
        this.drawn.add(xobject);
        if (!isForm(ctx, xobject)) return;
        const own = dictOf(ctx, xobject.dict.get(nm('Resources')));
        if (own) this.contexts.add(own);
        this.showForm(xobject, own ?? resources, depth + 1);
      } else if (op === 'scn' || op === 'SCN') {
        // A pattern is named last, after any colour it is painted in.
        this.follow(this.resource(resources, 'Pattern', operands[operands.length - 1]));
      } else if (op === 'gs') {
        this.follow(this.resource(resources, 'ExtGState', operands[0]));
      }
    });
  }

  showForm(form, resources, depth) {
    if (depth > MAX_FORM_DEPTH) throw new Error('Forms nested too deeply');
    let done = this.forms.get(form);
    if (!done) this.forms.set(form, (done = new Set()));
    const key = resources ?? NO_RESOURCES;
    if (done.has(key)) return;
    done.add(key);
    this.process(decodeStream(this.ctx, form), resources, depth);
  }

  resource(resources, kind, name) {
    if (!(name instanceof PDFName)) return undefined;
    return resolve(this.ctx, dictOf(this.ctx, resources?.get(nm(kind)))?.get(name));
  }

  follow(resource) {
    if (resource === undefined || this.followed.has(resource)) return;
    this.followed.add(resource);
    collect(this.ctx, resource, this.drawn);
  }
}

const NO_RESOURCES = {};

/**
 * Adds to `into` the images, forms, patterns and soft masks `page` draws (see DrawnXObjects). If
 * its content can't be read, everything its resources list counts, so nothing it might have drawn
 * is missed.
 */
export function drawnBy(ctx, page, into) {
  const found = new Set();
  try {
    new DrawnXObjects(ctx, found, new Set()).processPage(page);
    for (const x of found) into.add(x);
  } catch {
    collect(ctx, resourcesOf(ctx, page), into);
  }
  return into;
}

/**
 * Whether `page`'s resources list any of `xobjects`, also inside forms and the like: if not, it
 * can't draw them, and its content needn't be read. `known` keeps the answer for resources shared
 * by several pages.
 */
export function mayDraw(ctx, page, xobjects, known) {
  const resources = resourcesOf(ctx, page);
  if (!resources) return false;
  if (!known.has(resources)) {
    let any = false;
    for (const x of collect(ctx, resources, new Set())) if (xobjects.has(x)) { any = true; break; }
    known.set(resources, any);
  }
  return known.get(resources);
}

/**
 * Adds to `into` every image, form and pattern `page` might draw: what its content draws and paints
 * with, and, to be safe, all those reachable from its fonts, shadings and marked-content properties
 * and its annotations' appearances, which aren't followed in detail. If its content can't be read,
 * everything its resources list counts. Without `readContent`, only its annotations are looked at.
 */
function usedBy(ctx, page, into, readContent) {
  if (readContent) {
    const contexts = new Set();
    const resources = resourcesOf(ctx, page);
    if (resources) contexts.add(resources);
    try {
      new DrawnXObjects(ctx, into, contexts).processPage(page);
      for (const context of contexts) {
        for (const key of ['Font', 'Shading', 'Properties']) collect(ctx, context.get(nm(key)), into);
      }
    } catch {
      collect(ctx, resources, into);
    }
  }
  const annotations = arrayOf(ctx, page.get(nm('Annots')));
  for (let i = 0; annotations && i < annotations.size(); i++) {
    collect(ctx, dictOf(ctx, annotations.get(i))?.get(nm('AP')), into);
  }
}

/**
 * Empties, in place, each of `drawn` that none of `users` (the pages that stay, as page
 * dictionaries) nor the form's default resources might still draw. Only for objects that belong
 * to this document alone.
 */
export async function emptyUnused(doc, drawn, users, tick) {
  if (!drawn.size) return;
  const ctx = doc.context;
  const used = new Set();
  // Most pages' resources don't reach any of `drawn`, and their content needn't be read.
  const reaches = new Map();
  for (const page of users) {
    await tick();
    usedBy(ctx, page, used, mayDraw(ctx, page, drawn, reaches));
  }
  collect(ctx, dictOf(ctx, catalogOf(doc).get(nm('AcroForm')))?.get(nm('DR')), used);
  // What an image drawn there needs to look as it does: its soft mask, its mask, its alternates.
  for (const x of [...used]) if (x instanceof PDFStream && isImage(ctx, x)) collect(ctx, x, used);
  for (const x of drawn) if (!used.has(x) && x instanceof PDFRawStream) empty(ctx, x);
}

const IMAGE_KEEP = new Set(['Type', 'Subtype']);
const PATTERN_KEEP = new Set(['Type', 'PatternType', 'PaintType', 'TilingType', 'BBox', 'XStep', 'YStep', 'Matrix']);
const FORM_KEEP = new Set(['Type', 'Subtype', 'BBox', 'Matrix', 'FormType']);

/** Empties an image, form or pattern that only pages which have gone drew: a white pixel, or nothing to draw. */
function empty(ctx, stream) {
  const image = isImage(ctx, stream);
  const keep = image ? IMAGE_KEEP : stream.dict.has(nm('PatternType')) ? PATTERN_KEEP : FORM_KEEP;
  for (const key of stream.dict.keys()) if (!keep.has(key.decodeText())) stream.dict.delete(key);
  if (image) {
    stream.dict.set(nm('Width'), PDFNumber.of(1));
    stream.dict.set(nm('Height'), PDFNumber.of(1));
    stream.dict.set(nm('BitsPerComponent'), PDFNumber.of(8));
    stream.dict.set(nm('ColorSpace'), nm('DeviceGray'));
    stream.updateContents(new Uint8Array([0xff]));
  } else {
    stream.dict.set(nm('Resources'), PDFDict.withContext(ctx));
    stream.updateContents(new Uint8Array(0));
  }
}

/**
 * A copy of `resources` (a page's) whose list of images and forms keeps only those `page` draws,
 * for a page copied into another document: the others would go with it. The rest is shared.
 * `resources` itself if the page's content can't be read or it draws them all.
 */
export function drawnOnly(ctx, page, resources) {
  const xobjects = dictOf(ctx, resources.get(nm('XObject')));
  if (!xobjects) return resources;
  const drawn = new Set();
  try {
    new DrawnXObjects(ctx, drawn, new Set()).processPage(page);
  } catch {
    return resources;
  }
  const kept = PDFDict.withContext(ctx);
  for (const [name, value] of xobjects.entries()) {
    if (drawn.has(resolve(ctx, value))) kept.set(name, value);
  }
  if (kept.keys().length === xobjects.keys().length) return resources;
  const copy = resources.clone(ctx);
  copy.set(nm('XObject'), kept);
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Pages that have gone (PageCleanup.kt)

/**
 * Cuts every link to `removed` pages (page dictionaries) that are no longer in `doc`'s page tree:
 * their form fields go, bookmarks to them go (unless they hold bookmarks to pages that stay), so do
 * their tags and the pictures and forms only they drew, and any other reference to them or their
 * annotations, such as a link's destination, is emptied. A static XFA form goes too: it would keep
 * the fields' values. `tick` is awaited now and then (see ticker).
 */
export async function dropRemovedPages(doc, removed, tick) {
  const ctx = doc.context;
  const pages = readPages(doc).pages;
  const kept = new Set(pages.map((p) => p.dict));
  const gone = new Set(removed.filter((page) => !kept.has(page)));
  if (!gone.size) return;
  // Their annotations go too (unless a page that stays shows them as well): a reply to a comment,
  // or the tags of an accessible PDF, can still point at them.
  const keptAnnotations = new Set();
  for (const page of kept) annotationsOf(ctx, page, keptAnnotations);
  const goneAnnotations = new Set();
  for (const page of gone) annotationsOf(ctx, page, goneAnnotations);
  for (const a of keptAnnotations) goneAnnotations.delete(a);

  pruneForm(doc, goneAnnotations);
  await pruneOutline(doc, pages, gone, tick);
  // Pictures they alone drew go too, though pages that stay may still list them.
  const drawn = new Set();
  for (const page of gone) {
    await tick();
    drawnBy(ctx, page, drawn);
  }
  await emptyUnused(doc, drawn, pages.map((p) => p.dict), tick);
  const goneTags = pruneTags(doc, gone, goneAnnotations);
  const cut = new Set([...gone, ...goneAnnotations, ...goneTags]);
  await cutReferences(ctx, [ctx.trailerInfo.Root, ctx.trailerInfo.Info], (d) => cut.has(d), tick);
}

/** Form fields whose widgets were all on removed pages go, so their values don't stay behind. */
function pruneForm(doc, widgets) {
  const ctx = doc.context;
  const form = dictOf(ctx, catalogOf(doc).get(nm('AcroForm')));
  if (!form) return;
  const fields = arrayOf(ctx, form.get(nm('Fields')));
  if (fields && widgets.size) pruneFields(ctx, fields, widgets, 0);
  // A static XFA form holds every field's value again, those of the pages gone too.
  if (form.has(nm('XFA')) && fields && fields.size() > 0) {
    form.delete(nm('XFA'));
    catalogOf(doc).delete(nm('NeedsRendering'));
  }
  // The calculation order lists fields too; one that has gone mustn't stay in it.
  const order = arrayOf(ctx, form.get(nm('CO')));
  if (!order) return;
  const remaining = new Set();
  if (fields) collectFields(ctx, fields, remaining, 0);
  for (let i = order.size() - 1; i >= 0; i--) {
    if (!remaining.has(resolve(ctx, order.get(i)))) order.remove(i);
  }
}

function pruneFields(ctx, kids, widgets, depth) {
  if (depth > MAX_DEPTH) return;
  for (let i = kids.size() - 1; i >= 0; i--) {
    const kid = dictOf(ctx, kids.get(i));
    if (!kid) continue;
    // A widget on a removed page, or a field that is its own widget there.
    if (widgets.has(kid)) {
      kids.remove(i);
      continue;
    }
    const grandKids = arrayOf(ctx, kid.get(nm('Kids')));
    if (!grandKids || grandKids.size() === 0) continue;
    pruneFields(ctx, grandKids, widgets, depth + 1);
    // A field left with no widgets and no fields under it has gone with its pages.
    if (grandKids.size() === 0) kids.remove(i);
  }
}

export function collectFields(ctx, kids, into, depth) {
  if (depth > MAX_DEPTH) return into;
  for (let i = 0; i < kids.size(); i++) {
    const kid = dictOf(ctx, kids.get(i));
    if (!kid || into.has(kid)) continue;
    into.add(kid);
    const grandKids = arrayOf(ctx, kid.get(nm('Kids')));
    if (grandKids) collectFields(ctx, grandKids, into, depth + 1);
  }
  return into;
}

/**
 * Bookmarks that lead only to removed pages go; the /Count of each is then put right. Each bookmark
 * is read once: in a damaged outline, the bookmarks under one can lead back to those above it.
 */
async function pruneOutline(doc, pages, gone, tick) {
  const ctx = doc.context;
  const root = dictOf(ctx, catalogOf(doc).get(nm('Outlines')));
  if (!root) return;
  await pruneBookmarks(doc, pages, root, gone, new Set([root]), tick, 0);
  recountOutline(ctx, root);
}

async function pruneBookmarks(doc, pages, parent, gone, seen, tick, depth) {
  if (depth > MAX_DEPTH) return;
  const ctx = doc.context;
  let item = dictOf(ctx, parent.get(nm('First')));
  while (item && !seen.has(item)) {
    seen.add(item);
    await tick();
    const next = dictOf(ctx, item.get(nm('Next')));
    await pruneBookmarks(doc, pages, item, gone, seen, tick, depth + 1);
    let target;
    try {
      target = destinationPage(doc, pages, destinationOf(ctx, item));
    } catch {
      target = undefined;
    }
    if (target && gone.has(target) && !dictOf(ctx, item.get(nm('First')))) unlink(ctx, parent, item);
    item = next;
  }
}

/** Takes `item` out of `parent`'s list of bookmarks. Raw entries are moved, so references stay references. */
function unlink(ctx, parent, item) {
  const prev = item.get(nm('Prev'));
  const next = item.get(nm('Next'));
  const prevItem = dictOf(ctx, prev);
  const nextItem = dictOf(ctx, next);
  setOrRemove(prevItem ?? parent, prevItem ? 'Next' : 'First', next);
  setOrRemove(nextItem ?? parent, nextItem ? 'Prev' : 'Last', prev);
}

function setOrRemove(dict, key, value) {
  if (value === undefined || value === PDFNull) dict.delete(nm(key));
  else dict.set(nm(key), value);
}

/**
 * Sets the /Count of the outline at `root` and of each bookmark from those left: an open bookmark
 * counts those shown under it, a closed one the negative of that; the root counts every bookmark shown.
 */
export function recountOutline(ctx, root) {
  recount(ctx, root, true, new Set([root]), 0);
}

function recount(ctx, node, isRoot, seen, depth) {
  let shown = 0;
  let item = dictOf(ctx, node.get(nm('First')));
  while (item && depth <= MAX_DEPTH && !seen.has(item)) {
    seen.add(item);
    recount(ctx, item, false, seen, depth + 1);
    shown += 1 + Math.max(0, numberOf(ctx, item.get(nm('Count'))) ?? 0);
    item = dictOf(ctx, item.get(nm('Next')));
  }
  if (isRoot) node.set(nm('Count'), PDFNumber.of(shown));
  else if (shown === 0) node.delete(nm('Count'));
  else node.set(nm('Count'), PDFNumber.of((numberOf(ctx, node.get(nm('Count'))) ?? 0) > 0 ? shown : -shown));
}

/**
 * Takes out of the tags (the structure tree of an accessible PDF) the elements whose content was all
 * on `gone` pages or in `goneAnnotations`, with their alternate text, ActualText, titles and
 * expansions, which can repeat what the pages said. Returns them, so that references to them from
 * elsewhere (the parent tree) are cut too. Elements with content on pages that stay are kept.
 */
function pruneTags(doc, gone, goneAnnotations) {
  const ctx = doc.context;
  const root = dictOf(ctx, catalogOf(doc).get(nm('StructTreeRoot')));
  const dropped = new Set();
  if (!root) return dropped;
  const seen = new Set();

  // Removes `element`'s kids that were on gone pages: marked content (by number, or by a reference
  // saying which page), objects such as annotations, and elements left with nothing. Returns
  // whether `element` goes too. Its content is on `page` unless it or an item says otherwise.
  const prune = (element, page, depth) => {
    if (depth > MAX_DEPTH || seen.has(element)) return false;
    seen.add(element);
    const on = dictOf(ctx, element.get(nm('Pg'))) ?? page;
    const goes = (kid) => {
      if (kid instanceof PDFNumber) return gone.has(on);
      if (!(kid instanceof PDFDict)) return false;
      const type = nameOf(ctx, kid.get(nm('Type')));
      if (type === nm('MCR') || type === nm('OBJR')) {
        return gone.has(dictOf(ctx, kid.get(nm('Pg'))) ?? on) || goneAnnotations.has(dictOf(ctx, kid.get(nm('Obj'))));
      }
      const goesToo = prune(kid, on, depth + 1);
      if (goesToo) dropped.add(kid);
      return goesToo;
    };
    const isRoot = element === root;
    const kids = resolve(ctx, element.get(nm('K')));
    if (kids === undefined || kids === PDFNull) return !isRoot && gone.has(on);
    if (kids instanceof PDFArray) {
      if (kids.size() === 0) return !isRoot && gone.has(on);
      for (let i = kids.size() - 1; i >= 0; i--) if (goes(resolve(ctx, kids.get(i)))) kids.remove(i);
      return !isRoot && kids.size() === 0;
    }
    const single = goes(kids);
    if (single) element.delete(nm('K'));
    return single && !isRoot;
  };
  prune(root, undefined, 0);
  // The index of elements by their /ID, and the parent tree's entries for single elements (an
  // annotation's tag), lose those that went, rather than keep their keys with nothing.
  if (dropped.size) {
    for (const [tree, entries] of [['IDTree', 'Names'], ['ParentTree', 'Nums']]) {
      const node = dictOf(ctx, root.get(nm(tree)));
      if (node && pruneEntries(ctx, node, entries, dropped, new Set(), 0)) root.delete(nm(tree));
    }
  }
  return dropped;
}

/**
 * Takes out of the name or number tree at `node` (its pairs listed under `entries`) those whose value
 * is one of `dropped`, and puts its limits right. Returns whether `node` is left empty.
 */
function pruneEntries(ctx, node, entries, dropped, seen, depth) {
  if (depth > MAX_DEPTH || seen.has(node)) return false;
  seen.add(node);
  let isEmpty = true;
  let first;
  let last;
  const pairs = arrayOf(ctx, node.get(nm(entries)));
  if (pairs) {
    for (let pair = Math.floor(pairs.size() / 2) - 1; pair >= 0; pair--) {
      if (dropped.has(resolve(ctx, pairs.get(2 * pair + 1)))) {
        pairs.remove(2 * pair + 1);
        pairs.remove(2 * pair);
      }
    }
    if (pairs.size() >= 2) {
      isEmpty = false;
      first = pairs.get(0);
      last = pairs.get(Math.floor(pairs.size() / 2) * 2 - 2);
    }
  }
  const kids = arrayOf(ctx, node.get(nm('Kids')));
  if (kids) {
    for (let i = kids.size() - 1; i >= 0; i--) {
      const kid = dictOf(ctx, kids.get(i));
      if (kid && pruneEntries(ctx, kid, entries, dropped, seen, depth + 1)) kids.remove(i);
    }
    if (kids.size() > 0) {
      isEmpty = false;
      const limit = (kid, end) => arrayOf(ctx, dictOf(ctx, kid)?.get(nm('Limits')))?.get(end);
      first = first ?? limit(kids.get(0), 0);
      last = limit(kids.get(kids.size() - 1), 1) ?? last;
    }
  }
  // Nodes but the root say which keys they hold.
  if (arrayOf(ctx, node.get(nm('Limits'))) && first !== undefined && last !== undefined) {
    const limits = PDFArray.withContext(ctx);
    limits.push(first);
    limits.push(last);
    node.set(nm('Limits'), limits);
  }
  return isEmpty;
}

/**
 * Walks everything that can be reached from `starts` and empties each reference to what has `gone`
 * (pages, annotations, form fields, tags): a dictionary entry is removed, an array entry becomes
 * null. They aren't entered, so nothing reached only through them is saved.
 */
export async function cutReferences(ctx, starts, gone, tick) {
  const seen = new Set();
  const pending = [];
  for (const start of starts) {
    const value = resolve(ctx, start);
    if (value !== undefined) pending.push(value);
  }
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (++visited % 2000 === 0) await tick();
    const dict = entriesHolder(current);
    if (dict) {
      for (const [key, raw] of dict.entries()) {
        const value = resolve(ctx, raw);
        if (value instanceof PDFDict) {
          if (gone(value)) dict.delete(key);
          else pending.push(value);
        } else if (value instanceof PDFArray || value instanceof PDFStream) pending.push(value);
      }
    } else if (current instanceof PDFArray) {
      for (let i = 0; i < current.size(); i++) {
        const value = resolve(ctx, current.get(i));
        if (value instanceof PDFDict) {
          if (gone(value)) current.set(i, PDFNull);
          else pending.push(value);
        } else if (value instanceof PDFArray || value instanceof PDFStream) pending.push(value);
      }
    }
  }
}

/**
 * The form fields and widgets that hang under the same fields as the widgets in `kept` but hold
 * none of them, with all they hold: in a form whose fields nest, the fields of other pages.
 */
export function fieldsElsewhere(ctx, kept) {
  // The fields the widgets kept belong to, up to the top.
  const owners = new Set();
  for (const annotation of kept) {
    if (!isName(ctx, annotation.get(nm('Subtype')), 'Widget')) continue;
    let field = dictOf(ctx, annotation.get(nm('Parent')));
    let depth = 0;
    while (field && depth++ <= MAX_DEPTH && !owners.has(field)) {
      owners.add(field);
      field = dictOf(ctx, field.get(nm('Parent')));
    }
  }
  const others = new Set();
  const pending = [...owners].map((owner) => [owner, 0]);
  while (pending.length) {
    const [field, depth] = pending.pop();
    if (depth > MAX_DEPTH) continue;
    const kids = arrayOf(ctx, field.get(nm('Kids')));
    for (let i = 0; kids && i < kids.size(); i++) {
      const kid = dictOf(ctx, kids.get(i));
      if (kid && !owners.has(kid) && !kept.has(kid) && !others.has(kid)) {
        others.add(kid);
        pending.push([kid, depth + 1]);
      }
    }
  }
  return { owners, others };
}
