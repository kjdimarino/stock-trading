import { loadPT, describe, it, eq, near, ok, report } from './harness.mjs';

const { PT } = loadPT([
  'src/app/js/00-util.js', 'src/app/js/01-calendar.js', 'src/app/js/02-universe.js',
  'src/app/js/03-engine.js', 'src/app/js/04-indicators.js', 'src/app/js/07-ai.js',
]);
const E = PT.engine, C = PT.companion, T = PT.trader;

/* --------------------------------- helpers -------------------------------- */
const series = (fn, n = 200, base = 100) => Array.from({ length: n }, (_, i) => {
  const c = fn(i, base);
  return { t: i * 60000, o: c, h: c * 1.006, l: c * 0.994, c, v: 1_000_000 };
});
const UP = (i, b) => b * Math.pow(1.006, i);
const DOWN = (i, b) => b * Math.pow(0.994, i);
const FLAT = (_, b) => b;

function ctx(opts = {}) {
  const candles = opts.candles || {};
  const prices = {};
  for (const id in candles) {
    const last = candles[id][candles[id].length - 1];
    prices[id] = { price: last.c, changePct: 0 };
  }
  Object.assign(prices, opts.prices || {});
  return {
    now: opts.now ?? Date.UTC(2026, 7, 19, 14, 0),
    prices,
    candles,
    candidates: opts.candidates || Object.keys(candles),
    cooldowns: opts.cooldowns || {},
    marketOpen: opts.marketOpen !== false,
    slippageEnabled: false,
  };
}
const pf = (cash = 100000) => E.newPortfolio('ai', 'AI Trader', cash);

/* ================================ companion =============================== */

describe('concept explanations', () => {
  it('covers at least 30 concepts', () => ok(Object.keys(C.CONCEPTS).length >= 30, `${Object.keys(C.CONCEPTS).length} concepts`));
  it('finds an exact term', () => eq(C.explainConcept('limit order').term, 'limit order'));
  it('finds a term inside a question', () => eq(C.explainConcept('what is RSI?').term, 'rsi'));
  it('finds a term from a partial word', () => ok(C.explainConcept('bollinger') != null));
  it('returns null for an unknown term', () => eq(C.explainConcept('quantum tunnelling'), null));
  it('every explanation is substantive prose', () => {
    for (const k in C.CONCEPTS) {
      ok(C.CONCEPTS[k].length > 80, `"${k}" explanation is too thin`);
      ok(/[.!]$/.test(C.CONCEPTS[k].trim()), `"${k}" does not end in a sentence`);
    }
  });
});

describe('portfolio analytics', () => {
  it('HHI is 1 for a single position', () => {
    near(C.concentration([{ assetId: 'A', value: 100 }], 100).hhi, 1, 1e-9);
  });
  it('HHI is 0.25 for four equal positions', () => {
    const pos = ['A', 'B', 'C', 'D'].map((a) => ({ assetId: a, value: 25 }));
    near(C.concentration(pos, 100).hhi, 0.25, 1e-9);
  });
  it('identifies the largest holding', () => {
    const c = C.concentration([{ assetId: 'A', value: 30 }, { assetId: 'B', value: 70 }], 100);
    eq(c.top, 'B'); near(c.topWeight, 0.7, 1e-9);
  });
  it('flags a concentrated book', () => {
    const p = pf(10000);
    E.submitOrder(p, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 9000 }, ctx({ prices: { AAPL: { price: 100 } } }));
    const val = E.valuate(p, { AAPL: { price: 100, changePct: 0 } });
    eq(C.analyzePortfolio(val, null, E.stats(p, val)).risk, 'highly concentrated');
  });
  it('flags an uninvested book', () => {
    const val = E.valuate(pf(10000), {});
    eq(C.analyzePortfolio(val, null, null).risk, 'uninvested');
  });
});

describe('generated briefings cite real computed numbers', () => {
  it('calls a rising series bullish', () => {
    const b = C.briefAsset('BTC', series(UP), { price: 100, changePct: 5 });
    ok(b.signal.direction > 0, b.headline);
    ok(b.body.join(' ').includes('RSI(14)'), 'quotes the RSI it computed');
  });
  it('calls a falling series bearish', () => {
    ok(C.briefAsset('BTC', series(DOWN), { price: 100, changePct: -5 }).signal.direction < 0);
  });
  it('degrades honestly with too little history', () => {
    const b = C.briefAsset('BTC', series(FLAT, 3), null);
    ok(b.body.join(' ').toLowerCase().includes('waiting'), 'says it is waiting for data');
    eq(b.signal, null);
  });
  it('never emits NaN or undefined in prose', () => {
    for (const f of [UP, DOWN, FLAT]) {
      const text = C.briefAsset('ETH', series(f), { price: 50, changePct: 1 }).body.join(' ');
      ok(!/NaN|undefined|null/.test(text), `bad text: ${text}`);
    }
  });
  it('summarises an empty portfolio without inventing positions', () => {
    const val = E.valuate(pf(5000), {});
    const b = C.briefPortfolio(C.analyzePortfolio(val, null, null), val);
    ok(b.body.join(' ').includes('no positions'));
  });
  it('summarises a real book with its actual numbers', () => {
    const p = pf(10000);
    E.submitOrder(p, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx({ prices: { AAPL: { price: 100 } } }));
    const val = E.valuate(p, { AAPL: { price: 120, changePct: 2 } });
    const b = C.briefPortfolio(C.analyzePortfolio(val, null, E.stats(p, val)), val);
    const text = b.body.join(' ');
    ok(text.includes('1 position'), text);
    ok(!/NaN|undefined/.test(text), text);
  });
});

/* ================================= trader ================================= */

describe('autonomous trader — entries', () => {
  it('buys the strongest candidate in a clear uptrend', () => {
    const p = pf(100000);
    const c = ctx({ candles: { BTC: series(UP) } });
    const r = T.runTraderCycle(p, c);
    const buy = r.decisions.find((d) => d.action === 'buy');
    ok(buy, `no buy: ${JSON.stringify(r.decisions.map((d) => d.action + ':' + d.why))}`);
    eq(buy.assetId, 'BTC');
    ok(p.positions.BTC.qty > 0);
  });

  it('holds when nothing clears the evidence bar', () => {
    const p = pf(100000);
    const r = T.runTraderCycle(p, ctx({ candles: { BTC: series(FLAT) } }));
    ok(r.decisions.every((d) => d.action !== 'buy'), 'should not buy a flat tape');
    ok(r.decisions.some((d) => d.action === 'hold'));
  });

  it('refuses to buy a downtrend', () => {
    const p = pf(100000);
    const r = T.runTraderCycle(p, ctx({ candles: { BTC: series(DOWN) } }));
    ok(r.decisions.every((d) => d.action !== 'buy'));
  });

  it('logs its reasoning for every decision, holds included', () => {
    const r = T.runTraderCycle(pf(100000), ctx({ candles: { BTC: series(FLAT) } }));
    ok(r.decisions.length > 0);
    for (const d of r.decisions) {
      ok(typeof d.why === 'string' && d.why.length > 20, `thin reasoning: ${d.why}`);
      ok(d.t > 0 && d.id, 'decision is timestamped and identified');
    }
  });

  it('picks the highest-scoring candidate among several', () => {
    const p = pf(100000);
    const r = T.runTraderCycle(p, ctx({
      candles: { BTC: series(UP), ETH: series(FLAT), SOL: series(DOWN) },
    }));
    const buy = r.decisions.find((d) => d.action === 'buy');
    eq(buy.assetId, 'BTC');
  });

  it('skips equities while the market is closed but still trades crypto', () => {
    const p = pf(100000);
    const r = T.runTraderCycle(p, ctx({
      candles: { AAPL: series(UP), BTC: series(UP, 200, 60000) }, marketOpen: false,
    }));
    const buy = r.decisions.find((d) => d.action === 'buy');
    ok(buy && buy.assetId === 'BTC', 'should only take the crypto candidate');
  });

  it('respects a per-symbol cooldown', () => {
    const p = pf(100000);
    const now = Date.UTC(2026, 7, 19, 14, 0);
    const r = T.runTraderCycle(p, ctx({
      candles: { BTC: series(UP) }, cooldowns: { BTC: now - 60000 }, now,
    }));
    ok(r.decisions.every((d) => d.action !== 'buy'), 'cooldown should block the entry');
  });
});

describe('autonomous trader — risk limits', () => {
  it('never exceeds the max position count', () => {
    const p = pf(100000);
    const candles = {};
    for (const id of ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'ATOM', 'NEAR']) {
      candles[id] = series(UP, 200, 50 + Math.random() * 10);
    }
    for (let i = 0; i < 40; i++) {
      T.runTraderCycle(p, ctx({ candles, now: Date.UTC(2026, 7, 19, 14, 0) + i * 3600e3 }));
    }
    ok(Object.keys(p.positions).length <= T.RULES.maxPositions,
      `held ${Object.keys(p.positions).length} positions`);
  });

  it('keeps a cash reserve', () => {
    const p = pf(100000);
    const candles = {};
    for (const id of ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOT']) {
      candles[id] = series(UP, 200, 50);
    }
    for (let i = 0; i < 30; i++) {
      T.runTraderCycle(p, ctx({ candles, now: Date.UTC(2026, 7, 19, 14, 0) + i * 3600e3 }));
    }
    const val = E.valuate(p, ctx({ candles }).prices);
    ok(val.cash / val.equity >= T.RULES.minCashReserve - 0.02,
      `cash was ${(val.cash / val.equity * 100).toFixed(1)}% of equity`);
  });

  it('never lets cash go negative', () => {
    const p = pf(5000);
    const candles = { BTC: series(UP), ETH: series(UP, 200, 30), SOL: series(UP, 200, 12) };
    for (let i = 0; i < 50; i++) {
      T.runTraderCycle(p, ctx({ candles, now: Date.UTC(2026, 7, 19, 14, 0) + i * 3600e3 }));
      ok(p.cash >= 0, `cash went negative on cycle ${i}: ${p.cash}`);
    }
  });

  it('honours the daily trade cap', () => {
    const p = pf(500000);
    const candles = {};
    for (let i = 0; i < 12; i++) candles[['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'ATOM', 'NEAR'][i]] = series(UP, 200, 20 + i);
    const now = Date.UTC(2026, 7, 19, 14, 0);
    for (let i = 0; i < 60; i++) T.runTraderCycle(p, ctx({ candles, now: now + i * 60000 }));
    const today = p.fills.filter((f) => new Date(f.t).toISOString().slice(0, 10) === '2026-08-19');
    ok(today.length <= T.RULES.maxTradesPerDay, `${today.length} trades in one day`);
  });

  it('caps a single position at the weight limit', () => {
    const p = pf(100000);
    const candles = { BTC: series(UP) };
    for (let i = 0; i < 5; i++) {
      T.runTraderCycle(p, ctx({ candles, now: Date.UTC(2026, 7, 19, 14, 0) + i * 3600e3 }));
    }
    const val = E.valuate(p, ctx({ candles }).prices);
    for (const pos of val.positions) {
      ok(pos.value / val.equity <= T.RULES.maxWeightPerPosition + 0.03,
        `${pos.assetId} was ${(pos.value / val.equity * 100).toFixed(1)}% of equity`);
    }
  });
});

describe('autonomous trader — exits', () => {
  it('stops out a losing position', () => {
    const p = pf(100000);
    const up = series(UP);
    T.runTraderCycle(p, ctx({ candles: { BTC: up } }));
    ok(p.positions.BTC, 'entered first');
    const entry = p.positions.BTC.avgCost;

    // Collapse the price well beyond the hard stop.
    const crashed = up.concat(series((i) => entry * (1 - 0.02 * (i + 1)), 30, entry));
    const r = T.runTraderCycle(p, ctx({
      candles: { BTC: crashed },
      prices: { BTC: { price: entry * 0.8, changePct: -20 } },
      now: Date.UTC(2026, 7, 20, 14, 0),
    }));
    const sell = r.decisions.find((d) => d.action === 'sell');
    ok(sell, `no exit: ${JSON.stringify(r.decisions.map((d) => d.action))}`);
    ok(/stop/i.test(sell.why), sell.why);
    eq(p.positions.BTC, undefined);
  });

  it('takes profit on a large winner', () => {
    const p = pf(100000);
    const up = series(UP);
    T.runTraderCycle(p, ctx({ candles: { BTC: up } }));
    const entry = p.positions.BTC.avgCost;
    const r = T.runTraderCycle(p, ctx({
      candles: { BTC: up },
      prices: { BTC: { price: entry * 1.5, changePct: 50 } },
      now: Date.UTC(2026, 7, 20, 14, 0),
    }));
    const sell = r.decisions.find((d) => d.action === 'sell');
    ok(sell, 'should take profit');
    ok(/target/i.test(sell.why), sell.why);
    ok(p.fills.some((f) => f.side === 'sell' && f.realized > 0), 'booked a gain');
  });

  it('records realised P&L on every exit', () => {
    const p = pf(100000);
    const up = series(UP);
    T.runTraderCycle(p, ctx({ candles: { BTC: up } }));
    const entry = p.positions.BTC.avgCost;
    T.runTraderCycle(p, ctx({
      candles: { BTC: up }, prices: { BTC: { price: entry * 1.5, changePct: 50 } },
      now: Date.UTC(2026, 7, 20, 14, 0),
    }));
    const sells = p.fills.filter((f) => f.side === 'sell');
    ok(sells.length > 0 && isFinite(sells[0].realized));
  });
});

describe('autonomous trader — long simulation invariants', () => {
  it('survives 400 cycles of a noisy market with the books intact', () => {
    const p = pf(100000);
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ids = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'ADA'];
    const paths = {};
    for (const id of ids) paths[id] = [100 + rnd() * 50];

    const start = Date.UTC(2026, 7, 19, 14, 0);
    for (let cycle = 0; cycle < 400; cycle++) {
      const candles = {};
      for (const id of ids) {
        const path = paths[id];
        for (let k = 0; k < 3; k++) path.push(Math.max(1, path[path.length - 1] * (1 + (rnd() - 0.485) * 0.04)));
        if (path.length > 300) path.splice(0, path.length - 300);
        candles[id] = path.map((c, i) => ({ t: i * 60000, o: c, h: c * 1.01, l: c * 0.99, c, v: 1e6 }));
      }
      T.runTraderCycle(p, ctx({ candles, now: start + cycle * 60000 }));

      ok(p.cash >= 0, `cash negative at cycle ${cycle}: ${p.cash}`);
      ok(Object.keys(p.positions).length <= T.RULES.maxPositions, `too many positions at ${cycle}`);
      for (const id in p.positions) {
        ok(p.positions[id].qty > 0, `${id} has a non-positive qty at cycle ${cycle}`);
        ok(isFinite(p.positions[id].avgCost) && p.positions[id].avgCost > 0, `${id} avgCost broke`);
      }
    }

    ok(p.fills.length > 5, `expected real activity, got ${p.fills.length} fills`);
    // Cash must reconcile exactly against the fill log.
    const expected = 100000 + p.fills.reduce((s, f) => s + (f.side === 'buy' ? -f.notional : f.notional), 0);
    near(p.cash, expected, 0.02, 'cash reconciles with the fill log');
  });
});

report('ai');
