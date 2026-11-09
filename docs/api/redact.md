# Redact PDF engine (`site/app/js/engine/redact.js`)

The engine behind Redact PDF, ported from the app's `data/Redaction.kt` (Redactor), `core/Redaction.kt`
(boxes, PageText), `core/Areas.kt`, `data/XObjectCleanup.kt` and the redact parts of
`ui/PdfToolsViewModel.kt`. No UI: the screen (`js/tools/redact/`) is built on it.

- **Find text** boxes a word or phrase on every page: capitals and accents don't matter, every gap
  between words or lines is one space (a phrase is found across a line break), letter-spaced words
  (`J A N E  D O E`) and words broken after a hyphen at a line's end are found, typographic quotes,
  dashes and ligatures match what a keyboard types, right-to-left text drawn left to right is read
  in reading order. It reads the glyphs pdf.js draws, page content and annotation appearances
  (filled-in fields, stamps) alike, glyph by glyph, so boxes hug each line of a match. It also finds
  the query in what comments say (their text, author, subject), where links and buttons lead, and in
  form fields that hold it where no page shows it: those get a box so their page is redacted.
- **Redact** replaces each page with boxes by a picture of itself at 200 dpi (at most 12 million
  pixels), drawn as viewers show it, with the boxes painted solid black. Pages without boxes stay
  exactly as they were, unless they keep, out of sight, part of what a box hides (they draw the same
  content stream, or an image or form a box covers part of, without showing that part): those become
  pictures too, without boxes. Images, forms, patterns and soft masks only pictured pages drew are
  emptied even where shared resources still list them. Then the document details (Info, XMP),
  bookmarks, tags (structure tree), attached files, JavaScript (name tree and open action),
  application data (PieceInfo), article threads, the redacted pages' comments and form fields, named
  destinations to redacted pages, and what digital signatures say of their signers are removed.

Everything runs in the page (main thread), yielding to the browser with core/dom.js's `yieldToUI()`
between pages and inside long encodes, so the screen paints and takes input; files are never
uploaded. pdf.js documents it opens are closed with `loadingTask.destroy()` (pdf.js 6's document has
no `destroy()`).

## Boxes and coordinates

A **box** is `{ page, left, top, right, bottom }`: fractions (0–1) of the page **as shown** (its crop
box turned by its /Rotate), measured from its top-left corner, as on a screen. This is the app's
`RedactBox`; draw a box over a preview at `left × previewWidth`, `top × previewHeight`.

A **rect** is `{ x, y, width, height }` in the page's own, unturned coordinates (PDF user space,
points, y up; `(x, y)` is the lower-left corner).

A **frame** is `{ left, bottom, width, height, rotation, shownWidth, shownHeight }`: the page's crop
box (cut to its media box) and turn, as pdf.js reads them. `boxToRect` and `rectToBox` turn one into
the other with it.

## Engine functions

### `findText(input, query, hooks?) → Promise<Found[]>`

- `input`: `{ name?, bytes: Uint8Array, password? }` (a FileItem with a password, or a PdfSource).
- `query`: what to find; blank (after trimming) gives `[]`.
- `hooks`: `{ onProgress?(done, total), signal?: AbortSignal }` (one step per page).
- Returns `Found[]`, one entry **per line of each match**, in page order:
  `{ pageIndex, rect, box, match }` — `match` numbers the matches (a match broken over two lines is two
  entries with the same `match`).
- Throws `PasswordError` (`wrong` true when a password was given), `UserError('redact_find_failed')`,
  `CancelledError`.

```js
const found = await findText(source, 'Jane Doe', { signal, onProgress });
// [{ pageIndex: 0, rect: { x: 69.3, y: 633.1, width: 31.1, height: 23.7 },
//    box: { page: 0, left: 0.116, top: 0.22, right: 0.169, bottom: 0.248 }, match: 0 }, ...]
```

### `addFound(existing, found) → { boxes, added, matches, pages, tooMany }`

The view model's merging of a search into the boxes already drawn: boxes already there (`same`) aren't
added again. `existing` are boxes; `found` is what `findText` returned. `matches` is the number of
matches for `redact_found`; `pages` the page indices with matches (show the first unless the current
page has some); `tooMany` when more than `MAX_BOXES` (2000) would be kept (then `boxes` is `existing`).

```js
const r = addFound(boxes, found);
if (!found.length) snackbar(t('redact_find_none'));
else if (r.tooMany) snackbar(t('redact_find_too_many', MAX_BOXES));
else { boxes = r.boxes; searched.push(query); snackbar(tp('redact_found', r.matches, r.matches)); }
```

### `redactPdf(input, boxesByPage, hooks?) → Promise<OutputFile>`

- `boxesByPage`, any of:
  - a `Map` or object from page index (zero-based) to a list of rects (`{ x, y, width, height }`, user
    space) or boxes (`{ left, top, right, bottom }`, fractions as shown);
  - a list of `findText` entries (`{ pageIndex, rect }`), of `{ pageIndex, box }`, or of boxes with a
    `page`;
  - `{ boxes, searched, name }` with `boxes` one of the above.
- `hooks`: `{ onProgress?(done, total), signal?, searched?: string[], name?: string }`.
  - `searched`: what Find text looked for in this PDF (as typed, every query kept since the boxes were
    cleared). Form fields that hold it and that no page that stays shows are removed too.
  - `name`: the file name typed (without `.pdf`); default `redactedName(input.name)`
    (`Report.pdf` → `Report_redacted`). It is made safe as the app does (`Redacted` when blank).
- Boxes are cut to their page and made at least `MIN_SIZE`; boxes on pages past the end are ignored.
  At least one box must remain, else it throws a `RangeError` (the screen's button is off then).
- Returns `{ name: 'Report_redacted.pdf', bytes, type: 'application/pdf', pageCount, redactedPages,
  picturedPages }`: `redactedPages` are the pages with boxes, `picturedPages` those plus the pages that
  became pictures because they kept hidden content out of sight.
- Throws `PasswordError`, `UserError('pdf_import_failed')`, `UserError('redact_page_failed')`,
  `CancelledError`. The result has no password (as in the app).

```js
const out = await redactPdf(source, boxes.map((b) => ({ pageIndex: b.page, box: b })),
  { signal, onProgress, searched, name: fileNameField.value });
showResult(root, { files: [out] });
```

### `pageFrames(source) → Promise<Frame[]>`

Every page's frame. `source` is a pdf.js document (`await pdfSource.pdfjs()`) or an input. A page
pdf.js can't find (a page tree that loops) throws `UserError('pdf_import_failed')`.

### `renderPreview(pdf, pageIndex, cssWidth, { signal?, pixelRatio? }) → Promise<HTMLCanvasElement>`

Draws a page of a pdf.js document exactly as the redacted picture will show it (annotations and
filled-in fields included, which a plain thumbnail may leave out), `cssWidth` CSS pixels wide, sharp
at the device's pixel ratio. The canvas has `canvas.frame` (the page's frame) and its CSS width set.
Boxes drawn over it cover exactly what they will hide.

### `readPageTexts(input) → Promise<string[]>`

Each page's text as Find text reads it (folded: accents dropped, spaces single). For checks and tests.

## Box helpers (the app's `core/Redaction.kt`)

All take and return boxes; none change their arguments.

| Function | What it does |
| --- | --- |
| `makeBox(page, left, top, right, bottom)` | A box (values kept as 32-bit floats, as in the app) |
| `between(page, x0, y0, x1, y1)` | The box with those corners in either order, cut to the page (for drawing a box by dragging) |
| `clamp(box)` | At least `MIN_SIZE` wide and tall, moved as little as needed to be on the page |
| `moved(box, dx, dy)` | Moved, same size, stopping at the edges (arrow buttons: `±STEP`) |
| `resized(box, dw, dh)` | Wider/taller around its centre, at least `MIN_SIZE` (size buttons: `±STEP`) |
| `withCorner(box, right, bottom)` | Bottom-right corner dragged; top-left stays |
| `defaultBox(page, shownWidth, shownHeight, offset)` | "Add box": 2 inches wide, a line tall, centred, lower for each box already on the page (`offset`) |
| `hit(boxes, page, x, y, reachX, reachY)` | Index of the box tapped (smallest wins), counting `reach` around each; −1 for none |
| `findBox(boxes, index, was)` | Where box `was` (at `index` when touched) is now; −1 once changed or deleted |
| `same(a, b)` | Same box give or take 1e-4 (a button stays enabled while `!same(step(box), box)`) |
| `pack(boxes)` / `unpack(numbers)` | Boxes as five numbers each, for keeping them in a setting |
| `boxToRect(frame, box)` / `rectToBox(frame, page, rect)` | Box ↔ user-space rect |
| `pixelSize(shownWidth, shownHeight)` | `[w, h]` pixels a redacted page is drawn at (200 dpi, ≤ 12 MP) |
| `pixelBounds(box, w, h)` | `[left, top, right, bottom]` pixels a box blacks out (rounded outwards) |
| `PageFrame` | Class: `new PageFrame(left, bottom, width, height, rotation)`, `toShown(x, y)`, `toPage(x, y)`, `shownWidth`, `shownHeight`, `matrix` |
| `redactedName(fileName)` | Default file name: `withSuffix(base, '_redacted', 'Usugami')` |
| `normalizeQuery(query)` | The query as compared (folded, trimmed, single spaces); blank means nothing to find |

Constants: `DPI` 200, `MAX_PIXELS` 12 000 000, `MIN_SIZE` 0.005, `STEP` 0.005, `MAX_BOXES` 2000,
`TEXT_MARGIN` 0.15.

The app's screen also drops a drawn box smaller than 6 dp either way (a slip), keeps the boxes, the
page and the chosen box across rotation, and clears them all when the PDF changes.

## Errors thrown (keys for the screen's strings file)

| Key | English (strings.xml / common.js) | When |
| --- | --- | --- |
| `redact_find_failed` | Couldn't search this PDF. | Find text can't read the PDF |
| `pdf_import_failed` | Couldn't open that PDF. It may be damaged or unsupported. (common.js) | Redact can't open the PDF, or its page tree is damaged (no catalog, a loop, no `/Kids`, a page without its type or in the tree's place) |
| `redact_page_failed` | This page can't be shown, so it can't be redacted. | A page with a box can't be drawn |

Also `PasswordError` (ask for the password: `wrong` says whether one was given), `CancelledError`
(ignore quietly) and `RangeError` (no box on any page: a programming error).

Strings the screen shows from these results (from strings.xml, for its namespace file):
`redact_found` (one: "Found {1} match and boxed it. Check it before saving.", other: "Found {1}
matches and boxed them. Check them before saving."), `redact_find_none` ("Nothing found. Text in scans
and pictures can't be searched: draw boxes over it instead."), `redact_find_too_many` ("Too many
matches: Usugami keeps up to {1} boxes. Try a longer phrase."), `redact_too_many` ("Usugami keeps up
to {1} boxes.").

## Helpers under `engine/redact/` (internal)

`boxes.js` (geometry), `page-text.js` (folding and matching), `bidi.js` (reading order),
`glyphs.js` (glyph positions from pdf.js's operator list; lines and words as PDFBox reads them),
`content.js` (content stream tokenizer, image/form placements, emptying unused XObjects),
`hidden.js` (pages keeping hidden content out of sight), `leaks.js` (comment search, leak removal),
`picture.js` (rendering, black boxes, PNG-predictor deflate or JPEG, page replacement), `names.js`,
`objects.js` (pdf-lib helpers).

## Differences from the app

- Pages are drawn by pdf.js, not Android's renderer; annotations are drawn by pdf.js too (the app
  draws them into a copy first). A sticky note without an appearance stream gets no icon in the picture
  (Android/PDFBox draws a default one).
- Text positions come from pdf.js's glyphs (exact advances) rather than PDFBox's; line and word
  grouping follows PDFBox's rules. The bidirectional reordering has no explicit embeddings.
- Standard 14 fonts without a font box use those fonts' published boxes (pdf.js keeps none).
- The saved PDF has an Info dictionary with only `Producer: Usugami` (pdf-common's `savePdf` sets
  it); the app removes Info entirely. Nothing of the original Info stays.
- A page with an unreadable content stream that shares resources with a redacted page keeps those
  resources (it might draw them), exactly as in the app.
- A damaged page tree that pdf-lib reads otherwise than viewers do (it loops, lacks `/Kids`, has a
  page without its type, or a lone page in the tree's place) fails with `pdf_import_failed`; the app
  mends such a tree when the PDF is opened and redacts it. Split, Delete pages and the other organize
  tools mend it here too (cleanup.js `repairPageTree`).
