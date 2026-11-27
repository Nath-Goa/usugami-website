// Split PDF (js/tools/split: index.js, and frame.js, the screen around its options): driven in the
// app as a person would, by touch at phone size and by mouse and keyboard at desktop size, with the
// PDFs made read back (page counts, text with pdf.js, what the pages show).
// Run with: node tests/organize-ui-a.test.mjs   (--quick: Chromium only, no screenshots;
// --others: Firefox and WebKit only; --review: Chromium, the reviewers' findings only)
// Screenshots go to .tmp/organize-ui-a/screens/ to be looked at.
import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { withPage, assert, root, runInPage, chooserFromKeyboard } from './harness.mjs';
import { PDFDocument, rgb, StandardFonts } from '../site/app/vendor/pdf-lib/pdf-lib.esm.min.js';
import { unzipSync, strToU8 } from '../site/app/vendor/fflate/fflate.esm.js';

const REVIEW = process.argv.includes('--review');
const QUICK = REVIEW || process.argv.includes('--quick');
// --others: only Firefox and WebKit.
const OTHERS = process.argv.includes('--others');
const shots = join(root, '.tmp', 'organize-ui-a', 'screens');
await mkdir(shots, { recursive: true });
// The Android app beside this repository (not there on CI: what needs it is skipped or made here).
const appAssets = join(root, '..', 'pdfer', 'app', 'src', 'androidTest', 'assets');
const exists = (p) => access(p).then(() => true, () => false);

const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 900 };

// The English the screen should show (strings.xml).
const S = {
  split: 'Split PDF',
  pickPdf: 'Choose PDF',
  another: 'Choose another PDF',
  selected: 'Selected pages',
  custom: 'Custom ranges',
  fixed: 'Fixed chunks',
  every: 'Every page',
  fixedHint: 'Pages per PDF',
  selectedHint: 'For example: 1,3,5-8. Tap page previews to select them.',
  customHint: 'For example: 1-3;5-7;9',
  fixedExample: 'For example: 5',
  combineSelected: 'Combine selected pages into one PDF',
  combineRanges: 'Combine all ranges into one PDF',
  format: 'Use page numbers such as 1,3-5.',
  rangesFormat: 'Use ranges such as 1-3;5;7-9.',
  range: (n) => `Pages must be between 1 and ${n}.`,
  reversed: 'Write ranges from low to high, such as 3-8.',
  chunk: (n) => `Pages per PDF must be between 1 and ${n}.`,
  importFailed: "Couldn't open that PDF. It may be damaged or unsupported.",
  wrongPassword: "That password didn't open the PDF.",
  noPassword: 'The new PDF has no password.',
  oneReady: 'Your PDF is ready',
  manyReady: 'Your PDFs are ready',
};

// ---------------------------------------------------------------------------------------------
// Fixtures, made with pdf-lib: each page says "PAGE n" in big letters on a coloured block.

const HUES = [rgb(0.9, 0.2, 0.2), rgb(0.2, 0.6, 0.2), rgb(0.2, 0.3, 0.9), rgb(0.9, 0.7, 0.1)];

async function makePdf(count, { landscapeAt = [2], label = 'PAGE' } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const landscape = landscapeAt.includes(i);
    const page = doc.addPage(landscape ? [842, 595] : [595, 842]);
    page.drawRectangle({ x: 40, y: 40, width: page.getWidth() - 80, height: page.getHeight() - 80, color: HUES[i % 4], opacity: 0.45 });
    page.drawText(`${label} ${i + 1}`, { x: 60, y: page.getHeight() - 120, size: 56, font });
  }
  return doc.save();
}

async function fixtures() {
  const report = await makePdf(12);
  // Long enough that splitting it into every page takes a few seconds, to be cancelled.
  const big = await makePdf(3000, { landscapeAt: [] });
  const other = await makePdf(3, { landscapeAt: [], label: 'OTHER' });
  let locked;
  const protectedPath = join(appAssets, 'protected.pdf');
  if (await exists(protectedPath)) {
    locked = { bytes: new Uint8Array(await readFile(protectedPath)), password: 'test123' };
  } else {
    const doc = await PDFDocument.load(await makePdf(3, { landscapeAt: [] }));
    await doc.encrypt({ userPassword: 'test123', ownerPassword: 'owner123' });
    locked = { bytes: await doc.save(), password: 'test123' };
  }
  const damaged = strToU8('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\nthis is not a PDF at all\n%%EOF');
  // Without its first line, "%PDF-1.7": pdf.js still shows it, the engine (pdf-lib) refuses it.
  const headless = report.subarray(report.indexOf(10) + 1);
  return { report, big, other, locked, damaged, headless };
}

const asFile = (name, bytes) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// ---------------------------------------------------------------------------------------------
// Driving the app

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

/** Waits for `selector`, discarding unsaved work when leaving a screen asks about it. */
async function arrive(page, selector) {
  const discard = 'dialog[open] .ui-btn:has-text("Discard")';
  await page.waitForSelector(`${selector}, ${discard}`, { timeout: 20000 });
  if (await page.$(discard)) await page.click(discard);
  await page.waitForSelector(selector, { timeout: 20000 });
}

/** Opens the tool afresh: by way of Home when the app already shows, so the tool mounts anew. */
async function openTool(page, url, tool) {
  if (page.url().includes('/app/')) {
    await page.evaluate(() => { location.hash = '#/'; });
    await arrive(page, '#app .screen[data-route="home"]:not([aria-busy])');
  }
  await page.goto(url + 'app/#/tool/' + tool);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  await arrive(page, `#app .screen[data-tool="${tool}"]:not([aria-busy]) .onepdf`);
}

/** A tap on a phone, a click with the mouse on a computer. */
async function press(page, selector, { touch }) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  if (touch) await target.tap(); else await target.click();
}

/**
 * Picks a PDF through the "Choose PDF" card's file input, in every browser (the kit takes the files
 * of Playwright's Firefox, which sends the input's cancel event just before its change event), or
 * with `drop` drops it on the card.
 */
async function pickIn(page, file, { touch = false, drop = false } = {}) {
  if (drop) return dropFile(page, file.name, file.buffer, '.ui-empty');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), press(page, '.ui-empty', { touch })]);
  await chooser.setFiles(file);
}

const pick = (page, file, options) => pickIn(page, file, options);

/** Drops a PDF on `target`, as one dragged from the computer's files. */
async function dropFile(page, name, bytes, target) {
  const dt = await page.evaluateHandle(({ name, b64 }) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'application/pdf' }));
    return data;
  }, { name, b64: Buffer.from(bytes).toString('base64') });
  await page.dispatchEvent(target, 'dragenter', { dataTransfer: dt });
  ok(await page.evaluate((t) => document.querySelector(t).classList.contains('is-dragover'), target), 'shows where it goes');
  await page.dispatchEvent(target, 'drop', { dataTransfer: dt });
}

async function chosen(page, name) {
  await page.waitForFunction((n) => document.querySelector('.onepdf-card .ui-file-name')?.textContent === n, name, { timeout: 20000 });
  checks++;
  // Opening is over: the bar has gone.
  await page.waitForFunction(() => !document.querySelector('.onepdf-main[aria-busy]'));
}

const mainButton = (page) => page.locator('.onepdf > .ui-bottombar .ui-btn');

async function typeInto(page, selector, text) {
  const input = page.locator(selector);
  await input.fill('');
  if (text) await input.fill(text);
}

/** Waits for a snackbar saying `text`, then sends it (and any waiting) away. */
async function snack(page, text) {
  await page.waitForFunction((want) => [...document.querySelectorAll('.ui-snackbar-text')].some((n) => n.textContent === want), text, { timeout: 15000 });
  await page.evaluate(() => document.querySelectorAll('.ui-snackbar').forEach((s) => s.dismiss?.()));
  await page.waitForFunction(() => !document.querySelector('.ui-snackbar'), null, { timeout: 5000 });
  checks++;
}

async function noSnack(page, ms = 300) {
  await page.waitForTimeout(ms);
  const texts = await page.evaluate(() => [...document.querySelectorAll('.ui-snackbar-text')].map((n) => n.textContent));
  eq(texts, [], 'no message');
}

/** Presses the main button and waits for the result screen; returns its files (bytes as Uint8Array). */
async function runTool(page, { touch }) {
  await press(page, '.onepdf > .ui-bottombar .ui-btn', { touch });
  await page.waitForSelector('.ui-result', { timeout: 60000 });
  const files = await page.evaluate(() => {
    const b64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return document.querySelector('.ui-result').files.map((f) => ({ name: f.name, type: f.type, pageCount: f.pageCount, passwordRemoved: !!f.passwordRemoved, b64: b64(f.bytes) }));
  });
  return files.map((f) => ({ ...f, bytes: fromB64(f.b64) }));
}

/** Each page's text, read by pdf.js in the page. */
async function pageTexts(page, bytes) {
  return page.evaluate(async (b64) => {
    const { openPdfJs } = await import(new URL('js/lib/pdfjs.js', location.href).href);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await openPdfJs(data);
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const content = await p.getTextContent();
      out.push(content.items.map((x) => x.str).join('').trim());
    }
    await doc.loadingTask.destroy();
    return out;
  }, Buffer.from(bytes).toString('base64'));
}

/** How pdf.js shows each page: its size turned, and the colour at its middle. */
async function shownPages(page, bytes) {
  return page.evaluate(async (b64) => {
    const { openPdfJs } = await import(new URL('js/lib/pdfjs.js', location.href).href);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await openPdfJs(data);
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const viewport = p.getViewport({ scale: 0.25 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await p.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
      const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
      out.push({ landscape: viewport.width > viewport.height, rgb: [r, g, b] });
    }
    await doc.loadingTask.destroy();
    return out;
  }, Buffer.from(bytes).toString('base64'));
}

/** Back from the result screen to the tool, by the top bar's arrow or the browser's Back. */
async function backToEditing(page, { browserBack = false, touch = false } = {}) {
  if (browserBack) await page.goBack();
  else await press(page, '.ui-result .ui-topbar-nav', { touch });
  await page.waitForSelector('.ui-result', { state: 'detached' });
  await page.waitForSelector('.onepdf');
  checks++;
}

async function checkNoSideways(page, what) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `${what}: nothing scrolls sideways (${overflow} px)`);
}

async function shot(page, name, { full = false } = {}) {
  if (QUICK) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full });
}

async function themes(page, name) {
  if (QUICK) return;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const selectedTiles = (page, scope) => page.$$eval(`${scope} .ui-page[aria-checked="true"]`, (els) => els.map((e) => e.closest('.ui-page-tile').tile.index + 1));

// ---------------------------------------------------------------------------------------------
// The strings: the app's keys and English (strings.xml), none redefining common.js's or kit.js's

async function testStrings() {
  const xmlPath = join(root, '..', 'pdfer', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const common = (await import('../site/app/locales/en/common.js')).default;
  const kit = (await import('../site/app/locales/en/kit.js')).default;
  const app = {};
  if (await exists(xmlPath)) {
    const xml = await readFile(xmlPath, 'utf8');
    for (const m of xml.matchAll(/<string name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) {
      // Android's escapes and %1$d placeholders, as the web's strings write them.
      app[m[1]] = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/%(\d)\$[sd]/g, '{$1}').replace(/&amp;/g, '&');
    }
  }
  if (!Object.keys(app).length) console.log('strings.xml not found: app-string comparison skipped');
  const strings = (await import('../site/app/locales/en/split.js')).default;
  for (const [key, text] of Object.entries(strings)) {
    ok(!(key in common) && !(key in kit), `split: ${key} isn't redefined`);
    if (key.startsWith('web_') || !Object.keys(app).length) continue;
    eq(text, app[key], `split: ${key} as strings.xml has it`);
  }
}

// ---------------------------------------------------------------------------------------------
// The screen's own helpers (PageGrids.kt typedPages/tappedOnto, the taps' text)

async function testHelpers(page, url) {
  await openTool(page, url, 'split');
  const call = (name, ...args) => runInPage(page, url, 'app/js/tools/split/index.js', name, ...args);
  eq(await call('tappedOnto', '3,1-2', 5), [2, 0, 1], 'pages in the order typed');
  eq(await call('tappedOnto', '  ', 5), [], 'blank: none');
  eq(await call('tappedOnto', '2-', 5), null, 'half typed: unreadable');
  eq(await call('tappedOnto', '9', 5), null, 'past the end: unreadable');
  eq(await call('typedPages', '2-', 5), [], 'unreadable: none framed');
  eq(await call('tapPage', '', 3, 5), '4', 'first tap');
  eq(await call('tapPage', '3,1', 1, 5), '3,1-2', 'a tap adds at the end, runs kept short');
  eq(await call('tapPage', '3,1-2', 0, 5), '3,2', 'a tap takes a page out');
  eq(await call('tapPage', '5,4', 5, 6), '5,4,6', 'only runs going up become ranges');
  eq(await call('tapPage', '2-', 0, 5), '2-', 'unreadable text left alone');
  eq(await call('tapPage', '1,1', 0, 5), '', 'a page typed twice comes out once');
}

// ---------------------------------------------------------------------------------------------
// Split PDF

async function testSplit(page, url, fx, { touch, wide }) {
  const size = wide ? 'desktop' : 'phone';
  await openTool(page, url, 'split');
  eq(await page.textContent('.ui-topbar-title'), S.split, 'title');
  eq(await page.textContent('.ui-empty-title'), S.pickPdf, 'empty state');
  eq(await mainButton(page).textContent(), S.split, 'main button');
  ok(await mainButton(page).isDisabled(), 'main button off without a PDF');
  await shot(page, `split-empty-${size}`);

  // A file that isn't a PDF says so, and the screen stays as it was.
  await pick(page, asFile('Broken.pdf', fx.damaged), { touch });
  await snack(page, S.importFailed);
  ok(await page.isVisible('.onepdf .ui-empty'), 'still asks for a PDF');

  await pick(page, asFile('Report.pdf', fx.report), { touch });
  await chosen(page, 'Report.pdf');
  ok(/^12 pages · [\d.]+ kB$/.test(await page.textContent('.onepdf-card .ui-file-detail')), 'pages and size');
  await page.waitForSelector('.onepdf-card .ui-file-thumb canvas');
  eq(await page.inputValue('.onepdf-name .ui-field-input'), 'Report_split', 'default name');
  ok(!(await mainButton(page).isDisabled()), 'Split is on once a PDF is chosen');
  eq(await page.textContent('.split-options .ui-chip[aria-checked="true"] .ui-chip-label'), S.selected, 'Selected pages first');
  eq(await page.textContent('.split-field .ui-field-label'), S.selected, 'field label');
  eq(await page.textContent('.split-field .ui-field-support'), S.selectedHint, 'field hint');
  eq(await page.textContent('.split-options .ui-switch-label'), S.combineSelected, 'combine label');
  eq(await page.getAttribute('.split-options .ui-switch', 'aria-checked'), 'true', 'combine on at first');
  eq(await page.locator('.split-picker .ui-page').count(), 12, 'every page to pick from');
  await page.waitForSelector('.split-picker .ui-page-picture.has-picture canvas');

  // Tapping pages: each goes at the end, a tapped one comes out, runs stay short.
  const tile = (n) => `.split-picker .ui-page-tile:nth-of-type(${n}) .ui-page`;
  for (const n of [3, 1, 2, 5]) await press(page, tile(n), { touch });
  eq(await page.inputValue('.split-field .ui-field-input'), '3,1-2,5', 'pages tapped, in order');
  eq(await selectedTiles(page, '.split-picker'), [1, 2, 3, 5], 'tapped pages framed');
  await press(page, tile(1), { touch });
  eq(await page.inputValue('.split-field .ui-field-input'), '3,2,5', 'tapped again: out');
  await themes(page, `split-selected-${size}`);
  // Typed pages show as chosen.
  await typeInto(page, '.split-field .ui-field-input', '2-4,7');
  eq(await selectedTiles(page, '.split-picker'), [2, 3, 4, 7], 'typed pages framed');
  // Half typed: a tap leaves the text as it is.
  await typeInto(page, '.split-field .ui-field-input', '2-');
  eq(await selectedTiles(page, '.split-picker'), [], 'nothing framed while it cannot be read');
  await press(page, tile(6), { touch });
  eq(await page.inputValue('.split-field .ui-field-input'), '2-', 'tap leaves a half-typed range');

  // Problems with the pages typed are said, and nothing is made.
  for (const [typed, message] of [['', S.format], ['2-', S.format], ['0', S.range(12)], ['13', S.range(12)], ['5-3', S.reversed], ['1;2', S.format]]) {
    await typeInto(page, '.split-field .ui-field-input', typed);
    await press(page, '.onepdf > .ui-bottombar .ui-btn', { touch });
    await snack(page, message);
    ok(!(await page.$('.ui-result')), `nothing made for "${typed}"`);
  }

  // Selected pages, combined: one PDF with the pages in the order typed.
  await typeInto(page, '.split-field .ui-field-input', '3,1');
  let files = await runTool(page, { touch });
  eq(files.map((f) => f.name), ['Report_split.pdf'], 'one PDF');
  eq(await page.textContent('.ui-result-heading'), S.oneReady, 'result heading');
  eq(await pageTexts(page, files[0].bytes), ['PAGE 3', 'PAGE 1'], 'pages in the order typed');
  const shown = await shownPages(page, files[0].bytes);
  eq(shown.map((p) => p.landscape), [true, false], 'page 3 stays landscape');
  ok(/^2 pages · /.test(await page.textContent('.ui-result-file .ui-result-details')), 'result says 2 pages');
  await shot(page, `split-result-one-${size}`);
  // Start over asks while the PDF isn't saved; Cancel keeps it.
  await press(page, '.ui-result-startover', { touch });
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  eq(await page.textContent('dialog[open] .ui-dialog-title'), 'Start over?', 'asked first');
  await press(page, 'dialog[open] .ui-btn:has-text("Cancel")', { touch });
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  ok(await page.isVisible('.ui-result'), 'kept');
  // Saving it: a download named after the file name.
  const [download] = await Promise.all([page.waitForEvent('download'), press(page, '.ui-result-actions .ui-btn:has-text("Save to Downloads")', { touch })]);
  eq(download.suggestedFilename(), 'Report_split.pdf', 'downloaded name');
  eq(await pageTexts(page, new Uint8Array(await readFile(await download.path()))), ['PAGE 3', 'PAGE 1'], 'downloaded PDF');
  await backToEditing(page, { touch });
  eq(await page.inputValue('.split-field .ui-field-input'), '3,1', 'pages kept after Back to editing');
  eq(await page.inputValue('.onepdf-name .ui-field-input'), 'Report_split', 'name kept');

  // Not combined: a PDF for each page selected, named by part and pages.
  await press(page, '.split-options .ui-switch-row', { touch });
  eq(await page.getAttribute('.split-options .ui-switch', 'aria-checked'), 'false', 'combine off');
  files = await runTool(page, { touch });
  eq(files.map((f) => f.name), ['Report_split_1_3-3.pdf', 'Report_split_2_1-1.pdf'], 'a PDF per page');
  eq(await page.textContent('.ui-result-heading'), S.manyReady, 'several ready');
  eq(await pageTexts(page, files[0].bytes), ['PAGE 3'], 'first part');
  eq(await pageTexts(page, files[1].bytes), ['PAGE 1'], 'second part');
  // The browser's Back goes back to the tool, not out of it.
  await backToEditing(page, { browserBack: true });
  eq(await page.evaluate(() => location.hash), '#/tool/split', 'still in Split PDF');
  // Forward to the result left: it has gone, so its history step goes back too.
  await page.goForward();
  await page.waitForFunction(() => (history.state?.step ?? null) === null, null, { timeout: 5000 });
  ok(!(await page.$('.ui-result')) && await page.isVisible('.onepdf-card'), 'Forward: the tool as it was');
  eq(await page.inputValue('.split-field .ui-field-input'), '3,1', 'pages kept after Forward');

  // Custom ranges: their own labels, the picker goes, what was typed is cleared. The field and the
  // Combine switch are the same ones (the kit's setLabel), as the app's.
  await page.evaluate(() => { window.__splitField = document.querySelector('.split-field'); window.__splitSwitch = document.querySelector('.split-options .ui-switch-row'); });
  await press(page, `.split-options .ui-chip:has-text("${S.custom}")`, { touch });
  ok(await page.evaluate(() => document.querySelector('.split-field') === window.__splitField), 'the same field for custom ranges');
  ok(await page.evaluate(() => document.querySelector('.split-options .ui-switch-row') === window.__splitSwitch), 'the same Combine switch for custom ranges');
  eq(await page.getAttribute('.split-field .ui-field-input', 'inputmode'), null, 'a text keyboard for ranges');
  await page.waitForSelector('.split-picker', { state: 'hidden' });
  eq(await page.inputValue('.split-field .ui-field-input'), '', 'text cleared with the mode');
  eq(await page.textContent('.split-field .ui-field-label'), S.custom, 'custom label');
  eq(await page.textContent('.split-field .ui-field-support'), S.customHint, 'custom hint');
  eq(await page.textContent('.split-options .ui-switch-label'), S.combineRanges, 'combine ranges label');
  eq(await page.getAttribute('.split-options .ui-switch', 'aria-checked'), 'false', 'combine kept as chosen');
  await shot(page, `split-custom-${size}`);
  await typeInto(page, '.split-field .ui-field-input', '1-3,5');
  await press(page, '.onepdf > .ui-bottombar .ui-btn', { touch });
  await snack(page, S.rangesFormat);
  await typeInto(page, '.split-field .ui-field-input', '1-2;5;9-12');
  files = await runTool(page, { touch });
  eq(files.map((f) => f.name), ['Report_split_1_1-2.pdf', 'Report_split_2_5-5.pdf', 'Report_split_3_9-12.pdf'], 'a PDF per range');
  eq(await Promise.all(files.map(async (f) => (await PDFDocument.load(f.bytes)).getPageCount())), [2, 1, 4], 'range sizes');
  eq(await pageTexts(page, files[2].bytes), ['PAGE 9', 'PAGE 10', 'PAGE 11', 'PAGE 12'], 'last range');
  await backToEditing(page, { touch });
  await press(page, '.split-options .ui-switch-row', { touch });
  files = await runTool(page, { touch });
  eq(files.map((f) => f.name), ['Report_split.pdf'], 'ranges combined');
  eq(await pageTexts(page, files[0].bytes), ['PAGE 1', 'PAGE 2', 'PAGE 5', 'PAGE 9', 'PAGE 10', 'PAGE 11', 'PAGE 12'], 'combined ranges in order');
  await backToEditing(page, { touch });

  // Fixed chunks: a number, no switch.
  await press(page, `.split-options .ui-chip:has-text("${S.fixed}")`, { touch });
  await page.waitForFunction(() => document.querySelector('.split-section:has(.ui-switch-row)')?.hidden);
  eq(await page.textContent('.split-field .ui-field-label'), S.fixedHint, 'fixed label');
  eq(await page.textContent('.split-field .ui-field-support'), S.fixedExample, 'fixed hint');
  eq(await page.getAttribute('.split-field .ui-field-input', 'inputmode'), 'numeric', 'number keyboard');
  await shot(page, `split-fixed-${size}`);
  for (const [typed, message] of [['13', S.chunk(12)], ['0', S.chunk(12)], ['two', S.chunk(12)], ['', S.chunk(12)]]) {
    await typeInto(page, '.split-field .ui-field-input', typed);
    await press(page, '.onepdf > .ui-bottombar .ui-btn', { touch });
    await snack(page, message);
  }
  await typeInto(page, '.split-field .ui-field-input', ' 5 ');
  await typeInto(page, '.onepdf-name .ui-field-input', 'Chunks');
  files = await runTool(page, { touch });
  eq(files.map((f) => f.name), ['Chunks_1_1-5.pdf', 'Chunks_2_6-10.pdf', 'Chunks_3_11-12.pdf'], 'chunks named after the name typed');
  eq(await Promise.all(files.map(async (f) => (await PDFDocument.load(f.bytes)).getPageCount())), [5, 5, 2], 'chunk sizes');
  await backToEditing(page, { touch });
  ok(await page.evaluate(() => document.querySelector('.split-field') === window.__splitField), 'the same field for fixed chunks');
  // From Fixed chunks to Custom ranges: the field takes their label and a text keyboard again.
  await press(page, `.split-options .ui-chip:has-text("${S.custom}")`, { touch });
  eq(await page.textContent('.split-field .ui-field-label'), S.custom, 'custom label again');
  eq(await page.textContent('.split-field .ui-field-outline legend'), S.custom, 'the outline leaves room for it');
  eq(await page.getAttribute('.split-field .ui-field-input', 'inputmode'), null, 'no number keyboard for ranges');
  // The Combine switch's section, closed for Fixed chunks, is open again.
  const combineOpen = await page.evaluate(() => {
    const box = document.querySelector('.split-section:has(.ui-switch-row)');
    return !box.hidden && !box.inert && !box.classList.contains('is-collapsed');
  });
  ok(combineOpen, 'the Combine switch is back for custom ranges');

  // Every page: nothing to type; a PDF of each page, and a ZIP of them all.
  await press(page, `.split-options .ui-chip:has-text("${S.every}")`, { touch });
  await page.waitForFunction(() => document.querySelector('.split-section:has(.split-field)')?.hidden);
  eq(await page.textContent('.split-field .ui-field-label'), S.custom, 'closed, the field keeps its words');
  eq(await page.inputValue('.split-field .ui-field-input'), '', 'and nothing typed');
  await shot(page, `split-every-${size}`);
  await typeInto(page, '.onepdf-name .ui-field-input', '');
  files = await runTool(page, { touch });
  eq(files.length, 12, 'twelve PDFs');
  eq(files[0].name, 'Split_1_1-1.pdf', 'a blank name falls back to Split');
  eq(files[11].name, 'Split_12_12-12.pdf', 'last part');
  eq(await pageTexts(page, files[11].bytes), ['PAGE 12'], 'last page alone');
  await shot(page, `split-result-many-${size}`, { full: true });
  await press(page, '.ui-result-actions .ui-btn:has-text("Share or save as ZIP")', { touch });
  const [zipDownload] = await Promise.all([page.waitForEvent('download'), press(page, '.ui-menu-item:has-text("Save ZIP to Downloads")', { touch })]);
  eq(zipDownload.suggestedFilename(), 'Usugami.zip', 'ZIP named after the blank name');
  const entries = Object.keys(unzipSync(new Uint8Array(await readFile(await zipDownload.path()))));
  eq(entries.length, 12, 'every part in the ZIP');
  ok(entries.includes('Split_7_7-7.pdf'), 'parts keep their names in the ZIP');
  // Saved: Start over doesn't ask.
  await page.waitForSelector('.ui-result-unsaved', { state: 'hidden' });
  await press(page, '.ui-result-startover', { touch });
  await page.waitForSelector('.onepdf .ui-empty');
  ok(!(await page.$('dialog[open]')), 'nothing asked once saved');
  ok(await mainButton(page).isDisabled(), 'Split off again');
  // The history step of the result went with it.
  await page.waitForTimeout(100);
  eq(await page.evaluate(() => history.state?.step ?? null), null, 'no result step left');

  // Choose another PDF (a web extra): Split PDF holds no changes to lose, so the picker opens at
  // once; the new PDF comes with its own pages and name, and nothing typed.
  await pick(page, asFile('Report.pdf', fx.report), { touch });
  await chosen(page, 'Report.pdf');
  await typeInto(page, '.split-field .ui-field-input', '2-4');
  await typeInto(page, '.onepdf-name .ui-field-input', 'Mine');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), press(page, `.onepdf-card .ui-btn:has-text("${S.another}")`, { touch })]);
  ok(!(await page.$('dialog[open]')), 'nothing asked before the picker');
  await chooser.setFiles(asFile('Other.pdf', fx.other));
  await chosen(page, 'Other.pdf');
  eq(await page.locator('.split-picker .ui-page').count(), 3, "the other PDF's pages");
  eq(await page.inputValue('.onepdf-name .ui-field-input'), 'Other_split', 'its own name');
  eq(await page.inputValue('.split-field .ui-field-input'), '', 'nothing typed yet');
  // Remove takes it away: the screen asks for a PDF again.
  await press(page, '.onepdf-card .ui-icon-btn[aria-label="Remove Other.pdf"]', { touch });
  await page.waitForSelector('.onepdf .ui-empty');
  ok(await mainButton(page).isDisabled(), 'Split off once the PDF is removed');

  // A PDF with a password: asked for, a wrong one said, the new PDF has none.
  await pick(page, asFile('protected.pdf', fx.locked.bytes), { touch });
  await page.waitForSelector('dialog[open] input[type="password"]');
  await shot(page, `password-${size}`);
  await page.fill('dialog[open] input[type="password"]', 'nope');
  await press(page, 'dialog[open] .ui-btn:has-text("Open PDF")', { touch });
  await page.waitForFunction((t) => document.querySelector('dialog[open] .ui-field-support')?.textContent === t, S.wrongPassword);
  checks++;
  await page.fill('dialog[open] input[type="password"]', fx.locked.password);
  await press(page, 'dialog[open] .ui-btn:has-text("Open PDF")', { touch });
  await chosen(page, 'protected.pdf');
  await typeInto(page, '.split-field .ui-field-input', '1');
  const locked = await runTool(page, { touch });
  ok(locked[0].passwordRemoved, 'told the password went');
  eq(await page.textContent('.ui-result-note'), S.noPassword, 'says the new PDF has no password');
  const out = await PDFDocument.load(locked[0].bytes, { updateMetadata: false });
  ok(!out.isEncrypted, 'saved without a password');
  eq(out.getPageCount(), 1, 'the one page asked for');

  // Leaving the tool with pages typed doesn't ask: typing isn't work to lose (as the app).
  await backToEditing(page, { touch });
  eq(await page.inputValue('.split-field .ui-field-input'), '1', 'pages kept');
  await press(page, '.onepdf .ui-topbar-nav', { touch });
  await page.waitForSelector('#app .screen[data-tool="split"]', { state: 'detached' });
  ok(!(await page.$('dialog[open]')), 'nothing asked on leaving');
}

// ---------------------------------------------------------------------------------------------
// Desktop extras: files dropped, a long PDF, cancelling, a PDF handed over, the password question

async function testDesktopExtras(page, url, fx) {
  // A PDF dropped on the Choose PDF card opens; one dropped on the screen then takes its place.
  await openTool(page, url, 'split');
  const drop = (name, bytes, target = '.onepdf') => dropFile(page, name, bytes, target);
  await drop('Report.pdf', fx.report, '.ui-empty');
  await chosen(page, 'Report.pdf');
  eq(await page.locator('.split-picker .ui-page').count(), 12, 'the PDF dropped on the card');
  await drop('Other.pdf', fx.other);
  await chosen(page, 'Other.pdf');
  eq(await page.locator('.split-picker .ui-page').count(), 3, 'the PDF dropped on the screen');

  // A long PDF: the screen stays responsive, pages are drawn as they come near, and the work can
  // be cancelled.
  await openTool(page, url, 'split');
  await pick(page, asFile('Long.pdf', fx.big));
  await chosen(page, 'Long.pdf');
  eq(await page.locator('.split-picker .ui-page').count(), 3000, 'every page listed');
  await page.waitForSelector('.split-picker .ui-page-picture.has-picture');
  const drawn = await page.locator('.split-picker .ui-page-picture.has-picture').count();
  ok(drawn > 0 && drawn < 120, `only pages near the view drawn (${drawn})`);
  // Typing frames the pages typed; only the pages whose choice changed are drawn again.
  await typeInto(page, '.split-field .ui-field-input', '1-3000');
  eq(await page.locator('.split-picker .ui-page[aria-checked="true"]').count(), 3000, 'every page framed');
  await typeInto(page, '.split-field .ui-field-input', '5');
  eq(await selectedTiles(page, '.split-picker'), [5], 'one page framed');
  const typing = await page.evaluate(() => {
    const input = document.querySelector('.split-field .ui-field-input');
    const t0 = performance.now();
    input.value = '5,7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return performance.now() - t0;
  });
  eq(await selectedTiles(page, '.split-picker'), [5, 7], 'a page added to the frame');
  ok(typing < 250, `a page more typed in a 3000-page PDF redraws quickly (${typing.toFixed(1)} ms)`);
  await page.click(`.split-options .ui-chip:has-text("${S.every}")`);
  // The CPU slowed down while it works, so the split can't be over before Cancel is pressed on a
  // fast (or an idle) machine; the page must still answer.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    await page.click('.onepdf > .ui-bottombar .ui-btn');
    await page.waitForSelector('dialog[open] .ui-progress-dialog', { timeout: 20000 });
    await page.waitForSelector('dialog[open].is-shown .ui-progress-dialog', { timeout: 20000 });
    // Its scale-in over, the Cancel button stands still to be clicked (the bar's endless sweep aside).
    await page.waitForFunction(() => {
      const d = document.querySelector('dialog[open].is-shown');
      return !!d && d.getAnimations({ subtree: true })
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .every((a) => a.playState !== 'running');
    }, null, { timeout: 20000 });
    await shot(page, 'progress-desktop');
    // Progress moves while the main thread answers.
    const t0 = Date.now();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    ok(Date.now() - t0 < 1000, 'the page answers while it works');
    await page.waitForFunction(() => Number(document.querySelector('dialog[open] .ui-progress')?.getAttribute('aria-valuenow') ?? 0) > 0, null, { timeout: 20000 });
    checks++;
    ok(!(await page.$('.ui-result')), 'still working when Cancel is pressed');
    await page.click('dialog[open] .ui-btn:has-text("Cancel")');
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
  }
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 20000 });
  await noSnack(page, 500);
  ok(!(await page.$('.ui-result')), 'cancelled: no result');
  ok(!(await mainButton(page).isDisabled()), 'ready to go again');
  // The main button was only marked off meanwhile, so the dialog gave the focus back to it.
  ok(await page.evaluate(() => document.activeElement === document.querySelector('.onepdf > .ui-bottombar .ui-btn')), 'the focus is back on Split PDF');

  // Tool opened with a PDF handed over (Choose a tool, Home's drop): from Home, so the tool mounts
  // anew with the file rather than the screen above being shown again.
  await page.evaluate(async (b64) => {
    const { navigate } = await import(new URL('js/core/router.js', location.href).href);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await navigate('/');
    await navigate('/tool/split', { files: [{ name: 'Handed.pdf', type: 'application/pdf', size: bytes.length, lastModified: 0, bytes }] });
  }, Buffer.from(fx.other).toString('base64'));
  await chosen(page, 'Handed.pdf');
  eq(await page.locator('.split-picker .ui-page').count(), 3, 'the PDF handed over is open');

  // The browser's Back while a password is asked for closes the question, as Android's Back closes
  // a dialog, and stays; the focus goes back to the card picked from.
  await openTool(page, url, 'split');
  await pick(page, asFile('protected.pdf', fx.locked.bytes));
  await page.waitForSelector('dialog[open] input[type="password"]');
  await page.goBack();
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
  eq(await page.evaluate(() => location.hash), '#/tool/split', 'Back closes the password question first');
  ok(await page.evaluate(() => document.activeElement === document.querySelector('.onepdf .ui-empty')), 'the focus is back on Choose PDF');
  // Leaving while a password is asked for takes the question away with the tool.
  await pick(page, asFile('protected.pdf', fx.locked.bytes));
  await page.waitForSelector('dialog[open] input[type="password"]');
  await page.evaluate(async () => (await import(new URL('js/core/router.js', location.href).href)).navigate('/'));
  await page.waitForSelector('#app .screen[data-route="home"]:not([aria-busy])');
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
  checks++;
}

// ---------------------------------------------------------------------------------------------
// What reviewers found, checked: the focus where a keyboard user expects it, failures heard once
// the progress has gone, a paste after the result, the main button under its column.

async function testReviewFixes(page, url, fx) {
  const active = () => page.evaluate(() => {
    const a = document.activeElement;
    return a === document.body || !a ? 'BODY' : (a.getAttribute('aria-label') ?? a.textContent.trim());
  });

  // A password question cancelled with Escape: the focus stays on Choose PDF, opened from the keyboard.
  await openTool(page, url, 'split');
  const chooser = await chooserFromKeyboard(page, '.onepdf .ui-empty');
  await chooser.setFiles(asFile('protected.pdf', fx.locked.bytes));
  await page.waitForSelector('dialog[open] input[type="password"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
  ok(await page.evaluate(() => document.activeElement === document.querySelector('.onepdf .ui-empty')), `password cancelled: the focus on Choose PDF (${await active()})`);

  // A PDF pdf.js shows but the engine refuses (no %PDF header): the failure is said once the
  // progress dialog has gone, when a screen reader can reach it.
  await openTool(page, url, 'split');
  await page.evaluate(() => {
    window.__said = [];
    const watch = () => {
      const node = document.getElementById('announcer');
      if (!node) return requestAnimationFrame(watch);
      new MutationObserver(() => {
        if (node.textContent) window.__said.push({ text: node.textContent, modal: !!document.querySelector('dialog[open]') });
      }).observe(node, { childList: true, characterData: true, subtree: true });
    };
    watch();
  });
  // An announcement first, so the live region (made on first use) is there to watch.
  await page.evaluate(async () => (await import(new URL('js/core/dom.js', location.href).href)).announce('start'));
  await pick(page, asFile('Headless.pdf', fx.headless));
  await chosen(page, 'Headless.pdf');
  await page.click(`.split-options .ui-chip:has-text("${S.every}")`);
  await page.click('.onepdf > .ui-bottombar .ui-btn');
  await snack(page, S.importFailed);
  await page.waitForFunction((text) => window.__said.some((s) => s.text === text), S.importFailed, { timeout: 5000 });
  eq((await page.evaluate(() => window.__said)).filter((s) => s.text === S.importFailed).map((s) => s.modal), [false], 'said once, with no dialog over the page');

  // A PDF pasted on the result screen, then one pasted on the tool: it takes the open one's place.
  const paste = (name, bytes) => page.evaluate(({ name, b64 }) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'application/pdf' }));
    document.body.focus();
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { name, b64: Buffer.from(bytes).toString('base64') });
  await openTool(page, url, 'split');
  await pick(page, asFile('Report.pdf', fx.report));
  await chosen(page, 'Report.pdf');
  await typeInto(page, '.split-field .ui-field-input', '1');
  await runTool(page, { touch: false });
  await paste('OnResult.pdf', fx.other);
  await page.waitForTimeout(300);
  // Back to editing from the keyboard: the focus goes to the main button.
  await page.focus('.ui-result .ui-topbar-nav');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ui-result', { state: 'detached' });
  eq(await active(), S.split, 'Back to editing: the focus on Split PDF');
  eq(await page.textContent('.onepdf-card .ui-file-name'), 'Report.pdf', 'a paste on the result screen changes nothing');
  await paste('Pasted.pdf', fx.other);
  await chosen(page, 'Pasted.pdf');

  // Start over from the keyboard (not saved: asked first): the focus on Choose PDF.
  await typeInto(page, '.split-field .ui-field-input', '2');
  await runTool(page, { touch: false });
  await page.focus('.ui-result-startover');
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open] .ui-btn:has-text("Start over")');
  await page.click('dialog[open] .ui-btn:has-text("Start over")');
  await page.waitForSelector('.onepdf .ui-empty');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  ok(await page.evaluate(() => document.activeElement === document.querySelector('.onepdf .ui-empty')), `Start over: the focus on Choose PDF (${await active()})`);

  // On a wide screen the main button ends where the column above it ends (with a PDF open, so the
  // column holds the screen's parts).
  await openTool(page, url, 'split');
  await pick(page, asFile('Report.pdf', fx.report));
  await chosen(page, 'Report.pdf');
  for (const width of [1366, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const edges = await page.evaluate(() => {
      const main = document.querySelector('.onepdf-main');
      const column = main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight);
      return { column, button: document.querySelector('.onepdf > .ui-bottombar .ui-btn').getBoundingClientRect().right };
    });
    ok(Math.abs(edges.column - edges.button) <= 1, `${width} px: the main button under the column's end (${JSON.stringify(edges)})`);
  }
  await page.setViewportSize(DESKTOP);
}

// ---------------------------------------------------------------------------------------------
// Narrow screens

async function testNarrow(page, url, fx) {
  await page.setViewportSize({ width: 320, height: 640 });
  await openTool(page, url, 'split');
  await checkNoSideways(page, 'split empty at 320 px');
  await pick(page, asFile('A very long file name for a report that goes on and on.pdf', fx.report), { touch: true });
  await chosen(page, 'A very long file name for a report that goes on and on.pdf');
  await page.waitForTimeout(300);
  await checkNoSideways(page, 'split at 320 px');
  const small = await page.evaluate(() => [...document.querySelectorAll('.onepdf .ui-icon-btn')].filter((b) => b.getBoundingClientRect().height < 48 && b.getClientRects().length).length);
  eq(small, 0, 'split: icon buttons 48 px to tap');
  await shot(page, 'split-320', { full: true });
}

// ---------------------------------------------------------------------------------------------
// The same flows, shorter, in Firefox and WebKit

async function testOtherBrowser(page, url, fx, browser) {
  const touch = browser !== 'firefox';
  // The PDF picked through the file input; the top bar's arrow back to editing.
  await openTool(page, url, 'split');
  await pick(page, asFile('Report.pdf', fx.report), { touch });
  await chosen(page, 'Report.pdf');
  for (const n of [4, 2]) await press(page, `.split-picker .ui-page-tile:nth-of-type(${n}) .ui-page`, { touch });
  eq(await page.inputValue('.split-field .ui-field-input'), '4,2', `${browser}: pages tapped`);
  let files = await runTool(page, { touch });
  eq(await pageTexts(page, files[0].bytes), ['PAGE 4', 'PAGE 2'], `${browser}: split`);
  await backToEditing(page, { touch });
  await shot(page, `split-${browser}`);

  // The PDF dropped on the card; the browser's Back to editing.
  await openTool(page, url, 'split');
  await pick(page, asFile('Report.pdf', fx.report), { touch, drop: true });
  await chosen(page, 'Report.pdf');
  await press(page, '.split-picker .ui-page-tile:nth-of-type(1) .ui-page', { touch });
  files = await runTool(page, { touch });
  eq(await pageTexts(page, files[0].bytes), ['PAGE 1'], `${browser}: the dropped PDF split`);
  await backToEditing(page, { browserBack: true });
  eq(await page.evaluate(() => location.hash), '#/tool/split', `${browser}: still in Split PDF`);
  eq(await page.inputValue('.split-field .ui-field-input'), '1', `${browser}: pages kept`);
}

// ---------------------------------------------------------------------------------------------

const fx = await fixtures();
let passed = 0;
const step = async (name, fn) => {
  const t0 = performance.now();
  await fn();
  passed++;
  console.log(`  ok ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
};

if (REVIEW) {
  await withPage(async (page, url) => {
    await step('focus, messages after the progress, paste after a result, layout', () => testReviewFixes(page, url, fx));
  }, { viewport: DESKTOP, mobile: false });
} else if (!OTHERS) {
await step('strings', () => testStrings());
console.log('Phone (360 px, touch), Chromium');
await withPage(async (page, url) => {
  await step('helpers', () => testHelpers(page, url));
  await step('split', () => testSplit(page, url, fx, { touch: true, wide: false }));
  await step('320 px', () => testNarrow(page, url, fx));
}, { viewport: PHONE });

console.log('Desktop (1366 px, mouse and keyboard), Chromium');
await withPage(async (page, url) => {
  // Nothing Split PDF does embeds a font with pdf-lib: fontkit (157 kB gzipped) isn't loaded.
  const fontkit = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/fontkit/')) fontkit.push(r.url()); });
  await step('split', () => testSplit(page, url, fx, { touch: false, wide: true }));
  await step('drop, long PDF, cancel, a PDF handed over, the password question', () => testDesktopExtras(page, url, fx));
  await step('focus, messages after the progress, paste after a result, layout', () => testReviewFixes(page, url, fx));
  eq(fontkit, [], 'no fontkit loaded by Split PDF');
}, { viewport: DESKTOP, mobile: false });
}

if (!QUICK) {
  for (const browser of ['firefox', 'webkit']) {
    console.log(`Phone (360 px), ${browser}`);
    await withPage(async (page, url) => {
      await step(`${browser}: split`, () => testOtherBrowser(page, url, fx, browser));
    }, { browser, viewport: PHONE });
  }
}

console.log(`organize-ui-a: ${passed} groups, ${checks} checks passed`);
