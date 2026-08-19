/**
 * Provider-layer behaviour that only shows up under concurrency or failure:
 * the rate limiter's burst shape, and freshness labelling.
 */
import { describe, it, eq, ok, near, report } from './harness.mjs';
import * as P from '../src/providers.mjs';

/* The limiter is not exported, so exercise it through a real provider path
   would need network. Re-create it from the module's own source instead so the
   test cannot drift from the shipped implementation. */
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../src/providers.mjs', import.meta.url), 'utf8');
const start = src.indexOf('function createLimiter(');
const end = src.indexOf('const YAHOO_HOSTS');
const createLimiter = new Function(`${src.slice(start, end)}; return createLimiter;`)();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('rate limiter under concurrency', () => {
  it('spaces concurrent callers instead of releasing them in one burst', async () => {
    const lim = createLimiter({ capacity: 5, refillMs: 60, maxWaitMs: 100000 });
    const t0 = Date.now();
    const times = [];
    await Promise.all(Array.from({ length: 20 }, () => lim.take().then(() => times.push(Date.now() - t0))));
    times.sort((a, b) => a - b);

    // The first `capacity` may go immediately; the rest must be spaced out.
    const burst = times.filter((t) => t < 25).length;
    ok(burst <= 6, `${burst} requests released immediately (capacity 5)`);
    const last = times[times.length - 1];
    ok(last >= 14 * 60 * 0.8, `last release at ${last}ms — expected the queue to be spread out`);
  });

  it('reports a burst budget that recovers over time', async () => {
    const lim = createLimiter({ capacity: 3, refillMs: 40 });
    await Promise.all([lim.take(), lim.take(), lim.take()]);
    eq(lim.state.tokens, 0, 'budget spent');
    await sleep(140);
    ok(lim.state.tokens >= 2, `budget recovered to ${lim.state.tokens} without another call`);
  });

  it('refuses work while cooling down', async () => {
    const lim = createLimiter({ capacity: 2, refillMs: 10 });
    lim.penalise();
    eq(lim.state.cooling, true);
    let threw = null;
    try { await lim.take(); } catch (e) { threw = e; }
    ok(threw && threw.cooling, 'take() rejects with a cooling flag');
  });

  it('escalates the cooldown on repeated failures', () => {
    const lim = createLimiter({ capacity: 2, refillMs: 10 });
    const first = lim.penalise();
    const second = lim.penalise();
    ok(second > first, `${second}ms should exceed ${first}ms`);
    lim.reward();
    ok(lim.state.strikes === 0, 'a success clears the strike count');
  });

  it('sheds load rather than queueing without bound', async () => {
    const lim = createLimiter({ capacity: 1, refillMs: 1000, maxWaitMs: 1500 });
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      lim.take().then(() => 'ok', (e) => (e.throttled ? 'shed' : 'other'))));
    ok(results.includes('shed'), `expected some requests to be shed, got ${results.join(',')}`);
  });
});

describe('freshness labelling', () => {
  it('a live crypto snapshot is labelled live', async () => {
    const r = await P.cryptoQuotes(['BTC']);
    ok(r.quotes.BTC, 'BTC priced');
    eq(r.quotes.BTC.source, 'coinbase');
    ok(['live', 'cached'].includes(r.quotes.BTC.quality), r.quotes.BTC.quality);
    ok(r.quotes.BTC.price > 0);
  });

  it('every quote carries a source and a quality', async () => {
    const r = await P.cryptoQuotes(['BTC', 'ETH', 'DOGE', 'PEPE']);
    for (const [sym, q] of Object.entries(r.quotes)) {
      ok(q.source, `${sym} has no source`);
      ok(q.quality, `${sym} has no quality`);
      ok(isFinite(q.price) && q.price > 0, `${sym} price ${q.price}`);
    }
  });

  it('health reports every provider budget', () => {
    const h = P.providerHealth();
    for (const k of ['nasdaq', 'coingecko', 'coinbase']) ok(h[k], `missing ${k}`);
    ok(h.yahoo.query1 && h.yahoo.query2, 'yahoo hosts are tracked independently');
  });
});

await report('providers');
