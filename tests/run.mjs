// Runs every tests/*.test.mjs file one after another and reports which failed.
//   npm test                          all tests
//   npm test -- organize compress     only the files whose names contain "organize" or "compress"
//   npm test -- --shard 2/4           the second of four similar-sized parts (CI runs the parts
//                                     side by side); filters and --shard can be combined
//   npm test -- --list                print the files that would run, and run nothing
// Filters that match no file are an error, so a mistyped name can't pass by running nothing.
// A file that runs longer than TEST_FILE_TIMEOUT_MINUTES (default 20) is stopped and fails, so a
// test that hangs can't hold up the rest. On GitHub Actions each file's output is a log group.
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

/**
 * Roughly how long each file takes, in seconds (a local run in November 2026). Only used to split
 * the files into parts of similar length for --shard; a file not listed counts as DEFAULT_SECONDS.
 */
const SECONDS = {
  'batch-ui.test.mjs': 150, 'compress.test.mjs': 260, 'docx.test.mjs': 55, 'edit.test.mjs': 105,
  'epub.test.mjs': 90, 'flatten.test.mjs': 27, 'harness.test.mjs': 85, 'images-detect.test.mjs': 90,
  'images-looks.test.mjs': 42, 'images-ui.test.mjs': 225, 'kit.test.mjs': 215, 'mark.test.mjs': 115,
  'ocr.test.mjs': 125, 'office-core.test.mjs': 68, 'office-ui.test.mjs': 135, 'organize-ui-a.test.mjs': 145,
  'organize-ui-b.test.mjs': 85, 'organize.test.mjs': 15, 'pptx.test.mjs': 33, 'redact-ui.test.mjs': 70,
  'redact.test.mjs': 65, 'shell.test.mjs': 67, 'sign.test.mjs': 62, 'site.test.mjs': 31,
  'stamps.test.mjs': 300, 'strings.test.mjs': 2, 'text.test.mjs': 43, 'vendor.test.mjs': 12,
  'xlsx-numbers.test.mjs': 16, 'xlsx.test.mjs': 132,
};
const DEFAULT_SECONDS = 60;

/**
 * Splits files into `count` parts of similar total time (longest first, each to the part with
 * the least so far) and returns part `index` (1-based), in name order. The same files give the
 * same parts on every machine.
 * @param {string[]} files
 * @param {number} index
 * @param {number} count
 * @returns {string[]}
 */
export function shard(files, index, count) {
  const parts = Array.from({ length: count }, () => ({ total: 0, files: [] }));
  const weight = (f) => SECONDS[f] ?? DEFAULT_SECONDS;
  const longestFirst = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const f of longestFirst) {
    const part = parts.reduce((best, p) => (p.total < best.total ? p : best));
    part.total += weight(f);
    part.files.push(f);
  }
  return parts[index - 1].files.sort();
}

function usage(message) {
  console.error(`${message}\nUsage: node tests/run.mjs [name ...] [--shard <i>/<n>] [--list]`);
  process.exit(2);
}

/** The command line: name filters, --shard i/n (or --shard=i/n), --list. */
function parseArgs(args) {
  const filters = [];
  let shardSpec = null;
  let list = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list') list = true;
    else if (a === '--shard') shardSpec = args[++i] ?? '';
    else if (a.startsWith('--shard=')) shardSpec = a.slice(8);
    else if (a.startsWith('--')) usage(`Unknown option: ${a}`);
    else filters.push(a);
  }
  let part = null;
  if (shardSpec !== null) {
    const m = /^(\d+)\/(\d+)$/.exec(shardSpec);
    if (!m || +m[1] < 1 || +m[1] > +m[2]) usage(`--shard needs <i>/<n> with 1 <= i <= n, such as 2/4 (got "${shardSpec}")`);
    part = { index: +m[1], count: +m[2] };
  }
  return { filters, part, list };
}

async function main() {
  const { filters, part, list } = parseArgs(process.argv.slice(2));
  const minutes = Number(process.env.TEST_FILE_TIMEOUT_MINUTES) || 20;
  const github = process.env.GITHUB_ACTIONS === 'true';
  const all = (await readdir(dir)).filter((f) => f.endsWith('.test.mjs')).sort();
  const unmatched = filters.filter((x) => !all.some((f) => f.includes(x)));
  if (unmatched.length) {
    console.error(`No test file matches: ${unmatched.join(', ')}. The files are:\n  ${all.join('\n  ')}`);
    process.exit(1);
  }
  let files = all.filter((f) => !filters.length || filters.some((x) => f.includes(x)));
  if (part) {
    files = shard(files, part.index, part.count);
    console.log(`Part ${part.index} of ${part.count}: ${files.length} test file${files.length === 1 ? '' : 's'}`);
  }
  if (list) {
    console.log(files.join('\n'));
    return;
  }
  const failed = [];
  for (const f of files) {
    const started = performance.now();
    if (github) console.log(`::group::${f}`);
    const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit', timeout: minutes * 60_000 });
    if (github) console.log('::endgroup::');
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    const timedOut = r.error?.code === 'ETIMEDOUT';
    console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${f} (${secs} s${timedOut ? `, stopped after ${minutes} min` : ''})`);
    if (r.status !== 0) {
      failed.push(f);
      if (github) console.log(`::error file=tests/${f}::${f} failed${timedOut ? ` (stopped after ${minutes} min)` : ''}`);
    }
  }
  console.log(`\n${files.length - failed.length} of ${files.length} test files passed.`);
  if (failed.length) {
    console.log('Failed: ' + failed.join(', '));
    process.exit(1);
  }
}

// Run only from the command line: tests import shard() without running anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
