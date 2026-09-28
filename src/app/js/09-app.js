/* =========================================================================
   Application: state, shell, views and the run loop.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const UI = PT.ui;
  const E = PT.engine;
  const el = U.el;
  const icon = UI.icon;
  /** View builders, defined in 10-views.js and resolved lazily at call time. */
  const V = new Proxy({}, { get: (_, k) => (...a) => (PT.views && PT.views[k] ? PT.views[k](...a) : undefined) });

  /* --------------------------------------------------------------- state */

  const S = {
    st: null,                // persisted app state
    view: 'trade',
    focus: 'AAPL',
    tf: '5m',
    chartMode: 'candle',
    blotterTab: 'positions',
    order: { side: 'buy', type: 'limit', sizeMode: 'notional' },
    wlTab: 'watchlist',
    aiTab: 'chat',
    drawMode: false,         // is the drawing toolbar showing
    drawTool: null,          // which drawing tool is armed
    chart: null,
    equityChart: null,
    bars: null,              // candles for the focused asset
    barsMeta: null,
    lastCycle: 0,
    aiBusy: false,
    resetting: false,
    cooldowns: Object.create(null),
    // `${assetId}:${tf}` -> bars. The key MUST include the timeframe: the AI
    // cycle caches 15m bars while the chart may be on 5m, and serving one as
    // the other silently changes every indicator the companion reports.
    candleCache: Object.create(null),
    aiChat: [],
    llmReady: false,
    rotateIdx: 0,
  };

  const R = {};   // DOM references
  const priceCells = new Map(); // assetId -> [{node, kind}]

  /*
   * "The user's portfolio" is whichever account is active. Everything that
   * trades, values or renders goes through here, so switching accounts is a
   * single assignment rather than a hunt through the app for `portfolios.user`.
   */
  const pfUser = () => E.activeAccount(S.st);
  const pfAI = () => S.st.portfolios.ai;
  const accounts = () => E.accountIds(S.st).map((id) => S.st.portfolios[id]);
  const prices = () => PT.feed.prices;

  const marketOpenFor = (assetId) =>
    PT.isCrypto(assetId) ? true : PT.calendar.stockStatus().isOpen;

  function orderCtx(assetId) {
    return {
      prices: prices(),
      marketOpen: marketOpenFor(assetId),
      slippageEnabled: S.st.settings.slippageEnabled,
      shortingEnabled: S.st.settings.shortingEnabled !== false,
      now: Date.now(),
    };
  }

  /*
   * One saved book, possibly several open tabs. Every save writes the whole
   * book, so two tabs saving on their own clocks would each keep putting back
   * the copy they loaded and revert the other's trades. So one tab writes at a
   * time — whichever was last opened, looked at or used — and the others follow
   * what it saves until they are used themselves. `rev` numbers the saves, so a
   * tab can tell a newer book from the one it holds.
   */
  const TAB_ID = U.uid('tab');
  const WRITER_KEY = E.STORAGE_KEY + '.writer';
  let writer = false;

  const writerKey = () => { try { return localStorage.getItem(WRITER_KEY); } catch { return null; } };

  const persist = U.debounce(() => {
    if (S.resetting || !writer) return;
    S.st.rev = (S.st.rev || 0) + 1;
    E.save(S.st);
  }, 600);
  /** Debounced persistence. No-ops once a reset is under way. */
  const save = (...a) => {
    if (S.resetting) return;
    // Something changed in this tab, so this is the tab in use.
    claimWriter();
    persist(...a);
  };
  save.cancel = () => persist.cancel();
  /** Write a pending save immediately — used when the page is going away. */
  save.flush = () => { if (!S.resetting) persist.flush(); };
  save.pending = () => persist.pending();

  const isWriter = () => writer;

  /**
   * Become the tab that saves. `catchUp` first takes anything newer another
   * tab saved; a claim made by saving skips that, since it would throw away
   * the change being saved.
   */
  function claimWriter(catchUp) {
    if (writer || !S.st) return;
    if (catchUp) {
      const stored = E.load();
      if (stored && (stored.rev || 0) > (S.st.rev || 0)) adoptBook(stored);
    }
    writer = true;
    try { localStorage.setItem(WRITER_KEY, TAB_ID); } catch { /* no storage: the only tab */ }
  }

  /** Another tab has taken over: hand it anything unsaved, then follow. */
  function yieldWriter() {
    if (!writer) return;
    persist.flush();
    writer = false;
  }

  /** This page is going away: save, and let a tab that remains take over. */
  function releaseWriter() {
    if (!writer) return;
    yieldWriter();
    try { if (writerKey() === TAB_ID) localStorage.removeItem(WRITER_KEY); } catch { /* ignore */ }
  }

  /** Two claims that crossed can leave nobody writing; the named tab resumes. */
  function checkWriter() {
    if (!writer && S.st && writerKey() === TAB_ID) claimWriter(true);
  }

  /** A `storage` event: another tab saved the book or took over writing it. */
  function onStorage(e) {
    if (!S.st) return;
    if (e.key === WRITER_KEY) {
      // The writing tab closed. Someone has to keep resting orders working.
      if (e.newValue == null) claimWriter(true);
      else if (e.newValue !== TAB_ID) yieldWriter();
      return;
    }
    if (e.key !== null && e.key !== E.STORAGE_KEY) return;
    if (e.newValue == null) {
      // Reset in another tab. Saving this copy would undo it, so start over too.
      S.resetting = true;
      persist.cancel();
      location.reload();
      return;
    }
    const stored = E.load();
    if (!stored) return;
    if (!writer || ((stored.rev || 0) > (S.st.rev || 0) && !persist.pending())) {
      adoptBook(stored);
      return;
    }
    // Saved by a tab that had not yet seen this one take over. This tab is the
    // one in use, so its book goes back on top.
    S.st.rev = Math.max(S.st.rev || 0, stored.rev || 0);
    persist();
    persist.flush();
  }

  /** Put a book saved by another tab on screen in place of this one. */
  function adoptBook(next) {
    persist.cancel();
    delete next.repairs;   // the tab that loaded it has already said so
    S.st = next;
    for (const id in (S.st.discovered || {})) PT.registerAsset(S.st.discovered[id]);
    if (!R.terminal) return;
    // Every pane that shows the book is rebuilt: they close over its objects.
    renderWatchlist();
    V.bindDrawings(S.focus);
    V.buildBlotter();
    V.buildOrderPane();
    if (S.view === 'accounts') V.renderAccountsView();
    V.renderAll();
  }

  /* --------------------------------------------------------------- shell */

  function mount() {
    const root = document.getElementById('root');
    root.innerHTML = '';

    R.terminal = el('div', { class: 'terminal', dataset: { view: S.view } });
    R.rail = buildRail();
    R.topbar = buildTopbar();
    R.watchlist = el('aside', { class: 'watchlist panel' });
    R.chartpane = el('section', { class: 'chartpane' });
    R.blotter = el('section', { class: 'blotter' });
    R.orderpane = el('aside', { class: 'orderpane panel' });
    R.statusbar = buildStatusbar();

    R.terminal.append(R.rail, R.topbar, R.watchlist, R.chartpane, R.blotter, R.orderpane, R.statusbar);
    root.appendChild(R.terminal);

    buildWatchlist();
    V.buildChartPane();
    V.buildBlotter();
    V.buildOrderPane();
  }

  const NAV = [
    { id: 'trade', icon: 'trade', label: 'Trade' },
    { id: 'ideas', icon: 'trending', label: 'Ideas' },
    { id: 'portfolio', icon: 'portfolio', label: 'Portfolio' },
    { id: 'ai', icon: 'ai', label: 'AI companion' },
    { id: 'compare', icon: 'compare', label: 'You vs AI' },
    { id: 'accounts', icon: 'wallet', label: 'Accounts' },
  ];

  function buildRail() {
    const rail = el('nav', { class: 'rail', 'aria-label': 'Main navigation' });
    R.navBtns = {};
    for (const item of NAV) {
      const btn = el('button', {
        class: 'rail__btn' + (S.view === item.id ? ' is-active' : ''),
        'aria-label': item.label,
      }, icon(item.icon, 19));
      UI.bindTip(btn, item.label);
      btn.addEventListener('click', () => setView(item.id));
      R.navBtns[item.id] = btn;
      rail.appendChild(btn);
    }
    rail.appendChild(el('div', { class: 'rail__spacer' }));
    const settings = el('button', { class: 'rail__btn', 'aria-label': 'Settings' }, icon('settings', 19));
    UI.bindTip(settings, 'Settings');
    settings.addEventListener('click', () => V.openSettings());
    rail.appendChild(settings);
    return rail;
  }

  function buildTopbar() {
    const bar = el('header', { class: 'topbar' });

    bar.appendChild(el('div', { class: 'wordmark' }, [
      el('span', { class: 'wordmark__dot' }), 'Paper Trader',
    ]));

    /* omnibox */
    R.omniInput = el('input', {
      class: 'omni__input', type: 'text', placeholder: 'Search symbol or company…',
      'aria-label': 'Search symbols', autocomplete: 'off', spellcheck: 'false',
    });
    R.omniResults = el('div', { class: 'omni__results hidden' });
    const omni = el('div', { class: 'omni' }, [
      el('span', { class: 'omni__icon' }, icon('search', 14)),
      R.omniInput,
      el('span', { class: 'omni__kbd', text: '/' }),
      R.omniResults,
    ]);
    wireOmnibox();
    bar.appendChild(omni);

    R.session = el('div', { class: 'session session--closed' });
    bar.appendChild(R.session);

    R.feedBadge = el('span', { class: 'badge badge--closed' }, 'Connecting');
    bar.appendChild(R.feedBadge);

    /*
     * Below ~1100px only one centre region fits at a time, so the side panels
     * become switchable rather than simply disappearing.
     */
    R.mobileSwitch = el('div', { class: 'seg mobile-only' });
    for (const [mode, label] of [['chart', 'Chart'], ['watchlist', 'List'], ['order', 'Trade'], ['blotter', 'Book']]) {
      const b = el('button', { class: 'seg__item' + (mode === 'chart' ? ' is-active' : ''), text: label });
      b.addEventListener('click', () => {
        if (mode === 'chart') delete R.terminal.dataset.mobile;
        else R.terminal.dataset.mobile = mode;
        for (const child of R.mobileSwitch.children) child.classList.toggle('is-active', child.textContent === label);
        if (S.chart) S.chart.resize();
      });
      R.mobileSwitch.appendChild(b);
    }
    bar.appendChild(R.mobileSwitch);

    bar.appendChild(el('div', { class: 'topbar__spacer' }));

    /*
     * Account switcher. Always visible, even with one account, because which
     * book a trade lands in is the last thing that should ever be ambiguous.
     */
    R.acctBtn = el('button', { class: 'acctbtn', 'aria-haspopup': 'listbox' });
    R.acctMenu = el('div', { class: 'acctmenu hidden', role: 'listbox' });
    R.acctBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = R.acctMenu.classList.toggle('hidden');
      if (!open) renderAccountMenu();
    });
    document.addEventListener('click', () => R.acctMenu.classList.add('hidden'));
    bar.appendChild(el('div', { class: 'acct' }, [R.acctBtn, R.acctMenu]));

    R.topEquity = el('div', { class: 'v num' }, '—');
    R.topDay = el('div', { class: 'v num', style: 'font-size:13px' }, '—');
    bar.appendChild(el('div', { class: 'topbar__stat' }, [
      el('div', { class: 'label', text: 'Portfolio value' }), R.topEquity,
    ]));
    bar.appendChild(el('div', { class: 'topbar__stat' }, [
      el('div', { class: 'label', text: 'Day P&L' }), R.topDay,
    ]));
    return bar;
  }

  /** The button text: which account, and what it is worth right now. */
  function renderAccountButton() {
    if (!R.acctBtn) return;
    const pf = pfUser();
    const val = E.valuate(pf, prices());
    const n = E.accountIds(S.st).length;
    R.acctBtn.innerHTML = '';
    R.acctBtn.append(
      el('span', { class: 'acctbtn__name truncate', text: pf.name }),
      el('span', { class: 'acctbtn__value num', text: U.fmtUSD(val.equity) }),
      el('span', { class: 'acctbtn__caret', text: n > 1 ? `▾ ${n}` : '▾' }),
    );
  }

  function renderAccountMenu() {
    if (!R.acctMenu) return;
    R.acctMenu.innerHTML = '';
    const px = prices();
    for (const pf of accounts()) {
      const val = E.valuate(pf, px);
      const ret = pf.startingCash > 0 ? (val.equity / pf.startingCash - 1) * 100 : 0;
      const active = pf.id === S.st.activeAccount;
      const row = el('button', {
        class: 'acctmenu__row' + (active ? ' is-active' : ''),
        role: 'option', 'aria-selected': active ? 'true' : 'false',
      }, [
        el('span', { class: 'acctmenu__name truncate', text: pf.name }),
        el('span', { class: 'acctmenu__val num', text: U.fmtUSD(val.equity) }),
        el('span', {
          class: 'acctmenu__ret num ' + (ret >= 0 ? 'pos' : 'neg'),
          text: U.fmtPct(ret),
        }),
      ]);
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        R.acctMenu.classList.add('hidden');
        if (!active) switchAccount(pf.id);
      });
      R.acctMenu.appendChild(row);
    }
    const manage = el('button', { class: 'acctmenu__manage', text: 'Manage accounts…' });
    manage.addEventListener('click', (ev) => {
      ev.stopPropagation();
      R.acctMenu.classList.add('hidden');
      setView('accounts');
    });
    R.acctMenu.appendChild(manage);
  }

  function buildStatusbar() {
    const bar = el('footer', { class: 'statusbar' });
    R.stFeed = el('span', {}, '—');
    R.stMarket = el('span', {}, '—');
    R.stCounts = el('span', {}, '');
    R.stClock = el('span', { class: 'num' }, '');
    bar.append(
      R.stFeed,
      el('span', { class: 'dimmer' }, '·'), R.stMarket,
      el('span', { class: 'dimmer' }, '·'), R.stCounts,
      el('div', { class: 'statusbar__spacer' }),
      el('span', { class: 'dimmer' }, 'Paper trading · virtual money only'),
      el('span', { class: 'dimmer' }, '·'), R.stClock,
    );
    return bar;
  }

  /* ---------------------------------------------------------- navigation */

  function setView(view) {
    S.view = view;
    R.terminal.dataset.view = view;
    for (const id in R.navBtns) R.navBtns[id].classList.toggle('is-active', id === view);

    if (view === 'trade') {
      V.buildChartPane();
      V.buildBlotter();
      V.buildOrderPane();
    } else if (view === 'portfolio') {
      V.renderPortfolioView();
    } else if (view === 'ai') {
      V.renderAIView();
    } else if (view === 'compare') {
      V.renderCompareView();
    } else if (view === 'ideas') {
      V.renderIdeasView();
    } else if (view === 'accounts') {
      V.renderAccountsView();
    }
    V.renderAll();
  }

  function setFocus(assetId) {
    if (!PT.byId[assetId]) return;
    S.focus = assetId;
    PT.feed.setFocus(assetId);
    PT.feed.watch([assetId]);
    if (S.view !== 'trade') setView('trade');
    else { V.buildChartPane(); V.buildOrderPane(); }
    V.loadChart(true);
    renderWatchlist();
  }

  /* ------------------------------------------------------------- omnibox */

  function wireOmnibox() {
    let cursor = -1;
    let results = [];
    let searching = false;

    const close = () => { R.omniResults.classList.add('hidden'); cursor = -1; };

    const render = () => {
      R.omniResults.innerHTML = '';
      if (!results.length) {
        // "No matches" would be a claim we cannot make while a lookup is still
        // running — the first search also warms a 7,000-symbol directory.
        R.omniResults.appendChild(el('div', { class: 'omni__hint', text: searching ? 'Searching…' : 'No matches.' }));
        R.omniResults.classList.remove('hidden');
        return;
      }
      results.forEach((r, i) => {
        // Tradable means the providers can price it, not that it was on a list.
        const tradable = r.tradable !== false;
        const item = el('div', {
          class: 'omni__item' + (i === cursor ? ' is-cursor' : '') + (tradable ? '' : ' is-disabled'),
          title: tradable ? '' : 'No price source for this symbol',
        }, [
          el('span', { class: 'omni__sym', text: r.symbol }),
          el('span', { class: 'omni__name', text: r.name }),
          r.exchange ? el('span', { class: 'dimmer', style: 'font-size:10px', text: r.exchange }) : null,
          el('span', { class: 'badge ' + (r.kind === 'crypto' ? 'badge--sim' : 'badge--closed'), text: r.kind === 'crypto' ? 'Crypto' : r.kind === 'etf' ? 'ETF' : 'Stock' }),
        ]);
        if (tradable) {
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            R.omniInput.value = '';
            close();
            adopt(r);
          });
        }
        R.omniResults.appendChild(item);
      });
      R.omniResults.classList.remove('hidden');
    };

    const run = U.debounce(async (q) => {
      if (!q.trim()) return close();
      searching = true;
      render();
      const j = await PT.feed.search(q);
      // A slower earlier query must not overwrite a newer one.
      if (R.omniInput.value.trim() !== q.trim()) return;
      searching = false;
      results = j.results || [];
      cursor = results.findIndex((r) => r.tradable !== false);
      render();
    }, 180);

    R.omniInput.addEventListener('input', () => { results = []; run(R.omniInput.value); });
    R.omniInput.addEventListener('focus', () => { if (results.length && R.omniInput.value) render(); });
    R.omniInput.addEventListener('blur', () => setTimeout(close, 120));
    R.omniInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { R.omniInput.blur(); close(); return; }
      if (!results.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        for (let i = 0; i < results.length; i++) {
          cursor = (cursor + dir + results.length) % results.length;
          if (results[cursor].tradable !== false) break;
        }
        render();
      } else if (e.key === 'Enter' && results[cursor]) {
        const r = results[cursor];
        if (r.tradable === false) return;
        R.omniInput.value = '';
        R.omniInput.blur();
        close();
        adopt(r);
      }
    });
  }

  /* ----------------------------------------------------------- watchlist */

  function buildWatchlist() {
    R.watchlist.innerHTML = '';
    const tabs = el('div', { class: 'panel__head', style: 'padding:0 6px' });
    R.wlTabs = {};
    for (const t of [['watchlist', 'Watchlist'], ['movers', 'Top movers']]) {
      const tab = el('button', { class: 'tab' + (S.wlTab === t[0] ? ' is-active' : ''), text: t[1] });
      tab.addEventListener('click', () => { S.wlTab = t[0]; buildWatchlist(); });
      R.wlTabs[t[0]] = tab;
      tabs.appendChild(tab);
    }
    R.watchlist.appendChild(tabs);

    R.wlBody = el('div', { class: 'panel__body scroll' });
    R.watchlist.appendChild(R.wlBody);

    const addBtn = el('button', { class: 'btn btn--ghost btn--block btn--sm' }, [icon('plus', 14), 'Add symbol']);
    addBtn.addEventListener('click', () => R.omniInput.focus());
    R.watchlist.appendChild(el('div', { class: 'panel__foot' }, addBtn));

    renderWatchlist();
  }

  /**
   * Take a search result into the app: register it so every other module can
   * price, chart and trade it, then remember it so it survives a reload.
   */
  function adopt(result) {
    const asset = PT.registerAsset({
      id: result.symbol,
      name: result.name,
      kind: result.kind,
      exchange: result.exchange,
      yh: result.yh,
      // Long-tail coins carry their CoinGecko id; it is the only way to price them.
      cg: result.cg,
      delayed: result.delayed,
    });
    if (!asset) return;
    if (asset.discovered) {
      S.st.discovered = S.st.discovered || {};
      S.st.discovered[asset.id] = {
        id: asset.id, name: asset.name, kind: asset.kind, exchange: asset.exchange,
        yh: asset.yh, cg: asset.cg || null,
      };
    }
    addToWatchlist(asset.id);
    setFocus(asset.id);
    save();
  }

  /**
   * Move to another account. The whole shell is rebuilt: positions, orders,
   * blotter, order ticket and every price cell belong to the account that was
   * showing, and reusing them would leave one account's numbers on another's
   * screen.
   */
  function switchAccount(id) {
    if (!E.setActiveAccount(S.st, id)) return false;
    save();
    // priceCells is a shared registry pruned on paint — see renderWatchlist.
    // Only the trade view shows the chart; building it on any other view would
    // replace that view while the rail still names it.
    if (S.view === 'trade') V.buildChartPane();
    V.buildBlotter();
    V.buildOrderPane();
    if (S.view === 'trade') V.renderAll();
    else setView(S.view);
    const pf = pfUser();
    UI.toast({ title: `Switched to ${pf.name}`, message: `${U.fmtUSD(pf.cash, { fixed2: true })} cash available.` });
    return true;
  }

  function addToWatchlist(assetId) {
    if (!PT.byId[assetId]) return;
    if (!S.st.watchlist.includes(assetId)) {
      S.st.watchlist.unshift(assetId);
      PT.feed.watch([assetId]);
      save();
      renderWatchlist();
    }
  }

  function removeFromWatchlist(assetId) {
    S.st.watchlist = S.st.watchlist.filter((x) => x !== assetId);
    // Keep streaming anything still needed, even if it left the list.
    if (!neededSymbols().has(assetId)) PT.feed.unwatch(assetId);
    save();
    renderWatchlist();
  }

  /**
   * Every symbol something depends on a price for: the watchlist, the chart,
   * and each position and live order on every account and the AI's. One left
   * out is never priced, so its orders never fill and its holdings sit at cost.
   */
  function neededSymbols() {
    const ids = new Set(S.st.watchlist);
    if (S.focus) ids.add(S.focus);
    for (const id of E.accountIds(S.st).concat('ai')) {
      const pf = S.st.portfolios[id];
      if (!pf) continue;
      for (const assetId in pf.positions) ids.add(assetId);
      for (const o of pf.orders) ids.add(o.assetId);
    }
    return ids;
  }

  function renderWatchlist() {
    if (!R.wlBody) return;
    R.wlBody.innerHTML = '';
    /*
     * Deliberately NOT clearing `priceCells` here. It is a global registry
     * written by the watchlist, the symbol header, the blotter and the
     * holdings table; clearing it from one view unregistered all the others,
     * freezing the positions "Last" column. `paintQuote` already drops
     * bindings whose nodes have left the document, so the rows this call
     * replaces fall out on the next tick.
     */

    if (S.wlTab === 'movers') return renderMovers();

    if (!S.st.watchlist.length) {
      R.wlBody.appendChild(UI.emptyState('search', 'Watchlist is empty',
        'Search for a symbol above to start tracking it.'));
      return;
    }

    for (const assetId of S.st.watchlist) {
      const asset = PT.byId[assetId];
      if (!asset) continue;
      const q = prices()[assetId];

      const priceEl = UI.makePriceCell('row__price');
      const chgEl = el('span', { class: 'row__chg' }, '—');
      registerCell(assetId, { price: priceEl, chg: chgEl });

      const del = el('button', { class: 'row__del', title: `Remove ${assetId}` }, icon('close', 12));
      del.addEventListener('click', (e) => { e.stopPropagation(); removeFromWatchlist(assetId); });

      const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      spark.setAttribute('class', 'row__spark');
      spark.setAttribute('viewBox', '0 0 52 22');
      spark.setAttribute('preserveAspectRatio', 'none');

      const row = el('div', {
        class: 'row' + (assetId === S.focus ? ' is-active' : ''),
        dataset: { asset: assetId },
      }, [
        el('div', { class: 'row__main' }, [
          el('div', { class: 'row__sym', text: assetId }),
          el('div', { class: 'row__name truncate', text: asset.name }),
        ]),
        spark,
        el('div', { class: 'row__right' }, [priceEl, chgEl]),
        del,
      ]);
      row.addEventListener('click', () => setFocus(assetId));
      R.wlBody.appendChild(row);
      paintQuote(assetId, q);
      queueSparkline(assetId, spark);
    }
    drainSparklineQueue();
  }

  /* ------------------------------------------------------------ sparklines */

  /*
   * Watchlist sparklines are drawn from real daily candles. Requests are
   * queued and spaced out rather than fired in a burst, because a dozen
   * simultaneous upstream fetches is exactly what gets an IP rate limited.
   */
  const sparkCache = new Map();   // assetId -> array of closes
  let sparkQueue = [];
  let sparkDraining = false;

  function drawSparkline(svg, closes) {
    if (!svg || !closes || closes.length < 2) return;
    const d = PT.chart.sparklinePath(closes, 52, 22);
    if (!d) return;
    const rising = closes[closes.length - 1] >= closes[0];
    svg.innerHTML = '';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', rising ? 'var(--dir-up)' : 'var(--dir-down)');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);
  }

  function queueSparkline(assetId, svg) {
    const cached = sparkCache.get(assetId);
    if (cached) { drawSparkline(svg, cached); return; }
    sparkQueue.push({ assetId, svg });
  }

  async function drainSparklineQueue() {
    if (sparkDraining) return;
    sparkDraining = true;
    try {
      /*
       * Sparklines are decoration and must never delay the tape. Upstream
       * budget is shared, so drawing twelve of them first would push the first
       * real quote out by several seconds.
       */
      await PT.feed.whenReady();
      await new Promise((r) => setTimeout(r, 800));
      while (sparkQueue.length) {
        const { assetId, svg } = sparkQueue.shift();
        if (!svg.isConnected) continue;
        try {
          const res = await PT.feed.candles(assetId, '1D');
          // Shared with the symbol header, which uses the newest daily bar for
          // range and volume when the quote provider omits them.
          S.candleCache[assetId + ':1D'] = res.bars;
          const closes = res.bars.slice(-40).map((b) => b.c);
          sparkCache.set(assetId, closes);
          drawSparkline(svg, closes);
        } catch {
          // No history available for this symbol; the row simply has no spark.
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    } finally {
      sparkDraining = false;
    }
  }

  function renderMovers() {
    const all = Object.values(prices())
      .filter((q) => q && isFinite(q.changePct))
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 24);

    if (!all.length) {
      R.wlBody.appendChild(UI.emptyState('trending', 'Waiting for quotes',
        'Top movers appear once the feed has priced your watchlist.'));
      return;
    }

    const gainers = all.filter((q) => q.changePct > 0).slice(0, 10);
    const losers = all.filter((q) => q.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 10);

    const section = (title, rows) => {
      if (!rows.length) return;
      R.wlBody.appendChild(el('div', { class: 'label', style: 'padding:10px 12px 6px' }, title));
      rows.forEach((q, i) => {
        const node = el('div', { class: 'mover' }, [
          el('span', { class: 'mover__rank num', text: String(i + 1) }),
          el('span', { class: 'mover__sym', text: q.assetId }),
          el('span', { class: 'mover__chg num ' + U.dirClass(q.changePct), text: UI.changeText(q.changePct) }),
        ]);
        node.addEventListener('click', () => setFocus(q.assetId));
        R.wlBody.appendChild(node);
      });
    };
    section('Gainers', gainers);
    section('Losers', losers);
  }

  function registerCell(assetId, cells) {
    if (!priceCells.has(assetId)) priceCells.set(assetId, []);
    priceCells.get(assetId).push(cells);
  }

  /**
   * Push a quote into every bound cell for that asset.
   *
   * Cells are registered by several views, and those views re-render
   * independently, so bindings to detached nodes are dropped here. Without this
   * the map grows without bound and every tick repaints nodes nobody can see.
   */
  function paintQuote(assetId, q) {
    const bound = priceCells.get(assetId);
    if (!bound) return;

    let live = 0;
    for (let i = 0; i < bound.length; i++) {
      const c = bound[i];
      const anchor = c.price || c.chg;
      if (!anchor || !anchor.isConnected) continue;
      bound[live++] = c;

      if (c.price) UI.setPrice(c.price, q ? q.price : null, (v) => (v == null ? '—' : U.fmtUSD(v)));
      if (c.chg) {
        const pct = q ? q.changePct : null;
        c.chg.textContent = UI.changeText(pct);
        c.chg.className = 'row__chg num ' + U.dirClass(pct);
      }
    }
    bound.length = live;
    if (!live) priceCells.delete(assetId);
  }

  PT.app = { S, R, mountShell: mount, setView, setFocus, addToWatchlist, removeFromWatchlist, renderWatchlist,
    save, orderCtx, paintQuote, registerCell, priceCells, pfUser, pfAI, accounts,
    switchAccount, renderAccountButton, renderAccountMenu, prices, marketOpenFor, neededSymbols,
    isWriter, claimWriter, releaseWriter, checkWriter, onStorage };
})(window.PT);
