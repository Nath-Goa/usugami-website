// Redact PDF's engine (site/app/js/engine/redact.js): what the boxes cover is gone from the whole
// file, not just hidden; pages without boxes stay as they were; sizes and turns are kept;
// metadata, bookmarks, tags, attachments, scripts and form fields that could repeat the hidden
// text are removed; Find text boxes the right words on upright, turned and cropped pages, in
// several fonts, letter-spaced and broken by a hyphen. Ported from the app's RedactionTest.kt,
// AreasTest.kt and RedactionDeviceTest.kt. The PDFs are made up here with pdf-lib.
import { readFile, access } from 'node:fs/promises';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import {
  PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString, PDFHexString, PDFDict, PDFArray,
  PDFRawStream, PDFStream, PDFRef, PDFNumber, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, setCharacterSpacing,
} from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { withPage, assert, saveOutput, root } from './harness.mjs';
import * as R from '../site/app/js/engine/redact/boxes.js';
import { PageTextBuilder, PageText, normalize } from '../site/app/js/engine/redact/page-text.js';
import { readingOrder } from '../site/app/js/engine/redact/bidi.js';
import { sanitize, redactedName } from '../site/app/js/engine/redact/names.js';

const ENGINE = 'app/js/engine/redact.js';
const near = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps;
const eq = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), `${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
function assertBox(expected, actual, message = 'box') {
  assert(expected.page === actual.page, `${message}: page ${actual.page} is not ${expected.page}`);
  for (const k of ['left', 'top', 'right', 'bottom']) {
    assert(near(expected[k], actual[k]), `${message}: ${k} ${actual[k]} is not ${expected[k]}`);
  }
}
const box = (page, left, top, right, bottom) => ({ page, left, top, right, bottom });
let passed = 0;
async function test(name, fn) {
  const started = performance.now();
  await fn();
  passed++;
  console.log(`  ok ${name} (${Math.round(performance.now() - started)} ms)`);
}

// ---- The app's unit tests (RedactionTest.kt, AreasTest.kt), in Node ----

console.log('Boxes, areas and page text');

await test('shown points go back to where they came from', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const frame = new R.PageFrame(10, 20, 400, 600, rotation);
    for (const [x, y] of [[0, 0], [12, 34], [frame.shownWidth, frame.shownHeight], [100, 5]]) {
      const [px, py] = frame.toPage(x, y);
      const [sx, sy] = frame.toShown(px, py);
      assert(near(sx, x, 0.001) && near(sy, y, 0.001), `rotation ${rotation}`);
    }
  }
  const turned = new R.PageFrame(10, 20, 400, 600, 90);
  eq(turned.toShown(410, 20), [0, 0], 'turned corner');
  eq(turned.toShown(10, 20), [0, 400], 'turned corner 2');
  // Boxes and user-space rectangles turn into each other.
  for (const rotation of [0, 90, 180, 270]) {
    const frame = new R.PageFrame(10, 20, 400, 600, rotation);
    const b = box(3, 0.1, 0.2, 0.4, 0.3);
    assertBox(b, R.rectToBox(frame, 3, R.boxToRect(frame, b)), `round trip at ${rotation}`);
  }
});

await test('boxes drawn either way are cut to the page', () => {
  assertBox(box(2, 0.1, 0.2, 0.5, 0.6), R.between(2, 0.5, 0.6, 0.1, 0.2));
  assertBox(box(0, 0, 0, 1, 0.3), R.between(0, -0.2, 0.3, 1.4, -1));
});

await test('moving stops at the edges and keeps the size', () => {
  const b = box(0, 0.1, 0.1, 0.3, 0.2);
  assertBox(box(0, 0.15, 0.08, 0.35, 0.18), R.moved(b, 0.05, -0.02));
  assertBox(box(0, 0, 0, 0.2, 0.1), R.moved(b, -1, -1));
  assertBox(box(0, 0.8, 0.9, 1, 1), R.moved(b, 5, 5));
});

await test('resizing keeps the centre and a minimum', () => {
  const b = box(1, 0.4, 0.4, 0.6, 0.5);
  assertBox(box(1, 0.39, 0.4, 0.61, 0.5), R.resized(b, 0.02, 0));
  const tiny = R.resized(b, -1, -1);
  assert(near(tiny.right - tiny.left, R.MIN_SIZE, 1e-6) && near(tiny.bottom - tiny.top, R.MIN_SIZE, 1e-6), 'smallest size');
  assert(near((tiny.left + tiny.right) / 2, 0.5, 1e-6), 'centre kept');
  assertBox(box(0, 0.8, 0, 1, 0.2), R.resized(box(0, 0.9, 0, 1, 0.1), 0.1, 0.1));
});

await test('dragging the corner keeps the other one', () => {
  const b = box(0, 0.2, 0.3, 0.4, 0.5);
  assertBox(box(0, 0.2, 0.3, 0.7, 0.9), R.withCorner(b, 0.7, 0.9));
  assertBox(box(0, 0.2, 0.3, 0.2 + R.MIN_SIZE, 0.3 + R.MIN_SIZE), R.withCorner(b, 0, 0));
  assertBox(box(0, 0.2, 0.3, 1, 1), R.withCorner(b, 3, 3));
});

await test('new boxes are centred and do not land on each other', () => {
  const first = R.defaultBox(4, 595, 842, 0);
  assert(first.page === 4, 'page');
  assert(near(first.right - first.left, 144 / 595) && near(first.bottom - first.top, 24 / 842), 'size');
  assert(near((first.left + first.right) / 2, 0.5) && near((first.top + first.bottom) / 2, 0.5), 'centred');
  const placed = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => R.defaultBox(0, 595, 842, i));
  assert(new Set(placed.map((b) => b.top)).size === 8, 'all apart');
  for (const b of placed) assert(b.top >= 0.15 && b.bottom <= 0.85, 'within the middle');
  const label = R.defaultBox(0, 100, 50, 0);
  assert(near(label.right - label.left, 0.6) && near(label.bottom - label.top, 0.2), 'small page');
});

await test('pages are drawn at 200 dpi unless huge', () => {
  eq(R.pixelSize(595, 842), [1653, 2339], 'A4');
  const [w, h] = R.pixelSize(2384, 3370);
  assert(w * h <= R.MAX_PIXELS + 10000, 'A0 is drawn smaller');
  assert(near(w / h, 2384 / 3370, 0.001), 'A0 keeps its shape');
  eq(R.pixelSize(0.1, 0.1), [1, 1], 'tiny');
});

await test('pixel bounds round outwards', () => {
  eq(R.pixelBounds(box(0, 0.101, 0.2, 0.3005, 0.40001), 100, 100), [10, 20, 31, 41], 'rounded out');
  eq(R.pixelBounds(box(0, 0, 0, 1, 1), 100, 100), [0, 0, 100, 100], 'whole page');
});

await test('tapping picks the smallest box under the finger', () => {
  const boxes = [box(0, 0.1, 0.1, 0.9, 0.9), box(0, 0.4, 0.4, 0.5, 0.42), box(1, 0.4, 0.4, 0.5, 0.42)];
  assert(R.hit(boxes, 0, 0.45, 0.41, 0, 0) === 1, 'small inside big');
  assert(R.hit(boxes, 0, 0.45, 0.395, 0.01, 0.01) === 1, 'within reach');
  assert(R.hit(boxes, 0, 0.2, 0.2, 0.01, 0.01) === 0, 'big');
  assert(R.hit(boxes, 0, 0.95, 0.95, 0.01, 0.01) === -1, 'none');
  assert(R.hit(boxes, 1, 0.45, 0.41, 0, 0) === 2, 'other page');
});

await test('a box touched is found where it is now', () => {
  const a = R.makeBox(0, 0.1, 0.1, 0.2, 0.2);
  const b = R.makeBox(1, 0.1, 0.1, 0.2, 0.2);
  const c = R.makeBox(0, 0.5, 0.5, 0.6, 0.6);
  assert(R.findBox([a, b, c], 2, c) === 2, 'in place');
  assert(R.findBox([b, c], 2, c) === 1, 'moved up');
  assert(R.findBox([a, b], 1, c) === -1, 'deleted');
  assert(R.findBox([a, b, R.moved(c, 0.1, 0)], 2, c) === -1, 'changed');
  assert(R.findBox([], 0, a) === -1, 'empty');
});

await test('boxes survive being packed into numbers', () => {
  const boxes = [R.makeBox(0, 0.1, 0.2, 0.3, 0.4), R.makeBox(41, 0, 0.5, 1, 0.75)];
  eq(R.unpack(R.pack(boxes)), boxes, 'round trip');
  eq(R.unpack([]), [], 'empty');
  assert(R.same(boxes[0], { ...boxes[0], left: 0.10001 }), 'same');
  assert(!R.same(boxes[0], { ...boxes[0], page: 1 }), 'other page');
});

function pageText(...words) {
  const b = new PageTextBuilder();
  let glyph = 0;
  for (const word of words) {
    if (word === ' ') b.space();
    else for (const c of word) b.glyph(glyph++, c);
  }
  return b.build();
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

await test('find ignores case and accents and matches across lines', () => {
  const text = pageText('Top', ' ', 'SECRET', ' ', 'José', ' ', 'Smith', ' ', 'secretary');
  eq(text.text, 'Top SECRET Jose Smith secretary', 'text');
  const secret = text.find('secret');
  eq(secret, [range(3, 8), range(18, 23)], 'secret');
  eq(text.find('  jose   SMITH '), [range(9, 17)], 'phrase');
  eq(text.find('JOSÉ'), [range(9, 12)], 'accent in the query');
  eq(text.find('   '), [], 'blank');
  eq(text.find('nothing'), [], 'nothing');
});

await test('letter-spaced text is found', () => {
  const b = new PageTextBuilder();
  [...'JANE'].forEach((c, i) => { if (i > 0) b.gap(); b.glyph(i, c); });
  b.space();
  [...'DOE'].forEach((c, i) => { if (i > 0) b.gap(); b.glyph(4 + i, c); });
  b.gap();
  b.glyph(7, 'a');
  b.gap();
  [...'natural'].forEach((c, i) => b.glyph(8 + i, c));
  const text = b.build();
  eq(text.text, 'J A N E D O E a natural', 'text');
  eq(text.find('Jane Doe'), [range(0, 6)], 'Jane Doe');
  eq(text.find('jane'), [range(0, 3)], 'jane');
  eq(text.find('anatural'), [], 'a gap beside a whole word is a space');
  eq(text.find('Ana'), [], 'Ana');
  eq(text.find('a natural'), [range(7, 14)], 'a natural');
});

await test('words broken after a hyphen are found', () => {
  const b = new PageTextBuilder();
  let g = 0;
  const word = (w) => { for (const c of w) b.glyph(g++, c); };
  word('jane.smith-'); b.lineBreak(); b.lineBreak(); word('jones@example.com'); b.space();
  word('confi'); b.glyph(g++, '\u{AD}'); b.lineBreak(); word('dential'); b.lineBreak(); word('end'); b.lineBreak();
  word('Bo-'); b.lineBreak(); word('Bob'); b.space(); word('555-'); b.lineBreak(); word('5555');
  const text = b.build();
  eq(text.text, 'jane.smith- jones@example.com confi dential end Bo- Bob 555- 5555', 'text');
  eq(text.find('Jane.Smith-Jones@example.com'), [range(0, 27)], 'address');
  assert(text.find('smith jones').length === 1, 'smith jones');
  eq(text.find('confidential'), [[...range(28, 32), ...range(34, 40)]], 'soft hyphen');
  eq(text.find('dentialend'), [], 'a break after a whole word is a space');
  assert(text.find('dential end').length === 1, 'dential end');
  eq(text.find('bob'), [range(44, 49)], 'bob');
  eq(text.find('5555'), [range(50, 57)], '5555');
});

await test('matches do not overlap', () => {
  eq(pageText('aaaa').find('aa'), [[0, 1], [2, 3]], 'aa');
});

await test('glyphs that read as several letters or none still match', () => {
  const b = new PageTextBuilder();
  b.glyph(0, '\u{FB01}'); b.glyph(1, 'n'); b.glyph(2, 'd'); b.glyph(3, '\u{AD}'); b.glyph(4, 'e'); b.glyph(5, '\u{A0}'); b.glyph(6, 'x');
  const text = b.build();
  eq(text.text, 'finde x', 'text');
  eq(text.find('find'), [[0, 1, 2]], 'find');
  eq(text.find('fin'), [[0, 1]], 'fin');
  eq(text.find('e x'), [[4, 6]], 'e x');
});

await test('typographic apostrophes and dashes match the keyboard ones', () => {
  const text = pageText('D\u{2019}Souza', ' ', '555\u{2011}1234', ' ', '10\u{2212}3', ' ', '\u{201C}quoted\u{201D}');
  eq(text.find("d'souza"), [range(0, 6)], 'apostrophe');
  eq(text.find('555-1234'), [range(7, 14)], 'hyphen');
  eq(text.find('10-3'), [range(15, 18)], 'minus');
  eq(text.find('"quoted"'), [range(19, 26)], 'quotes');
  assert(text.find('D\u{2019}SOUZA').length === 1, 'typed curly');
  const words = pageText('Straße', ' ', 'sœur');
  eq(words.find('strasse'), [range(0, 5)], 'strasse');
  eq(words.find('STRAßE'), [range(0, 5)], 'STRAßE');
  eq(words.find('soeur'), [range(6, 9)], 'soeur');
  const names = pageText('O\u{B4}Neill', ' ', 'Wałęsa', ' ', 'Søren', ' ', 'Łódź');
  eq(names.find("o'neill"), [range(0, 6)], "o'neill");
  eq(names.find('Walesa'), [range(7, 12)], 'Walesa');
  eq(names.find('soren'), [range(13, 17)], 'soren');
  eq(names.find('LODZ'), [range(18, 21)], 'LODZ');
});

await test('Devanagari is matched as written', () => {
  const b = new PageTextBuilder();
  [...'नमस्ते दुनिया'].forEach((c, i) => b.glyph(i, c));
  const text = b.build();
  assert(text.find('दुनिया').length === 1, 'found');
  assert(text.find('दनय').length === 0, "vowel signs aren't dropped");
});

await test('a match gets one box per line', () => {
  const g = (l, t, r, bt, across = true) => ({ left: l, top: t, right: r, bottom: bt, across });
  const boxes = R.boxesFor(3, [g(100, 100, 110, 112), g(110, 100, 120, 112), g(125, 100, 140, 112), g(50, 116, 70, 128)], 600, 800);
  assert(boxes.length === 2, 'two lines');
  const pad = R.TEXT_MARGIN * 12;
  assertBox(box(3, (100 - pad) / 600, (100 - pad) / 800, (140 + pad) / 600, (112 + pad) / 800), boxes[0], 'first line');
  assertBox(box(3, (50 - pad) / 600, (116 - pad) / 800, (70 + pad) / 600, (128 + pad) / 800), boxes[1], 'second line');
  const down = R.boxesFor(0, [0, 1, 2, 3].map((i) => g(300, 200 + 10 * i, 312, 210 + 10 * i, false)), 600, 800);
  assert(down.length === 1, 'one line down the page');
  assertBox(box(0, (300 - pad) / 600, (200 - pad) / 800, (312 + pad) / 600, (240 + pad) / 800), down[0], 'down the page');
  assert(R.boxesFor(0, [g(50, 100, 60, 110), g(400, 100, 410, 110)], 600, 800).length === 2, 'far apart');
});

await test('addresses are also read with their escapes as letters', () => {
  eq(R.addressForms('mailto:john.smith@example.org'), ['mailto:john.smith@example.org'], 'plain');
  assert(R.addressForms('https://example.org/team/Ana%20Silva').includes('https://example.org/team/Ana Silva'), 'space');
  assert(R.addressForms('?who=Jos%C3%A9').includes('?who=José'), 'accent');
  assert(R.addressForms('%D7%A9%D7%9C%D7%95%D7%9D').includes('שלום'), 'Hebrew');
  const forms = R.addressForms('100%+sure?to=jane+doe%2Bwork%zz%4');
  assert(forms.includes('100%+sure?to=jane+doe+work%zz%4'), 'plus kept');
  assert(forms.includes('100% sure?to=jane doe+work%zz%4'), 'plus as space');
});

await test('areas moved and moved back are where they were', () => {
  const m = [0, 2, -3, 0, 400, 10];
  const area = [0.25, 0, 0.5, 1];
  const moved = R.mapped(m, area);
  [397, 10.5, 400, 11].forEach((v, i) => assert(near(moved[i], v, 1e-4), 'mapped'));
  R.mapped(R.inverted(m), moved).forEach((v, i) => assert(near(v, area[i], 1e-4), 'inverted'));
  assert(R.inverted([1, 2, 2, 4, 0, 0]) === null, 'squashed flat');
  eq(R.intersection([0, 0, 10, 8], [5, 5, 20, 20]), [5, 5, 10, 8], 'intersection');
  assert(R.intersection([0, 0, 10, 10], [10, 0, 20, 10]) === null, 'touching edges');
  assert(R.inside([199.5, 0, 300, 200.5], [200, 0, 400, 200], 1), 'inside with slack');
  assert(!R.inside([0, 0, 200, 200], [200, 0, 400, 200], 1), 'outside');
});

await test('right-to-left text is read in reading order', () => {
  // Drawn left to right as PDF makers draw it: each word's last letter first, the second word left.
  const drawn = [...'םלוע'].concat([null], [...'םולש']).map((c) => (c === null ? null : { unicode: c }));
  const read = readingOrder(drawn).map(([g]) => (g === null ? ' ' : g.unicode)).join('');
  eq(read, 'שלום עולם', 'Hebrew');
  const latin = [{ unicode: 'a' }, null, { unicode: 'b' }];
  eq(readingOrder(latin).map(([g]) => g?.unicode ?? ' ').join(''), 'a b', 'left to right stays');
});

await test('file names', () => {
  eq(redactedName('Report.pdf'), 'Report_redacted', 'suffix');
  eq(redactedName(''), 'Usugami_redacted', 'blank');
  eq(sanitize('a/b:c.pdf', 'Redacted'), 'a_b_c', 'illegal characters');
  eq(sanitize('CON', 'Redacted'), 'CON_', 'Windows device');
  eq(sanitize('  ..  ', 'Redacted'), 'Redacted', 'fallback');
  assert(new TextEncoder().encode(redactedName('é'.repeat(300) + '.pdf')).length <= 200, 'long names are cut');
  assert(redactedName('é'.repeat(300)).endsWith('_redacted'), 'but keep their suffix');
});

// ---- Fixtures ----

/** A PNG of `width` × `height` pixels, all `color` ([r, g, b]), or each from color(x, y). */
function png(width, height, color) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const c = typeof color === 'function' ? color(x, y) : color;
      rows.set(c, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const RED = rgb(1, 0, 0);

/**
 * Writes `text` at (x, y), with the word SECRET in red and the rest black, so a picture of the page
 * shows whether every bit of it is covered. Returns the glyphs written: { page, char, x, y, red }.
 */
function write(page, pageIndex, font, text, x, y, size = 14) {
  const glyphs = [];
  let at = x;
  for (const part of text.split(/(SECRET)/)) {
    if (!part) continue;
    page.drawText(part, { x: at, y, size, font, color: part === 'SECRET' ? RED : rgb(0, 0, 0) });
    for (let k = 0; k < part.length; k++) {
      glyphs.push({ page: pageIndex, char: part[k], x: at + font.widthOfTextAtSize(part.slice(0, k), size), y, red: part === 'SECRET' });
    }
    at += font.widthOfTextAtSize(part, size);
  }
  return glyphs;
}

const str = (s) => PDFString.of(s);

/**
 * Four pages, the word SECRET (in red) on all but page 3, and the same word hidden in every place
 * a PDF can keep text besides its pages (as the app's device test):
 * 1. A4, upright: text, a form drawing FORMSECRET and an image, both listed in resources it shares
 *    with page 3; a sticky note, a green square comment, a filled-in form field, private
 *    application data and a thumbnail
 * 2. A4, turned clockwise (/Rotate 90), so its text runs down the page as shown
 * 3. A4, upright, without the word: shares page 1's resources and draws its own image, and has a
 *    form field of its own; it is never redacted. The word is only in an attached file (with its
 *    pop-up and a reply to it) and the details of a digital signature
 * 4. A4 with a crop box that leaves a 100-point border off on every side
 * Also: the document information, XMP metadata, a bookmark, named destinations, an attached file,
 * JavaScript (also run on opening), tags with alternate text and ActualText, and /DSS.
 */
async function secrets() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const shared = ctx.register(ctx.obj({}));
  const pages = [0, 1, 2, 3].map(() => doc.addPage([595.28, 841.89]));
  const [first, turned, plain, cropped] = pages;
  first.node.set(PDFName.of('Resources'), shared);
  plain.node.set(PDFName.of('Resources'), shared);
  turned.setRotation(degrees(90));
  cropped.setCropBox(100, 100, 595.28 - 200, 841.89 - 200);
  const glyphs = [];
  glyphs.push(...write(first, 0, helv, 'Public heading', 72, 760));
  glyphs.push(...write(first, 0, helv, 'The agent SECRET met them.', 72, 700));
  glyphs.push(...write(first, 0, helv, 'Lunch at Café José with Jane', 72, 660));
  glyphs.push(...write(first, 0, helv, 'Doe and nobody else.', 72, 640));
  const form = ctx.register(ctx.stream(
    'BT /F1 12 Tf 5 15 Td (FORM) Tj 1 0 0 rg (SECRET) Tj 0 g ( drawn in a form) Tj ET',
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 40], Resources: { Font: { F1: helv.ref } } },
  ));
  const formName = first.node.newXObject('Fm', form);
  first.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 72, 560), drawObject(formName), popGraphicsState());
  first.drawImage(await doc.embedPng(png(37, 23, [200, 120, 40])), { x: 72, y: 450, width: 74, height: 46 });
  glyphs.push(...write(turned, 1, helv, 'TOP SECRET on a turned page', 150, 420));
  glyphs.push(...write(plain, 2, helv, 'Unredacted page text stays.', 72, 700));
  plain.drawImage(await doc.embedPng(png(41, 29, [40, 120, 200])), { x: 72, y: 500, width: 82, height: 58 });
  glyphs.push(...write(cropped, 3, helv, 'A SECRET inside the crop box', 150, 420));

  // Comments: a sticky note and a green square, on page 1.
  const annots = (page) => {
    let a = page.node.lookup(PDFName.of('Annots'));
    if (!a) {
      a = ctx.obj([]);
      page.node.set(PDFName.of('Annots'), a);
    }
    return a;
  };
  annots(first).push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 700, 520, 720], Contents: str('SECRET note') })));
  const squareLook = ctx.register(ctx.stream('0 0.6 0 rg 0 0.6 0 RG 0 0 80 60 re B', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 80, 60] }));
  annots(first).push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [400, 100, 480, 160], C: [0, 0.6, 0], IC: [0, 0.6, 0], AP: { N: squareLook } })));

  // Form fields: one on page 1, one on page 3.
  const acro = doc.getForm();
  const name = acro.createTextField('name');
  name.setText('SECRET field value');
  name.addToPage(first, { x: 72, y: 300, width: 250, height: 24, font: helv, borderWidth: 0 });
  const keep = acro.createTextField('keepme');
  keep.setText('public value');
  keep.addToPage(plain, { x: 72, y: 300, width: 250, height: 24, font: helv, borderWidth: 0 });

  // On page 3: a file attached as a comment, with its pop-up and a reply…
  const payroll = ctx.register(ctx.flateStream('SECRET payroll', { Type: 'EmbeddedFile' }));
  const attachment = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'FileAttachment', Rect: [500, 600, 520, 620], Contents: str('payroll.txt'),
    FS: { Type: 'Filespec', F: str('payroll.txt'), EF: { F: payroll } },
  }));
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [400, 500, 550, 580], Parent: attachment }));
  ctx.lookup(attachment).set(PDFName.of('Popup'), popup);
  const reply = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [530, 600, 550, 620], Contents: str('Is this the latest?'), IRT: attachment }));
  annots(plain).push(attachment);
  annots(plain).push(popup);
  annots(plain).push(reply);
  // …and an invisible digital signature, with its signer's certificates kept for the catalog.
  const signature = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: str('Signature1'), Rect: [0, 0, 0, 0], P: plain.ref, F: 132,
    V: { Type: 'Sig', Name: str('SECRET signer'), Reason: str('SECRET reason'), Location: str('SECRET place'), Contents: PDFHexString.fromText('SECRET cert') },
  }));
  annots(plain).push(signature);
  acro.acroForm.dict.lookup(PDFName.of('Fields')).push(signature);
  acro.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  doc.catalog.set(PDFName.of('DSS'), ctx.obj({ Certs: [ctx.register(ctx.stream('SECRET cert'))] }));
  // Private application data and a thumbnail.
  const privateData = ctx.obj({ Usugami: { Private: str('SECRET private') } });
  first.node.set(PDFName.of('PieceInfo'), privateData);
  doc.catalog.set(PDFName.of('PieceInfo'), privateData);
  first.node.set(PDFName.of('Thumb'), ctx.register(ctx.stream(new Uint8Array(30 * 42).fill(128), { Width: 30, Height: 42, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })));

  doc.setTitle('SECRET title');
  doc.setAuthor('SECRET author');
  doc.setKeywords(['SECRET']);
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc>SECRET xmp</dc></x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
  const outlines = ctx.register(ctx.obj({ Type: 'Outlines', Count: 1 }));
  const item = ctx.register(ctx.obj({ Title: str('SECRET chapter'), Parent: outlines, Dest: [first.ref, PDFName.of('Fit')] }));
  ctx.lookup(outlines).set(PDFName.of('First'), item);
  ctx.lookup(outlines).set(PDFName.of('Last'), item);
  doc.catalog.set(PDFName.of('Outlines'), outlines);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  const dest = (page) => ctx.obj([page.ref, PDFName.of('Fit')]);
  const notes = ctx.register(ctx.flateStream('SECRET attachment', { Type: 'EmbeddedFile' }));
  doc.catalog.set(PDFName.of('Names'), ctx.obj({
    Dests: {
      Kids: [
        ctx.register(ctx.obj({ Names: [str('SECRETDEST'), dest(first), str('keep'), dest(plain)], Limits: [str('SECRETDEST'), str('keep')] })),
        ctx.register(ctx.obj({ Names: [str('zz'), dest(plain)], Limits: [str('zz'), str('zz')] })),
      ],
    },
    EmbeddedFiles: { Names: [str('notes.txt'), { Type: 'Filespec', F: str('notes.txt'), EF: { F: notes } }] },
    JavaScript: { Names: [str('hello'), { S: 'JavaScript', JS: str("app.alert('SECRET script');") }] },
  }));
  doc.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'JavaScript', JS: str("app.alert('SECRET on opening');") }));
  const tags = ctx.register(ctx.obj({ Type: 'StructTreeRoot' }));
  const element = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: tags, Pg: first.ref, ActualText: str('SECRET actual text'), Alt: str('SECRET alternate text') }));
  ctx.lookup(tags).set(PDFName.of('K'), ctx.obj([element]));
  doc.catalog.set(PDFName.of('StructTreeRoot'), tags);
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  return { bytes: await doc.save({ useObjectStreams: false, updateFieldAppearances: false }), glyphs };
}

// ---- Reading PDFs back (in Node, with pdf-lib and zlib, independently of the engine) ----

/** Every string, name and decoded stream reachable from the trailer, as text. */
async function everything(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context;
  const texts = [];
  const seen = new Set();
  const pending = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean);
  while (pending.length) {
    let item = pending.pop();
    if (item instanceof PDFRef) item = ctx.lookup(item);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (item instanceof PDFString || item instanceof PDFHexString) {
      texts.push(item.decodeText());
      texts.push(Buffer.from(item.asBytes()).toString('latin1'));
    } else if (item instanceof PDFName) texts.push(item.decodeText());
    else if (item instanceof PDFArray) pending.push(...item.asArray());
    else if (item instanceof PDFDict || item instanceof PDFStream) {
      const dict = item instanceof PDFStream ? item.dict : item;
      for (const [k, v] of dict.entries()) {
        texts.push(k.decodeText());
        pending.push(v);
      }
      if (item instanceof PDFRawStream) {
        let data;
        try {
          data = decodePDFRawStream(item).decode();
        } catch {
          data = item.contents;
        }
        texts.push(Buffer.from(data).toString('latin1'));
        texts.push(Buffer.from(data).swap16 ? utf16(data) : '');
      }
    }
  }
  return texts;
}

const utf16 = (data) => {
  const b = Buffer.from(data.length % 2 ? data.slice(0, -1) : data);
  return b.swap16().toString('utf16le');
};

/** The file's own bytes, and every stream in it inflated, and its hex strings decoded, as text. */
function rawTexts(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const texts = [raw];
  let at = raw.indexOf('stream');
  while (at >= 0) {
    let start = at + 6;
    if (raw.startsWith('\r\n', start)) start += 2;
    else if (raw[start] === '\n') start += 1;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      const data = inflateSync(Buffer.from(bytes.subarray(start, end)), { finishFlush: 2 });
      texts.push(data.toString('latin1'), utf16(data));
    } catch {
      // Not deflated: its raw bytes are already searched.
    }
    at = raw.indexOf('stream', end + 9);
  }
  for (const m of raw.matchAll(/<([0-9A-Fa-f\s]{8,})>/g)) {
    const hex = m[1].replace(/\s/g, '');
    const data = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
    texts.push(data.toString('latin1'), utf16(data));
  }
  return texts;
}

const leaksOf = (texts, word) => texts.filter((t) => t.toLowerCase().includes(word.toLowerCase()));

// ---- In the page ----

/** Calls an engine function in the page, with Uint8Arrays anywhere in the arguments and result. */
async function call(page, url, name, ...args) {
  const enc = (v) => {
    if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
    return v;
  };
  const result = await page.evaluate(async ({ src, name, args }) => {
    const dec = (v) => {
      if (v && typeof v === 'object' && '__b64' in v) return Uint8Array.from(atob(v.__b64), (c) => c.charCodeAt(0));
      if (Array.isArray(v)) return v.map(dec);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
      return v;
    };
    const out = (v) => {
      if (v instanceof Uint8Array) {
        let s = '';
        for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000));
        return { __b64: btoa(s) };
      }
      if (Array.isArray(v)) return v.map(out);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, out(x)]));
      return v;
    };
    const mod = await import(src);
    try {
      return { ok: out(await mod[name](...dec(args))) };
    } catch (e) {
      return { error: { name: e?.name, message: e?.message, key: e?.key, wrong: e?.wrong } };
    }
  }, { src: new URL(ENGINE, url).href, name, args: args.map(enc) });
  const dec = (v) => {
    if (v && typeof v === 'object' && '__b64' in v) return new Uint8Array(Buffer.from(v.__b64, 'base64'));
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
    return v;
  };
  if (result.error) {
    const e = new Error(`${result.error.name}: ${result.error.key ?? result.error.message}`);
    Object.assign(e, result.error);
    throw e;
  }
  return dec(result.ok);
}

/**
 * Draws page `index` of `bytes` with pdf.js in the page and reads it back: its size in pixels,
 * how many pixels are the red of the word SECRET, whether each of `boxes` (fractions) is solid
 * black, the colours at `points` ([x, y] pixels), its text, and its pixels' checksum. `scale` is
 * pixels per point, or `exact` [w, h] pixels for the whole page as shown.
 */
async function look(page, url, bytes, index, { scale = 1, exact, boxes = [], points = [], password } = {}) {
  return page.evaluate(async ({ src, b64, index, scale, exact, boxes, points, password }) => {
    const { openPdfJs } = await import(src);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pdf = await openPdfJs(data, { password });
    try {
      const pg = await pdf.getPage(index + 1);
      const base = pg.getViewport({ scale: 1 });
      const width = exact ? exact[0] : Math.floor(base.width * scale);
      const height = exact ? exact[1] : Math.floor(base.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      await pg.render({ canvasContext: context, canvas, viewport: base, transform: [width / base.width, 0, 0, height / base.height, 0, 0] }).promise;
      const pixels = context.getImageData(0, 0, width, height).data;
      let red = 0;
      let sum = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 150 && pixels[i + 1] < 110 && pixels[i + 2] < 110) red++;
        sum = (sum * 31 + pixels[i] + pixels[i + 1] * 7 + pixels[i + 2] * 13) >>> 0;
      }
      const black = boxes.map((b) => {
        const l = Math.floor(b.left * width) + 1;
        const r = Math.floor(b.right * width) - 1;
        const t = Math.floor(b.top * height) + 1;
        const bt = Math.floor(b.bottom * height) - 1;
        for (let y = t; y < bt; y++) for (let x = l; x < r; x++) {
          const i = (y * width + x) * 4;
          if (pixels[i] > 40 || pixels[i + 1] > 40 || pixels[i + 2] > 40) return false;
        }
        return true;
      });
      const colours = points.map(([x, y]) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 3)));
      const content = await pg.getTextContent();
      const text = content.items.map((i) => i.str).join(' ');
      const items = content.items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width }));
      return { width, height, red, black, colours, text, items, sum };
    } finally {
      await pdf.loadingTask.destroy();
    }
  }, { src: new URL('app/js/lib/pdfjs.js', url).href, b64: Buffer.from(bytes).toString('base64'), index, scale, exact, boxes, points, password });
}

/** pdf-lib's reading of a PDF, for its structure. */
const load = (bytes, password) => PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false, ...(password ? { password } : {}) });

/** The images a page draws directly: [{ width, height, filter, colorSpace, stream }]. */
function imagesOn(doc, index) {
  const page = doc.getPages()[index];
  const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'));
  if (!(xobjects instanceof PDFDict)) return [];
  return xobjects.entries().map(([, ref]) => doc.context.lookup(ref)).filter((s) => s instanceof PDFStream && s.dict.lookup(PDFName.of('Subtype'))?.asString() === '/Image')
    .map((s) => ({
      width: s.dict.lookup(PDFName.of('Width'))?.asNumber(),
      height: s.dict.lookup(PDFName.of('Height'))?.asNumber(),
      filter: s.dict.lookup(PDFName.of('Filter'))?.asString(),
      colorSpace: s.dict.lookup(PDFName.of('ColorSpace'))?.asString?.(),
      size: s.contents?.length,
      stream: s,
    }));
}

function contentOf(doc, index) {
  const contents = doc.getPages()[index].node.lookup(PDFName.of('Contents'));
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  return Buffer.concat(streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()))).toString('latin1');
}

const boxList = (found) => found.map((f) => f.box);

// ---- The engine in a browser ----

async function run(browser, { viewport } = {}) {
  await withPage(async (page, url) => {
    await page.goto(url + 'robots.txt');
    console.log(`Engine in ${browser}`);
    const { bytes: secretBytes, glyphs } = await secrets();
    const source = { name: 'secrets.pdf', bytes: secretBytes };

    await test('find text boxes every match and nothing else', async () => {
      const found = await call(page, url, 'findText', source, 'secret');
      const matches = [...new Set(found.map((f) => f.match))].map((m) => found.filter((f) => f.match === m));
      // Page 1: SECRET, FORMSECRET (drawn inside a form) and the filled-in form field; page 2 and
      // page 4 once each. One line each.
      eq(matches.map((m) => m.length), [1, 1, 1, 1, 1], 'one line each');
      eq(matches.map((m) => m[0].pageIndex), [0, 0, 0, 1, 3], 'pages');
      const inside = (g, rect) => g.x >= rect.x && g.x <= rect.x + rect.width && g.y >= rect.y && g.y <= rect.y + rect.height;
      for (const g of glyphs) {
        const rects = found.filter((f) => f.pageIndex === g.page).map((f) => f.rect);
        // The glyph's origin, a hair into it.
        const point = { x: g.x + 0.3, y: g.y + 0.3 };
        if (g.red) assert(rects.some((r) => inside(point, r)), `'${g.char}' of SECRET at ${g.x}, ${g.y} on page ${g.page + 1} is boxed`);
        else if (g.char.trim()) assert(!rects.some((r) => inside(point, r)), `'${g.char}' at ${g.x}, ${g.y} on page ${g.page + 1} isn't boxed`);
      }
      // Redacted with those boxes, not a speck of the red word is left on any page.
      const result = await call(page, url, 'redactPdf', source, found);
      await saveOutput('redact_find.pdf', result.bytes);
      for (const index of [0, 1, 3]) {
        assert((await look(page, url, secretBytes, index, { scale: 2 })).red > 0, `page ${index + 1} shows the word to begin with`);
        const left = (await look(page, url, result.bytes, index, { scale: 2 })).red;
        assert(left === 0, `${left} red pixels left on page ${index + 1}`);
      }
    });

    await test('find text matches across lines, ignoring case and accents', async () => {
      const jane = await call(page, url, 'findText', source, 'jane   DOE');
      eq(jane.map((f) => f.match), [0, 0], 'one match on two lines');
      assert(jane.every((f) => f.pageIndex === 0), 'page 1');
      assert(jane[1].box.top > jane[0].box.bottom - 0.005, 'the second box is lower');
      assert((await call(page, url, 'findText', source, 'cafe jose')).length === 1, 'cafe jose');
      assert((await call(page, url, 'findText', source, 'nowhere to be found')).length === 0, 'nothing');
      assert((await call(page, url, 'findText', source, '   ')).length === 0, 'blank');
    });

    // A redaction of page 1 by Find text and a box over its image, of pages 2 and 4 by Find text.
    const found = await call(page, url, 'findText', source, 'SECRET');
    const overImage = R.between(0, 60 / 595.28, 1 - 506 / 841.89, 160 / 595.28, 1 - 440 / 841.89);
    const boxes = [...boxList(found), overImage];
    const redacted = await call(page, url, 'redactPdf', source, { boxes: boxes.map((b) => ({ pageIndex: b.page, box: b })) });
    await saveOutput('redact_secrets.pdf', redacted.bytes);

    await test('the result is named and counted', () => {
      eq(redacted.name, 'secrets_redacted.pdf', 'name');
      eq(redacted.type, 'application/pdf', 'type');
      eq(redacted.pageCount, 4, 'pages');
      eq(redacted.redactedPages, [0, 1, 3], 'redacted pages');
    });

    await test('redacted text is gone from the whole file', async () => {
      assert(leaksOf(await everything(secretBytes), 'secret').length > 0, 'the source has the word');
      assert(leaksOf(rawTexts(secretBytes), 'secret').length > 0, "the source's bytes have the word");
      for (let index = 0; index < 4; index++) {
        const { text } = await look(page, url, redacted.bytes, index);
        assert(!/secret/i.test(text), `page ${index + 1} reads "${text}"`);
        // Redacted pages are pictures: they have no text at all.
        if (index !== 2) assert(!text.trim(), `page ${index + 1} has text: ${text}`);
      }
      const leaks = leaksOf(await everything(redacted.bytes), 'secret');
      assert(!leaks.length, `still in the file: ${leaks.map((l) => l.slice(0, 80))}`);
      const raw = leaksOf(rawTexts(redacted.bytes), 'secret');
      assert(!raw.length, `still in the file's bytes: ${raw.map((l) => l.slice(0, 200))}`);
    });

    await test('pages keep their size and turn, and the boxes are black where placed', async () => {
      const before = await load(secretBytes);
      const after = await load(redacted.bytes);
      for (let i = 0; i < 4; i++) {
        const a = before.getPages()[i];
        const b = after.getPages()[i];
        eq(b.getRotation().angle, a.getRotation().angle, `turn of page ${i + 1}`);
        const mb = (p) => Object.values(p.getMediaBox()).map((v) => Math.round(v * 100));
        const cb = (p) => Object.values(p.getCropBox()).map((v) => Math.round(v * 100));
        eq(mb(b), mb(a), `media box of page ${i + 1}`);
        eq(cb(b), cb(a), `crop box of page ${i + 1}`);
      }
      // A redacted page is one picture, as big as the page shown, at 200 dpi, and nothing else.
      const frames = await call(page, url, 'pageFrames', source);
      for (const i of [0, 1, 3]) {
        const images = imagesOn(after, i);
        eq(images.length, 1, `one picture on page ${i + 1}`);
        const [w, h] = R.pixelSize(frames[i].shownWidth, frames[i].shownHeight);
        eq([images[0].width, images[0].height], [w, h], `picture size on page ${i + 1}`);
        const node = after.getPages()[i].node;
        for (const key of ['Annots', 'Thumb', 'PieceInfo']) assert(!node.has(PDFName.of(key)), `no ${key} on page ${i + 1}`);
        const shot = await look(page, url, redacted.bytes, i, { exact: [w, h], boxes: boxes.filter((b) => b.page === i) });
        shot.black.forEach((black, k) => assert(black, `box ${k + 1} on page ${i + 1} is black`));
      }
      // What isn't boxed still shows, comments included: the green square on page 1 became part
      // of the picture, and the heading is still there.
      const page1 = await look(page, url, redacted.bytes, 0, { points: [[440, 842 - 130], ...[80, 100, 120, 140].map((x) => [x, 842 - 765])] });
      const [green, ...heading] = page1.colours;
      assert(green[1] > 120 && green[0] < 60, `the green square is drawn: ${green}`);
      assert(heading.some((c) => c[0] < 160), `the heading still shows: ${JSON.stringify(heading)}`);
    });

    await test('pages without boxes stay as they were', async () => {
      const before = await load(secretBytes);
      const after = await load(redacted.bytes);
      eq(contentOf(after, 2), contentOf(before, 2), 'content of page 3');
      eq((await look(page, url, redacted.bytes, 2)).text, (await look(page, url, secretBytes, 2)).text, 'text of page 3');
      // Its own image is untouched; the image and form only page 1 drew are emptied, though page 3
      // still lists them in the resources it shares with page 1.
      const widths = imagesOn(after, 2).map((i) => i.width);
      assert(widths.includes(41), `page 3's image stays: ${widths}`);
      assert(!widths.includes(37), `page 1's image is gone: ${widths}`);
      const form = after.getForm();
      eq(form.getTextField('keepme').getText(), 'public value', 'its field keeps its value');
      assert(!form.getFields().some((f) => f.getName() === 'name'), "page 1's field is gone");
      eq((await look(page, url, redacted.bytes, 2)).sum, (await look(page, url, secretBytes, 2)).sum, 'page 3 looks the same');
    });

    await test('metadata, bookmarks, tags, attachments and scripts are removed', async () => {
      const doc = await load(redacted.bytes);
      const info = doc.context.trailerInfo.Info && doc.context.lookup(doc.context.trailerInfo.Info);
      if (info) for (const key of ['Title', 'Author', 'Keywords', 'Subject']) assert(!info.has(PDFName.of(key)), `Info has no ${key}`);
      for (const key of ['Metadata', 'Outlines', 'StructTreeRoot', 'MarkInfo', 'OpenAction', 'PieceInfo', 'DSS', 'PageMode']) {
        assert(!doc.catalog.has(PDFName.of(key)), `catalog has no ${key}`);
      }
      const names = doc.catalog.lookup(PDFName.of('Names'));
      eq(names.keys().map((k) => k.asString()), ['/Dests'], 'only named destinations stay');
      const all = (await everything(redacted.bytes)).join('\n');
      assert(!all.includes('SECRETDEST'), 'the destination to the redacted page goes');
      assert(all.includes('keep') && all.includes('zz'), 'those to page 3 stay');
      const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
      assert(!acro.has(PDFName.of('SigFlags')), 'no signature flags');
    });

    await test('pages keeping what a box hides out of sight become pictures too', async () => {
      // Pages cut from one scanned spread: each draws the whole scan (red on the left, blue on the
      // right) and its crop shows one half. Pages 1 and 2 share one content stream, which also
      // writes SECRET on the left; pages 3 and 4 each have their own. Page 5 draws a logo page 1
      // also drew, where it shows: it stays as it was.
      const doc = await PDFDocument.create({ updateMetadata: false });
      const ctx = doc.context;
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      const scan = await doc.embedPng(png(2, 1, (x) => (x === 0 ? [255, 0, 0] : [0, 0, 255])));
      const logo = await doc.embedPng(png(4, 4, [0, 255, 0]));
      const resources = ctx.register(ctx.obj({ Font: { F1: helv.ref }, XObject: { Scan: scan.ref, Logo: logo.ref } }));
      const stream = (text) => ctx.register(ctx.stream(text));
      const scanned = 'q 400 0 0 200 0 0 cm /Scan Do Q';
      const logoOps = 'q 20 0 0 20 150 150 cm /Logo Do Q';
      const sharedContent = stream(`${scanned} ${logoOps} BT /F1 14 Tf 20 100 Td (SECRET) Tj ET`);
      for (const [left, content] of [[0, sharedContent], [200, sharedContent], [0, stream(scanned)], [200, stream(scanned)], [0, stream(logoOps)]]) {
        const p = doc.addPage([400, 200]);
        p.setMediaBox(left, 0, 200, 200);
        p.node.set(PDFName.of('Resources'), resources);
        p.node.set(PDFName.of('Contents'), content);
      }
      const bytes = await doc.save();
      const result = await call(page, url, 'redactPdf', { name: 'spread.pdf', bytes }, { 0: [{ left: 0, top: 0, right: 1, bottom: 1 }], 2: [{ left: 0, top: 0, right: 1, bottom: 1 }] });
      await saveOutput('redact_spread.pdf', result.bytes);
      eq(result.picturedPages, [0, 1, 2, 3], 'pages 2 and 4 become pictures too');
      assert(!leaksOf(await everything(result.bytes), 'secret').length, 'the word is gone');
      const out = await load(result.bytes);
      eq(contentOf(out, 4), logoOps, 'page 5 keeps its own content');
      // No image left in the file has any of the red half: pages 2 and 4 are pictures of their blue half.
      for (const index of [1, 3]) {
        const [colour] = (await look(page, url, result.bytes, index, { points: [[100, 100]] })).colours;
        assert(colour[2] > 200 && colour[0] < 60, `page ${index + 1} still shows blue: ${colour}`);
        assert((await look(page, url, result.bytes, index)).red === 0, `page ${index + 1} shows no red`);
      }
      assert(!(await anImageIsRed(page, url, result.bytes)), 'an image keeps the red half');
    });

    await test('an image under a box does not stay for a hidden stamp', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const ctx = doc.context;
      const photo = await doc.embedPng(png(4, 4, [255, 0, 0]));
      const p1 = doc.addPage([200, 200]);
      p1.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Photo: photo.ref } }));
      p1.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q 200 0 0 200 0 0 cm /Photo Do Q')));
      const look2 = ctx.register(ctx.stream('q 50 0 0 50 0 0 cm /Photo Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50], Resources: { XObject: { Photo: photo.ref } } }));
      const p2 = doc.addPage([200, 200]);
      p2.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [20, 20, 70, 70], F: 2, AP: { N: look2 } }))]));
      const result = await call(page, url, 'redactPdf', { name: 'stamped.pdf', bytes: await doc.save() }, { 0: [{ left: 0, top: 0, right: 1, bottom: 1 }] });
      eq(result.picturedPages, [0, 1], 'page 2 becomes a picture');
      assert(!(await anImageIsRed(page, url, result.bytes)), 'the photo stays in the file');
    });

    await test("shared patterns and soft masks of a redacted page go", async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const ctx = doc.context;
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      const fonts = ctx.obj({ F1: helv.ref });
      const pattern = ctx.register(ctx.stream('BT /F1 12 Tf 2 10 Td (SECRET) Tj ET', {
        Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 120, 30], XStep: 120, YStep: 30, Resources: { Font: fonts },
      }));
      const mask = ctx.register(ctx.stream('BT /F1 30 Tf 60 300 Td (SECRET) Tj ET', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], Group: { S: 'Transparency' }, Resources: { Font: fonts },
      }));
      const pagesTree = doc.catalog.lookup(PDFName.of('Pages'));
      pagesTree.set(PDFName.of('Resources'), ctx.obj({ Font: fonts, Pattern: { P1: pattern }, ExtGState: { G1: { SMask: { S: 'Luminosity', G: mask } } } }));
      for (const content of ['q /Pattern cs /P1 scn 50 600 360 120 re f Q q /G1 gs 0 g 50 200 400 200 re f Q', 'BT /F1 14 Tf 50 700 Td (Public) Tj ET']) {
        const p = doc.addPage([595, 842]);
        p.node.delete(PDFName.of('Resources'));
        p.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
      }
      const bytes = await doc.save();
      eq(leaksOf(await everything(bytes), 'secret').length >= 2, true, 'the source has the word twice');
      const result = await call(page, url, 'redactPdf', { name: 'patterns.pdf', bytes }, { 0: [{ left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 }] });
      assert(!leaksOf(await everything(result.bytes), 'secret').length, 'still in the file');
      assert((await look(page, url, result.bytes, 1)).text.includes('Public'), 'page 2 keeps its text');
    });

    await test('find text finds what comments say', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const ctx = doc.context;
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      const p1 = doc.addPage([595, 842]);
      write(p1, 0, helv, 'Meeting with John Smith', 72, 700);
      const p2 = doc.addPage([595, 842]);
      p2.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 700, 520, 720], Contents: str('Call John\nSmith about it') }))]));
      // A highlight by John Smith: its page goes too, but what it marks isn't blacked out.
      const p3 = doc.addPage([595, 842]);
      p3.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [72, 400, 472, 600], T: str('John Smith'), QuadPoints: [72, 600, 472, 600, 72, 400, 472, 400] }))]));
      const input = { name: 'commented.pdf', bytes: await doc.save() };
      const hits = await call(page, url, 'findText', input, 'john smith');
      eq(hits.map((h) => h.pageIndex), [0, 1, 2], 'pages');
      const mark = hits[2].box;
      assert(near(mark.right - mark.left, R.MIN_SIZE, 1e-6) && near(mark.bottom - mark.top, R.MIN_SIZE, 1e-6), 'a small box at the highlight');
      // The note's box covers the note.
      const note = hits[1].rect;
      assert(note.x <= 500.01 && note.y <= 700.01 && note.x + note.width >= 519.99 && note.y + note.height >= 719.99, `the note is covered: ${JSON.stringify(note)}`);
      const result = await call(page, url, 'redactPdf', input, hits);
      assert(!leaksOf(await everything(result.bytes), 'smith').length, 'Smith is gone');
    });

    await test('find text finds link addresses and hidden field values', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const ctx = doc.context;
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      const p1 = doc.addPage([595, 842]);
      write(p1, 0, helv, 'Email me', 72, 700);
      p1.node.set(PDFName.of('Annots'), ctx.obj([
        ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 695, 152, 715], A: { S: 'URI', URI: str('mailto:john.smith@example.org') } })),
        // A name with a space is in a web address only as an escape.
        ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 650, 152, 670], A: { S: 'URI', URI: str('https://example.org/team/Ana%20Silva') } })),
      ]));
      const p2 = doc.addPage([595, 842]);
      const contact = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: str('contact'), V: str('John Smith'), Rect: [72, 600, 272, 620], F: 2, P: p2.ref }));
      const office = ctx.register(ctx.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Ch', Ff: 131072, T: str('office'), Opt: [[str('a1'), str('Ana Silva')], [str('b2'), str('Bo Chen')]],
        V: str('b2'), Rect: [72, 500, 272, 520], F: 2, P: p2.ref,
      }));
      p2.node.set(PDFName.of('Annots'), ctx.obj([contact, office]));
      const former = ctx.register(ctx.obj({ FT: 'Tx', T: str('former'), V: str('Ana Silva') }));
      doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [contact, office, former] }));
      const input = { name: 'addresses.pdf', bytes: await doc.save() };
      const smith = await call(page, url, 'findText', input, 'smith');
      eq(smith.map((h) => h.pageIndex), [0, 1], 'smith pages');
      for (const h of smith) assert(near(h.box.right - h.box.left, R.MIN_SIZE, 1e-6), 'small boxes');
      const silva = await call(page, url, 'findText', input, 'ana silva');
      // The field on no page gets no box: Redact takes it out, told what was looked for.
      eq(silva.map((h) => h.pageIndex), [0, 1], 'ana silva pages');
      const result = await call(page, url, 'redactPdf', input, [...smith, ...silva], { searched: ['smith', 'ana silva'] });
      const all = await everything(result.bytes);
      assert(!leaksOf(all, 'smith').length && !leaksOf(all, 'silva').length, `gone: ${[...leaksOf(all, 'smith'), ...leaksOf(all, 'silva')]}`);
    });

    await test('letter-spaced words, hyphen breaks, several fonts, ligatures and fake bold are found', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      doc.registerFontkit(fontkit);
      const times = await doc.embedFont(StandardFonts.TimesRoman);
      const courier = await doc.embedFont(StandardFonts.Courier);
      const liberation = await doc.embedFont(await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)), { subset: true });
      const p = doc.addPage([595, 842]);
      // A heading in spaced capitals, set with character spacing.
      p.pushOperators(setCharacterSpacing(6));
      p.drawText('JANE DOE', { x: 72, y: 760, size: 18, font: times });
      p.pushOperators(setCharacterSpacing(0));
      p.drawText('Write to jane.smith-', { x: 72, y: 700, size: 12, font: courier });
      p.drawText('jones@example.com today.', { x: 72, y: 686, size: 12, font: courier });
      p.drawText('Wałęsa met Łódź officials', { x: 72, y: 640, size: 12, font: liberation });
      p.drawText('The confidential file', { x: 72, y: 600, size: 12, font: times });
      // Bold made by drawing the words twice, a hair apart, as some PDF makers do.
      p.drawText('Fake Bold Name', { x: 72, y: 560, size: 12, font: times });
      p.drawText('Fake Bold Name', { x: 72.3, y: 560, size: 12, font: times });
      const input = { name: 'fonts.pdf', bytes: await doc.save() };
      const texts = await call(page, url, 'readPageTexts', input);
      const jane = await call(page, url, 'findText', input, 'Jane Doe');
      eq(jane.length, 1, `letter-spaced Jane Doe in "${texts[0]}"`);
      const address = await call(page, url, 'findText', input, 'jane.smith-jones@example.com');
      eq(address.map((f) => f.match), [0, 0], 'the address across the hyphen break, one box a line');
      eq((await call(page, url, 'findText', input, 'walesa')).length, 1, 'Walesa in an embedded font');
      eq((await call(page, url, 'findText', input, 'LODZ OFFICIALS')).length, 1, 'Łódź officials');
      eq((await call(page, url, 'findText', input, 'confidential')).length, 1, 'confidential');
      eq((await call(page, url, 'findText', input, 'bold name')).length, 1, 'words drawn twice count once');
      // Boxes hug their line: a 12-point line's box is about 20 points tall.
      const line = (await call(page, url, 'findText', input, 'today'))[0].rect;
      assert(line.height > 12 && line.height < 24, `the box is a line tall: ${line.height}`);
      assert(line.y < 686 && line.y + line.height > 686 + 8, 'around the baseline');
    });

    await test('right-to-left text drawn left to right is found as typed', async () => {
      const arial = await readFile('C:/Windows/Fonts/arial.ttf').catch(() => null);
      if (!arial) {
        console.log('    (skipped: no font with Hebrew letters)');
        return;
      }
      const doc = await PDFDocument.create({ updateMetadata: false });
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(arial, { subset: true });
      const p = doc.addPage([595, 842]);
      // As PDF makers draw it: each word's last letter first, and the second word left of the first.
      let x = 72;
      for (const word of ['עולם', 'שלום']) {
        for (const c of [...word].reverse()) {
          p.drawText(c, { x, y: 700, size: 20, font });
          x += font.widthOfTextAtSize(c, 20);
        }
        x += 12;
      }
      const end = x - 12;
      const hits = await call(page, url, 'findText', { name: 'hebrew.pdf', bytes: await doc.save() }, 'שלום עולם');
      eq(hits.length, 1, 'one box over both words');
      assert(hits[0].rect.x < 73 && hits[0].rect.x + hits[0].rect.width > end - 1, `from the left word to the right one: ${JSON.stringify(hits[0].rect)}`);
    });

    await test('a box hides all of what it is placed over, on a page of no whole size', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const p = doc.addPage([300, 400.9]);
      p.drawRectangle({ x: 100, y: 10, width: 100, height: 20, color: RED });
      const rect = { x: 100, y: 10, width: 100, height: 20 };
      const result = await call(page, url, 'redactPdf', { name: 'fractional.pdf', bytes: await doc.save() }, { 0: [rect] });
      const [w, h] = R.pixelSize(300, 400.9);
      eq((await look(page, url, result.bytes, 0, { exact: [w, h] })).red, 0, 'no red pixels left');
    });

    await test('text pages stay lossless and photos become JPEG', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      const text = doc.addPage([595, 842]);
      for (let line = 0; line < 40; line++) text.drawText(`Line ${line} of plain text, the kind most pages have.`, { x: 72, y: 780 - 18 * line, size: 11, font: helv });
      const photo = doc.addPage([595, 842]);
      // Like a photo: smooth colours with fine grain (mulberry32, so it is the same every time).
      let seed = 7;
      const random = () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const grain = (v) => Math.max(0, Math.min(255, Math.round(v + random() * 20 - 10)));
      // As many pixels as the redacted page has, so the grain stays as fine as in a real photo.
      const [pw, ph] = R.pixelSize(595, 842);
      photo.drawImage(await doc.embedPng(png(pw, ph, (x, y) => [grain((x * 255) / pw), grain((y * 255) / ph), grain(128)])), { x: 0, y: 0, width: 595, height: 842 });
      const result = await call(page, url, 'redactPdf', { name: 'photo.pdf', bytes: await doc.save() }, { 0: [{ left: 0.1, top: 0.1, right: 0.3, bottom: 0.12 }], 1: [{ left: 0.1, top: 0.1, right: 0.3, bottom: 0.2 }] });
      const out = await load(result.bytes);
      const [textImage] = imagesOn(out, 0);
      eq(textImage.filter, '/FlateDecode', 'the text page is lossless');
      eq(textImage.colorSpace, '/DeviceGray', 'a black-and-white page is stored in grey');
      assert(textImage.size < 400000, `the text page takes ${textImage.size} bytes`);
      eq(imagesOn(out, 1)[0].filter, '/DCTDecode', 'the photo page is a JPEG');
    });

    await test('protected PDFs are redacted without their password', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      write(doc.addPage([595, 842]), 0, helv, 'A SECRET behind a password', 72, 700);
      doc.encrypt({ userPassword: 'test123', ownerPassword: 'owner456' });
      const bytes = await doc.save();
      let error = null;
      try {
        await call(page, url, 'findText', { name: 'locked.pdf', bytes }, 'secret');
      } catch (e) {
        error = e;
      }
      assert(error?.name === 'PasswordError' && !error.wrong, `a password is asked for: ${error?.message}`);
      error = null;
      try {
        await call(page, url, 'redactPdf', { name: 'locked.pdf', bytes, password: 'nope' }, { 0: [{ left: 0, top: 0, right: 1, bottom: 1 }] });
      } catch (e) {
        error = e;
      }
      assert(error?.name === 'PasswordError' && error.wrong, `a wrong password is told: ${error?.message}`);
      const input = { name: 'locked.pdf', bytes, password: 'test123' };
      const hits = await call(page, url, 'findText', input, 'secret');
      eq(hits.length, 1, 'found behind the password');
      const result = await call(page, url, 'redactPdf', input, hits);
      const out = await load(result.bytes);
      assert(!out.isEncrypted, 'the result has no password');
      assert((await look(page, url, result.bytes, 0)).red === 0, 'no red left');
      // The app's own test PDF with a password.
      const asset = await readFile('C:/Users/Nathan/OneDrive/Desktop/pdfer/app/src/androidTest/assets/protected.pdf').catch(() => null);
      if (asset) {
        const b = { left: 0, top: 0, right: 1, bottom: 0.5 };
        const r = await call(page, url, 'redactPdf', { name: 'protected.pdf', bytes: new Uint8Array(asset), password: 'test123' }, { 0: [b] });
        assert(!(await load(r.bytes)).isEncrypted, 'protected.pdf has no password after');
        const frames = await call(page, url, 'pageFrames', { bytes: r.bytes });
        const [w, h] = R.pixelSize(frames[0].shownWidth, frames[0].shownHeight);
        assert((await look(page, url, r.bytes, 0, { exact: [w, h], boxes: [b] })).black[0], 'its box is black');
      }
    });

    await test('damaged files fail with a clear message', async () => {
      const junk = new TextEncoder().encode('%PDF-1.7\nthis is not really a PDF at all\n%%EOF');
      for (const [name, args] of [['findText', ['secret']], ['redactPdf', [{ 0: [{ left: 0, top: 0, right: 1, bottom: 1 }] }]]]) {
        let error = null;
        try {
          await call(page, url, name, { name: 'junk.pdf', bytes: junk }, ...args);
        } catch (e) {
          error = e;
        }
        assert(error?.name === 'UserError' && ['redact_find_failed', 'pdf_import_failed'].includes(error.key), `${name}: ${error?.message}`);
      }
      // Files pdf-lib opens but whose pages it can't read as viewers do: no catalog, a page tree that
      // loops, one without /Kids, a lone page in the tree's place. A UserError, never a TypeError
      // or a stack overflow.
      const handMade = (objects) => {
        let text = '%PDF-1.4\n';
        for (const [n, source] of Object.entries(objects)) text += `${n} 0 obj\n${source}\nendobj\n`;
        return new TextEncoder().encode(`${text}trailer\n<< /Root 1 0 R /Size 20 >>\n%%EOF\n`);
      };
      const content = '<< /Length 0 >>\nstream\n\nendstream';
      const damaged = {
        'no catalog': new TextEncoder().encode('%PDF-1.4 nothing else'),
        'a looping page tree': handMade({
          1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
          3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 9 0 R >>',
          4: '<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 1 >>', 9: content,
        }),
        'no /Kids': handMade({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Count 1 >>' }),
        'a lone page': handMade({ 1: '<< /Type /Catalog /Pages 3 0 R >>', 3: '<< /Type /Page /MediaBox [0 0 200 200] /Contents 9 0 R >>', 9: content }),
      };
      const outcome = await page.evaluate(async ({ src, files }) => {
        const engine = await import(src);
        const out = {};
        for (const [name, b64] of Object.entries(files)) {
          const bytes = () => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const said = async (work) => {
            try {
              const result = await work();
              return Array.isArray(result) ? `${result.length} found` : 'done';
            } catch (e) {
              return `${e.name}: ${e.key ?? e.message}`;
            }
          };
          out[name] = [
            await said(() => engine.redactPdf({ name: 'd.pdf', bytes: bytes() }, { 0: [{ left: 0.1, top: 0.1, right: 0.5, bottom: 0.5 }] })),
            await said(() => engine.pageFrames({ bytes: bytes() })),
            await said(() => engine.findText({ bytes: bytes() }, 'secret')),
          ];
        }
        return out;
      }, { src: new URL(ENGINE, url).href, files: Object.fromEntries(Object.entries(damaged).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) });
      for (const [name, [redacted, frames, found]] of Object.entries(outcome)) {
        eq(redacted, 'UserError: pdf_import_failed', `${name}: Redact says the PDF is damaged`);
        assert(/^UserError: pdf_import_failed$|^\d+ found$/.test(frames), `${name}: page frames: ${frames}`);
        assert(/^UserError: redact_find_failed$|^0 found$/.test(found), `${name}: Find text: ${found}`);
      }
    });

    await test('cancelling stops the work', async () => {
      const outcome = await page.evaluate(async ({ src, b64 }) => {
        const { redactPdf, findText } = await import(src);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const results = [];
        for (const stopAt of [1, 2, 3]) {
          const controller = new AbortController();
          let calls = 0;
          try {
            await redactPdf({ name: 'c.pdf', bytes }, { 0: [{ left: 0.1, top: 0.1, right: 0.5, bottom: 0.2 }], 1: [{ left: 0.1, top: 0.1, right: 0.5, bottom: 0.2 }] }, {
              signal: controller.signal,
              onProgress: () => { if (++calls === stopAt) controller.abort(); },
            });
            results.push('finished');
          } catch (e) {
            results.push(e.name);
          }
        }
        const controller = new AbortController();
        controller.abort();
        try {
          await findText({ bytes }, 'secret', { signal: controller.signal });
          results.push('finished');
        } catch (e) {
          results.push(e.name);
        }
        // It still works afterwards.
        const after = await redactPdf({ name: 'c.pdf', bytes }, { 0: [{ left: 0.1, top: 0.1, right: 0.5, bottom: 0.2 }] });
        results.push(after.pageCount);
        return results;
      }, { src: new URL(ENGINE, url).href, b64: Buffer.from(secretBytes).toString('base64') });
      eq(outcome, ['CancelledError', 'CancelledError', 'CancelledError', 'CancelledError', 4], 'cancelled each time');
    });

    await test('adding found boxes skips those already there', async () => {
      const hits = await call(page, url, 'findText', source, 'secret');
      const first = await call(page, url, 'addFound', [], hits);
      eq([first.added, first.matches, first.pages], [5, 5, [0, 1, 3]], 'first search');
      const again = await call(page, url, 'addFound', first.boxes, hits);
      eq([again.added, again.boxes.length], [0, 5], 'searched again');
      const many = await call(page, url, 'addFound', Array.from({ length: R.MAX_BOXES }, (_, i) => R.makeBox(0, 0, 0, 0.01, 0.01 + i * 1e-4)), hits);
      assert(many.tooMany && many.added === 0, 'too many');
    });

    await test('Type 3 fonts, invisible text and vertical writing are found', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      doc.registerFontkit(fontkit);
      const ctx = doc.context;
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      // A Type 3 font whose letters a, b and c are each a block 500 units wide.
      const block = ctx.register(ctx.stream('500 0 0 0 500 700 d1 0 0 500 700 re f'));
      const type3 = ctx.register(ctx.obj({
        Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 500, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { a: block, b: block, c: block }, Encoding: { Type: 'Encoding', Differences: [97, 'a', 'b', 'c'] },
        FirstChar: 97, LastChar: 99, Widths: [500, 500, 500], Resources: {},
      }));
      // Letters stacked down the page: an embedded font written top to bottom (Identity-V).
      const liberation = await doc.embedFont(await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)));
      const p = doc.addPage([595, 842]);
      p.node.set(PDFName.of('Resources'), ctx.obj({ Font: { T3: type3, F1: helv.ref } }));
      p.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /T3 20 Tf 72 700 Td (abcab) Tj ET BT 3 Tr /F1 12 Tf 72 600 Td (HIDDEN OCR TEXT) Tj ET')));
      p.drawText('VERTICAL', { x: 400, y: 700, size: 12, font: liberation });
      await doc.flush();
      ctx.lookup(liberation.ref).set(PDFName.of('Encoding'), PDFName.of('IdentityV'.replace('V', '-V')));
      const input = { name: 'fonts3.pdf', bytes: await doc.save() };
      const type3Hits = await call(page, url, 'findText', input, 'bca');
      eq(type3Hits.length, 1, 'Type 3 text');
      const r = type3Hits[0].rect;
      // b, c and a are blocks from 82 to 112 points, 0 to 14 points above the baseline.
      assert(r.x < 82 && r.x > 75 && r.x + r.width > 112 && r.x + r.width < 119, `along the glyphs: ${JSON.stringify(r)}`);
      assert(r.y < 700 && r.y + r.height > 714, `around the glyphs: ${JSON.stringify(r)}`);
      eq((await call(page, url, 'findText', input, 'ocr text')).length, 1, 'invisible text, as OCR layers are');
      const vertical = await call(page, url, 'findText', input, 'tic');
      eq(vertical.length, 1, 'vertical text');
      const v = vertical[0].rect;
      assert(v.height > v.width * 1.5, `a box down the page: ${JSON.stringify(v)}`);
      assert(v.x < 400 && v.x + v.width > 400 && v.y + v.height < 700, `below where it starts: ${JSON.stringify(v)}`);
    });

    await test('forms that draw themselves and damaged content do not stop redaction', async () => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const ctx = doc.context;
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      const loopRef = ctx.nextRef();
      ctx.assign(loopRef, ctx.stream('q 0.5 0 0 0.5 10 10 cm /Me Do Q BT /F1 12 Tf 5 5 Td (SECRET loop) Tj ET', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200], Resources: { XObject: { Me: loopRef }, Font: { F1: helv.ref } },
      }));
      const resources = ctx.register(ctx.obj({ XObject: { Loop: loopRef }, Font: { F1: helv.ref } }));
      const p1 = doc.addPage([400, 400]);
      p1.node.set(PDFName.of('Resources'), resources);
      p1.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q 1 0 0 1 50 50 cm /Loop Do Q')));
      const p2 = doc.addPage([400, 400]);
      // A page that can't be read keeps all its resources list (it might draw any), so it has its own.
      p2.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref } }));
      // Content that isn't deflated as it says: it can't be read.
      p2.node.set(PDFName.of('Contents'), ctx.register(PDFRawStream.of(ctx.obj({ Filter: 'FlateDecode' }), new TextEncoder().encode('not deflated at all ) ] >> {'))));
      const p3 = doc.addPage([400, 400]);
      p3.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 12 Tf 10 10 Td (Stays) ) ] } { Tj ET <<>> [ (unclosed')));
      p3.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref } }));
      const input = { name: 'loops.pdf', bytes: await doc.save() };
      const hits = await call(page, url, 'findText', input, 'secret');
      assert(hits.length >= 1 && hits.every((h) => h.pageIndex === 0), `found on page 1: ${hits.length}`);
      const result = await call(page, url, 'redactPdf', input, { 0: [{ left: 0, top: 0, right: 1, bottom: 1 }] });
      eq(result.pageCount, 3, 'all pages kept');
      eq(result.picturedPages, [0], 'only page 1 is a picture');
      assert(!leaksOf(await everything(result.bytes), 'secret loop').length, 'the form is emptied');
    });

    await test('frames and previews for the screen', async () => {
      const frames = await call(page, url, 'pageFrames', source);
      eq(frames.map((f) => [Math.round(f.shownWidth), Math.round(f.shownHeight), f.rotation]), [[595, 842, 0], [842, 595, 90], [595, 842, 0], [395, 642, 0]], 'frames');
      const preview = await page.evaluate(async ({ src, pdfjs, b64 }) => {
        const { renderPreview } = await import(src);
        const { openPdfJs } = await import(pdfjs);
        const pdf = await openPdfJs(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        const canvas = await renderPreview(pdf, 1, 300, { pixelRatio: 2 });
        // The note on page 1 (an annotation) and the field's value are drawn in the preview too.
        const first = await renderPreview(pdf, 0, 595, { pixelRatio: 1 });
        const data = first.getContext('2d').getImageData(440, 842 - 130, 1, 1).data;
        await pdf.loadingTask.destroy();
        return { tag: canvas.tagName, width: canvas.width, height: canvas.height, css: canvas.style.width, frame: canvas.frame, green: Array.from(data) };
      }, { src: new URL(ENGINE, url).href, pdfjs: new URL('app/js/lib/pdfjs.js', url).href, b64: Buffer.from(secretBytes).toString('base64') });
      eq([preview.tag, preview.width, preview.height, preview.css], ['CANVAS', 600, Math.round((600 * 595.28) / 841.89), '300px'], 'a turned page drawn sideways');
      eq(preview.frame.rotation, 90, 'with its frame');
      assert(preview.green[1] > 120 && preview.green[0] < 60, `annotations are drawn: ${preview.green}`);
    });

    await test('it lets the browser paint between pages (core/dom.js yieldToUI)', async () => {
      const r = await page.evaluate(async ({ src, b64 }) => {
        const { findText, redactPdf } = await import(src);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        // yieldToUI uses scheduler.yield() where the browser has it, else a timer: count its calls.
        const created = !globalThis.scheduler;
        const target = globalThis.scheduler ?? (globalThis.scheduler = {});
        const before = Object.getOwnPropertyDescriptor(target, 'yield');
        const own = typeof target.yield === 'function' ? target.yield.bind(target) : () => new Promise((ok) => setTimeout(ok, 0));
        let yields = 0;
        target.yield = () => { yields++; return own(); };
        let frames = 0;
        let running = true;
        const frame = () => { frames++; if (running) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        try {
          const found = await findText({ bytes }, 'secret');
          const afterFind = yields;
          const out = await redactPdf({ name: 's.pdf', bytes }, found);
          return { afterFind, yields, frames, pages: out.picturedPages.length };
        } finally {
          running = false;
          if (created) delete globalThis.scheduler;
          else if (before) Object.defineProperty(target, 'yield', before);
          else delete target.yield;
        }
      }, { src: new URL(ENGINE, url).href, b64: Buffer.from(secretBytes).toString('base64') });
      assert(r.afterFind >= 4, `Find text yields after each of the 4 pages: ${r.afterFind}`);
      assert(r.yields >= r.afterFind + 1 + r.pages, `Redact yields after each pictured page: ${JSON.stringify(r)}`);
      assert(r.frames >= 1, `frames are drawn meanwhile: ${r.frames}`);
    });
  }, { viewport, browser });
}

/** Whether any image in the PDF, wherever it is kept, has a red pixel (decoded by pdf.js's rendering of it alone). */
async function anImageIsRed(page, url, bytes) {
  const doc = await load(bytes);
  const ctx = doc.context;
  const images = [];
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream && obj.dict.lookup(PDFName.of('Subtype'))?.asString() === '/Image') images.push(obj);
  }
  for (const image of images) {
    // Each image on a page of its own, drawn over the whole page.
    const one = await PDFDocument.create({ updateMetadata: false });
    const ref = one.context.register(PDFRawStream.of(image.dict.clone(one.context), image.contents));
    const p = one.addPage([100, 100]);
    p.node.set(PDFName.of('Resources'), one.context.obj({ XObject: { I: ref } }));
    p.node.set(PDFName.of('Contents'), one.context.register(one.context.stream('q 100 0 0 100 0 0 cm /I Do Q')));
    if ((await look(page, url, await one.save(), 0)).red > 0) return true;
  }
  return false;
}

await run('chromium');
await run('firefox', { viewport: { width: 1366, height: 900 } });
await run('webkit');
console.log(`${passed} checks passed.`);
