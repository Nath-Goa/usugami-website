# Word to PDF (`site/app/js/engine/office/docx*.js`)

Turns a Word document (.docx) into a PDF on the device, as the app's `DocxConverter.kt` and
`DocxStyles.kt` do (with the Word parts of `OfficeText.kt`, through the text engine). Nothing is
uploaded. Screens don't call this module directly: they call office-core's dispatcher,
`convertOffice('word', fileItem, options, hooks)` (see [office-core.md](office-core.md)), which
checks the file, loads `docx.js` when first needed, names the PDF and turns every failure into the
app's message.

| Module | What |
|---|---|
| [`docx.js`](#docxjs) | `convertDocx`: the converter `index.js` loads |
| [`docx-styles.js`](#docx-stylesjs) | run, paragraph and table formatting, styles, lists (`DocxStyles.kt`) |
| [`docx-read.js`](#docx-readjs) | reading the body, headers and footers into paragraphs, tables and breaks; sections |
| [`docx-layout.js`](#docx-layoutjs) | laying them out on pages: paragraphs, tables, pictures, headers and footers |

Lengths are **points**; colours **ARGB numbers** (`0xFF1F3864`), as everywhere in office-core.

---

## What converts

As in the app: page size and margins per section (portrait or landscape, a blank page before a
section that must start on an odd or even page); paragraphs with their alignment, spacing (with
"contextual spacing"), indents, line spacing, shading, top and bottom borders, "keep with next"
(up to four paragraphs), "page break before" and widow control; text that is bold, italic,
underlined, struck through, coloured (also theme colours with their shade or tint), highlighted or
shaded, raised or lowered, in capitals or small capitals, letter-spaced, any size; complex-script
text (Hebrew, Arabic, Hindi, Thai...) with its own size, bold and italic (`w:szCs`, `w:bCs`,
`w:iCs`); right-to-left paragraphs and tables (mirrored); Word's styles (document defaults,
paragraph and character styles based on others, table styles, the default table style) and theme
fonts (`+mj`/`major…` and `+mn`/`minor…`); bulleted and numbered lists at every level (numbering
definitions, levels, `startOverride` restarts, lists continuing each other through one definition,
lists defined through a list style, legal numbering, symbol-font bullets); tables with their column
widths, preferred width, alignment and indent, merged cells (`gridSpan`, `vMerge`, `gridBefore`),
borders, cell shading and margins, vertical alignment, exact and minimum row heights, header rows
repeated on each page, rows split across pages; pictures in the text and floating (anchored: in
front of or behind the text where Word puts them, else on a line of their own), turned a quarter or
any angle, flipped, cropped, in groups and drawing canvases, VML pictures and picture watermarks
(washed out); hidden pictures, shapes and text left out; page breaks, line breaks, section breaks;
headers and footers (first-page with `w:titlePg`, even-page with `w:evenAndOddHeaders`) with
`PAGE` fields in their section's or the field's own format, restarting where a section says; tab
stops; symbols (`w:sym`, Symbol and Wingdings); phonetic guides (the base text only); the text of
text boxes (after the paragraph they're anchored to), equations and fields (their last result);
charts and SmartArt as grey boxes with their title.

Beyond the app (the text and layout stay the same):
- **Links are clickable**: `w:hyperlink` to a web, mail, phone or FTP address, `HYPERLINK` fields,
  and links to bookmarks inside the document (a table of contents' lines, `HYPERLINK \l` and
  `PAGEREF … \h` fields) go to the bookmark's paragraph (a named destination at its top). Addresses
  of other kinds (`javascript:`, `file:`) and bookmarks that don't exist get no link.
- **Tab stops** are right, centre and decimal stops in every line, with their leaders (the dots of a
  table of contents); the app's lines have left stops only (aligned stops work there in one-line
  paragraphs, through `alignedTabs`). In a one-line paragraph whose first line starts further in,
  the stops are brought that much nearer, as the app does, so the text lands where Word puts it.
- A double underline is drawn double.

Left out, as in the app: footnotes, endnotes, comments, deleted text (`w:del`, `w:moveFrom`),
shapes' own fills and outlines (only their pictures and text), several columns (one column), text
wrapping around floating pictures.

---

## `docx.js`

### `convertDocx(input, options = {}, hooks = {}) → Promise<OutputFile>`

```js
import { convertDocx } from '../engine/office/docx.js';
const out = await convertDocx({ name: 'Report.docx', bytes }, { name: 'Annual report' }, {
  signal,
  onProgress: (done, total, info) => dialog.update(info?.compressing ? 1 : null, info?.compressing ? t('creating_pdf') : t('pdf_page_number', done)),
});
// out: { name: 'Annual report.pdf', bytes: Uint8Array, type: 'application/pdf', pageCount: 5 }
```

- `input`: `{ name, bytes }` (a FileItem will do). Not checked here: `convertOffice` runs
  `verifyOfficeFile` first. Called directly with something that isn't a .docx, it throws `ZipError`
  or `XmlError` (office-core), which `convertOffice` would turn into `office_convert_failed`.
- `options.name`: the PDF's name as typed, without ".pdf" (default: the document's own name;
  blank gives "Document.pdf"). Other fields are ignored (Word to PDF has no options).
- `hooks.onProgress(page, null)` as each page starts (the count isn't known until the end; the app
  shows "Page 3"), then `onProgress(pages, pages, { compressing: true })` while the PDF is saved.
- `hooks.signal`: aborting it stops the conversion with `CancelledError` (checked between pages,
  paragraphs and table rows).
- Resolves to an OutputFile `{ name, bytes, type: 'application/pdf', pageCount }`. A document with
  nothing in it gives one blank page (its first section's size), as in the app.

Throws (convertOffice turns these into `UserError`s with the keys below):
- `OfficeEmbeddedContent` (problems.js) when the body's only content is kept as a web page or RTF
  file inside the document (`w:altChunk`).
- `ZipError`, `XmlError` for a damaged file or part (a broken XML part, a DOCTYPE or entities,
  nesting past 16,384 levels); elements nested deeper than 256 levels are left out and the rest
  converts, as in the app.
- `UserError('web_fonts_unavailable')` when the text engine can't load its fonts.
- `CancelledError` when `hooks.signal` aborts.

### Messages (the keys a Word screen shows, from strings.xml)

| Key | English (one file) | Key `_many` |
|---|---|---|
| `office_not_word` | This isn't a Word document (.docx), or it's damaged. | These aren't Word documents (.docx), or they're damaged. |
| `office_legacy_word` | This is an old Word file (.doc). Save it as .docx in Word or another app, then try again. | These are old Word files (.doc). Save them as .docx in Word or another app, then try again. |
| `office_encrypted` | This file is protected with a password. Remove the password in Word or PowerPoint, save the file, then try again. | These files are protected with a password. Remove the password in Word or PowerPoint, save the files, then try again. |
| `office_embedded_content` | This document keeps its text as a web page or RTF file inside it, which Usugami can't convert. Open it in Word, save it, then try again. | These documents keep their text as a web page or RTF file inside them, which Usugami can't convert. Open them in Word, save them, then try again. |
| `office_convert_failed` | Couldn't convert this file. Check the file and free storage. | — |
| `web_fonts_unavailable` | Usugami couldn't load its fonts. Check your connection and try again. | — |

Around the conversion: `pdf_page_number` "Page %1$d" (progress), `creating_pdf` "Creating and
compressing PDF…".

---

## `docx-styles.js`

```js
import { RunProps, ParaProps, Borders, Border, TableProps, DocxStyles, DocxNumbering, ListLevel, ComplexScript, readTabs, sameStyle, hexInt } from './docx-styles.js';
```

### `RunProps`
Run (character) formatting; every field null when not set here: `font, size, bold, italic,
underline (true | 'double' | false), strike, color, background, baseline (1 | -1 | 0), caps,
smallCaps, hidden, spacing, style (w:rStyle), sizeCs, boldCs, italicCs, complex, rtl`.
- `RunProps.read(rPr, theme)` reads a `w:rPr` XmlNode. Highlight wins over run shading; a theme
  colour (`w:themeColor`) applies only without a hex `w:val`, with `w:themeShade`/`w:themeTint` as
  lumMod/lumOff.
- `props.over(base)` → these over `base`'s; `props.copy({ underline: false })`; `props.allComplex`.
- `props.toStyle(theme)` → the text engine's style (`{ font, size, bold, italic, underline, strike,
  color, background, baseline, caps, smallCaps, spacing, autoColor }`): the theme's body font and
  10 points when not set; `autoColor` when no colour is set (black, white on dark shading).
- `props.toComplexStyle(theme)` → the same with the complex-script size, bold and italic.

```js
const run = RunProps.read(rPr, theme).over(styles.run('Strong')).over(paragraphBase);
rich.append('Hello', run.toStyle(theme));
```

### `ParaProps`
Paragraph formatting: `style, align ('start' | 'center' | 'end' | 'justify'), before, after, line
(LineSpacing), left, right, firstLine (negative: hanging), numId, level, keepNext, pageBreakBefore,
contextual, widowControl, shading, rtl, tabs (TabStops), mark (RunProps), borderTop, borderBottom
([Border, distance])`.
- `ParaProps.read(pPr, theme, onSection?)` (`onSection(sectPr)` is called for a `w:sectPr` in it);
  `over(base)` (tab stops add up, as `TabStops.over`); `copy(changes)`.

### `readTabs(tabsNode) → TabStops`
`w:tabs`: `set` stops and `cleared` ones in points; `aligned` maps each stop that isn't a plain left
one to `{ align: 'right' | 'center' | 'decimal' | 'left', leader: 'dot' | 'hyphen' | 'underscore' | 'heavy' | 'middleDot' | null }`.

### `Border`, `Borders`, `TableProps`
`Border(width, color)` is tables.js's (`Border.NONE`: turned off). `Borders.read(tblBorders)` →
`{ top, left, bottom, right, insideH, insideV }` (double borders 1.5 × as wide), `over(base)`.
`TableProps.read(tblPr)` → `{ style, borders, margins [l, t, r, b], indent, align, width,
widthShare, rtl }`; `TableProps.readMargins(tcMar)`.

### `DocxStyles`
```js
const styles = await DocxStyles.read(pkg, pkg.targetOfType(main, '/styles'), theme);
styles.para('Heading1')                  // ParaProps of the style and those it's based on
styles.run('Heading1'), styles.table('TableGrid')
styles.resolvePara(direct, tableStyle)   // direct, then style (table style below a non-default one), then defaults
styles.paragraphRun(paraStyle, tableStyle)   // the RunProps a paragraph's text starts from
styles.defaultParagraphStyle, styles.defaultTableStyle   // ids or null
```
Styles based on each other are followed at most 31 deep and never round in a circle.

### `DocxNumbering`, `ListLevel`
```js
const numbering = await DocxNumbering.read(pkg, pkg.targetOfType(main, '/numbering'), theme, styles);
numbering.level(1, 0)   // ListLevel { format, text: '%1.', start, para, run, suffix: 'tab'|'space'|'nothing', legal }
numbering.next(1, 0)    // '1.', then '2.'...: counts as it labels (bullets come back as their character)
```
Lists sharing a definition continue each other's count unless a `w:num` restarts (overrides) it.

### `ComplexScript`, `sameStyle`, `hexInt`
`ComplexScript.split(text, before, (part, isComplex) => …)` → whether the text ended in
complex-script letters: Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic and the scripts of
South and South-East Asia; spaces, digits and punctuation go with the letters before them.
`ComplexScript.kind(ch)` → true, false or null. `sameStyle(a, b)` compares two text styles.
`hexInt('F06D')` → 61549 (Kotlin's `toIntOrNull(16)`; null for anything else).

---

## `docx-read.js`

```js
const root = await pkg.xml(main);
const ctx = { pkg, theme, styles, numbering, images /* OfficeImages */, bookmarks: bookmarkNames(root) };
const reader = new Reader(ctx, main);
for (const body of root.children('body')) for (const x of body.children()) reader.block(x, null, (item) => items.push(item));
```

- `new Reader(ctx, part)`: `blocks(node, tableStyle, emit)`, `block(node, tableStyle, emit)` emit
  `DocPara`, `DocTable`, `PAGE_BREAK` and `SECTION_END` items in order. `reader.altChunks`: how many
  `w:altChunk`s were met. Fields carry over from paragraph to paragraph, as in Word.
- `DocPara { props, inlines, label, labelStyle, labelSuffix, mark, floats, bookmarks }`. Inlines:
  `{ kind: 'text', text, style, link }` (`link`: `{ url }` or `{ dest }`), `{ kind: 'page', style,
  format }`, `{ kind: 'picture', picture, width, height, style }`; also made by `textInline`,
  `pageInline`, `pictureInline`.
- `DocTable { props, grid, rows: DocRow[] }`, `DocRow { cells, height, exact, header, gridBefore }`,
  `DocCell { span, vMerge, fill, borders, verticalAlign, margins, content: items }`. At most
  `MAX_COLUMNS` (1000) columns.
- `Floating { picture, width, height, h, v: Position { from, offset, align }, overText, behind }`.
- Pictures (all with `load()` and `draw(canvas, rect)`): office-core's `ImagePicture`,
  `TurnedPicture(picture, Turn, sideways)`, `GroupPicture(width, height, [[picture, OfficeRect]])`,
  `VeiledPicture(picture, opacity)` (washed out), `CaptionPicture(caption)` (charts).
  `Turn(degrees, flipH, flipV)`: `.isNone`, `.sideways`; `Turn.NONE`.
- `readSections(pkg, main, root)` → `Section[]` (at least one: `DEFAULT_SECTION`, US Letter with
  one-inch margins): `{ width, height, top, bottom, left, right, headerDistance, footerDistance,
  type, headers: Map(kind → part), footers, titlePage, pageStart, pageFormat }`. Sizes are held
  between 72 and 14,400 points, and an inch is kept for the text whatever the margins say.
- `await readEvenAndOddHeaders(pkg, main)` → boolean; `bookmarkNames(root)` → Set of names.
- `hasPageNumber(item)`, `shows(item)`, `picturesOf(item)`.
- `isPageField(' PAGE \\* roman ')` → true (not PAGEREF or NUMPAGES).
- `fieldTarget(instruction)` → `{ url }` / `{ anchor }` for `HYPERLINK "url"`, `HYPERLINK \l
  "name"` and `PAGEREF name \h`; null otherwise.

---

## `docx-layout.js`

```js
const layout = new DocxLayout({ ...ctx, pdf /* OfficePdf */, sections, evenAndOddHeaders, signal, onProgress });
const flow = new Flow(layout);
for (const item of items) await flow.add(item);
await flow.finish();             // the last page; then pdf.finish()
```

- `DocxLayout`: `await paragraphBlock(docPara, width, pageNumber, maxHeight, behind)` (a text
  engine ParagraphLayout, wrapped to add its bookmarks' destinations when drawn), `await
  tableBlock(docTable, width, pageNumber, maxHeight, behind)` (a tables.js TableBlock), `await
  stack(items, width, pageNumber, maxHeight, behind, overlays)` (a StackBlock, as in a cell or a
  header), `floatBlock(floating, width, maxHeight, pageLeft)`, `await breathe()` (checks the
  signal and now and then lets the page draw, with a task rather than a timer, so a conversion in a
  background tab isn't slowed).
- `Flow`: `await add(item)`, `await finish()`; pages are started through `ctx.pdf.startPage(width,
  height)` with `ctx.onProgress(page, null)`.
- `PageNumber(value, format).text(ownFormat)`, `FloatBlock(picture, width, height, x)`,
  `spaceBefore(paraProps)`, `spaceAfter(paraProps)` (with room for borders).

---

## Differences from the app

- The text engine's bundled Noto fonts stand in for the phone's; lines are scaled to Word's heights
  (`lineScale`) as in the app, so pages break about where they do there.
- Lengths are kept in points, not rounded to the app's tenths of a point.
- Long paragraphs aren't cut into the app's "pieces": the text engine splits a laid-out paragraph
  without laying it out again.
- Links are clickable, tab stops align and have leaders in every line, double underlines are double
  (see above). The gap a tab leaves inside a link isn't part of the link's area (the text engine
  links the text either side of it), so a contents line has two link areas.
- A table of contents' page numbers are Word's own (the fields' last results), as in the app.
- Each top-level part of the body (a paragraph, or a whole table) is read in one go before it is
  laid out; layout pauses between pages, paragraphs and table rows.

Tests: `node tests/docx.test.mjs` (about ten seconds): the app's Word device tests ported, the
app's report.docx fixture (`tests/fixtures/docx/report.docx`), links, leaders, headers, colours,
tables, lists, floating pictures, Chinese and Japanese, damaged and hostile files, cancelling and a
long document; Chromium in full, Firefox and WebKit for the main documents. The PDFs it makes are
saved in `tests/output/docx-*.pdf` to look at.
