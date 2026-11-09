// Scan document and Images to PDF (js/tools/images/): the editor, Crop page, Filters, the Create PDF
// sheet and the result, driven as a person would: by touch at phone size (360 px) and by mouse,
// keyboard, drag-and-drop and paste at desktop size (1366 px), in Chromium, with a shorter run in
// Firefox and WebKit. The PDFs made are read back: page counts and sizes, how each image is stored,
// what the pages show (rendered and sampled), names, and the text OCR added (pdf.js).
//
//   node tests/images-ui.test.mjs            everything
//   node tests/images-ui.test.mjs --quick    Chromium only, no screenshots of every screen in dark
//   node tests/images-ui.test.mjs --only scan   the tests whose name has "scan"
//
// Screenshots go to .tmp/images-ui/screens/ to be looked at.
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { withPage, assert, root, fixturesDir } from './harness.mjs';
import { pagePhoto, PAGE_PHOTO } from './fixtures/images/page-photos.mjs';
import { PDFDocument, PDFName } from '../site/app/vendor/pdf-lib/pdf-lib.esm.min.js';

const QUICK = process.argv.includes('--quick');
const shots = join(root, '.tmp', 'images-ui', 'screens');
await mkdir(shots, { recursive: true });

const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 768 };

const started = Date.now();
let checks = 0;
function ok(condition, what) {
  assert(condition, what);
  checks++;
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what}: expected ${e}, got ${a}`);
  checks++;
}
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
async function test(name, fn) {
  if (only && !name.includes(only)) return;
  const t0 = Date.now();
  await fn();
  console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------------------------------------------------------------------------------------------
// Fixtures

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A PNG of RGBA pixels. */
function png(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A plain picture `w` × `h` of one colour, with a darker band near its top (to tell up from down). */
function plain(w, h, [r, g, b]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const y = Math.floor(i / w);
    const band = y < h * 0.15;
    px[4 * i] = band ? r / 3 : r;
    px[4 * i + 1] = band ? g / 3 : g;
    px[4 * i + 2] = band ? b / 3 : b;
    px[4 * i + 3] = 255;
  }
  return png(px, w, h);
}

const photo = png(pagePhoto(), PAGE_PHOTO.PHOTO_WIDTH, PAGE_PHOTO.PHOTO_HEIGHT);
const asPng = (name, buffer) => ({ name, mimeType: 'image/png', buffer });
const red = plain(300, 400, [220, 40, 40]);
const green = plain(300, 400, [40, 170, 60]);
const blue = plain(400, 300, [40, 60, 220]);
const fixture = (name) => readFile(join(fixturesDir, 'images', name));

// The marks at the page's corners on the page photo (PagePhotos.kt), clockwise from top-left.
const MARKS = PAGE_PHOTO.MARKS;
const near = (c, want, tolerance = 60) => c.every((v, i) => Math.abs(v - want[i]) <= tolerance);

// ---------------------------------------------------------------------------------------------
// Reading PDFs back

/** Each page's size and how its image is stored (pdf-lib). */
async function structure(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    const im = p.node.Resources().lookup(PDFName.of('XObject')).lookup(PDFName.of('Im0'));
    const get = (k) => im.dict.lookup(PDFName.of(k))?.toString() ?? null;
    return {
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
      filter: get('Filter'),
      colorSpace: get('ColorSpace'),
      bits: Number(get('BitsPerComponent')),
      pixels: [Number(get('Width')), Number(get('Height'))],
    };
  });
  return { title: doc.getTitle(), producer: doc.getProducer(), pages };
}

/** pdf.js's text of each page, and colours sampled at fractions of a page rendered in the browser. */
async function inspect(page, bytes, { pageIndex = 0, samples = [] } = {}) {
  return page.evaluate(async ({ b64, pageIndex, samples }) => {
    const { openPdfJs } = await import(new URL('js/lib/pdfjs.js', location.href).href);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await openPdfJs(data);
    const texts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const content = await p.getTextContent();
      texts.push(content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
    }
    const p = await doc.getPage(pageIndex + 1);
    const base = p.getViewport({ scale: 1 });
    const viewport = p.getViewport({ scale: 500 / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await p.render({ canvas, viewport }).promise;
    const g = canvas.getContext('2d');
    const colors = samples.map(([x, y]) => Array.from(g.getImageData(Math.min(canvas.width - 1, Math.floor(x * canvas.width)), Math.min(canvas.height - 1, Math.floor(y * canvas.height)), 1, 1).data.slice(0, 3)));
    await doc.loadingTask.destroy();
    return { pages: doc.numPages, texts, colors };
  }, { b64: Buffer.from(bytes).toString('base64'), pageIndex, samples });
}

// ---------------------------------------------------------------------------------------------
// Driving the app

async function openApp(page, url, hash) {
  await page.goto(url + 'app/' + hash);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  await page.waitForSelector('.screen:not([aria-busy])', { timeout: 20000 });
}

async function choose(page, selector, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(selector).first().click()]);
  await chooser.setFiles(files);
}

async function pickFromMenu(page, anchor, label, files) {
  await page.locator(anchor).first().click();
  await choose(page, `.ui-menu-item:has-text("${label}")`, files);
}

/** The pages' names in order. */
const names = (page) => page.$$eval('.images-card .images-card-name .ui-visually-hidden', (els) => els.map((e) => e.textContent));
const handleLabels = (page) => page.$$eval('.images-card-handle', (els) => els.map((e) => e.getAttribute('aria-label')));

/** Waits until `n` pages show and nothing is being added or cropped. */
async function settled(page, n) {
  await page.waitForFunction((n) => document.querySelectorAll('.images-card').length === n &&
    document.querySelector('.images-import-progress')?.hidden !== false &&
    !document.querySelector('.images-card-spinner:not([hidden])'), n, { timeout: 60000 });
}

/** Waits until every page preview shows its picture. */
async function previewsDrawn(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.images-preview-image')].every((b) => b.classList.contains('has-picture')), null, { timeout: 30000 });
}

const snacks = (page) => page.$$eval('.ui-snackbar .ui-snackbar-text', (els) => els.map((e) => e.textContent));
async function snackWith(page, text) {
  await page.waitForFunction((t) => [...document.querySelectorAll('.ui-snackbar .ui-snackbar-text')].some((e) => e.textContent.includes(t)), text, { timeout: 30000 });
  checks++;
}
async function clearSnacks(page) {
  await page.evaluate(() => document.querySelectorAll('.ui-snackbar').forEach((n) => n.dismiss?.()));
  await page.waitForTimeout(250);
}

/** Waits for the crop step with its picture shown; returns the subtitle. */
async function cropReady(page) {
  await page.waitForSelector('.images-crop-step', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.images-crop-spinner')?.hidden === true, null, { timeout: 30000 });
  await page.waitForTimeout(350);
  return page.$eval('.images-crop .ui-topbar-subtitle', (e) => (e.hidden ? null : e.textContent));
}

/** Waits for Filters with the page and the looks' samples made. */
async function filtersReady(page) {
  await page.waitForSelector('.images-filter-step', { timeout: 30000 });
  await page.waitForFunction(() => {
    const area = document.querySelector('.images-filter-area');
    const canvas = document.querySelector('.images-filter-canvas');
    const samples = [...document.querySelectorAll('.images-look-canvas')];
    return area?.getAttribute('aria-busy') === 'false' && canvas.width > 0 && samples.every((c) => c.width > 0);
  }, null, { timeout: 60000 });
  await page.waitForTimeout(250);
}

const stepButton = (page, label) => page.locator(`.images-step-buttons .ui-btn:has-text("${label}")`);
const hintText = (page) => page.$eval('.images-crop-hint-text:not(.images-crop-hint-spare)', (e) => e.textContent);
const chosenLook = (page) => page.$eval('.images-look[aria-checked="true"]', (e) => e.dataset.look);
const handleBox = async (page, i) => {
  const b = await page.locator('.images-crop-handle').nth(i).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

async function touch(page) {
  const client = await page.context().newCDPSession(page);
  const send = (type, x, y) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  return {
    async drag(from, to, { hold = 0, steps = 12 } = {}) {
      await send('touchStart', from.x, from.y);
      if (hold) await page.waitForTimeout(hold);
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
        await page.waitForTimeout(20);
      }
      await page.waitForTimeout(60);
      await send('touchEnd');
    },
    detach: () => client.detach(),
  };
}

async function mouseDrag(page, from, to, steps = 15) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

const centre = async (locator) => {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Images dropped on the editor ('drop') or pasted ('paste'), as [name, bytes] PNGs. */
async function put(page, kind, files) {
  await page.evaluate(({ kind, files }) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    if (kind === 'drop') {
      const main = document.querySelector('.images-main');
      main.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      main.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    } else {
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  }, { kind, files: files.map(([name, buf]) => ({ name, type: 'image/png', b64: Buffer.from(buf).toString('base64') })) });
}

async function openSheet(page) {
  await page.locator('.images-convert-button').click();
  await page.waitForSelector('dialog[open] .images-sheet', { timeout: 10000 });
  await page.waitForTimeout(300);
}

/** Clicks Create in the sheet and waits for the result screen. */
async function create(page) {
  await page.locator('dialog[open] .images-create-button').click();
  await page.waitForSelector('.ui-result', { timeout: 180000 });
  await page.waitForTimeout(400);
}

/** Saves the result's files to Downloads; returns { name, bytes } for each. */
async function saveAll(page, count) {
  const got = [];
  const each = new Promise((resolve) => {
    const on = async (d) => {
      got.push({ name: d.suggestedFilename(), bytes: new Uint8Array(await readFile(await d.path())) });
      if (got.length === count) { page.off('download', on); resolve(); }
    };
    page.on('download', on);
  });
  await page.locator('.ui-result button:has-text("Save to Downloads")').first().click();
  await each;
  return got;
}

async function shot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, name + '.png') });
}

/** Screenshots of what shows, light then dark (the app follows the system). */
async function shots2(page, name) {
  await shot(page, name + '-light');
  if (QUICK) return;
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, name + '-dark');
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Nothing scrolls sideways. */
async function noSidewaysScroll(page, what) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 1, `${what}: nothing scrolls sideways (${over} px)`);
}

// ---------------------------------------------------------------------------------------------
// The editor at phone size: adding, previews, sorting, moving by touch and keyboard, turning,
// removing, the layout chips, Remove all.

await test('editor on a phone: add, sort, reorder by touch and keyboard, rotate, remove, options', () => withPage(async (page, url) => {
  await openApp(page, url, '#/tool/images');
  eq(await page.$eval('.images-editor h1', (e) => e.textContent), 'Images to PDF', 'title');
  eq(await page.$eval('.images-empty-title', (e) => e.textContent), 'Turn images into a PDF', 'empty title');
  ok((await page.$eval('.images-empty-body', (e) => e.textContent)).includes('on this device'), 'web wording of the empty screen');
  ok(await page.$eval('.images-bottombar', (e) => e.hidden), 'no bottom bar before the first image');
  await shots2(page, 'phone-empty');
  await noSidewaysScroll(page, 'empty editor');

  // Photos: three images and a file that isn't one.
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Photos")', [
    asPng('IMG_10.png', red), asPng('IMG_2.png', green), asPng('IMG_1.png', blue),
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
  ]);
  await settled(page, 3);
  await snackWith(page, 'Skipped 1 file: only JPG, PNG, HEIC, AVIF, WebP, BMP and GIF images are supported.');
  eq(await names(page), ['IMG_10.png', 'IMG_2.png', 'IMG_1.png'], 'pages in the order picked');
  eq(await page.$eval('.images-editor .ui-topbar-subtitle', (e) => e.textContent), '3 images', 'image count');
  eq(await page.$eval('.images-reorder-hint', (e) => e.textContent), 'Long-press a page and drag to reorder', 'reorder hint on a phone');
  await previewsDrawn(page);
  // A4 portrait by default: the preview page is A4-shaped, the landscape image fitted across it.
  const ratio = await page.$eval('.images-card:nth-child(3) .images-preview-page', (e) => e.getBoundingClientRect().width / e.getBoundingClientRect().height);
  ok(Math.abs(ratio - 210 / 297) < 0.02, `A4 page preview (${ratio})`);
  const box = await page.$eval('.images-card:nth-child(3) .images-preview-image', (e) => e.style.height);
  ok(parseFloat(box) < 60, 'a landscape image is fitted across a portrait page');
  await shots2(page, 'phone-editor');
  await noSidewaysScroll(page, 'editor');

  // Sort: natural order, its reverse, and reversing the order.
  const sortBy = async (label) => {
    await page.locator('.images-editor .ui-topbar [aria-label="Sort"]').click();
    await page.locator(`.ui-menu-item:has-text("${label}")`).click();
    await page.waitForTimeout(150);
  };
  await sortBy('Name (A to Z)');
  eq(await names(page), ['IMG_1.png', 'IMG_2.png', 'IMG_10.png'], 'sorted A to Z (natural order)');
  await sortBy('Name (Z to A)');
  eq(await names(page), ['IMG_10.png', 'IMG_2.png', 'IMG_1.png'], 'sorted Z to A');
  await sortBy('Reverse order');
  eq(await names(page), ['IMG_1.png', 'IMG_2.png', 'IMG_10.png'], 'reversed');

  // A long press and drag moves a page; a quick swipe doesn't.
  const fingers = await touch(page);
  const first = await centre(page.locator('.images-card-handle').nth(0));
  const third = await centre(page.locator('.images-card').nth(2).locator('.images-card-handle'));
  await fingers.drag(first, { x: first.x, y: first.y + 40 }, { hold: 0, steps: 4 });
  await page.waitForTimeout(200);
  eq(await names(page), ['IMG_1.png', 'IMG_2.png', 'IMG_10.png'], 'a swipe moves nothing');
  await fingers.drag(first, third, { hold: 650, steps: 16 });
  await page.waitForTimeout(500);
  eq(await names(page), ['IMG_2.png', 'IMG_10.png', 'IMG_1.png'], 'long-press and drag moved the first page last');
  await fingers.detach();

  // Ctrl + arrow keys move the focused page, and say so.
  await page.locator('.images-card-handle').nth(2).focus();
  await page.keyboard.press('Control+ArrowLeft');
  await page.waitForTimeout(200);
  eq(await names(page), ['IMG_2.png', 'IMG_1.png', 'IMG_10.png'], 'Ctrl+Left moved the page earlier');
  await page.waitForFunction(() => document.querySelector('#announcer')?.textContent === 'Moved to place 2 of 3');
  ok(await page.evaluate(() => document.activeElement.closest('.images-card') === document.querySelectorAll('.images-card')[1]), 'the moved page keeps the focus');
  // Its Move earlier button, for screen readers.
  await page.locator('.images-card').nth(1).locator('[aria-label="Move page 2 earlier"]').focus();
  await page.waitForTimeout(250);
  ok(await page.$eval('.images-card:nth-child(2) .images-card-moves', (e) => getComputedStyle(e).opacity === '1'), 'move buttons show with the focus');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  eq(await names(page), ['IMG_1.png', 'IMG_2.png', 'IMG_10.png'], 'Move page 2 earlier');

  // Rotate: the preview turns, a screen reader hears it.
  await page.locator('[aria-label="Rotate page 1 right"]').click();
  await page.waitForTimeout(200);
  eq((await handleLabels(page))[0], 'Page 1, Turned right', 'turned right said');
  ok((await page.$eval('.images-card:nth-child(1) .images-preview-canvas', (e) => e.style.transform)).includes('rotate(90deg)'), 'preview turned');
  await page.locator('[aria-label="Rotate page 1 left"]').click();
  await page.locator('[aria-label="Rotate page 1 left"]').click();
  eq((await handleLabels(page))[0], 'Page 1, Turned left', 'turned left said');

  // Options: Fit makes Orientation say "Same as image"; the choices are remembered.
  await page.locator('.ui-dropdown:has-text("Page size")').click();
  await page.locator('.ui-menu-item:has-text("Fit (same as image)")').click();
  eq(await page.$eval('.ui-dropdown:has-text("Page size")', (e) => e.textContent), 'Page size: Fit', 'Fit chip');
  const orientation = page.locator('.ui-dropdown:has-text("Orientation")');
  ok(await orientation.isDisabled(), 'orientation off on Fit');
  eq(await orientation.textContent(), 'Orientation: Same as image', 'Same as image');
  await page.locator('.ui-dropdown:has-text("Margin")').click();
  await page.locator('.ui-menu-item:has-text("Big")').click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('usugami.settings')));
  eq([saved['images.pageSize'], saved['images.margin']], ['fit', 'big'], 'layout remembered in settings');
  await page.waitForTimeout(200);
  const fitRatio = await page.$eval('.images-card:nth-child(3) .images-preview-page', (e) => e.getBoundingClientRect().width / e.getBoundingClientRect().height);
  // A 300 × 400 picture with a big margin in proportion to A4's: (300 + 2m) / (400 + 2m).
  const m = (54 / 595.2756) * 300;
  ok(Math.abs(fitRatio - (300 + 2 * m) / (400 + 2 * m)) < 0.01, `a Fit page takes its image's shape and margin (${fitRatio})`);
  await page.locator('.ui-dropdown:has-text("Page size")').click();
  await page.locator('.ui-menu-item:has-text("A4")').click();
  ok(!(await orientation.isDisabled()), 'orientation back on');

  // Remove: the page goes, the focus moves to the next page's Remove.
  await page.locator('[aria-label="Remove page 2"]').click();
  await settled(page, 2);
  eq(await names(page), ['IMG_1.png', 'IMG_10.png'], 'page 2 removed');
  eq(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove page 2', 'focus on the next Remove');

  // More images of every kind the app takes: HEIC through libheif, AVIF, WebP, BMP, GIF.
  await pickFromMenu(page, '.images-add-button', 'Files', [
    { name: 'turned.heic', mimeType: 'image/heic', buffer: await fixture('turned.heic') },
    { name: 'turned.avif', mimeType: 'image/avif', buffer: await fixture('turned.avif') },
    { name: 'photo.webp', mimeType: 'image/webp', buffer: await fixture('photo.webp') },
    { name: 'drawing.bmp', mimeType: 'image/bmp', buffer: await fixture('drawing.bmp') },
    { name: 'drawing.gif', mimeType: 'image/gif', buffer: await fixture('drawing.gif') },
  ]);
  await settled(page, 7);
  eq((await names(page)).slice(2), ['turned.heic', 'turned.avif', 'photo.webp', 'drawing.bmp', 'drawing.gif'], 'every image type added');
  await previewsDrawn(page);
  // The narrowest phones: two columns still, nothing sideways.
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(300);
  await noSidewaysScroll(page, 'editor at 320 px');
  eq(await page.$eval('.images-grid', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length), 1, 'one column at 320 px (cards at least 150 px)');
  await shot(page, 'phone320-editor');
  await page.setViewportSize(PHONE);

  // Remove all asks first; Keep keeps them.
  await page.locator('.images-editor .ui-topbar [aria-label="Remove all"]').click();
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  eq(await page.$eval('dialog[open] .ui-dialog-title', (e) => e.textContent), 'Remove all images?', 'Remove all question');
  await page.locator('dialog[open] .ui-btn:has-text("Keep")').click();
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  await settled(page, 7);
  await page.locator('.images-editor .ui-topbar [aria-label="Remove all"]').click();
  await page.locator('dialog[open] .ui-btn:has-text("Remove all")').click();
  await page.waitForSelector('.images-empty:not([hidden])');
  ok(true, 'Remove all empties the editor');

  // Back with no images leaves at once (to Home).
  await page.locator('.images-editor .ui-topbar-nav').click();
  await page.waitForSelector('.screen[data-route="home"]');
  ok(true, 'Back with no images goes Home');
}, { viewport: PHONE }));

// ---------------------------------------------------------------------------------------------
// Scan document from Home at phone size: three images one after another, a corner dragged by
// touch, looks, sliders, Apply to all pages, then a merged PDF read back.

await test('scan on a phone: Upload images, crop each in turn, looks, apply to all, one PDF', () => withPage(async (page, url) => {
  await openApp(page, url, '#/');
  await choose(page, '.scan-card button:has-text("Upload images")', [asPng('Receipt.png', photo), asPng('Letter.png', photo), asPng('Note.png', red)]);
  eq(await cropReady(page), 'Page 1 of 3', 'first image of the scan');
  eq(await page.$eval('.images-crop h1', (e) => e.textContent), 'Crop page', 'Crop page title');
  eq(await hintText(page), 'Usugami found the page. Drag the corners or sides to adjust it.', 'the page was found');
  eq(await page.$eval('.images-crop .ui-topbar-nav', (e) => e.getAttribute('aria-label')), 'Stop cropping', 'close button of a scan');
  await shots2(page, 'phone-crop');
  await noSidewaysScroll(page, 'crop');

  // The handles sit on the page's corners, as found.
  const area = await page.locator('.images-crop-canvas').boundingBox();
  const tl = await handleBox(page, 0);
  ok(tl.x > area.x && tl.y > area.y, 'top-left handle inside the picture');

  // A corner dragged by touch moves, with the magnifier showing while it is held.
  const fingers = await touch(page);
  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tl.x, y: tl.y, id: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tl.x + 10, y: tl.y + 10, id: 1 }] });
  await page.waitForTimeout(100);
  await shot(page, 'phone-crop-magnifier');
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tl.x + 24, y: tl.y + 20, id: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
  await page.waitForTimeout(150);
  const moved = await handleBox(page, 0);
  ok(Math.abs(moved.x - tl.x - 24) < 3 && Math.abs(moved.y - tl.y - 20) < 3, `corner followed the finger (${moved.x - tl.x}, ${moved.y - tl.y})`);
  eq(await page.$eval('.images-crop-handle-name', (e) => e.textContent), 'Top-left corner', 'the dragged corner is chosen');

  // The arrow buttons move it a step; a side only moves across itself.
  await page.locator('[aria-label="Move right"]').click();
  const stepped = await handleBox(page, 0);
  ok(stepped.x > moved.x && Math.abs(stepped.y - moved.y) < 0.5, 'Move right moved the corner right');
  // The bottom side, by its middle handle.
  const bottom = await handleBox(page, 6);
  await fingers.drag(bottom, { x: bottom.x, y: bottom.y - 30 }, { steps: 8 });
  await page.waitForTimeout(150);
  eq(await page.$eval('.images-crop-handle-name', (e) => e.textContent), 'Bottom side', 'the side is chosen');
  ok(await page.locator('[aria-label="Move left"]').isDisabled(), 'a bottom side doesn\'t move sideways');
  const after = await handleBox(page, 6);
  ok(after.y < bottom.y - 20, 'the bottom side moved up');

  // A corner dropped onto another doesn't make a page: the hint says so, Next is off.
  const tr = await handleBox(page, 1);
  const bl = await handleBox(page, 3);
  await fingers.drag(tr, { x: bl.x + 3, y: bl.y - 3 }, { steps: 10 });
  await page.waitForTimeout(150);
  eq(await hintText(page), "The corners don't make a page: put each one on a corner of the page.", 'not a page');
  ok(await stepButton(page, 'Next').isDisabled(), 'Next off while the corners make no page');
  // Reset puts them back on the page found.
  await page.locator('.images-crop-resets .ui-btn:has-text("Reset")').click();
  eq(await hintText(page), 'Usugami found the page. Drag the corners or sides to adjust it.', 'Reset puts the corners on the page');
  ok(!(await stepButton(page, 'Next').isDisabled()), 'Next on again');
  const found = await handleBox(page, 0);
  await page.locator('.images-crop-resets .ui-btn:has-text("Whole image")').click();
  const whole = await handleBox(page, 0);
  ok(whole.x < found.x - 20 && whole.y < found.y - 20, 'Whole image puts the corners on the picture corners');
  await page.locator('.images-crop-resets .ui-btn:has-text("Reset")').click();
  await fingers.detach();

  // Rotate right turns the picture and the corners; left turns it back.
  await page.locator('.images-crop .ui-topbar [aria-label="Rotate right"]').click();
  await page.waitForTimeout(100);
  await page.locator('.images-crop .ui-topbar [aria-label="Rotate left"]').click();

  await stepButton(page, 'Next').click();
  await filtersReady(page);
  eq(await page.$eval('.images-crop h1', (e) => e.textContent), 'Filters', 'Filters title');
  eq(await chosenLook(page), 'enhanced', 'a new scan starts on Enhanced');
  ok(await page.$eval('.images-all-pages', (e) => !e.hidden), 'Apply to all pages offered');
  await shots2(page, 'phone-filters');
  await noSidewaysScroll(page, 'filters');

  // Back on Filters goes back to Crop page with the corners kept (the browser's Back too).
  await page.goBack();
  await cropReady(page);
  eq(await page.$eval('.images-crop h1', (e) => e.textContent), 'Crop page', 'Back went to Crop page');
  await stepButton(page, 'Next').click();
  await filtersReady(page);

  // Grayscale, brighter by the keyboard; contrast held at 0 near the middle when dragged.
  await page.locator('.images-look[data-look="grayscale"]').click();
  eq(await chosenLook(page), 'grayscale', 'Grayscale chosen');
  const brightness = page.locator('.images-adjust-input').nth(0);
  await brightness.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  eq(await brightness.getAttribute('aria-valuetext'), '+12', 'brightness +12 by the keyboard');
  const contrast = page.locator('.images-adjust-input').nth(1);
  const cbox = await contrast.boundingBox();
  await page.mouse.click(cbox.x + cbox.width / 2 + 1, cbox.y + cbox.height / 2);
  eq(await contrast.getAttribute('aria-valuetext'), '0', 'contrast holds at 0 near the middle');
  await page.mouse.click(cbox.x + cbox.width * 0.25, cbox.y + cbox.height / 2);
  const c = Number(await contrast.inputValue());
  ok(c < -30, `contrast lowered (${c})`);
  await page.locator('[aria-label="Reset contrast"]').click();
  eq(await contrast.getAttribute('aria-valuetext'), '0', 'Reset contrast');
  await filtersReady(page);
  eq(await stepButton(page, 'Next').count(), 1, 'Next on an image before the last');
  await stepButton(page, 'Next').click();

  // The second image starts on the look chosen last.
  eq(await cropReady(page), 'Page 2 of 3', 'second image');
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  eq(await chosenLook(page), 'grayscale', 'the next image starts on the look chosen last');
  eq(await page.$eval('.images-adjust-input', (e) => e.getAttribute('aria-valuetext')), '0', 'its own brightness');
  await page.locator('.images-look[data-look="black_white"]').click();
  await page.locator('.images-all-pages').click();
  ok(await page.$eval('.images-all-pages-box', (e) => e.checked), 'Apply to all pages ticked');
  await stepButton(page, 'Next').click();

  // The last image: Done.
  eq(await cropReady(page), 'Page 3 of 3', 'third image');
  eq(await hintText(page), 'Drag the corners or sides onto the edges of the page.', 'no page found on a plain picture');
  await page.locator('.images-crop-resets .ui-btn:has-text("Whole image")').click();
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  eq(await chosenLook(page), 'black_white', 'Black & white from Apply to all pages');
  eq(await stepButton(page, 'Done').count(), 1, 'Done on the last image');
  await stepButton(page, 'Done').click();

  await page.waitForSelector('.images-editor');
  await settled(page, 3);
  eq(await names(page), ['Receipt.png', 'Letter.png', 'Note.png'], 'the scan\'s pages');
  eq(await handleLabels(page), ['Page 1, Black & white', 'Page 2, Black & white', 'Page 3, Black & white'], 'Apply to all pages reached every page');
  await previewsDrawn(page);
  await shots2(page, 'phone-editor-scanned');
  const steps = await page.evaluate(() => history.state?.stepDepth ?? 0);
  eq(steps, 0, 'no step left in the history');

  // One PDF, named, at Less: three A4 pages stored a bit a pixel.
  await openSheet(page);
  eq(await page.$eval('.images-sheet-summary', (e) => e.textContent), '3 images · A4 · Portrait · No margin', 'sheet summary');
  await shots2(page, 'phone-sheet');
  await page.locator('dialog[open] .ui-field-input').fill('Scan test');
  await page.locator('dialog[open] .ui-segment:has-text("Less")').click();
  eq(await page.$eval('dialog[open] .images-sheet-note', (e) => e.textContent), 'Best quality, smaller file (200 dpi)', 'compression explained');
  await create(page);
  eq(await page.$eval('.ui-result-heading', (e) => e.textContent), 'Your PDF is ready', 'result');
  await shots2(page, 'phone-result');
  const [file] = await saveAll(page, 1);
  eq(file.name, 'Scan test.pdf', 'named as typed');
  const s = await structure(file.bytes);
  eq(s.pages.length, 3, 'three pages');
  eq(s.title, 'Scan test', 'title');
  eq(s.producer, 'Usugami', 'producer');
  for (const p of s.pages) {
    eq([p.width, p.height], [595.28, 841.89], 'A4 portrait');
    eq([p.bits, p.colorSpace], [1, '/DeviceGray'], 'black and white a bit a pixel');
    ok(['/CCITTFaxDecode', '/FlateDecode'].includes(p.filter), `CCITT G4 or Flate (${p.filter})`);
  }
  // The cropped page fills its page: the paper is white, the line across it black.
  const r = await inspect(page, file.bytes, { samples: [[0.5, 0.25], [0.5, 0.75]] });
  ok(r.colors.every((col) => near(col, [255, 255, 255], 20)), `white paper (${JSON.stringify(r.colors)})`);

  // Back to editing keeps the pages; the settings remember Less and one PDF.
  await page.locator('.ui-result .ui-topbar-nav').click();
  await page.waitForSelector('.images-editor');
  await settled(page, 3);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('usugami.settings')));
  eq([saved['images.compression'], saved['images.merge']], ['less', true], 'compression and merge remembered');
}, { viewport: PHONE }));

await test('scan stopped part way keeps the images; a scan of nothing readable goes back Home', () => withPage(async (page, url) => {
  await openApp(page, url, '#/');
  await choose(page, '.scan-card button:has-text("Upload images")', [asPng('One.png', photo), asPng('Two.png', photo)]);
  eq(await cropReady(page), 'Page 1 of 2', 'scan started');
  // Stop cropping: the images not cropped yet stay in the page list as they are.
  await page.locator('.images-crop .ui-topbar-nav').click();
  await page.waitForSelector('.images-editor');
  await settled(page, 2);
  eq(await names(page), ['One.png', 'Two.png'], 'both images kept, uncropped');
  eq(await page.evaluate(() => history.state?.stepDepth ?? 0), 0, 'the scan step taken back');
  await previewsDrawn(page);
  ok(await page.$$eval('.images-preview-canvas', (cs) => cs.every((c) => c.width === 384)), 'uncropped previews');
  // Leaving asks, then goes Home.
  await page.goBack();
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  await page.locator('dialog[open] .ui-btn:has-text("Discard")').click();
  await page.waitForSelector('.screen[data-route="home"]');
  // Nothing that could be read: the scan ends, and Home shows again, saying why.
  await choose(page, '.scan-card button:has-text("Upload images")', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('text') }]);
  await snackWith(page, 'Skipped 1 file');
  await page.waitForSelector('.screen[data-route="home"]', { timeout: 15000 });
  ok(true, 'back on Home');
}, { viewport: PHONE }));

// ---------------------------------------------------------------------------------------------
// A photo taken with Take photo: Discard photo, Take another and Done, the browser's Back.

await test('take photo on a phone: Discard photo, Take another, Done, Back', () => withPage(async (page, url) => {
  await openApp(page, url, '#/tool/images');
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Take photo")', [asPng('image.png', photo)]);
  await cropReady(page);
  eq(await page.$eval('.images-crop .ui-topbar-nav', (e) => e.getAttribute('aria-label')), 'Discard photo', 'a photo can be discarded');
  eq(await page.$eval('.images-crop .ui-topbar-subtitle', (e) => e.hidden), true, 'no page count for a photo');
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  eq(await chosenLook(page), 'enhanced', 'a photo starts on Enhanced');
  ok(await page.$eval('.images-all-pages', (e) => e.hidden), 'no Apply to all pages with one page');
  await page.locator('.images-look[data-look="super_enhanced"]').click();
  eq(await page.$$eval('.images-step-buttons .ui-btn', (els) => els.map((e) => e.textContent.trim())), ['Take another', 'Done'], 'Take another and Done');
  await shots2(page, 'phone-filters-photo');

  // Take another: the page is done, the camera opens again.
  await choose(page, '.images-step-buttons .ui-btn:has-text("Take another")', [asPng('image.png', photo)]);
  await cropReady(page);
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  eq(await chosenLook(page), 'super_enhanced', 'the next photo starts on the look chosen last');
  // The browser's Back goes to Crop page, then discards the photo.
  await page.goBack();
  await cropReady(page);
  await page.goBack();
  await page.waitForSelector('.images-editor');
  await settled(page, 1);
  const name = (await names(page))[0];
  ok(/^Scan_\d{8}_\d{6}\.jpg$/.test(name), `a photo is named as the app names its photos (${name})`);
  eq((await handleLabels(page))[0], 'Page 1, Super enhanced', 'the first photo kept its look');

  // The crop button opens the page again where it was cropped; Back returns.
  await page.locator('[aria-label="Crop page 1"]').click();
  await cropReady(page);
  eq(await page.$eval('.images-crop .ui-topbar-nav', (e) => e.getAttribute('aria-label')), 'Back', 'a page from the list goes Back');
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  eq(await chosenLook(page), 'super_enhanced', 'a page opens with its own look');
  await page.locator('.images-crop .ui-topbar-nav').click();
  await cropReady(page);
  await page.locator('.images-crop .ui-topbar-nav').click();
  await page.waitForSelector('.images-editor');
  eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Crop page 1', 'focus back on the crop button');

  // Cropped again from scratch: the picture as taken, with the corners where they were; Whole
  // image puts the photo back as it was taken.
  await previewsDrawn(page);
  const croppedWidth = await page.$eval('.images-preview-canvas', (c) => c.width);
  ok(Math.abs(croppedWidth - 367) <= 2, `the page is the cropped paper (${croppedWidth} × 512 preview)`);
  await page.locator('[aria-label="Crop page 1"]').click();
  await cropReady(page);
  eq(await hintText(page), 'Usugami found the page. Drag the corners or sides to adjust it.', 'the picture as taken, searched again');
  await page.locator('.images-crop-resets .ui-btn:has-text("Whole image")').click();
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  await stepButton(page, 'Done').click();
  await page.waitForSelector('.images-editor');
  await settled(page, 1);
  await page.waitForFunction(() => document.querySelector('.images-preview-canvas')?.width === 384, null, { timeout: 15000 });
  ok(true, 'Whole image put the photo back as taken (384 × 512 preview)');

  // Leaving with images asks the app's question.
  await page.locator('.images-editor .ui-topbar-nav').click();
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  eq(await page.$eval('dialog[open] .ui-dialog-title', (e) => e.textContent), 'Discard these images?', 'discard question');
  await page.locator('dialog[open] .ui-btn:has-text("Keep")').click();
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  await page.locator('.images-editor .ui-topbar-nav').click();
  await page.locator('dialog[open] .ui-btn:has-text("Discard")').click();
  await page.waitForSelector('.screen[data-route="home"]');
  ok(true, 'Discard leaves');
}, { viewport: PHONE }));

// ---------------------------------------------------------------------------------------------
// Desktop: dropped and pasted images, mouse dragging, a corner dragged with the mouse, the crop
// screen beside its controls, Fit pages, one PDF per image, turned pages read back.

await test('desktop: drop and paste, mouse reorder, crop by mouse, Fit, one PDF per image', () => withPage(async (page, url) => {
  await openApp(page, url, '#/tool/images');
  await shots2(page, 'desktop-empty');
  // Dropped on the editor, and pasted.
  await put(page, 'drop', [['Page photo.png', photo], ['Red.png', red]]);
  await settled(page, 2);
  await put(page, 'paste', [['Blue.png', blue]]);
  await settled(page, 3);
  eq(await names(page), ['Page photo.png', 'Red.png', 'Blue.png'], 'dropped and pasted');
  eq(await page.$eval('.images-reorder-hint', (e) => e.textContent), 'Drag a page to reorder, or press Ctrl and an arrow key', 'mouse hint');
  await previewsDrawn(page);

  // A mouse drags a page at once.
  const a = await centre(page.locator('.images-card-handle').nth(2));
  const b = await centre(page.locator('.images-card-handle').nth(0));
  await mouseDrag(page, a, b);
  await page.waitForTimeout(400);
  eq(await names(page), ['Blue.png', 'Page photo.png', 'Red.png'], 'mouse drag moved the last page first');
  await page.locator('.images-card-handle').nth(0).focus();
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(200);
  eq(await names(page), ['Page photo.png', 'Red.png', 'Blue.png'], 'Ctrl+End moved it last');
  await shots2(page, 'desktop-editor');
  await noSidewaysScroll(page, 'desktop editor');

  // Crop the photo's page with the mouse: the controls are beside the picture.
  await page.locator('[aria-label="Crop page 1"]').click();
  await cropReady(page);
  ok(await page.$eval('.images-crop-step', (e) => e.classList.contains('is-wide')), 'controls beside the picture on a wide screen');
  const tl = await handleBox(page, 0);
  await mouseDrag(page, tl, { x: tl.x - 6, y: tl.y - 6 }, 6);
  await page.waitForTimeout(100);
  const moved = await handleBox(page, 0);
  ok(Math.abs(moved.x - tl.x + 6) < 2, 'corner dragged by the mouse');
  // Keyboard: Tab to a handle and move it with the arrow keys.
  await page.locator('.images-crop-handle').nth(2).focus();
  eq(await page.$eval('.images-crop-handle-name', (e) => e.textContent), 'Bottom-right corner', 'focus chooses the handle');
  const br = await handleBox(page, 2);
  await page.keyboard.press('Shift+ArrowRight');
  const br2 = await handleBox(page, 2);
  ok(br2.x > br.x, 'arrow keys move the focused handle');
  await page.locator('.images-crop-resets .ui-btn:has-text("Reset")').click();
  await shots2(page, 'desktop-crop');
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  ok(await page.$eval('.images-filter-step', (e) => e.classList.contains('is-wide')), 'Filters beside the page');
  eq(await chosenLook(page), 'original', 'a page from the list keeps its own look');
  // The looks are a radio group: the arrow keys choose.
  await page.locator('.images-look[data-look="original"]').focus();
  await page.keyboard.press('ArrowRight');
  eq(await chosenLook(page), 'lighten', 'ArrowRight chose the next look');
  await page.keyboard.press('ArrowLeft');
  eq(await chosenLook(page), 'original', 'ArrowLeft back');
  // Rotate right on Filters: the page turns with it.
  await page.locator('.images-crop .ui-topbar [aria-label="Rotate right"]').click();
  await filtersReady(page);
  const turned = await page.$eval('.images-filter-canvas', (e) => e.width > e.height);
  ok(turned, 'the page shows turned on Filters');
  await shots2(page, 'desktop-filters');
  await stepButton(page, 'Done').click();
  await page.waitForSelector('.images-editor');
  await settled(page, 3);
  eq((await handleLabels(page))[0], 'Page 1, Turned right', 'the page took the turn');

  // Fit pages, one PDF per image, Extreme.
  await page.locator('.ui-dropdown:has-text("Page size")').click();
  await page.locator('.ui-menu-item:has-text("Fit (same as image)")').click();
  await openSheet(page);
  await page.locator('dialog[open] .ui-switch-row:has-text("Merge all images")').click();
  ok(await page.$eval('dialog[open] .images-sheet-name', (e) => e.hidden), 'no file name for one PDF per image');
  eq(await page.$eval('dialog[open] .images-create-button', (e) => e.textContent), 'Create 3 PDFs', 'Create 3 PDFs');
  await page.locator('dialog[open] .ui-segment:has-text("Extreme")').click();
  await shots2(page, 'desktop-sheet');
  await create(page);
  eq(await page.$eval('.ui-result-heading', (e) => e.textContent), 'Your PDFs are ready', 'several PDFs');
  await shots2(page, 'desktop-result');
  const files = await saveAll(page, 3);
  eq(files.map((f) => f.name).sort(), ['Blue.pdf', 'Page photo.pdf', 'Red.pdf'], 'each PDF named after its image');
  const photoPdf = files.find((f) => f.name === 'Page photo.pdf');
  const s = await structure(photoPdf.bytes);
  eq(s.pages.length, 1, 'one page');
  const p = s.pages[0];
  ok(p.width > p.height, `a Fit page of a page turned right is landscape (${p.width} × ${p.height})`);
  // The page straightened: the paper's shape (its long edges 842 and 1176 pixels on the photo), turned.
  ok(Math.abs(p.width / p.height - 1176 / 842) < 0.05, `cropped page's shape (${p.width} × ${p.height})`);
  eq(p.filter, '/DCTDecode', 'a photo page is JPEG');
  // Turned right: the bottom-left mark (yellow) is now top-left, top-left (red) top-right.
  const r = await inspect(page, photoPdf.bytes, { samples: [[0.04, 0.05], [0.96, 0.05], [0.96, 0.95], [0.04, 0.95]] });
  const want = [MARKS[3], MARKS[0], MARKS[1], MARKS[2]];
  r.colors.forEach((col, i) => ok(near(col, want[i], 70), `corner ${i} of the turned page shows its mark (${col} vs ${want[i]})`));
  const blueS = await structure(files.find((f) => f.name === 'Blue.pdf').bytes);
  eq([blueS.pages[0].width, blueS.pages[0].height], [400, 300], 'Fit: a point a pixel');

  // Start over asks while the PDFs aren't saved... they are: it empties the editor.
  await page.locator('.ui-result .ui-btn:has-text("Start over")').click();
  await page.waitForSelector('.images-empty:not([hidden])');
  ok(true, 'Start over empties the editor');
}, { viewport: DESKTOP, mobile: false }));

// ---------------------------------------------------------------------------------------------
// Make text searchable (OCR) in English: the words read from the original picture, as a
// <name>_searchable.pdf; and text recognition that can't be downloaded.

/**
 * A white picture 1600 × 1200 with lines of black print, as a JPEG. `mark`: a red square at its
 * top-left (40–160 px). `sideways`: stored a quarter turn anticlockwise (1200 × 1600), as a photo
 * taken with the phone held sideways, which Rotate right puts upright.
 */
async function textPicture(page, { mark = false, sideways = false } = {}) {
  return Buffer.from(await page.evaluate(async ({ mark, sideways }) => {
    const face = new FontFace('TestSans', `url(${new URL('fonts/NotoSans-Regular.ttf', location.href).href})`);
    document.fonts.add(face);
    await face.load();
    let c = document.createElement('canvas');
    c.width = 1600;
    c.height = 1200;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#111';
    g.font = '64px TestSans';
    ['QUARTZ HARDWARE', 'Invoice number 48213', 'Payment is due on Friday'].forEach((line, i) => g.fillText(line, 140, 300 + i * 160));
    if (mark) {
      g.fillStyle = 'rgb(220, 30, 30)';
      g.fillRect(40, 40, 120, 120);
    }
    if (sideways) {
      const s = document.createElement('canvas');
      s.width = 1200;
      s.height = 1600;
      const o = s.getContext('2d');
      o.translate(0, 1600);
      o.rotate(-Math.PI / 2);
      o.drawImage(c, 0, 0);
      c = s;
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, { mark, sideways }), 'base64');
}

/**
 * Serves engine/ocr.js wrapped, so a test sees what text recognition is given: each picture's size
 * and its colours at `samples` (fractions across and down) go to window.__ocrReads, and with
 * window.__ocrFail set, reading fails as a broken engine would. Call before the tool is opened.
 */
async function watchOcr(page, samples = []) {
  await page.route((u) => u.pathname.endsWith('/app/js/engine/ocr.js') && !u.search, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `import * as real from './ocr.js?real';
export * from './ocr.js?real';
export async function createRecognizer(...args) {
  const r = await real.createRecognizer(...args);
  const recognize = r.recognize;
  r.recognize = async (image, options) => {
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0);
    const at = ([x, y]) => Array.from(g.getImageData(Math.floor(x * c.width), Math.floor(y * c.height), 1, 1).data.slice(0, 3));
    (window.__ocrReads ??= []).push({ width: c.width, height: c.height, colors: ${JSON.stringify(samples)}.map(at) });
    if (window.__ocrFail) throw new Error('Reading failed (test)');
    return recognize.call(r, image, options);
  };
  return r;
}
`,
  }));
}

await test('OCR in English makes the PDF searchable', () => withPage(async (page, url) => {
  await openApp(page, url, '#/tool/images');
  const text = await textPicture(page);
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Files")', [{ name: 'Invoice.jpg', mimeType: 'image/jpeg', buffer: text }]);
  await settled(page, 1);
  await openSheet(page);
  ok(await page.$eval('dialog[open] .ui-switch-row:has-text("Merge")', (e) => e.hidden), 'no merge switch for one image');
  eq(await page.$eval('dialog[open] .ui-field-input', (e) => e.value), 'Invoice', 'one image suggests its own name');
  await page.locator('dialog[open] .ui-switch-row:has-text("Make text searchable")').click();
  ok(await page.$eval('dialog[open] .images-sheet-ocr', (e) => !e.hidden), 'Text language shows');
  eq(await page.$eval('dialog[open] .images-sheet-ocr .ui-segment[aria-checked="true"]', (e) => e.textContent), 'English', 'English by default');
  ok((await page.$eval('dialog[open] .images-sheet-ocr .images-sheet-note', (e) => e.textContent)).includes('downloaded from this site'), 'web wording of where recognition comes from');
  await shots2(page, 'desktop-sheet-ocr');
  await create(page);
  const [file] = await saveAll(page, 1);
  eq(file.name, 'Invoice_searchable.pdf', 'a searchable PDF is named so');
  const r = await inspect(page, file.bytes);
  ok(/Invoice/.test(r.texts[0]) && /48213/.test(r.texts[0]) && /Friday/.test(r.texts[0]), `pdf.js finds the words (${r.texts[0]})`);
  eq((await structure(file.bytes)).title, 'Invoice', 'title kept');
}, { viewport: DESKTOP, mobile: false }));

await test('OCR that can\'t be downloaded says so and keeps the choices', () => withPage(async (page, url) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/vendor/tesseract/**', (route) => route.abort('internetdisconnected'));
  await openApp(page, url, '#/tool/images');
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Photos")', [asPng('A.png', red), asPng('B.png', green)]);
  await settled(page, 2);
  await openSheet(page);
  await page.locator('dialog[open] .ui-field-input').fill('Kept name');
  await page.locator('dialog[open] .ui-switch-row:has-text("Make text searchable")').click();
  await page.locator('dialog[open] .images-sheet-ocr .ui-segment:has-text("French")').click();
  await page.locator('dialog[open] .images-create-button').click();
  await page.waitForFunction(() => document.querySelector('dialog[open] .ui-dialog-title')?.textContent === "Text recognition isn't available", null, { timeout: 90000 });
  const body = await page.$eval('dialog[open] .ui-dialog-body', (e) => e.textContent);
  ok(body.includes('To create the PDF now, turn off OCR and try again.'), 'retry advice');
  ok(/couldn't (be downloaded|start)/.test(body), `what went wrong (${body})`);
  await shot(page, 'phone-ocr-problem');
  await page.locator('dialog[open] .ui-btn:has-text("OK")').click();
  await openSheet(page);
  eq(await page.$eval('dialog[open] .ui-field-input', (e) => e.value), 'Kept name', 'the name kept');
  eq(await page.$eval('dialog[open] .images-sheet-ocr .ui-segment[aria-checked="true"]', (e) => e.textContent), 'French', 'OCR still on, in French');
  ok(!errors.length, `no page errors (${errors.join('; ')})`);
}, { viewport: PHONE, ignoreProblems: true }));

await test('Cancel while the PDF is made', () => withPage(async (page, url) => {
  await openApp(page, url, '#/tool/images');
  const text = await textPicture(page);
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Files")', ['A', 'B', 'C'].map((n) => ({ name: `${n}.jpg`, mimeType: 'image/jpeg', buffer: text })));
  await settled(page, 3);
  await openSheet(page);
  await page.locator('dialog[open] .ui-field-input').fill('Cancelled');
  await page.locator('dialog[open] .ui-switch-row:has-text("Make text searchable")').click();
  await page.locator('dialog[open] .images-create-button').click();
  await page.waitForFunction(() => document.querySelector('.ui-progress-dialog .ui-dialog-title')?.textContent === 'Reading text…', null, { timeout: 90000 });
  ok(/of 3 pages/.test(await page.$eval('.ui-progress-dialog .ui-progress-label', (e) => e.textContent)), 'pages read so far');
  await shot(page, 'desktop-progress');
  await page.locator('.ui-progress-dialog .ui-btn:has-text("Cancel")').click();
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 30000 });
  ok(!(await page.$('.ui-result')), 'no result once cancelled');
  ok(!(await page.locator('.images-convert-button').isDisabled()), 'Convert to PDF ready again');
  ok(!(await snacks(page)).some((t) => t.startsWith("Couldn't")), 'nothing said to have failed');
  await openSheet(page);
  eq(await page.$eval('dialog[open] .ui-field-input', (e) => e.value), 'Cancelled', 'the sheet opens with the cancelled choices');
  ok(await page.$eval('dialog[open] .images-sheet-ocr', (e) => !e.hidden), 'OCR still on');
}, { viewport: DESKTOP, mobile: false }));

await test('OCR reads each page as it shows: its own image, turned, in colour whatever its look', () => withPage(async (page, url) => {
  // Samples of the picture read, upright: the red mark (top-left) and paper (bottom middle).
  await watchOcr(page, [[0.06, 0.08], [0.5, 0.95]]);
  await openApp(page, url, '#/tool/images');
  const sideways = await textPicture(page, { mark: true, sideways: true });
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Files")', [{ name: 'Invoice.jpg', mimeType: 'image/jpeg', buffer: sideways }]);
  await settled(page, 1);
  // The whole image, turned right (upright again) and in Black and white.
  await page.locator('[aria-label="Crop page 1"]').click();
  await cropReady(page);
  await page.locator('.images-crop-resets .ui-btn:has-text("Whole image")').click();
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  await page.locator('.images-crop .ui-topbar [aria-label="Rotate right"]').click();
  await filtersReady(page);
  await page.locator('.images-look[data-look="black_white"]').click();
  await filtersReady(page);
  await stepButton(page, 'Done').click();
  await page.waitForSelector('.images-editor');
  await settled(page, 1);
  eq((await handleLabels(page))[0], 'Page 1, Turned right, Black & white', 'turned and in Black & white');
  // Extreme keeps the page at 100 dpi in the PDF: the text is read from the image itself.
  await openSheet(page);
  await page.locator('dialog[open] .ui-segment:has-text("Extreme")').click();
  await page.locator('dialog[open] .ui-switch-row:has-text("Make text searchable")').click();
  await create(page);
  const reads = await page.evaluate(() => window.__ocrReads ?? []);
  eq(reads.length, 1, 'one page read');
  eq([reads[0].width, reads[0].height], [1600, 1200], 'read upright as turned, at the image\'s own size (not the 100 dpi copy)');
  const [mark, paper] = reads[0].colors;
  ok(mark[0] > 170 && mark[1] < 90 && mark[2] < 90, `read in colour, not in its look: the red mark is red (${mark})`);
  ok(paper.every((v) => v > 200), `the paper is white (${paper})`);
  const [file] = await saveAll(page, 1);
  eq(file.name, 'Invoice_searchable.pdf', 'a searchable PDF is named so');
  const r = await inspect(page, file.bytes);
  ok(/48213/.test(r.texts[0]) && /Friday/.test(r.texts[0]), `pdf.js finds the words (${r.texts[0]})`);
  const s = await structure(file.bytes);
  ok(Math.max(...s.pages[0].pixels) < 1600, `the PDF keeps a smaller copy (${s.pages[0].pixels})`);
}, { viewport: DESKTOP, mobile: false }));

/**
 * Records what the live region (#announcer) says, and whether a dialog was open then: a message
 * announced while the progress dialog is modal is never heard (the rest of the page is inert).
 */
async function watchAnnouncer(page) {
  await page.evaluate(() => {
    window.__said = [];
    new MutationObserver(() => {
      const text = document.getElementById('announcer')?.textContent;
      if (text && window.__said.at(-1)?.text !== text) window.__said.push({ text, modal: !!document.querySelector('dialog[open]') });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
async function saidWithoutDialog(page, text) {
  await page.waitForFunction((t) => window.__said.some((s) => s.text.includes(t)), text, { timeout: 30000 });
  const said = await page.evaluate((t) => window.__said.filter((s) => s.text.includes(t)), text);
  ok(said.every((s) => !s.modal), `"${text}" announced once the progress dialog had gone (${JSON.stringify(said)})`);
}

await test('OCR: no text found says so; reading that fails keeps the PDF, without text', () => withPage(async (page, url) => {
  await watchOcr(page);
  await openApp(page, url, '#/tool/images');
  await watchAnnouncer(page);
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Photos")', [asPng('Red.png', red)]);
  await settled(page, 1);
  await openSheet(page);
  await page.locator('dialog[open] .ui-switch-row:has-text("Make text searchable")').click();
  await create(page);
  await snackWith(page, 'No text was recognized. The PDF was created without a text layer.');
  await saidWithoutDialog(page, 'No text was recognized.');
  eq(await page.$eval('.ui-result-name', (e) => e.textContent), 'Red.pdf', 'named as it would be without text recognition');
  // The browser's Back goes back to editing; then reading fails.
  await page.goBack();
  await page.waitForSelector('.images-editor');
  await settled(page, 1);
  eq(await page.evaluate(() => history.state?.stepDepth ?? 0), 0, 'the result step taken back');
  await clearSnacks(page);
  await page.evaluate(() => { window.__ocrFail = true; });
  await openSheet(page);
  await page.locator('dialog[open] .ui-switch-row:has-text("Make text searchable")').click();
  await create(page);
  await snackWith(page, 'Text recognition failed, so the PDF was created without searchable text.');
  await saidWithoutDialog(page, 'Text recognition failed');
  eq(await page.$eval('.ui-result-name', (e) => e.textContent), 'Red.pdf', 'the PDF made, as it was');
  const [file] = await saveAll(page, 1);
  const r = await inspect(page, file.bytes);
  eq(r.texts, [''], 'no text layer');
  eq(await page.evaluate(() => window.__ocrReads.length), 2, 'each run read the page');
}, { viewport: PHONE }));

// ---------------------------------------------------------------------------------------------
// HEIC photos: decoded on this device (libheif, where the browser can't), the page made from the
// upright JPEG they are stored as.

await test('a HEIC photo: upright, as a JPEG page; Back from the result to editing', () => withPage(async (page, url, context) => {
  const requests = [];
  context.on('request', (r) => requests.push(r.url()));
  await openApp(page, url, '#/tool/images');
  const heic = await fixture('turned.heic');
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Files")', [{ name: 'turned.heic', mimeType: 'image/heic', buffer: heic }]);
  await settled(page, 1);
  await previewsDrawn(page);
  eq(await names(page), ['turned.heic'], 'named after its file');
  const native = await page.evaluate(async (b64) => {
    try {
      (await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/heic' }))).close();
      return true;
    } catch {
      return false;
    }
  }, heic.toString('base64'));
  if (!native) ok(requests.some((u) => u.endsWith('/vendor/libheif/libheif-bundle.mjs')), 'libheif, from this site, decoded it');
  ok(await page.$eval('.images-preview-canvas', (c) => c.height > c.width), 'the preview is upright (taller than wide)');
  await page.locator('.ui-dropdown:has-text("Page size")').click();
  await page.locator('.ui-menu-item:has-text("Fit (same as image)")').click();
  await openSheet(page);
  eq(await page.$eval('dialog[open] .ui-field-input', (e) => e.value), 'turned', 'named after the photo');
  await create(page);
  const [file] = await saveAll(page, 1);
  eq(file.name, 'turned.pdf', 'file name');
  const s = await structure(file.bytes);
  eq(s.pages.length, 1, 'one page');
  eq([s.pages[0].width, s.pages[0].height], [64, 128], 'Fit: the photo upright, a point a pixel');
  eq(s.pages[0].filter, '/DCTDecode', 'a photo page is JPEG');
  eq(s.pages[0].pixels, [64, 128], 'the whole photo');
  // The stored copy's red corner (images-detect's ImageTypesDeviceTest), where the page shows it.
  const r = await inspect(page, file.bytes, { samples: [[59.5 / 64, 4.5 / 128]] });
  const [c] = r.colors;
  ok(c[0] > 160 && c[1] < 100, `red at the photo's upright top-right (${c})`);
  // The browser's Back from the result goes back to editing, the photo kept.
  await page.goBack();
  await page.waitForSelector('.images-editor');
  await settled(page, 1);
  eq(await page.evaluate(() => [location.hash, history.state?.stepDepth ?? 0]), ['#/tool/images', 0], 'back to editing, no step left');
}, { viewport: DESKTOP, mobile: false }));

// ---------------------------------------------------------------------------------------------
// The editor's chips stay over the pages (the app's grid scrolls under them), each 48 px to tap;
// the first pages start at the top with the keyboard's focus on the first; the Create PDF sheet is
// a history step; a failed PDF is said once the progress dialog has gone.

/** Whether points 4 px above and below `selector`'s element (the first) still reach it. */
const tapReach = (page, selector) => page.$eval(selector, (el) => {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const hits = (y) => document.elementFromPoint(x, y)?.closest('.ui-chip') === el;
  return { above: hits(r.top - 4), below: hits(r.bottom + 4), height: r.height };
});

await test('editor: the chips stay over the scrolled pages, 48 px to tap; new pages start at the top, focused', () => withPage(async (page, url) => {
  await openApp(page, url, '#/tool/images');
  const many = Array.from({ length: 8 }, (_, i) => asPng(`P${i + 1}.png`, [red, green, blue][i % 3]));
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Photos")', many);
  await settled(page, 8);
  const reach = await tapReach(page, '.images-options .ui-chip');
  ok(reach.above && reach.below, `a chip takes taps 4 px beyond its edges (${JSON.stringify(reach)})`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.scrollY) > 300, 'the pages scrolled');
  const top = await page.$eval('.images-options', (e) => e.getBoundingClientRect().top);
  ok(top >= 63 && top <= 66, `the chips stay under the top bar (top ${top})`);
  const chip = await page.$eval('.images-options .ui-chip', (e) => e.getBoundingClientRect().top);
  ok(chip >= 64 && chip < 120, `the Page size chip shows (top ${chip})`);
  const hit = await page.$eval('.images-options .ui-chip', (e) => {
    const r = e.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.ui-chip') === e;
  });
  ok(hit, 'nothing covers the chip');
  await page.locator('.ui-dropdown:has-text("Page size")').click();
  await page.waitForSelector('.ui-menu-item:has-text("Letter")');
  await page.locator('.ui-menu-item:has-text("Letter")').click();
  eq(await page.$eval('.ui-dropdown:has-text("Page size")', (e) => e.textContent), 'Page size: US Letter', 'changed while scrolled');
  await shot(page, 'phone-editor-scrolled');

  // Remove all, then a landscape phone: the empty screen scrolls to reach its buttons; the pages
  // added start at their top, and the keyboard's focus goes to the first of them (not lost to
  // the document, where the next Tab would start again from the top).
  await page.locator('.images-editor .ui-topbar [aria-label="Remove all"]').click();
  await page.locator('dialog[open] .ui-btn:has-text("Remove all")').click();
  await page.waitForSelector('.images-empty:not([hidden])');
  await page.setViewportSize({ width: 780, height: 360 });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => window.scrollY) > 0, 'the empty screen scrolled');
  await page.locator('.images-empty-buttons .ui-btn:has-text("Files")').focus();
  // Playwright catches the picker once its listener is set up, which takes a moment.
  const picking = page.waitForEvent('filechooser');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  const chooser = await picking;
  await chooser.setFiles([asPng('One.png', red), asPng('Two.png', green)]);
  await settled(page, 2);
  await page.waitForTimeout(200);
  eq(await page.evaluate(() => window.scrollY), 0, 'the pages start at their top');
  ok(await page.$eval('.images-options', (e) => e.getBoundingClientRect().top) >= 64, 'the chips show under the top bar');
  eq(await page.evaluate(() => document.activeElement?.closest('.images-card') === document.querySelector('.images-card')), true, 'the focus is on the first page');
  ok(await page.$$eval('.images-empty-buttons .ui-btn', (els) => els.every((e) => !e.disabled)), 'the empty screen\'s buttons are never `disabled` (which drops the focus)');
}, { viewport: PHONE }));

for (const browser of QUICK ? ['chromium'] : ['chromium', 'firefox', 'webkit']) {
  await test(`${browser}: the Create PDF sheet: the browser's Back closes it and keeps the images; a failed PDF is said after the dialog`, () => withPage(async (page, url) => {
    // Making the PDF fails as an unreadable image would.
    await page.route((u) => u.pathname.endsWith('/app/js/engine/images/build-pdf.js'), (route) => route.fulfill({
      contentType: 'text/javascript',
      body: `import { UserError } from '../../core/errors.js';
export async function buildImagesPdf(pages) {
  await new Promise((r) => setTimeout(r, 700));
  throw new UserError('msg_image_unreadable', pages[0].name);
}`,
    }));
    await openApp(page, url, '#/tool/images');
    await watchAnnouncer(page);
    // Playwright's Firefox takes the file picker's cancel event first (see below): dropped there.
    if (browser === 'firefox') await put(page, 'drop', [['Red.png', red], ['Green.png', green]]);
    else await choose(page, '.images-empty-buttons .ui-btn:has-text("Photos")', [asPng('Red.png', red), asPng('Green.png', green)]);
    await settled(page, 2);
    await openSheet(page);
    eq(await page.evaluate(() => history.state?.stepDepth ?? 0), 1, 'the sheet is a step');
    await page.goBack();
    await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 10000 });
    await page.waitForTimeout(300);
    ok(!(await page.$('dialog[open]')), 'Back closed the sheet, asking nothing');
    await settled(page, 2);
    eq(await page.evaluate(() => [location.hash, history.state?.stepDepth ?? 0]), ['#/tool/images', 0], 'still editing, no step left');
    // Escape closes it too, and its step goes.
    await openSheet(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 10000 });
    await page.waitForFunction(() => (history.state?.stepDepth ?? 0) === 0, null, { timeout: 5000 });
    ok(true, 'Escape closes it, its step taken back');
    // Create: the PDF can't be made; that is said once the progress dialog has gone.
    await openSheet(page);
    await page.locator('dialog[open] .images-create-button').click();
    await snackWith(page, 'Couldn\'t create the PDF: "Red.png" could not be read');
    await saidWithoutDialog(page, 'Couldn\'t create the PDF');
    eq(await page.evaluate(() => [location.hash, history.state?.stepDepth ?? 0]), ['#/tool/images', 0], 'back to editing, no step left');
    await settled(page, 2);
  }, { browser, viewport: PHONE, mobile: browser !== 'firefox' }));
}

await test('the tool shows before the PDF writer and text recognition have loaded', () => withPage(async (page, url) => {
  // pdf-lib, fontkit, pdf.js and Tesseract held back, as on a slow connection.
  const held = [];
  let holding = true;
  await page.route((u) => /\/vendor\/(pdf-lib|fontkit|pdfjs|tesseract)\//.test(u.pathname), (route) => {
    if (holding) held.push(route);
    else route.continue();
  });
  await page.goto(url + 'app/#/tool/images');
  await page.waitForSelector('.screen[data-tool="images"]:not([aria-busy]) .images-empty-buttons', { timeout: 15000 });
  ok(true, 'the empty editor shows');
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Photos")', [asPng('Red.png', red)]);
  await settled(page, 1);
  await previewsDrawn(page);
  ok(true, 'images are added and shown meanwhile');
  holding = false;
  for (const route of held.splice(0)) await route.continue();
  await openSheet(page);
  await create(page);
  const [file] = await saveAll(page, 1);
  eq((await structure(file.bytes)).pages.length, 1, 'once they come, the PDF is made');
}, { viewport: PHONE }));

await test('leaving through the router\'s Discard starts the next photo on Enhanced again', () => withPage(async (page, url) => {
  const openImages = async () => {
    await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/tool/images'));
    await page.waitForSelector('.screen[data-tool="images"]:not([aria-busy]) .images-editor');
  };
  // From Home, so the browser's Back has the app to go back to.
  await openApp(page, url, '#/');
  await openImages();
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Take photo")', [asPng('image.png', photo)]);
  await cropReady(page);
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  await page.locator('.images-look[data-look="black_white"]').click();
  await stepButton(page, 'Done').click();
  await page.waitForSelector('.images-editor');
  await settled(page, 1);
  await page.goBack();
  await page.waitForSelector('dialog[open] .ui-dialog-title');
  await page.locator('dialog[open] .ui-btn:has-text("Discard")').click();
  await page.waitForSelector('.screen[data-route="home"]');
  await openImages();
  await choose(page, '.images-empty-buttons .ui-btn:has-text("Take photo")', [asPng('image.png', photo)]);
  await cropReady(page);
  await stepButton(page, 'Next').click();
  await filtersReady(page);
  eq(await chosenLook(page), 'enhanced', 'the next photo starts on Enhanced, as after the app\'s Discard');
}, { viewport: PHONE }));

for (const browser of QUICK ? ['chromium'] : ['chromium', 'firefox', 'webkit']) {
  await test(`${browser} desktop: Filters' looks scroll with the mouse wheel; Crop page shows grab cursors over its handles`, () => withPage(async (page, url) => {
    await openApp(page, url, '#/tool/images');
    if (browser === 'firefox') await put(page, 'drop', [['Photo.png', photo]]);
    else await choose(page, '.images-empty-buttons .ui-btn:has-text("Files")', [asPng('Photo.png', photo)]);
    await settled(page, 1);
    await page.locator('[aria-label="Crop page 1"]').click();
    await cropReady(page);
    const canvas = page.locator('.images-crop-canvas');
    const cursor = () => canvas.evaluate((c) => getComputedStyle(c).cursor);
    const corner = await handleBox(page, 0);
    await page.mouse.move(corner.x, corner.y);
    eq(await cursor(), 'grab', 'grab over a corner');
    await page.mouse.down();
    eq(await cursor(), 'grabbing', 'grabbing while it is dragged');
    await page.mouse.move(corner.x + 10, corner.y + 10, { steps: 3 });
    await page.mouse.up();
    eq(await cursor(), 'grab', 'grab again once let go over it');
    const box = await canvas.boundingBox();
    const a = await handleBox(page, 0);
    const c = await handleBox(page, 2);
    await page.mouse.move((a.x + c.x) / 2, (a.y + c.y) / 2);
    eq(await cursor(), 'auto', 'the default cursor away from the handles');
    await page.mouse.move(box.x + box.width + 40, box.y + 10);
    await stepButton(page, 'Next').click();
    await filtersReady(page);
    ok(await page.$eval('.images-step', (e) => e.classList.contains('is-wide')), 'the controls beside the picture');
    const hidden = () => page.evaluate(() => {
      const panel = document.querySelector('.images-step-panel').getBoundingClientRect();
      return [...document.querySelectorAll('.images-look')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.left < panel.left - 1 || r.right > panel.right + 1;
      }).map((b) => b.dataset.look);
    });
    ok((await hidden()).length > 0, `some looks don't fit beside the picture (${await hidden()})`);
    const strip = await page.locator('.images-looks').boundingBox();
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => document.querySelector('.images-looks').scrollLeft > 0, null, { timeout: 5000 });
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(300);
    const last = await page.evaluate(() => {
      const panel = document.querySelector('.images-step-panel').getBoundingClientRect();
      const r = [...document.querySelectorAll('.images-look')].at(-1).getBoundingClientRect();
      return r.right <= panel.right + 1 && r.left >= panel.left - 1;
    });
    ok(last, 'the wheel brought the last look into sight');
    await page.mouse.wheel(0, -2000);
    await page.waitForFunction(() => document.querySelector('.images-looks').scrollLeft === 0, null, { timeout: 5000 });
    ok(true, 'and back to the first');
  }, { browser, viewport: { width: 1280, height: 900 }, mobile: false }));
}

// ---------------------------------------------------------------------------------------------
// Home's Take photo (Scan document with the photo given), images shared while the tool shows, and
// the app's question on the browser's Back.

for (const browser of QUICK ? ['chromium'] : ['chromium', 'firefox', 'webkit']) {
  await test(`${browser}: Take photo on Home: Discard photo, Take another, Done; Back asks the app's question`, () => withPage(async (page, url) => {
    await openApp(page, url, '#/');
    // A photo discarded: nothing is left, so back to Home.
    await choose(page, '.scan-card button:has-text("Take photo")', [asPng('image.png', photo)]);
    await cropReady(page);
    ok((await page.evaluate(() => location.hash)).startsWith('#/tool/scan'), 'Scan document opened');
    eq(await page.$eval('.images-crop .ui-topbar-nav', (e) => e.getAttribute('aria-label')), 'Discard photo', 'a photo just taken can be discarded');
    await page.locator('.images-crop .ui-topbar-nav').click();
    await page.waitForSelector('.screen[data-route="home"]', { timeout: 15000 });
    // Another photo, Take another, then Done.
    await choose(page, '.scan-card button:has-text("Take photo")', [asPng('image.png', photo)]);
    await cropReady(page);
    await stepButton(page, 'Next').click();
    await filtersReady(page);
    eq(await page.$$eval('.images-step-buttons .ui-btn', (els) => els.map((e) => e.textContent.trim())), ['Take another', 'Done'], 'Take another and Done');
    eq(await chosenLook(page), 'enhanced', 'a scan from Home starts on Enhanced');
    // An Android camera names its capture with a number: no name worth keeping either.
    await choose(page, '.images-step-buttons .ui-btn:has-text("Take another")', [asPng('1731150000000.png', photo)]);
    await cropReady(page);
    await stepButton(page, 'Next').click();
    await filtersReady(page);
    await stepButton(page, 'Done').click();
    await page.waitForSelector('.images-editor');
    await settled(page, 2);
    const taken = await names(page);
    ok(taken.every((n) => /^Scan_\d{8}_\d{6}\.jpg$/.test(n)), `photos named as the app names its photos (${taken})`);
    eq(await page.evaluate(() => history.state?.stepDepth ?? 0), 0, 'no step left in the history');
    // The browser's Back asks the app's own question; Keep stays.
    await page.goBack();
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.$eval('dialog[open] .ui-dialog-title', (e) => e.textContent), 'Discard these images?', 'the app\'s question');
    ok((await page.$eval('dialog[open] .ui-dialog-body', (e) => e.textContent)).includes('Your original photos are not affected.'), 'with its explanation');
    eq(await page.$$eval('dialog[open] .ui-dialog-actions .ui-btn', (els) => els.map((e) => e.textContent.trim()).sort()), ['Discard', 'Keep'], 'Discard and Keep');
    await page.locator('dialog[open] .ui-btn:has-text("Keep")').click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await settled(page, 2);
    ok((await page.evaluate(() => location.hash)).startsWith('#/tool/scan'), 'Keep stays');
    await page.goBack();
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    await page.locator('dialog[open] .ui-btn:has-text("Discard")').click();
    await page.waitForSelector('.screen[data-route="home"]');
    ok(true, 'Discard leaves');
  }, { browser, viewport: PHONE, mobile: browser !== 'firefox' }));
}

for (const browser of QUICK ? ['chromium'] : ['chromium', 'firefox', 'webkit']) {
  await test(`${browser}: images shared while Scan document or Images to PDF shows join its pages`, () => withPage(async (page, url) => {
    const share = (files) => page.evaluate(async (files) => {
      const { receiveFiles } = await import('./js/core/share-inbox.js');
      await receiveFiles(files.map((f) => new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: 'image/png' })));
    }, files.map(([name, buf]) => ({ name, b64: Buffer.from(buf).toString('base64') })));
    // Scan document without a scan (a reload, say): its editor takes them.
    await openApp(page, url, '#/tool/scan');
    await page.waitForSelector('.images-editor');
    await share([['Red.png', red], ['Green.png', green]]);
    await settled(page, 2);
    eq(await names(page), ['Red.png', 'Green.png'], 'added on Scan document');
    ok(await page.isVisible('.screen[data-tool="scan"] .images-editor'), 'the same screen');
    // Images to PDF with its result showing: the result goes and the image joins, with no question.
    await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/tool/images', { force: true }));
    await page.waitForSelector('.screen[data-tool="images"]:not([aria-busy]) .images-editor');
    await choose(page, '.images-empty-buttons .ui-btn:has-text("Photos")', [asPng('Blue.png', blue)]);
    await settled(page, 1);
    await openSheet(page);
    await create(page);
    await share([['Red.png', red]]);
    await page.waitForSelector('.images-editor');
    await settled(page, 2);
    eq(await names(page), ['Blue.png', 'Red.png'], 'added after the pages there');
    ok(!(await page.$('dialog[open]')), 'nothing asked');
    eq(await page.evaluate(() => history.state?.stepDepth ?? 0), 0, 'the result step taken back');
  }, { browser, viewport: PHONE, mobile: browser !== 'firefox' }));
}

// ---------------------------------------------------------------------------------------------
// Firefox and WebKit: the whole flow, shorter.

for (const [browser, viewport] of QUICK ? [] : [['firefox', DESKTOP], ['webkit', PHONE]]) {
  await test(`${browser}: add, crop, look, convert`, () => withPage(async (page, url) => {
    await openApp(page, url, '#/tool/images');
    // Playwright's Firefox fires the file input's cancel event before its change event, which the
    // kit's picker takes for a cancel: there the images are dropped instead.
    if (browser === 'firefox') await put(page, 'drop', [['Photo.png', photo], ['Red.png', red]]);
    else await choose(page, '.images-empty-buttons .ui-btn:has-text("Photos")', [asPng('Photo.png', photo), asPng('Red.png', red)]);
    await settled(page, 2);
    await previewsDrawn(page);
    await shot(page, `${browser}-editor`);
    await page.locator('[aria-label="Crop page 1"]').click();
    await cropReady(page);
    eq(await hintText(page), 'Usugami found the page. Drag the corners or sides to adjust it.', 'page found');
    await shot(page, `${browser}-crop`);
    await stepButton(page, 'Next').click();
    await filtersReady(page);
    await page.locator('.images-look[data-look="enhanced"]').click();
    await filtersReady(page);
    await shot(page, `${browser}-filters`);
    await stepButton(page, 'Done').click();
    await page.waitForSelector('.images-editor');
    await settled(page, 2);
    await openSheet(page);
    await create(page);
    const [file] = await saveAll(page, 1);
    const s = await structure(file.bytes);
    eq(s.pages.length, 2, 'two pages');
    eq(s.pages[0].filter, '/DCTDecode', 'Enhanced page as JPEG');
    const r = await inspect(page, file.bytes);
    ok(r.pages === 2, 'pdf.js reads it');
  }, { browser, viewport, mobile: viewport.width < 700 }));
}

console.log(`\n${checks} checks passed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
