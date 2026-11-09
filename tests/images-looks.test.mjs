// Page looks, image encoders and image PDFs (engine/images: looks.js, encode.js, ccitt.js,
// jpeg.js, page-layout.js, build-pdf.js). Ports the app's DocumentLooksTest, CcittG4Test,
// GrayJpegTest, JpegTest, RasterEncoderTest, ImagePdfBuilderTest, PageLayoutTest, CompressionTest,
// ImagePlacementTest and PdfSyntaxTest, and its LooksDeviceTest and ImageExportDeviceTest end to
// end: PDFs made from synthetic photos, read back with pdf-lib and pdf.js (whose decoders share no
// code with ours) and compared pixel by pixel.
//
//   node tests/images-looks.test.mjs            all, in Chromium, then a part in Firefox and WebKit
//   node tests/images-looks.test.mjs looks      only the tests whose names contain "looks"
//   BROWSERS=firefox,webkit node tests/images-looks.test.mjs   every test in those browsers
import { withPage } from './harness.mjs';

const filters = process.argv.slice(2);
const tests = [];
const test = (name, fn, { browsers = ['chromium'] } = {}) => tests.push({ name, fn, browsers });

// ---------------------------------------------------------------------------------------------
// Helpers that run in the page. Defined here as a function so Node checks their syntax; its source
// is evaluated in the page, with the modules under test passed in.

function pageHelpers(m) {
  const { looks } = m;

  const assert = (condition, message) => {
    if (!condition) throw new Error('Assertion failed: ' + message);
  };
  const near = (a, b, eps, message) => assert(Math.abs(a - b) <= eps, `${message}: ${a} is not ${b} (±${eps})`);
  const equal = (a, b, message) => assert(Object.is(a, b) || a === b, `${message}: ${JSON.stringify(a)} is not ${JSON.stringify(b)}`);
  const sameArray = (a, b, message) => {
    assert(a.length === b.length, `${message}: length ${a.length} is not ${b.length}`);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${message}: differ at ${i}: ${a[i]} vs ${b[i]}`);
  };

  /** A seeded random number generator (mulberry32): nextInt(from, until). */
  function random(seed) {
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { next, nextInt: (from, until) => from + Math.floor(next() * (until - from)) };
  }

  const luma = (r, g, b) => (r * 77 + g * 150 + b * 29) >> 8;

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  const pixelsOf = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);

  /** The page as printed (DocumentLooksTest.page): A4's shape, print, a bold heading, a box, a pencil line, a red stamp. */
  function printedPage(width = 1240) {
    const height = Math.trunc((width * 297) / 210);
    const c = canvas(width, height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = 'rgb(246,245,240)';
    g.fillRect(0, 0, width, height);
    const unit = width / 1240;
    g.fillStyle = 'rgb(20,20,26)';
    g.font = `bold ${Math.trunc(90 * unit)}px sans-serif`;
    g.fillText('QUARTERLY', 90 * unit, 190 * unit);
    const words = 'The quick brown fox jumps over the lazy dog while invoice 4821 waits for Friday.';
    let y = 290 * unit;
    [26, 30, 34, 40].forEach((size, i) => {
      g.font = `${Math.trunc(size * unit)}px ${i % 2 === 0 ? 'serif' : 'sans-serif'}`;
      for (let k = 0; k < 5; k++) {
        g.fillText(words, 90 * unit, y);
        y += size * unit * 1.5;
      }
    });
    const box = { x: Math.trunc(90 * unit), y: Math.trunc(y + 20 * unit), w: Math.trunc(240 * unit), h: Math.trunc(160 * unit) };
    g.fillRect(box.x, box.y, box.w, box.h);
    g.strokeStyle = 'rgb(165,165,160)';
    g.lineWidth = 3 * unit;
    g.beginPath();
    g.moveTo(Math.trunc(420 * unit), Math.trunc(y + 60 * unit));
    g.lineTo(Math.trunc(1100 * unit), Math.trunc(y + 90 * unit));
    g.stroke();
    g.fillStyle = 'rgb(200,30,40)';
    g.font = `bold ${Math.trunc(60 * unit)}px sans-serif`;
    g.fillText('PAID', 520 * unit, y + 190 * unit);
    y += 260 * unit;
    g.fillStyle = 'rgb(20,20,26)';
    g.font = `${Math.trunc(30 * unit)}px serif`;
    while (y < height - 80 * unit) {
      g.fillText(words, 90 * unit, y);
      y += 45 * unit;
    }
    const image = pixelsOf(c);
    const lumas = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < lumas.length; p++, i += 4) lumas[p] = luma(image.data[i], image.data[i + 1], image.data[i + 2]);
    // Paper: bright, and nothing darker within 2 pixels (a 5 x 5 minimum).
    const across = new Uint8Array(width * height);
    for (let yy = 0; yy < height; yy++) {
      for (let x = 0; x < width; x++) {
        let v = 255;
        for (let d = -2; d <= 2; d++) v = Math.min(v, lumas[yy * width + Math.min(width - 1, Math.max(0, x + d))]);
        across[yy * width + x] = v;
      }
    }
    const paper = new Uint8Array(width * height);
    for (let yy = 0; yy < height; yy++) {
      for (let x = 0; x < width; x++) {
        let v = 255;
        for (let d = -2; d <= 2; d++) v = Math.min(v, across[Math.min(height - 1, Math.max(0, yy + d)) * width + x]);
        paper[yy * width + x] = v >= 225 ? 1 : 0;
      }
    }
    return {
      image, width, height, box, lumas,
      luma: (x, yy) => lumas[yy * width + x],
      isInk: (x, yy) => lumas[yy * width + x] < 110,
      isPaper: (x, yy) => paper[yy * width + x] === 1,
      isStamp: (x, yy) => {
        const i = (yy * width + x) * 4;
        return image.data[i] > 180 && image.data[i + 1] < 60;
      },
    };
  }

  /** `page` as a phone photographs it (DocumentLooksTest.photo): light falling off, a hard shadow, a warm lamp, noise. */
  function photo(page, { shadow = true, lamp = true, seed = 1 } = {}) {
    const { width: w, height: h } = page;
    const out = new ImageData(w, h);
    const rnd = random(seed);
    const tint = lamp ? [1, 0.92, 0.76] : [1, 1, 1];
    const soft = w * 0.004;
    const src = page.image.data;
    const d = out.data;
    for (let y = 0; y < h; y++) {
      const down = shadow ? (1 / (1 + Math.exp((h * 0.3 - y) / soft))) * (1 / (1 + Math.exp((y - h * 0.7) / soft))) : 0;
      for (let x = 0; x < w; x++) {
        let light = 1 - (0.55 * (x / w + y / h)) / 2;
        if (shadow) light *= 1 - 0.45 * (1 / (1 + Math.exp((x - w * 0.35) / soft))) * down;
        const i = (y * w + x) * 4;
        const noise = rnd.nextInt(-5, 6);
        for (let k = 0; k < 3; k++) d[i + k] = Math.min(255, Math.max(0, Math.trunc(src[i + k] * light * tint[k] + noise)));
        d[i + 3] = 255;
      }
    }
    return out;
  }

  /** `imageData` with any look, as RGBA ImageData. */
  function made(imageData, look, adjustments = {}) {
    return looks.applyLook(imageData, look, adjustments, { output: 'imagedata' });
  }

  function bits(imageData, look = 'black_white', adjustments = {}) {
    const gen = looks.blackAndWhiteGen(imageData, look, adjustments);
    for (;;) {
      const s = gen.next();
      if (s.done) return s.value;
    }
  }

  function gray(imageData, adjustments = {}) {
    const gen = looks.grayscaleGen(imageData, adjustments);
    for (;;) {
      const s = gen.next();
      if (s.done) return s.value;
    }
  }

  const blackCount = (b) => {
    let n = 0;
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (looks.isBlack(b, x, y)) n++;
    return n;
  };

  const lumaAt = (img, x, y) => {
    const i = (y * img.width + x) * 4;
    return luma(img.data[i], img.data[i + 1], img.data[i + 2]);
  };

  function meanLuma(img, where = () => true) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (where(x, y)) {
          sum += lumaAt(img, x, y);
          count++;
        }
      }
    }
    return sum / count;
  }

  function spread(img) {
    const mean = meanLuma(img);
    let sum = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) sum += (lumaAt(img, x, y) - mean) ** 2;
    return Math.sqrt(sum / (img.width * img.height));
  }

  /** How much of the paper came out white and of the ink black. */
  function score(page, black) {
    let paper = 0;
    let white = 0;
    let ink = 0;
    let dark = 0;
    for (let y = 0; y < page.height; y++) {
      for (let x = 0; x < page.width; x++) {
        if (page.isInk(x, y)) {
          ink++;
          if (black(x, y)) dark++;
        } else if (page.isPaper(x, y)) {
          paper++;
          if (!black(x, y)) white++;
        }
      }
    }
    return [white / paper, dark / ink];
  }

  /** RGB to hue (degrees) and saturation, as java.awt.Color.RGBtoHSB. */
  function hsb(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    let hue = 0;
    if (saturation !== 0) {
      const rc = (max - r) / (max - min);
      const gc = (max - g) / (max - min);
      const bc = (max - b) / (max - min);
      if (r === max) hue = bc - gc;
      else if (g === max) hue = 2 + rc - bc;
      else hue = 4 + gc - rc;
      hue /= 6;
      if (hue < 0) hue += 1;
    }
    return [hue * 360, saturation];
  }

  function stampColour(page, img) {
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = 0; y < page.height; y++) {
      for (let x = 0; x < page.width; x++) {
        if (page.isStamp(x, y)) {
          const i = (y * img.width + x) * 4;
          sum[0] += img.data[i];
          sum[1] += img.data[i + 1];
          sum[2] += img.data[i + 2];
          count++;
        }
      }
    }
    return hsb(Math.trunc(sum[0] / count), Math.trunc(sum[1] / count), Math.trunc(sum[2] / count));
  }

  const hueDistance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

  /** A BitImage from black(x, y), in the API's order: 1 for black. */
  function bitsBlackIs1(width, height, black) {
    const rowBytes = (width + 7) >> 3;
    const data = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (black(x, y)) data[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    return { width, height, rowBytes, data };
  }

  /** A PDF with a page for each [width, height, filter, decodeParms, data, bpc, colorSpace] image, drawn 1:1. */
  async function pdfOfImages(images) {
    const { PDFDocument, PDFName } = m.pdflib;
    const doc = await PDFDocument.create();
    for (const im of images) {
      const ref = doc.context.register(doc.context.stream(im.data, {
        Type: 'XObject', Subtype: 'Image', Width: im.width, Height: im.height,
        BitsPerComponent: im.bpc ?? 1, ColorSpace: im.colorSpace ?? 'DeviceGray', Filter: im.filter,
        ...(im.decodeParms ? { DecodeParms: im.decodeParms } : {}),
      }));
      const p = doc.addPage([im.width, im.height]);
      p.node.setXObject(PDFName.of('Im0'), ref);
      p.node.addContentStream(doc.context.register(doc.context.stream(`q ${im.width} 0 0 ${im.height} 0 0 cm /Im0 Do Q`)));
    }
    return doc.save();
  }

  /** The first image drawn on each page of `bytes`, decoded by pdf.js, as ImageData. */
  async function pdfjsImages(bytes, pages = null) {
    const doc = await m.pdfjs.openPdfJs(bytes);
    const out = [];
    try {
      const count = doc.numPages;
      for (let n = 1; n <= count; n++) {
        if (pages && !pages.includes(n)) continue;
        const page = await doc.getPage(n);
        const ops = await page.getOperatorList();
        const at = ops.fnArray.indexOf(m.pdfjs.pdfjsLib.OPS.paintImageXObject);
        if (at < 0) {
          out.push(null);
          continue;
        }
        const id = ops.argsArray[at][0];
        const img = await new Promise((resolve) => page.objs.get(id, resolve));
        let data;
        if (img.bitmap) {
          const c = canvas(img.bitmap.width, img.bitmap.height);
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img.bitmap, 0, 0);
          data = g.getImageData(0, 0, c.width, c.height);
        } else {
          data = new ImageData(img.width, img.height);
          const d = data.data;
          if (img.kind === 1) {
            const rowBytes = (img.width + 7) >> 3;
            for (let y = 0; y < img.height; y++) {
              for (let x = 0; x < img.width; x++) {
                const v = (img.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
                const i = (y * img.width + x) * 4;
                d[i] = d[i + 1] = d[i + 2] = v;
                d[i + 3] = 255;
              }
            }
          } else if (img.kind === 2) {
            for (let p = 0; p < img.width * img.height; p++) {
              d[p * 4] = img.data[p * 3];
              d[p * 4 + 1] = img.data[p * 3 + 1];
              d[p * 4 + 2] = img.data[p * 3 + 2];
              d[p * 4 + 3] = 255;
            }
          } else {
            d.set(img.data);
          }
        }
        out.push(data);
        page.cleanup();
      }
    } finally {
      await doc.loadingTask.destroy();
    }
    return out;
  }

  /** Page `n` of `bytes` rendered by pdf.js `width` pixels wide, on white. */
  async function renderPage(bytes, n, width) {
    const doc = await m.pdfjs.openPdfJs(bytes);
    try {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const c = canvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, canvas: c, viewport }).promise;
      return ctx.getImageData(0, 0, c.width, c.height);
    } finally {
      await doc.loadingTask.destroy();
    }
  }

  /** Each page's facts, read with pdf-lib: its box, its image's dictionary and size, its content. */
  async function pdfFacts(bytes) {
    const { PDFDocument, PDFName, PDFRawStream } = m.pdflib;
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const name = (v) => (v ? v.toString() : null);
    const pages = doc.getPages().map((p) => {
      const box = p.node.MediaBox().asArray().map((n) => n.asNumber());
      const xobjects = p.node.Resources().lookup(PDFName.of('XObject'));
      const image = xobjects.lookup(PDFName.of('Im0'));
      const dict = image.dict;
      const parms = dict.lookup(PDFName.of('DecodeParms'));
      const parm = (k) => parms?.lookup(PDFName.of(k))?.asNumber?.() ?? null;
      const contents = p.node.Contents();
      const streams = contents ? (contents.asArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents]) : [];
      const text = streams.map((s) => (s instanceof PDFRawStream ? new TextDecoder('latin1').decode(s.contents) : '')).join('\n');
      return {
        box,
        width: dict.lookup(PDFName.of('Width')).asNumber(),
        height: dict.lookup(PDFName.of('Height')).asNumber(),
        bpc: dict.lookup(PDFName.of('BitsPerComponent')).asNumber(),
        colorSpace: name(dict.lookup(PDFName.of('ColorSpace'))),
        filter: name(dict.lookup(PDFName.of('Filter'))),
        parms: parms ? Object.fromEntries(['K', 'Columns', 'Rows', 'Predictor', 'Colors', 'BitsPerComponent', 'ColorTransform'].map((k) => [k, parm(k)]).filter(([, v]) => v != null)) : null,
        data: image.contents,
        content: text,
      };
    });
    const info = (k) => {
      const v = doc.getInfoDict().lookup(PDFName.of(k));
      return v?.decodeText ? v.decodeText() : v?.toString() ?? null;
    };
    return {
      pages,
      title: doc.getTitle(),
      producer: doc.getProducer(),
      creator: doc.getCreator(),
      created: info('CreationDate'),
      infoKeys: doc.getInfoDict().keys().map((k) => k.toString()),
    };
  }

  /** The `cm` matrix in a page's content. */
  const cmOf = (content) => {
    const match = /q\n([-\d. ]+) cm\n\/Im0 Do\nQ/.exec(content);
    return match ? match[1].split(' ').map(Number) : null;
  };

  /** A JPEG of `c` (a canvas) at `quality` (0 to 1), as the browser encodes it. */
  async function jpegOf(c, quality = 0.9) {
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function pngOf(c) {
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function decodeImage(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const c = canvas(bitmap.width, bitmap.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    return g.getImageData(0, 0, c.width, c.height);
  }

  /** The pattern image of the app's TestImages.pattern on a canvas. */
  function patternCanvas(width, height) {
    const c = canvas(width, height);
    const g = c.getContext('2d');
    const img = g.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        img.data[i] = Math.trunc((x * 255) / Math.max(1, width - 1));
        img.data[i + 1] = Math.trunc((y * 255) / Math.max(1, height - 1));
        img.data[i + 2] = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 40 : 220;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /** Peak signal to noise ratio of `decoded` (RGBA) against a grey picture, in dB. */
  function psnr(grayImage, decoded) {
    let squares = 0;
    for (let p = 0; p < grayImage.pixels.length; p++) {
      const d = grayImage.pixels[p] - decoded.data[p * 4];
      squares += d * d;
    }
    const mse = squares / grayImage.pixels.length;
    return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
  }

  /** Mean absolute difference of the brightness of two RGBA pictures the same size. */
  function meanDifference(a, b) {
    let sum = 0;
    for (let i = 0; i < a.data.length; i += 4) sum += Math.abs(luma(a.data[i], a.data[i + 1], a.data[i + 2]) - luma(b.data[i], b.data[i + 1], b.data[i + 2]));
    return sum / (a.data.length / 4);
  }

  function indexOf(bytes, pattern, from = 0) {
    const p = typeof pattern === 'string' ? new TextEncoder().encode(pattern) : pattern;
    outer: for (let i = from; i <= bytes.length - p.length; i++) {
      for (let j = 0; j < p.length; j++) if (bytes[i + j] !== p[j]) continue outer;
      return i;
    }
    return -1;
  }

  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  /** A marker segment: FF marker, 2-byte length, payload. */
  const segment = (marker, payload) => {
    const p = typeof payload === 'string' ? Uint8Array.from(payload, (c) => c.charCodeAt(0)) : payload;
    return concat(Uint8Array.of(0xff, marker, (p.length + 2) >> 8, (p.length + 2) & 0xff), p);
  };

  const withSegments = (jpeg, ...segments) => concat(jpeg.subarray(0, 2), ...segments, jpeg.subarray(2));

  /** The share of the part of `img` in `area` (fractions, x across and y down) whose pixels pass `test`. */
  function share(img, area, margin, testFn) {
    const left = Math.trunc((area[0] + margin) * img.width);
    const right = Math.trunc((area[2] - margin) * img.width);
    const top = Math.trunc((area[1] + margin) * img.height);
    const bottom = Math.trunc((area[3] - margin) * img.height);
    let passed = 0;
    let all = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (y * img.width + x) * 4;
        all++;
        if (testFn(img.data[i], img.data[i + 1], img.data[i + 2])) passed++;
      }
    }
    return passed / all;
  }

  /** The app's ShadedPages photo: print, a black bar and blank paper in a shadow, as a JPEG. */
  async function shadedPhoto(width = 1240) {
    const height = Math.trunc((width * 297) / 210);
    const c = canvas(width, height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = 'rgb(246,245,240)';
    g.fillRect(0, 0, width, height);
    const unit = width / 1240;
    g.fillStyle = 'rgb(22,22,28)';
    g.font = `bold ${80 * unit}px sans-serif`;
    g.fillText('QUARTZ REPORT', 90 * unit, 160 * unit);
    g.font = `${34 * unit}px serif`;
    const lines = ['The quick brown fox jumps over the lazy dog.', 'Invoice number 48213 is due on Friday.', 'Pages scanned with a phone come out clean.'];
    lines.forEach((line, i) => g.fillText(line, 90 * unit, (260 + 60 * i) * unit));
    g.fillRect(SHADED.BAR[0] * width, SHADED.BAR[1] * height, (SHADED.BAR[2] - SHADED.BAR[0]) * width, (SHADED.BAR[3] - SHADED.BAR[1]) * height);
    let y = 0.6 * height;
    let i = 0;
    while (y < 0.92 * height) {
      g.fillText(lines[i++ % lines.length], 90 * unit, y);
      y += 60 * unit;
    }
    const img = g.getImageData(0, 0, width, height);
    const d = img.data;
    const rnd = random(2);
    const soft = width * 0.004;
    for (let py = 0; py < height; py++) {
      const fy = py / height;
      const down = (1 / (1 + Math.exp((0.3 * height - py) / soft))) * (1 / (1 + Math.exp((py - 0.7 * height) / soft)));
      for (let px = 0; px < width; px++) {
        const fx = px / width;
        const across = 1 / (1 + Math.exp((px - 0.45 * width) / soft));
        const light = (1 - (0.4 * (fx + fy)) / 2) * (1 - 0.45 * across * down);
        const noise = rnd.nextInt(-4, 5);
        const k = (py * width + px) * 4;
        d[k] = Math.min(255, Math.max(0, Math.trunc(d[k] * light + noise)));
        d[k + 1] = Math.min(255, Math.max(0, Math.trunc(d[k + 1] * light * 0.93 + noise)));
        d[k + 2] = Math.min(255, Math.max(0, Math.trunc(d[k + 2] * light * 0.8 + noise)));
      }
    }
    g.putImageData(img, 0, 0);
    return { bytes: await jpegOf(c, 0.92), width, height, imageData: img };
  }

  const SHADED = {
    SHADED_PAPER: [0.05, 0.36, 0.38, 0.46],
    LIT_PAPER: [0.6, 0.36, 0.92, 0.46],
    BAR: [0.1, 0.5, 0.38, 0.53],
  };

  return {
    assert, near, equal, sameArray, random, luma, canvas, pixelsOf, printedPage, photo, made, bits, gray, blackCount,
    lumaAt, meanLuma, spread, score, stampColour, hueDistance, bitsBlackIs1, pdfOfImages, pdfjsImages, renderPage,
    pdfFacts, cmOf, jpegOf, pngOf, decodeImage, patternCanvas, psnr, meanDifference, indexOf, concat, segment,
    withSegments, share, shadedPhoto, SHADED,
  };
}

/** Loads the modules and helpers into the page as window.T. */
async function setUp(page, url) {
  await page.route(url + '__images-looks.html', (r) => r.fulfill({ body: '<!doctype html><meta charset="utf-8"><title>images-looks</title><body></body>', contentType: 'text/html' }));
  await page.goto(url + '__images-looks.html');
  await page.evaluate(async ({ base, src }) => {
    const imp = (p) => import(new URL(p, base).href);
    const mods = {
      looks: await imp('app/js/engine/images/looks.js'),
      encode: await imp('app/js/engine/images/encode.js'),
      ccitt: await imp('app/js/engine/images/ccitt.js'),
      jpeg: await imp('app/js/engine/images/jpeg.js'),
      layout: await imp('app/js/engine/images/page-layout.js'),
      build: await imp('app/js/engine/images/build-pdf.js'),
      source: await imp('app/js/engine/images/page-source.js'),
      canvasKit: await imp('app/js/engine/images/canvas.js'),
      errors: await imp('app/js/core/errors.js'),
      pdflib: await imp('app/js/lib/pdf-lib.js'),
      pdfjs: await imp('app/js/lib/pdfjs.js'),
      fflate: await imp('app/js/lib/fflate.js'),
    };
    // eslint-disable-next-line no-eval
    window.T = { ...mods, ...(0, eval)('(' + src + ')')(mods) };
  }, { base: url, src: pageHelpers.toString() });
}

// ---------------------------------------------------------------------------------------------
// PageLayoutTest, CompressionTest, ImagePlacementTest, PdfSyntaxTest

test('layout: A4 portrait without a margin fits a landscape photo to its width', (page) => page.evaluate(() => {
  const { layout: L, near } = window.T;
  const g = L.computeLayout(4000, 3000, { pageSize: 'a4', orientation: 'portrait', margin: 'none' });
  near(g.pageWidth, 595.2756, 1e-4, 'width');
  near(g.pageHeight, 841.8898, 1e-4, 'height');
  near(g.imageWidth, g.pageWidth, 1e-6, 'image width');
  near(g.imageHeight, g.pageWidth * 0.75, 1e-6, 'image height');
  near(g.imageX, 0, 1e-6, 'x');
  near(g.imageY, (g.pageHeight - g.imageHeight) / 2, 1e-6, 'y');
  near(g.imageTop, g.imageY, 1e-6, 'centred');
}));

test('layout: Auto orientation follows the image', (page) => page.evaluate(() => {
  const { layout: L, near } = window.T;
  const auto = { pageSize: 'letter', orientation: 'auto', margin: 'none' };
  near(L.computeLayout(300, 200, auto).pageWidth, 792, 1e-6, 'wide');
  near(L.computeLayout(300, 200, auto).pageHeight, 612, 1e-6, 'wide height');
  near(L.computeLayout(200, 300, auto).pageWidth, 612, 1e-6, 'tall');
  near(L.computeLayout(500, 500, auto).pageWidth, 612, 1e-6, 'square stays portrait');
}));

test('layout: landscape and margins, small images scaled up to fill', (page) => page.evaluate(() => {
  const { layout: L, near } = window.T;
  const g = L.computeLayout(1000, 1000, { pageSize: 'a4', orientation: 'landscape', margin: 'big' });
  near(g.pageWidth, 841.8898, 1e-4, 'width');
  near(g.pageHeight, 595.2756, 1e-4, 'height');
  near(g.imageHeight, 595.2756 - 108, 1e-4, 'image height');
  near(g.imageY, 54, 1e-6, 'y');
  near(g.imageX, (g.pageWidth - g.imageWidth) / 2, 1e-6, 'x');
  const s = L.computeLayout(10, 20, { pageSize: 'a5', orientation: 'portrait', margin: 'small' });
  near(s.imageHeight, L.PAGE_SIZES.a5.longSide - 36, 1e-6, 'A5 image height');
  near(s.imageWidth, s.imageHeight / 2, 1e-6, 'A5 image width');
  // Every paper size, its sides in points.
  const sides = { a4: [595.2756, 841.8898], letter: [612, 792], legal: [612, 1008], a3: [841.8898, 1190.5512], a5: [419.5276, 595.2756] };
  for (const [size, [w, h]] of Object.entries(sides)) {
    near(L.PAGE_SIZES[size].shortSide, w, 1e-4, size);
    near(L.PAGE_SIZES[size].longSide, h, 1e-4, size);
  }
}));

test('layout: Fit uses pixels as points and a margin in proportion, within viewer limits', (page) => page.evaluate(() => {
  const { layout: L, near, equal, assert } = window.T;
  const none = L.computeLayout(1200, 800, { pageSize: 'fit', margin: 'none' });
  equal(JSON.stringify([none.pageWidth, none.pageHeight, none.imageX, none.imageY, none.imageWidth, none.imageHeight]), JSON.stringify([1200, 800, 0, 0, 1200, 800]), 'none');
  const small = L.computeLayout(1200, 800, { pageSize: 'fit', orientation: 'landscape', margin: 'small' });
  const m = (18 / L.PAGE_SIZES.a4.shortSide) * 800;
  near(small.pageWidth, 1200 + 2 * m, 1e-6, 'width');
  near(small.pageHeight, 800 + 2 * m, 1e-6, 'height');
  near(small.imageX, m, 1e-6, 'x');
  near(small.imageY, m, 1e-6, 'y');
  near(small.imageWidth, 1200, 1e-6, 'image width');
  const huge = L.computeLayout(30000, 10000, { pageSize: 'fit', margin: 'none' });
  near(huge.pageWidth, L.MAX_PAGE_SIDE, 1e-6, 'huge width');
  near(huge.pageHeight, 4800, 1e-6, 'huge height');
  const tiny = L.computeLayout(1, 2, { pageSize: 'fit', margin: 'none' });
  near(tiny.pageWidth, 3, 1e-6, 'tiny width');
  near(tiny.pageHeight, 6, 1e-6, 'tiny height');
  const strip = L.computeLayout(20000, 3, { pageSize: 'fit', margin: 'none' });
  near(strip.pageWidth, L.MAX_PAGE_SIDE, 1e-6, 'strip width');
  near(strip.pageHeight, L.MIN_PAGE_SIDE, 1e-6, 'strip height');
  near(strip.imageHeight, 2.16, 1e-6, 'strip image height');
  near(strip.imageY, (3 - 2.16) / 2, 1e-6, 'strip y');
  const withMargin = L.computeLayout(20000, 20000, { pageSize: 'fit', margin: 'big' });
  assert(withMargin.pageWidth <= L.MAX_PAGE_SIDE + 1e-6, 'within the limit');
  near(withMargin.pageWidth - 2 * withMargin.imageX, withMargin.imageWidth, 1e-6, 'margins');
}));

test('layout: the image is always inside its page, its shape kept', (page) => page.evaluate(() => {
  const { layout: L, assert, near } = window.T;
  for (const size of Object.keys(L.PAGE_SIZES)) for (const o of L.ORIENTATIONS) for (const margin of Object.keys(L.MARGINS)) {
    for (const [w, h] of [[1, 1], [4000, 3000], [3000, 4000], [100, 5000], [5000, 100]]) {
      const g = L.computeLayout(w, h, { pageSize: size, orientation: o, margin });
      const what = `${size} ${o} ${margin} ${w}x${h}`;
      assert(g.imageX >= -1e-6 && g.imageY >= -1e-6, what);
      assert(g.imageX + g.imageWidth <= g.pageWidth + 1e-6, what);
      assert(g.imageY + g.imageHeight <= g.pageHeight + 1e-6, what);
      near(g.imageWidth / g.imageHeight, w / h, 1e-9 * (w / h) + 1e-9, what);
    }
  }
}));

test('compression: sized for the space the image fills, never enlarged', (page) => page.evaluate(() => {
  const { layout: L, near, equal } = window.T;
  const a4 = { pageSize: 'a4', orientation: 'portrait', margin: 'none' };
  // A 3000 x 4000 photo filling A4 (8.27 in wide) at 150 dpi: 1240 px wide.
  equal(L.scaledSize(3000, 4000, L.scaleFor(3000, 4000, a4, 'recommended')).join('x'), '1240x1654', 'A4');
  const letter = { pageSize: 'letter', orientation: 'portrait', margin: 'big' };
  near(L.scaleFor(4000, 3000, letter, 'less'), (7 * 200) / 4000, 1e-9, 'less');
  near(L.scaleFor(4000, 3000, letter, 'extreme'), (7 * 100) / 4000, 1e-9, 'extreme');
  equal(L.scaleFor(800, 600, { pageSize: 'a4' }, 'less'), 1, 'never enlarges');
  equal(L.scaleFor(800, 600, { pageSize: 'fit' }, 'recommended'), 1, 'never enlarges on Fit');
  equal(L.scaledSize(3000, 4000, L.scaleFor(3000, 4000, { pageSize: 'fit' }, 'recommended')).join('x'), '1315x1754', 'Fit caps the long side');
  equal(L.scaleFor(1080, 10000, { pageSize: 'fit' }, 'recommended'), 1, 'long screenshot');
  equal(L.scaleFor(10000, 1080, { pageSize: 'fit' }, 'recommended'), 1, 'sideways screenshot');
  equal(L.scaledSize(3000, 12000, L.scaleFor(3000, 12000, { pageSize: 'fit' }, 'recommended')).join('x'), '1240x4961', 'wide screenshot');
  equal(L.savedPercent(1000, 1000), null, 'same');
  equal(L.savedPercent(1000, 995), null, 'under 1%');
  equal(L.savedPercent(1000, 990), 1, '1%');
  equal(L.savedPercent(1000, 500), 50, '50%');
  equal(L.savedPercent(0, 0), null, 'empty');
  equal(L.scaledSize(1, 1, 0.01).join('x'), '1x1', 'one pixel');
  equal(L.scaledSize(2, 100, 0.5).join('x'), '1x50', 'at least one pixel');
  equal(JSON.stringify(L.COMPRESSION), JSON.stringify({ less: { dpi: 200, jpegQuality: 85 }, recommended: { dpi: 150, jpegQuality: 75 }, extreme: { dpi: 100, jpegQuality: 55 } }), 'levels');
}));

test('placement: where a point of the image lands on its page, for every turn', (page) => page.evaluate(() => {
  const { layout: L, near, equal } = window.T;
  const point = (p, x, y, eps, what) => { near(p[0], x, eps, what + ' x'); near(p[1], y, eps, what + ' y'); };
  const place = (w, h, settings, exif = 1, rotation = 0) => {
    const t = L.imageTransform(exif, rotation);
    const [sw, sh] = L.swapsAxes(t) ? [h, w] : [w, h];
    return L.imagePlacement(L.computeLayout(sw, sh, settings), t);
  };
  let p = place(300, 400, { pageSize: 'a4', orientation: 'portrait', margin: 'small' });
  point(p.toPage(0, 0), 18, 793.7953, 1e-4, 'top-left');
  point(p.toPage(1, 1), 577.2756, 48.0945, 1e-4, 'bottom-right');
  point(p.toPage(0.25, 0.5), 18 + 559.2756 / 4, 48.0945 + 745.7008 / 2, 1e-4, 'quarter across');
  p = place(1000, 500, { pageSize: 'fit', orientation: 'auto', margin: 'big' });
  const m = (54 / L.PAGE_SIZES.a4.shortSide) * 500;
  near(p.geometry.pageWidth, 1000 + 2 * m, 1e-6, 'fit width');
  point(p.toPage(0, 0), m, m + 500, 1e-6, 'fit top-left');
  point(p.toPage(0.5, 0.5), m + 500, m + 250, 1e-6, 'fit middle');
  point(p.toPage(0.2, 0.2), m + 200, m + 400, 1e-6, 'fit pixel');
  p = place(400, 300, { pageSize: 'a4', orientation: 'landscape', margin: 'none' });
  point(p.toPage(0, 0), 24.0945, 595.2756, 1e-4, 'landscape top-left');
  point(p.toPage(1, 1), 817.7953, 0, 1e-4, 'landscape bottom-right');
  p = place(400, 300, { pageSize: 'a4', orientation: 'portrait', margin: 'none' }, 1, 90);
  point(p.toPage(0, 0), 0, 817.7953, 1e-4, 'turned top-left');
  point(p.toPage(1, 1), 595.2756, 24.0945, 1e-4, 'turned bottom-right');
  const mm = p.matrix;
  point(p.toPage(1, 0), mm[2] + mm[4], mm[3] + mm[5], 1e-6, 'stored top-left');
  const exif6 = place(400, 300, { pageSize: 'a4', orientation: 'portrait', margin: 'none' }, 6, 0);
  equal(JSON.stringify(exif6.matrix), JSON.stringify(p.matrix), 'EXIF 6 lands as a quarter turn');
  const geometry = { pageWidth: 600, pageHeight: 800, imageX: 30, imageY: 40, imageWidth: 500, imageHeight: 700 };
  for (let exif = 1; exif <= 8; exif++) {
    for (const rotation of [0, 90, 180, 270]) {
      const t = L.imageTransform(exif, rotation);
      const pl = L.imagePlacement(geometry, t);
      const k = pl.matrix;
      for (const [s, tt] of [[0, 0], [1, 0], [0.3, 0.8], [0.9, 0.25]]) {
        const shownS = t.a * s + t.b * tt + t.c;
        const shownT = t.d * s + t.e * tt + t.f;
        point(pl.toPage(shownS, shownT), k[0] * s + k[2] * (1 - tt) + k[4], k[1] * s + k[3] * (1 - tt) + k[5], 1e-6, `exif ${exif} rotation ${rotation}`);
      }
    }
  }
}));

test('PDF numbers use a dot and no exponent, at most four decimals', (page) => page.evaluate(() => {
  const { layout: L, equal } = window.T;
  const cases = [[0, '0'], [-0, '0'], [0.00001, '0'], [-0.00004, '0'], [1.5, '1.5'], [-12.25, '-12.25'], [595.275590551, '595.2756'],
    [841.88976378, '841.8898'], [14400, '14400'], [0.0001, '0.0001'], [1000000.1, '1000000.1'], [0.49999999, '0.5']];
  for (const [v, s] of cases) equal(L.pdfNumber(v), s, String(v));
}));

// ---------------------------------------------------------------------------------------------
// CcittG4Test (decoded by pdf.js's CCITTFaxDecode instead of Java's TIFF reader)

test('CCITT G4: a blank row is one bit then the end of the block; a blank page almost nothing', (page) => page.evaluate(() => {
  const { ccitt, sameArray, assert } = window.T;
  sameArray(ccitt.encodeCcittG4(new Uint8Array(1), 8, 1), [0x80, 0x08, 0x00, 0x80], 'blank row');
  // The same in DeviceGray order (1 for white).
  sameArray(ccitt.encodeCcittG4(Uint8Array.of(0xff), 8, 1, { blackIs1: false }), [0x80, 0x08, 0x00, 0x80], 'white is 1');
  const blank = ccitt.encodeCcittG4(new Uint8Array(310 * 3508), 2480, 3508);
  assert(blank.length < 3508 / 4 + 10, `blank page ${blank.length} bytes`);
}));

test('CCITT G4: each colour\'s codes are prefix-free; the changing elements of a row', (page) => page.evaluate(() => {
  const { ccitt, equal, assert, bitsBlackIs1 } = window.T;
  const eol = { code: 1, length: 12 };
  for (const codes of [[...ccitt.WHITE_TERMINATING, ...ccitt.WHITE_MAKE_UP, ...ccitt.EXTENDED, eol], [...ccitt.BLACK_TERMINATING, ...ccitt.BLACK_MAKE_UP, ...ccitt.EXTENDED, eol]]) {
    const strings = codes.map((c) => c.code.toString(2).padStart(c.length, '0'));
    equal(new Set(strings).size, strings.length, 'distinct');
    for (const a of strings) for (const b of strings) if (a !== b) assert(!b.startsWith(a), `${a} starts ${b}`);
  }
  equal(ccitt.WHITE_TERMINATING.length, 64, 'white terminating');
  equal(ccitt.BLACK_TERMINATING.length, 64, 'black terminating');
  equal(ccitt.WHITE_MAKE_UP.length, 27, 'white make-up');
  equal(ccitt.BLACK_MAKE_UP.length, 27, 'black make-up');
  equal(ccitt.EXTENDED.length, 13, 'extended');
  const image = bitsBlackIs1(20, 1, (x) => (x >= 0 && x <= 2) || (x >= 9 && x <= 16));
  const out = new Int32Array(24);
  const count = ccitt.changes(image.data, 0, 20, 0xff, out);
  equal(Array.from(out.subarray(0, count)).join(), '0,3,9,17', 'changes');
  equal(Array.from(out.subarray(count, count + 3)).join(), '20,20,20', 'then the width');
}));

test('CCITT G4: every run length of either colour decodes (pdf.js)', (page) => page.evaluate(async () => {
  const { ccitt, bitsBlackIs1, pdfOfImages, pdfjsImages } = window.T;
  const width = 3100;
  // Odd rows: a white run of every length, then a black run, under a blank row: every terminating
  // and make-up code, and runs past 2560. Then black runs of every length from the left edge.
  const images = [
    bitsBlackIs1(width, 2 * (width - 4), (x, y) => {
      if (y % 2 === 0) return false;
      const white = Math.floor(y / 2);
      const black = ((white * 37 + 1) % (width - white)) + 1;
      return x >= white && x < white + black;
    }),
    bitsBlackIs1(width, 2 * width, (x, y) => y % 2 === 1 && x < Math.floor(y / 2)),
  ];
  for (const image of images) {
    const g4 = ccitt.encodeCcittG4(image.data, image.width, image.height);
    const pdf = await pdfOfImages([{ width: image.width, height: image.height, filter: 'CCITTFaxDecode', decodeParms: { K: -1, Columns: image.width, Rows: image.height }, data: g4 }]);
    const [decoded] = await pdfjsImages(pdf);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const black = decoded.data[(y * image.width + x) * 4] < 128;
        const want = ((image.data[y * image.rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) === 1;
        if (black !== want) throw new Error(`${image.width} x ${image.height}: pixel ${x}, ${y}`);
      }
    }
  }
}));

test('CCITT G4: print, noise, blank, black, stripes and checks decode at any width (pdf.js)', (page) => page.evaluate(async () => {
  const { ccitt, bitsBlackIs1, pdfOfImages, pdfjsImages, random, canvas, assert } = window.T;
  const c = canvas(1240, 400);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 1240, 400);
  g.fillStyle = '#000';
  g.font = '28px serif';
  for (let line = 0; line < 9; line++) g.fillText(`Usugami turns photos of pages into PDFs, line ${line + 1}: 0123456789.`, 40, 40 + line * 40);
  g.font = 'bold 70px sans-serif';
  g.fillText('BOLD', 900, 380);
  const text = g.getImageData(0, 0, 1240, 400).data;
  const images = [bitsBlackIs1(1240, 400, (x, y) => text[(y * 1240 + x) * 4] < 128)];
  const rnd = random(7);
  for (const [w, h] of [[1, 1], [1, 40], [40, 1], [7, 13], [9, 9], [64, 64], [333, 77]]) {
    images.push(bitsBlackIs1(w, h, () => rnd.nextInt(0, 3) === 0));
    images.push(bitsBlackIs1(w, h, () => false));
    images.push(bitsBlackIs1(w, h, () => true));
    images.push(bitsBlackIs1(w, h, (x) => x % 3 === 0));
    images.push(bitsBlackIs1(w, h, (x, y) => (x + y) % 2 === 0));
    images.push(bitsBlackIs1(w, h, (x, y) => (Math.floor(x / 5) + Math.floor(y / 4)) % 2 === 0));
  }
  const encoded = images.map((im) => ccitt.encodeCcittG4(im.data, im.width, im.height));
  // Far smaller than the raw bits.
  assert(encoded[0].length < images[0].data.length / 5, `print: ${encoded[0].length} bytes for ${images[0].data.length}`);
  const pdf = await pdfOfImages(images.map((im, k) => ({ width: im.width, height: im.height, filter: 'CCITTFaxDecode', decodeParms: { K: -1, Columns: im.width, Rows: im.height }, data: encoded[k] })));
  const decoded = await pdfjsImages(pdf);
  images.forEach((im, k) => {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        const black = decoded[k].data[(y * im.width + x) * 4] < 128;
        const want = ((im.data[y * im.rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) === 1;
        if (black !== want) throw new Error(`image ${k} (${im.width} x ${im.height}): pixel ${x}, ${y}`);
      }
    }
  });
}));

test('CCITT G4: the 1-bit Flate stream inflates to the rows through PNG filters', (page) => page.evaluate(() => {
  const { encode, fflate, random, looks, sameArray, equal } = window.T;
  const rnd = random(3);
  const image = looks.bitImage(77, 31);
  for (let i = 0; i < image.data.length; i++) image.data[i] = rnd.nextInt(0, 256);
  const inflated = fflate.unzlibSync(encode.flateBits(image));
  equal(inflated.length, (image.rowBytes + 1) * image.height, 'size');
  let previous = new Uint8Array(image.rowBytes);
  for (let y = 0; y < image.height; y++) {
    const filter = inflated[y * (image.rowBytes + 1)];
    const row = new Uint8Array(image.rowBytes);
    for (let i = 0; i < image.rowBytes; i++) {
      const x = inflated[y * (image.rowBytes + 1) + 1 + i];
      const a = i > 0 ? row[i - 1] : 0;
      const b = previous[i];
      const c = i > 0 ? previous[i - 1] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      row[i] = x + [0, a, b, (a + b) >> 1, paeth][filter];
    }
    sameArray(row, image.data.subarray(y * image.rowBytes, (y + 1) * image.rowBytes), `row ${y}`);
    previous = row;
  }
}));

// ---------------------------------------------------------------------------------------------
// GrayJpegTest (decoded by the browser's own JPEG decoder)

test('grey JPEG: decodes as the picture, one component, baseline', (page) => page.evaluate(async () => {
  const { encode, jpeg, decodeImage, psnr, assert, equal } = window.T;
  const w = 301;
  const h = 203;
  const smooth = { width: w, height: h, pixels: Uint8Array.from({ length: w * h }, (_, i) => Math.min(255, Math.max(0, Math.trunc(128 + 90 * Math.sin((i % w) / 23) * Math.sin(Math.floor(i / w) / 17))))) };
  for (const q of [55, 75, 85, 95]) {
    const bytes = encode.encodeGrayJpeg(smooth, q);
    const decoded = await decodeImage(bytes);
    equal(decoded.width, w, 'width');
    equal(decoded.height, h, 'height');
    const db = psnr(smooth, decoded);
    assert(db > 36, `quality ${q}: ${db} dB`);
    const info = jpeg.parseJpeg(bytes);
    equal(info.components, 1, 'one component');
    equal(info.frameMarker, 0xc0, 'baseline');
    assert(info.canEmbedDirectly, 'embeddable');
    // The public encoder gives the same for a grey picture.
    const viaApi = await encode.encodeJpeg(smooth, { quality: q, gray: true });
    window.T.sameArray(viaApi, bytes, 'encodeJpeg gray');
  }
}));

test('grey JPEG: quality trades size for fidelity; Huffman tables fit their symbols', (page) => page.evaluate(async () => {
  const { encode, decodeImage, psnr, assert, equal, random } = window.T;
  const rnd = random(5);
  const pageImage = { width: 640, height: 480, pixels: Uint8Array.from({ length: 640 * 480 }, (_, i) => ((Math.floor((i % 640) / 9) + Math.floor(Math.floor(i / 640) / 13)) % 3 === 0 ? 30 : 235 + rnd.nextInt(-6, 7))) };
  const sizes = [30, 55, 75, 85, 100].map((q) => encode.encodeGrayJpeg(pageImage, q).length);
  equal(sizes.join(), [...sizes].sort((a, b) => a - b).join(), 'sizes grow with quality');
  assert(psnr(pageImage, await decodeImage(encode.encodeGrayJpeg(pageImage, 100))) > psnr(pageImage, await decodeImage(encode.encodeGrayJpeg(pageImage, 55))), 'fidelity');
  const noise = { width: 64, height: 64, pixels: Uint8Array.from({ length: 4096 }, () => rnd.nextInt(0, 256)) };
  assert(psnr(noise, await decodeImage(encode.encodeGrayJpeg(noise, 100))) > 40, 'noise at 100');
  // Smaller than the same picture through the browser's own encoder (three components, standard tables).
  const ours = encode.encodeGrayJpeg(pageImage, 75).length;
  const c = window.T.canvas(640, 480);
  const id = new ImageData(640, 480);
  for (let p = 0; p < pageImage.pixels.length; p++) { id.data.fill(pageImage.pixels[p], p * 4, p * 4 + 3); id.data[p * 4 + 3] = 255; }
  c.getContext('2d').putImageData(id, 0, 0);
  const browser = (await window.T.jpegOf(c, 0.75)).length;
  assert(ours < browser, `ours ${ours}, the browser's ${browser}`);

  const counts = Int32Array.from({ length: 257 }, (_, i) => (i < 200 ? 2 ** (i % 24) : 0));
  const table = encode.optimalHuffmanTable(counts);
  equal(table.symbols.length, 200, 'symbols');
  equal(table.counts.reduce((a, b) => a + b, 0), 200, 'counts');
  const codes = table.symbols.map((s) => table.codes[s].toString(2).padStart(table.lengths[s], '0'));
  assert(codes.every((c2) => c2.length >= 1 && c2.length <= 16 && !/^1+$/.test(c2)), 'lengths and no all-ones code');
  for (const a of codes) for (const b of codes) if (a !== b) assert(!b.startsWith(a), `${a} starts ${b}`);
  const one = encode.optimalHuffmanTable(Int32Array.from({ length: 257 }, (_, i) => (i === 0 ? 5 : 0)));
  equal(one.symbols.join(), '0', 'single symbol');
  equal(one.lengths[0], 1, 'one bit');
  const two = encode.optimalHuffmanTable(Int32Array.from({ length: 257 }, (_, i) => (i === 1 ? 100 : i === 2 || i === 3 ? 1 : 0)));
  assert(two.lengths[1] < two.lengths[2], 'frequent symbol shorter');
}));

test('grey JPEG: any size works; quantization scales as libjpeg', (page) => page.evaluate(async () => {
  const { encode, decodeImage, psnr, assert, equal } = window.T;
  for (const [w, h] of [[1, 1], [1, 17], [17, 1], [7, 9], [8, 8], [9, 16], [33, 65]]) {
    const image = { width: w, height: h, pixels: Uint8Array.from({ length: w * h }, (_, i) => ((i % w) * 31 + Math.floor(i / w) * 17) % 256) };
    const decoded = await decodeImage(encode.encodeGrayJpeg(image, 90));
    equal(decoded.width, w, 'width');
    equal(decoded.height, h, 'height');
    assert(psnr(image, decoded) > 25, `${w} x ${h}: ${psnr(image, decoded)}`);
  }
  for (const v of [0, 255, 128]) {
    const flat = { width: 100, height: 50, pixels: new Uint8Array(5000).fill(v) };
    assert(psnr(flat, await decodeImage(encode.encodeGrayJpeg(flat, 75))) > 45, `flat ${v}`);
  }
  equal(encode.quantization(50)[0], 16, 'q50');
  equal(encode.quantization(75)[0], 8, 'q75');
  equal(encode.quantization(100)[0], 1, 'q100');
  equal(encode.quantization(1)[63], 255, 'q1');
}));

// ---------------------------------------------------------------------------------------------
// JpegTest

test('JPEG header: baseline colour, grey, unsupported frames, plain RGB, Adobe marker', (page) => page.evaluate(async () => {
  const { jpeg, encode, jpegOf, patternCanvas, assert, equal, segment, withSegments } = window.T;
  const bytes = await jpegOf(patternCanvas(37, 21));
  const info = jpeg.parseJpeg(bytes);
  equal(`${info.width}x${info.height}`, '37x21', 'size');
  equal(info.components, 3, 'components');
  equal(info.precision, 8, 'precision');
  equal(info.frameMarker, 0xc0, 'baseline');
  assert(info.canEmbedDirectly, 'embeddable');
  assert(!info.isPlainRgb, 'YCbCr');
  assert(jpeg.isJpeg(bytes), 'isJpeg');
  equal(jpeg.parseJpeg(encode.encodeGrayJpeg({ width: 16, height: 16, pixels: new Uint8Array(256) }, 80)).components, 1, 'grey');
  const base = jpeg.parseJpeg(await jpegOf(patternCanvas(8, 8)));
  assert(!jpeg.jpegInfo({ ...base, components: 4 }).canEmbedDirectly, 'CMYK');
  assert(!jpeg.jpegInfo({ ...base, precision: 12 }).canEmbedDirectly, '12-bit');
  assert(!jpeg.jpegInfo({ ...base, frameMarker: 0xc9 }).canEmbedDirectly, 'arithmetic coding');
  assert(!jpeg.jpegInfo({ ...base, frameMarker: 0xc3 }).canEmbedDirectly, 'lossless');
  assert(!jpeg.jpegInfo({ ...base, height: 0 }).canEmbedDirectly, 'height by DNL');
  assert(jpeg.jpegInfo({ ...base, frameMarker: 0xc2 }).canEmbedDirectly, 'progressive');
  assert(base.hasJfifMarker, 'the browser writes JFIF');
  assert(!jpeg.jpegInfo({ ...base, componentIds: [82, 71, 66] }).isPlainRgb, 'JFIF is YCbCr whatever its labels');
  assert(jpeg.jpegInfo({ ...base, componentIds: [82, 71, 66], hasJfifMarker: false }).isPlainRgb, 'R G B');
  assert(!jpeg.jpegInfo({ ...base, componentIds: [82, 71, 66], hasJfifMarker: false, hasAdobeMarker: true }).isPlainRgb, 'Adobe');
  const adobe = segment(0xee, 'Adobe\u0000d\u0000\u0000\u0000\u0000\u0001');
  assert(jpeg.parseJpeg(withSegments(await jpegOf(patternCanvas(8, 8)), adobe)).hasAdobeMarker, 'Adobe marker found');
}));

test('JPEG strip: metadata and trailing data go, the pixels and colour profile stay', (page) => page.evaluate(async () => {
  const { jpeg, jpegOf, patternCanvas, decodeImage, assert, equal, segment, withSegments, indexOf, concat, sameArray } = window.T;
  const strip = (b) => {
    const s = jpeg.stripJpeg(b);
    equal(jpeg.jpegStrippedSize(b), s.length, 'strippedSize');
    return s;
  };
  const clean = await jpegOf(patternCanvas(120, 80));
  sameArray(strip(clean), clean, 'a plain file is left as it is');
  const icc = 'ICC_PROFILE\u0000\u0001\u0001fake-profile';
  const dirty = concat(withSegments(
    clean,
    segment(0xe1, 'Exif\u0000\u0000GPS-SECRET-LOCATION'),
    segment(0xe1, 'http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta>SECRET</x:xmpmeta>'),
    segment(0xe2, 'MPF\u0000index'),
    segment(0xe2, icc),
    segment(0xfe, 'comment SECRET'),
    segment(0xed, 'Photoshop 3.0\u0000SECRET'),
  ), new TextEncoder().encode('....ftypmp42 motion photo video SECRET'), Uint8Array.of(0xff, 0xd8, 0xff, 0xd9));
  const stripped = strip(dirty);
  equal(indexOf(stripped, 'SECRET'), -1, 'no secrets');
  equal(indexOf(stripped, 'MPF'), -1, 'no MPF');
  assert(indexOf(stripped, 'ICC_PROFILE') > 0, 'ICC profile kept');
  equal(stripped[stripped.length - 2], 0xff, 'EOI');
  equal(stripped[stripped.length - 1], 0xd9, 'EOI');
  equal(stripped.length, clean.length + 2 + icc.length + 2, 'size');
  // The pixels are the same as the file's (decoded with the same colour profile, which WebKit applies).
  sameArray((await decodeImage(stripped)).data, (await decodeImage(dirty)).data, 'pixels');

  // Only the segments decoders need: the ICC profile (in two parts) and the Adobe marker.
  const icc1 = segment(0xe2, 'ICC_PROFILE\u0000\u0001\u0002first-half');
  const icc2 = segment(0xe2, 'ICC_PROFILE\u0000\u0002\u0002second-half');
  const adobe = segment(0xee, 'Adobe\u0000d\u0000\u0000\u0000\u0000\u0001');
  const many = withSegments(clean,
    segment(0xeb, 'JP\u0000\u0001\u0000\u0000\u0000\u0001jumbc2pa SECRET'), icc1, segment(0xe3, 'META camera serial SECRET'), icc2,
    segment(0xe0, 'JFXX\u0000\u0010SECRET thumbnail'), segment(0xe2, 'FPXR\u0000SECRET'), adobe, segment(0xec, 'Ducky\u0000SECRET'), segment(0xef, 'SECRET'));
  sameArray(strip(many), withSegments(clean, icc1, icc2, adobe), 'kept segments');
  assert(jpeg.parseJpeg(strip(many)).hasAdobeMarker, 'Adobe');

  // A JFIF thumbnail goes.
  equal(clean[3], 0xe0, 'JFIF first');
  equal(clean[5], 16, 'JFIF without a thumbnail');
  const header = clean.slice(6, 20);
  header[12] = 2;
  header[13] = 1;
  const withThumbnail = concat(clean.subarray(0, 2), segment(0xe0, concat(header, new TextEncoder().encode('SECRET'))), clean.subarray(20));
  assert(jpeg.parseJpeg(withThumbnail).canEmbedDirectly, 'still a JPEG');
  sameArray(strip(withThumbnail), clean, 'thumbnail removed');

  // Metadata after the scan's data goes; a file cut off inside it keeps the scan, closed.
  const eoi = clean.length - 2;
  const metadata = concat(segment(0xe1, 'Exif\u0000\u0000SECRET'), segment(0xfe, 'SECRET'));
  const after = concat(clean.subarray(0, eoi), metadata, clean.subarray(eoi));
  sameArray(strip(after), clean, 'between scans');
  const cut = after.slice(0, eoi + 14);
  sameArray(strip(cut), concat(clean.subarray(0, eoi), Uint8Array.of(0xff, 0xd9)), 'cut inside a segment');

  // A truncated file gets closed.
  const big = await jpegOf(patternCanvas(64, 64));
  const truncated = big.slice(0, big.length - 40);
  const closed = strip(truncated);
  equal(closed.length, truncated.length + 2, 'closed');
  equal(closed[closed.length - 1], 0xd9, 'EOI');

  for (const bad of [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0), big.slice(0, 20)]) {
    let threw = false;
    try { jpeg.parseJpeg(bad); } catch (e) { threw = e instanceof jpeg.InvalidJpegError; }
    assert(threw, 'rejected');
  }
}));

test('JPEG facts: EXIF orientation, sRGB or not, stored size', (page) => page.evaluate(async () => {
  const { jpeg, jpegOf, pngOf, patternCanvas, equal, assert, concat, segment, withSegments } = window.T;
  const clean = await jpegOf(patternCanvas(40, 30));
  equal(jpeg.exifOrientation(clean), 1, 'none');
  for (let o = 1; o <= 8; o++) equal(jpeg.exifOrientation(jpeg.withExifOrientation(clean, o)), o, `orientation ${o}`);
  // Little-endian EXIF too.
  const le = segment(0xe1, 'Exif\u0000\u0000II*\u0000\u0008\u0000\u0000\u0000\u0001\u0000\u0012\u0001\u0003\u0000\u0001\u0000\u0000\u0000\u0008\u0000\u0000\u0000\u0000\u0000\u0000\u0000');
  equal(jpeg.exifOrientation(withSegments(clean, le)), 8, 'little-endian');
  equal(jpeg.exifOrientation(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0, 4, 1, 2)), 1, 'damaged');
  equal(JSON.stringify(jpeg.storedSize(clean)), '{"width":40,"height":30}', 'JPEG size');
  equal(JSON.stringify(jpeg.storedSize(await pngOf(patternCanvas(17, 9)))), '{"width":17,"height":9}', 'PNG size');
  // A profile that names itself: sRGB is kept as it is, Display P3 isn't.
  const profile = (name) => {
    const desc = new Uint8Array(12 + name.length + 1);
    desc.set([0x64, 0x65, 0x73, 0x63], 0);
    desc[11] = name.length + 1;
    for (let i = 0; i < name.length; i++) desc[12 + i] = name.charCodeAt(i);
    const p = new Uint8Array(132 + 12 + desc.length);
    p[131] = 1;
    p.set([0x64, 0x65, 0x73, 0x63, 0, 0, 0, 144, 0, 0, 0, desc.length], 132);
    p.set(desc, 144);
    return p;
  };
  const tagged = (name) => withSegments(clean, segment(0xe2, concat(new TextEncoder().encode('ICC_PROFILE\u0000\u0001\u0001'), profile(name))));
  assert(jpeg.jpegIsSrgb(clean), 'no profile');
  assert(jpeg.jpegIsSrgb(tagged('sRGB IEC61966-2.1')), 'sRGB');
  assert(!jpeg.jpegIsSrgb(tagged('Display P3')), 'Display P3');
}));

// ---------------------------------------------------------------------------------------------
// RasterEncoderTest

test('lossless Flate: colour and grey round trips, transparency on white', (page) => page.evaluate(() => {
  const { encode, fflate, random, sameArray, assert } = window.T;
  const unfilter = (compressed, width, height, bpp) => {
    const rowBytes = width * bpp;
    const raw = fflate.unzlibSync(compressed);
    assert(raw.length === (rowBytes + 1) * height, 'inflated size');
    const out = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (rowBytes + 1)];
      for (let i = 0; i < rowBytes; i++) {
        const x = raw[y * (rowBytes + 1) + 1 + i];
        const a = i >= bpp ? out[y * rowBytes + i - bpp] : 0;
        const b = y > 0 ? out[(y - 1) * rowBytes + i] : 0;
        const c = y > 0 && i >= bpp ? out[(y - 1) * rowBytes + i - bpp] : 0;
        const p = a + b - c;
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        out[y * rowBytes + i] = x + [0, a, b, (a + b) >> 1, paeth][filter];
      }
    }
    return out;
  };
  const rnd = random(42);
  const w = 53;
  const h = 31;
  const img = new ImageData(w, h);
  const expected = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    const x = p % w;
    const y = Math.floor(p / w);
    const rgb = y < 10 ? [rnd.nextInt(0, 256), rnd.nextInt(0, 256), rnd.nextInt(0, 256)] : y < 20 ? [(x * 4) & 255, (y * 8) & 255, x + y] : [0x33, 0x66, 0x99];
    img.data.set([...rgb, 255], p * 4);
    expected.set(rgb, p * 3);
  }
  assert(!encode.isGray(img), 'colour');
  sameArray(unfilter(encode.flateRaster(img, false), w, h, 3), expected, 'colour round trip');
  const alpha = new ImageData(Uint8ClampedArray.from([0, 0, 0, 0, 255, 0, 0, 0x80, 0, 0, 255, 255, 0x12, 0x34, 0x56, 0x40]), 4, 1);
  const mix = (c, a) => Math.trunc((c * a + 255 * (255 - a) + 127) / 255);
  sameArray(unfilter(encode.flateRaster(alpha, false), 4, 1, 3), [255, 255, 255, 255, mix(0, 0x80), mix(0, 0x80), 0, 0, 255, mix(0x12, 0x40), mix(0x34, 0x40), mix(0x56, 0x40)], 'flattened onto white');
  const grey = new ImageData(20, 10);
  for (let p = 0; p < 200; p++) grey.data.set([(p * 7) & 255, (p * 7) & 255, (p * 7) & 255, 255], p * 4);
  assert(encode.isGray(grey), 'grey');
  sameArray(unfilter(encode.flateRaster(grey, true), 20, 10, 1), Uint8Array.from({ length: 200 }, (_, p) => (p * 7) & 255), 'grey round trip');
  assert(encode.isGray(new ImageData(Uint8ClampedArray.from([255, 0, 0, 0, 128, 128, 128, 255]), 2, 1)), 'see-through colour is white');
  assert(!encode.isGray(new ImageData(Uint8ClampedArray.from([128, 128, 129, 255, 128, 128, 128, 255]), 2, 1)), 'a trace of colour');
}));

// ---------------------------------------------------------------------------------------------
// DocumentLooksTest

test('looks: black and white keeps the print and whitens the paper in a shadow', (page) => page.evaluate(() => {
  const { printedPage, photo, bits, score, looks, assert, equal } = window.T;
  const p = printedPage();
  window.T.page1240 = p;
  window.T.photo1240 = photo(p);
  const b = bits(window.T.photo1240);
  equal(b.width, p.width, 'width');
  equal(b.height, p.height, 'height');
  const [paper, ink] = score(p, (x, y) => looks.isBlack(b, x, y));
  assert(paper > 0.998, `paper white ${paper}`);
  assert(ink > 0.97, `ink black ${ink}`);
}));

test('looks: black and white fills bold print and keeps faint lines', (page) => page.evaluate(() => {
  const { photo, bits, looks, assert } = window.T;
  const p = window.T.page1240;
  const b = bits(photo(p, { shadow: false }));
  let missed = 0;
  let box = 0;
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      if (p.luma(x, y) < 40 && p.isInk(Math.max(0, x - 3), y) && p.isInk(Math.min(p.width - 1, x + 3), y)) {
        box++;
        if (!looks.isBlack(b, x, y)) missed++;
      }
    }
  }
  assert(missed < box / 500, `inside bold print and the box: ${missed} of ${box} white`);
  const unit = p.width / 1240;
  let found = 0;
  const xs = [];
  for (let v = 450; v <= 1070; v += 10) xs.push(Math.trunc(v * unit));
  for (const x of xs) {
    let any = false;
    for (let y = 0; y < p.height && !any; y++) if (p.luma(x, y) >= 150 && p.luma(x, y) <= 200 && looks.isBlack(b, x, y)) any = true;
    if (any) found++;
  }
  assert(found > xs.length * 0.9, `pencil line found at ${found} of ${xs.length}`);
}));

test('looks: grayscale and enhanced make the paper white and the ink dark, the stamp stays red', (page) => page.evaluate(() => {
  const { gray, made, assert } = window.T;
  const p = window.T.page1240;
  const ph = window.T.photo1240;
  const g = gray(ph);
  const enhanced = made(ph, 'enhanced');
  let paper = 0;
  let whiteGray = 0;
  let whiteColour = 0;
  const regions = Array.from({ length: 100 }, () => [0, 0, 0, 0]);
  let ink = 0;
  let darkGray = 0;
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      const [r, gg, b] = [enhanced.data[i], enhanced.data[i + 1], enhanced.data[i + 2]];
      if (p.isInk(x, y) && p.luma(x, y) < 60) {
        ink++;
        if (g.pixels[y * p.width + x] < 90) darkGray++;
      } else if (p.isPaper(x, y)) {
        paper++;
        if (g.pixels[y * p.width + x] >= 245) whiteGray++;
        if (Math.min(r, gg, b) >= 240) whiteColour++;
        const region = regions[Math.floor((y * 10) / p.height) * 10 + Math.floor((x * 10) / p.width)];
        region[0] += r; region[1] += gg; region[2] += b; region[3]++;
      }
    }
  }
  assert(whiteGray > paper * 0.99, `grey paper white ${whiteGray / paper}`);
  assert(whiteColour > paper * 0.99, `colour paper white ${whiteColour / paper}`);
  for (const region of regions.filter((rr) => rr[3] > 100)) {
    const c = region.slice(0, 3).map((v) => v / region[3]);
    assert(Math.max(...c) - Math.min(...c) < 4, `paper colour ${c}`);
  }
  assert(darkGray > ink * 0.97, `ink dark ${darkGray / ink}`);
  let stamp = 0;
  let red = 0;
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      if (p.isStamp(x, y)) {
        stamp++;
        const i = (y * p.width + x) * 4;
        if (enhanced.data[i] > 150 && enhanced.data[i + 1] < 70 && enhanced.data[i + 2] < 80) red++;
      }
    }
  }
  assert(red > stamp * 0.9, `stamp red: ${red} of ${stamp}`);
}));

test('looks: lighten brightens the photo but keeps its look', (page) => page.evaluate(() => {
  const { made, meanLuma, stampColour, hueDistance, assert } = window.T;
  const p = window.T.page1240;
  const ph = window.T.photo1240;
  const lighten = made(ph, 'lighten');
  assert(meanLuma(lighten) > meanLuma(ph) + 30, `brighter: ${meanLuma(lighten)}, the photo ${meanLuma(ph)}`);
  const paper = (x, y) => p.isPaper(x, y);
  const enhancedPaper = meanLuma(made(ph, 'enhanced'), paper);
  assert(meanLuma(lighten, paper) < enhancedPaper - 8, `paper ${meanLuma(lighten, paper)}, Enhanced's ${enhancedPaper}`);
  const top = Math.trunc(p.height * 0.35);
  const bottom = Math.trunc(p.height * 0.65);
  const shade = (img) => meanLuma(img, (x, y) => paper(x, y) && x < p.width * 0.3 && y >= top && y <= bottom) /
    meanLuma(img, (x, y) => paper(x, y) && x > p.width * 0.4 && x < p.width * 0.6 && y >= top && y <= bottom);
  assert(shade(lighten) > shade(ph) + 0.1 && shade(lighten) < 0.95, `shadow ${shade(lighten)}, in the photo ${shade(ph)}`);
  const ink = (x, y) => p.luma(x, y) < 60;
  assert(meanLuma(lighten, ink) >= meanLuma(ph, ink), `ink ${meanLuma(lighten, ink)}, in the photo ${meanLuma(ph, ink)}`);
  const [hue, saturation] = stampColour(p, lighten);
  assert(hueDistance(hue, stampColour(p, p.image)[0]) < 10 && saturation > 0.6, `stamp hue ${hue}, saturation ${saturation}`);
}));

test('looks: super enhanced goes further than enhanced, sharpens, leaves stains pale', (page) => page.evaluate(() => {
  const { made, meanLuma, stampColour, hueDistance, assert, equal, lumaAt } = window.T;
  const p = window.T.page1240;
  const ph = window.T.photo1240;
  const enhanced = made(ph, 'enhanced');
  const superEnhanced = made(ph, 'super_enhanced');
  const whitePaper = (img) => {
    let n = 0;
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      if (p.isPaper(x, y) && Math.min(img.data[i], img.data[i + 1], img.data[i + 2]) >= 250) n++;
    }
    return n;
  };
  assert(whitePaper(superEnhanced) >= whitePaper(enhanced), `white paper ${whitePaper(superEnhanced)}, Enhanced's ${whitePaper(enhanced)}`);
  const ink = (x, y) => p.luma(x, y) < 60;
  assert(meanLuma(superEnhanced, ink) <= meanLuma(enhanced, ink), 'ink darker');
  const [hue, saturation] = stampColour(p, superEnhanced);
  const [enhancedHue, enhancedSaturation] = stampColour(p, enhanced);
  assert(saturation > enhancedSaturation + 0.02, `stamp saturation ${saturation}, Enhanced's ${enhancedSaturation}`);
  assert(hueDistance(hue, enhancedHue) < 10, `stamp hue ${hue}, Enhanced's ${enhancedHue}`);
  // Sharpened: a grey square's edge darker than its middle, the step onto it steeper.
  const square = new ImageData(400, 400);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
    const v = x >= 188 && x < 212 && y >= 188 && y < 212 ? 0x6e : 0xeb;
    square.data.set([v, v, v, 255], (y * 400 + x) * 4);
  }
  const plain = made(square, 'enhanced');
  const sharp = made(square, 'super_enhanced');
  const at = (img, x) => lumaAt(img, x, 200);
  equal(at(plain, 200), at(plain, 188), 'Enhanced is flat');
  assert(at(sharp, 188) < at(sharp, 200) - 5, `edge ${at(sharp, 188)}, middle ${at(sharp, 200)}`);
  assert(at(sharp, 187) - at(sharp, 188) > at(plain, 187) - at(plain, 188), 'steeper step');
  for (const stain of [[205, 178, 135], [215, 192, 155]]) {
    const stained = new ImageData(400, 400);
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
      const c = x >= 170 && x < 230 && y >= 170 && y < 230 ? stain : [232, 228, 218];
      stained.data.set([...c, 255], (y * 400 + x) * 4);
    }
    const chroma = (img) => {
      const i = (200 * 400 + 200) * 4;
      return Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) - Math.min(img.data[i], img.data[i + 1], img.data[i + 2]);
    };
    assert(chroma(made(stained, 'super_enhanced')) <= chroma(made(stained, 'enhanced')), `${stain}: Super's colour no more than Enhanced's`);
  }
}));

test('looks: ink saver leaves large dark areas hollow, keeps outlines, no rings round specks', (page) => page.evaluate(() => {
  const { bits, looks, assert, equal, blackCount, canvas, pixelsOf } = window.T;
  const p = window.T.page1240;
  const ph = window.T.photo1240;
  const plain = bits(ph);
  const saver = bits(ph, 'ink_saver');
  const { box } = p;
  let differ = 0;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const around = x >= box.x - 2 && x < box.x + box.w + 2 && y >= box.y - 2 && y < box.y + box.h + 2;
    if (!around && looks.isBlack(plain, x, y) !== looks.isBlack(saver, x, y)) differ++;
  }
  equal(differ, 0, 'pixels that differ outside the box');
  let outline = 0;
  let inside = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const depth = Math.min(x - box.x, box.x + box.w - 1 - x, y - box.y, box.y + box.h - 1 - y);
    if (depth >= 1 && depth <= 2 && !looks.isBlack(saver, x, y)) outline++;
    if (depth >= 8 && looks.isBlack(saver, x, y)) inside++;
  }
  equal(outline, 0, 'white in the outline');
  equal(inside, 0, 'black inside');
  assert(blackCount(saver) < blackCount(plain) - (box.w - 16) * (box.h - 16), 'less black');

  // A marker stroke 30 pixels wide at 45 degrees keeps its outline along the slant.
  const c = canvas(1200, 1200);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = 'rgb(240,236,220)';
  g.fillRect(0, 0, 1200, 1200);
  g.strokeStyle = 'rgb(25,25,30)';
  g.lineWidth = 30;
  g.lineCap = 'square';
  g.beginPath();
  g.moveTo(200, 200);
  g.lineTo(1000, 1000);
  g.stroke();
  const slanted = bits(pixelsOf(c), 'ink_saver');
  let hollow = 0;
  let count = 0;
  for (let t = 300; t <= 900; t += 20) {
    count++;
    const black = (from, to) => {
      let a = false;
      let b = false;
      for (let d = from; d <= to; d++) {
        if (looks.isBlack(slanted, t + d, t - d)) a = true;
        if (looks.isBlack(slanted, t - d, t + d)) b = true;
      }
      return a && b;
    };
    assert(black(5, 11), `outline at ${t}`);
    if (!looks.isBlack(slanted, t, t)) hollow++;
  }
  equal(hollow, count, 'hollow along the stroke');

  // White specks a few pixels inside a black box are made white with it.
  g.fillStyle = 'rgb(240,238,230)';
  g.fillRect(0, 0, 1200, 1200);
  g.fillStyle = 'rgb(20,20,24)';
  g.fillRect(300, 300, 400, 300);
  g.fillStyle = 'rgb(240,238,230)';
  for (let k = 0; k < 10; k++) {
    g.fillRect(340 + k * 35, 306, 2, 2);
    g.fillRect(340 + k * 35, 592, 2, 2);
    g.fillRect(306, 330 + k * 25, 2, 2);
  }
  const specks = bits(pixelsOf(c), 'ink_saver');
  let black = 0;
  for (let y = 304; y < 596; y++) for (let x = 304; x < 696; x++) if (looks.isBlack(specks, x, y)) black++;
  equal(black, 0, 'black inside the outline');
  for (let x = 300; x < 700; x++) assert(looks.isBlack(specks, x, 300) && looks.isBlack(specks, x, 599), `outline at ${x}`);
}));

test('looks: tone curves never turn back and keep white; brightness and contrast change every look', (page) => page.evaluate(() => {
  const { looks, printedPage, photo, made, bits, meanLuma, spread, blackCount, assert, equal, sameArray } = window.T;
  sameArray(looks.tones({ brightness: 0, contrast: 0 }), Int32Array.from({ length: 256 }, (_, i) => i), 'none');
  for (let b = -100; b <= 100; b += 20) for (let c = -100; c <= 100; c += 20) {
    const t = looks.tones({ brightness: b, contrast: c });
    for (let i = 1; i < 256; i++) assert(t[i] >= t[i - 1], `${b}, ${c} turns back at ${i}`);
    equal(t[255], 255, `${b}, ${c} white`);
    if (c >= 0) equal(t[0], 0, `${b}, ${c} black`);
  }
  let threw = false;
  try { looks.tones({ brightness: 101 }); } catch (e) { threw = e instanceof RangeError; }
  assert(threw, 'out of range');

  const p = printedPage(620);
  const ph = photo(p);
  for (const look of looks.LOOKS) {
    sameArray(made(ph, look, { brightness: 0, contrast: 0 }).data, made(ph, look).data, `${look} with neither`);
  }
  const print = (x, y) => p.luma(x, y) < 200;
  for (const look of looks.LOOKS.filter((l) => !looks.isBilevel(l))) {
    const darker = meanLuma(made(ph, look, { brightness: -60 }), print);
    const plain = meanLuma(made(ph, look), print);
    const lighter = meanLuma(made(ph, look, { brightness: 60 }), print);
    assert(darker < plain - 5 && plain + 5 < lighter, `${look}: ${darker}, ${plain}, ${lighter}`);
    const flatter = spread(made(ph, look, { contrast: -60 }));
    const s = spread(made(ph, look));
    const punchier = spread(made(ph, look, { contrast: 60 }));
    assert(flatter < s - 2 && s < punchier, `${look}: ${flatter}, ${s}, ${punchier}`);
  }
  for (const look of looks.LOOKS.filter((l) => looks.isBilevel(l))) {
    const counts = [-60, 0, 60].map((b) => blackCount(bits(ph, look, { brightness: b })));
    assert(counts[0] > counts[1] && counts[1] > counts[2], `${look}: ${counts}`);
    const less = blackCount(bits(ph, look, { contrast: -60 }));
    const more = blackCount(bits(ph, look, { contrast: 60 }));
    assert(less < counts[1] && counts[1] < more, `${look}: ${less}, ${counts[1]}, ${more}`);
  }
}));

test('looks: original is the photo on white; colour looks can be written back into the photo', (page) => page.evaluate(() => {
  const { looks, made, printedPage, photo, equal, sameArray } = window.T;
  const img = new ImageData(37, 23);
  for (let y = 0; y < 23; y++) for (let x = 0; x < 37; x++) {
    img.data.set([Math.trunc((x * 255) / 36), Math.trunc((y * 255) / 22), (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 40 : 220, x * 7], (y * 37 + x) * 4);
  }
  const out = made(img, 'original');
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3];
    for (let k = 0; k < 3; k++) equal(out.data[i + k], Math.trunc((img.data[i + k] * a + 255 * (255 - a) + 127) / 255), `pixel ${i / 4}`);
    equal(out.data[i + 3], 255, 'opaque');
  }
  const ph = photo(printedPage(620));
  for (const look of looks.LOOKS.filter(looks.isColour)) for (const adj of [{}, { brightness: 30, contrast: 40 }]) {
    const beside = made(ph, look, adj);
    const copy = new ImageData(new Uint8ClampedArray(ph.data), ph.width, ph.height);
    const gen = looks.colourGen(copy, look, adj, copy.data);
    while (!gen.next().done);
    sameArray(copy.data, beside.data, `${look} ${JSON.stringify(adj)} in place`);
  }
}));

test('looks: an evenly lit page, a blank page, tiny pictures and transparency', (page) => page.evaluate(() => {
  const { looks, printedPage, photo, bits, gray, made, score, assert, equal, lumaAt } = window.T;
  const p = printedPage(620);
  const ph = photo(p, { shadow: false, lamp: false });
  const b = bits(ph);
  const [paper, ink] = score(p, (x, y) => looks.isBlack(b, x, y));
  assert(paper > 0.998 && ink > 0.95, `paper ${paper}, ink ${ink}`);
  const g = gray(ph);
  for (let y = 0; y < p.height; y += 7) for (let x = 0; x < p.width; x += 7) {
    if (p.isPaper(x, y)) assert(g.pixels[y * p.width + x] >= 235, `paper at ${x}, ${y}: ${g.pixels[y * p.width + x]}`);
  }
  const blank = new ImageData(300, 200);
  for (let i = 0; i < blank.data.length; i += 4) blank.data.set([180, 170, 150, 255], i);
  for (const look of looks.LOOKS) {
    const m2 = made(blank, look);
    const first = m2.data.slice(0, 4).join();
    for (let i = 0; i < m2.data.length; i += 4) if (m2.data.slice(i, i + 4).join() !== first) throw new Error(`${look} not flat`);
    if (look !== 'original' && look !== 'lighten') equal(first, '255,255,255,255', `${look} white`);
  }
  equal(bits(new ImageData(1, 1)).data.length, 1, 'one pixel');
  for (const [w, h] of [[1, 9], [9, 1], [13, 7], [17, 33]]) {
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (x + y) % 5 === 0 ? 0x10 : 0xf0;
      img.data.set([v, v, v, 255], (y * w + x) * 4);
    }
    const bb = bits(img);
    equal(bb.data.length, ((w + 7) >> 3) * h, 'size');
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) equal(looks.isBlack(bb, x, y), (x + y) % 5 === 0, `${w} x ${h} at ${x}, ${y}`);
    if (w % 8 !== 0) for (let y = 0; y < h; y++) equal(~bb.data[y * bb.rowBytes + bb.rowBytes - 1] & ((1 << (8 - (w % 8))) - 1), 0, 'white padding');
    window.T.sameArray(bits(img, 'ink_saver').data, bb.data, 'ink saver the same');
    equal(gray(img, { brightness: 20, contrast: 20 }).pixels.length, w * h, 'grey size');
    for (const look of looks.LOOKS.filter(looks.isColour)) {
      let rows = 0;
      const out = new Uint8ClampedArray(w * h * 4);
      const gen = looks.colourGen(img, look, { brightness: 20, contrast: 20 }, out);
      while (!gen.next().done);
      rows = out.length / 4 / w;
      equal(rows, h, look);
    }
  }
  // A PNG with a transparent background and black print: the background is paper.
  const t = new ImageData(200, 100);
  for (let y = 40; y < 60; y++) for (let x = 40; x < 160; x++) t.data.set([0, 0, 0, 255], (y * 200 + x) * 4);
  const tb = bits(t);
  assert(looks.isBlack(tb, 100, 50) && !looks.isBlack(tb, 10, 10), 'black and white');
  equal(gray(t).pixels[10 * 200 + 10], 255, 'grey');
  const saver = bits(t, 'ink_saver');
  assert(looks.isBlack(saver, 100, 40) && !looks.isBlack(saver, 10, 10), 'ink saver');
  for (const look of looks.LOOKS.filter(looks.isColour)) {
    const m2 = made(t, look);
    assert(lumaAt(m2, 10, 10) === 255 && m2.data[(10 * 200 + 10) * 4] === 255 && lumaAt(m2, 100, 50) < 40, look);
  }
}));

test('looks: the paper is found under print and boxes', (page) => page.evaluate(() => {
  const { looks, near, assert } = window.T;
  const size = 800;
  const block = looks.blockSize(size, size);
  const estimator = new looks.PaperEstimator(size, size);
  const row = new Int32Array(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) row[x] = x >= 5 * block && x < 7 * block && y >= 5 * block && y < 7 * block ? 0x1e : 0xc8;
    estimator.addRow(row);
  }
  const paper = estimator.finish();
  near(paper.blockLevel(5, 5), 200, 0.5, 'block 5, 5');
  near(paper.blockLevel(6, 6), 200, 0.5, 'block 6, 6');
  const levels = new Float32Array(size);
  paper.row(6 * block, levels, new Float32Array(size));
  assert(levels.every((v) => Math.abs(v - 200) < 1), 'row');
}));

test('looks: a twelve-megapixel photo is quick', (page) => page.evaluate(() => {
  const { looks, canvas, pixelsOf, assert } = window.T;
  const c = canvas(4000, 3000);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = 'rgb(210,200,180)';
  g.fillRect(0, 0, 4000, 3000);
  g.fillStyle = 'rgb(64,64,64)';
  g.font = '60px serif';
  for (let line = 0; line < 40; line++) g.fillText(`A line of print on a large photo, number ${line}`, 100, 100 + line * 70);
  g.fillRect(2600, 400, 1000, 800);
  const source = pixelsOf(c);
  const run = (gen) => { for (;;) { const s = gen.next(); if (s.done) return s.value; } };
  run(looks.blackAndWhiteGen(source)); // warm-up
  const times = {};
  for (const look of looks.LOOKS) {
    const start = performance.now();
    if (looks.isColour(look)) run(looks.colourGen(source, look, { brightness: 10, contrast: 10 }, new Uint8ClampedArray(source.data.length)));
    else if (look === 'grayscale') run(looks.grayscaleGen(source, { brightness: 10, contrast: 10 }));
    else run(looks.blackAndWhiteGen(source, look, { brightness: 10, contrast: 10 }));
    times[look] = Math.round(performance.now() - start);
  }
  console.log('12 MP looks, ms: ' + JSON.stringify(times));
  assert(Object.values(times).every((t) => t < 5000), JSON.stringify(times));
  return times;
}));

test('looks: applyLook takes pictures of every kind and leaves them as they are', (page) => page.evaluate(async () => {
  const { looks, canvas, pixelsOf, assert, equal, sameArray } = window.T;
  const c = canvas(120, 90);
  const g = c.getContext('2d');
  g.fillStyle = '#ddd';
  g.fillRect(0, 0, 120, 90);
  g.fillStyle = '#222';
  g.fillRect(10, 10, 50, 20);
  const before = pixelsOf(c).data.slice();
  const asCanvas = looks.applyLook(c, 'black_white');
  assert(asCanvas instanceof HTMLCanvasElement, 'a canvas for a canvas');
  equal(`${asCanvas.width}x${asCanvas.height}`, '120x90', 'size');
  sameArray(pixelsOf(c).data, before, 'the source is left as it is');
  const bitmap = await createImageBitmap(c);
  const fromBitmap = looks.applyLook(bitmap, 'grayscale', { brightness: 10 });
  assert(fromBitmap instanceof HTMLCanvasElement, 'a canvas for a bitmap');
  const data = pixelsOf(c);
  const fromData = looks.applyLook(data, 'enhanced');
  assert(fromData instanceof ImageData, 'ImageData for ImageData');
  sameArray(data.data, before, 'ImageData left as it is');
  const off = looks.applyLook(c, 'ink_saver', {}, { output: 'imagedata' });
  assert(off instanceof ImageData, 'output imagedata');
  const asyncResult = await looks.applyLookAsync(c, 'super_enhanced', { contrast: 20 });
  sameArray(pixelsOf(asyncResult).data, pixelsOf(looks.applyLook(c, 'super_enhanced', { contrast: 20 })).data, 'async the same');
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  const big = new ImageData(2000, 2000);
  try { await looks.applyLookAsync(big, 'enhanced', {}, { signal: controller.signal }); } catch (e) { cancelled = e.name === 'CancelledError'; }
  assert(cancelled, 'cancelled');
  let threw = false;
  try { looks.applyLook(c, 'sepia'); } catch (e) { threw = e instanceof RangeError; }
  assert(threw, 'unknown look');
  equal(looks.LOOKS.join(), 'original,lighten,enhanced,super_enhanced,grayscale,black_white,ink_saver', 'the order the filter screen shows');
}));

// ---------------------------------------------------------------------------------------------
// ImagePdfBuilderTest, ImageExportDeviceTest, LooksDeviceTest: PDFs made and read back

test('PDF: pages, placement, details and image dictionaries', (page) => page.evaluate(async () => {
  const { build, jpeg, jpegOf, pngOf, patternCanvas, canvas, pdfFacts, cmOf, assert, equal, near } = window.T;
  // A 40 x 30 JPEG stored turned (EXIF 6), and a flat 200 x 100 picture as PNG, turned a quarter by the user.
  const photoJpeg = jpeg.withExifOrientation(await jpegOf(patternCanvas(40, 30), 0.9), 6);
  const flat = canvas(200, 100);
  const g = flat.getContext('2d');
  g.fillStyle = '#3366cc';
  g.fillRect(0, 0, 200, 100);
  g.fillStyle = '#ffffff';
  g.fillRect(20, 20, 80, 30);
  const png = await pngOf(flat);
  const created = new Date(Date.UTC(2026, 9, 14, 12, 0, 0));
  const [file] = await build.buildImagesPdf([
    { name: 'IMG_1.jpg', bytes: photoJpeg },
    { name: 'shot.png', bytes: png, rotation: 90 },
  ], { name: 'Test', created });
  equal(file.name, 'Test.pdf', 'name');
  equal(file.type, 'application/pdf', 'type');
  equal(file.pageCount, 2, 'pages');
  equal(file.originalSize, photoJpeg.length + png.length, 'original size');
  const facts = await pdfFacts(file.bytes);
  equal(facts.pages.length, 2, 'pages');
  for (const p of facts.pages) equal(p.box.join(' '), '0 0 595.2756 841.8898', 'A4 portrait');
  equal(facts.title, 'Test', 'title');
  equal(facts.producer, 'Usugami', 'producer');
  equal(facts.creator, 'Usugami', 'creator');
  equal(facts.infoKeys.sort().join(), '/CreationDate,/Creator,/ModDate,/Producer,/Title', 'only what the app sets');
  assert(/^D:20261014120000/.test(facts.created), `creation date ${facts.created}`);
  const [one, two] = facts.pages;
  equal(one.filter, '/DCTDecode', 'JPEG');
  equal(one.colorSpace, '/DeviceRGB', 'colour');
  // Stored 40 x 30 and turned: shown 30 x 40, as wide as the page, whichever way the copy is stored.
  const m1 = cmOf(one.content);
  near(Math.abs(m1[0]) + Math.abs(m1[2]), 595.2756, 0.01, 'turned: as wide as the page');
  near(Math.abs(m1[1]) + Math.abs(m1[3]), (595.2756 * 40) / 30, 0.01, 'turned: 4 high for 3 across');
  // The flat picture: its PNG is smaller than a JPEG of it, so it is kept losslessly.
  equal(two.filter, '/FlateDecode', 'lossless');
  equal(two.colorSpace, '/DeviceRGB', 'colour');
  equal(JSON.stringify(two.parms), JSON.stringify({ Columns: 200, Predictor: 15, Colors: 3, BitsPerComponent: 8 }), 'predictor');
  equal(`${two.width}x${two.height}`, '200x100', 'size');
  const m2 = cmOf(two.content);
  // A quarter turn clockwise: 100 x 200 as shown, filling A4's width.
  near(m2[0], 0, 1e-9, 'a');
  near(m2[1], -841.8898, 1e-3, 'b');
  near(m2[2], 420.9449, 1e-3, 'c');
  near(m2[3], 0, 1e-9, 'd');
  // A title with letters beyond ASCII.
  const [unicode] = await build.buildImagesPdf([{ name: 'x.png', bytes: png }], { name: 'Reçu (été)' });
  equal(unicode.name, 'Reçu (été).pdf', 'unicode name');
  equal((await pdfFacts(unicode.bytes)).title, 'Reçu (été)', 'unicode title');
}));

test('PDF: black-and-white pages are CCITT G4, a bit a pixel; grey pages one component', (page) => page.evaluate(async () => {
  const { build, pdfFacts, pdfjsImages, shadedPhoto, looks, encode, ccitt, random, pngOf, canvas, assert, equal, made, sameArray } = window.T;
  const shaded = await shadedPhoto(1240);
  window.T.shaded = shaded;
  const [bw] = await build.buildImagesPdf([{ name: 'p.jpg', bytes: shaded.bytes, look: 'black_white' }], { pageSize: 'a4' });
  const facts = await pdfFacts(bw.bytes);
  const p = facts.pages[0];
  equal(p.filter, '/CCITTFaxDecode', 'CCITT');
  equal(p.colorSpace, '/DeviceGray', 'grey');
  equal(p.bpc, 1, 'a bit a pixel');
  equal(JSON.stringify(p.parms), JSON.stringify({ K: -1, Columns: p.width, Rows: p.height }), 'parameters');
  equal(p.width, 1240, 'A4 at 150 dpi');
  // About 10 KB a page of print.
  assert(bw.bytes.length < 25000, `black and white page ${bw.bytes.length} bytes`);
  // Decoded by pdf.js: exactly the look, made beside it from the photo as decoded.
  const decodedPhoto = await window.T.decodeImage(shaded.bytes);
  const expected = made(decodedPhoto, 'black_white');
  const [inPdf] = await pdfjsImages(bw.bytes);
  let differ = 0;
  for (let i = 0; i < expected.data.length; i += 4) if ((inPdf.data[i] < 128) !== (expected.data[i] < 128)) differ++;
  equal(differ, 0, 'pixels that differ from the look');

  // Noise in black and white: Flate is smaller than G4 there, and taken.
  const rnd = random(1);
  const noise = canvas(64, 64);
  const ng = noise.getContext('2d');
  const id = ng.createImageData(64, 64);
  for (let i = 0; i < id.data.length; i += 4) { const v = rnd.nextInt(0, 2) ? 250 : 5; id.data.set([v, v, v, 255], i); }
  ng.putImageData(id, 0, 0);
  const [noisy] = await build.buildImagesPdf([{ name: 'n.png', bytes: await pngOf(noise), look: 'black_white', rotation: 90 }], { pageSize: 'a4' });
  const nf = (await pdfFacts(noisy.bytes)).pages[0];
  const noiseBits = window.T.bits(window.T.pixelsOf(noise));
  const g4 = ccitt.encodeBitImage(noiseBits).length;
  const fl = encode.flateBits(noiseBits).length;
  assert(fl < g4, `noise: Flate ${fl}, G4 ${g4}`);
  equal(nf.filter, '/FlateDecode', 'Flate for noise');
  equal(JSON.stringify(nf.parms), JSON.stringify({ Columns: 64, Predictor: 15, Colors: 1, BitsPerComponent: 1 }), 'noise parameters');
  equal(nf.bpc, 1, 'a bit a pixel');
  const [noiseBack] = await pdfjsImages(noisy.bytes);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) equal(noiseBack.data[(y * 64 + x) * 4] < 128, looks.isBlack(noiseBits, x, y), `noise ${x}, ${y}`);

  const [grey] = await build.buildImagesPdf([{ name: 'p.jpg', bytes: shaded.bytes, look: 'grayscale' }], {});
  const gf = (await pdfFacts(grey.bytes)).pages[0];
  equal(gf.filter, '/DCTDecode', 'grey JPEG');
  equal(gf.colorSpace, '/DeviceGray', 'DeviceGray');
  equal(gf.bpc, 8, '8 bits');
  equal(window.T.jpeg.parseJpeg(gf.data).components, 1, 'one component');
}));

test('PDF: each look is stored as it needs and drawn right (LooksDeviceTest)', (page) => page.evaluate(async () => {
  const { build, looks, pdfFacts, renderPage, share, SHADED, luma, assert, equal } = window.T;
  const shaded = window.T.shaded;
  const sizes = {};
  for (const look of looks.LOOKS) {
    const [pdf] = await build.buildImagesPdf([{ name: 'page.jpg', bytes: shaded.bytes, look }], { pageSize: 'a4', orientation: 'portrait', margin: 'none', compression: 'recommended', name: 'Scan' });
    sizes[look] = pdf.bytes.length;
    const f = (await pdfFacts(pdf.bytes)).pages[0];
    const expected = looks.isBilevel(look) ? ['/CCITTFaxDecode', '/DeviceGray', 1] : look === 'grayscale' ? ['/DCTDecode', '/DeviceGray', 8] : ['/DCTDecode', '/DeviceRGB', 8];
    equal(JSON.stringify([f.filter, f.colorSpace, f.bpc]), JSON.stringify(expected), look);
    equal(f.width, 1240, `${look}: A4 at 150 dpi`);
    const img = await renderPage(pdf.bytes, 1, 1240);
    const L = (r, g, b) => luma(r, g, b);
    const shadedPaper = share(img, SHADED.SHADED_PAPER, 0.005, (r, g, b) => L(r, g, b) >= 225);
    const litPaper = share(img, SHADED.LIT_PAPER, 0.005, (r, g, b) => L(r, g, b) >= 225);
    const bar = share(img, SHADED.BAR, 0.005, (r, g, b) => L(r, g, b) < 70);
    if (look === 'ink_saver') {
      const inside = share(img, SHADED.BAR, 0.01, (r, g, b) => L(r, g, b) >= 225);
      assert(inside > 0.98, `${look}: inside the bar ${inside}`);
    } else {
      assert(bar > 0.98, `${look}: bar ${bar}`);
    }
    if (look === 'original') {
      assert(shadedPaper < 0.01, `${look}: paper in the shadow stays grey ${shadedPaper}`);
      continue;
    }
    if (look === 'lighten') {
      const sh = share(img, SHADED.SHADED_PAPER, 0.005, (r, g, b) => L(r, g, b) >= 170 && L(r, g, b) <= 224);
      const lit = share(img, SHADED.LIT_PAPER, 0.005, (r, g, b) => L(r, g, b) >= 210);
      assert(sh > 0.99 && lit > 0.995, `${look}: paper in the shadow ${sh}, in the light ${lit}`);
      continue;
    }
    assert(shadedPaper > 0.995, `${look}: paper in the shadow ${shadedPaper}`);
    assert(litPaper > 0.995, `${look}: paper in the light ${litPaper}`);
    if (!looks.isColour(look)) {
      const grey = share(img, [0, 0, 1, 1], 0, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) <= 2);
      assert(grey > 0.999, `${look}: grey ${grey}`);
    }
  }
  // Contrast all the way down fades the ink: the bar grey, the paper still white.
  const [faded] = await build.buildImagesPdf([{ name: 'page.jpg', bytes: shaded.bytes, look: 'enhanced', contrast: -100 }], {});
  const fimg = await renderPage(faded.bytes, 1, 1240);
  const bar = share(fimg, SHADED.BAR, 0.005, (r, g, b) => luma(r, g, b) < 70);
  const paper = share(fimg, SHADED.LIT_PAPER, 0.005, (r, g, b) => luma(r, g, b) >= 225);
  assert(bar < 0.05 && paper > 0.995, `faded: bar black ${bar}, paper white ${paper}`);
  // Black and white takes a fraction of the photo's size; one grey component less than three of colour.
  assert(sizes.black_white * 4 < sizes.original, `sizes ${JSON.stringify(sizes)}`);
  assert(sizes.grayscale < sizes.enhanced, `sizes ${JSON.stringify(sizes)}`);
  return sizes;
}));

test('PDF: every compression level sizes the image for the page; black and white far smaller', (page) => page.evaluate(async () => {
  const { build, layout: L, looks, pdfFacts, shadedPhoto, assert, equal } = window.T;
  const big = await shadedPhoto(2480);
  const report = {};
  for (const compression of Object.keys(L.COMPRESSION)) {
    const sizes = {};
    for (const look of ['original', 'enhanced', 'grayscale', 'black_white', 'ink_saver']) {
      const [pdf] = await build.buildImagesPdf([{ name: 'large.jpg', bytes: big.bytes, look }], { pageSize: 'a4', compression });
      const f = (await pdfFacts(pdf.bytes)).pages[0];
      const [w, h] = L.scaledSize(big.width, big.height, L.scaleFor(big.width, big.height, { pageSize: 'a4' }, compression));
      equal(`${f.width}x${f.height}`, `${w}x${h}`, `${look} at ${compression}`);
      sizes[look] = Math.round(pdf.bytes.length / 1024);
    }
    assert(sizes.black_white * 4 < sizes.original, `${compression}: ${JSON.stringify(sizes)}`);
    assert(sizes.grayscale < sizes.enhanced, `${compression}: ${JSON.stringify(sizes)}`);
    report[compression] = sizes;
  }
  console.log('KB per A4 page: ' + JSON.stringify(report));
  return report;
}));

test('PDF: every page size, orientation and margin, the image where the layout says, drawn there', (page) => page.evaluate(async () => {
  const { build, layout: L, pdfFacts, cmOf, renderPage, near, equal, assert, canvas, jpegOf } = window.T;
  // A photo 900 x 600: red left half, blue right half, a black square at its top-left corner.
  const c = canvas(900, 600);
  const g = c.getContext('2d');
  g.fillStyle = '#d02020';
  g.fillRect(0, 0, 450, 600);
  g.fillStyle = '#2040d0';
  g.fillRect(450, 0, 450, 600);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 90, 90);
  const bytes = await jpegOf(c, 0.92);
  for (const pageSize of Object.keys(L.PAGE_SIZES)) for (const orientation of L.ORIENTATIONS) for (const margin of Object.keys(L.MARGINS)) {
    const what = `${pageSize} ${orientation} ${margin}`;
    const settings = { pageSize, orientation, margin, compression: 'extreme' };
    const [pdf] = await build.buildImagesPdf([{ name: 'photo.jpg', bytes }], settings);
    const f = (await pdfFacts(pdf.bytes)).pages[0];
    const g2 = L.computeLayout(f.width, f.height, settings);
    near(f.box[2], g2.pageWidth, 1e-4, `${what} page width`);
    near(f.box[3], g2.pageHeight, 1e-4, `${what} page height`);
    const m = cmOf(f.content);
    near(m[0], g2.imageWidth, 1e-4, `${what} image width`);
    near(m[3], g2.imageHeight, 1e-4, `${what} image height`);
    near(m[4], g2.imageX, 1e-4, `${what} x`);
    near(m[5], g2.imageY, 1e-4, `${what} y`);
    if (pageSize !== 'fit') {
      // The margin is kept on the side the image fills.
      const mm = L.MARGINS[margin];
      assert(Math.min(m[4], m[5]) >= mm - 1e-4 && Math.abs(Math.min(m[4], m[5]) - mm) < 1e-3, `${what} margin ${m[4]}, ${m[5]}`);
      const landscape = orientation === 'landscape' || (orientation === 'auto');
      equal(f.box[2] > f.box[3], landscape, `${what} orientation`);
      // Extreme is 100 dpi of the space the image fills.
      const [w] = L.scaledSize(900, 600, L.scaleFor(900, 600, settings, 'extreme'));
      equal(f.width, w, `${what} pixels`);
    }
  }
  // Drawn there: A5 landscape with a big margin, rendered and sampled.
  const settings = { pageSize: 'a5', orientation: 'landscape', margin: 'big' };
  const [pdf] = await build.buildImagesPdf([{ name: 'photo.jpg', bytes }], settings);
  const geo = L.computeLayout(900, 600, settings);
  const width = 1190;
  const img = await renderPage(pdf.bytes, 1, width);
  const k = width / geo.pageWidth;
  const at = (x, y) => {
    const px = Math.round(x * k);
    const py = Math.round((geo.pageHeight - y) * k);
    const i = (py * img.width + px) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const isWhite = ([r, g3, b]) => r > 245 && g3 > 245 && b > 245;
  assert(isWhite(at(geo.imageX - 10, geo.imageY + geo.imageHeight / 2)), 'white margin left');
  assert(isWhite(at(geo.imageX + geo.imageWidth + 10, geo.imageY + geo.imageHeight / 2)), 'white margin right');
  assert(isWhite(at(geo.imageX + geo.imageWidth / 2, geo.imageY - 10)), 'white margin below');
  const left = at(geo.imageX + geo.imageWidth * 0.25, geo.imageY + geo.imageHeight * 0.5);
  const right = at(geo.imageX + geo.imageWidth * 0.75, geo.imageY + geo.imageHeight * 0.5);
  const corner = at(geo.imageX + geo.imageWidth * 0.05, geo.imageY + geo.imageHeight * 0.95);
  assert(left[0] > 150 && left[2] < 90, `red on the left ${left}`);
  assert(right[2] > 150 && right[0] < 90, `blue on the right ${right}`);
  assert(corner[0] < 40 && corner[1] < 40 && corner[2] < 40, `black at the top-left ${corner}`);
}));

test('PDF: photos come out the right way up (EXIF), kept as they are or compressed', (page) => page.evaluate(async () => {
  const { build, jpeg, canvas, jpegOf, pdfFacts, renderPage, assert, equal, indexOf } = window.T;
  // Stored 400 x 200: red left, blue right, with noise so a JPEG's quality tells in its size. EXIF 6
  // says turn a quarter clockwise: upright it is 200 x 400, red on top.
  const c = canvas(400, 200);
  const g = c.getContext('2d');
  const id = g.createImageData(400, 200);
  const rnd = window.T.random(9);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) {
    const n = rnd.nextInt(-30, 31);
    id.data.set(x < 200 ? [200 + n, 20 + n, 20 + n, 255] : [20 + n, 20 + n, 200 + n, 255], (y * 400 + x) * 4);
  }
  g.putImageData(id, 0, 0);
  for (const [quality, kept] of [[0.2, true], [1, false]]) {
    const bytes = jpeg.withExifOrientation(await jpegOf(c, quality), 6);
    const [pdf] = await build.buildImagesPdf([{ name: 'turned.jpg', bytes }], { pageSize: 'fit', compression: 'less' });
    const f = (await pdfFacts(pdf.bytes)).pages[0];
    equal(`${f.box[2]}x${f.box[3]}`, '200x400', `page upright (${quality})`);
    equal(indexOf(pdf.bytes, jpeg.stripJpeg(bytes)) >= 0, kept, `original kept at quality ${quality}`);
    equal(indexOf(pdf.bytes, 'Exif'), -1, 'no EXIF in the PDF');
    const img = await renderPage(pdf.bytes, 1, 200);
    const px = (x, y) => img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3);
    const top = px(100, 100);
    const bottom = px(100, 300);
    assert(top[0] > 150 && top[2] < 100, `red on top (${quality}): ${top}`);
    assert(bottom[2] > 150 && bottom[0] < 100, `blue below (${quality}): ${bottom}`);
  }
  // The caller's orientation counts over the file's: upright as stored, or turned another way.
  const marked = jpeg.withExifOrientation(await jpegOf(c, 0.9), 6);
  const [asStored, turnedOver] = await build.buildImagesPdf([
    { name: 'a.jpg', bytes: marked, exifOrientation: 1 },
    { name: 'b.jpg', bytes: marked, exifOrientation: 3, look: 'grayscale' },
  ], { pageSize: 'fit', merge: false });
  equal((await pdfFacts(asStored.bytes)).pages[0].box.slice(2).join('x'), '400x200', 'as stored');
  const stored = await renderPage(asStored.bytes, 1, 400);
  assert(stored.data[(100 * 400 + 100) * 4] > 150 && stored.data[(100 * 400 + 300) * 4 + 2] > 150, 'red left, blue right');
  const over = await renderPage(turnedOver.bytes, 1, 400);
  assert(window.T.lumaAt(over, 100, 100) < window.T.lumaAt(over, 300, 100), 'a half turn: blue (darker in grey) on the left');
  // Turned by the user as well: a half turn more puts blue on top.
  const bytes = jpeg.withExifOrientation(await jpegOf(c, 0.9), 6);
  const [turned] = await build.buildImagesPdf([{ name: 't.jpg', bytes, rotation: 180, look: 'enhanced' }], { pageSize: 'fit' });
  const img = await renderPage(turned.bytes, 1, 200);
  const top = img.data.slice((100 * img.width + 100) * 4, (100 * img.width + 100) * 4 + 3);
  assert(top[2] > 150 && top[0] < 100, `blue on top after a half turn: ${top}`);
}));

test('PDF: the original is kept when smaller, its metadata left out; a big photo is shrunk', (page) => page.evaluate(async () => {
  const { build, jpeg, canvas, jpegOf, pdfFacts, random, assert, equal, indexOf, segment, withSegments } = window.T;
  const rnd = random(1);
  const noise = (w, h) => {
    const c = canvas(w, h);
    const g = c.getContext('2d');
    const id = g.createImageData(w, h);
    for (let i = 0; i < id.data.length; i += 4) id.data.set([rnd.nextInt(0, 256), rnd.nextInt(0, 256), rnd.nextInt(0, 256), 255], i);
    g.putImageData(id, 0, 0);
    return c;
  };
  // Low quality, so the original is smaller than a re-encoded copy and goes into the PDF as is.
  const low = withSegments(await jpegOf(noise(400, 300), 0.2), segment(0xe1, 'Exif\u0000\u0000MM SecretCam GPS'));
  const [pdf] = await build.buildImagesPdf([{ name: 'exif.jpg', bytes: low }], { name: 'Notes' });
  assert(indexOf(pdf.bytes, jpeg.stripJpeg(low)) >= 0, 'original image kept');
  equal(indexOf(pdf.bytes, 'SecretCam'), -1, 'no camera');
  equal(indexOf(pdf.bytes, 'Exif'), -1, 'no EXIF');
  // A wide-gamut original isn't kept as it is.
  const p3 = withSegments(await jpegOf(noise(400, 300), 0.2), segment(0xe2, 'ICC_PROFILE\u0000\u0001\u0001' + '\u0000'.repeat(128) + '\u0000\u0000\u0000\u0001desc\u0000\u0000\u0000\u0090\u0000\u0000\u0000\u0017desc\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u000bDisplay P3\u0000'));
  assert(!jpeg.jpegIsSrgb(p3), 'tagged Display P3');
  const [wide] = await build.buildImagesPdf([{ name: 'p3.jpg', bytes: p3 }], {});
  equal(indexOf(wide.bytes, jpeg.stripJpeg(p3)), -1, 'wide-gamut original left out');
  // A big, good photo is shrunk to 150 dpi of A4's width.
  const bigPhoto = await jpegOf(noise(2480, 3508), 0.95);
  const [shrunk] = await build.buildImagesPdf([{ name: 'big.jpg', bytes: bigPhoto }], {});
  const f = (await pdfFacts(shrunk.bytes)).pages[0];
  equal(`${f.width}x${f.height}`, '1240x1754', 'shrunk');
  assert(shrunk.bytes.length < bigPhoto.length / 2, 'smaller');
}));

test('PDF: transparency on white, grey PNGs stored grey, other image types', (page) => page.evaluate(async () => {
  const { build, canvas, pngOf, pdfFacts, renderPage, pdfjsImages, assert, equal } = window.T;
  const c = canvas(300, 200);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(100, 80, 100, 40);
  const transparent = await pngOf(c);
  for (const look of ['original', 'enhanced', 'grayscale', 'black_white']) {
    const [pdf] = await build.buildImagesPdf([{ name: 't.png', bytes: transparent, look }], { pageSize: 'fit' });
    const img = await renderPage(pdf.bytes, 1, 300);
    const px = (x, y) => img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3);
    assert(px(20, 20).every((v) => v > 245), `${look}: the see-through background is white ${px(20, 20)}`);
    assert(px(150, 100).every((v) => v < 60), `${look}: the print black ${px(150, 100)}`);
  }
  // A grey diagram (thin lines, which a PNG holds in far less than a JPEG) is kept losslessly, with one component.
  const grey = canvas(240, 160);
  const gg = grey.getContext('2d');
  gg.fillStyle = '#808080';
  gg.fillRect(0, 0, 240, 160);
  gg.fillStyle = '#202020';
  for (let x = 0; x < 240; x += 4) gg.fillRect(x, 0, 1, 160);
  for (let y = 0; y < 160; y += 4) gg.fillRect(0, y, 240, 1);
  const [gp] = await build.buildImagesPdf([{ name: 'g.png', bytes: await pngOf(grey) }], { pageSize: 'fit' });
  const gf = (await pdfFacts(gp.bytes)).pages[0];
  equal(gf.filter, '/FlateDecode', 'kept losslessly');
  equal(gf.colorSpace, '/DeviceGray', 'grey');
  const [back] = await pdfjsImages(gp.bytes);
  equal(back.data[0], 0x20, 'pixel');
  equal(back.data[(30 * 240 + 30) * 4], 0x80, 'pixel');
  // WebP and BMP pictures, as the browser decodes them.
  const webpBlob = await new Promise((r) => grey.toBlob(r, 'image/webp', 0.9));
  const webp = new Uint8Array(await webpBlob.arrayBuffer());
  if (webp[8] === 0x57) {
    const [wp] = await build.buildImagesPdf([{ name: 'w.webp', bytes: webp }], { pageSize: 'fit' });
    equal((await pdfFacts(wp.bytes)).pages[0].width, 240, 'WebP');
  }
  const bmp = new Uint8Array(54 + 4 * 2 * 2);
  const dv = new DataView(bmp.buffer);
  bmp[0] = 0x42; bmp[1] = 0x4d;
  dv.setUint32(2, bmp.length, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true);
  dv.setInt32(18, 2, true); dv.setInt32(22, 2, true); dv.setUint16(26, 1, true); dv.setUint16(28, 32, true);
  bmp.fill(0xff, 54);
  const [bp] = await build.buildImagesPdf([{ name: 'b.bmp', bytes: bmp }], { pageSize: 'fit' });
  equal((await pdfFacts(bp.bytes)).pages[0].width, 2, 'BMP');
}));

test('PDF: pages handed over as pixels (a cropped page, a HEIC decoded elsewhere)', (page) => page.evaluate(async () => {
  const { build, canvas, pdfFacts, renderPage, assert, equal, pixelsOf } = window.T;
  const c = canvas(300, 400);
  const g = c.getContext('2d');
  g.fillStyle = '#f0f0f0';
  g.fillRect(0, 0, 300, 400);
  g.fillStyle = '#101010';
  g.fillRect(0, 0, 300, 60);
  let calls = 0;
  const [pdf] = await build.buildImagesPdf([
    { name: 'canvas', source: c, look: 'black_white' },
    { name: 'data', source: pixelsOf(c), look: 'grayscale' },
    { name: 'later', source: async () => { calls++; return createImageBitmap(c); }, rotation: 180 },
    { name: 'sideways', source: c, exifOrientation: 8 },
  ], { pageSize: 'fit' });
  equal(calls, 1, 'the function is called once, when its page is made');
  const facts = await pdfFacts(pdf.bytes);
  equal(facts.pages.map((p) => `${p.box[2]}x${p.box[3]}`).join(), '300x400,300x400,300x400,400x300', 'page sizes');
  const r3 = await renderPage(pdf.bytes, 3, 300);
  assert(r3.data[(380 * 300 + 150) * 4] < 60, 'turned a half: the dark band at the bottom');
  assert(c.width === 300, 'the canvas handed over is left as it is');
}));

test('PDF: one PDF per image, named after each; one image makes one PDF', (page) => page.evaluate(async () => {
  const { build, canvas, pngOf, equal, pdfFacts } = window.T;
  const c = canvas(50, 50);
  c.getContext('2d').fillRect(10, 10, 20, 20);
  const png = await pngOf(c);
  const progress = [];
  const files = await build.buildImagesPdf([
    { name: 'Receipt.jpg', bytes: png },
    { name: 'receipt.png', bytes: png },
    { name: 'a:b?.png', bytes: png },
    { name: '.png', bytes: png },
    { name: '  ', bytes: png },
  ], { merge: false }, { onProgress: (done, total) => progress.push(`${done}/${total}`) });
  // As FileNames.sanitize: leading dots go, so '.png' is 'png'; a blank name is Usugami.
  equal(files.map((f) => f.name).join('|'), 'Receipt.pdf|receipt (2).pdf|a_b_.pdf|png.pdf|Usugami.pdf', 'names');
  equal(progress.join(), '0/5,1/5,2/5,3/5,4/5,5/5', 'progress');
  equal(files.every((f) => f.pageCount === 1), true, 'one page each');
  equal((await pdfFacts(files[1].bytes)).title, 'receipt (2)', 'title is the name');
  const [one] = await build.buildImagesPdf([{ name: 'IMG_2041.png', bytes: png }], { merge: false });
  equal(one.name, 'IMG_2041.pdf', 'one image named after it');
  const [merged] = await build.buildImagesPdf([{ name: 'a.png', bytes: png }, { name: 'b.png', bytes: png }], { name: '  Report.pdf ' });
  equal(merged.name, 'Report.pdf', 'merged name made safe');
  equal(merged.pageCount, 2, 'merged pages');
  const [dated] = await build.buildImagesPdf([{ name: 'a.png', bytes: png }, { name: 'b.png', bytes: png }], {});
  equal(/^Usugami_\d{8}_\d{6}\.pdf$/.test(dated.name), true, `default name ${dated.name}`);
}));

test('PDF: onPage gets pdf-lib\'s page, where the image sits and the original to read text from', (page) => page.evaluate(async () => {
  const { build, jpeg, canvas, jpegOf, pdflib, pdfjs, assert, equal, near } = window.T;
  const c = canvas(1600, 1200);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 1600, 1200);
  g.fillStyle = '#f00';
  g.fillRect(0, 0, 100, 100);
  const bytes = jpeg.withExifOrientation(await jpegOf(c, 0.9), 6);
  const seen = [];
  const [pdf] = await build.buildImagesPdf([{ name: 'p.jpg', bytes, look: 'black_white' }], { pageSize: 'a4', margin: 'small', compression: 'extreme' }, {
    async onPage(doc, p, info) {
      const shown = await info.render({ maxSide: 1600 });
      // Upright: the red corner, stored at the top-left, is at the top-right once turned a quarter.
      const px = shown.getContext('2d').getImageData(shown.width - 50, 50, 1, 1).data;
      seen.push({ w: shown.width, h: shown.height, red: px[0] > 200 && px[1] < 80, info: [info.width, info.height, info.index] });
      const [x, y] = info.toPage(0, 0);
      const [x2, y2] = info.toPage(1, 1);
      seen.push({ topLeft: [x, y], bottomRight: [x2, y2], geometry: info.geometry });
      const font = await doc.embedFont(pdflib.StandardFonts.Helvetica);
      p.drawText('Recognised words', { x, y: y - 20, size: 12, font });
    },
  });
  equal(seen[0].w, 1200, 'shown width');
  equal(seen[0].h, 1600, 'shown height');
  equal(seen[0].red, true, 'shown upright, in colour whatever the look');
  equal(seen[0].info.join(), '1200,1600,0', 'info');
  const geo = seen[1].geometry;
  near(seen[1].topLeft[0], geo.imageX, 1e-6, 'top-left x');
  near(seen[1].topLeft[1], geo.imageY + geo.imageHeight, 1e-6, 'top-left y');
  near(seen[1].bottomRight[0], geo.imageX + geo.imageWidth, 1e-6, 'bottom-right x');
  near(seen[1].bottomRight[1], geo.imageY, 1e-6, 'bottom-right y');
  const doc = await pdfjs.openPdfJs(pdf.bytes);
  const text = await (await doc.getPage(1)).getTextContent();
  await doc.loadingTask.destroy();
  assert(text.items.map((i) => i.str).join(' ').includes('Recognised words'), 'the text added on the page is in the PDF');
}));

test('PDF: damaged and unreadable images are named; cancelling stops', (page) => page.evaluate(async () => {
  const { build, canvas, jpegOf, assert, equal } = window.T;
  const expectError = async (pages, settings, hooks, check) => {
    try {
      await build.buildImagesPdf(pages, settings, hooks);
    } catch (e) {
      check(e);
      return;
    }
    throw new Error('No error');
  };
  const good = await jpegOf(canvas(100, 100), 0.8);
  // A PNG header claiming 100000 x 100000 pixels, and nothing more.
  const huge = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 1, 0x86, 0xa0, 0, 1, 0x86, 0xa0, 8, 6, 0, 0, 0, 0, 0, 0, 0);
  const damaged = [
    ['broken.jpg', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3)],
    ['noise.png', crypto.getRandomValues(new Uint8Array(5000))],
    ['empty.jpg', new Uint8Array(0)],
    ['huge.png', huge],
  ];
  for (const [name, bytes] of damaged) {
    const started = performance.now();
    await expectError([{ name: 'fine.jpg', bytes: good }, { name, bytes }], {}, {}, (e) => {
      equal(e.name, 'UserError', `${name}: ${e}`);
      equal(e.key, 'msg_image_unreadable', `${name}: key`);
      equal(e.args.join(), name, `${name}: named`);
    });
    assert(performance.now() - started < 10000, `${name} quick`);
  }
  // A JPEG cut short decodes, as far as it goes, in some browsers and not in others: either way
  // it makes a page or names the file, quickly.
  try {
    const [cut] = await build.buildImagesPdf([{ name: 'cut.jpg', bytes: good.slice(0, 400) }], {});
    equal(cut.pageCount, 1, 'cut short: a page');
  } catch (e) {
    equal(e.key, 'msg_image_unreadable', 'cut short: named');
  }
  const controller = new AbortController();
  await expectError([{ name: 'a.jpg', bytes: good }, { name: 'b.jpg', bytes: good }, { name: 'c.jpg', bytes: good }], {}, {
    signal: controller.signal,
    onProgress: (done) => { if (done === 1) controller.abort(); },
  }, (e) => equal(e.name, 'CancelledError', 'cancelled'));
  await expectError([], {}, {}, (e) => assert(e instanceof RangeError, 'no images'));
  await expectError([{ name: 'a.jpg', bytes: good, look: 'sepia' }], {}, {}, (e) => assert(e instanceof RangeError, 'unknown look'));
  await expectError([{ name: 'a.jpg', bytes: good }], { pageSize: 'b5' }, {}, (e) => assert(e instanceof RangeError, 'unknown size'));
}));

test('PDF: a large photo stays responsive while its page is made', (page) => page.evaluate(async () => {
  const { build, canvas, jpegOf, assert } = window.T;
  // The earlier tests' large pictures let go, so a collection of them doesn't count against this one.
  for (const k of ['page1240', 'photo1240', 'shaded']) delete window.T[k];
  await new Promise((r) => setTimeout(r, 300));
  const c = canvas(4000, 3000);
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(210,200,180)';
  g.fillRect(0, 0, 4000, 3000);
  g.fillStyle = '#333';
  g.font = '60px serif';
  for (let line = 0; line < 40; line++) g.fillText(`A line of print on a large photo, number ${line}`, 100, 100 + line * 70);
  const bytes = await jpegOf(c, 0.92);
  // The longest the page went without painting a frame meanwhile.
  let frames = [];
  let running = true;
  const tick = () => {
    frames.push(performance.now());
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await new Promise((r) => setTimeout(r, 100));
  frames = [];
  const started = performance.now();
  const [pdf] = await build.buildImagesPdf([{ name: 'big.jpg', bytes, look: 'super_enhanced' }, { name: 'big.jpg', bytes, look: 'ink_saver' }], { pageSize: 'fit', compression: 'less' });
  const total = performance.now() - started;
  await new Promise((r) => setTimeout(r, 50));
  running = false;
  let longest = 0;
  for (let i = 1; i < frames.length; i++) longest = Math.max(longest, frames[i] - frames[i - 1]);
  console.log(`Two 12 MP pages in ${Math.round(total)} ms, ${frames.length} frames painted meanwhile, at most ${Math.round(longest)} ms apart`);
  assert(pdf.pageCount === 2, 'pages');
  assert(frames.length > total / 200, `only ${frames.length} frames in ${Math.round(total)} ms`);
  // Playwright's WebKit (on Windows, without OffscreenCanvas) decodes and draws a 12 MP photo in
  // one go now and then; Chromium and Firefox paint at least every 150 ms or so.
  const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  assert(longest < (webkit ? 600 : 300), `no frame painted for ${Math.round(longest)} ms`);
  return { total: Math.round(total), longest: Math.round(longest) };
}));

// ---------------------------------------------------------------------------------------------
// Other browsers: the parts that depend on the browser (its JPEG encoder and decoder, EXIF, canvas)

test('browsers: encoders, EXIF, a PDF of each kind of page read back', (page) => page.evaluate(async () => {
  const { build, encode, jpeg, canvas, jpegOf, pdfFacts, pdfjsImages, renderPage, decodeImage, made, assert, equal } = window.T;
  const c = canvas(400, 200);
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(235,230,220)';
  g.fillRect(0, 0, 400, 200);
  // Print on the left half, lines that differ (Flate would find lines repeated), the right half blank.
  g.fillStyle = 'rgb(30,30,30)';
  g.font = 'bold 15px sans-serif';
  ['Usugami makes', 'PDFs of pages', 'scanned with', 'a phone, in', 'black and white', 'of a few KB', 'with CCITT G4', 'as scanners', 'store them.', '0123456789'].forEach((t, i) => g.fillText(t, 8 + (i % 3) * 7, 22 + i * 18));
  // Colour JPEG from every kind of picture, flattened onto white.
  const see = canvas(50, 50);
  see.getContext('2d').fillRect(0, 0, 10, 10);
  for (const source of [c, see, see.getContext('2d').getImageData(0, 0, 50, 50), await createImageBitmap(c)]) {
    const bytes = await encode.encodeJpeg(source, { quality: 80 });
    const info = jpeg.parseJpeg(bytes);
    assert(info.canEmbedDirectly && info.components === 3, 'colour JPEG');
  }
  const seeThrough = await decodeImage(await encode.encodeJpeg(see, { quality: 90 }));
  assert(seeThrough.data[(40 * 50 + 40) * 4] > 240, 'transparency on white');
  equal(jpeg.parseJpeg(await encode.encodeJpeg(c, { quality: 80, gray: true })).components, 1, 'grey JPEG');
  // EXIF orientation 6, whether or not this browser's decoder follows it.
  const bytes = jpeg.withExifOrientation(await jpegOf(c, 0.9), 6);
  const follows = await window.T.source.bitmapsFollowExif();
  console.log(`createImageBitmap follows EXIF orientation: ${follows}`);
  const [pdf] = await build.buildImagesPdf([
    { name: 'turned.jpg', bytes },
    { name: 'turned.jpg', bytes, look: 'black_white' },
    { name: 'turned.jpg', bytes, look: 'grayscale' },
  ], { pageSize: 'fit' });
  const facts = await pdfFacts(pdf.bytes);
  equal(facts.pages.map((p) => `${p.box[2]}x${p.box[3]}`).join(), '200x400,200x400,200x400', `upright pages (decoder follows EXIF: ${follows})`);
  equal(facts.pages[1].filter, '/CCITTFaxDecode', 'CCITT');
  equal(facts.pages[1].bpc, 1, 'a bit a pixel');
  for (let n = 1; n <= 3; n++) {
    // Upright, the print is on the top half.
    const img = await renderPage(pdf.bytes, n, 200);
    const darkShare = (y0, y1) => {
      let dark = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < 200; x++) if (img.data[(y * 200 + x) * 4] < 100) dark++;
      return dark / ((y1 - y0) * 200);
    };
    const top = darkShare(20, 180);
    const bottom = darkShare(220, 380);
    assert(top > 0.05 && bottom < 0.005, `page ${n}: the print on top (${top}, ${bottom})`);
  }
  const [bw] = await pdfjsImages(pdf.bytes, [2]);
  const look = made(await decodeImage(jpeg.withExifOrientation(await jpegOf(c, 0.9), 1)), 'black_white');
  // The stored picture is 400 x 200 whichever way it was decoded; compare the dark share.
  const dark = (img) => { let n = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) n++; return n / (img.data.length / 4); };
  assert(Math.abs(dark(bw) - dark(look)) < 0.01, `black share ${dark(bw)} vs ${dark(look)}`);
}), { browsers: ['chromium', 'firefox', 'webkit'] });

// ---------------------------------------------------------------------------------------------

// BROWSERS=firefox,webkit runs every chosen test in those browsers instead.
const only = process.env.BROWSERS ? process.env.BROWSERS.split(',') : null;
const browsers = only ?? ['chromium', 'firefox', 'webkit'];
let failed = 0;
for (const browser of browsers) {
  const chosen = tests.filter((t) => (only || t.browsers.includes(browser)) && (!filters.length || filters.some((f) => t.name.includes(f))));
  if (!chosen.length) continue;
  await withPage(async (page, url) => {
    page.setDefaultTimeout(180000);
    page.on('console', (msg) => { if (msg.type() === 'log') console.log(`  [${browser}] ${msg.text()}`); });
    await setUp(page, url);
    for (const t of chosen) {
      const started = Date.now();
      try {
        await t.fn(page, url);
        console.log(`ok   ${browser}: ${t.name} (${Date.now() - started} ms)`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${browser}: ${t.name}\n     ${String(e.message ?? e).split('\n').slice(0, 6).join('\n     ')}`);
      }
    }
  }, { browser, viewport: { width: 1366, height: 900 }, mobile: false });
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('All passed.');
