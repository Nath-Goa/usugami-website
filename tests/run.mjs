// Runs every tests/*.test.mjs file one after another and reports which failed.
//   npm test                 all tests
//   npm test -- split merge  only the files whose names contain "split" or "merge"
// A file that runs longer than TEST_FILE_TIMEOUT_MINUTES (default 20) is stopped and fails, so a
// test that hangs can't hold up the rest. On GitHub Actions each file's output is a log group.
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);
const minutes = Number(process.env.TEST_FILE_TIMEOUT_MINUTES) || 20;
const github = process.env.GITHUB_ACTIONS === 'true';
const files = (await readdir(dir))
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)))
  .sort();
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
