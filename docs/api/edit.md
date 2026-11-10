# Edit PDF (`engine/edit.js`, `engine/edit/`, `tools/edit/`)

Edit PDF puts **text, pen and highlighter strokes, shapes (rectangles, filled or not, ellipses,
lines, arrows) and pictures** on top of a PDF's pages, one page at a time, and saves them into the
PDF exactly where the preview showed them, also on pages turned by `/Rotate` or cropped.

A port of the app's `PageEdits.kt` (items and `EditLayout`, with its unit tests), `EditHistory.kt`,
`PageEditing.kt`, `PageText.kt`, `PagePictures.kt`, `EditPdfOptions.kt`, `EditPreview.kt` and the edit
parts of `PdfToolsEngine.kt`, `PdfToolsViewModel.kt` and `PdfToolScreen.kt`.

| File | What it is |
|---|---|
| `engine/edit.js` | `editPages()`, `shownPageSizes()`, and everything below re-exported |
| `engine/edit/layout.js` | items, geometry, hit testing, handles, new items (PageEdits.kt) |
| `engine/edit/history.js` | `EditHistory`: items, the chosen one, Undo and Redo, limits |
| `engine/edit/text.js` | text layout and drawing at 100 pt (PageText.kt), on the text engine |
| `engine/edit/pictures.js` | taking pictures in, decoding them, putting them in a PDF (PagePictures.kt) |
| `engine/edit/draw.js` | drawing an item on a screen canvas or a `PdfCanvas`, the same way |
| `tools/edit/index.js` | the screen (`mount(ctx)`) |
| `tools/edit/stage.js` | the page preview: drawing, zoom, touches, mouse |
| `tools/edit/controls.js` | the row of tools, colours, the chosen item's controls, the row of pages, the text dialog |
| `tools/edit/edit.css` | its styles (`edit-` classes) |
| `locales/en/edit.js` | its strings |

```js
import {
  editPages, shownPageSizes, EditHistory, newShape, clearOf, unitSize, newText, importPicture, newPicture,
} from '../../engine/edit.js';
```

**Units and coordinates.** Everything is in **points on the page as it is shown** (its crop box cut to its media box, or the whole media box when that leaves nothing; turned
as `/Rotate` turns it), from the shown page's **top-left corner, y down**, as on a screen. Colours are
CSS hex strings (`'#d32f2f'`).

---

## Saving: `editPages(input, options, hooks)`

```js
const out = await editPages(
  { name: 'Report.pdf', bytes, password },            // a PdfSource's bytes and password ('' or none: no password)
  { items: history.items, name: 'Report_edited' },    // the items; the new file's name (no .pdf needed)
  { onProgress: (done, total) => dialog.update(done / total), signal },
);
// out = { name: 'Report_edited.pdf', bytes: Uint8Array, type: 'application/pdf', pageCount: 4 }
```

- Draws each page's items in the order they were added (the last on top), as ordinary page content
  after the page's own (which is wrapped in `q … Q` first, so what it leaves set can't move or
  recolour the items). Strokes and shapes are vector paths with round ends and corners; a highlighter
  is drawn at 55 % and multiplied with the page (`/CA 0.55`, `/BM /Multiply`), so text under it stays
  dark; text is real, searchable text (Type 0 fonts, subsets, ToUnicode; Hindi copies back in order);
  pictures are images (below).
- **Form fields and comments under an item's ink** (not those inside an outline or beside a stroke:
  `paintedAreas()`) are drawn into the page first and taken off it, so the item covers them as the
  preview shows (`engine/flatten.js` `bakeUnder`, loaded only for pages with annotations). Links stay.
- **Pages without items aren't touched**: their content streams and resources stay byte for byte.
- Items on pages the PDF doesn't have are left out. No items left: `RangeError` (a programming error:
  the screen's Save button is off then).
- The name: `options.name` made safe (`sanitizeName(name, 'Edited')`), `.pdf` added. The screen's
  default is `withSuffix(baseName(pdf), '_edited', 'Usugami')`, as the app's `defaultName(EDIT)`.
- The result has no password, as every tool's.
- `onProgress(done, total)`: `total` = items + 1, ending with `(total, total)`; the main thread yields
  between pages. `signal`: aborting throws `CancelledError` between items and pages.

Throws:

| Key / error | English | When |
|---|---|---|
| `watermark_no_font` | This phone has no font for some of these characters. Try different text. (web: `web_watermark_no_font`, "This device has…") | A text has characters no bundled font nor the browser can draw (`canDrawText`). Checked before anything is drawn. |
| `edit_picture_failed` | Couldn't read that picture. | A picture can't be decoded any more. |
| `web_fonts_unavailable` | Usugami couldn't load its fonts. Check your connection and try again. | From the text engine, offline before the fonts were saved for offline use. |
| `pdf_import_failed` | Couldn't open that PDF. It may be damaged or unsupported. | pdf-lib can't read the PDF (`pdf-common.js`), or it has no pages that can be found (also from `shownPageSizes`). A page tree that loops, or a page without its `/Type`, is mended first (`flatten/pages.js` `viewerPages`, as Flatten PDF and Compress PDF do), so items go on the pages the preview shows. |
| `PasswordError` | — | The password is missing or wrong. |
| `CancelledError` | — | `signal` aborted. |

## `shownPageSizes(input)`

```js
const sizes = await shownPageSizes({ bytes, password });
// [{ width: 841.89, height: 595.28, rotation: 90, box: [0, 0, 595.28, 841.89], matrix: [0, 1, 1, 0, 0, 0] }, …]
```
Each page's size **as shown**, read by pdf-lib exactly as `editPages` places items: `box` is the crop
box `[left, bottom, right, top]` in the page's own coordinates, `rotation` its `/Rotate`, `matrix` the
shown → page matrix (`topLeftMatrix`). The preview draws each page with pdf.js into exactly this box,
so items land where they show. Throws as `loadPdf`.

---

## Items (`engine/edit/layout.js`)

Frozen plain objects; every change makes a new one (`copy()`), so the history can keep old lists.

```js
textItem({ id, page, x, y, text, size, color, unitWidth, unitHeight })
// type 'text'. Lines split at '\n', left-aligned, the box's top-left at (x, y), `size` the font size in points.
// unitWidth/unitHeight: the box at 1 pt (text.js unitSize()); the box is size × that.
inkItem({ id, page, points: [x0, y0, x1, y1, …], width, color, highlighter = false })
// type 'ink'. Drawn as the smooth curve a signature is (outline()); one point is a dot. RangeError for an odd or empty list.
shapeItem({ id, page, kind: 'rectangle'|'ellipse'|'line'|'arrow', x1, y1, x2, y2, width, color, filled = false })
// type 'shape'. A box from (x1, y1) to (x2, y2) (x1 ≤ x2, y1 ≤ y2), outlined `width` wide or filled;
// or a line or arrow from (x1, y1) to (x2, y2), the arrow's head at the end.
pictureItem({ id, page, picture, x, y, width, height })
// type 'picture'. `picture` from importPicture(); the box has the picture's upright shape.
copy(item, changes)          // a new item with `changes`
```
`ShapeKind` (`RECTANGLE`…), `Handle` (`TOP_LEFT`, `TOP_RIGHT`, `BOTTOM_LEFT`, `BOTTOM_RIGHT`, `START`, `END`).
`isBox(item)` (rectangle or ellipse), `strokeWidth(item)` (0 for a filled box), `sameItem(a, b)`,
`sameItems(listA, listB)`, `contains(list, item)` (Kotlin's data-class equality; a picture by identity).

### Geometry

| Function | Returns |
|---|---|
| `bounds(item)` | `{ x, y, width, height }`: what it covers, ink included (a stroke's smoothed curve, half its width out) |
| `curveBounds(ink)` | the curve alone, no width |
| `inkBounds(strokes, penWidth)` | SignatureLayout.inkBounds for `[[x, y, …], …]`; null for no points |
| `shifted(item, dx, dy)` | moved anywhere |
| `scaled(item, factor, cx, cy)` | `factor` times as big about (cx, cy); line widths kept; text's font size scales |
| `outline(item)` | its path: `[['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2, x, y], ['Z']]` (none for text and pictures) |
| `quadratic(x0, y0, cx, cy, x, y)` | the quadratic curve as its exact cubic `['C', …]` |
| `ellipse(left, top, right, bottom)` | four cubics, clockwise from the top |
| `arrowHead(x1, y1, x2, y2, width)` | `[x, y, x, y]`: the barbs' ends, 30° off the line, `max(10, 4 × width)` long but at most half the arrow |
| `paintedAreas(item)` | boxes covering where it puts ink (an outline's edges, a stroke's path, ≤ about 6 pt across): what `bakeUnder` checks |
| `size(item)` | for the size slider: font size; else the longer side (no line width), or a line's length |
| `sizeRange(item, w, h)` | `{ min, max }`: text 6…min(96, fits); others min(8, now)…as big as fits |
| `resized(item, size, w, h)` | made `size` big about its centre, kept on the page |
| `onPage(item, w, h)` | moved as little as needed onto the page; bigger than the page: centred |
| `clampMove(bounds, dx, dy, w, h)` | `[dx, dy]` shortened at the edges |
| `moved(item, dx, dy, w, h)` | moved, stopping at the edges (as the move buttons and drags do) |
| `handles(item)` | `[[handle, x, y], …]`: a box's or picture's corners, a line's ends, text's and a stroke's bottom-right |
| `dragHandle(start, handle, x, y, w, h)` | `start` with `handle` dragged to (x, y): a box's opposite corner stays (it may turn inside out; ≥ 8 pt); a picture keeps its shape; a line's end moves; text and strokes grow from their top-left along the diagonal (text 6…96 pt) |
| `hits(item, x, y, reach)` | a touch within `reach` of what it draws (an outline by its line, so what it frames can still be tapped) |
| `pick(items, x, y, reach, chosenId)` | the chosen item if touched, else the topmost touched, else null |
| `distanceToSegment(x, y, x1, y1, x2, y2)` | |
| `topLeftMatrix(left, bottom, width, height, rotation)` | PageFrame.topLeftMatrix: shown → page `[a, b, c, d, e, f]` |
| `fromTopLeft(matrix, x, y)` | `[x, y]` on the page |
| `pageArea(matrix, x, y, width, height)` | `[left, bottom, right, top]` on the page (Flattening.pageArea) |

### New items

```js
newShape(id, page, kind, filled, width, color, pageWidth, pageHeight)
// in the middle: a box a third of the shorter side wide (a rectangle 0.6 as tall), or a line as long
newText(id, page, text, fontSize, color, unitWidth, unitHeight, pageWidth, pageHeight)
// in the middle, at fontSize or smaller if wider than 90 % of the page (never under 6 pt)
newPicture(id, page, picture, aspect, pageWidth, pageHeight)
// in the middle, half the page wide (or half as tall)
clearOf(item, others, pageWidth, pageHeight)
// moved down and right in steps of 4 % of the shorter side while centred on another item of its page
```
```js
const box = clearOf(newShape(history.newId(), page, 'rectangle', true, 2.5, '#d32f2f', w, h), onPage, w, h);
const [uw, uh] = await unitSize('Hello');
const text = clearOf(newText(history.newId(), page, 'Hello', 14, '#000000', uw, uh, w, h), onPage, w, h);
```

### Constants

`MIN_SIZE` 8, `MIN_TEXT` 6, `MAX_TEXT` 96, `PEN_WIDTHS` `{ min: 0.5, max: 20 }`, `HIGHLIGHTER_WIDTHS`
`{ min: 4, max: 40 }`, `HIGHLIGHTER_ALPHA` 0.55, `PAINT_STEP` 6, `NUDGE` 0.02 (a move button's step,
of the shorter side), `MAX_EDIT_ITEMS` 300, `MAX_INK_POINTS` 20 000, `EDIT_COLORS` (black `#000000`,
blue `#1565c0`, red `#d32f2f`, green `#2e7d32`, yellow `#ffe600`, white `#ffffff`, each
`{ id, color, label }` with its string key), `DEFAULT_STYLE` (EditStyle: text black 14 pt, pen blue
2.5, highlighter yellow 14, shapes red 2.5).

`inkPoints(items)` (stroke points used), `describeKey(item)` → `['edit_item_text', text]`,
`['edit_item_drawing']`, `['edit_picture']`, `['edit_item_filled_rectangle']`… (what a screen reader
calls it: `t(...describeKey(item))`).

---

## `EditHistory` (`engine/edit/history.js`)

```js
const history = new EditHistory([], () => render());   // items to start with, called after every change
history.items, history.selected, history.canUndo, history.canRedo, history.full
history.newId()                 // ids never reused
history.add(item)               // on top; chosen unless a stroke; false (nothing added) at 300 items or 20 000 stroke points
history.replace(item)           // one change: the item with its id replaced
history.remove(id)              // one change; nothing chosen
history.select(id | null)
history.begin(); history.stepItem(item) / history.step(list) / history.drag(was, item); history.end()
                                // a drag or slider: many steps, one change for Undo; ending where it began leaves
                                // Undo and Redo as they were; drag() refuses (false) once `was` changed or isn't chosen
history.undo() / history.redo() // the page of the change shown (to go to it), or null when there is none
history.inkRoom()               // stroke points still allowed
history.change(list), history.clear()
```
`MAX_UNDO` 50 changes. Kept in memory for the visit (the app keeps items in Android's saved state).

---

## Text (`engine/edit/text.js`)

```js
await unitSize('Hello\nदुनिया')          // [unitWidth, unitHeight]: the box at 1 pt (loads the fonts)
canDrawText(text)                       // PageText.canDraw: false when some character can't be drawn (no font loaded to know)
const layout = await textLayout(text, color)   // or textLayoutSync once the fonts are loaded
// { lines: [{ text, layout }], width, ascent, lineHeight, height } at REFERENCE (100 pt)
drawText(target, item, layout)          // on a PdfCanvas or a 2D context
textLayoutNow(text, color)              // textLayoutSync if the fonts are loaded already, else null (loads nothing)
```
As PageText: Noto Sans (the text engine's sans-serif) at 100 pt, lines left-aligned, each
`lineHeight` apart, the first baseline `ascent` below the top; scripts reaching past the main font
(Devanagari) make every line taller. Scaled to the item's size by a transform, so the PDF's text
size is `item.size`. `REFERENCE` 100, `TEXT_MAX_LENGTH` 500 (longer text is cut), `TEXT_STYLE`.

## Pictures (`engine/edit/pictures.js`)

```js
const picture = await importPicture(fileItem);   // null when it isn't a picture this browser reads
// { id, name, image: { bytes, type, width, height }, width, height, jpeg }
```
Taken in by Images to PDF's `importImage` (`engine/images/decode.js`): upright (EXIF), without
hidden metadata, HEIC decoded too; if that module can't load, the browser decodes it itself.
`jpeg` (stored as a photo): JPEG, HEIF/HEIC, AVIF and lossy WebP without transparency; PNG, GIF,
BMP and lossless WebP stay lossless.

- `decodePicture(picture, longSide, { signal })` → `ImageBitmap` upright, at most `longSide` px on
  its longer side (`PREVIEW_SIDE` 1024 for the screen). `UserError('edit_picture_failed')`.
- `pdfLongSide(item)` → pixels on the longer side in the PDF: 300 dpi for photos (`PHOTO_DPI`),
  200 for lossless (`LOSSLESS_DPI`) at the size drawn, at most `MAX_SIDE` 2400.
- `pdfImage(doc, item, cache)` → `{ ref, width, height }` (text engine `embedImage`): a photo as JPEG
  at `JPEG_QUALITY` 0.85 on white, others lossless with a soft mask; one image per picture and size.

## Drawing (`engine/edit/draw.js`)

```js
drawItem(target, item, { text: (item) => layout|null, picture: (item) => image|null })
drawLiveStroke(target, points, color, width, highlighter)   // a stroke being drawn
tracePath(target, outline(item))
```
`target` is a `PdfCanvas` or a screen canvas's 2D context, transformed to points on the page: the
preview and the PDF draw through the same code, so they match.

---

## The screen (`tools/edit/`)

Loading: `index.js` loads only the light parts with the screen (`engine/edit/history.js`,
`engine/edit/layout.js`), so "Choose PDF" shows without pdf-lib, fontkit or the text engine. The
engine (`engine/edit.js`), the page (`stage.js`) and the controls (`controls.js`) load just after
the screen shows (`loadEditor()`, exported by index.js) and are waited for once a PDF is chosen; if
they can't be fetched, `web_tool_load_failed` names the tool. The content is the screen's
`<main data-main>`, which the skip link goes to.

`mount(ctx)` (core contract): top bar "Edit PDF"; "Choose PDF" (pick, drop or paste; a PDF handed
over in `ctx.files` opens at once, with `item.password`); then the PDF's card (Remove asks "Discard
your changes?" when something was added), the row of pages (more than one page; edited ones marked),
the five tools (Text, Draw, Highlight, Shape ▾, Picture), the hint with Undo and Redo, the page,
Previous/Next page and zoom, the filled-box note (`edit_cover_hint`), the chosen item's controls
(name, Edit text, Delete, Move left/up/down/right, Size, Thickness, Filled, colours) or the pen's
(Thickness, colours), the file name, and **Save PDF** (off until something is on a page). Saving
shows "Working on your PDF…" (Cancel), then the kit's result screen, a history step
(`ctx.pushStep('result')`): Back to editing and the browser's (or a phone's) Back return to the
items, as the app's result screen does; a reload on that step takes the step back. A PDF is opened
with the screen's AbortSignal (`openPdf(item, { password, signal })`), so a password dialog still
open closes when the user leaves; leaving while the PDF is made stops it and takes its progress
dialog away at once. A failure is said once the progress dialog has gone (a screen reader hears
nothing outside a modal dialog). While a PDF opens, Choose PDF is off with `aria-disabled` (it keeps
the focus; a cancelled password dialog gives it back there). Removing the PDF or starting over also
resets the style (sizes, colours, widths) to the defaults, as the app's options start each PDF
afresh. Wide screens (≥ 840 px): pages in a column on the left, the page in the middle, the card and
controls on the right. Numbers (the zoom, the sliders' points) are formatted in the app's language
(`formatNumber`), not the browser's.

The handle: `unmount()`, `hasUnsavedWork()` (something added, the PDF being made, or a result not
saved), `onStep(step)`, and `inspect()` (for tests: `{ page, size, mode, zoom, selected, canUndo,
canRedo, style, items }`, pictures as their size).

Touches, pen and mouse (`stage.js`): a touch on an item chooses it and dragging moves it (touch slop
8 px, mouse 3 px, so a tap doesn't move it); the chosen item's handles (within 18 px) resize it; a tap
elsewhere lets go; a swipe that starts off the items scrolls the screen (or the zoomed page); two
fingers zoom; in Draw/Highlight a finger, pen or mouse draws (points 2 px apart on the screen,
coalesced events for smoothness), and the page doesn't scroll. A press never scrolls a zoomed page:
the item follows the finger exactly, as EditPreview.kt (only an item chosen with the keyboard or a
screen reader is scrolled into view). The drawing hint is the app's `edit_hint_draw` on touch
screens and `web_edit_hint_draw` (mouse wording) where the main pointer is fine. Ctrl/⌘ + wheel zooms about the mouse;
a mouse drag off the items pans a zoomed page. Zoom 100–600 %: the part showing is drawn again sharp.

Keys (computers): Delete/Backspace removes the chosen item, arrows move it a step (Shift: 1 pt),
Ctrl+Z undoes, Ctrl+Y or Ctrl+Shift+Z redoes, Escape stops drawing or lets go, Page Up/Down change
page. Only fields text is typed in keep these keys for themselves: on a slider (which keeps the
focus after a mouse drag) Ctrl+Z, Ctrl+Y, Delete and Escape work as anywhere, while its arrows, Page
Up/Down, Home and End stay its own. A move button pressed up to an edge of the page is off with
`aria-disabled` and keeps the focus; the item's controls made again (Filled turned on or off) keep
the focus on the control it was on. Each item is a button (named as `describeKey`, `aria-pressed` when chosen) placed over it, so
Tab finds it and Enter chooses it; a new item and an item clicked with the mouse get the focus.
The page keeps what pdf.js decoded only for the page showing: another page shown, or the editor
closed, lets pdf.js free the others (`page.cleanup()`).
The row of tools is a toolbar, the colours and pages radio groups (arrow keys).

`controls.js` also exports `toolbar`, `colorSwatches({ value, onSelect })`, `properties(hooks)`,
`pageStrip({ count, thumbnail, onSelect })`, `textDialog({ initial, title })` (a promise of the text or
null, with `close()`), `describe(item)` and `SHAPES`; `stage.js` exports `createStage(hooks)`,
`ZOOM_MIN`, `ZOOM_MAX`. They're the screen's own, not meant for other tools.

## Strings (`locales/en/edit.js`)

From strings.xml: `pdf_edit_action`, `edit_text`, `edit_draw`, `edit_highlight`, `edit_shape`,
`edit_picture`, `edit_hint_start`, `edit_hint_select`, `edit_hint_selected`, `edit_hint_draw`,
`edit_preview_description`, `edit_text_add`, `edit_text_change`, `edit_item_*`, `edit_selected`,
`edit_delete`, `edit_move_left|up|down|right`, `edit_thickness`, `edit_fill`, `sign_size`,
`sign_done`, `color_black|blue|red|green|yellow|white`, `edit_cover_hint`, `edit_picture_failed`,
`edit_full`, `edit_page_edited`, `watermark_no_font`. The web's own: `web_watermark_no_font`,
`web_edit_hint_draw`, `web_edit_hint_selected_wide`, `web_fonts_unavailable`, `web_edit_opening`,
`web_edit_picture_adding`, `web_edit_pages`, `web_edit_page_of`, `web_edit_previous_page`,
`web_edit_next_page`, `web_edit_zoom_in`, `web_edit_zoom_out`, `web_edit_zoom_level`,
`web_edit_tools`, `web_edit_color`, `web_edit_points`. From `common.js`/`kit.js`: `tool_edit`, `undo`,
`redo`, `cancel`, `discard`, `keep`, `tool_discard_title`, `pick_pdf`, `file_name`,
`pdf_page_number`, `page_count`, `result_details`, `pdf_working`, `pdf_import_failed`,
`pdf_process_failed`, `pdf_import_failed`.

## Differences from the app

- Items, Undo and Redo live for the visit; the app keeps the items through Android closing it.
  Pictures are kept in memory, not as copies in a cache folder (so "files cleared" can't happen).
- The web adds zoom (buttons, pinch, Ctrl+wheel), Previous/Next page buttons, keys, mouse cursors,
  dropping or pasting a picture onto the page, and a value shown beside each slider.
- Text is drawn with the bundled Noto Sans (the app: the phone's sans-serif), so a text box is a
  little different in size from the app's; preview and PDF match each other exactly.
- The PDF's text is drawn straight into the page, scaled from 100 pt, rather than through a form
  made by Android's PDF writer; it reads back the same (and Hindi copies back in the right order).
- A highlighter always multiplies in the preview (the app needs Android 10 for that).
- Text no font can draw: the web's message says "device", not "phone".
