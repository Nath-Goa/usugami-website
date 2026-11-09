// Word, PowerPoint, Excel and EPUB to PDF (js/tools/office): the one screen of the four tools driven
// in the app as a person would, by touch at phone size and by mouse and keyboard at desktop size.
// Documents are made here with fflate: good ones, old binary files, password-protected ones, files
// of another kind, a book with DRM, and files that pass the check but can't be converted. Every PDF
// made is read back with pdf.js (names, page counts, page sizes, text, bookmarks, gridline pixels).
// The app's own device tests (BatchToolsDeviceTest.kt, ScreensDeviceTest.kt) are ported: files left
// out are named with the reason, those with the same reason together; a broken file in a batch is
// named and the others are still made; books share the page size chosen.
//
// Run with: node tests/office-ui.test.mjs   (--quick: Chromium only, no screenshots)
// Screenshots go to .tmp/office-ui/screens/ to be looked at.
import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { withPage, assert, root } from './harness.mjs';
import { zipSync } from '../site/app/js/lib/fflate.js';
import common from '../site/app/locales/en/common.js';
import kit from '../site/app/locales/en/kit.js';
import office from '../site/app/locales/en/office.js';

const QUICK = process.argv.includes('--quick');
const shots = join(root, '.tmp', 'office-ui', 'screens');
await mkdir(shots, { recursive: true });
const appRes = join(root, '..', 'pdfer', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
const exists = (p) => access(p).then(() => true, () => false);

const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 900 };

// ---------------------------------------------------------------------------------------------
// Strings, as the screen should show them

const S = { ...common, ...kit, ...office };
const fill = (text, args) => text.replace(/\{(\d+)\}/g, (m, n) => String(args[n - 1] ?? m));
const say = (key, ...args) => fill(typeof S[key] === 'string' ? S[key] : S[key].other, args);
const sayN = (key, count, ...args) => {
  const v = S[key];
  return fill(count === 1 ? v.one : v.other, args.length ? args : [count]);
};

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
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;

// ---------------------------------------------------------------------------------------------
// Fixtures, made with fflate

const enc = new TextEncoder();
const u8 = (v) => (typeof v === 'string' ? enc.encode(v) : v);
/** A zip of `files` (name → text or bytes), in order; `stored` names are kept uncompressed. */
function zip(files, stored = []) {
  const entries = {};
  for (const [name, v] of Object.entries(files)) entries[name] = [u8(v), { level: stored.includes(name) ? 0 : 6 }];
  return Buffer.from(zipSync(entries));
}

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const rels = (...list) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">` +
  list.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${R}/${type}" Target="${target}"/>`).join('') + '</Relationships>';
const types = (overrides) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  overrides + '</Types>';

const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLS_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EPUB_TYPE = 'application/epub+zip';

/**
 * A Word document on US Letter pages of `paragraphs` ('\f' is a page break). With `broken`, its
 * text is cut short: the start reads as a Word document, the rest doesn't.
 */
function docx(paragraphs, { broken = false } = {}) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = paragraphs.map((p) => (p === '\f'
    ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
    : `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
  return zip({
    '[Content_Types].xml': types(`<Override PartName="/word/document.xml" ContentType="${WORD_TYPE}.main+xml"/>`),
    '_rels/.rels': rels(['officeDocument', 'word/document.xml']),
    'word/document.xml': broken ? doc.slice(0, Math.floor(doc.length * 0.6)) : doc,
  });
}

/** A 720 × 540 point presentation of `slides` ({ text, hidden }); with `broken`, that slide's XML is cut short. */
function pptx(slides, { broken = -1 } = {}) {
  const EMU = 12700;
  const NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:r="${R}"`;
  const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
  const box = (text) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text 2"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>` +
    `<a:xfrm><a:off x="${36 * EMU}" y="${36 * EMU}"/><a:ext cx="${600 * EMU}" cy="${100 * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="4000"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const files = {
    '[Content_Types].xml': types(`<Override PartName="/ppt/presentation.xml" ContentType="${PPT_TYPE}.main+xml"/>`),
    '_rels/.rels': rels(['officeDocument', 'ppt/presentation.xml']),
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldIdLst>` +
      slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('') +
      `</p:sldIdLst><p:sldSz cx="${720 * EMU}" cy="${540 * EMU}"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(...slides.map((_, i) => ['slide', `slides/slide${i + 1}.xml`])),
  };
  slides.forEach((s, i) => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${tree}${box(s.text)}</p:spTree></p:cSld></p:sld>`;
    files[`ppt/slides/slide${i + 1}.xml`] = i === broken ? xml.slice(0, Math.floor(xml.length / 2)) : xml;
  });
  return zip(files);
}

/** A workbook of `sheets` ({ name, rows: [[cell...]...] }, cells text or numbers), each sheet printing as it says (nothing: US Letter, portrait). */
function xlsx(sheets) {
  const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const column = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
  const cell = (v, ref) => (v == null ? '' : typeof v === 'number'
    ? `<c r="${ref}"><v>${v}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${v}</t></is></c>`);
  const files = {
    '[Content_Types].xml': types(`<Override PartName="/xl/workbook.xml" ContentType="${XLS_TYPE}.main+xml"/>`),
    '_rels/.rels': rels(['officeDocument', 'xl/workbook.xml']),
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${R}"><sheets>` +
      sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 2}"/>`).join('') + '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': rels(['styles', 'styles.xml'], ...sheets.map((_, i) => ['worksheet', `worksheets/sheet${i + 1}.xml`])),
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>',
  };
  sheets.forEach((s, i) => {
    const data = s.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, `${column(c)}${r + 1}`)).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}" xmlns:r="${R}"><sheetData>${data}</sheetData></worksheet>`;
  });
  return zip(files);
}

/** A small EPUB 3 book called `title` with one chapter (the app's test book); with `drm`, its text is marked as encrypted. */
function epub(title, { heading = 'The First Tale', drm = false } = {}) {
  const files = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:identifier id="id">x</dc:identifier></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
    'c1.xhtml': `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>1</title></head><body><h1>${heading}</h1><p>Once upon a time.</p></body></html>`,
  };
  if (drm) files['META-INF/encryption.xml'] = '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>';
  return zip(files, ['mimetype']);
}

/** How an old binary Office file (.doc, .ppt, .xls) starts. */
const OLD_DOC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
const legacy = (extra = 1024) => Buffer.concat([OLD_DOC, Buffer.alloc(extra)]);
/** A password-protected Office file: a compound file with an EncryptedPackage stream. */
const encrypted = () => Buffer.concat([OLD_DOC, Buffer.alloc(512), Buffer.from('EncryptedPackage', 'utf16le'), Buffer.alloc(512)]);

const file = (name, buffer, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer });

const FX = {
  garden: file('Garden report.docx', docx(['Riverside Community Garden', 'Spring planting plan', '\f', 'Second page of the plan']), WORD_TYPE),
  second: file('Second.docx', docx(['Seed list', 'Beans and peas']), WORD_TYPE),
  minutes: file('minutes.doc', legacy(1024), 'application/msword'),
  agenda: file('agenda.doc', legacy(2048), 'application/msword'),
  notes: file('notes.docx', Buffer.from('just some notes'), WORD_TYPE),
  locked: file('locked.docx', encrypted(), WORD_TYPE),
  brokenDocx: file('broken.docx', docx(['Riverside Community Garden', 'More text that is cut off before the end'], { broken: true }), WORD_TYPE),
  deck: file('deck.pptx', pptx([{ text: 'First slide' }, { text: 'Hidden slide', hidden: true }, { text: 'Last slide' }]), PPT_TYPE),
  brokenDeck: file('broken.pptx', pptx([{ text: 'Fine slide' }, { text: 'Broken slide' }], { broken: 1 }), PPT_TYPE),
  onlyHidden: file('hidden.pptx', pptx([{ text: 'Secret', hidden: true }]), PPT_TYPE),
  budget: file('Budget.xlsx', xlsx([{ name: 'Costs', rows: [['Seeds', 12.5, null], [null, null, null], ['Tools', 40, 'paid']] }]), XLS_TYPE),
  wide: file('Wide.xlsx', xlsx([{ name: 'Wide', rows: [Array.from({ length: 20 }, (_, i) => 1000 + i)] }]), XLS_TYPE),
  oldXls: file('ledger.xls', legacy(1024), 'application/vnd.ms-excel'),
  lockedXlsx: file('salaries.xlsx', encrypted(), XLS_TYPE),
  tiny: file('Tiny Tales.epub', epub('Tiny Tales'), EPUB_TYPE),
  stories: file('Short Stories.epub', epub('Short Stories', { heading: 'Short Stories' }), EPUB_TYPE),
  drm: file('locked.epub', epub('Locked', { drm: true }), EPUB_TYPE),
  notBook: file('notes.epub', Buffer.from('Not a book at all'), EPUB_TYPE),
};

// ---------------------------------------------------------------------------------------------
// Reading PDFs back, in the page

/** Each page's size (as shown) and text, and the bookmarks' titles. */
async function readBack(page, bytes) {
  return page.evaluate(async (b64) => {
    const { openPdfJs } = await import(new URL('js/lib/pdfjs.js', location.href).href);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await openPdfJs(data);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      const content = await p.getTextContent();
      pages.push({ width: vp.width, height: vp.height, text: content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim() });
    }
    const outline = (await doc.getOutline())?.map((o) => o.title) ?? [];
    await doc.loadingTask.destroy();
    return { pages, outline };
  }, Buffer.from(bytes).toString('base64'));
}

/** How many light gray pixels a line across page 1 crosses, `y` points from its top (gridlines). */
async function grayAcross(page, bytes, y) {
  return page.evaluate(async ({ b64, y }) => {
    const { openPdfJs } = await import(new URL('js/lib/pdfjs.js', location.href).href);
    const doc = await openPdfJs(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const g = canvas.getContext('2d');
    await p.render({ canvas, canvasContext: g, viewport: vp }).promise;
    const row = g.getImageData(0, Math.round(y * 2), canvas.width, 1).data;
    let gray = 0;
    for (let i = 0; i < row.length; i += 4) {
      const [r, gg, b] = [row[i], row[i + 1], row[i + 2]];
      if (r < 250 && r > 120 && Math.abs(r - gg) < 12 && Math.abs(r - b) < 12) gray++;
    }
    await doc.loadingTask.destroy();
    return gray;
  }, { b64: Buffer.from(bytes).toString('base64'), y });
}

// ---------------------------------------------------------------------------------------------
// Driving the app

/** Waits for `selector`, discarding unsaved work when leaving a screen asks about it. */
async function arrive(page, selector) {
  const discard = `dialog[open] .ui-btn:has-text("${S.discard}")`;
  await page.waitForSelector(`${selector}, ${discard}`, { timeout: 20000 });
  if (await page.$(discard)) await page.click(discard);
  await page.waitForSelector(selector, { timeout: 20000 });
}

/** Opens the tool afresh: by way of Home when the app already shows, so it mounts anew. */
async function openTool(page, url, tool) {
  if (page.url().includes('/app/')) {
    await page.evaluate(() => { location.hash = '#/'; });
    await arrive(page, '#app .screen[data-route="home"]:not([aria-busy])');
    await page.evaluate((id) => { location.hash = '#/tool/' + id; }, tool);
  } else {
    await page.goto(url + 'app/#/tool/' + tool);
    await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  }
  await arrive(page, `#app .screen[data-tool="${tool}"]:not([aria-busy]) .office-content`);
  await snackbarsGone(page);
}

async function press(page, selector, { touch }) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  if (touch) await target.tap(); else await target.click();
}

/** Picks `files` with the button `selector` opens; in Firefox they are dropped on the screen instead. */
async function pickWith(page, selector, files, { touch = false, browser = 'chromium' } = {}) {
  // Playwright's Firefox fires the input's cancel event before its change event (a real Firefox
  // doesn't), so there the files are dropped instead.
  if (browser === 'firefox') return drop(page, files, (await page.$('.ui-empty')) ? '.ui-empty' : '.office-page');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), press(page, selector, { touch })]);
  ok(chooser.isMultiple(), 'several can be picked at once');
  await chooser.setFiles(files);
}

/** Drops files on `target`, as dragged from the computer's files. */
async function drop(page, files, target) {
  const dt = await page.evaluateHandle((list) => {
    const data = new DataTransfer();
    for (const { name, type, b64 } of list) data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type }));
    return data;
  }, files.map((f) => ({ name: f.name, type: f.mimeType, b64: f.buffer.toString('base64') })));
  await page.dispatchEvent(target, 'dragenter', { dataTransfer: dt });
  ok(await page.evaluate((t) => document.querySelector(t).classList.contains('is-dragover'), target), 'shows where they go');
  await page.dispatchEvent(target, 'drop', { dataTransfer: dt });
}

/** Waits until `n` files are listed and none is being checked. */
async function listed(page, n) {
  await page.waitForFunction((n) => {
    const shown = n === 0 ? document.querySelector('.office-content--empty')
      : n === 1 ? document.querySelector('.office-content--one .office-card')
        : document.querySelectorAll('.office-content--many .ui-batch-item').length === n;
    return shown && document.querySelector('.office-progress')?.hidden;
  }, n, { timeout: 30000 });
  checks++;
}

const cardNames = (page) => page.$$eval('.office-content .ui-file-card .ui-file-name', (els) => els.map((e) => e.textContent));
const cardDetails = (page) => page.$$eval('.office-content .ui-file-card .ui-file-detail', (els) => els.map((e) => e.textContent));
const nameFields = (page) => page.$$eval('.office-content .ui-field-input', (els) => els.map((e) => e.value));
const runLabel = (page) => page.textContent('.office-run');
const handleState = (page) => page.evaluate(async () => (await import(new URL('js/core/router.js', location.href).href)).currentHandle().state);
const sizeText = (page, n) => page.evaluate(async (n) => (await import(new URL('js/core/i18n.js', location.href).href)).formatSize(n), n);
/** The order of what the screen shows, by kind of part. */
const layout = (page) => page.$$eval('.office-content > *', (els) => els.map((e) => {
  const c = e.classList;
  if (c.contains('ui-empty')) return 'empty';
  if (c.contains('office-card')) return 'card';
  if (c.contains('office-add')) return 'add';
  if (c.contains('office-note')) return 'note';
  if (c.contains('office-heading')) return 'heading';
  if (c.contains('office-book-page')) return 'sizes';
  if (c.contains('office-detail')) return 'detail';
  if (c.contains('office-sheet')) return 'sheet';
  if (c.contains('office-name')) return 'name';
  if (c.contains('office-list')) return 'list';
  return e.className;
}));

/** The next snackbar's text (waiting for it), after which it is sent away. */
async function nextSnack(page) {
  const text = await page.waitForFunction(() => {
    const s = [...document.querySelectorAll('.ui-snackbar')].find((n) => n.classList.contains('is-shown'));
    return s ? s.querySelector('.ui-snackbar-text').textContent : null;
  }, null, { timeout: 30000 }).then((h) => h.jsonValue());
  await page.evaluate((t) => [...document.querySelectorAll('.ui-snackbar')].find((n) => n.querySelector('.ui-snackbar-text').textContent === t)?.dismiss(), text);
  await page.waitForFunction((t) => ![...document.querySelectorAll('.ui-snackbar-text')].some((n) => n.textContent === t), text, { timeout: 5000 });
  return text;
}
async function snack(page, expected, what) {
  eq(await nextSnack(page), expected, what);
}
async function noSnack(page, ms = 600) {
  await page.waitForTimeout(ms);
  eq(await page.$$eval('.ui-snackbar-text', (els) => els.map((e) => e.textContent)), [], 'nothing more said');
}
async function snackbarsGone(page) {
  await page.evaluate(() => document.querySelectorAll('.ui-snackbar').forEach((s) => s.dismiss?.()));
}

/** Presses the main button and waits for the result screen; returns its files. */
async function runToResult(page, { touch }) {
  await press(page, '.office-run', { touch });
  await page.waitForSelector('.ui-result', { timeout: 120000 });
  return resultFiles(page);
}
async function resultFiles(page) {
  const files = await page.evaluate(() => {
    const b64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return document.querySelector('.ui-result').files.map((f) => ({ name: f.name, type: f.type, pageCount: f.pageCount, b64: b64(f.bytes) }));
  });
  return files.map((f) => ({ ...f, bytes: new Uint8Array(Buffer.from(f.b64, 'base64')) }));
}
async function backToEditing(page, { browserBack = false, touch = false } = {}) {
  if (browserBack) await page.goBack();
  else await press(page, '.ui-result .ui-topbar-nav', { touch });
  await page.waitForSelector('.ui-result', { state: 'detached' });
  await page.waitForSelector('.office-content');
  checks++;
}

async function checkNoSideways(page, what) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `${what}: nothing scrolls sideways (${overflow} px)`);
}

async function shot(page, name, { full = true } = {}) {
  if (QUICK) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full });
}
async function themes(page, name, options) {
  if (QUICK) return;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(page, `${name}-${scheme}`, options);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

// ---------------------------------------------------------------------------------------------
// In Node: the strings

async function testStrings() {
  const xml = await readFile(appRes, 'utf8').catch(() => null);
  if (!xml) {
    console.log('skip strings.xml check (the app is not next to the site)');
    return;
  }
  const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/%(\d)\$[sd]/g, '{$1}').replace(/%[sd]/g, '{1}').replace(/%%/g, '%');
  const strings = new Map();
  for (const m of xml.matchAll(/<string name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) strings.set(m[1], unescape(m[2]));
  const plurals = new Map();
  for (const m of xml.matchAll(/<plurals name="([^"]+)"[^>]*>([\s\S]*?)<\/plurals>/g)) {
    const forms = {};
    for (const f of m[2].matchAll(/<item quantity="([a-z]+)">([\s\S]*?)<\/item>/g)) forms[f[1]] = unescape(f[2]);
    plurals.set(m[1], forms);
  }
  for (const [key, value] of Object.entries(office)) {
    if (key.startsWith('web_')) continue;
    if (typeof value === 'string') eq(value, strings.get(key), `office.js ${key} as in strings.xml`);
    else eq(value, plurals.get(key), `office.js ${key} (plural) as in strings.xml`);
  }
  for (const key of Object.keys(office)) ok(!(key in common), `office.js doesn't redefine common.js's ${key}`);
  for (const key of Object.keys(office)) ok(!(key in kit), `office.js doesn't redefine kit.js's ${key}`);
  // Every key the screen and its engines can say is defined.
  const said = ['pick_word', 'pick_powerpoint', 'pick_excel', 'pick_epub', 'add_word', 'add_powerpoint', 'add_excel', 'add_epub',
    'document_word', 'document_powerpoint', 'document_excel', 'document_epub', 'office_note_word', 'office_note_powerpoint',
    'office_note_excel', 'office_note_epub', 'book_page_note', 'sheet_as_file', 'convert', 'convert_many', 'creating_pdf', 'creating_pdfs',
    'progress_slides', 'progress_chapter', 'office_convert_failed', 'web_fonts_unavailable'];
  for (const k of ['office_legacy_word', 'office_legacy_powerpoint', 'office_legacy_excel', 'office_encrypted', 'office_encrypted_excel',
    'office_not_word', 'office_not_powerpoint', 'office_not_excel', 'epub_not_recognized', 'epub_protected', 'office_no_slides',
    'office_no_sheets', 'epub_empty', 'office_embedded_content', 'office_too_large', 'web_office_too_large']) said.push(k, k + '_many');
  for (const k of said) ok(k in S, `${k} is defined`);
  for (const k of ['office_note_word', 'office_note_powerpoint', 'office_note_excel', 'office_note_epub']) {
    ok(!/phone/.test(S['web_' + k]), `web_${k} doesn't speak of a phone`);
  }
}

// ---------------------------------------------------------------------------------------------
// In the page: the helpers and the progress dialog

async function testHelpers(page, url) {
  await page.goto(url + 'app/#/');
  await page.waitForSelector('html[data-ready="true"]');
  const out = await page.evaluate(async () => {
    const at = (p) => import(new URL(p, location.href).href);
    const i18n = await at('js/core/i18n.js');
    await i18n.loadStrings('office');
    const { officeProgressView, officeProgressDialog } = await at('js/tools/office/progress.js');
    const { officeNames, messageKey } = await at('js/tools/office/index.js');
    const index = await at('js/engine/office/index.js');
    const v = (...a) => officeProgressView(...a);
    const views = {
      wordNone: v(null, 'word'),
      wordPage: v({ done: 3, total: null }, 'word'),
      wordCompressing: v({ done: 5, total: 5, compressing: true }, 'word'),
      slides: v({ done: 2, total: 6 }, 'powerpoint'),
      oneSlide: v({ done: 1, total: 1 }, 'powerpoint'),
      pages: v({ done: 1, total: 4 }, 'excel'),
      chapter: v({ done: 2, total: 9 }, 'epub'),
      zeroTotal: v({ done: 0, total: 0 }, 'excel'),
      manyNone: v(null, 'word', true, null),
      manyStart: v(null, 'word', true, { number: 2, total: 4, name: 'b.docx' }),
      manyWord: v({ done: 7, total: null }, 'word', true, { number: 2, total: 4, name: 'b.docx' }),
      manySlides: v({ done: 3, total: 6 }, 'powerpoint', true, { number: 1, total: 2, name: 'a.pptx' }),
      manyCompressing: v({ done: 6, total: 6, compressing: true }, 'powerpoint', true, { number: 2, total: 2, name: 'b.pptx' }),
    };
    const names = {
      own: officeNames([{ name: 'Report.docx' }, { name: 'Notes.docx' }], 'word'),
      typed: officeNames([{ name: 'a.docx' }, { name: 'b.docx' }], 'word', ['Garden report', 'garden report']),
      blank: officeNames([{ name: 'a.xlsx' }], 'excel', ['  ']),
      unsafe: officeNames([{ name: 'a.epub' }], 'epub', ['My: book?']),
      nameless: officeNames([{ name: '' }, { name: '' }, { name: '.pptx' }], 'powerpoint'),
    };
    const tooLarge = new index.OfficeTooLarge();
    const keys = {
      tooLarge: messageKey(tooLarge, 'excel'),
      tooLargeMany: messageKey(tooLarge, 'excel', true),
      legacy: messageKey(new index.OfficeLegacyFormat(), 'epub'),
      other: messageKey(new Error('x'), 'word'),
    };
    // The dialog itself, shown at once.
    let cancelled = 0;
    const d = officeProgressDialog({ kind: 'powerpoint', many: true, delay: 0, onCancel: () => cancelled++ });
    const read = () => ({
      title: d.el.querySelector('.ui-dialog-title').textContent,
      label: d.el.querySelector('.ui-progress-label').hidden ? null : d.el.querySelector('.ui-progress-label').textContent,
      detail: d.el.querySelector('.ui-progress-detail').hidden ? null : d.el.querySelector('.ui-progress-detail').textContent,
      step: d.el.querySelector('.office-progress-step').hidden ? null : d.el.querySelector('.office-progress-step').textContent,
      bar: d.el.querySelector('.ui-progress').classList.contains('is-indeterminate') ? null : d.el.querySelector('.ui-progress').getAttribute('aria-valuenow'),
      live: d.el.querySelector('.ui-progress-label').getAttribute('aria-live'),
      stepLive: d.el.querySelector('.office-progress-step').getAttribute('aria-live'),
    });
    const seen = [read()];
    d.next(1, 2, 'deck.pptx');
    seen.push(read());
    d.progress(1, 4);
    seen.push(read());
    d.progress(4, 4, { compressing: true });
    seen.push(read());
    d.next(2, 2, 'talk.pptx');
    seen.push(read());
    d.el.querySelector('.ui-dialog-actions .ui-btn').click();
    const cancelText = d.el.querySelector('.ui-dialog-actions .ui-btn').textContent;
    await d.close();
    const one = officeProgressDialog({ kind: 'word', delay: 0 });
    const oneSeen = [];
    const readOne = () => ({
      title: one.el.querySelector('.ui-dialog-title').textContent,
      step: one.el.querySelector('.office-progress-step').hidden ? null : one.el.querySelector('.office-progress-step').textContent,
      label: one.el.querySelector('.ui-progress-label').hidden ? null : one.el.querySelector('.ui-progress-label').textContent,
      indeterminate: one.el.querySelector('.ui-progress').classList.contains('is-indeterminate'),
    });
    oneSeen.push(readOne());
    one.progress(2, null);
    oneSeen.push(readOne());
    one.progress(2, 2, { compressing: true });
    oneSeen.push(readOne());
    await one.close();
    return { views, names, keys, seen, cancelled, cancelText, oneSeen };
  });
  const r = (f) => (f == null ? null : Math.round(f * 1000) / 1000);
  const view = (x) => ({ fraction: r(x.fraction), text: x.text });
  const V = out.views;
  eq(view(V.wordNone), { fraction: null, text: null }, 'Word before any page: a bar without end');
  eq(view(V.wordPage), { fraction: null, text: say('pdf_page_number', 3) }, 'Word: "Page 3", its count unknown');
  eq(view(V.wordCompressing), { fraction: null, text: null }, 'one file being compressed: the bar runs, no line');
  eq(view(V.slides), { fraction: 0.333, text: sayN('progress_slides', 6, 2, 6) }, 'PowerPoint: 2 of 6 slides');
  eq(view(V.oneSlide), { fraction: 1, text: sayN('progress_slides', 1, 1, 1) }, 'one slide: "1 of 1 slide"');
  eq(view(V.pages), { fraction: 0.25, text: sayN('progress_pages', 4, 1, 4) }, 'Excel: 1 of 4 pages');
  eq(view(V.chapter), { fraction: 0.222, text: say('progress_chapter', 2, 9) }, 'EPUB: Chapter 2 of 9');
  eq(view(V.zeroTotal), { fraction: null, text: null }, 'a total of 0 counts as unknown');
  eq(view(V.manyNone), { fraction: null, text: null }, 'several, before the first starts: a bar without end');
  eq(view(V.manyStart), { fraction: 0.25, text: null }, 'several: the second of four starts at a quarter');
  eq(view(V.manyWord), { fraction: 0.25, text: say('pdf_page_number', 7) }, 'several Word files: the bar moves per file');
  eq(view(V.manySlides), { fraction: 0.25, text: sayN('progress_slides', 6, 3, 6) }, 'several: half of the first of two');
  eq(view(V.manyCompressing), { fraction: 1, text: null }, 'several: the last one compressed fills the bar');

  eq(out.names.own, ['Report', 'Notes'], 'each PDF is named after its file');
  eq(out.names.typed, ['Garden report', 'garden report (2)'], 'two asking for one name are told apart, ignoring case');
  eq(out.names.blank, ['Spreadsheet'], "a blank name becomes the kind's");
  eq(out.names.unsafe, ['My_ book_'], 'a name is made safe');
  eq(out.names.nameless, ['Presentation', 'Presentation (2)', 'pptx'], "nameless files get the kind's name (a name that is only an extension keeps it, as FileNames.baseName)");

  eq(out.keys, { tooLarge: 'web_office_too_large', tooLargeMany: 'web_office_too_large_many', legacy: 'office_legacy_powerpoint', other: 'office_convert_failed' },
    'messages in the web wording where the app says "on a phone"');

  const [start, first, part, squeezed, second] = out.seen;
  eq(start.title, say('creating_pdfs'), 'several: "Creating and compressing PDFs…"');
  eq([start.label, start.detail, start.step, start.bar], [null, null, null, null], 'before the first: only a bar without end');
  eq([first.label, first.detail, first.step, first.bar], [say('batch_progress', 1, 2), 'deck.pptx', null, '0'], 'PDF 1 of 2 and its name');
  eq([part.label, part.detail, part.step, part.bar], [say('batch_progress', 1, 2), 'deck.pptx', sayN('progress_slides', 4, 1, 4), '13'], 'its slides under it, the bar an eighth on');
  eq([squeezed.step, squeezed.bar], [null, '50'], 'compressing: no line, the first file done');
  eq([second.label, second.detail, second.step, second.bar], [say('batch_progress', 2, 2), 'talk.pptx', null, '50'], 'the next file');
  eq(first.live, 'polite', '"PDF 1 of 2" is read out as it changes');
  eq(first.stepLive, null, 'the slides line is not read out at every slide');
  eq([out.cancelled, out.cancelText], [1, say('cancelling')], 'Cancel calls back and says "Cancelling…"');
  eq(out.oneSeen, [
    { title: say('creating_pdf'), step: null, label: null, indeterminate: true },
    { title: say('creating_pdf'), step: say('pdf_page_number', 2), label: null, indeterminate: true },
    { title: say('creating_pdf'), step: null, label: null, indeterminate: true },
  ], 'one Word file: "Creating and compressing PDF…", "Page 2", the bar without end');
}

// ---------------------------------------------------------------------------------------------
// Word to PDF

async function testWord(page, url, { touch, label }) {
  await openTool(page, url, 'word');
  const at = `word ${label}`;
  eq(await page.textContent('.ui-topbar h1'), say('tool_word'), `${at}: the title`);
  eq(await page.textContent('.ui-empty-title'), say('pick_word'), `${at}: "Choose Word files"`);
  eq(await page.textContent('.ui-empty-detail'), say('pick_several_hint'), `${at}: several can be chosen`);
  eq(await runLabel(page), say('convert'), `${at}: the main button`);
  ok(await page.$eval('.office-run', (b) => b.disabled), `${at}: nothing to convert yet`);
  await checkNoSideways(page, `${at} empty`);
  await themes(page, `word-${label}-empty`);

  // One old .doc picked alone: the message without its name, and nothing listed.
  await pickWith(page, '.ui-empty', [FX.minutes], { touch });
  await snack(page, say('office_legacy_word'), `${at}: an old .doc says what to do`);
  await listed(page, 0);
  // A password-protected one.
  await pickWith(page, '.ui-empty', [FX.locked], { touch });
  await snack(page, say('office_encrypted'), `${at}: a protected file says so`);
  await listed(page, 0);

  // Several, some that can't be converted: those with the same reason named together, worded for them all.
  await pickWith(page, '.ui-empty', [FX.minutes, FX.garden, FX.notes, FX.agenda], { touch });
  await snack(page, say('file_problem', 'minutes.doc, agenda.doc', say('office_legacy_word_many')), `${at}: two old files named together`);
  await snack(page, say('file_problem', 'notes.docx', say('office_not_word')), `${at}: one that isn't a Word document`);
  await listed(page, 1);
  eq(await cardNames(page), ['Garden report.docx'], `${at}: the document's card`);
  eq(await cardDetails(page), [say('result_details', say('document_word'), await sizeText(page, FX.garden.buffer.length))], `${at}: "Word document · size"`);
  eq(await page.getAttribute('.office-card .ui-file-head .ui-icon-btn', 'aria-label'), say('remove_file', 'Garden report.docx'), `${at}: Remove names it`);
  eq(await nameFields(page), ['Garden report'], `${at}: the PDF is named after it`);
  eq(await page.textContent('.office-note'), say('web_office_note_word'), `${at}: what converts`);
  eq(await layout(page), ['card', 'add', 'note', 'name'], `${at}: one file's screen in the app's order`);
  eq(await page.textContent('.office-add'), say('add_word'), `${at}: "Add Word files"`);
  eq(await runLabel(page), say('convert'), `${at}: one file's button`);
  ok(await page.$eval('.office-card .ui-file-thumb .office-doc-icon svg', (s) => !!s), `${at}: the document's icon stands for its first page`);
  await checkNoSideways(page, `${at} one`);
  await themes(page, `word-${label}-one`);

  // Converted as one file: the name typed.
  await page.fill('.office-name .ui-field-input', 'My plan');
  let files = await runToResult(page, { touch });
  eq(files.map((f) => f.name), ['My plan.pdf'], `${at}: named as typed`);
  let back = await readBack(page, files[0].bytes);
  eq(back.pages.length, 2, `${at}: two pages`);
  ok(near(back.pages[0].width, 612) && near(back.pages[0].height, 792), `${at}: US Letter, as the document says`);
  ok(back.pages[0].text.includes('Riverside Community Garden'), `${at}: its text is real text`);
  ok(back.pages[1].text.includes('Second page of the plan'), `${at}: the page break is kept`);
  eq(await page.textContent('.ui-result-heading'), say('result_heading_one'), `${at}: "Your PDF is ready"`);
  await page.waitForFunction(() => document.querySelector('.ui-result-details')?.textContent.includes('·'));
  ok((await page.textContent('.ui-result-details')).startsWith(sayN('page_count', 2)), `${at}: "2 pages · size"`);
  ok(await page.$('.ui-result .ui-result-unsaved'), `${at}: not saved yet`);
  await checkNoSideways(page, `${at} result`);
  await themes(page, `word-${label}-result`);
  const unsaved = await handleState(page);
  ok(unsaved.result, `${at}: the result shows`);

  // Back to the document: still there, with the name typed.
  await backToEditing(page, { touch });
  await listed(page, 1);
  eq(await nameFields(page), ['My plan'], `${at}: the name typed is kept`);

  // More added: the list, each with its own name. One named as another is told apart.
  await pickWith(page, '.office-add', [FX.second, FX.brokenDocx], { touch });
  await listed(page, 3);
  eq(await layout(page), ['note', 'list', 'add'], `${at}: several files' screen in the app's order`);
  eq(await cardNames(page), ['Garden report.docx', 'Second.docx', 'broken.docx'], `${at}: in the order picked`);
  eq(await nameFields(page), ['My plan', 'Second', 'broken'], `${at}: each with its name`);
  eq(await runLabel(page), sayN('convert_many', 3), `${at}: "Convert 3 files to PDF"`);
  await page.fill('.ui-batch-item:nth-child(2) .ui-field-input', 'my PLAN');
  await checkNoSideways(page, `${at} many`);
  await themes(page, `word-${label}-many`);
  files = await runToResult(page, { touch });
  // The broken one is named, and the others are still made.
  await snack(page, sayN('batch_failed', 1, 1, 'broken.docx'), `${at}: the broken file is named`);
  eq(files.map((f) => f.name), ['My plan.pdf', 'my PLAN (2).pdf'], `${at}: told apart`);
  eq(await page.textContent('.ui-result-heading'), say('result_heading_many'), `${at}: "Your PDFs are ready"`);
  back = await readBack(page, files[1].bytes);
  ok(back.pages[0].text.includes('Seed list'), `${at}: the second is the second document`);
  ok(await page.$('.ui-result .ui-btn:has-text("' + say('zip_button') + '")'), `${at}: several can be saved as a ZIP`);
  await themes(page, `word-${label}-result-many`);

  // The browser's Back returns to the files; one removed is forgotten.
  await backToEditing(page, { browserBack: true });
  await listed(page, 3);
  await press(page, '.ui-batch-item:nth-child(3) .ui-file-head .ui-icon-btn', { touch });
  await listed(page, 2);
  eq((await handleState(page)).documents.map((d) => d.outputName), ['My plan', 'my PLAN'], `${at}: the names typed stay`);
  await press(page, '.ui-batch-item:nth-child(1) .ui-file-head .ui-icon-btn', { touch });
  await listed(page, 1);
  eq(await cardNames(page), ['Second.docx'], `${at}: the other is left`);
  eq(await nameFields(page), ['my PLAN'], `${at}: with its name`);
  // Remove on one file's card starts over.
  await press(page, '.office-card .ui-file-head .ui-icon-btn', { touch });
  await listed(page, 0);

  // A broken file alone: the message, no result.
  await pickWith(page, '.ui-empty', [FX.brokenDocx], { touch });
  await listed(page, 1);
  await press(page, '.office-run', { touch });
  await snack(page, say('office_convert_failed'), `${at}: one file that can't be converted says so`);
  ok(!(await page.$('.ui-result')), `${at}: no result`);
  await page.waitForFunction(() => document.activeElement?.classList.contains('office-run'));
  ok(true, `${at}: the focus is back on the main button`);

  // Start over on the result asks first while it isn't saved.
  await press(page, '.office-card .ui-file-head .ui-icon-btn', { touch });
  await listed(page, 0);
  await pickWith(page, '.ui-empty', [FX.second], { touch });
  await listed(page, 1);
  await runToResult(page, { touch });
  await press(page, `.ui-result .ui-btn:has-text("${say('start_over')}")`, { touch });
  await page.waitForSelector(`dialog[open] .ui-dialog-title:has-text("${say('start_over_title')}")`);
  await press(page, `dialog[open] .ui-btn:has-text("${say('start_over')}")`, { touch });
  await page.waitForSelector('.ui-result', { state: 'detached' });
  await listed(page, 0);
  // After Start over, the next document's name shows, not the one before's.
  await pickWith(page, '.ui-empty', [FX.garden], { touch });
  await listed(page, 1);
  eq(await nameFields(page), ['Garden report'], `${at}: the next document's own name`);
}

// ---------------------------------------------------------------------------------------------
// PowerPoint to PDF

async function testPowerPoint(page, url, { touch, label }) {
  await openTool(page, url, 'powerpoint');
  const at = `powerpoint ${label}`;
  eq(await page.textContent('.ui-empty-title'), say('pick_powerpoint'), `${at}: "Choose PowerPoint files"`);
  // A Word document isn't a presentation.
  await pickWith(page, '.ui-empty', [FX.garden], { touch });
  await snack(page, say('office_not_powerpoint'), `${at}: a Word document is refused`);
  await listed(page, 0);
  await pickWith(page, '.ui-empty', [FX.deck], { touch });
  await listed(page, 1);
  eq(await cardDetails(page), [say('result_details', say('document_powerpoint'), await sizeText(page, FX.deck.buffer.length))], `${at}: "PowerPoint presentation · size"`);
  eq(await page.textContent('.office-note'), say('web_office_note_powerpoint'), `${at}: what converts`);
  eq(await page.textContent('.office-add'), say('add_powerpoint'), `${at}: "Add PowerPoint files"`);
  await themes(page, `powerpoint-${label}-one`);
  let files = await runToResult(page, { touch });
  eq(files.map((f) => f.name), ['deck.pdf'], `${at}: named after the presentation`);
  let back = await readBack(page, files[0].bytes);
  eq(back.pages.length, 2, `${at}: three slides, one hidden: two pages`);
  ok(near(back.pages[0].width, 720) && near(back.pages[0].height, 540), `${at}: the slides' size`);
  ok(back.pages[0].text.includes('First slide') && back.pages[1].text.includes('Last slide'), `${at}: the slides in order, the hidden one left out`);
  await backToEditing(page, { touch });

  // A broken one and one with only hidden slides added: each named with its reason, the deck still made.
  await pickWith(page, '.office-add', [FX.brokenDeck, FX.onlyHidden], { touch });
  await listed(page, 3);
  eq(await runLabel(page), sayN('convert_many', 3), `${at}: "Convert 3 files to PDF"`);
  await themes(page, `powerpoint-${label}-many`);
  files = await runToResult(page, { touch });
  await snack(page, say('file_problem', 'hidden.pptx', say('office_no_slides')), `${at}: no slides to convert, named`);
  await snack(page, sayN('batch_failed', 1, 1, 'broken.pptx'), `${at}: the broken one, named`);
  eq(files.map((f) => f.name), ['deck.pdf'], `${at}: the others are still made`);
  await themes(page, `powerpoint-${label}-result`);
}

// ---------------------------------------------------------------------------------------------
// Excel to PDF

/** The chosen item of the dropdown chip `nth` (1: Page size, 2: Orientation) set to `text`, by touch, mouse or keyboard. */
async function choose(page, nth, text, { touch, keyboard = false }) {
  const chip = `.office-chips > .ui-chip:nth-child(${nth})`;
  if (keyboard) {
    await page.focus(chip);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ui-menu');
    const labels = await page.$$eval('.ui-menu .ui-menu-item', (els) => els.map((e) => e.textContent.trim()));
    const at = labels.indexOf(text);
    const from = await page.evaluate(() => [...document.querySelectorAll('.ui-menu .ui-menu-item')].indexOf(document.activeElement));
    for (let i = Math.max(0, from); i < at; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  } else {
    await press(page, chip, { touch });
    await page.waitForSelector('.ui-menu');
    await press(page, `.ui-menu .ui-menu-item:has-text("${text}")`, { touch });
  }
  await page.waitForSelector('.ui-menu', { state: 'detached' });
}

async function testExcel(page, url, { touch, label }) {
  await openTool(page, url, 'excel');
  const at = `excel ${label}`;
  eq(await page.textContent('.ui-empty-title'), say('pick_excel'), `${at}: "Choose Excel files"`);
  await pickWith(page, '.ui-empty', [FX.oldXls, FX.lockedXlsx, FX.budget], { touch });
  await snack(page, say('file_problem', 'ledger.xls', say('office_legacy_excel')), `${at}: an old .xls`);
  await snack(page, say('file_problem', 'salaries.xlsx', say('office_encrypted_excel')), `${at}: a protected workbook, Excel's wording`);
  await listed(page, 1);
  eq(await layout(page), ['card', 'add', 'note', 'sheet', 'name'], `${at}: the choices come after what converts`);
  eq(await page.textContent('.office-note'), say('web_office_note_excel'), `${at}: what converts`);
  const chips = await page.$$eval('.office-chips > .ui-chip', (els) => els.map((e) => e.textContent.trim()));
  eq(chips, [say('option_value', say('option_page_size'), say('sheet_as_file')), say('option_value', say('option_orientation'), say('sheet_as_file'))],
    `${at}: paper and orientation as in the file`);
  const switches = await page.$$eval('.office-sheet .ui-switch-row', (rows) => rows.map((r) => ({
    label: r.querySelector('.ui-switch-label').textContent, detail: r.querySelector('.ui-switch-detail').textContent, on: r.querySelector('[role=switch]').getAttribute('aria-checked'),
  })));
  eq(switches, [
    { label: say('sheet_fit_width'), detail: say('sheet_fit_width_on'), on: 'true' },
    { label: say('sheet_gridlines'), detail: say('sheet_gridlines_detail'), on: 'false' },
  ], `${at}: Fit columns to page width on, Gridlines off`);
  await themes(page, `excel-${label}-one`);

  // As the file says: US Letter, portrait; no gridlines.
  let files = await runToResult(page, { touch });
  eq(files.map((f) => f.name), ['Budget.pdf'], `${at}: named after the workbook`);
  let back = await readBack(page, files[0].bytes);
  ok(near(back.pages[0].width, 612) && near(back.pages[0].height, 792), `${at}: US Letter when a sheet names no paper`);
  ok(back.pages[0].text.includes('Seeds') && back.pages[0].text.includes('12.5') && back.pages[0].text.includes('paid'), `${at}: the cells' values`);
  // Row 2 is empty: a line across it crosses only gridlines.
  const plain = await grayAcross(page, files[0].bytes, 54 + 15 + 7.5);
  await backToEditing(page, { touch });

  // A4 landscape, gridlines: the menu shows the choices, the chosen one checked.
  await press(page, '.office-chips > .ui-chip:nth-child(1)', { touch });
  await page.waitForSelector('.ui-menu');
  eq(await page.$$eval('.ui-menu .ui-menu-item', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('aria-checked')])), [
    [say('sheet_as_file'), 'true'], [say('size_a4'), 'false'], [say('size_letter'), 'false'], [say('size_legal'), 'false'], [say('size_a3'), 'false'], [say('size_a5'), 'false'],
  ], `${at}: the papers, as in the file checked`);
  await themes(page, `excel-${label}-menu`, { full: false });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ui-menu', { state: 'detached' });
  await choose(page, 1, say('size_a4'), { touch, keyboard: !touch });
  await choose(page, 2, say('orientation_landscape'), { touch, keyboard: !touch });
  eq(await page.$$eval('.office-chips > .ui-chip', (els) => els.map((e) => e.textContent.trim())),
    [say('option_value', say('option_page_size'), say('size_a4')), say('option_value', say('option_orientation'), say('orientation_landscape'))], `${at}: the chips say what is chosen`);
  if (touch) await press(page, '.office-sheet .ui-switch-row:nth-child(3)', { touch });
  else {
    await page.focus('.office-sheet .ui-switch-row:nth-child(3) [role=switch]');
    await page.keyboard.press('Space');
  }
  eq(await page.getAttribute('.office-sheet .ui-switch-row:nth-child(3) [role=switch]', 'aria-checked'), 'true', `${at}: Gridlines on`);
  eq((await handleState(page)).options, { paper: 'a4', landscape: true, fitWidth: true, gridlines: true }, `${at}: the choices`);
  await themes(page, `excel-${label}-options`);
  files = await runToResult(page, { touch });
  back = await readBack(page, files[0].bytes);
  ok(near(back.pages[0].width, 842) && near(back.pages[0].height, 595), `${at}: A4 landscape for every sheet (${back.pages[0].width} × ${back.pages[0].height})`);
  const lined = await grayAcross(page, files[0].bytes, 54 + 15 + 7.5);
  ok(lined > plain + 2, `${at}: gridlines between the cells (${plain} → ${lined} gray pixels)`);
  await backToEditing(page, { touch });

  // A wide sheet: on one page across while Fit columns to page width is on, more pages when off.
  await press(page, '.office-card .ui-file-head .ui-icon-btn', { touch });
  await listed(page, 0);
  eq((await handleState(page)).options.paper, 'a4', `${at}: the choices stay while the screen shows`);
  await pickWith(page, '.ui-empty', [FX.wide, FX.budget], { touch });
  await listed(page, 2);
  eq(await layout(page), ['note', 'sheet', 'list', 'add'], `${at}: the choices for all come before the files`);
  await themes(page, `excel-${label}-many`);
  files = await runToResult(page, { touch });
  eq(files.map((f) => f.name), ['Wide.pdf', 'Budget.pdf'], `${at}: one PDF of each`);
  const fitted = (await readBack(page, files[0].bytes)).pages.length;
  await backToEditing(page, { touch });
  if (touch) await press(page, '.office-sheet .ui-switch-row:nth-child(2)', { touch });
  else await page.click('.office-sheet .ui-switch-row:nth-child(2) [role=switch]');
  eq(await page.textContent('.office-sheet .ui-switch-row:nth-child(2) .ui-switch-detail'), say('sheet_fit_width_off'), `${at}: what Fit off does`);
  files = await runToResult(page, { touch });
  const unfitted = (await readBack(page, files[0].bytes)).pages.length;
  ok(fitted === 1 && unfitted > 1, `${at}: Fit columns to page width (${fitted} page, then ${unfitted} without)`);
}

// ---------------------------------------------------------------------------------------------
// EPUB to PDF

async function testEpub(page, url, { touch, label, browser = 'chromium' }) {
  await openTool(page, url, 'epub');
  const at = `epub ${label}`;
  eq(await page.textContent('.ui-empty-title'), say('pick_epub'), `${at}: "Choose EPUB files"`);
  ok(await page.$eval('.office-run', (b) => b.disabled), `${at}: nothing to convert yet`);
  // A file that isn't a book, and a book with DRM.
  await pickWith(page, '.ui-empty', [FX.notBook], { touch, browser });
  await snack(page, say('epub_not_recognized'), `${at}: not a book`);
  await pickWith(page, '.ui-empty', [FX.drm], { touch, browser });
  await snack(page, say('epub_protected'), `${at}: a book with DRM`);
  await listed(page, 0);

  await pickWith(page, '.ui-empty', [FX.tiny], { touch, browser });
  await listed(page, 1);
  eq(await cardNames(page), ['Tiny Tales.epub'], `${at}: the book's card`);
  eq(await cardDetails(page), [say('result_details', say('document_epub'), await sizeText(page, FX.tiny.buffer.length))], `${at}: "EPUB e-book · size"`);
  eq(await nameFields(page), ['Tiny Tales'], `${at}: the file name`);
  eq(await layout(page), ['card', 'add', 'note', 'heading', 'sizes', 'detail', 'name'], `${at}: the page size after what converts`);
  eq(await page.textContent('.office-note'), say('web_office_note_epub'), `${at}: what converts`);
  eq(await page.textContent('.office-heading'), say('option_page_size'), `${at}: "Page size"`);
  eq(await page.textContent('.office-detail'), say('book_page_note'), `${at}: what each size suits`);
  const segments = () => page.$$eval('.office-book-page .ui-segment', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('aria-checked')]));
  eq(await segments(), [[say('size_a5'), 'true'], [say('size_a4'), 'false']], `${at}: A5 is the default`);
  eq(await page.$eval('.office-book-page', (g) => document.getElementById(g.getAttribute('aria-labelledby'))?.textContent), say('option_page_size'), `${at}: the choice is named by its heading`);
  await checkNoSideways(page, `${at} one`);
  await themes(page, `epub-${label}-one`);

  // A5: about a paperback's.
  let files = await runToResult(page, { touch });
  let back = await readBack(page, files[0].bytes);
  eq(files.map((f) => f.name), ['Tiny Tales.pdf'], `${at}: named after the book`);
  ok(near(back.pages[0].width, 420) && near(back.pages[0].height, 595), `${at}: A5 pages (${back.pages[0].width} × ${back.pages[0].height})`);
  await backToEditing(page, { touch });

  // A4, with the keyboard or a tap; then a second book: they share the page size chosen.
  if (touch) await press(page, `.office-book-page .ui-segment:has-text("${say('size_a4')}")`, { touch });
  else {
    await page.focus('.office-book-page .ui-segment[aria-checked="true"]');
    await page.keyboard.press('ArrowRight');
  }
  eq(await segments(), [[say('size_a5'), 'false'], [say('size_a4'), 'true']], `${at}: A4 chosen`);
  await pickWith(page, '.office-add', [FX.stories], { touch, browser });
  await listed(page, 2);
  eq(await layout(page), ['note', 'heading', 'sizes', 'detail', 'list', 'add'], `${at}: the page size for all, then the books`);
  eq(await segments(), [[say('size_a5'), 'false'], [say('size_a4'), 'true']], `${at}: A4 still chosen`);
  await checkNoSideways(page, `${at} many`);
  await themes(page, `epub-${label}-many`);
  files = await runToResult(page, { touch });
  eq(files.map((f) => f.name), ['Tiny Tales.pdf', 'Short Stories.pdf'], `${at}: each named after its book`);
  for (const f of files) {
    back = await readBack(page, f.bytes);
    ok(near(back.pages[0].width, 595) && near(back.pages[0].height, 842), `${at}: ${f.name} on A4`);
  }
  back = await readBack(page, files[0].bytes);
  ok(back.pages.some((p) => p.text.includes('Once upon a time.')), `${at}: the book's text`);
  eq(back.outline[0], 'The First Tale', `${at}: the table of contents becomes bookmarks`);
  ok((await readBack(page, files[1].bytes)).pages.some((p) => p.text.includes('Short Stories')), `${at}: the second book's text`);
  await themes(page, `epub-${label}-result`);
}

// ---------------------------------------------------------------------------------------------
// Files shared to the app, progress while converting, leaving

/** A FileItem made in the page from a fixture, as the share inbox hands them over. */
async function share(page, fx) {
  return page.evaluate(async (list) => {
    const { fileItem } = await import(new URL('js/core/files.js', location.href).href);
    const { currentHandle } = await import(new URL('js/core/router.js', location.href).href);
    const items = list.map(({ name, type, b64 }) => fileItem(name, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), type));
    currentHandle().receiveFiles(items);
  }, fx.map((f) => ({ name: f.name, type: f.mimeType, b64: f.buffer.toString('base64') })));
}

async function testSharedAndProgress(page, url, { touch }) {
  // Files handed over (shared to the app, or opened with it) are checked as picked ones are.
  await page.evaluate(() => { location.hash = '#/'; });
  await arrive(page, '#app .screen[data-route="home"]:not([aria-busy])');
  await page.evaluate(async (list) => {
    const { fileItem } = await import(new URL('js/core/files.js', location.href).href);
    const { navigate } = await import(new URL('js/core/router.js', location.href).href);
    const items = list.map(({ name, type, b64 }) => fileItem(name, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), type));
    await navigate('/tool/word', { files: items });
  }, [FX.garden, FX.notes].map((f) => ({ name: f.name, type: f.mimeType, b64: f.buffer.toString('base64') })));
  await arrive(page, '#app .screen[data-tool="word"]:not([aria-busy]) .office-content');
  await listed(page, 1);
  await snack(page, say('file_problem', 'notes.docx', say('office_not_word')), 'shared: the one left out is named');
  // Shared while the tool shows: added to the list.
  await share(page, [FX.second]);
  await listed(page, 2);
  eq(await cardNames(page), ['Garden report.docx', 'Second.docx'], 'shared while it shows: added');

  // While converting, shared files wait, and are added once it is done. A long document shows
  // the progress dialog: "PDF 1 of 2", its name, and the page being drawn.
  const long = file('Long.docx', docx(Array.from({ length: 8000 }, (_, i) => (i % 40 === 39 ? '\f' : `Paragraph ${i + 1} of a long report about the garden, with enough words to wrap onto a second line of the page.`))), WORD_TYPE);
  await share(page, [long]);
  await listed(page, 3);
  await press(page, '.office-run', { touch });
  await page.waitForSelector('dialog.ui-dialog--progress.is-shown', { timeout: 20000 });
  eq(await page.textContent('dialog.ui-dialog--progress .ui-dialog-title'), say('creating_pdfs'), 'progress: "Creating and compressing PDFs…"');
  await page.waitForFunction((label) => document.querySelector('dialog.ui-dialog--progress .ui-progress-label')?.textContent === label, say('batch_progress', 3, 3), { timeout: 60000, polling: 50 });
  eq(await page.textContent('dialog.ui-dialog--progress .ui-progress-detail'), 'Long.docx', 'progress: the file being converted');
  await page.waitForFunction(() => /\d/.test(document.querySelector('dialog.ui-dialog--progress .office-progress-step:not([hidden])')?.textContent ?? ''), null, { timeout: 60000, polling: 50 });
  ok(/^Page \d+$/.test(await page.textContent('dialog.ui-dialog--progress .office-progress-step')), 'progress: the page being drawn');
  if (!QUICK) await page.screenshot({ path: join(shots, `progress-${touch ? 'phone' : 'desktop'}.png`) });
  eq((await handleState(page)).processing, true, 'converting');
  await share(page, [FX.garden]);
  await snack(page, say('share_waits'), 'shared while converting: they wait');
  // Leaving now asks first.
  ok(await page.evaluate(async () => (await import(new URL('js/core/router.js', location.href).href)).currentHandle().hasUnsavedWork()), 'converting is work to lose');
  await page.waitForSelector('.ui-result', { timeout: 180000 });
  const files = await resultFiles(page);
  eq(files.map((f) => f.name), ['Garden report.pdf', 'Second.pdf', 'Long.pdf'], 'three made');
  ok((await readBack(page, files[2].bytes)).pages.length >= 100, 'the long one, all its pages');
  // Over a result not saved yet, the shared file waiting asks first: "Discard this PDF?"
  await page.waitForSelector(`dialog[open] .ui-dialog-title:has-text("${say('pdf_discard_title')}")`);
  eq(await page.textContent('dialog[open] .ui-dialog-body'), say('share_discard_body'), 'the question says why');
  await themes(page, `share-question-${touch ? 'phone' : 'desktop'}`, { full: false });
  // Keep: the result stays; the file joins the list once the result has gone.
  await press(page, `dialog[open] .ui-btn:has-text("${say('keep')}")`, { touch });
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  ok(await page.$('.ui-result'), 'Keep: the result stays');
  await backToEditing(page, { touch });
  await listed(page, 4);
  eq(await cardNames(page), ['Garden report.docx', 'Second.docx', 'Long.docx', 'Garden report.docx'], 'the file kept waiting joins the list');

  // Cancel while converting: nothing made, nothing said, the files still there.
  await press(page, '.ui-batch-item:nth-child(4) .ui-file-head .ui-icon-btn', { touch });
  await listed(page, 3);
  await press(page, '.office-run', { touch });
  await page.waitForFunction((label) => document.querySelector('dialog.ui-dialog--progress.is-shown .ui-progress-label')?.textContent === label
    && /\d/.test(document.querySelector('dialog.ui-dialog--progress .office-progress-step:not([hidden])')?.textContent ?? ''), say('batch_progress', 3, 3), { timeout: 60000, polling: 50 });
  await press(page, 'dialog.ui-dialog--progress .ui-btn', { touch });
  eq(await page.evaluate(() => document.querySelector('dialog.ui-dialog--progress .ui-btn')?.textContent ?? null), say('cancelling'), 'Cancel: "Cancelling…"');
  await page.waitForSelector('dialog.ui-dialog--progress', { state: 'detached', timeout: 30000 });
  ok(!(await page.$('.ui-result')), 'cancelled: no result');
  await noSnack(page);
  await listed(page, 3);

  // Over a result, Discard starts afresh with the files shared.
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) document.querySelector('.ui-batch-item:nth-child(2) .ui-file-head .ui-icon-btn').click();
  });
  await listed(page, 1);
  await runToResult(page, { touch });
  await share(page, [FX.second]);
  await page.waitForSelector(`dialog[open] .ui-dialog-title:has-text("${say('pdf_discard_title')}")`);
  await press(page, `dialog[open] .ui-btn:has-text("${say('discard')}")`, { touch });
  await page.waitForSelector('.ui-result', { state: 'detached' });
  await listed(page, 1);
  eq(await cardNames(page), ['Second.docx'], 'Discard: afresh with the file shared');

  // Leaving with a result not saved asks "Discard your changes?"; Keep stays.
  await runToResult(page, { touch });
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector(`dialog[open] .ui-dialog-title:has-text("${say('tool_discard_title')}")`);
  await press(page, `dialog[open] .ui-btn:has-text("${say('keep')}")`, { touch });
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  ok(await page.$('.ui-result'), 'Keep: still on the result');
}

// ---------------------------------------------------------------------------------------------
// Desktop: dropping files, and the keyboard

async function testDesktopDrop(page, url) {
  await openTool(page, url, 'word');
  ok(await page.isVisible('.ui-empty-drop'), 'desktop: "Or drop files here"');
  await drop(page, [FX.garden, FX.deck], '.ui-empty');
  await snack(page, say('file_problem', 'deck.pptx', say('office_not_word')), 'desktop: a presentation dropped on Word to PDF says why');
  await listed(page, 1);
  // Dropped anywhere on the screen once there is a file.
  await drop(page, [FX.second], '.office-page');
  await listed(page, 2);
  // The keyboard: Tab reaches the cards' fields and the main button; Enter converts.
  await page.focus('.office-run');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ui-result', { timeout: 120000 });
  ok(true, 'desktop: Enter on the main button converts');
  const cards = await page.$$eval('.ui-result-file', (els) => els.length);
  eq(cards, 2, 'desktop: two PDFs');
  await checkNoSideways(page, 'desktop result');
}

// ---------------------------------------------------------------------------------------------

await testStrings();
console.log('strings ok');

await withPage(async (page, url) => {
  await testHelpers(page, url);
  console.log('helpers ok');
  await testWord(page, url, { touch: true, label: 'phone' });
  console.log('word phone ok');
  await testPowerPoint(page, url, { touch: true, label: 'phone' });
  console.log('powerpoint phone ok');
  await testExcel(page, url, { touch: true, label: 'phone' });
  console.log('excel phone ok');
  await testEpub(page, url, { touch: true, label: 'phone' });
  console.log('epub phone ok');
  await testSharedAndProgress(page, url, { touch: true });
  console.log('shared and progress phone ok');
  // At 320 px nothing scrolls sideways either.
  await page.setViewportSize({ width: 320, height: 700 });
  await openTool(page, url, 'excel');
  await pickWith(page, '.ui-empty', [FX.budget, FX.wide], { touch: true });
  await listed(page, 2);
  await checkNoSideways(page, 'excel at 320 px');
  await shot(page, 'excel-320-many');
}, { viewport: PHONE });

await withPage(async (page, url) => {
  await testWord(page, url, { touch: false, label: 'desktop' });
  console.log('word desktop ok');
  await testPowerPoint(page, url, { touch: false, label: 'desktop' });
  console.log('powerpoint desktop ok');
  await testExcel(page, url, { touch: false, label: 'desktop' });
  console.log('excel desktop ok');
  await testEpub(page, url, { touch: false, label: 'desktop' });
  console.log('epub desktop ok');
  await testDesktopDrop(page, url);
  console.log('desktop drop ok');
}, { viewport: DESKTOP });

// The converter can't be loaded (offline before it was saved for offline use): said as such, not as
// a problem with the file. The request failing is logged by the browser, so problems aren't counted here.
await withPage(async (page, url) => {
  await page.route('**/engine/office/docx.js', (route) => route.abort());
  await openTool(page, url, 'word');
  await pickWith(page, '.ui-empty', [FX.garden], { touch: true });
  await listed(page, 1);
  await press(page, '.office-run', { touch: true });
  await snack(page, say('web_tool_load_failed', say('tool_word')), "a converter that can't be loaded says so");
  ok(!(await page.$('.ui-result')) && !(await handleState(page)).processing, 'nothing made, ready to try again');
  console.log('converter load failure ok');
}, { viewport: PHONE, ignoreProblems: true });

if (!QUICK) {
  for (const browser of ['firefox', 'webkit']) {
    await withPage(async (page, url) => {
      await testEpub(page, url, { touch: browser !== 'firefox', label: browser, browser });
      console.log(`epub ${browser} ok`);
    }, { viewport: PHONE, browser, allowConsole: [/^XML Parsing Error/] });
  }
}

console.log(`office-ui: ${checks} checks passed${await exists(shots) && !QUICK ? `; screenshots in ${shots}` : ''}`);
