/**
 * Runs every suite. Unit suites first (fast, no network), then the live-data
 * and browser suites which need the server running.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const UNIT = ['calendar', 'engine', 'indicators', 'chart', 'feed', 'ai', 'strategy'];
const LIVE = ['live-feed', 'providers'];

let failed = 0;
const run = (file, env = {}) => {
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) failed++;
  return r.status === 0;
};

console.log('\n\x1b[1m── unit suites ──\x1b[0m');
for (const name of UNIT) run(`test/${name}.test.mjs`);

if (process.env.PT_SKIP_LIVE !== '1') {
  console.log('\n\x1b[1m── live data ──\x1b[0m');
  for (const name of LIVE) run(`test/${name}.test.mjs`);
}

if (process.env.PT_SKIP_BROWSER !== '1' && fs.existsSync('node_modules/playwright')) {
  console.log('\n\x1b[1m── browser end-to-end ──\x1b[0m');
  spawnSync('bash', ['tools/serve.sh', 'start'], { stdio: 'inherit' });
  run('test/browser.test.mjs');
  // Equities are shut most of the time, so this suite pins the clock open and
  // exercises the stock path that would otherwise never be covered.
  run('test/market-open.test.mjs');

  // Regenerate the documentation screenshots last, from a settled book, so the
  // suite's reset flow cannot leave them showing an empty account.
  if (process.env.PT_SHOTS === '1') {
    console.log('\n\x1b[1m── screenshots ──\x1b[0m');
    run('tools/screenshots.mjs');
  }
  spawnSync('bash', ['tools/serve.sh', 'stop'], { stdio: 'inherit' });
}

console.log(failed ? `\n\x1b[31m${failed} suite(s) failed\x1b[0m` : '\n\x1b[32mall suites passed\x1b[0m');
process.exit(failed ? 1 : 0);
