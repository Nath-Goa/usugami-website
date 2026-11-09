// The website pages (Home, Download, Privacy, 404) and tools/check-site.mjs.
//
//   node tests/site.test.mjs
//
// Each page is opened in the sub-folder (as on GitHub Pages) at 320, 412, 768 and 1280 px wide in
// Chromium, and at phone size in Firefox and WebKit: no errors or outside requests, no horizontal
// scrolling, every image loads, every internal link and #anchor resolves, headings in order, touch
// targets, the menu, the theme from the web app's settings, and screenshots (light and dark) in
// tests/output/. Before that, the checker is run on the website pages and on a site with mistakes,
// and the pages' content is checked: the links every footer must have (the website's source code
// and third-party notices), what Home and Download must say, and a Privacy page that describes
// every kind of browser storage the web app's code uses.
import { withPage, root, outputDir } from './harness.mjs';
import { checkSite, stripJsComments } from '../tools/check-site.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const PAGES = [
  { name: 'home', path: '' },
  { name: 'download', path: 'download/' },
  { name: 'privacy', path: 'privacy/' },
  // GitHub Pages serves 404.html for unknown addresses at any depth.
  { name: '404', path: 'no/such/page/here', status: 404 },
];

// The smallest phone, a common one, a tablet and a laptop; dark screenshots at 320, 412 and 1280.
const RUNS = [
  { browser: 'chromium', viewport: { width: 320, height: 640 } },
  { browser: 'chromium', viewport: { width: 412, height: 915 } },
  { browser: 'chromium', viewport: { width: 768, height: 1024 } },
  { browser: 'chromium', viewport: { width: 1280, height: 800 } },
  { browser: 'firefox', viewport: { width: 360, height: 740 } },
  { browser: 'webkit', viewport: { width: 360, height: 740 } },
];

const SOURCE = 'https://github.com/Nath-Goa/usugami-website';
const NOTICES = 'https://github.com/Nath-Goa/usugami-website/blob/main/THIRD_PARTY_NOTICES.md';

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// ---------- The checker on the website pages ----------

{
  const only = ['index.html', 'download', 'privacy', '404.html', 'assets'].map((p) => join(root, 'site', p));
  const { problems, files } = checkSite({ only });
  check(files.length >= 6, `check-site saw only ${files.length} files`);
  check(!problems.length, 'check-site found problems in the website pages:\n' + problems.map((p) => `  ${p.file}:${p.line} ${p.message}`).join('\n'));
  console.log(`check-site: ${files.length} website files, ${problems.length} problems`);
}

// ---------- The checker on a site with mistakes ----------

await testChecker();

// ---------- What the pages must say ----------

checkContent();

// ---------- The pages in browsers ----------

for (const run of RUNS) {
  const label = `${run.browser} ${run.viewport.width}x${run.viewport.height}`;
  const started = performance.now();
  await withPage(async (page, url, context) => {
    for (const p of PAGES) {
      if (p.status === 404) await check404(context, url, p, run, label);
      else await checkPage(page, url, p, run, label);
    }
    if (run.browser === 'chromium' && run.viewport.width === 320) {
      await checkMenu(page, url, label);
      await checkTheme(page, url, label);
    }
    if (run.browser === 'chromium' && run.viewport.width === 1280) await checkWideNav(page, url, label);
    if (run.browser === 'chromium' && [320, 412, 1280].includes(run.viewport.width)) await checkDarkScreenshots(page, url);
    for (const p of PAGES) await screenshot(context, url, p, run);
  }, { browser: run.browser, viewport: run.viewport });
  console.log(`${label}: checked ${PAGES.length} pages in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

if (failures.length) {
  throw new Error(`${failures.length} problem${failures.length === 1 ? '' : 's'}:\n- ` + failures.join('\n- '));
}
console.log('site.test.mjs: all checks passed');

// ---------- Page checks ----------

async function checkPage(page, url, p, run, label) {
  const where = `${label} ${p.name}`;
  const res = await page.goto(url + p.path, { waitUntil: 'load' });
  check(res.status() === 200, `${where}: status ${res.status()}`);
  await checkLoaded(page, url, where, run);
}

/**
 * A full-page screenshot for review in tests/output/. WebKit's screenshots add a style element,
 * which the pages' Content-Security-Policy refuses (and reports): take those in a context that
 * bypasses it.
 */
async function screenshot(context, url, p, run) {
  const ctx = run.browser === 'webkit'
    ? await context.browser().newContext({ viewport: run.viewport, isMobile: true, hasTouch: true, bypassCSP: true })
    : context;
  const page = await ctx.newPage();
  await page.goto(url + p.path, { waitUntil: 'load' });
  await page.evaluate(async () => {
    for (const img of document.images) img.loading = 'eager';
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  });
  await page.screenshot({ path: await outPath(`site-${p.name}-${run.browser}-${run.viewport.width}.png`), fullPage: true, caret: 'initial' });
  await page.close();
  if (ctx !== context) await ctx.close();
}

async function check404(context, url, p, run, label) {
  const where = `${label} 404`;
  // A second page, so the expected "404 Not Found" of the page itself isn't reported as an error;
  // outside requests are still caught by the harness (context-wide).
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/status of 404/.test(m.text()) && (!m.location().url || m.location().url === url + p.path)) return;
    errors.push(`console error: ${m.text()}`);
  });
  page.on('response', (r) => { if (r.status() >= 400 && r.url() !== url + p.path) errors.push(`${r.status()} for ${r.url()}`); });
  const res = await page.goto(url + p.path, { waitUntil: 'load' });
  check(res.status() === 404, `${where}: status ${res.status()}, expected 404`);
  // Links on the 404 page lead to the site's root, however deep the missing address was.
  const links = await page.evaluate(() => ({
    home: document.querySelector('.notfound a.btn-filled')?.href,
    brand: document.querySelector('.brand')?.href,
    download: [...document.querySelectorAll('.notfound a')].find((a) => a.href.endsWith('download/'))?.href,
    css: getComputedStyle(document.body).backgroundColor,
    base: document.baseURI,
  }));
  check(links.home === url, `${where}: home link is ${links.home}, expected ${url}`);
  check(links.brand === url, `${where}: brand link is ${links.brand}, expected ${url}`);
  check(links.download === url + 'download/', `${where}: download link is ${links.download}`);
  check(links.base === url, `${where}: base is ${links.base}, expected ${url}`);
  check(links.css !== 'rgba(0, 0, 0, 0)', `${where}: the stylesheet didn't load (no body background)`);
  await checkLoaded(page, url, where, run);
  check(!errors.length, `${where}: ${errors.join('; ')}`);
  await page.close();
}

/** The checks every page gets. */
async function checkLoaded(page, url, where, run) {
  const info = await page.evaluate(async () => {
    // Load the lazy images too, then see that each one decoded.
    const imgs = [...document.images];
    for (const img of imgs) img.loading = 'eager';
    await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.trim() }));
    const anchors = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, raw: a.getAttribute('href') }));
    const resources = [
      ...[...document.querySelectorAll('link[href]')].filter((l) => !/alternate|canonical/.test(l.rel)).map((l) => l.href),
      ...[...document.querySelectorAll('[src]')].map((e) => e.src),
    ];
    return {
      lang: document.documentElement.lang,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content,
      viewport: document.querySelector('meta[name="viewport"]')?.content,
      themeColor: document.querySelectorAll('meta[name="theme-color"]').length,
      icon: !!document.querySelector('link[rel="icon"]'),
      mains: document.querySelectorAll('main').length,
      scrollWidth: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
      images: imgs.map((i) => ({ src: i.currentSrc || i.src, ok: i.complete && i.naturalWidth > 0, w: i.getAttribute('width'), h: i.getAttribute('height'), alt: i.getAttribute('alt') })),
      headings,
      anchors,
      resources,
      cookie: document.cookie,
      stored: (() => { try { return localStorage.length; } catch { return 0; } })(),
    };
  });
  check(info.lang === 'en', `${where}: <html lang> is "${info.lang}"`);
  check(info.title && info.description, `${where}: missing title or meta description`);
  check(/width=device-width/.test(info.viewport || ''), `${where}: missing viewport meta`);
  check(info.themeColor >= 1 && info.icon, `${where}: missing theme-color or icon`);
  check(info.mains === 1, `${where}: ${info.mains} <main> elements`);
  check(info.scrollWidth <= info.width, `${where}: scrolls sideways (${info.scrollWidth} > ${info.width})`);
  check(info.cookie === '', `${where}: sets a cookie`);
  check(info.stored === 0, `${where}: wrote to localStorage`);
  for (const img of info.images) {
    check(img.ok, `${where}: image didn't load: ${img.src}`);
    check(img.w && img.h, `${where}: image without width and height: ${img.src}`);
    check(img.alt !== null, `${where}: image without alt: ${img.src}`);
  }
  // Headings: one h1 first, and no level skipped on the way down.
  const levels = info.headings.map((h) => h.level);
  check(levels[0] === 1 && levels.filter((l) => l === 1).length === 1, `${where}: needs exactly one h1, first (${levels.join(',')})`);
  for (let i = 1; i < levels.length; i++) {
    check(levels[i] <= levels[i - 1] + 1, `${where}: heading "${info.headings[i].text}" (h${levels[i]}) skips a level after h${levels[i - 1]}`);
  }
  // Internal links and resources: each must load, and #anchors must exist on their page.
  const origin = new URL(url).origin;
  const targets = new Map();
  for (const a of info.anchors) {
    if (!a.href.startsWith(origin)) {
      check(!/^http:\/\//.test(a.href), `${where}: insecure link ${a.href}`);
      continue;
    }
    check(a.href.startsWith(url), `${where}: link ${a.raw} leaves the site's folder (${a.href})`);
    const u = new URL(a.href);
    const hash = decodeURIComponent(u.hash.slice(1));
    u.hash = '';
    if (!targets.has(u.href)) targets.set(u.href, new Set());
    if (hash && !hash.startsWith('/')) targets.get(u.href).add(hash);
  }
  for (const r of info.resources) if (r.startsWith(origin) && !targets.has(r)) targets.set(r, new Set());
  for (const [target, hashes] of targets) {
    const res = await page.request.get(target);
    check(res.status() === 200, `${where}: ${target.slice(url.length) || './'} gives ${res.status()}`);
    if (!hashes.size) continue;
    const html = await res.text();
    for (const h of hashes) check(new RegExp(`\\sid="${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html), `${where}: anchor #${h} missing on ${target.slice(url.length) || './'}`);
  }
  // On phones, the things people tap are at least 48 px tall.
  if (run.viewport.width < 600) {
    const small = await page.evaluate(() => [...document.querySelectorAll('.btn, .nav-menu > summary, .toc a, .footer-links a, .link-list a, .brand, .disclosure > summary')]
      .filter((e) => e.offsetParent !== null && !e.closest('[hidden]'))
      .map((e) => ({ text: e.textContent.trim().slice(0, 40), h: e.getBoundingClientRect().height }))
      .filter((e) => e.h < 47.5));
    check(!small.length, `${where}: touch targets under 48 px: ${small.map((s) => `"${s.text}" ${s.h.toFixed(0)}px`).join(', ')}`);
  }
}

/** Phones: the compact menu opens without JavaScript (<details>) and holds the four links. */
async function checkMenu(page, url, label) {
  const where = `${label} menu`;
  await page.goto(url, { waitUntil: 'load' });
  check(!(await page.locator('.nav-wide').isVisible()), `${where}: the wide navigation shows on a phone`);
  const summary = page.locator('.nav-menu > summary');
  check(await summary.isVisible(), `${where}: no menu button`);
  check((await summary.textContent()).includes('Menu'), `${where}: the menu button has no name`);
  await summary.click();
  const links = page.locator('.nav-menu .nav-list a');
  check(await links.count() === 4, `${where}: ${await links.count()} links in the menu`);
  check(await links.first().isVisible(), `${where}: menu links not shown after tapping Menu`);
  check(await page.locator('.nav-menu a[aria-current="page"]').textContent() === 'Home', `${where}: Home isn't marked as the current page`);
  await page.locator('.nav-menu .nav-list a', { hasText: 'Privacy' }).click();
  await page.waitForURL(url + 'privacy/');
  // Keyboard: the skip link comes first and leads to the content.
  await page.goto(url, { waitUntil: 'load' });
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement?.classList.contains('skip-link')), `${where}: the first Tab doesn't reach the skip link`);
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => location.hash === '#main'), `${where}: the skip link doesn't go to #main`);
  // The screenshots row scrolls sideways on its own, without the page scrolling.
  const row = await page.evaluate(() => {
    const ul = document.querySelector('.shots');
    return { scrolls: ul.scrollWidth > ul.clientWidth, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
  });
  check(row.scrolls && row.page, `${where}: the screenshots row should be swipeable on phones`);
}

async function checkWideNav(page, url, label) {
  const where = `${label} navigation`;
  await page.goto(url + 'download/', { waitUntil: 'load' });
  check(await page.locator('.nav-wide').isVisible(), `${where}: the navigation links are hidden on a wide screen`);
  check(!(await page.locator('.nav-menu').isVisible()), `${where}: the phone menu shows on a wide screen`);
  check(await page.locator('.nav-wide a[aria-current="page"]').textContent() === 'Download', `${where}: Download isn't marked as the current page`);
  // Wide screens can be touch screens too (a tablet held sideways): the same 48 px.
  const small = await page.evaluate(() => [...document.querySelectorAll('.nav-wide a, .footer-links a, .link-list a, .toc a, .btn')]
    .filter((e) => e.offsetParent !== null && !e.closest('[hidden]'))
    .map((e) => ({ text: e.textContent.trim().slice(0, 40), h: e.getBoundingClientRect().height }))
    .filter((e) => e.h < 47.5));
  check(!small.length, `${where}: targets under 48 px: ${small.map((s) => `"${s.text}" ${s.h.toFixed(0)}px`).join(', ')}`);
  // The editions line up row by row.
  const tops = await page.evaluate(() => [...document.querySelectorAll('.compare dl > div:nth-child(7)')].map((d) => Math.round(d.getBoundingClientRect().top)));
  check(tops.length === 3 && new Set(tops).size === 1, `${where}: the editions' rows don't line up (${tops.join(', ')})`);
}

/** The pages follow the theme chosen in the web app (localStorage usugami.settings), else the device. */
async function checkTheme(page, url, label) {
  const where = `${label} theme`;
  const bg = () => page.evaluate(() => [document.documentElement.dataset.theme || '', getComputedStyle(document.body).backgroundColor, document.querySelector('meta[name="theme-color"]').content]);
  await page.goto(url, { waitUntil: 'load' });
  await page.emulateMedia({ colorScheme: 'light' });
  check((await bg())[1] === 'rgb(255, 248, 247)', `${where}: light background is ${(await bg())[1]}`);
  await page.emulateMedia({ colorScheme: 'dark' });
  check((await bg())[1] === 'rgb(23, 23, 23)', `${where}: dark background is ${(await bg())[1]}`);

  await page.evaluate(() => localStorage.setItem('usugami.settings', JSON.stringify({ appearance: 'light', language: 'en' })));
  await page.reload({ waitUntil: 'load' });
  let [theme, color, meta] = await bg();
  check(theme === 'light' && color === 'rgb(255, 248, 247)' && meta === '#fff8f7', `${where}: Light in the app's settings gave ${theme} ${color} ${meta}`);

  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => localStorage.setItem('usugami.settings', JSON.stringify({ appearance: 'dark' })));
  await page.goto(url + 'privacy/', { waitUntil: 'load' });
  [theme, color, meta] = await bg();
  check(theme === 'dark' && color === 'rgb(23, 23, 23)' && meta === '#171717', `${where}: Dark in the app's settings gave ${theme} ${color} ${meta}`);
  await page.screenshot({ path: await outPath(`site-privacy-chromium-${page.viewportSize().width}-dark-setting.png`), caret: 'initial' });

  for (const bad of ['not json', 'null', '{"appearance":"blue"}', '{"appearance":"system"}']) {
    await page.evaluate((v) => localStorage.setItem('usugami.settings', v), bad);
    await page.reload({ waitUntil: 'load' });
    [theme, color] = await bg();
    check(theme === '' && color === 'rgb(255, 248, 247)', `${where}: settings ${bad} gave ${theme} ${color}`);
  }
  await page.evaluate(() => localStorage.clear());
  await page.emulateMedia({ colorScheme: 'light' });
}

async function checkDarkScreenshots(page, url) {
  await page.emulateMedia({ colorScheme: 'dark' });
  const width = page.viewportSize().width;
  for (const p of PAGES.filter((x) => !x.status)) {
    await page.goto(url + p.path, { waitUntil: 'load' });
    await page.evaluate(async () => {
      for (const img of document.images) img.loading = 'eager';
      await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    });
    await page.screenshot({ path: await outPath(`site-${p.name}-chromium-${width}-dark.png`), fullPage: true, caret: 'initial' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

// ---------- Content ----------

/** The text of some HTML: no tags, comments, scripts or styles, spaces collapsed. */
function pageText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** The href of every link in some HTML, comments left out. */
function hrefs(html) {
  return [...html.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(/<a\s[^>]*href="([^"]*)"/g)].map((m) => m[1]);
}

/** Checks what the pages must say and link to, from their files. */
function checkContent() {
  const read = (path) => readFileSync(join(root, 'site', path), 'utf8');
  const pages = { home: read('index.html'), download: read('download/index.html'), privacy: read('privacy/index.html'), 404: read('404.html') };
  const part = (html, re) => html.match(re)?.[0] ?? '';

  // Every footer links to the website's source code and its third-party notices (only site/ is
  // deployed, and some licenses ask for their notices to be reachable from it), and to the app's.
  for (const [name, html] of Object.entries(pages)) {
    const links = hrefs(part(html, /<footer[\s\S]*?<\/footer>/));
    for (const l of [SOURCE, NOTICES, 'https://github.com/Nath-Goa/usugami']) check(links.includes(l), `${name}: the footer doesn't link to ${l}`);
  }

  // Home: the web app first, then the Android app; the features as in the app's README; Download,
  // Privacy, and the website's source.
  {
    const main = part(pages.home, /<main[\s\S]*?<\/main>/);
    const hero = part(main, /<section class="hero"[\s\S]*?<\/section>/);
    check(hrefs(hero)[0] === 'app/', 'home: the first link in the hero should open the web app (app/)');
    check(pageText(hero).includes('Use Usugami in your browser'), 'home: the hero should offer the web app');
    const links = hrefs(main);
    for (const l of ['app/', 'download/', 'privacy/', SOURCE, NOTICES]) check(links.includes(l), `home: no link to ${l}`);
    const text = pageText(main);
    for (const words of ['Scan document', 'Images to PDF', 'Word to PDF', 'PowerPoint to PDF', 'Excel to PDF', 'EPUB to PDF', 'Merge PDF',
      'Split PDF', 'Reorganize PDF', 'Delete pages', 'Rotate PDF', 'Edit PDF', 'Sign PDF', 'Add page numbers', 'Add watermark', 'Compress PDF',
      'Redact PDF', 'Flatten PDF', 'Text recognition (OCR)', 'Recent files', 'Share to Usugami', 'never uploaded', 'never leave your device',
      'Usugami watermark', 'Off unless you turn it on']) {
      check(text.includes(words), `home: doesn't say "${words}"`);
    }
  }

  // Download: GitHub releases, Obtainium and Usugami's F-Droid repository, as in the app's README.
  {
    const main = part(pages.download, /<main[\s\S]*?<\/main>/);
    const links = hrefs(main);
    const apk = 'https://github.com/Nath-Goa/usugami/releases/latest/download/';
    for (const l of [`${apk}Usugami.apk`, `${apk}Usugami-lite.apk`, `${apk}Usugami-ocr.apk`, 'https://github.com/Nath-Goa/usugami/releases',
      'https://nathank.me/usugami/', '../app/', SOURCE, NOTICES]) {
      check(links.includes(l), `download: no link to ${l}`);
    }
    const obtainium = links.filter((l) => l.startsWith('https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/'));
    check(new Set(obtainium).size === 3, `download: ${new Set(obtainium).size} different Obtainium links, expected one per edition`);
    const text = pageText(main);
    for (const words of ['https://nathank.me/usugami/fdroid/repo', '8D92FFB46DB5C052B334438D8E012974D3969A27EACFF4AEEE687B99A4760DA8',
      'It serves Usugami (with the open-source text recognition of Usugami OCR) and Usugami Lite',
      '6F:4F:23:AD:E0:3E:63:6A:7C:C3:68:16:89:44:D0:CC:FC:81:32:EF:34:C5:0B:C5:A4:6B:0C:A4:CB:BD:F4:ED']) {
      check(text.includes(words), `download: doesn't say "${words}"`);
    }
  }

  // Privacy: what the web app downloads and stores, and where.
  {
    const text = pageText(part(pages.privacy, /<section[^>]*aria-labelledby="on-the-web"[\s\S]*?<\/section>/));
    for (const words of ['about 5 to 8 MB', 'from this same website', 'never leave your device', 'Fonts work the same way', 'local storage',
      'Usugami watermark switch with its size and opacity', 'IndexedDB', 'Recent files', 'service worker', 'Shared files', 'clear this site’s data']) {
      check(text.includes(words), `privacy: the web app's part doesn't say "${words}"`);
    }
    // Every kind of browser storage the web app's own code uses (vendor/ aside) is described there.
    const kinds = [
      { re: /\blocalStorage\b/, words: 'local storage' },
      { re: /\bsessionStorage\b/, words: 'session storage' },
      { re: /\bindexedDB\b/, words: 'IndexedDB' },
      { re: /\bcaches\s*\.\s*(open|match|keys)\b/, words: 'service worker' },
      { re: /\bstorage\s*\.\s*getDirectory\b/, words: 'origin private file system' },
    ];
    const used = new Map();
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'vendor') walk(path);
        } else if (/\.m?js$/.test(e.name)) {
          const code = stripJsComments(readFileSync(path, 'utf8'));
          for (const k of kinds) if (k.re.test(code)) used.set(k.words, [...(used.get(k.words) ?? []), path.slice(root.length + 1)]);
        }
      }
    };
    walk(join(root, 'site', 'app'));
    check(used.has('local storage') && used.has('IndexedDB'), 'privacy: the storage scan found no localStorage or IndexedDB in site/app (is the scan broken?)');
    for (const [words, files] of used) {
      check(text.includes(words), `privacy: the web app uses ${words} (${files.join(', ')}), but the Privacy page doesn't describe it`);
    }
  }
  console.log('content: footers, Home, Download and Privacy say what they must');
}


async function outPath(name) {
  await mkdir(outputDir, { recursive: true });
  return join(outputDir, name);
}

// ---------- The checker itself ----------

async function testChecker() {
  const dir = await mkdtemp(join(tmpdir(), 'usugami-check-'));
  const site = join(dir, 'site');
  const put = async (path, text) => {
    await mkdir(join(site, path, '..'), { recursive: true });
    await writeFile(join(site, path), text);
  };
  const okScript = "console.log('hi')";
  const hash = createHash('sha256').update(okScript).digest('base64');
  try {
    await put('index.html', `<!doctype html><html lang="en"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'sha256-${hash}'">
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="//fonts.example.com/a.css">
<link rel="alternate" hreflang="fr" href="https://usugami.com/fr/">
<link rel="icon" href="Icon.PNG">
<script>${okScript}</script>
<script>console.log('changed')</script>
<!-- <img src="/commented-out.png"> -->
</head><body>
<img src="/root.png" alt="">
<script src="https://cdn.example.com/lib.js"></script>
<img srcset="ok.png 1x, https://img.example.com/b.png 2x" alt="">
<a href="https://github.com/Nath-Goa/usugami">fine</a>
<a href="missing/">missing</a>
<a href="docs/">folder without index</a>
<a href="#here" id="here">here</a>
<a href="#nowhere">nowhere</a>
<a href="page.html#sec">fine</a>
<a href="page.html#zzz">bad anchor</a>
<a href="app/#/tool/split">route</a>
<a href="ok.png" ping="https://track.example.com">ping</a>
<p id="here">duplicate</p>
<div style="background: url(/bg.png)"></div>
</body></html>`);
    await put('page.html', '<!doctype html><html lang="en"><body><h2 id="sec">Section</h2></body></html>');
    await put('icon.png', 'x');
    await put('ok.png', 'x');
    await put('docs/readme.txt', 'x');
    await put('app/index.html', '<!doctype html><html lang="en"><body><script type="module" src="./main.js"></script></body></html>');
    await put('app/ok.js', 'export const ok = 1;\n');
    await put('app/main.js', `// fetch('/commented-out') is only a comment
import { ok } from './ok.js';
import bad from 'https://esm.sh/x';
import missing from './missing.js';
import bare from 'pdf-lib';
const s = "// not a comment"; fetch('/api/data');
const w = new Worker('https://cdn.example.com/worker.js');
const f = new URL('../../outside.js', import.meta.url);
const g = new URL('ok.js', import.meta.url);
const folder = new URL('./', import.meta.url); const route = new URL('./share-target/', import.meta.url);
const t = \`\${'x'}\`; navigator.sendBeacon('x');
document.cookie = 'a=b';
gtag('config', 'G-1');
`);
    await put('app/vendor/lib.js', "fetch('https://default.example.com/data'); import('https://cdn.example.com/x.js');\n");
    await put('app/worker.js', "importScripts('//cdn.example.com/x.js', './ok.js');\n");
    await put('style.css', `/* url(/commented.png) */
@import url("https://fonts.googleapis.com/css2?family=Inter");
body { background: url(/bg.png); }
.a { background: url('ok.png'); }
.b { background: url(missing.png); }
.c { mask: url(#svg-mask); background: url(data:image/png;base64,AAAA); }
`);
    await put('app/manifest.webmanifest', JSON.stringify({ start_url: '/', scope: './', icons: [{ src: 'https://example.com/i.png' }, { src: '../ok.png' }], share_target: { action: './share' } }, null, 2));
    await put('CNAME', 'usugami.com\n');

    const { problems } = checkSite({ siteDir: site });
    const text = problems.map((p) => `${p.file.split('/').slice(-2).join('/')}:${p.line} ${p.message}`);
    const expect = [
      [/CNAME.*CNAME file/],
      [/index\.html:4 .*outside resource "\/\/fonts\.example\.com/],
      [/index\.html:6 .*Icon\.PNG" differs in upper and lower case/],
      [/index\.html:8 .*Content-Security-Policy: add 'sha256-/],
      [/index\.html:11 .*root-relative URL "\/root\.png"/],
      [/index\.html:12 .*outside resource "https:\/\/cdn\.example\.com\/lib\.js"/],
      [/index\.html:13 .*outside resource "https:\/\/img\.example\.com\/b\.png"/],
      [/index\.html:15 .*"missing\/" not found/],
      [/index\.html:16 .*folder "docs\/" has no index\.html/],
      [/index\.html:18 .*anchor "#nowhere" not found/],
      [/index\.html:20 .*anchor "#zzz" not found in page\.html/],
      [/index\.html:22 .*ping.*tracking/],
      [/index\.html:23 .*id "here" is used more than once/],
      [/index\.html:24 .*root-relative URL "\/bg\.png"/],
      [/index\.html:24 .*style attribute.*Content-Security-Policy/],
      [/main\.js:3 .*outside resource "https:\/\/esm\.sh\/x"/],
      [/main\.js:4 .*"\.\/missing\.js" not found/],
      [/main\.js:5 .*bare import "pdf-lib"/],
      [/main\.js:6 .*root-relative URL "\/api\/data"/],
      [/main\.js:7 .*outside resource "https:\/\/cdn\.example\.com\/worker\.js"/],
      [/main\.js:8 .*points outside the site/],
      [/main\.js:\d+ .*tracking or cookies: "sendBeacon"/],
      [/main\.js:\d+ .*tracking or cookies: "document\.cookie"/],
      [/main\.js:\d+ .*tracking or cookies: "gtag\("/],
      [/worker\.js:1 .*outside resource "\/\/cdn\.example\.com\/x\.js"/],
      [/style\.css:2 .*CSS @import.*fonts\.googleapis\.com/],
      [/style\.css:3 .*root-relative URL "\/bg\.png"/],
      [/style\.css:5 .*"missing\.png" not found/],
      [/manifest\.webmanifest:\d+ .*start_url: root-relative/],
      [/manifest\.webmanifest:\d+ .*outside resource "https:\/\/example\.com\/i\.png"/],
    ];
    for (const [re] of expect) check(text.some((t) => re.test(t)), `check-site missed ${re} in:\n    ${text.join('\n    ')}`);
    const wrong = [/share-target/, /commented/, /default\.example\.com/, /alternate/, /usugami\.com\/fr/, /github\.com\/Nath-Goa/, /#here" not found/, /#\/tool/, /ok\.js/, /\.\/share/, /svg-mask/, /data:image/, /"\.\/" /, /index\.html:7 /];
    for (const re of wrong) check(!text.some((t) => re.test(t)), `check-site wrongly reported ${re}:\n    ${text.filter((t) => re.test(t)).join('\n    ')}`);
    check(text.length === expect.length, `check-site reported ${text.length} problems, expected ${expect.length}:\n    ${text.join('\n    ')}`);

    // The command line prints a report and exits with 1 on problems, 0 on a clean site.
    const cli = spawnSync(process.execPath, [join(root, 'tools', 'check-site.mjs'), join(root, 'site', 'index.html')], { encoding: 'utf8', cwd: root });
    check(cli.status === 0 && /no problems/.test(cli.stdout), `check-site on site/index.html: exit ${cli.status}\n${cli.stdout}${cli.stderr}`);
    await rm(join(site, 'CNAME'));
    const bad = spawnSync(process.execPath, ['-e', `import('${new URL('../tools/check-site.mjs', import.meta.url).href}').then(({ checkSite }) => { const r = checkSite({ siteDir: ${JSON.stringify(site)} }); process.exit(r.problems.length ? 1 : 0); })`], { encoding: 'utf8' });
    check(bad.status === 1, `check-site API on the bad site should fail, got exit ${bad.status} ${bad.stderr}`);
    console.log(`check-site on a site with mistakes: ${text.length} problems found, as expected`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
