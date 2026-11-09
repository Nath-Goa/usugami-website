// The vendored libraries (site/app/vendor, made by tools/vendor.mjs): that they are what
// npm run vendor makes from node_modules, that every license file they point at is there, and the
// change made to Tesseract's Hindi data. Node only, no browser.
//
//   node tests/vendor.test.mjs
import { readFile, readdir, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { assert, root } from './harness.mjs';

const started = Date.now();
let count = 0;
async function test(name, fn) {
  const t = Date.now();
  await fn();
  count++;
  console.log(`ok - ${name} (${Date.now() - t} ms)`);
}

const vendor = join(root, 'site/app/vendor');
const nm = join(root, 'node_modules');
const require = createRequire(import.meta.url);
const vendorScript = join(root, 'tools/vendor.mjs');

async function files(dir, base = '') {
  const out = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const p = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await files(dir, p));
    else out.push(p);
  }
  return out.sort();
}

/** A .traineddata file's entries (tesseract's tessdatamanager.cpp format), null where absent. */
function entries(data) {
  const n = data.readInt32LE(0);
  const offsets = Array.from({ length: n }, (_, i) => Number(data.readBigInt64LE(4 + 8 * i)));
  return offsets.map((o, i) => {
    if (o < 0) return null;
    const next = offsets.slice(i + 1).find((x) => x >= 0) ?? data.length;
    return data.subarray(o, next);
  });
}
const traineddata = async (path) => gunzipSync(await readFile(path));

await test('every license file a vendored script points at is next to it', async () => {
  let pointers = 0;
  for (const f of await files(vendor)) {
    if (!/\.(m?js)$/.test(f)) continue;
    const text = await readFile(join(vendor, f), 'utf8');
    for (const [, name] of text.matchAll(/For license information please see (\S+?\.LICENSE\.txt)/g)) {
      pointers++;
      assert(existsSync(join(vendor, dirname(f), name)), `${f} points at ${name}, which is missing`);
    }
  }
  // tesseract.esm.min.js, worker.min.js and fontkit.esm.min.js.
  assert(pointers >= 3, `pointers found: ${pointers}`);
  for (const name of ['tesseract.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt']) {
    const shipped = await readFile(join(vendor, 'tesseract', name));
    assert(shipped.equals(await readFile(join(nm, 'tesseract.js/dist', name))), `${name} as tesseract.js publishes it`);
  }
});

await test('fontkit\'s license file covers every package esbuild bundles into it', async () => {
  const result = await build({
    entryPoints: [join(nm, '@cantoo/fontkit/dist/browser-module.mjs')],
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    metafile: true,
    outfile: join(root, '.tmp/fontkit-check.js'),
    logLevel: 'silent',
  });
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const m = input.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    if (m) packages.add(m[1]);
  }
  assert(packages.size >= 5, `bundled packages: ${[...packages]}`);
  const text = await readFile(join(vendor, 'fontkit/fontkit.esm.min.js.LICENSE.txt'), 'utf8');
  for (const dir of packages) {
    const { name, version } = require(join(root, dir, 'package.json'));
    assert(text.includes(`\n${name} ${version}\n`), `${name} ${version} has a section`);
  }
  for (const part of ['Unicode', 'Apache License', 'Copyright (c) 2014-present Devon Govett']) {
    assert(text.includes(part), `includes ${part}`);
  }
  const bundle = await readFile(join(vendor, 'fontkit/fontkit.esm.min.js'), 'utf8');
  assert(bundle.startsWith('/*! For license information please see fontkit.esm.min.js.LICENSE.txt */'), 'the bundle points at it');
});

await test('PDF.js\'s QuickJS build has its licenses next to it', async () => {
  const wasm = await readdir(join(vendor, 'pdfjs/wasm'));
  assert(wasm.includes('quickjs-eval.wasm') && wasm.includes('quickjs-eval.js'), 'QuickJS files');
  for (const [name, text] of [['LICENSE_QUICKJS.txt', 'QuickJS.txt'], ['LICENSE_PDFJS_QUICKJS.txt', 'pdf.js.quickjs.txt']]) {
    const shipped = await readFile(join(vendor, 'pdfjs/wasm', name), 'utf8');
    assert(shipped === await readFile(join(root, 'licenses', text), 'utf8'), `${name} is licenses/${text}`);
  }
});

await test('every license text is served with an extension browsers show (.txt or .md), none bare', async () => {
  // GitHub Pages and tools/serve.mjs serve a file without an extension as
  // application/octet-stream, which browsers download instead of showing.
  const all = await files(vendor);
  const licenses = all.filter((f) => /^(?:licen[cs]e|copying)/i.test(f.split('/').pop()));
  const bare = licenses.filter((f) => !/\.(?:txt|md)$/i.test(f));
  assert(!bare.length, `license files without .txt or .md: ${bare}`);
  // The ones the app's Open-source licenses screen links to (js/screens/licenses.js).
  for (const f of ['pdf-lib/LICENSE.md', 'fontkit/LICENSE.txt', 'fflate/LICENSE.txt', 'pdfjs/LICENSE.txt',
    'tesseract/LICENSE.md', 'tesseract/core/LICENSE.txt', 'libheif/LICENSE.txt', 'material-icons/LICENSE.txt']) {
    assert(all.includes(f), `${f} is there`);
  }
  // Each is the package's own text, unchanged.
  for (const [f, from] of [['fontkit/LICENSE.txt', '@cantoo/fontkit/LICENSE'], ['fflate/LICENSE.txt', 'fflate/LICENSE'],
    ['pdfjs/LICENSE.txt', 'pdfjs-dist/LICENSE'], ['pdfjs/cmaps/LICENSE.txt', 'pdfjs-dist/cmaps/LICENSE'],
    ['tesseract/core/LICENSE.txt', 'tesseract.js-core/LICENSE'], ['libheif/LICENSE.txt', 'libheif-js/LICENSE'],
    ['material-icons/LICENSE.txt', '@material-design-icons/svg/LICENSE']]) {
    assert((await readFile(join(vendor, f))).equals(await readFile(join(nm, from))), `${f} is ${from}`);
  }
});

await test('the language data names no settings the engine lacks, and is otherwise unchanged', async () => {
  const unknown = ['classify_misfit_junk_penalty', 'merge_fragments_in_matrix'];
  for (const lang of ['eng', 'fra', 'spa', 'hin']) {
    const ours = entries(await traineddata(join(vendor, `tesseract/lang/${lang}.traineddata.gz`)));
    const theirs = entries(await traineddata(join(nm, `@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`)));
    assert(ours.length === theirs.length, `${lang}: ${ours.length} entries`);
    for (let i = 1; i < ours.length; i++) {
      assert((ours[i] === null) === (theirs[i] === null), `${lang}: entry ${i} present in both or neither`);
      assert(!ours[i] || ours[i].equals(theirs[i]), `${lang}: entry ${i} unchanged`);
    }
    if (!theirs[0]) {
      assert(!ours[0], `${lang}: no config`);
      continue;
    }
    const before = theirs[0].toString('utf8').split('\n');
    const after = ours[0].toString('utf8').split('\n');
    const settings = (ls) => ls.filter((l) => l.trim() && !l.startsWith('#'));
    const expected = settings(before).filter((l) => !unknown.includes(l.split(/\s+/)[0]));
    assert(JSON.stringify(settings(after)) === JSON.stringify(expected), `${lang}: every other setting kept, in order: ${settings(after)}`);
    // Only whole lines were taken out.
    let k = 0;
    for (const l of before) if (k < after.length && l === after[k]) k++;
    assert(k === after.length, `${lang}: the config is the original with lines removed`);
  }
  const hin = (await traineddata(join(vendor, 'tesseract/lang/hin.traineddata.gz'))).toString('latin1');
  assert(!/classify_misfit_junk_penalty|merge_fragments_in_matrix/.test(hin), 'Hindi data no longer names them');
});

await test('site/app/vendor is what npm run vendor makes from node_modules', async () => {
  const out = await mkdtemp(join(tmpdir(), 'usugami-vendor-'));
  try {
    const r = spawnSync(process.execPath, [vendorScript, '--out', out], { encoding: 'utf8' });
    assert(r.status === 0, `npm run vendor failed: ${r.stderr}`);
    const made = await files(out);
    const committed = await files(vendor);
    assert(JSON.stringify(made) === JSON.stringify(committed),
      `the same files: missing ${made.filter((f) => !committed.includes(f))}, extra ${committed.filter((f) => !made.includes(f))}`);
    for (const f of made) {
      let a = await readFile(join(out, f));
      let b = await readFile(join(vendor, f));
      // gzip's bytes can differ between zlib builds; what they unpack to can't.
      if (f.endsWith('.gz')) [a, b] = [gunzipSync(a), gunzipSync(b)];
      assert(a.equals(b), `${f} is the same (run npm run vendor)`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

await test('vendor.mjs --out refuses to empty a folder that isn\'t vendor output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usugami-not-vendor-'));
  try {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'keep.txt'), 'keep');
    const r = spawnSync(process.execPath, [vendorScript, '--out', dir], { encoding: 'utf8' });
    assert(r.status === 1 && /not deleting it/.test(r.stderr), `refused: ${r.status} ${r.stderr}`);
    assert(existsSync(join(dir, 'sub', 'keep.txt')), 'its files are still there');
    const bad = spawnSync(process.execPath, [vendorScript, '--outt', dir], { encoding: 'utf8' });
    assert(bad.status === 2 && /Unknown argument/.test(bad.stderr), `unknown argument: ${bad.status} ${bad.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log(`${count} tests passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
