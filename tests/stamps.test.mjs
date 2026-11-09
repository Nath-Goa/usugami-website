// Add page numbers and Add watermark: the engine (engine/stamps.js) and the two screens
// (tools/page-numbers/, tools/watermark/). Ported from the app's PageStampsTest.kt and the page-number
// and watermark parts of PdfEditingDeviceTest.kt, BatchToolsDeviceTest.kt and ScreensDeviceTest.kt.
// Results are read back with pdf.js: the text and where it is, and the pages drawn, compared with
// the pages before (the pixels that changed are the number or the watermark).
//   node tests/stamps.test.mjs            everything
//   node tests/stamps.test.mjs --quick    Chromium only, no screenshots
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withPage, assert, saveOutput, root } from './harness.mjs';
import {
  PDFDocument, StandardFonts, degrees, PDFName, PDFStream,
} from '../site/app/vendor/pdf-lib/pdf-lib.esm.min.js';
import {
  PageFrame, numberedPages, numberedEach, numberMargin, numberOrigin, placeWatermark, defaultName, outputNames,
  PAGE_NUMBER_POSITIONS, PAGE_NUMBER_SIZES, WATERMARK_COLORS, WATERMARK_OPACITIES, BATCH_NAMES,
} from '../site/app/js/engine/stamps.js';
import pageNumberOwn from '../site/app/locales/en/page-numbers.js';
import watermarkOwn from '../site/app/locales/en/watermark.js';
import common from '../site/app/locales/en/common.js';

// Strings shared by several tools live in common.js, which the app loads at start.
const pageNumberStrings = { ...common, ...pageNumberOwn };
const watermarkStrings = { ...common, ...watermarkOwn };

const quick = process.argv.includes('--quick');
const log = (s) => console.log('  ' + s);
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
const throwsKey = (fn, key, message) => {
  try {
    fn();
  } catch (e) {
    eq(e.key, key, message);
    return e;
  }
  throw new Error(`${message}: nothing thrown`);
};

const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 800 };
const CAP = 0.714; // Noto Sans's cap height: digits are as tall.

// ---------------------------------------------------------------------------------------------
// The app's unit tests (PageStampsTest.kt), in Node.

const point = (expected, actual, message) => {
  near(actual[0], expected[0], 0.001, message + ' x');
  near(actual[1], expected[1], 0.001, message + ' y');
};
const frame = (rotation) => new PageFrame(10, 20, 400, 600, rotation);

await test('page frames: the shown page in the page\'s own coordinates', () => {
  let f = frame(0);
  eq([f.shownWidth, f.shownHeight], [400, 600], 'upright size');
  point([10, 20], f.toPage(0, 0), 'upright origin');
  point([410, 620], f.toPage(400, 600), 'upright corner');
  // Shown sideways: the box's right edge is the shown bottom, its bottom edge the shown left.
  f = frame(90);
  eq([f.shownWidth, f.shownHeight], [600, 400], 'turned size');
  point([410, 20], f.toPage(0, 0), 'shown bottom-left');
  point([410, 620], f.toPage(600, 0), 'shown bottom-right');
  point([10, 20], f.toPage(0, 400), 'shown top-left');
  point([10, 620], f.toPage(600, 400), 'shown top-right');
  f = frame(180);
  point([410, 620], f.toPage(0, 0), 'upside down origin');
  point([10, 20], f.toPage(400, 600), 'upside down corner');
  f = frame(-90);
  eq(f.rotation, 270, 'the same as 270');
  eq(f.shownWidth, 600, 'anticlockwise width');
  point([10, 620], f.toPage(0, 0), 'shown bottom-left: the box\'s top-left');
  point([10, 20], f.toPage(600, 0), 'anticlockwise bottom-right');
  point([410, 620], f.toPage(0, 400), 'anticlockwise top-left');
  for (const rotation of [0, 90, 180, 270, 450]) {
    f = frame(rotation);
    const corners = [[0, 0], [f.shownWidth, 0], [0, f.shownHeight], [f.shownWidth, f.shownHeight]].map(([x, y]) => f.toPage(x, y));
    eq([...new Set(corners.map((c) => Math.round(c[0])))].sort((a, b) => a - b), [10, 410], `rotation ${rotation} x`);
    eq([...new Set(corners.map((c) => Math.round(c[1])))].sort((a, b) => a - b), [20, 620], `rotation ${rotation} y`);
    // toShown undoes toPage, and the top-left matrix is the same frame with y down.
    for (const [x, y] of [[0, 0], [37, 91], [f.shownWidth, f.shownHeight]]) {
      point([x, y], f.toShown(...f.toPage(x, y)), `rotation ${rotation} round trip`);
      const m = f.topLeftMatrix;
      point(f.toPage(x, f.shownHeight - y), [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]], `rotation ${rotation} top-left`);
    }
  }
  let refused = false;
  try { new PageFrame(0, 0, 100, 100, 45); } catch (e) { refused = e instanceof RangeError; }
  assert(refused, 'odd rotations are refused');
});

await test('pages to skip: each page keeps its own number, several PDFs read them against the longest', () => {
  eq(numberedPages('', 4), [0, 1, 2, 3], 'blank');
  eq(numberedPages('  ', 4), [0, 1, 2, 3], 'spaces');
  eq(numberedPages('1', 4), [1, 2, 3], 'cover');
  eq(numberedPages('1-2,4', 4), [2], 'several');
  eq(numberedPages('1-4', 4), [], 'all');
  eq(numberedEach('', [3, 1]), [[0, 1, 2], [0]], 'none skipped');
  // A cover skipped in each; the one-page PDF has nothing left to number.
  eq(numberedEach('1', [4, 2, 1]), [[1, 2, 3], [1], []], 'cover in each');
  // Page 4 is only in the longest; the others have no page 4 to skip.
  eq(numberedEach('1, 4', [3, 5]), [[1, 2], [1, 2, 4]], 'page only in the longest');
  eq(numberedEach('1-3', [2, 4]), [[], [3]], 'all of the shorter');
  throwsKey(() => numberedEach('cover', [2, 4, 3]), 'pdf_pages_format', 'words');
  const beyond = throwsKey(() => numberedEach('5', [2, 4, 3]), 'pdf_pages_range', 'beyond the longest');
  eq(beyond.args, [4], 'the longest PDF\'s pages');
  eq(beyond.problem, 'OUT_OF_RANGE', 'problem');
  throwsKey(() => numberedPages('cover', 4), 'pdf_pages_format', 'one: words');
  throwsKey(() => numberedPages('5', 4), 'pdf_pages_range', 'one: beyond');
  throwsKey(() => numberedPages('3-2', 4), 'pdf_pages_reversed', 'one: reversed');
  let refused = false;
  try { numberedEach('1', []); } catch (e) { refused = e instanceof RangeError; }
  assert(refused, 'no PDFs');
});

await test('numbers sit inside the margin; the watermark runs along the diagonal and stays on the page', () => {
  // A4: the margin is half an inch; a small page gets a smaller one.
  near(numberMargin(595, 842), 35.7, 0.01, 'A4');
  near(numberMargin(842, 1190), 36, 0.01, 'A3');
  near(numberMargin(200, 300), 12, 0.01, 'small');
  const [w, h] = [600, 800]; // margin 36
  point([36, 36], numberOrigin('bottom-left', w, h, 20, 10), 'bottom left');
  point([290, 36], numberOrigin('bottom-center', w, h, 20, 10), 'bottom center');
  point([544, 36], numberOrigin('bottom-right', w, h, 20, 10), 'bottom right');
  point([36, 754], numberOrigin('top-left', w, h, 20, 10), 'top left');
  point([290, 754], numberOrigin('TOP_CENTER', w, h, 20, 10), 'top center (the app\'s name)');
  point([544, 754], numberOrigin('top-right', w, h, 20, 10), 'top right');
  eq(Object.keys(PAGE_NUMBER_POSITIONS).length, 6, 'six places');
  eq(PAGE_NUMBER_SIZES, { small: 9, medium: 12, large: 16 }, 'sizes');

  // A long text on A4 is limited by the diagonal.
  const long = placeWatermark(595, 842, 1000, 50);
  near(long.centerX, 297.5, 0.01, 'centre x');
  near(long.centerY, 421, 0.01, 'centre y');
  near(long.degrees, 54.75, 0.01, 'angle');
  near(long.scale, 0.7 * 1031.0 / 1000, 0.001, 'scale by the diagonal');
  // A short word is limited by its height.
  near(placeWatermark(595, 842, 100, 50).scale, 0.18 * 595 / 50, 0.001, 'scale by the height');
  // Landscape pages tilt less.
  near(placeWatermark(842, 595, 1000, 50).degrees, 35.25, 0.01, 'landscape');
  for (const [pw, ph] of [[595, 842], [842, 595], [300, 300], [200, 1000]]) {
    for (const [sw, sh] of [[1000, 50], [100, 50], [300, 100]]) {
      const p = placeWatermark(pw, ph, sw, sh);
      const a = p.degrees * Math.PI / 180;
      const hw = sw * p.scale / 2;
      const hh = sh * p.scale / 2;
      for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
        const x = p.centerX + dx * Math.cos(a) - dy * Math.sin(a);
        const y = p.centerY + dx * Math.sin(a) + dy * Math.cos(a);
        assert(x >= 0 && x <= pw && y >= 0 && y <= ph, `corner (${x}, ${y}) of ${sw}×${sh} is off the ${pw}×${ph} page`);
      }
    }
  }
  eq(WATERMARK_COLORS, { gray: '#757575', black: '#000000', red: '#d32f2f', blue: '#1565c0', green: '#2e7d32' }, 'colours');
  eq(WATERMARK_OPACITIES, { translucent: 0.3, semi: 0.6, opaque: 1 }, 'opacities');
});

await test('names: each PDF after its own, told apart when two ask for one', () => {
  eq(defaultName('page-numbers', { name: 'Report.pdf' }), 'Report_numbered', 'numbered');
  eq(defaultName('watermark', { name: 'alpha.pdf' }), 'alpha_watermarked', 'watermarked');
  eq(defaultName('watermark'), 'Usugami_watermarked', 'no PDF');
  // A long name is cut, not its ending.
  const long = defaultName('page-numbers', { name: 'x'.repeat(300) + '.pdf' });
  assert(long.endsWith('_numbered') && new TextEncoder().encode(long).length <= 200, 'long name cut');
  // The engine's FileNames.uniqueNames, as PdfEditingDeviceTest names them.
  eq(outputNames('page-numbers', ['Numbered', 'numbered.pdf']), ['Numbered', 'numbered (2)'], 'told apart');
  eq(outputNames('watermark', ['Draft', ' draft ', '']), ['Draft', 'draft (2)', 'Watermarked'], 'cleaned');
  eq(BATCH_NAMES, { 'page-numbers': 'Numbered_PDFs', watermark: 'Watermarked_PDFs' }, 'ZIP names');
});

await test('strings: the app\'s keys and English texts', async () => {
  const xml = await readFile(join(root, '..', 'pdfer', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8').catch(() => null);
  const android = (value) => value.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/%(\d)\$[sd]/g, '{$1}').replace(/%[sd]/g, '{1}');
  for (const [key, value] of Object.entries({ ...pageNumberOwn, ...watermarkOwn })) {
    assert(!(key in common), `${key} isn't redefined from common.js`);
    if (key.startsWith('web_') || !xml) continue;
    if (typeof value === 'string') {
      const m = xml.match(new RegExp(`<string name="${key}"[^>]*>([\\s\\S]*?)</string>`));
      assert(m, `${key} is in strings.xml`);
      eq(value, android(m[1]), `${key} as in strings.xml`);
    } else {
      const m = xml.match(new RegExp(`<plurals name="${key}">([\\s\\S]*?)</plurals>`));
      assert(m, `${key} is a plural in strings.xml`);
      const items = Object.fromEntries([...m[1].matchAll(/<item quantity="(\w+)">([\s\S]*?)<\/item>/g)].map((x) => [x[1], android(x[2])]));
      eq(value, items, `${key} as in strings.xml`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Fixtures

/**
 * Pages of every kind, each with a caption in the middle (PdfEditingDeviceTest's mixedPages, and more):
 * size in points, crop box [x, y, w, h], /Rotate, and a page whose drawing leaves its state set.
 */
const MIXED = [
  { size: [595, 842] },
  { size: [595, 842], rotate: 90 },
  { size: [595, 842], crop: [100, 100, 395, 642] },
  { size: [842, 595], rotate: 270 },
  { size: [595, 842], rotate: 180 },
  { size: [612, 792], crop: [50, 60, 400, 500], rotate: 90 },
  { size: [200, 300] },
  { size: [595, 842], dangling: true },
];

/** The page as shown, as the engine and viewers see it. */
function shownFrame(spec) {
  const [w, h] = spec.size;
  const [x, y, cw, ch] = spec.crop ?? [0, 0, w, h];
  return new PageFrame(x, y, cw, ch, spec.rotate ?? 0);
}

async function makePdf(specs, { encrypt } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  specs.forEach((spec, i) => {
    const [w, h] = spec.size;
    const page = doc.addPage([w, h]);
    if (spec.caption !== false) {
      const text = spec.caption ?? `CAPTION ${String.fromCharCode(65 + i)}`;
      page.drawText(text, { x: w / 2 - 40, y: h / 2, size: Math.min(14, w / 12), font });
    }
    if (spec.crop) page.setCropBox(...spec.crop);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (spec.dangling) {
      // Red, at half size, left set at the end of the page's drawing.
      page.node.addContentStream(doc.context.register(doc.context.flateStream('1 0 0 rg 1 0 0 RG 0.5 0 0 0.5 0 0 cm')));
    }
  });
  if (encrypt) await doc.encrypt({ userPassword: encrypt, ownerPassword: encrypt + '-owner' });
  return doc.save();
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// What the tests run in the page: the engine, and pdf.js reading and drawing the results.
const HELPERS = `(() => {
  const base = new URL('./', location.href);
  const mod = (p) => import(new URL(p, base).href);
  const toBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const docs = new Map();
  async function open(data, password) {
    const key = (password || '') + ':' + data;
    if (docs.has(key)) return docs.get(key);
    const { openPdfJs } = await mod('js/lib/pdfjs.js');
    const doc = await openPdfJs(toBytes(data), password ? { password } : {});
    // A few kept: the page drawn before is compared with many drawn after.
    if (docs.size > 6) {
      const [oldest] = docs.keys();
      docs.get(oldest).loadingTask.destroy();
      docs.delete(oldest);
    }
    docs.set(key, doc);
    return doc;
  }
  async function render(doc, i, scale) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    await page.render({ canvas: c, viewport: vp, background: '#ffffff' }).promise;
    return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  }
  /** The pixels that changed: how many, where, their middle and slant, and their commonest colour. */
  function changes(before, after, threshold = 20) {
    const w = after.width, h = after.height, A = after.data, B = before?.data;
    let n = 0, sx = 0, sy = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    const colors = new Map();
    const hit = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const d = B ? Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2]))
        : Math.max(255 - A[k], 255 - A[k + 1], 255 - A[k + 2]);
      if (d <= threshold) continue;
      hit[y * w + x] = 1;
      n++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      const c = (A[k] << 16) | (A[k + 1] << 8) | A[k + 2];
      colors.set(c, (colors.get(c) || 0) + 1);
    }
    if (!n) return { n, width: w, height: h };
    const cx = sx / n, cy = sy / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      if (!hit[y * w + x]) continue;
      sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy);
    }
    let mode = 0, best = -1, darkest = 0xffffff, dark = 766;
    for (const [c, k] of colors) {
      if (k > best) { best = k; mode = c; }
      const sum = (c >> 16) + ((c >> 8) & 255) + (c & 255);
      if (sum < dark) { dark = sum; darkest = c; }
    }
    return { n, width: w, height: h, minX, minY, maxX: maxX + 1, maxY: maxY + 1, cx: cx + 0.5, cy: cy + 0.5,
      angle: 0.5 * Math.atan2(2 * sxy, sxx - syy) * 180 / Math.PI, mode: [mode >> 16, (mode >> 8) & 255, mode & 255],
      darkest: [darkest >> 16, (darkest >> 8) & 255, darkest & 255] };
  }
  window.__st = {
    async run(fn, data, opts = {}, { password, abort, name = 'test.pdf' } = {}) {
      const m = await mod('js/engine/stamps.js');
      const controller = new AbortController();
      if (abort) controller.abort();
      let progress = 0;
      try {
        const out = await m[fn]({ name, bytes: toBytes(data), password }, opts, { signal: controller.signal, onProgress: () => { progress++; } });
        return { name: out.name, pageCount: out.pageCount, passwordRemoved: !!out.passwordRemoved, type: out.type, b64: toB64(out.bytes), size: out.bytes.length, progress };
      } catch (e) {
        return { error: { name: e.name, key: e.key ?? null, args: e.args ?? [], message: e.message } };
      }
    },
    async call(fn, ...args) {
      const m = await mod('js/engine/stamps.js');
      return m[fn](...args);
    },
    /** Each page's size as shown and its text, placed on the page as shown (points, y down). */
    async texts(data, password) {
      const doc = await open(data, password);
      const { pdfjsLib } = await mod('js/lib/pdfjs.js');
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        pages.push({
          width: vp.width, height: vp.height,
          items: tc.items.filter((it) => it.str).map((it) => {
            const m = pdfjsLib.Util.transform(vp.transform, it.transform);
            return { str: it.str, x: m[4], y: m[5], a: m[0], b: m[1], d: m[3], size: Math.hypot(m[0], m[1]), width: it.width };
          }),
          text: tc.items.map((it) => it.str).join(''),
        });
      }
      return pages;
    },
    /** What changed on each page from \`before\` (null: a white page) to \`after\`, drawn at \`scale\`. */
    async changes(beforeData, afterData, scale, pages, password) {
      const after = await open(afterData);
      const before = beforeData ? await open(beforeData, password) : null;
      const out = [];
      for (const i of pages ?? Array.from({ length: after.numPages }, (_, k) => k)) {
        const a = await render(after, i, scale);
        const b = before ? await render(before, i, scale) : null;
        out.push(changes(b, a));
      }
      return out;
    },
    /** The watermark preview drawn on a canvas: what paintWatermark draws, as the PDF has it. */
    async preview(text, color, width, height) {
      const m = await mod('js/engine/stamps.js');
      const stamp = await m.watermarkStamp(text, color);
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      m.paintWatermark(ctx, stamp, width, height);
      const img = ctx.getImageData(0, 0, width, height);
      // On white, as the page under it.
      const white = new ImageData(width, height);
      for (let k = 0; k < img.data.length; k += 4) {
        const a = img.data[k + 3] / 255;
        for (let j = 0; j < 3; j++) white.data[k + j] = Math.round(img.data[k + j] * a + 255 * (1 - a));
        white.data[k + 3] = 255;
      }
      return changes(null, white);
    },
  };
})()`;

async function engineTests(browser) {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/');
    await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
    await page.evaluate(HELPERS);
    const run = (fn, bytes, opts, extra) => page.evaluate(([f, d, o, e]) => window.__st.run(f, d, o, e), [fn, typeof bytes === 'string' ? bytes : b64(bytes), opts, extra ?? {}]);
    const texts = (data, password) => page.evaluate(([d, p]) => window.__st.texts(d, p), [data, password]);
    const changes = (before, after, scale, pages, password) => page.evaluate(([b, a, s, p, w]) => window.__st.changes(b, a, s, p, w), [before, after, scale, pages ?? null, password]);
    const full = browser === 'chromium';

    const mixed = b64(await makePdf(MIXED));
    const frames = MIXED.map(shownFrame);
    const digitsOn = (pageText, label) => pageText.items.filter((it) => /^\d+$/.test(it.str.trim()) && it.str.trim() === label);

    await test(`${browser}: numbers in every position and size land where the reader sees them`, async () => {
      const positions = Object.keys(PAGE_NUMBER_POSITIONS);
      const sizes = Object.keys(PAGE_NUMBER_SIZES);
      const combos = [];
      for (const position of positions) for (const size of sizes) combos.push([position, size]);
      for (const [position, size] of full ? combos : [['bottom-right', 'medium'], ['top-left', 'large']]) {
        const out = await run('addPageNumbers', mixed, { position, size });
        assert(!out.error, `${position} ${size}: ${JSON.stringify(out.error)}`);
        eq([out.name, out.pageCount, out.type], ['test_numbered.pdf', MIXED.length, 'application/pdf'], 'output');
        assert(out.progress >= MIXED.length, 'progress for each page');
        const points = PAGE_NUMBER_SIZES[size];
        const { top, column } = PAGE_NUMBER_POSITIONS[position];
        const pages = await texts(out.b64);
        // Pixels only for the large numbers and every size at the bottom centre (enough to see them all).
        const drawn = full && (size === 'large' || position === 'bottom-center')
          ? await changes(mixed, out.b64, 2) : null;
        for (let i = 0; i < MIXED.length; i++) {
          const f = frames[i];
          const W = f.shownWidth;
          const H = f.shownHeight;
          const where = `${position} ${size} page ${i + 1}`;
          near(pages[i].width, W, 0.01, `${where}: shown width`);
          near(pages[i].height, H, 0.01, `${where}: shown height`);
          const margin = numberMargin(W, H);
          const [digit] = digitsOn(pages[i], String(i + 1));
          assert(digit, `${where}: its own number as text (${JSON.stringify(pages[i].items.map((x) => x.str))})`);
          // Upright for the reader, at its size.
          assert(digit.a > 0 && Math.abs(digit.b) < 0.01 * digit.a && digit.d < 0, `${where}: upright`);
          near(digit.size, points, 0.05, `${where}: size`);
          const baseline = top ? margin + CAP * points : H - margin;
          near(digit.y, baseline, 0.6, `${where}: baseline`);
          if (column === 0) near(digit.x, margin, 0.6, `${where}: left`);
          if (column === 1) near(digit.x + digit.width / 2, W / 2, 1, `${where}: centred`);
          if (column === 2) near(digit.x + digit.width, W - margin, 1, `${where}: right`);
          if (drawn) {
            const c = drawn[i];
            const s = 2;
            assert(c.n > 10, `${where}: drawn`);
            // Only the number changed: its ink sits on the baseline (or hangs from the margin), digit-tall.
            near(c.maxY / s, top ? margin + CAP * points : H - margin, 1.2, `${where}: ink bottom`);
            near((c.maxY - c.minY) / s, CAP * points, 1.3, `${where}: ink height`);
            // The number's advance is placed; its ink is in by a digit's side bearing at most.
            const bearing = 0.25 * points;
            if (column === 0) assert(c.minX / s >= margin - 0.5 && c.minX / s <= margin + bearing, `${where}: ink left ${c.minX / s}`);
            if (column === 1) near((c.minX + c.maxX) / 2 / s, W / 2, 1.5, `${where}: ink centred`);
            if (column === 2) assert(c.maxX / s <= W - margin + 0.5 && c.maxX / s >= W - margin - bearing, `${where}: ink right ${c.maxX / s}`);
            // Black, even where the page's drawing left red set.
            assert(Math.max(...c.darkest) < 60, `${where}: black, not ${c.darkest}`);
          }
        }
      }
      if (full) await saveOutput('stamps-numbers-mixed.pdf', Buffer.from((await run('addPageNumbers', mixed, { position: 'bottom-right', size: 'medium' })).b64, 'base64'));
    });

    await test(`${browser}: skipped pages get no number, the others their own`, async () => {
      // PdfEditingDeviceTest.pageNumbersFollowThePageAsShown: page 1 skipped.
      const out = await run('addPageNumbers', mixed, { skip: '1', position: 'bottom-right', size: 'medium' });
      const pages = await texts(out.b64);
      eq(pages.map((p, i) => digitsOn(p, String(i + 1)).length), [0, 1, 1, 1, 1, 1, 1, 1], 'numbers');
      const some = await run('addPageNumbers', mixed, { skip: '1, 3-4, 8', position: 'top-center' });
      const again = await texts(some.b64);
      eq(again.map((p, i) => digitsOn(p, String(i + 1)).length), [0, 1, 0, 0, 1, 1, 1, 0], 'skip several');
      if (full) {
        const drawn = await changes(mixed, some.b64, 1);
        eq(drawn.map((c) => c.n > 0), [false, true, false, false, true, true, true, false], 'nothing drawn on skipped pages');
      }
      // Zero-based pages, as the screen hands them; ones the PDF doesn't have are passed over.
      const listed = await run('addPageNumbers', mixed, { pages: [6, 1, 1, 99] });
      eq((await texts(listed.b64)).map((p, i) => digitsOn(p, String(i + 1)).length), [0, 1, 0, 0, 0, 0, 1, 0], 'pages listed');
      const all = await run('addPageNumbers', mixed, { skip: '1-8' });
      eq(all.error?.key, 'page_numbers_all_skipped', 'every page skipped');
      const none = await run('addPageNumbers', mixed, { pages: [] });
      eq(none.error?.key, 'page_numbers_all_skipped', 'no pages');
      const words = await run('addPageNumbers', mixed, { skip: 'cover' });
      eq(words.error?.key, 'pdf_pages_format', 'words');
      const beyond = await run('addPageNumbers', mixed, { skip: '9' });
      eq([beyond.error?.key, beyond.error?.args], ['pdf_pages_range', [8]], 'beyond the PDF');
    });

    await test(`${browser}: several PDFs, the pages to skip read against the longest`, async () => {
      // BatchToolsDeviceTest.pagesToSkipGoForEveryPdfThatHasThem: three pages, two, one; "1, 3".
      const three = b64(await makePdf([{ size: [595, 842] }, { size: [595, 842] }, { size: [595, 842] }]));
      const two = b64(await makePdf([{ size: [595, 842] }, { size: [842, 595] }]));
      const one = b64(await makePdf([{ size: [400, 400], caption: 'COVER' }]));
      const counts = [3, 2, 1];
      eq(numberedEach('1, 3', counts), [[1], [1], []], 'as the screen checks them');
      const made = [];
      for (const [i, data] of [three, two, one].entries()) {
        made.push(await run('addPageNumbers', data, { skip: '1, 3', skipAgainst: 3, position: 'bottom-right', fileName: ['alpha_numbered', 'beta_numbered', 'cover_numbered'][i] }));
      }
      eq(made[2].error?.key, 'page_numbers_all_skipped', 'the one-page PDF is left out');
      eq(made.slice(0, 2).map((m) => m.name), ['alpha_numbered.pdf', 'beta_numbered.pdf'], 'names');
      const corner = async (data) => (await texts(data)).map((p) => p.items.filter((it) => /^\d+$/.test(it.str) && it.x > p.width - 100 && it.y > p.height - 72).map((it) => it.str).join(''));
      eq(await corner(made[0].b64), ['', '2', ''], 'each page its own number, the skipped ones none');
      eq(await corner(made[1].b64), ['', '2'], 'the shorter PDF has no page 3 to skip');
      // "4" is beyond the longest: the screen says so before anything is made.
      throwsKey(() => numberedEach('4', counts), 'pdf_pages_range', 'beyond the longest');
    });

    await test(`${browser}: protected, damaged and cancelled`, async () => {
      const locked = b64(await makePdf([{ size: [595, 842] }, { size: [595, 842], rotate: 90 }], { encrypt: 'test123' }));
      const wrong = await run('addPageNumbers', locked, {}, { password: 'nope' });
      eq(wrong.error?.name, 'PasswordError', 'wrong password');
      const out = await run('addPageNumbers', locked, {}, { password: 'test123' });
      assert(!out.error, JSON.stringify(out.error));
      eq(out.passwordRemoved, true, 'the password is removed');
      const plain = await texts(out.b64);
      eq(plain.map((p, i) => digitsOn(p, String(i + 1)).length), [1, 1], 'opens without a password, numbered');
      const marked = await run('addWatermark', locked, { text: 'COPY' }, { password: 'test123' });
      eq(marked.passwordRemoved, true, 'watermark: the password is removed');
      for (const fn of ['addPageNumbers', 'addWatermark']) {
        const damaged = await run(fn, b64(Buffer.from('%PDF-1.4 nothing else')), { text: 'Draft' });
        eq(damaged.error?.key, 'pdf_import_failed', `${fn}: damaged`);
        const notPdf = await run(fn, b64(Buffer.from('hello')), { text: 'Draft' });
        eq(notPdf.error?.key, 'pdf_import_failed', `${fn}: not a PDF`);
        const cancelled = await run(fn, mixed, { text: 'Draft' }, { abort: true });
        eq(cancelled.error?.name, 'CancelledError', `${fn}: cancelled`);
      }
      // A page tree that miscounts and a page without its type are read as viewers read them.
      const doc = await PDFDocument.load(Buffer.from(mixed, 'base64'));
      const pages = doc.catalog.lookup(PDFName.of('Pages'));
      pages.set(PDFName.of('Count'), doc.context.obj(99));
      doc.getPages()[2].node.delete(PDFName.of('Type'));
      const broken = b64(await doc.save({ useObjectStreams: false }));
      const mended = await run('addPageNumbers', broken, {});
      assert(!mended.error, `mended: ${JSON.stringify(mended.error)}`);
      eq(mended.pageCount, MIXED.length, 'every page found');
      eq((await texts(mended.b64)).map((p, i) => digitsOn(p, String(i + 1)).length), MIXED.map(() => 1), 'every page numbered');
    });

    const blank = b64(await makePdf([{ size: [595, 842], caption: false }]));
    const ALPHA_TOLERANCE = 14;
    await test(`${browser}: watermarks in each colour and opacity`, async () => {
      for (const [color, hex] of Object.entries(WATERMARK_COLORS)) {
        for (const [opacity, alpha] of Object.entries(WATERMARK_OPACITIES)) {
          if (!full && !(color === 'red' && opacity === 'translucent') && !(color === 'blue' && opacity === 'opaque')) continue;
          const out = await run('addWatermark', blank, { text: 'DRAFT', color, opacity });
          assert(!out.error, `${color} ${opacity}: ${JSON.stringify(out.error)}`);
          eq(out.name, 'test_watermarked.pdf', 'name');
          const [c] = await changes(null, out.b64, 0.5);
          assert(c.n > 2000, `${color} ${opacity}: a large watermark (${c.n} pixels)`);
          // Its colour over white, as see-through as chosen.
          const rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
          const expected = rgb.map((v) => Math.round(v * alpha + 255 * (1 - alpha)));
          for (let j = 0; j < 3; j++) near(c.mode[j], expected[j], ALPHA_TOLERANCE, `${color} ${opacity}: channel ${j} of ${c.mode}`);
          if (full && opacity === 'translucent') await saveOutput(`stamps-watermark-${color}.pdf`, Buffer.from(out.b64, 'base64'));
        }
      }
    });

    await test(`${browser}: the watermark crosses every page along its diagonal, as real text`, async () => {
      // PdfEditingDeviceTest.watermarkCrossesEveryPageAlongItsDiagonal.
      const out = await run('addWatermark', mixed, { text: 'Brouillon é ñ', color: 'red', opacity: 'translucent' });
      assert(!out.error, JSON.stringify(out.error));
      eq(out.pageCount, MIXED.length, 'pages');
      const pages = await texts(out.b64);
      // Real text, accents included, after each page's caption.
      for (const [i, p] of pages.entries()) {
        const text = p.text.replace(/\s/g, '');
        assert(text.includes('Brouillonéñ'), `page ${i + 1}: ${text}`);
        assert(text.indexOf('CAPTION') < text.indexOf('Brouillon'), `page ${i + 1}: after the caption`);
      }
      if (full) {
        await saveOutput('stamps-watermark-mixed.pdf', Buffer.from(out.b64, 'base64'));
        const drawn = await changes(mixed, out.b64, 1);
        for (const [i, c] of drawn.entries()) {
          const f = frames[i];
          assert(c.n > 500, `page ${i + 1}: drawn (${c.n})`);
          // Centred, and running from the bottom-left corner as shown to the top-right one.
          near(c.cx, f.shownWidth / 2, f.shownWidth * 0.04, `page ${i + 1}: centre x`);
          near(c.cy, f.shownHeight / 2, f.shownHeight * 0.04, `page ${i + 1}: centre y`);
          const diagonal = Math.atan2(f.shownHeight, f.shownWidth) * 180 / Math.PI;
          // y points down here, so rising to the right is a negative angle.
          near(c.angle, -diagonal, 3, `page ${i + 1}: angle`);
          // Translucent: the page shows through, so the red is light.
          assert(c.mode[1] > 140, `page ${i + 1}: light red ${c.mode}`);
          // Within the page and no larger than the share of it the app allows.
          assert(c.minX > 0 && c.minY > 0 && c.maxX < c.width && c.maxY < c.height, `page ${i + 1}: inside the page`);
        }
      }
    });

    await test(`${browser}: Hindi is shaped and copies back in order; text no font has is refused`, async () => {
      const words = 'गोपनीय प्रति';
      const out = await run('addWatermark', mixed, { text: words, color: 'gray', opacity: 'semi' });
      assert(!out.error, JSON.stringify(out.error));
      const pages = await texts(out.b64);
      for (const [i, p] of pages.entries()) {
        const text = p.text.replace(/\s/g, '');
        assert(text.startsWith('CAPTION'), `page ${i + 1} starts with its caption`);
        assert(text.includes('गोपनीयप्रति'), `page ${i + 1}: ${text}`);
      }
      if (full) {
        await saveOutput('stamps-watermark-hindi.pdf', Buffer.from(out.b64, 'base64'));
        const [c] = await changes(mixed, out.b64, 1, [0]);
        assert(c.n > 2000, 'drawn');
        // Semi-opaque gray: 60 % of #757575 over white.
        near(c.mode[0], Math.round(0x75 * 0.6 + 255 * 0.4), ALPHA_TOLERANCE, `gray ${c.mode}`);
        eq(c.mode[0], c.mode[1], 'gray, not tinted');
      }
      for (const text of ['Confidential é ñ ç ß', 'गोपनीय क्षत्रिय', 'DRAFT']) {
        eq(await page.evaluate((t) => window.__st.call('canDrawWatermark', t), text), true, `can draw ${text}`);
      }
      // Firefox draws a missing character as a box with its code in it, which the text engine
      // can't tell from a character (see the API notes).
      if (browser !== 'firefox') {
        eq(await page.evaluate(() => window.__st.call('canDrawWatermark', 'Draft ͸')), false, 'a character no font has');
        const refused = await run('addWatermark', mixed, { text: '͸͹' });
        eq(refused.error?.key, 'watermark_no_font', 'refused');
      }
      const blankText = await run('addWatermark', mixed, { text: '   ' });
      eq(blankText.error?.name, 'RangeError', 'blank text');
      const tooLong = await run('addWatermark', mixed, { text: 'x'.repeat(81) });
      eq(tooLong.error?.name, 'RangeError', 'longer than 80');
      const longest = await run('addWatermark', blank, { text: 'W'.repeat(80) });
      assert(!longest.error, '80 characters');
    });

    await test(`${browser}: the watermark is drawn once and shown on every page; long PDFs stay quick`, async () => {
      const many = b64(await makePdf(Array.from({ length: 120 }, () => ({ size: [595, 842] }))));
      const started = Date.now();
      const out = await run('addWatermark', many, { text: 'CONFIDENTIAL', color: 'blue' });
      const secs = (Date.now() - started) / 1000;
      assert(!out.error, JSON.stringify(out.error));
      eq(out.progress, 121, 'progress for each page and the save');
      const doc = await PDFDocument.load(Buffer.from(out.b64, 'base64'));
      let forms = 0;
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) forms++;
      }
      eq(forms, 1, 'one form for every page');
      const before = (Buffer.from(many, 'base64')).length;
      assert((out.size - before) / 120 < 400, `small: ${out.size - before} bytes more`);
      log(`${browser}: 120 pages watermarked in ${secs.toFixed(1)} s (+${((out.size - before) / 1024).toFixed(1)} KB)`);
      const numbered = await run('addPageNumbers', many, {});
      eq(numbered.progress, 121, 'numbers: progress for each page and the save');
      assert(secs < 30, 'quick');
    });

    if (full) {
      await test(`${browser}: the preview draws the watermark where the PDF has it`, async () => {
        const out = await run('addWatermark', blank, { text: 'DRAFT', color: 'red', opacity: 'opaque' });
        const [pdf] = await changes(null, out.b64, 0.5);
        // The preview at the page's size in pixels (595 × 842 at 0.5).
        const shown = await page.evaluate(() => window.__st.preview('DRAFT', 'red', 298, 421));
        near(shown.cx, pdf.cx, 2, 'centre x');
        near(shown.cy, pdf.cy, 2, 'centre y');
        near(shown.angle, pdf.angle, 1.5, 'angle');
        near(shown.maxX - shown.minX, pdf.maxX - pdf.minX, 4, 'as wide');
        near(shown.n, pdf.n, pdf.n * 0.08, 'as much ink');
      });
    }
  }, { browser });
}

await engineTests('chromium');
if (!quick) {
  await test('firefox: engine', () => engineTests('firefox'));
  await test('webkit: engine', () => engineTests('webkit'));
}

// ---------------------------------------------------------------------------------------------
// The screens

const alphaPdf = Buffer.from(await makePdf([{ size: [595, 842], caption: 'ALPHA ONE' }, { size: [595, 842], caption: 'ALPHA TWO' }, { size: [595, 842], caption: 'ALPHA THREE' }]));
const betaPdf = Buffer.from(await makePdf([{ size: [842, 595], caption: 'BETA ONE' }, { size: [595, 842], rotate: 90, caption: 'BETA TWO' }]));
const coverPdf = Buffer.from(await makePdf([{ size: [400, 560], caption: 'COVER' }]));
const lockedPdf = Buffer.from(await makePdf([{ size: [595, 842], caption: 'LOCKED' }], { encrypt: 'test123' }));
const file = (name, buffer) => ({ name, mimeType: 'application/pdf', buffer });

async function openTool(page, url, tool) {
  await page.goto(url + 'app/#/tool/' + tool);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  await page.waitForSelector(`#app > .screen[data-tool="${tool}"]:not([aria-busy])`, { timeout: 15000 });
  await page.evaluate(HELPERS);
}

async function pick(page, selector, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await chooser.setFiles(files);
}

/** Drops `files` on `selector`, as dragged from the computer's files. */
async function drop(page, selector, files) {
  await page.evaluate(({ selector: sel, files: list }) => {
    const data = new DataTransfer();
    for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.mimeType }));
    const target = document.querySelector(sel);
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, { selector, files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, b64: b64(f.buffer) })) });
}

/**
 * Adds files as the user would: through the file input `selector` opens, in every browser (the kit
 * takes the files of Playwright's Firefox, which sends the input's cancel event just before its
 * change event), or with `dropped` dropped there (Add PDFs: on the screen) as from a file manager.
 */
async function addFiles(page, browser, selector, files, { dropped = false } = {}) {
  if (!dropped) await pick(page, selector, files);
  else await drop(page, selector === '.stamps-add' ? '.stamps-page' : selector, files);
}

/** Waits until the snackbar showing has come to rest above the bottom bar, as the app's Scaffold puts it. */
async function snackAboveBar(page) {
  await page.waitForFunction(() => {
    const bar = document.querySelector('.ui-bottombar')?.getBoundingClientRect();
    const snack = document.querySelector('.ui-snackbar.is-shown')?.getBoundingClientRect();
    return bar && snack && snack.height > 0 && snack.bottom <= bar.top + 0.5;
  }, null, { timeout: 5000 });
}

async function snack(page, text) {
  await page.waitForFunction((t) => [...document.querySelectorAll('.ui-snackbar-text')].some((e) => e.textContent === t), text, { timeout: 25000 });
}

async function shot(page, name, { scheme, fullPage = true } = {}) {
  if (quick) return;
  for (const s of scheme ? [scheme] : ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: s });
    await page.waitForTimeout(250);
    await saveOutput(`stamps-${name}-${s}.png`, await page.screenshot({ fullPage }));
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Taps the main button, then moves the pointer away (a snackbar under the pointer stays). */
async function press(page) {
  await page.click('.ui-bottombar .ui-btn');
  await page.mouse.move(1, 1);
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** Saves the result's PDFs with Save to Downloads and gives their names and bytes. */
async function saveAll(page, count) {
  const downloads = [];
  const got = new Promise((resolve) => {
    page.on('download', async (d) => {
      downloads.push({ name: d.suggestedFilename(), bytes: await readFile(await d.path()) });
      if (downloads.length === count) resolve();
    });
  });
  await page.getByRole('button', { name: common.save_to_downloads, exact: true }).first().click();
  await got;
  return downloads;
}

async function screenTests(browser, label, viewport) {
  const tag = `${browser}-${label}`;
  const wide = viewport.width >= 840;

  await test(`${tag}: Add page numbers, from picking a PDF to the result`, async () => {
    await withPage(async (page, url) => {
      await openTool(page, url, 'page-numbers');
      eq(await page.textContent('#app h1'), common.tool_page_numbers, 'title');
      assert(await page.isVisible('.ui-empty'), 'Choose PDFs');
      eq((await page.textContent('.ui-empty')).includes(common.pick_several_hint), true, 'several at once');
      eq(await page.isDisabled('.ui-bottombar .ui-btn'), true, 'nothing to number yet');
      if (browser === 'chromium') await shot(page, `numbers-empty-${label}`, { fullPage: false });

      await addFiles(page, browser, '.ui-empty', [file('alpha.pdf', alphaPdf)]);
      await page.waitForSelector('.ui-file-card');
      eq((await page.textContent('.ui-file-card .ui-file-detail')).startsWith('3 pages'), true, 'pages');
      eq(await page.getByLabel(kitFileName).inputValue(), 'alpha_numbered', 'its PDF\'s name');
      // Bottom center is chosen first; each spot is a radio button named after its place.
      const radio = (name) => page.getByRole('radio', { name, exact: true });
      eq(await radio(pageNumberStrings.position_bottom_center).getAttribute('aria-checked'), 'true', 'bottom center first');
      eq(await page.getByRole('radio').count(), 6 + 3, 'six places and three sizes');
      eq(await radio(pageNumberStrings.number_size_medium).getAttribute('aria-checked'), 'true', 'medium first');
      eq(await page.textContent('.page-numbers-chosen'), pageNumberStrings.position_bottom_center, 'in words');
      // The arrow keys move between places as they sit on the page.
      await radio(pageNumberStrings.position_bottom_center).focus();
      await page.keyboard.press('ArrowUp');
      eq(await radio(pageNumberStrings.position_top_center).getAttribute('aria-checked'), 'true', 'up');
      await page.keyboard.press('ArrowLeft');
      eq(await radio(pageNumberStrings.position_top_left).getAttribute('aria-checked'), 'true', 'left');
      eq(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), pageNumberStrings.position_top_left, 'focus follows');
      await radio(pageNumberStrings.position_top_right).click();
      await radio(pageNumberStrings.position_top_left).click();
      eq(await page.textContent('.page-numbers-chosen'), pageNumberStrings.position_top_left, 'top left in words');
      await radio(pageNumberStrings.number_size_large).click();
      assert(await noSideScroll(page), 'no sideways scroll');
      if (browser === 'chromium') await shot(page, `numbers-one-${label}`);

      // Pages to skip it can't use are explained (ScreensDeviceTest.pageNumbersExplainBadPagesToSkip).
      const skip = page.getByLabel(pageNumberStrings.page_numbers_skip);
      await skip.fill('1-3');
      await press(page);
      await snack(page, pageNumberStrings.page_numbers_all_skipped);
      await skip.fill('7');
      await press(page);
      await snack(page, 'Pages must be between 1 and 3.');
      // Above the bottom bar, which the kit's snackbar measures (nothing set by the screen).
      await snackAboveBar(page);
      eq(await page.evaluate(() => document.documentElement.style.getPropertyValue('--snackbar-offset')), '', 'no lift of the screen\'s own');
      await skip.fill('1');
      await page.getByLabel(kitFileName).fill('Numbered report');
      await press(page);
      await page.waitForSelector('.ui-result', { timeout: 20000 });
      eq(await page.textContent('.ui-result-heading'), common.result_heading_one, 'result');
      eq(await page.textContent('.ui-result-name'), 'Numbered report.pdf', 'named as typed');
      if (browser === 'chromium') await shot(page, `numbers-result-${label}`);
      const [saved] = await saveAll(page, 1);
      eq(saved.name, 'Numbered report.pdf', 'saved');
      const pages = await page.evaluate((d) => window.__st.texts(d), b64(saved.bytes));
      // Page 1 skipped; the others numbered at the top left with their own numbers (ScreensDeviceTest).
      const numbers = pages.map((p) => p.items.filter((it) => /^\d+$/.test(it.str) && it.y < 72));
      eq(numbers[0].length, 0, 'page 1 skipped');
      for (const n of [2, 3]) {
        eq(numbers[n - 1].map((it) => it.str), [String(n)], `page ${n}`);
        assert(numbers[n - 1][0].x < 72, `page ${n} at the top left`);
        near(numbers[n - 1][0].size, 16, 0.05, `page ${n} large`);
      }
      // Back to editing keeps the choices.
      await page.getByRole('button', { name: common.back_to_editing }).click();
      await page.waitForSelector('.page-numbers-picker');
      eq(await radio(pageNumberStrings.position_top_left).getAttribute('aria-checked'), 'true', 'kept');
      eq(await skip.inputValue(), '1', 'skip kept');
      // The browser's Forward shows the result again, and its Back returns to editing.
      await page.goForward();
      await page.waitForSelector('.ui-result');
      eq(await page.textContent('.ui-result-name'), 'Numbered report.pdf', 'Forward: the result again');
      await page.goBack();
      await page.waitForSelector('.page-numbers-picker');
      eq(await page.evaluate(() => location.hash), '#/tool/page-numbers', 'Back: still in the tool');
      eq(await skip.inputValue(), '1', 'skip kept after Back');
    }, { browser, viewport });
  });

  await test(`${tag}: Add page numbers to several PDFs, one with every page skipped`, async () => {
    await withPage(async (page, url) => {
      await openTool(page, url, 'page-numbers');
      // Dropped on the card in Firefox and WebKit (they pick through the input elsewhere).
      await addFiles(page, browser, '.ui-empty', [file('alpha.pdf', alphaPdf), file('beta.pdf', betaPdf), file('cover.pdf', coverPdf)], { dropped: browser !== 'chromium' });
      await page.waitForSelector('.ui-batch-list');
      eq(await page.locator('.ui-batch-item').count(), 3, 'three PDFs');
      eq(await page.textContent('.ui-bottombar .ui-btn'), 'Add page numbers to 3 PDFs', 'button');
      assert(await page.isVisible('.stamps-hint'), 'the choices go for all');
      eq(await page.textContent('.stamps-hint'), pageNumberStrings.page_numbers_for_all_hint, 'hint');
      assert(await noSideScroll(page), 'no sideways scroll');
      if (wide) {
        // The PDFs on one side, the choices on the other.
        const [a, b] = await page.$$eval('.stamps-pane', (els) => els.map((e) => e.getBoundingClientRect().left));
        assert(b > a + 300, 'side by side');
      }
      const names = await page.$$eval('.ui-batch-item input', (els) => els.map((e) => e.value));
      eq(names, ['alpha_numbered', 'beta_numbered', 'cover_numbered'], 'each named after itself');
      await page.locator('.ui-batch-item input').nth(1).fill('Beta, numbered');
      if (browser === 'chromium') await shot(page, `numbers-many-${label}`);
      await page.getByLabel(pageNumberStrings.page_numbers_skip).fill('4');
      await press(page);
      await snack(page, 'Pages must be between 1 and 3.');
      await page.getByLabel(pageNumberStrings.page_numbers_skip).fill('1-3');
      await press(page);
      await snack(page, pageNumberStrings.page_numbers_all_skipped);
      await page.getByLabel(pageNumberStrings.page_numbers_skip).fill('1, 3');
      await press(page);
      await snack(page, 'No page is left to number in cover.pdf, so it was left out.');
      await page.waitForSelector('.ui-result');
      eq(await page.textContent('.ui-result-heading'), common.result_heading_many, 'result');
      eq(await page.$$eval('.ui-result-name', (els) => els.map((e) => e.textContent)), ['alpha_numbered.pdf', 'Beta, numbered.pdf'], 'the others are made');
      if (browser === 'chromium') await shot(page, `numbers-many-result-${label}`);
      const saved = await saveAll(page, 2);
      const byName = Object.fromEntries(saved.map((s) => [s.name, s.bytes]));
      const corner = async (bytes) => (await page.evaluate((d) => window.__st.texts(d), b64(bytes)))
        .map((p) => p.items.filter((it) => /^\d+$/.test(it.str) && it.y > p.height - 60).map((it) => it.str).join(''));
      eq(await corner(byName['alpha_numbered.pdf']), ['', '2', ''], 'alpha');
      eq(await corner(byName['Beta, numbered.pdf']), ['', '2'], 'beta');
      // Removing PDFs: down to one, the screen is the one-PDF screen again.
      await page.getByRole('button', { name: common.back_to_editing }).click();
      await page.waitForSelector('.ui-batch-list');
      // From the keyboard (Safari doesn't focus a button it clicks): the focus moves to the next card.
      await page.getByRole('button', { name: 'Remove cover.pdf' }).focus();
      await page.keyboard.press('Enter');
      eq(await page.locator('.ui-batch-item').count(), 2, 'removed');
      eq(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Remove beta.pdf', 'focus moves on');
      await page.getByRole('button', { name: 'Remove beta.pdf' }).click();
      await page.waitForSelector('.ui-batch-list', { state: 'detached' });
      eq(await page.textContent('.ui-bottombar .ui-btn'), pageNumberStrings.pdf_page_numbers_action, 'one PDF');
      await page.getByRole('button', { name: 'Remove alpha.pdf' }).click();
      await page.waitForSelector('.ui-empty');
    }, { browser, viewport });
  });

  await test(`${tag}: Add watermark, from picking a PDF to the result`, async () => {
    await withPage(async (page, url) => {
      await openTool(page, url, 'watermark');
      eq(await page.textContent('#app h1'), common.tool_watermark, 'title');
      // A PDF with a password: asked for, then worked on (and the result says it has none).
      await addFiles(page, browser, '.ui-empty', [file('statement.pdf', lockedPdf)]);
      await page.waitForSelector('dialog[open] input[type="password"]');
      await page.fill('dialog[open] input[type="password"]', 'test123');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.watermark-options');
      eq(await page.isDisabled('.ui-bottombar .ui-btn'), true, 'no watermark without text');
      const radio = (name) => page.getByRole('radio', { name, exact: true });
      for (const c of ['color_gray', 'color_black', 'color_red', 'color_blue', 'color_green']) {
        eq(await radio(watermarkStrings[c]).count(), 1, c);
      }
      eq(await radio(watermarkStrings.color_gray).getAttribute('aria-checked'), 'true', 'gray first');
      eq(await radio(watermarkStrings.opacity_translucent).getAttribute('aria-checked'), 'true', 'translucent first');
      await radio(watermarkStrings.color_red).click();
      await radio(watermarkStrings.opacity_opaque).click();
      // Arrow keys go round the colours.
      await radio(watermarkStrings.color_red).focus();
      await page.keyboard.press('ArrowRight');
      eq(await radio(watermarkStrings.color_blue).getAttribute('aria-checked'), 'true', 'arrow right');
      await page.keyboard.press('ArrowLeft');
      eq(await radio(watermarkStrings.color_red).getAttribute('aria-checked'), 'true', 'arrow left');

      // Text no font can draw is refused, with a message.
      const text = page.getByLabel(watermarkStrings.watermark_text);
      if (browser !== 'firefox') {
        await text.fill('͸');
        await press(page);
        await snack(page, watermarkStrings.web_watermark_no_font);
      }
      eq(await text.getAttribute('maxlength'), '80', 'at most 80 characters');
      await text.fill('Draft');
      eq(await page.isDisabled('.ui-bottombar .ui-btn'), false, 'ready');
      // The preview: page 1 with the watermark, red and opaque, along its diagonal.
      eq(await page.getAttribute('.watermark-preview', 'aria-label'), watermarkStrings.watermark_preview_description, 'described');
      await page.waitForFunction(() => {
        const c = document.querySelector('.watermark-preview-mark');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let k = 3; k < d.length; k += 16) if (d[k] > 200) return true;
        return false;
      }, null, { timeout: 10000 });
      const mark = await page.evaluate(() => {
        const c = document.querySelector('.watermark-preview-mark');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
          const k = (y * c.width + x) * 4;
          if (d[k + 3] < 250) continue;
          n++; sx += x; sy += y; r += d[k]; g += d[k + 1]; b += d[k + 2];
        }
        return { n, cx: sx / n / c.width, cy: sy / n / c.height, rgb: [r / n, g / n, b / n] };
      });
      assert(mark.n > 300, 'drawn');
      near(mark.cx, 0.5, 0.05, 'centred x');
      near(mark.cy, 0.5, 0.05, 'centred y');
      near(mark.rgb[0], 0xd3, 6, 'red');
      near(mark.rgb[1], 0x2f, 6, 'red green');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.watermark-preview-mark')).opacity === '1');
      await radio(watermarkStrings.opacity_translucent).click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.watermark-preview-mark')).opacity === '0.3');
      assert(await noSideScroll(page), 'no sideways scroll');
      if (browser === 'chromium') await shot(page, `watermark-one-${label}`);
      await radio(watermarkStrings.opacity_opaque).click();

      await press(page);
      await page.waitForSelector('.ui-result', { timeout: 20000 });
      eq(await page.textContent('.ui-result-name'), 'statement_watermarked.pdf', 'named after itself');
      assert((await page.textContent('.ui-result')).includes(common.pdf_password_removed.one), 'says the password is gone');
      const [saved] = await saveAll(page, 1);
      const pages = await page.evaluate((d) => window.__st.texts(d), b64(saved.bytes));
      for (const p of pages) assert(p.text.replace(/\s/g, '').includes('Draft'), `Draft on every page: ${p.text}`);
      const [drawn] = await page.evaluate((d) => window.__st.changes(null, d, 0.5), b64(saved.bytes));
      // Opaque red.
      near(drawn.mode[0], 0xd3, 14, 'opaque red');
      near(drawn.mode[1], 0x2f, 14, 'opaque red, green channel');
      // Start over asks nothing once saved, and empties the tool.
      await page.getByRole('button', { name: common.start_over }).click();
      await page.waitForSelector('.ui-empty');
    }, { browser, viewport });
  });

  await test(`${tag}: Add watermark to several PDFs, the preview showing the first`, async () => {
    await withPage(async (page, url) => {
      await openTool(page, url, 'watermark');
      await addFiles(page, browser, '.ui-empty', [file('beta.pdf', betaPdf)]);
      await page.waitForSelector('.watermark-options');
      await page.getByLabel(watermarkStrings.watermark_text).fill('गोपनीय प्रति');
      // On computers, dropped onto the screen; on phones, Add PDFs, picked through its input in every
      // browser (the kit waits 1.5 s after Playwright's Firefox's cancel event for its change event,
      // which comes late while the page lays out the Hindi preview).
      if (wide) await drop(page, '.stamps-page', [file('alpha.pdf', alphaPdf), file('cover.pdf', coverPdf)]);
      else await addFiles(page, browser, '.stamps-add', [file('alpha.pdf', alphaPdf), file('cover.pdf', coverPdf)]);
      await page.waitForSelector('.ui-batch-list');
      eq(await page.textContent('.ui-bottombar .ui-btn'), 'Add watermark to 3 PDFs', 'button');
      eq(await page.textContent('.stamps-hint'), watermarkStrings.watermark_for_all_hint, 'hint');
      // The preview keeps the first PDF's page: beta's first page is landscape.
      await page.waitForFunction(() => {
        const p = document.querySelector('.watermark-preview');
        return p && p.getBoundingClientRect().width > p.getBoundingClientRect().height;
      }, null, { timeout: 10000 });
      assert(await noSideScroll(page), 'no sideways scroll');
      if (browser === 'chromium') await shot(page, `watermark-many-${label}`);
      // Removing another keeps the preview of the first.
      await page.getByRole('button', { name: 'Remove cover.pdf' }).click();
      const box = await page.$eval('.watermark-preview', (e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]);
      assert(box[0] > box[1], 'still the first');
      await press(page);
      await page.waitForSelector('.ui-result', { timeout: 30000 });
      eq(await page.$$eval('.ui-result-name', (els) => els.map((e) => e.textContent)), ['beta_watermarked.pdf', 'alpha_watermarked.pdf'], 'each into a PDF of its own');
      if (browser === 'chromium') await shot(page, `watermark-many-result-${label}`);
      // Unsaved: leaving the result asks first through the router, and Back goes to editing.
      eq(await page.evaluate(async () => (await import('./js/core/router.js')).currentHandle().hasUnsavedWork()), true, 'unsaved');
      await page.goBack();
      await page.waitForSelector('.watermark-options');
      eq(await page.evaluate(async () => (await import('./js/core/router.js')).currentHandle().hasUnsavedWork()), false, 'choices alone aren\'t work');
      eq(await page.inputValue('.watermark-options input'), 'गोपनीय प्रति', 'text kept');
    }, { browser, viewport });
  });
}

const kitFileName = 'File name';

await test('chromium: PDFs handed over open in the tool; leaving mid-run stops it', async () => {
  const long = Buffer.from(await makePdf(Array.from({ length: 3000 }, () => ({ size: [300, 400], caption: false }))));
  await withPage(async (page, url) => {
    await openTool(page, url, 'watermark');
    // As Choose a tool hands them over: FileItems, a password already given.
    await page.evaluate(async ({ locked, plain }) => {
      const { navigate } = await import('./js/core/router.js');
      const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const item = (name, data, password) => ({ name, type: 'application/pdf', size: data.length, lastModified: 0, bytes: bytes(data), ...(password ? { password } : {}) });
      await navigate('/tool/page-numbers', { files: [item('statement.pdf', locked, 'test123'), item('long.pdf', plain)] });
    }, { locked: b64(lockedPdf), plain: b64(long) });
    await page.waitForSelector('#app > .screen[data-tool="page-numbers"] .ui-batch-list', { timeout: 20000 });
    eq(await page.locator('dialog[open]').count(), 0, 'no password asked again');
    eq(await page.$$eval('.ui-batch-item .ui-file-name', (els) => els.map((e) => e.textContent)), ['statement.pdf', 'long.pdf'], 'both');
    await press(page);
    await page.waitForSelector('dialog[open]', { timeout: 5000 });
    // While they are made, leaving asks first (the app ignores Back then), as the other tools do.
    eq(await page.evaluate(async () => (await import('./js/core/router.js')).currentHandle().hasUnsavedWork()), true, 'work under way');
    await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/'));
    await page.waitForSelector('#app > .screen[data-route="home"]:not([aria-busy])');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 5000 });
    eq(await page.evaluate(() => document.documentElement.style.getPropertyValue('--snackbar-offset')), '', 'snackbars back in place');

    // Leaving while a password is asked for takes the question away with the tool.
    await openTool(page, url, 'watermark');
    await addFiles(page, 'chromium', '.ui-empty', [file('statement.pdf', lockedPdf)]);
    await page.waitForSelector('dialog[open] input[type="password"]');
    await page.evaluate(async () => (await import('./js/core/router.js')).navigate('/'));
    await page.waitForSelector('#app > .screen[data-route="home"]:not([aria-busy])');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 5000 });
  });
});

await test('chromium: a reload on the result step comes back to the tool, its step gone', async () => {
  await withPage(async (page, url) => {
    await openTool(page, url, 'page-numbers');
    await pick(page, '.ui-empty', [file('alpha.pdf', alphaPdf)]);
    await page.waitForSelector('.ui-file-card');
    await press(page);
    await page.waitForSelector('.ui-result', { timeout: 20000 });
    await saveAll(page, 1);
    eq(await page.evaluate(() => history.state?.step), 'result', 'on the result step');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
    await page.waitForSelector('#app > .screen[data-tool="page-numbers"]:not([aria-busy]) .ui-empty', { timeout: 15000 });
    await page.waitForFunction(() => (history.state?.step ?? null) === null, null, { timeout: 5000 });
    eq(await page.evaluate(() => location.hash), '#/tool/page-numbers', 'the tool');
  });
});

await screenTests('chromium', 'phone', PHONE);
await screenTests('chromium', 'desktop', DESKTOP);
if (!quick) {
  await screenTests('firefox', 'phone', PHONE);
  await screenTests('webkit', 'phone', PHONE);
  await test('chromium 320 px: nothing scrolls sideways', async () => {
    await withPage(async (page, url) => {
      for (const tool of ['page-numbers', 'watermark']) {
        await openTool(page, url, tool);
        await pick(page, '.ui-empty', [file('a-very-long-file-name-that-goes-on-and-on-and-on.pdf', alphaPdf), file('beta.pdf', betaPdf)]);
        await page.waitForSelector('.ui-batch-list');
        assert(await noSideScroll(page), `${tool}: no sideways scroll`);
        await saveOutput(`stamps-${tool}-320.png`, await page.screenshot({ fullPage: true }));
      }
    }, { viewport: { width: 320, height: 700 } });
  });
}

// ---- Review fixes: the focus while PDFs are added, the names shown, one PDF's problem, loading ----

const notPdf = Buffer.from('This is not a PDF at all.');

async function reviewTests(browser) {
  await test(`${browser}: typing a name while PDFs are added keeps the focus in it`, async () => {
    await withPage(async (page, url) => {
      await openTool(page, url, 'watermark');
      eq(await page.locator('main[data-main]').count(), 1, 'one main landmark');
      await drop(page, '.ui-empty', [file('alpha.pdf', alphaPdf), file('beta.pdf', betaPdf)]);
      await page.waitForFunction(() => document.querySelectorAll('.ui-batch-item').length === 2);
      const field = page.locator('.ui-batch-item').nth(1).locator('input');
      await field.click();
      await page.keyboard.press('End');
      await page.keyboard.type('ab');
      await field.evaluate((input) => {
        window.__blurs = 0;
        input.addEventListener('blur', () => { window.__blurs++; });
      });
      await drop(page, '.stamps-page', [file('cover.pdf', coverPdf)]);
      await page.waitForFunction(() => document.querySelectorAll('.ui-batch-item').length === 3);
      eq(await page.evaluate(() => window.__blurs), 0, 'the name field never lost the focus while the PDF was added');
      await page.keyboard.type(' cd');
      eq(await page.locator('.ui-batch-item').count(), 3, 'no PDF removed');
      assert((await field.inputValue()).endsWith('ab cd'), `typing went on in the name: ${await field.inputValue()}`);

      // One PDF, its File name being typed in: a second dropped turns it into the list, the focus in
      // the same PDF's name there.
      await page.reload();
      await openTool(page, url, 'watermark');
      await drop(page, '.ui-empty', [file('alpha.pdf', alphaPdf)]);
      await page.waitForSelector('.ui-file-card');
      const one = page.getByRole('textbox', { name: kitFileName, exact: true });
      await one.click();
      await page.keyboard.press('End');
      await page.keyboard.type('X');
      await drop(page, '.stamps-page', [file('beta.pdf', betaPdf)]);
      await page.waitForFunction(() => document.querySelectorAll('.ui-batch-item').length === 2);
      const focusedIn = await page.evaluate(() => [...document.querySelectorAll('.ui-batch-item')].findIndex((c) => c.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'));
      eq(focusedIn, 0, "the focus is in the first card's name");
      await page.keyboard.type(' ');
      eq(await page.locator('.ui-batch-item').count(), 2, 'Space typed there removes nothing');
      eq(await page.locator('.ui-batch-item').nth(0).locator('input').inputValue(), 'alpha_watermarkedX ', 'the name typed goes on');
    }, { browser, viewport: PHONE, mobile: false });
  });

  await test(`${browser}: the name shown is the name the PDF gets, from one PDF to several and back`, async () => {
    await withPage(async (page, url) => {
      await openTool(page, url, 'page-numbers');
      await drop(page, '.ui-empty', [file('alpha.pdf', alphaPdf)]);
      await page.waitForSelector('.ui-file-card');
      eq(await page.getByRole('textbox', { name: kitFileName, exact: true }).inputValue(), 'alpha_numbered', 'the one PDF\'s name');
      await drop(page, '.stamps-page', [file('beta.pdf', betaPdf)]);
      await page.waitForFunction(() => document.querySelectorAll('.ui-batch-item').length === 2);
      await page.locator('.ui-batch-item').nth(0).locator('input').fill('Renamed in the list');
      await page.getByRole('button', { name: common.remove_file.replace('{1}', 'beta.pdf') }).click();
      await page.waitForFunction(() => !document.querySelector('.ui-batch-item'));
      eq(await page.getByRole('textbox', { name: kitFileName, exact: true }).inputValue(), 'Renamed in the list', 'File name shows the name given in the list');
      await page.getByRole('textbox', { name: kitFileName, exact: true }).fill('Typed for one');
      await drop(page, '.stamps-page', [file('cover.pdf', coverPdf)]);
      await page.waitForFunction(() => document.querySelectorAll('.ui-batch-item').length === 2);
      const shown = [];
      for (let i = 0; i < 2; i++) shown.push(await page.locator('.ui-batch-item').nth(i).locator('input').inputValue());
      eq(shown, ['Typed for one', 'cover_numbered'], 'the list shows the name typed for one');
      await press(page);
      await page.waitForSelector('.ui-result', { timeout: 30000 });
      const saved = await saveAll(page, 2);
      eq(saved.map((d) => d.name).sort(), shown.map((n) => n + '.pdf').sort(), 'the PDFs get the names shown');
    }, { browser, viewport: PHONE, mobile: false });
  });

  await test(`${browser}: one PDF that can't be opened is told about without its name`, async () => {
    await withPage(async (page, url) => {
      for (const tool of ['page-numbers', 'watermark']) {
        await openTool(page, url, tool);
        await drop(page, '.ui-empty', [file('text.pdf', notPdf)]);
        await snack(page, common.pdf_import_failed);
        await page.reload();
        await openTool(page, url, tool);
        await drop(page, '.ui-empty', [file('text.pdf', notPdf), file('empty.pdf', Buffer.alloc(0))]);
        await snack(page, `text.pdf, empty.pdf: ${common.pdf_import_failed_many}`);
        await page.reload();
      }
    }, { browser, viewport: PHONE, mobile: false, allowConsole: [/./] });
  });
}

await test('chromium: the screens load pdf-lib and the text engine only once a PDF is added', async () => {
  await withPage(async (page, url) => {
    for (const tool of ['page-numbers', 'watermark']) {
      const asked = [];
      const log = (r) => asked.push(r.url());
      await page.goto(url + 'app/');
      await page.waitForSelector('html[data-ready="true"]');
      page.on('request', log);
      await page.evaluate(async (id) => (await import('./js/core/router.js')).navigate('/tool/' + id), tool);
      await page.waitForSelector(`#app > .screen[data-tool="${tool}"]:not([aria-busy]) .ui-empty`);
      await page.waitForTimeout(500);
      const heavy = asked.filter((u) => /vendor\/(pdf-lib|fontkit)|engine\/text\/|engine\/stamps\.js/.test(u));
      eq(heavy, [], `${tool}: nothing heavy before a PDF is added`);
      await drop(page, '.ui-empty', [file('alpha.pdf', alphaPdf)]);
      await page.waitForSelector('.ui-file-card');
      await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /vendor\/pdf-lib/.test(e.name)), null, { timeout: 15000 });
      page.off('request', log);
    }
  }, { viewport: PHONE });
});

await test('chromium: the watermark preview of a landscape page stays in its column', async () => {
  for (const [w, size] of [[840, null], [900, null], [412, [280, 198]], [1366, [420, 297]]]) {
    await withPage(async (page, url) => {
      await openTool(page, url, 'watermark');
      await drop(page, '.ui-empty', [file('beta.pdf', betaPdf)]);
      await page.waitForSelector('.ui-file-card');
      await page.waitForFunction(() => {
        const p = document.querySelector('.watermark-preview')?.getBoundingClientRect();
        return p && p.width / p.height > 1.3;
      }, null, { timeout: 15000 });
      const r = await page.evaluate(() => {
        const box = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, height: b.height }; };
        return { preview: box('.watermark-preview'), options: box('.watermark-options') };
      });
      assert(r.preview.left >= r.options.left - 0.5 && r.preview.right <= r.options.right + 0.5, `${w} px: the preview (${r.preview.left}–${r.preview.right}) is inside its column (${r.options.left}–${r.options.right})`);
      if (size) near(r.preview.width, size[0], 1, `${w} px: preview width`), near(r.preview.height, size[1], 1.5, `${w} px: preview height`);
    }, { viewport: { width: w, height: 900 }, mobile: false });
  }
});

await test('chromium 1920 px: the main button ends where the column above it ends', async () => {
  await withPage(async (page, url) => {
    for (const tool of ['page-numbers', 'watermark']) {
      await openTool(page, url, tool);
      await drop(page, '.ui-empty', [file('alpha.pdf', alphaPdf)]);
      await page.waitForSelector('.ui-file-card');
      const r = await page.evaluate(() => ({
        button: document.querySelector('.ui-bottombar .ui-btn--filled').getBoundingClientRect().right,
        column: document.querySelector('.stamps-content').getBoundingClientRect().right,
      }));
      near(r.button, r.column, 1, `${tool}: the button's right edge`);
    }
  }, { viewport: { width: 1920, height: 1000 } });
});

await reviewTests('chromium');
if (!quick) {
  await reviewTests('firefox');
  await reviewTests('webkit');
}

if (failures) {
  console.log(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll stamps tests passed.');
