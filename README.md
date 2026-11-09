# Usugami website

The website and web app for [Usugami](https://github.com/Nath-Goa/usugami), the free, open-source
Android app that turns photos, Word, PowerPoint, Excel and EPUB files into PDFs and splits,
merges, edits, signs, compresses and redacts PDFs.

- **Website**: Home, Download and Privacy pages.
- **Web app** (`site/app/`): Usugami's tools in the browser, on phones and desktops, with the
  same options and wording as the Android app. Files are processed on your device and never
  uploaded.

Everything is static files in `site/`, served by GitHub Pages. There is no build step: the
libraries are copied into `site/app/vendor/` and committed.


## What is where

```
site/                   the website as it is served
  index.html            Home
  download/             Download
  privacy/              Privacy
  404.html              page for addresses that don't exist
  assets/               the pages' CSS (tokens.css: colours, light and dark) and images
  app/                  the web app: index.html, sw.js (offline), manifest.webmanifest,
                        js/, css/, locales/ (strings), fonts/, icons/
    vendor/             libraries, copied from node_modules by npm run vendor
tools/                  serve.mjs (preview server), check-site.mjs (site checks),
                        vendor.mjs (copies libraries), build-icons.mjs (icons)
tests/                  browser tests: harness.mjs, run.mjs, one <area>.test.mjs per area
docs/                   ARCHITECTURE.md (how the app is built: read this first),
                        api/ (each part's functions)
licenses/               license texts of bundled components that don't ship their own
.github/workflows/      ci.yml (checks and tests), pages.yml (deployment)
LICENSE                 GPL-3.0
THIRD_PARTY_NOTICES.md  every third-party component in site/, with its license
```


## Preview on your computer

You need [Node.js](https://nodejs.org/) 24 or later. Once, in this folder:

```sh
npm install
```

Then start the preview server and open http://localhost:8080/:

```sh
npm run serve
```

Other ways to run it:

- **In a sub-folder, as on GitHub Pages** before usugami.com is linked:
  `node tools/serve.mjs --prefix usugami-website`, then open
  http://localhost:8080/usugami-website/. Use this to check that no link starts with `/`.
- **On a phone on the same Wi-Fi**: `node tools/serve.mjs --host 0.0.0.0` prints the address to
  open on the phone (allow Node through the firewall if your computer asks). Browsers only allow
  some features on secure (https) pages, so offline use, installing the app and sharing don't
  work at that address; on the computer, http://localhost is treated as secure.
- **Without Node**: `python -m http.server 8080 --directory site`, then open
  http://localhost:8080/.

Opening `site/index.html` straight from disk shows the pages, but the web app doesn't work that
way: browsers block JavaScript modules on `file://` addresses. Use one of the servers above.


## Tests

The tests open the site in real browsers with Playwright. Once, after `npm install`:

```sh
npx playwright install
```

Then:

```sh
npm test                        # every test file
npm test -- split merge         # only files whose names contain "split" or "merge"
node tests/split.test.mjs       # one file
npm run check                   # site checks (tools/check-site.mjs)
```

GitHub runs the checks and all the tests on every pull request and every push to `main`
(`.github/workflows/ci.yml`).


## Deployment

Every push to `main` publishes `site/` to GitHub Pages (`.github/workflows/pages.yml`). You can
also run it by hand: **Actions > Deploy to GitHub Pages > Run workflow**. The workflow runs the
site checks, stamps `site/app/sw.js` with the commit (its line `const VERSION = 'dev';` becomes the
short commit hash, so visitors' offline copies update) and deploys. Nothing else is built or
changed.

One-time setup:

1. Make sure the branch is called `main` (to rename it: `git branch -m main`), and push it to
   https://github.com/Nath-Goa/usugami-website.
2. In the repository's **Settings > Pages**, under **Build and deployment**, set **Source** to
   **GitHub Actions**.
3. Run the workflow (or push to `main`). The site appears at https://nath-goa.github.io/usugami-website/.


## Linking usugami.com later

No file in the repository needs to change: every link in the site is relative, and with
deployment by Actions GitHub doesn't use a `CNAME` file.

1. **Verify the domain** (so nobody else can use it with GitHub Pages): your profile picture >
   **Settings > Pages > Add a domain**, enter `usugami.com`, and add the TXT record it shows at
   your DNS provider. Wait until GitHub says it's verified.
2. **DNS records** at your DNS provider:
   - `usugami.com` (the apex, often written `@`): four **A** records, `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153`, `185.199.111.153`, and four **AAAA** records,
     `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.
   - `www.usugami.com`: a **CNAME** record pointing to `nath-goa.github.io`.
3. In the repository's **Settings > Pages**, enter `usugami.com` under **Custom domain** and save.
   GitHub checks the DNS records (this can take up to a day while DNS updates).
4. When the certificate is ready, tick **Enforce HTTPS**.

The github.io address then redirects to usugami.com, and `www.usugami.com` to `usugami.com`.
Browsers keep settings, Recent files and installed apps per address, so people who used the app
at the github.io address start fresh at usugami.com.


## Updating the libraries

The libraries the app uses are listed in `package.json` and copied into `site/app/vendor/`.

1. Change the version in `package.json` (or check out the branch of a Dependabot pull request).
2. `npm install`
3. `npm run vendor` (rewrites `site/app/vendor/` and its `VERSIONS.json`)
4. `npm test`, and try the app with `npm run serve`.
5. Update the versions in `THIRD_PARTY_NOTICES.md` (its last section says what else to check).
6. Commit `package.json`, `package-lock.json`, `site/app/vendor/` and `THIRD_PARTY_NOTICES.md`.

Dependabot proposes updates every week. Its npm pull requests change only `package.json` and
`package-lock.json`, so when they update a library in `site/app/vendor/`, CI fails until steps 2
to 6 are done on the same branch. Updates to the development tools (esbuild, Playwright) need
only the tests. After updating `@material-design-icons/svg`, run `node tools/build-icons.mjs`.


## Adding a language

The web app's strings are in `site/app/locales/<language>/`, with the same keys as the Android
app's `strings.xml`, so French, Spanish and Hindi can be taken from the app's translations. See
the Strings section of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the app, and
`docs/website.md` for the website pages.


## Privacy

- **Files stay on the device.** Everything runs in the browser; nothing is uploaded.
- **No outside requests.** No CDNs, outside fonts, analytics, trackers or cookies: the site
  serves every file it uses itself. Links to other sites are ordinary links.
- **Only two kinds of storage, both on the device:** settings in `localStorage` and the Recent
  files list in IndexedDB. The Privacy page describes them; nothing else is stored.

Keep it that way when changing the site. The rules are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).


## License

The website and web app are free software: you can redistribute them and/or modify them under the
terms of the [GNU General Public License](LICENSE), version 3 or (at your option) any later
version. Copyright (C) 2026 Nathan Kumtakar.

Components by others are listed, with their licenses, in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
