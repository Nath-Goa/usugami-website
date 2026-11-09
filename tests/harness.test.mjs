// The test harness itself (tests/harness.mjs): runInPage passing binary values both ways at any
// depth, and withPage's allowConsole, in Chromium, Firefox and WebKit; and the test runner
// (tests/run.mjs: filters, --list, --shard), with Node only.
//
//   node tests/harness.test.mjs            all three browsers
//   node tests/harness.test.mjs chromium   one
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withPage, runInPage, assert, root } from './harness.mjs';
import { shard } from './run.mjs';

const started = Date.now();
let count = 0;
async function test(name, fn) {
  const t = Date.now();
  await fn();
  count++;
  console.log(`ok - ${name} (${Date.now() - t} ms)`);
}

// A module for the page, as a data: URL (runInPage resolves it against the site like any path).
const module = (code) => 'data:text/javascript,' + encodeURIComponent(code);
const PROBE = module(`
  // What arrived: each value's type and contents, as plain JSON-safe data.
  const describe = (v) => {
    if (v instanceof ArrayBuffer) return { type: 'ArrayBuffer', bytes: [...new Uint8Array(v)] };
    if (v instanceof DataView) return { type: 'DataView', bytes: [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)] };
    if (ArrayBuffer.isView(v)) return { type: v.constructor.name, values: [...v].map(String) };
    if (Array.isArray(v)) return { type: 'Array', items: v.map(describe) };
    if (v instanceof Map) return { type: 'Map', entries: [...v].map(([k, x]) => [describe(k), describe(x)]) };
    if (v instanceof Set) return { type: 'Set', items: [...v].map(describe) };
    if (v instanceof Date) return { type: 'Date', time: v.getTime() };
    if (v && typeof v === 'object') return { type: 'Object', fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, describe(x)])) };
    return { type: typeof v, value: v === undefined ? 'undefined' : v };
  };
  export const probe = (...args) => args.map(describe);
  export const echo = (...args) => args;
  export const sum = ({ bytes }) => bytes.reduce((a, b) => a + b, 0);
  // An engine result: OutputFiles and other facts, made in the page.
  export function outputs(n) {
    const files = [];
    for (let i = 0; i < n; i++) files.push({ name: 'part ' + (i + 1) + '.pdf', bytes: new Uint8Array([37, 80, 68, 70, i]), type: 'application/pdf' });
    return {
      files,
      pixels: new Uint8ClampedArray([0, 128, 255, 300]),
      widths: new Float32Array([0.5, 1.25]),
      offsets: new BigInt64Array([1n, -2n]),
      buffer: new Uint8Array([9, 8, 7]).buffer,
      view: new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2),
      window: new Uint8Array([0, 1, 2, 3, 4, 5]).subarray(2, 4),
      subclass: new (class Bytes extends Uint8Array {})([6, 6]),
      byPage: new Map([[1, new Uint16Array([65535])]]),
      seen: new Set([new Int8Array([-1])]),
      when: new Date(86400000),
      nothing: null,
      text: 'done',
    };
  }
  export function big(size) {
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = (i * 31) & 255;
    return b;
  }
  export function fail() { throw new Error('engine failed on purpose'); }
`);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const values = (v) => [...v].map(String);

// tests/run.mjs (npm test), with Node only.
const runner = join(root, 'tests', 'run.mjs');
const runTests = (...args) => spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });
const testFiles = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();

await test('npm test: filters that match no file fail, and --list shows what would run', async () => {
  const none = runTests('nosuchname');
  assert(none.status === 1 && none.stderr.includes('No test file matches: nosuchname'), `no match: ${none.status} ${none.stderr}`);
  const partly = runTests('organize', 'nosuchname', '--list');
  assert(partly.status === 1 && partly.stderr.includes('No test file matches: nosuchname'), `one filter matches nothing: ${partly.status}`);
  const listed = runTests('organize', 'compress', '--list');
  assert(listed.status === 0, listed.stderr);
  const names = listed.stdout.trim().split(/\r?\n/);
  assert(names.length >= 3 && names.every((f) => /organize|compress/.test(f) && testFiles.includes(f)), `listed: ${names}`);
  for (const bad of [['--shard', '0/4'], ['--shard', '5/4'], ['--shard=x'], ['--nosuch']]) {
    const r = runTests(...bad, '--list');
    assert(r.status === 2 && /Usage:/.test(r.stderr), `${bad.join(' ')}: ${r.status} ${r.stderr}`);
  }
});

await test('npm test -- --shard i/n: each test file in exactly one part, the same parts every time', async () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const parts = Array.from({ length: n }, (_, i) => shard(testFiles, i + 1, n));
    const all = parts.flat();
    assert(all.length === testFiles.length && new Set(all).size === testFiles.length, `${n} parts cover every file once`);
    assert(parts.every((p) => p.length && same(p, [...p].sort())), `${n} parts: none empty, each in name order`);
    assert(same(parts, Array.from({ length: n }, (_, i) => shard(testFiles, i + 1, n))), `${n} parts: the same every time`);
  }
  const fromCli = [1, 2, 3, 4].map((i) => runTests('--shard', `${i}/4`, '--list').stdout.trim().split(/\r?\n/).slice(1));
  assert(same(fromCli, [1, 2, 3, 4].map((i) => shard(testFiles, i, 4))), 'the command line gives the same parts');
});

const only = process.argv[2];
for (const browser of ['chromium', 'firefox', 'webkit'].filter((b) => !only || b === only)) {
  await withPage(async (page, url) => {
    // A page without the app's Content-Security-Policy, so the data: module may load.
    await page.goto(url + 'app/fonts/OFL.txt');
    const run = (name, ...args) => runInPage(page, url, PROBE, name, ...args);

    await test(`${browser}: a Uint8Array or Buffer argument arrives as a Uint8Array, as before`, async () => {
      const [a, b] = await run('probe', new Uint8Array([1, 2, 255]), Buffer.from([4, 5]));
      assert(a.type === 'Uint8Array' && same(a.values, ['1', '2', '255']), JSON.stringify(a));
      assert(b.type === 'Uint8Array' && same(b.values, ['4', '5']), JSON.stringify(b));
      const back = await run('echo', new Uint8Array([7, 0, 7]));
      assert(back[0] instanceof Uint8Array && same(values(back[0]), ['7', '0', '7']), 'Uint8Array back');
    });

    await test(`${browser}: an engine input { name, bytes } arrives with bytes a Uint8Array`, async () => {
      const [d] = await run('probe', { name: 'a.pdf', bytes: new Uint8Array([10, 20]), password: 'x' });
      assert(d.type === 'Object' && d.fields.bytes.type === 'Uint8Array' && same(d.fields.bytes.values, ['10', '20']), JSON.stringify(d));
      assert(d.fields.name.value === 'a.pdf' && d.fields.password.value === 'x', 'other fields kept');
      assert(await run('sum', { name: 'b', bytes: Buffer.from([1, 2, 3]) }) === 6, 'engine reads the bytes');
      // Lists of inputs, and inputs inside options.
      const [list, opts] = await run('probe', [{ name: '1', bytes: new Uint8Array([1]) }, { name: '2', bytes: new Uint8Array([2]) }],
        { signature: { image: new Uint8Array([3]) }, pages: [1, 2] });
      assert(list.items.every((x) => x.fields.bytes.type === 'Uint8Array'), JSON.stringify(list));
      assert(opts.fields.signature.fields.image.type === 'Uint8Array' && opts.fields.pages.type === 'Array', JSON.stringify(opts));
    });

    await test(`${browser}: a hand-made { __b64 } still arrives as a Uint8Array`, async () => {
      const [d] = await run('probe', { bytes: { __b64: Buffer.from([5, 6]).toString('base64') } });
      assert(d.fields.bytes.type === 'Uint8Array' && same(d.fields.bytes.values, ['5', '6']), JSON.stringify(d));
    });

    await test(`${browser}: other typed arrays, DataViews and ArrayBuffers keep their type both ways`, async () => {
      const input = {
        clamped: new Uint8ClampedArray([1, 255]),
        floats: new Float64Array([Math.PI, -0.5]),
        shorts: new Int16Array([-32768, 32767]),
        big: new BigUint64Array([2n ** 64n - 1n]),
        buffer: new Uint8Array([4, 2]).buffer,
        view: new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2),
        // A view into a larger buffer: only its own bytes go.
        window: new Uint32Array(new Uint32Array([1, 2, 3, 4]).buffer, 4, 2),
        map: new Map([['k', new Uint8Array([1])]]),
        set: new Set([new Float32Array([1.5])]),
      };
      const [d] = await run('probe', input);
      const f = d.fields;
      assert(f.clamped.type === 'Uint8ClampedArray' && same(f.clamped.values, ['1', '255']), JSON.stringify(f.clamped));
      assert(f.floats.type === 'Float64Array' && same(f.floats.values, [String(Math.PI), '-0.5']), JSON.stringify(f.floats));
      assert(f.shorts.type === 'Int16Array' && same(f.shorts.values, ['-32768', '32767']), JSON.stringify(f.shorts));
      assert(f.big.type === 'BigUint64Array' && same(f.big.values, [String(2n ** 64n - 1n)]), JSON.stringify(f.big));
      assert(f.buffer.type === 'ArrayBuffer' && same(f.buffer.bytes, [4, 2]), JSON.stringify(f.buffer));
      assert(f.view.type === 'DataView' && same(f.view.bytes, [8, 7]), JSON.stringify(f.view));
      assert(f.window.type === 'Uint32Array' && same(f.window.values, ['2', '3']), JSON.stringify(f.window));
      assert(f.map.type === 'Map' && f.map.entries[0][1].type === 'Uint8Array', JSON.stringify(f.map));
      assert(f.set.type === 'Set' && f.set.items[0].type === 'Float32Array', JSON.stringify(f.set));

      const [back] = await run('echo', input);
      assert(back.clamped instanceof Uint8ClampedArray && same(values(back.clamped), ['1', '255']), 'Uint8ClampedArray back');
      assert(back.floats instanceof Float64Array && back.floats[0] === Math.PI, 'Float64Array back');
      assert(back.shorts instanceof Int16Array && back.shorts[0] === -32768, 'Int16Array back');
      assert(back.big instanceof BigUint64Array && back.big[0] === 2n ** 64n - 1n, 'BigUint64Array back');
      assert(back.buffer instanceof ArrayBuffer && same([...new Uint8Array(back.buffer)], [4, 2]), 'ArrayBuffer back');
      assert(back.view instanceof DataView && back.view.byteLength === 2 && back.view.getUint8(0) === 8, 'DataView back');
      assert(back.window instanceof Uint32Array && same(values(back.window), ['2', '3']), 'view back');
      assert(back.map instanceof Map && back.map.get('k') instanceof Uint8Array, 'Map back');
      assert(back.set instanceof Set && [...back.set][0] instanceof Float32Array, 'Set back');
    });

    await test(`${browser}: results made in the page come back with their binary values`, async () => {
      const r = await run('outputs', 3);
      assert(Array.isArray(r.files) && r.files.length === 3, 'three OutputFiles');
      for (const [i, f] of r.files.entries()) {
        assert(f.bytes instanceof Uint8Array && same(values(f.bytes), ['37', '80', '68', '70', String(i)]), `file ${i} bytes`);
        assert(f.name === `part ${i + 1}.pdf` && f.type === 'application/pdf', `file ${i} facts`);
      }
      assert(r.pixels instanceof Uint8ClampedArray && same(values(r.pixels), ['0', '128', '255', '255']), 'Uint8ClampedArray');
      assert(r.widths instanceof Float32Array && same(values(r.widths), ['0.5', '1.25']), 'Float32Array');
      assert(r.offsets instanceof BigInt64Array && r.offsets[1] === -2n, 'BigInt64Array');
      assert(r.buffer instanceof ArrayBuffer && same([...new Uint8Array(r.buffer)], [9, 8, 7]), 'ArrayBuffer');
      assert(r.view instanceof DataView && r.view.byteLength === 2 && r.view.getUint8(0) === 2 && r.view.getUint8(1) === 3, 'DataView');
      assert(r.window instanceof Uint8Array && same(values(r.window), ['2', '3']), 'subarray: only its bytes');
      assert(r.subclass.constructor === Uint8Array && same(values(r.subclass), ['6', '6']), 'a Uint8Array subclass comes back as a Uint8Array');
      assert(r.byPage instanceof Map && r.byPage.get(1) instanceof Uint16Array && r.byPage.get(1)[0] === 65535, 'Map of typed arrays');
      assert(r.seen instanceof Set && [...r.seen][0] instanceof Int8Array && [...r.seen][0][0] === -1, 'Set of typed arrays');
      assert(r.when instanceof Date && r.when.getTime() === 86400000, 'Date');
      assert(r.nothing === null && r.text === 'done', 'other values unchanged');
    });

    await test(`${browser}: large bytes go both ways intact`, async () => {
      const size = 6 * 1024 * 1024 + 3;
      const t0 = Date.now();
      const b = await run('big', size);
      assert(b instanceof Uint8Array && b.length === size, `length ${b.length}`);
      for (const i of [0, 1, 255, 0x8000, size - 1]) assert(b[i] === ((i * 31) & 255), `byte ${i}`);
      const [d] = await run('probe', { bytes: b.subarray(0, 10) });
      assert(same(d.fields.bytes.values, values(b.subarray(0, 10))), 'sent back');
      assert(await run('sum', { bytes: b }) === b.reduce((a, x) => a + x, 0), 'whole array sent');
      assert(Date.now() - t0 < 30000, `took ${Date.now() - t0} ms`);
    });

    await test(`${browser}: an engine's error rejects runInPage`, async () => {
      let message = '';
      try { await run('fail'); } catch (e) { message = e.message; }
      assert(message.includes('engine failed on purpose'), message);
    });
  }, { browser });

  await test(`${browser}: allowConsole ignores the console errors it matches, and only those`, async () => {
    // Matching errors only: the page passes.
    await withPage(async (page, url) => {
      await page.goto(url + 'app/fonts/OFL.txt');
      await page.evaluate(() => { console.error('XML Parsing Error: not well-formed'); console.error('Expected noise 2'); });
      await page.waitForTimeout(100);
    }, { browser, allowConsole: [/^XML Parsing Error/, /^Expected noise \d$/] });
    // Any other console error still fails it.
    let failure = '';
    try {
      await withPage(async (page, url) => {
        await page.goto(url + 'app/fonts/OFL.txt');
        await page.evaluate(() => { console.error('XML Parsing Error: allowed'); console.error('Something else broke'); });
        await page.waitForTimeout(100);
      }, { browser, allowConsole: [/^XML Parsing Error/] });
    } catch (e) {
      failure = e.message;
    }
    assert(failure.includes('console error: Something else broke'), `other errors fail: ${failure}`);
    assert(!failure.includes('allowed'), `the allowed one isn't reported: ${failure}`);
    // Without allowConsole, every console error fails it, as before.
    failure = '';
    try {
      await withPage(async (page, url) => {
        await page.goto(url + 'app/fonts/OFL.txt');
        await page.evaluate(() => console.error('XML Parsing Error: not allowed here'));
        await page.waitForTimeout(100);
      }, { browser });
    } catch (e) {
      failure = e.message;
    }
    assert(failure.includes('console error: XML Parsing Error'), `fails by default: ${failure}`);
  });

  await test(`${browser}: allowConsole lets a page parse damaged XML (Firefox logs it as an error)`, async () => {
    const parse = async (page, url) => {
      await page.goto(url + 'app/fonts/OFL.txt');
      const failed = await page.evaluate(() => {
        const doc = new DOMParser().parseFromString('<a><b></a>', 'application/xml');
        return doc.getElementsByTagName('parsererror').length > 0;
      });
      assert(failed, 'the XML is damaged');
      await page.waitForTimeout(200);
    };
    await withPage(parse, { browser, allowConsole: [/XML Parsing Error/] });
    if (browser !== 'firefox') return;
    let failure = '';
    try {
      await withPage(parse, { browser });
    } catch (e) {
      failure = e.message;
    }
    assert(failure.includes('XML Parsing Error'), `Firefox reports it without allowConsole: ${failure}`);
  });
}

console.log(`${count} tests passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
