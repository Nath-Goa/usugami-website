// The app shell: Home, search, routes and Back (with the unsaved-work question), Settings and
// appearance, Recent files, files shared to the app, the manifest, the service worker (offline),
// and layouts at phone and desktop sizes in Chromium, Firefox and WebKit.
//   node tests/shell.test.mjs            everything
//   node tests/shell.test.mjs --quick    Chromium only, no screenshots
//   node tests/shell.test.mjs --browser firefox   the screens' tests in another browser
//   node tests/shell.test.mjs --only "service worker"   only the tests whose names include that
import { withPage, assert, runInPage, saveOutput, root } from './harness.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { words, matches, search } from '../site/app/js/core/search.js';
import * as names from '../site/app/js/core/names.js';
import { kindOfShared, chosenKind, sortShared, SHARE_TARGETS } from '../site/app/js/core/share-inbox.js';
import { TOOLS, SECTIONS } from '../site/app/js/core/tools.js';
import common from '../site/app/locales/en/common.js';
import kit from '../site/app/locales/en/kit.js';

const quick = process.argv.includes('--quick');
const browserArg = process.argv.indexOf('--browser');
/** The browser the screens' tests run in (Home's layout is checked in all three). */
const BROWSER = browserArg > 0 ? process.argv[browserArg + 1] : 'chromium';
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? process.argv[onlyArg + 1] : null;
const log = (s) => console.log('  ' + s);
let failures = 0;

async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
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

const PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1366, height: 800 };

/** Opens the app at `hash` and waits until it has started. */
async function openApp(page, url, hash = '') {
  await page.goto(url + 'app/' + hash);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
}

/** Waits until the screen showing is `route` (data-route on .screen). */
async function onScreen(page, route, tool) {
  const sel = `#app > .screen[data-route="${route}"]` + (tool ? `[data-tool="${tool}"]` : '') + ':not([aria-busy])';
  await page.waitForSelector(sel, { timeout: 15000 });
}

const hashOf = (page) => page.evaluate(() => location.hash);

/** Puts a file of `size` bytes on Recent files, as a tool's Save does. */
const addRecent = (page, name, size, type = 'application/pdf') => page.evaluate(async ([n, s, t]) => {
  const { addRecent: add } = await import('./js/core/recent.js');
  await add({ name: n, type: t, bytes: new Uint8Array(s).fill(7) });
}, [name, size, type]);

/** A tool screen standing in for the real ones, served in place of js/tools/<id>/index.js. */
const FAKE_TOOL = `
export async function mount(ctx) {
  const state = { unsaved: false, steps: [] };
  window.__tool = { id: ctx.tool.id, params: ctx.params, files: ctx.files ? ctx.files.map((f) => f.name) : null, from: ctx.from, mounted: (window.__tool?.mounted ?? 0) + 1 };
  window.__toolState = state;
  const h1 = document.createElement('h1');
  h1.textContent = 'Fake ' + ctx.tool.id;
  const back = document.createElement('button');
  back.textContent = 'Leave';
  back.className = 'fake-back';
  back.onclick = () => ctx.back();
  const step = document.createElement('button');
  step.textContent = 'Result';
  step.className = 'fake-step';
  step.onclick = () => ctx.pushStep('result');
  ctx.root.append(h1, back, step);
  return {
    unmount() { window.__unmounts = (window.__unmounts ?? 0) + 1; },
    hasUnsavedWork: () => state.unsaved,
    discardQuestion: () => state.question ?? null,
    onStep(s) { state.steps.push(s); },
    // As Images to PDF: files shared while it shows join it (when a test asks for it).
    ...(window.__fakeReceives ? { receiveFiles(files) { (window.__received ??= []).push(...files.map((f) => f.name)); } } : {}),
  };
}`;

async function fakeTools(page) {
  await page.route('**/app/js/tools/**/index.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TOOL }));
}

async function makePdf(pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]).drawText('Page ' + (i + 1), { x: 40, y: 300, size: 20 });
  return new Uint8Array(await doc.save());
}

/** Hands files to share-inbox.js's receiveFiles in the page, as a share does ({ name, type, bytes }). */
const receiveOn = (page, files) => page.evaluate(async (list) => {
  const { receiveFiles } = await import('./js/core/share-inbox.js');
  await receiveFiles(list.map((f) => new File([new Uint8Array(f.bytes)], f.name, { type: f.type })));
}, files.map((f) => ({ ...f, bytes: Array.from(f.bytes) })));
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const go = (page, path, options) => page.evaluate(async ([p, o]) => (await import('./js/core/router.js')).navigate(p, o ?? {}), [path, options ?? null]);

// ---------------------------------------------------------------------------------------------
// The algorithms, as the app's unit tests check them (ToolSearchTest, FileNamesTest, SharedFilesTest).

await test('search folds words and finds tools as ToolSearch does', async () => {
  eq(words('Shrink images, keep text sharp'), ['shrink', 'images', 'keep', 'text', 'sharp'], 'words');
  eq(words('Documents (.docx), converted'), ['documents', 'docx', 'converted'], 'punctuation');
  eq(words('Réduire l’image'), ['reduire', 'l', 'image'], 'accents');
  eq(words('e-book; EBOOK'), ['e', 'book', 'ebook'], 'hyphen');
  eq(words('ÉTÉ Niño FRANÇAIS'), ['ete', 'nino', 'francais'], 'capitals');
  eq(words('ﬁle ＰＤＦ'), ['file', 'pdf'], 'ligatures');
  eq(words('  ,.-  '), [], 'nothing');
  eq(words('पेज हटाएं'), ['पेज', 'हटाएं'], 'devanagari');
  eq(words('फाइल'), words('फ़ाइल'), 'nukta');
  eq(words('कागज'), words('क़ागज'), 'precomposed nukta');
  eq(words('मिलाएं'), words('मिलाएँ'), 'candrabindu');
  eq(words('क्‍षमा'), ['क्षमा'], 'zero-width joiner');
  for (const [q, text] of [['MERGE', 'Merge PDF'], ['resume', 'Résumé'], ['présentation', 'presentation, slides'], ['imagenes', 'Imágenes a PDF'], ['PAGINA', 'Numerar páginas'], ['Ôter', 'retirer, effacer, ôter']]) {
    assert(matches(q, text), `"${q}" matches "${text}"`);
  }
  const compress = 'Compress PDF Shrink images, keep text sharp reduce size';
  assert(matches('size reduce', compress) && matches('  red   si ', compress) && matches('comp', compress), 'any order, prefixes');
  assert(!matches('reduce colour', compress) && !matches('press', compress) && !matches('   ', compress) && !matches(',.;', compress), 'every word must begin a word');
  const english = [
    ['Images to PDF', 'JPGs and PNGs to PDF, with text recognition', 'photo, picture, JPEG, scan, camera, gallery'],
    ['Merge PDF', 'Combine files and arrange individual pages', 'join, combine, append, put together'],
    ['Split PDF', 'Extract pages or split into smaller files', 'separate, cut, divide, extract'],
    ['Delete pages', "Remove the pages you don't need", 'remove, erase, discard'],
    ['Add page numbers', 'Number pages at the top or bottom', 'numbering, pagination, footer, header'],
    ['Compress PDF', 'Shrink images, keep text sharp', 'shrink, reduce size, smaller, optimize, file size'],
  ];
  const find = (list, q) => search(list, q, (x) => x[0], (x) => `${x[1]} ${x[2]}`).map((x) => x[0]);
  eq(find(english, 'join'), ['Merge PDF'], 'keyword');
  eq(find(english, 'Put Together'), ['Merge PDF'], 'two keywords');
  eq(find(english, 'need'), ['Delete pages'], 'detail');
  eq(find(english, 'zebra'), [], 'none');
  eq(find(english, 'images'), ['Images to PDF', 'Compress PDF'], 'by name first');
  eq(find(english, 'page'), ['Delete pages', 'Add page numbers', 'Merge PDF', 'Split PDF'], 'by name, then the rest in order');
  const french = [
    ['Images en PDF', 'JPG et PNG en PDF, avec reconnaissance de texte', 'photo, scanner, numériser, appareil photo, galerie'],
    ['Fusionner des PDF', 'Combiner des fichiers et organiser les pages', 'assembler, combiner, joindre, réunir, regrouper'],
    ['Compresser un PDF', 'Réduire les images, garder le texte net', 'alléger, réduire, taille, plus petit, poids'],
  ];
  eq(find(french, 'REUNIR'), ['Fusionner des PDF'], 'french');
  eq(find(french, 'réduire la taille'), [], 'every word must match');
  const hindi = [
    ['PDF मर्ज करें', 'फ़ाइलें मिलाएं और अलग-अलग पेज क्रम में लगाएं', 'जोड़ें, मिलाएँ, एक फ़ाइल, merge, combine, join'],
    ['पेज हटाएं', 'जिन पेजों की ज़रूरत नहीं, उन्हें हटाएं', 'मिटाएं, निकालें, delete, remove'],
    ['PDF कंप्रेस करें', 'इमेज छोटी करें, टेक्स्ट साफ़ रखें', 'छोटा करें, साइज़ घटाएं, compress, shrink, reduce size'],
  ];
  eq(find(hindi, 'जोडें'), ['PDF मर्ज करें'], 'hindi without nukta');
  eq(find(hindi, 'पेज'), ['पेज हटाएं', 'PDF मर्ज करें'], 'hindi');
  eq(find(hindi, 'पज'), [], 'vowel signs are part of a word');
});

await test('file names as FileNames.kt makes them', async () => {
  eq(names.sanitizeName('  Holiday  ', 'x'), 'Holiday', 'trim');
  eq(names.sanitizeName('Holiday.PDF', 'x'), 'Holiday', 'extension');
  eq(names.sanitizeName(String.raw`a/b\c:d*e?f"g<h>i`, 'x'), 'a_b_c_d_e_f_g_h_i', 'illegal characters');
  eq(names.sanitizeName('tab\tnew', 'x'), 'tab_new', 'control characters');
  eq(['   ', '...', '.pdf'].map((n) => names.sanitizeName(n, 'x')), ['x', 'x', 'x'], 'fallback');
  eq(names.sanitizeName('Reçu été 📷', 'x'), 'Reçu été 📷', 'unicode kept');
  eq(['name. ', 'Report.pdf.', 'Report.pdf . '].map((n) => names.sanitizeName(n, 'x')), ['name', 'Report', 'Report'], 'trailing dots');
  const long = names.sanitizeName('📷'.repeat(100), 'x');
  assert(names.utf8Size(long) <= 200 && Array.from(long).length === 50, 'emoji cut whole');
  eq(names.sanitizeName('a'.repeat(300), 'x').length, 200, '200 bytes');
  eq(names.sanitizeName('é'.repeat(67), 'x'), 'é'.repeat(66), 'accents stay with their letter');
  eq(names.withSuffix('क'.repeat(67), '_redacted', 'x'), 'क'.repeat(63) + '_redacted', 'suffix kept whole');
  eq(names.withSuffixes('क'.repeat(67), ['_1_1-9', '_10_91-100'], 'x'), ['क'.repeat(63) + '_1_1-9', 'क'.repeat(63) + '_10_91-100'], 'suffixes');
  eq(['CON', 'nul.pdf', 'Aux.notes', 'com1', 'LPT9 .old', 'Console', 'COM10', 'My CON'].map((n) => names.sanitizeName(n, 'x')),
    ['CON_', 'nul_', 'Aux_.notes', 'com1_', 'LPT9_ .old', 'Console', 'COM10', 'My CON'], 'windows devices');
  eq([names.baseName('IMG_1234.jpg'), names.baseName('archive.tar.gz'), names.baseName('.hidden'), names.baseName('noext')], ['IMG_1234', 'archive.tar', '.hidden', 'noext'], 'baseName');
  eq(names.uniqueNames(['Report', 'Report.pdf', ' report ', 'Notes', '', '...', 'a/b'], 'Compressed'), ['Report', 'Report (2)', 'report (3)', 'Notes', 'Compressed', 'Compressed (2)', 'a_b'], 'uniqueNames');
  eq(names.uniqueNames(['a', 'a (2)', 'a'], 'x'), ['a', 'a (2)', 'a (3)'], 'uniqueNames twice');
  eq(['img10.jpg', 'IMG2.jpg', 'img1.jpg', 'b.png', 'A.png', 'img02.jpg', 'img2b.jpg'].sort(names.naturalCompare), ['A.png', 'b.png', 'img1.jpg', 'IMG2.jpg', 'img02.jpg', 'img2b.jpg', 'img10.jpg'], 'natural order');
  eq(names.defaultPdfName(new Date(2026, 9, 31, 17, 21, 4)), 'Usugami_20261031_172104', 'default name');
  eq([names.withPdfExtension('a'), names.withPdfExtension('b.PDF')], ['a.pdf', 'b.PDF'], 'withPdfExtension');
});

await test('shared files are routed as SharedFiles.kt routes them', async () => {
  const k = kindOfShared;
  eq([k('application/pdf'), k('application/x-pdf'), k('image/jpeg'), k('image/heic'), k('application/msword'), k('application/vnd.ms-powerpoint'), k('application/epub+zip'), k('application/vnd.ms-excel'), k('text/plain'), k(null)],
    ['pdf', 'pdf', 'image', 'image', 'docx', 'pptx', 'epub', 'xlsx', 'other', 'other'], 'by type');
  eq([k(' Application/PDF '), k('application/pdf; name="Report.pdf"'), k('APPLICATION/EPUB+ZIP')], ['pdf', 'pdf', 'epub'], 'case and parameters');
  eq([k('application/octet-stream', 'Book.epub'), k('application/zip', 'Report.DOCX'), k('*/*', 'Talk.pptx'), k(null, 'scan.final.pdf'), k(null, 'IMG_1234.JPG'), k(null, 'old.doc'), k(null, 'old.xls'), k(null, 'notes.txt'), k(null, 'README'), k('application/pdf', 'photo.jpg')],
    ['epub', 'docx', 'pptx', 'pdf', 'image', 'docx', 'xlsx', 'other', 'other', 'pdf'], 'by name');
  eq([k(null, '1000000033', 'image/*'), k('application/octet-stream', 'download', 'application/pdf'), k(null, 'download', '*/*'), k('application/pdf', null, 'image/*'), k(null, 'Book.epub', 'image/*')],
    ['image', 'pdf', 'other', 'pdf', 'epub'], 'share type last');
  eq([chosenKind(['pdf']), chosenKind(['docx', 'pdf', 'docx', 'other']), chosenKind(['image', 'image', 'pdf', 'epub', 'other', 'other', 'other']), chosenKind(['other', 'epub'])], ['pdf', 'docx', 'image', 'epub'], 'most');
  eq([chosenKind(['image', 'pdf']), chosenKind(['docx', 'pdf', 'docx', 'pdf']), chosenKind(['epub', 'image']), chosenKind(['pptx', 'docx', 'epub']), chosenKind(['epub', 'pptx']), chosenKind(['xlsx', 'epub'])],
    ['pdf', 'pdf', 'image', 'docx', 'pptx', 'epub'], 'ties');
  eq([chosenKind([]), chosenKind(['other', 'other'])], [null, null], 'none');
  const files = ['a.pdf', 'b.jpg', 'c.pdf', 'notes.txt', 'd.docx'];
  const sorted = sortShared(files, files.map((n) => k(null, n)), (n) => n);
  eq(sorted, { kind: 'pdf', taken: ['a.pdf', 'c.pdf'], unsupported: ['notes.txt'], otherKind: ['b.jpg', 'd.docx'], target: '/choose' }, 'sortShared');
  eq(SHARE_TARGETS, { pdf: '/choose', image: '/tool/images', docx: '/tool/word', pptx: '/tool/powerpoint', epub: '/tool/epub', xlsx: '/tool/excel' }, 'targets');
});

await test('common strings hold every tool, section and Home string', async () => {
  for (const tool of Object.values(TOOLS)) {
    for (const key of [tool.title, tool.detail, tool.keywords]) assert(typeof common[key] === 'string', `${key} in common.js`);
  }
  for (const s of SECTIONS) assert(common[s.heading], `${s.heading} in common.js`);
  for (const key of ['pdf_import_failed', 'search_keywords_batch', 'web_home_subtitle', 'home_search_none', 'tool_discard_title', 'recent_clear_body', 'share_several_hint']) assert(common[key], key);
  eq(common.home_search_results, { one: '{1} tool found', other: '{1} tools found' }, 'plural');
  // Copied from strings.xml exactly.
  const xml = await readFile(join(root, '..', 'pdfer', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8').catch(() => null);
  if (xml) {
    for (const [key, value] of Object.entries(common)) {
      if (typeof value !== 'string' || key.startsWith('web_') || key === 'pdf_import_failed') continue;
      const m = xml.match(new RegExp(`<string name="${key}"[^>]*>([\\s\\S]*?)</string>`));
      assert(m, `${key} is in strings.xml`);
      const android = m[1].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/%(\d)\$[sd]/g, '{$1}').replace(/%[sd]/g, '{1}');
      eq(value, android, `${key} as in strings.xml`);
    }
  }
});

await test('file names: Kotlin\'s whitespace, unique, and the same as engine/organize.js\'s fileNames', async () => {
  // Kotlin's trim() and isWhitespace (FileNames.kt): no-break and ideographic spaces and line
  // separators go too; a control character at an end isn't trimmed but becomes '_'.
  eq(names.sanitizeName('\u00a0Report\u00a0', 'x'), 'Report', 'no-break spaces trimmed');
  eq(names.sanitizeName('\u202fReport\u2007.pdf', 'x'), 'Report', 'narrow no-break spaces');
  eq(names.sanitizeName('\u2028Notes\u3000', 'x'), 'Notes', 'line separator and ideographic space');
  eq(names.sanitizeName('\u0001Report', 'x'), '_Report', 'control character at the start');
  eq(names.sanitizeName('\u001cReport\u001f', 'x'), 'Report', 'Java whitespace among the control characters');
  // FileNames.unique, withSuffix with room to spare, and the app's names for them.
  eq([names.unique('a', new Set(['b'])), names.unique('a', new Set(['A'])), names.unique('a', ['a', 'a (2)'])], ['a', 'a (2)', 'a (3)'], 'unique');
  assert(names.unique === names.uniqueName && names.sanitize === names.sanitizeName, 'the app\'s names');
  const split = names.withSuffix('a'.repeat(200), '_split', 'x', 10);
  eq(split, 'a'.repeat(184) + '_split', 'spare');
  eq(names.withSuffixes(split, ['_1_1-9', '_10_91-100'], 'x'), [split + '_1_1-9', split + '_10_91-100'], 'Split\'s parts');
  eq(names.withSuffix(' ... ', '_split', 'x'), 'x_split', 'blank base');
  eq(Object.keys(names.fileNames).sort(), ['baseName', 'sanitize', 'unique', 'uniqueNames', 'withSuffix', 'withSuffixes'], 'fileNames');
  // FileNames.listed (FileNamesTest): all when few, one more listed rather than counted, else the
  // first three; listOfNames and namesArg as NameList.kt words them.
  eq(names.listedNames([]), { listed: [], more: 0 }, 'listed: none');
  eq(names.listedNames(['a', 'b', 'c', 'd']), { listed: ['a', 'b', 'c', 'd'], more: 0 }, 'listed: four');
  const many = Array.from({ length: 250 }, (_, i) => `File ${i + 1}.txt`);
  eq(names.listedNames(many), { listed: ['File 1.txt', 'File 2.txt', 'File 3.txt'], more: 247 }, 'listed: many');
  eq(names.listOfNames(['a.pdf', 'b.pdf']), 'a.pdf, b.pdf', 'listOfNames: few');
  eq(names.namesArg(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']), 'a.pdf, b.pdf, c.pdf, d.pdf', 'namesArg: four');
  eq(names.namesArg(many), { key: 'names_and_more', count: 247, args: ['File 1.txt, File 2.txt, File 3.txt', 247] }, 'namesArg: many');
  {
    const { loadStrings } = await import('../site/app/js/core/i18n.js');
    const common = (await import('../site/app/locales/en/common.js')).default;
    eq(common.names_and_more, { one: '{1} and {2} more', other: '{1} and {2} more' }, 'names_and_more (strings.xml)');
    await loadStrings('common').catch(() => {});
    const worded = names.listOfNames(many);
    // Node can't load the strings files as the page does: then the key comes back.
    if (worded !== 'names_and_more') eq(worded, 'File 1.txt, File 2.txt, File 3.txt and 247 more', 'listOfNames: many');
  }
  // engine/organize.js has its own port (fileNames): both give the same names.
  const { fileNames } = await import('../site/app/js/engine/organize.js');
  const inputs = ['\u00a0Report\u00a0', '\u0001Report', '\u2028a', ' Report\u202f.pdf', '\u001cX\u001f', '  Holiday  ', 'Report.pdf . ',
    'CON', 'LPT9 .old', 'क'.repeat(67), '📷'.repeat(100), 'é'.repeat(67), ' ... ', '', 'a/b', '\u3000x\u3000', 'Été', 'a'.repeat(300)];
  for (const input of inputs) {
    for (const [fn, args] of [
      ['sanitize', [input, 'x']], ['withSuffix', [input, '_split', 'x']], ['withSuffix', [input, '_redacted', 'x', 10]],
      ['withSuffixes', [input, ['_1_1-9', '_10_91-100'], 'x']], ['baseName', [input]], ['unique', [input, new Set([input.toUpperCase(), input + ' (2)'])]],
    ]) {
      eq(names.fileNames[fn](...args), fileNames[fn](...args), `${fn}(${JSON.stringify(args)}) as organize.js`);
    }
  }
});

/** The paths in sw.js's SHELL, its strings of every language in LANGUAGES included. */
async function shellPaths() {
  const sw = await readFile(join(root, 'site', 'app', 'sw.js'), 'utf8');
  const shell = new Set([...sw.matchAll(/^ {2}'([^']+)',/gm)].map((m) => m[1]));
  const codes = JSON.parse(sw.match(/^const LANGUAGES = (\[[^\]]*\]);/m)[1].replace(/'/g, '"'));
  assert(/\.\.\.LANGUAGES\.flatMap\(\(code\) => \[`locales\/\$\{code\}\/common\.js`, `locales\/\$\{code\}\/kit\.js`, `locales\/\$\{code\}\/mark\.js`\]\)/.test(sw), 'SHELL keeps each language\'s common, kit and mark strings');
  for (const code of codes) for (const ns of ['common', 'kit', 'mark']) shell.add(`locales/${code}/${ns}.js`);
  return { shell, codes, sw };
}

/** Every module `entries` import statically, themselves included (paths relative to site/app/). */
async function importGraph(entries) {
  const app = join(root, 'site', 'app');
  const seen = new Set();
  const visit = async (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = await readFile(join(app, rel), 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gm)) {
      const next = new URL(m[1] ?? m[2], 'http://x/' + rel).pathname.slice(1);
      await visit(next);
    }
  };
  for (const entry of entries) await visit(entry);
  return seen;
}

await test('the service worker keeps at install every module the app starts with and its screens import', async () => {
  const app = join(root, 'site', 'app');
  const { shell, codes } = await shellPaths();
  const { readdir } = await import('node:fs/promises');
  const screens = (await readdir(join(app, 'js', 'screens'))).filter((f) => f.endsWith('.js')).map((f) => 'js/screens/' + f);
  const seen = await importGraph(['js/main.js', ...screens]);
  eq([...seen].filter((f) => !shell.has(f)), [], 'imported at start but not in sw.js SHELL');
  // What the modules kept in SHELL import must be kept too (output.js's result-mark.js and
  // mark-layout.js), or they fail offline; and the style sheets they load (mark.css).
  const kept = [...shell].filter((f) => f.endsWith('.js') && f.startsWith('js/'));
  const closure = await importGraph(kept);
  eq([...closure].filter((f) => !shell.has(f)), [], 'imported by a module in SHELL but not in SHELL');
  for (const rel of kept) {
    const text = await readFile(join(app, rel), 'utf8');
    // Not in comments (dom.js's own example).
    for (const m of text.matchAll(/^(?!\s*(?:\*|\/\/)).*ensureCss\(new URL\('([^']+\.css)', import\.meta\.url\)\)/gm)) {
      const css = new URL(m[1], 'http://x/' + rel).pathname.slice(1);
      assert(shell.has(css), `SHELL has ${css} (loaded by ${rel})`);
    }
  }
  for (const f of ['index.html', 'css/app.css', 'css/mark.css', 'locales/en/common.js', 'locales/en/kit.js', 'locales/en/mark.js', 'js/core/result-mark.js', 'js/engine/mark-layout.js']) assert(shell.has(f), 'SHELL has ' + f);
  // Every language the app comes in opens offline in it.
  const { LANGUAGES } = await import('../site/app/locales/languages.js');
  eq(codes, LANGUAGES.map((l) => l.code), "sw.js's LANGUAGES are locales/languages.js's");
  // Every path kept exists, so none is quietly missing offline.
  const { existsSync } = await import('node:fs');
  eq([...shell].filter((f) => f !== './' && !existsSync(join(app, f))), [], 'SHELL paths that are not on the site');
});

await test('index.html preloads every module Home starts with, and only those', async () => {
  const app = join(root, 'site', 'app');
  const html = await readFile(join(app, 'index.html'), 'utf8');
  const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  const graph = await importGraph(['js/main.js', 'js/screens/home.js', 'locales/en/common.js', 'locales/en/kit.js', 'locales/en/mark.js']);
  eq([...graph].filter((f) => !preloads.includes(f)), [], 'Home\'s start modules without a modulepreload link in app/index.html');
  eq(preloads.filter((f) => !graph.has(f)), [], 'modulepreload links for modules Home doesn\'t start with');
  eq(preloads.length, new Set(preloads).size, 'each preloaded once');
  // A strict Content-Security-Policy first in <head>, and no referrer sent to other sites.
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  assert(/<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy" content="default-src 'self';/.test(head), 'CSP meta right after the charset');
  assert(head.includes('<meta name="referrer" content="no-referrer">'), 'referrer policy no-referrer');
});

await test('icons: the generated set names its source and license, and has every icon the code uses', async () => {
  const source = await readFile(join(root, 'site', 'app', 'js', 'core', 'icons.js'), 'utf8');
  const head = source.slice(0, 1200);
  for (const part of ["Google's Material Icons", 'Round', '@material-design-icons/svg', 'Apache License, Version 2.0']) assert(head.includes(part), 'header names ' + part);
  const have = new Set([...source.matchAll(/^ {2}([a-z0-9_]+): '/gm)].map((m) => m[1]));
  // Every name given to an icon anywhere in site/app/js (icon('x'), icon: 'x', iconName: 'x', ...).
  const { readdir } = await import('node:fs/promises');
  const missing = new Set();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['lib', 'vendor'].includes(entry.name)) await walk(p);
      } else if (entry.name.endsWith('.js') && entry.name !== 'icons.js') {
        const text = await readFile(p, 'utf8');
        for (const m of text.matchAll(/\b\w*[iI]con\w*(?:\(\s*|\s*[:=]\s*)['"`]([a-z0-9_]+)['"`]/g)) {
          if (!have.has(m[1])) missing.add(`${m[1]} (${p.slice(root.length + 1)})`);
        }
      }
    }
  };
  await walk(join(root, 'site', 'app', 'js'));
  eq([...missing], [], 'icons used but not in core/icons.js (run node tools/build-icons.mjs --js)');
});

// ---------------------------------------------------------------------------------------------
// In the browsers.

const browsers = quick ? ['chromium'] : ['chromium', 'firefox', 'webkit'];
for (const browser of browsers) {
  for (const [label, viewport] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    await test(`${browser} ${label}: Home shows every tool in its section, no outside requests, no horizontal scroll`, async () => {
      await withPage(async (page, url) => {
        await openApp(page, url);
        await onScreen(page, 'home');
        const sections = await page.$$eval('.home-sections section', (els) => els.map((s) => ({
          heading: s.querySelector('h2').textContent,
          tools: Array.from(s.querySelectorAll('.ui-card-title'), (c) => c.textContent),
        })));
        eq(sections, SECTIONS.map((s) => ({ heading: common[s.heading], tools: s.tools.map((id) => common[TOOLS[id].title]) })), 'sections');
        assert(await page.isVisible('.scan-card'), 'scan card');
        eq(await page.textContent('.home-subtitle'), common.web_home_subtitle, 'subtitle');
        eq(await page.$eval('h1', (e) => e.textContent), 'Usugami', 'title');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
        eq(await page.$eval('#app > .screen h1', (e) => e === document.activeElement), true, 'focus on the heading');
        if (!quick) {
          for (const scheme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            await saveOutput(`shell-home-${browser}-${label}-${scheme}.png`, await page.screenshot({ fullPage: label === 'phone' }));
          }
        }
        if (label === 'desktop') {
          // Several cards to a row on wide screens.
          const tops = await page.$$eval('.home-sections section:first-child .ui-card', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
          assert(new Set(tops).size < tops.length, 'cards share rows on a desktop');
          // "/" goes to the search field.
          await page.locator('body').press('/');
          eq(await page.evaluate(() => document.activeElement?.id), 'home-search', '/ focuses search');
        }
      }, { browser, viewport });
    });
  }
}

await test('search finds tools by name, keyword and accent-free text, and Back clears it', async () => {
  await withPage(async (page, url) => {
    await fakeTools(page);
    await openApp(page, url);
    const results = async () => page.$$eval('.home-results .ui-card-title, .home-results .scan-card-title', (els) => els.map((e) => e.textContent));
    const type = async (q) => {
      await page.fill('#home-search', q);
      await page.waitForTimeout(50);
    };
    await type('merge');
    eq(await results(), ['Merge PDF'], 'by name');
    eq(await page.textContent('.home-results-count'), '1 tool found', 'count');
    assert(await page.isHidden('.home-sections') && await page.isHidden('.scan-card-buttons >> nth=0').catch(() => true), 'sections hidden');
    await type('join');
    eq(await results(), ['Merge PDF'], 'by keyword');
    await type('MÉRGÉ');
    eq(await results(), ['Merge PDF'], 'case and accents');
    await type('scan');
    eq(await results(), ['Scan document', 'Images to PDF'], 'scan card first, found by name');
    assert(await page.isVisible('.home-results .scan-card button'), 'scan card with its buttons');
    await type('batch');
    eq(await results(), ['Word to PDF', 'PowerPoint to PDF', 'Excel to PDF', 'EPUB to PDF', 'Add page numbers', 'Add watermark', 'Compress PDF', 'Flatten PDF'], 'batch');
    await type('several');
    eq((await results()).length, 8, 'several');
    await type('zebra');
    eq(await page.textContent('.home-results-count'), 'No tools match "zebra"', 'none');
    // A tool opened from the results, then Back: the results are as they were.
    await type('split');
    await page.click('.home-results .ui-card-main');
    await onScreen(page, 'tool', 'split');
    await page.goBack();
    await onScreen(page, 'home');
    eq(await page.inputValue('#home-search'), 'split', 'query kept');
    eq(await results(), ['Split PDF'], 'results kept');
    // Back clears the search first, as in the app.
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#home-search').value === '');
    assert(await page.isVisible('.home-sections'), 'sections back');
    // Escape clears it too.
    await type('rotate');
    await page.press('#home-search', 'Escape');
    eq(await page.inputValue('#home-search'), '', 'escape clears');
  }, { browser: BROWSER });
});

await test('routes, Back, files handed over, and the unsaved-work question', async () => {
  await withPage(async (page, url, context) => {
    await fakeTools(page);
    await openApp(page, url);
    // A tool card opens the tool's module with its params.
    await page.click('.home-sections .ui-card-main:has-text("Word to PDF")');
    await onScreen(page, 'tool', 'word');
    eq(await hashOf(page), '#/tool/word', 'hash');
    eq(await page.evaluate(() => window.__tool), { id: 'word', params: { kind: 'word' }, files: null, from: null, mounted: 1 }, 'ctx');
    eq(await page.evaluate(() => document.activeElement?.textContent), 'Fake word', 'focus on the heading');
    await page.goBack();
    await onScreen(page, 'home');
    eq(await page.evaluate(() => window.__unmounts), 1, 'unmounted');
    // Home's scroll position comes back.
    await page.evaluate(() => window.scrollTo(0, 400));
    const y = await page.evaluate(() => window.scrollY);
    // Clicked without scrolling it into view first.
    await page.evaluate(() => Array.from(document.querySelectorAll('.home-sections .ui-card-main')).find((b) => b.textContent.includes('Compress PDF')).click());
    await onScreen(page, 'tool', 'compress');
    await page.click('.fake-back');
    await onScreen(page, 'home');
    await page.waitForTimeout(50);
    eq(await page.evaluate(() => window.scrollY), y, 'scroll restored');
    // navigate() hands files to the tool.
    await page.evaluate(async () => {
      const { navigate } = await import('./js/core/router.js');
      await navigate('/tool/scan', { files: [{ name: 'a.jpg', type: 'image/jpeg', size: 1, lastModified: 0, bytes: new Uint8Array([1]) }] });
    });
    await onScreen(page, 'tool', 'scan');
    eq(await page.evaluate(() => [window.__tool.files, window.__tool.params]), [['a.jpg'], { start: 'scan' }], 'files and params');
    // Unsaved work: Back asks; Keep stays, Discard leaves.
    await page.evaluate(() => { window.__toolState.unsaved = true; });
    await page.goBack();
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.textContent('dialog[open] .ui-dialog-title'), common.tool_discard_title, 'question');
    await page.click('dialog[open] button:has-text("Keep")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    eq(await hashOf(page), '#/tool/scan', 'kept');
    assert(await page.isVisible('#app .screen[data-tool="scan"]'), 'still on the tool');
    await page.click('.fake-back');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    await page.click('dialog[open] button:has-text("Discard")');
    await onScreen(page, 'home');
    assert(['', '#/'].includes(await hashOf(page)), 'left after discarding');
    // A tool's inner step: Back returns to the step before, staying in the tool.
    await page.click('.home-sections .ui-card-main:has-text("Split PDF")');
    await onScreen(page, 'tool', 'split');
    await page.click('.fake-step');
    await page.goBack();
    await page.waitForFunction(() => window.__toolState.steps.length === 1);
    eq(await page.evaluate(() => window.__toolState.steps), [null], 'onStep(null)');
    eq(await hashOf(page), '#/tool/split', 'still in the tool');
    await page.click('.fake-step');
    await page.click('.fake-back');
    await onScreen(page, 'home');
    // An unknown address shows Home.
    await page.goto(url + 'app/#/nowhere');
    await onScreen(page, 'home');
    eq(await hashOf(page), '#/', 'unknown address');
    // Opened straight at an address (a new tab), the back arrow leads up.
    const tab = await context.newPage();
    await tab.goto(url + 'app/#/settings/about/licenses');
    await onScreen(tab, 'licenses');
    await tab.click('.ui-topbar-nav');
    await onScreen(tab, 'about');
    eq(await hashOf(tab), '#/settings/about', 'up to About');
    await tab.click('.ui-topbar-nav');
    await onScreen(tab, 'settings');
    await tab.click('.ui-topbar-nav');
    await onScreen(tab, 'home');
    await tab.close();
  }, { browser: BROWSER });
});

await test('a tool screen that is missing or fails to load says so, with a way back', async () => {
  await withPage(async (page, url) => {
    await page.route('**/app/js/tools/redact/index.js', (route) => route.fulfill({ status: 404, body: 'Not found' }));
    await page.route('**/app/js/tools/sign/index.js', (route) => route.abort('internetdisconnected'));
    await openApp(page, url, '#/tool/redact');
    await page.waitForSelector('.shell-problem');
    eq(await page.textContent('.shell-problem p'), "Redact PDF isn't available in the web app yet.", 'missing');
    await page.click('.shell-problem button');
    await onScreen(page, 'home');
    await page.goto(url + 'app/#/tool/sign');
    await page.waitForSelector('.shell-problem');
    assert((await page.textContent('.shell-problem p')).startsWith("Couldn't load Sign PDF."), 'network');
    assert(await page.isVisible('.shell-problem button:has-text("Try again")'), 'try again');
  }, { ignoreProblems: true, browser: BROWSER });
});

await test('Settings: Appearance changes the theme at once and is kept; Language; About; licenses', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url);
    await page.click('.ui-topbar button[aria-label="Settings"]');
    await onScreen(page, 'settings');
    const items = await page.$$eval('.settings-list .ui-list-title', (els) => els.map((e) => e.textContent.trim()));
    eq(items, ['Language', 'Appearance', 'Source code on GitHub (opens in a new tab)', 'About Usugami'], 'rows');
    await page.click('.ui-list-main:has-text("Appearance")');
    await page.waitForSelector('dialog[open] [role="listbox"]');
    eq(await page.$$eval('dialog[open] [role="option"]', (els) => els.map((e) => [e.textContent, e.getAttribute('aria-selected')])),
      [['System default', 'true'], ['Light', 'false'], ['Dark', 'false']], 'choices');
    await page.click('dialog[open] [role="option"]:has-text("Dark")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    eq(await page.getAttribute('html', 'data-theme'), 'dark', 'dark at once');
    eq(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(23, 23, 23)', 'dark background');
    assert((await page.textContent('.settings-list')).includes('Dark'), 'row says Dark');
    eq(await page.evaluate(() => JSON.parse(localStorage.getItem('usugami.settings')).appearance), 'dark', 'saved');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    eq(await page.getAttribute('html', 'data-theme'), 'dark', 'kept after reload');
    // With the keyboard: Light.
    await page.focus('.ui-list-main:has-text("Appearance")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog[open] [role="listbox"]');
    eq(await page.evaluate(() => document.activeElement.textContent), 'Dark', 'focus on the choice made');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    eq(await page.getAttribute('html', 'data-theme'), 'light', 'light');
    eq(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 248, 247)', 'light background');
    // System default follows the device.
    await page.click('.ui-list-main:has-text("Appearance")');
    await page.click('dialog[open] [role="option"]:has-text("System default")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    eq(await page.getAttribute('html', 'data-theme'), null, 'system');
    // Language: English only, chosen.
    await page.click('.ui-list-main:has-text("Language")');
    eq(await page.$$eval('dialog[open] [role="option"]', (els) => els.map((e) => e.textContent)), ['English'], 'languages');
    await page.click('dialog[open] button:has-text("Cancel")');
    // About and its links.
    await page.click('.ui-list-main:has-text("About Usugami")');
    await onScreen(page, 'about');
    assert((await page.textContent('.about-header')).includes('Version 1.0.0'), 'version');
    const links = await page.$$eval('#app a[href]', (els) => els.map((a) => [a.textContent.replace(' (opens in a new tab)', '').trim(), new URL(a.href).pathname.replace(/^\/usugami-website/, '') || a.href, a.target]));
    const hrefs = Object.fromEntries(links.map(([text, href]) => [text.split(/\s{2,}|(?<=[a-z])(?=github)/)[0], href]));
    assert(Object.values(hrefs).includes('/privacy/'), 'privacy policy ../privacy/: ' + JSON.stringify(links));
    assert(Object.values(hrefs).includes('/download/'), 'Get the Android app ../download/');
    const all = await page.$$eval('#app a[href]', (els) => els.map((a) => a.href));
    assert(all.includes('https://github.com/Nath-Goa/usugami-website') && all.includes('https://github.com/Nath-Goa/usugami'), 'source links');
    await page.click('.ui-list-main:has-text("Open-source licenses")');
    await onScreen(page, 'licenses');
    const text = await page.textContent('.licenses-list');
    for (const part of ['pdf-lib', 'fontkit', 'fflate', 'PDF.js', 'Tesseract.js', 'Tesseract trained data', 'libheif', 'Noto Sans', 'Material Icons', 'Tesseract.js core', 'GNU General Public License v3.0 or later']) {
      assert(text.includes(part), `licenses name ${part}`);
    }
    assert(text.includes('6.4.299'), 'versions from vendor/VERSIONS.json');
    // Each license text the site serves is there, as text the browser shows (not a download).
    const local = await page.$$eval('.licenses-list a', (els) => els.map((a) => a.href).filter((h) => h.startsWith(location.origin)));
    for (const href of local) {
      const res = await page.request.get(href);
      eq(res.status(), 200, href);
      assert((res.headers()['content-type'] ?? '').startsWith('text/'), `${href} is served as text, not ${res.headers()['content-type']}`);
    }
  }, { browser: BROWSER });
});

await test('Recent files: added, listed newest first (at most 50), removed and cleared', async () => {
  await withPage(async (page, url) => {
    await page.route('**/app/js/core/output.js', (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: 'export async function openFile(f) { window.__opened = [f.name, f.bytes.length]; } export async function share(files) { if (window.__shareFails) throw Object.assign(new Error("web_share_failed"), { name: "UserError", key: "web_share_failed", args: [] }); window.__shared = files.map((f) => f.name); }',
    }));
    // A browser that can share files (Share then shows in a row's menu).
    await page.addInitScript(() => {
      navigator.share = async () => {};
      navigator.canShare = () => true;
    });
    await openApp(page, url);
    const add = (name, size) => addRecent(page, name, size);
    assert(await page.isHidden('.home-recent') || !(await page.$('.home-recent .recent-row')), 'no recent files at first');
    await add('One.pdf', 1500);
    await add('Two.pdf', 2500);
    await add('Three.pdf', 960000);
    await add('Four.pdf', 10);
    await page.waitForFunction(() => document.querySelectorAll('.home-recent .recent-row').length === 3 && document.querySelector('.home-recent .recent-name').textContent === 'Four.pdf');
    const homeRows = await page.$$eval('.home-recent .recent-name', (els) => els.map((e) => e.textContent));
    eq(homeRows, ['Four.pdf', 'Three.pdf', 'Two.pdf'], 'Home shows the last three, newest first');
    const detail = await page.textContent('.home-recent .recent-row:nth-child(2) .recent-detail');
    assert(/ · 0\.96 MB$/.test(detail), 'details: time · size: ' + detail);
    // The same file saved again moves up rather than showing twice.
    await add('Two.pdf', 2500);
    await page.waitForFunction(() => document.querySelector('.home-recent .recent-name')?.textContent === 'Two.pdf');
    eq((await runInPage(page, url, 'app/js/core/recent.js', 'listRecent')).length, 4, 'not twice');
    // See all.
    await page.click('.home-recent button:has-text("See all")');
    await onScreen(page, 'recent');
    eq(await page.$$eval('.recent-list .recent-name', (els) => els.map((e) => e.textContent)), ['Two.pdf', 'Four.pdf', 'Three.pdf', 'One.pdf'], 'all of them');
    // Open, share and remove from a row's menu.
    await page.click('.recent-row:has-text("Three.pdf") .recent-open');
    await page.waitForFunction(() => window.__opened);
    eq(await page.evaluate(() => window.__opened), ['Three.pdf', 960000], 'opened with its bytes');
    await page.click('.recent-row:has-text("One.pdf") .recent-menu');
    await page.click('.ui-menu button:has-text("Share")');
    await page.waitForFunction(() => window.__shared);
    eq(await page.evaluate(() => window.__shared), ['One.pdf'], 'shared');
    // A share that fails says so in the kit's own words, not the bare "an unexpected error occurred".
    await page.evaluate(() => { window.__shareFails = true; });
    await page.click('.recent-row:has-text("One.pdf") .recent-menu');
    await page.click('.ui-menu button:has-text("Share")');
    await page.waitForSelector('.ui-snackbar-text');
    eq(await page.textContent('.ui-snackbar-text'), kit.web_share_failed, 'a failed share says why');
    await page.evaluate(() => { window.__shareFails = false; document.querySelectorAll('.ui-snackbar').forEach((n) => n.dismiss?.()); });
    // Each row is named by what it shows (its name, then when and how large), no other label.
    const named = await page.$eval('.recent-row:has-text("Three.pdf") .recent-open', (b) => [b.getAttribute('aria-label'), b.querySelector('[aria-hidden="true"].recent-text') === null, b.textContent]);
    eq([named[0], named[1]], [null, true], 'no aria-label over the visible text');
    assert(named[2].startsWith('Three.pdf') && named[2].includes('0.96 MB'), 'its text names it: ' + named[2]);
    await page.click('.recent-row:has-text("One.pdf") .recent-menu');
    await page.click('.ui-menu button:has-text("Remove from list")');
    await page.waitForFunction(() => document.querySelectorAll('.recent-list .recent-row').length === 3);
    eq(await runInPage(page, url, 'app/js/core/recent.js', 'getRecentBytes', 'nope'), null, 'unknown id');
    // Removed with the keyboard: the focus goes to the row now in its place.
    const before = await page.$$eval('.recent-list .recent-name', (els) => els.map((e) => e.textContent));
    await page.focus('.recent-row:nth-child(2) .recent-menu');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ui-menu');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.recent-list .recent-row').length === 2);
    await page.waitForFunction(() => document.activeElement?.closest('.recent-row'));
    eq(await page.evaluate(() => [document.activeElement.className, document.activeElement.closest('.recent-row').querySelector('.recent-name').textContent]), ['recent-open', before[2]], 'the focus on the row now in its place');
    // Clear list, a text button as in the app, asks first.
    eq(await page.$$eval('.ui-topbar-actions button', (els) => els.map((b) => [b.textContent.trim(), !!b.querySelector('svg')])), [['Clear list', false]], 'Clear list is a text button');
    await page.click('.ui-topbar button:has-text("Clear list")');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.textContent('dialog[open] .ui-dialog-title'), 'Clear the list?', 'asks');
    await page.click('dialog[open] button:has-text("Cancel")');
    eq(await page.$$eval('.recent-list .recent-row', (els) => els.length), 2, 'kept');
    await page.click('.ui-topbar button:has-text("Clear list")');
    await page.click('dialog[open] button:has-text("Clear list")');
    await page.waitForSelector('.recent-empty:not([hidden])');
    eq(await page.textContent('.recent-empty'), common.recent_empty, 'empty');
    eq(await runInPage(page, url, 'app/js/core/recent.js', 'listRecent'), [], 'cleared');
    // At most 50, the oldest going first.
    await page.evaluate(async () => {
      const { addRecent } = await import('./js/core/recent.js');
      for (let i = 1; i <= 55; i++) await addRecent({ name: `F${i}.pdf`, type: 'application/pdf', bytes: new Uint8Array([i]) });
    });
    const list = await runInPage(page, url, 'app/js/core/recent.js', 'listRecent');
    eq([list.length, list[0].name, list[49].name], [50, 'F55.pdf', 'F6.pdf'], 'at most 50');
    // A file whose copy is gone says so and offers to take it off the list.
    await page.evaluate(async () => {
      const db = await new Promise((r) => { const q = indexedDB.open('usugami'); q.onsuccess = () => r(q.result); });
      const { listRecent } = await import('./js/core/recent.js');
      const [first] = await listRecent();
      await new Promise((r) => { const tx = db.transaction('recentBytes', 'readwrite'); tx.objectStore('recentBytes').delete(first.id); tx.oncomplete = r; });
      db.close();
    });
    await page.click('.recent-list .recent-row:first-child .recent-open');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.textContent('dialog[open] .ui-dialog-title'), common.recent_lost_title, 'lost');
    await page.click('dialog[open] button:has-text("Remove from list")');
    await page.waitForFunction(() => document.querySelectorAll('.recent-list .recent-row').length === 49);
  }, { browser: BROWSER });
});

await test('Recent files without storage: kept for the visit, nothing breaks', async () => {
  await withPage(async (page, url) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('blocked', 'SecurityError'); } });
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    await openApp(page, url);
    await page.evaluate(async () => {
      const { addRecent } = await import('./js/core/recent.js');
      await addRecent({ name: 'Kept.pdf', type: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) });
    });
    await page.waitForSelector('.home-recent .recent-row');
    eq(await page.textContent('.home-recent .recent-name'), 'Kept.pdf', 'listed in memory');
  }, { browser: BROWSER });
});

await test('files shared to the app: PDFs to Choose a tool, images and documents to their tool, others named', async () => {
  const pdf1 = await makePdf(1);
  const pdf2 = await makePdf(3);
  await withPage(async (page, url) => {
    await fakeTools(page);
    await openApp(page, url);
    const receive = (files) => page.evaluate(async (list) => {
      const { receiveFiles } = await import('./js/core/share-inbox.js');
      await receiveFiles(list.map((f) => new File([new Uint8Array(f.bytes)], f.name, { type: f.type })));
    }, files.map((f) => ({ ...f, bytes: Array.from(f.bytes) })));
    // One PDF: every PDF tool.
    await receive([{ name: 'Report.pdf', type: 'application/pdf', bytes: pdf1 }]);
    await onScreen(page, 'choose');
    await page.waitForSelector('.choose-tools:not([hidden]) section');
    eq(await page.textContent('.ui-file-name'), 'Report.pdf', 'file listed');
    await page.waitForFunction(() => /1 page · /.test(document.querySelector('.ui-file-detail')?.textContent ?? ''));
    const one = await page.$$eval('.choose-tools section', (els) => els.map((s) => Array.from(s.querySelectorAll('.ui-card-title'), (c) => c.textContent)));
    eq(one, [['Merge PDF', 'Split PDF', 'Reorganize PDF', 'Delete pages', 'Rotate PDF'], ['Edit PDF', 'Sign PDF', 'Add page numbers', 'Add watermark'], ['Compress PDF', 'Redact PDF', 'Flatten PDF']], 'every PDF tool');
    // A tool opened from here gets the PDFs, and goes back here.
    await page.click('.choose-tools .ui-card-main:has-text("Split PDF")');
    await onScreen(page, 'tool', 'split');
    eq(await page.evaluate(() => [window.__tool.files, window.__tool.from]), [['Report.pdf'], '/choose'], 'tool from Choose a tool');
    await page.click('.fake-back');
    await onScreen(page, 'choose');
    eq(await page.textContent('.ui-file-name'), 'Report.pdf', 'still there');
    // Leaving Choose a tool lets the PDFs go.
    await page.click('.ui-topbar-nav');
    await onScreen(page, 'home');
    // Several PDFs, with an image and a text file: the PDFs, naming the others.
    await receive([
      { name: 'a.pdf', type: 'application/pdf', bytes: pdf1 },
      { name: 'photo.jpg', type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]) },
      { name: 'b.pdf', type: '', bytes: pdf2 },
      { name: 'notes.txt', type: 'text/plain', bytes: new Uint8Array([104, 105]) },
    ]);
    await onScreen(page, 'choose');
    await page.waitForSelector('.choose-tools:not([hidden]) section');
    eq(await page.$$eval('.ui-file-name', (els) => els.map((e) => e.textContent)), ['a.pdf', 'b.pdf'], 'the PDFs');
    eq(await page.textContent('.choose-hint'), common.share_several_hint, 'hint');
    const several = await page.$$eval('.choose-tools section', (els) => els.map((s) => Array.from(s.querySelectorAll('.ui-card-title'), (c) => c.textContent)));
    eq(several, [['Merge PDF'], ['Add page numbers', 'Add watermark'], ['Compress PDF', 'Flatten PDF']], 'tools for several');
    const snacks = await page.$$eval('.ui-snackbar-text', (els) => els.map((e) => e.textContent));
    const queued = snacks.join(' | ');
    assert(queued.includes("Usugami can't open notes.txt, so it was left out.") || queued.includes('photo.jpg was left out'), 'messages: ' + queued);
    // Removing every PDF leaves the screen.
    await page.click('.ui-file-card:has-text("a.pdf") button[aria-label="Remove a.pdf"]');
    await page.click('.ui-file-card:has-text("b.pdf") button[aria-label="Remove b.pdf"]');
    await onScreen(page, 'home');
    // Files dropped on Home open the same way.
    await page.evaluate((bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'Dropped.pdf', { type: 'application/pdf' }));
      const target = document.querySelector('.home-page');
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }, Array.from(pdf1));
    await onScreen(page, 'choose');
    await page.waitForSelector('.choose-tools:not([hidden]) section');
    eq(await page.textContent('.ui-file-name'), 'Dropped.pdf', 'dropped PDF');
    await page.click('.ui-topbar-nav');
    await onScreen(page, 'home');
    // Images open Images to PDF; Word files their converter.
    await receive([{ name: 'p.png', type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) }]);
    await onScreen(page, 'tool', 'images');
    eq(await page.evaluate(() => window.__tool.files), ['p.png'], 'images');
    await receive([{ name: 'Letter.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]) }]);
    await onScreen(page, 'tool', 'word');
    eq(await page.evaluate(() => [window.__tool.files, window.__tool.params]), [['Letter.docx'], { kind: 'word' }], 'word');
    // A tool with unsaved work asks first; Keep makes the files wait until the user leaves.
    await page.evaluate(() => { window.__toolState.unsaved = true; });
    const pending = receive([{ name: 'Talk.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) }]);
    await page.waitForSelector('dialog[open] .ui-dialog-body');
    eq(await page.textContent('dialog[open] .ui-dialog-body'), common.share_discard_changes, 'asks');
    await page.click('dialog[open] button:has-text("Keep")');
    await pending;
    assert(await page.isVisible('#app .screen[data-tool="word"]'), 'stays');
    await page.evaluate(() => { window.__toolState.unsaved = false; });
    await page.click('.fake-back');
    await onScreen(page, 'tool', 'powerpoint');
    eq(await page.evaluate(() => window.__tool.files), ['Talk.pptx'], 'opened once the user left');
  }, { browser: BROWSER });
});

await test('the manifest is valid, with icons, share target and file handlers, all relative', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url);
    const href = await page.$eval('link[rel="manifest"]', (l) => l.href);
    const res = await page.request.get(href);
    eq(res.status(), 200, 'served');
    const m = await res.json();
    eq([m.name, m.short_name, m.start_url, m.scope, m.display, m.id], ['Usugami', 'Usugami', './', './', 'standalone', './'], 'basics');
    assert(/^#[0-9a-f]{6}$/i.test(m.theme_color) && /^#[0-9a-f]{6}$/i.test(m.background_color), 'colours');
    const css = await readFile(join(root, 'site', 'assets', 'css', 'tokens.css'), 'utf8');
    assert(css.toLowerCase().includes(m.background_color.toLowerCase()), 'colours from the tokens');
    const sizes = m.icons.map((i) => `${i.sizes} ${i.purpose}`);
    for (const s of ['192x192 any', '512x512 any', '512x512 maskable']) assert(sizes.includes(s), 'icon ' + s);
    const urls = [...m.icons.map((i) => i.src), m.share_target.action, ...m.file_handlers.map((f) => f.action), m.start_url, m.scope];
    for (const u of urls) assert(!u.startsWith('/') && !/^[a-z]+:/i.test(u), 'relative: ' + u);
    for (const i of m.icons) {
      const r = await page.request.get(new URL(i.src, href).href);
      eq(r.status(), 200, i.src);
      if (i.type === 'image/png') {
        const dims = await page.evaluate(async (src) => { const img = new Image(); img.src = src; await img.decode(); return `${img.naturalWidth}x${img.naturalHeight}`; }, new URL(i.src, href).href);
        eq(dims, i.sizes, 'icon size ' + i.src);
      }
    }
    eq([m.share_target.method, m.share_target.enctype], ['POST', 'multipart/form-data'], 'share target');
    // Only files, of the kinds Usugami opens, as the app's share filters: no text or links.
    eq(Object.keys(m.share_target.params), ['files'], 'shares take files only');
    const accept = m.share_target.params.files[0].accept;
    for (const a of ['application/pdf', 'image/jpeg', '.docx', '.pptx', '.xlsx', '.epub']) assert(accept.includes(a), 'share accepts ' + a);
    const handled = Object.values(m.file_handlers[0].accept).flat();
    for (const ext of ['.pdf', '.jpg', '.png', '.heic', '.docx', '.pptx', '.xlsx', '.epub']) assert(handled.includes(ext), 'opens ' + ext);
    // The page's icons and colours.
    for (const sel of ['link[rel="icon"][type="image/svg+xml"]', 'link[rel="apple-touch-icon"]', 'meta[name="theme-color"][media*="dark"]']) assert(await page.$(sel), sel);
    const apple = await page.$eval('link[rel="apple-touch-icon"]', (l) => l.href);
    eq(await page.evaluate(async (src) => { const img = new Image(); img.src = src; await img.decode(); return img.naturalWidth; }, apple), 180, 'apple-touch-icon');
    // The service worker's version line, which the deploy workflow replaces.
    const sw = await readFile(join(root, 'site', 'app', 'sw.js'), 'utf8');
    assert(sw.split('\n').includes("const VERSION = 'dev';"), 'VERSION line');
  });
});

/** Waits until the service worker controls the page. */
const swControls = (page) => page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  }
});

await test('the service worker registers, serves the app offline, and receives shared files', async () => {
  const pdf = await makePdf(2);
  if (BROWSER === 'firefox') {
    // Playwright's request routing, which the harness uses to stop outside requests, makes Firefox
    // bypass service workers; so Firefox is checked without it.
    const { firefox } = await import('playwright');
    const { startServer } = await import('../tools/serve.mjs');
    const server = await startServer({ prefix: 'usugami-website' });
    const browser = await firefox.launch();
    try {
      const context = await browser.newContext({ serviceWorkers: 'allow' });
      const page = await context.newPage();
      await openApp(page, server.url);
      await swControls(page);
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]');
      await context.setOffline(true);
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
      eq(await page.$$eval('.home-sections .ui-card', (els) => els.length), 17, 'Home offline in Firefox');
    } finally {
      await browser.close();
      await server.close();
    }
    return;
  }
  await withPage(async (page, url, context) => {
    await openApp(page, url);
    await swControls(page);
    // Opened once more online, so what it uses is kept as it is used.
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
    await onScreen(page, 'home');
    eq(await page.$$eval('.home-sections .ui-card', (els) => els.length), 17, 'Home offline');
    await page.click('.ui-topbar button[aria-label="Settings"]');
    await onScreen(page, 'settings');
    await context.setOffline(false);
    // Share target: the files are kept and the app picks them up.
    const redirected = await page.evaluate(async (bytes) => {
      const form = new FormData();
      form.append('files', new File([new Uint8Array(bytes)], 'Shared.pdf', { type: 'application/pdf' }));
      const res = await fetch(new URL('share-target', document.baseURI), { method: 'POST', body: form });
      return res.url;
    }, Array.from(pdf));
    assert(/\?share=\d+-/.test(redirected), 'redirected with the share: ' + redirected);
    await page.goto(redirected);
    await onScreen(page, 'choose');
    await page.waitForFunction(() => /2 pages · /.test(document.querySelector('.ui-file-detail')?.textContent ?? ''));
    eq(await page.textContent('.ui-file-name'), 'Shared.pdf', 'shared PDF on Choose a tool');
    eq(await page.evaluate(() => location.search), '', 'address cleaned');
    eq(await page.evaluate(async () => (await (await caches.open('usugami-share')).keys()).length), 0, 'share cache emptied');
    // Offline, only the app's own page is answered with the shell: at another address under
    // app/ its relative files would load nothing (a blank screen).
    await context.setOffline(true);
    const other = await context.newPage();
    const deep = await other.goto(url + 'app/a/b/c').then((r) => r?.status() ?? 0, () => 0);
    assert(deep !== 200 || !(await other.$('#app')), 'no shell at app/a/b/c offline (' + deep + ')');
    await other.close();
    await page.goto(url + 'app/?x=1');
    await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
    await context.setOffline(false);
  }, { serviceWorkers: 'allow', browser: BROWSER });
});

await test('the service worker after a deploy: one version\'s code only, the tools used before fetched again for it', async () => {
  if (BROWSER !== 'chromium') return;
  // Two versions of the site, served by a small server in front of the site's: sw.js's VERSION
  // and a marker in some files differ. (Playwright's routing doesn't see a service worker's own
  // requests, so it can't stand in for them.)
  let version = 'a';
  const marked = ['js/screens/settings.js', 'js/tools/split/index.js', 'js/core/output.js'];
  const { startServer } = await import('../tools/serve.mjs');
  const { createServer } = await import('node:http');
  const site = await startServer({ prefix: 'usugami-website' });
  const front = createServer(async (req, res) => {
    try {
      const upstream = await fetch(new URL(req.url, site.url).href);
      let body = Buffer.from(await upstream.arrayBuffer());
      const path = new URL(req.url, 'http://x').pathname;
      if (path.endsWith('/app/sw.js')) body = Buffer.from(body.toString('utf8').replace("const VERSION = 'dev';", `const VERSION = '${version}';`));
      else if (marked.some((m) => path.endsWith('/app/' + m))) body = Buffer.from(body.toString('utf8') + `\n// BUILD-${version}\n`);
      const headers = { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-cache' };
      if (upstream.headers.get('location')) headers.location = upstream.headers.get('location');
      res.writeHead(upstream.status, headers);
      res.end(body);
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${front.address().port}/usugami-website/`;
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const problems = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push('page error: ' + e.message));
    await openApp(page, url);
    await swControls(page);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await go(page, '/settings');
    await onScreen(page, 'settings');
    await page.evaluate(() => fetch('js/tools/split/index.js').then((r) => r.text()));
    await waitKept(page, ['js/tools/split/index.js']);
    const before = await page.evaluate(async () => (await caches.keys()).sort());
    assert(before.includes('usugami-shell-a') && before.includes('usugami-code-a'), 'version a kept: ' + before);
    // Version b is published: the next visit installs it.
    version = 'b';
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    for (let i = 0; ; i++) {
      const keys = await page.evaluate(() => caches.keys());
      if (keys.includes('usugami-shell-b') && keys.includes('usugami-code-b') && !keys.includes('usugami-shell-a') && !keys.includes('usugami-code-a')) break;
      if (i > 150) throw new Error('version b not installed: ' + keys);
      await page.waitForTimeout(200);
    }
    const code = await page.evaluate(async () => (await (await caches.open('usugami-code-b')).keys()).map((r) => new URL(r.url).pathname));
    assert(code.some((p) => p.endsWith('/js/tools/split/index.js')), 'the tool used before is fetched again for b: ' + code.join(', '));
    const runtimeCode = await page.evaluate(async () => (await (await caches.open('usugami-runtime')).keys()).map((r) => r.url).filter((u) => /\/app\/(js|css|locales)\//.test(u)));
    eq(runtimeCode, [], 'no code in the runtime cache');
    // Offline, every file comes from version b.
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
    const markers = await page.evaluate((list) => Promise.all(list.map((p) => fetch(p).then((r) => r.text()).then((t) => t.match(/BUILD-(\w)/)?.[1] ?? null))), marked);
    eq(markers, ['b', 'b', 'b'], 'offline: all of version b');
    await context.setOffline(false);
  } finally {
    await browser.close();
    front.closeAllConnections?.();
    await new Promise((r) => front.close(r));
    await site.close();
  }
  eq(problems, [], 'no page errors');
});

await test('a screen words its own discard question, for Back and leaving; a new language keeps unsaved work', async () => {
  await withPage(async (page, url) => {
    await fakeTools(page);
    // Two languages: English, and a stand-in "French" whose strings are English but one.
    await page.route('**/app/locales/languages.js', (route) => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: "export const LANGUAGES = [{ code: 'en', name: 'English', dir: 'ltr' }, { code: 'fr', name: 'Français', dir: 'ltr' }];",
    }));
    await page.route('**/app/locales/fr/*.js', (route) => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: route.request().url().endsWith('/common.js') ? "export default { home_title: 'Usugami FR' };" : 'export default {};',
    }));
    await page.addInitScript(() => localStorage.setItem('usugami.settings', JSON.stringify({ language: 'en' })));
    const setLanguage = (code) => page.evaluate(async (c) => (await import('./js/core/i18n.js')).setLanguage(c), code);
    const go = (path) => page.evaluate(async (p) => (await import('./js/core/router.js')).navigate(p), path);
    await openApp(page, url);
    await go('/tool/split');
    await onScreen(page, 'tool', 'split');
    // The screen's own question, with its own buttons.
    await page.evaluate(() => {
      window.__toolState.unsaved = true;
      window.__toolState.question = { title: 'Discard these pages?', message: 'They are not saved yet.', confirm: 'Throw away', dismiss: 'Hold on' };
    });
    const asked = async () => {
      await page.waitForSelector('dialog[open] .ui-dialog-title');
      const q = await page.evaluate(() => [
        document.querySelector('dialog[open] .ui-dialog-title').textContent,
        document.querySelector('dialog[open] .ui-dialog-body')?.textContent,
        Array.from(document.querySelectorAll('dialog[open] button'), (b) => b.textContent.trim()).sort(),
      ]);
      await page.click('dialog[open] button:has-text("Hold on")');
      await page.waitForSelector('dialog[open]', { state: 'detached' });
      return q;
    };
    const expected = ['Discard these pages?', 'They are not saved yet.', ['Hold on', 'Throw away']];
    await page.click('.fake-back');
    eq(await asked(), expected, 'leaving asks the screen\'s question');
    await page.goBack();
    eq(await asked(), expected, 'the browser\'s Back asks it too');
    eq(await hashOf(page), '#/tool/split', 'kept');
    // Without one, the generic question.
    await page.evaluate(() => { window.__toolState.question = null; });
    await page.click('.fake-back');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.textContent('dialog[open] .ui-dialog-title'), common.tool_discard_title, 'generic question');
    await page.click('dialog[open] button:has-text("Keep")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    // A new language while there is unsaved work: the screen isn't drawn again (its work stays).
    await setLanguage('fr');
    eq(await page.evaluate(() => [document.documentElement.lang, window.__tool.mounted, window.__unmounts ?? 0]), ['fr', 1, 0], 'not mounted again with unsaved work');
    assert(await page.isVisible('#app .screen[data-tool="split"]'), 'still showing');
    // Without unsaved work, it is drawn again in the new language.
    await page.evaluate(() => { window.__toolState.unsaved = false; });
    await setLanguage('en');
    await page.waitForFunction(() => window.__tool.mounted === 2);
    await onScreen(page, 'tool', 'split');
    // A tool handed files isn't drawn again either (that would lose them).
    await page.evaluate(async () => {
      const { navigate } = await import('./js/core/router.js');
      await navigate('/tool/scan', { files: [{ name: 'a.jpg', type: 'image/jpeg', size: 1, lastModified: 0, bytes: new Uint8Array([1]) }] });
    });
    await onScreen(page, 'tool', 'scan');
    const unmounts = await page.evaluate(() => window.__unmounts ?? 0);
    await setLanguage('fr');
    eq(await page.evaluate(() => [window.__tool.id, window.__tool.files, window.__unmounts ?? 0]), ['scan', ['a.jpg'], unmounts], 'files kept');
    // The next screen shows in the new language.
    await go('/');
    await onScreen(page, 'home');
    eq(await page.$eval('#app > .screen h1', (e) => e.textContent), 'Usugami FR', 'Home in the new language');
    // Discarding with the screen's question leaves.
    await go('/tool/split');
    await onScreen(page, 'tool', 'split');
    await page.evaluate(() => {
      window.__toolState.unsaved = true;
      window.__toolState.question = { title: 'Discard these images?', message: 'Gone.', confirm: 'Throw away', dismiss: 'Hold on' };
    });
    await page.click('.fake-back');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    await page.click('dialog[open] button:has-text("Throw away")');
    await onScreen(page, 'home');
  }, { browser: BROWSER });
});

await test('Home: Take photo goes through the photo flow, Upload images through the crop screens; the picker opens within the tap', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await withPage(async (page, url) => {
    await fakeTools(page);
    // Records each file picker opened, and whether it was opened during the tap itself.
    await page.addInitScript(() => {
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') (window.__pickers ??= []).push({ inTap: window.event?.type === 'click', capture: this.getAttribute('capture'), multiple: this.multiple });
        return click.call(this);
      };
    });
    await openApp(page, url);
    const [photo] = await Promise.all([page.waitForEvent('filechooser'), page.click('.scan-card button:has-text("Take photo")')]);
    await photo.setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
    await onScreen(page, 'tool', 'scan');
    eq(await page.evaluate(() => [window.__tool.files, window.__tool.params]), [['photo.png'], { start: 'scan', camera: '1' }], 'the photo flow');
    await page.click('.fake-back');
    await onScreen(page, 'home');
    const [upload] = await Promise.all([page.waitForEvent('filechooser'), page.click('.scan-card button:has-text("Upload images")')]);
    await upload.setFiles([{ name: 'a.png', mimeType: 'image/png', buffer: png }, { name: 'b.png', mimeType: 'image/png', buffer: png }]);
    await onScreen(page, 'tool', 'scan');
    eq(await page.evaluate(() => [window.__tool.files, window.__tool.params]), [['a.png', 'b.png'], { start: 'scan' }], 'the crop screens');
    eq(await page.evaluate(() => window.__pickers), [
      { inTap: true, capture: 'environment', multiple: false },
      { inTap: true, capture: null, multiple: true },
    ], 'pickers opened within the tap');
  }, { browser: BROWSER });
});

await test('images shared while Scan document or Images to PDF shows join it, with no question', async () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
  await withPage(async (page, url) => {
    await fakeTools(page);
    await page.addInitScript(() => { window.__fakeReceives = true; });
    await openApp(page, url);
    const receive = (name) => page.evaluate(async ([n, bytes]) => {
      const { receiveFiles } = await import('./js/core/share-inbox.js');
      await receiveFiles([new File([new Uint8Array(bytes)], n, { type: 'image/png' })]);
    }, [name, png]);
    for (const id of ['scan', 'images']) {
      await page.evaluate(async (tool) => {
        const { navigate } = await import('./js/core/router.js');
        await navigate('/tool/' + tool, { files: [{ name: 'first.png', type: 'image/png', size: 1, lastModified: 0, bytes: new Uint8Array([1]) }] });
      }, id);
      await onScreen(page, 'tool', id);
      await page.evaluate(() => { window.__toolState.unsaved = true; window.__received = []; });
      const mounted = await page.evaluate(() => window.__tool.mounted);
      await receive(id + '.png');
      eq(await page.evaluate(() => [window.__received, window.__tool.mounted, !!document.querySelector('dialog[open]')]), [[id + '.png'], mounted, false], id + ' took them');
      assert(await page.isVisible(`#app .screen[data-tool="${id}"]`), 'still on ' + id);
      await page.evaluate(() => { window.__toolState.unsaved = false; });
    }
  }, { browser: BROWSER });
});

await test('lib wrappers: pdf.js takes more options and is freed by its loading task; Tesseract takes errorHandler and config', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 400]).drawText('Hi', { x: 40, y: 300, size: 20, font });
  const pdf = Array.from(await doc.save());
  await withPage(async (page, url) => {
    await openApp(page, url);
    const fonts = await page.evaluate(async (bytes) => {
      const { openPdfJs } = await import('./js/lib/pdfjs.js');
      const input = new Uint8Array(bytes);
      const out = [];
      for (const more of [{}, { fontExtraProperties: true, data: new Uint8Array([1, 2, 3]) }]) {
        const d = await openPdfJs(input, more);
        const p = await d.getPage(1);
        const name = Object.keys((await p.getTextContent()).styles)[0];
        await p.getOperatorList();
        // fontExtraProperties keeps a font's details (its name, widths...) for the page. The font
        // can arrive a moment after the operator list (Firefox): commonObjs calls back once it has.
        const fontObj = await new Promise((resolve) => p.commonObjs.get(name, resolve));
        out.push({ pages: d.numPages, extra: 'widths' in fontObj, destroy: typeof d.destroy, kept: input.length === bytes.length });
        await d.loadingTask.destroy();
        out.at(-1).destroyed = d.loadingTask.destroyed;
      }
      return out;
    }, pdf);
    eq(fonts, [
      { pages: 1, extra: false, destroy: 'undefined', kept: true, destroyed: true },
      { pages: 1, extra: true, destroy: 'undefined', kept: true, destroyed: true },
    ], 'options passed through; its own copy of the bytes always; loadingTask.destroy()');
    const ocr = await page.evaluate(async () => {
      const { createOcrWorker } = await import('./js/lib/tesseract.js');
      const errors = [];
      const worker = await createOcrWorker('en', { errorHandler: (e) => errors.push(String(e)), config: { tessedit_char_whitelist: '0123456789' } });
      const c = document.createElement('canvas');
      c.width = 800;
      c.height = 200;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 800, 200);
      g.fillStyle = '#000';
      g.font = '48px sans-serif';
      g.fillText('PAGE 2019', 40, 120);
      const text = (await worker.recognize(c)).data.text;
      let rejected = null;
      try {
        await worker.recognize(new Uint8Array([1, 2, 3, 4, 5]));
      } catch (e) {
        rejected = String(e);
      }
      await new Promise((r) => setTimeout(r, 200));
      await worker.terminate();
      return { text, rejected, errors };
    });
    // The config holds from the start: only digits are read.
    assert(/2019/.test(ocr.text) && !/[A-Za-z]/.test(ocr.text), 'config: digits only: ' + JSON.stringify(ocr.text));
    // A failed job rejects its promise and goes to errorHandler, not to an uncaught error (which
    // would fail this test as a page error).
    assert(ocr.rejected && ocr.errors.length === 1 && ocr.errors[0] === ocr.rejected, 'errorHandler: ' + JSON.stringify(ocr));
  }, {
    browser: BROWSER,
    // What Tesseract's image reader (Leptonica) logs about the bytes that aren't an image.
    allowConsole: [/findFileFormatStream|pixReadStream|pixRead|Image file \/input cannot be read/],
  });
});

await test('About and Open-source licenses: notices and source code linked; every vendored package, the fonts and the icons listed', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url, '#/settings/about');
    await onScreen(page, 'about');
    const about = await page.$$eval('#app a[href]', (els) => els.map((a) => a.href));
    for (const href of ['https://github.com/Nath-Goa/usugami-website', 'https://github.com/Nath-Goa/usugami-website/blob/main/THIRD_PARTY_NOTICES.md']) assert(about.includes(href), 'About links ' + href);
    await page.click('.ui-list-main:has-text("Open-source licenses")');
    await onScreen(page, 'licenses');
    const links = await page.$$eval('#app a[href]', (els) => els.map((a) => [a.href, a.target]));
    for (const href of ['https://github.com/Nath-Goa/usugami-website', 'https://github.com/Nath-Goa/usugami-website/blob/main/THIRD_PARTY_NOTICES.md']) {
      assert(links.some(([h, target]) => h === href && target === '_blank'), 'licenses link ' + href);
    }
    const covered = await page.evaluate(async () => {
      const { THIRD_PARTY, packagesOf } = await import('./js/screens/licenses.js');
      const versions = await (await fetch('vendor/VERSIONS.json')).json();
      return {
        missing: Object.keys(versions).filter((name) => !THIRD_PARTY.some((p) => packagesOf(p).includes(name))),
        licenses: THIRD_PARTY.map((p) => p.license).join(' | '),
      };
    });
    eq(covered.missing, [], 'every package in vendor/VERSIONS.json is listed');
    assert(covered.licenses.includes('SIL Open Font License 1.1') && covered.licenses.includes('Apache License 2.0'), 'fonts (OFL) and icons (Apache-2.0)');
    const text = await page.textContent('.licenses-list');
    assert(text.includes('Material Icons 0.14.15') || /Material Icons\s*\d/.test(text), 'icons with their version: ' + text.slice(-400));
    assert(text.includes('based in part on the work of the Independent JPEG Group'), 'the IJG notice');
    // Every license text is served with the site as text the browser shows (not a download),
    // and links to other sites don't tell them where the visitor came from.
    const texts = await page.evaluate(async () => {
      const { THIRD_PARTY } = await import('./js/screens/licenses.js');
      return Promise.all(THIRD_PARTY.map(async (p) => {
        const res = await fetch(new URL(p.text, document.baseURI));
        return [p.name, res.status, res.headers.get('content-type') ?? ''];
      }));
    });
    eq(texts.filter(([, status, type]) => status !== 200 || !/^text\//.test(type)), [], 'license texts served as text');
    eq(await page.$$eval('#app a[target="_blank"]', (els) => els.filter((a) => !/\bnoreferrer\b/.test(a.rel)).map((a) => a.href)), [], 'new-tab links with noreferrer');
  }, { browser: BROWSER });
});

/** Waits until the caches of what is kept on first use (code, and data) hold every one of `paths` (relative to app/). */
async function waitKept(page, paths) {
  for (let i = 0; i < 100; i++) {
    const missing = await page.evaluate(async (list) => {
      const urls = new Set();
      for (const name of await caches.keys()) {
        if (name !== 'usugami-runtime' && !name.startsWith('usugami-code-')) continue;
        for (const r of await (await caches.open(name)).keys()) urls.add(r.url);
      }
      return list.filter((p) => !urls.has(new URL(p, document.baseURI).href));
    }, paths);
    if (!missing.length) return;
    if (i === 99) throw new Error('not kept: ' + missing.join(', '));
    await page.waitForTimeout(100);
  }
}

/** Reads a line of text with text recognition, as Images to PDF does; 'ERR <key>' when it can't. */
const readText = (page) => page.evaluate(async () => {
  const { createRecognizer } = await import('./js/engine/ocr.js');
  const c = document.createElement('canvas');
  c.width = 800;
  c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 800, 200);
  g.fillStyle = '#000';
  g.font = '48px sans-serif';
  g.fillText('Hello offline world', 40, 120);
  try {
    const recognizer = await createRecognizer('en');
    try {
      return (await recognizer.recognize(c)).text.trim();
    } finally {
      recognizer.terminate();
    }
  } catch (e) {
    return 'ERR ' + (e.key ?? e.message);
  }
});

/** Files fetched on first use (fonts, a tool, a library), with their sizes or what went wrong. */
const FIRST_USE = ['fonts/NotoSans-Regular.ttf', 'fonts/NotoSansDevanagari-Regular.ttf', 'js/tools/split/index.js', 'vendor/pdfjs/pdf.min.mjs'];
const fetchAll = (page, paths) => page.evaluate((list) => Promise.all(list.map((p) => fetch(p).then(
  (r) => (r.ok ? r.arrayBuffer().then((b) => b.byteLength) : 'HTTP ' + r.status),
  (e) => 'ERR ' + e.message))), paths);

/**
 * Text recognition, fonts, a tool module and a library used once online work offline afterwards:
 * the service worker keeps them as they are first fetched, not when it installs. `goOffline()`
 * cuts the page off from the site.
 */
async function firstUseOffline(page, appUrl, goOffline) {
  await openApp(page, appUrl);
  await swControls(page);
  const shell = await page.evaluate(async () => {
    const name = (await caches.keys()).find((n) => n.startsWith('usugami-shell-'));
    return (await (await caches.open(name)).keys()).map((r) => r.url);
  });
  assert(!shell.some((u) => /\/(vendor\/tesseract|fonts|js\/tools)\//.test(u)), 'not kept at install: ' + shell.filter((u) => /tesseract|fonts|tools/.test(u)).join(', '));
  eq(await readText(page), 'Hello offline world', 'read online');
  const sizes = await fetchAll(page, FIRST_USE);
  assert(sizes.every((s) => typeof s === 'number'), 'fetched online: ' + sizes);
  const ocrFiles = await page.evaluate(async () => {
    const { filesFor } = await import('./js/engine/ocr/loader.js');
    return (await filesFor('en')).map((f) => f.url);
  });
  await waitKept(page, [...FIRST_USE, ...ocrFiles]);
  const kept = await page.evaluate(async () => (await (await caches.open('usugami-runtime')).keys()).map((r) => r.url));
  assert(!kept.some((u) => u.includes('fra.traineddata')), 'only what was used is kept');
  await goOffline();
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
  eq(await readText(page), 'Hello offline world', 'read offline');
  eq(await fetchAll(page, FIRST_USE), sizes, 'fonts, the tool and the library offline');
}

await test('the service worker keeps what is fetched on first use: text recognition, fonts and tools work offline afterwards', async () => {
  if (BROWSER === 'chromium') {
    await withPage(async (page, url, context) => {
      await firstUseOffline(page, url, () => context.setOffline(true));
    }, { serviceWorkers: 'allow', browser: BROWSER });
    // Opened once and then offline: everything the app loads at start was kept when the worker
    // installed (or as it was used), so it starts offline the very next time.
    await withPage(async (page, url, context) => {
      await openApp(page, url);
      await swControls(page);
      const loaded = await page.evaluate(() => [location.href, ...performance.getEntriesByType('resource').map((e) => e.name)]
        .filter((u) => u.startsWith(location.origin + '/')).map((u) => u.split('#')[0]));
      const kept = await page.evaluate(async () => {
        const urls = [];
        for (const name of await caches.keys()) urls.push(...(await (await caches.open(name)).keys()).map((r) => r.url));
        return urls;
      });
      eq([...new Set(loaded)].filter((u) => !kept.includes(u) && !kept.includes(u.replace(/index\.html$/, ''))), [], 'loaded at start but not kept');
      await context.setOffline(true);
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
      eq(await page.$$eval('.home-sections .ui-card', (els) => els.length), 17, 'Home offline after one visit');
    }, { serviceWorkers: 'allow', browser: BROWSER });
    return;
  }
  // Firefox and WebKit: Playwright's request routing (which the harness uses) bypasses service
  // workers in Firefox, and its offline switch doesn't reach them, so the site's server is stopped
  // instead: nothing can come from it any more.
  const pw = await import('playwright');
  const { startServer } = await import('../tools/serve.mjs');
  const server = await startServer({ prefix: 'usugami-website' });
  const browser = await pw[BROWSER].launch();
  const problems = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push('page error: ' + e.message));
    await firstUseOffline(page, server.url, () => new Promise((done) => {
      server.server.close(done);
      server.server.closeAllConnections();
    }));
  } finally {
    await browser.close();
    server.server.closeAllConnections();
    server.server.close();
  }
  eq(problems, [], 'no page errors');
});

await test('Back closes an open dialog or menu first, and answers the discard question as Keep; titles and landmarks', async () => {
  await withPage(async (page, url) => {
    await fakeTools(page);
    await openApp(page, url);
    eq(await page.title(), 'Usugami', 'Home: the tab is titled Usugami');
    // Settings: Back while Appearance is open closes it, and Settings stays.
    await go(page, '/settings');
    await onScreen(page, 'settings');
    eq(await page.title(), 'Settings – Usugami', 'the tab names the screen');
    await page.click('.settings-list :text("Appearance")');
    await page.waitForSelector('dialog[open] .choice-list');
    // The choices aren't read as the dialog's description.
    eq(await page.$eval('dialog[open]', (d) => d.getAttribute('aria-describedby')), null, 'no aria-describedby over the choices');
    await page.goBack();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await onScreen(page, 'settings');
    eq(await hashOf(page), '#/settings', 'Back closed the dialog only');
    await page.goBack();
    await onScreen(page, 'home');
    // Recent files: Back while a row's menu is open closes it; the screen works on.
    await addRecent(page, 'Menu.pdf', 100);
    await go(page, '/recent');
    await onScreen(page, 'recent');
    // Every shell screen has one main landmark, where the skip link leads.
    eq(await page.$$eval('#app main, #app [role="main"]', (els) => els.map((e) => e.id)), ['content'], 'one main landmark, id content');
    await page.focus('.skip-link');
    await page.keyboard.press('Enter');
    assert(await page.evaluate(() => !!document.activeElement.closest('main, [role="main"]')), 'the skip link puts the focus in the main content');
    await page.click('.recent-row .recent-menu');
    await page.waitForSelector('.ui-menu');
    await page.goBack();
    await page.waitForSelector('.ui-menu', { state: 'detached' });
    eq([await hashOf(page), await page.$('.ui-menu-scrim')], ['#/recent', null], 'Back closed the menu and its scrim');
    await page.click('.ui-topbar button:has-text("Clear list")');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    await page.goBack();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    eq(await hashOf(page), '#/recent', 'Clear list still works; Back closed its question');
    // A menu left open when the screen changes otherwise goes with it.
    await page.click('.recent-row .recent-menu');
    await page.waitForSelector('.ui-menu');
    await go(page, '/');
    await onScreen(page, 'home');
    eq(await page.$$('.ui-menu, .ui-menu-scrim').then((l) => l.length), 0, 'no menu over the next screen');
    // The discard question: Back again answers Keep, and the history stays in step.
    await go(page, '/tool/split');
    await onScreen(page, 'tool', 'split');
    eq(await page.title(), 'Split PDF – Usugami', 'a tool names itself');
    await page.evaluate(() => { window.__toolState.unsaved = true; });
    const unmounts = await page.evaluate(() => window.__unmounts ?? 0);
    await page.goBack();
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    await page.goBack();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.waitForTimeout(200);
    eq([await hashOf(page), await page.evaluate(() => window.__unmounts ?? 0)], ['#/tool/split', unmounts], 'Back during the question: Keep, the tool stays');
    await page.goBack();
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await hashOf(page), '#/tool/split', 'asked again');
    await page.click('dialog[open] button:has-text("Discard")');
    await onScreen(page, 'home');
    assert(['', '#/'].includes(await hashOf(page)), 'Discard goes Home, not out of the app');
    // Back from a tool opened from Home puts the focus back on its card.
    await page.focus('.home-sections [data-tool-card="compress"] .ui-card-main');
    await page.keyboard.press('Enter');
    await onScreen(page, 'tool', 'compress');
    await page.goBack();
    await onScreen(page, 'home');
    eq(await page.evaluate(() => document.activeElement?.closest('[data-tool-card]')?.dataset.toolCard), 'compress', 'the focus is back on the card');
    // "/" goes to the search only while no control has the focus.
    await page.keyboard.press('/');
    eq(await page.evaluate(() => document.activeElement?.closest('[data-tool-card]')?.dataset.toolCard), 'compress', '"/" on a card leaves the focus there');
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('/');
    eq(await page.evaluate(() => document.activeElement?.id), 'home-search', '"/" with nothing focused goes to the search');
  }, { browser: BROWSER, viewport: DESKTOP });
});

await test('files shared open in place of the screen showing, worded as the app asks; more shares join those waiting', async () => {
  const pdf1 = await makePdf(1);
  await withPage(async (page, url) => {
    await fakeTools(page);
    await openApp(page, url);
    // From an empty tool: Word to PDF opens in its place, and Back leads Home.
    await go(page, '/tool/split');
    await onScreen(page, 'tool', 'split');
    await receiveOn(page, [{ name: 'Letter.docx', type: DOCX, bytes: ZIP_HEAD }]);
    await onScreen(page, 'tool', 'word');
    await page.click('.fake-back');
    await onScreen(page, 'home');
    // From Settings, PDFs: Choose a tool, then Back: Home.
    await go(page, '/settings');
    await onScreen(page, 'settings');
    await receiveOn(page, [{ name: 'First.pdf', type: 'application/pdf', bytes: pdf1 }]);
    await onScreen(page, 'choose');
    await page.waitForSelector('.choose-tools:not([hidden]) section');
    // More PDFs shared while Choose a tool shows join those listed.
    await receiveOn(page, [{ name: 'Second.pdf', type: 'application/pdf', bytes: pdf1 }]);
    await page.waitForFunction(() => document.querySelectorAll('.ui-file-name').length === 2);
    await page.waitForSelector('.choose-tools:not([hidden]) .choose-hint');
    eq(await page.$$eval('.ui-file-name', (els) => els.map((e) => e.textContent)), ['First.pdf', 'Second.pdf'], 'added to the list');
    await page.click('.ui-topbar-nav');
    await onScreen(page, 'home');
    // From a tool's result, not saved: the app's "Discard this PDF?"; Keep, then a second share
    // joins with no question; leaving opens both together.
    await go(page, '/tool/compress');
    await onScreen(page, 'tool', 'compress');
    await page.click('.fake-step');
    await page.evaluate(() => { window.__toolState.unsaved = true; });
    const first = receiveOn(page, [{ name: 'Letter.docx', type: DOCX, bytes: ZIP_HEAD }]);
    await page.waitForSelector('dialog[open] .ui-dialog-body');
    eq([await page.textContent('dialog[open] .ui-dialog-title'), await page.textContent('dialog[open] .ui-dialog-body')], [common.pdf_discard_title, common.share_discard_body], 'asked about the PDF made');
    await page.click('dialog[open] button:has-text("Keep")');
    await first;
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await receiveOn(page, [{ name: 'Memo.docx', type: DOCX, bytes: ZIP_HEAD }]);
    await page.waitForTimeout(300);
    eq(await page.$('dialog[open]'), null, 'no second question');
    await page.evaluate(() => { window.__toolState.unsaved = false; });
    await page.click('.fake-back');
    await onScreen(page, 'tool', 'word');
    eq(await page.evaluate(() => window.__tool.files), ['Letter.docx', 'Memo.docx'], 'both open together');
    // Images shared over a result: the app's own words for images.
    await page.evaluate(() => { window.__toolState.unsaved = true; });
    await page.click('.fake-step');
    const images = receiveOn(page, [{ name: 'p.png', type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) }]);
    await page.waitForSelector('dialog[open] .ui-dialog-body');
    eq(await page.textContent('dialog[open] .ui-dialog-body'), common.pdf_discard_shared_body, 'images over a PDF made');
    await page.click('dialog[open] button:has-text("Discard")');
    await images;
    await onScreen(page, 'tool', 'images');
    // Opened in place of Word to PDF and its result step: Back is Home.
    await page.click('.fake-back');
    await onScreen(page, 'home');
  }, { browser: BROWSER });
});

await test('a second language: first launch asks, then goes on to the address and the files shared meanwhile; Web strings fall back to the app\'s translation', async () => {
  const pdf1 = await makePdf(1);
  await withPage(async (page, url) => {
    await fakeTools(page);
    await page.route('**/app/locales/languages.js', (route) => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: "export const LANGUAGES = [{ code: 'en', name: 'English', dir: 'ltr' }, { code: 'fr', name: 'Français', dir: 'ltr' }];",
    }));
    // The app's translations only (no web_ strings yet), as the importer writes them.
    await page.route('**/app/locales/fr/*.js', (route) => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: route.request().url().endsWith('/common.js') ? "export default { home_subtitle: 'Vos fichiers restent sur ce téléphone.', tool_word_detail: 'Documents (.docx), convertis sur ce téléphone' };" : 'export default {};',
    }));
    await page.goto(url + 'app/#/tool/split');
    await page.waitForSelector('html[data-ready="true"]');
    await onScreen(page, 'language');
    // A file shared during the choice waits for it.
    await receiveOn(page, [{ name: 'Wait.pdf', type: 'application/pdf', bytes: pdf1 }]);
    await page.waitForTimeout(200);
    await onScreen(page, 'language');
    await page.click('.language-page .ui-card-main:has-text("Français")');
    await onScreen(page, 'choose');
    eq(await page.textContent('.ui-file-name'), 'Wait.pdf', 'the file shared meanwhile opens after the choice');
    await page.click('.ui-topbar-nav');
    await onScreen(page, 'home');
    // In French: the app's translation of the lines the web words for itself, as long as their
    // web_ string isn't translated yet. English keeps the web's wording.
    eq(await page.textContent('.home-subtitle'), 'Vos fichiers restent sur ce téléphone.', 'Home subtitle from the app\'s translation');
    assert((await page.textContent('.home-sections')).includes('convertis sur ce téléphone'), 'Word to PDF\'s line from the app\'s translation');
    await page.evaluate(async () => (await import('./js/core/i18n.js')).setLanguage('en'));
    await onScreen(page, 'home');
    eq(await page.textContent('.home-subtitle'), common.web_home_subtitle, 'English: the web wording');
    // Opened at an address on a first launch, that screen shows once the language is chosen.
    await page.evaluate(() => localStorage.removeItem('usugami.settings'));
    await page.goto(url + 'app/index.html#/tool/merge');
    await page.waitForSelector('html[data-ready="true"]');
    await onScreen(page, 'language');
    await page.click('.language-page .ui-card-main:has-text("English")');
    await onScreen(page, 'tool', 'merge');
  }, { browser: BROWSER });
});

await test('a screen\'s own question with plain buttons; Choose a tool left while a password is asked; installed: storage kept', async () => {
  // A PDF with a password (test123), made by the kit's tests' fixture when there is one.
  const { existsSync } = await import('node:fs');
  const lockedPath = join(root, 'tests', 'fixtures', 'flatten-locked.pdf');
  const locked = existsSync(lockedPath) ? Array.from(await readFile(lockedPath)) : null;
  await withPage(async (page, url) => {
    await fakeTools(page);
    // Running installed (its own window): the app asks the browser to keep its storage.
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => (q === '(display-mode: standalone)' ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q));
      window.__persist = 0;
      if (navigator.storage) navigator.storage.persist = async () => { window.__persist++; return true; };
    });
    await openApp(page, url);
    await page.waitForFunction(() => window.__persist > 0, null, { timeout: 5000 }).catch(() => {});
    eq(await page.evaluate(() => (navigator.storage ? window.__persist > 0 : true)), true, 'storage.persist() asked for, installed');
    // Images to PDF's question has plain buttons, as the app's; the generic one a red Discard.
    await go(page, '/tool/images');
    await onScreen(page, 'tool', 'images');
    await page.evaluate(() => {
      window.__toolState.unsaved = true;
      window.__toolState.question = { title: 'Discard these images?', message: 'Not affected.', destructive: false };
    });
    await page.click('.fake-back');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.$$eval('dialog[open] .ui-btn--danger', (els) => els.length), 0, 'no destructive colour');
    await page.click('dialog[open] button:has-text("Keep")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.evaluate(() => { window.__toolState.question = null; });
    await page.click('.fake-back');
    await page.waitForSelector('dialog[open] .ui-dialog-title');
    eq(await page.$$eval('dialog[open] .ui-btn--danger', (els) => els.map((b) => b.textContent.trim())), [common.discard], 'the generic question\'s Discard in red');
    await page.click('dialog[open] button:has-text("Discard")');
    await onScreen(page, 'home');
    if (!locked) return;
    // Choose a tool asking for a shared PDF's password: leaving takes the question with it.
    await receiveOn(page, [{ name: 'Locked.pdf', type: 'application/pdf', bytes: locked }]);
    await onScreen(page, 'choose');
    await page.waitForSelector('dialog[open] input[type="password"]');
    await go(page, '/');
    await onScreen(page, 'home');
    await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
    // Back while it is asked: the question closes (as Android's Back), Choose a tool goes too
    // (with no PDF left to choose a tool for).
    await receiveOn(page, [{ name: 'Locked.pdf', type: 'application/pdf', bytes: locked }]);
    await onScreen(page, 'choose');
    await page.waitForSelector('dialog[open] input[type="password"]');
    await page.goBack();
    await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 });
    await onScreen(page, 'home');
  }, { browser: BROWSER });
});

await test('long work: yieldToUI lets timers run and the page paint; announcements wait for a modal dialog to close', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url);
    const r = await page.evaluate(async () => {
      const { yieldToUI } = await import('./js/core/dom.js');
      let frames = 0;
      let worstFrame = 0;
      let lastF = performance.now();
      let run = true;
      const f = () => { frames++; const now = performance.now(); worstFrame = Math.max(worstFrame, now - lastF); lastF = now; if (run) requestAnimationFrame(f); };
      requestAnimationFrame(f);
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 10);
      const t0 = performance.now();
      // 2 s of work in 30 ms slices, yielding between them, as an engine does between pages.
      while (performance.now() - t0 < 2000) {
        const s = performance.now();
        while (performance.now() - s < 30) Math.sqrt(Math.random());
        await yieldToUI();
      }
      run = false;
      clearInterval(timer);
      // Many quick yields cost little (no 4 ms clamp). Not measured in Playwright's WebKit on
      // Windows, whose run loop takes 15 ms for any task (yieldToUI races a timer there).
      const t1 = performance.now();
      for (let i = 0; i < 500; i++) await yieldToUI();
      const fastLoop = typeof globalThis.scheduler !== 'undefined';
      return { frames, worstFrame, ticks, quick: performance.now() - t1, fastLoop };
    });
    assert(r.frames >= 15 && r.ticks >= 10, 'frames and timers keep coming: ' + JSON.stringify(r));
    assert(!r.fastLoop || r.quick < 1500, '500 quick yields: ' + JSON.stringify(r));
    // A snackbar said while a progress dialog is open is announced once it has gone.
    const said = await page.evaluate(async () => {
      const ui = await import('./js/core/ui.js');
      const region = () => document.getElementById('announcer');
      const dialog = ui.progressDialog({ title: 'Working', delay: 0 });
      const log = [];
      const watch = new MutationObserver(() => {
        if (region()?.textContent) log.push({ text: region().textContent, modal: !!document.querySelector('dialog[open]') });
      });
      ui.snackbar('Something went wrong');
      await new Promise((r) => setTimeout(r, 0));
      if (region()) watch.observe(region(), { childList: true, characterData: true, subtree: true });
      await dialog.close();
      await new Promise((r) => setTimeout(r, 600));
      watch.disconnect();
      return log;
    });
    assert(said.length && said.every((s) => !s.modal) && said.at(-1).text === 'Something went wrong', 'announced after the dialog: ' + JSON.stringify(said));
  }, { browser: BROWSER });
});

await test('Contrast themes and the keyboard: shell parts keep their outlines; Tab doesn\'t hide controls under the bars', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url);
    await page.emulateMedia({ forcedColors: 'active' });
    const borders = await page.evaluate(() => ['.scan-card', '.home-search'].map((s) => getComputedStyle(document.querySelector(s)).borderTopWidth));
    eq(borders.every((w) => parseFloat(w) >= 1), true, 'scan card and search bar outlined: ' + borders);
    await page.emulateMedia({ forcedColors: 'none' });
    const padding = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop));
    assert(padding >= 64, 'scrolled clear of the top bar: ' + padding);
  }, { browser: BROWSER });
});

await test('pdf.js: one worker for every PDF, and nothing kept by a PDF that failed to open', async () => {
  const pdf1 = Array.from(await makePdf(1));
  await withPage(async (page, url) => {
    await openApp(page, url);
    const pdfWorkers = () => page.workers().filter((w) => w.url().includes('pdf.worker')).length;
    const pages = await page.evaluate(async (bytes) => {
      const { openPdfJs } = await import('./js/lib/pdfjs.js');
      window.__docs = [];
      for (let i = 0; i < 10; i++) window.__docs.push(await openPdfJs(new Uint8Array(bytes)));
      return window.__docs.map((d) => d.numPages);
    }, pdf1);
    eq(pdfWorkers(), 1, 'ten PDFs open, one pdf.js worker');
    const result = await page.evaluate(async (bytes) => {
      const { openPdfJs } = await import('./js/lib/pdfjs.js');
      const pdf = new Uint8Array(bytes);
      for (const d of window.__docs) await d.loadingTask.destroy();
      const failed = [];
      for (let i = 0; i < 3; i++) {
        try {
          await openPdfJs(new TextEncoder().encode('not a PDF at all ' + i));
          failed.push('opened');
        } catch (e) {
          failed.push(e.name);
        }
      }
      // Still works after failures.
      const again = await openPdfJs(pdf);
      const n = again.numPages;
      await again.loadingTask.destroy();
      return { failed, n };
    }, pdf1);
    eq(pages, Array(10).fill(1), 'ten PDFs opened');
    eq(result.failed.every((n) => n === 'InvalidPDFException'), true, 'failures: ' + result.failed);
    eq(result.n, 1, 'opens again after failures');
    await page.waitForTimeout(300);
    const workers = page.workers().filter((w) => w.url().includes('pdf.worker'));
    assert(workers.length <= 1, `one pdf.js worker for all of them, none left by the failures (${workers.length})`);
  }, { browser: BROWSER });
});

await test('no horizontal scrolling at 320 px on any shell screen, light and dark', async () => {
  await withPage(async (page, url) => {
    await openApp(page, url);
    await addRecent(page, 'A very long file name that goes on and on without any spaces_at_all_1234567890.pdf', 5);
    for (const [hash, route] of [['#/', 'home'], ['#/recent', 'recent'], ['#/settings', 'settings'], ['#/settings/about', 'about'], ['#/settings/about/licenses', 'licenses']]) {
      await page.goto(url + 'app/' + hash);
      await onScreen(page, route);
      await page.waitForTimeout(150);
      const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      assert(sw <= iw, `${route}: scrollWidth ${sw} > ${iw}`);
      if (!quick) {
        for (const scheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: scheme });
          await saveOutput(`shell-${route}-320-${scheme}.png`, await page.screenshot({ fullPage: true }));
        }
        await page.emulateMedia({ colorScheme: 'light' });
      }
    }
    await page.goto(url + 'app/');
    await onScreen(page, 'home');
    await page.fill('#home-search', 'pdf');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'search results');
  }, { viewport: { width: 320, height: 640 }, browser: BROWSER });
});

if (!quick) {
  await test('screenshots of the other screens at phone and desktop sizes', async () => {
    for (const [label, viewport] of [['phone', PHONE], ['desktop', DESKTOP]]) {
      await withPage(async (page, url) => {
        await openApp(page, url);
        for (let i = 0; i < 4; i++) await addRecent(page, i === 3 ? 'Usugami_PDFs.zip' : `Scan_2026110${i}.pdf`, 1000 * (i + 1) ** 3, i === 3 ? 'application/zip' : 'application/pdf');
        for (const scheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: scheme });
          for (const [hash, route] of [['#/', 'home'], ['#/recent', 'recent'], ['#/settings', 'settings'], ['#/settings/about', 'about'], ['#/settings/about/licenses', 'licenses']]) {
            await page.goto(url + 'app/' + hash);
            await onScreen(page, route);
            await page.waitForTimeout(400);
            await saveOutput(`shell-${route}-${label}-${scheme}.png`, await page.screenshot({ fullPage: label === 'phone' }));
          }
          await page.goto(url + 'app/#/');
          await onScreen(page, 'home');
          await page.fill('#home-search', 'pages');
          await page.waitForTimeout(400);
          await saveOutput(`shell-search-${label}-${scheme}.png`, await page.screenshot());
        }
      }, { viewport });
    }
  });
}

if (failures) {
  console.log(`\n${failures} shell test(s) failed.`);
  process.exit(1);
}
console.log('\nAll shell tests passed.');
