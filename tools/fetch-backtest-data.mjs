/**
 * Pull real daily candles for a broad basket and freeze them to a fixture, so
 * the backtest is deterministic and runs offline. Re-run it to refresh the
 * window; the file it writes is the only thing the backtest reads.
 */
import fs from 'node:fs';
import { fetchCandles } from '../src/providers.mjs';

const STOCKS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'NFLX', 'JPM',
  'XOM', 'WMT', 'KO', 'PFE', 'DIS', 'BA', 'INTC', 'F', 'PLTR', 'SOFI',
  'SPY', 'QQQ', 'IWM', 'GLD', 'TLT'];
const CRYPTO = ['BTC', 'ETH', 'SOL', 'DOGE', 'LTC', 'LINK', 'AVAX', 'XRP'];

const out = {};
for (const s of STOCKS) {
  try {
    const r = await fetchCandles(s, '1D', { kind: 'stock' });
    if (r.bars.length > 150) out[s] = { kind: 'stock', bars: r.bars, source: r.source };
    console.log(`${s}: ${r.bars.length} bars (${r.source})`);
  } catch (e) { console.log(`${s}: FAILED ${e.message}`); }
}
for (const s of CRYPTO) {
  try {
    const r = await fetchCandles(s, '1D', { kind: 'crypto' });
    if (r.bars.length > 150) out[s] = { kind: 'crypto', bars: r.bars, source: r.source };
    console.log(`${s}: ${r.bars.length} bars (${r.source})`);
  } catch (e) { console.log(`${s}: FAILED ${e.message}`); }
}

const path = 'test/fixtures/backtest-daily.json';
fs.writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), assets: out }));
const n = Object.keys(out).length;
console.log(`\nwrote ${path}: ${n} assets, ${(fs.statSync(path).size / 1024).toFixed(0)}kb`);
