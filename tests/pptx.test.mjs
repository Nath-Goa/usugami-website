// Tests for PowerPoint to PDF (site/app/js/engine/office/pptx.js): the presentations the app's
// OfficeConverterDeviceTest builds, the app's own deck.pptx fixture (from the Android project, when
// it is there), and more: backgrounds, master and layout shapes, placeholders, bullets and numbers,
// autofit, rotation, pictures, tables, damaged and hostile files, progress, cancelling and a large
// deck. PDFs are read back with pdf.js (text, positions, sizes, pictures) and rendered to pixels.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { withPage, assert, saveOutput } from './harness.mjs';

let passed = 0;
function check(name, condition, detail = '') {
  assert(condition, `${name}${detail !== '' ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  passed++;
}
const near = (expected, actual, tolerance = 1.5) => typeof actual === 'number' && Math.abs(expected - actual) <= tolerance;

/** The app's fixture (made by its tools/make_office_fixtures.py with python-pptx's default template). */
const DECK = 'C:/Users/Nathan/OneDrive/Desktop/pdfer/app/src/androidTest/assets/deck.pptx';

/** Loads the modules and the helpers that write presentations into the page as window.T. */
async function setup(page, url) {
  await page.goto(url + 'app/fonts/OFL.txt');
  await page.evaluate(async (base) => {
    const at = (p) => import(base + 'app/js/' + p);
    const T = {};
    window.T = T;
    T.index = await at('engine/office/index.js');
    T.pptx = await at('engine/office/pptx.js');
    T.pdfjs = await at('lib/pdfjs.js');
    T.lib = await at('lib/pdf-lib.js');
    T.fflate = await at('lib/fflate.js');
    const enc = new TextEncoder();
    T.u8 = (s) => (typeof s === 'string' ? enc.encode(s) : s);
    T.b64 = (b) => {
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    };
    T.fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    T.zip = (files) => {
      const entries = {};
      for (const [name, v] of Object.entries(files)) entries[name] = [T.u8(v), { level: 6 }];
      return T.fflate.zipSync(entries);
    };
    const EMU = 12700;
    T.EMU = EMU;
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
    T.MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
    T.NS = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"`;
    T.A = A;
    T.relationships = (...rels) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">` +
      rels.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${R}/${type}" Target="${target}"/>`).join('') + '</Relationships>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>';
    const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
    T.tree = tree;
    T.slide = (shapes, { hidden = false, attrs = '', bg = '', after = '' } = {}) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <p:sld ${T.NS}${hidden ? ' show="0"' : ''} ${attrs}><p:cSld>${bg}<p:spTree>${tree}${shapes}</p:spTree></p:cSld>${after}</p:sld>`;
    T.xfrm = (x, y, w, h, attributes = '') => `<a:xfrm ${attributes}><a:off x="${x * EMU}" y="${y * EMU}"/><a:ext cx="${w * EMU}" cy="${h * EMU}"/></a:xfrm>`;
    T.rect = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
    T.solid = (hex) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
    T.run = (text, size, bold = false) => `<a:r><a:rPr lang="en-US" sz="${size * 100}" b="${bold ? 1 : 0}"/><a:t>${text}</a:t></a:r>`;
    T.textBox = (id, x, y, w, h, ...paragraphs) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr>${T.xfrm(x, y, w, h)}${T.rect}</p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`;
    T.sp = (id, spPr, paragraphs = null, bodyPr = '<a:bodyPr/>', ph = '', extra = '') =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${spPr}</p:spPr>${extra}` +
      (paragraphs != null ? `<p:txBody>${bodyPr}<a:lstStyle/>${paragraphs}</p:txBody>` : '') + '</p:sp>';
    T.pic = (id, rel, spPr, crop = '') => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="${rel}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${spPr}</p:spPr></p:pic>`;
    T.png = async (w, h, draw) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      draw(c.getContext('2d'), w, h);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    T.solidPng = (css) => T.png(20, 20, (ctx, w, h) => { ctx.fillStyle = css; ctx.fillRect(0, 0, w, h); });
    // The app's test picture: steel blue with a yellow sun.
    T.picturePng = (w, h) => T.png(w, h, (ctx) => {
      ctx.fillStyle = 'rgb(70,130,180)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffff00';
      ctx.beginPath();
      ctx.arc(w * 0.7, h * 0.35, h * 0.2, 0, 2 * Math.PI);
      ctx.fill();
    });

    /**
     * A 720 × 540 point presentation of `slides` (each slide's XML), with `attributes` on
     * p:presentation, the relationships of slide n+1 at slideRels[n], the presentation's other
     * relationships `more` ([type, target]), and `parts` besides (the app's deck()).
     */
    T.deck = (slides, { attributes = '', slideRels = {}, more = [], parts = {}, size = [720, 540] } = {}) => {
      const files = {
        '[Content_Types].xml': contentTypes,
        '_rels/.rels': T.relationships(['officeDocument', 'ppt/presentation.xml']),
        'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${T.NS} ${attributes}>
          <p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst>
          <p:sldSz cx="${size[0] * EMU}" cy="${size[1] * EMU}"/></p:presentation>`,
        'ppt/_rels/presentation.xml.rels': T.relationships(...slides.map((_, i) => ['slide', `slides/slide${i + 1}.xml`]), ...more),
      };
      slides.forEach((xml, i) => { files[`ppt/slides/slide${i + 1}.xml`] = xml; });
      for (const [i, rels] of Object.entries(slideRels)) files[`ppt/slides/_rels/slide${Number(i) + 1}.xml.rels`] = rels;
      Object.assign(files, parts);
      return T.zip(files);
    };

    /**
     * The app's presentation(): 16:9, slides listed in another order than their file names ("First"
     * is slide3.xml), a picture 300 × 200 points at (72, 144) on the second, a fourth hidden slide.
     */
    T.presentation = async (onlyHidden = false) => {
      const title = (text) => T.textBox(2, 36, 36, 888, 72, `<a:p>${T.run(text, 40, true)}</a:p>`);
      const bullets = T.textBox(3, 36, 140, 600, 300,
        `<a:p><a:pPr marL="342900" indent="-342900"><a:buChar char="•"/></a:pPr>${T.run('Body point one', 18)}</a:p>`,
        `<a:p><a:pPr marL="342900" indent="-342900"><a:buChar char="•"/></a:pPr>${T.run('Body point two', 18)}</a:p>`);
      const picture = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture" descr="A made-up picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr>${T.xfrm(72, 144, 300, 200)}${T.rect}</p:spPr></p:pic>`;
      return T.zip({
        '[Content_Types].xml': contentTypes,
        '_rels/.rels': T.relationships(['officeDocument', 'ppt/presentation.xml']),
        'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${T.NS}>
          <p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId2"/><p:sldId id="259" r:id="rId4"/></p:sldIdLst>
          <p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
        'ppt/_rels/presentation.xml.rels': T.relationships(['slide', 'slides/slide1.xml'], ['slide', 'slides/slide2.xml'], ['slide', 'slides/slide3.xml'], ['slide', 'slides/slide4.xml']),
        'ppt/slides/slide3.xml': T.slide(title('First slide title') + bullets, { hidden: onlyHidden }),
        'ppt/slides/slide1.xml': T.slide(title('Second slide title') + picture, { hidden: onlyHidden }),
        'ppt/slides/_rels/slide1.xml.rels': T.relationships(['image', '../media/picture.png']),
        'ppt/slides/slide2.xml': T.slide(title('Third slide title'), { hidden: onlyHidden }),
        'ppt/slides/slide4.xml': T.slide(title('Secret draft slide'), { hidden: true }),
        'ppt/media/picture.png': await T.picturePng(300, 200),
      });
    };

    T.outputs = [];
    /** Converts with convertOffice: { bytes, name, pageCount, progress, leftOut } or { error: { name, key, manyKey } }. */
    T.convert = async (bytes, options = {}, extra = {}) => {
      const progress = [];
      const leftOut = [];
      try {
        const out = await T.index.convertOffice('powerpoint', { name: options.file ?? 'slides.pptx', bytes }, options, {
          onProgress: (done, total, info) => progress.push([done, total, !!info?.compressing]),
          onLeftOut: (e, name) => leftOut.push(`${name}: ${e?.message ?? e}`),
          ...extra,
        });
        T.outputs.push(out.bytes);
        return { ...out, progress, leftOut };
      } catch (e) {
        return { error: { name: e?.name, key: e?.key ?? null, manyKey: e?.manyKey ?? null, message: String(e?.message ?? e), cause: String(e?.cause?.message ?? '') }, progress };
      }
    };

    /** Each page's text and size: [{ text, width, height }]. */
    T.pages = async (bytes) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const p = await pdf.getPage(i);
        const vp = p.getViewport({ scale: 1 });
        const tc = await p.getTextContent();
        out.push({ text: tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim(), width: vp.width, height: vp.height });
      }
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      return out;
    };

    /**
     * The text pieces of page n with where they are: { str, x, y (baseline, from the top), size,
     * angle (degrees, counter-clockwise as on the page; 0 reads across, 180 upside down, 270 down),
     * width }.
     */
    T.glyphs = async (bytes, n) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      const p = await pdf.getPage(n);
      const h = p.getViewport({ scale: 1 }).height;
      const tc = await p.getTextContent();
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      return tc.items.filter((it) => it.str).map((it) => {
        const [a, b, c, d, e, f] = it.transform;
        let angle = Math.round((Math.atan2(b, a) * 180) / Math.PI);
        if (angle < 0) angle += 360;
        return { str: it.str, x: e, y: h - f, size: Math.hypot(c, d), angle, width: it.width };
      });
    };

    /** The piece of page n holding `word`, with the x where the word starts (by its share of the piece's letters). */
    T.word = async (bytes, n, word) => {
      const all = await T.glyphs(bytes, n);
      const g = all.find((it) => it.str.includes(word));
      if (!g) return null;
      const at = g.str.indexOf(word);
      const dx = (g.width * at) / Math.max(1, g.str.length);
      const rad = (g.angle * Math.PI) / 180;
      return { ...g, x: g.x + dx * Math.cos(rad), y: g.y - dx * Math.sin(rad) };
    };

    /** Where each picture of page n is drawn: [{ x, y, width, height }] in points from the top-left. */
    T.placed = async (bytes, n) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      const p = await pdf.getPage(n);
      const h = p.getViewport({ scale: 1 }).height;
      const ops = await p.getOperatorList();
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      const OPS = T.pdfjs.pdfjsLib.OPS;
      const mul = (m, k) => [
        m[0] * k[0] + m[1] * k[2], m[0] * k[1] + m[1] * k[3],
        m[2] * k[0] + m[3] * k[2], m[2] * k[1] + m[3] * k[3],
        m[4] * k[0] + m[5] * k[2] + k[4], m[4] * k[1] + m[5] * k[3] + k[5],
      ];
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const out = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === OPS.transform) ctm = mul(ops.argsArray[i], ctm);
        else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
          const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
          const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
          out.push({ x: Math.min(...xs), y: h - Math.max(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
        }
      }
      return out;
    };

    /** Renders page n; px(x, y) gives [r, g, b] at the point (x, y) points from the top-left. */
    T.render = async (bytes, n = 1, scale = 2) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      const p = await pdf.getPage(n);
      const vp = p.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      const px = (x, y) => {
        const i = (Math.floor(y * scale) * canvas.width + Math.floor(x * scale)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      return { px, scale, canvas, data };
    };
    // The app's isColor: within 60 of each channel.
    T.is = (rgb, hex) => {
      const want = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
      return rgb.every((v, i) => Math.abs(v - want[i]) < 60);
    };
    /** How many pixels of the rectangle (points) are about `hex`. */
    T.count = (r, x0, y0, w, h, hex) => {
      let n = 0;
      for (let x = x0; x < x0 + w; x += 1 / r.scale) for (let y = y0; y < y0 + h; y += 1 / r.scale) if (T.is(r.px(x, y), hex)) n++;
      return n;
    };
    T.RED = 0xff0000; T.GREEN = 0x00ff00; T.BLUE = 0x0000ff; T.BLACK = 0x000000; T.WHITE = 0xffffff;
  }, url);
}

/** Saves the PDFs the last test made in tests/output (pptx-<name>-<n>.pdf), to look at. */
async function keep(page, name) {
  const all = await page.evaluate(() => { const out = window.T.outputs.map((b) => window.T.b64(b)); window.T.outputs = []; return out; });
  for (const [i, b64] of all.entries()) await saveOutput(`pptx-${name}-${i + 1}.pdf`, Buffer.from(b64, 'base64'));
}

/** Runs `fn` (a function of T, as source) in the page and returns what it returns. */
const inPage = (page, fn, arg) => page.evaluate(`(${fn})(window.T, ${JSON.stringify(arg ?? null)})`);

// ---------------------------------------------------------------------------------------------

async function slidesInOrder(page) {
  const r = await inPage(page, async (T) => {
    const out = await T.convert(await T.presentation());
    if (out.error) return out;
    const title = await T.word(out.bytes, 1, 'First');
    const body = await T.word(out.bytes, 1, 'Body');
    return {
      name: out.name, pageCount: out.pageCount, progress: out.progress, leftOut: out.leftOut,
      pages: await T.pages(out.bytes), placed1: await T.placed(out.bytes, 1), placed2: await T.placed(out.bytes, 2),
      titleSize: title?.size, bodySize: body?.size,
    };
  });
  check('presentation converts', !r.error, r.error);
  check('three slides, the hidden one left out', r.pageCount === 3 && r.pages.length === 3, r.pageCount);
  check('slides in the presentation\'s order', r.pages[0].text.includes('First slide title') && r.pages[0].text.includes('Body point two') &&
    r.pages[1].text.includes('Second slide title') && r.pages[2].text.includes('Third slide title'), r.pages.map((p) => p.text));
  check('the hidden slide is left out', !r.pages.some((p) => p.text.includes('Secret draft')));
  check('progress counts slides 1, 2, 3 of 3', JSON.stringify(r.progress.filter((p) => !p[2]).map((p) => p[0])) === '[1,2,3]' && r.progress.filter((p) => !p[2]).every((p) => p[1] === 3), r.progress);
  check('then the PDF is saved', r.progress.at(-1)?.[2] === true, r.progress);
  check('16:9 slides make 960 × 540 pages', r.pages.every((p) => near(960, p.width) && near(540, p.height)), r.pages.map((p) => [p.width, p.height]));
  check('no picture on the first slide', r.placed1.length === 0, r.placed1);
  const pic = r.placed2[0];
  check('the picture where the slide puts it: 72 in, 144 down, 300 × 200', r.placed2.length === 1 && near(72, pic.x) && near(144, pic.y) && near(300, pic.width) && near(200, pic.height), r.placed2);
  check('title at 40 points, body at 18', near(40, r.titleSize, 0.5) && near(18, r.bodySize, 0.5), [r.titleSize, r.bodySize]);
  check('the PDF is named after the file', r.name === 'slides.pdf', r.name);
  check('nothing left out', r.leftOut.length === 0, r.leftOut);
}

async function deckFixture(page, bytes, browser = 'chromium') {
  const r = await inPage(page, async (T, b64) => {
    const out = await T.convert(T.fromB64(b64), { file: 'deck.pptx', name: 'Garden deck' });
    if (out.error) return out;
    const what = await T.word(out.bytes, 2, 'What');
    const veg = await T.word(out.bytes, 2, 'Vegetables');
    const tomatoes = await T.word(out.bytes, 2, 'Tomatoes');
    return {
      name: out.name, leftOut: out.leftOut, b64: T.b64(out.bytes), pages: await T.pages(out.bytes),
      pictures: [await T.placed(out.bytes, 3), await T.placed(out.bytes, 1)], what: what?.size, veg: veg?.size,
      tomatoes: tomatoes?.size, vegX: veg?.x, tomatoesX: tomatoes?.x,
    };
  }, bytes.toString('base64'));
  check(`${browser}: deck.pptx converts`, !r.error, r.error);
  await saveOutput(`pptx-deck-${browser}.pdf`, Buffer.from(r.b64, 'base64'));
  const titles = ['Riverside Community Garden', 'What we grew', 'The beds in June', 'Harvest', 'How the garden works', 'Harvest by month'];
  check(`${browser}: one page per shown slide`, r.pages.length === titles.length, r.pages.length);
  titles.forEach((title, i) => check(`${browser}: slide ${i + 1}: ${title}`, r.pages[i].text.includes(title), r.pages[i].text));
  check(`${browser}: the hidden slide is left out`, !r.pages.some((p) => p.text.includes('Draft notes')));
  check(`${browser}: bullets from the layout's body placeholder`, r.pages[1].text.includes('Squash and pumpkins'));
  check(`${browser}: table text`, r.pages[3].text.includes('Potatoes') && r.pages[3].text.includes('240'));
  check(`${browser}: text in shapes`, r.pages[4].text.includes('Harvest') && r.pages[4].text.includes('Share'));
  check(`${browser}: the chart's title in its stand-in box`, r.pages[5].text.includes('Harvest by month (kg)'));
  check(`${browser}: 720 × 540 pages`, r.pages.every((p) => near(720, p.width) && near(540, p.height)));
  check(`${browser}: the picture slide has one picture`, r.pictures[0].length === 1 && r.pictures[1].length === 0, r.pictures);
  check(`${browser}: the title takes its larger text from the master`, r.what > r.veg + 4, [r.what, r.veg]);
  check(`${browser}: bullets of each level from the master's body style`, /• Vegetables – Tomatoes, beans and peas – Squash and pumpkins • Herbs/.test(r.pages[1].text), r.pages[1].text);
  check(`${browser}: the second level smaller and further in`, r.tomatoes < r.veg - 2 && r.tomatoesX > r.vegX + 20, [r.veg, r.tomatoes, r.vegX, r.tomatoesX]);
  check(`${browser}: the name typed`, r.name === 'Garden deck.pdf', r.name);
  check(`${browser}: nothing left out`, r.leftOut.length === 0, r.leftOut);
  return Buffer.from(r.b64, 'base64');
}

async function deckPixels(page, pdf) {
  const r = await inPage(page, async (T, b64) => {
    const bytes = T.fromB64(b64);
    const table = await T.render(bytes, 4);
    const shapes = await T.render(bytes, 5);
    const chart = await T.render(bytes, 6);
    // Table: a header row in accent blue, then banded rows; shapes: four green steps and a sun.
    const header = table.px(150, 160);
    const band = table.px(150, 205);
    return { header, band, step: shapes.px(70, 190), sun: shapes.px(598, 382), between: shapes.px(195, 215), chart: chart.px(200, 200) };
  }, pdf.toString('base64'));
  check('deck: the table\'s header row is the accent colour', r.header[2] > 150 && r.header[0] < 120, r.header);
  check('deck: banded rows lighter', r.band[2] > 200 && r.band[0] > 150, r.band);
  check('deck: a step box is green', r.step[1] > r.step[0] + 30 && r.step[1] > r.step[2] + 30, r.step);
  check('deck: the yellow circle', r.sun[0] > 200 && r.sun[1] > 150 && r.sun[2] < 120, r.sun);
  check('deck: a connector between steps', r.between[0] < 150, r.between);
  check('deck: the chart is a light grey box', r.chart.every((v) => v > 230 && v < 250), r.chart);
}

async function slideNumbers(page) {
  const r = await inPage(page, async (T) => {
    const numbered = (hidden) => T.slide(T.textBox(2, 36, 36, 400, 72,
      `<a:p>${T.run('Slide ', 24)}<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US" sz="2400"/><a:t>‹#›</a:t></a:fld></a:p>`), { hidden });
    const slides = [numbered(false), numbered(true), numbered(false), numbered(false)];
    const numbers = async (bytes) => (await T.pages(bytes)).map((p) => /Slide (\d+)/.exec(p.text)?.[1]);
    return [await numbers((await T.convert(T.deck(slides))).bytes), await numbers((await T.convert(T.deck(slides, { attributes: 'firstSlideNum="0"' }))).bytes)];
  });
  check('a hidden slide keeps its number', JSON.stringify(r[0]) === '["1","3","4"]', r[0]);
  check('numbers start at firstSlideNum', JSON.stringify(r[1]) === '["0","2","3"]', r[1]);
}

async function connectorsGroupsAndSavedPictures(page) {
  const r = await inPage(page, async (T) => {
    const E = T.EMU;
    const elbow = `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="2" name="Elbow"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${T.xfrm(40, 40, 200, 100)}
      <a:prstGeom prst="bentConnector3"><a:avLst/></a:prstGeom><a:ln w="${4 * E}">${T.solid('000000')}<a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>`;
    const circle = T.sp(3, T.xfrm(300, 40, 100, 100) + '<a:prstGeom prst="flowChartConnector"><a:avLst/></a:prstGeom>' + T.solid('FF0000'));
    // Flipped left to right: its blue square, in the left half of the group's own coordinates, on the right.
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm flipH="1">
      <a:off x="${40 * E}" y="${200 * E}"/><a:ext cx="${200 * E}" cy="${100 * E}"/><a:chOff x="0" y="0"/><a:chExt cx="${200 * E}" cy="${100 * E}"/></a:xfrm></p:grpSpPr>
      ${T.sp(5, T.xfrm(0, 0, 100, 100) + T.rect + T.solid('0000FF'))}</p:grpSp>`;
    // Freeforms: one with a point given by a formula, which is left out; one in the shape's EMUs, 72 points square.
    const formula = T.sp(6, T.xfrm(300, 200, 100, 100) + `<a:custGeom><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="gd1" y="0"/></a:moveTo>
      <a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:lnTo><a:pt x="0" y="100"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>` + T.solid('FF0000'));
    const emus = T.sp(7, T.xfrm(450, 200, 200, 200) + `<a:custGeom><a:pathLst><a:path><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="914400" y="0"/></a:lnTo>
      <a:lnTo><a:pt x="914400" y="914400"/></a:lnTo><a:lnTo><a:pt x="0" y="914400"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>` + T.solid('00B050'));
    // Ink, and an equation, which PowerPoint also saves as pictures.
    const ink = `<mc:AlternateContent ${T.MC}><mc:Choice Requires="p14"><p:contentPart r:id="rId4"/></mc:Choice>
      <mc:Fallback>${T.pic(10, 'rId1', T.xfrm(40, 40, 100, 100) + T.rect)}</mc:Fallback></mc:AlternateContent>`;
    const equation = `<mc:AlternateContent ${T.MC} xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><mc:Choice Requires="a14">
      ${T.sp(11, T.xfrm(200, 40, 100, 100) + T.rect, '<a:p><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara></a14:m></a:p>')}
      </mc:Choice><mc:Fallback>${T.sp(11, T.xfrm(200, 40, 100, 100) + T.rect + '<a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>')}</mc:Fallback></mc:AlternateContent>`;
    const text = `<mc:AlternateContent ${T.MC}><mc:Choice Requires="p14">${T.textBox(12, 40, 200, 300, 50, `<a:p>${T.run('Choice text', 18)}</a:p>`)}</mc:Choice>
      <mc:Fallback>${T.textBox(12, 40, 200, 300, 50, `<a:p>${T.run('Fallback text', 18)}</a:p>`)}</mc:Fallback></mc:AlternateContent>`;
    // An embedded spreadsheet, shown by the picture saved with it.
    const ole = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="13" name="Object"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm><a:off x="${400 * E}" y="${40 * E}"/><a:ext cx="${100 * E}" cy="${100 * E}"/></p:xfrm><a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><mc:AlternateContent ${T.MC}><mc:Choice Requires="v">
      <p:oleObj name="Worksheet" r:id="rId5" progId="Excel.Sheet.12"><p:embed/></p:oleObj></mc:Choice><mc:Fallback>
      <p:oleObj name="Worksheet" r:id="rId5" progId="Excel.Sheet.12"><p:embed/>${T.pic(14, 'rId3', T.xfrm(400, 40, 100, 100) + T.rect)}</p:oleObj>
      </mc:Fallback></mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>`;
    const rels = T.relationships(['image', '../media/red.png'], ['image', '../media/green.png'], ['image', '../media/blue.png'], ['customXml', '../ink/ink1.xml'], ['oleObject', '../embeddings/oleObject1.bin']);
    const media = { 'ppt/media/red.png': await T.solidPng('#f00'), 'ppt/media/green.png': await T.solidPng('#0f0'), 'ppt/media/blue.png': await T.solidPng('#00f') };
    // Cropped by minus half its width on each side (Crop > Fit): the middle half of its frame.
    const fitted = T.pic(15, 'rId1', T.xfrm(40, 300, 200, 100) + T.rect, '<a:srcRect l="-50000" r="-50000"/>');
    // A group drawn half the size of its own coordinates, holding a freeform in its shape's EMUs, 200 points square.
    const half = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="8" name="Half"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>
      <a:off x="${40 * E}" y="${420 * E}"/><a:ext cx="${100 * E}" cy="${100 * E}"/><a:chOff x="0" y="0"/><a:chExt cx="${200 * E}" cy="${200 * E}"/></a:xfrm></p:grpSpPr>
      ${T.sp(9, T.xfrm(0, 0, 200, 200) + `<a:custGeom><a:pathLst><a:path><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="${200 * E}" y="0"/></a:lnTo>
      <a:lnTo><a:pt x="${200 * E}" y="${200 * E}"/></a:lnTo><a:lnTo><a:pt x="0" y="${200 * E}"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>` + T.solid('7030A0'))}</p:grpSp>`;
    // Flipped upside down: its text too.
    const upsideDown = T.sp(16, T.xfrm(450, 250, 200, 50, 'flipV="1"') + T.rect, `<a:p>${T.run('Upside down', 18)}</a:p>`);
    const slides = [T.slide(elbow + circle + group + formula + emus + half), T.slide(ink + equation + text + ole + fitted + upsideDown)];
    const out = await T.convert(T.deck(slides, { slideRels: { 1: rels }, parts: media }));
    if (out.error) return out;
    const a = await T.render(out.bytes, 1);
    const b = await T.render(out.bytes, 2);
    const is = (rr, x, y, c) => T.is(rr.px(x, y), c);
    return {
      leftOut: out.leftOut,
      elbow: is(a, 140, 90, T.BLACK), noBox: is(a, 240, 70, T.WHITE), arrow: is(a, 230, 136, T.BLACK),
      circle: is(a, 350, 90, T.RED), flipped: is(a, 190, 250, T.BLUE), flippedEmpty: is(a, 90, 250, T.WHITE),
      formula: is(a, 350, 250, T.WHITE), emus: is(a, 486, 236, 0x00b050), emusEnd: is(a, 600, 350, T.WHITE),
      half: is(a, 90, 470, 0x7030a0), halfEnd: is(a, 180, 470, T.WHITE),
      ink: is(b, 90, 90, T.RED), equation: is(b, 250, 90, T.GREEN), ole: is(b, 450, 90, T.BLUE),
      fitted: is(b, 140, 350, T.RED), fittedEmpty: is(b, 60, 350, T.WHITE),
      text: (await T.pages(out.bytes))[1].text, upside: (await T.word(out.bytes, 2, 'Upside'))?.angle,
    };
  });
  check('shapes deck converts', !r.error, r.error);
  check('the elbow\'s middle', r.elbow);
  check('no box around the elbow', r.noBox);
  check('its arrowhead', r.arrow);
  check('a flowchart connector is a filled circle', r.circle);
  check('the flipped group\'s square, on the right', r.flipped && r.flippedEmpty);
  check('a freeform that can\'t be drawn isn\'t a box', r.formula);
  check('a freeform in EMUs', r.emus && r.emusEnd);
  check('a freeform in EMUs in a group half its size', r.half && r.halfEnd);
  check('ink, from its saved picture', r.ink);
  check('an equation, from its saved picture', r.equation);
  check('an embedded object, from its saved picture', r.ole);
  check('a picture fitted in its frame', r.fitted && r.fittedEmpty);
  check('the choice\'s text, not the fallback\'s', r.text.includes('Choice text') && !r.text.includes('Fallback text'), r.text);
  check('text flipped upside down with its shape', r.upside === 180, r.upside);
  check('the formula freeform is the only thing skipped, quietly', r.leftOut.length === 0, r.leftOut);
}

async function placeholdersAndColourMaps(page) {
  const r = await inPage(page, async (T) => {
    const mapping = 'bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
    const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${T.NS}><p:cSld><p:spTree>${T.tree}
      ${T.sp(2, T.xfrm(40, 40, 640, 80) + T.rect, '<a:p/>', '<a:bodyPr/>', '<p:ph type="title"/>')}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" ${mapping}/>
      <p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>`;
    // A grey picture placeholder, and an oval for the body.
    const layout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${T.NS}><p:cSld><p:spTree>${T.tree}
      ${T.sp(2, T.xfrm(500, 300, 100, 100) + T.rect + T.solid('808080'), '<a:p/>', '<a:bodyPr/>', '<p:ph type="pic" idx="13"/>')}
      ${T.sp(3, T.xfrm(40, 300, 300, 200) + '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' + T.solid('00B050'), '<a:p/>', '<a:bodyPr/>', '<p:ph idx="1"/>')}
      </p:spTree></p:cSld></p:sldLayout>`;
    // The colours swapped, as a dark background style does: a black background, a white title.
    const dark = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${T.NS}><p:cSld>
      <p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${T.tree}
      ${T.sp(2, '', '<a:p><a:r><a:rPr lang="en-US"/><a:t>Dark title</a:t></a:r></a:p>', '<a:bodyPr/>', '<p:ph type="title"/>')}</p:spTree></p:cSld>
      <p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" ${mapping}/></p:clrMapOvr></p:sld>`;
    // The picture placeholder left empty, and text typed in the body.
    const plain = T.slide(T.sp(2, '', null, '', '<p:ph type="pic" idx="13"/>') + T.sp(3, '', '<a:p><a:r><a:rPr lang="en-US"/><a:t>Hi</a:t></a:r></a:p>', '<a:bodyPr/>', '<p:ph idx="1"/>'));
    const toLayout = T.relationships(['slideLayout', '../slideLayouts/slideLayout1.xml']);
    const parts = {
      'ppt/slideLayouts/slideLayout1.xml': layout,
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': T.relationships(['slideMaster', '../slideMasters/slideMaster1.xml']),
      'ppt/slideMasters/slideMaster1.xml': master,
    };
    const out = await T.convert(T.deck([dark, plain], { slideRels: { 0: toLayout, 1: toLayout }, parts }));
    if (out.error) return out;
    const first = await T.render(out.bytes, 1);
    const title = await T.word(out.bytes, 1, 'Dark');
    const second = await T.render(out.bytes, 2);
    return {
      black: T.is(first.px(700, 520), T.BLACK),
      white: title ? T.count(first, title.x, title.y - 25, 80, 25, T.WHITE) : -1,
      titleSize: title?.size, titleY: title?.y,
      empty: T.is(second.px(550, 350), T.WHITE), oval: T.is(second.px(46, 306), T.WHITE), ovalInside: T.is(second.px(190, 420), 0x00b050),
      hi: await T.word(out.bytes, 2, 'Hi'),
    };
  });
  check('layouts deck converts', !r.error, r.error);
  check('a black background from the slide\'s colour map', r.black);
  check('a white title', r.white > 50, r.white);
  check('the title takes its size from the master\'s title style and its place from the master', near(40, r.titleSize, 0.5) && r.titleY > 40 && r.titleY < 120, [r.titleSize, r.titleY]);
  check('an empty placeholder isn\'t drawn', r.empty);
  check('the layout\'s oval, not a box', r.oval && r.ovalInside);
  check('the body text in the layout\'s oval', r.hi && r.hi.x > 40 && r.hi.x < 340 && r.hi.y > 300 && r.hi.y < 500, r.hi);
}

async function directionSymbolsAnchoring(page) {
  const r = await inPage(page, async (T) => {
    const box = (id, x, y, bodyPr, paragraph) => T.sp(id, T.xfrm(x, y, 300, 300) + T.rect, paragraph, bodyPr);
    const hebrew = (text) => `<a:r><a:rPr lang="he-IL" sz="2000"/><a:t>${text}</a:t></a:r>`;
    // Aligned right in a right-to-left paragraph; Hebrew aligned left in a left-to-right one.
    const directions = T.slide(box(2, 40, 40, '<a:bodyPr/>', `<a:p><a:pPr algn="r" rtl="1"/>${hebrew('שלום עולם')}</a:p>`) +
      box(3, 380, 40, '<a:bodyPr/>', `<a:p><a:pPr algn="l"/>${hebrew('עולם שלום')}</a:p>`));
    // Wingdings' check mark from Insert > Symbol (a:sym), and typed in Wingdings; and a link, in the theme's link colour.
    const symbols = T.slide(box(2, 40, 40, '<a:bodyPr/>', '<a:p><a:r><a:rPr lang="en-US" sz="2000"><a:sym typeface="Wingdings"/></a:rPr><a:t>&#xF0FC;</a:t></a:r>' +
      '<a:r><a:rPr lang="en-US" sz="2000"><a:latin typeface="Wingdings"/></a:rPr><a:t>ü</a:t></a:r></a:p>' +
      '<a:p><a:r><a:rPr lang="en-US" sz="4000"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:hlinkClick r:id="rId9"/></a:rPr><a:t>Link</a:t></a:r></a:p>'));
    // At the bottom of their boxes, with and without space before: a first paragraph's doesn't count.
    const bottom = '<a:bodyPr anchor="b" tIns="0" bIns="0"/>';
    // As PowerPoint writes most text bodies: with what to do when the text overflows inside.
    const bottomWithAutofit = '<a:bodyPr anchor="b" tIns="0" bIns="0"><a:normAutofit/></a:bodyPr>';
    const anchored = T.slide(box(2, 40, 100, bottom, `<a:p><a:pPr><a:spcBef><a:spcPts val="2000"/></a:spcBef></a:pPr>${T.run('Alpha', 20)}</a:p>`) +
      box(3, 380, 100, bottomWithAutofit, `<a:p>${T.run('Beta', 20)}</a:p>`));
    const out = await T.convert(T.deck([directions, symbols, anchored]));
    if (out.error) return out;
    const glyphs = (await T.glyphs(out.bytes, 1)).filter((g) => /[\u05d0-\u05ea]/.test(g.str));
    const rtl = glyphs.filter((g) => g.x < 360);
    const ltr = glyphs.filter((g) => g.x >= 360);
    const links = await T.render(out.bytes, 2);
    const link = await T.word(out.bytes, 2, 'Link');
    let blue = 0;
    if (link) for (let x = 0; x < 60; x++) for (let y = 0; y < 25; y++) if (T.is(links.px(link.x + x, link.y - y), 0x0563c1)) blue++;
    return {
      rtlRight: Math.max(...rtl.map((g) => g.x + g.width)), ltrLeft: Math.min(...ltr.map((g) => g.x)),
      text: (await T.pages(out.bytes))[1].text, blue,
      beta: (await T.word(out.bytes, 3, 'Beta'))?.y, alpha: (await T.word(out.bytes, 3, 'Alpha'))?.y,
    };
  });
  check('text deck converts', !r.error, r.error);
  check('right to left: 7.2 points in from the right of the first box', near(340 - 7.2, r.rtlRight, 3), r.rtlRight);
  check('Hebrew in a left-to-right paragraph: 7.2 points in from the left of the second', near(380 + 7.2, r.ltrLeft, 3), r.ltrLeft);
  check('Wingdings check marks, from a:sym and typed', (r.text.match(/✓/g) ?? []).length === 2, r.text);
  check('the link in the theme\'s link colour', r.blue > 20, r.blue);
  check('anchored at the bottom: a first paragraph\'s space before doesn\'t count', near(r.beta, r.alpha), [r.alpha, r.beta]);
  check('at the bottom of the box', r.alpha > 370 && r.alpha < 400, r.alpha);
}

async function verticalText(page) {
  const r = await inPage(page, async (T) => {
    // Insert > Text Box > Vertical, as PowerPoint writes it: a narrow box that grows with its text.
    const vertical = '<a:bodyPr vert="eaVert" wrap="none"><a:spAutoFit/></a:bodyPr>';
    const japanese = '<a:p><a:r><a:rPr lang="ja-JP" sz="2000"/><a:t>縦書き</a:t></a:r></a:p>';
    const up = '<a:bodyPr vert="vert270"/>';
    const slide = T.slide(T.sp(2, T.xfrm(40, 40, 30, 200) + T.rect, japanese, vertical) +
      T.sp(3, T.xfrm(200, 40, 30, 200) + T.rect, `<a:p>${T.run('Sideways', 20)}</a:p>`, vertical) +
      T.sp(4, T.xfrm(400, 40, 30, 200) + T.rect, `<a:p>${T.run('Upwards', 20)}</a:p>`, up));
    const out = await T.convert(T.deck([slide]));
    if (out.error) return out;
    return await T.glyphs(out.bytes, 1);
  });
  check('vertical deck converts', !r.error, r.error);
  const upright = r.filter((g) => g.angle === 0);
  const turned = r.filter((g) => g.str.includes('Sideways'));
  const up = r.filter((g) => g.str.includes('Upwards'));
  check('Japanese stays upright', upright.map((g) => g.str).join('').replace(/\s/g, '') === '縦書き', upright);
  check('one character under the other', new Set(upright.filter((g) => /\S/.test(g.str)).map((g) => Math.round(g.y))).size === 3, upright);
  check('Latin letters read down the page: turned a quarter clockwise', turned.length === 1 && turned[0].angle === 270, turned);
  check('vert270 reads up the page', up.length === 1 && up[0].angle === 90, up);
}

async function tablesAndMergedCells(page) {
  const r = await inPage(page, async (T) => {
    const E = T.EMU;
    const id = '{5C22544A-0000-0000-0000-000000000001}';
    const ln = (hex) => `<a:ln w="${3 * E}">${T.solid(hex)}</a:ln>`;
    // Red at the table's top and bottom, green between rows; the last column blue.
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="${T.A}" def="${id}"><a:tblStyle styleId="${id}" styleName="Test">
      <a:wholeTbl><a:tcStyle><a:tcBdr><a:top>${ln('FF0000')}</a:top><a:bottom>${ln('FF0000')}</a:bottom><a:insideH>${ln('00B050')}</a:insideH></a:tcBdr>
      <a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl><a:lastCol><a:tcStyle><a:tcBdr/><a:fill>${T.solid('0000FF')}</a:fill></a:tcStyle></a:lastCol>
      </a:tblStyle></a:tblStyleLst>`;
    const cell = (text, attributes = '', tcPr = '<a:tcPr/>') => `<a:tc ${attributes}><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${text != null ? T.run(text, 18) : ''}</a:p></a:txBody>${tcPr}</a:tc>`;
    // A header merged across two columns, and a cell merged down two rows.
    const rows = [
      cell('Head', 'gridSpan="2"') + cell(null, 'hMerge="1"') + cell('Last'),
      cell('Merged', 'rowSpan="2"', '<a:tcPr anchor="ctr"/>') + cell('b1') + cell('c1'),
      cell(null, 'vMerge="1"') + cell('b2') + cell('c2'),
      cell('a3') + cell('b3') + cell('c3'),
    ].map((row) => `<a:tr h="${40 * E}">${row}</a:tr>`).join('');
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm><a:off x="${40 * E}" y="${40 * E}"/><a:ext cx="${300 * E}" cy="${160 * E}"/></p:xfrm><a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr lastCol="1"><a:tableStyleId>${id}</a:tableStyleId></a:tblPr>
      <a:tblGrid>${`<a:gridCol w="${100 * E}"/>`.repeat(3)}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    // The same table right to left, its first column on the right.
    const rtl = table.replace('<a:tblPr lastCol="1">', '<a:tblPr lastCol="1" rtl="1">');
    // A table whose style isn't in the file: PowerPoint's default look (Medium Style 2, Accent 1).
    const unknown = table.replace(`<a:tableStyleId>${id}</a:tableStyleId>`, '<a:tableStyleId>{00000000-0000-0000-0000-000000000000}</a:tableStyleId>').replace('lastCol="1"', 'firstRow="1" bandRow="1"');
    const out = await T.convert(T.deck([T.slide(table), T.slide(rtl), T.slide(unknown)], { more: [['tableStyles', 'tableStyles.xml']], parts: { 'ppt/tableStyles.xml': styles } }));
    if (out.error) return out;
    const p1 = await T.render(out.bytes, 1);
    const p2 = await T.render(out.bytes, 2);
    const p3 = await T.render(out.bytes, 3);
    const is = (rr, x, y, c) => T.is(rr.px(x, y), c);
    return {
      top: is(p1, 190, 40, T.RED), inside1: is(p1, 190, 80, 0x00b050), inside2: is(p1, 190, 120, 0x00b050),
      noLine: is(p1, 130, 120, T.WHITE), bottom: is(p1, 190, 200, T.RED), last: is(p1, 290, 100, T.BLUE),
      merged: (await T.word(out.bytes, 1, 'Merged'))?.y, texts: (await T.pages(out.bytes)).map((p) => p.text),
      mirrored: is(p2, 90, 100, T.BLUE), mergedRtl: (await T.word(out.bytes, 2, 'Merged'))?.x,
      header: p3.px(150, 60), band1: p3.px(150, 100), band2: p3.px(150, 140), headWord: await T.word(out.bytes, 3, 'Head'),
      headInk: T.count(p3, 47, 46, 40, 20, T.WHITE),
    };
  });
  check('table deck converts', !r.error, r.error);
  check('the table\'s top', r.top);
  check('between rows, the inside line', r.inside1 && r.inside2);
  check('no line across the merged cell', r.noLine);
  check('the table\'s bottom', r.bottom);
  check('the last column, the merged header counted once', r.last);
  check('the merged cell\'s text in the middle of its two rows', r.merged > 115, r.merged);
  check('every cell\'s text', ['Head', 'Last', 'Merged', 'b1', 'c2', 'a3', 'c3'].every((w) => r.texts[0].includes(w)), r.texts[0]);
  check('right to left: the last column on the left', r.mirrored);
  check('right to left: the first column on the right', r.mergedRtl > 240, r.mergedRtl);
  check('a style not in the file: an accent-coloured header row', r.header[2] > 150 && r.header[0] < 110, r.header);
  check('banded rows, the first band darker', r.band1[0] < r.band2[0] && r.band2[2] > 200, [r.band1, r.band2]);
  check('the header in bold white', r.headInk > 10, r.headInk);
}

async function groupFillAndNumbering(page) {
  const r = await inPage(page, async (T) => {
    // The square is filled as its red group is (a:grpFill), not in its style's accent colour.
    const style = `<p:style><a:lnRef idx="0"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>
      <a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>`;
    const square = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Square"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>${T.xfrm(100, 100, 100, 100)}${T.rect}<a:grpFill/></p:spPr>${style}</p:sp>`;
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>${T.xfrm(100, 100, 100, 100)}${T.solid('FF0000')}</p:grpSpPr>${square}</p:grpSp>`;
    // A shape filled in its style's accent colour, its text in the style's font colour (white).
    const styled = `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Styled"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>${T.xfrm(300, 100, 200, 100)}${T.rect}</p:spPr>${style}<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>${T.run('Styled', 28)}</a:p></p:txBody></p:sp>`;
    const fill = await T.convert(T.deck([T.slide(group + styled)]));
    const item = (text) => `<a:p><a:pPr marL="342900" indent="-342900"><a:buAutoNum type="arabicPeriod"/></a:pPr>${text ? T.run(text, 18) : ''}</a:p>`;
    const numbered = await T.convert(T.deck([T.slide(T.textBox(2, 40, 40, 400, 300, item('Apples'), item(''), item('Pears')))]));
    // Other schemes, a start number, a deeper level starting over, bullets from symbol fonts.
    const scheme = (type, text, extra = '', lvl = 0) => `<a:p><a:pPr lvl="${lvl}" marL="${342900 * (lvl + 1)}" indent="-342900"><a:buAutoNum type="${type}" ${extra}/></a:pPr>${T.run(text, 18)}</a:p>`;
    const bullet = (font, char, text) => `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="${font}"/><a:buChar char="${char}"/></a:pPr>${T.run(text, 18)}</a:p>`;
    const lists = await T.convert(T.deck([T.slide(T.textBox(2, 40, 40, 600, 480,
      scheme('alphaLcParenR', 'Cherries'), scheme('alphaLcParenR', 'Grapes'), scheme('romanUcPeriod', 'Kiwis', '', 1), scheme('romanUcPeriod', 'Limes', '', 1),
      scheme('alphaLcParenR', 'Mangoes'), scheme('arabicParenBoth', 'Nectarines', 'startAt="7"'),
      bullet('Wingdings', '§', 'Square'), bullet('Symbol', '·', 'Dot'), `<a:p><a:pPr marL="342900" indent="-342900"><a:buNone/></a:pPr>${T.run('Plain', 18)}</a:p>`,
      scheme('arabicParenBoth', 'Plums', 'startAt="7"')))]));
    const r = await T.render(fill.bytes, 1);
    const styledWord = await T.word(fill.bytes, 1, 'Styled');
    return {
      red: T.is(r.px(150, 150), T.RED), accent: T.is(r.px(310, 110), 0x4472c4),
      white: styledWord ? T.count(r, styledWord.x, styledWord.y - 18, 70, 18, T.WHITE) : -1,
      styledCenter: styledWord ? styledWord.x + styledWord.width / 2 : null,
      numbered: (await T.pages(numbered.bytes))[0].text, lists: (await T.pages(lists.bytes))[0].text,
      errors: [fill.error, numbered.error, lists.error].filter(Boolean),
    };
  });
  check('group fill and numbering decks convert', !r.errors.length, r.errors);
  check('a shape takes its group\'s fill', r.red);
  check('a shape takes its style\'s fill colour', r.accent);
  check('its text takes its style\'s font colour', r.white > 30, r.white);
  check('centred in its shape', near(400, r.styledCenter, 6), r.styledCenter);
  check('numbering goes on after an empty paragraph', /1\.\s*Apples/.test(r.numbered) && /2\.\s*Pears/.test(r.numbered), r.numbered);
  check('letters with a closing parenthesis', /a\)\s*Cherries/.test(r.lists) && /b\)\s*Grapes/.test(r.lists), r.lists);
  check('a deeper level counts on its own, in capital roman numerals', /I\.\s*Kiwis/.test(r.lists) && /II\.\s*Limes/.test(r.lists), r.lists);
  check('a level up goes on counting', /c\)\s*Mangoes/.test(r.lists), r.lists);
  // As in the app, a list goes on counting at its level whatever its scheme; its start number counts
  // only once a paragraph without a number has ended it.
  check('a numbered list goes on counting in another scheme', /\(4\)\s*Nectarines/.test(r.lists), r.lists);
  check('a start number in parentheses, after a paragraph without a number', /Plain\s*\(7\)\s*Plums/.test(r.lists), r.lists);
  check('Wingdings and Symbol bullets as the characters they show', /▪\s*Square/.test(r.lists) && /•\s*Dot/.test(r.lists), r.lists);
  check('no bullet', /Dot\s*Plain/.test(r.lists), r.lists);
}

async function damagedPartsAndNesting(page) {
  const r = await inPage(page, async (T) => {
    const E = T.EMU;
    // A chart whose part is empty, and a table whose styles' part is: the rest of the slide still converts.
    const chart = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm><a:off x="${40 * E}" y="${300 * E}"/><a:ext cx="${200 * E}" cy="${100 * E}"/></p:xfrm><a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1"/>
      </a:graphicData></a:graphic></p:graphicFrame>`;
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm><a:off x="${40 * E}" y="${120 * E}"/><a:ext cx="${200 * E}" cy="${40 * E}"/></p:xfrm><a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr><a:tableStyleId>{5C22544A-0000-0000-0000-000000000002}</a:tableStyleId></a:tblPr>
      <a:tblGrid><a:gridCol w="${200 * E}"/></a:tblGrid><a:tr h="${40 * E}"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${T.run('Cell words', 18)}</a:p></a:txBody><a:tcPr/></a:tc></a:tr>
      </a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    // A picture whose part isn't a picture: a grey box in its place.
    const broken = T.pic(5, 'rId2', T.xfrm(400, 300, 100, 100) + T.rect);
    const damaged = await T.convert(T.deck([T.slide(T.textBox(2, 40, 40, 300, 40, `<a:p>${T.run('Still here', 18)}</a:p>`) + chart + table + broken)], {
      slideRels: { 0: T.relationships(['chart', '../charts/chart1.xml'], ['image', '../media/broken.png']) }, more: [['tableStyles', 'tableStyles.xml']],
      parts: { 'ppt/charts/chart1.xml': '', 'ppt/tableStyles.xml': '', 'ppt/media/broken.png': 'not a picture' },
    }));
    const render = damaged.bytes ? await T.render(damaged.bytes, 1) : null;
    // Groups 1,000 deep: what's deeper than the XML reader goes is left out, and the rest converts.
    const group = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
    const depth = 1000;
    const nested = await T.convert(T.deck([T.slide(group.repeat(depth) + T.textBox(2, 36, 36, 300, 72, `<a:p>${T.run('Deep', 18)}</a:p>`) + '</p:grpSp>'.repeat(depth) +
      T.textBox(3, 36, 136, 300, 72, `<a:p>${T.run('Shallow', 18)}</a:p>`))]));
    return {
      error: damaged.error ?? nested.error,
      text: damaged.bytes ? (await T.pages(damaged.bytes))[0].text : '',
      grey: render ? render.px(450, 350) : null, greyEdge: render ? render.px(400.2, 350) : null,
      chartBox: render ? render.px(140, 350) : null,
      nested: nested.bytes ? (await T.pages(nested.bytes))[0].text : '',
    };
  });
  check('damaged parts of shapes leave out only what is in them', !r.error && r.text.includes('Still here') && r.text.includes('Cell words'), r);
  check('a picture that can\'t be decoded is a light grey box', r.grey.every((v) => v > 230 && v < 250), r.grey);
  check('a chart whose part is damaged is a grey box', r.chartBox.every((v) => v > 230 && v < 250), r.chartBox);
  check('groups nested 1,000 deep: the rest converts', r.nested.includes('Shallow') && !r.nested.includes('Deep'), r.nested);
}

async function refusedFiles(page) {
  const r = await inPage(page, async (T) => {
    const compound = new Uint8Array(2048 + 8);
    compound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const locked = compound.slice();
    const name = new TextEncoder().encode('EncryptedPackage');
    for (let i = 0; i < name.length; i++) locked[1000 + 2 * i] = name[i];
    const docx = T.zip({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      '_rels/.rels': T.relationships(['officeDocument', 'word/document.xml']),
      'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    });
    const brokenSlide = T.deck(['<p:sld><p:cSld><p:spTree>']);
    const brokenTheme = T.deck([T.slide(T.textBox(2, 40, 40, 300, 40, `<a:p>${T.run('Hi', 18)}</a:p>`))], {
      slideRels: { 0: T.relationships(['slideLayout', '../slideLayouts/slideLayout1.xml']) },
      parts: {
        'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${T.NS}><p:cSld><p:spTree>${T.tree}</p:spTree></p:cSld></p:sldLayout>`,
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels': T.relationships(['slideMaster', '../slideMasters/slideMaster1.xml']),
        'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${T.NS}><p:cSld><p:spTree>${T.tree}</p:spTree></p:cSld></p:sldMaster>`,
        'ppt/slideMasters/_rels/slideMaster1.xml.rels': T.relationships(['theme', '../theme/theme1.xml']),
        'ppt/theme/theme1.xml': '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements>',
      },
    });
    const entities = T.deck([`<?xml version="1.0"?><!DOCTYPE p:sld [<!ENTITY lol "lol">]>` + T.slide('').replace(/^<\?xml[^>]*\?>/, '').trim()]);
    const results = {
      legacy: await T.convert(compound, { file: 'old.ppt' }),
      encrypted: await T.convert(locked),
      word: await T.convert(docx, { file: 'notes.pptx' }),
      text: await T.convert(new TextEncoder().encode('Just some text, not a presentation at all.')),
      tiny: await T.convert(new Uint8Array(3)),
      hidden: await T.convert(await T.presentation(true)),
      none: await T.convert(T.deck([])),
      missing: await T.convert(T.deck([T.slide('')]).slice(0, 0)),
      brokenSlide: await T.convert(brokenSlide),
      brokenTheme: await T.convert(brokenTheme),
      entities: await T.convert(entities),
    };
    // A slide whose part is missing is left out, as one that's hidden.
    const zip = T.fflate.unzipSync(T.deck([T.slide(T.textBox(2, 40, 40, 300, 40, `<a:p>${T.run('Kept', 18)}</a:p>`)), T.slide('')]));
    delete zip['ppt/slides/slide2.xml'];
    const withMissing = await T.convert(T.fflate.zipSync(zip));
    results.missingPart = { pages: withMissing.pageCount, error: withMissing.error };
    const out = {};
    for (const [k, v] of Object.entries(results)) out[k] = v.error ?? v;
    return out;
  });
  check('an old .ppt file', r.legacy.key === 'office_legacy_powerpoint' && r.legacy.manyKey === 'office_legacy_powerpoint_many', r.legacy);
  check('a password-protected presentation', r.encrypted.key === 'office_encrypted' && r.encrypted.manyKey === 'office_encrypted_many', r.encrypted);
  check('a Word document picked as a presentation', r.word.key === 'office_not_powerpoint' && r.word.manyKey === 'office_not_powerpoint_many', r.word);
  check('a text file', r.text.key === 'office_not_powerpoint', r.text);
  check('three bytes', r.tiny.key === 'office_not_powerpoint', r.tiny);
  check('only hidden slides', r.hidden.key === 'office_no_slides' && r.hidden.manyKey === 'office_no_slides_many', r.hidden);
  check('no slides at all', r.none.key === 'office_no_slides', r.none);
  check('an empty file', r.missing.key === 'office_not_powerpoint', r.missing);
  check('a slide that isn\'t well-formed XML fails the conversion', r.brokenSlide.key === 'office_convert_failed', r.brokenSlide);
  check('a damaged theme fails the conversion, as in the app', r.brokenTheme.key === 'office_convert_failed', r.brokenTheme);
  check('XML declaring entities is refused', r.entities.key === 'office_convert_failed', r.entities);
  check('a slide whose part is missing is left out', r.missingPart.pages === 1 && !r.missingPart.error, r.missingPart);
}

async function autofit(page) {
  const r = await inPage(page, async (T) => {
    const lines = Array.from({ length: 10 }, (_, i) => `<a:p>${T.run(`Line ${i + 1} of the list`, 24)}</a:p>`).join('');
    const box = (id, x, bodyPr) => T.sp(id, T.xfrm(x, 40, 300, 100) + T.rect + `<a:ln w="12700">${T.solid('000000')}</a:ln>`, lines, bodyPr);
    const shrink = await T.convert(T.deck([T.slide(box(2, 40, '<a:bodyPr><a:normAutofit/></a:bodyPr>') + box(3, 380, '<a:bodyPr><a:noAutofit/></a:bodyPr>'))]));
    // PowerPoint's own scale, saved with the file, is where shrinking starts: here it fits at once.
    const saved = await T.convert(T.deck([T.slide(T.sp(2, T.xfrm(40, 40, 400, 200) + T.rect, `<a:p>${T.run('Half size', 40)}</a:p>`, '<a:bodyPr><a:normAutofit fontScale="50000" lnSpcReduction="20000"/></a:bodyPr>'))]));
    const glyphs = await T.glyphs(shrink.bytes, 1);
    const left = glyphs.filter((g) => g.x < 360);
    const right = glyphs.filter((g) => g.x >= 360);
    return {
      error: shrink.error ?? saved.error,
      leftSizes: [...new Set(left.map((g) => Math.round(g.size * 10) / 10))], leftBottom: Math.max(...left.map((g) => g.y)), leftCount: left.length,
      rightSizes: [...new Set(right.map((g) => Math.round(g.size * 10) / 10))], rightBottom: Math.max(...right.map((g) => g.y)),
      text: (await T.pages(shrink.bytes))[0].text,
      half: (await T.word(saved.bytes, 1, 'Half'))?.size,
    };
  });
  check('autofit decks convert', !r.error, r.error);
  check('text too long for its box is shrunk', r.leftSizes.length === 1 && r.leftSizes[0] < 24 && r.leftSizes[0] > 24 * 0.3, r.leftSizes);
  check('until it fits', r.leftBottom < 140, r.leftBottom);
  check('all of it still there', r.text.includes('Line 10 of the list') && (r.text.match(/Line 10 of the list/g) ?? []).length === 2, r.text);
  check('without autofit it overflows at its size', r.rightSizes.length === 1 && near(24, r.rightSizes[0], 0.1) && r.rightBottom > 200, [r.rightSizes, r.rightBottom]);
  check('the font scale PowerPoint saved', near(20, r.half, 0.3), r.half);
}

async function backgroundsAndMasters(page) {
  const r = await inPage(page, async (T) => {
    const master = (bg, shapes) => `<p:sldMaster ${T.NS}><p:cSld>${bg}<p:spTree>${T.tree}${shapes}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`;
    const layout = (attrs, bg, shapes) => `<p:sldLayout ${T.NS} ${attrs}><p:cSld>${bg}<p:spTree>${T.tree}${shapes}</p:spTree></p:cSld></p:sldLayout>`;
    const bg = (fill) => `<p:bg><p:bgPr>${fill}<a:effectLst/></p:bgPr></p:bg>`;
    // The master: a light green background, a red logo square in the corner; its theme's accent1 is orange.
    const theme = `<a:theme xmlns:a="${T.A}" name="T"><a:themeElements><a:clrScheme name="C"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="FF8000"/></a:accent1></a:clrScheme>
      <a:fontScheme name="F"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Courier New"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
    const logo = T.sp(9, T.xfrm(680, 500, 30, 30) + T.rect + T.solid('FF0000'));
    const accent = T.sp(10, T.xfrm(600, 500, 30, 30) + T.rect + '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>');
    const parts = {
      'ppt/slideMasters/slideMaster1.xml': master(bg(T.solid('CCFFCC')), logo + accent),
      'ppt/slideMasters/_rels/slideMaster1.xml.rels': T.relationships(['theme', '../theme/theme1.xml']),
      'ppt/theme/theme1.xml': theme,
      'ppt/slideLayouts/slideLayout1.xml': layout('', '', ''),
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': T.relationships(['slideMaster', '../slideMasters/slideMaster1.xml']),
      // A layout without the master's shapes, with a blue band of its own.
      'ppt/slideLayouts/slideLayout2.xml': layout('showMasterSp="0"', bg('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>'),
        T.sp(8, T.xfrm(0, 0, 720, 20) + T.rect + T.solid('0000FF'))),
      'ppt/slideLayouts/_rels/slideLayout2.xml.rels': T.relationships(['slideMaster', '../slideMasters/slideMaster1.xml']),
      'ppt/media/bg.png': await T.png(40, 30, (ctx) => { ctx.fillStyle = '#ff0'; ctx.fillRect(0, 0, 40, 30); ctx.fillStyle = '#f0f'; ctx.fillRect(20, 0, 20, 30); }),
    };
    const toLayout = (n, extra = []) => T.relationships(['slideLayout', `../slideLayouts/slideLayout${n}.xml`], ...extra);
    const text = (t) => T.textBox(2, 40, 200, 600, 60, `<a:p>${T.run(t, 24)}</a:p>`);
    const slides = [
      T.slide(text('Master look')),
      T.slide(text('Own background'), { bg: bg(T.solid('FFFF00')) }),
      T.slide(text('Layout gradient')),
      T.slide(text('No master shapes'), { attrs: 'showMasterSp="0"' }),
      T.slide(text('Picture background'), { bg: bg('<a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>') }),
    ];
    const out = await T.convert(T.deck(slides, { slideRels: { 0: toLayout(1), 1: toLayout(1), 2: toLayout(2), 3: toLayout(1), 4: toLayout(1, [['image', '../media/bg.png']]) }, parts }));
    if (out.error) return out;
    const p = [];
    for (let i = 1; i <= 5; i++) p.push(await T.render(out.bytes, i));
    const word = await T.word(out.bytes, 1, 'Master');
    return {
      leftOut: out.leftOut,
      masterBg: p[0].px(100, 100), logo: T.is(p[0].px(695, 515), T.RED), accent: p[0].px(615, 515),
      ownBg: T.is(p[1].px(100, 100), 0xffff00), ownLogo: T.is(p[1].px(695, 515), T.RED),
      gradLeft: p[2].px(5, 300), gradRight: p[2].px(715, 300), band: T.is(p[2].px(300, 10), T.BLUE), noLogo: !T.is(p[2].px(695, 515), T.RED),
      hidden: T.is(p[3].px(695, 515), 0xccffcc), hiddenBg: T.is(p[3].px(100, 100), 0xccffcc),
      picLeft: T.is(p[4].px(100, 300), 0xffff00), picRight: T.is(p[4].px(600, 300), 0xff00ff),
      font: word ? (await (async () => {
        const pdf = await T.pdfjs.openPdfJs(out.bytes);
        const pg = await pdf.getPage(1);
        const tc = await pg.getTextContent();
        const item = tc.items.find((i) => i.str.includes('Master'));
        const name = tc.styles[item.fontName]?.fontFamily;
        await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
        return name;
      })()) : null,
    };
  });
  check('backgrounds deck converts', !r.error, r.error);
  check('the master\'s background', T_is(r.masterBg, 0xccffcc), r.masterBg);
  check('the master\'s shapes on each slide', r.logo);
  check('scheme colours from the master\'s theme', T_is(r.accent, 0xff8000), r.accent);
  check('a slide\'s own background', r.ownBg && r.ownLogo);
  check('a layout\'s gradient background, left to right', T_is(r.gradLeft, 0xff0000) && T_is(r.gradRight, 0x0000ff), [r.gradLeft, r.gradRight]);
  check('a layout\'s own shapes, without the master\'s', r.band && r.noLogo);
  check('a slide without master shapes', r.hidden && r.hiddenBg);
  check('a picture background stretched over the slide', r.picLeft && r.picRight);
  check('the theme\'s body font for text without one (Courier New: monospace)', /mono/i.test(r.font ?? '') || r.font === 'monospace', r.font);
  check('nothing left out', r.leftOut.length === 0, r.leftOut);
}

function T_is(rgb, hex) {
  const want = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  return Array.isArray(rgb) && rgb.every((v, i) => Math.abs(v - want[i]) < 60);
}

async function rotationAndPictures(page) {
  const r = await inPage(page, async (T) => {
    // A 200 × 50 bar turned a quarter: it stands upright about its centre (200, 125), its text turned with it.
    const bar = T.sp(2, T.xfrm(100, 100, 200, 50, 'rot="5400000"') + T.rect + T.solid('0000FF'), `<a:p><a:pPr algn="ctr"/>${T.run('Turned', 18)}</a:p>`, '<a:bodyPr anchor="ctr"/>');
    // A picture cropped to its right half (blue), and one flipped left to right (blue on the left).
    const halves = await T.png(40, 20, (ctx) => { ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 20, 20); ctx.fillStyle = '#00f'; ctx.fillRect(20, 0, 20, 20); });
    const cropped = T.pic(3, 'rId1', T.xfrm(400, 40, 200, 100) + T.rect, '<a:srcRect l="50000"/>');
    const flipped = T.pic(4, 'rId1', T.xfrm(400, 200, 200, 100, 'flipH="1"') + T.rect);
    // A picture in an oval frame, and one hidden in the selection pane.
    const oval = T.pic(5, 'rId1', T.xfrm(400, 360, 200, 100) + '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>');
    const hidden = T.sp(6, T.xfrm(40, 400, 100, 100) + T.rect + T.solid('FF0000')).replace('name="Shape 6"', 'name="Shape 6" hidden="1"');
    // A large photo-like picture shown 2 inches wide: decoded no larger than 150 pixels per inch, stored as JPEG.
    const photo = await T.png(2000, 1500, (ctx) => {
      ctx.fillStyle = 'rgb(90,140,60)';
      ctx.fillRect(0, 0, 2000, 1500);
      for (let i = 0; i < 300; i++) {
        ctx.fillStyle = `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256})`;
        ctx.beginPath();
        ctx.arc((i * 997) % 2000, (i * 613) % 1500, 30 + (i % 150), 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    const big = T.pic(7, 'rId2', T.xfrm(40, 250, 144, 108) + T.rect);
    const out = await T.convert(T.deck([T.slide(bar + cropped + flipped + oval + hidden), T.slide(big)], {
      slideRels: { 0: T.relationships(['image', '../media/halves.png']), 1: T.relationships(['image', '../media/halves.png'], ['image', '../media/photo.png']) },
      parts: { 'ppt/media/halves.png': halves, 'ppt/media/photo.png': photo },
    }));
    if (out.error) return out;
    const p = await T.render(out.bytes, 1);
    const doc = await T.lib.PDFDocument.load(out.bytes);
    const images = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const dict = obj?.dict;
      if (dict?.get(T.lib.PDFName.of('Subtype'))?.toString() !== '/Image') continue;
      images.push({ width: dict.get(T.lib.PDFName.of('Width'))?.asNumber(), filter: dict.get(T.lib.PDFName.of('Filter'))?.toString() });
    }
    return {
      upright: T.is(p.px(200, 40), T.BLUE), notAcross: T.is(p.px(110, 125), T.WHITE),
      turned: (await T.word(out.bytes, 1, 'Turned'))?.angle,
      cropLeft: T.is(p.px(410, 90), T.BLUE), cropRight: T.is(p.px(590, 90), T.BLUE),
      flipLeft: T.is(p.px(420, 250), T.BLUE), flipRight: T.is(p.px(580, 250), T.RED),
      ovalCorner: T.is(p.px(405, 365), T.WHITE), ovalInside: T.is(p.px(450, 410), T.RED),
      hidden: T.is(p.px(90, 450), T.WHITE),
      images, size: out.bytes.length,
    };
  });
  check('rotation deck converts', !r.error, r.error);
  check('a shape turned a quarter stands upright about its centre', r.upright && r.notAcross);
  check('its text turned with it (reading down)', r.turned === 270, r.turned);
  check('a picture cropped to its right half', r.cropLeft && r.cropRight);
  check('a picture flipped left to right', r.flipLeft && r.flipRight);
  check('a picture in an oval frame', r.ovalCorner && r.ovalInside);
  check('a hidden shape isn\'t drawn', r.hidden);
  const photo = r.images.find((i) => i.width > 100);
  check('a large picture is decoded smaller and stored as JPEG', photo && photo.width <= 300 * 1.25 && photo.filter === '/DCTDecode', r.images);
  check('the small picture stored once for three frames at one size... or per size shown', r.images.filter((i) => i.width <= 100).length <= 4, r.images);
  check('the PDF stays small', r.size < 200000, r.size);
}

async function fontsSubsetted(page) {
  const r = await inPage(page, async (T) => {
    const out = await T.convert(T.deck([T.slide(T.textBox(2, 40, 40, 600, 100, `<a:p>${T.run('Hello', 24)}</a:p>`))]));
    const doc = await T.lib.PDFDocument.load(out.bytes);
    const fonts = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const dict = obj?.dict;
      if (!dict) continue;
      if (dict.get(T.lib.PDFName.of('Length1')) || obj.constructor.name.includes('Stream') && dict.get(T.lib.PDFName.of('Subtype'))?.toString() === '/OpenType') fonts.push(obj.contents?.length ?? 0);
    }
    return { size: out.bytes.length, fonts };
  });
  check('only the letters used are embedded: the PDF of one word is small', r.size < 30000, r.size);
  check('its font file is a small subset', r.fonts.length >= 1 && r.fonts.every((n) => n < 20000), r.fonts);
}

async function progressCancelAndLargeDecks(page) {
  const r = await inPage(page, async (T) => {
    const slides = [];
    for (let i = 0; i < 120; i++) {
      const paras = Array.from({ length: 12 }, (_, k) => `<a:p><a:pPr marL="342900" indent="-342900"><a:buChar char="•"/></a:pPr>${T.run(`Slide ${i + 1}, point ${k + 1}: some words to lay out on the line`, 14)}</a:p>`).join('');
      const shapes = Array.from({ length: 20 }, (_, k) => T.sp(10 + k, T.xfrm(20 + k * 30, 480, 25, 25) + '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' + T.solid('336699'))).join('');
      slides.push(T.slide(T.textBox(2, 40, 40, 640, 420, paras) + shapes));
    }
    const bytes = T.deck(slides);
    // The longest the page goes without letting the browser handle input: between two timer ticks,
    // or, where the page yields with scheduler.yield() (whose turn comes before timers'), between yields.
    let last = performance.now();
    let worst = 0;
    const tick = () => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; };
    const real = globalThis.scheduler?.yield?.bind(globalThis.scheduler);
    if (real) globalThis.scheduler.yield = () => { tick(); return real().then(() => { last = performance.now(); }); };
    const timer = setInterval(tick, 10);
    const t0 = performance.now();
    const out = await T.convert(bytes, { file: 'large.pptx' });
    const ms = performance.now() - t0;
    clearInterval(timer);
    if (real) globalThis.scheduler.yield = real;
    const controller = new AbortController();
    const cancelled = await T.convert(bytes, {}, { signal: controller.signal, onProgress: (done) => { if (done >= 3) controller.abort(); } });
    return { pages: out.pageCount, error: out.error, ms, worst, cancelled: cancelled.error, last: (await T.pages(out.bytes)).at(-1).text.slice(0, 40), progress: out.progress.length };
  });
  check('a 120-slide deck converts', !r.error && r.pages === 120, r);
  check('every slide in place', r.last.includes('Slide 120, point 1'), r.last);
  check('progress for each slide and the save', r.progress === 121, r.progress);
  check('the page stays responsive (no pause over 200 ms)', r.worst < 200, `${Math.round(r.worst)} ms, ${Math.round(r.ms)} ms in all`);
  check('cancelling stops the conversion', r.cancelled?.name === 'CancelledError', r.cancelled);
  console.log(`  120 slides in ${Math.round(r.ms)} ms, longest pause ${Math.round(r.worst)} ms`);
}

async function hostileValues(page) {
  const r = await inPage(page, async (T) => {
    const E = T.EMU;
    // Sizes no presentation has, negative and enormous shapes, a rotation past a turn, a table with
    // thousands of columns claimed and none given: the slide still converts.
    const huge = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Huge"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="99999999"><a:off x="-9000000000000" y="5"/><a:ext cx="9000000000000000" cy="-5"/></a:xfrm>${T.rect}${T.solid('FF0000')}</p:spPr>
      <p:txBody><a:bodyPr lIns="-99999999999" wrap="none"><a:normAutofit fontScale="1%"/></a:bodyPr><a:lstStyle/><a:p><a:pPr lvl="99" marL="-999999999999" indent="99999999999"><a:buAutoNum type="nonsense" startAt="-5"/></a:pPr>${T.run('Odd', 18)}</a:p></p:txBody></p:sp>`;
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm><a:off x="${40 * E}" y="${300 * E}"/><a:ext cx="${200 * E}" cy="${40 * E}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
      <a:tbl><a:tblGrid/><a:tr h="-5"><a:tc gridSpan="999999" rowSpan="999999"><a:txBody><a:bodyPr/><a:p>${T.run('Wide', 12)}</a:p></a:txBody></a:tc><a:tc vMerge="1"/></a:tr><a:tr/></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const ok = T.textBox(4, 40, 40, 300, 40, `<a:p>${T.run('Fine', 18)}</a:p>`);
    const odd = await T.convert(T.deck([T.slide(huge + table + ok)]));
    const tiny = await T.convert(T.deck([T.slide(ok)], { size: [1, 1] }));
    const big = await T.convert(T.deck([T.slide(ok)], { size: [99999, 99999] }));
    const first = async (out) => (out.bytes ? (await T.pages(out.bytes))[0] : null);
    return { error: odd.error ?? tiny.error ?? big.error, odd: await first(odd), tiny: await first(tiny), big: await first(big), leftOut: odd.leftOut };
  });
  check('odd values still convert', !r.error, r.error);
  check('a slide size too small becomes an inch', near(72, r.tiny.width) && near(72, r.tiny.height), r.tiny);
  check('a slide size too large becomes 200 inches', near(14400, r.big.width) && near(14400, r.big.height), r.big);
  check('the rest of the slide is there', r.odd.text.includes('Fine') && r.odd.text.includes('Wide'), r.odd.text);
  check('nothing left out', r.leftOut.length === 0, r.leftOut);
}

async function smartArt(page) {
  const r = await inPage(page, async (T) => {
    const E = T.EMU;
    const DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
    const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Diagram" descr="Steps"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm><a:off x="${100 * E}" y="${100 * E}"/><a:ext cx="${400 * E}" cy="${200 * E}"/></p:xfrm><a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/>
      </a:graphicData></a:graphic></p:graphicFrame>`;
    const data = `<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="${T.A}"><dgm:ptLst/><dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram">
      <dsp:dataModelExt xmlns:dsp="${DSP}" relId="rId5" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst></dgm:dataModel>`;
    const shape = (id, x, text) => `<dsp:sp modelId="{${id}}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr>
      <a:xfrm><a:off x="${x * E}" y="${50 * E}"/><a:ext cx="${100 * E}" cy="${100 * E}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>${T.solid('00B050')}</dsp:spPr>
      <dsp:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>${T.run(text, 14)}</a:p></dsp:txBody><dsp:txXfrm><a:off x="${x * E}" y="${50 * E}"/><a:ext cx="${100 * E}" cy="${100 * E}"/></dsp:txXfrm></dsp:sp>`;
    const drawing = `<dsp:drawing xmlns:dsp="${DSP}" xmlns:a="${T.A}"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>
      ${shape(1, 0, 'Plan')}${shape(2, 150, 'Build')}${shape(3, 300, 'Ship')}</dsp:spTree></dsp:drawing>`;
    const rels = T.relationships(['diagramData', '../diagrams/data1.xml'], ['diagramLayout', '../diagrams/layout1.xml'], ['diagramQuickStyle', '../diagrams/quickStyle1.xml'],
      ['diagramColors', '../diagrams/colors1.xml'], ['diagramDrawing', '../diagrams/drawing1.xml']);
    const out = await T.convert(T.deck([T.slide(frame), T.slide(frame)], {
      slideRels: { 0: rels, 1: T.relationships(['diagramData', '../diagrams/missing.xml']) },
      parts: { 'ppt/diagrams/data1.xml': data, 'ppt/diagrams/drawing1.xml': drawing },
    }));
    if (out.error) return out;
    const p = await T.render(out.bytes, 1);
    const q = await T.render(out.bytes, 2);
    return {
      text: (await T.pages(out.bytes)).map((x) => x.text), green: T.is(p.px(115, 165), 0x00b050), third: T.is(p.px(415, 235), 0x00b050),
      gap: T.is(p.px(225, 200), T.WHITE), white: T.count(p, 430, 190, 40, 15, T.WHITE) > 20 && T.count(p, 430, 190, 40, 15, 0x00b050) > 20,
      ship: await T.word(out.bytes, 1, 'Ship'), standIn: q.px(300, 150),
    };
  });
  check('SmartArt deck converts', !r.error, r.error);
  check('SmartArt from the drawing saved with it', r.text[0].includes('Plan') && r.text[0].includes('Build') && r.text[0].includes('Ship') && r.green && r.third && r.gap, r);
  check('SmartArt text without a colour is white on its dark fill', r.white);
  check('its text in its own frame', r.ship && r.ship.x > 400 && r.ship.x < 500 && r.ship.y > 190 && r.ship.y < 220, r.ship);
  check('SmartArt without its drawing: a grey box with its description', r.text[1].includes('Steps') && r.standIn.every((v) => v > 230 && v < 250), [r.text[1], r.standIn]);
}

// ---------------------------------------------------------------------------------------------

const deckBytes = existsSync(DECK) ? await readFile(DECK) : null;

await withPage(async (page, url) => {
  await setup(page, url);
  await slidesInOrder(page);
  await keep(page, 'slidesInOrder');
  if (deckBytes) {
    const pdf = await deckFixture(page, deckBytes);
    await keep(page, 'deck');
    await deckPixels(page, pdf);
  } else {
    console.log('  (the app\'s deck.pptx isn\'t here: its checks are skipped)');
  }
  const tests = {
    slideNumbers, connectorsGroupsAndSavedPictures, placeholdersAndColourMaps, directionSymbolsAnchoring, verticalText,
    tablesAndMergedCells, groupFillAndNumbering, damagedPartsAndNesting, refusedFiles, autofit, backgroundsAndMasters,
    rotationAndPictures, fontsSubsetted, smartArt, hostileValues,
  };
  for (const [name, test] of Object.entries(tests)) {
    await test(page);
    await keep(page, name);
  }
  await progressCancelAndLargeDecks(page);
});
console.log(`chromium: ${passed} checks passed`);

for (const browser of ['firefox', 'webkit']) {
  const before = passed;
  // Firefox writes each XML error it meets to the console; the damaged-file checks stay in Chromium.
  await withPage(async (page, url) => {
    await setup(page, url);
    await slidesInOrder(page);
    if (deckBytes) await deckFixture(page, deckBytes, browser);
    await connectorsGroupsAndSavedPictures(page);
    await tablesAndMergedCells(page);
    await autofit(page);
    await progressCancelAndLargeDecks(page);
  }, { browser });
  console.log(`${browser}: ${passed - before} checks passed`);
}
console.log(`pptx: all ${passed} checks passed`);
