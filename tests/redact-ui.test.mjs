// Redact PDF's screen (site/app/js/tools/redact/): choosing a PDF, drawing boxes with the mouse and
// by touch on upright, turned and cropped pages, Find text, moving, resizing and deleting boxes
// (by dragging, with the buttons and with the keyboard), Add box, Remove all, the app's quick-tap
// cases (RedactQuickTapsDeviceTest.kt), zoom, and saving: the boxed words are gone from the PDF
// (pdf.js text and pixels) while the rest stays. Screenshots at phone and desktop sizes, light and
// dark, go to tests/output/redact-ui-*.png.
//   node tests/redact-ui.test.mjs            everything
//   node tests/redact-ui.test.mjs --quick    Chromium only, no screenshots
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { withPage, assert, runInPage, outputDir } from './harness.mjs';
import * as R from '../site/app/js/engine/redact/boxes.js';
import strings from '../site/app/locales/en/redact.js';
import common from '../site/app/locales/en/common.js';

const quick = process.argv.includes('--quick');
const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 800 };
let failures = 0;
let passed = 0;

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
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
const near = (a, b, eps, message) => assert(Math.abs(a - b) <= eps, `${message}: ${a} should be ${b} (±${eps})`);
const plural = (entry, n) => (n === 1 ? entry.one : entry.other).replace('{1}', String(n));
const fill = (text, ...args) => args.reduce((s, a, i) => s.replace(`{${i + 1}}`, String(a)), text);

// ---- The PDFs ----

/**
 * Four pages: an upright A4 page, a page turned a quarter (/Rotate 90), a page cropped to part of
 * it, and a page without anything to hide. `words` gives where each word is, as a box of its page
 * as shown (fractions from the top-left corner).
 */
async function samplePdf({ pages = 4, password } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const words = {};
  const put = (p, index, frame, key, text, x, y, size) => {
    p.drawText(text, { x, y, size, font });
    const rect = { x, y: y - 0.25 * size, width: font.widthOfTextAtSize(text, size), height: 1.05 * size };
    words[key] = { page: index, box: R.rectToBox(frame, index, rect) };
  };
  const upright = doc.addPage([595, 842]);
  const flat = new R.PageFrame(0, 0, 595, 842, 0);
  put(upright, 0, flat, 'jane', 'Jane Doe', 72, 700, 24);
  put(upright, 0, flat, 'account', 'Account 1234 5678', 72, 600, 14);
  put(upright, 0, flat, 'cafe', 'Café Noir', 72, 500, 14);
  if (pages > 1) {
    const turned = doc.addPage([595, 842]);
    turned.setRotation(degrees(90));
    const frame = new R.PageFrame(0, 0, 595, 842, 90);
    put(turned, 1, frame, 'jane2', 'Jane Doe', 100, 420, 20);
    put(turned, 1, frame, 'keep', 'Keep this line', 100, 300, 14);
  }
  if (pages > 2) {
    const cropped = doc.addPage([595, 842]);
    cropped.setCropBox(100, 200, 400, 500);
    const frame = new R.PageFrame(100, 200, 400, 500, 0);
    put(cropped, 2, frame, 'secret', 'Secret Code 42', 150, 600, 18);
    put(cropped, 2, frame, 'visible', 'Visible words', 150, 400, 14);
    cropped.drawText('Outside crop', { x: 20, y: 20, size: 12, font });
  }
  if (pages > 3) {
    const plain = doc.addPage([595, 842]);
    put(plain, 3, flat, 'nothing', 'Nothing to hide here', 72, 700, 14);
  }
  for (let i = 4; i < pages; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Filler page ${i + 1}`, { x: 72, y: 700, size: 14, font });
  }
  if (password) doc.encrypt({ userPassword: password, ownerPassword: password + '-owner' });
  return { bytes: await doc.save(), words };
}

// ---- Driving the screen ----

async function openApp(page, url) {
  if (!page.url().startsWith(url + 'app/')) {
    await page.goto(url + 'app/#/tool/redact');
    await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  } else {
    // Already in the app: Redact PDF afresh, as from Home.
    await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/tool/redact', { force: true, replace: true }));
  }
  await page.waitForSelector('#app > .screen[data-tool="redact"]:not([aria-busy]) .redact-page .ui-empty', { timeout: 20000 });
}

/** Opens Redact PDF and chooses `bytes` with the file picker, as a user would. */
async function openWithPicker(page, url, bytes, name = 'Sample report.pdf') {
  await openApp(page, url);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.redact-page .ui-empty')]);
  await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await waitReady(page);
}

/** Opens Redact PDF with `bytes` handed over, as Choose a tool does. */
async function openHanded(page, url, bytes, name = 'Sample report.pdf', extra = {}) {
  await openApp(page, url);
  await page.evaluate(async ({ b64, name, extra }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { navigate } = await import('./js/core/router.js');
    await navigate('/tool/redact', { files: [{ name, type: 'application/pdf', size: bytes.length, lastModified: 0, bytes, ...extra }] });
  }, { b64: Buffer.from(bytes).toString('base64'), name, extra });
}

/** Drops files on Choose PDF, as from a computer's file manager. */
async function dropFiles(page, files) {
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const target = document.querySelector('.redact-page .ui-empty');
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files.map((f) => ({ name: f.name, type: f.type, b64: Buffer.from(f.bytes).toString('base64') })));
}

async function waitReady(page) {
  await page.waitForSelector('.redact-sheet.is-ready', { timeout: 20000 });
  // Polled in the page: waitForFunction doesn't wait for an async predicate (a promise is truthy).
  await page.evaluate(async () => {
    const { currentHandle } = await import('./js/core/router.js');
    const started = Date.now();
    while (!currentHandle()?.redact?.ready()) {
      if (Date.now() - started > 20000) throw new Error('Redact PDF\'s page was never ready');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
}

/**
 * Calls fn(r, arg) in the page with the screen's test handle `r`. Through Playwright's handle of
 * it, not by building a function from text: the app's Content Security Policy has no 'unsafe-eval'.
 */
async function handle(page, fn, arg) {
  const r = await page.evaluateHandle(async () => (await import('./js/core/router.js')).currentHandle().redact);
  try {
    return await r.evaluate(fn, arg);
  } finally {
    await r.dispose();
  }
}
const state = (page) => handle(page, (r) => r.state());

/** The page's place on the screen, its frame scrolled into the middle of it first. */
async function sheetBox(page) {
  await page.evaluate(() => document.querySelector('.redact-viewport').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(50);
  return page.locator('.redact-sheet').boundingBox();
}

/** Screen point of the page fraction (fx, fy). */
const at = (r, fx, fy) => ({ x: r.x + fx * r.width, y: r.y + fy * r.height });

async function mouseDrag(page, from, to, steps = 8) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** A one-finger drag with real touch events (Chromium). */
async function touchDrag(page, from, to, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await send('touchStart', [{ x: from.x, y: from.y, id: 1 }]);
  for (let i = 1; i <= steps; i++) {
    await send('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 }]);
  }
  await send('touchEnd', []);
  await cdp.detach();
}

async function touchTap(page, p) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Two fingers moving apart from `gap` to `gap2` pixels around `mid`. */
async function pinch(page, mid, gap, gap2, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const points = (g) => [{ x: mid.x - g / 2, y: mid.y, id: 1 }, { x: mid.x + g / 2, y: mid.y, id: 2 }];
  await send('touchStart', [points(gap)[0]]);
  await send('touchStart', points(gap));
  for (let i = 1; i <= steps; i++) await send('touchMove', points(gap + ((gap2 - gap) * i) / steps));
  await send('touchEnd', []);
  await cdp.detach();
}

/** Draws a box over `box` (fractions of the page), `margin` px bigger all round, with the mouse. */
async function drawOver(page, box, { margin = 4, touch = false } = {}) {
  const r = await sheetBox(page);
  const from = { x: r.x + box.left * r.width - margin, y: r.y + box.top * r.height - margin };
  const to = { x: r.x + box.right * r.width + margin, y: r.y + box.bottom * r.height + margin };
  if (touch) await touchDrag(page, from, to);
  else await mouseDrag(page, from, to);
  return r;
}

/** Waits for a snackbar saying `text` and puts it away, so the next one shows at once. */
async function snack(page, text) {
  await page.waitForFunction((t) => [...document.querySelectorAll('.ui-snackbar.is-shown .ui-snackbar-text')].some((n) => n.textContent === t), text, { timeout: 30000 });
  await page.evaluate((t) => {
    for (const n of document.querySelectorAll('.ui-snackbar')) if (n.querySelector('.ui-snackbar-text')?.textContent === t) n.dismiss();
  }, text);
  await page.waitForFunction((t) => ![...document.querySelectorAll('.ui-snackbar-text')].some((n) => n.textContent === t), text);
}

async function dismissSnacks(page) {
  await page.evaluate(() => document.querySelectorAll('.ui-snackbar').forEach((n) => n.dismiss?.()));
}

const covers = (outer, inner, slack = 0) => outer.page === inner.page && outer.left <= inner.left + slack &&
  outer.top <= inner.top + slack && outer.right >= inner.right - slack && outer.bottom >= inner.bottom - slack;

async function find(page, query, { enter = false } = {}) {
  await page.fill('.redact-find input', query);
  if (enter) await page.press('.redact-find input', 'Enter');
  else await page.click('.redact-find-button');
}

/** Redacts and returns the new PDF from the result screen's Save to Downloads. */
async function redactAndDownload(page) {
  await page.click('.ui-bottombar button:has-text("' + strings.pdf_redact_action + '")');
  await page.waitForSelector('.ui-result-heading', { timeout: 60000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('.ui-result-actions button:has-text("' + common.save_to_downloads + '")'),
  ]);
  const name = download.suggestedFilename();
  const bytes = new Uint8Array(await readFile(await download.path()));
  return { name, bytes };
}

/**
 * Renders page `index` of `bytes` with pdf.js and measures `rects` (fractions of the page as
 * shown): how many pixels are dark, light, and how many in all. Also the page's text.
 */
function measure(page, bytes, index, rects) {
  return page.evaluate(async ({ b64, index, rects }) => {
    const { openPdfJs } = await import('./js/lib/pdfjs.js');
    const doc = await openPdfJs(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    try {
      const p = await doc.getPage(index + 1);
      const viewport = p.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: ctx, canvas, viewport }).promise;
      const text = (await p.getTextContent()).items.map((i) => i.str).join(' ');
      const areas = rects.map((r) => {
        const x0 = Math.floor(r.left * canvas.width);
        const y0 = Math.floor(r.top * canvas.height);
        const w = Math.max(1, Math.ceil((r.right - r.left) * canvas.width));
        const h = Math.max(1, Math.ceil((r.bottom - r.top) * canvas.height));
        const data = ctx.getImageData(x0, y0, w, h).data;
        let dark = 0;
        let light = 0;
        for (let i = 0; i < data.length; i += 4) {
          const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (v < 60) dark++;
          else if (v > 200) light++;
        }
        return { dark, light, total: data.length / 4 };
      });
      return { text, areas, width: viewport.width, height: viewport.height };
    } finally {
      await doc.loadingTask.destroy();
    }
  }, { b64: Buffer.from(bytes).toString('base64'), index, rects });
}

/** `box` made smaller by `f` of its size on each side: inside it, safely. */
const inner = (box, f = 0.2) => {
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  return { ...box, left: box.left + f * w, right: box.right - f * w, top: box.top + f * h, bottom: box.bottom - f * h };
};

/** The element's place once it has stopped moving (the box buttons open with an animation). */
async function settled(page, selector) {
  let last = null;
  for (let i = 0; i < 40; i++) {
    const box = await page.locator(selector).boundingBox();
    if (last && box && JSON.stringify(box) === JSON.stringify(last)) return box;
    last = box;
    await page.waitForTimeout(60);
  }
  return last;
}

const controlsShown = (page) => page.waitForSelector('.redact-controls:not([hidden]):not(.is-gone)', { timeout: 5000 });
const stepButton = (key) => `.redact-controls [data-step="${key}"]`;

// ---- The tests ----

const sample = await samplePdf();
const { words } = sample;

await test('strings are the app\'s, word for word (strings.xml)', async () => {
  const xml = await readFile(new URL('../../pdfer/app/src/main/res/values/strings.xml', import.meta.url), 'utf8').catch(() => null);
  if (!xml) {
    console.log('  (the app\'s strings.xml is not next to this repository: skipped)');
    return;
  }
  const text = (raw) => raw.trim().replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/%(\d)\$[sd]/g, '{$1}').replace(/%[sd]/g, '{1}');
  for (const [key, value] of Object.entries(strings)) {
    if (key.startsWith('web_')) continue;
    if (typeof value === 'string') {
      const m = xml.match(new RegExp(`<string name="${key}"[^>]*>([\\s\\S]*?)</string>`));
      assert(m, `${key} is in strings.xml`);
      eq(value, text(m[1]), key);
    } else {
      const m = xml.match(new RegExp(`<plurals name="${key}"[^>]*>([\\s\\S]*?)</plurals>`));
      assert(m, `${key} is a plural in strings.xml`);
      const items = Object.fromEntries([...m[1].matchAll(/<item quantity="(\w+)">([\s\S]*?)<\/item>/g)].map((x) => [x[1], text(x[2])]));
      eq(value, items, key);
    }
    assert(!(key in common), `${key} isn't redefined from common.js`);
  }
});

await test('the screen before and after choosing a PDF (phone)', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url);
    eq(await page.textContent('.ui-topbar-title'), common.tool_redact, 'title');
    eq((await page.textContent('.redact-page .ui-empty .ui-empty-title')).trim(), common.pick_pdf, 'Choose PDF');
    assert(await page.isDisabled('.ui-bottombar button'), 'Redact PDF is off without a PDF');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.redact-page .ui-empty')]);
    assert(chooser.page() === page, 'the picker opened');
    await chooser.setFiles({ name: 'Sample report.pdf', mimeType: 'application/pdf', buffer: Buffer.from(sample.bytes) });
    await waitReady(page);
    eq(await page.textContent('.ui-file-name'), 'Sample report.pdf', 'file name on the card');
    assert((await page.textContent('.ui-file-detail')).startsWith(plural(common.page_count, 4) + ' · '), 'pages and size');
    eq(await page.textContent('.redact-note'), strings.redact_note, 'the note on true removal');
    eq(await page.textContent('.redact-find .ui-field-label'), strings.redact_find, 'Find text');
    eq(await page.textContent('.redact-find .ui-field-support'), strings.redact_find_hint, 'its hint');
    eq(await page.getAttribute('.redact-find-button', 'aria-label'), strings.redact_find_action, 'Find button');
    assert(await page.isDisabled('.redact-find-button'), 'Find is off while the field is empty');
    const titles = await page.$$eval('.redact-title', (n) => n.map((x) => x.textContent));
    eq(titles, [strings.redact_page, strings.redact_mark], 'headings');
    eq(await page.$$eval('.redact-strip [role=radio]', (n) => n.map((x) => [x.getAttribute('aria-label'), x.getAttribute('aria-checked')])),
      [['Page 1', 'true'], ['Page 2', 'false'], ['Page 3', 'false'], ['Page 4', 'false']], 'page strip');
    eq(await page.textContent('.redact-hint'), strings.redact_mark_hint, 'hint');
    eq(await page.getAttribute('.redact-boxes', 'aria-label'), fill(strings.redact_preview_description.other, 1, 0), 'page described');
    assert(!(await page.isDisabled('.redact-actions button:has-text("' + strings.redact_add_box + '")')), 'Add box is on');
    assert(!(await page.isVisible('.redact-remove-all')), 'Remove all only with boxes');
    assert(await page.isHidden('.redact-controls'), 'no box buttons without a box chosen');
    eq(await page.inputValue('.redact-tail input'), 'Sample report_redacted', 'file name');
    assert(await page.isDisabled('.ui-bottombar button'), 'Redact PDF is off without boxes');
    // The page is shaped as the PDF's (A4) and fits the phone's width.
    const r = await sheetBox(page);
    near(r.width / r.height, 595 / 842, 0.01, 'A4 shape');
    assert(r.height <= 440.5 && r.width <= PHONE.width - 40 + 0.5, 'fits the screen');
    // Nothing scrolls sideways.
    assert(await page.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth), 'no sideways scroll');
    // Messages show above the bottom bar, as the app's above its button (the kit lifts them).
    await find(page, 'nowhere to be found');
    await page.waitForSelector('.ui-snackbar.is-shown', { timeout: 30000 });
    const message = await settled(page, '.ui-snackbar.is-shown');
    const bar = await page.locator('.ui-bottombar').boundingBox();
    assert(message && bar && message.y + message.height <= bar.y + 0.5, `the message is above the bottom bar: ${JSON.stringify({ message, bar })}`);
    await dismissSnacks(page);
  }, { viewport: PHONE });
});

await test('drawing by touch on an upright page; slips, taps and Add box (phone)', async () => {
  await withPage(async (page, url) => {
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    const r = await drawOver(page, words.jane.box, { touch: true });
    let s = await state(page);
    eq(s.boxes.length, 1, 'one box drawn');
    assert(covers(s.boxes[0], words.jane.box), `the box covers "Jane Doe": ${JSON.stringify(s.boxes[0])}`);
    near(s.boxes[0].left, words.jane.box.left - 4 / r.width, 0.004, 'left where the finger went down');
    near(s.boxes[0].bottom, words.jane.box.bottom + 4 / r.height, 0.004, 'bottom where it lifted');
    eq(s.selected, 0, 'the new box is chosen');
    await controlsShown(page);
    eq(await page.getAttribute('button.redact-box', 'aria-label'), fill(strings.web_redact_box, 1, 1), 'box named');
    eq(await page.getAttribute('button.redact-box', 'aria-pressed'), 'true', 'box chosen');
    assert(await page.isEnabled('.ui-bottombar button'), 'Redact PDF on with a box');
    eq(await page.$eval('.redact-strip [role=radio]', (n) => !n.querySelector('.redact-strip-dot').hidden), true, 'page 1 has a dot');
    eq(await page.$eval('.redact-strip [role=radio]', (n) => document.getElementById(n.getAttribute('aria-describedby'))?.textContent), strings.redact_page_marked, 'Has boxes');
    // The page doesn't scroll while drawing.
    const scrolled = await page.evaluate(() => window.scrollY);
    await touchDrag(page, at(r, 0.6, 0.6), at(r, 0.8, 0.95));
    eq(await page.evaluate(() => window.scrollY), scrolled, 'a drag on the page draws instead of scrolling');
    eq((await state(page)).boxes.length, 2, 'a second box');
    // A box smaller than 6 px either way is a slip.
    await touchDrag(page, at(r, 0.3, 0.9), { x: at(r, 0.3, 0.9).x + 30, y: at(r, 0.3, 0.9).y + 4 });
    eq((await state(page)).boxes.length, 2, 'a 4 px tall box is dropped');
    // A tap on empty page lets the chosen box go; a tap on a box chooses it.
    await touchTap(page, at(r, 0.9, 0.05));
    eq((await state(page)).selected, -1, 'tap elsewhere');
    await page.waitForSelector('.redact-controls[hidden]', { state: 'attached', timeout: 5000 });
    const mid = at(r, (words.jane.box.left + words.jane.box.right) / 2, (words.jane.box.top + words.jane.box.bottom) / 2);
    await touchTap(page, mid);
    eq((await state(page)).selected, 0, 'tap on the box');
    // Within reach of a thin box's edge still chooses it.
    await touchTap(page, at(r, 0.9, 0.05));
    s = await state(page);
    const b1 = s.boxes[1];
    await touchTap(page, { x: r.x + b1.left * r.width - 8, y: r.y + ((b1.top + b1.bottom) / 2) * r.height });
    eq((await state(page)).selected, 1, 'a tap 8 px beside a box chooses it');
    // Add box: two inches wide and a line tall, centred, lower for each box on the page.
    await page.click('.redact-actions button:has-text("' + strings.redact_add_box + '")');
    s = await state(page);
    const expected = R.defaultBox(0, 595, 842, 2);
    for (const k of ['page', 'left', 'top', 'right', 'bottom']) near(s.boxes[2][k], expected[k], 1e-6, `Add box ${k}`);
    eq(s.selected, 2, 'the added box is chosen');
    eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), fill(strings.web_redact_box, 3, 3), 'and has the focus');
  }, { viewport: PHONE });
});

await test('drawing with the mouse on turned and cropped pages, moving, resizing (desktop)', async () => {
  await withPage(async (page, url) => {
    await openWithPicker(page, url, sample.bytes);
    // Page 2 is turned a quarter: shown landscape.
    await page.click('.redact-strip [role=radio][aria-label="Page 2"]');
    await waitReady(page);
    eq((await state(page)).page, 1, 'page 2 showing');
    let r = await sheetBox(page);
    near(r.width / r.height, 842 / 595, 0.01, 'turned page shown landscape');
    await drawOver(page, words.jane2.box);
    let s = await state(page);
    eq(s.boxes.length, 1, 'box on the turned page');
    assert(covers(s.boxes[0], words.jane2.box), `covers "Jane Doe" on the turned page: ${JSON.stringify(s.boxes[0])} vs ${JSON.stringify(words.jane2.box)}`);
    eq(s.boxes[0].page, 1, 'on page 2');
    // Page 3 is cropped.
    await page.click('.redact-strip [role=radio][aria-label="Page 3"]');
    await waitReady(page);
    r = await sheetBox(page);
    near(r.width / r.height, 400 / 500, 0.01, 'cropped page shaped as its crop box');
    eq(await page.$$eval('button.redact-box', (n) => n.length), 0, 'only the boxes of the page showing');
    await drawOver(page, words.secret.box);
    s = await state(page);
    eq(s.boxes.length, 2, 'box on the cropped page');
    assert(covers(s.boxes[1], words.secret.box), `covers "Secret Code 42": ${JSON.stringify(s.boxes[1])}`);
    // Dragging the box moves it.
    const was = s.boxes[1];
    r = await page.locator('.redact-sheet').boundingBox();
    const centre = at(r, (was.left + was.right) / 2, (was.top + was.bottom) / 2);
    await mouseDrag(page, centre, { x: centre.x + 40, y: centre.y + 30 });
    s = await state(page);
    // The page doesn't shift on the screen while boxes are chosen and let go.
    eq(await page.locator('.redact-sheet').boundingBox(), r, 'the page stayed where it was');
    const moved = R.moved(was, 40 / r.width, 30 / r.height);
    for (const k of ['left', 'top', 'right', 'bottom']) near(s.boxes[1][k], moved[k], 0.003, `moved ${k}`);
    eq(s.selected, 1, 'the moved box is chosen');
    // Dragging its corner resizes it.
    const before = s.boxes[1];
    const corner = at(r, before.right, before.bottom);
    await mouseDrag(page, { x: corner.x - 2, y: corner.y - 2 }, { x: corner.x + 28, y: corner.y + 18 });
    s = await state(page);
    near(s.boxes[1].left, before.left, 1e-6, 'left kept');
    near(s.boxes[1].top, before.top, 1e-6, 'top kept');
    near(s.boxes[1].right, before.right + 28 / r.width, 0.004, 'right follows');
    near(s.boxes[1].bottom, before.bottom + 18 / r.height, 0.004, 'bottom follows');
    // Dragged past the page's edge, a box stops at it.
    const now = s.boxes[1];
    const c2 = at(r, (now.left + now.right) / 2, (now.top + now.bottom) / 2);
    await mouseDrag(page, c2, { x: c2.x - 2000, y: c2.y });
    s = await state(page);
    near(s.boxes[1].left, 0, 1e-6, 'stopped at the left edge');
    near(s.boxes[1].right - s.boxes[1].left, now.right - now.left, 1e-5, 'same width');
    // Strip dots on pages 2 and 3.
    eq(await page.$$eval('.redact-strip-dot', (n) => n.map((d) => !d.hidden)), [false, true, true, false], 'dots');
  }, { viewport: DESKTOP });
});

await test('the box buttons and the keyboard (desktop)', async () => {
  await withPage(async (page, url) => {
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    const A = R.makeBox(0, 0.4, 0.4, 0.6, 0.45);
    await handle(page, (r, box) => r.addBox(box), A);
    await controlsShown(page);
    const STEP = R.STEP;
    // Arrow buttons.
    await page.click(stepButton('redact_move_right'));
    let box = (await state(page)).boxes[0];
    near(box.left, A.left + STEP, 1e-5, 'Move box right');
    await page.click(stepButton('redact_move_down'));
    box = (await state(page)).boxes[0];
    near(box.top, A.top + STEP, 1e-5, 'Move box down');
    await page.click(stepButton('redact_wider'));
    box = (await state(page)).boxes[0];
    near(box.right - box.left, A.right - A.left + STEP, 1e-5, 'Make box wider');
    near((box.left + box.right) / 2, (A.left + A.right) / 2 + STEP, 1e-5, 'around its centre');
    await page.click(stepButton('redact_shorter'));
    box = (await state(page)).boxes[0];
    near(box.bottom - box.top, A.bottom - A.top - STEP, 1e-5, 'Make box shorter');
    // The labels, as the app's.
    eq(await page.$$eval('.redact-controls [data-step]', (n) => n.map((b) => b.getAttribute('aria-label') ?? b.textContent.trim())),
      [strings.redact_move_left, strings.redact_move_up, strings.redact_move_down, strings.redact_move_right,
        strings.redact_narrower, strings.redact_wider, strings.redact_shorter, strings.redact_taller, strings.redact_delete_box], 'button names');
    // A button that can't take its step is off: a box at the top can't go up.
    await handle(page, (r) => r.addBox({ page: 0, left: 0.1, top: 0, right: 0.2, bottom: 0.05 }));
    assert(await page.isDisabled(stepButton('redact_move_up')), 'Move up off at the top');
    assert(await page.isEnabled(stepButton('redact_move_down')), 'Move down on');
    // Keyboard: focus the first box, arrows move it, Shift+arrows resize it, Ctrl+arrows take ten steps.
    await handle(page, (r) => r.selectBox(0));
    await page.focus('.redact-box[data-index="0"]');
    let before = (await state(page)).boxes[0];
    await page.keyboard.press('ArrowLeft');
    box = (await state(page)).boxes[0];
    near(box.left, before.left - STEP, 1e-5, 'ArrowLeft');
    await page.keyboard.press('Shift+ArrowRight');
    const wider = (await state(page)).boxes[0];
    near(wider.right - wider.left, box.right - box.left + STEP, 1e-5, 'Shift+ArrowRight wider');
    await page.keyboard.press('Control+ArrowDown');
    box = (await state(page)).boxes[0];
    near(box.top, wider.top + 10 * STEP, 1e-4, 'Ctrl+ArrowDown ten steps');
    await page.keyboard.press('Escape');
    eq((await state(page)).selected, -1, 'Escape lets it go');
    // Tab reaches the boxes; focusing one chooses it.
    await page.keyboard.press('Tab');
    eq((await state(page)).selected, 1, 'Tab to the next box chooses it');
    eq(await page.$eval('.redact-boxes', (g) => document.getElementById(g.getAttribute('aria-describedby')).textContent), fill(strings.redact_box_chosen, 2, 2), 'chosen said');
    // Delete removes it, and the focus goes on to the box left.
    await page.keyboard.press('Delete');
    let s = await state(page);
    eq(s.boxes.length, 1, 'Delete removes the box');
    eq(s.selected, 0, 'the next box takes the focus and is chosen');
    // Delete box leaves the page with the focus and no box chosen.
    await handle(page, (r) => { r.addBox({ page: 0, left: 0.1, top: 0.6, right: 0.2, bottom: 0.65 }); r.addBox({ page: 0, left: 0.1, top: 0.7, right: 0.2, bottom: 0.75 }); r.selectBox(0); });
    await page.click(stepButton('redact_delete_box'));
    s = await state(page);
    eq([s.boxes.length, s.selected], [2, -1], 'Delete box: one fewer, none chosen');
    eq(await page.evaluate(() => document.activeElement?.classList.contains('redact-boxes')), true, 'the page has the focus');
    // A double click on Delete box deletes the chosen box only.
    await handle(page, (r) => r.selectBox(0));
    await page.dblclick(stepButton('redact_delete_box'));
    s = await state(page);
    eq([s.boxes.length, s.selected], [1, -1], 'double click on Delete box deletes one box');
    // The Delete box button, on the last box of the page.
    await handle(page, (r) => r.selectBox(0));
    await page.click(stepButton('redact_delete_box'));
    s = await state(page);
    eq(s.boxes.length, 0, 'Delete box');
    eq(await page.evaluate(() => document.activeElement?.textContent.trim()), strings.redact_add_box, 'focus on Add box once none is left');
    // Page Down on the page changes the page.
    await page.click('.redact-actions button:has-text("' + strings.redact_add_box + '")');
    await page.keyboard.press('PageDown');
    await waitReady(page);
    eq((await state(page)).page, 1, 'Page Down');
    eq(await page.$eval('.redact-strip [aria-checked=true]', (n) => n.getAttribute('aria-label')), 'Page 2', 'strip follows');
    // The strip with the keyboard.
    await page.focus('.redact-strip [aria-checked=true]');
    await page.keyboard.press('End');
    await waitReady(page);
    eq((await state(page)).page, 3, 'End: last page');
    await page.keyboard.press('ArrowLeft');
    await waitReady(page);
    eq((await state(page)).page, 2, 'ArrowLeft: page before');
  }, { viewport: DESKTOP });
});

await test('quick taps act on the boxes as they are (RedactQuickTapsDeviceTest)', async () => {
  await withPage(async (page, url) => {
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    const A = R.clamp(R.makeBox(0, 0.15, 0.84, 0.55, 0.92));
    const B = R.clamp(R.makeBox(1, 0.1, 0.1, 0.5, 0.2));
    const C = R.clamp(R.makeBox(0, 0.5, 0.1, 0.9, 0.2));
    const setUp = async () => {
      await handle(page, (r) => r.clearBoxes());
      await handle(page, (r, boxes) => {
        for (const b of boxes) r.addBox(b);
        r.showPage(0);
        r.selectBox(0);
      }, [A, B, C]);
      await controlsShown(page);
    };
    // Delete box pressed twice before anything else: only the chosen box goes (B, out of sight on
    // page 2, would otherwise go too, and what it covers be left unredacted).
    await setUp();
    await page.evaluate((sel) => { const d = document.querySelector(sel); d.click(); d.click(); }, stepButton('redact_delete_box'));
    let s = await state(page);
    eq(s.boxes, [B, C], 'double Delete box');
    eq(s.selected, -1, 'none chosen');
    // Delete and a step together leave the other boxes alone.
    await setUp();
    await page.evaluate(([del, right]) => {
      const d = document.querySelector(del);
      const r = document.querySelector(right);
      d.click();
      r.click();
    }, [stepButton('redact_delete_box'), stepButton('redact_move_right')]);
    eq((await state(page)).boxes, [B, C], 'Delete and Move right');
    // Quick steps each move the chosen box.
    await setUp();
    await page.evaluate((sel) => { const r = document.querySelector(sel); r.click(); r.click(); }, stepButton('redact_move_right'));
    s = await state(page);
    near(s.boxes[0].left, A.left + 2 * R.STEP, 1e-4, 'two quick steps');
    eq(s.boxes.slice(1), [B, C], 'the others unchanged');
    // A real double tap on Delete box, as fingers do it.
    await setUp();
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), stepButton('redact_delete_box'));
    const del = await settled(page, stepButton('redact_delete_box'));
    const cdp = await page.context().newCDPSession(page);
    for (let i = 0; i < 2; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: del.x + del.width / 2, y: del.y + del.height / 2, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await cdp.detach();
    await page.waitForTimeout(400);
    s = await state(page);
    eq(s.boxes, [B, C], 'double tap on Delete box');
    eq(s.selected, -1, 'none chosen after a double tap');
    // Keys pressed quickly do the same.
    await setUp();
    await page.focus('.redact-box[data-index="0"]');
    await page.evaluate(() => {
      const b = document.activeElement;
      const key = (k) => b.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      key('Delete');
      key('Delete');
    });
    s = await state(page);
    eq(s.boxes.length, 1, 'two quick Deletes on the keyboard: one box each, the focused one each time');
    eq(s.boxes[0], B, 'B is left: C, the next box, took the focus and went second');
  }, { viewport: PHONE });
});

await test('Find text boxes every match, ignoring capitals and accents', async () => {
  await withPage(async (page, url) => {
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    await find(page, 'jane DOE');
    await snack(page, plural(strings.redact_found, 2));
    let s = await state(page);
    eq(s.boxes.map((b) => b.page), [0, 1], 'a box on pages 1 and 2');
    assert(covers(s.boxes[0], words.jane.box, 0.002), `covers "Jane Doe" on page 1: ${JSON.stringify(s.boxes[0])}`);
    assert(covers(s.boxes[1], words.jane2.box, 0.002), `covers "Jane Doe" on the turned page: ${JSON.stringify(s.boxes[1])}`);
    eq(s.searched, ['jane DOE'], 'kept as typed');
    eq(s.page, 0, 'the page showing has a match: it stays');
    eq(s.selected, -1, 'none chosen');
    eq(await page.$$eval('button.redact-box', (n) => n.length), 1, 'shown on the page');
    // The same again adds nothing.
    await find(page, 'jane doe', { enter: true });
    await snack(page, plural(strings.redact_found, 2));
    eq((await state(page)).boxes.length, 2, 'no box twice');
    eq((await state(page)).searched, ['jane DOE', 'jane doe'], 'both kept');
    // Accents don't matter.
    await find(page, 'CAFE noir');
    await snack(page, plural(strings.redact_found, 1));
    s = await state(page);
    eq(s.boxes.length, 3, 'Café Noir boxed');
    assert(covers(s.boxes[2], words.cafe.box, 0.002), 'covers Café Noir');
    // A match only on another page shows that page.
    await find(page, 'secret code 42');
    await snack(page, plural(strings.redact_found, 1));
    s = await state(page);
    eq(s.page, 2, 'the first page with matches shows');
    assert(covers(s.boxes[3], words.secret.box, 0.002), 'covers Secret Code on the cropped page');
    await waitReady(page);
    eq(await page.$eval('.redact-strip [aria-checked=true]', (n) => n.getAttribute('aria-label')), 'Page 3', 'strip shows page 3');
    // Nothing found.
    await find(page, 'zebra crossing');
    await snack(page, strings.redact_find_none);
    eq((await state(page)).boxes.length, 4, 'nothing added');
    // Remove all asks first; Cancel keeps them.
    await page.click('.redact-remove-all');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.textContent('dialog[open] .ui-dialog-title'), strings.redact_remove_all_title, 'question');
    eq(await page.textContent('dialog[open] .ui-dialog-body'), fill(strings.redact_remove_all_body.other, 4), 'how many');
    await page.click('dialog[open] button:has-text("' + common.cancel + '")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    eq((await state(page)).boxes.length, 4, 'kept');
    await page.click('.redact-remove-all');
    await page.click('dialog[open] button:has-text("' + strings.redact_remove_all + '")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    s = await state(page);
    eq([s.boxes.length, s.searched.length], [0, 0], 'boxes and searches gone');
    assert(await page.isDisabled('.ui-bottombar button'), 'Redact PDF off again');
    // One box: "The box will be removed."
    await handle(page, (r) => r.addBox({ page: 0, left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 }));
    await page.click('.redact-remove-all');
    eq(await page.textContent('dialog[open] .ui-dialog-body'), strings.redact_remove_all_body.one, 'one box');
    await page.keyboard.press('Escape');
    // Too many boxes.
    await handle(page, (r) => {
      for (let i = 1; i < 2000; i++) r.addBox({ page: 3, left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 });
    });
    eq((await state(page)).boxes.length, 2000, '2000 boxes');
    await dismissSnacks(page);
    await page.click('.redact-actions button:has-text("' + strings.redact_add_box + '")');
    await snack(page, fill(strings.redact_too_many, 2000));
    eq((await state(page)).boxes.length, 2000, 'no more');
  }, { viewport: PHONE });
});

await test('redacting: the boxed words are gone, the rest stays (pdf.js text and pixels)', async () => {
  await withPage(async (page, url) => {
    await openWithPicker(page, url, sample.bytes);
    // "Jane Doe" on pages 1 and 2 by Find text, "Secret Code 42" on the cropped page by hand.
    await find(page, 'Jane Doe');
    await snack(page, plural(strings.redact_found, 2));
    await page.click('.redact-strip [role=radio][aria-label="Page 3"]');
    await waitReady(page);
    await drawOver(page, words.secret.box, { margin: 6 });
    const s = await state(page);
    eq(s.boxes.length, 3, 'three boxes');
    await page.fill('.redact-tail input', 'For the press');
    const { name, bytes } = await redactAndDownload(page);
    eq(name, 'For the press.pdf', 'the name typed');
    const doc = await PDFDocument.load(bytes);
    eq(doc.getPageCount(), 4, 'every page kept');
    eq(doc.getPage(1).getRotation().angle, 90, 'turned page still turned');
    const crop = doc.getPage(2).getCropBox();
    eq([crop.x, crop.y, crop.width, crop.height], [100, 200, 400, 500], 'crop box kept');
    // Text: the pictured pages have none; the untouched page keeps its own.
    const texts = await runInPage(page, url, 'app/js/engine/redact.js', 'readPageTexts', { bytes });
    for (const i of [0, 1, 2]) eq(texts[i].trim(), '', `page ${i + 1} has no text left`);
    assert(texts[3].toLowerCase().includes('nothing to hide here'), `page 4 keeps its text: ${texts[3]}`);
    // Pixels: under the boxes black; the other words still there to read; blank paper white.
    const p1 = await measure(page, bytes, 0, [inner(words.jane.box), words.account.box, { left: 0.6, top: 0.85, right: 0.9, bottom: 0.95 }]);
    eq(p1.text.trim(), '', 'page 1: no text for pdf.js');
    assert(p1.areas[0].dark === p1.areas[0].total, `Jane Doe blacked out: ${JSON.stringify(p1.areas[0])}`);
    assert(p1.areas[1].dark > 0.03 * p1.areas[1].total && p1.areas[1].light > 0.3 * p1.areas[1].total, `Account line still readable: ${JSON.stringify(p1.areas[1])}`);
    assert(p1.areas[2].light === p1.areas[2].total, 'blank paper stays white');
    const p2 = await measure(page, bytes, 1, [inner(words.jane2.box), words.keep.box]);
    near(p2.width / p2.height, 842 / 595, 0.01, 'page 2 shown landscape');
    assert(p2.areas[0].dark === p2.areas[0].total, `Jane Doe blacked out on the turned page: ${JSON.stringify(p2.areas[0])}`);
    assert(p2.areas[1].dark > 0.03 * p2.areas[1].total && p2.areas[1].light > 0.3 * p2.areas[1].total, `"Keep this line" still there: ${JSON.stringify(p2.areas[1])}`);
    const p3 = await measure(page, bytes, 2, [inner(words.secret.box), words.visible.box]);
    near(p3.width / p3.height, 400 / 500, 0.01, 'page 3 keeps its crop');
    assert(p3.areas[0].dark === p3.areas[0].total, `Secret Code blacked out on the cropped page: ${JSON.stringify(p3.areas[0])}`);
    assert(p3.areas[1].dark > 0.03 * p3.areas[1].total, `"Visible words" still there: ${JSON.stringify(p3.areas[1])}`);
    const p4 = await measure(page, bytes, 3, [words.nothing.box]);
    assert(p4.text.includes('Nothing to hide here'), 'page 4 untouched');
    // Back to editing: the boxes are still there.
    await page.click('.ui-result .ui-topbar-nav');
    await page.waitForSelector('.redact-sheet');
    eq((await state(page)).boxes.length, 3, 'boxes kept');
    assert(await page.isEnabled('.ui-bottombar button'), 'Redact PDF on');
    eq(await handle(page, (r) => r.result()), null, 'the result is put away');
  }, { viewport: DESKTOP });
});

await test('result step, Back, Start over, leaving and removing the PDF', async () => {
  await withPage(async (page, url) => {
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    await handle(page, (r) => r.addBox({ page: 0, left: 0.1, top: 0.1, right: 0.3, bottom: 0.15 }));
    await page.click('.ui-bottombar button');
    await page.waitForSelector('.ui-result-heading', { timeout: 60000 });
    eq(await page.textContent('.ui-result-name'), 'Sample report_redacted.pdf', 'default name');
    assert(!(await page.textContent('.ui-result-content')).includes(plural(common.pdf_password_removed, 1)), 'no password note');
    // The browser's Back goes back to editing.
    await page.goBack();
    await page.waitForSelector('.redact-sheet.is-ready');
    eq((await state(page)).boxes.length, 1, 'boxes kept');
    eq(await page.evaluate(() => location.hash), '#/tool/redact', 'still on the tool');
    // Start over asks while the PDF isn't saved, then goes back to Choose PDF.
    await page.click('.ui-bottombar button');
    await page.waitForSelector('.ui-result-heading', { timeout: 60000 });
    await page.click('.ui-result-startover');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.textContent('dialog[open] .ui-dialog-title'), common.start_over_title, 'Start over?');
    await page.click('dialog[open] .ui-dialog-actions button:last-child');
    await page.waitForSelector('.redact-page .ui-empty');
    eq((await state(page)).pageCount, 0, 'no PDF');
    await page.waitForTimeout(300);
    eq(await page.evaluate(() => location.hash), '#/tool/redact', 'on the tool');
    // Leaving with boxes asks first.
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    await handle(page, (r) => r.addBox({ page: 0, left: 0.1, top: 0.1, right: 0.3, bottom: 0.15 }));
    await page.click('.ui-topbar-nav');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.textContent('dialog[open] .ui-dialog-title'), common.tool_discard_title, 'Discard your changes?');
    await page.click('dialog[open] button:has-text("' + common.keep + '")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    assert(await page.isVisible('.redact-sheet'), 'kept');
    // Removing the PDF asks too.
    await page.click('.ui-file-card .ui-icon-btn');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    await page.click('dialog[open] button:has-text("' + common.discard + '")');
    await page.waitForSelector('.redact-page .ui-empty');
    eq((await state(page)).boxes.length, 0, 'boxes gone with the PDF');
    // Without boxes, removing doesn't ask.
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    await page.click('.ui-file-card .ui-icon-btn');
    await page.waitForSelector('.redact-page .ui-empty');
    eq(await page.$$eval('dialog[open]', (d) => d.length), 0, 'no question');
  }, { viewport: PHONE });
});

await test('damaged files and locked PDFs', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.redact-page .ui-empty')]);
    await chooser.setFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nthis is not really a PDF at all\n%%EOF') });
    await snack(page, common.pdf_import_failed);
    assert(await page.isVisible('.redact-page .ui-empty'), 'still Choose PDF');
    // Dropped files: what isn't a PDF is left out and named; the PDF opens.
    await dropFiles(page, [
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('hello') },
      { name: 'Sample report.pdf', type: 'application/pdf', bytes: sample.bytes },
    ]);
    await snack(page, fill(common.share_unsupported.one, 1, 'notes.txt'));
    await waitReady(page);
    eq(await page.textContent('.ui-file-name'), 'Sample report.pdf', 'the dropped PDF opened');
    await page.click('.ui-file-card .ui-icon-btn');
    await page.waitForSelector('.redact-page .ui-empty');
    // A PDF with a password: asked for, then the new PDF has none.
    const locked = await samplePdf({ pages: 1, password: 'secret' });
    await openHanded(page, url, locked.bytes, 'Locked.pdf');
    await page.waitForSelector('dialog[open] input[type=password]');
    await page.fill('dialog[open] input[type=password]', 'wrong');
    await page.click('dialog[open] .ui-dialog-actions button:last-child');
    await page.waitForSelector('dialog[open] .ui-field.is-error');
    await page.fill('dialog[open] input[type=password]', 'secret');
    await page.click('dialog[open] .ui-dialog-actions button:last-child');
    await waitReady(page);
    await find(page, 'jane');
    await snack(page, plural(strings.redact_found, 1));
    await page.click('.ui-bottombar button');
    await page.waitForSelector('.ui-result-heading', { timeout: 60000 });
    assert((await page.textContent('.ui-result-content')).includes(plural(common.pdf_password_removed, 1)), 'says the new PDF has no password');
    const out = await handle(page, (r) => Array.from(r.result().bytes));
    const doc = await PDFDocument.load(new Uint8Array(out));
    eq(doc.getPageCount(), 1, 'opens without a password');
    // Handed over with its password already given (Choose a tool): not asked again.
    await openHanded(page, url, locked.bytes, 'Locked.pdf', { password: 'secret' });
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await waitReady(page);
  }, { viewport: PHONE });
});

await test('the keyboard keeps its place; one main landmark; a failure is said once the progress dialog has gone (desktop)', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url);
    const active = () => page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a?.tagName, cls: a?.className ?? '', inScreen: !!a?.closest('.screen[data-tool="redact"]') };
    });
    // One main landmark, the screen's content, where Skip to content goes.
    eq(await page.$$eval('#app .screen[data-tool="redact"] main, #app .screen[data-tool="redact"] [role="main"]', (m) => m.map((n) => n.className)), ['page redact-page'], 'one main landmark');
    eq(await page.$eval('#app .screen[data-tool="redact"] [data-main]', (n) => n.tagName), 'MAIN', 'it is the [data-main] element');
    await page.focus('.skip-link');
    await page.keyboard.press('Enter');
    assert((await active()).cls.includes('redact-page'), `Skip to content focuses the main landmark: ${JSON.stringify(await active())}`);
    await page.keyboard.press('Tab');
    assert((await active()).cls.includes('ui-empty'), `the next Tab is Choose PDF, past the top bar: ${JSON.stringify(await active())}`);

    // Choose PDF by keyboard, then the password dialog cancelled: the focus is back on Choose PDF.
    const locked = await samplePdf({ pages: 1, password: 'secret' });
    await page.focus('.redact-page .ui-empty');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await chooser.setFiles({ name: 'Locked.pdf', mimeType: 'application/pdf', buffer: Buffer.from(locked.bytes) });
    await page.waitForSelector('dialog[open] input[type=password]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.waitForFunction(() => !document.querySelector('.redact-page .ui-empty[aria-disabled]'));
    const back = await active();
    assert(back.cls.includes('ui-empty') && back.inScreen, `cancelled: the focus is on Choose PDF, not ${back.tag}`);

    // Chosen by keyboard: the PDF's card takes the focus from Choose PDF, which has gone.
    const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await chooser2.setFiles({ name: 'Sample report.pdf', mimeType: 'application/pdf', buffer: Buffer.from(sample.bytes) });
    await waitReady(page);
    const chosen = await active();
    assert(chosen.cls.includes('ui-file-card') && chosen.inScreen, `chosen: the focus is on the PDF's card, not ${chosen.tag}.${chosen.cls}`);

    // Redact PDF by keyboard: the result's heading has the focus once the progress dialog has gone.
    await handle(page, (r) => r.addBox({ page: 0, left: 0.1, top: 0.1, right: 0.3, bottom: 0.15 }));
    await page.focus('.ui-bottombar button');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ui-result-heading', { timeout: 60000 });
    await page.waitForFunction(() => document.activeElement?.classList.contains('ui-result-heading'), null, { timeout: 5000 })
      .catch(async () => { throw new Error(`the result's heading has no focus: ${JSON.stringify(await active())}`); });
    await page.click('.ui-result .ui-topbar-nav');
    await page.waitForSelector('.redact-sheet');
    await handle(page, (r) => r.clearBoxes());
    await page.click('.ui-file-card .ui-icon-btn');
    await page.waitForSelector('.redact-page .ui-empty');

    // A PDF pdf.js shows but pdf-lib can't read (its header gone): Redact PDF fails. The message
    // comes once the progress dialog has gone, when the rest of the screen can be heard again.
    const headerless = Buffer.from(sample.bytes).subarray(Buffer.from(sample.bytes).indexOf('\n') + 1);
    await page.evaluate(() => {
      window.__said = [];
      new MutationObserver(() => {
        const modal = !!document.querySelector('dialog[open]');
        const announcer = document.getElementById('announcer');
        if (announcer?.textContent) window.__said.push({ text: announcer.textContent, modal, where: 'announcer' });
        for (const n of document.querySelectorAll('.ui-snackbar-text')) window.__said.push({ text: n.textContent, modal, where: 'snackbar' });
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const [chooser3] = await Promise.all([page.waitForEvent('filechooser'), page.click('.redact-page .ui-empty')]);
    await chooser3.setFiles({ name: 'Headerless.pdf', mimeType: 'application/pdf', buffer: headerless });
    await waitReady(page);
    await handle(page, (r) => r.addBox({ page: 0, left: 0.1, top: 0.1, right: 0.3, bottom: 0.15 }));
    await page.click('.ui-bottombar button');
    await snack(page, common.pdf_import_failed);
    const said = (await page.evaluate(() => window.__said)).filter((s) => s.text === common.pdf_import_failed);
    assert(said.some((s) => s.where === 'snackbar'), 'the snackbar showed');
    assert(said.every((s) => !s.modal), `said only once the dialog had gone: ${JSON.stringify(said)}`);
    assert(said.some((s) => s.where === 'announcer'), `the announcer said it: ${JSON.stringify(said)}`);
  }, { viewport: { width: 1280, height: 800 } });
});

for (const browser of quick ? ['chromium'] : ['chromium', 'firefox', 'webkit']) {
  await test(`${browser}: leaving while a password is asked for closes the dialog; a reload on the result step`, async () => {
    await withPage(async (page, url) => {
      const locked = await samplePdf({ pages: 1, password: 'secret' });
      await page.goto(url + 'app/#/');
      await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
      await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
      // Handed over from Home, as Choose a tool does.
      const handOver = () => page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const { navigate } = await import('./js/core/router.js');
        await navigate('/tool/redact', { files: [{ name: 'Locked.pdf', type: 'application/pdf', size: bytes.length, lastModified: 0, bytes }] });
      }, Buffer.from(locked.bytes).toString('base64'));
      await handOver();
      await page.waitForSelector('dialog[open] input[type=password]');
      // The browser's Back while the password is asked for closes the dialog first, as Android's
      // Back does: Redact PDF stays, without the PDF.
      await page.goBack();
      await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
      await page.waitForSelector('#app > .screen[data-tool="redact"]:not([aria-busy]) .redact-page .ui-empty:not([aria-disabled])', { timeout: 5000 });
      eq((await state(page)).pageCount, 0, 'no PDF opened');
      // Leaving while the password is asked for (to Home): the dialog goes with the screen.
      await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/', { replace: true }));
      await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
      await handOver();
      await page.waitForSelector('dialog[open] input[type=password]');
      await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/'));
      await page.waitForSelector('.screen[data-route="home"]:not([aria-busy])');
      await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
      await page.waitForTimeout(300);
      eq(await page.locator('.screen[data-tool="redact"]').count(), 0, 'Redact PDF has gone');
      eq(await page.$$eval('dialog[open]', (d) => d.length), 0, 'the password dialog went with it');
      // A reload on the result step: the result is gone, and so is its step.
      await openHanded(page, url, sample.bytes);
      await waitReady(page);
      await handle(page, (r) => r.addBox({ page: 0, left: 0.1, top: 0.1, right: 0.3, bottom: 0.15 }));
      await page.click('.ui-bottombar button');
      await page.waitForSelector('.ui-result-heading', { timeout: 60000 });
      eq(await page.evaluate(() => history.state?.step), 'result', 'the result is a step');
      await page.reload();
      await page.waitForSelector('#app > .screen[data-tool="redact"]:not([aria-busy]) .redact-page .ui-empty', { timeout: 20000 });
      await page.waitForFunction(() => (history.state?.step ?? null) === null, null, { timeout: 5000 });
      eq(await page.evaluate(() => location.hash), '#/tool/redact', 'still on Redact PDF');
    }, { browser, viewport: PHONE });
  });
}

await test('zoom: buttons, Ctrl and the wheel, two fingers', async () => {
  await withPage(async (page, url) => {
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    const fit = await sheetBox(page);
    eq(await page.textContent('.redact-zoom-level'), '100%', '100% at first');
    assert(await page.isDisabled('.redact-zoombar [aria-label="' + strings.web_redact_zoom_out + '"]'), 'Zoom out off at 100%');
    await page.click('.redact-zoombar [aria-label="' + strings.web_redact_zoom_in + '"]');
    eq(await page.textContent('.redact-zoom-level'), '125%', 'Zoom in');
    const zoomed = await page.locator('.redact-sheet').boundingBox();
    near(zoomed.width, fit.width * 1.25, 1, 'the page grows');
    // A box drawn while zoomed lands on the same words.
    await page.evaluate(() => { document.querySelector('.redact-viewport').scrollTop = 0; document.querySelector('.redact-viewport').scrollLeft = 0; });
    await drawOver(page, words.jane.box);
    const s = await state(page);
    assert(covers(s.boxes[0], words.jane.box), `zoomed box covers Jane Doe: ${JSON.stringify(s.boxes[0])}`);
    near(s.boxes[0].left, words.jane.box.left - 4 / zoomed.width, 0.003, 'zoomed box where drawn');
    // The page is drawn again, sharper.
    await page.waitForFunction((w) => document.querySelector('.redact-picture')?.width >= w * 1.2, fit.width, { timeout: 5000 });
    // Ctrl and the wheel.
    const r = await sheetBox(page);
    await page.mouse.move(r.x + 50, r.y + 50);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    const z = await handle(page, (h) => h.zoom());
    assert(z > 1.5, `Ctrl+wheel zooms in: ${z}`);
    // Keys: 0 fits again.
    await page.focus('button.redact-box');
    await page.keyboard.press('0');
    eq(await page.textContent('.redact-zoom-level'), '100%', '0 fits the page');
    await page.keyboard.press('+');
    eq(await page.textContent('.redact-zoom-level'), '125%', '+ zooms in');
    await page.click('.redact-zoombar [aria-label="' + strings.web_redact_zoom_fit + '"]');
    eq(await page.textContent('.redact-zoom-level'), '100%', 'Fit page');
  }, { viewport: DESKTOP });
  // Two fingers on a phone zoom without drawing.
  await withPage(async (page, url) => {
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    const r = await sheetBox(page);
    await pinch(page, at(r, 0.5, 0.5), 60, 180);
    const z = await handle(page, (h) => h.zoom());
    assert(z > 2, `pinched to ${z}`);
    eq((await state(page)).boxes.length, 0, 'no box drawn by the fingers');
    assert(await page.evaluate(() => document.querySelector('.redact-viewport').scrollWidth > document.querySelector('.redact-viewport').clientWidth), 'the zoomed page scrolls inside its frame');
    assert(await page.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth), 'the screen does not scroll sideways');
    // One finger still draws, where the page shows.
    const v = await page.locator('.redact-viewport').boundingBox();
    await touchDrag(page, { x: v.x + 40, y: v.y + 40 }, { x: v.x + 140, y: v.y + 100 });
    const s = await state(page);
    eq(s.boxes.length, 1, 'drawn while zoomed');
    const sr = await page.locator('.redact-sheet').boundingBox();
    near(s.boxes[0].left, (v.x + 40 - sr.x) / sr.width, 0.003, 'where the finger was');
  }, { viewport: PHONE });
});

await test('a long PDF stays light: pictures only near the pages in view', async () => {
  const long = await samplePdf({ pages: 60 });
  await withPage(async (page, url) => {
    await openHanded(page, url, long.bytes, 'Long.pdf');
    await waitReady(page);
    await page.waitForFunction(() => document.querySelectorAll('.redact-strip-thumb canvas').length >= 3, null, { timeout: 15000 });
    await page.waitForTimeout(800);
    const drawn = await page.$$eval('.redact-strip-thumb canvas', (n) => n.length);
    assert(drawn < 30, `only the pages near the strip's view are drawn: ${drawn}`);
    await page.focus('.redact-strip [aria-checked=true]');
    await page.keyboard.press('End');
    await waitReady(page);
    eq((await state(page)).page, 59, 'last page');
    await page.waitForFunction(() => document.querySelector('.redact-strip [aria-label="Page 60"] canvas'), null, { timeout: 15000 });
    const near0 = await page.$eval('.redact-strip [aria-label="Page 1"]', (n) => !!n.querySelector('canvas'));
    assert(!near0, 'page 1 let go once far away');
    await page.focus('.redact-strip [aria-checked=true]');
    await page.keyboard.press('Home');
    await waitReady(page);
    // A search can be stopped: Cancel takes the search button's place while it runs.
    await page.fill('.redact-find input', 'filler page 33');
    const during = await page.evaluate(() => {
      document.querySelector('.redact-find-button:not([hidden])').click();
      const stop = document.querySelector('.redact-find-button:not([hidden])');
      const seen = { label: stop.getAttribute('aria-label'), bar: !document.querySelector('.redact-find-progress').hidden };
      stop.click();
      return seen;
    });
    eq([during.label, during.bar], [common.cancel, true], 'Cancel and a bar while searching');
    await page.waitForTimeout(1500);
    const st = await state(page);
    eq([st.finding, st.boxes.length, st.searched.length], [false, 0, 0], 'stopped: nothing found or kept');
    eq(await page.$$eval('.ui-snackbar', (n) => n.length), 0, 'and nothing said');
    eq(await page.getAttribute('.redact-find-button:not([hidden])', 'aria-label'), strings.redact_find_action, 'Find is back');
    await find(page, 'filler page 33');
    await snack(page, plural(strings.redact_found, 1));
    eq((await state(page)).page, 32, 'found on page 33, shown');
    await page.waitForFunction(() => document.querySelector('.redact-strip [aria-label="Page 33"]')?.getAttribute('aria-checked') === 'true');
  }, { viewport: PHONE });
});

await test('320 px wide: nothing scrolls sideways', async () => {
  await withPage(async (page, url) => {
    await openHanded(page, url, sample.bytes);
    await waitReady(page);
    await handle(page, (r) => r.addBox({ page: 0, left: 0.1, top: 0.1, right: 0.3, bottom: 0.15 }));
    await controlsShown(page);
    assert(await page.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth), 'no sideways scroll');
    const r = await sheetBox(page);
    assert(r.width <= 280.5, `the page fits: ${r.width}`);
  }, { viewport: { width: 320, height: 640 } });
});

for (const browser of quick ? [] : ['firefox', 'webkit']) {
  await test(`${browser}: draw, find, redact`, async () => {
    await withPage(async (page, url) => {
      // Firefox through Playwright says the file picker was cancelled before giving the file, so
      // there the PDF is dropped on Choose PDF instead (also how a computer's user may give it).
      if (browser === 'firefox') {
        await openApp(page, url);
        await dropFiles(page, [{ name: 'Sample report.pdf', type: 'application/pdf', bytes: sample.bytes }]);
        await waitReady(page);
      } else {
        await openWithPicker(page, url, sample.bytes);
      }
      await drawOver(page, words.account.box);
      eq((await state(page)).boxes.length, 1, 'drawn with the mouse');
      await find(page, 'jane doe');
      await snack(page, plural(strings.redact_found, 2));
      await page.click('.ui-bottombar button');
      await page.waitForSelector('.ui-result-heading', { timeout: 60000 });
      const out = new Uint8Array(await handle(page, (r) => Array.from(r.result().bytes)));
      const p1 = await measure(page, out, 0, [inner(words.account.box), inner(words.jane.box), words.cafe.box]);
      eq(p1.text.trim(), '', 'page 1 has no text');
      assert(p1.areas[0].dark === p1.areas[0].total && p1.areas[1].dark === p1.areas[1].total, `boxed words black: ${JSON.stringify(p1.areas)}`);
      assert(p1.areas[2].dark > 0.03 * p1.areas[2].total && p1.areas[2].light > 0.3 * p1.areas[2].total, 'Café Noir still there');
      const p4 = await measure(page, out, 3, []);
      assert(p4.text.includes('Nothing to hide here'), 'page 4 untouched');
    }, { browser, viewport: browser === 'webkit' ? PHONE : DESKTOP });
  });
}

if (!quick) {
  await test('screenshots: phone and desktop, light and dark', async () => {
    for (const [label, viewport] of [['phone', PHONE], ['desktop', DESKTOP]]) {
      for (const scheme of ['light', 'dark']) {
        await withPage(async (page, url) => {
          await page.emulateMedia({ colorScheme: scheme });
          await openApp(page, url);
          if (scheme === 'light') await page.screenshot({ path: `${outputDir}/redact-ui-${label}-empty.png` });
          await openHanded(page, url, sample.bytes);
          await waitReady(page);
          await find(page, 'jane doe');
          await snack(page, plural(strings.redact_found, 2));
          await drawOver(page, words.account.box);
          await controlsShown(page);
          await page.waitForTimeout(400);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: `${outputDir}/redact-ui-${label}-${scheme}.png` });
          if (label === 'phone') {
            await page.evaluate(() => document.querySelector('.redact-controls').scrollIntoView({ block: 'center' }));
            await page.waitForTimeout(200);
            await page.screenshot({ path: `${outputDir}/redact-ui-${label}-${scheme}-controls.png` });
          } else {
            await page.click('.redact-zoombar [aria-label="' + strings.web_redact_zoom_in + '"]');
            await page.click('.redact-zoombar [aria-label="' + strings.web_redact_zoom_in + '"]');
            await page.waitForTimeout(600);
            await page.screenshot({ path: `${outputDir}/redact-ui-${label}-${scheme}-zoomed.png` });
          }
        }, { viewport });
      }
    }
  });
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
