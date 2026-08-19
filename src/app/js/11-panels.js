/* =========================================================================
   Portfolio, scoreboard (you vs the AI), AI companion, settings, onboarding.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const UI = PT.ui;
  const E = PT.engine;
  const C = PT.companion;
  const el = U.el;
  const icon = UI.icon;
  const A = PT.app;
  const { S, R } = A;

  const SERIES_COLORS = { user: '#4c82f7', ai: '#9d7bff' };

  /* ============================= portfolio =============================== */

  function renderPortfolioView() {
    // These views replace the chart pane's contents. Without an explicit
    // teardown the canvases stay detached but alive, and every incoming tick
    // keeps repainting them off-screen.
    if (S.chart) { S.chart.destroy(); S.chart = null; S.bars = null; }
    const host = R.chartpane;
    const pf = A.pfUser();
    const val = E.valuate(pf, A.prices());
    const day = E.dayPnl(pf, val, PT.calendar.stockStatus().etDate);
    const stats = E.stats(pf, val);
    const pa = C.analyzePortfolio(val, day, stats);

    host.innerHTML = '';
    const view = el('div', { class: 'pfview' });

    /* hero */
    const alloc = el('div', { class: 'allocation' });
    const investedPct = val.equity > 0 ? (val.invested / val.equity) * 100 : 0;
    const cashPct = 100 - investedPct;
    alloc.append(
      el('div', { class: 'label', text: 'Cash vs invested' }),
      el('div', { class: 'alloc__bar' }, [
        el('div', { class: 'alloc__seg', style: `width:${investedPct}%;background:var(--accent)` }),
        el('div', { class: 'alloc__seg', style: `width:${cashPct}%;background:var(--surface-4)` }),
      ]),
      el('div', { class: 'alloc__legend' }, [
        el('span', { class: 'alloc__key' }, [
          el('span', { class: 'alloc__swatch', style: 'background:var(--accent)' }),
          `Invested ${U.fmtUSD(val.invested, { fixed2: true })} (${investedPct.toFixed(1)}%)`,
        ]),
        el('span', { class: 'alloc__key' }, [
          el('span', { class: 'alloc__swatch', style: 'background:var(--surface-4)' }),
          `Cash ${U.fmtUSD(val.cash, { fixed2: true })} (${cashPct.toFixed(1)}%)`,
        ]),
      ]),
    );

    view.appendChild(el('div', { class: 'pfhero' }, [
      el('div', { class: 'pfhero__main' }, [
        el('div', { class: 'label', text: 'Total portfolio value' }),
        el('div', { class: 'pfhero__value num', text: U.fmtUSD(val.equity, { fixed2: true }) }),
        el('div', { class: 'pfhero__row' }, [
          el('span', { class: U.dirClass(val.totalReturn), text: `${U.fmtSigned(val.totalReturn)} (${U.fmtPct(val.totalReturnPct)})` }),
          el('span', { class: 'dimmer', text: 'all time' }),
          el('span', { class: 'dimmer', text: '·' }),
          el('span', {
            class: day.pending ? 'dim' : U.dirClass(day.change),
            text: day.pending ? '—' : `${U.fmtSigned(day.change)} (${U.fmtPct(day.changePct)})`,
          }),
          el('span', { class: 'dimmer', text: 'today' }),
        ]),
      ]),
      el('div', { class: 'pfhero__spacer' }),
      alloc,
    ]));

    /* stat strip */
    const stats6 = el('div', { class: 'stats', style: 'grid-template-columns:repeat(auto-fit,minmax(150px,1fr))' });
    const tile = (label, value, sub, cls) => stats6.appendChild(el('div', { class: 'stat' }, [
      el('div', { class: 'stat__label', text: label }),
      el('div', { class: 'stat__value num ' + (cls || ''), text: value }),
      sub ? el('div', { class: 'stat__sub', text: sub }) : null,
    ]));
    tile('Unrealized P&L', U.fmtSigned(val.unrealized), U.fmtPct(val.unrealizedPct), U.dirClass(val.unrealized));
    tile('Realized P&L', U.fmtSigned(val.realized), `${stats.sells} closed trade${stats.sells === 1 ? '' : 's'}`, U.dirClass(val.realized));
    tile('Positions', String(val.positions.length), `${stats.openOrders} open order${stats.openOrders === 1 ? '' : 's'}`);
    tile('Win rate', stats.winRate == null ? '—' : stats.winRate.toFixed(0) + '%',
      stats.winRate == null ? 'no closed trades yet' : `${stats.wins}W / ${stats.losses}L`);
    tile('Max drawdown', stats.maxDrawdownPct >= 0.005 ? '-' + stats.maxDrawdownPct.toFixed(2) + '%' : '—', 'from peak equity');
    tile('Diversification', pa.positionCount ? pa.diversification + '/100' : '—', pa.risk);
    view.appendChild(stats6);

    /* equity curve */
    view.appendChild(el('div', { class: 'panel__head' }, el('div', { class: 'panel__title', text: 'Equity curve' })));
    const curveWrap = el('div', { style: 'height:220px;position:relative;background:var(--bg-void)' });
    view.appendChild(curveWrap);

    /* positions */
    view.appendChild(el('div', { class: 'panel__head' }, el('div', { class: 'panel__title', text: 'Holdings' })));
    const posHost = el('div');
    view.appendChild(posHost);

    host.appendChild(view);

    if (S.equityChart) { S.equityChart.destroy(); S.equityChart = null; }
    S.equityChart = new PT.chart.EquityChart(curveWrap);
    S.equityChart.setSeries([{ name: 'You', color: SERIES_COLORS.user, points: pf.equity }]);

    PT.views.renderPositionsInto(posHost, val);
  }

  /* ============================== scoreboard ============================= */

  function renderCompareView() {
    // These views replace the chart pane's contents. Without an explicit
    // teardown the canvases stay detached but alive, and every incoming tick
    // keeps repainting them off-screen.
    if (S.chart) { S.chart.destroy(); S.chart = null; S.bars = null; }
    const host = R.chartpane;
    const user = A.pfUser();
    const ai = A.pfAI();
    const uv = E.valuate(user, A.prices());
    const av = E.valuate(ai, A.prices());
    const us = E.stats(user, uv);
    const as = E.stats(ai, av);

    host.innerHTML = '';
    const view = el('div', { class: 'compare' });

    const leading = uv.totalReturnPct > av.totalReturnPct ? 'user'
      : av.totalReturnPct > uv.totalReturnPct ? 'ai' : null;

    view.appendChild(el('div', { class: 'score' }, [
      el('div', { class: 'score__side' }, [
        el('div', { class: 'score__who' }, [el('span', { class: 'dot', style: `color:${SERIES_COLORS.user}` }), 'You']),
        el('div', { class: 'score__val num', text: U.fmtUSD(uv.equity, { fixed2: true }) }),
        el('div', { class: 'score__ret num ' + U.dirClass(uv.totalReturnPct), text: U.fmtPct(uv.totalReturnPct) }),
      ]),
      el('div', { class: 'score__vs', text: 'VS' }),
      el('div', { class: 'score__side score__side--ai' }, [
        el('div', { class: 'score__who' }, ['AI Trader', el('span', { class: 'dot', style: `color:${SERIES_COLORS.ai}` })]),
        el('div', { class: 'score__val num', text: U.fmtUSD(av.equity, { fixed2: true }) }),
        el('div', { class: 'score__ret num ' + U.dirClass(av.totalReturnPct), text: U.fmtPct(av.totalReturnPct) }),
      ]),
    ]));

    const lead = Math.abs(uv.totalReturnPct - av.totalReturnPct);
    // Below a hundredth of a percent the gap rounds to 0.00% — saying "ahead by
    // 0.00%" is worse than saying they are level.
    view.appendChild(el('div', {
      style: 'text-align:center;padding:0 0 12px;font-size:12px;color:var(--text-secondary)',
    }, leading && lead >= 0.005
      ? `${leading === 'user' ? 'You are' : 'The AI is'} ahead by ${U.fmtPct(lead).replace('+', '')} of return.`
      : 'Neck and neck so far.'));

    /* metric comparison */
    const metrics = el('div', { class: 'score__metrics' });
    const row = (label, a, b, better) => {
      const aWin = better === 'a', bWin = better === 'b';
      metrics.append(
        el('div', { class: 'a' + (aWin ? ' win' : ''), text: a }),
        el('div', { class: 'k', text: label }),
        el('div', { class: 'b' + (bWin ? ' win' : ''), text: b }),
      );
    };
    const cmp = (x, y, higherIsBetter = true) => {
      if (x == null || y == null || x === y) return null;
      const xBetter = higherIsBetter ? x > y : x < y;
      return xBetter ? 'a' : 'b';
    };
    row('Total return', U.fmtPct(uv.totalReturnPct), U.fmtPct(av.totalReturnPct), cmp(uv.totalReturnPct, av.totalReturnPct));
    row('Realized P&L', U.fmtSigned(uv.realized), U.fmtSigned(av.realized), cmp(uv.realized, av.realized));
    row('Unrealized P&L', U.fmtSigned(uv.unrealized), U.fmtSigned(av.unrealized), cmp(uv.unrealized, av.unrealized));
    row('Trades', String(us.trades), String(as.trades), null);
    row('Win rate', us.winRate == null ? '—' : us.winRate.toFixed(0) + '%',
      as.winRate == null ? '—' : as.winRate.toFixed(0) + '%', cmp(us.winRate, as.winRate));
    row('Max drawdown', us.maxDrawdownPct.toFixed(2) + '%', as.maxDrawdownPct.toFixed(2) + '%',
      cmp(us.maxDrawdownPct, as.maxDrawdownPct, false));
    row('Positions', String(us.positions), String(as.positions), null);
    row('Cash', U.fmtUSD(uv.cash, { fixed2: true }), U.fmtUSD(av.cash, { fixed2: true }), null);
    view.appendChild(metrics);

    /* overlaid equity curves */
    view.appendChild(el('div', { class: 'panel__head' }, [
      el('div', { class: 'panel__title', text: 'Equity curves' }),
      el('div', { style: 'flex:1' }),
      el('span', { class: 'dimmer', style: 'font-size:10px' }, 'both portfolios started at ' + U.fmtUSD(S.st.startingCash, { fixed2: true })),
    ]));
    const wrap = el('div', { style: 'height:260px;position:relative;background:var(--bg-void)' });
    view.appendChild(wrap);

    /* AI trade log */
    view.appendChild(el('div', { class: 'panel__head' }, [
      el('div', { class: 'panel__title', text: 'AI decision log' }),
      el('div', { style: 'flex:1' }),
      el('span', { class: 'dimmer', style: 'font-size:10px' },
        S.st.settings.aiTraderEnabled
          ? `runs every ${Math.round(S.st.settings.aiIntervalMs / 1000)}s`
          : 'paused'),
    ]));
    const logHost = el('div', { style: 'padding:12px' });
    view.appendChild(logHost);

    host.appendChild(view);

    if (S.equityChart) { S.equityChart.destroy(); S.equityChart = null; }
    S.equityChart = new PT.chart.EquityChart(wrap);
    S.equityChart.setSeries([
      { name: 'You', color: SERIES_COLORS.user, points: user.equity },
      { name: 'AI Trader', color: SERIES_COLORS.ai, points: ai.equity },
    ]);

    renderTradeLog(logHost, 30);
  }

  function renderTradeLog(host, limit) {
    host.innerHTML = '';
    const log = S.st.aiLog.slice(-limit).reverse();
    if (!log.length) {
      host.appendChild(UI.emptyState('ai', 'The AI has not decided anything yet',
        'Every decision it makes — including the choice to hold — gets logged here with the numbers behind it.'));
      return;
    }
    const list = el('div', { class: 'tradelog' });
    for (const d of log) {
      const kind = d.action === 'buy' ? 'buy' : d.action === 'sell' ? 'sell' : 'hold';
      const item = el('div', { class: `logitem logitem--${kind}` }, [
        el('div', { class: 'logitem__head' }, [
          el('span', { class: 'logitem__action ' + (d.action === 'buy' ? 'up' : d.action === 'sell' ? 'down' : 'dim'), text: d.action }),
          d.assetId ? el('span', { class: 'logitem__sym', text: d.assetId }) : null,
          d.qty ? el('span', { class: 'dim num', style: 'font-size:11px', text: `${U.fmtQty(d.qty)} @ ${U.fmtUSD(d.price)}` }) : null,
          d.realized != null ? el('span', {
            class: 'num ' + U.dirClass(d.realized), style: 'font-size:11px',
            text: U.fmtSigned(d.realized),
          }) : null,
          el('div', { class: 'logitem__spacer' }),
          el('span', { class: 'logitem__time', text: U.fmtDateTime(d.t) }),
        ]),
        el('div', { class: 'logitem__why', text: d.why }),
        d.factors && d.factors.length ? el('div', { class: 'logitem__factors' },
          d.factors.map((f) => el('span', {
            class: 'factor' + (f.dir > 0 ? ' factor--pos' : f.dir < 0 ? ' factor--neg' : ''),
            text: `${f.k}: ${f.v}`,
          }))) : null,
      ]);
      list.appendChild(item);
    }
    host.appendChild(list);
  }

  /* ============================ AI companion ============================= */

  const SUGGESTIONS = [
    'How is my portfolio doing?',
    'What is moving on my watchlist?',
    'Analyze ' ,
    'What is RSI?',
    'Explain limit orders',
    'What is a stop loss?',
  ];

  function renderAIView() {
    // These views replace the chart pane's contents. Without an explicit
    // teardown the canvases stay detached but alive, and every incoming tick
    // keeps repainting them off-screen.
    if (S.chart) { S.chart.destroy(); S.chart = null; S.bars = null; }
    const host = R.chartpane;
    host.innerHTML = '';

    const view = el('div', { class: 'ai' });
    view.appendChild(el('div', { class: 'panel__head' }, [
      el('div', { class: 'panel__title', text: 'AI companion' }),
      el('div', { style: 'flex:1' }),
      el('span', {
        class: 'badge ' + (S.llmReady ? 'badge--accent' : 'badge--sim'),
        title: S.llmReady
          ? 'A language model is available and will be given the computed evidence.'
          : 'No model API key is configured, so every answer is computed directly from indicators.',
      }, S.llmReady ? 'Model + computed' : 'Computed analytics'),
    ]));

    R.aiBody = el('div', { class: 'ai__body' });
    view.appendChild(R.aiBody);

    const chips = el('div', { class: 'ai__chips' });
    for (const s of SUGGESTIONS) {
      const label = s === 'Analyze ' ? `Analyze ${S.focus}` : s;
      const chip = el('button', { class: 'ai__chip', text: label });
      chip.addEventListener('click', () => ask(label));
      chips.appendChild(chip);
    }
    view.appendChild(chips);

    R.aiInput = el('input', {
      class: 'input', type: 'text', placeholder: 'Ask about your positions, a symbol, or a concept…',
    });
    R.aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && R.aiInput.value.trim()) ask(R.aiInput.value.trim());
    });
    const send = el('button', { class: 'btn btn--primary btn--icon' }, icon('send', 15));
    send.addEventListener('click', () => { if (R.aiInput.value.trim()) ask(R.aiInput.value.trim()); });
    view.appendChild(el('div', { class: 'ai__composer' }, [R.aiInput, send]));

    host.appendChild(view);

    if (!S.aiChat.length) {
      pushMessage('assistant', [
        el('p', {}, [
          'I read your book and the live tape and tell you what the numbers say. ',
          el('strong', {}, 'Everything I state is computed'), ' from real candles — RSI, MACD, Bollinger, ATR, moving averages — and I show my work.',
        ]),
        el('p', { class: 'dim' }, 'Ask about your portfolio, any symbol you are watching, or a trading concept you want explained.'),
      ]);
    } else {
      for (const m of S.aiChat) renderMessage(m.role, m.nodes ? m.nodes() : [el('p', {}, m.text)], m.meta);
    }
  }

  function pushMessage(role, nodes, meta) {
    S.aiChat.push({ role, nodes: () => nodes, meta });
    if (S.aiChat.length > 40) S.aiChat.shift();
    renderMessage(role, nodes, meta);
  }

  function renderMessage(role, nodes, meta) {
    if (!R.aiBody) return;
    const msg = el('div', { class: 'ai__msg' + (role === 'user' ? ' ai__msg--user' : '') }, [
      el('div', { class: 'ai__avatar', text: role === 'user' ? 'YOU' : 'AI' }),
      el('div', { class: 'ai__content' }, [
        ...(Array.isArray(nodes) ? nodes : [nodes]),
        meta ? el('div', { class: 'ai__meta', text: meta }) : null,
      ]),
    ]);
    R.aiBody.appendChild(msg);
    R.aiBody.scrollTop = R.aiBody.scrollHeight;
  }

  const para = (text) => el('p', {}, text);
  const bullets = (items) => el('ul', {}, items.map((t) => el('li', {}, t)));

  async function ask(question) {
    if (R.aiInput) R.aiInput.value = '';
    pushMessage('user', [para(question)]);
    const q = question.toLowerCase();

    // 1. A concept question gets the knowledge base.
    const concept = /what is|explain|define|how does|what does/.test(q) ? C.explainConcept(q) : null;
    if (concept) {
      pushMessage('assistant', [
        el('p', {}, [el('strong', {}, concept.term.replace(/^./, (c) => c.toUpperCase())), ' — ', concept.text]),
      ], 'From the built-in glossary');
      return;
    }

    // 2. Portfolio questions.
    if (/portfolio|my position|holding|how am i|p&l|pnl|doing|performance/.test(q)) {
      const pf = A.pfUser();
      const val = E.valuate(pf, A.prices());
      const day = E.dayPnl(pf, val, PT.calendar.stockStatus().etDate);
      const pa = C.analyzePortfolio(val, day, E.stats(pf, val));
      const brief = C.briefPortfolio(pa, val);
      const nodes = [el('p', {}, [el('strong', {}, brief.headline)]), bullets(brief.body)];
      await withOptionalModel(nodes, question, { portfolio: summarisePortfolio(val, pa) },
        'Computed from your live positions');
      return;
    }

    // 3. A symbol mentioned by name.
    const symbol = findSymbol(question);
    if (symbol) {
      const tf = companionTf();
      const bars = await ensureBars(symbol, tf);
      const brief = C.briefAsset(symbol, bars, A.prices()[symbol], tf);
      const nodes = [el('p', {}, [el('strong', {}, brief.headline)]), bullets(brief.body)];
      if (brief.signal) nodes.push(signalReadout(brief.signal, brief.indicators));
      await withOptionalModel(nodes, question,
        { symbol, timeframe: tf, indicators: compactIndicators(brief.indicators), signal: brief.signal },
        brief.indicators ? `Computed from ${brief.indicators.bars} ${tf} candles` : 'Awaiting data');
      return;
    }

    // 4. What is moving.
    if (/moving|movers|watchlist|trend|momentum|scan/.test(q)) {
      const entries = [];
      const tf = companionTf();
      for (const id of S.st.watchlist.slice(0, 8)) {
        entries.push({ assetId: id, bars: await ensureBars(id, tf), quote: A.prices()[id] });
      }
      const scan = C.scanMovers(entries);
      if (!scan.length) {
        pushMessage('assistant', [para('I do not have enough candle history yet to rank your watchlist. Give the feed a moment.')]);
        return;
      }
      const nodes = [
        el('p', {}, [el('strong', {}, 'Watchlist scan'), ' — ranked by how strongly the indicators lean, not by size of move.']),
        bullets(scan.slice(0, 6).map((s) => {
          const q2 = s.quote;
          return `${s.assetId}: ${s.signal.stance} (${s.signal.confidence}% confidence)`
            + (q2 && isFinite(q2.changePct) ? `, ${U.fmtPct(q2.changePct)} on the day` : '')
            + `. ${s.signal.factors[0] ? s.signal.factors[0].detail + '.' : ''}`;
        })),
      ];
      await withOptionalModel(nodes, question, { scan: scan.slice(0, 6).map((s) => ({ symbol: s.assetId, stance: s.signal.stance, score: +s.signal.score.toFixed(3), confidence: s.signal.confidence })) },
        'Computed across your watchlist');
      return;
    }

    // 5. Nothing matched — say so rather than improvise.
    pushMessage('assistant', [
      para('I could not map that to something I can actually measure. I can help with:'),
      bullets([
        'Your portfolio — performance, concentration, biggest winner or loser',
        'Any symbol you are watching — trend, momentum, volatility, range position',
        'What is moving across your watchlist',
        'Trading concepts — RSI, MACD, limit orders, stop losses, spreads and more',
      ]),
    ]);
  }

  /** Offer the model the computed evidence; fall back silently to the computed prose. */
  async function withOptionalModel(computedNodes, question, evidence, meta) {
    if (!S.llmReady) {
      pushMessage('assistant', computedNodes, meta + ' · rule-based, no model involved');
      return;
    }
    pushMessage('assistant', computedNodes, meta);
    try {
      const text = await C.llmCommentary(question, evidence);
      pushMessage('assistant', text.split(/\n{2,}/).map((p) => para(p)), 'Written by a language model from the computed evidence above');
    } catch (e) {
      // The computed answer already stands; just note the model was unavailable.
      pushMessage('assistant', [el('p', { class: 'dim' }, `(Model commentary unavailable: ${e.message})`)]);
    }
  }

  function signalReadout(sig, ind) {
    const pos = ((sig.score + 1) / 2) * 100;
    const wrap = el('div', { class: 'signal', style: 'margin-top:10px' }, [
      el('div', { class: 'signal__head' }, [
        el('span', { class: 'signal__stance ' + (sig.direction > 0 ? 'up' : sig.direction < 0 ? 'down' : 'flat'), text: sig.stance }),
        el('span', { class: 'dim', style: 'font-size:11px', text: `${sig.confidence}% confidence` }),
      ]),
      el('div', { class: 'signal__bar' }, el('div', { class: 'signal__marker', style: `left:${U.clamp(pos, 0, 100)}%` })),
    ]);
    if (ind) {
      const grid = el('div', { class: 'indicators', style: 'margin-top:10px' });
      const cell = (k, v) => grid.appendChild(el('div', { class: 'indicator' }, [
        el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }),
      ]));
      if (ind.rsi14 != null) cell('RSI 14', ind.rsi14.toFixed(1));
      if (ind.macd) cell('MACD hist', ind.macd.histogram.toFixed(4));
      if (ind.sma20 != null) cell('SMA 20', U.fmtUSD(ind.sma20));
      if (ind.sma50 != null) cell('SMA 50', U.fmtUSD(ind.sma50));
      if (ind.atrPct != null) cell('ATR %', ind.atrPct.toFixed(2) + '%');
      if (ind.volumeRatio != null) cell('Vol ratio', ind.volumeRatio.toFixed(2) + 'x');
      if (ind.realizedVol != null) cell('Realized vol', ind.realizedVol.toFixed(1) + '%');
      if (ind.bollinger) cell('Bollinger %B', (ind.bollinger.percentB * 100).toFixed(0) + '%');
      wrap.appendChild(grid);
    }
    return wrap;
  }

  const compactIndicators = (ind) => (!ind ? null : {
    last: ind.last, rsi14: ind.rsi14, sma20: ind.sma20, sma50: ind.sma50,
    macdHistogram: ind.macd ? ind.macd.histogram : null,
    atrPct: ind.atrPct, roc10: ind.roc10, volumeRatio: ind.volumeRatio,
    realizedVol: ind.realizedVol, bars: ind.bars,
  });

  const summarisePortfolio = (val, pa) => ({
    equity: val.equity, cash: val.cash, invested: val.invested,
    unrealized: val.unrealized, realized: val.realized,
    totalReturnPct: val.totalReturnPct, risk: pa.risk,
    topWeight: pa.concentration.topWeight, topHolding: pa.concentration.top,
    positions: val.positions.map((p) => ({ symbol: p.assetId, value: p.value, pnlPct: p.unrealizedPct })),
  });

  function findSymbol(text) {
    const upper = text.toUpperCase();
    // Prefer an exact token match so "A" inside a sentence cannot match a ticker.
    const tokens = upper.split(/[^A-Z0-9-]+/).filter(Boolean);
    for (const t of tokens) if (PT.byId[t]) return t;
    const lower = text.toLowerCase();
    for (const a of PT.assets) {
      if (a.name && lower.includes(a.name.toLowerCase())) return a.id;
    }
    return null;
  }

  /**
   * Candles for the companion, at the timeframe it will report. The cache is
   * keyed by timeframe so a 15m series cached by the AI cycle is never handed
   * back and described as 5m data.
   */
  async function ensureBars(assetId, tf) {
    const want = tf || companionTf();
    const key = assetId + ':' + want;
    const hit = S.candleCache[key];
    if (hit && hit.length) return hit;
    try {
      const res = await PT.feed.candles(assetId, want);
      S.candleCache[key] = res.bars;
      return res.bars;
    } catch { return []; }
  }

  /** Weekly bars are too coarse for the indicator set; fall back to daily. */
  const companionTf = () => (S.tf === '1W' ? '1D' : S.tf);

  /* =============================== settings ============================== */

  function openSettings() {
    const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

    const slip = el('input', { type: 'checkbox' });
    slip.checked = !!S.st.settings.slippageEnabled;
    slip.addEventListener('change', () => { S.st.settings.slippageEnabled = slip.checked; A.save(); });

    const aiOn = el('input', { type: 'checkbox' });
    aiOn.checked = !!S.st.settings.aiTraderEnabled;
    aiOn.addEventListener('change', () => { S.st.settings.aiTraderEnabled = aiOn.checked; A.save(); });

    const scheme = el('select', { class: 'input' });
    for (const [v, label] of [['standard', 'Green up / red down'], ['inverted', 'Red up / green down'], ['cvd', 'Blue up / amber down (colour-blind safe)']]) {
      scheme.appendChild(el('option', { value: v, text: label, selected: (S.st.settings.directionScheme || 'standard') === v }));
    }
    scheme.addEventListener('change', () => {
      S.st.settings.directionScheme = scheme.value;
      applyDirectionScheme();
      A.save();
    });

    const toggleRow = (label, hint, input) => el('label', {
      style: 'display:flex;gap:12px;align-items:flex-start;cursor:pointer',
    }, [
      input,
      el('div', {}, [
        el('div', { style: 'font-size:13px;font-weight:600', text: label }),
        el('div', { class: 'dim', style: 'font-size:11px;line-height:1.5', text: hint }),
      ]),
    ]);

    body.append(
      toggleRow('Simulate spread and slippage', 'Market orders fill a few basis points into the spread, the way a real fill does. Turning this off makes fills perfectly clean, which flatters your results.', slip),
      toggleRow('Run the autonomous AI trader', 'The AI portfolio trades its own money on a schedule while the app is open. Turning it off freezes its book where it stands.', aiOn),
      el('div', { class: 'field' }, [el('div', { class: 'field__label' }, 'Direction colours'), scheme]),
      el('div', { class: 'disclaimer' }, [
        el('b', {}, 'Paper trading only. '),
        'No real money, no real orders, no brokerage account. Prices are real and delayed or live as labelled, but nothing here is investment advice.',
      ]),
    );

    const reset = el('button', { class: 'btn btn--danger', text: 'Reset portfolio…' });
    reset.addEventListener('click', () => { UI.closeModal(); confirmReset(); });

    UI.modal({
      title: 'Settings',
      width: 520,
      body,
      actions: [reset, el('button', { class: 'btn btn--primary', text: 'Done', onclick: UI.closeModal })],
    });
  }

  function applyDirectionScheme() {
    const s = S.st.settings.directionScheme || 'standard';
    if (s === 'standard') document.documentElement.removeAttribute('data-direction-scheme');
    else document.documentElement.setAttribute('data-direction-scheme', s);
    if (S.chart) S.chart.draw();
    if (S.equityChart) S.equityChart.draw();
  }

  function confirmReset() {
    UI.confirmDialog({
      title: 'Reset everything?',
      message: 'This wipes both portfolios, every position, all trade history and the AI decision log, then asks you to pick a starting balance again. It cannot be undone.',
      confirmLabel: 'Reset portfolio',
      danger: true,
      onConfirm: () => {
        /*
         * `location.reload()` is asynchronous, so a debounced save armed in the
         * last 600ms would otherwise fire after the wipe and write the old book
         * straight back — the reset would silently do nothing.
         */
        S.resetting = true;
        A.save.cancel();
        E.clear();
        location.reload();
      },
    });
  }

  /* ============================== onboarding ============================= */

  const PRESETS = [
    { amount: 1000, label: '$1K', note: 'Tight — every position size matters' },
    { amount: 10000, label: '$10K', note: 'A realistic first account' },
    { amount: 100000, label: '$100K', note: 'Room to diversify properly' },
    { amount: 1000000, label: '$1M', note: 'Go wild, it is not real' },
  ];

  function showOnboarding(onDone) {
    let selected = 10000;
    const root = el('div', { class: 'onboard' });
    const card = el('div', { class: 'onboard__card' });

    const presetNodes = [];
    const customInput = el('input', {
      class: 'input num', type: 'number', min: '100', step: '100', placeholder: 'Custom amount',
    });

    const paint = () => {
      presetNodes.forEach((n, i) => n.classList.toggle('is-active', PRESETS[i].amount === selected));
    };

    const grid = el('div', { class: 'onboard__presets' });
    PRESETS.forEach((p) => {
      const node = el('button', { class: 'preset' }, [
        el('div', { class: 'preset__amt', text: p.label }),
        el('div', { class: 'preset__note', text: p.note }),
      ]);
      node.addEventListener('click', () => { selected = p.amount; customInput.value = ''; paint(); });
      presetNodes.push(node);
      grid.appendChild(node);
    });

    const MIN_CASH = 100;
    const customError = el('div', { class: 'order__err hidden' });

    customInput.addEventListener('input', () => {
      const raw = customInput.value.trim();
      const v = Number(raw);
      customInput.classList.toggle('input--invalid', raw !== '' && !(v >= MIN_CASH));
      if (raw === '' || v >= MIN_CASH) customError.classList.add('hidden');
      if (v >= MIN_CASH) { selected = v; paint(); }
    });

    const start = el('button', { class: 'btn btn--primary btn--lg btn--block', text: 'Start trading' });
    start.addEventListener('click', () => {
      const raw = customInput.value.trim();
      const v = Number(raw);
      // Say so rather than quietly opening an account for a different amount.
      if (raw !== '' && !(v >= MIN_CASH)) {
        customError.textContent = `Minimum starting balance is $${MIN_CASH}. Clear the box to use a preset instead.`;
        customError.classList.remove('hidden');
        customInput.classList.add('input--invalid');
        customInput.focus();
        return;
      }
      root.remove();
      onDone(raw === '' ? selected : v);
    });

    card.append(
      el('div', { class: 'onboard__brand' }, [
        el('span', { class: 'wordmark__dot' }),
        el('span', { style: 'font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:11px;color:var(--text-tertiary)' }, 'Paper Trader'),
      ]),
      el('div', { class: 'onboard__title', text: 'Pick your starting balance' }),
      el('div', { class: 'onboard__sub' },
        'Virtual money, real prices. Stocks and ETFs quote from live market data during US market hours; crypto streams around the clock. You can reset and start over any time.'),
      grid,
      el('div', { class: 'field' }, [
        el('div', { class: 'field__label' }, 'Or set your own'),
        customInput,
        customError,
      ]),
      start,
      el('div', { class: 'onboard__foot' },
        'Paper trading for practice only. No real money is involved, no orders reach a real market, and nothing here is financial advice.'),
    );
    root.appendChild(card);
    document.body.appendChild(root);
    paint();
  }

  /* --------------------------------------------------- shared sub-render */

  function renderPositionsInto(host, val) {
    host.innerHTML = '';
    if (!val.positions.length) {
      host.appendChild(UI.emptyState('wallet', 'No holdings yet',
        'Your positions and their live P&L will appear here once you buy something.'));
      return;
    }
    const { t, tbody } = PT.views.table(['Symbol', 'Qty', 'Avg cost', 'Last', 'Market value', 'Unrealized', '%', 'Weight']);
    for (const p of val.positions) {
      const weight = val.equity > 0 ? (p.value / val.equity) * 100 : 0;
      const priceCell = UI.makePriceCell('');
      A.registerCell(p.assetId, { price: priceCell });
      UI.setPrice(priceCell, p.price);
      const tr = el('tr', { class: 'is-clickable' }, [
        el('td', {}, [
          el('div', { class: 'table__sym', text: p.assetId }),
          el('div', { class: 'table__sub', text: (PT.byId[p.assetId] || {}).name || '' }),
        ]),
        el('td', { class: 'num', text: U.fmtQty(p.qty) }),
        el('td', { class: 'num', text: U.fmtUSD(p.avgCost) }),
        el('td', {}, priceCell),
        el('td', { class: 'num', text: U.fmtUSD(p.value, { fixed2: true }) }),
        el('td', { class: 'num ' + U.dirClass(p.unrealized), text: U.fmtSigned(p.unrealized) }),
        el('td', { class: 'num ' + U.dirClass(p.unrealized), text: U.fmtPct(p.unrealizedPct) }),
        el('td', { class: 'num dim', text: weight.toFixed(1) + '%' }),
      ]);
      tr.addEventListener('click', () => A.setFocus(p.assetId));
      tbody.appendChild(tr);
    }
    host.appendChild(t);
  }

  PT.views = Object.assign(PT.views || {}, {
    renderPortfolioView, renderCompareView, renderAIView, renderTradeLog,
    openSettings, showOnboarding, applyDirectionScheme, renderPositionsInto,
    askCompanion: ask,
  });
})(window.PT);
