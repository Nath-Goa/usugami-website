# Spreadsheet values and number formats (`engine/office/xlsx-numbers.js`, `xlsx-model.js`)

The pure base of Excel to PDF: how a cell's number reads through its number format, and the
workbook pieces around it (cell references, print areas and titles, column widths, splitting a
sheet into pages, paper sizes, colours, dates of type `d`, escaped text, shared formulas, headers
and footers). A complete port of the app's `core/SpreadsheetNumbers.kt` and `core/Spreadsheets.kt`,
plus the `CellNumbers` class of `data/office/XlsxText.kt` (numbers in the device's language).

- Pure functions: no DOM, no network, nothing to load. They run in pages, workers and Node.
- **Nothing is thrown, for any input**: a broken or hostile format code shows the number as General,
  a reference that isn't one gives `null`. No `UserError` keys, so no strings to add.
- Same names as the Kotlin (`SpreadsheetNumbers.format`, `SheetRefs.cell`, ...), so the converter's
  Kotlin (`XlsxConverter.kt`, `XlsxSheet.kt`, `XlsxPages.kt`, `XlsxText.kt`, `XlsxStyles.kt`) ports
  line for line. Where Kotlin has named arguments with defaults, JavaScript takes an options object;
  a Kotlin `Pair` becomes a two-item array or a small object (each noted below).
- Checked against the app's own Kotlin code: over a million random codes, values and references give
  the same answers (`tests/xlsx-numbers.test.mjs` keeps 1,464 of them), and the app's unit tests
  pass in Node, Chromium, Firefox and WebKit.
- **Colours** are ARGB numbers from 0 to 0xFFFFFFFF, never negative (opaque red is `0xFFFF0000`,
  where Kotlin's `Int` is negative). To draw one: `r = (c >>> 16) & 255`, `g = (c >>> 8) & 255`,
  `b = c & 255`. Header colours (`HeaderRun.color`) are RGB without alpha, as in Kotlin.

```js
import { SpreadsheetNumbers, CellNumbers, SheetLocale } from './engine/office/xlsx-numbers.js';
import { SheetRefs, SheetPages, SheetHeaders } from './engine/office/xlsx-model.js';

const numbers = new CellNumbers(navigator.language);   // as the app's CellNumbers(Locale.getDefault(FORMAT))
numbers.format(45000, numbers.builtIn(14)).text;       // '3/15/2023' in the US, '15/03/2023' in Britain
SpreadsheetNumbers.format(-1234.5, '#,##0.00;[Red](#,##0.00)');   // { text: '(1,234.50)', colour: 0xFFFF0000 }
SheetRefs.range('$A$1:$F$20');                         // SheetRange { firstRow: 0, firstColumn: 0, lastRow: 19, lastColumn: 5 }
```

## `xlsx-numbers.js`

### `SpreadsheetNumbers.format(value, formatCode, { locale, date1904, maxChars } = {})`

`value` (a number; anything else goes through `Number()`) shown with `formatCode` as Excel shows it.
Returns `{ text, colour }`: `colour` is the ARGB number the code asks for (`[Red]`, `[Blue]`,
`[Color10]`), or `null`.

- `locale`: a locale object (see `SheetLocale`); default English. Parts it leaves out are English.
- `date1904`: the workbook's 1904 date system (`workbookPr date1904="1"`); default `false`.
- `maxChars`: how many characters General may take (not counting a minus), as in a narrow column;
  default 11, which is also the most. A date out of Excel's range (negative, or after 31 December
  9999) fills `maxChars` characters with `#` (1 to 255 of them).
- `NaN` and infinities show `#NUM!`. A code longer than 1,024 characters, with an unclosed quote or
  bracket, or with more than four sections shows General.

What codes do: up to four sections (positive; negative, shown without its minus; zero; text), or
conditions (`[>=1000]0.0,"K";0`); `0 # ?` placeholders, `.`, thousands `,` and trailing `,` (divide
by 1000), `%` and `‰`, `E+`/`E-` scientific and engineering (`##0.0E+0`), fractions (`# ?/?`,
`# ??/16`, `?/?`), `General`, quoted text, `\x`, `_x` (a space), `*x` (fill: left out, as a PDF's
text doesn't stretch), `[$€-x-euro2]` currency symbols (`[$-409]` shows nothing); dates and times
(`y yy yyyy e`, `m mm mmm mmmm mmmmm`, `d dd ddd dddd`, `h hh`, `m`/`mm` as minutes after an hour
or before seconds, `s ss`, `.0 .00 .000`, `AM/PM`, `A/P`, elapsed `[h] [mm] [ss]`). Numbers keep 15
significant digits and round half away from zero (`1.005` with `0.00` is `1.01`). The 1900 system
has Excel's 29 February 1900 (serial 60) and counts 1 January 1900 as a Sunday; serial 0 is
`1/0/1900`. `g` (Japanese eras) shows nothing.

```js
SpreadsheetNumbers.format(0.256, '0.00%').text;                 // '25.60%'
SpreadsheetNumbers.format(Math.PI, '# ??/??').text;             // '3 14/99'
SpreadsheetNumbers.format(1.5, '[h]:mm:ss').text;               // '36:00:00'
SpreadsheetNumbers.format(0, 'm/d/yyyy', { date1904: true }).text;   // '1/1/1904'
SpreadsheetNumbers.format(123456789, 'General', { maxChars: 6 }).text; // '1E+08'
SpreadsheetNumbers.format(-1, 'm/d/yyyy', { maxChars: 8 }).text;      // '########'
```

### `SpreadsheetNumbers.formatText(text, formatCode)`

A text cell (shared string, inline string, `t="str"`) shown with the code's text section (the fourth
section, or a last section with `@`): `{ text, colour }`. Without a text section the text shows as
it is, with `colour: null`.

```js
SpreadsheetNumbers.formatText('abc', '0;-0;0;"Text: "@');   // { text: 'Text: abc', colour: null }
SpreadsheetNumbers.formatText('x', SpreadsheetNumbers.builtInFormat(41));   // { text: ' x ', colour: null }
```

### `SpreadsheetNumbers.builtInFormat(id)`

The code of built-in number format `id` (0 to 49, the ids `styles.xml` doesn't spell out), or
`null`. 5 to 8 are the dollar formats; 23 to 26 are General; 27 to 31 and 34 to 36 (East Asian
dates) are `m/d/yyyy`; 32 is `h:mm`, 33 `h:mm:ss`. For a cell, use `CellNumbers.builtIn(id)`,
which gives the device's short date for 14 and 22 and General for unknown ids, as the app does.

```js
SpreadsheetNumbers.builtInFormat(4);    // '#,##0.00'
SpreadsheetNumbers.builtInFormat(50);   // null
```

### `SpreadsheetNumbers.isDateFormat(formatCode)`

Whether the code shows a date or time (so the number is a date serial): `true` for `m/d/yyyy`,
`[h]:mm`, `yyyy" years"`, `h AM/PM`; `false` for `0.00`, `"d"0`, `0 \m`, `@`, `[$-409]#,##0`.

### `SheetLocale.ENGLISH`

The locale object format() uses by default, American English as Excel's built-in formats are
written: `{ decimal: '.', grouping: ',', months: [12 names from January], shortMonths: [...],
days: [7 names from Sunday], shortDays: [...], am: 'AM', pm: 'PM' }`. Any object of this shape
works as a `locale`; a missing name is taken from English.

### `sheetLocale(lang)`

The locale object for `lang` (a BCP 47 tag such as `'fr-FR'`; `undefined` for the browser's own),
from the browser's `Intl` data, as the app takes it from Java's `DecimalFormatSymbols` and
`DateFormatSymbols`: decimal point, grouping (French gives a narrow no-break space, U+202F),
month names as they read in a date, day names, AM/PM. English when `Intl` doesn't know `lang`.

```js
sheetLocale('fr-FR').months[0];   // 'janvier'
sheetLocale('de-DE').decimal;     // ','
```

### `shortDateCode(lang)`

`lang`'s short date as an Excel format code with the year in full, as Windows writes it: `m/d/yyyy`
(en-US), `dd/mm/yyyy` (en-GB, fr), `d/m/yyyy` (es, hi), `dd.mm.yyyy` (de), `yyyy/mm/dd` (ja).
`m/d/yyyy` when the language's date lacks a day, month or year.

### `new CellNumbers(lang)`

The app's `CellNumbers` (XlsxText.kt): numbers written the way `lang` writes them.

- `.locale`: `sheetLocale(lang)`; `.shortDate`: `shortDateCode(lang)`.
- `.builtIn(id)`: the code of built-in format `id`: the short date for 14, `<short date> h:mm`
  for 22, `builtInFormat(id)` otherwise, General for an id that doesn't exist.
- `.format(value, code, date1904 = false, maxChars = 11)`: `SpreadsheetNumbers.format` with the
  locale (positional, as in Kotlin).
- `.formatText(text, code)`: `SpreadsheetNumbers.formatText`.

```js
const numbers = new CellNumbers('en-GB');
numbers.format(45000.5, numbers.builtIn(22)).text;   // '15/03/2023 12:00'
new CellNumbers('fr-FR').format(1234.5, '#,##0.00').text;   // '1 234,50' (with U+202F)
```

### `daysFromCivil(year, month, day)`

Days from 1 January 1970 to that date in the proleptic Gregorian calendar (negative before 1970),
as the Kotlin's private helper. `daysFromCivil(1900, 3, 1) - daysFromCivil(1899, 12, 31)` is 60.

## `xlsx-model.js`

### `new SheetRange(firstRow, firstColumn, lastRow, lastColumn)`

A block of cells, rows and columns from 0, both ends included. Methods: `contains(row, column)`,
`union(other)` (the smallest range holding both), `intersect(other)` (the shared cells or `null`),
`equals(other)`.

### `SheetRefs`

- `MAX_ROWS` (1,048,576), `MAX_COLUMNS` (16,384, column XFD).
- `column(letters)`: `'A'` → 0, `'xfd'` → 16383; `null` for anything else or past XFD.
- `columnName(index)`: 26 → `'AA'`.
- `cell(ref)`: `'B3'` or `'$B$3'` packed into one number (`pack(row, column)`, row × 2^20 + column),
  or `null` (`'XFE1'`, `'A0'`, `'A1048577'`, `'1A'`). Parsed by hand: it is called for every cell.
- `pack(row, column)`, `rowOf(packed)`, `columnOf(packed)`.
- `range(ref)`: a `SheetRange` for `'A1:C5'`, `'F20:A1'` (either order), `'$A$1'`, whole columns
  `'B:C'` (all rows), whole rows `'$1:$2'` (all columns); `null` otherwise. Surrounding spaces are fine.
- `areas(formula)`: a defined name's areas (print area, print titles), each `{ sheet, range }`
  (Kotlin's `Pair<String?, SheetRange>`); `sheet` is unquoted (`'It''s'` → `It's`), `null` when
  the part names none. Parts that aren't ranges (`#REF!`) are left out; commas and `!` inside quotes
  don't split.

```js
SheetRefs.cell('$AB$3') === SheetRefs.pack(2, 27);   // true
SheetRefs.areas("'Sales 2024'!$A$1:$F$20,'Sales 2024'!$1:$2");
// [{ sheet: 'Sales 2024', range: SheetRange(0, 0, 19, 5) }, { sheet: 'Sales 2024', range: SheetRange(0, 0, 1, 16383) }]
```

### `SheetUnits`

- `DIGIT_WIDTH`: 7 (Calibri 11's widest digit in pixels).
- `columnPoints(width, digitWidth = 7)`: a `<col width>` in points, as Excel draws it in whole pixels
  (0 for 0, negative or NaN; widths over 255 count as 255). `columnPoints(9.140625)` → 48.
- `defaultColumnPoints(baseWidth, digitWidth = 7)`: `<sheetFormatPr baseColWidth>` (8 when absent)
  as points: `defaultColumnPoints(8)` → 48 (64 pixels).
- `digitWidth(name, size)`: the default font's widest digit in pixels: 7 for Calibri 11, Aptos Narrow
  11, Arial 10. (A NaN size, which the app's style reader never passes, counts as 1.)
- `digitEm(name)`: how wide an Office font's digits are as a share of its size (`'Calibri'` → 0.507,
  `'Arial'` → 0.556), or `null` for a font it doesn't know; the converter scales device fonts by it.

### `SheetPages`

- `MIN_SCALE` 10, `MAX_SCALE` 400 (percent).
- `bands(sizes, space, { scale = 1, breaks, titleSize = 0, titleEnd = -1 } = {})`: splits row
  heights or column widths (points, before `scale`) into pages of `space` points; returns the first
  index of each band. `breaks` (a `Set` or array of indices) start pages; a band starting after
  `titleEnd` has `titleSize × scale` less room (repeated titles; `titleEnd < 0`: every band). A row
  too big for a page gets one of its own; hidden rows (size 0) take no room.
  `bands(new Array(10).fill(15), 60)` → `[0, 4, 8]`.
- `count(sizes, space, options)`: how many bands, without keeping them.
- `fitScale(widths, heights, width, height, pagesWide, pagesTall, { columnBreaks, rowBreaks,
  columnTitle = [0, -1], rowTitle = [0, -1], most = 100 } = {})`: Excel's Fit to, the largest whole
  percent up to `most` (10..400) at which the columns fit `pagesWide` pages and the rows `pagesTall`
  (0 leaves that side free), never below 10. `columnTitle`/`rowTitle` are `[size, end]` (Kotlin's
  `Pair`). `fitScale(new Array(20).fill(48), rows, 480, 700, 1, 0)` → 50.
- `order(pages, downThenOver)`: `pages` as `[rowBand, columnBand]` pairs sorted in print order
  (down then over is Excel's default, `pageSetup pageOrder="downThenOver"`); returns a new array.

### `SheetPaper`

- `size(code)`: `pageSetup paperSize` → `[shortSide, longSide]` in points (9 is A4,
  `[595.28, 841.89]`; 1 is Letter, `[612, 792]`), or `null` for a code it doesn't know.
- `length(text)`: `paperWidth`/`paperHeight` such as `'210mm'`, `'21cm'`, `'8.5in'`, `'612pt'` in
  points; `null` for anything else or outside `MIN_SIDE` (72) to `MAX_SIDE` (14,400).

### `SheetColors`

- `indexed(index)`: the default 64-colour palette as ARGB; 64 is black (text), 65 white
  (background); `null` for others. `indexed(10)` → `0xFFFF0000`.
- `themeKey(index)`: the theme colour `<color theme>` means: `'lt1'`, `'dk1'`, `'lt2'`, `'dk2'`,
  `'accent1'`..`'accent6'`, `'hlink'`, `'folHlink'` (background before text, as Excel counts), or `null`.
- `tint(argb, tint)`: lighter (up to 1) or darker (down to -1) as Excel tints, with the app's 32-bit
  float rounding: `tint(0xFFFF0000, 0.5)` → `0xFFFF8080`, `tint(0xFFFF0000, -0.5)` → `0xFF800000`.
- `rgb(text)`: `rgb="FF4472C4"` or `"4472C4"` as opaque ARGB, the alpha byte ignored; `null` otherwise.
- `hex(text)`: `"4472C4"` or `"#4472C4"` as opaque ARGB, or `null` (OfficeColors.hex).

### `SheetDates.serial(iso, date1904 = false)`

A cell of type `d` (`'2024-03-15'`, `'2024-03-15T10:30:00'`, `'10:30:00'`, a trailing `Z` allowed)
as Excel's serial number, or `null`. `serial('1900-03-01')` → 61 (after the false 29 February),
`serial('06:00:00')` → 0.25, `serial('1904-01-01', true)` → 0.

### `SheetStrings.unescape(text)`

`_xHHHH_` back to characters (`_x000D_` is a carriage return, `_x005F_` the underscore), as in
shared strings, inline strings and headers. `unescape('Line_x000D_\nnext')` → `'Line\r\nnext'`.

### `SheetFormulas.shift(formula, rows, columns)`

A shared formula (written once for its first cell) as it reads `rows` down and `columns` across:
relative references move, `$` parts don't, quoted text, sheet names and function names stay, and a
reference pushed off the sheet becomes `#REF!`.
`shift('SUM(B1:C1)*$D$1', 1, 0)` → `'SUM(B2:C2)*$D$1'`; `shift('A1+1', -1, 0)` → `'#REF!+1'`.

### `SheetHeaders.parts(code, fields)` and `headerRun(text, look)`

A header or footer code (`&LPage &P of &N&R&D`) as its left, centre and right parts: an array of
three arrays of runs. `fields` is `{ page, pages, sheet, file, date, time }` (Kotlin's
`SheetHeaders.Fields`), what `&P &N &A &F &D &T` stand for on this page (`&P+1`, `&P-2` offset the
page). Text before `&L`/`&C`/`&R` is the centre's; each part starts in the default look. A run is
`{ text, bold, italic, underline, strike, baseline (1 raised, -1 lowered, 0), size (points or null),
font (or null), color (RGB without alpha, or null for black) }`; `headerRun(text, look)` makes one
with the defaults. Codes: `&B &I &U &E &S &X &Y` toggle, `&"Arial,Bold"` font and style (`-` keeps
the font), `&12` size (1 to 409), `&KFF0000` colour, `&&` an ampersand; pictures (`&G`) and `&Z`
show nothing.

```js
SheetHeaders.parts('&L&"Arial,Bold"&A&CPage &P of &N', { page: 2, pages: 5, sheet: 'Sales', file: 'Q3.xlsx', date: '1/2/26', time: '9:30' });
// [[{ text: 'Sales', bold: true, font: 'Arial', ... }], [{ text: 'Page 2 of 5', ... }], []]
```

## Helpers (`xlsx-numbers-kt.js`, `xlsx-numbers-decimal.js`)

Used by the two modules above, exported for their tests and for the converter if it wants Kotlin's
text rules: `isDigit`, `isLetter`, `isLetterOrDigit`, `isWhitespace`, `trim`, `isBlank` (Kotlin's
Unicode rules, which differ from JavaScript's `trim()`), `toIntOrNull(s, radix)` and
`toDoubleOrNull(s)` (what Kotlin's `"..".toIntOrNull()` and `.toDoubleOrNull()` accept: signs,
digits of any script, `1.5d`, `0x1p3`, `NaN`), `digitOf(c, radix)` (Java's `Character.digit`),
`toInt`, `roundToInt`, `coerceIn`. `Decimal` is an exact decimal (a BigInt and a scale, like Java's
BigDecimal) with `fromNumber`, `round(digits)`, `setScale(n, 'half-up' | 'floor')`, `movePoint(n)`,
`toPlainString()`.

## Where a browser differs from the app

- Month and day names, decimal and grouping signs come from the browser's `Intl` data instead of
  Android's. For English, French, Spanish and Hindi they match Java's, except that Spanish "a. m."
  has a narrow no-break space where Java has a no-break space; a few other languages differ slightly
  (Finnish day names, Thai AM/PM, Swiss grouping).
- Which language: the app uses the phone's format locale; pass `navigator.language` (or the
  converter's choice) to `CellNumbers`.
