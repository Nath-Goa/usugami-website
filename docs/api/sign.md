# Sign PDF (`engine/sign.js`, `js/tools/sign/`)

A port of the app's `data/Signature.kt` (the drawing, its smoothing and its picture),
`core/SignatureLayout.kt` (where it goes and how big), `PdfToolsEngine.sign`, and the screens
`ui/SignOptions.kt` and `ui/SignaturePad.kt`, with the sign parts of `PdfToolsViewModel.kt`.

A signature drawn by hand (finger, pen or mouse), in black or blue ink, goes on one page as a
picture with a see-through background: trimmed to the ink, 300 dpi (at most 2400 pixels on its
longer side), exactly where the preview put it on the page as it is shown (turned, cropped). Form
fields and comments under it become part of the page first, so it lies over them as the preview
shows. It is a picture of a handwritten signature, never a certified digital signature.

The screen keeps the signature in its module's memory for the visit only: another PDF can be signed
without drawing it again, a reload forgets it, and nothing is written to any storage.

## Engine: `engine/sign.js`

No UI, no strings of its own. Plain inputs, so it can be called from tests with `runInPage`.

### `signPdf(input, options, hooks)` → `Promise<OutputFile>`

```js
import { signPdf } from '../../engine/sign.js';

const out = await signPdf(
  { name: src.name, bytes: src.bytes, password: src.password },        // password '' or absent: none
  {
    signature,                                  // a Signature, or { strokes: number[][], ink: 'black'|'blue' }
    page: 3,                                    // from 0
    placement: { centerX: 0.7, centerY: 0.85, width: 0.32 },   // shares of the page as shown; null: lower right
    name: 'Contract_signed',                    // optional; made safe, ".pdf" added; blank → "Signed"
  },
  { signal, onProgress: (done, total) => {} },  // total is 5 steps
);
// out = { name: 'Contract_signed.pdf', bytes: Uint8Array, type: 'application/pdf', pageCount: 4 }
```

- The placement is clamped to the page first (`clampPlacement`), as the screen clamps it, so a
  placement made for one page can be used on another.
- The picture is an RGB image of the ink's colour everywhere with an 8-bit soft mask (as PDFBox's
  LosslessFactory), drawn in a `q … Q` after the page's own content, which is itself kept in a
  `q … Q`. The page gets resources of its own (shared ones are copied first). Other pages are left
  as they are; the page count doesn't change.
- Annotations under the signature (not links or popups) are drawn into the page with Flatten PDF's
  `bakeUnder` (imported only when the page has annotations). If that fails on a damaged
  annotation, the annotations stay as they are and the signature is still added.
- The result has no password, unreferenced objects pruned, producer "Usugami" (`savePdf`).
- `signal` is checked between steps; aborting throws `CancelledError`.

Throws:

| Error | When | English text |
|---|---|---|
| `UserError('pdf_import_failed')` | not readable as a PDF, or no pages | Couldn't open that PDF. It may be damaged or unsupported. (`common.js`) |
| `UserError('pdf_process_failed')` | nothing drawn, no such page, or anything failing while drawing or saving | Couldn't process this PDF. Check the file and free storage. (`common.js`) |
| `PasswordError` (`.wrong`) | a password is needed, or the one given is wrong | (the screen opens PDFs with `core/pdfdoc.js`, which asks) |
| `CancelledError` | `signal` aborted | (say nothing) |

### The signature: `Signature`

```js
import { Signature } from '../../engine/sign.js';
let s = new Signature([], 'black');              // strokes in pad units: [[x0, y0, x1, y1, …], …]
s = s.plus([120, 250, 160, 230, 200, 260]);       // a new Signature with one more stroke
s = s.withInk('blue');                            // 'black' | 'blue' (anything else is black)
s.isEmpty; s.pointCount; s.aspect;                // aspect: width / height of the ink (1 when empty)
s.bounds;                                         // { x, y, width, height } of the ink, pen included; null when empty
s.cleared();                                      // no strokes, same ink
s.toJSON();                                       // { strokes, ink }
Signature.from({ strokes, ink });                 // from a plain object (null for nothing)
```

Immutable (frozen). The pad is `PAD_WIDTH` × `PAD_HEIGHT` units (1000 × 500).

### Drawing it

- `traceSignature(target, strokes)` → `[[x, y], …]` dots. Traces the app's smooth curve onto a
  canvas context or `Path2D` (`moveTo`, `quadraticCurveTo`, `lineTo`): from each stroke's first
  point it bends through each point to the midpoint between it and the next, then goes straight to
  the last point. One-point strokes are returned as dots, to be drawn as round as the pen's end.
- `drawSignature(ctx, strokes, color)` — strokes and dots on a 2D context in pad units (set the
  transform first), pen `PEN_WIDTH` (9 units) wide, round ends and joins.
- `signaturePathData(strokes)` → `{ line, dots }` — the same as SVG path data in pad units
  (stroke `line` with `stroke-width` 9, round caps and joins; fill `dots`).
  `signaturePathData([[0, 0, 10, 10, 20, 0]]).line` → `'M0 0Q10 10 15 5L20 0'`.
- `renderSignature(signature, widthPx)` → `{ width, height, alpha: Uint8Array }` — the picture
  trimmed to the ink, `widthPx` wide, one alpha byte per pixel (OffscreenCanvas, else a canvas).
  Throws `RangeError` when nothing is drawn.
- `inkColor(ink)` → `'#000000'` | `'#1a3c9c'`; `INKS` → `{ black: 0xff000000, blue: 0xff1a3c9c }`.

### Layout (SignatureLayout.kt), pure

All sizes in points on the page as shown; placements are `{ centerX, centerY, width }` as shares
of the page (from the left and top edges, as on a screen).

| Function | Returns |
|---|---|
| `inkBounds(strokes, penWidth = 9)` | what the smoothed strokes cover (curve extremes measured), `{ x, y, width, height }` or null |
| `widthRange(shownWidth, shownHeight, aspect)` | `[smallest, largest]` width share: half an inch on the longer side … as big as the page |
| `heightShare(width, shownWidth, shownHeight, aspect)` | its height as a share of the page's height |
| `defaultPlacement(shownWidth, shownHeight, aspect)` | lower right: 32% of the shorter side wide (at most 12% of the page tall), 8% from the edges |
| `clampPlacement(placement, shownWidth, shownHeight, aspect)` | width in range, moved as little as needed to be wholly on the page |
| `pdfArea(placement, shownWidth, shownHeight, aspect)` | `{ x, y, width, height }` from the shown page's bottom-left corner, y up |
| `pixels(widthPoints, heightPoints)` | `[w, h]` at 300 dpi, at most 2400 on the longer side |

`widthRange`, `defaultPlacement` and `pixels` throw `RangeError` for sizes that aren't positive.

```js
defaultPlacement(595, 842, 3);  // { centerX: 0.76, centerY: 0.9058…, width: 0.32 }
pdfArea({ centerX: 0.25, centerY: 0.25, width: 0.2 }, 600, 800, 2); // { x: 90, y: 570, width: 120, height: 60 }
pixels(180, 72);                // [750, 300]
```

Constants: `PAD_WIDTH` 1000, `PAD_HEIGHT` 500, `PEN_WIDTH` 9, `MIN_SIDE_POINTS` 36,
`DEFAULT_WIDTH` 0.32, `DEFAULT_MAX_HEIGHT` 0.12, `DEFAULT_MARGIN` 0.08, `DPI` 300,
`MAX_PIXELS` 2400, `MIN_STEP` 2 (pad units between kept points), `MAX_POINTS` 5000.

### The page as shown (PageFrame)

- `pageFrame(doc, index)` (a pdf-lib document) → `{ left, bottom, width, height, rotation,
  shownWidth, shownHeight, matrix }`: the crop box within the media box (inherited, written
  backwards or not, Letter when missing; an empty overlap uses the media box) turned by `/Rotate`
  (inherited; not a quarter turn → 0; negative → counted back), read exactly as pdf.js reads it, so
  the preview (pdf.js) and the signed page agree. `matrix` takes points on the shown page (origin
  bottom-left, y up) to the page's own coordinates.
- `frameOf(left, bottom, width, height, rotation)` — the same from numbers.
  `frameOf(0, 0, 595, 842, 90).matrix` → `[0, 1, -1, 0, 595, 0]`.
- `pageArea(m, x, y, width, height)` → `[left, bottom, right, top]` the rectangle covers once `m`
  takes it there.

## Screen: `js/tools/sign/`

| File | What it is |
|---|---|
| `index.js` | `mount(ctx)`; `keptSignature()` → the visit's signature as `{ strokes, ink }` or null (tests use it) |
| `pad.js` | `openSignaturePad({ initial })` → `Promise<Signature|null>`; `closeSignaturePad()` |
| `placer.js` | `pageStrip({ src, selected, onSelect, label })`, `signaturePlacer({ src, signature, page, placement, onPlacement })` → `{ el, controls, setPage, setSignature, placed, destroy }`, `signatureSvg(signature, { fit, cls })`, `NUDGE` (0.02) |
| `sign.css` | the tool's styles, classes prefixed `sign-` |

Flow, as the app's: Choose PDF (also drop or paste; a PDF dropped on the loaded screen replaces
it; `ctx.files[0]` opens at once, with `item.password` if Choose a tool asked for it) → the PDF's
card → "Signature" with "Draw your signature" (or the signature, to change) and the note that it
isn't a certified digital signature → once there is a signature: "Page to sign" (a strip of the
pages, the last chosen first; only for more than one page), "Place your signature" (the page drawn
by pdf.js with the signature on it: drag it, tap or click elsewhere to move it there, arrow keys on
the focused signature), "Size", the four nudge buttons (off against an edge) → "File name"
(`<name>_signed`) → Sign PDF → "Working on your PDF…" (Cancel) → the result screen ("The new PDF
has no password." for a locked one). The result is a history step (`ctx.pushStep('result')`):
Back to editing keeps the page, the place and the name; the browser's (or a phone's) Back from the
result does the same, and Forward shows the result again; a reload on that step takes the step
back. Start over and removing the PDF keep the signature. PDFs are opened with the screen's
AbortSignal (`openPdf(item, { password, signal })`), so a password dialog still open closes when
the user leaves.

The pad: full screen on phones (sized to leave room for the ink row on a phone turned sideways),
a dialog in the middle from 840 × 600 px. One finger, pen or mouse signs at a time; coalesced
pointer events give smoother curves; points closer than 2 pad units are dropped and at most 5000
are kept; Clear mid-stroke drops the rest of that stroke; Done mid-stroke keeps it; closing (×,
Escape) keeps the signature there was. On wide screens the size and nudge buttons sit beside the
preview, under the options.

`hasUnsavedWork()` is true while signing and while an unsaved result shows.

## Strings (`locales/en/sign.js`)

From strings.xml: `pdf_sign_action`, `sign_signature`, `sign_draw`, `sign_change`, `sign_note`,
`sign_pad`, `sign_pad_hint`, `sign_ink`, `sign_clear`, `sign_done`, `sign_page`, `sign_place`,
`sign_place_hint`, `sign_preview_description` ("Your signature on page {1}"), `sign_size`,
`sign_size_description`, `sign_move_left|up|down|right`, `color_black`, `color_blue`.
Web only: `web_sign_pad_hint` ("Sign above the line with your mouse, pen or finger.", where the
main pointer is a mouse), `web_sign_place_hint` ("Drag the signature, or click where it should
go."), `web_sign_keys_hint` ("Arrow keys move it."), `web_sign_size_value` ("{1}%", read out by
the size slider). Also used, from `common.js` / `kit.js`: `tool_sign`, `pick_pdf`, `file_name`,
`pdf_page_number`, `result_details`, `page_count`, `pdf_working`, `cancel`, `pdf_import_failed`,
`pdf_process_failed`, and the kit's own.

## Tests

`node tests/sign.test.mjs` (`--quick`: Chromium only, no screenshots; `--other`: Firefox and
WebKit only; `--back`: only the browser's Back and Forward over the result step and leaving while a
password is asked for, in the three browsers).
