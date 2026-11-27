# Split PDF's screen (organize-ui-a)

Files:

| File | What it is |
|---|---|
| `site/app/js/tools/split/index.js`, `split.css` | Split PDF's options and its work (`#/tool/split`) |
| `site/app/js/tools/split/frame.js`, `frame.css` | The screen around them (the app's `PdfToolScreen` for one PDF) |
| `site/app/locales/en/split.js` | Its strings |
| `tests/organize-ui-a.test.mjs` | Its tests (`node tests/organize-ui-a.test.mjs`, `--quick`: Chromium only, `--others`: Firefox and WebKit only). Every browser picks PDFs through the real file input (Firefox too) and drops them on the card in other steps. |

Ported from the app's `PdfToolScreen.kt` (SplitOptions, PdfInputCard, the bottom button, the
working dialog), `PageGrids.kt` (typedPages, tappedOnto) and the view model's `runSplit`,
`hasUnsavedWork` and `defaultName`. The work itself is `engine/organize.js` (see
`docs/api/organize.md`).

`frame.js` was written for three tools on one PDF. Delete pages and Rotate PDF are now part of
Reorganize PDF, as in the app (see `docs/api/organize-ui-b.md`), so Split PDF is the one tool
that uses it. It still takes the tool as a `spec` (below), and can still ask before a tool's
changes are discarded, though Split PDF never has any.

## What the screen does

As the app's screen for a tool on one PDF:

- **Choose PDF** card (a tap opens the picker; on computers also a drop zone, and a paste target).
  A bar runs while the PDF opens; its password is asked for when it has one (the kit's `openPdf`;
  a PDF handed over with `item.password` from Choose a tool isn't asked again). Leaving the tool
  while the password is asked for takes the question away with it (`openPdf`'s `signal`). A file
  that can't be opened says "Couldn't open that PDF…" and the card stays. Opened with `ctx.files`
  (Choose a tool, Home's drop), the first of them is opened at once.
- The chosen PDF's **card**: first page, name, "12 pages · 619 kB", **Remove** (×), and
  **Choose another PDF** (web extra, `web_choose_another_pdf`). With a PDF open, a PDF dropped or
  pasted anywhere on the screen takes its place. The PDF there stays if the new one can't be
  opened or its password is cancelled. `frame.js` asks "Discard your changes?" (Discard / Keep)
  before each of these when the tool's `unsaved()` says there are changes; Split PDF's never does
  (what is typed isn't work to lose, as the app's `hasUnsavedWork`), so nothing is asked.
- The tool's options, then **File name** with ".pdf" (`Report_split`, from `defaultName`; reset
  for each new PDF).
- The main button at the bottom (**Split PDF**), off without a PDF (and while the tool's
  `ready()` says no: Split PDF's always says yes). While a PDF opens or is made it, the Choose PDF
  card and Choose another PDF are only marked off (`aria-disabled`, shown as off), not `disabled`,
  so the one pressed keeps the keyboard focus and a dialog closing (a password cancelled, Cancel
  pressed) gives it back. Pages typed wrongly are said in a snackbar (no progress, nothing made).
  On screens 840 px and wider the main button ends where the column above it ends: `.onepdf` sets
  the kit's `--ui-column` to `.page--narrow`'s content width (760 px less its 32 px padding each
  side).
- **Working on your PDF…** after 400 ms, with the engine's progress and **Cancel** (cancelling says
  nothing). Problems: the engine's UserError message, else "Couldn't process this PDF…", said once
  the dialog has gone (while it is open the rest of the page is out of a screen reader's reach).
- The focus where a keyboard user expects it: a PDF opened, on its card; nothing opened (a password
  cancelled), back where it was; Back to editing, on the main button (or the back arrow, were the
  main button off); Start over or Remove, on Choose PDF.
- The kit's **result screen** (`showResult`): its history step (`pushStep('result')`) so the
  browser's Back (Android's Back) returns to the tool (`onStep(null)`), as does the back arrow
  ("Back to editing", which takes the step back with `popStep`); the tool shows again as it was.
  The browser's Forward to a result left that way doesn't bring it back: its step goes back again
  (the tool stays). Opened on the result step (a reload there), the tool starts empty and the step
  goes. ZIP named after the file name typed. "The new PDF has no password." when the PDF had one.
  **Start over** goes back to Choose PDF (the result screen asks "Start over?" first while its
  files aren't saved). A PDF pasted on the tool after a result (even after a paste on the result
  screen) still takes the open one's place: the screen's paste zone is made again when the tool
  comes back.
- `hasUnsavedWork()`: while working; on the result, until it is saved; on the tool, what the
  tool's `unsaved()` says (Split PDF: never, its typing doesn't count, as in the app), so leaving
  Split PDF with pages typed asks nothing.

Split PDF's options: "Split PDF" heading; filter chips **Selected pages**, **Custom ranges**,
**Fixed chunks**, **Every page** (a new mode clears what was typed); one field for every mode, as
the app's, its label, hint and keyboard changed with the mode (the kit's `setLabel`, `setHelper`;
numbers for Fixed chunks); it closes for Every page, keeping its words while it closes;
**Combine…** switch (Selected and Custom; on at first, kept for the next PDF); the page picker
(Selected only): a row that scrolls sideways on phones (105 px pages, as the app's), a grid that
scrolls inside on wide screens. A tap adds the page at the end or takes it out (`tapPage`); text
that can't be read is left alone by a tap. Typed pages are framed as typed. The mode and what was
typed belong to the PDF they were chosen in: another PDF starts at Selected pages with nothing
typed.

## The tool module

`split/index.js` exports `mount(ctx)` (the core contract), returning
`{ unmount(), hasUnsavedWork(), onStep(step) }`, and the helpers its picker uses:

**`tappedOnto(text, pageCount)`** → `number[] | null` — the pages `text` names, zero-based, in the
order typed; `[]` for blank text; `null` while it can't be read (PageGrids.kt `tappedOnto`).
```js
tappedOnto('3,1-2', 5)  // [2, 0, 1]
tappedOnto('2-', 5)     // null
```
**`typedPages(text, pageCount)`** → `number[]` — the same, `[]` instead of `null`.

**`tapPage(text, index, pageCount)`** → `string` — the text after a tap on page `index`
(zero-based): added at the end or taken out, others in order, runs as ranges; `text` itself when
it can't be read.
```js
tapPage('3,1', 1, 5)  // '3,1-2'
tapPage('3,1', 2, 5)  // '1'
tapPage('2-', 0, 5)   // '2-'
```

## frame.js (the screen for a tool on one PDF)

**`mountPdfTool(ctx, spec)`** → `Promise<handle>` — mounts the screen.
```js
return mountPdfTool(ctx, {
  id: 'split',                  // the tool's id: defaultName(id, ...) and the class `${id}-screen`
  namespace: 'split',           // locales/en/<namespace>.js, loaded first
  action: 'pdf_split_action',   // the main button's string
  css: new URL('./split.css', import.meta.url),
  build(src, { engine, refresh }) {
    // src: the kit's PdfSource; engine: engine/organize.js; refresh(): re-reads ready()
    return {
      nodes: [/* the options, between the card and the file name */],
      ready: () => true,                 // the main button may be pressed
      unsaved: () => false,              // changes worth asking about
      prepare: () => plan,               // checks the choices; a UserError thrown is shown
      run: (input, plan, fileName, hooks) => engine.splitPdf(input, { groups: plan, fileName }, hooks),
      destroy() {},                      // when the PDF goes
    };
  },
});
```
`input` is `{ name, bytes, password? }`; `run` returns an OutputFile or a list. `build` is called
for each PDF opened, so what it holds starts afresh with the PDF.

**`collapsible(content, { shown = true, cls })`** → element — a section opening downwards and
closing upwards (250 ms, none with reduced motion); closed, it is `hidden` and `inert`.
`el.setShown(b, { animate = true })`, `el.shown`, `el.inner`.

**`updateSelection(grid, shown, next)`** — makes `shown` (the Set given to a `pageGrid` as
`selected`) hold `next` and redraws only the pages that changed, through the kit's
`grid.refresh(indexes)` (no reaching into the grid's tiles). Typing a page more in a 3000-page PDF
redraws two tiles.

**`problemText(error, fallback)`** → string — a UserError's own message, else `t(fallback)`.

## Messages shown (UserError keys and others)

The screen throws nothing; it shows these (keys in `split.js` unless noted):

| key | English | when |
|---|---|---|
| `pdf_pages_format` (common) | Use page numbers such as 1,3-5. | Selected pages |
| `pdf_ranges_format` | Use ranges such as 1-3;5;7-9. | Custom ranges |
| `pdf_pages_range` (common) | Pages must be between 1 and {1}. | a page past the end |
| `pdf_pages_reversed` (common) | Write ranges from low to high, such as 3-8. | "5-3" |
| `pdf_pages_chunk` | Pages per PDF must be between 1 and {1}. | Fixed chunks |
| `pdf_invalid_pages` (common) | Check the page numbers and try again. | anything else wrong with pages |
| `pdf_process_failed` (common) | Couldn't process this PDF. Check the file and free storage. | the engine failed |
| `pdf_import_failed` (common) | Couldn't open that PDF. It may be damaged or unsupported. | the PDF picked can't be opened |
| `pdf_certificate_unsupported` (common) | This PDF is locked with a certificate (digital ID). Usugami can only open PDFs locked with a password. | |
| `web_tool_load_failed` (common) | Couldn't load {1}. Check your internet connection and try again. | the engine couldn't be loaded (offline) |

## Strings

Each key is defined in one file only. `split.js`: `pdf_split_action pdf_selected pdf_selected_hint
pdf_custom pdf_custom_hint pdf_fixed pdf_fixed_hint pdf_fixed_example pdf_every_page
pdf_combine_selected pdf_combine_ranges pdf_ranges_format pdf_pages_chunk`. The strings other
screens show too (the other page errors, `web_choose_another_pdf`, `web_opening_pdf`, the tool's
name, `pick_pdf`, `remove_file`, `result_details`, `page_count`, `pdf_working`,
`tool_discard_title`, `discard`, `keep` and the result screen's) are in common.js, and
`file_name` in kit.js. The test compares every app key of `split.js` with strings.xml when the
Android app's folder is beside this repository (`../pdfer`), and skips that comparison otherwise
(CI).
