# Page looks, image encoders and image PDFs (`engine/images/`)

The engine under **Scan document** and **Images to PDF**: the seven page looks with brightness and
contrast, the encoders (colour and grey JPEG, CCITT Group 4, lossless Flate), the page layout and
compression rules, and the builder that turns pictures into PDFs. Ported from the app's
`DocumentLooks.kt`, `PageLooks.kt`, `CcittG4.kt`, `Jpeg.kt`, `GrayJpeg.kt`, `RasterEncoder.kt`,
`ImagePdfBuilder.kt`, `PageLayout.kt`, `Compression.kt`, `PdfSyntax.kt` and `PdfExporter.kt`.
Tests: `node tests/images-looks.test.mjs`.

| File | What it has |
| --- | --- |
| `build-pdf.js` | `buildImagesPdf`: the PDFs, as the app's Create PDF makes them |
| `looks.js` | the looks: `LOOKS`, `applyLook`, `applyLookAsync`, the pixel work |
| `encode.js` | `encodeJpeg` (colour or grey), `encodeGrayJpeg`, `flateRaster`, `flateBits` |
| `ccitt.js` | `encodeCcittG4` |
| `jpeg.js` | JPEG headers, stripping metadata, EXIF orientation, sRGB check |
| `page-layout.js` | page sizes, margins, compression levels, layout, placement, PDF numbers |
| `page-source.js` | decoding a page's picture, drawing it smaller or turned |
| `canvas.js` | canvas helpers and the pause/run helpers for long work |
| `bit-writer.js` | `BitWriter` (bits, most significant first) |

The image turns (`transformOf`, `fromExif`, …) are `image-transform.js`'s and the file types
(`imageFileType`, `isLossyOpaqueWebp`) `image-type.js`'s (both by the detection part); this part
uses them.

## Option values and their strings

Values are the app's enum names in lower case. Labels are strings.xml keys (English shown).

| Option | Values (default first) and labels |
| --- | --- |
| Look | `original` look_original "Original", `lighten` look_lighten "Lighten", `enhanced` look_enhanced "Enhanced", `super_enhanced` look_super_enhanced "Super enhanced", `grayscale` look_grayscale "Grayscale", `black_white` look_black_white "Black & white", `ink_saver` look_ink_saver "Ink saver" (this order is `LOOKS`, the order Filters shows them; labels in `LOOK_LABELS`) |
| Brightness, Contrast | whole numbers −100 to 100, 0 = as the look is (filter_brightness "Brightness", filter_contrast "Contrast") |
| Page size | `a4` size_a4 "A4", `fit` size_fit "Fit (same as image)" / size_fit_short "Fit", `letter` size_letter "US Letter", `legal` size_legal "US Legal", `a3` size_a3 "A3", `a5` size_a5 "A5" (labels in `PAGE_SIZES[id].label`) |
| Orientation | `portrait` orientation_portrait "Portrait", `auto` orientation_auto "Auto", `landscape` orientation_landscape "Landscape" (on Fit pages: orientation_fit_note "Same as image") |
| Margin | `none` margin_none "No margin", `small` margin_small "Small" (¼ in), `big` margin_big "Big" (¾ in) |
| Compression | `recommended` compression_recommended "Recommended" (150 dpi, JPEG 75), `less` compression_less "Less" (200 dpi, 85), `extreme` compression_extreme "Extreme" (100 dpi, 55) |
| One PDF | `merge: true` (default) merge_on_summary, `false` merge_off_summary: one PDF per image, named after it |

The app's defaults: A4, Portrait, No margin, Recommended, one PDF. A new scan starts on Enhanced
(the screen's choice, not the engine's).

## `buildImagesPdf(pages, settings?, hooks?)` — build-pdf.js

```js
import { buildImagesPdf } from '../../engine/images/build-pdf.js';
const files = await buildImagesPdf(pages, settings, { onProgress, signal, onPage });
// → [{ name: 'Scan.pdf', bytes, type: 'application/pdf', pageCount, originalSize, images }]
```

**pages** — one entry per page, in order:

| Field | Meaning |
| --- | --- |
| `name` | the image's file name: one PDF per image is named after it, and an unreadable one is named in the error |
| `bytes` | the image file (`Uint8Array`): JPEG, PNG, or anything else the browser decodes (WebP, GIF, BMP, AVIF). A `StoredImage` from `decode.js` `importImage` fits as it is: `{ name: image.name, bytes: image.bytes }` |
| `source` | instead of `bytes`: pixels already decoded (`ImageBitmap`, canvas, `ImageData`, `<img>`), or a function returning them (or a Promise of them), called when the page is made so only one page is in memory at a time. An `ImageBitmap` a function returns is closed after its page; anything handed over as it is is left alone |
| `exifOrientation` | 1–8, how the pixels are stored. Leave it out: it is read from `bytes` (JPEG, PNG eXIf, WebP), and 1 for a `source` |
| `rotation` | the user's clockwise turn: 0, 90, 180, 270 |
| `look` | one of `LOOKS`, default `'original'` |
| `brightness`, `contrast` | −100 to 100, default 0 |

**settings** — `{ pageSize, orientation, margin, compression, merge, name, created }` as in the
table above; `name` is the merged PDF's name as the user typed it (made safe with `sanitizeName`;
default: the image's own name for one image, else `Usugami_yyyyMMdd_HHmmss`); `created` a `Date`
for the PDF's dates (default now). One image always makes one PDF named `name`, as the app's
Convert sheet does. With `merge: false` each PDF is named after its image (base name, made safe,
unique ignoring case: `Receipt.pdf`, `receipt (2).pdf`, a blank one `Usugami.pdf`).

**hooks**

- `onProgress(done, total)`: images done so far (`0` first, then after each page).
- `signal`: an `AbortSignal`; aborting stops with `CancelledError` (between pages and inside the
  looks).
- `onPage(pdfDoc, page, info)` (may be async): called once each page is drawn, before the PDF is
  saved, with pdf-lib's `PDFDocument` and `PDFPage`. Text recognition adds its layer here. `info`:

  ```js
  {
    index,            // the page's place in this PDF, from 0
    item,             // the page as passed in
    geometry,         // { pageWidth, pageHeight, imageX, imageY, imageWidth, imageHeight, imageTop } in points
    matrix,           // the cm matrix the image is drawn with
    toPage(s, t),     // → [x, y] in points from the page's bottom-left: the point (s across, t down,
                      //   each 0–1) of the image as shown (upright and turned as the user chose)
    width, height,    // the original image's size as shown, in pixels
    render({ maxSide = 4000, dom = false }),  // → Promise<canvas>: the original image as shown,
                      //   in colour whatever its look, on white; only while onPage runs
    placement,        // { geometry, transform, matrix, toPage }
  }
  ```

  Example (a word read at pixel box `[x0, y0, x1, y1]` of the rendered picture):

  ```js
  onPage: async (doc, page, info) => {
    const picture = await info.render({ maxSide: 3000 });
    const words = await recognise(picture);            // the OCR part's own work
    for (const w of words) {
      const [left, top] = info.toPage(w.x0 / picture.width, w.y0 / picture.height);
      const [right, bottom] = info.toPage(w.x1 / picture.width, w.y1 / picture.height);
      // … draw invisible text in that box on `page`
    }
  }
  ```

**Returns** `OutputFile[]`: `name` (`'<name>.pdf'`), `bytes`, `type: 'application/pdf'`, and
`pageCount`, `originalSize` (bytes of the images given), `images` (`[{ item, placement }]` per page,
as the app's `PdfFile.images`).

**What goes in the PDF**, as the app does it:

- Each image is sized for the space it fills on its page at the level's dpi (`scaleFor`), never
  enlarged, decoded no larger than needed (as Android's `inSampleSize`) and stepped down by halves.
- **Original look, no adjustments:** a JPEG of the shrunk picture at the level's quality, unless
  the original JPEG is smaller and a PDF can show it as stored (baseline/progressive, 8-bit, grey
  or RGB, sRGB): then the original goes in byte for byte, its metadata (EXIF, GPS, XMP, maker data,
  motion-photo video) stripped. A PNG (or GIF, BMP, lossless WebP) no larger than that JPEG and not
  shrunk is kept losslessly: Flate with PNG predictors, grey when every pixel is grey.
- **Black & white, Ink saver:** 1 bit a pixel, CCITT Group 4 (`/K -1`), or Flate when that is
  smaller (as for speckled pictures): about 10 KB for an A4 page of print at Recommended.
- **Grayscale:** a one-component (DeviceGray) JPEG. **Colour looks:** a colour JPEG.
- Transparency is flattened onto white. Pages turned by EXIF and the user's rotation.
- Page box with four decimals (A4 is `[0 0 595.2756 841.8898]`); the image drawn with
  `q a b c d e f cm /Im0 Do Q`.
- Document info: Title = the PDF's name, Producer and Creator = `Usugami`, CreationDate and
  ModDate; nothing else (no XMP).

**Errors**

| Thrown | When | English (strings.xml) |
| --- | --- | --- |
| `UserError('msg_image_unreadable', name)` | an image can't be decoded (damaged, unsupported such as HEIC in Chrome, empty) | `"{1}" could not be read` |
| `UserError('msg_out_of_memory')` | the browser runs out of canvas memory even at 1/32 of the size | `not enough memory for an image this large` |
| `CancelledError` | `signal` aborted | (screens ignore it) |
| `RangeError` | a programming error: no pages, an unknown look, size, margin… | — |

As in the app, the screen shows the first two inside `msg_convert_failed`
("Couldn't create the PDF: {1}"): `t('msg_convert_failed', t(e.key, ...e.args))`, and anything
else as `t('msg_convert_failed', t('msg_unknown_error'))` ("an unexpected error occurred").

## Looks — looks.js

```js
import { applyLook, applyLookAsync, LOOKS, LOOK_LABELS, isBilevel, isColour } from '../../engine/images/looks.js';
const preview = applyLook(canvasOrBitmap, 'enhanced', { brightness: 10, contrast: -20 });
```

- `applyLook(source, look, { brightness, contrast }?, { output }?)` → the picture as the look
  shows it, a new opaque picture of the same size; `source` (ImageData, canvas, ImageBitmap, `<img>`)
  is left as it is. Returns ImageData for ImageData, otherwise a canvas (HTMLCanvasElement in a page,
  OffscreenCanvas in a worker); `output: 'imagedata' | 'canvas' | 'dom'` chooses. Synchronous: for
  previews keep it about 1000 px (a 12 MP photo takes 0.1–0.8 s per look in Chrome).
- `applyLookAsync(source, look, adjustments?, { output, signal }?)` → Promise of the same, pausing
  for the browser every ~24 ms; `CancelledError` when `signal` aborts.
- `LOOKS`, `LOOK_LABELS`, `isBilevel(look)` (black_white, ink_saver), `isColour(look)` (original,
  lighten, enhanced, super_enhanced), `MAX_ADJUSTMENT` (100).
- `lookAdjustments({ brightness, contrast })` → checked and rounded; `RangeError` outside ±100.
- `tones(adjustments)` → `Int32Array(256)`: the brightness/contrast curve of the colour and grey looks.
- Lower level, as generators that yield every 64 rows (run them with `runSync` / `runAsync` from
  canvas.js):
  - `lookGen(imageData, look, adjustments, { inPlace })` → `{ kind: 'colour', imageData }`,
    `{ kind: 'gray', gray: { width, height, pixels } }` or `{ kind: 'bilevel', bits }`;
    `lookToImageData(result)` shows any of them as RGBA.
  - `colourGen(imageData, look, adjustments, out = imageData.data)` writes RGBA into `out` (may be
    the source itself); `grayscaleGen(imageData, adjustments)`; `blackAndWhiteGen(imageData, look,
    adjustments)` → BitImage; `thresholdGen(gray, adjustments)`.
- BitImage: `{ width, height, rowBytes, data }`, rows of `rowBytes` bytes, leftmost pixel in the
  high bit, **1 = white**, 0 = black (DeviceGray's order); `bitImage(w, h)` makes a white one,
  `isBlack(bits, x, y)`.
- `PaperEstimator`, `PaperMap`, `blockSize`, `windowRadius` and the constants (`WHITE`, `INK`,
  `SAUVOLA_K`, …) are the app's, exported for tests.

## Encoders — encode.js, ccitt.js

- `encodeJpeg(source, { quality = 75, gray = false, signal }?)` → `Promise<Uint8Array>`. `source`:
  ImageData, canvas, ImageBitmap, `<img>`, or a grey picture `{ width, height, pixels }`. Quality
  1–100 as Android's. Transparency onto white, no metadata (stripped). `gray: true` makes a
  one-component baseline JPEG (DeviceGray), brightness `(77R + 150G + 29B) >> 8`, with Huffman
  tables made for the picture; it pauses for the browser on large pictures.
  ```js
  const jpeg = await encodeJpeg(imageData, { quality: 75, gray: true });
  // in a PDF: /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode
  ```
- `encodeGrayJpeg({ width, height, pixels }, quality)` → `Uint8Array`, synchronous;
  `grayJpegGen(...)` the same as a generator. `quantization(quality)`, `optimalHuffmanTable(counts)`,
  `huffmanTable(counts, symbols)` for tests.
- `encodeCcittG4(bits, width, height, { blackIs1 = true }?)` → `Uint8Array`. `bits`: rows of
  `ceil(width / 8)` bytes, most significant bit first, **1 = black** (pass `blackIs1: false` for
  1 = white). Use with `/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns w /Rows h >>`,
  `/ColorSpace /DeviceGray /BitsPerComponent 1` (BlackIs1 false: black decodes to 0), or as an
  `/ImageMask`.
  ```js
  const g4 = encodeCcittG4(bits, w, h);
  ```
  `encodeBitImage(bitImage)` encodes a look's BitImage (1 = white). `changes()` and the code
  tables are exported for tests.
- `flateRaster(imageData, gray)` → zlib data of RGBA flattened onto white, 1 or 3 components,
  through PNG filters: `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors (1|3)
  /BitsPerComponent 8 /Columns w >>`. `isGray(imageData)` says whether every pixel is grey.
- `flateBits(bitImage)` → zlib data of 1-bit rows: `/DecodeParms << /Predictor 15 /Colors 1
  /BitsPerComponent 1 /Columns w >>`. `filterRow` (libpng's heuristic) for tests.
- `grayOf(imageData)` → `{ width, height, pixels }`, brightness on white.

## JPEG and image facts — jpeg.js

- `parseJpeg(bytes)` → `{ width, height, components, precision, frameMarker, componentIds,
  hasAdobeMarker, hasJfifMarker, canEmbedDirectly, isPlainRgb }`; throws `InvalidJpegError`.
  `canEmbedDirectly`: DCTDecode shows it as stored (SOF0/1/2, 8-bit, 1 or 3 components);
  `isPlainRgb`: needs `/DecodeParms << /ColorTransform 0 >>`. `jpegInfo(facts)` recomputes the two.
- `stripJpeg(bytes)` → the primary image only, ending at its EOI, keeping only what decoders need
  (tables, frame, scans, JFIF without thumbnail, ICC profile, Adobe marker); a truncated file is
  closed. `jpegStrippedSize(bytes)` its size without copying. `isJpeg(bytes)`.
- `exifOrientation(bytes)` → 1–8 from a JPEG, PNG (eXIf) or WebP (EXIF), 1 if none.
  `withExifOrientation(jpeg, n)` adds an EXIF segment saying `n` (for tests and probes).
- `storedSize(bytes)` → `{ width, height }` of a JPEG or PNG, or null.
- `jpegIsSrgb(bytes)`, `iccIsSrgb(profile)`: false for a profile naming something else (Display P3).
- Re-exports `imageFileType`, `isLossyOpaqueWebp` from image-type.js.

## Layout — page-layout.js

- `PAGE_SIZES` (`{ shortSide, longSide, label }` in points), `ORIENTATIONS`, `MARGINS` (points),
  `COMPRESSION` (`{ dpi, jpegQuality }`), `DEFAULT_LAYOUT`, `MAX_PAGE_SIDE` (14400), `MIN_PAGE_SIDE` (3).
- `layoutSettings(settings)` → checked `{ pageSize, orientation, margin }` with defaults.
- `computeLayout(shownWidth, shownHeight, settings)` → `{ pageWidth, pageHeight, imageX, imageY,
  imageWidth, imageHeight, imageTop }` in points (y from the bottom). Fit: a pixel per point, the
  margin in proportion to A4, within the viewer limits; paper: fitted inside the margins, centred.
  ```js
  computeLayout(4000, 3000, { pageSize: 'a4' }) // { pageWidth: 595.2756…, imageHeight: 446.45…, … }
  ```
- `scaleFor(shownWidth, shownHeight, settings, compression)` → factor ≤ 1 (Fit pages judged as if
  on A4, each side keeping A4's pixels); `scaledSize(w, h, scale)` → `[w, h]`, at least 1 each;
  `savedPercent(original, now)` → whole percent or null under 1% (for "62% smaller").
- `imageTransform(exif = 1, rotation = 0)`, `imagePlacement(geometry, transform)` → `{ geometry,
  transform, matrix, toPage(s, t) }`; re-exports `IDENTITY`, `swapsAxes`, `fromExif`, `pdfMatrix`.
- `pdfNumber(v)` → `'595.2756'` (dot, no exponent, ≤ 4 decimals); `pdfRound(v)` the number itself.

## Pictures and long work — page-source.js, canvas.js

- `openPageSource(item, { sizeHint })` → PageSource (see the JSDoc): decodes `bytes` (or takes
  `source`), knows how its pixels are turned whether or not the browser applied EXIF, `draw(w, h)`
  → canvas, `close()`. `bitmapsFollowExif()` → whether `createImageBitmap` turns by EXIF (all
  current browsers do). `resized(src, w0, h0, w, h)`, `renderShown(src, w, h, transform, { maxSide })`,
  `release(canvasOrBitmap)`.
- `newCanvas(w, h, { dom })`, `context2d(canvas, { willRead })` (throws
  `UserError('msg_out_of_memory')` when the browser gives no context), `toImageData(source)`,
  `newImageData`, `imageDataToCanvas`, `canvasToBlob`, `sourceSize`, `isImageData`.
- `pause()` (scheduler.yield, else a timer), `runSync(generator)`, `runAsync(generator, { signal, slice = 24 })`.

## Speed (Chrome, desktop)

A 12 MP photo: each look 0.1–0.8 s; two 12 MP pages made into a PDF in about 0.7–1 s with a frame
painted at least every ~150 ms (Firefox ~100 ms; Playwright's WebKit on Windows ~350 ms once per page).
Sizes of an A4 page from a 300 dpi photo, KB: Recommended — Original 108, Enhanced 115, Grayscale
109, Black & white 10; Less 323 / 220 / 210 / 13; Extreme 43 / 52 / 49 / 8.
