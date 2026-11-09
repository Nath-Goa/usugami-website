// Shared helpers for the browser tests. Each test file is a plain Node script:
//
//   import { withPage, runInPage, assert, fixture } from './harness.mjs';
//   await withPage(async (page, url) => { await page.goto(url + 'app/'); ... });
//
// Run one with `node tests/<name>.test.mjs`, or all of them with `npm test`.
// A test fails by throwing (the script then exits with code 1).
//
// withPage(fn, options) options:
//   browser        'chromium' (default) | 'firefox' | 'webkit'
//   prefix         the sub-folder the site is served under (default 'usugami-website')
//   viewport       default a phone, { width: 412, height: 915 }
//   mobile         touch and mobile viewport (default: viewport narrower than 700 px; not in Firefox)
//   serviceWorkers 'block' (default) | 'allow'
//   allowExternal  true lets requests to other hosts through (default false: they fail the test)
//   allowConsole   [RegExp, ...]: console errors whose text matches any of them don't fail the
//                  test, e.g. allowConsole: [/XML Parsing Error/] for Firefox, which logs every
//                  DOMParser syntax error as a console error (its text starts with
//                  '[JavaScript Error: "XML Parsing Error: ', so don't anchor the pattern with ^).
//                  Page errors and other console errors still fail it.
//   ignoreProblems true: nothing above fails the test (the test checks for itself)
//
// runInPage(page, baseUrl, modulePath, exportName, ...args) calls a module's function inside the
// page. Uint8Arrays (and Node Buffers), the other typed arrays, DataViews and ArrayBuffers are
// passed both ways at any depth (in arrays, plain objects, Maps and Sets), keeping their type:
// an engine input { name, bytes } arrives with bytes a Uint8Array, and an OutputFile's bytes come
// back as one. A plain object { __b64: '<base64>' } still arrives as a Uint8Array.
import { chromium, firefox, webkit } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/serve.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const fixturesDir = join(root, 'tests', 'fixtures');
export const outputDir = join(root, 'tests', 'output');

const browsers = { chromium, firefox, webkit };

/**
 * Starts the site on a free port (under a sub-folder by default, as on GitHub Pages, so a link
 * that only works at the root fails), opens a page, runs fn(page, baseUrl, context), and cleans up.
 * Fails on page errors, console errors (except those matching opts.allowConsole) and requests to
 * other hosts. The options are listed at the top of this file.
 * @param {(page: import('playwright').Page, baseUrl: string, context: import('playwright').BrowserContext) => Promise<void>} fn
 * @param {{ browser?: 'chromium' | 'firefox' | 'webkit', prefix?: string, viewport?: { width: number, height: number },
 *   mobile?: boolean, serviceWorkers?: 'block' | 'allow', allowExternal?: boolean, allowConsole?: RegExp[],
 *   ignoreProblems?: boolean }} [opts]
 */
export async function withPage(fn, opts = {}) {
  const {
    browser: name = 'chromium',
    prefix = 'usugami-website',
    viewport = { width: 412, height: 915 },
    mobile = viewport.width < 700,
    allowExternal = false,
    allowConsole = [],
  } = opts;
  const server = await startServer({ prefix });
  const browser = await browsers[name].launch();
  const context = await browser.newContext({
    viewport,
    ...(name === 'firefox' ? {} : { isMobile: mobile, hasTouch: mobile }),
    acceptDownloads: true,
    serviceWorkers: opts.serviceWorkers ?? 'block',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Where it came from: for "Failed to load resource", the file that failed.
    const at = m.location()?.url;
    if (!allowConsole.some((re) => re.test(text))) problems.push(`console error: ${text}${at ? ` (${at})` : ''}`);
  });
  const origin = new URL(server.url).origin;
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (allowExternal || u.startsWith(origin) || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
    problems.push(`external request blocked: ${u}`);
    return route.abort();
  });
  try {
    await fn(page, server.url, context);
    if (problems.length && !opts.ignoreProblems) throw new Error('Problems while testing:\n' + problems.join('\n'));
  } finally {
    await browser.close();
    await server.close();
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
}

export const fixture = (name) => readFile(join(fixturesDir, name));

export async function saveOutput(name, bytes) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, name), bytes);
  return join(outputDir, name);
}

const isPlain = (v) => {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Binary values as { __b64, __type } (no __type: a Uint8Array), Maps as { __map: [[k, v]...] } and
 * Sets as { __set: [...] }, at any depth. Playwright's own passing of typed arrays is slow, and it
 * passes Maps and Sets into the page as empty objects, so they go as plain data.
 */
function encodeArg(v) {
  // The built-in type's name, also for subclasses such as Buffer (which arrives as a Uint8Array).
  const kind = Object.prototype.toString.call(v).slice(8, -1);
  if (kind === 'ArrayBuffer') return { __b64: Buffer.from(v).toString('base64'), __type: kind };
  if (ArrayBuffer.isView(v)) {
    const b64 = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
    return kind === 'Uint8Array' ? { __b64: b64 } : { __b64: b64, __type: kind };
  }
  if (Array.isArray(v)) return v.map(encodeArg);
  // Playwright passes Maps and Sets into the page as empty objects.
  if (v instanceof Map) return { __map: [...v].map(([k, x]) => [encodeArg(k), encodeArg(x)]) };
  if (v instanceof Set) return { __set: [...v].map(encodeArg) };
  if (isPlain(v) && !('__b64' in v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeArg(x)]));
  return v;
}

/** The other way: { __b64, __type }, { __map } and { __set } back to what they stand for, at any depth. */
function decodeResult(v) {
  if (Array.isArray(v)) return v.map(decodeResult);
  if (!isPlain(v)) return v;
  if (Array.isArray(v.__map)) return new Map(v.__map.map(([k, x]) => [decodeResult(k), decodeResult(x)]));
  if (Array.isArray(v.__set)) return new Set(v.__set.map(decodeResult));
  if (typeof v.__b64 === 'string') {
    // A fresh buffer, so every element type is aligned.
    const bytes = new Uint8Array(Buffer.from(v.__b64, 'base64'));
    if (!v.__type) return bytes;
    if (v.__type === 'ArrayBuffer') return bytes.buffer;
    if (v.__type === 'DataView') return new DataView(bytes.buffer);
    const Type = globalThis[v.__type];
    if (typeof Type !== 'function' || !Number.isInteger(Type.BYTES_PER_ELEMENT)) throw new Error(`runInPage: unknown binary type ${v.__type}`);
    return new Type(bytes.buffer);
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeResult(x)]));
}

/**
 * Runs an ES module function inside the page (the app's own modules, loaded by URL relative to
 * the site root), e.g. await runInPage(page, url, 'app/js/engine/organize.js', 'splitPdf', input, opts).
 * Binary values (Uint8Array, Buffer, other typed arrays, DataView, ArrayBuffer) are passed both
 * ways at any depth inside arrays, plain objects, Maps and Sets, keeping their types.
 * @param {import('playwright').Page} page
 * @param {string} baseUrl
 * @param {string} modulePath
 * @param {string} exportName
 * @param {...any} args
 */
export async function runInPage(page, baseUrl, modulePath, exportName, ...args) {
  const result = await page.evaluate(async ({ src, name, args }) => {
    const isPlain = (v) => {
      if (!v || typeof v !== 'object') return false;
      const proto = Object.getPrototypeOf(v);
      return proto === Object.prototype || proto === null;
    };
    const fromBase64 = (s) => {
      if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
      const text = atob(s);
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      return bytes;
    };
    const toBase64 = (bytes) => {
      if (bytes.toBase64) return bytes.toBase64();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const dec = (v) => {
      if (Array.isArray(v)) return v.map(dec);
      if (!isPlain(v)) return v;
      if (Array.isArray(v.__map)) return new Map(v.__map.map(([k, x]) => [dec(k), dec(x)]));
      if (Array.isArray(v.__set)) return new Set(v.__set.map(dec));
      if (typeof v.__b64 === 'string') {
        const bytes = fromBase64(v.__b64);
        if (!v.__type) return bytes;
        if (v.__type === 'ArrayBuffer') return bytes.buffer;
        if (v.__type === 'DataView') return new DataView(bytes.buffer);
        return new globalThis[v.__type](bytes.buffer);
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
    };
    const enc = (v) => {
      const kind = Object.prototype.toString.call(v).slice(8, -1);
      if (kind === 'ArrayBuffer') return { __b64: toBase64(new Uint8Array(v)), __type: kind };
      if (ArrayBuffer.isView(v)) {
        const b64 = toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        return kind === 'Uint8Array' ? { __b64: b64 } : { __b64: b64, __type: kind };
      }
      if (Array.isArray(v)) return v.map(enc);
      if (v instanceof Map) return { __map: [...v].map(([k, x]) => [enc(k), enc(x)]) };
      if (v instanceof Set) return { __set: [...v].map(enc) };
      if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
      return v;
    };
    const mod = await import(src);
    return enc(await mod[name](...dec(args)));
  }, { src: new URL(modulePath, baseUrl).href, name: exportName, args: args.map(encodeArg) });
  return decodeResult(result);
}
