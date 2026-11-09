# Third-party notices

The Usugami website and web app (this repository) are free software, licensed under the GNU
General Public License version 3 or later (see [LICENSE](LICENSE)). Copyright (C) 2026 Nathan
Kumtakar.

The site in `site/`, which is what GitHub Pages serves, includes libraries, fonts, data files and
images made by other people. This file lists each of them with its version, source, copyright and
license, and says where its license text is:

- next to the files in `site/`, served with the site (for example `site/app/vendor/pdfjs/LICENSE`);
- in [licenses/](licenses/), for texts the packages don't ship themselves, and in
  [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) for the Apache License 2.0.

Paths are relative to the root of the repository. Library versions are the ones in
`site/app/vendor/VERSIONS.json`, which `npm run vendor` writes. Update this file when they change
(see the last section).

Contents

1. pdf-lib
2. fontkit
3. fflate
4. PDF.js, with its data files and decoders
5. Tesseract.js, its engine and language data
6. libheif, for HEIC photos
7. Emscripten runtime in the WebAssembly files
8. Fonts
9. Icons and badges
10. License texts in licenses/
11. Keeping this file up to date


## 1. pdf-lib

### @cantoo/pdf-lib 2.11.1

Creates and changes PDFs. `site/app/vendor/pdf-lib/pdf-lib.esm.min.js`.

- Source: https://github.com/cantoo-scribe/pdf-lib (Cantoo's maintained fork of
  https://github.com/Hopding/pdf-lib)
- Copyright (c) 2019 Andrew Dillon
- License: MIT. Text: `site/app/vendor/pdf-lib/LICENSE.md`

The file is pdf-lib's own prebuilt bundle. It also contains the following, in the versions chosen
by @cantoo/pdf-lib 2.11.1's build:

| Component | Copyright | License | Text |
|---|---|---|---|
| [culori](https://github.com/Evercoder/culori) (colour parsing), with Okhsl/Okhsv code by Björn Ottosson | Copyright (c) 2018 Dan Burzo; Copyright (c) 2021 Björn Ottosson | MIT | [licenses/culori.txt](licenses/culori.txt) |
| [html-entities](https://github.com/mdevils/html-entities) | Copyright (c) 2021 Dulin Marat | MIT | [licenses/html-entities.txt](licenses/html-entities.txt) |
| [node-html-better-parser](https://github.com/Sharcoux/node-html-parser) | Copyright 2019 Tao Qiufeng | MIT | [licenses/node-html-better-parser.txt](licenses/node-html-better-parser.txt) |
| [tslib](https://github.com/microsoft/tslib) | Copyright (c) Microsoft Corporation | 0BSD | [licenses/tslib.txt](licenses/tslib.txt) |
| fflate | see section 3 | MIT | `site/app/vendor/fflate/LICENSE` |
| [@pdf-lib/standard-fonts](https://github.com/Hopding/standard-fonts): metrics of the 14 standard PDF fonts, made from Adobe's Core 14 AFM files | Copyright (c) 2018 Andrew Dillon; AFM files Copyright Adobe Systems Incorporated | MIT; Adobe's AFM terms | [licenses/pdf-lib-standard-fonts.txt](licenses/pdf-lib-standard-fonts.txt) |
| PNG decoder and encoder ported from [UPNG.js](https://github.com/photopea/UPNG.js) (by way of [@pdf-lib/upng](https://github.com/Hopding/upng)) | Copyright (c) 2017 Photopea | MIT | [licenses/UPNG.js.txt](licenses/UPNG.js.txt) |
| Base64 code from [base64-arraybuffer](https://github.com/niklasvh/base64-arraybuffer) | Copyright (c) 2012 Niklas von Hertzen | MIT | [licenses/base64-arraybuffer.txt](licenses/base64-arraybuffer.txt) |
| SVG path code from [PDFKit](https://github.com/foliojs/pdfkit) | Copyright (c) 2014 Devon Govett | MIT | [licenses/pdfkit.txt](licenses/pdfkit.txt) |
| Stream decoders and decryption code from [PDF.js](https://github.com/mozilla/pdf.js) | Copyright 2012 Mozilla Foundation; the Flate decoder also Copyright 1996-2003 Glyph & Cog, LLC | Apache-2.0 | [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) |


## 2. fontkit

### @cantoo/fontkit 2.0.12

Reads fonts and lays out text (including Devanagari shaping) for the text the app writes into
PDFs. `npm run vendor` bundles it with its dependencies into one file:
`site/app/vendor/fontkit/fontkit.esm.min.js`.

- Source: https://github.com/cantoo-scribe/fontkit (a fork of https://github.com/foliojs/fontkit)
- Copyright (c) 2014-present Devon Govett
- License: MIT. Text: `site/app/vendor/fontkit/LICENSE`

The bundle also contains, in the versions locked in `package-lock.json`, the parts below. Their
license texts, with fontkit's, are also in `site/app/vendor/fontkit/fontkit.esm.min.js.LICENSE.txt`,
which the bundle's first line points at. `npm run vendor` writes that file from the list of
packages esbuild reports bundling.

| Component | Copyright | License | Text |
|---|---|---|---|
| [restructure](https://github.com/devongovett/restructure) 3.0.2 | Copyright (c) 2015-present Devon Govett | MIT | [licenses/restructure.txt](licenses/restructure.txt) |
| [dfa](https://github.com/devongovett/dfa) 1.2.0 | Devon Govett | MIT | [licenses/dfa.txt](licenses/dfa.txt) |
| [brotli](https://github.com/devongovett/brotli.js) 1.3.3 (the decoder, for WOFF2 fonts) | Devon Govett; decoder files Copyright 2013 Google Inc. | MIT; decoder files Apache-2.0 | [licenses/brotli.js.txt](licenses/brotli.js.txt), [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) |
| [base64-js](https://github.com/beatgammit/base64-js) 1.5.1 | Copyright (c) 2014 Jameson Little | MIT | [licenses/base64-js.txt](licenses/base64-js.txt) |
| fflate 0.8.3 | see section 3 | MIT | `site/app/vendor/fflate/LICENSE` |
| @cantoo/unicode-trie 1.0.5 and @cantoo/unicode-properties 1.0.5 (part of fontkit's source) | Copyright 2018, Devon Govett | MIT | [licenses/unicode-trie-and-unicode-properties.txt](licenses/unicode-trie-and-unicode-properties.txt) |
| Character property and shaping tables generated from the [Unicode Character Database](https://www.unicode.org/ucd/) | Copyright © 1991-2026 Unicode, Inc. | Unicode-3.0 | [licenses/Unicode-3.0.txt](licenses/Unicode-3.0.txt) |


## 3. fflate

### fflate 0.8.3

Reads and writes ZIP files (Word, PowerPoint, Excel and EPUB files are ZIPs; "Share or save as
ZIP") and compresses data. `site/app/vendor/fflate/fflate.esm.js`.

- Source: https://github.com/101arrowz/fflate
- Copyright (c) 2026 Arjun Barrett (as written in its license file)
- License: MIT. Text: `site/app/vendor/fflate/LICENSE`


## 4. PDF.js, with its data files and decoders

### PDF.js (pdfjs-dist 6.4.299)

Shows pages, finds text positions and renders pages to images.
`site/app/vendor/pdfjs/pdf.min.mjs` and `site/app/vendor/pdfjs/pdf.worker.min.mjs`.

- Source: https://github.com/mozilla/pdf.js (tag v6.4.299, build d0991a0d5)
- Copyright Mozilla Foundation (the files say "Copyright 2024 Mozilla Foundation")
- License: Apache-2.0. Text: `site/app/vendor/pdfjs/LICENSE`

These files come with it, in `site/app/vendor/pdfjs/`:

| Files | What they are | Copyright | License | Text |
|---|---|---|---|---|
| `cmaps/*.bcmap` | Character maps for Chinese, Japanese and Korean PDFs | Copyright 1990-2009 Adobe Systems Incorporated | BSD-3-Clause | `cmaps/LICENSE` |
| `standard_fonts/Foxit*.pfb` | Fonts for PDFs that use the standard fonts without embedding them | Copyright 2014 PDFium Authors | BSD-3-Clause | `standard_fonts/LICENSE_FOXIT` |
| `standard_fonts/LiberationSans-*.ttf` | Liberation Sans 1.07.4, for the same purpose | Copyright (c) 2007 Red Hat, Inc. | GPL-2.0 with font exceptions (the Liberation Fonts license) | `standard_fonts/LICENSE_LIBERATION` |
| `iccs/CGATS001Compat-v2-micro.icc` | Colour profile for turning CMYK into RGB, from [Compact-ICC-Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles) (revision bdd8466) | none (public domain dedication) | CC0-1.0 | `iccs/LICENSE` |
| `wasm/openjpeg.wasm`, `wasm/openjpeg_nowasm_fallback.js` | [OpenJPEG](https://github.com/uclouvain/openjpeg), the JPEG 2000 decoder, with pdf.js's wrapper | Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium, and the others named in the text; wrapper Copyright (c) 2024, Mozilla Foundation | BSD-2-Clause | `wasm/LICENSE_OPENJPEG`, `wasm/LICENSE_PDFJS_OPENJPEG` |
| `wasm/jbig2.wasm`, `wasm/jbig2_nowasm_fallback.js` | PDFium's JBIG2 decoder, with pdf.js's wrapper | Copyright 2014 The PDFium Authors; wrapper Copyright 2026 Mozilla Foundation | BSD-3-Clause and Apache-2.0 (PDFium); Apache-2.0 (wrapper) | `wasm/LICENSE_JBIG2`, `wasm/LICENSE_PDFJS_JBIG2` |
| `wasm/qcms_bg.wasm` | [qcms](https://github.com/FirefoxGraphics/qcms), colour management, with pdf.js's wrapper | Copyright (C) 2009-2024 Mozilla Corporation; Copyright (C) 1998-2007 Marti Maria | MIT | `wasm/LICENSE_QCMS`, `wasm/LICENSE_PDFJS_QCMS` |
| `wasm/quickjs-eval.js`, `wasm/quickjs-eval.wasm` | [QuickJS](https://bellard.org/quickjs/), the sandbox pdf.js uses for JavaScript inside PDFs, built by [pdf.js.quickjs](https://github.com/mozilla/pdf.js.quickjs) | Copyright (c) 2017-2021 Fabrice Bellard; Copyright (c) 2017-2021 Charlie Gordon; pdf.js.quickjs Copyright (c) 2026 Mozilla Foundation | MIT | `wasm/LICENSE_QUICKJS`, `wasm/LICENSE_PDFJS_QUICKJS` (copies of [licenses/QuickJS.txt](licenses/QuickJS.txt) and [licenses/pdf.js.quickjs.txt](licenses/pdf.js.quickjs.txt)) |

pdfjs-dist 6.4.299 ships no license file for QuickJS; the two texts in `licenses/` are the ones
pdf.js added later (commit a3beacc). `npm run vendor` copies them next to the QuickJS files under
the names pdf.js gives them, unless pdfjs-dist ships those files itself.


## 5. Tesseract.js, its engine and language data

Text recognition ("Make text searchable"), loaded only when it is used. Everything is in
`site/app/vendor/tesseract/`.

### tesseract.js 7.0.0

`tesseract.esm.min.js` and `worker.min.js`.

- Source: https://github.com/naptha/tesseract.js
- Copyright the tesseract.js authors
- License: Apache-2.0. Text: `site/app/vendor/tesseract/LICENSE.md`

Its two prebuilt bundles also contain the following, in the versions chosen by tesseract.js
7.0.0's build. The notices it publishes beside them are served with them, unchanged, as
`tesseract.min.js.LICENSE.txt` and `worker.min.js.LICENSE.txt` (the files the bundles' first
comments name: `tesseract.esm.min.js` names `tesseract.min.js.LICENSE.txt`), and are collected in
[licenses/tesseract.js-bundled-notices.txt](licenses/tesseract.js-bundled-notices.txt).

| Component | Copyright | License | Text |
|---|---|---|---|
| [regenerator-runtime](https://github.com/facebook/regenerator) | Copyright (c) 2014-present, Facebook, Inc. | MIT | [licenses/regenerator-runtime.txt](licenses/regenerator-runtime.txt) |
| [buffer](https://github.com/feross/buffer) | Copyright (c) Feross Aboukhadijeh, and other contributors; parts Copyright Node.js contributors | MIT | [licenses/buffer.txt](licenses/buffer.txt) |
| [ieee754](https://github.com/feross/ieee754) | Copyright 2008 Fair Oaks Labs, Inc. | BSD-3-Clause | [licenses/ieee754.txt](licenses/ieee754.txt) |
| [base64-js](https://github.com/beatgammit/base64-js) | Copyright (c) 2014 Jameson Little | MIT | [licenses/base64-js.txt](licenses/base64-js.txt) |
| [zlib.js](https://github.com/imaya/zlib.js) (zlibjs) | Copyright (c) 2012 imaya | MIT | [licenses/zlib.js.txt](licenses/zlib.js.txt) |
| [bmp-js](https://github.com/shaozilee/bmp-js) | Copyright (c) 2014 @丝刀口 (shaozilee) | MIT | [licenses/bmp-js.txt](licenses/bmp-js.txt) |
| [is-url](https://github.com/segmentio/is-url) | No copyright line in its license (published by segmentio) | MIT | [licenses/is-url.txt](licenses/is-url.txt) |
| [idb-keyval](https://github.com/jakearchibald/idb-keyval) | Copyright 2016, Jake Archibald | Apache-2.0 | [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) |
| [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect) | No copyright line in its license (by Surma, published by Google Chrome Labs) | Apache-2.0 | [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) |

idb-keyval is tesseract.js's language-data cache. The web app turns that cache off
(`cacheMethod: 'none'` in `site/app/js/lib/tesseract.js`), so it stores nothing.

### tesseract.js-core 7.0.0

The recognition engine, compiled to WebAssembly: `core/tesseract-core-lstm.wasm.js`,
`core/tesseract-core-simd-lstm.wasm.js` and `core/tesseract-core-relaxedsimd-lstm.wasm.js` (the
worker picks the one the browser supports).

- Source: https://github.com/naptha/tesseract.js-core (tag v7.0.0)
- Copyright the tesseract.js-core authors
- License: Apache-2.0. Text: `site/app/vendor/tesseract/core/LICENSE`

It is built with Emscripten 4.0.15 (section 7) from these libraries, at the commits named in each
text in `licenses/`:

| Component | Copyright | License | Text |
|---|---|---|---|
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) 5.1.0, from the [Balearica/tesseract](https://github.com/Balearica/tesseract) fork (commit 2a9c1c4) | Hewlett-Packard Company, Google Inc. and the Tesseract authors | Apache-2.0 | [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) |
| [Leptonica](https://github.com/DanBloomberg/leptonica) | Copyright (C) 2001-2020 Leptonica | BSD-2-Clause | [licenses/Leptonica.txt](licenses/Leptonica.txt) |
| [libpng](https://github.com/glennrp/libpng) 1.6.38 | Copyright (c) 1995-2020 The PNG Reference Library Authors, and the others named in the text | libpng-2.0 | [licenses/libpng.txt](licenses/libpng.txt) |
| [zlib](https://github.com/madler/zlib) 1.2.12 | (C) 1995-2022 Jean-loup Gailly and Mark Adler | Zlib | [licenses/zlib.txt](licenses/zlib.txt) |
| The Independent JPEG Group's JPEG software (libjpeg) 9a. This software is based in part on the work of the Independent JPEG Group. | Copyright (C) 1991-2014, Thomas G. Lane, Guido Vollbeding | IJG | [licenses/libjpeg.txt](licenses/libjpeg.txt) |
| [LibTIFF](https://gitlab.com/libtiff/libtiff) | Copyright (c) 1988-1997 Sam Leffler; Copyright (c) 1991-1997 Silicon Graphics, Inc. | libtiff | [licenses/libtiff.txt](licenses/libtiff.txt) |
| [libwebp](https://chromium.googlesource.com/webm/libwebp) | Copyright (c) 2010, Google Inc. | BSD-3-Clause, with Google's patent grant | [licenses/libwebp.txt](licenses/libwebp.txt) |
| [GIFLIB](https://sourceforge.net/projects/giflib/) | Copyright (c) 1997 Eric S. Raymond | MIT | [licenses/giflib.txt](licenses/giflib.txt) |
| [OpenLibm](https://github.com/JuliaMath/openlibm) (built with the libraries above) | The Julia Project, and the FreeBSD and OpenBSD authors named in the text | MIT, BSD-2-Clause, ISC and public-domain parts | [licenses/openlibm.txt](licenses/openlibm.txt) |

### Language data: English, French, Spanish and Hindi

`lang/eng.traineddata.gz`, `lang/fra.traineddata.gz`, `lang/spa.traineddata.gz`,
`lang/hin.traineddata.gz`, from the npm packages @tesseract.js-data/eng, /fra, /spa and /hin
1.0.0 (folder `4.0.0_best_int`).

- What they are: Tesseract's "best" LSTM models
  ([tessdata_best](https://github.com/tesseract-ocr/tessdata_best)), converted to integers by
  the tesseract.js project ([naptha/tessdata](https://github.com/naptha/tessdata))
- Copyright the Tesseract authors
- License: Apache-2.0. Text: [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt), served with
  the site as `site/app/vendor/tesseract/core/LICENSE`. (The npm packages that carry the files
  declare MIT for their packaging.)
- Changed by Usugami: in `lang/hin.traineddata.gz`, `npm run vendor` removes two settings from
  the data's config part, `classify_misfit_junk_penalty 0.125` (with the comment above it) and
  `merge_fragments_in_matrix F`, then compresses the file again. The LSTM-only engine has neither
  setting and printed a warning for each. Every other part of the data, and the other three
  files, are unchanged.


## 6. libheif, for HEIC photos

### libheif 1.23.5, with libde265 1.0.15 (libheif-js 1.23.5)

Decodes HEIC photos in browsers that can't (Chrome, Firefox). `site/app/vendor/libheif/libheif-bundle.mjs`.

- libheif: https://github.com/strukturag/libheif. Copyright (c) 2017-2025 Dirk Farin.
- libde265 (the HEVC decoder inside it): https://github.com/strukturag/libde265.
  Copyright (c) 2013-2014 struktur AG, Dirk Farin.
- libheif-js (the Emscripten build packaged for npm): https://github.com/catdad-experiments/libheif-js,
  by Kiril Vatev.
- License: GNU Lesser General Public License, version 3 or (at your option) any later version.
  Text: `site/app/vendor/libheif/LICENSE` (the LGPL), which adds to the GNU GPL version 3 in
  [LICENSE](LICENSE).

How Usugami meets the LGPL:

- **A separate file.** libheif is not built into Usugami's own code. It stays in its own file,
  `site/app/vendor/libheif/libheif-bundle.mjs`, unmodified as published in libheif-js 1.23.5, and
  the app loads it (a dynamic `import()`) only when a HEIC photo is opened. Anyone can replace
  that file with their own build of libheif-js that has the same exports; the rest of the site
  works unchanged.
- **Corresponding source.** The file is libheif-js 1.23.5
  (https://github.com/catdad-experiments/libheif-js/tree/1.23.5), which packages the release of
  libheif-emscripten v1.23.5
  (https://github.com/catdad-experiments/libheif-emscripten/tree/v1.23.5). That compiles libheif
  v1.23.5 (https://github.com/strukturag/libheif/tree/v1.23.5, commit 413e2a8) and libde265 1.0.15
  (https://github.com/strukturag/libde265/releases/tag/v1.0.15) with Emscripten 3.1.61, using
  libheif's `build-emscripten.sh`. The source of everything else on the site is this repository.


## 7. Emscripten runtime in the WebAssembly files

The WebAssembly builds above (Tesseract in `site/app/vendor/tesseract/core/`, libheif in
`site/app/vendor/libheif/`, and OpenJPEG, JBIG2 and QuickJS in `site/app/vendor/pdfjs/wasm/`)
were compiled with [Emscripten](https://emscripten.org/), which adds its own runtime code and C
library to each one:

- Emscripten: MIT or University of Illinois/NCSA Open Source License.
  Text: [licenses/Emscripten.txt](licenses/Emscripten.txt)
- musl libc: Copyright © 2005-2020 Rich Felker, et al. MIT. Text: [licenses/musl.txt](licenses/musl.txt)
- For C++ code (Tesseract, libheif): LLVM's libc++ and libc++abi, under the Apache License 2.0
  with LLVM Exceptions, which allow compiled code to be distributed without these notices.

`wasm/qcms_bg.wasm` is compiled from Rust and contains parts of the Rust standard library (MIT or
Apache-2.0).


## 8. Fonts

In `site/app/fonts/`, for the text the app writes into PDFs (the fonts are embedded in those
PDFs). All are licensed under the SIL Open Font License, Version 1.1.

| Files | Version | Copyright | Text |
|---|---|---|---|
| `NotoSans-Regular.ttf`, `-Bold`, `-Italic`, `-BoldItalic`; `NotoSerif-Regular.ttf`, `-Bold`, `-Italic`, `-BoldItalic` | 2.015 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) | `site/app/fonts/OFL.txt` |
| `NotoSansMono-Regular.ttf`, `-Bold` | 2.014 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) | `site/app/fonts/OFL.txt` |
| `NotoSansDevanagari-Regular.ttf`, `-Bold` | 2.007 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari) | `site/app/fonts/OFL.txt` |
| `NotoSerifDevanagari-Regular.ttf`, `-Bold` | 2.006 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari) | `site/app/fonts/OFL.txt` |
| `UsugamiOcr-Regular.ttf` | 1.0 | see below | `site/app/fonts/UsugamiOcr-LICENSE.txt` |

Noto is a trademark of Google LLC.

### Usugami OCR font (UsugamiOcr-Regular.ttf)

An invisible font used only for the searchable text layer that text recognition adds to a PDF. It
has no visible letters (every glyph is empty) and keeps the character map and letter widths of
these fonts:

- Noto Sans 2.008. Copyright 2015-2021 Google LLC. All Rights Reserved.
- Noto Sans Devanagari 2.002. Copyright 2015-2022 Google Inc. All Rights Reserved.

It is the same file as in the Usugami Android app (`app/src/main/assets/fonts/` in
https://github.com/Nath-Goa/usugami), made by that repository's tools/make_ocr_font.py. It is a
modified version of those fonts, renamed so it uses no Reserved Font Name, and distributed under
the same license. The license file distributed with the Noto fonts reads "Copyright 2018 The Noto
Project Authors (github.com/googlei18n/noto-fonts)".


## 9. Icons and badges

### Material Icons

The app's icons are Google's [Material Icons](https://github.com/google/material-design-icons),
Round style, from the npm package @material-design-icons/svg 0.14.15
(https://github.com/marella/material-design-icons). `tools/build-icons.mjs` copies the ones the app
uses into `site/app/js/core/icons.js`.

- Copyright Google LLC
- License: Apache-2.0. Text: [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt), served with the
  site as `site/app/vendor/material-icons/LICENSE` (the npm package's copy, which `npm run vendor`
  copies there)

### Download badges

`site/assets/img/badges/`, used on the Download page. They are copies of the Usugami app's
`docs/badges/` (https://github.com/Nath-Goa/usugami/tree/main/docs/badges), are not covered by
Usugami's own license, and are used unchanged:

| File | Source | License |
|---|---|---|
| `get-it-on-github.png` | [Kunzisoft/Github-badge](https://github.com/Kunzisoft/Github-badge) (`get-it-on-github.png`, commit `4711835`). Badge design by flocke, based on the [F-Droid badge artwork](https://gitlab.com/fdroid/artwork/-/tree/master/badge/src). | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `badge_obtainium.png` | [ImranR98/Obtainium](https://github.com/ImranR98/Obtainium) (`assets/graphics/badge_obtainium.png`, commit `298b48a`). Losslessly re-compressed (same pixels, smaller file). | [GPL-3.0](https://github.com/ImranR98/Obtainium/blob/main/LICENSE.txt) (text: [LICENSE](LICENSE)) |

GitHub and the GitHub logo are trademarks of GitHub, Inc. Obtainium is a project by Imran R.
(ImranR98). Neither project endorses Usugami; the badges only link to where Usugami can be
downloaded.

The Usugami icon (`site/app/icons/`, `site/assets/img/`) and the screenshots are Usugami's own and
covered by its license.


## 10. License texts in licenses/

Each file starts with what it covers and where the text comes from, followed by the text itself.

| File | For |
|---|---|
| [Apache-2.0.txt](licenses/Apache-2.0.txt) | Material Icons, Tesseract, tesseract.js data, idb-keyval, wasm-feature-detect, the brotli decoder, PDF.js code in pdf-lib |
| [base64-arraybuffer.txt](licenses/base64-arraybuffer.txt), [culori.txt](licenses/culori.txt), [html-entities.txt](licenses/html-entities.txt), [node-html-better-parser.txt](licenses/node-html-better-parser.txt), [pdf-lib-standard-fonts.txt](licenses/pdf-lib-standard-fonts.txt), [pdfkit.txt](licenses/pdfkit.txt), [tslib.txt](licenses/tslib.txt), [UPNG.js.txt](licenses/UPNG.js.txt) | Inside pdf-lib (section 1) |
| [base64-js.txt](licenses/base64-js.txt), [brotli.js.txt](licenses/brotli.js.txt), [dfa.txt](licenses/dfa.txt), [restructure.txt](licenses/restructure.txt), [unicode-trie-and-unicode-properties.txt](licenses/unicode-trie-and-unicode-properties.txt), [Unicode-3.0.txt](licenses/Unicode-3.0.txt) | Inside fontkit (section 2); brotli.js.txt, dfa.txt, the Unicode texts and Apache-2.0.txt also go into `site/app/vendor/fontkit/fontkit.esm.min.js.LICENSE.txt` |
| [QuickJS.txt](licenses/QuickJS.txt), [pdf.js.quickjs.txt](licenses/pdf.js.quickjs.txt) | PDF.js's QuickJS sandbox (section 4); copied to `site/app/vendor/pdfjs/wasm/` |
| [tesseract.js-bundled-notices.txt](licenses/tesseract.js-bundled-notices.txt), [regenerator-runtime.txt](licenses/regenerator-runtime.txt), [buffer.txt](licenses/buffer.txt), [ieee754.txt](licenses/ieee754.txt), [zlib.js.txt](licenses/zlib.js.txt), [bmp-js.txt](licenses/bmp-js.txt), [is-url.txt](licenses/is-url.txt) | Inside tesseract.js (section 5) |
| [Leptonica.txt](licenses/Leptonica.txt), [libpng.txt](licenses/libpng.txt), [zlib.txt](licenses/zlib.txt), [libjpeg.txt](licenses/libjpeg.txt), [libtiff.txt](licenses/libtiff.txt), [libwebp.txt](licenses/libwebp.txt), [giflib.txt](licenses/giflib.txt), [openlibm.txt](licenses/openlibm.txt) | Inside tesseract.js-core (section 5) |
| [Emscripten.txt](licenses/Emscripten.txt), [musl.txt](licenses/musl.txt) | The WebAssembly files (section 7) |


## 11. Keeping this file up to date

After `npm run vendor`, compare `site/app/vendor/VERSIONS.json` with the versions above and update
them. To see what a library update changes first, run `node tools/vendor.mjs --out .tmp/vendor-check`
and compare that folder with `site/app/vendor/`. `node tests/vendor.test.mjs` checks that
`site/app/vendor/` is what `npm run vendor` makes and that every license file the vendored files
point at is there. When a library's major version changes, also check:

- fontkit's bundle contents: they come from `@cantoo/fontkit`'s dependencies in
  `package-lock.json`. `npm run vendor` lists them from esbuild's metafile into
  `fontkit.esm.min.js.LICENSE.txt` and stops when a bundled package ships no license file: then
  add its text to `licenses/` and name it in `LICENSE_FALLBACKS` in `tools/vendor.mjs`. Update the
  table in section 2 to match;
- the language data: `npm run vendor` removes the settings named in `UNKNOWN_SETTINGS` in
  `tools/vendor.mjs` from it. If new data names other settings the engine lacks (a
  "Warning: Parameter not found" console error when a worker starts), add them there and to
  section 5;
- pdf-lib's and tesseract.js's bundle contents: their `.js.map` files in `node_modules` list
  every bundled module;
- tesseract.js-core's libraries: its `third_party/` folder and build scripts on GitHub;
- libheif-js: `scripts/install.js` names the libheif-emscripten release, whose `libheif` submodule
  and `build-emscripten.sh` give the libheif and libde265 versions. Keep section 6's source links
  pointing at the versions in `site/app/vendor/libheif/`.
