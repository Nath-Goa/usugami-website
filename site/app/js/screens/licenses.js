// Open-source licenses (the app's THIRD_PARTY_NOTICES, for the web app): Usugami's own license,
// then each library, font, icon set and data file the web app is built with, its version, license
// and copyright, with its license text (served with the site) and its project page, and a link to
// the site's full notices (THIRD_PARTY_NOTICES.md), which also name the code inside the libraries.
import { h } from '../core/dom.js';
import { t, getLanguage } from '../core/i18n.js';
import { icon, ICON_SET } from '../core/icons.js';
import { topBar } from '../core/ui.js';
import { WEBSITE_SOURCE_URL, WEBSITE_NOTICES_URL } from './settings.js';

/**
 * The parts by others. `version` names the package in vendor/VERSIONS.json (written by
 * npm run vendor) whose version shows, or `fixedVersion` gives it; `packages` are every
 * VERSIONS.json package the row covers; `text` is the license file served with the site, relative
 * to site/app/.
 */
export const THIRD_PARTY = [
  {
    name: 'pdf-lib', version: '@cantoo/pdf-lib', purpose: 'web_lic_pdflib', license: 'MIT License',
    copyright: 'Copyright (c) 2019 Andrew Dillon. Fork by Cantoo.', text: 'vendor/pdf-lib/LICENSE.md', home: 'https://github.com/cantoo-scribe/pdf-lib',
  },
  {
    name: 'fontkit', version: '@cantoo/fontkit', purpose: 'web_lic_fontkit', license: 'MIT License',
    copyright: 'Copyright (c) 2014-present Devon Govett. Fork by Cantoo.', text: 'vendor/fontkit/fontkit.esm.min.js.LICENSE.txt', home: 'https://github.com/cantoo-scribe/fontkit',
  },
  {
    name: 'fflate', version: 'fflate', purpose: 'web_lic_fflate', license: 'MIT License',
    copyright: 'Copyright (c) Arjun Barrett', text: 'vendor/fflate/LICENSE.txt', home: 'https://github.com/101arrowz/fflate',
  },
  {
    name: 'PDF.js', version: 'pdfjs-dist', purpose: 'web_lic_pdfjs', license: 'Apache License 2.0',
    copyright: 'Copyright Mozilla Foundation and contributors', text: 'vendor/pdfjs/LICENSE.txt', home: 'https://mozilla.github.io/pdf.js/',
  },
  {
    name: 'Tesseract.js', version: 'tesseract.js', purpose: 'web_lic_tesseract', license: 'Apache License 2.0',
    copyright: 'Copyright the Tesseract.js authors (Project Naptha)', text: 'vendor/tesseract/LICENSE.md', home: 'https://github.com/naptha/tesseract.js',
  },
  {
    name: 'Tesseract.js core', version: 'tesseract.js-core', purpose: 'web_lic_tesseract_core',
    license: 'Apache License 2.0; Leptonica: BSD 2-Clause; libjpeg: IJG License; libpng, zlib, LibTIFF, libwebp, GIFLIB: their own licenses',
    copyright: 'Tesseract OCR: Copyright Hewlett-Packard, Google and the Tesseract authors. Leptonica: Copyright (C) 2001-2020 Leptonica. '
      + 'This software is based in part on the work of the Independent JPEG Group.',
    text: 'vendor/tesseract/core/LICENSE.txt', home: 'https://github.com/naptha/tesseract.js-core',
  },
  {
    name: 'Tesseract trained data (eng, fra, spa, hin)', version: '@tesseract.js-data/eng',
    packages: ['@tesseract.js-data/eng', '@tesseract.js-data/fra', '@tesseract.js-data/spa', '@tesseract.js-data/hin'],
    purpose: 'web_lic_tessdata', license: 'Apache License 2.0',
    copyright: 'Copyright Google and the Tesseract OCR authors (tessdata_best)', text: 'vendor/tesseract/core/LICENSE.txt', home: 'https://github.com/tesseract-ocr/tessdata_best',
  },
  {
    name: 'libheif', version: 'libheif-js', purpose: 'web_lic_libheif', license: 'GNU Lesser General Public License v3.0',
    copyright: 'Copyright struktur AG and Dirk Farin; libheif-js by Kiril Vatev', text: 'vendor/libheif/LICENSE.txt', home: 'https://github.com/strukturag/libheif',
  },
  {
    name: 'Noto Sans, Noto Serif, Noto Sans Mono, Noto Sans Devanagari, Noto Serif Devanagari', purpose: 'web_lic_noto', license: 'SIL Open Font License 1.1',
    copyright: 'Copyright 2022 The Noto Project Authors. Usugami OCR font: made from Noto Sans and Noto Sans Devanagari, Copyright 2015-2022 Google LLC.',
    text: 'fonts/OFL.txt', home: 'https://notofonts.github.io/',
  },
  {
    name: ICON_SET.name, fixedVersion: ICON_SET.version, purpose: 'web_lic_icons', license: 'Apache License 2.0',
    copyright: ICON_SET.copyright, text: 'vendor/material-icons/LICENSE.txt', home: 'https://github.com/google/material-design-icons',
  },
];

/** The VERSIONS.json packages each row covers. */
export function packagesOf(part) {
  return part.packages ?? (part.version ? [part.version] : []);
}

const appBase = new URL('../../', import.meta.url);

/** The versions vendored, or none when they can't be read (offline, say). */
async function vendoredVersions() {
  try {
    const res = await fetch(new URL('vendor/VERSIONS.json', appBase));
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

function link(href, label) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' },
    label, h('span', { class: 'visually-hidden' }, ' ' + t('web_opens_elsewhere')),
    icon('open_in_new', { size: 16 }));
}

/** Renders the licenses. */
export async function mount(ctx) {
  const versions = await vendoredVersions();
  const own = h('li', { class: 'license license--own' },
    h('h2', null, t('home_title')),
    h('p', null, t('web_license_usugami')),
    h('p', { class: 'license-meta' }, `GNU General Public License v3.0 or later · ${t('about_copyright')}`),
    h('div', { class: 'license-links' },
      link('https://www.gnu.org/licenses/gpl-3.0.html', t('web_license_text')),
      link(WEBSITE_SOURCE_URL, t('about_source'))));
  const parts = THIRD_PARTY.map((p) => {
    const version = p.fixedVersion ?? (p.version ? versions[p.version] : null);
    return h('li', { class: 'license' },
      h('h2', { lang: 'en' }, p.name, version ? h('span', { class: 'license-version' }, ' ' + version) : null),
      h('p', null, t(p.purpose)),
      h('p', { class: 'license-meta', lang: getLanguage() === 'en' ? null : 'en' }, `${p.license} · ${p.copyright}`),
      h('div', { class: 'license-links' },
        link(new URL(p.text, appBase).href, t('web_license_text')),
        link(p.home, t('web_license_project'))));
  });
  ctx.root.append(
    topBar({ title: t('about_licenses'), onBack: () => ctx.back() }),
    h('div', { class: 'page page--narrow', 'data-main': '' },
      h('p', { class: 'licenses-intro' }, t('web_licenses_intro')),
      // The code bundled inside the libraries (MIT, BSD, IJG, Leptonica...) is named there, with
      // its notices.
      h('div', { class: 'licenses-notices' },
        h('p', null, t('web_licenses_notices')),
        h('div', { class: 'license-links' }, link(WEBSITE_NOTICES_URL, t('web_about_notices')))),
      h('ul', { class: 'licenses-list' }, own, parts)));
  return { unmount() {}, hasUnsavedWork: () => false };
}
