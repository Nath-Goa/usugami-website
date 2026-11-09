// Text recognition (engine/ocr.js): Tesseract reading drawn pages in English, French, Spanish and
// Hindi (with English), the invisible text layer it adds over the page image, and the edge cases of
// the app's own tests (PdfToolsDeviceTest, BuiltInOcrDeviceTest, TextDetectionTest.picturesAreReadBigEnough).
//
//   node tests/ocr.test.mjs
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPage, assert, saveOutput, root } from './harness.mjs';

const started = Date.now();
let count = 0;
async function test(name, fn) {
  const t = Date.now();
  await fn();
  count++;
  console.log(`ok - ${name} (${Date.now() - t} ms)`);
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

// ---------------------------------------------------------------------------------------------
// Pure parts, in Node.

const { ocrScale, MAX_SIDE } = await import(pathToFileURL(join(root, 'site/app/js/engine/ocr/scale.js')).href);
const lines = await import(pathToFileURL(join(root, 'site/app/js/engine/ocr/lines.js')).href);

await test('pictures are read big enough (OcrScale, as the app tests it)', () => {
  assert(near(ocrScale(4000, 3000, 3000, 2.5), 0.75, 1e-9), '4:3 photo');
  assert(near(ocrScale(1080, 2400, 3000, 2.5), 1.25, 1e-9), 'screenshot');
  assert(near(ocrScale(400, 300, 3000, 2.5), 2.5, 1e-9), 'small image enlarged at most 2.5 times');
  assert(near(ocrScale(3000, 3000, 3000, 2.5), 1, 1e-9), 'square');
  assert(near(ocrScale(1080, 3500, 3000, 2.5), 1, 1e-9), 'long screenshot with fewer pixels than a 4:3 photo');
  const s = ocrScale(1080, 9000, 3000, 2.5);
  assert(near(1080 * 9000 * s * s, 3000 * 2250, 1), 'long screenshot shrunk to the pixels of a 4:3 photo');
  assert(near(ocrScale(1080, 12000, 3000, 2.5), MAX_SIDE / 12000, 1e-9), 'at most 8192 on a side');
  assert(near(ocrScale(2250, 3000, 2240, 1), 2240 / 3000, 1e-9), 'never enlarged with 1');
  assert(near(ocrScale(1000, 1400, 2240, 1), 1, 1e-9), 'small page at 1');
  const d = ocrScale(737, 8192, 2240, 1);
  assert(near(737 * 8192 * d * d, 2240 * 1680, 1), 'long page');
  assert(near(ocrScale(595, 842, 2600, 2.5), 2.5, 1e-9), 'A4 in points');
  let threw = false;
  try { ocrScale(0, 10, 100, 1); } catch { threw = true; }
  assert(threw, 'a zero size is refused');
});

await test('turned readings map back onto the picture', () => {
  // A 300 x 200 picture read turned: a point of the turned picture goes back where it came from.
  const original = { x: 30, y: 20 };
  const turnedBy = {
    1: { x: 200 - original.y, y: original.x, w: 200, h: 300 },
    2: { x: 300 - original.x, y: 200 - original.y, w: 300, h: 200 },
    3: { x: original.y, y: 300 - original.x, w: 200, h: 300 },
  };
  for (const [k, p] of Object.entries(turnedBy)) {
    const back = lines.unturn(p.w, p.h, Number(k), 1)(p);
    assert(near(back.x, original.x, 1e-6) && near(back.y, original.y, 1e-6), `quarter turns ${k}: ${JSON.stringify(back)}`);
  }
  const scaled = lines.unturn(600, 400, 0, 2)({ x: 60, y: 40 });
  assert(scaled.x === 30 && scaled.y === 20, 'scale divided out');
});

await test('a line\'s baseline is fitted through its letters, not Tesseract\'s parallel lines', () => {
  // A level line whose letters sit on y = 100 (descenders below), which Tesseract gave a slanted
  // baseline because another line of its block was tilted.
  const symbols = (x0, text, descender = '') => [...text].map((c, i) => ({
    text: c, bbox: { x0: x0 + i * 20, y0: 65, x1: x0 + i * 20 + 16, y1: descender.includes(c) ? 110 : 100 },
  }));
  const line = {
    bbox: { x0: 40, y0: 65, x1: 600, y1: 110 },
    baseline: { x0: 40, y0: 101, x1: 600, y1: 89 },
    rowAttributes: { rowHeight: 45, descenders: 10, ascenders: 9 },
    confidence: 93,
    words: [
      { text: 'Hello', confidence: 92, bbox: { x0: 40, y0: 65, x1: 136, y1: 100 }, symbols: symbols(40, 'Hello') },
      { text: 'jumpy', confidence: 95, bbox: { x0: 200, y0: 65, x1: 296, y1: 110 }, symbols: symbols(200, 'jumpy', 'jpy') },
      { text: 'world', confidence: 95, bbox: { x0: 400, y0: 65, x1: 496, y1: 100 }, symbols: symbols(400, 'world') },
      { text: '~', confidence: 12, bbox: { x0: 560, y0: 80, x1: 600, y1: 90 }, symbols: symbols(560, '~') },
    ],
  };
  const g = lines.lineGeometry(line);
  assert(Math.abs(g.slope) < 1e-6, `level baseline, slope ${g.slope}`);
  assert(g.words.length === 3, 'a mark read with little confidence is left out');
  const unsure = lines.lineGeometry({ ...line, words: [{ ...line.words[0], confidence: 29 }, ...line.words.slice(1)] });
  assert(unsure.words.length === 3 && unsure.words[0].text === 'Hello', 'a word with letters stays, however unsure');
  assert(lines.lineGeometry({ ...line, confidence: 31 }) === null, 'a line read with little confidence is left out');
  for (const w of g.words) {
    assert(near(w.baseline[0].y, 100, 0.01) && near(w.baseline[1].y, 100, 0.01), `${w.text} on the baseline: ${JSON.stringify(w.baseline)}`);
    assert(near(w.corners[0].y, 100 - 35, 0.01) && near(w.corners[3].y, 110, 0.01), `${w.text} as tall as the line`);
  }
  assert(near(g.words[1].baseline[0].x, 200, 0.01) && near(g.words[1].baseline[1].x, 296, 0.01), 'word spans its box');
  // A rising line: the fit follows it.
  const rising = {
    ...line,
    baseline: { x0: 40, y0: 100, x1: 600, y1: 100 },
    words: line.words.slice(0, 3).map((w) => ({
      ...w,
      symbols: w.symbols.map((s) => ({ ...s, bbox: { ...s.bbox, y1: s.bbox.y1 - 0.05 * s.bbox.x0 } })),
    })),
  };
  assert(near(lines.lineGeometry(rising).slope, -0.05, 0.002), 'rising line slope');
  assert(lines.lineGeometry({ ...line, words: [{ text: ' ', confidence: 90, bbox: line.bbox }] }) === null, 'no words, no line');
});

// The characters each model can read (its LSTM unicharset), for the font check in the page.
async function modelCharacters(code) {
  const data = gunzipSync(await readFile(join(root, `site/app/vendor/tesseract/lang/${code}.traineddata.gz`)));
  const n = data.readInt32LE(0);
  const offsets = [];
  for (let i = 0; i < n; i++) offsets.push(Number(data.readBigInt64LE(4 + 8 * i)));
  const start = offsets[21]; // TESSDATA_LSTM_UNICHARSET
  const end = offsets.slice(22).find((o) => o > 0) ?? data.length;
  const text = data.subarray(start, end).toString('utf8').split('\n');
  const chars = new Set();
  for (let i = 1; i <= Number(text[0]); i++) {
    const unichar = text[i].split(' ')[0];
    if (unichar !== 'NULL') for (const c of unichar) chars.add(c);
  }
  return [...chars];
}
const characters = {};
for (const code of ['eng', 'fra', 'spa', 'hin']) characters[code] = await modelCharacters(code);

// ---------------------------------------------------------------------------------------------
// In the browser.

/** Puts helpers on window.T: the modules, the test fonts, drawing pages, making and reading PDFs. */
async function installHelpers(page, base) {
  await page.evaluate(async (base) => {
    const mod = (p) => import(new URL(p, base).href);
    const T = {};
    T.ocr = await mod('app/js/engine/ocr.js');
    T.textLayer = await mod('app/js/engine/ocr/text-layer.js');
    T.loader = await mod('app/js/engine/ocr/loader.js');
    T.common = await mod('app/js/engine/pdf-common.js');
    T.pdfjs = await mod('app/js/lib/pdfjs.js');
    T.pdfLib = await mod('app/js/lib/pdf-lib.js');
    T.fontkit = await mod('app/js/lib/fontkit.js');
    T.errors = await mod('app/js/core/errors.js');
    T.base = base;
    // The site's own Noto fonts, so the pages look the same on every computer.
    for (const [family, file] of [['TestSans', 'NotoSans-Regular.ttf'], ['TestDeva', 'NotoSansDevanagari-Regular.ttf']]) {
      const face = new FontFace(family, `url(${new URL('app/fonts/' + file, base).href})`);
      document.fonts.add(face);
      await face.load();
    }
    /**
     * A white picture with `lines` of black text ({ text, x, y (baseline), size, font, angle }),
     * turned `turn` quarter turns clockwise. Returns the canvas and where each upright word's ink is.
     */
    T.picture = ({ width, height, lines, kind = 'offscreen', turn = 0, background = '#fff', ink = '#000' }) => {
      const w = turn % 2 ? height : width;
      const h = turn % 2 ? width : height;
      // A page canvas also where there is no OffscreenCanvas (Safari before 16.4, WebKit on Windows).
      const c = kind === 'dom' || typeof OffscreenCanvas === 'undefined'
        ? Object.assign(document.createElement('canvas'), { width: w, height: h })
        : new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      g.fillStyle = background;
      g.fillRect(0, 0, w, h);
      g.translate(w / 2, h / 2);
      g.rotate((turn * Math.PI) / 2);
      g.translate(-width / 2, -height / 2);
      g.fillStyle = ink;
      const words = [];
      for (const l of lines) {
        g.font = `${l.size}px ${l.font ?? 'TestSans'}`;
        g.save();
        g.translate(l.x, l.y);
        if (l.angle) g.rotate(l.angle);
        g.fillText(l.text, 0, 0);
        g.restore();
        if (l.angle) continue;
        let offset = 0;
        for (const word of l.text.split(' ')) {
          const startX = l.x + g.measureText(l.text.slice(0, offset)).width;
          const m = g.measureText(word);
          words.push({
            text: word, line: l.text, baseline: l.y,
            x0: startX - m.actualBoundingBoxLeft, x1: startX + m.actualBoundingBoxRight,
            top: l.y - m.actualBoundingBoxAscent, bottom: l.y + m.actualBoundingBoxDescent,
          });
          offset += word.length + 1;
        }
      }
      return { canvas: c, words };
    };
    /** A PDF with one page holding `canvas` as a PNG in `rect`. */
    T.pdfWithImage = async (canvas, { pageWidth = 595.28, pageHeight = 841.89, rect }) => {
      const doc = await T.common.createPdf();
      const page = doc.addPage([pageWidth, pageHeight]);
      const blob = canvas.convertToBlob ? await canvas.convertToBlob() : await new Promise((r) => canvas.toBlob(r));
      const png = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
      page.drawImage(png, rect);
      return { doc, page };
    };
    /** pdf.js's text items of the first page (string, transform, width). */
    T.pdfText = async (bytes, pageIndex = 0) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      try {
        const content = await (await pdf.getPage(pageIndex + 1)).getTextContent();
        const items = content.items.filter((i) => i.str !== '' || i.width > 0).map((i) => ({ str: i.str, t: i.transform, width: i.width, eol: i.hasEOL }));
        return { items, text: content.items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join('') };
      } finally {
        await (pdf.destroy ? pdf.destroy() : pdf.loadingTask?.destroy());
      }
    };
    /** The first page rendered by pdf.js, as RGBA bytes. */
    T.render = async (bytes, scale = 1) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      try {
        const p = await pdf.getPage(1);
        const viewport = p.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        await p.render({ canvasContext: ctx, canvas, viewport }).promise;
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      } finally {
        await (pdf.destroy ? pdf.destroy() : pdf.loadingTask?.destroy());
      }
    };
    T.differentPixels = (a, b) => {
      if (a.length !== b.length) return Infinity;
      let n = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
      return n;
    };
    /** Where pdf.js puts `word`, about (from its item, in proportion to its characters): every whole-word match. */
    T.findWords = (items, word) => {
      const found = [];
      const re = new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gu');
      for (const it of items) {
        for (const m of it.str.matchAll(re)) {
          const index = m.index + m[1].length;
          const chars = [...it.str].length;
          const at = [...it.str.slice(0, index)].length;
          const len = [...word].length;
          const angle = Math.atan2(it.t[1], it.t[0]);
          const center = (((at + at + len) / 2) / chars) * it.width;
          found.push({
            x: it.t[4] + Math.cos(angle) * center,
            y: it.t[5] + Math.sin(angle) * center,
            baseline: it.t[5],
            angle: (angle * 180) / Math.PI,
            size: Math.hypot(it.t[2], it.t[3]),
          });
        }
      }
      return found;
    };
    T.findWord = (items, word) => T.findWords(items, word)[0] ?? null;
    /**
     * Each run of text pdf.js draws on the first page, as its operator list has it: the text (as
     * pdf.js decodes the glyphs), where it starts, its angle, size and width.
     */
    T.pdfRuns = async (bytes) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      try {
        const ops = await (await pdf.getPage(1)).getOperatorList();
        const OPS = T.pdfjs.pdfjsLib.OPS;
        const runs = [];
        let size = 0;
        let hScale = 1;
        let charSpacing = 0;
        let matrix = null;
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          const args = ops.argsArray[i];
          if (fn === OPS.setFont) size = args[1];
          else if (fn === OPS.setHScale) hScale = args[0] / 100;
          else if (fn === OPS.setCharSpacing) charSpacing = args[0];
          else if (fn === OPS.setTextMatrix) matrix = Array.from(args[0]?.length === 6 ? args[0] : args);
          else if (fn === OPS.showText && matrix) {
            const glyphs = args[0].filter((g) => typeof g !== 'number');
            const text = glyphs.map((g) => g.unicode).join('');
            if (text.trim()) {
              // The last glyph's spacing comes after it, so it isn't part of the text's width.
              const width = glyphs.reduce((sum, g) => sum + ((g.width * size) / 1000 + charSpacing) * hScale, 0) - charSpacing * hScale;
              const angle = Math.atan2(matrix[1], matrix[0]);
              runs.push({ text, x: matrix[4], y: matrix[5], angle: (angle * 180) / Math.PI, size, width, hScale });
            }
            matrix = null;
          }
        }
        return runs;
      } finally {
        await (pdf.destroy ? pdf.destroy() : pdf.loadingTask?.destroy());
      }
    };
    T.errorKey = (e) => (e instanceof T.errors.CancelledError ? 'cancelled' : e?.key ?? `${e?.name}: ${e?.message}`);
    window.T = T;
  }, base);
}

/** The words of a recognition, flattened, with their corners' box. */
function recognizedWords(recognition) {
  return recognition.lines.flatMap((l) => l.words).map((w) => ({
    ...w,
    x0: Math.min(...w.corners.map((c) => c.x)), x1: Math.max(...w.corners.map((c) => c.x)),
    y0: Math.min(...w.corners.map((c) => c.y)), y1: Math.max(...w.corners.map((c) => c.y)),
  }));
}

/**
 * Reads `lines` drawn on a page image in `lang`, puts the image on an A4 page with the text layer,
 * and returns the recognition, the drawn words, the PDF's text items, the word places pdf.js gives
 * and how many rendered pixels the text layer changed.
 */
async function readDrawnPage(page, { lang, width, height, lines: drawn, rect, kind, turn = 0 }) {
  return page.evaluate(async ({ lang, width, height, drawn, rect, kind, turn }) => {
    const { canvas, words } = T.picture({ width, height, lines: drawn, kind, turn });
    const recognizer = await T.ocr.createRecognizer(lang);
    let recognition;
    try {
      recognition = await recognizer.recognize(canvas);
    } finally {
      recognizer.terminate();
    }
    const plain = await T.pdfWithImage(canvas, { rect });
    const before = await T.common.savePdf(plain.doc);
    const withText = await T.pdfWithImage(canvas, { rect });
    const written = await T.ocr.addTextLayer(withText.doc, withText.page, recognition, rect);
    const after = await T.common.savePdf(withText.doc);
    const { items, text } = await T.pdfText(after);
    const changed = T.differentPixels(await T.render(before, 1), await T.render(after, 1));
    const places = Object.fromEntries(words.map((w) => [w.text, T.findWords(items, w.text)]));
    const runs = await T.pdfRuns(after);
    // The text layer's operators: invisible text with the OCR font.
    const doc = await T.pdfLib.PDFDocument.load(after);
    const fonts = doc.getPage(0).node.Resources().lookup(T.pdfLib.PDFName.of('Font'));
    const fontNames = fonts ? fonts.keys().map((k) => doc.context.lookup(fonts.get(k)).get(T.pdfLib.PDFName.of('BaseFont')).asString()) : [];
    return { recognition, words, items, text, changed, places, runs, written, fontNames, bytes: after };
  }, { lang, width, height, drawn, rect, kind, turn });
}

/** The page image's pixel point (x, y) on a page where the image fills `rect`. */
const toPoints = (rect, width, height) => (x, y) => ({
  x: rect.x + (x / width) * rect.width,
  y: rect.y + rect.height - (y / height) * rect.height,
});

/** Checks that every drawn word was recognized over its ink, and that pdf.js finds it over the same place. */
/**
 * `looseStart(word)`: words whose start Tesseract may box late (with the Hindi data, a leading 1
 * is split off its word's box, though read as part of it): their start may be off by a digit.
 */
function checkWordsLieOverTheirInk(result, { width, height, rect, label, skip = [], looseStart = () => false }) {
  const recognized = recognizedWords(result.recognition);
  const pt = toPoints(rect, width, height);
  const scale = rect.width / width;
  for (const w of result.words) {
    if (skip.includes(w.text)) continue;
    const r = recognized.find((x) => x.text === w.text && x.x1 > w.x0 && x.x0 < w.x1);
    assert(r, `${label}: "${w.text}" recognized (read: ${result.recognition.text})`);
    const tolerance = Math.max(6, (w.bottom - w.top) * 0.25);
    const startTolerance = looseStart(w.text) ? (w.bottom - w.top) * 0.8 : tolerance;
    assert(near(r.x0, w.x0, startTolerance) && near(r.x1, w.x1, tolerance), `${label}: "${w.text}" across its ink: read ${r.x0}..${r.x1}, drawn ${w.x0.toFixed(1)}..${w.x1.toFixed(1)}`);
    assert(near(r.baseline[0].y, w.baseline, tolerance), `${label}: "${w.text}" baseline ${r.baseline[0].y} vs ${w.baseline}`);
    assert(r.y0 <= w.top + tolerance && r.y1 >= w.bottom - tolerance, `${label}: "${w.text}" as tall as its ink`);
    // Search finds it: pdf.js's text has it as a word.
    assert((result.places[w.text] ?? []).length, `${label}: pdf.js finds "${w.text}" in: ${result.text}`);
    // And its text lies over its ink: pdf.js draws it from the ink's start along its baseline, as
    // wide as the ink (the same word may be on several lines: the run nearest this one).
    const start = pt(w.x0, w.baseline);
    const end = pt(w.x1, w.baseline);
    const run = result.runs.filter((x) => x.text === w.text)
      .sort((a, b) => Math.hypot(a.x - start.x, a.y - start.y) - Math.hypot(b.x - start.x, b.y - start.y))[0];
    assert(run, `${label}: a text run for "${w.text}" in ${JSON.stringify(result.runs.map((x) => x.text))}`);
    const inkHeight = (w.bottom - w.top) * scale;
    const slack = Math.max(2, inkHeight * 0.25);
    assert(near(run.x, start.x, looseStart(w.text) ? inkHeight * 0.8 : slack), `${label}: "${w.text}" starts at x ${run.x.toFixed(1)}, ink at ${start.x.toFixed(1)}`);
    assert(near(run.y, start.y, slack), `${label}: "${w.text}" on baseline ${run.y.toFixed(1)}, ink's at ${start.y.toFixed(1)}`);
    assert(near(run.x + run.width, end.x, slack), `${label}: "${w.text}" ends at x ${(run.x + run.width).toFixed(1)}, ink at ${end.x.toFixed(1)}`);
    assert(near(run.angle, 0, 0.01), `${label}: "${w.text}" level`);
    assert(run.size > inkHeight * 0.6 && run.size < inkHeight * 2.5, `${label}: "${w.text}" at size ${run.size.toFixed(1)} for ink ${inkHeight.toFixed(1)} high`);
  }
}

const A4 = { width: 595.28, height: 841.89 };

const english = {
  lang: 'en', width: 1700, height: 1100,
  rect: { x: 40, y: 400, width: 515, height: 515 * (1100 / 1700) },
  lines: [
    { text: 'QUARTZ', x: 100, y: 180, size: 110 },
    { text: 'The quick brown fox jumps over the lazy dog.', x: 100, y: 330, size: 52 },
    { text: 'Invoice number 48213 is due on Friday.', x: 100, y: 450, size: 52 },
    { text: 'School notes for the week 12345', x: 100, y: 570, size: 52 },
    { text: 'Small print still reads well here', x: 100, y: 680, size: 34 },
  ],
};

const externalRequests = [];

await withPage(async (page, url) => {
  const origin = new URL(url).origin;
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) externalRequests.push(u);
  });
  const workerRequests = [];
  page.on('request', (r) => { if (/worker\.min\.js$/.test(r.url())) workerRequests.push(r.url()); });
  await page.goto(url + 'app/fonts/OFL.txt');
  await installHelpers(page, url);

  await test('printable() writes what the font has, in compatibility form, or as a space', async () => {
    const r = await page.evaluate(async () => {
      const bytes = new Uint8Array(await (await fetch(new URL('app/fonts/UsugamiOcr-Regular.ttf', T.base))).arrayBuffer());
      const font = T.fontkit.create(bytes);
      const has = (cp) => font.hasGlyphForCodePoint(cp);
      const p = (s) => T.ocr.printable(s, has);
      return {
        compatible: p('① Install ② Open ⌀ 12 mm \u{1D462}'),
        emoji: p('a\u{1F600}b'),
        joiner: p('क्\u200Dष soft\u00ADhyphen'),
        ligature: p('ﬁ'),
        devanagari: p('किताब हिन्दी'),
        control: p('a\tb\u0000c'),
      };
    });
    assert(r.compatible === '① Install ② Open ⌀ 12 mm u', `compatibility form: ${r.compatible}`);
    assert(r.emoji === 'a b', `no glyph, no compatibility form: a space (${JSON.stringify(r.emoji)})`);
    assert(r.joiner === 'क्ष softhyphen', `joiners and soft hyphens are left out: ${JSON.stringify(r.joiner)}`);
    assert(r.ligature === 'ﬁ', 'the font has the ligature');
    assert(r.devanagari === 'किताब हिन्दी', 'Devanagari as it is');
    assert(r.control === 'a b c', `control characters become spaces: ${JSON.stringify(r.control)}`);
  });

  await test('every character the four models can read has a glyph in the text layer\'s font', async () => {
    const missing = await page.evaluate(async (characters) => {
      const bytes = new Uint8Array(await (await fetch(new URL('app/fonts/UsugamiOcr-Regular.ttf', T.base))).arrayBuffer());
      const font = T.fontkit.create(bytes);
      const out = {};
      for (const [code, chars] of Object.entries(characters)) {
        // Joiners are never drawn: they are left out (not written as spaces), so search ignores them.
        const ignorable = chars.filter((c) => T.textLayer.isDefaultIgnorable(c.codePointAt(0)));
        if (ignorable.some((c) => T.ocr.printable(`a${c}b`, (cp) => font.hasGlyphForCodePoint(cp)) !== 'ab')) out[code + ' joiners'] = ignorable;
        out[code] = chars.filter((c) => c.trim() !== '' && !ignorable.includes(c) && T.ocr.printable(c, (cp) => font.hasGlyphForCodePoint(cp)).trim() === '');
      }
      return out;
    }, characters);
    for (const [code, list] of Object.entries(missing)) assert(list.length === 0, `${code} characters written as spaces: ${list.join(' ')}`);
    assert(characters.hin.some((c) => c === 'क') && characters.hin.some((c) => c === 'e'), 'Hindi model reads Devanagari and Latin');
  });

  await test('the text layer keeps Devanagari and Latin, in reading order (lines as the app writes them)', async () => {
    const r = await page.evaluate(async () => {
      const doc = await T.common.createPdf();
      const pg = doc.addPage([595.28, 841.89]);
      // An A4 page "rendered" at 1190 x 1684, as the app's test.
      const lines = ['भारत India 2024 test@example.com', 'क्षत्रिय श्री ₹500 Hello, World!']
        .map((text, i) => ({ text, corners: [{ x: 100, y: 100 + i * 80 }, { x: 1000, y: 100 + i * 80 }, { x: 1000, y: 150 + i * 80 }, { x: 100, y: 150 + i * 80 }] }));
      const n = await T.ocr.addTextLayer(doc, pg, { lines }, { x: 0, y: 0, width: 595.28, height: 841.89 }, 1190, 1684);
      return { n, ...(await T.pdfText(await T.common.savePdf(doc))) };
    });
    assert(r.n === 2, 'two lines written');
    for (const expected of ['भारत India 2024 test@example.com', 'क्षत्रिय श्री ₹500 Hello, World!']) {
      assert(r.text.includes(expected), `missing "${expected}" in "${r.text}"`);
    }
  });

  await test('a line on a tilted photo follows its angle and height, not its upright bounds', async () => {
    const r = await page.evaluate(async () => {
      const doc = await T.common.createPdf();
      const pg = doc.addPage([595.28, 841.89]);
      // A 600 x 40 pixel line rising at 30 degrees, on the A4 page read at 1190 x 1684.
      const angle = Math.PI / 6;
      const at = (along, up) => ({ x: 200 + along * Math.cos(angle) - up * Math.sin(angle), y: 900 - along * Math.sin(angle) - up * Math.cos(angle) });
      const line = { text: 'This line was photographed at an angle', corners: [at(0, 40), at(600, 40), at(600, 0), at(0, 0)] };
      await T.ocr.addTextLayer(doc, pg, { lines: [line], width: 1190, height: 1684 }, { x: 0, y: 0, width: 595.28, height: 841.89 });
      return T.pdfText(await T.common.savePdf(doc));
    });
    const scale = 841.89 / 1684;
    const item = r.items.find((i) => i.str.includes('photographed'));
    assert(item && item.str === 'This line was photographed at an angle', `one run: ${JSON.stringify(r.items)}`);
    const [a, b, c, d, e, f] = item.t;
    assert(near(e, 200 * (595.28 / 1190), 1) && near(f, 841.89 - 900 * scale, 1), `starts at the bottom-left corner: ${e}, ${f}`);
    assert(near((Math.atan2(b, a) * 180) / Math.PI, 30, 1), `at the line's angle: ${(Math.atan2(b, a) * 180) / Math.PI}`);
    assert(near(Math.hypot(c, d), 40 * scale * 0.9, 0.5), `as tall as the line: ${Math.hypot(c, d)}`);
    assert(item.width >= 500 * scale && item.width <= 600 * scale + 1, `spans the line: ${item.width}`);
  });

  await test('characters beyond the font are written in compatibility form and stay searchable', async () => {
    const r = await page.evaluate(async () => {
      const doc = await T.common.createPdf();
      const pg = doc.addPage([595.28, 841.89]);
      const line = { text: '① Install ② Open ⌀ 12 mm \u{1D462}', corners: [{ x: 100, y: 100 }, { x: 1000, y: 100 }, { x: 1000, y: 150 }, { x: 100, y: 150 }] };
      await T.ocr.addTextLayer(doc, pg, { lines: [line] }, { x: 0, y: 0, width: 595.28, height: 841.89 }, 1190, 1684);
      return T.pdfText(await T.common.savePdf(doc));
    });
    assert(r.text.includes('① Install ② Open ⌀ 12 mm u'), r.text);
  });

  await test('the text goes where the page draws the image, also turned, and whatever the page\'s content leaves changed', async () => {
    const r = await page.evaluate(async () => {
      const doc = await T.common.createPdf();
      const pg = doc.addPage([400, 400]);
      // Content that leaves its transformation in place, as some PDFs do.
      pg.pushOperators(T.pdfLib.concatTransformationMatrix(2, 0, 0, 2, 50, 50));
      const word = (text, x0, x1) => ({ text, corners: [{ x: x0, y: 10 }, { x: x1, y: 10 }, { x: x1, y: 30 }, { x: x0, y: 30 }], baseline: [{ x: x0, y: 25 }, { x: x1, y: 25 }] });
      const recognition = { width: 200, height: 100, lines: [{ text: 'left right', corners: [{ x: 20, y: 10 }, { x: 180, y: 10 }, { x: 180, y: 30 }, { x: 20, y: 30 }], words: [word('left', 20, 60), word('right', 140, 180)] }] };
      // The image (200 x 100 as read) drawn turned a quarter clockwise into 100 x 200 points at (100, 100).
      const placement = { toPage: (s, t) => [100 + (1 - t) * 100, 100 + (1 - s) * 200] };
      // The size of the image in the PDF (compressed smaller, say) doesn't matter: the recognition has its own.
      const n = await T.ocr.addTextLayer(doc, pg, recognition, placement, 50, 25);
      return { n, ...(await T.pdfText(await T.common.savePdf(doc))) };
    });
    assert(r.n === 1, 'one line');
    const left = r.items.find((i) => i.str.startsWith('left'));
    assert(left, JSON.stringify(r.items));
    assert(r.text.replace(/\n/g, '').includes('left right'), `one space between the words: ${JSON.stringify(r.text)}`);
    // (20, 25) of the image: s = 0.1, t = 0.25, on the page at (175, 280), running down the page.
    assert(near(left.t[4], 175, 0.5) && near(left.t[5], 280, 0.5), `turned image: starts at ${left.t[4]}, ${left.t[5]}`);
    assert(near((Math.atan2(left.t[1], left.t[0]) * 180) / Math.PI, -90, 0.5), 'runs down the page');
  });

  await test('a page without text is left as it was', async () => {
    const r = await page.evaluate(async () => {
      const doc = await T.common.createPdf();
      const pg = doc.addPage([200, 200]);
      const n = await T.ocr.addTextLayer(doc, pg, { width: 10, height: 10, lines: [{ text: '  ', corners: [] }, { text: '\u200D', corners: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }] }] }, { x: 0, y: 0, width: 200, height: 200 });
      const bytes = await T.common.savePdf(doc);
      const loaded = await T.pdfLib.PDFDocument.load(bytes);
      const resources = loaded.getPage(0).node.Resources();
      let error = null;
      try {
        await T.ocr.addTextLayer(doc, pg, { lines: [] }, { x: 0, y: 0, width: 0, height: 10 }, 10, 10);
      } catch (e) {
        error = e.name;
      }
      return { n, font: !!resources?.lookup(T.pdfLib.PDFName.of('Font')), text: (await T.pdfText(bytes)).text, error };
    });
    assert(r.n === 0 && !r.font && r.text === '', `nothing added: ${JSON.stringify(r)}`);
    assert(r.error === 'TypeError', 'a bad placement is a programming error');
  });

  let englishResult;
  await test('English: words are read where they are drawn, and the PDF finds them over their ink, invisibly', async () => {
    englishResult = await readDrawnPage(page, english);
    await saveOutput('ocr-english.pdf', englishResult.bytes);
    checkWordsLieOverTheirInk(englishResult, { ...english, label: 'English' });
    assert(englishResult.changed === 0, `the text layer changed ${englishResult.changed} rendered pixels`);
    assert(englishResult.written === 5, `five lines written: ${englishResult.written}`);
    assert(englishResult.recognition.width === english.width && englishResult.recognition.height === english.height, 'points in the picture\'s pixels');
    assert(englishResult.recognition.turned === 0, 'read as it is');
    assert(englishResult.fontNames.length === 1 && /UsugamiOcr/i.test(englishResult.fontNames[0]), `the OCR font: ${englishResult.fontNames}`);
    for (const l of english.lines) assert(englishResult.text.includes(l.text), `line "${l.text}" in ${JSON.stringify(englishResult.text)}`);
    assert(englishResult.recognition.text.split('\n').length === 5, 'five lines read');
  });

  await test('French and Spanish keep their accents', async () => {
    const cases = [
      { lang: 'fr', lines: ['Mon élève préféré étudie la géographie', 'Le garçon a déjà mangé une crêpe.'] },
      { lang: 'es', lines: ['Dónde está el niño pequeño', 'Mañana el señor Muñoz canta una canción.'] },
    ];
    for (const c of cases) {
      const setup = {
        lang: c.lang, width: 1600, height: 500,
        rect: { x: 40, y: 500, width: 500, height: 500 * (500 / 1600) },
        lines: c.lines.map((text, i) => ({ text, x: 80, y: 160 + i * 140, size: 56 })),
      };
      const r = await readDrawnPage(page, setup);
      // Punctuation alone isn't a word to look for.
      checkWordsLieOverTheirInk(r, { ...setup, label: c.lang });
      assert(r.changed === 0, `${c.lang}: invisible`);
    }
  });

  await test('a page photographed upside down or sideways is read the right way up, its text turned to match', async () => {
    for (const turn of [2, 1]) {
      const setup = { ...english, turn, rect: turn % 2 ? { x: 100, y: 100, width: 400, height: 400 * (1700 / 1100) } : english.rect };
      const r = await page.evaluate(async ({ setup }) => {
        const { canvas, words } = T.picture({ ...setup });
        const recognizer = await T.ocr.createRecognizer('en');
        const recognition = await recognizer.recognize(canvas);
        recognizer.terminate();
        const { doc, page } = await T.pdfWithImage(canvas, { rect: setup.rect });
        await T.ocr.addTextLayer(doc, page, recognition, setup.rect);
        const { items, text } = await T.pdfText(await T.common.savePdf(doc));
        return { recognition, text, drawn: words.find((w) => w.text === 'QUARTZ'), quartz: T.findWord(items, 'QUARTZ') };
      }, { setup });
      assert(r.recognition.turned === (turn === 2 ? 180 : 270), `turn ${turn}: read turned ${r.recognition.turned}`);
      assert(r.text.includes('Invoice number 48213 is due on Friday.'), `turn ${turn}: ${r.text}`);
      assert(r.text.indexOf('QUARTZ') < r.text.indexOf('Friday'), `turn ${turn}: in reading order`);
      // Where QUARTZ's ink is on the turned picture.
      const { width: W, height: H } = english;
      const d = r.drawn;
      const box = turn === 2
        ? { x0: W - d.x1, x1: W - d.x0, y0: H - d.bottom, y1: H - d.top }
        : { x0: H - d.bottom, x1: H - d.top, y0: d.x0, y1: d.x1 };
      const quartz = recognizedWords(r.recognition).find((w) => w.text === 'QUARTZ');
      const tolerance = 20;
      assert(near(quartz.x0, box.x0, tolerance) && near(quartz.x1, box.x1, tolerance) && near(quartz.y0, box.y0, tolerance) && near(quartz.y1, box.y1, tolerance),
        `turn ${turn}: QUARTZ read at ${JSON.stringify([quartz.x0, quartz.y0, quartz.x1, quartz.y1])}, drawn ${JSON.stringify(box)}`);
      // In the PDF: upside down, or running down the page.
      const angle = r.quartz.angle;
      assert(turn === 2 ? near(Math.abs(angle), 180, 2) : near(angle, -90, 2), `turn ${turn}: text layer at ${angle} degrees`);
      const pt = toPoints(setup.rect, turn % 2 ? H : W, turn % 2 ? W : H);
      const centre = pt((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
      const reach = (Math.max(box.x1 - box.x0, box.y1 - box.y0) / 2) * (setup.rect.width / (turn % 2 ? H : W));
      assert(near(r.quartz.x, centre.x, reach) && near(r.quartz.y, centre.y, reach),
        `turn ${turn}: QUARTZ in the PDF at ${r.quartz.x.toFixed(1)}, ${r.quartz.y.toFixed(1)}; ink at ${centre.x.toFixed(1)}, ${centre.y.toFixed(1)} ± ${reach.toFixed(1)}`);
    }
  });

  await test('canvases, bitmaps, image data and image files are read; a broken file fails clearly', async () => {
    const r = await page.evaluate(async () => {
      const recognizer = await T.ocr.createRecognizer('en');
      const lines = [{ text: 'Searchable words here', x: 40, y: 90, size: 48 }];
      const out = {};
      try {
        const { canvas } = T.picture({ width: 700, height: 140, lines });
        out.offscreen = (await recognizer.recognize(canvas)).text;
        out.dom = (await recognizer.recognize(T.picture({ width: 700, height: 140, lines, kind: 'dom' }).canvas)).text;
        out.bitmap = (await recognizer.recognize(await createImageBitmap(canvas))).text;
        out.imageData = (await recognizer.recognize(canvas.getContext('2d').getImageData(0, 0, 700, 140))).text;
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        const fromBlob = await recognizer.recognize(blob);
        out.blob = fromBlob.text;
        out.blobSize = [fromBlob.width, fromBlob.height];
        try {
          await recognizer.recognize(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4])], { type: 'image/jpeg' }));
          out.broken = 'no error';
        } catch (e) {
          out.broken = T.errorKey(e);
        }
        // Still reads after a failure.
        out.after = (await recognizer.recognize(canvas)).text;
        const tiny = new OffscreenCanvas(1, 1);
        out.tiny = (await recognizer.recognize(tiny)).lines.length;
        const blank = T.picture({ width: 900, height: 600, lines: [] });
        out.blank = (await recognizer.recognize(blank.canvas)).lines.length;
      } finally {
        recognizer.terminate();
      }
      return out;
    });
    for (const kind of ['offscreen', 'dom', 'bitmap', 'imageData', 'blob', 'after']) {
      assert(r[kind] === 'Searchable words here', `${kind}: ${JSON.stringify(r[kind])}`);
    }
    assert(r.blobSize[0] === 700 && r.blobSize[1] === 140, 'an image file is measured as decoded');
    assert(r.broken === 'ocr_failed', `broken image: ${r.broken}`);
    assert(r.tiny === 0 && r.blank === 0, 'nothing to read, no lines');
  });

  await test('a large photo is read at the app\'s size and its words map back onto its own pixels', async () => {
    const r = await page.evaluate(async () => {
      // 4800 x 3600 is read at 3000 x 2250 (OcrScale).
      const { canvas, words } = T.picture({ width: 4800, height: 3600, lines: [{ text: 'Large photo text', x: 400, y: 900, size: 160 }] });
      const recognizer = await T.ocr.createRecognizer('en');
      const recognition = await recognizer.recognize(canvas);
      recognizer.terminate();
      return { recognition, words };
    });
    assert(r.recognition.width === 4800 && r.recognition.height === 3600, 'the photo\'s own size');
    const read = recognizedWords(r.recognition);
    for (const w of r.words) {
      const m = read.find((x) => x.text === w.text);
      assert(m && near(m.x0, w.x0, 12) && near(m.x1, w.x1, 12) && near(m.baseline[0].y, w.baseline, 12), `"${w.text}" at ${m && [m.x0, m.x1, m.baseline[0].y]}, drawn ${w.x0}..${w.x1} on ${w.baseline}`);
    }
  });

  await test('lines on a tilted photo stay whole lines, each word along its line', async () => {
    for (const degrees of [-3, 4]) {
      const r = await page.evaluate(async ({ degrees }) => {
        const texts = ['A tilted line of text here', 'The quick brown fox jumps over the lazy dog', 'Invoice number 48213 is due on Friday'];
        const c = new OffscreenCanvas(1600, 900);
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 1600, 900);
        g.fillStyle = '#000';
        g.font = '48px TestSans';
        const angle = (degrees * Math.PI) / 180;
        g.translate(800, 450);
        g.rotate(angle);
        g.translate(-800, -450);
        texts.forEach((t, i) => g.fillText(t, 150, 300 + i * 110));
        const recognizer = await T.ocr.createRecognizer('en');
        const recognition = await recognizer.recognize(c);
        recognizer.terminate();
        const rect = { x: 0, y: 0, width: 800, height: 450 };
        const { doc, page } = await T.pdfWithImage(c, { rect, pageWidth: 800, pageHeight: 450 });
        await T.ocr.addTextLayer(doc, page, recognition, rect);
        const bytes = await T.common.savePdf(doc);
        const { items } = await T.pdfText(bytes);
        // Where each line starts on the photo: (150, its baseline) turned about the middle.
        const starts = texts.map((t, i) => {
          const x = 150 - 800;
          const y = 300 + i * 110 - 450;
          return { x: 800 + x * Math.cos(angle) - y * Math.sin(angle), y: 450 + x * Math.sin(angle) + y * Math.cos(angle) };
        });
        return { texts, items, runs: await T.pdfRuns(bytes), starts, read: recognition.text };
      }, { degrees });
      const lines = r.items.filter((i) => i.str.trim()).map((i) => i.str);
      assert(JSON.stringify(lines) === JSON.stringify(r.texts), `${degrees} degrees: pdf.js lines ${JSON.stringify(lines)} (read ${JSON.stringify(r.read)})`);
      r.texts.forEach((text, i) => {
        const start = { x: r.starts[i].x / 2, y: 450 - r.starts[i].y / 2 };
        const first = r.runs.find((x) => x.text === text.split(' ')[0] && near(x.y, start.y, 12));
        assert(first, `${degrees} degrees: first word of "${text}" in ${JSON.stringify(r.runs.map((x) => [x.text, Math.round(x.x), Math.round(x.y)]))}`);
        assert(near(first.x, start.x, 6), `${degrees} degrees: "${text}" starts at x ${first.x}, ink ${start.x}`);
        assert(near(first.angle, -degrees, 0.75), `${degrees} degrees: written at ${first.angle} degrees`);
      });
    }
  });

  await test('a speckled picture beside the text is no reason to read the page turned', async () => {
    const r = await page.evaluate(async () => {
      const { canvas } = T.picture({ width: 2400, height: 1800, lines: [{ text: 'Photo of a gravel path', x: 120, y: 200, size: 64 }] });
      const g = canvas.getContext('2d');
      const patch = g.createImageData(900, 900);
      let seed = 7;
      for (let i = 0; i < patch.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        patch.data[i] = patch.data[i + 1] = patch.data[i + 2] = seed >>> 24;
        patch.data[i + 3] = 255;
      }
      g.putImageData(patch, 1300, 700);
      const recognizer = await T.ocr.createRecognizer('en');
      const recognition = await recognizer.recognize(canvas);
      recognizer.terminate();
      return { text: recognition.text, turned: recognition.turned };
    });
    assert(r.turned === 0, `read as it is: ${r.turned}`);
    assert(r.text.split('\n')[0] === 'Photo of a gravel path', `the text is read: ${JSON.stringify(r.text)}`);
  });

  await test('one worker reads many pages, reporting each page\'s progress', async () => {
    const before = workerRequests.length;
    const r = await page.evaluate(async () => {
      const recognizer = await T.ocr.createRecognizer('en');
      const texts = [];
      const progress = [];
      for (let i = 1; i <= 3; i++) {
        const { canvas } = T.picture({ width: 800, height: 160, lines: [{ text: `Page number ${i} of three`, x: 40, y: 100, size: 52 }] });
        texts.push((await recognizer.recognize(canvas, { onProgress: (done, total) => progress.push(done / total) })).text);
      }
      recognizer.terminate();
      let afterTerminate;
      try {
        await recognizer.recognize(new OffscreenCanvas(10, 10));
      } catch (e) {
        afterTerminate = T.errorKey(e);
      }
      return { texts, progress, afterTerminate };
    });
    assert(r.texts.join('|') === 'Page number 1 of three|Page number 2 of three|Page number 3 of three', r.texts.join('|'));
    assert(workerRequests.length - before === 1, `one worker for three pages: ${workerRequests.length - before} started`);
    assert(r.progress.length >= 3 && r.progress.every((p) => p >= 0 && p <= 1) && r.progress.at(-1) === 1, `page progress ${r.progress}`);
    assert(r.afterTerminate === 'cancelled', `after terminate: ${r.afterTerminate}`);
  });

  await test('cancelling stops a reading at once, and the next page is still read', async () => {
    const r = await page.evaluate(async () => {
      const recognizer = await T.ocr.createRecognizer('en');
      const lines = Array.from({ length: 40 }, (_, i) => ({ text: 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod', x: 100, y: 120 + i * 70, size: 40 }));
      const { canvas } = T.picture({ width: 2100, height: 3000, lines });
      const controller = new AbortController();
      const t0 = performance.now();
      const reading = recognizer.recognize(canvas, { signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      let first;
      try {
        await reading;
        first = 'finished';
      } catch (e) {
        first = T.errorKey(e);
      }
      const stoppedAfter = performance.now() - t0;
      const next = (await recognizer.recognize(T.picture({ width: 700, height: 140, lines: [{ text: 'Still working', x: 40, y: 90, size: 48 }] }).canvas)).text;
      // Cancelling the whole recognizer: this reading and any later one stop.
      const all = new AbortController();
      const second = await T.ocr.createRecognizer('en', { signal: all.signal });
      const running = second.recognize(canvas);
      setTimeout(() => all.abort(), 200);
      let whole;
      try {
        await running;
        whole = 'finished';
      } catch (e) {
        whole = T.errorKey(e);
      }
      let later;
      try {
        await second.recognize(canvas);
        later = 'finished';
      } catch (e) {
        later = T.errorKey(e);
      }
      recognizer.terminate();
      let preAborted;
      try {
        await T.ocr.createRecognizer('en', { signal: AbortSignal.abort() });
      } catch (e) {
        preAborted = T.errorKey(e);
      }
      return { first, stoppedAfter, next, whole, later, preAborted };
    });
    assert(r.first === 'cancelled', `cancelled reading: ${r.first}`);
    assert(r.stoppedAfter < 1500, `stopped quickly: ${r.stoppedAfter} ms`);
    assert(r.next === 'Still working', `next page read: ${r.next}`);
    assert(r.whole === 'cancelled' && r.later === 'cancelled', `recognizer cancelled: ${r.whole}, ${r.later}`);
    assert(r.preAborted === 'cancelled', 'an aborted signal stops before starting');
  });

  await test('the default text language follows the app\'s', async () => {
    const r = await page.evaluate(() => ['en', 'fr', 'es-MX', 'hi', 'de', undefined].map((l) => T.ocr.defaultOcrLanguage(l)));
    assert(r.join() === 'en,fr,es,hi,en,en', r.join());
  });
});

// Downloads, some made to fail: the browser reports each failed request in the console, which
// is allowed here; any other console error still fails.
await withPage(async (page, url) => {
  await page.goto(url + 'app/fonts/OFL.txt');
  await installHelpers(page, url);

  await test('the first use downloads from this site with progress', async () => {
    const r = await page.evaluate(async () => {
      const progress = [];
      const recognizer = await T.ocr.createRecognizer('es', { onProgress: (done, total) => progress.push([done, total]) });
      recognizer.terminate();
      const files = await T.loader.filesFor('es');
      const sizes = await Promise.all(files.map(async (f) => (await fetch(f.url, { method: 'HEAD' })).headers.get('content-length')));
      const again = [];
      (await T.ocr.createRecognizer('es', { onProgress: (d, t) => again.push([d, t]) })).terminate();
      return { progress, total: sizes.reduce((a, b) => a + Number(b), 0), files: files.map((f) => f.url), again };
    });
    assert(r.files.every((f) => f.includes('/usugami-website/app/vendor/tesseract/') || f.includes('/usugami-website/app/fonts/')), `files from this site: ${r.files}`);
    assert(r.files.some((f) => f.endsWith('spa.traineddata.gz')), 'Spanish data');
    assert(r.progress.length >= 3, `progress reported: ${r.progress.length}`);
    for (let i = 1; i < r.progress.length; i++) assert(r.progress[i][0] >= r.progress[i - 1][0], 'progress only grows');
    assert(r.progress.every(([d, t]) => d <= t), 'never past the total');
    const [lastDone, lastTotal] = r.progress.at(-1);
    assert(lastDone === lastTotal && lastDone === r.total, `ends at every byte: ${lastDone} of ${lastTotal}, files ${r.total}`);
    assert(r.again.length === 0, 'not downloaded again in this tab');
  });

  await test('no connection, a missing file or a stalled download fail with the app\'s messages', async () => {
    await page.route('**/fra.traineddata.gz', (route) => route.abort('internetdisconnected'));
    await page.route('**/hin.traineddata.gz', (route) => route.fulfill({ status: 404, body: 'Not found' }));
    const r = await page.evaluate(async () => {
      const key = async (lang) => {
        try {
          (await T.ocr.createRecognizer(lang)).terminate();
          return 'started';
        } catch (e) {
          return T.errorKey(e);
        }
      };
      return { offline: await key('fr'), missing: await key('hi') };
    });
    assert(r.offline === 'ocr_problem_download', `offline: ${r.offline}`);
    assert(r.missing === 'ocr_problem_failed', `missing file: ${r.missing}`);
    await page.unroute('**/fra.traineddata.gz');
    await page.unroute('**/hin.traineddata.gz');
    // A server that stops answering.
    await page.route('**/stalled.bin', () => {});
    const stalled = await page.evaluate(async () => {
      const t0 = performance.now();
      try {
        await T.loader.download([{ url: new URL('app/stalled.bin', T.base).href, size: 1000 }], { stallTimeout: 400 });
        return 'finished';
      } catch (e) {
        return `${T.errorKey(e)} after ${Math.round(performance.now() - t0)} ms`;
      }
    });
    assert(/^ocr_problem_download after \d+ ms$/.test(stalled) && Number(stalled.match(/\d+/)[0]) < 3000, `stalled: ${stalled}`);
  });

  await test('cancelling the first download stops it', async () => {
    // A slow connection: the French data takes three seconds to come.
    await page.route('**/fra.traineddata.gz', async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue().catch(() => {});
    });
    const r = await page.evaluate(async () => {
      const controller = new AbortController();
      const t0 = performance.now();
      let progressed = false;
      const p = T.ocr.createRecognizer('fr', { signal: controller.signal, onProgress: () => { progressed = true; } });
      setTimeout(() => controller.abort(), 300);
      try {
        (await p).terminate();
        return { result: 'started' };
      } catch (e) {
        return { result: T.errorKey(e), ms: performance.now() - t0, progressed };
      }
    });
    assert(r.result === 'cancelled' && r.ms < 2000 && r.progressed, `cancelled download: ${JSON.stringify(r)}`);
    await page.unroute('**/fra.traineddata.gz');
  });
}, { allowConsole: [/^Failed to load resource: (net::ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|the server responded with a status of 404)/] });

// A job the worker fails (bytes that aren't an image) rejects only its own promise: without the
// errorHandler startWorker passes, tesseract.js would also throw it in the worker's message
// handler, an uncaught error that fails this page. Leptonica's notes about the bytes are allowed.
await withPage(async (page, url) => {
  await page.goto(url + 'app/fonts/OFL.txt');
  await installHelpers(page, url);
  await test('a job the worker fails rejects its own promise only, and the worker reads on', async () => {
    const r = await page.evaluate(async () => {
      const worker = await T.loader.startWorker('en');
      let rejected = null;
      try {
        await worker.recognize(new Uint8Array([1, 2, 3, 4, 5]));
      } catch (e) {
        rejected = String(e?.message ?? e);
      }
      // An uncaught error would arrive just after the rejection.
      await new Promise((done) => setTimeout(done, 300));
      const { canvas } = T.picture({ width: 700, height: 140, lines: [{ text: 'Still reading', x: 30, y: 90, size: 56 }] });
      const text = (await worker.recognize(canvas)).data.text;
      await worker.terminate();
      return { rejected, text };
    });
    assert(r.rejected, 'the failed job rejects');
    assert(/Still reading/.test(r.text), `the worker reads on: ${JSON.stringify(r.text)}`);
  });
}, { allowConsole: [/findFileFormatStream|pixReadStream|pixRead|Image file \/input cannot be read/] });

// Hindi. Tesseract's Hindi data named two settings this engine build doesn't have
// (classify_misfit_junk_penalty, merge_fragments_in_matrix), which its worker printed as console
// errors; npm run vendor takes them out of the data, so a Hindi worker starts without any.
await withPage(async (page, url) => {
  // Also at levels other than errors (errors fail the harness anyway).
  const warnings = [];
  page.on('console', (m) => { if (/Parameter not found/.test(m.text())) warnings.push(`${m.type()}: ${m.text()}`); });
  await page.goto(url + 'app/fonts/OFL.txt');
  await installHelpers(page, url);

  await test('Hindi mode reads Devanagari and English words, kept in logical order for search and copy', async () => {
    const setup = {
      lang: 'hi', width: 1700, height: 900,
      rect: { x: 40, y: 300, width: 515, height: 515 * (900 / 1700) },
      lines: [
        { text: 'नमस्ते दुनिया भारत मेरा देश है', x: 100, y: 170, size: 64, font: 'TestDeva' },
        { text: 'किताब Hello World 2024', x: 100, y: 330, size: 64, font: 'TestDeva' },
        { text: 'The quick brown fox jumps', x: 100, y: 490, size: 60 },
        // Numbers with the digit 1, which Tesseract's Hindi data would never read, and dandas.
        { text: 'भारत सन 1947 में है।', x: 100, y: 640, size: 60, font: 'TestDeva' },
        { text: 'Call 1-800-111 in 2019 or 1999', x: 100, y: 790, size: 60 },
      ],
    };
    const r = await readDrawnPage(page, setup);
    await saveOutput('ocr-hindi.pdf', r.bytes);
    checkWordsLieOverTheirInk(r, { ...setup, label: 'Hindi', looseStart: (word) => word.startsWith('1') });
    assert(r.changed === 0, 'invisible');
    for (const l of setup.lines) assert(r.text.includes(l.text), `"${l.text}" exactly, in ${JSON.stringify(r.text)}`);
    assert(warnings.length === 0, `settings the engine doesn't know: ${warnings.join('; ')}`);
  });
});

// The other browsers, at desktop size: Firefox, and WebKit (Safari's engine, as on iPhones).
for (const browser of ['firefox', 'webkit']) {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/fonts/OFL.txt');
    await installHelpers(page, url);
    await test(`${browser}: a page is read and its text layer found`, async () => {
      const setup = {
        lang: 'en', width: 1200, height: 400,
        rect: { x: 40, y: 400, width: 500, height: 500 / 3 },
        lines: [{ text: 'Invoice number 48213 is due on Friday.', x: 60, y: 160, size: 52 }, { text: 'School notes 12345', x: 60, y: 300, size: 52 }],
      };
      const r = await readDrawnPage(page, setup);
      checkWordsLieOverTheirInk(r, { ...setup, label: browser });
      assert(r.changed === 0, `${browser}: invisible`);
    });
    // The Hindi worker loads its own data, which named settings the engine lacks (see above): a
    // console error there fails this page.
    await test(`${browser}: a Hindi worker starts without console errors and reads Devanagari`, async () => {
      const setup = {
        lang: 'hi', width: 1200, height: 300,
        rect: { x: 40, y: 400, width: 500, height: 125 },
        lines: [{ text: 'नमस्ते दुनिया भारत मेरा देश है', x: 60, y: 170, size: 64, font: 'TestDeva' }],
      };
      const r = await readDrawnPage(page, setup);
      assert(r.text.includes(setup.lines[0].text), `${browser}: Hindi read: ${JSON.stringify(r.text)}`);
    });
  }, { browser, viewport: { width: 1366, height: 768 } });
}

assert(externalRequests.length === 0, `requests to other hosts: ${externalRequests.join(', ')}`);
console.log(`${count} tests passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
