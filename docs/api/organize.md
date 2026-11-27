# Organize engines: Split, Merge, Reorganize

Files: `site/app/js/engine/page-selection.js`, `site/app/js/engine/organize.js`,
`site/app/js/engine/cleanup.js`. Tests: `tests/organize.test.mjs`.

Ported from the app's `PdfPageSelection.kt`, `PdfToolsEngine.kt` (split, merge, and reorganize with
its two ways of saving, turnAndRemove and rearrange), `PageCleanup.kt`, `XObjectCleanup.kt`,
`PageLabeling.kt`, `FileNames.kt` and the choices of `PdfToolsViewModel.kt` (runSplit, runMerge,
runReorganize, defaultName, addBlankPage).

Reorganize PDF is also where pages are turned and removed: it took over from Rotate PDF and Delete
pages, as in the app (its commits 640285a6 and 7db36467). Their engines `rotatePdf` and
`deletePages`, `pagesToDelete`, the `'ALL_PAGES'` problem and the names
`defaultName('rotate' | 'delete-pages')` are gone; `reorganizePdf`, below, does their work.

What every engine here does, as the app does:

- Opens its PDFs with `loadPdf(bytes, { password })`; the PDFs it makes have **no password**
  (`passwordRemoved: true` on the result when a PDF it was made from had one: show
  `pdf_password_removed`, "The new PDF has no password.").
- Pages left out (Reorganize, Merge's page mode, the other pages of a Split) are
  **really gone**: their text, pictures only they drew, form fields, comments, bookmarks and tags
  aren't left hidden in the file. Links to them stay but lead nowhere.
- Pages kept keep their bookmarks, links (also those between pages kept), form fields, comments
  and labels (the page numbers viewers show, such as "iv").
- A PDF keeps at least one page.
- Rotation only changes how a page is shown (`/Rotate`, added to the turn the page has, also one it
  inherits from the page tree); its content stays byte for byte.
- Damaged page trees are read the way viewers read them (a page counted once, in order; loops and
  miscounts are mended). Damaged or hostile files fail with a `UserError`, never hang: loops are
  read once, nesting is bounded, a stream inflating past 128 MB is taken for unreadable.
- A file pdf-lib opens but that has nothing to read (no catalog, as in `%PDF-1.4` and nothing more;
  a catalog or page tree that isn't a dictionary; no page tree; a page tree without `/Kids`, whose
  `/Kids` isn't a list or holds no pages, or that only leads back into itself) fails with
  `UserError('pdf_import_failed')` in every engine, never a `TypeError` or `pdf_process_failed`.
  A file without a catalog already fails in `loadPdf` (engine/pdf-common.js), so every engine
  that opens PDFs with it says the same.
- No fontkit: `loadPdf` and `createPdf` register none, as nothing these engines do embeds a font
  with pdf-lib. An engine that does (`doc.embedFont(bytes)`) registers it itself first, as
  engine/ocr/text-layer.js does; the other tools then don't load its 157 kB (gzipped).
- Long work yields to the browser every 30 ms, reports progress and stops on `hooks.signal`. It
  yields with a timer, not core/dom.js's `yieldToUI()`: where the browser has `scheduler.yield()`,
  yielding that often with it kept Chromium from drawing Split's progress on a 3000-page PDF.

## Inputs and outputs

```js
// input (from core/files.js' FileItem or a PdfSource)
{ name: 'Report.pdf', bytes: Uint8Array, password?: 'secret', id?: any }

// hooks
{ onProgress?: (done, total) => void, signal?: AbortSignal }

// OutputFile
{ name: 'Report_split_1_1-3.pdf', bytes: Uint8Array, type: 'application/pdf', pageCount: 3, passwordRemoved?: true }
```

Page numbers passed to engines are **zero-based**; typed text is one-based ("1,3-5").

## page-selection.js

Also `defaultName(tool, input)` and `partSuffix(index, pages)` (see organize.js below), which the
screens import from here, light, before the engine has loaded.

All throw `PageSelectionError` (a `UserError`: show `t(e.key, ...e.args)`), whose `problem` is one of
`'FORMAT' | 'RANGES_FORMAT' | 'OUT_OF_RANGE' | 'REVERSED' | 'CHUNK_SIZE'` and
`pageCount` the PDF's page count. A `pageCount` below 1 throws `UserError('pdf_invalid_pages')`.

### parsePageSelection(text, pageCount) → number[]
Pages typed like "5,1,3-4" in the order typed, each once (Split's "Selected pages", Page numbers'
pages to skip and, through engine/page-choice.js, Reorganize's "Selected pages").
```js
parsePageSelection('5,1,3-4,3', 6)   // [4, 0, 2, 3]
parsePageSelection('7', 6)           // throws: problem 'OUT_OF_RANGE', key 'pdf_pages_range', args [6]
```

### parseRanges(text, pageCount) → number[][]
Split's custom ranges, separated by semicolons. Ranges typed with commas get `'RANGES_FORMAT'`.
```js
parseRanges('1-2;5;3-4', 6)   // [[0, 1], [4], [2, 3]]
parseRanges('1-3,5', 6)       // throws 'RANGES_FORMAT' (pdf_ranges_format)
```

### fixedChunks(pageCount, pagesPerFile) → number[][]
Split's "Fixed chunks". `pagesPerFile` may be the text typed ("5", read like Kotlin's
`toIntOrNull`); anything not from 1 to `pageCount` throws `'CHUNK_SIZE'` (`pdf_pages_chunk`).
```js
fixedChunks(5, 2)     // [[0, 1], [2, 3], [4]]
fixedChunks(3, '4')   // throws 'CHUNK_SIZE', args [3]
```

### formatPages(pages) → string, formatPagesInOrder(pages) → string
Zero-based pages written as people type them. `formatPages` sorts (Reorganize's "Selected pages"
field, written from the pages tapped), `formatPagesInOrder` keeps the order (Split's selection,
where tapping adds at the end).
```js
formatPages([6, 1, 4, 5])               // '2,5-7'
formatPagesInOrder([9, 0, 1, 2, 4])     // '10,1-3,5'
```

## organize.js

### splitGroups(options, pageCount) → number[][]
The parts Split makes for the screen's choices (the view model's `runSplit`). Call it to check the
typed pages before showing progress.
- `mode`: `'selected'`, `'custom'`, `'fixed'` or `'every'` (the app's `SELECTED`, `CUSTOM`,
  `FIXED`, `EVERY_PAGE` are accepted too)
- `pages`: the text typed for 'selected' ("1,3,5-8") or 'custom' ("1-3;5;7-9")
- `pagesPerFile`: for 'fixed', the text typed or a number
- `combine`: for 'selected' and 'custom', one PDF of all the pages (default **true**, as the app's
  switch starts on): "Combine selected pages into one PDF" / "Combine all ranges into one PDF"
```js
splitGroups({ mode: 'selected', pages: '3,1' }, 5)                    // [[2, 0]]
splitGroups({ mode: 'selected', pages: '3,1', combine: false }, 5)    // [[2], [0]]
splitGroups({ mode: 'fixed', pagesPerFile: '2' }, 5)                  // [[0, 1], [2, 3], [4]]
```

### splitPdf(input, options, hooks) → Promise<OutputFile[]>
A PDF of each part. `options` is `splitGroups`' options, or `groups` (zero-based page lists) to
give the parts directly, plus `fileName` (the name typed, no extension; default
`defaultName('split', input)`). One part is named `fileName.pdf`; several get the app's endings
`_<n>_<first>-<last>` (`Report_split_2_4-6.pdf`), a long name cut the same for all, told apart
if two clash. A page may be in a part twice (custom ranges overlapping, combined).

Each part holds only its pages: links between them still work (also links by name), other links
lead nowhere, and the form fields on its pages stay fillable in a form of their own.
```js
const parts = await splitPdf(input, { mode: 'custom', pages: '1-3;4-6', combine: false, fileName: 'Report_split' }, hooks);
// [{ name: 'Report_split_1_1-3.pdf', pageCount: 3, ... }, { name: 'Report_split_2_4-6.pdf', ... }]
```

### mergePdfs(inputs, options, hooks) → Promise<OutputFile>
Joins `inputs` (at least two) in order: their bookmarks (one after the other), links, form fields
(a field whose name another PDF's already has is renamed `name_2`), named places, attachments,
layers, colour profiles, tags and page labels come along; the first PDF's details (title, author)
are kept, with what it lacks from the others.
- `pages` (Merge's page mode, or null for whole PDFs): `[{ input, page, rotation? }]` in the
  merged order. `input` is the `id` of one of `inputs` when they have ids, otherwise its index;
  `page` is zero-based; `rotation` is degrees clockwise added to the page's turn (multiple of 90,
  negative turns left). Pages left out are gone from the file, with their bookmarks and fields.
- `fileName` (default `'Merged_PDF'`).
```js
await mergePdfs([a, b], { fileName: 'Merged_PDF' }, hooks);
await mergePdfs([a, b], { pages: [{ input: 1, page: 0 }, { input: 0, page: 2, rotation: 90 }] }, hooks);
```
Errors: fewer than two inputs `pdf_need_two`; empty `pages` `pdf_need_page`; a PDF whose form is
drawn by XFA alone (dynamic XFA) can't be merged: `pdf_process_failed`, as in the app.

### reorganizePdf(input, plan, extraInputs = [], hooks) → Promise<OutputFile>
Saves `input` with the pages `plan` lists, in order. `plan` is the list itself or
`{ pages, fileName }` (default name `defaultName('reorganize', input)`). Each entry is one of:
- `{ page, rotation? }`: the PDF's own page (also `{ input: null }` or `{ input: input.id }`)
- `{ input, page, rotation? }`: a page of one of `extraInputs` ("Add pages" → "Pages from a PDF";
  `input` is its id when they have ids, otherwise its index)
- `{ blank: true, width, height, rotation? }`: a blank page of that size in points
  ("Add pages" → "Blank page"; see `blankPageAfter`)

`rotation` is degrees clockwise, added to the turn the page has (a multiple of 90; negative turns
left; 0 or left out for a page not turned). Each page may be listed once, and the list is every
page the new PDF has: a page not listed is removed. The PDF's bookmarks, form, tags and details
stay; an added PDF's come along with its pages, as in Merge. The result's `pageCount` is counted
from the PDF saved, as `countPages` counts (the app gives `doc.numberOfPages`); it equals the
list's length.
```js
// Pages moved, a page of another PDF and a blank page added: laid out again.
await reorganizePdf(main, { pages: [{ page: 2, rotation: 90 }, { input: 'x7', page: 0 }, blankPageAfter(size, 0)], fileName: 'Report_reorganized' }, [extra], hooks);
// Page 2 of four removed, page 4 turned left: saved in place.
await reorganizePdf(main, [{ page: 0 }, { page: 2 }, { page: 3, rotation: -90 }]);
```

It saves in one of two ways, as the app's `reorganize` does, and the list alone decides which:

- **In place** (the app's `turnAndRemove`), when the list holds only the PDF's own pages, in the
  order they have in it, each once (some turned, some left out, none moved, none added), and the
  PDF's page tree lists each page once.
  - The page tree is kept as it is, with its nesting and with what pages inherit from it (size,
    crop box, turn, resources).
  - A turned page gets `/Rotate` = its own turn (inherited too) plus `rotation`, modulo 360, and
    nothing else of it changes. A page not turned is not touched at all.
  - Pages left out are taken out of the tree where they stand (`removePages`; a part of the tree
    left without pages stays, empty) and cleaned up (`dropRemovedPages`): their form fields,
    bookmarks, tags and the pictures only they drew go, and links to them stay but lead nowhere.
    Page labels are then written again so that each page kept keeps its own.
  - With no page left out nothing is cleaned up and the labels are not rewritten: `/Rotate`
    entries are all that changes.
- **Laid out again** (the app's `rearrange`), for anything else: a page moved, a page of
  `extraInputs` or a blank page in the list, or a damaged PDF whose page tree lists a page twice
  (taking it out where it stands would take out both).
  - The `extraInputs` the list uses are joined on as Merge joins them.
  - The pages are laid flat under the tree's root in the list's order, each first given the size,
    crop box, turn and resources it inherited (`setPages`).
  - Pages left out are cleaned up the same way, and labels are written again.

Either way a damaged page tree is mended first (`repairPageTree`). Both ways show the same pages;
they differ in how much of the file is left as it was. To turn or remove pages and change nothing
else, list the pages kept in the PDF's own order.

Errors: no page (an empty list, or no list) `pdf_need_page`. A list that can't be used is a
mistake of the caller's, not something the user typed, and fails with `pdf_process_failed`: a
page that isn't in its PDF, a page listed twice, a turn that isn't a multiple of 90, an `input`
that is none of `extraInputs`, a blank page without a size.

### defaultName(tool, input) → string
The name the tool's PDF gets unless another is typed (no extension), as the view model's
`defaultName`: `tool` is `'split' | 'merge' | 'reorganize'` (any other throws), `input`
`{ name, pageCount }` (the first PDF). Defined in page-selection.js (with `partSuffix`), which
loads without pdf-lib, so a screen can show the name before this engine has loaded; organize.js
exports both too.
```js
defaultName('split', { name: 'Report.pdf', pageCount: 12 })   // 'Report_split' (room left for '_12_12-12')
defaultName('merge')                                          // 'Merged_PDF'
defaultName('reorganize', { name: 'Report.pdf' })             // 'Report_reorganized'
```

### partSuffix(index, pages) → string
What Split adds to part `index`'s name: `partSuffix(1, [3, 4, 5])` → `'_2_4-6'`.

### shownPageSize(input, index) → Promise<{ width, height }>
Page `index` as shown (crop box turned by its rotation), in points; A4 if it can't be read.

### blankPageAfter(shown, rotation = 0) → { blank: true, width, height, rotation: 0 }
Reorganize's blank page after a page (the view model's `insertBlankPage`): the size that page
shows (`shownPageSize`, or a blank page's own `width`/`height`), sideways when the user turned that
page a quarter (`rotation`, its turn in the list).
```js
blankPageAfter({ width: 595, height: 842 }, 90)   // { blank: true, width: 842, height: 595, rotation: 0 }
```

### countPages(input) → Promise<number>
The page count as these engines count pages (viewers' way, damaged trees mended). 0 for a page
tree without pages; `UserError('pdf_import_failed')` for a file without a catalog or a page tree.

### fileNames
The app's `FileNames` helpers, for tools that name files alike: `sanitize(input, fallback)`,
`withSuffix(base, suffix, fallback, spare)`, `withSuffixes(base, suffixes, fallback)`,
`unique(base, takenSet)`, `baseName(fileName)`, `uniqueNames(names, fallback)`. The shell's port
(core/names.js's `fileNames`), re-exported: the engines name their files with it too.
```js
fileNames.sanitize(' a/b.pdf ', 'X')   // 'a_b'
fileNames.unique('report', new Set(['Report']))   // 'report (2)'
```

`PageSelectionError` and `checkCancelled` are re-exported for the screens.

## cleanup.js (for other engines)

Lower-level pieces, for engines that also remove or copy pages:

- `catalogOf(doc)` → the document's catalog (a `PDFDict`). pdf-lib opens a file without one
  (`doc.catalog` is then undefined, or a number or list): this throws `UserError('pdf_import_failed')`
  instead. Use it rather than `doc.catalog` on a PDF the user picked.
- `readPages(doc)` → `{ pages: [{ ref, dict }], sound }`: the pages as viewers find them (`[]` for a
  tree without any). Throws `pdf_import_failed` without a catalog or a page tree.
- `repairPageTree(doc)` → `{ pages, changed }`: mends a damaged page tree in place (a page without
  its type, a tree that miscounts or loops is laid out flat). Throws `pdf_import_failed` without
  pages (and, as `readPages`, without a catalog or a page tree).
- `setPages(doc, pages)`: makes `pages` the document's pages, in order, under the root, each first
  given what it inherited (size, crop, turn, resources). A catalog without a proper page tree gets
  one; without a catalog it throws `pdf_import_failed`.
- `removePages(doc, removedPageDicts)`: takes pages out of the page tree where they stand, for a
  sound tree (after `repairPageTree`) that lists each page once: each leaves the `/Kids` that
  lists it, and every part of the tree above it counts that many pages fewer. Nothing else changes
  (the nesting stays, and the pages left still inherit what they inherited); a part of the tree
  left without pages stays, empty. Use it rather than `setPages` when no page moves.
- `dropRemovedPages(doc, removedPageDicts, tick)`: after taking pages out of the tree (with
  `removePages` or `setPages`), cuts what still leads to them (fields, bookmarks, tags, pictures
  only they drew, every other reference). `tick = ticker(signal)`.
- `drawnBy(ctx, page, set)`, `emptyUnused(doc, drawn, keptPageDicts, tick)`,
  `drawnOnly(ctx, page, resources)`, `collect(ctx, start, set)`: XObjectCleanup's helpers.
- `Copier(srcContext, destContext, { redirect, transform })` and `copyPage(copier, page, destRef, parentRef, { resources })`:
  copy objects between PDFs once each, cutting what must stay behind.
- `decodeStream(ctx, stream)` (bounded inflate) and `scanContent(bytes, visit)` (content operators).
- `ticker(signal)`: an async function to await in loops; checks cancelling and yields (a timer)
  every 30 ms.

## UserError keys thrown (put them in the screen's namespace file)

| key | English (strings.xml) | args |
| --- | --- | --- |
| `pdf_pages_format` | Use page numbers such as 1,3-5. | |
| `pdf_ranges_format` | Use ranges such as 1-3;5;7-9. | |
| `pdf_pages_range` | Pages must be between 1 and {1}. | page count |
| `pdf_pages_reversed` | Write ranges from low to high, such as 3-8. | |
| `pdf_pages_chunk` | Pages per PDF must be between 1 and {1}. | page count |
| `pdf_need_page` | Keep at least one page. | |
| `pdf_invalid_pages` | Check the page numbers and try again. | |
| `pdf_need_two` | Add at least two PDFs to merge. | |
| `pdf_process_failed` | Couldn't process this PDF. Check the file and free storage. | |
| `pdf_import_failed` | (pdf-common's key for a file that can't be read as a PDF; the app says `pdf_import_failed`: "Couldn't open that PDF. It may be damaged or unsupported.") | |

Also thrown: `PasswordError` (`wrong` false: ask for the password; true: `pdf_wrong_password`,
"That password didn't open the PDF.") and `CancelledError` (ignore quietly).
