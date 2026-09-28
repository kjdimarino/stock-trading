/**
 * Regression tests for the trading UI — the order ticket, the blotter, the
 * portfolio view and the narrow layout — in a real browser against the shipped
 * sources.
 *
 * Hermetic: the page is the bundle built straight from src/ and served through
 * Playwright's router, the market-data API answers empty and the Coinbase
 * socket is stubbed, so every price on screen is one the test put there and
 * nothing depends on the network or on a running server.
 */
import fs from 'node:fs';
import { buildHTML } from '../tools/bundle.mjs';
import { describe, it, eq, ok, report } from './harness.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui-regress: playwright is not installed, skipped');
  process.exit(0);
}

const HTML = buildHTML();
const ORIGIN = 'http://paper-trader.test';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** What the search API answers, shaped like the real server's rows. */
const SEARCH = JSON.stringify({ results: [
  { symbol: 'AAPL', name: 'Apple Inc.', kind: 'stock', exchange: 'US', tradable: true },
  { symbol: 'APLD', name: 'Applied Digital Corporation', kind: 'stock', exchange: 'US', tradable: true },
  { symbol: 'APE', name: 'ApeCoin', kind: 'crypto', exchange: 'Coinbase', tradable: true },
] });

let browser;
try {
  browser = await chromium.launch({
    executablePath: fs.existsSync(EXE) ? EXE : undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (e) {
  console.log(`ui-regress: no browser to run in, skipped (${e.message.split('\n')[0]})`);
  process.exit(0);
}

function seedState() {
  const pf = (id, name, cash) => ({
    id, name, startingCash: cash, cash, positions: {}, orders: [], fills: [], rejected: [],
    equity: [], realizedTotal: 0, dayBaseline: null, counters: { orders: 0 },
  });
  return {
    version: 1, createdAt: Date.now(), startingCash: 10000,
    accounts: ['user', 'acct2'], activeAccount: 'user',
    portfolios: { user: pf('user', 'Main', 10000), acct2: pf('acct2', 'Second', 5000), ai: pf('ai', 'AI Trader', 10000) },
    watchlist: ['AAPL', 'BTC', 'TSLA'], aiLog: [], drawings: {},
    settings: {
      slippageEnabled: false, shortingEnabled: true, aiTraderEnabled: false, aiIntervalMs: 5000,
      soundEnabled: false, llmKey: '', disclaimerSeen: true,
    },
  };
}

/**
 * A fresh page on a seeded book. `session` pins the equity calendar: 'open' is
 * a Monday afternoon, 'closed' a Sunday, so market hours never decide a result.
 */
async function open({ width = 1600, height = 950, session = 'open' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  ctx.setDefaultTimeout(5000);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const reply = (status, contentType, body) => route.fulfill({ status, contentType, body });
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/') return reply(200, 'text/html; charset=utf-8', HTML);
    if (url.pathname === '/api/quotes') return reply(200, 'application/json', '{"quotes":{}}');
    if (url.pathname === '/api/candles') return reply(200, 'application/json', '{"bars":[],"source":"test"}');
    if (url.pathname === '/api/search') return reply(200, 'application/json', SEARCH);
    return reply(404, 'text/plain', '');
  });
  await ctx.addInitScript((state) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('pt.state.v1', JSON.stringify(state));
      sessionStorage.setItem('seeded', '1');
    }
    window.WebSocket = function () { return { close() {}, send() {}, readyState: 3 }; };
  }, seedState());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ORIGIN + '/');
  await page.waitForFunction(() => window.PT && window.PT.app && window.PT.app.R.terminal);
  await page.evaluate((mode) => {
    const cal = window.PT.calendar;
    const real = cal.stockStatus;
    const at = mode === 'open' ? Date.UTC(2026, 8, 28, 17, 0) : Date.UTC(2026, 8, 27, 16, 0);
    cal.stockStatus = () => real(at);
  }, session);
  return { ctx, page, errors };
}

const setPrices = (page, prices) => page.evaluate((p) => {
  for (const [id, price] of Object.entries(p)) {
    window.PT.feed.applyQuote(id, { price, changePct: 0, change: 0, source: 'test' });
  }
}, prices);

/** Fill a market order straight through the engine, as if the session were open. */
const fill = (page, assetId, side, qty) => page.evaluate(([assetId, side, qty]) => {
  const { app: A, engine: E, views: V } = window.PT;
  E.submitOrder(A.pfUser(), { assetId, side, type: 'market', qty }, { ...A.orderCtx(assetId), marketOpen: true });
  A.save();
  V.renderAll();
}, [assetId, side, qty]);

const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => ({
  kind: t.className.replace(/.*toast--(\w+).*/, '$1'),
  title: t.querySelector('.toast__title').textContent,
  msg: (t.querySelector('.toast__msg') || {}).textContent || '',
})));

const clearToasts = (page) => page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });

const segBtn = (page, text) => page.locator('.orderpane .seg__item', { hasText: new RegExp(`^${text}$`) });
const ticket = (page) => page.evaluate(() => {
  const i = document.querySelectorAll('.orderpane input');
  return { limit: i.length > 1 ? i[0].value : null, amount: i[i.length - 1].value };
});

/**
 * One page per scenario. A scenario that throws part-way (a control that never
 * appeared, say) is reported as a failure rather than taking the suite down.
 */
async function scenario(name, fn) {
  const opened = [];
  try {
    await fn(async (opts) => { const o = await open(opts); opened.push(o.ctx); return o; });
  } catch (e) {
    describe(name, () => it('runs to the end', () => { throw e; }));
  } finally {
    for (const ctx of opened) await ctx.close().catch(() => {});
  }
}

/* ---------------------------------------------- close/cover, queued order */

await scenario('closing a position while the stock market is shut', async (open) => {
  const { page, errors } = await open({ session: 'closed' });
  await setPrices(page, { AAPL: 200 });
  await fill(page, 'AAPL', 'buy', 10);
  await page.evaluate(() => window.PT.views.buildBlotter());
  await clearToasts(page);
  await page.locator('.blotter button:text-is("Close")').click();
  await page.locator('.modal button:text-is("Close position")').click();
  const after = await page.evaluate(() => ({
    saving: window.PT.app.save.pending(),
    orders: window.PT.app.pfUser().orders.map((o) => `${o.side} ${o.qty} ${o.assetId} ${o.status}`),
    ordersTab: window.PT.app.R.blotterTabs.orders.count.textContent,
  }));
  const shown = await toasts(page);
  await page.waitForTimeout(800);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pt.state.v1')).portfolios.user.orders.length);

  describe('closing a position while the stock market is shut', () => {
    it('queues the sell for the bell', () => eq(after.orders, ['sell 10 AAPL queued']));
    it('does not tell the user the order was rejected', () =>
      ok(!shown.some((t) => /rejected/i.test(t.title)), JSON.stringify(shown)));
    it('says the order is waiting for the open', () =>
      ok(shown.some((t) => t.kind === 'warn' && /opening bell/i.test(t.title) && /SELL 10 AAPL/.test(t.msg)),
        JSON.stringify(shown)));
    it('saves the queued order and redraws the blotter', () => {
      ok(after.saving, 'save was not requested');
      eq(after.ordersTab, '1', 'open orders count');
      eq(saved, 1, 'orders in the saved book');
    });
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* ------------------------------------------ covering a short, P&L labels */

await scenario('covering a short', async (open) => {
  const { page, errors } = await open();
  await setPrices(page, { BTC: 60000 });
  await fill(page, 'BTC', 'sell', 0.1);            // opens a short
  await setPrices(page, { BTC: 50000 });
  await page.evaluate(() => window.PT.app.setFocus('BTC'));
  await clearToasts(page);

  // A partial cover from the ticket.
  await segBtn(page, 'Buy').click();
  await segBtn(page, 'Market').click();
  await segBtn(page, 'Coins').click();
  await page.locator('.orderpane input').last().fill('0.04');
  await page.locator('.order__foot .btn--buy').click();
  const ticketToasts = await toasts(page);
  await clearToasts(page);

  // The rest from the blotter's Cover button.
  await page.evaluate(() => window.PT.views.buildBlotter());
  await page.locator('.blotter button:text-is("Cover")').click();
  await page.locator('.modal button:text-is("Cover short")').click();
  const coverToasts = await toasts(page);

  await page.locator('.blotter .tab', { hasText: 'Trade history' }).click();
  const history = await page.evaluate(() => [...document.querySelectorAll('.blotter tbody tr')].map((tr) => {
    const td = tr.querySelectorAll('td');
    return `${td[2].textContent} ${td[3].textContent} ${td[6].textContent}`;
  }));
  await page.evaluate(() => window.PT.app.setView('portfolio'));
  const realizedTile = await page.evaluate(() => {
    const tile = [...document.querySelectorAll('.pfview .stat')].find((s) => /Realized/.test(s.textContent));
    return tile.querySelector('.stat__sub').textContent;
  });

  describe('covering a short', () => {
    it('the ticket reports the P&L a covering buy realizes', () =>
      ok(ticketToasts.some((t) => /^Bought 0\.04 BTC/.test(t.title) && /realized \+\$400\.00/.test(t.msg)),
        JSON.stringify(ticketToasts)));
    it('the Cover button says Covered, not Sold', () =>
      ok(coverToasts.some((t) => t.kind === 'buy' && /^Covered 0\.06 BTC/.test(t.title)
        && /realized \+\$600\.00/.test(t.msg)), JSON.stringify(coverToasts)));
    it('trade history puts realized P&L on the covering buys', () =>
      eq(history, ['buy 0.06 +$600.00', 'buy 0.04 +$400.00', 'sell 0.1 —']));
    it('the realized tile counts closing fills, not sells', () => eq(realizedTile, '2 closed trades'));
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* --------------------------------------------- the typed limit price */

await scenario('the order ticket keeps a typed limit price', async (open) => {
  const { page, errors } = await open();
  await setPrices(page, { AAPL: 200, TSLA: 300 });
  await fill(page, 'AAPL', 'buy', 10);
  await page.evaluate(() => window.PT.app.setFocus('AAPL'));
  await clearToasts(page);

  await segBtn(page, 'Sell').click();
  await segBtn(page, 'Limit').click();
  await segBtn(page, 'Dollars').click();
  await page.locator('.orderpane input').first().fill('250');
  await page.locator('.order__quick .btn', { hasText: 'Max' }).click();
  const afterMax = await ticket(page);
  await page.locator('.order__foot .btn--sell').click();
  const result = await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    return {
      held: pf.positions.AAPL ? pf.positions.AAPL.qty : 0,
      resting: pf.orders.map((o) => `${o.side} ${o.qty} @ ${o.limitPrice}`),
    };
  });

  const kept = {};
  await page.locator('.orderpane input').first().fill('250');
  await segBtn(page, 'Dollars').click();
  kept.sizeMode = (await ticket(page)).limit;
  await segBtn(page, 'Sell').click();
  kept.side = (await ticket(page)).limit;
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('b');
  kept.shortcut = (await ticket(page)).limit;
  await page.evaluate(() => window.PT.app.setFocus('TSLA'));
  const otherSymbol = (await ticket(page)).limit;
  await page.evaluate(() => window.PT.app.setFocus('AAPL'));
  const backAgain = (await ticket(page)).limit;

  describe('the order ticket keeps a typed limit price', () => {
    it('Max on a dollar-sized sell keeps the limit', () => eq(afterMax, { limit: '250', amount: '10' }));
    it('so the sell rests at the limit instead of filling at market', () =>
      eq(result, { held: 10, resting: ['sell 10 @ 250'] }));
    it('across the size-mode, side and b/s rebuilds', () => eq(kept, { sizeMode: '250', side: '250', shortcut: '250' }));
    it('but starts from the quote on another symbol', () => eq(otherSymbol, '300'));
    it('and does not carry a stale limit back to the first one', () => eq(backAgain, '200'));
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* -------------------------------------------- the topbar at narrow widths */

await scenario('the topbar fits narrow screens', async (open) => {
  const { page, errors } = await open();
  await setPrices(page, { AAPL: 200 });
  const widths = [1100, 1024, 900, 760, 430, 390];
  const results = {};
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
      const bar = document.querySelector('.topbar');
      const inView = (node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth;
      };
      const trade = [...document.querySelectorAll('.mobile-only .seg__item')].find((b) => b.textContent === 'Trade');
      const r = trade.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        overflow: bar.scrollWidth > bar.clientWidth + 1,
        switcher: [...document.querySelectorAll('.mobile-only .seg__item')].every(inView),
        account: inView(document.querySelector('.acctbtn')),
        search: inView(document.querySelector('.omni__input')),
        hit: hit === trade,
        at: [r.left + r.width / 2, r.top + r.height / 2],
      };
    });
    // A real pointer click at the button's position, not a scripted one that
    // scrolls the clipped terminal to find it.
    await page.mouse.click(m.at[0], m.at[1]);
    m.opened = await page.evaluate(() => document.querySelector('.terminal').dataset.mobile || null);
    m.scrolled = await page.evaluate(() => document.querySelector('.terminal').scrollLeft);
    await page.evaluate(() => [...document.querySelectorAll('.mobile-only .seg__item')][0].click());
    delete m.at;
    results[width] = m;
  }
  const want = { overflow: false, switcher: true, account: true, search: true, hit: true, opened: 'order', scrolled: 0 };

  // Above the switcher's breakpoint the bar still carries the session pill and
  // both stats, so it has to fit there too.
  const wide = {};
  for (const width of [1280, 1180, 1101]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(150);
    wide[width] = await page.evaluate(() => {
      const bar = document.querySelector('.topbar');
      const last = [...bar.children].pop().getBoundingClientRect();
      return bar.scrollWidth <= bar.clientWidth + 1 && last.right <= window.innerWidth;
    });
  }

  describe('the topbar fits narrow screens', () => {
    for (const width of widths) {
      it(`at ${width}px the switcher, account and search are on screen and clickable`, () =>
        eq(results[width], want, `${width}px`));
    }
    it('and fits between the breakpoint and the full layout', () => eq(wide, { 1101: true, 1180: true, 1280: true }));
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* ------------------------------------- search results at narrow widths */

await scenario('search results when the search box shrinks', async (open) => {
  const { page, errors } = await open({ width: 1280 });
  await page.locator('.omni__input').fill('apple');
  await page.waitForSelector('.omni__item');
  const results = {};
  for (const width of [1280, 1101, 1024, 768, 601, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(100);
    results[width] = await page.evaluate(() => {
      const list = document.querySelector('.omni__results').getBoundingClientRect();
      const input = document.querySelector('.omni__input').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.omni__item')];
      return {
        shown: rows.length === 3,
        // Room for a company name, not an ellipsis.
        names: rows.map((r) => r.querySelector('.omni__name').getBoundingClientRect().width).every((w) => w >= 60),
        rowsFit: rows.every((r) => r.scrollWidth <= r.clientWidth),
        onScreen: list.left >= 0 && list.right <= window.innerWidth,
        underInput: list.left <= input.left + 1 && list.right >= input.right - 1,
      };
    });
  }

  describe('search results when the search box shrinks', () => {
    const want = { shown: true, names: true, rowsFit: true, onScreen: true, underInput: true };
    for (const width of Object.keys(results)) {
      it(`at ${width}px the results keep room for company names`, () => eq(results[width], want, `${width}px`));
    }
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* ----------------------------------------------- toasts at phone width */

await scenario('toasts at phone width', async (open) => {
  // Two accounts, so the account button carries its "▾ 2" count.
  const { page, errors } = await open({ width: 600, height: 780 });
  await setPrices(page, { AAPL: 200 });
  const results = {};
  for (const [name, width] of [
    ['Main', 600], ['Main', 390], ['Main', 374], ['Main', 360], ['Main', 340], ['Main', 320],
    ['Retirement savings', 390], ['Retirement savings', 320], ['Main', 300], ['Main', 280],
  ]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate((name) => { window.PT.app.pfUser().name = name; window.PT.app.renderAccountButton(); }, name);
    await clearToasts(page);
    await page.evaluate(() => window.PT.ui.toast({ title: 'Bought 1 AAPL', message: 'Filled at $200.00', kind: 'buy', timeout: 60000 }));
    await page.waitForTimeout(400);
    results[`${width}px, account "${name}"`] = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      const bar = box('.topbar'), toast = box('.toast'), acct = box('.acctbtn'), sw = box('.topbar > .mobile-only');
      const mid = (r) => (r.top + r.bottom) / 2;
      const hit = document.elementFromPoint(acct.left + acct.width / 2, acct.bottom - 4);
      return {
        clear: toast.top >= bar.bottom,
        twoRows: Math.abs(mid(sw) - mid(acct)) < 1,
        labels: [...document.querySelectorAll('.mobile-only .seg__item')].every((b) => b.scrollWidth <= b.clientWidth),
        account: !!hit && !!hit.closest('.acctbtn') && acct.right <= bar.right,
        // Which book a trade lands in must stay readable, if only in part.
        named: box('.acctbtn__name').width >= 20,
      };
    });
  }

  describe('toasts at phone width', () => {
    const want = { clear: true, twoRows: true, labels: true, account: true, named: true };
    for (const at of Object.keys(results)) {
      it(`at ${at} a toast clears the topbar and its account button`, () => eq(results[at], want, at));
    }
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* ----------------------------------------- narrow region vs other views */

await scenario('the narrow-layout region switcher and full-width views', async (open) => {
  const { page, errors } = await open({ width: 900, height: 800 });
  await setPrices(page, { AAPL: 200 });
  const box = (sel) => page.evaluate((sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), shown: getComputedStyle(n).display !== 'none' };
  }, sel);
  const pick = (label) => page.evaluate((label) => {
    [...document.querySelectorAll('.mobile-only .seg__item')].find((b) => b.textContent === label).click();
  }, label);
  const rail = (label) => page.locator(`.rail__btn[aria-label="${label}"]`).click();
  const switcherShown = () => page.locator('.mobile-only').isVisible();

  const checks = {};
  for (const [region, label, view, root] of [
    ['Trade', 'Portfolio', 'portfolio', '.pfview'],
    ['List', 'AI companion', 'ai', '.ai'],
    ['Book', 'Accounts', 'accounts', '.accounts'],
  ]) {
    await rail('Trade');
    await pick(region);
    await rail(label);
    await page.waitForTimeout(100);
    const b = await box(root);
    const status = await box('.statusbar');
    checks[view] = {
      visible: !!b && b.w > 400 && b.h > 400,
      statusAtBottom: status.bottom === 800,
      sidePanes: (await box('.orderpane')).shown || (await box('.watchlist')).shown || (await box('.blotter')).shown,
      switcher: await switcherShown(),
    };
  }
  await rail('Trade');
  await pick('Trade');
  await rail('Portfolio');
  await rail('Trade');
  const back = { order: (await box('.orderpane')).shown, switcher: await switcherShown() };

  describe('the narrow-layout region switcher and full-width views', () => {
    const want = { visible: true, statusAtBottom: true, sidePanes: false, switcher: false };
    it('a region picked on the trade view does not blank Portfolio', () => eq(checks.portfolio, want));
    it('nor the AI companion', () => eq(checks.ai, want));
    it('nor Accounts', () => eq(checks.accounts, want));
    it('and the trade view comes back on the region that was picked', () => eq(back, { order: true, switcher: true }));
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* ---------------------------------- switching account from another view */

await scenario('switching account from the topbar menu', async (open) => {
  const { page, errors } = await open();
  await setPrices(page, { AAPL: 200 });
  const results = {};
  for (const [label, view, root] of [['AI companion', 'ai', '.ai'], ['Ideas', 'ideas', '.ideas'], ['Accounts', 'accounts', '.accounts']]) {
    await page.locator(`.rail__btn[aria-label="${label}"]`).click();
    await page.locator('.acctbtn').click();
    await page.locator('.acctmenu__row:not(.is-active)').first().click();
    await page.waitForTimeout(100);
    results[view] = await page.evaluate(([view, root]) => ({
      view: window.PT.app.S.view === view,
      shown: !!document.querySelector('.chartpane > ' + root),
      chart: !!document.querySelector('.chartpane .symhead'),
    }), [view, root]);
  }

  describe('switching account from the topbar menu', () => {
    for (const view of ['ai', 'ideas', 'accounts']) {
      it(`keeps the ${view} view on screen`, () => eq(results[view], { view: true, shown: true, chart: false }));
    }
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* ------------------------------------------------------ portfolio numbers */

await scenario('the portfolio view', async (open) => {
  const { page, errors } = await open();
  await setPrices(page, { AAPL: 200, TSLA: 250 });
  await fill(page, 'AAPL', 'buy', 40);
  await fill(page, 'TSLA', 'sell', 15);             // a short
  await setPrices(page, { TSLA: 450 });
  await page.evaluate(() => window.PT.app.setView('portfolio'));
  const shorts = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('.pfview .alloc__seg')].map((s) => s.style.width);
    const legend = [...document.querySelectorAll('.pfview .alloc__key')].map((k) => k.textContent);
    const row = [...document.querySelectorAll('.pfview tbody tr')].find((tr) => /TSLA/.test(tr.textContent));
    const td = row.querySelectorAll('td');
    return { segs, legend, weight: td[td.length - 1].textContent };
  });

  describe('the portfolio allocation with a short open', () => {
    it('shows cash as the engine\'s share of equity, never negative', () =>
      eq(shorts.legend, ['Invested $8,000.00 (114.3%)', 'Cash $5,750.00 (82.1%)']));
    it('draws both bar segments with valid widths that fill the bar', () => {
      ok(shorts.segs.every((w) => /^\d+(\.\d+)?%$/.test(w)), JSON.stringify(shorts.segs));
      const sum = shorts.segs.reduce((s, w) => s + parseFloat(w), 0);
      ok(Math.abs(sum - 100) < 0.01, `segments sum to ${sum}`);
    });
    it('weighs a short like the blotter\'s % of book does', () => eq(shorts.weight, '96.4%'));
  });

  // Now a price move with the view open.
  await setPrices(page, { AAPL: 260 });
  const live = await page.evaluate(() => {
    const { app: A, views: V, engine: E } = window.PT;
    const view = document.querySelector('.pfview');
    const chart = A.S.equityChart;
    V.refreshPortfolioValues();
    const row = [...document.querySelectorAll('.pfview tbody tr')].find((tr) => /AAPL/.test(tr.textContent));
    const tile = [...document.querySelectorAll('.pfview .stat')].find((s) => /Unrealized/.test(s.textContent));
    const out = {
      hero: document.querySelector('.pfhero__value').textContent,
      row: [...row.querySelectorAll('td')].map((t) => t.textContent).slice(3),
      unrealized: tile.querySelector('.stat__value').textContent,
      inPlace: document.querySelector('.pfview') === view && A.S.equityChart === chart,
    };
    // A fill changes the holdings, so the next refresh rebuilds the table.
    E.submitOrder(A.pfUser(), { assetId: 'AAPL', side: 'sell', type: 'market', qty: 1 }, A.orderCtx('AAPL'));
    V.refreshPortfolioValues();
    const after = [...document.querySelectorAll('.pfview tbody tr')].find((tr) => /AAPL/.test(tr.textContent));
    out.qtyAfterFill = after.querySelectorAll('td')[1].textContent;
    return out;
  });

  describe('the portfolio view follows the tape', () => {
    it('the hero value moves with prices', () => eq(live.hero, '$9,400.00'));
    it('the holdings row agrees with its own Last price', () =>
      eq(live.row, ['$260.00', '$10,400.00', '+$2,400.00', '+30.00%', '110.6%']));
    it('the unrealized tile moves too', () => eq(live.unrealized, '-$600.00'));
    it('updates in place, keeping the view and its equity chart', () => ok(live.inPlace));
    it('and rebuilds when a fill changes the holdings', () => eq(live.qtyAfterFill, '39'));
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* ------------------------------------------ the portfolio between fills */

await scenario('the portfolio view between fills', async (open) => {
  const { page, errors } = await open({ height: 600 });
  await setPrices(page, { AAPL: 200.01, TSLA: 250 });
  await fill(page, 'AAPL', 'buy', 10);
  await fill(page, 'TSLA', 'buy', 8);
  await page.evaluate(() => window.PT.app.setView('portfolio'));
  const scrolled = await page.evaluate(() => {
    const view = document.querySelector('.pfview');
    view.scrollTop = view.scrollHeight;
    window.__pf = { view, chart: window.PT.app.S.equityChart };
    return view.scrollTop;
  });

  // TSLA's $2,000.16 now outranks AAPL's $2,000.00: the same holdings, reordered.
  await setPrices(page, { AAPL: 200, TSLA: 250.02 });
  const swapped = await page.evaluate(() => {
    const { app: A, views: V } = window.PT;
    V.refreshPortfolioValues();
    const view = document.querySelector('.pfview');
    return {
      kept: view === window.__pf.view && A.S.equityChart === window.__pf.chart,
      scrollTop: view.scrollTop,
      hero: document.querySelector('.pfhero__value').textContent,
    };
  });

  // With prices standing still, a repaint changes nothing — so a figure the
  // user has selected to copy stays selected.
  const still = await page.evaluate(() => {
    const V = window.PT.views;
    const row = [...document.querySelectorAll('.pfview tbody tr')].find((tr) => /AAPL/.test(tr.textContent));
    const out = {};
    for (const [key, node] of [
      ['hero', document.querySelector('.pfhero__value')],
      ['holding', row.querySelectorAll('td')[4]],
      ['tile', document.querySelector('.pfview .stat .stat__value')],
      ['legend', document.querySelector('.pfview .alloc__key')],
    ]) {
      const range = document.createRange();
      range.selectNodeContents(node);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      V.refreshPortfolioValues();
      out[key] = getSelection().toString();
    }
    getSelection().removeAllRanges();
    const watch = new MutationObserver(() => {});
    watch.observe(document.querySelector('.pfview'), { subtree: true, childList: true, characterData: true, attributes: true });
    V.refreshPortfolioValues();
    out.mutations = watch.takeRecords().length;
    watch.disconnect();
    return out;
  });

  describe('the portfolio view between fills', () => {
    it('keeps the view, its equity chart and its scroll when two holdings swap rank', () => {
      ok(scrolled > 0, 'the view did not scroll');
      eq(swapped, { kept: true, scrollTop: scrolled, hero: '$10,000.06' });
    });
    it('keeps a selected figure selected across a repaint', () => eq(still, {
      hero: '$10,000.06', holding: '$2,000.00', tile: '+$0.06', legend: 'Invested $4,000.16 (40.0%)', mutations: 0,
    }));
    it('throws nothing on the page', () => eq(errors, []));
  });
});

/* --------------------------------------------------------- accessibility */

await scenario('controls have accessible names', async (open) => {
  const { page, errors } = await open();
  await setPrices(page, { AAPL: 200 });
  const count = (role, opts, within) => (within ? page.locator(within) : page).getByRole(role, { exact: true, ...opts }).count();
  const names = {
    limit: await count('spinbutton', { name: 'Limit price (USD)' }, '.orderpane'),
    amount: await count('spinbutton', { name: 'Amount in USD' }, '.orderpane'),
    pressed: await page.locator('.orderpane .seg__item[aria-pressed="true"]').evaluateAll((b) => b.map((x) => x.textContent)),
    unpressed: await page.locator('.orderpane .seg__item[aria-pressed="false"]').count(),
  };
  await segBtn(page, 'Shares').click();
  names.qty = await count('spinbutton', { name: 'Quantity in AAPL' }, '.orderpane');

  await page.evaluate(() => window.PT.app.setView('ai'));
  names.send = await count('button', { name: 'Send' }, '.ai__composer');
  names.ask = await count('textbox', { name: 'Ask the AI companion' }, '.ai__composer');

  await page.locator('.rail__btn[aria-label="Settings"]').click();
  names.scheme = await count('combobox', { name: 'Direction colours' }, '.modal');
  await page.keyboard.press('Escape');

  await page.evaluate(() => window.PT.app.setView('accounts'));
  await page.locator('.accounts button:text-is("Rename")').first().click();
  names.rename = await count('textbox', { name: 'Account name' }, '.modal');

  describe('controls have accessible names', () => {
    it('the ticket\'s limit and amount fields say what they are', () =>
      eq([names.limit, names.amount, names.qty], [1, 1, 1]));
    it('segment buttons expose which one is active', () => {
      eq(names.pressed, ['Buy', 'Limit', 'Dollars']);
      eq(names.unpressed, 3);
    });
    it('the AI composer\'s send button and field are named', () => eq([names.send, names.ask], [1, 1]));
    it('the settings select and the rename field are named', () => eq([names.scheme, names.rename], [1, 1]));
    it('throws nothing on the page', () => eq(errors, []));
  });
});

await browser.close();
await report('ui regressions');
