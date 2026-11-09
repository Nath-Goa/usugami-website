// Tests for the shared core of Word, PowerPoint, Excel and EPUB to PDF (site/app/js/engine/office/):
// the ported OfficeFormats and XmlTokenGuard unit tests, ZIP and XML reading with the guard against
// hostile files, packages and the app's messages, the dispatcher, colours, and DrawingML shapes,
// pictures and tables drawn into real PDFs and checked by their pixels and text.
import { withPage, assert } from './harness.mjs';

let passed = 0;
function check(name, condition, detail = '') {
  assert(condition, `${name}${detail !== '' ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  passed++;
}

/** Loads the modules and helpers into the page as window.O. */
async function setup(page, url) {
  await page.goto(url + 'app/fonts/OFL.txt');
  await page.evaluate(async (base) => {
    const at = (p) => import(base + 'app/js/' + p);
    const O = { base };
    O.fmt = await at('engine/office/office-formats.js');
    O.col = await at('engine/office/colors.js');
    O.guard = await at('engine/office/xml-guard.js');
    O.zip = await at('engine/office/zip.js');
    O.prob = await at('engine/office/problems.js');
    O.ox = await at('engine/office/ooxml.js');
    O.pm = await at('engine/office/path-measure.js');
    O.dml = await at('engine/office/drawingml.js');
    O.blocks = await at('engine/office/blocks.js');
    O.tables = await at('engine/office/tables.js');
    O.opdf = await at('engine/office/office-pdf.js');
    O.index = await at('engine/office/index.js');
    O.text = await at('engine/text/index.js');
    O.common = await at('engine/pdf-common.js');
    O.pdfjs = await at('lib/pdfjs.js');
    O.lib = await at('lib/pdf-lib.js');
    O.fflate = await at('lib/fflate.js');
    O.errors = await at('core/errors.js');

    const enc = new TextEncoder();
    O.u8 = (s) => (typeof s === 'string' ? enc.encode(s) : s);
    O.concat = (...parts) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let i = 0;
      for (const p of parts) { out.set(p, i); i += p.length; }
      return out;
    };
    O.utf16 = (s, le) => {
      const b = new Uint8Array(s.length * 2);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        b[2 * i + (le ? 0 : 1)] = c & 255;
        b[2 * i + (le ? 1 : 0)] = c >> 8;
      }
      return b;
    };
    // A zip of { name: text or bytes } (deflated unless `level` 0).
    O.makeZip = (files, level = 6) => {
      const entries = {};
      for (const [name, v] of Object.entries(files)) entries[name] = [O.u8(v), { level }];
      return O.fflate.zipSync(entries);
    };
    O.W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    O.A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    O.P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    O.S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    O.R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    O.PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
    O.rels = (...rels) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${O.PKG}">` +
      rels.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${O.R}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('') +
      '</Relationships>';
    const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
    O.docx = (body = '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>', extra = {}) => O.makeZip({
      '[Content_Types].xml': types,
      '_rels/.rels': O.rels(['rId1', 'officeDocument', 'word/document.xml']),
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${O.W}" xmlns:r="${O.R}"><w:body>${body}</w:body></w:document>`,
      'word/_rels/document.xml.rels': O.rels(['rId1', 'styles', 'styles.xml'], ['rId2', 'image', 'media/image1.png'], ['rId3', 'hyperlink', 'https://example.com/', true], ['rId4', 'customXml', '../customXml/item1.xml'], ['rId5', 'image', '/word/media/abs.png']),
      'word/styles.xml': `<w:styles xmlns:w="${O.W}"/>`,
      ...extra,
    });
    O.pptx = (extra = {}) => O.makeZip({
      '[Content_Types].xml': types,
      '_rels/.rels': O.rels(['rId1', 'officeDocument', 'ppt/presentation.xml']),
      'ppt/presentation.xml': `<p:presentation xmlns:p="${O.P}" xmlns:r="${O.R}"/>`,
      ...extra,
    });
    O.xlsx = () => O.makeZip({
      '[Content_Types].xml': types,
      '_rels/.rels': O.rels(['rId1', 'officeDocument', 'xl/workbook.xml']),
      'xl/workbook.xml': `<workbook xmlns="${O.S}" xmlns:r="${O.R}"><sheets/></workbook>`,
    });
    O.epub = () => O.makeZip({ mimetype: 'application/epub+zip', 'META-INF/container.xml': '<container/>' }, 0);
    O.compound = (extra = new Uint8Array(2048)) => O.concat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), extra);
    // What a call throws: { name, key, manyKey, message, reason, problem } or null.
    O.thrown = async (fn) => {
      try {
        await fn();
        return null;
      } catch (e) {
        return { name: e?.name, key: e?.key ?? null, manyKey: e?.manyKey ?? null, message: String(e?.message ?? e), reason: e?.reason ?? null, problem: e?.problem ?? null };
      }
    };
    // A PNG `w` × `h`, drawn by draw(ctx).
    O.png = async (w, h, draw) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      draw(c.getContext('2d'));
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    O.items = async (bytes, n = 1) => {
      const pdf = await O.pdfjs.openPdfJs(bytes);
      const p = await pdf.getPage(n);
      const tc = await p.getTextContent();
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      return tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
    };
    O.pageCount = async (bytes) => {
      const pdf = await O.pdfjs.openPdfJs(bytes);
      const n = pdf.numPages;
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      return n;
    };
    // Renders page n with pdf.js; px(x, y) gives [r, g, b] at the point (x, y) from the top-left.
    O.render = async (bytes, n = 1, scale = 2) => {
      const pdf = await O.pdfjs.openPdfJs(bytes);
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
        const i = (Math.round(y * scale) * canvas.width + Math.round(x * scale)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      return { px, width: canvas.width, height: canvas.height, data, scale };
    };
    O.near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    // The image XObjects of a PDF: [{ width, height, filter, smask }].
    O.images = async (bytes) => {
      const doc = await O.lib.PDFDocument.load(bytes);
      const out = [];
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        const dict = obj?.dict;
        if (!dict) continue;
        const sub = dict.get(O.lib.PDFName.of('Subtype'));
        if (sub?.toString() !== '/Image') continue;
        if (dict.get(O.lib.PDFName.of('ColorSpace'))?.toString() === '/DeviceGray' && !dict.get(O.lib.PDFName.of('SMask'))) {
          // A soft mask of another picture.
          out.push({ mask: true, width: dict.get(O.lib.PDFName.of('Width'))?.asNumber() });
          continue;
        }
        out.push({
          width: dict.get(O.lib.PDFName.of('Width'))?.asNumber(),
          height: dict.get(O.lib.PDFName.of('Height'))?.asNumber(),
          filter: dict.get(O.lib.PDFName.of('Filter'))?.toString() ?? null,
          smask: !!dict.get(O.lib.PDFName.of('SMask')),
        });
      }
      return out;
    };
    window.O = O;
  }, url);
}

// ---------------------------------------------------------------------------------------------
// OfficeFormatsTest, ported

async function formats(page) {
  const r = await page.evaluate(() => {
    const { OfficeUnits: U, OfficeFileType: F, OfficeContainer: C, ListNumbering: L, SymbolFonts: S, TableColumns: T, TabStops, TabAlign,
      PageBreaking: B, GroupFrame, OfficeRect, SlideTableStyles: ST, paperSize } = window.O.fmt;
    const out = {};
    out.units = [U.emu(914400), U.twips(720), U.halfPoints(22), U.cssLength('1.5in'), U.cssLength(' 120pt '), U.cssLength('2.54cm'), U.cssLength('100'), U.cssLength('auto'), U.cssLength('1'.repeat(70) + 'pt')];
    out.css = { ...U.cssStyle('position:absolute; WIDTH:120pt;height:4cm;') };
    out.cssProto = U.cssStyle('__proto__:x;constructor:y').__proto__;
    const style = new TabStops([234, 468]);
    const own = new TabStops([504], [234]);
    out.tabsOver = [own.over(style).set, new TabStops([504]).over(style).set, new TabStops([234]).over(own).over(style).set];
    const header = new TabStops([234, 468], [], new Map([[234, TabAlign.CENTER], [468, TabAlign.RIGHT]]));
    out.positions = [
      header.positions(0, [50, 40, 30], 36), new TabStops([100]).positions(0, [10, 70, 5], 36),
      new TabStops([250], [], new Map([[250, TabAlign.RIGHT]])).positions(0, [200, 80], 36),
      new TabStops([468], [], new Map([[468, TabAlign.RIGHT]])).positions(0, [500, 300], 360, 10),
      [...new TabStops([500], [234]).over(header).aligned],
    ];
    out.percent = [U.percentage('90000'), U.percentage(' 90% '), U.percentage('-5.5%'), U.percentage('NaN%'), U.percentage('lots'), U.percentage('12.9'), U.percentage(null)];
    const cmp = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    out.containers = [F.container(new Uint8Array([0x50, 0x4b, 3, 4, 0x14, 0, 0, 0])), F.container(cmp), F.container(new TextEncoder().encode('{\\rtf1\\ansi')), F.container(new Uint8Array([0x50, 0x4b]))];
    out.containerNames = [C.ZIP, C.COMPOUND, C.OTHER];
    const name = new Uint8Array([...'EncryptedPackage'].flatMap((c) => [c.charCodeAt(0), 0]));
    const encrypted = window.O.concat(new Uint8Array(65530), name, new Uint8Array(100));
    const legacy = window.O.concat(new Uint8Array(70000), new Uint8Array([...'WordDocument'].flatMap((c) => [c.charCodeAt(0), 0])));
    out.encrypted = [F.isEncryptedPackage(encrypted), F.isEncryptedPackage(legacy), F.isEncryptedPackage(new TextEncoder().encode('EncryptedPackage'))];
    out.numbers = L.FORMATS.map((f) => L.format(4, f));
    out.more = [L.format(27, L.Format.LOWER_LETTER), L.format(780, L.Format.UPPER_LETTER), L.format(2000000000, L.Format.LOWER_LETTER), L.format(1994, L.Format.UPPER_ROMAN), L.format(4000, L.Format.UPPER_ROMAN), L.format(0, L.Format.LOWER_ROMAN), L.format(7, L.Format.DECIMAL_ZERO), L.format(12, L.Format.DECIMAL_ZERO)];
    out.wordFormats = [L.wordFormat('lowerLetter'), L.wordFormat('chineseCounting'), L.wordFormat('bullet'), L.wordFormat(null)];
    const formats = [L.Format.DECIMAL, L.Format.LOWER_LETTER, L.Format.LOWER_ROMAN];
    out.labels = [L.wordLabel('%1.', [3, 1, 1], formats), L.wordLabel('%1.%2)', [3, 2, 1], formats), L.wordLabel('(%3)', [1, 1, 2], formats), L.wordLabel('Step %1:', [2], formats), L.wordLabel('%5', [1], formats)];
    out.schemes = [L.powerPointScheme('arabicPeriod'), L.powerPointScheme('alphaLcParenBoth'), L.powerPointScheme('romanUcParenR'), L.powerPointScheme('arabicPlain'), L.powerPointScheme('arabicMinus')];
    out.fields = [L.fieldFormat(' PAGE  \\* roman  \\* MERGEFORMAT '), L.fieldFormat('PAGE \\* ROMAN'), L.fieldFormat('PAGE \\*alphabetic'), L.fieldFormat('PAGE \\* ALPHABETIC'), L.fieldFormat('PAGE \\* Arabic \\* MERGEFORMAT'), L.fieldFormat('PAGE \\* MERGEFORMAT'), L.fieldFormat('PAGE')];
    out.bullets = [S.bullet('Symbol', ''), S.bullet('Wingdings', ''), S.bullet('Wingdings', '§'), S.bullet('Wingdings', 'ü'), S.bullet('Wingdings', '#'), S.bullet('Courier New', 'o'), S.bullet('Arial', '–')];
    out.symbols = [
      S.character('Symbol', ''), S.character('Symbol', ''), S.character('Symbol', ''), S.character('Symbol', ''),
      S.character('Symbol', ''), S.character('Symbol', ''), S.character('Symbol', ''), S.character('Symbol', ''),
      S.character('symbol', 'p'), S.character('Wingdings', ''), S.character('Wingdings', ''), S.character('Wingdings', ''),
      S.character('Wingdings', ''), S.character('Wingdings 2', ''), S.character('Wingdings 2', ''), S.character('Wingdings 2', ''),
      S.character('Wingdings', ''), S.character('Webdings', ''), S.character('Segoe UI Symbol', '✓'), S.character('Arial', 'a'),
      S.bullet('Symbol', ''), S.text('Wingdings', 'ü ü'), S.text('Symbol', 'a+b'), S.text('Calibri', 'Done ', 'Wingdings'), S.text('Calibri', 'abc', 'Wingdings'),
      S.text('Symbol', 'a\nb'), S.text('Calibri', '😀', 'Wingdings'),
    ];
    out.columns = [T.widths([100, 200], 2, 450), T.widths([200, 400], 2, 450), T.widths([], 3, 450), T.widths([], 2, 450, 200), T.widths([100, 300], 3, 600), T.widths([0, -5], 2, 100)];
    const lines = [10, 20, 30, 40, 50];
    out.breaks = [
      B.linesThatFit(lines, 55, true, false), B.linesThatFit(lines, 35, true, false), B.linesThatFit(lines, 45, true, false),
      B.linesThatFit(lines, 45, false, false), B.linesThatFit(lines, 15, true, false), B.linesThatFit([10, 20, 30], 25, true, false),
      B.linesThatFit([10, 20, 30], 25, true, false, true, false), B.linesThatFit(lines, 15, true, false, false), B.linesThatFit([900, 950], 800, true, true),
      B.linesThatFit([], 800, true, true),
    ];
    const plain = (r) => [r.x, r.y, r.width, r.height];
    const group = new GroupFrame(new OfficeRect(100, 50, 200, 100), [0, 0], [400, 100]);
    const offset = new GroupFrame(new OfficeRect(0, 0, 100, 100), [1000, 1000], [100, 100]);
    const flippedGroup = new GroupFrame(new OfficeRect(0, 0, 100, 100), [0, 0], [100, 100], true);
    const upsideDown = new GroupFrame(new OfficeRect(0, 0, 100, 100), [0, 0], [100, 100], false, true);
    const both = new GroupFrame(new OfficeRect(0, 0, 100, 100), [0, 0], [100, 100], true, true);
    out.groups = [
      plain(group.place(new OfficeRect(100, 10, 200, 50))), plain(offset.place(new OfficeRect(1010, 1020, 30, 40))),
      plain(flippedGroup.place(new OfficeRect(10, 20, 30, 40))), flippedGroup.mirror(30, false, false),
      plain(upsideDown.place(new OfficeRect(10, 20, 30, 40))), both.mirror(30, true, false),
      plain(new GroupFrame(new OfficeRect(5, 5, 10, 10), [0, 0], [0, 0]).place(new OfficeRect(1, 1, 2, 2))),
    ];
    const flags = new Set(['firstRow', 'bandRow', 'firstCol', 'bandCol', 'lastCol']);
    out.tableStyles = [
      ST.parts(flags, 0, 4, 0, 1, 3), ST.parts(flags, 1, 4, 1, 2, 3), ST.parts([...flags], 2, 4, 2, 3, 3),
      ST.border('wholeTbl', 'top', true), ST.border('wholeTbl', 'top', false), ST.border('wholeTbl', 'right', false),
      ST.border('firstRow', 'bottom', false), ST.border('band1H', 'left', false), ST.border('band1H', 'left', true),
      ST.border('firstCol', 'right', false), ST.border('lastCol', 'top', false),
    ];
    out.papers = [paperSize('a4'), paperSize('letter', true), paperSize('nope')];
    return out;
  });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const near = (a, b) => a.every((v, i) => (v == null ? b[i] == null : Math.abs(v - b[i]) < 0.001));
  check('units become points', near(r.units, [72, 36, 11, 108, 120, 72, 75, null, null]), r.units);
  check('a VML style is read by lowercase name', eq(r.css, { position: 'absolute', width: '120pt', height: '4cm' }) && r.cssProto === 'x', r.css);
  check("Word tab stops add to the style's", eq(r.tabsOver, [[468, 504], [234, 468, 504], [234, 468, 504]]), r.tabsOver);
  check('text after tabs ends at right stops and centres on centre ones',
    eq(r.positions.slice(0, 4), [[214, 438], [100, 180], [201], [4380]]) && eq(r.positions[4], [[468, 'RIGHT']]), r.positions);
  check('percentages as Office and Strict Open XML write them', eq(r.percent, [90000, 90000, -5500, null, null, 12, null]), r.percent);
  check('zips and compound files are told apart', eq(r.containers, [r.containerNames[0], r.containerNames[1], r.containerNames[2], r.containerNames[2]]), r.containers);
  check('the encrypted package stream is found, straddling reads', eq(r.encrypted, [true, false, false]), r.encrypted);
  check('list items are numbered in each format', eq(r.numbers, ['4', '04', 'd', 'D', 'iv', 'IV', '', '']), r.numbers);
  check('letters and roman numerals have their limits',
    eq(r.more, ['aa', 'Z'.repeat(30), '2000000000', 'MCMXCIV', '4000', '0', '07', '12']), r.more);
  check("Word's number formats", eq(r.wordFormats, ['LOWER_LETTER', 'DECIMAL', 'BULLET', 'DECIMAL']), r.wordFormats);
  check("Word's level text is filled in", eq(r.labels, ['3.', '3.b)', '(ii)', 'Step 2:', '%5']), r.labels);
  check('PowerPoint autonumber schemes', eq(r.schemes, [['DECIMAL', '', '.'], ['LOWER_LETTER', '(', ')'], ['UPPER_ROMAN', '', ')'], ['DECIMAL', '', ''], ['DECIMAL', '', ' -']]), r.schemes);
  check('page field formats', eq(r.fields, ['LOWER_ROMAN', 'UPPER_ROMAN', 'LOWER_LETTER', 'UPPER_LETTER', 'DECIMAL', null, null]), r.fields);
  check('symbol font bullets become Unicode', eq(r.bullets, ['•', '▪', '▪', '✓', '•', 'o', '–']), r.bullets);
  check('inserted symbols become their own characters', eq(r.symbols, [
    'μ', '°', '±', 'α', '≤', 'Ω', '•', '7', 'π', '☑', '◻', '☒', '▪', '☑', '□', '✓',
    '�', '�', '✓', 'a', '•', '✓ ✓', 'α+β', 'Done ✓', 'abc', 'α\nβ', '😀✓',
  ]), r.symbols);
  check('table columns fit the space', eq(r.columns, [[100, 200], [150, 300], [150, 150, 150], [100, 100], [100, 300, 200], [50, 50]]), r.columns);
  check('single lines are kept off page edges', eq(r.breaks, [5, 3, 3, 4, 0, 0, 2, 1, 1, 0]), r.breaks);
  // PageBreaking is ported here so the converter screens load no fonts; it must give what the text engine's gives.
  const same = await page.evaluate(async () => {
    const { linesThatFit } = await import(window.O.base + 'app/js/engine/text/layout.js');
    const B = window.O.fmt.PageBreaking;
    let seed = 11;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const differ = [];
    for (let k = 0; k < 2000; k++) {
      const n = Math.floor(rand() * 7);
      const bottoms = [];
      let at = 0;
      for (let i = 0; i < n; i++) bottoms.push((at += 1 + Math.round(rand() * 400) / 20));
      const space = k % 3 === 0 && n ? bottoms[Math.floor(rand() * n)] + (rand() < 0.5 ? 1e-7 : -1e-7) : rand() * at;
      const args = [space, rand() < 0.7, rand() < 0.3, rand() < 0.8, rand() < 0.8];
      const a = B.linesThatFit(new Float32Array(bottoms), ...args);
      const b = linesThatFit(Array.from(new Float32Array(bottoms)), ...args);
      if (a !== b) differ.push([bottoms, ...args, a, b]);
    }
    return differ.slice(0, 3);
  });
  check("page breaking gives what the text engine's does", same.length === 0, same);
  check('groups stretch, offset and mirror their children', eq(r.groups, [
    [150, 60, 100, 50], [10, 20, 30, 40], [60, 20, 30, 40], [-30, true, false], [10, 40, 30, 40], [30, false, true], [6, 6, 2, 2],
  ]), r.groups);
  check('table style parts and borders', eq(r.tableStyles, [
    ['wholeTbl', 'firstCol', 'firstRow'], ['wholeTbl', 'band1H', 'band1V'], ['wholeTbl', 'band2H', 'band2V', 'lastCol'],
    'top', 'insideH', 'insideV', 'bottom', 'insideV', 'left', 'right', 'insideH',
  ]), r.tableStyles);
  check('paper sizes', Math.abs(r.papers[0].width - 595.2756) < 0.001 && Math.abs(r.papers[0].height - 841.8898) < 0.001 &&
    r.papers[1].width === 792 && r.papers[1].height === 612 && r.papers[2] === null, r.papers);
}

// ---------------------------------------------------------------------------------------------
// Colours

async function colors(page) {
  const r = await page.evaluate(async () => {
    const { OfficeColors: C } = window.O.col;
    const { parseXml } = window.O.ox;
    const { readColor, OfficeTheme } = window.O.dml;
    const accent = 0xff4472c4;
    const hex = (v) => (v == null ? null : (v >>> 0).toString(16).padStart(8, '0').toUpperCase());
    const out = {};
    out.parsed = [C.hex('4472C4'), C.hex('#4472c4'), C.hex('auto'), C.hex('12345'), C.hex(' 00ff00 '), C.hex('GG0000'), C.highlight('yellow'), C.highlight('none'), C.highlight('darkGray')].map(hex);
    out.presets = [C.preset('Orange'), C.preset('ltGray'), C.preset('unknown'), C.preset(null)].map(hex);
    out.modified = [
      C.modify(accent, [['lumMod', 75000]]), C.modify(accent, [['lumMod', 60000], ['lumOff', 40000]]),
      C.modify(0xffffffff, [['shade', 50196]]), C.modify(0xffff0000, [['alpha', 50196]]), C.modify(0xffff0000, [['comp', 0]]),
      C.modify(0xff000000, [['tint', 50000]]), C.modify(0xff000000, [['tint', 25000]]), C.modify(0xffffffff, [['shade', 25000]]),
      C.modify(0xffff0000, [['gray', 0]]), C.modify(0xff336699, [['inv', 0]]), C.modify(accent, [['satMod', 0]]),
      C.modify(0xffff0000, [['hueOff', 7200000]]), C.modify(0x80ff0000, [['alphaMod', 50000]]), C.modify(0xffff0000, [['alphaOff', -50000]]),
      C.modify(accent, [['lumMod', 50000], ['lumOff', 0]]), C.modify(accent, [['lumOff', 200000]]), C.modify(accent, [['unknownMod', 5]]),
      // Accent 1 "lighter 80%" and "darker 50%", as PowerPoint's palette writes them.
      C.modify(accent, [['lumMod', 20000], ['lumOff', 80000]]), C.modify(accent, [['lumMod', 50000]]),
    ].map(hex);
    out.dark = [C.isDark(0xff1f3864), C.isDark(0xfffff2cc), C.isDark(0xff808080), C.isDark(0xff7f7f7f)];
    out.css = [C.css(0xff336699), C.css(0x80ff0000)];
    // The scheme colours of a theme, read with their modifiers.
    const theme = new OfficeTheme(new Map([...OfficeTheme.DEFAULT.colors, ['accent1', 0xff112233]]), 'Aptos Display', 'Aptos');
    const scheme = (n) => theme.color(n);
    const color = (xml) => readColor(parseXml(`<x xmlns:a="${window.O.A}">${xml}</x>`).children()[0], scheme);
    out.read = [
      color('<a:schemeClr val="accent1"/>'), color('<a:schemeClr val="accent1"><a:lumMod val="75%"/><a:lumOff val="0"/></a:schemeClr>'),
      color('<a:srgbClr val="4472C4"><a:lumMod val="75000"/></a:srgbClr>'), color('<a:sysClr val="windowText" lastClr="000000"/>'),
      color('<a:sysClr val="window"/>'), color('<a:prstClr val="orange"/>'), color('<a:scrgbClr r="100000" g="50000" b="0"/>'),
      color('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>'), color('<a:hslClr hue="0" sat="0" lum="50000"/>'),
      color('<a:schemeClr val="nothing"/>'), color('<a:somethingElse val="FF0000"/>'), color('<a:srgbClr val="00FF00"><a:inv/></a:srgbClr>'),
      color('<a:srgbClr val="FF0000"><a:tint val="50000"/><a:shade val="50000"/></a:srgbClr>'),
    ].map(hex);
    // A theme read from its part, and Office's default.
    const themeXml = `<a:theme xmlns:a="${window.O.A}"><a:themeElements><a:clrScheme name="x">
      <a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:accent1><a:srgbClr val="AB1234"/></a:accent1><a:accent2><a:schemeClr val="dk1"/></a:accent2>
      </a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
    const pkg = await window.O.ox.OfficePackage.open(window.O.makeZip({ 'ppt/theme/theme1.xml': themeXml }));
    const read = await OfficeTheme.read(pkg, 'ppt/theme/theme1.xml');
    const fallback = await OfficeTheme.read(pkg, null);
    const missing = await OfficeTheme.read(pkg, 'ppt/theme/none.xml');
    out.theme = [hex(read.color('dk1')), hex(read.color('accent1')), hex(read.color('accent2')), hex(read.color('accent6')), read.font('+mj-lt'), read.font('minorHAnsi'), read.font('Arial'), read.font(null)];
    out.defaults = [fallback === OfficeTheme.DEFAULT, missing === OfficeTheme.DEFAULT, hex(fallback.color('accent1')), fallback.font('+mn-ea')];
    return out;
  });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('hex colours and highlights are read', eq(r.parsed, ['FF4472C4', 'FF4472C4', null, null, 'FF00FF00', null, 'FFFFFF00', null, 'FF808080']), r.parsed);
  check('preset colours', eq(r.presets, ['FFFFA500', 'FFC0C0C0', 'FF000000', 'FF000000']), r.presets);
  check('lumMod, lumOff, tints, shades and the other modifiers change colours as in the app', eq(r.modified, [
    'FF2F5597', 'FF8FAADC', 'FF808080', '80FF0000', 'FF00FFFF', 'FF808080', 'FFBFBFBF', 'FF404040', 'FF4D4D4D', 'FFCC9966',
    'FF848484', 'FF00FF00', '40FF0000', '80FF0000', 'FF203864', 'FFFFFFFF', 'FF4472C4', 'FFDAE3F3', 'FF203864',
  ]), r.modified);
  check('dark colours are told from light ones (mid grey just under the line, as in Kotlin)', eq(r.dark, [true, false, true, true]), r.dark);
  check('colours as CSS', eq(r.css, ['#336699', 'rgba(255, 0, 0, 0.502)']), r.css);
  check('DrawingML colour elements are read with their modifiers', eq(r.read, [
    'FF112233', 'FF0D1A26', 'FF2F5597', 'FF000000', 'FFFFFFFF', 'FFFFA500', 'FFFF7F00', '80FF0000', 'FF808080', null, null, 'FFFF00FF', 'FF804040',
  ]), r.read);
  check("a theme's colours and fonts are read from its part", eq(r.theme, ['FF111111', 'FFAB1234', 'FFED7D31', 'FF70AD47', 'Aptos Display', 'Calibri', 'Arial', null]), r.theme);
  check("Office's default theme stands in when there's none", eq(r.defaults, [true, true, 'FF4472C4', 'Calibri']), r.defaults);
}

// ---------------------------------------------------------------------------------------------
// XmlTokenGuardTest, ported, and reading XML with the guard

async function guard(page, { quick = false } = {}) {
  const r = await page.evaluate(async (quick) => {
    const O = window.O;
    const { parseXml } = O.ox;
    const refused = (input, options) => {
      try {
        parseXml(input, options);
        return false;
      } catch (e) {
        return e.name === 'XmlError';
      }
    };
    const out = {};
    const crafted = '<w:document' + Array.from({ length: 4097 }, (_, i) => ` xmlns:p${i}="u"`).join('') + '/>';
    const bom = new Uint8Array([0xff, 0xfe]);
    out.crafted = [
      refused(O.u8(crafted)), refused(O.concat(bom, O.utf16(crafted, true))), refused(O.utf16('<?xml version="1.0"?>' + crafted, false)),
      refused(O.u8('<?xml version="1.0" encoding="UTF-16"?><a/>')),
    ];
    const declaration = '<?xml version="1.0"' + Array.from({ length: 1001 }, (_, i) => ` a${i}=''`).join('') + '?><a/>';
    out.declarations = [
      refused(O.concat(bom, O.utf16(declaration, true))), refused(O.u8(declaration.replace('<?xml', '<?XML'))),
      refused(O.concat(new Uint8Array([0xef, 0xbb, 0xbf]), O.u8(declaration))), refused(O.u8(declaration.replace('version', 'x=">" version'))),
    ];
    const ordinary = '<?xml version="1.0" encoding="UTF-16" standalone="yes"?><w:document xmlns:w="main"><w:body/></w:document>';
    const a = parseXml(O.concat(bom, O.utf16(ordinary, true)));
    const b = parseXml(O.u8(ordinary.replace('UTF-16', 'UTF-8')));
    out.ordinary = [a.name, a.uri, a.children()[0].name, b.name];
    const level = Array.from({ length: 1000 }, (_, i) => ` xmlns:a${i}="u"`).join('');
    const nested = '<w:document xmlns:w="m">' + `<w:p${level}>`.repeat(5) + '</w:p>'.repeat(5) + '</w:document>';
    const apart = '<w:document xmlns:w="m">' + `<w:p${level}></w:p>`.repeat(5) + `<w:p${level}/>`.repeat(5) + '</w:document>';
    out.piling = [refused(O.u8(nested)), refused(O.u8(apart)), parseXml(O.u8(apart)).children().length];
    const many = Array.from({ length: 4097 }, (_, i) => ` a${i}=""`).join('');
    out.hiding = ['<!-- > <a \' -->', '<![CDATA[ > <a \' ]]>', '<?pi > <a \' ?>'].map((h) => refused(O.u8(`<w:document>${h}<w:p${many}/><!-- ' --></w:document>`)));
    if (!quick) {
      out.longText = refused(O.u8('<a>' + 'x>'.repeat(5 * 1024 * 1024) + '</a>'));
      out.brokenUp = refused(O.u8('<a>' + ('x'.repeat(1000) + '<!---->').repeat(1000) + '</a>'));
    }
    const plain = '<?xml version="1.0"?><?mso-application progid="Word.Document"?><w:document xmlns:w="m">' +
      '<!-- a "quote" and > --><w:t a="1>2">x &gt; y > z<![CDATA[<b c=\'>\']]></w:t><w:p/></w:document>';
    const p = parseXml(O.u8(plain));
    out.plain = [p.children().map((c) => c.name), p.child('t').text(), p.child('t').attr('a')];
    // A DOCTYPE could declare entities that expand into gigabytes: refused, unless asked to leave it out unread.
    out.doctype = [
      refused(O.u8('<!DOCTYPE w:document [<!ENTITY lol "lol">]><w:document xmlns:w="m">&lol;</w:document>')),
      refused(O.u8('<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><lolz>&c;&c;&c;</lolz>')),
      refused(O.u8('<a><!ELEMENT b ANY></a>')), refused(O.u8('<a><!-x--></a>')),
      parseXml(O.u8('<?xml version="1.0"?><!DOCTYPE html [ <!ENTITY x "]>"> ]><html xmlns="http://www.w3.org/1999/xhtml"><body>Hi</body></html>'), { doctype: 'remove' }).allText(),
    ];
    // Nested deeper than the app reads: what's too deep is left out, and the rest is read.
    const para = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
    const doc = (depth) => `<w:document xmlns:w="${O.W}"><w:body>` + '<w:customXml>'.repeat(depth) + para('Deep') + '</w:customXml>'.repeat(depth) + para('Shallow') + '</w:body></w:document>';
    let t = performance.now();
    const deep = parseXml(O.u8(doc(10000)));
    out.deepMs = performance.now() - t;
    let deepest = 0;
    deep.descendants((n) => { deepest = Math.max(deepest, n.depth); return true; });
    out.deep = [deep.allText(), deepest];
    t = performance.now();
    out.tooDeep = refused(O.u8(doc(100000)));
    out.tooDeepMs = performance.now() - t;
    const chain = '<e>'.repeat(256) + 'keep<x>gone</x><y/>' + '</e>'.repeat(256);
    const c = parseXml(O.u8(chain));
    out.edge = [c.allText(), (() => { let n = c; while (n.children().length) n = n.children()[0]; return n.depth; })()];
    // Each way of nesting the app's device test tries: links, tables in cells, content controls, groups.
    const ways = [
      '<w:p>' + '<w:hyperlink>'.repeat(1000) + '<w:r><w:t>Deep</w:t></w:r>' + '</w:hyperlink>'.repeat(1000) + '</w:p>' + para('Shallow'),
      '<w:tbl><w:tr><w:tc>'.repeat(1000) + para('Deep') + '</w:tc></w:tr></w:tbl>'.repeat(1000) + para('Shallow'),
      '<w:sdt><w:sdtContent>'.repeat(1000) + para('Deep') + '</w:sdtContent></w:sdt>'.repeat(1000) + para('Shallow'),
    ];
    out.ways = ways.map((body) => parseXml(O.u8(`<w:document xmlns:w="${O.W}"><w:body>${body}</w:body></w:document>`)).allText());
    // Encodings: 8-bit ones as their declarations name them, UTF-16 and UTF-32 by their first bytes.
    const latin = O.concat(O.u8('<?xml version="1.0" encoding="windows-1252"?><a>caf'), new Uint8Array([0xe9, 0x80]), O.u8('</a>'));
    const polish = O.concat(O.u8("<?xml version='1.0' encoding='ISO-8859-2'?><a>"), new Uint8Array([0xb1]), O.u8('</a>'));
    const utf32 = (s) => {
      const bytes = new Uint8Array(4 + s.length * 4);
      bytes.set([0xff, 0xfe, 0, 0]);
      for (let i = 0; i < s.length; i++) bytes[4 + 4 * i] = s.charCodeAt(i);
      return bytes;
    };
    out.encodings = [
      parseXml(latin).text(), parseXml(polish).text(), parseXml(O.utf16('<?xml version="1.0"?><a>16</a>', false)).text(),
      parseXml(utf32('<a>32</a>')).text(), parseXml(O.u8('<?xml version="1.0" encoding="UTF-8"?><a>éक</a>')).text(),
      refused(O.u8('<?xml version="1.0" encoding="EBCDIC-US"?><a/>')), refused(O.u8('<?xml version="1.0" encoding="iso-8859-12"?><a/>')),
      refused(O.u8('<?xml version="1.0"' + ' '.repeat(9000) + '?><a/>')),
    ];
    // The root element of a part from its start only.
    const root = (s) => window.O.ox.rootElementOf(async (n) => O.u8(s).slice(0, n));
    out.roots = [
      await root(`<?xml version="1.0"?><!-- hi --><w:document xmlns:w="${O.W}"><w:body>${'x'.repeat(300000)}</w:body></w:document>`),
      await root(`<w:document ${'a'.repeat(100000)}="1" xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main">`),
      await window.O.thrown(() => root('<!DOCTYPE x><x/>')), await window.O.thrown(() => root('   ')),
    ];
    return out;
  }, quick);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('a crafted part is refused whatever its encoding', eq(r.crafted, [true, true, true, true]), r.crafted);
  check('an XML declaration with too many attributes is refused however it is written', eq(r.declarations, [true, true, true, true]), r.declarations);
  check('ordinary parts in UTF-16 and UTF-8 are read', eq(r.ordinary, ['document', 'main', 'body', 'document']), r.ordinary);
  check('attributes piling up on open elements are refused, not those apart', eq(r.piling, [true, false, 10]), r.piling);
  check("comments, CDATA and instructions can't hide attributes", eq(r.hiding, [true, true, true]), r.hiding);
  if (!quick) {
    check('text too long to read is refused', r.longText === true);
    check('text broken up by comments too often is refused', r.brokenUp === true);
  }
  check('comments, quotes and CDATA read as XML has them', eq(r.plain, [['t', 'p'], "x > y > z<b c='>'", '1>2']), r.plain);
  check('a DOCTYPE and its entities are refused; left out on request', eq(r.doctype, [true, true, true, true, 'Hi']), r.doctype);
  check('elements nested deeper than the app reads are left out and the rest is read', r.deep[0] === 'Shallow' && r.deep[1] <= 256, r.deep);
  check('ten thousand levels are read quickly', r.deepMs < 3000, `${Math.round(r.deepMs)} ms`);
  check('a part nested far deeper is refused as damaged, quickly', r.tooDeep === true && r.tooDeepMs < 3000, `${Math.round(r.tooDeepMs)} ms`);
  check('level 256 is read and level 257 is left out', eq(r.edge, ['keep', 256]), r.edge);
  check('every way of nesting leaves out only what is too deep', eq(r.ways, ['Shallow', 'Shallow', 'Shallow']), r.ways);
  check('8-bit encodings, UTF-16 and UTF-32 are read; others refused', eq(r.encodings, ['café€', 'ą', '16', '32', 'éक', true, true, true]), r.encodings);
  check("a part's root element is read from its start",
    r.roots[0]?.name === 'document' && r.roots[0]?.ns === 'WORD' && r.roots[1]?.name === 'document' && r.roots[1]?.ns === 'WORD' &&
    r.roots[2]?.name === 'XmlError' && r.roots[3]?.name === 'XmlError', r.roots);
}

/** Broken XML fails cleanly (Firefox also logs each to its console, which the caller allows for). */
async function brokenXml(page) {
  const broken = await page.evaluate(() => {
    const refused = (s) => {
      try {
        window.O.ox.parseXml(window.O.u8(s));
        return false;
      } catch (e) {
        return e.name === 'XmlError';
      }
    };
    return ['<a><b></a>', '', '<a>&undefined;</a>', '<x:a/>', '<a/><b/>'].map(refused);
  });
  check('broken XML is refused', JSON.stringify(broken) === JSON.stringify([true, true, true, true, true]), broken);
}

// ---------------------------------------------------------------------------------------------
// ZIP

async function zips(page, { quick = false } = {}) {
  const r = await page.evaluate(async (quick) => {
    const O = window.O;
    const { ZipArchive, ZipError, isZip, MAX_ENTRY_BYTES } = O.zip;
    const out = {};
    const text = 'x'.repeat(5000) + 'end';
    const zip = O.fflate.zipSync({
      'word/document.xml': [O.u8(text), { level: 6 }],
      '/media/leading.bin': [new Uint8Array([1, 2, 3]), { level: 0 }],
      'Docs/A.TXT': [O.u8('upper'), { level: 0 }],
      'folder/': [new Uint8Array(0), { level: 0 }],
      'OEBPS/content.opf': [O.u8('<package/>'), { level: 6 }],
      'b/content.opf': [O.u8('<package/>'), { level: 6 }],
    });
    const z = ZipArchive.open(zip);
    const dec = new TextDecoder();
    out.lookups = [
      z.has('word/document.xml'), z.has('WORD/Document.XML'), z.has('/word/document.xml'), z.has('media/leading.bin'), z.has('docs/a.txt'),
      z.has('folder/'), z.has('missing'), z.names.length, z.firstEndingWith('.OPF'),
    ];
    out.contents = [dec.decode(await z.bytes('word/document.xml')) === text, [...(await z.bytes('media/leading.bin'))], dec.decode(z.bytesSync('docs/a.txt')), await z.bytes('nope'), isZip(zip), isZip(O.u8('PK'))];
    out.head = [...(await z.bytes('word/document.xml', { maxBytes: 4 }))].length;
    // Data before the zip (a self-extracting archive) doesn't stop it being read.
    out.prefixed = dec.decode(await ZipArchive.open(O.concat(new Uint8Array(100).fill(7), zip)).bytes('docs/A.TXT'));
    // Two entries with one name: the last wins, as in the app.
    // Two entries with one name (made by renaming the second): the last wins, as in the app's maps.
    const dup = O.fflate.zipSync({ 'a.txt': [O.u8('first'), { level: 0 }], 'b.txt': [O.u8('second'), { level: 0 }] });
    for (let i = 0; i + 5 <= dup.length; i++) if (dec.decode(dup.subarray(i, i + 5)) === 'b.txt') dup[i] = 0x61;
    out.notZip = [O.u8('just text, not a zip at all'), new Uint8Array(10), zip.slice(0, zip.length - 30)].map((b) => {
      try { ZipArchive.open(b); return 'opened'; } catch (e) { return e instanceof ZipError ? e.reason : e.name; }
    });
    const climbing = O.fflate.zipSync({ 'a/../../etc/passwd': [O.u8('x'), { level: 0 }] });
    out.climbing = await O.thrown(() => ZipArchive.open(climbing));
    // Damaged entries: encrypted, an unknown method, data cut short, a local header out of place.
    const damaged = (mutate, name = 'word/document.xml') => {
      const copy = zip.slice();
      const dv = new DataView(copy.buffer);
      let cd = copy.length - 22;
      while (dv.getUint32(cd, true) !== 0x06054b50) cd--;
      let p = dv.getUint32(cd + 16, true);
      while (dv.getUint32(p, true) === 0x02014b50) {
        const nameLength = dv.getUint16(p + 28, true);
        const n = dec.decode(copy.subarray(p + 46, p + 46 + nameLength));
        if (n === name) mutate(dv, p, dv.getUint32(p + 42, true));
        p += 46 + nameLength + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      }
      return copy;
    };
    const readError = async (bytes, name = 'word/document.xml') => {
      try { await ZipArchive.open(bytes).bytes(name); return 'read'; } catch (e) { return e instanceof ZipError ? e.reason : e.name; }
    };
    out.damaged = [
      await readError(damaged((dv, p, local) => { dv.setUint16(p + 8, 1, true); dv.setUint16(local + 6, 1, true); })),
      await readError(damaged((dv, p) => dv.setUint16(p + 10, 12, true))),
      await readError(damaged((dv, p) => dv.setUint32(p + 20, Math.floor(dv.getUint32(p + 20, true) / 2), true))),
      await readError(damaged((dv, p) => dv.setUint32(p + 42, 0xffffff, true))),
      await readError(damaged((dv, p) => dv.setUint32(p + 20, 0, true))),
    ];
    // Limits: an entry inflating past its room, past all entries' room, too many entries.
    const zeros = (n) => new Uint8Array(n);
    const big = O.fflate.zipSync({ 'a.xml': [zeros(2 << 20), { level: 6 }], 'b.xml': [zeros(1 << 20), { level: 6 }], 'c.xml': [zeros(1 << 20), { level: 6 }] });
    const limited = ZipArchive.open(big, { limits: { entryBytes: 1.5 * (1 << 20), totalBytes: 1.75 * (1 << 20) } });
    out.limits = [
      await O.thrown(() => limited.bytes('a.xml')), (await limited.bytes('b.xml')).length, await O.thrown(() => limited.bytes('c.xml')),
      (await limited.bytes('b.xml', { maxBytes: 10 })).length,
      await O.thrown(() => ZipArchive.open(big, { limits: { entries: 2 } })),
      await O.thrown(() => ZipArchive.open(big, { limits: { entryBytes: 1 << 19 } }).bytesSync('a.xml')),
    ];
    // Cancelled while inflating.
    const ac = new AbortController();
    ac.abort(new O.errors.CancelledError());
    out.cancelled = await O.thrown(() => ZipArchive.open(big).bytes('a.xml', { signal: ac.signal }));
    if (!quick) {
      // A zip bomb: 270 MB of zeros in a few hundred kilobytes, with the real limit.
      let bomb = O.fflate.zipSync({ 'xl/worksheets/sheet1.xml': [zeros(270 << 20), { level: 1 }] });
      out.bombSize = bomb.length;
      const t = performance.now();
      out.bomb = await O.thrown(() => ZipArchive.open(bomb).bytes('xl/worksheets/sheet1.xml'));
      out.bombMs = performance.now() - t;
      out.maxEntry = MAX_ENTRY_BYTES;
      bomb = null;
    }
    out.dup = dec.decode(await ZipArchive.open(dup).bytes('A.TXT'));
    return out;
  }, quick);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('zip entries are found as named, without a leading slash, and ignoring case', eq(r.lookups, [true, true, true, true, true, false, false, 5, 'OEBPS/content.opf']), r.lookups);
  check('stored and deflated entries are read', eq(r.contents, [true, [1, 2, 3], 'upper', null, true, false]) && r.head === 4, [r.contents, r.head]);
  check('a zip after other data is still read', r.prefixed === 'upper', r.prefixed);
  check('what isn\'t a zip, or is cut short, is refused', eq(r.notZip, ['not-zip', 'not-zip', 'not-zip']), r.notZip);
  check('an entry name climbing out of the archive makes the zip unreadable', r.climbing?.reason === 'damaged', r.climbing);
  check('encrypted, unknown, cut-short and misplaced entries fail as damaged', eq(r.damaged, ['encrypted', 'unsupported', 'damaged', 'damaged', 'damaged']), r.damaged);
  check('an entry inflating past its room, or past the archive\'s, fails as too large',
    r.limits[0]?.reason === 'too-large' && r.limits[1] === 1 << 20 && r.limits[2]?.reason === 'too-large' && r.limits[3] === 10 &&
    r.limits[4]?.reason === 'too-large' && r.limits[5]?.reason === 'too-large', r.limits);
  check('reading stops when cancelled', r.cancelled?.name === 'CancelledError', r.cancelled);
  if (!quick) {
    check('a zip bomb fails as too large, without inflating it all', r.bomb?.reason === 'too-large' && r.bombSize < 2 << 20 && r.bombMs < 15000, { size: r.bombSize, ms: Math.round(r.bombMs), e: r.bomb });
  }
  check('of two entries with one name, the last is read', r.dup === 'second', r.dup);
}

// ---------------------------------------------------------------------------------------------
// Packages, the guard on whole files, and the app's messages

async function packages(page) {
  const r = await page.evaluate(async () => {
    const O = window.O;
    const { OfficePackage, Ns, namespaceOf, verifyOfficePackage } = O.ox;
    const out = {};
    const docx = O.docx('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r w:rsidR="00A1"><w:rPr><w:b/><w:i w:val="0"/><w:sz w:val="24.6"/></w:rPr><w:t xml:space="preserve"> Hello <![CDATA[there]]></w:t><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId2" embed="nope"/></w:drawing></w:r></w:p>');
    const pkg = await OfficePackage.open(docx);
    const main = pkg.mainPart();
    const rels = pkg.relationships(main);
    out.rels = [main, rels.size, pkg.target(main, 'rId2'), pkg.target(main, 'rId3'), rels.get('rId3').external, rels.get('rId3').target,
      pkg.target(main, 'rId4'), pkg.target(main, 'rId5'), pkg.target(main, null), pkg.targetOfType(main, '/styles'), pkg.targetOfType(main, '/numbering'),
      pkg.relationships('word/styles.xml').size, pkg.relationships('WORD/DOCUMENT.XML') === rels];
    const doc = await pkg.xml(main);
    const body = doc.child('body', Ns.WORD);
    const run = body.child('p').child('r');
    const props = run.child('rPr');
    out.nodes = [doc.name, doc.ns, body.depth, props.child('b').flag(), props.child('i').flag(), props.child('u')?.flag() ?? null, props.child('b').flag('val', false),
      props.child('sz').intAttr('val'), props.child('sz').longAttr('val'), run.attr('rsidR'), run.child('t').attr('space'), run.child('t').text(),
      run.child('drawing').child('blip').relId('embed'), run.child('drawing').child('blip').attr('embed'), body.child('p').child('pPr').child('jc').attr('val'),
      doc.attr('w'), doc.children('body').length, doc.child('body', Ns.DRAWING), run.parent.name];
    const visited = [];
    doc.descendants((n) => { visited.push(n.name); return n.name !== 'rPr'; });
    out.visited = visited;
    out.missing = [await pkg.xml('word/nothing.xml'), pkg.has('word/styles.xml'), pkg.has('WORD/STYLES.XML')];
    // An XML part past the package's XML limit fails as too large (a phone has a lower one), media don't.
    const capped = await OfficePackage.open(O.makeZip({ 'a.xml': '<a>' + 'x'.repeat(5000) + '</a>', 'b.bin': new Uint8Array(5000) }), { limits: { xmlBytes: 1000 } });
    out.xmlCap = [await O.thrown(() => capped.xml('a.xml')), await O.thrown(() => capped.xmlSync('a.xml')), (await capped.bytes('b.bin')).length, O.ox.MAX_XML_BYTES >= 64 << 20];
    out.namespaces = [namespaceOf('http://purl.oclc.org/ooxml/wordprocessingml/main'), namespaceOf(O.A), namespaceOf(O.P), namespaceOf('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'),
      namespaceOf('http://schemas.openxmlformats.org/drawingml/2006/picture'), namespaceOf('http://schemas.openxmlformats.org/markup-compatibility/2006'),
      namespaceOf('http://schemas.openxmlformats.org/officeDocument/2006/math'), namespaceOf('urn:schemas-microsoft-com:vml'), namespaceOf(O.S), namespaceOf('x'), namespaceOf(null)];
    // The app's check on a picked file, and its messages.
    const word = (bytes, kind = 'word') => O.thrown(() => O.index.verifyOfficeFile(kind, { name: 'x', bytes }));
    const name = new Uint8Array([...'EncryptedPackage'].flatMap((c) => [c.charCodeAt(0), 0]));
    const locked = O.compound(O.concat(new Uint8Array(1000), name, new Uint8Array(1000)));
    const strict = O.makeZip({
      '_rels/.rels': `<Relationships xmlns="${O.PKG}"><Relationship Id="r" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="/word/document.xml"/></Relationships>`,
      '/word/document.xml': '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"/>',
    });
    const entities = O.docx().slice();
    const withDoctype = O.makeZip({
      '_rels/.rels': O.rels(['rId1', 'officeDocument', 'word/document.xml']),
      'word/document.xml': `<!DOCTYPE w:document [<!ENTITY lol "lol">]><w:document xmlns:w="${O.W}"><w:body/></w:document>`,
    });
    const bomb = O.makeZip({ '_rels/.rels': O.rels(['rId1', 'officeDocument', 'word/document.xml']), 'word/document.xml': `<w:document xmlns:w="${O.W}">` + ' '.repeat(20 << 20) + '</w:document>' });
    out.verify = [
      await word(docx), await word(strict), await word(O.pptx(), 'powerpoint'), await word(O.xlsx(), 'excel'),
      await word(O.compound()), await word(O.compound(), 'powerpoint'), await word(O.compound(), 'excel'),
      await word(locked), await word(locked, 'powerpoint'), await word(locked, 'excel'),
      await word(O.u8('Just some text, not a Word document at all.')), await word(O.makeZip({ 'readme.txt': 'hello' })),
      await word(O.pptx()), await word(docx, 'powerpoint'), await word(O.xlsx()), await word(docx, 'excel'), await word(new Uint8Array(3)),
      await word(withDoctype), await word(O.u8('{\\rtf1 not a doc}'), 'excel'), await word(O.u8('nope'), 'epub'), await word(bomb),
    ];
    out.entities = entities.length > 0;
    return out;
  });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('relationships are resolved against their part, external ones kept apart', eq(r.rels, [
    'word/document.xml', 5, 'word/media/image1.png', null, true, 'https://example.com/', 'customXml/item1.xml', 'word/media/abs.png', null, 'word/styles.xml', null, 0, true,
  ]), r.rels);
  check("elements are read by local name and vocabulary, attributes by local name, and on/off properties as Word's", eq(r.nodes, [
    'document', 'WORD', 2, true, false, null, false, 24, 24, '00A1', 'preserve', ' Hello there', 'rId2', 'rId2', 'center', null, 1, null, 'p',
  ]), r.nodes);
  check('descendants go into the elements asked for', eq(r.visited, ['body', 'p', 'pPr', 'jc', 'r', 'rPr', 't', 'drawing', 'blip']), r.visited);
  check("a part that isn't there is null; names ignore case", eq(r.missing, [null, true, true]), r.missing);
  check('an XML part past the XML limit fails as too large', r.xmlCap[0]?.reason === 'too-large' && r.xmlCap[1]?.reason === 'too-large' && r.xmlCap[2] === 5000 && r.xmlCap[3], r.xmlCap);
  check('transitional and strict namespaces are both understood', eq(r.namespaces, ['WORD', 'DRAWING', 'SLIDE', 'WORD_DRAWING', 'PICTURE', 'COMPATIBILITY', 'MATH', 'VML', 'SHEET', 'OTHER', 'OTHER']), r.namespaces);
  const keys = r.verify.map((v) => (v ? [v.key, v.manyKey] : null));
  check('Office files of the right kind are accepted (strict ones and rooted names too)', eq(keys.slice(0, 4), [null, null, null, null]), keys.slice(0, 4));
  check('old binary files are refused with their own message', eq(keys.slice(4, 7), [
    ['office_legacy_word', 'office_legacy_word_many'], ['office_legacy_powerpoint', 'office_legacy_powerpoint_many'], ['office_legacy_excel', 'office_legacy_excel_many'],
  ]), keys.slice(4, 7));
  check('password-protected files are recognized', eq(keys.slice(7, 10), [
    ['office_encrypted', 'office_encrypted_many'], ['office_encrypted', 'office_encrypted_many'], ['office_encrypted_excel', 'office_encrypted_excel_many'],
  ]), keys.slice(7, 10));
  check('other files are not taken for Office files', eq(keys.slice(10, 21).map((k) => k?.[0]), [
    'office_not_word', 'office_not_word', 'office_not_word', 'office_not_powerpoint', 'office_not_word', 'office_not_excel', 'office_not_word',
    'office_not_word', 'office_not_excel', 'epub_not_recognized', null,
  ]), keys.slice(10, 21));
}

// ---------------------------------------------------------------------------------------------
// The dispatcher, with stand-in converters

const FAKE = (fn, verify = '') => `
import { OfficePdf } from './office-pdf.js';
import * as P from './problems.js';
import { ZipError } from './zip.js';
import { OfficePackage } from './ooxml.js';
${verify}
export async function ${fn}(input, options, hooks) {
  window.__calls = (window.__calls || 0) + 1;
  window.__options = options;
  switch (options.fake) {
    case 'nothing': throw new P.OfficeNothingToConvert();
    case 'embedded': throw new P.OfficeEmbeddedContent();
    case 'too-large': throw new P.OfficeTooLarge();
    case 'zip-too-large': throw new ZipError('too-large');
    case 'boom': throw new TypeError('a bug');
    case 'bytes': return new Uint8Array(0);
    default: break;
  }
  const pkg = input.name.endsWith('.epub') ? null : await OfficePackage.open(input.bytes, hooks);
  const pdf = await OfficePdf.create();
  for (let i = 1; i <= 2; i++) {
    if (options.fake === 'cancel' && i === 2) await new Promise((r) => setTimeout(r, 50));
    const c = pdf.startPage(612.4, 791.6);
    c.fillText('${fn} page ' + i + ' ' + JSON.stringify(options), 40, 60, { size: 9 });
    pdf.finishPage();
    hooks.onProgress?.(i, ${fn === 'convertDocx' ? 'null' : '2'});
    if (hooks.signal?.aborted) throw hooks.signal.reason;
  }
  return pdf.finish(hooks);
}`;

async function dispatcher(page, url) {
  const routes = {
    'docx.js': FAKE('convertDocx'), 'pptx.js': FAKE('convertPptx'), 'xlsx.js': FAKE('convertXlsx'),
    'epub.js': FAKE('convertEpub', `export async function verifyEpub(input) {
      if (new TextDecoder().decode(input.bytes).includes('DRM')) throw new P.EpubProtected();
      if (new TextDecoder().decode(input.bytes).includes('EMPTY')) throw new P.OfficeNothingToConvert();
    }`),
  };
  for (const [file, body] of Object.entries(routes)) {
    await page.route(`**/app/js/engine/office/${file}`, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
  }
  await setup(page, url);
  const r = await page.evaluate(async () => {
    const O = window.O;
    const I = O.index;
    const out = {};
    const item = (name, bytes) => ({ name, type: '', size: bytes.length, lastModified: 0, bytes });
    out.kinds = [
      I.officeKindOf(item('a.docx', O.docx())), I.officeKindOf(item('deck.pptx', O.pptx())), I.officeKindOf(item('book.xlsx', O.xlsx())),
      I.officeKindOf(item('b.epub', O.epub())), I.officeKindOf(item('old.doc', O.compound())), I.officeKindOf(item('old.xls', O.compound())),
      I.officeKindOf(item('x.pdf', O.u8('%PDF-1.4'))), I.officeKindOf(item('notes.txt', O.u8('hi'))), I.officeKindOf(item('renamed.bin', O.docx())),
    ];
    out.defaults = ['word', 'powerpoint', 'excel', 'epub'].map((k) => I.defaultOfficeOptions(k));
    out.normalized = [I.officeOptions('excel', { paper: 'tabloid', landscape: 'yes', fitWidth: 0, gridlines: 1 }), I.officeOptions('epub', { bookPage: 'a3' }), I.officeOptions('excel', { paper: 'a3', landscape: true, fitWidth: false, gridlines: true, name: 'x' })];
    out.unknownKind = await O.thrown(() => I.convertOffice('rtf', item('a.rtf', O.u8('x'))));
    out.names = [I.officeOutputName({ name: 'Report.docx' }, 'word'), I.officeOutputName({ name: 'Report.docx' }, 'word', 'My: report?'), I.officeOutputName({ name: '.docx' }, 'word'),
      I.officeOutputName({ name: '' }, 'excel'), I.officeOutputName({ name: 'Slides.final.pptx' }, 'powerpoint', '   '),
      I.officeOutputNames([{ name: 'a.docx' }, { name: 'b.docx' }, { name: 'c.docx' }], 'word', ['Garden report', null, 'garden report']),
      I.officeOutputNames([{ name: '' }, { name: '' }], 'epub')];
    // Converting through the kind's converter, with progress and the defaults.
    const progress = [];
    const deck = await I.convertOffice('powerpoint', item('Deck.pptx', O.pptx()), { name: 'Deck one' }, { onProgress: (d, t, info) => progress.push([d, t, !!info?.compressing]) });
    out.deck = [deck.name, deck.type, deck.pageCount, await O.pageCount(deck.bytes), await O.items(deck.bytes, 2), progress];
    const pdfDoc = await O.lib.PDFDocument.load(deck.bytes);
    out.pageSize = [pdfDoc.getPage(0).getWidth(), pdfDoc.getPage(0).getHeight()];
    const wordProgress = [];
    const doc = await I.convertOffice('word', item('Report.docx', O.docx()), {}, { onProgress: (d, t) => wordProgress.push([d, t]) });
    out.word = [doc.name, await O.items(doc.bytes), wordProgress];
    const sheet = await I.convertOffice('excel', item('Budget.xlsx', O.xlsx()), { paper: 'a4' });
    out.sheet = [sheet.name, await O.items(sheet.bytes)];
    const book = await I.convertOffice('epub', item('Novel.epub', O.epub()), {});
    out.book = [book.name, await O.items(book.bytes)];
    // The app's messages for each kind.
    const fail = (kind, name, bytes, options, hooks) => O.thrown(() => I.convertOffice(kind, item(name, bytes), options, hooks));
    window.__calls = 0;
    out.failures = [
      await fail('powerpoint', 'd.pptx', O.pptx(), { fake: 'nothing' }), await fail('excel', 'b.xlsx', O.xlsx(), { fake: 'nothing' }),
      await fail('epub', 'n.epub', O.epub(), { fake: 'nothing' }), await fail('word', 'w.docx', O.docx(), { fake: 'embedded' }),
      await fail('excel', 'b.xlsx', O.xlsx(), { fake: 'too-large' }), await fail('excel', 'b.xlsx', O.xlsx(), { fake: 'zip-too-large' }),
      await fail('word', 'w.docx', O.docx(), { fake: 'zip-too-large' }), await fail('word', 'w.docx', O.docx(), { fake: 'boom' }),
      await fail('powerpoint', 'd.pptx', O.pptx(), { fake: 'bytes' }),
    ];
    const calls = window.__calls;
    out.refusedFirst = [
      await fail('word', 'old.doc', O.compound()), await fail('excel', 'locked.xlsx', O.compound(O.concat(new Uint8Array(10), new Uint8Array([...'EncryptedPackage'].flatMap((c) => [c.charCodeAt(0), 0]))))),
      await fail('powerpoint', 'doc.pptx', O.docx()), await fail('epub', 'drm.epub', O.concat(O.epub(), O.u8('DRM'))), await fail('epub', 'e.epub', O.concat(O.epub(), O.u8('EMPTY'))),
      await fail('epub', 'not.epub', O.u8('not a book, just text')),
    ];
    out.callsWhenRefused = window.__calls - calls;
    const ac = new AbortController();
    const cancelling = fail('word', 'w.docx', O.docx(), { fake: 'cancel' }, { signal: ac.signal, onProgress: () => ac.abort(new O.errors.CancelledError()) });
    out.cancelled = await cancelling;
    out.keys = [
      I.officeErrorKey(new O.prob.OfficeTooLarge(), 'excel', true), I.officeErrorKey(new O.prob.OfficeNotRecognized(), 'epub'),
      I.officeErrorKey(new Error('x'), 'word'), I.officeErrorKey(new O.errors.UserError('web_fonts_unavailable'), 'word', true),
      I.officeErrorKey(new O.prob.EpubProtected(), 'epub', true), I.officeErrorKey(new O.prob.OfficeEncrypted(), 'powerpoint'),
    ];
    return out;
  });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('the kind of a file is told by its content, then its name', eq(r.kinds, ['word', 'powerpoint', 'excel', 'epub', 'word', 'excel', null, null, 'word']), r.kinds);
  check("each kind's options start as the app's", eq(r.defaults, [{}, {}, { paper: null, landscape: null, fitWidth: true, gridlines: false }, { bookPage: 'a5' }]), r.defaults);
  check('options are checked', eq(r.normalized, [
    { paper: null, landscape: null, fitWidth: true, gridlines: false }, { bookPage: 'a5' }, { paper: 'a3', landscape: true, fitWidth: false, gridlines: true, name: 'x' },
  ]), r.normalized);
  check('an unknown kind is a programming error', r.unknownKind?.name === 'RangeError', r.unknownKind);
  check('PDFs are named as the app names them', eq(r.names, [
    'Report.pdf', 'My_ report_.pdf', 'docx.pdf', 'Spreadsheet.pdf', 'Slides.final.pdf', ['Garden report.pdf', 'b.pdf', 'garden report (2).pdf'], ['Book.pdf', 'Book (2).pdf'],
  ]), r.names);
  check('a presentation converts through its converter, with progress', r.deck[0] === 'Deck one.pdf' && r.deck[1] === 'application/pdf' && r.deck[2] === 2 && r.deck[3] === 2 &&
    r.deck[4].includes('convertPptx page 2') && eq(r.deck[5], [[1, 2, false], [2, 2, false], [2, 2, true]]), r.deck);
  check('pages are whole points, as Android makes them', eq(r.pageSize, [612, 792]), r.pageSize);
  check("a Word document's progress has no total", r.word[0] === 'Report.pdf' && r.word[1].includes('convertDocx page 1 {}') && eq(r.word[2], [[1, null], [2, null], [2, 2]]), r.word);
  check('a workbook gets its sheet options', r.sheet[0] === 'Budget.pdf' && r.sheet[1].includes('"paper":"a4","landscape":null,"fitWidth":true,"gridlines":false'), r.sheet);
  check('a book gets its page size', r.book[0] === 'Novel.pdf' && r.book[1].includes('{"bookPage":"a5"}'), r.book);
  const keys = (list) => list.map((e) => e?.key ?? e?.name ?? null);
  check("converters' problems become the app's messages for the kind", eq(keys(r.failures), [
    'office_no_slides', 'office_no_sheets', 'epub_empty', 'office_embedded_content', 'office_too_large', 'office_too_large', 'office_convert_failed', 'office_convert_failed', 'office_convert_failed',
  ]) && r.failures[0].manyKey === 'office_no_slides_many', r.failures);
  check('files are checked before their converter runs', eq(keys(r.refusedFirst), [
    'office_legacy_word', 'office_encrypted_excel', 'office_not_powerpoint', 'epub_protected', 'epub_empty', 'epub_not_recognized',
  ]) && r.callsWhenRefused === 0, [r.refusedFirst, r.callsWhenRefused]);
  check('cancelling stops the conversion quietly', r.cancelled?.name === 'CancelledError', r.cancelled);
  check('error keys for one file and for several', eq(r.keys, ['office_too_large_many', 'epub_not_recognized', 'office_convert_failed', 'web_fonts_unavailable', 'epub_protected_many', 'office_encrypted']), r.keys);
}

// ---------------------------------------------------------------------------------------------
// DrawingML drawn into a PDF, checked by its pixels

/** Builds a page of shapes and pictures in the page; returns the PDF and what the readers read. */
async function drawingPdf(page) {
  return page.evaluate(async () => {
    const O = window.O;
    const { parseXml, OfficePackage } = O.ox;
    const D = O.dml;
    const { OfficeRect } = O.fmt;
    const halves = await O.png(100, 50, (ctx) => {
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 50, 50);
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(50, 0, 50, 50);
    });
    const big = await O.png(2000, 1000, (ctx) => {
      ctx.fillStyle = '#20a040';
      ctx.fillRect(0, 0, 2000, 1000);
    });
    const seeThrough = await O.png(40, 40, (ctx) => {
      ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
      ctx.fillRect(0, 0, 40, 40);
    });
    // A photo: colours changing all over, which a JPEG stores in far fewer bytes.
    const photo = await O.png(960, 720, (ctx) => {
      const img = ctx.createImageData(960, 720);
      let seed = 7;
      const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 41) - 20;
      for (let y = 0, i = 0; y < 720; y++) {
        for (let x = 0; x < 960; x++, i += 4) {
          img.data[i] = 120 + 80 * Math.sin(x / 37) + noise();
          img.data[i + 1] = 110 + 70 * Math.cos(y / 23) + noise();
          img.data[i + 2] = 100 + 60 * Math.sin((x + y) / 51) + noise();
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    });
    const slide = 'ppt/slides/slide1.xml';
    const pkg = await OfficePackage.open(O.makeZip({
      'ppt/slides/_rels/slide1.xml.rels': O.rels(['rId2', 'image', '../media/image1.png'], ['rId3', 'image', '../media/big.png'], ['rId4', 'image', '../media/broken.emf'], ['rId5', 'image', '../media/alpha.png']),
      'ppt/media/image1.png': halves, 'ppt/media/big.png': big, 'ppt/media/broken.emf': O.u8('\u0001\u0000\u0000\u0000 not a picture'), 'ppt/media/alpha.png': seeThrough, 'ppt/media/photo.png': photo,
    }));
    const theme = D.OfficeTheme.DEFAULT;
    const scheme = (n) => theme.color(n);
    const el = (xml) => parseXml(`<x xmlns:a="${O.A}" xmlns:r="${O.R}">${xml}</x>`).children()[0];
    const fill = (xml) => D.readFill(el(xml), pkg, slide, scheme);
    const line = (xml) => D.readOutline(el(xml), scheme);
    const read = {
      solid: fill('<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>'),
      grad: fill('<a:gradFill><a:gsLst><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>'),
      radial: fill('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100%"><a:srgbClr val="000000"/></a:gs></a:gsLst><a:path path="circle"/></a:gradFill>'),
      blip: fill('<a:blipFill><a:blip r:embed="rId2"/><a:srcRect l="50000"/><a:stretch/></a:blipFill>'),
      tile: fill('<a:blipFill><a:blip r:embed="rId2"/><a:tile/></a:blipFill>'),
      none: fill('<a:noFill/>'), patt: fill('<a:pattFill prst="pct5"><a:fgClr><a:srgbClr val="00FF00"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>'),
      group: fill('<a:grpFill/>'), other: fill('<a:ln/>'), emptyGrad: fill('<a:gradFill><a:gsLst/></a:gradFill>'), noBlip: fill('<a:blipFill><a:blip r:embed="rId9"/></a:blipFill>'),
      ln: line('<a:ln w="25400"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:prstDash val="dash"/><a:headEnd type="oval"/><a:tailEnd type="triangle" w="lg" len="sm"/></a:ln>'),
      lnNone: line('<a:ln w="12700"><a:noFill/></a:ln>'), lnPlain: line('<a:ln/>'), lnGrad: line('<a:ln><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="112233"/></a:gs><a:gs pos="1"><a:srgbClr val="445566"/></a:gs></a:gsLst></a:gradFill></a:ln>'),
      xfrm: D.readXfrm(el('<a:xfrm rot="5400000" flipH="1"><a:off x="12700" y="25400"/><a:ext cx="1270000" cy="635000"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="50"/></a:xfrm>')),
      guides: [...D.readAdjustments(el('<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/><a:gd name="adj2" fmla="*/ 1 2 3"/></a:avLst></a:prstGeom>'))],
      custom: D.readCustom(el('<a:custGeom><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="0" y="100"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>')),
      formulas: D.readCustom(el('<a:custGeom><a:pathLst><a:path><a:moveTo><a:pt x="wd2" y="0"/></a:moveTo></a:path></a:pathLst></a:custGeom>')),
      arc: D.readCustom(el('<a:custGeom><a:pathLst><a:path w="100" h="100" stroke="0"><a:moveTo><a:pt x="100" y="50"/></a:moveTo><a:arcTo wR="50" hR="50" stAng="0" swAng="21600000"/><a:close/></a:path></a:pathLst></a:custGeom>')),
    };

    const doc = await O.common.createPdf();
    const pageObj = doc.addPage([600, 800]);
    const c = new O.text.PdfCanvas(pageObj);
    const images = new O.opdf.OfficeImages(pkg, doc);
    const solid = (hex) => D.Fill.solid(0xff000000 + hex);
    const shape = (s) => { c.save(); D.drawShape(c, s, { picture: (f, r) => s.pictureObject }); c.restore(); };
    const R = (x, y, w, h) => new OfficeRect(x, y, w, h);
    shape({ rect: R(20, 20, 100, 60), geometry: 'rect', fill: solid(0xff0000) });
    shape({ rect: R(140, 20, 100, 60), geometry: 'ellipse', fill: solid(0x0000ff) });
    shape({ rect: R(260, 20, 100, 60), geometry: 'triangle', fill: solid(0x00a000) });
    shape({ rect: R(20, 100, 200, 40), geometry: 'rect', fill: read.grad });
    shape({ rect: R(240, 100, 80, 80), geometry: 'rect', fill: read.radial });
    shape({ rect: R(20, 200, 200, 0), geometry: 'straightConnector1', line: new D.Outline(0xff000000, 2, false, null, new D.LineEnd('triangle', 5, 5)) });
    shape({ rect: R(20, 230, 200, 30), geometry: 'rect', line: new D.Outline(0xff000000, 2, true) });
    shape({ rect: R(300, 200, 100, 20), rotation: 90, geometry: 'rect', fill: solid(0x800080) });
    const cropped = await images.picture(read.blip.path, 100, 50, read.blip.crop);
    shape({ picture: true, rect: R(400, 20, 100, 50), fill: read.blip, pictureObject: cropped });
    const whole = await images.picture(read.tile.path, 100, 50, null);
    shape({ picture: true, rect: R(400, 100, 100, 50), flipH: true, fill: read.tile, pictureObject: whole, line: new D.Outline(0xff000000, 1, false) });
    const broken = await images.picture('ppt/media/broken.emf', 80, 40, null);
    shape({ picture: true, rect: R(400, 180, 80, 40), fill: D.Fill.image('ppt/media/broken.emf'), pictureObject: broken });
    shape({ rect: R(20, 300, 100, 100), custom: read.custom, fill: solid(0xff8000) });
    shape({ rect: R(140, 300, 100, 100), geometry: 'star5', fill: solid(0x000000) });
    shape({ rect: R(260, 300, 100, 60), geometry: 'roundRect', adjust: new Map([['adj', 50000]]), fill: solid(0x008080) });
    shape({ rect: R(380, 300, 120, 60), geometry: 'rightArrow', fill: solid(0x404040) });
    shape({ rect: R(20, 420, 100, 40), geometry: 'rect', fill: D.Fill.solid(0x80ff0000) });
    shape({ rect: R(140, 420, 100, 60), geometry: 'bentConnector3', line: new D.Outline(0xff0000ff, 2, false, new D.LineEnd('oval', 3, 3), new D.LineEnd('arrow', 3, 3)) });
    shape({ rect: R(260, 420, 100, 60), geometry: 'line', fill: solid(0xff0000), line: new D.Outline(0xff000000, 1, false) });
    shape({ rect: R(380, 420, 100, 100), custom: read.arc, fill: solid(0x00ff00) });
    shape({ rect: R(20, 500, 80, 40), geometry: 'rect', fill: read.blip, pictureObject: cropped });
    shape({ rect: R(140, 500, 80, 40), geometry: 'curvedConnector3', line: new D.Outline(0xff000000, 1.5, false, null, new D.LineEnd('stealth', 3, 3)) });
    const alpha = await images.picture('ppt/media/alpha.png', 40, 40, null);
    shape({ picture: true, rect: R(260, 500, 40, 40), fill: D.Fill.image('ppt/media/alpha.png'), pictureObject: alpha });
    // The same big picture twice at one size: stored once, at 150 pixels per inch of its 1-inch width.
    const bigPicture = await images.picture('ppt/media/big.png', 72, 36, null);
    const again = await images.picture('ppt/media/big.png', 72, 36, null);
    shape({ picture: true, rect: R(320, 500, 72, 36), fill: D.Fill.image('ppt/media/big.png'), pictureObject: bigPicture });
    shape({ picture: true, rect: R(320, 540, 72, 36), fill: D.Fill.image('ppt/media/big.png'), pictureObject: again });
    // A photo 0.8 inch wide: 120 × 90 pixels.
    const photoPicture = await images.picture('ppt/media/photo.png', 57.6, 43.2, null);
    shape({ picture: true, rect: R(420, 600, 57.6, 43.2), fill: D.Fill.image('ppt/media/photo.png'), pictureObject: photoPicture });
    // A chart's stand-in, with its title.
    const chart = await O.opdf.StandInPicture.create('Sales by region');
    chart.draw(c, R(20, 600, 200, 100));
    O.opdf.StandInPicture.EMPTY.draw(c, { left: 240, top: 600, right: 300, bottom: 610 });
    const bytes = await O.common.savePdf(doc);
    return {
      bytes,
      read: JSON.parse(JSON.stringify(read, (k, v) => (v instanceof Map ? [...v] : v))),
      sizes: [bigPicture.image?.width, bigPicture.image?.height, bigPicture.image === again.image, broken.image, O.opdf.decodedSize(2000, 1000, 150, 75), O.opdf.decodedSize(4000, 3000, 800, 600), O.opdf.decodedSize(100, 100, 300, 300)],
    };
  });
}

async function drawing(page) {
  const { bytes, read, sizes } = await drawingPdf(page);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('fills are read: solid, gradients sorted, pictures with their crop, none, patterns', read.solid.type === 'solid' && read.solid.color === 0xffed7d31 &&
    eq(read.grad, { type: 'gradient', stops: [[0, 0xffff0000], [1, 0xff0000ff]], angle: 0, radial: false }) && read.radial.radial === true && read.radial.angle === 90 &&
    eq(read.blip, { type: 'image', path: 'ppt/media/image1.png', crop: [0.5, 0, 0, 0], tile: false }) && read.tile.tile === true && read.tile.crop === null &&
    read.none.type === 'none' && read.patt.color === 0xff00ff00 && read.group === null && read.other === null && read.emptyGrad.type === 'none' && read.noBlip.type === 'none', read);
  check('outlines are read: width, colour, dashes, arrowheads', read.ln.width === 2 && read.ln.color === 0xff00ff00 && read.ln.dashed === true &&
    eq(read.ln.head, { type: 'oval', width: 3, length: 3 }) && eq(read.ln.tail, { type: 'triangle', width: 5, length: 2 }) &&
    read.lnNone.color === null && read.lnNone.width === 0 && read.lnPlain.width === 0.75 && read.lnPlain.color === null && read.lnGrad.color === 0xff112233, read.ln);
  check('transforms are read: place, size, turn, flips, child frame', eq(read.xfrm, { rect: { x: 1, y: 2, width: 100, height: 50 }, rotation: 90, flipH: true, flipV: false, child: { offset: [0, 0], extent: [100 / 12700, 50 / 12700].map(Math.fround) } }), read.xfrm);
  check('adjustments are read, formulas left out', eq(read.guides, [['adj', 50000]]), read.guides);
  check('freeform paths are read; those with formulas left out', read.custom.length === 1 && eq(read.custom[0].kinds, ['moveTo', 'lnTo', 'lnTo', 'close']) && read.formulas.length === 0 && read.arc[0].stroked === false, read.custom);
  check('pictures are decoded no larger than 150 pixels per inch where they are shown, and stored once',
    eq(sizes, [150, 75, true, null, [150, 75], [1000, 750], [100, 100]]), sizes);

  const r = await page.evaluate(async (b) => {
    const O = window.O;
    const img = await O.render(b, 1, 2);
    const p = img.px;
    const text = await O.items(b);
    const images = await O.images(b);
    // Dark pixels along a row, and how often they turn on and off.
    const along = (y, x0, x1) => {
      let changes = 0;
      let prev = null;
      for (let x = x0; x <= x1; x += 0.5) {
        const dark = p(x, y)[0] < 128;
        if (prev !== null && dark !== prev) changes++;
        prev = dark;
      }
      return changes;
    };
    return {
      px: {
        rect: p(70, 50), outside: p(10, 10), ellipse: p(190, 50), ellipseCorner: p(143, 23), triangle: p(310, 75), triangleCorner: p(265, 25),
        gradLeft: p(22, 120), gradMid: p(120, 120), gradRight: p(218, 120), radialCentre: p(280, 140), radialCorner: p(242, 102),
        lineBody: p(100, 200), arrowWide: p(211, 197.5), arrowTip: p(218, 200), arrowPast: p(225, 200),
        rotatedIn: p(350, 170), rotatedOut: p(310, 210),
        cropLeft: p(410, 45), cropRight: p(490, 45), flipLeft: p(410, 125), flipRight: p(490, 125), flipBorder: p(400.2, 125),
        brokenBox: p(440, 200), brokenEdge: p(400.2, 200),
        customIn: p(30, 310), customOut: p(110, 390), star: p(190, 353), starOut: p(145, 305),
        roundCorner: p(261, 301), roundIn: p(310, 330), arrowHead: p(495, 330), arrowAbove: p(495, 305), arrowShaft: p(390, 330), arrowShaftAbove: p(390, 305),
        half: p(70, 440), bentMid: p(190, 450), bentStart: p(140, 420.5), bentOff: p(160, 450),
        lineFill: p(330, 430), lineStroke: p(310, 450),
        arcIn: p(430, 470), arcOut: p(382, 422),
        shapePicture: p(30, 520), shapePictureRight: p(95, 520),
        curveEnd: p(217, 540), alphaPicture: p(280, 520), bigPicture: p(356, 518),
        standIn: p(30, 610), standInEdge: p(20.2, 650), emptyStandIn: p(270, 605), photo: p(448, 621),
      },
      dashes: along(230, 25, 215),
      text,
      images,
    };
  }, bytes);
  const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const P = r.px;
  const white = [255, 255, 255];
  check('a solid rectangle is filled, nothing outside it', near(P.rect, [255, 0, 0]) && near(P.outside, white), [P.rect, P.outside]);
  check('an ellipse is filled inside, not in its corners', near(P.ellipse, [0, 0, 255]) && near(P.ellipseCorner, white), [P.ellipse, P.ellipseCorner]);
  check('a triangle has its point at the top', near(P.triangle, [0, 160, 0]) && near(P.triangleCorner, white), [P.triangle, P.triangleCorner]);
  check('a linear gradient goes from its first colour to its last', near(P.gradLeft, [255, 0, 0], 60) && near(P.gradRight, [0, 0, 255], 60) && P.gradMid[0] > 60 && P.gradMid[2] > 60, [P.gradLeft, P.gradMid, P.gradRight]);
  check('a radial gradient is lightest in the middle', P.radialCentre[0] > 200 && P.radialCorner[0] < 60, [P.radialCentre, P.radialCorner]);
  check('a line ends in its arrowhead, which is wider than the line', P.lineBody[0] < 80 && P.arrowWide[0] < 128 && P.arrowTip[0] < 128 && near(P.arrowPast, white), [P.lineBody, P.arrowWide, P.arrowTip, P.arrowPast]);
  check('a dashed outline is drawn in dashes', r.dashes >= 20, r.dashes);
  check('a shape turns about its centre', near(P.rotatedIn, [128, 0, 128]) && near(P.rotatedOut, white), [P.rotatedIn, P.rotatedOut]);
  check('a picture is cropped as its source rectangle says', near(P.cropLeft, [0, 0, 255], 60) && near(P.cropRight, [0, 0, 255], 60), [P.cropLeft, P.cropRight]);
  check('a flipped picture is mirrored, its outline drawn', near(P.flipLeft, [0, 0, 255], 60) && near(P.flipRight, [255, 0, 0], 60) && P.flipBorder[0] < 128, [P.flipLeft, P.flipRight, P.flipBorder]);
  check("a picture that can't be decoded shows as a grey box", near(P.brokenBox, [241, 241, 241], 6) && P.brokenEdge[0] < 230, [P.brokenBox, P.brokenEdge]);
  check('a freeform shape is filled where its path goes', near(P.customIn, [255, 128, 0]) && near(P.customOut, white), [P.customIn, P.customOut]);
  check('a star is filled in its middle, not its corners', near(P.star, [0, 0, 0]) && near(P.starOut, white), [P.star, P.starOut]);
  check('a rounded rectangle has round corners', near(P.roundCorner, white) && near(P.roundIn, [0, 128, 128]), [P.roundCorner, P.roundIn]);
  check('a right arrow has its head and shaft', near(P.arrowHead, [64, 64, 64]) && near(P.arrowAbove, white) && near(P.arrowShaft, [64, 64, 64]) && near(P.arrowShaftAbove, white),
    [P.arrowHead, P.arrowAbove, P.arrowShaft, P.arrowShaftAbove]);
  check('a see-through fill is blended', near(P.half, [255, 128, 128], 20), P.half);
  check('an elbow connector is drawn as an open line with its ends', P.bentMid[2] > 200 && P.bentMid[0] < 80 && P.bentStart[2] > 150 && near(P.bentOff, white), [P.bentMid, P.bentStart, P.bentOff]);
  check('a line shape is never filled', near(P.lineFill, white), P.lineFill);
  check('a freeform arc makes a full circle', near(P.arcIn, [0, 255, 0]) && near(P.arcOut, white), [P.arcIn, P.arcOut]);
  check('a shape filled with a picture shows it inside its outline', near(P.shapePicture, [0, 0, 255], 60), P.shapePicture);
  check('a curved connector ends in a stealth arrowhead', P.curveEnd[0] < 160, P.curveEnd);
  check('a see-through picture stays see-through', near(P.alphaPicture, [128, 128, 255], 30), P.alphaPicture);
  check('a large picture is drawn at its place', near(P.bigPicture, [32, 160, 64], 40), P.bigPicture);
  check("a chart's stand-in is a grey box with its title as text", near(P.standIn, [241, 241, 241], 6) && P.standInEdge[0] < 230 && r.text.includes('Sales by region') && near(P.emptyStandIn, [241, 241, 241], 6), [P.standIn, r.text]);
  const pictures = r.images.filter((i) => !i.mask);
  const big = pictures.find((i) => i.width === 150 && i.height === 75);
  const halves = pictures.find((i) => i.width === 100 && i.height === 50);
  const photo = pictures.find((i) => i.width === 120 && i.height === 90);
  const alpha = pictures.find((i) => i.smask);
  // As Compress PDF leaves the app's pictures: replaced by a JPEG only when that is smaller and the
  // picture took 2 KB or more, so flat ones shown large (logos, diagrams) keep sharp edges.
  check('a photo is stored as a JPEG', photo?.filter === '/DCTDecode' && !photo.smask, r.images);
  check('flat pictures are stored losslessly, without JPEG blocks', big?.filter === '/FlateDecode' && !big.smask && halves?.filter === '/FlateDecode' && !halves.smask, r.images);
  check('a see-through picture is stored losslessly with its transparency', alpha?.filter === '/FlateDecode' && pictures.filter((i) => i.width === 150).length === 1, r.images);
  check('a photo is drawn at its place', P.photo[0] > 20 && P.photo[1] > 20 && !near(P.photo, white, 10), P.photo);
}

// ---------------------------------------------------------------------------------------------
// Tables

async function tables(page) {
  const r = await page.evaluate(async () => {
    const O = window.O;
    const { CellBox, RowBlock, TableBlock, Border } = O.tables;
    const { StackBlock, Spaced, EmptyBlock } = O.blocks;
    const para = (text, width, style = {}) => O.text.layoutParagraph({ text, base: { size: 10, ...style }, width });
    const doc = await O.common.createPdf();
    const page1 = doc.addPage([400, 400]);
    const page2 = doc.addPage([400, 400]);
    const page3 = doc.addPage([400, 400]);
    const black = new Border(1, 0xff000000);
    const red = new Border(3, 0xffff0000);
    const widths = [100, 150, 100];
    const xs = [0, 100, 250];
    const pad = { padLeft: 5, padTop: 3, padRight: 5, padBottom: 3 };
    const cell = async (i, text, more = {}) => new CellBox({
      x: xs[i], width: widths[i], content: text == null ? null : new StackBlock([new Spaced(await para(text, widths[i] - 10, more.style), 0, 0)]),
      top: black, left: black, bottom: black, right: black, ...pad, ...more,
    });
    const header = new RowBlock([
      await cell(0, 'Name', { fill: 0xffddeeff, bottom: red }), await cell(1, 'Score', { fill: 0xffddeeff, bottom: red }), await cell(2, 'Notes', { fill: 0xffddeeff, bottom: red }),
    ], 0, false);
    // The note covers two rows: its upper cell has no bottom border, its lower one no top border and no content.
    const row2 = new RowBlock([await cell(0, 'Ann'), await cell(1, '90', { verticalAlign: 2 }), await cell(2, 'Merged note', { bottom: Border.NONE })], 40, false);
    const row3 = new RowBlock([await cell(0, 'Bob', { fill: 0xfffff2cc }), await cell(1, '85'), await cell(2, null, { top: Border.NONE })], 30, false);
    const table = new TableBlock([header, row2, row3], 1, 0);
    const c1 = new O.text.PdfCanvas(page1);
    table.draw(c1, 50, 50);
    const tops = [50, 50 + header.height, 50 + header.height + row2.height, 50 + table.height];
    // Split after the second row: the header repeats on the next page.
    const parts = table.split(header.height + row2.height + 5, false);
    const c2 = new O.text.PdfCanvas(page2);
    parts[1].draw(c2, 50, 50);
    // An exact row clips what doesn't fit; a long paragraph in a row splits between pages.
    const long = await para('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 60);
    const exact = new RowBlock([new CellBox({ x: 0, width: 80, content: long, top: black, bottom: black, left: black, right: black, fill: 0xffeeeeee })], 20, true);
    const c3 = new O.text.PdfCanvas(page3);
    exact.draw(c3, 50, 50);
    const splitting = new RowBlock([
      new CellBox({ x: 0, width: 80, content: long, ...pad }), new CellBox({ x: 80, width: 80, content: await para('short', 60), ...pad }),
    ], 0, false);
    const halves = splitting.split(40, false);
    halves[0].draw(c3, 50, 150);
    halves[1].draw(c3, 250, 150);
    const bytes = await O.common.savePdf(doc);
    // Blocks one under another, split as the app's StackBlock splits them.
    const stack = new StackBlock([new Spaced(new EmptyBlock(30), 5, 5), new Spaced(long, 10, 10), new Spaced(new EmptyBlock(20), 0, 0)]);
    const s1 = stack.split(100, false);
    const nothing = new StackBlock([new Spaced(long, 50, 0)]).split(55, false);
    const forced = new StackBlock([new Spaced(new EmptyBlock(500), 0, 0)]).split(100, true);
    const everything = stack.split(1000, false);
    const exactSplit = [exact.split(5, false), exact.split(5, true)?.[0] === exact];
    const tooTall = new TableBlock([header, new RowBlock([new CellBox({ x: 0, width: 80, content: new EmptyBlock(600), ...pad })], 0, false)], 1, 0);
    const forcedTable = tooTall.split(100, true);
    const cell2 = new CellBox({ x: 1, fill: 5 }).copy({ x: 2 });
    return {
      bytes, tops, heights: [header.height, row2.height, row3.height, table.height],
      split: [parts[0].rows.length, parts[1].rows.length, parts[1].headerRows, parts[0].height + parts[1].height > table.height],
      halves: [halves[0].height <= 40, halves[1] != null, halves[1]?.cells[1].content == null, halves[0].cells[1].content != null, long.lineCount],
      stack: [s1[0].height <= 100, s1[1] != null, s1[0].items.length, nothing, forced?.[0].height, everything[1], everything[0] === stack],
      exactSplit, forcedTable: [forcedTable?.[0].rows.length, forcedTable?.[1]?.rows.length ?? null], copied: [cell2.x, cell2.fill, cell2 instanceof CellBox],
    };
  });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('rows grow with their tallest cell, or keep their own height', r.heights[1] === 40 && r.heights[2] === 30 && r.heights[0] > 10 && r.heights[3] === r.heights[0] + 70, r.heights);
  check('a table splits after a row, its header repeated on the next page', eq(r.split, [2, 2, 1, true]), r.split);
  check('a row splits a long paragraph between pages, other cells staying above', eq(r.halves.slice(0, 4), [true, true, true, true]) && r.halves[4] > 3, r.halves);
  check('blocks one under another split as the app splits them', r.stack[0] && r.stack[1] && r.stack[2] === 2 && r.stack[3] === null && r.stack[4] === 500 && r.stack[5] === null && r.stack[6], r.stack);
  check('an exact row only splits when it must; a header with a row too tall for any page is forced through', r.exactSplit[0] === null && r.exactSplit[1] === true && eq(r.forcedTable, [2, null]), [r.exactSplit, r.forcedTable]);
  check('cells copy with changes', eq(r.copied, [2, 5, true]), r.copied);

  const p = await page.evaluate(async ({ bytes, tops }) => {
    const O = window.O;
    const one = await O.render(bytes, 1, 2);
    const two = await O.render(bytes, 2, 2);
    const three = await O.render(bytes, 3, 2);
    const darkest = (img, x0, x1, y0, y1) => {
      let best = [255, 255, 255];
      for (let y = y0; y <= y1; y += 0.5) for (let x = x0; x <= x1; x += 0.5) {
        const v = img.px(x, y);
        if (v[0] + v[1] + v[2] < best[0] + best[1] + best[2]) best = v;
      }
      return best;
    };
    return {
      text1: await O.items(bytes, 1), text2: await O.items(bytes, 2), text3: await O.items(bytes, 3),
      headerFill: one.px(140, tops[0] + 4), bobFill: one.px(140, tops[2] + 25),
      headerRule: one.px(205, tops[1] - 1.2),
      innerBorder: darkest(one, 149, 151, tops[1] + 10, tops[1] + 30),
      rowBorderLeft: darkest(one, 100, 110, tops[2] - 1, tops[2] + 1),
      mergedGap: darkest(one, 320, 330, tops[2] - 1, tops[2] + 1),
      outer: darkest(one, 400 - 1, 401, tops[1] + 5, tops[3] - 5),
      below: darkest(one, 60, 390, tops[3] + 3, tops[3] + 20),
      clippedBelow: darkest(three, 52, 128, 72, 120), exactFill: three.px(120, 60),
      page2Rule: two.px(205, tops[1] - 1.2),
    };
  }, r);
  check('cells are filled with their colours', O(p.headerFill, [0xdd, 0xee, 0xff], 8) && O(p.bobFill, [0xff, 0xf2, 0xcc], 8), [p.headerFill, p.bobFill]);
  check("each border is drawn in its width and colour, after every cell's fill", O(p.headerRule, [255, 0, 0], 60) && p.innerBorder[0] < 100 && p.rowBorderLeft[0] < 100 && p.outer[0] < 100, [p.headerRule, p.innerBorder, p.rowBorderLeft, p.outer]);
  check('a merged cell has no border across it', p.mergedGap[0] > 230, p.mergedGap);
  check('nothing is drawn below the table', p.below[0] > 240, p.below);
  check('table text reads row by row', /Name Score Notes Ann 90 Merged note Bob 85/.test(p.text1), p.text1);
  check("the next page starts with the header and the rows that didn't fit", /Name Score Notes Bob 85/.test(p.text2) && !p.text2.includes('Ann') && O(p.page2Rule, [255, 0, 0], 60), [p.text2, p.page2Rule]);
  check('an exact row clips what goes past it', p.clippedBelow[0] > 240 && O(p.exactFill, [0xee, 0xee, 0xee], 8), [p.clippedBelow, p.exactFill]);
  check("a split row's parts each have their share of the text", /^one two/.test(p.text3) && p.text3.includes('short') && p.text3.includes('sixteen'), p.text3);
}

function O(a, b, tol) {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

// ---------------------------------------------------------------------------------------------
// Pages, path measuring, and a large part read without freezing the page

async function pagesAndMeasures(page) {
  const r = await page.evaluate(async () => {
    const O = window.O;
    const pdf = await O.opdf.OfficePdf.create();
    const c = pdf.startPage(595.3, 841.6);
    const twice = await O.thrown(() => pdf.startPage(10, 10));
    c.fillText('first', 20, 40, { size: 12 });
    pdf.finishPage();
    pdf.startPage(0.2, NaN);
    pdf.finishPage();
    // A picture inside a line of text, from a plain zip (as e-books give them).
    const red = await O.png(20, 10, (ctx) => { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 20, 10); });
    const book = O.zip.ZipArchive.open(O.makeZip({ 'OEBPS/images/red.png': red }));
    const c3 = pdf.startPage(300, 200);
    const pictures = new O.opdf.OfficeImages(book, pdf.doc);
    const pic = await pictures.picture('OEBPS/images/red.png', 40, 20);
    const rich = new O.text.RichText().append('Before ', { size: 12 }).appendObject(O.opdf.inlinePicture(pic, 40, 20), { size: 12 }).append(' after', { size: 12 });
    const para = await O.text.layoutParagraph({ text: rich, width: 250 });
    para.draw(c3, 20, 20);
    pdf.finishPage();
    const { bytes, pageCount } = await pdf.finish();
    const inline = await O.render(bytes, 3, 2);
    const inlineText = await O.items(bytes, 3);
    const doc = await O.lib.PDFDocument.load(bytes);
    const sizes = doc.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    const { PdfPath } = O.text;
    const path = new PdfPath();
    path.moveTo(0, 0);
    path.lineTo(30, 40);
    path.bezierCurveTo(30, 40, 60, 80, 90, 120);
    const m = new O.pm.PathMeasure(path);
    const seg = new PdfPath();
    m.getSegment(25, 75, seg);
    const segMeasure = new O.pm.PathMeasure(seg);
    const two = new PdfPath();
    two.moveTo(0, 0); two.lineTo(10, 0); two.moveTo(5, 5); two.moveTo(20, 20); two.lineTo(20, 30);
    const tm = new O.pm.PathMeasure(two);
    const closed = new PdfPath();
    closed.rect(0, 0, 10, 10);
    const cm = new O.pm.PathMeasure(closed);
    // The line's baseline is at 20 + para.firstBaseline; the picture stands on it, 20 points tall.
    const base = 20 + para.firstBaseline;
    const xs = [];
    for (let x = 20; x < 270; x += 0.5) if (O.near(inline.px(x, base - 10), [255, 0, 0], 30)) xs.push(x);
    return {
      inline: [xs.length ? xs[xs.length - 1] - xs[0] : 0, inlineText, O.near(inline.px(xs[0] + 20, base + 2), [255, 255, 255], 30)],
      pageCount, sizes, twice: twice?.message, text: await O.items(bytes),
      measure: [m.length, m.getPosTan(0), m.getPosTan(50), m.getPosTan(150), segMeasure.length, m.getSegment(80, 70, new PdfPath())],
      contours: [tm.length, tm.nextContour(), tm.length, tm.nextContour()], closed: [cm.length, cm.isClosed, cm.getPosTan(15)],
    };
  });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('pages are started, finished and saved, sized in whole points', r.pageCount === 3 && eq(r.sizes, [[595, 842], [1, 1], [300, 200]]) && r.text === 'first' && r.twice === 'A page is already open', r);
  check('a picture sits inline on the baseline of its line, as wide as asked', Math.abs(r.inline[0] - 39.5) <= 1 && /Before\s*after/.test(r.inline[1]) && r.inline[2], r.inline);
  const [len, start, mid, end, segLen, empty] = r.measure;
  const near = (a, b, t = 0.05) => Math.abs(a - b) < t;
  check('paths are measured along lines and curves, as Android measures them',
    near(len, 150, 0.01) && near(start.x, 0) && near(start.tx, 0.6) && near(start.ty, 0.8) && near(mid.x, 30) && near(mid.y, 40) && near(end.x, 90) && near(end.y, 120) &&
    near(segLen, 50, 0.05) && empty === false, r.measure);
  check('a path in pieces has a contour for each; empty ones are skipped', eq(r.contours, [10, true, 10, false]), r.contours);
  check('a closed path counts its closing side', r.closed[0] === 40 && r.closed[1] === true && near(r.closed[2].x, 10) && near(r.closed[2].y, 5), r.closed);
}

async function largePart(page) {
  const r = await page.evaluate(async () => {
    const O = window.O;
    // A sheet of 400,000 cells, about 13 million characters of XML.
    const rows = [];
    for (let i = 1; i <= 40000; i++) {
      let row = `<row r="${i}">`;
      for (let j = 0; j < 10; j++) row += `<c r="${String.fromCharCode(65 + j)}${i}" s="1"><v>${i * j}</v></c>`;
      rows.push(row + '</row>');
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${O.S}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
    const pkg = await O.ox.OfficePackage.open(O.makeZip({ 'xl/worksheets/sheet1.xml': xml }));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const t = performance.now();
    const root = await pkg.xml('xl/worksheets/sheet1.xml');
    const ms = performance.now() - t;
    clearInterval(timer);
    const data = root.child('sheetData');
    const count = data.el.childElementCount;
    const last = data.children().at(-1).children().at(-1);
    return { chars: xml.length, ms, ticks, count, last: [last.attr('r'), last.child('v').text()] };
  });
  check('a large part is read in seconds', r.ms < 8000 && r.count === 40000 && r.last[0] === 'J40000' && r.last[1] === String(40000 * 9), { ms: Math.round(r.ms), chars: r.chars, last: r.last });
  check('the page stays responsive while a large part is read', r.ticks >= 2, r.ticks);
}

/**
 * In a tab in the background, timers run once a second at most: the pauses between slices are new
 * tasks instead, so reading a large part there takes no longer. Timers are slowed so here.
 */
async function backgroundTab(page) {
  const slowed = await page.evaluate(async () => {
    const O = window.O;
    const rows = [];
    for (let i = 1; i <= 20000; i++) rows.push(`<row r="${i}"><c r="A${i}"><v>${i}</v></c><c r="B${i}" t="inlineStr"><is><t>Row ${i} of a long sheet</t></is></c></row>`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${O.S}"><sheetData>${rows.join('').repeat(4)}</sheetData></worksheet>`;
    const pkg = await O.ox.OfficePackage.open(O.makeZip({ 'xl/worksheets/sheet1.xml': xml }));
    const real = window.setTimeout;
    let timers = 0;
    window.setTimeout = (fn, ms, ...rest) => {
      if (!(ms > 0)) timers++;
      return real(fn, Math.max(1000, ms || 0), ...rest);
    };
    try {
      const t = performance.now();
      const root = await pkg.xml('xl/worksheets/sheet1.xml');
      const guarded = await O.guard.guardXmlAsync('<a>' + '<b>x</b>'.repeat(1200000) + '</a>');
      return { ms: performance.now() - t, timers, rows: root.child('sheetData').el.childElementCount, guarded: guarded.length };
    } finally {
      window.setTimeout = real;
    }
  });
  check('a large part reads as fast in a tab in the background', slowed.ms < 6000 && slowed.timers === 0 && slowed.rows === 80000 && slowed.guarded === 1200000 * 8 + 7, { ...slowed, ms: Math.round(slowed.ms) });
}

/** A picture's lossless stream, deflated only as far as needed to tell it from its JPEG's size. */
async function deflating(page) {
  const deflated = await page.evaluate(() => {
    const O = window.O;
    const { deflateBelow } = O.opdf;
    const flat = new Uint8Array(300 * 200 * 3).fill(200);
    const noisy = new Uint8Array(300 * 200 * 3);
    let seed = 3;
    for (let i = 0; i < noisy.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      noisy[i] = seed & 255;
    }
    const whole = deflateBelow(flat);
    const back = O.fflate.unzlibSync(whole);
    return {
      flat: whole.length, same: back.length === flat.length && back.every((v) => v === 200),
      flatUnder: deflateBelow(flat, 2048)?.length ?? null, noisyStopped: deflateBelow(noisy, 5000), noisyAll: deflateBelow(noisy).length,
      tiny: O.fflate.unzlibSync(deflateBelow(new Uint8Array([1, 2, 3]))).join(),
    };
  });
  check('a lossless stream is a zlib stream, given up once past the limit', deflated.same && deflated.flat < 2048 && deflated.flatUnder === deflated.flat &&
    deflated.noisyStopped === null && deflated.noisyAll > 150000 && deflated.tiny === '1,2,3', deflated);
}

// ---------------------------------------------------------------------------------------------

await withPage(async (page, url) => {
  await setup(page, url);
  await formats(page);
  await colors(page);
  await guard(page);
  await brokenXml(page);
  await zips(page);
  await packages(page);
  await drawing(page);
  await tables(page);
  await pagesAndMeasures(page);
  await largePart(page);
  await backgroundTab(page);
  await deflating(page);
}, { viewport: { width: 1366, height: 900 }, mobile: false });
console.log(`Chromium: ${passed} checks passed`);

await withPage(async (page, url) => {
  await dispatcher(page, url);
});
console.log(`Dispatcher: ${passed} checks passed`);

for (const browser of ['firefox', 'webkit']) {
  const before = passed;
  // Firefox writes each XML error DOMParser meets to the console: those (and only those) are let
  // through there, so broken XML is checked in every browser.
  await withPage(async (page, url) => {
    await setup(page, url);
    await formats(page);
    await colors(page);
    await guard(page, { quick: true });
    await brokenXml(page);
    await zips(page, { quick: true });
    await packages(page);
    await drawing(page);
    await tables(page);
    await backgroundTab(page);
    await deflating(page);
  }, { browser, allowConsole: browser === 'firefox' ? [/XML Parsing Error/] : [] });
  console.log(`${browser}: ${passed - before} checks passed`);
}

console.log(`office-core: all ${passed} checks passed`);
