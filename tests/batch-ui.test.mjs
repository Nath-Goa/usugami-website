// Compress PDF and Flatten PDF (js/tools/compress, js/tools/flatten): both screens driven in the
// app as a person would, by touch at phone size and by mouse and keyboard at desktop size, with
// several PDFs (one not a PDF, one damaged so it can't be read, one with nothing to compress or
// flatten), each PDF's own level and name, and the PDFs made read back (names, sizes, image sizes,
// text with pdf.js, the form left or gone with pdf-lib). Then Firefox and WebKit at phone size.
//
// Run with: node tests/batch-ui.test.mjs   (--quick: Chromium only, no screenshots)
// Screenshots go to .tmp/batch-ui/screens/ to be looked at.
import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { withPage, assert, root, runInPage } from './harness.mjs';
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFBool, PDFDict, PDFArray, StandardFonts,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from '../site/app/js/lib/pdf-lib.js';
import common from '../site/app/locales/en/common.js';
import kit from '../site/app/locales/en/kit.js';
import compressStrings from '../site/app/locales/en/compress.js';
import flattenStrings from '../site/app/locales/en/flatten.js';
import { markPdf, mayCarryMark, MarkStyle } from '../site/app/js/engine/page-mark.js';

const QUICK = process.argv.includes('--quick');
const shots = join(root, '.tmp', 'batch-ui', 'screens');
await mkdir(shots, { recursive: true });
const appAssets = join(root, '..', 'pdfer', 'app', 'src', 'androidTest', 'assets');
const exists = (p) => access(p).then(() => true, () => false);

const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 900 };
const A4 = [595.28, 841.89];

// ---------------------------------------------------------------------------------------------
// Strings, as the screens should show them

const S = { ...common, ...kit, ...compressStrings, ...flattenStrings };
const fill = (text, args) => text.replace(/\{(\d+)\}/g, (m, n) => String(args[n - 1] ?? m));
const say = (key, ...args) => fill(S[key], args);
const sayN = (key, count, ...args) => {
  const v = S[key];
  return fill(count === 1 ? v.one : v.other, args.length ? args : [count]);
};

let checks = 0;
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what}: expected ${e}, got ${a}`);
  checks++;
}
function ok(condition, what) {
  assert(condition, what);
  checks++;
}

// ---------------------------------------------------------------------------------------------
// Fixtures, made with pdf-lib

/** RGB pixels that look like a photo to a compressor: colour ramps with grain. */
function photoPixels(w, h, seed) {
  let s = seed >>> 0;
  const grain = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 26);
  const px = new Uint8Array(w * h * 3);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 3) {
      px[i] = (x * 200 / w + grain()) & 255;
      px[i + 1] = (y * 200 / h + grain()) & 255;
      px[i + 2] = (120 + grain()) & 255;
    }
  }
  return px;
}

/** Rows alike: almost nothing to store, but every pixel still has to be read and encoded. */
function rampPixels(w, h) {
  const row = new Uint8Array(w * 3);
  for (let x = 0; x < w; x++) row.set([x & 255, (x >> 2) & 255, 255 - (x & 255)], x * 3);
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) px.set(row, y * w * 3);
  return px;
}

async function writeText(doc, page, text, x, y, size = 24) {
  page.drawText(text, { x, y, size, font: await doc.embedFont(StandardFonts.Helvetica) });
}

/**
 * A "scan": `pages` A4 pages, each with a picture of w x h pixels stored without loss (Flate), drawn
 * 400 x 500 points (so 0.5 pt a pixel at 800 wide: Less and Recommended keep 800, Extreme 555).
 */
async function scanPdf(label, { w = 800, h = 1000, pages = 1, seed = 7, ramp = false } = {}) {
  const doc = await PDFDocument.create();
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(A4);
    const pixels = ramp ? rampPixels(w, h) : photoPixels(w, h, seed + p);
    const image = doc.context.register(doc.context.flateStream(pixels, {
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    }));
    const name = page.node.newXObject('Im', image);
    const [pw, ph] = ramp ? [A4[0], A4[1]] : [400, 500];
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(pw, 0, 0, ph, ramp ? 0 : 97, ramp ? 0 : 170), drawObject(name), popGraphicsState());
    await writeText(doc, page, `${label} ${p + 1}`, 72, 760);
  }
  return doc.save();
}

/** Text only: nothing to compress. */
async function textPdf(text) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  await writeText(doc, page, text, 72, 760);
  return doc.save();
}

/** `bytes` without its "%PDF-" header: pdf.js still shows it, but the tools can't read it. */
function headerless(bytes) {
  const out = Uint8Array.from(bytes);
  out.set([0x25, 0x58, 0x58, 0x58, 0x2d], 0);
  return out;
}

function form(doc, content, bbox, extra = {}) {
  return doc.context.register(doc.context.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: bbox, ...extra }));
}
function annot(doc, page, dict) {
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  return ref;
}
function helvetica(doc) {
  return doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
}
function newForm(doc, helv, extra = {}) {
  const acro = doc.context.obj({ Fields: [], DR: { Font: { Helv: helv } }, DA: PDFString.of('/Helv 0 Tf 0 g'), ...extra });
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro));
  return acro;
}
function textField(doc, page, acro, name, rect, { value, ap, da = '/Helv 12 Tf 0 g', extra = {} } = {}) {
  const dict = { Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of(name), Rect: rect, F: 4, DA: PDFString.of(da), P: page.ref, ...extra };
  if (value !== undefined) dict.V = PDFHexString.fromText(value);
  if (ap) dict.AP = { N: ap };
  const ref = annot(doc, page, dict);
  doc.context.lookup(acro.get(PDFName.of('Fields'))).push(ref);
  return ref;
}

/**
 * As the app's TestPdfs.formPdf: "FORM PAGE" with a text field "name" holding `name` (drawn), a
 * field "city" holding "Lisbon" never drawn, and a red square comment with no look of its own.
 * With xfa, a dynamic XFA form too.
 */
async function formPdf({ name = 'Jane Doe', xfa = false } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  await writeText(doc, page, 'FORM PAGE', 72, 760);
  const helv = helvetica(doc);
  const acro = newForm(doc, helv);
  textField(doc, page, acro, 'name', [72, 600, 322, 624], {
    value: name,
    ap: form(doc, `/Tx BMC q BT /Helv 12 Tf 0 g 2 7 Td (${name}) Tj ET Q EMC`, [0, 0, 250, 24], { Resources: { Font: { Helv: helv } } }),
  });
  textField(doc, page, acro, 'city', [72, 560, 322, 584], { value: 'Lisbon' });
  annot(doc, page, { Type: 'Annot', Subtype: 'Square', Rect: [350, 300, 500, 400], C: [1, 0, 0], IC: [1, 0, 0], F: 4 });
  if (xfa) {
    acro.set(PDFName.of('XFA'), doc.context.register(doc.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>')));
    doc.catalog.set(PDFName.of('NeedsRendering'), PDFBool.True);
  }
  return doc.save({ updateFieldAppearances: false });
}

/** As the app's unencodableFormPdf: "₹ 5,000" and "नाम" in Helvetica, to be drawn by viewers. */
async function unencodableFormPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const helv = helvetica(doc);
  const acro = newForm(doc, helv, { NeedAppearances: true });
  textField(doc, page, acro, 'amount', [72, 600, 322, 624], { value: '₹ 5,000' });
  textField(doc, page, acro, 'name', [72, 560, 322, 584], { value: 'नाम' });
  return doc.save({ updateFieldAppearances: false });
}

/** As the app's xfaOnlyPdf: its only form is a dynamic XFA form. */
async function xfaOnlyPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  await writeText(doc, page, 'Please wait while the form loads', 72, 760);
  const acro = newForm(doc, helvetica(doc));
  acro.set(PDFName.of('XFA'), doc.context.register(doc.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>')));
  doc.catalog.set(PDFName.of('NeedsRendering'), PDFBool.True);
  return doc.save();
}

async function fixtures() {
  const f = (name, bytes) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  const scan = await scanPdf('SCAN', { seed: 7 });
  const scan2 = await scanPdf('SECOND SCAN', { seed: 11 });
  const compact = await textPdf('ALREADY COMPACT');
  const lockedPath = join(appAssets, 'protected.pdf');
  let locked;
  if (await exists(lockedPath)) {
    locked = f('statement.pdf', await readFile(lockedPath));
  } else {
    const doc = await PDFDocument.load(await textPdf('LOCKED'));
    await doc.encrypt({ userPassword: 'test123', ownerPassword: 'owner123' });
    locked = f('statement.pdf', await doc.save());
  }
  const big = [];
  for (let i = 1; i <= 4; i++) big.push(f(`big ${i}.pdf`, await scanPdf(`BIG ${i}`, { w: 2800, h: 2800, pages: 4, ramp: true })));
  return {
    scan: f('scan.pdf', scan),
    scan2: f('scan2.pdf', scan2),
    compact: f('compact.pdf', compact),
    junk: f('junk.pdf', Buffer.from('not a PDF at all')),
    junk2: f('junk2.pdf', Buffer.from('not a PDF either')),
    broken: f('broken.pdf', headerless(scan)),
    broken2: f('broken2.pdf', headerless(compact)),
    locked,
    big,
    form: f('form.pdf', await formPdf()),
    alpha: f('alpha.pdf', await textPdf('ALPHA')),
    amounts: f('amounts.pdf', await unencodableFormPdf()),
    brokenForm: f('broken form.pdf', headerless(await formPdf({ name: 'Broken' }))),
    tax: f('tax form.pdf', await xfaOnlyPdf()),
    visa: f('visa form.pdf', await xfaOnlyPdf()),
    permit: f('permit.pdf', await formPdf({ name: 'Ana Lima', xfa: true })),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the PDFs made

async function imagesOf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj?.dict;
    if (!(dict instanceof PDFDict) || String(dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
    out.push({ width: dict.get(PDFName.of('Width')).asNumber(), height: dict.get(PDFName.of('Height')).asNumber(), filter: String(dict.get(PDFName.of('Filter'))) });
  }
  return out;
}

async function formOf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (!(acro instanceof PDFDict)) return null;
  const fields = acro.lookup(PDFName.of('Fields'));
  return {
    fields: fields instanceof PDFArray ? fields.size() : 0,
    needAppearances: acro.get(PDFName.of('NeedAppearances')) === PDFBool.True,
    xfa: acro.has(PDFName.of('XFA')),
  };
}

async function encrypted(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return doc.isEncrypted;
}

/** Each page's text, and the annotations pdf.js finds on it, read in the page. */
async function readBack(page, bytes) {
  return page.evaluate(async (b64) => {
    const { openPdfJs } = await import(new URL('js/lib/pdfjs.js', location.href).href);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await openPdfJs(data);
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const content = await p.getTextContent();
      const annots = await p.getAnnotations();
      // The colour where the red square comment was.
      const viewport = p.getViewport({ scale: 0.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await p.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, annotationMode: 0 }).promise;
      const [x, y] = viewport.convertToViewportPoint(425, 350);
      const rgb = [...canvas.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
      out.push({ text: content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim(), annots: annots.map((a) => a.subtype), rgb });
    }
    await doc.loadingTask.destroy();
    return out;
  }, Buffer.from(bytes).toString('base64'));
}

// ---------------------------------------------------------------------------------------------
// Driving the app

/** Waits for `selector`, discarding unsaved work when leaving a screen asks about it. */
async function arrive(page, selector) {
  const discard = `dialog[open] .ui-btn:has-text("${S.discard}")`;
  await page.waitForSelector(`${selector}, ${discard}`, { timeout: 20000 });
  if (await page.$(discard)) await page.click(discard);
  await page.waitForSelector(selector, { timeout: 20000 });
}

/** Opens the tool afresh: by way of Home when the app already shows, so it mounts anew. */
async function openTool(page, url, tool) {
  if (page.url().includes('/app/')) {
    await page.evaluate(() => { location.hash = '#/'; });
    await arrive(page, '#app .screen[data-route="home"]:not([aria-busy])');
    await page.evaluate((id) => { location.hash = '#/tool/' + id; }, tool);
  } else {
    await page.goto(url + 'app/#/tool/' + tool);
    await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  }
  await arrive(page, `#app .screen[data-tool="${tool}"]:not([aria-busy]) .compress-content`);
  await snackbarsGone(page);
}

async function press(page, selector, { touch }) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  if (touch) await target.tap(); else await target.click();
}

/**
 * Picks `files` with the button `selector` opens, through the real file input in every browser (the
 * kit's pickFiles takes the files of Playwright's Firefox, which sends the input's cancel event just
 * before its change event).
 */
async function pickWith(page, selector, files, { touch = false } = {}) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), press(page, selector, { touch })]);
  await chooser.setFiles(files);
}

/** Drops PDFs on `target`, as dragged from the computer's files. */
async function drop(page, files, target) {
  const dt = await page.evaluateHandle((list) => {
    const data = new DataTransfer();
    for (const { name, b64 } of list) data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'application/pdf' }));
    return data;
  }, files.map((f) => ({ name: f.name, b64: f.buffer.toString('base64') })));
  await page.dispatchEvent(target, 'dragenter', { dataTransfer: dt });
  ok(await page.evaluate((t) => document.querySelector(t).classList.contains('is-dragover'), target), 'shows where they go');
  await page.dispatchEvent(target, 'drop', { dataTransfer: dt });
}

/** Waits until `n` PDFs are listed and none is being opened. */
async function listed(page, n) {
  await page.waitForFunction((n) => {
    const shown = n === 0 ? document.querySelector('.compress-content--empty')
      : n === 1 ? document.querySelector('.compress-content--one .compress-card')
        : document.querySelectorAll('.compress-content--many .ui-batch-item').length === n;
    return shown && document.querySelector('.compress-progress')?.hidden;
  }, n, { timeout: 30000 });
  checks++;
}

const cardNames = (page) => page.$$eval('.compress-content .ui-file-card .ui-file-name', (els) => els.map((e) => e.textContent));
const cardDetails = (page) => page.$$eval('.compress-content .ui-file-card .ui-file-detail', (els) => els.map((e) => e.textContent));
const nameFields = (page) => page.$$eval('.compress-content .ui-field-input', (els) => els.map((e) => e.value));
const runLabel = (page) => page.textContent('.compress-run');
/** The level checked in each PDF's own segmented buttons, then the one for all (null: none). */
async function levels(page) {
  return page.evaluate(() => {
    const checked = (group) => {
      const b = [...group.querySelectorAll('.ui-segment')].findIndex((s) => s.getAttribute('aria-checked') === 'true');
      return b < 0 ? null : b;
    };
    return {
      each: [...document.querySelectorAll('.ui-batch-item .ui-segmented')].map(checked),
      all: checked(document.querySelector('.compress-options .ui-segmented')),
    };
  });
}
const itemSelector = (i) => `.ui-batch-item:nth-child(${i + 1})`;
const handleState = (page) => page.evaluate(async () => (await import(new URL('js/core/router.js', location.href).href)).currentHandle().state);

/** The next snackbar's text (waiting for it), after which it is sent away. */
async function nextSnack(page) {
  const text = await page.waitForFunction(() => {
    const s = [...document.querySelectorAll('.ui-snackbar')].find((n) => n.classList.contains('is-shown'));
    return s ? s.querySelector('.ui-snackbar-text').textContent : null;
  }, null, { timeout: 30000 }).then((h) => h.jsonValue());
  await page.evaluate((t) => [...document.querySelectorAll('.ui-snackbar')].find((n) => n.querySelector('.ui-snackbar-text').textContent === t)?.dismiss(), text);
  await page.waitForFunction((t) => ![...document.querySelectorAll('.ui-snackbar-text')].some((n) => n.textContent === t), text, { timeout: 5000 });
  return text;
}
async function snack(page, expected, what) {
  eq(await nextSnack(page), expected, what);
}
async function noSnack(page, ms = 600) {
  await page.waitForTimeout(ms);
  eq(await page.$$eval('.ui-snackbar-text', (els) => els.map((e) => e.textContent)), [], 'nothing more said');
}
async function snackbarsGone(page) {
  await page.evaluate(() => document.querySelectorAll('.ui-snackbar').forEach((s) => s.dismiss?.()));
}

/** Presses the main button and waits for the result screen; returns its files. */
async function runToResult(page, { touch }) {
  await press(page, '.compress-run', { touch });
  await page.waitForSelector('.ui-result', { timeout: 90000 });
  return resultFiles(page);
}
async function resultFiles(page) {
  const files = await page.evaluate(() => {
    const b64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return document.querySelector('.ui-result').files.map((f) => ({
      name: f.name, originalSize: f.originalSize ?? null, keptOriginal: !!f.keptOriginal, keptFields: f.keptFields ?? null, b64: b64(f.bytes),
    }));
  });
  return files.map((f) => ({ ...f, bytes: new Uint8Array(Buffer.from(f.b64, 'base64')) }));
}
const resultRows = (page) => page.$$eval('.ui-result-file', (rows) => rows.map((r) => ({
  name: r.querySelector('.ui-result-name').textContent,
  extra: r.querySelector('.ui-result-extra')?.textContent ?? null,
})));

async function backToEditing(page, { browserBack = false, touch = false } = {}) {
  if (browserBack) await page.goBack();
  else await press(page, '.ui-result .ui-topbar-nav', { touch });
  await page.waitForSelector('.ui-result', { state: 'detached' });
  await page.waitForSelector('.compress-content');
  checks++;
}

async function checkNoSideways(page, what) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `${what}: nothing scrolls sideways (${overflow} px)`);
}

async function shot(page, name, { full = true } = {}) {
  if (QUICK) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full });
}
async function themes(page, name, options) {
  if (QUICK) return;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(page, `${name}-${scheme}`, options);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

// ---------------------------------------------------------------------------------------------
// In Node: helpers and strings

async function testStrings() {
  const xml = await readFile(join(appAssets, '..', '..', 'main', 'res', 'values', 'strings.xml'), 'utf8').catch(() => null);
  if (!xml) {
    console.log('skip strings.xml check (the app is not next to the site)');
    return;
  }
  const android = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/%(\d)\$[sd]/g, '{$1}').replace(/%[sd]/g, '{1}');
  for (const strings of [compressStrings, flattenStrings]) {
    for (const [key, value] of Object.entries(strings)) {
      if (key.startsWith('web_')) continue;
      if (typeof value === 'string') {
        const m = xml.match(new RegExp(`<string name="${key}"[^>]*>([\\s\\S]*?)</string>`));
        ok(m, `${key} is in strings.xml`);
        eq(value, android(m[1]), `${key} as in strings.xml`);
      } else {
        const m = xml.match(new RegExp(`<plurals name="${key}">([\\s\\S]*?)</plurals>`));
        ok(m, `${key} is a plural in strings.xml`);
        for (const [, q, text] of m[1].matchAll(/<item quantity="(\w+)">([\s\S]*?)<\/item>/g)) eq(value[q], android(text), `${key} (${q}) as in strings.xml`);
      }
      ok(!(key in common) && !(key in kit), `${key} isn't redefined from common.js or kit.js`);
    }
  }
  // The keys the engines' notes and errors use are all defined somewhere loaded.
  for (const key of ['pdf_no_reduction', 'pdf_not_smaller', 'batch_not_smaller', 'batch_failed', 'pdf_import_failed', 'pdf_process_failed',
    'flatten_nothing', 'flatten_xfa_only', 'flatten_xfa_only_many', 'flatten_xfa_dropped', 'flatten_xfa_dropped_many',
    'flatten_fields_kept', 'flatten_fields_kept_many', 'batch_nothing_to_flatten', 'file_problem', 'compressed_from', 'original_kept']) {
    ok(S[key] !== undefined, `${key} is defined`);
  }
  console.log('ok strings as in strings.xml');
}

async function testHelpers(page, url) {
  const call = (mod, name, ...args) => runInPage(page, url, mod, name, ...args);
  const compress = 'app/js/tools/compress/index.js';
  eq(await call(compress, 'levelOf', 0), 'less', 'choice 0');
  eq(await call(compress, 'levelOf', 1), 'recommended', 'choice 1');
  eq(await call(compress, 'levelOf', 2), 'extreme', 'choice 2');
  eq(await call(compress, 'levelOf', 7), 'recommended', 'a choice out of range: Recommended, as compressionOf');
  for (const name of ['Report.pdf', 'scan.v2.PDF', '', '...', 'a'.repeat(300) + '.pdf', 'नाम.pdf']) {
    eq(await call(compress, 'defaultCompressName', { name }), await call('app/js/engine/compress.js', 'defaultCompressName', { name }), `the screen's default name is the engine's (${name.slice(0, 20)})`);
  }
  eq(await call(compress, 'defaultCompressName', { name: 'Report.pdf' }), 'Report_compressed', 'Report_compressed');
  eq(await call('app/js/tools/flatten/index.js', 'defaultFlattenName', { name: 'form.pdf' }), 'form_flattened', 'form_flattened');
  eq(await call('app/js/tools/flatten/index.js', 'defaultFlattenName', { name: '' }), 'Usugami_flattened', 'nameless: Usugami_flattened');
  console.log('ok helpers');
}

// ---------------------------------------------------------------------------------------------
// Compress PDF

async function testCompress(page, url, fx, { touch, label }) {
  const opts = { touch };
  await openTool(page, url, 'compress');
  eq(await page.textContent('.ui-topbar-title'), common.tool_compress, 'title');
  eq(await page.textContent('.ui-empty-title'), common.pick_pdfs, 'Choose PDFs');
  eq(await page.textContent('.ui-empty-detail'), common.pick_several_hint, 'several at once');
  eq(await runLabel(page), S.pdf_compress_action, 'the button before a PDF');
  ok(await page.$eval('.compress-run', (b) => b.disabled), 'off without a PDF');
  await checkNoSideways(page, 'empty');
  await themes(page, `compress-${label}-empty`);

  // Four picked together: one isn't a PDF, and is named; the others are listed.
  await pickWith(page, '.ui-empty', [fx.scan, fx.junk, fx.compact, fx.broken], opts);
  await listed(page, 3);
  await snack(page, say('file_problem', 'junk.pdf', S.pdf_import_failed), 'the one that isn\'t a PDF is named');
  eq(await cardNames(page), ['scan.pdf', 'compact.pdf', 'broken.pdf'], 'listed in order');
  const details = await cardDetails(page);
  ok(details.every((d) => /^1 page · [\d.]+ (kB|MB|B)$/.test(d)), `pages and size: ${details}`);
  eq(await runLabel(page), sayN('pdf_compress_action_many', 3), 'Compress 3 PDFs');
  eq(await page.textContent('.compress-options .compress-heading'), S.compression_for_all, 'the level for all');
  eq(await page.textContent('.compress-options .compress-note'), `${S.compression_for_all_hint} ${S.pdf_compress_note}`, 'its note');
  eq(await page.$$eval('.ui-batch-item .ui-batch-choice-label', (els) => els.map((e) => e.textContent)), [S.compression_title, S.compression_title, S.compression_title], 'each its own level');
  eq(await page.$$eval('.compress-options .ui-segment', (els) => els.map((e) => e.textContent)), [S.compression_less, S.compression_recommended, S.compression_extreme], 'Less, Recommended, Extreme');
  eq(await levels(page), { each: [1, 1, 1], all: 1 }, 'all Recommended to start');
  eq(await nameFields(page), ['scan_compressed', 'compact_compressed', 'broken_compressed'], 'each named after itself');
  // Named for screen readers: the groups by their titles, the buttons by their PDFs.
  eq(await page.$eval('.compress-options .ui-segmented', (g) => document.getElementById(g.getAttribute('aria-labelledby'))?.textContent), S.compression_for_all, 'the level for all is named');
  eq(await page.$$eval('.ui-batch-item .ui-file-head .ui-icon-btn', (els) => els.map((e) => e.getAttribute('aria-label'))),
    ['scan.pdf', 'compact.pdf', 'broken.pdf'].map((n) => say('remove_file', n)), 'Remove buttons name their PDFs');

  // Extreme for all, then Less for the scan alone: none is chosen for all while they differ.
  await press(page, '.compress-options .ui-segment:nth-child(3)', opts);
  eq(await levels(page), { each: [2, 2, 2], all: 2 }, 'Extreme for all');
  await press(page, `${itemSelector(0)} .ui-segment:nth-child(1)`, opts);
  eq(await levels(page), { each: [0, 2, 2], all: null }, 'the scan has its own level');

  // Another PDF added starts with the level for all.
  await pickWith(page, '.compress-add', [fx.scan2], opts);
  await listed(page, 4);
  eq(await levels(page), { each: [0, 2, 2, 2], all: null }, 'the one added gets the level for all');
  eq(await runLabel(page), sayN('pdf_compress_action_many', 4), 'Compress 4 PDFs');
  // Removed, it is forgotten, and the focus goes to the Remove button now last.
  await press(page, `${itemSelector(3)} .ui-file-head .ui-icon-btn`, opts);
  await listed(page, 3);
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), say('remove_file', 'broken.pdf'), 'the focus moves to the next Remove');
  eq((await handleState(page)).map((s) => s.name), ['scan.pdf', 'compact.pdf', 'broken.pdf'], 'gone from the PDFs');

  // Named as the scan's will be: the second is told apart.
  await page.fill(`${itemSelector(1)} .ui-field-input`, 'scan_compressed');
  eq((await handleState(page)).map((s) => s.outputName), ['scan_compressed', 'scan_compressed', 'broken_compressed'], 'the name typed is kept');
  await checkNoSideways(page, 'several');
  await page.evaluate(() => window.scrollTo(0, 0));
  await themes(page, `compress-${label}-many`);
  if (label === 'desktop') {
    const columns = await page.$eval('.ui-batch-list', (l) => getComputedStyle(l).gridTemplateColumns.split(' ').length);
    ok(columns >= 2, `cards side by side on a wide screen (${columns})`);
  }

  // Made one after another: the damaged one is named, the others are made.
  let files = await runToResult(page, opts);
  await snack(page, sayN('batch_failed', 1, 1, 'broken.pdf'), 'the one that can\'t be read is named');
  eq(files.map((f) => f.name), ['scan_compressed.pdf', 'scan_compressed (2).pdf'], 'names, told apart');
  eq(await page.textContent('.ui-result-heading'), common.result_heading_many, 'Your PDFs are ready');
  const scanImages = await imagesOf(files[0].bytes);
  eq(scanImages.map((i) => [i.width, i.filter]), [[800, '/DCTDecode']], 'Less keeps the scan\'s pixels, as a JPEG');
  ok(files[0].bytes.length < fx.scan.buffer.length / 2, `the scan shrank (${fx.scan.buffer.length} → ${files[0].bytes.length})`);
  ok(files[1].keptOriginal, 'nothing to compress: the original kept');
  ok(Buffer.from(files[1].bytes).equals(fx.compact.buffer), 'byte for byte');
  const rows = await resultRows(page);
  const pct = Math.floor(((fx.scan.buffer.length - files[0].bytes.length) * 100) / fx.scan.buffer.length);
  ok(rows[0].extra?.startsWith('Compressed from ') && rows[0].extra.endsWith(`(${pct}% smaller)`), `how much smaller: ${rows[0].extra}`);
  eq(rows[1].extra, S.original_kept, 'the original kept says so');
  // Each with its own Open and Save (and Share where the browser shares files).
  eq(await page.$$eval('.ui-result-file .ui-result-row-buttons .ui-btn', (els) => els.filter((e) => /^(Open|Save) /.test(e.getAttribute('aria-label'))).map((e) => e.getAttribute('aria-label'))),
    [say('open_file', 'scan_compressed.pdf'), say('save_file', 'scan_compressed.pdf'), say('open_file', 'scan_compressed (2).pdf'), say('save_file', 'scan_compressed (2).pdf')], 'each its own Open and Save');
  ok(!(await page.$('.ui-result-note')), 'no password note');
  const text = (await readBack(page, files[0].bytes))[0].text;
  eq(text, 'SCAN 1', 'the text stays text');
  await checkNoSideways(page, 'result');
  await themes(page, `compress-${label}-result`);

  // Save to Downloads saves them all, each as its own file.
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await press(page, `.ui-result-actions .ui-btn:has-text("${common.save_to_downloads}")`, opts);
  // A PDF tool's result says it in its own words (PdfToolsViewModel: pdf_saved_downloads).
  await snack(page, common.pdf_saved_downloads, 'saved');
  eq(downloads.sort(), ['scan_compressed (2).pdf', 'scan_compressed.pdf'], 'both downloaded');
  eq(await page.$$eval('.ui-result-saved', (els) => els.map((e) => !e.hidden)), [true, true], 'each marked saved');
  page.removeAllListeners('download');

  // Back to the PDFs: their levels and names are as they were.
  await backToEditing(page, { touch });
  await listed(page, 3);
  eq(await levels(page), { each: [0, 2, 2], all: null }, 'levels kept');
  eq(await nameFields(page), ['scan_compressed', 'scan_compressed', 'broken_compressed'], 'names kept');
  // The browser's Forward shows the result again, and Back leaves it again.
  await page.goForward();
  await page.waitForSelector('.ui-result');
  await backToEditing(page, { browserBack: true });

  // Recommended for all sets every PDF again; down to one PDF, the screen is the one for a PDF.
  await press(page, '.compress-options .ui-segment:nth-child(2)', opts);
  eq(await levels(page), { each: [1, 1, 1], all: 1 }, 'Recommended for every PDF again');
  await press(page, `${itemSelector(2)} .ui-file-head .ui-icon-btn`, opts);
  await listed(page, 2);
  await press(page, `${itemSelector(1)} .ui-file-head .ui-icon-btn`, opts);
  await listed(page, 1);
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), say('remove_file', 'scan.pdf'), 'the focus stays on a Remove');
  eq(await cardNames(page), ['scan.pdf'], 'one PDF');
  eq(await page.textContent('.compress-options .compress-heading'), S.compression_title, 'Compression');
  eq(await page.textContent('.compress-options .compress-note'), S.pdf_compress_note, 'the note');
  eq(await levels(page), { each: [], all: 1 }, 'its level');
  eq(await nameFields(page), ['scan_compressed'], 'its name');
  eq(await runLabel(page), S.pdf_compress_action, 'Compress PDF');
  ok(await page.isVisible('.compress-add'), 'Add PDFs under it');
  await checkNoSideways(page, 'one');
  await themes(page, `compress-${label}-one`);
  if (label === 'desktop') {
    const width = await page.$eval('.compress-content', (c) => c.getBoundingClientRect().width);
    ok(width <= 640.5, `one PDF in a column of reading width (${width})`);
  }

  // One PDF at Extreme: smaller still, and nothing to say.
  await press(page, '.compress-options .ui-segment:nth-child(3)', opts);
  files = await runToResult(page, opts);
  eq(await page.textContent('.ui-result-heading'), common.result_heading_one, 'Your PDF is ready');
  eq(files.map((f) => f.name), ['scan_compressed.pdf'], 'its name');
  eq((await imagesOf(files[0].bytes)).map((i) => [i.width, i.height]), [[555, 694]], 'Extreme: 100 dpi where it is drawn');
  await noSnack(page);

  // Start over asks first while unsaved.
  await press(page, '.ui-result-startover', opts);
  await page.waitForSelector(`dialog[open] .ui-dialog-title:has-text("${common.start_over_title}")`);
  await press(page, `dialog[open] .ui-btn:has-text("${common.start_over}")`, opts);
  await listed(page, 0);
  eq((await handleState(page)).length, 0, 'started over');

  // One PDF that can't get smaller says so; one that isn't a PDF, picked alone, isn't named.
  await pickWith(page, '.ui-empty', [fx.junk], opts);
  await snack(page, S.pdf_import_failed, 'one picked alone: not named');
  await listed(page, 0);
  await pickWith(page, '.ui-empty', [fx.compact], opts);
  await listed(page, 1);
  files = await runToResult(page, opts);
  await snack(page, S.pdf_no_reduction, 'already compact');
  ok(files[0].keptOriginal && files[0].name === 'compact_compressed.pdf', 'kept, under its new name');
  eq((await resultRows(page))[0].extra, S.original_kept, 'says so under it');
  console.log(`ok compress ${label}`);
}

/** PDFs with a password join once opened; those made have none; two that can't be read: no result. */
async function testCompressMore(page, url, fx, { touch, label }) {
  const opts = { touch };
  await openTool(page, url, 'compress');
  await pickWith(page, '.ui-empty', [fx.locked, fx.scan], opts);
  // The password is asked for; a wrong one says so in the dialog.
  await page.waitForSelector('dialog[open] input[type="password"]');
  eq(await page.textContent('dialog[open] .ui-dialog-title'), common.pdf_password_title, 'PDF password');
  await page.fill('dialog[open] input[type="password"]', 'nope');
  await press(page, `dialog[open] .ui-btn:has-text("${common.pdf_unlock}")`, opts);
  await page.waitForFunction((t) => document.querySelector('dialog[open] .ui-field-support')?.textContent === t, common.pdf_wrong_password);
  checks++;
  await themes(page, `compress-${label}-password`, { full: false });
  await page.fill('dialog[open] input[type="password"]', 'test123');
  await press(page, `dialog[open] .ui-btn:has-text("${common.pdf_unlock}")`, opts);
  await listed(page, 2);
  eq(await cardNames(page), ['statement.pdf', 'scan.pdf'], 'joined once opened');
  const files = await runToResult(page, opts);
  eq(files.map((f) => f.name), ['statement_compressed.pdf', 'scan_compressed.pdf'], 'both made');
  eq(await page.textContent('.ui-result-note'), sayN('pdf_password_removed', 2), 'the new PDFs have no password');
  ok(!(await encrypted(files[0].bytes)), 'no password any more');
  // A PDF with a password is saved again even when no smaller, and named for it.
  const smaller = Math.floor(((fx.locked.buffer.length - files[0].bytes.length) * 100) / fx.locked.buffer.length) >= 1;
  if (!smaller) await snack(page, sayN('batch_not_smaller', 1, 1, 'statement.pdf'), 'no smaller, said with its name');
  ok(!files[0].keptOriginal, 'never kept as it was, with a password');
  await page.click('.ui-result-startover');
  await press(page, `dialog[open] .ui-btn:has-text("${common.start_over}")`, opts);
  await listed(page, 0);

  // None of them can be read: each named, and no result.
  await pickWith(page, '.ui-empty', [fx.broken, fx.broken2], opts);
  await listed(page, 2);
  await press(page, '.compress-run', opts);
  await snack(page, sayN('batch_failed', 2, 2, 'broken.pdf, broken2.pdf'), 'both named');
  ok(!(await page.$('.ui-result')), 'no result');
  ok(await page.$eval('.compress-run', (b) => !b.disabled), 'the button can be pressed again');

  // Cancelled while "PDF 2 of 4" is made: nothing made, nothing said.
  await press(page, '.ui-batch-item:nth-child(2) .ui-file-head .ui-icon-btn', opts);
  await press(page, '.ui-file-card .ui-file-head .ui-icon-btn', opts);
  await listed(page, 0);
  await pickWith(page, '.ui-empty', fx.big, opts);
  await listed(page, 4);
  await press(page, '.compress-run', opts);
  await page.waitForSelector('dialog.ui-dialog--progress.is-shown', { timeout: 20000 });
  eq(await page.textContent('dialog.ui-dialog--progress .ui-dialog-title'), common.pdf_working_many, 'Working on your PDFs…');
  const progress = await page.waitForFunction(() => {
    const l = document.querySelector('dialog.ui-dialog--progress .ui-progress-label');
    return l && !l.hidden && l.textContent ? [l.textContent, document.querySelector('dialog.ui-dialog--progress .ui-progress-detail').textContent] : null;
  }).then((h) => h.jsonValue());
  ok(/^PDF [1-4] of 4$/.test(progress[0]) && /^big [1-4]\.pdf$/.test(progress[1]), `which PDF and its name: ${progress}`);
  if (!QUICK) await page.screenshot({ path: join(shots, `compress-${label}-progress.png`) });
  // Pressed at once, before the last PDF is done.
  const cancelLabel = await page.evaluate(() => {
    const b = [...document.querySelectorAll('dialog.ui-dialog--progress .ui-btn')].pop();
    b.click();
    return b.textContent;
  });
  eq(cancelLabel, common.cancelling, 'Cancel turns into Cancelling…');
  await page.waitForSelector('dialog.ui-dialog--progress', { state: 'detached', timeout: 30000 });
  ok(!(await page.$('.ui-result')), 'cancelled: no result');
  await noSnack(page);
  eq((await handleState(page)).length, 4, 'the PDFs are still there');

  // The browser's Back while they are made asks first: Keep lets the run go on to its result.
  await press(page, '.compress-run', opts);
  await page.waitForSelector('dialog.ui-dialog--progress.is-shown', { timeout: 20000 });
  await page.goBack();
  const keep = `dialog[open] .ui-btn:has-text("${common.keep}")`;
  await page.waitForSelector(keep);
  await page.click(keep);
  await page.waitForSelector('.ui-result', { timeout: 90000 });
  eq((await resultFiles(page)).map((f) => f.name), ['big 1_compressed.pdf', 'big 2_compressed.pdf', 'big 3_compressed.pdf', 'big 4_compressed.pdf'], 'kept on: all made');
  await backToEditing(page, { touch });
  // Discard leaves, and the run stops with its dialog.
  await press(page, '.compress-run', opts);
  await page.waitForSelector('dialog.ui-dialog--progress.is-shown', { timeout: 20000 });
  await page.goBack();
  const discard = `dialog[open] .ui-btn:has-text("${common.discard}")`;
  await page.waitForSelector(discard);
  await page.click(discard);
  await page.waitForSelector('#app .screen[data-route="home"]:not([aria-busy])');
  await page.waitForSelector('dialog.ui-dialog--progress', { state: 'detached', timeout: 10000 });
  checks++;
  await noSnack(page);
  console.log(`ok compress passwords, failures, cancel, leaving ${label}`);
}

/**
 * Compress PDF and the Usugami watermark (runCompress's afterResult, ResultMarker): a PDF kept as it
 * was gets the watermark on the result screen and then isn't the original any more; turned off,
 * it is the original again, byte for byte. With the watermark on, Compress can't keep a PDF as it
 * was, and one that comes out no smaller says so, as one that had a password does. A PDF that
 * already has Usugami's watermark is compressed without it.
 */
async function testCompressMark(page, url, fx, { touch }) {
  const opts = { touch };
  const setMark = (on) => page.evaluate(async (v) => (await import(new URL('js/core/settings.js', location.href).href)).setSetting('mark.on', v), on);
  /** The result's files once they have the watermark the setting asks for. */
  const readyFiles = async () => {
    await page.evaluate(() => document.querySelector('.ui-result').ready);
    return resultFiles(page);
  };
  const settled = () => page.waitForFunction(() => !document.querySelector('.ui-mark-working .ui-progress')
    && !document.querySelector('.ui-result-actions .ui-btn').disabled, null, { timeout: 30000 });
  const startOver = async () => {
    await press(page, '.ui-result-startover', opts);
    await press(page, `dialog[open] .ui-btn:has-text("${common.start_over}")`, opts);
    await listed(page, 0);
  };
  await setMark(false);
  await openTool(page, url, 'compress');
  await pickWith(page, '.ui-empty', [fx.compact], opts);
  await listed(page, 1);
  let files = await runToResult(page, opts);
  await snack(page, S.pdf_no_reduction, 'kept as it was');
  ok(files[0].keptOriginal && !mayCarryMark(files[0].bytes), 'the original');

  // The switch puts the watermark on that same PDF, which then isn't the original any more.
  await press(page, '.ui-mark [role="switch"]', opts);
  await page.waitForFunction(() => document.querySelector('.ui-result').files[0].keptOriginal === false, null, { timeout: 30000 });
  await settled();
  files = await resultFiles(page);
  ok(mayCarryMark(files[0].bytes) && !files[0].keptOriginal, 'marked, no longer the original');
  eq((await resultRows(page))[0].extra, null, 'no longer says the original was kept');
  // Off again: the original as it was, byte for byte, and it says so again.
  await press(page, '.ui-mark [role="switch"]', opts);
  await page.waitForFunction(() => document.querySelector('.ui-result').files[0].keptOriginal === true, null, { timeout: 30000 });
  await settled();
  files = await resultFiles(page);
  ok(Buffer.from(files[0].bytes).equals(fx.compact.buffer), 'the original again');
  eq((await resultRows(page))[0].extra, S.original_kept, 'says so again');

  // With the watermark on as the PDF is made: no smaller, and said as for a PDF with a password.
  await setMark(true);
  await backToEditing(page, opts);
  await press(page, '.compress-run', opts);
  await page.waitForSelector('.ui-result', { timeout: 90000 });
  files = await readyFiles();
  await snack(page, S.pdf_not_smaller, 'no smaller with the watermark');
  ok(mayCarryMark(files[0].bytes) && !files[0].keptOriginal, 'made anew, with the watermark');
  eq((await resultRows(page))[0].extra, null, 'nothing under it');
  await noSnack(page, 300);

  // Several: the one no smaller named, the other smaller even with the watermark.
  await startOver();
  await pickWith(page, '.ui-empty', [fx.compact, fx.scan], opts);
  await listed(page, 2);
  await press(page, '.compress-run', opts);
  await page.waitForSelector('.ui-result', { timeout: 90000 });
  files = await readyFiles();
  await snack(page, sayN('batch_not_smaller', 1, 1, 'compact.pdf'), 'named, as one with a password');
  ok(files.every((f) => mayCarryMark(f.bytes) && !f.keptOriginal), 'both with the watermark');
  ok(files[1].bytes.length < fx.scan.buffer.length * 0.99, 'the scan smaller all the same');

  // A PDF made with the watermark before: compressed without it, the setting deciding (off here).
  await setMark(false);
  await startOver();
  const markedBefore = { ...fx.compact, name: 'marked.pdf', buffer: Buffer.from(await markPdf(fx.compact.buffer, new MarkStyle({ size: 100, opacity: 100 }))) };
  await pickWith(page, '.ui-empty', [markedBefore], opts);
  await listed(page, 1);
  await press(page, '.compress-run', opts);
  await page.waitForSelector('.ui-result', { timeout: 90000 });
  files = await readyFiles();
  ok(!mayCarryMark(files[0].bytes) && !files[0].keptOriginal, 'without its old watermark, not kept as it was');
  await snackbarsGone(page);
  await startOver();
  console.log('ok compress and the Usugami watermark');
}

/**
 * The edges of the screen both tools share: the single PDF's name after a trip through the list,
 * Start over while more PDFs are still opening (PdfToolsViewModel.startOver abandons them),
 * leaving with a password question open, a reload on the result's history step, and the main
 * landmark "Skip to content" goes to.
 */
async function testScreenEdges(page, url, fx, { touch }) {
  const opts = { touch };
  await openTool(page, url, 'compress');

  // The main part of the screen is one main landmark, past the top bar.
  eq(await page.$$eval('#app main, #app [role="main"]', (els) => els.map((e) => e.hasAttribute('data-main'))), [true], 'one main landmark');
  await page.focus('.skip-link');
  await page.keyboard.press('Enter');
  ok(await page.evaluate(() => document.activeElement?.matches('#app main')), 'Skip to content goes to it');
  await page.keyboard.press('Tab');
  ok(await page.evaluate(() => !!document.activeElement?.closest('#app main') && !document.activeElement.closest('.ui-topbar')), 'the next Tab is past the top bar');

  // The single PDF's File name shows the name it will be made with, after the list renamed it.
  await pickWith(page, '.ui-empty', [fx.scan], opts);
  await listed(page, 1);
  await page.fill('.compress-name input', 'First name');
  await pickWith(page, '.compress-add', [fx.compact], opts);
  await listed(page, 2);
  eq(await nameFields(page), ['First name', 'compact_compressed'], 'the name typed goes with it into the list');
  await page.fill(`${itemSelector(0)} .ui-field-input`, 'Renamed in the list');
  await press(page, `${itemSelector(1)} .ui-file-head .ui-icon-btn`, opts);
  await listed(page, 1);
  eq(await page.$eval('.compress-name input', (i) => i.value), 'Renamed in the list', 'one PDF again: the name from the list');
  eq((await handleState(page))[0].outputName, 'Renamed in the list', 'the name it will get');
  await runToResult(page, opts);
  eq((await resultRows(page)).map((r) => r.name), ['Renamed in the list.pdf'], 'made under the name shown');

  // A reload on the result's step: the result is gone, and so is its step in the history.
  ok(await page.evaluate(() => history.state?.step === 'result'), 'the result is a step of its own');
  // The browser asks before a reload loses the unsaved result: leave.
  const leave = (d) => d.accept();
  page.on('dialog', leave);
  await page.reload();
  page.off('dialog', leave);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  await arrive(page, '#app .screen[data-tool="compress"]:not([aria-busy]) .compress-content--empty');
  await page.waitForFunction(() => history.state?.step == null, null, { timeout: 10000 });
  checks++;
  // Forward to it again finds no result to show: the screen stays as it is.
  await page.goForward();
  await page.waitForTimeout(300);
  await page.waitForFunction(() => history.state?.step == null, null, { timeout: 10000 });
  ok(!(await page.$('.ui-result')) && !!(await page.$('.compress-content--empty')), 'forward: still the PDFs to pick');

  // Start over (Remove on the one PDF) while more are opening: they are abandoned, and their
  // password isn't asked for.
  const many = [];
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 1500; i++) doc.addPage([300, 300]).drawText(`PAGE ${i + 1}`, { x: 20, y: 150, size: 18, font });
    many.push({ name: 'long.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  }
  many.push(fx.locked, fx.scan2);
  await pickWith(page, '.ui-empty', [fx.scan], opts);
  await listed(page, 1);
  const cdp = await page.context().newCDPSession(page);
  try {
    // Slowed down, so the first PDF added (1500 pages) takes long enough to open to start over
    // meanwhile. Only once the files are in: throttled, Playwright's own handing over of them (its
    // decoding in the page, some 6 MB) outlasts its timeout on Windows, where Chrome's throttling
    // slows more than the rate says.
    await pickWith(page, '.compress-add', many, opts);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 30 });
    // Remove on the one PDF's card, pressed while the bar says the others are opening (done in the
    // page, so it lands before the first of them is open).
    await page.waitForFunction(() => {
      const bar = document.querySelector('.compress-progress');
      const remove = document.querySelector('.compress-content--one .compress-card .ui-file-head .ui-icon-btn');
      if (!bar || bar.hidden || !remove) return false;
      remove.click();
      return true;
    }, null, { timeout: 10000 });
    checks++;
    ok(await page.$eval('.compress-progress', (p) => p.hidden), 'no longer opening');
    ok(await page.$eval('.ui-empty', (e) => !e.hasAttribute('aria-disabled')), 'picking is on again at once');
    await page.evaluate(async () => (await import(new URL('js/core/router.js', location.href).href)).currentHandle().settled);
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
  }
  await page.waitForTimeout(300);
  ok(!!(await page.$('.compress-content--empty')), 'started over: none listed');
  eq(await handleState(page), [], 'none added once open');
  ok(!(await page.$('dialog[open]')), 'no password asked for one abandoned');
  await noSnack(page, 300);

  // Back closes the password question first, as Android's Back closes a dialog.
  await pickWith(page, '.ui-empty', [fx.locked], opts);
  await page.waitForSelector('dialog[open] input[type="password"]');
  await page.goBack();
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
  await page.waitForTimeout(300);
  ok(!!(await page.$('#app .screen[data-tool="compress"] .compress-content--empty')), 'Back with the question open: the question goes, the screen stays');
  // Leaving the screen another way while a password is asked for (a PDF shared to the app opens
  // another screen) takes the question away with the screen.
  await pickWith(page, '.ui-empty', [fx.locked], opts);
  await page.waitForSelector('dialog[open] input[type="password"]');
  await page.evaluate(async () => (await import(new URL('js/core/router.js', location.href).href)).navigate('/'));
  await page.waitForSelector('#app .screen[data-route="home"]:not([aria-busy])');
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
  checks++;
  console.log('ok screen edges');
}

// ---------------------------------------------------------------------------------------------
// Flatten PDF

async function testFlatten(page, url, fx, { touch, label }) {
  const opts = { touch };
  await openTool(page, url, 'flatten');
  eq(await page.textContent('.ui-topbar-title'), common.tool_flatten, 'title');
  eq(await runLabel(page), S.pdf_flatten_action, 'Flatten PDF');
  await themes(page, `flatten-${label}-empty`);

  if (label === 'desktop') {
    // On a computer the PDFs can be dropped on the card.
    await drop(page, [fx.form, fx.alpha, fx.amounts, fx.brokenForm], '.ui-empty');
  } else {
    await pickWith(page, '.ui-empty', [fx.form, fx.alpha, fx.amounts, fx.brokenForm], opts);
  }
  await listed(page, 4);
  eq(await cardNames(page), ['form.pdf', 'alpha.pdf', 'amounts.pdf', 'broken form.pdf'], 'listed');
  eq(await page.textContent('.compress-options .compress-text'), S.flatten_note, 'what it does');
  ok(!(await page.$('.ui-batch-item .ui-segmented')), 'no choices of its own');
  eq(await nameFields(page), ['form_flattened', 'alpha_flattened', 'amounts_flattened', 'broken form_flattened'], 'each named after itself');
  eq(await runLabel(page), sayN('pdf_flatten_action_many', 4), 'Flatten 4 PDFs');
  await page.fill(`${itemSelector(2)} .ui-field-input`, 'Amounts: done');
  await checkNoSideways(page, 'several');
  await page.evaluate(() => window.scrollTo(0, 0));
  await themes(page, `flatten-${label}-many`);

  const files = await runToResult(page, opts);
  // First those left out, then what happened to another.
  await snack(page, sayN('batch_nothing_to_flatten', 1, 1, 'alpha.pdf'), 'nothing to flatten: left out and named');
  await snack(page, sayN('batch_failed', 1, 1, 'broken form.pdf'), 'the damaged one named');
  await snack(page, say('file_problem', 'amounts.pdf', sayN('flatten_fields_kept', 2, 2)), 'fields kept, said of it');
  eq(files.map((f) => f.name), ['form_flattened.pdf', 'Amounts_ done.pdf'], 'names, made safe');
  const [formBack] = await readBack(page, files[0].bytes);
  ok(formBack.text.includes('FORM PAGE') && formBack.text.includes('Jane Doe') && formBack.text.includes('Lisbon'), `the fields are part of the page: ${formBack.text}`);
  eq(formBack.annots, [], 'no form fields or comments left');
  ok(formBack.rgb[0] > 200 && formBack.rgb[1] < 80 && formBack.rgb[2] < 80, `the comment is drawn in the page: ${formBack.rgb}`);
  eq(await formOf(files[0].bytes), null, 'the form is gone');
  eq(await formOf(files[1].bytes), { fields: 2, needAppearances: true, xfa: false }, 'fields it can\'t draw stay fillable');
  ok((await resultRows(page)).every((r) => r.extra === null), 'nothing under the files');
  await themes(page, `flatten-${label}-result`);

  // Down to the one with nothing to flatten: said in its own words, and no result.
  await backToEditing(page, { touch });
  await listed(page, 4);
  for (const i of [3, 2, 0]) await press(page, `${itemSelector(i)} .ui-file-head .ui-icon-btn`, opts);
  await listed(page, 1);
  eq(await cardNames(page), ['alpha.pdf'], 'one left');
  eq(await page.textContent('.compress-options .compress-text'), S.flatten_note, 'the same note for one');
  eq(await runLabel(page), S.pdf_flatten_action, 'Flatten PDF');
  await themes(page, `flatten-${label}-one`);
  await press(page, '.compress-run', opts);
  await snack(page, S.flatten_nothing, 'nothing to flatten');
  ok(!(await page.$('.ui-result')), 'no result');

  // What is said of several PDFs comes once for them all; of one alone, naming it.
  await press(page, '.compress-card .ui-file-head .ui-icon-btn', opts);
  await listed(page, 0);
  await pickWith(page, '.ui-empty', [fx.tax, fx.permit, fx.visa], opts);
  await listed(page, 3);
  const more = await runToResult(page, opts);
  await snack(page, say('file_problem', 'tax form.pdf, visa form.pdf', S.flatten_xfa_only_many), 'XFA only, together');
  await snack(page, say('file_problem', 'permit.pdf', S.flatten_xfa_dropped), 'XFA dropped, of one');
  eq(more.map((f) => f.name), ['permit_flattened.pdf'], 'the one made');
  eq(await formOf(more[0].bytes), null, 'its form flattened, XFA and all');
  eq(await page.textContent('.ui-result-heading'), common.result_heading_one, 'Your PDF is ready');
  console.log(`ok flatten ${label}`);
}

/** Desktop extras: the keyboard, PDFs handed over by Choose a tool, drop zones, the narrow column. */
async function testDesktopKeyboard(page, url, fx) {
  await openTool(page, url, 'compress');
  // Picked from the keyboard: the focus stays on the screen, on the first PDF's card.
  await page.focus('.ui-empty');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles([fx.scan, fx.compact]);
  await page.waitForFunction(() => document.querySelector('.compress-run')?.getAttribute('aria-disabled') === 'true' || document.querySelectorAll('.ui-batch-item').length === 2);
  await listed(page, 2);
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), say('remove_file', 'scan.pdf'), 'the focus goes to the first PDF');
  ok(await page.$eval('.compress-run', (b) => !b.disabled && !b.hasAttribute('aria-disabled')), 'the button is on once they are open');
  // PDFs handed to the tool, one with the password given on Choose a tool.
  await page.evaluate(async (list) => {
    const { navigate } = await import(new URL('js/core/router.js', location.href).href);
    const files = list.map(({ name, b64, password }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const item = { name, type: 'application/pdf', size: bytes.length, lastModified: 0, bytes };
      if (password) item.password = password;
      return item;
    });
    await navigate('/tool/compress', { files });
  }, [{ name: fx.scan.name, b64: fx.scan.buffer.toString('base64') }, { name: fx.locked.name, b64: fx.locked.buffer.toString('base64'), password: 'test123' }]);
  await listed(page, 2);
  ok(!(await page.$('dialog[open]')), 'no password asked again');
  eq(await cardNames(page), ['scan.pdf', 'statement.pdf'], 'handed over');

  // The level for all by keyboard: arrow keys choose.
  await page.focus('.compress-options .ui-segment[aria-checked="true"]');
  await page.keyboard.press('ArrowRight');
  eq(await levels(page), { each: [2, 2], all: 2 }, 'ArrowRight: Extreme for all');
  await page.keyboard.press('Tab');
  // Tab moves on to the first PDF's own level, then its name.
  ok(await page.evaluate(() => !!document.activeElement.closest('.ui-batch-item') || document.activeElement.closest('.ui-file-card') !== null), 'Tab moves on to the PDFs');
  await page.focus(`${itemSelector(1)} .ui-segment[aria-checked="true"]`);
  await page.keyboard.press('Home');
  eq(await levels(page), { each: [2, 0], all: null }, 'Home: Less for the second alone');

  // More dropped onto the screen join the list; one that isn't a PDF is named.
  await drop(page, [fx.compact, fx.junk], '.compress-page');
  await listed(page, 3);
  await snack(page, say('file_problem', 'junk.pdf', S.pdf_import_failed), 'not a PDF: named');
  eq(await levels(page), { each: [2, 0, 2], all: null }, 'the one dropped gets the level for all');

  // Pressed from the keyboard with nothing that can be made: said, and the focus is back on it.
  await openTool(page, url, 'flatten');
  await drop(page, [fx.alpha, fx.brokenForm], '.ui-empty');
  await listed(page, 2);
  await page.focus('.compress-run');
  await page.keyboard.press('Enter');
  await snack(page, sayN('batch_nothing_to_flatten', 1, 1, 'alpha.pdf'), 'nothing to flatten');
  await snack(page, sayN('batch_failed', 1, 1, 'broken form.pdf'), 'the damaged one');
  ok(!(await page.$('.ui-result')), 'no result');
  ok(await page.evaluate(() => document.activeElement?.classList.contains('compress-run')), 'the focus is back on the button');
  console.log('ok desktop keyboard and drops');
}

// ---------------------------------------------------------------------------------------------

await testStrings();
const fx = await fixtures();

// --edges: only the shared screen's edges (testScreenEdges), at phone size in Chromium.
if (process.argv.includes('--edges')) {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/');
    await page.waitForSelector('html[data-ready="true"]');
    await testScreenEdges(page, url, fx, { touch: true });
  }, { viewport: PHONE });
  console.log(`batch-ui (edges): all ${checks} checks passed`);
  process.exit(0);
}

await withPage(async (page, url) => {
  await page.goto(url + 'app/');
  await page.waitForSelector('html[data-ready="true"]');
  await testHelpers(page, url);
  await testCompress(page, url, fx, { touch: true, label: 'phone' });
  await testCompressMore(page, url, fx, { touch: true, label: 'phone' });
  await testCompressMark(page, url, fx, { touch: true });
  await testScreenEdges(page, url, fx, { touch: true });
  await testFlatten(page, url, fx, { touch: true, label: 'phone' });
}, { viewport: PHONE });

await withPage(async (page, url) => {
  await page.goto(url + 'app/');
  await page.waitForSelector('html[data-ready="true"]');
  await testCompress(page, url, fx, { touch: false, label: 'desktop' });
  await testFlatten(page, url, fx, { touch: false, label: 'desktop' });
  await testDesktopKeyboard(page, url, fx);
}, { viewport: DESKTOP });

// At 320 px nothing scrolls sideways.
await withPage(async (page, url) => {
  await page.goto(url + 'app/');
  await page.waitForSelector('html[data-ready="true"]');
  await openTool(page, url, 'compress');
  await pickWith(page, '.ui-empty', [fx.scan, fx.compact], { touch: true });
  await listed(page, 2);
  await checkNoSideways(page, '320 px');
  await shot(page, 'compress-320-many');
  console.log('ok 320 px');
}, { viewport: { width: 320, height: 700 } });

if (!QUICK) {
  for (const browser of ['firefox', 'webkit']) {
    await withPage(async (page, url) => {
      await page.goto(url + 'app/');
      await page.waitForSelector('html[data-ready="true"]');
      const opts = { touch: browser !== 'firefox', browser };
      await openTool(page, url, 'compress');
      await pickWith(page, '.ui-empty', [fx.scan, fx.compact, fx.broken], opts);
      await listed(page, 3);
      await press(page, `${itemSelector(0)} .ui-segment:nth-child(3)`, opts);
      eq(await levels(page), { each: [2, 1, 1], all: null }, `${browser}: a level of its own`);
      let files = await runToResult(page, opts);
      await snack(page, sayN('batch_failed', 1, 1, 'broken.pdf'), `${browser}: the damaged one named`);
      eq(files.map((f) => f.name), ['scan_compressed.pdf', 'compact_compressed.pdf'], `${browser}: made`);
      eq((await imagesOf(files[0].bytes)).map((i) => i.width), [555], `${browser}: Extreme`);
      ok(files[1].keptOriginal, `${browser}: kept`);
      await checkNoSideways(page, `${browser} result`);
      await shot(page, `compress-${browser}-result`);

      await openTool(page, url, 'flatten');
      // Flatten PDF's PDFs come through the real file input, in Firefox too (the kit takes the files
      // of Playwright's Firefox, which sends the input's cancel event just before its change event).
      const [flattenChooser] = await Promise.all([page.waitForEvent('filechooser'), press(page, '.ui-empty', opts)]);
      await flattenChooser.setFiles([fx.form, fx.alpha]);
      await listed(page, 2);
      await shot(page, `flatten-${browser}-many`);
      files = await runToResult(page, opts);
      await snack(page, sayN('batch_nothing_to_flatten', 1, 1, 'alpha.pdf'), `${browser}: nothing to flatten`);
      eq(files.map((f) => f.name), ['form_flattened.pdf'], `${browser}: flattened`);
      eq(await formOf(files[0].bytes), null, `${browser}: no form left`);
      console.log(`ok ${browser}`);
    }, { browser, viewport: PHONE });

    await withPage(async (page, url) => {
      await page.goto(url + 'app/');
      await page.waitForSelector('html[data-ready="true"]');
      await openTool(page, url, 'compress');
      await drop(page, [fx.scan, fx.compact, fx.scan2], '.ui-empty');
      await listed(page, 3);
      const columns = await page.$eval('.ui-batch-list', (l) => getComputedStyle(l).gridTemplateColumns.split(' ').length);
      ok(columns >= 2, `${browser} desktop: cards side by side (${columns})`);
      await checkNoSideways(page, `${browser} desktop`);
      await shot(page, `compress-${browser}-desktop-many`, { full: false });
      await page.click('.compress-options .ui-segment:nth-child(1)');
      eq(await levels(page), { each: [0, 0, 0], all: 0 }, `${browser} desktop: Less for all`);
      const files = await runToResult(page, { touch: false });
      eq(files.map((f) => f.name), ['scan_compressed.pdf', 'compact_compressed.pdf', 'scan2_compressed.pdf'], `${browser} desktop: made`);
      await shot(page, `compress-${browser}-desktop-result`, { full: false });
      console.log(`ok ${browser} desktop`);
    }, { browser, viewport: DESKTOP });
  }
}

console.log(`batch-ui: all ${checks} checks passed`);
