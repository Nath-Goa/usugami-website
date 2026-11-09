# The Usugami watermark (`engine/page-mark.js`, `engine/mark-layout.js`, `core/result-mark.js`)

The Android app's "Usugami watermark" (README: "What's new in 1.6.1", the result screen, FAQ "Does
Usugami put a watermark on my PDFs?"), ported from `data/PageMark.kt`, `core/MarkLayout.kt`
(`MarkStyle`, `MarkLayout`), `ui/ResultMarker.kt`, `ui/MarkCard.kt`, the result screen and its view
models, and `PdfToolsEngine.loadUnmarked` / `previewView` / `compressTo`.

What the user gets, as in the app:

- **Off unless turned on.** A switch at the top of the result screen, above the PDFs and Open, Share
  and Save: "Usugami watermark" / "Adds a small "Usugami" in the corner of each page, to support the
  app.". One setting for the whole app, kept in this browser (`localStorage`, through
  `core/settings.js`): every PDF made afterwards gets the mark until it is turned off.
- The word "Usugami" in the **bottom-right corner of every page** of the PDFs just made, **upright and
  in the corner as the page is shown**, also on turned or cropped pages; Helvetica Bold (a standard
  font, nothing embedded), dark grey (0.2) at 30% opacity: small and light grey unless changed.
  Every page gets it, also pages a tool leaves as they were (the original Compress PDF keeps, pages
  Rotate PDF only turns).
- The **arrow** on the switch's row opens **Size** (0–100%: barely visible up to starting at the
  page's middle) and **Opacity** (10–100%: faint to solid), with the first page showing the mark as
  they move (faint while it is off). The PDFs change once a slider is let go.
- Turned on, off or changed, **the same PDFs change** after a moment (250 ms, so a quick run of
  changes rewrites them once), with a bar under the row ("Updating the watermark…"); meanwhile
  Open, Share and Save wait. **Turned off, they are the PDFs as they were made, byte for byte**,
  without making them again. A copy saved before a change stays as it was: the result counts as not
  saved again ("Not saved yet…", Start over asks), save again to keep the new version.
- With the switch on, the mark goes on as the result shows: "Adding the Usugami watermark…" (with
  "PDF 2 of 5" and the name for several) once that takes over 400 ms; its Cancel goes back to
  editing, as cancelling the run does in the app. A PDF that can't be changed is left as it is and
  "Couldn't change the Usugami watermark. Check that there is enough free storage." is said.
- **Marks never stack**: the tools take a mark off the PDFs they read (`loadPdf`), so what they make
  starts without it and gets the one the setting asks for, or none.
- The same objects and names as the Android app, so a PDF marked by either app can be changed or
  unmarked by the other.

## Strings (`locales/en/mark.js`, loaded at start by `main.js` and by `core/output.js`)

`mark_title` "Usugami watermark", `mark_detail`, `mark_adjust` "Watermark size and opacity" (the
arrow's name), `mark_size` "Size", `mark_opacity` "Opacity", `mark_percent` "{1}%",
`mark_preview_description` "Page 1 with the Usugami watermark" (the preview while on; while off it
is `pdf_page_number` "Page 1", kit.js), `mark_working` "Updating the watermark…", `mark_adding`
"Adding the Usugami watermark…", `mark_failed`. The English is strings.xml's.

## Settings (`core/settings.js`)

| Key | Value | Default |
|---|---|---|
| `mark.on` | `true` / `false` | off |
| `mark.size` | 0–100 | 20 |
| `mark.opacity` | 10–100 | 30 |

Read and written through `core/result-mark.js`: `getMarkSetting()` → `{ on, style }`,
`wantedMark()` → the `MarkStyle` when on, else `null`, `setMarkOn(on)`, `setMarkStyle({ size,
opacity })`, `onMarkSettingChange(fn)` → unsubscribe (one call for a change of several keys; also
for a change in another tab). `MARK_KEYS` names the keys.

---

## `engine/mark-layout.js` — pure (MarkLayout.kt), no pdf-lib

```js
import { MarkStyle, MarkLayout, markStyle, sameMark, mayCarryMark } from '../engine/mark-layout.js';
```

**`new MarkStyle({ size = 20, opacity = 30 })`** — whole numbers, `size` 0–100, `opacity` 10–100
(`MIN_OPACITY`); out of range is a `RangeError`. `style.alpha` (0.1–1), `style.equals(other)`,
**`MarkStyle.of(size, opacity)`** rounds and brings each into its range (settings, a PDF).
`DEFAULT_SIZE`, `DEFAULT_OPACITY`, `MIN_OPACITY` are exported.

**`markStyle(style)`** — a `MarkStyle` from a `MarkStyle` or a plain `{ size, opacity }`, or `null`
for `null`. **`sameMark(a, b)`** — both none, or the same size and opacity.

**`MarkLayout`** — `TEXT` "Usugami", `TEXT_WIDTH` 4.223 (Helvetica Bold, in font sizes), `DESCENT`
0.217, `MARGIN` 1, `MIN_WIDTH` 0.04, `MAX_WIDTH` (the word starts mid-page), `MAX_HEIGHT` 0.25,
`GRAY` 0.2; `MarkLayout.widthShare(size)` (geometric from `MIN_WIDTH` to `MAX_WIDTH`) and
`MarkLayout.place(style, shownWidth, shownHeight)` → `{ x, y, fontSize }`: the baseline's start on
the page as shown (origin bottom-left, y up), one font size from the right and bottom edges. A4 at
the default size: about a 9 pt font. A page without width or height is a `RangeError`.

**`mayCarryMark(bytes)`** — whether a PDF may have the mark, told by searching its bytes for
`/UsugamiMark` (the mark's streams' dictionaries are never compressed): `false` means it certainly
hasn't. Fast (a 100 MB PDF in well under a second); used to skip reading PDFs without a mark.

## `engine/page-mark.js` — the mark in a PDF (PageMark.kt)

Re-exports all of `mark-layout.js`.

| Export | |
|---|---|
| `unmark(doc)` → `boolean` | Takes the mark off a pdf-lib `PDFDocument`'s pages in memory and puts back what each page had (its very content object, its resources as they were); `true` if any page had it. `loadPdf` calls it. |
| `markPdf(bytes, style \| null, hooks?)` → `Promise<Uint8Array \| null>` | Brings a PDF to carry `style` (a `MarkStyle` or `{ size, opacity }`) on every page, or no mark for `null` (PageMark.apply): the new PDF's bytes, or `null` when it already does (nothing changed). The bytes given are never changed. `hooks`: `{ signal, onProgress(done, total) }`; aborting throws `CancelledError`. A PDF with a password, also one only restricted by an owner password, can't be changed: `UserError('mark_failed')` (as the app's PageMark throws for an encrypted PDF). Saved with `savePdf` (unreferenced objects pruned, producer "Usugami"). |
| `markDoc(doc, style \| null, hooks?)` → `Promise<boolean>` | The same on a pdf-lib document in memory, without saving; `false` when nothing changed. |
| `carriesMark(doc, style \| null)` → `boolean` | Every page has `style` once, where it goes on the page as shown now (a page turned or cropped since doesn't), and nothing else of the mark; with `null`, no page has any of it. |
| `hasMark(doc)` → `boolean` | Some page has some of it. |
| `unmarkPdf(bytes, { password?, signal? })` → `Promise<Uint8Array \| null>` | A copy without the mark and without the password, for previews (PdfToolsEngine.previewView: the tools' previews show pages as they come out); `null` when it has no mark. Throws as `loadPdf` does. |

Fast on big PDFs: pdf-lib reads and writes 1500 objects before letting the screen in, and the pages
are walked with a yield every ~16 ms (a 600-page PDF is marked in about 0.1 s in Node, a 1500-page
one in about 0.2 s in Chromium).

### What the mark is in the PDF (the app's structure, so either app can take off the other's)

All of it is marked with `/UsugamiMark` in a stream dictionary:

- one **form XObject** for the whole PDF: `/Type /XObject /Subtype /Form /BBox [0 -0.3 4.323 0.8]
  /UsugamiMark true`, resources `/Font << /F << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold
  /Encoding /WinAnsiEncoding >> >>` and `/ExtGState << /GS << /Type /ExtGState /ca alpha >> >>`,
  content `/GS gs 0.2 g BT /F 1 Tf (Usugami) Tj ET` (a font size of 1, the baseline at the origin);
- before each page's own content a stream `q` (`/UsugamiMark true`), one for the whole PDF;
- after it a stream of the page's own: `Q q /Artifact <</Type /Pagination /Subtype /Watermark>> BDC
  a b c d e f cm /UsugamiMark Do EMC Q` (a pagination artifact, which screen readers pass over),
  whose `/UsugamiMark` is the marker: `/Size`, `/Opacity`, `/Matrix [a b c d e f]` (where it was
  drawn), `/Name` (the form's name in the page's resources), `/Was` (the page's `/Contents` as it
  was, when it had one), `/MadeXObjects true` / `/MadeResources true` (when it had to add them);
- the form in the page's `/XObject` resources as `/UsugamiMark` (or `/UsugamiMark1`, ... when that
  name is taken by something else; pages sharing resources share the name).

Numbers are written with at most 4 decimals. Taking it off removes exactly these and puts back
`/Was` when the page's other content streams are still what it was, so the page is as before.

## `engine/pdf-common.js` additions

- **`loadPdf(bytes, { password, unmark = true, parseSpeed })`** — as before, and now takes
  Usugami's mark off what it loads (PdfToolsEngine.loadUnmarked), so every tool makes its PDFs of
  the pages as they were; `unmark: false` leaves it. A page tree too broken to walk is left to the
  tool. `parseSpeed`: objects pdf-lib reads per tick (its default when not given).
- **`wasUnmarked(doc)`** — `loadPdf` took a mark off this document.
- **`wasEncrypted(doc)`** — the PDF was encrypted when `loadPdf` read it (opened with a password, or
  only restricted by an owner password). pdf-lib forgets it once decrypted. Compress PDF keeps a PDF
  as it was only when neither is true (see compress.md).
- **`savePdf(doc, { prune, objectStreams, objectsPerTick })`** — `objectsPerTick`: objects pdf-lib
  writes per tick (its default when not given).

## `core/result-mark.js` — the result screen's part (ResultMarker, MarkCard)

**`new ResultMarker(files)`** — the mark on a result's OutputFiles: `marker.files` (the versions
showing, in order), `hasPdfs`, `isAt(style | null)`, `useKnown(style | null)` (shows at once a
version made before: a result shown again), `bringTo(style | null, { signal, onFile(i, n, name) })`
→ `{ changed, failed }` (all change together once done; cancelled, none), `firstMade()` (the first
PDF as made, for the preview). Each PDF is kept as it was made: a PDF that kept a mark from the
PDF it was made of (Compress PDF keeping an original that had one) is taken as a copy without it,
`keptOriginal: false`. A version with the mark is `{ ...made, bytes, keptOriginal: false }` (saved
anew, a PDF Compress kept isn't that PDF any more); without the mark it is the file as made, its
`keptOriginal` too. What is known of a file is kept (WeakMap) while the file is.

**`markCard({ setting, onOn, onStyle, page })`** — the card (`.ui-mark`): the kit's `switchRow` with
the arrow (`.ui-mark-arrow`, `aria-expanded`, `aria-controls`) before the switch, a 4 px slot for
the bar, and the panel: the page (`.ui-mark-page`, `role=img`, at most 150 × 200 CSS px in the
page's shape, white A4 until drawn) and the kit's two `slider`s. Side by side when the panel is at
least 400 px wide (container query), else the page above the sliders. `el.setSetting(setting)`,
`el.setWorking(b)`, `el.setEnabled(b)` (off while saving or zipping), `el.open(b)`, `el.isOpen`,
`el.sliders`, `el.arrow`, `el.row`, `el.preview`. Styles: `site/app/css/mark.css` (loaded by
`core/output.js`).

**`drawFirstPage(file, maxCss = 200)`** → `{ canvas, width, height }` — page 1 as shown, for the preview.

## `core/output.js` — `showResult` additions

No change is needed in the screens: every result with a PDF gets the switch.

- **`onReady(files)`** (new option) — called once (after `showResult` has returned) when the PDFs
  are as the setting asks, with the files as they show, in the order given; not when the user
  leaves first (Cancel on "Adding the Usugami watermark…"). Compress PDF works out its messages here
  (the app's `afterResult`).
- **`el.files`** — now a getter: the files as they show (with or without the mark). Open, Share,
  Save, Save as, Save to folder, the ZIP file and Recent files all use these.
- **`el.ready`** — a promise of those files once ready (as `onReady`).
- **`el.markCard`** — the card, or `null` when no file is a PDF.
- `details(file)` and the default line under each file ("Compressed from…", "Already compact…") are
  worked out from the version showing, and again when it changes.
- **Each row is the version showing**, from the start: a result shown again (Back to editing and
  the result again, the browser's Forward) shows its PDFs with the mark at once (`useKnown`), and
  each row's size, its line ("Already compact…" goes: a PDF saved anew isn't the original), its own
  Open, Share and Save, and its "Saved" mark are of that version, as the app's rows act on the
  `PdfFile` shown.
- The page's listeners for the setting (and for closing the tab while unsaved) hold the screen
  weakly: a result screen left without `destroy()` is freed, and stops following the setting.
- After a change: not saved any more (each file's "Saved" mark goes, "Not saved yet…" shows,
  closing the tab asks again), and Save to folder copies all files again.

```js
// Nothing changes for a tool; to say something about the PDFs as they come out:
resultEl = showResult(ctx.root, { files, zipName, onBack, onStartOver, onReady: (shown) => tell(shown) });
```

## Tests

`node tests/mark.test.mjs` (`--quick`: Chromium only): MarkLayoutTest ported; the engine in Node
(PageMarkDeviceTest's pages: A4, Letter turned with a crop box, a blank page without content or
resources, shared and inherited resources, upside down, turned left; added, changed, idempotent,
taken off leaving content and resources as they were, a page turned or cropped since, a name taken
by another XObject, a mark as the Android app writes it, `loadPdf`, passwords, 600 pages); pdf.js
reading the marks back in Chromium, Firefox and WebKit (once per page, upright where it goes, light
grey, gone once off); the result screen at 412 × 915 and 1280 × 800 in the three browsers (switch,
arrow, sliders, preview, remembered after a reload, saved, shared and zipped bytes with the mark,
the PDFs as made once off); cancelling, a failure, a result shown again (each row's size, line
and own Save of the marked version), a change in another tab;
Rotate PDF in the app with the mark on. Compress PDF's part is in `tests/batch-ui.test.mjs`.
