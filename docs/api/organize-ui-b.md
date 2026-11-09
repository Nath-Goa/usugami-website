# Merge PDF and Reorganize PDF screens (organize-ui-b)

Files: `site/app/js/tools/merge/` (`index.js`, `merge.css`, `page-list.js`, `reorder-list.js`,
`thumbs.js`, `tool-run.js`), `site/app/js/tools/reorganize/` (`index.js`, `reorganize.css`),
`site/app/locales/en/merge.js`, `site/app/locales/en/reorganize.js`. Tests:
`tests/organize-ui-b.test.mjs` (`--quick`: Chromium only; `--review`: Chromium, the reviewers'
findings only; Firefox and WebKit each pick PDFs through the real file input in one tool and drop
them on the card in the other).

Ported from the app's `PdfToolScreen.kt` (MergeInputs, MergePages), `PageGrids.kt`
(ReorganizeOptions, PageActions, ReorganizeTile, BlankPage, AddPagesButton) and the page logic of
`PdfToolsViewModel.kt` (addPdfs, moveInput, sortInputs, removeInput, followFileOrder, movePage,
movePageBy, rotatePage, removePage, resetPages, resetToOriginal, prepareInsert, addBlankPage,
insertBlankPage, beginPageDrag/endPageDrag, undo, hasUnsavedWork, runMerge, runReorganize). The PDFs
are made by `engine/organize.js` (`mergePdfs`, `reorganizePdf`; see docs/api/organize.md).

## The screens

Both are tool modules for the router (`#/tool/merge`, `#/tool/reorganize`):

```js
export async function mount(ctx)   // ctx as in core-contract.md
// → { unmount(), hasUnsavedWork(), onStep(step), state }
```

- The screen shows at once: the engine (`engine/organize.js`, with pdf-lib) loads behind it and is
  waited for only to make the PDF (`web_tool_load_failed` if it can't load, offline); the default
  names come from the light `engine/page-selection.js`.
- `ctx.files` (FileItems) are opened at once, a FileItem's `password` (given on Choose a tool)
  tried first. Merge takes them all; Reorganize the first. Leaving the tool while a password is
  asked for takes the question away with it (`openPdf`'s `signal`); leaving while the PDF is made
  stops the work and takes its progress dialog away at once.
- The content is the screen's `<main data-main>`. On 840 px and wider the main button ends where
  that column ends (the kit's `--ui-column`, the column's content width: 760 px for Merge, the
  page's 1120 px for Reorganize, each less its 32 px padding each side).
- While PDFs open or one is made, the empty card, Add PDFs / Add pages and the main button are only
  marked off (`aria-disabled`, shown as off), not `disabled`: the one pressed keeps the keyboard
  focus, and a dialog closing (a password cancelled, Cancel) gives it back. The focus goes on where
  a keyboard user expects it: Back to editing, to the main button (or the back arrow); Start over,
  the PDF removed or the last PDF removed, to the empty card; Reorganize's last Undo, to the page
  count; Reset pages, to Add pages.
- `hasUnsavedWork()`: while the result shows, whether it isn't saved; otherwise, as the app,
  Merge: the page list differs from every page of the PDFs in order (moving or sorting whole files
  loses nothing); Reorganize: the pages differ from the PDF's own (pages added count).
  True while a PDF is being made.
- The result screen (`core/output.js`) shows over the tool with a history step (`ctx.pushStep('result')`):
  "Back to editing", the browser's Back (Android's Back) or `onStep(null)` bring the tool back as it
  was; Start over empties it. The browser's Forward to a result left that way doesn't bring it back:
  its step goes back again. Opened on the result step (a reload there), the step goes.
- `state` (for tests): Merge `{ inputs: [{ id, name, pageCount }], pages, pageMode, fileName, canUndo }`,
  Reorganize `{ main, extras, pages, chosen, fileName, canUndo }`; `pages` are page-list entries (below).
  Ids are given in order of opening: Merge `f1, f2…`, Reorganize `p1` (the PDF), `p2…` (PDFs added).

**Merge PDF**: "Add PDFs" (several; the empty card, the button, or files dropped or pasted anywhere
on the screen: on the card while none is listed, on the screen once some are, one drop zone at a
time), each password asked for in turn (Cancel leaves that PDF out). Files | Pages switch
("Arrange individual pages"). Files: numbered cards with Move earlier/later and Remove (named after
the file), drag (long press on touch, mouse), Ctrl/⌘ + ↑/↓ from any of a card's buttons, Sort A to Z /
Z to A (case ignored, stable). Pages: Reset pages, the pages as rows (picture turned as it will be,
"1. alpha.pdf, page 3", Rotate right, Remove), moved by drag, Ctrl/⌘ + arrows on a focused row (two
columns from 840 px: ↑/↓ a row, ←/→ a place), Home/End, or the Move earlier/later buttons. Those sit
among the row's buttons, before Rotate, never over the picture or the text (a press there drags,
as the app's whole card is its drag handle): with a mouse their room is kept and they show while
the row is pointed at; on touch screens they are out of sight until the keyboard is in the row
(`:focus-visible`), so a tap or a drag never brings them; screen readers always reach them. One
Tab stop for the rows; arrows move between them. A turn or a removal redraws only the rows it
changes (`reorderList`), so a 3000-page list stays quick. Pages follow the
files' order until pages of different files are mixed. "Add at least two PDFs to merge." with one
PDF; "Keep at least one page." with none. File name `Merged_PDF`, reset when the list empties.

**Reorganize PDF**: "Choose PDF" (or a PDF dropped/pasted). The PDF's card (Remove asks "Discard
your changes?" when there are changes), "3 pages" (said as it changes) and Undo, the hint, the bar
("Tap a page to choose it" / "Page 3" with Move earlier, Move later, Rotate left, Rotate right,
Remove; Remove is off with one page; removing chooses the page now in its place), the page grid
(`core/pagegrid.js` with `selectable: 'single'`, as the app's selectable tiles: a `listbox` of
`option` pages with `aria-selected`, one chosen at a time; tap/Space/Enter chooses, again lets go;
arrows move the focus, long press or mouse drags, Ctrl/⌘ + arrows moves; each move by keyboard or
button is one Undo step, a whole drag one; a turn or a new choice redraws only the pages it
changes, `grid.refresh(indexes)`), Add pages (menu: Pages from a PDF, Blank
page) and Reset pages. Pages from a PDF go after the chosen page (or at the end); a PDF dropped or
pasted on the screen does the same. A blank page takes the size the page before it shows
(`PdfSource.pageSize`, else `shownPageSize`), sideways when that page is turned a quarter in the
list. Undo (button or Ctrl/⌘+Z outside text fields) takes back one change, up to 50. Save PDF is off
until the pages differ from the PDF's own. File name `<name>_reorganized`. On 840 px and wider the
controls sit beside the bar and the grid, which takes the screen's height.

## merge/page-list.js

The page list both screens edit. A page is `{ input, page, rotation }` (`input`: the id of its PDF,
`page` zero-based, `rotation` 0/90/180/270 clockwise on top of the page's own turn) or a blank page
`{ input: BLANK, page: n, rotation, width, height }` (points). Entries are never changed in place.

| export | |
|---|---|
| `BLANK` | `'blank'`, a blank page's `input` |
| `MAX_UNDO` | 50 |
| `pageKey(ref)` → string | `'f1:3'`; tells pages apart whatever their rotation |
| `isBlank(ref)` → boolean | |
| `samePage(a, b)`, `samePages(a, b)` → boolean | equal pages / lists (key, rotation, blank size) |
| `pagesOf(inputs)` → pages | every page of `[{ id, pageCount }]`, in order, unturned |
| `turnedKey(rotation)` → key or null | `'rotated_right'`, `'rotated_upside_down'`, `'rotated_left'` |
| `enginePages(pages)` → list | the `pages` option of `mergePdfs` / `reorganizePdf` |

`new PageList(pages = [])`: `.pages`, `.length`, `.canUndo`, `.onChange(fn)` → unsubscribe (after
every change), `.indexOf(key)`, `.find(key)`, `.set(list)` (no Undo step), `.pushUndo()`,
`.clearUndo()`, `.undo(inputIds?)` → boolean (pages of PDFs not in the Set don't come back),
`.beginDrag()`, `.endDrag()` (a drag that moved nothing leaves no step), `.moveAt(from, to)` /
`.move(key, toKey)` (drag steps, no Undo step), `.moveBy(key, offset)`, `.rotate(key, degrees)`,
`.rotateAll(degrees)`, `.remove(key)`, `.reset(all)` (always a step), `.resetTo(original)` (none
when already there), `.insert(added, afterKey = null, { undoable = true })`,
`.insertBlank(neighbour, width, height)` → the blank page or null, `.dropInput(id)`,
`.followOrder(ids)` → boolean (false once PDFs' pages are mixed).
```js
const list = new PageList(pagesOf([{ id: 'a', pageCount: 3 }]));
list.rotate('a:2', 90);
list.insertBlank(list.find('a:2'), 595, 842);   // 842 × 595: after a page turned a quarter
list.undo();                                     // the blank page goes
await mergePdfs(inputs, { pages: enginePages(list.pages) });
```

## merge/reorder-list.js

`reorderList({ cls?, ariaLabel?, keyOf(item), create(item) → row, onMove(from, to), onMoveStart?, onMoveEnd?(from, to), roving = false, lazy = false })`
→ element (`role=list`). A row is `{ el, handle?, update(item, index, count, active), load?(), unload?(), destroy?() }`;
`handle` is its focusable element (arrows move the focus, Ctrl/⌘ + arrows/Home/End the row; Ctrl
also works from the row's buttons). With `roving`, elements marked `data-rove` are tabbable on the
active row only. With `lazy`, `load()`/`unload()` follow the row coming near the list's visible part.
Drags: long press 450 ms (touch; a quick swipe scrolls), 5 px with a mouse; the list (or the page)
scrolls near its edges; moves are announced (`web_page_moved`). `onMove` returning false refuses.
`update` runs again only when the item, its place, whether it is first or last, or whether it is
the active row changed (a turn: one row; a removal: the rows after it).
Methods: `setItems(items)` (rows kept by key), `moveBy(key, offset)` (as a row's own move buttons:
announced, focus kept, or handed to the row's other move button), `rowOf(key)`, `focusKey(key)`,
`destroy()`, `count`.

## merge/thumbs.js

- `turnedThumb({ width, height })` → `{ el, setRotation(deg), load(draw), unload() }`: a page picture
  in a box, turned the short way round and fitted when sideways; `draw({ signal })` resolves with a canvas.
- `blankPicture(width, height, label, cssWidth, cssHeight = cssWidth·4/3)` → canvas: a blank page of
  that shape, white, `label` ("Blank") in gray.

## merge/tool-run.js

- `problemText(error, fallback = 'pdf_process_failed')` → string: a UserError's text, else the fallback's.
- `runWithProgress(work({ signal, onProgress }), { signal }?)` → result or null: "Working on your
  PDF…" after 400 ms, Cancel; failures said in a snackbar once the dialog has gone (cancelling says
  nothing). The optional `signal` (the tool's leaving) stops the work as Cancel does and closes
  the dialog at once.
- `setOff(el, off)`: marks a control off with `aria-disabled` (merge.css shows it as off), keeping
  its focus; its handler checks for itself.
- `engineLoader(() => import(...))` → `load()`: the same promise each time, tried again after a
  failure (offline).
- `resultScreen(ctx, view, { onStartOver, onBack? })` → `{ show(files, options), onStep(step), showing, isSaved(), destroy() }`.
  `show` pushes the `'result'` step; its back arrow and Start over take it back (`popStep`).
  `onStep(null)` hides the result (and calls `onBack`); either way back, the focus goes to the
  tool's main button (else its back arrow); `onStep('result')` with no result showing
  takes the step back (`popStep`). Made while `ctx.step` is set (a reload on the result step), it
  takes that step back at once.

## Messages shown (no UserError is thrown here)

| key | English | when |
|---|---|---|
| `pdf_import_failed` (`_many`) | Couldn't open that PDF. It may be damaged or unsupported. | a PDF picked can't be opened (several: named, `file_problem`) |
| `pdf_certificate_unsupported` (`_many`) | This PDF is locked with a certificate (digital ID)… | from `openPdf` |
| `pdf_need_two` | Add at least two PDFs to merge. | Merge with one PDF |
| `pdf_need_page` | Keep at least one page. | Merge's page mode with none |
| `pdf_process_failed` | Couldn't process this PDF. Check the file and free storage. | the engine failed |
| `pdf_import_failed` | Couldn't open that PDF. It may be damaged or unsupported. | from the engine |

## Strings

Each key is defined in one file only.
`locales/en/merge.js`: pdf_file_mode, pdf_page_mode, pdf_page_mode_switch, pdf_file_mode_hint,
pdf_page_mode_hint, pdf_sort_az, pdf_sort_za, merge_page_line, pdf_merge_action, pdf_need_two,
web_adding_pdfs ("Adding PDFs…").
`locales/en/reorganize.js`: reorganize_hint, reorganize_choose_page, reorganize_add,
reorganize_add_pdf, reorganize_add_blank, reorganize_blank, reorganize_page_from,
reorganize_page_blank, pdf_reorganize_action, web_adding_pages ("Adding pages…").
Keys and English are strings.xml's (the test checks when the Android app's folder is beside this
repository, `../pdfer`; on CI it skips that comparison and still checks nothing of common.js or
kit.js is redefined). The organize screens' shared strings (pdf_reset_pages, rotate_page_left/right,
remove_page, rotated_*, pdf_need_page, web_tool_load_failed...) are in common.js.
Also used from common.js/kit.js: tool_merge, tool_reorganize, add_pdfs, pick_pdf, move_file_earlier,
move_file_later, remove_file, page_count, result_details, undo, discard, keep, tool_discard_title,
pdf_page_number, move_page_earlier, move_page_later, file_name, web_page_moved, web_reorder_hint.
