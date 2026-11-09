# UI kit API (core/ui.js, files.js, pdfdoc.js, pagegrid.js, output.js, batch.js)

The kit is what tool screens are built from: the Android app's Material 3 components, picking and
opening files, PDF page previews, the page grid, the result screen and the run over several files.
Everything in `docs/api/core-contract.md` is here with the same names; this file adds the options
and functions the contract doesn't list. Styles are in `site/app/css/components.css` (linked by
`index.html`; `ui.js` also makes sure it is loaded). Its strings are in `locales/en/kit.js`, which
the shell loads at start beside `common.js`.

Text passed to a component is already translated (`t()`); components never hard-code English.
Every component returns its element; extra methods are set on it (`el.setValue(v)`, ...).

```js
import { topBar, button, segmented, snackbar } from '../../core/ui.js';
import { pickFiles, fileKind } from '../../core/files.js';
import { openPdf } from '../../core/pdfdoc.js';
import { pageGrid } from '../../core/pagegrid.js';
import { showResult } from '../../core/output.js';
import { batchList, runBatch, BatchChoices } from '../../core/batch.js';
```

---

## core/ui.js

### Buttons and bars

**`button({ label, icon?, variant = 'filled', onClick?, disabled?, type = 'button', tone?, cls?, ariaLabel? })`**
A `<button>`: `variant` `'filled'` (the main action), `'tonal'`, `'outlined'` or `'text'`;
`tone: 'danger'` gives a text button the error colour. 40 px tall, 48 px to tap.
`el.setLabel(text)`.
```js
button({ label: t('add_pdfs'), variant: 'outlined', onClick: addMore })
```

**`iconButton({ icon, label, onClick?, disabled?, selected?, variant = 'standard' | 'tonal' | 'filled', cls? })`**
48 px round button named by `label` (also its tooltip). With `selected` (true/false) it is a toggle
(`aria-pressed`). `el.setSelected(b)`, `el.setLabel(text)`.

**`fab({ label, icon, onClick?, disabled? })`** — extended floating action button. `el.setLabel(text)`.

**`bottomBar(...children)`** — the bar at the bottom of a tool holding its main button, as the app's
`bottomBar`: sticky, the button across the screen on phones, at the end (240 px wide) on desktops.
Snackbars show above it while it is on screen (see `snackbar`); nothing to do for that.
On desktops (840 px and wider) the button ends where the screen's content column ends when the
screen sets the CSS variable **`--ui-column`** to the width of its content, centred in the screen
(on the bar or any ancestor, e.g. `.compress-screen { --ui-column: 600px }`); without it, 32 px from
the window's edge, as before.
A control reached with Tab is scrolled clear of the sticky top and bottom bars (scroll padding on
`<html>` while they are there).
```js
const run = button({ label: t('pdf_split_action'), onClick: split });
ctx.root.append(topBar(...), page, bottomBar(run));
```

**`topBar({ title, subtitle?, onBack?, backLabel?, actions?: [{ icon?, label, onClick, disabled?, selected? }], menu?: items | () => items, backDisabled? })`**
The top app bar: back arrow (named `backLabel`, default "Back"), a one-line `<h1>` title that
shrinks to 16 px before ending in "…", optional subtitle, actions, and an overflow "More options"
menu (`menu` items as for `menu()`). An action with an `icon` is an icon button named by its
`label`; one with a `label` and no `icon` is a text button showing it (class `ui-topbar-text`), as
Recent files' "Clear list" in the app. Takes a tint once the page scrolls under it (one listener
for every bar, which holds none of them: a screen left behind is freed with its bar).
`el.setTitle(text)`, `el.setSubtitle(text|null)`, `el.actions` (the action buttons, in order:
icon buttons or text buttons; both take `.disabled` and `setLabel(text)`), `el.back`.
```js
topBar({ title: t('recent_title'), onBack, actions: [{ label: t('recent_clear'), onClick: confirmClear }] })
```

### Choosing

**`segmented({ options: [{ value, label, icon?, disabled? }], value, onChange?(v), label?, labelledBy? })`**
Segmented buttons sharing the row's width, as the app's (no check mark; labels shrink to fit down
to 8 px). 40 px tall, 48 px to tap (as buttons). A `radiogroup` of `radio` buttons: arrow keys,
Home and End choose. `label` names the group for screen readers (or `labelledBy`, an element id).
`el.setValue(v)` (doesn't call onChange), `el.value`, `el.setDisabled(true|false)` or `el.setDisabled(value, true|false)` for one option.
```js
const levels = segmented({ label: t('compression_title'), value: 1,
  options: [{ value: 0, label: t('compression_less') }, { value: 1, label: t('compression_recommended') }, { value: 2, label: t('compression_extreme') }],
  onChange: (v) => setLevel(v) });
```

**`chips({ options, value, onChange?, label?, labelledBy? })`** — single-choice filter chips (the chosen
one filled with a check mark), wrapping onto more lines 48 px apart (as the app's FlowRow: each
chip's 48 px tap area meets the next row's). Same API as `segmented`.

**`dropdown({ label, options: [{ value, label, short?, icon?, disabled? }], value, onChange?, disabled? })`**
The app's OptionChip: "Page size: A4 ▾" opens a menu of the options, the chosen one checked
(`menuitemradio`). An option's `short` is what the chip shows ("Fit" for "Fit (same as image)").
`el.setValue(v)`, `el.value`, `el.setDisabled(disabled, shownText?)` — turned off, showing
`shownText` as its value meanwhile (the orientation chip says "Same as image" while the size is Fit).

**`switchRow({ label, detail?, checked, onChange?(b), disabled? })`** — a row with a label, a
detail line and a `role=switch` at its end; a tap anywhere on the row flips it.
`el.setChecked(b)`, `el.setDisabled(b)`, `el.setLabel(text)` (the switch is named by it, so its name
changes too), `el.setDetail(text)` (when made with a detail), `el.checked`, `el.switch`.

**`slider({ label, min = 0, max = 100, step = 1, value, onChange?(v), onCommit?(v), format?(v) })`**
A labelled `<input type=range>`, its value shown (and read out) as `format(v)`. `onChange` follows
the thumb, `onCommit` gets the value once let go. `el.setValue(v)`, `el.value`, `el.input`, `el.setDisabled(b)`.

**`textField({ label, value?, suffix?, prefix?, helper?, error?, placeholder?, inputmode?, onInput?(v), onEnter?(v), onChange?(v), type?, autocomplete?, maxLength?, multiline?, rows?, disabled?, spellcheck? })`**
Outlined field with a floating label, as OutlinedTextField: `suffix` ".pdf" after the text,
`helper` under it, or `error` in its place (red, `aria-invalid`, announced politely).
`el.setValue(v)`, `el.setError(text|null)`, `el.setHelper(text)`, `el.setLabel(text)` (the floating
label and the outline's gap for it; the field and what is typed stay), `el.setDisabled(b)`,
`el.focus()`, `el.value`, `el.input`.
```js
const name = textField({ label: t('file_name'), value: defaultPdfName(), suffix: '.pdf', onInput: (v) => (fileName = v) });
```

**`linearProgress({ value = null, label? })`** — 4 px bar; `null` runs without end. `el.setValue(f|null)`.

### Cards and lists

**`card({ icon, title, detail?, onClick?, href?, trailing? })`** — a tool card as on Home; the card
is one button (or link with `href`); `trailing` (a node) sits outside it at the end.

**`fileCard({ name, detail?, thumbnail?: Node | Promise<Node> | null, onRemove?, actions?: Node[], options?: Node, size = 'large' | 'small', placeholderIcon = 'picture_as_pdf' })`**
A picked file (PdfInputCard): thumbnail 58×78 (`'small'`: 44×58) faded in over a placeholder when
the promise resolves (`null` shows none), name on up to two lines, detail, "Remove name" button.
`el.setDetail(text)`, `el.setName(text)`, `el.setThumbnail(node|promise)`, `el.body`, `el.removeButton`.
```js
fileCard({ name: src.name, detail: t('result_details', tp('page_count', src.pageCount), formatSize(src.size)),
  thumbnail: src.thumbnail(0, 58).catch(() => null), onRemove: startOver })
```

**`listItem({ icon?, leading?, title, detail?, trailing?, onClick?, href? })`** — a list row.

**`sectionHeading(text, { level = 2 })`** — a heading over a group (primary colour, 14 px).

### Picking files

**`emptyState({ icon = 'add', title, detail?, actions = [], onClick?, onFiles?, accept?, multiple = true })`**
What a tool shows before it has a file. With `onClick` and no `actions` the whole card is one
button (the app's "Choose PDF" card). With `onFiles(fileItems)` it is also a drop zone (see
`dropZone`), and on computers it says "Or drop files here". `el.detachDrop()`. On desktops it is at
most 640 px wide, centred in whatever column the tool gives it.
```js
emptyState({ icon: 'add', title: t('pick_pdfs'), detail: t('pick_several_hint'),
  onClick: async () => add(await pickFiles({ accept: 'pdf', multiple: true })),
  onFiles: add, accept: 'pdf' })
```

**`dropZone(target, { accept?, multiple = true, onFiles(fileItems), paste = true })`** → `detach()`
Files dropped on `target`, or pasted while it shows (the latest drop zone on screen takes a paste;
not while a text field has the focus or a dialog of another screen is open). Files not matching
`accept` are left out and named in a snackbar (`share_unsupported`); with `multiple: false` only the
first is taken. `target` has the class `is-dragover` while files are dragged over it. A zone inside
another takes the files dropped on it, and the drop still reaches the outer zone, which only lets go
of its highlight. A paste zone is held weakly: a screen left without `detach()` is freed with it.
A zone whose target is off the page for a while (a result screen in its place) is passed over and
takes a paste again once it is back; only `detach()` takes it off the list.
`accept`: a kind (`'pdf'`, `'image'`, `'docx'`, `'pptx'`, `'xlsx'`, `'epub'`), a list of kinds, an
accept string (`'.pdf,image/*'`) or a function of a FileItem.

**`accepts(accept, fileItem)`** → boolean — the test `dropZone` uses.

### Dialogs

All dialogs are modal `<dialog>`s: the page behind is inert, Tab stays inside, Escape and a tap on
the scrim dismiss (unless said otherwise) and the focus returns where it was.

**`alertDialog({ title, message: string | Node, confirm = 'OK', dismiss?, destructive?, describe = true })`** → `Promise<boolean>`
`destructive`: confirm in the error colour, focus starting on the dismiss button. `describe: false`
for a message that is controls (Settings' list of choices): the dialog then has no
`aria-describedby`, which would read the whole list out as its description.
```js
if (await alertDialog({ title: t('tool_discard_title'), message: t('...'), confirm: t('discard'), dismiss: t('cancel'), destructive: true })) leave();
```

**`passwordDialog({ fileName, wrong = false, check?(password): Promise<boolean>, signal? })`** → `Promise<string|null>`
"PDF password", '"name" is protected…', a password field, Cancel and Open PDF (off while empty).
`wrong` shows "That password didn't open the PDF." (typing clears it). With `check`, the dialog
stays open while the password is tried and says so in place when it is wrong; it resolves only
with a password `check` accepted (an error `check` throws rejects the promise). Aborting `signal`
closes it with `null` (and no error), so leaving a screen also takes its question away. `openPdf` uses it.
In a very short window (a phone sideways, 400 % zoom: under 421 px tall) alert, password and
progress dialogs scroll whole instead of squeezing their body, and the password field is scrolled
into view.

**`bottomSheet({ title?, content: Node | Node[], actions?: Node[], onClose?, dismissible = true, cls? })`** → `{ el, dialog, body, close(), closed }`
A sheet up from the bottom on phones (swipe its handle down to close), a dialog in the middle at
840 px and wider. `el` is the surface, `body` the scrolling part, `closed` a promise. When
`dismissible`, the handle is a button named "Close" (`web_sheet_close`) for screen readers on touch
screens, which have no Escape or scrim to tap (Material's drag handle gives TalkBack a dismiss
action); it is out of the Tab order, so the focus still starts on the sheet's first control.

**`progressDialog({ title, cancellable = true, onCancel?, delay = 400 })`** → `{ el, dialog, update(fraction|null, label?, detail?, step?), setStep(text|null), setTitle(text), close() }`
Work under way: a bar (`null` = without end), a line (`label`, announced as it changes), a second
line (`detail`, the file's name) and a third (`step`, the page, slide or chapter being made: "Page 3",
"Slide 2 of 6"; not announced, as it changes too often). `undefined` leaves a line as it is; `null`
or `''` hides it; with no line showing, the lines' block (`.ui-progress-text`) is hidden too, so
the dialog is its bar alone, as the app's for one PDF. The lines are in the dialog's text colour
(the app's AlertDialog onSurfaceVariant). Shows only after `delay` ms, as the app's, but takes no input from the start;
Cancel gets the focus once it shows. Escape doesn't cancel; Cancel turns into "Cancelling…" and
calls `onCancel`. `close()` returns a promise.
```js
const dialog = progressDialog({ title: t('pdf_working'), onCancel: () => controller.abort() });
try { out = await splitPdf(input, opts, { signal: controller.signal, onProgress: (d, n) => dialog.update(d / n) }); }
finally { dialog.close(); }
```

**`menu(anchorEl, items: [{ label, icon?, onClick, disabled?, checked? } | 'divider'], { radio = false })`** → `{ el, close(), dismiss(focusAnchor = false) }`
A popup menu below (or above) the anchor. Arrow keys, Home, End and a letter move through it;
Escape, Tab or a tap outside close it and the focus returns to the anchor (whose `aria-expanded`
it keeps right). `radio`: items are `menuitemradio`, checked ones with a check mark.

**`closeMenu({ focus = false })`** → boolean — closes the open menu, if any (`focus`: back to its
anchor). For the router to call as it leaves a screen, so a menu's items can't act on a screen gone.

**`closeTopOverlay()`** → boolean — what Android's Back closes before it leaves a screen: the open
menu (focus back to its anchor), else the topmost kit dialog or sheet that can be dismissed (as
Escape: alert dialogs, the password dialog, sheets; not the progress dialog). True when something
was closed: for the router to call first on the browser's Back, staying on the screen when it
returns true.

### Messages

**`snackbar(message, { action?, onAction?, duration? })`** → element (`el.dismiss()`, `el.result`: `Promise<'action'|'dismissed'>`)
One at a time at the bottom, the next once it goes (as Compose's SnackbarHost), each said to
screen readers politely. Shown 4 s, longer for a long message (up to 10 s), 10 s with an action;
held while pointed at or focused. Above open dialogs where the browser has popovers.
**Above the bottom bar**, as the app's Scaffold puts its snackbars: while one shows, the kit
measures the `.ui-bottombar` elements (made by `bottomBar()`) that are on screen and reach the
bottom of the window, and lifts it 16 px above the highest (the bar's room for the phone's gesture
bar counted once), following bars that come, go or slide in (checked every 250 ms and on resize).
A long word (a file name without spaces) wraps inside the bar.
Every screen gets this without code of its own. A screen can still lift snackbars further with the
CSS variable `--snackbar-offset` on `<html>` (added to the gesture bar's room); the higher of the
two wins, so screens that set it today keep working. The measured lift is `--ui-snackbar-lift` on
the snackbar host.

**`uid(prefix)`** — a unique id, for labelling one element by another.

---

## core/files.js

A **FileItem** is `{ name, type, size, lastModified, bytes: Uint8Array }`.

**`pickFiles({ accept = 'pdf', multiple = false, capture? })`** → `Promise<FileItem[]>` (empty when cancelled)
The system picker (a hidden `<input type=file>`). Call it straight from a click: it awaits nothing
before opening the picker. `accept`: a kind or an accept string; `capture: 'environment'` opens the
phone's camera app (images). A `cancel` event waits 1.5 s for a `change` that brings files (Firefox,
as Playwright drives it, sends both, cancel first, the change up to half a second later on a busy
page): files that arrive then (or are already on the input) are taken. A real cancel shows nothing
either way. On Android the EPUB picker also offers `application/octet-stream`, as the app's
(`OfficeKind.pickerTypes`: some providers call an EPUB "binary data"; the content decides).
```js
const items = await pickFiles({ accept: 'image', multiple: true });
const photo = await pickFiles({ accept: 'image', capture: 'environment' });
```

**`toFileItems(files, { onUnreadable?(files) })`** → `Promise<FileItem[]>` — reads a FileList or File[];
files that can't be read are left out (and passed to `onUnreadable`). A file without a type gets its
kind's (`application/pdf`, the Word type, `image/heic`, ...). A ZIP among them loads fflate first
(not loaded at start), so its kind is read from its entries.

**`fileItem(name, bytes, type?)`** → FileItem — for bytes made in the app or in tests.

**`fileKind(item)`** → `'pdf' | 'image' | 'docx' | 'pptx' | 'xlsx' | 'epub' | 'other'`
By content first: "%PDF-" in the first 1 KB; images by signature (JPEG, PNG, WebP, GIF, BMP, and
HEIF/AVIF by their ftyp brands, ImageFileType.kt); ZIP files by their `mimetype` entry (EPUB) or
the main part named in `[Content_Types].xml` (Word, PowerPoint, Excel; embedded workbooks don't
count), else by the main part itself. Then by extension, then by MIME type (SharedFiles.kt).
The old binary formats (.doc, .ppt, .xls) count as their kind, as in the app. Before fflate is
loaded (a FileItem not made by `toFileItems`), a ZIP is read from its central directory: the names
of its parts, and `mimetype` and `[Content_Types].xml` when stored uncompressed (an EPUB's
`mimetype` always is); a compressed `[Content_Types].xml` is then skipped, and the main part's
name, the extension and the type decide.

**`kindOfContent(bytes)`**, **`kindOfName(name)`**, **`kindOfType(mime)`** → kind or `null` — the three steps.

**`imageType(bytes)`** → `'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'heif' | 'avif' | null` (ImageFileType.of):
`engine/images/image-type.js`'s `imageFileType` on the first 64 bytes (one port, used by the kit and
Images to PDF alike). A FileItem without a type gets `IMAGE_MIME`'s for its image type.

**`chosenKind(kinds)`** → kind or `null` — the kind files shared together are taken as
(SharedFiles.chosen): the most common, ties going PDF, image, Word, PowerPoint, EPUB, Excel.

**`ACCEPT`** — accept strings per kind: `ACCEPT.pdf`, `.image` (`image/*` first, so phones offer the
gallery, then `engine/images/image-type.js`'s `IMAGE_ACCEPT`: JPEG, PNG, WebP, BMP, GIF, HEIC, HEIF and
AVIF by type and extension), `.docx`, `.pptx`, `.xlsx`, `.epub` (types and extensions, as the app's pickers).
files.js imports only `image-type.js` (no imports of its own) for images, so app start doesn't load
`decode.js` and its ~50 kB of image code. fflate is imported on demand.

---

## core/pdfdoc.js

**`preloadPdfJs()`** → `Promise<{ openPdfJs, pdfjsLib }>` — starts loading pdf.js (about 460 kB)
without waiting for it. pdfdoc.js doesn't import pdf.js until a PDF is opened, so a tool (and
anything importing pdfdoc.js for `reportFileProblems`) shows at once; call this as the tool mounts,
so a PDF picked a moment later opens without waiting for the download. A failed load is tried again
next time (and `openPdf` then throws `pdf_import_failed`).

**`openPdf(fileItem, { ask = true, password?, signal? })`** → `Promise<PdfSource | null>`
Opens the PDF as the app's PdfToolsEngine.inspect and previewView do. When it needs a password:
asks as the app does (a wrong one says so and asks again; the password must open it in pdf-lib
too, as every tool opens it), `null` when cancelled. With `ask: false` it throws `PasswordError`
(`wrong` true when a password was given). `password`, else **`fileItem.password`** (Choose a tool
sets it after asking for a shared PDF's password), is tried first, so the tool doesn't ask again;
when it doesn't open the PDF the dialog asks, saying it was wrong. Aborting `signal` while the
dialog is open closes it and resolves `null`. Throws:
- `UserError('pdf_import_failed')` — "Couldn't open that PDF. It may be damaged or unsupported."
  (not a PDF, empty, too damaged for pdf.js, no pages)
- `UserError('pdf_certificate_unsupported')` — "This PDF is locked with a certificate (digital ID).
  Usugami can only open PDFs locked with a password."
- `CancelledError` when `signal` is aborted (other than during the dialog).

How it opens (so screens agree with what engines cut):
1. pdf.js opens the PDF itself (with the password), in its worker.
2. pdf-lib reads it as the engines do (`engine/pdf-common.js`'s `loadPdf(bytes, { password })`),
   the page tree is mended as they mend it (`engine/cleanup.js`'s `repairPageTree`), and
   **`pageCount` is the number of pages found that way** (what `splitPdf` and the others cut).
3. Usugami's own corner mark is taken off: `loadPdf` does it as it reads (`wasUnmarked(doc)` tells);
   where it doesn't, `engine/page-mark.js`'s `unmark(doc)` does, imported only when the file names
   `/UsugamiMark` at all (skipped if that module or export is missing). The read is done in parts
   (`parseSpeed` 1500, pdf-lib's "Fast"), so a large PDF lets the screen in between.
4. Only when the tree was mended, the mark taken off, or pdf.js counts other pages, the result is
   saved (`savePdf`, no password) and pdf.js shows that copy instead: the **view**. A normal PDF is
   never saved again; it costs one pdf-lib read on top of pdf.js's (on the main thread, after
   pdf.js has opened it in its worker).
   A PDF pdf-lib can't read at all is shown as pdf.js reads it (`pageCount` pdf.js's): the tool
   says what is wrong once it works on it.

A **PdfSource**:
| | |
|---|---|
| `name`, `size`, `bytes`, `item` | the FileItem's; `bytes` are **the PDF as picked**, never the view (engines read them; Compress PDF keeps the original as is); they stay usable (pdf.js got a copy) |
| `password` | the password it opened with, `''` for none (pass it to engines' `loadPdf`) |
| `pageCount` | its pages as the engines find them (damaged page trees mended) |
| `viewBytes` | what the previews show: `bytes` itself, or the view (a copy without the password, Usugami's mark and the page tree's damage) |
| `viewPassword` | the password `viewBytes` opens with: `password`, or `''` for the view |
| `hasView` | whether `viewBytes` is that copy |
| `pdfjs()` | `Promise<PDFDocumentProxy>` of `viewBytes` (open until `close()`) |
| `thumbnail(index, cssWidth, { signal?, maxCssHeight? })` | `Promise<HTMLCanvasElement>`: the page as shown (crop box, its rotation) on white, fitting `cssWidth` × `maxCssHeight` (default 4/3 of the width) CSS px at the screen's density (up to 3×). Cached (48 MB across PDFs), two drawn at a time, the latest asked for first; aborting `signal` drops it (rejects `CancelledError`). Each call gets a canvas of its own (class `ui-page-canvas`). Drawn on a canvas with alpha, filled white first: an opaque canvas makes Chromium smooth text with colour fringes. Once drawn, the page is cleaned up in pdf.js (`page.cleanup()`: its operator list and decoded images, full size for a scanned page, are let go; deferred while another drawing of it runs). |
| `render(index, { cssWidth?, maxCssHeight?, scale?, signal? })` | a larger preview, not cached, ahead of waiting thumbnails; `scale` = pixels per point; the page cleaned up after, as for thumbnails |
| `pageSize(index)` | `Promise<{ width, height, rotation, viewWidth, viewHeight }>` in points: width/height as shown (turned), rotation 0/90/180/270, view* the crop box before turning |
| `close()` | frees pdf.js's copy (through its loading task) and the thumbnails; thumbnails asked for afterwards reject `CancelledError`, `pdfjs()` rejects; calling it again does nothing; `closed` tells |

```js
const src = await openPdf(ctx.files[0]);
if (!src) return; // password cancelled
const sizes = await src.pageSize(0);
card.setThumbnail(src.thumbnail(0, 58));
const out = await splitPdf({ name: src.name, bytes: src.bytes, password: src.password }, opts);
```

**`openPdfs(fileItems, { ask = true, report = true, signal? })`** → `Promise<{ sources, failed: [{ item, error }] }>`
One after another, passwords asked in turn (as the app asks for locked PDFs picked together);
a cancelled password leaves that PDF out quietly. With `report`, failures are named in snackbars.

**`reportFileProblems([{ name, error }], { fallback = 'pdf_import_failed' })`** — PdfToolsViewModel.sayOf:
files with the same problem named together in one snackbar, `"{names}: {text}"` (`file_problem`),
the text worded for one file (the error's key) or several (key + `_many` when there is one). With
more than four, the first three are named and the others counted (`listOfNames`, core/names.js):
"1.pdf, 2.pdf, 3.pdf and 3 more: …". `reportBatchFailures` names files the same way.

pdf.js note: in pdf.js 6 a `PDFDocumentProxy` has no `destroy()`; free one with `doc.loadingTask.destroy()`.
A screen drawing pages itself through `pdfjs()` should call `page.cleanup()` once it has its canvas
(and when it moves to another page), as `thumbnail` does: pdf.js otherwise keeps every drawn page's
decoded images until the PDF is closed.

---

## core/pagegrid.js

**`pageGrid(options)`** → element (`role=list`)
| option | |
|---|---|
| `count` | pages |
| `thumbnail(i, cssWidth, { signal })` | `Promise<Node>` (a canvas or img); asked for only when the page comes within 600 px of the screen, aborted and let go when it is far again |
| `label(i)` | text under the page (default its number) |
| `tileLabel(i)` | its name for screen readers (default "Page 3"); with `reorderable`, described by the hidden hint "To move it, press Ctrl and an arrow key, or drag it." (hidden, so the list holds only its items, and a grid whose pages can't move says nothing of moving them) |
| `selectable`, `selected: Set<number>`, `onToggle(i)` | tapping a page (or Space/Enter) calls `onToggle`; change the set there. `selectable: true`: any number chosen, the grid a `list` of `role=checkbox` pages (`aria-checked`). **`selectable: 'single'`**: one page chosen at a time (Reorganize's): the grid is a `listbox` of `role=option` pages (`aria-selected`), the tiles `role=none`; arrow keys (and Home/End) move the focus, Space or Enter chooses, Ctrl+arrows move the page; keep at most one page in the set (the page chosen before is drawn again too). A listbox holds only its options, so there are no move buttons in this mode (`moveButtons` is ignored). |
| `onActivate(i)` | a tap in a grid that isn't selectable |
| `selectedStyle` | `'primary'` (3 px accent frame, Reorganize) or `'delete'` (error frame, faded, a delete sign: Delete pages) |
| `reorderable`, `onMove(from, to)` | called for each step of a move (as the app moves pages live while dragging); return `false` to refuse |
| `onMoveStart()`, `onMoveEnd(from, to)` | around a drag (for one undo step per drag) |
| `rotation(i)` | degrees clockwise, the picture turned (the short way, animated) and fitted |
| `badge(i)`, `overlay(i)` | a node at the picture's top corner / over the picture, or null; return the same node again to leave it in place (a new node replaces it) |
| `ariaLabel` | the grid's name |
| `moveButtons` (true) | each page's "Move page 3 earlier/later" buttons (shown on hover or focus; always there for screen readers) |

Moving: a long press (450 ms) and drag on touch screens (a quick swipe still scrolls), a drag with
a mouse, Ctrl (⌘) + arrow keys on a focused page (Ctrl+Home/End: first/last), or the move
buttons. Arrow keys alone move the focus. The page dragged near the top or bottom edge scrolls the
grid (or the page). Moves are announced ("Moved to place 5 of 12"). Columns: at least 96 px wide
(128 px from 840 px). Tiles off screen skip layout and painting (`content-visibility: auto`, always
on: switched on and off a tile would be laid out at its placeholder size for a moment), sized as a
tile on screen measures (`--ui-tile-h` on the grid), so a grid of thousands of pages opens without
holding up the screen. What a tile draws beyond itself is drawn by the tile: its focus ring (the
page's own is off) and its lift while dragged (`scale`, shadow). Their icons are parsed once and
copied. Measuring a tile far off screen right after the grid is made gives the placeholder size.

Methods: `el.refresh(indexes?)` (labels, names, selection, rotations, badges and overlays again: of
the pages given, a number or a list/Set of them, or of all when omitted), `el.setCount(n)`
(rebuilds the tiles; thumbnails come from the cache), `el.setSelected(set)`, `el.reload(i?)` (draws
again), `el.focusIndex(i)`, `el.scrollToIndex(i)`, `el.move(from, to)`, `el.destroy()`, `el.count`.
A tile redraw touches only what changed (its icon nodes, such as Delete pages' delete sign, are
made once and kept), so a refresh of thousands of pages where little changed is quick; call
`el.refresh([i, j])` after a tap that changes two pages. Each tile element (`.ui-page-tile`) also
has `.tile.update()`, which redraws that one page.
```js
const grid = pageGrid({ count: pages.length, thumbnail: (i, w, o) => src.thumbnail(pages[i].page, w, o),
  rotation: (i) => pages[i].rotation, reorderable: true, onMove: (a, b) => pages.splice(b, 0, ...pages.splice(a, 1)),
  onMoveStart: () => history.begin(), onMoveEnd: () => history.end() });
```

---

## core/output.js

An **OutputFile** is `{ name, bytes, type }`, optionally with `pageCount` (else counted with pdf.js
for the result screen), `originalSize` and `keptOriginal` (Compress PDF).

**`showResult(root, { files, title?, heading?, message?, details?(file), onStartOver?, onBack?, zipName?, passwordRemoved?, onReady?(files), wording = 'pdf' })`** → element
Empties `root` and shows the app's result screen: "Done" (`title`) with a back arrow named "Back to
editing" (`onBack`; off while saving), a check mark, "Your PDF is ready"/"Your PDFs are ready",
each file with "3 pages · 619 kB" and `details(file)` (else "Compressed from 2.4 MB (62% smaller)"
from `originalSize`, or "Already compact: the original was kept" from `keptOriginal`), `message`
and "The new PDF has no password." (`passwordRemoved`) under the files, then:
- one file: **Open** and **Share**, **Save to Downloads**, **Save as…**
- several: **Share all**, **Save to Downloads**, **Save to folder…**, **Share or save as ZIP**
  (Share ZIP, Save ZIP to Downloads, Save ZIP as…), and each file its own Open, Share and Save
  (Save offers Downloads and Save as…, or downloads at once where there is no Save as picker),
  marked "✓ Saved" once saved.

Share shows only where the browser shares files; Save as… and Save to folder… only where it has
those pickers (`showSaveFilePicker`, `showDirectoryPicker`); without Share, Save to Downloads is the
filled button. Saving says so in a snackbar, worded as the app's view model for the tool does
(`wording`): **`'pdf'`** (the default: every PDF tool, PdfToolsViewModel) "Saved to Downloads" for
Save to Downloads (one PDF or several) and "Saved" for Save to folder…; **`'images'`** (Images to PDF,
MainViewModel) "Saved to Downloads as Report.pdf" / "Saved 3 PDFs to Downloads" and "Saved 3 PDFs to
the folder". In both, Save as… says "Saved" and a file's own Save "Saved to Downloads as Report.pdf".
Failures "Couldn't save the PDF…" / "Couldn't make the ZIP file…". A button pressed is off while its
work runs; the focus comes back to it after (unless it moved elsewhere meanwhile).
"Not saved yet…" shows until every file is saved; **Start over** asks first
until then, then calls `onStartOver`. While unsaved, closing or reloading the tab asks first. The
ZIP file is named `zipName` + ".zip" (made safe; "Usugami.zip" without one) — pass the run's name
("Report_split", "Compressed_PDFs"). The focus starts on the heading. Rows off screen skip layout
(`content-visibility`, always on), for a Split into hundreds of PDFs.
`el.isSaved()` (for `hasUnsavedWork`), `el.destroy()` (also revokes the tabs' object URLs), `el.files`.
The page's listeners (closing the tab while unsaved, the watermark's setting) hold the screen
weakly: one left without `destroy()` is still freed.

**The Usugami watermark** (`docs/api/mark.md` has it all): at the top of the result screen, above
the files and the buttons, the watermark's card (`el.markCard`) when some file is a PDF; the PDFs
show, open, share, save and go in the ZIP with the mark the setting asks for, changing when it
changes. **`el.files`** is a getter of the versions showing now (the files as made, or with the
mark); each row shows, opens, shares and saves its version (a result shown again, the browser's
Forward, shows the marked versions at once). **`onReady(files)`** is called once the PDFs are as the
setting asks, with the versions showing, in order (not if the screen goes first); **`el.ready`** is
a promise of the same.
```js
const result = showResult(ctx.root, { files: outputs, zipName: 'Compressed_PDFs', passwordRemoved: !!src.password,
  onBack: () => renderTool(), onStartOver: () => startOver() });
```

**`download(file, { recent = true })`** → `Promise<void>` — a download under its name; goes on Recent files
unless `recent` is false.
**`openFile(file)`** → boolean — opens it in a new tab (call from a click; a ZIP is downloaded, without
going on Recent files again: opening a file from Recent files leaves the list as it is, as the app's
does); false and a snackbar "Your browser blocked the new tab…" when blocked.
**`share(files)`** → `Promise<boolean>` — Web Share with files; false when the sheet was closed.
Throws `UserError('web_share_failed')` — "Couldn't share from this browser. Save the file instead."
(also with `.notAllowed` when the browser no longer counts the tap).
**`saveAs(file)`** → `Promise<boolean>` — the Save as picker (downloads where there is none); false when cancelled.
**`saveToFolder(files, { earlier? })`** → `Promise<{ dir, names } | null>` — a folder picker; a name taken
gets " (1)"; `earlier` (what a previous call returned) skips files still in that same folder;
downloads each where there is no folder picker; null when cancelled.
**`zipFiles(files, zipName)`** → OutputFile — one ZIP (stored entries, UTF-8 names unique ignoring case,
sizes in the local headers). Throws `UserError('zip_failed')` past 65,535 files or 4 GB.
**`zipFilesAsync(files, zipName, { onProgress?({ files, totalFiles, bytes, totalBytes, fraction }), signal? })`** → `Promise<OutputFile>`
— the same, yielding to the screen; progress counts each byte twice (checksum, copy) as ZipArchive;
`CancelledError` when aborted.
**`entryNames(names)`**, **`zipFileName(name)`**, **`savedPercent(original, now)`** (≥ 1 or null),
**`canShareFiles(files?)`**, **`canSaveAs()`**, **`canSaveToFolder()`**.

Every save (download, Save as, folder, ZIP) goes on Recent files through `core/recent.js`'s `addRecent`
(a failure there is ignored); shares don't.

---

## core/batch.js

**`batchList({ items: [{ id, name, detail?, thumbnail?, icon? }], nameOf(id), onRename(id, name), onRemove(id), onAdd?, addLabel?, choice?, options?(id), suffix = '.pdf', thumbnails = true })`** → element
The app's BatchList: a card per file (thumbnail, name, detail, "Remove name"), then `options(id)`
(a node), then its own `choice` — `{ label, options: [{ value, label }], valueOf(id), onChange(id, v) }`
as segmented buttons under `label` — then "File name" with ".pdf" (`nameOf(id)`, typing calls
`onRename`), named for screen readers after its file, "File name for Report.pdf"
(`web_file_name_for`), as its Remove button is. `onAdd`: an "Add PDFs" button (`addLabel`) after
the list. Two columns on desktops.
`el.setItems(items)` (cards keep what is typed; only cards out of place are moved, so a card being
typed in keeps the focus while PDFs are added or removed around it; the focus of a removed card
moves to the next Remove button), `el.refreshChoices()` (after a choice for all), `el.refreshNames()`,
`el.setAddDisabled(b)`.

**`runBatch(items, work(item, index, { signal, onProgress, onStep }), { title?, report = true, named = {}, fallback = 'pdf_process_failed', delay? })`**
→ `Promise<{ outputs: OutputFile[], failures: [{ item, error }], cancelled }>`
Runs `work` on each item in turn with the progress dialog: "Working on your PDFs…", "PDF 2 of 5"
and the item's `name`, the bar moving with `onProgress(done, total)` or `onProgress(fraction)`.
`onProgress(done, null)`: how many there are isn't known yet (a Word document's pages): the bar
runs without end for one file, and stays at the file's start for several. `onStep(text | null)`
sets the dialog's third line ("Page 3", "Slide 2 of 6", "Chapter 1 of 9"; not announced), cleared as
the next file starts.
A failure doesn't stop the others; once done they are named in snackbars: an error key in `named`
by its plural with the names (`{ page_numbers_all_skipped: 'batch_nothing_to_number' }`), a
`UserError` with `"{names}: {text}"` (same reason together, `key_many` wording for several), others
together with `batch_failed`. Cancel stops it: `{ outputs: [], failures: [], cancelled: true }`.
With one item it works as the tools do for one file: "Working on your PDF…" and the error's own
message (`fallback` for an error that isn't a UserError).
```js
const { outputs, cancelled } = await runBatch(sources, (src, i, hooks) =>
  compressPdf({ name: src.name, bytes: src.bytes, password: src.password }, { level: choices.choiceOf(src.id), name: nameFor(src) }, hooks));
if (outputs.length) showResult(ctx.root, { files: outputs, zipName: 'Compressed_PDFs' });
```

**`reportBatchFailures(failures, { many, named, fallback })`** — the reporting alone.

**`BatchChoices`** (BatchChoices.kt), immutable: `new BatchChoices(files = [{ id, name, choice }], all = 0)`,
`.choiceOf(id)`, `.nameOf(id)` (null: the tool's own), `.common` (null while they differ),
`.following(ids)`, `.withAll(choice)`, `.withChoice(id, choice)`, `.withName(id, name)`,
`.equals(other)`, `.toJSON()`, `BatchChoices.from(json, all)`.
```js
let choices = new BatchChoices([], 1).following(sources.map((s) => s.id));
choices = choices.withAll(2);       // "Compression for all PDFs"
choices = choices.withChoice(id, 0); // one PDF's own level
```

---

## Errors thrown

| key | English | by |
|---|---|---|
| `pdf_import_failed` | Couldn't open that PDF. It may be damaged or unsupported. | `openPdf` |
| `pdf_certificate_unsupported` | This PDF is locked with a certificate (digital ID). Usugami can only open PDFs locked with a password. | `openPdf` |
| `web_share_failed` | Couldn't share from this browser. Save the file instead. | `share` |
| `zip_failed` | Couldn't make the ZIP file. Check that there is enough free storage. | `zipFiles`, `zipFilesAsync` |

Also `PasswordError` (`openPdf` with `ask: false`) and `CancelledError` (aborted signals).

## Strings

`locales/en/kit.js` defines: `option_value`, `file_name`, `pdf_page_number`, `move_page_earlier`,
`move_page_later`, `compressed_from`, `original_kept`, `web_drop_hint`, `web_files_unreadable`,
`web_page_moved`, `web_reorder_hint`, `web_file_name_for`, `web_open_blocked`, `web_share_failed`,
`web_zip_download`, `web_zip_ready`, `web_sheet_close`. Don't redefine them in a tool's namespace. The kit also uses these from
`common.js`: back, cancel, cancelling, ok, open, open_file, share, share_file, share_all, save,
save_file, remove_file, add_pdfs, web_more_options, share_unsupported, pdf_import_failed(_many),
pdf_certificate_unsupported(_many), pdf_password_title, pdf_password_body, pdf_password_hint,
pdf_unlock, pdf_wrong_password, pdf_password_removed, pdf_working(_many), batch_progress,
batch_failed, progress_files, page_count, pdf_process_failed, file_problem, result_*,
save_to_downloads, save_as, save_all_to_folder, zip_*, back_to_editing, start_over*,
not_saved_note, msg_saved*, pdf_saved_downloads, msg_save_failed.

## Styles worth knowing (components.css)

- **Thumbnails on white** in both themes, as the app's PdfThumbnail: `.ui-page-picture` and
  `.ui-file-thumb` use `var(--paper, #ffffff)`. A tool's own page boxes (strips, previews) should
  use the same.
- **Windows contrast themes** (`forced-colors: active`): buttons, chips, segmented buttons, cards,
  the empty state, file cards, result rows and page tiles get real borders in the system colours,
  and what is chosen (a segment, a chip, a toggled icon button, a page, a switch on) is drawn in
  `Highlight`.
- `--ui-column` (the bottom bar on desktops, above), `--ui-tile-h` (set by the page grid).
