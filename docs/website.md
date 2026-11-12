# The website pages

The website is four hand-written HTML pages, plus a page for each tool made from them, all sharing
one stylesheet. They tell people what Usugami is, send them to the web app (`site/app/`) or the
Android app, and hold the privacy policy; the tool pages are what people find when they search for
a task ("merge PDF", "compress PDF"). There is no framework and no build step when deploying: the
tool pages are written by `tools/build-tool-pages.mjs` and committed. JavaScript is used for two
small jobs only: following the theme chosen in the web app, and finding the site's root on the 404
page.

| File | What it is |
|---|---|
| `site/index.html` | Home: what Usugami is, the web app first and then the Android app, screenshots, every feature grouped as on the app's Home (the Usugami watermark among them), privacy highlights, the three editions in brief, source code and license |
| `site/download/index.html` | Download: the three editions compared, GitHub, Obtainium and F-Droid, install steps, verifying the download, the source code of the app and of this website (with their third-party notices), badge credits |
| `site/privacy/index.html` | Privacy: the Android app's policy (all of `PRIVACY.md`), then "Usugami on the web": this website, the web app, what it downloads (text recognition, fonts), everything it stores on the device, and how to delete it |
| `site/merge-pdf/index.html` and the other tool pages | One page per tool, written by `tools/build-tool-pages.mjs` (see [The tool pages](#the-tool-pages)) |
| `site/404.html` | Page not found, served by GitHub Pages for any unknown address |
| `site/robots.txt` | Allows everything and names the sitemap (read only at the domain's root) |
| `site/sitemap.xml` | Every page's address for search engines, written with the tool pages |
| `site/assets/css/tokens.css` | Colors, radii and spacing, shared with the web app (not owned by the pages: append only) |
| `site/assets/css/site.css` | The pages' layout and components, phone first |
| `site/assets/img/` | Icons, screenshots, badges and the social preview image |
| `tools/build-tool-pages.mjs`, `tools/tool-pages.mjs` | The script that writes the tool pages and the sitemap, and the tool pages' words |
| `tools/check-site.mjs` | Checks the whole site for the rules in `ARCHITECTURE.md` (see below) |
| `tests/site.test.mjs` | Opens every page in Chromium, Firefox and WebKit and checks it (see below) |

The content comes from the Android app's repository: `README.md` (features, editions, install,
verify, Obtainium), `PRIVACY.md` and `fastlane/metadata/android/en-US/`. When those change (a new
size, a new edition, a new install note, a policy update), change the pages to match. Things that
date: the editions' sizes, the "developer verification" answer ("As of October 2026"), and the
policies' effective date (9 November 2026).

The Privacy page's web part ("Usugami on the web") comes from the web app itself instead: what it
keeps in `localStorage` (`app/js/core/settings.js`: language, appearance, the tools' last choices,
the Usugami watermark switch, size and opacity), in IndexedDB (`app/js/core/recent.js`: copies of
the files saved, for Recent files), in the service worker's caches (`app/sw.js`: offline copies;
`app/js/core/share-inbox.js`: shared files until read), and what it downloads on first use (text
recognition, about 5 to 8 MB per language with the engine, `docs/api/ocr.md`; fonts, `app/fonts/`).
When any of that changes, change the page; the tests fail if the app's code starts using a kind of
browser storage the page doesn't describe, or if the Settings item names a tool choice the app
doesn't save with `setSetting` (or leaves out one it saves). Other facts about the web app that
the page states: Open shows a file in a new browser tab (`core/output.js` `openFile`); files reach
the app by picking, dropping, pasting, sharing, or opening them with the installed app
(`manifest.webmanifest` `share_target` and `file_handlers`); only the tools used once work offline
(`sw.js`); and a share reaches the app only through its service worker.

## How the pages are put together

Every page has the same parts, in this order, written out in full in each file. There is no
template system for the four hand-written pages, so a change to a shared part is made in all four;
then run `node tools/build-tool-pages.mjs`, which copies the head, header and footer from Download
into the tool pages (the tests fail until you do):

1. `<head>`: charset, viewport, a `Content-Security-Policy` meta (see below), a `referrer` meta
   (`no-referrer`, so links to GitHub, Obtainium or F-Droid don't tell those sites the visitor
   came from Usugami), title and description, `color-scheme`, two `theme-color` metas (light and
   dark), the theme script, favicons (`icon.svg`, `icon-32.png`, `apple-touch-icon.png`),
   `tokens.css`, `site.css`, the canonical and Open Graph tags (the page's absolute address on
   `https://usugami.com/`, its title and description again, and `og:image`
   `https://usugami.com/assets/img/social-preview.png` with its `og:image:alt`), and structured
   data for search results (see [Search engines](#search-engines)). The 404 page has the
   `referrer` meta but no canonical, Open Graph or structured data, and `noindex`.
2. A skip link ("Skip to content", to `#main`), then the header: the icon and "Usugami" (to Home),
   and the navigation (Home, Web app, Download, Privacy). The current page's link has
   `aria-current="page"`. The navigation is written twice: `.nav-wide` (a row of links, 720 px
   and wider) and `.nav-menu`, a `<details>` menu for phones that opens without JavaScript. Only
   one is displayed at a time, so screen readers meet it once.
3. `<main id="main">` with the page's sections. Each page has exactly one `h1`, and headings go
   down one level at a time (the tests check this).
4. The footer: the icon, two groups of links (`.footer-nav`): "Android app" (source code,
   releases, questions and ideas, report a problem) and "This website and the web app" (its source
   code, https://github.com/Nath-Goa/usugami-website, its third-party notices,
   `.../blob/main/THIRD_PARTY_NOTICES.md`, and privacy), "No cookies · No tracking · No ads", the
   license line (which links the notices again), and the hidden language switcher. Only `site/`
   is deployed, and some of the bundled libraries' and fonts' licenses ask for their notices to be
   reachable, so every page must keep the two links to the website's repository (the tests check
   it, and the Download page's Source code section has them too).

Links are always relative (`download/`, `../privacy/#on-the-web`), never starting with `/`, so the
site works at the root of usugami.com and in the `usugami-website/` sub-folder on github.io. Links
to other sites (GitHub, Obtainium, F-Droid) are ordinary `https://` links.

Icons are inline SVG paths from Material Symbols Rounded (`@material-design-icons/svg/round`,
Apache-2.0), the same set as the web app: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"
focusable="false"><path d="..."/></svg>`. To add one, copy the inner part of
`node_modules/@material-design-icons/svg/round/<name>.svg`.

### Styles

`site.css` uses only the variables from `tokens.css`, plus a few page-level ones defined at its top
(`--page-card`, `--page-band`, `--page-hero-glow`, `--page-code`, `--page-header`, `--page-bezel`)
with their dark values in the same three blocks as the tokens (system dark, `data-theme="dark"`).
It is phone first: the base styles are for 320 px and up, and `min-width` media queries add
columns at 600, 720, 840, 960 and 1080 px. It uses logical properties (`margin-inline-start`,
`inset-block-start`) so a right-to-left language could come later. No text lives in the CSS.

Main components: `.btn` (`.btn-filled`, `.btn-tonal`, `.btn-outlined`, `.btn-large`), `.card`,
`.icon-badge`, `.section` (`.section-band` for a tinted band), `.section-head` with `.eyebrow`,
`.pills`, `.shots` (the screenshots: a swipeable row with scroll snapping on phones, four columns
from 840 px), `.feature-grid` and `.feature` (`.compact` for the Everywhere group), `.points`,
`.editions` (`.compare` on Download: on wide screens the rows of the three cards line up with
CSS subgrid), `.source-grid`, `.source-pair` (two cards side by side from 840 px), `.link-list`,
`.steps` (numbered install steps), `.disclosure` (`<details>` blocks), `.note`, `.kv`, `.toc`,
`.prose`, `.doc-toc` (the policy's sticky section list from 1080 px), `.nowrap` (a file name kept
on one line), `.link-note` (a note inside a `.link-list` link, after its text, such as "(the main
edition)": not underlined and kept whole, so on phones it moves under the link's text),
`.source-action` (a button in a card's text, such as "Add to F-Droid") and the footer's
`.footer-nav`, `.footer-group` and `.footer-label`.

Everything people tap is at least 48 px tall at every width (a tablet held sideways is wide but
touched), except the policy's section list, which is 40 px with a mouse and 48 px under
`(pointer: coarse)`.

Home's feature groups (Create PDF 7 cards, Organize 5, Edit and sign 4, Optimize and protect 3,
Everywhere 9) never leave a row part filled, whatever their number of cards: one card to a row on
phones; two from 720 px, where a last card on its own takes the whole row (with its list beside
its name); three from 1080 px, on a six-column grid, where the cards after the last full row of
three come two to a row instead (3n + 2 cards end with one row of two, 3n + 1 cards with two
rows of two). The rules use only `:nth-child` and `:nth-last-child`, so adding or removing a card
needs no change; the tests check that every row reaches both edges at 720 to 1440 px.

Code blocks on Download: the lines to paste into AppVerifier (`pre.select-all`) wrap instead of
scrolling; the command blocks keep their lines and scroll sideways on phones, so each has
`tabindex="0"`, `role="region"` and an `aria-label` (Safari doesn't let the keyboard reach a
scroller by itself).

`tokens.css` also has `--paper` (`#ffffff` in both themes): the web app puts it behind page
pictures (thumbnails, page strips), as the Android app's `PdfThumbnail` fills its box with white.

### The theme script

Each page has the same small inline script in its `<head>`, before the stylesheets. It reads
`JSON.parse(localStorage['usugami.settings']).appearance` (written by the web app's Settings) in a
`try` block: `"light"` or `"dark"` sets `<html data-theme>` (and the `theme-color` metas), anything
else (no setting, `"system"`, storage blocked, bad JSON) leaves the device's theme. The pages
never write to storage and set no cookies.

### Content-Security-Policy

Each page has a `<meta http-equiv="Content-Security-Policy">` that allows only the site's own
files (`default-src 'self'`), no inline styles, and only its own inline scripts, listed by their
SHA-256 hash. The browser itself then refuses any outside resource, which backs up the
no-tracking promise. **If you change an inline script (even its comments or spaces), its hash
changes**: run `node tools/check-site.mjs`, which prints the new `'sha256-...'` value to put in
`script-src` in place of the old one. Translators should leave the scripts as they are, so the
hashes stay the same. Don't add `style="..."` attributes or `<style>` elements; use `site.css`.

### The 404 page

GitHub Pages serves `site/404.html` for every unknown address at any depth (for example
`.../usugami-website/a/b/c`), so links relative to the address would point to the wrong place. The
404 page's first script works out the site's root from the address: on `*.github.io`, or when the
first folder of the path is `usugami-website` on a host other than usugami.com (local previews
with `node tools/serve.mjs --prefix usugami-website`), the root is that first folder; anywhere
else it is `/`. On usugami.com (and www.usugami.com) the root is always `/`, even for an address
that starts with `usugami-website/` (someone who kept the old sub-folder path and only changed the
domain). It then writes `<base href="(root)">` and the stylesheet and icon links
with `document.write`, so that every relative link on the page starts from the root. The
stylesheets aren't in the markup because browsers fetch the addresses in the markup before
scripts run, at the wrong place. The icon in the header and footer is inline SVG for the same
reason, and the page has no `#` links (they would resolve against the root too).

Without JavaScript, a `<noscript>` block loads the stylesheets relative to the address, which works
for addresses one level deep (the most common typo, such as `.../usugami-website/downlod`), and a
note links to `https://usugami.com/`. **If the repository is renamed**, change `usugami-website`
in that script (and then its hash in the page's Content-Security-Policy). The tests open the 404
page through a proxy at usugami.com, www.usugami.com and github.io addresses and check its base,
styles and links.

## Images

| File | Source |
|---|---|
| `img/icon.svg` | `pdfer/docs/icon.svg`, the launcher icon (lavender circle, purple pages) |
| `img/icon-32.png`, `icon-192.png`, `icon-512.png` | Rendered from `icon.svg` with Playwright, transparent corners |
| `img/apple-touch-icon.png` (180 px), `icon-maskable-512.png` | The pages on a full lavender square (`#E8DEF8`), for iOS and for a maskable web app icon (the pages sit inside the safe zone) |
| `img/screenshots/*.png` | `pdfer/docs/screenshots/` (540 x 1200), alt text from the README |
| `img/screenshots/*.webp` | The same screenshots encoded by Chromium as WebP at quality 0.85 (`canvas.toDataURL('image/webp', 0.85)`): 145 KiB for the four instead of 227 KiB, with text as sharp. Pages show them through `<picture>` with the PNG as the fallback. |
| `img/badges/*.png` | `pdfer/docs/badges/`: "Get it on GitHub" (Kunzisoft/Github-badge, CC BY-SA 3.0, based on the F-Droid badge by flocke) and the Obtainium badge (GPL-3.0). Their credits are on the Download page and must stay there. |
| `img/social-preview.png` | `pdfer/docs/social-preview.png` (1280 x 640), the pages' `og:image` |

To render the PNG icons again after changing `icon.svg`, open each size in Playwright and take a
screenshot with a transparent background, for example:

```js
import { chromium } from 'playwright';
const svg = (await import('node:fs')).readFileSync('site/assets/img/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [32, 192, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body>`);
  await page.screenshot({ path: `site/assets/img/icon-${size}.png`, omitBackground: true });
}
await browser.close();
```

For the full-square versions, draw `<rect width="108" height="108" fill="#E8DEF8"/>` behind the
pages' `<g>` with `viewBox="18 18 72 72"` (Apple) or `viewBox="0 0 108 108"` (maskable).

Every `<img>` has `width` and `height` (no layout shift) and `alt` (empty when the image only
decorates). Images below the fold have `loading="lazy"`; the hero's fanned screenshots are lazy
too, because they are hidden on phones and lazy hidden images aren't downloaded. Screenshots are
`<picture><source type="image/webp" srcset="....webp"><img src="....png" ...></picture>`, keeping the
`<img>`'s classes and attributes (`picture` is `display: block` in `site.css`). After changing a
screenshot, encode its WebP again the same way; the tests check that a phone loads less than
166 KiB of images on Home.

## Adding French, Spanish and Hindi

The web app's languages live in `site/app/locales/`. The website pages are translated by copying
them into a folder per language:

1. Copy the pages: `site/index.html` to `site/fr/index.html`, `site/download/index.html` to
   `site/fr/download/index.html`, and `site/privacy/index.html` to `site/fr/privacy/index.html`.
   (Likewise `es/` and `hi/`.) The 404 page stays English only: GitHub Pages serves only the root
   `404.html`. The tool pages are written by `tools/build-tool-pages.mjs`, which writes English
   only today: it would need each language's words and to copy the translated Download's parts.
2. Make every relative path one level deeper: `assets/` becomes `../assets/`, `../assets/`
   becomes `../../assets/`, and the same for the links to `app/`, `download/` and `privacy/`
   (keep links between the translated pages inside the language folder: from `fr/index.html`,
   `download/` is `fr/download/`). Run `node tools/check-site.mjs`: it reports any path that
   doesn't exist and any `#anchor` that is missing.
3. Set `<html lang="fr">` (`es`, `hi`) and translate the text: titles, descriptions, headings,
   paragraphs, `alt` texts and `aria-label`s. Keep the ids (`#install`, `#verify`, ...) in English
   so links keep working, and leave the scripts unchanged (their hashes are in the
   Content-Security-Policy). Use the app's own translations for its words: tool names, details and
   button names are in `pdfer/app/src/main/res/values-fr/strings.xml` (`values-es`, `values-hi`).
   Home's feature texts are translated in the app's `fastlane/metadata/android/fr-FR/`, `es-ES/`
   and `hi-IN/` (`full_description.txt`, `short_description.txt`). For Hindi, the system fonts with Devanagari are already in `--font`, and `.eyebrow` drops its
   upper case and letter spacing under `:lang(hi)`.
4. Show the language switcher: in every page's footer, remove `hidden` from
   `<nav class="lang-switch">` and un-comment the links (each page links to the same page in the
   other languages, `aria-current="true"` on its own language).
5. Add `hreflang` alternates to every page's `<head>`, listing every
   language including its own and `x-default` (absolute URLs are allowed here):
   `<link rel="alternate" hreflang="fr" href="https://usugami.com/fr/">`.

## The tool pages

Each tool has a page of its own at the site's root, named for what people search for:
`scan-to-pdf/`, `images-to-pdf/`, `ocr-pdf/`, `word-to-pdf/`, `powerpoint-to-pdf/`,
`excel-to-pdf/`, `epub-to-pdf/`, `merge-pdf/`, `split-pdf/`, `reorganize-pdf/`,
`delete-pdf-pages/`, `rotate-pdf/`, `edit-pdf/`, `sign-pdf/`, `add-page-numbers-to-pdf/`,
`watermark-pdf/`, `compress-pdf/`, `redact-pdf/` and `flatten-pdf/`. A page says what the tool
does in the web app and how to use it, and its first button opens the tool there
(`../app/#/tool/<id>`; the text recognition page opens Images to PDF, where it is). On Home, each
tool's name in its feature card links to its page (`<a class="feature-link">`; the whole top of
the card takes the tap, with a chevron at its end).

`node tools/build-tool-pages.mjs` (or `npm run tool-pages`) writes them, and `site/sitemap.xml`
with them. Their words are in `tools/tool-pages.mjs`: per tool the address (`slug`), Home's feature
card (`card`), the web app's tool it opens (`opens`) and, where "Open <tool>" would read badly, the
button's own text (`button`, such as "Watermark a PDF"), its name, title, description, heading, lead,
steps, what it can do and its questions; and the parts every tool page shares (`SHARED`). Everything
else comes from the hand-written pages: the head (Content-Security-Policy and theme script
included), header and footer from Download, without its `aria-current`; the groups, their order
and each tool's icon from Home's feature cards (not Everywhere); the two buttons with their notes
and the promise pills from Home's hero. So after changing those parts of Download or Home, run the
script again; `tests/site.test.mjs` fails while a tool page or the sitemap differs from what the
script would write, and `node tools/build-tool-pages.mjs --check` says which. Don't edit the
generated files by hand.

A tool page is: the hero (the tool's icon and group, the `h1`, a lead, **Open <tool>** and **Get the
Android app**, the pills), "How to ..." (numbered steps, the first one generated: open the tool
with the button), what the tool can do (`.tool-list`), how files are handled (with a link to
`../privacy/#on-the-web`), Questions (the tool's own, then the shared ones), and More PDF tools
(`.tool-index`: every tool by group, the page's own marked `aria-current="page"`).

Every statement on a tool page must be true of the web app as it is: take option names, labels
and numbers from the app's strings (`site/app/locales/en/`) and code, as Home's feature cards do,
and change the page when the tool changes. The script refuses words that would break the page or
the site's style: straight quotes or apostrophes (write ’ “ ”), em dashes, a bare `&`, tags other
than `<strong>`, `<em>` and `<code>`, a title over 65 characters or not ending in ": Usugami", and
a description outside 110 to 160 characters.

## Search engines

- **Titles and descriptions**: each page's `<title>` (at most about 60 characters, ending in
  ": Usugami" on the inner pages) and `<meta name="description">` (about 150 to 160 characters,
  as much as results show), repeated in `og:title` and `og:description`.
- **Canonical addresses**: every page but the 404 names its address on `https://usugami.com/`, the
  web app's page (`app/index.html`) included.
- **Structured data** (`<script type="application/ld+json">` in the `<head>`, which browsers don't
  run, so the Content-Security-Policy doesn't block it): Home has `WebSite` (the site's name for
  results); Download, Privacy and the tool pages have a `BreadcrumbList` from Home to the page. No
  `SoftwareApplication`: Google wants ratings or reviews with it, and the site has none.
- **The sitemap** (`site/sitemap.xml`) lists Home, the web app, the tool pages, Download and
  Privacy, without dates (an old date is worse than none); `robots.txt` names it. Search
  engines find it there; it can also be submitted in Google Search Console and Bing Webmaster
  Tools.
- **The web app's title**: `app/index.html`'s `<title>` and the tab's title on the app's Home
  (`web_home_title` in `app/locales/en/common.js`, set by `core/router.js`) are the same,
  "Usugami: free PDF tools in your browser", because search engines read the title after the
  app has run.

## The domain

usugami.com is set as the custom domain in the repository's Pages settings (there is no `CNAME`
file, and the checker refuses one), and `https://nath-goa.github.io/usugami-website/` redirects
there. The pages' canonical and Open Graph tags give their addresses on `https://usugami.com/`
(the tests check each one). HTTPS is enforced: `http://usugami.com/`, `http://www.usugami.com/`,
`https://www.usugami.com/` and the github.io address all redirect (301) to `https://usugami.com/`
(checked 2026-11-09). Keep "Enforce HTTPS" ticked in the Pages settings: on plain http the web app
can't work offline, be installed or receive shared files (no service worker), and its settings and
Recent files would be kept for the http address only. Still to do:

- Add the `hreflang` alternates when there are translations (and the translated pages to the
  sitemap: `tools/build-tool-pages.mjs` writes it).

## Checking the site: `tools/check-site.mjs`

```sh
node tools/check-site.mjs                        # the whole site
node tools/check-site.mjs site/index.html site/download   # only some files or folders
```

It uses Node's built-in modules only, prints the problems by file and line, and exits with code 1
if there are any. It scans `site/**/*.html`, `.css`, `.js`, `.mjs` and `.webmanifest` and fails on:

- **Root-relative URLs** (`/...`) in any `href`, `src`, `srcset`, `action`, CSS `url()` or
  `@import`, JavaScript `import`, `fetch`, `new URL`, `importScripts`, `Worker`,
  `serviceWorker.register`, and manifest `src`, `start_url`, `scope`, `action`, `url` and `id`.
- **Outside resources** (`http://`, `https://`, `//`) in the same places, except `<a href>` and
  `<link rel="alternate">` / `rel="canonical"` (ordinary links to other sites are fine). The
  JavaScript scan skips `site/app/vendor/`, whose libraries contain default URLs that the app
  overrides.
- **Cookies and tracking**: `document.cookie`, `cookieStore`, `navigator.sendBeacon`, the `ping`
  attribute, and the names of analytics and tracking services as they appear in code (Google
  Analytics and Tag Manager, Plausible, Matomo, Umami, Fathom, Mixpanel, Segment, Hotjar, Clarity,
  PostHog, Sentry, the Facebook pixel and others).
- **A `CNAME` file** in `site/` or the repository root.
- **Missing targets**: every relative `href`, `src`, `srcset`, CSS `url()`, `import`, and
  `new URL(..., import.meta.url)` that names a file (has an extension) must exist, with the same
  upper and lower case (GitHub Pages is case-sensitive, Windows isn't). A link to a folder needs its
  `index.html`; a `new URL` without an extension may be a folder used as a base or a route the
  service worker answers (a share target), so it isn't required to exist. Bare imports such as
  `'pdf-lib'` are refused (browsers need `./`).
- **Missing anchors**: `#id` links on the same page or another page (`download/#install`) must
  match an `id` there. App routes such as `#/tool/split` are skipped.
- **Content-Security-Policy**: an inline script whose hash isn't in the page's `script-src` (the
  message gives the hash to add), and inline styles the policy would block.
- **Structured data** (`<script type="application/ld+json">`) that isn't valid JSON, or an item
  without `"@context": "https://schema.org"` and an `@type`.
- **Duplicate ids** on a page.

Comments in HTML, CSS and JavaScript are ignored, so commented-out examples don't count.

From a script: `import { checkSite, stripJsComments } from './tools/check-site.mjs'`, then
`checkSite({ siteDir, only })` returns `{ problems: [{ file, line, message }], files }`. `siteDir`
defaults to `site/`; `only` is a list of files or folders (absolute or relative to the working
directory) to check, while links are still resolved against the whole site. For example:

```js
const { problems } = checkSite({ only: ['site/index.html'] });
if (problems.length) console.log(problems.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'));
```

`stripJsComments(source)` returns JavaScript with its `//` and `/* */` comments blanked out (strings,
template literals and regular expressions kept, line breaks kept so line numbers stay right).

## Tests: `tests/site.test.mjs`

```sh
node tests/site.test.mjs
```

It runs `checkSite` on the website pages, tool pages included (no problems allowed, and each page
must have its Content-Security-Policy), then on a small site full of deliberate mistakes (each must
be reported, and nothing else). It then reads the pages and checks what they must say: the tool
pages and the sitemap are as `tools/build-tool-pages.mjs` would write them; every footer links to
the website's source code, its third-party notices and the app's source code, and every page has
the `no-referrer` meta; `robots.txt` allows every page and names the sitemap, which lists Home,
the web app, the tool pages, Download and Privacy in that order; each of those has one canonical
address on `https://usugami.com/`, Open Graph tags with the same title and description and the
image's alt text, a title of at most 65 characters and a description of at most 160, and its
structured data (`WebSite` on Home, a `BreadcrumbList` from Home elsewhere, none on the web app);
the 404 page has none of it (its noscript note links to `https://usugami.com/`); each of Home's
tool cards links to its tool page, and each tool page opens a tool the web app has as its first
link, says files aren't uploaded, links to Download, the Privacy page's web part and every other
tool page; Home's hero opens the web app first, and Home names every tool, the Usugami
watermark ("Off unless you turn it on") and that files are never uploaded, and links to the web app,
Download, Privacy and the website's source and notices, promises offline use only for the tools
used once, and says the web app is "in English for now" exactly while `app/locales/languages.js`
lists English alone; Download links to the three APKs, the
releases, the three Obtainium links, `nathank.me/usugami/`, the web app and the website's source
and notices, has the one-tap `fdroidrepos://` link with the repository fingerprint and the
by-hand steps (Settings → Repositories → +), gives the F-Droid address and fingerprint, what the
repository serves and the signing certificate, and every `<pre>` either wraps (`select-all`) or
is focusable and named; Privacy's web part names the text-recognition download (about 5 to 8 MB, from
this same website), fonts, local storage with the Usugami watermark settings, IndexedDB, the
service worker and shared files, files opened with the installed app, Open showing a file in a
browser tab, and that a share needs the service worker. It also scans the web app's own JavaScript (not `vendor/`,
comments left out) for `localStorage`, `sessionStorage`, `indexedDB`, `caches.open/match/keys`
and `storage.getDirectory`, and fails if the Privacy page doesn't describe one that is used (so a
new kind of storage needs a line on the Privacy page first), and for the `setSetting` keys: the
Settings item must name each tool choice saved and nothing else. Then it opens Home, Download,
Privacy, every tool page and the 404 page (at `no/such/page/here`) in the `usugami-website/` sub-folder at
320 x 640, 412 x 915, 768 x 1024 and 1280 x 800 in Chromium, and at 360 x 740 in Firefox and
WebKit, and checks: no page errors, console errors or outside requests; no sideways scrolling; every image
loads and has `width`, `height` and `alt`; `lang`, title, description, viewport, theme-color and
icon; every internal link, stylesheet and image answers 200, and every `#anchor` exists; one `h1`
and no skipped heading levels; no cookies or storage writes; touch targets of at least 48 px on
phones (Home's linked card tops too) and at 1280 px; the phone menu, the skip link and the swipeable screenshots; the wide navigation and the
lined-up edition rows; Home's feature rows each filling the width (also at 720, 900, 1079, 1080
and 1440 px) and its screenshots shown as WebP, with under 166 KiB of images loaded on a phone;
Download's code blocks (those that scroll sideways can be focused, in WebKit too) and the
Obtainium "(the main edition)" note kept whole; no `Referer` sent when the footer's source link is
followed (Chromium, Firefox and WebKit, with github.com stubbed); the 404 page's links leading to
the root, and, through a proxy, its root at usugami.com, www.usugami.com and github.io addresses;
and the theme following the web app's `appearance` setting (and ignoring bad values), with
`--paper` staying white in dark mode. Full-page screenshots go to
`tests/output/site-<page>-<browser>-<width>.png`, with dark ones (`-dark.png`) at 320, 412 and
1280 px: look at them after changing the pages.
