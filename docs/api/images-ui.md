# Scan document and Images to PDF screens (`js/tools/images/`)

The screens of **Scan document** and **Images to PDF**, ported from the app's `EditorScreen.kt`,
`CropScreen.kt`, `FilterScreen.kt`, `ConvertSheet.kt`, `PagePreview.kt`, `Options.kt`, the images
part of `MainViewModel.kt` and `data/ImageItem.kt`. One module serves both tools (`core/tools.js`
routes `scan` and `images` to `tools/images/index.js`). Strings: `locales/en/images.js`. Styles:
`images.css` (classes prefixed `images-`). Tests: `node tests/images-ui.test.mjs` (`--quick`:
Chromium only, no dark screenshots; `--only <words>`: the tests whose name has them). Besides each
screen, they cover Home's Take photo (in Chromium, Firefox and WebKit), images shared while the tool
shows, the app's discard question on the browser's Back, a HEIC photo made into a page, the result
step, and what text recognition is given (a test wraps `engine/ocr.js` to see each picture read, and
to make reading fail). Also: the chips over scrolled pages and their 48 px taps, the focus and
scroll when the first pages come, the sheet's Back and Escape, messages announced after the
progress dialog, the look reset by the router's Discard, the tool showing while pdf-lib, fontkit,
pdf.js and Tesseract are held back, and Filters' wheel and Crop page's cursors (the sheet's and the
wheel's tests in Chromium, Firefox and WebKit).

## Opening the tools

`mount(ctx)` as every tool:

| `ctx` | What happens |
| --- | --- |
| `#/tool/images`, no files | The editor, empty: Photos, Files, Take photo (and drop or paste on computers). |
| `#/tool/images` with `ctx.files` (shared, dropped on Home) | The editor, the images being added. |
| `#/tool/scan` (`params.start === 'scan'`) with `ctx.files` | A new scan (the first page starts on Enhanced): each image goes through Crop page and Filters in turn, "Page 2 of 5", Next, Done on the last. Closing part way keeps the rest uncropped. |
| `#/tool/scan` with `ctx.files` and `params.camera` (`'1'`, `'true'` or `true`) | The file is a photo just taken: Crop page with "Discard photo", Filters with **Take another** and **Done**. Home's Take photo opens it so: `navigate('/tool/scan', { files, params: { camera: '1' } })`. A photo the browser gives no name worth keeping (`image.jpg`, a number such as `1731150000000.jpg`; `isUnnamedPhoto`) is named as the app names its photos, `Scan_yyyyMMdd_HHmmss.jpg`. |
| `#/tool/scan` without files (a reload) | The empty editor. |

When a scan from Home ends with no page (nothing readable, the photo discarded), the tool goes
back (to Home), the messages saying why showing there.

The handle:

```js
{
  unmount(),            // stops imports, crops and a PDF being made; closes the sheet; frees previews
  hasUnsavedWork(),     // true while there are pages or images being added
  discardQuestion(),    // { title: discard_title, message: discard_body, confirm: discard, dismiss: keep } while
                        // there are pages or images being added, else null: the router asks it on the
                        // browser's Back too ("Discard these images?", as the app's editor)
  onStep(step),         // the browser's Back and Forward between the inner screens (below)
  receiveFiles(files),  // images shared while Images to PDF or Scan document shows are added after the
                        // pages there (the result goes, as in the app's addImages); no question
}
```

### Inner screens and history steps

The inner screens are history steps (`ctx.pushStep` / `ctx.popStep`), so the browser's Back and a
phone's Back go back as the app's Back does:

| Screen | Step | Back |
| --- | --- | --- |
| Editor | none | leaves the tool, asking the app's "Discard these images?" first while there are pages (the back arrow, and the router through `discardQuestion()`) |
| Create PDF sheet | `sheet` | closes it, the images kept (the app's Back closes its bottom sheet) |
| Crop page | `crop` | closes it: a photo just taken is discarded, a scan stops |
| Waiting for a scan's next image | `waiting` | stops the scan |
| Filters | `filters` (above `crop`) | back to Crop page, the corners kept |
| Result | `result` | back to editing |

Moving between the screens in code keeps the history as deep as the screen showing: steps are
pushed, or taken back one `popStep()` at a time (each awaited), so the history never runs two
changes at once. The sheet's step goes however the sheet closes (Escape, the scrim, a swipe,
Create PDF).

### The editor

The page size, orientation and margin chips stay under the top bar while the pages scroll (in the
app only the page grid scrolls), the import progress over their top edge; the row is 56 px tall
as the app's (each chip takes 48 px to tap), and the keyboard's focus brought to a page clears it.
When the first pages arrive the editor starts at its top, and the focus, when it was on the empty
screen's button pressed, goes to the first page. While images are being added the empty screen's
buttons are off with `aria-disabled` (not `disabled`, which would throw the focus out of the
button pressed).

On Crop page, a mouse over a corner or side it would take (within 40 px, as a press) shows the
`grab` cursor, `grabbing` while dragging. On Filters, a mouse wheel scrolls the row of looks along
(beside a wide picture it shows three or four), until its end.

## Modules

| Module | Exports |
| --- | --- |
| `index.js` | `mount(ctx)` |
| `model.js` | `ImagesModel`, `sourceOf(item)`, `shownSize(item)`, `isStyled(item)`, `scanName(date)`, `DEFAULT_NAME`, `SORT_MODES` |
| `editor.js` | `createEditor({ model, actions })`, `PAGE_SIZE_OPTIONS`, `ORIENTATION_OPTIONS`, `MARGIN_OPTIONS` |
| `page-list.js` | `pageList(options)` |
| `preview.js` | `pagePreview()`, `pagePicture(item)`, `forgetPreviews(image)`, `clearPreviews()` |
| `crop-screen.js` | `createCropScreen(options)`, `createScanWaiting(options)` |
| `filter-step.js` | `createFilterStep(options)`, `drawTurnedInto(canvas, picture, rotation)` |
| `convert.js` | `openConvertSheet(model, onCreate)`, `convert(model, choice, hooks)`, `preloadConvert()`, `summary(count, layout)`, `ocrProblemDialog(key)` |
| `wheel.js` | `wheelAlong(row)` (a vertical mouse wheel scrolls a sideways row; returns a function that stops it) |

These are the tool's own parts; nothing outside it needs them. In brief:

### `model.js`

A page (item) is `{ id, name, image, rotation, look, brightness, contrast, original }`: `image` is
what goes in the PDF (`{ bytes, type, format, width, height, name }`, upright: the image as added,
or the page cropped from it), `original` is `null` or `{ image, corners }`, the image as added and
the corners the page was cropped at (so it can be cropped again from scratch). Items are never
changed in place.

`new ImagesModel({ onChange, onMessage, onImagesComing, onForget })`: `onChange()` after changes
(batched to one call a turn), `onMessage(text)` for snackbars, `onImagesComing()` as images start
to be added (the result screen goes), `onForget(image)` when an image is no longer shown.

State: `items`, `layout` (`{ pageSize, orientation, margin }`), `merge`, `compression`, `pending`
(images being added and pages being cropped), `crop` (the crop session: `{ itemId, fromCamera,
rotation, start, found, foundPage, opened, look, adjustments, queued }`), `cropping` (ids), `openingCrop`,
`scan` (`{ waiting, coming, done }`), `cameraOpen`, `converting`, `lastChoices`, `lastLook`.

Actions (MainViewModel's): `addImages(files)`, `scanImages(files)`, `addPhoto(file)` (an unnamed
camera capture becomes `Scan_yyyyMMdd_HHmmss.jpg`), `newScan()`, `rotate(id, degrees)`,
`remove(id)`, `clearAll()`, `move(from, to)`, `moveBy(id, ±1)`, `sort('name_asc' | 'name_desc' |
'reverse')`, `setLayout(layout)`, `setMerge(b)`, `setCompression(level)`, `openCrop(id)`,
`finishCrop({ corners, look, allPages, adjustments, rotation })` → boolean (false: the corners make
no page), `closeCrop()`, `scanUnderWay()`, `initialChoices()`, `defaultFileName()`, `canConvert()`,
`setConverting(b)`, `dispose()`.

Settings kept (as the app's SettingsStore): `images.pageSize`, `images.orientation`,
`images.margin`, `images.merge` (only changed when making a PDF of several images),
`images.compression`. The look chosen last lives beside the module for the visit (reset by a new
scan from Home, by Remove all and Start over, and when the tool goes with its images, discarded
through the router's question: as the app's confirmDiscard, which clears them all), as the app
keeps it beside its editor.

### `convert.js`

```js
const sheet = openConvertSheet(model, (choice) => convert(model, choice, { say: snackbar, signal }));
// choice: { merge, fileName, compression, ocrLanguage (null: OCR off) }
// sheet: { update(), close(), open, closed (a promise, resolved once it has closed) }
const made = await convert(model, choice, { say, signal }); // → { files, name } or null
```

The PDF writer, its fonts and the OCR engine (about 1 MB) are loaded once a PDF is made, not
before the tool shows: `preloadConvert()` (called by `mount` once the tool shows) starts loading
them without waiting. `say(text)` is called only once the progress dialog has closed (a message
announced under a modal dialog is never heard, the rest of the page being inert); the result's
saving messages are the app editor's (`showResult`'s `wording: 'images'`).

`convert` makes the PDFs with `engine/images/build-pdf.js` (pages: `{ name, bytes, rotation, look,
brightness, contrast }`, `bytes` being the page's stored image: the upright JPEG or PNG
`engine/images/decode.js`'s `importImage` made of it, so a HEIC photo, decoded with libheif where
the browser can't, is never handed to `createImageBitmap` as HEIC), with the progress dialog
("Downloading text recognition…" with "45% downloaded", "Creating and compressing PDF…" with
"2 of 5 images", "Reading text…" with "1 of 5 pages", "Adding searchable text…") and Cancel.
With OCR it first starts the recognizer (as the app's `ensureReady`), then reads each page from
the page's own image as it shows (cropped and straightened, turned), in colour whatever its look,
from the image itself rather than the PDF's compressed copy, no larger than the 3000 px reading
needs; adds the text with `engine/ocr.js`'s `addTextLayer`; and names a PDF with text
`<name>_searchable.pdf` (as PdfOcr). A PDF with no text stays as it was; no text in any of them:
`ocr_no_text`. Reading that fails (an image that can't be decoded, the engine failing):
`ocr_failed`, and every PDF is kept as made, without text.

## Strings and errors

`locales/en/images.js` holds every string these screens use beyond `common.js` and `kit.js`,
keyed and worded as strings.xml, including the engines' errors shown here. Web-only strings:

| Key | English |
| --- | --- |
| `web_empty_body` | Pick your images, put them in order and convert. Everything happens on this device. Nothing is uploaded. |
| `web_empty_share_hint` | Tip: you can also drop or paste images here, or share them to Usugami once it is installed as an app. |
| `web_reorder_hint_mouse` | Drag a page to reorder, or press Ctrl and an arrow key |
| `web_crop_handle_hint` | The arrow keys move it a step at a time. |
| `web_ocr_note` | Text is recognized on this device. The first time you use a language, its recognition data is downloaded from this site. |
| `web_ocr_download_note` | This happens the first time you use each language in this browser and needs an internet connection. Your images stay on this device. |
| `web_skipped_unsupported_no_avif` (plural) | Skipped {1} file(s): only JPG, PNG, HEIC, WebP, BMP and GIF images are supported in this browser. |

The screens throw no `UserError`s of their own. Messages they show, from the engines and the app:

| Key | English | When |
| --- | --- | --- |
| `msg_skipped_unsupported` (plural) | Skipped {1} file: only JPG, PNG, HEIC, AVIF, WebP, BMP and GIF images are supported. | files that aren't images |
| `msg_failed_import` (plural) | Couldn't read {1} image. | damaged images |
| `crop_failed` | Couldn't crop the page. It was kept as it was. | a crop that couldn't be made |
| `crop_not_a_page` | The corners don't make a page: put each one on a corner of the page. | on Crop page, Next off |
| `msg_convert_failed` + `msg_image_unreadable` / `msg_out_of_memory` / `msg_unknown_error` | Couldn't create the PDF: "{1}" could not be read | making the PDF failed |
| `ocr_problem_title` + `ocr_problem_download` / `ocr_problem_failed` + `ocr_problem_retry` | Text recognition isn't available … To create the PDF now, turn off OCR and try again. | a dialog; no PDF is made, the sheet reopens with the same choices |
| `ocr_failed` | Text recognition failed, so the PDF was created without searchable text. | reading failed after the PDF was made |
| `ocr_no_text` | No text was recognized. The PDF was created without a text layer. | |
