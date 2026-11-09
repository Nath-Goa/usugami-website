# Page numbers and watermarks (`site/app/js/engine/stamps.js`)

Add page numbers and Add watermark: the engine, and the two screens built on it
(`js/tools/page-numbers/`, `js/tools/watermark/`). Ported from the app's `PageStamps.kt`
(where numbers and watermarks go), `Watermark.kt` (the watermark's text, colours and opacities),
the page-number and watermark parts of `PdfToolsEngine.kt` and `PdfToolsViewModel.kt`, and
`PdfEditOptions.kt`'s `PageNumberOptions` and `WatermarkOptions`. Tests: `tests/stamps.test.mjs`
(`--quick`: Chromium only; the screens in Chromium, Firefox and WebKit pick PDFs through the real
file input, and drop them on the card or the screen in other steps).

```js
import {
  addPageNumbers, addWatermark, numberedPages, numberedEach, watermarkStamp, paintWatermark,
} from '../engine/stamps.js';
// The layout, choices and names alone (no pdf-lib, no text engine), for screens to load first:
import { numberedEach, PAGE_NUMBER_POSITIONS, WATERMARK_COLORS, defaultName, outputNames } from '../engine/stamps-layout.js';
```

`engine/stamps-layout.js` holds everything below that is pure: `PageFrame`, the page-number
positions, sizes and defaults, `numberedPages`, `numberedEach`, `numberMargin`, `numberOrigin`,
`numberStyle`, the watermark's colours, opacities, limits and defaults, `watermarkStyle`,
`placeWatermark`, `defaultName`, `outputNames`, `BATCH_NAMES` (and, for stamps.js, `positionOf`,
`alphaOf`, `STAMP_PAD`, `FALLBACK_NAMES`). `engine/stamps.js` re-exports all of it with the
engines, `frameOfPage`, `canDrawWatermark`, `watermarkStamp`, `drawStamp` and `paintWatermark`.

What both engines do, as the app does:

- They draw on each page **as a viewer shows it**: its crop box (inherited, cut to the media box,
  as pdf.js and PDFBox read it) turned by its `/Rotate`. A number put at the bottom of a page
  turned sideways is at the bottom the reader sees; the watermark runs from the shown bottom-left
  corner to the shown top-right one. A `/Rotate` that isn't a quarter turn counts as none (as
  pdf.js shows it). Pages with no area are passed over.
- The text is **real text** (searchable, copyable; Hindi copies back in order), drawn with the text
  engine (`engine/text/`) in the bundled Noto Sans, only the glyphs used embedded.
- The page's own drawing is wrapped in `q`/`Q` first, so a transform or colour it leaves set
  can't move or recolour what is added.
- The PDF made has **no password** (`passwordRemoved: true` when the input had one: show
  `pdf_password_removed`). It keeps everything else (form fields, comments, bookmarks, links).
- Damaged page trees are read as viewers read them (cleanup.js's `repairPageTree`).
- Each page yields to the browser now and then (every 30 ms of work), reports progress and stops
  on `hooks.signal`.

## Inputs and outputs

```js
// input: a FileItem or PdfSource's parts
{ name: 'Report.pdf', bytes: Uint8Array, password?: 'secret' }   // password '' or missing: none

// hooks
{ onProgress?: (done, total) => void, signal?: AbortSignal }      // total = pages + 1 (the save)

// OutputFile
{ name: 'Report_numbered.pdf', bytes: Uint8Array, type: 'application/pdf', pageCount: 12, passwordRemoved?: true }
```

Page numbers passed to the engine are **zero-based**; typed text is one-based ("1-2,5").

---

## addPageNumbers(input, options, hooks) → Promise<OutputFile>

Writes on pages its own page number (page 3 shows "3"), black, at `position` on the page as
shown (PdfToolsEngine.addPageNumbers / addPageNumbersEach for one PDF).

| option | | default |
|---|---|---|
| `position` | `'top-left'`, `'top-center'`, `'top-right'`, `'bottom-left'`, `'bottom-center'`, `'bottom-right'` (the app's `'BOTTOM_RIGHT'` works too) | `'bottom-center'` |
| `size` | `'small'` (9 pt), `'medium'` (12 pt), `'large'` (16 pt), or points | `'medium'` |
| `pages` | the zero-based pages to number; pages the PDF doesn't have are passed over | all but `skip` |
| `skip` | pages to leave without a number, as typed: `'1'`, `'1-2,5'`, blank for none | `''` |
| `skipAgainst` | the page count `skip` is read against (several PDFs: the longest's), if more than the PDF's own | the PDF's |
| `fileName` | the name typed, without `.pdf` (made safe; `'Numbered'` if it ends up empty) | `defaultName('page-numbers', input)` |

Where the number goes (PageNumbers.origin): the margin is `min(36, 0.06 × the shown page's
shorter side)` points from the edges; at the bottom the number's baseline sits on the margin, at
the top its digits (cap height tall) hang from it; left and right align its advance to the margin,
centre centres it.

```js
const out = await addPageNumbers(input, { position: 'bottom-right', size: 'medium', skip: '1' }, hooks);
// { name: 'Report_numbered.pdf', pageCount: 12, ... }: page 1 without a number, page 2 numbered "2"

// Several PDFs, as the screen does it: the skip text checked first against the longest.
const counts = sources.map((s) => s.pageCount);
numberedEach('1, 3', counts);                 // throws PageSelectionError if it can't be used
await addPageNumbers(input, { skip: '1, 3', skipAgainst: Math.max(...counts), fileName }, hooks);
```

Throws:
- `UserError('page_numbers_all_skipped')` when no page is left to number (with several PDFs, run
  through `runBatch(..., { named: { page_numbers_all_skipped: 'batch_nothing_to_number' } })`).
- `PageSelectionError` (a UserError, from `engine/page-selection.js`) for `skip` it can't use:
  `pdf_pages_format`, `pdf_pages_range` (args: the page count), `pdf_pages_reversed`.

## addWatermark(input, options, hooks) → Promise<OutputFile>

Draws the text large, diagonally across the middle of every page as shown (PdfToolsEngine.addWatermark).
The text is drawn once into a form (a transparency group, so the opacity fades it as a whole) that
every page shows: 500 pages take the room of one.

| option | | default |
|---|---|---|
| `text` | the watermark, 1 to 80 characters once trimmed | (required unless `stamp`) |
| `color` | `'gray'`, `'black'`, `'red'`, `'blue'`, `'green'` (or any CSS colour) | `'gray'` |
| `opacity` | `'translucent'` (0.3), `'semi'` (0.6), `'opaque'` (1), or an alpha 0..1 | `'translucent'` |
| `stamp` | a stamp from `watermarkStamp(text, color)`, to measure the text once for several PDFs | made from `text`, `color` |
| `fileName` | as above, `'Watermarked'` if empty | `defaultName('watermark', input)` |

Where it goes (WatermarkLayout.place): centred on the shown page, turned anticlockwise to its
diagonal, as large as fits both 70 % of the diagonal and 18 % of the shorter side in height.

```js
const out = await addWatermark(input, { text: 'CONFIDENTIAL', color: 'red', opacity: 'semi' }, hooks);

// Several PDFs: the text laid out once.
const stamp = await watermarkStamp('DRAFT', 'blue');
for (const src of sources) await addWatermark(src, { stamp, opacity: 'translucent', fileName: names[i] }, hooks);
```

Throws (before opening the PDF):
- `UserError('watermark_no_font')` when no font (bundled, or the browser's) can draw some of the
  characters, or the text draws nothing. Screens show it with `tWeb('watermark_no_font')`.
- `UserError('web_fonts_unavailable')` (text engine) when the fonts can't be fetched (offline).
- `RangeError` for blank text or more than 80 characters (the screen doesn't allow either).

## Both

Also from `loadPdf`: `UserError('pdf_import_failed')` (not a PDF, no page tree), `PasswordError`
(missing or wrong password: `wrong` true for a wrong one), and `CancelledError` when `signal` aborts.
Other failures are plain `Error`s (the batch says "Couldn't process …").

---

## The layout (PageStamps.kt), pure

### class PageFrame(left, bottom, width, height, rotation = 0)
A page as shown: its crop box in the page's own coordinates, turned clockwise by `rotation`
(a multiple of 90, else `RangeError`; `-90` is `270`).
- `rotation`, `shownWidth`, `shownHeight`
- `matrix` → `[a, b, c, d, e, f]` (as a PDF `cm`) from the shown page (origin bottom-left, y up) to the page's coordinates
- `topLeftMatrix` → the same from the shown top-left corner with y down (as a canvas)
- `toPage(x, y)` → `[x, y]` on the page; `toShown(x, y)` → `[x, y]` as shown
```js
new PageFrame(10, 20, 400, 600, 90).toPage(0, 0)   // [410, 20]: the shown bottom-left corner
```

### frameOfPage(doc, pageDict) → PageFrame
A pdf-lib page dictionary's frame as viewers read it (crop box cut to the media box).

### numberedPages(skip, pageCount) → number[]
The zero-based pages that get a number: all but those in `skip`. Throws `PageSelectionError`.
```js
numberedPages('1-2,4', 4)   // [2]
numberedPages('', 3)        // [0, 1, 2]
```

### numberedEach(skip, pageCounts) → number[][]
The same for several PDFs, `skip` read against the longest: a shorter one has no page 4 to skip.
```js
numberedEach('1', [4, 2, 1])      // [[1, 2, 3], [1], []]  (the last has nothing to number)
numberedEach('1, 4', [3, 5])      // [[1, 2], [1, 2, 4]]
numberedEach('5', [2, 4, 3])      // throws pdf_pages_range with args [4]
```

### numberMargin(shownWidth, shownHeight) → number
`min(36, 0.06 × min(w, h))`: `numberMargin(595, 842)` → 35.7.

### numberOrigin(position, shownWidth, shownHeight, textWidth, textHeight) → [x, y]
Where the number's baseline starts, from the shown bottom-left corner, y up.
```js
numberOrigin('bottom-right', 600, 800, 20, 10)   // [544, 36]
numberOrigin('top-center', 600, 800, 20, 10)     // [290, 754]
```

### placeWatermark(shownWidth, shownHeight, stampWidth, stampHeight) → { centerX, centerY, degrees, scale }
Centre (from the bottom-left, y up), anticlockwise turn in degrees, and scale of the stamp.
```js
placeWatermark(595, 842, 1000, 50)   // { centerX: 297.5, centerY: 421, degrees: 54.75, scale: 0.7217 }
```

### numberStyle(size) → style
The text engine style of page numbers: `{ family: 'sans-serif', size: 12, color: '#000000' }`.

---

## The watermark's stamp (Watermark.kt)

### watermarkStamp(text, color = 'gray') → Promise<stamp>
The text, trimmed, laid out bold at 100 points in `color`, in a box just around its ink (rounded
out to whole points, as Android's `getTextBounds`) with 2 points to spare: the app's one-page stamp.
`{ text, style, width, height, x, baseline, layout }`: the box is `width × height` points and the
pen starts at (`x`, `baseline`) from its top-left corner. Throws as `addWatermark` does.

### drawStamp(target, stamp, x = 0, y = 0)
Draws the stamp's text with its box's top-left corner at (x, y), on a `PdfCanvas` or a screen 2D context.

### paintWatermark(ctx2d, stamp, width, height)
The screen preview (WatermarkPreview): draws the stamp on a 2D context covering a page shown
`width × height` (in the context's units), at the PDF's place, angle and size compared with the
page, with the same glyph outlines. Fade it with the layer's opacity (the PDF fades the stamp as
a whole).
```js
const stamp = await watermarkStamp('DRAFT', 'red');
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
paintWatermark(ctx, stamp, 280, 396);      // canvas.style.opacity = '0.3' for translucent
```

### canDrawWatermark(text) → boolean
WatermarkText.canDraw: whether a font (bundled or the browser's) has every character that needs
drawing (spaces, joiners and variation selectors need none).

### watermarkStyle(color) → style
`{ family: 'sans-serif', bold: true, size: 100, color }`.

---

## Names

### defaultName(tool, input) → string
The name the PDF gets unless another is typed (PdfToolsViewModel.defaultName), the base cut
rather than the ending: `defaultName('page-numbers', { name: 'Report.pdf' })` → `'Report_numbered'`,
`defaultName('watermark', { name: 'a.pdf' })` → `'a_watermarked'`, no input → `'Usugami_…'`.

### outputNames(tool, names) → string[]
Names typed for PDFs made together, made safe and told apart ignoring case (the engine's
`FileNames.uniqueNames`): `outputNames('page-numbers', ['Numbered', 'numbered.pdf'])` →
`['Numbered', 'numbered (2)']`; an empty one becomes `'Numbered'` / `'Watermarked'`.

## Constants

| | |
|---|---|
| `PAGE_NUMBER_POSITIONS` | `{ 'top-left': { top: true, column: 0 }, ... 'bottom-right': { top: false, column: 2 } }` |
| `PAGE_NUMBER_SIZES` | `{ small: 9, medium: 12, large: 16 }` |
| `DEFAULT_POSITION`, `DEFAULT_SIZE` | `'bottom-center'`, `'medium'` (the screen's first choices) |
| `WATERMARK_COLORS` | `{ gray: '#757575', black: '#000000', red: '#d32f2f', blue: '#1565c0', green: '#2e7d32' }` |
| `WATERMARK_OPACITIES` | `{ translucent: 0.3, semi: 0.6, opaque: 1 }` |
| `DEFAULT_COLOR`, `DEFAULT_OPACITY` | `'gray'`, `'translucent'` |
| `WATERMARK_MAX_LENGTH` | 80 (UTF-16 units, as the app counts) |
| `WATERMARK_MAX_SPAN`, `WATERMARK_MAX_HEIGHT` | 0.7, 0.18 |
| `BATCH_NAMES` | `{ 'page-numbers': 'Numbered_PDFs', watermark: 'Watermarked_PDFs' }`: what several PDFs made together (and their ZIP file) are called |

---

## The screens

`js/tools/page-numbers/index.js` and `js/tools/watermark/index.js` export `mount(ctx)`. Both are
built on `js/tools/page-numbers/stamp-screen.js` (`mountStampTool(ctx, spec)`, the flow both
batch tools share; its CSS classes start with `stamps-`):

- The screens load only `stamps-layout.js`: the engines (`engine/stamps.js`, with pdf-lib, fontkit
  and the text engine) load once a PDF is added, or the watermark preview has text to draw
  (`loadStampsEngine()` from stamp-screen.js, shared by both tools), and are waited for when the
  main button is pressed. If they can't be fetched: `web_tool_load_failed`.
- The content is the screen's `<main data-main>` landmark, which the skip link goes to.
- No PDF: the "Choose PDFs" card ("You can choose several at once."), a drop zone too.
- One PDF: its card (Remove starts over), Add PDFs, the tool's choices, and "File name" (`.pdf`).
- Several: the choices first, the line saying they go for all, then each PDF's card with its own
  name field (the kit's `batchList`), Add PDFs. On screens 840 px and wider, the PDFs on one side
  and the choices on the other; PDFs dropped or pasted anywhere on the screen are added.
- The main button: "Add page numbers" / "Add page numbers to 3 PDFs" (and the watermark's), off
  until there is a PDF (and, for the watermark, text). Checks first (pages to skip against the
  longest PDF; text no font can draw), then `runBatch` ("PDF 2 of 5"), then the result screen
  (`showResult`, ZIP named `Numbered_PDFs` / `Watermarked_PDFs`). Back returns to editing with
  the choices kept; the browser's Back (Android's Back) does the same (a history step `'result'`,
  `onStep(null)`). The browser's Forward then shows that result again (`onStep('result')`); after
  Start over there is none, and its step goes back. Opened on the result step (a reload there),
  the tool starts empty and the step goes.
- `ctx.files` (shared PDFs, Choose a tool) are opened at mount, with `item.password` when given
  (the kit's `openPdf` tries it first). Leaving the tool while a password is asked for takes the
  question away with it (`openPdf`'s `signal`).
- `hasUnsavedWork()` is true while a result isn't saved (as the app: choices alone aren't work),
  and while the PDFs are being made: the app ignores Back then; here leaving asks first, as the
  other tools do, and Discard stops the run.
- While PDFs open, Choose PDFs and the Add PDFs buttons are off with `aria-disabled`, not
  `disabled`: they keep the focus, so a cancelled password dialog gives it back there.
- The focus stays where it is while PDFs come and go, as in the app: a name being typed keeps it
  (a card that stays is never taken out of the page); when the one-PDF "File name" becomes the
  list (or the list goes back to one PDF) the same PDF's name field takes it. A control removed
  with the focus in it hands it to Add PDFs, or to the empty card; never to a Remove button.
- Each name field shows the name its PDF will get: going from several PDFs to one, or back, the
  field shows the name typed in the other layout.
- One PDF picked that can't be opened is told about without its name ("Couldn't open that PDF…"),
  as the app's addPdfs; several are named ("a.pdf, b.pdf: Couldn't open these PDFs…").
- Snackbars show above the bottom bar while it is there: the kit's snackbar measures the bar
  (the screen sets no `--snackbar-offset`).

Add page numbers: Position (a small page with a radio-button spot for each of the six places; the
arrow keys move between them as they sit on the page, Home/End to the first/last; the chosen place
in words beside it), Size (segmented), Pages to skip with its hint and the note under it.
Add watermark: Watermark text (at most 80 characters), Color (round swatches, a radio group),
Opacity (segmented), and Preview: page 1 of the first PDF with the watermark drawn on it by
`paintWatermark`, 280 × 220 px at most on phones (420 × 330 from 840 px), an A4 blank until page 1
is drawn, the layer faded to the opacity chosen. The preview is never wider than its column (two narrow
panes just past 840 px): it is laid out again when the column changes width.

## Strings

`locales/en/page-numbers.js`: `pdf_page_numbers_action`, `pdf_page_numbers_action_many`,
`page_numbers_position`, `position_*` (6), `page_numbers_size`, `number_size_small|medium|large`,
`page_numbers_skip`, `page_numbers_skip_hint`, `page_numbers_note`, `page_numbers_all_skipped`,
`page_numbers_for_all_hint`, `batch_nothing_to_number`, `pdf_pages_format`, `pdf_pages_range`,
`pdf_pages_reversed`, `pdf_invalid_pages`, `web_fonts_unavailable`, `web_opening_pdfs`.

`locales/en/watermark.js`: `pdf_watermark_action`, `pdf_watermark_action_many`, `watermark_text`,
`watermark_text_hint`, `watermark_color`, `color_gray|black|red|blue|green`, `watermark_opacity`,
`opacity_translucent|semi|opaque`, `watermark_preview`, `watermark_preview_description`,
`watermark_for_all_hint`, `watermark_no_font`, `web_watermark_no_font`, `web_fonts_unavailable`,
`web_opening_pdfs`.

## UserError keys thrown by the engine

| key | English | args |
|---|---|---|
| `page_numbers_all_skipped` | Leave at least one page to number. | |
| `pdf_pages_format` | Use page numbers such as 1,3-5. | |
| `pdf_pages_range` | Pages must be between 1 and {1}. | page count |
| `pdf_pages_reversed` | Write ranges from low to high, such as 3-8. | |
| `watermark_no_font` | This phone has no font for some of these characters. Try different text. (web: `web_watermark_no_font`, "This device has no font for some of these characters. Try different text.") | |
| `web_fonts_unavailable` | Usugami couldn't load its fonts. Check your connection and try again. | |
| `pdf_import_failed` | Couldn't open that PDF. It may be damaged or unsupported. (common.js) | |

Several PDFs (the screens, through `runBatch`): `batch_nothing_to_number` — one: "No page is left
to number in {2}, so it was left out."; other: "No page is left to number in {1} PDFs, so they were
left out: {2}."

## Differences from the app

- Numbers are drawn in the bundled Noto Sans (embedded, only the digits used); the app writes them
  in Helvetica, a standard font viewers supply. Digits are placed by Noto Sans's cap height (0.714)
  where the app uses Helvetica's (0.718).
- The watermark is laid out by the text engine, not Android's text drawing: the same bold
  sans-serif at 100 points, the same box around the ink and the same placement, but the bundled
  fonts' shapes. Characters no bundled font has are drawn by the browser into pictures with their
  text kept invisibly (see text.md).
- In Firefox, a character no font has is drawn as a box with its code in it, which the text engine
  can't tell from a real character, so such text isn't refused there (it is in Chromium and Safari).
- A `/Rotate` that isn't a multiple of 90 counts as none, as pdf.js shows it; PDFBox would fail.
