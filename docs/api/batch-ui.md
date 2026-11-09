# Compress PDF and Flatten PDF screens (`site/app/js/tools/compress/`, `site/app/js/tools/flatten/`)

The two tool screens, ported from the app's `PdfToolScreen.kt` (`CompressOptions`, `CompressBatch`,
`PdfBatchList`, `FlattenOptions`), `BatchList.kt`, the batch parts of `PdfToolsViewModel.kt`
(`addPdfs`, `runCompress`, `runCompressAll`, `runFlatten`, `runFlattenAll`, `processEach`,
`reportFailures`) and the per-file lines of `ResultScreen.kt`. They share one screen module. The
work is done by `engine/compress.js` (docs/api/compress.md) and `engine/flatten.js`
(docs/api/flatten.md); the parts on screen are the kit's (docs/api/kit.md).

| File | What it is |
|---|---|
| `js/tools/compress/index.js` | Compress PDF: `mount(ctx)` and the level helpers below |
| `js/tools/compress/batch-screen.js` | `mountPdfBatchTool(ctx, spec)`, the screen both tools use |
| `js/tools/compress/compress.css` | its styles (classes `compress-*`), loaded by batch-screen.js |
| `js/tools/flatten/index.js` | Flatten PDF: `mount(ctx)` and `defaultFlattenName` |
| `locales/en/compress.js`, `locales/en/flatten.js` | their strings |
| `tests/batch-ui.test.mjs` | the tests (`node tests/batch-ui.test.mjs`, `--quick`: Chromium only, no screenshots; `--edges`: only the shared screen's edges) |

## What the screens do

- **Pick** one or several PDFs (the empty card "Choose PDFs", "You can choose several at once."),
  then **Add PDFs** or **Remove** one at any time. On computers PDFs can also be dropped or pasted on
  the empty card or anywhere on the screen. PDFs handed over (`ctx.files`, from Choose a tool or a
  share) are added the same way; one carrying `item.password` opens without asking again.
- Opening: a bar under the top bar while PDFs are opened; each joins the list as soon as it is
  open. A locked PDF asks for its password in turn (a wrong one says so in the dialog; Cancel
  leaves it out quietly). Those that can't be opened are left out and named once all are tried
  ("junk.pdf: Couldn't open that PDF. It may be damaged or unsupported.", several with the same
  reason together, worded for several); a PDF picked alone is told about without its name, as
  the app does. Picking and the main button are off meanwhile. **Start over** (Remove on the one
  PDF's card) while more are still opening abandons them, as the app's `startOver` abandons its
  import: none joins the list once open, no password is asked for them, nothing is said, and
  picking is on again at once.
- **One PDF**: its card (thumbnail, name, "1 page · 2.2 MB", Remove = start over), Add PDFs, the
  tool's choices, and **File name** with ".pdf" (made afresh when the list goes back to one PDF,
  so it shows the name given in the list meanwhile, as the app composes `OutputNameField` anew).
  - Compress PDF: "Compression" with Less / Recommended / Extreme (a change gives every PDF that
    level, as the app's `setBatchChoiceForAll`) and "Text and drawings stay sharp. Images are reduced
    where it saves space."
  - Flatten PDF: "Form fields, comments and drawings become part of the page, …".
- **Several PDFs**: what goes for all first, then the kit's `batchList` (each card with its own
  name field, and for Compress PDF its own "Compression" level), then Add PDFs.
  - Compress PDF: "Compression for all PDFs" (none chosen while the PDFs' levels differ), and
    "Change one below to give it a level of its own. Text and drawings stay sharp. …". A PDF added
    later gets the level for all (`BatchChoices.following`).
- Names start as `<name>_compressed` / `<name>_flattened` (`FileNames.withSuffix`, "Usugami" for a
  nameless file); what is typed is kept per PDF while PDFs come and go. When the button is pressed
  the names are made safe and unique among them (`uniqueNames(names, 'Compressed' | 'Flattened')`:
  "Report" and "Report (2)"; a blank one becomes "Compressed" / "Flattened").
- The main button: "Compress PDF" / "Compress 3 PDFs", "Flatten PDF" / "Flatten 3 PDFs". It runs
  `runBatch` (the kit): "Working on your PDF(s)…", "PDF 2 of 5" and the PDF's name, Cancel. One
  that fails doesn't stop the others.
- **The result** (`showResult`): each PDF with "Compressed from 2.4 MB (62% smaller)" or "Already
  compact: the original was kept" (from the engine's `originalSize` / `keptOriginal`), its own
  Open, Share and Save; Save to Downloads, Save to folder…, Share or save as ZIP
  (`Compressed_PDFs.zip` / `Flattened_PDFs.zip`); "The new PDF(s) have no password." when one had a
  password. Back returns to the PDFs with their levels and names; the browser's Back and Forward
  move between the two (`pushStep('result')`). Start over asks first while unsaved. A reload on the
  result's step loses the result (as every screen's state, see Differences): the step is taken off
  the history (`popStep`), and Forward to a result that is gone (put away by Start over, or lost
  with a reload) stays on the PDFs. At its top,
  the Usugami watermark's switch (docs/api/mark.md): with it on, the PDFs get the watermark as they
  show, and those lines are worked out from the PDFs with it.
- **Messages**, after the result shows, in the app's order and words (the engines' `compressNotes`
  and `flattenNotes`), worked out once the PDFs have the Usugami watermark the setting asks for
  (`showResult`'s `onReady`, the app's `afterResult`): each outcome's `result` is the PDF as the
  result screen shows it.
  - Compress, one PDF: its error, or "This PDF is already compact; the original size was kept." /
    "This PDF couldn't be made any smaller." (it had a password, or got the watermark: a PDF with
    the watermark put on isn't the original any more, `keptOriginal: false`). Several: "Couldn't
    process broken.pdf. Check the file and free storage." naming those that failed, then
    "statement.pdf couldn't be made any smaller." naming those with a password, or the watermark,
    that came out no smaller.
  - Flatten, one PDF: its error ("This PDF has no form fields or comments to flatten.", the XFA
    one), or "This PDF had a dynamic XFA form, which was removed. …" and "2 form fields have text
    that Usugami can't draw with their font, …". Several: those whose only form is XFA together
    ("tax form.pdf, visa form.pdf: These PDFs' forms are dynamic XFA forms, …"), "alpha.pdf has no
    form fields or comments to flatten, so it was left out.", "Couldn't process …", then what
    happened to the others ("amounts.pdf: 2 form fields have text …", several together in the words
    for several).
  - With none made there is no result: only the messages.
- **Leaving**: `hasUnsavedWork()` is true while PDFs are being made and while a result isn't
  saved, so the router asks "Discard your changes?" first. Leaving (or unmounting) stops a run under
  way, and the PDFs still opening with a password question still open (Back closes the question
  first, as Android's Back closes a dialog). Cancel in the progress dialog stops it with nothing
  made and nothing said.
- Keyboard and screen readers: the level groups are radio groups named by their headings, each
  Remove names its PDF, controls that are off for a moment (while opening or making) use
  `aria-disabled` so the focus stays on them, a PDF's card removed passes the focus to the next
  Remove, and after a run with nothing made the focus is back on the main button.
- Layout: one column, as the app's, at every width. From 840 px one PDF (and the empty card) stays
  in a 640 px column in the middle; several are the kit's grid of cards (2–3 across) under the
  choice for all (640 px wide). The main button is the kit's `bottomBar`. Snackbars sit above it
  (the kit lifts them above any `.ui-bottombar`). Everything between the top bar and the main
  button is the screen's one `<main data-main>` landmark, where "Skip to content" goes.

## Exports

### `mountPdfBatchTool(ctx, spec)` (batch-screen.js) → `Promise<handle>`

Renders a batch PDF tool into `ctx.root` (the router's mount context, see shell.md) and returns
the handle the router keeps. For a tool that makes one PDF of each of several PDFs, with an
optional choice for all that one PDF can also have of its own.

| `spec` | |
|---|---|
| `id` | `'compress'`, `'flatten'` (for the record; nothing else uses it) |
| `action`, `actionMany` | string keys of the main button for one PDF / its plural for several |
| `defaultName(src)` | the name (no `.pdf`) a PdfSource's new PDF gets until another is typed |
| `fallback` | the name for a blank one (`'Compressed'`) |
| `batchName` | what several are called together, as their ZIP file (`'Compressed_PDFs'`) |
| `engine()` | `() => import(...)`: loaded at mount (not awaited), awaited when the button is pressed |
| `work(engine, src, { name, choice }, hooks)` | makes one OutputFile; `hooks` = `{ signal, onProgress }` |
| `notes(engine, outcomes)` | the messages after a run: `[{ key, args, count? }]`, args may be messages; called once the result's PDFs have the Usugami watermark the setting asks for, each `result` the PDF as shown (with all failed, at once) |
| `note` | (optional) a line saying what the tool does, shown for one PDF and several |
| `choice` | (optional) `{ options: [{ value, label }], all, title, forAllTitle, note, forAllNote }`: the choice's numbers, its start value, the heading for one PDF and each PDF's label, the heading for several, and the notes under them |

`outcomes` is `[{ name, result }]` or `[{ name, error }]` per PDF in order (`name` the PDF's own
name), which is what `compressNotes` and `flattenNotes` take. The engine failing to load says
`web_tool_load_failed` ("Couldn't load Compress PDF. Check your internet connection and try again.").

The handle: `unmount()`, `hasUnsavedWork()`, `onStep(step)` (the router's; `'result'` or null), and
for tests two getters: `state`, `[{ id, name, outputName, choice }]` for the PDFs listed, and
`settled`, a promise resolved once the PDFs being opened are in or left out (abandoned ones too).

```js
import { mountPdfBatchTool } from '../compress/batch-screen.js';
export async function mount(ctx) {
  await loadStrings('flatten');
  return mountPdfBatchTool(ctx, {
    id: 'flatten', action: 'pdf_flatten_action', actionMany: 'pdf_flatten_action_many',
    defaultName: defaultFlattenName, fallback: 'Flattened', batchName: 'Flattened_PDFs',
    note: t('flatten_note'),
    engine: () => import('../../engine/flatten.js'),
    work: (engine, src, { name }, hooks) => engine.flattenPdf({ name: src.name, bytes: src.bytes, password: src.password }, { name }, hooks),
    notes: (engine, outcomes) => engine.flattenNotes(outcomes),
  });
}
```

The tool's namespace must define `web_opening_pdfs` ("Opening the PDFs…", the opening bar's name).

### `compress/index.js`

- `mount(ctx)`: Compress PDF.
- `LEVELS` → `['less', 'recommended', 'extreme']` (the app's `PdfCompression` order; a level's
  number in `BatchChoices` is its index).
- `DEFAULT_CHOICE` → `1` (Recommended, the app's `DEFAULT_BATCH_CHOICE`).
- `levelOf(choice)` → the engine's level: `levelOf(2)` → `'extreme'`; out of range → `'recommended'`
  (`BatchChoices.compressionOf`).
- `defaultCompressName({ name })` → `'Report_compressed'` for `Report.pdf` (`'Usugami_compressed'`
  without a name); the same as the engine's, here so the screen needn't load the engine for it.

### `flatten/index.js`

- `mount(ctx)`: Flatten PDF.
- `defaultFlattenName({ name })` → `'form_flattened'` (`'Usugami_flattened'` without a name).

## Errors

The screens throw no `UserError`s. They show the engines' and the kit's (texts in compress.md,
flatten.md and kit.md): `pdf_import_failed`, `pdf_process_failed`, `flatten_nothing`,
`flatten_xfa_only`, `pdf_import_failed`, `pdf_certificate_unsupported`.

## Strings

`locales/en/compress.js` (from strings.xml): `pdf_compress_action` "Compress PDF",
`pdf_compress_action_many` (one "Compress {1} PDF", other "Compress {1} PDFs"), `compression_title`
"Compression", `compression_less` "Less", `compression_recommended` "Recommended",
`compression_extreme` "Extreme", `pdf_compress_note`, `compression_for_all` "Compression for all
PDFs", `compression_for_all_hint` "Change one below to give it a level of its own.",
`pdf_no_reduction`, `pdf_not_smaller`, `batch_not_smaller`; web: `web_opening_pdfs`.

`locales/en/flatten.js` (from strings.xml): `pdf_flatten_action`, `pdf_flatten_action_many`,
`flatten_note`, `flatten_nothing`, `flatten_xfa_only`, `flatten_xfa_only_many`,
`flatten_xfa_dropped`, `flatten_xfa_dropped_many`, `flatten_fields_kept` (plural),
`flatten_fields_kept_many`, `batch_nothing_to_flatten` (plural); web: `web_opening_pdfs`.

The `compression_*` keys are also in `images.js` (same texts), and `web_opening_pdfs` in
`page-numbers.js` and `watermark.js`: each namespace loads alone, so each has its copy.
From `common.js` and `kit.js` they use the tool names, `pick_pdfs`, `pick_several_hint`,
`add_pdfs`, `remove_file`, `file_name`, `result_details`, `page_count`, `file_problem`,
`batch_failed`, `pdf_import_failed(_many)`, `web_tool_load_failed` and the kit's own.

## Differences from the app

- A PDF that can't be read is mostly caught when it is picked (pdf.js opens it for the card), so
  it is named then and never listed; one pdf.js can show but the engine can't read (a damaged
  structure, a missing header) is named after the run with "Couldn't process …", as in the app.
- The PDFs, levels and names live as long as the screen: a reload loses them (the app keeps them
  through Android stopping it).
- Browser Back while PDFs are being made asks "Discard your changes?" (Discard stops the run); the
  app ignores Back then.
- The single PDF's progress dialog has a bar that moves with the engine's progress; the app's runs
  without end.
- On wide screens the layout is wider (a grid of cards, a centred column); the order is the app's.
