# Compress PDF engine (`site/app/js/engine/compress.js`)

A port of the app's `PdfToolsEngine.compress` / `compressTo` / `compressResources`, `PdfCompression`,
`Compressor.savedPercent` (`Compression.kt`) and the compress parts of `PdfToolsViewModel.kt` and
`ResultScreen.kt`. No UI and no strings file: the Compress PDF screen puts the keys listed below in
`locales/en/compress.js` (those not already in `common.js` or `kit.js`). Tests:
`node tests/compress.test.mjs` (Chromium, then Firefox and WebKit).

What it does to a PDF:

- **Only images change.** Text stays text (selectable, searchable), drawings stay drawings, pages,
  links, forms, bookmarks and everything else stay as they are.
- **Each image is sized for the space it fills.** The pages' content streams are followed with their
  transforms (`cm`), into form XObjects (with their `/Matrix`, nested ones too) and annotations'
  appearances, so an image drawn small is shrunk more, and one drawn several times (on many pages,
  or at two sizes) is sized for the largest. Never enlarged, and never more than the app keeps: the
  largest page's long side at the level's dpi, at most 4000 pixels (`maxDimensionFor`). An image
  whose drawing can't be followed (damaged content, an unknown filter) gets that limit alone, as in
  the app.
- **Stored again as JPEG** at the level's quality, in **the same colour space with the same
  `/Decode`**; grey (one-component) images as one-component JPEGs, and a DeviceRGB image whose pixels
  are all grey as a one-component DeviceGray JPEG. A soft mask (`/SMask`) or stencil mask (`/Mask`
  stream) is **kept as it is** (its own size), so transparency is unchanged. Layer membership
  (`/OC`), `/StructParent`, `/Interpolate`, `/Intent`, `/ID`, `/Name`, `/Measure`, `/PtData` stay;
  `/Metadata`, `/Alternates`, `/OPI` and private keys go (the app makes a new dictionary too).
- The new image replaces the old one **only if it is smaller**; an image used several times is
  encoded once and the copy used everywhere it was (the app's `done` map). The old one is dropped
  when nothing uses it any more.
- **A damaged page tree is mended first**, as the app mends it when a PDF is picked: the pages
  compressed are the pages viewers show (`engine/flatten/pages.js`' `viewerPages`, see
  flatten.md), and the PDF made has a sound tree.
- **Never bigger:** a PDF that doesn't get at least 1% smaller is handed back byte for byte
  (`keptOriginal: true`). A PDF opened with a password is always saved again, **without the
  password**, even if no smaller (as every tool's PDFs are). A PDF locked only against changes
  (an owner password, none to open it) opens without asking but is never kept as it was either:
  it is saved anew without the restriction, as every tool's PDFs are (the app's `asItIs`; its
  PageMarkDeviceTest `aRestrictedPdfIsNeitherMarkedNorKeptAsItIs`). Nor is one that carried
  Usugami's own watermark (taken off as it is read), nor one whose page tree had to be mended.

## Levels

| Value | dpi | JPEG quality | Label key (English) | Summary key (English) |
|---|---|---|---|---|
| `less` | 200 | 85 | `compression_less` "Less" | `compression_less_summary` "Best quality, smaller file (200 dpi)" |
| `recommended` (default) | 150 | 68 | `compression_recommended` "Recommended" | `compression_recommended_summary` "Good quality, much smaller file (150 dpi)" |
| `extreme` | 100 | 48 | `compression_extreme` "Extreme" | `compression_extreme_summary` "Smallest file, lower quality (100 dpi)" |

The qualities are the app's `PdfCompression` (0.85, 0.68, 0.48 given to Android's JPEG encoder), not
Images to PDF's 85/75/55. `LEVELS[value]` is `{ dpi, quality, label, summary }`; `LEVEL_ORDER` is
`['less', 'recommended', 'extreme']` (the order of the app's segmented buttons); `DEFAULT_LEVEL` is
`'recommended'` (also the app's level for every PDF of a batch until one is changed).

## `compressPdf(input, options?, hooks?)`

```js
import { compressPdf, defaultCompressName } from '../../engine/compress.js';

const out = await compressPdf(
  { name: 'Report.pdf', bytes, password },               // a FileItem's bytes; the password if it had one
  { level: 'recommended', name: 'Report_compressed' },   // name as typed, without .pdf
  { onProgress: (done, total) => dialog.update(done / total), signal },
);
// out = { name: 'Report_compressed.pdf', bytes: Uint8Array, type: 'application/pdf', pageCount: 12,
//         keptOriginal: false, originalSize: 2480311, imagesReduced: 9 }
```

- `input`: `{ name, bytes, password? }` (a PdfSource's `name`, `bytes` and `password` fit). An empty
  password counts as none. `input.outputName` is another way to give the name.
- `options.level`: one of `LEVEL_ORDER` (default `'recommended'`); anything else is a `RangeError`.
- `options.name` (or `options.fileName`): the new PDF's name as the user typed it; made safe with
  `sanitizeName(name, 'Compressed')` (the app's fallback) and given `.pdf`. Default:
  `defaultCompressName(input)`. For several PDFs the screen makes the names unique first:
  `uniqueNames(names, 'Compressed')` (core/names.js), as the app's `compressEach` does; a ZIP of
  them is named `Compressed_PDFs`.
- `hooks.onProgress(done, total)`: `total` = pages + images + 1 (saving). It starts at `(0, total)`,
  counts each page as its drawing is followed and each image as it is done, and ends at
  `(total, total)`. Use it as a fraction.
- `hooks.signal`: an `AbortSignal`; aborting throws `CancelledError` (checked between pages and
  images, and inside long work: inflating, reading rows, the grey JPEG encoder). The page gets a
  chance to paint every ~25 ms of work (a 12 MP Flate image: worst frame ~150 ms in Chromium,
  mostly pdf-lib's own parsing and saving). A JPEG is decoded and shrunk by the browser away from
  the page where it can (`createImageBitmap` with its resize), then read back, checked for grey and
  stored again in slices, a pause between the steps: a 50-page scan (1654 × 2339 JPEG pages) at 4x
  CPU throttling went from a ~300 ms task on every page to a few over 200 ms in all.
- Returns an OutputFile plus:
  - `keptOriginal`: the PDF couldn't be made at least 1% smaller, so `bytes` is a copy of the input,
    byte for byte (never for a PDF that had a password, was restricted by an owner password,
    carried Usugami's watermark or had its page tree mended: those are saved anew).
  - `originalSize`: the input's size in bytes.
  - `pageCount`, `imagesReduced` (how many images were replaced, for tests and curiosity).

### Errors

| Thrown | When | English (strings.xml) |
|---|---|---|
| `PasswordError` (`wrong` false / true) | the PDF needs a password and none / a wrong one was given (from `loadPdf`) | (the screen asks: `passwordDialog`) |
| `UserError('pdf_import_failed')` | not readable as a PDF, or no pages can be found in it | "Couldn't open that PDF. It may be damaged or unsupported." (`common.js`) |
| `UserError('pdf_process_failed')` | anything else going wrong while compressing or saving | "Couldn't process this PDF. Check the file and free storage." (`common.js`) |
| `CancelledError` | `signal` aborted | (screens ignore it) |
| `RangeError` | an unknown level (a programming error) | — |

An image that can't be read, decoded or made smaller is never an error: it stays as it was (as the
app catches `IOException`, `IllegalArgumentException` and `OutOfMemoryError` per image).

## What to show afterwards

### `compressDetail(file)` — the line under each result

The app's ResultScreen line under a compressed PDF:

```js
import { compressDetail } from '../../engine/compress.js';
const d = compressDetail(out);
const text = d?.key === 'compressed_from' ? t('compressed_from', formatSize(d.originalSize), d.percent)
  : d ? t(d.key) : '';
```

Returns `{ key: 'compressed_from', originalSize, percent }` when it got at least 1% smaller
("Compressed from {1} ({2}% smaller)", `kit.js`), `{ key: 'original_kept' }` when the original was
kept ("Already compact: the original was kept", `kit.js`), else `null` (a PDF that had a password,
or that couldn't be kept as it was for another reason above, and came out no smaller: nothing
under it, as in the app).

### `compressNotes(outcomes)` — the messages (snackbar) after compressing

Pure: give it every PDF's outcome in order, `{ name, result }` or `{ name, error }`. Each message is
`{ key, args }` for `t(key, ...args)` or `{ key, count, args }` for `tp(key, count, ...args)`.

```js
for (const m of compressNotes(outcomes)) snackbar(m.count !== undefined ? tp(m.key, m.count, ...m.args) : t(m.key, ...m.args));
```

- One PDF: an error's own key (a `UserError`'s, else `pdf_process_failed`; none for
  `CancelledError`); after success, if it isn't at least 1% smaller: `pdf_no_reduction` when the
  original was kept ("This PDF is already compact; the original size was kept."), else
  `pdf_not_smaller` ("This PDF couldn't be made any smaller.").
- Several (the app's `runCompressAll` and `reportFailures`): first `batch_failed` naming those that
  failed (plural: one "Couldn't process {2}. Check the file and free storage.", other "Couldn't
  process {1} files: {2}. Check the files and free storage."), then `batch_not_smaller` naming those
  with a password that came out no smaller (one "{2} couldn't be made any smaller.", other "{1} PDFs
  couldn't be made any smaller: {2}."). Kept ones say so under their own names (`compressDetail`).
  `{2}` is `namesArg(names)` (core/names.js): the names, or with more than four the message
  `names_and_more` ("a.pdf, b.pdf, c.pdf and 2 more") as an argument the screen puts in words.

## The Usugami watermark (docs/api/mark.md)

Where the app decides it (`PdfToolsEngine.compressTo`, `ResultMarker.bringTo`, `runCompress` /
`runCompressAll`'s `afterResult`), and how the web app follows it:

- **A PDF that has Usugami's watermark is compressed without it**: `loadPdf` takes it off as every
  tool's PDF is read, and such a PDF can't be kept as it was. In the app `compressTo` keeps the
  original only when the PDF had no password, wasn't encrypted (an owner password alone counts) and
  had no watermark taken off; the engine checks the same (`wasEncrypted(doc)` and `wasUnmarked(doc)`
  from `engine/pdf-common.js`), so a PDF kept as it was never has the watermark.
- **With the watermark on**, the result screen puts it on the PDF made, kept as it was or not: the
  PDF is then no longer the original (`keptOriginal: false`) and a little bigger. The messages
  (`compressNotes`) and the line under each PDF (`compressDetail`, or the result screen's own) are
  worked out from the PDF as it shows, so one that came out no smaller says "This PDF couldn't be
  made any smaller." (`pdf_not_smaller`; several: `batch_not_smaller`, as for a PDF with a
  password) rather than that the original was kept. The Compress PDF screen does this through
  `showResult`'s `onReady` (batch-ui.md).
- **Turned off again** on the result screen, the PDF is the one the engine made, byte for byte: a
  kept original is the original again (`keptOriginal: true`, "Already compact: the original was
  kept").

## Small helpers

| Export | What |
|---|---|
| `defaultCompressName(input)` | `'Report_compressed'` for `{ name: 'Report.pdf' }`, `'Usugami_compressed'` without a name (the app's `defaultName(COMPRESS)`: `FileNames.withSuffix(base, "_compressed", "Usugami")`) |
| `savedPercent(original, now)` | whole percent saved, or `null` under 1% (`Compressor.savedPercent`); `savedPercent(1000, 380)` → 62 |
| `targetSize(width, height, extent, dpi, maxDimension)` | the `[w, h]` an image is stored at: `extent` is the most points one of its pixels covers on a page (0 = unknown) |
| `maxDimensionFor(maxPageSide, dpi)` | the app's limit: `floor(side × dpi / 72)`, 1 to 4000 (`maxDimensionFor(841.89, 150)` → 1753) |
| `LEVELS`, `LEVEL_ORDER`, `DEFAULT_LEVEL`, `MAX_IMAGE_SIDE` (4000) | see Levels |

## Strings the Compress PDF screen uses (from strings.xml)

`tool_compress` "Compress PDF" (common), `pdf_compress_action` "Compress PDF",
`pdf_compress_action_many` (one "Compress {1} PDF", other "Compress {1} PDFs"), `compression_title`
"Compression", the level labels above, `pdf_compress_note` "Text and drawings stay sharp. Images are
reduced where it saves space.", `compression_for_all` "Compression for all PDFs",
`compression_for_all_hint` "Change one below to give it a level of its own.", and for the result
`compressed_from`, `original_kept`, `pdf_no_reduction`, `pdf_not_smaller`, `batch_not_smaller`,
`batch_failed` (texts above).

## Which images are made smaller

| Image | What happens |
|---|---|
| JPEG (`DCTDecode`, after any other filters), grey or 3 components, 8-bit baseline / extended / progressive | decoded by the browser (EXIF orientation and ICC profile taken out first, as viewers ignore them; its colour transform must be the one viewers apply, `/ColorTransform` included), shrunk, encoded again |
| `FlateDecode` (PNG and TIFF predictors), `LZWDecode` (EarlyChange), `RunLengthDecode`, `ASCIIHexDecode`, `ASCII85Decode`, chained | read row by row, shrunk by averaging while reading (a big image is never held whole), encoded as JPEG |
| 2, 4, 8 or 16 bits a component | scaled to 8 bits; `/Decode` kept (it means the same on 8 bits) |
| DeviceGray, CalGray, ICCBased (1), Separation | one-component JPEG, colour space kept |
| DeviceRGB, CalRGB, Lab, ICCBased (3), DeviceN of 3 | colour JPEG, colour space kept (DeviceRGB that is all grey: DeviceGray) |
| Indexed (2, 4, 8 bits; string or stream table; `/Decode` on the index) | its colours looked up, stored in its base colour space |
| DeviceCMYK, ICCBased (4), DeviceN of 2 or 4+ (and Indexed on them) | when shrunk: stored losslessly (Flate, PNG predictors) in the same colour space; otherwise left |
| with a soft mask (`/SMask`) or stencil mask (`/Mask` stream) | the colour part as above; the mask kept as it is |

Left exactly as they are: images under 2048 bytes as stored (the app's rule), 1-bit images (scans of
text and line art: a JPEG would blur them), stencil masks (`/ImageMask`), colour-key masking
(`/Mask` array), soft masks with a `/Matte`, CMYK and other 4-component JPEGs, 12-bit, arithmetic or
lossless JPEGs, JPEG 2000 (`JPXDecode`), `JBIG2Decode`, `CCITTFaxDecode`, external data (`/F`), images
over 100 million pixels, images whose data is damaged or shorter than they say, inline images
(`BI … ID … EI`), and images only used by annotations, patterns or Type 3 fonts (the app looks only at
pages' resources and their form XObjects too).

## Lower-level modules (`engine/compress/`)

- `filters.js`: `filtersOf(ctx, dict)` → `[{ name, params }]` (short names expanded);
  `decodeTo(ctx, data, filters, sink, { maxBytes, signal })` (pieces to `sink.push(chunk)`, which
  returns true when it has enough) and `decodeAll(...)` → `{ bytes, complete }`; `inflateTo`,
  `lzwDecode`, `runLengthDecode`, `asciiHexDecode`, `ascii85Decode`, `predictorSink`, `unfilterPng`,
  `undoTiff`; `StreamError` when data grows past `maxBytes` or parameters are impossible.
- `content.js`: `scanContent(bytes)` (a generator; run with `runSync`/`runAsync`) → a flat list of
  `OP_SAVE`, `OP_RESTORE`, `OP_TRANSFORM a b c d e f`, `OP_DRAW name`, reading past strings,
  comments, arrays, dictionaries and inline images.
- `placements.js`: `findImages(ctx, pages)` → `Map<PDFRef, { ref, stream, width, height, uses,
  extent, unknown }>`; `measureImages(ctx, pages, images, { signal, onPage })`.
- `image.js`: `colourSpaceOf`, `examine(ctx, stream)` → `{ ok, reason | facts }`,
  `readImage(ctx, facts, w, h, { signal, rgba })` (with `rgba`, a three-component JPEG comes back
  as `{ pixels: null, rgba: ImageData, components: 3 }`), `encodeImage(pixels, w, h, components,
  options)` (`pixels` may be that RGBA ImageData for three components), `imageStream`,
  `flateComponents`, `isGreyRgb(pixels, tolerance = 3, stride = 3)` (stride 4 reads RGBA),
  `MIN_IMAGE_BYTES`, `MAX_IMAGE_PIXELS`.
- `samples.js`: `readSamples(ctx, data, filters, image, { signal })` → `{ pixels, complete }`.
- `jpeg-source.js`: `jpegFacts`, `transformsAgree`, `canDecode`, `jpegForDecoding`,
  `decodeJpegImage(bytes, { width, height }, outWidth, outHeight)` → opaque RGBA `ImageData` or
  null, `decodeJpeg(bytes, { width, height, components }, outWidth, outHeight, { signal })` → its
  components as a `Uint8Array` or null, `shrink(source, w, h)` (for a browser that ignores
  `createImageBitmap`'s resize: Safari).
- `budget.js`: `WorkBudget(signal)` with `check()` (a pause once ~24 ms of work have gone by) and
  `each(count, step(from, to), slice)` (pixel loops in slices; `step` returning false stops it).
- `../flatten/pages.js`: `viewerPages(doc)` and `wasMended(doc)` (flatten.md).

## Differences from the app

- **Sizes follow where each image is drawn** (the app uses one limit for every image: the largest
  page side at the level's dpi). The web version never keeps more pixels than the app's limit, and
  shrinks images drawn smaller than their page further, so results are smaller than the app's for
  PDFs with small or reused pictures.
- **More images are reduced.** The app leaves images with any mask, a `/Decode`, Indexed, CMYK,
  Lab, Separation/DeviceN colours or other than 8 bits as they are, because its decoders would get
  their colours wrong. Here they are read as a viewer reads them and stored in the same colour space,
  so they are reduced too (a PDF the app finds "already compact" because of a transparent picture
  can get smaller here). Grey images stay grey (one component) instead of Android's encoder's choice.
- **Shrinking** averages the source pixels (area averaging) where the app subsamples and then
  scales bilinearly (a JPEG is shrunk by the browser's own createImageBitmap resize, smooth: in
  Chrome the same pixels as the canvas's high-quality drawing; Safari, which ignores the resize,
  shrinks it on a canvas by halves); JPEGs are encoded by the browser (libjpeg-turbo in Chrome and Firefox, ImageIO in
  Safari), so sizes differ slightly from Android's at the same quality.
- **Saving** is pdf-lib's (object streams, cross-reference stream) rather than PDFBox's, so a PDF
  re-saved with nothing to compress can come out a little smaller or larger than the app's copy;
  either way one not at least 1% smaller is handed back as it was.
