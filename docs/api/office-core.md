# Office core (`site/app/js/engine/office/`)

The shared core of Word, PowerPoint, Excel and EPUB to PDF, and the dispatcher every converter
screen calls. It ports the app's `data/office/Ooxml.kt`, `DrawingML.kt`, `OfficeTables.kt`,
`OfficePdf.kt`, `OfficeConverter.kt` (its problems and checks), the `Block`/`StackBlock`/
`StandInPicture` parts of `OfficeText.kt`, the a:xfrm, a:custGeom and shape drawing of
`PptxConverter.kt`, and `core/OfficeFormats.kt` and `core/XmlTokenGuard.kt`.

| Module | What |
|---|---|
| [`index.js`](#indexjs-the-dispatcher) | `convertOffice`, `verifyOfficeFile`, `officeKindOf`, and all of `kinds.js` |
| [`kinds.js`](#kindsjs) | `OFFICE_KINDS`, options, names, `officeErrorKey`: nothing heavy, for the screens to load at once |
| [`problems.js`](#problemsjs) | `OfficeFileProblem` and its kinds (thrown by converters) |
| [`zip.js`](#zipjs) | `ZipArchive`: reading zips with limits against zip bombs |
| [`xml-guard.js`](#xml-guardjs) | `XmlTokenGuard`, `decodeXml`, `guardXml`: checks before the browser's XML parser |
| [`ooxml.js`](#ooxmljs) | `OfficePackage`, `XmlNode`, `parseXml`, `Ns`: parts, relationships, elements |
| [`office-formats.js`](#office-formatsjs) | `OfficeUnits`, `ListNumbering`, `SymbolFonts`, `TableColumns`, `TabStops`, `PageBreaking`, `OfficeRect`, `GroupFrame`, `SlideTableStyles`, `paperSize` |
| [`colors.js`](#colorsjs) | `OfficeColors`: hex, highlights, presets, lumMod/lumOff/tint/shade..., `isDark` |
| [`drawingml.js`](#drawingmljs) | themes, colours, fills, outlines, arrowheads, preset and freeform shapes, transforms, `drawShape` |
| [`path-measure.js`](#path-measurejs) | `PathMeasure` (Android's) for PdfPaths |
| [`blocks.js`](#blocksjs) | the Block interface, `StackBlock`, `Spaced`, `EmptyBlock` |
| [`tables.js`](#tablesjs) | `Border`, `CellBox`, `RowBlock`, `TableBlock` |
| [`office-pdf.js`](#office-pdfjs) | `OfficePdf` (pages), `OfficeImages`, `ImagePicture`, `StandInPicture`, `BitmapPicture`, `inlinePicture`, `deflateBelow` |
| [`pause.js`](#pausejs) | `pause()`: a breath in long work that a tab in the background doesn't slow down |

Conventions, everywhere below:
- **Lengths are points**, origin at the top-left, y down (the app's tenths of a point are gone).
- **Colours are ARGB numbers** from 0 to 0xFFFFFFFF, never negative (opaque red `0xFFFF0000`),
  as the text engine (`fillStyle = 0xFF336699`) and the spreadsheet engine take them.
- **Rectangles** are `{ x, y, width, height }` (an `OfficeRect`), and `{ left, top, right,
  bottom }` (Android's RectF) is accepted wherever a rectangle is drawn into.
- Kotlin's `Pair`/`Triple` become arrays (`[x, y]`), `Map<String, …>` a `Map`, data classes
  classes or plain objects with the same field names; `copy(changes)` where Kotlin used `copy`.
- Numbers are Kotlin's: Float arithmetic is emulated where results are compared exactly (colours,
  units, group frames), and attribute numbers read as Kotlin's `toIntOrNull`/`toDoubleOrNull` do.

---

## Writing a converter (`docx.js`, `pptx.js`, `xlsx.js`, `epub.js`)

`index.js` imports `./docx.js`, `./pptx.js`, `./xlsx.js` and `./epub.js` when first needed and
calls their `convertDocx`, `convertPptx`, `convertXlsx` and `convertEpub`. Nothing in `index.js`
changes when they are written.

```js
// ./pptx.js
import { OfficePackage } from './ooxml.js';
import { OfficePdf, OfficeImages } from './office-pdf.js';
import { OfficeTheme, drawShape } from './drawingml.js';
import { OfficeNothingToConvert } from './problems.js';
import { checkCancelled } from '../../core/errors.js';

/**
 * @param {{ name: string, bytes: Uint8Array }} input   checked already: a .pptx of the right kind
 * @param {object} options   defaultOfficeOptions('powerpoint') with the screen's choices (and `name`)
 * @param {{ onProgress?, signal? }} hooks
 * @returns {Promise<{ bytes: Uint8Array, pageCount: number }>}   (or just the bytes)
 */
export async function convertPptx(input, options, hooks = {}) {
  const pkg = await OfficePackage.open(input.bytes, hooks);       // hooks.signal stops reading
  const pdf = await OfficePdf.create();
  const images = new OfficeImages(pkg, pdf.doc, hooks);
  const theme = await OfficeTheme.read(pkg, pkg.targetOfType(pkg.mainPart(), '/theme'));
  // ... read the slides; none left: throw new OfficeNothingToConvert();
  for (const [i, slide] of slides.entries()) {
    checkCancelled(hooks.signal);
    const canvas = pdf.startPage(slideWidth, slideHeight);   // a PdfCanvas
    // ... draw
    pdf.finishPage();
    hooks.onProgress?.(i + 1, slides.length);   // Word: (page, null), its total being unknown
    await pause();                              // ./pause.js: let the page breathe between pages
  }
  return pdf.finish(hooks);   // { bytes, pageCount }; tells onProgress(n, n, { compressing: true })
}
```

- Throw the `problems.js` classes for what the app says to the user (`OfficeNothingToConvert`,
  `OfficeEmbeddedContent`, `OfficeTooLarge`, `EpubProtected`...); `convertOffice` turns them into
  the app's message for the kind. Any other error becomes `office_convert_failed`.
- `CancelledError` (from `checkCancelled(hooks.signal)`) passes through quietly.
- `epub.js` may also export `verifyEpub(input, hooks)`, the app's EpubBook.read check at import:
  throw `OfficeNotRecognized`, `EpubProtected` or `OfficeNothingToConvert`. Without it, an e-book
  is only checked to be a readable zip before `convertEpub` runs.
- Fonts, text and drawing: the text engine (`docs/api/text.md`). Pictures: `OfficeImages`.

---

## `index.js`: the dispatcher

```js
import { convertOffice, verifyOfficeFile, officeKindOf, defaultOfficeOptions, officeErrorKey } from '../../engine/office/index.js';
```

<a id="kindsjs"></a>The kinds, options, names and `officeErrorKey` below live in `kinds.js` (re-exported by
`index.js`), which imports only `core/errors.js`, `core/names.js` and `problems.js`: a screen imports
them from there to show itself at once, and `index.js` (ZIP and XML reading, fflate, and through
the converters pdf-lib and the fonts) with `import()` while the user picks a file, as
`js/tools/office/index.js` does.

### `convertOffice(kind, input, options = {}, hooks = {}) → Promise<OutputFile>`

Converts `input` (`{ name, bytes }`, a FileItem will do) of `kind` (`'word'`, `'powerpoint'`,
`'excel'`, `'epub'`) into a PDF, as the app's `OfficeConverter.convert`: checks the file
(`verifyOfficeFile`), loads the kind's converter, runs it, names the PDF.

- `options`: the kind's options (below), plus `name`: the PDF's name as typed, without `.pdf`
  (default: the file's own name, "Report.docx" → "Report.pdf"). Checked with `officeOptions`.
- `hooks`: `{ onProgress(done, total, info), signal }`. `done` of `total` pages (Excel), slides
  (PowerPoint) or chapters (EPUB); for Word `total` is `null` (the page count isn't known until the
  end: the app shows "Page 3"). Last comes `onProgress(n, n, { compressing: true })` while the PDF
  is saved (the app's "Creating and compressing PDF…" bar, full).
- Resolves to `{ name, bytes, type: 'application/pdf', pageCount }`.
- Throws `UserError` with the app's message (see [Errors](#errors-and-strings)), `CancelledError`
  when `hooks.signal` aborts, `RangeError` for an unknown kind.

```js
const out = await convertOffice('excel', fileItem, { paper: 'a4', name: 'Budget 2026' }, {
  signal, onProgress: (done, total) => dialog.update(total ? done / total : null, tp('progress_pages', total, done, total)),
});
// out.name === 'Budget 2026.pdf'
```

### `verifyOfficeFile(kind, input, hooks = {}) → Promise<void>`

The app's check when a file is picked or shared (`OfficeConverter.verify`): resolves when `input`
is a `kind` file that can be converted, throws `UserError` (its `key` for one file, `manyKey` for
several) otherwise. Reads only the start of the main part, so it is quick even for large files.
Old binary files (`.doc`, `.ppt`, `.xls`) and password-protected ones get their own messages.

```js
try { await verifyOfficeFile('word', item); }
catch (e) { if (e.name !== 'CancelledError') snackbar(t(e.key)); }
```

### `officeKindOf(fileItem) → 'word' | 'powerpoint' | 'excel' | 'epub' | null`

By content, then name, then type (`core/files.js`'s `fileKind`). Old `.doc`/`.ppt`/`.xls` files
count as their kind, so converting one says how to save it in the new format.

### Options

```js
defaultOfficeOptions('word')        // {}
defaultOfficeOptions('powerpoint')  // {}
defaultOfficeOptions('epub')        // { bookPage: 'a5' }            'a5' or 'a4' (BookPageOptions)
defaultOfficeOptions('excel')       // { paper: null, landscape: null, fitWidth: true, gridlines: false }  (SheetOptions)
officeOptions(kind, options)        // options checked, defaults filled in, unknown fields kept
```

- Excel `paper`: `null` (as each sheet says), `'a4'`, `'letter'`, `'legal'`, `'a3'`, `'a5'`;
  `landscape`: `null` (as each sheet says), `false` (portrait), `true` (landscape); `fitWidth`:
  "Fit columns to page width" (on); `gridlines`: "Gridlines" (off). Sizes: `paperSize(id, landscape)`.
- The choices as the app lists them, with their labels' string keys:
  `BOOK_PAGES` (`[{ value: 'a5', label: 'size_a5' }, { value: 'a4', label: 'size_a4' }]`),
  `SHEET_PAPERS` (`null`: `sheet_as_file`, then `size_a4`, `size_letter`, `size_legal`, `size_a3`,
  `size_a5`), `SHEET_ORIENTATIONS` (`null`: `sheet_as_file`, `false`: `orientation_portrait`,
  `true`: `orientation_landscape`).

### Names

```js
officeOutputName({ name: 'Report.docx' }, 'word')              // 'Report.pdf'
officeOutputName({ name: 'Report.docx' }, 'word', 'My: plan?') // 'My_ plan_.pdf'
officeOutputName({ name: '' }, 'excel')                        // 'Spreadsheet.pdf'
officeOutputNames(inputs, 'word', ['Garden report', null, 'garden report'])
                                   // ['Garden report.pdf', 'b.pdf', 'garden report (2).pdf'] (convertEach)
```
Blank names fall back to the kind's `fallbackName`: Document, Presentation, Spreadsheet, Book.

### `officeErrorKey(error, kind, many = false) → string`

The string key for any error from `verifyOfficeFile`/`convertOffice` (or a `problems.js` error):
the message of one file, or with `many` of several. Errors that aren't about the file give
`office_convert_failed`. For several files, the app names them: `t('file_problem', names, t(key))`.

### `OFFICE_KINDS`

`{ word, powerpoint, excel, epub }`, each `{ id, extension, fallbackName, accept, module, convert }`
(`accept` is the `pickFiles({ accept })` kind: `'docx'`, `'pptx'`, `'xlsx'`, `'epub'`).

### Errors and strings

`convertOffice` and `verifyOfficeFile` throw `UserError(key)` with `error.manyKey` (the `_many`
key, when there is one) and `error.problem` (the problem's kind). Put these in the screen's
strings (keys and texts from strings.xml):

| Key | English (one file) | Key `_many` (several) |
|---|---|---|
| `office_legacy_word` | This is an old Word file (.doc). Save it as .docx in Word or another app, then try again. | These are old Word files (.doc). Save them as .docx in Word or another app, then try again. |
| `office_legacy_powerpoint` | This is an old PowerPoint file (.ppt). Save it as .pptx in PowerPoint or another app, then try again. | These are old PowerPoint files (.ppt). Save them as .pptx in PowerPoint or another app, then try again. |
| `office_legacy_excel` | This is an old Excel file (.xls). Save it as .xlsx in Excel or another app, then try again. | These are old Excel files (.xls). Save them as .xlsx in Excel or another app, then try again. |
| `office_encrypted` | This file is protected with a password. Remove the password in Word or PowerPoint, save the file, then try again. | These files are protected with a password. Remove the password in Word or PowerPoint, save the files, then try again. |
| `office_encrypted_excel` | This file is protected with a password. Remove the password in Excel, save the file, then try again. | These files are protected with a password. Remove the password in Excel, save the files, then try again. |
| `office_not_word` | This isn't a Word document (.docx), or it's damaged. | These aren't Word documents (.docx), or they're damaged. |
| `office_not_powerpoint` | This isn't a PowerPoint presentation (.pptx), or it's damaged. | These aren't PowerPoint presentations (.pptx), or they're damaged. |
| `office_not_excel` | This isn't an Excel workbook (.xlsx), or it's damaged. | These aren't Excel workbooks (.xlsx), or they're damaged. |
| `epub_not_recognized` | This isn't an EPUB e-book, or it's damaged. | These aren't EPUB e-books, or they're damaged. |
| `epub_protected` | This book is protected with DRM (copy protection), so Usugami can't read it. Only books without DRM can be converted. | These books are protected with DRM (copy protection), so Usugami can't read them. Only books without DRM can be converted. |
| `office_no_slides` | This presentation has no slides to convert. Hidden slides are left out. | These presentations have no slides to convert. Hidden slides are left out. |
| `office_no_sheets` | This workbook has nothing to convert. Hidden sheets are left out. | These workbooks have nothing to convert. Hidden sheets are left out. |
| `epub_empty` | This book has nothing to convert. | These books have nothing to convert. |
| `office_embedded_content` | This document keeps its text as a web page or RTF file inside it, which Usugami can't convert. Open it in Word, save it, then try again. | These documents keep their text as a web page or RTF file inside them, which Usugami can't convert. Open them in Word, save them, then try again. |
| `office_too_large` | This workbook is too big to convert on a phone. Set a print area for the part you need in Excel or another app, then try again. | These workbooks are too big to convert on a phone. Set a print area for the part you need in Excel or another app, then try again. |
| `office_convert_failed` | Couldn't convert this file. Check the file and free storage. | — |

Also passed through: the text engine's `web_fonts_unavailable` ("Usugami couldn't load its fonts.
Check your connection and try again."). Which problem gives which key: `legacy` →
`office_legacy_<kind>` (PowerPoint's for EPUB); `encrypted` → `office_encrypted` (Excel:
`office_encrypted_excel`); `not-recognized` → `office_not_<kind>` / `epub_not_recognized`;
`nothing` → `office_no_slides` (Word and PowerPoint), `office_no_sheets`, `epub_empty`;
`too-large` → `office_too_large`; `embedded` → `office_embedded_content`; `protected` →
`epub_protected`. A converter's damaged part (a `ZipError` or `XmlError` it doesn't catch) gives
`office_convert_failed`, except an Excel part too large to inflate: `office_too_large`.

Strings the screens need around a conversion (strings.xml): `creating_pdf` "Creating and
compressing PDF…", `creating_pdfs`, `pdf_page_number` "Page %1$d" (Word), `progress_slides`
("%1$d of %2$d slide(s)"), `progress_pages` ("%1$d of %2$d page(s)"), `progress_chapter` "Chapter
%1$d of %2$d", `file_problem` "%1$s: %2$s".

---

## `problems.js`

```js
throw new OfficeNothingToConvert();
```
`OfficeFileProblem(problem, message)` with `problem` one of `'legacy'`, `'encrypted'`,
`'not-recognized'`, `'nothing'`, `'too-large'`, `'embedded'`, `'protected'`, and its subclasses
named as in Kotlin: `OfficeLegacyFormat`, `OfficeEncrypted`, `OfficeNotRecognized`,
`OfficeNothingToConvert`, `OfficeTooLarge`, `OfficeEmbeddedContent`, `EpubProtected` (no
arguments). `officeReasonKey(problem, kind, many = false)` → the string key (table above). All are
re-exported by `index.js`.

---

## `zip.js`

A zip's directory and its files, only read, never extracted, with limits so a crafted file fails
instead of filling the device's memory. As the app's `ZipFile`: names starting with "/" are fine,
a name with a ".." segment makes the whole zip unreadable (as on Android 14), of two entries with
one name the last wins. Data before the zip (self-extracting archives) and ZIP64 are read.

```js
import { ZipArchive, ZipError } from './zip.js';
const zip = ZipArchive.open(bytes);                       // throws ZipError
zip.has('OEBPS/content.opf');                             // as named, a leading "/" aside, then ignoring case
const opf = await zip.bytes('OEBPS/content.opf', { signal });   // Uint8Array, or null when missing
const head = await zip.bytes('word/document.xml', { maxBytes: 4096 });   // just the start
await zip.bytes('xl/worksheets/sheet1.xml', { limit: 64 << 20 });        // ZipError 'too-large' past it
zip.bytesSync('mimetype');                                // without pausing, for small entries
await zip.text('META-INF/container.xml');                 // UTF-8 text, or null
zip.firstEndingWith('.opf');                              // first name (sorted) ending so, ignoring case
zip.names;                                                // files (not folders), in directory order
zip.entry('x') → ZipEntry { name, size, compressedSize, method, encrypted, isDirectory } | null
zip.close();
```
- `ZipArchive.open(bytes, { limits: { entries, entryBytes, totalBytes } })` lowers the limits.
  Defaults: `MAX_ENTRIES` 100,000; `MAX_ENTRY_BYTES` 256 MB inflated per entry; `MAX_TOTAL_BYTES`
  2 GB inflated in all from one archive. Inflating stops as soon as a limit is passed (a 270 MB
  zip bomb fails in about a second), and `bytes()` pauses now and then (`pause.js`) and checks `signal`.
- `ZipError.reason`: `'not-zip'`, `'damaged'` (broken directory or data, ".." names), `'encrypted'`
  (a zip password), `'unsupported'` (a compression method other than stored or deflated),
  `'too-large'`. `isZip(bytes)`: starts with a local file header.

---

## `xml-guard.js`

The checks `XmlTokenGuard.kt` makes before the parser, so a hostile part fails quickly as damaged
instead of hanging the page in `DOMParser` (one call nothing can stop): tags or text over `MAX_RUN`
(8 M) characters; text broken by comments past `MAX_COPIED`; more than `MAX_ATTRIBUTES` (4096)
attributes on the open elements; an XML declaration with more than 3 attributes or naming an
encoding that isn't 8-bit while the bytes are 8-bit; a DOCTYPE (entities: "billion laughs") or any
other declaration but comments and CDATA; nesting deeper than `MAX_NESTING` (16,384). Elements
nested deeper than `MAX_DEPTH` (256), which the app skips, are **cut out** of the text, so the
rest reads as in the app (browsers give up at a few thousand levels).

```js
decodeXml(bytes) → string        // UTF-32/UTF-16 by BOM or "<", else the 8-bit encoding the declaration names (UTF-8 by default)
guardXml(text, { doctype }) → string        // checked, too-deep elements and the declaration cut out; throws XmlError
await guardXmlAsync(text, { doctype, signal })  // the same, pausing every 4 M characters
new XmlTokenGuard({ doctype }).feed(text, from, to); guard.end(); guard.cuts; guard.rootStart; guard.rootEnd
withoutCuts(text, cuts) → string
```
`doctype`: `'refuse'` (default, Office parts) or `'remove'` (left out unread: e-books' XHTML has
`<!DOCTYPE html>`; HTML entities like `&nbsp;` are then still undefined for the XML parser).
`XmlError` (also exported as `XmlGuardError`) is thrown for refused and malformed parts.

---

## `ooxml.js`

### `OfficePackage`

```js
const pkg = await OfficePackage.open(bytes, { signal, limits });   // throws ZipError; limits: ZipArchive's, and xmlBytes
const main = pkg.mainPart();                        // 'word/document.xml' (package relationship /officeDocument)
const doc = await pkg.xml(main);                    // XmlNode root, or null when there's no such part; throws XmlError
pkg.xmlSync('word/styles.xml');                     // without pausing, for small parts
await pkg.bytes('word/media/image1.png');           // Uint8Array or null
pkg.has('WORD/Styles.xml');                         // part names ignore case
pkg.relationships(main);                            // Map id → Relationship { type, target, external } (cached)
pkg.target(main, 'rId5');                           // 'word/media/image1.png' (resolved), null if missing or external
pkg.targetOfType(main, '/theme');                   // first non-external relationship whose type ends so
await pkg.root(main);                               // { name, ns, uri } from the part's start only
pkg.close();
```
An XML part inflating past `MAX_XML_BYTES` (160 MB; 64 MB on a device saying it has 4 GB of memory
or less, as the browser's document of a part takes several times its size) fails with
`ZipError('too-large')`: for Excel that is the app's `office_too_large`.

Relationship targets are resolved against their part's folder (`../media/x.png`, `/word/x.png`);
an external one (`TargetMode="External"`, links) keeps its URL and `target()` gives null for it.
`relationships('')` are the package's own (`_rels/.rels`).

### `XmlNode`

An element, read as the app's `OfficeXml` reads one. `el` is the DOM element (use it for speed in
large parts: `el.firstElementChild`, `el.childElementCount`).

| Member | Meaning |
|---|---|
| `name`, `uri`, `ns`, `depth` | local name ("p" for w:p), namespace URI, vocabulary (`Ns`), depth (root 1) |
| `is(name, ns?)` | local name (and vocabulary) match |
| `attr(local)` | the first attribute with that local name, whatever its prefix (not `xmlns` declarations); null when missing |
| `relId(local = 'id')` | an attribute in a relationships namespace (`r:id`, `r:embed`) |
| `intAttr`, `longAttr`, `floatAttr`, `percentAttr` | numbers as Kotlin reads them ("12.7" → 12; "90%" → 90000 for percentages) |
| `flag(local = 'val', missing = true)` | on/off: `"0"`, `"false"`, `"off"`, `"none"` are off; a missing attribute is `missing` |
| `children(name?)` | child elements (only `name`s) |
| `child(name, ns?)` | the first child element so named, or null |
| `descendants(enter)` | `enter(node)` for every element inside, in order; it goes into an element only when `enter` returns `true` (no recursion) |
| `text()` | the text directly inside (CDATA too), not children's: w:t, a:t |
| `allText()`, `parent` | all text inside; the parent element |

```js
for (const p of body.children('p')) {
  const jc = p.child('pPr')?.child('jc')?.attr('val');
  for (const r of p.children('r')) if (r.child('rPr')?.child('b')?.flag()) ...
}
```

### Parsing and vocabularies

```js
parseXml(bytesOrText, { doctype }) → XmlNode        // decode, guard, DOMParser; throws XmlError
await parseXmlAsync(bytesOrText, { doctype, signal })
await rootElementOf((n) => firstNBytes(n)) → { name, ns, uri }   // reads more while the root tag is long
namespaceOf(uri) → Ns.WORD | DRAWING | SLIDE | WORD_DRAWING | PICTURE | COMPATIBILITY | MATH | VML | SHEET | OTHER
await verifyOfficePackage(bytes, 'word' | 'powerpoint' | 'excel', { signal })   // throws OfficeFileProblem (used by index.js)
```
Transitional and strict (purl.oclc.org) namespaces are both understood. `DOMParser` exists only in
pages, not workers. Firefox writes each XML error it meets to the browser console (harmless; a test
feeding broken XML in Firefox sees "XML Parsing Error" console errors).

---

## `office-formats.js`

Ports of `core/OfficeFormats.kt` (its unit tests pass here):

```js
OfficeUnits.emu(914400)          // 72        twips(720) 36, halfPoints(22) 11, EMU_PER_POINT 12700
OfficeUnits.percentage('90%')    // 90000     (thousandths of a percent; null when not a number)
OfficeUnits.cssLength('1.5in')   // 108       (bare numbers are pixels at 96 dpi; null when not a length)
OfficeUnits.cssStyle('width:120pt;height:4cm')   // { width: '120pt', height: '4cm' } (no prototype)

OfficeFileType.container(header)       // OfficeContainer.ZIP | COMPOUND | OTHER ('zip', 'compound', 'other')
OfficeFileType.isEncryptedPackage(bytes), OfficeFileType.contains(bytes, needle)

ListNumbering.Format                   // DECIMAL, DECIMAL_ZERO, LOWER_LETTER, UPPER_LETTER, LOWER_ROMAN, UPPER_ROMAN, BULLET, NONE (strings)
ListNumbering.wordFormat('lowerRoman'), ListNumbering.format(4, Format.LOWER_ROMAN)  // 'iv'
ListNumbering.wordLabel('%1.%2)', [3, 2], [Format.DECIMAL, Format.LOWER_LETTER])     // '3.b)'
ListNumbering.fieldFormat('PAGE \\* roman')        // Format.LOWER_ROMAN, or null
ListNumbering.powerPointScheme('alphaLcParenBoth') // [Format.LOWER_LETTER, '(', ')']

SymbolFonts.bullet('Wingdings', '')          // '▪'
SymbolFonts.character('Symbol', '')          // 'μ'  (unknown symbols: '�')
SymbolFonts.text('Calibri', 'Done ', 'Wingdings')   // 'Done ✓'

TableColumns.widths(grid, count, available, preferred = null)   // scaled down to fit
new TabStops(set, cleared = [], aligned = new Map())  .over(base)  .positions(start, widths, defaultTab, scale = 1)
TabAlign.RIGHT, TabAlign.CENTER
PageBreaking.linesThatFit(lineBottoms, space, avoidSingleLines, force, keepFirst = true, keepLast = true)   // ported here, the same as text/layout.js's
new OfficeRect(x, y, width, height)       // .centerX .centerY .left .top .right .bottom .copy({...}) .equals(r)
new GroupFrame(frame, [offX, offY], [extX, extY], flipH = false, flipV = false)  .place(rect)  .mirror(rotation, flipH, flipV) → [rotation, flipH, flipV]
SlideTableStyles.parts(flags, row, rows, start, end, columns), SlideTableStyles.border(part, side, outer)
paperSize('a4', landscape = false) → { width, height }    // PAPER_SIZES: a4 letter legal a3 a5
```

---

## `colors.js`

```js
OfficeColors.hex('4472C4')                     // 0xFF4472C4 (null for 'auto' and anything else)
OfficeColors.highlight('yellow')               // Word's w:highlight names
OfficeColors.preset('orange')                  // a:prstClr (others black)
OfficeColors.modify(0xFF4472C4, [['lumMod', 75000]])                    // 0xFF2F5597 ("darker 25%")
OfficeColors.modify(0xFF4472C4, [['lumMod', 60000], ['lumOff', 40000]]) // 0xFF8FAADC ("lighter 40%")
OfficeColors.isDark(argb)                      // black text would be hard to read on it
OfficeColors.alpha(argb), OfficeColors.css(argb)  // 0..255; '#rrggbb' or 'rgba(...)'
OfficeColors.TRANSPARENT, BLACK, WHITE
```
Modifiers, applied in order: `alpha`, `alphaMod`, `alphaOff`, `lumMod`, `lumOff`, `satMod`,
`satOff`, `hueOff`, `comp`, `tint` (towards white), `shade` (towards black), `gray`, `inv`.
Word's `w:themeShade`/`w:themeTint` are `lumMod` (and `lumOff`) in DocxStyles: port that there.

---

## `drawingml.js`

### Themes and colours

```js
const theme = await OfficeTheme.read(pkg, pkg.targetOfType(main, '/theme'));   // OfficeTheme.DEFAULT without one
theme.colors          // Map: 'dk1', 'lt1', 'dk2', 'lt2', 'accent1'..'accent6', 'hlink', 'folHlink' → ARGB
theme.color('accent1'), theme.font('+mj-lt') /* heading font */, theme.font('minorHAnsi') /* body font */
readColor(x, (name) => theme.color(mapped(name)))   // a:srgbClr/schemeClr/sysClr/prstClr/scrgbClr/hslClr with modifiers, or null
```

### Fills and outlines

```js
readFill(x, pkg, part, scheme)   // a:noFill/solidFill/gradFill/blipFill/pattFill → Fill; null for others (a:grpFill too)
Fill.NONE, Fill.solid(c), Fill.gradient(stops, angle, radial), Fill.image(path, crop, tile), Fill.mainColor(fill)
// { type: 'none' } | { type: 'solid', color } | { type: 'gradient', stops: [[pos 0..1, color]], angle (deg), radial }
// | { type: 'image', path (part), crop: [l, t, r, b] shares or null, tile }
readOutline(x, scheme) → Outline { color (null: none), width (points, default 0.75), dashed, head, tail }
new Outline(color, width, dashed, head = null, tail = null), Outline.NONE, outline.copy({...})
new LineEnd(type /* triangle, stealth, arrow, diamond, oval */, width, length)   // multiples of the line's width
```

### Painting on a PdfCanvas

```js
fillShape(canvas, fill, path, bounds, (fill) => picture)   // solid, gradient (gradientFor), picture clipped to the path
strokeShape(canvas, outline, path)                         // Android's Paint: butt ends, mitred joins (limit 4); dashes 4w on, 3w off
strokeLine(canvas, outline, path)                          // an open line with its arrowheads; under a pointed one the line stops short
gradientFor(canvas, fill, rect)                            // the canvas gradient DrawingML.kt's gradient() makes
presetPath(name, rect, adjust = null) → PdfPath            // see PRESET_SHAPES; others become rectangles
isLineShape(name)                                          // line, connectors: never filled
```
`PRESET_SHAPES` lists those drawn as themselves: ellipse, roundRect, triangle, rtTriangle, diamond,
parallelogram, trapezoid, hexagon, octagon, pentagon, homePlate, chevron, the four block arrows,
star5, plus, line, lineInv, straight, bent (2–5) and curved (2–5) connectors, the snip/round
rectangles (rounded), and their flowchart twins. `adjust`: a Map (or object) of a:gd values.

### Transforms and freeform shapes

```js
readXfrm(x) → { rect: OfficeRect, rotation (deg clockwise), flipH, flipV, child: { offset: [x, y], extent: [w, h] } | null }
readAdjustments(prstGeom) → Map, readGuide(gd) → [name, value] | null
readCustom(custGeom) → [{ w, h, commands, kinds, filled, stroked }]   // [] when points need formulas
customPaths(paths, rect, { flipH, flipV }, groupX = 1, groupY = 1) → [[PdfPath, filled, stroked]]
rotateAbout(canvas, degrees, cx, cy), scaleAbout(canvas, sx, sy, cx, cy), flipped(path, flipH, flipV, rect)
box(rect) → { x, y, width, height }
```

### `drawShape(canvas, shape, { picture })`

The geometric part of `PptxConverter.drawShape`: turns the canvas about the shape's centre, then
fills (not lines) and outlines its preset or freeform path, mirrored by its flips; or draws a
picture (`shape.picture: true`) clipped to its geometry and mirrored, then its outline.

```js
canvas.save();
drawShape(canvas, {
  rect, rotation, flipH, flipV,           // place it (after GroupFrame.place / mirror in groups)
  picture: false,                         // true for p:pic
  geometry: 'roundRect', adjust,          // null: rectangle
  custom: null, groupScale: [1, 1],       // readCustom's paths; how much the group stretches them
  fill, line,                             // Fill, Outline
}, { picture: (fill, rect) => loadedPictures.get(fill.path) });   // loaded ImagePictures (or null)
drawText(...);                            // the canvas is still turned, as the shape's text needs
canvas.restore();
```

---

## `path-measure.js`

```js
const m = new PathMeasure(pdfPath, forceClosed = false);   // the first contour of non-zero length
m.length; m.isClosed; m.nextContour() → boolean
m.getPosTan(d) → { x, y, tx, ty }          // point and unit direction d points along (clamped)
m.getSegment(from, to, intoPdfPath, startWithMoveTo = true) → boolean   // curves stay curves
```

---

## `blocks.js`

A **block** is any object with `height` (points), `draw(canvas, x, y)` and `split(space, force)`
→ `[head, tail | null]` (tail null when it all fits) or `null` when nothing fits (with `force`,
something always fits). The text engine's `ParagraphLayout` is one.

```js
new Spaced(block, before = 0, after = 0)
new StackBlock([new Spaced(paragraph, 6, 6), new Spaced(table)])   // one under another; splits as the app's
new EmptyBlock(height)                                                // space
```

---

## `tables.js`

```js
new Border(width, color)        // points, ARGB; Border.NONE: turned off (width 0)
new CellBox({ x, width, content /* block or null */, fill /* ARGB or null */, top, left, bottom, right /* Border or null */,
              verticalAlign /* 0 top, 1 middle, 2 bottom */, padLeft, padTop, padRight, padBottom })   // cell.copy({ content: null })
new RowBlock(cells, minHeight = 0, exact = false)   // grows with its tallest cell unless exact (then clipped)
new TableBlock(rows, headerRows = 0, x = 0)         // splits at a row, or inside a row too tall for a page; header rows repeat
table.draw(canvas, left, top); const [head, tail] = table.split(spaceLeft, pageIsEmpty) ?? [null, table];
```
Fills first, then borders (square ends) over every cell, so no fill covers a neighbour's border. A
merged cell: content in its top cell, `null` content and `Border.NONE` between its rows.

---

## `office-pdf.js`

### Pages

```js
const pdf = await OfficePdf.create();         // pdf.doc: the pdf-lib document
const canvas = pdf.startPage(612.3, 792.4);   // PdfCanvas; the page is 612 × 792 (whole points, as Android)
pdf.finishPage();                             // pdf.pageCount
const { bytes, pageCount } = await pdf.finish({ onProgress, signal });   // saves (savePdf)
```

### Pictures

```js
const images = new OfficeImages(pkgOrZipOrFunction, pdf.doc, { signal });
const pic = await images.picture('word/media/image1.png', widthPt, heightPt, crop /* [l, t, r, b] or null */);
pic.draw(canvas, rect);                       // ImagePicture: the picture, cropped; a grey box when it can't be decoded
await images.image(path, widthPt, heightPt)   // { ref, width, height } for canvas.drawImage, or null
new ImagePicture(images, path, w, h, crop); await picture.load();   // the same in two steps
rich.appendObject(inlinePicture(pic, w, h), style);   // a picture in a line of text (PictureSpan)
const chart = await StandInPicture.create('Sales by region'); chart.draw(canvas, rect);   // grey box with its title
StandInPicture.EMPTY.draw(canvas, rect)
new BitmapPicture(imageBitmapOrCanvas, crop /* { x, y, width, height } px */).draw(canvas, rect)
decodedSize(w, h, targetW, targetH) → [w, h]  // the size a picture is decoded at
```
- Pictures must be loaded (awaited) before drawing: drawing is synchronous.
- Each picture is decoded once per size shown, no larger than **150 pixels per inch** where it is
  shown (`DPI`), at most `MAX_SIDE` (2400) on a side and `MAX_PIXELS` (12 MP), and stored once in
  the PDF: as a JPEG at quality 0.75 (`JPEG_QUALITY`) when that is smaller than the picture stored
  losslessly and the lossless stream is 2 KB (`MIN_JPEG_BYTES`) or more; losslessly (Flate)
  otherwise, and always with its transparency when it has any. That is what the app's PDF has
  after its Compress PDF (Recommended) pass, which replaces a picture only by a smaller JPEG and
  leaves streams under 2 KB and masked pictures alone: small flat pictures shown large (logos,
  diagrams) keep sharp edges, photos become JPEGs.
- `deflateBelow(bytes, limit = Infinity) → Uint8Array | null`: `bytes` as a zlib (FlateDecode)
  stream, or null as soon as it reaches `limit` bytes (how a picture's lossless size is told from
  its JPEG's without deflating all of a photo).
- Decoded as Android decodes pictures for the app: without turning them by their EXIF orientation.
  JPEG, PNG, GIF, BMP, WebP (and AVIF/HEIF where the browser decodes them) are drawn; EMF, WMF,
  TIFF, pictures over `MAX_DECODE_PIXELS` and damaged files show as the grey stand-in, as in the app.
- Pictures draw on a PdfCanvas only (not on a screen canvas).

---

## `pause.js`

```js
import { pause } from './pause.js';
await pause();   // the work goes on in a new task (a MessageChannel message)
```

Every long loop of the converters breathes with it (zip inflating, the XML guard's slices, Word's
layout, slides, sheet rows, EPUB chapters): the page paints and answers input, its timers run.
Not `setTimeout(0)`, which a tab in the background runs once a second at most (a big file would
take minutes while the user looks elsewhere), nor `scheduler.yield()`, which goes ahead of the
page's timers (the progress dialog's) and holds them up.

---

## Tests

`node tests/office-core.test.mjs` (about a minute): the app's `OfficeFormatsTest` and
`XmlTokenGuardTest`; hostile XML (entities, DOCTYPE, attribute floods, 10,000 and 100,000 levels of
nesting, encodings); zips (limits, a 270 MB zip bomb, damaged and encrypted entries, ".." names);
packages and the app's messages for old, locked and wrong files; the dispatcher with stand-in
converters; colours; DrawingML shapes, fills, outlines, arrowheads, transforms, pictures and crops
drawn into a PDF and checked by pixels, and stored as JPEG or losslessly as Compress PDF leaves
them; tables with merged cells, borders and page splits; a 13-million-character part read without
freezing the page, and as fast with timers slowed as in a tab in the background. Chromium in full,
Firefox and WebKit for most of it (Firefox's console errors for broken XML let through).
