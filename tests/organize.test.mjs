// Split PDF, Merge PDF and Reorganize PDF (engine/organize.js), page selection
// (engine/page-selection.js) and the clean-up that makes removed pages really gone
// (engine/cleanup.js). Ports PdfPageSelectionTest.kt and the matching cases of the app's
// PdfToolsDeviceTest.kt, PageToolsDeviceTest.kt and PdfEditingDeviceTest.kt. Pages turned and pages
// removed are saved by Reorganize PDF, which took over from Rotate PDF and Delete pages: what those
// two were tested for is tested here through reorganizePdf. Results are read back with pdf-lib
// (structure), pdf.js (text, labels, rendering) and by inflating every stream in the file.
//
//   node tests/organize.test.mjs
import zlib from 'node:zlib';
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFNumber, PDFRef, PDFNull,
  PDFRawStream, PDFStream, decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { withPage, assert, runInPage, saveOutput } from './harness.mjs';
import * as pageSelection from '../site/app/js/engine/page-selection.js';

const {
  parsePageSelection, parseRanges, fixedChunks, formatPages, formatPagesInOrder, PageSelectionError,
  defaultName: lightDefaultName,
} = pageSelection;

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

  // The app's toDelete and its "every page" problem went with Delete pages (commit 7db36467):
  // Reorganize's screen keeps a page, and its engine refuses a plan without any (see engineTests).
  check(!('pagesToDelete' in pageSelection), 'pagesToDelete is gone, as the app\'s toDelete');
  equal(new PageSelectionError('ALL_PAGES', 4).key, undefined, 'and so is the ALL_PAGES problem');
  equal(formatPages(parsePageSelection('5-7,2,6', 10)), '2,5-7', 'Pages typed in any order are written sorted');
  throwsProblem(() => parsePageSelection('5', 4), 'OUT_OF_RANGE', 'A page that is not there');

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

/** A page saying `text` at `at`, with its own resources unless `resources` is given (a ref) or false (none). */
function textPage(doc, text, { size = A4, resources, extra = '', at = [72, 700] } = {}) {
  const page = doc.addPage(size);
  const ctx = doc.context;
  const content = `${extra} BT /F1 14 Tf ${at[0]} ${at[1]} Td (${text}) Tj ET`;
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

/**
 * Four pages saying "PAGE ONE" to "PAGE FOUR", with bookmarks under bookmarks. Each leads to its
 * page by /Dest or, with `byAction`, by a go-to action, as many programs write them:
 *   Part A (page 2): A STAYS (page 1), A GOES (page 2)
 *   Part B (page 4): B GOES (page 4)
 *   Part C (page 3): C GOES (page 2), C STAYS (page 3)
 * Named for what becomes of them when pages 2 and 4 are removed.
 */
async function nestedOutline(byAction) {
  const doc = await newDoc();
  const ctx = doc.context;
  const pages = [0, 1, 2, 3].map((i) => textPage(doc, `PAGE ${WORDS[i]}`));
  const leads = (page) => (byAction ? { A: { S: 'GoTo', D: [page.ref, 'Fit'] } } : { Dest: [page.ref, 'Fit'] });
  // Writes the bookmarks `items` ([title, page, those under it]) under `parent`; returns their references.
  const write = (parent, items) => {
    const refs = items.map(() => ctx.nextRef());
    items.forEach(([title, page, under = []], i) => {
      const dict = ctx.obj({ Title: S(title), Parent: parent, ...leads(pages[page]) });
      if (i > 0) dict.set(N('Prev'), refs[i - 1]);
      if (i < items.length - 1) dict.set(N('Next'), refs[i + 1]);
      if (under.length) {
        const kids = write(refs[i], under);
        dict.set(N('First'), kids[0]);
        dict.set(N('Last'), kids[kids.length - 1]);
        // Open: the bookmarks under it are shown, and counted.
        dict.set(N('Count'), PDFNumber.of(under.length));
      }
      ctx.assign(refs[i], dict);
    });
    return refs;
  };
  const rootRef = ctx.nextRef();
  const top = write(rootRef, [
    ['Part A', 1, [['A STAYS', 0], ['A GOES', 1]]],
    ['Part B', 3, [['B GOES', 3]]],
    ['Part C', 2, [['C GOES', 1], ['C STAYS', 2]]],
  ]);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top[0], Last: top[top.length - 1], Count: 8 }));
  doc.catalog.set(N('Outlines'), rootRef);
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
  const node = ctx.register(ctx.obj({ Type: 'Pages', Parent: rootRef, Kids: [pages[0].ref, pages[1].ref], Count: 2, MediaBox: [0, 0, ...LETTER], Rotate: 90 }));
  for (const p of pages.slice(0, 2)) {
    p.node.delete(N('MediaBox'));
    p.node.set(N('Parent'), node);
  }
  ctx.lookup(rootRef).set(N('Kids'), ctx.obj([node, pages[2].ref]));
  return save(doc);
}

/**
 * "DEEP ONE" to "DEEP THREE" under two parts of the page tree, one inside the other. The pages
 * have no size and no turn of their own: the root gives them a quarter turn, the outer part US
 * Letter. So what they inherit comes from further up than the part that holds them.
 */
async function deepPages() {
  const doc = await newDoc();
  const ctx = doc.context;
  const pages = [0, 1, 2].map((i) => textPage(doc, `DEEP ${WORDS[i]}`));
  const rootRef = doc.catalog.get(N('Pages'));
  const outer = ctx.nextRef();
  const inner = ctx.register(ctx.obj({ Type: 'Pages', Parent: outer, Kids: pages.map((p) => p.ref), Count: 3 }));
  ctx.assign(outer, ctx.obj({ Type: 'Pages', Parent: rootRef, Kids: [inner], Count: 3, MediaBox: [0, 0, ...LETTER] }));
  for (const p of pages) {
    p.node.delete(N('MediaBox'));
    p.node.set(N('Parent'), inner);
  }
  const root = ctx.lookup(rootRef);
  root.set(N('Kids'), ctx.obj([outer]));
  root.set(N('Rotate'), PDFNumber.of(90));
  return save(doc);
}

/**
 * Four pages, each with a caption in the middle (PdfEditingDeviceTest's mixedPages): A4 upright; A4
 * turned clockwise (/Rotate 90); A4 with a crop box that leaves a 100-point border off on every
 * side; landscape A4 turned anticlockwise (/Rotate 270).
 */
async function mixedPages() {
  const doc = await newDoc();
  [A4, A4, A4, [A4[1], A4[0]]].forEach((size, i) => {
    const page = textPage(doc, `CAPTION ${'ABCD'[i]}`, { size, at: [size[0] / 2 - 40, size[1] / 2] });
    if (i === 1) page.node.set(N('Rotate'), PDFNumber.of(90));
    if (i === 2) page.node.set(N('CropBox'), doc.context.obj([100, 100, size[0] - 100, size[1] - 100]));
    if (i === 3) page.node.set(N('Rotate'), PDFNumber.of(270));
  });
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

/**
 * The bookmarks as they are nested: for each, its title, the place in the PDF of the page it leads
 * to (by /Dest or by a go-to action; null when it leads nowhere) and the bookmarks under it. Walked
 * from /First by /Next or, `backwards`, from /Last by /Prev: both must give the same.
 */
function bookmarkTree(doc, backwards = false, parent = doc.catalog.lookup(N('Outlines'))) {
  const places = new Map(doc.getPages().map((p, i) => [p.ref, i]));
  const items = [];
  const seen = new Set();
  let item = parent.lookup(N(backwards ? 'Last' : 'First'));
  while (item instanceof PDFDict && !seen.has(item)) {
    seen.add(item);
    const dest = item.lookup(N('Dest')) ?? item.lookup(N('A'))?.lookup(N('D'));
    const page = dest instanceof PDFArray ? places.get(dest.get(0)) ?? null : null;
    items.push([item.lookup(N('Title')).decodeText(), page, bookmarkTree(doc, backwards, item)]);
    item = item.lookup(N(backwards ? 'Prev' : 'Next'));
  }
  return backwards ? items.reverse() : items;
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

// runInPage passes Uint8Arrays (and Buffers) through as they are.
const pdfIn = (name, bytes, extra = {}) => ({ name, bytes: new Uint8Array(bytes), ...extra });

// Reorganize's page lists for a PDF's own pages (zero-based), as its screen makes them. Lists like
// these, in the PDF's own order, are saved in place.
/** Pages `indexes`, not turned (TestPdfs.kt's pagesOf). */
const pagesOf = (...indexes) => indexes.map((page) => ({ page }));
/** Every page of a PDF of `count` pages but those in `removed`. */
const without = (count, ...removed) => pagesOf(...[...Array(count).keys()].filter((p) => !removed.includes(p)));
/** Every page of a PDF of `count` pages, those in `turns` ({ page: degrees }) turned by that much more. */
const turnedBy = (count, turns) => [...Array(count).keys()].map((page) => ({ page, rotation: turns[page] ?? 0 }));

/** The page tree as it is laid out: a list for each part of it, a page's place in the PDF for each page. */
function pageTree(doc) {
  const places = new Map(doc.getPages().map((p, i) => [p.node, i]));
  const walk = (node) => node.lookup(N('Kids')).asArray().map((kid) => {
    const dict = doc.context.lookup(kid);
    return dict.has(N('Kids')) ? walk(dict) : places.get(dict);
  });
  return walk(doc.catalog.lookup(N('Pages')));
}

/** The /Count of every part of the page tree, the root's first, then each part's as the tree is read. */
function partCounts(doc) {
  const walk = (node) => [node.lookup(N('Count')).asNumber(), ...node.lookup(N('Kids')).asArray()
    .map((kid) => doc.context.lookup(kid)).filter((kid) => kid.has(N('Kids'))).flatMap(walk)];
  return walk(doc.catalog.lookup(N('Pages')));
}

/** Each page's turn as the file gives it, its own or inherited (pdf-lib reads both). */
const turnsOf = (doc) => doc.getPages().map((p) => p.getRotation().angle);

/** The names of the entries page `index` has of its own (not what it inherits), sorted. */
const ownEntries = (doc, index) => doc.getPages()[index].node.keys().map((key) => key.decodeText()).sort();

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
  equal(await call('defaultName', 'reorganize', { name: 'Report.pdf' }), 'Report_reorganized', 'Reorganize default name');
  // The same names from page-selection.js, which the screens use before the engine has loaded.
  for (const [tool, input] of [['merge'], ['reorganize', { name: 'Report.pdf' }], ['split', { name: 'R.pdf', pageCount: 300 }], ['reorganize', { name: 'CON.pdf' }]]) {
    equal(lightDefaultName(tool, input), await call('defaultName', tool, input), `${tool}: page-selection.js names it as organize.js`);
  }
  // Rotate PDF and Delete pages went from the app (commits 640285a6 and 7db36467): their engines and
  // their names are gone here too, and what the other screens use is still there.
  for (const tool of ['rotate', 'delete-pages']) {
    await rejects(call('defaultName', tool, { name: 'Report.pdf' }), /Unknown tool/, `${tool} names no PDF any more`);
  }
  const exported = await page.evaluate(async (src) => Object.keys(await import(src)), new URL(ENGINE, url).href);
  for (const gone of ['rotatePdf', 'deletePages']) check(!exported.includes(gone), `${gone} is gone from organize.js`);
  for (const kept of ['splitGroups', 'splitPdf', 'mergePdfs', 'reorganizePdf', 'shownPageSize', 'blankPageAfter', 'countPages',
    'fileNames', 'defaultName', 'partSuffix', 'PageSelectionError', 'checkCancelled', 'resourcesOf']) {
    check(exported.includes(kept), `organize.js still exports ${kept}`);
  }
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
    const ownerOnly = await call('reorganizePdf', pdfIn('owner.pdf', await encrypted(alpha, algorithm, '')), pagesOf(1, 2));
    equal(squash((await readBack(page, url, ownerOnly.bytes)).texts), ['ALPHATWO', 'ALPHATHREE'], `${algorithm}: a PDF with only an owner password`);
    const locked = await encrypted(alpha, algorithm);
    await rejects(call('splitPdf', pdfIn('protected.pdf', locked), { groups: [[1]] }), /Password|password/, `${algorithm}: no password`);
    await rejects(call('splitPdf', pdfIn('protected.pdf', locked, { password: 'wrong' }), { groups: [[1]] }), /Password|password/, `${algorithm}: a wrong password`);
    const lockedIn = pdfIn('protected.pdf', locked, { password: 'test123' });
    const part = await call('splitPdf', lockedIn, { groups: [[1]], fileName: 'protected_split' });
    check(part[0].passwordRemoved === true, `${algorithm}: the result says its password went`);
    equal(squash((await readBack(page, url, part[0].bytes)).texts), ['ALPHATWO'], `${algorithm}: split of a protected PDF`);
    check(!(await load(part[0].bytes)).isEncrypted && !everythingIn(part[0].bytes).includes('/Encrypt'), `${algorithm}: the part has no password`);
    // turningAPageOfAProtectedPdfRemovesThePassword (PdfEditingDeviceTest)
    const turnedLocked = await call('reorganizePdf', lockedIn, turnedBy(3, { 1: 180 }));
    equal((await load(turnedLocked.bytes)).getPages().map((p) => p.getRotation().angle), [0, 180, 0], `${algorithm}: a page of a protected PDF turned`);
    for (const [name, result] of [
      ['merge', await call('mergePdfs', [lockedIn, betaIn], { pages: [{ input: 0, page: 2 }, { input: 1, page: 0 }] })],
      ['pages removed', await call('reorganizePdf', lockedIn, pagesOf(1, 2))],
      ['pages added', await call('reorganizePdf', alphaIn, [{ page: 0 }, { input: 0, page: 2 }], [lockedIn])],
      ['a page turned', turnedLocked],
    ]) {
      const texts = squash((await readBack(page, url, result.bytes)).texts);
      check(texts.some((t) => t === 'ALPHATHREE') && !(await load(result.bytes)).isEncrypted, `${algorithm}: ${name} of a protected PDF has no password (${texts})`);
      check(!everythingIn(result.bytes).includes('/Encrypt'), `${algorithm}: ${name} leaves no encryption dictionary`);
      check(result.passwordRemoved === true, `${algorithm}: ${name} says its password went`);
    }
  }
  // A PDF that had no password says nothing about one.
  check(!('passwordRemoved' in await call('reorganizePdf', alphaIn, turnedBy(3, { 0: 90 }))), 'No password, none removed');

  // --- deletedPagesAreGoneFromTheFile (PageToolsDeviceTest)
  const chaptersPdf = await chapters();
  const chaptersIn = pdfIn('chapters.pdf', chaptersPdf);
  const source = everythingIn(chaptersPdf);
  check(['SECRET VALUE', 'SECRET NOTE', 'Chapter FOUR', 'PAGE FOUR'].every((t) => holds(source, t)), 'The fixture holds the words checked below');
  const deleted = await call('reorganizePdf', chaptersIn, { pages: pagesOf(0, 2, 4), fileName: 'chapters_reorganized' });
  equal([deleted.name, deleted.pageCount], ['chapters_reorganized.pdf', 3], 'Pages removed: name and count');
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
  // Selected as on the screen, typed like 2,4-5, then removed: the pages left are saved, under the PDF's name.
  const typed = parsePageSelection('2,4-5', 5);
  const afterTyping = await call('reorganizePdf', chaptersIn, without(5, ...typed));
  equal([afterTyping.name, afterTyping.pageCount], ['chapters_reorganized.pdf', 2], 'Pages typed like 2,4-5 removed');
  equal(squash((await readBack(page, url, afterTyping.bytes)).texts), ['PAGEONE', 'PAGETHREE'], 'and pages 1 and 3 left');
  // Pages removed and pages turned in one save, which neither of the two old tools could do. A turn
  // goes to the page it names, though that page has a new place in the PDF: pages 2 and 4 removed,
  // page 3 turned right and page 5 upside down.
  const fewerTurned = await call('reorganizePdf', chaptersIn, [{ page: 0 }, { page: 2, rotation: 90 }, { page: 4, rotation: 180 }]);
  back = await readBack(page, url, fewerTurned.bytes);
  equal([squash(back.texts), back.sizes.map((s) => s[2])], [['PAGEONE', 'PAGETHREE', 'PAGEFIVE'], [0, 90, 180]], 'Pages removed and others turned: each turn is on the page it was given to');
  doc = await load(fewerTurned.bytes);
  refs = pageRefs(doc);
  equal(outlineItems(doc).items.map((item) => refs.indexOf(item.page)), [0, 1, 2], 'and the bookmarks left lead to their pages');
  // aPdfWithNoPagesLeftIsRefused: nothing is made of a list without pages.
  await rejects(call('reorganizePdf', alphaIn, pagesOf()), /pdf_need_page/, 'A PDF with no pages left is refused');
  await rejects(call('reorganizePdf', alphaIn, { pages: [], fileName: 'none' }), /pdf_need_page/, 'A PDF with no pages left is refused, also with a name typed');
  await rejects(call('reorganizePdf', alphaIn, { fileName: 'none' }), /pdf_need_page/, 'and so is no list of pages at all');
  await rejects(call('mergePdfs', [alphaIn, betaIn], { pages: [] }), /pdf_need_page/, 'Merge keeps a page too');
  // The engine takes pages, not what was typed: one that isn't in the PDF is a mistake of the caller's.
  await rejects(call('reorganizePdf', alphaIn, pagesOf(0, 5)), /pdf_process_failed/, 'A page that is not there, in the PDF\'s own order');
  await rejects(call('reorganizePdf', alphaIn, pagesOf(5, 0)), /pdf_process_failed/, 'A page that is not there, among pages moved');
  await rejects(call('reorganizePdf', alphaIn, pagesOf(1, 1)), /pdf_process_failed/, 'A page listed twice');
  await rejects(call('reorganizePdf', alphaIn, [{ page: 0 }, { input: 'other', page: 0 }], [betaIn]), /pdf_process_failed/, 'A page of a PDF that was not added');
  await rejects(call('reorganizePdf', alphaIn, [{ page: 0 }, { blank: true }]), /pdf_process_failed/, 'A blank page without a size');

  // --- Bookmarks under bookmarks, and bookmarks that lead to their page by a go-to action
  // (PageCleanup's pruneBookmarks, which the chapters' flat list of /Dest bookmarks doesn't go
  // through): a bookmark goes with its page, unless it holds a bookmark to a page that stays.
  for (const byAction of [false, true]) {
    const how = byAction ? 'by a go-to action' : 'by /Dest';
    const outlinedIn = pdfIn('outlined.pdf', await nestedOutline(byAction));
    equal(bookmarkTree(await load(outlinedIn.bytes)), [
      ['Part A', 1, [['A STAYS', 0, []], ['A GOES', 1, []]]],
      ['Part B', 3, [['B GOES', 3, []]]],
      ['Part C', 2, [['C GOES', 1, []], ['C STAYS', 2, []]]],
    ], `The fixture's bookmarks, read ${how}`);
    // Pages 2 and 4 removed, each way Reorganize saves. `places`: where pages 1 and 3 then are.
    for (const [what, kept, places] of [['Pages removed', pagesOf(0, 2), [0, 1]], ['Pages moved', pagesOf(2, 0), [1, 0]]]) {
      const out = await call('reorganizePdf', outlinedIn, kept);
      doc = await load(out.bytes);
      // Part A led to page 2, which went: it stays for A STAYS, and leads nowhere now.
      const left = [['Part A', null, [['A STAYS', places[0], []]]], ['Part C', places[1], [['C STAYS', places[1], []]]]];
      equal(bookmarkTree(doc), left, `${what} (${how}): the bookmarks of the pages left, where they were`);
      equal(bookmarkTree(doc, true), left, `${what} (${how}): the same read from the end`);
      const outlineRoot = doc.catalog.lookup(N('Outlines'));
      const partCount = (item) => item.lookup(N('Count')).asNumber();
      equal([partCount(outlineRoot), partCount(outlineRoot.lookup(N('First'))), partCount(outlineRoot.lookup(N('Last')))], [4, 1, 1], `${what} (${how}): the outline and its parts count the bookmarks left`);
      everything = everythingIn(out.bytes);
      for (const gone of ['A GOES', 'Part B', 'B GOES', 'C GOES', 'PAGE TWO', 'PAGE FOUR']) check(!holds(everything, gone), `${what} (${how}): "${gone}" is still in the file`);
    }
  }

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
  const nestedDeleted = await call('reorganizePdf', nestedIn, pagesOf(0));
  check(!holds(everythingIn(nestedDeleted.bytes), 'FAR VALUE') && holds(everythingIn(nestedDeleted.bytes), 'NEAR VALUE'), 'Removing page 2 takes its nested field');

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
    const del = await call('reorganizePdf', sharedIn, pagesOf(0, 2));
    equal(squash((await readBack(page, url, del.bytes)).texts), ['PAGEONE', 'PAGETHREE'], 'A page removed with shared resources');
    assertImages(del.bytes, [0, 2], 'Pages removed');
    await assertDrawn(del.bytes, 2, 'Pages removed');
    // Saved in place, the pages left still take their resources from where they took them.
    const delDoc = await load(del.bytes);
    equal([0, 1].map((i) => delDoc.getPages()[i].node.has(N('Resources'))), [!inherited, !inherited], `Pages removed (inherited: ${inherited}): resources stay where they were`);
    const reo = await call('reorganizePdf', sharedIn, [{ page: 2 }, { page: 0 }]);
    equal(squash((await readBack(page, url, reo.bytes)).texts), ['PAGETHREE', 'PAGEONE'], 'Pages moved with shared resources');
    assertImages(reo.bytes, [0, 2], 'Pages moved');
    await assertDrawn(reo.bytes, 2, 'Pages moved');
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
    const out = await call('reorganizePdf', pdfIn('loop.pdf', await save(d)), pagesOf(0));
    equal([out.pageCount, (await load(out.bytes)).getPageCount()], [1, 1], 'A looping outline: one page left');
    check(Date.now() - started < 20000, 'and quickly');
  }

  // --- tagsOfDeletedPagesGo
  const taggedIn = pdfIn('tagged.pdf', await taggedPages());
  for (const [what, result] of [
    ['Pages removed', await call('reorganizePdf', taggedIn, pagesOf(0, 2))],
    ['Pages moved', await call('reorganizePdf', taggedIn, [{ page: 2 }, { page: 0 }])],
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
  equal(await labelsOf((await call('reorganizePdf', bookIn, pagesOf(1, 2, 3, 4, 5))).bytes), ['ii', 'iii', '1', '2', '3'], 'Without its cover');
  equal(await labelsOf((await call('reorganizePdf', bookIn, pagesOf(0, 2, 4, 5))).bytes), ['i', 'iii', '2', '3'], 'Fewer pages');
  // Pages only turned: no page changes place, and the labels are left exactly as they were.
  const bookTurned = await call('reorganizePdf', bookIn, turnedBy(6, { 1: 90, 4: 270 }));
  equal(await labelsOf(bookTurned.bytes), ['i', 'ii', 'iii', '1', '2', '3'], 'Pages turned keep their labels');
  const labelTree = async (bytes) => (await load(bytes)).catalog.lookup(N('PageLabels'))?.toString();
  equal(await labelTree(bookTurned.bytes), await labelTree(bookIn.bytes), 'as they were written');
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
  const plainIn = pdfIn('plain.pdf', await labelledPages(true));
  const plainDeleted = await call('reorganizePdf', plainIn, pagesOf(0, 1, 3, 4, 5));
  equal(await labelsOf(plainDeleted.bytes), ['1', '2', '3', '4', '5'], 'Labels that are just the places follow the new places');
  check(!(await load(plainDeleted.bytes)).catalog.has(N('PageLabels')), 'and are left out');
  // With no page gone there is nothing to put right: even such labels stay as they were written.
  const plainTurned = await call('reorganizePdf', plainIn, turnedBy(6, { 2: 90 }));
  equal([await labelTree(plainTurned.bytes), await labelsOf(plainTurned.bytes)], [await labelTree(plainIn.bytes), ['1', '2', '3', '4', '5', '6']], 'Pages only turned leave them alone');

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

  // --- pagesOnlyTurnedOrRemovedLeaveTheRestOfTheFileAsItWas (PageToolsDeviceTest): pages only
  // turned, or turned and removed, are saved in place. The page tree stays as it was, nested, and
  // the pages keep what they inherit from it.
  {
    const was = await load(mainIn.bytes);
    const treeNode = (d) => d.context.lookup(d.catalog.lookup(N('Pages')).lookup(N('Kids')).get(0));
    const counts = (d) => [d.catalog.lookup(N('Pages')).lookup(N('Count')).asNumber(), treeNode(d).lookup(N('Count')).asNumber()];
    equal(pageTree(was), [[0, 1], 2], "The fixture's root holds a part with pages 1 and 2, and page 3");
    check([0, 1].every((i) => !was.getPages()[i].node.has(N('MediaBox')) && !was.getPages()[i].node.has(N('Rotate'))), 'whose pages 1 and 2 have no size or turn of their own');

    // Page 3 turned, nothing else. The pages are named with the PDF's id, as the screen names them.
    const turned = await call('reorganizePdf', mainIn, { pages: [{ input: 7, page: 0, rotation: 0 }, { input: 7, page: 1, rotation: 0 }, { input: 7, page: 2, rotation: 90 }], fileName: 'nested_turned' });
    await saveOutput('organize_nested_turned.pdf', turned.bytes);
    equal([turned.name, turned.pageCount], ['nested_turned.pdf', 3], 'Turned in place: name and count');
    doc = await load(turned.bytes);
    equal(pageTree(doc), [[0, 1], 2], 'The page tree is still nested');
    equal(counts(doc), [3, 2], 'and counts its pages as before');
    equal(treeNode(doc).toString(), treeNode(was).toString(), 'The part of the tree is as it was, with the size and turn its pages inherit');
    for (const i of [0, 1]) {
      equal(ownEntries(doc, i), ownEntries(was, i), `Page ${i + 1} has the entries it had: no size and no turn of its own`);
      // Still shown as it inherits it: US Letter, a quarter turn.
      equal([doc.getPages()[i].getRotation().angle, doc.getPages()[i].getSize()], [90, { width: 612, height: 792 }], `Page ${i + 1} is shown as before`);
      check(contentOf(doc, i) === contentOf(was, i), `Page ${i + 1}'s content is as it was`);
    }
    equal(doc.getPages()[2].getRotation().angle, 90, 'Page 3 is turned');
    equal(ownEntries(doc, 2), [...ownEntries(was, 2), 'Rotate'].sort(), 'and its turn is all it gained');
    refs = pageRefs(doc);
    check(destPage(doc, annots(doc, 0).find((a) => subtype(a) === 'Link')) === refs[2], "Page 1's link still leads to page 3");
    equal((await readBack(page, url, turned.bytes)).sizes, [[792, 612, 90], [792, 612, 90], [842, 595, 90]], 'Viewers show all three sideways');

    // Page 2 left out and page 1 turned, in one save.
    const fewer = await call('reorganizePdf', mainIn, [{ page: 0, rotation: 90 }, { page: 2 }]);
    await saveOutput('organize_nested_fewer.pdf', fewer.bytes);
    equal(fewer.pageCount, 2, 'Two pages left');
    doc = await load(fewer.bytes);
    equal(pageTree(doc), [[0], 1], 'The tree keeps its nesting without page 2');
    equal(counts(doc), [2, 1], 'and each part of it counts one page fewer');
    const first = doc.getPages()[0];
    equal(first.getRotation().angle, 180, 'The quarter turn it inherited, and one more');
    check(!first.node.has(N('MediaBox')), 'Page 1 still has no size of its own');
    equal(first.getSize(), { width: 612, height: 792 }, 'and is still US Letter');
    equal(ownEntries(doc, 1), ownEntries(was, 2), 'Page 3, not turned, has the entries it had');
    check(!holds(everythingIn(fewer.bytes), 'MAIN TWO'), 'The page left out is gone');
    back = await readBack(page, url, fewer.bytes);
    equal([squash(back.texts), back.sizes], [['MAINONE', 'MAINTHREE'], [[612, 792, 180], [595, 842, 0]]], 'Viewers show page 1 upside down and page 3 as it was');

    // Page 2 left out and page 3 turned left, the pages named with the PDF's id as the screen names
    // them. The turn goes to the page it names, which comes after the page left out, and page 1,
    // not turned, is left as it was: it still inherits its size and its turn.
    const after = await call('reorganizePdf', mainIn, [{ input: 7, page: 0, rotation: 0 }, { input: 7, page: 2, rotation: 270 }]);
    doc = await load(after.bytes);
    equal(pageTree(doc), [[0], 1], 'Named with the PDF\'s id, a page left out is taken out of the tree where it stands');
    equal(counts(doc), [2, 1], 'and each part of the tree counts one page fewer');
    equal(turnsOf(doc), [90, 270], 'A page turned that comes after the page left out');
    equal(doc.getPages()[0].node.toString(), was.getPages()[0].node.toString(), 'Page 1, not turned, is as it was beside a page left out, entry for entry');
    back = await readBack(page, url, after.bytes);
    equal([squash(back.texts), back.sizes], [['MAINONE', 'MAINTHREE'], [[792, 612, 90], [842, 595, 270]]], 'Viewers show page 1 as it was and page 3 turned left');

    // Page 3 left out and nothing turned: pages 1 and 2, and the part of the tree that holds them
    // and gives them their size and turn, are as they were.
    const firstTwo = await call('reorganizePdf', mainIn, pagesOf(0, 1));
    doc = await load(firstTwo.bytes);
    equal(pageTree(doc), [[0, 1]], 'Page 3 left out: the part still holds pages 1 and 2');
    equal(counts(doc), [2, 2], 'and only the root counts one page fewer');
    equal(treeNode(doc).toString(), treeNode(was).toString(), 'The part is as it was');
    for (const i of [0, 1]) equal(ownEntries(doc, i), ownEntries(was, i), `Page ${i + 1} still has no size and no turn of its own`);
    equal((await readBack(page, url, firstTwo.bytes)).sizes, [[792, 612, 90], [792, 612, 90]], 'Viewers show both as before');

    // A page that inherits its turn, turned, with every page kept: the turn is added to the one it inherits.
    const inheritedTurn = await call('reorganizePdf', mainIn, turnedBy(3, { 1: 90 }));
    doc = await load(inheritedTurn.bytes);
    equal([pageTree(doc), turnsOf(doc)], [[[0, 1], 2], [90, 180, 0]], 'A turn added to an inherited turn, no page left out');
    equal([ownEntries(doc, 0), ownEntries(doc, 1)], [ownEntries(was, 0), [...ownEntries(was, 1), 'Rotate'].sort()], 'Its turn is all page 2 gained, and page 1 gained nothing');

    // The list alone decides how the PDF is saved: a PDF given along, none of whose pages is in
    // the list, changes nothing.
    const unused = await call('reorganizePdf', mainIn, [{ page: 0 }, { page: 2 }], [betaIn]);
    equal([unused.pageCount, pageTree(await load(unused.bytes))], [2, [[0], 1]], 'A PDF given but not used: still saved in place');

    // A part of the tree left without pages stays, empty, as PDFBox leaves it: viewers and this
    // engine read the page that is left.
    const last = await call('reorganizePdf', mainIn, pagesOf(2));
    doc = await load(last.bytes);
    equal([pageTree(doc), counts(doc)], [[[], 0], [1, 0]], 'The part emptied stays, counting no pages');
    equal(squash((await readBack(page, url, last.bytes)).texts), ['MAINTHREE'], 'Viewers show the page left');
    check(!holds(everythingIn(last.bytes), 'MAIN ONE') && !holds(everythingIn(last.bytes), 'MAIN TWO'), 'and the two taken out are gone');
    const again = await call('reorganizePdf', pdfIn('last.pdf', last.bytes), turnedBy(1, { 0: 90 }));
    equal([again.pageCount, pageTree(await load(again.bytes))], [1, [[], 0]], 'What was saved in place can be saved in place again');

    // Any page moved, and the pages are laid out again, flat, each with what it inherited.
    const moved = await call('reorganizePdf', mainIn, pagesOf(1, 0, 2));
    doc = await load(moved.bytes);
    equal(pageTree(doc), [0, 1, 2], 'Pages moved are laid out flat');
    check([0, 1].every((i) => doc.getPages()[i].node.has(N('MediaBox')) && doc.getPages()[i].node.has(N('Rotate'))), 'with the size and turn they inherited as their own');
    equal(squash((await readBack(page, url, moved.bytes)).texts), ['MAINTWO', 'MAINONE', 'MAINTHREE'], 'in the new order');

    // A page added is not one of the PDF's own, whatever its number: BETA TWO after MAIN ONE, and a
    // blank page after MAIN ONE, are laid out again too.
    const added = await call('reorganizePdf', mainIn, [{ page: 0 }, { input: 'beta', page: 1 }], [pdfIn('beta.pdf', beta, { id: 'beta' })]);
    equal([squash((await readBack(page, url, added.bytes)).texts), pageTree(await load(added.bytes))], [['MAINONE', 'BETATWO'], [0, 1]], 'A page of a PDF added after the first page');
    const withBlank = await call('reorganizePdf', mainIn, [{ page: 0 }, { blank: true, width: 300, height: 400 }, { page: 1 }]);
    equal([squash((await readBack(page, url, withBlank.bytes)).texts), pageTree(await load(withBlank.bytes))], [['MAINONE', '', 'MAINTWO'], [0, 1, 2]], 'A blank page among the pages in their own order');
  }

  // --- What pages inherit from further up the page tree than the part that holds them: the turn
  // from the root and the size from a part between, two and three levels above the pages.
  {
    const deepIn = pdfIn('deep.pdf', await deepPages());
    const was = await load(deepIn.bytes);
    equal([pageTree(was), partCounts(was), turnsOf(was)], [[[[0, 1, 2]]], [3, 3, 3], [90, 90, 90]], 'The fixture: three pages two parts down, turned by the root');
    equal([0, 1, 2].map((i) => ownEntries(was, i).filter((key) => key === 'MediaBox' || key === 'Rotate')), [[], [], []], 'with no size and no turn of their own');

    // Page 1 turned: the turn is added to the root's.
    const turned = await call('reorganizePdf', deepIn, turnedBy(3, { 0: 90 }));
    doc = await load(turned.bytes);
    equal([pageTree(doc), partCounts(doc), turnsOf(doc)], [[[[0, 1, 2]]], [3, 3, 3], [180, 90, 90]], 'A turn inherited from the root is added to');
    equal((await readBack(page, url, turned.bytes)).sizes, [[612, 792, 180], [792, 612, 90], [792, 612, 90]], 'Viewers show page 1 upside down, the others as before');

    // Page 2 left out and page 3 turned: every part above the page counts one fewer.
    const fewer = await call('reorganizePdf', deepIn, [{ page: 0 }, { page: 2, rotation: 180 }]);
    doc = await load(fewer.bytes);
    equal([pageTree(doc), partCounts(doc), turnsOf(doc)], [[[[0, 1]]], [2, 2, 2], [90, 270]], 'A page left out two parts down');
    equal(doc.getPages()[0].node.toString(), was.getPages()[0].node.toString(), 'Page 1 is as it was, entry for entry');
    equal(doc.getPages().map((p) => p.getSize()), [{ width: 612, height: 792 }, { width: 612, height: 792 }], 'Both still US Letter, from the part between');
    back = await readBack(page, url, fewer.bytes);
    equal([squash(back.texts), back.sizes], [['DEEPONE', 'DEEPTHREE'], [[792, 612, 90], [792, 612, 270]]], 'Viewers show pages 1 and 3, page 3 turned round');

    // Pages moved are laid out flat, each with what it inherited from wherever it came.
    const moved = await call('reorganizePdf', deepIn, pagesOf(2, 0, 1));
    doc = await load(moved.bytes);
    equal([pageTree(doc), partCounts(doc), turnsOf(doc)], [[0, 1, 2], [3], [90, 90, 90]], 'Pages moved: flat, each with the turn it inherited');
    equal(doc.getPages().map((p) => [p.node.has(N('MediaBox')), p.node.has(N('Rotate')), p.getSize()]), Array(3).fill([true, true, { width: 612, height: 792 }]), 'and the size, now their own');
    equal(squash((await readBack(page, url, moved.bytes)).texts), ['DEEPTHREE', 'DEEPONE', 'DEEPTWO'], 'in the new order');
  }

  // --- aPageListedTwiceIsRemovedWhereChosen: a damaged PDF whose page tree lists one page twice
  // shows it twice. Taking out one of the two keeps the other where it is.
  {
    const d = await newDoc();
    const pages = ['ONE', 'TWO'].map((word) => textPage(d, `PAGE ${word}`));
    const tree = d.catalog.lookup(N('Pages'));
    tree.set(N('Kids'), d.context.obj([pages[0].ref, pages[1].ref, pages[0].ref]));
    tree.set(N('Count'), PDFNumber.of(3));
    const twiceIn = pdfIn('listed_twice.pdf', await save(d));
    equal(await call('countPages', twiceIn), 3, 'A page listed twice is counted twice, as viewers show it');
    const left = await call('reorganizePdf', twiceIn, pagesOf(0, 1));
    equal(squash((await readBack(page, url, left.bytes)).texts), ['PAGEONE', 'PAGETWO'], 'The second of the two taken out');
    const right = await call('reorganizePdf', twiceIn, pagesOf(1, 2));
    equal(squash((await readBack(page, url, right.bytes)).texts), ['PAGETWO', 'PAGEONE'], 'The first of the two taken out');
    const one = await call('reorganizePdf', twiceIn, pagesOf(1));
    equal([squash((await readBack(page, url, one.bytes)).texts), holds(everythingIn(one.bytes), 'PAGE ONE')], [['PAGETWO'], false], 'Both taken out: the page is gone');
  }

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
    const left = await call('reorganizePdf', damagedIn, pagesOf(0, 2));
    equal(squash((await readBack(page, url, left.bytes)).texts), ['PAGEONE', 'PAGETHREE'], 'Removing a page of a damaged page tree');
    const rotated = await call('reorganizePdf', damagedIn, turnedBy(3, { 1: 90 }));
    back = await readBack(page, url, rotated.bytes);
    equal([squash(back.texts), back.sizes.map((s) => s[2])], [['PAGEONE', 'PAGETWO', 'PAGETHREE'], [0, 90, 0]], 'Turning a page of a mended tree');
  }

  // --- Pages only turned: only the turn changes.
  {
    const rotSrc = await simple('TURN', 3, [A4, LETTER, [400, 300]]);
    const turnIn = pdfIn('turn.pdf', rotSrc);
    const rotated = await call('reorganizePdf', turnIn, { pages: [{ page: 0, rotation: 270 }, { page: 1, rotation: -90 }, { page: 2, rotation: 180 }], fileName: 'turned' });
    equal([rotated.name, rotated.pageCount], ['turned.pdf', 3], 'Pages turned: name and count');
    const before = await load(rotSrc);
    doc = await load(rotated.bytes);
    equal(doc.getPages().map((p) => p.getRotation().angle), [270, 270, 180], 'Three quarters right is one left, and left is negative');
    equal(doc.getPages().map((p) => p.getSize()), before.getPages().map((p) => p.getSize()), 'Sizes stay');
    check([0, 1, 2].every((i) => contentOf(doc, i) === contentOf(before, i)), 'Content stays exactly as it was');
    back = await readBack(page, url, rotated.bytes);
    equal(back.sizes, [[842, 595, 270], [792, 612, 270], [400, 300, 180]], 'Viewers show them turned');
    const turnedList = await call('reorganizePdf', turnIn, turnedBy(3, { 1: 90 }));
    equal((await load(turnedList.bytes)).getPages().map((p) => p.getRotation().angle), [0, 90, 0], 'The pages as a plain list');
    // A page not turned keeps its /Rotate exactly as it was written, however oddly: more than a
    // full turn (page 1), to the left (page 2), kept in an object of its own (page 3).
    {
      const odd = await load(await simple('ODD', 4));
      const oddPages = odd.getPages();
      oddPages[0].node.set(N('Rotate'), PDFNumber.of(450));
      oddPages[1].node.set(N('Rotate'), PDFNumber.of(-90));
      oddPages[2].node.set(N('Rotate'), odd.context.register(PDFNumber.of(90)));
      const oddIn = pdfIn('odd.pdf', await save(odd));
      const written = async (bytes) => (await load(bytes)).getPages().map((p) => p.node.get(N('Rotate'))?.toString() ?? null);
      const dicts = async (bytes) => (await load(bytes)).getPages().map((p) => p.node.toString());
      const asWritten = await written(oddIn.bytes);
      check(asWritten[0] === '450' && asWritten[1] === '-90' && /^\d+ 0 R$/.test(asWritten[2]) && asWritten[3] === null, `The fixture's turns as written: ${asWritten}`);
      const oneTurned = await call('reorganizePdf', oddIn, turnedBy(4, { 3: 90 }));
      equal(await written(oneTurned.bytes), [...asWritten.slice(0, 3), '90'], 'Pages not turned keep their turn as it was written');
      equal((await dicts(oneTurned.bytes)).slice(0, 3), (await dicts(oddIn.bytes)).slice(0, 3), 'and the rest of their dictionaries, entry for entry');
      const oneRemoved = await call('reorganizePdf', oddIn, without(4, 3));
      equal(await written(oneRemoved.bytes), asWritten.slice(0, 3), 'also beside a page left out');
      // A page that is turned has such a turn read as viewers read it, and written plainly.
      const allTurned = await call('reorganizePdf', oddIn, turnedBy(4, { 0: 90, 1: 90, 2: 90 }));
      equal(await written(allTurned.bytes), ['180', '0', '180', null], 'A turn written oddly is read as viewers read it once the page is turned');
    }
    // The turn a page has is added to: saved once more, the pages turned above turn further.
    const twice = await call('reorganizePdf', pdfIn('turned.pdf', rotated.bytes), turnedBy(3, { 0: 180, 2: 90 }));
    equal((await load(twice.bytes)).getPages().map((p) => p.getRotation().angle), [90, 270, 270], 'Turns add up to the turn a page has');
    await rejects(call('reorganizePdf', turnIn, turnedBy(3, { 0: 45 })), /pdf_process_failed/, 'Only quarter turns');
    await rejects(call('reorganizePdf', turnIn, [{ page: 1 }, { page: 0, rotation: 45 }]), /pdf_process_failed/, 'Only quarter turns, among pages moved too');
  }

  // --- turningPagesChangesOnlyTheirTurn (PdfEditingDeviceTest)
  {
    const mixedSrc = await mixedPages();
    const turns = [90, 90, 0, 270];
    const out = await call('reorganizePdf', pdfIn('mixed.pdf', mixedSrc), turns.map((rotation, index) => ({ page: index, rotation })));
    await saveOutput('organize_pages_turned.pdf', out.bytes);
    const was = await load(mixedSrc);
    doc = await load(out.bytes);
    equal(doc.getPages().map((p) => p.getRotation().angle), [90, 180, 0, 180], 'Each turn is added to the turn the page had');
    // The content isn't touched: only the page's turn changes.
    equal(doc.getPages()[0].getSize(), { width: A4[0], height: A4[1] }, 'Page 1 keeps its size');
    equal(doc.getPages()[2].getCropBox().x, 100, 'Page 3 keeps its crop box');
    turns.forEach((turn, i) => {
      // Each page keeps what its dictionary had, and only a page turned gets a /Rotate it may not have had.
      equal(ownEntries(doc, i), [...new Set([...ownEntries(was, i), ...(turn ? ['Rotate'] : [])])].sort(), `Page ${i + 1}'s entries`);
      check(contentOf(doc, i) === contentOf(was, i), `Page ${i + 1}'s content is as it was`);
      for (const box of ['MediaBox', 'CropBox']) {
        equal(doc.getPages()[i].node.lookup(N(box))?.toString(), was.getPages()[i].node.lookup(N(box))?.toString(), `Page ${i + 1}'s ${box}`);
      }
    });
    // The page not turned is as it was.
    const [untouched, original] = [doc.getPages()[2].node, was.getPages()[2].node];
    check(!untouched.has(N('Rotate')), 'The page not turned gets no /Rotate');
    equal(untouched.toString(), original.toString(), 'and its dictionary is as it was, entry for entry');
    equal(untouched.lookup(N('Resources')).toString(), original.lookup(N('Resources')).toString(), 'with the resources it had');
    back = await readBack(page, url, out.bytes);
    equal(squash(back.texts).join(''), 'CAPTIONACAPTIONBCAPTIONCCAPTIOND', 'The text is all there, in order');
    check(back.sizes[0][0] > back.sizes[0][1], 'Page 1 is shown sideways now');
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
  await rejects(call('reorganizePdf', pdfIn('cut.pdf', alpha.subarray(0, 200)), pagesOf(1, 2)), /pdf_import_failed|pdf_process_failed/, 'A PDF cut short');
  {
    // Content that inflates hugely, and a form drawing itself: still finishes.
    const d = await newDoc();
    const ctx = d.context;
    const selfForm = ctx.nextRef();
    ctx.assign(selfForm, ctx.flateStream('/Fm0 Do', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { XObject: { Fm0: selfForm } } }));
    const shared = ctx.register(ctx.obj({ Font: { F1: d.helv }, XObject: { Fm0: selfForm } }));
    textPage(d, 'LOOPING FORM', { resources: shared, extra: '/Fm0 Do' });
    textPage(d, 'SECOND', { resources: shared });
    const out = await call('reorganizePdf', pdfIn('selfform.pdf', await save(d)), pagesOf(0));
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
    const out = await call('reorganizePdf', pdfIn('bomb.pdf', await save(d)), pagesOf(0));
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
    const deleted = await call('reorganizePdf', staticIn, without(5, 3));
    check(!holds(everythingIn(deleted.bytes), 'SECRET XFA DATA') && fieldNames(await load(deleted.bytes)).join() === 'keep', 'Removing pages drops a static XFA form, keeping the fields left');
    const movedXfa = await call('reorganizePdf', staticIn, pagesOf(4, 0, 1, 2));
    check(!holds(everythingIn(movedXfa.bytes), 'SECRET XFA DATA') && fieldNames(await load(movedXfa.bytes)).join() === 'keep', 'and so does removing them among pages moved');
    // With every page kept, no value has to go: the form stays whole.
    const turnedXfa = await call('reorganizePdf', staticIn, turnedBy(5, { 3: 90 }));
    check(holds(everythingIn(turnedXfa.bytes), 'SECRET XFA DATA') && fieldNames(await load(turnedXfa.bytes)).join() === 'keep,secret', 'Pages only turned keep a static XFA form and every field');
    const partsXfa = await call('splitPdf', staticIn, { groups: [[0]] });
    check(!holds(everythingIn(partsXfa[0].bytes), 'SECRET XFA DATA'), 'A part of a split has no XFA form');
    const mergedXfa = await call('mergePdfs', [staticIn, alphaIn], {});
    check(!holds(everythingIn(mergedXfa.bytes), 'SECRET XFA DATA') && fieldNames(await load(mergedXfa.bytes)).join() === 'keep,secret', 'A merge keeps the fields, not the XFA form');
    const dynamicIn = pdfIn('dynamic_xfa.pdf', await withXfa(true));
    await rejects(call('mergePdfs', [alphaIn, dynamicIn], {}), /pdf_process_failed/, 'A dynamic XFA form is not merged');
    check(holds(everythingIn((await call('reorganizePdf', dynamicIn, turnedBy(5, { 0: 90 }))).bytes), 'SECRET XFA DATA'), 'Pages only turned leave a dynamic XFA form as it is');
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
      // Reorganize, as its screen calls it: saved in place, then with pages moved and a PDF added.
      const inPlace = [];
      await mod.reorganizePdf({ name: 'many.pdf', bytes }, { pages: [{ page: 0 }, { page: 5, rotation: 90 }] }, [], { onProgress: (done, total) => inPlace.push([done, total]) });
      const laidOut = [];
      await mod.reorganizePdf({ name: 'many.pdf', bytes }, { pages: [{ page: 5 }, { page: 0 }, { input: 0, page: 1 }] }, [{ name: 'b.pdf', bytes }], { onProgress: (done, total) => laidOut.push([done, total]) });
      const stopped = [];
      for (const pages of [[{ page: 0 }, { page: 5 }], [{ page: 5 }, { page: 0 }]]) {
        try {
          await mod.reorganizePdf({ name: 'many.pdf', bytes }, { pages }, [], { signal: early.signal });
          stopped.push('finished');
        } catch (e) {
          stopped.push(e.name);
        }
      }
      return { seen, cancelled, before, inPlace, laidOut, stopped };
    }, { src: new URL(ENGINE, url).href, b64: Buffer.from(many).toString('base64') });
    const totals = new Set(result.seen.map(([, t]) => t));
    check(result.seen.length > 4 && totals.size === 1 && result.seen.every(([d, t], i) => d <= t && (i === 0 || d >= result.seen[i - 1][0])), `Progress goes up to its total: ${JSON.stringify(result.seen.slice(-2))}`);
    equal(result.seen[result.seen.length - 1][0], result.seen[0][1], 'and reaches it');
    equal(result.cancelled, 'CancelledError', 'Cancelling stops a split');
    equal(result.before, 'CancelledError', 'A signal aborted before it starts stops a merge');
    equal(result.inPlace, [[1, 3], [2, 3], [3, 3]], 'Reorganize in place: the PDF read, its pages turned and removed, the PDF saved');
    equal(result.laidOut, [[1, 4], [2, 4], [3, 4], [4, 4]], 'Reorganize with a PDF added: one step more for it');
    equal(result.stopped, ['CancelledError', 'CancelledError'], 'A signal aborted before it starts stops a reorganize, either way it saves');
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
      // Pages 2 to 299 removed, then every page turned: both saved in place.
      const deleted = await mod.reorganizePdf({ name: 'long.pdf', bytes }, [{ page: 0 }, { page: 299 }]);
      const turned = await mod.reorganizePdf({ name: 'long.pdf', bytes }, Array.from({ length: 300 }, (_, page) => ({ page, rotation: 90 })));
      clearInterval(timer);
      const seconds = (performance.now() - started) / 1000;
      // The two PDFs go back to the test, which reads them: the counts the engine gives are not enough.
      const base64 = (data) => {
        let text = '';
        for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
        return btoa(text);
      };
      return { parts: out.length, left: deleted.pageCount, turned: turned.pageCount, leftPdf: base64(deleted.bytes), turnedPdf: base64(turned.bytes), seconds, worst };
    }, { src: new URL(ENGINE, url).href, b64: Buffer.from(longPdf).toString('base64') });
    equal([result.parts, result.left, result.turned], [300, 2, 300], 'A 300-page PDF split into every page, 298 removed, and all 300 turned');
    // What the two files hold: the first and the last page alone, and a quarter turn on every page.
    const leftPdf = Buffer.from(result.leftPdf, 'base64');
    equal([(await load(leftPdf)).getPageCount(), squash((await readBack(page, url, leftPdf)).texts)], [2, ['LONGONE', 'LONG300']], 'The PDF with 298 pages removed holds its first and last page');
    check(!holds(everythingIn(leftPdf), 'LONG 150'), 'and nothing of a page between');
    const longTurns = turnsOf(await load(Buffer.from(result.turnedPdf, 'base64')));
    equal([longTurns.length, longTurns.filter((angle) => angle === 90).length], [300, 300], 'The PDF with every page turned has 300 pages, each a quarter turned');
    console.log(`  300 pages split, pages removed and pages turned in ${result.seconds.toFixed(1)} s; longest pause ${Math.round(result.worst)} ms`);
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
      await run('loadPdf', async () => { await p.loadPdf(bytes()); return 'done'; });
      await run('readPages', async () => c.readPages(await p.loadPdf(bytes())).pages.length);
      await run('repairPageTree', async () => c.repairPageTree(await p.loadPdf(bytes())).pages.length);
      await run('setPages', async () => { c.setPages(await p.loadPdf(bytes()), []); return 'done'; });
      await run('dropRemovedPages', async () => { await c.dropRemovedPages(await p.loadPdf(bytes()), [], c.ticker()); return 'done'; });
      await run('splitPdf', async () => (await o.splitPdf(input(), { mode: 'every' })).map((f) => f.pageCount));
      await run('mergePdfs', async () => (await o.mergePdfs([input(), input()], {})).pageCount);
      // Reorganize, each way it saves: a page removed and a page turned in place, pages moved laid out again.
      await run('reorganizePdf', async () => (await o.reorganizePdf(input(), [{ page: 0 }])).pageCount);
      await run('removed', async () => (await o.reorganizePdf(input(), [{ page: 1 }])).pageCount);
      await run('moved', async () => (await o.reorganizePdf(input(), [{ page: 1 }, { page: 0 }])).pageCount);
      await run('turned', async () => {
        const turned = await o.reorganizePdf(input(), [{ page: 0 }, { page: 1, rotation: 90 }]);
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
    for (const engine of ['repairPageTree', 'splitPdf', 'mergePdfs', 'reorganizePdf', 'removed', 'moved', 'turned']) {
      equal(r[engine], damaged, `${where}: ${engine} says the PDF is damaged`);
    }
    if (UNCOUNTED.has(name)) {
      for (const fn of ['readPages', 'dropRemovedPages', 'countPages']) equal(r[fn], damaged, `${where}: ${fn} says the PDF is damaged`);
    } else {
      equal([r.readPages, r.countPages, r.dropRemovedPages], [0, 0, 'done'], `${where}: no pages are read`);
    }
    equal(r.setPages, NO_CATALOG.has(name) ? damaged : 'done', `${where}: setPages`);
    // Without a catalog loadPdf itself says so; with one, the engines find what is missing.
    equal(r.loadPdf, NO_CATALOG.has(name) ? damaged : 'done', `${where}: loadPdf`);
    equal(r.shownPageSize, { width: 595.27563, height: 841.8898 }, `${where}: a page size that can't be read is A4`);
  }
  const looping = results.looping;
  equal([looping.readPages, looping.repairPageTree, looping.countPages], [2, 2, 2], `${browser}: a looping tree's two pages are read once each`);
  equal(looping.turned, { pageCount: 2, sizes: [[200, 300], [200, 400]] }, `${browser}: a looping tree is mended, its page without a type kept`);
  equal([looping.splitPdf, looping.mergePdfs, looping.reorganizePdf, looping.removed, looping.moved], [[1, 1], 4, 1, 1, 2], `${browser}: every tool reads a looping tree`);
}

/** The same engines in Firefox and WebKit, briefly: they use nothing Chromium alone has. */
async function otherBrowserTests(page, url, browser) {
  const call = (name, ...args) => runInPage(page, url, ENGINE, name, ...args);
  const chaptersIn = pdfIn('chapters.pdf', await chapters({ named: true }));
  const deleted = await call('reorganizePdf', chaptersIn, pagesOf(0, 2, 4));
  check(!holds(everythingIn(deleted.bytes), 'SECRET VALUE') && deleted.pageCount === 3, `${browser}: pages removed`);
  const parts = await call('splitPdf', chaptersIn, { mode: 'custom', pages: '1-2;3-5', combine: false });
  equal(parts.map((p) => p.name), ['chapters_split_1_1-2.pdf', 'chapters_split_2_3-5.pdf'], `${browser}: split`);
  const merged = await call('mergePdfs', [chaptersIn, chaptersIn], { pages: [{ input: 1, page: 4 }, { input: 0, page: 0, rotation: 90 }] });
  equal(merged.pageCount, 2, `${browser}: merge`);
  const reo = await call('reorganizePdf', chaptersIn, [{ page: 1 }, { blank: true, width: 200, height: 200 }]);
  equal(reo.pageCount, 2, `${browser}: a page kept and a blank page added`);
  const rot = await call('reorganizePdf', chaptersIn, turnedBy(5, { 0: 270 }));
  equal((await load(rot.bytes)).getPages().map((p) => p.getRotation().angle), [270, 0, 0, 0, 0], `${browser}: a page turned`);
  const nested = await call('reorganizePdf', pdfIn('nested.pdf', await nestedPages()), [{ page: 0, rotation: 90 }, { page: 2 }]);
  const nestedDoc = await load(nested.bytes);
  equal([pageTree(nestedDoc), nestedDoc.getPages().map((p) => p.getRotation().angle)], [[[0], 1], [180, 0]], `${browser}: saved in place, the page tree keeps its nesting`);
  // As the app's screen test saves it (ScreensDeviceTest): page 2 of three removed, pages 1 and 3 turned left.
  const sides = await call('reorganizePdf', pdfIn('alpha.pdf', await simple('ALPHA', 3)), [{ page: 0, rotation: 270 }, { page: 2, rotation: 270 }]);
  const sidesDoc = await load(sides.bytes);
  equal([sides.pageCount, turnsOf(sidesDoc), [0, 1].map((i) => contentOf(sidesDoc, i).includes(`ALPHA ${WORDS[i * 2]}`))], [2, [270, 270], [true, true]], `${browser}: a page removed and the pages on both sides of it turned`);
  const locked = await encrypted(await simple('ALPHA', 3), 'AES-256');
  const part = await call('splitPdf', pdfIn('locked.pdf', locked, { password: 'test123' }), { groups: [[2]] });
  equal(part[0].pageCount, 1, `${browser}: a protected PDF`);
  equal(await call('defaultName', 'split', { name: `${'é'.repeat(10)}.pdf`, pageCount: 3 }), `${'é'.repeat(10)}_split`, `${browser}: names`);
}

pageSelectionTests();
await withPage(async (page, url) => {
  // None of these engines embeds a font with pdf-lib: fontkit (157 kB gzipped) isn't loaded for them.
  const fontkitRequests = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/fontkit/')) fontkitRequests.push(r.url()); });
  await page.goto(url + 'app/vendor/VERSIONS.json');
  await engineTests(page, url);
  await damagedTrees(page, url, 'chromium');
  equal(fontkitRequests, [], 'no fontkit loaded for splitting, merging or reorganizing');
});
for (const browser of ['firefox', 'webkit']) {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/vendor/VERSIONS.json');
    await otherBrowserTests(page, url, browser);
    await damagedTrees(page, url, browser);
  }, { browser });
}
console.log(`organize: ${checks} checks passed`);
