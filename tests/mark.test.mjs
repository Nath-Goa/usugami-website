// The Usugami watermark (README: "What's new in 1.6.1", the result screen's "Usugami watermark",
// FAQ "Does Usugami put a watermark on my PDFs?"):
// - MarkStyle and MarkLayout (engine/mark-layout.js), MarkLayoutTest.kt ported, in Node;
// - the engine (engine/page-mark.js, data/PageMark.kt), as PageMarkDeviceTest.kt checks it: put on
//   each page as shown, changed, taken off leaving each page as it was, the app's own structure so
//   either app can take off the other's, tools reading a marked PDF without it (loadPdf);
// - read back in the browser with pdf.js: "Usugami" once on each page, upright in the corner
//   as shown, light grey; gone once taken off;
// - the result screen's switch (core/output.js, core/result-mark.js) at phone and desktop width:
//   off at first, its sliders and preview, remembered after a reload, the PDFs saved and shared with
//   the mark, the files as made again once it is off; and Rotate PDF in the app with the mark on.
//   node tests/mark.test.mjs           everything (Chromium, Firefox and WebKit)
//   node tests/mark.test.mjs --quick   Chromium only
import { readFile } from 'node:fs/promises';
import { withPage, assert, saveOutput } from './harness.mjs';
import {
  PDFDocument, PDFName, PDFArray, PDFDict, PDFStream, PDFNumber, PDFBool, degrees, decodePDFRawStream,
} from '../site/app/vendor/pdf-lib/pdf-lib.esm.min.js';
import {
  MarkStyle, MarkLayout, markStyle, sameMark, mayCarryMark, DEFAULT_SIZE, DEFAULT_OPACITY, MIN_OPACITY,
} from '../site/app/js/engine/mark-layout.js';
import { markPdf, unmarkPdf, unmark, carriesMark, hasMark } from '../site/app/js/engine/page-mark.js';
import { loadPdf, wasUnmarked, wasEncrypted } from '../site/app/js/engine/pdf-common.js';
import markStrings from '../site/app/locales/en/mark.js';

const quick = process.argv.includes('--quick');
let failures = 0;

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n${e.stack || e}`);
  }
}

const eq = (actual, expected, message) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${message}: ${a} should be ${b}`);
};
const near = (actual, expected, tolerance, message) => {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} should be ${expected} ± ${tolerance}`);
};
const N = (s) => PDFName.of(s);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const sameBytes = (a, b) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

// ---------------------------------------------------------------------------------------------
// MarkLayoutTest.kt, in Node

// An A4 page as shown, in points.
const A4W = 595.28;
const A4H = 841.89;

await test('MarkLayout: sizes run from barely readable to half the page', () => {
  const smallest = MarkLayout.place(new MarkStyle({ size: 0 }), A4W, A4H);
  near(smallest.fontSize, 5.6, 0.1, 'smallest');
  const def = MarkLayout.place(new MarkStyle(), A4W, A4H);
  assert(def.fontSize >= 8.8 && def.fontSize <= 9.6, `About a 9 pt font, not ${def.fontSize}`);
  // At the largest, the word starts on the page's middle.
  const largest = MarkLayout.place(new MarkStyle({ size: 100 }), A4W, A4H);
  near(largest.x, A4W / 2, 0.01, 'largest starts mid-page');
  // Each step up is bigger than the last, and the small end changes least.
  const sizes = Array.from({ length: 101 }, (_, i) => MarkLayout.widthShare(i));
  assert(sizes.every((s, i) => i === 0 || s > sizes[i - 1]), 'grows with each step');
  assert(sizes[1] - sizes[0] < sizes[100] - sizes[99], 'finest at the small end');
});

await test('MarkLayout: stays in the bottom-right corner', () => {
  for (const size of [0, 20, 60, 100]) {
    const place = MarkLayout.place(new MarkStyle({ size }), A4W, A4H);
    const f = place.fontSize;
    // Its right edge and the bottom of its "g" are a font size from the page's edges.
    near(place.x + f * MarkLayout.TEXT_WIDTH, A4W - f * MarkLayout.MARGIN, 0.01, `right edge at ${size}`);
    near(place.y - f * MarkLayout.DESCENT, f * MarkLayout.MARGIN, 0.01, `bottom at ${size}`);
  }
  // On a page much wider than tall, the word stays low on the page.
  const strip = MarkLayout.place(new MarkStyle({ size: 100 }), 2000, 100);
  near(strip.fontSize, 25, 0.01, 'a strip');
  let threw = false;
  try { MarkLayout.place(new MarkStyle(), 0, 100); } catch (e) { threw = e instanceof RangeError; }
  assert(threw, 'a page without width is refused');
});

await test('MarkStyle: stays in its ranges', () => {
  const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof RangeError; } };
  assert(throws(() => new MarkStyle({ size: 101 })), 'size 101');
  assert(throws(() => new MarkStyle({ opacity: 5 })), 'opacity 5');
  assert(throws(() => new MarkStyle({ size: 2.5 })), 'whole numbers only');
  assert(MarkStyle.of(150, 0).equals(new MarkStyle({ size: 100, opacity: 10 })), 'of() brings values into range');
  near(new MarkStyle().alpha, 0.3, 0.0001, 'alpha');
  eq([DEFAULT_SIZE, DEFAULT_OPACITY, MIN_OPACITY], [20, 30, 10], 'the app\'s defaults');
  eq(MarkStyle.of('35', null), new MarkStyle({ size: 35, opacity: 30 }), 'read from settings');
  eq(markStyle({ size: 40, opacity: 50 }), new MarkStyle({ size: 40, opacity: 50 }), 'a plain style');
  assert(markStyle(null) === null && sameMark(null, null) && !sameMark(null, new MarkStyle()), 'none');
  // Helvetica Bold's widths for U s u g a m i, in thousandths.
  eq([722, 556, 611, 611, 556, 889, 278].reduce((a, b) => a + b) / 1000, MarkLayout.TEXT_WIDTH, 'the word\'s width');
});

// ---------------------------------------------------------------------------------------------
// Fixtures

/**
 * PageMarkDeviceTest's three pages: A4 upright, Letter turned a quarter clockwise with a crop box
 * smaller than the page, and a blank one with neither content nor resources. The first two share
 * their resources.
 */
async function pagesPdf({ objectStreams = false } = {}) {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const shared = ctx.register(ctx.obj({ Font: { F1: font } }));
  const text = (s, x, y) => ctx.register(ctx.flateStream(`BT /F1 24 Tf ${x} ${y} Td (${s}) Tj ET`));
  const upright = doc.addPage([A4W, A4H]);
  upright.node.set(N('Resources'), shared);
  upright.node.set(N('Contents'), text('PAGE ONE', 72, 700));
  const turned = doc.addPage([612, 792]);
  turned.node.set(N('Resources'), shared);
  turned.node.set(N('Contents'), text('PAGE TWO', 100, 400));
  turned.setRotation(degrees(90));
  turned.setCropBox(50, 60, 500, 650);
  const blank = doc.addPage([A4W, A4H]);
  blank.node.delete(N('Resources'));
  blank.node.delete(N('Contents'));
  return doc.save({ useObjectStreams: objectStreams, addDefaultPage: false });
}

/** Pages upside down, turned left, and two that take their resources from the page tree. */
async function morePdf() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  const text = (s) => ctx.register(ctx.flateStream(`BT /F1 20 Tf 60 100 Td (${s}) Tj ET`));
  const pages = [
    { size: [400, 300], rotate: 180, text: 'UPSIDE' },
    { size: [300, 500], rotate: 270, text: 'LEFT', crop: [20, 30, 200, 400] },
    { size: [500, 500], text: 'INHERIT ONE', inherit: true },
    { size: [500, 500], text: 'INHERIT TWO', inherit: true },
  ];
  for (const p of pages) {
    const page = doc.addPage(p.size);
    page.node.set(N('Contents'), text(p.text));
    if (p.rotate) page.setRotation(degrees(p.rotate));
    if (p.crop) page.setCropBox(...p.crop);
    if (p.inherit) page.node.delete(N('Resources'));
    else page.node.set(N('Resources'), ctx.obj({ Font: { F1: font } }));
  }
  // The page tree holds the resources the last two take.
  const tree = ctx.lookup(doc.catalog.get(N('Pages')));
  tree.set(N('Resources'), ctx.register(ctx.obj({ Font: { F1: font } })));
  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

/** A page's content streams' bytes, decoded and joined. */
function contentOf(ctx, page) {
  const raw = ctx.lookup(page.get(N('Contents')));
  const list = raw instanceof PDFArray ? raw.asArray().map((r) => ctx.lookup(r)) : raw ? [raw] : [];
  return Buffer.concat(list.map((s) => Buffer.from(decodePDFRawStream(s).decode())));
}

/** What each page is (PageMarkDeviceTest.pages): its content's bytes, whether it has any, and its resources' names. */
async function pagesOf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  return doc.getPages().map(({ node }) => {
    const resources = ctx.lookup(node.get(N('Resources')));
    const names = [];
    if (resources instanceof PDFDict) {
      for (const [key, value] of resources.entries()) {
        const inner = ctx.lookup(value);
        if (inner instanceof PDFDict && inner.keys().length) for (const k of inner.keys()) names.push(`${key.decodeText()}/${k.decodeText()}`);
        else names.push(key.decodeText());
      }
    }
    return { content: b64(contentOf(ctx, node)), hasContents: node.get(N('Contents')) !== undefined, resources: names.sort(), hasResources: node.has(N('Resources')) };
  });
}

/** A page as shown (PageFrame), from its crop box kept to its media box and its rotation. */
function frameOf(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const left = Math.max(media.x, crop.x);
  const bottom = Math.max(media.y, crop.y);
  const width = Math.min(media.x + media.width, crop.x + crop.width) - left;
  const height = Math.min(media.y + media.height, crop.y + crop.height) - bottom;
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const sideways = rotation === 90 || rotation === 270;
  return {
    left, bottom, width, height, rotation,
    shownWidth: sideways ? height : width,
    shownHeight: sideways ? width : height,
    /** The page's own coordinates of the shown point (x, y). */
    toPage(x, y) {
      switch (rotation) {
        case 90: return [left + width - y, bottom + x];
        case 180: return [left + width - x, bottom + height - y];
        case 270: return [left + y, bottom + height - x];
        default: return [left + x, bottom + y];
      }
    },
  };
}

/** The mark's parts on each page of `bytes`, as the app's PageMark writes them. */
async function markParts(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  return doc.getPages().map((page) => {
    const list = ctx.lookup(page.node.get(N('Contents')));
    const streams = list instanceof PDFArray ? list.asArray() : [page.node.get(N('Contents'))];
    const first = ctx.lookup(streams[0]);
    const last = ctx.lookup(streams[streams.length - 1]);
    const marker = last instanceof PDFStream ? ctx.lookup(last.dict.get(N('UsugamiMark'))) : null;
    const name = marker instanceof PDFDict ? ctx.lookup(marker.get(N('Name'))) : null;
    const resources = ctx.lookup(page.node.getInheritableAttribute?.(N('Resources')) ?? page.node.get(N('Resources')));
    const xObjects = resources instanceof PDFDict ? ctx.lookup(resources.get(N('XObject'))) : null;
    const formRef = name && xObjects instanceof PDFDict ? xObjects.get(name) : null;
    const form = formRef ? ctx.lookup(formRef) : null;
    const formResources = form ? ctx.lookup(form.dict.get(N('Resources'))) : null;
    const font = formResources ? ctx.lookup(ctx.lookup(formResources.get(N('Font'))).get(N('F'))) : null;
    const gs = formResources ? ctx.lookup(ctx.lookup(formResources.get(N('ExtGState'))).get(N('GS'))) : null;
    const num = (v) => ctx.lookup(v)?.asNumber?.();
    return {
      page,
      frame: frameOf(page),
      count: streams.length,
      first: first ? Buffer.from(decodePDFRawStream(first).decode()).toString('latin1') : null,
      firstMarker: first instanceof PDFStream ? ctx.lookup(first.dict.get(N('UsugamiMark'))) === PDFBool.True : false,
      last: last ? Buffer.from(decodePDFRawStream(last).decode()).toString('latin1') : null,
      size: marker ? num(marker.get(N('Size'))) : null,
      opacity: marker ? num(marker.get(N('Opacity'))) : null,
      matrix: marker ? ctx.lookup(marker.get(N('Matrix'))).asArray().map(num) : null,
      name: name ? name.decodeText() : null,
      was: marker ? marker.get(N('Was')) !== undefined : null,
      madeXObjects: marker ? ctx.lookup(marker.get(N('MadeXObjects'))) === PDFBool.True : null,
      madeResources: marker ? ctx.lookup(marker.get(N('MadeResources'))) === PDFBool.True : null,
      formTag: formRef ? String(formRef) : null,
      form: form ? {
        marker: ctx.lookup(form.dict.get(N('UsugamiMark'))) === PDFBool.True,
        subtype: ctx.lookup(form.dict.get(N('Subtype')))?.decodeText(),
        bbox: ctx.lookup(form.dict.get(N('BBox'))).asArray().map(num),
        content: Buffer.from(decodePDFRawStream(form).decode()).toString('latin1'),
      } : null,
      font: font ? {
        base: ctx.lookup(font.get(N('BaseFont'))).decodeText(),
        subtype: ctx.lookup(font.get(N('Subtype'))).decodeText(),
        encoding: ctx.lookup(font.get(N('Encoding'))).decodeText(),
        embedded: font.has(N('FontDescriptor')),
      } : null,
      alpha: gs ? num(gs.get(N('ca'))) : null,
    };
  });
}

/** Checks each page of `bytes` carries `style` once, in its corner as shown, as the app writes it. */
async function checkMarked(bytes, style, label) {
  const parts = await markParts(bytes);
  const forms = new Set(parts.map((p) => p.formTag));
  eq(forms.size, 1, `${label}: one form for the whole PDF`);
  for (const [i, p] of parts.entries()) {
    const at = `${label} page ${i + 1}`;
    assert(p.firstMarker && p.first === 'q\n', `${at}: the state is saved first (${JSON.stringify(p.first)})`);
    assert(p.last.startsWith('Q\nq\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC\n'), `${at}: drawn last as a pagination artifact: ${p.last}`);
    assert(p.last.endsWith(` cm\n/${p.name} Do\nEMC\nQ\n`), `${at}: draws its form: ${p.last}`);
    eq([p.size, p.opacity], [style.size, style.opacity], `${at}: the style it says`);
    assert(p.name === 'UsugamiMark', `${at}: the form's name`);
    assert(p.form.marker && p.form.subtype === 'Form', `${at}: the form is marked`);
    eq(p.form.bbox, [0, -0.3, 4.323, 0.8], `${at}: the form's box`);
    eq(p.form.content, '/GS gs\n0.2 g\nBT\n/F 1 Tf\n(Usugami) Tj\nET\n', `${at}: the form draws the word`);
    eq(p.font, { base: 'Helvetica-Bold', subtype: 'Type1', encoding: 'WinAnsiEncoding', embedded: false }, `${at}: a standard font, nothing embedded`);
    near(p.alpha, style.opacity / 100, 0.0001, `${at}: its opacity`);
    // Where the word goes on the page as shown: its baseline's start, its size, upright.
    const place = MarkLayout.place(style, p.frame.shownWidth, p.frame.shownHeight);
    const [x, y] = p.frame.toPage(place.x, place.y);
    const [rx, ry] = p.frame.toPage(place.x + place.fontSize, place.y);
    const [ux, uy] = p.frame.toPage(place.x, place.y + place.fontSize);
    const m = p.matrix;
    near(m[4], x, 0.01, `${at}: x`);
    near(m[5], y, 0.01, `${at}: y`);
    near(m[0] + m[4], rx, 0.01, `${at}: runs right as shown (x)`);
    near(m[1] + m[5], ry, 0.01, `${at}: runs right as shown (y)`);
    near(m[2] + m[4], ux, 0.01, `${at}: stands up as shown (x)`);
    near(m[3] + m[5], uy, 0.01, `${at}: stands up as shown (y)`);
    // The matrix the content draws with is the one the marker keeps.
    const drawn = p.last.split('\n').find((l) => l.endsWith(' cm')).split(' ').slice(0, 6).map(Number);
    eq(drawn, m, `${at}: drawn where its marker says`);
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// The engine, in Node

const base = await pagesPdf();
const more = await morePdf();

await test('engine: marks each page as shown, changes it and takes it off again', async () => {
  const before = await pagesOf(base);
  const style = new MarkStyle();
  const marked = await markPdf(base, style);
  assert(marked && mayCarryMark(marked) && !mayCarryMark(base), 'marked');
  const parts = await checkMarked(marked, style, 'default');
  eq(parts.map((p) => [p.was, p.madeXObjects, p.madeResources]), [[true, true, false], [true, false, false], [false, true, true]], 'what the marker keeps (the second page finds the XObjects the first, sharing its resources, made)');
  // Asked again, it is already there: nothing changes.
  eq(await markPdf(marked, { size: 20, opacity: 30 }), null, 'the same mark again');
  assert(carriesMark(await PDFDocument.load(marked), style), 'carries it');

  // At its largest, the word starts on the middle of each page as shown; once, fully opaque.
  const largest = new MarkStyle({ size: 100, opacity: 100 });
  const big = await markPdf(marked, largest);
  const bigParts = await checkMarked(big, largest, 'largest');
  for (const p of bigParts) near(MarkLayout.place(largest, p.frame.shownWidth, p.frame.shownHeight).x, p.frame.shownWidth / 2, 0.01, 'mid-page');
  assert(!carriesMark(await PDFDocument.load(big), style), 'no longer the default');

  // Taken off, each page is as it was: the same content and resources.
  const off = await markPdf(big, null);
  assert(off && !mayCarryMark(off), 'nothing of it is left');
  const after = await pagesOf(off);
  eq(after, before, 'each page as it was');
  assert(!after[2].hasResources, 'the blank page has no resources again');
  eq(await markPdf(off, null), null, 'nothing to take off');
  const doc = await PDFDocument.load(off);
  assert(!hasMark(doc) && carriesMark(doc, null), 'no mark');
});

await test('engine: upside down, turned left, cropped, and resources from the page tree', async () => {
  const before = await pagesOf(more);
  const style = new MarkStyle({ size: 45, opacity: 60 });
  const marked = await markPdf(more, style);
  const parts = await checkMarked(marked, style, 'more');
  // The two pages sharing the tree's resources share one name for the form.
  eq(parts.map((p) => p.name), ['UsugamiMark', 'UsugamiMark', 'UsugamiMark', 'UsugamiMark'], 'names');
  eq(await pagesOf(await markPdf(marked, null)), before, 'as it was');
  // In the same PDF with object streams too.
  const packed = await pagesPdf({ objectStreams: true });
  const packedMarked = await markPdf(packed, style);
  await checkMarked(packedMarked, style, 'object streams');
  eq(await pagesOf(await markPdf(packedMarked, null)), await pagesOf(packed), 'object streams: as it was');
});

await test('engine: a page turned or cropped since it was marked gets it in its corner again', async () => {
  const style = new MarkStyle();
  const marked = await markPdf(base, style);
  for (const change of ['turn', 'crop']) {
    const doc = await PDFDocument.load(marked);
    if (change === 'turn') doc.getPage(0).setRotation(degrees(90));
    else doc.getPage(0).setCropBox(100, 100, 300, 300);
    const changed = await doc.save();
    assert(!carriesMark(await PDFDocument.load(changed), style), `${change}: no longer where it goes`);
    const again = await markPdf(changed, style);
    assert(again, `${change}: marked again`);
    await checkMarked(again, style, change);
  }
});

await test('engine: a name taken by another XObject, and a mark made by the Android app', async () => {
  // A page whose resources already have an XObject called UsugamiMark that isn't Usugami's.
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const theirs = ctx.register(ctx.stream('0 0 1 1 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }));
  const page = doc.addPage([300, 300]);
  page.node.set(N('Resources'), ctx.obj({ XObject: { UsugamiMark: theirs } }));
  page.node.set(N('Contents'), ctx.register(ctx.stream('/UsugamiMark Do')));
  const bytes = await doc.save({ useObjectStreams: false });
  const marked = await markPdf(bytes, new MarkStyle());
  const parts = await markParts(marked);
  eq(parts[0].name, 'UsugamiMark1', 'a name of its own');
  const off = await pagesOf(await markPdf(marked, null));
  eq(off, await pagesOf(bytes), 'theirs left in place');

  // As PDFBox writes it on Android: a direct array of what was there, floats as COSFloat writes them.
  const android = await PDFDocument.load(base);
  const actx = android.context;
  const style = new MarkStyle({ size: 30, opacity: 50 });
  const form = actx.register(actx.stream('/GS gs\n0.2 g\nBT\n/F 1 Tf\n(Usugami) Tj\nET\n', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, -0.3, 4.323, 0.8], UsugamiMark: true,
    Resources: { Font: { F: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold', Encoding: 'WinAnsiEncoding' } }, ExtGState: { GS: { Type: 'ExtGState', ca: 0.5 } } },
  }));
  const before = actx.register(actx.stream('q\n', { UsugamiMark: true }));
  for (const p of android.getPages()) {
    const was = p.node.get(N('Contents'));
    let resources = actx.lookup(p.node.get(N('Resources')));
    const madeResources = !resources;
    if (!resources) { resources = actx.obj({}); p.node.set(N('Resources'), resources); }
    let x = actx.lookup(resources.get(N('XObject')));
    const madeX = !x;
    if (!x) { x = actx.obj({}); resources.set(N('XObject'), x); }
    x.set(N('UsugamiMark'), form);
    const f = frameOf(p);
    const place = MarkLayout.place(style, f.shownWidth, f.shownHeight);
    const [ex, ey] = f.toPage(place.x, place.y);
    const [rx, ry] = f.toPage(place.x + place.fontSize, place.y);
    const [ux, uy] = f.toPage(place.x, place.y + place.fontSize);
    const m = [rx - ex, ry - ey, ux - ex, uy - ey, ex, ey].map((v) => Number(v.toFixed(4)));
    const marker = actx.obj({ Size: style.size, Opacity: style.opacity, Matrix: m, Name: N('UsugamiMark') });
    if (was) marker.set(N('Was'), was);
    if (madeX) marker.set(N('MadeXObjects'), PDFBool.True);
    if (madeResources) marker.set(N('MadeResources'), PDFBool.True);
    const after = actx.register(actx.stream(`Q\nq\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC\n${m.join(' ')} cm\n/UsugamiMark Do\nEMC\nQ\n`, { UsugamiMark: marker }));
    const own = was ? [was] : [];
    p.node.set(N('Contents'), actx.obj([before, ...own, after]));
  }
  const fromAndroid = await android.save({ useObjectStreams: false });
  const androidDoc = await PDFDocument.load(fromAndroid);
  assert(carriesMark(androidDoc, style), 'the web reads the Android app\'s mark as its own');
  eq(await markPdf(fromAndroid, style), null, 'already as asked');
  eq(await pagesOf(await markPdf(fromAndroid, null)), await pagesOf(base), 'the Android app\'s mark taken off, the pages as they were');
  assert(unmark(androidDoc) && !hasMark(androidDoc), 'unmark() in memory');
});

await test('engine: tools read a marked PDF without the mark (loadPdf); passwords', async () => {
  const marked = await markPdf(base, new MarkStyle({ size: 100 }));
  const doc = await loadPdf(marked);
  assert(wasUnmarked(doc) && !hasMark(doc), 'loaded without it');
  eq(await pagesOf(await doc.save({ useObjectStreams: false })), await pagesOf(base), 'the pages as they were');
  const kept = await loadPdf(marked, { unmark: false });
  assert(!wasUnmarked(kept) && hasMark(kept), 'unmark: false keeps it');
  const plain = await loadPdf(base);
  assert(!wasUnmarked(plain) && !wasEncrypted(plain), 'a PDF without it');
  // The previews' copy without it.
  const view = await unmarkPdf(marked);
  assert(view && !mayCarryMark(view), 'unmarkPdf');
  eq(await unmarkPdf(base), null, 'nothing to take off');

  // A PDF with a password, or only restricted by an owner password, can't be changed.
  for (const userPassword of ['secret', '']) {
    const locked = await PDFDocument.load(await markPdf(base, new MarkStyle()));
    locked.encrypt({ userPassword, ownerPassword: 'owner' });
    const lockedBytes = await locked.save();
    let err = null;
    try { await markPdf(lockedBytes, new MarkStyle({ size: 50 })); } catch (e) { err = e; }
    eq(err?.key, 'mark_failed', `can't be changed (user password ${JSON.stringify(userPassword)})`);
    // A tool opens it, decrypted, without the mark.
    const opened = await loadPdf(lockedBytes, userPassword ? { password: userPassword } : {});
    assert(wasEncrypted(opened) && wasUnmarked(opened) && !hasMark(opened), 'opened by a tool');
  }
});

await test('engine: quick enough on a long PDF', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  for (let i = 0; i < 600; i++) {
    const page = doc.addPage([A4W, A4H]);
    page.node.set(N('Resources'), ctx.obj({ Font: { F1: font } }));
    page.node.set(N('Contents'), ctx.register(ctx.flateStream(`BT /F1 12 Tf 72 700 Td (Page ${i + 1}) Tj ET`)));
  }
  const long = await doc.save();
  let started = performance.now();
  const marked = await markPdf(long, new MarkStyle());
  const markMs = performance.now() - started;
  started = performance.now();
  const off = await markPdf(marked, null);
  const offMs = performance.now() - started;
  console.log(`  600 pages: marked in ${markMs.toFixed(0)} ms, taken off in ${offMs.toFixed(0)} ms`);
  assert(markMs < 15000 && offMs < 15000, 'not held up');
  eq((await PDFDocument.load(off)).getPageCount(), 600, 'every page');
});

await test('strings: the app\'s English', () => {
  eq(markStrings.mark_title, 'Usugami watermark', 'title');
  eq(markStrings.mark_detail, 'Adds a small "Usugami" in the corner of each page, to support the app.', 'detail');
  eq(markStrings.mark_adding, 'Adding the Usugami watermark…', 'adding');
  eq(markStrings.mark_working, 'Updating the watermark…', 'working');
  eq(markStrings.mark_failed, "Couldn't change the Usugami watermark. Check that there is enough free storage.", 'failed');
  eq(Object.keys(markStrings).sort(), ['mark_adding', 'mark_adjust', 'mark_detail', 'mark_failed', 'mark_opacity', 'mark_percent', 'mark_preview_description', 'mark_size', 'mark_title', 'mark_working'], 'every mark_ string');
});

// ---------------------------------------------------------------------------------------------
// In the browser: pdf.js reads the marks back

const HELPERS = `(() => {
  const root = new URL('./', location.href);
  const mod = (p) => import(new URL(p, root).href);
  const toBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  window.__mk = {
    toBytes, toB64, mod,
    async mark(data, style) {
      const m = await mod('js/engine/page-mark.js');
      const out = await m.markPdf(toBytes(data), style);
      return out ? toB64(out) : null;
    },
    /** Each page: its size as shown, its text, and where each "Usugami" starts, as shown (y up). */
    async read(data) {
      const { openPdfJs, pdfjsLib } = await mod('js/lib/pdfjs.js');
      const doc = await openPdfJs(toBytes(data));
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const marks = tc.items.filter((it) => it.str === 'Usugami').map((it) => {
          const m = pdfjsLib.Util.transform(vp.transform, it.transform);
          return { x: m[4], y: vp.height - m[5], a: m[0], b: m[1], c: m[2], d: m[3], width: it.width };
        });
        pages.push({ width: vp.width, height: vp.height, text: tc.items.map((it) => it.str).join(' '), marks });
      }
      doc.loadingTask.destroy();
      return pages;
    },
    /** Where pixels changed on each page from before to after, drawn at scale, and the darkest one. */
    async changes(beforeData, afterData, scale) {
      const { openPdfJs } = await mod('js/lib/pdfjs.js');
      const draw = async (doc, i) => {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await page.render({ canvas: c, viewport: vp, background: '#ffffff' }).promise;
        return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
      };
      const a = await openPdfJs(toBytes(beforeData));
      const b = await openPdfJs(toBytes(afterData));
      const out = [];
      for (let i = 1; i <= a.numPages; i++) {
        const x = await draw(a, i); const y = await draw(b, i);
        let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, n = 0, darkest = 255;
        for (let p = 0; p < x.data.length; p += 4) {
          const d = Math.max(Math.abs(x.data[p] - y.data[p]), Math.abs(x.data[p + 1] - y.data[p + 1]), Math.abs(x.data[p + 2] - y.data[p + 2]));
          if (d <= 8) continue;
          const k = p / 4, px = k % y.width, py = Math.floor(k / y.width);
          n++; minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
          darkest = Math.min(darkest, y.data[p], y.data[p + 1], y.data[p + 2]);
        }
        out.push({ width: y.width, height: y.height, n, minX, minY, maxX, maxY, darkest });
      }
      a.loadingTask.destroy(); b.loadingTask.destroy();
      return out;
    },
  };
})()`;

async function browserEngineTests(browser) {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/');
    await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
    await page.evaluate(HELPERS);
    const style = { size: 20, opacity: 30 };
    const marked = await page.evaluate(([d, s]) => window.__mk.mark(d, s), [b64(base), style]);
    const pages = await page.evaluate((d) => window.__mk.read(d), marked);
    eq(pages.map((p) => p.marks.length), [1, 1, 1], `${browser}: "Usugami" once on each page`);
    for (const [i, p] of pages.entries()) {
      const place = MarkLayout.place(new MarkStyle(style), p.width, p.height);
      const [m] = p.marks;
      near(m.x, place.x, 0.5, `${browser} page ${i + 1}: where the word starts`);
      near(m.y, place.y, 0.5, `${browser} page ${i + 1}: its baseline`);
      // Upright as shown: it runs to the right and its letters stand up (y down on screen).
      near(m.a, place.fontSize, 0.05, `${browser} page ${i + 1}: runs right`);
      near(m.b, 0, 0.05, `${browser} page ${i + 1}: level`);
      near(m.d, -place.fontSize, 0.05, `${browser} page ${i + 1}: stands up`);
      assert(m.x + m.width < p.width, `${browser} page ${i + 1}: ends before the right edge`);
    }
    assert(pages[0].text.includes('PAGE ONE') && pages[1].text.includes('PAGE TWO'), `${browser}: the pages' own text is there`);
    // Small and light grey unless changed, in the bottom-right corner as shown.
    const changed = await page.evaluate(([a, b]) => window.__mk.changes(a, b, 2), [b64(base), marked]);
    for (const [i, c] of changed.entries()) {
      assert(c.n > 30, `${browser} page ${i + 1}: drawn (${c.n} pixels)`);
      assert(c.minX > c.width * 0.75 && c.minY > c.height * 0.9, `${browser} page ${i + 1}: in the bottom-right corner ${JSON.stringify(c)}`);
      assert(c.darkest >= 180, `${browser} page ${i + 1}: light grey (darkest ${c.darkest})`);
    }
    const solid = await page.evaluate(([d, s]) => window.__mk.mark(d, s), [marked, { size: 100, opacity: 100 }]);
    const solidChanges = await page.evaluate(([a, b]) => window.__mk.changes(a, b, 1), [b64(base), solid]);
    assert(solidChanges.every((c) => c.darkest <= 70 && c.minX >= c.width * 0.45), `${browser}: solid at its largest, from mid-page ${JSON.stringify(solidChanges)}`);
    const off = await page.evaluate(([d]) => window.__mk.mark(d, null), [solid]);
    const offPages = await page.evaluate((d) => window.__mk.read(d), off);
    eq(offPages.map((p) => p.marks.length), [0, 0, 0], `${browser}: none once taken off`);
    assert(!offPages.some((p) => p.text.includes('Usugami')), `${browser}: no trace in the text`);
    const same = await page.evaluate(([a, b]) => window.__mk.changes(a, b, 1), [b64(base), off]);
    eq(same.map((c) => c.n), [0, 0, 0], `${browser}: the pages look as they did`);
    // Rotated and cropped pages of the second PDF too.
    const more2 = await page.evaluate(([d, s]) => window.__mk.mark(d, s), [b64(more), style]);
    const morePages = await page.evaluate((d) => window.__mk.read(d), more2);
    for (const [i, p] of morePages.entries()) {
      const place = MarkLayout.place(new MarkStyle(style), p.width, p.height);
      eq(p.marks.length, 1, `${browser} turned page ${i + 1}: once`);
      near(p.marks[0].x, place.x, 0.5, `${browser} turned page ${i + 1}: x`);
      near(p.marks[0].y, place.y, 0.5, `${browser} turned page ${i + 1}: y`);
      near(p.marks[0].b, 0, 0.05, `${browser} turned page ${i + 1}: upright`);
    }
  }, { browser });
}

for (const browser of quick ? ['chromium'] : ['chromium', 'firefox', 'webkit']) {
  await test(`browser engine (${browser}): read back with pdf.js`, () => browserEngineTests(browser));
}

// ---------------------------------------------------------------------------------------------
// The result screen

const TEST_PAGE = `<!doctype html>
<html lang="en" dir="ltr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mark test</title>
<link rel="stylesheet" href="../assets/css/tokens.css">
<link rel="stylesheet" href="css/app.css">
<link rel="stylesheet" href="css/components.css">
</head><body><div id="root" class="page"></div>
<script type="module">
  const { initI18n, loadStrings } = await import('./js/core/i18n.js');
  await initI18n();
  await loadStrings('kit', 'mark');
  window.output = await import('./js/core/output.js');
  window.settings = await import('./js/core/settings.js');
  window.marks = await import('./js/engine/mark-layout.js');
  window.fx = {};
  window.log = [];
  window.bytesOf = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  window.b64Of = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  window.snacks = () => [...document.querySelectorAll('.ui-snackbar .ui-snackbar-text')].map((n) => n.textContent);
  // Share: what was given, kept for the test.
  window.shared = [];
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }) => { for (const f of files) window.shared.push({ name: f.name, b64: b64Of(new Uint8Array(await f.arrayBuffer())) }); } });
  window.show = (names) => {
    const files = names.map((n) => ({ name: n + '.pdf', bytes: fx[n], type: 'application/pdf', pageCount: 3 }));
    window.made = files;
    window.result = output.showResult(document.getElementById('root'), {
      files, zipName: 'Marked', onBack: () => log.push('back'), onStartOver: () => log.push('start over'),
      onReady: (shown) => log.push('ready:' + shown.map((f) => f.bytes.length).join(',')),
    });
  };
  window.state = () => {
    const card = document.querySelector('.ui-mark');
    const sw = card?.querySelector('[role="switch"]');
    return {
      card: !!card, on: sw?.getAttribute('aria-checked') === 'true', open: card?.classList.contains('is-open'),
      expanded: card?.querySelector('.ui-mark-arrow')?.getAttribute('aria-expanded'),
      working: !!card?.querySelector('.ui-mark-working .ui-progress'),
      openDisabled: document.querySelector('.ui-result-actions .ui-btn')?.disabled,
      saved: result.isSaved(),
      unsavedShown: !document.querySelector('.ui-result-unsaved').hidden,
      carries: result.files.map((f) => marks.mayCarryMark(f.bytes)),
      same: result.files.map((f, i) => f.bytes === made[i].bytes),
    };
  };
  window.ready = true;
</script></body></html>`;

async function openTestPage(page, url) {
  await page.route('**/app/mark-test.html', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: TEST_PAGE }));
  await page.goto(url + 'app/mark-test.html');
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
}

const until = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout });
const state = (page) => page.evaluate(() => window.state());
/** The marks pdf.js finds in `data`, page by page. */
async function marksIn(page, data) {
  await page.evaluate(HELPERS);
  const pages = await page.evaluate((d) => window.__mk.read(d), data);
  return pages.map((p) => p.marks.length);
}

async function resultScreenTests(browser, label, viewport) {
  await withPage(async (page, url) => {
    const tag = `${browser} ${label}`;
    await openTestPage(page, url);
    await page.evaluate(([a, b]) => { fx.a = bytesOf(a); fx.b = bytesOf(b); }, [b64(base), b64(more)]);

    // Off unless turned on: nothing is added, and the files are the files as made.
    await page.evaluate(() => show(['a']));
    await until(page, () => log.some((l) => l.startsWith('ready:')));
    let s = await state(page);
    assert(s.card && !s.on && !s.open && s.expanded === 'false', `${tag}: the switch, off, closed ${JSON.stringify(s)}`);
    eq([s.carries, s.same], [[false], [true]], `${tag}: nothing added while off`);
    // At the top of the result screen, above the PDF and Open, Share and Save.
    const order = await page.evaluate(() => {
      const y = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      return [y('.ui-result-heading'), y('.ui-mark'), y('.ui-result-files'), y('.ui-result-actions')];
    });
    assert(order.every((v, i) => i === 0 || v > order[i - 1]), `${tag}: heading, switch, files, buttons ${order}`);
    eq(await page.evaluate(() => [document.querySelector('.ui-mark .ui-switch-label').textContent, document.querySelector('.ui-mark .ui-switch-detail').textContent,
      document.querySelector('.ui-mark-arrow').getAttribute('aria-label')]), [markStrings.mark_title, markStrings.mark_detail, markStrings.mark_adjust], `${tag}: its words`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: no sideways scrolling`);

    // The arrow opens Size and Opacity, with the first page showing the mark; it doesn't flip the switch.
    await page.click('.ui-mark-arrow');
    s = await state(page);
    assert(s.open && s.expanded === 'true' && !s.on, `${tag}: opened, still off`);
    await until(page, () => document.querySelector('.ui-mark-page').getBoundingClientRect().height > 0);
    const panel = await page.evaluate(() => {
      const card = document.querySelector('.ui-mark');
      const sliders = [...card.querySelectorAll('.ui-slider')].map((el) => ({
        label: el.querySelector('label').textContent, value: el.querySelector('.ui-slider-value').textContent,
        min: el.querySelector('input').min, max: el.querySelector('input').max, disabled: el.querySelector('input').disabled,
      }));
      const box = card.querySelector('.ui-mark-page');
      const r = box.getBoundingClientRect();
      const sl = card.querySelector('.ui-mark-sliders').getBoundingClientRect();
      return { sliders, label: box.getAttribute('aria-label'), w: r.width, h: r.height, beside: sl.left > r.right - 1, below: sl.top >= r.bottom - 1 };
    });
    eq(panel.sliders, [
      { label: 'Size', value: '20%', min: '0', max: '100', disabled: true },
      { label: 'Opacity', value: '30%', min: '10', max: '100', disabled: true },
    ], `${tag}: the sliders, off while the mark is`);
    eq(panel.label, 'Page 1', `${tag}: the page without the mark said as such`);
    // A4 fits 150 × 200 by its height, as the app's preview.
    near(panel.h, 200, 1, `${tag}: the preview's height`);
    near(panel.w, 200 * A4W / A4H, 1, `${tag}: the page's shape`);
    // Beside each other where there is room, otherwise the page above the sliders.
    assert(viewport.width >= 840 ? panel.beside : panel.below, `${tag}: the panel's layout ${JSON.stringify(panel)}`);

    // Turned on: the PDF gets the mark, Open and the others wait meanwhile; the result isn't saved.
    await page.click('.ui-mark .ui-switch-text');
    s = await state(page);
    assert(s.on && s.working && s.openDisabled, `${tag}: on, the PDF changing ${JSON.stringify(s)}`);
    await until(page, () => !window.state().working && window.state().carries[0]);
    s = await state(page);
    assert(s.on && !s.openDisabled && s.carries[0] && !s.same[0], `${tag}: marked ${JSON.stringify(s)}`);
    eq(await page.evaluate(() => settings.getSetting('mark.on')), true, `${tag}: the switch remembered`);
    eq(await page.evaluate(() => document.querySelector('.ui-mark-page').getAttribute('aria-label')), markStrings.mark_preview_description, `${tag}: the preview says it has the mark`);
    eq(await marksIn(page, await page.evaluate(() => b64Of(result.files[0].bytes))), [1, 1, 1], `${tag}: on every page`);
    if (viewport.width >= 840) await saveOutput(`mark-result-${browser}-${label}.png`, await page.screenshot({ fullPage: true }));

    // Saved and shared with the mark.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.ui-result-actions >> text=Save to Downloads')]);
    const saved = await readFile(await dl.path());
    assert(mayCarryMark(saved), `${tag}: the PDF saved has the mark`);
    await until(page, () => window.state().saved);
    // Recent files keep what was saved.
    const recent = await page.evaluate(async () => {
      const r = await import(new URL('js/core/recent.js', location.href).href);
      const [last] = await r.listRecent();
      return last ? b64Of(await r.getRecentBytes(last.id)) : null;
    });
    assert(recent && sameBytes(Buffer.from(recent, 'base64'), saved), `${tag}: Recent files has the PDF saved, with the mark`);
    await page.click('.ui-result-actions >> text=Share');
    await until(page, () => window.shared.length === 1);
    const sharedBytes = Buffer.from(await page.evaluate(() => window.shared[0].b64), 'base64');
    assert(sameBytes(sharedBytes, saved), `${tag}: the PDF shared is the one saved`);

    // The size slider: the preview follows as it moves, the PDF changes once it is let go.
    const previewBefore = await page.evaluate(() => document.querySelector('.ui-mark-canvas').toDataURL());
    await page.focus('.ui-mark .ui-slider:nth-child(1) input');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    eq(await page.evaluate(() => document.querySelector('.ui-mark .ui-slider-value').textContent), '25%', `${tag}: size shown`);
    assert((await page.evaluate(() => document.querySelector('.ui-mark-canvas').toDataURL())) !== previewBefore, `${tag}: the preview follows`);
    await until(page, () => window.settings.getSetting('mark.size') === 25);
    await until(page, () => !window.state().working && !window.state().saved);
    s = await state(page);
    assert(!s.saved && s.unsavedShown, `${tag}: a copy saved before stays as it was: save again ${JSON.stringify(s)}`);
    let parts = await markParts(Buffer.from(await page.evaluate(() => b64Of(result.files[0].bytes)), 'base64'));
    eq(parts.map((p) => p.size), [25, 25, 25], `${tag}: the new size`);
    // Opacity, faint to solid.
    await page.focus('.ui-mark .ui-slider:nth-child(2) input');
    await page.keyboard.press('End');
    await until(page, () => window.settings.getSetting('mark.opacity') === 100);
    await until(page, () => !window.state().working);
    parts = await markParts(Buffer.from(await page.evaluate(() => b64Of(result.files[0].bytes)), 'base64'));
    eq(parts.map((p) => [p.size, p.opacity]), [[25, 100], [25, 100], [25, 100]], `${tag}: solid`);

    // Off again: the same PDF as made, byte for byte, without making it again.
    await page.click('.ui-mark [role="switch"]');
    await until(page, () => !window.state().working && window.state().same[0]);
    s = await state(page);
    assert(!s.on && !s.carries[0] && s.same[0], `${tag}: the PDF as made ${JSON.stringify(s)}`);
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.ui-result-actions >> text=Save to Downloads')]);
    assert(sameBytes(await readFile(await dl2.path()), base), `${tag}: saved as made`);
    // Size and opacity are kept while it is off.
    eq(await page.evaluate(() => [...document.querySelectorAll('.ui-mark .ui-slider-value')].map((e) => e.textContent)), ['25%', '100%'], `${tag}: kept while off`);

    // Remembered after a reload: every PDF made afterwards gets the mark, several one after another.
    await page.evaluate(() => settings.setSetting('mark.on', true));
    await page.reload();
    await page.waitForFunction(() => window.ready === true);
    await page.evaluate(([a, b]) => { fx.a = bytesOf(a); fx.b = bytesOf(b); }, [b64(base), b64(more)]);
    await page.evaluate(() => show(['a', 'b']));
    await until(page, () => log.some((l) => l.startsWith('ready:')));
    s = await state(page);
    assert(s.on && s.carries.every(Boolean) && !s.saved, `${tag}: remembered, both marked at once ${JSON.stringify(s)}`);
    eq(await page.evaluate(() => [...document.querySelectorAll('.ui-mark .ui-slider-value')].map((e) => e.textContent)), ['25%', '100%'], `${tag}: sliders remembered`);
    eq(await marksIn(page, await page.evaluate(() => b64Of(result.files[1].bytes))), [1, 1, 1, 1], `${tag}: every page of the second`);
    // The ZIP file holds the PDFs as they show.
    await page.click('.ui-result-actions >> text=Share or save as ZIP');
    const [zip] = await Promise.all([page.waitForEvent('download'), page.click('.ui-menu >> text=Save ZIP to Downloads')]);
    const zipBytes = await readFile(await zip.path());
    eq(zipBytes.indexOf(Buffer.from('/UsugamiMark')) > 0, true, `${tag}: the ZIP file's PDFs have it`);
    await until(page, () => window.state().saved);
    // Off: both as made.
    await page.click('.ui-mark [role="switch"]');
    await until(page, () => !window.state().working && window.state().same.every(Boolean));
    s = await state(page);
    assert(!s.saved && s.unsavedShown, `${tag}: not saved once changed`);
    await page.evaluate(() => result.destroy());
  }, { browser, viewport });
}

for (const browser of quick ? ['chromium'] : ['chromium', 'firefox', 'webkit']) {
  for (const [label, viewport] of [['phone', { width: 412, height: 915 }], ['desktop', { width: 1280, height: 800 }]]) {
    await test(`result screen (${browser}, ${label})`, () => resultScreenTests(browser, label, viewport));
  }
}

// Cancel while the PDFs just made get the mark goes back to editing, as cancelling the run; a PDF
// that can't be marked says so and stays as it is; a result shown again needs no work.
await test('result screen: cancelling, a failure, a result shown again (chromium)', async () => {
  await withPage(async (page, url) => {
    await openTestPage(page, url);
    // A long PDF.
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
    for (let i = 0; i < 1500; i++) {
      const p = doc.addPage([A4W, A4H]);
      p.node.set(N('Resources'), ctx.obj({ Font: { F1: font } }));
      p.node.set(N('Contents'), ctx.register(ctx.flateStream(`BT /F1 12 Tf 72 700 Td (Page ${i + 1}) Tj ET`)));
    }
    const long = await doc.save();
    await page.evaluate(([l, a]) => { fx.long = bytesOf(l); fx.a = bytesOf(a); settings.setSetting('mark.on', true); }, [b64(long), b64(base)]);
    // A slow phone: the dialog shows once the work has taken a while.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 60 });
    await page.evaluate(() => show(['long']));
    await page.waitForSelector('dialog[open] .ui-dialog-title', { state: 'attached', timeout: 15000 });
    eq(await page.textContent('dialog[open] .ui-dialog-title'), markStrings.mark_adding, 'Adding the Usugami watermark…');
    // Cancel while the PDF is being marked (the dialog shows once that has taken 400 ms).
    await page.evaluate(() => document.querySelector('dialog[open] .ui-btn').click());
    await until(page, () => log.includes('back'));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    assert(!(await page.evaluate(() => log.some((l) => l.startsWith('ready:')))), 'not ready: it isn\'t the result');
    await page.evaluate(() => result.destroy());

    // A PDF pdf-lib can't read: left as it is, and said.
    await page.evaluate(() => { fx.bad = new TextEncoder().encode('%PDF-1.7\nnot really a PDF'); log.length = 0; show(['bad']); });
    await until(page, () => log.some((l) => l.startsWith('ready:')));
    await until(page, () => snacks().includes("Couldn't change the Usugami watermark. Check that there is enough free storage."));
    eq((await state(page)).same, [true], 'left as it is');
    await page.evaluate(() => result.destroy());

    // Shown again (Back to editing, then the result again): no work, no dialog.
    await page.evaluate(() => { log.length = 0; show(['a']); });
    await until(page, () => log.some((l) => l.startsWith('ready:')));
    const first = await page.evaluate(() => { window.firstFiles = result.files; return b64Of(result.files[0].bytes); });
    const again = await page.evaluate(() => {
      result.destroy();
      log.length = 0;
      window.result = output.showResult(document.getElementById('root'), { files: made, onBack: () => log.push('back'), onReady: () => log.push('ready:again') });
      return [log.join(), result.files[0] === firstFiles[0], !!document.querySelector('dialog[open]'), window.state().working];
    });
    eq(again, ['', true, false, false], 'the same version at once, ready just after');
    await until(page, () => log.includes('ready:again'));
    eq(await page.evaluate(() => b64Of(result.files[0].bytes)), first, 'the same bytes');
    // A setting changed in another tab is followed too.
    await page.evaluate(() => {
      localStorage.setItem('usugami.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('usugami.settings')), 'mark.on': false }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'usugami.settings' }));
    });
    await until(page, () => !window.state().on && window.state().same[0] && !window.state().working);
  });
});

// ---------------------------------------------------------------------------------------------
// In the app: Rotate PDF with the mark on. Every page gets it, also those it only turns or leaves
// as they were; a PDF marked before isn't marked twice.

await test('Rotate PDF with the mark on (chromium)', async () => {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/');
    await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
    await page.evaluate(() => localStorage.setItem('usugami.settings', JSON.stringify({ language: 'en', 'mark.on': true, 'mark.size': 40 })));
    const input = await markPdf(base, new MarkStyle({ size: 90, opacity: 80 }));
    await page.goto(url + 'app/#/tool/rotate');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
    await page.waitForSelector('#app .screen[data-tool="rotate"]:not([aria-busy]) .ui-empty', { timeout: 20000 });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.ui-empty')]);
    await chooser.setFiles({ name: 'Marked.pdf', mimeType: 'application/pdf', buffer: Buffer.from(input) });
    await page.waitForSelector('.rotate-card', { timeout: 20000 });
    await page.click('.rotate-card:nth-of-type(1) .ui-icon-btn[aria-label="Rotate page 1 right"]');
    await page.click('.ui-bottombar .ui-btn');
    await page.waitForSelector('.ui-result .ui-mark', { timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('.ui-mark-working .ui-progress') && !document.querySelector('.ui-result-actions .ui-btn').disabled, null, { timeout: 30000 });
    eq(await page.getAttribute('.ui-mark [role="switch"]', 'aria-checked'), 'true', 'the switch is on');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.ui-result-actions >> text=Save to Downloads')]);
    const out = await readFile(await dl.path());
    const parts = await checkMarked(out, new MarkStyle({ size: 40 }), 'rotated');
    eq(parts.map((p) => p.frame.rotation), [90, 90, 0], 'page 1 turned, the others as they were');
    await page.evaluate(HELPERS);
    eq((await page.evaluate((d) => window.__mk.read(d), b64(out))).map((p) => p.marks.length), [1, 1, 1], 'once on each page, not twice');
  });
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll mark tests passed.');
