/**
 * Regressions for the shared number helpers in 00-util.js (rounding and
 * formatting), including the engine paths where their bugs surfaced.
 */
import { loadPT, describe, it, eq, ok, throws, report } from './harness.mjs';

const FILES = [
  'src/app/js/00-util.js', 'src/app/js/01-calendar.js',
  'src/app/js/02-universe.js', 'src/app/js/03-engine.js',
];
const { PT } = loadPT(FILES);
const U = PT.util;
const E = PT.engine;

const ctx = (prices, opts = {}) => ({
  prices, marketOpen: true, now: 1_000_000,
  slippageEnabled: opts.slippage === true, shortingEnabled: opts.shorting === true,
});
const px = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { price: v, changePct: 0 }]));
const fresh = (cash = 100000) => E.newPortfolio('user', 'You', cash);
// What the ticket's Max button fills in (10-views.js applyQuickSize).
const maxQty = (pf, id) => Number(String(U.roundQty(E.availableQty(pf, id), pf.positions[id].kind)));

describe('round() is idempotent on large quantities', () => {
  it('roundQty keeps whole coin counts as they are', () => {
    eq(U.roundQty(3e7, 'crypto'), 3e7);
    eq(U.roundQty(1e8, 'crypto'), 1e8);
    eq(U.roundQty(1e9, 'crypto'), 1e9);
  });
  it('re-rounding never creeps a quantity upward', () => {
    for (const v of [3e7, 29999999.99999999, 142857142.85714287, 1e9, 1e10]) {
      const once = U.roundQty(v, 'crypto');
      let x = once;
      for (let i = 0; i < 5; i++) x = U.roundQty(x, 'crypto');
      eq(x, once, `roundQty(${v}) drifted`);
    }
  });
  it('still rounds representation artefacts as their decimal', () => {
    eq(U.round(1.005, 2), 1.01);
    eq(U.round(0.1 + 0.2, 2), 0.3);
    eq(U.roundQty(0.1 + 0.2, 'crypto'), 0.3);
  });
  for (const shorting of [false, true]) {
    it(`SHIB: buy $300 by notional, Max-sell closes it (shorting ${shorting ? 'on' : 'off'})`, () => {
      const pf = fresh();
      const c = ctx(px({ SHIB: 0.00001 }), { shorting });
      E.submitOrder(pf, { assetId: 'SHIB', side: 'buy', type: 'market', notional: 300 }, c);
      E.submitOrder(pf, { assetId: 'SHIB', side: 'sell', type: 'market', qty: maxQty(pf, 'SHIB') }, c);
      eq(pf.positions.SHIB, undefined);
    });
  }
  it('SHIB: buy 1e9 then sell 1e9 leaves no position', () => {
    const pf = fresh();
    const c = ctx(px({ SHIB: 0.00001 }));
    E.submitOrder(pf, { assetId: 'SHIB', side: 'buy', type: 'market', qty: 1e9 }, c);
    eq(pf.positions.SHIB.qty, 1e9);
    E.submitOrder(pf, { assetId: 'SHIB', side: 'sell', type: 'market', qty: 1e9 }, c);
    eq(pf.positions.SHIB, undefined);
  });
  it('MOG: Max-sell with shorting on leaves no dust short, live or replayed', () => {
    const pf = fresh();
    const c = ctx(px({ MOG: 0.0000007 }), { shorting: true });
    E.submitOrder(pf, { assetId: 'MOG', side: 'buy', type: 'market', notional: 100 }, c);
    E.submitOrder(pf, { assetId: 'MOG', side: 'sell', type: 'market', qty: maxQty(pf, 'MOG') }, c);
    eq(pf.positions.MOG, undefined);
    eq(E.reconstruct(pf).positions.MOG, undefined);
  });
});

describe('round() treats negative halves like positive ones', () => {
  it('ties round away from zero on both sides', () => {
    eq(U.round(0.175, 2), 0.18);
    eq(U.round(-0.175, 2), -0.18);
    eq(U.round(2.675, 2), 2.68);
    eq(U.round(-2.675, 2), -2.68);
  });
  it('a long and its mirror short book the same realized cents', () => {
    const c = ctx(px({ AAPL: 1 }), { shorting: true });
    const long = fresh();
    E.submitOrder(long, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 5 }, c);
    const lf = E.submitOrder(long, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 5 }, ctx(px({ AAPL: 0.907 }))).fill;
    const short = fresh();
    E.submitOrder(short, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 5 }, c);
    const sf = E.submitOrder(short, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 5 }, ctx(px({ AAPL: 0.907 }))).fill;
    eq(lf.realized, -0.47);
    eq(sf.realized, 0.47);
  });
});

describe('fmtQty never shows more than is held', () => {
  it('cuts digits instead of rounding up', () => {
    eq(U.fmtQty(2.99849475), '2.9984');
    eq(U.fmtQty(2.999994), '2.9999');
    eq(U.fmtQty(0.99999999), '0.999999');
    eq(U.fmtQty(1234.999), '1,234.99');
    eq(U.fmtQty(9.99996), '9.9999');
    eq(U.fmtQty(-2.99849475), '-2.9984');
  });
  it('clean decimals still print cleanly', () => {
    eq(U.fmtQty(0.3), '0.3');
    eq(U.fmtQty(0.1 + 0.2), '0.3');
    eq(U.fmtQty(1.15), '1.15');
    eq(U.fmtQty(12.5), '12.5');
    eq(U.fmtQty(0), '0');
  });
  it('a difference sitting just under its decimal is not cut a unit low', () => {
    eq(U.fmtQty(0.3 - 0.1), '0.2');
    eq(U.fmtQty(5.3 - 2.1), '3.2');
    eq(U.fmtQty(0.03 - 0.01), '0.02');
    eq(U.fmtQty(-(0.3 - 0.1)), '-0.2');
    // Past 2^50 scaled units round() leaves a value alone, so the snap must not rely on it.
    eq(U.fmtQty(14999999.969999999), '14,999,999.97');
  });
  it('snapping float noise never rounds a genuine amount up', () => {
    eq(U.fmtQty(0.0000123456789), '0.00001234');
    eq(U.fmtQty(5.999999996), '5.9999');
    eq(U.fmtQty(0.99999999995), '0.999999');
    eq(U.fmtQty(0.00009999999), '0.00009999');
  });
  it('the free quantity reads the same as the Max button fills', () => {
    const pf = fresh();
    const c = ctx(px({ BTC: 50000 }));
    E.submitOrder(pf, { assetId: 'BTC', side: 'buy', type: 'market', qty: 0.3 }, c);
    E.submitOrder(pf, { assetId: 'BTC', side: 'sell', type: 'limit', qty: 0.1, limitPrice: 60000 }, c);
    eq(U.fmtQty(E.availableQty(pf, 'BTC')), String(maxQty(pf, 'BTC')));
    throws(() => E.submitOrder(pf, { assetId: 'BTC', side: 'sell', type: 'market', qty: 0.25 }, c), 'Only 0.2 BTC is free');
  });
  it('selling the displayed ETH amount neither fails nor opens a short', () => {
    for (const shorting of [false, true]) {
      const pf = fresh();
      const c = ctx(px({ ETH: 3333.34 }), { slippage: true, shorting });
      E.submitOrder(pf, { assetId: 'ETH', side: 'buy', type: 'market', notional: 10000 }, c);
      const shown = U.fmtQty(pf.positions.ETH.qty);
      E.submitOrder(pf, { assetId: 'ETH', side: 'sell', type: 'market', qty: Number(shown.replace(/,/g, '')) }, c);
      ok(!pf.positions.ETH || pf.positions.ETH.qty > 0, `shorting ${shorting}: left ${JSON.stringify(pf.positions.ETH)}`);
    }
  });
});

describe('fmtUSD', () => {
  it('zero is plain dollars and cents', () => {
    eq(U.fmtUSD(0), '$0.00');
    eq(U.fmtUSD(-0), '$0.00');
  });
  it('an all-in buy leaves a readable "available" in the next rejection', () => {
    const pf = fresh(1000);
    const c = ctx(px({ AAPL: 100 }));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 1000 }, c);
    eq(pf.cash, 0);
    throws(() => E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 1 }, c), 'available $0.00.');
  });
  it('keeps significant digits on sub-nano prices', () => {
    eq(U.fmtUSD(1.3e-9), '$0.000000001300');
    eq(U.fmtUSD(4.9e-9), '$0.000000004900');
    eq(U.fmtUSD(5e-9), '$0.000000005000');
    eq(U.fmtUSD(-1.3e-9), '-$0.000000001300');
    eq(U.fmtUSD(4.16688e-10), '$0.0000000004167');
  });
  it('leaves the familiar tiers alone', () => {
    eq(U.fmtUSD(0.000012), '$0.00001200');
    eq(U.fmtUSD(0.00005), '$0.00005000');
    eq(U.fmtUSD(0.005), '$0.005000');
    eq(U.fmtUSD(0.5), '$0.5000');
    eq(U.fmtUSD(1234.5), '$1,234.50');
    eq(U.fmtUSD(0.5, { fixed2: true }), '$0.50');
  });
});

describe('fmtCompact picks its unit after rounding', () => {
  const cases = [
    [999.996, '1.0K'], [999949, '999.9K'], [999950, '1.00M'], [999999, '1.00M'], [-999999, '-1.00M'],
    [999994999, '999.99M'], [999995000, '1.00B'], [999.999e9, '1.00T'],
    [0, '0'], [999.99, '999.99'], [1234, '1.2K'], [1e6, '1.00M'], [2.5e9, '2.50B'], [1e15, '1,000.00T'],
  ];
  for (const [v, want] of cases) it(`${v} -> ${want}`, () => eq(U.fmtCompact(v), want));
});

await report('calendar-regress');
