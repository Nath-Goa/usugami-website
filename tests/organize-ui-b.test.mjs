// Merge PDF and Reorganize PDF screens (site/app/js/tools/merge/, site/app/js/tools/reorganize/),
// driven in the real app at phone size (touch) and desktop size (mouse and keyboard): files picked,
// put in order and sorted, page mode's turns, removals and moves; Reorganize's pages selected by
// taps, by typing and with Select all, its field and its bar, several pages turned and removed at
// once, pages added from another PDF and blank, drags, Undo and Reset, passwords and damaged files,
// where the grid scrolls to and where the focus goes, then the PDFs made, saved and read back (page
// order, text, turns and sizes). Ports the page-list and Reorganize cases of the app's
// PageToolsDeviceTest, ScreensDeviceTest and EditorsMultiClickDeviceTest (two pages tapped
// together, quick turns, a blank page asked for while adding is busy), and its PageChoiceTest and
// PdfPageSelectionTest (read and problem).
// What Rotate PDF's and Delete pages' screens were tested for is tested here on Reorganize PDF,
// which took over from them. Screenshots (light and dark, both sizes) go to .tmp/organize-ui-b/screens/.
//
//   node tests/organize-ui-b.test.mjs          Chromium at both sizes, then Firefox and WebKit
//   node tests/organize-ui-b.test.mjs --quick  Chromium only
//   node tests/organize-ui-b.test.mjs --review Chromium only, the reviewers' findings only
import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { withPage, root, chooserFromKeyboard } from './harness.mjs';
import { parseStringsXml } from '../tools/import-strings.mjs';
import { PDFDocument, StandardFonts, rgb, degrees } from '../site/app/vendor/pdf-lib/pdf-lib.esm.min.js';
import {
  PageList, pageKey, pagesOf, samePages, BLANK, MAX_UNDO, enginePages, turnedKey,
} from '../site/app/js/tools/merge/page-list.js';
import { formatPages } from '../site/app/js/engine/page-selection.js';
import {
  readPages, pagesProblem, places, following, fieldText, pack, unpack,
} from '../site/app/js/engine/page-choice.js';

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
/** `json` with everything but plain ASCII written as \uXXXX, so a no-break space shows in a message. */
const ascii = (json) => json.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, message, `expected ${ascii(e ?? 'undefined')}\n  got      ${ascii(a ?? 'undefined')}`);
}
const exists = (p) => access(p).then(() => true, () => false);
const squash = (s) => s.replace(/\s+/g, '');

/** Everything the file holds as text: its bytes, and every stream inflated (as tests/organize.test.mjs). */
function everythingIn(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const parts = [raw];
  const re = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const data = Buffer.from(bytes.subarray(start, end));
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        parts.push(inflate(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1'));
        break;
      } catch { /* not deflated */ }
    }
    re.lastIndex = end + 'endstream'.length;
  }
  return parts.join('\n');
}

/** Whether `text` is in the file in any form a PDF stores it: as it is, or in hex, also UTF-16. */
function holds(everything, text) {
  const hex = Buffer.from(text, 'latin1').toString('hex');
  const utf16 = Buffer.from(text, 'utf16le').swap16().toString('hex');
  const lower = everything.toLowerCase();
  return everything.includes(text) || lower.includes(hex) || lower.includes(utf16);
}

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
  // Twelve pages, the third lying on its side, as the PDF Rotate PDF and Delete pages were tested with.
  report: pdf('Report.pdf', await makePdf(Array.from({ length: 12 }, (_, i) => ({ text: `PAGE ${i + 1}`, size: i === 2 ? LANDSCAPE : A4 })))),
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
  // The app's strings as the app shows them, read as the importer reads them: <plurals> as
  // { one, other }, \' and \uXXXX unescaped, %1$d as {1}.
  const app = xml == null ? new Map() : parseStringsXml(xml).strings;
  // A plural's forms in one order, whichever way a file lists them.
  const forms = (text) => (typeof text === 'string' ? text : Object.fromEntries(Object.entries(text ?? {}).sort(([a], [b]) => a.localeCompare(b))));
  const common = (await import('../site/app/locales/en/common.js')).default;
  const kit = (await import('../site/app/locales/en/kit.js')).default;
  const own = {};
  for (const ns of ['merge', 'reorganize']) {
    const strings = (await import(`../site/app/locales/en/${ns}.js`)).default;
    own[ns] = strings;
    for (const [key, text] of Object.entries(strings)) {
      check(!(key in common) && !(key in kit), `${ns}.js doesn't redefine ${key} of common.js or kit.js`);
      if (key.startsWith('web_') || xml == null) continue;
      check(app.has(key), `${ns}.js: ${key} is a strings.xml key`);
      equal(forms(text), forms(app.get(key)), `${ns}.js: ${key} is the app's English`);
    }
  }
  // The two kinds of string the comparison above must read rightly, whether or not the app is beside.
  equal(own.reorganize.remove_selected_pages, { one: 'Remove {1} page', other: 'Remove {1} pages' }, 'the plural for the pages selected');
  equal(own.merge.merge_page_line, '{1}. {2}, page\u00a0{3}', 'a no-break space keeps "page" and its number together');
  if (xml != null) {
    equal(forms(app.get('remove_selected_pages')), { one: 'Remove {1} page', other: 'Remove {1} pages' }, 'strings.xml\'s plurals are read as plurals');
    check(app.get('merge_page_line').includes('\u00a0') && !app.get('merge_page_line').includes('\\u'), 'strings.xml\'s \\uXXXX escapes are decoded');
  }
  // The strings of the one page chosen at a time are gone, with the app's.
  for (const key of ['reorganize_hint', 'reorganize_choose_page']) check(!(key in own.reorganize) && !app.has(key), `${key} is no more`);
  // Every string Reorganize PDF's new screen shows is somewhere, once.
  const everywhere = { ...common, ...kit, ...own.reorganize };
  for (const key of ['reorganize_pages_hint', 'reorganize_select_all', 'reorganize_select_none', 'reorganize_pages_field',
    'reorganize_pages_clear', 'reorganize_tap_pages', 'reorganize_selected_count', 'reorganize_move_hint', 'rotate_selected_left',
    'rotate_selected_right', 'remove_selected_pages', 'pdf_need_page', 'pdf_pages_format', 'pdf_pages_range', 'pdf_pages_reversed']) {
    check(key in everywhere, `${key} is defined`);
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

  // Several pages turned together are one change (rotateKeys, the app's rotateChosen).
  const turns = () => list.pages.map((p) => p.rotation);
  list = new PageList(pagesOf([alpha, beta]));
  check(list.rotateKeys(new Set(['a:0', 'b:1']), 90), 'two pages turned');
  equal(turns(), [90, 0, 0, 0, 90], 'only the pages named turn');
  check(list.rotateKeys(new Set(['a:0', 'a:1']), -180), 'turned again, one of them');
  equal(turns(), [270, 180, 0, 0, 90], 'turns add up and wrap round');
  list.undo();
  equal(turns(), [90, 0, 0, 0, 90], 'one Undo takes back one turn of them all');
  list.undo();
  check(samePages(list.pages, pagesOf([alpha, beta])) && !list.canUndo, 'and the one before: two changes in all');
  check(!list.rotateKeys(new Set(), 90) && !list.rotateKeys(new Set(['x:0']), 90) && !list.canUndo, 'no page named, or none of them here: nothing turns, nothing to undo');
  const kept = list.pages[2];
  list.rotateKeys(new Set(['a:0']), 90);
  check(list.pages[2] === kept, 'a page not turned is the same entry as before');

  // Several pages removed together are one change, and one page is always left (removeKeys, removeChosen).
  list = new PageList(pagesOf([alpha, beta]));
  check(list.removeKeys(new Set(['a:1', 'b:0'])), 'two pages removed');
  equal(list.pages.map(pageKey), ['a:0', 'a:2', 'b:1'], 'the others stay, in order');
  list.undo();
  check(samePages(list.pages, pagesOf([alpha, beta])) && !list.canUndo, 'one Undo brings both back');
  const all = new Set(list.pages.map(pageKey));
  const before = list.pages;
  check(list.removeKeys(all) === false, 'every page: refused');
  check(list.pages === before && !list.canUndo, 'refused, nothing changes and Undo gets no step');
  check(new PageList(a.slice(0, 1)).removeKeys(new Set(['a:0'])) === false, 'the only page: refused');
  check(list.removeKeys(new Set()) === true && list.removeKeys(new Set(['x:0'])) === true, 'no page named, or none of them here: nothing to do');
  check(list.pages === before && !list.canUndo, 'and nothing changed');
  // What Merge PDF uses is as it was beside the new methods.
  list.remove('a:0');
  list.rotate('a:1', 90);
  list.rotateAll(90);
  equal(list.pages.map((p) => `${pageKey(p)}@${p.rotation}`), ['a:1@180', 'a:2@90', 'b:0@90', 'b:1@90'], 'remove, rotate and rotateAll as before');

  // theSelectedPagesAreTurnedAndRemovedTogetherAndOneIsKept (PageToolsDeviceTest.kt): the app's
  // view model, here the page list with the selection following it as the screen makes it.
  const [p1, p2, p3] = a.map(pageKey);
  const order = () => list.pages.map(pageKey);
  list = new PageList(a);
  let selected = new Set([p1, p2, p3]);
  list.rotateKeys(selected, -90);
  equal(turns(), [270, 270, 270], 'every selected page turns');
  list.undo();
  equal(turns(), [0, 0, 0], 'one Undo turns them all back');
  check(list.removeKeys(selected) === false && samePages(list.pages, a), 'a PDF keeps at least one page: nothing is removed');
  // (Two pages tapped back to back both being selected is the screen's: reorganizeTapsTogether.)
  selected = new Set([p2, p3]);
  check(list.removeKeys(selected) === true, 'removed');
  equal(order(), [p1], 'the page not selected is left');
  selected = following(order(), selected);
  equal([...selected], [], 'the pages removed leave the selection');
  list.undo();
  equal(order(), [p1, p2, p3], 'Undo brings them back');
  equal([...following(order(), selected)], [], 'and doesn\'t select them again');
  selected = new Set([p3]);
  list.moveBy(p3, -1);
  equal(order(), [p1, p3, p2], 'moved earlier');
  check(following(order(), selected) === selected, 'the page moved stays selected');
  equal(places(order(), selected), [1], 'in its new place');
  // The app keeps the selection across a restart as places: packed and read back for the same pages.
  equal([...unpack(pack(order(), selected), order())], [p3], 'the selection kept as "2" comes back');
}

// ---------------------------------------------------------------------------------------------
// The selected pages and the field's text (engine/page-choice.js), without a browser.

function pageChoiceTests() {
  group = 'page choice';
  const sameSet = (set, list, message) => equal([...set].sort(), [...list].sort(), message);

  // PageChoiceTest.kt: placesFollowThePagesWhereverTheyGo
  equal(places(['a', 'b', 'c', 'd'], new Set(['d', 'b'])), [1, 3], 'the places of the pages selected, going up');
  // Page b goes and d moves to the front: d stays selected, now first.
  const moved = ['d', 'a', 'c'];
  const left = following(moved, new Set(['d', 'b']));
  sameSet(left, ['d'], 'a page that has gone leaves the selection');
  equal(places(moved, left), [0], 'the page that moved is found in its new place');
  // A selection whose pages are all still there is given back as it is.
  const chosen = new Set(['a', 'c']);
  check(following(moved, chosen) === chosen, 'all still there: the same selection');
  const none = new Set();
  check(following(moved, none) === none, 'nothing selected: the same selection');
  equal(places(moved, none), [], 'nothing selected: no places');

  // PageChoiceTest.kt: theFieldKeepsWhatWasTypedWhileItNamesTheSamePages
  equal(fieldText('5,1', [0, 4], 6), '5,1', 'what was typed stays while it names the pages selected');
  equal(fieldText('5,1', [0, 2, 4], 6), '1,3,5', 'otherwise the selection, as ranges');
  // Still being typed, or naming a page the PDF hasn't: kept while nothing is selected.
  equal(fieldText('2,5-', [], 6), '2,5-', 'half typed: kept');
  equal(fieldText('9', [], 6), '9', 'a page the PDF hasn\'t: kept');
  // A page tapped then says what is selected.
  equal(fieldText('9', [1], 6), '2', 'a page tapped then says what is selected');
  equal(fieldText('', [1, 4, 5, 6], 8), '2,5-7', 'nothing typed: the selection');
  equal(fieldText('', [], 6), '', 'nothing typed, nothing selected');

  // PageChoiceTest.kt: theSelectionIsPackedAsRangesAndComesBack
  const order = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const some = new Set(['p0', 'p2', 'p3', 'p4', 'p8', 'p11']);
  const packed = pack(order, some);
  equal(packed, '1,3-5,9,12', 'packed as ranges');
  sameSet(unpack(packed, order), [...some], 'and read back');
  // Every page of a long PDF takes a few bytes.
  const long = Array.from({ length: 5000 }, (_, i) => `p${i}`);
  equal(pack(long, new Set(long)), '1-5000', 'every page of a long PDF');
  const back = unpack('1-5000', long);
  check(back.size === 5000 && long.every((key) => back.has(key)), 'and back, the same pages');
  // Kept for pages that are no longer there, or not readable: nothing is selected.
  equal([...unpack('9', ['a', 'b', 'c'])], [], 'a page that isn\'t there');
  equal([...unpack('x', ['a', 'b', 'c'])], [], 'not readable');
  equal([...unpack('1', [])], [], 'no pages');
  equal([...unpack('', ['a', 'b', 'c'])], [], 'nothing kept');

  // PdfPageSelectionTest.kt: typedPagesAreReadOrSayWhyNot
  // Reorganize PDF's field: blank selects nothing, and while it can't be read nothing changes.
  const FORMAT = { key: 'pdf_pages_format', args: [] };
  const REVERSED = { key: 'pdf_pages_reversed', args: [] };
  const outOfRange = (count) => ({ key: 'pdf_pages_range', args: [count] });
  equal(readPages('', 6), [], 'blank: no pages');
  equal(readPages('2,5-6', 6), [1, 4, 5], 'pages typed');
  equal(readPages('2,', 6), null, 'half typed: can\'t be read');
  equal(readPages('1', 0), null, 'a PDF without pages');
  equal(pagesProblem('', 6), null, 'blank: nothing wrong');
  equal(pagesProblem('2,5-6', 6), null, 'readable: nothing wrong');
  equal(pagesProblem('2,', 6), FORMAT, 'half typed: the format');
  equal(pagesProblem('7', 6), outOfRange(6), 'a page the PDF hasn\'t, and how many it has');
  equal(pagesProblem('5-2', 6), REVERSED, 'a range backwards');
  equal(pagesProblem('1', 0), null, 'a PDF without pages: nothing said');

  // PdfPageSelectionTest.kt: selectedPagesKeepOrderAndDiscardDuplicates, badInputIsRejected and
  // badInputSaysWhy, as far as they are about a list of pages, through read and problem.
  equal(readPages('5,1,3-4,3', 6), [4, 0, 2, 3], 'the order typed, each page once');
  for (const input of ['0', '2-1', '7', '1,,2', 'one']) equal(readPages(input, 6), null, `"${input}" can't be read`);
  equal(pagesProblem('one', 6), FORMAT, 'letters');
  equal(pagesProblem('7', 6), outOfRange(6), 'above the count');
  equal(pagesProblem('2-1', 6), REVERSED, '2-1');
  equal(pagesProblem('5-2', 6), REVERSED, '5-2');
  // A range running backwards from a page that doesn't exist is out of range, as it says.
  equal(pagesProblem('8-3', 6), outOfRange(6), 'backwards from a page that doesn\'t exist');
  equal(pagesProblem('99999999999', 6), outOfRange(6), 'a number too long');
  // PdfPageSelectionTest.kt: pagesAreWrittenAsRanges, what it writes reads back as the same pages.
  const pages = [0, 2, 3, 4, 8, 9, 11];
  equal(readPages(formatPages(pages), 12), pages, 'what is written reads back');

  // The grammar, case by case (PdfPageSelection.range and read).
  // Blank as Kotlin's isBlank: spaces of any kind, and nothing else.
  for (const blank of [' ', '\t\n', '\u00a0', '\u2003 \u3000', '\u001c']) {
    equal(readPages(blank, 6), [], `blank (${ascii(JSON.stringify(blank))}): no pages`);
    equal(pagesProblem(blank, 6), null, 'and nothing wrong');
  }
  equal(readPages('\ufeff', 6), null, 'a byte order mark isn\'t blank');
  // Spaces are allowed round the numbers and the dash; a no-break space isn't one of them.
  equal(readPages(' 1 , 3 - 4 ', 6), [0, 2, 3], 'spaces round numbers and dashes');
  equal(pagesProblem('1\u00a0,2', 6), FORMAT, 'a no-break space among the numbers');
  // An empty part, and anything that isn't a number or a range.
  for (const input of ['1,,2', '2,', ',', ',2', '1;2', '1-2-3', '-3', '3-', '1 2', '+1', '1.5', '\u0663']) equal(pagesProblem(input, 6), FORMAT, `"${input}": the format`);
  // Out of range: 0, above the count, a range that leaves it, a number too long for an Int.
  for (const input of ['0', '7', '5-0', '0-5', '5-7', '2147483648', '1-99999999999']) equal(pagesProblem(input, 6), outOfRange(6), `"${input}": out of range`);
  equal(readPages('2147483647', 6), null, 'the largest Int is only out of range');
  // Backwards only when the range starts on a page of the PDF and ends on a number from 1 up.
  equal(pagesProblem('6-1', 6), REVERSED, 'from the last page back');
  equal(pagesProblem('7-1', 6), outOfRange(6), 'from beyond the last page');
  // One page as a range, zeros in front, pages named twice.
  equal(readPages('3-3', 6), [2], 'a range of one page');
  equal(readPages('003,0005-06', 6), [2, 4, 5], 'zeros in front');
  equal(readPages('2,2,1-2', 6), [1, 0], 'pages named twice count once');
  // The first part that is wrong, from the left, decides what is said.
  equal(pagesProblem('9,x', 6), outOfRange(6), 'out of range first');
  equal(pagesProblem('x,9', 6), FORMAT, 'the format first');
  equal(pagesProblem('5-2,9,x', 6), REVERSED, 'backwards first');
  equal(pagesProblem('1,2,6-5', 6), REVERSED, 'the parts before it fine');
  // The count is the list's as it is now: the same text reads differently for another.
  equal([readPages('7', 6), readPages('7', 7)], [null, [6]], 'a page added makes "7" readable');
  equal(pagesProblem('7', 7), null, 'and nothing is wrong then');
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
  equal(await pageLines(page), ['1. gamma.pdf, page\u00a01', '2. Beta.pdf, page\u00a01', '3. Beta.pdf, page\u00a02', '4. alpha.pdf, page\u00a01', '5. alpha.pdf, page\u00a02', '6. alpha.pdf, page\u00a03'], 'every page, in the files\' order');
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
  equal(await pageLines(page), ['1. gamma.pdf, page\u00a01', '2. Beta.pdf, page\u00a01', '3. Beta.pdf, page\u00a02', '4. alpha.pdf, page\u00a02', '5. alpha.pdf, page\u00a03'], 'page 4 removed');
  equal(await label(page), 'Remove page 4', 'the focus goes to the page in its place');

  // Keyboard: the row focused moves with Ctrl and the arrow keys; arrows alone move the focus.
  await page.focus('.merge-pages .merge-page-row:nth-of-type(5)');
  await page.keyboard.press('Control+ArrowUp');
  if (wide) {
    // Two columns: up is a row up; right and left are one place.
    equal((await pageLines(page))[2], '3. alpha.pdf, page\u00a03', 'Ctrl+Up: a row up');
    await page.keyboard.press('Control+ArrowRight');
    equal((await pageLines(page))[3], '4. alpha.pdf, page\u00a03', 'Ctrl+Right: one place later');
    await page.keyboard.press('Control+ArrowLeft');
  } else {
    await page.keyboard.press('Control+ArrowUp');
  }
  equal((await pageLines(page))[2], '3. alpha.pdf, page\u00a03', 'moved to place 3');
  await page.keyboard.press(wide ? 'ArrowLeft' : 'ArrowUp');
  equal(await page.evaluate(() => document.activeElement.querySelector('.merge-page-text')?.textContent), '2. Beta.pdf, page\u00a01', 'arrow keys move the focus');
  // Its own move buttons show on focus, and name its place.
  await page.keyboard.press('Tab');
  equal(await label(page), 'Move page 2 earlier', 'the move buttons come next');
  await page.keyboard.press('Enter');
  equal((await pageLines(page))[0], '1. Beta.pdf, page\u00a01', 'moved by its button');
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
const PAGES_FIELD = '.reorganize-pages-field .ui-field-input';
const NAME_FIELD = '.reorganize-name .ui-field-input';
/** The line under the Selected pages field (not the room kept for it, which is never seen). */
const SUPPORT = '.reorganize-pages-field > .ui-field-support:not(.reorganize-room)';
const HINT = 'For example: 2,5-7. Or tap the pages below.';
const SELECT_ALL = '.reorganize-head .ui-btn';
/** What the Selected pages field holds. */
const fieldReads = (page) => page.inputValue(PAGES_FIELD);
/** What is under the field: its hint, or what is wrong in its place. */
const support = (page) => page.textContent(SUPPORT);
const barSays = (page) => page.textContent('.reorganize-bar-label');
/** The bar's buttons that show, by the names a screen reader reads. */
const barButtons = (page) => page.$$eval('.reorganize-bar .ui-icon-btn', (n) => n.filter((b) => b.getClientRects().length).map((b) => b.getAttribute('aria-label')));
/** The numbers of the pages whose check box is checked. */
const checked = (page) => page.$$eval('.reorganize-grid .ui-page', (n) => n.flatMap((b, i) => (b.getAttribute('aria-checked') === 'true' ? [i + 1] : [])));
/** The keys of the pages selected, in the pages' order. */
const selected = async (page) => (await state(page)).chosen;
const turns = async (page) => (await state(page)).pages.map((p) => p.rotation);
const tileCount = (page, count) => waitFor(page, (n) => document.querySelectorAll('.reorganize-grid .ui-page-tile').length === n, count);
/** How far page `n`'s picture is shown turned, as the grid set it (the short way round: -180, not 180). */
const turnShown = (page, n) => page.$eval(`.reorganize-grid .ui-page-tile:nth-of-type(${n}) .ui-page-turn`, (e) => Number(/rotate\((-?\d+)deg\)/.exec(e.style.transform)?.[1] ?? 0));

/** Waits until neither the grid nor the window has scrolled for 600 ms: a glide is over, or none began. */
const atRest = (page) => page.$eval('.reorganize-grid', (grid) => new Promise((done) => {
  let last = [grid.scrollTop, window.scrollY];
  let still = 0;
  const look = () => {
    const now = [grid.scrollTop, window.scrollY];
    still = now[0] === last[0] && now[1] === last[1] ? still + 1 : 0;
    last = now;
    if (still >= 6) done();
    else setTimeout(look, 100);
  };
  setTimeout(look, 100);
}));
/**
 * Where page `n`'s tile is (with 0: the tile of the page that has the focus): the page's name, how
 * far the tile's top is under the grid's, and whether the whole of it can be seen, which is inside
 * the grid's own box and on the screen, clear of the bar at the top and of Save PDF at the foot.
 */
const tilePlace = (page, n) => page.evaluate((n) => {
  const grid = document.querySelector('.reorganize-grid');
  const el = n ? grid.querySelectorAll('.ui-page-tile')[n - 1] : document.activeElement.closest('.reorganize-grid .ui-page-tile');
  if (!el) return { name: document.activeElement.getAttribute('aria-label') ?? document.activeElement.tagName, seen: false };
  const box = el.getBoundingClientRect();
  const inner = grid.getBoundingClientRect();
  const head = document.querySelector('.merge-view > .ui-topbar').getBoundingClientRect().bottom;
  const foot = document.querySelector('.merge-view > .ui-bottombar').getBoundingClientRect().top;
  return {
    name: el.querySelector('.ui-page').getAttribute('aria-label'),
    underGridTop: Math.round(el.offsetTop - grid.scrollTop),
    gridHeight: grid.clientHeight,
    seen: box.top >= Math.max(head, inner.top - 1) && box.bottom <= Math.min(foot, inner.bottom + 1),
    tile: [Math.round(box.top), Math.round(box.bottom)],
    grid: [Math.round(inner.top), Math.round(inner.bottom)],
    screen: [Math.round(head), Math.round(foot)],
  };
}, n);

/** Opens Reorganize PDF with `file`, which has `count` pages. */
async function openReorganize(page, url, file, count) {
  await openTool(page, url, 'reorganize');
  await pick(page, '.reorganize-page .ui-empty', [file]);
  await tileCount(page, count);
}

/** Makes the PDF, saves it and reads it back: { name, bytes, shown } (the result screen stays). */
async function saveAndRead(page, url) {
  await page.click('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  const out = await download(page);
  return { ...out, shown: await readBack(page, url, out.bytes) };
}

/**
 * The app's reorganizeSelectsPagesByTappingAndTypingThenTurnsAndRemovesThem (ScreensDeviceTest.kt):
 * pages are selected by tapping them, by Select all and by typing their numbers, and the field,
 * the bar and the check boxes stay in step; the bar turns every page selected at once, refuses to
 * remove them all, and removes one; what is typed but can't be read is explained once a page is
 * tapped, and selects nothing.
 */
async function reorganizeSelects(page, url, { wide }) {
  group = `reorganize selects ${wide ? 'desktop' : 'phone'}`;
  const tap = (sel) => (wide ? page.click(sel) : page.tap(sel));
  await openReorganize(page, url, fx.alpha, 3);
  check(await page.isDisabled('.ui-bottombar button'), 'nothing to save until the pages change');
  equal(await barSays(page), 'Tap pages to select them', 'the bar, with nothing selected');
  equal(await page.getAttribute('.reorganize-bar-label', 'aria-live'), 'polite', 'a screen reader hears the bar change');
  equal(await barButtons(page), [], 'no buttons with nothing selected');

  // Each page is a check box named after it. A tap selects a page: the field, the bar and the
  // check box say so.
  equal(await page.getAttribute('.reorganize-grid', 'role'), 'list', 'the pages are a list');
  equal(await page.$$eval('.reorganize-grid .ui-page', (n) => n.map((b) => [b.getAttribute('role'), b.getAttribute('aria-checked'), b.getAttribute('aria-label')])),
    [['checkbox', 'false', 'Page 1'], ['checkbox', 'false', 'Page 2'], ['checkbox', 'false', 'Page 3']], 'each page a check box named after it, none checked');
  await tap(tile(2));
  equal(await fieldReads(page), '2', 'the field says the page tapped');
  equal(await barSays(page), 'Page 2', 'the bar, for page 2');
  equal(await checked(page), [2], 'page 2 shows as selected');
  // Its check mark fades in, in the picture's top corner at the end of the line.
  await waitFor(page, () => getComputedStyle(document.querySelectorAll('.reorganize-grid .reorganize-check')[1]).opacity === '1');
  const marks = await page.$$eval('.reorganize-grid .ui-page-tile', (n) => n.map((el) => {
    const mark = el.querySelector('.reorganize-check');
    const m = mark.getBoundingClientRect();
    const p = el.querySelector('.ui-page-picture').getBoundingClientRect();
    return { shown: getComputedStyle(mark).opacity === '1', corner: m.top - p.top < 12 && p.right - m.right < 12 && m.width >= 16, forTheEye: mark.getAttribute('aria-hidden') === 'true' };
  }));
  equal(marks.map((m) => m.shown), [false, true, false], 'a check mark on the page selected, on no other');
  check(marks[1].corner && marks.every((m) => m.forTheEye), 'in the top corner, for the eye only: the check box says its state', marks);

  // Select all selects every page, and becomes Select none.
  await tap(SELECT_ALL);
  equal(await fieldReads(page), '1-3', 'the field says every page');
  equal(await barSays(page), 'Selected: 3 of 3', 'the count');
  equal(await page.textContent(SELECT_ALL), 'Select none', 'Select all is now Select none');
  equal(await barButtons(page), ['Rotate the selected pages left', 'Rotate the selected pages right', 'Remove 3 pages'], 'the bar\'s buttons for several pages');

  // The bar turns every page selected at once.
  await tap('[aria-label="Rotate the selected pages left"]');
  equal(await turns(page), [270, 270, 270], 'every page turns');

  // But it can't remove them all: a PDF keeps at least one page.
  await tap('[aria-label="Remove 3 pages"]');
  equal(await support(page), 'Keep at least one page.', 'the warning');
  equal((await state(page)).pages.length, 3, 'nothing is removed');
  equal(await page.getAttribute(PAGES_FIELD, 'aria-invalid'), 'true', 'the field itself is marked as wrong');
  check(await page.isEnabled('[aria-label="Remove 3 pages"]'), 'Remove stays on');

  // Pages that don't exist select nothing, and a page tapped then says why.
  await page.fill(PAGES_FIELD, '9');
  equal(await selected(page), [], 'nothing is selected');
  equal(await support(page), HINT, 'nothing is said while it is typed');
  await tap(tile(1));
  equal(await support(page), 'Pages must be between 1 and 3.', 'the reason');
  equal(await fieldReads(page), '9', 'the field still says 9');
  equal([await selected(page), await checked(page)], [[], []], 'the tap selected nothing');

  // A page typed is selected, and removed with the bar.
  await page.fill(PAGES_FIELD, '2');
  equal(await checked(page), [2], 'the page typed is selected');
  await tap('[aria-label="Remove page 2"]');
  equal((await state(page)).pages.map((p) => p.page), [0, 2], 'page 2 goes');
  equal(await fieldReads(page), '', 'the field is empty');
  equal(await selected(page), [], 'nothing is selected');
  equal(await barSays(page), 'Tap pages to select them', 'the bar says so');
  equal(await page.textContent('.reorganize-count'), '2 pages', 'the count, which a screen reader hears, says what is left');

  await tap('.ui-bottombar button');
  await page.waitForSelector('.ui-result', { timeout: 30000 });
  equal(await page.textContent('.ui-result-heading'), 'Your PDF is ready', 'the result');
  const out = await download(page);
  equal(out.name, 'alpha_reorganized.pdf', 'named after the PDF');
  const shown = await readBack(page, url, out.bytes);
  equal(shown.map((p) => p.rotate), [270, 270], 'the two pages left, turned');
  // Read from turned pages, the words may come out broken up: only the letters count.
  const text = squash(shown.map((p) => p.text).join(''));
  check(text.includes('ALPHAONE') && text.includes('ALPHATHREE'), 'pages one and three are there', text);
  check(!text.includes('ALPHATWO'), 'page two is not', text);
}

/**
 * The app's reorganizeMovesTurnsAddsAndRemovesPagesWithButtons (ScreensDeviceTest.kt). Two of its
 * steps have no counterpart in a browser. The app removes page 1 with the action each page offers
 * a screen reader, whatever is selected: here the page is selected and removed with the bar. And
 * the app then has Android make the screen again, to see the pages and the selection survive it.
 */
async function reorganizeButtons(page, url, { wide }) {
  group = `reorganize buttons ${wide ? 'desktop' : 'phone'}`;
  const tap = (sel) => (wide ? page.click(sel) : page.tap(sel));
  await openReorganize(page, url, fx.alpha, 3);
  check(await page.isDisabled('.ui-bottombar button'), 'nothing to save until the pages change');
  equal(await page.textContent('.reorganize-count'), '3 pages', 'the page count');
  const [a, b, c] = (await state(page)).pages.map(pageKey);

  // Page 3 is selected with a tap, then moved and turned with the buttons, which name it.
  await tap(tile(3));
  await tap('[aria-label="Move page 3 earlier"]');
  equal((await state(page)).pages.map(pageKey), [a, c, b], 'page 3 comes second');
  // The bar's buttons are named anew in place.
  await tap('[aria-label="Rotate page 2 right"]');
  equal(await turns(page), [0, 90, 0], 'page 3 turns, in its new place');
  check(await page.isEnabled('.ui-bottombar button'), 'now there is something to save');

  // A blank page goes in after the selected page; Undo takes it out again.
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 4);
  equal((await state(page)).pages.map((p) => p.input === 'blank'), [false, false, true, false], 'a blank page third');
  equal((await tiles(page))[2], 'Page 3, blank', 'the blank page, named for a screen reader');
  equal(await page.textContent('.reorganize-count'), '4 pages', 'the new page count');
  await tap('[aria-label="Undo"]');
  await tileCount(page, 3);
  check(!(await state(page)).pages.some((p) => p.input === 'blank'), 'the blank page goes');
  equal(await selected(page), [c], 'the page selected stays selected through it all');

  // Page 1 goes: selected in place of the page selected, and removed with the bar.
  await tap(tile(2));
  await tap(tile(1));
  await tap('[aria-label="Remove page 1"]');
  equal((await state(page)).pages.map((p) => p.page), [2, 1], 'page 1 goes');
  // The page turned is first now: selected, the bar's buttons name its new place.
  await tap(tile(1));
  check((await barButtons(page)).includes('Rotate page 1 right'), 'the selected page\'s buttons, for its new place', await barButtons(page));

  const { name, shown } = await saveAndRead(page, url);
  equal(name, 'alpha_reorganized.pdf', 'named after the PDF');
  equal(shown.map((p) => p.rotate), [90, 0], 'the turn is saved');
  const text = squash(shown.map((p) => p.text).join(''));
  check(text.includes('ALPHATHREE') && text.indexOf('ALPHATHREE') < text.indexOf('ALPHATWO'), 'page three before page two', text);
  check(!text.includes('ALPHAONE'), 'page one is gone', text);
}

/** The app's reorganizeTwoPagesTappedTogetherAreBothSelected (EditorsMultiClickDeviceTest.kt). */
async function reorganizeTapsTogether(page, url) {
  group = 'reorganize two pages tapped together';
  await openReorganize(page, url, fx.alpha, 3);
  // Both taps land before the screen is drawn again: each goes on from the one before.
  const tapTogether = (first, second) => page.evaluate(([first, second]) => {
    const boxes = document.querySelectorAll('.reorganize-grid .ui-page');
    boxes[first - 1].click();
    boxes[second - 1].click();
  }, [first, second]);
  await tapTogether(2, 3);
  equal(await fieldReads(page), '2-3', 'both pages are selected');
  equal(await barSays(page), 'Selected: 2 of 3', 'and counted');
  // Page 2 unselected, page 1 selected.
  await tapTogether(2, 1);
  equal(await fieldReads(page), '1,3', 'each tap goes on from the one before');
  equal(await checked(page), [1, 3], 'the check boxes too');
}

/**
 * The app's reorganizeQuickTurnsEachTurnThePageAndUndoTakesBackOne (EditorsMultiClickDeviceTest.kt),
 * on the bar's own buttons: each of two presses before the screen is drawn again counts.
 */
async function reorganizeQuickPresses(page, url) {
  group = 'reorganize quick presses on the bar';
  await openReorganize(page, url, fx.alpha, 3);
  await page.click(tile(1));
  /** Presses the bar's buttons with these names one after the other, with no time between. */
  const pressTogether = (...names) => page.evaluate((names) => {
    for (const name of names) document.querySelector(`.reorganize-bar [aria-label="${name}"]`).click();
  }, names);
  await pressTogether('Rotate page 1 right', 'Rotate page 1 right');
  equal((await turns(page))[0], 180, 'two quick presses turn the page twice');
  await page.click('[aria-label="Undo"]');
  equal((await turns(page))[0], 90, 'Undo takes back one of them');
  // Turned and then removed with no time between: the page goes.
  const first = pageKey((await state(page)).pages[0]);
  await pressTogether('Rotate page 1 right', 'Remove page 1');
  await tileCount(page, 2);
  const left = (await state(page)).pages.map(pageKey);
  check(left.length === 2 && !left.includes(first), 'turned and removed together: the page is gone', left);
}

/**
 * The app's reorganizeBlankPageAskedForWhileFilesAreBusyIsAddedOnceAndSaved
 * (EditorsMultiClickDeviceTest.kt): while a blank page's size is read, Add pages and Save PDF are
 * off, and asked for again it adds no second page. Then, with the list a page longer than the
 * PDF: typed numbers are read for the pages there are now.
 */
async function reorganizeAdding(page, url) {
  group = 'reorganize adding a blank page';
  const ADD = '.reorganize-actions button:has-text("Add pages")';
  const SAVE = '.merge-view > .ui-bottombar .ui-btn';
  await openReorganize(page, url, fx.alpha, 3);
  // A change first, so the PDF can be saved.
  await page.click(tile(1));
  await page.click('[aria-label="Rotate page 1 right"]');
  equal([await page.isEnabled(SAVE), await page.getAttribute(SAVE, 'aria-disabled')], [true, null], 'Save PDF is on');
  await page.click(ADD);
  await page.waitForSelector('.ui-menu');
  // Read right after the press, before the page's size has been read.
  const during = await page.evaluate((SAVE) => {
    // Add pages is the first button of its row.
    const add = document.querySelector('.reorganize-actions button');
    const blank = [...document.querySelectorAll('.ui-menu [role="menuitem"]')].find((b) => b.textContent.includes('Blank page'));
    // Tapped twice, as a double tap would.
    blank.click();
    blank.click();
    const seen = {
      add: add.textContent,
      addOff: add.getAttribute('aria-disabled'),
      saveOff: document.querySelector(SAVE).getAttribute('aria-disabled'),
      busyShown: !document.querySelector('.merge-busy').hidden,
      pages: document.querySelectorAll('.reorganize-grid .ui-page-tile').length,
    };
    // Asked for again meanwhile: Add pages opens no menu.
    add.click();
    seen.menuAgain = !!document.querySelector('.ui-menu');
    return seen;
  }, SAVE);
  equal(during, { add: 'Add pages', addOff: 'true', saveOff: 'true', busyShown: true, pages: 3, menuAgain: false },
    'while the page is added: Add pages and Save PDF are off, adding shows, and it can\'t be asked for again');
  await tileCount(page, 4);
  await waitFor(page, () => !document.querySelector('.reorganize-actions button').hasAttribute('aria-disabled'));
  equal((await state(page)).pages.map((p) => p.input === 'blank'), [false, true, false, false], 'the one blank page asked for, after the selected page');
  equal([await page.getAttribute(SAVE, 'aria-disabled'), await page.isHidden('.merge-busy')], [null, true], 'Save PDF is on again, adding is over');

  // The list is a page longer than the PDF now: "4" names a page, and "5" is what is out of range.
  await page.fill(PAGES_FIELD, '4');
  await page.keyboard.press('Enter');
  equal([await support(page), await page.getAttribute(PAGES_FIELD, 'aria-invalid'), await checked(page)], [HINT, null, [4]], 'page 4 is there to select once a page is added');
  await page.fill(PAGES_FIELD, '5');
  await page.keyboard.press('Enter');
  equal(await support(page), 'Pages must be between 1 and 4.', 'the message counts the pages there are now, the page added too');

  const { shown } = await saveAndRead(page, url);
  equal(shown.length, 4, 'the PDF saved has the blank page');
  equal(shown.map((p) => squash(p.text) === ''), [false, true, false, false], 'second, and empty');
  // And a page shorter again, after Undo takes the blank page out.
  await page.click('.ui-result .ui-topbar [aria-label="Back to editing"]');
  await page.waitForSelector('.merge-view:not([hidden])');
  await page.click('[aria-label="Undo"]');
  await tileCount(page, 3);
  await page.fill(PAGES_FIELD, '4');
  await page.keyboard.press('Enter');
  equal([await support(page), await checked(page)], ['Pages must be between 1 and 3.', []], 'a page fewer: the message follows');
}

async function reorganize(page, url, { wide }) {
  group = `reorganize ${wide ? 'desktop' : 'phone'}`;
  const tap = (sel) => (wide ? page.click(sel) : page.tap(sel));
  await openTool(page, url, 'reorganize');
  await shot(page, `reorganize-empty-${wide ? 'desktop' : 'phone'}`);
  await pick(page, '.reorganize-page .ui-empty', [fx.alpha]);
  await tileCount(page, 3);
  equal(await page.textContent('.reorganize-count'), '3 pages', 'the page count');
  equal(await barSays(page), 'Tap pages to select them', 'no page selected');
  check(await page.isDisabled('[aria-label="Undo"]'), 'nothing to undo');
  check(await page.isDisabled('.ui-bottombar button') && await page.isDisabled('button:has-text("Reset pages")'), 'nothing to save until the pages change');
  equal(await page.inputValue(NAME_FIELD), 'alpha_reorganized', 'the default name');
  check((await page.textContent('.reorganize-card .ui-file-detail')).startsWith('3 pages · '), 'the card says its pages and size');
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-turn canvas').length === 3);
  check(true, 'the pages are drawn');
  await shot(page, `reorganize-open-${wide ? 'desktop' : 'phone'}`);

  // The screen from top to bottom, in the app's order: the PDF's card; the page count with Select
  // all and Undo; the Selected pages field; the bar; the pages; their hint; Add pages and Reset
  // pages; the file name; Save PDF. On a wide screen the bar, the pages and their hint stand beside
  // the rest.
  const top = (selector) => page.$eval(selector, (e) => Math.round(e.getBoundingClientRect().top));
  const tops = async (...selectors) => Promise.all(selectors.map(top));
  const goingDown = (list) => list.every((y, i) => i === 0 || y > list[i - 1]);
  const beside = await tops('.reorganize-bar', '.reorganize-grid', '.reorganize-hint');
  const column = await tops('.reorganize-card', '.reorganize-head', '.reorganize-select');
  const below = await tops('.reorganize-actions', NAME_FIELD);
  check(goingDown(wide ? [...column, ...below] : [...column, ...beside, ...below]) && goingDown(beside), 'the parts in the app\'s order', { column, beside, below });
  equal(await page.textContent('.merge-view > .ui-bottombar .ui-btn'), 'Save PDF', 'Save PDF in the bar at the foot of the screen');
  equal(await page.$$eval('.reorganize-head > *', (n) => n.map((x) => x.getAttribute('aria-label') ?? x.textContent)), ['3 pages', 'Select all', 'Undo'], 'the count, Select all and Undo in one row');
  equal(await page.$$eval('.reorganize-actions > *', (n) => n.map((x) => x.textContent)), ['Add pages', 'Reset pages'], 'Add pages and Reset pages in one row');
  equal(await page.textContent('.reorganize-pages-field .ui-field-label'), 'Selected pages', 'the field\'s label');
  equal(await support(page), HINT, 'its hint');
  equal(await page.textContent('.reorganize-hint'), 'Long-press a page and drag to move it. Pages you add go after the last selected page.', 'the hint under the pages');
  check(await page.isHidden('.reorganize-clear'), 'no cross while the field is empty');
  const [a0, a1, a2] = ['p1:0', 'p1:1', 'p1:2'];

  // Pages 1 and 3 selected by taps: with several, the bar counts them, and can turn or remove them.
  await tap(tile(1));
  await tap(tile(3));
  equal(await checked(page), [1, 3], 'a second page tapped is selected too');
  equal(await barSays(page), 'Selected: 2 of 3', 'the bar counts them');
  equal(await barButtons(page), ['Rotate the selected pages left', 'Rotate the selected pages right', 'Remove 2 pages'], 'turn and remove, no move buttons');
  equal(await fieldReads(page), '1,3', 'the field lists them');
  check(await page.isVisible('.reorganize-clear'), 'the cross shows while the field holds text');
  // Tapped again, a page is let go; the one left has five buttons, which name it.
  await tap(tile(1));
  equal(await checked(page), [3], 'let go');
  equal(await barSays(page), 'Page 3', 'the bar names the page left');
  equal(await barButtons(page), ['Move page 3 earlier', 'Move page 3 later', 'Rotate page 3 left', 'Rotate page 3 right', 'Remove page 3'], 'five buttons for one page');
  check(await page.isDisabled('[aria-label="Move page 3 later"]') && await page.isEnabled('[aria-label="Move page 3 earlier"]'), 'the last page can\'t move later');
  await tap(tile(3));
  equal([await barSays(page), await fieldReads(page)], ['Tap pages to select them', ''], 'no page selected again');
  await tap(tile(3));
  await page.click('[aria-label="Move page 3 earlier"]');
  equal(await keys(page), [`${a0}@0`, `${a2}@0`, `${a1}@0`], 'page 3 comes second');
  equal(await barSays(page), 'Page 2', 'still selected, in its new place');
  equal(await fieldReads(page), '2', 'the field says its new place');
  await waitFor(page, () => document.getElementById('announcer')?.textContent === 'Moved to place 2 of 3');
  checks++;
  await page.click('[aria-label="Rotate page 2 right"]');
  equal(await keys(page), [`${a0}@0`, `${a2}@90`, `${a1}@0`], 'turned right');
  check(await page.isEnabled('.ui-bottombar button'), 'now there is something to save');
  equal((await tiles(page))[1], 'Page 2, Turned right', 'a screen reader hears it turned');
  await waitFor(page, () => /rotate\(90deg\)/.test(document.querySelectorAll('.reorganize-grid .ui-page-turn')[1].style.transform));
  checks++;

  // A blank page goes in after the selected page, sideways as that page is; Undo takes it out.
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 4);
  let s = await state(page);
  equal([s.pages[2].input, Math.round(s.pages[2].width), Math.round(s.pages[2].height)], ['blank', 842, 595], 'a blank page third, lying sideways');
  equal((await tiles(page))[2], 'Page 3, blank', 'named for a screen reader');
  equal(await page.textContent('.reorganize-count'), '4 pages', 'the new count');
  equal(s.chosen, [a2], 'the blank page is not selected, the page before it still is');
  await waitFor(page, () => {
    const c = document.querySelectorAll('.reorganize-grid .ui-page-turn')[2].querySelector('canvas');
    return c && c.width > c.height;
  });
  checks++;
  await page.click('[aria-label="Undo"]');
  await tileCount(page, 3);
  equal(await keys(page), [`${a0}@0`, `${a2}@90`, `${a1}@0`], 'Undo takes the blank page out');

  // Pages of another PDF go after the last selected page, and are not selected themselves.
  await tap(tile(1));
  equal(await selected(page), [a0, a2], 'two pages selected, the later one second');
  await page.click('.reorganize-actions button:has-text("Add pages")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.ui-menu-item:has-text("Pages from a PDF")')]);
  await chooser.setFiles([fx.beta]);
  await tileCount(page, 5);
  equal(await keys(page), [`${a0}@0`, `${a2}@90`, 'p2:0@0', 'p2:1@0', `${a1}@0`], 'Beta\'s pages after the last selected page');
  equal(await selected(page), [a0, a2], 'the same pages stay selected, the pages added are not');
  equal(await fieldReads(page), '1-2', 'the field, written as ranges for the longer list');
  equal((await tiles(page))[2], 'Page 3, from Beta.pdf', 'pages from another PDF say so');
  equal(await label(page), 'Add pages', 'the focus is back on Add pages');
  // Added again, pages go after the same page, before those added the time before.
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 6);
  equal((await state(page)).pages.map((p) => p.input), ['p1', 'p1', 'blank', 'p2', 'p2', 'p1'], 'a blank page after the same page, before Beta\'s');
  await page.click('[aria-label="Undo"]');
  await tileCount(page, 5);

  // Dragged: page 5 to the first place, one change for Undo. The selection goes with its pages.
  const before = await keys(page);
  const [from, to] = await centers(page, '.reorganize-grid .ui-page', [4, 0]);
  if (wide) await mouseDrag(page, from, to);
  else await touchDrag(page, from, to);
  equal(await keys(page), [`${a1}@0`, ...before.slice(0, 4)], 'page 5 dragged first');
  equal([await selected(page), await fieldReads(page)], [[a0, a2], '2-3'], 'the same pages are selected, the field says their new places');
  await page.click('[aria-label="Undo"]');
  equal(await keys(page), before, 'one Undo takes back the whole drag');
  equal(await fieldReads(page), '1-2', 'and the field follows');

  // Keyboard: arrows move the focus, Ctrl and an arrow moves the page.
  await page.focus(tile(1));
  await page.keyboard.press('ArrowRight');
  equal(await label(page), 'Page 2, Turned right', 'arrows move the focus');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+ArrowLeft');
  equal(await keys(page), [before[0], before[2], before[1], before[3], before[4]], 'Ctrl+Left moves it earlier');
  await page.click('[aria-label="Undo"]');
  equal(await keys(page), before, 'a keyboard move is one change too');

  // Several pages removed at once, as one change: Beta's first page and page 5.
  await tap(tile(1));
  await tap(tile(2));
  await tap(tile(3));
  await tap(tile(5));
  equal(await fieldReads(page), '3,5', 'two pages picked');
  await page.click('[aria-label="Remove 2 pages"]');
  await tileCount(page, 3);
  equal(await keys(page), [before[0], before[1], before[3]], 'both removed');
  equal([await selected(page), await fieldReads(page), await barSays(page)], [[], '', 'Tap pages to select them'], 'nothing is selected after');
  await page.click('[aria-label="Undo"]');
  await tileCount(page, 5);
  equal(await keys(page), before, 'one Undo brings both back');
  equal(await selected(page), [], 'not selected again');

  // Page 5 removed with the bar: nothing is selected after, and the focus, which was on the
  // button that went, is on the page now in its place (here the last one).
  await tap(tile(5));
  await page.click('[aria-label="Remove page 5"]');
  equal(await keys(page), before.slice(0, 4), 'removed');
  equal(await barSays(page), 'Tap pages to select them', 'no page is selected in its place');
  equal(await label(page), 'Page 4, from Beta.pdf', 'the focus goes to the page now in its place');
  // A blank page with nothing selected: at the end, after Beta's landscape page, so landscape.
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 5);
  s = await state(page);
  equal([s.pages[4].input, Math.round(s.pages[4].width), Math.round(s.pages[4].height)], ['blank', 842, 595], 'at the end, the size of the page before it');
  // Asked for again, it follows a blank page, whose size it takes (no PDF page is read for it);
  // after a blank page turned a quarter it lies the other way, as that page now shows.
  const blankSizes = async () => (await state(page)).pages.slice(5).map((p) => [p.input, Math.round(p.width), Math.round(p.height), p.rotation]);
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 6);
  equal(await blankSizes(), [['blank', 842, 595, 0]], 'a blank page after a blank page: the same size');
  await tap(tile(6));
  await page.click('[aria-label="Rotate page 6 right"]');
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 7);
  equal(await blankSizes(), [['blank', 842, 595, 90], ['blank', 595, 842, 0]], 'after a blank page turned a quarter: the other way up, and not turned itself');
  // Taken back for the PDF saved below: the page, the turn, the page.
  for (const count of [6, 6, 5]) {
    await page.click('[aria-label="Undo"]');
    await tileCount(page, count);
  }
  equal([await keys(page), await selected(page)], [[...before.slice(0, 4), 'blank:0@0'], []], 'three Undos later: the five pages, none selected');
  await shot(page, `reorganize-edit-${wide ? 'desktop' : 'phone'}`);
  await noSideScroll(page);

  // Saved: the pages as listed, turned, sized and named as shown.
  const expected = (await state(page)).pages;
  const { name, shown } = await saveAndRead(page, url);
  equal(name, 'alpha_reorganized.pdf', 'named after the PDF');
  const names = { p1: 'alpha.pdf', p2: 'Beta.pdf' };
  equal(says(shown, expected.map((p) => (p.input === 'blank' ? '' : SAYS[names[p.input]][p.page]))), expected.map((p) => (p.input === 'blank' ? '' : SAYS[names[p.input]][p.page])), 'the pages in their new order, the blank page empty');
  equal(shown.map((p) => p.rotate), expected.map((p) => p.rotation), 'turned as shown');
  equal([shown[4].width, shown[4].height], [842, 595], 'the blank page\'s size');
  check(!shown.some((p) => squash(p.text) === 'ALPHATWO'), 'the page removed is gone');

  // Back to editing; Reset pages; one Undo brings the changes back. Neither changes what is
  // selected beyond letting go of the pages that are no longer there.
  await page.click('.ui-result .ui-topbar [aria-label="Back to editing"]');
  await page.waitForSelector('.merge-view:not([hidden])');
  const edited = await keys(page);
  await tap(tile(1));
  await tap(tile(3));
  equal(await selected(page), [a0, 'p2:0'], 'page 1 and one of Beta\'s selected');
  await page.click('button:has-text("Reset pages")');
  equal(await keys(page), [`${a0}@0`, `${a1}@0`, `${a2}@0`], 'Reset: the PDF\'s own pages');
  equal([await selected(page), await fieldReads(page)], [[a0], '1'], 'the page selected that is still there stays selected');
  check(await page.isDisabled('button:has-text("Reset pages")') && await page.isDisabled('.ui-bottombar button'), 'nothing more to reset or save');
  await page.click('[aria-label="Undo"]');
  equal(await keys(page), edited, 'one Undo brings the changes back');
  equal(await selected(page), [a0], 'the pages that come back are not selected again');

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
  equal([(await state(page)).chosen, await fieldReads(page)], [[], ''], 'with what was selected');
}

async function reorganizeMore(page, url) {
  group = 'reorganize desktop keys, turned pages and passwords';
  await openReorganize(page, url, fx.turned, 2);
  // A blank page after a page the PDF itself turns: the size that page shows.
  await page.click(tile(1));
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 3);
  const s = await state(page);
  equal([Math.round(s.pages[1].width), Math.round(s.pages[1].height)], [842, 595], 'shown sideways, so the blank page is too');
  await page.click(tile(1));

  // Keyboard on a computer: Space and Enter select a page or let it go; Ctrl+Z undoes.
  await page.focus(tile(3));
  await page.keyboard.press('Space');
  equal(await barSays(page), 'Page 3', 'Space selects');
  await page.keyboard.press('Enter');
  equal(await barSays(page), 'Tap pages to select them', 'Enter lets go');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  equal(await fieldReads(page), '2-3', 'pages selected from the keyboard');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  equal([await barSays(page), await label(page)], ['Page 3', 'Page 3'], 'page 3 selected alone, with the focus');
  await page.keyboard.press('Control+Home');
  equal((await state(page)).pages.map(pageKey), ['p1:1', 'p1:0', 'blank:0'], 'Ctrl+Home moves it first');
  equal(await barSays(page), 'Page 1', 'selected still, in its new place');
  await page.keyboard.press('Control+z');
  equal((await state(page)).pages.map(pageKey), ['p1:0', 'blank:0', 'p1:1'], 'Ctrl+Z takes it back');
  check(await page.evaluate(() => !!document.activeElement.closest('.reorganize-grid .ui-page-tile')), 'the grid drawn afresh keeps the focus');
  for (const field of [NAME_FIELD, PAGES_FIELD]) {
    await page.focus(field);
    await page.keyboard.press('Control+z');
    equal((await state(page)).pages.map(pageKey), ['p1:0', 'blank:0', 'p1:1'], 'Ctrl+Z in a text field is left to the field');
  }
  // A page from a PDF with a password, after it asks.
  await page.click(tile(3));
  await page.click(tile(1));
  equal(await selected(page), ['p1:0'], 'the first page selected alone');
  await page.click('.reorganize-actions button:has-text("Add pages")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.ui-menu-item:has-text("Pages from a PDF")')]);
  await chooser.setFiles([fx.locked]);
  await page.waitForSelector('dialog[open] .ui-password');
  await page.fill('dialog[open] input[type=password]', 'test123');
  await page.keyboard.press('Enter');
  await tileCount(page, 6);
  check((await state(page)).pages[1].input === 'p2' && (await state(page)).pages[3].input === 'p2', 'its pages after the selected page');
  // A PDF dropped on the pages adds its pages after the last selected page too, unselected.
  await page.click(tile(6));
  await dropFiles(page, '.reorganize-page .merge-content', [fx.gamma]);
  await tileCount(page, 7);
  equal(pageKey((await state(page)).pages[6]), 'p3:0', 'the PDF dropped: its page after the last selected one');
  equal([await selected(page), await fieldReads(page)], [['p1:0', 'p1:1'], '1,6'], 'the page dropped is not selected');
  // And so does a PDF pasted.
  await page.click(tile(6));
  await page.evaluate((b64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Pasted.pdf', { type: 'application/pdf' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, fx.gamma.buffer.toString('base64'));
  await tileCount(page, 8);
  equal((await state(page)).pages.map((p) => p.input), ['p1', 'p4', 'p2', 'p2', 'p2', 'blank', 'p1', 'p3'], 'a PDF pasted adds its page after the selected page');
  await page.click('[aria-label="Undo"]');
  await tileCount(page, 7);
  const expected = (await state(page)).pages;
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

/**
 * What Rotate PDF's screen was tested for, now Reorganize PDF's: pages turned one by one and
 * several at once, seen turning; every page with Select all; Reset pages; turned pages as work
 * to lose; the turns saved and read back.
 */
async function reorganizeTurns(page, url, { wide }) {
  const size = wide ? 'desktop' : 'phone';
  group = `reorganize turns ${size}`;
  const tap = (sel) => (wide ? page.click(sel) : page.tap(sel));
  await openReorganize(page, url, fx.report, 12);
  await page.waitForSelector('.reorganize-grid .ui-page-picture.has-picture canvas');
  await tap(tile(1));
  // The turn icons aren't mirrored for right-to-left text (TurnIcon).
  equal(await page.$$eval('.reorganize-bar [aria-label^="Rotate"] .icon-mirrored', (n) => n.length), 0, 'turn icons drawn the same either way');
  await page.click('[aria-label="Rotate page 1 right"]');
  equal(await turnShown(page, 1), 90, 'page 1 turned right');
  equal((await tiles(page))[0], 'Page 1, Turned right', 'says turned right');
  check(await page.isEnabled('.ui-bottombar button') && await page.isEnabled('button:has-text("Reset pages")'), 'Save PDF and Reset pages on');
  // Two quarters left: upside down, the short way round.
  await tap(tile(1));
  await tap(tile(2));
  await page.click('[aria-label="Rotate page 2 left"]');
  await page.click('[aria-label="Rotate page 2 left"]');
  equal(await turnShown(page, 2), -180, 'page 2 went left twice');
  equal((await tiles(page))[1], 'Page 2, Upside down', 'upside down');
  // Two pages at once, each from where it was; one Undo takes the turn of both back.
  await tap(tile(4));
  await page.click('[aria-label="Rotate the selected pages right"]');
  equal((await turns(page)).slice(0, 4), [90, 270, 0, 90], 'the pages selected turn together');
  equal(await turnShown(page, 2), -90, 'page 2 the short way');
  equal((await tiles(page)).slice(0, 4), ['Page 1, Turned right', 'Page 2, Turned left', 'Page 3', 'Page 4, Turned right'], 'each says its turn');
  equal(await fieldReads(page), '2,4', 'the pages turned stay selected');
  await page.click('[aria-label="Undo"]');
  equal((await turns(page)).slice(0, 4), [90, 180, 0, 0], 'one Undo takes back the turn of both');

  // Animated: the picture turns to its new place rather than jumping there. Pressed in the page,
  // and the turn read from its transition (a quarter of the way through its time, then at its
  // end), so the answer is the same however busy the machine is.
  await tap(tile(2));
  await tap(tile(4));
  await tap(tile(3));
  const turning = await page.evaluate(() => {
    const turn = document.querySelectorAll('.reorganize-grid .ui-page-turn')[2];
    const angle = () => {
      const x = new DOMMatrix(getComputedStyle(turn).transform);
      return Math.round(Math.atan2(x.b, x.a) * 180 / Math.PI);
    };
    const before = angle();
    document.querySelector('[aria-label="Rotate page 3 right"]').click();
    // Reading the style takes the new turn in, which starts its transition.
    angle();
    const moving = turn.getAnimations().find((a) => a.transitionProperty === 'transform');
    if (!moving) return { before, moving: false, after: angle() };
    const time = moving.effect.getComputedTiming().duration;
    moving.pause();
    moving.currentTime = time / 4;
    const onTheWay = angle();
    moving.finish();
    return { before, moving: true, time, onTheWay, after: angle() };
  });
  check(turning.moving && turning.time > 0 && turning.before === 0 && turning.onTheWay > 0 && turning.onTheWay < 90 && turning.after === 90, 'turning, not jumping', turning);
  await page.waitForTimeout(400);
  // On its side, a page is sized to fit its tile the other way: page 1 (upright paper, now lying
  // down) is made smaller and reaches from side to side, page 3 (wide paper, now standing) larger
  // and from top to bottom. Neither sticks out of its tile. Measured once no turn is under way.
  await waitFor(page, () => [0, 2].every((i) => {
    const turn = document.querySelectorAll('.reorganize-grid .ui-page-turn')[i];
    return turn.querySelector('canvas') && !turn.getAnimations().length;
  }));
  const fitted = await page.$$eval('.reorganize-grid .ui-page-tile', (all) => [0, 2].map((i) => {
    const box = all[i].querySelector('.ui-page-picture').getBoundingClientRect();
    const drawn = all[i].querySelector('.ui-page-turn canvas').getBoundingClientRect();
    return {
      inside: drawn.left >= box.left - 1 && drawn.right <= box.right + 1 && drawn.top >= box.top - 1 && drawn.bottom <= box.bottom + 1,
      lying: drawn.width > drawn.height,
      roomAcross: Math.round(box.width - drawn.width),
      roomUp: Math.round(box.height - drawn.height),
    };
  }));
  check(fitted[0].inside && fitted[0].lying && Math.abs(fitted[0].roomAcross) <= 1 && fitted[0].roomUp > 1, 'an upright page turned a quarter lies in its tile, from side to side', fitted[0]);
  check(fitted[1].inside && !fitted[1].lying && Math.abs(fitted[1].roomUp) <= 1 && fitted[1].roomAcross > 1, 'a wide page turned a quarter stands in its tile, from top to bottom', fitted[1]);
  await shot(page, `reorganize-turned-${size}`);

  // Every page at once: Select all, then turn.
  await tap(SELECT_ALL);
  await page.click('[aria-label="Rotate the selected pages right"]');
  equal(await turns(page), [180, 270, 180, 90, 90, 90, 90, 90, 90, 90, 90, 90], 'every page a quarter more');
  equal(await turnShown(page, 2), -90, 'page 2 the short way round again');
  await page.click('[aria-label="Rotate the selected pages left"]');
  equal(await turns(page), [90, 180, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'and back');
  // Reset pages turns them all back, and there is nothing to save again.
  await page.click('button:has-text("Reset pages")');
  await page.waitForTimeout(300);
  equal(await turns(page), new Array(12).fill(0), 'Reset turns every page back');
  check(await page.isDisabled('.ui-bottombar button'), 'nothing to save after Reset');
  equal((await tiles(page)).filter((name) => name.includes(',')), [], 'no page says it is turned');
  equal(await barSays(page), 'Selected: 12 of 12', 'Reset leaves the pages selected');

  // Turned pages are work: leaving asks first.
  await page.click('[aria-label="Rotate the selected pages right"]');
  check(await unsaved(page), 'turned pages are work to lose');
  await page.click('.ui-topbar [aria-label="Back"]');
  await page.waitForSelector('dialog[open] >> text=Discard your changes?');
  await page.click('dialog[open] button:has-text("Keep")');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  equal(await turns(page), new Array(12).fill(90), 'Keep keeps them');
  await page.click('button:has-text("Reset pages")');

  // Pages 1 right, 2 upside down, 4 left: the PDF says so and its text is as it was.
  await tap(SELECT_ALL);
  equal(await selected(page), [], 'Select none lets go of every page');
  await tap(tile(1));
  await page.click('[aria-label="Rotate page 1 right"]');
  await tap(tile(1));
  await tap(tile(2));
  await page.click('[aria-label="Rotate page 2 right"]');
  await page.click('[aria-label="Rotate page 2 right"]');
  await tap(tile(2));
  await tap(tile(4));
  await page.click('[aria-label="Rotate page 4 left"]');
  const { name, shown } = await saveAndRead(page, url);
  equal(name, 'Report_reorganized.pdf', 'named');
  equal(shown.map((p) => p.rotate), [90, 180, 0, 270, 0, 0, 0, 0, 0, 0, 0, 0], 'turns saved');
  equal(shown.slice(0, 4).map((p) => squash(p.text)), ['PAGE1', 'PAGE2', 'PAGE3', 'PAGE4'], 'text as it was');
  equal(shown.slice(0, 5).map((p) => p.width > p.height), [true, false, true, true, false], 'pages shown turned');
  await shot(page, `reorganize-turned-result-${size}`);
  // On the phone, Back (the browser's) returns to editing, as Android's Back does in the app.
  if (wide) await page.click('.ui-result .ui-topbar [aria-label="Back to editing"]');
  else await page.goBack();
  await page.waitForSelector('.merge-view:not([hidden])');
  equal(await page.evaluate(() => location.hash), '#/tool/reorganize', 'still in Reorganize PDF');
  equal([await turnShown(page, 4), await fieldReads(page)], [-90, '4'], 'turns and selection kept after Back to editing');
}

/** With reduced motion nothing turns, fades or glides: it is where it goes at once. */
async function reorganizeStill(page, url) {
  group = 'reorganize with reduced motion';
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openReorganize(page, url, fx.many, 24);
  equal(await page.$eval('.reorganize-grid .ui-page-turn', (e) => getComputedStyle(e).transitionDuration), '0s', 'no turning animation with reduced motion');
  await page.tap(tile(1));
  const mark = await page.$eval('.reorganize-grid .reorganize-check', (e) => ({ time: getComputedStyle(e).transitionDuration, opacity: getComputedStyle(e).opacity }));
  check(mark.time.split(',').every((d) => parseFloat(d) === 0) && mark.opacity === '1', 'the check mark is there at once', mark);
  await page.tap('[aria-label="Rotate page 1 right"]');
  const angle = await page.$eval('.reorganize-grid .ui-page-turn', (e) => {
    const x = new DOMMatrix(getComputedStyle(e).transform);
    return Math.round(Math.atan2(x.b, x.a) * 180 / Math.PI);
  });
  equal(angle, 90, 'turned at once');
  // A page typed alone comes into sight without the grid gliding there.
  await page.fill(PAGES_FIELD, '24');
  const scrolled = await page.$eval('.reorganize-grid', (g) => ({ top: g.scrollTop, end: g.scrollHeight - g.clientHeight }));
  check(scrolled.top > 0 && Math.abs(scrolled.top - scrolled.end) <= 1, 'the last page is in sight at once', scrolled);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

/**
 * What Delete pages' screen was tested for, now Reorganize PDF's: pages picked by taps and by
 * typing, kept in step; what is wrong with typed pages, said once typing is done; one page always
 * kept; and the pages removed really gone from the PDF saved.
 */
async function reorganizeRemoves(page, url, { wide }) {
  const size = wide ? 'desktop' : 'phone';
  group = `reorganize removes ${size}`;
  const tap = (sel) => (wide ? page.click(sel) : page.tap(sel));
  await openReorganize(page, url, fx.report, 12);
  equal(await page.getAttribute(SUPPORT, 'aria-live'), 'polite', 'what is under the field is said as it changes');
  equal(await page.getAttribute(PAGES_FIELD, 'aria-describedby'), await page.getAttribute(SUPPORT, 'id'), 'and it describes the field');

  // Tapping selects pages, written sorted with runs as ranges.
  for (const n of [7, 2, 5, 6]) await tap(tile(n));
  equal(await fieldReads(page), '2,5-7', 'taps written as typed');
  equal(await barSays(page), 'Selected: 4 of 12', 'four selected');
  equal(await checked(page), [2, 5, 6, 7], 'the pages selected');
  equal((await barButtons(page)).at(-1), 'Remove 4 pages', 'the bar removes them all');
  await page.waitForSelector('.reorganize-grid .ui-page-tile.is-selected .ui-page-picture.has-picture');
  await shot(page, `reorganize-picked-${size}`);
  await tap(tile(6));
  equal(await fieldReads(page), '2,5,7', 'one let go');
  // Typed in any order, the text stays as typed; a tap then writes the selection sorted, with
  // runs as ranges. Half typed, a tap leaves the text alone.
  await page.fill(PAGES_FIELD, '7,6,5');
  equal([await fieldReads(page), await checked(page)], ['7,6,5', [5, 6, 7]], 'typed backwards: kept as typed');
  await tap(tile(5));
  equal(await fieldReads(page), '6-7', 'a tap writes what is left, as a range');
  await page.fill(PAGES_FIELD, '2,7');
  await tap(tile(5));
  equal(await fieldReads(page), '2,5,7', 'a page tapped goes in its place');
  await page.fill(PAGES_FIELD, '3-');
  await tap(tile(5));
  equal([await fieldReads(page), await checked(page)], ['3-', []], 'half typed: a tap leaves it alone');

  // Every page selected: one must stay, and nothing is made.
  await page.fill(PAGES_FIELD, '1-12');
  equal(await barSays(page), 'Selected: 12 of 12', 'all selected');
  equal(await page.textContent(SELECT_ALL), 'Select none', 'typed, every page selected is Select none too');
  equal(await support(page), HINT, 'no warning yet');
  await page.click('[aria-label="Remove 12 pages"]');
  equal(await support(page), 'Keep at least one page.', 'keep a page');
  equal((await state(page)).pages.length, 12, 'no page goes');
  check(await page.isDisabled('.ui-bottombar button') && await page.isDisabled('[aria-label="Undo"]'), 'nothing to save, nothing to undo');
  await shot(page, `reorganize-need-${size}`);
  // Typing takes the warning away, also when what is typed still names every page.
  await page.fill(PAGES_FIELD, '1-11,12');
  equal([await barSays(page), await support(page)], ['Selected: 12 of 12', HINT], 'typed again, every page still selected: the warning goes');
  // It goes for good once not every page is selected: a page added and then taken back by Undo
  // leaves every page selected again, and the warning doesn't come back with no Remove pressed.
  await page.click('[aria-label="Remove 12 pages"]');
  equal(await support(page), 'Keep at least one page.', 'Remove pressed again brings it back');
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 13);
  equal([await barSays(page), await support(page)], ['Selected: 12 of 13', HINT], 'a page added: not every page is selected, and the warning goes');
  await page.click('[aria-label="Undo"]');
  await tileCount(page, 12);
  equal([await barSays(page), await support(page)], ['Selected: 12 of 12', HINT], 'the page taken back: every page selected again, and no warning');
  // The same with taps: gone with a page let go, and not back when the page is selected again.
  await page.click('[aria-label="Remove 12 pages"]');
  equal(await support(page), 'Keep at least one page.', 'Remove pressed once more');
  await tap(tile(12));
  equal(await support(page), HINT, 'gone with a page let go');
  equal(await page.getAttribute(PAGES_FIELD, 'aria-invalid'), null, 'the field is no longer marked');
  await tap(tile(12));
  equal([await barSays(page), await support(page)], ['Selected: 12 of 12', HINT], 'every page selected again doesn\'t bring it back');

  // Typed pages that can't be used are explained once typing is done (Enter, the field left, or
  // a page tapped), never while they are typed.
  const cases = [
    ['13', 'Pages must be between 1 and 12.', 'Enter'],
    ['2,x', 'Use page numbers such as 1,3-5.', 'the field left'],
    ['9-4', 'Write ranges from low to high, such as 3-8.', 'a page tapped'],
  ];
  for (const [typed, message, how] of cases) {
    await page.fill(PAGES_FIELD, typed);
    equal([await support(page), await page.getAttribute(PAGES_FIELD, 'aria-invalid')], [HINT, null], `"${typed}": nothing said while it is typed`);
    equal(await selected(page), [], `"${typed}": nothing selected`);
    if (how === 'Enter') {
      await page.keyboard.press('Enter');
    } else if (how === 'the field left') {
      // Another window or tab looked at sends the field a blur as well, but leaves it the one to
      // type in: that is not leaving it, and nothing is said yet.
      await page.$eval(PAGES_FIELD, (field) => field.dispatchEvent(new FocusEvent('blur')));
      equal([await focusIs(page, PAGES_FIELD), await support(page), await page.getAttribute(PAGES_FIELD, 'aria-invalid')], [true, HINT, null],
        `"${typed}": another window looked at is not the field left`);
      await page.focus(NAME_FIELD);
    } else {
      await tap(tile(1));
    }
    equal(await support(page), message, `"${typed}": said after ${how}`);
    equal(await page.getAttribute(PAGES_FIELD, 'aria-invalid'), 'true', `"${typed}": the field is marked as wrong`);
    equal([await fieldReads(page), await checked(page)], [typed, []], `"${typed}": what was typed stays, nothing is selected`);
    // Enter with a keyboard leaves the focus in the field; a phone's Done puts its keyboard away.
    if (how === 'Enter') {
      const finger = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      equal(finger, !wide, 'a phone is used with a finger, a computer with a mouse');
      equal(await focusIs(page, PAGES_FIELD), !finger, finger ? 'Done leaves the field' : 'Enter keeps the focus in the field');
    }
  }
  // Typing on hides it again.
  await page.fill(PAGES_FIELD, '9-');
  equal([await support(page), await page.getAttribute(PAGES_FIELD, 'aria-invalid')], [HINT, null], 'typing on, nothing is said');
  // Blank: nothing selected, nothing wrong. The cross empties the field and the selection.
  await page.fill(PAGES_FIELD, '  ');
  await page.keyboard.press('Enter');
  equal([await support(page), await selected(page)], [HINT, []], 'blank: nothing selected, nothing wrong');
  equal(await page.getAttribute('.reorganize-clear', 'aria-label'), 'Clear the selected pages', 'the cross is named');
  check(await page.isVisible('.reorganize-clear'), 'spaces are text: the cross shows');
  await tap('.reorganize-clear');
  equal(await fieldReads(page), '', 'the cross empties the field');
  check(await page.isHidden('.reorganize-clear'), 'and goes with the text');
  await tap(tile(3));
  await tap(tile(4));
  await tap('.reorganize-clear');
  equal([await fieldReads(page), await checked(page), await barSays(page)], ['', [], 'Tap pages to select them'], 'the cross lets go of the pages too');

  // Four pages removed: the PDF saved holds the others, and nothing of those removed.
  await page.fill(PAGES_FIELD, '2,5-7');
  await page.click('[aria-label="Remove 4 pages"]');
  await tileCount(page, 8);
  equal(await page.textContent('.reorganize-count'), '8 pages', 'the count');
  equal([await fieldReads(page), await selected(page)], ['', []], 'nothing is selected after');
  const { name, bytes, shown } = await saveAndRead(page, url);
  equal(name, 'Report_reorganized.pdf', 'named');
  equal(shown.map((p) => squash(p.text)), ['PAGE1', 'PAGE3', 'PAGE4', 'PAGE8', 'PAGE9', 'PAGE10', 'PAGE11', 'PAGE12'], 'the pages left');
  const everything = everythingIn(bytes);
  check(holds(everything, 'PAGE 3') && holds(everything, 'PAGE 8'), 'the pages kept are found in the file\'s bytes');
  for (const gone of ['PAGE 2', 'PAGE 5', 'PAGE 6', 'PAGE 7']) check(!holds(everything, gone), `${gone} is gone from the file's bytes`);
  check(/^8 pages · /.test(await page.textContent('.ui-result-file .ui-result-details')), 'the result says 8 pages');
  await shot(page, `reorganize-removed-result-${size}`);
  // On the computer the browser's Back returns to editing (the result's history step).
  if (wide) await page.goBack();
  else await page.click('.ui-result .ui-topbar [aria-label="Back to editing"]');
  await page.waitForSelector('.merge-view:not([hidden])');
  equal([await page.textContent('.reorganize-count'), await fieldReads(page)], ['8 pages', ''], 'back to editing, as it was');

  // Leaving with pages only selected doesn't ask: nothing is turned, moved or removed.
  await openReorganize(page, url, fx.report, 12);
  await tap(tile(2));
  await tap(tile(3));
  check(!(await unsaved(page)), 'pages selected are nothing to lose');
  check(await page.isDisabled('.ui-bottombar button'), 'nor anything to save');
  await page.click('.ui-topbar [aria-label="Back"]');
  await page.waitForSelector('.screen[data-tool="reorganize"]', { state: 'detached' });
  check(await page.$('dialog[open]') === null, 'nothing asked on leaving');
}

/**
 * The grid never moves under the finger that taps a page. A page typed alone, or moved out of
 * sight, is scrolled into sight: inside the grid, the window staying where it is.
 */
async function reorganizeScrolls(page, url, { wide }) {
  group = `reorganize scrolling ${wide ? 'desktop' : 'phone'}`;
  await openReorganize(page, url, fx.many, 24);
  await waitFor(page, () => document.querySelectorAll('.reorganize-grid .ui-page-turn canvas').length >= 6);
  /** Where the grid is on screen, how far it and the window are scrolled, and how tall the line under the field is. */
  const where = () => page.evaluate((line) => {
    const grid = document.querySelector('.reorganize-grid');
    return {
      top: Math.round(grid.getBoundingClientRect().top),
      grid: Math.round(grid.scrollTop),
      window: Math.round(window.scrollY),
      line: Math.round(document.querySelector(line).getBoundingClientRect().height),
    };
  }, SUPPORT);
  /**
   * A tap in the middle of page `n`, where it is in the grid: the grid is never scrolled to reach
   * it. If the page is off the screen, or under the bar at its foot, the window is scrolled first,
   * as a finger would.
   */
  const tapAt = async (n) => {
    const at = await page.$eval(tile(n), (b) => {
      const foot = document.querySelector('.merge-view > .ui-bottombar').getBoundingClientRect().top;
      const middle = () => {
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      if (middle().y < 80 || middle().y > foot - 8) window.scrollBy(0, middle().y - foot / 2);
      return middle();
    });
    if (wide) await page.mouse.click(at.x, at.y);
    else await page.touchscreen.tap(at.x, at.y);
  };
  /** A press of a button in the page, which scrolls nothing to reach it. */
  const press = (selector) => page.$eval(selector, (b) => b.click());
  /** Scrolls the grid as a finger or a wheel would. */
  const scrollGrid = (to) => page.$eval('.reorganize-grid', (g, to) => { g.scrollTop = to === 'end' ? g.scrollHeight : to; }, to);
  const settled = () => atRest(page);
  /** Waits for the whole of page `n` to show in the grid, and for the grid to have come to rest. */
  const inSight = async (n) => {
    await waitFor(page, (n) => {
      const grid = document.querySelector('.reorganize-grid');
      const el = grid.querySelectorAll('.ui-page-tile')[n - 1];
      const top = el.offsetTop - grid.scrollTop;
      return top >= 0 && top + el.offsetHeight <= grid.clientHeight;
    }, n);
    await settled();
  };
  /**
   * Scrolls the grid until only `px` px of page `n` show, at the grid's foot or at its top, and
   * says how far the grid is scrolled then and how much of the page shows.
   */
  const showOnly = (n, edge, px) => page.evaluate(({ n, edge, px }) => {
    const grid = document.querySelector('.reorganize-grid');
    const el = grid.querySelectorAll('.ui-page-tile')[n - 1];
    grid.scrollTop = edge === 'foot' ? el.offsetTop - grid.clientHeight + px : el.offsetTop + el.offsetHeight - px;
    const top = el.offsetTop - grid.scrollTop;
    return { grid: Math.round(grid.scrollTop), shows: Math.round(Math.min(top + el.offsetHeight, grid.clientHeight) - Math.max(top, 0)), of: el.offsetHeight };
  }, { n, edge, px });

  const start = await where();
  check(start.grid === 0 && (await page.$eval('.reorganize-grid', (g) => g.scrollHeight > g.clientHeight)), 'the grid scrolls inside itself, from its top', start);
  await tapAt(2);
  await tapAt(3);
  equal(await checked(page), [2, 3], 'pages tapped where they are');
  await settled();
  equal(await where(), start, 'taps move nothing: not the grid, not the pages in it, not the window');

  // The hint and what is wrong take the same room: the tap that brings the reason, with text
  // that can't be read, doesn't move the grid either.
  await page.fill(PAGES_FIELD, '2,5-');
  const typed = await where();
  await tapAt(1);
  equal(await support(page), 'Use page numbers such as 1,3-5.', 'the reason shows');
  await settled();
  equal(await where(), typed, 'the grid stays where it was, the line under the field as tall as before');

  // A page typed alone that is out of sight is scrolled into sight: in the grid, not the window,
  // so the field being typed in stays on screen.
  await page.fill(PAGES_FIELD, '23');
  await inSight(23);
  let now = await where();
  check(now.grid > 0 && now.window === typed.window && now.top === typed.top, 'the grid scrolled inside itself, the window stayed', now);
  check(await focusIs(page, PAGES_FIELD), 'and the focus is still in the field');
  // It is the page's row that comes first in the grid, as in the app: right under the bar and the
  // field, so the page is seen on a phone too, where the grid's foot lies under Save PDF. (Page 23
  // is in the last row, which stops at the grid's foot: the grid can scroll no further.)
  await scrollGrid(0);
  const hidden = await tilePlace(page, 14);
  check(hidden.underGridTop >= hidden.gridHeight, 'page 14 is out of sight with the grid at its top', hidden);
  await page.fill(PAGES_FIELD, '14');
  await settled();
  const first = await tilePlace(page, 14);
  check(first.underGridTop >= 0 && first.underGridTop <= 8, 'page 14 typed: its row is the first that shows in the grid', first);
  check(first.seen, 'and the whole page is on the screen, clear of the bars', first);
  now = await where();
  check(now.window === typed.window && now.top === typed.top && await focusIs(page, PAGES_FIELD), 'the window stayed and the focus is in the field', now);
  // A page of which any part shows in the grid is in sight, as in the app: typed alone it is left
  // where it is, whether it is cut at the grid's foot or at its top.
  for (const edge of ['foot', 'top']) {
    await page.fill(PAGES_FIELD, '');
    const cut = await showOnly(13, edge, 30);
    check(cut.shows > 0 && cut.shows < cut.of, `page 13 shows in part at the grid's ${edge}`, cut);
    await page.fill(PAGES_FIELD, '13');
    await settled();
    equal([await barSays(page), (await where()).grid], ['Page 13', cut.grid], `page 13, cut at the grid's ${edge}, is typed: the grid stays where it is`);
  }
  // Nor does a tap bring a page cut at the grid's edge into it: the grid stays under the finger.
  const cutBy30 = await page.$eval('.reorganize-grid', (grid) => {
    grid.scrollTop = grid.querySelectorAll('.ui-page-tile')[12].offsetTop + 30;
    return Math.round(grid.scrollTop);
  });
  await tapAt(13);
  await settled();
  equal([await checked(page), (await where()).grid], [[], cutBy30], 'page 13, cut at the grid\'s top, is tapped: let go, and the grid stays where it is');
  // Typed with another page, nothing scrolls: only a page selected alone is gone to.
  await scrollGrid(0);
  await page.fill(PAGES_FIELD, '23,24');
  await settled();
  equal((await where()).grid, 0, 'two pages typed: the grid stays');

  // A page left selected alone by taps is not gone to: the grid never moves under the finger
  // that taps a page, also when the one left is out of sight.
  await tapAt(1);
  equal(await fieldReads(page), '1,23-24', 'page 1 tapped as well');
  await scrollGrid('end');
  await tapAt(23);
  await scrollGrid(0);
  await tapAt(1);
  equal(await barSays(page), 'Page 24', 'page 24 is left alone, out of sight');
  await settled();
  equal((await where()).grid, 0, 'and the grid stays where the finger is');

  // Moved while out of sight with the bar's button, it is scrolled into sight; so is a page that
  // Undo moves back.
  const alone = await where();
  await press('[aria-label="Move page 24 earlier"]');
  await inSight(23);
  now = await where();
  check(now.grid > 0 && now.window === alone.window && now.top === alone.top, 'the page moved is scrolled into sight in the grid, the window staying', now);
  await scrollGrid(0);
  await press('[aria-label="Undo"]');
  await inSight(24);
  equal(await barSays(page), 'Page 24', 'Undo puts it back, and it is in sight again');
  // A page added goes after it and doesn't move it: nothing to follow.
  await scrollGrid(0);
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 25);
  equal((await state(page)).pages[24].input, 'blank', 'a blank page after the selected page, the last');
  await settled();
  equal((await where()).grid, 0, 'a page added after it doesn\'t move it: the grid stays');
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
  // Several pages selected, and what is wrong under the field.
  await page.click(tile(4));
  await page.click(tile(5));
  await page.fill(PAGES_FIELD, '2,4-');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await shot(page, `reorganize-dark-wrong-${wide ? 'desktop' : 'phone'}`);
  await page.fill(PAGES_FIELD, '2,4-5');
  await page.waitForTimeout(300);
  await shot(page, `reorganize-dark-several-${wide ? 'desktop' : 'phone'}`);
  // A long PDF's grid scrolls inside the screen.
  const grid = await page.evaluate(() => { const g = document.querySelector('.reorganize-grid'); return { sh: g.scrollHeight, ch: g.clientHeight }; });
  check(grid.sh > grid.ch, 'the grid scrolls in itself', grid);
  await noSideScroll(page);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The narrowest phones (320 px): nothing scrolls sideways, the selected page's buttons all fit. */
async function narrow(page, url) {
  group = 'narrow';
  await page.setViewportSize({ width: 320, height: 700 });
  await openTool(page, url, 'merge');
  await pick(page, '.merge-page .ui-empty', [fx.alpha, { ...fx.gamma, name: 'A quarterly report with a long name that goes on and on.pdf' }]);
  await waitFor(page, () => document.querySelectorAll('.merge-files .merge-file').length === 2);
  await noSideScroll(page);
  await page.click('.merge-mode');
  await noSideScroll(page);
  await openReorganize(page, url, fx.many, 24);
  /** Whether the bar's buttons that show are all inside it, 48 px each. */
  const fit = () => page.evaluate(() => {
    const bar = document.querySelector('.reorganize-bar').getBoundingClientRect();
    return [...document.querySelectorAll('.reorganize-bar .ui-icon-btn')].filter((b) => b.getClientRects().length).every((b) => {
      const x = b.getBoundingClientRect();
      return x.left >= bar.left - 1 && x.right <= bar.right + 1 && x.width >= 47 && x.height >= 47;
    });
  });
  const labelBox = () => page.$eval('.reorganize-bar-label', (e) => {
    const r = e.getBoundingClientRect();
    return { width: Math.round(r.width), cut: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 };
  });
  const barHeight = () => page.$eval('.reorganize-bar', (e) => Math.round(e.getBoundingClientRect().height));
  const empty = await barHeight();
  await page.click(tile(2));
  equal((await barButtons(page)).length, 5, 'one page selected: five buttons');
  check(await fit(), 'the five buttons fit, 48 px each');
  equal(await barSays(page), 'Page 2', 'the page is still named for screen readers');
  check((await labelBox()).width <= 1, 'though its name is out of sight beside five buttons', await labelBox());
  equal(await barHeight(), empty, 'the bar is as tall as with nothing selected');
  await shot(page, 'reorganize-320');
  // Several pages selected: three buttons, and the text beside them is seen, whole.
  await page.click(SELECT_ALL);
  equal(await barSays(page), 'Selected: 24 of 24', 'every page selected');
  equal((await barButtons(page)).length, 3, 'three buttons');
  check(await fit(), 'which fit');
  const several = await labelBox();
  check(several.width > 60 && !several.cut, 'the text is seen beside three buttons, not cut', several);
  equal(await barHeight(), empty, 'and the bar is as tall still');
  // The line under the field is as tall with its hint as with what is wrong.
  const lineHeight = () => page.$eval(SUPPORT, (e) => Math.round(e.getBoundingClientRect().height));
  const gridTop = () => page.$eval('.reorganize-grid', (e) => Math.round(e.getBoundingClientRect().top + window.scrollY));
  const withHint = [await lineHeight(), await gridTop()];
  await page.click('[aria-label="Remove 24 pages"]');
  equal(await support(page), 'Keep at least one page.', 'what is wrong shows');
  equal([await lineHeight(), await gridTop()], withHint, 'in the room the hint had: the grid is where it was');
  await shot(page, 'reorganize-320-several');
  await noSideScroll(page);
  // The same when the two take different numbers of lines, as in a language with longer words: a
  // field narrower than any phone's, where the hint needs two lines and what is wrong one.
  await page.addStyleTag({ content: '.reorganize-select { max-width: 200px; }' });
  const oneLine = await page.$eval(SUPPORT, (e) => parseFloat(getComputedStyle(e).lineHeight));
  const wrong = [await lineHeight(), await gridTop()];
  await page.click(tile(1));
  equal(await support(page), HINT, 'a page let go: the hint is back');
  check(await page.$eval(SUPPORT, (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getClientRects().length; }) >= 2, 'the hint takes two lines here');
  equal([await lineHeight(), await gridTop()], wrong, 'the line was as tall with one line of text as it is with two');
  check(wrong[0] >= 2 * oneLine, 'room for two lines, kept all along', { line: wrong[0], oneLine });
}

/** A short run in another browser: merge two PDFs, then Reorganize: move, turn, select, remove, save. */
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
  equal((await pageLines(page))[0], '1. gamma.pdf, page\u00a01', 'a page dragged with the mouse');
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
  await tileCount(page, 3);
  await page.click(tile(1));
  await page.click('[aria-label="Move page 1 later"]');
  await page.click('[aria-label="Rotate page 2 left"]');
  const [a, b] = await centers(page, '.reorganize-grid .ui-page', [2, 0]);
  await mouseDrag(page, a, b);
  const expected = (await state(page)).pages;
  check(expected.length === 3 && expected[0].page === 2 && expected[2].rotation === 270, 'moved, turned and dragged with the mouse', expected);
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 4);
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

  // What Rotate PDF and Delete pages did: every page turned at once, pages tapped and typed,
  // what is wrong said, several removed, the PDF saved.
  await openReorganize(page, url, fx.report, 12);
  await page.click(SELECT_ALL);
  equal([await fieldReads(page), await barSays(page)], ['1-12', 'Selected: 12 of 12'], 'every page selected');
  await page.click('[aria-label="Rotate the selected pages left"]');
  equal(await turns(page), new Array(12).fill(270), 'all turned left');
  await page.click('[aria-label="Remove 12 pages"]');
  equal(await support(page), 'Keep at least one page.', 'one page is kept');
  await page.click(SELECT_ALL);
  for (const n of [7, 2, 5]) await page.click(tile(n));
  equal(await fieldReads(page), '2,5,7', 'pages tapped');
  await page.fill(PAGES_FIELD, '2,5-');
  await page.keyboard.press('Enter');
  equal(await support(page), 'Use page numbers such as 1,3-5.', 'what is wrong with typed pages');
  await page.fill(PAGES_FIELD, '2,5-7');
  equal(await checked(page), [2, 5, 6, 7], 'pages typed');
  await page.waitForTimeout(300);
  await shot(page, `reorganize-selected-${name.replace(' ', '-')}`);
  await page.click('[aria-label="Remove 4 pages"]');
  await tileCount(page, 8);
  const made = await saveAndRead(page, url);
  equal(made.shown.map((p) => p.rotate), new Array(8).fill(270), 'eight pages left, turned');
  equal(made.shown.map((p) => squash(p.text)).sort(), ['PAGE1', 'PAGE10', 'PAGE11', 'PAGE12', 'PAGE3', 'PAGE4', 'PAGE8', 'PAGE9'], 'the pages removed are gone');
  // The browser's Back returns to editing.
  await page.goBack();
  await page.waitForSelector('.merge-view:not([hidden])');
  equal(await page.evaluate(() => location.hash), '#/tool/reorganize', 'still in Reorganize PDF');
  equal(await page.textContent('.reorganize-count'), '8 pages', 'the pages as they were');
  // Remove from the keyboard: this browser too brings the page the focus goes to onto the screen
  // (at the phone's width page 7 is in the row cut at the grid's foot, under Save PDF).
  await page.fill(PAGES_FIELD, '7');
  await atRest(page);
  await page.focus('[aria-label="Remove page 7"]');
  await page.keyboard.press('Enter');
  await tileCount(page, 7);
  await atRest(page);
  const at = await tilePlace(page, 0);
  check(at.name === 'Page 7, Turned left' && at.seen, 'Remove from the keyboard: the focus is on the page now in its place, the whole of it on the screen', at);
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
  const chooser = await chooserFromKeyboard(page, selector);
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
  await tileCount(page, 3);
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
  // Reset pages leaves the page selected, as the app's now does.
  equal([await barSays(page), (await selected(page)).length], ['Page 1', 1], 'Reset pages leaves the page selected');

  // Remove pressed from the keyboard. Its buttons go with the selection: the focus goes to the
  // page now in the place of the first page removed, never to the top of the page, and the page
  // count, which a screen reader hears change, says what is left.
  await page.click(tile(2));
  await page.focus('[aria-label="Remove 2 pages"]');
  await page.keyboard.press('Enter');
  await tileCount(page, 1);
  equal(await focused(page), 'Page 1', 'pages removed: the focus on the page now in their place');
  check(await page.evaluate(() => !!document.activeElement.closest('.reorganize-grid .ui-page-tile')), 'which is in the grid');
  equal([await page.textContent('.reorganize-count'), await page.getAttribute('.reorganize-count', 'aria-live')], ['1 page', 'polite'], 'the count says what is left');
  // The only page: its Remove is on, and pressed it says why nothing goes; the focus stays on it.
  await page.keyboard.press('Space');
  equal(await barButtons(page), ['Move page 1 earlier', 'Move page 1 later', 'Rotate page 1 left', 'Rotate page 1 right', 'Remove page 1'], 'the only page has its five buttons');
  check(await page.isDisabled('[aria-label="Move page 1 earlier"]') && await page.isDisabled('[aria-label="Move page 1 later"]') && await page.isEnabled('[aria-label="Remove page 1"]'), 'it can\'t move, and Remove is on');
  await page.focus('[aria-label="Remove page 1"]');
  await page.keyboard.press('Enter');
  equal(await support(page), 'Keep at least one page.', 'the only page stays, and the field says why');
  equal([(await state(page)).pages.length, await focused(page)], [1, 'Remove page 1'], 'nothing goes, and the focus stays on Remove');
  // Ctrl+Z from the bar: the pages come back unselected, the page selected is third again and
  // its buttons, renamed, keep the focus.
  await page.keyboard.press('Control+z');
  await tileCount(page, 3);
  equal([await barSays(page), await focused(page)], ['Page 3', 'Remove page 3'], 'Undo from the bar: the focus stays on the button, renamed');
  equal(await support(page), HINT, 'and nothing is wrong any more');

  // A page that goes with an Undo while one of its buttons has the focus: the buttons go, and
  // the focus goes to a page rather than to the top of the screen.
  await page.click(tile(3));
  await page.click('.reorganize-actions button:has-text("Add pages")');
  await page.click('.ui-menu-item:has-text("Blank page")');
  await tileCount(page, 4);
  await page.click(tile(4));
  await page.focus('[aria-label="Rotate page 4 right"]');
  await page.keyboard.press('Control+z');
  await tileCount(page, 3);
  equal(await barSays(page), 'Tap pages to select them', 'the page selected went with the Undo');
  check(await page.evaluate(() => !!document.activeElement.closest('.reorganize-grid .ui-page-tile')), 'the focus its button had is on a page', await focused(page));

  // The cross from the keyboard: it goes with the text, and the focus goes to the field it
  // emptied. Pressed with a mouse, it leaves the focus where it was: in the field.
  await page.fill(PAGES_FIELD, '2');
  await page.keyboard.press('Tab');
  equal(await focused(page), 'Clear the selected pages', 'the cross comes after the field');
  await page.keyboard.press('Enter');
  equal(await fieldReads(page), '', 'the cross empties the field');
  check(await focusIs(page, PAGES_FIELD), 'the cross pressed from the keyboard: the focus on the field', await focused(page));
  await page.fill(PAGES_FIELD, '3');
  await page.click('.reorganize-clear');
  equal(await fieldReads(page), '', 'emptied with the mouse');
  check(await focusIs(page, PAGES_FIELD), 'the cross pressed with the mouse: the focus stays in the field', await focused(page));

  // Turned, saved, and left from the keyboard.
  await page.click(tile(1));
  await page.click('[aria-label="Rotate page 1 right"]');
  await resultFocus(page, 'Save PDF', '.reorganize-page .ui-empty');
}

/**
 * Remove pressed from the keyboard in a long PDF. The bar's buttons go with the selection, and
 * the focus goes to the page now in the place of the first page removed: that page, and the
 * whole of it on the screen, also in one column, where the grid's foot lies under Save PDF.
 */
async function reorganizeFocusAfterRemove(page, url, { wide }) {
  group = `reorganize focus after Remove ${wide ? 'desktop' : 'phone'}`;
  await openReorganize(page, url, fx.many, 24);
  const cases = [
    // Far down the PDF, the first page removed neither the last page nor the page Tab goes to.
    ['20,22-23', 'Remove 3 pages', 21, 'Page 20'],
    // In the row cut at the grid's foot while the grid is at its top.
    ['8-9', 'Remove 2 pages', 19, 'Page 8'],
    // One page, which typing has brought to the grid's top.
    ['12', 'Remove page 12', 18, 'Page 12'],
  ];
  for (const [typed, button, left, name] of cases) {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.reorganize-grid').scrollTop = 0;
    });
    await page.fill(PAGES_FIELD, typed);
    await atRest(page);
    await page.focus(`[aria-label="${button}"]`);
    await page.keyboard.press('Enter');
    await tileCount(page, left);
    await atRest(page);
    const at = await tilePlace(page, 0);
    equal(at.name, name, `"${typed}" removed: the focus is on the page now in the place of the first page removed`);
    check(at.seen, `"${typed}" removed: and the whole of that page is on the screen`, at);
    equal([await selected(page), await barSays(page)], [[], 'Tap pages to select them'], `"${typed}" removed: nothing is selected`);
  }
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
      // Merge PDF's file name is there at once; Reorganize PDF's waits for its PDF.
      equal(await page.inputValue(id === 'merge' ? '.screen .ui-field-input' : NAME_FIELD).catch(() => null) ?? 'none', id === 'merge' ? 'Merged_PDF' : '', `${id}: shown with its name, the engine not loaded`);
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
  equal(turned.which, ['5. big.pdf, page\u00a05'], `a turn redraws only its row of 2501 (${turned.ms} ms)`);
  const removed = await rowsChanged('[aria-label="Remove page 2499"]');
  // The two rows after it, renumbered, and the row whose Tab stop the focus took (the first).
  check(removed.rows <= 3, `a removal near the end redraws only the rows after it (${removed.ms} ms)`, removed.which);
  equal((await pageLines(page)).length, 2500, 'removed');
}

// ---------------------------------------------------------------------------------------------

await stringTests();
pageListTests();
pageChoiceTests();

for (const wide of [false, true]) {
  await withPage(async (page, url) => {
    // Merging and reorganizing embed no font with pdf-lib: fontkit (157 kB gzipped) isn't loaded.
    const fontkit = [];
    page.on('request', (r) => { if (r.url().includes('/vendor/fontkit/')) fontkit.push(r.url()); });
    if (!review) {
      await mergeFiles(page, url, { wide });
      await mergePages(page, url, { wide });
      if (!wide) await mergePasswordsAndProblems(page, url);
      await reorganizeSelects(page, url, { wide });
      await reorganizeButtons(page, url, { wide });
      await reorganizeTapsTogether(page, url);
      await reorganizeQuickPresses(page, url);
      await reorganizeAdding(page, url);
      await reorganize(page, url, { wide });
      if (wide) await reorganizeMore(page, url);
      await reorganizeTurns(page, url, { wide });
      await reorganizeRemoves(page, url, { wide });
      await reorganizeScrolls(page, url, { wide });
      await darkShots(page, url, { wide });
      if (!wide) {
        await reorganizeStill(page, url);
        await narrow(page, url);
      }
      await page.setViewportSize(wide ? DESKTOP : PHONE);
    }
    await mergeReview(page, url, { wide });
    await reorganizeReview(page, url, { wide });
    await reorganizeFocusAfterRemove(page, url, { wide });
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
