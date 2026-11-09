// Sign PDF (engine/sign.js and js/tools/sign/). Ports SignatureLayoutTest.kt, the signature cases
// of PdfEditingDeviceTest.kt, PageEditsDeviceTest.kt (a signature over form fields and comments)
// and EditorsMultiClickDeviceTest.kt (Clear and Done while a stroke is being drawn). Results are
// read back with pdf-lib (structure), pdf.js (images placed, text) and by rendering the pages and
// finding the ink's pixels. The screen is driven with a mouse and with touch, at phone and desktop
// sizes, light and dark, and screenshots go to tests/output/sign-*.png.
//
//   node tests/sign.test.mjs            everything
//   node tests/sign.test.mjs --quick    Chromium only, no screenshots
//   node tests/sign.test.mjs --other    Firefox and WebKit only
//   node tests/sign.test.mjs --back     only the result step and leaving while a password is asked for
import {
  PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFString, StandardFonts, rgb, degrees, decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { withPage, assert, saveOutput, fixture } from './harness.mjs';
import * as S from '../site/app/js/engine/sign.js';

const quick = process.argv.includes('--quick');
const A4 = [595.28, 841.89];
let checks = 0;

function check(condition, message) {
  assert(condition, message);
  checks++;
}

function near(actual, expected, tolerance, message) {
  check(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// -----------------------------------------------------------------------------------------------
// SignatureLayoutTest.kt (and Signature.kt's model), in Node: the layout needs no browser.

function layoutTests() {
  const a4 = [595, 842];
  const landscape = [842, 595];
  const area = (e, a, m) => {
    near(a.x, e.x, 0.01, `${m} x`);
    near(a.y, e.y, 0.01, `${m} y`);
    near(a.width, e.width, 0.01, `${m} width`);
    near(a.height, e.height, 0.01, `${m} height`);
  };
  const onPage = (p, [w, h], aspect) => {
    const a = S.pdfArea(p, w, h, aspect);
    const slack = 0.01;
    return a.x >= -slack && a.y >= -slack && a.x + a.width <= w + slack && a.y + a.height <= h + slack;
  };

  // inkBoundsCoverEveryStrokeAndThePen
  area({ x: 95, y: 145, width: 310, height: 120 }, S.inkBounds([[100, 200, 300, 150], [250, 260, 260, 240], [400, 180]], 10), 'Two strokes and a dot');
  area({ x: 495.5, y: 245.5, width: 9, height: 9 }, S.inkBounds([[500, 250]]), 'A dot is as big as the pen');
  // inkBoundsFollowTheSmoothedCurve
  area({ x: 0, y: 0, width: 200, height: 200 / 3 }, S.inkBounds([[0, 0, 100, 100, 200, 0]], 0), 'The bend peaks two thirds of the way down');
  area({ x: 10, y: 10, width: 30, height: 30 }, S.inkBounds([[10, 10, 20, 20, 30, 30, 40, 40]], 0), 'Points along a line give the line');
  // nothingDrawnHasNoBounds
  check(S.inkBounds([]) === null && S.inkBounds([[]]) === null, 'Nothing drawn has no bounds');

  // startsInTheLowerRight
  {
    const [w, h] = a4;
    const p = S.defaultPlacement(w, h, 3);
    const a = S.pdfArea(p, w, h, 3);
    near(a.width, 0.32 * 595, 0.01, 'Default width is a third of the shorter side');
    near(a.height, a.width / 3, 0.01, 'Default height');
    near(w - a.x - a.width, 0.08 * 595, 0.01, 'Right margin');
    near(a.y, 0.08 * 595, 0.01, 'Bottom margin');
    check(p.centerX > 0.5 && p.centerY > 0.5, 'Lower right');
  }
  // aTallSignatureStartsSmallerSoItIsNotHuge
  {
    const a = S.pdfArea(S.defaultPlacement(595, 842, 1), 595, 842, 1);
    near(a.height, 0.12 * 842, 0.01, 'A square signature is 12% of the page tall');
    near(a.width, a.height, 0.01, 'and as wide');
  }
  // landscapePagesUseTheShorterSide
  {
    const [w, h] = landscape;
    const a = S.pdfArea(S.defaultPlacement(w, h, 3), w, h, 3);
    near(a.width, 0.32 * 595, 0.01, 'Landscape width uses the shorter side');
    near(a.y, 0.08 * 595, 0.01, 'Landscape margin');
  }
  // widthGoesFromHalfAnInchToTheWholePage
  {
    const wide = S.widthRange(595, 842, 3);
    near(wide[0], 36 / 595, 0.0001, 'Half an inch at the smallest');
    near(wide[1], 1, 0.0001, 'The whole page at the largest');
    near(S.widthRange(595, 842, 0.5)[1], (842 * 0.5) / 595, 0.0001, 'A tall signature is limited by the height');
    const tiny = S.widthRange(30, 10, 1);
    near(tiny[0], tiny[1], 0.0001, 'A tiny page has one size');
  }
  // aNarrowSignatureNeedNotBeAsTallAsThePage
  {
    const aspect = 0.029;
    const r = S.widthRange(595, 842, aspect);
    near(r[1], (842 * aspect) / 595, 0.0001, 'A stroke down is as tall as the page at most');
    near((r[0] * 595) / aspect, 36, 0.01, 'and half an inch tall at least');
    const placed = S.defaultPlacement(595, 842, aspect);
    check(S.heightShare(placed.width, 595, 842, aspect) < 0.5, 'A stroke down starts less than half the page tall');
  }
  // clampKeepsTheSignatureOnThePage
  for (const pageSize of [a4, landscape, [300, 300], [100, 40]]) {
    for (const aspect of [0.3, 1, 4, 12]) {
      for (const wanted of [
        { centerX: 0.5, centerY: 0.5, width: 0.3 },
        { centerX: -1, centerY: 2, width: 0.4 },
        { centerX: 1.2, centerY: -0.3, width: 5 },
        { centerX: 0.99, centerY: 0.99, width: 0 },
      ]) {
        const p = S.clampPlacement(wanted, pageSize[0], pageSize[1], aspect);
        check(onPage(p, pageSize, aspect), `${JSON.stringify(wanted)} with aspect ${aspect} is on the ${pageSize} page as ${JSON.stringify(p)}`);
        const [lo, hi] = S.widthRange(pageSize[0], pageSize[1], aspect);
        check(p.width >= lo - 1e-9 && p.width <= hi + 1e-9, 'Width in range');
      }
      check(onPage(S.defaultPlacement(pageSize[0], pageSize[1], aspect), pageSize, aspect), 'Default placement is on the page');
    }
  }
  // clampLeavesAPlacementThatFitsAlone
  {
    const p = { centerX: 0.4, centerY: 0.7, width: 0.25 };
    check(JSON.stringify(S.clampPlacement(p, 595, 842, 3)) === JSON.stringify(p), 'A placement that fits is left alone');
  }
  // pdfAreaMeasuresFromTheBottom
  area({ x: 150 - 60, y: 600 - 30, width: 120, height: 60 }, S.pdfArea({ centerX: 0.25, centerY: 0.25, width: 0.2 }, 600, 800, 2), 'pdfArea from the bottom');
  // imageIsPrintSharpButLimited
  check(S.pixels(180, 72).join() === '750,300', '2.5 by 1 inch at 300 dpi');
  check(S.pixels(842, 280).join() === '2400,798', 'Kept to 2400 pixels');
  check(S.pixels(0.01, 0.01).join() === '1,1', 'At least one pixel');
  let threw = false;
  try { S.widthRange(0, 10, 1); } catch (e) { threw = e instanceof RangeError; }
  check(threw, 'Sizes must be positive');

  // Signature.kt's model
  const sig = new S.Signature([[10, 10, 20, 20]], 'blue');
  check(!sig.isEmpty && sig.pointCount === 2 && sig.ink === 'blue', 'A stroke of two points');
  const more = sig.plus([30, 30]);
  check(more.strokes.length === 2 && sig.strokes.length === 1, 'plus makes a new signature');
  check(more.withInk('black').ink === 'black' && more.ink === 'blue', 'withInk');
  check(more.cleared().isEmpty && more.cleared().ink === 'blue', 'cleared keeps the ink');
  check(new S.Signature([], 'red').ink === 'black', 'An unknown ink is black');
  check(S.Signature.from({ strokes: [[1, 2]], ink: 'blue' }).pointCount === 1 && S.Signature.from(null) === null, 'from');
  check(JSON.stringify(S.Signature.from(sig.toJSON())) === JSON.stringify(sig), 'toJSON and back');
  check(new S.Signature([[0, 0, 100, 0]]).aspect > 10 && new S.Signature().aspect === 1, 'aspect');
  check(S.inkColor('black') === '#000000' && S.inkColor('blue') === '#1a3c9c', 'The inks');
  const paths = S.signaturePathData([[0, 0, 10, 10, 20, 0], [5, 5]]);
  check(paths.line === 'M0 0Q10 10 15 5L20 0' && paths.dots.startsWith('M0.5 5a4.5'), `SVG paths: ${JSON.stringify(paths)}`);
  // PageFrame: shown sizes and the matrix to the page's own coordinates.
  const f90 = S.frameOf(0, 0, 595, 842, 90);
  check(f90.shownWidth === 842 && f90.shownHeight === 595 && f90.matrix.join() === '0,1,-1,0,595,0', 'A page turned a quarter');
  const f270 = S.frameOf(10, 20, 100, 200, 270);
  check(f270.matrix.join() === '0,-1,1,0,10,220', 'A page turned three quarters');
  check(S.pageArea([0, 1, -1, 0, 100, 0], 10, 20, 30, 40).join() === '40,10,80,40', 'pageArea');
}

// -----------------------------------------------------------------------------------------------
// Fixtures (pdf-lib in Node)

/** A wave above a line, and a dot, in pad units (PdfEditingDeviceTest's signature). */
function wave(ink = 'blue') {
  const first = [];
  for (let i = 0; i < 40; i++) first.push(120 + 9 * i, 250 - 80 * Math.sin(0.4 * i));
  return { strokes: [first, [150, 360, 500, 372, 820, 355], [860, 140]], ink };
}

/** Four pages: A4, A4 turned a quarter, A4 cropped, and landscape A4 turned three quarters. */
async function mixedPages({ background = false, caption = true } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boxes = [A4, A4, A4, [A4[1], A4[0]]];
  boxes.forEach(([w, h], i) => {
    const p = doc.addPage([w, h]);
    if (background) p.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(1, 0, 0) });
    if (caption) p.drawText(`CAPTION ${'ABCD'[i]}`, { x: w / 2 - 40, y: h / 2, size: 14, font });
    // A thin gray frame, so the pages aren't blank (and no black ink is mistaken for text).
    else p.drawRectangle({ x: 20, y: 20, width: w - 40, height: h - 40, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
    if (i === 1) p.setRotation(degrees(90));
    if (i === 2) p.setCropBox(100, 100, w - 200, h - 200);
    if (i === 3) p.setRotation(degrees(270));
  });
  return doc.save();
}

/** A form (PageEditsDeviceTest's formPdf): fields name, city and agree (ticked), a red square comment, a note with its popup and a link. */
async function formPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Application', { x: 60, y: 760, size: 18, font });
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.setText('Jane Doe');
  name.addToPage(page, { x: 70, y: 600, width: 260, height: 24, font });
  const city = form.createTextField('city');
  city.setText('Lyon');
  city.addToPage(page, { x: 70, y: 560, width: 260, height: 24, font });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 70, y: 300, width: 18, height: 18 });
  agree.check();
  const ctx = doc.context;
  const square = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [350, 400, 500, 500], C: [1, 0, 0], IC: [1, 0, 0], F: 4, Border: [0, 0, 2],
  }));
  const note = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [520, 700, 540, 720], Contents: PDFString.of('A note'), F: 4 });
  const noteRef = ctx.register(note);
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [540, 600, 590, 700], Parent: noteRef }));
  note.set(PDFName.of('Popup'), popup);
  const link = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [60, 100, 200, 120], Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of('https://example.org/') },
  }));
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
  annots.push(square);
  annots.push(noteRef);
  annots.push(popup);
  annots.push(link);
  return doc.save({ updateFieldAppearances: true });
}

/** The decoded content of each page of `bytes`. */
async function pageContents(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const c = p.node.Contents();
    const list = c instanceof PDFArray ? Array.from({ length: c.size() }, (_, i) => c.lookup(i)) : [c];
    return Buffer.concat(list.filter(Boolean).map((s) => Buffer.from(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()))).toString('latin1');
  });
}

// -----------------------------------------------------------------------------------------------
// In the page: the engine, pdf.js reading back, rendering and finding ink.

async function sign(page, url, bytes, options, { password, name = 'in.pdf', abort = false } = {}) {
  return page.evaluate(async ({ base, data, options, password, name, abort }) => {
    const { signPdf } = await import(base + 'app/js/engine/sign.js');
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const controller = new AbortController();
    if (abort) controller.abort();
    try {
      const out = await signPdf({ name, bytes, password }, options, { signal: controller.signal });
      let s = '';
      for (let i = 0; i < out.bytes.length; i += 0x8000) s += String.fromCharCode(...out.bytes.subarray(i, i + 0x8000));
      return { name: out.name, type: out.type, pageCount: out.pageCount, data: btoa(s) };
    } catch (e) {
      return { error: e.name, key: e.key, wrong: e.wrong };
    }
  }, { base: url, data: b64(bytes), options, password, name, abort });
}

/** Signs and returns the bytes, failing the test on an error. */
async function signed(page, url, bytes, options, extra) {
  const r = await sign(page, url, bytes, options, extra);
  check(!r.error, `signPdf failed: ${JSON.stringify(r)}`);
  return { ...r, bytes: fromB64(r.data) };
}

/**
 * Reads `bytes` back with pdf.js: for each page in `pages`, its size as shown, its text, the
 * matrices images are drawn with, and (with `scale`) the box and count of pixels of each `kinds`
 * ('blue', 'black', 'red', 'ink' = blue or black) when rendered on white.
 */
async function readBack(page, url, bytes, pages, { scale = 0, kinds = [], regions = [] } = {}) {
  return page.evaluate(async ({ base, data, pages, scale, kinds, regions }) => {
    const { openPdfJs, pdfjsLib } = await import(base + 'app/js/lib/pdfjs.js');
    const { OPS } = pdfjsLib;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const doc = await openPdfJs(bytes);
    const tests = {
      blue: (r, g, b) => b - r > 40 && b > 90,
      black: (r, g, b) => r < 80 && g < 80 && b < 80,
      red: (r, g, b) => r > 200 && g < 70 && b < 70,
      ink: (r, g, b) => (b - r > 40 && b > 90) || (r < 80 && g < 80 && b < 80),
    };
    const mul = (m, n) => [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
    ];
    const out = { pageCount: doc.numPages, pages: {} };
    try {
      for (const index of pages) {
        const p = await doc.getPage(index + 1);
        const vp1 = p.getViewport({ scale: 1 });
        const text = (await p.getTextContent()).items.map((i) => i.str).join(' ');
        const ops = await p.getOperatorList();
        const images = [];
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          if (fn === OPS.save) stack.push(ctm);
          else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
          else if (fn === OPS.transform) ctm = mul(ops.argsArray[i], ctm);
          else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) images.push(ctm);
        }
        const info = { width: vp1.width, height: vp1.height, rotate: p.rotate, view: p.view, text, images, found: {} };
        if (scale) {
          const vp = p.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await p.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
          const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          info.canvas = [canvas.width, canvas.height];
          for (const kind of kinds) {
            const test = tests[kind];
            let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1; let count = 0;
            for (let y = 0; y < canvas.height; y++) {
              for (let x = 0; x < canvas.width; x++) {
                const o = (y * canvas.width + x) * 4;
                if (!test(px[o], px[o + 1], px[o + 2])) continue;
                count++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
            info.found[kind] = { count, minX, minY, maxX, maxY };
          }
          info.regions = regions.map(({ kind, x0, y0, x1, y1 }) => {
            let count = 0; let total = 0;
            for (let y = Math.max(0, Math.round(y0)); y < Math.min(canvas.height, Math.round(y1)); y++) {
              for (let x = Math.max(0, Math.round(x0)); x < Math.min(canvas.width, Math.round(x1)); x++) {
                const o = (y * canvas.width + x) * 4;
                total++;
                if (tests[kind](px[o], px[o + 1], px[o + 2])) count++;
              }
            }
            return { count, total };
          });
        }
        out.pages[index] = info;
      }
    } finally {
      doc.loadingTask.destroy();
    }
    return out;
  }, { base: url, data: b64(bytes), pages, scale, kinds, regions });
}

/** The page frame the engine reads with pdf-lib, for each page of `bytes`. */
async function frames(page, url, bytes) {
  return page.evaluate(async ({ base, data }) => {
    const { pageFrame } = await import(base + 'app/js/engine/sign.js');
    const { loadPdf } = await import(base + 'app/js/engine/pdf-common.js');
    const doc = await loadPdf(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    return doc.getPages().map((_, i) => pageFrame(doc, i));
  }, { base: url, data: b64(bytes) });
}

const corner = (m, u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
const toPage = (f, x, y) => corner(f.matrix, x, y);

// -----------------------------------------------------------------------------------------------
// The engine

async function engineTests(page, url) {
  const source = await mixedPages();
  const sig = wave('blue');
  const aspect = S.Signature.from(sig).aspect;
  const fr = await frames(page, url, source);
  const before = await pageContents(source);
  // The frame read with pdf-lib is the page pdf.js shows, turned and cropped.
  const shown = await readBack(page, url, source, [0, 1, 2, 3]);
  for (let i = 0; i < 4; i++) {
    near(fr[i].shownWidth, shown.pages[i].width, 0.01, `Page ${i + 1} shown width as pdf.js`);
    near(fr[i].shownHeight, shown.pages[i].height, 0.01, `Page ${i + 1} shown height as pdf.js`);
    check(fr[i].rotation === shown.pages[i].rotate, `Page ${i + 1} rotation as pdf.js`);
  }

  // signatureGoesWhereThePreviewPutsIt: up and to the left, away from where a signature starts.
  const placement = { centerX: 0.3, centerY: 0.25, width: 0.35 };
  for (let index = 0; index < 4; index++) {
    const out = await signed(page, url, source, { signature: sig, page: index, placement, name: 'signed' });
    check(out.name === 'signed.pdf' && out.type === 'application/pdf' && out.pageCount === 4, `Output ${JSON.stringify([out.name, out.pageCount])}`);
    if (index === 1) await saveOutput('sign-engine-turned.pdf', out.bytes);
    const after = await pageContents(out.bytes);
    for (let i = 0; i < 4; i++) if (i !== index) check(after[i] === before[i], `Page ${i + 1} is unchanged when page ${index + 1} is signed`);
    const f = fr[index];
    const a = S.pdfArea(placement, f.shownWidth, f.shownHeight, aspect);
    const scale = 2;
    const back = await readBack(page, url, out.bytes, [0, 1, 2, 3], { scale, kinds: ['blue'] });
    check(back.pageCount === 4, 'Page count unchanged');
    for (let i = 0; i < 4; i++) {
      const imgs = back.pages[i].images;
      if (i !== index) {
        check(imgs.length === 0, `Page ${i + 1} has no signature`);
        check(back.pages[i].found.blue.count === 0, `Page ${i + 1} has no ink`);
        continue;
      }
      check(imgs.length === 1, `Page ${index + 1} has one picture, has ${imgs.length}`);
      // The picture's corners are the area's, the right way up on the page as shown.
      for (const [u, v, x, y] of [[0, 0, a.x, a.y], [1, 0, a.x + a.width, a.y], [0, 1, a.x, a.y + a.height]]) {
        const [px, py] = corner(imgs[0], u, v);
        const [ex, ey] = toPage(f, x, y);
        near(px, ex, 0.01, `Page ${index + 1} corner ${u},${v} x`);
        near(py, ey, 0.01, `Page ${index + 1} corner ${u},${v} y`);
      }
      check(back.pages[i].text.includes(`CAPTION ${'ABCD'[index]}`), `Page ${index + 1}'s text is kept`);
      // Rendered, the blue ink fills just that area of the page as shown (y down here).
      const ink = back.pages[i].found.blue;
      check(ink.count > 500, `Ink on page ${index + 1}: ${ink.count}`);
      const tol = 2 * scale;
      near(ink.minX, a.x * scale, tol, `Page ${index + 1} left`);
      near(ink.maxX + 1, (a.x + a.width) * scale, tol, `Page ${index + 1} right`);
      near(ink.minY, (f.shownHeight - a.y - a.height) * scale, tol, `Page ${index + 1} top`);
      near(ink.maxY + 1, (f.shownHeight - a.y) * scale, tol, `Page ${index + 1} bottom`);
    }
  }

  // signatureStartsInTheLowerRight
  for (let index = 0; index < 4; index++) {
    const out = await signed(page, url, source, { signature: sig, page: index, placement: null });
    check(out.name === 'Signed.pdf', `A blank name gives Signed.pdf, not ${out.name}`);
    const back = await readBack(page, url, out.bytes, [index], { scale: 1, kinds: ['blue'] });
    const { found: { blue }, canvas: [w, h] } = back.pages[index];
    check(blue.count > 0, `Ink on page ${index + 1}`);
    check(blue.minX > w / 2, `Page ${index + 1}: on the right`);
    check(blue.minY > (h * 3) / 4, `Page ${index + 1}: at the bottom`);
  }

  // signatureImageIsSharpSmallAndTrimmed
  {
    const alpha = await mixedPages();
    const out = await signed(page, url, alpha, { signature: sig, page: 1, placement: { centerX: 0.5, centerY: 0.5, width: 0.3 }, name: 'sharp' });
    const added = out.bytes.length - alpha.length;
    check(added < 40000, `The signature added ${added} bytes`);
    const doc = await PDFDocument.load(out.bytes, { updateMetadata: false });
    const images = [];
    doc.context.enumerateIndirectObjects().forEach(([, obj]) => {
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') images.push(obj);
    });
    const image = images.find((i) => i.dict.get(PDFName.of('SMask')));
    check(!!image, 'The picture has a soft mask');
    const mask = doc.context.lookup(image.dict.get(PDFName.of('SMask')));
    const w = image.dict.get(PDFName.of('Width')).asNumber();
    const h = image.dict.get(PDFName.of('Height')).asNumber();
    const f = (await frames(page, url, alpha))[1];
    const widthPoints = 0.3 * f.shownWidth;
    near(w, Math.round((widthPoints / 72) * 300), 1, '300 pixels per inch of its width');
    near(h, w / aspect, 1.5, 'As tall as its shape says');
    check(image.dict.get(PDFName.of('ColorSpace')).toString() === '/DeviceRGB', 'RGB');
    // Every pixel has the ink's colour; the soft mask's alpha alone draws the strokes.
    const colors = decodePDFRawStream(image).decode();
    check(colors.length === w * h * 3, 'One colour per pixel');
    let all = true;
    for (let i = 0; i < colors.length; i += 3) if (colors[i] !== 0x1a || colors[i + 1] !== 0x3c || colors[i + 2] !== 0x9c) { all = false; break; }
    check(all, "Every pixel has the ink's colour");
    check(mask.dict.get(PDFName.of('Width')).asNumber() === w && mask.dict.get(PDFName.of('ColorSpace')).toString() === '/DeviceGray', 'The mask is as wide, in gray');
    const a = decodePDFRawStream(mask).decode();
    check(a.length === w * h, 'One alpha per pixel');
    const inked = (x, y) => a[y * w + x] > 0;
    const nearEdge = [0, 1, 2];
    const anyX = (fn) => { for (let x = 0; x < w; x++) if (fn(x)) return true; return false; };
    const anyY = (fn) => { for (let y = 0; y < h; y++) if (fn(y)) return true; return false; };
    check(anyX((x) => nearEdge.some((d) => inked(x, d))), 'Trimmed at the top');
    check(anyX((x) => nearEdge.some((d) => inked(x, h - 1 - d))), 'Trimmed at the bottom');
    check(anyY((y) => nearEdge.some((d) => inked(d, y))), 'Trimmed at the left');
    check(anyY((y) => nearEdge.some((d) => inked(w - 1 - d, y))), 'Trimmed at the right');
    check(!inked(0, 0) && !inked(w - 1, h - 1), 'No ink in the corners');
    let clear = 0;
    for (const v of a) if (v === 0) clear++;
    check(clear > a.length / 2, 'Mostly see-through');
  }

  // See-through: the page under the signature still shows between its strokes.
  {
    const red = await mixedPages({ background: true });
    const box = { centerX: 0.5, centerY: 0.5, width: 0.6 };
    const out = await signed(page, url, red, { signature: wave('black'), page: 0, placement: box });
    const f = fr[0];
    const a = S.pdfArea(box, f.shownWidth, f.shownHeight, S.Signature.from(wave('black')).aspect);
    const scale = 1;
    const region = { x0: a.x * scale + 2, x1: (a.x + a.width) * scale - 2, y0: (f.shownHeight - a.y - a.height) * scale + 2, y1: (f.shownHeight - a.y) * scale - 2 };
    const back = await readBack(page, url, out.bytes, [0], { scale, kinds: ['black'], regions: [{ kind: 'red', ...region }, { kind: 'black', ...region }] });
    const [reds, blacks] = back.pages[0].regions;
    check(reds.count / reds.total > 0.6, `The red page shows through the signature: ${reds.count} of ${reds.total}`);
    check(blacks.count > 300, `and the black ink is drawn over it: ${blacks.count}`);
    await saveOutput('sign-engine-see-through.pdf', out.bytes);
  }

  // A dot alone is a round dot as big as the pen.
  {
    const r = await page.evaluate(async (base) => {
      const { renderSignature } = await import(base + 'app/js/engine/sign.js');
      const { width, height, alpha } = renderSignature({ strokes: [[500, 250]], ink: 'black' }, 90);
      const at = (x, y) => alpha[y * width + x];
      return { width, height, centre: at(45, 45), corner: at(2, 2), edge: at(45, 1) };
    }, url);
    check(r.width === 90 && r.height === 90 && r.centre > 250 && r.corner === 0 && r.edge > 0, `A round dot: ${JSON.stringify(r)}`);
  }

  // itemsAndSignaturesCoverTheFieldsAndCommentsUnderThem: over the ticked box, the box becomes part
  // of the page under the signature; the other fields and comments stay.
  {
    const form = await formPdf();
    const placement = { centerX: 79 / A4[0], centerY: (A4[1] - 309) / A4[1], width: 0.12 };
    const out = await signed(page, url, form, { signature: { strokes: [[100, 100, 300, 160, 500, 100]], ink: 'black' }, page: 0, placement, name: 'form_signed' });
    await saveOutput('sign-engine-form.pdf', out.bytes);
    const doc = await PDFDocument.load(out.bytes, { updateMetadata: false });
    const fields = doc.getForm().getFields().map((f) => f.getName());
    check(JSON.stringify(fields) === '["name","city"]', `The box under the signature left the form: ${JSON.stringify(fields)}`);
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const kinds = Array.from({ length: annots.size() }, (_, i) => doc.context.lookup(annots.get(i), PDFDict).get(PDFName.of('Subtype')).toString().slice(1));
    check(JSON.stringify(kinds) === '["Widget","Widget","Square","Text","Popup","Link"]', `Other annotations stay: ${JSON.stringify(kinds)}`);
    const back = await readBack(page, url, out.bytes, [0]);
    check(back.pages[0].text.includes('Jane Doe') || back.pages[0].images.length === 1, 'Read back');
    check(back.pages[0].images.length === 1, 'The signature is on the page');
  }

  // A password-protected PDF: asked for, and the signed PDF has none.
  {
    const locked = new Uint8Array(await fixture('flatten-locked.pdf'));
    const none = await sign(page, url, locked, { signature: sig, page: 0 });
    check(none.error === 'PasswordError' && !none.wrong, `A password is needed: ${JSON.stringify(none)}`);
    const wrong = await sign(page, url, locked, { signature: sig, page: 0 }, { password: 'guess' });
    check(wrong.error === 'PasswordError' && wrong.wrong, `A wrong password is said: ${JSON.stringify(wrong)}`);
    const out = await signed(page, url, locked, { signature: sig, page: 0 }, { password: 'secret' });
    const text = Buffer.from(out.bytes).toString('latin1');
    check(!/\/Encrypt\b/.test(text), 'The signed PDF has no password');
    const back = await readBack(page, url, out.bytes, [0]);
    check(back.pages[0].images.length === 1, 'Signed');
  }

  // Damaged files, nothing drawn, a page that isn't there, cancelling.
  {
    const damaged = await sign(page, url, new TextEncoder().encode('%PDF-1.7\nnot really a PDF'), { signature: sig, page: 0 });
    check(damaged.error === 'UserError' && damaged.key === 'pdf_import_failed', `A damaged PDF: ${JSON.stringify(damaged)}`);
    const empty = await sign(page, url, source, { signature: { strokes: [], ink: 'black' }, page: 0 });
    check(empty.error === 'UserError' && empty.key === 'pdf_process_failed', `Nothing drawn: ${JSON.stringify(empty)}`);
    const missing = await sign(page, url, source, { signature: sig, page: 4 });
    check(missing.error === 'UserError' && missing.key === 'pdf_process_failed', `No page 5: ${JSON.stringify(missing)}`);
    const cancelled = await sign(page, url, source, { signature: sig, page: 0 }, { abort: true });
    check(cancelled.error === 'CancelledError', `Cancelled: ${JSON.stringify(cancelled)}`);
    const named = await signed(page, url, source, { signature: sig, page: 0, name: ' Contract: final.pdf ' });
    check(named.name === 'Contract_ final.pdf', `Names are made safe: ${named.name}`);
  }

  // Odd page boxes: a crop box past the media box, boxes written backwards, rotations inherited,
  // negative or not a quarter turn, the media box inherited from the page tree.
  {
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([400, 600]);
    p1.node.set(PDFName.of('CropBox'), doc.context.obj([-50, 100, 300, 900]));
    const p2 = doc.addPage([400, 600]);
    p2.node.set(PDFName.of('MediaBox'), doc.context.obj([400, 600, 0, 0]));
    p2.node.set(PDFName.of('Rotate'), doc.context.obj(-90));
    const p3 = doc.addPage([400, 600]);
    p3.node.set(PDFName.of('Rotate'), doc.context.obj(45));
    const p4 = doc.addPage([400, 600]);
    p4.node.delete(PDFName.of('MediaBox'));
    doc.catalog.lookup(PDFName.of('Pages'), PDFDict).set(PDFName.of('MediaBox'), doc.context.obj([0, 0, 300, 200]));
    doc.catalog.lookup(PDFName.of('Pages'), PDFDict).set(PDFName.of('Rotate'), doc.context.obj(180));
    for (let i = 0; i < 4; i++) {
      p1.drawText('x', { x: 10, y: 10, size: 1 });
    }
    const odd = await doc.save();
    const f = await frames(page, url, odd);
    const back = await readBack(page, url, odd, [0, 1, 2, 3]);
    for (let i = 0; i < 4; i++) {
      near(f[i].shownWidth, back.pages[i].width, 0.01, `Odd page ${i + 1} width as pdf.js`);
      near(f[i].shownHeight, back.pages[i].height, 0.01, `Odd page ${i + 1} height as pdf.js`);
      check(f[i].rotation === back.pages[i].rotate, `Odd page ${i + 1} rotation ${f[i].rotation} as pdf.js ${back.pages[i].rotate}`);
      check(JSON.stringify([f[i].left, f[i].bottom, f[i].left + f[i].width, f[i].bottom + f[i].height]) === JSON.stringify(back.pages[i].view), `Odd page ${i + 1} view ${JSON.stringify(back.pages[i].view)}`);
      const out = await signed(page, url, odd, { signature: sig, page: i, placement: { centerX: 0.5, centerY: 0.5, width: 0.5 } });
      const r = await readBack(page, url, out.bytes, [i], { scale: 1, kinds: ['blue'] });
      const { blue } = r.pages[i].found;
      const [cw, ch] = r.pages[i].canvas;
      near((blue.minX + blue.maxX + 1) / 2 / cw, 0.5, 0.02, `Odd page ${i + 1}: centred across`);
      near((blue.minY + blue.maxY + 1) / 2 / ch, 0.5, 0.02, `Odd page ${i + 1}: centred down`);
      near((blue.maxX + 1 - blue.minX) / cw, 0.5, 0.02, `Odd page ${i + 1}: half as wide`);
    }
  }
}

// -----------------------------------------------------------------------------------------------
// The screen

async function openTool(page, url) {
  await page.goto(url + 'app/#/tool/sign');
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  await page.waitForSelector('.screen[data-tool="sign"]:not([aria-busy])');
}

/**
 * Picks a PDF with the file chooser, or (`drop`) drops it on the screen as from a file manager.
 * Under Playwright, Firefox's file input says "cancel" before "change", so it drops there.
 */
async function pickPdf(page, name, bytes, { drop = false } = {}) {
  if (drop) {
    await page.evaluate(({ name, data }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
      const target = document.querySelector('.sign-page .ui-empty');
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { name, data: b64(bytes) });
  } else {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sign-page .ui-empty')]);
    await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  }
  await page.waitForSelector('.sign-signature');
}

/** Points along a wave across the pad, as fractions of it. */
function wavePoints(n = 24, y0 = 0.45, from = 0.15, to = 0.8) {
  return Array.from({ length: n + 1 }, (_, i) => [from + ((to - from) * i) / n, y0 - 0.15 * Math.sin((i / n) * Math.PI * 2)]);
}

async function mouseStroke(page, box, points, { up = true } = {}) {
  const at = ([fx, fy]) => [box.x + fx * box.width, box.y + fy * box.height];
  await page.mouse.move(...at(points[0]));
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...at(p));
  if (up) await page.mouse.up();
}

async function touchStroke(cdp, box, points) {
  const at = ([fx, fy]) => ({ x: box.x + fx * box.width, y: box.y + fy * box.height, id: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(points[0])] });
  for (const p of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(p)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function padBox(page) {
  await page.waitForSelector('.sign-pad-canvas');
  await page.waitForTimeout(350);
  return page.locator('.sign-pad-canvas').boundingBox();
}

/** Scrolls the preview to the middle of the screen, clear of the bars, to touch it. */
async function centrePreview(page) {
  await page.evaluate(() => document.querySelector('.sign-preview').scrollIntoView({ block: 'center', inline: 'center' }));
  await page.waitForTimeout(150);
}

/** Where the preview shows the signature, as shares of the page: its ink box and its centre. */
async function previewPlace(page) {
  await page.waitForTimeout(350);
  return page.evaluate(() => {
    const p = document.querySelector('.sign-preview').getBoundingClientRect();
    const ink = document.querySelector('.sign-mark-ink').getBoundingClientRect();
    return {
      left: (ink.left - p.left) / p.width, right: (ink.right - p.left) / p.width,
      top: (ink.top - p.top) / p.height, bottom: (ink.bottom - p.top) / p.height,
      centerX: ((ink.left + ink.right) / 2 - p.left) / p.width, centerY: ((ink.top + ink.bottom) / 2 - p.top) / p.height,
      width: ink.width / p.width,
    };
  });
}

/** The PDF the result screen shows. */
async function resultBytes(page) {
  await page.waitForSelector('.ui-result');
  const data = await page.evaluate(() => {
    const f = document.querySelector('.ui-result').files[0];
    let s = '';
    for (let i = 0; i < f.bytes.length; i += 0x8000) s += String.fromCharCode(...f.bytes.subarray(i, i + 0x8000));
    return { name: f.name, data: btoa(s) };
  });
  return { name: data.name, bytes: fromB64(data.data) };
}

/** The ink found on page `index` of `bytes`, as shares of the page as shown. */
async function inkShares(page, url, bytes, index, kind) {
  const r = await readBack(page, url, bytes, [index], { scale: 1.5, kinds: [kind] });
  const { found, canvas: [w, h] } = r.pages[index];
  const k = found[kind];
  return { count: k.count, left: k.minX / w, right: (k.maxX + 1) / w, top: k.minY / h, bottom: (k.maxY + 1) / h, pageCount: r.pageCount, images: r.pages[index].images.length };
}

function samePlace(ink, shown, message, tol = 0.012) {
  near(ink.left, shown.left, tol, `${message}: left`);
  near(ink.right, shown.right, tol, `${message}: right`);
  near(ink.top, shown.top, tol, `${message}: top`);
  near(ink.bottom, shown.bottom, tol, `${message}: bottom`);
}

async function noSideScroll(page, message) {
  const r = await page.evaluate(() => [document.scrollingElement.scrollWidth, document.scrollingElement.clientWidth]);
  check(r[0] <= r[1], `${message}: no sideways scroll (${r.join(' > ')})`);
}

async function shot(page, name, opts = {}) {
  if (quick) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `tests/output/sign-${name}.png`, ...opts });
}

/** Phone, touch: drawing, choosing pages, dragging, nudging, sizing, signing turned and cropped pages. */
async function phoneTests(browserName = 'chromium') {
  const source = await mixedPages();
  await withPage(async (page, url, context) => {
    await openTool(page, url);
    check(await page.locator('.sign-run').isDisabled(), 'Sign PDF is off without a PDF');
    await noSideScroll(page, 'Empty');
    await shot(page, 'phone-empty');
    await pickPdf(page, 'Contract.pdf', source);
    check(await page.locator('.sign-card--draw').count() === 1, '"Draw your signature" without a signature');
    check((await page.textContent('.sign-note')).includes("isn't a certified digital signature"), 'Says it is not a certified digital signature');
    check(await page.locator('.sign-place').count() === 0, 'Nothing to place before drawing');
    check(await page.locator('.sign-run').isDisabled(), 'Sign PDF is off without a signature');
    check(await page.inputValue('.sign-name input') === 'Contract_signed', 'The file name is the PDF\'s with _signed');

    // Drawing with a finger.
    await page.click('.sign-card--draw');
    const cdp = await context.newCDPSession(page);
    let box = await padBox(page);
    check((await page.textContent('.sign-pad-hint')).includes('finger'), 'A phone signs with a finger');
    check(await page.locator('.sign-pad-done').isDisabled() && await page.locator('.sign-pad-clear').isDisabled(), 'Done and Clear are off on an empty pad');
    await touchStroke(cdp, box, wavePoints());
    check(!await page.locator('.sign-pad-done').isDisabled(), 'Done once something is drawn');
    await touchStroke(cdp, box, [[0.2, 0.62], [0.5, 0.64], [0.85, 0.6]]);
    await touchStroke(cdp, box, [[0.9, 0.2]]);
    // A second finger is ignored while the first signs.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.3, y: box.y + box.height * 0.3, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.3, y: box.y + box.height * 0.3, id: 1 }, { x: box.x + box.width * 0.7, y: box.y + box.height * 0.2, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * 0.4, y: box.y + box.height * 0.32, id: 1 }, { x: box.x + box.width * 0.75, y: box.y + box.height * 0.25, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.click('.sign-swatch[data-ink="blue"]');
    check(await page.getAttribute('.sign-swatch[data-ink="blue"]', 'aria-checked') === 'true', 'Blue ink chosen');
    await shot(page, 'phone-pad');
    await page.click('.sign-pad-done');
    await page.waitForSelector('.sign-card--change');
    const kept = await page.evaluate(async (base) => (await import(base + 'app/js/tools/sign/index.js')).keptSignature(), url);
    check(kept && kept.strokes.length === 4 && kept.ink === 'blue', `Four strokes in blue (the second finger ignored): ${kept && kept.strokes.length}`);
    check(kept.strokes[0].length >= 20, 'The wave kept its points');
    check(await page.getAttribute('.sign-card--change', 'aria-label') === 'Change signature', 'The card changes the signature');
    // Smoothed as the app smooths it: the card shows the same curve.
    const d = await page.getAttribute('.sign-card-svg path', 'd');
    check(d.startsWith('M') && d.includes('Q'), 'Drawn as smooth curves');

    // The page strip starts on the last page; the preview shows it.
    await page.waitForSelector('.sign-preview-page canvas');
    check(await page.getAttribute('.sign-strip-page[aria-checked="true"]', 'aria-label') === 'Page 4', 'The last page is chosen first');
    check(await page.getAttribute('.sign-mark', 'aria-label') === 'Your signature on page 4', 'The preview says which page');
    check(!await page.locator('.sign-run').isDisabled(), 'Sign PDF is on');
    await noSideScroll(page, 'Editor');
    await shot(page, 'phone-editor', { fullPage: true });

    // Page 4 (landscape, turned three quarters): the signature where it starts out.
    await page.click('.sign-run');
    let out = await resultBytes(page);
    check(out.name === 'Contract_signed.pdf', `Saved as ${out.name}`);
    let ink = await inkShares(page, url, out.bytes, 3, 'blue');
    check(ink.pageCount === 4 && ink.images === 1 && ink.count > 100, `Signed page 4: ${JSON.stringify(ink)}`);
    await page.click('.ui-topbar-nav');
    await page.waitForSelector('.sign-preview-page canvas');
    let shown = await previewPlace(page);
    samePlace(ink, shown, 'Page 4 where it starts out');
    check(shown.left > 0.5 && shown.top > 0.75, 'It starts out in the lower right');

    // Page 2 (turned a quarter): dragged with a finger.
    await page.click('.sign-strip-page[aria-label="Page 2"]');
    await page.waitForFunction(() => document.querySelector('.sign-mark').getAttribute('aria-label').endsWith('page 2'));
    await centrePreview(page);
    const before2 = await previewPlace(page);
    const mark = await page.locator('.sign-mark').boundingBox();
    const preview = await page.locator('.sign-preview').boundingBox();
    check(preview.width > preview.height, 'Page 2 is shown sideways');
    const from = { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 };
    const steps = [[0, 0], [-30, -10], [-80, -30], [-140, -60]];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    for (const [dx, dy] of steps.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + dx, y: from.y + dy, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const dragged = await previewPlace(page);
    near(dragged.centerX - before2.centerX, -140 / preview.width, 0.01, 'Dragged left with the finger');
    near(dragged.centerY - before2.centerY, -60 / preview.height, 0.01, 'Dragged up with the finger');
    // Bigger, then nudged.
    await page.locator('.sign-size input').fill('700');
    const bigger = await previewPlace(page);
    check(bigger.width > dragged.width * 1.5, `The size slider makes it bigger: ${dragged.width} → ${bigger.width}`);
    await page.click('[aria-label="Move signature down"]');
    await page.click('[aria-label="Move signature right"]');
    const nudged = await previewPlace(page);
    near(nudged.centerY - bigger.centerY, 0.02, 0.003, 'Down a step');
    near(nudged.centerX - bigger.centerX, 0.02, 0.003, 'Right a step');
    await page.click('.sign-run');
    out = await resultBytes(page);
    ink = await inkShares(page, url, out.bytes, 1, 'blue');
    samePlace(ink, nudged, 'Page 2, turned, dragged, sized and nudged');
    await saveOutput('sign-phone-turned.pdf', out.bytes);

    // Page 3 (cropped): a tap moves it there; pushed against the top edge, Up turns off.
    await page.click('.ui-topbar-nav');
    await page.waitForSelector('.sign-preview-page canvas');
    await page.click('.sign-strip-page[aria-label="Page 3"]');
    await page.waitForFunction(() => document.querySelector('.sign-mark').getAttribute('aria-label').endsWith('page 3'));
    // Its size is kept from page 2, as a share of the page: smaller first, to fit where it goes.
    await page.locator('.sign-size input').fill('150');
    await centrePreview(page);
    const pv = await page.locator('.sign-preview').boundingBox();
    await page.touchscreen.tap(pv.x + pv.width * 0.3, pv.y + pv.height * 0.2);
    const tapped = await previewPlace(page);
    near(tapped.centerX, 0.3, 0.01, 'A tap puts it there across');
    near(tapped.centerY, 0.2, 0.01, 'and down');
    for (let i = 0; i < 20 && !await page.locator('[aria-label="Move signature up"]').isDisabled(); i++) await page.click('[aria-label="Move signature up"]');
    const top = await previewPlace(page);
    check(await page.locator('[aria-label="Move signature up"]').isDisabled(), 'Up is off against the top edge');
    near(top.top, 0, 0.01, 'Against the top edge');
    await page.click('.sign-run');
    out = await resultBytes(page);
    ink = await inkShares(page, url, out.bytes, 2, 'blue');
    samePlace(ink, top, 'Page 3, cropped');
    await shot(page, 'phone-result');
    await saveOutput('sign-phone-cropped.pdf', out.bytes);

    // Back to editing keeps the choices; another PDF can be signed without drawing again.
    await page.click('.ui-topbar-nav');
    await page.waitForSelector('.sign-card--change');
    await page.click('.ui-file-card [aria-label^="Remove"]');
    await page.waitForSelector('.sign-page .ui-empty');
    const second = await PDFDocument.create();
    second.addPage(A4);
    second.addPage([300, 300]);
    await pickPdf(page, 'Second.pdf', await second.save());
    check(await page.locator('.sign-card--change').count() === 1, 'The signature is still there for another PDF');
    check(await page.getAttribute('.sign-strip-page[aria-checked="true"]', 'aria-label') === 'Page 2', 'Its last page is chosen');
    await page.click('.sign-run');
    out = await resultBytes(page);
    check(out.name === 'Second_signed.pdf', `Named after the second PDF: ${out.name}`);
    ink = await inkShares(page, url, out.bytes, 1, 'blue');
    check(ink.images === 1 && ink.pageCount === 2, 'The second PDF is signed too');

    // Leaving the tool and coming back keeps it; reloading the page forgets it.
    await page.click('.ui-topbar-nav');
    await page.waitForSelector('.sign-card--change');
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
    await page.evaluate(() => { location.hash = '#/tool/sign'; });
    await page.waitForSelector('.screen[data-tool="sign"]:not([aria-busy])');
    await pickPdf(page, 'Third.pdf', source);
    check(await page.locator('.sign-card--change').count() === 1, 'Kept after leaving the tool');
    // Never written to storage.
    const stored = await page.evaluate(async () => {
      const ls = JSON.stringify({ ...localStorage });
      const ss = JSON.stringify({ ...sessionStorage });
      const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
      return { ls, ss, dbs };
    });
    check(!/strokes|signature/i.test(stored.ls + stored.ss), `Nothing in storage: ${stored.ls} ${stored.ss}`);
    check(!stored.dbs.some((n) => /sign/i.test(n)), `No database of signatures: ${stored.dbs}`);
    await page.reload();
    await page.waitForSelector('.screen[data-tool="sign"]:not([aria-busy])');
    await pickPdf(page, 'Third.pdf', source);
    check(await page.locator('.sign-card--draw').count() === 1, 'Gone after a reload');
    check(await page.evaluate(async (base) => (await import(base + 'app/js/tools/sign/index.js')).keptSignature(), url) === null, 'Nothing kept after a reload');
  }, { browser: browserName, viewport: { width: 360, height: 780 } });
}

/** Desktop, mouse and keyboard: drawing, Clear and Done mid-stroke, dragging, arrow keys. */
async function desktopTests() {
  const source = await mixedPages({ caption: false });
  await withPage(async (page, url) => {
    await openTool(page, url);
    await shot(page, 'desktop-empty');
    await pickPdf(page, 'Lease.pdf', source);
    await page.click('.sign-card--draw');
    let box = await padBox(page);
    check((await page.textContent('.sign-pad-hint')).includes('mouse'), 'A computer signs with a mouse too');
    await mouseStroke(page, box, wavePoints());
    // Clear while a stroke is being drawn: the rest of it isn't drawn either (EditorsMultiClickDeviceTest).
    await mouseStroke(page, box, [[0.55, 0.5], [0.6, 0.52], [0.65, 0.5]], { up: false });
    await page.focus('.sign-pad-clear');
    await page.keyboard.press('Enter');
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
    await page.mouse.up();
    check(await page.locator('.sign-pad-done').isDisabled() && await page.locator('.sign-pad-clear').isDisabled(), 'Cleared mid-stroke stays empty');
    // Escape closes the pad and keeps no drawing.
    await mouseStroke(page, box, wavePoints());
    await page.keyboard.press('Escape');
    await page.waitForSelector('.sign-pad-dialog', { state: 'detached' });
    check(await page.locator('.sign-card--draw').count() === 1, 'Closing the pad keeps no signature');
    check(await page.evaluate(() => document.activeElement?.classList.contains('sign-card')), 'The focus returns to the card');
    // Done while a stroke is being drawn takes that stroke too.
    await page.click('.sign-card--draw');
    box = await padBox(page);
    await mouseStroke(page, box, wavePoints());
    await mouseStroke(page, box, [[0.2, 0.65], [0.5, 0.66], [0.8, 0.63]], { up: false });
    await shot(page, 'desktop-pad');
    await page.focus('.sign-pad-done');
    await page.keyboard.press('Enter');
    await page.mouse.up();
    await page.waitForSelector('.sign-card--change');
    const kept = await page.evaluate(async (base) => (await import(base + 'app/js/tools/sign/index.js')).keptSignature(), url);
    check(kept.strokes.length === 2 && kept.ink === 'black', `Done mid-stroke keeps both strokes: ${kept.strokes.length}`);
    await page.waitForSelector('.sign-preview-page canvas');
    await noSideScroll(page, 'Desktop editor');
    // Side by side: the preview beside the options.
    const layout = await page.evaluate(() => {
      const a = document.querySelector('.sign-signature').getBoundingClientRect();
      const b = document.querySelector('.sign-preview').getBoundingClientRect();
      return { optionsRight: a.right, previewLeft: b.left, previewTop: b.top, optionsTop: a.top };
    });
    check(layout.previewLeft > layout.optionsRight, 'The preview is beside the options on a wide screen');
    await shot(page, 'desktop-editor');

    // Page 1, dragged with the mouse, then moved with the arrow keys.
    await page.click('.sign-strip-page[aria-label="Page 1"]');
    await page.waitForFunction(() => document.querySelector('.sign-mark').getAttribute('aria-label').endsWith('page 1'));
    await centrePreview(page);
    const start = await previewPlace(page);
    const mark = await page.locator('.sign-mark').boundingBox();
    const pv = await page.locator('.sign-preview').boundingBox();
    await page.mouse.move(mark.x + mark.width / 2, mark.y + mark.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(mark.x + mark.width / 2 - 20 * i, mark.y + mark.height / 2 - 25 * i);
    await page.mouse.up();
    const dragged = await previewPlace(page);
    near(dragged.centerX - start.centerX, -200 / pv.width, 0.005, 'Dragged left with the mouse');
    near(dragged.centerY - start.centerY, -250 / pv.height, 0.005, 'Dragged up with the mouse');
    check(await page.evaluate(() => document.activeElement?.classList.contains('sign-mark')), 'The signature has the focus after a drag');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    const keyed = await previewPlace(page);
    near(keyed.centerX - dragged.centerX, -0.04, 0.003, 'Two steps left with the arrow keys');
    near(keyed.centerY - dragged.centerY, -0.02, 0.003, 'One step up');
    // A click off the signature moves it there.
    await page.mouse.click(pv.x + pv.width * 0.7, pv.y + pv.height * 0.8);
    const clicked = await previewPlace(page);
    near(clicked.centerX, 0.7, 0.01, 'A click puts it there across');
    near(clicked.centerY, 0.8, 0.01, 'and down');
    await page.keyboard.press('Tab');
    await page.click('.sign-run');
    const out = await resultBytes(page);
    const ink = await inkShares(page, url, out.bytes, 0, 'black');
    samePlace(ink, clicked, 'Page 1, by mouse and keyboard', 0.008);
    check(!(await page.textContent('.ui-result')).includes('no password'), 'Nothing said of a password the PDF never had');
    await shot(page, 'desktop-result');

    // Another PDF dropped on the screen takes this one's place.
    await page.click('.ui-topbar-nav');
    await page.waitForSelector('.sign-card--change');
    const other = await PDFDocument.create();
    other.addPage([400, 400]);
    const otherBytes = await other.save();
    await page.evaluate(({ data }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'Dropped.pdf', { type: 'application/pdf' }));
      const target = document.querySelector('.sign-page');
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { data: b64(otherBytes) });
    await page.waitForFunction(() => document.querySelector('.ui-file-name')?.textContent === 'Dropped.pdf');
    check(await page.inputValue('.sign-name input') === 'Dropped_signed', 'The dropped PDF names the file');
    check(await page.locator('.sign-strip').count() === 0, 'One page: no page to choose');

    // A PDF with a password: asked for, and the result says the new PDF has none.
    await page.click('.ui-file-card [aria-label^="Remove"]');
    await page.waitForSelector('.sign-page .ui-empty');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sign-page .ui-empty')]);
    await chooser.setFiles({ name: 'Locked.pdf', mimeType: 'application/pdf', buffer: await fixture('flatten-locked.pdf') });
    await page.waitForSelector('.ui-password input');
    await page.fill('.ui-password input', 'secret');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sign-preview-page canvas');
    await page.click('.sign-run');
    const locked = await resultBytes(page);
    check((await page.textContent('.ui-result')).includes('The new PDF has no password.'), 'The result says the new PDF has no password');
    const lockedInk = await inkShares(page, url, locked.bytes, 0, 'black');
    check(lockedInk.images === 1 && lockedInk.count > 50, 'The locked PDF is signed');
    check(!/\/Encrypt\b/.test(Buffer.from(locked.bytes).toString('latin1')), 'and has no password');
  }, { viewport: { width: 1366, height: 768 } });
}

/** Light and dark screenshots at both sizes, and 320 px without sideways scrolling. */
async function lookTests() {
  const source = await mixedPages();
  for (const [name, viewport] of [['phone', { width: 360, height: 780 }], ['desktop', { width: 1366, height: 768 }], ['narrow', { width: 320, height: 640 }]]) {
    for (const scheme of ['light', 'dark']) {
      if (quick && (scheme === 'dark' || name !== 'narrow')) continue;
      await withPage(async (page, url) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openTool(page, url);
        await pickPdf(page, 'Look.pdf', source);
        await page.click('.sign-card--draw');
        const box = await padBox(page);
        await mouseStroke(page, box, wavePoints());
        await noSideScroll(page, `${name} ${scheme} pad`);
        if (name !== 'narrow') await shot(page, `${name}-pad-${scheme}`);
        await page.click('.sign-pad-done');
        await page.waitForSelector('.sign-preview-page canvas');
        await noSideScroll(page, `${name} ${scheme} editor`);
        if (name !== 'narrow') await shot(page, `${name}-editor-${scheme}`, { fullPage: name === 'phone' });
      }, { viewport });
    }
  }
}

/** The browser's Back and Forward over the result step; leaving while a password is asked for. */
async function backTests(browser = 'chromium') {
  const source = await mixedPages();
  await withPage(async (page, url) => {
    await openTool(page, url);
    await pickPdf(page, 'Back.pdf', source, { drop: browser === 'firefox' });
    await page.click('.sign-card--draw');
    const box = await padBox(page);
    await mouseStroke(page, box, wavePoints());
    await page.click('.sign-pad-done');
    await page.waitForSelector('.sign-preview-page canvas');
    await page.click('.sign-run');
    await page.waitForSelector('.ui-result');
    check(await page.evaluate(() => history.state?.step) === 'result', 'The result is a step in the history');
    await page.goBack();
    await page.waitForSelector('.sign-card--change');
    check(await page.locator('.ui-result').count() === 0, "The browser's Back leaves the result");
    check(await page.evaluate(() => location.hash) === '#/tool/sign', 'Still on Sign PDF');
    check(await page.textContent('.ui-file-name') === 'Back.pdf', 'The PDF is kept');
    await page.goForward();
    await page.waitForSelector('.ui-result');
    check(true, 'Forward shows the result again');
    await page.click('.ui-result .ui-topbar-nav');
    await page.waitForSelector('.sign-card--change');
    check(await page.evaluate(() => history.state?.step ?? null) === null, "Back to editing takes the result's step back");
    // A locked PDF handed over from Home: the browser's Back while its password is asked for
    // closes the dialog with the screen.
    await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/'));
    await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
    await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const { navigate } = await import('./js/core/router.js');
      await navigate('/tool/sign', { files: [{ name: 'Locked.pdf', type: 'application/pdf', size: bytes.length, lastModified: 0, bytes }] });
    }, b64(await fixture('flatten-locked.pdf')));
    await page.waitForSelector('dialog[open] .ui-password input');
    await page.goBack();
    await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
    await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
    await page.waitForTimeout(300);
    check(await page.locator('.screen[data-tool="sign"]').count() === 0 && !(await page.$('dialog[open]')), `${browser}: the password dialog went with the screen`);
  }, { browser, viewport: { width: 412, height: 860 } });
}

/** Firefox and WebKit: draw with the mouse, sign, read back. */
async function otherBrowsers() {
  const source = await mixedPages({ caption: false });
  for (const browser of ['firefox', 'webkit']) {
    await withPage(async (page, url) => {
      await openTool(page, url);
      await pickPdf(page, 'Other.pdf', source, { drop: browser === 'firefox' });
      await page.click('.sign-card--draw');
      const box = await padBox(page);
      await mouseStroke(page, box, wavePoints());
      await page.click('.sign-pad-done');
      await page.waitForSelector('.sign-preview-page canvas');
      await page.click('.sign-strip-page[aria-label="Page 2"]');
      await page.waitForTimeout(300);
      await centrePreview(page);
      const pv = await page.locator('.sign-preview').boundingBox();
      await page.mouse.click(pv.x + pv.width * 0.4, pv.y + pv.height * 0.4);
      const shown = await previewPlace(page);
      await page.click('.sign-run');
      const out = await resultBytes(page);
      const ink = await inkShares(page, url, out.bytes, 1, 'black');
      check(ink.images === 1, `${browser}: signed`);
      samePlace(ink, shown, `${browser}: where the preview showed it`, 0.015);
      await noSideScroll(page, browser);
    }, { browser, viewport: { width: 412, height: 860 }, mobile: false });
  }
}

// -----------------------------------------------------------------------------------------------

if (process.argv.includes('--other')) {
  await otherBrowsers();
  console.log(`sign (other browsers): all ${checks} checks passed`);
  process.exit(0);
}
if (process.argv.includes('--back')) {
  for (const browser of quick ? ['chromium'] : ['chromium', 'firefox', 'webkit']) await backTests(browser);
  console.log(`sign (Back): all ${checks} checks passed`);
  process.exit(0);
}
layoutTests();
console.log(`layout: ${checks} checks`);
await withPage(async (page, url) => {
  await page.goto(url + 'app/');
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  await engineTests(page, url);
});
console.log(`engine: ${checks} checks`);
await phoneTests();
console.log(`phone: ${checks} checks`);
await desktopTests();
console.log(`desktop: ${checks} checks`);
await backTests();
console.log(`Back: ${checks} checks`);
await lookTests();
console.log(`looks: ${checks} checks`);
if (!quick) {
  await otherBrowsers();
  for (const browser of ['firefox', 'webkit']) await backTests(browser);
  console.log(`other browsers: ${checks} checks`);
}
console.log(`sign: all ${checks} checks passed`);
