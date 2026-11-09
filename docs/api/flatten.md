# Flatten PDF engine (`site/app/js/engine/flatten.js`)

A port of the app's `Flattening.kt` (with the PDFBox form flattening and appearance drawing it
relies on), `AppearancePlacement.kt`, and the flatten parts of `PdfToolsEngine.kt` and
`PdfToolsViewModel.kt`. No UI, no strings of its own: the Flatten PDF screen owns the strings
listed below and puts them in `locales/en/flatten.js` (those not already in `common.js`).

What it does to a PDF:

- **Form fields** (text, check boxes, radio buttons, drop-down and list boxes, push buttons,
  signatures) are drawn into their pages as they look, and taken off the form. A form with no
  field left loses its `/AcroForm`.
- Fields are **drawn again first** where the app draws them: every text and choice field when the
  form asks viewers to (`/NeedAppearances`), otherwise only those with a widget that has no look.
  Text is drawn in the **form's own font** (the `/DA` font from `/DR`, a font the widget's own look
  has, or Acrobat's standard names such as `/Helv`), laid out as PDFBox lays it out: font size 0
  ("as big as fits"), alignment (`/Q`), multi-line wrapping, comb fields, list boxes with their
  choice highlighted, background and border from `/MK`, turned with `/MK /R`. Drop-down lists show
  the text paired with their value (`/Opt` pairs), not the export value. Check boxes and radio
  buttons show the state their value names (`/AS` from `/V`); one with no look for that state gets
  a tick, dot, cross, diamond, square or star (`/MK /CA`) drawn.
- **A field whose text its font can't show** (Hindi typed into a form made for English, the rupee
  sign in Helvetica, a CJK font the PDF doesn't carry) and that has no look of its own, or only one
  the form says is out of date (`/NeedAppearances`), **stays a field**, value and widgets and all;
  the form then asks viewers to draw it (`NeedAppearances true`). `keptFields` counts them.
- **Comments, highlights, drawings, stamps** and other annotations are drawn into the page and
  taken off it; **links stay** and keep working. Popups go with their comments. Hidden (`F` 2),
  print-only (no-view, `F` 32) and "invisible" (`F` 1) ones are dropped without being drawn. The
  print flag isn't looked at: what shows on screen is what is flattened, as in the app.
- A comment with **no look of its own** gets one, as viewers draw them: square, circle, line (with
  its endings), polygon, polyline, ink, highlight (multiplied with the page), underline,
  strike-out, squiggly, caret, sticky-note icons (Note, Comment, Key, Help, Insert, Check, Cross,
  Circle, Star, arrows, CrossHairs, Paragraph), text boxes (`FreeText`, in Helvetica) and stamps
  (their name in a frame).
- Each look is placed by its `/BBox` and `/Matrix` onto its `/Rect` (PDF 32000-1, 12.5.5), with the
  comment's opacity (`/CA`) and its layer (`/OC`: a comment on a layer that is off stays hidden).
  Page rotation needs nothing special: looks are drawn in the page's own coordinates.
- A **dynamic XFA form** is dropped (`droppedDynamicXfa`) and the ordinary fields flattened; a PDF
  whose only form is a dynamic XFA form, or with no fields and no annotations but links, throws.
- The result has no password (as every tool's), objects nothing uses any more are dropped, and the
  page's own drawing is kept in a `q … Q` of its own so what is added lands where it should.
- Damaged parts are skipped, not fatal: a field tree that loops, an annotation that isn't a
  dictionary, a look with no box, a font that can't be read (its field then counts as one that
  can't be drawn).

## `flattenPdf(input, hooks)` / `flattenPdf(input, options, hooks)`

```js
import { flattenPdf } from '../../engine/flatten.js';

const out = await flattenPdf(
  { name: 'form.pdf', bytes, password },          // a FileItem's bytes; password if it has one
  { name: 'form_flattened' },                      // optional: the new file's name (no .pdf needed)
  { onProgress: (done, total) => dialog.update(done / total), signal },
);
// out = { name: 'form_flattened.pdf', bytes: Uint8Array, type: 'application/pdf',
//         pageCount: 3, keptFields: 0, droppedDynamicXfa: false }
```

- `input`: `{ name, bytes, password?, outputName? }`. `outputName` is another way to give the name.
- With two arguments the second is `hooks`; with three, the second is `options` (`{ name }`).
- The name: the one given (illegal characters become `_`, a trailing `.pdf` and surrounding dots
  and spaces dropped), else `<original base name>_flattened` (`Usugami_flattened` for a nameless
  input). Screens should pass a name made with `core/names.js` (as the app's `defaultName`:
  `FileNames.withSuffix(base, "_flattened", "Usugami")`, made unique among several with fallback
  `"Flattened"`; a ZIP of several is named `Flattened_PDFs`).
- `hooks.onProgress(done, total)`: total = form fields + pages; ends with `(total, total)`.
- `hooks.signal`: an `AbortSignal`; aborting throws `CancelledError` (checked between fields and
  pages; the page gets a chance to paint every ~25 ms of work).
- Returns an OutputFile plus the facts the result screen tells: `keptFields` (fields left fillable)
  and `droppedDynamicXfa`.

Throws:

| Error | When | English text (strings.xml) |
|---|---|---|
| `UserError('flatten_nothing')` | no form fields and no annotations but links | This PDF has no form fields or comments to flatten. |
| `UserError('flatten_xfa_only')` | its only form is a dynamic XFA form | This PDF's form is a dynamic XFA form, which Usugami can't flatten. |
| `UserError('pdf_import_failed')` | not readable as a PDF (from `loadPdf`) | Couldn't open that PDF. It may be damaged or unsupported. (`common.js`) |
| `UserError('pdf_process_failed')` | anything else going wrong while flattening or saving | Couldn't process this PDF. Check the file and free storage. |
| `PasswordError` (`.wrong`) | a password is needed, or the one given is wrong | (the screen asks for it: `core/pdfdoc.js`) |
| `CancelledError` | `signal` aborted | (say nothing) |

## `flattenNotes(outcomes)` — what to say afterwards

The app's messages after Flatten PDF, for one PDF (`runFlatten`) or several (`runFlattenAll`), in
the order it shows them. Pure: give it every PDF's outcome, in order.

```js
import { flattenNotes } from '../../engine/flatten.js';

const outcomes = items.map((item, i) => (results[i].error
  ? { name: item.name, error: results[i].error }
  : { name: item.name, result: results[i].output }));
const say = (m) => (m.count !== undefined
  ? tp(m.key, m.count, ...m.args)
  : t(m.key, ...(m.args ?? []).map((a) => (typeof a === 'object' ? say(a) : a))));
for (const m of flattenNotes(outcomes)) snackbar(say(m));
```

- One PDF: its error's own message (`flatten_nothing`, `flatten_xfa_only`, …), or after success
  `flatten_xfa_dropped` and then `flatten_fields_kept` (plural, the count).
- Several: first those that failed (`file_problem` naming the dynamic-XFA-only ones with
  `flatten_xfa_only(_many)`; `batch_nothing_to_flatten` naming those with nothing to flatten;
  `batch_failed` naming the rest), then what happened to the others (`file_problem` naming them,
  with `flatten_fields_kept` / `flatten_fields_kept_many` and `flatten_xfa_dropped(_many)`). What
  is said of several files comes once for all of them, in the words for several; of one file
  alone, in the words for one. A cancelled one is left out. Names are the files' original names.

## `flattenDocument(doc, hooks)`

The same on a `PDFDocument` already open (from `loadPdf`), changed in place; returns
`{ keptFields, droppedDynamicXfa }`. Throws the `UserError`s above (not `pdf_process_failed`).
Save with `savePdf(doc)` from `pdf-common.js`.

## `bakeUnder(doc, pageIndex, areas, { signal })`

For Edit PDF and Sign PDF (the app's `Flattening.bakeUnder`): draws into page `pageIndex` the
annotations seen on it (fields, comments, stamps; not links or popups) that overlap any of `areas`
(`[left, bottom, right, top]` in the page's own coordinates), and takes them off the page, so what
the tool adds there lands on top of them, as its preview shows. Fields among them are drawn again
first where needed (as above); one whose text can't be drawn is left alone. A field drawn this
way loses that widget (and leaves the form when it has none left). A comment's popup goes with it.

```js
const doc = await loadPdf(bytes, { password });
await bakeUnder(doc, 0, [pageArea(frameMatrix, x, y, width, height)]);
// …draw the signature, then savePdf(doc)
```

## `placementMatrix(rect, bbox, formMatrix?)` and `pageArea(m, x, y, width, height)`

From `AppearancePlacement.kt` and `Flattening.pageArea` (also in `engine/flatten/placement.js`):

```js
placementMatrix([100, 200, 300, 230], [0, 0, 200, 30]);        // [1, 0, 0, 1, 100, 200]
placementMatrix([10, 10, 30, 110], [0, 0, 100, 20], [0, 1, -1, 0, 20, 0]); // fits a turned look
pageArea([0, 1, -1, 0, 100, 0], 10, 20, 30, 40);              // [40, 10, 80, 40]
```

`placementMatrix` returns the `cm` that puts an appearance (box `bbox`, own matrix `formMatrix`,
applied by `Do` itself) onto an annotation's rectangle; a box with no width or height is drawn
at its size. `pageArea` gives the page rectangle a rectangle covers once matrix `m` takes it there.

## Strings the Flatten PDF screen uses (from strings.xml)

| Key | English |
|---|---|
| `tool_flatten` | Flatten PDF (`common.js`) |
| `tool_flatten_detail` | Make forms and comments part of the page (`common.js`) |
| `pdf_flatten_action` | Flatten PDF |
| `pdf_flatten_action_many` | `{ one: 'Flatten {1} PDF', other: 'Flatten {1} PDFs' }` |
| `flatten_note` | Form fields, comments and drawings become part of the page, so they can't be changed or filled in anymore. Links keep working. |
| `flatten_nothing` | This PDF has no form fields or comments to flatten. |
| `flatten_xfa_only` | This PDF's form is a dynamic XFA form, which Usugami can't flatten. |
| `flatten_xfa_only_many` | These PDFs' forms are dynamic XFA forms, which Usugami can't flatten. |
| `flatten_xfa_dropped` | This PDF had a dynamic XFA form, which was removed. Its other form fields and comments were flattened. |
| `flatten_xfa_dropped_many` | These PDFs had a dynamic XFA form, which was removed. Their other form fields and comments were flattened. |
| `flatten_fields_kept` | `{ one: "{1} form field has text that Usugami can't draw with its font, so it was left fillable to keep that text.", other: "{1} form fields have text that Usugami can't draw with their font, so they were left fillable to keep that text." }` |
| `flatten_fields_kept_many` | Some form fields have text that Usugami can't draw with their font, so they were left fillable to keep that text. |
| `batch_nothing_to_flatten` | `{ one: '{2} has no form fields or comments to flatten, so it was left out.', other: '{1} PDFs have no form fields or comments to flatten, so they were left out: {2}.' }` |
| `file_problem` | `{1}: {2}` |
| `batch_failed` | `{ one: "Couldn't process {2}. Check the file and free storage.", other: "Couldn't process {1} files: {2}. Check the files and free storage." }` |

## Where it differs from the app

- A **password field**'s text is drawn as asterisks, as viewers show it; PDFBox draws it in the clear.
- A check box or radio button **with no look** for its state gets one drawn; PDFBox leaves it blank.
- A **stamp with no look** gets its name drawn in a frame; PDFBox (2.0) has nothing for stamps.
- A field font missing from `/DR` but named as Acrobat names the standard fonts (`/Helv`, `/ZaDb`…),
  or found in the widget's own look, is used, so forms made by pdf-lib (no `/DR`) are drawn;
  PDFBox needs `/DR` (the app turns off its fix-ups that would add `/Helv`).
- Text in a composite font (Type0, Identity-H, embedded TrueType) is **shaped** (Devanagari
  conjuncts and vowel signs) and placed glyph by glyph; PDFBox maps character by character.
- Fields and comments on a page are drawn in the page's annotation order; PDFBox draws all the
  fields first, then the comments.
- A comment on a layer stays on it (`/OC`); PDFBox draws it whatever the layer.
- The previews' own copy with kept fields' values drawn by Android (`FieldValues.kt`) isn't needed:
  pdf.js draws field values in previews itself.
