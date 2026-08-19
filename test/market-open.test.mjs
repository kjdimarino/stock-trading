/**
 * Exercises the equity path with the market OPEN.
 *
 * Everything else runs whenever the suite happens to run, which overnight means
 * equities are always shut and the primary stock-trading flow is never touched.
 * Here the calendar is pinned to a real open session so stock orders, resting
 * limits and the AI trader's equity path all get covered.
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

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const args = ['--no-sandbox', '--disable-dev-shm-usage'];
if (PROXY) args.push(`--proxy-server=${PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, ignoreHTTPSErrors: !!PROXY });

/*
 * Pin the market clock open. This replaces only the session verdict — holiday
 * rules, DST maths and everything downstream still run for real.
 */
await ctx.addInitScript(() => {
  const install = () => {
    if (!window.PT || !window.PT.calendar) return false;
    window.PT.calendar.stockStatus = () => ({
      phase: 'open', label: 'Market open', isOpen: true, early: false,
      nextChange: Date.now() + 3600e3, nextLabel: 'Closes',
      etTime: '10:30', etDate: '2026-08-19',
    });
    return true;
  };
  if (!install()) {
    const iv = setInterval(() => { if (install()) clearInterval(iv); }, 10);
    setTimeout(() => clearInterval(iv), 8000);
  }
});

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  section('Setup with the market open');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.onboard', { timeout: 20000 });
  await page.locator('.preset', { hasText: '$100K' }).click();
  await page.locator('button', { hasText: 'Start trading' }).click();
  await page.waitForSelector('.terminal', { timeout: 20000 });

  check('session pill reports the market as open',
    /market open/i.test(await page.locator('.session').innerText()));

  await page.waitForFunction(() => {
    const p = window.PT.feed.prices;
    return Object.keys(p).some((k) => !window.PT.isCrypto(k) && isFinite(p[k].price));
  }, { timeout: 60000 });

  const sym = await page.evaluate(() => {
    const p = window.PT.feed.prices;
    return Object.keys(p).find((k) => !window.PT.isCrypto(k) && isFinite(p[k].price));
  });
  check('a stock is priced', !!sym, sym);

  await page.evaluate((s) => window.PT.app.setFocus(s), sym);
  await page.waitForTimeout(2000);

  section('Stock order flow');
  const err = await page.locator('.order__err').isVisible();
  check('no "market closed" rejection while open', !err,
    err ? await page.locator('.order__err').innerText() : '');

  await page.locator('.orderpane .seg__item', { hasText: 'Market' }).click();
  await page.locator('.orderpane .seg__item', { hasText: 'Dollars' }).click();
  await page.locator('.orderpane input[type="number"]').last().fill('5000');
  await page.waitForTimeout(400);
  check('buy button is enabled for a stock during the session',
    !(await page.locator('.orderpane .btn--lg').isDisabled()));

  await page.locator('.orderpane .btn--lg').click();
  await page.waitForTimeout(1200);
  const bought = await page.evaluate((s) => {
    const pf = window.PT.app.pfUser();
    return { pos: pf.positions[s], cash: pf.cash, fills: pf.fills.length };
  }, sym);
  check('stock market buy fills', !!bought.pos && bought.fills === 1);
  check('fractional shares are supported on equities',
    bought.pos && bought.pos.qty % 1 !== 0, bought.pos ? `qty=${bought.pos.qty}` : '');
  check('cash debited ≈ the order value', Math.abs(100000 - bought.cash - 5000) < 5,
    `spent ${(100000 - bought.cash).toFixed(2)}`);

  section('Resting stock limit order fills when the price crosses');
  const px = await page.evaluate((s) => window.PT.feed.prices[s].price, sym);
  await page.locator('.orderpane .seg__item', { hasText: 'Limit' }).click();
  await page.waitForTimeout(300);
  // A buy limit well below the market must rest, not fill.
  await page.locator('.orderpane input[type="number"]').first().fill(String((px * 0.8).toFixed(2)));
  await page.locator('.orderpane input[type="number"]').last().fill('1000');
  await page.waitForTimeout(300);
  await page.locator('.orderpane .btn--lg').click();
  await page.waitForTimeout(800);
  check('stock limit order rests while out of the money',
    (await page.evaluate(() => window.PT.app.pfUser().orders.length)) === 1);

  // Drop the quote through the limit; the run loop should fill it.
  await page.evaluate((s) => {
    const q = window.PT.feed.prices[s];
    window.PT.feed.applyQuote(s, { ...q, price: q.price * 0.7 });
  }, sym);
  await page.waitForTimeout(2500);
  const afterCross = await page.evaluate(() => {
    const pf = window.PT.app.pfUser();
    return { orders: pf.orders.length, fills: pf.fills.length };
  });
  check('the resting stock limit fills once the market crosses it',
    afterCross.orders === 0 && afterCross.fills === 2,
    `orders=${afterCross.orders} fills=${afterCross.fills}`);

  section('Selling a stock during the session');
  await page.locator('.orderpane .seg__item', { hasText: 'Sell' }).click();
  await page.locator('.orderpane .seg__item', { hasText: 'Market' }).click();
  await page.waitForTimeout(300);
  await page.locator('.orderpane .btn', { hasText: 'Max' }).click();
  await page.waitForTimeout(400);
  check('Max sell is submittable for a stock',
    !(await page.locator('.orderpane .btn--lg').isDisabled()),
    await page.locator('.order__err').innerText().catch(() => ''));
  await page.locator('.orderpane .btn--lg').click();
  await page.waitForTimeout(1200);
  const sold = await page.evaluate((s) => {
    const pf = window.PT.app.pfUser();
    return { pos: pf.positions[s], sells: pf.fills.filter((f) => f.side === 'sell').length };
  }, sym);
  check('stock position closes out', !sold.pos);
  check('the sell is recorded', sold.sells === 1);

  section('AI trader considers equities while open');
  const aiOut = await page.evaluate(async () => {
    await window.PT.boot.aiCycle();
    return window.PT.app.S.st.aiLog.map((d) => ({ action: d.action, why: d.why, assetId: d.assetId }));
  });
  check('the AI logged a decision', aiOut.length > 0);
  check('the AI no longer claims equities are closed',
    !aiOut.some((d) => /equities are closed/i.test(d.why)),
    aiOut.map((d) => d.why).join(' | ').slice(0, 140));

  section('Diagnostics');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await page.screenshot({ path: 'test/screenshot-market-open.png' });
} catch (e) {
  fail++;
  failures.push(`harness crashed: ${e.message}`);
  console.log(`\n\x1b[31mHARNESS ERROR\x1b[0m ${e.stack}`);
  try { await page.screenshot({ path: 'test/screenshot-open-failure.png' }); } catch { /* ignore */ }
} finally {
  await browser.close();
}

console.log(`\n${fail ? '\x1b[31m✗' : '\x1b[32m✓'} market-open: ${pass}/${pass + fail} passed\x1b[0m`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
