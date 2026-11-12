// Builds the tool pages, one page per tool (site/merge-pdf/index.html, site/compress-pdf/index.html
// and so on: usugami.com/merge-pdf/), each saying what the tool does and how to use it and opening
// it in the web app, and site/sitemap.xml, the list of every page for search engines.
//
//   node tools/build-tool-pages.mjs           writes the pages and the sitemap
//   node tools/build-tool-pages.mjs --check   writes nothing; exits with 1 if a file differs from
//                                             what it would write (tests/site.test.mjs checks this)
//
// The words are in tools/tool-pages.mjs. Everything the tool pages share with the other pages is
// read from those pages, so it can't drift apart:
// - from site/download/index.html (one folder deep, like the tool pages): the <head> up to the
//   title and from color-scheme to the stylesheets (Content-Security-Policy and the theme script
//   included), the header without its aria-current, and the footer with the page's own address
//   in the hidden language switcher;
// - from site/index.html: the groups and their order (Home's feature groups, but not Everywhere),
//   each tool's icon (its feature card, id="f-<card>"), the two buttons with their notes and the
//   promise pills (the hero).
// Run it again after changing tools/tool-pages.mjs, or those parts of Download or Home (the test
// fails until you do). Don't edit the generated files by hand.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_PAGES, SHARED } from './tool-pages.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://usugami.com/';

/** The other pages search engines should list, in the sitemap's order (the tool pages go after the web app). */
const OTHER_PAGES = ['', 'app/'];
const LAST_PAGES = ['download/', 'privacy/'];

/**
 * Every file the tool pages are made of, as they should be on disk.
 * @param {{ siteDir?: string }} [opts] siteDir: the site folder (default site/)
 * @returns {{ files: Map<string, string>, pages: { slug: string, url: string, id: string }[] }}
 *   files: path relative to siteDir (with /) → contents; pages: the tool pages in order
 */
export function buildToolPages({ siteDir = join(repoRoot, 'site') } = {}) {
  const read = (path) => readFileSync(join(siteDir, path), 'utf8');
  const home = read('index.html');
  const download = read('download/index.html');
  const shared = sharedParts(home, download);
  const groups = homeGroups(home);

  validateShared();
  const byCard = new Map(Object.values(TOOL_PAGES).map((t) => [t.card, t]));
  for (const t of Object.values(TOOL_PAGES)) {
    validate(t);
    if (!TOOL_PAGES[t.opens]) throw new Error(`tool-pages.mjs: ${t.id} opens "${t.opens}", which has no page`);
  }
  const ordered = [];
  for (const g of groups) {
    g.tools = g.cards.map((card) => {
      const t = byCard.get(card);
      if (!t) throw new Error(`Home's feature card f-${card} (${g.name}) has no tool page in tools/tool-pages.mjs`);
      ordered.push(t);
      return t;
    });
  }
  for (const t of Object.values(TOOL_PAGES)) {
    if (!ordered.includes(t)) throw new Error(`tool-pages.mjs: ${t.id} (card f-${t.card}) isn't in one of Home's feature groups`);
  }

  const files = new Map();
  for (const g of groups) {
    for (const t of g.tools) files.set(`${t.slug}/index.html`, toolPage(t, g, groups, shared, home));
  }
  const pages = ordered.map((t) => ({ slug: t.slug, url: `${ORIGIN}${t.slug}/`, id: t.id }));
  files.set('sitemap.xml', sitemap([...OTHER_PAGES, ...ordered.map((t) => `${t.slug}/`), ...LAST_PAGES]));
  return { files, pages };
}

// ---------- The parts shared with the hand-written pages ----------

/**
 * Cuts text from `start` (found exactly once, included) to the first `end` after it (included when
 * endIncluded).
 */
function cut(text, start, end, { endIncluded = true, from = 'page' } = {}) {
  const a = once(text, start, from);
  const b = text.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`${from}: no "${end.trim().slice(0, 60)}" after "${start.trim().slice(0, 60)}"`);
  return text.slice(a, endIncluded ? b + end.length : b);
}

function once(text, marker, from) {
  const i = text.indexOf(marker);
  if (i < 0 || text.indexOf(marker, i + 1) >= 0) throw new Error(`${from}: expected "${marker.trim().slice(0, 60)}" exactly once`);
  return i;
}

/** Replaces `find` with `replacement`, which must occur exactly `count` times. */
function replaceCount(text, find, replacement, count, from) {
  const n = text.split(find).length - 1;
  if (n !== count) throw new Error(`${from}: expected "${find}" ${count} times, found ${n}`);
  return text.split(find).join(replacement);
}

function sharedParts(home, download) {
  const from = 'site/download/index.html';
  const headTop = cut(download, '<!doctype html>', '  <title>', { endIncluded: false, from });
  const headMid = cut(download, '  <meta name="color-scheme"', '<link rel="stylesheet" href="../assets/css/site.css">\n', { from });
  const header = replaceCount(cut(download, '<body>\n', '  </header>\n', { from }), ' aria-current="page"', '', 2, from);
  const footer = cut(download, '  <footer class="site-footer">', '</html>\n', { from });
  if (!/<script>[\s\S]*<\/script>/.test(headMid) || !/Content-Security-Policy/.test(headTop)) throw new Error(`${from}: the head isn't as expected`);

  const hero = cut(home, '<section class="hero"', '</section>', { from: 'site/index.html' });
  const ctaList = cut(hero, '<ul class="cta-list">', '</ul>', { from: 'site/index.html hero' });
  const pills = cut(hero, '<ul class="pills"', '</ul>', { from: 'site/index.html hero' });
  return { headTop, headMid, header, footer, ctaList, pills };
}

/** Home's feature groups (not Everywhere): id, name and the feature cards, in order. */
function homeGroups(home) {
  const groups = [];
  for (const m of home.matchAll(/<div class="feature-group" role="group" aria-labelledby="group-([a-z]+)">([\s\S]*?)<\/ul>\s*<\/div>/g)) {
    if (m[1] === 'everywhere') continue;
    const name = m[2].match(/<h3 class="group-title" id="group-[a-z]+">([^<]+)<\/h3>/)?.[1];
    const cards = [...m[2].matchAll(/<article class="card feature" aria-labelledby="f-([a-z-]+)">/g)].map((c) => c[1]);
    if (!name || !cards.length) throw new Error(`site/index.html: couldn't read the feature group "${m[1]}"`);
    groups.push({ id: m[1], name: decode(name), cards });
  }
  if (groups.length !== 4) throw new Error(`site/index.html: expected 4 feature groups besides Everywhere, found ${groups.length}`);
  return groups;
}

/** The icon of Home's feature card f-<card>, as written there. */
function cardIcon(home, card) {
  const article = cut(home, `<article class="card feature" aria-labelledby="f-${card}">`, '</article>', { from: 'site/index.html' });
  const icon = article.match(/<div class="icon-badge">(<svg class="icon"[\s\S]*?<\/svg>)<\/div>/)?.[1];
  if (!icon) throw new Error(`site/index.html: no icon in the feature card f-${card}`);
  return icon;
}

// ---------- A tool page ----------

const ICON_CHEVRON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.29 6.71a.996.996 0 0 0 0 1.41L13.17 12l-3.88 3.88a.996.996 0 1 0 1.41 1.41l4.59-4.59a.996.996 0 0 0 0-1.41L10.7 6.7c-.38-.38-1.02-.38-1.41.01z"/></svg>';

/** The text of a tool page's button, which opens its tool in the web app. */
export function buttonLabel(t) {
  return t.button ?? `Open ${TOOL_PAGES[t.opens].name}`;
}

function toolPage(t, group, groups, shared, home) {
  const url = `${ORIGIN}${t.slug}/`;
  const opens = TOOL_PAGES[t.opens];
  const open = buttonLabel(t);
  const route = `../app/#/tool/${opens.id}`;
  const from = `site/index.html hero, for ${t.slug}`;
  let cta = replaceCount(shared.ctaList, 'href="app/"', `href="${route}"`, 1, from);
  cta = replaceCount(cta, '> Use Usugami in your browser</a>', `> ${esc(open)}</a>`, 1, from);
  cta = replaceCount(cta, 'href="download/"', 'href="../download/"', 1, from);
  const footer = replaceCount(shared.footer, '/download/" hreflang=', `/${t.slug}/" hreflang=`, 4, 'site/download/index.html footer');
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Usugami', item: ORIGIN },
      { '@type': 'ListItem', position: 2, name: t.name, item: url },
    ],
  };
  const faq = [...t.faq, ...SHARED.faq];

  return `${shared.headTop}  <title>${esc(t.title)}</title>
  <meta name="description" content="${esc(t.description)}">
${shared.headMid}  <!-- The page's address on usugami.com, for search engines and link previews (absolute URLs; see docs/website.md). -->
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Usugami">
  <meta property="og:title" content="${esc(t.title)}">
  <meta property="og:description" content="${esc(t.description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="https://usugami.com/assets/img/social-preview.png">
  <meta property="og:image:width" content="1280">
  <meta property="og:image:height" content="640">
  <meta property="og:image:alt" content="${esc(SHARED.ogImageAlt)}">
  <meta name="twitter:card" content="summary_large_image">
  <!-- Where the page sits in the site, for search results (structured data; see docs/website.md). -->
  <script type="application/ld+json">
${indent(JSON.stringify(breadcrumb, null, 2), 2)}
  </script>
</head>
<!-- Made by tools/build-tool-pages.mjs from tools/tool-pages.mjs: change those, not this file. -->
${shared.header}
  <main id="main">
    <section class="page-hero tool-hero" aria-labelledby="page-title">
      <div class="wrap narrow">
        <div class="tool-title">
          <div class="icon-badge">${cardIcon(home, t.card)}</div>
          <p class="eyebrow">${esc(group.name)}</p>
        </div>
        <h1 id="page-title">${esc(t.h1)}</h1>
        <p class="lead">${t.lead}</p>
        ${cta}
        ${shared.pills}
      </div>
    </section>

    <section class="section" aria-labelledby="how-title">
      <div class="wrap narrow">
        <div class="section-head">
          <h2 id="how-title">${esc(t.howToHeading)}</h2>
        </div>
        <ol class="steps">
          <li><strong>Open the tool.</strong> ${SHARED.openStep.replace('{open}', esc(open))}</li>
${t.steps.map((s) => `          <li><strong>${s.title}.</strong> ${s.html}</li>`).join('\n')}
        </ol>
      </div>
    </section>

    <section class="section section-band" aria-labelledby="features-title">
      <div class="wrap narrow">
        <div class="section-head">
          <h2 id="features-title">${esc(t.featuresHeading)}</h2>
        </div>
        <ul class="tool-list">
${t.features.map((f) => `          <li>${f}</li>`).join('\n')}
        </ul>
      </div>
    </section>

    <section class="section" aria-labelledby="private-title">
      <div class="wrap narrow">
        <div class="section-head">
          <h2 id="private-title">${esc(SHARED.privacyHeading)}</h2>
${SHARED.privacy.map((p) => `          <p>${p}</p>`).join('\n')}
        </div>
        <ul class="link-list">
          <li><a href="../privacy/#on-the-web">${esc(SHARED.privacyLink)} ${ICON_CHEVRON}</a></li>
        </ul>
      </div>
    </section>

    <section class="section" aria-labelledby="faq-title">
      <div class="wrap narrow faq">
        <div class="section-head">
          <h2 id="faq-title">Questions</h2>
        </div>
${faq.map((f) => `        <h3>${f.q}</h3>\n        <p>${f.a}</p>`).join('\n')}
      </div>
    </section>

    <section class="section section-band" aria-labelledby="tools-title">
      <div class="wrap">
        <div class="section-head">
          <h2 id="tools-title">${esc(SHARED.toolsHeading)}</h2>
          <p>${SHARED.toolsIntro}</p>
        </div>
        <div class="tool-index">
${groups.map((g) => toolGroup(g, t)).join('\n')}
        </div>
      </div>
    </section>
  </main>

${footer}`;
}

/** One group in "More PDF tools": its name, then a link to each tool's page (this page's marked). */
function toolGroup(g, current) {
  const links = g.tools.map((t) => (t === current
    ? `              <li><a href="./" aria-current="page">${esc(t.name)}</a></li>`
    : `              <li><a href="../${t.slug}/">${esc(t.name)} ${ICON_CHEVRON}</a></li>`));
  return `          <div class="tool-index-group">
            <h3 class="group-title" id="tools-${g.id}">${esc(g.name)}</h3>
            <ul class="link-list">
${links.join('\n')}
            </ul>
          </div>`;
}

// ---------- The sitemap ----------

function sitemap(paths) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Every page of usugami.com for search engines, named in robots.txt. Made by tools/build-tool-pages.mjs: change that, not this file. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`).join('\n')}
</urlset>
`;
}

// ---------- Checks on the words ----------

const TEXT_FIELDS = ['name', 'title', 'description', 'h1', 'howToHeading', 'featuresHeading'];
const HTML_FIELDS = ['lead'];

/** Catches what would break the page or the site's style before it is written. */
function validate(t) {
  const where = `tool-pages.mjs ${t.id}`;
  for (const key of ['id', 'slug', 'card', 'opens', ...TEXT_FIELDS, ...HTML_FIELDS]) {
    if (typeof t[key] !== 'string' || !t[key].trim()) throw new Error(`${where}: ${key} is missing`);
  }
  if (t.button !== undefined) checkText(`${where} button`, t.button, false);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.slug)) throw new Error(`${where}: slug "${t.slug}" should be lower case words with hyphens`);
  if (!t.title.endsWith(': Usugami') || t.title.length > 65) throw new Error(`${where}: the title should end with ": Usugami" and be at most 65 characters (${t.title.length})`);
  if (t.description.length < 110 || t.description.length > 160) throw new Error(`${where}: the description should be 110 to 160 characters (${t.description.length})`);
  if (t.steps.length < 2 || t.features.length < 3 || t.faq.length < 1) throw new Error(`${where}: needs at least 2 steps, 3 features and 1 question`);
  const texts = [
    ...TEXT_FIELDS.map((k) => [k, t[k], false]),
    ...HTML_FIELDS.map((k) => [k, t[k], true]),
    ...t.steps.flatMap((s, i) => [[`steps[${i}].title`, s.title, true], [`steps[${i}].html`, s.html, true]]),
    ...t.features.map((f, i) => [`features[${i}]`, f, true]),
    ...t.faq.flatMap((f, i) => [[`faq[${i}].q`, f.q, true], [`faq[${i}].a`, f.a, true]]),
  ];
  for (const [key, text, html] of texts) checkText(`${where} ${key}`, text, html);
}

function validateShared() {
  const where = 'tool-pages.mjs SHARED';
  for (const key of ['ogImageAlt', 'privacyHeading', 'privacyLink', 'toolsHeading']) checkText(`${where} ${key}`, SHARED[key], false);
  for (const key of ['openStep', 'toolsIntro']) checkText(`${where} ${key}`, SHARED[key]);
  if (!SHARED.openStep.includes('<strong>{open}</strong>')) throw new Error(`${where} openStep: should name the button as <strong>{open}</strong>`);
  SHARED.privacy.forEach((p, i) => checkText(`${where} privacy[${i}]`, p));
  SHARED.faq.forEach((f, i) => { checkText(`${where} faq[${i}].q`, f.q); checkText(`${where} faq[${i}].a`, f.a); });
}

/**
 * Visible text: no straight quotes or apostrophes (the site uses ’ “ ”), no em dashes, & written
 * as &amp;, and only <strong>, <em> and <code> as tags (in fields that take HTML).
 */
export function checkText(where, text, html = true) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${where}: empty`);
  if (/['"]/.test(text)) throw new Error(`${where}: straight quote or apostrophe (use ’ “ ”): ${text}`);
  if (text.includes('—')) throw new Error(`${where}: em dash: ${text}`);
  if (/&(?!(?:amp|lt|gt|nbsp|#\d+);)/.test(text)) throw new Error(`${where}: write & as &amp;: ${text}`);
  const tags = text.match(/<[^>]*>/g) ?? [];
  if (!html && tags.length) throw new Error(`${where}: no tags allowed here: ${text}`);
  for (const tag of tags) if (!/^<\/?(?:strong|em|code)>$/.test(tag)) throw new Error(`${where}: tag ${tag} isn't allowed: ${text}`);
  for (const name of ['strong', 'em', 'code']) {
    const opened = (text.match(new RegExp(`<${name}>`, 'g')) ?? []).length;
    const closed = (text.match(new RegExp(`</${name}>`, 'g')) ?? []).length;
    if (opened !== closed) throw new Error(`${where}: <${name}> isn't closed: ${text}`);
  }
}

// ---------- Helpers ----------

/** Escapes text for HTML (text and attribute values); entities already written stay as they are. */
function esc(s) {
  return String(s).replace(/&(?!(?:amp|lt|gt|quot|nbsp|#\d+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decode(s) {
  return s.replace(/&amp;/g, '&');
}

function indent(text, n) {
  return text.split('\n').map((l) => ' '.repeat(n) + l).join('\n');
}

// ---------- Command line ----------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--check');
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}\nUsage: node tools/build-tool-pages.mjs [--check]`);
    process.exit(2);
  }
  const siteDir = join(repoRoot, 'site');
  const { files } = buildToolPages({ siteDir });
  if (args.includes('--check')) {
    const stale = [...files].filter(([path, text]) => !existsSync(join(siteDir, path)) || readFileSync(join(siteDir, path), 'utf8') !== text).map(([path]) => path);
    if (stale.length) {
      console.log(`Out of date (run node tools/build-tool-pages.mjs): ${stale.map((p) => `site/${p}`).join(', ')}`);
      process.exit(1);
    }
    console.log(`${files.size} files up to date.`);
  } else {
    for (const [path, text] of files) {
      mkdirSync(dirname(join(siteDir, path)), { recursive: true });
      writeFileSync(join(siteDir, path), text);
    }
    console.log(`Wrote ${files.size} files: ${[...files.keys()].map((p) => `site/${p}`).join(', ')}`);
  }
}
