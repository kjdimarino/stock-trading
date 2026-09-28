/**
 * Regressions for the application layer: the run loop and boot (12-boot.js)
 * and the app state/shell helpers (09-app.js).
 *
 * Each "tab" is its own sandbox running the real engine, app and boot files,
 * with the DOM, views and market feed stubbed out. Tabs opened from one
 * `browser()` share a localStorage, and a write in one queues a `storage`
 * event for the others, delivered when the test says so — as a browser does,
 * asynchronously.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadPT, describe, it, eq, near, ok, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = ['00-util', '01-calendar', '02-universe', '03-engine'].map((f) => `src/app/js/${f}.js`);
const KEY = 'pt.state.v1';

function browser() {
  const store = new Map();
  const tabs = [];
  const queue = [];
  const deliver = () => {
    while (queue.length) {
      const { tab, ev } = queue.shift();
      for (const fn of [...(tab.on.window.storage || [])]) fn(ev);
    }
  };
  return { store, tabs, queue, deliver };
}

const clock = { now: Date.UTC(2026, 8, 26, 16, 0) };   // Sat 26 Sep 2026, stocks shut

function openTab(b = browser(), { hidden = false } = {}) {
  const { PT, sandbox } = loadPT(ENGINE, { localStorage: false });
  const tab = {
    PT, sandbox, b, toasts: [], views: [], timers: [], rafs: 0, reloads: 0,
    on: { window: {}, document: {} }, feedOn: {}, onboarding: null,
  };

  const RealDate = Date;
  sandbox.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  };

  const emit = (key, oldValue, newValue) => {
    for (const other of b.tabs) if (other !== tab) b.queue.push({ tab: other, ev: { key, oldValue, newValue } });
  };
  sandbox.localStorage = {
    getItem: (k) => (b.store.has(k) ? b.store.get(k) : null),
    setItem: (k, v) => { const old = b.store.get(k) ?? null; b.store.set(k, String(v)); emit(k, old, String(v)); },
    removeItem: (k) => { const old = b.store.get(k) ?? null; b.store.delete(k); emit(k, old, null); },
    clear: () => { b.store.clear(); emit(null, null, null); },
  };

  const listen = (where) => (type, fn) => { (tab.on[where][type] = tab.on[where][type] || []).push(fn); };
  const unlisten = (where) => (type, fn) => {
    tab.on[where][type] = (tab.on[where][type] || []).filter((f) => f !== fn);
  };
  sandbox.addEventListener = listen('window');
  sandbox.removeEventListener = unlisten('window');
  sandbox.document = {
    readyState: 'loading',   // keeps 12-boot from booting itself on load
    hidden, visibilityState: hidden ? 'hidden' : 'visible',
    activeElement: { tagName: 'BODY' },
    addEventListener: listen('document'),
    documentElement: { setAttribute() {}, removeAttribute() {} },
  };
  sandbox.location = { reload: () => { tab.reloads++; } };
  // Timers are recorded, never run on their own: tests drive them.
  sandbox.setTimeout = (fn, ms) => { tab.timers.push({ fn, ms }); return tab.timers.length; };
  sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0;
  sandbox.requestAnimationFrame = () => { tab.rafs++; };

  PT.ui = {
    toast: (t) => tab.toasts.push(t), icon: () => null, bindTip() {},
    emptyState: () => null, makePriceCell: () => null, setPrice() {}, changeText: () => '',
  };
  PT.views = new Proxy({}, {
    get: (_, k) => (...a) => {
      tab.views.push(k);
      if (k === 'showOnboarding') tab.onboarding = a[0];
    },
  });
  const watched = new Set();
  PT.feed = {
    prices: Object.create(null),
    watched,
    watch: (ids) => { for (const id of ids) watched.add(id); },
    unwatch: (id) => { watched.delete(id); },
    setFocus() {}, start() {},
    on: (ev, fn) => { tab.feedOn[ev] = fn; },
    candles: async () => ({ bars: [] }),
    SECOND_TFS: new Set(),
    status: { cryptoLive: true, serverUp: true, counters: { ticks: 0, polls: 0 } },
  };
  PT.companion = { llmAvailable: () => Promise.resolve(false) };
  PT.trader = { RULES: { candidatesPerCycle: 2 }, runTraderCycle: () => ({ decisions: [] }) };

  for (const f of ['09-app', '12-boot']) {
    const file = `src/app/js/${f}.js`;
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  PT.app.mountShell = () => { PT.app.R.terminal = { dataset: {} }; PT.app.R.navBtns = {}; };

  tab.A = PT.app;
  tab.E = PT.engine;
  tab.S = PT.app.S;
  tab.fire = (where, type, ev = {}) => { for (const fn of [...(tab.on[where][type] || [])]) fn(ev); };
  tab.stored = () => JSON.parse(b.store.get(KEY));
  b.tabs.push(tab);
  return tab;
}

/** Seed storage with a book, via the engine exactly as onboarding does. */
function seed(tab, cash = 10000, edit) {
  const st = tab.E.newState(cash);
  if (edit) edit(st, tab.E);
  tab.E.save(st);
  tab.b.queue.length = 0;
  return st;
}

const quote = (price, extra = {}) => ({ price, changePct: 0, t: clock.now, ...extra });
const buyBTC = (tab, notional = 5000) => tab.E.submitOrder(tab.A.pfUser(),
  { assetId: 'BTC', side: 'buy', type: 'market', notional }, tab.A.orderCtx('BTC'));
const activeFills = (st) => st.portfolios[st.activeAccount].fills.length;

/* --------------------------------------------------------------- tabs */

describe('two open tabs do not revert each other\'s book', () => {
  it('a trade in one tab survives the other tab\'s timed saves', async () => {
    const b = browser();
    const t1 = openTab(b);
    seed(t1);
    t1.PT.boot.boot();
    const t2 = openTab(b);
    t2.PT.boot.boot();
    b.deliver();

    for (const t of [t1, t2]) t.PT.feed.prices.BTC = quote(50000);
    // The idle tab has a save in flight when the user trades in the other.
    t2.A.save();
    buyBTC(t1);
    t1.A.save();
    t1.A.save.flush();
    b.deliver();
    eq(activeFills(t1.stored()), 1, 'the trade is on disk');

    // The idle tab's clocks: equity samples, the AI cycle, and flushes on hide.
    clock.now += 11000;
    t2.PT.boot.tickLoop();
    await t2.PT.boot.aiCycle();
    t2.A.save.flush();
    Object.assign(t2.sandbox.document, { hidden: true, visibilityState: 'hidden' });
    t2.fire('document', 'visibilitychange');
    b.deliver();

    const st = t1.stored();
    eq(activeFills(st), 1, 'the trade is still on disk');
    near(st.portfolios[st.activeAccount].cash, 5000, 1, 'cash after the buy');
    eq(activeFills(t2.S.st), 1, 'the idle tab now shows the trade too');
  });

  it('only one tab writes; the other follows what it saves', () => {
    const b = browser();
    const t1 = openTab(b);
    seed(t1);
    t1.PT.boot.boot();
    const t2 = openTab(b);
    t2.PT.boot.boot();
    b.deliver();
    ok(t2.A.isWriter() && !t1.A.isWriter(), 'the newest tab writes');

    t2.PT.feed.prices.BTC = quote(50000);
    buyBTC(t2, 2000);
    t2.A.save();
    t2.A.save.flush();
    b.deliver();
    eq(activeFills(t1.S.st), 1, 'the following tab picked up the trade');
    ok(t1.views.includes('buildBlotter'), 'and redrew its blotter');
  });

  it('a tab brought back into view catches up before it takes over', () => {
    const b = browser();
    const t1 = openTab(b);
    seed(t1);
    t1.PT.boot.boot();
    const t2 = openTab(b);
    t2.PT.boot.boot();
    b.deliver();
    t2.PT.feed.prices.BTC = quote(50000);
    buyBTC(t2, 2000);
    t2.A.save();
    t2.A.save.flush();
    // The switch back lands before this tab has heard about that save.
    t1.fire('document', 'visibilitychange');
    ok(t1.A.isWriter(), 'the tab in view writes');
    eq(activeFills(t1.S.st), 1, 'having picked up the other tab\'s trade first');
    b.deliver();
    t1.A.save();
    t1.A.save.flush();
    eq(activeFills(t1.stored()), 1);
  });

  it('closing the writing tab hands writing to one that remains', () => {
    const b = browser();
    const t1 = openTab(b);
    seed(t1);
    t1.PT.boot.boot();
    const t2 = openTab(b);
    t2.PT.boot.boot();
    b.deliver();
    t2.fire('window', 'pagehide');
    b.deliver();
    ok(t1.A.isWriter(), 'the remaining tab took over');
  });

  it('a reset in another tab is not undone by this one', () => {
    const b = browser();
    const t1 = openTab(b);
    seed(t1);
    t1.PT.boot.boot();
    const t2 = openTab(b);
    t2.PT.boot.boot();
    b.deliver();

    // confirmReset() in the other tab.
    t1.S.resetting = true;
    t1.A.save.cancel();
    t1.E.clear();
    b.deliver();
    eq(t2.reloads, 1, 'this tab starts over too');
    t2.A.save();
    t2.A.save.flush();
    t2.fire('window', 'pagehide');
    eq(b.store.get(KEY) ?? null, null, 'nothing wrote the old book back');
  });
});

/* -------------------------------------------------------------- boot */

describe('boot never overwrites a save it cannot read', () => {
  it('sets an unreadable save aside before onboarding writes a fresh one', () => {
    const t = openTab();
    const raw = JSON.stringify({ version: 999, portfolios: { acct_1: { cash: 123456.78 } } });
    t.b.store.set(KEY, raw);
    t.PT.boot.boot();
    ok(t.onboarding, 'onboarding shown');
    t.onboarding(5000);
    eq(t.b.store.get(`${KEY}.unreadable`), raw, 'the unreadable save is kept');
    eq(t.stored().portfolios.user.cash, 5000, 'the fresh book is saved');
  });

  it('uses a book another tab started while this one sat on onboarding', () => {
    const b = browser();
    const t1 = openTab(b);
    t1.PT.boot.boot();
    const t2 = openTab(b);
    seed(t2, 25000);
    t1.onboarding(5000);
    eq(t1.stored().portfolios.user.cash, 25000, 'the other tab\'s book was not overwritten');
    eq(t1.A.pfUser().cash, 25000, 'and this tab opened it');
  });
});

/* ---------------------------------------------------- account switching */

describe('switching accounts keeps the view that is up', () => {
  const setup = () => {
    const t = openTab();
    seed(t, 10000, (st, E) => E.addAccount(st, 'Swing', 5000));
    t.PT.boot.boot();
    return t;
  };
  for (const view of ['accounts', 'ai', 'ideas']) {
    it(`on ${view}, the topbar switch does not put the chart in its place`, () => {
      const t = setup();
      t.A.setView(view);
      const other = t.A.accounts().find((p) => p.id !== t.S.st.activeAccount);
      t.views.length = 0;
      ok(t.A.switchAccount(other.id));
      ok(!t.views.includes('buildChartPane'), `chart built on ${view}: ${t.views.join(',')}`);
      eq(t.S.st.activeAccount, other.id);
      eq(t.A.R.terminal.dataset.view, view);
      const redraw = { accounts: 'renderAccountsView', ai: 'renderAIView', ideas: 'renderIdeasView' }[view];
      ok(t.views.includes(redraw), `${redraw} re-rendered`);
      ok(t.views.includes('buildOrderPane'), 'the order ticket belongs to the new account');
    });
  }
  it('on trade, the chart pane is rebuilt as before', () => {
    const t = setup();
    const other = t.A.accounts().find((p) => p.id !== t.S.st.activeAccount);
    t.views.length = 0;
    t.A.switchAccount(other.id);
    ok(t.views.includes('buildChartPane'));
    ok(t.views.includes('buildBlotter') && t.views.includes('buildOrderPane'));
  });
});

/* ------------------------------------------------------- watched symbols */

describe('every symbol an order or holding depends on is watched', () => {
  const setup = () => {
    const t = openTab();
    seed(t, 10000, (st, E) => {
      const swing = E.addAccount(st, 'Swing', 5000);
      swing.positions.LINK = { assetId: 'LINK', kind: 'crypto', qty: 10, avgCost: 15, realized: 0, openedAt: 0 };
      E.submitOrder(st.portfolios.user, { assetId: 'AVAX', side: 'buy', type: 'limit', qty: 1, limitPrice: 100 },
        { prices: { AVAX: quote(200) }, marketOpen: true, now: clock.now });
    });
    t.PT.boot.boot();
    return t;
  };
  it('boot watches other accounts\' holdings and every open order', () => {
    const t = setup();
    ok(t.PT.feed.watched.has('LINK'), 'held on a non-active account');
    ok(t.PT.feed.watched.has('AVAX'), 'resting order');
  });
  it('removing a watchlist row keeps a symbol that is still needed', () => {
    const t = setup();
    t.S.st.watchlist.unshift('ADA');
    t.PT.feed.watch(['ADA']);
    t.S.focus = 'ADA';
    t.A.removeFromWatchlist('ADA');
    ok(t.PT.feed.watched.has('ADA'), 'still on the chart');
    t.S.focus = 'AAPL';
    t.S.st.watchlist.unshift('LINK');
    t.A.removeFromWatchlist('LINK');
    ok(t.PT.feed.watched.has('LINK'), 'still held on another account');
    t.S.st.watchlist.unshift('ADA');
    t.A.removeFromWatchlist('ADA');
    ok(!t.PT.feed.watched.has('ADA'), 'nothing needs it any more');
  });
  it('an order placed later is watched on the next pass', () => {
    const t = setup();
    t.PT.feed.watched.clear();
    t.E.submitOrder(t.A.pfUser(), { assetId: 'DOT', side: 'buy', type: 'limit', qty: 1, limitPrice: 3 },
      { prices: { DOT: quote(4) }, marketOpen: true, now: clock.now });
    t.PT.boot.tickLoop();
    ok(t.PT.feed.watched.has('DOT'));
  });
});

/* ------------------------------------------------------ hidden-tab loop */

describe('the run loop keeps working orders in a hidden tab', () => {
  const setup = (hidden) => {
    const t = openTab(browser(), { hidden });
    seed(t);
    t.PT.boot.boot();
    t.PT.feed.prices.BTC = quote(100000);
    t.E.submitOrder(t.A.pfUser(), { assetId: 'BTC', side: 'buy', type: 'limit', qty: 0.01, limitPrice: 98000 },
      t.A.orderCtx('BTC'));
    return t;
  };
  it('reschedules itself on a timer, not on animation frames', () => {
    const t = setup(true);
    t.timers.length = 0;
    t.PT.boot.tickLoop();
    ok(t.timers.some((x) => x.fn === t.PT.boot.tickLoop), 'next pass is on a timer');
    eq(t.rafs, 0, 'animation frames, which a hidden tab never gets, are not used');
  });
  it('fills a limit the market crosses while the tab is hidden', () => {
    const t = setup(true);
    t.PT.feed.prices.BTC = quote(97000);
    const next = t.timers.filter((x) => x.fn === t.PT.boot.tickLoop).pop();
    ok(next, 'a pass is scheduled');
    next.fn();
    eq(t.A.pfUser().positions.BTC && t.A.pfUser().positions.BTC.qty, 0.01);
  });
  it('fills a limit on the print that crosses it, between passes', () => {
    const t = setup(true);
    // As the feed emits it: the quote is in the map before listeners hear of it.
    t.PT.feed.prices.BTC = quote(97500, { assetId: 'BTC' });
    t.feedOn.tick(t.PT.feed.prices.BTC);
    t.PT.feed.prices.BTC = quote(100000);
    eq(t.A.pfUser().orders.length, 0, 'no order left resting');
    eq(t.A.pfUser().positions.BTC && t.A.pfUser().positions.BTC.qty, 0.01);
  });
});

/* ------------------------------------------------------------ the bell */

describe('queued orders wait for a quote from after the open', () => {
  // Mon 28 Sep 2026, EDT (UTC-4).
  const et = (d, h, m, s = 0) => Date.UTC(2026, 8, d, h + 4, m, s);
  const setup = () => {
    clock.now = et(27, 21, 0);   // Sunday night
    const t = openTab();
    seed(t);
    t.PT.boot.boot();
    const pf = t.A.pfUser();
    const shut = { prices: { AAPL: quote(340) }, marketOpen: false, now: clock.now };
    t.E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'market', notional: 3400 }, shut);
    t.E.submitOrder(pf, { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 5, limitPrice: 345 }, shut);
    eq(pf.orders.map((o) => o.status), ['queued', 'queued']);
    return t;
  };
  const preOpen = () => quote(340, {
    marketState: 'PRE', quoteTime: et(25, 16, 0), t: et(28, 9, 29, 40), source: 'yahoo',
  });

  it('does not fill against the pre-market poll still on hand at 9:30', () => {
    const t = setup();
    clock.now = et(28, 9, 30) + 200;
    t.PT.feed.prices.AAPL = preOpen();
    t.PT.boot.tickLoop();
    eq(t.A.pfUser().fills.length, 0, 'nothing filled at the prior close');
    eq(t.A.pfUser().orders.map((o) => o.status), ['queued', 'queued']);
  });
  it('fills on the first quote printed after the open', () => {
    const t = setup();
    clock.now = et(28, 9, 30) + 200;
    t.PT.feed.prices.AAPL = preOpen();
    t.PT.boot.tickLoop();
    clock.now = et(28, 9, 30, 2);
    t.PT.feed.prices.AAPL = quote(360, { marketState: 'REGULAR', quoteTime: et(28, 9, 30, 1), source: 'yahoo' });
    t.PT.boot.tickLoop();
    const fills = t.A.pfUser().fills;
    eq(fills.length, 1, 'the market order filled; the 345 limit is below the open');
    ok(fills[0].price >= 360, `filled at the open, not the prior close (${fills[0].price})`);
    eq(t.A.pfUser().orders.map((o) => o.status), ['open']);
  });
  it('a limit resting since the session began is not held back', () => {
    clock.now = et(28, 10, 30);
    const t = openTab();
    seed(t);
    t.PT.boot.boot();
    const open = { prices: { AAPL: quote(340) }, marketOpen: true, now: clock.now };
    t.E.submitOrder(t.A.pfUser(), { assetId: 'AAPL', side: 'buy', type: 'limit', qty: 5, limitPrice: 330 }, open);
    t.PT.feed.prices.AAPL = quote(320, { marketState: 'CLOSED', quoteTime: et(25, 16, 0) });
    t.PT.boot.tickLoop();
    eq(t.A.pfUser().fills.length, 1, 'only orders waiting on the bell wait for a fresh quote');
  });
  it('a Nasdaq quote, with no exchange stamp, counts from when it was fetched', () => {
    const t = setup();
    clock.now = et(28, 9, 31);
    t.PT.feed.prices.AAPL = quote(360, { quoteTime: null, source: 'nasdaq' });
    t.PT.boot.tickLoop();
    eq(t.A.pfUser().fills.length, 1);
  });
});

/* -------------------------------------------------------------- margin */

describe('margin is enforced by the run loop', () => {
  const setup = (price) => {
    clock.now = Date.UTC(2026, 8, 26, 16, 0);
    const t = openTab();
    seed(t, 10000, (st, E) => {
      st.settings.shortingEnabled = true;
      E.submitOrder(st.portfolios.user, { assetId: 'SOL', side: 'sell', type: 'market', qty: 190 },
        { prices: { SOL: quote(100) }, marketOpen: true, shortingEnabled: true, now: clock.now });
    });
    t.PT.boot.boot();
    t.toasts.length = 0;
    if (price != null) t.PT.feed.prices.SOL = quote(price);
    return t;
  };
  it('warns once at a margin call', () => {
    const t = setup(118);
    eq(t.E.marginStatus(t.A.pfUser(), t.PT.feed.prices).level, 'call');
    t.PT.boot.tickLoop();
    t.PT.boot.tickLoop();
    eq(t.toasts.filter((x) => /Margin call/.test(x.title)).length, 1);
    eq(t.A.pfUser().positions.SOL.qty, -190, 'not bought in yet');
  });
  it('buys the short back below the floor', () => {
    const t = setup(125);
    eq(t.E.marginStatus(t.A.pfUser(), t.PT.feed.prices).level, 'liquidate');
    t.PT.boot.tickLoop();
    ok(!t.A.pfUser().positions.SOL, 'short closed');
    ok(t.toasts.some((x) => /Forced buy-in/.test(x.title)), 'and the user is told');
  });
  it('does nothing on a short the feed has not priced yet', () => {
    const t = setup(null);
    t.PT.boot.tickLoop();
    eq(t.toasts.length, 0);
    eq(t.A.pfUser().positions.SOL.qty, -190);
  });
  it('retries a buy-in that failed, but not on every pass', () => {
    const t = setup(125);
    let tries = 0;
    const real = t.E.submitOrder;
    t.E.submitOrder = () => { tries++; throw new Error('refused'); };
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 5; i++) t.PT.boot.tickLoop();
      eq(tries, 1, 'one attempt per interval');
      clock.now += 11000;
      t.PT.boot.tickLoop();
      eq(tries, 2, 'then another');
    } finally {
      t.E.submitOrder = real;
      console.warn = warn;
    }
  });
});

await report('app regressions');
