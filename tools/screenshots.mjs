/**
 * Captures the README screenshots from a settled app with a realistic book,
 * rather than from whatever state a test run happened to end in.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.PT_URL || 'http://127.0.0.1:7777';
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const args = ['--no-sandbox', '--disable-dev-shm-usage'];
if (PROXY) args.push(`--proxy-server=${PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2, ignoreHTTPSErrors: !!PROXY,
});

/* Replay real recorded Coinbase frames so crypto is live even where this
   sandbox blocks outbound websockets. */
if (fs.existsSync('test/fixtures/coinbase-ticker.json')) {
  const frames = JSON.parse(fs.readFileSync('test/fixtures/coinbase-ticker.json', 'utf8'));
  await ctx.addInitScript((recorded) => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (!/ws-feed\.exchange\.coinbase\.com/.test(String(url))) return new Real(url, protocols);
      const self = {
        readyState: 0, url, onopen: null, onmessage: null, onclose: null, onerror: null,
        send(payload) {
          const msg = JSON.parse(payload);
          if (msg.type !== 'subscribe') return;
          let i = 0;
          self._timer = setInterval(() => {
            const base = recorded[i % recorded.length]; i++;
            self.onmessage && self.onmessage({
              data: JSON.stringify({ ...base, price: String(parseFloat(base.price) * (1 + Math.sin(i / 4) * 0.0006)), time: new Date().toISOString() }),
            });
          }, 400);
        },
        close() { clearInterval(self._timer); self.readyState = 3; },
      };
      setTimeout(() => { self.readyState = 1; self.onopen && self.onopen(); }, 40);
      return self;
    };
    window.WebSocket.prototype = Real.prototype;
  }, frames);
}

const page = await ctx.newPage();
// Always start from a clean slate: inheriting a previous run's account meant
// the seeded orders were rejected for insufficient cash.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded' });

await page.waitForSelector('.onboard', { timeout: 20000 });
await page.locator('.preset', { hasText: '$100K' }).click();
await page.locator('button', { hasText: 'Start trading' }).click();
await page.waitForSelector('.terminal', { timeout: 20000 });

// Wait for BOTH asset classes to be priced. Waiting only for a count is not
// enough: crypto alone satisfies it, and the stock orders below would then be
// rejected for having no price.
await page.waitForFunction(() => {
  const p = window.PT.feed.prices;
  const priced = (pred) => Object.keys(p).some((k) => pred(k) && isFinite(p[k].price));
  return priced((k) => window.PT.isCrypto(k)) && priced((k) => !window.PT.isCrypto(k));
}, { timeout: 90000 });

/* Build a book worth looking at, at prices that are already on screen. */
const seeded = await page.evaluate(() => {
  const placed = [];
  const pf = window.PT.app.pfUser();
  const plan = [['NVDA', 12000], ['AAPL', 9000], ['BTC', 14000], ['ETH', 6500], ['SPY', 11000], ['DOGE', 2500]];
  for (const [id, amount] of plan) {
    try {
      window.PT.engine.submitOrder(pf, { assetId: id, side: 'buy', type: 'market', notional: amount },
        { prices: window.PT.feed.prices, marketOpen: true, slippageEnabled: true, now: Date.now() });
      placed.push(id);
    } catch (e) { placed.push(id + ':' + e.message.slice(0, 40)); }
  }
  // A resting order so the ticket and blotter both have something to show.
  const q = window.PT.feed.prices.BTC;
  if (q) {
    try {
      window.PT.engine.submitOrder(pf, { assetId: 'BTC', side: 'buy', type: 'limit', notional: 3000, limitPrice: q.price * 0.94 },
        { prices: window.PT.feed.prices, marketOpen: true, slippageEnabled: true, now: Date.now() });
    } catch { /* ignore */ }
  }
  /*
   * The equity curve is deliberately NOT seeded. Synthesising a pretty line for
   * a documentation screenshot would be fabricating data, which is the one
   * thing this app is built not to do. The curve below is whatever the running
   * app actually sampled.
   */
  window.PT.app.save();
  return placed;
});
console.log('seeded:', seeded.join(', '));
if (!seeded.some((p) => !p.includes(':'))) throw new Error('no seed orders filled — screenshots would be empty');

/* Let the run loop accumulate real equity samples (it samples every 10s), so
   the curve in the screenshots is genuine rather than invented. */
await page.waitForFunction(() => window.PT.app.pfUser().equity.length >= 7, { timeout: 120000 }).catch(() => {});

await page.evaluate(() => window.PT.app.setFocus('NVDA'));
await page.waitForTimeout(1000);
await page.locator('.charttools .seg__item', { hasText: /^1D$/ }).click();
await page.waitForTimeout(3500);
await page.locator('.blotter .tab', { hasText: 'Positions' }).click();
await page.waitForTimeout(1500);

// Let sparklines finish drawing.
await page.waitForFunction(() => document.querySelectorAll('.row__spark path').length >= 4, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);

await page.screenshot({ path: 'test/screenshot-trade.png' });

await page.evaluate(() => window.PT.app.setView('portfolio'));
await page.waitForTimeout(2000);
await page.screenshot({ path: 'test/screenshot-portfolio.png' });

await page.evaluate(async () => { await window.PT.boot.aiCycle(); window.PT.app.setView('compare'); });
await page.waitForTimeout(2500);
await page.screenshot({ path: 'test/screenshot-compare.png' });

await page.evaluate(() => window.PT.app.setView('ai'));
await page.waitForTimeout(600);
await page.evaluate(() => window.PT.views.askCompanion('How is my portfolio doing?'));
await page.waitForTimeout(1500);
await page.evaluate(() => window.PT.views.askCompanion('Analyze NVDA'));
await page.waitForTimeout(4000);
await page.screenshot({ path: 'test/screenshot-ai.png' });

console.log('screenshots written');
await browser.close();
