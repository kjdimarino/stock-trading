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
  it('allows exactly the burst capacity, then spaces the rest', async () => {
    const lim = createLimiter({ capacity: 5, refillMs: 60, maxWaitMs: 100000 });
    const t0 = Date.now();
    const times = [];
    await Promise.all(Array.from({ length: 20 }, () => lim.take().then(() => times.push(Date.now() - t0))));
    times.sort((a, b) => a - b);

    const burst = times.filter((t) => t < 30).length;
    // Too few means the limiter throttles work it should have let through;
    // too many means it admits the burst it exists to prevent.
    eq(burst, 5, `${burst} released immediately for a capacity of 5`);

    const spaced = times.slice(5);
    for (let i = 1; i < spaced.length; i++) {
      const gap = spaced[i] - spaced[i - 1];
      ok(gap >= 40 && gap <= 140, `gap ${gap}ms between queued releases (interval 60ms)`);
    }
  });

  it('is deterministic no matter how callers interleave', async () => {
    // Two waves launched a tick apart must still respect one shared budget.
    const lim = createLimiter({ capacity: 2, refillMs: 80, maxWaitMs: 100000 });
    const t0 = Date.now();
    const times = [];
    const wave = () => Array.from({ length: 4 }, () => lim.take().then(() => times.push(Date.now() - t0)));
    const first = wave();
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([...first, ...wave()]);
    times.sort((a, b) => a - b);
    eq(times.filter((t) => t < 30).length, 2, 'only the burst allowance went immediately');
    ok(times[times.length - 1] >= 5 * 80 * 0.8, `total spread ${times[times.length - 1]}ms`);
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

  it('counts one strike per throttled burst, not one per refused request', async () => {
    const lim = createLimiter({ capacity: 5, refillMs: 10 });
    const sentAt = Date.now();
    // Five requests from one burst all come back 429 — the first in the same
    // millisecond it was sent, which must not make the rest look newer.
    const backoffs = Array.from({ length: 5 }, () => lim.penalise(sentAt));
    ok(backoffs.every((ms) => ms <= 20000), `backoffs ${backoffs.join(',')} — one burst went past the first step`);
    eq(lim.state.strikes, 1, 'strikes after one burst');
    // A late success from the same burst must not wipe the strike it earned.
    lim.reward(sentAt);
    eq(lim.state.strikes, 1, 'a success sent before the ban leaves the strike');
    // A request sent after the ban is a new episode: it escalates, or clears.
    await sleep(5);
    ok(lim.penalise(Date.now()) > 20000, 'a second episode escalates');
    await sleep(5);
    lim.reward(Date.now());
    eq(lim.state.strikes, 0, 'a success sent after the ban clears it');
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

  it('1m equity candles are not a row of flat dashes', async () => {
    const r = await P.fetchCandles('AAPL', '1m', { kind: 'stock' });
    ok(r.bars.length > 20, `only ${r.bars.length} bars`);
    const flat = r.bars.filter((b) => b.o === b.h && b.h === b.l && b.l === b.c).length;
    ok(flat < r.bars.length * 0.5,
      `${flat}/${r.bars.length} bars have no body — candles would be unreadable`);
    for (const b of r.bars) {
      ok(b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c), `bar at ${b.t} has an inverted range`);
    }
  });

  it('a coin with a Coinbase market keeps real OHLCV even though it has a gecko id', async () => {
    // Every curated coin carries a CoinGecko id for market caps. That must not
    // divert its candles to CoinGecko's close-only series.
    const r = await P.fetchCandles('BTC', '1h', { kind: 'crypto', cg: 'bitcoin', yh: 'BTC-USD' });
    eq(r.source, 'coinbase');
    ok(!r.closeOnly, 'Coinbase gives full OHLC');
    const flat = r.bars.filter((b) => b.o === b.h && b.h === b.l && b.l === b.c).length;
    ok(flat < r.bars.length * 0.2, `${flat}/${r.bars.length} bars have no body`);
  });

  it('the long tail directory covers the coins it could fetch, with prices', async () => {
    const dir = await P.geckoDirectory();
    /*
     * Eight pages when the budget allows, fewer when CoinGecko's keyless tier
     * refuses — a partial directory is the designed outcome, not a failure, and
     * the pages that do land are the ones anyone is searching for. So the floor
     * is one full page; the page count is reported for context.
     */
    ok(dir.coins.length >= 250,
      `only ${dir.coins.length} coins from ${dir.pages} page(s) — expected at least one full page`);
    if (dir.pages < 8) console.log(`    (CoinGecko served ${dir.pages}/8 pages this run — rate limited)`);
    eq(dir.quality, 'delayed');
    for (const c of dir.coins.slice(0, 50)) {
      ok(c.cg && c.symbol && c.name, `incomplete coin ${JSON.stringify(c)}`);
      ok(isFinite(c.price) && c.price > 0, `${c.symbol} has no price`);
    }
  });

  it('a long-tail quote is labelled delayed', async () => {
    const dir = await P.geckoDirectory();
    const coin = dir.coins[dir.coins.length - 1];
    let q;
    try {
      q = await P.geckoQuotes([coin.cg]);
    } catch (e) {
      /*
       * CoinGecko's keyless tier is a few calls a minute and the rest of this
       * suite spends them. A refused request is their budget, not our bug — but
       * say so out loud rather than letting it read as a pass.
       */
      if (/429|rate/i.test(e.message)) {
        console.log(`    (skipped the live quote check: CoinGecko returned ${e.message})`);
        return;
      }
      throw e;
    }
    const got = q.quotes[coin.cg];
    ok(got && got.price > 0, `no price for ${coin.cg}`);
    eq(got.quality, 'delayed');
    eq(got.source, 'coingecko');
  });

  it('health reports every provider budget', () => {
    const h = P.providerHealth();
    for (const k of ['nasdaq', 'coingecko', 'coinbase']) ok(h[k], `missing ${k}`);
    ok(h.yahoo.query1 && h.yahoo.query2, 'yahoo hosts are tracked independently');
  });
});

await report('providers');
