// Split PDF, Delete pages and Rotate PDF (js/tools/split, delete-pages, rotate): each screen driven
// in the app as a person would, by touch at phone size and by mouse and keyboard at desktop size,
// with the PDFs made read back (page counts, turns, text with pdf.js, what the pages show).
// Run with: node tests/organize-ui-a.test.mjs   (--quick: Chromium only, no screenshots;
// --others: Firefox and WebKit only; --review: Chromium, the reviewers' findings only)
// Screenshots go to .tmp/organize-ui-a/screens/ to be looked at.
import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { withPage, assert, root, runInPage } from './harness.mjs';
import { PDFDocument, PDFName, rgb, degrees, StandardFonts } from '../site/app/vendor/pdf-lib/pdf-lib.esm.min.js';
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

// The English the screens should show (strings.xml).
const S = {
  split: 'Split PDF',
  deleteAction: 'Delete pages',
  rotateAction: 'Rotate PDF',
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
  needPage: 'Keep at least one page.',
  deleteField: 'Pages to delete',
  deleteHint: 'For example: 2,5-7. Or tap the pages below.',
  deleteCount: (a, b) => `To delete: ${a} of ${b}`,
  rotateAll: 'All pages',
  rotateHint: 'Turn pages one by one, or all at once.',
  turnedRight: 'Turned right',
  turnedLeft: 'Turned left',
  upsideDown: 'Upside down',
  reset: 'Reset pages',
  discardTitle: 'Discard your changes?',
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
const fieldInput = (page, cls) => page.locator(`${cls} .ui-field-input`);

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

async function rotationsOf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => p.getRotation().angle);
}

async function resultNames(page) {
  return page.$$eval('.ui-result-file .ui-result-name', (els) => els.map((e) => e.textContent));
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
  for (const ns of ['split', 'delete-pages', 'rotate']) {
    const strings = (await import(`../site/app/locales/en/${ns}.js`)).default;
    for (const [key, text] of Object.entries(strings)) {
      ok(!(key in common) && !(key in kit), `${ns}: ${key} isn't redefined`);
      if (key.startsWith('web_') || !Object.keys(app).length) continue;
      eq(text, app[key], `${ns}: ${key} as strings.xml has it`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The screens' own helpers (PageGrids.kt typedPages/tappedOnto, the taps' text, turns)

async function testHelpers(page, url) {
  await openTool(page, url, 'split');
  const call = (mod, name, ...args) => runInPage(page, url, `app/js/tools/${mod}/index.js`, name, ...args);
  eq(await call('split', 'tappedOnto', '3,1-2', 5), [2, 0, 1], 'pages in the order typed');
  eq(await call('split', 'tappedOnto', '  ', 5), [], 'blank: none');
  eq(await call('split', 'tappedOnto', '2-', 5), null, 'half typed: unreadable');
  eq(await call('split', 'tappedOnto', '9', 5), null, 'past the end: unreadable');
  eq(await call('split', 'typedPages', '2-', 5), [], 'unreadable: none framed');
  eq(await call('split', 'tapPage', '', 3, 5), '4', 'first tap');
  eq(await call('split', 'tapPage', '3,1', 1, 5), '3,1-2', 'a tap adds at the end, runs kept short');
  eq(await call('split', 'tapPage', '3,1-2', 0, 5), '3,2', 'a tap takes a page out');
  eq(await call('split', 'tapPage', '5,4', 5, 6), '5,4,6', 'only runs going up become ranges');
  eq(await call('split', 'tapPage', '2-', 0, 5), '2-', 'unreadable text left alone');
  eq(await call('split', 'tapPage', '1,1', 0, 5), '', 'a page typed twice comes out once');
  eq(await call('delete-pages', 'toggleMark', '2,7', 4, 10), '2,5,7', 'marked, sorted');
  eq(await call('delete-pages', 'toggleMark', '2,5-7', 5, 10), '2,5,7', 'unmarked');
  eq(await call('delete-pages', 'toggleMark', '', 0, 10), '1', 'first mark');
  eq(await call('delete-pages', 'toggleMark', '3-', 0, 10), '3-', 'unreadable text left alone');
  eq(await call('delete-pages', 'toggleMark', '7,6,5', 4, 10), '6-7', 'sorted into a run');
  eq(await call('rotate', 'turnedKey', 90), 'rotated_right', 'right');
  eq(await call('rotate', 'turnedKey', 180), 'rotated_upside_down', 'upside down');
  eq(await call('rotate', 'turnedKey', -90), 'rotated_left', 'left');
  eq(await call('rotate', 'turnedKey', 360), null, 'upright');
  eq(await call('rotate', 'nextAngle', 270, 0), 360, '270 to 0 goes a quarter on');
  eq(await call('rotate', 'nextAngle', 0, 270), -90, '0 to 270 goes a quarter back');
  eq(await call('rotate', 'nextAngle', -90, 90), 90, 'a half turn goes clockwise, as the app');
  eq(await call('rotate', 'nextAngle', 450, 180), 540, 'running angles stay running');
  // A portrait page fills the box's height upright; lying down, its height is the box's width.
  const portrait = await call('rotate', 'sidewaysScale', 595 / 842);
  ok(Math.abs(portrait - 55 / 72) < 1e-6, `a portrait page lying down shrinks to fit (${portrait})`);
  // A landscape page fills the box's width upright; stood up, it grows to the box's height.
  const landscape = await call('rotate', 'sidewaysScale', 842 / 595);
  ok(Math.abs(landscape - 72 / 55) < 1e-6, `a landscape page stood up grows to fit (${landscape})`);
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
}

// ---------------------------------------------------------------------------------------------
// Delete pages

async function testDeletePages(page, url, fx, { touch, wide }) {
  const size = wide ? 'desktop' : 'phone';
  await openTool(page, url, 'delete-pages');
  eq(await page.textContent('.ui-topbar-title'), S.deleteAction, 'title');
  eq(await mainButton(page).textContent(), S.deleteAction, 'main button');

  // A file that isn't a PDF says so, and the screen stays as it was.
  await pick(page, asFile('Broken.pdf', fx.damaged), { touch });
  await snack(page, S.importFailed);
  ok(await page.isVisible('.onepdf .ui-empty'), 'still asks for a PDF');

  await pick(page, asFile('Report.pdf', fx.report), { touch });
  await chosen(page, 'Report.pdf');
  eq(await page.inputValue('.onepdf-name .ui-field-input'), 'Report_pages_deleted', 'default name');
  eq(await page.textContent('.delete-pages-count'), S.deleteCount(0, 12), 'none marked');
  eq(await page.getAttribute('.delete-pages-count', 'aria-live'), 'polite', 'count is announced');
  eq(await page.textContent('.ui-field:not(.onepdf-name) .ui-field-label'), S.deleteField, 'field label');
  eq(await page.textContent('.ui-field:not(.onepdf-name) .ui-field-support'), S.deleteHint, 'field hint');
  ok(await mainButton(page).isDisabled(), 'off until pages are named');
  ok(await page.isHidden('.delete-pages-need'), 'no warning yet');

  // Tapping marks pages, written sorted with runs as ranges.
  const tile = (n) => `.delete-pages-grid .ui-page-tile:nth-of-type(${n}) .ui-page`;
  for (const n of [7, 2, 5, 6]) await press(page, tile(n), { touch });
  eq(await page.inputValue('.ui-field:not(.onepdf-name) .ui-field-input'), '2,5-7', 'taps written as typed');
  eq(await page.textContent('.delete-pages-count'), S.deleteCount(4, 12), 'four to delete');
  eq(await selectedTiles(page, '.delete-pages-grid'), [2, 5, 6, 7], 'marked pages');
  eq(await page.getAttribute(tile(2), 'aria-label'), 'Page 2, Marked to delete', 'a marked page says so');
  eq(await page.getAttribute(tile(3), 'aria-label'), 'Page 3, Kept', 'a kept page says so');
  ok(!(await mainButton(page).isDisabled()), 'Delete pages on');
  await page.waitForSelector('.delete-pages-grid .ui-page-tile.is-selected .ui-page-picture.has-picture');
  await themes(page, `delete-marked-${size}`);
  await press(page, tile(6), { touch });
  eq(await page.inputValue('.ui-field:not(.onepdf-name) .ui-field-input'), '2,5,7', 'unmarked');

  // Every page marked: one must stay.
  await typeInto(page, '.ui-field:not(.onepdf-name) .ui-field-input', '1-12');
  eq(await page.textContent('.delete-pages-count'), S.deleteCount(12, 12), 'all marked');
  await page.waitForSelector('.delete-pages-need', { state: 'visible' });
  eq(await page.textContent('.delete-pages-need'), S.needPage, 'keep a page');
  await shot(page, `delete-need-${size}`);
  await press(page, '.onepdf > .ui-bottombar .ui-btn', { touch });
  await snack(page, S.needPage);
  for (const [typed, message] of [['13', S.range(12)], ['2,x', S.format], ['9-4', S.reversed], ['  ', null]]) {
    await typeInto(page, '.ui-field:not(.onepdf-name) .ui-field-input', typed);
    if (!message) {
      ok(await mainButton(page).isDisabled(), 'blank: nothing to delete');
      continue;
    }
    await press(page, '.onepdf > .ui-bottombar .ui-btn', { touch });
    await snack(page, message);
  }
  await page.waitForSelector('.delete-pages-need', { state: 'hidden' });

  await typeInto(page, '.ui-field:not(.onepdf-name) .ui-field-input', '2,5-7');
  const files = await runTool(page, { touch });
  eq(files.map((f) => f.name), ['Report_pages_deleted.pdf'], 'named');
  eq(await pageTexts(page, files[0].bytes), ['PAGE 1', 'PAGE 3', 'PAGE 4', 'PAGE 8', 'PAGE 9', 'PAGE 10', 'PAGE 11', 'PAGE 12'], 'the pages left');
  ok(!(new TextDecoder('latin1').decode(files[0].bytes).includes('PAGE 6')), 'deleted pages are gone from the file');
  ok(/^8 pages · /.test(await page.textContent('.ui-result-file .ui-result-details')), 'result says 8 pages');
  await shot(page, `delete-result-${size}`);
  // Start over asks while the PDF isn't saved.
  await press(page, '.ui-result-startover', { touch });
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  eq(await page.textContent('dialog[open] .ui-dialog-title'), 'Start over?', 'asked first');
  await press(page, 'dialog[open] .ui-btn:has-text("Cancel")', { touch });
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  ok(await page.isVisible('.ui-result'), 'kept');
  // On the computer the browser's Back returns to editing (the result's history step).
  await backToEditing(page, { touch, browserBack: !touch });
  eq(await page.evaluate(() => location.hash), '#/tool/delete-pages', 'still in Delete pages');
  // The marks stay for another go.
  eq(await page.inputValue('.ui-field:not(.onepdf-name) .ui-field-input'), '2,5-7', 'marks kept');
  // Leaving the tool with marks only doesn't ask: nothing is turned or moved (as the app).
  await press(page, '.onepdf .ui-topbar-nav', { touch });
  await page.waitForSelector('#app .screen[data-tool="delete-pages"]', { state: 'detached' });
  ok(!(await page.$('dialog[open]')), 'nothing asked on leaving');

  // A PDF with a password: asked for, a wrong one said, the new PDF has none.
  await openTool(page, url, 'delete-pages');
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
  await typeInto(page, '.ui-field:not(.onepdf-name) .ui-field-input', '1');
  const locked = await runTool(page, { touch });
  ok(locked[0].passwordRemoved, 'told the password went');
  eq(await page.textContent('.ui-result-note'), S.noPassword, 'says the new PDF has no password');
  const out = await PDFDocument.load(locked[0].bytes, { updateMetadata: false });
  ok(!out.isEncrypted, 'saved without a password');
  eq(out.getPageCount(), (await PDFDocument.load(fx.locked.bytes, { ignoreEncryption: true })).getPageCount() - 1, 'one page fewer');
}

// ---------------------------------------------------------------------------------------------
// Rotate PDF

const turnOf = (page, n) => page.evaluate((i) => document.querySelectorAll('.rotate-card')[i].card.angle, n - 1);
/** What page n says about its turn, or null while it says nothing (its line closed or closing). */
const turnedText = (page, n) => page.evaluate((i) => {
  const box = document.querySelectorAll('.rotate-card')[i].querySelector('.onepdf-collapse');
  return box.hidden || box.classList.contains('is-collapsed') ? null : box.textContent;
}, n - 1);

async function testRotate(page, url, fx, { touch, wide }) {
  const size = wide ? 'desktop' : 'phone';
  await openTool(page, url, 'rotate');
  eq(await page.textContent('.ui-topbar-title'), S.rotateAction, 'title');
  await pick(page, asFile('Report.pdf', fx.report), { touch });
  await chosen(page, 'Report.pdf');
  eq(await page.inputValue('.onepdf-name .ui-field-input'), 'Report_rotated', 'default name');
  eq(await page.textContent('.rotate-all-title'), S.rotateAll, 'all pages');
  eq(await page.textContent('.rotate-all .onepdf-hint'), S.rotateHint, 'hint');
  eq(await page.locator('.rotate-card').count(), 12, 'a card per page');
  ok(await mainButton(page).isDisabled(), 'off until a page is turned');
  ok(await page.isDisabled('.rotate-reset'), 'Reset off');
  await page.waitForSelector('.rotate-card .rotate-thumb.has-picture canvas');
  // The turn icons aren't mirrored for right-to-left text (TurnIcon.kt).
  eq(await page.locator('.rotate-card .icon-mirrored').count(), 0, 'turn icons drawn the same either way');

  const btn = (n, way) => `.rotate-card:nth-of-type(${n}) .ui-icon-btn[aria-label="Rotate page ${n} ${way}"]`;
  await press(page, btn(1, 'right'), { touch });
  eq(await turnOf(page, 1), 90, 'page 1 turned right');
  eq(await turnedText(page, 1), S.turnedRight, 'says turned right');
  ok(!(await mainButton(page).isDisabled()), 'Rotate on');
  ok(!(await page.isDisabled('.rotate-reset')), 'Reset on');
  // Two quarters left: upside down, the short way round.
  await press(page, btn(2, 'left'), { touch });
  await press(page, btn(2, 'left'), { touch });
  eq(await turnOf(page, 2), -180, 'page 2 went left twice');
  eq(await turnedText(page, 2), S.upsideDown, 'upside down');
  // Animated: the picture is mid-turn just after a press. Pressed in the page, so the frames are
  // watched from the press on, however busy the machine is between the test and the browser.
  await page.locator(btn(3, 'right')).scrollIntoViewIfNeeded();
  // The angles the picture shows over the next frames: some between the two.
  const angles = await page.evaluate(async (selector) => {
    const turn = document.querySelectorAll('.rotate-card')[2].querySelector('.rotate-turn');
    document.querySelector(selector).click();
    const seen = [];
    for (let i = 0; i < 30; i++) {
      const x = new DOMMatrix(getComputedStyle(turn).transform);
      seen.push(Math.round(Math.atan2(x.b, x.a) * 180 / Math.PI));
      await new Promise((r) => requestAnimationFrame(r));
    }
    return seen;
  }, btn(3, 'right'));
  ok(angles.some((a) => a > 5 && a < 85) && angles.at(-1) === 90, `turning, not jumping (${angles.join(' ')})`);
  await page.waitForTimeout(400);
  await themes(page, `rotate-turned-${size}`);

  // All pages at once.
  await press(page, '.rotate-all .ui-icon-btn[aria-label="Rotate all pages right"]', { touch });
  eq(await turnedText(page, 1), S.upsideDown, 'page 1 now upside down');
  eq(await turnedText(page, 2), S.turnedLeft, 'page 2 now turned left');
  eq(await turnedText(page, 3), S.upsideDown, 'page 3 now upside down');
  eq(await turnedText(page, 4), S.turnedRight, 'page 4 now turned right');
  eq(await turnOf(page, 2), -90, 'page 2 the short way');
  await press(page, '.rotate-all .ui-icon-btn[aria-label="Rotate all pages left"]', { touch });
  // Reset turns them all back, and Rotate is off again.
  await press(page, '.rotate-reset', { touch });
  await page.waitForTimeout(300);
  ok(await mainButton(page).isDisabled(), 'off after Reset');
  eq(await page.$$eval('.rotate-card .onepdf-collapse', (els) => els.every((e) => e.hidden)), true, 'no page says it is turned');

  // Turned pages are work: leaving or removing the PDF asks first.
  await press(page, btn(1, 'right'), { touch });
  await press(page, '.onepdf .ui-topbar-nav', { touch });
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  eq(await page.textContent('dialog[open] .ui-dialog-title'), S.discardTitle, 'asked on leaving');
  await press(page, 'dialog[open] .ui-btn:has-text("Keep")', { touch });
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  eq(await turnOf(page, 1), 90, 'kept');
  await press(page, '.onepdf-card .ui-icon-btn[aria-label="Remove Report.pdf"]', { touch });
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  await press(page, 'dialog[open] .ui-btn:has-text("Keep")', { touch });
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  ok(await page.isVisible('.onepdf-card'), 'still there after Keep');

  // Another PDF in its place: asked first too, then the new one's pages.
  await press(page, '.onepdf-card .ui-btn:has-text("Choose another PDF")', { touch });
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), press(page, 'dialog[open] .ui-btn:has-text("Discard")', { touch })]);
  await chooser.setFiles(asFile('Other.pdf', fx.other));
  await chosen(page, 'Other.pdf');
  eq(await page.locator('.rotate-card').count(), 3, "the other PDF's pages");
  eq(await page.inputValue('.onepdf-name .ui-field-input'), 'Other_rotated', 'its own name');
  ok(await mainButton(page).isDisabled(), 'nothing turned yet');
  await press(page, '.onepdf-card .ui-icon-btn[aria-label="Remove Other.pdf"]', { touch });
  await page.waitForSelector('.onepdf .ui-empty');

  // Turn pages 1 right, 2 upside down, 4 left; the PDF says so and its content is as it was.
  await pick(page, asFile('Report.pdf', fx.report), { touch });
  await chosen(page, 'Report.pdf');
  await press(page, btn(1, 'right'), { touch });
  await press(page, btn(2, 'right'), { touch });
  await press(page, btn(2, 'right'), { touch });
  await press(page, btn(4, 'left'), { touch });
  const files = await runTool(page, { touch });
  eq(files.map((f) => f.name), ['Report_rotated.pdf'], 'named');
  eq(await rotationsOf(files[0].bytes), [90, 180, 0, 270, 0, 0, 0, 0, 0, 0, 0, 0], 'turns saved');
  eq((await pageTexts(page, files[0].bytes)).slice(0, 4), ['PAGE 1', 'PAGE 2', 'PAGE 3', 'PAGE 4'], 'text as it was');
  const shown = await shownPages(page, files[0].bytes);
  eq(shown.slice(0, 5).map((p) => p.landscape), [true, false, true, true, false], 'pages shown turned');
  await shot(page, `rotate-result-${size}`);
  // On the phone, Back (the browser's) returns to editing, as Android's Back does in the app.
  await backToEditing(page, { touch, browserBack: touch });
  eq(await page.evaluate(() => location.hash), '#/tool/rotate', 'still in Rotate PDF');
  eq(await turnOf(page, 4), -90, 'turns kept after Back to editing');
}

// ---------------------------------------------------------------------------------------------
// Desktop extras: keyboard, files dropped and pasted, a long PDF, cancelling

async function testDesktopExtras(page, url, fx) {
  // Delete pages from the keyboard: arrows move between pages, Space marks one.
  await openTool(page, url, 'delete-pages');
  await pick(page, asFile('Report.pdf', fx.report));
  await chosen(page, 'Report.pdf');
  await page.focus('.delete-pages-grid .ui-page-tile:nth-of-type(1) .ui-page');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.delete-pages-grid .ui-pagegrid')).gridTemplateColumns.split(' ').length);
  eq(await page.inputValue('.ui-field:not(.onepdf-name) .ui-field-input'), `2,${2 + cols}`, 'marked from the keyboard');
  ok(cols >= 4, `more columns on a wide screen (${cols})`);

  // A PDF dropped on the screen takes the place of the one there.
  const drop = (name, bytes, target = '.onepdf') => dropFile(page, name, bytes, target);
  await drop('Other.pdf', fx.other);
  await chosen(page, 'Other.pdf');
  eq(await page.locator('.delete-pages-grid .ui-page').count(), 3, 'the dropped PDF');

  // Rotate: a drop over turned pages asks first.
  await openTool(page, url, 'rotate');
  await drop('Report.pdf', fx.report, '.ui-empty');
  await chosen(page, 'Report.pdf');
  await page.focus('.rotate-card:nth-of-type(1) .ui-icon-btn[aria-label="Rotate page 1 right"]');
  await page.keyboard.press('Enter');
  eq(await turnOf(page, 1), 90, 'turned from the keyboard');
  await drop('Other.pdf', fx.other);
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  await page.click('dialog[open] .ui-btn:has-text("Keep")');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  eq(await page.textContent('.onepdf-card .ui-file-name'), 'Report.pdf', 'kept on Keep');
  // Pasted, with Discard.
  await page.evaluate(async (b64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Pasted.pdf', { type: 'application/pdf' }));
    document.body.focus();
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, Buffer.from(fx.other).toString('base64'));
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  await page.click('dialog[open] .ui-btn:has-text("Discard")');
  await chosen(page, 'Pasted.pdf');
  ok(await mainButton(page).isDisabled(), 'nothing turned in the pasted PDF');

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

  // Tool opened with a PDF handed over (Choose a tool, Home's drop).
  await page.evaluate(async (b64) => {
    const { navigate } = await import(new URL('js/core/router.js', location.href).href);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await navigate('/tool/rotate', { files: [{ name: 'Handed.pdf', type: 'application/pdf', size: bytes.length, lastModified: 0, bytes }] });
  }, Buffer.from(fx.other).toString('base64'));
  await chosen(page, 'Handed.pdf');
  eq(await page.locator('.rotate-card').count(), 3, 'the PDF handed over is open');

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
  await openTool(page, url, 'delete-pages');
  await page.focus('.onepdf .ui-empty');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
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

  // Rotate: Reset pages turns itself off; the focus goes to "Rotate all pages right".
  await openTool(page, url, 'rotate');
  await pick(page, asFile('Report.pdf', fx.report));
  await chosen(page, 'Report.pdf');
  await page.focus('.rotate-card:nth-of-type(2) .ui-icon-btn[aria-label="Rotate page 2 left"]');
  await page.keyboard.press('Enter');
  await page.focus('.rotate-reset');
  await page.keyboard.press('Enter');
  eq(await page.evaluate(() => [...document.querySelectorAll('.rotate-card')].map((c) => c.card.angle % 360)).then((a) => a.every((x) => x === 0)), true, 'Reset pages turns them back');
  eq(await active(), 'Rotate all pages right', 'Reset pages: the focus on Rotate all pages right');

  // On a wide screen the main button ends where the column above it ends.
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
// Reduced motion, narrow screens

async function testMotionAndWidths(page, url, fx) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openTool(page, url, 'rotate');
  await pick(page, asFile('Report.pdf', fx.report), { touch: true });
  await chosen(page, 'Report.pdf');
  eq(await page.$eval('.rotate-turn', (e) => getComputedStyle(e).transitionDuration), '0s', 'no turning animation with reduced motion');
  await page.tap('.rotate-card:nth-of-type(1) .ui-icon-btn[aria-label="Rotate page 1 right"]');
  const angle = await page.$eval('.rotate-turn', (e) => { const x = new DOMMatrix(getComputedStyle(e).transform); return Math.round(Math.atan2(x.b, x.a) * 180 / Math.PI); });
  eq(angle, 90, 'turned at once');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  for (const tool of ['split', 'delete-pages', 'rotate']) {
    await page.setViewportSize({ width: 320, height: 640 });
    await openTool(page, url, tool);
    await checkNoSideways(page, `${tool} empty at 320 px`);
    await pick(page, asFile('A very long file name for a report that goes on and on.pdf', fx.report), { touch: true });
    await chosen(page, 'A very long file name for a report that goes on and on.pdf');
    await page.waitForTimeout(300);
    await checkNoSideways(page, `${tool} at 320 px`);
    const small = await page.evaluate(() => [...document.querySelectorAll('.onepdf .ui-icon-btn')].filter((b) => b.getBoundingClientRect().height < 48 && b.getClientRects().length).length);
    eq(small, 0, `${tool}: icon buttons 48 px to tap`);
    await shot(page, `${tool}-320`, { full: true });
  }
}

// ---------------------------------------------------------------------------------------------
// The same flows, shorter, in Firefox and WebKit

async function testOtherBrowser(page, url, fx, browser) {
  const touch = browser !== 'firefox';
  // Split PDF and Rotate PDF get their PDF through the file input, Delete pages by a drop.
  await openTool(page, url, 'split');
  await pick(page, asFile('Report.pdf', fx.report), { touch });
  await chosen(page, 'Report.pdf');
  for (const n of [4, 2]) await press(page, `.split-picker .ui-page-tile:nth-of-type(${n}) .ui-page`, { touch });
  eq(await page.inputValue('.split-field .ui-field-input'), '4,2', `${browser}: pages tapped`);
  let files = await runTool(page, { touch });
  eq(await pageTexts(page, files[0].bytes), ['PAGE 4', 'PAGE 2'], `${browser}: split`);
  await backToEditing(page, { touch });
  await shot(page, `split-${browser}`);

  await openTool(page, url, 'delete-pages');
  await pick(page, asFile('Report.pdf', fx.report), { touch, drop: true });
  await chosen(page, 'Report.pdf');
  await press(page, '.delete-pages-grid .ui-page-tile:nth-of-type(1) .ui-page', { touch });
  eq(await page.textContent('.delete-pages-count'), S.deleteCount(1, 12), `${browser}: marked`);
  files = await runTool(page, { touch });
  eq(await rotationsOf(files[0].bytes).then((r) => r.length), 11, `${browser}: page deleted`);
  // The browser's Back returns to editing.
  await backToEditing(page, { browserBack: true });
  eq(await page.evaluate(() => location.hash), '#/tool/delete-pages', `${browser}: still in Delete pages`);
  eq(await page.textContent('.delete-pages-count'), S.deleteCount(1, 12), `${browser}: marks kept`);

  await openTool(page, url, 'rotate');
  await pick(page, asFile('Report.pdf', fx.report), { touch });
  await chosen(page, 'Report.pdf');
  await press(page, '.rotate-all .ui-icon-btn[aria-label="Rotate all pages left"]', { touch });
  await page.waitForTimeout(300);
  await shot(page, `rotate-${browser}`);
  files = await runTool(page, { touch });
  eq(await rotationsOf(files[0].bytes), new Array(12).fill(270), `${browser}: all turned left`);
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
  await step('delete pages', () => testDeletePages(page, url, fx, { touch: true, wide: false }));
  await step('rotate', () => testRotate(page, url, fx, { touch: true, wide: false }));
  await step('reduced motion and 320 px', () => testMotionAndWidths(page, url, fx));
}, { viewport: PHONE });

console.log('Desktop (1366 px, mouse and keyboard), Chromium');
await withPage(async (page, url) => {
  // Nothing these tools do embeds a font with pdf-lib: fontkit (157 kB gzipped) isn't loaded.
  const fontkit = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/fontkit/')) fontkit.push(r.url()); });
  await step('split', () => testSplit(page, url, fx, { touch: false, wide: true }));
  await step('delete pages', () => testDeletePages(page, url, fx, { touch: false, wide: true }));
  await step('rotate', () => testRotate(page, url, fx, { touch: false, wide: true }));
  await step('keyboard, drop, paste, long PDF, cancel', () => testDesktopExtras(page, url, fx));
  await step('focus, messages after the progress, paste after a result, layout', () => testReviewFixes(page, url, fx));
  eq(fontkit, [], 'no fontkit loaded by Split, Delete pages or Rotate');
}, { viewport: DESKTOP, mobile: false });
}

if (!QUICK) {
  for (const browser of ['firefox', 'webkit']) {
    console.log(`Phone (360 px), ${browser}`);
    await withPage(async (page, url) => {
      await step(`${browser}: split, delete pages, rotate`, () => testOtherBrowser(page, url, fx, browser));
    }, { browser, viewport: PHONE });
  }
}

console.log(`organize-ui-a: ${passed} groups, ${checks} checks passed`);
