/**
 * Connects to the real Coinbase websocket and pushes genuine live frames
 * through the exact parser the browser uses. This proves the endpoint, the
 * subscription payload and the field mapping are all correct against the real
 * service — not against a fixture.
 *
 * Also records a handful of real frames to test/fixtures/coinbase-ticker.json
 * so the browser test can replay them where outbound websockets are blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadPT, describe, it, eq, ok, near, report } from './harness.mjs';

const { PT } = loadPT([
  'src/app/js/00-util.js', 'src/app/js/01-calendar.js',
  'src/app/js/02-universe.js', 'src/app/js/05-data.js',
]);

const PRODUCTS = ['BTC-USD', 'ETH-USD', 'DOGE-USD'];

const frames = await new Promise((resolve) => {
  const got = [];
  let ws;
  const done = () => { try { ws.close(); } catch { /* already closed */ } resolve(got); };
  const timer = setTimeout(done, 20000);

  try {
    ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  } catch (e) {
    clearTimeout(timer);
    return resolve([]);
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: PRODUCTS, channels: ['ticker'] }));
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    got.push(m);
    if (got.filter((x) => x.type === 'ticker').length >= 6) { clearTimeout(timer); done(); }
  };
  ws.onerror = () => { clearTimeout(timer); done(); };
});

const tickers = frames.filter((f) => f.type === 'ticker');

describe('live Coinbase websocket', () => {
  it('the socket connects and delivers frames', () => ok(frames.length > 0, 'no frames received'));
  it('the subscription is acknowledged', () => ok(frames.some((f) => f.type === 'subscriptions'), 'no subscriptions ack'));
  it('real ticker frames arrive', () => ok(tickers.length > 0, `got ${frames.map((f) => f.type).join(',')}`));
});

describe('parsing real frames', () => {
  if (!tickers.length) {
    it('SKIPPED — no live frames available in this environment', () => ok(true));
  } else {
    it('every ticker frame parses into a quote', () => {
      for (const t of tickers) {
        const p = PT.feed.parseCoinbaseTicker(t);
        ok(p, `failed to parse ${JSON.stringify(t).slice(0, 120)}`);
        ok(isFinite(p.quote.price) && p.quote.price > 0, `bad price for ${p.symbol}`);
        eq(p.quote.source, 'coinbase-ws');
        eq(p.quote.quality, 'live');
      }
    });
    it('maps product ids onto our tradable symbols', () => {
      const syms = new Set(tickers.map((t) => PT.feed.parseCoinbaseTicker(t).symbol));
      for (const s of syms) ok(PT.byId[s], `${s} is not in the universe`);
    });
    it('derives a 24h change from the frame open', () => {
      const withOpen = tickers.map((t) => PT.feed.parseCoinbaseTicker(t)).filter((p) => p.quote.prevClose);
      ok(withOpen.length > 0, 'no frame carried open_24h');
      for (const p of withOpen) {
        near(p.quote.changePct, ((p.quote.price - p.quote.prevClose) / p.quote.prevClose) * 100, 1e-9);
      }
    });
    it('carries a bid and ask', () => {
      ok(tickers.map((t) => PT.feed.parseCoinbaseTicker(t)).some((p) => p.quote.bid > 0 && p.quote.ask > 0));
    });
    it('ignores non-ticker frames', () => {
      eq(PT.feed.parseCoinbaseTicker({ type: 'subscriptions', channels: [] }), null);
      eq(PT.feed.parseCoinbaseTicker({ type: 'heartbeat', product_id: 'BTC-USD' }), null);
      eq(PT.feed.parseCoinbaseTicker(null), null);
    });
    it('ignores products outside the universe', () => {
      eq(PT.feed.parseCoinbaseTicker({ type: 'ticker', product_id: 'XYZZY-USD', price: '1' }), null);
    });
  }
});

/* Record real frames for the browser test to replay. */
if (tickers.length) {
  const dir = path.join(process.cwd(), 'test/fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coinbase-ticker.json'), JSON.stringify(tickers.slice(0, 6), null, 2));
  console.log(`  recorded ${Math.min(6, tickers.length)} real frames to test/fixtures/coinbase-ticker.json`);
}

await report('live-feed');
