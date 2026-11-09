// A small static file server for previewing the site on your computer, with no dependencies.
//
//   node tools/serve.mjs                         http://localhost:8080/
//   node tools/serve.mjs --prefix usugami-website   http://localhost:8080/usugami-website/
//                                                (a sub-folder, as on GitHub Pages before the domain is linked)
//   node tools/serve.mjs --port 3000 --host 0.0.0.0  (reachable from a phone on the same Wi-Fi)
//
// Tests import startServer() to get a server on a free port.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.gz': 'application/gzip',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
};

/**
 * Serves `root` (default: site/) under `prefix` (default: none, so the site is at /).
 * Resolves to { server, url, port, close() }; port 0 picks a free port. Rejects when the server
 * can't listen (for example EADDRINUSE: the port is taken).
 */
export function startServer({ root, port = 0, host = '127.0.0.1', prefix = '' } = {}) {
  const base = resolve(root ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'site'));
  const pre = prefix ? '/' + prefix.replace(/^\/+|\/+$/g, '') : '';
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (pre) {
        if (path === pre) { res.writeHead(301, { Location: pre + '/' }); return res.end(); }
        if (!path.startsWith(pre + '/')) return notFound(res, base);
        path = path.slice(pre.length);
      }
      let file = resolve(join(base, path));
      if (file !== base && !file.startsWith(base + sep)) return notFound(res, base);
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        if (!path.endsWith('/')) {
          res.writeHead(301, { Location: pre + path + '/' });
          return res.end();
        }
        file = join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) return notFound(res, base);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      const { port: p } = server.address();
      const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${p}${pre}/`;
      ok({ server, url, port: p, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

async function notFound(res, base) {
  // Like GitHub Pages: the site's own 404.html, if there is one.
  const page = join(base, '404.html');
  const info = await stat(page).catch(() => null);
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  if (info?.isFile()) createReadStream(page).pipe(res);
  else res.end('Not found');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const host = opt('host', '127.0.0.1');
  const wanted = Number(opt('port', 8080));
  const { url } = await startServer({
    root: opt('root', undefined),
    port: wanted,
    host,
    prefix: opt('prefix', ''),
  }).catch((e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`Port ${wanted} is in use (another preview server?). Stop it, or pick another port: node tools/serve.mjs --port ${wanted + 1}`);
    process.exit(1);
  });
  console.log(`Usugami website: ${url}`);
  if (host === '0.0.0.0') {
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`On your phone (same Wi-Fi): ${url.replace('localhost', a.address)}`);
      }
    }
  }
  console.log('Press Ctrl+C to stop.');
}
