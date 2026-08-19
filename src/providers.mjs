/**
 * Upstream market-data providers with caching, request coalescing, failover
 * and honest freshness labelling.
 *
 * Every value this module hands back carries a `source` and a `quality`:
 *   live    — fetched from the primary source moments ago
 *   delayed — real data, but the upstream stamp is old (e.g. a closed market)
 *   cached  — served from our cache because upstream is unavailable right now
 * Nothing is ever invented. If we have no number, we return null.
 */
import { getJSON } from './http.mjs';
import { BY_ID, CRYPTO } from './universe.mjs';

/* ------------------------------------------------------------------ cache */

const cache = new Map();   // key -> { value, at, ttl }
const inflight = new Map(); // key -> Promise (coalesces duplicate concurrent work)

function cacheGet(key) {
  return cache.get(key) || null;
}
function cacheSet(key, value, ttl) {
  cache.set(key, { value, at: Date.now(), ttl });
  return value;
}

/**
 * Stale-while-revalidate: fresh entries return immediately; stale entries are
 * returned only if the refresh fails.
 */
async function through(key, ttl, fetcher) {
  const hit = cacheGet(key);
  if (hit && Date.now() - hit.at < ttl) return { ...hit.value, quality: hit.value.quality || 'live', ageMs: Date.now() - hit.at };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const fresh = await fetcher();
      cacheSet(key, fresh, ttl);
      return { ...fresh, ageMs: 0 };
    } catch (err) {
      if (hit) return { ...hit.value, quality: 'cached', ageMs: Date.now() - hit.at, error: err.message };
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/* ---------------------------------------------------- upstream throttling */

/**
 * Yahoo bans an IP for minutes after a burst, so we spend its budget very
 * deliberately: a token bucket for steady state, plus escalating cooldown
 * whenever it answers 429.
 */
function createLimiter({ capacity, refillMs }) {
  let tokens = capacity;
  let last = Date.now();
  let cooldownUntil = 0;
  let strikes = 0;

  return {
    get state() {
      return { tokens: Math.floor(tokens), cooling: Date.now() < cooldownUntil, cooldownUntil, strikes };
    },
    /** Wait for a token; throws if the provider is in cooldown. */
    async take() {
      const now = Date.now();
      if (now < cooldownUntil) {
        const e = new Error(`provider cooling down for ${Math.ceil((cooldownUntil - now) / 1000)}s`);
        e.cooling = true;
        throw e;
      }
      tokens = Math.min(capacity, tokens + (now - last) / refillMs);
      last = now;
      if (tokens < 1) {
        const waitMs = Math.ceil((1 - tokens) * refillMs);
        if (waitMs > 4000) {
          const e = new Error('rate limit budget exhausted');
          e.throttled = true;
          throw e;
        }
        await new Promise((r) => setTimeout(r, waitMs));
        tokens = 0;
        last = Date.now();
        return;
      }
      tokens -= 1;
    },
    penalise() {
      strikes = Math.min(strikes + 1, 5);
      const backoff = Math.min(300000, 20000 * 2 ** (strikes - 1)); // 20s → 5min
      cooldownUntil = Date.now() + backoff;
      tokens = 0;
      return backoff;
    },
    reward() { strikes = 0; },
  };
}

/*
 * query1 and query2 are rate limited independently — one can be in a penalty
 * box while the other answers 200 — so each gets its own budget and cooldown,
 * and we always spend from whichever host has the most headroom.
 */
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const yahooLimiters = Object.fromEntries(
  YAHOO_HOSTS.map((h) => [h, createLimiter({ capacity: 5, refillMs: 2500 })]),
);
const nasdaqLimiter = createLimiter({ capacity: 8, refillMs: 700 });
const geckoLimiter = createLimiter({ capacity: 5, refillMs: 2500 });

/** The host with the most tokens that is not cooling down, or null. */
function pickYahooHost() {
  const ready = YAHOO_HOSTS
    .map((h) => ({ h, st: yahooLimiters[h].state }))
    .filter((x) => !x.st.cooling)
    .sort((a, b) => b.st.tokens - a.st.tokens);
  return ready.length ? ready[0].h : null;
}

/**
 * GET a Yahoo path (starting with '/'), choosing a host with budget left.
 * Retrying during a penalty extends it, so a cooling host is never touched.
 */
async function yahooGet(pathAndQuery) {
  const host = pickYahooHost();
  if (!host) {
    const cools = YAHOO_HOSTS.map((h) => Math.ceil((yahooLimiters[h].state.cooldownUntil - Date.now()) / 1000));
    const e = new Error(`provider cooling down for ${Math.max(...cools)}s`);
    e.cooling = true;
    throw e;
  }
  const limiter = yahooLimiters[host];
  await limiter.take();
  try {
    const json = await getJSON(`https://${host}${pathAndQuery}`, { timeout: 9000 });
    limiter.reward();
    return json;
  } catch (e) {
    if (e.status === 429 || e.status === 999) {
      const ms = limiter.penalise();
      e.message = `Yahoo ${host.slice(0, 6)} rate limited (backing off ${Math.round(ms / 1000)}s)`;
    }
    throw e;
  }
}

/* ---------------------------------------------------------- stock quotes */

/** Parse a Yahoo v8 chart payload into a normalised quote. */
function quoteFromYahooChart(json, symbol) {
  const r = json?.chart?.result?.[0];
  if (!r || !r.meta) throw new Error(`no chart data for ${symbol}`);
  const m = r.meta;
  const price = m.regularMarketPrice;
  if (!isFinite(price)) throw new Error(`no price for ${symbol}`);
  const prev = isFinite(m.chartPreviousClose) ? m.chartPreviousClose
    : isFinite(m.previousClose) ? m.previousClose : null;
  const change = prev != null ? price - prev : null;

  return {
    symbol,
    price,
    prevClose: prev,
    change,
    changePct: prev ? (change / prev) * 100 : null,
    dayHigh: m.regularMarketDayHigh ?? null,
    dayLow: m.regularMarketDayLow ?? null,
    volume: m.regularMarketVolume ?? null,
    fiftyTwoHigh: m.fiftyTwoWeekHigh ?? null,
    fiftyTwoLow: m.fiftyTwoWeekLow ?? null,
    currency: m.currency || 'USD',
    exchange: m.fullExchangeName || m.exchangeName || null,
    marketState: m.marketState || null,
    quoteTime: (m.regularMarketTime || 0) * 1000 || null,
    source: 'yahoo',
    quality: 'live',
  };
}

/** Nasdaq's public quote endpoint — used when Yahoo is throttled. */
async function nasdaqQuote(symbol) {
  await nasdaqLimiter.take();
  const num = (s) => {
    if (s == null) return null;
    const v = parseFloat(String(s).replace(/[$,%+\s]/g, ''));
    return isFinite(v) ? v : null;
  };
  for (const cls of ['stocks', 'etf']) {
    try {
      const j = await getJSON(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${cls}`,
        { timeout: 8000 },
      );
      const d = j?.data;
      const pd = d?.primaryData;
      if (!d || !pd) continue;
      const price = num(pd.lastSalePrice);
      if (price == null) continue;
      const changePct = num(pd.percentageChange);
      const change = num(pd.netChange);
      return {
        symbol,
        price,
        change,
        changePct,
        prevClose: change != null ? price - change : null,
        currency: 'USD',
        exchange: d.exchange || null,
        // Nasdaq's free feed is explicitly not real-time.
        quality: pd.isRealTime ? 'live' : 'delayed',
        source: 'nasdaq',
        quoteTime: null,
      };
    } catch { /* try the next asset class */ }
  }
  throw new Error(`nasdaq has no quote for ${symbol}`);
}

/**
 * One stock quote, Yahoo first then Nasdaq, cached and coalesced.
 * `ttl` is short while the market is open and long when it is shut.
 */
export function stockQuote(symbol, ttl = 5000) {
  return through(`q:${symbol}`, ttl, async () => {
    try {
      const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=false`;
      return quoteFromYahooChart(await yahooGet(path), symbol);
    } catch (yErr) {
      try {
        return await nasdaqQuote(symbol);
      } catch (nErr) {
        throw new Error(`${yErr.message}; fallback: ${nErr.message}`);
      }
    }
  });
}

/** Batch quotes. Failures are per-symbol so one bad ticker cannot blank the board. */
export async function stockQuotes(symbols, ttl) {
  const out = {};
  const errors = {};
  await Promise.all(symbols.map(async (s) => {
    try { out[s] = await stockQuote(s, ttl); } catch (e) { errors[s] = e.message; }
  }));
  return { quotes: out, errors };
}

/* --------------------------------------------------------- crypto quotes */

const CB_BY_SYMBOL = Object.fromEntries(CRYPTO.map((c) => [c.symbol, c]));

/**
 * Crypto quote via Coinbase Exchange (24h stats + ticker). The browser normally
 * streams this over WebSocket; this REST path exists for the initial snapshot
 * and for browsers where the socket cannot connect.
 */
export function cryptoQuote(symbol, ttl = 4000) {
  return through(`c:${symbol}`, ttl, async () => {
    const meta = CB_BY_SYMBOL[symbol];
    if (!meta) throw new Error(`unknown crypto ${symbol}`);
    const [ticker, stats] = await Promise.all([
      getJSON(`https://api.exchange.coinbase.com/products/${meta.cb}/ticker`, { timeout: 8000 }),
      getJSON(`https://api.exchange.coinbase.com/products/${meta.cb}/stats`, { timeout: 8000 }),
    ]);
    const price = parseFloat(ticker.price);
    const open = parseFloat(stats.open);
    if (!isFinite(price)) throw new Error(`no price for ${symbol}`);
    const change = isFinite(open) ? price - open : null;
    return {
      symbol,
      price,
      prevClose: isFinite(open) ? open : null,
      change,
      changePct: isFinite(open) && open > 0 ? (change / open) * 100 : null,
      dayHigh: parseFloat(stats.high) || null,
      dayLow: parseFloat(stats.low) || null,
      volume: parseFloat(stats.volume) || null,
      bid: parseFloat(ticker.bid) || null,
      ask: parseFloat(ticker.ask) || null,
      currency: 'USD',
      exchange: 'Coinbase',
      source: 'coinbase',
      quality: 'live',
      quoteTime: ticker.time ? Date.parse(ticker.time) : null,
    };
  });
}

/**
 * Every Coinbase product's 24h stats in a single request (~110kb, ~0.4s).
 * One call covers the whole watchlist, so a snapshot costs the same whether the
 * user follows two coins or forty.
 */
function cryptoSnapshotAll(ttl = 5000) {
  return through('cb:stats', ttl, async () => ({
    stats: await getJSON('https://api.exchange.coinbase.com/products/stats', { timeout: 12000 }),
    source: 'coinbase', quality: 'live',
  }));
}

function quoteFromCoinbaseStats(symbol, row) {
  const price = parseFloat(row.last);
  if (!isFinite(price)) return null;
  const open = parseFloat(row.open);
  const change = isFinite(open) ? price - open : null;
  return {
    symbol,
    price,
    prevClose: isFinite(open) ? open : null,
    change,
    changePct: isFinite(open) && open > 0 ? (change / open) * 100 : null,
    dayHigh: parseFloat(row.high) || null,
    dayLow: parseFloat(row.low) || null,
    volume: parseFloat(row.volume) || null,
    currency: 'USD',
    exchange: 'Coinbase',
    source: 'coinbase',
    quality: 'live',
  };
}

export async function cryptoQuotes(symbols, ttl) {
  const out = {}; const errors = {};
  try {
    const snap = await cryptoSnapshotAll(ttl);
    const missing = [];
    for (const s of symbols) {
      const meta = CB_BY_SYMBOL[s];
      const row = meta && snap.stats[meta.cb] && snap.stats[meta.cb].stats_24hour;
      const q = row ? quoteFromCoinbaseStats(s, row) : null;
      if (q) out[s] = q; else missing.push(s);
    }
    // Anything the bulk feed did not cover falls back to a per-product call.
    await Promise.all(missing.map(async (s) => {
      try { out[s] = await cryptoQuote(s, ttl); } catch (e) { errors[s] = e.message; }
    }));
    return { quotes: out, errors };
  } catch (bulkErr) {
    await Promise.all(symbols.map(async (s) => {
      try { out[s] = await cryptoQuote(s, ttl); } catch (e) { errors[s] = e.message; }
    }));
    return { quotes: out, errors, note: `bulk snapshot failed: ${bulkErr.message}` };
  }
}

/** CoinGecko market snapshot — market cap and rank, refreshed slowly. */
export function cryptoMarkets(ids) {
  const key = `cg:${ids.slice().sort().join(',')}`;
  return through(key, 120000, async () => {
    await geckoLimiter.take();
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids='
      + encodeURIComponent(ids.join(',')) + '&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h';
    const rows = await getJSON(url, { timeout: 12000 });
    const byId = {};
    for (const r of rows) {
      byId[r.id] = {
        price: r.current_price,
        changePct: r.price_change_percentage_24h,
        marketCap: r.market_cap,
        rank: r.market_cap_rank,
        volume: r.total_volume,
        high24h: r.high_24h,
        low24h: r.low_24h,
      };
    }
    return { markets: byId, source: 'coingecko', quality: 'live' };
  });
}

/* -------------------------------------------------------------- candles */

/** Yahoo range/interval pairs that actually return data for each timeframe. */
const YH_TF = {
  '1m': { range: '1d', interval: '1m' },
  '5m': { range: '5d', interval: '5m' },
  '15m': { range: '1mo', interval: '15m' },
  '1h': { range: '3mo', interval: '60m' },
  '1D': { range: '2y', interval: '1d' },
  '1W': { range: '10y', interval: '1wk' },
};

/** Coinbase granularity (seconds) per timeframe; 1W is aggregated from 1D. */
const CB_TF = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1D': 86400, '1W': 86400 };

function candlesFromYahoo(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!ts || !q) throw new Error('no candle data');
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue; // Yahoo pads gaps with nulls
    out.push({ t: ts[i] * 1000, o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  if (!out.length) throw new Error('candle series was entirely empty');
  return out;
}

/** Roll daily candles up into weekly buckets (Monday-anchored). */
function toWeekly(daily) {
  const weeks = new Map();
  for (const d of daily) {
    const dt = new Date(d.t);
    const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
    const monday = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - dow);
    const w = weeks.get(monday);
    if (!w) weeks.set(monday, { t: monday, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v });
    else { w.h = Math.max(w.h, d.h); w.l = Math.min(w.l, d.l); w.c = d.c; w.v += d.v; }
  }
  return Array.from(weeks.values()).sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------- nasdaq candle fallback */

const NUM = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,%\s]/g, ''));
  return isFinite(n) ? n : null;
};

/** Bucket width in ms per timeframe, for aggregating intraday samples. */
const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3 };

/**
 * Nasdaq's intraday endpoint returns one price sample per minute rather than
 * OHLC bars, so we aggregate samples into buckets. The open/high/low/close of
 * each bucket are derived from real prints; only volume is unavailable, and it
 * is reported as 0 rather than invented.
 */
async function nasdaqIntradayCandles(symbol, tf) {
  await nasdaqLimiter.take();
  const width = TF_MS[tf];
  if (!width) throw new Error(`nasdaq intraday does not cover ${tf}`);

  let json = null;
  for (const cls of ['stocks', 'etf']) {
    try {
      const j = await getJSON(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/chart?assetclass=${cls}`,
        { timeout: 12000 },
      );
      if (j?.data?.chart?.length) { json = j; break; }
    } catch { /* try the next asset class */ }
  }
  if (!json) throw new Error(`nasdaq has no intraday chart for ${symbol}`);

  const buckets = new Map();
  for (const point of json.data.chart) {
    const t = Number(point.x);
    const price = Number(point.y);
    if (!isFinite(t) || !isFinite(price)) continue;
    const key = Math.floor(t / width) * width;
    const b = buckets.get(key);
    if (!b) buckets.set(key, { t: key, o: price, h: price, l: price, c: price, v: 0 });
    else {
      if (price > b.h) b.h = price;
      if (price < b.l) b.l = price;
      b.c = price;
    }
  }
  const bars = [...buckets.values()].sort((a, b) => a.t - b.t);
  if (!bars.length) throw new Error(`nasdaq intraday produced no bars for ${symbol}`);
  return bars;
}

/** Real daily OHLCV from Nasdaq's historical table. */
async function nasdaqDailyCandles(symbol, days = 400) {
  await nasdaqLimiter.take();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400e3);
  const iso = (d) => d.toISOString().slice(0, 10);

  let rows = null;
  for (const cls of ['stocks', 'etf']) {
    try {
      const j = await getJSON(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical`
        + `?assetclass=${cls}&fromdate=${iso(from)}&todate=${iso(to)}&limit=${days}`,
        { timeout: 12000 },
      );
      const r = j?.data?.tradesTable?.rows;
      if (r && r.length) { rows = r; break; }
    } catch { /* try the next asset class */ }
  }
  if (!rows) throw new Error(`nasdaq has no history for ${symbol}`);

  const bars = [];
  for (const r of rows) {
    const [m, d, y] = String(r.date).split('/').map(Number);
    const o = NUM(r.open), h = NUM(r.high), l = NUM(r.low), c = NUM(r.close);
    if (!isFinite(y) || o == null || h == null || l == null || c == null) continue;
    bars.push({ t: Date.UTC(y, m - 1, d), o, h, l, c, v: NUM(r.volume) || 0 });
  }
  if (!bars.length) throw new Error(`nasdaq history unparseable for ${symbol}`);
  return bars.sort((a, b) => a.t - b.t);
}

async function nasdaqCandles(symbol, tf) {
  if (tf === '1D') return nasdaqDailyCandles(symbol, 400);
  if (tf === '1W') return toWeekly(await nasdaqDailyCandles(symbol, 1500));
  return nasdaqIntradayCandles(symbol, tf);
}

const CANDLE_TTL = { '1m': 20000, '5m': 60000, '15m': 120000, '1h': 300000, '1D': 900000, '1W': 1800000 };

export function fetchCandles(assetId, tf) {
  const asset = BY_ID[assetId];
  if (!asset) return Promise.reject(new Error(`unknown asset ${assetId}`));
  const spec = YH_TF[tf];
  if (!spec) return Promise.reject(new Error(`unsupported timeframe ${tf}`));

  return through(`k:${assetId}:${tf}`, CANDLE_TTL[tf] ?? 60000, async () => {
    if (asset.kind === 'crypto') {
      try {
        const gran = CB_TF[tf];
        const j = await getJSON(
          `https://api.exchange.coinbase.com/products/${asset.cb}/candles?granularity=${gran}`,
          { timeout: 10000 },
        );
        // Coinbase rows are [time, low, high, open, close, volume], newest first.
        let bars = j.map((r) => ({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
          .sort((a, b) => a.t - b.t);
        if (!bars.length) throw new Error('empty coinbase candles');
        if (tf === '1W') bars = toWeekly(bars);
        return { bars, source: 'coinbase', quality: 'live', tf, assetId };
      } catch (cbErr) {
        const path = `/v8/finance/chart/${encodeURIComponent(asset.yh)}?range=${spec.range}&interval=${spec.interval}`;
        const bars = candlesFromYahoo(await yahooGet(path));
        return { bars, source: 'yahoo', quality: 'live', tf, assetId, note: `coinbase: ${cbErr.message}` };
      }
    }

    try {
      const path = `/v8/finance/chart/${encodeURIComponent(asset.yh)}?range=${spec.range}&interval=${spec.interval}`;
      return { bars: candlesFromYahoo(await yahooGet(path)), source: 'yahoo', quality: 'live', tf, assetId };
    } catch (yErr) {
      const bars = await nasdaqCandles(asset.symbol, tf);
      return {
        bars, source: 'nasdaq', quality: 'delayed', tf, assetId,
        // Nasdaq's free intraday feed carries prices but no per-bar volume.
        volume: tf === '1D' || tf === '1W',
        note: `yahoo: ${yErr.message}`,
      };
    }
  });
}

/* --------------------------------------------------------------- search */

/** Ticker lookup: Yahoo's search, falling back to our local universe. */
export function searchSymbols(query) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve({ results: [], source: 'local' });

  const local = () => {
    const needle = q.toLowerCase();
    const results = Object.values(BY_ID)
      .filter((a) => a.id.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle))
      .slice(0, 20)
      .map((a) => ({ symbol: a.id, name: a.name, kind: a.kind, exchange: a.kind === 'crypto' ? 'Coinbase' : 'US', tradable: true }));
    return { results, source: 'local' };
  };

  return through(`s:${q.toLowerCase()}`, 300000, async () => {
    try {
      const j = await yahooGet(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`);
      const seen = new Set();
      const results = (j.quotes || [])
        .filter((r) => r.symbol && ['EQUITY', 'ETF', 'CRYPTOCURRENCY', 'INDEX', 'MUTUALFUND'].includes(r.quoteType))
        .filter((r) => (seen.has(r.symbol) ? false : (seen.add(r.symbol), true)))
        .map((r) => {
          const isCrypto = r.quoteType === 'CRYPTOCURRENCY';
          // A Yahoo crypto symbol like "BTC-USD" maps onto our tradable universe.
          const base = isCrypto ? String(r.symbol).replace(/-USD$/, '') : r.symbol;
          const known = BY_ID[base];
          return {
            symbol: known ? known.id : r.symbol,
            name: r.longname || r.shortname || r.symbol,
            kind: isCrypto ? 'crypto' : (r.quoteType === 'ETF' ? 'etf' : 'stock'),
            exchange: r.exchDisp || r.exchange || '',
            // Only assets we can actually price and trade are marked tradable.
            tradable: !!known || (!isCrypto && ['EQUITY', 'ETF'].includes(r.quoteType)),
          };
        });
      // Merge in local matches so our own universe always surfaces first.
      const localRes = local().results;
      const merged = [...localRes, ...results.filter((r) => !localRes.some((l) => l.symbol === r.symbol))];
      return { results: merged.slice(0, 20), source: 'yahoo' };
    } catch {
      return local();
    }
  });
}

/* --------------------------------------------------------------- health */

export function providerHealth() {
  return {
    yahoo: Object.fromEntries(YAHOO_HOSTS.map((h) => [h.split('.')[0], yahooLimiters[h].state])),
    nasdaq: nasdaqLimiter.state,
    coingecko: geckoLimiter.state,
    cacheEntries: cache.size,
    inflight: inflight.size,
  };
}
