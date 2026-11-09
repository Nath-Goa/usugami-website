# EPUB to PDF (`site/app/js/engine/office/epub*.js`)

E-books (`.epub`, EPUB 2 and EPUB 3) laid out as PDF pages, in the browser: a port of the app's
`data/office/EpubBook.kt`, `EpubHtml.kt`, `EpubConverter.kt` (with the EPUB parts of
`OfficeConverter.kt`) and `core/EpubFormats.kt` (its unit tests pass here).

- **A5** pages (about a paperback's, the default) or **A4** for printing, with book margins and
  type: 11 pt type and 44/46/52 pt margins (sides, top, bottom) on A5; 12 pt and 66/64/72 pt on A4.
- The **cover** first, on a page of its own (filling the page's height or width, centred), then the
  documents in the book's **reading order**, each starting on a new page; documents read only when
  linked to (notes) come after the main text. Fixed-layout books (comics, picture books) get one
  page per document: a single picture fills it, anything else is shrunk onto it, turned sideways for
  a landscape viewport.
- Headings, paragraphs, line breaks, bold, italic, underlined and struck text, superscripts and
  subscripts, lists (bullets, numbers, letters, roman numerals), block quotes, definition lists,
  preformatted text, simple tables (column and row spans, header rows repeated across pages,
  captions), pictures (also in SVG covers and `<object>`s), rules, quotation marks for `<q>`.
- From the book's CSS (linked, `<style>` and `style=""`, with simple selectors): text-align,
  font-weight, font-style, font-size (kept within 0.6 and 3 times the book's), the generic
  font-family, text-decoration, text-indent, vertical margins (collapsed as CSS does) and side
  margins, display:none, list-style-type, white-space and page breaks. Books written down the page
  (Japanese, Chinese: `writing-mode: vertical-rl`) are laid out across it, their margins turned to
  suit, and line breaks between their characters leave no space.
- The table of contents (EPUB 3 navigation document, else the EPUB 2 NCX) becomes the PDF's
  **bookmarks**, each leading to the page and height of its place; without one, each document's
  first main heading. The title, author and language go into the PDF.
- Text stays real, searchable text with only the letters used embedded; pictures are stored at
  no more than 150 pixels per inch, JPEG at quality 75 when opaque (OfficeImages, office-core).
- Books with DRM, other files, damaged and hostile books get the app's messages (below); a
  chapter that can't be read is left out and the rest converted, as in the app.

Modules:

| Module | What |
|---|---|
| [`epub.js`](#epubjs) | `convertEpub`, `verifyEpub`, `EpubConverter`, `BookInfo`, `OutlineItem` |
| [`epub-book.js`](#epub-bookjs) | `EpubBook` (the package: metadata, reading order, cover, table of contents), `SpineItem`, `TocEntry` |
| [`epub-html.js`](#epub-htmljs) | `XhtmlReader` and what it reads documents into (`BookPara`, `BookImage`, `BookTable`, ...) |
| [`epub-xml.js`](#epub-xmljs) | `LenientXml`: XML read forgivingly, as e-books write it |
| [`epub-formats.js`](#epub-formatsjs) | `HtmlEntities`, `EpubPaths`, `EpubProtection`, `XmlPrefix`, `HtmlText`, the CSS engine (`SimpleCss`, `CssSheet`, `CssValues`...) |

Lengths are points; the page's origin is its top-left corner (the text engine's). Kotlin's `Pair`s
are arrays (`[path, fragment]`, `[width, height]`).

---

## How screens use it

Screens don't call these modules: they call the office dispatcher, which checks the book, loads
`epub.js` when first needed, names the PDF and turns every problem into the app's message
(`docs/api/office-core.md`):

```js
import { convertOffice, verifyOfficeFile, officeErrorKey, BOOK_PAGES } from '../../engine/office/index.js';

await verifyOfficeFile('epub', fileItem);                 // when picked or shared: DRM, not a book...
const out = await convertOffice('epub', fileItem, { bookPage: 'a4', name: 'My book' }, {
  signal,
  onProgress: (done, total, info) => dialog.update(info?.compressing ? 1 : done / total,
    info?.compressing ? t('creating_pdf') : t('progress_chapter', done, total)),
});
// out: { name: 'My book.pdf', bytes, type: 'application/pdf', pageCount }
```

`BOOK_PAGES` lists the choice for the screen (`[{ value: 'a5', label: 'size_a5' }, { value: 'a4',
label: 'size_a4' }]`), shown with `book_page_note` under it, as the app's BookPageOptions.

---

## `epub.js`

### `convertEpub(input, options = {}, hooks = {}) → Promise<OutputFile>`

Converts the e-book `input` (`{ name, bytes: Uint8Array }`, a FileItem will do) into a PDF.

- `options.pageSize`: `'a5'` (default) or `'a4'`. `options.bookPage` (what `convertOffice` passes)
  is read too. Anything else is A5.
- `options.name`: the PDF's name as typed, without `.pdf` (default: the book's file name, as
  `officeOutputName` makes it: "Pride.epub" → "Pride.pdf", a blank name → "Book.pdf").
- `hooks.onProgress(chapter, chapters)`: before each document of the reading order (the app's
  "Chapter 3 of 12"); last `onProgress(pages, pages, { compressing: true })` while the PDF is saved.
- `hooks.signal`: an AbortSignal; aborting throws `CancelledError` soon after (it is checked
  between events of a document, between blocks, pages and documents, and while the zip inflates).
- Resolves to `{ name, bytes, type: 'application/pdf', pageCount }`.
- Throws the office-core problems (`problems.js`): `EpubProtected` (DRM), `OfficeNotRecognized`
  (not an EPUB), `OfficeNothingToConvert` (nothing to show); `ZipError` for a zip that can't be
  read; `UserError('web_fonts_unavailable')` when the fonts can't be loaded; `CancelledError`. A
  book nested so deep (thousands of tables in tables) that laying it out runs out of stack throws a
  `RangeError`. `convertOffice` turns all of these into the messages below.

```js
import { convertEpub } from '../../engine/office/epub.js';
const pdf = await convertEpub({ name: 'Garden.epub', bytes }, { pageSize: 'a4' }, { onProgress, signal });
```

### `verifyEpub(input, hooks = {}) → Promise<void>`

The app's check when a book is picked (`EpubBook.read`): reads `META-INF` and the package only.
Throws `EpubProtected`, `OfficeNotRecognized`, `OfficeNothingToConvert`, `ZipError` (a damaged
zip, a ".." name), `CancelledError`. `index.js` calls it from `verifyOfficeFile('epub', ...)` and
maps every error that isn't a problem to `OfficeNotRecognized`.

### `new EpubConverter(zip, book, pdf, images, pageSize, check, progress, signal = null)`

The page layout itself, for callers with their own PDF: `zip` a `ZipArchive`, `book` from
`EpubBook.read`, `pdf` an `OfficePdf`, `images` an `OfficeImages` on the zip, `pageSize`
`{ width, height }` (points, e.g. `paperSize('a5')`), `check()` throws to cancel,
`progress(chapter, total)`, `signal` stops reading the zip. `await converter.convert()` draws every page and resolves to a
`BookInfo`; `bookInfo.applyTo(pdf.doc)` then adds the bookmarks, title, author and language.

```js
const zip = ZipArchive.open(bytes);
const book = await EpubBook.read(zip, check);
const pdf = await OfficePdf.create();
const info = await new EpubConverter(zip, book, pdf, new OfficeImages(zip, pdf.doc), paperSize('a5'), check, progress).convert();
info.applyTo(pdf.doc);
const { bytes: out, pageCount } = await pdf.finish();
```

### `BookInfo`, `OutlineItem`

`new BookInfo(outline, title, author, language)`; `applyTo(doc)` writes the outline (titles cut at
500 characters, pages clamped to the PDF's, each leading to an XYZ destination at the left edge and
its height), the title and author (500 characters at most) and the language (35). `new
OutlineItem(title, page, top, children)`: `page` 0-based, `top` in PDF points from the page's
bottom.

---

## `epub-book.js`

### `EpubBook.read(zip, check = () => {}) → Promise<EpubBook>`

Reads the package of the book in `zip` (a `ZipArchive`): DRM first (`META-INF/rights.xml`,
`license.lcpl`, or `encryption.xml` naming anything but font obfuscation; an encryption file that
can't be read counts as DRM), then the package's path from `META-INF/container.xml` (or the first
`.opf` file), then the package. Throws `EpubProtected`, `OfficeNotRecognized`,
`OfficeNothingToConvert`.

```js
const book = await EpubBook.read(zip);
book.title; book.creator; book.language;   // the first non-empty dc:title, dc:creator, dc:language, or null
book.spine;        // SpineItem[]: documents and pictures in reading order (missing files and SVG left out)
book.coverImage;   // the cover picture's path (properties="cover-image", else <meta name="cover">), or null
book.navPath; book.ncxPath;
const toc = await book.toc(zip, check);    // TocEntry[] from the nav document, else the NCX; [] when neither reads
```

- `SpineItem { path, mediaType, linear, fixed }`: `linear` false for `linear="no"`; `fixed` for
  pre-paginated layout (the book's `rendition:layout`, or the itemref's own properties).
- `TocEntry { title, path, fragment, children }`: `path` and `fragment` resolved against the
  navigation file (`null` when it points out of the book).
- `rethrowCancel(e)`: throws `e` again when it is a `CancelledError`. `readEntry(zip, path, options)`:
  a zip entry's bytes, or null when it is missing or can't be inflated.

---

## `epub-html.js`

### `new XhtmlReader(path, base, textWidth, sheet, imageSize, images, check, sink)`

Reads one XHTML document into `BookEntry`s handed to `sink` as they are read (a long chapter
isn't held whole):

| Argument | |
|---|---|
| `path` | the document's path in the book; links, pictures and style sheets are found from it |
| `base` | the book's font size in points (11 on A5, 12 on A4); CSS's 16 px is this |
| `textWidth` | the text's width in points: what CSS percentages are of |
| `sheet` | `async (path) => CssSheet \| null`: a linked style sheet |
| `imageSize` | `async (path) => [width, height] \| null`: a picture's pixels, null when it can't be drawn |
| `images` | the `OfficeImages` inline pictures are drawn from (may be null when `imageSize` always gives null) |
| `check` | `() => void`, throws to cancel |
| `sink` | `async (BookEntry) => void`; its errors stop the reading and come through `read()` |

`await reader.read(bytes)` reads the document; a part that can't be parsed ends it and what came
before is kept. Then `reader.firstHeading` (the first h1–h3's text, or null) and `reader.viewport`
(`[width, height]` from `<meta name="viewport">`, or null).

```js
const entries = [];
const reader = new XhtmlReader('OEBPS/ch1.xhtml', 11, 332, sheetOf, sizeOf, images, check, async (e) => entries.push(e));
await reader.read(bytes);
```

What it reads into:

| Class | Fields |
|---|---|
| `BookEntry` | `item`, `before` (points of space above, collapsed as CSS does), `ids` (the element ids and `<a name>`s starting with it) |
| `BookPara` | `text` (a `BookText`), `style` (`BlockStyle`), `base` (the paragraph's resolved text style), `label` (`[text, style]` for a list item, or null), `heading` (1–6, 0 for text) |
| `BookImage` | `path`, `width`, `height` (points at the picture's natural size, 16 px to `base`), `share` (of the width, for `width: 50%`, or null), `style` |
| `BookTable` | `rows` (arrays of `BookCell { items: BookEntry[], span, rowSpan, header }`), `style` |
| `BookRule` | `style` (an `<hr>`) |
| `BookBreak` | a page break the CSS asks for (one shared object) |
| `BlockStyle` | `align` (`Align.START`/`CENTER`/`END`/`JUSTIFY`: `'start'`, `'center'`, `'end'`, `'justify'`), `left`, `right`, `textIndent`, `rtl`, `physical` (text-align left/right, which stay put in right-to-left text), `start`, `end` |
| `BookText` | `text` (string), `runs` (`[{ start, end, style, obj? }]`), `length`, `hasContent`, `pictures` (inline `ImagePicture`s to load), `rich()` → the text engine's `RichText` |

Paragraphs longer than 12,000 characters go on as new paragraphs at the next space (or line
break), so a book that is one huge paragraph still lays out quickly.

---

## `epub-xml.js`

### `new LenientXml(bytes)` and `lenientXml(bytes)`

A pull parser like the app's `LenientXml` (Android's XmlPullParser, relaxed): the character set
from the byte order mark or declaration (`XmlPrefix.charset`), the DOCTYPE dropped unread, HTML's
named characters known, unknown ones and a lone "&" kept as written, attributes unquoted or without
a value (`<nav hidden>` gives `hidden="hidden"`), mismatched and unclosed tags tolerated. It decodes
a megabyte at a time.

```js
const p = new LenientXml(bytes);           // throws XmlReadError when no root element starts in the first 8,192 characters
for (let type = p.next(); type !== END_DOCUMENT; type = p.next()) {
  if (type === START_TAG) p.localName(), p.attr('href'), p.attrs, p.depth;   // 'dc:title' → 'title'; attr by local name
  else if (type === TEXT) p.text;          // coalesced across references, CDATA, comments
  else if (type === END_TAG) p.name, p.depth;
}
```

- `next()` throws `XmlReadError` when the file ends inside a tag, comment, CDATA or declaration,
  or a tag is longer than a megabyte; readers keep what they had.
- `depth` counts as the app's parser does: every start tag opens a level (HTML-style `<br>` too),
  every end tag closes one whatever its name, and an end tag with nothing open is skipped.
- `lenientXml(bytes)`: the same, or null instead of the XmlReadError.
- `decodeReferences(text)`: numeric, XML and HTML references replaced (`"&eacute;&#x263A;"` →
  `"é☺"`; invalid numbers → U+FFFD).

---

## `epub-formats.js`

All of `core/EpubFormats.kt`:

```js
HtmlEntities.all.get('eacute')                       // 'é' (a Map of HTML 4's 253 names)
EpubPaths.resolve('OEBPS/text/ch1.xhtml', '../img/a%20b.png#x')   // ['OEBPS/img/a b.png', 'x']; null for http:, mailto:, data:
EpubPaths.decode('%C3%A9')                           // 'é' ("+" stays a plus)
EpubProtection.isProtected(rights, algorithms)       // DRM unless only font obfuscation
XmlPrefix.charset(head, length)                      // 'UTF-8', 'UTF-16LE', 'ISO-8859-1' (as declared, when the browser decodes it)...
XmlPrefix.stripDoctype(text)                         // without its DOCTYPE; null when unfinished or no root element starts in it
HtmlText.collapse(text, afterSpace, before = 0)      // white space as HTML shows it; line breaks between Chinese/Japanese characters go
HtmlText.endsInWideBreak(text, before), HtmlText.isWide(codePoint)
HtmlText.viewport('width=1200, height=800')          // [1200, 800]
HtmlText.listFormat('lower-roman', true)             // ListNumbering.Format.LOWER_ROMAN; null for 'none'
HtmlText.columnWidths([10, 30], 400)                 // half shared evenly, half by text
SimpleCss.parse(cssText) → CssSheet                  // rules with simple selectors; @-rules left out
SimpleCss.declarations('margin: 0 1em; page-break-before: always')   // { 'margin-top': '0', ..., 'break-before': 'always' } (no prototype)
SimpleCss.selector('div.poem > p') → CssSelector | null   // descendant and child combinators only
CssSheet.cascade(new CssNode(tag, id, classes, parent), sheets, styleAttribute)   // the declarations that win
CssValues.length('1.5em', em, base, percentOf, rem), fontSize(...), rootSize(...), bold(...),
CssValues.verticalMargins(...), horizontalMargins(...), fontFamily(...), pageBreak(...), writingMode(css), acrossFromVertical(css, mode)
```

Also Kotlin's rules where results depend on them: `ktFloat` (toFloatOrNull), `ktInt`
(toIntOrNull), `ktToInt`, `isKtWhitespace`, `ktTrim`, `codePointBefore`, and `breather(ms)`
(`await breathe()` lets the page paint when `ms` have passed since it last did).

---

## Messages

The engine has no strings of its own. Through `convertOffice('epub', ...)` /
`verifyOfficeFile('epub', ...)` a screen gets `UserError`s with these keys (strings.xml), and
`manyKey` for several books (`file_problem`: "%1$s: %2$s" names each):

| Key | English (one book) | `_many` |
|---|---|---|
| `epub_protected` | This book is protected with DRM (copy protection), so Usugami can't read it. Only books without DRM can be converted. | These books are protected with DRM (copy protection), so Usugami can't read them. Only books without DRM can be converted. |
| `epub_not_recognized` | This isn't an EPUB e-book, or it's damaged. | These aren't EPUB e-books, or they're damaged. |
| `epub_empty` | This book has nothing to convert. | These books have nothing to convert. |
| `office_convert_failed` | Couldn't convert this file. Check the file and free storage. | — |
| `web_fonts_unavailable` | Usugami couldn't load its fonts. Check your connection and try again. | — |

Strings a screen shows around it: `tool_epub` "EPUB to PDF", `tool_epub_detail` "E-books (.epub),
laid out as pages", `pick_epub` "Choose EPUB files", `add_epub` "Add EPUB files", `document_epub`
"EPUB e-book", `office_note_epub` "Chapters, headings, text styles, lists, tables and pictures
convert, and the table of contents becomes bookmarks. Your phone's fonts are used.",
`book_page_note` "A5 is about the size of a paperback; A4 suits printing.", `size_a5` "A5",
`size_a4` "A4", `progress_chapter` "Chapter %1$d of %2$d", `creating_pdf` "Creating and
compressing PDF…", `creating_pdfs` "Creating and compressing PDFs…".

---

## Differences from the app

- XML is read by a forgiving parser written to behave as Android's relaxed XmlPullParser, not by
  Android's own. Where they could differ: a "<" that starts no tag is text here (Android reads a
  tag of it), unknown references stay as written, invalid numeric ones become U+FFFD, a tag over a
  megabyte long ends the document.
- Pictures: sizes are read from the file's header for JPEG, PNG, GIF, BMP and WebP; HEIF and AVIF
  pictures count only where the browser decodes them (else their `alt` text shows, as for SVG).
  They are stored as office-core's OfficeImages stores them (150 pixels per inch where shown, JPEG
  quality 75) rather than drawn at 200 dpi and then compressed.
- Fonts are the bundled Noto fonts (serif, sans-serif, monospace) on every device; characters they
  lack (Chinese, Japanese, Arabic, Hebrew...) are drawn by the browser (see docs/api/text.md).
- Lengths are laid out in fractional points rather than Android's tenths, so a line or page can
  occasionally break in a slightly different place.
- A chapter inflating past 256 MB (zip.js's limit) is left out.
- A crafted file's extremes are cut short where the app would only be slow: a descendant selector
  looks at most 4,096 elements up; bookmarks nest at most 64 levels.
- Text starting with a Chinese or Japanese character right after a long paragraph was split at
  12,000 characters is read on; the app stops reading that chapter there (deleting from an empty
  paragraph throws).
- `%`-escapes in links next to characters outside the Basic Multilingual Plane decode correctly
  (the app turns those characters into "?").
- The app writes books of more than 400 pages in parts and joins them; here the PDF is one
  document until it is saved.

## Tests

`node tests/epub.test.mjs` (about 30 s): the app's EpubFormatsTest; the forgiving XML reader
(references, relaxed attributes, unclosed tags, encodings, text across its megabyte chunks); the
XHTML reader (the device test's checks, styles, lists, tables, pictures, margins); and books
converted and read back with pdf.js and pdf-lib: page sizes, reading order, text, fonts and sizes,
positions (centred, justified, right to left, indents), pictures and their pixels, covers, fixed
layout, bookmarks from NCX and nav documents and from headings, metadata, DRM, other files,
damaged and hostile books (20,000 nested tables, 100,000 nested elements, 4 MB paragraphs), a
405-chapter book, progress and cancelling, and a Japanese book written down the page. Chromium in
full; Firefox and WebKit for most of it.
