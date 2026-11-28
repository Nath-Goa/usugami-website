# Scan document and Images to PDF screens (`js/tools/images/`)

The screens of **Scan document** and **Images to PDF**, ported from the app's `EditorScreen.kt`,
`ScanPhotosScreen.kt`, `CropScreen.kt`, `FilterScreen.kt`, `ScanLooksScreen.kt`, `ConvertSheet.kt`,
`PagePreview.kt`, `Options.kt`, the images part of `MainViewModel.kt` and `data/ImageItem.kt` (the
app's 4.0.0). One module serves both tools (`core/tools.js` routes `scan` and `images` to
`tools/images/index.js`). Strings: `locales/en/images.js`. Styles: `images.css` (classes prefixed
`images-`). Tests: `node tests/images-ui.test.mjs` (`--quick`: Chromium only, no dark screenshots;
`--only <words>`: the tests whose name has them). Besides each screen, they cover a scan through
its Photos, Crop page and Filters (from Home's Take photo in Chromium, Firefox and WebKit, from
Upload images, from Images to PDF's own Take photo), the back arrow's cases, Same filter for all
pages and a slider handed on as it is let go, the last photo removed and Back with no photo, the
scan screens on a wide desktop, at 320 px and at 400 % zoom (320 × 256), by keyboard, as a screen
reader hears them, in a contrast theme and with reduced motion (a screen that slides is checked
not to move); images
shared while the tool shows, the app's discard question on the browser's Back, a HEIC photo made
into a page, the result step, and what text recognition is given (a test wraps `engine/ocr.js` to
see each picture read, and to make reading fail). Also: the chips over scrolled pages and their
48 px taps, the focus and scroll when the first pages come, the sheet's Back and Escape, messages
announced after the progress dialog, the tool showing while pdf-lib, fontkit, pdf.js and
Tesseract are held back, and Filters' wheel and Crop page's cursors (the sheet's and the wheel's
tests in Chromium, Firefox and WebKit).

## Opening the tools

`mount(ctx)` as every tool:

| `ctx` | What happens |
| --- | --- |
| `#/tool/images`, no files | The editor, empty: Photos, Files, Take photo (and drop or paste on computers). |
| `#/tool/images` with `ctx.files` (shared, dropped on Home) | The editor, the images being added. |
| `#/tool/scan` (`params.start === 'scan'`) with `ctx.files` | Home's Upload images: a scan of those images. Each goes through Crop page in turn ("Page 2 of 5", **Next** on every one), then the scan's one **Filters** screen, then **Save**. |
| `#/tool/scan` with `ctx.files` and `params.camera` (`'1'`, `'true'` or `true`) | Home's Take photo: the file is the photo the camera gave, the first of a scan, which opens on its **Photos** screen. Home opens it so: `navigate('/tool/scan', { files, params: { camera: '1' } })`. A photo the browser gives no name worth keeping (`image.jpg`, a number such as `1731150000000.jpg`; `isUnnamedPhoto`) is named as the app names its photos, `Scan_yyyyMMdd_HHmmss.jpg`. |
| `#/tool/scan` without files (a reload) | The empty editor. |

When a scan from Home ends with no page (nothing readable, the photos discarded, the last photo
removed or discarded, cropping stopped before an image came), the tool goes back to Home straight
from the scan's screen, not by way of the empty editor; the messages saying why show there.

## A scan

As the app's 4.0.0 (README, "A new way to scan"): all the photos first, then each image cropped in
turn, then one Filters screen for all the pages, then Save. A scan's pages are in the model's
items from the moment each is added, but the editor shows them, and a PDF can be made of them,
only once Save has put them after the pages that were there.

1. **Photos** (`scan-photos.js`), after Take photo (Home's, or Images to PDF's own: its empty
   screen's and its Add images menu's). The photos taken so far, as taken (the photo itself,
   upright, neither turned nor in a look), numbered in the order taken, each with **Remove page N**
   (✕). A photo still being added is blank paper with a ring ("Adding the photo…"). The hint
   "Take a photo of each page in order, then tap Done to crop them." heads the grid. At the foot:
   **Take another** (outlined, camera glyph; **Take photo** while there is no photo) and **Done**
   (filled, check glyph), off while there is no photo or one is still being added. Back with photos
   asks "Discard these photos?" / "The photos you took for this scan will be deleted." with
   **Keep** and **Discard** (red); with none it just leaves. Removing the last photo ends the scan
   (from Home, back to Home; from Images to PDF, back to its editor).
   A browser can't open a phone's camera app: Take photo is a file input with
   `capture="environment"` (the camera on phones, a picker on computers), as before. From Images
   to PDF (and the Photos screen's own Take photo / Take another) the Photos screen shows behind
   it, and a camera closed without a photo leaves the photos as they were (a scan with none is
   over). From Home it is the other way round: Home's card opens the picker over Home, and Scan
   document opens on Photos only with the photo given (see "Differences from the app").
2. **Crop page** (`crop-screen.js`), each photo or image picked in turn, its corners alone:
   "Page 2 of 5" under the title, **Next** on every image, the last too. The bar: a back arrow (to
   the image before, with the corners it was given, once its page is made; from the first photo,
   back to the photos; from the first image picked, on to Filters with the images whole, as Stop
   cropping), then **Discard photo** (delete glyph: the photo goes, and the next shows) for photos
   or **Stop cropping** (✕: the images not cropped yet, also those still being added, stay whole
   and the scan goes on to Filters) for images picked, then Rotate left and Rotate right. Each Next
   crops the page in the background. While the next image is awaited (still being added, or its
   page looked for), the crop screen shows a ring (and "Adding images…" when it is still being
   added), with the same back arrow and Stop cropping.
3. **Filters** (`scan-looks.js`), one screen for the whole scan: "Filters" over "Page n of N"
   (with more than one page) and a back arrow (to the last image's crop screen). The page chosen,
   large, in its look; the row of the scan's pages (with more than one: radio buttons "Page N",
   the one shown marked; "Cropping page N…" with a ring while its page is made); the looks (no
   "Look" heading; the row is named "Look" for screen readers); Brightness and Contrast (each on
   one line with its name, value and reset while the slider keeps 160 px, else the name over it);
   **Same filter for all pages** (with more than one page); **Save** (filled, check glyph).
   - The first page shows at first; a page chosen in the row shows instead.
   - A look or a slider changes the page shown, or every page of the scan with the switch on. A
     slider changes what shows as it moves and reaches the pages as it is let go (a key's step at
     once). Turning the switch on gives every page the shown page's look, brightness and contrast;
     turning it off changes nothing. It starts off.
   - Every page of a scan starts on **Enhanced** with no brightness or contrast, the first time
     the scan reaches Filters; a page coming later (a photo taken after going back to the photos,
     an image picked still being added when cropping stopped) starts so too, or with Same filter
     for all pages on, as the page shown; the others keep theirs. A new scan starts on Enhanced
     again whatever was chosen before.
   - **Save** ends the scan: Images to PDF shows, the scan's pages after the pages that were there.
   - The row, the controls and Save take at most 60 % of the height, only the controls scrolling
     past that. On a wide screen a 320 px column holds the controls and Save, the row under the
     page (in a short window the page gets smaller, so that the row shows whole).
   - The row of pages is a radio group named "Pages" (`web_scan_pages`); the arrow keys, Home and
     End choose in it. In the looks, the arrow keys choose too, and a look chosen (by the keys, or
     tapped at the row's edge) comes whole into view. A reset pressed with the keyboard hands the
     focus to its slider as it turns off at 0.

**Wide or not.** Photos, Crop page and both Filters screens put their controls in a 320 px column
beside the picture when the screen is wider than tall, as the app does, and the picture keeps at
least 160 px beside the column (`isWideStep` in `crop-screen.js`); otherwise the controls are under
it. In a very short window with the controls under the picture (under 421 px tall: a window zoomed
to 400 %, 320 × 256), Crop page and Filters scroll whole instead of squeezing: the picture keeps its
140 px, the controls follow it, and the step's buttons stay in sight at its foot. Photos keeps its
buttons at the foot and scrolls the photos above them.

Upload images joins at step 2. Images shared while a scan goes on join the editor's pages, not
the scan. **Unchanged:** a page cropped again with its crop
button (Crop page, then Filters with "Look", "Apply to all pages" and **Done**), Add images, and
everything after Images to PDF. The web app has no ID card flow.

### Differences from the app

On purpose, each for a reason:

- **Home's Take photo picks the photo first.** The app's `startScan` (UsugamiApp.kt) opens the
  camera and goes to the Photos screen in the same step, so Photos is behind the camera; on the
  web, Home's card opens the picker over Home and opens Scan document on its Photos only once a
  photo is given (`navigate('/tool/scan', { files, params: { camera: '1' } })`). A browser opens its file picker only in answer to the tap itself, and the
  tool's code, strings and styles load after that tap; a camera closed without a photo also leaves
  Home as it was. Take another, and Images to PDF's own Take photo, work as the app's.
- **The column beside the picture needs room** (160 px for the picture, see "Wide or not"), and
  short windows scroll whole: a window zoomed to 400 % has no counterpart on Android.
- **The row of pages has a name**, "Pages" (`web_scan_pages`): the app's row has none, but a radio
  group on the web needs one for screen readers.
- **Its tiles are at least 48 px wide**, to tap (the app's least is 0.7 of the 64 dp height, 44.8 dp).
- **On a computer's screen** (840 × 600 px and larger) the photos on Photos are at least 150 px
  wide, as large as the editor's pages there (the app's grid: 96 dp).
- **A reset pressed with the keyboard** gives the focus to its slider as it turns off (a button
  turned off can't keep the focus on the web; the app's keeps TalkBack's).
- **A scan isn't kept across a reload** (nor are the images; the app keeps both when Android stops it).
- **Take photo is a file input** (`capture="environment"`): a browser can't open the camera app
  itself, and on a computer it picks an image.

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
| A scan's Photos | `photos` | with photos, asks "Discard these photos?" (Keep stays; Discard ends the scan); with none, the scan ends |
| Crop page of a scan's image | `crop` | the image before, with its corners; from the first photo, the photos; from the first image picked, on to Filters (Stop cropping) |
| Waiting for a scan's next image | `waiting` | as on an image |
| A scan's Filters | `looks` | the last image's Crop page |
| Crop page of a page cropped again | `crop` | closes it, the page as it was |
| Its Filters | `filters` (above `crop`) | back to Crop page, the corners kept |
| Result | `result` | back to editing |

A scan's screens are all one step above the editor, one after another: the browser's Back is the
screen's own back arrow, and while the scan goes on its step is pushed again (a Back that only
asked, or went to the image before, leaves the scan a step above the editor). Moving between the
screens in code keeps the history as deep as the screen showing: steps are pushed, or taken back
one `popStep()` at a time (each awaited), so the history never runs two changes at once. The
sheet's step goes however the sheet closes (Escape, the scrim, a swipe, Create PDF). A scan's
later stage, or later image, slides in over the one before; Back brings the one before from the
other side (none of it with reduced motion).

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
(beside a wide picture it shows three or four), until its end; on a scan's Filters, the row of
pages too.

## Modules

| Module | Exports |
| --- | --- |
| `index.js` | `mount(ctx)` |
| `model.js` | `ImagesModel`, `sourceOf(item)`, `shownSize(item)`, `isStyled(item)`, `scanName(date)`, `scanPlace(scan)`, `scanTotal(scan)`, `shownPage(scan)`, `DEFAULT_NAME`, `SORT_MODES`, `SCAN_STAGES`, `SCAN_LOOK` |
| `editor.js` | `createEditor({ model, actions })`, `PAGE_SIZE_OPTIONS`, `ORIENTATION_OPTIONS`, `MARGIN_OPTIONS` |
| `page-list.js` | `pageList(options)` |
| `preview.js` | `pagePreview()`, `pagePicture(item)`, `forgetPreviews(image)`, `clearPreviews()` |
| `scan-photos.js` | `createScanPhotos({ model, actions: { takePhoto, done, remove, discard } })` → `{ el, update(), back(), focus(), destroy() }` |
| `crop-screen.js` | `createCropScreen(options)` (actions `{ done, close, back, discard, stop }`), `createScanWaiting({ scan, onBack, onStop })`, `stepButtons(main, other)`, `stepLayout(el, hint)`, `isWideStep({ width, height })` |
| `scan-looks.js` | `createScanLooks({ model, actions: { back, save } })` → `{ el, update(), back(), focus(), destroy() }` |
| `filter-step.js` | `createFilterStep(options)`, `adjustmentSlider(options)`, `fitSliders(sliders, width)`, `looksRow(options)`, `revealIn(row, item)`, `drawTurnedInto(canvas, picture, rotation)`, `small(picture)`, `delay(ms, signal)`, `PAGE_MAX`, `LOOK_DELAY_MS` |
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
rotation, start, found, foundPage, opened, look, adjustments, staged }`; `staged`: an image of a
scan), `cropping` (ids), `openingCrop`, `scan` (the scan going on, ScanQueue: `{ stage: 'photos' |
'crop' | 'looks', camera, pages, waiting, whole, coming, selected, sameLook, styled }`),
`photosAdding` (photos taken for a scan still being added), `cameraOpen`, `converting`,
`lastChoices`.

Actions (MainViewModel's): `addImages(files)`, `scanImages(files)`, `startScan()` → boolean,
`photoTaken(file | null)`, `addPhoto(file)` (an unnamed camera capture becomes
`Scan_yyyyMMdd_HHmmss.jpg`), `cropScan()` (Done), `scanBack()`, `discardScanPhoto()`,
`stopScanCropping()`, `discardScan()`, `selectScanPage(id)`, `setScanLook(look)`,
`setScanAdjustments({ brightness, contrast })`, `setScanSameLook(on)`, `scanLooksBack()`,
`saveScan()`, `rotate(id, degrees)`, `remove(id)`, `clearAll()`, `move(from, to)`, `moveBy(id, ±1)`,
`sort('name_asc' | 'name_desc' | 'reverse')`, `setLayout(layout)`, `setMerge(b)`,
`setCompression(level)`, `openCrop(id)` (not during a scan), `finishCrop({ corners, look, allPages,
adjustments, rotation })` → boolean (false: the corners make no page; a scan's image takes its
corners and turn alone, and the scan goes on), `closeCrop()`, `scanUnderWay()`, `initialChoices()`,
`defaultFileName()`, `canConvert()` (false during a scan), `setConverting(b)`, `dispose()`.

Settings kept (as the app's SettingsStore): `images.pageSize`, `images.orientation`,
`images.margin`, `images.merge` (only changed when making a PDF of several images),
`images.compression`. Nothing of a scan is remembered beyond it: as in the app's 4.0.0, which
dropped the "look chosen last", every scan's pages start on Enhanced. A scan isn't kept across a
reload (nor are the images; the app keeps both when Android stops it).

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
keyed and worded as strings.xml, including the engines' errors shown here. A scan's Photos and
Filters screens add the app's `scan_photos_title`, `scan_photos_hint`, `scan_adding_photo`,
`scan_discard_title`, `scan_discard_body` and `scan_same_look`, and use `crop_take_another`,
`add_from_camera`, `crop_done`, `remove_page`, `pdf_page_number`, `cropping_page`, `crop_next`,
`crop_discard`, `crop_stop`, `scan_place`, `scan_pane_title`, `filter_title`, `save`, `discard`
and `keep`. Web-only strings:

| Key | English |
| --- | --- |
| `web_empty_body` | Pick your images, put them in order and convert. Everything happens on this device. Nothing is uploaded. |
| `web_empty_share_hint` | Tip: you can also drop or paste images here, or share them to Usugami once it is installed as an app. |
| `web_reorder_hint_mouse` | Drag a page to reorder, or press Ctrl and an arrow key |
| `web_crop_handle_hint` | The arrow keys move it a step at a time. |
| `web_scan_pages` | Pages (the name of the row of a scan's pages on Filters, for screen readers) |
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
