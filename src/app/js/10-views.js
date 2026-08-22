/* =========================================================================
   Trading views: chart pane, blotter and order entry.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const UI = PT.ui;
  const E = PT.engine;
  const el = U.el;
  const icon = UI.icon;
  const A = PT.app;
  const { S, R } = A;

  const TIMEFRAMES = ['1s', '5s', '15s', '1m', '5m', '15m', '1h', '1D', '1W'];

  /* ============================== chart pane ============================= */

  function buildChartPane() {
    const asset = PT.byId[S.focus];
    if (!asset) return;
    R.chartpane.innerHTML = '';
    if (S.chart) { S.chart.destroy(); S.chart = null; }

    /* symbol header */
    R.symLast = UI.makePriceCell('symhead__last');
    R.symChg = el('div', { class: 'symhead__chg num' }, '—');
    R.symBadge = el('span', {});
    A.registerCell(S.focus, { price: R.symLast });

    const inWatchlist = S.st.watchlist.includes(S.focus);
    const watchBtn = el('button', {
      class: 'btn btn--sm', title: inWatchlist ? 'Remove from watchlist' : 'Add to watchlist',
    }, [icon(inWatchlist ? 'check' : 'plus', 13), inWatchlist ? 'Watching' : 'Watch']);
    watchBtn.addEventListener('click', () => {
      if (S.st.watchlist.includes(S.focus)) {
        S.st.watchlist = S.st.watchlist.filter((x) => x !== S.focus);
      } else S.st.watchlist.unshift(S.focus);
      A.save();
      buildChartPane();
      A.renderWatchlist();
    });

    R.symStats = el('div', { class: 'symhead__stats' });

    R.chartpane.appendChild(el('div', { class: 'symhead' }, [
      el('div', { class: 'symhead__id' }, [
        el('div', { class: 'symhead__sym' }, [
          asset.id,
          el('span', {
            class: 'badge ' + (asset.kind === 'crypto' ? 'badge--sim' : 'badge--closed'),
            text: asset.kind === 'crypto' ? 'Crypto' : asset.kind === 'etf' ? 'ETF' : 'Stock',
          }),
        ]),
        el('div', { class: 'symhead__name truncate', text: asset.name }),
      ]),
      el('div', { class: 'symhead__px' }, [R.symLast, R.symChg]),
      el('div', { class: 'symhead__spacer' }),
      R.symStats,
      R.symBadge,
      watchBtn,
    ]));

    /* toolbar */
    const tfSeg = el('div', { class: 'seg' });
    R.tfButtons = {};
    for (const tf of TIMEFRAMES) {
      const b = el('button', { class: 'seg__item' + (S.tf === tf ? ' is-active' : ''), text: tf });
      b.addEventListener('click', () => {
        S.tf = tf;
        for (const k in R.tfButtons) R.tfButtons[k].classList.toggle('is-active', k === tf);
        loadChart(true);
      });
      R.tfButtons[tf] = b;
      tfSeg.appendChild(b);
    }

    const modeSeg = el('div', { class: 'seg' });
    R.modeButtons = {};
    for (const [mode, label] of [['candle', 'Candles'], ['line', 'Line']]) {
      const b = el('button', { class: 'seg__item' + (S.chartMode === mode ? ' is-active' : ''), text: label });
      b.addEventListener('click', () => {
        S.chartMode = mode;
        for (const k in R.modeButtons) R.modeButtons[k].classList.toggle('is-active', k === mode);
        if (S.chart) S.chart.setMode(mode);
      });
      R.modeButtons[mode] = b;
      modeSeg.appendChild(b);
    }

    /* drawing tools */
    const drawSeg = el('div', { class: 'seg seg--draw hidden' });
    R.drawButtons = {};
    const TOOLS = [
      // Not "Line": the chart-mode switch next to it already has one, and two
      // buttons with the same word in one toolbar is a coin toss.
      ['trend', 'Trend', 'Drag a trendline between two points'],
      ['level', 'Level', 'Click to drop a horizontal price line'],
      ['free', 'Free', 'Draw freehand'],
      ['erase', 'Erase', 'Click a drawing to remove it'],
    ];
    for (const [tool, label, title] of TOOLS) {
      const b = el('button', { class: 'seg__item', title, text: label });
      b.addEventListener('click', () => setDrawTool(S.drawTool === tool ? null : tool));
      R.drawButtons[tool] = b;
      drawSeg.appendChild(b);
    }
    const undo = el('button', { class: 'btn btn--ghost btn--sm hidden', title: 'Undo the last drawing', text: 'Undo' });
    undo.addEventListener('click', () => { S.chart.undoDrawing(); });
    const clearDraw = el('button', { class: 'btn btn--ghost btn--sm hidden', title: 'Remove every drawing on this symbol', text: 'Clear' });
    clearDraw.addEventListener('click', () => { S.chart.clearDrawings(); });
    R.drawExtras = [undo, clearDraw];

    const drawToggle = el('button', { class: 'btn btn--ghost btn--sm', title: 'Draw on the chart', text: 'Draw' });
    drawToggle.addEventListener('click', () => setDrawMode(!S.drawMode));
    R.drawToggle = drawToggle;
    R.drawSeg = drawSeg;

    R.chartSource = el('span', { class: 'dimmer', style: 'font-size:10px' }, '');
    const refresh = el('button', { class: 'btn btn--ghost btn--icon btn--sm', title: 'Reload candles' }, icon('refresh', 13));
    refresh.addEventListener('click', () => loadChart(true));

    R.chartpane.appendChild(el('div', { class: 'charttools' }, [
      tfSeg, modeSeg, drawToggle, drawSeg, undo, clearDraw,
      el('div', { class: 'charttools__spacer' }),
      R.chartSource, refresh,
    ]));

    /* canvas */
    R.chartLegend = el('div', { class: 'chartlegend hidden' });
    R.chartMsg = el('div', { class: 'chart-msg' }, [el('div', { class: 'spinner' }), 'Loading candles…']);
    R.chartWrap = el('div', { class: 'chartwrap' }, [R.chartLegend, R.chartMsg]);
    R.chartpane.appendChild(R.chartWrap);

    S.chart = new PT.chart.PriceChart(R.chartWrap);
    S.chart.setMode(S.chartMode);
    bindDrawings(S.focus);
    setDrawMode(S.drawMode === true);
    S.chart.onHover = (bar) => {
      if (!bar) { R.chartLegend.classList.add('hidden'); return; }
      R.chartLegend.classList.remove('hidden');
      R.chartLegend.innerHTML = '';
      const up = bar.c >= bar.o;
      const cls = up ? 'up' : 'down';
      for (const [k, v] of [['O', bar.o], ['H', bar.h], ['L', bar.l], ['C', bar.c]]) {
        R.chartLegend.appendChild(el('span', { class: cls }, [el('b', { text: k }), U.fmtUSD(v)]));
      }
      if (bar.v) R.chartLegend.appendChild(el('span', { class: 'dim' }, [el('b', { text: 'V' }), U.fmtCompact(bar.v)]));
    };

    loadChart(true);
  }

  /* ------------------------------------------------------------ drawings */

  /**
   * Drawings belong to a symbol, not to a timeframe: a level you marked on the
   * daily is the same level on the 5m, so it is stored once in (time, price)
   * and re-projected whenever the chart geometry changes.
   */
  function drawingsFor(assetId) {
    const all = S.st.drawings || (S.st.drawings = {});
    return all[assetId] || [];
  }

  function setDrawMode(on) {
    S.drawMode = !!on;
    if (!S.drawMode) setDrawTool(null);
    else if (!S.drawTool) setDrawTool('trend');
    if (R.drawToggle) R.drawToggle.classList.toggle('is-active', S.drawMode);
    if (R.drawSeg) R.drawSeg.classList.toggle('hidden', !S.drawMode);
    for (const b of (R.drawExtras || [])) b.classList.toggle('hidden', !S.drawMode);
  }

  function setDrawTool(tool) {
    S.drawTool = tool || null;
    if (S.chart) S.chart.setDrawTool(S.drawTool);
    for (const k in (R.drawButtons || {})) {
      R.drawButtons[k].classList.toggle('is-active', k === S.drawTool);
    }
  }

  /** Point the chart at this symbol's drawings and persist anything new. */
  function bindDrawings(assetId) {
    if (!S.chart) return;
    S.chart.setDrawings(drawingsFor(assetId).slice());
    S.chart.onDrawingsChange = (list) => {
      const all = S.st.drawings || (S.st.drawings = {});
      // A runaway freehand session should not be able to bloat the save file.
      if (list.length) all[assetId] = list.slice(-200);
      else delete all[assetId];
      A.save();
    };
  }

  /*
   * Sub-minute candles are aggregated locally from the print stream, so the
   * series starts empty and fills in as prints arrive. Say that plainly instead
   * of leaving an empty chart with no explanation, and name the real source:
   * crypto is a genuine trade feed, equities are a poll.
   */
  function tickSeriesState(assetId, tf, bars) {
    // A CoinGecko-only coin is polled like an equity, not streamed like BTC.
    const crypto = PT.isCrypto(assetId) && !PT.isDelayedCoin(assetId);
    const label = crypto ? 'live trades' : 'polled quotes';
    const n = bars ? bars.length : 0;
    if (n >= 3) return { label, message: null };
    if (!crypto && !PT.isCrypto(assetId) && !PT.calendar.stockStatus().isOpen) {
      return {
        label,
        message: `${tf} candles are built from live prints. The US market is closed, `
          + 'so nothing new is coming in — try a crypto symbol, or 1m and above.',
      };
    }
    return {
      label,
      message: `Building ${tf} candles from ${label}… ${n} bar${n === 1 ? '' : 's'} so far.`,
    };
  }

  function showChartMsg(text) {
    if (!R.chartMsg) return;
    R.chartMsg.classList.remove('hidden');
    R.chartMsg.innerHTML = '';
    R.chartMsg.append(el('div', { class: 'spinner' }), text);
  }

  async function loadChart(force) {
    const assetId = S.focus;
    const tf = S.tf;
    if (!S.chart) return;
    R.chartMsg.classList.remove('hidden');
    R.chartMsg.innerHTML = '';
    R.chartMsg.append(el('div', { class: 'spinner' }), 'Loading candles…');

    try {
      const res = await PT.feed.candles(assetId, tf, { force });
      /*
       * The user may have moved on while this was in flight — to another
       * symbol, another timeframe, or to a view that tears the chart down
       * altogether. The last of those leaves S.chart null, so it has to be
       * re-checked here and not only on the way in.
       */
      if (S.focus !== assetId || S.tf !== tf || !S.chart) return;
      S.bars = res.bars;
      S.barsMeta = res;
      S.candleCache[assetId + ':' + tf] = res.bars;
      S.chart.setData(res.bars, tf);
      if (PT.feed.SECOND_TFS.has(tf)) {
        const st = tickSeriesState(assetId, tf, res.bars);
        if (st.message) showChartMsg(st.message);
        else R.chartMsg.classList.add('hidden');
        R.chartSource.textContent = `${res.bars.length} bars · ${st.label}`;
      } else {
        R.chartMsg.classList.add('hidden');
        R.chartSource.textContent = `${res.bars.length} bars · ${res.source}`
          + (res.closeOnly ? ' · close-only, no intraday high/low' : '');
      }
    } catch (e) {
      // Guard on the timeframe and the chart's existence too: a slow failure for
      // a timeframe the user has already left would otherwise blank a chart that
      // loaded fine, or throw against a chart that has since been destroyed.
      if (S.focus !== assetId || S.tf !== tf || !S.chart || !R.chartMsg) return;
      S.bars = null;
      S.chart.setData([], tf);
      R.chartMsg.classList.remove('hidden');
      R.chartMsg.innerHTML = '';
      const retry = el('button', { class: 'btn btn--sm', text: 'Retry' });
      retry.addEventListener('click', () => loadChart(true));
      R.chartMsg.append(icon('alert', 16), `Couldn't load candles — ${e.message}`, retry);
    }
  }

  /* ================================ blotter ============================== */

  const BLOTTER_TABS = [
    ['positions', 'Positions'], ['orders', 'Open orders'], ['history', 'Trade history'],
  ];

  function buildBlotter() {
    R.blotter.innerHTML = '';
    R.blotterSig = null;
    R.posRows = new Map();
    const head = el('div', { class: 'blotter__head' });
    R.blotterTabs = {};
    for (const [id, label] of BLOTTER_TABS) {
      const count = el('span', { class: 'tab__count', text: '0' });
      const tab = el('button', { class: 'tab' + (S.blotterTab === id ? ' is-active' : '') }, [label, count]);
      tab.addEventListener('click', () => { S.blotterTab = id; buildBlotter(); });
      R.blotterTabs[id] = { tab, count };
      head.appendChild(tab);
    }
    /*
     * Money summary. "How much have I actually put in, and how much is left"
     * should never require opening another view.
     */
    R.moneyBar = el('div', { class: 'moneybar' });
    head.appendChild(el('div', { style: 'flex:1' }));
    head.appendChild(R.moneyBar);

    R.blotter.appendChild(head);
    R.blotterBody = el('div', { class: 'blotter__body scroll' });
    R.blotter.appendChild(R.blotterBody);
    renderBlotter();
  }

  /**
   * A signature of what the blotter is showing. The run loop calls this every
   * second, and blowing away the table each time would reset scroll position,
   * kill text selection and thrash the DOM — so the table is only rebuilt when
   * its rows actually change, and otherwise just has its numbers updated.
   */
  function blotterSignature(pf, val) {
    if (S.blotterTab === 'positions') return 'p:' + val.positions.map((p) => p.assetId + ':' + p.qty).join('|');
    // Status is part of the signature: an order released at the bell has to
    // redraw, not sit there still labelled as waiting.
    if (S.blotterTab === 'orders') return 'o:' + pf.orders.map((o) => o.id + o.status).join('|') + '/r:' + (pf.rejected || []).length;
    return 'h:' + pf.fills.length;
  }

  function renderBlotter() {
    if (!R.blotterBody) return;
    const pf = A.pfUser();
    const val = E.valuate(pf, A.prices());

    if (R.blotterTabs) {
      R.blotterTabs.positions.count.textContent = String(val.positions.length);
      R.blotterTabs.orders.count.textContent = String(pf.orders.length);
      R.blotterTabs.history.count.textContent = String(pf.fills.length);
    }

    renderMoneyBar(val);

    const sig = blotterSignature(pf, val);
    if (sig === R.blotterSig && R.blotterBody.firstChild) {
      if (S.blotterTab === 'positions') updatePositionValues(val);
      return;
    }
    R.blotterSig = sig;
    R.posRows = new Map();

    R.blotterBody.innerHTML = '';
    if (S.blotterTab === 'positions') renderPositions(R.blotterBody, val);
    else if (S.blotterTab === 'orders') renderOpenOrders(R.blotterBody, pf);
    else renderHistory(R.blotterBody, pf);
  }

  /** Invested / free / short exposure, always visible above the blotter. */
  function renderMoneyBar(val) {
    if (!R.moneyBar) return;
    R.moneyBar.innerHTML = '';
    const item = (label, value, sub, cls) => R.moneyBar.appendChild(el('div', { class: 'moneybar__item' }, [
      el('span', { class: 'moneybar__k', text: label }),
      el('span', { class: 'moneybar__v num ' + (cls || ''), text: value }),
      sub ? el('span', { class: 'moneybar__sub num', text: sub }) : null,
    ]));

    item('Invested', U.fmtUSD(val.invested, { fixed2: true }),
      val.equity > 0 ? (val.invested / val.equity * 100).toFixed(1) + '%' : '0%');
    item('Cash free', U.fmtUSD(val.buyingPower, { fixed2: true }),
      val.equity > 0 ? (val.buyingPower / val.equity * 100).toFixed(1) + '%' : '0%');
    if (val.reserved > 0.005) {
      item('Reserved', U.fmtUSD(val.reserved, { fixed2: true }), 'held', 'dim');
    }
    if (val.shortValue > 0.005) {
      item('Short', U.fmtUSD(val.shortValue, { fixed2: true }),
        val.equity > 0 ? (val.shortValue / val.equity * 100).toFixed(1) + '%' : '0%', 'down');
    }
    item('Equity', U.fmtUSD(val.equity, { fixed2: true }), null,
      U.dirClass(val.totalReturn));
  }

  /** Write live valuation numbers into the existing position rows. */
  function updatePositionValues(val) {
    if (!R.posRows) return;
    for (const p of val.positions) {
      const row = R.posRows.get(p.assetId);
      if (!row || !row.value.isConnected) continue;
      if (row.weight) row.weight.textContent = p.weightPct.toFixed(1) + '%';
      row.value.textContent = U.fmtUSD(p.exposure, { fixed2: true });
      row.upl.textContent = U.fmtSigned(p.unrealized);
      row.upl.className = 'num ' + U.dirClass(p.unrealized);
      row.pct.textContent = U.fmtPct(p.unrealizedPct);
      row.pct.className = 'num ' + U.dirClass(p.unrealized);
    }
  }

  function table(headers) {
    const t = el('table', { class: 'table' });
    const thead = el('thead');
    const tr = el('tr');
    for (const h of headers) tr.appendChild(el('th', { text: h }));
    thead.appendChild(tr);
    t.appendChild(thead);
    const tbody = el('tbody');
    t.appendChild(tbody);
    return { t, tbody };
  }

  function renderPositions(host, val) {
    if (!val.positions.length) {
      host.appendChild(UI.emptyState('wallet', 'No positions yet',
        'Buy something from the order panel and it will show up here with live P&L.'));
      return;
    }
    const { t, tbody } = table(['Symbol', 'Side', 'Qty', 'Avg cost', 'Last', 'Market value', '% of book', 'Unrealized', '%', '']);
    for (const p of val.positions) {
      const priceCell = UI.makePriceCell('');
      const weightCell = el('span', { class: 'num dim' }, p.weightPct.toFixed(1) + '%');
      const valueCell = el('span', { class: 'num' }, U.fmtUSD(p.exposure, { fixed2: true }));
      const uplCell = el('span', { class: 'num ' + U.dirClass(p.unrealized) }, U.fmtSigned(p.unrealized));
      const pctCell = el('span', { class: 'num ' + U.dirClass(p.unrealized) }, U.fmtPct(p.unrealizedPct));
      A.registerCell(p.assetId, { price: priceCell });
      UI.setPrice(priceCell, p.price);
      if (R.posRows) R.posRows.set(p.assetId, { value: valueCell, upl: uplCell, pct: pctCell, weight: weightCell });

      const close = el('button', { class: 'btn btn--sm btn--danger', text: p.isShort ? 'Cover' : 'Close' });
      close.addEventListener('click', (ev) => { ev.stopPropagation(); closePosition(p); });

      const tr = el('tr', { class: 'is-clickable' }, [
        el('td', {}, [
          el('div', { class: 'table__sym', text: p.assetId }),
          el('div', { class: 'table__sub', text: (PT.byId[p.assetId] || {}).name || '' }),
        ]),
        el('td', {}, el('span', {
          class: 'badge ' + (p.isShort ? 'badge--down' : 'badge--up'),
          text: p.isShort ? 'Short' : 'Long',
        })),
        el('td', { class: 'num', text: U.fmtQty(Math.abs(p.qty)) }),
        el('td', { class: 'num', text: U.fmtUSD(p.avgCost) }),
        el('td', {}, [priceCell, p.stale ? el('span', { class: 'badge badge--delayed', style: 'margin-left:6px' }, 'stale') : null]),
        el('td', {}, valueCell),
        el('td', {}, weightCell),
        el('td', {}, uplCell),
        el('td', {}, pctCell),
        el('td', {}, close),
      ]);
      tr.addEventListener('click', () => A.setFocus(p.assetId));
      tbody.appendChild(tr);
    }
    host.appendChild(t);
  }

  function closePosition(p) {
    const side = p.isShort ? 'buy' : 'sell';
    UI.confirmDialog({
      title: `${p.isShort ? 'Cover' : 'Close'} ${p.assetId}?`,
      message: `${p.isShort ? 'Buy back' : 'Sell'} all ${U.fmtQty(Math.abs(p.qty))} ${p.assetId} at market. `
        + `Unrealized P&L of ${U.fmtSigned(p.unrealized)} will be realized.`,
      confirmLabel: p.isShort ? 'Cover short' : 'Close position',
      danger: true,
      onConfirm: () => {
        try {
          const r = E.submitOrder(A.pfUser(), {
            assetId: p.assetId, side, type: 'market', qty: Math.abs(p.qty),
          }, A.orderCtx(p.assetId));
          UI.toast({
            kind: 'sell', title: `Sold ${U.fmtQty(r.fill.qty)} ${p.assetId}`,
            message: `at ${U.fmtUSD(r.fill.price)} · realized ${U.fmtSigned(r.fill.realized)}`,
          });
          A.save();
          renderAll();
        } catch (e) {
          UI.toast({ kind: 'error', title: 'Order rejected', message: e.message });
        }
      },
    });
  }

  function renderOpenOrders(host, pf) {
    const rejected = pf.rejected || [];
    if (!pf.orders.length) {
      if (!rejected.length) {
        host.appendChild(UI.emptyState('orders', 'No open orders',
          'Limit orders rest here until the market reaches your price, and anything you buy '
          + 'while the stock market is shut waits here until the opening bell.'));
        return;
      }
      renderRejected(host, pf);
      return;
    }
    const queuedCount = pf.orders.filter((o) => o.status === 'queued').length;
    const restingCount = pf.orders.length - queuedCount;
    const parts = [];
    if (restingCount) parts.push(`${restingCount} resting`);
    if (queuedCount) parts.push(`${queuedCount} waiting for the open`);
    const head = el('div', { class: 'panel__head' }, [
      el('div', { class: 'panel__title', text: parts.join(' · ') }),
      el('div', { style: 'flex:1' }),
    ]);
    const cancelAll = el('button', { class: 'btn btn--sm btn--danger', text: 'Cancel all' });
    cancelAll.addEventListener('click', () => {
      const n = pf.orders.length;
      pf.orders = [];
      A.save();
      renderBlotter();
      updateEstimate();
      UI.toast({ title: `Cancelled ${n} order${n === 1 ? '' : 's'}`, message: 'The cash they were holding is spendable again.' });
    });
    head.appendChild(cancelAll);
    host.appendChild(head);

    const openAt = PT.calendar.stockStatus().nextChange;
    const { t, tbody } = table(['Placed', 'Symbol', 'Side', 'Type', 'Qty', 'Limit', 'Status', '']);
    for (const o of pf.orders) {
      const q = A.prices()[o.assetId];
      const dist = o.limitPrice != null && q && isFinite(q.price)
        ? ((o.limitPrice - q.price) / q.price) * 100 : null;

      /*
       * "Distance to my limit" is the useful thing to know about a resting
       * order; for one parked until the bell it is when the bell is. Same
       * column, different question.
       */
      const status = o.status === 'queued'
        ? el('span', { class: 'badge badge--delayed' },
          openAt ? `Opens in ${PT.calendar.untilText(openAt)}` : 'At the open')
        : el('span', { class: 'num dim', text: dist == null ? '—' : U.fmtPct(dist) });
      const cancel = el('button', { class: 'btn btn--sm', text: 'Cancel' });
      cancel.addEventListener('click', () => {
        E.cancelOrder(pf, o.id);
        A.save();
        renderAll();
        UI.toast({ title: 'Order cancelled', message: `${o.side.toUpperCase()} ${o.assetId}` });
      });
      tbody.appendChild(el('tr', {}, [
        el('td', { class: 'table__sub', text: U.fmtDateTime(o.createdAt) }),
        el('td', {}, el('span', { class: 'table__sym', text: o.assetId })),
        el('td', {}, el('span', { class: 'badge ' + (o.side === 'buy' ? 'badge--up' : 'badge--down'), text: o.side })),
        el('td', { class: 'table__sub', text: o.type }),
        el('td', { class: 'num', text: o.notional != null ? U.fmtUSD(o.notional) : U.fmtQty(o.qty) }),
        el('td', { class: 'num', text: o.limitPrice == null ? '—' : U.fmtUSD(o.limitPrice) }),
        el('td', {}, status),
        el('td', {}, cancel),
      ]));
    }
    host.appendChild(t);
    renderRejected(host, pf);
  }

  /**
   * Orders that reached their price but could not be filled. They are shown
   * rather than dropped so the reason is always visible somewhere.
   */
  function renderRejected(host, pf) {
    const rejected = pf.rejected || [];
    if (!rejected.length) return;

    const head = el('div', { class: 'panel__head' }, [
      el('div', { class: 'panel__title', text: 'Could not fill' }),
      el('div', { style: 'flex:1' }),
    ]);
    const clear = el('button', { class: 'btn btn--ghost btn--sm', text: 'Dismiss' });
    clear.addEventListener('click', () => { pf.rejected = []; A.save(); renderBlotter(); });
    head.appendChild(clear);
    host.appendChild(head);

    const { t, tbody } = table(['Rejected', 'Symbol', 'Side', 'Qty', 'Limit', 'Reason', '']);
    for (const o of rejected.slice().reverse()) {
      tbody.appendChild(el('tr', {}, [
        el('td', { class: 'table__sub', text: U.fmtDateTime(o.rejectedAt || o.createdAt) }),
        el('td', {}, el('span', { class: 'table__sym', text: o.assetId })),
        el('td', {}, el('span', { class: 'badge ' + (o.side === 'buy' ? 'badge--up' : 'badge--down'), text: o.side })),
        el('td', { class: 'num', text: U.fmtQty(o.qty) }),
        el('td', { class: 'num', text: o.limitPrice ? U.fmtUSD(o.limitPrice) : '—' }),
        el('td', { class: 'table__sub', style: 'text-align:left;white-space:normal', text: o.rejectedReason || 'unknown' }),
        el('td', {}, ''),
      ]));
    }
    host.appendChild(t);
  }

  function renderHistory(host, pf) {
    if (!pf.fills.length) {
      host.appendChild(UI.emptyState('clock', 'No trades yet',
        'Every fill is logged here with its timestamp, price and realized P&L.'));
      return;
    }
    const { t, tbody } = table(['Time', 'Symbol', 'Side', 'Qty', 'Price', 'Value', 'Realized']);
    for (const f of pf.fills.slice().reverse().slice(0, 400)) {
      tbody.appendChild(el('tr', {}, [
        el('td', { class: 'table__sub', text: U.fmtDateTime(f.t) }),
        el('td', {}, el('span', { class: 'table__sym', text: f.assetId })),
        el('td', {}, el('span', { class: 'badge ' + (f.side === 'buy' ? 'badge--up' : 'badge--down'), text: f.side })),
        el('td', { class: 'num', text: U.fmtQty(f.qty) }),
        el('td', { class: 'num', text: U.fmtUSD(f.price) }),
        el('td', { class: 'num', text: U.fmtUSD(f.notional, { fixed2: true }) }),
        el('td', { class: 'num ' + (f.side === 'sell' ? U.dirClass(f.realized) : 'dimmer'), text: f.side === 'sell' ? U.fmtSigned(f.realized) : '—' }),
      ]));
    }
    host.appendChild(t);
  }

  /* ============================== order entry ============================ */

  function buildOrderPane() {
    const assetId = S.focus;
    const asset = PT.byId[assetId];
    if (!asset) return;
    R.orderpane.innerHTML = '';

    R.orderpane.appendChild(el('div', { class: 'panel__head' }, [
      el('div', { class: 'panel__title', text: 'Order ticket' }),
      el('div', { style: 'flex:1' }),
      el('span', { class: 'badge badge--accent', text: assetId }),
    ]));

    const form = el('div', { class: 'order__form' });

    /* side */
    const sideSeg = el('div', { class: `seg seg--full seg--${S.order.side}` });
    R.sideBtns = {};
    for (const side of ['buy', 'sell']) {
      const b = el('button', {
        class: 'seg__item' + (S.order.side === side ? ' is-active' : ''),
        text: side === 'buy' ? 'Buy' : 'Sell',
      });
      b.addEventListener('click', () => { S.order.side = side; buildOrderPane(); });
      R.sideBtns[side] = b;
      sideSeg.appendChild(b);
    }
    form.appendChild(sideSeg);

    /* type */
    const typeSeg = el('div', { class: 'seg seg--full' });
    for (const type of ['market', 'limit']) {
      const b = el('button', {
        class: 'seg__item' + (S.order.type === type ? ' is-active' : ''),
        text: type === 'market' ? 'Market' : 'Limit',
      });
      b.addEventListener('click', () => { S.order.type = type; buildOrderPane(); });
      typeSeg.appendChild(b);
    }
    form.appendChild(typeSeg);

    /* limit price */
    if (S.order.type === 'limit') {
      const q = A.prices()[assetId];
      R.limitInput = el('input', {
        class: 'input num', type: 'number', step: 'any', min: '0',
        placeholder: q ? String(U.round(q.price, q.price < 1 ? 6 : 2)) : '0.00',
        value: q ? String(U.round(q.price, q.price < 1 ? 6 : 2)) : '',
      });
      R.limitInput.addEventListener('input', updateEstimate);
      form.appendChild(el('div', { class: 'field' }, [
        el('div', { class: 'field__label' }, ['Limit price', el('span', { class: 'dimmer', text: 'USD' })]),
        R.limitInput,
      ]));
    } else {
      R.limitInput = null;
    }

    /* size mode */
    const sizeSeg = el('div', { class: 'seg seg--full' });
    for (const [mode, label] of [['notional', 'Dollars'], ['qty', asset.kind === 'crypto' ? 'Coins' : 'Shares']]) {
      const b = el('button', {
        class: 'seg__item' + (S.order.sizeMode === mode ? ' is-active' : ''), text: label,
      });
      b.addEventListener('click', () => { S.order.sizeMode = mode; buildOrderPane(); });
      sizeSeg.appendChild(b);
    }
    form.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'field__label' }, 'Size by'), sizeSeg,
    ]));

    /* amount */
    R.amountInput = el('input', {
      class: 'input num', type: 'number', step: 'any', min: '0',
      placeholder: S.order.sizeMode === 'notional' ? '0.00' : '0',
    });
    R.amountInput.addEventListener('input', updateEstimate);
    R.amountInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitOrder(); });
    form.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'field__label' }, [
        S.order.sizeMode === 'notional' ? 'Amount' : 'Quantity',
        el('span', { class: 'dimmer', text: S.order.sizeMode === 'notional' ? 'USD' : assetId }),
      ]),
      el('div', { class: 'input-group' }, [
        R.amountInput,
        el('span', { class: 'input-group__suffix', text: S.order.sizeMode === 'notional' ? 'USD' : assetId }),
      ]),
    ]));

    /* quick sizing */
    const quick = el('div', { class: 'order__quick' });
    for (const pct of [25, 50, 75, 100]) {
      const b = el('button', { class: 'btn btn--sm', text: pct === 100 ? 'Max' : pct + '%' });
      b.addEventListener('click', () => applyQuickSize(pct / 100));
      quick.appendChild(b);
    }
    form.appendChild(quick);

    /* estimate */
    R.estLines = el('div', { class: 'order__summary' });
    form.appendChild(R.estLines);

    R.orderError = el('div', { class: 'order__err hidden' });
    form.appendChild(R.orderError);

    R.orderpane.appendChild(form);

    /* submit */
    R.submitBtn = el('button', {
      class: `btn btn--lg btn--block btn--${S.order.side}`,
      text: `${S.order.side === 'buy' ? 'Buy' : 'Sell'} ${assetId}`,
    });
    R.submitBtn.addEventListener('click', submitOrder);

    R.buyingPower = el('div', { class: 'order__line', style: 'margin-top:8px' }, [
      el('span', { class: 'k', text: S.order.side === 'buy' ? 'Buying power' : 'Position' }),
      el('span', { class: 'v num', text: '—' }),
    ]);

    R.orderpane.appendChild(el('div', { class: 'order__foot' }, [R.submitBtn, R.buyingPower]));
    updateEstimate();
  }

  /**
   * The price an order would actually transact at. Quick-size buttons and the
   * cost estimate must agree on this: if sizing used the raw quote while the
   * estimate applied simulated slippage, a "Max" sell would ask for marginally
   * more than the position holds and be rejected.
   */
  function referencePrice(side) {
    const q = A.prices()[S.focus];
    if (!q || !isFinite(q.price)) return null;
    if (S.order.type === 'limit' && R.limitInput) {
      const lp = Number(R.limitInput.value);
      if (lp > 0) return lp;
    }
    return E.effectivePrice(S.focus, side, q.price, S.st.settings.slippageEnabled);
  }

  function applyQuickSize(fraction) {
    const assetId = S.focus;
    const ref = referencePrice(S.order.side);
    if (!ref) return;
    const pf = A.pfUser();

    if (S.order.side === 'buy') {
      // Size against spendable cash: raw cash would produce an order the
      // engine immediately rejects whenever a limit order holds a reservation.
      const cash = E.availableCash(pf, A.prices()) * fraction;
      R.amountInput.value = S.order.sizeMode === 'notional'
        ? String(Math.floor(cash * 100) / 100)
        : String(U.floorQty(cash / ref, PT.assetKind(assetId)));
    } else {
      const pos = pf.positions[assetId];
      if (!pos) { R.amountInput.value = '0'; updateEstimate(); return; }
      const sellable = E.availableQty(pf, assetId);

      /*
       * "Max" on a sell means close the position, so it is always sized by
       * quantity. Going through dollars would floor to the cent and leave a
       * dust quantity behind, and the position would never actually close.
       */
      if (fraction >= 1) {
        if (S.order.sizeMode !== 'qty') {
          S.order.sizeMode = 'qty';
          buildOrderPane();
        }
        R.amountInput.value = String(U.roundQty(sellable, pos.kind));
        updateEstimate();
        return;
      }

      const qty = U.roundQty(sellable * fraction, pos.kind);
      // Floor the dollar figure so converting it back can never exceed `qty`.
      R.amountInput.value = S.order.sizeMode === 'notional'
        ? String(Math.floor(qty * ref * 100) / 100) : String(qty);
    }
    updateEstimate();
  }

  /** Preview the order without mutating anything, surfacing the same errors. */
  function updateEstimate() {
    if (!R.estLines) return;
    const assetId = S.focus;
    const asset = PT.byId[assetId];
    const q = A.prices()[assetId];
    const pf = A.pfUser();
    const kind = PT.assetKind(assetId);

    R.estLines.innerHTML = '';
    const line = (k, v, cls) => R.estLines.appendChild(el('div', { class: 'order__line' + (cls ? ' ' + cls : '') }, [
      el('span', { class: 'k', text: k }), el('span', { class: 'v num', text: v }),
    ]));

    const marketOpen = A.marketOpenFor(assetId);
    const raw = Number(R.amountInput ? R.amountInput.value : 0);
    const limitPrice = R.limitInput ? Number(R.limitInput.value) : null;
    const refPrice = referencePrice(S.order.side);

    let qty = 0, notional = 0;
    if (refPrice && raw > 0) {
      if (S.order.sizeMode === 'notional') { notional = raw; qty = U.roundQty(raw / refPrice, kind); }
      else { qty = U.roundQty(raw, kind); notional = qty * refPrice; }
    }

    line('Last price', q && isFinite(q.price) ? U.fmtUSD(q.price) : '—');
    line(S.order.type === 'limit' ? 'Limit price' : 'Est. fill', refPrice ? U.fmtUSD(refPrice) : '—');
    line(kind === 'crypto' ? 'Coins' : 'Shares', qty > 0 ? U.fmtQty(qty) : '—');
    line('Estimated total', notional > 0 ? U.fmtUSD(notional, { fixed2: true }) : '—', 'order__line--total');

    if (R.buyingPower) {
      const v = R.buyingPower.querySelector('.v');
      const k = R.buyingPower.querySelector('.k');
      if (S.order.side === 'buy') {
        // Show what can actually be spent. Showing raw cash while the engine
        // validates against the free balance is how money looks "stuck".
        const free = E.availableCash(pf, A.prices());
        const reserved = pf.cash - free;
        k.textContent = 'Buying power';
        v.textContent = U.fmtUSD(free, { fixed2: true })
          + (reserved > 0.005 ? `  (${U.fmtUSD(reserved, { fixed2: true })} reserved)` : '');
      } else {
        const free = E.availableQty(pf, assetId);
        const pos = pf.positions[assetId];
        const held = pos ? pos.qty : 0;
        if (held < 0) {
          k.textContent = 'Short position';
          v.textContent = `${U.fmtQty(Math.abs(held))} ${assetId} short`;
        } else if (S.st.settings.shortingEnabled !== false) {
          // Selling past a holding opens a short, so show that headroom too.
          const q = A.prices()[assetId];
          const room = q && isFinite(q.price)
            ? E.availableCash(pf, A.prices()) / (E.SHORT_INITIAL_MARGIN - 1) / q.price : 0;
          k.textContent = 'Can sell';
          v.textContent = `${U.fmtQty(free)} held  ·  up to ${U.fmtQty(free + room)} short`;
        } else {
          k.textContent = 'Available to sell';
          v.textContent = `${U.fmtQty(free)} ${assetId}`;
        }
      }
    }

    /* Validate by building the order against a throwaway copy of the book. */
    let error = null;
    if (raw > 0) {
      try {
        const probe = JSON.parse(JSON.stringify(pf));
        E.buildOrder(probe, {
          assetId, side: S.order.side, type: S.order.type,
          limitPrice: limitPrice,
          [S.order.sizeMode === 'notional' ? 'notional' : 'qty']: raw,
        }, A.orderCtx(assetId));
      } catch (e) { error = e.message; }
    }

    /*
     * A closed session is a note, not an error: the order will be taken and
     * held for the bell. Keep it visually distinct from a real rejection so
     * "this will happen later" never reads as "this failed".
     */
    const willQueue = !error && !marketOpen && !PT.isCrypto(assetId);
    if (error) {
      R.orderError.textContent = error;
      R.orderError.className = 'order__err';
    } else if (willQueue) {
      const openAt = PT.calendar.stockStatus().nextChange;
      R.orderError.textContent = openAt
        ? `${assetId} is closed — this order waits and fills at the open, in ${PT.calendar.untilText(openAt)}.`
        : `${assetId} is closed — this order waits and fills at the next open.`;
      R.orderError.className = 'order__err order__err--note';
    }
    R.orderError.classList.toggle('hidden', !error && !willQueue);
    if (R.submitBtn) R.submitBtn.disabled = !!error || !(raw > 0);
  }

  function submitOrder() {
    const assetId = S.focus;
    const raw = Number(R.amountInput.value);
    if (!(raw > 0)) return;
    const limitPrice = R.limitInput ? Number(R.limitInput.value) : null;

    try {
      const req = {
        assetId, side: S.order.side, type: S.order.type, limitPrice,
        [S.order.sizeMode === 'notional' ? 'notional' : 'qty']: raw,
      };
      const r = E.submitOrder(A.pfUser(), req, A.orderCtx(assetId));

      if (r.fill) {
        UI.toast({
          kind: S.order.side,
          title: `${S.order.side === 'buy' ? 'Bought' : 'Sold'} ${U.fmtQty(r.fill.qty)} ${assetId}`,
          message: `at ${U.fmtUSD(r.fill.price)} · ${U.fmtUSD(r.fill.notional, { fixed2: true })}`
            + (r.fill.side === 'sell' ? ` · realized ${U.fmtSigned(r.fill.realized)}` : ''),
        });
      } else if (r.queued) {
        const openAt = PT.calendar.stockStatus().nextChange;
        const when = openAt
          ? `${U.fmtDateTime(openAt)} (in ${PT.calendar.untilText(openAt)})`
          : 'the next open';
        const size = r.order.notional != null
          ? U.fmtUSD(r.order.notional, { fixed2: true }) + ' of'
          : U.fmtQty(r.order.qty);
        UI.toast({
          kind: 'warn',
          title: 'Queued for the opening bell',
          message: `${r.order.side.toUpperCase()} ${size} ${assetId} `
            + (r.order.type === 'limit'
              ? `will join the book at ${when} and fill at ${U.fmtUSD(r.order.limitPrice)} or better.`
              : `will fill at the opening price on ${when}.`)
            + ' Cancel it any time from Open orders.',
          timeout: 9000,
        });
      } else {
        UI.toast({
          title: 'Limit order placed',
          message: `${r.order.side.toUpperCase()} ${U.fmtQty(r.order.qty)} ${assetId} at ${U.fmtUSD(r.order.limitPrice)}. It rests until the market reaches your price.`,
        });
      }
      R.amountInput.value = '';
      A.save();
      renderAll();
      updateEstimate();
    } catch (e) {
      UI.toast({ kind: 'error', title: 'Order rejected', message: e.message });
      R.orderError.textContent = e.message;
      R.orderError.classList.remove('hidden');
    }
  }

  /* ================================ render =============================== */

  function renderAll() {
    renderTopbar();
    renderStatusbar();
    if (S.view === 'trade') {
      renderSymbolHeader();
      renderBlotter();
      updateEstimate();
    } else if (S.view === 'portfolio') PT.views.renderPortfolioView();
    else if (S.view === 'compare') PT.views.renderCompareView();
  }

  function renderTopbar() {
    A.renderAccountButton();
    const val = E.valuate(A.pfUser(), A.prices());
    const day = E.dayPnl(A.pfUser(), val, PT.calendar.stockStatus().etDate);
    R.topEquity.textContent = U.fmtUSD(val.equity, { fixed2: true });
    if (day.pending) {
      // The book is not fully priced yet; showing 0.00 would be a claim we
      // cannot support, so say nothing until the quotes land.
      R.topDay.textContent = '—';
      R.topDay.className = 'v num dim';
    } else {
      R.topDay.textContent = `${U.fmtSigned(day.change)} (${U.fmtPct(day.changePct)})`;
      R.topDay.className = 'v num ' + U.dirClass(day.change);
    }

    const st = PT.calendar.stockStatus();
    R.session.className = `session session--${st.phase}`;
    R.session.innerHTML = '';
    R.session.append(
      el('span', { class: 'dot' + (st.isOpen ? ' dot--pulse' : '') }),
      el('span', { class: 'session__label', text: st.label }),
      st.nextChange ? el('span', { class: 'dim num', text: `${st.nextLabel} in ${PT.calendar.untilText(st.nextChange)}` }) : null,
    );

    const fs = PT.feed.status;
    R.feedBadge.className = 'badge ' + (fs.cryptoLive ? 'badge--live' : fs.serverUp ? 'badge--delayed' : 'badge--closed');
    R.feedBadge.innerHTML = '';
    R.feedBadge.append(
      el('span', { class: 'dot' + (fs.cryptoLive ? ' dot--pulse' : '') }),
      fs.cryptoLive ? 'Live feed' : fs.serverUp ? 'Polling' : 'Offline',
    );
  }

  function renderSymbolHeader() {
    if (!R.symChg) return;
    const q = A.prices()[S.focus];
    UI.setPrice(R.symLast, q ? q.price : null, (v) => (v == null ? '—' : U.fmtUSD(v)));
    R.symChg.textContent = q ? `${UI.changeText(q.changePct)}  ${q.change != null ? U.fmtSigned(q.change) : ''}` : '—';
    R.symChg.className = 'symhead__chg num ' + U.dirClass(q ? q.changePct : 0);

    R.symBadge.innerHTML = '';
    R.symBadge.appendChild(UI.statusBadge(PT.feed.grade(q, S.focus), q ? q.source : null));

    R.symStats.innerHTML = '';
    const stat = (k, v) => R.symStats.appendChild(el('div', { class: 'symhead__stat' }, [
      el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }),
    ]));
    if (q) {
      const isCrypto = PT.isCrypto(S.focus);
      /*
       * Nasdaq's quote carries no range or volume. Rather than show three
       * dashes, derive them from the newest daily candle we already hold —
       * real data from the same source, just a different endpoint.
       */
      const daily = S.candleCache[S.focus + ':1D'];
      const bar = !isCrypto && daily && daily.length ? daily[daily.length - 1] : null;
      const high = q.dayHigh != null ? q.dayHigh : (bar ? bar.h : null);
      const low = q.dayLow != null ? q.dayLow : (bar ? bar.l : null);
      const vol = q.volume != null ? q.volume : (bar ? bar.v : null);
      // "24h" is a rolling window and only true for crypto; equities have a session.
      const label = isCrypto ? '24h' : 'Day';

      stat(`${label} high`, high ? U.fmtUSD(high) : '—');
      stat(`${label} low`, low ? U.fmtUSD(low) : '—');
      stat('Volume', vol ? U.fmtCompact(vol) : '—');
      const pos = A.pfUser().positions[S.focus];
      if (pos) stat('Your position', `${U.fmtQty(pos.qty)} @ ${U.fmtUSD(pos.avgCost)}`);
    }
  }

  function renderStatusbar() {
    const fs = PT.feed.status;
    R.stFeed.innerHTML = '';
    R.stFeed.append(
      el('span', { class: fs.cryptoLive ? 'up' : 'dim' }, '●'),
      ` crypto: ${fs.cryptoLive ? `coinbase ws (${fs.wsProducts})` : fs.ws}`,
    );
    const st = PT.calendar.stockStatus();
    R.stMarket.textContent = `stocks: ${st.label.toLowerCase()} · ${st.etTime} ET`;
    R.stCounts.textContent = `${fs.counters.ticks.toLocaleString()} ticks · ${fs.counters.polls} polls`;
    R.stClock.textContent = U.fmtTime(Date.now());
  }

  PT.views = Object.assign(PT.views || {}, {
    buildChartPane, loadChart, buildBlotter, renderBlotter, buildOrderPane,
    updateEstimate, renderAll, renderTopbar, renderSymbolHeader, renderStatusbar,
    table, TIMEFRAMES, tickSeriesState, showChartMsg, bindDrawings, setDrawMode, setDrawTool,
  });
})(window.PT);
