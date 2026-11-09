// Copies the libraries the web app uses from node_modules into site/app/vendor/, so the site
// serves every file itself (no CDN). Run it after changing a version in package.json:
//   npm install && npm run vendor
// The output is committed, so deploying needs no build step.
//
// To see what a change to this script does before replacing site/app/vendor, write elsewhere:
//   node tools/vendor.mjs --out .tmp/vendor-check
// The output folder is deleted and made again, so --out refuses a folder that has files but no
// VERSIONS.json (anything that isn't an earlier output).
import { cp, mkdir, rm, readdir, writeFile, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const licensesDir = join(root, 'licenses');
const out = outputFolder(process.argv.slice(2));
const require = createRequire(import.meta.url);
const version = (pkg) => require(join(nm, pkg, 'package.json')).version;

/** The folder to write: site/app/vendor, or --out <dir> (relative to the current folder). */
function outputFolder(args) {
  let dir = join(root, 'site', 'app', 'vendor');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) dir = resolve(args[++i]);
    else if (args[i].startsWith('--out=') && args[i].length > 6) dir = resolve(args[i].slice(6));
    else {
      console.error(`Unknown argument: ${args[i]}\nUsage: node tools/vendor.mjs [--out <dir>]`);
      process.exit(2);
    }
  }
  return dir;
}

async function copy(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

// Packages that ship no license file, with the text kept in licenses/ for them.
const LICENSE_FALLBACKS = { dfa: 'dfa.txt', brotli: 'brotli.js.txt' };
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/** A package's license text: its own LICENSE file, else the one in licenses/. */
async function licenseText(pkgDir, name) {
  const own = (await readdir(pkgDir)).filter((f) => LICENSE_FILE.test(f)).sort();
  if (own.length) return readFile(join(pkgDir, own[0]), 'utf8');
  if (LICENSE_FALLBACKS[name]) return readFile(join(licensesDir, LICENSE_FALLBACKS[name]), 'utf8');
  throw new Error(`${name} ships no license file: put its text in licenses/ and name it in LICENSE_FALLBACKS (tools/vendor.mjs).`);
}

/** The npm packages esbuild put into a bundle (from its metafile), as name -> package folder. */
function bundledPackages(metafile) {
  const found = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    // The innermost node_modules/<name> (or node_modules/@scope/<name>) holds the file.
    const m = input.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    if (m) found.set(m[2], join(root, m[1]));
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

/** Writes the licenses of everything in a bundle into one text file next to it. */
async function writeBundleLicenses(file, bundle, packages, extras) {
  const rule = '='.repeat(72);
  const list = [];
  const sections = [];
  for (const [name, dir] of packages) {
    const { version: v, license } = require(join(dir, 'package.json'));
    list.push(`  ${name} ${v} (${license})`);
    let text = `${rule}\n${name} ${v}\n${rule}\n\n${(await licenseText(dir, name)).trim()}\n`;
    for (const extra of extras[name] ?? []) {
      text += `\n------------------------------------------------------------------------\n` +
        `Also in ${name}: licenses/${extra}\n\n${(await readFile(join(licensesDir, extra), 'utf8')).trim()}\n`;
    }
    sections.push(text);
  }
  const head = `Licenses of the code in ${bundle}, which tools/vendor.mjs bundles with esbuild from\n` +
    `these npm packages (the list comes from esbuild's metafile):\n\n${list.join('\n')}\n`;
  await writeFile(file, [head, ...sections].join('\n'));
}

/** Copies the license files a prebuilt bundle points at ("For license information please see X"). */
async function copyReferencedLicenses(file, fromDir) {
  const text = await readFile(file, 'utf8');
  for (const [, name] of text.matchAll(/For license information please see (\S+?\.LICENSE\.txt)/g)) {
    await copy(join(fromDir, name), join(dirname(file), name));
  }
}

/**
 * Takes settings out of the config part of a Tesseract .traineddata file, with the comment
 * lines just above each. The file (tesseract's ccutil/tessdatamanager.cpp, little-endian) is an
 * int32 entry count, an int64 offset per entry (-1 when absent), then the entries' bytes one
 * after another in index order, each running to the next present entry (the last to the end).
 * Entry 0 is the config: lines of "name value", '#' comments. Returns null when nothing changes.
 * @param {Buffer} data
 * @param {string[]} names
 */
function dropSettings(data, names) {
  const parse = (b) => {
    const n = b.readInt32LE(0);
    if (n < 1 || n > 1000 || 4 + 8 * n > b.length) throw new Error(`not a .traineddata file (${n} entries)`);
    const offsets = Array.from({ length: n }, (_, i) => Number(b.readBigInt64LE(4 + 8 * i)));
    const present = offsets.map((o, i) => [o, i]).filter(([o]) => o >= 0);
    let previous = 4 + 8 * n;
    for (const [o] of present) {
      if (o < previous || o > b.length) throw new Error('.traineddata offsets out of order');
      previous = o;
    }
    const entries = offsets.map(() => null);
    present.forEach(([o, i], k) => { entries[i] = b.subarray(o, k + 1 < present.length ? present[k + 1][0] : b.length); });
    return { offsets, entries };
  };
  const { offsets, entries } = parse(data);
  if (!entries[0]) return null;
  const lines = entries[0].toString('utf8').split('\n');
  const keep = [];
  for (const line of lines) {
    if (names.includes(line.trim().split(/\s+/)[0])) {
      while (keep.length && keep.at(-1).trimStart().startsWith('#')) keep.pop();
    } else {
      keep.push(line);
    }
  }
  if (keep.length === lines.length) return null;
  const config = Buffer.from(keep.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  const shift = entries[0].length - config.length;
  const result = Buffer.concat([data.subarray(0, offsets[0]), config, data.subarray(offsets[0] + entries[0].length)]);
  offsets.forEach((o, i) => { if (i > 0 && o >= 0) result.writeBigInt64LE(BigInt(o - shift), 4 + 8 * i); });
  // Every other entry must read back unchanged.
  const check = parse(result);
  if (check.entries.some((e, i) => i > 0 && (e === null) !== (entries[i] === null))) throw new Error('entries lost');
  if (check.entries.some((e, i) => i > 0 && e && !e.equals(entries[i]))) throw new Error('entries changed');
  return result;
}

/**
 * Settings that language data names but this engine (tesseract.js-core's LSTM-only build) doesn't
 * have: a worker prints "Warning: Parameter not found: <name>" for each as a console error.
 */
const UNKNOWN_SETTINGS = ['classify_misfit_junk_penalty', 'merge_fragments_in_matrix'];

// Empty the output folder, but never one that isn't an earlier output (a mistyped --out).
if (existsSync(out)) {
  const entries = await readdir(out);
  if (entries.length && !entries.includes('VERSIONS.json')) {
    console.error(`${out} has files but no VERSIONS.json, so it isn't vendor output: not deleting it.`);
    process.exit(1);
  }
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const versions = {};

// pdf-lib (Cantoo's maintained fork: decrypts password-protected PDFs, fflate compression).
versions['@cantoo/pdf-lib'] = version('@cantoo/pdf-lib');
await copy(join(nm, '@cantoo/pdf-lib/dist/pdf-lib.esm.min.js'), join(out, 'pdf-lib/pdf-lib.esm.min.js'));
await copy(join(nm, '@cantoo/pdf-lib/LICENSE.md'), join(out, 'pdf-lib/LICENSE.md')).catch(() =>
  copy(join(nm, '@cantoo/pdf-lib/LICENSE'), join(out, 'pdf-lib/LICENSE')));

// fontkit: its browser build imports other packages, so bundle it into one ES module, with the
// licenses of everything that went into it in a file next to it.
versions['@cantoo/fontkit'] = version('@cantoo/fontkit');
const fontkitLicenses = 'fontkit.esm.min.js.LICENSE.txt';
const fontkit = await build({
  entryPoints: [join(nm, '@cantoo/fontkit/dist/browser-module.mjs')],
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  legalComments: 'eof',
  banner: { js: `/*! For license information please see ${fontkitLicenses} */` },
  metafile: true,
  outfile: join(out, 'fontkit/fontkit.esm.min.js'),
  logLevel: 'warning',
});
await writeBundleLicenses(join(out, 'fontkit', fontkitLicenses), 'fontkit.esm.min.js', bundledPackages(fontkit.metafile), {
  // Parts that come with a package's own code rather than as packages of their own.
  '@cantoo/fontkit': ['unicode-trie-and-unicode-properties.txt', 'Unicode-3.0.txt'],
  brotli: ['Apache-2.0.txt'],
});
await copy(join(nm, '@cantoo/fontkit/LICENSE'), join(out, 'fontkit/LICENSE'));

// fflate: ZIP reading and writing (Office and EPUB files are ZIPs; "Share or save as ZIP").
versions.fflate = version('fflate');
await copy(join(nm, 'fflate/esm/browser.js'), join(out, 'fflate/fflate.esm.js'));
await copy(join(nm, 'fflate/LICENSE'), join(out, 'fflate/LICENSE'));

// pdf.js: page previews, text positions (Redact PDF's Find text), rendering pages to images.
versions['pdfjs-dist'] = version('pdfjs-dist');
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  await copy(join(nm, 'pdfjs-dist/build', f), join(out, 'pdfjs', f));
}
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await copy(join(nm, 'pdfjs-dist', d), join(out, 'pdfjs', d));
}
await copy(join(nm, 'pdfjs-dist/LICENSE'), join(out, 'pdfjs/LICENSE'));
// pdfjs-dist ships no license for its QuickJS build; pdf.js added these texts later (commit
// a3beacc), under these names. Use the copies in licenses/ until a release includes them. (Like
// every bare LICENSE file, they are served with .txt added: see addTxtToLicenses below.)
if (existsSync(join(out, 'pdfjs/wasm/quickjs-eval.wasm'))) {
  for (const [name, text] of [['LICENSE_QUICKJS', 'QuickJS.txt'], ['LICENSE_PDFJS_QUICKJS', 'pdf.js.quickjs.txt']]) {
    const there = [name, name + '.txt'].some((n) => existsSync(join(out, 'pdfjs/wasm', n)));
    if (!there) await copy(join(licensesDir, text), join(out, 'pdfjs/wasm', name));
  }
}

// Tesseract: text recognition (OCR), loaded only when "Make text searchable" is on.
versions['tesseract.js'] = version('tesseract.js');
versions['tesseract.js-core'] = version('tesseract.js-core');
for (const f of ['tesseract.esm.min.js', 'worker.min.js']) {
  await copy(join(nm, 'tesseract.js/dist', f), join(out, 'tesseract', f));
  await copyReferencedLicenses(join(out, 'tesseract', f), join(nm, 'tesseract.js/dist'));
}
await copy(join(nm, 'tesseract.js/LICENSE.md'), join(out, 'tesseract/LICENSE.md')).catch(() =>
  copy(join(nm, 'tesseract.js/LICENSE'), join(out, 'tesseract/LICENSE')));
for (const f of await readdir(join(nm, 'tesseract.js-core'))) {
  // LSTM-only engines (the app's OCR is LSTM-only too); the worker picks the variant the browser supports.
  if (/^tesseract-core(-simd|-relaxedsimd)?-lstm\.wasm\.js$/.test(f)) {
    await copy(join(nm, 'tesseract.js-core', f), join(out, 'tesseract/core', f));
  }
}
await copy(join(nm, 'tesseract.js-core/LICENSE'), join(out, 'tesseract/core/LICENSE'));
for (const lang of ['eng', 'fra', 'spa', 'hin']) {
  const pkg = `@tesseract.js-data/${lang}`;
  versions[pkg] = version(pkg);
  const from = join(nm, pkg, '4.0.0_best_int', `${lang}.traineddata.gz`);
  const to = join(out, 'tesseract/lang', `${lang}.traineddata.gz`);
  const changed = dropSettings(gunzipSync(await readFile(from)), UNKNOWN_SETTINGS);
  if (changed) {
    const gz = gzipSync(changed, { level: 9 });
    gz[9] = 255; // gzip's "operating system" byte: unknown, the same on every system
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, gz);
    console.log(`${lang}.traineddata: removed ${UNKNOWN_SETTINGS.join(', ')} from its config`);
  } else {
    await copy(from, to);
  }
}

// libheif: HEIC photos, for browsers that can't decode them (Chrome, Firefox). Loaded only for HEIC.
versions['libheif-js'] = version('libheif-js');
await copy(join(nm, 'libheif-js/libheif-wasm/libheif-bundle.mjs'), join(out, 'libheif/libheif-bundle.mjs'));
await copy(join(nm, 'libheif-js/LICENSE'), join(out, 'libheif/LICENSE'));

// Material icons: tools/build-icons.mjs copies the ones the app draws into js/core/icons.js. Their
// license (Apache-2.0) is served from here, so the site carries a copy of it.
await copy(join(nm, '@material-design-icons/svg/LICENSE'), join(out, 'material-icons/LICENSE'));

// License texts without an extension (LICENSE, LICENSE_FOXIT...) get .txt: GitHub Pages serves
// extensionless files as application/octet-stream, so browsers would download them instead of
// showing them (the app's Open-source licenses screen links to them).
const BARE_LICENSE = /^(?:licen[cs]e|copying)(?:[_-][\w-]*)?$/i;
async function addTxtToLicenses(dir) {
  let renamed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) renamed += await addTxtToLicenses(path);
    else if (BARE_LICENSE.test(entry.name)) {
      if (existsSync(path + '.txt')) throw new Error(`${path}.txt exists already`);
      await rename(path, path + '.txt');
      renamed++;
    }
  }
  return renamed;
}
if (!await addTxtToLicenses(out)) throw new Error('no license files found to serve as .txt');

// Source maps aren't shipped, so drop the comments pointing at them (browsers would ask for them).
async function stripSourceMaps(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await stripSourceMaps(path);
    else if (/\.(m?js)$/.test(entry.name) && !entry.name.endsWith('.wasm.js')) {
      const text = await readFile(path, 'utf8');
      const cleaned = text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
      if (cleaned !== text) await writeFile(path, cleaned);
    }
  }
}
await stripSourceMaps(out);

await writeFile(join(out, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
console.log(`Vendored into ${relative(root, out) || '.'}:`, versions);
