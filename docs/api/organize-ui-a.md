# Split PDF, Delete pages and Rotate PDF screens (organize-ui-a)

Files:

| File | What it is |
|---|---|
| `site/app/js/tools/split/index.js`, `split.css` | Split PDF's screen (`#/tool/split`) |
| `site/app/js/tools/delete-pages/index.js`, `delete-pages.css` | Delete pages' screen (`#/tool/delete-pages`) |
| `site/app/js/tools/rotate/index.js`, `rotate.css` | Rotate PDF's screen (`#/tool/rotate`) |
| `site/app/js/tools/split/frame.js`, `frame.css` | The screen the three share (the app's `PdfToolScreen` for one PDF) |
| `site/app/locales/en/split.js`, `delete-pages.js`, `rotate.js` | Their strings |
| `tests/organize-ui-a.test.mjs` | Their tests (`node tests/organize-ui-a.test.mjs`, `--quick`: Chromium only, `--others`: Firefox and WebKit only). Every browser picks PDFs through the real file input (Firefox too) and drops them on the card in other steps. |

Ported from the app's `PdfToolScreen.kt` (SplitOptions, PdfInputCard, the bottom button, the
working dialog), `PageGrids.kt` (DeletePagesOptions, typedPages, tappedOnto), `PdfEditOptions.kt`
(RotateOptions, RotatePageCard, TurnedThumbnail, turnedLabel), `TurnIcon.kt` and the view
model's `runSplit`, `runDeletePages`, `runRotate`, `rotatePage`, `rotateAll`, `resetPages`,
`hasUnsavedWork` and `defaultName`. The work itself is `engine/organize.js` (see
`docs/api/organize.md`).

## What the screens do

All three, as the app's screen for a tool on one PDF:

- **Choose PDF** card (a tap opens the picker; on computers also a drop zone, and a paste target).
  A bar runs while the PDF opens; its password is asked for when it has one (the kit's `openPdf`;
  a PDF handed over with `item.password` from Choose a tool isn't asked again). Leaving the tool
  while the password is asked for takes the question away with it (`openPdf`'s `signal`).
- The chosen PDF's **card**: first page, name, "12 pages · 619 kB", **Remove** (×), and
  **Choose another PDF** (web extra, `web_choose_another_pdf`). With a PDF open, a PDF dropped or
  pasted anywhere on the screen takes its place. Each asks "Discard your changes?" (Discard / Keep)
  first when there are changes (Rotate's turned pages, as the app's `hasUnsavedWork`); the PDF
  there stays if the new one can't be opened or its password is cancelled.
- The tool's options, then **File name** with ".pdf" (`Report_split`, `Report_pages_deleted`,
  `Report_rotated`, from `defaultName`; reset for each new PDF).
- The main button at the bottom (**Split PDF**, **Delete pages**, **Rotate PDF**), off without a
  PDF and until the tool is ready (Delete pages: something typed; Rotate: a page turned). While a
  PDF opens or is made it, the Choose PDF card and Choose another PDF are only marked off
  (`aria-disabled`, shown as off), not `disabled`, so the one pressed keeps the keyboard focus and
  a dialog closing (a password cancelled, Cancel pressed) gives it back. Pages typed wrongly are
  said in a snackbar (no progress, nothing made). On screens 840 px and wider the main button ends
  where the column above it ends: `.onepdf` sets the kit's `--ui-column` to `.page--narrow`'s
  content width (760 px less its 32 px padding each side).
- **Working on your PDF…** after 400 ms, with the engine's progress and **Cancel** (cancelling says
  nothing). Problems: the engine's UserError message, else "Couldn't process this PDF…", said once
  the dialog has gone (while it is open the rest of the page is out of a screen reader's reach).
- The focus where a keyboard user expects it: a PDF opened, on its card; nothing opened (a password
  cancelled), back where it was; Back to editing, on the main button (or the back arrow while the
  main button is off); Start over or Remove, on Choose PDF; Rotate's Reset pages, which turns
  itself off, on Rotate all pages right.
- The kit's **result screen** (`showResult`): its history step (`pushStep('result')`) so the
  browser's Back (Android's Back) returns to the tool (`onStep(null)`), as does the back arrow
  ("Back to editing", which takes the step back with `popStep`); the tool shows again as it was.
  The browser's Forward to a result left that way doesn't bring it back: its step goes back again
  (the tool stays). Opened on the result step (a reload there), the tool starts empty and the step
  goes. ZIP named after the file name typed. "The new PDF has no password." when the PDF had one.
  **Start over** goes back to Choose PDF. A PDF pasted on the tool after a result (even after a
  paste on the result screen) still takes the open one's place: the screen's paste zone is made
  again when the tool comes back.
- `hasUnsavedWork()`: while working; on the result, until it is saved; on the tool, Rotate's
  turned pages (Split's and Delete pages' typing doesn't count, as in the app).

Split PDF: "Split PDF" heading; filter chips **Selected pages**, **Custom ranges**, **Fixed
chunks**, **Every page** (a new mode clears what was typed); one field for every mode, as the
app's, its label, hint and keyboard changed with the mode (the kit's `setLabel`, `setHelper`;
numbers for Fixed chunks); it closes for Every page, keeping its words while it closes; **Combine…** switch
(Selected and Custom; on at first, kept for the next PDF); the page picker (Selected only): a
row that scrolls sideways on phones (105 px pages, as the app's), a grid that scrolls inside on
wide screens. A tap adds the page at the end or takes it out (`tapPage`); text that can't be read
is left alone by a tap. Typed pages are framed as typed.

Delete pages: **Pages to delete** field; "To delete: 4 of 12" (announced); "Keep at least one
page." when every page is marked; a grid of pages (the kit's `selectedStyle: 'delete'`), each
named "Page 3, Marked to delete" / "Page 3, Kept", tapped or toggled with Space/Enter; marks and
text kept in step (`toggleMark`, sorted, runs as ranges). The grid scrolls inside past 480 px.

Rotate PDF: **All pages** with Rotate all pages left/right; "Turn pages one by one, or all at
once."; a card per page with its picture turned (the short way, 250 ms, none with reduced motion;
a sideways page shrinks to fit), "Page 3" and "Turned right" / "Upside down" / "Turned left"
(opening and closing), and Rotate page 3 left/right (a turn is announced); **Reset pages**. The
turn icons aren't mirrored for right-to-left text (TurnIcon.kt). The list scrolls inside past
450 px (two columns on wide screens); pictures are drawn only near the view.

## Tool modules

Each `index.js` exports `mount(ctx)` (the core contract), returning
`{ unmount(), hasUnsavedWork(), onStep(step) }`.

### split/index.js

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

### delete-pages/index.js

**`toggleMark(text, index, pageCount)`** → `string` — the text after a tap on page `index`: marked
or unmarked, sorted, runs as ranges; `text` itself while it can't be read.
```js
toggleMark('2,7', 4, 10)  // '2,5,7'
toggleMark('2,5-7', 5, 10)  // '2,5,7'
```
**`markedPages(text, pageCount)`** → `Set<number>` — the pages marked (none while unreadable).

### rotate/index.js

**`turnedKey(rotation)`** → `'rotated_right' | 'rotated_upside_down' | 'rotated_left' | null` (turnedLabel).

**`nextAngle(angle, rotation)`** → `number` — the running angle a picture shown at `angle` moves
to for `rotation`, the short way: `nextAngle(270, 0)` → `360`, `nextAngle(0, 270)` → `-90`.

**`sidewaysScale(aspect)`** → `number` — how much a page of `aspect` (width/height), fitted
upright in the 55 × 72 box, shrinks to fit lying on its side.

## frame.js (for screens on one PDF)

**`mountPdfTool(ctx, spec)`** → `Promise<handle>` — mounts the shared screen.
```js
return mountPdfTool(ctx, {
  id: 'rotate',                 // the tool's id: defaultName(id, ...) and the class `${id}-screen`
  namespace: 'rotate',          // locales/en/<namespace>.js, loaded first
  action: 'pdf_rotate_action',  // the main button's string
  css: new URL('./rotate.css', import.meta.url),
  build(src, { engine, refresh }) {
    // src: the kit's PdfSource; engine: engine/organize.js; refresh(): re-reads ready()
    return {
      nodes: [/* the options, between the card and the file name */],
      ready: () => true,                 // the main button may be pressed
      unsaved: () => false,              // changes worth asking about
      prepare: () => plan,               // checks the choices; a UserError thrown is shown
      run: (input, plan, fileName, hooks) => engine.rotatePdf(input, { rotations: plan, fileName }, hooks),
      destroy() {},                      // when the PDF goes
    };
  },
});
```
`input` is `{ name, bytes, password? }`; `run` returns an OutputFile or a list.

**`collapsible(content, { shown = true, cls })`** → element — a section opening downwards and
closing upwards (250 ms, none with reduced motion); closed, it is `hidden` and `inert`.
`el.setShown(b, { animate = true })`, `el.shown`, `el.inner`.

**`updateSelection(grid, shown, next)`** — makes `shown` (the Set given to a `pageGrid` as
`selected`) hold `next` and redraws only the pages that changed, through the kit's
`grid.refresh(indexes)` (no reaching into the grid's tiles). Typing a page more in a 3000-page PDF
redraws two tiles.

**`problemText(error, fallback)`** → string — a UserError's own message, else `t(fallback)`.

## Messages shown (UserError keys and others)

The screens throw nothing; they show these (keys in their namespace files unless noted):

| key | English | when |
|---|---|---|
| `pdf_pages_format` | Use page numbers such as 1,3-5. | Split (Selected), Delete pages |
| `pdf_ranges_format` | Use ranges such as 1-3;5;7-9. | Split (Custom) |
| `pdf_pages_range` | Pages must be between 1 and {1}. | a page past the end |
| `pdf_pages_reversed` | Write ranges from low to high, such as 3-8. | "5-3" |
| `pdf_pages_chunk` | Pages per PDF must be between 1 and {1}. | Split (Fixed) |
| `pdf_need_page` | Keep at least one page. | Delete pages, every page marked |
| `pdf_invalid_pages` | Check the page numbers and try again. | anything else wrong with pages |
| `pdf_process_failed` (common) | Couldn't process this PDF. Check the file and free storage. | the engine failed |
| `pdf_import_failed` (common) | Couldn't open that PDF. It may be damaged or unsupported. | the PDF picked can't be opened |
| `pdf_certificate_unsupported` (common) | This PDF is locked with a certificate (digital ID). Usugami can only open PDFs locked with a password. | |
| `web_tool_load_failed` (common) | Couldn't load {1}. Check your internet connection and try again. | the engine couldn't be loaded (offline) |

## Strings

Each key is defined in one file only. `split.js`: `pdf_split_action pdf_selected pdf_selected_hint
pdf_custom pdf_custom_hint pdf_fixed pdf_fixed_hint pdf_fixed_example pdf_every_page
pdf_combine_selected pdf_combine_ranges pdf_ranges_format pdf_pages_chunk`. `delete-pages.js`:
`pdf_delete_pages_action delete_pages_field delete_pages_hint delete_pages_count page_marked_delete
page_kept`. `rotate.js`: `pdf_rotate_action rotate_all rotate_all_left rotate_all_right
rotate_hint`. The strings the organize screens share (the other page errors, `pdf_need_page`,
`rotated_*`, `rotate_page_left/right`, `pdf_reset_pages`, `web_choose_another_pdf`,
`web_opening_pdf`...) are in common.js, with tool names, `pick_pdf`, `remove_file`,
`result_details`, `page_count`, `file_name`, `pdf_page_number`, `pdf_working`,
`tool_discard_title`, `discard`, `keep` and the result screen's. The test compares every app key
with strings.xml when the Android app's folder is beside this repository (`../pdfer`), and skips
that comparison otherwise (CI).
