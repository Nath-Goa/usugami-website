# Merge PDF and Reorganize PDF screens (organize-ui-b)

Files: `site/app/js/tools/merge/` (`index.js`, `merge.css`, `page-list.js`, `reorder-list.js`,
`thumbs.js`, `tool-run.js`), `site/app/js/tools/reorganize/` (`index.js`, `reorganize.css`),
`site/app/locales/en/merge.js`, `site/app/locales/en/reorganize.js`. Tests:
`tests/organize-ui-b.test.mjs` (`--quick`: Chromium only; Firefox and WebKit each pick PDFs
through the real file input in one tool and drop them on the card in the other).

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

- `ctx.files` (FileItems) are opened at once, a FileItem's `password` (given on Choose a tool)
  tried first. Merge takes them all; Reorganize the first. Leaving the tool while a password is
  asked for takes the question away with it (`openPdf`'s `signal`).
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
on the screen), each password asked for in turn (Cancel leaves that PDF out). Files | Pages switch
("Arrange individual pages"). Files: numbered cards with Move earlier/later and Remove (named after
the file), drag (long press on touch, mouse), Ctrl/⌘ + ↑/↓ from any of a card's buttons, Sort A to Z /
Z to A (case ignored, stable). Pages: Reset pages, the pages as rows (picture turned as it will be,
"1. alpha.pdf, page 3", Rotate right, Remove), moved by drag, Ctrl/⌘ + arrows on a focused row (two
columns from 840 px: ↑/↓ a row, ←/→ a place), Home/End, or the Move earlier/later buttons that show
on a focused or pointed row. One Tab stop for the rows; arrows move between them. Pages follow the
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
- `runWithProgress(work({ signal, onProgress }))` → result or null: "Working on your PDF…" after
  400 ms, Cancel; failures said in a snackbar (cancelling says nothing).
- `resultScreen(ctx, view, { onStartOver, onBack? })` → `{ show(files, options), onStep(step), showing, isSaved(), destroy() }`.
  `show` pushes the `'result'` step; its back arrow and Start over take it back (`popStep`).
  `onStep(null)` hides the result (and calls `onBack`); `onStep('result')` with no result showing
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

`locales/en/merge.js`: pdf_file_mode, pdf_page_mode, pdf_page_mode_switch, pdf_file_mode_hint,
pdf_page_mode_hint, pdf_sort_az, pdf_sort_za, pdf_reset_pages, merge_page_line, rotate_page_right,
remove_page, rotated_right, rotated_left, rotated_upside_down, pdf_merge_action, pdf_need_two,
pdf_need_page, web_adding_pdfs ("Adding PDFs…").
`locales/en/reorganize.js`: reorganize_hint, reorganize_choose_page, reorganize_add,
reorganize_add_pdf, reorganize_add_blank, reorganize_blank, reorganize_page_from,
reorganize_page_blank, pdf_reset_pages, rotate_page_left, rotate_page_right, remove_page,
rotated_right, rotated_left, rotated_upside_down, pdf_reorganize_action, pdf_need_page,
web_adding_pages ("Adding pages…").
Keys and English are strings.xml's (the test checks); the keys both files have carry the same text.
Also used from common.js/kit.js: tool_merge, tool_reorganize, add_pdfs, pick_pdf, move_file_earlier,
move_file_later, remove_file, page_count, result_details, undo, discard, keep, tool_discard_title,
pdf_page_number, move_page_earlier, move_page_later, file_name, web_page_moved, web_reorder_hint.
