// The web app's service worker: the app works offline once opened, and files shared to the
// installed app (Web Share Target) are received here and handed to the page.
//
// Same-origin GET requests go to the network first, so the app is never stale while online; what
// comes back is kept, and used when the network can't be reached (or the server fails). The shell
// is kept when this worker installs. Everything else is kept as it is first used, not before:
// libraries (site/app/vendor), fonts (site/app/fonts), text recognition's engine and language data
// (vendor/tesseract, 4.8 to 8.4 MB a language) and tool screens, so a tool, a font or a text
// language used once works offline afterwards. Other sites' requests are never answered or kept
// here, nor are Range requests.
//
// Code belongs to one version of the site: the shell and the code kept as it is used (modules,
// styles, strings, libraries) are kept per version, and a new version fetches again the code the
// last one had kept, so offline the app never mixes files of two versions. Fonts and text
// recognition's language data don't change between versions and stay.

// The deploy workflow replaces 'dev' with the commit being published.
const VERSION = 'dev';

const SHELL_CACHE = `usugami-shell-${VERSION}`;
const CODE_CACHE = `usugami-code-${VERSION}`;
const RUNTIME_CACHE = 'usugami-runtime';
const SHARE_CACHE = 'usugami-share';

// The codes of locales/languages.js's LANGUAGES (tests/shell.test.mjs checks they agree): the
// strings the app loads at start are kept in each, so it opens offline in the language chosen.
const LANGUAGES = ['en'];

// Relative to this file (site/app/): what the app needs to start and show its own screens (every
// module main.js and the shell's screens import, and what the modules listed here import, which
// tests/shell.test.mjs checks), and the kit.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  '../assets/css/tokens.css',
  'css/app.css',
  'css/components.css',
  // The result screen's watermark card (core/output.js loads it).
  'css/mark.css',
  'js/main.js',
  'js/core/dom.js',
  'js/core/i18n.js',
  'js/core/settings.js',
  'js/core/router.js',
  'js/core/icons.js',
  'js/core/recent.js',
  'js/core/names.js',
  'js/core/search.js',
  'js/core/share-inbox.js',
  'js/core/tools.js',
  'js/core/errors.js',
  'js/core/ui.js',
  'js/core/files.js',
  'js/core/pdfdoc.js',
  'js/core/pagegrid.js',
  'js/core/output.js',
  'js/core/result-mark.js',
  'js/core/batch.js',
  'js/engine/mark-layout.js',
  // What core/files.js tells image files by (by their content) and the types it picks.
  'js/engine/images/image-type.js',
  'js/screens/home.js',
  'js/screens/recent.js',
  'js/screens/settings.js',
  'js/screens/about.js',
  'js/screens/licenses.js',
  'js/screens/choose.js',
  'js/screens/language.js',
  'js/lib/fflate.js',
  'vendor/fflate/fflate.esm.js',
  'vendor/VERSIONS.json',
  'locales/languages.js',
  // The common, kit and mark strings, loaded at start, in every language.
  ...LANGUAGES.flatMap((code) => [`locales/${code}/common.js`, `locales/${code}/kit.js`, `locales/${code}/mark.js`]),
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

const scope = () => self.registration.scope;

/**
 * Whether `url` is data the same for every version (fonts, text recognition's languages), kept in
 * RUNTIME_CACHE across versions; anything else of this site is code, kept per version.
 */
function isData(url) {
  const base = scope();
  if (!url.startsWith(base)) return false;
  const rest = url.slice(base.length).split(/[?#]/)[0];
  return rest.startsWith('fonts/') || rest.startsWith('vendor/tesseract/lang/');
}

/** Fetches `urls` into `cache`, a few at a time; one that fails is left out. */
async function keepAll(cache, urls) {
  const queue = urls.slice();
  const one = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        // Checked with the server (a 304 costs nothing), not taken blindly from the HTTP cache.
        const request = new Request(url, { cache: 'no-cache' });
        const response = await fetch(request);
        if (response.ok && response.status === 200) await cache.put(request, response);
      } catch {
        // Kept when it is next used instead.
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, one));
}

/** The code earlier versions kept as it was used: fetched again for this version. */
async function earlierCode() {
  const urls = new Set();
  for (const name of await caches.keys()) {
    const old = (name.startsWith('usugami-code-') && name !== CODE_CACHE) || name === RUNTIME_CACHE;
    if (!old) continue;
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      if (request.method === 'GET' && !isData(request.url) && !new URL(request.url).search) urls.add(request.url);
    }
  }
  return [...urls];
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // One by one: a file missing from the site doesn't stop the others being kept. 'no-cache'
    // checks each with the server, so a file the page has just loaded isn't downloaded again.
    await keepAll(shell, SHELL.map((path) => new URL(path, scope()).href));
    // The tools used before still open offline after an update, in this version.
    const shellUrls = new Set((await shell.keys()).map((r) => r.url));
    await keepAll(await caches.open(CODE_CACHE), (await earlierCode()).filter((url) => !shellUrls.has(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Older versions' shells and code go; fonts and language data stay.
    for (const name of await caches.keys()) {
      if ((name.startsWith('usugami-shell-') && name !== SHELL_CACHE) || (name.startsWith('usugami-code-') && name !== CODE_CACHE)) await caches.delete(name);
    }
    // Code kept by the versions before code had a cache of its own goes too.
    const runtime = await caches.open(RUNTIME_CACHE);
    for (const request of await runtime.keys()) {
      if (!isData(request.url)) await runtime.delete(request);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === 'POST' && url.pathname === new URL('share-target', scope()).pathname) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET' || request.headers.has('range')) return;
  event.respondWith(networkFirst(request, event));
});

/**
 * Whether to keep the answer to `request`: a whole, good answer from this site. An address of the
 * app with a query (?share=<id>) isn't kept: the shell answers for it offline.
 */
function keepable(request, response) {
  if (!response.ok || response.status !== 200 || response.type !== 'basic') return false;
  return !(request.mode === 'navigate' && new URL(request.url).search);
}

/**
 * The network's answer (kept for later), or the copy kept when the network can't be reached or the
 * server fails. Keeping it is part of the fetch event's work, so the worker isn't stopped while a
 * large file (a text language's data) is still being written to the cache.
 */
async function networkFirst(request, event) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const kept = await fromCache(request);
    if (kept) return kept;
    throw error;
  }
  if (response.status >= 500) {
    const kept = await fromCache(request);
    if (kept) return kept;
  }
  if (keepable(request, response)) {
    const copy = response.clone();
    const name = isData(request.url) ? RUNTIME_CACHE : CODE_CACHE;
    const keeping = caches.open(name).then((cache) => cache.put(request, copy)).catch(() => {});
    try {
      event.waitUntil(keeping);
    } catch {
      // The event is over already: the copy is still written, only without holding the worker.
    }
  }
  return response;
}

/** Whether a navigation to `url` is the app's own page (its folder, index.html, any query). */
function isAppPage(url) {
  const base = new URL(scope());
  const u = new URL(url);
  if (!u.pathname.startsWith(base.pathname)) return false;
  const rest = u.pathname.slice(base.pathname.length);
  return rest === '' || rest === 'index.html';
}

async function fromCache(request) {
  const navigation = request.mode === 'navigate';
  // Only the app's page is answered with the shell: its files are relative to it, so served at
  // another address (app/tool/split, say) it would load nothing.
  if (navigation && !isAppPage(request.url)) return null;
  // Any copy kept will do offline, whatever headers it was asked for with. The shell first: it is
  // always this version's.
  const options = { ignoreSearch: navigation, ignoreVary: true };
  const names = [SHELL_CACHE, CODE_CACHE, RUNTIME_CACHE];
  for (const name of names) {
    const cache = await caches.open(name);
    const hit = await cache.match(request, options);
    if (hit) return hit;
  }
  if (navigation) {
    // ./ and index.html are the same page.
    for (const name of names) {
      const cache = await caches.open(name);
      const hit = (await cache.match(new URL('./', scope()).href)) ?? (await cache.match(new URL('index.html', scope()).href));
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Files shared to the installed app: kept in the share cache, then the app is opened with
 * ?share=<id>, and it takes them (and deletes them) at once.
 */
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function');
    if (!files.length) return Response.redirect(scope(), 303);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const cache = await caches.open(SHARE_CACHE);
    const index = { files: [], unreadable: 0 };
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        await cache.put(new URL(`share/${id}/${i}`, scope()).href, new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }));
        index.files.push({ i, name: file.name || '', type: file.type || '', lastModified: file.lastModified || Date.now() });
      } catch {
        // No room to keep it: the app says it couldn't be read.
        index.unreadable++;
      }
    }
    await cache.put(new URL(`share/${id}/index`, scope()).href, new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect(new URL(`./?share=${id}`, scope()).href, 303);
  } catch {
    return Response.redirect(scope(), 303);
  }
}
