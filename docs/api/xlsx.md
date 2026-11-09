# Excel to PDF (`site/app/js/engine/office/xlsx.js` and `xlsx-*.js`)

Workbooks (.xlsx, and .xlsm and templates, whose macros are left alone) turned into PDFs the way
Excel prints them, on the device. A port of the app's `data/office/XlsxConverter.kt`,
`XlsxSheet.kt`, `XlsxPages.kt`, `XlsxStyles.kt` and the `CellTexts` class of `XlsxText.kt`. Number
formats, references, page splitting, paper sizes, colours and header codes are the numbers
engineer's (`xlsx-numbers.js`, `xlsx-model.js`: see [xlsx-numbers.md](xlsx-numbers.md)); text and
drawing are the text engine's ([text.md](text.md)); zips, XML, themes, pictures and the PDF are
office-core's ([office-core.md](office-core.md)).

- Each visible sheet with anything on it starts a page; its print area (or everything from A1)
  goes onto pages down and then across (or over and then down), with its title rows and columns
  repeated, its manual page breaks, paper size, orientation, margins, centring, scale or Fit to.
  Pages are numbered through the whole PDF, and pages with nothing on them are left out.
- Cells show their values as their number formats show them (red negatives, dates, times,
  currencies, fractions...), and formulas their last values (a formula the file kept no value for
  shows itself, `=A2*2`; shared formulas are moved to each cell). Fonts, sizes, bold, italic,
  underlined (once or twice), struck-through, raised and lowered text, colours, rich text; fills
  (patterns and gradients as one colour), borders of every style, alignment, indents, wrapped,
  justified, shrunk, turned and stacked text; text running on into empty cells; Center Across
  Selection, Fill; merged cells; column widths and row heights (rows grow to fit wrapped text and
  larger fonts); hidden rows, columns and sheets left out; pictures placed on the sheet; headers
  and footers with page numbers, page counts, dates, times, sheet and file names; light gridlines.
- Left out, as in the app: charts, shapes, text boxes, comments, conditional formatting (the
  values data bars and icon sets hide stay hidden), table styles, sparklines, header pictures.

## Converting: use the dispatcher

Screens call office-core's dispatcher, which checks the file, loads `xlsx.js`, names the PDF and
turns every failure into the app's message:

```js
import { convertOffice, defaultOfficeOptions, SHEET_PAPERS, SHEET_ORIENTATIONS } from '../../engine/office/index.js';
const options = { ...defaultOfficeOptions('excel'), paper: 'a4', name: 'Budget 2026' };   // { paper: null, landscape: null, fitWidth: true, gridlines: false }
const out = await convertOffice('excel', fileItem, options, {
  signal,
  onProgress: (done, total, info) => dialog.update(info?.compressing ? 1 : done / total, tp('progress_pages', total, done, total)),
});
// out: { name: 'Budget 2026.pdf', bytes, type: 'application/pdf', pageCount }
```

## `xlsx.js`

### `convertXlsx(input, options = {}, hooks = {}) → Promise<{ bytes, pageCount }>`

The converter `index.js` calls (`OFFICE_KINDS.excel.convert`). Call it directly only in tests or
when the file has been checked (`verifyOfficeFile('excel', input)`).

- `input`: `{ name, bytes }` (a FileItem will do). `name` is what `&F` in a header shows.
- `options` (the app's SheetOptions, plus two of the web's own):

| Option | Values | Default | Meaning |
|---|---|---|---|
| `paper` | `null`, `'a4'`, `'letter'`, `'legal'`, `'a3'`, `'a5'` | `null` | `null`: each sheet's own paper (US Letter when a sheet names none); else this paper for every sheet |
| `landscape` | `null`, `false`, `true` | `null` | `null`: each sheet's own orientation (portrait when it names none); `false` portrait, `true` landscape for every sheet |
| `fitWidth` | boolean | `true` | Fit columns to page width: a sheet wider than the page shrinks to fit across it, never below half size (or its own scale, when smaller); a sheet set to Fit to its own way keeps that |
| `gridlines` | boolean | `false` | Light grey lines between the cells of every sheet that shows them on screen. Sheets set to print gridlines always get them |
| `locale` | BCP 47 tag | `navigator.language` | The language numbers, dates (built-in formats 14 and 22, month and day names) and the header date and time are written in: the device's, as the app uses the phone's format locale |
| `now` | `Date` | the current time | What `&D` and `&T` show |

- `hooks`: `{ signal, onProgress(done, total, info) }`: `done` of `total` pages drawn (the total is
  known before the first page is drawn), then `onProgress(n, n, { compressing: true })` while the
  PDF is saved. `signal` cancels (CancelledError) between rows and pages.
- Resolves to `{ bytes, pageCount }`.
- Throws (index.js turns these into the messages below): `OfficeNothingToConvert` (no visible
  sheet has anything to print), `OfficeTooLarge` (more than `MAX_PAGES` pages, more row elements
  than a sheet has rows, or shared strings over 24 million characters), `CancelledError`,
  `XmlError`/`ZipError` for a damaged part (`ZipError('too-large')` for a part too big to read),
  `UserError('web_fonts_unavailable')` when the fonts can't be loaded.

```js
import { convertXlsx } from './xlsx.js';
const { bytes, pageCount } = await convertXlsx({ name: 'Q3.xlsx', bytes }, { paper: 'a4', landscape: true, locale: 'en-GB' }, { signal });
```

### `MAX_PAGES`

5000: a workbook that would make more pages is refused before any is drawn (`office_too_large`).

### `sheetOptions(options) → { paper, landscape, fitWidth, gridlines }`

The options checked as convertXlsx reads them: anything unknown at its default.
`sheetOptions({ paper: 'b5', fitWidth: 0 })` → `{ paper: null, landscape: null, fitWidth: true, gridlines: false }`.

### `areasOf(printArea, used) → SheetRange[]`

The areas of a sheet that print: those of its `_xlnm.Print_Area` formula (each on pages of its
own; whole rows or columns stop where the sheet's cells do; an area named twice prints once), or
A1 to the last cell `used` reaches.
`areasOf('Data!$D:$E', new SheetRange(0, 0, 5, 5))` → `[SheetRange(0, 3, 5, 4)]`.

### `titlesOf(text) → [rows, columns]`

A sheet's `_xlnm.Print_Titles` formula as the rows and columns repeated on every page, each
`[first, last]` (from 0) or null. `titlesOf("'Sales'!$1:$2,'Sales'!$A:$A")` → `[[0, 1], [0, 0]]`.

## Errors and strings

What a screen shows comes from `convertOffice` (`officeErrorKey`); keys and English texts from
strings.xml:

| Key | English |
|---|---|
| `office_no_sheets` / `_many` | This workbook has nothing to convert. Hidden sheets are left out. / These workbooks have nothing to convert. Hidden sheets are left out. |
| `office_too_large` / `_many` | This workbook is too big to convert on a phone. Set a print area for the part you need in Excel or another app, then try again. / These workbooks are too big to convert on a phone. Set a print area for the part you need in Excel or another app, then try again. |
| `office_convert_failed` | Couldn't convert this file. Check the file and free storage. |
| `web_fonts_unavailable` | Usugami couldn't load its fonts. Check your connection and try again. |

Checking a file gives `office_not_excel`, `office_legacy_excel` and `office_encrypted_excel` (see
office-core.md). The Excel to PDF screen's own strings (strings.xml): `sheet_as_file` "As in the
file", `option_page_size`, `option_orientation`, `size_a4` "A4", `size_letter` "US Letter",
`size_legal` "US Legal", `size_a3` "A3", `size_a5` "A5", `orientation_portrait` "Portrait",
`orientation_landscape` "Landscape", `sheet_fit_width` "Fit columns to page width",
`sheet_fit_width_on` "Wide sheets shrink so their columns fit across the page, but never below half
size.", `sheet_fit_width_off` "Columns that don't fit go on more pages, as Excel prints them.",
`sheet_gridlines` "Gridlines", `sheet_gridlines_detail` "Light gray lines between cells, as on
screen. Borders, and gridlines a sheet is set to print, always show.", `office_note_excel` "Each
sheet starts a new page, as Excel prints it; hidden sheets are left out. Your phone's fonts stand in
for the workbook's, and charts are left out." (the web app may say "the app's fonts").

## The helpers

Exported for the converter and its tests; names as in the Kotlin. Lengths are points, rows and
columns count from 0, colours are ARGB numbers (0 to 0xFFFFFFFF), rectangles are
`{ left, top, right, bottom }` and ranges of rows or columns `[first, last]`.

### `xlsx-styles.js` (XlsxStyles.kt)

```js
const styles = await SheetStyles.read(pkg, pkg.targetOfType(main, '/styles'), theme, new CellNumbers('en-US'));
const format = styles.format(3);          // CellFormat; format 0 (Normal) for one that doesn't exist
format.numberFormat;                      // '0.0%' (built-in ids as CellNumbers.builtIn gives them)
format.font;                              // SheetFont { name, size, bold, italic, underline, strike, color, baseline, doubleUnderline, key, style }
format.fill;                              // ARGB or null (patterns blended, gradients halfway)
format.borders;                           // CellBorders { left, top, right, bottom, diagonalUp, diagonalDown } (CellLine or null), or null
format.horizontal; format.vertical;       // SheetAlign.* / SheetVAlign.*
format.wrap; format.wraps; format.indent; format.shrink; format.rotation; format.showsEmpty;
styles.defaultFont;                       // the Normal font (theme minor font, Calibri 11 without styles)
styles.palette.argb(color);               // SheetPalette: a SheetColor as ARGB, or null (automatic)
```

- `SheetStyles.read(pkg, path, theme, numbers) → Promise<SheetStyles>`; `format(index) → CellFormat`.
  Each list is read up to 65,536 entries. Throws XmlError for a damaged part.
- `SheetColor.read(xmlNode) → SheetColor { rgb, theme, indexed, tint, auto }`;
  `new SheetPalette(theme, customColors).argb(color) → number | null`.
- `SheetFont` (`SheetFont.DEFAULT` is Calibri 11 black; `copy(changes)`; `.style` the text
  engine's style); `FontProps.read(xmlNode)` (a `font` or `rPr`) and `props.over(baseFont, palette, theme) → SheetFont`.
- `CellLine.of(style, color) → CellLine { width, color, dashes, double } | null`:
  `CellLine.of('thin', 0xff000000).width` → 0.6; `'dashed'` → dashes `[2.25, 0.75]`; `'double'` → `double: true`.
- `SheetAlign` (`GENERAL`, `LEFT`, `CENTER`, `RIGHT`, `FILL`, `JUSTIFY`, `CENTER_ACROSS`,
  `DISTRIBUTED`), `SheetVAlign` (`TOP`, `CENTER`, `BOTTOM`, `JUSTIFY`, `DISTRIBUTED`),
  `CellKind` (`NUMBER`, `TEXT`, `BOOLEAN`, `ERROR`, `FORMULA`): string constants.
- `new SheetText(text, runs)`, `new TextRun(start, end, fontProps)`.
- `SharedStrings.read(pkg, path, pace) → Promise<SharedStrings>`; `.get(index) → SheetText | null`;
  `.size`; `SharedStrings.NONE`. Throws OfficeTooLarge past `MAX_SHARED_CHARS` (24,000,000).
- `readItem(xmlNode) → SheetText`: an `si` or an inline `is` (runs with their `rPr`; phonetic
  guides left out; `_xHHHH_` unescaped).
- `BLACK` (0xFF000000), `WHITE` (0xFFFFFFFF).

### `xlsx-sheet.js` (XlsxSheet.kt)

```js
const planner = new SheetPlanner(pkg, styles, strings, texts, theme, date1904, new Pace(signal));
const plan = await planner.plan('Sales', 'xl/worksheets/sheet1.xml');
plan.used;                  // SheetRange of everything that prints, or null (nothing to print)
plan.columns.width(2);      // ColumnWidths: points, 0 when hidden; offset(c), columnAt(x), format(c)
plan.rows.height(9);        // RowHeights: points, 0 when hidden; offset(r), rowAt(y)
plan.merges; plan.pictures; plan.rowBreaks; plan.columnBreaks; plan.valuesHidden;
plan.setup;                 // { paper: [short, long] | null, landscape, scale, fitToPage, fitWidth, fitHeight, margins,
                            //   centerHorizontally, centerVertically, downThenOver, firstPageNumber, headerFooter }
plan.content.any(top, bottom, left, right);   // RowContent: rows with something in those columns?
plan.gridlinesShown; plan.gridlinesPrinted;
```

- `SheetPlanner.plan(name, part) → Promise<SheetPlan>`: the first pass: column widths (from the
  default font's digit width), row heights (rows grow to fit wrapped text, rich text and larger
  fonts unless set by hand; merged cells don't grow rows), what prints (`used`, with text running
  on past the last cell, merged blocks and pictures), page setup, margins, header and footer,
  breaks, the drawing's pictures, the cells data bars hide. Throws OfficeTooLarge for more row
  elements than a sheet has rows.
- `new RowReader(sharedStrings, date1904)`: `read(rowElement) → SheetRow { index, cells, format,
  height, custom, hidden }` (cells: `SheetCell { column, format, kind, number, text }`, in order,
  one per column, the last given); `skim(rowElement, anchors, kept) → index` (goes past a row,
  keeping shared formulas and the cells of `anchors`, packed references, in the Map `kept`);
  `indexOf(rowElement) → index`. Rows and cells without references follow the ones before them.
- `new ColumnWidths(widths, formats, tailWidth, tailFormat)`, `new RowHeights(rows, heights, default)`,
  `new RowContent(rows, first, last)` (`start(row)`, `any(...)`, `forEach(top, bottom, fn(row, first, last))`).
- `SheetPicture { path, crop, rect }`, `SheetMargins { left, right, top, bottom, header, footer }`, `SheetPlan`.
- `pictureCells(picture, rows, columns) → SheetRange`: the cells a picture covers.
- `binarySearch(sortedArray, key, from?, to?) → index | -(insertion) - 1` (Kotlin's).
- `MAX_ROW_HEIGHT` (409.5). `CellKind` and `CellTexts` are re-exported.

### `xlsx-text.js` (XlsxText.kt's CellTexts)

```js
const texts = new CellTexts(styles, theme, numbers, date1904);
const shown = texts.shown(cell, styles.format(cell.format), plan.columns.width(cell.column));
// ShownText { text (string, or RichText for rich text), font, color, align (General resolved), number, rich, plain, isEmpty }
await texts.ensure([shown]);                  // loads the fonts it needs (measuring and drawing are synchronous)
texts.width(shown);                           // points on one line
texts.height(shown, format, cellWidth);       // what the row needs
texts.draw(canvas, shown, format, { left, top, right, bottom }, clip);   // on a PdfCanvas
```

- `shown(cell, format, width) → ShownText | null`: numbers in their format (General in as many
  characters as fit `width`), text through its format's text section (line breaks as spaces unless
  wrapped; at most 32,767 characters), TRUE/FALSE, errors. Cached per cell and width.
- `width(shown)`, `height(shown, format, boxWidth)`, `room(shown, format, boxWidth)`,
  `paragraph(shown, format, width) → ParagraphLayout`, `lineHeight(font)` (15 for Calibri 11),
  `lineFactor(font)`, `digit(font)`, `widthScale(font)`, `lineStyle(font)`, `runStyle(font, color)`,
  `measureWidth(text, style)`, `indentStep` (7.5 points for an 11-point default font).
- `draw(canvas, shown, format, box, clip)`: wrapped, justified and stacked text as a paragraph;
  turned text about the cell's middle; one line otherwise (numbers too wide as `#`, Fill repeated,
  shrunk to fit, double underlines drawn under it), cut off at `clip`. Only the letters of a long
  text that can show (and eight more each side) go into the PDF.
- `ready(shown) → boolean`, `ensure(showns) → Promise`, `require(shown)` (throws `FontsNeeded`
  with `.runs` for `ensureFonts`), `runsOf(shown)`.
- `PAD` (1.5), `STACKED` (255), `MAX_CELL_CHARS` (32,767), `lines(text, wraps)`, `intersect(a, b)`
  (Android's RectF.intersect: null when they don't overlap), `rect(left, top, right, bottom)`.

### `xlsx-pages.js` (XlsxPages.kt)

```js
const layout = await AreaLayout.of(plan, area, [titleRows, titleColumns], { paper: null, landscape: null, fitWidth: true }, MAX_PAGES, pace);
layout.pageWidth; layout.pageHeight; layout.scale;   // points; 0.1 to 4
layout.rowStarts; layout.columnStarts;               // first row (column) of each band
layout.pages;                                        // [[rowBand, columnBand], ...] in print order, empty pages left out
layout.margins;                                      // SheetMargins as laid out (shrunk together when over 90% of the paper)
const painter = new SheetPainter(styles, texts, images, gridlines);
await painter.prepare(layout, rowBand, columnBand, new PageCells(rowsByIndex, anchors));   // fonts and pictures
painter.draw(canvas, layout, rowBand, columnBand, cells);
await painter.drawHeaderFooter(canvas, layout, numberInSheet, pageNumber, pageCount, (page, pages) => ({ page, pages, sheet, file, date, time }));
```

- `AreaLayout.of(plan, area, titles, options, limit, pace) → Promise<AreaLayout>`: paper and
  orientation (options over the sheet's), margins, Fit to or scale or Fit columns to page width
  (`MIN_FIT_WIDTH` 50 %), titles (not repeated when over half a page), breaks (ignored by Fit to,
  and column breaks by a sheet fitted one page across); throws OfficeTooLarge past `limit` pages.
  `rowEnd(band)`, `columnEnd(band)`, `repeatsRows(band)`, `repeatsColumns(band)`,
  `pagesWithContent(downThenOver, limit, pace)`.
- `new PageCells(rows, anchors).cell(row, column) → SheetCell | null`.
- `SheetPainter`: `parts(layout, rowBand, columnBand) → [rowParts, columnParts]`,
  `pageMerges(plan, rowParts)`, `prepare(...)`, `draw(...)` (fills, gridlines, borders, text,
  pictures, in that order, as Excel prints), `place(plan, row, area, merges)` (where each cell's
  text goes), `drawGrid(...)`, `drawHeaderFooter(...)`, `drawHeaderParts(...)`.

### `xlsx-pace.js`

`new Pace(signal, budget = 30)`: `check() → boolean` (throws CancelledError when cancelled; true
once `budget` ms have gone by), `breathe() → Promise` (yieldToUI, then checks again).
`if (pace.check()) await pace.breathe();` in long loops.

## Where the browser differs from the app

- The bundled Noto fonts stand in for the workbook's (the app uses the phone's), drawn to the
  Office font's width as the app does. Their lines are a little taller than Roboto's, so text sits
  a little higher in its cell; rows are as tall as in the app.
- Characters no bundled font has (Chinese, Japanese, emoji...) are drawn by the browser as
  pictures, with their text kept (text engine).
- The sheet's XML is read with the browser's DOMParser instead of the app's pull parser: each
  sheet is parsed twice (to lay it out, then to draw it) rather than read once per run of pages,
  and only the rows of the page being drawn are read in full.
- The app's PagedPdf memory budget and TextScales/EmbeddedFonts passes aren't needed (text engine).
- Numbers and dates are written in the browser's language (or `options.locale`), with Intl's data
  (see xlsx-numbers.md); the header date and time are Intl's short date and time.
- Text that ends in spaces: the text engine leaves trailing spaces out of a line's width, where
  Android's Canvas.drawText counts them, so right-aligned text ending in spaces sits at the edge.
- A long text cut off at its cell: the app lays out only the part that shows; here the whole line
  is laid out and only the letters that can show (and eight more each side) are written.
