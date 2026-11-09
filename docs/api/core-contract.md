# Core contract (binding)

The app shell and the UI kit are built at the same time as the tools that use them, so their
public functions are fixed here. Implementers may add options and functions (document them in
`docs/api/shell.md` / `docs/api/kit.md`) but must not rename or remove these. Every function that
renders returns an `HTMLElement` unless noted. Text passed in is already translated (callers use
`t()`); components never hard-code English.

## core/dom.js (shell)

```js
h(tag, props?, ...children)       // props: { class, style (object or string), id, for, type, value,
                                  //   onClick / onInput / on<Event> handlers, aria-* / data-* / role / other attributes,
                                  //   dataset }; children: strings, nodes, arrays, null/false (skipped)
clear(el)                         // remove all children
ensureCss(url)                    // add <link rel="stylesheet"> once per URL (URL object or string)
nextFrame(): Promise<void>
yieldToUI(): Promise<void>        // let the browser paint and handle input during long work
announce(text)                    // polite screen-reader announcement
isWide(): boolean                 // matchMedia('(min-width: 840px)') — desktop/tablet layout
```

## core/i18n.js (shell)

```js
initI18n(): Promise<void>                    // picks the language (Settings, else the browser's), loads 'common'
loadStrings(...namespaces): Promise<void>    // loads locales/<lang>/<ns>.js with English fallback
t(key, ...args): string                      // '{1}' '{2}' placeholders
tp(key, count, ...args): string              // plural object chosen by Intl.PluralRules(count)
getLanguage(): string                        // 'en'
setLanguage(code): Promise<void>
LANGUAGES                                    // from locales/languages.js: [{ code, name, dir }]
formatSize(bytes): string                    // like Android's short file size: '619 kB', '2.4 MB'
formatNumber(n, options?): string
formatDate(date, options?): string
```

## core/settings.js (shell)

```js
getSetting(key, fallback)      // keys: 'language', 'appearance' ('system' | 'light' | 'dark'),
setSetting(key, value)         // tool choices as '<toolId>.<name>' (e.g. 'images.pageSize')
onSettingChange(key, fn): () => void   // returns an unsubscribe function
```
All settings are one JSON object in `localStorage['usugami.settings']` (for example
`{"appearance":"dark","language":"en","images.pageSize":"a4"}`). The website pages read
`appearance` from it (in try/catch) so they match the theme chosen in the app.

## core/router.js (shell)

```js
navigate(path, { files?, params?, replace? })   // '/', '/tool/<id>', '/recent', '/settings', '/choose'
back()                                          // like the app's back arrow / Android back
```

## core/icons.js (shell)

```js
icon(name, { size = 24, label })   // inline <svg> from Material Symbols Rounded (Apache-2.0),
                                   // aria-hidden unless label is given. name = Material icon name,
                                   // e.g. 'arrow_back', 'more_vert', 'rotate_left', 'delete', 'share'.
```
The shell generates the icon set from `node_modules/@material-design-icons/svg/round/` with a
script (`tools/build-icons.mjs`) listing every icon any screen uses. If an icon you need is missing,
use it anyway: `icon()` draws a neutral placeholder for unknown names, and note it in your report so
it can be added.

## core/recent.js (shell)

```js
addRecent(outputFile): Promise<void>   // a file the user saved (Save, Save as, Save to folder): kept in this
                                       // browser (IndexedDB), newest first, at most 50
listRecent(): Promise<RecentFile[]>    // { id, name, type, size, savedAt }
getRecentBytes(id): Promise<Uint8Array|null>
removeRecent(id), clearRecent()
```

## core/ui.js (kit)

```js
topBar({ title, subtitle?, onBack?, actions?: [{ icon, label, onClick, disabled? }], menu?: [{ label, onClick }] })
button({ label, icon?, variant = 'filled' | 'tonal' | 'outlined' | 'text', onClick, disabled?, type? })
iconButton({ icon, label, onClick, disabled?, selected? })
fab({ label, icon, onClick })                       // extended floating action button (the app's main buttons)
segmented({ options: [{ value, label }], value, onChange, label? })   // el.setValue(v)
chips({ options: [{ value, label }], value, onChange, label? })       // single-choice filter chips; el.setValue(v)
dropdown({ label, options: [{ value, label }], value, onChange })     // "Page size: A4 ▾"; el.setValue(v)
switchRow({ label, detail?, checked, onChange, disabled? })           // el.setChecked(b)
slider({ label, min, max, step, value, onChange, format? })           // el.setValue(v)
textField({ label, value, suffix?, helper?, error?, placeholder?, inputmode?, onInput, onEnter? })
                                                    // el.setValue(v), el.setError(text|null), el.input
card({ icon, title, detail?, onClick, trailing? })  // a tool card as on Home
fileCard({ name, detail?, thumbnail?: Node | Promise<Node>, onRemove?, actions? })
emptyState({ icon, title, detail?, actions: Node[] })   // "Choose a PDF" etc.; on desktop it is also a drop zone
dropZone(target, { accept, multiple, onFiles(fileItems) })  // drag-and-drop and paste of files onto target
progressDialog({ title, cancellable = true, onCancel })  // returns { update(fraction|null, label?), close() }
snackbar(message, { action?, onAction?, duration? })
alertDialog({ title, message, confirm, dismiss?, destructive? }): Promise<boolean>
passwordDialog({ fileName, wrong }): Promise<string|null>
bottomSheet({ title, content, actions? })           // returns { el, close() }; a side dialog on wide screens
menu(anchorEl, items: [{ label, icon?, onClick, disabled? }])
sectionHeading(text)
listItem({ icon?, leading?, title, detail?, trailing?, onClick? })
```

## core/files.js (kit)

```js
pickFiles({ accept: 'pdf' | 'image' | 'docx' | 'pptx' | 'xlsx' | 'epub' | string, multiple, capture?: 'environment' })
                                   // Promise<FileItem[]> (empty if cancelled). capture opens the phone's camera app.
toFileItems(fileList | File[]): Promise<FileItem[]>
fileKind(fileItem): 'pdf' | 'image' | 'docx' | 'pptx' | 'xlsx' | 'epub' | 'other'   // by content, then name (ImageFileType.kt, SharedFiles.kt)
ACCEPT                             // accept attribute strings per kind
```

## core/pdfdoc.js (kit)

```js
openPdf(fileItem, { ask = true }): Promise<PdfSource|null>   // asks for a password (again if wrong); null if cancelled
// PdfSource: { name, size, bytes, password, pageCount,
//   pdfjs(): Promise<PDFDocumentProxy>, thumbnail(index, cssWidth): Promise<HTMLCanvasElement>,
//   pageSize(index): Promise<{ width, height, rotation }>, close() }
```

## core/pagegrid.js (kit)

```js
pageGrid({
  count, thumbnail(i, cssWidth): Promise<Node>,   // page previews, rendered lazily as they scroll into view
  label?(i): string,                              // under each page (default: its number)
  selectable?: boolean, selected?: Set<number>, onToggle?(i),
  reorderable?: boolean, onMove?(from, to),       // long-press and drag (touch), drag (mouse), keyboard
  rotation?(i): number,                           // degrees, shown turned
  badge?(i): Node|null, overlay?(i): Node|null,
})  // el.refresh() re-renders labels/rotations/selection; el.setCount(n)
```

## core/output.js (kit)

```js
showResult(root, {
  files: OutputFile[], title?, message?, details?(file): string,   // e.g. '62% smaller'
  onStartOver?(), onBack?(),
})  // Open, Share, Save to Downloads, Save as…, and for several files Save to folder… and Share or save as ZIP
download(file), share(files), openFile(file), saveAs(file), saveToFolder(files), zipFiles(files, zipName): OutputFile
```

## core/batch.js (kit)

```js
batchList({ items: [{ id, name, detail? }], nameOf(id), onRename(id, name), onRemove(id), onAdd?, choice?: { options, valueOf(id), onChange(id, value) } })
runBatch(items, work(item, index, { signal, onProgress }), { title }): Promise<{ outputs: OutputFile[], failures: [{ item, error }] }>
                                   // shows "PDF 2 of 5" and the file's name in a progress dialog; one failure doesn't stop the others
```

## core/names.js (shell)

```js
defaultPdfName(date = new Date()): string     // 'Usugami_20261031_172104' (no extension)
sanitizeName(name, fallback): string          // FileNames.sanitize
baseName(fileName): string                    // without extension
withPdfExtension(name): string
uniqueNames(names, fallback): string[]
```
