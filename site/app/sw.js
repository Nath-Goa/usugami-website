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

// The deploy workflow replaces 'dev' with the commit being published.
const VERSION = 'dev';

const SHELL_CACHE = `usugami-shell-${VERSION}`;
const RUNTIME_CACHE = 'usugami-runtime';
const SHARE_CACHE = 'usugami-share';

// Relative to this file (site/app/): what the app needs to start and show its own screens (every
// module main.js and the shell's screens import, which tests/shell.test.mjs checks), and the kit.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  '../assets/css/tokens.css',
  'css/app.css',
  'css/components.css',
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
  'js/core/batch.js',
  // What core/files.js reads image files with (it tells images by their content).
  'js/engine/images/image-type.js',
  'js/engine/images/decode.js',
  'js/engine/images/image-meta.js',
  'js/engine/images/image-transform.js',
  'js/engine/images/heif-decode.js',
  'js/engine/images/image-canvas.js',
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
  'locales/en/common.js',
  'locales/en/kit.js',
  // Loaded at start with the kit's strings; kept when it is first used if the site doesn't have it yet.
  'locales/en/mark.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

const scope = () => self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One by one: a file missing from the site doesn't stop the others being kept.
    await Promise.all(SHELL.map(async (path) => {
      try {
        const request = new Request(new URL(path, scope()), { cache: 'reload' });
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response);
      } catch {
        // Kept when it is first used instead.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // The shells of older versions go; files kept as they were used stay for offline use.
    for (const name of await caches.keys()) {
      if (name.startsWith('usugami-shell-') && name !== SHELL_CACHE) await caches.delete(name);
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
    const keeping = caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    try {
      event.waitUntil(keeping);
    } catch {
      // The event is over already: the copy is still written, only without holding the worker.
    }
  }
  return response;
}

async function fromCache(request) {
  const navigation = request.mode === 'navigate';
  // Any copy kept will do offline, whatever headers it was asked for with.
  const options = { ignoreSearch: navigation, ignoreVary: true };
  for (const name of [RUNTIME_CACHE, SHELL_CACHE]) {
    const cache = await caches.open(name);
    const hit = await cache.match(request, options);
    if (hit) return hit;
  }
  if (navigation) {
    // The app is one page: its shell answers for any of its addresses.
    for (const name of [RUNTIME_CACHE, SHELL_CACHE]) {
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
