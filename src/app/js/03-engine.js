/* =========================================================================
   Paper trading engine.

   Long-only by design: shorting a paper account teaches margin mechanics that
   this app does not simulate (borrow fees, maintenance calls, forced buy-ins),
   and getting those subtly wrong would be worse than omitting them.

   All mutations funnel through this module so the human portfolio and the
   autonomous AI portfolio share one accounting implementation.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const { round, money, roundQty } = U;

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'pt.state.v1';

  /** Simulated spread/slippage, in basis points, applied to market orders. */
  const SLIPPAGE_BPS = { stock: 2, etf: 2, crypto: 5 };

  /** Smallest order we accept, in dollars — stops dust orders. */
  const MIN_NOTIONAL = 1;

  /* ----------------------------------------------------------- portfolios */

  function newPortfolio(id, name, startingCash) {
    return {
      id,
      name,
      startingCash: money(startingCash),
      cash: money(startingCash),
      positions: {},   // assetId -> { qty, avgCost, realized, kind, openedAt }
      orders: [],      // open (resting) limit orders
      fills: [],       // executed trades, newest last
      equity: [],      // [{ t, e }] sampled equity curve
      dayBaseline: null, // { etDate, equity } — anchor for day P&L
      counters: { orders: 0 },
    };
  }

  function newState(startingCash) {
    const now = Date.now();
    return {
      version: SCHEMA_VERSION,
      createdAt: now,
      startingCash: money(startingCash),
      portfolios: {
        user: newPortfolio('user', 'You', startingCash),
        ai: newPortfolio('ai', 'AI Trader', startingCash),
      },
      watchlist: PT.defaultWatchlist.slice(),
      aiLog: [],
      settings: {
        slippageEnabled: true,
        aiTraderEnabled: true,
        aiIntervalMs: 60000,
        soundEnabled: false,
        llmKey: '',
      },
    };
  }

  /* -------------------------------------------------------------- pricing */

  const kindOf = (assetId) => PT.assetKind(assetId);

  /** Price a market order would actually get, after simulated spread. */
  function effectivePrice(assetId, side, price, slippageEnabled) {
    if (!slippageEnabled) return price;
    const bps = SLIPPAGE_BPS[kindOf(assetId)] ?? 2;
    const mult = side === 'buy' ? 1 + bps / 10000 : 1 - bps / 10000;
    return price * mult;
  }

  /* ----------------------------------------------------------- validation */

  class OrderError extends Error {}

  /**
   * Normalise and validate an order request.
   * Accepts either `qty` (shares/coins) or `notional` (dollars).
   * Returns a fully-specified order object; throws OrderError on rejection.
   */
  function buildOrder(pf, req, ctx) {
    const { assetId, side, type } = req;
    const asset = PT.byId[assetId];
    if (!asset) throw new OrderError(`Unknown symbol "${assetId}".`);
    if (side !== 'buy' && side !== 'sell') throw new OrderError('Side must be buy or sell.');
    if (type !== 'market' && type !== 'limit') throw new OrderError('Order type must be market or limit.');

    const kind = asset.kind;
    const quote = ctx.prices[assetId];
    const last = quote && isFinite(quote.price) ? quote.price : null;
    if (last == null || last <= 0) {
      throw new OrderError(`No live price for ${assetId} yet — wait for the feed to connect.`);
    }

    if (kind !== 'crypto' && !ctx.marketOpen) {
      throw new OrderError('US equities are closed. Crypto trades 24/7 — try BTC, ETH or DOGE.');
    }

    let limitPrice = null;
    if (type === 'limit') {
      limitPrice = Number(req.limitPrice);
      if (!isFinite(limitPrice) || limitPrice <= 0) throw new OrderError('Enter a valid limit price.');
      // Guard against fat-finger limits that could never fill sensibly.
      if (limitPrice > last * 10 || limitPrice < last / 10) {
        throw new OrderError('Limit price is more than 10x away from the market.');
      }
    }

    // Reference price for sizing: limit orders size against their own limit.
    const refPrice = type === 'limit' ? limitPrice : effectivePrice(assetId, side, last, ctx.slippageEnabled);

    let qty;
    if (req.notional != null && req.notional !== '') {
      const notional = Number(req.notional);
      if (!isFinite(notional) || notional <= 0) throw new OrderError('Enter a valid dollar amount.');
      qty = roundQty(notional / refPrice, kind);
    } else {
      qty = roundQty(Number(req.qty), kind);
    }
    if (!isFinite(qty) || qty <= 0) throw new OrderError('Enter a quantity greater than zero.');

    const estCost = qty * refPrice;
    if (estCost < MIN_NOTIONAL) {
      throw new OrderError(`Order value must be at least $${MIN_NOTIONAL}.`);
    }

    if (side === 'buy') {
      if (estCost > pf.cash + 1e-6) {
        throw new OrderError(
          `Not enough cash. Need ${U.fmtUSD(estCost)}, available ${U.fmtUSD(pf.cash)}.`,
        );
      }
    } else {
      const held = pf.positions[assetId] ? pf.positions[assetId].qty : 0;
      if (qty > held + 1e-9) {
        throw new OrderError(
          `You only hold ${U.fmtQty(held)} ${assetId}. Short selling is not supported.`,
        );
      }
    }

    pf.counters.orders += 1;
    return {
      id: U.uid('ord'),
      seq: pf.counters.orders,
      assetId,
      kind,
      side,
      type,
      qty,
      limitPrice,
      status: 'open',
      createdAt: ctx.now ?? Date.now(),
      note: req.note || null,
    };
  }

  /* ----------------------------------------------------------- execution */

  /**
   * Apply a fill to the portfolio. Mutates `pf` and returns the fill record.
   * Cost basis is a weighted average; a sell realises P&L against that average
   * and leaves the average untouched (standard for fractional paper accounts).
   */
  function applyFill(pf, order, price, ts, reason) {
    const kind = order.kind;
    const qty = roundQty(order.qty, kind);
    const gross = qty * price;

    let realizedDelta = 0;

    if (order.side === 'buy') {
      const cost = money(gross);
      // Guard: never let rounding push cash negative.
      if (cost > pf.cash + 1e-6) throw new OrderError('Insufficient cash at fill time.');
      const pos = pf.positions[order.assetId] || {
        qty: 0, avgCost: 0, realized: 0, kind, openedAt: ts,
      };
      const newQty = roundQty(pos.qty + qty, kind);
      // Weighted average cost basis.
      pos.avgCost = newQty > 0 ? (pos.qty * pos.avgCost + qty * price) / newQty : 0;
      pos.qty = newQty;
      pos.kind = kind;
      if (!pos.openedAt) pos.openedAt = ts;
      pf.positions[order.assetId] = pos;
      pf.cash = money(pf.cash - cost);
    } else {
      const pos = pf.positions[order.assetId];
      if (!pos || pos.qty + 1e-9 < qty) throw new OrderError('Insufficient shares at fill time.');
      realizedDelta = (price - pos.avgCost) * qty;
      pos.realized = round(pos.realized + realizedDelta, 6);
      pos.qty = roundQty(pos.qty - qty, kind);
      pf.cash = money(pf.cash + money(gross));
      if (pos.qty <= 1e-9) {
        // Fully closed: keep realised P&L on the books via the fill log, drop the row.
        delete pf.positions[order.assetId];
      }
    }

    const fill = {
      id: U.uid('fil'),
      orderId: order.id,
      assetId: order.assetId,
      kind,
      side: order.side,
      type: order.type,
      qty,
      price,
      notional: money(gross),
      realized: order.side === 'sell' ? round(realizedDelta, 2) : 0,
      t: ts,
      reason: reason || order.note || null,
    };
    pf.fills.push(fill);
    if (pf.fills.length > 5000) pf.fills.splice(0, pf.fills.length - 5000);

    order.status = 'filled';
    order.filledAt = ts;
    order.filledPrice = price;
    return fill;
  }

  /**
   * Submit an order. Market orders fill immediately against the live quote;
   * limit orders rest until `processOpenOrders` sees the market cross them.
   */
  function submitOrder(pf, req, ctx) {
    const order = buildOrder(pf, req, ctx);
    const ts = ctx.now ?? Date.now();

    if (order.type === 'market') {
      const price = effectivePrice(order.assetId, order.side,
        ctx.prices[order.assetId].price, ctx.slippageEnabled);
      const fill = applyFill(pf, order, price, ts, req.reason);
      return { order, fill };
    }

    // A limit order priced through the market fills right away, as on a real book.
    const last = ctx.prices[order.assetId].price;
    if (crosses(order, last)) {
      const fill = applyFill(pf, order, marketableLimitPrice(order, last), ts, req.reason);
      return { order, fill };
    }

    pf.orders.push(order);
    return { order, fill: null };
  }

  /** Would this resting limit order execute at `price`? */
  function crosses(order, price) {
    if (order.side === 'buy') return price <= order.limitPrice;
    return price >= order.limitPrice;
  }

  /**
   * Price improvement: a marketable limit fills at the better of limit and
   * market, exactly as a real exchange would.
   */
  function marketableLimitPrice(order, market) {
    return order.side === 'buy' ? Math.min(order.limitPrice, market)
      : Math.max(order.limitPrice, market);
  }

  /**
   * Walk resting orders against current prices. No partial fills: a paper
   * account cannot honestly model queue position, so an order is all-or-nothing.
   */
  function processOpenOrders(pf, ctx) {
    const ts = ctx.now ?? Date.now();
    const fills = [];
    const still = [];

    for (const order of pf.orders) {
      if (order.status !== 'open') continue;
      // Equities only fill during regular hours.
      if (order.kind !== 'crypto' && !ctx.marketOpen) { still.push(order); continue; }

      const q = ctx.prices[order.assetId];
      if (!q || !isFinite(q.price)) { still.push(order); continue; }

      if (!crosses(order, q.price)) { still.push(order); continue; }

      try {
        fills.push(applyFill(pf, order, marketableLimitPrice(order, q.price), ts, 'Limit order filled'));
      } catch (e) {
        // Conditions changed since the order rested (cash spent elsewhere).
        order.status = 'rejected';
        order.rejectedReason = e.message;
        order.rejectedAt = ts;
      }
    }
    pf.orders = still;
    return fills;
  }

  function cancelOrder(pf, orderId) {
    const i = pf.orders.findIndex((o) => o.id === orderId);
    if (i < 0) return false;
    pf.orders.splice(i, 1);
    return true;
  }

  /* ---------------------------------------------------------- valuation */

  /**
   * Value the portfolio at current prices.
   * A position whose feed has dropped is valued at its last known price and
   * flagged via `stale` so the UI can say so rather than silently misreport.
   */
  function valuate(pf, prices) {
    let invested = 0, unrealized = 0, costBasis = 0, stale = 0;
    const rows = [];

    for (const assetId in pf.positions) {
      const pos = pf.positions[assetId];
      const q = prices[assetId];
      const price = q && isFinite(q.price) ? q.price : pos.avgCost;
      if (!q || !isFinite(q.price)) stale++;

      const value = pos.qty * price;
      const cost = pos.qty * pos.avgCost;
      const upl = value - cost;

      invested += value;
      costBasis += cost;
      unrealized += upl;

      rows.push({
        assetId,
        kind: pos.kind,
        qty: pos.qty,
        avgCost: pos.avgCost,
        price,
        value,
        cost,
        unrealized: upl,
        unrealizedPct: cost > 0 ? (upl / cost) * 100 : 0,
        realized: pos.realized,
        dayChangePct: q ? q.changePct : null,
        dayChange: q && isFinite(q.changePct) ? value - value / (1 + q.changePct / 100) : null,
        stale: !q || !isFinite(q.price),
        openedAt: pos.openedAt,
      });
    }

    rows.sort((a, b) => b.value - a.value);

    const realizedTotal = pf.fills.reduce((s, f) => s + (f.realized || 0), 0);
    const equity = pf.cash + invested;

    return {
      cash: pf.cash,
      invested,
      costBasis,
      unrealized,
      unrealizedPct: costBasis > 0 ? (unrealized / costBasis) * 100 : 0,
      realized: realizedTotal,
      equity,
      totalReturn: equity - pf.startingCash,
      totalReturnPct: pf.startingCash > 0 ? ((equity - pf.startingCash) / pf.startingCash) * 100 : 0,
      positions: rows,
      staleCount: stale,
    };
  }

  /**
   * Day P&L is measured against an anchor captured the first time the app
   * values the book on a new Eastern-time date. That makes it behave sensibly
   * overnight and across weekends, where "previous close" is ambiguous for a
   * mixed stock+crypto book.
   */
  function dayPnl(pf, val, etDate) {
    if (!pf.dayBaseline || pf.dayBaseline.etDate !== etDate) {
      pf.dayBaseline = { etDate, equity: val.equity, t: Date.now() };
    }
    const base = pf.dayBaseline.equity;
    const change = val.equity - base;
    return {
      change,
      changePct: base > 0 ? (change / base) * 100 : 0,
      baseline: base,
      since: pf.dayBaseline.t,
    };
  }

  /* ------------------------------------------------------- equity curve */

  /** Minimum spacing between retained samples, by sample age. */
  function minSpacing(ageMs) {
    if (ageMs < 3600e3) return 10e3;        // last hour: 10s
    if (ageMs < 86400e3) return 60e3;       // last day: 1m
    if (ageMs < 7 * 86400e3) return 300e3;  // last week: 5m
    return 3600e3;                          // older: 1h
  }

  /** Thin the curve in place so localStorage stays bounded over weeks of use. */
  function pruneEquity(samples, now) {
    const out = [];
    let lastKept = -Infinity;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const isLast = i === samples.length - 1;
      if (isLast || s.t - lastKept >= minSpacing(now - s.t)) {
        out.push(s);
        lastKept = s.t;
      }
    }
    return out;
  }

  function sampleEquity(pf, equity, now) {
    const last = pf.equity[pf.equity.length - 1];
    if (last && now - last.t < 5000) {
      // Keep the newest point fresh without growing the array every tick.
      last.e = round(equity, 2);
      last.t = now;
      return;
    }
    pf.equity.push({ t: now, e: round(equity, 2) });
    if (pf.equity.length > 200 && pf.equity.length % 50 === 0) {
      pf.equity = pruneEquity(pf.equity, now);
    }
  }

  /* ---------------------------------------------------------- statistics */

  /**
   * Trade statistics. A "trade" for win-rate purposes is a *sell* (a realised
   * round trip), which is the convention retail platforms use.
   */
  function stats(pf, val) {
    const sells = pf.fills.filter((f) => f.side === 'sell');
    const wins = sells.filter((f) => f.realized > 0).length;
    const losses = sells.filter((f) => f.realized < 0).length;
    const decided = wins + losses;

    const grossWin = sells.reduce((s, f) => s + Math.max(0, f.realized), 0);
    const grossLoss = sells.reduce((s, f) => s + Math.max(0, -f.realized), 0);

    // Max drawdown across the recorded equity curve.
    let peak = -Infinity, maxDD = 0;
    for (const s of pf.equity) {
      if (s.e > peak) peak = s.e;
      if (peak > 0) maxDD = Math.max(maxDD, (peak - s.e) / peak);
    }

    // Volatility of sampled returns, annualised with the observed sample rate.
    let sharpe = null;
    if (pf.equity.length > 20) {
      const rets = [];
      for (let i = 1; i < pf.equity.length; i++) {
        const p = pf.equity[i - 1].e, c = pf.equity[i].e;
        if (p > 0) rets.push(c / p - 1);
      }
      if (rets.length > 10) {
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
        const sd = Math.sqrt(varr);
        const spanMs = pf.equity[pf.equity.length - 1].t - pf.equity[0].t;
        const perYear = spanMs > 0 ? (rets.length / spanMs) * 365 * 24 * 3600e3 : 0;
        if (sd > 0 && perYear > 0) sharpe = (mean / sd) * Math.sqrt(perYear);
      }
    }

    return {
      trades: pf.fills.length,
      buys: pf.fills.length - sells.length,
      sells: sells.length,
      wins,
      losses,
      winRate: decided > 0 ? (wins / decided) * 100 : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
      avgWin: wins > 0 ? grossWin / wins : 0,
      avgLoss: losses > 0 ? grossLoss / losses : 0,
      maxDrawdownPct: maxDD * 100,
      sharpe,
      openOrders: pf.orders.length,
      positions: val ? val.positions.length : Object.keys(pf.positions).length,
    };
  }

  /* -------------------------------------------------------- persistence */

  function migrate(state) {
    if (!state || typeof state !== 'object') return null;
    if (state.version === SCHEMA_VERSION) return state;
    // Only one schema version exists so far; future migrations chain here.
    if (state.version == null) return null;
    if (state.version > SCHEMA_VERSION) return null; // newer app wrote this
    return state;
  }

  function load() {
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
    if (!raw) return null;
    try {
      const parsed = migrate(JSON.parse(raw));
      if (!parsed) return null;
      // Defensive: fill in anything a partial write may have lost.
      for (const id of ['user', 'ai']) {
        const pf = parsed.portfolios && parsed.portfolios[id];
        if (!pf) return null;
        pf.positions = pf.positions || {};
        pf.orders = pf.orders || [];
        pf.fills = pf.fills || [];
        pf.equity = pf.equity || [];
        pf.counters = pf.counters || { orders: pf.orders.length };
      }
      parsed.watchlist = parsed.watchlist || PT.defaultWatchlist.slice();
      parsed.aiLog = parsed.aiLog || [];
      parsed.settings = Object.assign(newState(0).settings, parsed.settings || {});
      return parsed;
    } catch (e) {
      console.warn('[PT] saved state unreadable, starting fresh', e);
      return null;
    }
  }

  /**
   * Persist. On quota exhaustion, shed history oldest-first and retry rather
   * than losing the portfolio itself.
   */
  function save(state) {
    const attempt = (s) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      return true;
    };
    try {
      return attempt(state);
    } catch (e) {
      const now = Date.now();
      for (const id of ['user', 'ai']) {
        const pf = state.portfolios[id];
        pf.equity = pruneEquity(pf.equity, now).filter((s) => now - s.t < 30 * 86400e3);
        if (pf.fills.length > 1000) pf.fills = pf.fills.slice(-1000);
      }
      if (state.aiLog.length > 200) state.aiLog = state.aiLog.slice(-200);
      try {
        return attempt(state);
      } catch (e2) {
        console.error('[PT] could not persist state', e2);
        return false;
      }
    }
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  PT.engine = {
    SCHEMA_VERSION, STORAGE_KEY, SLIPPAGE_BPS, MIN_NOTIONAL, OrderError,
    newState, newPortfolio, submitOrder, buildOrder, applyFill, processOpenOrders,
    cancelOrder, crosses, effectivePrice, valuate, dayPnl, stats,
    sampleEquity, pruneEquity, load, save, clear,
  };
})(window.PT);
