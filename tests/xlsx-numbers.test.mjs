// Spreadsheet values and number formats (engine/office/xlsx-numbers.js and xlsx-model.js): the
// app's SpreadsheetNumbersTest.kt and SpreadsheetsTest.kt, edge cases of the web port, and a set of
// cases whose answers were worked out by the app's own Kotlin code (GOLDEN, below). The same suite
// runs in Node, then in Chromium, Firefox and WebKit pages served as on GitHub Pages.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { withPage, assert, runInPage, root } from './harness.mjs';

const NUMBERS = 'app/js/engine/office/xlsx-numbers.js';
const MODEL = 'app/js/engine/office/xlsx-model.js';

/**
 * Every check, self-contained (it runs inside browser pages too): `numbers` and `model` are the two
 * modules. Returns { count, failures }.
 */
function suite(numbers, model, golden) {
  const { SpreadsheetNumbers: N, SheetLocale, CellNumbers, sheetLocale, shortDateCode } = numbers;
  const { SheetRange, SheetRefs, SheetUnits, SheetPages, SheetPaper, SheetColors, SheetDates, SheetStrings, SheetFormulas, SheetHeaders, headerRun } = model;
  const failures = [];
  let count = 0;
  const show = (v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : Object.is(v, -0) ? '-0' : JSON.stringify(v));
  const same = (a, b) => {
    if (Object.is(a, b)) return true;
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every((k) => same(a[k], b[k]));
    }
    return false;
  };
  const eq = (expected, actual, what) => {
    count++;
    if (!same(expected, actual)) failures.push(`${what}: expected ${show(expected)}, got ${show(actual)}`);
  };
  const near = (expected, actual, tolerance, what) => {
    count++;
    if (!(typeof actual === 'number' && Math.abs(expected - actual) <= tolerance)) failures.push(`${what}: expected ${expected} ± ${tolerance}, got ${show(actual)}`);
  };
  const ok = (condition, what) => {
    count++;
    if (!condition) failures.push(what);
  };
  const shown = (value, code, options) => N.format(value, code, options).text;
  const check = (rows) => {
    for (const [value, code, expected] of rows) eq(expected, shown(value, code), `${show(value)} with ${code}`);
  };
  const RED = 0xffff0000;
  const BLUE = 0xff0000ff;

  // SpreadsheetNumbersTest.kt

  // generalShowsWhatFitsInElevenCharacters
  check([
    [0, 'General', '0'],
    [-0, 'General', '0'],
    [-1, 'General', '-1'],
    [0.1 + 0.2, 'General', '0.3'],
    [1 / 3, 'General', '0.333333333'],
    [2 / 3, 'General', '0.666666667'],
    [-1 / 3, 'General', '-0.333333333'],
    [1234.5678901234, 'General', '1234.56789'],
    [12345678901, 'General', '12345678901'],
    [123456789012, 'General', '1.23457E+11'],
    [99999999999.5, 'General', '1E+11'],
    [1e15, 'General', '1E+15'],
    [1.23456789e100, 'General', '1.2346E+100'],
    [0.0001, 'General', '0.0001'],
    [0.00001234, 'General', '0.00001234'],
    [0.0000123456789, 'General', '1.23457E-05'],
    [1.5e-10, 'General', '1.5E-10'],
  ]);

  // generalNarrowsToTheColumn
  eq('1234.6', shown(1234.5678, 'General', { maxChars: 6 }), 'General in 6 characters');
  eq('1E+08', shown(123456789, 'General', { maxChars: 6 }), 'a big number in 6 characters');
  // However wide the column, General stops at eleven.
  eq('0.333333333', shown(1 / 3, 'General', { maxChars: 40 }), 'General in 40 characters');

  // impossibleNumbersShowAsNum
  for (const value of [NaN, Infinity, -Infinity]) eq('#NUM!', shown(value, '0.00'), `${value} with 0.00`);

  // builtInFormatsAreExcelsOwn
  eq('General', N.builtInFormat(0), 'built-in 0');
  eq('#,##0.00', N.builtInFormat(4), 'built-in 4');
  eq('m/d/yyyy', N.builtInFormat(14), 'built-in 14');
  eq('[h]:mm:ss', N.builtInFormat(46), 'built-in 46');
  eq('@', N.builtInFormat(49), 'built-in 49');
  eq(null, N.builtInFormat(50), 'built-in 50');
  eq(null, N.builtInFormat(-1), 'built-in -1');
  const dateIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47]);
  for (let id = 0; id <= 49; id++) eq(dateIds.has(id), N.isDateFormat(N.builtInFormat(id)), `built-in ${id} is a date`);
  check([
    [-1234.5, N.builtInFormat(8), '($1,234.50)'],
    [1234.5, N.builtInFormat(44), ' $1,234.50 '],
    [-1234.5, N.builtInFormat(43), ' (1,234.50)'],
    [0, N.builtInFormat(41), ' - '],
  ]);

  // digitPlaceholders
  check([
    [2.5, '0', '3'],
    [-2.5, '0', '-3'],
    [1.005, '0.00', '1.01'],
    [1234567.891, '#,##0.00', '1,234,567.89'],
    [-1234, '#,##0', '-1,234'],
    [5, '0,000', '0,005'],
    [0.5, '#.##', '.5'],
    [1, '0.#', '1.'],
    [1.234, '0.0#', '1.23'],
    [1.5, '0.0#', '1.5'],
    [1.5, '0.0?', '1.5 '],
    [12.5, '.00', '12.50'],
    [123, '00000', '00123'],
    [123456789, '000-00-0000', '123-45-6789'],
    [5551234567, '(###) ###-####', '(555) 123-4567'],
  ]);

  // scalingPercentAndPerMille
  check([
    [1234567, '#,##0,', '1,235'],
    [1234567, '0.0,,', '1.2'],
    [1234567, '#,##0.0,,"M"', '1.2M'],
    [0.256, '0%', '26%'],
    [0.256, '0.00%', '25.60%'],
    [0.0256, '0‰', '26‰'],
  ]);

  // scientific
  check([
    [12345, '0.00E+00', '1.23E+04'],
    [0.000123, '0.00E+00', '1.23E-04'],
    [9.999, '0.00E+00', '1.00E+01'],
    [0, '0.00E+00', '0.00E+00'],
    [12345, '0.00E-00', '1.23E04'],
    [12345, '##0.0E+0', '12.3E+3'],
    [0.000123, '##0.0E+0', '123.0E-6'],
  ]);

  // fractions
  check([
    [1.5, '# ?/?', '1 1/2'],
    [Math.PI, '# ??/??', '3 14/99'],
    [-1.25, '# ??/??', '-1  1/4 '],
    [2, '# ?/?', '2    '],
    [0.999, '# ?/?', '1    '],
    [1.5, '?/?', '3/2'],
    [1.5, '# ?/8', '1 4/8'],
    [0.5, '0/100', '50/100'],
  ]);

  // textAroundTheNumber
  const BS = String.fromCharCode(92);
  check([
    [-5, '"$"#,##0.00', '-$5.00'],
    [5, '#,##0.00 "kg"', '5.00 kg'],
    [3, `${BS}$0${BS} ${BS}k${BS}g`, '$3 kg'],
    [5, '0_)', '5 '],
    [5, '**0', '5'],
    [1234.5, '[$€-x-sysdecimal] #,##0.00', '€ 1,234.50'],
    [1234, '[$₹-4009] #,##0', '₹ 1,234'],
    [1.25, '[$-409]0.0', '1.3'],
    [5, '"Total: "General', 'Total: 5'],
  ]);

  // sectionsForNegativeZeroAndText
  check([
    [-5, '0.00;(0.00)', '(5.00)'],
    [-5, '0;-0', '-5'],
    [0, '0;-0;"zero"', 'zero'],
    [0.001, '0;-0;"zero"', '0'],
    [0, '0;-0;;@', ''],
    [5, ';;;', ''],
    [-5, '0.00;@', '-5.00'],
    [1.5, '@', '1.5'],
    [-5, 'General;[Red]-General', '-5'],
  ]);

  // conditionsPickTheSection
  const millions = '[>=1000000]0.0,,"M";[>=1000]0.0,"K";0';
  check([[1500000, millions, '1.5M'], [2500, millions, '2.5K'], [999, millions, '999']]);
  const split = '[Red][<=100]0;[Blue][>100]0';
  eq({ text: '50', colour: RED }, N.format(50, split), '50 in red');
  eq({ text: '150', colour: BLUE }, N.format(150, split), '150 in blue');
  // A negative number in a section of its own condition keeps its minus.
  eq('-5', shown(-5, split), '-5 keeps its minus');

  // colours
  eq(RED, N.format(5, '[Red]0').colour, '[Red]');
  eq({ text: '-5', colour: RED }, N.format(-5, '0;[Red]-0'), 'red negative');
  eq(0xff008000, N.format(5, '[Color10]0').colour, '[Color10]');
  eq(BLUE, N.format(5, '[BLUE]0').colour, '[BLUE]');
  eq(null, N.format(5, '0;[Red]-0').colour, 'positive of a red negative');

  // textCells
  eq({ text: 'abc', colour: null }, N.formatText('abc', '@'), 'text with @');
  eq({ text: 'abc', colour: null }, N.formatText('abc', '0.00'), 'text with 0.00');
  eq({ text: 'abc', colour: null }, N.formatText('abc', '0.00;@'), 'text with 0.00;@');
  eq({ text: 'Text: abc', colour: null }, N.formatText('abc', '0;-0;0;"Text: "@'), 'text section with words');
  eq({ text: 'n/a', colour: null }, N.formatText('abc', '0;-0;0;"n/a"'), 'text section without @');
  eq({ text: 'abc', colour: RED }, N.formatText('abc', '0;-0;0;[Red]@'), 'red text section');
  eq({ text: ' x ', colour: null }, N.formatText('x', N.builtInFormat(41)), 'text in built-in 41');

  // brokenCodesFallBackToGeneral
  for (const code of ['', '"unclosed', '[Red', '0;0;0;0;0', '#'.repeat(5000)]) {
    eq({ text: '1.5', colour: null }, N.format(1.5, code), `broken code ${code.slice(0, 12)}`);
  }

  // dates: 45000 is Wednesday 15 March 2023.
  check([
    [45000, 'm/d/yyyy', '3/15/2023'],
    [45000, 'dddd, mmmm d, yyyy', 'Wednesday, March 15, 2023'],
    [45000, 'd-mmm-yy', '15-Mar-23'],
    [45000, 'ddd dd/mm/yy', 'Wed 15/03/23'],
    [45000, 'mmmmm', 'M'],
    [45000, 'YYYY-MM-DD', '2023-03-15'],
    [45000, 'mm/dd', '03/15'],
    [45000.5, 'm/d/yyyy h:mm', '3/15/2023 12:00'],
  ]);

  // times
  check([
    [0.75, 'h:mm AM/PM', '6:00 PM'],
    [0, 'h:mm:ss AM/PM', '12:00:00 AM'],
    [0.75, 'h:mm a/p', '6:00 p'],
    // Typed in small letters, AM/PM still shows in capitals.
    [0.6, 'h:mm am/pm', '2:24 PM'],
    [0.5, 'hh:mm:ss', '12:00:00'],
    [(12 * 60 + 5) / 1440, 'h:mm', '12:05'],
    [307 / 86400, 'mm:ss', '05:07'],
    // Seconds round, as in Excel, and then the minutes aren't rounded up.
    [(12 * 3600 + 0.6) / 86400, 'h:mm:ss', '12:00:01'],
    [(59 * 60 + 59) / 86400, 'h:mm', '0:59'],
    [1.5 / 86400, 'mm:ss.0', '00:01.5'],
    [1.5, '[h]:mm:ss', '36:00:00'],
    [1 / 24, '[mm]:ss', '60:00'],
    [1 / 1440, '[ss]', '60'],
  ]);

  // excelsCalendarOf1900And1904
  check([
    [0, 'm/d/yyyy', '1/0/1900'],
    [1, 'dddd', 'Sunday'],
    [59, 'm/d/yyyy', '2/28/1900'],
    [60, 'm/d/yyyy', '2/29/1900'],
    [61, 'm/d/yyyy', '3/1/1900'],
    [2958465, 'm/d/yyyy', '12/31/9999'],
    [-1, 'm/d/yyyy', '###########'],
    [2958466, 'm/d/yyyy', '###########'],
  ]);
  eq('1/1/1904', shown(0, 'm/d/yyyy', { date1904: true }), '0 in 1904');
  eq('3/16/2027', shown(45000, 'm/d/yyyy', { date1904: true }), '45000 in 1904');

  // theLocalesSymbolsAndNames
  const french = {
    decimal: ',',
    grouping: ' ',
    months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    shortMonths: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
    shortDays: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
    am: 'AM',
    pm: 'PM',
  };
  eq('1 234,50', shown(1234.5, '#,##0.00', { locale: french }), 'French grouping');
  eq('1,5', shown(1.5, 'General', { locale: french }), 'French General');
  eq('mercredi 15 mars 2023', shown(45000, 'dddd d mmmm yyyy', { locale: french }), 'French date');

  // recognizesDateFormats
  for (const code of ['m/d/yyyy', '[h]:mm', 'mm:ss', '[$-409]mmmm', 'yyyy" years"', 'h AM/PM']) ok(N.isDateFormat(code), `${code} is a date`);
  for (const code of ['0.00', 'General', '"d"0', `0 ${BS}m`, '[Red]0', '@', '0.00E+00', '[$-409]#,##0']) ok(!N.isDateFormat(code), `${code} isn't a date`);

  // anyCodeAndValueIsShownWithoutAnError (a seeded generator of its own; the app's is Kotlin's Random)
  let seed = 1904;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const pieces = [
    '0', '#', '?', '.', ',', '%', '‰', 'E+', 'e-', '/', '/8', ' ', '"x"', `${BS}-`, '_)', '*-', '[Red]', '[Color60]',
    '[>=100]', '[<0]', '[=x]', '[$€-x-euro2]', '[$-409]', '[h]', '[mm]', '[ss]', 'y', 'yyyy', 'm', 'mmm', 'mmmmm',
    'd', 'dddd', 'h', 'hh', 's', 'ss', '.000', 'AM/PM', 'A/P', '@', ';', 'General', '"', '[', ']', BS, '_', '*', 'g', 'e',
  ];
  const values = [0, -0, 1, -1, 0.5, 1e-300, 1e300, -1e300, 45000.75, 2958465.99999, 3e6, Number.MAX_VALUE, Number.MIN_VALUE, NaN, Infinity, 1234.5678, -0.001];
  let thrown = null;
  const started = Date.now();
  for (let k = 0; k < 3000 && !thrown; k++) {
    let code = '';
    for (let n = Math.floor(random() * 12); n > 0; n--) code += pick(pieces);
    const value = random() < 0.5 ? pick(values) : random() * 2e7 - 1e7;
    try {
      const r = N.format(value, code, { date1904: random() < 0.5, maxChars: Math.floor(random() * 22) - 2 });
      if (typeof r.text !== 'string') thrown = `no text for ${code}`;
      N.formatText('text', code);
      N.isDateFormat(code);
    } catch (e) {
      thrown = `${code} with ${value}: ${e.message}`;
    }
  }
  ok(!thrown, `any code and value: ${thrown}`);
  ok(Date.now() - started < 10000, `3000 random codes took ${Date.now() - started} ms`);

  // SpreadsheetsTest.kt

  // cellReferencesReadFromA1ToXfd1048576
  eq(SheetRefs.pack(0, 0), SheetRefs.cell('A1'), 'A1');
  eq(SheetRefs.pack(2, 27), SheetRefs.cell('$AB$3'), '$AB$3');
  const last = SheetRefs.cell('XFD1048576');
  eq(SheetRefs.MAX_ROWS - 1, SheetRefs.rowOf(last), 'last row');
  eq(SheetRefs.MAX_COLUMNS - 1, SheetRefs.columnOf(last), 'last column');
  // Past the last column or row, or not a reference at all.
  for (const ref of ['XFE1', 'A1048577', 'A0', '1A']) eq(null, SheetRefs.cell(ref), ref);
  eq('XFD', SheetRefs.columnName(SheetRefs.MAX_COLUMNS - 1), 'column XFD');
  eq('AA', SheetRefs.columnName(26), 'column AA');

  // rangesAndDefinedNamesGiveTheirAreas
  eq(new SheetRange(0, 0, 19, 5), SheetRefs.range('$A$1:$F$20'), '$A$1:$F$20');
  // Corners in either order, whole rows and whole columns.
  eq(new SheetRange(0, 0, 19, 5), SheetRefs.range('F20:A1'), 'F20:A1');
  eq(new SheetRange(0, 0, 1, SheetRefs.MAX_COLUMNS - 1), SheetRefs.range('$1:$2'), '$1:$2');
  eq(new SheetRange(0, 1, SheetRefs.MAX_ROWS - 1, 2), SheetRefs.range('B:C'), 'B:C');
  eq([{ sheet: "It's, here", range: new SheetRange(0, 0, 1, 1) }, { sheet: "It's, here", range: new SheetRange(3, 3, 3, 3) }],
    SheetRefs.areas("'It''s, here'!$A$1:$B$2,'It''s, here'!$D$4,#REF!"), 'areas of a defined name');

  // columnWidthsTurnIntoPointsAsExcelDrawsThem: 8.43 characters, stored as 9.140625, is Excel's 64 pixel column.
  near(48, SheetUnits.columnPoints(9.140625), 0.001, 'column of 9.140625');
  near(48, SheetUnits.defaultColumnPoints(8), 0.001, 'default column of 8');
  near(0, SheetUnits.columnPoints(0), 0.001, 'column of 0');
  eq(7, SheetUnits.digitWidth('Calibri', 11), 'Calibri 11 digit');
  eq(7, SheetUnits.digitWidth('Arial', 10), 'Arial 10 digit');

  // rowsAndColumnsSplitIntoPagesThatFit
  const rows15 = new Array(10).fill(15);
  eq([0, 4, 8], SheetPages.bands(rows15, 60), 'bands of 60');
  // At half size they all fit; a manual break still starts a page.
  eq([0, 6], SheetPages.bands(rows15, 80, { scale: 0.5, breaks: new Set([6]) }), 'half size with a break');
  // A row taller than the page has one of its own; hidden rows take no room.
  eq([0, 1, 2], SheetPages.bands([10, 100, 0, 10], 50), 'a tall row');
  // Title rows (the first two) repeat on the pages after them, taking their room.
  eq([0, 4, 6, 8], SheetPages.bands(rows15, 60, { titleSize: 30, titleEnd: 1 }), 'title rows');
  eq(3, SheetPages.count(rows15, 60), 'count of bands');

  // fitToShrinksToTheLargestWholePercentThatFits
  const columns48 = new Array(20).fill(48);
  const rows100 = new Array(100).fill(15);
  // 960 points of columns on 480 points of paper: 50%.
  eq(50, SheetPages.fitScale(columns48, rows100, 480, 700, 1, 0), 'fit to one page wide');
  // Never enlarged past the most asked for, never below 10%.
  eq(100, SheetPages.fitScale([48, 48], rows100, 480, 700, 1, 0), 'never enlarged');
  eq(150, SheetPages.fitScale([48, 48], rows100, 480, 700, 1, 0, { most: 150 }), 'enlarged to most');
  eq(SheetPages.MIN_SCALE, SheetPages.fitScale(columns48, new Array(10000).fill(15), 480, 700, 1, 1), 'never below 10%');
  // Whole columns: 960 points fit two pages of 470 at 97%, ten columns a page.
  eq(97, SheetPages.fitScale(new Array(20).fill(48), rows100, 470, 700, 2, 0), 'two pages of whole columns');

  // pagesGoDownThenOverUnlessAskedOtherwise
  const pages = [[1, 1], [0, 1], [1, 0], [0, 0]];
  eq([[0, 0], [1, 0], [0, 1], [1, 1]], SheetPages.order(pages, true), 'down then over');
  eq([[0, 0], [0, 1], [1, 0], [1, 1]], SheetPages.order(pages, false), 'over then down');

  // paperSizesComeByNumberOrMeasure
  near(595.3, SheetPaper.size(9)[0], 0.1, 'A4 width');
  near(792, SheetPaper.size(1)[1], 0.1, 'Letter height');
  eq(null, SheetPaper.size(999), 'unknown paper');
  near(595.3, SheetPaper.length('210mm'), 0.1, '210mm');
  near(612, SheetPaper.length('8.5in'), 0.1, '8.5in');
  eq(null, SheetPaper.length('wide'), 'wide');
  // Sizes no paper has are left out, for the paper's number or Letter.
  for (const t of ['1e308mm', '100000in', '0.0001mm']) eq(null, SheetPaper.length(t), t);

  // coloursComeFromThePaletteAndTint
  eq(RED, SheetColors.indexed(10), 'indexed 10');
  eq(0xff000000, SheetColors.indexed(64), 'indexed 64');
  // Excel puts the background theme colour first.
  eq('lt1', SheetColors.themeKey(0), 'theme 0');
  eq('dk1', SheetColors.themeKey(1), 'theme 1');
  // The alpha byte is ignored, as Excel ignores it.
  eq(0xff4472c4, SheetColors.rgb('004472C4'), 'rgb with alpha 00');
  // Halfway to white, and halfway to black.
  eq(0xffff8080, SheetColors.tint(RED, 0.5), 'tint 0.5');
  eq(0xff800000, SheetColors.tint(RED, -0.5), 'tint -0.5');

  // datesOfTypeDBecomeExcelsDayNumbers
  eq(1, SheetDates.serial('1900-01-01'), '1900-01-01');
  // Excel's 29 February 1900 that never was puts later dates a day on.
  eq(61, SheetDates.serial('1900-03-01'), '1900-03-01');
  near(45366.5, SheetDates.serial('2024-03-15T12:00:00'), 1e-9, '2024-03-15T12:00:00');
  eq(0, SheetDates.serial('1904-01-01', true), '1904-01-01 in 1904');
  near(0.25, SheetDates.serial('06:00:00'), 1e-9, '06:00:00');
  eq(null, SheetDates.serial('15 March'), '15 March');

  // escapedCharactersComeBack
  eq('Line\r\nnext', SheetStrings.unescape('Line_x000D_\nnext'), '_x000D_');
  eq('_x000D_', SheetStrings.unescape('_x005F_x000D_'), '_x005F_');
  eq('plain_text', SheetStrings.unescape('plain_text'), 'plain text');

  // sharedFormulasMoveTheirRelativeReferences
  eq('SUM(B2:C2)*$D$1', SheetFormulas.shift('SUM(B1:C1)*$D$1', 1, 0), 'SUM moved down');
  eq('B$1+$A2', SheetFormulas.shift('A$1+$A1', 1, 1), 'half absolute');
  // Text, sheet names and function names stay; a reference off the sheet is #REF!.
  eq(`IF(A3="A1",'B1 sheet'!A3,LOG10(A3))`, SheetFormulas.shift(`IF(A2="A1",'B1 sheet'!A2,LOG10(A2))`, 1, 0), 'text, sheets and functions');
  eq('#REF!+1', SheetFormulas.shift('A1+1', -1, 0), 'off the sheet');
  eq('1E+5*C1', SheetFormulas.shift('1E+5*B1', 0, 1), 'a number with an exponent');

  // headersAndFootersFillInTheirFields
  const fields = { page: 2, pages: 5, sheet: 'Sales', file: 'Q3.xlsx', date: '1/2/26', time: '9:30' };
  const parts = SheetHeaders.parts('&L&"Arial,Bold"&A&CPage &P of &N&R&D && &F', fields);
  eq([headerRun('Sales', { bold: true, font: 'Arial' })], parts[0], 'left part');
  eq('Page 2 of 5', parts[1].map((r) => r.text).join(''), 'centre part');
  eq('1/2/26 & Q3.xlsx', parts[2].map((r) => r.text).join(''), 'right part');
  // Text before any part is the centre's; sizes and colours change the look of what follows.
  eq([headerRun('Draft '), headerRun('3', { size: 14, color: 0xff0000 })], SheetHeaders.parts('Draft &14&KFF0000&P+1', fields)[1], 'size and colour');

  // More of the web port: its JavaScript arguments, locales and limits.

  eq('#NUM!', shown('abc', '0'), 'a value that is no number');
  eq('5', shown(5, null), 'no code is General');
  eq('5', shown(5, undefined), 'an undefined code is General');
  eq({ text: '', colour: null }, N.formatText(null, '@'), 'no text');
  eq('12', shown(12.3, '0', { maxChars: NaN }), 'maxChars that is no number');
  eq('##########', shown(-1, 'd/m/yyyy', { maxChars: 10 }), 'a negative date fills the cell');
  eq('#', shown(-1, 'd/m/yyyy', { maxChars: -5 }), 'at least one #');
  eq('#'.repeat(255), shown(-1, 'd/m/yyyy', { maxChars: 1e9 }), 'at most 255 #');
  // A locale that leaves things out writes them in English.
  eq('March 15 12:00:00,0 PM', shown(45000.5, 'mmmm d h:mm:ss.0 AM/PM', { locale: { decimal: ',' } }), 'partial locale');
  eq('1.234,5', shown(1234.5, '#,##0.0', { locale: { decimal: ',', grouping: '.' } }), 'German symbols');
  eq('12:00:00,5 PM', shown(0.5 + 0.5 / 86400, 'hh:mm:ss.0 AM/PM', { locale: { decimal: ',' } }), 'tenths after a decimal comma');
  // Excel's 1900 leap-year bug: 29 February 1900 is a Wednesday after Tuesday the 28th.
  eq('Tue 2/28/1900', shown(59, 'ddd m/d/yyyy'), '28 February 1900');
  eq('Wed 2/29/1900', shown(60, 'ddd m/d/yyyy'), '29 February 1900');
  eq('Thu 3/1/1900', shown(61, 'ddd m/d/yyyy'), '1 March 1900');
  eq('Fri 1/1/1904', shown(0, 'ddd m/d/yyyy', { date1904: true }), '1 January 1904 was a Friday');
  eq('12/31/9999', shown(2957003, 'm/d/yyyy', { date1904: true }), 'last day of 1904');
  eq('###########', shown(2957004, 'm/d/yyyy', { date1904: true }), 'past the last day of 1904');
  // Seconds rounding into the next day.
  eq('1/2/1900 0:00:00', shown(1.999999999, 'm/d/yyyy h:mm:ss'), 'rounding to the next day');
  eq('1/1/1900 23:59:59.999', shown(1 + 86399.999 / 86400, 'm/d/yyyy hh:mm:ss.000'), 'thousandths of a second');
  eq('25:30', shown(1 + 1.5 / 24, '[h]:mm'), 'elapsed hours past a day');
  eq('0025:30', shown(1 + 1.5 / 24, '[hhhh]:mm'), 'elapsed hours padded');
  // Conditions without a third section, and with one.
  eq('neg', shown(-3, '[<0]"neg";[>0]"pos";"zero"'), 'condition: negative');
  eq('zero', shown(0, '[<0]"neg";[>0]"pos";"zero"'), 'condition: zero');
  eq('3', shown(-3, '[<0]0;0'), '[<0] shows without the minus');
  eq('1.50', shown(1.5, '[<1]0.000;[<10]0.00;0'), 'second condition');
  // Fractions, percent of fractions, denominators.
  eq('3 1/7', shown(3.142857, '# ?/?'), 'a seventh');
  eq(' 1/3', shown(1 / 3, '# ?/?'), 'no whole part shows nothing for #');
  eq('50 1/2%', shown(0.505, '# ?/?%'), 'percent of a fraction');
  eq('1 1/4', shown(1.26, '# ?/4'), 'quarters');
  eq('355/113', shown(Math.PI, '???/???'), 'pi');
  // Grouping with a large number and many decimals.
  eq('123,456,789,012,346,000,000.00', shown(1.23456789012345678e20, '#,##0.00'), '15 digits then zeros');
  eq('0.000000000000000000000000000001', shown(1e-30, '0.' + '0'.repeat(30)), 'thirty decimals');
  eq('1.0E+308', shown(1e308, '0.0E+0'), 'a huge exponent');
  eq('4.9E-324', shown(Number.MIN_VALUE, 'General'), 'the smallest double, as Java writes it');
  eq('-1.7977E+308', shown(-Number.MAX_VALUE, 'General'), 'the largest double, its exponent taking room');
  // Codes too long or too strange.
  eq('5', shown(5, '0'.repeat(1025)), 'a code over 1024 characters is General');
  eq('00005', shown(5, '0'.repeat(5)), 'zeros');
  ok(shown(1e300, '%'.repeat(1000) + '0').length > 2000, 'a thousand percent signs');
  const hostile = Date.now();
  for (let k = 0; k < 200; k++) N.format(1e300 + k, '0' + '%'.repeat(1000) + '.' + '0'.repeat(20));
  ok(Date.now() - hostile < 5000, `hostile codes took ${Date.now() - hostile} ms`);
  // A sheet's worth of cells.
  const many = Date.now();
  let length = 0;
  for (let k = 0; k < 50000; k++) length += N.format(k * 1.37, ['#,##0.00', 'm/d/yyyy', 'General', '0%', '# ?/?'][k % 5]).text.length;
  ok(length > 0 && Date.now() - many < 5000, `50,000 cells took ${Date.now() - many} ms`);

  // SheetLocale and CellNumbers, from the browser's own data.
  eq('.', SheetLocale.ENGLISH.decimal, 'English decimal');
  eq('m/d/yyyy', shortDateCode('en-US'), 'US short date');
  eq('dd/mm/yyyy', shortDateCode('en-GB'), 'British short date');
  eq('dd.mm.yyyy', shortDateCode('de-DE'), 'German short date');
  const us = new CellNumbers('en-US');
  eq('m/d/yyyy', us.builtIn(14), 'US built-in 14');
  eq('m/d/yyyy h:mm', us.builtIn(22), 'US built-in 22');
  eq('General', us.builtIn(100), 'unknown built-in');
  eq({ text: '3/15/2023', colour: null }, us.format(45000, us.builtIn(14)), 'US date');
  eq({ text: 'abc', colour: RED }, us.formatText('abc', '0;0;0;[Red]@'), 'US text');
  const gb = new CellNumbers('en-GB');
  eq('15/03/2023 12:00', gb.format(45000.5, gb.builtIn(22)).text, 'British date and time');
  const fr = sheetLocale('fr-FR');
  eq(',', fr.decimal, 'French decimal');
  ok(/^\s$/u.test(fr.grouping) || fr.grouping === '\u202f', `French grouping ${show(fr.grouping)}`);
  eq('janvier', fr.months[0], 'French January');
  eq('mercredi', fr.days[3], 'French Wednesday');
  eq(`1${fr.grouping}234,50`, new CellNumbers('fr-FR').format(1234.5, '#,##0.00').text, 'French number');
  eq('mercredi 15 mars 2023', new CellNumbers('fr-FR').format(45000, 'dddd d mmmm yyyy').text, 'French date from the browser');
  const es = sheetLocale('es-ES');
  eq(',', es.decimal, 'Spanish decimal');
  eq('marzo', es.months[2], 'Spanish March');
  const hi = sheetLocale('hi-IN');
  eq('.', hi.decimal, 'Hindi decimal');
  eq('d/m/yyyy', shortDateCode('hi-IN'), 'Hindi short date');
  eq(SheetLocale.ENGLISH, sheetLocale('not a language!'), 'an unknown language is English');

  // The model's own extras.
  const r = new SheetRange(2, 2, 5, 5);
  ok(r.contains(2, 5) && !r.contains(6, 2), 'range contains');
  eq(new SheetRange(0, 2, 5, 9), r.union(new SheetRange(0, 9, 1, 9)), 'range union');
  eq(new SheetRange(4, 4, 5, 5), r.intersect(new SheetRange(4, 4, 9, 9)), 'range intersect');
  eq(null, r.intersect(new SheetRange(6, 6, 9, 9)), 'ranges apart');
  ok(r.equals(new SheetRange(2, 2, 5, 5)) && !r.equals(new SheetRange(2, 2, 5, 6)), 'range equals');
  eq(null, SheetRefs.cell(null), 'no reference');
  eq(null, SheetRefs.range('A1:B2:C3'), 'three corners');
  eq(new SheetRange(0, 0, 0, 0), SheetRefs.range(' $A$1 '), 'a single cell with spaces');
  eq([{ sheet: null, range: new SheetRange(0, 0, 9, 1) }], SheetRefs.areas('=$A$1:$B$10'), 'no sheet name');
  eq([{ sheet: 'Q1!Q2', range: new SheetRange(0, 0, 0, 0) }], SheetRefs.areas("'Q1!Q2'!A1"), 'a ! inside quotes');
  eq(0xffffffff, SheetColors.indexed(65), 'indexed 65');
  eq(null, SheetColors.indexed(66), 'indexed 66');
  eq(null, SheetColors.themeKey(12), 'theme 12');
  eq(null, SheetColors.rgb('auto'), 'rgb auto');
  eq(RED, SheetColors.tint(RED, 0), 'no tint');
  eq(0xffffffff, SheetColors.tint(RED, 1), 'full tint is white');
  eq(0xff000000, SheetColors.tint(RED, -1), 'full shade is black');
  eq(0.507, SheetUnits.digitEm('Calibri Light'), 'Calibri Light digits');
  eq(null, SheetUnits.digitEm('Comic Sans MS'), 'unknown font');
  eq(6, SheetUnits.digitWidth(null, 8), 'no font name');
  near(1 / 24, SheetDates.serial('01:00Z'), 1e-12, 'an hour, in UTC');
  eq(null, SheetDates.serial('2024-13-01'), 'month 13');
  eq('A1', SheetFormulas.shift('A1', 0, 0), 'not moved');
  eq('XFD1+#REF!', SheetFormulas.shift('XFC1+XFD1', 0, 1), 'off the right edge');
  eq([[], [headerRun('7 of 12')], []], SheetHeaders.parts('&P of &N', { page: 7, pages: 12 }), 'header fields');
  eq([[], [headerRun('&')], []], SheetHeaders.parts('&', fields), 'a lone &');

  // Cases worked out by the app's Kotlin code.
  for (const [value, code, d1904, maxChars, text, colour] of golden.format) {
    eq({ text, colour }, N.format(Number(value), code, { date1904: d1904 === 1, maxChars }), `golden format(${value}, ${show(code)}, ${d1904}, ${maxChars})`);
  }
  for (const [code, text, colour] of golden.text) eq({ text, colour }, N.formatText('text', code), `golden formatText(${show(code)})`);
  for (const [code, date] of golden.date) eq(date, N.isDateFormat(code), `golden isDateFormat(${show(code)})`);
  for (const [ref, cell, column, rangeOf] of golden.refs) {
    eq(cell, SheetRefs.cell(ref), `golden cell(${show(ref)})`);
    eq(column, SheetRefs.column(ref), `golden column(${show(ref)})`);
    const got = SheetRefs.range(ref);
    eq(rangeOf, got && [got.firstRow, got.firstColumn, got.lastRow, got.lastColumn], `golden range(${show(ref)})`);
  }
  for (const [formula, list] of golden.areas) {
    eq(list, SheetRefs.areas(formula).map((a) => [a.sheet, a.range.firstRow, a.range.firstColumn, a.range.lastRow, a.range.lastColumn]), `golden areas(${show(formula)})`);
  }
  for (const [formula, rows, columns, expected] of golden.shift) eq(expected, SheetFormulas.shift(formula, rows, columns), `golden shift(${show(formula)}, ${rows}, ${columns})`);
  for (const [text, expected] of golden.unescape) eq(expected, SheetStrings.unescape(text), `golden unescape(${show(text)})`);
  for (const [iso, d1904, expected] of golden.serial) eq(expected, SheetDates.serial(iso, d1904 === 1), `golden serial(${show(iso)}, ${d1904})`);
  for (const [text, expected] of golden.paper) eq(expected, SheetPaper.length(text), `golden length(${show(text)})`);
  for (const [text, expected] of golden.rgb) eq(expected, SheetColors.rgb(text), `golden rgb(${show(text)})`);
  for (const [colour, amount, expected] of golden.tint) eq(expected, SheetColors.tint(colour, Number(amount)), `golden tint(${colour.toString(16)}, ${amount})`);
  for (const [name, size, expected] of golden.digitWidth) eq(expected, SheetUnits.digitWidth(name, size), `golden digitWidth(${name}, ${size})`);
  for (const [width, digit, expected] of golden.columnPoints) eq(expected, SheetUnits.columnPoints(Number(width), digit), `golden columnPoints(${width}, ${digit})`);
  for (const [code, expected] of golden.headers) {
    const got = SheetHeaders.parts(code, { page: 7, pages: 12, sheet: 'Sheet', file: 'Book.xlsx', date: '1/2/26', time: '9:30' })
      .map((part) => part.map((x) => [x.text, x.bold, x.italic, x.underline, x.strike, x.baseline, x.size, x.font, x.color]));
    eq(expected, got, `golden parts(${show(code)})`);
  }

  return { count, failures };
}

// GOLDEN: inputs and the answers the app's Kotlin code gives for them (generated by running
// SpreadsheetNumbers.kt and Spreadsheets.kt on the inputs; values are strings so NaN and -0 survive).
const GOLDEN = {
  format: [
    ["16716.52735","General",0,11,"16716.52735",null],
    ["-0.000004242421","General",0,11,"-4.24242E-06",null],
    ["5089.085600338876","General",0,11,"5089.0856",null],
    ["-59897","General",0,11,"-59897",null],
    ["45000.75","0",1,11,"45001",null],
    ["-1e+300","0",0,11,"-1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",null],
    ["29514.43589","0",0,11,"29514",null],
    ["2957003.5","0",1,11,"2957004",null],
    ["-4000000000","0.00",0,11,"-4000000000.00",null],
    ["2014255.1","0.00",0,11,"2014255.10",null],
    ["2247000000000","0.00",0,0,"2247000000000.00",null],
    ["5345451.4","0.00",1,14,"5345451.40",null],
    ["12139.04969","#,##0",0,15,"12,139",null],
    ["-78021689.4578189","#,##0",0,20,"-78,021,689",null],
    ["0.75","#,##0",0,11,"1",null],
    ["0.020029948512092","#,##0",1,11,"0",null],
    ["5.0120433e-9","#,##0.00",0,11,"0.00",null],
    ["0.0000123456789","#,##0.00",0,11,"0.00",null],
    ["59912.57556","#,##0.00",0,11,"59,912.58",null],
    ["27460","#,##0.00",1,11,"27,460.00",null],
    ["59","\"$\"#,##0_);\\(\"$\"#,##0\\)",1,11,"$59 ",null],
    ["72477","\"$\"#,##0_);\\(\"$\"#,##0\\)",0,11,"$72,477 ",null],
    ["2957003.5","\"$\"#,##0_);\\(\"$\"#,##0\\)",0,11,"$2,957,004 ",null],
    ["73484","\"$\"#,##0_);\\(\"$\"#,##0\\)",0,11,"$73,484 ",null],
    ["0.3333333333333333","\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",0,15,"$0 ",null],
    ["-3159592.88","\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",1,11,"($3,159,593)",4294901760],
    ["-80926","\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",0,11,"($80,926)",4294901760],
    ["38921.79449","\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",1,11,"$38,922 ",null],
    ["2957004","\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",1,11,"$2,957,004.00 ",null],
    ["1.005","\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",1,11,"$1.01 ",null],
    ["-906010600000","\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",1,11,"($906,010,600,000.00)",null],
    ["3000000","\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",1,11,"$3,000,000.00 ",null],
    ["12761.97927","\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",1,11,"$12,761.98 ",null],
    ["-3942","\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",0,11,"($3,942.00)",4294901760],
    ["-2.71120019e-11","\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",0,11,"($0.00)",4294901760],
    ["1e-323","\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",0,11,"$0.00 ",null],
    ["4.0330930287e-8","0%",0,11,"0%",null],
    ["10028.45576","0%",0,-1,"1002846%",null],
    ["-6.225706e-12","0%",0,11,"-0%",null],
    ["1.9999999999","0%",1,11,"200%",null],
    ["7037829.37","0.00%",0,11,"703782937.00%",null],
    ["-4719763.08","0.00%",0,11,"-471976308.00%",null],
    ["36111","0.00%",0,11,"3611100.00%",null],
    ["-339.64759111","0.00%",0,11,"-33964.76%",null],
    ["2.372","0.00E+00",1,11,"2.37E+00",null],
    ["52245","0.00E+00",0,10,"5.22E+04",null],
    ["0.75","0.00E+00",0,11,"7.50E-01",null],
    ["9.999","0.00E+00",1,11,"1.00E+01",null],
    ["Infinity","# ?/?",0,11,"#NUM!",null],
    ["2958465.99999","# ?/?",0,11,"2958466    ",null],
    ["37526","# ?/?",0,11,"37526    ",null],
    ["-0.0001145","# ?/?",0,18,"-0    ",null],
    ["-Infinity","# ??/??",0,11,"#NUM!",null],
    ["45144.56869","# ??/??",0,11,"45144 29/51",null],
    ["298073.55","# ??/??",0,11,"298073 11/20",null],
    ["0.000007299770927056671","# ??/??",0,11,"0      ",null],
    ["2985239.87","m/d/yyyy",1,11,"###########",null],
    ["508339.21","m/d/yyyy",0,12,"10/12/3291",null],
    ["1e+300","m/d/yyyy",0,11,"###########",null],
    ["-92.49697","m/d/yyyy",0,11,"###########",null],
    ["-1859864.64","d-mmm-yy",0,11,"###########",null],
    ["19582.14486","d-mmm-yy",0,11,"11-Aug-53",null],
    ["14372.29148","d-mmm-yy",0,11,"7-May-39",null],
    ["2958466","d-mmm-yy",0,11,"###########",null],
    ["8807.00877","d-mmm",0,11,"10-Feb",null],
    ["29171.85567","d-mmm",1,11,"13-Nov",null],
    ["5e-324","d-mmm",0,11,"0-Jan",null],
    ["-6740168.71","d-mmm",1,11,"###########",null],
    ["-2.43719459e-9","mmm-yy",0,11,"###########",null],
    ["5e-324","mmm-yy",1,11,"Jan-04",null],
    ["-9092067.7","mmm-yy",0,11,"###########",null],
    ["903.43172243","mmm-yy",1,11,"Jun-06",null],
    ["0.125","h:mm AM/PM",0,11,"3:00 AM",null],
    ["-50021","h:mm AM/PM",0,-1,"#",null],
    ["2958466","h:mm AM/PM",0,11,"###########",null],
    ["33536.18167","h:mm AM/PM",1,11,"4:21 AM",null],
    ["6105.73035","h:mm:ss AM/PM",0,11,"5:31:42 PM",null],
    ["1.9999999999","h:mm:ss AM/PM",0,11,"12:00:00 AM",null],
    ["-91152","h:mm:ss AM/PM",1,7,"#######",null],
    ["1.7976931348623157e+308","h:mm:ss AM/PM",1,11,"###########",null],
    ["-18816","h:mm",0,11,"###########",null],
    ["-2857863.59","h:mm",0,11,"###########",null],
    ["16777.7354","h:mm",1,11,"17:38",null],
    ["87011287361.38","h:mm",1,11,"###########",null],
    ["3000000","h:mm:ss",0,11,"###########",null],
    ["9.999","h:mm:ss",1,11,"23:58:34",null],
    ["45556","h:mm:ss",0,11,"0:00:00",null],
    ["0.5","h:mm:ss",0,11,"12:00:00",null],
    ["-91300","m/d/yyyy h:mm",0,11,"###########",null],
    ["721113.588195294","m/d/yyyy h:mm",0,11,"5/3/3874 14:07",null],
    ["1234.5678","m/d/yyyy h:mm",0,11,"5/18/1903 13:37",null],
    ["3.141592653589793","m/d/yyyy h:mm",0,-1,"1/3/1900 3:23",null],
    ["1234.5678","#,##0_);(#,##0)",0,11,"1,235 ",null],
    ["5891385.56","#,##0_);(#,##0)",0,11,"5,891,386 ",null],
    ["-67901","#,##0_);(#,##0)",1,11,"(67,901)",null],
    ["90476","#,##0_);(#,##0)",0,11,"90,476 ",null],
    ["-3791420.94","#,##0_);[Red](#,##0)",0,3,"(3,791,421)",4294901760],
    ["0.3333333333333333","#,##0_);[Red](#,##0)",0,11,"0 ",null],
    ["82900000","#,##0_);[Red](#,##0)",0,11,"82,900,000 ",null],
    ["-1","#,##0_);[Red](#,##0)",0,11,"(1)",4294901760],
    ["-20120","#,##0.00_);(#,##0.00)",0,11,"(20,120.00)",null],
    ["0.999","#,##0.00_);(#,##0.00)",0,11,"1.00 ",null],
    ["Infinity","#,##0.00_);(#,##0.00)",0,13,"#NUM!",null],
    ["28263.35077","#,##0.00_);(#,##0.00)",0,11,"28,263.35 ",null],
    ["-35400","#,##0.00_);[Red](#,##0.00)",0,11,"(35,400.00)",4294901760],
    ["0","#,##0.00_);[Red](#,##0.00)",0,11,"0.00 ",null],
    ["1e-323","#,##0.00_);[Red](#,##0.00)",0,11,"0.00 ",null],
    ["-89010","#,##0.00_);[Red](#,##0.00)",0,7,"(89,010.00)",4294901760],
    ["-25879","_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)",0,11," (25,879)",null],
    ["86163","_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)",0,11," 86,163 ",null],
    ["0.30000000000000004","_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)",0,11," 0 ",null],
    ["-8.816324e-7","_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)",0,11," (0)",null],
    ["99999999999.5","_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)",0,11," $100,000,000,000 ",null],
    ["2958466","_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)",1,11," $2,958,466 ",null],
    ["-71816","_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)",0,11," $(71,816)",null],
    ["9.999","_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)",0,11," $10 ",null],
    ["-86847","_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)",1,11," (86,847.00)",null],
    ["-4391434.82","_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)",0,11," (4,391,434.82)",null],
    ["3.141592653589793","_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)",1,11," 3.14 ",null],
    ["28495","_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)",0,11," 28,495.00 ",null],
    ["-3200390.84","_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)",0,11," $(3,200,390.84)",null],
    ["12891.5222","_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)",0,11," $12,891.52 ",null],
    ["2957004","_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)",0,11," $2,957,004.00 ",null],
    ["54893.90179","_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)",0,11," $54,893.90 ",null],
    ["82195","mm:ss",0,11,"00:00",null],
    ["-8719894.16","mm:ss",0,11,"###########",null],
    ["1","mm:ss",0,11,"00:00",null],
    ["2443416.6","mm:ss",0,11,"24:00",null],
    ["2610","[h]:mm:ss",1,9,"62640:00:00",null],
    ["25475","[h]:mm:ss",1,11,"611400:00:00",null],
    ["97013","[h]:mm:ss",0,14,"2328312:00:00",null],
    ["-1e+300","[h]:mm:ss",0,11,"###########",null],
    ["3621038.92","mm:ss.0",0,11,"###########",null],
    ["4218924.68","mm:ss.0",0,11,"###########",null],
    ["29077.18368","mm:ss.0",0,11,"24:30.0",null],
    ["85642","mm:ss.0",0,4,"00:00.0",null],
    ["61","##0.0E+0",0,17,"61.0E+0",null],
    ["1e+300","##0.0E+0",0,5,"1.0E+300",null],
    ["12195.44068","##0.0E+0",0,11,"12.2E+3",null],
    ["45118.85917","##0.0E+0",0,11,"45.1E+3",null],
    ["12368.45265","@",0,11,"12368.45265",null],
    ["1.7976931348623157e+308","@",0,11,"1.7977E+308",null],
    ["1234.5678","@",0,11,"1234.5678",null],
    ["-6446","@",0,11,"-6446",null],
    ["16311.84015","[>=1000000]0.0,,\"M\";[>=1000]0.0,\"K\";0",0,11,"16.3K",null],
    ["Infinity","[>=1000000]0.0,,\"M\";[>=1000]0.0,\"K\";0",1,7,"#NUM!",null],
    ["3110000000000","[>=1000000]0.0,,\"M\";[>=1000]0.0,\"K\";0",0,11,"3110000.0M",null],
    ["1e-323","[>=1000000]0.0,,\"M\";[>=1000]0.0,\"K\";0",0,11,"0",null],
    ["-1","[Red][<=100]0;[Blue][>100]0",0,11,"-1",4294901760],
    ["3614000000000","[Red][<=100]0;[Blue][>100]0",0,11,"3614000000000",4278190335],
    ["1.7299471236765385","[Red][<=100]0;[Blue][>100]0",1,11,"2",4294901760],
    ["-0","[Red][<=100]0;[Blue][>100]0",0,12,"0",4294901760],
    ["0.30000000000000004","0;-0;\"zero\"",0,11,"0",null],
    ["59011.808","0;-0;\"zero\"",1,11,"59012",null],
    ["52805","0;-0;\"zero\"",1,11,"52805",null],
    ["27972.99572","0;-0;\"zero\"",0,11,"27973",null],
    ["-9807654.52","0;-0;;@",0,11,"-9807655",null],
    ["49121.58309","0;-0;;@",0,11,"49122",null],
    ["0.125","0;-0;;@",1,11,"0",null],
    ["2957003.5","0;-0;;@",0,11,"2957004",null],
    ["5080.60835",";;;",0,11,"",null],
    ["-82881713.937968",";;;",1,11,"",null],
    ["Infinity",";;;",0,11,"#NUM!",null],
    ["2.5",";;;",0,11,"",null],
    ["4929000000000","General;[Red]-General",1,11,"4.929E+12",null],
    ["-9140693.21","General;[Red]-General",1,20,"-9140693.21",4294901760],
    ["3961.98149","General;[Red]-General",0,11,"3961.98149",null],
    ["3000000","General;[Red]-General",0,11,"3000000",null],
    ["2958465.99999","# ???/???",0,11,"2958466        ",null],
    ["6555376.06","# ???/???",0,16,"6555376   3/50 ",null],
    ["-7427551.84","# ???/???",0,11,"-7427551  21/25 ",null],
    ["0.0000123456789","# ???/???",0,11,"0        ",null],
    ["49968.27486","?/?",0,11,"349778/7",null],
    ["54702","?/?",1,11,"54702/1",null],
    ["7552.74938","?/?",1,11,"30211/4",null],
    ["-102128.07","?/?",1,2,"-919153/9",null],
    ["34338.76431","# ?/16",0,11,"34338 12/16",null],
    ["41491.59133","# ?/16",0,11,"41491 9/16",null],
    ["3708276.54","# ?/16",0,11,"3708276 9/16",null],
    ["59","# ?/16",1,5,"59     ",null],
    ["52757.25786","0.0%",1,0,"5275725.8%",null],
    ["58531.69289","0.0%",0,3,"5853169.3%",null],
    ["-13578","0.0%",1,-1,"-1357800.0%",null],
    ["3.424e-8","0.0%",0,6,"0.0%",null],
    ["-8078017.82","0.000E+00",1,11,"-8.078E+06",null],
    ["4505.53334","0.000E+00",1,11,"4.506E+03",null],
    ["1","0.000E+00",1,7,"1.000E+00",null],
    ["773045.12","0.000E+00",0,11,"7.730E+05",null],
    ["7833389.28","##0.00E+0",0,11,"7.83E+6",null],
    ["-22381","##0.00E+0",0,11,"-22.38E+3",null],
    ["7491345.24","##0.00E+0",1,11,"7.49E+6",null],
    ["41543.55149","##0.00E+0",0,11,"41.54E+3",null],
    ["Infinity","###0.0E+0",0,4,"#NUM!",null],
    ["45666.94275","###0.0E+0",0,11,"4.6E+4",null],
    ["5.265e-8","###0.0E+0",0,1,"5.3E-8",null],
    ["5e-324","###0.0E+0",1,11,"4.9E-324",null],
    ["-0.69","dddd, mmmm d, yyyy",0,11,"###########",null],
    ["24023.95552","dddd, mmmm d, yyyy",0,11,"Friday, October 8, 1965",null],
    ["66978","dddd, mmmm d, yyyy",0,11,"Monday, May 17, 2083",null],
    ["-2508821.88","dddd, mmmm d, yyyy",0,11,"###########",null],
    ["7657904.81586","yyyy-mm-dd hh:mm:ss",0,2,"##",null],
    ["60","yyyy-mm-dd hh:mm:ss",1,11,"1904-03-01 00:00:00",null],
    ["-90379","yyyy-mm-dd hh:mm:ss",1,8,"########",null],
    ["NaN","yyyy-mm-dd hh:mm:ss",0,11,"#NUM!",null],
    ["0.30000000000000004","h:mm:ss.000",0,16,"7:12:00.000",null],
    ["1343","h:mm:ss.000",0,0,"0:00:00.000",null],
    ["-9825834.17","h:mm:ss.000",0,11,"###########",null],
    ["-87017","h:mm:ss.000",0,11,"###########",null],
    ["16318.83508","[h]:mm:ss.00",0,11,"391652:02:30.91",null],
    ["210442.95281172","[h]:mm:ss.00",0,20,"5050630:52:02.93",null],
    ["-37729","[h]:mm:ss.00",0,11,"###########",null],
    ["1e-310","[h]:mm:ss.00",0,11,"0:00:00.00",null],
    ["56271.13701","[<0]\"neg\";[>0]\"pos\";\"zero\"",0,11,"pos",null],
    ["52603.65141","[<0]\"neg\";[>0]\"pos\";\"zero\"",0,12,"pos",null],
    ["88266","[<0]\"neg\";[>0]\"pos\";\"zero\"",0,11,"pos",null],
    ["38018.72879","[<0]\"neg\";[>0]\"pos\";\"zero\"",0,11,"pos",null],
    ["-63000000","[>=0]0;[<0]-0",1,1,"-63000000",null],
    ["61","[>=0]0;[<0]-0",1,8,"61",null],
    ["95582","[>=0]0;[<0]-0",0,9,"95582",null],
    ["1234.5678","[>=0]0;[<0]-0",0,11,"1235",null],
    ["0.0000123456789","[>0]0;[<0]0;0",0,18,"0",null],
    ["-6972873.45","[>0]0;[<0]0;0",0,11,"6972873",null],
    ["23732.72119","[>0]0;[<0]0;0",0,11,"23733",null],
    ["-6259177.82","[>0]0;[<0]0;0",1,11,"6259178",null],
    ["2957003.5","[<=0]0;0",1,11,"2957004",null],
    ["1234.5678","[<=0]0;0",0,11,"1235",null],
    ["-59786695195000","[<=0]0;0",1,11,"59786695195000",null],
    ["1.005","[<=0]0;0",0,11,"1",null],
    ["3.141592653589793","#,###,,",0,11,"",null],
    ["20282","#,###,,",0,11,"",null],
    ["9.999","#,###,,",0,18,"",null],
    ["0.30000000000000004","#,###,,",1,11,"",null],
    ["47178.08636","$#,##0.00_);($#,##0.00)",0,11,"$47,178.09 ",null],
    ["61","$#,##0.00_);($#,##0.00)",1,11,"$61.00 ",null],
    ["6677166978","$#,##0.00_);($#,##0.00)",0,11,"$6,677,166,978.00 ",null],
    ["2791412.7","$#,##0.00_);($#,##0.00)",0,11,"$2,791,412.70 ",null],
    ["-0.001","[$\u20ac-x-sysdecimal] #,##0.00",0,10,"-\u20ac 0.00",null],
    ["20110.34891","[$\u20ac-x-sysdecimal] #,##0.00",0,11,"\u20ac 20,110.35",null],
    ["Infinity","[$\u20ac-x-sysdecimal] #,##0.00",1,11,"#NUM!",null],
    ["-71848","[$\u20ac-x-sysdecimal] #,##0.00",0,10,"-\u20ac 71,848.00",null],
    ["99999999999.5","0.0?",0,11,"99999999999.5 ",null],
    ["-8002081.43","0.0?",0,11,"-8002081.43",null],
    ["46731","0.0?",0,11,"46731.0 ",null],
    ["Infinity","0.0?",1,11,"#NUM!",null],
    ["1e-310","# ????/????",1,0,"0          ",null],
    ["-70710","# ????/????",0,11,"-70710          ",null],
    ["64229000","# ????/????",1,11,"64229000          ",null],
    ["-0.048506204737350345","# ????/????",1,11,"-  289/5958",null],
    ["-3207037.73","0%%",0,11,"-32070377300%%",null],
    ["4677698.08","0%%",1,11,"46776980800%%",null],
    ["-58834500000000","0%%",0,14,"-588345000000000000%%",null],
    ["-6.508287647739e-11","0%%",1,-1,"-0%%",null],
    ["1e+300","[<1]0.00;[<10]0.0;0",0,11,"1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",null],
    ["-0.000006","[<1]0.00;[<10]0.0;0",0,11,"-0.00",null],
    ["0.5","[<1]0.00;[<10]0.0;0",0,11,"0.50",null],
    ["638689.44","[<1]0.00;[<10]0.0;0",0,-1,"638689",null],
    ["1e+300","[=1]\"one\";[=2]\"two\";0",0,11,"1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",null],
    ["1e-300","[=1]\"one\";[=2]\"two\";0",0,11,"0",null],
    ["4371547.74","[=1]\"one\";[=2]\"two\";0",0,11,"4371548",null],
    ["99999999999.5","[=1]\"one\";[=2]\"two\";0",0,11,"100000000000",null],
    ["-48044","mmm d, yyyy h:mm AM/PM",0,11,"###########",null],
    ["-682000000","mmm d, yyyy h:mm AM/PM",0,11,"###########",null],
    ["1.2e-12","mmm d, yyyy h:mm AM/PM",0,4,"Jan 0, 1900 12:00 AM",null],
    ["2958466","mmm d, yyyy h:mm AM/PM",0,11,"###########",null],
    ["53675.67133","ddd",1,11,"Thu",null],
    ["1234.5678","ddd",0,11,"Mon",null],
    ["Infinity","ddd",0,11,"#NUM!",null],
    ["NaN","ddd",0,14,"#NUM!",null],
    ["-Infinity","mmmmm-yy",1,11,"#NUM!",null],
    ["1321578000","mmmmm-yy",1,11,"###########",null],
    ["0.75","mmmmm-yy",1,11,"J-04",null],
    ["51754.84129","mmmmm-yy",0,11,"S-41",null],
    ["2958466","[ss].00",0,11,"###########",null],
    ["13939.07078","[ss].00",0,11,"1204335715.39",null],
    ["5.27e-12","[ss].00",0,1,"00.00",null],
    ["NaN","[ss].00",0,13,"#NUM!",null],
    ["-8193","e",0,11,"-e",null],
    ["57163.33518","e",0,11,"e",null],
    ["-8526000000","e",0,11,"-e",null],
    ["9.999","e",0,11,"e",null],
    ["9.7","yyyy\" years\"",0,12,"1900 years",null],
    ["-30891","yyyy\" years\"",0,11,"###########",null],
    ["0.5","yyyy\" years\"",0,11,"1900 years",null],
    ["2.5","yyyy\" years\"",0,11,"1900 years",null],
    ["55488.36971","[>=1e3][=x]:[>=1e3]/16[dddd",0,15,"55488.36971",null],
    ["-1e+300","mmm",0,-1,"#",null],
    ["-472810840","e[Red]*;",0,11,"-e",4294901760],
    ["42238.90676","[=0][<=0]/mmmmmmdy)$",0,8,"42238.91",null],
    ["2.5","[h][BLUE]",0,11,"60",4278190335],
    ["5403102.51"," ",0,11,"5403102.51",null],
    ["47918","\\-",0,5,"-",null],
    ["8343.49693","am/pm_)mmm",0,4,"AM Nov",null],
    ["2957004"," [mm]*-/[=x]ddmmmmmg",0,11," 4258085760/31D",null],
    ["17801","[<>5][<=0][BLUE].000",1,11,"17801",null],
    ["4456.04989",".000dddd/",0,11,".000Wednesday/",null],
    ["-53013","B",0,11,"-B",null],
    ["NaN","[>=1e3][=x].00*-[>=100]ddd:mmm",0,11,"#NUM!",null],
    ["5652","[<0][>0]y00",0,11,"1500",null],
    ["-3064916.71","\"x\"smmmm[",0,8,"-3064917",null],
    ["2922764.7","mmmmmmmmmmmm.h$/8%",0,11,"April.16$/8%",null],
    ["59","mh[ss]*E+",0,11,"205097600+",null],
    ["46895.02783","hhGeneral\"kg\"",0,11,"002028n2028ralkg",null],
    ["9.57323937676847e-10","E+\"x\"\\",1,11,"E+x",null],
    ["44449","*-mmyyyy#[h]/8dddddd",1,13,"092025#1066776/8Thursday",null],
    ["0.0445","(]]mmmmmm$[$\u20ac-x-euro2]General",1,11,"(]]January$\u20ac1904n1904ral",null],
    ["1234.5678","e-",0,8,"e-",null],
    ["0.000359411938116","*[Color10];[=0]",0,11,"Color10]",null],
    ["4830370.33",")Generald;[BLUE]\\/16",1,14,"##############",null],
    ["-4.96e-10","dd[>0]m",0,11,"-4.96E-10",null],
    ["3452.05489","?\\-_)#,##0",0,11," - 3,452",null],
    ["1.005","g.d/8yy,e[=0]",0,7,"1.005",null],
    ["-0.000045243883","_[$\u20b9-4009]mmmmm\\[Color10]",0,11,"###########",null],
    ["-87648","\\-_)GeneralGeneral#,##0",0,11,"-- 87648",null],
    ["5.29153e-11","# ddE+",0,11,"# 001900+",null],
    ["33723","[Color10]\ud83d\ude00\\-\\AM/PM0.00%",1,12,"\ud83d\ude00-A4/P40.00%",4278222848],
    ["2957004",";d[hh][$\u20ac-x-euro2]",0,11,"",null],
    ["43877.93432",",",0,11,"",null],
    ["60",":[_",0,11,"60",null],
    ["-3705859","mmmyy*",0,11,"###########",null],
    ["24465.72906","[<>5]00d%s[$-409]",1,11,"0025%51",null],
    ["-52896","[Red]/8.00",0,11,"-/852896.00",4294901760],
    ["35518","[<>5]/8;/8mmmm\\-\\",0,11,"/8",null],
    ["1.005","*-",0,11,"",null],
    ["0","00.00\"kg\"",0,11,"00.00kg",null],
    ["1e-310","[>=100]\"kg\"\"kg\"00B$\\",1,11,"1E-310",null],
    ["67592",",",0,11,"",null],
    ["12070.85616","[<>5][.0_hh",1,11,"12070.85616",null],
    ["2958465.99999","*[>=1e3].A/P[$\u20ac-x-euro2]/16/8$",0,8,">=1e3]2958466.A/P\u20ac/16/8$",null],
    ["0.999","e-",1,0,"e-",null],
    ["-4396780.07","[BLUE]Generalmmmmm.000AM/PM",0,4,"####",4278190335],
    ["-2142110746.353865","Generale-??/",0,11,"-2142110746e-/",null],
    ["2958465.99999","@[=x]",0,11,"2958466",null],
    ["57689","he[<>5]hh)A/Py",0,-1,"12205712)A57",null],
    ["-2323527.9",")[<=0]gmmmmm/8B",1,11,")A/8B",null],
    ["-0.00000369482302","[<=0],mmmmmmmm",0,11,",January",null],
    ["9405","yyyy:",0,11,"1925:",null],
    ["-0.001","??hhBmm[<=0][Color60][Color60]mmmm",0,11,"??00B01January",null],
    ["8570234.46","*-.00[mm]gdd(;[<>5]",0,11,"###########",null],
    ["28990.097623318","am/pm",0,18,"AM",null],
    ["9730783.69","#,##0dddd*-;",0,11,"###########",null],
    ["2931","[Color60][=0]##_[$\u20b9-4009]mmm",1,11,"2931",null],
    ["2957004","[=x]ssddd",0,9,"00Sun",null],
    ["8284.85811",".0000.00hh*[<>5] .000[mm]",0,11,".0000.0020<>5] .00011930195",null],
    ["-1","[hh]mmmmmm\"kg\"d",0,11,"###########",null],
    ["0.30000000000000004","AM/PM\\-am/pm",0,11,"AM-AM",null],
    ["1234.5678","[$-409][$\u20ac-x-euro2]",0,11,"\u20ac",null],
    ["2957004","(0ham/pm[mm]",0,11,"(012AM4258085760",null],
    ["-9256518.72","e",0,11,"-e",null],
    ["50863.00654","[Red][$\u20ac-x-euro2]mmmm\"x\"e[>=1e3]\ud83d\ude00\"",0,11,"50863.00654",null],
    ["32788.77782","[>0]g\u2030",1,11,"g\u2030",null],
    ["20317.81498","d[",0,10,"20317.815",null],
    ["35702.78437","\ud83d\ude0000[$-409]a/pdddd##A/P",0,11,"\ud83d\ude0000pMonday##P",null],
    ["NaN","[$\u20ac-x-euro2].0.*-mmmmmm0##",0,2,"#NUM!",null],
    ["-832987563680","E+BE+",0,11,"-E+BE+",null],
    ["-2.331145042553544e-9","$ddddm][Red].00yyyyddd",0,11,"###########",4294901760],
    ["4246.38713","[<>5]m0E+",0,11,"801911+",null],
    ["0.3333333333333333","#,##0edddd[ss]00dd[>0]##",0,11,"#,##01900Saturday288000000##",null],
    ["9371421.91","yyyy\"x\"hh( ",0,11,"###########",null],
    ["-0.004","_)[<0].mmmmmm\"?",0,2,"-4E-03",null],
    ["12869.22772","mmB_)yydmm[mm][BLUE]",0,11,"03B 35260318531687",4278190335],
    ["0.00001736111111111111","_00\ud83d\ude00AM/PMA/P",0,-1," 0\ud83d\ude00AMA",null],
    ["42965","#mmmmm[$-409]ssmmmmmss##[ss]",0,11,"#A00A00##3712176000",null],
    ["-81739","hh[Color10]??am/pmdddh]",0,11,"###########",4278222848],
    ["36020","*-e-[>=100]",1,11,"e-",null],
    ["1.005","?[ss].0",1,11,"?86832.0",null],
    ["-0.0000508417781","mmmmA/Pss.0",0,13,"#############",null],
    ["-6710789.3","[$\u20b9-4009]yyyy",0,0,"#",null],
    ["0.3333333333333333","@[<0]-am/pm",0,11,"0.333333333",null],
    ["4215153.95","[gddd\\AM/PM?",0,11,"4215153.95",null],
    ["438096835000","  [Color60]:",0,11,"  :",null],
    ["8.76497352961451e-10","[h]mmmmmm00s#,##0[Red][\"kg\"",0,11,"8.76497E-10",null],
    ["Infinity","@",0,11,"#NUM!",null],
    ["2.58985e-11","[ss]AM/PM.00dddmm00",1,11,"00AM.00Fri0100",null],
    ["-Infinity","syyyy-0.00[<0]_e-",0,11,"#NUM!",null],
    ["54035.4397","mm",0,11,"12",null],
    ["3000000","/16[<0]\u2030[h]",1,11,"3000000",null],
    ["-83902","ss[Red]",0,11,"###########",4294901760],
    ["43447.28497","(.00",0,3,"(43447.28",null],
    ["8654.96905","[",0,11,"8654.96905",null],
    ["41459.41312","[Color60]??[$\u20ac-x-euro2]",1,11,"41459\u20ac",null],
    ["61","[>=100][hh]g*",0,11,"61",null],
    ["51801.14203","\ud83d\ude00/[<=0]]",0,11,"51801.14203",null],
    ["-5346469.12","[$-409]m?",0,11,"###########",null],
    ["2957003.5","y\\[Red][>0]:[$\u20ac-x-euro2]",0,2,"95[R999530]:\u20ac",null],
    ["84.5","ssy\";\\-[<>5]#/8",1,11,"84.5",null],
    ["4923612671","mmmyy[>0][<>5]hhmmm",0,13,"#############",null],
    ["36905.56036","[<>5]d",0,11,"14",null],
    ["7887.80846","\u2030",0,11,"\u2030",null],
    ["-Infinity","00\ud83d\ude00hh",1,11,"#NUM!",null],
    ["Infinity","/16hh",0,11,"#NUM!",null],
    ["-94029","e[BLUE]B",0,12,"-eB",4278190335],
    ["2958466",".000a/pddd",0,15,"###############",null],
    ["1.005","mmmmm*-",0,11,"J",null],
    ["28561.97933",".00[>=1e3]mmmmm[>=1e3][$\u20b9-4009][>0]B",0,5,".00M\u20b9B",null],
    ["-60023","[>0]\"kg\"mmmmeg\u2030[$\u20ac-x-euro2]",0,11,"-60023",null],
    ["1","%mmma/pdd\\-0.00[<0].000",0,11,"1",null],
    ["NaN","[$-409]d",0,11,"#NUM!",null],
    ["3000000","[E+[<=0][ss]e-\u2030",0,11,"###########",null],
    ["3290782.56","##[=x]a/p",0,11,"3290783a/p",null],
    ["-9785341.69","AM/PM_).\\-",0,0,"#",null],
    ["-3890720.44","[BLUE];\"[=x]",1,16,"-3890720.44",null],
    ["1234.5678","[>0]",0,14,"",null],
    ["30146.98103","[ss][>0]\"x\"\u2030mmm",1,11,"2604699161x\u2030Jul",null],
    ["5e-324","mmm",0,11,"Jan",null],
    ["-23201","y[Red][Color10][$\u20ac-x-euro2]##sa/pyy",0,2,"##",4278222848],
    ["60","h(hhe-mm.",0,11,"0(001900-02.",null],
    ["-2286073.24","ddd_)$-/[<=0]",0,10,"Fri $-/",null],
    ["87610","e\\-yyyyddd@",1,12,"87610",null],
    ["1.9999999999","[<=0][Color60]mmmmmm[ss][Color60]\\yy[>=1e3]",0,11,"2",null],
    ["818815.91","\\-\"E+h[=x]",0,11,"818815.91",null],
    ["1234.5678","[>=100]\"kg\"[BLUE]0.000[Color60] [Color10]",1,1,"kg1234.568 ",4278222848],
    ["-24149","[<0].000",0,11,"24149.000",null],
    ["2958466",".0AM/PM[$\u20b9-4009]ddd[=x]\"[mm]",0,11,"2958466",null],
    ["0.0000123456789","[>0]ddd.00@mmmmm",1,3,"1E-05",null],
    ["0.00001736111111111111","a/p[<>5]\"dBe",1,11,"1.73611E-05",null],
    ["-1e+300","$",1,11,"-$",null],
    ["3000000","[$\u20ac-x-euro2]#,##0[yy/16.000",0,11,"3000000",null],
    ["1.005","dddyyyy[>=100]/8[=x]00[hh]mmmm",1,5,"1.005",null],
    ["0",")$gg[<0]e-",1,11,"0",null],
    ["45000.75","([$-409]yy",1,11,"(27",null],
    ["45000.75","E+dddd_",0,0,"2023+Wednesday ",null],
    ["50045.85001","[Color60].00@[h][$\u20b9-4009][Color60]00%",0,1,"5E+04",null],
    ["2957004",",[mm][=x]a/p",0,18,",4258085760a",null],
    ["-92445","_)",1,7,"- ",null],
    ["83335","\\-\\-[BLUE]]e-",0,11,"--]e-",4278190335],
    ["59527.88518","mmmmss\"am/pm#,##0m",0,11,"59527.88518",null],
    ["-9900","h[$\u20ac-x-euro2]gmmmm[=0]_)[<>5][$-409]",0,11,"###########",null],
    ["NaN","0##[Color60]",1,11,"#NUM!",null],
    ["0.5","[<0]#,##0[h][$\u20b9-4009])[<0]hh:",0,11,"0.5",null],
    ["-3.9866415e-13","B%??[$\u20ac-x-euro2][$\u20b9-4009][$-409](",1,11,"-B%  \u20ac\u20b9(",null],
    ["-13514","[>0]#,##0s*-#d",0,1,"-1E+04",null],
    ["3.141592653589793","/8ss[h]hh",0,11,"/8547503",null],
    ["1234.5678","[h]yy0[<=0]yyyy\"kg\"\"kg\"",0,4,"1235",null],
    ["199665.053747594","[<0]",0,11,"199665.0537",null],
    ["6712558.37","[<0]yy)mm*\"",0,11,"6712558.37",null],
    ["1234.5678","%",0,4,"%",null],
    ["1e-300",";\\-eyyyy[\"x\"",0,14,"1E-300",null],
    ["9.621e-10","[h]:E+/16B\\-:[hh]",0,11,"0:1900+/16B-:00",null],
    ["1234.5678","/8am/pm%-eGeneral[<>5];",0,11,"/8PM%-19031903n1903ral",null],
    ["28834","e-*/8\"x\"",0,11,"e-8x",null],
    ["-1197727.71","h",0,11,"###########",null],
    ["0.002507770089432597","[ss].mmmm\ud83d\ude00[Color10]%_)",1,14,"217.January\ud83d\ude00% ",4278222848],
    ["86597",".00.00.E+e-[$\u20ac-x-euro2]\\-$",0,11,"86597.00.00.E+e-\u20ac-$",null],
    ["-1","[mm]00m_)#,##0",0,11,"###########",null],
    ["-9790112.84","_)yy]$??[<0]",1,11,"###########",null],
    ["-6670865.37","ssm .e--",0,1,"#",null],
    ["2.310797e-11","ha/p",0,11,"12a",null],
    ["-8436278.82","m[hh]",1,20,"####################",null],
    ["0.0116564320400357","[<=0]ddd",0,2,"1E-02",null],
    ["-2.4",",dd\\[>=100]\\",0,11,"###########",null],
    ["-29017","0E+[$-409]/16[ss]",0,11,"###########",null],
    ["1e-310","[$\u20b9-4009]#mmmmmmmmmmmmmm.000",0,11,"\u20b9#January.000",null],
    ["16889","/??",0,11,"/16889",null],
    ["-43593","%E+\"x\"[<=0]",0,11,"%E+x",null],
    ["Infinity",":.000.00\\0.00",0,11,"#NUM!",null],
    ["NaN","ddd_)?[hh][<>5]\u2030hhe",0,11,"#NUM!",null],
    ["31894.14631","[>=1e3]??\\",1,11,"31894",null],
    ["-1","[$\u20b9-4009]E+*-[mm]\"x\"@mmmm",0,11,"-1",null],
    ["53741.00899",";mmmmmm[Color60]y[BLUE]d$[>=100]",0,-1,"",null],
    ["28558.17502","[h]",1,16,"685396",null],
    ["-72408","*-00dde[mm]",0,11,"###########",null],
    ["17804","ddd/8_)_).0",0,11,"Tue/8  .0",null],
    ["572293.33","A/Pyyss\\ddd",0,11,"A6612d18",null],
    ["6029343.93","mmmmm[<>5][>0]mm",1,11,"###########",null],
    ["57227.64813","[Red]B_)",0,11,"B ",4294901760],
    ["-68969","[$\u20ac-x-euro2][<0]y0*\\_/",1,11,"\u20ac920 ",null],
    ["0.00001736111111111111","E+B-.000??",0,11,"E+B-.00002",null],
    ["-90178","mmmmm[$-409]_)*yyyy",1,11,"###########",null],
    ["57347.89674","\u2030[>0]]\"kg\"[BLUE]",0,11,"\u2030]kg",4278190335],
    ["-Infinity","\"x\"E+[>=100]ss?[Red]",0,11,"#NUM!",null],
    ["30889.71702","ddd",0,14,"Thu",null],
    ["0.999","[ss]_).00",0,15,"86314 .00",null],
    ["-0.00008125","m[Color60]\"[<=0]\"x\"%00",0,11,"-0.00008125",null],
    ["7548918.19","\"[$-409]ddd??",0,11,"7548918.19",null],
    ["8598847.6",",",0,11,"",null],
    ["6323732.31",")[ss]]y###",0,9,"#########",null],
    ["60","[h]_",0,11,"1440 ",null],
    ["42110.09606","[Red]*[>0][>=100]",1,11,">42110]",4294901760],
    ["903.9751049131155","\"kg\"",0,12,"kg",null],
    ["1.7976931348623157e+308","[ss][Red]_)",0,11,"###########",4294901760],
    ["273431.154433638","\"kg\"e- ]\ud83d\ude00_)hh\\",1,14,"kg2652- ]\ud83d\ude00 03",null],
    ["90910","00E+mmmmmm-mmmmmm[Color60]",1,11,"002152+November-November",null],
    ["-46307","mm",1,0,"#",null],
    ["28369.36216","00\ud83d\ude00",0,17,"28369\ud83d\ude00",null],
    ["-67122","*-)",0,11,"-)",null],
    ["34657","[<0][[<>5]/8",0,11,"34657",null],
    ["5e-324","??[BLUE]?AM/PMam/pm",1,11,"???AMAM",4278190335],
    ["3000000","_);(",0,11," ",null],
    ["-1",".000y[Color60]",0,11,"###########",null],
    ["0.3333333333333333","/16ddmmmmmmmmmm##)\\-/8",1,11,"/1601January##)-/8",null],
    ["0.00001736111111111111","mmmm;",0,11,"January",null],
    ["-3462668.05","y[Color60]-dBa/p",0,11,"###########",null],
    ["99999999999.5","[$\u20b9-4009][Red]-)[<=0]dam/pm",0,11,"1E+11",null],
    ["9.999","yyyyd;",0,13,"19009",null],
    ["5e-324","//1600yyyy",0,2,"//16001900",null],
    ["2957004","*-?",0,11,"2957004",null],
    ["-73230",")B.\\-",0,11,"-)B73230.-",null],
    ["-26010","m\\m#,##0\ud83d\ude00\"x\"ss",0,11,"###########",null],
    ["-56395","[$-409]##dd",0,5,"#####",null],
    ["-0","[hh]yyyym",1,11,"0019041",null],
    ["31918.27906","$mmmm?e-/16",1,11,"$May?1991-/16",null],
    ["23660","[=x]@*-[$\u20b9-4009]##",0,11,"23660",null],
    ["-661400000000","[=0]:00",0,11,"-6.614E+11",null],
    ["2.5","/16A/P_ss",0,20,"/16P 0",null],
    ["0.30000000000000004","e[h]hh[[mmmmE+",1,0,"3E-01",null],
    ["-40269","h",0,19,"###################",null],
    ["1.74e-13","mm*-:)[=x]",0,11,"01:)",null],
    ["17684.95011","/ss#,##0dGeneral_)",1,0,"/10#,##011952n1952ral ",null],
    ["-42493","GeneraldddBg",0,11,"###########",null],
    ["39077.18781","\\-[hh]\"kg\"0/16",0,11,"-937852kg0/16",null],
    ["47465.02559","[>0][Color10]@ddddddd?E+",1,11,"47465.02559",null],
    ["-6.89046e-14","00[mm]*/16??mmm",0,11,"###########",null],
    ["-9.36598675325513e-9","??hh [<=0]",0,11,"??00 ",null],
    ["-535266.73","[$\u20b9-4009],",1,17,"-\u20b9,",null],
    ["-Infinity","/8[mm]",0,11,"#NUM!",null],
    ["-Infinity",".ss[$\u20ac-x-euro2][<>5]",0,11,"#NUM!",null],
    ["1732086.99","ydddd[$-409]a/p[>=1e3]ddd-\"",0,11,"1732086.99",null],
    ["58746",":#,##0,??[=x]",0,11,":58,746",null],
    ["-36085","[BLUE][<>5][<>5].00e",0,13,"-36085.00e",4278190335],
    ["-7161",")$[$\u20b9-4009][mm]/.000\"[Color10]",1,11,"-7161",null],
    ["60",",",1,19,"",null],
    ["1.7976931348623157e+308","ddm[$\u20ac-x-euro2].00-y",0,11,"###########",null],
    ["87828680127.85912","ss",0,18,"##################",null],
    ["7848","[=x]\\\"x\"ss",1,1,"8E+03",null],
    ["3000000"," sy[BLUE][=0]",1,11,"3000000",null],
    ["-0.0000033","ss[$\u20b9-4009]",0,10,"##########",null],
    ["2957003.5","\u2030.000$_[>0]yyyy[>0]E+",0,11,"\u2030.000$ >0]99959995+",null],
    ["2303.56994","ddd[<=0]h",0,11,"2303.56994",null],
    ["-5420567.02","\"kg\"[$\u20b9-4009])##*",0,0,"-kg\u20b9)5420567",null],
    ["6536.63304",".[BLUE][<>5][mmmm[=0]",0,11,"6537.",4278190335],
    ["53217","[Color60]0[h]\"kg\"mm",0,11,"01277208kg00",null],
    ["1426","[/16[.00a/pmmmam/pmhh",0,6,"1426",null],
    ["-1","/8[<=0]am/pmh",0,11,"/8AM12",null],
    ["32969.27045","mme(",0,11,"041990(",null],
    ["19673.16894","[BLUE]",0,11,"",4278190335],
    ["0.3333333333333333","d\\/8gGeneral[<0]",0,11,"0.333333333",null],
    ["-4593","[h]ss\"x\"BB##",1,11,"###########",null],
    ["99999999999.5","[$\u20b9-4009]",1,11,"\u20b9",null],
    ["-0.00628666","/8[>=1e3]",0,11,"-0.00628666",null],
    ["-5.968397231773e-7",".00.0000.00",0,11,"-.00.0000.60",null],
    ["5e-324","[>=1e3];yy\\-Bg[Color60]-",0,11,"00-B-",null],
    ["9.471e-11","\\[$\u20ac-x-euro2]*-[hh]y0.00AM/PM",1,0,"[$\u20ac-x-1904uro2]00040.00AM",null],
    ["45000.75","g",0,19,"g",null],
    ["2958465.99999","__)[>=100][<=0]",0,8,"2958466",null],
  ],
  text: [
    ["_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)"," text ",null],
    ["_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)"," text ",null],
    ["_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)"," text ",null],
    ["_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)"," text ",null],
    ["@","text",null],
    ["0;-0;;@","text",null],
    [";;;","",null],
    ["*-*[<=0]\u2030mmmmmm","text",null],
    [":Byyyy\ud83d\ude00[ss][ss]","text",null],
    ["]","text",null],
    ["[=0][Red]","text",null],
    ["(A/P]-A/Pd","text",null],
    ["\"x\"AM/PM[h]","text",null],
    ["g[Color10]m00e","text",null],
    [".0@",".0text",null],
    ["am/pm[Color60][h]","text",null],
    ["*)\\","text",null],
    ["[","text",null],
    ["s[=x]y\\","text",null],
    ["[$\u20b9-4009][ss]","text",null],
    ["[Color10]","text",null],
    ["dddh#[hh]ddddGeneral","text",null],
    [".","text",null],
    ["[Color60]AM/PM","text",null],
    ["\\ssBm0)mmmmm","text",null],
    ["[a/p.000","text",null],
    ["d[mmmm[=x]","text",null],
    ["[<=0]0.00","text",null],
    ["[Color60][>=100]-[>0]\ud83d\ude00.\ud83d\ude00ss","text",null],
    ["B[>=1e3]B","text",null],
    ["[hh]","text",null],
    ["[>=100]ddd","text",null],
    ["Generalm/8\u2030","text",null],
    ["h\\","text",null],
    ["[ss]","text",null],
    ["##%A/P(\u2030[BLUE]","text",null],
    ["A/P\"%","text",null],
    ["[$\u20ac-x-euro2]-_.[hh]?[Red]h","text",null],
    ["[=x]s","text",null],
    ["[*$yy[<>5][=0]","text",null],
    ["\"x\"]#,##0[=x]","text",null],
    ["/\\A/P#:dddd","text",null],
    ["mmm-mmmmmm","text",null],
    ["s","text",null],
    ["yyyyd[=x]-","text",null],
    ["[<>5]mmmmmhE+.0mmmmm_[mm]","text",null],
    ["[Red]ddd\"x\"\\-$-#ss","text",null],
    ["A/P\\","text",null],
    ["[Color10]","text",null],
    [".0@0.00A/PE+$/??",".0text0.00A/PE+$/??",null],
    ["ddd#,##0","text",null],
    ["[[ss]","text",null],
    ["am/pm??\"x\"yyyyyy%g","text",null],
    ["s[Color60][[h]$AM/PM@","s$AM/PMtext",null],
    [".0ddd,mmmmmh@",".0ddd,mmmmmhtext",null],
    [",mmmmA/P#,##0","text",null],
    ["#,##0","text",null],
    ["[<0]/8","text",null],
    ["??","text",null],
    ["\u2030","text",null],
    ["yyyy\u2030Generalg$yy@General","yyyy\u2030Generalg$yytextGeneral",null],
    ["00(ddd-","text",null],
    ["-\"x\"","text",null],
    ["##A/P.00","text",null],
    [":0General\\-[<=0]ddd","text",null],
    ["mmmmmm","text",null],
    ["?","text",null],
  ],
  date: [
    ["General",false],
    ["0",false],
    ["0.00",false],
    ["#,##0",false],
    ["#,##0.00",false],
    ["\"$\"#,##0_);\\(\"$\"#,##0\\)",false],
    ["\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",false],
    ["\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",false],
    ["\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",false],
    ["0%",false],
    ["0.00%",false],
    ["0.00E+00",false],
    ["# ?/?",false],
    ["# ??/??",false],
    ["m/d/yyyy",true],
    ["d-mmm-yy",true],
    ["d-mmm",true],
    ["mmm-yy",true],
    ["h:mm AM/PM",true],
    ["h:mm:ss AM/PM",true],
    ["h:mm",true],
    ["h:mm:ss",true],
    ["m/d/yyyy h:mm",true],
    ["#,##0_);(#,##0)",false],
    ["#,##0_);[Red](#,##0)",false],
    ["#,##0.00_);(#,##0.00)",false],
    ["#,##0.00_);[Red](#,##0.00)",false],
    ["_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)",false],
    ["_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)",false],
    ["_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)",false],
    ["_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)",false],
    ["mm:ss",true],
    ["[h]:mm:ss",true],
    ["mm:ss.0",true],
    ["##0.0E+0",false],
    ["@",false],
    ["[>=1000000]0.0,,\"M\";[>=1000]0.0,\"K\";0",false],
    ["[Red][<=100]0;[Blue][>100]0",false],
    ["0;-0;\"zero\"",false],
    ["0;-0;;@",false],
    ["d??dd",true],
    ["##%/ss[h]g[<0]",true],
    ["00m[>=1e3]@dd",false],
    ["##][>=1e3]",false],
    ["mmmm*mddd/8",true],
    [".00[$\u20ac-x-euro2]",false],
    ["[<=0](\"x\"mm0e",true],
    ["[Red]a/p$[h]mmm",true],
    ["A/Pe-dddyym:sAM/PM",true],
    ["-General",false],
    ["smmmm_)[Color60]",true],
    ["*A/Pddddy%E+",true],
    ["e##mm",true],
    ["0.00\\@[$\u20ac-x-euro2]",false],
    ["am/pm[Color60]??mA/P",true],
    ["[>0][BLUE]\"x\"",false],
    ["\\[Color60]",false],
    ["ssGeneral",true],
    ["\u2030];a/p",false],
    ["??\"/16",false],
    ["h[ss]*[Color10]hhmmmmdddh",true],
    ["[<>5]s#,##0[$\u20b9-4009]",true],
    [";.\"[>=100]*;\"kg\"##",false],
    ["/16[:,mmmmmm[Color10]",false],
    ["h[<0]m[=0]_)",true],
    ["\ud83d\ude00[h][<=0]\"kg\"mmmmmmss",true],
    [".000y[mm[Color10]",true],
    ["%\\[>0]e-[<0]\"kg\"00",false],
    ["e-/8A/P#\"kg\"\ud83d\ude00e",false],
    ["[<0][Red]",false],
    ["d0.00.0##[hh]:;",true],
    [".*--yyyyyy",true],
    ["[<0]sB/8#@e-",false],
    ["[>=100][$\u20ac-x-euro2][Color60]",false],
    ["\\d[mm]",true],
    ["A/P\\-[Color10]-??;ddd?",true],
    ["gB:[ss]##",true],
    ["[h]",true],
    ["\\.00;[_)",false],
    ["[Color60]mmmmmmy*[<>5]yyyy]mmmmmm",true],
    [";",false],
    ["[mm][ss]\\-[ss]\"kg\"[<>5]",true],
    [".000a/p[$\u20b9-4009]\\-",false],
    ["@AM/PM.000dss",false],
    ["\"s)[<0]",false],
    ["General#,##0mmm.000[hh]h",true],
    ["$\":am/pmmmmmmm",false],
    ["[BLUE].000.00-B",false],
    ["[>=1e3]([Red].000",false],
    ["(.0:hh[BLUE]mmm[=x][Color10]",true],
    ["yye-dddd m\u2030",true],
    ["g_",false],
    ["_ss",true],
    ["ss/:00?\"kg\"#,##0General",true],
    ["mmmmmmmmmmm",true],
    ["\u2030[Color10]ddd/16\\hh",true],
    ["mmmmyyyy;[<=0][$\u20b9-4009]\ud83d\ude00AM/PM",true],
    ["[=0][Color60]\\\\\u203000",false],
    ["AM/PMmmmmmmBGeneral",true],
    ["[$-409][ss]0.00mm)ss[<0],",true],
    ["\\[",false],
    ["\\-[<0]",false],
    ["/\"x\";",false],
    ["@[Color10]",false],
    ["AM/PMss%@[$\u20b9-4009]mm$",false],
    ["dddd_)E+0.00\"kg\"[BLUE][$\u20b9-4009]#",true],
    ["[h][$\u20ac-x-euro2]yyyy\u2030$??",true],
    ["m",true],
    [",mmmm",true],
    ["General",false],
    ["#,am/pm[<0][Red]E+",true],
    ["mmmmm)",true],
    ["\"x\"[$-409][Red]]*-",false],
    ["[BLUE]*??/[>=100]yyyy[>0]",true],
    ["$E+\ud83d\ude00[>=1e3]##[$\u20b9-4009]",false],
    ["A/P\"x\":/16(#[$\u20b9-4009]",false],
    ["[>=1e3]mmmmmm[Color10][BLUE]\"\\-",false],
    ["B;dss",true],
    ["##",false],
    ["##",false],
  ],
  refs: [
    ["+AAAA",null,null,null],
    ["a",null,0,null],
    ["$A+",null,null,null],
    [":",null,null,null],
    ["19",null,null,null],
    ["1104857601",null,null,null],
    ["0XFD$- ",null,null,null],
    ["$:Z:A",null,null,null],
    ["XFEXFD\u0663$1048576",null,null,null],
    ["0Z\u0663",null,null,null],
    ["10485761",null,null,null],
    ["B",null,1,null],
    ["1B-",null,null,null],
    [" AAAAAAAA",null,null,null],
    ["XFE 10485770",null,null,null],
    ["Z0",null,null,null],
    ["0XFE+1048577",null,null,null],
    ["AAAA#REF!AAAA-a",null,null,null],
    ["Z+a1",null,null,null],
    ["1048577$",null,null,null],
    ["1048576+009",null,null,null],
    ["1048576",null,null,null],
    ["+Z",null,null,null],
    ["aA1048577XFE",null,null,null],
    ["1048576#REF!:",null,null,null],
    ["XFDa1",null,null,null],
    ["BAAAA\u0663ZB",null,null,null],
    [":",null,null,null],
    ["AAAA",null,null,null],
    ["1",null,null,null],
    ["XFD#REF!",null,null,null],
    ["1048577",null,null,null],
    ["1048576-1XFE",null,null,null],
    ["104857710485769",null,null,null],
    ["AAAA:0$",null,null,null],
    ["AAAA#REF!Z$",null,null,null],
    [": XFD",null,null,null],
    ["\u066311048577\u0663",null,null,null],
    ["XFE900",null,null,null],
    ["1XFDA\u0663:",null,null,null],
    ["A01048577",null,null,null],
    ["1048577+1048576",null,null,null],
    ["+1-#REF!",null,null,null],
    [" 9+-",null,null,null],
    ["\u06631048577$#REF!0",null,null,null],
    [" +",null,null,null],
    ["9+XFE",null,null,null],
    ["AAAA0",null,null,null],
    ["1XFE0",null,null,null],
    [" $9",null,null,null],
    [" XFDAAAA",null,null,null],
    ["Z1048576",1099510579225,null,[1048575,25,1048575,25]],
    ["+a\u06639#REF!",null,null,null],
    [" A10485761048577-",null,null,null],
    ["A",null,0,null],
    ["\u0663-\u0663",null,null,null],
    ["+a#REF!1048576",null,null,null],
    ["1048576",null,null,null],
    ["B#REF!\u06631-",null,null,null],
    ["$",null,null,null],
    ["B ",null,null,null],
    [" 0a1048577",null,null,null],
    ["#REF!",null,null,null],
    ["+ AAAA\u0663",null,null,null],
    ["9",null,null,null],
    [" 01048577",null,null,null],
    ["\u0663-",null,null,null],
    ["AAAA",null,null,null],
    ["+AAAA +",null,null,null],
    ["A",null,0,null],
    ["1048577XFD a",null,null,null],
    [":",null,null,null],
    ["$10485760",null,null,null],
    ["1XFD ",null,null,null],
    ["$1048577",null,null,null],
    ["$ ",null,null,null],
    [" XFD9+ ",null,null,null],
    ["1048576\u0663XFD\u0663B",null,null,null],
    ["\u0663",null,null,null],
    ["\u06631048576 XFD",null,null,null],
    ["Z-",null,null,null],
    ["Z",null,25,null],
    [" ",null,null,null],
    ["A1048576-",null,null,null],
    ["9A",null,null,null],
    ["1\u06631048576",null,null,null],
    ["a$",null,null,null],
    ["1",null,null,null],
    ["1AAAA",null,null,null],
    ["-+910485771",null,null,null],
    ["$:",null,null,null],
    [":A",null,null,null],
    [" -",null,null,null],
    ["-\u0663#REF!B",null,null,null],
    [" ",null,null,null],
    ["9:$",null,null,null],
    ["#REF!0 ",null,null,null],
    ["+",null,null,null],
    ["1048577",null,null,null],
    ["AAAA",null,null,null],
    ["-",null,null,null],
    [" 9",null,null,null],
    ["9B+",null,null,null],
    ["+:",null,null,null],
    ["XFDAAAAZ\u0663",null,null,null],
    ["++",null,null,null],
    [" 91048576#REF!$",null,null,null],
    ["#REF!A",null,null,null],
    ["AB10485771048576",null,null,null],
    ["Z",null,25,null],
    [":",null,null,null],
    ["Z",null,25,null],
    ["a",null,0,null],
    ["-++0$",null,null,null],
    ["XFEB",null,null,null],
    [":",null,null,null],
    ["B0 ",null,null,null],
    ["1048576-",null,null,null],
    ["0B",null,null,null],
    ["$",null,null,null],
  ],
  areas: [
    ["'Q1!Q2'!",[]],
    ["XFD1048576:'Q1!Q2'!$B$2$A$1$A$1",[]],
    ["B:C",[[null,0,1,1048575,2]]],
    [",33B:C,1:2'It''s, here'!Sheet1!",[]],
    ["'Q1!Q2'!'Q1!Q2'!#REF!,'B:C!",[]],
    ["1:2",[[null,0,0,1,16383]]],
    ["'Q1!Q2'!",[]],
    [":$B$2$A$1'$B$2#REF!,",[]],
    ["$B$2#REF!,Sheet1!33  ",[]],
    ["'It''s, here'!$B$23",[["It's, here",22,1,22,1]]],
    ["=' $B$2$B$2:  ",[]],
    ["::1:2:XFD1048576'",[]],
    ["B:C'Q1!Q2'!3'It''s, here'!1:2,",[["B:C'Q1!Q2'!3'It''s, here'",0,0,1,16383]]],
    ["1:2",[[null,0,0,1,16383]]],
    ["#REF!!B:C'Q1!Q2'!",[]],
    ["'Q1!Q2'!'Sheet1!",[]],
    ["C#REF!B:CXFD1048576'",[]],
    ["!: CC!",[]],
    ["Sheet1!Sheet1!XFD1048576Sheet1!",[]],
    ["3,,'':",[]],
    ["'",[]],
    [" $B$2:'Sheet1!",[]],
    ["$A$1,$B$2Sheet1!$B$2$A$1,Sheet1!",[[null,0,0,0,0]]],
    ["Sheet1!,==$A$1'B:C",[]],
    ["'It''s, here'!3XFD1048576XFD1048576",[]],
    ["XFD1048576,",[[null,1048575,16383,1048575,16383]]],
    [":,'It''s, here'! $A$1=!$B$2",[["'It''s, here'! $A$1=",1,1,1,1]]],
    ["1:2 $B$233 'It''s, here'!#REF!",[]],
    ["'Q1!Q2'!$A$11:2'It''s, here'!",[]],
    ["$A$1",[[null,0,0,0,0]]],
    ["31:2'#REF!",[]],
    [":3C'It''s, here'!$B$2",[[":3C'It''s, here'",1,1,1,1]]],
    [":B:C ",[]],
    ["$A$1",[[null,0,0,0,0]]],
    ["CXFD1048576'It''s, here'!Sheet1!'It''s, here'!$B$2",[["CXFD1048576'It''s, here'!Sheet1!'It''s, here'",1,1,1,1]]],
    ["XFD1048576Sheet1!Sheet1!1:2Sheet1!B:C",[["XFD1048576Sheet1!Sheet1!1:2Sheet1",0,1,1048575,2]]],
    ["XFD1048576C='It''s, here'!1:2B:C ",[]],
    ["Sheet1!1:2 $A$1:",[]],
    ["1:2",[[null,0,0,1,16383]]],
    ["'Q1!Q2'!1:2'Q1!Q2'!B:C$B$2",[]],
    ["#REF!'Q1!Q2'!Sheet1!",[]],
    ["XFD1048576Sheet1!:B:C",[]],
    ["#REF!,C !1:2",[["C",0,0,1,16383]]],
    ["!'Q1!Q2'!'It''s, here'!#REF!#REF!$B$2!C",[]],
    [",Sheet1!",[]],
    ["=='Q1!Q2'!1:2'Q1!Q2'!, !",[]],
    [" :C'It''s, here'!#REF!",[]],
    ["#REF!1:2C",[]],
    [",",[]],
    ["$B$2C1:2#REF!$A$1!=B:C",[]],
    ["31:2$B$2$A$1'It''s, here'!#REF!'",[]],
    ["'''Q1!Q2'!XFD1048576:XFD1048576$A$1,",[]],
    ["C3",[[null,2,2,2,2]]],
    [", ",[]],
    ["XFD1048576#REF!B:CC'",[]],
    ["$B$21:21:2=$A$1 ",[]],
    ["XFD1048576",[[null,1048575,16383,1048575,16383]]],
    ["'It''s, here'!$B$2$A$1$A$1B:CSheet1!",[]],
    [":''Q1!Q2'!#REF!",[]],
    [" :C!C'Sheet1!",[]],
  ],
  shift: [
    [")1.5'B1 sheet'!Sheet1!$\"A1\" ",1,1,")1.5'B1 sheet'!Sheet1!$\"A1\" "],
    [":1E+51.5\"A1\"\"A1\"1E+5)",-1,-1,":1E+51.5\"A1\"\"A1\"1E+5)"],
    ["\"A1\"Sheet1!B2A$1",1,-1,"\"A1\"Sheet1!B2A$1"],
    ["$A$11E+5AB12A$",-1,1,"$A$11E+5AB12A$"],
    ["$A$1B2B2",3,1,"$A$1B2B2"],
    ["Sheet1!tbl.Col1.5",2,-3,"Sheet1!tbl.Col1.5"],
    [" A$1",-2,-2," #REF!"],
    ["*A$1B2Sheet1!",3,-3,"*A$1B2Sheet1!"],
    ["LOG10()$SUM(:ZZZ9999999-",0,1,"LOG10()$SUM(:ZZZ9999999-"],
    ["*$SUM(tbl.Col+:SUM($A1",-1,-1,"*$SUM(tbl.Col+:SUM(#REF!"],
    ["LOG10(B2-+A1048576SUM(",-2,-2,"LOG10(#REF!-+A1048576SUM("],
    [":",3,3,":"],
    ["ZZZ9999999A1048576\"x\"\"y\"A:-AB12$A$1",-2,2,"ZZZ9999999A1048576\"x\"\"y\"A:-AB12$A$1"],
    ["-+B2,",-1,-3,"-+#REF!,"],
    ["A1AB12",3,3,"A1AB12"],
    ["A1048576$$A1AXFD1\"x\"\"y\"",-1,1,"A1048576$$A1AXFD1\"x\"\"y\""],
    ["\u00e91A$1\"A1\"AB12tbl.ColZZZ9999999ZZZ9999999",3,-1,"\u00e91A$1\"A1\"AB12tbl.ColZZZ9999999ZZZ9999999"],
    [":XFD1::Sheet1!",-2,2,":#REF!::Sheet1!"],
    ["A1048576:",-3,0,"A1048573:"],
    ["\"A1\"AB12-$A$1)'B1 sheet'!",1,1,"\"A1\"AC13-$A$1)'B1 sheet'!"],
    ["XFD1LOG10(A1048576$A$1",-3,1,"XFD1LOG10(A1048576$A$1"],
    ["+1E+5$A1$A1A1048576",-1,-3,"+1E+5$A1$A1A1048576"],
    [",$A1LOG10(1.5,AB12*$A1",-3,-3,",$A1LOG10(1.5,Y9*#REF!"],
    ["\u00e91 ",1,2,"\u00e91 "],
    ["\u00e91XFD1'B1 sheet'!*A1$A1SUM('B1 sheet'!",1,2,"\u00e91XFD1'B1 sheet'!*A1$A1SUM('B1 sheet'!"],
    ["A-A1048576XFD11E+5",1,1,"A-A1048576XFD11E+5"],
    ["1E+5)",2,-2,"1E+5)"],
    ["A1048576$A$1$A1\"x\"\"y\"XFD1",-2,0,"A1048576$A$1$A1\"x\"\"y\"#REF!"],
    ["XFD11E+5,ZZZ9999999'B1 sheet'!)A$1",0,0,"XFD11E+5,ZZZ9999999'B1 sheet'!)A$1"],
    ["ZZZ9999999A1",3,-1,"ZZZ9999999A1"],
    ["LOG10($\u00e91",0,1,"LOG10($\u00e91"],
    ["B2LOG10(*A1\"A1\"-SUM($",-1,-1,"B2LOG10(*#REF!\"A1\"-SUM($"],
    ["+A$1:ZZZ9999999SUM($A",-3,-3,"+#REF!:ZZZ9999999SUM($A"],
    ["SUM( 'B1 sheet'!)1.5)$A$1ZZZ9999999",1,3,"SUM( 'B1 sheet'!)1.5)$A$1ZZZ9999999"],
    ["\u00e91,XFD1AB12",2,-1,"\u00e91,XFD1AB12"],
    ["+\u00e91AB12LOG10(LOG10(LOG10(",-1,-1,"+\u00e91AB12LOG10(LOG10(LOG10("],
    ["'B1 sheet'!",-1,1,"'B1 sheet'!"],
    ["A11.5AB12$B2\"A1\"$A$1AB12",1,1,"A11.5AB12$B2\"A1\"$A$1AB12"],
    ["A1048576$A1\"x\"\"y\"",-2,1,"A1048576$A1\"x\"\"y\""],
    ["$+\"A1\"Sheet1!,",1,0,"$+\"A1\"Sheet1!,"],
    ["1E+5 \"A1\"$,SUM(",-3,-3,"1E+5 \"A1\"$,SUM("],
    ["B2,LOG10(+1E+5\"A1\"\u00e911E+5",2,1,"C4,LOG10(+1E+5\"A1\"\u00e911E+5"],
    ["A1 'B1 sheet'!A$1$A$1",-1,2,"#REF! 'B1 sheet'!A$1$A$1"],
    [",AB12-A)A)",1,-1,",AA13-A)A)"],
    ["-A$1$A$1A1",1,2,"-A$1$A$1A1"],
    ["tbl.ColAB12",-3,-2,"tbl.ColAB12"],
    ["\"A1\")+",0,-2,"\"A1\")+"],
    ["-A1\"A1\"",0,0,"-A1\"A1\""],
    ["ZZZ9999999A1",3,2,"ZZZ9999999A1"],
    ["$A$1 ZZZ99999991E+5",1,3,"$A$1 ZZZ99999991E+5"],
    ["\"x\"\"y\"+$B2A1048576",1,1,"\"x\"\"y\"+$B2A1048576"],
    ["$:\u00e91\"x\"\"y\"$A1A\u00e91",-1,0,"$:\u00e91\"x\"\"y\"$A1A\u00e91"],
    ["1.5",3,3,"1.5"],
    ["A1048576ZZZ9999999",1,2,"A1048576ZZZ9999999"],
    ["$,B2XFD1SUM(*",2,2,"$,B2XFD1SUM(*"],
    ["\u00e91+A1",0,3,"\u00e91+D1"],
    ["A1B2*$A$1$A1",3,-3,"A1B2*$A$1$A1"],
    ["LOG10('B1 sheet'!B2\"A1\"",2,0,"LOG10('B1 sheet'!B4\"A1\""],
    ["A1048576ZZZ9999999\u00e91\u00e91*",-1,3,"A1048576ZZZ9999999\u00e91\u00e91*"],
    ["SUM(:",1,3,"SUM(:"],
    ["\u00e91XFD1\"A1\"**1.5*",-1,-3,"\u00e91XFD1\"A1\"**1.5*"],
    ["$AXFD1A$1Sheet1!A1048576",2,0,"$AXFD1A$1Sheet1!#REF!"],
    ["AB12+\"A1\"1E+5A1048576,",-2,-3,"Y10+\"A1\"1E+5#REF!,"],
    ["$A$1LOG10(",-3,3,"$A$1LOG10("],
    ["\"A1\"A)",-2,-3,"\"A1\"A)"],
    ["XFD1tbl.Col\"x\"\"y\"",0,-3,"XFD1tbl.Col\"x\"\"y\""],
    ["ZZZ9999999",3,-1,"ZZZ9999999"],
    ["1E+5+)1.5A1A1\"x\"\"y\"+",-2,1,"1E+5+)1.5A1A1\"x\"\"y\"+"],
    ["AB12",3,-1,"AA15"],
    ["A$11.5\"A1\" +",-1,2,"A$11.5\"A1\" +"],
    ["A1048576$A$1$\u00e91B2$AB12",-1,3,"A1048576$A$1$\u00e91B2$AB12"],
    ["tbl.Col:",-2,-2,"tbl.Col:"],
    ["SUM(Sheet1!)-A$1LOG10(",-2,-1,"SUM(Sheet1!)-A$1LOG10("],
    ["\u00e91'B1 sheet'!A1048576\"A1\"",3,3,"\u00e91'B1 sheet'!#REF!\"A1\""],
    ["\"x\"\"y\"AB12\"A1\"A$1-",-3,-3,"\"x\"\"y\"Y9\"A1\"#REF!-"],
    ["1.5 SUM(ALOG10(B2",0,-2,"1.5 SUM(ALOG10(#REF!"],
    ["-):)",1,-1,"-):)"],
    [")\"x\"\"y\"-LOG10(A1A)",2,3,")\"x\"\"y\"-LOG10(A1A)"],
    ["  ",-3,0,"  "],
    ["$SUM(A1048576LOG10(",-2,3,"$SUM(A1048576LOG10("],
    ["A1048576A1048576'B1 sheet'!XFD11E+5'B1 sheet'!XFD1 ",3,1,"A1048576A1048576'B1 sheet'!XFD11E+5'B1 sheet'!#REF! "],
    ["\"x\"\"y\"",-2,-1,"\"x\"\"y\""],
    ["A11E+5A$1,LOG10(XFD1\"A1\"",-1,0,"A11E+5A$1,LOG10(#REF!\"A1\""],
    ["\"x\"\"y\"$A$1-",2,-1,"\"x\"\"y\"$A$1-"],
    ["B2SUM($A$1:",3,3,"B2SUM($A$1:"],
    [")$A1\"x\"\"y\"",-3,2,")#REF!\"x\"\"y\""],
    ["Sheet1!LOG10(1.5",-1,-3,"Sheet1!LOG10(1.5"],
    ["SUM(\u00e91AB12,$$-",-2,-3,"SUM(\u00e91AB12,$$-"],
    ["XFD1\u00e91-LOG10(A$1B2\"A1\"",1,2,"XFD1\u00e91-LOG10(A$1B2\"A1\""],
    ["B2XFD1B2",-1,1,"B2XFD1B2"],
    ["Sheet1!",0,2,"Sheet1!"],
    ["\"A1\"$A$1A$1AB12'B1 sheet'!B2$",0,0,"\"A1\"$A$1A$1AB12'B1 sheet'!B2$"],
    [")$A$1B2'B1 sheet'!AB12'B1 sheet'!*B2",1,-3,")$A$1B2'B1 sheet'!Y13'B1 sheet'!*#REF!"],
    ["*'B1 sheet'! ",-2,1,"*'B1 sheet'! "],
    ["\"x\"\"y\",ZZZ9999999",1,2,"\"x\"\"y\",ZZZ9999999"],
    [":",0,-2,":"],
    ["+tbl.Col+SUM(),",3,1,"+tbl.Col+SUM(),"],
    ["XFD1'B1 sheet'!$A$1",-2,-2,"#REF!'B1 sheet'!$A$1"],
    [" $",-2,-2," $"],
    ["1E+5",0,0,"1E+5"],
  ],
  unescape: [
    ["_x\uff26\uff26\uff26\uff26__x005F_","\uffff_"],
    ["_xZZZZ__x_x-001_","_xZZZZ__x\uffff"],
    ["_xx_x\uff26\uff26\uff26\uff26__x005F_000D","_xx\uffff_000D"],
    ["_x_x\u0663\u0663\u0663\u0663__x00e9_","_x\u3333\u00e9"],
    ["_x00e9__x00e9_aa_xZZZZ_","\u00e9\u00e9aa_xZZZZ_"],
    ["_x-001_","\uffff"],
    ["_x\uff26\uff26\uff26\uff26_","\uffff"],
    ["_","_"],
    ["_xZZZZ__xZZZZ_a_x00e9_","_xZZZZ__xZZZZ_a\u00e9"],
    ["000D_xZZZZ__\n","000D_xZZZZ__\n"],
    ["_x005F___x00e9_\n","__\u00e9\n"],
    ["_x","_x"],
    ["_x-001__x\uff26\uff26\uff26\uff26__x+041_","\uffff\uffffA"],
    ["_x+041__","A_"],
    ["_x-001__x+041_a","\uffffAa"],
    ["_x-001__x000D_","\uffff\r"],
    ["_x\u0663\u0663\u0663\u0663__x__x\uff26\uff26\uff26\uff26_","\u3333_x_\uffff"],
    ["_x+041_","A"],
    ["x_x00e9_x","x\u00e9x"],
    ["x","x"],
    ["x_x000D_","x\r"],
    ["x_x-001__x000D_","x\uffff\r"],
    ["x_000D_x000D_000D","x_000D\r000D"],
    ["_xZZZZ_","_xZZZZ_"],
    ["_xZZZZ__x","_xZZZZ__x"],
    ["_x\uff26\uff26\uff26\uff26__x+041_","\uffffA"],
    ["a_x\uff26\uff26\uff26\uff26_","a\uffff"],
    ["x_x-001_a_x000D","x\uffffa_x000D"],
    ["_x00e9__x000D_000D_x005F__xZZZZ_","\u00e9\r000D__xZZZZ_"],
    ["_x-001___x+041_","\uffff_A"],
    ["_x00e9_\n_x\uff26\uff26\uff26\uff26__\n","\u00e9\n\uffff_\n"],
    ["_xZZZZ__x005F__x-001_000D_x\u0663\u0663\u0663\u0663_","_xZZZZ__\uffff000D\u3333"],
    ["_x+041_","A"],
    ["000D","000D"],
    ["_x-001_","\uffff"],
    ["_x_x00e9_\n000Dx","_x\u00e9\n000Dx"],
    ["_x\u0663\u0663\u0663\u0663__xZZZZ__x\u0663\u0663\u0663\u0663_","\u3333_xZZZZ_\u3333"],
    ["x_x+041_","xA"],
    ["_x005F_","_"],
    ["_xZZZZ_\n_x000D__x\u0663\u0663\u0663\u0663_","_xZZZZ_\n\r\u3333"],
    ["_x-001__x\uff26\uff26\uff26\uff26__x000D__xZZZZ_","\uffff\uffff\r_xZZZZ_"],
    ["_xZZZZ_\n_x\u0663\u0663\u0663\u0663_","_xZZZZ_\n\u3333"],
    ["x_x00e9_a__x00e9_","x\u00e9a_\u00e9"],
    ["\n","\n"],
    ["\na_x-001__x00e9_","\na\uffff\u00e9"],
    ["_x\u0663\u0663\u0663\u0663__x00e9__","\u3333\u00e9_"],
    ["_x000D_","\r"],
    ["_x005F_000D_x\u0663\u0663\u0663\u0663_","_000D\u3333"],
    ["_x+041__x\u0663\u0663\u0663\u0663__","A\u3333_"],
    ["__x000D__x\n","_\r_x\n"],
    ["x","x"],
    ["a_x+041__xZZZZ_","aA_xZZZZ_"],
    ["\n","\n"],
    ["_x\u0663\u0663\u0663\u0663__","\u3333_"],
    ["aa_xZZZZ__x000D__xZZZZ_","aa_xZZZZ_\r_xZZZZ_"],
    ["000D_x005F_","000D_"],
    ["_xZZZZ_a_x00e9__x000D__xZZZZ_","_xZZZZ_a\u00e9\r_xZZZZ_"],
    ["_x-001__x00e9_","\uffff\u00e9"],
    ["_x+041_a_x_x+041_","Aa_xA"],
    ["x\n_x005F_","x\n_"],
  ],
  serial: [
    ["2024-03-15",0,45366],
    ["2024-03-15T10:30:00",0,45366.4375],
    ["10:30:00",0,0.4375],
    ["1900-02-28",0,59],
    ["1900-02-29",0,61],
    ["1900-03-01",1,-1401],
    ["1904-01-01",1,0],
    ["9999-12-31T23:59:59.999",1,2957003.9999999884],
    ["2024-02-30",0,45352],
    ["0000-01-01",0,-693960],
    ["1899-12-31",0,0],
    ["12:00",1,0.5],
    ["25:61:61",1,1.0847337962962964],
    ["Z9999190431190012",1,null],
    ["2024999915",1,null],
    ["311212",0,null],
    ["31190431T30",1,null],
    ["99T:1212",1,null],
    ["30",0,null],
    ["309999.5",1,null],
    ["1312030029",0,null],
    ["0330:190403202429",1,null],
    ["31",1,null],
    ["2024159999",0,null],
    [":0000Z",0,null],
    ["T",1,null],
    [" 30023099",0,null],
    ["29Z0115-3113",0,null],
    ["T: 03190412 13",1,null],
    ["01",0,null],
    ["-TT20241231:.5",0,null],
    ["1904-Z31::0000",0,null],
    [" 3100121900",1,null],
    ["2024T",1,null],
    ["1900",1,null],
    ["000000Z0000T13-",0,null],
    [" 15030012",1,null],
    ["123003019999",1,null],
    ["19000000Z-9901 2024",0,null],
    ["02",0,null],
    ["-",1,null],
    ["1900311319001303Z",0,null],
    ["990312Z 122902",0,null],
    ["3002",1,null],
    [".501 99993012:9999",0,null],
    ["1900 .50000",0,null],
    [":9999.5 ",0,null],
    [":99312999",0,null],
    ["0000:2929.5-",1,null],
    ["001900",0,null],
    ["000000130015190430",0,null],
    ["130013T12",0,null],
    ["12",0,null],
    ["12:2930",1,null],
    [".599990212",0,null],
    ["3000003199.52024",1,null],
    [".512: 01",0,null],
    ["999900001302T",0,null],
    ["152902Z001900.503",1,null],
    ["291299TZ",0,null],
    ["999999T",1,null],
    ["99::99T202499",1,null],
    ["13.5:",0,null],
    ["12T",0,null],
    [" 03",0,null],
    ["1230",0,null],
    ["19002913: 290015",1,null],
    ["2024T.519001219002999",0,null],
    ["0299:.59999",0,null],
    [":",1,null],
    ["9915ZT29:31",0,null],
    ["20242024T.519002912",1,null],
    ["1904:03",0,null],
  ],
  paper: [
    ["wide",null],
    ["1e308 ",null],
    ["f210f",null],
    ["din",null],
    ["1e3088.5",null],
    ["8.5",null],
    ["d",null],
    ["8.5mm",null],
    ["8.5",null],
    ["-in",null],
    ["MMInfinityin",null],
    ["d0x1.8p10MM",null],
    ["mmpt-",null],
    ["210",null],
    ["8.5",null],
    ["8.5",null],
    ["-",null],
    ["MM",null],
    ["d",null],
    ["1e308",null],
    ["in",null],
    [".5",null],
    ["pt",null],
    ["MM",null],
    ["f",null],
    ["210MMwide",null],
    ["in",null],
    ["MM",null],
    ["1000001e308",null],
    ["d",null],
    ["0x1.8p10",null],
    [" 1e308f",null],
    ["8.5",null],
    ["297",null],
    [" in",null],
    ["297Infinity1e308",null],
    ["210",null],
    ["100000297",null],
    ["Infinity",null],
    ["-",null],
    ["mm",null],
    ["0.0001",null],
    ["inNaN297",null],
    ["inmmd",null],
    [".5",null],
    ["72100000pt",null],
    ["72in0x1.8p10",null],
    ["0x1p8mm",725.6692913385828],
    ["MMwide",null],
    ["0x1p80.0001",null],
    ["NaNd",null],
    [" 0.0001",null],
    ["pt0x1.8p10",null],
    ["mm",null],
    ["297mm",841.8897637795276],
    ["widept",null],
    ["0x1.8p10+",null],
    ["Infinity",null],
    ["inin",null],
    ["mmcmNaN",null],
  ],
  rgb: [
    ["f72C400",null],
    ["fC4",null],
    ["\uff26",null],
    ["44",null],
    ["00",null],
    ["C4",null],
    ["g\u0663",null],
    ["72g72#44",null],
    ["#0000fFF",4278194175],
    [" \u0663#\u0663",null],
    ["\u066300C4",null],
    ["FF",null],
    [" 00",null],
    ["44C400\uff26",null],
    ["\u0663",null],
    ["72\uff26f #",null],
    ["00",null],
    ["g",null],
    ["  ",null],
    ["44",null],
    ["C4",null],
    ["44\uff26C4",null],
    [" 44C4",null],
    ["FF44\uff26",null],
    ["\uff26",null],
    ["FF",null],
    ["447244\uff2644",null],
    [" 4400\uff26",null],
    ["\u0663447244",null],
    ["ggg",null],
    ["#g\u0663g",null],
    ["g\uff26\u0663C4",null],
    ["#\u0663C4",null],
    ["\u0663f72C4\u0663",null],
    ["44FF\u0663#",null],
    ["#C4FF",null],
    ["C4FF727244",null],
    ["44fFF",null],
    ["#",null],
    ["f f\u0663",null],
  ],
  tint: [
    [4284319466,"0.25",4286948591],
    [4280806310,"-0.249977111117893",4279352448],
    [4285282946,"0.8899",4293977844],
    [4171499976,"-0.3016",4168287884],
    [4278972364,"-0.3475",4278688901],
    [4291950912,"1.1533",4294967295],
    [4286793626,"-1.0439",4278190080],
    [3460982873,"0.7484",3469663445],
    [4291820305,"0.6",4293721504],
    [2586056983,"-0.35",2585202703],
    [1639422274,"-0.6812",1631203605],
    [2164791535,"0.5",2172684539],
    [4280041159,"0.25",4282738149],
    [4284097526,"-0.4172",4281206429],
    [4293226310,"-1.1836",4278190080],
    [3937681238,"-0.475",3932102957],
    [4285617554,"0.2313",4287723440],
    [4290772426,"0.288",4291952345],
    [4289295123,"-0.8879",4279438594],
    [4285697839,"-0.8783",4279111942],
    [4278473354,"-1.1508",4278190080],
    [2027167871,"0.7999816888943144",2029572581],
    [4291673255,"-0.9156",4279504907],
    [4286314309,"-0.249977111117893",4283228938],
    [4294696127,"0.7999816888943144",4294899954],
    [1441278932,"-0.35",1436619154],
    [1361801786,"0.382",1365361525],
    [4284341497,"0.3675",4288276987],
    [4287114814,"0.5691",4292580770],
    [4290719299,"0.7107",4293967814],
    [4283916385,"0.1903",4285825154],
    [4283882948,"-0.35",4280395406],
    [4282461785,"1.0172",4294967295],
    [4291585929,"0.8109",4294304489],
    [4286834196,"0.5",4290901383],
    [4279170045,"-0.5358",4278285947],
    [3010694110,"-0.3543",3005892784],
    [4294202894,"0.8",4294827471],
    [4283802174,"0.4236",4288270728],
    [4293059088,"0.25",4294111811],
    [2424242582,"0.1934",2428043739],
    [4286932378,"-0.0857",4286209165],
    [2854994189,"-0.5",2853593350],
    [4282698447,"0.8",4292539637],
    [4294416995,"-0.4953",4289086217],
    [4283353206,"-0.249977111117893",4281442133],
    [4289063700,"0.8761",4294245858],
    [4286369464,"0.3835",4289651155],
    [3204047793,"0.8",3204381167],
    [4288566587,"-0.249977111117893",4286005292],
    [4283478170,"0.6333",4290765530],
    [4285456053,"0.25",4287817415],
    [4286766838,"0.7744",4293130493],
    [4280614448,"-0.9301",4278195201],
    [4287550866,"1.1421",4294967295],
    [1897140874,"-0.35",1896680538],
    [2100060335,"0.1352",2100720332],
    [4287945539,"0.8984",4294245356],
    [4287002843,"-0.5066",4281410436],
    [4284073228,"-0.249977111117893",4282618889],
    [2247645434,"-0.3531",2245134036],
    [4278565864,"0.4422",4285194236],
    [4280480779,"-0.1212",4280210954],
    [4280639062,"0.9577",4294179577],
    [4292867874,"-0.6295",4284113924],
    [4283350935,"0.8",4292670186],
    [4284491345,"-0.0738",4284031819],
    [4278846876,"-0.3621",4278584164],
    [4291960164,"1.1903",4294967295],
    [2249754865,"-0.9385",2248214543],
    [4284864660,"-0.5",4280319559],
    [4290848158,"-0.2587",4287568757],
    [4287493769,"0.5",4291230660],
    [3177006716,"-0.249977111117893",3175495005],
    [4294235417,"-0.4559",4287396103],
    [4288829739,"0.6",4293245599],
    [4291913513,"-0.25",4288498975],
    [4286074349,"0.0792",4286798830],
    [4288003763,"-0.249977111117893",4284587661],
    [4286167411,"-0.0687",4285313637],
  ],
  digitWidth: [
    ["Unknown",7.1,5],
    ["Unknown",1.6,1],
    ["Courier New",31.6,25],
    ["Aptos",37.5,28],
    ["Aptos",18.9,14],
    ["Verdana",23.2,20],
    ["Courier New",3.5,3],
    ["Verdana",16.1,14],
    ["Georgia",24,20],
    ["Calibri",18.2,12],
    ["Arial",26.9,20],
    ["Verdana",36.3,31],
    ["Aptos",500,300],
    ["",26.1,19],
    ["",38.7,28],
    ["Aptos",18.3,13],
    ["Segoe UI",20.1,15],
    ["Arial Narrow",18.8,11],
    ["Unknown",6.6,5],
    ["Courier New",500,327],
    ["Arial Narrow",37.8,23],
    ["",32.2,24],
    ["",10,7],
    ["",-5,1],
    ["Times New Roman",15.5,10],
    ["Arial Narrow",37.7,23],
    ["Aptos Narrow",22.6,15],
    ["Arial Narrow",14.5,9],
    ["Arial Narrow",7.3,4],
    ["Arial",12.1,9],
    ["Segoe UI",14,10],
    ["Aptos",5.5,4],
    ["Times New Roman",0,1],
    ["Verdana",1,1],
    ["Unknown",409,300],
    ["Aptos",1,1],
    ["Aptos",22,16],
    ["Arial",12.5,9],
    ["",-5,1],
    ["Segoe UI",28.9,22],
  ],
  columnPoints: [
    ["8.43",10,63],
    ["13.866",10,104.25],
    ["71.71",8,430.5],
    ["9.140625",1,6.75],
    ["300",3,573.75],
    ["38.512",13,375.75],
    ["18.614",9,126],
    ["76.888",20,1153.5],
    ["300",9,1721.25],
    ["300",19,3633.75],
    ["90.842",5,340.5],
    ["5.385",9,36],
    ["13.7109375",11,113.25],
    ["9.140625",12,82.5],
    ["42.809",16,513.75],
    ["97.719",13,952.5],
    ["78.175",14,820.5],
    ["44.913",20,673.5],
    ["80.479",1,60],
    ["0",17,0],
    ["62.39",15,702],
    ["76.079",19,1083.75],
    ["51.297",18,692.25],
    ["9.684",14,102],
    ["255",11,2103.75],
    ["15.486",1,11.25],
    ["0.252",9,1.5],
    ["26.931",2,40.5],
    ["71.635",15,805.5],
    ["13.7109375",13,133.5],
    ["68.044",15,765.75],
    ["1.749",15,19.5],
    ["98.467",19,1403.25],
    ["300",12,2295],
    ["13.7109375",10,102.75],
    ["36.57",15,411.75],
    ["24.633",3,55.5],
    ["300",10,1912.5],
    ["81.221",4,243.75],
    ["94.192",11,777],
  ],
  headers: [
    ["&C&A&P+1&\"&G&12&P+1",[[],[["Sheet8",false,false,false,false,0,null,null,null]],[]]],
    ["&S&KFF0000&KFF0000&\u0661\u0662&D&T",[[],[["1/2/269:30",false,false,false,true,0,12,null,16711680]],[]]],
    ["&E&\u0661\u0662&C&12",[[],[],[]]],
    ["&N&D&P+1&T&P+1",[[],[["121/2/2689:308",false,false,false,false,0,null,null,null]],[]]],
    ["&P of ",[[],[["7 of ",false,false,false,false,0,null,null,null]],[]]],
    ["&R",[[],[],[]]],
    [" of &B",[[],[[" of ",false,false,false,false,0,null,null,null]],[]]],
    ["&\"&P+&X&&",[[],[],[]]],
    ["&\"Times\"",[[],[],[]]],
    ["&U&D",[[],[["1/2/26",false,false,true,false,0,null,null,null]],[]]],
    ["&U&12&K12&S&\"Arial,Bold\"&P+1",[[],[["Arial,Bold\"8",false,false,true,false,0,12,null,null]],[]]],
    ["&E&S&\"Arial,Bold\"&P+&I",[[],[["7+",true,false,true,true,0,null,"Arial",null]],[]]],
    ["&K12&\"Times\"x&P",[[],[["mes\"x7",false,false,false,false,0,null,null,null]],[]]],
    ["&U&P-2",[[],[["5",false,false,true,false,0,null,null,null]],[]]],
    ["&D&&XPage &L&A&KFF0000",[[["Sheet",false,false,false,false,0,null,null,null]],[["1/2/26&XPage ",false,false,false,false,0,null,null,null]],[]]],
    ["&12&P-2&&&Gx&N&410",[[],[["5&x12",false,false,false,false,0,12,null,null]],[]]],
    ["&L&&P-2&X",[[["&P-2",false,false,false,false,0,null,null,null]],[],[]]],
    ["&\"-,Italic\"&B&U of &409",[[],[[" of ",true,true,true,false,0,null,null,null]],[]]],
    ["&Xx&\"Times\"&\u0661\u0662&P+1 of &E",[[],[["x",false,false,false,false,1,null,null,null],["8 of ",false,false,false,false,1,12,"Times",null]],[]]],
    ["&P+&\u0661\u0662&409 of &GPage &",[[],[["7+",false,false,false,false,0,null,null,null],[" of Page &",false,false,false,false,0,409,null,null]],[]]],
    ["&\"Arial,Bold\"&KFF0000",[[],[],[]]],
    ["&S&&I&X&F&KFF0000&",[[],[["&I",false,false,false,true,0,null,null,null],["Book.xlsx",false,false,false,true,1,null,null,null],["&",false,false,false,true,1,null,null,16711680]],[]]],
    ["&C&C&\"-,Italic\"",[[],[],[]]],
    ["&P+&R&P&B&C",[[],[["7+",false,false,false,false,0,null,null,null]],[["7",false,false,false,false,0,null,null,null]]]],
    ["&E&G&\"Times\"&P+&U&&",[[],[["7+",false,false,true,false,0,null,"Times",null],["&",false,false,false,false,0,null,"Times",null]],[]]],
    ["&L&410 of &P+&S",[[[" of 7+",false,false,false,false,0,null,null,null]],[],[]]],
    ["&409&&Px&Y",[[],[["&Px",false,false,false,false,0,409,null,null]],[]]],
    ["&K12&\"&KFF0000&410",[[],[["FF0000",false,false,false,false,0,null,null,null]],[]]],
    ["&410&D&&G",[[],[["1/2/26&G",false,false,false,false,0,null,null,null]],[]]],
    ["&410&P&T&\"Arial,Bold\"&U&\u0661\u0662&409",[[],[["79:30",false,false,false,false,0,null,null,null]],[]]],
    ["&S&\"Arial,Bold\"&P+&N&X&G&D",[[],[["7+12",true,false,false,true,0,null,"Arial",null],["1/2/26",true,false,false,true,1,null,"Arial",null]],[]]],
    ["&I&T",[[],[["9:30",false,true,false,false,0,null,null,null]],[]]],
    ["&P-2 of &12&Y",[[],[["5 of ",false,false,false,false,0,null,null,null]],[]]],
    ["&\"Times\"x&410&G",[[],[["x",false,false,false,false,0,null,"Times",null]],[]]],
    ["&Y&\"Times\"&F&Y of &&&S",[[],[["Book.xlsx",false,false,false,false,-1,null,"Times",null],[" of &",false,false,false,false,0,null,"Times",null]],[]]],
    ["&P-2&T&I&T&G&A",[[],[["59:30",false,false,false,false,0,null,null,null],["9:30Sheet",false,true,false,false,0,null,null,null]],[]]],
    ["&KFF0000&T&R&\u0661\u0662&\"Times\"",[[],[["9:30",false,false,false,false,0,null,null,16711680]],[]]],
    ["&C&NPage &409&K12&B&K12",[[],[["12Page ",false,false,false,false,0,null,null,null],["12",false,false,false,false,0,409,null,null]],[]]],
    ["&P+1&I&N&N&C&\"-,Italic\"Page ",[[],[["8",false,false,false,false,0,null,null,null],["1212",false,true,false,false,0,null,null,null],["Page ",false,true,false,false,0,null,null,null]],[]]],
    ["&A&I&P",[[],[["Sheet",false,false,false,false,0,null,null,null],["7",false,true,false,false,0,null,null,null]],[]]],
    ["&\"",[[],[],[]]],
    [" of ",[[],[[" of ",false,false,false,false,0,null,null,null]],[]]],
    ["&Y&D&P&\"-,Italic\"",[[],[["1/2/267",false,false,false,false,-1,null,null,null]],[]]],
    ["&\"-,Italic\"&S",[[],[],[]]],
    ["&\u0661\u0662&KFF0000&C&L&N",[[["12",false,false,false,false,0,null,null,null]],[],[]]],
    ["&S",[[],[],[]]],
    ["&&\"Arial,Bold\"&P+1&P+1&P-2&\"",[[],[["&\"Arial,Bold\"885",false,false,false,false,0,null,null,null]],[]]],
    ["&L&P+&P+1&A&&",[[["7+8Sheet&",false,false,false,false,0,null,null,null]],[],[]]],
    ["&E&U&Y&Y&P+&U&P+1",[[],[["7+",false,false,false,false,0,null,null,null],["8",false,false,true,false,0,null,null,null]],[]]],
    ["&L&\u0661\u0662&P-2&C&E&\"-,Italic\"",[[["5",false,false,false,false,0,12,null,null]],[],[]]],
    ["&S&P&\u0661\u0662&N",[[],[["7",false,false,false,true,0,null,null,null],["12",false,false,false,true,0,12,null,null]],[]]],
    ["&K12",[[],[],[]]],
    ["&\u0661\u0662&\"-,Italic\"&B&U&410",[[],[],[]]],
    ["&T&12",[[],[["9:30",false,false,false,false,0,null,null,null]],[]]],
    ["&\"-,Italic\"",[[],[],[]]],
    ["&410&I",[[],[],[]]],
    ["&A&\"Arial,Bold\"&P+1x",[[],[["Sheet",false,false,false,false,0,null,null,null],["8x",true,false,false,false,0,null,"Arial",null]],[]]],
    ["&K12&I&E&\u0661\u0662&P+",[[],[["7+",false,false,false,false,0,12,null,null]],[]]],
    ["&L&KFF0000&T&I",[[["9:30",false,false,false,false,0,null,null,16711680]],[],[]]],
    ["&T&G",[[],[["9:30",false,false,false,false,0,null,null,null]],[]]],
  ],
};

function report(where, result) {
  if (result.failures.length) {
    throw new Error(`${where}: ${result.failures.length} of ${result.count} checks failed:\n  ` + result.failures.slice(0, 40).join('\n  '));
  }
  console.log(`${where}: ${result.count} checks passed`);
}

const fileUrl = (path) => pathToFileURL(join(root, 'site', path)).href;
const numbers = await import(fileUrl(NUMBERS));
const model = await import(fileUrl(MODEL));
const nodeResult = suite(numbers, model, GOLDEN);
report('Node', nodeResult);

// Kotlin's toDoubleOrNull, which every cell value that isn't plainly a number goes through: a long
// run of digits that isn't a number after all is refused at once, not after minutes of trying.
{
  const { toDoubleOrNull } = await import(fileUrl('app/js/engine/office/xlsx-numbers-kt.js'));
  const cases = [['12', 12], ['12.', 12], ['12.5', 12.5], ['.5', 0.5], ['1e3', 1000], ['12.5e-1', 1.25], ['-7d', -7], [' 3f ', 3],
    ['', null], ['.', null], ['1e', null], ['1.e', null], ['12x', null], ['1..2', null]];
  for (const [text, expected] of cases) assert(toDoubleOrNull(text) === expected, `toDoubleOrNull(${JSON.stringify(text)}) gave ${toDoubleOrNull(text)}, not ${expected}`);
  const began = Date.now();
  for (const tail of ['x', 'e', '.x']) assert(toDoubleOrNull('1'.repeat(200000) + tail) === null, `200,000 digits and "${tail}" is no number`);
  assert(Date.now() - began < 2000, `long digit runs took ${Date.now() - began} ms to refuse`);
}

const expression = (base) => `(async () => {
  const numbers = await import(${JSON.stringify(new URL(NUMBERS, base).href)});
  const model = await import(${JSON.stringify(new URL(MODEL, base).href)});
  return (${suite.toString()})(numbers, model, ${JSON.stringify(GOLDEN)});
})()`;

for (const browser of ['chromium', 'firefox', 'webkit']) {
  const viewport = browser === 'chromium' ? { width: 360, height: 800 } : { width: 1366, height: 900 };
  await withPage(async (page, url) => {
    // Any page of the site will do: the modules are imported from it, as the app imports them.
    await page.goto(url + NUMBERS);
    const result = await page.evaluate(expression(url));
    report(browser, result);
    assert(result.count === nodeResult.count, `${browser} ran ${result.count} checks, Node ${nodeResult.count}`);
    // The harness's way in, for one export.
    const code = await runInPage(page, url, NUMBERS, 'shortDateCode', 'en-GB');
    assert(code === 'dd/mm/yyyy', `${browser}: British short date ${code}`);
  }, { browser, viewport });
}
console.log('xlsx-numbers: all passed');
