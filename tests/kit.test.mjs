// The UI kit (core/ui.js, files.js, pdfdoc.js, pagegrid.js, output.js, batch.js): its components
// mounted in a page and driven with clicks, keys and touches, at phone and desktop sizes, plus a
// look in Firefox and WebKit. Run with: node tests/kit.test.mjs
// Screenshots go to .tmp/kit/screens/ to be looked at.
import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { withPage, assert, root } from './harness.mjs';
import { PDFDocument, PDFName, PDFNumber, PDFDict, rgb, degrees, StandardFonts } from '../site/app/vendor/pdf-lib/pdf-lib.esm.min.js';
import { zipSync, unzipSync, strToU8 } from '../site/app/vendor/fflate/fflate.esm.js';

const shots = join(root, '.tmp', 'kit', 'screens');
await mkdir(shots, { recursive: true });
const appAssets = 'C:/Users/Nathan/OneDrive/Desktop/pdfer/app/src/androidTest/assets';

const exists = (p) => access(p).then(() => true, () => false);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 900 };

// ---------------------------------------------------------------------------------------------
// Fixtures

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([p.w, p.h]);
    if (p.color) page.drawRectangle({ x: p.w * 0.1, y: p.h * 0.1, width: p.w * 0.8, height: p.h * 0.8, color: p.color });
    if (p.text) page.drawText(p.text, { x: 20, y: p.h - 60, size: Math.min(48, p.w / 4), font, color: rgb(0, 0, 0) });
    if (p.rotate) page.setRotation(degrees(p.rotate));
  }
  return doc.save();
}

async function fixtures() {
  const plain = await makePdf([
    { w: 595, h: 842, color: rgb(1, 0, 0), text: 'One' },
    { w: 842, h: 595, color: rgb(0, 0.6, 0), text: 'Two', rotate: 90 },
    { w: 612, h: 792, color: rgb(0, 0, 1), text: 'Three' },
  ]);
  const hues = [rgb(0.9, 0.2, 0.2), rgb(0.2, 0.6, 0.2), rgb(0.2, 0.3, 0.9), rgb(0.9, 0.7, 0.1)];
  const many = await makePdf(Array.from({ length: 60 }, (_, i) => ({ w: 300, h: 400, color: hues[i % 4], text: String(i + 1) })));
  const encDoc = await PDFDocument.create();
  encDoc.addPage([300, 400]).drawRectangle({ x: 0, y: 0, width: 300, height: 400, color: rgb(1, 0, 0) });
  encDoc.addPage([300, 400]);
  await encDoc.encrypt({ userPassword: 'test123', ownerPassword: 'owner123' });
  const encrypted = await encDoc.save();
  const protectedPdf = (await exists(join(appAssets, 'protected.pdf'))) ? new Uint8Array(await readFile(join(appAssets, 'protected.pdf'))) : null;
  const certificate = (await exists(join(appAssets, 'certificate.pdf'))) ? new Uint8Array(await readFile(join(appAssets, 'certificate.pdf'))) : null;
  const damaged = strToU8('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\ngarbage that is not a PDF at all\n%%EOF');

  const ct = (main, extra = '') => strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${extra}<Default Extension="xml" ContentType="application/xml"/><Override PartName="/main.xml" ContentType="${main}"/></Types>`);
  const docx = zipSync({
    '[Content_Types].xml': ct('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      // An embedded chart's workbook is listed too; only the main part counts.
      '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'),
    'word/document.xml': strToU8('<w:document/>'),
    'word/embeddings/chart.xlsx': strToU8('x'),
  });
  const pptx = zipSync({ '[Content_Types].xml': ct('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'), 'ppt/presentation.xml': strToU8('<p/>') });
  const xlsx = zipSync({ '[Content_Types].xml': ct('application/vnd.ms-excel.sheet.macroEnabled.main+xml'), 'xl/workbook.xml': strToU8('<w/>') });
  const epub = zipSync({ mimetype: [strToU8('application/epub+zip'), { level: 0 }], 'META-INF/container.xml': strToU8('<container/>'), 'OEBPS/book.opf': strToU8('<package/>') });
  const bare = zipSync({ 'word/document.xml': strToU8('<w:document/>') });
  const other = zipSync({ 'notes.txt': strToU8('hello') });
  const images = {};
  for (const n of ['clear.webp', 'photo.webp', 'drawing.bmp', 'drawing.gif', 'turned.avif', 'turned.heic']) {
    const p = join(appAssets, 'images', n);
    if (await exists(p)) images[n] = new Uint8Array(await readFile(p));
  }
  return { plain, many, encrypted, protectedPdf, certificate, damaged, docx, pptx, xlsx, epub, bare, other, images, miscounted: await miscountedPdf(), marked: await markedPdf() };
}

/** Three pages (red, green, blue) under a page tree that says it holds five: the tools find three. */
async function miscountedPdf() {
  const doc = await PDFDocument.create();
  for (const color of [rgb(1, 0, 0), rgb(0, 0.6, 0), rgb(0, 0, 1)]) {
    doc.addPage([300, 400]).drawRectangle({ x: 0, y: 0, width: 300, height: 400, color });
  }
  doc.catalog.lookup(PDFName.of('Pages'), PDFDict).set(PDFName.of('Count'), PDFNumber.of(5));
  return doc.save({ useObjectStreams: false });
}

/**
 * A red page carrying Usugami's mark as PageMark.kt adds it: a "q" stream before the page's own
 * content and one after it that draws the mark's form (here a black square in the bottom-right
 * corner, x 190-290, y 10-110), each marked /UsugamiMark, and the form in the page's resources.
 */
async function markedPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  page.drawRectangle({ x: 0, y: 0, width: 300, height: 400, color: rgb(1, 0, 0) });
  const ctx = doc.context;
  const N = (s) => PDFName.of(s);
  const form = ctx.register(ctx.stream('0 g 0 0 1 1 re f\n', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], UsugamiMark: true }));
  const before = ctx.register(ctx.stream('q\n', { UsugamiMark: true }));
  const was = page.node.get(N('Contents'));
  const marker = ctx.obj({ Size: 10, Opacity: 100, Matrix: [100, 0, 0, 100, 190, 10], Name: N('UsugamiMark'), MadeXObjects: true });
  if (was) marker.set(N('Was'), was);
  const after = ctx.register(ctx.stream('Q\nq\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC\n100 0 0 100 190 10 cm\n/UsugamiMark Do\nEMC\nQ\n', { UsugamiMark: marker }));
  const own = was ? (was.asArray ? was.asArray() : [was]) : [];
  page.node.set(N('Contents'), ctx.obj([before, ...own, after]));
  const resources = page.node.Resources() ?? ctx.obj({});
  resources.set(N('XObject'), ctx.obj({ UsugamiMark: form }));
  page.node.set(N('Resources'), resources);
  return doc.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------------------------------------
// The test page: the site's styles and the kit, with the shell's strings loaded as at start.

const TEST_PAGE = `<!doctype html>
<html lang="en" dir="ltr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kit test</title>
<link rel="stylesheet" href="../assets/css/tokens.css">
<link rel="stylesheet" href="css/app.css">
<link rel="stylesheet" href="css/components.css">
</head><body><div id="root" class="page"></div>
<script type="module">
  const { initI18n, loadStrings } = await import('./js/core/i18n.js');
  await initI18n();
  await loadStrings('kit');
  const names = ['ui', 'files', 'pdfdoc', 'pagegrid', 'output', 'batch', 'errors', 'dom', 'i18n'];
  const mods = await Promise.all(names.map((n) => import('./js/core/' + n + '.js')));
  window.kit = Object.fromEntries(names.map((n, i) => [n, mods[i]]));
  window.fx = {};
  window.log = [];
  window.bytesOf = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  window.b64Of = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  window.mount = (node) => { const r = document.getElementById('root'); r.replaceChildren(node); return node; };
  window.snacks = () => [...document.querySelectorAll('.ui-snackbar .ui-snackbar-text')].map((n) => n.textContent);
  window.kitReady = true;
</script></body></html>`;

async function openKit(page, url) {
  await page.route('**/app/kit-test.html', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: TEST_PAGE }));
  await page.goto(url + 'app/kit-test.html');
  await page.waitForFunction(() => window.kitReady === true);
}

async function put(page, fx) {
  for (const [k, v] of Object.entries(fx)) {
    if (v instanceof Uint8Array) await page.evaluate(([k, s]) => { window.fx[k] = window.bytesOf(s); }, [k, b64(v)]);
  }
  for (const [k, v] of Object.entries(fx.images ?? {})) await page.evaluate(([k, s]) => { window.fx['img_' + k] = window.bytesOf(s); }, [k, b64(v)]);
}

/** Waits until the snackbars on screen include one containing `text`. */
async function snackWith(page, text, timeout = 15000) {
  await page.waitForFunction((t) => window.snacks().some((s) => s.includes(t)), text, { timeout });
}

async function clearSnacks(page) {
  await page.evaluate(() => document.querySelectorAll('.ui-snackbar').forEach((n) => n.dismiss?.()));
  await page.waitForTimeout(200);
}

const check = (name, cond, detail = '') => assert(cond, name + (detail ? ` (${detail})` : ''));

// ---------------------------------------------------------------------------------------------
// files.js

async function testFiles(page, fx) {
  const r = await page.evaluate(() => {
    const { fileKind, imageType, kindOfType, kindOfName, chosenKind } = kit.files;
    const k = (name, bytes, type = '') => fileKind({ name, type, bytes });
    const s = (t) => new TextEncoder().encode(t);
    const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { out.set(x, i); i += x.length; } return out; };
    const ftyp = (major, ...compat) => {
      const size = 16 + 4 * compat.length;
      return cat(new Uint8Array([0, 0, 0, size]), s('ftyp' + major), new Uint8Array(4), s(compat.join('')), new Uint8Array(8));
    };
    const latin = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0));
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
    const out = {
      pdf: k('x.bin', fx.plain),
      pdfJunk: k('noname', cat(s('junk before the header\n'), fx.plain)),
      pdfAsPng: k('p.png', fx.plain, 'image/png'),
      pngNamedPdf: k('photo.pdf', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
      docx: k('report.zip', fx.docx),
      pptx: k('deck.bin', fx.pptx),
      xlsx: k('x', fx.xlsx),
      epub: k('book.zip', fx.epub),
      bare: k('noct.zip', fx.bare),
      otherZip: k('stuff.zip', fx.other),
      otherZipNamedDocx: k('a.docx', fx.other),
      damagedZip: k('b.pptx', cat(new Uint8Array([0x50, 0x4b, 3, 4]), s('garbage'))),
      oleDoc: k('old.doc', ole), oleXls: k('old.xls', ole), olePpt: k('old.ppt', ole), oleType: k('x', ole, 'application/msword'),
      text: k('notes.txt', s('hello')), textPdfName: k('x.pdf', s('hello')),
      byType: k('download', s('???'), 'application/epub+zip'),
      empty: k('', new Uint8Array(0)),
      // ImageFileTypeTest.picturesAreToldByTheirFirstBytes
      jpeg: imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
      png: imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
      webp: imageType(latin('RIFF\0\0\0\0WEBPVP8 ')),
      gif: imageType(latin('GIF89a\u0001\0')),
      bmp: imageType(latin('BM\0\0\0\0\0\0\0\0' + '6\0\0\0(\0\0\0')),
      heic: imageType(ftyp('heic', 'mif1', 'heic')),
      mif1: imageType(ftyp('mif1', 'mif1')),
      avif: imageType(ftyp('avif', 'avif', 'mif1', 'miaf', 'MA1B')),
      avifCompat: imageType(ftyp('mif1', 'mif1', 'avif')),
      // ImageFileTypeTest.otherFilesAreNone
      none: [imageType(new Uint8Array(0)), imageType(ftyp('isom', 'isom', 'iso2', 'mp41')), imageType(latin('RIFF\0\0\0\0WAVEfmt ')),
        imageType(s('BMW cars and other things')), imageType(latin('II*\0\u0008\0\0\0')), imageType(cat(new Uint8Array([0x7f, 0xff, 0xff, 0xff]), s('ftypisom')))],
      heifKind: k('IMG_1.HEIC', ftyp('heic', 'mif1', 'heic')),
      // SharedFilesTest
      types: [kindOfType('application/pdf'), kindOfType('application/x-pdf'), kindOfType('image/jpeg'), kindOfType('image/heic'),
        kindOfType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), kindOfType('application/vnd.ms-word.document.macroEnabled.12'),
        kindOfType('application/msword'), kindOfType('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
        kindOfType('application/vnd.ms-powerpoint'), kindOfType('application/epub+zip'),
        kindOfType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), kindOfType('application/vnd.ms-excel'),
        kindOfType('text/plain'), kindOfType(null), kindOfType(' Application/PDF '), kindOfType('application/pdf; name="Report.pdf"'),
        kindOfType('APPLICATION/EPUB+ZIP'), kindOfType('application/octet-stream')],
      names: [kindOfName('Book.epub'), kindOfName('Report.DOCX'), kindOfName('Talk.pptx'), kindOfName('scan.final.pdf'), kindOfName('IMG_1234.JPG'),
        kindOfName('old.doc'), kindOfName('Budget.XLSX'), kindOfName('old.xls'), kindOfName('notes.txt'), kindOfName('README')],
      chosen: [chosenKind(['pdf']), chosenKind(['docx', 'pdf', 'docx', 'other']), chosenKind(['image', 'image', 'pdf', 'epub', 'other', 'other', 'other']),
        chosenKind(['other', 'epub']), chosenKind(['image', 'pdf']), chosenKind(['docx', 'pdf', 'docx', 'pdf']), chosenKind(['epub', 'image']),
        chosenKind(['pptx', 'docx', 'epub']), chosenKind(['epub', 'pptx']), chosenKind(['xlsx', 'epub']), chosenKind([]), chosenKind(['other', 'other'])],
      real: Object.fromEntries(Object.keys(fx).filter((n) => n.startsWith('img_')).map((n) => [n, [k(n.slice(4).replace(/\.\w+$/, ''), fx[n]), imageType(fx[n])]])),
    };
    return out;
  });
  const want = {
    pdf: 'pdf', pdfJunk: 'pdf', pdfAsPng: 'pdf', pngNamedPdf: 'image', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', epub: 'epub', bare: 'docx',
    otherZip: 'other', otherZipNamedDocx: 'docx', damagedZip: 'pptx', oleDoc: 'docx', oleXls: 'xlsx', olePpt: 'pptx', oleType: 'docx',
    text: 'other', textPdfName: 'pdf', byType: 'epub', empty: 'other',
    jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp', heic: 'heif', mif1: 'heif', avif: 'avif', avifCompat: 'avif', heifKind: 'image',
  };
  for (const [key, value] of Object.entries(want)) check(`fileKind/imageType ${key}`, r[key] === value, `got ${r[key]}`);
  check('imageType of other files is null', r.none.every((x) => x === null), JSON.stringify(r.none));
  check('kindOfType', JSON.stringify(r.types) === JSON.stringify(['pdf', 'pdf', 'image', 'image', 'docx', 'docx', 'docx', 'pptx', 'pptx', 'epub', 'xlsx', 'xlsx', null, null, 'pdf', 'pdf', 'epub', null]), JSON.stringify(r.types));
  check('kindOfName', JSON.stringify(r.names) === JSON.stringify(['epub', 'docx', 'pptx', 'pdf', 'image', 'docx', 'xlsx', 'xlsx', null, null]), JSON.stringify(r.names));
  check('chosenKind', JSON.stringify(r.chosen) === JSON.stringify(['pdf', 'docx', 'image', 'epub', 'pdf', 'pdf', 'image', 'docx', 'pptx', 'epub', null, null]), JSON.stringify(r.chosen));
  const realWant = { img_clear: 'webp', img_photo: 'webp', img_drawing: null };
  for (const [n, [kind, type]] of Object.entries(r.real)) {
    check(`app test image ${n} is an image`, kind === 'image', kind);
    if (n.includes('avif')) check('turned.avif is AVIF', type === 'avif', type);
    if (n.includes('heic')) check('turned.heic is HEIF', type === 'heif', type);
    if (n.includes('bmp')) check('drawing.bmp is BMP', type === 'bmp', type);
    if (n.includes('gif')) check('drawing.gif is GIF', type === 'gif', type);
    if (n.includes('webp')) check(`${n} is WebP`, type === 'webp', type);
  }
  void realWant;

  // Images: the picker offers Images to PDF's types, HEIC, HEIF and AVIF among them, after image/*.
  const imageAccept = await page.evaluate(() => kit.files.ACCEPT.image);
  check('ACCEPT.image names HEIC, HEIF and AVIF', imageAccept.startsWith('image/*,') && ['image/heic', 'image/heif', 'image/avif', '.heic', '.heif', '.avif', '.jpg', 'image/webp'].every((x) => imageAccept.split(',').includes(x)), imageAccept);
  await testPick(page, fx);
}

/**
 * pickFiles through the real <input type=file> (the browser's file chooser): the accept list,
 * several files, the camera and, with `cancel`, a cancelled pick.
 */
async function testPick(page, fx, { cancel = true } = {}) {
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'pick';
    b.textContent = 'pick';
    b.onclick = () => { window.picked = kit.files.pickFiles(window.pickOptions); };
    document.body.prepend(b);
  });
  // One file, as most tools pick.
  await page.evaluate(() => { window.pickOptions = { accept: 'pdf' }; });
  let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#pick')]);
  check('pickFiles one', !chooser.isMultiple());
  await chooser.setFiles([{ name: 'Only.pdf', mimeType: 'application/pdf', buffer: Buffer.from(fx.plain) }]);
  let picked = await page.evaluate(async () => (await window.picked).map((f) => ({ name: f.name, size: f.size, kind: kit.files.fileKind(f) })));
  check('a file picked through the input arrives', picked.length === 1 && picked[0].name === 'Only.pdf' && picked[0].size === fx.plain.length && picked[0].kind === 'pdf', JSON.stringify(picked));

  await page.evaluate(() => { window.pickOptions = { accept: 'pdf', multiple: true }; });
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#pick')]);
  check('pickFiles multiple', chooser.isMultiple());
  const accept = await chooser.element().evaluate((i) => i.accept);
  check('pickFiles accept for pdf', accept.includes('application/pdf') && accept.includes('.pdf'), accept);
  await chooser.setFiles([
    { name: 'One.pdf', mimeType: 'application/pdf', buffer: Buffer.from(fx.plain) },
    { name: 'Two.docx', mimeType: '', buffer: Buffer.from(fx.docx) },
  ]);
  picked = await page.evaluate(async () => (await window.picked).map((f) => ({ name: f.name, type: f.type, size: f.size, isBytes: f.bytes instanceof Uint8Array, kind: kit.files.fileKind(f), first: f.bytes[0] })));
  check('pickFiles gives FileItems', picked.length === 2 && picked[0].name === 'One.pdf' && picked[0].isBytes && picked[0].size === fx.plain.length && picked[0].first === 0x25, JSON.stringify(picked));
  check('a FileItem without a type gets its kind\'s', picked[1].type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && picked[1].kind === 'docx', JSON.stringify(picked[1]));
  // The camera; cancelled: nothing.
  await page.evaluate(() => { window.pickOptions = { accept: 'image', multiple: false, capture: 'environment' }; });
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#pick')]);
  const cam = await chooser.element().evaluate((i) => ({ capture: i.getAttribute('capture'), accept: i.accept, multiple: i.multiple }));
  check('capture opens the camera', cam.capture === 'environment' && cam.accept === 'image/*' && !cam.multiple, JSON.stringify(cam));
  if (cancel) {
    await chooser.setFiles([]);
    const none = await page.evaluate(async () => (await window.picked).length);
    check('a cancelled pick gives no files', none === 0);
  } else {
    await chooser.setFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) }]);
    const one = await page.evaluate(async () => (await window.picked).map((f) => f.type));
    check('a photo picked arrives', one.join() === 'image/png', one.join());
  }
  const leftover = await page.evaluate(() => document.querySelectorAll('input[type=file]').length);
  check('the picker input is removed', leftover === 0);
  await page.evaluate(() => document.getElementById('pick').remove());
}

// ---------------------------------------------------------------------------------------------
// ui.js

async function testControls(page) {
  // Segmented buttons: a radio group, arrow keys choose.
  await page.evaluate(() => {
    window.log = [];
    const { segmented, chips, dropdown, switchRow, slider, textField, button } = kit.ui;
    const wrap = document.createElement('div');
    wrap.id = 'controls';
    window.seg = segmented({ label: 'Compression', value: 'rec', options: [{ value: 'less', label: 'Less' }, { value: 'rec', label: 'Recommended' }, { value: 'ext', label: 'Extreme' }], onChange: (v) => log.push('seg:' + v) });
    window.chip = chips({ label: 'Look', value: 'a', options: [{ value: 'a', label: 'Original' }, { value: 'b', label: 'Grayscale' }], onChange: (v) => log.push('chip:' + v) });
    window.drop = dropdown({ label: 'Page size', value: 'fit', options: [{ value: 'fit', label: 'Fit (same as image)', short: 'Fit' }, { value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }], onChange: (v) => log.push('drop:' + v) });
    window.sw = switchRow({ label: 'Merge all images into one PDF', detail: 'One PDF with a page for each image', checked: true, onChange: (v) => log.push('sw:' + v) });
    window.sl = slider({ label: 'Opacity', min: 10, max: 100, step: 5, value: 50, format: (v) => v + '%', onChange: (v) => log.push('sl:' + v) });
    window.tf = textField({ label: 'File name', value: 'Report', suffix: '.pdf', helper: 'A helper', onInput: (v) => log.push('tf:' + v), onEnter: (v) => log.push('enter:' + v) });
    window.btns = [button({ label: 'Filled', icon: 'add' }), button({ label: 'Tonal', variant: 'tonal' }), button({ label: 'Outlined', variant: 'outlined' }), button({ label: 'Text', variant: 'text', disabled: true })];
    wrap.append(seg, chip, drop, sw, sl, tf, ...btns);
    mount(wrap);
  });
  let s = await page.evaluate(() => [...seg.querySelectorAll('[role=radio]')].map((b) => b.getAttribute('aria-checked') + b.tabIndex));
  check('segmented starts on its value, one tab stop', JSON.stringify(s) === JSON.stringify(['false-1', 'true0', 'false-1']), JSON.stringify(s));
  await page.click('#controls .ui-segment >> text=Less');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('End');
  s = await page.evaluate(() => ({ v: seg.value, log: log.slice(), focused: document.activeElement.textContent, role: seg.getAttribute('role') }));
  check('segmented by click and keys', s.v === 'ext' && s.log.join() === 'seg:less,seg:rec,seg:ext' && s.focused === 'Extreme' && s.role === 'radiogroup', JSON.stringify(s));
  await page.evaluate(() => seg.setValue('less'));
  check('segmented setValue tells nobody', await page.evaluate(() => seg.value === 'less' && log.length === 3));

  await page.click('#controls .ui-chip--filter >> text=Grayscale');
  s = await page.evaluate(() => ({ v: chip.value, checked: [...chip.querySelectorAll('[role=radio]')].map((b) => b.getAttribute('aria-checked')) }));
  check('chips choose', s.v === 'b' && s.checked.join() === 'false,true', JSON.stringify(s));

  // Dropdown chip: "Page size: Fit", a menu with the choice checked.
  check('dropdown shows the short value', (await page.textContent('#controls .ui-dropdown')).trim() === 'Page size: Fit');
  await page.click('#controls .ui-dropdown');
  let m = await page.evaluate(() => ({
    items: [...document.querySelectorAll('.ui-menu [role=menuitemradio]')].map((b) => b.textContent + ':' + b.getAttribute('aria-checked')),
    focused: document.activeElement.textContent, expanded: drop.getAttribute('aria-expanded'),
  }));
  check('dropdown menu', m.items.join('|') === 'Fit (same as image):true|A4:false|US Letter:false' && m.focused === 'Fit (same as image)' && m.expanded === 'true', JSON.stringify(m));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  m = await page.evaluate(() => ({ text: drop.textContent.trim(), log: log.slice(-1)[0], menu: !!document.querySelector('.ui-menu'), focus: document.activeElement === drop, expanded: drop.getAttribute('aria-expanded') }));
  check('dropdown chosen with keys', m.text === 'Page size: US Letter' && m.log === 'drop:letter' && !m.menu && m.focus && m.expanded === 'false', JSON.stringify(m));
  await page.click('#controls .ui-dropdown');
  await page.keyboard.press('Escape');
  check('Escape closes the menu, focus back', await page.evaluate(() => !document.querySelector('.ui-menu') && document.activeElement === drop));
  await page.click('#controls .ui-dropdown');
  await page.mouse.click(5, 770);
  check('a tap outside closes the menu', await page.evaluate(() => !document.querySelector('.ui-menu') && log.slice(-1)[0] === 'drop:letter'));
  await page.evaluate(() => drop.setDisabled(true, 'Same as image'));
  check('dropdown off, with its note', await page.evaluate(() => drop.disabled && drop.textContent.trim() === 'Page size: Same as image'));

  // Switch: the whole row flips it, Space too.
  await page.click('#controls .ui-switch-label');
  s = await page.evaluate(() => ({ c: sw.checked, aria: sw.switch.getAttribute('aria-checked'), role: sw.switch.getAttribute('role'), name: document.getElementById(sw.switch.getAttribute('aria-labelledby')).textContent }));
  check('switch row flips', !s.c && s.aria === 'false' && s.role === 'switch' && s.name === 'Merge all images into one PDF', JSON.stringify(s));
  await page.keyboard.press('Space');
  check('Space flips the focused switch', await page.evaluate(() => sw.checked && log.slice(-2).join() === 'sw:false,sw:true'));

  // Slider: keys move it, and a screen reader hears the formatted value.
  await page.focus('#controls .ui-slider-input');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  s = await page.evaluate(() => ({ v: sl.value, text: sl.input.getAttribute('aria-valuetext'), shown: sl.querySelector('.ui-slider-value').textContent, log: log.slice(-1)[0], type: sl.input.type }));
  check('slider', s.v === 60 && s.text === '60%' && s.shown === '60%' && s.log === 'sl:60' && s.type === 'range', JSON.stringify(s));

  // Text field: floating label, suffix, helper, error.
  await page.click('#controls .ui-field-input');
  await page.keyboard.press('End');
  await page.keyboard.type(' 2');
  await page.keyboard.press('Enter');
  s = await page.evaluate(() => ({ v: tf.value, log: log.slice(-2), suffix: getComputedStyle(tf.querySelector('.ui-field-suffix')).opacity, label: document.querySelector(`label[for="${tf.input.id}"]`).textContent, desc: tf.input.getAttribute('aria-describedby') }));
  check('text field typing and Enter', s.v === 'Report 2' && s.log.join() === 'tf:Report 2,enter:Report 2' && s.suffix === '1' && s.label === 'File name' && s.desc.split(' ').length === 2, JSON.stringify(s));
  await page.evaluate(() => tf.setError('Use page numbers such as 1,3-5.'));
  s = await page.evaluate(() => ({ inv: tf.input.getAttribute('aria-invalid'), support: tf.querySelector('.ui-field-support').textContent, live: tf.querySelector('.ui-field-support').getAttribute('aria-live') }));
  check('text field error', s.inv === 'true' && s.support === 'Use page numbers such as 1,3-5.' && s.live === 'polite', JSON.stringify(s));
  await page.evaluate(() => tf.setError(null));
  check('text field error cleared, helper back', await page.evaluate(() => !tf.input.hasAttribute('aria-invalid') && tf.querySelector('.ui-field-support').textContent === 'A helper'));
  check('buttons are real buttons', await page.evaluate(() => btns.every((b) => b.tagName === 'BUTTON' && b.type === 'button') && btns[3].disabled));
}

async function testDialogs(page, { wide }) {
  await page.evaluate(() => {
    window.log = [];
    const opener = kit.ui.button({ label: 'Open dialog' });
    opener.id = 'opener';
    mount(opener);
  });
  // Alert dialog: focus inside, Tab stays inside, Escape dismisses, the focus goes back.
  await page.focus('#opener');
  await page.evaluate(() => { window.answer = kit.ui.alertDialog({ title: 'Start over?', message: 'Not saved yet.', confirm: 'Start over', dismiss: 'Cancel' }); });
  let d = await page.evaluate(() => {
    const dlg = document.querySelector('dialog.ui-dialog[open]');
    return { role: dlg?.getAttribute('role'), modal: dlg?.matches(':modal'), focused: document.activeElement.textContent, label: document.getElementById(dlg.getAttribute('aria-labelledby')).textContent };
  });
  check('alert dialog opens with the focus inside', d.role === 'alertdialog' && d.modal && d.focused === 'Start over' && d.label === 'Start over?', JSON.stringify(d));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  d = await page.evaluate(() => ({ inside: !!document.activeElement.closest('dialog'), text: document.activeElement.textContent }));
  check('Tab stays in the dialog', d.inside, JSON.stringify(d));
  await page.keyboard.press('Escape');
  d = await page.evaluate(async () => ({ answer: await window.answer, focus: document.activeElement.id, open: !!document.querySelector('dialog[open]') }));
  check('Escape dismisses, focus returns', d.answer === false && d.focus === 'opener' && !d.open, JSON.stringify(d));
  await page.evaluate(() => { window.answer = kit.ui.alertDialog({ title: 'Remove?', message: 'Gone for good.', confirm: 'Remove', dismiss: 'Keep', destructive: true }); });
  check('a destructive dialog starts on the safe button', (await page.evaluate(() => document.activeElement.textContent)) === 'Keep');
  await page.click('dialog[open] .ui-btn:has-text("Remove")');
  check('confirm resolves true', await page.evaluate(() => window.answer) === true);

  // Bottom sheet: from the bottom on phones, in the middle on wide screens.
  await page.evaluate(() => {
    const { bottomSheet, button, switchRow } = kit.ui;
    window.sheet = bottomSheet({
      title: 'Create PDF',
      content: [switchRow({ label: 'Merge all images into one PDF', checked: true }), kit.ui.textField({ label: 'File name', value: 'Usugami_20261109', suffix: '.pdf' })],
      actions: [button({ label: 'Create PDF' })],
      onClose: () => log.push('sheet closed'),
    });
  });
  await page.waitForTimeout(400);
  const box = await page.evaluate(() => { const r = sheet.el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight, handle: getComputedStyle(sheet.el.querySelector('.ui-sheet-handle')).display }; });
  if (wide) check('sheet is a centred dialog on wide screens', Math.abs((box.top + box.bottom) / 2 - box.vh / 2) < 4 && box.handle === 'none', JSON.stringify(box));
  else check('sheet comes from the bottom on phones', Math.abs(box.bottom - box.vh) < 2 && box.left === 0 && box.handle !== 'none', JSON.stringify(box));
  await page.screenshot({ path: join(shots, `sheet-${wide ? 'desktop' : 'phone'}.png`) });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes the sheet', await page.evaluate(() => !document.querySelector('dialog[open]') && log.includes('sheet closed')));
  if (!wide) {
    // Swiping the handle down closes it.
    await page.evaluate(() => { window.sheet = kit.ui.bottomSheet({ title: 'Swipe me', content: 'Body', onClose: () => log.push('swiped') }); });
    await page.waitForTimeout(350);
    const h = await page.evaluate(() => { const r = sheet.el.querySelector('.ui-sheet-head').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; });
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    // Down past a third of its height, staying on the screen.
    const room = await page.evaluate(() => innerHeight - 4);
    await page.mouse.move(h.x, Math.min(room, h.y + 60), { steps: 6 });
    await page.mouse.move(h.x, Math.min(room, h.y + 110), { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    check('swiping the sheet down closes it', await page.evaluate(() => log.includes('swiped')));
  }

  // Progress dialog: only after its delay; Cancel says "Cancelling…".
  await page.evaluate(() => {
    window.pd = kit.ui.progressDialog({ title: 'Working on your PDFs…', onCancel: () => log.push('cancel') });
    pd.update(0.25, 'PDF 2 of 5', 'Report.pdf');
  });
  const early = await page.evaluate(() => getComputedStyle(document.querySelector('.ui-progress-dialog')).visibility);
  await page.waitForTimeout(500);
  d = await page.evaluate(() => {
    const surf = document.querySelector('.ui-progress-dialog');
    return { vis: getComputedStyle(surf).visibility, label: surf.querySelector('.ui-progress-label').textContent, live: surf.querySelector('.ui-progress-label').getAttribute('aria-live'), detail: surf.querySelector('.ui-progress-detail').textContent, now: surf.querySelector('[role=progressbar]').getAttribute('aria-valuenow') };
  });
  check('progress dialog waits, then shows', early === 'hidden' && d.vis === 'visible' && d.label === 'PDF 2 of 5' && d.live === 'polite' && d.detail === 'Report.pdf' && d.now === '25', JSON.stringify({ early, ...d }));
  if (!wide) await page.screenshot({ path: join(shots, 'progress-phone.png') });
  await page.keyboard.press('Escape');
  check('Escape doesn\'t cancel work', await page.evaluate(() => !!document.querySelector('dialog[open]') && !log.includes('cancel')));
  await page.click('dialog[open] .ui-btn:has-text("Cancel")');
  d = await page.evaluate(() => ({ log: log.slice(), btn: document.querySelector('.ui-progress-dialog .ui-btn').textContent, off: document.querySelector('.ui-progress-dialog .ui-btn').disabled }));
  check('Cancel', d.log.includes('cancel') && d.btn === 'Cancelling…' && d.off, JSON.stringify(d));
  await page.evaluate(() => pd.close());
  await page.waitForTimeout(250);

  // Snackbars: one at a time, announced, with an action.
  await page.evaluate(() => {
    window.s1 = kit.ui.snackbar('Saved', { duration: 600 });
    window.s2 = kit.ui.snackbar('Saved to Downloads as Report.pdf', { action: 'Undo', onAction: () => log.push('undo') });
  });
  await page.waitForTimeout(120);
  d = await page.evaluate(() => ({ shown: window.snacks(), announced: document.getElementById('announcer')?.textContent }));
  check('one snackbar at a time, announced', d.shown.join('|') === 'Saved' && d.announced === 'Saved', JSON.stringify(d));
  await page.waitForTimeout(1000);
  check('the next one follows', (await page.evaluate(() => window.snacks())).join('|') === 'Saved to Downloads as Report.pdf');
  await page.click('.ui-snackbar-action');
  check('snackbar action', await page.evaluate(async () => (await s2.result) === 'action' && log.includes('undo')));
  await page.waitForTimeout(250);

  // Password dialog on its own: wrong says so, Open PDF is off while empty.
  await page.evaluate(() => { window.pw = kit.ui.passwordDialog({ fileName: 'statement.pdf', wrong: true }); });
  d = await page.evaluate(() => {
    const dlg = document.querySelector('dialog[open]');
    return { body: dlg.querySelector('.ui-dialog-body p').textContent, err: dlg.querySelector('.ui-field-support').textContent, type: dlg.querySelector('input').type, focus: document.activeElement === dlg.querySelector('input'), ok: [...dlg.querySelectorAll('.ui-btn')].map((b) => b.textContent + ':' + b.disabled).join() };
  });
  check('password dialog', d.body === '"statement.pdf" is protected. Enter its password to continue.' && d.err === "That password didn't open the PDF." && d.type === 'password' && d.focus && d.ok === 'Cancel:false,Open PDF:true', JSON.stringify(d));
  await page.keyboard.type('x');
  d = await page.evaluate(() => ({ err: document.querySelector('dialog[open] .ui-field-support').textContent, ok: document.querySelector('dialog[open] .ui-dialog-actions .ui-btn:last-child').disabled }));
  check('typing clears the error and allows Open PDF', d.err === '' && !d.ok, JSON.stringify(d));
  await page.keyboard.press('Enter');
  check('Enter gives the password', (await page.evaluate(() => window.pw)) === 'x');
}

async function testCardsAndDrop(page) {
  await page.evaluate(() => {
    window.log = [];
    const { card, listItem, fileCard, emptyState, sectionHeading, topBar } = kit.ui;
    const c = document.createElement('div');
    c.id = 'cards';
    window.bar = topBar({ title: 'Split PDF', onBack: () => log.push('back'), actions: [{ icon: 'undo', label: 'Undo', onClick: () => log.push('undo') }], menu: [{ label: 'Sort A to Z', onClick: () => log.push('sort') }] });
    const canvas = document.createElement('canvas');
    canvas.width = 58; canvas.height = 78;
    const g = canvas.getContext('2d'); g.fillStyle = '#d00'; g.fillRect(0, 0, 58, 78);
    window.fc = fileCard({ name: 'A rather long file name for a report that wraps.pdf', detail: '3 pages · 619 kB', thumbnail: new Promise((r) => setTimeout(() => r(canvas), 50)), onRemove: () => log.push('remove') });
    window.empty = emptyState({ icon: 'add', title: 'Choose PDF', detail: 'You can choose several at once.', onClick: () => log.push('pick'), onFiles: (items) => log.push('dropped:' + items.map((i) => i.name).join('+')), accept: 'pdf' });
    c.append(bar, sectionHeading('Organize'), card({ icon: 'splitscreen', title: 'Split PDF', detail: 'Extract pages or split into smaller files', onClick: () => log.push('card') }),
      listItem({ icon: 'language', title: 'Language', detail: 'English', onClick: () => log.push('list') }), fc, empty);
    mount(c);
  });
  await page.click('#cards .ui-card-main');
  await page.click('#cards .ui-list-main');
  await page.click('#cards [aria-label="Remove A rather long file name for a report that wraps.pdf"]');
  await page.click('#cards [aria-label="Back"]');
  await page.click('#cards [aria-label="Undo"]');
  await page.click('#cards [aria-label="More options"]');
  await page.click('.ui-menu >> text=Sort A to Z');
  await page.click('#cards .ui-empty');
  let r = await page.evaluate(() => ({ log: log.join(), thumb: !!fc.querySelector('.ui-file-thumb canvas'), h1: bar.querySelector('h1').textContent }));
  check('cards, list items, file card, top bar and empty state', r.log === 'card,list,remove,back,undo,sort,pick' && r.thumb && r.h1 === 'Split PDF', JSON.stringify(r));

  // Dropping files: those of the kind asked for are taken, the others named.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([fx.plain], 'Good.pdf', { type: 'application/pdf' }));
    dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    empty.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.over = empty.classList.contains('is-dragover');
    empty.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => log.some((l) => l.startsWith('dropped:')));
  await snackWith(page, "Usugami can't open notes.txt, so it was left out.");
  r = await page.evaluate(() => ({ over: window.over, after: empty.classList.contains('is-dragover'), log: log.slice(-1)[0] }));
  check('drop zone', r.over && !r.after && r.log === 'dropped:Good.pdf', JSON.stringify(r));
  await clearSnacks(page);
  // Pasting a file while it shows.
  await page.evaluate(() => {
    document.activeElement?.blur();
    const dt = new DataTransfer();
    dt.items.add(new File([fx.plain], 'Pasted.pdf', { type: 'application/pdf' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => log.includes('dropped:Pasted.pdf'));
}

// ---------------------------------------------------------------------------------------------
// pdfdoc.js

async function testPdfDoc(page, fx) {
  let r = await page.evaluate(async () => {
    const src = await kit.pdfdoc.openPdf({ name: 'plain.pdf', type: 'application/pdf', size: fx.plain.length, bytes: fx.plain });
    window.plainSrc = src;
    const sizes = [await src.pageSize(0), await src.pageSize(1), await src.pageSize(2)];
    const c = await src.thumbnail(0, 100);
    const px = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    const corner = c.getContext('2d').getImageData(1, 1, 1, 1).data;
    const turned = await src.thumbnail(1, 100);
    const t0 = performance.now();
    const again = await src.thumbnail(0, 100);
    const cachedMs = performance.now() - t0;
    const doc = await src.pdfjs();
    return {
      count: src.pageCount, password: src.password, name: src.name, size: src.size, sizes, w: c.width, h: c.height, dpr: devicePixelRatio,
      center: [...px], corner: [...corner], turned: [turned.width, turned.height], cachedMs, same: again !== c && again.width === c.width, numPages: doc.numPages,
    };
  });
  check('openPdf counts pages', r.count === 3 && r.password === '' && r.name === 'plain.pdf' && r.numPages === 3, JSON.stringify(r));
  check('pageSize with rotation', r.sizes[0].width === 595 && r.sizes[0].height === 842 && r.sizes[0].rotation === 0
    && r.sizes[1].rotation === 90 && r.sizes[1].width === 595 && r.sizes[1].height === 842 && r.sizes[1].viewWidth === 842, JSON.stringify(r.sizes));
  check('thumbnail at the screen density, fitting its box', r.w <= Math.round(100 * r.dpr) && r.h <= Math.round(100 * 4 / 3 * r.dpr) + 1 && r.h > r.w, `${r.w}x${r.h} @${r.dpr}`);
  check('thumbnail drawn by pdf.js (red in the middle, white paper)', r.center[0] > 200 && r.center[1] < 60 && r.center[2] < 60 && r.corner.every((v) => v > 240), JSON.stringify([r.center, r.corner]));
  check('a turned page is drawn turned', r.turned[1] > r.turned[0], JSON.stringify(r.turned));
  check('thumbnails are cached, each a canvas of its own', r.cachedMs < 30 && r.same, String(r.cachedMs));

  r = await page.evaluate(async () => {
    const ac = new AbortController();
    const p = plainSrc.thumbnail(2, 300, { signal: ac.signal });
    ac.abort();
    try { await p; return 'drawn'; } catch (e) { return e.name; }
  });
  check('a thumbnail no longer wanted is dropped', r === 'CancelledError', r);

  // A PDF with a password: asked for, a wrong one said in the dialog, the right one opens it.
  for (const [label, key, pw] of [['pdf-lib encrypted', 'encrypted', 'test123'], ['the app\'s protected.pdf', 'protectedPdf', 'test123']]) {
    if (!(await page.evaluate((k) => !!fx[k], key))) continue;
    await page.evaluate((k) => { window.opening = kit.pdfdoc.openPdf({ name: 'statement.pdf', type: 'application/pdf', size: fx[k].length, bytes: fx[k] }); }, key);
    await page.waitForSelector('dialog[open] input[type=password]');
    check(`${label}: password asked`, (await page.textContent('dialog[open] .ui-dialog-title')) === 'PDF password');
    await page.fill('dialog[open] input[type=password]', 'wrong');
    await page.click('dialog[open] .ui-btn:has-text("Open PDF")');
    await page.waitForFunction(() => document.querySelector('dialog[open] .ui-field-support')?.textContent === "That password didn't open the PDF.");
    const still = await page.evaluate(() => ({ open: !!document.querySelector('dialog[open]'), invalid: document.querySelector('dialog[open] input').getAttribute('aria-invalid') }));
    check(`${label}: a wrong password says so and asks again`, still.open && still.invalid === 'true', JSON.stringify(still));
    await page.fill('dialog[open] input[type=password]', pw);
    await page.keyboard.press('Enter');
    r = await page.evaluate(async () => {
      const src = await window.opening;
      const c = await src.thumbnail(0, 80);
      const px = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      const out = { count: src.pageCount, password: src.password, px: [...px], dialog: !!document.querySelector('dialog[open]') };
      src.close();
      return out;
    });
    check(`${label}: the right password opens it`, r.password === pw && r.count >= 1 && !r.dialog, JSON.stringify(r));
    if (key === 'encrypted') check('its pages are drawn', r.px[0] > 200 && r.px[1] < 60, JSON.stringify(r.px));
  }
  // Cancel: null.
  await page.evaluate(() => { window.opening = kit.pdfdoc.openPdf({ name: 'locked.pdf', bytes: fx.encrypted }); });
  await page.waitForSelector('dialog[open] input[type=password]');
  await page.click('dialog[open] .ui-btn:has-text("Cancel")');
  check('cancelling the password gives null', (await page.evaluate(() => window.opening)) === null);
  r = await page.evaluate(async () => {
    const out = {};
    try { await kit.pdfdoc.openPdf({ name: 'locked.pdf', bytes: fx.encrypted }, { ask: false }); } catch (e) { out.noAsk = e.name + ':' + e.wrong; }
    try { await kit.pdfdoc.openPdf({ name: 'locked.pdf', bytes: fx.encrypted }, { ask: false, password: 'nope' }); } catch (e) { out.wrong = e.name + ':' + e.wrong; }
    out.given = (await kit.pdfdoc.openPdf({ name: 'locked.pdf', bytes: fx.encrypted }, { password: 'test123' }))?.pageCount;
    try { await kit.pdfdoc.openPdf({ name: 'bad.pdf', bytes: fx.damaged }); } catch (e) { out.damaged = e.key; }
    try { await kit.pdfdoc.openPdf({ name: 'empty.pdf', bytes: new Uint8Array(0) }); } catch (e) { out.empty = e.key; }
    if (fx.certificate) try { await kit.pdfdoc.openPdf({ name: 'cert.pdf', bytes: fx.certificate }); out.cert = 'opened'; } catch (e) { out.cert = e.key; }
    return out;
  });
  check('ask: false throws PasswordError', r.noAsk === 'PasswordError:false' && r.wrong === 'PasswordError:true', JSON.stringify(r));
  check('a password given opens it', r.given === 2, JSON.stringify(r));
  check('a damaged PDF fails clearly', r.damaged === 'pdf_import_failed' && r.empty === 'pdf_import_failed', JSON.stringify(r));
  if (fx.certificate) check('a certificate-locked PDF says so', r.cert === 'pdf_certificate_unsupported', JSON.stringify(r));

  // Several: one at a time, failures named together.
  await page.evaluate(() => {
    window.many = kit.pdfdoc.openPdfs([
      { name: 'a.pdf', bytes: fx.plain }, { name: 'bad.pdf', bytes: fx.damaged }, { name: 'locked.pdf', bytes: fx.encrypted }, { name: 'worse.pdf', bytes: new Uint8Array([1, 2, 3]) },
    ]);
  });
  await page.waitForSelector('dialog[open] input[type=password]');
  await page.click('dialog[open] .ui-btn:has-text("Cancel")');
  r = await page.evaluate(async () => { const m = await window.many; return { sources: m.sources.map((s) => s.name), failed: m.failed.map((f) => f.item.name) }; });
  check('openPdfs', r.sources.join() === 'a.pdf' && r.failed.join() === 'bad.pdf,worse.pdf', JSON.stringify(r));
  await snackWith(page, "bad.pdf, worse.pdf: Couldn't open these PDFs. They may be damaged or unsupported.");
  await clearSnacks(page);
}

/**
 * openPdf as the app's inspect and previewView: the item's own password first, a password question
 * closed with the screen, the view (page tree mended, Usugami's mark off) while `bytes` stay the
 * original, close() through pdf.js's loading task, and thumbnails drawn with alpha.
 */
async function testPdfDocMore(page, fx) {
  const pageMark = await exists(join(root, 'site', 'app', 'js', 'engine', 'page-mark.js'));
  const asked = [];
  const onRequest = (req) => { if (req.url().includes('page-mark.js')) asked.push(req.url()); };
  page.on('request', onRequest);

  // A plain PDF: no copy, its own bytes shown, the mark's module never fetched.
  let r = await page.evaluate(async () => {
    const item = { name: 'plain.pdf', bytes: fx.plain };
    const src = await kit.pdfdoc.openPdf(item);
    const doc = await src.pdfjs();
    const out = { count: src.pageCount, hasView: src.hasView, same: src.bytes === item.bytes && src.viewBytes === item.bytes, viewPassword: src.viewPassword, numPages: doc.numPages };
    // close(): pdf.js 6 frees a document through its loading task (it has no destroy()).
    const waiting = src.thumbnail(2, 400).then(() => 'drawn', (e) => e.name);
    src.close();
    src.close();
    out.closed = src.closed;
    out.destroyed = doc.loadingTask.destroyed;
    out.waiting = await waiting;
    out.after = await src.thumbnail(0, 50).then(() => 'drawn', (e) => e.name);
    out.pdfjs = await src.pdfjs().then(() => 'open', () => 'rejected');
    out.noDestroy = typeof doc.destroy;
    return out;
  });
  check('a plain PDF is shown as it is', r.count === 3 && !r.hasView && r.same && r.viewPassword === '' && r.numPages === 3, JSON.stringify(r));
  check('close() frees pdf.js through its loading task', r.closed && r.destroyed === true && r.noDestroy === 'undefined', JSON.stringify(r));
  check('after close(), nothing is drawn', ['CancelledError', 'drawn'].includes(r.waiting) && r.after === 'CancelledError' && r.pdfjs === 'rejected', JSON.stringify(r));

  // Thumbnails on a canvas with alpha (no coloured text fringes in Chromium), white paper.
  r = await page.evaluate(async () => {
    const src = await kit.pdfdoc.openPdf({ name: 'plain.pdf', bytes: fx.plain });
    const c = await src.render(0, { cssWidth: 80 });
    const g = c.getContext('2d');
    const out = { alpha: g.getContextAttributes?.().alpha ?? null, corner: [...g.getImageData(1, 1, 1, 1).data] };
    const thumb = await src.thumbnail(0, 80);
    out.thumbCorner = [...thumb.getContext('2d').getImageData(1, 1, 1, 1).data];
    src.close();
    return out;
  });
  check('pages are drawn on a canvas with alpha, on white', (r.alpha === true || r.alpha === null) && r.corner.every((v) => v > 240) && r.thumbCorner[3] === 255, JSON.stringify(r));

  // The item's own password (Choose a tool's) is tried first: no question.
  r = await page.evaluate(async () => {
    const src = await kit.pdfdoc.openPdf({ name: 'shared.pdf', bytes: fx.encrypted, password: 'test123' });
    const out = { password: src?.password, count: src?.pageCount, dialog: !!document.querySelector('dialog[open]') };
    src?.close();
    return out;
  });
  check('the item\'s password opens it without asking', r.password === 'test123' && r.count === 2 && !r.dialog, JSON.stringify(r));
  // A wrong one: asked, saying so.
  await page.evaluate(() => { window.opening = kit.pdfdoc.openPdf({ name: 'shared.pdf', bytes: fx.encrypted, password: 'not it' }); });
  await page.waitForSelector('dialog[open] input[type=password]');
  r = await page.evaluate(() => document.querySelector('dialog[open] .ui-field-support').textContent);
  check('a wrong item password asks again, saying so', r === "That password didn't open the PDF.", r);
  await page.fill('dialog[open] input[type=password]', 'test123');
  await page.keyboard.press('Enter');
  r = await page.evaluate(async () => { const src = await window.opening; const out = src?.password; src?.close(); return out; });
  check('then the right one opens it', r === 'test123', String(r));

  // Leaving the screen (its signal aborted) takes the question away.
  await page.evaluate(() => {
    window.ac = new AbortController();
    window.opening = kit.pdfdoc.openPdf({ name: 'locked.pdf', bytes: fx.encrypted }, { signal: ac.signal });
  });
  await page.waitForSelector('dialog[open] input[type=password]');
  await page.evaluate(() => ac.abort());
  r = await page.evaluate(async () => ({ result: await window.opening, open: !!document.querySelector('dialog[open]') }));
  check('aborting closes the password dialog with null', r.result === null && !r.open, JSON.stringify(r));
  // Also while a password is being tried.
  await page.evaluate(() => {
    window.ac = new AbortController();
    window.opening = kit.pdfdoc.openPdf({ name: 'locked.pdf', bytes: fx.encrypted }, { signal: ac.signal });
  });
  await page.waitForSelector('dialog[open] input[type=password]');
  await page.fill('dialog[open] input[type=password]', 'test123');
  await page.evaluate(() => { document.querySelector('dialog[open] .ui-dialog-actions .ui-btn:last-child').click(); ac.abort(); });
  r = await page.evaluate(async () => ({ result: await window.opening, open: !!document.querySelector('dialog[open]') }));
  check('aborting while trying a password gives null too', r.result === null && !r.open, JSON.stringify(r));

  // A page tree that miscounts: the pages counted as the tools count them, drawn from a mended copy,
  // and `bytes` still the PDF as picked.
  r = await page.evaluate(async () => {
    const item = { name: 'miscounted.pdf', bytes: fx.miscounted };
    const src = await kit.pdfdoc.openPdf(item);
    const doc = await src.pdfjs();
    const c = await src.thumbnail(2, 60);
    const px = [...c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data];
    const out = { count: src.pageCount, numPages: doc.numPages, hasView: src.hasView, original: src.bytes === item.bytes, copy: src.viewBytes !== item.bytes && src.viewBytes.length > 0, px };
    src.close();
    return out;
  });
  check('a miscounted page tree: the pages the tools find', r.count === 3 && r.numPages === 3 && r.hasView && r.original && r.copy, JSON.stringify(r));
  check('its last page drawn from the mended copy', r.px[2] > 200 && r.px[0] < 60, JSON.stringify(r.px));

  if (pageMark) {
    r = await page.evaluate(async () => {
      const item = { name: 'marked.pdf', bytes: fx.marked };
      const src = await kit.pdfdoc.openPdf(item);
      const c = await src.thumbnail(0, 100);
      const g = c.getContext('2d');
      const at = (fx_, fy) => [...g.getImageData(Math.floor(c.width * fx_), Math.floor(c.height * fy), 1, 1).data];
      const out = { hasView: src.hasView, original: src.bytes === item.bytes, corner: at(0.8, 0.85), middle: at(0.5, 0.4) };
      src.close();
      return out;
    });
    check('Usugami\'s mark is taken off the view', r.hasView && r.original && r.corner[0] > 200 && r.corner[1] < 60 && r.middle[0] > 200, JSON.stringify(r));
  } else {
    console.log('    (engine/page-mark.js isn\'t there yet: the mark is left on, untested)');
  }
  page.off('request', onRequest);
  check('the mark\'s module is fetched only for a PDF naming it', pageMark || !asked.length, asked.join());
}

/** The kit's smaller additions: text actions, labels, snackbars over bottom bars, batch names. */
async function testKitMore(page, { wide, timing = false }) {
  // A top bar action with words and no icon is a text button.
  await page.evaluate(() => {
    window.log = [];
    window.tbar = kit.ui.topBar({ title: 'Recent files', onBack: () => {}, actions: [{ label: 'Clear list', onClick: () => log.push('clear') }, { icon: 'undo', label: 'Undo', onClick: () => log.push('undo') }] });
    mount(tbar);
  });
  let r = await page.evaluate(() => {
    const [text, undo] = tbar.actions;
    const box = text.getBoundingClientRect();
    return { text: text.textContent, isText: text.classList.contains('ui-btn--text') && !text.classList.contains('ui-icon-btn'), name: text.getAttribute('aria-label'), undo: undo.classList.contains('ui-icon-btn') && undo.getAttribute('aria-label'), h: box.height, inBar: tbar.contains(text) };
  });
  check('a top bar action without an icon is a text button', r.text === 'Clear list' && r.isText && r.name === null && r.undo === 'Undo' && r.h >= 40 && r.inBar, JSON.stringify(r));
  await page.click('.ui-topbar-text');
  await page.evaluate(() => { tbar.actions[0].disabled = true; });
  await page.click('.ui-topbar-text', { force: true });
  check('its click, and off when disabled', (await page.evaluate(() => log.join())) === 'clear');

  // textField.setLabel: the floating label and the outline's gap change, the text stays.
  r = await page.evaluate(() => {
    const f = kit.ui.textField({ label: 'Pages', value: '1-3' });
    mount(f);
    f.setLabel('Page ranges');
    return { label: f.querySelector('.ui-field-label').textContent, legend: f.querySelector('legend').textContent, value: f.value, labelFor: document.querySelector(`label[for="${f.input.id}"]`).textContent };
  });
  check('textField setLabel', r.label === 'Page ranges' && r.legend === 'Page ranges' && r.value === '1-3' && r.labelFor === 'Page ranges', JSON.stringify(r));

  // Snackbars show above a bottom bar on screen, without the screen doing anything, and come down
  // when it goes.
  await clearSnacks(page);
  await page.evaluate(() => {
    const { bottomBar, button, topBar } = kit.ui;
    const screen = document.createElement('div');
    screen.style.cssText = 'display:flex;flex-direction:column;min-height:100vh';
    const body = document.createElement('div');
    body.style.flex = '1';
    body.textContent = 'Content';
    window.bbar = bottomBar(button({ label: 'Split PDF' }));
    screen.append(topBar({ title: 'Split PDF' }), body, bbar);
    mount(screen);
    window.scrollTo(0, 0);
    window.liftSnack = kit.ui.snackbar('Above the bar', { duration: 8000 });
  });
  await page.waitForTimeout(450);
  const place = () => page.evaluate(() => {
    const s = liftSnack.getBoundingClientRect();
    const b = bbar.isConnected ? bbar.getBoundingClientRect() : null;
    return { snack: Math.round(s.bottom), bar: b && Math.round(b.top), vh: document.documentElement.clientHeight };
  });
  r = await place();
  check('a snackbar shows above the bottom bar', r.bar > r.vh / 2 && r.snack <= r.bar - 12 && r.snack >= r.bar - 20, JSON.stringify(r));
  if (!wide) await page.screenshot({ path: join(shots, 'snackbar-over-bar-phone.png') });
  await page.evaluate(() => bbar.remove());
  await page.waitForTimeout(700);
  r = await place();
  check('and comes down once the bar goes', r.snack >= r.vh - 20 && r.snack <= r.vh - 12, JSON.stringify(r));
  // A screen's own --snackbar-offset still lifts it, the higher of the two winning.
  await page.evaluate(() => document.documentElement.style.setProperty('--snackbar-offset', '120px'));
  await page.waitForTimeout(100);
  r = await place();
  check('--snackbar-offset still works', Math.abs(r.vh - 16 - 120 - r.snack) <= 2, JSON.stringify(r));
  await page.evaluate(() => { document.documentElement.style.removeProperty('--snackbar-offset'); liftSnack.dismiss(); });
  await page.waitForTimeout(250);

  // pageGrid: refresh(indexes) redraws only those pages; a redraw with nothing new changes nothing.
  r = await page.evaluate(async () => {
    window.calls = [];
    const never = () => new Promise(() => {});
    window.rg = kit.pagegrid.pageGrid({ count: 20, thumbnail: never, label: (i) => { calls.push(i); return String(i + 1); } });
    mount(rg);
    calls.length = 0;
    rg.refresh([2, 5]);
    const some = calls.slice();
    calls.length = 0;
    rg.refresh(7);
    const one = calls.slice();
    calls.length = 0;
    rg.refresh();
    const all = calls.length;
    const mo = new MutationObserver(() => {});
    mo.observe(rg, { subtree: true, childList: true, attributes: true, characterData: true });
    rg.refresh();
    const changes = mo.takeRecords().length;
    mo.disconnect();
    rg.destroy();
    return { some, one, all, changes };
  });
  check('refresh(indexes) redraws only those pages', r.some.join() === '2,5' && r.one.join() === '7' && r.all === 20, JSON.stringify(r));
  check('a redraw with nothing new touches nothing', r.changes === 0, JSON.stringify(r));

  // Delete pages' sign is made once per page and kept.
  r = await page.evaluate(() => {
    window.marked = new Set([1]);
    window.dg = kit.pagegrid.pageGrid({ count: 6, thumbnail: () => new Promise(() => {}), selectable: true, selected: marked, selectedStyle: 'delete', onToggle: (i) => (marked.has(i) ? marked.delete(i) : marked.add(i)) });
    mount(dg);
    const before = [...dg.querySelectorAll('.ui-page-delete-sign')];
    dg.querySelectorAll('.ui-page')[3].click();
    marked.add(4);
    dg.refresh([4]);
    dg.refresh();
    const after = [...dg.querySelectorAll('.ui-page-delete-sign')];
    const checked = [...dg.querySelectorAll('.ui-page')].map((b) => b.getAttribute('aria-checked')).join();
    dg.destroy();
    return { n: before.length, same: before.length === after.length && before.every((s, i) => s === after[i]), checked };
  });
  check('Delete pages\' signs are kept, not made anew', r.n === 6 && r.same && r.checked === 'false,true,false,true,true,false', JSON.stringify(r));

  // Thousands of pages: a redraw where little changes is quick.
  r = await page.evaluate(() => {
    const big = kit.pagegrid.pageGrid({ count: 3000, thumbnail: () => new Promise(() => {}), selectable: true, selected: new Set([0]), selectedStyle: 'delete' });
    mount(big);
    let t0 = performance.now();
    big.refresh();
    const same = performance.now() - t0;
    t0 = performance.now();
    big.setSelected(new Set(Array.from({ length: 3000 }, (_, i) => i)));
    const every = performance.now() - t0;
    t0 = performance.now();
    big.refresh([5, 6]);
    const two = performance.now() - t0;
    big.destroy();
    return { same: Math.round(same), every: Math.round(every), two: +two.toFixed(2) };
  });
  console.log(`    3000 pages: redraw ${r.same} ms unchanged, ${r.every} ms all chosen, ${r.two} ms two pages`);
  if (timing) check('redrawing 3000 pages with nothing new is quick', r.same < 100 && r.two < 10, JSON.stringify(r));

  // One page chosen at a time (Reorganize): a listbox of options, keyboard-usable.
  await page.evaluate(() => {
    window.log = [];
    window.one = new Set([0]);
    window.sg = kit.pagegrid.pageGrid({
      count: 8, thumbnail: () => new Promise(() => {}), selectable: 'single', selected: one, ariaLabel: 'Pages',
      onToggle: (i) => { one.clear(); one.add(i); log.push('one:' + i); },
      reorderable: true, onMove: (a, b) => log.push(`move:${a}>${b}`),
    });
    mount(sg);
  });
  const single = () => page.evaluate(() => ({
    role: sg.getAttribute('role'), name: sg.getAttribute('aria-label'),
    options: [...sg.querySelectorAll('.ui-page')].map((b) => b.getAttribute('role') + ':' + b.getAttribute('aria-selected')),
    wraps: [...new Set([...sg.querySelectorAll('.ui-page-tile')].map((w) => w.getAttribute('role')))].join(),
    shownChildren: [...sg.children].filter((c) => !c.hidden).every((c) => c.getAttribute('role') === 'none'),
    moves: sg.querySelectorAll('.ui-page-move').length,
    desc: document.getElementById(sg.querySelector('.ui-page').getAttribute('aria-describedby'))?.textContent,
    focus: document.activeElement?.getAttribute('aria-label'),
    log: log.slice(),
  }));
  r = await single();
  check('single choice: a listbox of options', r.role === 'listbox' && r.name === 'Pages' && r.options[0] === 'option:true' && r.options.slice(1).every((o) => o === 'option:false')
    && r.wraps === 'none' && r.shownChildren && r.moves === 0 && r.desc === 'To move it, press Ctrl and an arrow key, or drag it.', JSON.stringify(r));
  await page.click('.ui-page-tile:nth-child(4) .ui-page');
  r = await single();
  check('tapping a page chooses it alone', r.options[2] === 'option:true' && r.options.filter((o) => o === 'option:true').length === 1 && r.log.join() === 'one:2', JSON.stringify(r));
  await page.keyboard.press('ArrowRight');
  r = await single();
  check('arrow keys move the focus, not the choice', r.focus === 'Page 4' && r.options[2] === 'option:true' && r.options[3] === 'option:false', JSON.stringify(r));
  await page.keyboard.press('Space');
  r = await single();
  check('Space chooses the focused page', r.options[3] === 'option:true' && r.options[2] === 'option:false' && r.log.at(-1) === 'one:3', JSON.stringify(r));
  await page.keyboard.press('Control+ArrowLeft');
  r = await single();
  check('Ctrl+arrow still moves it', r.log.at(-1) === 'move:3>2', JSON.stringify(r));
  await page.evaluate(() => sg.destroy());

  // batchList: each "File name" is named after its file, as its Remove button is.
  r = await page.evaluate(() => {
    const items = [{ id: 1, name: 'alpha.pdf' }, { id: 2, name: 'beta.pdf' }];
    const list = kit.batch.batchList({ items, nameOf: (id) => 'n' + id, onRename: () => {}, onRemove: () => {} });
    mount(list);
    const names = () => [...list.querySelectorAll('.ui-field-input')].map((i) => i.getAttribute('aria-label'));
    const first = names();
    list.setItems([{ id: 1, name: 'alpha.pdf' }, { id: 2, name: 'beta (2).pdf' }]);
    return { first, then: names(), label: list.querySelector('.ui-field-label').textContent };
  });
  check('each file name field is named after its file', r.first.join('|') === 'File name for alpha.pdf|File name for beta.pdf' && r.then[1] === 'File name for beta (2).pdf' && r.label === 'File name', JSON.stringify(r));
}

// ---------------------------------------------------------------------------------------------
// pagegrid.js

async function gridSetup(page, { selectable = false, count = 60, rotation = false } = {}) {
  await page.evaluate(async ({ selectable, count, rotation }) => {
    window.log = [];
    window.gridSrc ??= await kit.pdfdoc.openPdf({ name: 'many.pdf', bytes: fx.many });
    window.order = Array.from({ length: count }, (_, i) => i);
    window.sel = new Set();
    window.thumbsAsked = new Set();
    window.grid = kit.pagegrid.pageGrid({
      count,
      thumbnail: (i, w, o) => { thumbsAsked.add(order[i]); return gridSrc.thumbnail(order[i], w, o); },
      label: (i) => String(order[i] + 1),
      selectable,
      selected: sel,
      onToggle: (i) => { if (sel.has(i)) sel.delete(i); else sel.add(i); log.push('toggle:' + i); },
      reorderable: true,
      onMove: (from, to) => { const [x] = order.splice(from, 1); order.splice(to, 0, x); log.push(`move:${from}>${to}`); },
      onMoveStart: () => log.push('start'),
      onMoveEnd: (a, b) => log.push(`end:${a}>${b}`),
      rotation: rotation ? (i) => (order[i] === 0 ? 90 : 0) : undefined,
      ariaLabel: 'Pages',
    });
    const wrap = document.createElement('div');
    wrap.append(grid);
    mount(wrap);
    window.scrollTo(0, 0);
  }, { selectable, count, rotation });
  await page.waitForFunction(() => document.querySelectorAll('.ui-pagegrid canvas').length >= 3);
}

const domOrder = (page) => page.evaluate(() => [...grid.querySelectorAll('.ui-page-label')].map((l) => Number(l.textContent) - 1));
const modelOrder = (page) => page.evaluate(() => window.order.slice());

async function tileCenter(page, i) {
  return page.evaluate((i) => {
    const r = grid.querySelectorAll('.ui-page-tile')[i].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, i);
}

async function testPageGrid(page, { wide }) {
  await gridSetup(page, { selectable: true, rotation: true });
  await page.waitForTimeout(500);
  let r = await page.evaluate(() => ({ canvases: grid.querySelectorAll('canvas').length, asked: thumbsAsked.size, tiles: grid.querySelectorAll('.ui-page-tile').length, role: grid.getAttribute('role') }));
  check('only the pages near the screen are drawn', r.tiles === 60 && r.canvases > 0 && r.canvases < 60 && r.asked < 60 && r.role === 'list', JSON.stringify(r));
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => grid.querySelectorAll('.ui-page-tile')[59].querySelector('canvas'), null, { timeout: 8000 });
  r = await page.evaluate(() => ({ first: !!grid.querySelectorAll('.ui-page-tile')[0].querySelector('canvas'), last: !!grid.querySelectorAll('.ui-page-tile')[59].querySelector('canvas') }));
  check('scrolling draws the pages reached and lets the far ones go', r.last && !r.first, JSON.stringify(r));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => grid.querySelectorAll('.ui-page-tile')[0].querySelector('canvas'));
  r = await page.evaluate(() => ({ turn: grid.querySelectorAll('.ui-page-turn')[0].style.transform, other: grid.querySelectorAll('.ui-page-turn')[1].style.transform }));
  check('a turned page is shown turned', r.turn.includes('rotate(90deg)') && r.other.startsWith('rotate(0deg)'), JSON.stringify(r));
  // Chosen pages framed, and the pictures faded in, for the screenshot.
  await page.evaluate(() => { sel.add(3); grid.refresh(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `grid-${wide ? 'desktop' : 'phone'}.png`) });
  await page.evaluate(() => { sel.delete(3); grid.refresh(); });

  // Choosing.
  await page.click('.ui-page-tile:nth-child(3) .ui-page');
  r = await page.evaluate(() => ({ log: log.slice(), checked: grid.querySelectorAll('.ui-page')[1].getAttribute('aria-checked'), role: grid.querySelectorAll('.ui-page')[1].getAttribute('role'), name: grid.querySelectorAll('.ui-page')[1].getAttribute('aria-label') }));
  check('tapping a page chooses it', r.log.join() === 'toggle:1' && r.checked === 'true' && r.role === 'checkbox' && r.name === 'Page 2', JSON.stringify(r));

  // Keyboard: arrows move the focus, Ctrl+arrows move the page.
  await page.focus('.ui-page-tile:nth-child(2) .ui-page');
  await page.keyboard.press('ArrowRight');
  r = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  check('arrow keys move the focus', r === 'Page 2', r);
  await page.keyboard.press('Control+ArrowRight');
  r = { dom: await domOrder(page), model: await modelOrder(page), focus: await page.evaluate(() => document.activeElement.getAttribute('aria-label')) };
  check('Ctrl+Right moves the page later', r.model.slice(0, 4).join() === '0,2,1,3' && r.dom.slice(0, 4).join() === r.model.slice(0, 4).join() && r.focus === 'Page 3', JSON.stringify({ ...r, dom: r.dom.slice(0, 5), model: r.model.slice(0, 5) }));
  await page.waitForTimeout(120);
  check('the move is announced', (await page.evaluate(() => document.getElementById('announcer').textContent)) === 'Moved to place 3 of 60');
  await page.keyboard.press('Control+Home');
  r = await modelOrder(page);
  check('Ctrl+Home moves it first', r.slice(0, 4).join() === '1,0,2,3', r.slice(0, 4).join());
  // The move buttons of the page focused.
  r = await page.evaluate(() => {
    const t = grid.querySelectorAll('.ui-page-tile')[0];
    return [...t.querySelectorAll('.ui-page-move')].map((b) => b.getAttribute('aria-label') + ':' + b.disabled);
  });
  check('move buttons say which page they move', r.join() === 'Move page 1 earlier:true,Move page 1 later:false', r.join());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  r = { model: await modelOrder(page), focus: await page.evaluate(() => document.activeElement.getAttribute('aria-label')) };
  check('the later button moves it, keeping the focus', r.model.slice(0, 3).join() === '0,1,2' && r.focus === 'Move page 2 later', JSON.stringify(r));

  // Mouse: drag page 1 onto page 4's place.
  await page.evaluate(() => { window.scrollTo(0, 0); log = []; });
  // The tiles moved last glide into place first.
  await page.waitForTimeout(400);
  const a = await tileCenter(page, 0);
  const b = await tileCenter(page, 3);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 10, a.y + 2, { steps: 2 });
  await page.mouse.move(b.x, b.y, { steps: 12 });
  const lifted = await page.evaluate(() => !!grid.querySelector('.ui-page-tile.is-dragging'));
  await page.mouse.up();
  await page.waitForTimeout(300);
  r = { model: await modelOrder(page), dom: await domOrder(page), log: await page.evaluate(() => log.slice()) };
  check('dragging with a mouse moves the page', lifted && r.model.slice(0, 5).join() === '1,2,3,0,4' && r.dom.slice(0, 5).join() === '1,2,3,0,4', JSON.stringify({ lifted, ...r, model: r.model.slice(0, 6), dom: r.dom.slice(0, 6) }));
  check('one drag start and end', r.log[0] === 'start' && r.log[r.log.length - 1] === 'end:0>3' && !r.log.some((l) => l.startsWith('toggle')), JSON.stringify(r.log));
  // Delete pages' look: a page marked fades behind a delete sign, framed in the error colour.
  await page.evaluate(() => {
    window.marked = new Set([1]);
    window.dgrid = kit.pagegrid.pageGrid({ count: 6, thumbnail: (i, w, o) => gridSrc.thumbnail(i, w, o), selectable: true, selected: marked, selectedStyle: 'delete', onToggle: (i) => (marked.has(i) ? marked.delete(i) : marked.add(i)) });
    mount(dgrid);
  });
  await page.waitForTimeout(500);
  r = await page.evaluate(() => {
    const tiles = dgrid.querySelectorAll('.ui-page-tile');
    const sign = (t) => getComputedStyle(t.querySelector('.ui-page-delete-sign')).opacity;
    return { marked: sign(tiles[1]), kept: sign(tiles[0]), faded: getComputedStyle(tiles[1].querySelector('.ui-page-picture')).opacity, checked: tiles[1].querySelector('.ui-page').getAttribute('aria-checked') };
  });
  check('Delete pages look', r.marked === '1' && r.kept === '0' && r.faded === '0.4' && r.checked === 'true', JSON.stringify(r));
  await page.screenshot({ path: join(shots, `grid-delete-${wide ? 'desktop' : 'phone'}.png`) });
  await page.evaluate(() => mount(grid));
  check('no page stays lifted', await page.evaluate(() => !grid.querySelector('.is-dragging') && [...grid.querySelectorAll('.ui-page-tile')].every((t) => !t.style.transform || t.style.transform === 'none' || t.style.transform === '')));
}

/** Touch: a long press lifts the page, a quick swipe scrolls instead. Chromium only (CDP). */
async function testTouchReorder(page) {
  await gridSetup(page, { count: 60 });
  const client = await page.context().newCDPSession(page);
  const touch = (type, x, y) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await page.evaluate(() => { window.scrollTo(0, 0); log = []; });
  let a = await tileCenter(page, 0);
  let b = await tileCenter(page, 4);
  await touch('touchStart', a.x, a.y);
  await page.waitForTimeout(650);
  const lifted = await page.evaluate(() => !!grid.querySelector('.ui-page-tile.is-dragging'));
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd');
  await page.waitForTimeout(300);
  let r = { model: await modelOrder(page), log: await page.evaluate(() => log.slice()) };
  check('a long press and drag moves the page', lifted && r.model.slice(0, 6).join() === '1,2,3,4,0,5' && r.log[0] === 'start' && r.log.at(-1) === 'end:0>4', JSON.stringify({ lifted, model: r.model.slice(0, 7), log: r.log }));

  // A quick swipe scrolls, it doesn't move a page.
  await page.evaluate(() => { log = []; });
  a = await tileCenter(page, 7);
  const before = await page.evaluate(() => window.scrollY);
  await touch('touchStart', a.x, a.y);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', a.x, a.y - i * 30);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd');
  await page.waitForTimeout(400);
  r = { scrolled: await page.evaluate(() => window.scrollY), log: await page.evaluate(() => log.slice()) };
  check('a swipe scrolls the grid, moving nothing', r.scrolled > before && !r.log.length, JSON.stringify({ before, ...r }));

  // Held near the bottom of the screen, the page scrolls the grid along.
  await page.evaluate(() => { window.scrollTo(0, 0); log = []; });
  a = await tileCenter(page, 1);
  const vh = await page.evaluate(() => innerHeight);
  await touch('touchStart', a.x, a.y);
  await page.waitForTimeout(650);
  await touch('touchMove', a.x, vh - 60);
  await touch('touchMove', a.x, vh - 15);
  await page.waitForTimeout(900);
  const scrolled = await page.evaluate(() => window.scrollY);
  await touch('touchEnd');
  await page.waitForTimeout(300);
  const model = await modelOrder(page);
  check('dragging to the edge scrolls', scrolled > 100 && model.indexOf(2) > 4, JSON.stringify({ scrolled, at: model.indexOf(2) }));
  await client.detach();
}

// ---------------------------------------------------------------------------------------------
// output.js

async function readDownload(dl) {
  return new Uint8Array(await readFile(await dl.path()));
}

/** Stubs the browser's pickers and share sheet, keeping what is written. */
async function stubPickers(page, { share = true } = {}) {
  await page.evaluate((share) => {
    window.written = {};
    window.folderFiles = { 'Report_split_1.pdf': new Uint8Array([1]) };
    const writable = (name, store) => ({
      async write(b) { store[name] = new Uint8Array(b); },
      async close() {}, async abort() {},
    });
    window.showSaveFilePicker = async ({ suggestedName }) => ({ name: suggestedName, createWritable: async () => writable(suggestedName, written) });
    const dir = {
      name: 'Docs',
      async getFileHandle(n, o = {}) {
        if (!(n in folderFiles) && !o.create) throw new DOMException('no', 'NotFoundError');
        if (!(n in folderFiles)) folderFiles[n] = new Uint8Array(0);
        return { name: n, createWritable: async () => writable(n, folderFiles) };
      },
      async isSameEntry(o) { return o === dir; },
    };
    window.showDirectoryPicker = async () => dir;
    if (share) {
      window.shared = [];
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => Array.isArray(d?.files) });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { shared.push(d.files.map((f) => f.name + ':' + f.size)); } });
    }
  }, share);
}

async function testOutput(page, fx, { wide }) {
  // ZipArchive's names and the ZIP file itself.
  let r = await page.evaluate(() => {
    const { entryNames, zipFileName, savedPercent } = kit.output;
    return {
      a: entryNames(['a.pdf', 'A.pdf', 'b.pdf', 'a.pdf', 'a (2).pdf']),
      b: entryNames(['notes', 'Notes']),
      c: entryNames(['../../x.pdf', 'a\\b.pdf', '  ']),
      zipName: [zipFileName('Report_split'), zipFileName('  '), zipFileName('Report.pdf'), zipFileName('a/b')],
      pct: [savedPercent(1000, 380), savedPercent(1000, 995), savedPercent(1000, 1200), savedPercent(0, 10)],
    };
  });
  check('entryNames (ZipArchiveTest)', r.a.join('|') === 'a.pdf|A (2).pdf|b.pdf|a (3).pdf|a (2) (2).pdf' && r.b.join('|') === 'notes|Notes (2)' && r.c.join('|') === '.._.._x.pdf|a_b.pdf|file', JSON.stringify(r));
  check('ZIP names', r.zipName.join('|') === 'Report_split.zip|Usugami.zip|Report.zip|a_b.zip', r.zipName.join('|'));
  check('savedPercent (Compressor)', JSON.stringify(r.pct) === JSON.stringify([62, null, null, null]), JSON.stringify(r.pct));
  r = await page.evaluate(async () => {
    const big = new Uint8Array(1_500_000); for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
    const files = [{ name: 'Report_split_1_1-1.pdf', bytes: big }, { name: 'रिपोर्ट_1.pdf', bytes: new Uint8Array([1, 2, 3]) }, { name: 'Reçu été.pdf', bytes: new Uint8Array(0) }, { name: 'scan.pdf', bytes: new Uint8Array([9]) }, { name: 'Scan.pdf', bytes: new Uint8Array([8]) }];
    const seen = [];
    const zip = await kit.output.zipFilesAsync(files, 'Report_split', { onProgress: (p) => seen.push(p) });
    const sync = kit.output.zipFiles(files, 'Report_split');
    const ac = new AbortController();
    let cancelled = null;
    try { await kit.output.zipFilesAsync(files, 'x', { signal: ac.signal, onProgress: () => ac.abort() }); } catch (e) { cancelled = e.name; }
    const last = seen.at(-1);
    return {
      name: zip.name, type: zip.type, b64: b64Of(zip.bytes), same: b64Of(sync.bytes).length === b64Of(zip.bytes).length,
      last: [last.files, last.totalFiles, last.bytes, last.totalBytes, last.fraction], total: files.reduce((s, f) => s + f.bytes.length, 0) * 2,
      monotonic: seen.every((p, i) => !i || (p.bytes >= seen[i - 1].bytes && p.files >= seen[i - 1].files)), cancelled,
    };
  });
  check('zipFilesAsync progress counts every byte twice and every file', r.monotonic && r.last.join() === `5,5,${r.total},${r.total},1`, JSON.stringify(r.last));
  check('zipping can be cancelled', r.cancelled === 'CancelledError', r.cancelled);
  const zipBytes = Buffer.from(r.b64, 'base64');
  const entries = unzipSync(new Uint8Array(zipBytes));
  check('ZIP entries in order with unique names, UTF-8', Object.keys(entries).join('|') === 'Report_split_1_1-1.pdf|रिपोर्ट_1.pdf|Reçu été.pdf|scan.pdf|Scan (2).pdf' && r.name === 'Report_split.zip' && r.type === 'application/zip', Object.keys(entries).join('|'));
  check('ZIP data intact', entries['Report_split_1_1-1.pdf'].length === 1_500_000 && entries['Report_split_1_1-1.pdf'][1000] === ((1000 * 31) & 255) && entries['Scan (2).pdf'][0] === 8 && entries['Reçu été.pdf'].length === 0);
  // Stored, with sizes and checksum in each local header (method 0, flag 0x800, no data descriptor).
  check('ZIP entries stored', zipBytes.readUInt32LE(0) === 0x04034b50 && zipBytes.readUInt16LE(8) === 0 && zipBytes.readUInt16LE(6) === 0x0800 && zipBytes.readUInt32LE(22) === 1_500_000);

  // One PDF: Open, Share, Save to Downloads, Save as.
  await stubPickers(page);
  await page.evaluate(() => {
    window.log = [];
    window.result = kit.output.showResult(document.getElementById('root'), {
      files: [{ name: 'Report_compressed.pdf', bytes: fx.plain, type: 'application/pdf', originalSize: fx.plain.length * 4 }],
      onBack: () => log.push('back'), onStartOver: () => log.push('start over'), passwordRemoved: true,
    });
  });
  await page.waitForFunction(() => document.querySelector('.ui-result-details')?.textContent.includes('3 pages'));
  r = await page.evaluate(() => ({
    title: document.querySelector('.ui-topbar-title').textContent, back: document.querySelector('.ui-topbar [aria-label="Back to editing"]') != null,
    heading: document.querySelector('.ui-result-heading').textContent, focus: document.activeElement.className,
    buttons: [...document.querySelectorAll('.ui-result-actions .ui-btn')].map((b) => b.textContent),
    details: document.querySelector('.ui-result-details').textContent, extra: document.querySelector('.ui-result-extra')?.textContent,
    note: document.querySelector('.ui-result-note')?.textContent, unsaved: document.querySelector('.ui-result-unsaved').textContent,
    start: document.querySelector('.ui-result-startover')?.textContent,
  }));
  check('result screen for one PDF', r.title === 'Done' && r.back && r.heading === 'Your PDF is ready' && r.focus === 'ui-result-heading'
    && r.buttons.join('|') === 'Open|Share|Save to Downloads|Save as…' && r.start === 'Start over', JSON.stringify(r));
  check('its details', /^3 pages · \d/.test(r.details) && /^Compressed from .+ \(75% smaller\)$/.test(r.extra) && r.note === 'The new PDF has no password.'
    && r.unsaved.startsWith('Not saved yet.'), JSON.stringify(r));
  await page.screenshot({ path: join(shots, `result-one-${wide ? 'desktop' : 'phone'}.png`), fullPage: true });
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('.ui-result-actions >> text=Open')]);
  await popup.close();
  // What the tab was opened on: the PDF itself, as a PDF.
  await page.evaluate(() => { window.realOpen = window.open; window.open = (u, target) => { window.opened = [u, target]; return {}; }; });
  await page.click('.ui-result-actions >> text=Open');
  r = await page.evaluate(async () => { const [u, target] = window.opened; const blob = await (await fetch(u)).blob(); window.open = window.realOpen; return { u, target, type: blob.type, size: blob.size }; });
  check('Open shows the PDF in a new tab', r.u.startsWith('blob:') && r.target === '_blank' && r.type === 'application/pdf' && r.size === fx.plain.length, JSON.stringify(r));
  await page.click('.ui-result-actions >> text=Share');
  check('Share hands the PDF over', (await page.evaluate(() => JSON.stringify(window.shared))) === JSON.stringify([[`Report_compressed.pdf:${fx.plain.length}`]]));
  // Start over asks first while not saved.
  await page.click('.ui-result-startover');
  await page.waitForSelector('dialog[open]');
  check('Start over asks while unsaved', (await page.textContent('dialog[open] .ui-dialog-title')) === 'Start over?');
  await page.click('dialog[open] .ui-btn:has-text("Cancel")');
  await page.waitForTimeout(200);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.ui-result-actions >> text=Save to Downloads')]);
  const got = await readDownload(dl);
  check('Save to Downloads: right name and bytes', dl.suggestedFilename() === 'Report_compressed.pdf' && Buffer.compare(Buffer.from(got), Buffer.from(fx.plain)) === 0, dl.suggestedFilename());
  await snackWith(page, 'Saved to Downloads as Report_compressed.pdf');
  await page.waitForTimeout(400);
  r = await page.evaluate(() => ({ hidden: document.querySelector('.ui-result-unsaved').hidden, saved: result.isSaved() }));
  check('saved: the note goes', r.hidden && r.saved, JSON.stringify(r));
  await page.click('.ui-result-actions >> text=Save as…');
  await snackWith(page, 'Saved');
  check('Save as writes the bytes', await page.evaluate(() => written['Report_compressed.pdf']?.length === fx.plain.length));
  const recent = await page.evaluate(async () => (await (await import('./js/core/recent.js')).listRecent()).map((f) => f.name));
  check('saved files go on Recent files', recent.filter((n) => n === 'Report_compressed.pdf').length >= 1, JSON.stringify(recent));
  await page.click('.ui-result-startover');
  check('Start over once saved doesn\'t ask', await page.evaluate(() => log.includes('start over') && !document.querySelector('dialog[open]')));
  await page.click('.ui-topbar [aria-label="Back to editing"]');
  check('Back', await page.evaluate(() => log.includes('back')));
  await clearSnacks(page);

  // Several PDFs: Share all, Save to Downloads, Save to folder…, ZIP, and each its own buttons.
  const parts = await page.evaluate(() => [1, 2, 3].map((n) => ({ name: `Report_split_${n}.pdf`, bytes: fx.plain.slice(), type: 'application/pdf', pageCount: n })));
  await page.evaluate((parts) => {
    window.log = [];
    window.parts = parts.map((p) => ({ ...p, bytes: fx.plain }));
    window.result = kit.output.showResult(document.getElementById('root'), { files: window.parts, zipName: 'Report_split', onStartOver: () => log.push('start over') });
  }, parts);
  r = await page.evaluate(() => ({
    heading: document.querySelector('.ui-result-heading').textContent,
    buttons: [...document.querySelectorAll('.ui-result-actions .ui-btn')].map((b) => b.textContent),
    rows: [...document.querySelectorAll('.ui-result-file')].map((li) => [...li.querySelectorAll('.ui-result-row-buttons .ui-btn')].map((b) => b.getAttribute('aria-label')).join('/')),
    details: [...document.querySelectorAll('.ui-result-details')].map((d) => d.textContent.split(' · ')[0]),
  }));
  check('result screen for several PDFs', r.heading === 'Your PDFs are ready' && r.buttons.join('|') === 'Share all|Save to Downloads|Save to folder…|Share or save as ZIP'
    && r.rows[0] === 'Open Report_split_1.pdf/Share Report_split_1.pdf/Save Report_split_1.pdf' && r.details.join() === '1 page,2 pages,3 pages', JSON.stringify(r));
  await page.screenshot({ path: join(shots, `result-many-${wide ? 'desktop' : 'phone'}.png`), fullPage: true });
  // One file on its own: Save offers Downloads and Save as.
  await page.click('[aria-label="Save Report_split_2.pdf"]');
  check('a file\'s own Save offers both', (await page.evaluate(() => [...document.querySelectorAll('.ui-menu .ui-menu-item')].map((b) => b.textContent).join('|'))) === 'Save to Downloads|Save as…');
  const [one] = await Promise.all([page.waitForEvent('download'), page.click('.ui-menu >> text=Save to Downloads')]);
  check('a file saved on its own', one.suggestedFilename() === 'Report_split_2.pdf');
  await page.waitForFunction(() => !document.querySelectorAll('.ui-result-saved')[1].hidden);
  check('it is marked saved, the others not', await page.evaluate(() => [...document.querySelectorAll('.ui-result-saved')].map((s) => s.hidden).join() === 'true,false,true' && !result.isSaved()));
  await page.click('.ui-result-actions >> text=Save to folder…');
  await snackWith(page, 'Saved 3 PDFs to the folder');
  r = await page.evaluate(() => Object.keys(folderFiles));
  check('Save to folder: a name taken gets (1)', r.join('|') === 'Report_split_1.pdf|Report_split_1 (1).pdf|Report_split_2.pdf|Report_split_3.pdf', r.join('|'));
  await page.click('.ui-result-actions >> text=Save to folder…');
  await page.waitForTimeout(300);
  r = await page.evaluate(() => Object.keys(folderFiles));
  check('saving into the same folder again copies nothing twice', r.length === 4, r.join('|'));
  check('all saved', await page.evaluate(() => result.isSaved()));
  // ZIP: Share ZIP, Save ZIP to Downloads, Save ZIP as….
  await page.click('.ui-result-actions >> text=Share or save as ZIP');
  check('the ZIP menu', (await page.evaluate(() => [...document.querySelectorAll('.ui-menu .ui-menu-item')].map((b) => b.textContent).join('|'))) === 'Share ZIP|Save ZIP to Downloads|Save ZIP as…');
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.click('.ui-menu >> text=Save ZIP to Downloads')]);
  const zip = unzipSync(await readDownload(zdl));
  check('ZIP named after the run, with every PDF', zdl.suggestedFilename() === 'Report_split.zip' && Object.keys(zip).join('|') === 'Report_split_1.pdf|Report_split_2.pdf|Report_split_3.pdf'
    && Buffer.compare(Buffer.from(zip['Report_split_3.pdf']), Buffer.from(fx.plain)) === 0, zdl.suggestedFilename() + ' ' + Object.keys(zip).join('|'));
  await page.click('.ui-result-actions >> text=Share or save as ZIP');
  await page.click('.ui-menu >> text=Share ZIP');
  await page.waitForFunction(() => window.shared.length >= 1);
  check('Share ZIP', (await page.evaluate(() => window.shared.at(-1)[0])).startsWith('Report_split.zip:'));
  await page.click('.ui-result-actions >> text=Share all');
  check('Share all', (await page.evaluate(() => window.shared.at(-1).length)) === 3);
  await clearSnacks(page);

  // Without share or pickers (Firefox, say): what the browser can do, and nothing else.
  await page.evaluate(() => {
    delete window.showSaveFilePicker; delete window.showDirectoryPicker;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined;
    kit.output.showResult(document.getElementById('root'), { files: window.parts, zipName: 'Report_split' });
  });
  r = await page.evaluate(() => ({ buttons: [...document.querySelectorAll('.ui-result-actions .ui-btn')].map((b) => b.textContent + ':' + b.className.match(/ui-btn--\w+/)[0]), rows: [...document.querySelectorAll('.ui-result-file')][0].querySelectorAll('.ui-result-row-buttons .ui-btn').length }));
  check('only what the browser can do', r.buttons.join('|') === 'Save to Downloads:ui-btn--filled|Share or save as ZIP:ui-btn--outlined' && r.rows === 2, JSON.stringify(r));
  const [direct] = await Promise.all([page.waitForEvent('download'), page.click('[aria-label="Save Report_split_1.pdf"]')]);
  check('Save goes straight to Downloads without a picker', direct.suggestedFilename() === 'Report_split_1.pdf');
  await clearSnacks(page);
}

// ---------------------------------------------------------------------------------------------
// batch.js

async function testBatch(page) {
  // BatchChoicesTest, in the page.
  let r = await page.evaluate(() => {
    const { BatchChoices } = kit.batch;
    const start = new BatchChoices([], 1).following([10, 20, 30]);
    const out = {};
    out.a = [start.files.map((f) => f.id).join(), start.files.map((f) => f.choice).join(), start.files.map((f) => f.name).join(), start.common, start.choiceOf(99), start.nameOf(99)];
    const extreme = start.withAll(2);
    const oneLess = extreme.withChoice(20, 0);
    const added = oneLess.following([10, 20, 30, 40]);
    out.b = [extreme.files.map((f) => f.choice).join(), extreme.common, oneLess.files.map((f) => f.choice).join(), oneLess.common, added.choiceOf(40), added.choiceOf(20),
      added.withAll(1).files.map((f) => f.choice).join(), oneLess.withChoice(99, 1).equals(oneLess)];
    const each = start.withChoice(10, 2).withChoice(20, 2).withChoice(30, 2);
    const left = start.withChoice(10, 0).following([10]);
    out.c = [each.common, each.following([10, 20, 30, 40]).choiceOf(40), each.following([10, 20, 30, 40]).common, left.all, left.following([10, 50]).choiceOf(50)];
    const chosen = start.withName(30, 'Thirty').withChoice(30, 0);
    const next = chosen.following([30, 10]);
    out.d = [next.files.map((f) => f.id).join(), next.nameOf(30), next.choiceOf(30), next.nameOf(20), next.following([30, 10, 20]).nameOf(20), next.following([30, 10, 10]) === next, chosen.following([]).equals(new BatchChoices([], 1))];
    const named = start.withName(10, ' my report.pdf ');
    out.e = [named.nameOf(10), named.withName(10, null).nameOf(10), named.withName(99, 'x').equals(named)];
    const packed = start.withAll(2).withChoice(20, 0).withName(10, 'Été / notes').withName(30, '');
    out.f = [BatchChoices.from(JSON.parse(JSON.stringify(packed))).equals(packed), BatchChoices.from(null, 2).equals(new BatchChoices([], 2)), BatchChoices.from({ files: [{ id: 1 }], all: 1 }).equals(new BatchChoices([], 0))];
    return out;
  });
  check('BatchChoices: files added start with the choice for all', JSON.stringify(r.a) === JSON.stringify(['10,20,30', '1,1,1', ',,', 1, 1, null]), JSON.stringify(r.a));
  check('BatchChoices: choice for all, then one of its own', JSON.stringify(r.b) === JSON.stringify(['2,2,2', 2, '2,0,2', null, 2, 0, '1,1,1,1', true]), JSON.stringify(r.b));
  check('BatchChoices: a file added takes the choice the others all have', JSON.stringify(r.c) === JSON.stringify([2, 2, 2, 0, 0]), JSON.stringify(r.c));
  check('BatchChoices: following', JSON.stringify(r.d) === JSON.stringify(['30,10', 'Thirty', 0, null, null, true, true]), JSON.stringify(r.d));
  check('BatchChoices: names as typed', JSON.stringify(r.e) === JSON.stringify([' my report.pdf ', null, true]), JSON.stringify(r.e));
  check('BatchChoices: kept and taken back', r.f.every(Boolean), JSON.stringify(r.f));

  // The list: a card per file, its own level, its name with .pdf.
  await page.evaluate(() => {
    window.log = [];
    window.names = { 1: 'alpha_compressed', 2: 'beta_compressed', 3: 'gamma_compressed' };
    window.levels = { 1: 1, 2: 1, 3: 2 };
    window.items = [{ id: 1, name: 'alpha.pdf', detail: '3 pages · 2.4 kB' }, { id: 2, name: 'beta.pdf', detail: '1 page · 1.9 kB' }, { id: 3, name: 'gamma.pdf', detail: '7 pages · 619 kB' }];
    window.blist = kit.batch.batchList({
      items,
      nameOf: (id) => names[id],
      onRename: (id, n) => { names[id] = n; log.push(`rename:${id}:${n}`); },
      onRemove: (id) => { log.push('remove:' + id); items = items.filter((i) => i.id !== id); blist.setItems(items); },
      onAdd: () => log.push('add'),
      choice: { label: 'Compression', options: [{ value: 0, label: 'Less' }, { value: 1, label: 'Recommended' }, { value: 2, label: 'Extreme' }], valueOf: (id) => levels[id], onChange: (id, v) => { levels[id] = v; log.push(`level:${id}:${v}`); } },
    });
    mount(blist);
  });
  r = await page.evaluate(() => ({
    cards: [...blist.querySelectorAll('.ui-file-card')].map((c) => c.querySelector('.ui-file-name').textContent + '|' + c.querySelector('.ui-file-detail').textContent),
    fields: [...blist.querySelectorAll('.ui-field-input')].map((i) => i.value), suffix: blist.querySelector('.ui-field-suffix').textContent,
    label: blist.querySelector('.ui-field-label').textContent, chosen: [...blist.querySelectorAll('.ui-segmented')].map((s) => s.value).join(),
    group: document.getElementById(blist.querySelector('.ui-segmented').getAttribute('aria-labelledby')).textContent,
    add: blist.querySelector('.ui-batch-add').textContent,
  }));
  check('batch list', r.cards[0] === 'alpha.pdf|3 pages · 2.4 kB' && r.fields.join() === 'alpha_compressed,beta_compressed,gamma_compressed' && r.suffix === '.pdf'
    && r.label === 'File name' && r.chosen === '1,1,2' && r.group === 'Compression' && r.add === 'Add PDFs', JSON.stringify(r));
  await page.screenshot({ path: join(shots, 'batch-phone.png'), fullPage: true });
  await page.fill('.ui-batch-item:nth-child(3) .ui-field-input', 'My gamma');
  await page.click('.ui-batch-item:nth-child(2) .ui-segment >> text=Less');
  await page.click('[aria-label="Remove alpha.pdf"]');
  r = await page.evaluate(() => ({
    log: log.slice(-3), fields: [...blist.querySelectorAll('.ui-field-input')].map((i) => i.value), focus: document.activeElement.getAttribute('aria-label'),
  }));
  check('renaming, a level of its own, removing keeps what is typed', r.log.join('|') === 'rename:3:My gamma|level:2:0|remove:1' && r.fields.join() === 'beta_compressed,My gamma' && r.focus === 'Remove beta.pdf', JSON.stringify(r));
  await page.click('.ui-batch-add');
  check('Add PDFs', await page.evaluate(() => log.at(-1) === 'add'));
  await page.evaluate(() => { levels[2] = 2; levels[3] = 2; blist.refreshChoices(); });
  check('refreshChoices', (await page.evaluate(() => [...blist.querySelectorAll('.ui-segmented')].map((s) => s.value).join())) === '2,2');

  // runBatch: "PDF 2 of 4" and the name, failures named, the others still made.
  await page.evaluate(() => {
    const { UserError } = kit.errors;
    window.runs = kit.batch.runBatch([{ name: 'a.pdf' }, { name: 'b.pdf' }, { name: 'c.pdf' }, { name: 'd.pdf' }, { name: 'e.pdf' }], async (item, i, { onProgress, signal }) => {
      onProgress(1, 2);
      await new Promise((r) => setTimeout(r, i === 1 ? 900 : 60));
      if (signal.aborted) return null;
      if (item.name === 'c.pdf' || item.name === 'e.pdf') throw new UserError('pdf_certificate_unsupported');
      if (item.name === 'd.pdf') throw new Error('boom');
      return { name: item.name.replace('.pdf', '_done.pdf'), bytes: new Uint8Array([i]), type: 'application/pdf' };
    });
  });
  await page.waitForFunction(() => document.querySelector('.ui-progress-label')?.textContent === 'PDF 2 of 5' && getComputedStyle(document.querySelector('.ui-progress-dialog')).visibility === 'visible');
  r = await page.evaluate(() => ({ title: document.querySelector('.ui-progress-dialog .ui-dialog-title').textContent, name: document.querySelector('.ui-progress-detail').textContent, now: Number(document.querySelector('.ui-progress-dialog [role=progressbar]').getAttribute('aria-valuenow')) }));
  check('runBatch progress', r.title === 'Working on your PDFs…' && r.name === 'b.pdf' && r.now >= 20 && r.now <= 40, JSON.stringify(r));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, 'batch-progress-phone.png') });
  r = await page.evaluate(async () => { const x = await window.runs; return { out: x.outputs.map((o) => o.name), failed: x.failures.map((f) => f.item.name), cancelled: x.cancelled }; });
  check('runBatch makes the others', r.out.join() === 'a_done.pdf,b_done.pdf' && r.failed.join() === 'c.pdf,d.pdf,e.pdf' && !r.cancelled, JSON.stringify(r));
  await snackWith(page, 'c.pdf, e.pdf: These PDFs are locked with a certificate (digital ID). Usugami can only open PDFs locked with a password.');
  await snackWith(page, "Couldn't process d.pdf. Check the file and free storage.", 15000);
  await clearSnacks(page);
  // Cancel: nothing made.
  await page.evaluate(() => {
    window.runs = kit.batch.runBatch([{ name: 'a.pdf' }, { name: 'b.pdf' }], async (item, i, { signal }) => {
      await new Promise((resolve, reject) => { const t = setTimeout(resolve, 5000); signal.addEventListener('abort', () => { clearTimeout(t); reject(new kit.errors.CancelledError()); }); });
      return { name: item.name, bytes: new Uint8Array(1) };
    });
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.ui-progress-dialog')).visibility === 'visible');
  await page.click('dialog[open] .ui-btn:has-text("Cancel")');
  r = await page.evaluate(async () => { const x = await window.runs; return { out: x.outputs.length, cancelled: x.cancelled, open: !!document.querySelector('dialog[open]:not(.is-closing)') }; });
  check('Cancel stops the batch with nothing made', r.out === 0 && r.cancelled && !r.open, JSON.stringify(r));
  // One file works as the tools do for one: its own message.
  r = await page.evaluate(async () => {
    const x = await kit.batch.runBatch([{ name: 'only.pdf' }], async () => { throw new kit.errors.UserError('pdf_import_failed'); }, { delay: 0 });
    return { failed: x.failures.length, title: null };
  });
  await snackWith(page, "Couldn't open that PDF. It may be damaged or unsupported.");
  check('one file failing says why', r.failed === 1);
  await clearSnacks(page);
  r = await page.evaluate(async () => {
    const x = await kit.batch.runBatch([{ name: 'x.pdf' }, { name: 'y.pdf' }], async () => { throw new kit.errors.UserError('page_numbers_all_skipped'); }, { named: { page_numbers_all_skipped: 'batch_failed' } });
    return x.failures.length;
  });
  await snackWith(page, "Couldn't process 2 files: x.pdf, y.pdf. Check the files and free storage.");
  check('named failures together', r === 2);
  await clearSnacks(page);
}

// ---------------------------------------------------------------------------------------------
// Screens to look at: the components together, light and dark.

async function gallery(page, name) {
  await page.evaluate(() => {
    const { topBar, segmented, chips, dropdown, switchRow, slider, textField, button, fab, card, fileCard, emptyState, sectionHeading, listItem, linearProgress, iconButton, bottomBar } = kit.ui;
    const g = document.createElement('div');
    g.style.display = 'flex';
    g.style.flexDirection = 'column';
    g.style.gap = '16px';
    const row = (...n) => { const d = document.createElement('div'); d.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center'; d.append(...n); return d; };
    const thumb = document.createElement('canvas');
    thumb.width = 116; thumb.height = 156;
    const c = thumb.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 116, 156); c.fillStyle = '#b3261e'; c.fillRect(14, 20, 88, 10); c.fillStyle = '#888'; for (let y = 40; y < 140; y += 12) c.fillRect(14, y, 88, 4);
    g.append(
      emptyState({ icon: 'add', title: 'Choose PDFs', detail: 'You can choose several at once.', onClick: () => {}, onFiles: () => {}, accept: 'pdf' }),
      sectionHeading('Organize'),
      card({ icon: 'splitscreen', title: 'Split PDF', detail: 'Extract pages or split into smaller files', onClick: () => {} }),
      fileCard({ name: 'Quarterly report with a long name.pdf', detail: '12 pages · 2.4 MB', thumbnail: thumb, onRemove: () => {} }),
      segmented({ label: 'Compression', value: 1, options: [{ value: 0, label: 'Less' }, { value: 1, label: 'Recommended' }, { value: 2, label: 'Extreme' }] }),
      row(...[dropdown({ label: 'Page size', value: 'a4', options: [{ value: 'a4', label: 'A4' }] }), dropdown({ label: 'Margin', value: 's', options: [{ value: 's', label: 'Small' }] })]),
      chips({ label: 'Look', value: 'b', options: [{ value: 'a', label: 'Original' }, { value: 'b', label: 'Enhanced' }, { value: 'c', label: 'Grayscale' }, { value: 'd', label: 'Black & white' }] }),
      switchRow({ label: 'Merge all images into one PDF', detail: 'One PDF with a page for each image', checked: true }),
      switchRow({ label: 'Arrange individual pages', checked: false }),
      slider({ label: 'Opacity', min: 10, max: 100, value: 40, format: (v) => v + '%' }),
      textField({ label: 'File name', value: 'Usugami_20261109_101500', suffix: '.pdf' }),
      textField({ label: 'Pages', value: '1,3-', error: 'Use page numbers such as 1,3-5.' }),
      linearProgress({ value: 0.4 }),
      row(button({ label: 'Split PDF' }), button({ label: 'Tonal', variant: 'tonal', icon: 'share' }), button({ label: 'Add PDFs', variant: 'outlined' }), button({ label: 'Start over', variant: 'text', icon: 'restart_alt' }), button({ label: 'Off', disabled: true })),
      row(iconButton({ icon: 'undo', label: 'Undo' }), iconButton({ icon: 'delete', label: 'Delete', variant: 'tonal' }), fab({ label: 'Add images', icon: 'add' })),
      listItem({ icon: 'language', title: 'Language', detail: 'English', onClick: () => {} }),
      bottomBar(button({ label: 'Compress 3 PDFs' })),
    );
    const screen = document.createElement('div');
    screen.append(topBar({ title: 'Compress PDF', onBack: () => {}, actions: [{ icon: 'undo', label: 'Undo' }], menu: [{ label: 'x' }] }), g);
    mount(screen);
  });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `gallery-${name}-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  // Nothing sticks out sideways at this width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`no sideways scroll at ${name}`, overflow <= 0, String(overflow));
  // Touch targets: buttons are at least 48 px to tap (40 px drawn, 4 px more each side).
  const small = await page.evaluate(() => [...document.querySelectorAll('.ui-icon-btn')].filter((b) => b.getBoundingClientRect().height < 48).length);
  check('icon buttons are 48 px', small === 0, String(small));
}

// ---------------------------------------------------------------------------------------------

const fx = await fixtures();
let passed = 0;
// KIT_STEPS=pdfdoc,grid runs only the steps whose names contain one of those words (for working on one part).
const only = process.env.KIT_STEPS?.split(',').map((s) => s.trim()).filter(Boolean);
const step = async (name, fn) => {
  if (only && !only.some((s) => name.includes(s))) return;
  const t0 = performance.now();
  await fn();
  passed++;
  console.log(`  ok ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
};

if (!process.env.KIT_ONLY_OTHERS) {
console.log('Phone (360 px), Chromium');
await withPage(async (page, url) => {
  await openKit(page, url);
  await put(page, fx);
  await step('files', () => testFiles(page, fx));
  await step('controls', () => testControls(page));
  await step('dialogs', () => testDialogs(page, { wide: false }));
  await step('cards and drop', () => testCardsAndDrop(page));
  await step('pdfdoc', () => testPdfDoc(page, fx));
  await step('pdfdoc: view, passwords, close', () => testPdfDocMore(page, fx));
  await step('kit additions', () => testKitMore(page, { wide: false, timing: true }));
  await step('page grid', () => testPageGrid(page, { wide: false }));
  await step('touch reordering', () => testTouchReorder(page));
  await step('output', () => testOutput(page, fx, { wide: false }));
  await step('batch', () => testBatch(page));
  await step('gallery', () => gallery(page, 'phone'));
}, { viewport: PHONE });

console.log('Desktop (1366 px), Chromium');
await withPage(async (page, url) => {
  await openKit(page, url);
  await put(page, fx);
  await step('dialogs', () => testDialogs(page, { wide: true }));
  await step('kit additions', () => testKitMore(page, { wide: true, timing: true }));
  await step('page grid', () => testPageGrid(page, { wide: true }));
  await step('output', () => testOutput(page, fx, { wide: true }));
  await step('gallery', () => gallery(page, 'desktop'));
}, { viewport: DESKTOP, mobile: false });

}
for (const browser of ['firefox', 'webkit']) {
  console.log(`Phone (360 px), ${browser}`);
  await withPage(async (page, url) => {
    await openKit(page, url);
    await put(page, fx);
    await step(`${browser}: controls`, () => testControls(page));
    // Firefox (as Playwright drives it) sends cancel before change when files are chosen.
    await step(`${browser}: picking files`, () => testPick(page, fx, { cancel: browser === 'firefox' }));
    await step(`${browser}: dialogs`, () => testDialogs(page, { wide: false }));
    await step(`${browser}: pdfdoc`, () => testPdfDoc(page, fx));
    await step(`${browser}: pdfdoc: view, passwords, close`, () => testPdfDocMore(page, fx));
    await step(`${browser}: kit additions`, () => testKitMore(page, { wide: false }));
    await step(`${browser}: page grid`, () => testPageGrid(page, { wide: false }));
    await step(`${browser}: gallery`, () => gallery(page, `phone-${browser}`));
  }, { browser, viewport: PHONE });
}

console.log(`kit: ${passed} groups passed`);
