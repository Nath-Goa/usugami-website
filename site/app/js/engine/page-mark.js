// The small "Usugami" mark the PDFs Usugami makes can carry, to support the app (data/PageMark.kt,
// core/MarkLayout.kt): put on every page, changed or taken off again in place, in the bottom-right
// corner of each page as it is shown (its crop box, turned by its rotation), upright, in Helvetica
// Bold (one of the fonts every PDF viewer has, so nothing is embedded), in a dark grey at the chosen
// opacity.
//
// What it adds is all marked with /UsugamiMark, the same objects and names as the Android app's, so
// a PDF marked by either can be unmarked by the other, leaving each page as it was:
// - a form XObject that draws the word, with its own font and opacity, one for the whole PDF;
// - before each page's own content, a stream that saves the graphics state (q), one for the whole PDF;
// - after it, a stream of the page's own that restores that state (Q), so nothing the page's content
//   leaves behind can move or recolour the mark, and draws the form at the page's corner, marked as a
//   pagination artifact so that screen readers and other accessibility tools pass over it. Its marker
//   keeps the style, where on the page it was drawn, the form's name, what the page's content was,
//   and which resources were added;
// - the form's name in the page's XObject resources.
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFStream, PDFNumber, PDFBool, EncryptedPDFError,
} from '../lib/pdf-lib.js';
import { UserError, checkCancelled } from '../core/errors.js';
import { yieldToUI } from '../core/dom.js';
import { loadPdf, savePdf } from './pdf-common.js';
import { MarkLayout, markStyle, mayCarryMark } from './mark-layout.js';

export {
  MarkStyle, MarkLayout, markStyle, sameMark, mayCarryMark, DEFAULT_SIZE, DEFAULT_OPACITY, MIN_OPACITY,
} from './mark-layout.js';

// ---------------------------------------------------------------------------------------------
// The mark in a PDF (data/PageMark.kt)

const nm = (s) => PDFName.of(s);
/** In the dictionary of each stream the mark adds. */
const MARKER = nm('UsugamiMark');
const FORM_NAME = 'UsugamiMark';
const FONT_NAME = 'F';
const STATE_NAME = 'GS';
const KEY_SIZE = nm('Size');
const KEY_OPACITY = nm('Opacity');
const KEY_MATRIX = nm('Matrix');
const KEY_NAME = nm('Name');
const KEY_WAS = nm('Was');
const KEY_MADE_XOBJECTS = nm('MadeXObjects');
const KEY_MADE_RESOURCES = nm('MadeResources');
const CONTENTS = nm('Contents');
const RESOURCES = nm('Resources');
const XOBJECT = nm('XObject');
const PARENT = nm('Parent');
const KIDS = nm('Kids');
const TYPE = nm('Type');

/** How far a number of the mark's place may be from where it goes: in points, or font sizes. */
const MATRIX_SLACK = 0.01;
const LETTER = [0, 0, 612, 792];
const MAX_DEPTH = 512;

/** `value` as a PDF number: no exponent, at most 4 decimals (rounded half up, as the app's BigDecimal). */
function number(value) {
  if (!Number.isFinite(value)) return '0';
  const fixed = Math.abs(value) < 1e21 ? value.toFixed(4) : String(Math.round(value));
  const out = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return out === '-0' ? '0' : out;
}

function dictOf(ctx, v) {
  const o = ctx.lookup(v);
  return o instanceof PDFDict ? o : undefined;
}

function numberOf(ctx, v) {
  const o = ctx.lookup(v);
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

/** COSDictionary.getInt: a number's whole part, or `fallback`. */
function intOf(ctx, v, fallback) {
  const n = numberOf(ctx, v);
  return n === undefined ? fallback : Math.trunc(n);
}

function boolOf(ctx, v) {
  const o = ctx.lookup(v);
  return o instanceof PDFBool ? o.asBoolean() : false;
}

function nameOf(ctx, v) {
  const o = ctx.lookup(v);
  return o instanceof PDFName ? o : undefined;
}

/** Whether `item` (an entry of a page's /Contents) is one of the streams the mark adds. */
function isOurs(ctx, item) {
  const s = ctx.lookup(item);
  return s instanceof PDFStream && s.dict.get(MARKER) !== undefined;
}

/** The marker of one of the mark's streams: the dictionary of the stream drawn after the page's content. */
function markerOf(ctx, item) {
  const s = ctx.lookup(item);
  return s instanceof PDFStream ? dictOf(ctx, s.dict.get(MARKER)) : undefined;
}

/**
 * The pages of `doc`, as viewers find them: what ends each branch of the page tree, a page with or
 * without its type (core/cleanup.js's readPages, without pdf-lib's page list, which caches).
 * @returns {PDFDict[]}
 */
function pagesOf(doc) {
  const ctx = doc.context;
  const root = dictOf(ctx, doc.catalog.get(nm('Pages')));
  if (!root) return [];
  // A lone page in the tree's place, which viewers read as a tree holding it.
  if (nameOf(ctx, root.get(TYPE)) === nm('Page')) return [root];
  const pages = [];
  const seen = new Set([root]);
  const walk = (node, depth) => {
    if (depth > MAX_DEPTH) return;
    const kids = ctx.lookup(node.get(KIDS));
    if (!(kids instanceof PDFArray)) return;
    for (let i = 0; i < kids.size(); i++) {
      const kid = dictOf(ctx, kids.get(i));
      if (!kid) continue;
      const type = nameOf(ctx, kid.get(TYPE));
      if (type === nm('Pages') || kid.get(KIDS) !== undefined) {
        if (seen.has(kid)) continue;
        seen.add(kid);
        walk(kid, depth + 1);
      } else if (type === undefined || type === nm('Page')) {
        // A page listed twice is one page: marked once.
        if (seen.has(kid)) continue;
        seen.add(kid);
        pages.push(kid);
      }
    }
  };
  walk(root, 0);
  return pages;
}

/** The value `page` has for `key`, its own or inherited from the page tree (raw, unresolved). */
function inherited(ctx, page, key) {
  const seen = new Set();
  let node = page;
  for (let depth = 0; node && depth <= MAX_DEPTH && !seen.has(node); depth++) {
    seen.add(node);
    const v = node.get(key);
    if (v !== undefined) return v;
    node = dictOf(ctx, node.get(PARENT));
  }
  return undefined;
}

/** A box [x1, y1, x2, y2] as PDFBox reads it: corners in order; null when it isn't four numbers. */
function boxOf(ctx, raw) {
  const a = ctx.lookup(raw);
  if (!(a instanceof PDFArray) || a.size() < 4) return null;
  const v = [0, 1, 2, 3].map((i) => numberOf(ctx, a.get(i)));
  if (v.some((n) => n === undefined || !Number.isFinite(n))) return null;
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

/**
 * `page` as a viewer shows it (PageFrame, PdfToolsEngine's PDPage.frame()): its crop box, kept to
 * its media box, turned clockwise by its /Rotate. `matrix` takes points of the shown page (origin
 * at its bottom-left corner, y up) to the page's own coordinates.
 */
function frameOf(ctx, page) {
  const media = boxOf(ctx, inherited(ctx, page, nm('MediaBox'))) ?? LETTER;
  const cropped = boxOf(ctx, inherited(ctx, page, nm('CropBox')));
  const box = cropped
    ? [Math.max(media[0], cropped[0]), Math.max(media[1], cropped[1]), Math.min(media[2], cropped[2]), Math.min(media[3], cropped[3])]
    : media;
  const left = box[0];
  const bottom = box[1];
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  const turn = numberOf(ctx, inherited(ctx, page, nm('Rotate')));
  let rotation = turn === undefined ? 0 : Math.trunc(turn);
  rotation = rotation % 90 === 0 ? ((rotation % 360) + 360) % 360 : 0;
  const sideways = rotation === 90 || rotation === 270;
  let matrix;
  switch (rotation) {
    // The shown bottom-left corner is the box's bottom-right corner, and shown x runs up the page.
    case 90: matrix = [0, 1, -1, 0, left + width, bottom]; break;
    case 180: matrix = [-1, 0, 0, -1, left + width, bottom + height]; break;
    // The shown bottom-left corner is the box's top-left corner, and shown x runs down the page.
    case 270: matrix = [0, -1, 1, 0, left, bottom + height]; break;
    default: matrix = [1, 0, 0, 1, left, bottom];
  }
  return { shownWidth: sideways ? height : width, shownHeight: sideways ? width : height, matrix, rotation };
}

/**
 * Where the form goes on `page` in `style`: from the form's space (a font size of 1, the baseline's
 * start at its origin) to the page's, in the bottom-right corner of the page as shown.
 */
function markMatrix(ctx, page, style) {
  const frame = frameOf(ctx, page);
  const place = MarkLayout.place(style, frame.shownWidth, frame.shownHeight);
  const m = frame.matrix;
  const size = place.fontSize;
  return [
    m[0] * size, m[1] * size, m[2] * size, m[3] * size,
    m[0] * place.x + m[2] * place.y + m[4], m[1] * place.x + m[3] * place.y + m[5],
  ];
}

/** `page`'s content streams as it lists them: references, mostly (raw, unresolved). */
function contentsOf(ctx, page) {
  const raw = page.get(CONTENTS);
  const contents = ctx.lookup(raw);
  if (contents instanceof PDFArray) return contents.asArray();
  if (contents instanceof PDFStream) return [raw];
  return [];
}

/** The resources `page` uses: its own, or those it takes from the page tree. */
function resourcesOf(ctx, page) {
  return dictOf(ctx, inherited(ctx, page, RESOURCES));
}

/** Whether `was`, a page's content as it was, is the streams `left`, in order. */
function sameStreams(ctx, was, left) {
  const resolved = ctx.lookup(was);
  const streams = resolved instanceof PDFArray ? resolved.asArray().map((x) => ctx.lookup(x)) : [resolved];
  return streams.length === left.length && streams.every((s, i) => s === ctx.lookup(left[i]));
}

/** Takes Usugami's mark off `page`, if it has one, and puts back what was there before; says whether it had one. */
function unmarkPage(ctx, page) {
  const elements = contentsOf(ctx, page);
  const ours = new Set();
  elements.forEach((item, i) => { if (isOurs(ctx, item)) ours.add(i); });
  if (!ours.size) return false;
  const markers = [...ours].map((i) => markerOf(ctx, elements[i])).filter(Boolean);
  for (const marker of markers) {
    const resources = resourcesOf(ctx, page);
    if (!resources) break;
    const xObjects = dictOf(ctx, resources.get(XOBJECT));
    const name = nameOf(ctx, marker.get(KEY_NAME));
    // Its own form only: another page sharing these resources may have taken it out already.
    if (name && xObjects) {
      const form = ctx.lookup(xObjects.get(name));
      if (form instanceof PDFStream && form.dict.get(MARKER) !== undefined) xObjects.delete(name);
    }
    if (xObjects && xObjects.keys().length === 0 && boolOf(ctx, marker.get(KEY_MADE_XOBJECTS))) resources.delete(XOBJECT);
    if (resources.keys().length === 0 && boolOf(ctx, marker.get(KEY_MADE_RESOURCES)) && dictOf(ctx, page.get(RESOURCES)) === resources) {
      page.delete(RESOURCES);
    }
  }
  const left = elements.filter((_, i) => !ours.has(i));
  const was = markers.map((m) => m.get(KEY_WAS)).find((v) => v !== undefined);
  if (was !== undefined && sameStreams(ctx, was, left)) {
    // The page's content as it was, the very object, when nothing else has been added since.
    page.set(CONTENTS, was);
  } else if (!left.length) {
    page.delete(CONTENTS);
  } else {
    const list = PDFArray.withContext(ctx);
    for (const item of left) list.push(item);
    page.set(CONTENTS, list);
  }
  return true;
}

/**
 * Whether `page` carries `style` once, drawn where it goes on the page as it is shown now, and
 * nothing else of Usugami's mark; or none of it when `style` is null.
 */
function carries(ctx, page, style) {
  const ours = contentsOf(ctx, page).filter((item) => isOurs(ctx, item));
  if (!style) return ours.length === 0;
  const markers = ours.map((item) => markerOf(ctx, item)).filter(Boolean);
  if (markers.length !== 1 || ours.length !== 2) return false;
  const [marker] = markers;
  if (intOf(ctx, marker.get(KEY_SIZE), -1) !== style.size || intOf(ctx, marker.get(KEY_OPACITY), -1) !== style.opacity) return false;
  // A page turned or cropped since it was marked has the mark in the wrong place.
  const drawn = ctx.lookup(marker.get(KEY_MATRIX));
  if (!(drawn instanceof PDFArray)) return false;
  const wanted = markMatrix(ctx, page, style);
  if (drawn.size() !== wanted.length) return false;
  return wanted.every((w, i) => {
    const n = numberOf(ctx, drawn.get(i));
    return n !== undefined && Math.abs(n - w) < MATRIX_SLACK;
  });
}

/** The form that draws the word in `style`'s opacity, at a font size of 1, its baseline starting at the origin. */
function makeForm(ctx, style) {
  const font = ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold', Encoding: 'WinAnsiEncoding' });
  const state = ctx.obj({ Type: 'ExtGState', ca: style.alpha });
  const resources = ctx.obj({ Font: { [FONT_NAME]: font }, ExtGState: { [STATE_NAME]: state } });
  const content = `/${STATE_NAME} gs\n${number(MarkLayout.GRAY)} g\nBT\n/${FONT_NAME} 1 Tf\n(${MarkLayout.TEXT}) Tj\nET\n`;
  return ctx.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    // Round the word's letters, with room to spare: "U" and "i" reach up 0.72, "g" down 0.22.
    BBox: [0, -0.3, Number(number(MarkLayout.TEXT_WIDTH + 0.1)), 0.8],
    Resources: resources,
    UsugamiMark: true,
  });
}

/** Draws `form`, the mark in `style`, in `page`'s bottom-right corner as shown, after the page's own content. */
function markPage(ctx, page, form, formRef, beforeRef, style) {
  const was = page.get(CONTENTS);
  const found = resourcesOf(ctx, page);
  const madeResources = !found;
  const resources = found ?? ctx.obj({});
  if (madeResources) page.set(RESOURCES, resources);
  const foundXObjects = dictOf(ctx, resources.get(XOBJECT));
  const madeXObjects = !foundXObjects;
  const xObjects = foundXObjects ?? ctx.obj({});
  if (madeXObjects) resources.set(XOBJECT, xObjects);
  // A name of its own, or the one an earlier page sharing these resources gave the form.
  let name = null;
  for (let i = 0; !name; i++) {
    const candidate = i === 0 ? FORM_NAME : `${FORM_NAME}${i}`;
    const there = ctx.lookup(xObjects.get(nm(candidate)));
    if (there === undefined || there === form) name = candidate;
  }
  xObjects.set(nm(name), formRef);

  const matrix = markMatrix(ctx, page, style);
  const after = ctx.stream(
    'Q\nq\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC\n'
      + `${matrix.map(number).join(' ')} cm\n/${name} Do\nEMC\nQ\n`,
  );
  const marker = ctx.obj({
    Size: style.size,
    Opacity: style.opacity,
    Matrix: matrix.map((v) => Number(number(v))),
  });
  marker.set(KEY_NAME, nm(name));
  if (was !== undefined) marker.set(KEY_WAS, was);
  if (madeXObjects) marker.set(KEY_MADE_XOBJECTS, PDFBool.True);
  if (madeResources) marker.set(KEY_MADE_RESOURCES, PDFBool.True);
  after.dict.set(MARKER, marker);
  const afterRef = ctx.register(after);
  const contents = PDFArray.withContext(ctx);
  contents.push(beforeRef);
  for (const item of contentsOf(ctx, page)) contents.push(item);
  contents.push(afterRef);
  page.set(CONTENTS, contents);
}

/**
 * Takes Usugami's mark off `doc`'s pages, in memory, and returns whether any had it. The tools make
 * their PDFs of the pages as they were, without it (loadPdf does this): once made, a PDF gets the
 * mark the setting asks for, or none. The bytes `doc` was read from aren't changed.
 * @param {PDFDocument} doc a pdf-lib document
 * @returns {boolean}
 */
export function unmark(doc) {
  const ctx = doc.context;
  let found = false;
  for (const page of pagesOf(doc)) if (unmarkPage(ctx, page)) found = true;
  return found;
}

/**
 * Whether every page of `doc` carries `style` (a MarkStyle or { size, opacity }) once, where it
 * goes on the page as shown now, and nothing else of the mark; with `style` null, whether no page
 * has any of it.
 */
export function carriesMark(doc, style) {
  const ctx = doc.context;
  const wanted = markStyle(style);
  return pagesOf(doc).every((page) => carries(ctx, page, wanted));
}

/** Whether any page of `doc` has any of Usugami's mark. */
export function hasMark(doc) {
  return !carriesMark(doc, null);
}

/**
 * Brings `doc` (in memory) to carry `style` on every page, or no mark when it is null, and returns
 * whether it changed. Every page's mark goes first: pages that share their resources then never find
 * another page's old mark there. Stops with CancelledError once `signal` is aborted, yielding to
 * the screen now and then.
 * @param {PDFDocument} doc
 * @param {MarkStyle|{ size: number, opacity: number }|null} style
 * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [hooks]
 * @returns {Promise<boolean>}
 */
export async function markDoc(doc, style, { signal, onProgress } = {}) {
  const ctx = doc.context;
  const wanted = markStyle(style);
  const pages = pagesOf(doc);
  if (pages.every((page) => carries(ctx, page, wanted))) return false;
  const total = pages.length * (wanted ? 2 : 1);
  let done = 0;
  let last = performance.now();
  const step = async () => {
    checkCancelled(signal);
    onProgress?.(++done, total);
    if (performance.now() - last > 16) {
      await yieldToUI();
      last = performance.now();
      checkCancelled(signal);
    }
  };
  for (const page of pages) {
    unmarkPage(ctx, page);
    await step();
  }
  if (wanted) {
    const form = makeForm(ctx, wanted);
    const formRef = ctx.register(form);
    const beforeRef = ctx.register(ctx.stream('q\n', { UsugamiMark: true }));
    for (const page of pages) {
      markPage(ctx, page, form, formRef, beforeRef, wanted);
      await step();
    }
  }
  return true;
}

/** How many objects pdf-lib reads or writes before it lets the screen in: quick, still responsive. */
const OBJECTS_PER_TICK = 1500;

/**
 * Brings the PDF `bytes` to carry `style` on every page (MarkStyle or { size, opacity }), or no mark
 * when it is null (PageMark.apply). Resolves with the new PDF's bytes, or null when `bytes` already
 * does (nothing to change). A PDF with a password can't be changed: UserError('mark_failed'). Stops
 * with CancelledError once `signal` is aborted; `bytes` are never changed.
 * @param {Uint8Array} bytes
 * @param {MarkStyle|{ size: number, opacity: number }|null} style
 * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [hooks]
 * @returns {Promise<Uint8Array|null>}
 */
export async function markPdf(bytes, style, hooks = {}) {
  const { signal } = hooks;
  const wanted = markStyle(style);
  checkCancelled(signal);
  // Without a mark to take off, there is nothing to read.
  if (!wanted && !mayCarryMark(bytes)) return null;
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false, parseSpeed: OBJECTS_PER_TICK });
  } catch (e) {
    // Saving it would take its password off. No tool's PDF has one.
    if (e instanceof EncryptedPDFError || /encrypt/i.test(e?.message ?? '')) throw new UserError('mark_failed');
    throw e;
  }
  checkCancelled(signal);
  if (!(await markDoc(doc, wanted, hooks))) return null;
  checkCancelled(signal);
  const out = await savePdf(doc, { objectsPerTick: OBJECTS_PER_TICK });
  checkCancelled(signal);
  return out;
}

/**
 * The PDF `bytes` (opened with `password`) without Usugami's mark, as the tools' previews show
 * pages (PdfToolsEngine.previewView): new bytes without the mark and without the password, or null
 * when it has no mark. Throws as loadPdf does (PasswordError, UserError('pdf_import_failed')).
 * @param {Uint8Array} bytes
 * @param {{ password?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<Uint8Array|null>}
 */
export async function unmarkPdf(bytes, { password, signal } = {}) {
  checkCancelled(signal);
  if (!mayCarryMark(bytes)) return null;
  const doc = await loadPdf(bytes, { password, unmark: false });
  checkCancelled(signal);
  if (!unmark(doc)) return null;
  const out = await savePdf(doc, { objectsPerTick: OBJECTS_PER_TICK });
  checkCancelled(signal);
  return out;
}
