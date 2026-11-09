// Split PDF, Merge PDF, Reorganize PDF, Delete pages and Rotate PDF (engine/organize.js), page
// selection (engine/page-selection.js) and the clean-up that makes removed pages really gone
// (engine/cleanup.js). Ports PdfPageSelectionTest.kt and the matching cases of the app's
// PdfToolsDeviceTest.kt and PageToolsDeviceTest.kt. Results are read back with pdf-lib (structure),
// pdf.js (text, labels, rendering) and by inflating every stream in the file.
//
//   node tests/organize.test.mjs
import zlib from 'node:zlib';
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFNumber, PDFRef, PDFNull,
  PDFRawStream, PDFStream, decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { withPage, assert, runInPage, saveOutput } from './harness.mjs';
import {
  parsePageSelection, parseRanges, fixedChunks, pagesToDelete, formatPages, formatPagesInOrder, PageSelectionError,
} from '../site/app/js/engine/page-selection.js';

const ENGINE = 'app/js/engine/organize.js';
const A4 = [595.28, 841.89];
const LETTER = [612, 792];
const WORDS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'];
const IMAGE_MARKERS = ['IMAGE ONE 111111', 'IMAGE TWO 222222', 'IMAGE THREE 3333'];
let checks = 0;

function check(condition, message) {
  assert(condition, message);
  checks++;
}

function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${message}: expected ${e}, got ${a}`);
}

function throwsProblem(fn, problem, message) {
  try {
    fn();
  } catch (e) {
    check(e instanceof PageSelectionError && e.problem === problem, `${message}: expected ${problem}, got ${e.problem ?? e.message}`);
    return e;
  }
  check(false, `${message}: expected ${problem}, nothing thrown`);
  return null;
}

// -----------------------------------------------------------------------------------------------
// PdfPageSelectionTest.kt

function pageSelectionTests() {
  equal(parsePageSelection('5,1,3-4,3', 6), [4, 0, 2, 3], 'Selected pages keep order and discard duplicates');
  equal(parseRanges('1-2;5;3-4', 6), [[0, 1], [4], [2, 3]], 'Custom ranges stay separate');
  equal(fixedChunks(5, 2), [[0, 1], [2, 3], [4]], 'Fixed ranges include the last short group');
  for (const input of ['', '0', '2-1', '7', '1,,2', 'one']) {
    let thrown = false;
    try { parsePageSelection(input, 6); } catch (e) { thrown = e instanceof PageSelectionError; }
    check(thrown, `"${input}" is rejected`);
  }
  throwsProblem(() => parseRanges('1-2;', 6), 'RANGES_FORMAT', 'A trailing ; is rejected');

  throwsProblem(() => parsePageSelection('one', 6), 'FORMAT', 'one');
  throwsProblem(() => parsePageSelection('', 6), 'FORMAT', 'blank');
  throwsProblem(() => parsePageSelection('7', 6), 'OUT_OF_RANGE', '7 of 6');
  throwsProblem(() => parsePageSelection('2-1', 6), 'REVERSED', '2-1');
  throwsProblem(() => parsePageSelection('5-2', 6), 'REVERSED', '5-2');
  // A range running backwards from a page that doesn't exist is out of range, as it says.
  throwsProblem(() => parsePageSelection('8-3', 6), 'OUT_OF_RANGE', '8-3');
  throwsProblem(() => parsePageSelection('99999999999', 6), 'OUT_OF_RANGE', 'a number too long');
  throwsProblem(() => parseRanges('1-99999999999', 6), 'OUT_OF_RANGE', 'a range end too long');
  // Custom ranges typed as a page list are told how ranges are written, not to use commas.
  throwsProblem(() => parseRanges('1-3,5', 6), 'RANGES_FORMAT', '1-3,5 as ranges');
  throwsProblem(() => parseRanges('1,3-5', 6), 'RANGES_FORMAT', '1,3-5 as ranges');
  throwsProblem(() => parseRanges('1-2;5-3', 6), 'REVERSED', '5-3 in ranges');
  throwsProblem(() => parseRanges('1-2;7', 6), 'OUT_OF_RANGE', '7 in ranges');
  throwsProblem(() => fixedChunks(3, 4), 'CHUNK_SIZE', '4 per PDF of 3');
  const outOfRange = throwsProblem(() => parsePageSelection('7', 6), 'OUT_OF_RANGE', 'page count kept');
  equal(outOfRange.pageCount, 6, 'The error knows the page count');
  equal([outOfRange.key, outOfRange.args], ['pdf_pages_range', [6]], 'Its message is pdf_pages_range with the count');

  equal(pagesToDelete('5-7,2,6', 10), [1, 4, 5, 6], 'Pages to delete are sorted');
  const all = throwsProblem(() => pagesToDelete('1-3,4', 4), 'ALL_PAGES', 'Deleting every page');
  equal([all.key, all.args], ['pdf_need_page', []], 'Keep at least one page');
  throwsProblem(() => pagesToDelete('5', 4), 'OUT_OF_RANGE', 'Deleting a page that is not there');

  equal(formatPages([6, 1, 4, 5]), '2,5-7', 'Pages are written as ranges');
  equal(formatPages(new Set([0])), '1', 'One page');
  equal(formatPages([3, 1, 0, 1]), '1-2,4', 'Sorted, each once');
  equal(formatPages([]), '', 'No pages');
  const pages = [0, 2, 3, 4, 8, 9, 11];
  equal(parsePageSelection(formatPages(pages), 12), pages, 'What it writes reads back');

  equal(formatPagesInOrder([9, 0, 1, 2, 4]), '10,1-3,5', 'Written in the order given');
  equal(formatPagesInOrder([]), '', 'None in order');
  equal(formatPagesInOrder([2, 1, 0]), '3,2,1', 'Only runs going up become ranges');
  equal(formatPagesInOrder([...Array(500).keys()].filter((p) => p !== 5)), '1-5,7-500', 'A long range with a gap');
  const ordered = [7, 2, 3, 4, 0, 11, 9, 10];
  equal(parsePageSelection(formatPagesInOrder(ordered), 12), ordered, 'In order, read back');

  for (const size of [0, -1, 4, '0', ' x ', '']) {
    const e = throwsProblem(() => fixedChunks(3, size), 'CHUNK_SIZE', `chunk size ${JSON.stringify(size)}`);
    equal([e.key, e.args], ['pdf_pages_chunk', [3]], 'Pages per PDF must be between 1 and 3');
  }
  equal(fixedChunks(5, ' 2 '), [[0, 1], [2, 3], [4]], 'Pages per PDF as typed');
  equal(fixedChunks(5, '+5'), [[0, 1, 2, 3, 4]], 'A plus sign, as Kotlin reads it');
  equal(parsePageSelection(' 2 - 3 , 1 ', 6), [1, 2, 0], 'Spaces around numbers');
}

// -----------------------------------------------------------------------------------------------
// Fixtures, made with pdf-lib. Text is written as literal strings, as the app's PDFBox fixtures
// do, so that what must be gone can be looked for in the file byte for byte.

const N = (name) => PDFName.of(name);
const S = (text) => PDFString.of(text);

async function newDoc() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.helv = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  return doc;
}

const save = (doc) => doc.save({ addDefaultPage: false, updateFieldAppearances: false, useObjectStreams: false });

/** A page saying `text`, with its own resources unless `resources` is given (a ref) or false (none). */
function textPage(doc, text, { size = A4, resources, extra = '' } = {}) {
  const page = doc.addPage(size);
  const ctx = doc.context;
  const content = `${extra} BT /F1 14 Tf 72 700 Td (${text}) Tj ET`;
  page.node.set(N('Contents'), ctx.register(ctx.flateStream(content)));
  if (resources === false) page.node.delete(N('Resources'));
  else page.node.set(N('Resources'), resources ?? ctx.obj({ Font: { F1: doc.helv } }));
  return page;
}

function link(doc, target, y) {
  return doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [72, y, 272, y + 20], Border: [0, 0, 0], Dest: [target, 'Fit'],
  }));
}

function addAnnots(page, refs) {
  const existing = page.node.lookup(N('Annots'));
  const annots = existing instanceof PDFArray ? existing : page.doc.context.obj([]);
  for (const ref of refs) annots.push(ref);
  page.node.set(N('Annots'), annots);
}

function outline(doc, items) {
  const ctx = doc.context;
  const rootRef = ctx.nextRef();
  const refs = items.map(() => ctx.nextRef());
  items.forEach((item, i) => {
    const dict = ctx.obj({ Title: S(item.title), Parent: rootRef, Dest: [item.page, 'Fit'] });
    if (i > 0) dict.set(N('Prev'), refs[i - 1]);
    if (i < items.length - 1) dict.set(N('Next'), refs[i + 1]);
    ctx.assign(refs[i], dict);
  });
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: items.length }));
  doc.catalog.set(N('Outlines'), rootRef);
  return refs;
}

function form(doc) {
  let acro = doc.catalog.lookup(N('AcroForm'));
  if (!acro) {
    acro = doc.context.obj({ Fields: [], DA: S('/Helv 12 Tf 0 g'), DR: { Font: { Helv: doc.helv } } });
    doc.catalog.set(N('AcroForm'), doc.context.register(acro));
  }
  return acro;
}

/** A filled text field called `name` on `page` that is its own widget, with an appearance showing `value`. */
function textField(doc, page, name, value, rect = [72, 400, 322, 424]) {
  const ctx = doc.context;
  const ap = ctx.register(ctx.flateStream(`/Tx BMC q BT /Helv 12 Tf 2 6 Td (${value}) Tj ET Q EMC`, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, rect[2] - rect[0], rect[3] - rect[1]], Resources: { Font: { Helv: doc.helv } },
  }));
  const field = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: S(name), V: S(value), DA: S('/Helv 12 Tf 0 g'),
    Rect: rect, P: page.ref, F: 4, AP: { N: ap },
  }));
  addAnnots(page, [field]);
  form(doc).lookup(N('Fields')).push(field);
  return field;
}

/**
 * Five A4 pages saying "PAGE ONE" to "PAGE FIVE" (TestPdfs.kt's chapters): a bookmark to each page
 * ("Chapter ONE"...), on page 1 links to pages 3 and 4 and to a web page, a named destination
 * "four" to page 4, a form field on page 1 ("keep", "KEEP VALUE") and one on page 4 ("secret",
 * "SECRET VALUE"), and on page 2 a comment with its popup ("SECRET NOTE"). The pages share one font.
 */
async function chapters({ named = false } = {}) {
  const doc = await newDoc();
  const pages = WORDS.map((w) => textPage(doc, `PAGE ${w}`));
  outline(doc, pages.map((p, i) => ({ title: `Chapter ${WORDS[i]}`, page: p.ref })));
  const ctx = doc.context;
  const web = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 520, 272, 540], A: { S: 'URI', URI: S('https://example.org/chapters') } }));
  addAnnots(pages[0], [link(doc, pages[2].ref, 600), link(doc, pages[3].ref, 560), web]);
  doc.catalog.set(N('Dests'), ctx.obj({ four: [pages[3].ref, 'Fit'] }));
  textField(doc, pages[0], 'keep', 'KEEP VALUE');
  textField(doc, pages[3], 'secret', 'SECRET VALUE');
  const note = ctx.nextRef();
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 600, 500, 700], Parent: note, P: pages[1].ref }));
  ctx.assign(note, ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 700, 320, 720], Contents: S('SECRET NOTE'), Popup: popup, P: pages[1].ref }));
  addAnnots(pages[1], [note, popup]);
  if (named) {
    // Links by name (to page 3, and to a name that leads nowhere) through a /Names /Dests tree.
    const leaf = (name, value) => ctx.obj({ Names: [S(name), value], Limits: [S(name), S(name)] });
    doc.catalog.set(N('Names'), ctx.obj({ Dests: { Kids: [ctx.register(leaf('bad', S('not a place'))), ctx.register(leaf('three', ctx.obj([pages[2].ref, 'Fit'])))] } }));
    addAnnots(pages[0], ['three', 'bad'].map((name) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 480, 272, 500], Dest: S(name) }))));
  }
  return save(doc);
}

/** Two pages with a form whose fields nest by page: topmostSubform[0].Page1[0].near and .Page2[0].far. */
async function nestedForm() {
  const doc = await newDoc();
  const ctx = doc.context;
  const pages = [0, 1].map((i) => textPage(doc, `PAGE ${WORDS[i]}`));
  const fields = form(doc).lookup(N('Fields'));
  const node = (name, parent) => {
    const ref = ctx.register(ctx.obj({ T: S(name), Kids: [] }));
    if (parent) {
      ctx.lookup(ref).set(N('Parent'), parent);
      ctx.lookup(parent).lookup(N('Kids')).push(ref);
    }
    return ref;
  };
  const widget = (dict, page) => {
    dict.set(N('Type'), N('Annot'));
    dict.set(N('Subtype'), N('Widget'));
    dict.set(N('Rect'), ctx.obj([72, 400, 322, 424]));
    dict.set(N('P'), page.ref);
    dict.set(N('F'), PDFNumber.of(4));
  };
  const top = node('topmostSubform[0]');
  fields.push(top);
  const near = node('near', node('Page1[0]', top));
  const nearDict = ctx.lookup(near);
  nearDict.delete(N('Kids'));
  nearDict.set(N('FT'), N('Tx'));
  nearDict.set(N('V'), S('NEAR VALUE'));
  widget(nearDict, pages[0]);
  addAnnots(pages[0], [near]);
  const far = node('far', node('Page2[0]', top));
  ctx.lookup(far).set(N('FT'), N('Tx'));
  ctx.lookup(far).set(N('V'), S('FAR VALUE'));
  const farWidget = ctx.register(ctx.obj({ Parent: far }));
  widget(ctx.lookup(farWidget), pages[1]);
  ctx.lookup(far).lookup(N('Kids')).push(farWidget);
  addAnnots(pages[1], [farWidget]);
  return save(doc);
}

/**
 * Three A4 pages saying "PAGE ONE" to "PAGE THREE", each drawing its own 16 by 2 pixel gray image
 * (IMAGE_MARKERS) large at (100, 300) to (500, 500), all in one list of resources the pages share
 * (with `inherited`, inherited from the page tree).
 */
async function sharedResources(inherited) {
  const doc = await newDoc();
  const ctx = doc.context;
  const images = IMAGE_MARKERS.map((m) => ctx.register(ctx.flateStream(m + m, {
    Type: 'XObject', Subtype: 'Image', Width: 16, Height: 2, BitsPerComponent: 8, ColorSpace: 'DeviceGray',
  })));
  const shared = ctx.register(ctx.obj({ Font: { F1: doc.helv }, XObject: { Im0: images[0], Im1: images[1], Im2: images[2] } }));
  [0, 1, 2].forEach((i) => textPage(doc, `PAGE ${WORDS[i]}`, { resources: inherited ? false : shared, extra: `q 400 0 0 200 100 300 cm /Im${i} Do Q` }));
  if (inherited) doc.catalog.lookup(N('Pages')).set(N('Resources'), shared);
  return save(doc);
}

/** Three tagged pages: figures with alternate text "SECRET ALT 1" to 3 (IDs fig1 to fig3), and a paragraph spanning pages 1 and 2. */
async function taggedPages() {
  const doc = await newDoc();
  const ctx = doc.context;
  const pages = [0, 1, 2].map((i) => {
    const page = textPage(doc, `PAGE ${WORDS[i]}`);
    page.node.set(N('StructParents'), PDFNumber.of(i));
    return page;
  });
  const rootRef = ctx.nextRef();
  const documentRef = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef }));
  const element = (type, page, extra) => ctx.register(ctx.obj({ Type: 'StructElem', S: type, P: documentRef, Pg: page.ref, ...extra }));
  const figures = pages.map((p, i) => element('Figure', p, { Alt: S(`SECRET ALT ${i + 1}`), K: 0, ID: S(`fig${i + 1}`) }));
  const paragraph = element('P', pages[0], { ActualText: S('SPANS PAGES'), K: [1, { Type: 'MCR', Pg: pages[1].ref, MCID: 1 }] });
  ctx.lookup(documentRef).set(N('K'), ctx.obj([...figures, paragraph]));
  const nums = [];
  pages.forEach((_, i) => nums.push(i, i < 2 ? [figures[i], paragraph] : [figures[i]]));
  const leaf = (...ids) => ctx.register(ctx.obj({ Names: ids.flatMap((i) => [S(`fig${i + 1}`), figures[i]]), Limits: [S(`fig${ids[0] + 1}`), S(`fig${ids[ids.length - 1] + 1}`)] }));
  ctx.assign(rootRef, ctx.obj({ Type: 'StructTreeRoot', K: documentRef, ParentTree: { Nums: nums }, IDTree: { Kids: [leaf(0, 1), leaf(2)] }, ParentTreeNextKey: 3 }));
  doc.catalog.set(N('StructTreeRoot'), rootRef);
  doc.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
  return save(doc);
}

/** Six pages numbered as a book's: i to iii, then 1 to 3 (or, `plain`, 1 to 6). */
async function labelledPages(plain = false) {
  const doc = await newDoc();
  for (let i = 0; i < 6; i++) textPage(doc, `PAGE ${i + 1}`);
  const nums = plain ? [0, { S: 'D' }] : [0, { S: 'r' }, 3, { S: 'D' }];
  doc.catalog.set(N('PageLabels'), doc.context.obj({ Nums: nums }));
  return save(doc);
}

/** "MAIN ONE" to "MAIN THREE"; pages 1 and 2 inherit US Letter and a quarter turn; page 1 links to page 3. */
async function nestedPages() {
  const doc = await newDoc();
  const ctx = doc.context;
  const pages = [0, 1, 2].map((i) => textPage(doc, `MAIN ${WORDS[i]}`));
  addAnnots(pages[0], [link(doc, pages[2].ref, 600)]);
  const rootRef = doc.catalog.get(N('Pages'));
  const node = ctx.register(ctx.obj({ Type: 'Pages', Parent: rootRef, Kids: [pages[0].ref, pages[1].ref], Count: 2, MediaBox: LETTER, Rotate: 90 }));
  for (const p of pages.slice(0, 2)) {
    p.node.delete(N('MediaBox'));
    p.node.set(N('Parent'), node);
  }
  ctx.lookup(rootRef).set(N('Kids'), ctx.obj([node, pages[2].ref]));
  return save(doc);
}

async function simple(prefix, count, sizes = []) {
  const doc = await newDoc();
  for (let i = 0; i < count; i++) textPage(doc, `${prefix} ${WORDS[i] ?? i + 1}`, { size: sizes[i] ?? A4 });
  return save(doc);
}

async function encrypted(bytes, algorithm, userPassword = 'test123') {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.encrypt({ userPassword, ownerPassword: 'owner456', algorithm, allowWeakCryptography: true });
  return doc.save({ addDefaultPage: false, updateFieldAppearances: false, useObjectStreams: false });
}

// -----------------------------------------------------------------------------------------------
// Reading results back

/** Everything the file holds as text: its bytes, every stream inflated, and strings decoded. */
function everythingIn(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const parts = [raw];
  const re = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const data = Buffer.from(bytes.subarray(start, end));
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        parts.push(inflate(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1'));
        break;
      } catch { /* not deflated */ }
    }
    re.lastIndex = end + 'endstream'.length;
  }
  return parts.join('\n');
}

/** Whether `text` is in the file in any form a PDF stores it: as it is, or in hex, also UTF-16. */
function holds(everything, text) {
  const hex = Buffer.from(text, 'latin1').toString('hex');
  const utf16 = Buffer.from(text, 'utf16le').swap16().toString('hex');
  const lower = everything.toLowerCase();
  return everything.includes(text) || lower.includes(hex) || lower.includes(utf16);
}

const load = (bytes) => PDFDocument.load(bytes, { updateMetadata: false });

function pageRefs(doc) {
  return doc.getPages().map((p) => p.ref);
}

function outlineItems(doc) {
  const items = [];
  const root = doc.catalog.lookup(N('Outlines'));
  let item = root?.lookup(N('First'));
  const seen = new Set();
  while (item instanceof PDFDict && !seen.has(item)) {
    seen.add(item);
    const dest = item.lookup(N('Dest'));
    items.push({ title: item.lookup(N('Title')).decodeText(), page: dest instanceof PDFArray ? dest.get(0) : undefined, dict: item });
    item = item.lookup(N('Next'));
  }
  return { root, items };
}

function annots(doc, index) {
  const page = doc.getPages()[index].node;
  const list = page.lookup(N('Annots'));
  if (!(list instanceof PDFArray)) return [];
  return list.asArray().map((a) => doc.context.lookup(a)).filter((a) => a instanceof PDFDict);
}

const subtype = (dict) => dict.lookup(N('Subtype'))?.decodeText();
const destPage = (doc, linkDict) => {
  const dest = linkDict.lookup(N('Dest'));
  if (!(dest instanceof PDFArray)) return undefined;
  const first = dest.get(0);
  return first === PDFNull ? null : first;
};

function fieldNames(doc) {
  const acro = doc.catalog.lookup(N('AcroForm'));
  const fields = acro?.lookup(N('Fields'));
  if (!(fields instanceof PDFArray)) return [];
  return fields.asArray().map((f) => doc.context.lookup(f).lookup(N('T'))?.decodeText());
}

function contentOf(doc, index) {
  const contents = doc.getPages()[index].node.lookup(N('Contents'));
  const streams = contents instanceof PDFArray ? contents.asArray().map((s) => doc.context.lookup(s)) : [contents];
  return streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join(' ');
}

const pdfIn = (name, bytes, extra = {}) => ({ name, bytes: { __b64: Buffer.from(bytes).toString('base64') }, ...extra });

/** Each page's text and the labels viewers show, read by pdf.js in the page. */
async function readBack(page, url, bytes, password) {
  return page.evaluate(async ({ src, b64, password }) => {
    const { openPdfJs } = await import(src);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await openPdfJs(data, { password });
    const texts = [];
    const sizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      texts.push((await p.getTextContent()).items.map((item) => item.str).join(''));
      const view = p.getViewport({ scale: 1 });
      sizes.push([Math.round(view.width), Math.round(view.height), p.rotate]);
    }
    const labels = await doc.getPageLabels();
    await doc.loadingTask.destroy();
    return { texts, labels, sizes };
  }, { src: new URL('app/js/lib/pdfjs.js', url).href, b64: Buffer.from(bytes).toString('base64'), password });
}

/** Renders page `index` at one pixel per point and counts dark pixels in `rect` ([left, bottom, right, top], y up). */
async function darkPixels(page, url, bytes, index, rect) {
  return page.evaluate(async ({ src, b64, index, rect }) => {
    const { openPdfJs } = await import(src);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await openPdfJs(data);
    const p = await doc.getPage(index + 1);
    const view = p.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(view.width);
    canvas.height = Math.round(view.height);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvasContext: g, viewport: view }).promise;
    const [left, bottom, right, top] = rect;
    const pixels = g.getImageData(left, canvas.height - top, right - left, top - bottom).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 120) dark++;
    await doc.loadingTask.destroy();
    return { dark, width: canvas.width, height: canvas.height };
  }, { src: new URL('app/js/lib/pdfjs.js', url).href, b64: Buffer.from(bytes).toString('base64'), index, rect });
}

async function rejects(promise, pattern, message) {
  try {
    await promise;
  } catch (e) {
    check(pattern.test(e.message), `${message}: got ${e.message.split('\n')[0]}`);
    return;
  }
  check(false, `${message}: expected an error`);
}

const squash = (texts) => texts.map((t) => t.replace(/\s+/g, ''));

// -----------------------------------------------------------------------------------------------
// The engines, in the browser

async function engineTests(page, url) {
  const call = (name, ...args) => runInPage(page, url, ENGINE, name, ...args);
  const alpha = await simple('ALPHA', 3);
  const beta = await simple('BETA', 2);
  const alphaIn = pdfIn('alpha.pdf', alpha);
  const betaIn = pdfIn('beta.pdf', beta);

  // --- Names (the view model's defaultName and FileNames)
  equal(await call('defaultName', 'split', { name: 'Report.pdf', pageCount: 12 }), 'Report_split', 'Split default name');
  equal(await call('defaultName', 'merge', { name: 'Report.pdf' }), 'Merged_PDF', 'Merge default name');
  equal(await call('defaultName', 'rotate', { name: 'Report.pdf' }), 'Report_rotated', 'Rotate default name');
  equal(await call('defaultName', 'delete-pages', { name: 'Report.pdf' }), 'Report_pages_deleted', 'Delete pages default name');
  equal(await call('defaultName', 'reorganize', { name: 'Report.pdf' }), 'Report_reorganized', 'Reorganize default name');
  const long = 'é'.repeat(150);
  const longSplit = await call('defaultName', 'split', { name: `${long}.pdf`, pageCount: 120 });
  check(longSplit.endsWith('_split') && Buffer.byteLength(longSplit) + '_12_120-120'.length <= 200, `A long name is cut, not its _split: ${longSplit.length}`);
  equal(await call('partSuffix', 1, [3, 4, 5]), '_2_4-6', 'Part suffix');
  const named = await page.evaluate(async (src) => {
    const { fileNames } = await import(src);
    return [fileNames.sanitize(' a/b ', 'X'), fileNames.sanitize('Report.pdf.', 'X'), fileNames.sanitize('CON', 'X'), fileNames.sanitize('nul.notes', 'X'),
      fileNames.sanitize('  ', 'X'), fileNames.unique('report', new Set(['Report', 'report (2)'])), fileNames.sanitize('..hidden', 'X')];
  }, new URL(ENGINE, url).href);
  equal(named, ['a_b', 'Report', 'CON_', 'nul_.notes', 'X', 'report (3)', 'hidden'], 'File names are made safe as the app makes them');

  // --- splitMergeCompressAndPasswords (PdfToolsDeviceTest)
  const selected = await call('splitPdf', alphaIn, { groups: [[0, 2]], fileName: 'selected' });
  equal(selected.map((f) => [f.name, f.type, f.pageCount]), [['selected.pdf', 'application/pdf', 2]], 'One part, named as typed');
  let back = await readBack(page, url, selected[0].bytes);
  equal(squash(back.texts), ['ALPHAONE', 'ALPHATHREE'], 'The selected pages, without ALPHA TWO');
  check(!holds(everythingIn(selected[0].bytes), 'ALPHA TWO'), 'ALPHA TWO is nowhere in the part');
  await saveOutput('organize_split_selected.pdf', selected[0].bytes);

  const chunks = await call('splitPdf', alphaIn, { groups: [[0, 1], [2]], fileName: 'chunks' });
  equal(chunks.map((f) => [f.name, f.pageCount]), [['chunks_1_1-2.pdf', 2], ['chunks_2_3-3.pdf', 1]], 'Parts are named by number and pages');

  // The screen's choices, as runSplit reads them.
  const sel = await call('splitPdf', alphaIn, { mode: 'selected', pages: '3,1', combine: true });
  equal(sel.map((f) => f.name), ['alpha_split.pdf'], 'Selected pages combined, default name');
  equal(squash((await readBack(page, url, sel[0].bytes)).texts), ['ALPHATHREE', 'ALPHAONE'], 'In the order typed');
  const each = await call('splitPdf', alphaIn, { mode: 'selected', pages: '3,1', combine: false });
  equal(each.map((f) => f.name), ['alpha_split_1_3-3.pdf', 'alpha_split_2_1-1.pdf'], 'One PDF per selected page');
  equal((await call('splitPdf', alphaIn, { mode: 'selected', pages: '3,1' })).length, 1, 'Combined unless asked not to, as on the screen');
  equal((await call('splitGroups', { mode: 'custom', pages: '1-2;3', combine: false }, 3)), [[0, 1], [2]], 'Ranges apart');
  equal((await call('splitGroups', { mode: 'EVERY_PAGE' }, 2)), [[0], [1]], 'The app\'s mode names');
  const custom = await call('splitPdf', alphaIn, { mode: 'custom', pages: '1-2;2-3', combine: true });
  equal([custom.length, custom[0].pageCount], [1, 4], 'Ranges combined, a page twice');
  equal(squash((await readBack(page, url, custom[0].bytes)).texts), ['ALPHAONE', 'ALPHATWO', 'ALPHATWO', 'ALPHATHREE'], 'A page in two ranges appears twice');
  const fixed = await call('splitPdf', alphaIn, { mode: 'fixed', pagesPerFile: '2' });
  equal(fixed.map((f) => f.pageCount), [2, 1], 'Fixed chunks');
  const every = await call('splitPdf', alphaIn, { mode: 'every' });
  equal(every.map((f) => f.name), ['alpha_split_1_1-1.pdf', 'alpha_split_2_2-2.pdf', 'alpha_split_3_3-3.pdf'], 'Every page');
  const clash = await call('splitPdf', alphaIn, { groups: [[0], [0]], fileName: 'same' });
  equal(clash.map((f) => f.name), ['same_1_1-1.pdf', 'same_2_1-1.pdf'], 'Parts keep their own names');
  await rejects(call('splitPdf', alphaIn, { mode: 'custom', pages: '1-3,5' }), /pdf_ranges_format/, 'Custom ranges typed with commas');
  await rejects(call('splitPdf', alphaIn, { mode: 'fixed', pagesPerFile: '4' }), /pdf_pages_chunk/, 'Chunks bigger than the PDF');
  await rejects(call('splitPdf', alphaIn, { groups: [[3]] }), /pdf_pages_range/, 'A page that is not there');

  const merged = await call('mergePdfs', [betaIn, alphaIn], { fileName: 'merged' });
  equal([merged.name, merged.pageCount], ['merged.pdf', 5], 'Merged, named as typed');
  back = await readBack(page, url, merged.bytes);
  equal(squash(back.texts), ['BETAONE', 'BETATWO', 'ALPHAONE', 'ALPHATWO', 'ALPHATHREE'], 'In the order of the PDFs');
  equal((await call('mergePdfs', [alphaIn, betaIn], {})).name, 'Merged_PDF.pdf', 'Merge default name');

  const pagesMerged = await call('mergePdfs', [alphaIn, betaIn], { pages: [{ input: 0, page: 2, rotation: 90 }, { input: 1, page: 0 }, { input: 0, page: 0 }], fileName: 'edited' });
  equal(pagesMerged.pageCount, 3, 'Merge page mode: three pages');
  back = await readBack(page, url, pagesMerged.bytes);
  equal(squash(back.texts), ['ALPHATHREE', 'BETAONE', 'ALPHAONE'], 'Merge page mode order');
  equal(back.sizes.map((s) => s[2]), [90, 0, 0], 'The page turned a quarter');
  check(!holds(everythingIn(pagesMerged.bytes), 'ALPHA TWO') && !holds(everythingIn(pagesMerged.bytes), 'BETA TWO'), 'Pages left out of the merge are gone');
  // Inputs by id, as the screen keeps them.
  const byId = await call('mergePdfs', [pdfIn('a.pdf', alpha, { id: 'a' }), pdfIn('b.pdf', beta, { id: 'b' })], { pages: [{ input: 'b', page: 1 }, { input: 'a', page: 1, rotation: -90 }] });
  back = await readBack(page, url, byId.bytes);
  equal([squash(back.texts), back.sizes.map((s) => s[2])], [['BETATWO', 'ALPHATWO'], [0, 270]], 'Pages by PDF id, turned left');
  await rejects(call('mergePdfs', [alphaIn], {}), /pdf_need_two/, 'Merging one PDF');

  // Passwords: alpha locked with "test123", by AES-256 and the older RC4 and AES-128.
  for (const algorithm of ['AES-256', 'RC4-128', 'AES-128']) {
    // Locked only against changes (an owner password, none to open it): it opens as it is.
    const ownerOnly = await call('deletePages', pdfIn('owner.pdf', await encrypted(alpha, algorithm, '')), [0]);
    equal(squash((await readBack(page, url, ownerOnly.bytes)).texts), ['ALPHATWO', 'ALPHATHREE'], `${algorithm}: a PDF with only an owner password`);
    const locked = await encrypted(alpha, algorithm);
    await rejects(call('splitPdf', pdfIn('protected.pdf', locked), { groups: [[1]] }), /Password|password/, `${algorithm}: no password`);
    await rejects(call('splitPdf', pdfIn('protected.pdf', locked, { password: 'wrong' }), { groups: [[1]] }), /Password|password/, `${algorithm}: a wrong password`);
    const lockedIn = pdfIn('protected.pdf', locked, { password: 'test123' });
    const part = await call('splitPdf', lockedIn, { groups: [[1]], fileName: 'protected_split' });
    check(part[0].passwordRemoved === true, `${algorithm}: the result says its password went`);
    equal(squash((await readBack(page, url, part[0].bytes)).texts), ['ALPHATWO'], `${algorithm}: split of a protected PDF`);
    check(!(await load(part[0].bytes)).isEncrypted && !everythingIn(part[0].bytes).includes('/Encrypt'), `${algorithm}: the part has no password`);
    for (const [name, result] of [
      ['merge', await call('mergePdfs', [lockedIn, betaIn], { pages: [{ input: 0, page: 2 }, { input: 1, page: 0 }] })],
      ['delete', await call('deletePages', lockedIn, [0])],
      ['reorganize', await call('reorganizePdf', alphaIn, [{ page: 0 }, { input: 0, page: 2 }], [lockedIn])],
      ['rotate', await call('rotatePdf', lockedIn, { 1: 90 })],
    ]) {
      const texts = squash((await readBack(page, url, result.bytes)).texts);
      check(texts.some((t) => t === 'ALPHATHREE') && !(await load(result.bytes)).isEncrypted, `${algorithm}: ${name} of a protected PDF has no password (${texts})`);
      check(result.passwordRemoved === true, `${algorithm}: ${name} says its password went`);
    }
  }

  // --- deletedPagesAreGoneFromTheFile (PageToolsDeviceTest)
  const chaptersPdf = await chapters();
  const chaptersIn = pdfIn('chapters.pdf', chaptersPdf);
  const source = everythingIn(chaptersPdf);
  check(['SECRET VALUE', 'SECRET NOTE', 'Chapter FOUR', 'PAGE FOUR'].every((t) => holds(source, t)), 'The fixture holds the words checked below');
  const deleted = await call('deletePages', chaptersIn, { pages: [3, 1], fileName: 'chapters_pages_deleted' });
  equal([deleted.name, deleted.pageCount], ['chapters_pages_deleted.pdf', 3], 'Delete pages: name and count');
  await saveOutput('organize_pages_deleted.pdf', deleted.bytes);
  equal(squash((await readBack(page, url, deleted.bytes)).texts), ['PAGEONE', 'PAGETHREE', 'PAGEFIVE'], 'Pages 2 and 4 deleted');
  let everything = everythingIn(deleted.bytes);
  for (const gone of ['PAGE TWO', 'PAGE FOUR', 'SECRET VALUE', 'SECRET NOTE', 'Chapter TWO', 'Chapter FOUR']) check(!holds(everything, gone), `"${gone}" is still in the file`);
  let doc = await load(deleted.bytes);
  let refs = pageRefs(doc);
  const { root, items } = outlineItems(doc);
  equal(items.map((i) => i.title), ['Chapter ONE', 'Chapter THREE', 'Chapter FIVE'], 'Their bookmarks went');
  equal(root.lookup(N('Count')).asNumber(), 3, 'The outline counts the bookmarks left');
  check(items.every((item, i) => item.page === refs[i]), 'The bookmarks left still lead to their pages');
  const links = annots(doc, 0).filter((a) => subtype(a) === 'Link');
  equal(links.length, 3, 'Page 1 keeps its links');
  check(destPage(doc, links[0]) === refs[1], 'The link to page 3 still works');
  check(destPage(doc, links[1]) === null, 'The link to page 4 leads nowhere now');
  equal(links[2].lookup(N('A')).lookup(N('URI')).decodeText(), 'https://example.org/chapters', 'The web link stays');
  equal(fieldNames(doc), ['keep'], "Page 4's field went with it");
  equal(doc.context.lookup(doc.catalog.lookup(N('AcroForm')).lookup(N('Fields')).get(0)).lookup(N('V')).decodeText(), 'KEEP VALUE', "Page 1's field stays, filled in");
  check(doc.catalog.lookup(N('Dests')).lookup(N('four')).get(0) === PDFNull, 'The named destination to page 4 is emptied');
  // Typed as on the screen.
  equal((await call('deletePages', chaptersIn, '2,4-5')).pageCount, 2, 'Pages typed like 2,4-5');
  await rejects(call('deletePages', alphaIn, [0, 1, 2]), /pdf_need_page/, 'Deleting every page is refused');
  await rejects(call('deletePages', alphaIn, '1-3'), /pdf_need_page/, 'Typing every page is refused');
  await rejects(call('deletePages', alphaIn, [5]), /pdf_pages_range/, 'Deleting a page that is not there');

  // --- mergePagesLeftOutAreGoneFromTheFile
  const leftOut = await call('mergePdfs', [chaptersIn, alphaIn], { pages: [{ input: 0, page: 0 }, { input: 1, page: 0 }, { input: 0, page: 2 }], fileName: 'merged' });
  everything = everythingIn(leftOut.bytes);
  for (const gone of ['PAGE TWO', 'PAGE FOUR', 'PAGE FIVE', 'SECRET VALUE', 'SECRET NOTE', 'Chapter FOUR', 'ALPHA TWO']) check(!holds(everything, gone), `Merge: "${gone}" is still in the file`);
  check(holds(everything, 'KEEP VALUE'), 'Merge keeps page 1 field');
  doc = await load(leftOut.bytes);
  refs = pageRefs(doc);
  const mergedOutline = outlineItems(doc);
  equal(mergedOutline.items.map((i) => i.title), ['Chapter ONE', 'Chapter THREE'], 'Merge keeps the bookmarks of the pages kept');
  check(mergedOutline.items[0].page === refs[0] && mergedOutline.items[1].page === refs[2], 'and they lead to their pages');
  check(destPage(doc, annots(doc, 0)[0]) === refs[2], 'A link between kept pages still works in a merge');

  // --- Merge whole PDFs: bookmarks of both, fields of both (renamed when they clash), links by name.
  const twice = await call('mergePdfs', [chaptersIn, pdfIn('chapters2.pdf', await chapters({ named: true }))], {});
  doc = await load(twice.bytes);
  refs = pageRefs(doc);
  const both = outlineItems(doc);
  equal(both.items.length, 10, 'Both PDFs bookmarks');
  equal(both.root.lookup(N('Count')).asNumber(), 10, 'counted');
  check(both.items.every((item, i) => item.page === refs[i]), 'each leading to its own page');
  equal(fieldNames(doc), ['keep', 'secret', 'keep_2', 'secret_2'], 'Fields of the same names are told apart');
  const named2 = annots(doc, 5).filter((a) => subtype(a) === 'Link');
  check(destPage(doc, named2[0]) === refs[7], 'The second PDF links still lead to its own pages');
  check(destPage(doc, named2[3]) === refs[7], 'A link by name leads to its page');

  // --- splitPartsHoldOnlyTheirOwnPages
  const part = await call('splitPdf', chaptersIn, { groups: [[0]], fileName: 'part' });
  equal(squash((await readBack(page, url, part[0].bytes)).texts), ['PAGEONE'], 'Part of page 1');
  everything = everythingIn(part[0].bytes);
  for (const gone of ['PAGE TWO', 'PAGE THREE', 'PAGE FOUR', 'PAGE FIVE', 'SECRET VALUE', 'SECRET NOTE']) check(!holds(everything, gone), `"${gone}" is in the part`);
  check(holds(everything, 'KEEP VALUE'), "Page 1's own field stays");
  doc = await load(part[0].bytes);
  equal(fieldNames(doc), ['keep'], 'The part has a form with its own field');
  const partLinks = annots(doc, 0).filter((a) => subtype(a) === 'Link');
  check(destPage(doc, partLinks[0]) === null && destPage(doc, partLinks[1]) === null, 'Links to pages left out lead nowhere');
  check(partLinks[2].lookup(N('A')) instanceof PDFDict, 'The web link stays');
  check(doc.context.lookup(annots(doc, 0).find((a) => subtype(a) === 'Widget').get(N('P'))) === doc.getPages()[0].node, 'Its widget names its page');

  const parts = await call('splitPdf', chaptersIn, { mode: 'every' });
  for (const [index, file] of parts.entries()) {
    const all = everythingIn(file.bytes);
    WORDS.forEach((word, other) => check(holds(all, `PAGE ${word}`) === (index === other), `Part ${index + 1} has "PAGE ${word}": ${index === other}`));
    check(holds(all, 'SECRET VALUE') === (index === 3), `Only page 4's part has its field (part ${index + 1})`);
    check(holds(all, 'SECRET NOTE') === (index === 1), `Only page 2's part has its comment (part ${index + 1})`);
  }

  // Fields that nest by page share their parents: each part still has only its page's values.
  const nestedIn = pdfIn('nested.pdf', await nestedForm());
  const halves = await call('splitPdf', nestedIn, { groups: [[0], [1]], fileName: 'nested' });
  for (const [index, half] of halves.entries()) {
    const all = everythingIn(half.bytes);
    check(holds(all, 'NEAR VALUE') === (index === 0), `Part ${index + 1} has page 1's value: ${index === 0}`);
    check(holds(all, 'FAR VALUE') === (index === 1), `Part ${index + 1} has page 2's value: ${index === 1}`);
    equal(fieldNames(await load(half.bytes)), ['topmostSubform[0]'], `Part ${index + 1} keeps the field tree's top`);
  }
  const nestedDeleted = await call('deletePages', nestedIn, [1]);
  check(!holds(everythingIn(nestedDeleted.bytes), 'FAR VALUE') && holds(everythingIn(nestedDeleted.bytes), 'NEAR VALUE'), 'Deleting page 2 takes its nested field');

  // --- linksBetweenPagesOfAPartStillWork
  const linked = pdfIn('links.pdf', await chapters({ named: true }));
  const linkParts = await call('splitPdf', linked, { groups: [[0, 1], [0, 2]], fileName: 'links' });
  doc = await load(linkParts[1].bytes);
  refs = pageRefs(doc);
  const l = annots(doc, 0).filter((a) => subtype(a) === 'Link');
  check(destPage(doc, l[0]) === refs[1], 'The link leads to page 2 of the part');
  check(destPage(doc, l[1]) === null, 'The link to page 4, left out, leads nowhere');
  check(destPage(doc, l[3]) === refs[1], 'The link by name leads to page 2 of the part');
  check(!holds(everythingIn(linkParts[1].bytes), 'PAGE FOUR'), 'No PAGE FOUR in the part');
  check(!holds(everythingIn(linkParts[0].bytes), 'PAGE THREE'), 'The first part, without page 3, holds none of it');

  // --- picturesOfRemovedPagesGoThoughPagesShareResources
  for (const inherited of [false, true]) {
    const sharedPdf = await sharedResources(inherited);
    const sharedIn = pdfIn(`shared_${inherited}.pdf`, sharedPdf);
    check(IMAGE_MARKERS.every((m) => holds(everythingIn(sharedPdf), m)), 'The fixture holds every image');
    const assertImages = (bytes, kept, what) => {
      const all = everythingIn(bytes);
      IMAGE_MARKERS.forEach((marker, i) => check(holds(all, marker) === kept.includes(i), `${what} (inherited: ${inherited}) has image ${i + 1}: ${kept.includes(i)}`));
    };
    const assertDrawn = async (bytes, count, what) => {
      for (let i = 0; i < count; i++) {
        const { dark } = await darkPixels(page, url, bytes, i, [110, 310, 490, 490]);
        check(dark > 30000, `${what} (inherited: ${inherited}): page ${i + 1} shows its image (${dark})`);
      }
    };
    const del = await call('deletePages', sharedIn, [1]);
    equal(squash((await readBack(page, url, del.bytes)).texts), ['PAGEONE', 'PAGETHREE'], 'Delete pages with shared resources');
    assertImages(del.bytes, [0, 2], 'Delete pages');
    await assertDrawn(del.bytes, 2, 'Delete pages');
    const reo = await call('reorganizePdf', sharedIn, [{ page: 2 }, { page: 0 }]);
    assertImages(reo.bytes, [0, 2], 'Reorganize');
    await assertDrawn(reo.bytes, 2, 'Reorganize');
    const mer = await call('mergePdfs', [sharedIn, alphaIn], { pages: [{ input: 0, page: 0 }, { input: 1, page: 0 }, { input: 0, page: 2 }] });
    assertImages(mer.bytes, [0, 2], 'Merge');
    const spl = await call('splitPdf', sharedIn, { groups: [[0], [1, 2]] });
    assertImages(spl[0].bytes, [0], "Split's first part");
    assertImages(spl[1].bytes, [1, 2], "Split's second part");
    await assertDrawn(spl[1].bytes, 2, 'Split');
  }

  // --- splitKeepsJpeg2000Images
  {
    const d = await newDoc();
    const ctx = d.context;
    const jpx = ctx.register(PDFRawStream.of(ctx.obj({ Type: 'XObject', Subtype: 'Image', Filter: 'JPXDecode', Width: 16, Height: 16 }), new TextEncoder().encode('NOT REALLY JPEG 2000')));
    const shared = ctx.register(ctx.obj({ XObject: { Im0: jpx } }));
    for (const content of ['q 400 0 0 400 100 300 cm /Im0 Do Q', '']) {
      const p = d.addPage(A4);
      p.node.set(N('Resources'), shared);
      p.node.set(N('Contents'), ctx.register(ctx.flateStream(content)));
    }
    const jpxParts = await call('splitPdf', pdfIn('jpx.pdf', await save(d)), { groups: [[0], [1]] });
    const filterOf = async (bytes) => {
      const out = await load(bytes);
      const xobjects = out.getPages()[0].node.lookup(N('Resources')).lookup(N('XObject'));
      return xobjects?.lookup(N('Im0'))?.dict?.lookup(N('Filter'))?.decodeText();
    };
    equal(await filterOf(jpxParts[0].bytes), 'JPXDecode', 'The page that draws a JPEG 2000 image keeps it');
    equal(await filterOf(jpxParts[1].bytes), undefined, 'The other page leaves it out');
  }

  // --- aLoopingOutlineDoesntHoldUpDeletingPages
  {
    const d = await newDoc();
    const pages = [0, 1].map((i) => textPage(d, `LOOP ${i}`));
    const refsLoop = outline(d, [0, 1, 2, 3].map((i) => ({ title: `Chapter ${i}`, page: pages[i % 2].ref })));
    for (const r of refsLoop) d.context.lookup(r).set(N('First'), refsLoop[0]);
    const started = Date.now();
    const out = await call('deletePages', pdfIn('loop.pdf', await save(d)), [1]);
    equal(out.pageCount, 1, 'A looping outline: one page left');
    check(Date.now() - started < 20000, 'and quickly');
  }

  // --- tagsOfDeletedPagesGo
  const taggedIn = pdfIn('tagged.pdf', await taggedPages());
  for (const [what, result] of [
    ['Delete pages', await call('deletePages', taggedIn, [1])],
    ['Reorganize', await call('reorganizePdf', taggedIn, [{ page: 2 }, { page: 0 }])],
  ]) {
    everything = everythingIn(result.bytes);
    check(!holds(everything, 'SECRET ALT 2'), `${what}: page 2's alternate text is gone`);
    for (const kept of ['SECRET ALT 1', 'SECRET ALT 3', 'SPANS PAGES']) check(holds(everything, kept), `${what} keeps "${kept}"`);
    doc = await load(result.bytes);
    const treeRoot = doc.catalog.lookup(N('StructTreeRoot'));
    const documentElement = treeRoot.lookup(N('K'));
    const elements = documentElement.lookup(N('K')).asArray().map((e) => doc.context.lookup(e)).filter((e) => e instanceof PDFDict);
    equal(elements.map((e) => e.lookup(N('S')).decodeText()), ['Figure', 'Figure', 'P'], `${what}: the figures left and the paragraph`);
    const leaves = treeRoot.lookup(N('IDTree')).lookup(N('Kids')).asArray().map((k) => doc.context.lookup(k));
    const leafNames = leaves.flatMap((leaf) => leaf.lookup(N('Names')).asArray().filter((_, i) => i % 2 === 0).map((s) => s.decodeText()));
    equal(leafNames, ['fig1', 'fig3'], `${what}: the IDs left`);
    equal(leaves[0].lookup(N('Limits')).get(1).decodeText(), 'fig1', `${what}: the first leaf's limits are put right`);
  }

  // --- Merging tagged PDFs: both trees, numbered apart.
  {
    const out = await call('mergePdfs', [taggedIn, alphaIn, taggedIn], {});
    doc = await load(out.bytes);
    const treeRoot = doc.catalog.lookup(N('StructTreeRoot'));
    const kids = treeRoot.lookup(N('K')).asArray().map((k) => doc.context.lookup(k));
    equal(kids.map((k) => k.lookup(N('S')).decodeText()), ['Document', 'Document'], 'Both tagged PDFs tags are joined');
    equal(doc.getPages().map((p) => p.node.lookup(N('StructParents'))?.asNumber() ?? null), [0, 1, 2, null, null, null, 3, 4, 5], 'Pages numbered apart, untagged ones without numbers');
    equal(treeRoot.lookup(N('ParentTreeNextKey')).asNumber(), 6, 'The next key goes on');
    const nums = treeRoot.lookup(N('ParentTree')).lookup(N('Nums'));
    equal(nums.asArray().filter((_, i) => i % 2 === 0).map((n) => n.asNumber()), [0, 1, 2, 3, 4, 5], 'The parent tree holds both');
    const secondFigure = doc.context.lookup(doc.context.lookup(nums.get(7)).get(0));
    check(secondFigure.get(N('Pg')) === doc.getPages()[6].ref, "The second PDF's figure is on its own page");
    check(doc.catalog.lookup(N('MarkInfo'))?.lookup(N('Marked'))?.asBoolean() === true, 'Marked as tagged');
  }

  // --- pagesKeepTheirLabels
  const bookIn = pdfIn('book.pdf', await labelledPages());
  const labelsOf = async (bytes) => (await readBack(page, url, bytes)).labels ?? (await readBack(page, url, bytes)).texts.map((_, i) => `${i + 1}`);
  equal(await labelsOf(await labelledPages()), ['i', 'ii', 'iii', '1', '2', '3'], 'The book fixture');
  equal(await labelsOf((await call('deletePages', bookIn, [0])).bytes), ['ii', 'iii', '1', '2', '3'], 'Without its cover');
  equal(await labelsOf((await call('deletePages', bookIn, [1, 3])).bytes), ['i', 'iii', '2', '3'], 'Fewer pages');
  const reversed = [5, 4, 3, 2, 1, 0].map((p) => ({ page: p })).concat([{ blank: true, width: 300, height: 400 }]);
  equal(await labelsOf((await call('reorganizePdf', bookIn, reversed)).bytes), ['3', '2', '1', 'iii', 'ii', 'i', 'ii'], 'Reversed, with a blank page at the end');
  const book = await labelledPages();
  const mixed = [{ input: 0, page: 2 }, { input: 0, page: 0 }, { input: 1, page: 4 }, { input: 0, page: 1 }, { input: 1, page: 1 }];
  equal(await labelsOf((await call('mergePdfs', [alphaIn, pdfIn('book.pdf', book)], { pages: mixed })).bytes), ['1', '2', '2', '3', 'ii'], 'A PDF without labels goes on from the page before');
  const added = [{ page: 3 }, { input: 0, page: 1 }, { input: 0, page: 0 }, { page: 0 }];
  equal(await labelsOf((await call('reorganizePdf', bookIn, added, [alphaIn])).bytes), ['1', '2', '3', 'i'], 'Pages added from a PDF without labels');
  const joined = await call('mergePdfs', [alphaIn, bookIn], {});
  equal(await labelsOf(joined.bytes), ['1', '2', '3', 'i', 'ii', 'iii', '1', '2', '3'], 'Joined whole, the one without labels first');
  equal((await load(joined.bytes)).catalog.lookup(N('PageLabels')).lookup(N('Nums')).get(0).asNumber(), 0, 'Labels from the first page on');
  const plainDeleted = await call('deletePages', pdfIn('plain.pdf', await labelledPages(true)), [2]);
  equal(await labelsOf(plainDeleted.bytes), ['1', '2', '3', '4', '5'], 'Labels that are just the places follow the new places');
  check(!(await load(plainDeleted.bytes)).catalog.has(N('PageLabels')), 'and are left out');

  // --- reorganizeKeepsOrderTurnsAddedAndBlankPages
  const mainIn = pdfIn('nested.pdf', await nestedPages(), { id: 7 });
  const plan = [
    { input: 7, page: 2, rotation: 90 },
    { input: 'beta', page: 0 },
    { page: 0 },
    { blank: true, width: 300, height: 400 },
    { input: 'beta', page: 1, rotation: 180 },
  ];
  const reorganized = await call('reorganizePdf', mainIn, { pages: plan, fileName: 'nested_reorganized' }, [pdfIn('beta.pdf', beta, { id: 'beta' })]);
  await saveOutput('organize_reorganized.pdf', reorganized.bytes);
  equal([reorganized.name, reorganized.pageCount], ['nested_reorganized.pdf', 5], 'Reorganized: name and count');
  back = await readBack(page, url, reorganized.bytes);
  equal(squash(back.texts), ['MAINTHREE', 'BETAONE', 'MAINONE', '', 'BETATWO'], 'Order, added and blank pages');
  check(!holds(everythingIn(reorganized.bytes), 'MAIN TWO'), 'The page left out is gone');
  doc = await load(reorganized.bytes);
  refs = pageRefs(doc);
  equal(doc.getPages().map((p) => p.getRotation().angle), [90, 0, 90, 0, 180], 'Turned on top of the turn they had');
  equal(doc.getPages()[2].getSize(), { width: 612, height: 792 }, 'MAIN ONE keeps the US Letter size it inherited');
  equal(doc.getPages()[3].getSize(), { width: 300, height: 400 }, 'The blank page');
  check(destPage(doc, annots(doc, 2).find((a) => subtype(a) === 'Link')) === refs[0], "MAIN ONE's link to MAIN THREE still leads there, now page 1");
  const first = await darkPixels(page, url, reorganized.bytes, 0, [0, 0, 1, 1]);
  check(first.width > first.height, 'A page turned a quarter is shown sideways');
  equal(await call('blankPageAfter', { width: 595, height: 842 }, 90), { blank: true, width: 842, height: 595, rotation: 0 }, 'A blank page after a sideways page lies sideways');
  equal(await call('shownPageSize', mainIn, 0), { width: 792, height: 612 }, 'A page shown sideways');
  equal(await call('shownPageSize', mainIn, 2), { width: 595.28, height: 841.89 }, 'A page shown upright');
  await rejects(call('reorganizePdf', alphaIn, []), /pdf_need_page/, 'Reorganizing to no page');

  // Reorganize keeps the PDF's bookmarks, fields and links of the pages kept, and takes in those of a PDF added.
  {
    const out = await call('reorganizePdf', chaptersIn, [{ page: 4 }, { page: 0 }, { input: 0, page: 1 }], [chaptersIn]);
    doc = await load(out.bytes);
    refs = pageRefs(doc);
    const o = outlineItems(doc);
    equal(o.items.map((i) => i.title), ['Chapter ONE', 'Chapter FIVE', 'Chapter TWO'], 'Bookmarks of the pages kept, the added PDF\'s after');
    equal([o.items[0].page === refs[1], o.items[1].page === refs[0], o.items[2].page === refs[2]], [true, true, true], 'each leading to its page');
    equal(fieldNames(doc), ['keep'], 'Fields of pages kept only');
    everything = everythingIn(out.bytes);
    check(!holds(everything, 'SECRET VALUE') && !holds(everything, 'PAGE FOUR') && holds(everything, 'SECRET NOTE'), 'Pages left out of a reorganize are gone; the page added keeps its comment');
  }

  // --- aDamagedPageTreeIsMended (PdfToolsDeviceTest): miscounted, a page without its type, a loop.
  {
    const d = await newDoc();
    const ctx = d.context;
    const pages = [0, 1, 2].map((i) => textPage(d, `PAGE ${WORDS[i]}`));
    const rootRef = d.catalog.get(N('Pages'));
    const node = (count, held) => {
      const ref = ctx.register(ctx.obj({ Type: 'Pages', Parent: rootRef, Kids: held.map((p) => p.ref), Count: count }));
      for (const p of held) p.node.set(N('Parent'), ref);
      return ref;
    };
    ctx.lookup(rootRef).set(N('Kids'), ctx.obj([node(1, [pages[0], pages[1]]), node(2, [pages[2]]), rootRef]));
    ctx.lookup(rootRef).set(N('Count'), PDFNumber.of(5));
    pages[1].node.delete(N('Type'));
    const damagedIn = pdfIn('damaged_tree.pdf', await save(d));
    equal(await call('countPages', damagedIn), 3, 'The damaged tree has the three pages viewers show');
    const left = await call('deletePages', damagedIn, [1]);
    equal(squash((await readBack(page, url, left.bytes)).texts), ['PAGEONE', 'PAGETHREE'], 'Deleting from a damaged page tree');
    const rotated = await call('rotatePdf', damagedIn, { 1: 90 });
    equal((await readBack(page, url, rotated.bytes)).sizes.map((s) => s[2]), [0, 90, 0], 'Rotating a page of a mended tree');
  }

  // --- Rotate PDF: only the turn changes.
  {
    const rotSrc = await simple('TURN', 3, [A4, LETTER, [400, 300]]);
    const rotated = await call('rotatePdf', pdfIn('turn.pdf', rotSrc), { rotations: [[0, 90], [1, -90], [2, 180], [0, 180]], fileName: 'turned' });
    equal([rotated.name, rotated.pageCount], ['turned.pdf', 3], 'Rotate: name and count');
    const before = await load(rotSrc);
    doc = await load(rotated.bytes);
    equal(doc.getPages().map((p) => p.getRotation().angle), [270, 270, 180], 'Turns add up, left is negative');
    equal(doc.getPages().map((p) => p.getSize()), before.getPages().map((p) => p.getSize()), 'Sizes stay');
    check([0, 1, 2].every((i) => contentOf(doc, i) === contentOf(before, i)), 'Content stays exactly as it was');
    back = await readBack(page, url, rotated.bytes);
    equal(back.sizes, [[842, 595, 270], [792, 612, 270], [400, 300, 180]], 'Viewers show them turned');
    const turnedMap = await call('rotatePdf', pdfIn('turn.pdf', rotSrc), [{ page: 1, rotation: 90 }]);
    equal((await load(turnedMap.bytes)).getPages().map((p) => p.getRotation().angle), [0, 90, 0], 'Rotations as a list');
    await rejects(call('rotatePdf', pdfIn('turn.pdf', rotSrc), { 0: 45 }), /pdf_process_failed/, 'Only quarter turns');
  }

  // --- Mixed page sizes and a shared font through split and merge.
  {
    const mixedSrc = await simple('SIZE', 3, [A4, LETTER, [300, 500]]);
    const mixedIn = pdfIn('sizes.pdf', mixedSrc);
    const partsOut = await call('splitPdf', mixedIn, { mode: 'every' });
    const sizes = [];
    for (const p of partsOut) sizes.push((await load(p.bytes)).getPages()[0].getSize());
    equal(sizes, [{ width: 595.28, height: 841.89 }, { width: 612, height: 792 }, { width: 300, height: 500 }], 'Each part keeps its page size');
    for (const p of partsOut) check(everythingIn(p.bytes).includes('/BaseFont /Helvetica'), 'Each part has the font its page uses');
    const m = await call('mergePdfs', [mixedIn, mixedIn], {});
    equal((await load(m.bytes)).getPages().map((p) => p.getSize().width), [595.28, 612, 300, 595.28, 612, 300], 'Merge keeps each page size');
  }

  // --- Damaged and hostile files fail with a clear message.
  await rejects(call('splitPdf', pdfIn('junk.pdf', new TextEncoder().encode('this is not a PDF at all')), { mode: 'every' }), /pdf_import_failed|pdf_process_failed/, 'Not a PDF');
  await rejects(call('deletePages', pdfIn('cut.pdf', alpha.subarray(0, 200)), [0]), /pdf_import_failed|pdf_process_failed/, 'A PDF cut short');
  {
    // Content that inflates hugely, and a form drawing itself: still finishes.
    const d = await newDoc();
    const ctx = d.context;
    const selfForm = ctx.nextRef();
    ctx.assign(selfForm, ctx.flateStream('/Fm0 Do', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { XObject: { Fm0: selfForm } } }));
    const shared = ctx.register(ctx.obj({ Font: { F1: d.helv }, XObject: { Fm0: selfForm } }));
    textPage(d, 'LOOPING FORM', { resources: shared, extra: '/Fm0 Do' });
    textPage(d, 'SECOND', { resources: shared });
    const out = await call('deletePages', pdfIn('selfform.pdf', await save(d)), [1]);
    equal(squash((await readBack(page, url, out.bytes)).texts), ['LOOPINGFORM'], 'A form that draws itself');
  }
  {
    // A kept page whose content inflates to 300 MB: it can't be read, so everything it lists stays.
    const d = await newDoc();
    const ctx = d.context;
    const image = ctx.register(ctx.flateStream('BOMB IMAGE 12345BOMB IMAGE 12345', { Type: 'XObject', Subtype: 'Image', Width: 16, Height: 2, BitsPerComponent: 8, ColorSpace: 'DeviceGray' }));
    const shared = ctx.register(ctx.obj({ Font: { F1: d.helv }, XObject: { Im0: image } }));
    const bombPage = d.addPage(A4);
    bombPage.node.set(N('Resources'), shared);
    const bomb = zlib.deflateSync(Buffer.alloc(300 * 1024 * 1024, 0x20), { level: 9 });
    bombPage.node.set(N('Contents'), ctx.register(PDFRawStream.of(ctx.obj({ Filter: 'FlateDecode' }), new Uint8Array(bomb))));
    textPage(d, 'DRAWS THE IMAGE', { resources: shared, extra: 'q 100 0 0 100 0 0 cm /Im0 Do Q' });
    const started = Date.now();
    const out = await call('deletePages', pdfIn('bomb.pdf', await save(d)), [1]);
    check(holds(everythingIn(out.bytes), 'BOMB IMAGE 12345') && !holds(everythingIn(out.bytes), 'DRAWS THE IMAGE'), 'A page too big to read keeps what it lists');
    check(Date.now() - started < 20000, `A decompression bomb doesn't hold it up (${Date.now() - started} ms)`);
  }

  // --- XFA forms: a static one goes with removed pages (it holds every field's value again); a
  // dynamic one, which draws the whole form itself, can't be merged, as in the app.
  {
    const withXfa = async (dynamic) => {
      const d = await PDFDocument.load(await chapters(), { updateMetadata: false });
      const ctx = d.context;
      const xfa = ctx.register(ctx.flateStream('<xdp:xdp><data>SECRET XFA DATA</data></xdp:xdp>'));
      const acro = d.catalog.lookup(N('AcroForm'));
      acro.set(N('XFA'), xfa);
      if (dynamic) acro.set(N('Fields'), ctx.obj([]));
      return save(d);
    };
    const staticIn = pdfIn('static_xfa.pdf', await withXfa(false));
    const deleted = await call('deletePages', staticIn, [3]);
    check(!holds(everythingIn(deleted.bytes), 'SECRET XFA DATA') && fieldNames(await load(deleted.bytes)).join() === 'keep', 'Deleting pages drops a static XFA form, keeping the fields left');
    const partsXfa = await call('splitPdf', staticIn, { groups: [[0]] });
    check(!holds(everythingIn(partsXfa[0].bytes), 'SECRET XFA DATA'), 'A part of a split has no XFA form');
    const mergedXfa = await call('mergePdfs', [staticIn, alphaIn], {});
    check(!holds(everythingIn(mergedXfa.bytes), 'SECRET XFA DATA') && fieldNames(await load(mergedXfa.bytes)).join() === 'keep,secret', 'A merge keeps the fields, not the XFA form');
    const dynamicIn = pdfIn('dynamic_xfa.pdf', await withXfa(true));
    await rejects(call('mergePdfs', [alphaIn, dynamicIn], {}), /pdf_process_failed/, 'A dynamic XFA form is not merged');
    check(holds(everythingIn((await call('rotatePdf', dynamicIn, { 0: 90 })).bytes), 'SECRET XFA DATA'), 'Other tools leave a dynamic XFA form as it is');
  }

  // --- Merge joins named places, attachments, layers and document details.
  {
    const extras = async (title, extra) => {
      const d = await PDFDocument.load(await chapters({ named: true }), { updateMetadata: false });
      const ctx = d.context;
      const file = ctx.register(ctx.flateStream(`ATTACHED ${title}`, { Type: 'EmbeddedFile' }));
      const spec = ctx.register(ctx.obj({ Type: 'Filespec', F: S('notes.txt'), UF: S('notes.txt'), EF: { F: file } }));
      d.catalog.lookup(N('Names')).set(N('EmbeddedFiles'), ctx.obj({ Names: [S('notes.txt'), spec] }));
      const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: S(`Layer ${title}`) }));
      d.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [ocg], D: { Order: [ocg], ON: [ocg] } }));
      const info = ctx.obj({ Title: S(title), ...extra });
      ctx.trailerInfo.Info = ctx.register(info);
      return pdfIn(`${title}.pdf`, await save(d));
    };
    const out = await call('mergePdfs', [await extras('First', {}), await extras('Second', { Author: S('Writer') })], {});
    doc = await load(out.bytes);
    const names = doc.catalog.lookup(N('Names'));
    const keys = (tree) => tree.lookup(N('Names')).asArray().filter((_, i) => i % 2 === 0).map((k) => k.decodeText());
    equal(keys(names.lookup(N('Dests'))), ['bad', 'bad (2)', 'three', 'three (2)'], 'Named places of both, sorted, told apart');
    equal(keys(names.lookup(N('EmbeddedFiles'))), ['notes.txt', 'notes.txt (2)'], 'Attachments of both');
    everything = everythingIn(out.bytes);
    check(holds(everything, 'ATTACHED First') && holds(everything, 'ATTACHED Second'), 'with their contents');
    const layers = doc.catalog.lookup(N('OCProperties'));
    equal(layers.lookup(N('OCGs')).asArray().map((r) => doc.context.lookup(r).lookup(N('Name')).decodeText()), ['Layer First', 'Layer Second'], 'Layers of both');
    equal(layers.lookup(N('D')).lookup(N('Order')).size(), 2, 'in the layer order');
    equal([doc.getTitle(), doc.getAuthor(), doc.getProducer()], ['First', 'Writer', 'Usugami'], 'The first PDF\'s details, with what it lacks from the others');
  }

  // --- Progress and cancelling.
  {
    const many = await simple('MANY', 40);
    const result = await page.evaluate(async ({ src, b64 }) => {
      const mod = await import(src);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const seen = [];
      await mod.splitPdf({ name: 'many.pdf', bytes }, { mode: 'fixed', pagesPerFile: 10 }, { onProgress: (done, total) => seen.push([done, total]) });
      const controller = new AbortController();
      let cancelled;
      try {
        await mod.splitPdf({ name: 'many.pdf', bytes }, { mode: 'every' }, { signal: controller.signal, onProgress: (done) => { if (done >= 3) controller.abort(); } });
        cancelled = 'finished';
      } catch (e) {
        cancelled = e.name;
      }
      const early = new AbortController();
      early.abort();
      let before;
      try {
        await mod.mergePdfs([{ name: 'a.pdf', bytes }, { name: 'b.pdf', bytes }], {}, { signal: early.signal });
      } catch (e) {
        before = e.name;
      }
      return { seen, cancelled, before };
    }, { src: new URL(ENGINE, url).href, b64: Buffer.from(many).toString('base64') });
    const totals = new Set(result.seen.map(([, t]) => t));
    check(result.seen.length > 4 && totals.size === 1 && result.seen.every(([d, t], i) => d <= t && (i === 0 || d >= result.seen[i - 1][0])), `Progress goes up to its total: ${JSON.stringify(result.seen.slice(-2))}`);
    equal(result.seen[result.seen.length - 1][0], result.seen[0][1], 'and reaches it');
    equal(result.cancelled, 'CancelledError', 'Cancelling stops a split');
    equal(result.before, 'CancelledError', 'A signal aborted before it starts stops a merge');
  }

  // --- A long PDF stays responsive: the page keeps handling events while it is split.
  {
    const longPdf = await simple('LONG', 300);
    const result = await page.evaluate(async ({ src, b64 }) => {
      const mod = await import(src);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      let last = performance.now();
      let worst = 0;
      const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 10);
      const started = performance.now();
      const out = await mod.splitPdf({ name: 'long.pdf', bytes }, { mode: 'every' });
      const deleted = await mod.deletePages({ name: 'long.pdf', bytes }, '2-299');
      clearInterval(timer);
      return { parts: out.length, left: deleted.pageCount, seconds: (performance.now() - started) / 1000, worst };
    }, { src: new URL(ENGINE, url).href, b64: Buffer.from(longPdf).toString('base64') });
    equal([result.parts, result.left], [300, 2], 'A 300-page PDF split into every page, and 298 deleted');
    console.log(`  300 pages split and pages deleted in ${result.seconds.toFixed(1)} s; longest pause ${Math.round(result.worst)} ms`);
    check(result.worst < 1500, `The page stayed responsive (longest pause ${Math.round(result.worst)} ms)`);
  }
}

// -----------------------------------------------------------------------------------------------
// Damaged page trees and catalogs, written by hand: pdf-lib opens all of these (some without a
// catalog at all), and every engine must fail on them with a UserError, never a TypeError.

/** A PDF file of the objects given ({ number: 'source' }), its catalog object 1. */
function handMade(objects) {
  let text = '%PDF-1.4\n';
  for (const [n, source] of Object.entries(objects)) text += `${n} 0 obj\n${source}\nendobj\n`;
  return new TextEncoder().encode(`${text}trailer\n<< /Root 1 0 R /Size 20 >>\n%%EOF\n`);
}

const handPage = (parent) => `<< /Type /Page /Parent ${parent} /MediaBox [0 0 200 300] /Resources << >> /Contents 9 0 R >>`;
const emptyStream = '<< /Length 0 >>\nstream\n\nendstream';
const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';

/** Files that have no pages to read: each engine says the PDF is damaged. */
const NO_PAGES = {
  'no catalog': new TextEncoder().encode('%PDF-1.4 nothing else'),
  'a catalog that is a number': handMade({ 1: '42' }),
  'a catalog that is a list': handMade({ 1: '[1 2 3]' }),
  'no page tree': handMade({ 1: '<< /Type /Catalog >>' }),
  'a page tree that is a list': handMade({ 1: CATALOG, 2: '[3 0 R]' }),
  'a page tree without /Kids': handMade({ 1: CATALOG, 2: '<< /Type /Pages /Count 1 >>' }),
  '/Kids that is not a list': handMade({ 1: CATALOG, 2: '<< /Type /Pages /Kids 3 0 R /Count 1 >>', 3: handPage('2 0 R'), 9: emptyStream }),
  '/Kids of things that are not pages': handMade({ 1: CATALOG, 2: '<< /Type /Pages /Kids [null 5 (x) 7 0 R] /Count 1 >>' }),
  'a page tree that only loops': handMade({ 1: CATALOG, 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 4: '<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 1 >>' }),
};
// Without a catalog or a page tree there is nothing to count either; an empty tree counts no pages.
const UNCOUNTED = new Set(['no catalog', 'a catalog that is a number', 'a catalog that is a list', 'no page tree', 'a page tree that is a list']);
// setPages gives a catalog without a proper page tree a new one; without a catalog it can't.
const NO_CATALOG = new Set(['no catalog', 'a catalog that is a number', 'a catalog that is a list']);

/** A page tree that leads back into itself around its two pages, and miscounts them. */
const LOOPING = handMade({
  1: CATALOG,
  2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 7 >>',
  3: handPage('2 0 R'),
  4: '<< /Type /Pages /Parent 2 0 R /Kids [2 0 R 5 0 R 4 0 R] /Count 1 >>',
  5: '<< /Parent 4 0 R /MediaBox [0 0 400 200] /Resources << >> /Contents 9 0 R >>',
  9: emptyStream,
});

async function damagedTrees(page, url, browser) {
  const files = Object.fromEntries(Object.entries({ ...NO_PAGES, looping: LOOPING }).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  const results = await page.evaluate(async ({ organize, cleanup, common, pdfjs, files }) => {
    const o = await import(organize);
    const c = await import(cleanup);
    const p = await import(common);
    const { openPdfJs } = await import(pdfjs);
    const out = {};
    for (const [name, b64] of Object.entries(files)) {
      const bytes = () => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const input = () => ({ name: 'damaged.pdf', bytes: bytes() });
      const r = {};
      const run = async (label, fn) => {
        try {
          r[label] = await fn();
        } catch (e) {
          r[label] = `${e.name}: ${e.key ?? e.message}`;
        }
      };
      await run('readPages', async () => c.readPages(await p.loadPdf(bytes())).pages.length);
      await run('repairPageTree', async () => c.repairPageTree(await p.loadPdf(bytes())).pages.length);
      await run('setPages', async () => { c.setPages(await p.loadPdf(bytes()), []); return 'done'; });
      await run('dropRemovedPages', async () => { await c.dropRemovedPages(await p.loadPdf(bytes()), [], c.ticker()); return 'done'; });
      await run('splitPdf', async () => (await o.splitPdf(input(), { mode: 'every' })).map((f) => f.pageCount));
      await run('mergePdfs', async () => (await o.mergePdfs([input(), input()], {})).pageCount);
      await run('reorganizePdf', async () => (await o.reorganizePdf(input(), [{ page: 0 }])).pageCount);
      await run('deletePages', async () => (await o.deletePages(input(), [0])).pageCount);
      await run('rotatePdf', async () => {
        const turned = await o.rotatePdf(input(), { 1: 90 });
        // Read back as viewers read it.
        const view = await openPdfJs(turned.bytes);
        const sizes = [];
        for (let i = 1; i <= view.numPages; i++) {
          const v = (await view.getPage(i)).getViewport({ scale: 1 });
          sizes.push([Math.round(v.width), Math.round(v.height)]);
        }
        await view.loadingTask.destroy();
        return { pageCount: turned.pageCount, sizes };
      });
      await run('countPages', () => o.countPages(input()));
      await run('shownPageSize', () => o.shownPageSize(input(), 0));
      out[name] = r;
    }
    return out;
  }, {
    organize: new URL(ENGINE, url).href, cleanup: new URL('app/js/engine/cleanup.js', url).href,
    common: new URL('app/js/engine/pdf-common.js', url).href, pdfjs: new URL('app/js/lib/pdfjs.js', url).href, files,
  });
  const damaged = 'UserError: pdf_import_failed';
  for (const name of Object.keys(NO_PAGES)) {
    const r = results[name];
    const where = `${browser}: ${name}`;
    for (const engine of ['repairPageTree', 'splitPdf', 'mergePdfs', 'reorganizePdf', 'deletePages', 'rotatePdf']) {
      equal(r[engine], damaged, `${where}: ${engine} says the PDF is damaged`);
    }
    if (UNCOUNTED.has(name)) {
      for (const fn of ['readPages', 'dropRemovedPages', 'countPages']) equal(r[fn], damaged, `${where}: ${fn} says the PDF is damaged`);
    } else {
      equal([r.readPages, r.countPages, r.dropRemovedPages], [0, 0, 'done'], `${where}: no pages are read`);
    }
    equal(r.setPages, NO_CATALOG.has(name) ? damaged : 'done', `${where}: setPages`);
    equal(r.shownPageSize, { width: 595.27563, height: 841.8898 }, `${where}: a page size that can't be read is A4`);
  }
  const looping = results.looping;
  equal([looping.readPages, looping.repairPageTree, looping.countPages], [2, 2, 2], `${browser}: a looping tree's two pages are read once each`);
  equal(looping.rotatePdf, { pageCount: 2, sizes: [[200, 300], [200, 400]] }, `${browser}: a looping tree is mended, its page without a type kept`);
  equal([looping.splitPdf, looping.mergePdfs, looping.reorganizePdf, looping.deletePages], [[1, 1], 4, 1, 1], `${browser}: every tool reads a looping tree`);
}

/** The same engines in Firefox and WebKit, briefly: they use nothing Chromium alone has. */
async function otherBrowserTests(page, url, browser) {
  const call = (name, ...args) => runInPage(page, url, ENGINE, name, ...args);
  const chaptersIn = pdfIn('chapters.pdf', await chapters({ named: true }));
  const deleted = await call('deletePages', chaptersIn, '2,4');
  check(!holds(everythingIn(deleted.bytes), 'SECRET VALUE') && deleted.pageCount === 3, `${browser}: delete pages`);
  const parts = await call('splitPdf', chaptersIn, { mode: 'custom', pages: '1-2;3-5', combine: false });
  equal(parts.map((p) => p.name), ['chapters_split_1_1-2.pdf', 'chapters_split_2_3-5.pdf'], `${browser}: split`);
  const merged = await call('mergePdfs', [chaptersIn, chaptersIn], { pages: [{ input: 1, page: 4 }, { input: 0, page: 0, rotation: 90 }] });
  equal(merged.pageCount, 2, `${browser}: merge`);
  const reo = await call('reorganizePdf', chaptersIn, [{ page: 1 }, { blank: true, width: 200, height: 200 }]);
  equal(reo.pageCount, 2, `${browser}: reorganize`);
  const rot = await call('rotatePdf', chaptersIn, { 0: 270 });
  equal((await load(rot.bytes)).getPages()[0].getRotation().angle, 270, `${browser}: rotate`);
  const locked = await encrypted(await simple('ALPHA', 3), 'AES-256');
  const part = await call('splitPdf', pdfIn('locked.pdf', locked, { password: 'test123' }), { groups: [[2]] });
  equal(part[0].pageCount, 1, `${browser}: a protected PDF`);
  equal(await call('defaultName', 'split', { name: `${'é'.repeat(10)}.pdf`, pageCount: 3 }), `${'é'.repeat(10)}_split`, `${browser}: names`);
}

pageSelectionTests();
await withPage(async (page, url) => {
  await page.goto(url + 'app/vendor/VERSIONS.json');
  await engineTests(page, url);
  await damagedTrees(page, url, 'chromium');
});
for (const browser of ['firefox', 'webkit']) {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/vendor/VERSIONS.json');
    await otherBrowserTests(page, url, browser);
    await damagedTrees(page, url, browser);
  }, { browser });
}
console.log(`organize: ${checks} checks passed`);
