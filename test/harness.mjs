/**
 * Loads the browser-side app modules into a sandboxed fake window so the exact
 * shipped code can be unit-tested in Node. No DOM is stubbed beyond what the
 * pure-logic modules touch.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadPT(files, { now = null, localStorage = true } = {}) {
  const store = new Map();
  const sandbox = {
    console, Intl, Date, Math, JSON, Object, Array, String, Number, Boolean,
    Error, TypeError, RangeError, Map, Set, WeakMap, Promise, Symbol, RegExp,
    isFinite, isNaN, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, setInterval, clearInterval, structuredClone,
    performance, TextEncoder, TextDecoder, URL, URLSearchParams, fetch, AbortController,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  if (localStorage) {
    sandbox.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      key: (i) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  }
  if (now != null) {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(now); }
      static now() { return now; }
    }
    sandbox.Date = FakeDate;
  }

  vm.createContext(sandbox);
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }
  return { PT: sandbox.PT, sandbox, store };
}

/* ------------------------------- assertions ------------------------------ */

let passed = 0, failed = 0;
const failures = [];
const pending = [];
let suite = '';

export const describe = (name, fn) => { suite = name; fn(); };

/**
 * Supports both sync and async test bodies. An async body that threw would
 * otherwise become an unhandled rejection and be counted as a pass — the worst
 * possible failure mode for a test harness.
 */
export function it(name, fn) {
  const where = suite;
  const fail = (e) => {
    failed++;
    failures.push(`${where} › ${name}\n    ${e && e.message ? e.message : e}`);
  };
  let result;
  try {
    result = fn();
  } catch (e) {
    return fail(e);
  }
  if (result && typeof result.then === 'function') {
    pending.push(result.then(() => { passed++; }, fail));
    return;
  }
  passed++;
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'expected'}: got ${a}, want ${b}`);
}

export function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= (tol ?? 1e-9))) {
    throw new Error(`${msg || 'expected'}: got ${actual}, want ~${expected} (±${tol ?? 1e-9})`);
  }
}

export function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

export function throws(fn, match, msg) {
  try { fn(); } catch (e) {
    if (match && !String(e.message).includes(match)) {
      throw new Error(`${msg || 'throws'}: message "${e.message}" lacks "${match}"`);
    }
    return;
  }
  throw new Error(msg || 'expected a throw');
}

export async function report(label) {
  await Promise.all(pending);
  const total = passed + failed;
  if (failed) {
    console.log(`\n\x1b[31m✗ ${label}: ${passed}/${total} passed\x1b[0m`);
    failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32m✓ ${label}: ${passed}/${total} passed\x1b[0m`);
  }
  return failed === 0;
}
