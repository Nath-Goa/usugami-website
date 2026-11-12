// The website pages (Home, Download, Privacy, the tool pages, 404), tools/check-site.mjs and
// tools/build-tool-pages.mjs.
//
//   node tests/site.test.mjs
//
// Each page is opened in the sub-folder (as on GitHub Pages) at 320, 412, 768 and 1280 px wide in
// Chromium, and at phone size in Firefox and WebKit: no errors or outside requests, no horizontal
// scrolling, every image loads, every internal link and #anchor resolves, headings in order, touch
// targets, the menu, the theme from the web app's settings, no Referer sent to other sites, Home's
// feature rows full and its screenshots as WebP (and how many bytes of images a phone loads),
// Download's code blocks, and screenshots (light and dark) in tests/output/. The 404 page is also
// opened through a proxy at usugami.com and github.io addresses. Before that, the checker is run
// on the website pages and on a site with mistakes, and the pages' content is checked: the links
// every footer must have (the website's source code and third-party notices), the canonical and
// Open Graph tags, the structured data, the sitemap and robots.txt, the tool pages being as
// tools/build-tool-pages.mjs makes them (and Home linking to each), what Home and Download must
// say, and a Privacy page that describes every kind of browser storage the web app's code uses and
// exactly the tool choices it saves.
import { chromium } from 'playwright';
import { withPage, root, outputDir } from './harness.mjs';
import { checkSite, stripJsComments } from '../tools/check-site.mjs';
import { startServer } from '../tools/serve.mjs';
import { buildToolPages } from '../tools/build-tool-pages.mjs';
import { TOOL_PAGES } from '../tools/tool-pages.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// The tool pages (usugami.com/merge-pdf/ and so on), as tools/build-tool-pages.mjs makes them.
const TOOL_PAGE_LIST = buildToolPages().pages;

const PAGES = [
  { name: 'home', path: '' },
  { name: 'download', path: 'download/' },
  { name: 'privacy', path: 'privacy/' },
  ...TOOL_PAGE_LIST.map((t) => ({ name: t.slug, path: `${t.slug}/`, tool: true })),
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
  const only = ['index.html', 'download', 'privacy', '404.html', 'assets', ...TOOL_PAGE_LIST.map((t) => t.slug)].map((p) => join(root, 'site', p));
  const { problems, files } = checkSite({ only, requireCsp: true });
  check(files.length >= 6 + TOOL_PAGE_LIST.length, `check-site saw only ${files.length} files`);
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
    if (run.browser !== 'chromium' || run.viewport.width === 320) await checkReferrer(page, url, context, label);
    if (run.browser === 'chromium' && run.viewport.width === 412) await checkHomeBytes(page, url, label);
    if (run.browser === 'chromium' && run.viewport.width === 1280) {
      await checkWideNav(page, url, label);
      // The widths between the runs' where the feature cards change from two to three a row.
      for (const width of [720, 900, 1079, 1080, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(url, { waitUntil: 'load' });
        await checkFeatureRows(page, `chromium ${width}x800 home`);
      }
      await page.setViewportSize(run.viewport);
    }
    if (run.browser === 'chromium' && [320, 412, 1280].includes(run.viewport.width)) await checkDarkScreenshots(page, url);
    for (const p of PAGES) await screenshot(context, url, p, run);
  }, { browser: run.browser, viewport: run.viewport });
  console.log(`${label}: checked ${PAGES.length} pages in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

// ---------- The 404 page on the real addresses ----------

await check404Hosts();

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
  if (p.name === 'home') {
    // checkLoaded loaded every image: the screenshots come as WebP (PNG only as a fallback).
    const shots = await page.evaluate(() => [...document.querySelectorAll('picture img')].map((i) => i.currentSrc));
    check(shots.length === 7 && shots.every((s) => s.endsWith('.webp')), `${where}: screenshots not shown as WebP: ${shots.join(', ')}`);
    await checkFeatureRows(page, where);
  }
  if (p.name === 'download') await checkDownloadBlocks(page, where);
}

/**
 * Home's feature groups (7, 5, 4, 3 and 9 cards) leave no row part filled: each row of cards
 * reaches both edges of its grid, at one, two or three cards to a row.
 */
async function checkFeatureRows(page, where) {
  const groups = await page.evaluate(() => [...document.querySelectorAll('.feature-grid')].map((grid) => {
    const g = grid.getBoundingClientRect();
    const rows = new Map();
    for (const li of grid.children) {
      const r = li.getBoundingClientRect();
      const top = Math.round(r.top);
      rows.set(top, [...(rows.get(top) ?? []), r]);
    }
    return {
      name: grid.closest('[aria-labelledby]')?.getAttribute('aria-labelledby'),
      rows: [...rows.values()].map((rs) => ({
        cards: rs.length,
        start: Math.min(...rs.map((r) => r.left)) - g.left,
        end: g.right - Math.max(...rs.map((r) => r.right)),
      })),
    };
  }));
  check(groups.length === 5, `${where}: ${groups.length} feature groups, expected 5`);
  for (const g of groups) {
    const gaps = g.rows.filter((r) => r.start > 1 || r.end > 1);
    check(!gaps.length, `${where}: ${g.name} has rows that don't fill the width (cards per row ${g.rows.map((r) => r.cards).join('+')}; gaps ${gaps.map((r) => `${r.start.toFixed(0)}/${r.end.toFixed(0)}px`).join(', ')})`);
  }
}

/**
 * Download: a code block that scrolls sideways can be focused (WebKit doesn't focus scrollers by
 * itself), the lines to paste wrap instead, and the Obtainium link's "(the main edition)" stays
 * whole, under the link's text when it doesn't fit beside it.
 */
async function checkDownloadBlocks(page, where) {
  const pres = await page.evaluate(() => [...document.querySelectorAll('pre')].map((pre) => {
    pre.focus();
    return {
      label: pre.getAttribute('aria-label') ?? pre.textContent.slice(0, 30),
      scrolls: pre.scrollWidth > pre.clientWidth + 1,
      paste: pre.classList.contains('select-all'),
      focusable: document.activeElement === pre && pre.tabIndex === 0,
      named: pre.getAttribute('role') === 'region' && !!pre.getAttribute('aria-label'),
    };
  }));
  for (const p of pres) {
    if (p.paste) check(!p.scrolls, `${where}: the lines to paste (${p.label}) scroll sideways instead of wrapping`);
    else if (p.scrolls) check(p.focusable && p.named, `${where}: code block "${p.label}" scrolls sideways but can't be focused or has no name`);
  }
  const note = await page.evaluate(() => {
    const n = document.querySelector('#obtainium .link-note');
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { height: r.height, line: parseFloat(getComputedStyle(n).lineHeight), left: r.left, textLeft: n.parentElement.getBoundingClientRect().left };
  });
  check(note, `${where}: no "(the main edition)" note in the Obtainium links`);
  if (note) {
    check(note.height < note.line * 1.5, `${where}: "(the main edition)" breaks over lines (${note.height.toFixed(0)}px tall)`);
    check(note.left >= note.textLeft - 0.5, `${where}: "(the main edition)" starts left of the link's text`);
  }
}

/** Links to other sites send no Referer (meta referrer no-referrer): try the footer's source link. */
async function checkReferrer(page, url, context, label) {
  const seen = [];
  const handler = async (route) => {
    seen.push({ url: route.request().url(), referer: (await route.request().allHeaders()).referer ?? '' });
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title><p>stub</p>' });
  };
  await context.route('https://github.com/**', handler);
  try {
    for (const p of PAGES) {
      if (p.status) continue;
      await page.goto(url + p.path, { waitUntil: 'load' });
      await Promise.all([page.waitForURL(SOURCE), page.locator(`footer a[href="${SOURCE}"]`).click()]);
    }
  } finally {
    await context.unroute('https://github.com/**', handler);
  }
  const sent = seen.filter((s) => s.referer);
  check(seen.length >= 3 && !sent.length, `${label} referrer: ${seen.length} requests to github.com, with Referer: ${sent.map((s) => `${s.url} <- ${s.referer}`).join('; ')}`);
}

/**
 * Home on a phone, as a visitor scrolls through it: the images it downloads stay small (the
 * screenshots are WebP; as PNGs they were 227 KiB). The hidden hero pictures aren't downloaded.
 */
async function checkHomeBytes(page, url, label) {
  await page.goto(url, { waitUntil: 'load' });
  const images = await page.evaluate(async () => {
    for (let y = 0; y <= document.documentElement.scrollHeight; y += 400) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
    await Promise.all([...document.querySelectorAll('.shots img')].map((i) => i.decode().catch(() => {})));
    const sizes = new Map();
    for (const e of performance.getEntriesByType('resource')) {
      if (/\.(png|webp|jpe?g|svg|gif|avif)$/.test(new URL(e.name).pathname)) sizes.set(e.name, e.encodedBodySize);
    }
    return [...sizes];
  });
  const total = images.reduce((sum, [, size]) => sum + size, 0);
  check(images.some(([name]) => name.endsWith('.webp')) && !images.some(([name]) => /screenshots\/\w+\.png$/.test(name)), `${label} home: screenshots not loaded as WebP: ${images.map(([n]) => n.slice(url.length)).join(', ')}`);
  check(total > 50_000 && total < 170_000, `${label} home: ${(total / 1024).toFixed(0)} KiB of images on a phone, expected under 166 KiB (${images.map(([n, s]) => `${n.slice(url.length)} ${s}`).join(', ')})`);
  console.log(`${label} home: ${(total / 1024).toFixed(0)} KiB of images (${images.length} files)`);
}

/**
 * The 404 page at the site's real addresses, through a proxy: on usugami.com (and www) the site is
 * at the root, even for an address starting with the old sub-folder; on github.io it is in the
 * sub-folder. Its base, both stylesheets and its three buttons must work.
 */
async function check404Hosts() {
  const atRoot = await startServer({});
  const inFolder = await startServer({ prefix: 'usugami-website' });
  const cases = [
    [atRoot, 'http://usugami.com/usugami-website/app/x', 'http://usugami.com/'],
    [atRoot, 'http://usugami.com/usugami-website/download/', 'http://usugami.com/'],
    [atRoot, 'http://www.usugami.com/usugami-website/', 'http://www.usugami.com/'],
    [atRoot, 'http://usugami.com/nope/deeper', 'http://usugami.com/'],
    [inFolder, 'http://nath-goa.github.io/usugami-website/a/b/c', 'http://nath-goa.github.io/usugami-website/'],
  ];
  try {
    for (const server of [atRoot, inFolder]) {
      const origin = new URL(server.url).origin;
      const browser = await chromium.launch({ proxy: { server: origin } });
      try {
        const page = await browser.newPage();
        for (const [, address, base] of cases.filter(([s]) => s === server)) {
          const where = `404 at ${address}`;
          const res = await page.goto(address, { waitUntil: 'load' });
          check(res.status() === 404, `${where}: status ${res.status()}`);
          const info = await page.evaluate(() => ({
            base: document.baseURI,
            sheets: [...document.styleSheets].map((s) => { try { return s.cssRules.length; } catch { return 0; } }),
            background: getComputedStyle(document.body).backgroundColor,
            links: [...document.querySelectorAll('.btn-row a, .brand')].map((a) => a.href),
          }));
          check(info.base === base, `${where}: base is ${info.base}, expected ${base}`);
          check(info.sheets.length === 2 && info.sheets.every((n) => n > 0), `${where}: stylesheets didn't load (${info.sheets.join(', ')} rules)`);
          check(info.background !== 'rgba(0, 0, 0, 0)', `${where}: the page isn't styled`);
          check(info.links.length === 4 && info.links.every((l) => l.startsWith(base)), `${where}: links ${info.links.join(', ')}`);
          for (const link of info.links) {
            const status = (await fetch(origin + new URL(link).pathname, { redirect: 'manual' })).status;
            check(status === 200, `${where}: ${link} answers ${status}`);
          }
        }
      } finally {
        await browser.close();
      }
    }
    console.log(`404 page: right root at ${cases.length} addresses on usugami.com and github.io`);
  } finally {
    await atRoot.close();
    await inFolder.close();
  }
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
    const small = await page.evaluate(() => [...document.querySelectorAll('.btn, .nav-menu > summary, .toc a, .footer-links a, .link-list a, .brand, .disclosure > summary, .feature-top:has(.feature-link)')]
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
  // tokens.css's --paper (behind page pictures, as the app's white PdfThumbnail box) stays white.
  const paper = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--paper').trim().toLowerCase());
  check(await paper() === '#ffffff', `${where}: --paper is ${await paper()} in dark mode, expected #ffffff`);

  await page.evaluate(() => localStorage.setItem('usugami.settings', JSON.stringify({ appearance: 'light', language: 'en' })));
  await page.reload({ waitUntil: 'load' });
  let [theme, color, meta] = await bg();
  check(theme === 'light' && color === 'rgb(255, 248, 247)' && meta === '#fff8f7', `${where}: Light in the app's settings gave ${theme} ${color} ${meta}`);

  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => localStorage.setItem('usugami.settings', JSON.stringify({ appearance: 'dark' })));
  await page.goto(url + 'privacy/', { waitUntil: 'load' });
  [theme, color, meta] = await bg();
  check(theme === 'dark' && color === 'rgb(23, 23, 23)' && meta === '#171717', `${where}: Dark in the app's settings gave ${theme} ${color} ${meta}`);
  check(await paper() === '#ffffff', `${where}: --paper is ${await paper()} with Dark chosen, expected #ffffff`);
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
  const part = (html, re) => html.match(re)?.[0] ?? '';

  // The tool pages and the sitemap are as tools/build-tool-pages.mjs makes them: run it after
  // changing tools/tool-pages.mjs, or the parts of Download and Home it copies.
  {
    const stale = [...buildToolPages().files].filter(([path, text]) => !existsSync(join(root, 'site', path)) || read(path) !== text).map(([path]) => `site/${path}`);
    check(!stale.length, `out of date (run node tools/build-tool-pages.mjs): ${stale.join(', ')}`);
  }
  const pages = { home: read('index.html'), download: read('download/index.html'), privacy: read('privacy/index.html'), 404: read('404.html') };
  for (const t of TOOL_PAGE_LIST) if (existsSync(join(root, 'site', t.slug, 'index.html'))) pages[t.slug] = read(`${t.slug}/index.html`);

  // Every footer links to the website's source code and its third-party notices (only site/ is
  // deployed, and some licenses ask for their notices to be reachable from it), and to the app's.
  for (const [name, html] of Object.entries(pages)) {
    const links = hrefs(part(html, /<footer[\s\S]*?<\/footer>/));
    for (const l of [SOURCE, NOTICES, 'https://github.com/Nath-Goa/usugami']) check(links.includes(l), `${name}: the footer doesn't link to ${l}`);
    // Links to other sites don't tell them that the visitor came from Usugami.
    check(/<meta name="referrer" content="no-referrer">/.test(part(html, /<head>[\s\S]*?<\/head>/)), `${name}: no <meta name="referrer" content="no-referrer"> in the head`);
  }

  // The domain is linked: every page the sitemap lists (all but the 404 page) names its address on
  // https://usugami.com/ (canonical), gives link previews (Open Graph) its title, description and
  // the social preview image with its alt text, and says what it is for search results with
  // structured data: the site's name on Home, a breadcrumb from Home on the other pages (the web
  // app's page has none). robots.txt allows every page and names the sitemap.
  const robots = read('robots.txt');
  check(/^Sitemap: https:\/\/usugami\.com\/sitemap\.xml$/m.test(robots), 'robots.txt: no "Sitemap: https://usugami.com/sitemap.xml" line');
  check(/^User-agent: \*$/m.test(robots) && /^Disallow:\s*$/m.test(robots) && !/^Disallow:[ \t]*\S/m.test(robots), 'robots.txt: should let every page be indexed');
  const listed = [...read('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  const addresses = ['', 'app/', ...TOOL_PAGE_LIST.map((t) => `${t.slug}/`), 'download/', 'privacy/'].map((p) => `https://usugami.com/${p}`);
  check(JSON.stringify(listed) === JSON.stringify(addresses), `sitemap.xml lists ${listed.join(', ')}; expected ${addresses.join(', ')}`);
  for (const address of addresses) {
    const path = address.slice('https://usugami.com/'.length);
    const name = path.replace(/\/$/, '') || 'home';
    if (!existsSync(join(root, 'site', path, 'index.html'))) { check(false, `${name}: site/${path}index.html is missing`); continue; }
    const head = part(read(`${path}index.html`), /<head>[\s\S]*?<\/head>/).replace(/<!--[\s\S]*?-->/g, ' ');
    const canonical = [...head.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);
    check(canonical.length === 1 && canonical[0] === address, `${name}: needs one <link rel="canonical" href="${address}">, has ${canonical.join(', ') || 'none'}`);
    const og = (p) => head.match(new RegExp(`<meta property="og:${p}" content="([^"]*)">`))?.[1];
    const title = head.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    const description = head.match(/<meta name="description" content="([^"]*)">/)?.[1] ?? '';
    check(title && title.length <= 65, `${name}: the title is ${title.length} characters; search results show about 60`);
    check(description.length >= 50 && description.length <= 160, `${name}: the description is ${description.length} characters; search results show about 160`);
    check(og('url') === address, `${name}: og:url is ${og('url')}, expected ${address}`);
    check(og('title') === title, `${name}: og:title differs from the title`);
    check(og('description') === description, `${name}: og:description differs from the description`);
    check(og('image') === 'https://usugami.com/assets/img/social-preview.png', `${name}: og:image is ${og('image')}`);
    check(!!og('image:alt'), `${name}: no og:image:alt`);
    check(/<meta name="twitter:card" content="summary_large_image">/.test(head), `${name}: no twitter:card`);
    const data = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } });
    if (path === 'app/') {
      check(!data.length, 'app: no structured data expected on the web app');
    } else if (path === '') {
      check(data.length === 1 && data[0]?.['@type'] === 'WebSite' && data[0].name === 'Usugami' && data[0].url === address, 'home: needs one WebSite structured data, named Usugami, with the url https://usugami.com/');
    } else {
      const items = data.length === 1 && data[0]?.['@type'] === 'BreadcrumbList' ? data[0].itemListElement : [];
      check(items.length === 2 && items[0].item === 'https://usugami.com/' && items[1].item === address && items.every((it, i) => it['@type'] === 'ListItem' && it.position === i + 1 && it.name),
        `${name}: needs one BreadcrumbList from https://usugami.com/ to ${address}`);
    }
  }
  check(existsSync(join(root, 'site', 'assets', 'img', 'social-preview.png')), 'og:image: site/assets/img/social-preview.png is missing');
  check(!/rel="canonical"|og:url|ld\+json/.test(pages[404].replace(/<!--[\s\S]*?-->/g, ' ')), '404: should have no canonical address, Open Graph address or structured data');
  // Without JavaScript, the 404 page's note leads to the home page on the domain, over HTTPS.
  check(hrefs(part(pages[404], /<noscript>\s*<p>[\s\S]*?<\/noscript>/)).includes('https://usugami.com/'), '404: the noscript note should link to https://usugami.com/');

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
    // The service worker keeps the app's shell when installed and each tool's files as it is used
    // (site/app/sw.js), so the web app's card promises offline use only for tools used before.
    const webCard = pageText(part(main, /<article class="card way" aria-labelledby="way-web">[\s\S]*?<\/article>/));
    const offline = webCard.split(/(?<=\.)\s+/).filter((s) => /offline/i.test(s));
    check(offline.length && offline.every((s) => /\bused\b/.test(s)), `home: the web app's card should promise offline use only for the tools used once: "${offline.join(' ')}"`);
    // Four languages: the web app's own languages (site/app/locales/languages.js) as they are.
    const languages = stripJsComments(readFileSync(join(root, 'site', 'app', 'locales', 'languages.js'), 'utf8'));
    const codes = [...part(languages, /LANGUAGES\s*=\s*\[[\s\S]*?\]/).matchAll(/code:\s*'([^']+)'/g)].map((m) => m[1]);
    check(codes.includes('en'), `home: couldn't read the web app's languages (${codes.join(', ')})`);
    const englishOnly = codes.length === 1;
    check(text.includes('The web app is in English for now') === englishOnly,
      `home: the Four languages card should ${englishOnly ? '' : 'no longer '}say the web app is in English for now (the web app has ${codes.join(', ')})`);
  }

  // Each tool's feature card on Home leads to its page (the name is the link), and each tool page
  // opens a tool the web app has, first thing in its hero, and links to Download and Privacy.
  {
    const toolIds = new Set([...readFileSync(join(root, 'site', 'app', 'js', 'core', 'tools.js'), 'utf8').matchAll(/^\s*id: '([a-z-]+)'/gm)].map((m) => m[1]));
    check(toolIds.has('merge') && toolIds.size >= 18, `tool pages: couldn't read the web app's tools (${[...toolIds].join(', ')})`);
    for (const t of Object.values(TOOL_PAGES)) {
      check(pages.home.includes(`<h4 id="f-${t.card}"><a class="feature-link" href="${t.slug}/">`), `home: the feature card f-${t.card} should link to ${t.slug}/`);
      check(toolIds.has(t.opens), `${t.slug}: opens #/tool/${t.opens}, which the web app doesn't have`);
      const html = pages[t.slug];
      if (!html) continue;
      const main = part(html, /<main[\s\S]*?<\/main>/);
      const hero = part(main, /<section class="page-hero tool-hero"[\s\S]*?<\/section>/);
      check(hrefs(hero)[0] === `../app/#/tool/${t.opens}`, `${t.slug}: the first link in the hero should open the tool (../app/#/tool/${t.opens}), not ${hrefs(hero)[0]}`);
      check(pageText(hero).includes(`Open ${TOOL_PAGES[t.opens].name}`), `${t.slug}: the hero should say "Open ${TOOL_PAGES[t.opens].name}"`);
      for (const l of ['../download/', '../privacy/#on-the-web']) check(hrefs(main).includes(l), `${t.slug}: no link to ${l}`);
      check((main.match(/<h1[\s>]/g) ?? []).length === 1, `${t.slug}: needs exactly one h1`);
      check(/never leave your device|never uploaded|nothing is uploaded/i.test(pageText(main)), `${t.slug}: should say that files aren't uploaded`);
      for (const other of Object.values(TOOL_PAGES)) {
        if (other !== t) check(hrefs(main).includes(`../${other.slug}/`), `${t.slug}: "More PDF tools" doesn't link to ${other.slug}`);
      }
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
      '6F:4F:23:AD:E0:3E:63:6A:7C:C3:68:16:89:44:D0:CC:FC:81:32:EF:34:C5:0B:C5:A4:6B:0C:A4:CB:BD:F4:ED',
      // How to add the F-Droid repository, as on its own page (pdfer/fdroid/site/index.html).
      'Settings → Repositories → +', 'Then search for Usugami and install the app you want']) {
      check(text.includes(words), `download: doesn't say "${words}"`);
    }
    // One tap adds the repository in F-Droid, Droid-ify or Neo Store, with its fingerprint.
    check(links.includes('fdroidrepos://nathank.me/usugami/fdroid/repo?fingerprint=8D92FFB46DB5C052B334438D8E012974D3969A27EACFF4AEEE687B99A4760DA8'),
      'download: no "Add to F-Droid" link (fdroidrepos:// with the repository fingerprint)');
    // Code blocks: lines to paste wrap (select-all), and the others, which can scroll sideways on
    // phones, can be reached by keyboard and are named (Safari doesn't focus scrollers itself).
    for (const [, attrs] of main.matchAll(/<pre([^>]*)>/g)) {
      check(/class="select-all"/.test(attrs) || (/tabindex="0"/.test(attrs) && /role="region"/.test(attrs) && /aria-label="[^"]+"/.test(attrs)),
        `download: <pre${attrs}> should wrap (select-all) or have tabindex="0", role="region" and an aria-label`);
    }
  }

  // Privacy: what the web app downloads and stores, and where.
  {
    const text = pageText(part(pages.privacy, /<section[^>]*aria-labelledby="on-the-web"[\s\S]*?<\/section>/));
    for (const words of ['about 5 to 8 MB', 'from this same website', 'never leave your device', 'Fonts work the same way', 'local storage',
      'Usugami watermark switch with its size and opacity', 'IndexedDB', 'Recent files', 'service worker', 'Shared files', 'clear this site’s data',
      // Files opened with the installed app (manifest file_handlers, launchQueue) reach it too.
      'share to it or open with it',
      // Open shows a file in a browser tab (core/output.js openFile); only Share hands it to an app.
      'When you open a file, your browser shows it in a new tab',
      // Only tools used once work offline (sw.js).
      'each tool you have used',
      // A share reaches the app only through its service worker (manifest share_target, sw.js).
      'Without its service worker, your browser would send the shared files to this website']) {
      check(text.includes(words), `privacy: the web app's part doesn't say "${words}"`);
    }
    check(!text.includes('When you share or open a file, it goes to the app you pick'), 'privacy: Open shows the file in a browser tab, not in an app the visitor picks');
    // Every kind of browser storage the web app's own code uses (vendor/ aside) is described there.
    const kinds = [
      { re: /\blocalStorage\b/, words: 'local storage' },
      { re: /\bsessionStorage\b/, words: 'session storage' },
      { re: /\bindexedDB\b/, words: 'IndexedDB' },
      { re: /\bcaches\s*\.\s*(open|match|keys)\b/, words: 'service worker' },
      { re: /\bstorage\s*\.\s*getDirectory\b/, words: 'origin private file system' },
    ];
    const used = new Map();
    const settingKeys = new Set();
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'vendor') walk(path);
        } else if (/\.m?js$/.test(e.name)) {
          const code = stripJsComments(readFileSync(path, 'utf8'));
          for (const k of kinds) if (k.re.test(code)) used.set(k.words, [...(used.get(k.words) ?? []), path.slice(root.length + 1)]);
          for (const m of code.matchAll(/\bsetSetting\(\s*'([^']+)'/g)) settingKeys.add(m[1]);
        }
      }
    };
    walk(join(root, 'site', 'app'));
    check(used.has('local storage') && used.has('IndexedDB'), 'privacy: the storage scan found no localStorage or IndexedDB in site/app (is the scan broken?)');
    for (const [words, files] of used) {
      check(text.includes(words), `privacy: the web app uses ${words} (${files.join(', ')}), but the Privacy page doesn't describe it`);
    }
    // The Settings item names exactly the tools' choices the web app saves (setSetting keys):
    // nothing it doesn't keep (the OCR text language lives in memory only), nothing left out.
    const settingsItem = pageText(part(part(pages.privacy, /<section[^>]*aria-labelledby="on-the-web"[\s\S]*?<\/section>/), /<li>Settings:[\s\S]*?<\/li>/));
    check(settingKeys.has('images.pageSize'), `privacy: the setSetting scan found no images.pageSize (is the scan broken?): ${[...settingKeys].join(', ')}`);
    for (const [words, re] of [['page size', /pageSize/], ['orientation', /orientation/], ['margins', /margin/], ['one PDF or one per image', /\.merge$/],
      ['compression level', /compression/], ['text language', /ocr|textLanguage/i]]) {
      const saved = [...settingKeys].some((k) => re.test(k));
      check(settingsItem.includes(words) === saved, `privacy: the Settings item ${saved ? 'should' : 'shouldn’t'} name "${words}" (the web app saves ${[...settingKeys].join(', ')})`);
    }
  }
  console.log(`content: footers, Home, Download, Privacy and ${TOOL_PAGE_LIST.length} tool pages say what they must, with the sitemap`);
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
    // Content-Security-Policy <meta>s that don't protect the page: after a <link>, without
    // default-src, letting other hosts in, sending reports away, or in <body>.
    await put('csp-bad.html', `<!doctype html><html><head><link rel="stylesheet" href="style.css">
<meta http-equiv="Content-Security-Policy" content="script-src 'self' https://cdn.example.com *; img-src data: http:; report-uri https://r.example.com/x">
</head><body></body></html>`);
    await put('csp-body.html', `<!doctype html><html><head></head><body>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'"></body></html>`);
    // Structured data for search engines: valid JSON, with its schema.org @context and an @type.
    await put('ld.html', `<!doctype html><html><head><script type="application/ld+json">{"@context": "https://schema.org", "@type": "WebSite", "name": "ok"}</script>
<script type="application/ld+json">{"@context": "https://schema.org", "@type": "WebSite",}</script>
<script type="application/ld+json">[{"@type": "BreadcrumbList"}]</script>
</head><body></body></html>`);

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
      [/csp-bad\.html:1 .*<link> comes before the page's Content-Security-Policy/],
      [/csp-bad\.html:2 .*has no default-src/],
      [/csp-bad\.html:2 .*script-src allows "https:\/\/cdn\.example\.com"/],
      [/csp-bad\.html:2 .*script-src allows "\*"/],
      [/csp-bad\.html:2 .*img-src allows "http:"/],
      [/csp-bad\.html:2 .*report-uri sends reports/],
      [/csp-body\.html:2 .*is in <body>/],
      [/ld\.html:2 .*structured data \(ld\+json\) is not valid JSON/],
      [/ld\.html:3 .*structured data \(ld\+json\) needs "@context"/],
    ];
    for (const [re] of expect) check(text.some((t) => re.test(t)), `check-site missed ${re} in:\n    ${text.join('\n    ')}`);
    const wrong = [/share-target/, /commented/, /default\.example\.com/, /alternate/, /usugami\.com\/fr/, /github\.com\/Nath-Goa/, /#here" not found/, /#\/tool/, /ok\.js/, /\.\/share/, /svg-mask/, /data:image/, /"\.\/" /, /index\.html:7 /, /ld\.html:1 /];
    for (const re of wrong) check(!text.some((t) => re.test(t)), `check-site wrongly reported ${re}:\n    ${text.filter((t) => re.test(t)).join('\n    ')}`);
    check(text.length === expect.length, `check-site reported ${text.length} problems, expected ${expect.length}:\n    ${text.join('\n    ')}`);
    // As CI runs it (--require-csp): a page without a Content-Security-Policy <meta> is reported too.
    const noCsp = (r) => r.problems.filter((p) => /no Content-Security-Policy <meta>/.test(p.message)).map((p) => p.file.split('/').slice(-2).join('/'));
    check(noCsp(checkSite({ siteDir: site })).length === 0, 'without requireCsp, a page without a Content-Security-Policy is not reported');
    const required = noCsp(checkSite({ siteDir: site, requireCsp: true }));
    check(required.some((f) => /(^|\/)page\.html$/.test(f)) && required.includes('app/index.html'), `requireCsp reports page.html and app/index.html: ${required.join(', ')}`);

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
