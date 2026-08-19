/* =========================================================================
   Live market data feed.

   Crypto streams straight from Coinbase's public WebSocket in the browser —
   real trade prints, several per second. Equities are polled through this
   app's own server, because Yahoo Finance sends no CORS headers and cannot be
   called from a page.

   The feed never invents a price. Each quote carries the source that produced
   it and a freshness grade, and the UI is expected to show both.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const CB_WS = 'wss://ws-feed.exchange.coinbase.com';

  /** A tick older than this is no longer "live". */
  const STALE_AFTER = { crypto: 25000, stock: 90000 };

  const bus = U.emitter();

  const state = {
    prices: Object.create(null),  // assetId -> quote
    watched: new Set(),
    focus: null,
    started: false,
    ws: null,
    wsState: 'idle',              // idle | connecting | open | closed | failed
    wsAttempts: 0,
    openedAt: 0,
    wsSubscribed: new Set(),
    lastStockPoll: 0,
    stockPollInFlight: false,
    lastFocusPoll: 0,
    focusPollInFlight: false,
    serverUp: true,
    counters: { ticks: 0, polls: 0, wsReconnects: 0 },
    // Has a first fetch completed for each asset class? Before it has, "no
    // data" is misleading — nothing has been asked for yet.
    ready: { stock: false, crypto: false },
  };

  /* --------------------------------------------------------------- quotes */

  function applyQuote(assetId, patch) {
    const prev = state.prices[assetId];
    const next = Object.assign({}, prev, patch, { assetId, t: patch.t || Date.now() });

    // Direction of the last print, used by the UI for the tick flash.
    if (prev && isFinite(prev.price) && isFinite(next.price)) {
      next.tickDir = next.price > prev.price ? 1 : next.price < prev.price ? -1 : 0;
      next.prevPrice = prev.price;
    } else {
      next.tickDir = 0;
    }
    state.prices[assetId] = next;
    bus.emit('tick', next);
    return next;
  }

  /** Freshness grade for a quote, recomputed on read rather than stored. */
  function grade(q, assetId) {
    /*
     * Distinguish "nothing has been fetched yet" from "we asked and got
     * nothing". A quote record that exists but carries no usable price means
     * the provider answered without one; no record at all, before the first
     * cycle has completed, just means we have not asked yet.
     */
    if (!q) {
      const kind = PT.assetKind(assetId);
      return state.ready[kind === 'crypto' ? 'crypto' : 'stock'] ? 'none' : 'loading';
    }
    if (!isFinite(q.price)) return 'none';
    if (q.quality === 'delayed') return 'delayed';
    if (q.quality === 'cached') return 'cached';
    const kind = PT.assetKind(q.assetId);
    const limit = kind === 'crypto' ? STALE_AFTER.crypto : STALE_AFTER.stock;
    // Judge against the exchange's own stamp when we have it: polling a closed
    // market every 12s keeps `t` fresh while the price itself is hours old.
    const stamp = isFinite(q.quoteTime) && q.quoteTime > 0 ? q.quoteTime : q.t;
    if (Date.now() - stamp > limit) return 'stale';
    return 'live';
  }

  /* ----------------------------------------------------- coinbase socket */

  const cryptoProducts = () => {
    const ids = [];
    for (const id of state.watched) {
      const a = PT.byId[id];
      if (a && a.kind === 'crypto' && a.cb) ids.push(a.cb);
    }
    return ids;
  };

  const productToSymbol = (pid) => String(pid).replace(/-USD$/, '');

  /**
   * Map a Coinbase `ticker` frame onto our quote shape.
   * Returns null for anything that is not a usable ticker for a known asset —
   * heartbeats, subscription acks, and products outside our universe.
   */
  function parseCoinbaseTicker(m) {
    if (!m || m.type !== 'ticker' || !m.product_id) return null;
    const symbol = productToSymbol(m.product_id);
    if (!PT.byId[symbol]) return null;

    const price = parseFloat(m.price);
    if (!isFinite(price)) return null;
    const open = parseFloat(m.open_24h);
    const change = isFinite(open) ? price - open : null;

    return {
      symbol,
      quote: {
        price,
        prevClose: isFinite(open) ? open : null,
        change,
        changePct: isFinite(open) && open > 0 ? (change / open) * 100 : null,
        dayHigh: parseFloat(m.high_24h) || null,
        dayLow: parseFloat(m.low_24h) || null,
        volume: parseFloat(m.volume_24h) || null,
        bid: parseFloat(m.best_bid) || null,
        ask: parseFloat(m.best_ask) || null,
        source: 'coinbase-ws',
        quality: 'live',
        t: m.time ? Date.parse(m.time) : Date.now(),
      },
    };
  }

  function connectWS() {
    if (state.ws || !state.started) return;
    const products = cryptoProducts();
    if (!products.length) return;

    state.wsState = 'connecting';
    bus.emit('status', snapshotStatus());

    let ws;
    try {
      ws = new WebSocket(CB_WS);
    } catch (e) {
      console.warn('[feed] websocket unavailable', e);
      state.wsState = 'failed';
      return scheduleReconnect();
    }
    state.ws = ws;

    ws.onopen = () => {
      state.wsState = 'open';
      state.openedAt = Date.now();
      state.ready.crypto = true;
      // Re-read the watched set: it may have changed during the handshake.
      const current = cryptoProducts();
      state.wsSubscribed = new Set(current);
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: current, channels: ['ticker'] }));
      bus.emit('status', snapshotStatus());
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'error') {
        console.warn('[feed] coinbase error', m.message);
        return;
      }
      const parsed = parseCoinbaseTicker(m);
      if (!parsed) return;
      state.counters.ticks++;
      applyQuote(parsed.symbol, parsed.quote);
    };

    ws.onclose = () => {
      state.ws = null;
      if (state.wsState !== 'idle') {
        state.wsState = 'closed';
        bus.emit('status', snapshotStatus());
        scheduleReconnect();
      }
    };

    ws.onerror = () => { try { ws.close(); } catch { /* already gone */ } };
  }

  function scheduleReconnect() {
    if (!state.started) return;
    /*
     * Reset the backoff only after a connection proved stable. Resetting on
     * `open` defeats it entirely for a socket that connects and immediately
     * drops: every cycle would restart at ~1s, hammering the endpoint.
     */
    if (state.openedAt && Date.now() - state.openedAt > 60000) state.wsAttempts = 0;
    state.openedAt = 0;
    state.wsAttempts++;
    state.counters.wsReconnects++;
    // Exponential backoff with jitter, capped at 30s.
    const base = Math.min(30000, 1000 * 2 ** Math.min(5, state.wsAttempts - 1));
    const delay = base * (0.7 + Math.random() * 0.6);
    setTimeout(() => { if (!state.ws && state.started) connectWS(); }, delay);
    // While the socket is down, keep crypto alive over REST.
    pollCrypto();
  }

  /**
   * Reconcile the socket's subscriptions against what is actually watched.
   *
   * Called both on watchlist changes and periodically, because a change that
   * lands mid-handshake has nowhere to go: `connectWS` is a no-op while a
   * socket is pending, and `onopen` sends the product list captured before the
   * change. Reconciling against `cryptoProducts()` on every open — and again on
   * a timer — means a dropped change repairs itself.
   */
  function syncSubscriptions() {
    const want = new Set(cryptoProducts());
    if (!state.ws || state.wsState !== 'open') {
      // Not connected (or still handshaking): connectWS is idempotent, and
      // onopen reads the live watched set rather than a stale capture.
      connectWS();
      return;
    }

    const add = [...want].filter((p) => !state.wsSubscribed.has(p));
    const remove = [...state.wsSubscribed].filter((p) => !want.has(p));
    if (!add.length && !remove.length) return;
    try {
      if (add.length) state.ws.send(JSON.stringify({ type: 'subscribe', product_ids: add, channels: ['ticker'] }));
      if (remove.length) state.ws.send(JSON.stringify({ type: 'unsubscribe', product_ids: remove, channels: ['ticker'] }));
    } catch { return; }
    state.wsSubscribed = want;
  }

  /* --------------------------------------------------------- REST polling */

  async function api(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Crypto over REST — the fallback path when the socket cannot connect. */
  async function pollCrypto() {
    const ids = [...state.watched].filter((id) => PT.isCrypto(id));
    if (!ids.length) return;
    try {
      const j = await api(`/api/quotes?crypto=${encodeURIComponent(ids.join(','))}&ttl=4000`);
      state.ready.crypto = true;
      for (const id in j.quotes) {
        const q = j.quotes[id];
        /*
         * Coinbase's ticker channel only emits on trades, so a quiet product
         * can sit blank for minutes after subscribing. Fill it from REST, but
         * never overwrite a price the socket has already delivered.
         */
        const existing = state.prices[id];
        if (state.wsState === 'open' && existing && existing.source === 'coinbase-ws') continue;
        applyQuote(id, { ...q, t: Date.now() });
      }
      state.serverUp = true;
    } catch (e) {
      state.serverUp = false;
      bus.emit('status', snapshotStatus());
    }
  }

  /**
   * Poll interval for equities. Deliberately conservative: Yahoo bans an IP for
   * minutes after a burst, and a closed market has nothing new to say.
   */
  /** True when a watched coin still has no price at all. */
  function cryptoAwaitingPrice() {
    for (const id of state.watched) {
      if (!PT.isCrypto(id)) continue;
      const q = state.prices[id];
      if (!q || !isFinite(q.price)) return true;
    }
    return false;
  }

  function stockInterval() {
    const s = PT.calendar.stockStatus();
    if (s.phase === 'open') return 12000;
    if (s.phase === 'pre' || s.phase === 'after') return 30000;
    return 120000;
  }

  /**
   * Poll interval for the symbol the user is actually looking at.
   *
   * Yahoo tolerates roughly one request every 2.5s per host, so a dedicated
   * lane for one symbol is affordable where polling the whole watchlist that
   * fast is not — and it is the quote that matters while you are sizing a trade.
   */
  function focusInterval() {
    const s = PT.calendar.stockStatus();
    if (s.phase === 'open') return 4000;
    if (s.phase === 'pre' || s.phase === 'after') return 20000;
    return 120000;
  }

  /** Refresh just the focused equity, faster than the watchlist sweep. */
  async function pollFocused() {
    const id = state.focus;
    if (!id || PT.isCrypto(id) || state.focusPollInFlight) return;
    if (Date.now() - state.lastFocusPoll < focusInterval()) return;

    state.focusPollInFlight = true;
    state.lastFocusPoll = Date.now();
    try {
      const j = await api(`/api/quotes?stocks=${encodeURIComponent(id)}&ttl=2500`);
      state.counters.polls++;
      state.ready.stock = true;
      for (const sym in j.quotes) applyQuote(sym, { ...j.quotes[sym], t: Date.now() });
      state.serverUp = true;
    } catch {
      state.serverUp = false;
    } finally {
      state.focusPollInFlight = false;
    }
  }

  async function pollStocks(force) {
    const ids = [...state.watched].filter((id) => !PT.isCrypto(id));
    if (!ids.length || state.stockPollInFlight) return;
    const interval = stockInterval();
    if (!force && Date.now() - state.lastStockPoll < interval) return;

    state.stockPollInFlight = true;
    state.lastStockPoll = Date.now();
    try {
      // Server-side TTL matches our cadence so repeat callers share one upstream hit.
      const ttl = Math.max(4000, interval - 2000);
      const j = await api(`/api/quotes?stocks=${encodeURIComponent(ids.join(','))}&ttl=${ttl}`);
      state.counters.polls++;
      state.ready.stock = true;
      for (const id in j.quotes) {
        // `t` is when we fetched; `quoteTime` is when the market printed it.
        // Keeping both lets grade() tell a fresh poll of a stale price apart
        // from a genuinely live one.
        applyQuote(id, { ...j.quotes[id], t: Date.now() });
      }
      state.lastErrors = j.errors || {};
      state.serverUp = true;
    } catch (e) {
      state.serverUp = false;
    } finally {
      state.stockPollInFlight = false;
      bus.emit('status', snapshotStatus());
      bus.emit('quotes', state.prices);
    }
  }

  /* --------------------------------------------------------------- candles */

  const candleCache = new Map(); // `${assetId}:${tf}` -> { bars, at, source }

  /** Bar width in ms for each timeframe, used to roll live ticks into candles. */
  const TF_MS = {
    '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '1D': 86400e3, '1W': 604800e3,
  };

  async function candles(assetId, tf, { force = false } = {}) {
    const key = `${assetId}:${tf}`;
    const hit = candleCache.get(key);
    const maxAge = Math.min(300000, (TF_MS[tf] || 60e3) / 2);
    if (!force && hit && Date.now() - hit.at < maxAge) return hit;

    const j = await api(`/api/candles?asset=${encodeURIComponent(assetId)}&tf=${encodeURIComponent(tf)}`);
    if (j.error) throw new Error(j.error);
    const entry = { bars: j.bars, at: Date.now(), source: j.source, quality: j.quality, tf, assetId };
    candleCache.set(key, entry);
    return entry;
  }

  /**
   * Fold a live price into the newest candle so the chart moves with the tape,
   * extending the series into a new bar when the interval rolls over.
   */
  function applyTickToBars(bars, tf, price, ts) {
    if (!bars || !bars.length || !isFinite(price)) return false;
    const width = TF_MS[tf];
    if (!width) return false;
    const last = bars[bars.length - 1];

    /*
     * Anchor the grid on the series itself, not on the epoch. Hourly equity
     * bars start at the 09:30 ET open, so they sit at :30 past the hour and are
     * never a multiple of 3600e3; an epoch-aligned bucket would drop half of
     * each hour's ticks and then invent bars on the wrong grid. Weekly bars
     * have the same problem (Monday-anchored vs the epoch's Thursday).
     */
    const elapsed = ts - last.t;
    if (elapsed < 0) return false;              // a print older than the last bar
    if (elapsed < width) {                      // still inside the current bar
      last.c = price;
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
      return true;
    }

    const steps = Math.floor(elapsed / width);
    const bucket = last.t + steps * width;
    bars.push({ t: bucket, o: price, h: price, l: price, c: price, v: 0 });
    if (bars.length > 1500) bars.shift();
    return true;
  }

  /* ---------------------------------------------------------------- search */

  async function search(q) {
    try { return await api(`/api/search?q=${encodeURIComponent(q)}`); }
    catch { return { results: [], source: 'offline' }; }
  }

  /* ---------------------------------------------------------------- status */

  function snapshotStatus() {
    const cal = PT.calendar.stockStatus();
    return {
      market: cal,
      ws: state.wsState,
      wsProducts: state.wsSubscribed.size,
      serverUp: state.serverUp,
      counters: { ...state.counters },
      ready: { ...state.ready },
      cryptoLive: state.wsState === 'open',
    };
  }

  /* ------------------------------------------------------------ lifecycle */

  let timer = null;

  function start() {
    if (state.started) return;
    state.started = true;
    connectWS();
    pollCrypto();
    pollStocks(true);
    timer = setInterval(() => {
      pollStocks(false);
      pollFocused();
      // Repair any subscription drift (e.g. a change made mid-handshake).
      if (state.wsState === 'open') syncSubscriptions();
      // Top up over REST while the socket is down, or for coins it has not
      // priced yet because they simply have not traded.
      if (state.wsState !== 'open' || cryptoAwaitingPrice()) pollCrypto();
      bus.emit('status', snapshotStatus());
    }, 5000);

    // Reconnect promptly when the tab comes back or the network returns.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (state.wsState !== 'open') connectWS();
        pollStocks(true);
      }
    });
    window.addEventListener('online', () => { connectWS(); pollStocks(true); });
  }

  function stop() {
    state.started = false;
    state.wsState = 'idle';
    clearInterval(timer);
    if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } state.ws = null; }
  }

  function watch(ids) {
    let changed = false;
    for (const id of ids) {
      if (!state.watched.has(id) && PT.byId[id]) { state.watched.add(id); changed = true; }
    }
    if (changed && state.started) {
      syncSubscriptions();
      pollStocks(true);
      pollCrypto();
    }
    return changed;
  }

  function unwatch(id) {
    if (state.watched.delete(id) && state.started) syncSubscriptions();
  }

  const setFocus = (id) => {
    state.focus = id;
    // Refresh the newly focused symbol immediately rather than waiting for the
    // next sweep — this is the quote the user is about to trade against.
    state.lastFocusPoll = 0;
    if (state.started) pollFocused();
  };

  /** Resolves once the first quote cycle has completed (or after `timeout`). */
  function whenReady(timeout = 20000) {
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if ((state.ready.stock && state.ready.crypto) || Date.now() - started > timeout) resolve();
        else setTimeout(check, 300);
      };
      check();
    });
  }
  const price = (id) => (state.prices[id] ? state.prices[id].price : null);
  const quote = (id) => state.prices[id] || null;

  PT.feed = {
    start, stop, watch, unwatch, setFocus, candles, search,
    applyTickToBars, applyQuote, grade, price, quote, parseCoinbaseTicker, whenReady,
    get prices() { return state.prices; },
    get status() { return snapshotStatus(); },
    get watched() { return state.watched; },
    on: bus.on,
    TF_MS,
  };
})(window.PT);
