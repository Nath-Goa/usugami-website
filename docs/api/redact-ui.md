# Redact PDF screen (`site/app/js/tools/redact/`)

The screen of Redact PDF (`#/tool/redact`), ported from the app's `ui/RedactOptions.kt` and the redact
parts of `ui/PdfToolScreen.kt` and `ui/PdfToolsViewModel.kt`, built on the redact engine
(`docs/api/redact.md`), the shell (`docs/api/shell.md`) and the kit (`docs/api/kit.md`). Nothing here is
meant to be imported by other screens; this note says what the screen does and what it exposes for
tests.

## Files

| File | What it is |
| --- | --- |
| `index.js` | `mount(ctx)`: the screen, its state (the app's view model for Redact PDF), Find text, the run and the result step. |
| `editor.js` | `createEditor(options)`: the page to mark, its boxes, pointer and keyboard handling, zoom. |
| `strip.js` | `pageStrip(options)`: the pages to choose from (the app's PageStrip). |
| `redact.css` | Its styles, all prefixed `redact-`. |
| `locales/en/redact.js` | Its strings (namespace `redact`). |

## What the screen does

- **Choose PDF** (empty state: tap, or drop or paste a PDF on a computer). A PDF handed over in
  `ctx.files` (shared to the app, Choose a tool, dropped on Home) opens at once, with
  `item.password` when Choose a tool already asked for it; otherwise the kit asks for the password.
  The PDF is opened with the screen's AbortSignal (`openPdf(item, { password, signal })`), so a
  password dialog still open closes when the user leaves. A file that can't be opened says why in a
  snackbar (`pdf_import_failed`, `pdf_certificate_unsupported`). While a PDF opens, Choose PDF is off
  with `aria-disabled` (not `disabled`), so the keyboard focus stays on it and comes back to it when
  the password dialog is cancelled; once the PDF has opened, the PDF's card takes the focus. The
  screen's content is its `<main>` landmark (with `data-main`), where Skip to content goes.
- Then, in the app's order: the PDF's card (X removes it: "Discard your changes?" first while it has
  boxes), the note `redact_note`, **Find text** (search button and Enter; while searching a bar takes
  the hint's place, Redact PDF is off, and a Cancel button takes the search button's place), **Page** (the pages, with a dot under those with boxes;
  only for PDFs of 2 or more pages), **Mark what to hide** (the page drawn as the redacted picture
  will be, its boxes see-through), the hint, the chosen box's buttons (move left/up/down/right,
  narrower/wider, shorter/taller, Delete box; each off once its step would change nothing),
  **Add box** and **Remove all** (asks first), and **File name** (`<name>_redacted`, `.pdf` after
  it). The bottom bar's **Redact PDF** is on while there is a box and nothing is being searched,
  opened or made. Snackbars show above the bottom bar: the kit's snackbar lifts itself over a
  bottom bar showing (the screen no longer sets `--snackbar-offset`).
- **On the page**: dragging draws a box (one smaller than 6 px either way is dropped); dragging a box
  moves it; dragging the chosen box's corner (within 24 px) resizes it; a tap chooses a box (12 px of
  reach around each, the smallest wins) and a tap elsewhere lets it go. Drags don't scroll the screen
  (`touch-action: none` on the page, as the app consumes the touch). A box changed or deleted by
  something else during a drag is left as it is now, as in the app. A box chosen or drawn with the
  pointer takes the focus (so the keyboard can carry on from it) but shows the app's dashed frame;
  the solid focus frame shows once a key is pressed. The frame and handle use the light theme's red
  in both themes, as they sit on the white page.
- **Keyboard**: each box of the page is a button ("Box 1 of 3", pressed when chosen); focusing one
  chooses it. Arrow keys move it a step (`STEP`, 0.5% of the page), Ctrl/⌘ + arrows ten steps, Shift +
  arrows resize it (Right wider, Left narrower, Down taller, Up shorter), Delete or Backspace delete it
  (the focus goes to the next box, which is then chosen, or to Add box), Escape lets it go, Page Up /
  Page Down change the page, + / - / 0 zoom in, out and back to fit. The strip is a radio group (arrow
  keys, Home, End). The Delete box *button* leaves the focus on the page (the box group) with no box
  chosen, so a second quick press deletes nothing more, as in the app.
- **Zoom**: on screens 840 px and wider, Zoom out / 100% / Zoom in / Fit page over the page (steps 1,
  1.25, 1.5, 2, 3, 4 times the fitting size); Ctrl/⌘ + wheel (and a trackpad pinch) zoom around the
  pointer; two fingers zoom and move the page on touch screens (a drag the first finger began is
  dropped). The page is drawn again, sharp, once the zoom settles (at most 16 MP, at most 3× density).
- **Sizes**: on a phone the page is at most 440 px tall (less in landscape: window height − 180, at
  least 240), as in the app; from 840 px the options take a left column (300–380 px) and the page the
  rest, as tall as the window allows (window height − 252, 320–1600 px), staying in view while the
  options scroll. There the box buttons sit in the left column and stay, off while no box is chosen,
  so the page never shifts as boxes are chosen and let go; on phones they open under the page when a
  box is chosen and close (still answering presses as they go) when none is, as in the app.
- **Every button acts on the boxes as they are when pressed**, as the app's view model: two quick
  presses of Delete box delete one box; Delete box and a move together delete only the chosen box;
  two quick presses of Move right move it two steps (RedactQuickTapsDeviceTest).
- **Find text** boxes every match (`findText` + `addFound`): "Found 3 matches and boxed them…", "Nothing
  found…", "Too many matches…"; boxes already there aren't added twice; the first page with matches
  shows unless the page showing has some; the query is kept (as typed) for the redaction, until
  Remove all or the PDF goes. On a touch screen the keyboard is put away first.
- **Redact PDF** runs `redactPdf` with the boxes on the PDF's pages, what was searched, and the name
  typed, in the kit's progress dialog (with Cancel). The dialog has gone before anything else shows
  (while it is up the rest of the screen is inert): a failure's snackbar is then heard by screen
  readers, and the result's heading takes the focus. The result is a step of the screen
  (`ctx.pushStep('result')`): the kit's result screen, with "The new PDF has no password." when the
  PDF had one. Back to editing (or the browser's Back) returns to the boxes, putting the result away
  as the app does; Start over (asking while unsaved) goes back to Choose PDF. A reload on the result
  step takes the step back (the result is gone).
- `hasUnsavedWork()` is true while there are boxes, or while the result showing isn't saved.

## Handle

`mount(ctx)` returns `{ unmount(), hasUnsavedWork(), onStep(step), redact }`. `redact` is for tests
and checking from the console (`(await import('./js/core/router.js')).currentHandle().redact`):

| Member | What it does |
| --- | --- |
| `state()` | A copy of `{ boxes, page, selected, searched, finding, processing, fileName, pageCount }` (boxes as the engine's `{ page, left, top, right, bottom }`). |
| `addBox(box)` | As the app's `addRedactBox`: clamped, chosen; `false` and "Usugami keeps up to 2000 boxes." past `MAX_BOXES`. |
| `showPage(i)` | Shows page `i` (cut to the PDF), letting the chosen box go. |
| `selectBox(i)` | Chooses box `i` (−1: none). |
| `clearBoxes()` | Removes every box and what was searched (as Remove all once confirmed). |
| `ready()` | Whether the page showing has been drawn (boxes can be drawn and added). |
| `result()` | The OutputFile of the result showing, or null. |
| `zoom()`, `setZoom(z)` | The page's zoom (1 = fitting). |

```js
const r = (await import('./js/core/router.js')).currentHandle().redact;
r.addBox({ page: 0, left: 0.15, top: 0.84, right: 0.55, bottom: 0.92 });
r.state().boxes.length; // 1
```

## Internal modules

`createEditor({ engine, state, onSelect, onAdd, onChange, onKeyStep, onKeyDelete, onPage, onReady, describedBy })`
→ `{ el, zoomBar, setPdf(pdf), showPage(i), update(), relayout(), isReady(), frame(), focusBox(i), focusFallback(), hasFocus(), zoom(), setZoom(z), destroy() }`.
It keeps no boxes: it reads `state()` (`{ boxes, page, selected }`) and reports what was done.

`pageStrip({ source, count, selected, labelledBy, markedId, onSelect })` → element with
`setSelected(i, { scroll })`, `setMarked(Set)`, `destroy()`. Pictures are drawn only near the pages in
view and let go once far away.

## Strings (`locales/en/redact.js`)

From strings.xml: `pdf_redact_action redact_note redact_find redact_find_hint redact_find_action
redact_find_none redact_find_too_many redact_too_many redact_find_failed redact_found redact_page
redact_page_marked redact_mark redact_mark_hint redact_page_failed redact_preview_description
redact_box_chosen redact_add_box redact_remove_all redact_remove_all_title redact_remove_all_body
redact_move_left redact_move_up redact_move_down redact_move_right redact_width redact_height
redact_narrower redact_wider redact_shorter redact_taller redact_delete_box`.
Web only: `web_redact_box` ("Box {1} of {2}"), `web_redact_keys_hint`, `web_redact_zoom`,
`web_redact_zoom_in`, `web_redact_zoom_out`, `web_redact_zoom_fit` (the zoom level is a percentage in
the language's own format, from `formatNumber`).
Also used from common.js and kit.js: `tool_redact pick_pdf remove_file result_details page_count
tool_discard_title discard keep cancel pdf_working pdf_process_failed pdf_import_failed
web_tool_load_failed file_name pdf_page_number`.

## Errors shown

The screen throws nothing. It shows, in snackbars: the engine's `UserError`s (`redact_find_failed`
"Couldn't search this PDF.", `redact_page_failed` "This page can't be shown, so it can't be
redacted.", `pdf_import_failed`), `pdf_process_failed` for anything else while redacting, the kit's
`openPdf` errors, `redact_find_none`, `redact_find_too_many`, `redact_too_many`, and `redact_found`.
A page the browser can't draw says `redact_page_failed` on the page itself, and Add box is off there.

## Differences from the app

- The app draws the preview with Android's renderer from a copy with annotations flattened; here
  pdf.js draws it (`renderPreview`), exactly as the engine draws the redacted picture.
- Boxes, the page and the chosen box don't survive a reload (the PDF itself doesn't either); leaving
  or reloading with boxes asks first.
- Added on the web: the keyboard (box buttons, arrows, Delete, Page Up/Down), zoom (buttons, Ctrl and
  the wheel, two fingers), the side-by-side layout on wide screens, and drop or paste of a PDF.
- The app's "Choose next box" screen-reader action is Tab here: every box is a button
  (`redact_next_box` isn't used).
- Find text and Redact show how far they have got (the app's bars run without end), and a search
  can be stopped (Cancel in place of the search button; the app has no way to stop one).
- On wide screens the box buttons stay beside the page, off while no box is chosen, instead of
  opening and closing under it.
- In the dark theme the chosen box's frame and handle are the light theme's red, not the dark
  theme's pale red, which hardly shows on the white page.

## Tests

`node tests/redact-ui.test.mjs` (`--quick`: Chromium only, no screenshots): the strings against
strings.xml; the screen before and after choosing a PDF; drawing by touch (real touch events), slips,
taps, reach and Add box; drawing with the mouse on turned and cropped pages, moving and resizing by
dragging, stopping at the edge; the box buttons and the keyboard; the app's quick-tap cases (and a
real double tap and double click on Delete box); Find text (capitals, accents, repeats, another page,
nothing found, Remove all, 2000 boxes); redacting and checking the PDF (pdf.js text, pixels under
and beside the boxes, rotation and crop kept, the untouched page's text); the result step, Back,
Start over, leaving and removing; damaged and dropped files and a password-protected PDF; leaving
while its password is asked for (the dialog closes) and a reload on the result step; zoom
(buttons, Ctrl+wheel, keys, two fingers); a 60-page PDF's lazy strip; 320 px; a run in Firefox
(dropping the PDF) and WebKit; screenshots in `tests/output/redact-ui-*.png`.
