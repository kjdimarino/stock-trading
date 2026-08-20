import { loadPT, describe, it, eq, near, ok, throws, report } from './harness.mjs';

const FILES = [
  'src/app/js/00-util.js', 'src/app/js/01-calendar.js',
  'src/app/js/02-universe.js', 'src/app/js/03-engine.js',
];
const { PT, sandbox } = loadPT(FILES);
const localStorage = sandbox.localStorage;
const E = PT.engine;

const ctx = (prices, opts = {}) => ({
  prices, marketOpen: opts.marketOpen !== false,
  slippageEnabled: opts.slippage === true, now: opts.now ?? 1_000_000,
});
const px = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { price: v, changePct: 0 }]));
const fresh = (cash = 10000) => E.newPortfolio('user', 'You', cash);

describe('order validation', () => {
  it('rejects unknown symbols', () => {
    throws(() => E.submitOrder(fresh(), { assetId: 'NOTREAL', side: 'buy', type: 'market', qty: 1 },
      ctx(px({ AAPL: 100 }))), 'Unknown symbol');
  });
  it('rejects when there is no live price', () => {
    throws(() => E.submitOrder(fresh(), { assetId: 'AAPL', side: 'buy', type: 'market', qty: 1 },
      ctx(px({}))), 'No live price');
  });
  it('rejects a buy that exceeds cash', () => {
    throws(() => E.submitOrder(fresh(100), { assetId: 'AAPL', side: 'buy', type: 'market', qty: 5 },
      ctx(px({ AAPL: 100 }))), 'Not enough cash');
  });
  it('rejects selling more than held when shorting is off', () => {
    throws(() => E.submitOrder(fresh(), { assetId: 'AAPL', side: 'sell', type: 'market', qty: 1 },
      ctx(px({ AAPL: 100 }))), 'Turn on short selling');
  });
  it('rejects stock orders while the market is closed only when queueing is off', () => {
    throws(() => E.submitOrder(fresh(), { assetId: 'AAPL', side: 'buy', type: 'market', qty: 1 },
      { ...ctx(px({ AAPL: 100 }), { marketOpen: false }), allowQueue: false }), 'US equities are closed');
  });
  it('allows crypto orders while equities are closed', () => {
    const pf = fresh();
    const r = E.submitOrder(pf, { assetId: 'BTC', side: 'buy', type: 'market', qty: 0.01 },
      ctx(px({ BTC: 50000 }), { marketOpen: false }));
    ok(r.fill, 'crypto should fill');
  });
  it('rejects zero and negative quantity', () => {
    throws(() => E.submitOrder(fresh(), { assetId: 'AAPL', side: 'buy', type: 'market', qty: 0 },
      ctx(px({ AAPL: 100 }))), 'greater than zero');
    throws(() => E.submitOrder(fresh(), { assetId: 'AAPL', side: 'buy', type: 'market', qty: -3 },
      ctx(px({ AAPL: 100 }))), 'greater than zero');
  });
  it('rejects sub-minimum dust orders', () => {
    throws(() => E.submitOrder(fresh(), { assetId: 'AAPL', side: 'buy', type: 'market', qty: 0.0001 },
      ctx(px({ AAPL: 100 }))), 'at least $1');
  });
  it('rejects a fat-finger limit far from the market', () => {
    throws(() => E.submitOrder(fresh(), { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 1, limitPrice: 5000 },
      ctx(px({ AAPL: 100 }))), '10x away');
  });
  it('rejects a non-numeric limit price', () => {
    throws(() => E.submitOrder(fresh(), { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 1, limitPrice: 'abc' },
      ctx(px({ AAPL: 100 }))), 'valid limit price');
  });
});

describe('market orders and cost basis', () => {
  it('buy debits cash and opens a position', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 150 })));
    near(pf.cash, 8500, 1e-9);
    near(pf.positions.AAPL.qty, 10, 1e-9);
    near(pf.positions.AAPL.avgCost, 150, 1e-9);
  });

  it('averages cost across two buys at different prices', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 30 }, ctx(px({ AAPL: 200 })));
    // (10*100 + 30*200) / 40 = 175
    near(pf.positions.AAPL.avgCost, 175, 1e-9);
    near(pf.positions.AAPL.qty, 40, 1e-9);
    near(pf.cash, 10000 - 1000 - 6000, 1e-9);
  });

  it('sell realises P&L against the average and leaves the average intact', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 40 }, ctx(px({ AAPL: 100 })));
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 10 }, ctx(px({ AAPL: 130 })));
    near(r.fill.realized, 300, 1e-6);          // (130-100)*10
    near(pf.positions.AAPL.avgCost, 100, 1e-9); // unchanged by the sell
    near(pf.positions.AAPL.qty, 30, 1e-9);
    near(pf.cash, 10000 - 4000 + 1300, 1e-9);
  });

  it('a losing sell realises a negative number', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 10 }, ctx(px({ AAPL: 80 })));
    near(r.fill.realized, -200, 1e-6);
  });

  it('fully closing a position removes it but keeps the realised history', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 10 }, ctx(px({ AAPL: 120 })));
    eq(pf.positions.AAPL, undefined);
    const v = E.valuate(pf, px({ AAPL: 120 }));
    near(v.realized, 200, 1e-6);
    near(v.equity, 10200, 1e-6);
  });

  it('round-trip at the same price is exactly flat', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 7 }, ctx(px({ AAPL: 123.45 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 7 }, ctx(px({ AAPL: 123.45 })));
    near(pf.cash, 10000, 1e-6);
    near(E.valuate(pf, px({ AAPL: 123.45 })).equity, 10000, 1e-6);
  });

  it('supports notional (dollar-amount) orders with fractional shares', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 500 }, ctx(px({ AAPL: 173.21 })));
    near(pf.positions.AAPL.qty * 173.21, 500, 0.01);
    ok(pf.positions.AAPL.qty % 1 !== 0, 'should be fractional');
  });

  it('supports 8-decimal crypto quantities', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'BTC', side: 'buy', type: 'market', notional: 25 }, ctx(px({ BTC: 64321.55 })));
    const q = pf.positions.BTC.qty;
    ok(q > 0 && q < 0.001, 'small fractional coin qty');
    eq(String(q).split('.')[1].length <= 8, true);
  });

  it('cash never goes negative when spending the entire balance', () => {
    const pf = fresh(1000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 1000 }, ctx(px({ AAPL: 137.77 })));
    ok(pf.cash >= 0, `cash was ${pf.cash}`);
  });
});

describe('slippage model', () => {
  it('buys fill above and sells below the quote when enabled', () => {
    const pf = fresh(10000);
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 1 },
      ctx(px({ AAPL: 100 }), { slippage: true }));
    near(r.fill.price, 100 * 1.0002, 1e-9); // 2 bps for equities
    const s = E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 1 },
      ctx(px({ AAPL: 100 }), { slippage: true }));
    near(s.fill.price, 100 * 0.9998, 1e-9);
  });
  it('crypto carries a wider simulated spread than equities', () => {
    ok(E.SLIPPAGE_BPS.crypto > E.SLIPPAGE_BPS.stock);
  });
  it('slippage makes an instant round trip a small loss', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 }), { slippage: true }));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 }), { slippage: true }));
    ok(pf.cash < 10000 && pf.cash > 9999, `expected small loss, got ${pf.cash}`);
  });
});

describe('limit orders', () => {
  it('a non-marketable buy limit rests on the book', () => {
    const pf = fresh(10000);
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 10, limitPrice: 90 },
      ctx(px({ AAPL: 100 })));
    eq(r.fill, null);
    eq(pf.orders.length, 1);
    near(pf.cash, 10000, 1e-9); // cash is not debited until the fill
  });

  it('a resting buy limit fills when price falls to it', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 10, limitPrice: 90 }, ctx(px({ AAPL: 100 })));
    eq(E.processOpenOrders(pf, ctx(px({ AAPL: 95 }))).length, 0, 'no fill above the limit');
    const fills = E.processOpenOrders(pf, ctx(px({ AAPL: 89 })));
    eq(fills.length, 1);
    near(fills[0].price, 89, 1e-9); // price improvement: fills at market, not the limit
    eq(pf.orders.length, 0);
  });

  it('a resting sell limit fills when price rises to it', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'limit', qty: 10, limitPrice: 120 }, ctx(px({ AAPL: 100 })));
    eq(E.processOpenOrders(pf, ctx(px({ AAPL: 119 }))).length, 0);
    const fills = E.processOpenOrders(pf, ctx(px({ AAPL: 125 })));
    eq(fills.length, 1);
    near(fills[0].price, 125, 1e-9);
    near(fills[0].realized, 250, 1e-6);
  });

  it('a marketable limit fills immediately at the better price', () => {
    const pf = fresh(10000);
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 10, limitPrice: 110 },
      ctx(px({ AAPL: 100 })));
    ok(r.fill, 'should fill at once');
    near(r.fill.price, 100, 1e-9); // buyer never pays more than the market
    eq(pf.orders.length, 0);
  });

  it('resting equity orders do not fill while the market is closed', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 10, limitPrice: 90 }, ctx(px({ AAPL: 100 })));
    eq(E.processOpenOrders(pf, ctx(px({ AAPL: 80 }), { marketOpen: false })).length, 0);
    eq(pf.orders.length, 1);
  });

  it('an equity order placed while shut is queued, not rejected', () => {
    const pf = fresh(10000);
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 },
      ctx(px({ AAPL: 100 }), { marketOpen: false }));
    eq(r.fill, null, 'nothing fills while the market is shut');
    eq(r.queued, true);
    eq(pf.orders.length, 1);
    eq(pf.orders[0].status, 'queued');
    eq(pf.cash, 10000, 'cash is held, not spent');
  });

  it('a queued market order fills at the opening price', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 },
      ctx(px({ AAPL: 100 }), { marketOpen: false }));
    const fills = E.processOpenOrders(pf, ctx(px({ AAPL: 104 })));
    eq(fills.length, 1);
    near(fills[0].price, 104, 1e-9, 'fills at the open, not at the previous close');
    eq(pf.orders.length, 0);
    eq(pf.positions.AAPL.qty, 10);
  });

  it('a queued order stays put until the bell', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 },
      ctx(px({ AAPL: 100 }), { marketOpen: false }));
    eq(E.processOpenOrders(pf, ctx(px({ AAPL: 104 }), { marketOpen: false })).length, 0);
    eq(pf.orders[0].status, 'queued', 'still waiting');
  });

  it('a queued buy reserves its cash so it cannot be spent twice', () => {
    const pf = fresh(1000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 9 },
      ctx(px({ AAPL: 100 }), { marketOpen: false }));
    const free = E.availableCash(pf, px({ AAPL: 100 }));
    ok(free < 200, `expected the queued order to hold ~$900, free was ${free}`);
    throws(() => E.submitOrder(pf, { assetId: 'BTC', side: 'buy', type: 'market', notional: 500 },
      ctx(px({ AAPL: 100, BTC: 50000 }), { marketOpen: false })), 'Not enough');
  });

  it('a dollar-sized queued buy buys its dollars at the open, not a stale share count', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 500 },
      ctx(px({ AAPL: 100 }), { marketOpen: false }));
    // Gap up overnight: the same share count would now cost more than was reserved.
    const fills = E.processOpenOrders(pf, ctx(px({ AAPL: 125 })));
    eq(fills.length, 1);
    near(fills[0].notional, 500, 1, 'spends the dollars that were reserved');
    near(pf.positions.AAPL.qty, 4, 1e-6);
  });

  it('a queued sell holds the shares it will deliver', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 10 },
      ctx(px({ AAPL: 100 }), { marketOpen: false }));
    eq(E.availableQty(pf, 'AAPL'), 0, 'the shares are spoken for');
  });

  it('a queued order can be cancelled and gives its cash back', () => {
    const pf = fresh(1000);
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 9 },
      ctx(px({ AAPL: 100 }), { marketOpen: false }));
    eq(E.cancelOrder(pf, r.order.id), true);
    near(E.availableCash(pf, px({ AAPL: 100 })), 1000, 1e-9);
  });

  it('a queued limit joins the book at the open rather than filling blind', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 10, limitPrice: 90 },
      ctx(px({ AAPL: 100 }), { marketOpen: false }));
    eq(E.processOpenOrders(pf, ctx(px({ AAPL: 95 }))).length, 0, 'the open is above the limit');
    eq(pf.orders[0].status, 'open', 'released, now resting');
    eq(E.processOpenOrders(pf, ctx(px({ AAPL: 89 }))).length, 1, 'fills when the price comes to it');
  });

  it('resting crypto orders fill around the clock', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'BTC', side: 'buy', type: 'limit', qty: 0.01, limitPrice: 50000 },
      ctx(px({ BTC: 60000 }), { marketOpen: false }));
    eq(E.processOpenOrders(pf, ctx(px({ BTC: 49000 }), { marketOpen: false })).length, 1);
  });

  it('resting buy limits reserve their cash so it cannot be spent twice', () => {
    const pf = fresh(1000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 10, limitPrice: 90 }, ctx(px({ AAPL: 100 })));
    near(E.availableCash(pf), 100, 1e-9, 'only the unreserved balance is spendable');
    // The resting order has claimed $900, so a $990 market buy must be refused
    // up front rather than silently killing the resting order later.
    throws(() => E.submitOrder(pf, { assetId: 'TSLA', side: 'buy', type: 'market', notional: 990 }, ctx(px({ TSLA: 200 }))),
      'held against open orders');
    ok(pf.orders.length === 1, 'the resting order survives');
  });

  it('resting sell limits reserve their shares', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'limit', qty: 10, limitPrice: 130 }, ctx(px({ AAPL: 100 })));
    near(E.availableQty(pf, 'AAPL'), 0, 1e-9);
    throws(() => E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 5 }, ctx(px({ AAPL: 100 }))),
      'committed to open sell orders');
  });

  it('an order that still cannot fill is kept and explained, not silently dropped', () => {
    const pf = fresh(1000);
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 10, limitPrice: 90 }, ctx(px({ AAPL: 100 })));
    // Force the failure the reservation normally prevents.
    pf.cash = 10;
    const fills = E.processOpenOrders(pf, ctx(px({ AAPL: 89 })));
    eq(fills.length, 0);
    eq(pf.orders.length, 0);
    eq(pf.rejected.length, 1, 'the order is retained for the user to see');
    eq(pf.rejected[0].id, r.order.id);
    ok(pf.rejected[0].rejectedReason.length > 0, 'it carries a reason');
    ok(pf.cash >= 0, 'cash stayed non-negative');
  });

  it('cancels a resting order', () => {
    const pf = fresh(10000);
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 1, limitPrice: 50 }, ctx(px({ AAPL: 100 })));
    eq(E.cancelOrder(pf, r.order.id), true);
    eq(pf.orders.length, 0);
    eq(E.cancelOrder(pf, 'nope'), false);
  });
});

describe('valuation and day P&L', () => {
  it('computes unrealised P&L in dollars and percent', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    const v = E.valuate(pf, px({ AAPL: 125 }));
    near(v.unrealized, 250, 1e-6);
    near(v.unrealizedPct, 25, 1e-6);
    near(v.equity, 9000 + 1250, 1e-6);
    near(v.totalReturn, 250, 1e-6);
    near(v.totalReturnPct, 2.5, 1e-6);
  });

  it('equity equals cash when flat', () => {
    near(E.valuate(fresh(5000), px({})).equity, 5000, 1e-9);
  });

  it('values a position at its cost basis and flags it when the feed drops', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    const v = E.valuate(pf, px({}));
    eq(v.staleCount, 1);
    eq(v.positions[0].stale, true);
    near(v.equity, 10000, 1e-6);
  });

  it('anchors day P&L on first valuation and tracks it thereafter', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    const d1 = E.dayPnl(pf, E.valuate(pf, px({ AAPL: 100 })), '2026-08-19');
    near(d1.change, 0, 1e-6);
    const d2 = E.dayPnl(pf, E.valuate(pf, px({ AAPL: 110 })), '2026-08-19');
    near(d2.change, 100, 1e-6);
    near(d2.changePct, 1, 1e-6);
  });

  it('re-anchors day P&L on a new trading date', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    E.dayPnl(pf, E.valuate(pf, px({ AAPL: 100 })), '2026-08-19');
    const next = E.dayPnl(pf, E.valuate(pf, px({ AAPL: 110 })), '2026-08-20');
    near(next.change, 0, 1e-6);         // fresh day starts flat
    near(next.baseline, 10100, 1e-6);
  });

  it('sorts positions by market value, largest first', () => {
    const pf = fresh(100000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 1000 }, ctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'TSLA', side: 'buy', type: 'market', notional: 5000 }, ctx(px({ TSLA: 200 })));
    eq(E.valuate(pf, px({ AAPL: 100, TSLA: 200 })).positions.map((p) => p.assetId), ['TSLA', 'AAPL']);
  });
});

describe('statistics', () => {
  const build = () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 5 }, ctx(px({ AAPL: 120 }))); // +100
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 5 }, ctx(px({ AAPL: 90 })));  // -50
    return pf;
  };
  it('counts trades, wins and losses', () => {
    const s = E.stats(build(), null);
    eq(s.trades, 3); eq(s.sells, 2); eq(s.wins, 1); eq(s.losses, 1);
  });
  it('win rate counts closed trades only', () => near(E.stats(build(), null).winRate, 50, 1e-9));
  it('profit factor is gross win over gross loss', () => near(E.stats(build(), null).profitFactor, 2, 1e-9));
  it('win rate is null before any sell', () => eq(E.stats(fresh(), null).winRate, null));
  it('computes max drawdown from the equity curve', () => {
    const pf = fresh(10000);
    [10000, 12000, 9000, 11000].forEach((e, i) => pf.equity.push({ t: i * 1000, e }));
    near(E.stats(pf, null).maxDrawdownPct, 25, 1e-9); // 12000 -> 9000
  });
});

describe('equity curve pruning', () => {
  it('thins old samples but keeps recent detail', () => {
    const now = 10 * 86400e3;
    const samples = [];
    for (let t = 0; t <= now; t += 10e3) samples.push({ t, e: 10000 });
    const pruned = E.pruneEquity(samples, now);
    ok(pruned.length < samples.length / 5, `pruned to ${pruned.length} of ${samples.length}`);
    eq(pruned[pruned.length - 1].t, now, 'newest sample is always kept');
    const recent = pruned.filter((s) => now - s.t < 3600e3);
    ok(recent.length > 300, `kept dense recent detail (${recent.length})`);
  });
  it('keeps the curve bounded across a simulated month', () => {
    const pf = fresh(10000);
    let t = 0;
    for (let i = 0; i < 200000; i++) { t += 10e3; E.sampleEquity(pf, 10000 + i, t); }
    ok(pf.equity.length < 6000, `curve held at ${pf.equity.length} points`);
  });
});

describe('persistence', () => {
  it('round-trips state through localStorage', () => {
    const st = E.newState(25000);
    E.submitOrder(st.portfolios.user, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 5 }, ctx(px({ AAPL: 100 })));
    eq(E.save(st), true);
    const back = E.load();
    near(back.portfolios.user.cash, 24500, 1e-6);
    near(back.portfolios.user.positions.AAPL.qty, 5, 1e-9);
    eq(back.version, E.SCHEMA_VERSION);
  });
  it('returns null when nothing is stored', () => { E.clear(); eq(E.load(), null); });
  it('survives corrupt stored JSON', () => {
    localStorage.setItem(E.STORAGE_KEY, '{not json');
    eq(E.load(), null);
    E.clear();
  });
  it('refuses state written by a newer schema', () => {
    localStorage.setItem(E.STORAGE_KEY, JSON.stringify({ version: 99, portfolios: {} }));
    eq(E.load(), null);
    E.clear();
  });
  it('starts both portfolios with identical cash', () => {
    const st = E.newState(50000);
    eq(st.portfolios.user.cash, st.portfolios.ai.cash);
    eq(st.portfolios.ai.startingCash, 50000);
  });
});

describe('review regressions', () => {
  it('a dollar order for the entire balance is accepted', () => {
    // Rounding qty up made estCost exceed the notional and tripped the cash
    // check on roughly half of all "Max" buys.
    let rejected = 0, tried = 0;
    for (let cents = 5000; cents <= 60000; cents += 137) {
      const price = cents / 100;
      const pf = fresh(10000);
      tried++;
      try {
        E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 10000 },
          ctx(px({ AAPL: price }), { slippage: true }));
      } catch { rejected++; }
    }
    eq(rejected, 0, `${rejected} of ${tried} full-balance buys were rejected`);
  });

  it('sizing by dollars never spends more than the dollars requested', () => {
    for (const price of [187.4321, 0.069989, 64321.55, 3.33333]) {
      const pf = fresh(10000);
      E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 500 },
        ctx(px({ AAPL: price })));
      ok(10000 - pf.cash <= 500 + 0.005, `spent ${(10000 - pf.cash).toFixed(6)} for a $500 order at ${price}`);
    }
  });

  it('realized P&L survives the fill log being trimmed', () => {
    const pf = fresh(100000);
    for (let i = 0; i < 3; i++) {
      E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
      E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 10 }, ctx(px({ AAPL: 110 })));
    }
    near(E.valuate(pf, px({})).realized, 300, 1e-6);
    pf.fills = pf.fills.slice(-2);            // what the quota fallback does
    near(E.valuate(pf, px({})).realized, 300, 1e-6, 'still 300 after truncation');
  });

  it('day P&L does not anchor to an unpriced book', () => {
    const pf = fresh(5000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 50 }, ctx(px({ AAPL: 100 })));
    // Startup: quotes have not arrived, so valuate falls back to cost basis.
    const cold = E.dayPnl(pf, E.valuate(pf, px({})), '2026-08-19');
    eq(cold.pending, true, 'reports pending rather than anchoring');
    eq(pf.dayBaseline, null, 'no baseline is written from an unpriced book');
    // Quotes arrive with the position up 50% on the month but flat today.
    const warm = E.dayPnl(pf, E.valuate(pf, px({ AAPL: 150 })), '2026-08-19');
    near(warm.change, 0, 1e-6, 'today is flat, not +2500');
    near(pf.dayBaseline.equity, 7500, 1e-6);
  });

  it('save only sheds history on a genuine quota error', () => {
    const st = E.newState(10000);
    for (let i = 0; i < 40; i++) {
      E.submitOrder(st.portfolios.user, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 1 }, ctx(px({ AAPL: 10 })));
    }
    const before = st.portfolios.user.fills.length;
    const real = localStorage.setItem;
    localStorage.setItem = () => { const e = new Error('storage disabled'); e.name = 'SecurityError'; throw e; };
    eq(E.save(st), false);
    localStorage.setItem = real;
    eq(st.portfolios.user.fills.length, before, 'history is untouched by a non-quota failure');
  });
});


describe('short selling', () => {
  const sctx = (prices, o = {}) => ({
    prices, marketOpen: true, slippageEnabled: false, shortingEnabled: true,
    now: o.now ?? 1_000_000,
  });

  it('selling with no position opens a short', () => {
    const pf = fresh(10000);
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 50 }, sctx(px({ AAPL: 100 })));
    eq(r.fill.effect, 'open short');
    near(pf.positions.AAPL.qty, -50, 1e-9);
    near(pf.positions.AAPL.avgCost, 100, 1e-9);
    near(pf.cash, 15000, 1e-6, 'proceeds are credited');
    near(E.valuate(pf, px({ AAPL: 100 })).equity, 10000, 1e-6, 'equity is unchanged at entry');
  });

  it('a short gains when the price falls', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 50 }, sctx(px({ AAPL: 100 })));
    const v = E.valuate(pf, px({ AAPL: 80 }));
    near(v.unrealized, 1000, 1e-6);
    near(v.equity, 11000, 1e-6);
    eq(v.positions[0].isShort, true);
  });

  it('a short loses when the price rises', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 50 }, sctx(px({ AAPL: 100 })));
    near(E.valuate(pf, px({ AAPL: 130 })).unrealized, -1500, 1e-6);
  });

  it('covering realises the gain and closes the position', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 50 }, sctx(px({ AAPL: 100 })));
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 50 }, sctx(px({ AAPL: 80 })));
    eq(r.fill.effect, 'cover short');
    near(r.fill.realized, 1000, 1e-6);
    eq(pf.positions.AAPL, undefined);
    near(pf.cash, 11000, 1e-6);
    near(E.valuate(pf, px({})).realized, 1000, 1e-6);
  });

  it('partially covering leaves the entry price alone', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 50 }, sctx(px({ AAPL: 100 })));
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 20 }, sctx(px({ AAPL: 90 })));
    near(r.fill.realized, 200, 1e-6);
    near(pf.positions.AAPL.qty, -30, 1e-9);
    near(pf.positions.AAPL.avgCost, 100, 1e-9);
  });

  it('selling through a long flips it to a short', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, sctx(px({ AAPL: 100 })));
    const r = E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 30 }, sctx(px({ AAPL: 120 })));
    eq(r.fill.effect, 'reverse to short');
    near(r.fill.realized, 200, 1e-6, 'the long leg is realised');
    near(pf.positions.AAPL.qty, -20, 1e-9);
    near(pf.positions.AAPL.avgCost, 120, 1e-9, 'the short opens at the fill price');
  });

  it('holds 150% collateral against a short', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 50 }, sctx(px({ AAPL: 100 })));
    const prices = px({ AAPL: 100 });
    near(E.shortExposure(pf, prices), 5000, 1e-6);
    near(E.shortCollateral(pf, prices), 7500, 1e-6);
    near(E.availableCash(pf, prices), 7500, 1e-6, 'proceeds cannot be spent twice');
  });

  it('caps leverage at roughly 2x, the Reg T limit', () => {
    const pf = fresh(10000);
    throws(() => E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 250 }, sctx(px({ AAPL: 100 }))),
      'Not enough margin');
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 190 }, sctx(px({ AAPL: 100 })));
    near(pf.positions.AAPL.qty, -190, 1e-9);
  });

  it('refuses to short when the setting is off', () => {
    throws(() => E.submitOrder(fresh(10000), { assetId: 'AAPL', side: 'sell', type: 'market', qty: 1 },
      { ...sctx(px({ AAPL: 100 })), shortingEnabled: false }), 'Turn on short selling');
  });

  it('escalates from healthy to margin call to forced buy-in', () => {
    // 100 shares shorted at 100 with 10,000 of own cash: equity 10,000 against
    // 10,000 of exposure. A call lands when equity drops under 30% of the short.
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 100 }, sctx(px({ AAPL: 100 })));
    eq(E.marginStatus(pf, px({ AAPL: 100 })).level, 'ok');
    eq(E.marginStatus(pf, px({ AAPL: 130 })).level, 'ok', 'a 30% move is survivable');
    eq(E.marginStatus(pf, px({ AAPL: 156 })).level, 'call');
    eq(E.marginStatus(pf, px({ AAPL: 165 })).level, 'liquidate');
  });

  it('a freshly opened maximum short is not instantly liquidated', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 190 }, sctx(px({ AAPL: 100 })));
    eq(E.marginStatus(pf, px({ AAPL: 100 })).level, 'ok');
  });

  it('counts a covered short as a closed winning trade', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 50 }, sctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 50 }, sctx(px({ AAPL: 80 })));
    const st = E.stats(pf, E.valuate(pf, px({})));
    eq(st.wins, 1);
    eq(st.winRate, 100);
  });

  it('reconstruction reproduces a short book exactly', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 50 }, sctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 20 }, sctx(px({ AAPL: 90 })));
    E.submitOrder(pf, { assetId: 'TSLA', side: 'buy', type: 'market', qty: 5 }, sctx(px({ TSLA: 200 })));
    const rebuilt = E.reconstruct(pf);
    near(rebuilt.cash, pf.cash, 0.01);
    near(rebuilt.positions.AAPL.qty, pf.positions.AAPL.qty, 1e-9);
    near(rebuilt.positions.AAPL.avgCost, pf.positions.AAPL.avgCost, 1e-9);
    near(rebuilt.realizedTotal, pf.realizedTotal, 0.01);
  });

  it('never lets cash go negative across a randomised long/short run', () => {
    const pf = fresh(50000);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const syms = ['AAPL', 'TSLA', 'BTC'];
    for (let i = 0; i < 400; i++) {
      const id = syms[Math.floor(rnd() * syms.length)];
      const base = { AAPL: 180, TSLA: 340, BTC: 64000 }[id];
      const prices = px({ [id]: base * (0.85 + rnd() * 0.3) });
      try {
        E.submitOrder(pf, {
          assetId: id, side: rnd() < 0.5 ? 'buy' : 'sell', type: 'market',
          notional: 100 + rnd() * 3000,
        }, sctx(prices));
      } catch { /* rejections are expected */ }
      ok(pf.cash >= 0, `cash negative at ${i}: ${pf.cash}`);
      for (const s of syms) {
        const p = pf.positions[s];
        if (p) ok(isFinite(p.qty) && p.qty !== 0 && isFinite(p.avgCost) && p.avgCost > 0, `${s} corrupt at ${i}`);
      }
    }
    // Cash must still reconcile against the fill log.
    const rebuilt = E.reconstruct(pf);
    near(pf.cash, rebuilt.cash, 0.05, 'cash matches the fill log after 400 mixed trades');
  });
});

describe('account repair', () => {
  it('rebuilds a book whose cash was corrupted', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    E.submitOrder(pf, { assetId: 'AAPL', side: 'sell', type: 'market', qty: 10 }, ctx(px({ AAPL: 120 })));
    pf.cash = null;                       // a partial write
    const report = E.repair(pf);
    ok(report, 'a repair happened');
    eq(report.exact, true);
    near(pf.cash, 10200, 1e-6);
  });

  it('does nothing to a healthy book', () => eq(E.repair(fresh(10000)), null));

  it('a zeroed balance does not stay zero', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    pf.cash = NaN;
    E.repair(pf);
    near(pf.cash, 9000, 1e-6, 'restored from the trade history');
    ok(E.availableCash(pf, px({ AAPL: 100 })) > 0, 'and it can trade again');
  });

  it('clamps rather than guessing when history is incomplete', () => {
    const pf = fresh(10000);
    E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', qty: 10 }, ctx(px({ AAPL: 100 })));
    pf.fillsTrimmed = true;
    pf.cash = null;
    const report = E.repair(pf);
    eq(report.exact, false, 'does not claim an exact rebuild');
    ok(isFinite(pf.cash) && pf.cash >= 0);
  });

  it('drops positions that cannot be valued', () => {
    const pf = fresh(10000);
    pf.positions.AAPL = { qty: NaN, avgCost: 10, realized: 0, kind: 'stock' };
    pf.fillsTrimmed = true;
    E.repair(pf);
    eq(pf.positions.AAPL, undefined);
  });
});

describe('float safety', () => {
  it('survives 500 randomised trades without cash drift or negative balances', () => {
    const pf = fresh(100000);
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const syms = ['AAPL', 'TSLA', 'BTC', 'DOGE', 'SPY'];
    for (let i = 0; i < 500; i++) {
      const id = syms[Math.floor(rnd() * syms.length)];
      const price = { AAPL: 173.21, TSLA: 336.87, BTC: 64321.55, DOGE: 0.069989, SPY: 767.45 }[id];
      const p = ctx(px({ [id]: price * (0.9 + rnd() * 0.2) }));
      try {
        if (rnd() < 0.5) {
          E.submitOrder(pf, { assetId: id, side: 'buy', type: 'market', notional: 10 + rnd() * 500 }, p);
        } else {
          const held = pf.positions[id] ? pf.positions[id].qty : 0;
          if (held > 0) E.submitOrder(pf, { assetId: id, side: 'sell', type: 'market', qty: held * rnd() }, p);
        }
      } catch { /* rejections are expected and fine */ }
      ok(pf.cash >= 0, `cash went negative at trade ${i}: ${pf.cash}`);
    }
    for (const id in pf.positions) ok(pf.positions[id].qty > 0, `${id} left a zero/negative qty row`);
    // Independently recompute cash from the fill log.
    const expected = 100000 + pf.fills.reduce((s, f) => s + (f.side === 'buy' ? -f.notional : f.notional), 0);
    near(pf.cash, expected, 0.01, 'cash matches the fill log');
  });
});

await report('engine');
