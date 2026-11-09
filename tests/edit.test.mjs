// Edit PDF: the engine (PageEdits.kt's geometry with its unit tests ported, EditHistory, and the PDF
// it makes: every kind of item where the preview put it on upright, turned and cropped pages, real
// text, a see-through highlighter, pictures compressed, untouched pages byte for byte the same, form
// fields and comments under items made part of the page) and the screen (each kind of item added,
// moved, resized, recoloured and deleted with a mouse and with a finger, Undo and Redo, keys, the
// saved PDF checked against the preview, screenshots at phone and desktop sizes, light and dark).
//
// Run: node tests/edit.test.mjs   (--quick: the engine and the phone screen in Chromium only)
import { withPage, assert, saveOutput, outputDir } from './harness.mjs';
import { PDFDocument, StandardFonts, degrees, PDFName, PDFString, PDFArray, PDFDict, PDFRawStream, PDFStream } from '@cantoo/pdf-lib';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const quick = process.argv.includes('--quick');
const started = Date.now();
let checks = 0;
const ok = (cond, msg) => { checks++; assert(cond, msg); };
const step = (name) => console.log(`- ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);

// ---- Fixtures ----

/**
 * Four pages, each with a black caption across the middle of its top half, as the app's test:
 * 1. A4, upright  2. A4, turned clockwise (/Rotate 90)
 * 3. A4 with a crop box leaving a 100-point border off on every side  4. landscape A4, turned anticlockwise (/Rotate 270)
 */
async function mixedPages() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const a4 = [595.28, 841.89];
  for (let i = 0; i < 4; i++) {
    const [w, h] = i === 3 ? [a4[1], a4[0]] : a4;
    const page = doc.addPage([w, h]);
    if (i === 1) page.setRotation(degrees(90));
    if (i === 2) page.setCropBox(100, 100, w - 200, h - 200);
    if (i === 3) page.setRotation(degrees(270));
    page.drawText(`CAPTION ${'ABCD'[i]}`, { x: w / 2 - 60, y: h / 2, size: 18, font });
    // One content stream, not an array of them, as most PDFs have it.
    const contents = page.node.Contents();
    if (contents instanceof PDFArray && contents.size() === 1) page.node.set(PDFName.of('Contents'), contents.get(0));
  }
  return doc.save({ useObjectStreams: false });
}

/** A form: a filled-in name, a city, a ticked box, a red square comment, a note with its popup, and a link. */
async function formPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.setText('Jane Doe');
  name.addToPage(page, { x: 80, y: 600, width: 240, height: 24 });
  const city = form.createTextField('city');
  city.addToPage(page, { x: 80, y: 560, width: 240, height: 24 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 80, y: 520, width: 18, height: 18 });
  agree.check();
  const ctx = doc.context;
  const square = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [350, 400, 500, 500], C: [1, 0, 0], IC: [1, 0, 0], F: 4 }));
  const note = ctx.nextRef();
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [400, 700, 560, 780], Parent: note }));
  ctx.assign(note, ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [520, 650, 540, 670], Contents: PDFString.of('A note'), Popup: popup, F: 4 }));
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 50, 150, 70], A: { S: 'URI', URI: PDFString.of('https://example.com') } }));
  for (const ref of [square, note, popup, link]) page.node.addAnnot(ref);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: true });
}

/** The raw bytes of each page's content stream (null for an array of them), and its resource names. */
async function rawPages(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const contents = p.node.get(PDFName.of('Contents'));
    const target = contents ? doc.context.lookup(contents) : null;
    const raw = target instanceof PDFRawStream ? Buffer.from(target.contents).toString('latin1') : null;
    const res = p.node.Resources();
    const keys = res ? [...res.keys()].map(String).sort() : [];
    return { raw, keys };
  });
}

// ---- Helpers that run in the page ----

function pageHelpers() {
  const T = {};
  T.pdfjs = async (bytes) => (await import('./js/lib/pdfjs.js')).openPdfJs(bytes);
  /** Page `n` (1-based) of a PDF drawn by pdf.js, `scale` pixels per point, on white. */
  T.render = async (bytes, n, scale = 2) => {
    const doc = await T.pdfjs(bytes);
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    doc.loadingTask.destroy();
    return { width: canvas.width, height: canvas.height, data: img.data, scale };
  };
  /** Where pixels matching `match(r, g, b)` are, in points on the page as shown: [left, top, right, bottom]. */
  T.extent = (img, match) => {
    let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity; let n = 0;
    const d = img.data;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (match(d[i], d[i + 1], d[i + 2])) {
          n++;
          if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
        }
      }
    }
    if (!n) return null;
    const s = img.scale;
    return [l / s, t / s, (r + 1) / s, (b + 1) / s, n];
  };
  T.red = (r, g, b) => r > 160 && g < 90 && b < 90;
  T.blue = (r, g, b) => b > 120 && r < 80 && g < 140;
  T.green = (r, g, b) => g > 90 && r < 80 && b < 90;
  T.magenta = (r, g, b) => r > 180 && b > 180 && g < 80;
  T.near = (a, b, tol) => Math.abs(a - b) <= tol;
  T.boxNear = (got, want, tol) => !!got && [0, 1, 2, 3].every((i) => Math.abs(got[i] - want[i]) <= tol);
  T.fmt = (a) => (a ? a.slice(0, 4).map((v) => v.toFixed(1)).join(',') : 'none');
  /** The text pdf.js finds on page `n`, each item with its start in points on the page as shown and its size. */
  T.text = async (bytes, n) => {
    const doc = await T.pdfjs(bytes);
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((it) => it.str).map((it) => {
      const [a, b, , , e, f] = it.transform;
      const [x, y] = vp.convertToViewportPoint(e, f);
      return { str: it.str, x, y, size: Math.hypot(a, b) };
    });
    doc.loadingTask.destroy();
    return items;
  };
  /** A picture made on a canvas: `draw(ctx)` on width × height, as `type` bytes. */
  T.picture = async (width, height, draw, type = 'image/png', quality) => {
    const c = new OffscreenCanvas(width, height);
    draw(c.getContext('2d'));
    const blob = await c.convertToBlob({ type, quality });
    return new Uint8Array(await blob.arrayBuffer());
  };
  /** A JPEG with an EXIF orientation added after its start. */
  T.withOrientation = (jpeg, orientation) => {
    const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = body.length + 2;
    const app1 = [0xff, 0xe1, len >> 8, len & 255, ...body];
    const out = new Uint8Array(jpeg.length + app1.length);
    out.set(jpeg.subarray(0, 2), 0);
    out.set(app1, 2);
    out.set(jpeg.subarray(2), 2 + app1.length);
    return out;
  };
  window.T = T;
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

await mkdir(outputDir, { recursive: true });
const mixed = await mixedPages();
const form = await formPdf();
const locked = await (async () => {
  const doc = await PDFDocument.load(mixed);
  await doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner' });
  return doc.save({ useObjectStreams: false });
})();

// =================================================================================================
// The engine
// =================================================================================================

await withPage(async (page, url) => {
  await page.goto(url + 'app/');
  await page.waitForSelector('html[data-ready="true"]');
  await page.evaluate(`(${pageHelpers.toString()})()`);

  // ---- PageEditsTest.kt ----
  step('geometry (PageEditsTest)');
  const failures = await page.evaluate(async () => {
    const E = await import('./js/engine/edit.js');
    const out = [];
    const check = (cond, msg) => { if (!cond) out.push(msg); };
    const near = (a, b, d = 0.001) => Math.abs(a - b) <= d;
    const nearPt = (p, q, d = 0.001) => near(p[0], q[0], d) && near(p[1], q[1], d);
    const frame = (rotation) => ({ m: E.topLeftMatrix(10, 20, 400, 600, rotation), w: rotation % 180 ? 600 : 400, h: rotation % 180 ? 400 : 600 });
    // The shown page's corners land on the box's corners.
    const topLeft = { 0: [10, 620], 90: [10, 20], 180: [410, 20], 270: [410, 620] };
    for (const [rotation, expected] of Object.entries(topLeft)) {
      const f = frame(Number(rotation));
      check(nearPt(E.fromTopLeft(f.m, 0, 0), expected), `rotation ${rotation}: top-left`);
      check(nearPt(E.fromTopLeft(f.m, f.w, f.h), [420 - expected[0], 640 - expected[1]]), `rotation ${rotation}: bottom-right`);
      const m = f.m;
      check(near(m[0] * m[3] - m[1] * m[2], -1, 0.0001), `rotation ${rotation}: only turns and flips`);
    }
    // Turned clockwise, down the screen is along the box's x axis.
    const f90 = frame(90);
    const a = E.fromTopLeft(f90.m, 100, 50);
    const b = E.fromTopLeft(f90.m, 100, 150);
    check(near(b[0] - a[0], 100) && near(b[1] - a[1], 0), 'turned page: down the screen');

    // Strokes follow the signature curve as cubics.
    const cubicAt = (x0, y0, op, t) => {
      const u = 1 - t;
      const at = (p, q, r, s) => u * u * u * p + 3 * u * u * t * q + 3 * u * t * t * r + t * t * t * s;
      return [at(x0, op[1], op[3], op[5]), at(y0, op[2], op[4], op[6])];
    };
    const ops = E.outline(E.inkItem({ id: 1, page: 0, points: [10, 10, 50, 80, 90, 20, 130, 60], width: 2, color: '#000000' }));
    check(String(ops[0]) === 'M,10,10' && String(ops[ops.length - 1]) === 'L,130,60', 'stroke ends');
    const curves = ops.filter((o) => o[0] === 'C');
    check(curves.length === 2 && near(curves[0][5], 70, 0.0001) && near(curves[0][6], 50, 0.0001), 'stroke bends through midpoints');
    for (const tt of [0.1, 0.35, 0.5, 0.8]) {
      const u = 1 - tt;
      const q = [u * u * 10 + 2 * u * tt * 50 + tt * tt * 70, u * u * 10 + 2 * u * tt * 80 + tt * tt * 50];
      check(nearPt(q, cubicAt(10, 10, curves[0], tt)), `cubic is the quadratic at ${tt}`);
    }
    check(JSON.stringify(E.outline(E.inkItem({ id: 2, page: 0, points: [5, 6], width: 2, color: '#000' }))) === '[["M",5,6],["L",5,6]]', 'one point is a dot');
    // Ellipse.
    const el = E.ellipse(100, 200, 300, 300);
    check(String(el[0]) === 'M,200,200' && el[el.length - 1][0] === 'Z', 'ellipse starts at its top');
    check(JSON.stringify(el.filter((o) => o[0] === 'C').map((o) => [o[5], o[6]])) === '[[300,250],[200,300],[100,250],[200,200]]', 'ellipse passes each side');
    const mid = cubicAt(200, 200, el[1], 0.5);
    check(near(((mid[0] - 200) / 100) ** 2 + ((mid[1] - 250) / 50) ** 2, 1), 'ellipse quarter is on the ellipse');
    // Arrow heads.
    const head = E.arrowHead(0, 0, 100, 0, 2);
    check(head[0] < 100 && head[2] < 100 && near(-head[1], head[3]), 'barbs behind the tip, one each side');
    check(near(Math.hypot(100 - head[0], head[1]), 10), 'barbs at least 10');
    check(near(Math.hypot(100 - E.arrowHead(0, 0, 100, 0, 10)[0], E.arrowHead(0, 0, 100, 0, 10)[1]), 40), 'longer for a thick line');
    check(near(Math.hypot(20 - E.arrowHead(0, 0, 20, 0, 10)[0], E.arrowHead(0, 0, 20, 0, 10)[1]), 10), 'at most half the arrow');
    // Painted areas follow the ink.
    const covers = (item, x, y) => E.paintedAreas(item).some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
    for (const kind of ['rectangle', 'ellipse']) {
      const o = E.shapeItem({ id: 1, page: 0, kind, x1: 100, y1: 100, x2: 300, y2: 200, width: 2, color: '#000' });
      check(!covers(o, 200, 150), `${kind}'s middle isn't painted`);
      check(covers(o, 100.5, 150) && covers(o, 200, 100.5), `${kind}'s edge is`);
      check(covers(E.copy(o, { filled: true }), 200, 150), `filled ${kind} is`);
    }
    const line = E.shapeItem({ id: 2, page: 0, kind: 'line', x1: 0, y1: 0, x2: 400, y2: 300, width: 4, color: '#000' });
    check(covers(line, 200, 150) && covers(line, -1.5, 0) && !covers(line, 380, 20) && !covers(line, 20, 280), 'slanting line paints along itself');
    const stroke = E.inkItem({ id: 3, page: 0, points: [0, 0, 100, 100, 200, 0, 300, 100], width: 2, color: '#000' });
    check(!covers(stroke, 150, 90) && covers(stroke, 0, 0) && covers(stroke, 300, 100), 'a stroke paints along itself');
    check(covers(E.inkItem({ id: 4, page: 0, points: [50, 50], width: 6, color: '#000' }), 52, 48), 'a dot paints its spot');
    const text = E.textItem({ id: 1, page: 0, x: 100, y: 200, text: 'Hello', size: 10, color: '#000', unitWidth: 2.5, unitHeight: 1.2 });
    check(JSON.stringify(E.paintedAreas(text)) === JSON.stringify([E.bounds(text)]), 'text paints its box');
    // Text box scales with its size.
    const tb = E.bounds(text);
    check(near(tb.x, 100) && near(tb.y, 200) && near(tb.width, 25) && near(tb.height, 12), 'text box');
    const bigger = E.scaled(text, 2, 100, 200);
    check(near(bigger.size, 20) && near(E.bounds(bigger).width, 50) && near(E.bounds(bigger).height, 24), 'text twice as big');
    // Moves stop at the page edges.
    const box = E.shapeItem({ id: 1, page: 0, kind: 'rectangle', x1: 50, y1: 50, x2: 150, y2: 100, width: 2, color: '#000' });
    const movedBox = E.moved(box, 1000, -1000, 400, 600);
    check(near(movedBox.x2, 399) && near(movedBox.y1, 1), 'move stops at the edges (outline counted)');
    check(E.sameItem(E.moved(box, 10, 20, 400, 600), E.shifted(box, 10, 20)), 'a move inside goes as far as asked');
    const wide = E.textItem({ id: 2, page: 0, x: 0, y: 0, text: 'x', size: 10, color: '#000', unitWidth: 50, unitHeight: 1 });
    check(near(E.bounds(E.onPage(wide, 400, 600)).x, -50), 'bigger than the page: centred');
    // Box corners move while the opposite one stays.
    const ell = E.shapeItem({ id: 1, page: 0, kind: 'ellipse', x1: 100, y1: 100, x2: 200, y2: 150, width: 2, color: '#000' });
    const d1 = E.dragHandle(ell, E.Handle.TOP_LEFT, 50, 60, 400, 600);
    check([d1.x1, d1.y1, d1.x2, d1.y2].join() === '50,60,200,150', 'corner dragged');
    const d2 = E.dragHandle(ell, E.Handle.BOTTOM_RIGHT, 40, 120, 400, 600);
    check([d2.x1, d2.y1, d2.x2, d2.y2].join() === '40,100,100,120', 'turned inside out');
    const d3 = E.dragHandle(ell, E.Handle.BOTTOM_RIGHT, 101, 900, 400, 600);
    check(near(d3.x2, 100 + E.MIN_SIZE) && near(d3.y2, 600), 'never smaller, never off the page');
    // Pictures keep their shape.
    const pic = E.pictureItem({ id: 1, page: 0, picture: {}, x: 100, y: 100, width: 200, height: 100 });
    const pg = E.dragHandle(pic, E.Handle.BOTTOM_RIGHT, 350, 120, 400, 600);
    check(near(pg.x, 100) && near(pg.y, 100) && near(pg.width, 250) && near(pg.height, 125), 'picture grows keeping its shape');
    const pu = E.dragHandle(pic, E.Handle.TOP_LEFT, -500, 90, 400, 600);
    check(near(pu.x + pu.width, 300) && near(pu.y + pu.height, 200) && near(pu.x, 0) && near(pu.width / pu.height, 2), 'picture pulled up-left stops at the page');
    // Line ends move.
    const arrow = E.shapeItem({ id: 1, page: 0, kind: 'arrow', x1: 10, y1: 10, x2: 100, y2: 10, width: 2, color: '#000' });
    check(E.handles(arrow).map((x) => x[0]).join() === 'start,end', 'a line has two ends');
    const am = E.dragHandle(arrow, E.Handle.END, 120, 700, 400, 600);
    check([am.x1, am.y1, am.x2, am.y2].join() === '10,10,120,600', 'the end moves, kept on the page');
    // Text grows from its corner within the font sizes.
    const th = E.handles(text);
    check(th.length === 1 && th[0][0] === E.Handle.BOTTOM_RIGHT && near(th[0][1], 125) && near(th[0][2], 212), 'text handle');
    check(near(E.dragHandle(text, E.Handle.BOTTOM_RIGHT, 137.5, 218, 400, 600).size, 15), 'text 1.5 times');
    check(near(E.dragHandle(text, E.Handle.BOTTOM_RIGHT, 100, 200, 400, 600).size, E.MIN_TEXT), 'text no smaller than MIN_TEXT');
    check(near(E.dragHandle(text, E.Handle.BOTTOM_RIGHT, 117.5, 212, 400, 600).size, 10 * (17.5 * 25 + 12 * 12) / (25 * 25 + 12 * 12)), 'left shrinks one line');
    check(near(E.dragHandle(text, E.Handle.BOTTOM_RIGHT, 125, 214, 400, 600).size, 10 * (25 * 25 + 14 * 12) / (25 * 25 + 12 * 12)), 'drift barely grows');
    // Size slider scales about the middle.
    const fb = E.shapeItem({ id: 1, page: 0, kind: 'rectangle', x1: 100, y1: 100, x2: 200, y2: 150, width: 0, color: '#000', filled: true });
    check(near(E.size(fb), 100), 'box size');
    const rb = E.resized(fb, 200, 400, 600);
    check([rb.x1, rb.y1, rb.x2, rb.y2].join() === '50,75,250,175', 'resized about the middle');
    check(near(E.sizeRange(fb, 400, 600).max, 400), 'at most as big as fits');
    check(near(E.size(text), 10) && near(E.sizeRange(text, 400, 600).min, E.MIN_TEXT) && near(E.sizeRange(text, 4000, 6000).max, E.MAX_TEXT), 'text sizes are font sizes');
    // Outlines are touched by their line, filled shapes anywhere.
    const outlined = E.shapeItem({ id: 1, page: 0, kind: 'rectangle', x1: 100, y1: 100, x2: 300, y2: 300, width: 2, color: '#000' });
    check(E.hits(outlined, 101, 200, 5) && !E.hits(outlined, 200, 200, 5) && E.hits(E.copy(outlined, { filled: true }), 200, 200, 5) && !E.hits(outlined, 320, 200, 5), 'rectangle hits');
    const oe = E.copy(outlined, { kind: 'ellipse' });
    check(E.hits(oe, 200, 102, 5) && !E.hits(oe, 200, 200, 5) && !E.hits(oe, 105, 105, 5), 'ellipse hits');
    const l2 = E.shapeItem({ id: 2, page: 0, kind: 'line', x1: 0, y1: 0, x2: 100, y2: 100, width: 2, color: '#000' });
    check(E.hits(l2, 52, 48, 5) && !E.hits(l2, 70, 30, 5), 'line hits');
    const ink = E.inkItem({ id: 3, page: 0, points: [0, 0, 100, 0, 100, 100], width: 4, color: '#000' });
    check(E.hits(ink, 50, 6, 5) && !E.hits(ink, 50, 50, 5), 'stroke hits');
    // Touches pick the chosen item first, then the topmost.
    const bottom = E.shapeItem({ id: 1, page: 0, kind: 'rectangle', x1: 0, y1: 0, x2: 100, y2: 100, width: 2, color: '#000', filled: true });
    const top = E.shapeItem({ id: 2, page: 0, kind: 'rectangle', x1: 50, y1: 50, x2: 150, y2: 150, width: 2, color: '#000', filled: true });
    check(E.pick([bottom, top], 75, 75, 1, null) === top && E.pick([bottom, top], 75, 75, 1, 1) === bottom &&
      E.pick([bottom, top], 140, 140, 1, 1) === top && E.pick([bottom, top], 300, 300, 1, null) === null, 'pick');
    // New items start in the middle.
    const ns = E.newShape(1, 2, 'rectangle', false, 2, '#000', 400, 600);
    check(ns.page === 2 && near((ns.x1 + ns.x2) / 2, 200) && near((ns.y1 + ns.y2) / 2, 300), 'new shape in the middle');
    const np = E.newPicture(2, 0, {}, 0.5, 400, 600);
    check(near(np.width / np.height, 0.5) && np.height <= 300 && np.width <= 200 && near(np.x + np.width / 2, 200), 'new picture in the middle');
    const nt = E.newText(3, 0, 'long', 40, '#000', 30, 1.2, 400, 600);
    check(near(nt.size, 12) && E.bounds(nt).x >= 0 && Math.abs(E.bounds(nt).x + E.bounds(nt).width / 2 - 200) < 0.01, 'too wide: smaller font');
    // New items don't hide the ones before.
    const first = E.newShape(1, 0, 'rectangle', false, 2, '#000', 400, 600);
    const second = E.clearOf(E.newShape(2, 0, 'rectangle', false, 2, '#000', 400, 600), [first], 400, 600);
    check(near(second.x1, first.x1 + 16) && near(second.y1, first.y1 + 16), 'second one a step down and right');
    const third = E.clearOf(E.newShape(3, 0, 'rectangle', true, 2, '#000', 400, 600), [first, second], 400, 600);
    check(near(third.x1, first.x1 + 32), 'third one two steps');
    const fresh = E.newShape(4, 0, 'ellipse', false, 2, '#000', 400, 600);
    check(E.clearOf(fresh, [E.shifted(first, 100, 0)], 400, 600) === fresh, 'something elsewhere is not in the way');
    const other = E.newShape(5, 1, 'rectangle', false, 2, '#000', 400, 600);
    check(E.clearOf(other, [first, second], 400, 600) === other, 'another page is not in the way');

    // ---- EditHistory (PageEditsDeviceTest.undoRedoAndSavedStateKeepTheItems) ----
    const hist = new E.EditHistory();
    const hb = E.shapeItem({ id: hist.newId(), page: 1, kind: 'rectangle', x1: 10, y1: 10, x2: 60, y2: 40, width: 2, color: '#d32f2f' });
    const hs = E.inkItem({ id: hist.newId(), page: 0, points: [5, 5, 50, 60], width: 2.5, color: '#1565c0' });
    hist.change([hb]);
    hist.select(hb.id);
    hist.change([hb, hs]);
    hist.begin();
    for (let dx = 1; dx <= 10; dx++) hist.step([E.shifted(hb, dx, 0), hs]);
    hist.end();
    check(E.sameItem(hist.items[0], E.shifted(hb, 10, 0)), 'a drag is many steps');
    hist.begin();
    hist.end();
    check(hist.undo() === 1 && E.sameItems(hist.items, [hb, hs]), 'the drag undone, on page 2');
    check(hist.undo() === 0 && E.sameItems(hist.items, [hb]) && hist.canRedo, 'then the stroke, on page 1');
    hist.begin(); hist.step(hist.items); hist.end();
    check(hist.canRedo, 'a touch that moves nothing keeps Redo');
    hist.begin(); hist.step([E.shifted(hb, 5, 0)]); hist.step([hb]); hist.end();
    check(hist.canRedo && hist.canUndo, 'a slider brought back keeps Redo');
    check(hist.redo() === 0 && E.sameItems(hist.items, [hb, hs]), 'redo');
    hist.change([hs]);
    check(!hist.canRedo && hist.redo() === null, 'a new change cannot be redone over');
    hist.undo(); hist.redo();
    check(hist.selected === null, 'the chosen box has gone: nothing chosen');
    check(hist.newId() > hs.id, 'ids are not reused');
    // Limits (MAX_EDIT_ITEMS, MAX_INK_POINTS).
    const lim = new E.EditHistory();
    let added = 0;
    for (let i = 0; i < E.MAX_EDIT_ITEMS + 5; i++) if (lim.add(E.newShape(lim.newId(), 0, 'line', false, 2, '#000', 400, 600))) added++;
    check(added === E.MAX_EDIT_ITEMS && lim.full, 'at most MAX_EDIT_ITEMS');
    const inkLim = new E.EditHistory();
    check(inkLim.add(E.inkItem({ id: 1, page: 0, points: new Array(2 * E.MAX_INK_POINTS).fill(1), width: 2, color: '#000' })) && inkLim.inkRoom() === 0, 'ink room used up');
    check(!inkLim.add(E.inkItem({ id: 2, page: 0, points: [1, 1], width: 2, color: '#000' })), 'no more ink');
    // Undo keeps at most MAX_UNDO changes.
    const many = new E.EditHistory();
    for (let i = 0; i < E.MAX_UNDO + 10; i++) many.change([E.newShape(i + 1, 0, 'line', false, 2, '#000', 400, 600)]);
    let undos = 0;
    while (many.undo() !== null) undos++;
    check(undos === E.MAX_UNDO, `Undo goes back ${E.MAX_UNDO} changes (${undos})`);
    // Text that no font draws is refused.
    check(E.canDrawText('Hello é ñ\nगोपनीय'), 'Latin and Hindi can be drawn');
    check(!E.canDrawText('͸'), 'an unassigned character cannot');
    return out;
  });
  ok(failures.length === 0, 'geometry and history:\n  ' + failures.join('\n  '));

  // ---- The PDF ----
  step('every kind lands where the preview puts it (upright, turned, cropped pages)');
  const every = await page.evaluate(async (mixedB64) => {
    const E = await import('./js/engine/edit.js');
    const bytes = Uint8Array.from(atob(mixedB64), (c) => c.charCodeAt(0));
    const sizes = await E.shownPageSizes({ bytes });
    const [uw, uh] = await E.unitSize('Edited here');
    // A magenta square on a transparent ground, as a PNG.
    const png = await T.picture(120, 120, (g) => { g.fillStyle = '#ff00ff'; g.fillRect(20, 20, 80, 80); });
    const picture = await E.importPicture({ name: 'square.png', bytes: png });
    let id = 1;
    const items = sizes.flatMap(({ width: w, height: h }, page) => [
      E.shapeItem({ id: id++, page, kind: 'rectangle', x1: 0.1 * w, y1: 0.1 * h, x2: 0.35 * w, y2: 0.2 * h, width: 2, color: '#d32f2f', filled: true }),
      E.inkItem({ id: id++, page, points: [0.6 * w, 0.1 * h, 0.7 * w, 0.25 * h, 0.8 * w, 0.12 * h, 0.9 * w, 0.24 * h], width: 3, color: '#1565c0' }),
      E.shapeItem({ id: id++, page, kind: 'arrow', x1: 0.1 * w, y1: 0.75 * h, x2: 0.5 * w, y2: 0.85 * h, width: 4, color: '#2e7d32' }),
      E.textItem({ id: id++, page, x: 0.55 * w, y: 0.7 * h, text: 'Edited here', size: 16, color: '#000000', unitWidth: uw, unitHeight: uh }),
      E.pictureItem({ id: id++, page, picture, x: 0.6 * w, y: 0.85 * h, width: 0.12 * w, height: 0.12 * w }),
    ]);
    const progress = [];
    const out = await E.editPages({ name: 'mixed.pdf', bytes }, { items, name: 'edited' }, { onProgress: (d, n) => progress.push([d, n]) });
    const report = [];
    const layout = await E.textLayout('Edited here');
    for (let i = 0; i < 4; i++) {
      const [box, ink, arrow, text, square] = items.filter((it) => it.page === i);
      const img = await T.render(out.bytes, i + 1, 2);
      const want = (b) => [b.x, b.y, b.x + b.width, b.y + b.height];
      const red = T.extent(img, T.red);
      const blue = T.extent(img, T.blue);
      const green = T.extent(img, T.green);
      const magenta = T.extent(img, T.magenta);
      const inner = [square.x + square.width / 6, square.y + square.height / 6, square.x + square.width * 5 / 6, square.y + square.height * 5 / 6];
      if (!T.boxNear(red, want(E.bounds(box)), 1)) report.push(`page ${i + 1}: red box ${T.fmt(red)} vs ${T.fmt(want(E.bounds(box)))}`);
      if (!T.boxNear(blue, want(E.bounds(ink)), 1.5)) report.push(`page ${i + 1}: blue stroke ${T.fmt(blue)} vs ${T.fmt(want(E.bounds(ink)))}`);
      if (!T.boxNear(green, want(E.bounds(arrow)), 2)) report.push(`page ${i + 1}: green arrow ${T.fmt(green)} vs ${T.fmt(want(E.bounds(arrow)))}`);
      if (!T.boxNear(magenta, inner, 1.5)) report.push(`page ${i + 1}: picture ${T.fmt(magenta)} vs ${T.fmt(inner)}`);
      // The text: real text, starting at the box's left edge, its baseline the ascent below its top.
      const words = (await T.text(out.bytes, i + 1)).filter((it) => /Edited/.test(it.str));
      if (!words.length) report.push(`page ${i + 1}: no text found`);
      else {
        const w = words[0];
        if (!T.near(w.x, text.x, 0.5)) report.push(`page ${i + 1}: text x ${w.x} vs ${text.x}`);
        const baseline = text.y + layout.ascent * text.size / E.REFERENCE;
        if (!T.near(w.y, baseline, 0.5)) report.push(`page ${i + 1}: text baseline ${w.y} vs ${baseline}`);
        if (!T.near(w.size, 16, 0.5)) report.push(`page ${i + 1}: text size ${w.size}`);
      }
    }
    // The picture keeps its transparency (a soft mask), stored once for each size it is drawn at.
    const distinct = new Set(items.filter((it) => it.type === 'picture').map((it) => E.pdfLongSide(it))).size;
    const { PDFDocument, PDFName, PDFRawStream } = await import('./js/lib/pdf-lib.js');
    const doc = await PDFDocument.load(out.bytes);
    let images = 0;
    let masked = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image' && !obj.dict.get(PDFName.of('ImageMask'))) {
        if (obj.dict.get(PDFName.of('ColorSpace'))?.toString() === '/DeviceGray') continue;
        images++;
        if (obj.dict.get(PDFName.of('SMask'))) masked++;
      }
    }
    if (images !== distinct || masked !== distinct || distinct !== 3) report.push(`pictures: ${images} images, ${masked} with a soft mask, ${distinct} sizes`);
    const last = progress[progress.length - 1];
    if (!last || last[0] !== last[1]) report.push('progress did not reach the end');
    return { report, name: out.name, type: out.type, pages: out.pageCount, bytes: Array.from(out.bytes) };
  }, b64(mixed));
  ok(every.report.length === 0, 'every kind:\n  ' + every.report.join('\n  '));
  ok(every.name === 'edited.pdf' && every.type === 'application/pdf' && every.pages === 4, 'output file facts');
  const edited = new Uint8Array(every.bytes);
  await saveOutput('edit-every-kind.pdf', edited);

  step('pages without items stay as they were');
  {
    const out = fromB64(await page.evaluate(async (mixedB64) => {
      const E = await import('./js/engine/edit.js');
      const bytes = Uint8Array.from(atob(mixedB64), (c) => c.charCodeAt(0));
      const sizes = await E.shownPageSizes({ bytes });
      const { width: w, height: h } = sizes[2];
      const items = [
        E.shapeItem({ id: 1, page: 2, kind: 'ellipse', x1: 0.2 * w, y1: 0.2 * h, x2: 0.5 * h, y2: 0.4 * h, width: 2, color: '#d32f2f' }),
        E.shapeItem({ id: 2, page: 0, kind: 'line', x1: 10, y1: 10, x2: 100, y2: 100, width: 2, color: '#000000' }),
        // Items on pages the PDF doesn't have are left out.
        E.shapeItem({ id: 3, page: 9, kind: 'line', x1: 10, y1: 10, x2: 100, y2: 100, width: 2, color: '#000000' }),
      ];
      const r = await E.editPages({ name: 'm.pdf', bytes }, { items });
      let s = '';
      for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
      return btoa(s) + '|' + r.name;
    }, b64(mixed)).then((v) => { ok(v.endsWith('|Edited.pdf'), 'a nameless PDF is named Edited.pdf'); return v.split('|')[0]; }));
    const before = await rawPages(mixed);
    const after = await rawPages(out);
    for (const i of [1, 3]) {
      ok(after[i].raw !== null, `page ${i + 1} has one content stream still`);
      ok(after[i].raw === before[i].raw, `page ${i + 1}'s content is byte for byte the same`);
      ok(after[i].keys.join() === before[i].keys.join(), `page ${i + 1}'s resources are the same`);
    }
    ok(after[0].raw === null && after[2].raw === null, 'the edited pages got content of their own');
    const doc = await PDFDocument.load(out);
    ok(doc.getPages().map((p) => p.getRotation().angle).join() === '0,90,0,270', 'turns kept');
  }

  step('highlighter: see-through, multiplied, text stays dark');
  {
    const r = await page.evaluate(async (mixedB64) => {
      const E = await import('./js/engine/edit.js');
      const bytes = Uint8Array.from(atob(mixedB64), (c) => c.charCodeAt(0));
      const [{ width: w, height: h }] = await E.shownPageSizes({ bytes });
      // Across the first page's caption, in the middle of the page.
      const stroke = E.inkItem({ id: 1, page: 0, points: [0.25 * w, 0.5 * h - 6, 0.75 * w, 0.5 * h - 6], width: 24, color: '#ffe600', highlighter: true });
      const out = await E.editPages({ name: 'h.pdf', bytes }, { items: [stroke] });
      const { PDFDocument, PDFName, PDFDict } = await import('./js/lib/pdf-lib.js');
      const doc = await PDFDocument.load(out.bytes);
      const res = doc.getPage(0).node.Resources();
      const gs = res.lookup(PDFName.of('ExtGState'), PDFDict);
      const states = gs ? [...gs.values()].map((v) => doc.context.lookup(v)) : [];
      const multiply = states.some((s) => Number(s.get(PDFName.of('CA'))?.asNumber?.()) === 0.55 && String(s.get(PDFName.of('BM'))) === '/Multiply');
      const img = await T.render(out.bytes, 1, 2);
      const band = E.bounds(stroke);
      const inside = [];
      for (let y = Math.ceil((band.y + 2) * 2); y < (band.y + band.height - 2) * 2; y++) {
        for (let x = Math.ceil((band.x + 14) * 2); x < (band.x + band.width - 14) * 2; x++) {
          const i = (y * img.width + x) * 4;
          inside.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
        }
      }
      const paper = inside.filter((p) => p[0] > 200);
      const yellow = paper.filter((p) => p[2] >= 60 && p[2] <= 200 && p[1] > 200).length;
      const dark = inside.filter((p) => p[0] < 60 && p[1] < 60).length;
      return { multiply, inside: inside.length, paper: paper.length, yellow, dark };
    }, b64(mixed));
    ok(r.multiply, 'a see-through (0.55), multiplying graphics state');
    ok(r.paper > r.inside / 2 && r.yellow > r.paper * 0.9, `paper under it turns pale yellow (${r.yellow}/${r.paper})`);
    ok(r.dark > 200, `the caption's letters stay dark under it (${r.dark})`);
  }

  step('Hindi text stays real text');
  {
    const r = await page.evaluate(async (mixedB64) => {
      const E = await import('./js/engine/edit.js');
      const bytes = Uint8Array.from(atob(mixedB64), (c) => c.charCodeAt(0));
      const words = 'हिन्दी में लिखा गया\nSecond line';
      const [uw, uh] = await E.unitSize(words);
      const item = E.textItem({ id: 1, page: 0, x: 60, y: 120, text: words, size: 28, color: '#000000', unitWidth: uw, unitHeight: uh });
      const out = await E.editPages({ name: 'hi.pdf', bytes }, { items: [item] });
      const found = await T.text(out.bytes, 1);
      const img = await T.render(out.bytes, 1, 2);
      const ink = T.extent(img, (r, g, b) => r < 100 && g < 100 && b < 100 && true);
      return { text: found.map((f) => f.str).join(' '), firstY: found[0]?.y, box: E.bounds(item), ink, lines: found.filter((f) => /Second/.test(f.str)).map((f) => f.y) };
    }, b64(mixed));
    ok(r.text.replace(/\s+/g, ' ').includes('हिन्दी में लिखा गया'), `Hindi copies back in order: "${r.text}"`);
    ok(r.text.includes('Second line'), 'the second line too');
    ok(r.ink && r.ink[0] >= r.box.x - 1 && r.ink[1] >= r.box.y - 1, 'drawn in its box');
  }

  step('photos: upright, compressed, as JPEG; drawings keep their transparency');
  {
    const r = await page.evaluate(async () => {
      const E = await import('./js/engine/edit.js');
      // A photo stored sideways: red on its left, blue on its right, with EXIF saying "turn it right".
      const raw = await T.picture(200, 100, (g) => { g.fillStyle = '#0000ff'; g.fillRect(0, 0, 200, 100); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 100, 100); }, 'image/jpeg', 0.95);
      const sideways = T.withOrientation(raw, 6);
      const picked = await E.importPicture({ name: 'sideways.jpg', bytes: sideways });
      const { PDFDocument } = await import('./js/lib/pdf-lib.js');
      const blank = await PDFDocument.create();
      blank.addPage([595.28, 841.89]);
      const bytes = await blank.save();
      const item = E.newPicture(1, 0, picked, picked.width / picked.height, 595.28, 841.89);
      const out = await E.editPages({ name: 'p.pdf', bytes }, { items: [item] });
      const img = await T.render(out.bytes, 1, 1);
      const red = T.extent(img, (r, g, b) => r > 160 && g < 90 && b < 90);
      const blue = T.extent(img, (r, g, b) => b > 160 && r < 90);
      const facts = async (pdf) => {
        const d = await PDFDocument.load(pdf);
        const { PDFName, PDFRawStream } = await import('./js/lib/pdf-lib.js');
        const list = [];
        for (const [, obj] of d.context.enumerateIndirectObjects()) {
          if (obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image' && String(obj.dict.get(PDFName.of('ColorSpace'))) !== '/DeviceGray') {
            list.push({ filter: String(obj.dict.get(PDFName.of('Filter'))), w: obj.dict.get(PDFName.of('Width')).asNumber(), h: obj.dict.get(PDFName.of('Height')).asNumber(), smask: !!obj.dict.get(PDFName.of('SMask')), size: obj.contents.length });
          }
        }
        return list;
      };
      const photo = await facts(out.bytes);
      // A big photo is stored no larger than it needs to be: 300 dpi at the size it is drawn.
      const big = await T.picture(3000, 2000, (g) => {
        const d = g.createImageData(3000, 2000);
        for (let i = 0; i < d.data.length; i += 4) { const v = (i * 2654435761) >>> 24; d.data[i] = v; d.data[i + 1] = (v * 7) & 255; d.data[i + 2] = (v * 13) & 255; d.data[i + 3] = 255; }
        g.putImageData(d, 0, 0);
      }, 'image/jpeg', 0.98);
      const bigPicked = await E.importPicture({ name: 'big.jpg', bytes: big });
      const bigItem = E.newPicture(2, 0, bigPicked, bigPicked.width / bigPicked.height, 595.28, 841.89);
      const bigOut = await E.editPages({ name: 'p.pdf', bytes }, { items: [bigItem] });
      const bigFacts = await facts(bigOut.bytes);
      // A full-page picture is never more than 2400 pixels on its longer side.
      const full = E.pictureItem({ id: 3, page: 0, picture: bigPicked, x: 0, y: 0, width: 595, height: 397 });
      // A drawing with transparency stays lossless.
      const png = await T.picture(120, 120, (g) => { g.fillStyle = '#ff00ff'; g.fillRect(20, 20, 80, 80); });
      const drawing = await E.importPicture({ name: 'd.png', bytes: png });
      const pngOut = await E.editPages({ name: 'p.pdf', bytes }, { items: [E.newPicture(4, 0, drawing, 1, 595.28, 841.89)] });
      const notPicture = await E.importPicture({ name: 'x.png', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) });
      return {
        jpeg: picked.jpeg, w: picked.width, h: picked.height, item, red, blue, photo, bigLen: big.length, bigFacts,
        longSide: E.pdfLongSide(bigItem), fullSide: E.pdfLongSide(full), drawingJpeg: drawing.jpeg, pngFacts: await facts(pngOut.bytes), notPicture,
      };
    });
    ok(r.jpeg && r.w === 100 && r.h === 200, `a sideways photo is taken in upright (${r.w}×${r.h})`);
    ok(r.photo.length === 1 && r.photo[0].filter === '/DCTDecode' && !r.photo[0].smask && r.photo[0].h > r.photo[0].w, 'stored as JPEG, upright, no mask');
    ok(r.red && Math.abs(r.red[1] - r.item.y) <= 2, `red on top (${r.red?.[1]} vs ${r.item.y})`);
    ok(r.blue && Math.abs(r.blue[1] - (r.item.y + r.item.height / 2)) <= 5, 'blue below');
    ok(r.bigFacts.length === 1 && r.bigFacts[0].filter === '/DCTDecode' && Math.max(r.bigFacts[0].w, r.bigFacts[0].h) === r.longSide, `a big photo goes in at 300 dpi (${r.bigFacts[0]?.w} px, wanted ${r.longSide})`);
    ok(r.bigFacts[0].size < r.bigLen / 3, `and compressed (${r.bigFacts[0].size} bytes from ${r.bigLen})`);
    ok(r.fullSide === 2400, 'at most 2400 pixels on the longer side');
    ok(!r.drawingJpeg && r.pngFacts.length === 1 && r.pngFacts[0].smask && r.pngFacts[0].filter === '/FlateDecode', 'a drawing stays lossless with its transparency');
    ok(r.notPicture === null, 'a file that is no picture is refused');
  }

  step('form fields and comments under items become part of the page');
  {
    const out = fromB64(await page.evaluate(async (formB64) => {
      const E = await import('./js/engine/edit.js');
      const bytes = Uint8Array.from(atob(formB64), (c) => c.charCodeAt(0));
      const [{ height }] = await E.shownPageSizes({ bytes });
      const blue = '#1565c0';
      const items = [
        // Filled boxes over the filled-in name and over the red square comment.
        E.shapeItem({ id: 1, page: 0, kind: 'rectangle', x1: 70, y1: height - 626, x2: 330, y2: height - 598, width: 2, color: blue, filled: true }),
        E.shapeItem({ id: 2, page: 0, kind: 'rectangle', x1: 340, y1: height - 510, x2: 510, y2: height - 390, width: 2, color: blue, filled: true }),
        // An outline drawn around the city field paints nothing over it: that field stays.
        E.shapeItem({ id: 3, page: 0, kind: 'rectangle', x1: 60, y1: height - 590, x2: 335, y2: height - 556, width: 2, color: blue }),
      ];
      const r = await E.editPages({ name: 'f.pdf', bytes }, { items });
      let s = '';
      for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, b64(form)));
    await saveOutput('edit-form.pdf', out);
    const doc = await PDFDocument.load(out);
    ok(doc.getForm().getFields().map((f) => f.getName()).join() === 'city,agree', 'the name field went into the page, the others stay');
    const annots = doc.getPage(0).node.Annots();
    const subtypes = [];
    for (let i = 0; i < annots.size(); i++) subtypes.push(String(doc.context.lookup(annots.get(i)).get(PDFName.of('Subtype'))));
    ok(subtypes.join() === '/Widget,/Widget,/Text,/Popup,/Link', `the square comment went into the page (${subtypes.join()})`);
    const seen = await page.evaluate(async (outB64) => {
      const bytes = Uint8Array.from(atob(outB64), (c) => c.charCodeAt(0));
      const img = await T.render(bytes, 1, 1);
      const red = T.extent(img, T.red);
      const text = (await T.text(bytes, 1)).map((it) => it.str).join(' ');
      return { red, text };
    }, b64(out));
    ok(!seen.red, 'the comment is under the box, not over it');
    ok(seen.text.includes('Jane Doe'), 'the name is still in the file, under the box (as the app says)');
  }

  step('a PDF with a password: edited, saved without it');
  {
    const r = await page.evaluate(async (lockedB64) => {
      const E = await import('./js/engine/edit.js');
      const bytes = Uint8Array.from(atob(lockedB64), (c) => c.charCodeAt(0));
      const sizes = await E.shownPageSizes({ bytes, password: 'secret' });
      const out = await E.editPages({ name: 'locked.pdf', bytes, password: 'secret' }, { items: [E.newShape(1, 1, 'rectangle', true, 2, '#d32f2f', sizes[1].width, sizes[1].height)] });
      const img = await T.render(out.bytes, 2, 1);
      let wrong = null;
      try { await E.editPages({ name: 'locked.pdf', bytes, password: 'nope' }, { items: [E.newShape(1, 0, 'line', false, 2, '#000', 100, 100)] }); } catch (e) { wrong = e.name; }
      return { pages: sizes.length, rotation: sizes[1].rotation, red: !!T.extent(img, T.red), text: new TextDecoder('latin1').decode(out.bytes).includes('/Encrypt'), wrong };
    }, b64(locked));
    ok(r.pages === 4 && r.rotation === 90, 'its pages are read with the password');
    ok(r.red && !r.text, 'the new PDF has the box and no password');
    ok(r.wrong === 'PasswordError', 'a wrong password says so');
  }

  step('text no font draws, cancelling');
  {
    const r = await page.evaluate(async (mixedB64) => {
      const E = await import('./js/engine/edit.js');
      const bytes = Uint8Array.from(atob(mixedB64), (c) => c.charCodeAt(0));
      const res = {};
      try {
        await E.editPages({ name: 'x.pdf', bytes }, { items: [E.textItem({ id: 1, page: 0, x: 10, y: 10, text: '͸', size: 12, color: '#000', unitWidth: 1, unitHeight: 1 })] });
        res.font = 'no error';
      } catch (e) { res.font = e.key ?? e.name; }
      const controller = new AbortController();
      try {
        const items = [];
        for (let i = 0; i < 40; i++) items.push(E.newShape(i + 1, i % 4, 'ellipse', false, 2, '#000000', 400, 600));
        await E.editPages({ name: 'x.pdf', bytes }, { items }, { signal: controller.signal, onProgress: (d) => { if (d === 5) controller.abort(); } });
        res.cancel = 'no error';
      } catch (e) { res.cancel = e.name; }
      try {
        await E.editPages({ name: 'x.pdf', bytes: new Uint8Array([1, 2, 3]) }, { items: [E.newShape(1, 0, 'line', false, 2, '#000', 100, 100)] });
      } catch (e) { res.damaged = e.key ?? e.name; }
      return res;
    }, b64(mixed));
    ok(r.font === 'watermark_no_font', `text no font can draw is refused (${r.font})`);
    ok(r.cancel === 'CancelledError', `cancelling stops it (${r.cancel})`);
    ok(r.damaged === 'pdf_import_failed', `a damaged PDF says so (${r.damaged})`);
  }
}, { viewport: { width: 412, height: 915 } });

console.log(`Engine: ${checks} checks passed.`);

// =================================================================================================
// The screen
// =================================================================================================

/** Opens Edit PDF with `bytes` as the PDF, as Choose a tool hands a PDF over. */
async function openEditor(page, url, bytes, name = 'Mixed.pdf') {
  await page.goto(url + 'app/#/tool/edit');
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('.screen[data-tool="edit"]:not([aria-busy])');
  await page.evaluate(`(${pageHelpers.toString()})()`);
  await page.evaluate(async ({ data, name }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const { navigate } = await import('./js/core/router.js');
    await navigate('/tool/edit', { files: [{ name, type: 'application/pdf', size: bytes.length, lastModified: 0, bytes }], force: true });
  }, { data: b64(bytes), name });
  await page.waitForSelector('.edit-frame.is-drawn', { timeout: 30000 });
  await page.evaluate(`(${pageHelpers.toString()})()`);
  // The screen's handle, so state can be waited for without awaiting anything.
  await page.evaluate(async () => { window.__edit = (await import('./js/core/router.js')).currentHandle(); });
}

const inspect = (page) => page.evaluate(() => window.__edit.inspect());

/** Where page point (x, y) is on the screen, the page scrolled to the middle of the screen first. */
async function at(page, x, y) {
  await page.evaluate(() => {
    const r = document.querySelector('.edit-frame').getBoundingClientRect();
    if (r.top < 64 || r.bottom > innerHeight - 72) window.scrollBy(0, r.top + r.height / 2 - innerHeight / 2);
  });
  const box = await page.locator('.edit-sheet').boundingBox();
  const { size } = await inspect(page);
  return [box.x + x * box.width / size.width, box.y + y * box.height / size.height];
}

/** CSS pixels per point on the screen. */
async function scaleOf(page) {
  const box = await page.locator('.edit-sheet').boundingBox();
  const { size } = await inspect(page);
  return box.width / size.width;
}

async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** A touch dragged from `from` to `to` (CSS pixels), in steps, through Chromium's touch input. */
async function touchDrag(cdp, from, to, steps = 12) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1], id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from[0] + (to[0] - from[0]) * k, y: from[1] + (to[1] - from[1]) * k, id: 1 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function mouseDrag(page, from, to, steps = 12) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}

const tool = (page, name) => page.locator('.edit-tool', { hasText: name });

async function addShape(page, name) {
  await tool(page, 'Shape').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  await settle(page);
}

async function addText(page, text) {
  await tool(page, 'Text').click();
  const field = page.locator('dialog[open] textarea');
  await field.waitFor();
  await field.fill(text);
  await page.locator('dialog[open]').getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction((t) => window.__edit.inspect().items.some((it) => it.text === t), text);
  await settle(page);
}

/** Saves the PDF and downloads it from the result screen: its bytes. */
async function saveAndDownload(page) {
  await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
  await page.locator('.ui-result').waitFor({ timeout: 30000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save to Downloads' }).click()]);
  const path = await download.path();
  return new Uint8Array(await readFile(path));
}

/**
 * Where pixels matching `color` (a T helper's name) are on the preview of the page showing, in
 * points: what the page shows, before saving. Nothing may be chosen while it is read (the chosen
 * item's frame is red).
 */
async function previewExtent(page, color) {
  return page.evaluate(async (color) => {
    const { size } = (await import('./js/core/router.js')).currentHandle().inspect();
    const canvas = document.querySelector('.edit-canvas');
    const g = canvas.getContext('2d');
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const pxPerPoint = canvas.width / size.width;
    return T.extent({ width: img.width, height: img.height, data: img.data, scale: pxPerPoint }, T[color]);
  }, color);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const boxNear = (a, b, tol) => !!a && !!b && [0, 1, 2, 3].every((i) => near(a[i], b[i], tol));
const fmt = (a) => (a ? a.slice(0, 4).map((v) => v.toFixed(1)).join(', ') : 'none');

async function pngSquare(page) {
  return fromB64(await page.evaluate(async () => {
    const bytes = await T.picture(120, 120, (g) => { g.fillStyle = '#ff00ff'; g.fillRect(20, 20, 80, 80); });
    return btoa(String.fromCharCode(...bytes));
  }));
}

// ---- A phone, with a finger ----

step('phone: every kind added, moved, resized, recoloured and deleted with a finger');
await withPage(async (page, url, context) => {
  await openEditor(page, url, mixed);
  const cdp = await context.newCDPSession(page);
  let s = await inspect(page);
  ok(s.page === 0 && s.items.length === 0, 'opens on page 1 with nothing added');
  ok(await page.locator('.edit-hint').textContent() === 'Add text, a drawing, a shape or a picture to this page.', 'the start hint');
  ok(await page.getByRole('button', { name: 'Save PDF' }).isDisabled(), 'Save PDF is off until something is added');
  ok(await page.locator('.edit-name input').inputValue() === 'Mixed_edited', 'the file name is Mixed_edited');

  // A filled rectangle, in the middle, chosen.
  await addShape(page, 'Filled rectangle');
  s = await inspect(page);
  ok(s.items.length === 1 && s.items[0].kind === 'rectangle' && s.items[0].filled && s.selected === s.items[0].id, 'a filled rectangle, chosen');
  ok(near((s.items[0].x1 + s.items[0].x2) / 2, s.size.width / 2, 0.01), 'in the middle of the page');
  ok(await page.locator('.edit-cover').isVisible(), 'the filled box says it only covers what is under it');
  ok(await page.locator('.edit-props-title').textContent() === 'Filled rectangle', 'its controls name it');
  ok(!(await page.getByRole('button', { name: 'Save PDF' }).isDisabled()), 'Save PDF is on');
  const rect0 = s.items[0];

  // Dragged with a finger.
  const k = await scaleOf(page);
  const from = await at(page, (rect0.x1 + rect0.x2) / 2, (rect0.y1 + rect0.y2) / 2);
  await touchDrag(cdp, from, [from[0] + 40, from[1] + 60]);
  await settle(page);
  s = await inspect(page);
  const dragged = s.items[0];
  ok(near(dragged.x1 - rect0.x1, 40 / k, 1.5) && near(dragged.y1 - rect0.y1, 60 / k, 1.5), `dragged by the finger (${(dragged.x1 - rect0.x1).toFixed(1)}, ${(dragged.y1 - rect0.y1).toFixed(1)} pt)`);
  ok(s.canUndo && !s.canRedo, 'one change for Undo');
  // A tap off the items lets go; a tap on it chooses it without moving it.
  const empty = await at(page, 20, 20);
  await page.touchscreen.tap(empty[0], empty[1]);
  await settle(page);
  ok((await inspect(page)).selected === null, 'a tap elsewhere lets go');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  ok((await inspect(page)).canRedo, 'undone: Redo can bring it back');
  const centre = await at(page, (rect0.x1 + rect0.x2) / 2, (rect0.y1 + rect0.y2) / 2);
  await page.touchscreen.tap(centre[0], centre[1]);
  await settle(page);
  s = await inspect(page);
  ok(s.selected === rect0.id && boxNear([s.items[0].x1, s.items[0].y1, s.items[0].x2, s.items[0].y2], [rect0.x1, rect0.y1, rect0.x2, rect0.y2], 0.001), 'a tap chooses without moving');
  ok(s.canRedo, 'and leaves Redo as it was');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  s = await inspect(page);
  ok(near(s.items[0].x1, dragged.x1, 0.001), 'Redo moves it again');
  // A swipe that starts off the items scrolls the screen, and lets go of nothing.
  const off = await at(page, 30, 700);
  const y0 = await page.evaluate(() => scrollY);
  await touchDrag(cdp, off, [off[0], off[1] - 160], 10);
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => scrollY) > y0 + 40, 'a swipe off the items scrolls the screen');
  s = await inspect(page);
  ok(s.selected === rect0.id && near(s.items[0].x1, dragged.x1, 0.001), 'and moves or lets go of nothing');

  // Recoloured, filled off and on, moved a step, resized with the slider.
  await page.getByRole('radio', { name: 'Blue' }).click();
  s = await inspect(page);
  ok(s.items[0].color === '#1565c0' && s.style.shapeColor === '#1565c0', 'recoloured blue, and the next shape will be too');
  await page.locator('.edit-fill').click();
  ok(!(await inspect(page)).items[0].filled && !(await page.locator('.edit-cover').isVisible()), 'Filled off: an outline, and no covering note');
  ok(await page.getByRole('slider', { name: 'Thickness' }).isVisible(), 'an outline has a thickness');
  await page.locator('.edit-fill').click();
  const beforeStep = (await inspect(page)).items[0];
  await page.getByRole('button', { name: 'Move right' }).click();
  s = await inspect(page);
  ok(near(s.items[0].x1 - beforeStep.x1, 0.02 * Math.min(s.size.width, s.size.height), 0.01), 'Move right moves a step');
  const sizeSlider = page.getByRole('slider', { name: 'Size' });
  await sizeSlider.focus();
  const beforeKeys = (await inspect(page)).items[0];
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  s = await inspect(page);
  ok(s.items[0].x2 - s.items[0].x1 > beforeKeys.x2 - beforeKeys.x1, 'the size slider makes it bigger');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  s = await inspect(page);
  ok(near(s.items[0].x2 - s.items[0].x1, beforeKeys.x2 - beforeKeys.x1, 0.001), 'each step of the slider is one change for Undo');

  // Drawn with a finger, and highlighted.
  await tool(page, 'Draw').click();
  ok(await tool(page, 'Draw').getAttribute('aria-pressed') === 'true', 'Draw is on');
  ok((await page.locator('.edit-hint').textContent()).startsWith('Draw on the page'), 'the drawing hint');
  ok(await page.getByRole('slider', { name: 'Thickness' }).isVisible(), "the pen's thickness shows while drawing");
  const a = await at(page, 60, 80);
  const yDraw = await page.evaluate(() => scrollY);
  await touchDrag(cdp, a, [a[0] + 80, a[1] + 30], 16);
  await settle(page);
  ok(await page.evaluate(() => scrollY) === yDraw, 'drawing on the page does not scroll it');
  s = await inspect(page);
  const ink = s.items.find((it) => it.type === 'ink');
  ok(ink && !ink.highlighter && ink.points.length >= 8 && ink.color === '#1565c0' && near(ink.width, 2.5, 0.001), 'a pen stroke, in the pen colour and width');
  ok(s.selected === null, 'a stroke just drawn is not chosen');
  await tool(page, 'Highlight').click();
  ok(await tool(page, 'Draw').getAttribute('aria-pressed') === 'false' && await tool(page, 'Highlight').getAttribute('aria-pressed') === 'true', 'one drawing tool at a time');
  const b = await at(page, 60, 140);
  await touchDrag(cdp, b, [b[0] + 100, b[1]], 10);
  await settle(page);
  s = await inspect(page);
  const marker = s.items.find((it) => it.type === 'ink' && it.highlighter);
  ok(marker && marker.color === '#ffe600' && near(marker.width, 14, 0.001), 'a highlight, yellow and 14 pt');
  await tool(page, 'Highlight').click();
  ok((await inspect(page)).mode === 'select', 'tapped again, drawing stops');

  // Text, with Hindi; changed with Edit text.
  await addText(page, 'Hello दुनिया');
  s = await inspect(page);
  const text = s.items.find((it) => it.type === 'text');
  ok(text && s.selected === text.id && near(text.size, 14, 0.001), 'text added at 14 pt, chosen');
  ok(await page.locator('.edit-props-title').textContent() === 'Text: Hello दुनिया', 'named by its text');
  await page.getByRole('button', { name: 'Edit text' }).click();
  await page.locator('dialog[open] textarea').fill('Hello again\nSecond line');
  await page.locator('dialog[open]').getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction(() => window.__edit.inspect().items.some((it) => it.text === 'Hello again\nSecond line'));
  s = await inspect(page);
  ok(s.items.find((it) => it.type === 'text').unitHeight > text.unitHeight * 1.5, 'two lines are taller');
  // Text no font can draw: Done stays off and says why.
  await tool(page, 'Text').click();
  await page.locator('dialog[open] textarea').fill('͸');
  ok(await page.locator('dialog[open]').getByRole('button', { name: 'Done', exact: true }).isDisabled(), 'Done is off for text no font draws');
  ok((await page.locator('dialog[open] .ui-field-support').textContent()).includes('no font'), 'and the field says why');
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });

  // A picture from the device, resized with its handle.
  const png = await pngSquare(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), tool(page, 'Picture').click()]);
  await chooser.setFiles({ name: 'square.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await page.waitForFunction(() => window.__edit.inspect().items.some((it) => it.type === 'picture'));
  await settle(page);
  s = await inspect(page);
  const pic = s.items.find((it) => it.type === 'picture');
  ok(pic && s.selected === pic.id && near(pic.width, s.size.width / 2, 0.01) && near(pic.width, pic.height, 0.01), 'a picture, half the page wide, chosen');
  const corner = await at(page, pic.x + pic.width, pic.y + pic.height);
  await touchDrag(cdp, corner, [corner[0] - 30, corner[1] - 30], 8);
  await settle(page);
  s = await inspect(page);
  const smaller = s.items.find((it) => it.type === 'picture');
  ok(smaller.width < pic.width - 10 && near(smaller.width, smaller.height, 0.01) && near(smaller.x, pic.x, 0.01), `its handle makes it smaller, keeping its shape (${smaller.width.toFixed(1)} pt)`);
  // Deleted, and back with Undo.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  ok(!(await inspect(page)).items.some((it) => it.type === 'picture'), 'deleted');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  ok((await inspect(page)).items.some((it) => it.type === 'picture'), 'back with Undo');

  // Every shape.
  for (const name of ['Rectangle', 'Ellipse', 'Line', 'Arrow']) await addShape(page, name);
  s = await inspect(page);
  ok(['rectangle', 'ellipse', 'line', 'arrow'].every((kind) => s.items.some((it) => it.kind === kind && !it.filled)), 'rectangle, ellipse, line and arrow added');
  ok(s.items.filter((it) => it.type === 'shape').every((it) => it.color === '#1565c0'), 'in the colour last chosen');
  // A line's thickness: each key press one change.
  const line = s.items.find((it) => it.kind === 'line');
  await page.keyboard.press('Escape');
  // Chosen through its button, as a screen reader would (the arrow lies over it on the page).
  await page.locator('.edit-node[aria-label="Line"]').focus();
  await page.keyboard.press('Enter');
  await settle(page);
  s = await inspect(page);
  if (s.items.find((it) => it.id === s.selected)?.kind === 'line') {
    await page.getByRole('slider', { name: 'Thickness' }).focus();
    await page.keyboard.press('ArrowRight');
    ok((await inspect(page)).items.find((it) => it.id === line.id).width > line.width, 'the thickness slider makes the line thicker');
  } else {
    ok(false, `tapping the line chooses it (chose ${s.selected})`);
  }

  // Another page: the strip, and the page's own items.
  await page.getByRole('radio', { name: 'Page 2' }).click();
  s = await inspect(page);
  ok(s.page === 1 && near(s.size.width, 841.89, 0.01) && near(s.size.height, 595.28, 0.01), 'page 2 shows turned sideways');
  ok(await page.getByRole('radio', { name: 'Page 1' }).getAttribute('aria-describedby') !== null, 'page 1 is marked edited');
  ok(await page.locator('.edit-hint').textContent() === 'Add text, a drawing, a shape or a picture to this page.', 'page 2 has nothing yet');
  ok(await page.locator('.edit-pagenav .edit-nav-label').textContent() === 'Page 2 of 4', 'Page 2 of 4');
  // Undo shows the page its change was on.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  ok((await inspect(page)).page === 0, 'Undo goes to the page of the change');

  await page.screenshot({ path: join(outputDir, 'edit-phone-items.png') });
  ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 360, 'nothing scrolls sideways at 360 px');

  // Leaving with additions asks first.
  await page.getByRole('button', { name: 'Back', exact: true }).first().click();
  await page.locator('dialog[open]').getByText('Discard your changes?').waitFor();
  await page.locator('dialog[open]').getByRole('button', { name: 'Keep' }).click();
  ok(await page.locator('.edit-frame').isVisible(), 'Keep stays');
}, { viewport: { width: 360, height: 780 } });

// ---- A computer, with a mouse and keys; the saved PDF against the preview ----

step('desktop: mouse, keys, zoom, and the saved PDF where the preview showed it');
await withPage(async (page, url) => {
  await openEditor(page, url, mixed);
  // Page 1 (upright): a red filled box, dragged with the mouse, its corner dragged bigger.
  await addShape(page, 'Filled rectangle');
  let s = await inspect(page);
  const r0 = s.items[0];
  const mid = await at(page, (r0.x1 + r0.x2) / 2, (r0.y1 + r0.y2) / 2);
  await mouseDrag(page, mid, [mid[0] - 50, mid[1] - 80]);
  s = await inspect(page);
  const corner = await at(page, s.items[0].x2, s.items[0].y2);
  await mouseDrag(page, corner, [corner[0] + 30, corner[1] + 20]);
  s = await inspect(page);
  const r1 = s.items[0];
  ok(r1.x1 < r0.x1 - 20 && r1.x2 - r1.x1 > r0.x2 - r0.x1 + 20, 'moved and made bigger with the mouse');
  // Keys: arrows nudge (Shift a point), Delete removes, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, Escape lets go.
  await page.keyboard.press('ArrowDown');
  s = await inspect(page);
  ok(near(s.items[0].y1 - r1.y1, 0.02 * Math.min(s.size.width, s.size.height), 0.01), 'ArrowDown moves a step');
  await page.keyboard.press('Shift+ArrowLeft');
  ok(near((await inspect(page)).items[0].x1, r1.x1 - 1, 0.01), 'Shift+ArrowLeft moves a point');
  await page.keyboard.press('Delete');
  ok((await inspect(page)).items.length === 0, 'Delete removes it');
  await page.keyboard.press('Control+z');
  ok((await inspect(page)).items.length === 1, 'Ctrl+Z brings it back');
  await page.keyboard.press('Control+y');
  ok((await inspect(page)).items.length === 0, 'Ctrl+Y removes it again');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  ok(near((await inspect(page)).items[0].x1, r1.x1 - 1, 0.01), 'Ctrl+Shift+Z redoes');
  await page.keyboard.press('Escape');
  ok((await inspect(page)).selected === null, 'Escape lets go');
  // The keyboard alone: the item is a button, Enter chooses it.
  await page.locator('.edit-node').first().focus();
  await page.keyboard.press('Enter');
  ok((await inspect(page)).selected !== null, 'an item found with the keyboard is chosen with Enter');
  ok(await page.locator('.edit-node').first().getAttribute('aria-label') === 'Filled rectangle', 'named for screen readers');
  ok(await page.locator('.edit-node').first().getAttribute('aria-pressed') === 'true', 'and says it is chosen');
  const keyed = (await inspect(page)).items[0];
  await page.keyboard.press('ArrowRight');
  ok((await inspect(page)).items[0].x1 > keyed.x1, 'its arrow keys move it');
  ok(await page.evaluate(() => document.activeElement?.classList.contains('edit-node')), 'and it keeps the focus');

  // Zoomed in, a drag moves as far on the page as the mouse does on the zoomed page.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  s = await inspect(page);
  ok(near(s.zoom, 2, 0.001), 'zoomed to 200%');
  ok(await page.locator('.edit-zoom-label').textContent() === '200%', 'and says so');
  const before = s.items[0];
  const bmid = await at(page, (before.x1 + before.x2) / 2, (before.y1 + before.y2) / 2);
  await page.evaluate(([x, y]) => {
    // Scrolled so the box shows.
    const v = document.querySelector('.edit-viewport');
    const r = v.getBoundingClientRect();
    v.scrollLeft += x - (r.left + r.width / 2);
    v.scrollTop += y - (r.top + r.height / 2);
  }, bmid);
  await settle(page);
  const k2 = await scaleOf(page);
  const m2 = await at(page, (before.x1 + before.x2) / 2, (before.y1 + before.y2) / 2);
  await mouseDrag(page, m2, [m2[0] + 40, m2[1]]);
  s = await inspect(page);
  ok(near(s.items[0].x1 - before.x1, 40 / k2, 1), `at 200%, 40 px is ${(40 / k2).toFixed(1)} pt (${(s.items[0].x1 - before.x1).toFixed(1)})`);
  // Ctrl and the wheel zoom too.
  const vbox = await page.locator('.edit-viewport').boundingBox();
  await page.mouse.move(vbox.x + vbox.width / 2, vbox.y + vbox.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Control');
  await settle(page);
  ok((await inspect(page)).zoom < 2, 'Ctrl and the wheel zoom out');
  for (let i = 0; i < 6; i++) if (!(await page.getByRole('button', { name: 'Zoom out' }).isDisabled())) await page.getByRole('button', { name: 'Zoom out' }).click();
  ok(near((await inspect(page)).zoom, 1, 0.001), 'back to 100%');

  // Page 2 (turned): a blue stroke drawn with the mouse, a green arrow.
  await page.getByRole('radio', { name: 'Page 2' }).click();
  await settle(page);
  await tool(page, 'Draw').click();
  const p2 = await at(page, 300, 100);
  await mouseDrag(page, p2, [p2[0] + 120, p2[1] + 60], 20);
  await tool(page, 'Draw').click();
  await addShape(page, 'Arrow');
  await page.getByRole('radio', { name: 'Green' }).click();
  await page.keyboard.press('Escape');
  // Page 3 (cropped): a red filled box.
  await page.getByRole('radio', { name: 'Page 3' }).click();
  await settle(page);
  await addShape(page, 'Filled rectangle');
  await page.getByRole('radio', { name: 'Red' }).click();
  await page.keyboard.press('Escape');
  await settle(page);

  // What the preview shows of each page, then the saved PDF.
  const preview = {};
  for (const [n, colors] of [[1, ['red']], [2, ['blue', 'green']], [3, ['red']]]) {
    await page.getByRole('radio', { name: `Page ${n}` }).click();
    await page.keyboard.press('Escape');
    await settle(page);
    await page.waitForTimeout(150);
    preview[n] = {};
    for (const c of colors) preview[n][c] = await previewExtent(page, c);
  }
  await page.screenshot({ path: join(outputDir, 'edit-desktop-items.png') });
  const saved = await saveAndDownload(page);
  await saveOutput('edit-desktop-saved.pdf', saved);
  ok(await page.locator('.ui-result-heading').textContent() === 'Your PDF is ready', 'the result screen');
  for (const n of [1, 2, 3]) {
    for (const [c, want] of Object.entries(preview[n])) {
      const got = await page.evaluate(async ({ data, n, c }) => {
        const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
        return T.extent(await T.render(bytes, n, 2), T[c]);
      }, { data: b64(saved), n, c });
      ok(boxNear(got, want, 2), `page ${n}: ${c} in the PDF (${fmt(got)}) where the preview showed it (${fmt(want)})`);
    }
  }
  const raw = await rawPages(saved);
  const orig = await rawPages(mixed);
  ok(raw[3].raw === orig[3].raw, 'page 4, not changed, is byte for byte the same');
  // Back to editing keeps the items.
  await page.getByRole('button', { name: 'Back to editing' }).click();
  await page.locator('.edit-frame').waitFor();
  ok((await inspect(page)).items.length === 4, 'back to editing, the items are still there');
}, { viewport: { width: 1366, height: 768 } });

// ---- A PDF with a password, picked with the file picker ----

step('a PDF with a password, picked: asked for, edited, saved without it');
await withPage(async (page, url) => {
  await page.goto(url + 'app/#/tool/edit');
  await page.waitForSelector('.screen[data-tool="edit"]:not([aria-busy])');
  await page.evaluate(`(${pageHelpers.toString()})()`);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.ui-empty').click()]);
  await chooser.setFiles({ name: 'Locked.pdf', mimeType: 'application/pdf', buffer: Buffer.from(locked) });
  await page.locator('dialog[open] input[type="password"]').fill('secret');
  await page.locator('dialog[open]').getByRole('button', { name: 'Open PDF' }).click();
  await page.waitForSelector('.edit-frame.is-drawn', { timeout: 30000 });
  await page.evaluate(async () => { window.__edit = (await import('./js/core/router.js')).currentHandle(); });
  ok(await page.locator('.edit-name input').inputValue() === 'Locked_edited', 'named after the PDF');
  await addShape(page, 'Arrow');
  await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
  await page.locator('.ui-result').waitFor({ timeout: 30000 });
  ok(await page.getByText('The new PDF has no password.').isVisible(), 'the result says the new PDF has no password');
  // Start over asks first while the PDF isn't saved, then shows "Choose PDF" again.
  await page.getByRole('button', { name: 'Start over' }).click();
  await page.locator('dialog[open]').getByRole('button').last().click();
  await page.locator('.ui-empty').waitFor();
  ok((await page.locator('.edit-frame').count()) === 0, 'started over');
}, { viewport: { width: 1280, height: 800 } });

// ---- The browser's Back: the result is a step; leaving closes a password dialog ----

for (const browser of quick ? ['chromium'] : ['chromium', 'firefox', 'webkit']) {
  step(`${browser}: the browser's Back: from the result to editing; leaving while a password is asked`);
  await withPage(async (page, url) => {
    await openEditor(page, url, mixed);
    await addShape(page, 'Arrow');
    await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
    await page.locator('.ui-result').waitFor({ timeout: 30000 });
    ok(await page.evaluate(() => history.state?.step) === 'result', 'the result is a step in the history');
    await page.goBack();
    await page.locator('.edit-frame').waitFor();
    ok((await page.locator('.ui-result').count()) === 0, "the browser's Back leaves the result");
    ok(await page.evaluate(() => location.hash) === '#/tool/edit', 'still on Edit PDF');
    ok((await inspect(page)).items.length === 1, 'back to editing, the arrow kept');
    // A PDF with a password handed over from Home: the browser's Back while it is asked for closes
    // the dialog with the screen.
    await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/'));
    await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
    await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const { navigate } = await import('./js/core/router.js');
      await navigate('/tool/edit', { files: [{ name: 'Locked.pdf', type: 'application/pdf', size: bytes.length, lastModified: 0, bytes }] });
    }, b64(locked));
    await page.locator('dialog[open] input[type="password"]').waitFor();
    await page.goBack();
    await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
    await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
    await page.waitForTimeout(300);
    ok((await page.locator('.screen[data-tool="edit"]').count()) === 0 && !(await page.$('dialog[open]')), `${browser}: the password dialog went with the screen`);
  }, { browser, viewport: { width: 412, height: 915 } });
}

// ---- Screenshots: phone and desktop, light and dark ----

step('screenshots');
for (const [w, hgt, label] of [[360, 780, 'phone'], [1366, 768, 'desktop']]) {
  for (const scheme of ['light', 'dark']) {
    await withPage(async (page, url) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(url + 'app/#/tool/edit');
      await page.waitForSelector('.screen[data-tool="edit"]:not([aria-busy])');
      await page.screenshot({ path: join(outputDir, `edit-${label}-${scheme}-empty.png`) });
      await openEditor(page, url, mixed);
      await addShape(page, 'Filled rectangle');
      await addText(page, 'Hello दुनिया');
      await page.getByRole('button', { name: 'Move up' }).click();
      await page.getByRole('button', { name: 'Move up' }).click();
      await settle(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(outputDir, `edit-${label}-${scheme}.png`), fullPage: w < 700 });
      ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= w, `${label} ${scheme}: nothing scrolls sideways`);
      // Zoomed in, the part showing drawn sharp; then drawing, with the pen's controls.
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
      await page.locator('.edit-frame').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(outputDir, `edit-${label}-${scheme}-zoom.png`) });
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
      await tool(page, 'Draw').click();
      const p = await at(page, 120, 120);
      await mouseDrag(page, p, [p[0] + 60, p[1] + 40], 12);
      await page.locator('.edit-frame').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await settle(page);
      await page.screenshot({ path: join(outputDir, `edit-${label}-${scheme}-draw.png`) });
    }, { viewport: { width: w, height: hgt } });
  }
}

// ---- Firefox and WebKit ----

if (!quick) {
  for (const browser of ['firefox', 'webkit']) {
    step(`${browser}: add, draw, type, save`);
    await withPage(async (page, url) => {
      await openEditor(page, url, mixed);
      await addShape(page, 'Filled rectangle');
      await page.getByRole('radio', { name: 'Green' }).click();
      await page.keyboard.press('Escape');
      await tool(page, 'Draw').click();
      const p = await at(page, 80, 600);
      await mouseDrag(page, p, [p[0] + 100, p[1] + 20], 10);
      await tool(page, 'Draw').click();
      await addText(page, 'Hello दुनिया');
      const s = await inspect(page);
      ok(s.items.length === 3, `${browser}: three items`);
      await page.keyboard.press('Escape');
      await settle(page);
      const want = await previewExtent(page, 'green');
      const saved = await saveAndDownload(page);
      const r = await page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        return { green: T.extent(await T.render(bytes, 1, 2), T.green), text: (await T.text(bytes, 1)).map((x) => x.str).join(' ') };
      }, b64(saved));
      ok(boxNear(r.green, want, 2.5), `${browser}: the box where the preview showed it (${fmt(r.green)} vs ${fmt(want)})`);
      ok(r.text.includes('Hello') && r.text.includes('दुनिया'), `${browser}: the text is real text`);
    }, { browser, viewport: { width: 1280, height: 800 } });
  }
}

console.log(`All ${checks} Edit PDF checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
