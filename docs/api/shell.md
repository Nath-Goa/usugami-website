# App shell API (`site/app/`)

The shell starts the web app, moves between screens, holds the shared strings, settings, icons,
Recent files and file names, receives files shared to the installed app, and draws Home, Recent
files, Settings (Language, Appearance), About, Open-source licenses and Choose a tool. It
implements what `docs/api/core-contract.md` gives it, plus the extras below (marked *extra*).

The shell throws no `UserError`s. It defines `pdf_import_failed` (thrown by
`engine/pdf-common.js`) in `locales/en/common.js`:
`pdf_import_failed`: "Couldn't open that PDF. It may be damaged or unsupported."

## Files

| File | What it is |
|---|---|
| `index.html` | The page: a Content-Security-Policy `<meta>` first (only this site, `blob:`/`data:` for images, fonts, workers and fetches, `'wasm-unsafe-eval'` for pdf.js, libheif and Tesseract, `'unsafe-inline'` styles for the kit's style attributes, the inline script by its hash: `node tools/check-site.mjs` prints the new hash when it changes), `referrer` `no-referrer`, tokens.css, css/app.css, css/components.css, a `modulepreload` for every module Home starts with (tests/shell.test.mjs checks the list against the imports), js/main.js; theme and language set before the first paint from `localStorage['usugami.settings']`, and plain-http `usugami.com` sent to https; manifest, icons, theme colours, a noscript message. |
| `js/main.js` | Boot: appearance, `initI18n()` + the `kit` and `mark` strings, skip link, router, share inbox, service worker; installed (`display-mode: standalone`, or on `appinstalled`) it asks for `navigator.storage.persist()`, so the service worker that keeps shared files on the device isn't cleared away. With more than one language and none chosen, the first launch shows `#/language?next=<the address opened>`. Sets `<html data-ready="true">` once started (tests wait for it). |
| `js/core/{dom,i18n,settings,router,icons,recent,names,search,share-inbox}.js` | Below. |
| `js/lib/{pdfjs,tesseract}.js` | Wrappers of the vendored pdf.js and Tesseract (below). |
| `js/screens/{home,recent,settings,language,about,licenses,choose}.js` | The shell's screens, each `mount(ctx)` like a tool. |
| `css/app.css` | Page basics, screen transitions, the shell's screens. |
| `locales/languages.js`, `locales/en/common.js` | Languages; shared strings. |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable app, offline use, share target, app icons. |
| `tools/build-icons.mjs` | Writes `js/core/icons.js` and the PNG app icons. |

## core/dom.js

```js
h(tag, props?, ...children): HTMLElement
```
props: `class` (string or array; falsy entries dropped), `style` (object or string; `--vars` and
kebab-case allowed), `id`, `for`, `type`, `value`/`checked`/`selected` (set as properties),
`on<Event>` handlers (`onClick`, `onInput`, `onKeydown`, `onPointerdown`...), `aria-*` (false is
written as `"false"`), `data-*`, `role`, any attribute (`true` → empty attribute, `false`/`null`
→ left out), `dataset` (object), `ref` (called with the element). Children: strings, numbers,
nodes, nested arrays; `null`/`false`/`true` skipped. SVG tags (`svg`, `path`, `circle`, `rect`,
`g`, `line`, `text`, `image`...) are created in the SVG namespace.
```js
h('button', { class: ['x', on && 'is-on'], onClick: go, 'aria-label': t('back') }, icon('arrow_back'))
```
- `svg(tag, props?, ...children)` *extra*: always SVG namespace (for `a`, `title`, `style` inside an SVG).
- `clear(el)`: removes all children, returns `el`.
- `ensureCss(url): Promise<void>`: adds `<link rel="stylesheet">` once per URL (URL or string);
  resolves when loaded (or failed). `await ensureCss(new URL('./split.css', import.meta.url))`.
- `nextFrame(): Promise<void>`: next animation frame (or 100 ms, when the tab is hidden).
- `yieldToUI(): Promise<void>`: continues in a `MessageChannel` task, and once 50 ms have gone
  without a frame, after the next frame (each call yields: tests count them). Measured on a loop
  yielding every 30 ms: `scheduler.yield()` gave no frame and no timer for seconds (Chromium
  and Firefox: its continuations go first), `setTimeout` is slowed to once a second in a
  background tab and costs 4 ms a call; with a message task, 33 frames a second (none more than
  31 ms apart) and timers every 30-60 ms in Chromium and Firefox, 99% of the time on the work,
  and it keeps going in a background tab. Where messages are slow to arrive and there is no
  scheduler API (Playwright's WebKit on Windows: 30 ms a message, 15 ms a timer), a timer races
  each message.
  Safe in workers (a message task there) and in Node (timers).
- `announce(text)`: polite screen-reader announcement (`#announcer`, a live region; the same
  text twice is announced twice). While a modal dialog it isn't in is open (the rest of the page
  is inert then), it waits for that dialog to close (a progress dialog on its way out), up to 3 s;
  a dialog that stays gets the announcement in a live region of its own.
- `isWide(): boolean`: `(min-width: 840px)`.
- `onWideChange(fn(wide)): unsubscribe` *extra*.
- `prefersReducedMotion(): boolean` *extra*.

## core/i18n.js

- `initI18n(): Promise<void>`: picks the language (Settings `language`, else the first of
  `navigator.languages` in `LANGUAGES`, else `'en'`), sets `<html lang dir>`, loads `common`
  (when the language's `common.js` can't be loaded, offline say, `<html lang>` goes back to `en`,
  as the screens are then in English).
- `loadStrings(...namespaces): Promise<void>`: loads `locales/<lang>/<ns>.js` (and English for
  what is missing). Rejects when the English file is missing. `await loadStrings('split')`.
- `t(key, ...args): string`: `{1}`, `{2}`... replaced; a plural object gives its `other` form; an
  unknown key comes back as the key. `t('remove_file', 'Report.pdf')` → "Remove Report.pdf".
- `tp(key, count, ...args): string`: the plural form for `count` (`Intl.PluralRules` in the
  current language). **With no args, `{1}` is the count**; with args they fill `{1}`, `{2}`... as
  Android's `getQuantityString(res, n, args...)`:
  `tp('page_count', 3)` → "3 pages"; `tp('share_unsupported', 2, 2, 'a.txt, b.txt')`.
- `tWeb(key, ...args)` *extra*: `web_<key>` when it exists, else `key`. For the app's strings that
  say "this phone": `tWeb('tool_word_detail')` → "Documents (.docx), converted on this device".
  In another language, the app's translation of `key` shows while `web_<key>` has none of its own
  yet (rather than the English web wording). The `web_` strings whose meaning differs from the
  app's (`web_recent_lost_body`, `web_empty_share_hint`, `web_reorder_hint`, `web_edit_hint_draw`,
  `web_ocr_download_note`, `web_sign_pad_hint`, `web_sign_place_hint`) must be translated before
  a language ships.
- `hasString(key): boolean` *extra*.
- `getLanguage(): string` (`'en'`), `getDirection(): 'ltr'|'rtl'` *extra*.
- `setLanguage(code): Promise<void>`: saves it, reloads the namespaces loaded so far, sets
  `<html lang dir>`, then the router draws the current screen again.
- `onLanguageChange(fn(code)): unsubscribe` *extra*.
- `LANGUAGES`: `[{ code: 'en', name: 'English', dir: 'ltr' }]` (from `locales/languages.js`).
- `formatSize(bytes)`: as Android's `formatShortFileSize`: 1000-based, 2 decimals below 1, 1
  below 10, none from 10: "532 B", "619 kB", "2.4 MB", "0.96 MB". Units are strings
  (`web_size_b` ... `web_size_pb`, `web_size_format`).
- `formatNumber(n, options?)`, `formatDate(date|ms, options = { dateStyle: 'medium' })`: `Intl`
  in the current language (number formats are made once per language and options).

## core/settings.js

All settings are one JSON object in `localStorage['usugami.settings']`; reading and writing never
throw (no storage: the values hold for the visit). The website pages read `appearance` from it.
- `getSetting(key, fallback)`, `setSetting(key, value)` (`undefined` removes it; listeners are
  told only when the value changes), `onSettingChange(key, fn(value)): unsubscribe` (also for
  changes made in another tab).
- Keys: `language` (`'en'`...), `appearance` (`'system' | 'light' | 'dark'`, applied at once by
  main.js through `<html data-theme>` and the theme-color metas), tool choices `'<toolId>.<name>'`.

## core/router.js

Routes (hash): `#/` Home, `#/tool/<id>` (any id in `core/tools.js`), `#/recent`, `#/settings`,
`#/settings/about`, `#/settings/about/licenses`, `#/choose` (Choose a tool), `#/language` (first
launch, only with more than one language). `?a=b` after a path becomes params. Unknown → Home.

- `navigate(path, { files?, params?, replace?, from?, force?, replaceScreen? }): Promise<void>` (resolves once the
  screen has mounted). `files` (FileItem[]) and `params` go to `mount(ctx)`. `replace` swaps the
  history entry. `from` *extra*: where the back arrow leads when there is no page to go back to
  (a tool opened from Choose a tool passes `'/choose'`). `force` *extra*: mount again even if it is
  showing. Navigating to the screen showing with files replaces its entry. **navigate() doesn't
  ask about unsaved work**: code that leaves a tool by itself decides.
- `back(): Promise<void>`: as the app's back arrow and Android Back. If the screen's
  `hasUnsavedWork()` is true it first asks: the screen's own question when its handle has
  `discardQuestion()` (below), else `alertDialog({ title: t('tool_discard_title'),
  confirm: t('discard'), dismiss: t('keep'), destructive: true })` ("Discard your changes?",
  Discard / Keep, as the app). Then it goes to the previous page of the app, or (opened straight
  at an address) up to the parent: tool → Home (or Choose a tool), licenses → About → Settings → Home.
- The browser's Back/Forward do the same, with the same question; Keep stays on the screen.
  Closing or reloading the tab with unsaved work gets the browser's own "Leave site?".
- **Back closes what is open first**, as Android's Back: with a kit menu or a dismissible dialog
  open (a choice, a password question, a bottom sheet, the signature pad...), the browser's Back
  closes it as Escape would (Cancel, Keep) and the screen stays (its history entry is put back).
  Back while the discard question is asked answers Keep. A dialog that can't be dismissed (a
  progress dialog) stays, and Back goes on as without it (asking about unsaved work).
- A menu still open when the screen changes goes with the screen.
- Each screen sets the tab's title: `web_page_title` ("{1} – Usugami") with the tool's name or the
  screen's heading; "Usugami" on Home. Its element marked `data-main` gets `role="main"` when the
  screen has no `<main>`, and `id="content"` (where the skip link leads) when it has no id.
- `replaceScreen: true` *extra* (navigate): opens the screen in place of the one showing, unless
  that is Home: the history goes back over that screen's steps and its entry is replaced, so Back
  then leads where it would have from that screen (Home). Files shared to the app open so, as the
  app's openForShare.
- **A new language** (`setLanguage`) draws the screen showing again in it, with its params,
  unless that would lose work: a screen whose `hasUnsavedWork()` is true, or one handed `files`,
  keeps showing as it is (Edit PDF keeps its items and undo); the new language applies to the
  next screen mounted (strings read with `t()` from then on are in it already).
- `pushStep(step)` / `popStep()` *extra*: a history entry for an inner step of the screen (a
  result screen, Home's search), so the browser's Back returns to the step before instead of
  leaving. The router then calls `handle.onStep(step | null)` with the step now showing.
- `currentRoute(): { path, name, id, params, step, from } | null`, `currentHandle()`,
  `onRouteChange(fn(route)): unsubscribe` *extra* (called as each new screen starts showing),
  `parsePath(path)` *extra*, `startRouter(el)` (main.js only).

`mount(ctx)` gets, besides the contract's `root, tool, params, files, back, navigate`:
`ctx.step` (the history step it opens on, usually null), `ctx.from` (`'/choose'` when opened from
Choose a tool), `ctx.pushStep`, `ctx.popStep`. The screen root is
`<div class="screen" data-route="tool" data-tool="<id>" aria-busy="true">` until `mount()`
resolves (tests can wait for `:not([aria-busy])`); a thin progress bar shows after 300 ms of
loading. After mounting, the focus moves to the screen's first `h1` (the kit's top bar title).
Home's scroll position comes back when Home shows again.

The handle may have, besides `unmount()` and `hasUnsavedWork()`:
- `onStep(step)` *extra*: see pushStep.
- `restoreFocus(): boolean` *extra*: called when the screen shows again on the way back; true
  when it put the focus somewhere itself (Home: the card of the tool that was opened), else the
  focus goes to the heading.
- `receiveFiles(files)` *extra*: files shared to the app while this tool shows go to it instead of
  mounting it again (Images to PDF should add shared images to its list, as the app does). For
  images, `/tool/scan` counts as `/tool/images` (one module, tools/images/index.js).
- `discardQuestion(): { title, message?, confirm?, dismiss?, destructive? } | null` *extra*: the
  screen's own wording of the question asked before its unsaved work is lost, by the back arrow,
  the browser's Back and `ctx.back()`; what it leaves out is the generic one's (Discard / Keep,
  `destructive: true`: Discard in the error colour, the focus on Keep). `destructive: false`
  gives plain buttons, as the app's "Discard these images?".
  Null (or no such function): "Discard your changes?". Images to PDF:
  `discardQuestion: () => ({ title: t('discard_title'), message: t('discard_body') })` ("Discard
  these images?"). Called each time it asks, so it can depend on the screen's state.

A tool module that is missing (404), can't be loaded (offline) or throws in `mount()` gets a
screen of the shell's own: the tool's name in a bar with Back, and `web_tool_unavailable`
("{1} isn't available in the web app yet."), `web_tool_load_failed` ("Couldn't load {1}. Check
your internet connection and try again.") or `web_tool_crashed`, with Try again and Back to Home.

## core/icons.js

- `icon(name, { size = 24, label })`: inline `<svg class="icon">` in `currentColor` from Google's
  Material Icons (Round style, from @material-design-icons/svg, Apache-2.0; icons.js's header says
  so); `aria-hidden` unless `label` names it (`role="img"`).
  Icons that point a way (arrow_back, arrow_forward, open_in_new, undo, redo, rotate_left/right,
  sort, chevrons...) get `icon-mirrored` and turn round in right-to-left languages. An unknown
  name draws a rounded-square placeholder and warns once in the console.
- `hasIcon(name)`, `iconNames()` *extra*.
- `ICON_SET` *extra*: `{ name: 'Material Icons', style: 'Round', package: '@material-design-icons/svg',
  version, license: 'Apache-2.0', copyright: 'Copyright Google LLC' }`, for the licenses screen.
- 238 icons: every icon of the Android app (snake_case, e.g. `document_scanner`), plus
  `settings_outline` and `info_outline` (the app's Outlined.Settings and Outlined.Info), plus
  many the web screens may need (zoom_in, drag_indicator, expand_more, upload_file, chevron_left...).
- **Adding icons**: use the name in your code, then run `node tools/build-icons.mjs --js`; the
  script picks up every name used in `site/app/js` (`icon('name')`, `icon: 'name'`,
  `iconName: 'name'`, `placeholderIcon = 'name'`, and names chosen in an expression such as
  `icon(busy ? 'sync' : 'done')`) and lists the names the Material set doesn't have.
  (`--android <path to the app>` checks that every Android icon is listed; `--png` renders only
  the app icons.) tests/shell.test.mjs fails when a name used isn't in icons.js.

## core/recent.js

A copy of each saved file is kept in this browser (IndexedDB database `usugami`, stores `recent`
and `recentBytes`), newest first, at most 50. Nothing here throws.
- `addRecent(outputFile): Promise<void>`: `{ name, type?, bytes }` (any typed array or
  ArrayBuffer; the bytes are copied). **Call it whenever the user saves a file** (Save to
  Downloads, Save as, Save to folder; not Share). The same name and contents saved again moves up
  instead of showing twice. When storage is full the oldest files make room; a file that still
  doesn't fit isn't listed. Without IndexedDB, the list lives in memory for the visit.
- `listRecent(): Promise<{ id, name, type, size, savedAt }[]>` (newest first).
- `getRecentBytes(id): Promise<Uint8Array|null>` (null: gone).
- `removeRecent(id)`, `clearRecent()`: also delete the copies.
- `onRecentChange(fn): unsubscribe` *extra* (this tab and others), `MAX_RECENT` (50) *extra*.

## core/names.js

FileNames.kt, ported with its unit tests.
- `defaultPdfName(date = new Date())` → `'Usugami_20261031_172104'`.
- `sanitizeName(name, fallback)`: illegal characters (and control characters) → `_`, trimmed of
  spaces and dots, `.pdf` dropped, at most 200 UTF-8 bytes cut between whole characters, Windows
  device names get `_` (`'CON'` → `'CON_'`), `fallback` when empty. "Spaces" are Kotlin's
  `isWhitespace`, as the app's `trim()`: no-break, ideographic and other Unicode spaces and line
  separators too (`' Report '` → `'Report'`); a control character at an end isn't
  trimmed but becomes `_` (`'\u0001Report'` → `'_Report'`).
- `baseName('IMG_1.jpg')` → `'IMG_1'`; `withPdfExtension('a')` → `'a.pdf'`.
- `uniqueNames(['Report', 'report'], 'x')` → `['Report', 'report (2)']`.
- *extra*: `withSuffix(base, suffix, fallback, spare = 0)` (`'Report_redacted'`, cutting the base,
  never the suffix; `spare` bytes left free for an ending still to come),
  `withSuffixes(base, suffixes, fallback)` (Split's parts: the base is cut once, for the longest
  suffix, so they all begin alike: `withSuffixes('Report', ['_1_1-3', '_2_4-6'], 'x')`),
  `uniqueName(base, taken)` (also exported as `unique`, the app's name: `unique('a', ['A'])` →
  `'a (2)'`), `sanitize` (= `sanitizeName`), `naturalCompare(a, b)` ("IMG_2" before "IMG_10", for
  `sort`), `utf8Size(text)`.
- `fileNames` *extra*: `{ sanitize, withSuffix, withSuffixes, unique, baseName, uniqueNames }`, the
  same shape as engine/organize.js's `fileNames` (its own port); tests/shell.test.mjs checks that
  the two give the same names.
- Names in messages (app 1.6.2, `FileNames.listed` and NameList.kt): `listedNames(names)` →
  `{ listed, more }`, all of them when there are at most `LISTED_NAMES + 1` (4), else the first
  `LISTED_NAMES` (3) and how many more; `listOfNames(names)` → `'a.pdf, b.pdf'`, or
  `'a.pdf, b.pdf, c.pdf and 247 more'` (`names_and_more`, common.js), so a message about hundreds of
  files stays short (the message counts them all itself); `namesArg(names)` is the same for an
  engine's message arguments: the string, or `{ key: 'names_and_more', count, args }`, which the
  screen puts in words as it does the engine's messages. Every snackbar that names files uses them:
  `reportFileProblems`, `reportBatchFailures`, the share inbox's and drop zone's `share_unsupported`
  and `share_other_kind`, and Compress and Flatten's notes. names.js imports `tp` from i18n.js.

## core/search.js

ToolSearch.kt, ported with its unit tests (French, Spanish and Hindi cases included).
- `words(text): string[]`: lower case, accents, nukta and zero-width joiners dropped, candrabindu
  as anusvara, split at anything but letters, digits and marks.
- `matches(query, text): boolean`: every word typed begins a word of the text.
- `search(items, query, name(item), moreText(item)): items`: found by name first, then by
  description and keywords, each group in the items' order.

## core/share-inbox.js

Files shared to the installed app (share target, via sw.js) or opened with it (file handlers,
`launchQueue`), and dropped or pasted on Home, are routed as the app routes shared files.
- `receiveFiles(files, { unreadable = 0 })`: File objects or FileItems. Kind by the kit's
  `fileKind`. Takes the kind most of them are (ties: PDF, image, Word, PowerPoint, EPUB, Excel);
  snackbars name the files left out (`share_unsupported`, `share_other_kind`) and count those that
  couldn't be read (`msg_share_unreadable`). PDFs open Choose a tool; images `/tool/images`; Word,
  PowerPoint, Excel, EPUB `/tool/word|powerpoint|excel|epub`, with the files as `ctx.files`, in
  place of the screen showing (`replaceScreen`: Back then leads Home, as in the app). PDFs shared
  while Choose a tool shows join those listed. When the screen showing has unsaved work it asks
  first, as the app: on a result not saved (`step` 'result') "Discard this PDF?"
  (`pdf_discard_title`) with `share_discard_body`, or `pdf_discard_shared_body` for images; else
  "Discard your changes?" with `share_discard_changes`, or `pdf_discard_shared_changes`. Keep
  makes the files wait until the user leaves that screen, and files shared meanwhile (or while
  the question is open) join them with no question; when the screen is left, all of them are
  sorted again as one share (the kind most are opens, the others are named). While the first
  launch's language screen shows, shared files wait for the choice the same way. A tool showing with `receiveFiles` gets them directly, with
  no question; images shared while Scan document shows (`/tool/scan`, the same screen as Images to
  PDF) go to it that way too.
- Pure, for tests: `kindOfShared(type, name, sharedAs)` (SharedFiles.kindOf), `chosenKind(kinds)`,
  `sortShared(items, kinds, nameOf)` → `{ kind, taken, unsupported, otherKind, target }`,
  `fallbackName(kind)`, `SHARED_KINDS`, `SHARE_TARGETS`.
- `getSharedPdfs()`, `setSharedPdfs(items)`, `clearSharedPdfs()`: the PDFs on Choose a tool.
- `initShareInbox()` (main.js only).

**Passwords**: Choose a tool opens each shared PDF with the kit's `openPdf` (asking for passwords
in turn); a FileItem whose password was given there carries it as `item.password` when it reaches
the tool. Open it with `openPdf(item, { password: item.password })` so the user isn't asked twice.

## Vendor wrappers (js/lib/pdfjs.js, js/lib/tesseract.js)

- `openPdfJs(bytes, { password, ...more }): Promise<PDFDocumentProxy>`: pdf.js with this site's
  worker (one for every document: `pdfWorker()` *extra*, made again if it has gone; `worker: null`
  gives a document its own; ten PDFs used to be ten threads and 130 MB more), what a failed open
  held freed (pdf.js keeps it otherwise: a damaged PDF, or each password tried, left a worker and a
  copy of the file until the page closed), character maps, standard fonts, WebAssembly decoders and colour profiles, on a copy of
  `bytes` (pdf.js detaches the buffer it gets; `data` can't be overridden). Any other getDocument
  option in `more` is passed through and wins over the defaults (`useWorkerFetch: true`,
  `isEvalSupported: false`, `enableXfa: false`, `stopAtErrors: false`, `cMapPacked: true`), e.g.
  `openPdfJs(bytes, { fontExtraProperties: true })`. Rejects with `pdfjsLib.PasswordException`
  (code 1 needed, 2 wrong). **pdf.js 6.4.299's PDFDocumentProxy has no `destroy()`**: free a
  document with `doc.loadingTask.destroy()` (a PdfSource's `close()` does that). `pdfjsLib` is
  exported too.
- `createOcrWorker(lang, { logger, errorHandler, config } = {})`: a tesseract.js worker for
  `'en' | 'fr' | 'es' | 'hi'` (`OCR_LANGS`: `eng`, `fra`, `spa`, `hin+eng`), LSTM only, its worker,
  engine and data from this site (`cacheMethod: 'none'`; the service worker keeps them).
  `logger(message)` gets its progress. `errorHandler(error)`, when given, gets a failed job's
  error (the job's promise still rejects) instead of tesseract.js throwing it in the worker's
  message handler, where nothing can catch it (an uncaught page error). `config` (Tesseract
  parameters, createWorker's 4th argument) is set as the engine starts, for parameters
  setParameters can't change later: `{ config: { tessedit_char_whitelist: '0123456789' } }`. Each is
  passed on only when given. Call `worker.terminate()` when done.

## Screens (js/screens/)

Each exports `mount(ctx)`. Also exported, for reuse:
- `recent.js`: `recentRow(file, now?)` (a Recent files row: open, menu with Open, Share (only where
  the browser can share files, as the result screen), Remove from list; the row's button is named
  by its visible text; a failure says the UserError's words, `web_share_failed` or
  `web_recent_open_failed`; a share whose tap the browser no longer counts offers one more tap,
  `web_recent_share_ready`), `keepRowFocus(list | () => list, fallback)` *extra* (call before
  drawing the rows again: the focus goes to the row now in the place of the one removed, else
  `fallback()`; Home and Recent files use it), `savedWhen(ms, now?)` (time today, "Nov 3" this year, "Nov 3, 2025" before),
  `openRecent(file)`, `shareRecent(file)` (through the kit's output.js `openFile` / `share`; a file
  whose copy is gone gets "Can't open this file" with Remove from list / Keep).
- `settings.js`: `chooseDialog({ title, options: [{ value, label }], value }): Promise<value|null>`
  (the app's radio-choice dialog: tapping a choice closes it; Cancel; the list of choices isn't
  given as the dialog's description), `chooseAppearance()`,
  `chooseLanguage()`, `nativeName(language)`, `externalRow({ icon, title, detail, href })` (a list
  row opening a new tab, `rel="noopener noreferrer"`, with the open_in_new icon), `APPEARANCES`, `currentAppearance()`,
  `WEBSITE_SOURCE_URL` (https://github.com/Nath-Goa/usugami-website), `WEBSITE_NOTICES_URL`
  *extra* (its THIRD_PARTY_NOTICES.md on GitHub).
- `about.js`: `APP_VERSION` (`'1.0.0'`), `ANDROID_SOURCE_URL`, `appIcon()`. About links the
  website's source code and its third-party notices as ordinary links (new tab), as the
  MIT/BSD/IJG/Leptonica licenses of code inside the libraries want their notices reachable.
- `language.js`: after the choice, goes on to `ctx.params.next` (the address the app was opened
  at), else Home.
- `licenses.js`: `THIRD_PARTY` rows `{ name, version (a vendor/VERSIONS.json package, whose version
  shows) or fixedVersion, packages? (every VERSIONS.json package the row covers, when more than
  `version`), purpose (string key), license, copyright, text (license file served with the
  site, relative to site/app/, a `.txt` or `.md` the browser shows; fontkit's lists what is
  bundled in it too), home }`; `packagesOf(row)` *extra*. Add a row when adding a
  library: tests/shell.test.mjs fails when a VERSIONS.json package isn't covered. The screen also
  links the website's source code and THIRD_PARTY_NOTICES.md. The icons' row takes its name and
  version from icons.js's `ICON_SET`.
- `recent.js`'s Recent files screen has Clear list as a text button in its top bar, as the app
  (a topBar action with a label and no icon).
- `home.js`: "/" goes to the search field only while no control has the focus (the page, or the
  heading the router focused): a "/" typed or spoken on a card stays there (WCAG 2.1.4). Back from
  a tool opened from a card focuses that card (`restoreFocus`). Take photo opens the camera (a picker on computers) and goes to
  `navigate('/tool/scan', { files, params: { camera: '1' } })`, the app's photo flow (Discard
  photo, Take another, Done); Upload images goes to `navigate('/tool/scan', { files })`. The
  picker opens within the tap (files.js is imported up front: mobile Safari opens no picker after
  an await).
- `choose.js`: opens the shared PDFs with a `signal` its unmount aborts, so leaving takes a password
  question with it; PDFs opened for a list since replaced are closed. `takesShared(id, count)` (ShareScreen.takesShared: any PDF tool for one PDF;
  Merge PDF and the batch tools for several), `toolsForShared(count)`.

## CSS (css/app.css)

For everyone: `[hidden]` always hides; `.visually-hidden`; `.page` (a screen's content under its
top bar: 20 px sides on phones, centred at `--content-max` on wide screens, safe-area bottom),
`.page--narrow` (760 px), `.page--list` (no side padding, for full-width list rows); `.icon`.
The rest (`.home-*`, `.scan-card`, `.recent-*`, `.choice-*`, `.about-*`, `.license*`,
`.choose-*`, `.shell-*`, `.screen*`, `.route-progress`) is the shell's own. Screens slide in as
Motion.kt's screen change (24 px, 300 ms; none with reduced motion). `html` has a
`scroll-padding` clear of the sticky top bar, and of the bottom bar while a screen has one, so a
control reached with Tab isn't left under them. In Windows' contrast themes (forced colours) the
shell's parts drawn by a background (Scan document, the search bar, filled buttons) get a border,
and the chosen choice shows in `Highlight`.

## Strings (locales/en/common.js)

Shared by every screen; don't redefine these keys in another namespace. Copied from strings.xml
(same keys and English): `app_name back cancel cancelling ok open open_file share share_file
share_all save save_file keep discard undo redo`; Home (`home_title home_subtitle settings
scan_title scan_detail scan_upload add_from_camera home_section_* home_search_*`); every tool's
`tool_*`, `tool_*_detail`, `search_keywords_*` and `search_keywords_batch`; Recent files
(`recent_*`); Settings and About (`language_* settings_* appearance_* about*`); sharing
(`share_title share_several_hint share_unsupported share_other_kind msg_share_unreadable
share_waits tool_discard_title pdf_discard_title share_discard_* pdf_discard_shared_*`); picking
(`pick_pdf pick_pdfs add_pdfs pick_several_hint remove_file move_file_earlier move_file_later`);
opening PDFs (`pdf_import_failed[_many] pdf_certificate_unsupported[_many] pdf_wrong_password
pdf_password_* pdf_unlock pdf_password_removed open_no_space[_many]`); work (`pdf_working[_many]
batch_progress batch_failed progress_pages progress_files page_count pdf_process_failed
file_problem`); the result screen (`result_* save_to_downloads save_as save_all_to_folder zip_*
back_to_editing start_over start_over_title not_saved_note pdf_saved_downloads msg_saved*
msg_not_saved msg_save_failed`); errors (`msg_convert_failed msg_image_unreadable
msg_out_of_memory msg_out_of_space msg_unknown_error pdf_import_failed`). Web-only keys start with
`web_` (`web_more_options` "More options", `web_more_options_for`, `web_try_again`, `web_page_title` "{1} –
Usugami", `web_recent_open_failed`, `web_recent_share_ready`,
`web_opens_elsewhere`, `web_size_*`, `web_home_subtitle`, `web_tool_word_detail`,
`web_about_notices` "Third-party notices", `web_about_notices_detail`, `web_licenses_notices`,
`web_lic_*`...).

## Service worker (sw.js) and manifest

- Its version line is exactly `const VERSION = 'dev';` (the deploy workflow puts the commit there).
- Code is kept per version, so offline the app never runs files of two versions together (a
  renamed export would break it): the shell in `usugami-shell-<VERSION>`, code kept as it is
  used (modules, CSS, strings, libraries, anything not data) in `usugami-code-<VERSION>`; data the
  same in every version (`fonts/`, `vendor/tesseract/lang/`) in `usugami-runtime`. Installing a
  new version fetches again the code the last one had kept (checked with the server: unchanged
  files cost a 304), so the tools used before still open offline; activating it deletes the old
  versions' shells and code (and code an older worker left in `usugami-runtime`). Offline the
  shell answers first.
- `const LANGUAGES = ['en'];` in sw.js lists the codes of `locales/languages.js` (the test checks
  they agree): each language's `common`, `kit` and `mark` strings are in `SHELL`, so the app opens
  offline in the language chosen.
- Install: keeps the shell in `usugami-shell-<VERSION>`: index, CSS (`mark.css` too), every module
  main.js and the shell's screens import (core, screens, the kit with output.js's result-mark.js
  and engine/mark-layout.js, and what files.js imports from engine/images/), fflate, the common,
  kit and mark strings, icons. A module added to that import graph, or imported by a module in
  `SHELL`, must be added to `SHELL` (tests/shell.test.mjs checks both, and the CSS those modules
  load), or the app can't start offline after its first visit. Each file is asked for with
  `cache: 'no-cache'` (a 304 for what the page has just loaded, not a second download). A file
  missing on the site doesn't stop the install.
- Same-origin GET: network first. A whole good answer (200, same origin) is kept in
  `usugami-runtime` as it is first fetched, not before: vendor libraries, fonts
  (`fonts/*.ttf`), text recognition's engine and language data (`vendor/tesseract/**`, 4.8–8.4 MB a
  language, fetched by the page and by Tesseract's worker), tool modules and their CSS. So text
  recognition in a language, a font or a tool used once works offline afterwards; one never used
  doesn't. Writing the copy is part of the fetch event (`waitUntil`), so the worker isn't stopped
  halfway through a large file. Without a network, or when the server fails (5xx), the kept copy
  answers (any one, whatever it was asked with: `ignoreVary`), and the app's page (`app/`,
  `app/index.html`, with any query) gets the shell; another address under `app/` (`app/tool/split`)
  gets nothing, as its relative files would load nothing.
  App addresses with a query (`?share=<id>`) aren't kept. Other origins and Range requests are
  never touched. Old shells are deleted on activate; the runtime copies stay (network first keeps
  them fresh).
- Share target: `POST share-target` (multipart, field `files`). The files are kept in the cache
  `usugami-share` under `share/<id>/<n>` with `share/<id>/index`, and the app opens at
  `./?share=<id>`; share-inbox.js reads them, deletes them, and routes them.
- Manifest: name Usugami, start_url/scope/id `./`, standalone, colours from tokens.css, icons 192,
  512, maskable 512 and SVG, `share_target` (PDF, images, .docx, .pptx, .xlsx, .epub) and
  `file_handlers` for the same (consumed through `launchQueue`), `launch_handler`
  focus-existing. The share target takes files only (no `title`, `text`, `url`), so the app isn't
  offered for sharing text or links, as the Android app's filters.

## Tests

`node tests/shell.test.mjs` (`--quick`: Chromium only, no screenshots). Covers the ported unit
tests (ToolSearch, FileNames, SharedFiles), common.js against strings.xml, Home in Chromium,
Firefox and WebKit at 360 and 1366 px (every tool in its section, no outside requests, no
sideways scroll), search, routes and Back with the unsaved-work question and steps, missing tool
modules, Settings (appearance applied and kept, language, About links, licenses), Recent files
(order, de-duplication, 50 max, menu, Clear list, lost copies, no storage), shared/dropped files
routing with Choose a tool, the manifest and icons, the service worker offline and its share
target, and 320 px layouts. Screenshots go to `tests/output/shell-*.png`. Also: FileNames' Kotlin
whitespace and `names.js` against organize.js's `fileNames`; icons.js's header and every icon
name used; the shell precache against the start's import graph; the screen's own discard question
(back arrow, browser Back) and a language change keeping unsaved work; Take photo / Upload images
(params, the picker opened within the tap); images shared while Scan document shows; the lib
wrappers (`openPdfJs` options, `createOcrWorker` errorHandler and config); About/licenses links and
every VERSIONS.json package listed; Back closing a dialog or menu first and answering the discard
question as Keep (and Discard leading Home); tab titles, the main landmark and the skip link;
files shared opening in place of the screen showing, worded as the app at a result, joining
those waiting or on Choose a tool; a stand-in second language (first launch with the address
kept and shared files waiting, web strings falling back to the app's translation); one pdf.js
worker and nothing left by failed opens; the license texts served as text and links with
noreferrer; the modulepreload list and the CSP; `yieldToUI` keeping frames and timers going and
announcements waiting for a modal dialog; contrast-theme outlines and scroll padding; a deploy
of a second version (offline, only its code); offline, no shell at `app/a/b/c`; and text
recognition, fonts, a tool and a library working
offline after their first use (Chromium with its offline switch; with `--browser firefox` or
`webkit`, the site's server is stopped instead, as their offline switch doesn't reach service
workers).
