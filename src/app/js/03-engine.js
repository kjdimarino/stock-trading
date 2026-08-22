/* =========================================================================
   Paper trading engine.

   Supports long and short positions. A position's quantity is signed: positive
   is long, negative is short. Shorts follow a Reg-T-shaped margin model —
   proceeds are credited to cash but 150% of the short's current value is held
   as collateral, so the account cannot spend money it may need to buy back.
   A maintenance check warns, and ultimately forces a buy-in, if the position
   moves far enough against you.

   All mutations funnel through this module so the human portfolio and the
   autonomous AI portfolio share one accounting implementation.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const { round, money, roundQty, floorQty } = U;

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'pt.state.v1';

  /** Simulated spread/slippage, in basis points, applied to market orders. */
  const SLIPPAGE_BPS = { stock: 2, etf: 2, crypto: 5 };

  /** Smallest order we accept, in dollars — stops dust orders. */
  const MIN_NOTIONAL = 1;

  /**
   * Slack when comparing an order's cost against cash. Cash is tracked to the
   * cent, so anything below half a cent is representation noise rather than a
   * real shortfall. A tolerance tighter than the quantity rounding step would
   * reject "spend my whole balance" orders.
   */
  const CASH_EPS = 0.005;
  const QTY_EPS = 1e-9;

  /*
   * Two different quantities, easily confused:
   *
   * SHORT_INITIAL_MARGIN is the *collateral* held, as a multiple of the short's
   * market value. 1.5 mirrors Reg T — the sale proceeds plus 50% of your own
   * money — which works out to about 2x leverage.
   *
   * The MAINTENANCE ratios compare account *equity* to short market value.
   * Brokers require roughly 30%; below that the account is in a margin call,
   * and below the force level the position is bought back.
   */
  const SHORT_INITIAL_MARGIN = 1.5;
  const SHORT_MAINTENANCE_RATIO = 0.30;
  const SHORT_FORCE_RATIO = 0.25;

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
      rejected: [],    // orders that could not fill, kept so they are explainable
      equity: [],      // [{ t, e }] sampled equity curve
      // Accumulated at fill time. The fill log gets trimmed, so realized P&L
      // must never be re-derived from it or booked profit would shrink.
      realizedTotal: 0,
      dayBaseline: null, // { etDate, equity } — anchor for day P&L
      counters: { orders: 0 },
    };
  }

  /* ------------------------------------------------------------- accounts */

  /** Ordered user account ids, always at least one, never including the AI. */
  function accountIds(state) {
    const list = (state.accounts || []).filter((id) => id !== 'ai' && state.portfolios[id]);
    return list.length ? list : ['user'];
  }

  /** The account the user is currently trading. */
  function activeAccount(state) {
    const ids = accountIds(state);
    const id = ids.includes(state.activeAccount) ? state.activeAccount : ids[0];
    return state.portfolios[id];
  }

  function setActiveAccount(state, id) {
    if (!state.portfolios[id] || id === 'ai') return false;
    state.activeAccount = id;
    return true;
  }

  const MAX_ACCOUNTS = 12;

  /**
   * Open another account. Each is completely independent: its own cash,
   * positions, orders, history and equity curve. Nothing is shared but the
   * watchlist and the chart drawings, which are about symbols rather than money.
   */
  function addAccount(state, name, startingCash) {
    const ids = accountIds(state);
    if (ids.length >= MAX_ACCOUNTS) {
      throw new OrderError(`You can keep up to ${MAX_ACCOUNTS} accounts open at once.`);
    }
    const cash = money(startingCash);
    if (!(cash > 0)) throw new OrderError('Enter a starting balance greater than zero.');

    const id = U.uid('acct');
    const label = String(name || '').trim() || `Account ${ids.length + 1}`;
    state.portfolios[id] = newPortfolio(id, label, cash);
    state.accounts = ids.concat(id);
    return state.portfolios[id];
  }

  /** Close an account for good. The last one standing cannot be removed. */
  function removeAccount(state, id) {
    const ids = accountIds(state);
    if (id === 'ai' || !state.portfolios[id]) return false;
    if (ids.length <= 1) return false;
    delete state.portfolios[id];
    state.accounts = ids.filter((x) => x !== id);
    if (state.activeAccount === id) state.activeAccount = state.accounts[0];
    return true;
  }

  function renameAccount(state, id, name) {
    const pf = state.portfolios[id];
    const label = String(name || '').trim();
    if (!pf || id === 'ai' || !label) return false;
    pf.name = label.slice(0, 40);
    return true;
  }

  /** Wipe one account back to a starting balance, leaving the others alone. */
  function resetAccount(state, id, startingCash) {
    const pf = state.portfolios[id];
    if (!pf || id === 'ai') return false;
    const cash = money(startingCash != null ? startingCash : pf.startingCash);
    if (!(cash > 0)) return false;
    const fresh = newPortfolio(id, pf.name, cash);
    state.portfolios[id] = fresh;
    return true;
  }

  function newState(startingCash) {
    const now = Date.now();
    return {
      version: SCHEMA_VERSION,
      createdAt: now,
      startingCash: money(startingCash),
      /*
       * User accounts, in the order they are shown, alongside the AI's book.
       * The first one keeps the id 'user' so that every save written before
       * multiple accounts existed loads as an account rather than as nothing.
       */
      accounts: ['user'],
      activeAccount: 'user',
      portfolios: {
        user: newPortfolio('user', 'Main', startingCash),
        ai: newPortfolio('ai', 'AI Trader', startingCash),
      },
      watchlist: PT.defaultWatchlist.slice(),
      aiLog: [],
      // Chart annotations, keyed by symbol. See views: they live in (time,
      // price) so they survive timeframe changes.
      drawings: {},
      settings: {
        slippageEnabled: true,
        shortingEnabled: true,
        aiTraderEnabled: true,
        aiIntervalMs: 5000,
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
   * Cash already promised to resting buy limits. Without this a user can place
   * several limit buys that each pass on their own but cannot all be honoured,
   * and the losers would silently disappear when they later fail to fill.
   */
  /** Statuses that still hold cash or shares: resting, or waiting for the bell. */
  const LIVE_ORDER = new Set(['open', 'queued']);

  function committedCash(pf, exceptId) {
    let total = 0;
    for (const o of pf.orders) {
      if (!LIVE_ORDER.has(o.status) || o.side !== 'buy' || o.id === exceptId) continue;
      /*
       * A queued market buy has no limit price to reserve against, so it holds
       * what it was sized at. A dollar-sized one holds exactly its dollars,
       * which is what it will actually spend at the open.
       */
      total += o.notional != null ? o.notional : o.qty * (o.limitPrice ?? o.refPrice ?? 0);
    }
    return total;
  }

  /** Shares already promised to resting sell limits for one asset. */
  function committedQty(pf, assetId, exceptId) {
    let total = 0;
    for (const o of pf.orders) {
      if (!LIVE_ORDER.has(o.status) || o.side !== 'sell') continue;
      if (o.assetId !== assetId || o.id === exceptId) continue;
      total += o.qty;
    }
    return total;
  }

  /** Total current market value of every short position. */
  function shortExposure(pf, prices) {
    let total = 0;
    for (const id in pf.positions) {
      const p = pf.positions[id];
      if (p.qty >= 0) continue;
      const q = prices && prices[id];
      const price = q && isFinite(q.price) ? q.price : p.avgCost;
      total += Math.abs(p.qty) * price;
    }
    return total;
  }

  /** Collateral held against open shorts. */
  const shortCollateral = (pf, prices) => shortExposure(pf, prices) * SHORT_INITIAL_MARGIN;

  /**
   * Cash that is actually spendable: the balance, less money promised to
   * resting buy orders, less collateral held against short positions.
   */
  function availableCash(pf, prices) {
    return Math.max(0, pf.cash - committedCash(pf) - shortCollateral(pf, prices));
  }

  /** Long units of an asset that can be sold without opening a short. */
  function availableQty(pf, assetId) {
    const pos = pf.positions[assetId];
    if (!pos || pos.qty <= 0) return 0;
    return Math.max(0, pos.qty - committedQty(pf, assetId));
  }

  /**
   * Margin health. `ratio` is equity as a multiple of short exposure; below
   * SHORT_MAINTENANCE the account is in a call, below SHORT_FORCE_CLOSE the
   * engine buys the shorts back.
   */
  function marginStatus(pf, prices) {
    const exposure = shortExposure(pf, prices);
    if (exposure <= 0) return { exposure: 0, ratio: Infinity, level: 'none', equity: 0 };
    let invested = 0;
    for (const id in pf.positions) {
      const p = pf.positions[id];
      const q = prices && prices[id];
      const price = q && isFinite(q.price) ? q.price : p.avgCost;
      invested += p.qty * price;
    }
    const equity = pf.cash + invested;
    const ratio = equity / exposure;
    const level = ratio < SHORT_FORCE_RATIO ? 'liquidate'
      : ratio < SHORT_MAINTENANCE_RATIO ? 'call' : 'ok';
    return {
      exposure, ratio, level, equity,
      maintenance: exposure * SHORT_MAINTENANCE_RATIO,
      forceLevel: exposure * SHORT_FORCE_RATIO,
    };
  }

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

    /*
     * A closed equity session is no longer a rejection. The order is parked and
     * released at the next open, which is what a real broker does with an order
     * entered overnight. `allowQueue: false` opts out — the autonomous trader
     * uses that, since its decisions are made against a price it can see now.
     */
    const queued = kind !== 'crypto' && !ctx.marketOpen;
    if (queued && ctx.allowQueue === false) {
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
      // Floor, never round: sizing by dollars must not spend more than asked.
      qty = floorQty(notional / refPrice, kind);
    } else {
      qty = roundQty(Number(req.qty), kind);
    }
    if (!isFinite(qty) || qty <= 0) throw new OrderError('Enter a quantity greater than zero.');

    const estCost = qty * refPrice;
    if (estCost < MIN_NOTIONAL) {
      throw new OrderError(`Order value must be at least $${MIN_NOTIONAL}.`);
    }

    if (side === 'buy') {
      const pos = pf.positions[assetId];
      // Buying back a short releases collateral rather than consuming cash.
      const covering = pos && pos.qty < 0 ? Math.min(qty, Math.abs(pos.qty)) : 0;
      const free = availableCash(pf, ctx.prices) + covering * refPrice * (SHORT_INITIAL_MARGIN - 1);
      if (estCost > free + CASH_EPS) {
        const reserved = pf.cash - availableCash(pf, ctx.prices);
        throw new OrderError(reserved > CASH_EPS
          ? `Not enough free cash. Need ${U.fmtUSD(estCost)}, but ${U.fmtUSD(reserved)} is held against open orders and short positions.`
          : `Not enough cash. Need ${U.fmtUSD(estCost)}, available ${U.fmtUSD(free)}.`);
      }
    } else {
      const pos = pf.positions[assetId];
      const held = pos ? pos.qty : 0;
      const freeLong = availableQty(pf, assetId);

      if (qty > freeLong + QTY_EPS) {
        // The part beyond any long holding opens or increases a short.
        const shortQty = qty - Math.max(0, freeLong);

        if (held > 0 && freeLong < held) {
          throw new OrderError(
            `Only ${U.fmtQty(freeLong)} ${assetId} is free — the rest is committed to open sell orders.`,
          );
        }
        if (!ctx.shortingEnabled) {
          throw new OrderError(
            `You hold ${U.fmtQty(Math.max(0, held))} ${assetId}. Turn on short selling in Settings to sell more than you own.`,
          );
        }

        // Reg T: the new short's collateral must be covered by free cash plus
        // the proceeds the sale itself will generate.
        const addedExposure = shortQty * refPrice;
        const needed = addedExposure * SHORT_INITIAL_MARGIN;
        const willHave = availableCash(pf, ctx.prices) + addedExposure;
        if (needed > willHave + CASH_EPS) {
          const maxExposure = availableCash(pf, ctx.prices) / (SHORT_INITIAL_MARGIN - 1);
          throw new OrderError(
            `Not enough margin to short ${U.fmtQty(shortQty)} ${assetId}. `
            + `That needs ${U.fmtUSD(needed)} of collateral; you can short up to about `
            + `${U.fmtUSD(maxExposure)} of stock right now.`,
          );
        }
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
      status: queued ? 'queued' : 'open',
      // What the order was sized against, so a queued buy can reserve the right
      // amount of cash before there is a fill price to reserve against.
      refPrice,
      /*
       * Dollar-sized orders keep their dollar amount. A queued "$500 of AAPL"
       * re-derives its quantity from the opening price, so the user gets the
       * $500 of stock they asked for rather than a rejection because the gap up
       * made yesterday's share count unaffordable.
       */
      notional: req.notional != null && req.notional !== '' ? Number(req.notional) : null,
      queuedAt: queued ? (ctx.now ?? Date.now()) : null,
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
    const delta = order.side === 'buy' ? qty : -qty;

    const pos = pf.positions[order.assetId] || {
      qty: 0, avgCost: 0, realized: 0, kind, openedAt: ts,
    };
    const oldQty = pos.qty;
    const newQty = roundQty(oldQty + delta, kind);

    let realizedDelta = 0;
    let closedQty = 0;

    if (oldQty === 0 || (oldQty > 0 === newQty > 0 && Math.abs(newQty) > Math.abs(oldQty))) {
      /* Opening, or adding to, a position in the same direction. */
      const denom = Math.abs(newQty);
      pos.avgCost = denom > 0 ? (Math.abs(oldQty) * pos.avgCost + qty * price) / denom : price;
    } else if (newQty === 0 || oldQty > 0 === newQty > 0) {
      /* Reducing exposure. The average entry price is untouched. */
      closedQty = Math.abs(oldQty) - Math.abs(newQty);
      realizedDelta = oldQty > 0
        ? (price - pos.avgCost) * closedQty      // sold a long above/below cost
        : (pos.avgCost - price) * closedQty;     // covered a short below/above entry
    } else {
      /* Crossing through zero: close the old position, open the remainder. */
      closedQty = Math.abs(oldQty);
      realizedDelta = oldQty > 0
        ? (price - pos.avgCost) * closedQty
        : (pos.avgCost - price) * closedQty;
      pos.avgCost = price;
    }

    // Cash moves the same way regardless of direction: a sale credits, a
    // purchase debits — whether it opens, closes or reverses a position.
    if (order.side === 'buy') {
      const cost = money(gross);
      if (cost > pf.cash + CASH_EPS) throw new OrderError('Insufficient cash at fill time.');
      pf.cash = money(pf.cash - cost);
    } else {
      pf.cash = money(pf.cash + money(gross));
    }

    pos.qty = newQty;
    pos.kind = kind;
    if (!pos.openedAt) pos.openedAt = ts;
    if (realizedDelta) pos.realized = round(pos.realized + realizedDelta, 6);
    pf.realizedTotal = round((pf.realizedTotal || 0) + realizedDelta, 6);

    if (Math.abs(pos.qty) <= QTY_EPS) delete pf.positions[order.assetId];
    else pf.positions[order.assetId] = pos;

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
      realized: round(realizedDelta, 2),
      closed: closedQty > 0,
      // What this fill did to the book, for an honest history label.
      effect: oldQty === 0 ? (delta > 0 ? 'open long' : 'open short')
        : closedQty > 0 && Math.abs(newQty) < Math.abs(oldQty) && newQty !== 0 ? (oldQty > 0 ? 'reduce long' : 'reduce short')
          : newQty === 0 ? (oldQty > 0 ? 'close long' : 'cover short')
            : oldQty > 0 === newQty > 0 ? (newQty > 0 ? 'add long' : 'add short')
              : (newQty > 0 ? 'reverse to long' : 'reverse to short'),
      t: ts,
      reason: reason || order.note || null,
    };
    pf.fills.push(fill);
    if (pf.fills.length > 5000) {
      pf.fills.splice(0, pf.fills.length - 5000);
      // Reconstruction from the log is no longer exact once it is trimmed.
      pf.fillsTrimmed = true;
    }

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

    // Parked until the session opens — see buildOrder.
    if (order.status === 'queued') {
      pf.orders.push(order);
      return { order, fill: null, queued: true };
    }

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
    const rejected = [];
    const still = [];

    const released = [];

    for (const order of pf.orders) {
      if (!LIVE_ORDER.has(order.status)) continue;
      // Equities only fill during regular hours.
      if (order.kind !== 'crypto' && !ctx.marketOpen) { still.push(order); continue; }

      const q = ctx.prices[order.assetId];
      if (!q || !isFinite(q.price)) { still.push(order); continue; }

      /*
       * The bell has rung on an order entered while the market was shut. Market
       * orders go off at the opening print; limit orders simply join the book
       * and are matched by the same crossing test as everything else.
       */
      if (order.status === 'queued') {
        order.status = 'open';
        order.releasedAt = ts;
        released.push(order);

        if (order.type === 'market') {
          try {
            // Dollar-sized orders buy their dollars, not yesterday's share count.
            if (order.notional != null) {
              const sized = roundQty(order.notional / q.price, order.kind);
              if (sized > 0) order.qty = sized;
            }
            const price = effectivePrice(order.assetId, order.side, q.price, ctx.slippageEnabled);
            fills.push(applyFill(pf, order, price, ts, 'Queued order filled at the open'));
          } catch (e) {
            order.status = 'rejected';
            order.rejectedReason = e.message;
            order.rejectedAt = ts;
            rejected.push(order);
          }
          continue;
        }
      }

      if (!crosses(order, q.price)) { still.push(order); continue; }

      try {
        fills.push(applyFill(pf, order, marketableLimitPrice(order, q.price), ts, 'Limit order filled'));
      } catch (e) {
        // Conditions changed since the order rested. Keep it — an order that
        // silently disappears is worse than one that explains itself.
        order.status = 'rejected';
        order.rejectedReason = e.message;
        order.rejectedAt = ts;
        rejected.push(order);
      }
    }
    pf.orders = still;
    if (rejected.length) {
      pf.rejected = (pf.rejected || []).concat(rejected).slice(-50);
    }
    fills.rejected = rejected;
    fills.released = released;
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
    let longValue = 0, shortValue = 0, unrealized = 0, longCost = 0, stale = 0;
    const rows = [];

    for (const assetId in pf.positions) {
      const pos = pf.positions[assetId];
      const q = prices[assetId];
      const price = q && isFinite(q.price) ? q.price : pos.avgCost;
      if (!q || !isFinite(q.price)) stale++;

      const isShort = pos.qty < 0;
      const value = pos.qty * price;              // signed: negative for shorts
      const cost = pos.qty * pos.avgCost;         // signed
      const upl = value - cost;                   // (price - avgCost) * qty
      const basis = Math.abs(cost);

      if (isShort) shortValue += Math.abs(value); else { longValue += value; longCost += cost; }
      unrealized += upl;

      rows.push({
        assetId,
        kind: pos.kind,
        qty: pos.qty,
        side: isShort ? 'short' : 'long',
        isShort,
        avgCost: pos.avgCost,
        price,
        value,
        exposure: Math.abs(value),
        cost,
        unrealized: upl,
        unrealizedPct: basis > 0 ? (upl / basis) * 100 : 0,
        realized: pos.realized,
        dayChangePct: q ? q.changePct : null,
        dayChange: q && isFinite(q.changePct) ? value - value / (1 + q.changePct / 100) : null,
        stale: !q || !isFinite(q.price),
        openedAt: pos.openedAt,
      });
    }

    // Largest exposure first, so a big short ranks alongside a big long.
    rows.sort((a, b) => b.exposure - a.exposure);

    const equityForWeights = pf.cash + (longValue - shortValue);
    for (const r of rows) {
      r.weightPct = equityForWeights > 0 ? (r.exposure / equityForWeights) * 100 : 0;
    }

    const realizedTotal = pf.realizedTotal || 0;
    const invested = longValue - shortValue;      // net market exposure
    const equity = pf.cash + invested;
    const collateral = shortValue * SHORT_INITIAL_MARGIN;
    const free = Math.max(0, pf.cash - committedCash(pf) - collateral);

    return {
      cash: pf.cash,
      // What is actually deployed into positions, long side only — this is the
      // figure the cash-vs-invested split is about.
      invested: longValue,
      longValue,
      shortValue,
      netExposure: invested,
      costBasis: longCost,
      unrealized,
      unrealizedPct: Math.abs(longCost) > 0 ? (unrealized / Math.abs(longCost)) * 100 : 0,
      realized: realizedTotal,
      equity,
      // Money the user can actually deploy right now.
      buyingPower: free,
      reserved: pf.cash - free,
      shortCollateral: collateral,
      uninvested: Math.max(0, pf.cash - collateral),
      investedPct: equity > 0 ? (longValue / equity) * 100 : 0,
      cashPct: equity > 0 ? ((equity - longValue + shortValue) / equity) * 100 : 100,
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
    /*
     * Only anchor against a fully priced book. At startup the feed is empty and
     * `valuate` falls back to cost basis, so anchoring there would bake the
     * entire lifetime gain into "today" — and then persist that wrong baseline.
     */
    const trustworthy = val.staleCount === 0;
    if (!pf.dayBaseline || pf.dayBaseline.etDate !== etDate) {
      if (!trustworthy) {
        return { change: 0, changePct: 0, baseline: val.equity, since: Date.now(), pending: true };
      }
      pf.dayBaseline = { etDate, equity: val.equity, t: Date.now() };
    }
    const base = pf.dayBaseline.equity;
    const change = val.equity - base;
    return {
      change,
      changePct: base > 0 ? (change / base) * 100 : 0,
      baseline: base,
      since: pf.dayBaseline.t,
      pending: false,
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
    // A closing fill is any fill that reduced exposure — selling a long or
    // buying back a short both realise P&L.
    const closers = pf.fills.filter((f) => (f.closed != null ? f.closed : f.side === 'sell'));
    const sells = pf.fills.filter((f) => f.side === 'sell');
    const wins = closers.filter((f) => f.realized > 0).length;
    const losses = closers.filter((f) => f.realized < 0).length;
    const decided = wins + losses;

    const grossWin = closers.reduce((s, f) => s + Math.max(0, f.realized), 0);
    const grossLoss = closers.reduce((s, f) => s + Math.max(0, -f.realized), 0);

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
      closed: closers.length,
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

  /* ------------------------------------------------------- reconciliation */

  const finite = (v) => typeof v === 'number' && isFinite(v);

  /**
   * Rebuild cash, positions and realised P&L from the fill log alone.
   *
   * The fill log is the account's source of truth: every row records side,
   * quantity, price and notional. As long as it has not been trimmed, the whole
   * book can be derived from it exactly.
   */
  function reconstruct(pf) {
    let cash = pf.startingCash;
    let realized = 0;
    const positions = {};

    for (const f of pf.fills) {
      if (!finite(f.qty) || !finite(f.price)) continue;
      const notional = finite(f.notional) ? f.notional : f.qty * f.price;
      const kind = f.kind || PT.assetKind(f.assetId);
      const pos = positions[f.assetId] || { qty: 0, avgCost: 0, realized: 0, kind, openedAt: f.t };

      const delta = f.side === 'buy' ? f.qty : -f.qty;
      const oldQty = pos.qty;
      const newQty = roundQty(oldQty + delta, kind);
      cash += f.side === 'buy' ? -notional : notional;

      if (oldQty === 0 || (oldQty > 0 === newQty > 0 && Math.abs(newQty) > Math.abs(oldQty))) {
        const denom = Math.abs(newQty);
        pos.avgCost = denom > 0 ? (Math.abs(oldQty) * pos.avgCost + f.qty * f.price) / denom : f.price;
      } else if (newQty === 0 || oldQty > 0 === newQty > 0) {
        const closed = Math.abs(oldQty) - Math.abs(newQty);
        const gain = oldQty > 0 ? (f.price - pos.avgCost) * closed : (pos.avgCost - f.price) * closed;
        pos.realized = round(pos.realized + gain, 6);
        realized += gain;
      } else {
        const closed = Math.abs(oldQty);
        const gain = oldQty > 0 ? (f.price - pos.avgCost) * closed : (pos.avgCost - f.price) * closed;
        pos.realized = round(pos.realized + gain, 6);
        realized += gain;
        pos.avgCost = f.price;
      }
      pos.qty = newQty;
      positions[f.assetId] = pos;
    }

    for (const id in positions) if (Math.abs(positions[id].qty) <= 1e-9) delete positions[id];
    return { cash: money(cash), positions, realizedTotal: round(realized, 6) };
  }

  /**
   * Detect and repair a corrupted book.
   *
   * `round()` returns 0 for anything non-finite, so a single bad value — a
   * partial write, an interrupted save — silently zeroes the balance and every
   * subsequent order is rejected for insufficient funds. Rather than leave the
   * account bricked, rebuild it from the fill log.
   */
  function audit(pf) {
    const problems = [];
    if (!finite(pf.cash)) problems.push(`cash was ${JSON.stringify(pf.cash)}`);
    else if (pf.cash < -0.005) problems.push(`cash was negative (${pf.cash})`);
    if (!finite(pf.startingCash) || pf.startingCash <= 0) problems.push('starting balance was invalid');
    for (const id in pf.positions) {
      const p = pf.positions[id];
      if (!p || !finite(p.qty) || p.qty === 0) problems.push(`${id} had an invalid quantity`);
      else if (!finite(p.avgCost) || p.avgCost <= 0) problems.push(`${id} had an invalid cost basis`);
    }
    if (!finite(pf.realizedTotal)) problems.push('realised P&L was invalid');
    return problems;
  }

  /**
   * Repair in place. Returns a report describing what changed, or null when the
   * book was already sound.
   */
  function repair(pf, { force = false } = {}) {
    const problems = audit(pf);
    if (!problems.length && !force) return null;

    const before = { cash: pf.cash, positions: Object.keys(pf.positions).length };

    if (!finite(pf.startingCash) || pf.startingCash <= 0) pf.startingCash = 10000;

    if (pf.fillsTrimmed) {
      /*
       * History is incomplete, so the log cannot reproduce the book exactly.
       * Do the least-destructive thing: make every field valid and leave the
       * rest alone.
       */
      if (!finite(pf.cash) || pf.cash < 0) pf.cash = 0;
      for (const id in pf.positions) {
        const p = pf.positions[id];
        if (!p || !finite(p.qty) || p.qty === 0 || !finite(p.avgCost) || p.avgCost <= 0) delete pf.positions[id];
      }
      if (!finite(pf.realizedTotal)) {
        pf.realizedTotal = pf.fills.reduce((s, f) => s + (finite(f.realized) ? f.realized : 0), 0);
      }
      return { problems, method: 'clamped', exact: false, before, after: { cash: pf.cash, positions: Object.keys(pf.positions).length } };
    }

    const rebuilt = reconstruct(pf);
    pf.cash = rebuilt.cash;
    pf.positions = rebuilt.positions;
    pf.realizedTotal = rebuilt.realizedTotal;
    return {
      problems, method: 'rebuilt', exact: true, before,
      after: { cash: pf.cash, positions: Object.keys(pf.positions).length },
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
      if (!parsed.portfolios || !parsed.portfolios.user || !parsed.portfolios.ai) return null;

      /*
       * Saves written before multiple accounts existed have no account list.
       * Their single book keeps its id and simply becomes the first account —
       * nothing is copied, moved or renamed, so no history can be lost here.
       */
      if (!Array.isArray(parsed.accounts) || !parsed.accounts.length) {
        parsed.accounts = ['user'];
      }
      parsed.accounts = parsed.accounts.filter((id) => id !== 'ai' && parsed.portfolios[id]);
      if (!parsed.accounts.length) parsed.accounts = ['user'];
      if (!parsed.portfolios[parsed.activeAccount] || parsed.activeAccount === 'ai') {
        parsed.activeAccount = parsed.accounts[0];
      }

      // Defensive: fill in anything a partial write may have lost.
      for (const id of parsed.accounts.concat('ai')) {
        const pf = parsed.portfolios && parsed.portfolios[id];
        if (!pf) return null;
        if (!pf.name) pf.name = id === 'ai' ? 'AI Trader' : 'Main';
        pf.positions = pf.positions || {};
        pf.orders = pf.orders || [];
        pf.fills = pf.fills || [];
        pf.rejected = pf.rejected || [];
        pf.equity = pf.equity || [];
        pf.counters = pf.counters || { orders: pf.orders.length };
        // Books written before the running total existed: seed it from history.
        if (typeof pf.realizedTotal !== 'number') {
          pf.realizedTotal = pf.fills.reduce((s, f) => s + (f.realized || 0), 0);
        }
        // Never load a bricked account: rebuild it from the fill log instead.
        const fixed = repair(pf);
        if (fixed) {
          parsed.repairs = parsed.repairs || [];
          parsed.repairs.push({ portfolio: id, ...fixed });
          console.warn(`[PT] repaired ${id} portfolio:`, fixed.problems.join('; '));
        }
      }
      parsed.watchlist = parsed.watchlist || PT.defaultWatchlist.slice();
      parsed.aiLog = parsed.aiLog || [];
      parsed.drawings = parsed.drawings || {};
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
      /*
       * Only a quota failure justifies destroying history. Storage can throw
       * for other reasons (private browsing disables it entirely), and shedding
       * trade history on every save in that case would be far worse than the
       * write simply not happening.
       */
      const isQuota = e && (e.name === 'QuotaExceededError'
        || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
      if (!isQuota) {
        console.warn('[PT] could not persist state', e && e.message);
        return false;
      }
      const now = Date.now();
      for (const id of accountIds(state).concat('ai')) {
        const pf = state.portfolios[id];
        if (!pf) continue;
        pf.equity = pruneEquity(pf.equity, now).filter((s) => now - s.t < 30 * 86400e3);
        if (pf.fills.length > 1000) { pf.fills = pf.fills.slice(-1000); pf.fillsTrimmed = true; }
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
    accountIds, activeAccount, setActiveAccount, addAccount, removeAccount,
    renameAccount, resetAccount, MAX_ACCOUNTS,
    cancelOrder, crosses, effectivePrice, valuate, dayPnl, stats,
    audit, repair, reconstruct,
    availableCash, availableQty, committedCash, committedQty, CASH_EPS,
    shortExposure, shortCollateral, marginStatus,
    SHORT_INITIAL_MARGIN, SHORT_MAINTENANCE_RATIO, SHORT_FORCE_RATIO,
    sampleEquity, pruneEquity, load, save, clear,
  };
})(window.PT);
