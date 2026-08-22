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

  function tickLoop() {
    const now = Date.now();
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
        prices: px,
        // Each order's own asset class decides whether it may fill.
        marketOpen: PT.calendar.stockStatus().isOpen,
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
            message: `at ${U.fmtUSD(f.price)}` + (f.side === 'sell' ? ` · realized ${U.fmtSigned(f.realized)}` : ''),
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

    /* Chrome refresh, throttled — price cells update on their own via ticks. */
    if (now - lastRender > 250) {
      lastRender = now;
      V.renderTopbar();
      V.renderStatusbar();
      if (S.view === 'trade') {
        V.renderSymbolHeader();
        if (S.blotterTab !== 'history') V.renderBlotter();
      }
    }

    requestAnimationFrame(() => setTimeout(tickLoop, 100));
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
  function checkMargin(now, px) {
    for (const id of E.accountIds(S.st)) checkAccountMargin(S.st.portfolios[id], id, px);
  }

  function checkAccountMargin(pf, id, px) {
    if (!pf) return;
    const active = id === S.st.activeAccount;
    const where = active ? '' : ` · ${pf.name}`;
    const m = E.marginStatus(pf, px);
    if (m.level === 'none') { lastMarginLevel[id] = 'ok'; return; }

    if (m.level === 'liquidate') {
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
    if (S.aiBusy || !S.st.settings.aiTraderEnabled) return;
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

      // Fold the live price into the focused chart's newest candle.
      if (S.bars && PT.feed.applyTickToBars(S.bars, S.tf, q.price, q.t)) {
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

    const toWatch = new Set(S.st.watchlist);
    for (const id in A.pfUser().positions) toWatch.add(id);
    for (const id in A.pfAI().positions) toWatch.add(id);
    PT.feed.watch([...toWatch]);
    PT.feed.setFocus(S.focus);
    PT.feed.start();

    wireFeed();
    wireShortcuts();
    wireDurability();
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
        A.save();
      }, 1500);
    }
  }

  function boot() {
    const existing = E.load();
    if (existing) return startApp(existing);
    V.showOnboarding((cash) => {
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
