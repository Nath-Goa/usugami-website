# Text recognition (OCR): `site/app/js/engine/ocr.js`

"Make text searchable (OCR)" for Images to PDF and Scan document. This reads the words on page
images with Tesseract (LSTM models: English `eng`, French `fra`, Spanish `spa`, and Hindi
`hin+eng`, so Hindi mode keeps English words too). It then writes them into the PDF as an
invisible, searchable and selectable text layer, as the app's `PdfOcr.kt` does. Everything runs
in the browser. The engine, the language data and the text layer's font come from this site
(`app/vendor/tesseract/`, `app/fonts/UsugamiOcr-Regular.ttf`). Nothing is uploaded.

Helpers live in `engine/ocr/`: `loader.js` (downloads, worker), `picture.js` (the picture that
gets read), `lines.js` (Tesseract's results to lines and words), `text-layer.js` (the PDF text),
`scale.js` (OcrScale) and `languages.js` (the languages, below). Screens only need `engine/ocr.js`;
one that offers the languages before any OCR runs (Create PDF's sheet) can import `languages.js`
and `scale.js`, which import nothing, and load `engine/ocr.js` (with pdf-lib and fontkit) once it
is needed.

## The flow, as in the app (MainViewModel.convert → PdfOcr.apply)

```js
import { createRecognizer, addTextLayer, defaultOcrLanguage } from '../../engine/ocr.js';
import { UserError, CancelledError } from '../../core/errors.js';

const lang = getSetting('images.ocrLanguage', defaultOcrLanguage(getLanguage()));

// 1. Before any PDF work, so a problem is reported straight away (the app's ensureReady):
//    progress shows "Downloading text recognition…" / "{1}% downloaded".
const recognizer = await createRecognizer(lang, {
  signal,
  onProgress: (done, total) => dialog.update(done / total, t('ocr_download_percent', Math.round((100 * done) / total))),
});
try {
  // 2. Make the PDF (pdf-lib). 3. For each page ("Reading text…", page i of n):
  let lines = 0;
  for (const p of pages) {
    const recognition = await recognizer.recognize(p.original, { signal }); // see "What to read"
    lines += await addTextLayer(pdfDoc, p.page, recognition, p.placement);  // placement: see below
  }
  if (lines === 0) snackbar(t('ocr_no_text'));
} catch (e) {
  if (e instanceof CancelledError) throw e;         // the user cancelled: no PDF
  // A failed reading: keep the PDF as made, without text (the app's addTextLayer catch).
  snackbar(t(e instanceof UserError ? e.key : 'ocr_failed'));
} finally {
  recognizer.terminate();
}
```

**What to read:** the README's rule. Text is read from the original image (a cropped page as
cropped and turned, in colour whatever its look), not from the compressed copy in the PDF, so
small print is found even at Extreme. Pass the picture as the page shows it, upright and turned
as the user chose: a canvas or ImageBitmap of the cropped, straightened page before its look
(black and white, etc.) and before compression.

## `createRecognizer(lang, { onProgress, signal } = {})` → `Promise<Recognizer>`

- `lang`: `'en'`, `'fr'`, `'es'` or `'hi'` (anything else reads English).
- The first time in a tab, it downloads the engine and the language's data from this site and
  reports progress with `onProgress(doneBytes, totalBytes)`. `done` only grows and is never more
  than `total`. `total` is exact when the server gives sizes (this site does), and an estimate
  otherwise. The last call has `done === total`. Already loaded in this tab: no progress calls.
  About 7.0 MB for English, 4.8 MB French, 6.1 MB Spanish, 8.4 MB Hindi (with English). The
  engine (3.9 MB) is shared. The browser's cache (and the service worker, if it keeps them)
  makes later uses quick.
- It then starts one Tesseract worker, which reads every page given to this recognizer.
- `signal` cancels the download, the start and any reading: `CancelledError` (core/errors.js).
  Afterwards, `recognize()` throws `CancelledError` too.
- Throws `UserError('ocr_problem_download')` without a connection, or when nothing arrives for
  60 s (the app's STALL_TIMEOUT). Throws `UserError('ocr_problem_failed')` when a file is
  missing on the site or the engine can't start (no WebAssembly or no Worker).

```js
const recognizer = await createRecognizer('hi', { signal: controller.signal });
recognizer.language; // 'hi'
```

### `recognizer.recognize(image, { signal, onProgress } = {})` → `Promise<Recognition>`

- `image`: `ImageBitmap`, `HTMLCanvasElement`, `OffscreenCanvas`, `Blob`/`File` (decoded with its
  EXIF orientation), `ImageData` or a loaded `<img>`.
- The picture is read as the app reads it (PdfOcr.shownImage), on white, in colour. It is read
  at 3000 px on its long side (OcrScale): larger photos are shrunk, smaller images enlarged at
  most 2.5 times, and a long screenshot keeps the pixels of a 4:3 photo (at most 8192 px a side).
  Below 32 px a side it is padded on white. If the browser can't make a canvas that large, it is
  read at half the size, and so on down to 750 px.
- A page photographed upside down or sideways is read the right way up, as Usugami OCR does. If
  the page reads poorly but has letters, the three other turns are tried on a 1600 px copy. A
  turn is taken only if it reads clearly better (1.5 times, at least 60 confidence). The
  recognition's points are still on the picture as given, and `turned` says what was done.
- Lines read with less than 50 confidence are left out ("mostly not text", PaddleOCR's 0.5). In
  a kept line, a mark with no letter or digit read with less than 40 is left out too.
- Pages are read one at a time, in the order given (calls queue). `onProgress(done, 1)` reports
  the page's reading from 0 to 1.
- `signal` cancels this reading at once (the worker is ended; the next call starts a new one,
  from the cache): `CancelledError`.
- Throws `UserError('ocr_failed')` when the image can't be decoded (a damaged file) or the
  engine fails while reading. The recognizer stays usable. A job the worker fails only rejects its
  own promise: `loader.js`'s `startWorker` gives tesseract.js an `errorHandler`, without which it
  would also throw the error in the worker's message handler, where nothing can catch it.
- The work happens in a Web Worker. Preparing the picture yields to the browser, so the screen
  keeps answering. About 0.5–3 s a page on a desktop, a few times that on a phone. A page of
  pure noise takes about 10 s on a desktop.

### `recognizer.terminate()`

Ends the worker and fails any reading in progress with `CancelledError`. Call it when done, in
`finally`, and in the screen's `unmount()`.

### Recognition

Plain data (it can be cloned or kept). Points are `{ x, y }` in pixels of the picture as given
(after EXIF orientation for a Blob), with y going down.

```js
{
  width: 4032, height: 3024,      // the picture as given: the space of every point below
  turned: 0,                      // degrees clockwise the picture was turned to read it (0, 90, 180, 270)
  confidence: 91,                 // Tesseract's mean confidence, 0–100
  text: 'QUARTZ\nInvoice number 48213 is due on Friday.',   // lines joined by '\n'
  lines: [{
    text: 'Invoice number 48213 is due on Friday.',          // its words joined by spaces
    confidence: 93,
    // Top-left, top-right, bottom-right, bottom-left as the text reads (the app's OcrLine),
    // which also give its angle (upside down: top-left is at the bottom right).
    corners: [{ x, y }, { x, y }, { x, y }, { x, y }],
    baseline: [{ x, y }, { x, y }],   // where the line's letters sit, start to end
    words: [{ text: 'Invoice', confidence: 95, corners: [...4], baseline: [...2] }, ...],
  }],
}
```

Each line's baseline is fitted through the bottoms of its letters. That is robust to descenders
and to a Q's tail. Tesseract's own baseline assumes all the lines of a block are parallel, which
a photo taken at an angle breaks. Height and descent come from Tesseract's row attributes.

## `addTextLayer(pdfDoc, page, recognition, placement, imageWidth?, imageHeight?)` → `Promise<number>`

Adds `recognition`'s text to `page` (a pdf-lib `PDFPage` of `pdfDoc`) as invisible text over
where the image is drawn. Returns how many lines it wrote. Lines with nothing the font can write
are left out; 0 means the page was left exactly as it was (no font, no content added).

- `placement`: where the picture that was read sits on the page, in points from the page's
  bottom-left (pdf-lib coordinates), either:
  - `{ x, y, width, height }`: the rectangle the picture fills, upright as it was read; or
  - an object with `toPage(s, t) => [x, y]` (s across, t down, 0–1 of the picture as shown), such
    as `imagePlacement(geometry, transform)` from `engine/images/page-layout.js`, for an image the
    PDF draws turned (the app's `ImagePlacement.toPage`).
- `imageWidth`, `imageHeight`: only for hand-made `{ lines: [{ text, corners }] }` without a
  `width`/`height`. A Recognition from `recognize()` carries its own size, and that is what its
  points are in, whatever size the PDF keeps the image at.
- How the text is written (PdfOcr.writeTextLayer):
  - Rendering mode 3 (invisible; rendered pixels don't change), with `UsugamiOcr-Regular.ttf`.
    That font is glyph-less and covers Latin and Devanagari. It has every character the four
    models can output, and it is embedded once per document, subset to the glyphs used.
  - The text size is 0.9 × the line's height (at least 3 pt). Each word starts where its
    baseline starts, at the line's angle, and is stretched to its width (20–200 %).
  - Lines within 0.3° of level (or of a quarter turn) are written exactly level, each word with
    its own stretch.
  - A tilted line uses one stretch for all its words. pdf.js (Firefox's viewer) would otherwise
    split it into one line per word.
  - A space glyph after each word fills the gap to the next word, so search, copy and selection
    run across words with one space between them.
  - Lines without `words` (the app's OcrLine shape) are written as one run from the bottom-left
    corner along the top edge, as in the app.
- The font has no shaping tables, so the glyphs stay in reading order: Devanagari in logical
  order, as search and copy need it (pdf.js gives back exactly `'नमस्ते दुनिया भारत मेरा देश है'`).
- Characters go through `printable()` (below).
- The page's existing content is wrapped in `q … Q` first, so a transformation it leaves in place
  doesn't move the text (PDFBox's resetContext in the app).
- Throws `TypeError` for a bad `placement` or a missing size (programming errors), and
  `UserError('ocr_failed')` if the font can't be loaded.

```js
const { doc, page } = ...; // a page with the image drawn in rect
const n = await addTextLayer(doc, page, recognition, { x: 36, y: 50, width: 523, height: 742 });
const bytes = await savePdf(doc);
```

## Smaller exports

- `printable(text, hasGlyph)` → `string` (PdfOcr.printable). A character the font has no glyph
  for is written in its compatibility form (NFKC) if the font has that, else as a space:
  `printable('① 12 mm 𝑢', has) === '① 12 mm u'`. Characters that are never drawn (ZWJ, ZWNJ,
  the soft hyphen, direction marks, variation selectors) are left out. pdf-lib/fontkit would
  write them as spaces, which search would then find. `hasGlyph(codePoint) => boolean`.
- `ocrScale(width, height, longSide, maxEnlarge)` → `number` (OcrScale.of, with the app's tests).
  `ocrScale(4000, 3000, 3000, 2.5) === 0.75`.
- `OCR_LANGUAGES` = `['en', 'fr', 'es', 'hi']`, the app's order for "Text language".
- `OCR_LANGUAGE_NAMES` = `{ en: 'ocr_english', fr: 'ocr_french', es: 'ocr_spanish', hi: 'ocr_hindi' }`.
- `defaultOcrLanguage(appLanguage)` → the app's language if it is one of the four, else `'en'`
  (README: "Text recognition starts on the same language"). `defaultOcrLanguage('es-MX') === 'es'`.
- These three are defined in `engine/ocr/languages.js` (no imports), and `engine/ocr.js`
  re-exports them.

## UserError keys thrown (put them in the calling screen's namespace)

| key | English (strings.xml) |
|---|---|
| `ocr_problem_download` | Text recognition couldn't be downloaded. Check your internet connection and try again. |
| `ocr_problem_failed` | Text recognition couldn't start because of an unexpected error. If this keeps happening, please report it at github.com/Nath-Goa/usugami. |
| `ocr_failed` | Text recognition failed, so the PDF was created without searchable text. |

As in the app, show `ocr_problem_*` in a dialog titled `ocr_problem_title` ("Text recognition
isn't available") with `ocr_problem_retry` ("To create the PDF now, turn off OCR and try
again."). `ocr_problem_help` is about Google Play services, so it doesn't apply on the web. Show
`ocr_failed` as a message after saving the PDF without text.

Other strings the screens need, from strings.xml: `ocr_title` "Make text searchable (OCR)",
`ocr_detail` "Recognize words on these images and add searchable text to the PDF.",
`ocr_language` "Text language", `ocr_english` "English", `ocr_french` "French", `ocr_spanish`
"Spanish", `ocr_hindi` "Hindi", `ocr_no_text` "No text was recognized. The PDF was created
without a text layer.", `ocr_downloading` "Downloading text recognition…",
`ocr_download_percent` "{1}% downloaded", `ocr_download_note` "This happens the first time you
use each language and needs an internet connection.", `ocr_reading` "Reading text…",
`ocr_adding_text` "Adding searchable text…".

## Differences from the app

- The engine is Tesseract (LSTM), not ML Kit or PaddleOCR PP-OCRv5, so what it reads differs.
  Tesseract gives word boxes, so words are placed one by one (the app places whole lines).
- The app downloads models through Google Play services (standard edition) or has them built
  in (Usugami OCR). Here the first use in a browser downloads them from this site.
- Tesseract's Hindi data blocks the digit 1 (lest a danda be read as one), which would read
  "2019" as "2079" in the English and numbers Hindi mode keeps. The recognizer clears that
  setting; dandas still read as `।`. With the Hindi data, Tesseract also boxes a word's leading
  "1" a digit late, though it reads it as part of the word. Such a word's text then starts up to
  one digit's width late.
- Tesseract's Hindi data named two settings the LSTM-only engine lacks
  (`classify_misfit_junk_penalty`, `merge_fragments_in_matrix`), which a Hindi worker printed to
  the console as errors. `npm run vendor` takes them out of the vendored data, so a Hindi worker
  starts without any console message (tests/ocr.test.mjs checks it in Chromium, Firefox and
  WebKit), and tests that start Hindi OCR need no allowance. Tesseract's other notes go to
  `/dev/null`.
