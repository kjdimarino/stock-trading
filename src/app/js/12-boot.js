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
  const { S } = A;

  /* ------------------------------------------------------------ run loop */

  let lastRender = 0;
  let lastEquitySample = 0;

  function tickLoop() {
    const now = Date.now();
    const px = A.prices();

    /* Resting limit orders for both books. */
    for (const id of ['user', 'ai']) {
      const pf = S.st.portfolios[id];
      if (!pf.orders.length) continue;
      const fills = E.processOpenOrders(pf, {
        prices: px,
        // Each order's own asset class decides whether it may fill.
        marketOpen: PT.calendar.stockStatus().isOpen,
        slippageEnabled: S.st.settings.slippageEnabled,
        now,
      });
      for (const f of fills) {
        if (id === 'user') {
          UI.toast({
            kind: f.side,
            title: `Limit filled: ${f.side} ${U.fmtQty(f.qty)} ${f.assetId}`,
            message: `at ${U.fmtUSD(f.price)}` + (f.side === 'sell' ? ` · realized ${U.fmtSigned(f.realized)}` : ''),
          });
        }
      }
      if (fills.length) A.save();
    }

    /* Equity curve sampling for both books. */
    if (now - lastEquitySample > 10000) {
      lastEquitySample = now;
      for (const id of ['user', 'ai']) {
        const pf = S.st.portfolios[id];
        E.sampleEquity(pf, E.valuate(pf, px).equity, now);
      }
      A.save();
    }

    /* Chrome refresh, throttled — price cells update on their own via ticks. */
    if (now - lastRender > 900) {
      lastRender = now;
      V.renderTopbar();
      V.renderStatusbar();
      if (S.view === 'trade') {
        V.renderSymbolHeader();
        if (S.blotterTab !== 'history') V.renderBlotter();
      }
    }

    requestAnimationFrame(() => setTimeout(tickLoop, 250));
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
          S.candleCache[id] = res.bars;
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
      });

      for (const d of result.decisions) {
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

      const idx = ['1', '2', '3', '4', '5', '6'].indexOf(e.key);
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

      // Fold the live price into the focused chart's newest candle.
      if (q.assetId === S.focus && S.bars && S.chart) {
        if (PT.feed.applyTickToBars(S.bars, S.tf, q.price, q.t)) {
          S.chart.setData(S.bars, S.tf);
        }
      }
    });
  }

  /* ---------------------------------------------------------------- boot */

  function startApp(state) {
    S.st = state;

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
    V.renderAll();
    tickLoop();

    // The AI takes its first decision shortly after launch, then on its schedule.
    setTimeout(aiCycle, 8000);
    setInterval(aiCycle, S.st.settings.aiIntervalMs || 60000);

    PT.companion.llmAvailable().then((ok) => {
      S.llmReady = ok;
      if (S.view === 'ai') V.renderAIView();
    });

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
