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

  const TIMEFRAMES = ['1m', '5m', '15m', '1h', '1D', '1W'];

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

    R.chartSource = el('span', { class: 'dimmer', style: 'font-size:10px' }, '');
    const refresh = el('button', { class: 'btn btn--ghost btn--icon btn--sm', title: 'Reload candles' }, icon('refresh', 13));
    refresh.addEventListener('click', () => loadChart(true));

    R.chartpane.appendChild(el('div', { class: 'charttools' }, [
      tfSeg, modeSeg,
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

  async function loadChart(force) {
    const assetId = S.focus;
    const tf = S.tf;
    if (!S.chart) return;
    R.chartMsg.classList.remove('hidden');
    R.chartMsg.innerHTML = '';
    R.chartMsg.append(el('div', { class: 'spinner' }), 'Loading candles…');

    try {
      const res = await PT.feed.candles(assetId, tf, { force });
      // The user may have moved on while this was in flight.
      if (S.focus !== assetId || S.tf !== tf) return;
      S.bars = res.bars;
      S.barsMeta = res;
      S.candleCache[assetId] = res.bars;
      S.chart.setData(res.bars, tf);
      R.chartMsg.classList.add('hidden');
      R.chartSource.textContent = `${res.bars.length} bars · ${res.source}`;
    } catch (e) {
      if (S.focus !== assetId) return;
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
    const head = el('div', { class: 'blotter__head' });
    R.blotterTabs = {};
    for (const [id, label] of BLOTTER_TABS) {
      const count = el('span', { class: 'tab__count', text: '0' });
      const tab = el('button', { class: 'tab' + (S.blotterTab === id ? ' is-active' : '') }, [label, count]);
      tab.addEventListener('click', () => { S.blotterTab = id; buildBlotter(); });
      R.blotterTabs[id] = { tab, count };
      head.appendChild(tab);
    }
    R.blotter.appendChild(head);
    R.blotterBody = el('div', { class: 'blotter__body scroll' });
    R.blotter.appendChild(R.blotterBody);
    renderBlotter();
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

    R.blotterBody.innerHTML = '';
    if (S.blotterTab === 'positions') renderPositions(R.blotterBody, val);
    else if (S.blotterTab === 'orders') renderOpenOrders(R.blotterBody, pf);
    else renderHistory(R.blotterBody, pf);
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
    const { t, tbody } = table(['Symbol', 'Qty', 'Avg cost', 'Last', 'Market value', 'Unrealized', '%', '']);
    for (const p of val.positions) {
      const priceCell = UI.makePriceCell('');
      const valueCell = el('span', { class: 'num' }, U.fmtUSD(p.value, { fixed2: true }));
      const uplCell = el('span', { class: 'num ' + U.dirClass(p.unrealized) }, U.fmtSigned(p.unrealized));
      const pctCell = el('span', { class: 'num ' + U.dirClass(p.unrealized) }, U.fmtPct(p.unrealizedPct));
      A.registerCell(p.assetId, { price: priceCell });
      UI.setPrice(priceCell, p.price);

      const close = el('button', { class: 'btn btn--sm btn--danger', text: 'Close' });
      close.addEventListener('click', (ev) => { ev.stopPropagation(); closePosition(p); });

      const tr = el('tr', { class: 'is-clickable' }, [
        el('td', {}, [
          el('div', { class: 'table__sym', text: p.assetId }),
          el('div', { class: 'table__sub', text: (PT.byId[p.assetId] || {}).name || '' }),
        ]),
        el('td', { class: 'num', text: U.fmtQty(p.qty) }),
        el('td', { class: 'num', text: U.fmtUSD(p.avgCost) }),
        el('td', {}, [priceCell, p.stale ? el('span', { class: 'badge badge--delayed', style: 'margin-left:6px' }, 'stale') : null]),
        el('td', {}, valueCell),
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
    UI.confirmDialog({
      title: `Close ${p.assetId}?`,
      message: `Sell all ${U.fmtQty(p.qty)} ${p.assetId} at market. Unrealized P&L of ${U.fmtSigned(p.unrealized)} will be realized.`,
      confirmLabel: 'Close position',
      danger: true,
      onConfirm: () => {
        try {
          const r = E.submitOrder(A.pfUser(), {
            assetId: p.assetId, side: 'sell', type: 'market', qty: p.qty,
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
    if (!pf.orders.length) {
      host.appendChild(UI.emptyState('orders', 'No open orders',
        'Limit orders that have not filled yet will rest here until the market reaches your price.'));
      return;
    }
    const { t, tbody } = table(['Placed', 'Symbol', 'Side', 'Type', 'Qty', 'Limit', 'Distance', '']);
    for (const o of pf.orders) {
      const q = A.prices()[o.assetId];
      const dist = q && isFinite(q.price)
        ? ((o.limitPrice - q.price) / q.price) * 100 : null;
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
        el('td', { class: 'num', text: U.fmtQty(o.qty) }),
        el('td', { class: 'num', text: U.fmtUSD(o.limitPrice) }),
        el('td', { class: 'num dim', text: dist == null ? '—' : U.fmtPct(dist) }),
        el('td', {}, cancel),
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
      const cash = pf.cash * fraction;
      R.amountInput.value = S.order.sizeMode === 'notional'
        ? String(Math.floor(cash * 100) / 100)
        : String(U.roundQty(cash / ref, PT.assetKind(assetId)));
    } else {
      const pos = pf.positions[assetId];
      if (!pos) { R.amountInput.value = '0'; updateEstimate(); return; }
      const qty = U.roundQty(pos.qty * fraction, pos.kind);
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
      if (S.order.side === 'buy') v.textContent = U.fmtUSD(pf.cash, { fixed2: true });
      else {
        const pos = pf.positions[assetId];
        v.textContent = pos ? `${U.fmtQty(pos.qty)} ${assetId}` : `0 ${assetId}`;
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
    } else if (!marketOpen && !PT.isCrypto(assetId)) {
      error = 'US equities are closed right now. Crypto trades 24/7.';
    }

    if (error) {
      R.orderError.textContent = error;
      R.orderError.classList.remove('hidden');
    } else {
      R.orderError.classList.add('hidden');
    }
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
    const val = E.valuate(A.pfUser(), A.prices());
    const day = E.dayPnl(A.pfUser(), val, PT.calendar.stockStatus().etDate);
    R.topEquity.textContent = U.fmtUSD(val.equity, { fixed2: true });
    R.topDay.textContent = `${U.fmtSigned(day.change)} (${U.fmtPct(day.changePct)})`;
    R.topDay.className = 'v num ' + U.dirClass(day.change);

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
    R.symBadge.appendChild(UI.statusBadge(PT.feed.grade(q), q ? q.source : null));

    R.symStats.innerHTML = '';
    const stat = (k, v) => R.symStats.appendChild(el('div', { class: 'symhead__stat' }, [
      el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }),
    ]));
    if (q) {
      stat('24h high', q.dayHigh ? U.fmtUSD(q.dayHigh) : '—');
      stat('24h low', q.dayLow ? U.fmtUSD(q.dayLow) : '—');
      stat('Volume', q.volume ? U.fmtCompact(q.volume) : '—');
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
    table, TIMEFRAMES,
  });
})(window.PT);
