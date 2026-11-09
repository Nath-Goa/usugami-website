# Word, PowerPoint, Excel and EPUB to PDF screen (`site/app/js/tools/office/`)

One screen module for the four converters (`core/tools.js` gives each `params: { kind }`:
`'word'`, `'powerpoint'`, `'excel'`, `'epub'`), ported from the office parts of the app's
`PdfToolScreen.kt`, `OfficeOptions.kt` (DocumentInputCard, DocumentIcon, OfficeNote,
BookPageOptions, SheetPageOptions, OfficeProgressDialog) and `PdfToolsViewModel.kt`
(addDocuments, addShared, removeDocument, runConvertAll, processEach, reportFailures). The
conversion is office-core's dispatcher (`convertOffice`, `verifyOfficeFile`: docs/api/office-core.md);
the parts on screen are the kit's (docs/api/kit.md).

| File | What it is |
|---|---|
| `js/tools/office/index.js` | `mount(ctx)` and the helpers below |
| `js/tools/office/progress.js` | the conversion dialog: `officeProgressDialog`, `officeProgressView` |
| `js/tools/office/office.css` | its styles (classes `office-*`), loaded by `mount` |
| `locales/en/office.js` | its strings |
| `tests/office-ui.test.mjs` | the tests (`node tests/office-ui.test.mjs`, `--quick`: Chromium only, no screenshots); also: each tool's empty screen within 3 s with every library held back, one main landmark and Skip to content, Back and Forward and a reload on the result, the progress dialog's spacing and colours, in Chromium, Firefox and WebKit |

## What the screen does

- **Pick** one or several files: the empty card "Choose Word files" (PowerPoint, Excel, EPUB),
  "You can choose several at once."; then **Add Word files** and each file's **Remove** at any
  time. On computers files can also be dropped or pasted on the empty card or anywhere on the
  screen. Files handed over (`ctx.files`: shared to the app, opened with it, dropped on Home) are
  added the same way, and so are files shared while the tool shows (`receiveFiles`).
- **Checking** (OfficeConverter.verify, through `verifyOfficeFile`): a bar under the top bar while
  files are checked; each joins the list once it passes. Those that can't be converted are left
  out and named once all are tried, those with the same reason together in the words for several
  ("minutes.doc, agenda.doc: These are old Word files (.doc). Save them as .docx…"); a file picked
  alone is told about without its name. Every file is taken and checked, also one of another kind
  (a PDF dropped on Word to PDF says "This isn't a Word document (.docx), or it's damaged."), as the
  app checks whatever the picker gives it. Picking and the main button are off meanwhile.
- **One file**: its card (the kind's icon on a tinted square where a PDF's first page would be,
  the name, "Word document · 25 kB", Remove = start over), Add Word files, what converts
  (OfficeNote), the kind's choices, and **File name** with ".pdf" (the file's own name at first).
- **Several**: what converts and the choices for all first, then the kit's `batchList` (each card
  with its own File name), then Add Word files.
- **Choices**, kept while the screen shows (the app's rememberSaveable), for every file:
  - EPUB: "Page size", A5 (default) or A4, "A5 is about the size of a paperback; A4 suits printing."
  - Excel: "Page size: As in the file ▾" (As in the file, A4, US Letter, US Legal, A3, A5) and
    "Orientation: As in the file ▾" (As in the file, Portrait, Landscape) chips; "Fit columns to
    page width" (on; its detail says what on and off do) and "Gridlines" (off) switches.
  - Word and PowerPoint have none.
- **Convert**: "Convert to PDF" / "Convert 3 files to PDF". The PDFs are named as typed (a blank
  name: the kind's, "Document"), two asking for one name told apart ("Report", "Report (2)"),
  as OfficeConverter.convertEach. Files are converted one after another in the dialog below; one
  that fails doesn't stop the others.
- **Progress** (OfficeProgressDialog, after 400 ms): "Creating and compressing PDF…" (one) or
  "…PDFs…" (several), the bar, for several "PDF 2 of 5" (read out as it changes) and the file's
  name, then the page being drawn (its parts 12 px apart, the kit's empty lines taking no room for
  one file; the page in the dialog's text colour, as the app's): "Page 3" (Word, its count unknown until the end), "2 of 6
  slides", "1 of 4 pages" (Excel), "Chapter 2 of 9" (EPUB). One file: the bar moves with the
  slides, pages or chapters, and runs without end for Word and while the PDF is saved; several:
  it moves file by file, each file's share filled as it goes. **Cancel** stops it: nothing is
  made and nothing said.
- **The result** (`showResult`): one PDF with Open, Share, Save to Downloads, Save as…; several with
  their own buttons, Save to folder… and Share or save as ZIP (`Converted_PDFs.zip`). Back returns
  to the files with their names and choices; the browser's Back and Forward move between the two
  (`pushStep('result')`, `onStep`, as the other tools): Forward shows the result left with Back
  again; once it has gone (Start over, a run since) Forward stays on the files, and a reload on
  the result's step leaves that step. Start over asks first while unsaved.
- **Messages** once the result shows (or with no result when none was made): a file that couldn't
  be converted for a reason of its own is named with it ("hidden.pptx: This presentation has no
  slides to convert…", the same reason together, worded for several); one that failed for no such
  reason (a damaged part found while converting) with "Couldn't process broken.pptx. Check the
  file and free storage."; a single file's own message without its name ("Couldn't convert this
  file. Check the file and free storage.").
- **Files shared while the screen shows** (the app's addShared and UsugamiApp's share handling):
  added to the list; while converting they wait ("The files you shared will open once this is
  done.") and are taken once it is done; over a result the tool starts afresh with them, asking
  first while the result isn't saved ("Discard this PDF?" / "The files you shared are ready to open,
  but this PDF isn't saved yet…", Discard / Keep). Keep: they join the list once the result has
  gone (Back to editing, Start over); leaving the tool drops them, as the app's exitTool does.
- **Leaving**: `hasUnsavedWork()` is true while converting and while a result isn't saved, so the
  router asks "Discard your changes?" first. Leaving stops a run under way.
- Keyboard and screen readers: the book's page size is a radio group named by its heading, the
  chips are menu buttons (arrow keys in the menu), the switches are `role=switch` named by their
  label and described by their detail, each Remove names its file, controls off for a moment
  (while checking or converting) use `aria-disabled` so the focus stays on them, a removed card
  passes the focus to the next Remove, and after a run with nothing made the focus is back on the
  main button.
- **Loading**: the screen shows its empty "Choose" card at once, without waiting for any library:
  it imports only `engine/office/kinds.js` (the kinds, choices and message keys); the engine
  (`engine/office/index.js`: ZIP and XML reading, fflate) and the kind's converter (pdf-lib, the
  fonts) are loaded while the user picks a file, and awaited where a file is first checked or
  converted.
- Landmarks: the content (under the top bar) is the screen's `<main data-main>`, which the app's
  "Skip to content" link moves the focus to.
- Layout: one column in the app's order, its parts 16 px apart, at every width. From 840 px one
  file (and the empty card) stays in a 640 px column in the middle; several are the kit's grid of
  cards (2–3 across) under the choices for all (640 px wide). The main button is the kit's
  `bottomBar`; snackbars sit above it.

## Exports

### `index.js`

**`mount(ctx)`** → `Promise<handle>` — renders the tool into `ctx.root`. The kind is
`ctx.params.kind` (or `ctx.tool.params.kind`); any other throws `RangeError` (the router then shows
its "couldn't be opened" screen). The handle: `unmount()`, `hasUnsavedWork()`, `onStep(step)` (the
router's; `'result'` or null), `receiveFiles(fileItems)` (files shared while it shows), and `state`
(a getter, for tests): `{ kind, documents: [{ id, name, outputName }], options, importing, processing, result }`.

**`OFFICE_SCREENS`** — per kind: the string keys `pick` ("Choose Word files"), `add` ("Add Word
files"), `document` ("Word document"), `note` (what converts) and the `icon`
(`description`, `slideshow`, `table_chart`, `auto_stories`).

**`BATCH_NAME`** → `'Converted_PDFs'`: what several PDFs are called together (their ZIP file).

**`officeNames(documents, kind, typed = [])`** → `string[]` — the names (without `.pdf`) the PDFs
made of `documents` (`[{ name }]`) get: each `typed[i]` when not null, else the file's own name
without its extension (FileNames.baseName); made safe; told apart ignoring case; blank →
the kind's name (Document, Presentation, Spreadsheet, Book).
```js
officeNames([{ name: 'a.docx' }, { name: 'b.docx' }], 'word', ['Plan', 'plan'])   // ['Plan', 'plan (2)']
officeNames([{ name: 'Budget.xlsx' }], 'excel', ['  '])                          // ['Spreadsheet']
```

**`messageKey(error, kind, many = false)`** → string key — office-core's `officeErrorKey`, with the
web app's wording where it has one (`office_too_large` → `web_office_too_large`, as the app says "on
a phone").
```js
snackbar(t(messageKey(error, 'excel')));
```

### `progress.js`

**`officeProgressDialog({ kind, many = false, onCancel?, delay? })`** → `{ el, dialog, next(number, total, name), progress(done, total, info), close() }`
The kit's `progressDialog` titled "Creating and compressing PDF…" / "PDFs…", with a line of its own
for the page, slide or chapter (`.office-progress-step`, not a live region). `next` when file
`number` of `total` starts (several files), `progress` as `convertOffice`'s `onProgress` reports,
`close()` → Promise. `delay` as the kit's (400 ms).
```js
const dialog = officeProgressDialog({ kind: 'powerpoint', many: true, onCancel: () => controller.abort() });
dialog.next(1, 2, 'deck.pptx');
const out = await convertOffice('powerpoint', item, {}, { signal, onProgress: (d, n, info) => dialog.progress(d, n, info) });
await dialog.close();
```

**`officeProgressView(progress, kind, many = false, batch = null)`** → `{ fraction: number | null, text: string | null }`
What the dialog shows (pure): `progress` `{ done, total, compressing }` or null, `batch`
`{ number, total, name }` or null. `fraction` null is a bar without end.
```js
officeProgressView({ done: 3, total: null }, 'word')       // { fraction: null, text: 'Page 3' }
officeProgressView({ done: 2, total: 6 }, 'powerpoint')    // { fraction: 0.333…, text: '2 of 6 slides' }
officeProgressView({ done: 1, total: 2 }, 'epub', true, { number: 2, total: 4 })   // { fraction: 0.375, text: 'Chapter 1 of 2' }
```

## Errors

The screen throws no `UserError`s. It shows those of `verifyOfficeFile` and `convertOffice`
(keys and texts in office-core.md, all defined in `locales/en/office.js`), the text engine's
`web_fonts_unavailable`, and `web_tool_load_failed` ("Word to PDF couldn't be opened…") when the
engine or the converter can't be loaded (offline before they were saved for offline use). `office_too_large` / `_many` are shown in the web wording
(`web_office_too_large`: "This workbook is too big to convert on this device. Set a print area for
the part you need in Excel or another app, then try again.").

## Strings

Each key is defined in exactly one `locales/en` file. `locales/en/office.js` defines, from
strings.xml (keys and English texts as the app's): `pick_word`, `pick_powerpoint`, `pick_excel`,
`pick_epub`, `add_word`, `add_powerpoint`, `add_excel`, `add_epub`, `document_word`,
`document_powerpoint`, `document_excel`, `document_epub`, `office_note_word`,
`office_note_powerpoint`, `office_note_excel`, `office_note_epub`, `book_page_note`,
`sheet_as_file`, `sheet_fit_width`, `sheet_fit_width_on`, `sheet_fit_width_off`,
`sheet_gridlines`, `sheet_gridlines_detail`, `convert_many` (plural), `creating_pdfs`,
`progress_slides` (plural), `progress_chapter`, every office message with its `_many`
(`office_legacy_word|powerpoint|excel`, `office_encrypted`, `office_encrypted_excel`,
`office_not_word|powerpoint|excel`, `epub_not_recognized`, `epub_protected`, `office_no_slides`,
`office_no_sheets`, `epub_empty`, `office_embedded_content`, `office_too_large`), and
`office_convert_failed`.

Web: `web_office_note_word|powerpoint|excel|epub` (the notes saying "Usugami's own fonts" where the
app says "your phone's fonts": the web app draws with its own bundled fonts; shown through
`tWeb`), `web_office_too_large` / `_many`, and `web_opening_files` ("Opening the files…", the
checking bar's name).

The screen also uses, from `common.js`: the tool names, `option_page_size`, `option_orientation`,
`size_a4`, `size_letter`, `size_legal`, `size_a3`, `size_a5`, `orientation_portrait`,
`orientation_landscape`, `convert`, `creating_pdf`, `pick_several_hint`, `remove_file`,
`result_details`, `progress_pages`, `batch_progress`, `batch_failed`, `file_problem`,
`share_waits`, `pdf_discard_title`, `share_discard_body`, `discard`, `keep`, `cancelling`,
`web_fonts_unavailable` (the text engine's) and `web_tool_load_failed`; from `kit.js`:
`file_name`, `pdf_page_number`, `option_value` and the kit's own. Those load at start, so they
are never copied into `office.js`.

## Differences from the app

- The files picked are kept in memory for as long as the screen shows: a reload loses them (the
  app keeps copies that survive Android stopping it, and says so when the system clears them).
- Files can also be dropped or pasted (computers). Every file dropped is checked, as picked ones are.
- Browser Back while converting asks "Discard your changes?" (Discard stops the run); the app
  ignores Back then.
- The notes say "Usugami's own fonts" and the too-large message "on this device" (web_ strings).
- A blank name gives the kind's name (Document.pdf) for one file too; the app's single-file path
  would say Compressed.pdf.
- Files shared over a result kept with Keep are dropped when the tool is left, as in the app; the
  app's quiet wait for files still being copied in has no web equivalent (files arrive whole).
