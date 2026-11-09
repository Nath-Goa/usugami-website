# Usugami website: architecture

The site has two parts, both static files in `site/`:

- **Website pages**: Home (`site/index.html`), Download (`site/download/`), Privacy (`site/privacy/`).
  Plain HTML and CSS.
- **The web app** (`site/app/`): Usugami's tools in the browser, on phones and desktops. It does
  what the Android app does (`C:\Users\Nathan\OneDrive\Desktop\pdfer`, read-only: never change
  anything there), with the same tools, options, wording and behaviour, as close as a browser
  allows. Files are processed on the device and never uploaded.

The Android app is the specification. Its Kotlin is in `pdfer/app/src/main/java/io/github/nath_goa/usugami/`
(`ui/` screens and view models, `data/` engines, `data/office/` converters) and
`pdfer/core/src/main/java/io/github/nath_goa/usugami/core/` (pure algorithms, with unit tests in
`pdfer/core/src/test/`). Its English strings are `pdfer/app/src/main/res/values/strings.xml`. Its
README describes every feature. When porting, read the Kotlin and port its logic and its edge
cases; don't reinvent them.

## Rules

- **No outside requests.** No CDNs, outside fonts, analytics, trackers or cookies. Every file the
  site uses is served from `site/`. Links to other sites (GitHub, F-Droid, Obtainium) are fine as
  ordinary `<a href>` links. Every HTML page starts its `<head>` (right after `<meta charset>`)
  with a `Content-Security-Policy` `<meta>` from `default-src 'self'` that names no other host,
  so the browser blocks anything else. `node tools/check-site.mjs --require-csp` (as CI runs it)
  checks this, and prints the hash to put in `script-src` when an inline script changes.
- **Relative URLs only.** Never start a path with `/`. The site must work at the root of
  usugami.com and in a sub-folder (`https://nath-goa.github.io/usugami-website/`, or
  `node tools/serve.mjs --prefix usugami-website`). In JavaScript, build URLs with
  `new URL('relative/path', import.meta.url)`. No `CNAME` file.
- **Browser storage**: only `localStorage` for settings and IndexedDB for Recent files, both
  local to the device, always wrapped in try/catch (they can be unavailable), and described on the
  Privacy page. Nothing else is stored.
- **No build step.** Native ES modules (`<script type="module">`), plain CSS. Libraries are
  vendored into `site/app/vendor/` by `npm run vendor` (committed). Import them only through the
  wrappers in `site/app/js/lib/` (`pdf-lib.js`, `pdfjs.js`, `fontkit.js`, `fflate.js`, `tesseract.js`).
- **Phones first, desktops too.** Layouts start at 320 px wide and grow: wider screens get more
  columns, side-by-side panes, hover states, drag-and-drop of files and keyboard shortcuts. Touch
  targets are at least 48 px. Works in current Chrome, Edge, Firefox and Safari (desktop, Android,
  iOS).
- **Accessible.** Real buttons and labels, `aria-*` where needed, visible focus, keyboard use
  everywhere (including reordering pages), `prefers-reduced-motion`, contrast as in the tokens.
- **Fast.** Load only what a screen needs (tool modules, vendor libraries, fonts and OCR data are
  imported on demand). Keep the main thread responsive during long work: `await yieldToUI()`
  between pages and show progress.
- **English first, ready for French, Spanish and Hindi** (see Strings).
- Style: 2-space indent, semicolons, single quotes, `const`/`let`, JSDoc on exported functions,
  short comments that say why. No frameworks. No TypeScript.
- Never commit or run git commands that change history; the maintainer commits.

## Layout of `site/app/`

```
site/app/
  index.html              the app shell (loads js/main.js)
  manifest.webmanifest    installable app; share_target (Share to Usugami) and file_handlers
  sw.js                   service worker: works offline, receives shared files
  css/app.css             app-wide components (uses ../../assets/css/tokens.css)
  js/main.js              boot
  js/lib/                 vendor wrappers (done)
  js/core/                app framework: dom, i18n, settings, router, ui, icons, files, pdfdoc,
                          pagegrid, output, batch, recent, names, search, errors, tools
  js/screens/             home, settings, recent files, choose a tool
  js/engine/              processing without UI (may use canvas/OffscreenCanvas):
    pdf-common.js         loadPdf / savePdf / needsPassword / createPdf / pruneUnreferenced (done)
    page-selection.js     "1,3,5-8" and "1-3;5;7-9" parsing (PdfPageSelection.kt)
    organize.js           split, merge, reorganize, delete pages, rotate
    cleanup.js            really removing what deleted pages used (PageCleanup.kt, XObjectCleanup.kt)
    compress.js, flatten.js, redact.js, stamps.js (page numbers, watermark), edit.js, sign.js
    ocr.js                text recognition → invisible text layer (PdfOcr.kt)
    text/                 fonts, text layout and a canvas-like PDF drawing surface
    images/               decoding, page detection, crop/straighten, looks, encoders, image PDFs
    office/               Word, PowerPoint, Excel and EPUB to PDF
  js/tools/<tool>/        each tool's screens (index.js exports mount), its CSS next to it
  locales/<lang>/<ns>.js  strings
  fonts/                  Noto fonts (OFL) and UsugamiOcr-Regular.ttf (glyph-less OCR font)
  vendor/                 libraries (generated by npm run vendor; license texts as .txt or .md,
                          so browsers show them instead of downloading them)
```

Tools and their sections are listed in `js/core/tools.js` (done; the same as the app's Home).

## Contracts between parts

### Files

`core/files.js` turns picked, dropped, pasted or shared files into **FileItem**s:
`{ name, type, size, lastModified, bytes: Uint8Array }`. Tools receive them, never `File` objects.

### PDFs

- Engines open PDFs with `loadPdf(bytes, { password })` and save with `savePdf(doc)` from
  `engine/pdf-common.js`: decrypted (new PDFs have no password, as in the app), unreferenced
  objects pruned, producer "Usugami".
- Screens open a picked PDF with `core/pdfdoc.js`'s `openPdf(fileItem)`, which asks for the
  password when needed (and again when it's wrong) and gives a **PdfSource**
  `{ name, size, bytes, password, pageCount, pdfjs(), thumbnail(index, cssWidth), pageSize(index), close() }`.
- pdf.js detaches the buffer it is given: always open it through `lib/pdfjs.js`'s
  `openPdfJs(bytes, { password, ...other getDocument options })`, which passes a copy. Free a
  document with `doc.loadingTask.destroy()` (pdf.js 6's PDFDocumentProxy has no `destroy()`).

### Engines

Engines are async functions with plain inputs and outputs, no DOM UI, testable in a page:

```js
/**
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {object} options        the tool's choices
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<OutputFile | OutputFile[]>}
 */
```

An **OutputFile** is `{ name: string, bytes: Uint8Array, type: 'application/pdf' | 'application/zip' | ... }`
plus optional facts the result screen shows (for example Compress PDF's `keptOriginal`,
`originalSize`). Engines throw `UserError(key, ...args)` (core/errors.js) for problems the user can
act on (the message is the string `key`), `PasswordError` for passwords, and call
`checkCancelled(signal)` between pages.

### Tool screens

Each `js/tools/<tool>/index.js` exports:

```js
/** Renders the tool into ctx.root and returns a handle. */
export async function mount(ctx) {
  // ctx.root     an empty element filling the screen: render the top bar and everything else in it
  // ctx.tool     the tool's entry in core/tools.js
  // ctx.params   ctx.tool.params (e.g. { kind: 'word' }, { start: 'scan' }) plus any route params
  // ctx.files    FileItem[] handed over (shared to the app, Choose a tool, Home), or null
  // ctx.back()   leave the tool (the router asks first if hasUnsavedWork() is true)
  // ctx.navigate(path, options)
  return {
    unmount() {},             // stop work, free memory (close PdfSources, revoke object URLs)
    hasUnsavedWork() { return false },
  };
}
```

A tool screen follows the app's flow: pick files (empty state with a pick button; on desktop
also drag-and-drop and paste), options, the main button (e.g. "Split PDF"), progress, then the
result screen from `core/output.js` with Open, Share, Save to Downloads, Save as…, and for several
PDFs Save to folder… and Share or save as ZIP, as in the app's ResultScreen.

## Strings

- Strings live in `site/app/locales/en/<namespace>.js`:
  `export default { key: 'Text with {1} and {2}', plural_key: { one: '{1} page', other: '{1} pages' } }`.
- **Keys are the app's strings.xml names** wherever the app has the string, with the English text
  copied exactly, so French, Spanish and Hindi can later be imported from the app's
  `values-fr`, `values-es` and `values-hi`. Android's `%1$s` / `%1$d` / `%s` become `{1}`, `{2}`, `{1}`, and `%%` becomes `%`.
  `<plurals>` become objects keyed by CLDR category (`one`, `other`, ...). Strings the app doesn't have
  get keys starting with `web_`.
- All namespaces of a language share one set of keys, and **each key is defined in exactly one
  `locales/en` file**. `common.js` (owned by the app shell) holds the strings used across screens:
  tool names, details and search keywords, Home, buttons, the result screen, errors; shared keys
  live there. `common.js`, `kit.js` and `mark.js` load at start, so their keys work everywhere.
  A tool's own strings go in `locales/en/<tool>.js`; never redefine a key from another file there.
- `await loadStrings('split')` (core/i18n.js) before rendering, then `t('key', arg1, arg2)` and
  `tp('plural_key', count, arg1, ...)`. Never build sentences from pieces; never hard-code
  user-visible English in JS or HTML of the app.
- Engines have no strings file of their own: their API notes list every `UserError` key they throw
  with its English text (from strings.xml), and the screen that calls the engine puts those keys in
  its namespace file.
- Format sizes, numbers and dates with core/i18n.js (`formatSize`, `formatNumber`, `formatDate`).
- `node tests/strings.test.mjs` (Node only, part of `npm test`) checks that each key is defined
  once, that every literal key in `t()`, `tp()`, `tWeb()` and `new UserError()` exists, and, when
  the app's repository is next to this one (`../pdfer`; not on GitHub's runners), that every
  app-named string is exactly its strings.xml English (`node tools/import-strings.mjs en --check`
  shows the differences).

### To add a language (French, Spanish, Hindi)

1. `node tools/import-strings.mjs fr` (with the app's repository at `../pdfer`, or `--app <folder>`)
   writes `site/app/locales/fr/<ns>.js` from the app's `values-fr/strings.xml`, each key in the file
   its English is in. It leaves out what the app doesn't translate (`translatable="false"`) and any
   translation whose `{1}` `{2}` don't match the English, and lists the `web_` keys still missing.
   Run it again whenever the app's translations change: it keeps the `web_` translations.
2. Translate the `web_` strings it lists (about 100, in the namespace file each belongs to; run
   `node tools/import-strings.mjs fr --missing` to see what is left). Start with what is on
   screen everywhere: the file size units `web_size_b` ... `web_size_pb` and `web_size_format`
   (use the units Android shows in that language, such as "ko" and "Mo" in French),
   `web_skip_to_content`, `web_choose_another_pdf`, then About and the licenses' descriptions.
3. Add the language to `LANGUAGES` in `locales/languages.js` (its own name, `dir`).
4. Add the language's code to `LANGUAGES` in `site/app/sw.js`: `SHELL` keeps each language's
   `common.js`, `kit.js` and `mark.js` from it, so the app opens in that language offline
   (`tests/shell.test.mjs` fails until it matches `locales/languages.js`).
5. `npm test`, then open the app with `npm run serve` in a new private window: with more than one
   language, the first launch shows the language screen (`#/language`), as the Android app does.
   Check Home, a tool, the result screen and Settings in the new language.
6. The website pages: see `docs/website.md` (copies in `site/<lang>/`; the app's
   `fastlane/metadata/android/fr-FR/`, `es-ES/` and `hi-IN/` have its feature texts in those
   languages).

## CSS

- Tokens: `site/assets/css/tokens.css` (colors, radii, spacing; light and dark; `data-theme`
  override). Use the variables, never raw colors.
- `site/app/css/app.css`: shell and shared components (owned by the app shell). A tool's own styles
  go in `js/tools/<tool>/<tool>.css`, loaded with `ensureCss(new URL('./<tool>.css', import.meta.url))`,
  with class names prefixed by the tool id.
- Logical properties (`margin-inline-start`) so right-to-left languages can come later.

## Tests

- `tests/harness.mjs`: `withPage(fn, opts)` serves the site in a sub-folder, opens headless
  Chromium (or `browser: 'firefox' | 'webkit'`) at phone size by default, fails on page errors,
  console errors and any request to another host. `allowConsole: [RegExp, ...]` lets matching
  console errors through (for example Firefox's `XML Parsing Error`, which it logs for every
  DOMParser syntax error; don't anchor the pattern with `^`, as Firefox's text starts with
  `[JavaScript Error: "`). `runInPage(page, url, 'app/js/engine/x.js', 'fn', ...args)` calls an
  engine inside the page: Uint8Arrays, other typed arrays, DataViews and ArrayBuffers pass both
  ways at any depth (inside arrays, plain objects, Maps and Sets), keeping their types.
- One file per area: `tests/<area>.test.mjs`, a plain Node script that throws on failure. Run one with
  `node tests/<area>.test.mjs`, all with `npm test`, some with `npm test -- organize compress`
  (files whose names contain either; a name that matches no file is an error), and
  `npm test -- --list` to see which would run. CI runs them in four parts side by side
  (`npm test -- --shard 2/4`), split by the rough times listed in `tests/run.mjs`: add a new
  file's time there.
- Infrastructure tests: `tests/harness.test.mjs` tests the harness and `tests/run.mjs`;
  `tests/vendor.test.mjs` checks that `site/app/vendor` is what `npm run vendor` makes (to see
  what a change to `tools/vendor.mjs` does first, `node tools/vendor.mjs --out .tmp/vendor-check`
  writes elsewhere); `tests/strings.test.mjs` checks the strings (see Strings).
- Fixtures: generate them in the test (pdf-lib can make PDFs; Office and EPUB files are ZIPs of XML,
  fflate can build them) or put small files in `tests/fixtures/`. The app's test images are in
  `pdfer/app/src/androidTest/assets/images/` (copy, don't move). Port the app's unit tests
  (`pdfer/core/src/test/`) for the algorithms you port.
- Check results by reading them back: pdf.js text extraction, page counts and sizes with pdf-lib,
  rendering to a canvas and sampling pixels.

## API notes from each part

Each part documents its public functions in `docs/api/<part>.md` so the screens built on it can use
it without reading its code.
