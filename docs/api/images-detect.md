# Images: import, page detection and cropping (`engine/images/`)

The engine under **Scan document** and **Images to PDF**: taking in the images the user adds,
finding the page on a photo, and straightening the page inside four corners. Ported from the
app's `ImageStore.kt` (import), `ImageOrientation.kt`, `ImageFileType.kt`, `Webp.kt`,
`PageOutline.kt` (with `MinAreaRect.convexHull` from `TextDetection.kt`), `PageCrop.kt`,
`ImageTransform.kt`, `Areas.kt` and `PageCropper.kt`. The page search gives the same corners as
the app's to within 3·10⁻⁸ on every photo of the app's `PageOutlineTest` (checked against the
compiled Kotlin).

Modules (all in `site/app/js/engine/images/`):

| Module | What it does |
| --- | --- |
| `decode.js` | `importImage`, `importImages`, `loadImage`, names, AVIF support |
| `crop.js` | `findPageOnImage`, `startingCorners`, `cropImage`, `straighten`, and re-exports all of `crop-quad.js` |
| `crop-quad.js` | corners (CropQuad) and page sizes (PageCrop): pure |
| `outline.js` | the page search on raw pixels (PageDetection): pure, also used by `outline-worker.js` |
| `image-transform.js` | the eight turns and flips (ImageTransform), PDF and canvas matrices: pure |
| `image-type.js` | what kind of image a file is, by its first bytes; WebP lossy or not: pure |
| `image-meta.js` | size, EXIF orientation and date, HEIF turns, metadata stripping: pure |
| `areas.js` | rectangles and `cm` matrices on PDF pages (Areas): pure |
| `crop-warp.js` | the perspective warp (WebGL 2, else typed arrays) |
| `heif-decode.js`, `heif-worker.js` | HEIC through libheif (vendor), in a worker |
| `outline-worker.js` | the page search in a worker |
| `image-canvas.js` | canvas helpers (make, encode, read pixels, release) |

Everything runs on the device; nothing is fetched from another host (libheif's WebAssembly is
inside its bundle, which is imported only when a HEIC photo is added and the browser can't decode
it).

## Data

**StoredImage**: what an added image becomes (the app's stored copy plus `ImageItem` fields):

```js
{
  name: 'Photo_20240501_134512.jpg', // the file's name, or Photo_ + when taken (see photoName)
  bytes: Uint8Array,                 // a JPEG or PNG, upright, without hidden metadata
  type: 'image/jpeg' | 'image/png',
  format: 'jpeg' | 'png',
  width: 4032, height: 3024,         // pixels, as it shows (upright)
  sourceType: 'jpeg' | 'png' | 'webp' | 'bmp' | 'gif' | 'heif' | 'avif',
  taken: Date | null,                // EXIF DateTimeOriginal, local time
}
```

It is always upright: EXIF orientation (and a HEIF/AVIF file's own turn) is applied when it is
added, so there is no `exifOrientation` to carry; the user's extra quarter turns (`rotation` in
the app's `ImageItem`) are the screen's to keep, and `image-transform.js` places them in the PDF.
A screen keeps the StoredImage a page was cropped from as the page's "original" (the app's
`OriginalImage`) with the corners it was cropped at, so it can be cropped again from scratch.

**Quad**: four points `{ x, y }`, fractions of the image (0..1, x from the left, y from the top),
clockwise from the page's top-left (`TOP_LEFT`, `TOP_RIGHT`, `BOTTOM_RIGHT`, `BOTTOM_LEFT`).
Functions never change a quad in place.

**PageOutline**: `{ quad, confidence (0..1), confident (confidence >= 0.5) }`.

## decode.js

### `importImage(file, { signal }) → Promise<ImportResult>`

Takes in one FileItem (`{ name, bytes, lastModified? }`). Never rejects for a bad file (only
`CancelledError` when `signal` aborts):

- `{ status: 'added', image: StoredImage }`
- `{ status: 'unsupported', sourceType }`: not JPG, PNG, HEIC, AVIF, WebP, BMP or GIF by its first
  bytes (a TIFF, a video, text…), or AVIF in a browser without an AVIF decoder.
- `{ status: 'failed', sourceType }`: damaged, or claiming more than 220 megapixels.

What happens, as in the app: a JPEG or PNG that is upright and at most 25 megapixels is kept byte
for byte except its metadata (EXIF with location and camera, XMP, IPTC, comments, PNG text and
time chunks, and anything after the end: the video of a motion photo, the extra pictures of a
multi-picture JPEG); its colour profile is kept. Anything else is decoded and stored again: a photo
(lossy WebP, HEIC/AVIF without transparency, a turned or very large JPEG) as JPEG at quality 0.95, a
picture with transparency or kept without loss (PNG, lossless or see-through WebP, BMP, the first
frame of a GIF) as PNG. Larger than 25 megapixels, it is halved until it fits (a 48 MP photo →
12 MP); if the browser runs out of canvas or memory, it is halved again, up to 32 times.

```js
import { importImage } from '../../engine/images/decode.js';
const r = await importImage(fileItem);
if (r.status === 'added') pages.push({ id: nextId++, image: r.image, rotation: 0 });
```

### `importImages(files, { onProgress, onImage, signal }) → Promise<{ images, unsupported, failed, messages }>`

One after another, in order (as `MainViewModel.importImages`). `onImage(image | null, index)` is
called for each as it is done (so a scan can open the crop screen for the first while the rest
come), `onProgress(done, total)` after each. `messages` is what to show, in order, as
`[{ key, count }]` for `tp(key, count, count)`:

```js
const { images, messages } = await importImages(fileItems, { onImage: (im) => im && addPage(im) });
for (const m of messages) snackbar(tp(m.key, m.count, m.count));
```

### `unsupportedMessageKey() → Promise<string>`

`'msg_skipped_unsupported'`, or `'web_skipped_unsupported_no_avif'` where this browser can't
decode AVIF (the app names the types each Android version reads the same way).

### `canDecodeAvif() → Promise<boolean>`

Whether this browser decodes AVIF (tried once on a small AVIF picture, then remembered).

### `loadImage(image, { maxSide = Infinity, rotation = 0, signal }) → Promise<ImageBitmap>`

A StoredImage (or a cropped page) decoded for showing: at most `maxSide` pixels on its long side,
turned `rotation` degrees clockwise (PageCropper.upright). For thumbnails, the crop screen's picture
(e.g. `maxSide: 2048`) and the Filters preview. Rejects with
`UserError('msg_image_unreadable', image.name)`. Call `bitmap.close()` when done.

```js
const bitmap = await loadImage(page.image, { maxSide: 400, rotation: page.rotation });
ctx.drawImage(bitmap, 0, 0); bitmap.close();
```

### `photoName(name, taken = null, now = new Date()) → string` and `isUnnamedPhoto(name) → boolean`

A photo with no useful name (`image.jpg`, `image (2).jpg` as iPhones name camera captures, a number
such as `1000000163.jpg` from Android's photo picker or a camera's milliseconds, or nothing) is named
`Photo_yyyyMMdd_HHmmss` and its extension, from when it was taken (EXIF DateTimeOriginal, else the
file's `lastModified`, else now), as the app names photos from its Photos picker. Any other name is
kept (only its last path part). `importImage` already does this. (The app names a photo taken with
its own Take photo `Scan_yyyyMMdd_HHmmss.jpg`; a screen that knows a file came from its Take photo
button can do the same by passing `{ ...file, name: 'Scan_…' + '.jpg' }`.)

```js
photoName('1000000163.jpg', new Date(2024, 4, 1, 13, 45, 12)) // 'Photo_20240501_134512.jpg'
photoName('IMG_2041.HEIC') // 'IMG_2041.HEIC'
```

### Constants

`MAX_PIXELS` (25 000 000), `CONVERTED_JPEG_QUALITY` (0.95), and re-exported from `image-type.js`:
`IMAGE_ACCEPT` (an `accept` attribute listing every type, extensions included, as
`ImageStore.pickableTypes`), `imageFileType`, `isLossyOpaqueWebp`, `IMAGE_MIME`,
`IMAGE_HEADER_BYTES`, `WEBP_HEADER_BYTES`.

## crop.js

### `findPageOnImage(image, { signal }) → Promise<PageOutline | null>`

PageCropper.findPage: decodes `image` at 800 pixels on its long side and looks for the page in a
worker (on the page's thread where module workers can't start). Null when nothing like a page stands
out or the search fails. Rejects with `UserError('msg_image_unreadable', name)` only when the image
can't be decoded.

### `startingCorners(outline) → { corners, foundPage }`

Where the crop screen's corners start, and what Reset goes back to (MainViewModel.openCrop): the
outline's corners when `confident`, else `inset(INSET)` (8% in from each edge). `foundPage` picks
the hint: `crop_found` or `crop_not_found`.

```js
const outline = await findPageOnImage(image);
const { corners, foundPage } = startingCorners(outline);
const start = page.original ? page.originalCorners : corners; // cropped before: where it was
```

### `shownQuad(quad, turn)` / `uprightQuad(quad, turn)`

Corners on the image upright ↔ as the crop screen shows the image turned `turn` degrees clockwise
(CropSession.shown / upright). `uprightQuad(shownQuad(q, t), t)` is `q`.

### `cropImage(image, quad, { signal, maxSide = MAX_SIDE }) → Promise<{ bytes, type, format, width, height }>`

PageCropper.crop: the page inside `quad` (on the image upright) straightened onto a rectangle of
`outputSize(quad, image.width, image.height)`, at most 3000 pixels on its long side, in the image's
format (JPEG at 0.92; a PNG keeps its transparency; anything else on white), with no metadata. Only
the region inside the corners is decoded, reduced by a power of two as far as the page allows. On
the graphics processor (WebGL 2) when there is one, else in typed arrays a band of rows at a time;
crops run one at a time. If memory runs short, the page is made smaller (3000 → 1500 → 750 → 375).
The result can be used as the page's image (it has `width`, `height`, `bytes`, `format`), with
`name` copied from the original.

Throws `UserError('crop_not_a_page')` when the corners don't make a page (check
`isUsable(quad, w, h)` first, as the screen does: it shows `crop_not_a_page` and stays open), and
`UserError('crop_failed')` when it can't be cropped (the app then keeps the page as it was). The
whole image needs no cropping: with `isWhole(quad)` the screen puts the original back instead.

```js
if (!isWhole(q) && !isUsable(q, image.width, image.height)) return showHint(t('crop_not_a_page'));
const page = await cropImage(image, q);
item.image = { ...page, name: image.name };
```

A 12-megapixel photo's page (2980 × 2493) crops in about 0.2 s in desktop Chromium on a software
GPU, 0.45 s with the processor slowed 4×.

### `straighten(source, quad, maxSide, { signal }) → Promise<canvas | null>`

PageLooks.straightened: the page inside `quad` (corners on `source`, an ImageBitmap or canvas)
straightened onto a new canvas on white, at most `maxSide` long: for showing a page on Filters before
it is cropped. Null when the corners can't be mapped onto a rectangle.

```js
const shown = await loadImage(image, { maxSide: 1600 });
const preview = await straighten(shown, corners, 1600);
```

### Also exported

`SEARCH_SIDE` (800), `JPEG_QUALITY` (0.92), `CONFIDENT` (0.5), `setGpuWarp(enabled)` (tests: force
the typed-array warp), `warpsOnGpu()`, and everything of `crop-quad.js` below.

## crop-quad.js (CropQuad, PageCrop)

- `quadOf(x0, y0, x1, y1, x2, y2, x3, y3)` or `quadOf([...8])` → quad; `WHOLE`; `inset(fraction)`
- `isWhole(quad, tolerance = 0.002)`, `isCloseTo(quad, other, tolerance = 1e-4)`
- `withCorner(quad, i, x, y)`, `movedCorner(quad, i, dx, dy)`: kept on the image
- `movedSide(quad, side, dx, dy, width, height)`: a side dragged by its middle handle; only the drag
  across it counts, its corners slide along the sides beside it (or move straight across when those
  are nearly parallel or would leave the image)
- `turned(quad, degrees)`: on the image turned by quarter turns, each corner named for where it lands
- `transformed(quad, t)`: each corner through an `image-transform.js` transform, same order
- `ordered(quad)`: clockwise from the one nearest the top-left (after corners were dragged past each other)
- `isUsable(quad, width, height, minSide = 16)`: convex, sides at least 16 pixels
- `outputSize(quad, width, height, maxSide = 3000) → [w, h]`
- `storedCorners(quad, upright, storedWidth, storedHeight) → [x0, y0, …]` (pixels)
- `TOP_LEFT`…`BOTTOM_LEFT` (0–3), `TOP_SIDE`…`LEFT_SIDE` (0–3), `MIN_SIDE` (16), `MAX_SIDE` (3000), `INSET` (0.08)

```js
let q = movedSide(corners, TOP_SIDE, dx / shownWidth, dy / shownHeight, shownWidth, shownHeight);
q = movedCorner(q, TOP_LEFT, 0, -1 / shownHeight); // a step with the arrow buttons
```

## outline.js (PageDetection)

- `findPage(rgba, width, height) → PageOutline | null`: on ImageData-style pixels (4 bytes each)
- `findPageInLuma(luma, width, height) → PageOutline | null`: on a byte of brightness per pixel
- Both throw `RangeError` when the array doesn't match the size. Work on a copy at most
  `WORK_SIDE` (400) pixels long; 15–60 ms in Node for the app's test photos.
- For tests: `shrink`, `byBrightness`, `otsu`, `largestQuad`, `convexHull`.

## image-transform.js (ImageTransform)

Transforms are frozen `{ a, b, c, d, e, f }` (s' = a·s + b·t + c, t' = d·s + e·t + f on 0..1
coordinates, t down).

- `IDENTITY`, `fromExif(orientation)`, `rotation(degreesClockwise)`, `transformOf(exif, rotation)`
- `then(t, next)`, `inverse(t)`, `swapsAxes(t)`, `sameTransform(p, q)`, `floorMod(x, m)`
- `pdfMatrix(t, x, y, width, height) → [a, b, c, d, e, f]`: the `cm` that paints an image XObject
  turned by `t` into that rectangle of a PDF page (y up)
- `canvasMatrix(t, width, height, outWidth?, outHeight?) → [a, b, c, d, e, f]` for `ctx.setTransform`

```js
// A page turned 90° clockwise in the editor, drawn into its box on the PDF page:
page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...pdfMatrix(rotation(90), x, y, w, h)), drawObject(name), popGraphicsState());
```

## image-type.js, image-meta.js, areas.js

- `imageFileType(header) → 'jpeg'|'png'|'webp'|'bmp'|'gif'|'heif'|'avif'|null` (64 bytes are
  enough: `IMAGE_HEADER_BYTES`); `isLossyOpaqueWebp(header)` (`WEBP_HEADER_BYTES`); `IMAGE_MIME`;
  `IMAGE_ACCEPT` (the file picker's accept attribute). `image-type.js` has no imports, so
  `core/files.js` can use `imageFileType` for "by content" (ImageFileType.kt) and `IMAGE_ACCEPT`
  for its pickers without loading the decoders (`decode.js` re-exports both).
- `readImageInfo(bytes, type) → { width, height, orientation, turnedByFile, taken, alpha, exifAt }`
  (never throws); `strippedJpeg(bytes)`, `strippedPng(bytes)` → bytes without metadata, or null when
  the file's structure can't be followed; `withoutExifOrientation(bytes, type, info)`.
- `areas.js`: `mapped(m, area)`, `inverted(m)`, `intersection(a, b)`, `inside(inner, outer, slack = 0)`
  on `[left, bottom, right, top]` and `cm` matrices.

## Errors and strings

Engines have no strings file; the screen that calls these puts the keys in its namespace.

| Key | English | From |
| --- | --- | --- |
| `msg_image_unreadable` | `"{1}" could not be read` | `loadImage`, `findPageOnImage` (`{1}` the image's name) |
| `crop_failed` | `Couldn't crop the page. It was kept as it was.` | `cropImage` |
| `crop_not_a_page` | `The corners don't make a page: put each one on a corner of the page.` | `cropImage` |
| `msg_skipped_unsupported` (plural) | one: `Skipped {1} file: only JPG, PNG, HEIC, AVIF, WebP, BMP and GIF images are supported.` other: `Skipped {1} files: only JPG, PNG, HEIC, AVIF, WebP, BMP and GIF images are supported.` | `importImages().messages` |
| `web_skipped_unsupported_no_avif` (plural, new) | one: `Skipped {1} file: only JPG, PNG, HEIC, WebP, BMP and GIF images are supported in this browser.` other: `Skipped {1} files: only JPG, PNG, HEIC, WebP, BMP and GIF images are supported in this browser.` | `importImages().messages` |
| `msg_failed_import` (plural) | one: `Couldn't read {1} image.` other: `Couldn't read {1} images.` | `importImages().messages` |

The crop screen's own strings (`crop_found`, `crop_not_found`, `crop_reset`, `crop_whole`, …) are
in strings.xml; `startingCorners().foundPage` says which hint to show.

All functions taking `signal` throw `CancelledError` (core/errors.js) when it aborts.

## Tests

`node tests/images-detect.test.mjs` (Node part, then Chromium, WebKit, Firefox);
`node tests/images-detect.test.mjs node` for the pure part only, or `chromium` / `webkit` /
`firefox` for one browser. The synthetic photos of the app's tests are in
`tests/fixtures/images/page-photos.mjs` (with a port of Kotlin's `Random`, so each photo is the
app's own), next to the app's test images.
