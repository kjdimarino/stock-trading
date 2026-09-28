/* =========================================================================
   Bootstrap and the run loop.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const UI = PT.ui;
  const E = PT.engine;
  const A = PT.app;
  const V = PT.views;
  const { S, R } = A;

  /* ------------------------------------------------------------ run loop */

  let lastRender = 0;
  let lastEquitySample = 0;

  /*
   * At the bell the newest quote on hand for a stock is still the last
   * pre-market poll — for Yahoo, the prior close — until the next poll lands.
   * Releasing a queued order against it would fill at that stale price and
   * hand out the overnight gap. So while an account has an order waiting on
   * the open, the stock is left out of the prices its orders see until a quote
   * printed after today's open arrives.
   */
  const OFF_HOURS = new Set(['PRE', 'PREPRE', 'POST', 'POSTPOST', 'CLOSED']);
  function orderPrices(pf, px, now) {
    let out = null, openTs = null;
    for (const o of pf.orders) {
      const q = px[o.assetId];
      if (o.status !== 'queued' || !q || PT.isCrypto(o.assetId)) continue;
      if (openTs == null) {
        if (!PT.calendar.stockStatus(now).isOpen) return px;
        const et = PT.calendar.inET(now);
        openTs = PT.calendar.fromET(et.y, et.m, et.d, 9, 30);
      }
      const stamp = q.quoteTime || q.fetchedAt || q.t;
      if (!OFF_HOURS.has(q.marketState) && stamp >= openTs) continue;
      if (!out) out = Object.assign(Object.create(null), px);
      delete out[o.assetId];
    }
    return out || px;
  }

  /** True when any account, or the AI, has a live order on this symbol. */
  function hasOrderOn(assetId) {
    for (const id of E.accountIds(S.st).concat('ai')) {
      const pf = S.st.portfolios[id];
      if (pf && pf.orders.some((o) => o.assetId === assetId)) return true;
    }
    return false;
  }

  function processOrders(now) {
    const px = A.prices();

    /*
     * Resting and queued orders for every open account plus the AI's. An order
     * left on an account the user is not looking at must still fill — the whole
     * point of a resting order is that it works while you are elsewhere.
     */
    const activeId = S.st.activeAccount;
    for (const id of E.accountIds(S.st).concat('ai')) {
      const pf = S.st.portfolios[id];
      if (!pf || !pf.orders.length) continue;
      const fills = E.processOpenOrders(pf, {
        prices: orderPrices(pf, px, now),
        // Each order's own asset class decides whether it may fill.
        marketOpen: PT.calendar.stockStatus(now).isOpen,
        slippageEnabled: S.st.settings.slippageEnabled,
        shortingEnabled: S.st.settings.shortingEnabled !== false,
        now,
      });
      for (const f of fills) {
        if (id !== 'ai') {
          const atOpen = /at the open/.test(f.reason || '');
          const where = id === activeId ? '' : ` · ${pf.name}`;
          UI.toast({
            kind: f.side,
            title: `${atOpen ? 'Filled at the open' : 'Limit filled'}: ${f.side} ${U.fmtQty(f.qty)} ${f.assetId}${where}`,
            message: `at ${U.fmtUSD(f.price)}` + (f.closed ? ` · realized ${U.fmtSigned(f.realized)}` : ''),
          });
        }
      }
      // An order that could not fill must say so; silently vanishing is worse.
      for (const r of (fills.rejected || [])) {
        if (id !== 'ai') {
          UI.toast({
            kind: 'error',
            title: `Order could not fill: ${r.side} ${U.fmtQty(r.qty)} ${r.assetId}`
              + (id === activeId ? '' : ` · ${pf.name}`),
            message: r.rejectedReason,
            timeout: 9000,
          });
        }
      }
      if (fills.length || (fills.rejected && fills.rejected.length)) A.save();
    }
  }

  function tickLoop() {
    const now = Date.now();
    const px = A.prices();

    // Keep a price on everything an order, a holding or the chart depends on.
    PT.feed.watch([...A.neededSymbols()]);
    A.checkWriter();

    // Orders, equity samples and margin are worked by the one tab that saves.
    // Another tab doing it to its own copy of the book would do it twice.
    if (A.isWriter()) {
      processOrders(now);
      sampleEquity(now, px);
      checkMargin(now, px);
    }

    /* Chrome refresh, throttled — price cells update on their own via ticks. */
    if (!document.hidden && now - lastRender > 250) {
      lastRender = now;
      V.renderTopbar();
      V.renderStatusbar();
      if (S.view === 'trade') {
        V.renderSymbolHeader();
        if (S.blotterTab !== 'history') V.renderBlotter();
      } else if (S.view === 'portfolio') V.refreshPortfolioValues();
    }

    /*
     * A timer, not requestAnimationFrame: animation frames stop outright in a
     * hidden tab, and resting orders have to keep working while you are
     * elsewhere. Timers there only slow down.
     */
    setTimeout(tickLoop, 100);
  }

  function sampleEquity(now, px) {
    /*
     * Equity curve sampling for every account and the AI.
     *
     * Only sample a fully priced book. At startup the feed is empty, so
     * `valuate` values positions at cost basis — sampling that would write a
     * false trough into the persisted curve on every page load and invent a
     * drawdown that never happened.
     */
    if (now - lastEquitySample > 10000) {
      let sampled = false;
      for (const id of E.accountIds(S.st).concat('ai')) {
        const pf = S.st.portfolios[id];
        if (!pf) continue;
        const v = E.valuate(pf, px);
        if (v.staleCount > 0) continue;
        E.sampleEquity(pf, v.equity, now);
        sampled = true;
      }
      if (sampled) { lastEquitySample = now; A.save(); }
    }
  }

  /**
   * A short can lose more than it cost to open, so the account is checked every
   * pass. Below the maintenance level the user is warned; below the hard floor
   * the engine buys the shorts back, exactly as a broker would, and says so.
   */
  /*
   * Per account, because a short on an account you are not looking at can still
   * lose more than that account can cover, and a single shared flag would let
   * one account's healthy state suppress another's margin call.
   */
  const lastMarginLevel = Object.create(null);
  const lastBuyIn = Object.create(null);
  function checkMargin(now, px) {
    for (const id of E.accountIds(S.st)) checkAccountMargin(S.st.portfolios[id], id, px, now);
  }

  function checkAccountMargin(pf, id, px, now) {
    if (!pf) return;
    // Judge only shorts the feed has priced: before it lands they sit at cost,
    // and a warning or a buy-in on made-up numbers is worse than none.
    for (const assetId in pf.positions) {
      const q = px[assetId];
      if (pf.positions[assetId].qty < 0 && !(q && q.price > 0)) return;
    }
    const active = id === S.st.activeAccount;
    const where = active ? '' : ` · ${pf.name}`;
    const m = E.marginStatus(pf, px);
    if (m.level === 'none') { lastMarginLevel[id] = 'ok'; return; }

    if (m.level === 'liquidate') {
      // A buy-in that failed is retried, but not on every 100ms pass.
      if (now - (lastBuyIn[id] || 0) < 10000) return;
      lastBuyIn[id] = now;
      const shorts = E.valuate(pf, px).positions.filter((p) => p.isShort);
      for (const pos of shorts) {
        try {
          const r = E.submitOrder(pf, {
            assetId: pos.assetId, side: 'buy', type: 'market', qty: Math.abs(pos.qty),
            reason: 'Forced buy-in: margin fell below the maintenance floor',
          }, { ...A.orderCtx(pos.assetId), marketOpen: true });
          UI.toast({
            kind: 'error',
            title: `Forced buy-in: ${pos.assetId}${where}`,
            message: `Your short lost more than the account could cover, so it was bought back at `
              + `${U.fmtUSD(r.fill.price)} (${U.fmtSigned(r.fill.realized)}). This is what a broker would do.`,
            timeout: 15000,
          });
        } catch (e) { console.warn('[margin] could not buy in', pos.assetId, e.message); }
      }
      A.save();
      lastMarginLevel[id] = 'liquidate';
      return;
    }

    if (m.level === 'call' && lastMarginLevel[id] !== 'call') {
      UI.toast({
        kind: 'warn',
        title: `Margin call on your short positions${where}`,
        message: `Equity is ${U.fmtUSD(m.equity)} against ${U.fmtUSD(m.exposure)} of shorts. `
          + `Equity must stay above ${U.fmtUSD(m.maintenance)} (30% of the short). `
          + `Below ${U.fmtUSD(m.forceLevel)} the positions are bought back automatically.`,
        timeout: 15000,
      });
    }
    lastMarginLevel[id] = m.level;
  }

  /* ------------------------------------------------------- AI trader loop */

  /**
   * Candidate rotation keeps upstream candle requests bounded: each cycle looks
   * at a handful of names rather than the whole universe.
   */
  function aiCandidates() {
    const pool = [];
    const seen = new Set();
    const push = (id) => { if (PT.byId[id] && !seen.has(id)) { seen.add(id); pool.push(id); } };

    // Anything the AI already holds is always evaluated, so exits are never missed.
    for (const id in A.pfAI().positions) push(id);
    for (const id of S.st.watchlist) push(id);
    for (const id of PT.defaultWatchlist) push(id);

    const held = Object.keys(A.pfAI().positions).length;
    const rotating = pool.slice(held);
    const take = PT.trader.RULES.candidatesPerCycle;
    const picked = [];
    for (let i = 0; i < Math.min(take, rotating.length); i++) {
      picked.push(rotating[(S.rotateIdx + i) % rotating.length]);
    }
    S.rotateIdx = (S.rotateIdx + take) % Math.max(1, rotating.length);
    return pool.slice(0, held).concat(picked);
  }

  async function aiCycle() {
    // One AI per book: a second tab running it would trade the same money twice.
    if (S.aiBusy || !S.st.settings.aiTraderEnabled || !A.isWriter()) return;
    S.aiBusy = true;
    try {
      const candidates = aiCandidates();
      PT.feed.watch(candidates);

      // The strategy reasons on 15m bars: slow enough to be meaningful,
      // fast enough that a session produces visible activity.
      const candles = {};
      for (const id of candidates) {
        try {
          const res = await PT.feed.candles(id, '15m');
          candles[id] = res.bars;
          S.candleCache[id + ':15m'] = res.bars;
        } catch { /* skip anything we cannot price honestly */ }
      }

      const result = PT.trader.runTraderCycle(A.pfAI(), {
        now: Date.now(),
        prices: A.prices(),
        candles,
        candidates,
        cooldowns: S.cooldowns,
        marketOpen: PT.calendar.stockStatus().isOpen,
        slippageEnabled: S.st.settings.slippageEnabled,
        // The autonomous strategy stays long-only regardless of the user's
        // own setting: its rules were designed and tested without shorts.
        shortingEnabled: false,
        // It decides against a price it can see, so it does not park orders
        // for a bell that is hours away.
        allowQueue: false,
      });

      for (const d of result.decisions) {
        /*
         * At a five-second cadence the strategy holds far more often than it
         * trades. Collapsing a repeated identical hold into one entry with a
         * count keeps the log fast-moving without burying the actual trades.
         */
        const last = S.st.aiLog[S.st.aiLog.length - 1];
        if (d.action === 'hold' && last && last.action === 'hold'
            && last.assetId === d.assetId && last.why === d.why) {
          last.t = d.t;
          last.repeats = (last.repeats || 1) + 1;
          continue;
        }
        S.st.aiLog.push(d);
        if (d.action === 'buy' || d.action === 'sell') {
          UI.toast({
            kind: d.action === 'buy' ? 'buy' : 'sell',
            title: `AI ${d.action === 'buy' ? 'bought' : 'sold'} ${U.fmtQty(d.qty)} ${d.assetId}`,
            message: d.why,
            timeout: 6000,
          });
        }
      }
      if (S.st.aiLog.length > 500) S.st.aiLog.splice(0, S.st.aiLog.length - 500);
      A.save();

      if (S.view === 'compare') V.renderCompareView();
    } catch (e) {
      console.error('[ai] cycle failed', e);
    } finally {
      S.aiBusy = false;
    }
  }

  /* ------------------------------------------------------------ shortcuts */

  function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === '/' && !typing) { e.preventDefault(); A.R.omniInput.focus(); return; }
      if (typing) return;

      const idx = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].indexOf(e.key);
      if (idx >= 0 && S.view === 'trade') {
        S.tf = V.TIMEFRAMES[idx];
        V.buildChartPane();
        return;
      }
      if (e.key === 'b' && S.view === 'trade') { S.order.side = 'buy'; V.buildOrderPane(); }
      if (e.key === 's' && S.view === 'trade') { S.order.side = 'sell'; V.buildOrderPane(); }
      if (e.key === 'g') A.setView('portfolio');
      if (e.key === 'a') A.setView('ai');
      if (e.key === 'c') A.setView('compare');
      if (e.key === 't') A.setView('trade');
    });
  }

  /* ------------------------------------------------------------ live wire */

  function wireFeed() {
    PT.feed.on('tick', (q) => {
      A.paintQuote(q.assetId, q);
      /*
       * Resting orders are matched against every print, not just the ones the
       * run loop samples: its timer crawls in a background tab, and a price can
       * trade through a limit and back between two passes.
       */
      if (A.isWriter() && hasOrderOn(q.assetId)) processOrders(Date.now());
      if (q.assetId !== S.focus || !S.chart) return;

      if (PT.feed.SECOND_TFS.has(S.tf)) {
        /*
         * Sub-minute candles are aggregated from the tick buffer, so rebuild
         * rather than fold: the buffer is small and this keeps the series exact
         * as prints arrive out of order or arrive faster than one per bucket.
         */
        S.bars = PT.feed.candlesFromTicks(S.focus, S.tf);
        S.chart.setData(S.bars, S.tf);
        const st = V.tickSeriesState(S.focus, S.tf, S.bars);
        if (R.chartMsg) {
          if (st.message) V.showChartMsg(st.message);
          else R.chartMsg.classList.add('hidden');
        }
        if (R.chartSource) R.chartSource.textContent = `${S.bars.length} bars · ${st.label}`;
        return;
      }

      /*
       * Fold the live price into the focused chart's newest candle. A stock
       * folds at the exchange's stamp, and only for a print from the regular
       * session: polls of a shut market would otherwise draw flat bars for
       * nights and weekends when nothing traded.
       */
      const eq = !PT.isCrypto(q.assetId);
      const ts = eq && q.quoteTime > 0 ? q.quoteTime : q.t;
      if (eq && !PT.calendar.stockStatus(ts).isOpen) return;
      if (S.bars && PT.feed.applyTickToBars(S.bars, S.tf, q.price, ts)) {
        S.chart.setData(S.bars, S.tf);
      }
    });
  }

  /* ---------------------------------------------------------------- boot */

  /*
   * Saves are debounced by 600ms so a burst of updates writes once. That leaves
   * a window where a trade lives only in memory, so flush it the moment the page
   * is going away. `pagehide` is the reliable signal on mobile Safari, where a
   * backgrounded tab may never see `unload` at all; `visibilitychange` covers
   * tab switches and app switches that precede a silent kill.
   */
  function wireDurability() {
    const flush = () => { try { A.save.flush(); } catch (_) { /* nothing to do while unloading */ } };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    // Moving to another window may mean moving to another tab of this app.
    window.addEventListener('blur', flush);
  }

  /*
   * Only one tab saves the book (see PT.app.save). The tab being looked at or
   * used takes that over; the others follow what it saves.
   */
  function wireTabs() {
    window.addEventListener('storage', A.onStorage);
    window.addEventListener('focus', () => A.claimWriter(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      A.claimWriter(true);
      // Catch up at once on anything that crossed while the tab was hidden.
      if (A.isWriter()) processOrders(Date.now());
    });
    window.addEventListener('pagehide', () => A.releaseWriter());
    // Back from the back/forward cache, having let go of it on the way out.
    window.addEventListener('pageshow', (e) => { if (e.persisted) A.claimWriter(true); });
  }

  function startApp(state) {
    S.st = state;

    /*
     * Re-register symbols the user discovered through search. This has to run
     * before anything reads the registry, or a held penny stock would come back
     * as an unknown symbol with no name and no price source.
     */
    for (const id in (S.st.discovered || {})) PT.registerAsset(S.st.discovered[id]);

    // Older saves defaulted the AI to a one-minute clock.
    if (!S.st.settings.aiIntervalMs || S.st.settings.aiIntervalMs > 30000) {
      S.st.settings.aiIntervalMs = 5000;
    }

    // Focus something the user is actually watching.
    S.focus = S.st.watchlist[0] || 'AAPL';
    if (!PT.byId[S.focus]) S.focus = 'AAPL';

    PT.app.mountShell();
    V.applyDirectionScheme();

    PT.feed.watch([...A.neededSymbols()]);
    PT.feed.setFocus(S.focus);
    PT.feed.start();

    // A newly opened tab is the one in use.
    A.claimWriter();
    wireFeed();
    wireShortcuts();
    wireDurability();
    wireTabs();
    V.renderAll();
    tickLoop();

    // The AI takes its first decision shortly after launch, then on its schedule.
    setTimeout(aiCycle, 4000);
    setInterval(aiCycle, S.st.settings.aiIntervalMs || 5000);

    PT.companion.llmAvailable().then((ok) => {
      S.llmReady = ok;
      if (S.view === 'ai') V.renderAIView();
    });

    // If the stored book was corrupt, say so plainly rather than silently
    // presenting different numbers than the user left behind.
    if (S.st.repairs && S.st.repairs.length) {
      for (const r of S.st.repairs) {
        UI.toast({
          kind: 'warn',
          title: `Repaired your ${r.portfolio === 'ai' ? 'AI' : ''} account`.replace('  ', ' '),
          message: `${r.problems.join('; ')}. `
            + (r.exact
              ? `Rebuilt from your trade history — balance is now ${U.fmtUSD(r.after.cash)}.`
              : `History was incomplete, so values were clamped to a valid state.`),
          timeout: 15000,
        });
      }
      delete S.st.repairs;
      A.save();
    }

    // A one-time, unmissable statement of what this is.
    if (!S.st.settings.disclaimerSeen) {
      setTimeout(() => {
        UI.toast({
          kind: 'warn',
          title: 'Paper trading — practice only',
          message: 'Virtual money against real prices. No real orders, no brokerage, and nothing here is financial advice.',
          timeout: 12000,
        });
        S.st.settings.disclaimerSeen = true;
        // Not a reason to take over from a tab the user has since gone back to.
        if (A.isWriter()) A.save();
      }, 1500);
    }
  }

  function boot() {
    const existing = E.load();
    if (existing) return startApp(existing);

    // Another tab can finish onboarding while this one waits; use its book.
    const onStored = (e) => { if (e.key === E.STORAGE_KEY && e.newValue && E.load()) location.reload(); };
    window.addEventListener('storage', onStored);
    V.showOnboarding((cash) => {
      window.removeEventListener('storage', onStored);
      const other = E.load();
      if (other) return startApp(other);
      /*
       * A save this build cannot read — damaged, or written by a newer version —
       * is set aside rather than overwritten, so it is not destroyed outright.
       */
      try {
        const raw = localStorage.getItem(E.STORAGE_KEY);
        if (raw) localStorage.setItem(E.STORAGE_KEY + '.unreadable', raw);
      } catch { /* no room to keep it */ }
      const fresh = E.newState(cash);
      E.save(fresh);
      startApp(fresh);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  PT.boot = { boot, aiCycle, tickLoop };
})(window.PT);
