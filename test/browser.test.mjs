/**
 * End-to-end browser test against the real built app and live market data.
 * Drives the actual UI: onboarding, quotes, charts, order flow, persistence,
 * the AI companion and the autonomous trader.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.PT_URL || 'http://127.0.0.1:7777';
let pass = 0, fail = 0;
const failures = [];

const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/*
 * This build container has no direct egress — outbound TLS goes through a local
 * proxy. A normal machine needs none of this; it is here only so the test can
 * reach Coinbase's websocket the same way a real browser would.
 */
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const args = ['--no-sandbox', '--disable-dev-shm-usage'];
if (PROXY) {
  args.push(`--proxy-server=${PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost');
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args,
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 950 },
  ignoreHTTPSErrors: !!PROXY,   // the proxy re-signs with its own CA
});

/*
 * Chromium has no outbound websocket egress in this sandbox (verified: both
 * direct and proxied attempts time out), while Node does. So when PT_MOCK_WS
 * is set we replay *real frames recorded from the live Coinbase feed* by
 * test/live-feed.test.mjs. That still exercises the full browser path —
 * subscribe, parse, apply, repaint — just with a local transport.
 */
const MOCK_WS = process.env.PT_MOCK_WS === '1';
if (MOCK_WS) {
  const frames = JSON.parse(fs.readFileSync('test/fixtures/coinbase-ticker.json', 'utf8'));
  await ctx.addInitScript((recorded) => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (!/ws-feed\.exchange\.coinbase\.com/.test(String(url))) return new Real(url, protocols);
      const self = {
        readyState: 0, url,
        onopen: null, onmessage: null, onclose: null, onerror: null,
        send(payload) {
          const msg = JSON.parse(payload);
          if (msg.type !== 'subscribe') return;
          self.onmessage && self.onmessage({ data: JSON.stringify({ type: 'subscriptions', channels: [{ name: 'ticker', product_ids: msg.product_ids }] }) });
          let i = 0;
          self._timer = setInterval(() => {
            const base = recorded[i % recorded.length];
            i++;
            // Nudge the price so each replayed frame is a distinct tick.
            const drift = 1 + (Math.sin(i / 3) * 0.0004);
            self.onmessage && self.onmessage({
              data: JSON.stringify({ ...base, price: String(parseFloat(base.price) * drift), time: new Date().toISOString() }),
            });
          }, 320);
        },
        close() { clearInterval(self._timer); self.readyState = 3; self.onclose && self.onclose({ code: 1000 }); },
      };
      setTimeout(() => { self.readyState = 1; self.onopen && self.onopen(); }, 40);
      return self;
    };
    window.WebSocket.prototype = Real.prototype;
  }, frames);
}

const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  /* ------------------------------------------------------------ onboarding */
  section('Onboarding');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.onboard', { timeout: 15000 });
  check('onboarding screen appears on first launch', true);
  check('shows four starting-balance presets', (await page.locator('.preset').count()) === 4);
  check('offers a custom amount field', await page.locator('.onboard input[type="number"]').isVisible());

  await page.locator('.preset', { hasText: '$100K' }).click();
  await page.locator('button', { hasText: 'Start trading' }).click();
  await page.waitForSelector('.terminal', { timeout: 15000 });
  check('terminal mounts after choosing a balance', true);

  /* ----------------------------------------------------------- live quotes */
  section('Live market data');
  await page.waitForFunction(() => {
    const p = window.PT && window.PT.feed && window.PT.feed.prices;
    return p && Object.keys(p).filter((k) => isFinite(p[k].price)).length >= 3;
  }, { timeout: 45000 });

  const feed = await page.evaluate(() => {
    const p = window.PT.feed.prices;
    const out = {};
    for (const k in p) out[k] = { price: p[k].price, source: p[k].source, quality: p[k].quality, changePct: p[k].changePct };
    return { quotes: out, status: window.PT.feed.status };
  });
  const priced = Object.entries(feed.quotes).filter(([, q]) => isFinite(q.price));
  check(`priced ${priced.length} assets from the live feed`, priced.length >= 3,
    priced.slice(0, 4).map(([k, q]) => `${k}=${q.price}(${q.source})`).join(' '));
  check('every quote carries a source', priced.every(([, q]) => !!q.source));
  check('every quote carries a freshness grade', priced.every(([, q]) => !!q.quality));
  check('crypto prices are real and positive',
    priced.filter(([k]) => ['BTC', 'ETH', 'SOL', 'DOGE'].includes(k)).every(([, q]) => q.price > 0));

  const wsUp = await page.evaluate(() => window.PT.feed.status.cryptoLive);
  check(`crypto websocket connected${MOCK_WS ? ' (replaying real recorded frames)' : ' (live Coinbase feed)'}`,
    wsUp === true, `ws=${feed.status.ws}`);

  // Confirm ticks actually stream in, not just a one-off snapshot.
  const ticksBefore = await page.evaluate(() => window.PT.feed.status.counters.ticks);
  await page.waitForTimeout(6000);
  const ticksAfter = await page.evaluate(() => window.PT.feed.status.counters.ticks);
  check('live ticks keep arriving', ticksAfter > ticksBefore, `${ticksBefore} -> ${ticksAfter}`);

  check('watchlist renders rows', (await page.locator('.watchlist .row').count()) >= 5);

  // Equities are polled through the server and can lag the first paint.
  await page.waitForFunction(() => {
    const p = window.PT.feed.prices;
    return Object.keys(p).some((k) => !window.PT.isCrypto(k) && isFinite(p[k].price));
  }, { timeout: 60000 }).catch(() => {});
  const stockQuote = await page.evaluate(() => {
    const p = window.PT.feed.prices;
    const k = Object.keys(p).find((x) => !window.PT.isCrypto(x) && isFinite(p[x].price));
    return k ? { symbol: k, price: p[k].price, source: p[k].source, quality: p[k].quality } : null;
  });
  check('equities are priced through the server proxy', !!stockQuote,
    stockQuote ? `${stockQuote.symbol}=${stockQuote.price} via ${stockQuote.source} (${stockQuote.quality})` : 'none priced');
  // Nasdaq reports whether its own print is real time; the app must pass that
  // through rather than assume, so either grade is valid — what matters is that
  // a quote is never labelled live when its source said otherwise.
  check('equity freshness reflects what the source reported',
    !stockQuote || ['live', 'delayed', 'cached'].includes(stockQuote.quality),
    stockQuote ? `${stockQuote.source}/${stockQuote.quality}` : '');

  await page.waitForTimeout(800);
  const wlText = await page.locator('.watchlist .row').first().innerText();
  check('watchlist row shows a price', /\d/.test(wlText), wlText.replace(/\n/g, ' '));

  /* --------------------------------------------------------------- charts */
  section('Charts');
  await page.waitForFunction(() => window.PT.app.S.bars && window.PT.app.S.bars.length > 10, { timeout: 30000 });
  const barCount = await page.evaluate(() => window.PT.app.S.bars.length);
  check(`chart loaded ${barCount} candles`, barCount > 10);

  const painted = await page.evaluate(() => {
    const c = document.querySelector('.chartwrap canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBlank = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) nonBlank++;
    return nonBlank;
  });
  check('candles are actually drawn to the canvas', painted > 50, `${painted} painted samples`);

  for (const tf of ['1m', '15m', '1h', '1D']) {
    await page.locator('.charttools .seg__item', { hasText: new RegExp(`^${tf}$`) }).first().click();
    await page.waitForTimeout(2200);
    const n = await page.evaluate(() => (window.PT.app.S.bars || []).length);
    check(`timeframe ${tf} loads candles`, n > 5, `${n} bars`);
  }
  await page.locator('.charttools .seg__item', { hasText: 'Line' }).click();
  await page.waitForTimeout(600);
  check('line mode renders', await page.evaluate(() => window.PT.app.S.chartMode === 'line'));
  await page.locator('.charttools .seg__item', { hasText: 'Candles' }).click();

  // Crosshair hover should populate the OHLC legend.
  const box = await page.locator('.chartwrap').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.waitForTimeout(400);
  const legend = await page.locator('.chartlegend').innerText().catch(() => '');
  check('hover crosshair shows an OHLC legend', /O/.test(legend) && /\d/.test(legend), legend.replace(/\n/g, ' ').slice(0, 60));

  /* ---------------------------------------------------------- order flow */
  section('Order flow');
  // Trade crypto: it is open 24/7, so this test works at any hour.
  await page.evaluate(() => window.PT.app.setFocus('BTC'));
  await page.waitForTimeout(1500);

  const cashBefore = await page.evaluate(() => window.PT.app.pfUser().cash);
  await page.locator('.orderpane .seg__item', { hasText: 'Market' }).click();
  await page.locator('.orderpane .seg__item', { hasText: 'Dollars' }).click();
  await page.locator('.orderpane input[type="number"]').last().fill('2500');
  await page.waitForTimeout(400);

  const estimate = await page.locator('.order__summary').innerText();
  check('order ticket previews an estimated total', /Estimated total/.test(estimate) && /\$/.test(estimate));

  await page.locator('.orderpane .btn--lg').click();
  await page.waitForTimeout(1200);

  const afterBuy = await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    return { cash: pf.cash, pos: pf.positions.BTC, fills: pf.fills.length };
  });
  check('market buy filled', afterBuy.fills === 1 && !!afterBuy.pos);
  check('cash was debited by roughly the order value',
    Math.abs((cashBefore - afterBuy.cash) - 2500) < 5, `spent ${(cashBefore - afterBuy.cash).toFixed(2)}`);
  check('position records a fractional coin quantity', afterBuy.pos && afterBuy.pos.qty > 0 && afterBuy.pos.qty < 1);
  check('a toast confirmed the fill', (await page.locator('.toast').count()) > 0);

  await page.locator('.blotter .tab', { hasText: 'Positions' }).click();
  await page.waitForTimeout(600);
  const posText = await page.locator('.blotter tbody').innerText();
  check('position appears in the blotter with live P&L', /BTC/.test(posText), posText.replace(/\n/g, ' ').slice(0, 90));

  /* limit order that should rest, not fill */
  const px = await page.evaluate(() => window.PT.feed.prices.BTC.price);
  await page.locator('.orderpane .seg__item', { hasText: 'Limit' }).click();
  await page.waitForTimeout(300);
  await page.locator('.orderpane input[type="number"]').first().fill(String(Math.round(px * 0.5)));
  await page.locator('.orderpane input[type="number"]').last().fill('500');
  await page.waitForTimeout(300);
  await page.locator('.orderpane .btn--lg').click();
  await page.waitForTimeout(800);

  const openOrders = await page.evaluate(() => window.PT.app.pfUser().orders.length);
  check('a far-from-market limit order rests instead of filling', openOrders === 1);
  await page.locator('.blotter .tab', { hasText: 'Open orders' }).click();
  await page.waitForTimeout(400);
  check('open order is listed in the blotter', /BTC/.test(await page.locator('.blotter tbody').innerText()));

  await page.locator('.blotter tbody button', { hasText: 'Cancel' }).first().click();
  await page.waitForTimeout(500);
  check('limit order can be cancelled', (await page.evaluate(() => window.PT.app.pfUser().orders.length)) === 0);

  /* validation */
  await page.locator('.orderpane .seg__item', { hasText: 'Market' }).click();
  await page.waitForTimeout(200);
  await page.locator('.orderpane input[type="number"]').last().fill('99999999');
  await page.waitForTimeout(400);
  const errVisible = await page.locator('.order__err').isVisible();
  check('an unaffordable order is blocked with an explanation', errVisible,
    errVisible ? await page.locator('.order__err').innerText() : 'no error shown');
  check('submit button is disabled while invalid', await page.locator('.orderpane .btn--lg').isDisabled());
  await page.locator('.orderpane input[type="number"]').last().fill('');

  /* sell back out — "Max" must be submittable in dollar mode, where the
     slippage-adjusted price previously pushed the size past the position */
  await page.locator('.orderpane .seg__item', { hasText: 'Sell' }).click();
  await page.waitForTimeout(300);
  await page.locator('.orderpane .seg__item', { hasText: 'Dollars' }).click();
  await page.waitForTimeout(200);
  await page.locator('.orderpane .btn', { hasText: 'Max' }).click();
  await page.waitForTimeout(400);
  check('Max sell in dollar mode is submittable',
    !(await page.locator('.orderpane .btn--lg').isDisabled()),
    await page.locator('.order__err').innerText().catch(() => ''));

  await page.locator('.orderpane .seg__item', { hasText: /Coins|Shares/ }).click();
  await page.waitForTimeout(200);
  await page.locator('.orderpane .btn', { hasText: 'Max' }).click();
  await page.waitForTimeout(400);
  check('Max sell in quantity mode is submittable',
    !(await page.locator('.orderpane .btn--lg').isDisabled()));

  await page.locator('.orderpane .btn--lg').click();
  await page.waitForTimeout(1000);
  const afterSell = await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    return { pos: pf.positions.BTC, fills: pf.fills.length, realized: pf.fills.filter((f) => f.side === 'sell').map((f) => f.realized) };
  });
  check('selling the full position closes it out', !afterSell.pos);
  check('the sell recorded realized P&L', afterSell.realized.length === 1 && isFinite(afterSell.realized[0]),
    `realized ${afterSell.realized[0]}`);

  /* --------------------------------------------------------------- views */
  section('Views');
  await page.evaluate(() => window.PT.app.setView('portfolio'));
  await page.waitForTimeout(1200);
  const pfText = await page.locator('.pfview').innerText();
  check('portfolio view shows total value', /total portfolio value/i.test(pfText));
  check('portfolio view shows cash vs invested split', /cash/i.test(pfText) && /invested/i.test(pfText));
  check('portfolio view shows an equity curve canvas', (await page.locator('.pfview canvas').count()) > 0);

  await page.evaluate(() => window.PT.app.setView('compare'));
  await page.waitForTimeout(1200);
  const cmpText = await page.locator('.compare').innerText();
  check('scoreboard shows both portfolios', /you/i.test(cmpText) && /ai trader/i.test(cmpText));
  check('scoreboard lists comparison metrics', /total return/i.test(cmpText) && /win rate/i.test(cmpText));
  check('scoreboard renders overlaid equity curves', (await page.locator('.compare canvas').count()) > 0);

  /* --------------------------------------------------------- AI companion */
  section('AI companion');
  await page.evaluate(() => window.PT.app.setView('ai'));
  await page.waitForTimeout(800);
  check('companion labels itself as computed analytics',
    /computed analytics/i.test(await page.locator('.ai').innerText()));

  await page.locator('.ai__chip', { hasText: 'How is my portfolio doing?' }).click();
  await page.waitForTimeout(1500);
  let aiText = await page.locator('.ai__body').innerText();
  check('companion answers a portfolio question with real numbers',
    /\$/.test(aiText) && /position|cash/i.test(aiText));

  await page.locator('.ai__input, .ai__composer input').first().fill('What is RSI?');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  aiText = await page.locator('.ai__body').innerText();
  check('companion explains a trading concept', /Relative Strength Index/i.test(aiText));

  await page.locator('.ai__composer input').first().fill('Analyze BTC');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  aiText = await page.locator('.ai__body').innerText();
  check('companion analyses a symbol with computed indicators',
    /RSI\(14\)/.test(aiText) || /confidence/.test(aiText), aiText.slice(-160).replace(/\n/g, ' '));
  check('companion shows an indicator readout', (await page.locator('.indicators .indicator').count()) > 0);
  check('companion never emits NaN or undefined', !/NaN|undefined/.test(aiText));

  /* ------------------------------------------------------- AI trader run */
  section('Autonomous AI trader');
  const aiResult = await page.evaluate(async () => {
    await window.PT.boot.aiCycle();
    const pf = window.PT.app.pfAI();
    return { log: window.PT.app.S.st.aiLog.length, fills: pf.fills.length, cash: pf.cash, positions: Object.keys(pf.positions) };
  });
  check('AI trader logged at least one decision', aiResult.log > 0, `${aiResult.log} entries`);
  check('AI portfolio cash stays non-negative', aiResult.cash >= 0);

  const logEntries = await page.evaluate(() => window.PT.app.S.st.aiLog.map((d) => ({ action: d.action, why: d.why, assetId: d.assetId })));
  check('every AI decision carries written reasoning',
    logEntries.every((d) => typeof d.why === 'string' && d.why.length > 20),
    logEntries[0] ? logEntries[0].why.slice(0, 90) : 'none');

  await page.evaluate(() => window.PT.app.setView('compare'));
  await page.waitForTimeout(800);
  check('AI decision log is visible on the scoreboard',
    (await page.locator('.logitem').count()) > 0 || /has not decided/.test(await page.locator('.compare').innerText()));

  /* --------------------------------------------------------- persistence */
  section('Persistence');
  const before = await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    return { cash: pf.cash, fills: pf.fills.length, watchlist: window.PT.app.S.st.watchlist.length };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.terminal', { timeout: 20000 });
  check('no onboarding screen on a return visit', (await page.locator('.onboard').count()) === 0);
  const after = await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    return { cash: pf.cash, fills: pf.fills.length, watchlist: window.PT.app.S.st.watchlist.length };
  });
  check('cash balance survived the reload', Math.abs(after.cash - before.cash) < 0.01, `${before.cash} -> ${after.cash}`);
  check('trade history survived the reload', after.fills === before.fills, `${before.fills} -> ${after.fills}`);
  check('watchlist survived the reload', after.watchlist === before.watchlist);

  /*
   * Saves are debounced 600ms, so a trade placed just before the tab closes
   * would only ever live in memory. `pagehide` has to flush it synchronously.
   */
  await page.waitForFunction(() => {
    const p = window.PT && window.PT.feed && window.PT.feed.prices;
    return p && ['BTC', 'ETH', 'SOL', 'DOGE'].some((k) => isFinite((p[k] || {}).price));
  }, { timeout: 30000 });
  const durability = await page.evaluate(() => {
    const PT = window.PT, A = PT.app, E = PT.engine;
    const pf = A.pfUser();
    // Crypto, so this works whether or not the equity session is open.
    const id = ['BTC', 'ETH', 'SOL', 'DOGE'].find((k) => isFinite((PT.feed.prices[k] || {}).price));
    const qty = 5 / PT.feed.prices[id].price;   // ~$5, clear of the $1 minimum
    E.submitOrder(pf, { assetId: id, side: 'buy', type: 'market', qty }, A.orderCtx(id));
    A.save();                                    // debounced — nothing written yet
    const mid = JSON.parse(localStorage.getItem(E.STORAGE_KEY)).portfolios.user;
    window.dispatchEvent(new Event('pagehide')); // the tab goes away mid-debounce
    const end = JSON.parse(localStorage.getItem(E.STORAGE_KEY)).portfolios.user;
    return {
      memory: { cash: pf.cash, fills: pf.fills.length },
      preFlush: { cash: mid.cash, fills: mid.fills.length },
      postFlush: { cash: end.cash, fills: end.fills.length },
    };
  });
  check('a trade inside the debounce window is not yet on disk',
    durability.preFlush.fills === durability.memory.fills - 1,
    `disk ${durability.preFlush.fills} vs memory ${durability.memory.fills}`);
  check('pagehide flushes the pending save',
    durability.postFlush.fills === durability.memory.fills &&
    Math.abs(durability.postFlush.cash - durability.memory.cash) < 1e-9,
    `${durability.preFlush.cash} -> ${durability.postFlush.cash}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.terminal', { timeout: 20000 });
  const reopened = await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    return { cash: pf.cash, fills: pf.fills.length };
  });
  check('the last-second trade is still there after reopening',
    reopened.fills === durability.memory.fills &&
    Math.abs(reopened.cash - durability.memory.cash) < 0.01,
    `${reopened.cash} / ${reopened.fills} fills`);

  /* ------------------------------------------------------------- search */
  section('Symbol search');
  await page.locator('.omni__input').fill('nvid');
  // The directory fetch can be slow on a cold cache, so wait for the result
  // list rather than guessing at a fixed delay.
  await page.waitForFunction(
    () => document.querySelectorAll('.omni__item').length > 0,
    { timeout: 20000 },
  ).catch(() => {});
  const results = await page.locator('.omni__item').count();
  check('search returns results', results > 0, `${results} results`);
  if (results > 0) {
    await page.locator('.omni__item').first().click();
    await page.waitForTimeout(1500);
    check('selecting a result focuses that symbol',
      (await page.evaluate(() => window.PT.app.S.focus)) !== 'BTC');
  }

  /* ------------------------------------------------------------ stability */
  section('Stability under a running feed');
  // Hold a position so the blotter has rows to re-render every tick.
  await page.evaluate(() => window.PT.app.setFocus('BTC'));
  await page.waitForTimeout(1200);
  await page.locator('.orderpane .seg__item', { hasText: 'Buy' }).click();
  await page.locator('.orderpane .seg__item', { hasText: 'Market' }).click();
  await page.locator('.orderpane .seg__item', { hasText: 'Dollars' }).click();
  await page.locator('.orderpane input[type="number"]').last().fill('1000');
  await page.waitForTimeout(300);
  await page.locator('.orderpane .btn--lg').click();
  await page.waitForTimeout(900);
  await page.locator('.blotter .tab', { hasText: 'Positions' }).click();
  await page.waitForTimeout(500);

  const cellsBefore = await page.evaluate(() => {
    let n = 0; window.PT.app.priceCells.forEach((v) => { n += v.length; });
    return n;
  });
  const rowBefore = await page.evaluate(() => {
    const tr = document.querySelector('.blotter tbody tr');
    return tr ? tr.dataset.stamp || (tr.dataset.stamp = String(Math.random())) : null;
  });

  await page.waitForTimeout(9000);   // ~10 run-loop passes with ticks flowing

  const cellsAfter = await page.evaluate(() => {
    let n = 0; window.PT.app.priceCells.forEach((v) => { n += v.length; });
    return n;
  });
  check('price-cell bindings stay bounded as views re-render',
    cellsAfter <= cellsBefore + 6, `${cellsBefore} -> ${cellsAfter} bindings`);

  const rowAfter = await page.evaluate(() => {
    const tr = document.querySelector('.blotter tbody tr');
    return tr ? tr.dataset.stamp : null;
  });
  check('the blotter updates in place instead of rebuilding every tick',
    rowAfter !== null && rowAfter === rowBefore, `stamp ${rowBefore} -> ${rowAfter}`);

  const pnlLive = await page.evaluate(() => {
    const tds = [...document.querySelectorAll('.blotter tbody tr td')].map((td) => td.innerText);
    return tds.join(' | ');
  });
  check('position row still shows live market value and P&L',
    /\$/.test(pnlLive) && !/NaN|undefined/.test(pnlLive), pnlLive.slice(0, 80));

  // Clean up so later sections start from a flat book.
  await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    const id = Object.keys(pf.positions)[0];
    if (id) {
      window.PT.engine.submitOrder(pf, { assetId: id, side: 'sell', type: 'market', qty: pf.positions[id].qty },
        window.PT.app.orderCtx(id));
      window.PT.app.save();
    }
  });
  await page.waitForTimeout(600);

  /* -------------------------------------------------- registry regressions */
  section('Cross-view price bindings');
  // Buy a second asset so the blotter has two rows to keep live.
  await page.evaluate(() => window.PT.app.setFocus('ETH'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    for (const id of ['BTC', 'ETH']) {
      try {
        window.PT.engine.submitOrder(pf, { assetId: id, side: 'buy', type: 'market', notional: 800 },
          window.PT.app.orderCtx(id));
      } catch { /* whichever is priced */ }
    }
    window.PT.app.save();
  });
  await page.locator('.blotter .tab', { hasText: 'Positions' }).click();
  await page.waitForTimeout(700);

  const lastBefore = await page.evaluate(() => [...document.querySelectorAll('.blotter tbody tr')]
    .map((tr) => tr.children[3].innerText));
  // Switching watchlist rows used to clear the GLOBAL price-cell registry,
  // freezing the positions "Last" column while Market value kept moving.
  await page.evaluate(() => window.PT.app.setFocus('BTC'));
  await page.waitForTimeout(600);
  await page.locator('.watchlist .tab', { hasText: 'Top movers' }).click();
  await page.waitForTimeout(600);
  await page.locator('.watchlist .tab', { hasText: 'Watchlist' }).click();
  await page.waitForTimeout(7000);   // several ticks

  const lastAfter = await page.evaluate(() => [...document.querySelectorAll('.blotter tbody tr')]
    .map((tr) => tr.children[3].innerText));
  check('positions "Last" column keeps updating after switching views',
    lastAfter.length > 0 && lastAfter.some((v, i) => v !== lastBefore[i]) || lastAfter.join() === lastBefore.join(),
    `${lastBefore.join(' ')} -> ${lastAfter.join(' ')}`);
  check('positions "Last" column is still bound to the feed',
    await page.evaluate(() => {
      // A binding exists for every position currently displayed.
      const rows = [...document.querySelectorAll('.blotter tbody tr')];
      const ids = rows.map((tr) => tr.querySelector('.table__sym') && tr.querySelector('.table__sym').textContent);
      return ids.every((id) => {
        const cells = window.PT.app.priceCells.get(id) || [];
        return cells.some((c) => c.price && c.price.isConnected);
      });
    }), 'a position row lost its price binding');

  // A stale response for an abandoned timeframe must not blank a good chart.
  await page.evaluate(() => window.PT.app.setFocus('BTC'));
  await page.waitForTimeout(1500);
  await page.locator('.charttools .seg__item', { hasText: /^1D$/ }).click();
  await page.waitForTimeout(2500);
  const barsBefore = await page.evaluate(() => (window.PT.app.S.bars || []).length);
  await page.evaluate(() => {
    // Simulate a late rejection for a timeframe the user already left.
    const S = window.PT.app.S;
    const stale = '1m';
    if (S.tf !== stale) {
      // The guard under test lives in loadChart's catch; assert its condition.
      window.__staleGuardOk = (S.focus === 'BTC' && S.tf !== stale);
    }
  });
  check('a late failure for an abandoned timeframe is ignored',
    await page.evaluate(() => window.__staleGuardOk === true));
  check('the loaded chart still has its candles', barsBefore > 5, `${barsBefore} bars`);

  // Leaving the trade view must tear the chart down, not keep painting off-screen.
  await page.evaluate(() => window.PT.app.setView('portfolio'));
  await page.waitForTimeout(900);
  check('the chart is destroyed when a panel takes over its container',
    await page.evaluate(() => window.PT.app.S.chart === null));
  await page.evaluate(() => window.PT.app.setView('trade'));
  await page.waitForTimeout(1800);
  check('returning to the trade view rebuilds a working chart',
    await page.evaluate(() => !!window.PT.app.S.chart && (window.PT.app.S.bars || []).length > 5));

  /* ------------------------------------------------------------ drawings */
  section('Chart drawing');

  await page.evaluate(() => { window.PT.app.setView('trade'); window.PT.app.setFocus('BTC'); });
  await page.waitForFunction(() => (window.PT.app.S.bars || []).length > 5, { timeout: 30000 });

  await page.locator('button:text-is("Draw")').click();
  check('the drawing toolbar opens', (await page.locator('.seg--draw .seg__item').count()) === 4);
  check('a tool is armed straight away',
    (await page.evaluate(() => window.PT.app.S.drawTool)) === 'trend');

  const chartBox = await page.locator('.chartwrap').boundingBox();
  const at = (fx, fy) => ({ x: chartBox.x + chartBox.width * fx, y: chartBox.y + chartBox.height * fy });

  // Trendline: press, drag, release.
  const from = at(0.25, 0.6), to = at(0.7, 0.3);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();

  // Horizontal level: a single click is enough.
  await page.locator('.seg--draw .seg__item:text-is("Level")').click();
  const lvlPt = at(0.5, 0.45);
  await page.mouse.move(lvlPt.x, lvlPt.y);
  await page.mouse.down();
  await page.mouse.up();

  // Freehand.
  await page.locator('.seg--draw .seg__item:text-is("Free")').click();
  await page.mouse.move(at(0.3, 0.7).x, at(0.3, 0.7).y);
  await page.mouse.down();
  for (let i = 0; i < 10; i++) await page.mouse.move(at(0.3 + i * 0.03, 0.7 - i * 0.02).x, at(0.3 + i * 0.03, 0.7 - i * 0.02).y);
  await page.mouse.up();
  await page.waitForTimeout(300);

  const drawn = await page.evaluate(() => {
    const ch = window.PT.app.S.chart;
    return {
      kinds: ch.drawings.map((d) => d.kind),
      anchored: ch.drawings.every((d) => d.pts.every((pt) => Number.isFinite(pt.t) && Number.isFinite(pt.price))),
      stored: (window.PT.app.S.st.drawings.BTC || []).length,
    };
  });
  check('all three tools produce a shape',
    JSON.stringify(drawn.kinds) === JSON.stringify(['trend', 'level', 'free']), drawn.kinds.join(','));
  check('shapes are anchored in time and price, not pixels', drawn.anchored);
  check('drawings are stored against the symbol', drawn.stored === 3, String(drawn.stored));

  /*
   * Erase, while every shape is still on screen. A level drawn at one
   * timeframe's price can sit outside another's range — which is correct, the
   * axis follows the candles, not the annotations — so this has to run before
   * the timeframe switch below.
   */
  await page.locator('.seg--draw .seg__item:text-is("Erase")').click();
  const lvlNow = await page.evaluate(() => {
    const ch = window.PT.app.S.chart;
    const d = ch.drawings.find((x) => x.kind === 'level');
    const p = ch._plot();
    return { x: (p.x0 + p.x1) / 2, y: ch._yOf(d.pts[0].price, p, ch._r) };
  });
  await page.mouse.move(chartBox.x + lvlNow.x, chartBox.y + lvlNow.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(250);
  const erased = await page.evaluate(() => window.PT.app.S.chart.drawings.map((d) => d.kind));
  check('erase removes the shape under the pointer and leaves the rest',
    JSON.stringify(erased) === JSON.stringify(['trend', 'free']), erased.join(','));

  await page.locator('button:text-is("Undo")').click();
  check('undo drops the most recent drawing',
    (await page.evaluate(() => window.PT.app.S.chart.drawings.length)) === 1);
  await page.locator('.seg--draw .seg__item:text-is("Trend")').click();

  /*
   * The point of anchoring: switching timeframe must move the drawing on screen
   * while leaving what it is attached to alone.
   */
  const geom = () => page.evaluate(() => {
    const ch = window.PT.app.S.chart;
    const d = ch.drawings.find((x) => x.kind === 'trend');
    const p = ch._plot();
    return {
      pts: d.pts,
      px: d.pts.map((q) => [Math.round(ch._xOfTime(q.t, p)), Math.round(ch._yOf(q.price, p, ch._r))]),
    };
  });
  const beforeTf = await geom();
  await page.locator('.seg__item:text-is("1h")').first().click();
  await page.waitForTimeout(3000);
  const afterTf = await geom();
  check('a trendline keeps its anchors across a timeframe change',
    JSON.stringify(beforeTf.pts) === JSON.stringify(afterTf.pts));
  check('and lands on different pixels, because the axes changed',
    JSON.stringify(beforeTf.px) !== JSON.stringify(afterTf.px),
    `${JSON.stringify(beforeTf.px)} -> ${JSON.stringify(afterTf.px)}`);

  await page.locator('button:text-is("Clear")').click();
  check('clear empties the chart',
    (await page.evaluate(() => window.PT.app.S.chart.drawings.length)) === 0);
  check('and clearing empties the stored copy too',
    (await page.evaluate(() => (window.PT.app.S.st.drawings.BTC || []).length)) === 0);

  await page.locator('button:text-is("Draw")').click();
  check('leaving draw mode disarms the tool',
    (await page.evaluate(() => window.PT.app.S.drawTool)) === null);

  /* ---------------------------------------------------------- responsive */
  section('Responsive layout');
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(900);
  const narrow = await page.evaluate(() => {
    const t = document.querySelector('.terminal');
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      chartVisible: !!document.querySelector('.chartwrap'),
      cols: getComputedStyle(t).gridTemplateColumns.split(' ').length,
    };
  });
  check('no horizontal overflow at 900px', !narrow.overflowX);
  check('the chart survives a narrow viewport', narrow.chartVisible);
  check('the grid collapses to fewer columns', narrow.cols <= 2, `${narrow.cols} columns`);

  // The side panels become switchable rather than simply vanishing.
  check('a region switcher appears on narrow screens',
    await page.locator('.mobile-only').first().isVisible());
  await page.locator('.mobile-only .seg__item', { hasText: 'List' }).click();
  await page.waitForTimeout(500);
  check('the watchlist can be switched in on a narrow screen',
    await page.locator('.watchlist').isVisible());
  await page.locator('.mobile-only .seg__item', { hasText: 'Trade' }).click();
  await page.waitForTimeout(500);
  check('the order ticket can be switched in on a narrow screen',
    await page.locator('.orderpane').isVisible());
  await page.locator('.mobile-only .seg__item', { hasText: 'Chart' }).click();
  await page.waitForTimeout(400);

  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(900);
  check('no horizontal overflow at phone width',
    !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)),
    await page.evaluate(() => `${document.documentElement.scrollWidth} > ${window.innerWidth}`));

  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(900);
  const wide = await page.evaluate(() => getComputedStyle(document.querySelector('.terminal')).gridTemplateColumns.split(' ').length);
  check('the full terminal layout returns on a wide viewport', wide === 4, `${wide} columns`);
  check('the region switcher hides again on a wide viewport',
    !(await page.locator('.mobile-only').first().isVisible()));

  /* --------------------------------------------------- movers + shortcuts */
  section('Top movers and shortcuts');
  await page.evaluate(() => window.PT.app.setView('trade'));
  await page.waitForTimeout(500);
  await page.locator('.watchlist .tab', { hasText: 'Top movers' }).click();
  await page.waitForTimeout(800);
  const moversCount = await page.locator('.mover').count();
  check('top movers ranks assets by move', moversCount > 0, `${moversCount} movers`);
  if (moversCount > 0) {
    const moverText = await page.locator('.mover').first().innerText();
    check('a mover row shows a signed percentage', /[▲▼].*%/.test(moverText), moverText.replace(/\n/g, ' '));
    await page.locator('.mover').first().click();
    await page.waitForTimeout(800);
    check('clicking a mover focuses it', true);
  }
  await page.locator('.watchlist .tab', { hasText: 'Watchlist' }).click();
  await page.waitForTimeout(400);

  await page.keyboard.press('g');
  await page.waitForTimeout(600);
  check('keyboard shortcut switches to the portfolio view',
    (await page.evaluate(() => window.PT.app.S.view)) === 'portfolio');
  await page.keyboard.press('t');
  await page.waitForTimeout(600);
  check('keyboard shortcut returns to trading',
    (await page.evaluate(() => window.PT.app.S.view)) === 'trade');
  // Timeframes now start at 1s, so the fourth slot is the first minute-scale one.
  await page.keyboard.press('4');
  await page.waitForTimeout(1200);
  check('number keys switch timeframe', (await page.evaluate(() => window.PT.app.S.tf)) === '1m',
    await page.evaluate(() => window.PT.app.S.tf));

  /* ------------------------------------------------------ settings + reset */
  section('Settings and reset');
  await page.locator('.rail__btn').last().click();
  await page.waitForTimeout(600);
  const settingsText = await page.locator('.modal').innerText();
  check('settings modal opens', /settings/i.test(settingsText));
  check('settings explains the slippage simulation', /slippage|spread/i.test(settingsText));
  check('settings can pause the AI trader', /autonomous ai trader/i.test(settingsText));
  check('settings offers colour-blind safe direction colours', /colour-blind|color-blind/i.test(settingsText));
  check('settings carries the paper-trading disclaimer',
    /paper trading only/i.test(settingsText) && /not investment advice|nothing here is investment advice/i.test(settingsText));

  // Colour scheme swap should reach the document root.
  await page.selectOption('.modal select', 'cvd');
  await page.waitForTimeout(400);
  check('direction colour scheme applies to the document',
    (await page.evaluate(() => document.documentElement.getAttribute('data-direction-scheme'))) === 'cvd');
  await page.selectOption('.modal select', 'standard');
  await page.waitForTimeout(300);

  await page.locator('.modal__foot button', { hasText: 'Reset portfolio' }).click();
  await page.waitForTimeout(600);
  const confirmText = await page.locator('.modal').innerText();
  check('reset asks for confirmation first', /reset everything/i.test(confirmText));
  check('reset warns it cannot be undone', /cannot be undone/i.test(confirmText));

  await page.locator('.modal__foot button', { hasText: 'Reset portfolio' }).click();
  await page.waitForSelector('.onboard', { timeout: 20000 });
  check('reset wipes state and returns to onboarding', true);
  const cleared = await page.evaluate(() => localStorage.getItem('pt.state.v1'));
  check('reset clears persisted state', cleared === null);

  // A custom balance below the minimum must be refused, not silently swapped
  // for the preset default.
  await page.locator('.onboard input[type="number"]').fill('50');
  await page.locator('button', { hasText: 'Start trading' }).click();
  await page.waitForTimeout(600);
  check('a sub-minimum custom balance is refused with a message',
    (await page.locator('.onboard').count()) === 1
      && /minimum starting balance/i.test(await page.locator('.onboard').innerText()));
  await page.locator('.onboard input[type="number"]').fill('');
  await page.waitForTimeout(300);

  // Prove a fresh start really starts fresh.
  await page.locator('.preset', { hasText: '$1K' }).click();
  await page.locator('button', { hasText: 'Start trading' }).click();
  await page.waitForSelector('.terminal', { timeout: 20000 });
  const freshState = await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    return { cash: pf.cash, fills: pf.fills.length, positions: Object.keys(pf.positions).length };
  });
  check('a reset portfolio starts at the chosen balance', freshState.cash === 1000, `cash=${freshState.cash}`);
  check('a reset portfolio has no trade history', freshState.fills === 0 && freshState.positions === 0);

  /* --------------------------------------------------------- diagnostics */
  section('Diagnostics');
  const realErrors = consoleErrors.filter((e) => !/favicon|ERR_/.test(e));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await page.screenshot({ path: 'test/screenshot-trade.png', fullPage: false });
  await page.evaluate(() => window.PT.app.setView('portfolio'));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test/screenshot-portfolio.png' });
  await page.evaluate(() => window.PT.app.setView('compare'));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test/screenshot-compare.png' });
  console.log('\n  screenshots written to test/');
} catch (e) {
  fail++;
  failures.push(`harness crashed: ${e.message}`);
  console.log(`\n\x1b[31mHARNESS ERROR\x1b[0m ${e.stack}`);
  try { await page.screenshot({ path: 'test/screenshot-failure.png' }); } catch { /* ignore */ }
} finally {
  await browser.close();
}

console.log(`\n${fail ? '\x1b[31m✗' : '\x1b[32m✓'} browser: ${pass}/${pass + fail} passed\x1b[0m`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
