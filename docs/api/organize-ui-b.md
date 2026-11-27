# Merge PDF and Reorganize PDF screens (organize-ui-b)

Files: `site/app/js/tools/merge/` (`index.js`, `merge.css`, `page-list.js`, `reorder-list.js`,
`thumbs.js`, `tool-run.js`), `site/app/js/tools/reorganize/` (`index.js`, `reorganize.css`),
`site/app/js/engine/page-choice.js` (Reorganize's selected pages), `site/app/locales/en/merge.js`,
`site/app/locales/en/reorganize.js`. Tests: `tests/organize-ui-b.test.mjs` (`--quick`: Chromium
only; `--review`: Chromium, the reviewers' findings only; Firefox and WebKit each pick PDFs through
the real file input in one tool and drop them on the card in the other). It starts with tests that
need no browser: the strings, the page list, and `page-choice.js`.

Ported from the app's `PdfToolScreen.kt` (MergeInputs, MergePages), `PageGrids.kt`
(ReorganizeOptions, PageActions, ReorganizeTile, BlankPage, AddPagesButton), `ChosenPages.kt`,
`core/PageChoice.kt`, `PdfPageSelection.read` and `problem`, and the page logic of
`PdfToolsViewModel.kt` (addPdfs, moveInput, sortInputs, removeInput, followFileOrder, movePage,
movePageBy, rotatePage, removePage, choosePages, toggleChosenPage, rotateChosen, removeChosen,
pagesProblem, resetPages, resetToOriginal, prepareInsert, addBlankPage, insertBlankPage,
beginPageDrag/endPageDrag, undo, hasUnsavedWork, runMerge, runReorganize). The PDFs are made by
`engine/organize.js` (`mergePdfs`, `reorganizePdf`; see docs/api/organize.md).

Reorganize PDF is the app's as it is since 13 November 2026 (its commits 640285a6 and 7db36467),
when it took over from Rotate PDF and Delete pages: several pages are selected, turned and removed
at once. Only what it does and says is the app's; how it looks is the web app's own.

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
  count; Reset pages, to Add pages; Reorganize's Remove (see below), to a page in the grid.
- `hasUnsavedWork()`: while the result shows, whether it isn't saved; otherwise, as the app,
  Merge: the page list differs from every page of the PDFs in order (moving or sorting whole files
  loses nothing); Reorganize: the pages differ from the PDF's own (pages added count; pages that
  are only selected don't). True while a PDF is being made.
- The result screen (`core/output.js`) shows over the tool with a history step (`ctx.pushStep('result')`):
  "Back to editing", the browser's Back (Android's Back) or `onStep(null)` bring the tool back as it
  was; Start over empties it. The browser's Forward to a result left that way doesn't bring it back:
  its step goes back again. Opened on the result step (a reload there), the step goes.
- `state` (for tests): Merge `{ inputs: [{ id, name, pageCount }], pages, pageMode, fileName, canUndo }`,
  Reorganize `{ main, extras, pages, chosen, fileName, canUndo }`; `pages` are page-list entries (below),
  `chosen` the keys of the selected pages, in the pages' order (`['p1:1', 'p1:4']`; empty for none).
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

**Reorganize PDF**: "Choose PDF" (or a PDF dropped or pasted). Then, from top to bottom as in
the app:

1. The PDF's card. Remove asks "Discard your changes?" when the pages differ from the PDF's own.
2. A row: "3 pages" (the list's count now, said as it changes), **Select all** (which is **Select
   none** while every page is selected) and Undo.
3. The **Selected pages** field (the kit's `textField`), with "For example: 2,5-7. Or tap the pages
   below." under it, or what is wrong in its place, and a cross ("Clear the selected pages") at its
   end while it holds text (spaces count).
4. The bar, directly above the pages.
5. The page grid (`core/pagegrid.js`, `selectable: true`, `reorderable`, no move buttons), which
   scrolls inside itself (480 px tall at most on a phone).
6. "Long-press a page and drag to move it. Pages you add go after the last selected page."
7. **Add pages** (menu: Pages from a PDF, Blank page) and **Reset pages**.
8. The file name, `<name>_reorganized`, and Save PDF in the bar at the foot of the screen.

On 840 px and wider the bar, the grid and its hint stand beside the rest, and the grid takes the
screen's height.

*The selection* is a set of page keys (`pageKey`), so it follows the pages wherever they go. After
every change to the page list the pages no longer in it leave the selection, and nothing is ever
added to it: pages that Undo or Reset pages bring back are not selected again, and Reset pages
doesn't let go of the pages that stay. A successful Remove therefore leaves nothing selected.
Start over, the PDF's Remove and another PDF chosen empty it.

- *A tap* on a page (or Space or Enter on it) puts it into the selection or takes it out. Each page
  is a check box (`role=checkbox`, `aria-checked`) named "Page 3", "Page 3, from Other.pdf" or
  "Page 3, blank", then ", Turned right" and so on. A selected page has the grid's frame and a
  check mark in its picture's top corner at the end of the line (the grid's `badge`, shown by
  `reorganize.css`; for the eye only).
- While what is typed can't be read, a tap selects nothing, leaves the text as it is, and shows why.
- *Typing* makes the pages named the selection on every change: none while the text can't be read
  ("2," selects nothing, "2,5-7" four pages). The grammar is the app's (`engine/page-choice.js`).
- *The field shows* what was typed while that names exactly the selected pages (in any order), or
  can't be read with nothing selected; otherwise the selection as ranges ("2,5-7"). What was typed
  is forgotten whenever the page count changes, as its numbers name other pages then.
- *Select all / Select none* and *the cross* forget what was typed and what was wrong.

*The bar* is always there and as tall whatever it shows, so the grid never moves under a finger
that taps a page. Its text is a polite live region:

| selected | text | buttons |
|---|---|---|
| none | "Tap pages to select them" | none |
| one | "Page 3" (its place now) | Move page 3 earlier, Move page 3 later, Rotate page 3 left, Rotate page 3 right, Remove page 3 |
| several | "Selected: 3 of 12" | Rotate the selected pages left, Rotate the selected pages right, Remove 3 pages |

Each press is one Undo step for all the selected pages (`PageList.rotateKeys`, `removeKeys`,
`grid.move`). Move earlier is off for the first page and Move later for the last. **Remove is
always on**: when it would leave no page (every page selected, or the only page) it removes
nothing, and "Keep at least one page." shows under the field until not every page is selected.

*What is wrong* shows in one place, under the field instead of its hint, with the field marked
(`aria-invalid`; the line is the field's description and a polite live region). Typed pages that
can't be used come first: "Use page numbers such as 1,3-5.", "Pages must be between 1 and 12."
(the list's count now), "Write ranges from low to high, such as 3-8." They are explained only once
typing is done: Enter (a phone's Done, which also puts its keyboard away; with a real keyboard the
focus stays in the field), the field losing the focus to something else on the screen (another
window or tab looked at doesn't count), or a page tapped. Typing on hides them again.

*Adding pages*: pages from a PDF (the menu, or a PDF dropped or pasted on the screen) and a blank
page go after the selected page that comes **last** in the list, else at the end, and are not
selected, so adding again puts pages after the same page. For "Pages from a PDF" that page is the
one selected when the PDF is asked for. A blank page takes the size the page before it shows
(`PdfSource.pageSize`, else `shownPageSize`), sideways when that page is turned a quarter in the list.

*Moving*: with the bar's buttons (one page selected), by a drag (a long press on touch screens, any
page, selected or not) and with Ctrl/⌘ + arrows, Home or End on a focused page. Each button or
keyboard move is one Undo step, a whole drag one. Moves are announced (`web_page_moved`).

*Scrolling into sight* (the app's rule): only while exactly one page is selected, only if no part
of it shows in the grid, never during a drag, and only when that page is still the one selected but
its place changed (the bar's buttons, Undo, Reset pages), or when the selection was last typed. A
page left selected alone by taps is never gone to. The screen scrolls the grid itself and never the
window (not `grid.scrollToIndex`, whose `scrollIntoView` would take the field being typed in off a
phone's screen), until the page's row is the first that shows, as the app's `animateScrollToItem`:
right under the bar and the field. (By the least that shows the page, it would stop at the grid's
foot, which in one column lies under Save PDF or below the screen.) "In the grid" is the grid's own
box, as in the app, whatever the screen shows of it. So in one column two cases are left as the app
has them: a page of which a part shows only in the grid's foot under Save PDF is not gone to, and a
page of the last rows stops at the grid's foot, as the grid can scroll no further.

*Undo* (button, or Ctrl/⌘+Z outside text fields) takes back one change to the page list, up to 50;
the selection is no part of it. Save PDF and Reset pages are off until the pages differ from the
PDF's own.

Decisions the app gave no rule for:

- **The focus after Remove.** The bar's buttons go with the selection. If one of them had the focus,
  it goes to the page now in the place of the first page removed (the last page if there is none);
  the page count, a live region, says what is left. That page is shown as the grid shows a page its
  arrow keys go to (`scrollIntoView({ block: 'nearest' })`): the grid scrolls by the least, and so
  does the window, which may move here as no field is being typed in. In one column the grid alone
  would leave the focus under Save PDF. The pages keep 4 px clear of the grid's edge
  (`scroll-margin-block` in `reorganize.css`), the room of the focus outline. The same hand-over
  takes the focus to a page when the selected page goes with an Undo while one of its buttons has
  the focus, and to the buttons left when the two move buttons go.
- **The cross** doesn't take the focus when pressed with a mouse or a finger (the field would count
  as left, and a phone's keyboard would close); pressed from the keyboard, it hands the focus to
  the field it emptied.
- **The line under the field** keeps the room of the tallest text it can show: every one of them
  lies unseen in the same grid cell (`.reorganize-room`), so the bar and the grid stay where they
  are when the hint and what is wrong swap.
- **The narrowest phones** (the pages' pane under 320 px): beside the five buttons of one selected
  page the bar's text is left to screen readers (`.reorganize-bar.is-one`); with several pages
  selected there are three buttons and the text stays, on two lines if need be.
- No vibration when Remove is refused (the app gives one): the web app has no haptics of its own
  beyond the grid's.

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
`.rotateAll(degrees)`, `.rotateKeys(keys, degrees)` → boolean (the pages whose keys are in the Set,
as one step; false and no step when none of them is in the list), `.remove(key)`,
`.removeKeys(keys)` → boolean (as one step; **false, changing nothing, when no page would be
left**; true and no step with no keys, or none of them in the list), `.reset(all)` (always a step),
`.resetTo(original)` (none when already there), `.insert(added, afterKey = null, { undoable = true })`,
`.insertBlank(neighbour, width, height)` → the blank page or null, `.dropInput(id)`,
`.followOrder(ids)` → boolean (false once PDFs' pages are mixed).
```js
const list = new PageList(pagesOf([{ id: 'a', pageCount: 3 }]));
list.rotate('a:2', 90);
list.insertBlank(list.find('a:2'), 595, 842);   // 842 × 595: after a page turned a quarter
list.undo();                                     // the blank page goes
await mergePdfs(inputs, { pages: enginePages(list.pages) });
```

## engine/page-choice.js

Reorganize PDF's selected pages, without a screen (the app's `core/PageChoice.kt`, with
`PdfPageSelection.read` and `problem`). Pages are known by keys; what is typed and read are their
places in the list as it is now, counted from 1 in text and from 0 in code. It reads text with
`engine/page-selection.js`' `parsePageSelection`, which accepts and refuses what the app's
`PdfPageSelection` does in its unit tests (the cases are in `tests/organize-ui-b.test.mjs`). One
difference from a phone is known: there the app's regular expression is Android's, which also
takes the digits and spaces of other scripts; here, as in Split PDF's field, only 0 to 9 are digits.

| export | |
|---|---|
| `readPages(text, pageCount)` → `number[]` or `null` | the pages typed, zero-based, in the order typed, each once; `[]` when the text is blank (Kotlin's `isBlank`); `null` while it can't be read, and for a PDF without pages |
| `pagesProblem(text, pageCount)` → `{ key, args }` or `null` | why it can't be read, for `t(key, ...args)`: `pdf_pages_format`, `pdf_pages_range` (`args: [pageCount]`) or `pdf_pages_reversed`; `null` when blank or readable, and for a PDF without pages |
| `places(order, chosen)` → `number[]` | the places, going up, of the keys of `order` that are in the Set `chosen` |
| `following(order, chosen)` → Set | `chosen` without the keys no longer in `order`; `chosen` itself when all still are |
| `fieldText(typed, places, pageCount)` → string | what the field shows: `typed` while it names just those places or can't be read with none selected, else the places as ranges |
| `pack(order, chosen)` → string, `unpack(text, order)` → Set | the selection as ranges ("1,3-5,9") and back, as the app keeps it across a restart; the screen doesn't use them |

The grammar: parts separated by commas, each a number or `low-high`, with spaces (space, tab, line
feed and the like, not a no-break space) allowed round numbers and the dash. An empty part ("1,,2",
"2,"), a semicolon, letters, "1-2-3" and "-3" are the format's problem. 0, a number above the
count, a range that leaves it and a number too long for an Int are out of range. A range backwards
is "reversed" only when it starts on a page of the PDF ("8-3" of 12 pages; of 6 pages it is out of
range). "3-3" is page 3; zeros in front are fine; a page named twice counts once. The first part
that is wrong, from the left, decides what is said.

```js
readPages('5,1,3-4,3', 6);            // [4, 0, 2, 3]
readPages('2,', 6);                   // null
pagesProblem('7', 6);                 // { key: 'pdf_pages_range', args: [6] }
fieldText('5,1', [0, 4], 6);          // '5,1'
fieldText('9', [1], 6);               // '2'
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
| `pdf_need_page` | Keep at least one page. | Merge's page mode with none; Reorganize's Remove with every page selected |
| `pdf_pages_format` | Use page numbers such as 1,3-5. | Reorganize's field, once typing is done |
| `pdf_pages_range` | Pages must be between 1 and {1}. | the same |
| `pdf_pages_reversed` | Write ranges from low to high, such as 3-8. | the same |
| `pdf_process_failed` | Couldn't process this PDF. Check the file and free storage. | the engine failed |
| `pdf_import_failed` | Couldn't open that PDF. It may be damaged or unsupported. | from the engine |

## Strings

Each key is defined in one file only.
`locales/en/merge.js`: pdf_file_mode, pdf_page_mode, pdf_page_mode_switch, pdf_file_mode_hint,
pdf_page_mode_hint, pdf_sort_az, pdf_sort_za, merge_page_line, pdf_merge_action, pdf_need_two,
web_adding_pdfs ("Adding PDFs…").
`merge_page_line` has the app's no-break space between "page" and its number, written
`\u00a0` so it is seen in the source.
`locales/en/reorganize.js`: reorganize_pages_hint, pdf_reorganize_action, reorganize_add,
reorganize_add_pdf, reorganize_add_blank, reorganize_blank, reorganize_page_from,
reorganize_page_blank, reorganize_select_all, reorganize_select_none, reorganize_pages_field,
reorganize_pages_clear, reorganize_tap_pages, reorganize_selected_count, reorganize_move_hint,
rotate_selected_left, rotate_selected_right, remove_selected_pages (a plural),
web_adding_pages ("Adding pages…"). `reorganize_hint` and `reorganize_choose_page` went with the
app's.
Keys and English are strings.xml's. The test checks it when the Android app's folder is beside this
repository (`../pdfer`), reading strings.xml with `tools/import-strings.mjs`' `parseStringsXml`, so
plurals and escapes are compared as the app shows them; on CI it skips that comparison and still
checks nothing of common.js or kit.js is redefined. The organize screens' shared strings
(pdf_reset_pages, rotate_page_left/right, remove_page, rotated_*, pdf_need_page, pdf_pages_format,
pdf_pages_range, pdf_pages_reversed, web_tool_load_failed...) are in common.js.
Also used from common.js/kit.js: tool_merge, tool_reorganize, add_pdfs, pick_pdf, move_file_earlier,
move_file_later, remove_file, page_count, result_details, undo, discard, keep, tool_discard_title,
pdf_page_number, move_page_earlier, move_page_later, file_name, web_page_moved, web_reorder_hint.
