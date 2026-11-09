// Merge PDF and Reorganize PDF screens (site/app/js/tools/merge/, site/app/js/tools/reorganize/),
// driven in the real app at phone size (touch) and desktop size (mouse and keyboard): files picked,
// put in order and sorted, page mode's turns, removals and moves, Reorganize's chosen page and its
// bar, pages added from another PDF and blank, drags, Undo and Reset, passwords and damaged files,
// then the PDFs made, saved and read back (page order, text, turns and sizes). Ports the page-list
// cases of the app's PageToolsDeviceTest, ScreensDeviceTest and EditorsMultiClickDeviceTest.
// Screenshots (light and dark, both sizes) go to .tmp/organize-ui-b/screens/.
//
//   node tests/organize-ui-b.test.mjs          Chromium at both sizes, then Firefox and WebKit
//   node tests/organize-ui-b.test.mjs --quick  Chromium only
//   node tests/organize-ui-b.test.mjs --review Chromium only, the reviewers' findings only
import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { withPage, root } from './harness.mjs';
import { PDFDocument, StandardFonts, rgb, degrees } from '../site/app/vendor/pdf-lib/pdf-lib.esm.min.js';
import {
  PageList, pageKey, pagesOf, samePages, BLANK, MAX_UNDO, enginePages, turnedKey,
} from '../site/app/js/tools/merge/page-list.js';

const review = process.argv.includes('--review');
const quick = review || process.argv.includes('--quick');
const shots = join(root, '.tmp', 'organize-ui-b', 'screens');
await mkdir(shots, { recursive: true });
const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 900 };
const A4 = [595.28, 841.89];
const LETTER = [612, 792];
const LANDSCAPE = [842, 595];
// The Android app beside this repository (not there on CI: what needs it is skipped or made here).
const appAssets = join(root, '..', 'pdfer', 'app', 'src', 'androidTest', 'assets');
const stringsXml = join(root, '..', 'pdfer', 'app', 'src', 'main', 'res', 'values', 'strings.xml');

let checks = 0;
let group = '';
function check(condition, message, detail) {
  if (!condition) throw new Error(`[${group}] ${message}${detail !== undefined ? `\n  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  checks++;
}
function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, message, `expected ${e}\n  got      ${a}`);
}
const exists = (p) => access(p).then(() => true, () => false);
const squash = (s) => s.replace(/\s+/g, '');

// ---------------------------------------------------------------------------------------------
// Fixtures

async function makePdf(pages, { password } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const tints = [rgb(0.85, 0.9, 1), rgb(1, 0.88, 0.85), rgb(0.88, 1, 0.88), rgb(1, 0.97, 0.8)];
  pages.forEach((p, i) => {
    const [w, h] = p.size ?? A4;
    const page = doc.addPage([w, h]);
    page.drawRectangle({ x: 30, y: 30, width: w - 60, height: h - 60, color: tints[i % tints.length] });
    page.drawText(p.text, { x: 50, y: h - 110, size: 44, font, color: rgb(0, 0, 0) });
    if (p.rotate) page.setRotation(degrees(p.rotate));
  });
  if (password) await doc.encrypt({ userPassword: password, ownerPassword: password + '-owner' });
  return Buffer.from(await doc.save());
}

const pdf = (name, buffer) => ({ name, mimeType: 'application/pdf', buffer });
const fx = {
  alpha: pdf('alpha.pdf', await makePdf([{ text: 'ALPHA ONE' }, { text: 'ALPHA TWO' }, { text: 'ALPHA THREE' }])),
  beta: pdf('Beta.pdf', await makePdf([{ text: 'BETA ONE', size: LANDSCAPE }, { text: 'BETA TWO', size: LANDSCAPE }])),
  gamma: pdf('gamma.pdf', await makePdf([{ text: 'GAMMA ONE', size: LETTER }])),
  turned: pdf('turned.pdf', await makePdf([{ text: 'TURNED ONE', rotate: 90 }, { text: 'TURNED TWO' }])),
  many: pdf('many.pdf', await makePdf(Array.from({ length: 24 }, (_, i) => ({ text: `MANY ${i + 1}` })))),
  locked: pdf('statement.pdf', (await exists(join(appAssets, 'protected.pdf')))
    ? await readFile(join(appAssets, 'protected.pdf'))
    : await makePdf([{ text: 'ALPHA ONE' }, { text: 'ALPHA TWO' }, { text: 'ALPHA THREE' }], { password: 'test123' })),
  damaged: pdf('broken.pdf', Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\nnot a PDF at all\n%%EOF')),
};

// ---------------------------------------------------------------------------------------------
// Strings: the app's keys and English, nothing of common.js or kit.js redefined.

async function stringTests() {
  group = 'strings';
  // Not on CI, which has only this repository: the namespace checks still run.
  const xml = await readFile(stringsXml, 'utf8').catch(() => null);
  if (xml == null) console.log('strings.xml not found: app-string comparison skipped');
  const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/%(\d)\$[sd]/g, '{$1}').replace(/%[sd]/g, '{1}');
  const app = new Map();
  for (const m of xml?.matchAll(/<string name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g) ?? []) app.set(m[1], unescape(m[2]));
  const common = (await import('../site/app/locales/en/common.js')).default;
  const kit = (await import('../site/app/locales/en/kit.js')).default;
  for (const ns of ['merge', 'reorganize']) {
    const strings = (await import(`../site/app/locales/en/${ns}.js`)).default;
    for (const [key, text] of Object.entries(strings)) {
      check(!(key in common) && !(key in kit), `${ns}.js doesn't redefine ${key} of common.js or kit.js`);
      if (key.startsWith('web_') || xml == null) continue;
      check(app.has(key), `${ns}.js: ${key} is a strings.xml key`);
      equal(text, app.get(key), `${ns}.js: ${key} is the app's English`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The page list (PdfToolsViewModel's page logic), without a browser.

function pageListTests() {
  group = 'page list';
  const alpha = { id: 'a', pageCount: 3 };
  const beta = { id: 'b', pageCount: 2 };
  const a = pagesOf([alpha]);
  const b = pagesOf([beta]);
  equal(pagesOf([alpha, beta]).map(pageKey), ['a:0', 'a:1', 'a:2', 'b:0', 'b:1'], 'every page of the PDFs, in order');

  // mergePagesFollowTheFilesOrder
  let list = new PageList(pagesOf([alpha, beta]));
  check(list.followOrder(['b', 'a']), 'pages follow the files');
  equal(list.pages.map(pageKey), [...b, ...a].map(pageKey), 'B first');
  list.rotate('a:0', 90);
  const turned = [{ ...a[0], rotation: 90 }, ...a.slice(1)];
  list.followOrder(['a', 'b']);
  check(samePages(list.pages, [...turned, ...b]), 'A to Z keeps the turn', list.pages);
  list.followOrder(['b', 'a']);
  check(samePages(list.pages, [...b, ...turned]), 'Z to A keeps the turn');
  list.moveBy('a:0', -1);
  const mixed = list.pages;
  equal(mixed.map(pageKey), ['b:0', 'a:0', 'b:1', 'a:1', 'a:2'], 'a page moved among the other PDF\'s');
  check(!list.followOrder(['a', 'b']) && samePages(list.pages, mixed), 'once mixed, the order stays');

  // mergePageModeStillWorksAndLeavesNoWorkingFiles: buttons, a drag, a turn and a page left out.
  list = new PageList(pagesOf([alpha, beta]));
  list.moveBy('b:0', -3);
  list.remove('a:1');
  list.rotate('a:2', 90);
  list.beginDrag();
  list.move('b:1', 'a:0');
  list.endDrag();
  equal(list.pages.map((p) => `${pageKey(p)}@${p.rotation}`), ['b:0@0', 'b:1@0', 'a:0@0', 'a:2@90'], 'buttons, a drag, a turn and a removal');
  equal(enginePages(list.pages), [{ input: 'b', page: 0, rotation: 0 }, { input: 'b', page: 1, rotation: 0 }, { input: 'a', page: 0, rotation: 0 }, { input: 'a', page: 2, rotation: 90 }], 'the engine\'s list');

  // reorganizeAddsPdfPagesWhereChosenAndUndoes
  list = new PageList(a);
  check(!list.canUndo, 'nothing to undo yet');
  list.insert(b, 'a:0');
  equal(list.pages.map(pageKey), ['a:0', 'b:0', 'b:1', 'a:1', 'a:2'], 'pages of another PDF go after the chosen page');
  check(list.canUndo, 'adding can be undone');
  list.undo(new Set(['a', 'b']));
  check(samePages(list.pages, a) && !list.canUndo, 'undone');
  list.insert(b, 'gone:9');
  equal(list.pages.map(pageKey), ['a:0', 'a:1', 'a:2', 'b:0', 'b:1'], 'after a page that has gone: at the end');
  list.undo();

  // A blank page takes the size its neighbour shows, sideways when that page is turned a quarter.
  list = new PageList(a);
  const blank = list.insertBlank(a[0], 595, 842);
  equal([list.pages[1].input, list.pages[1].width, list.pages[1].height], [BLANK, 595, 842], 'a blank page after the chosen page');
  list.rotate('a:2', 90);
  list.insertBlank(list.pages[3], 595, 842);
  equal([list.pages[4].width, list.pages[4].height, list.pages[4].page], [842, 595, 1], 'after a page turned a quarter: sideways, numbered apart');
  list.rotate(pageKey(blank), 270);
  list.insertBlank(list.find(pageKey(blank)), blank.width, blank.height);
  equal([list.pages[2].width, list.pages[2].height], [842, 595], 'after a turned blank page: turned too');
  check(new PageList([]).insertBlank(a[0], 1, 1) === null, 'no page, no blank page');

  // Undo leaves out the pages of PDFs gone, keeps blank pages.
  list = new PageList([...a, { input: BLANK, page: 0, rotation: 0, width: 10, height: 20 }]);
  list.insert(b, null);
  list.remove('a:0');
  list.undo(new Set(['a']));
  equal(list.pages.map(pageKey), ['a:0', 'a:1', 'a:2', 'blank:0'], 'undo forgets the pages of a PDF gone');

  // reorganizeDoubleTapOnResetLeavesOneUndoStep
  list = new PageList(a);
  list.remove('a:0');
  check(list.resetTo(a), 'reset');
  check(!list.resetTo(a), 'tapped again: nothing');
  list.undo();
  equal(list.pages.map(pageKey), ['a:1', 'a:2'], 'one undo brings the change back');

  // reorganizeQuickTurnsEachTurnThePageAndUndoTakesBackOne
  list = new PageList(a);
  list.rotate('a:0', 90);
  list.rotate('a:0', 90);
  equal(list.pages[0].rotation, 180, 'two quick turns');
  list.undo();
  equal(list.pages[0].rotation, 90, 'undo takes back one');
  list.rotate('a:0', -90);
  list.rotate('a:0', -90);
  equal(list.pages[0].rotation, 270, 'turns left wrap round');

  // A drag that moves nothing leaves nothing to undo; one that moves is one step.
  list = new PageList(a);
  list.beginDrag();
  check(list.canUndo, 'Undo is on during a drag');
  list.endDrag();
  check(!list.canUndo, 'a drag that moved nothing');
  list.beginDrag();
  list.moveAt(0, 1);
  list.moveAt(1, 2);
  list.endDrag();
  list.undo();
  check(samePages(list.pages, a) && !list.canUndo, 'a drag is one change');
  list.beginDrag();
  list.moveAt(0, 2);
  list.moveAt(2, 0);
  list.endDrag();
  check(!list.canUndo, 'a drag back where it started leaves nothing to undo');

  // At most MAX_UNDO steps.
  list = new PageList(a);
  for (let i = 0; i < MAX_UNDO + 10; i++) list.rotate('a:1', 90);
  let undone = 0;
  while (list.undo()) undone++;
  equal(undone, MAX_UNDO, 'Undo goes back 50 changes');
  check(!list.moveBy('a:0', -1) && !list.moveBy('a:2', 1) && !list.rotate('x:0', 90) && !list.remove('x:0'), 'moves past the ends and missing pages do nothing');
  list.dropInput('a');
  equal(list.length, 0, 'a PDF removed takes its pages');
  equal([turnedKey(90), turnedKey(-90), turnedKey(180), turnedKey(360)], ['rotated_right', 'rotated_left', 'rotated_upside_down', null], 'turn words');
}

// ---------------------------------------------------------------------------------------------
// Browser helpers

async function openTool(page, url, id) {
  // A fresh page each time: leaving with work unsaved asks first ("Leave site?"), accepted here.
  if (!page.__dialogs) {
    page.__dialogs = true;
    page.on('dialog', (d) => d.accept().catch(() => {}));
  }
  await page.goto('about:blank');
  await page.goto(url + 'app/#/tool/' + id);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  await page.waitForSelector(`.screen[data-tool="${id}"]:not([aria-busy])`, { timeout: 20000 });
  await page.evaluate(async (base) => {
    const router = await import(base + 'app/js/core/router.js');
    window.__handle = () => router.currentHandle();
  }, url);
}

const state = (page) => page.evaluate(() => window.__handle()?.state);
const unsaved = (page) => page.evaluate(() => window.__handle()?.hasUnsavedWork());
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });
const label = (page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent);

/**
 * Picks `files` through the file input `selector` opens, in every browser (the kit takes the files
 * of Playwright's Firefox, which sends the input's cancel event just before its change event).
 */
async function pick(page, selector, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await chooser.setFiles(files);
}

/** Drops `files` on `selector` as a file manager would (the drop zone of the empty state). */
async function dropFiles(page, selector, files) {
  const list = files.map((f) => ({ name: f.name, type: f.mimeType, b64: f.buffer.toString('base64') }));
  await page.evaluate(({ selector, list }) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const target = document.querySelector(selector);
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { selector, list });
}

async function snack(page, text) {
  await waitFor(page, (s) => [...document.querySelectorAll('.ui-snackbar-text')].some((n) => n.textContent === s), text);
  checks++;
}

/** Saves the result to Downloads and reads it: { name, bytes }. */
async function download(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.ui-result button:has-text("Save to Downloads")')]);
  return { name: dl.suggestedFilename(), bytes: new Uint8Array(await readFile(await dl.path())) };
}

/** Each page of `bytes` as pdf.js shows it: its text, turn and size as shown. */
async function readBack(page, url, bytes) {
  const b64 = Buffer.from(bytes).toString('base64');
  const shown = await page.evaluate(async ({ base, b64 }) => {
    const { openPdfJs } = await import(base + 'app/js/lib/pdfjs.js');
    const doc = await openPdfJs(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const text = (await p.getTextContent()).items.map((x) => x.str).join(' ');
      const vp = p.getViewport({ scale: 1 });
      out.push({ text, rotate: p.rotate, width: Math.round(vp.width), height: Math.round(vp.height) });
    }
    await doc.loadingTask.destroy();
    return out;
  }, { base: url, b64 });
  // And with pdf-lib: no password, the page boxes.
  const doc = await PDFDocument.load(bytes);
  check(!doc.isEncrypted, 'the new PDF has no password');
  return shown;
}

/**
 * The text of each page shown, as the words expected: a page says its word (it may say more, as the
 * app's protected.pdf does), a blank page ('') says nothing.
 */
function says(shown, words) {
  return shown.map((p, i) => {
    const text = squash(p.text);
    const word = words[i];
    if (word === '') return text === '' ? '' : text;
    return text.startsWith(word) && !words.some((w) => w && w !== word && w.startsWith(word) && text.startsWith(w)) ? word : text;
  });
}

/** What a page of the fixtures says. */
const SAYS = {
  'alpha.pdf': ['ALPHAONE', 'ALPHATWO', 'ALPHATHREE'],
  'Beta.pdf': ['BETAONE', 'BETATWO'],
  'gamma.pdf': ['GAMMAONE'],
  'turned.pdf': ['TURNEDONE', 'TURNEDTWO'],
  'statement.pdf': ['ALPHAONE', 'ALPHATWO', 'ALPHATHREE'],
};

/** Touches at (x, y) through CDP (Chromium): a long press and a drag to (x2, y2). */
async function touchDrag(page, from, to, { hold = 650, steps = 12 } = {}) {
  const client = await page.context().newCDPSession(page);
  const touch = (type, x, y) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', from.x, from.y);
  await page.waitForTimeout(hold);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(150);
  await touch('touchEnd');
  await page.waitForTimeout(300);
  await client.detach();
}

async function mouseDrag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 3, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/**
 * The middles of elements `ns` of `selector`, the first scrolled to the middle of the screen (clear
 * of the bars), once rows moved last have glided into place.
 */
async function centers(page, selector, ns) {
  await page.waitForTimeout(400);
  return page.evaluate(({ selector, ns }) => {
    const all = document.querySelectorAll(selector);
    all[ns[0]].scrollIntoView({ block: 'center' });
    return ns.map((n) => {
      const r = all[n].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  }, { selector, ns });
}

async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, name + '.png') });
}

/** No sideways scrolling of the page. */
async function noSideScroll(page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(r.sw <= r.cw + 1, 'nothing scrolls sideways', r);
}

// ---------------------------------------------------------------------------------------------
// Merge PDF

const fileNames = (page) => page.$$eval('.merge-files .merge-file-name', (n) => n.map((x) => x.textContent));
const pageLines = (page) => page.$$eval('.merge-pages .merge-page-text', (n) => n.map((x) => x.textContent));

async function mergeFiles(page, url, { wide }) {
  group = `merge files ${wide ? 'desktop' : 'phone'}`;
  await openTool(page, url, 'merge');
  check(await page.isDisabled('.ui-bottombar button'), 'Merge is off without PDFs');
  await shot(page, `merge-empty-${wide ? 'desktop' : 'phone'}`);
  await pick(page, '.merge-page .ui-empty', [fx.gamma, fx.alpha, fx.beta]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 3);
  equal(await fileNames(page), ['gamma.pdf', 'alpha.pdf', 'Beta.pdf'], 'the PDFs in the order picked');
  equal(await page.$$eval('.merge-file-number', (n) => n.map((x) => x.textContent)), ['1.', '2.', '3.'], 'numbered');
  equal(await page.$$eval('.merge-file-detail', (n) => n.map((x) => x.textContent)), ['1 page', '3 pages', '2 pages'], 'page counts');
  check(await page.isDisabled('[aria-label="Move gamma.pdf earlier"]') && await page.isDisabled('[aria-label="Move Beta.pdf later"]'), 'the first can\'t move earlier, the last later');
  check(await page.isEnabled('.ui-bottombar button'), 'Merge is on with two or more');
  check(!(await unsaved(page)), 'nothing to lose yet: the pages are every page in order');
  equal(await page.getAttribute('.merge-mode', 'aria-checked'), 'false', 'file mode first');
  equal(await page.textContent('.merge-hint'), 'Move whole PDFs into the order you want.', 'file mode hint');
  equal(await page.inputValue('.merge-page .ui-field-input'), 'Merged_PDF', 'the default name');
  await shot(page, `merge-files-${wide ? 'desktop' : 'phone'}`);
  await noSideScroll(page);

  // The buttons, which name their file; the focus stays with the file moved.
  await page.click('[aria-label="Move alpha.pdf earlier"]');
  equal(await fileNames(page), ['alpha.pdf', 'gamma.pdf', 'Beta.pdf'], 'moved earlier');
  equal(await label(page), 'Move alpha.pdf later', 'first now, its earlier button is off and the focus goes to later');
  equal((await state(page)).pages.map(pageKey).slice(0, 4), ['f2:0', 'f2:1', 'f2:2', 'f1:0'], 'the pages follow the files');
  check(!(await unsaved(page)), 'moving files loses nothing');

  // Sorting by name, ignoring case.
  await page.click('button:has-text("Sort Z to A")');
  equal(await fileNames(page), ['gamma.pdf', 'Beta.pdf', 'alpha.pdf'], 'Z to A');
  await page.click('button:has-text("Sort A to Z")');
  equal(await fileNames(page), ['alpha.pdf', 'Beta.pdf', 'gamma.pdf'], 'A to Z');

  // Dragged: a long press on touch screens, the mouse on computers.
  const [from, to] = await centers(page, '.merge-files .merge-file-text', [2, 0]);
  if (wide) await mouseDrag(page, from, to);
  else await touchDrag(page, from, { x: to.x, y: to.y - 10 });
  equal(await fileNames(page), ['gamma.pdf', 'alpha.pdf', 'Beta.pdf'], 'gamma dragged first');

  // Keyboard: Ctrl and an arrow key moves the file whose button has the focus.
  await page.focus('[aria-label="Remove Beta.pdf"]');
  await page.keyboard.press('Control+ArrowUp');
  equal(await fileNames(page), ['gamma.pdf', 'Beta.pdf', 'alpha.pdf'], 'Ctrl+Up moves it earlier');
  equal(await label(page), 'Remove Beta.pdf', 'the focus stays');
  await waitFor(page, () => document.getElementById('announcer')?.textContent === 'Moved to place 2 of 3');
  checks++;

  // Merged as whole files.
  await page.click('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  equal(await page.textContent('.ui-result-heading'), 'Your PDF is ready', 'the result');
  await shot(page, `merge-result-${wide ? 'desktop' : 'phone'}`);
  const out = await download(page);
  equal(out.name, 'Merged_PDF.pdf', 'named as typed');
  const shown = await readBack(page, url, out.bytes);
  equal(says(shown, ['GAMMAONE', 'BETAONE', 'BETATWO', 'ALPHAONE', 'ALPHATWO', 'ALPHATHREE']), ['GAMMAONE', 'BETAONE', 'BETATWO', 'ALPHAONE', 'ALPHATWO', 'ALPHATHREE'], 'merged in the files\' order');
  equal(shown.map((p) => [p.width, p.height]), [[612, 792], [842, 595], [842, 595], [595, 842], [595, 842], [595, 842]], 'each page keeps its size');

  // The browser's Back goes back to the tool as it was.
  await page.goBack();
  await page.waitForSelector('.merge-view:not([hidden])');
  equal(await fileNames(page), ['gamma.pdf', 'Beta.pdf', 'alpha.pdf'], 'back to editing, the files as they were');
  check(await page.$('.ui-result') === null, 'the result has gone');
  // Forward to the result left: it has gone, so its history step goes back too.
  await page.goForward();
  await waitFor(page, () => (history.state?.step ?? null) === null, null, 5000);
  check(await page.$('.ui-result') === null && await page.isVisible('.merge-view'), 'Forward: the tool as it was');
  equal(await page.evaluate(() => location.hash), '#/tool/merge', 'still in Merge PDF');
}

async function mergePages(page, url, { wide }) {
  group = `merge pages ${wide ? 'desktop' : 'phone'}`;
  // Page mode, with the files of mergeFiles: gamma, Beta, alpha.
  await page.click('.merge-mode');
  equal(await page.getAttribute('.merge-mode', 'aria-checked'), 'true', 'page mode on');
  equal(await page.getAttribute('.merge-mode', 'aria-label'), 'Arrange individual pages', 'the switch says what it turns on');
  equal(await page.textContent('.merge-hint'), 'Arrange, rotate, or remove individual pages.', 'page mode hint');
  check(await page.isHidden('.merge-files-section'), 'the file list goes');
  await waitFor(page, () => document.querySelectorAll('.merge-pages .merge-page-row').length === 6);
  equal(await pageLines(page), ['1. gamma.pdf, page 1', '2. Beta.pdf, page 1', '3. Beta.pdf, page 2', '4. alpha.pdf, page 1', '5. alpha.pdf, page 2', '6. alpha.pdf, page 3'], 'every page, in the files\' order');
  await waitFor(page, () => document.querySelectorAll('.merge-pages .merge-thumb canvas').length >= 4);
  check(true, 'the pages are drawn');
  if (wide) {
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.merge-pages')).gridTemplateColumns.split(' ').length);
    equal(cols, 2, 'two columns on a wide screen');
  }

  // Turned twice, then one removed.
  await page.click('[aria-label="Rotate page 2 right"]');
  await page.click('[aria-label="Rotate page 2 right"]');
  equal((await state(page)).pages[1].rotation, 180, 'two quick turns');
  await waitFor(page, () => document.querySelectorAll('.merge-pages .merge-page-row')[1].textContent.includes('Upside down'));
  check(await unsaved(page), 'turned pages are work to lose');
  const turn = await page.$eval('.merge-pages .merge-page-row:nth-of-type(2) .merge-thumb-turn', (n) => n.style.transform);
  check(/rotate\(180deg\)/.test(turn), 'the picture is shown turned', turn);
  await page.click('[aria-label="Remove page 4"]');
  equal(await pageLines(page), ['1. gamma.pdf, page 1', '2. Beta.pdf, page 1', '3. Beta.pdf, page 2', '4. alpha.pdf, page 2', '5. alpha.pdf, page 3'], 'page 4 removed');
  equal(await label(page), 'Remove page 4', 'the focus goes to the page in its place');

  // Keyboard: the row focused moves with Ctrl and the arrow keys; arrows alone move the focus.
  await page.focus('.merge-pages .merge-page-row:nth-of-type(5)');
  await page.keyboard.press('Control+ArrowUp');
  if (wide) {
    // Two columns: up is a row up; right and left are one place.
    equal((await pageLines(page))[2], '3. alpha.pdf, page 3', 'Ctrl+Up: a row up');
    await page.keyboard.press('Control+ArrowRight');
    equal((await pageLines(page))[3], '4. alpha.pdf, page 3', 'Ctrl+Right: one place later');
    await page.keyboard.press('Control+ArrowLeft');
  } else {
    await page.keyboard.press('Control+ArrowUp');
  }
  equal((await pageLines(page))[2], '3. alpha.pdf, page 3', 'moved to place 3');
  await page.keyboard.press(wide ? 'ArrowLeft' : 'ArrowUp');
  equal(await page.evaluate(() => document.activeElement.querySelector('.merge-page-text')?.textContent), '2. Beta.pdf, page 1', 'arrow keys move the focus');
  // Its own move buttons show on focus, and name its place.
  await page.keyboard.press('Tab');
  equal(await label(page), 'Move page 2 earlier', 'the move buttons come next');
  await page.keyboard.press('Enter');
  equal((await pageLines(page))[0], '1. Beta.pdf, page 1', 'moved by its button');
  equal(await label(page), 'Move page 1 later', 'first now: the focus goes to its later button');

  // Dragged.
  const lines = await pageLines(page);
  const [from, to] = await centers(page, '.merge-pages .merge-page-text', [0, 1]);
  if (wide) await mouseDrag(page, { x: from.x, y: from.y }, { x: to.x + 4, y: to.y });
  else await touchDrag(page, from, { x: to.x, y: to.y + 6 });
  const dragged = await pageLines(page);
  equal(dragged.map((l) => l.slice(3)), [lines[1], lines[0], ...lines.slice(2)].map((l) => l.slice(3)), 'dragged one place later');
  await shot(page, `merge-pages-${wide ? 'desktop' : 'phone'}`);
  await noSideScroll(page);

  // Back asks before the changes are lost; Keep stays.
  await page.click('.ui-topbar [aria-label="Back"]');
  await page.waitForSelector('dialog[open] >> text=Discard your changes?');
  await page.click('dialog[open] button:has-text("Keep")');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  check(await page.$('.screen[data-tool="merge"]') !== null, 'Keep stays');

  // Merged in page mode, named as typed.
  const expected = (await state(page)).pages;
  const names = Object.fromEntries((await state(page)).inputs.map((i) => [i.id, i.name]));
  await page.fill('.merge-page .ui-field-input', 'Ordered pages');
  await page.click('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  const out = await download(page);
  equal(out.name, 'Ordered pages.pdf', 'named as typed');
  const shown = await readBack(page, url, out.bytes);
  const words = expected.map((p) => SAYS[names[p.input]][p.page]);
  equal(says(shown, words), words, 'the pages in the order arranged, the one removed gone');
  equal(shown.map((p) => p.rotate), expected.map((p) => p.rotation), 'each page turned as shown');
  check(!shown.some((p) => squash(p.text) === 'ALPHAONE'), 'the page removed isn\'t in the PDF');

  // Back to editing, then Reset pages.
  await page.click('.ui-result .ui-topbar [aria-label="Back to editing"]');
  await page.waitForSelector('.merge-view:not([hidden])');
  await page.click('button:has-text("Reset pages")');
  equal((await pageLines(page)).length, 6, 'Reset pages brings every page back');
  check(!(await unsaved(page)), 'and nothing is left to lose');
  // Every page removed: Merge is off and says why.
  for (let i = 6; i >= 1; i--) await page.click(`[aria-label="Remove page ${i}"]`);
  equal(await page.textContent('.merge-pages-section .merge-error'), 'Keep at least one page.', 'a merge keeps a page');
  check(await page.isDisabled('.ui-bottombar button'), 'Merge is off without pages');
  await page.click('button:has-text("Reset pages")');
  await page.click('.merge-mode');
  check(await page.isVisible('.merge-files-section'), 'back to files');
}

async function mergePasswordsAndProblems(page, url) {
  group = 'merge passwords and problems';
  await openTool(page, url, 'merge');
  // A PDF with a password asks for it, again when it is wrong.
  await pick(page, '.merge-page .ui-empty', [fx.locked]);
  await page.waitForSelector('dialog[open] .ui-password');
  check((await page.textContent('dialog[open] .ui-password')).includes('"statement.pdf" is protected.'), 'the dialog names the PDF');
  await page.fill('dialog[open] input[type=password]', 'wrong');
  await page.click('dialog[open] button:has-text("Open PDF")');
  await page.waitForSelector('dialog[open] >> text=That password didn\'t open the PDF.');
  await page.fill('dialog[open] input[type=password]', 'test123');
  await page.click('dialog[open] button:has-text("Open PDF")');
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 1);
  equal(await page.textContent('.merge-content .merge-error'), 'Add at least two PDFs to merge.', 'one PDF: says why Merge is off');
  check(await page.isDisabled('.ui-bottombar button'), 'Merge is off with one PDF');

  // A damaged PDF alone is told about without its name; with others, by name.
  await pick(page, '.merge-add button:has-text("Add PDFs")', [fx.damaged]);
  await snack(page, "Couldn't open that PDF. It may be damaged or unsupported.");
  await pick(page, '.merge-add button:has-text("Add PDFs")', [fx.gamma, fx.damaged]);
  await snack(page, "broken.pdf: Couldn't open that PDF. It may be damaged or unsupported.");
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 2);
  equal(await page.textContent('.merge-content .merge-error'), '', 'two PDFs: nothing to say');

  // A password dialog cancelled leaves that PDF out, quietly.
  await pick(page, '.merge-add button:has-text("Add PDFs")', [fx.locked]);
  await page.waitForSelector('dialog[open] .ui-password');
  await page.click('dialog[open] button:has-text("Cancel")');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  await page.waitForTimeout(200);
  equal((await state(page)).inputs.length, 2, 'cancelled: left out');

  // Merged: the new PDF has no password.
  await page.click('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  check((await page.textContent('.ui-result')).includes('The new PDF has no password.'), 'the result says the password is gone');
  const out = await download(page);
  const shown = await readBack(page, url, out.bytes);
  equal(says(shown, ['ALPHAONE', 'ALPHATWO', 'ALPHATHREE', 'GAMMAONE']), ['ALPHAONE', 'ALPHATWO', 'ALPHATHREE', 'GAMMAONE'], 'the locked PDF\'s pages, then gamma');

  // Start over (saved, so it doesn't ask): an empty tool, the name as it was.
  await page.click('.ui-result button:has-text("Start over")');
  await page.waitForSelector('.merge-page .ui-empty:not([hidden])');
  equal((await state(page)).inputs.length, 0, 'started over');
  check(await page.$('.ui-result') === null, 'the result has gone');

  // Removing a file takes its pages; the last one gone, the tool is empty again.
  await pick(page, '.merge-page .ui-empty', [fx.alpha, fx.gamma]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 2);
  await page.fill('.merge-page .ui-field-input', 'Typed');
  await page.click('[aria-label="Remove alpha.pdf"]');
  equal((await state(page)).pages.map((p) => p.input), ['f4'], 'its pages go with it');
  equal(await label(page), 'Remove gamma.pdf', 'the focus goes to the next Remove');
  await page.click('[aria-label="Remove gamma.pdf"]');
  await page.waitForSelector('.merge-page .ui-empty:not([hidden])');
  await pick(page, '.merge-page .ui-empty', [fx.alpha]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 1);
  equal(await page.inputValue('.merge-page .ui-field-input'), 'Merged_PDF', 'the name starts afresh');

  // Leaving while a password is asked for takes the question away with the tool.
  await pick(page, '.merge-add button:has-text("Add PDFs")', [fx.locked]);
  await page.waitForSelector('dialog[open] .ui-password');
  await page.evaluate(async (base) => (await import(base + 'app/js/core/router.js')).navigate('/'), url);
  await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
  checks++;
}

// ---------------------------------------------------------------------------------------------
// Reorganize PDF

const tiles = (page) => page.$$eval('.reorganize-grid .ui-page', (n) => n.map((b) => b.getAttribute('aria-label')));
const keys = async (page) => (await state(page)).pages.map((p) => `${pageKey(p)}@${p.rotation}`);
const tile = (n) => `.reorganize-grid .ui-page-tile:nth-of-type(${n}) .ui-page`;

async function reorganize(page, url, { wide }) {
  group = `reorganize ${wide ? 'desktop' : 'phone'}`;
  const tap = (sel) => (wide ? page.click(sel) : page.tap(sel));
  await openTool(page, url, 'reorganize');
  await shot(page, `reorganize-empty-${wide ? 'desktop' : 'phone'}`);
  await pick(page, '.reorganize-page .ui-empty', [fx.alpha]);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 3);
  equal(await page.textContent('.reorganize-count'), '3 pages', 'the page count');
  equal(await page.textContent('.reorganize-bar-label'), 'Tap a page to choose it', 'no page chosen');
  check(await page.isDisabled('[aria-label="Undo"]'), 'nothing to undo');
  check(await page.isDisabled('.ui-bottombar button') && await page.isDisabled('button:has-text("Reset pages")'), 'nothing to save until the pages change');
  equal(await page.inputValue('.reorganize-page .ui-field-input'), 'alpha_reorganized', 'the default name');
  check((await page.textContent('.reorganize-card .ui-file-detail')).startsWith('3 pages · '), 'the card says its pages and size');
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-turn canvas').length === 3);
  check(true, 'the pages are drawn');
  await shot(page, `reorganize-open-${wide ? 'desktop' : 'phone'}`);
  const [a0, a1, a2] = ['p1:0', 'p1:1', 'p1:2'];

  // Page 3 chosen by a tap, moved earlier and turned with the bar's buttons, which name it.
  // One page chosen at a time, as the app's selectable tiles: a listbox of options.
  equal(await page.getAttribute('.reorganize-grid', 'role'), 'listbox', 'the pages are a listbox');
  equal(await page.$$eval('.reorganize-grid .ui-page', (n) => n.map((b) => [b.getAttribute('role'), b.getAttribute('aria-selected'), b.hasAttribute('aria-checked')])),
    [['option', 'false', false], ['option', 'false', false], ['option', 'false', false]], 'each page an option, none chosen');
  await tap(tile(1));
  await tap(tile(3));
  equal(await page.$$eval('.reorganize-grid .ui-page', (n) => n.map((b) => b.getAttribute('aria-selected'))), ['false', 'false', 'true'], 'chosen, the page before let go');
  equal(await page.textContent('.reorganize-bar-label'), 'Page 3', 'the bar names it');
  // Tapped again, it is let go, as in the app; tapped once more, chosen.
  await tap(tile(3));
  equal(await page.getAttribute(tile(3), 'aria-selected'), 'false', 'let go');
  equal(await page.textContent('.reorganize-bar-label'), 'Tap a page to choose it', 'no page chosen again');
  await tap(tile(3));
  equal(await page.getAttribute(tile(3), 'aria-selected'), 'true', 'chosen again');
  await page.click('[aria-label="Move page 3 earlier"]');
  equal(await keys(page), [`${a0}@0`, `${a2}@0`, `${a1}@0`], 'page 3 comes second');
  equal(await page.textContent('.reorganize-bar-label'), 'Page 2', 'still chosen, in its new place');
  await page.click('[aria-label="Rotate page 2 right"]');
  equal(await keys(page), [`${a0}@0`, `${a2}@90`, `${a1}@0`], 'turned right');
  check(await page.isEnabled('.ui-bottombar button'), 'now there is something to save');
  equal((await tiles(page))[1], 'Page 2, Turned right', 'a screen reader hears it turned');
  await waitFor(page, () => /rotate\(90deg\)/.test(document.querySelectorAll('.reorganize-grid .ui-page-turn')[1].style.transform));
  checks++;

  // A blank page goes in after the chosen page, sideways as that page is; Undo takes it out.
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 4);
  let s = await state(page);
  equal([s.pages[2].input, Math.round(s.pages[2].width), Math.round(s.pages[2].height)], ['blank', 842, 595], 'a blank page third, lying sideways');
  equal((await tiles(page))[2], 'Page 3, blank', 'named for a screen reader');
  equal(await page.textContent('.reorganize-count'), '4 pages', 'the new count');
  await waitFor(page, () => {
    const c = document.querySelectorAll('.reorganize-grid .ui-page-turn')[2].querySelector('canvas');
    return c && c.width > c.height;
  });
  checks++;
  await page.click('[aria-label="Undo"]');
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 3);
  equal(await keys(page), [`${a0}@0`, `${a2}@90`, `${a1}@0`], 'Undo takes the blank page out');

  // Pages of another PDF go after the chosen page.
  await page.click('.reorganize-actions button:has-text("Add pages")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.ui-menu-item:has-text("Pages from a PDF")')]);
  await chooser.setFiles([fx.beta]);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 5);
  equal(await keys(page), [`${a0}@0`, `${a2}@90`, 'p2:0@0', 'p2:1@0', `${a1}@0`], 'Beta\'s pages after the chosen page');
  equal((await tiles(page))[2], 'Page 3, from Beta.pdf', 'pages from another PDF say so');
  equal(await label(page), 'Add pages', 'the focus is back on Add pages');

  // Dragged: page 5 to the first place, one change for Undo.
  const before = await keys(page);
  const [from, to] = await centers(page, '.reorganize-grid .ui-page', [4, 0]);
  if (wide) await mouseDrag(page, from, to);
  else await touchDrag(page, from, to);
  equal(await keys(page), [`${a1}@0`, ...before.slice(0, 4)], 'page 5 dragged first');
  await page.click('[aria-label="Undo"]');
  equal(await keys(page), before, 'one Undo takes back the whole drag');

  // Keyboard: arrows move the focus, Space chooses, Ctrl and an arrow moves the page.
  await page.focus(tile(1));
  await page.keyboard.press('ArrowRight');
  equal(await label(page), 'Page 2, Turned right', 'arrows move the focus');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+ArrowLeft');
  equal(await keys(page), [before[0], before[2], before[1], before[3], before[4]], 'Ctrl+Left moves it earlier');
  await page.click('[aria-label="Undo"]');
  equal(await keys(page), before, 'a keyboard move is one change too');

  // Page 5 removed with the bar: the page before it is chosen next.
  await tap(tile(5));
  await page.click('[aria-label="Remove page 5"]');
  equal(await keys(page), before.slice(0, 4), 'removed');
  equal(await page.textContent('.reorganize-bar-label'), 'Page 4', 'the page before it is chosen');
  // A blank page after Beta's landscape page: landscape.
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 5);
  s = await state(page);
  equal([s.pages[4].input, Math.round(s.pages[4].width), Math.round(s.pages[4].height)], ['blank', 842, 595], 'the size of the page before it');
  await shot(page, `reorganize-edit-${wide ? 'desktop' : 'phone'}`);
  await noSideScroll(page);

  // Saved: the pages as listed, turned, sized and named as shown.
  const expected = (await state(page)).pages;
  await page.click('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  const out = await download(page);
  equal(out.name, 'alpha_reorganized.pdf', 'named after the PDF');
  const shown = await readBack(page, url, out.bytes);
  const names = { p1: 'alpha.pdf', p2: 'Beta.pdf' };
  equal(says(shown, expected.map((p) => (p.input === 'blank' ? '' : SAYS[names[p.input]][p.page]))), expected.map((p) => (p.input === 'blank' ? '' : SAYS[names[p.input]][p.page])), 'the pages in their new order, the blank page empty');
  equal(shown.map((p) => p.rotate), expected.map((p) => p.rotation), 'turned as shown');
  equal([shown[4].width, shown[4].height], [842, 595], 'the blank page\'s size');
  check(!shown.some((p) => squash(p.text) === 'ALPHATWO'), 'the page removed is gone');

  // Back to editing; Reset pages; one Undo brings the changes back.
  await page.click('.ui-result .ui-topbar [aria-label="Back to editing"]');
  await page.waitForSelector('.merge-view:not([hidden])');
  const edited = await keys(page);
  await page.click('button:has-text("Reset pages")');
  equal(await keys(page), [`${a0}@0`, `${a1}@0`, `${a2}@0`], 'Reset: the PDF\'s own pages');
  check(await page.isDisabled('button:has-text("Reset pages")') && await page.isDisabled('.ui-bottombar button'), 'nothing more to reset or save');
  await page.click('[aria-label="Undo"]');
  equal(await keys(page), edited, 'one Undo brings the changes back');

  // Removing the PDF with changes asks first.
  await page.click('.reorganize-card [aria-label="Remove alpha.pdf"]');
  await page.waitForSelector('dialog[open] >> text=Discard your changes?');
  await page.click('dialog[open] button:has-text("Keep")');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  check((await state(page)).main !== null, 'Keep keeps it');
  await page.click('.reorganize-card [aria-label="Remove alpha.pdf"]');
  await page.click('dialog[open] button:has-text("Discard")');
  await page.waitForSelector('.reorganize-page .ui-empty:not([hidden])');
  check((await state(page)).main === null, 'Discard: the PDF goes');
}

async function reorganizeMore(page, url) {
  group = 'reorganize desktop keys, turned pages and passwords';
  await openTool(page, url, 'reorganize');
  await pick(page, '.reorganize-page .ui-empty', [fx.turned]);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 2);
  // A blank page after a page the PDF itself turns: the size that page shows.
  await page.click(tile(1));
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 3);
  const s = await state(page);
  equal([Math.round(s.pages[1].width), Math.round(s.pages[1].height)], [842, 595], 'shown sideways, so the blank page is too');

  // Keyboard on a computer: Space chooses, Ctrl+Z undoes.
  await page.focus(tile(3));
  await page.keyboard.press('Space');
  equal(await page.textContent('.reorganize-bar-label'), 'Page 3', 'Space chooses');
  await page.keyboard.press('Control+Home');
  equal((await state(page)).pages.map(pageKey), ['p1:1', 'p1:0', 'blank:0'], 'Ctrl+Home moves it first');
  await page.keyboard.press('Control+z');
  equal((await state(page)).pages.map(pageKey), ['p1:0', 'blank:0', 'p1:1'], 'Ctrl+Z takes it back');
  check(await page.evaluate(() => !!document.activeElement.closest('.reorganize-grid .ui-page-tile')), 'the grid drawn afresh keeps the focus');
  await page.focus('.reorganize-page .ui-field-input');
  await page.keyboard.press('Control+z');
  equal((await state(page)).pages.map(pageKey), ['p1:0', 'blank:0', 'p1:1'], 'Ctrl+Z in the file name is left to the field');
  // A page from a PDF with a password, after it asks.
  await page.click(tile(1));
  await page.click('.reorganize-actions button:has-text("Add pages")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.ui-menu-item:has-text("Pages from a PDF")')]);
  await chooser.setFiles([fx.locked]);
  await page.waitForSelector('dialog[open] .ui-password');
  await page.fill('dialog[open] input[type=password]', 'test123');
  await page.keyboard.press('Enter');
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 6);
  check((await state(page)).pages[1].input === 'p2' && (await state(page)).pages[3].input === 'p2', 'its pages after the chosen page');
  // A PDF dropped on the pages adds its pages after the chosen page too.
  await page.click(tile(6));
  await dropFiles(page, '.reorganize-page .merge-content', [fx.gamma]);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 7);
  const expected = (await state(page)).pages;
  equal(pageKey(expected[6]), 'p3:0', 'the PDF dropped: its page after the chosen one');
  await shot(page, 'reorganize-more-desktop');
  await page.click('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  check((await page.textContent('.ui-result')).includes('The new PDF has no password.'), 'made from a PDF with a password');
  const out = await download(page);
  const shown = await readBack(page, url, out.bytes);
  const names = { p1: 'turned.pdf', p2: 'statement.pdf', p3: 'gamma.pdf' };
  equal(says(shown, expected.map((p) => (p.input === 'blank' ? '' : SAYS[names[p.input]][p.page]))), expected.map((p) => (p.input === 'blank' ? '' : SAYS[names[p.input]][p.page])), 'the pages as listed');
  // TURNED ONE keeps the quarter turn it has of its own, plus the one given here.
  equal(shown.map((p) => p.rotate), expected.map((p) => ((p.input === 'p1' && p.page === 0 ? 90 : 0) + p.rotation) % 360), 'turns add to the page\'s own');

  // The browser's Back returns to editing, the pages as they were; Forward doesn't bring back a
  // result that has gone.
  await page.goBack();
  await page.waitForSelector('.merge-view:not([hidden])');
  check(await page.$('.ui-result') === null, 'Back: the result has gone');
  equal((await state(page)).pages, expected, 'the pages as they were');
  equal(await page.evaluate(() => location.hash), '#/tool/reorganize', 'still in Reorganize PDF');
  await page.goForward();
  await waitFor(page, () => (history.state?.step ?? null) === null, null, 5000);
  check(await page.$('.ui-result') === null && await page.isVisible('.reorganize-grid'), 'Forward: the tool as it was');
}

/** The look in dark mode, at both sizes. */
async function darkShots(page, url, { wide }) {
  group = `dark ${wide ? 'desktop' : 'phone'}`;
  await page.emulateMedia({ colorScheme: 'dark' });
  await openTool(page, url, 'merge');
  await pick(page, '.merge-page .ui-empty', [fx.gamma, fx.alpha, fx.beta]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 3);
  await shot(page, `merge-files-dark-${wide ? 'desktop' : 'phone'}`);
  await page.click('.merge-mode');
  await page.click('[aria-label="Rotate page 3 right"]');
  await page.waitForTimeout(500);
  await shot(page, `merge-pages-dark-${wide ? 'desktop' : 'phone'}`);
  await openTool(page, url, 'reorganize');
  await pick(page, '.reorganize-page .ui-empty', [fx.many]);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-turn canvas').length >= 6);
  await page.click(tile(2));
  await page.click('[aria-label="Rotate page 2 left"]');
  await page.waitForTimeout(500);
  await shot(page, `reorganize-dark-${wide ? 'desktop' : 'phone'}`);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.reorganize-bar')).backgroundColor);
  check(bg !== 'rgb(255, 255, 255)', 'the bar takes the dark colours', bg);
  // A long PDF's grid scrolls inside the screen.
  const grid = await page.evaluate(() => { const g = document.querySelector('.reorganize-grid'); return { sh: g.scrollHeight, ch: g.clientHeight }; });
  check(grid.sh > grid.ch, 'the grid scrolls in itself', grid);
  await noSideScroll(page);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The narrowest phones (320 px): nothing scrolls sideways, the chosen page's buttons all fit. */
async function narrow(page, url) {
  group = 'narrow';
  await page.setViewportSize({ width: 320, height: 700 });
  await openTool(page, url, 'merge');
  await pick(page, '.merge-page .ui-empty', [fx.alpha, { ...fx.gamma, name: 'A quarterly report with a long name that goes on and on.pdf' }]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 2);
  await noSideScroll(page);
  await page.click('.merge-mode');
  await noSideScroll(page);
  await openTool(page, url, 'reorganize');
  await pick(page, '.reorganize-page .ui-empty', [fx.alpha]);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 3);
  await page.click(tile(2));
  const r = await page.evaluate(() => {
    const bar = document.querySelector('.reorganize-bar').getBoundingClientRect();
    return [...document.querySelectorAll('.reorganize-bar .ui-icon-btn')].every((b) => {
      const x = b.getBoundingClientRect();
      return x.left >= bar.left - 1 && x.right <= bar.right + 1 && x.width >= 47;
    });
  });
  check(r, 'the five buttons fit, 48 px each');
  equal(await page.textContent('.reorganize-bar-label'), 'Page 2', 'the page is still named for screen readers');
  await shot(page, 'reorganize-320');
  await noSideScroll(page);
}

/** A short run in another browser: merge two PDFs, move a page in Reorganize, save both. */
async function otherBrowser(page, url, name) {
  group = `${name}`;
  // Each browser picks through the file input in one tool and drops on the card in the other.
  const firefox = name.startsWith('firefox');
  const give = (selector, files, drop) => (drop ? dropFiles(page, selector, files) : pick(page, selector, files));
  await openTool(page, url, 'merge');
  await give('.merge-page .ui-empty', [fx.gamma, fx.alpha], !firefox);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 2);
  await page.click('[aria-label="Move alpha.pdf earlier"]');
  equal(await fileNames(page), ['alpha.pdf', 'gamma.pdf'], 'moved with its button');
  await page.focus('[aria-label="Remove gamma.pdf"]');
  await page.keyboard.press('Control+ArrowUp');
  await page.keyboard.press('Control+ArrowDown');
  equal(await fileNames(page), ['alpha.pdf', 'gamma.pdf'], 'and back with the keyboard');
  await page.click('.merge-mode');
  await waitFor(page, () => document.querySelectorAll('.merge-pages .merge-page-row').length === 4);
  await page.click('[aria-label="Rotate page 1 right"]');
  const [from, to] = await centers(page, '.merge-pages .merge-page-text', [3, 0]);
  await mouseDrag(page, from, to);
  equal((await pageLines(page))[0], '1. gamma.pdf, page 1', 'a page dragged with the mouse');
  await page.click('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  let out = await download(page);
  let shown = await readBack(page, url, out.bytes);
  let words = ['GAMMAONE', 'ALPHAONE', 'ALPHATWO', 'ALPHATHREE'];
  equal(says(shown, words), words, 'merged');
  equal(shown.map((p) => p.rotate), [0, 90, 0, 0], 'turned');
  await shot(page, `merge-result-${name.replace(' ', '-')}`);

  await openTool(page, url, 'reorganize');
  await give('.reorganize-page .ui-empty', [fx.alpha], firefox);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 3);
  await page.click(tile(1));
  await page.click('[aria-label="Move page 1 later"]');
  await page.click('[aria-label="Rotate page 2 left"]');
  const [a, b] = await centers(page, '.reorganize-grid .ui-page', [2, 0]);
  await mouseDrag(page, a, b);
  const expected = (await state(page)).pages;
  check(expected.length === 3 && expected[0].page === 2 && expected[2].rotation === 270, 'moved, turned and dragged with the mouse', expected);
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 4);
  await shot(page, `reorganize-${name.replace(' ', '-')}`);
  await page.click('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  out = await download(page);
  shown = await readBack(page, url, out.bytes);
  const pages = (await state(page)).pages;
  words = pages.map((p) => (p.input === 'blank' ? '' : SAYS['alpha.pdf'][p.page]));
  equal(says(shown, words), words, 'reorganized');
  equal(shown.map((p) => p.rotate), pages.map((p) => p.rotation), 'turned');
  await noSideScroll(page);
}

// ---------------------------------------------------------------------------------------------
// What reviewers found, checked

/** A 2500-page PDF, made once when first needed (a few seconds). */
let bigPdf = null;
const big = async () => (bigPdf ??= pdf('big.pdf', await makePdf(Array.from({ length: 2500 }, (_, i) => ({ text: `BIG ${i + 1}` })))));

/** What has the focus: 'BODY', or its label (aria-label, else its text). */
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return !a || a === document.body ? 'BODY' : (a.getAttribute('aria-label') ?? a.textContent.trim());
});
const focusIs = (page, selector) => page.evaluate((s) => document.activeElement === document.querySelector(s), selector);

/** Opens Home, then the tool from there, so the browser's Back goes back to Home in the app. */
async function openFromHome(page, url, id) {
  await page.goto('about:blank');
  await page.goto(url + 'app/#/');
  await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])', { timeout: 20000 });
  await page.evaluate((id) => { location.hash = '#/tool/' + id; }, id);
  await page.waitForSelector(`.screen[data-tool="${id}"]:not([aria-busy])`, { timeout: 20000 });
  await page.evaluate(async (base) => {
    const router = await import(base + 'app/js/core/router.js');
    window.__handle = () => router.currentHandle();
  }, url);
}

/** Picks a PDF from the keyboard (Enter on the focused card), gives the locked PDF, cancels its password. */
async function cancelPassword(page, selector) {
  await page.focus(selector);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles([fx.locked]);
  await page.waitForSelector('dialog[open] .ui-password');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  await page.waitForTimeout(100);
}

/** On a wide screen the main button ends where the column (`selector`'s content) ends. */
async function buttonUnderColumn(page, selector) {
  for (const width of [1366, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const edges = await page.evaluate((s) => {
      const col = document.querySelector(s);
      return {
        column: col.getBoundingClientRect().right - parseFloat(getComputedStyle(col).paddingRight),
        button: document.querySelector('.merge-view > .ui-bottombar .ui-btn').getBoundingClientRect().right,
      };
    }, selector);
    check(Math.abs(edges.column - edges.button) <= 1, `${width} px: the main button ends where the column does`, edges);
  }
  await page.setViewportSize(DESKTOP);
}

/** From the keyboard: the PDF made, Back to editing, made again, Start over (asked first). */
async function resultFocus(page, action, empty) {
  const run = '.merge-view > .ui-bottombar .ui-btn';
  await page.focus(run);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  await page.focus('.ui-result .ui-topbar-nav');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.merge-view:not([hidden])');
  equal(await focused(page), action, 'Back to editing: the focus on the main button');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  await page.focus('.ui-result-startover');
  await page.keyboard.press('Enter');
  await page.click('dialog[open] .ui-btn:has-text("Start over")');
  await page.waitForSelector(`${empty}:not([hidden])`);
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  check(await focusIs(page, empty), 'Start over: the focus on the empty card', await focused(page));
}

async function mergeReview(page, url, { wide }) {
  group = `merge review ${wide ? 'desktop' : 'phone'}`;
  await openTool(page, url, 'merge');
  equal(await page.$$eval('main', (m) => m.map((x) => x.classList.contains('merge-page') && x.hasAttribute('data-main'))), [true], 'one main landmark: the content');
  // A password question cancelled: the focus stays on the card it was picked from.
  await cancelPassword(page, '.merge-page .ui-empty');
  check(await focusIs(page, '.merge-page .ui-empty'), 'password cancelled: the focus on Add PDFs', await focused(page));

  // Dropped on the empty card: added, and nothing stays marked as a drop target.
  await dropFiles(page, '.merge-page .ui-empty', [fx.alpha, fx.beta]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 2);
  equal(await page.$$eval('#app .is-dragover', (n) => n.length), 0, 'a drop on the empty card leaves nothing marked');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['%PDF-1.4'], 'x.pdf', { type: 'application/pdf' }));
    const target = document.querySelector('.merge-page');
    for (const type of ['dragenter', 'dragleave']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  equal(await page.$$eval('#app .is-dragover', (n) => n.length), 0, 'a drag in and out again leaves nothing marked');
  await dropFiles(page, '.merge-page .merge-content', [fx.gamma]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 3);
  equal(await page.$$eval('#app .is-dragover', (n) => n.length), 0, 'a drop on the list adds it, nothing left marked');
  if (wide) await buttonUnderColumn(page, '.merge-page');

  // Page mode: the move buttons never cover the picture, which a press drags.
  await page.click('.merge-mode');
  await waitFor(page, () => document.querySelectorAll('.merge-pages .merge-page-row').length === 6);
  await waitFor(page, () => document.querySelectorAll('.merge-pages .merge-thumb canvas').length >= 4);
  const row = (n) => `.merge-pages .merge-page-row:nth-of-type(${n})`;
  const before = await pageLines(page);
  const moves = (n) => page.$eval(row(n), (r) => {
    const m = r.querySelector('.merge-moves').getBoundingClientRect();
    const p = r.querySelector('.merge-thumb').getBoundingClientRect();
    const overlaps = m.width > 1 && m.left < p.right && m.right > p.left && m.top < p.bottom && m.bottom > p.top;
    return { width: m.width, opacity: getComputedStyle(r.querySelector('.merge-moves')).opacity, overlaps };
  });
  if (wide) {
    const [c] = await centers(page, '.merge-pages .merge-thumb', [2]);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(250);
    const m = await moves(3);
    check(m.opacity === '1' && !m.overlaps, 'pointed at, the row shows its move buttons beside the picture', m);
    equal(await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y).closest('button') ? 'button' : 'picture'), c), 'picture', 'the picture is what is under the pointer');
    await page.mouse.click(c.x, c.y);
    equal(await pageLines(page), before, 'a click on the picture moves nothing');
    // Dragged from its picture: page 1 to the fourth place.
    const [from, to] = await centers(page, '.merge-pages .merge-thumb', [0, 3]);
    await mouseDrag(page, from, to);
    equal((await pageLines(page)).map((l) => l.slice(3)), [before[1], before[2], before[3], before[0], before[4], before[5]].map((l) => l.slice(3)), 'a drag from the picture moves the page');
  } else {
    // A tap on the row's text, then on its picture: nothing moves, the buttons don't show.
    await page.tap(`${row(2)} .merge-page-text`);
    await page.tap(`${row(2)} .merge-thumb`);
    await page.waitForTimeout(200);
    equal(await pageLines(page), before, 'taps on a row move nothing');
    check((await moves(2)).width <= 1, 'tapped, the row shows no move buttons', await moves(2));
    // A long press on the picture drags it.
    const [from, to] = await centers(page, '.merge-pages .merge-thumb', [1, 3]);
    await touchDrag(page, from, to);
    equal((await pageLines(page))[3].slice(3), before[1].slice(3), 'a long press on the picture drags the page');
    check((await moves(4)).width <= 1, 'after the drag, the row moved shows no move buttons', await moves(4));
  }
  await page.click('button:has-text("Reset pages")');

  // The result left from the keyboard: the focus on Merge PDFs, then (Start over) on Add PDFs.
  await resultFocus(page, 'Merge PDFs', '.merge-page .ui-empty');

  // The last PDF removed: the focus on the Add PDFs card, which takes the list's place.
  await pick(page, '.merge-page .ui-empty', [fx.gamma]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 1);
  await page.focus('[aria-label="Remove gamma.pdf"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.merge-page .ui-empty:not([hidden])');
  check(await focusIs(page, '.merge-page .ui-empty'), 'the last PDF removed: the focus on Add PDFs', await focused(page));
}

async function reorganizeReview(page, url, { wide }) {
  group = `reorganize review ${wide ? 'desktop' : 'phone'}`;
  await openTool(page, url, 'reorganize');
  equal(await page.$$eval('main', (m) => m.map((x) => x.classList.contains('reorganize-page') && x.hasAttribute('data-main'))), [true], 'one main landmark: the content');
  await cancelPassword(page, '.reorganize-page .ui-empty');
  check(await focusIs(page, '.reorganize-page .ui-empty'), 'password cancelled: the focus on Choose PDF', await focused(page));
  await pick(page, '.reorganize-page .ui-empty', [fx.alpha]);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 3);
  // Undo of the last change turns Undo off: the focus goes to the page count beside it.
  await page.click(tile(1));
  await page.click('[aria-label="Rotate page 1 right"]');
  await page.focus('[aria-label="Undo"]');
  await page.keyboard.press('Enter');
  check(await focusIs(page, '.reorganize-count'), 'the last Undo: the focus on the page count', await focused(page));
  // Reset pages turns itself off: the focus goes to Add pages.
  await page.click('[aria-label="Rotate page 1 right"]');
  await page.focus('button:has-text("Reset pages")');
  await page.keyboard.press('Enter');
  equal(await focused(page), 'Add pages', 'Reset pages: the focus on Add pages');
  if (wide) await buttonUnderColumn(page, '.reorganize-page');
  // Reset lets go of the chosen page: chosen again, turned, saved.
  await page.click(tile(1));
  await page.click('[aria-label="Rotate page 1 right"]');
  await resultFocus(page, 'Save PDF', '.reorganize-page .ui-empty');
}

/** Merge and Reorganize show their screen without waiting for the engine (pdf-lib), held here. */
async function beforeTheEngine(page, url) {
  group = 'the screens before the engine';
  const held = [];
  await page.route('**/vendor/pdf-lib/**', (route) => { held.push(route); });
  try {
    for (const id of ['merge', 'reorganize']) {
      await page.goto('about:blank');
      await page.goto(url + 'app/#/');
      await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])', { timeout: 20000 });
      // Home may have asked for it ahead: what matters is that the tool doesn't wait for it.
      await page.evaluate((id) => { location.hash = '#/tool/' + id; }, id);
      await page.waitForSelector(`.screen[data-tool="${id}"]:not([aria-busy]) .ui-empty`, { timeout: 10000 });
      equal(await page.inputValue('.screen .ui-field-input').catch(() => null) ?? 'none', id === 'merge' ? 'Merged_PDF' : '', `${id}: shown with its name, the engine not loaded`);
    }
  } finally {
    await page.unroute('**/vendor/pdf-lib/**');
    for (const r of held) await r.continue().catch(() => {});
  }
}

/** Leaving Merge or Reorganize while the PDF is made stops it: no progress left over Home. */
async function leaveWhileWorking(page, url) {
  group = 'leaving while a PDF is made';
  const bigOne = await big();
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const id of ['merge', 'reorganize']) {
      await openFromHome(page, url, id);
      if (id === 'merge') {
        await pick(page, '.merge-page .ui-empty', [bigOne, { ...bigOne, name: 'big2.pdf' }]);
        await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 2, null, 60000);
      } else {
        await pick(page, '.reorganize-page .ui-empty', [bigOne]);
        await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === 2500, null, 60000);
        await page.click(tile(1));
        await page.click('[aria-label="Remove page 1"]');
      }
      // Slowed, so the PDF can't be made before Back is pressed.
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.click('.merge-view > .ui-bottombar .ui-btn');
      await page.waitForSelector('dialog[open] .ui-progress-dialog', { timeout: 20000 });
      await page.goBack();
      await page.waitForSelector('dialog[open] >> text=Discard your changes?', { timeout: 20000 });
      check(await page.$('.ui-result') === null, `${id}: still working when Back is pressed`);
      await page.click('dialog[open] button:has-text("Discard")');
      await page.waitForSelector('.screen[data-route="home"]', { timeout: 20000 });
      await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 1500 });
      checks++;
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await cdp.detach();
  }
}

/**
 * A long merge in page mode: a turn or a removal redraws only the rows it changes. A row redrawn
 * writes its line again (row.update); pictures drawn and let go as the list scrolls don't count.
 */
async function longPageList(page, url) {
  group = 'a long page list';
  await openTool(page, url, 'merge');
  await pick(page, '.merge-page .ui-empty', [await big(), fx.gamma]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 2, null, 60000);
  await page.click('.merge-mode');
  await waitFor(page, () => document.querySelectorAll('.merge-pages .merge-page-row').length === 2501, null, 60000);
  const rowsChanged = (selector) => page.evaluate(async (selector) => {
    const list = document.querySelector('.merge-pages');
    const rows = new Set();
    const watch = new MutationObserver((records) => {
      for (const r of records) if (r.target.classList?.contains('merge-page-text')) rows.add(r.target.closest('.merge-page-row'));
    });
    watch.observe(list, { subtree: true, childList: true, characterData: true, attributes: true });
    // Once nothing is being redrawn (300 ms without a line written).
    const quiet = Date.now() + 15000;
    do {
      rows.clear();
      await new Promise((r) => setTimeout(r, 300));
      watch.takeRecords();
    } while (rows.size && Date.now() < quiet);
    rows.clear();
    const t0 = performance.now();
    document.querySelector(selector).click();
    const ms = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
    for (const r of watch.takeRecords()) if (r.target.classList?.contains('merge-page-text')) rows.add(r.target.closest('.merge-page-row'));
    watch.disconnect();
    return { rows: rows.size, which: [...rows].map((r) => r.querySelector('.merge-page-text').textContent), ms: Math.round(ms) };
  }, selector);
  const turned = await rowsChanged('[aria-label="Rotate page 5 right"]');
  equal(turned.which, ['5. big.pdf, page 5'], `a turn redraws only its row of 2501 (${turned.ms} ms)`);
  const removed = await rowsChanged('[aria-label="Remove page 2499"]');
  // The two rows after it, renumbered, and the row whose Tab stop the focus took (the first).
  check(removed.rows <= 3, `a removal near the end redraws only the rows after it (${removed.ms} ms)`, removed.which);
  equal((await pageLines(page)).length, 2500, 'removed');
}

// ---------------------------------------------------------------------------------------------

await stringTests();
pageListTests();

for (const wide of [false, true]) {
  await withPage(async (page, url) => {
    // Merging and reorganizing embed no font with pdf-lib: fontkit (157 kB gzipped) isn't loaded.
    const fontkit = [];
    page.on('request', (r) => { if (r.url().includes('/vendor/fontkit/')) fontkit.push(r.url()); });
    if (!review) {
      await mergeFiles(page, url, { wide });
      await mergePages(page, url, { wide });
      if (!wide) await mergePasswordsAndProblems(page, url);
      await reorganize(page, url, { wide });
      if (wide) await reorganizeMore(page, url);
      await darkShots(page, url, { wide });
      if (!wide) await narrow(page, url);
      await page.setViewportSize(wide ? DESKTOP : PHONE);
    }
    await mergeReview(page, url, { wide });
    await reorganizeReview(page, url, { wide });
    if (wide) {
      await beforeTheEngine(page, url);
      await longPageList(page, url);
      await leaveWhileWorking(page, url);
    }
    group = 'fontkit';
    equal(fontkit, [], 'no fontkit loaded by Merge or Reorganize');
  }, { viewport: wide ? DESKTOP : PHONE });
  console.log(`ok: Chromium at ${wide ? 'desktop' : 'phone'} size`);
}

if (!quick) {
  for (const browser of ['firefox', 'webkit']) {
    for (const viewport of [PHONE, DESKTOP]) {
      await withPage((page, url) => otherBrowser(page, url, `${browser} ${viewport.width}`), { browser, viewport, mobile: false });
      console.log(`ok: ${browser} at ${viewport.width} px`);
    }
  }
}

console.log(`organize-ui-b: ${checks} checks passed`);
