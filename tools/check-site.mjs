// Checks the static site in site/ for the rules in docs/ARCHITECTURE.md, with Node built-ins only:
//
//   node tools/check-site.mjs                 the whole site
//   node tools/check-site.mjs site/index.html site/download   only these files or folders
//                                             (links are still resolved against the whole site)
//   node tools/check-site.mjs --require-csp   also: every page has a Content-Security-Policy
//
// It fails (exit code 1) on:
// - root-relative URLs ("/..."), which break when the site is in a sub-folder (GitHub Pages);
// - outside resources (http://, https:// or //) loaded by the pages: src, srcset, <link href>
//   (except rel=alternate and rel=canonical), CSS url() and @import, and in JavaScript import,
//   fetch, new URL, importScripts, Worker and serviceWorker.register (not scanned inside
//   site/app/vendor, whose libraries contain default URLs that the app overrides);
// - document.cookie, the ping attribute, navigator.sendBeacon and analytics or tracker names;
// - a CNAME file (the domain is set in the repository settings);
// - relative links, sources and imports whose target doesn't exist (a folder needs index.html;
//   names must match in case, as on GitHub Pages), and #anchors that don't exist on their page;
// - inline scripts or styles a page's own Content-Security-Policy would block (it prints the
//   hash to add when an inline script changes); a CSP <meta> that comes after what it should
//   cover or outside <head>, has no default-src, lets the page reach another host or sends
//   reports; and with --require-csp (CI uses it), a page without one;
// - the same id twice on a page.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED = new Set(['.html', '.css', '.js', '.mjs', '.webmanifest']);

// Analytics and tracker names, as they appear in code (not plain words such as "analytics").
const TRACKERS = [
  /google-analytics\.com/i, /googletagmanager\.com/i, /\bgtag\s*\(/, /\bga\s*\(\s*['"](?:create|send)/,
  /\banalytics\.js\b/i, /\bgtm\.js\b/i, /doubleclick\.net/i, /googlesyndication\.com/i, /googleadservices\.com/i,
  /plausible\.io/i, /\bplausible\s*\(/, /\bmatomo\b/i, /\bpiwik\b/i, /umami\.is/i, /usefathom\.com/i,
  /simpleanalytics/i, /goatcounter/i, /getclicky\.com/i, /statcounter/i, /cloudflareinsights\.com/i,
  /\bmixpanel\b/i, /segment\.(?:io|com)/i, /amplitude\.com/i, /heapanalytics/i, /\bhotjar\b/i,
  /clarity\.ms/i, /fullstory/i, /\bposthog\b/i, /sentry\.io/i, /@sentry\//, /\bSentry\.init\b/,
  /bugsnag/i, /nr-data\.net/i, /datadoghq/i, /connect\.facebook\.net/i, /\bfbq\s*\(/,
  /snap\.licdn\.com/i, /ads-twitter\.com/i, /analytics\.tiktok\.com/i, /mc\.yandex/i, /hm\.baidu\.com/i,
  /\bsendBeacon\b/, /\bdocument\s*\.\s*cookie\b/, /\bcookieStore\b/,
];

/**
 * Checks the site and returns what it found.
 * @param {{ siteDir?: string, only?: string[], requireCsp?: boolean }} [opts] siteDir: the site
 *   folder (default site/); only: files or folders to check (default: all), absolute or relative
 *   to the working directory; requireCsp: an HTML page without a Content-Security-Policy <meta>
 *   is a problem (default false; --require-csp on the command line)
 * @returns {{ problems: { file: string, line: number, message: string }[], files: string[] }}
 */
export function checkSite({ siteDir = join(repoRoot, 'site'), only = [], requireCsp = false } = {}) {
  const site = resolve(siteDir);
  const problems = [];
  const report = (file, line, message) => problems.push({ file: rel(file), line, message });
  const rel = (f) => relative(process.cwd(), f).split(sep).join('/');

  // A CNAME file would point GitHub Pages at a domain before it is ready.
  for (const dir of [site, resolve(site, '..')]) {
    for (const name of safeList(dir)) {
      if (name.toLowerCase() === 'cname') report(join(dir, name), 0, 'CNAME file: set the custom domain in the repository settings instead');
    }
  }

  const all = walk(site);
  const roots = only.map((p) => resolve(p));
  const files = all.filter((f) => SCANNED.has(extname(f).toLowerCase()))
    .filter((f) => !roots.length || roots.some((r) => f === r || f.startsWith(r + sep)));
  for (const r of roots) if (!existsSync(r)) report(r, 0, 'no such file or folder to check');

  const htmlCache = new Map();
  const idsOf = (file) => {
    if (!htmlCache.has(file)) htmlCache.set(file, parseHtml(readFileSync(file, 'utf8')).ids);
    return htmlCache.get(file);
  };
  const vendorDir = join(site, 'app', 'vendor');

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const ext = extname(file).toLowerCase();
    const inVendor = file.startsWith(vendorDir + sep);
    const ctx = { file, site, report, idsOf, requireCsp };
    if (ext === '.html') checkHtml(text, ctx);
    else if (ext === '.css') checkCss(text, ctx, file, 1);
    else if (ext === '.webmanifest') checkManifest(text, ctx);
    else checkJs(text, ctx, { base: file, line: 1, skipUrls: inVendor });
  }
  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { problems, files: files.map(rel) };
}

// ---------- HTML ----------

const RESOURCE_ATTRS = new Set(['src', 'poster', 'data', 'srcset', 'imagesrcset']);

function parseHtml(html) {
  // Blank out comments, keeping line breaks so line numbers stay right.
  const clean = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const tags = [];
  const ids = new Map();
  const tagRe = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRe.exec(clean))) {
    const name = m[1].toLowerCase();
    const attrs = {};
    const attrRe = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const line = lineAt(clean, m.index);
    const tag = { name, attrs, line, index: m.index, end: m.index + m[0].length };
    tags.push(tag);
    for (const key of ['id', ...(name === 'a' ? ['name'] : [])]) {
      if (attrs[key] !== undefined && attrs[key] !== '') {
        if (!ids.has(attrs[key])) ids.set(attrs[key], []);
        ids.get(attrs[key]).push(line);
      }
    }
    // Skip the contents of script and style elements; they are checked separately.
    if (name === 'script' || name === 'style') {
      const close = clean.slice(tag.end).search(new RegExp(`</${name}\\s*>`, 'i'));
      tag.content = close >= 0 ? html.slice(tag.end, tag.end + close) : '';
      tagRe.lastIndex = close >= 0 ? tag.end + close : clean.length;
    }
  }
  return { tags, ids };
}

function checkHtml(html, ctx) {
  const { file, report } = ctx;
  const { tags, ids } = parseHtml(html);
  for (const [id, lines] of ids) {
    if (lines.length > 1) report(file, lines[1], `id "${id}" is used more than once (lines ${lines.join(', ')})`);
  }
  const csp = tags.find((t) => t.name === 'meta' && (t.attrs['http-equiv'] || '').toLowerCase() === 'content-security-policy');
  const cspDirectives = csp ? parseCsp(csp.attrs.content || '') : null;
  if (csp) checkCspMeta(csp, cspDirectives, tags, ctx);
  else if (ctx.requireCsp) report(file, 1, "no Content-Security-Policy <meta>: add one at the top of <head> (default-src 'self'), as the other pages have");

  for (const t of tags) {
    const { name, attrs, line } = t;
    const rels = (attrs.rel || '').toLowerCase().split(/\s+/);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'ping') report(file, line, `<${name} ping>: hyperlink auditing is tracking`);
      if (key === 'style') checkCss(value, ctx, file, line, true);
      if (key.startsWith('on') && /\bdocument\s*\.\s*cookie\b/.test(value)) report(file, line, 'document.cookie in an event handler');
      if (key === 'srcset' || key === 'imagesrcset') {
        for (const part of value.split(',')) {
          const url = part.trim().split(/\s+/)[0];
          if (url) checkUrl(url, ctx, { line, what: `<${name} ${key}>`, resource: true, base: file });
        }
      } else if (RESOURCE_ATTRS.has(key) && (key !== 'data' || name === 'object')) {
        checkUrl(value, ctx, { line, what: `<${name} ${key}>`, resource: true, base: file });
      } else if (key === 'href' || key === 'xlink:href') {
        if (name === 'link') {
          const isLinkOut = rels.includes('alternate') || rels.includes('canonical');
          checkUrl(value, ctx, { line, what: `<link rel="${attrs.rel || ''}" href>`, resource: !isLinkOut, base: file, mustExist: !isLinkOut });
        } else if (name === 'base') {
          checkUrl(value, ctx, { line, what: '<base href>', resource: true, base: file, mustExist: false });
        } else if (name === 'use' || name === 'image' || name === 'feimage') {
          checkUrl(value, ctx, { line, what: `<${name} href>`, resource: true, base: file });
        } else {
          checkUrl(value, ctx, { line, what: `<${name} href>`, resource: false, base: file });
        }
      } else if (key === 'action' || key === 'formaction') {
        checkUrl(value, ctx, { line, what: `<${name} ${key}>`, resource: false, base: file, mustExist: false });
      }
    }
    if (name === 'meta' && (attrs['http-equiv'] || '').toLowerCase() === 'refresh') {
      const url = (attrs.content || '').match(/url\s*=\s*['"]?([^'"]+)/i)?.[1];
      if (url) checkUrl(url.trim(), ctx, { line, what: '<meta http-equiv="refresh">', resource: false, base: file });
    }
    if (name === 'script' && attrs.src === undefined) {
      const type = (attrs.type || '').toLowerCase();
      if (type === 'importmap') checkImportMap(t.content, ctx, line);
      else if (!type || type === 'module' || type.includes('javascript')) {
        checkJs(t.content, ctx, { base: file, line, inHtml: true });
        if (cspDirectives) checkCspScript(t.content, cspDirectives, ctx, line);
      }
    }
    if (name === 'style') {
      checkCss(t.content, ctx, file, line);
      if (cspDirectives && !allowsInline(cspDirectives, 'style-src')) report(file, line, 'inline <style> is blocked by the page\'s Content-Security-Policy (style-src)');
    }
    if (cspDirectives && attrs.style !== undefined && !allowsInline(cspDirectives, 'style-src')) {
      report(file, line, `style attribute on <${name}> is blocked by the page's Content-Security-Policy (style-src)`);
    }
  }
}

function parseCsp(content) {
  const out = {};
  for (const part of content.split(';')) {
    const [key, ...values] = part.trim().split(/\s+/);
    if (key) out[key.toLowerCase()] = values;
  }
  return out;
}

// Source expressions that let a page load only from the site itself (or from memory).
const LOCAL_SOURCE = /^(?:'(?:self|none|unsafe-inline|unsafe-eval|wasm-unsafe-eval|unsafe-hashes|strict-dynamic|report-sample|inline-speculation-rules)'|'(?:sha256|sha384|sha512)-[A-Za-z0-9+/_=-]+'|'nonce-[^']+'|(?:blob|data|mediastream|filesystem):)$/i;
// Directives whose values aren't sources.
const NOT_SOURCES = new Set(['sandbox', 'upgrade-insecure-requests', 'block-all-mixed-content', 'require-trusted-types-for', 'trusted-types', 'webrtc']);

/**
 * A CSP <meta> covers only what comes after it, and only in <head>; it must start from
 * default-src and allow no other host, so it backs up the rule of no outside requests.
 */
function checkCspMeta(meta, csp, tags, { file, report }) {
  const body = tags.find((t) => t.name === 'body');
  if (body && body.index < meta.index) report(file, meta.line, 'Content-Security-Policy <meta> is in <body>, where browsers ignore it: put it at the top of <head>');
  const before = tags.find((t) => t.index < meta.index && (['script', 'style', 'link', 'base'].includes(t.name) || t.attrs.src !== undefined));
  if (before) report(file, before.line, `<${before.name}> comes before the page's Content-Security-Policy <meta> (line ${meta.line}), which doesn't cover it: put the <meta> first in <head>`);
  if (!csp['default-src']) report(file, meta.line, "Content-Security-Policy has no default-src: start it with default-src 'self'");
  for (const [directive, values] of Object.entries(csp)) {
    if (directive === 'report-uri' || directive === 'report-to') {
      report(file, meta.line, `Content-Security-Policy ${directive} sends reports to a server`);
    } else if (!NOT_SOURCES.has(directive)) {
      for (const v of values) {
        if (!LOCAL_SOURCE.test(v)) report(file, meta.line, `Content-Security-Policy ${directive} allows "${v}": only the site itself ('self') and blob:/data: may be sources`);
      }
    }
  }
}

function allowsInline(csp, directive) {
  const list = csp[directive] ?? csp['default-src'];
  if (!list) return true;
  return list.includes("'unsafe-inline'") && !list.some((v) => /^'(?:sha\d+|nonce)-/.test(v));
}

function checkCspScript(code, csp, ctx, line) {
  const list = csp['script-src'] ?? csp['default-src'];
  if (!list || allowsInline(csp, 'script-src')) return;
  const hash = `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
  if (!list.includes(hash)) ctx.report(ctx.file, line, `inline script is blocked by the page's Content-Security-Policy: add ${hash} to script-src (and remove the old hash)`);
}

function checkImportMap(json, ctx, line) {
  let map;
  try { map = JSON.parse(json); } catch { return ctx.report(ctx.file, line, 'import map is not valid JSON'); }
  const values = [...Object.values(map.imports || {}), ...Object.values(map.scopes || {}).flatMap((s) => Object.values(s))];
  for (const v of values) checkUrl(String(v), ctx, { line, what: 'import map', resource: true, base: ctx.file });
}

// ---------- CSS ----------

function checkCss(css, ctx, base, startLine, inline = false) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const re = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1|url\(\s*(['"]?)([^'")]*?)\3\s*\)/gi;
  let m;
  while ((m = re.exec(clean))) {
    const url = (m[2] ?? m[4] ?? '').trim();
    if (!url || url.startsWith('#') || /^data:/i.test(url)) continue;
    const line = startLine + (inline ? 0 : lineAt(clean, m.index) - 1);
    checkUrl(url, ctx, { line, what: m[2] !== undefined ? 'CSS @import' : 'CSS url()', resource: true, base });
  }
  scanTrackers(clean, ctx, startLine, inline);
}

// ---------- JavaScript ----------

function checkJs(code, ctx, { base, line: startLine, inHtml = false, skipUrls = false }) {
  const clean = stripJsComments(code);
  scanTrackers(clean, ctx, startLine);
  if (skipUrls) return;
  const at = (i) => startLine + lineAt(clean, i) - 1;
  const lit = String.raw`(['"\x60])((?:(?!\1)[^\\\n]|\\.)*)\1`;
  const patterns = [
    // import ... from '...', export ... from '...', import '...'
    { re: new RegExp(String.raw`(?<![\w$.])(?:import|export)\s*(?:[\w*${'$'}{}\s,]+?\s*from\s*)?` + lit, 'g'), kind: 'import' },
    { re: new RegExp(String.raw`(?<![\w$.])import\s*\(\s*` + lit + String.raw`\s*[,)]`, 'g'), kind: 'import' },
    { re: new RegExp(String.raw`(?<![\w$.])fetch\s*\(\s*` + lit, 'g'), kind: 'fetch' },
    { re: new RegExp(String.raw`(?<![\w$.])new\s+URL\s*\(\s*` + lit + String.raw`\s*(?:,\s*([^)]*?))?\s*\)`, 'g'), kind: 'url' },
    { re: new RegExp(String.raw`(?<![\w$.])new\s+(?:Shared)?Worker\s*\(\s*` + lit, 'g'), kind: 'worker' },
    { re: new RegExp(String.raw`serviceWorker\s*\.\s*register\s*\(\s*` + lit, 'g'), kind: 'worker' },
  ];
  for (const { re, kind } of patterns) {
    let m;
    while ((m = re.exec(clean))) {
      const quote = m[1];
      const url = m[2];
      if (quote === '`' && url.includes('${')) continue;
      const line = at(m.index);
      if (kind === 'import') {
        if (!/^(?:\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(url)) {
          ctx.report(ctx.file, line, `bare import "${url}": browsers need a relative path such as "./${url}"`);
          continue;
        }
        checkUrl(url, ctx, { line, what: 'JavaScript import', resource: true, base });
      } else if (kind === 'url') {
        const second = (m[3] || '').trim();
        const known = second === 'import.meta.url' || (inHtml && second === '');
        // Only a path that names a file must exist: others may be routes the service worker
        // answers (such as a share target) or folders used as a base.
        const namesFile = /\.[a-z0-9]+$/i.test(url.replace(/[?#].*$/, ''));
        checkUrl(url, ctx, { line, what: 'new URL()', resource: true, base, folderOk: true, mustExist: known && namesFile });
      } else {
        // fetch and workers resolve against the page, which only an inline script knows.
        checkUrl(url, ctx, { line, what: kind === 'fetch' ? 'fetch()' : 'Worker', resource: true, base, mustExist: inHtml });
      }
    }
  }
  const imp = /(?<![\w$.])importScripts\s*\(([^)]*)\)/g;
  let m;
  while ((m = imp.exec(clean))) {
    for (const s of m[1].matchAll(/(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      checkUrl(s[2], ctx, { line: at(m.index), what: 'importScripts()', resource: true, base });
    }
  }
}

/**
 * Removes // and /* *\/ comments, keeping strings, template literals, regular expressions and line
 * breaks, so line numbers stay right. tests/site.test.mjs uses it too.
 * @param {string} src  JavaScript source
 * @returns {string}
 */
export function stripJsComments(src) {
  const out = [];
  const n = src.length;
  const special = /[/"'`]/g;
  let i = 0;
  let last = ''; // the last significant character before i: tells a regular expression from a division
  const noteCode = (from, to) => {
    for (let k = to - 1; k >= from; k--) {
      const ch = src[k];
      if (!/\s/.test(ch)) { last = /[\w$)\]]/.test(ch) ? 'x' : ch; return; }
    }
  };
  while (i < n) {
    special.lastIndex = i;
    const found = special.exec(src);
    const at = found ? found.index : n;
    if (at > i) { out.push(src.slice(i, at)); noteCode(i, at); }
    if (!found) break;
    i = at;
    const c = src[i];
    const d = src[i + 1];
    let stop;
    if (c === '/' && d === '/') {
      const nl = src.indexOf('\n', i);
      stop = nl < 0 ? n : nl;
      out.push(' '.repeat(stop - i));
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      stop = end < 0 ? n : end + 2;
      out.push(src.slice(i, stop).replace(/[^\n]/g, ' '));
    } else if (c === '/' && !/[(,=:[!&|?{};+\-*%<>~^]|^$/.test(last)) {
      stop = i + 1; // a division
      out.push(c);
      last = c;
    } else {
      // A string, template literal or regular expression: copy it whole.
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (c === '/') {
          if (ch === '\n') break;
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
        } else if (ch === c || (c !== '`' && ch === '\n')) break;
        j++;
      }
      stop = Math.min(n, j + 1);
      out.push(src.slice(i, stop));
      last = c === '/' ? 'x' : c;
    }
    i = stop;
  }
  return out.join('');
}

// ---------- Web app manifest ----------

function checkManifest(text, ctx) {
  let json;
  try { json = JSON.parse(text); } catch (e) { return ctx.report(ctx.file, 1, `not valid JSON: ${e.message}`); }
  const visit = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${path}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof x === 'string' && ['src', 'start_url', 'scope', 'action', 'url', 'id'].includes(k)) {
        const line = lineAt(text, Math.max(0, text.indexOf(JSON.stringify(x))));
        // Icons and screenshots are files; start_url must be a page; the rest are routes.
        const mustExist = k === 'src' || k === 'start_url';
        checkUrl(x, ctx, { line, what: `manifest ${p}`, resource: true, base: ctx.file, mustExist });
      } else visit(x, p);
    }
  };
  visit(json, '');
}

// ---------- URLs ----------

function checkUrl(raw, ctx, { line, what, resource, base, mustExist = true, folderOk = false }) {
  const { file, report } = ctx;
  const url = raw.trim();
  if (!url) return;
  if (/^javascript:/i.test(url)) return report(file, line, `${what}: javascript: URL`);
  if (/^(?:https?:)?\/\//i.test(url)) {
    if (resource) report(file, line, `${what}: outside resource "${url}" (serve it from site/)`);
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return; // mailto:, data:, blob:, obtainium:, ...
  if (url.startsWith('/')) return report(file, line, `${what}: root-relative URL "${url}" breaks in a sub-folder; use a relative path`);
  if (!mustExist) return;

  const hashAt = url.indexOf('#');
  const fragment = hashAt >= 0 ? url.slice(hashAt + 1) : null;
  const path = url.replace(/[?#].*$/, '');
  let target = base;
  if (path) {
    let decoded;
    try { decoded = decodeURI(path); } catch { return report(file, line, `${what}: badly encoded URL "${url}"`); }
    target = resolve(dirname(base), ...decoded.split('/'));
    if (target !== ctx.site && !target.startsWith(ctx.site + sep)) return report(file, line, `${what}: "${url}" points outside the site`);
    const found = findExact(ctx.site, target);
    if (found === 'case') return report(file, line, `${what}: "${url}" differs in upper and lower case from the file (GitHub Pages is case-sensitive)`);
    if (!found) return report(file, line, `${what}: "${url}" not found`);
    if (statSync(target).isDirectory()) {
      if (!path.endsWith('/')) report(file, line, `${what}: "${url}" is a folder; end it with "/"`);
      // A folder as a base for other URLs (new URL('fonts/', import.meta.url)) needn't be a page.
      if (folderOk) return;
      target = join(target, 'index.html');
      if (!existsSync(target)) return report(file, line, `${what}: folder "${url}" has no index.html`);
    }
  }
  // Same-page and other-page #anchors (not app routes such as #/tool/split, or text fragments).
  if (fragment && !fragment.includes('/') && !fragment.startsWith(':~:') && fragment !== 'top' && extname(target).toLowerCase() === '.html') {
    let id;
    try { id = decodeURIComponent(fragment); } catch { id = fragment; }
    if (!ctx.idsOf(target).has(id)) report(file, line, `${what}: anchor "#${fragment}" not found in ${relative(ctx.site, target).split(sep).join('/')}`);
  }
}

/**
 * true if the path exists with exactly this case, 'case' if only in another case (Windows and macOS
 * would find it, GitHub Pages wouldn't), false if not at all.
 */
function findExact(site, target) {
  let dir = site;
  let exact = true;
  for (const part of relative(site, target).split(sep).filter(Boolean)) {
    const names = safeList(dir);
    let name = names.includes(part) ? part : null;
    if (!name) {
      name = names.find((x) => x.toLowerCase() === part.toLowerCase());
      if (!name || part === '..') return false;
      exact = false;
    }
    dir = join(dir, name);
  }
  return exact ? true : 'case';
}

// ---------- Helpers ----------

function scanTrackers(text, ctx, startLine, inline = false) {
  for (const re of TRACKERS) {
    const m = re.exec(text);
    if (m) ctx.report(ctx.file, startLine + (inline ? 0 : lineAt(text, m.index) - 1), `tracking or cookies: "${m[0]}"`);
  }
}

const listCache = new Map();
function safeList(dir) {
  if (!listCache.has(dir)) {
    try { listCache.set(dir, readdirSync(dir)); } catch { listCache.set(dir, []); }
  }
  return listCache.get(dir);
}

function walk(dir) {
  const out = [];
  for (const name of safeList(dir)) {
    const p = join(dir, name);
    let info;
    try { info = statSync(p); } catch { continue; }
    if (info.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
  });
}

// ---------- Command line ----------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const only = args.filter((a) => !a.startsWith('--'));
  const unknown = args.filter((a) => a.startsWith('--') && a !== '--require-csp');
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}
Usage: node tools/check-site.mjs [--require-csp] [file or folder ...]`);
    process.exit(2);
  }
  // --require-csp: every page must have its own Content-Security-Policy.
  const { problems, files } = checkSite({ only, requireCsp: args.includes('--require-csp') });
  if (problems.length) {
    let last = '';
    for (const p of problems) {
      if (p.file !== last) { console.log(`\n${p.file}`); last = p.file; }
      console.log(`  ${p.line ? `line ${p.line}: ` : ''}${p.message}`);
    }
    console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in ${new Set(problems.map((p) => p.file)).size} of ${files.length} files checked.`);
    process.exit(1);
  }
  console.log(`Checked ${files.length} files: no problems.`);
}
