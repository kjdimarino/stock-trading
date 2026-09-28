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
  // fetchedAt lets the client order two quotes that carry no exchange stamp.
  if (hit && Date.now() - hit.at < ttl) return { ...hit.value, quality: hit.value.quality || 'live', ageMs: Date.now() - hit.at, fetchedAt: hit.at };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const fresh = await fetcher();
      cacheSet(key, fresh, ttl);
      return { ...fresh, ageMs: 0, fetchedAt: cache.get(key).at };
    } catch (err) {
      if (hit) return { ...hit.value, quality: 'cached', ageMs: Date.now() - hit.at, fetchedAt: hit.at, error: err.message };
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
/**
 * Leaky bucket with burst, scheduled by *reservation*.
 *
 * A token-count-plus-sleep design is unsafe under concurrency: every caller
 * runs its own `take()` body synchronously before any await resolves, so N
 * callers all observe the same token count, all sleep the same interval and
 * all fire together — the bucket admits the exact burst it exists to prevent.
 *
 * Here each caller claims the next free slot and advances `nextAt` before
 * awaiting anything, so N concurrent callers are spaced `refillMs` apart no
 * matter how they interleave.
 */
function createLimiter({ capacity, refillMs, maxWaitMs = 4000 }) {
  /*
   * GCRA (generic cell rate algorithm): a leaky bucket with burst, expressed
   * as a single "theoretical arrival time".
   *
   * A token-count-plus-sleep design is unsafe under concurrency — every caller
   * runs its own `take()` body synchronously before any await resolves, so N
   * callers observe the same count, sleep the same interval and fire together,
   * admitting the exact burst the limiter exists to prevent. Here each caller
   * claims its slot by advancing `tat` before awaiting anything, so ordering is
   * deterministic no matter how they interleave.
   */
  const interval = refillMs;
  const burst = Math.max(0, capacity - 1) * interval;   // tolerance
  let tat = 0;                                          // next theoretical arrival
  let cooldownUntil = 0;
  let strikes = 0;
  let penalisedAt = -Infinity;                          // when the last strike landed

  return {
    get state() {
      const now = Date.now();
      // How many requests could still go out immediately.
      const spare = Math.max(0, burst - Math.max(0, tat - now));
      return {
        tokens: Math.min(capacity, Math.floor(spare / interval) + (tat <= now ? 1 : 0)),
        cooling: now < cooldownUntil,
        cooldownUntil,
        strikes,
      };
    },

    /** Reserve a slot. Throws if the provider is cooling or the queue is long. */
    async take() {
      const now = Date.now();
      if (now < cooldownUntil) {
        const e = new Error(`provider cooling down for ${Math.ceil((cooldownUntil - now) / 1000)}s`);
        e.cooling = true;
        throw e;
      }
      const start = Math.max(now, tat);
      const wait = Math.max(0, start - burst - now);
      if (wait > maxWaitMs) {
        const e = new Error('rate limit budget exhausted');
        e.throttled = true;
        throw e;
      }
      tat = start + interval;   // claimed synchronously, before any await
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
        /*
         * Re-check on the way out: if an earlier request in this burst was
         * penalised while we queued, spending our slot would only extend the
         * ban, and every queued caller would sit out its full wait before
         * finding that out. Bail so the fallback provider is reached quickly.
         */
        const after = Date.now();
        if (after < cooldownUntil) {
          const e = new Error(`provider cooling down for ${Math.ceil((cooldownUntil - after) / 1000)}s`);
          e.cooling = true;
          throw e;
        }
      }
    },

    /*
     * `sentAt` is when the refused request went out. Everything already in
     * flight when the first 429 lands was sent into the same ban and answers
     * 429 too; counting each of those as a strike would take one burst
     * straight to the five-minute maximum. Likewise a late success from before
     * the ban does not clear it. (Nothing is sent after a penalty until the
     * cooldown ends, so a request stamped the same millisecond went before
     * it.) Called without it, every call counts.
     */
    penalise(sentAt = Infinity) {
      if (sentAt <= penalisedAt) return Math.max(0, cooldownUntil - Date.now());
      strikes = Math.min(strikes + 1, 5);
      penalisedAt = Date.now();
      const backoff = Math.min(300000, 20000 * 2 ** (strikes - 1)); // 20s → 5min
      cooldownUntil = Date.now() + backoff;
      tat = cooldownUntil;
      return backoff;
    },
    reward(sentAt = Infinity) { if (sentAt > penalisedAt) strikes = 0; },
  };
}

const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const yahooLimiters = Object.fromEntries(
  YAHOO_HOSTS.map((h) => [h, createLimiter({ capacity: 5, refillMs: 2500, maxWaitMs: 12000 })]),
);
const nasdaqLimiter = createLimiter({ capacity: 10, refillMs: 450, maxWaitMs: 20000 });
const geckoLimiter = createLimiter({ capacity: 5, refillMs: 2500, maxWaitMs: 20000 });
const coinbaseLimiter = createLimiter({ capacity: 10, refillMs: 120, maxWaitMs: 10000 });

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
  const sentAt = Date.now();
  try {
    const json = await getJSON(`https://${host}${pathAndQuery}`, { timeout: 9000 });
    limiter.reward(sentAt);
    return json;
  } catch (e) {
    if (e.status === 429 || e.status === 999) {
      const ms = limiter.penalise(sentAt);
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
  // isFinite(null) is true, so a null or zero price has to be ruled out by hand.
  if (!(Number.isFinite(price) && price > 0)) throw new Error(`no price for ${symbol}`);
  const prev = isFinite(m.chartPreviousClose) ? m.chartPreviousClose
    : isFinite(m.previousClose) ? m.previousClose : null;
  const change = prev != null ? price - prev : null;

  const quoteTime = (m.regularMarketTime || 0) * 1000 || null;
  const stampAgeMs = quoteTime ? Date.now() - quoteTime : null;
  const fresh = m.marketState === 'REGULAR' && (stampAgeMs == null || stampAgeMs < 15 * 60000);

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
    quoteTime,
    source: 'yahoo',
    /*
     * Real data, but the print may be old: outside regular hours this is the
     * last close, not a live quote, and labelling it 'live' would put a pulsing
     * green dot on a Friday price all weekend.
     */
    quality: fresh ? 'live' : 'delayed',
  };
}

/*
 * Class shares have three spellings: the Nasdaq screener writes BRK/B, Yahoo
 * (and the curated list) BRK-B, and Nasdaq's quote API BRK.B. Each upstream
 * 404s the others. Ids are kept in the Yahoo form and translated on the way
 * out; the slash form is still accepted, since ids already saved may use it.
 */
const yahooSymbol = (s) => String(s).replace(/^([A-Z]+)\/([A-Z])$/, '$1-$2');
const nasdaqSymbol = (s) => String(s).replace(/^([A-Z]+)[-/]([A-Z])$/, '$1.$2');

/**
 * Nasdaq needs an `assetclass`, and guessing wrong costs a full round trip
 * (~3s). Our own universe already knows, so order the attempts accordingly.
 */
function assetClassesFor(symbol) {
  const known = BY_ID[symbol];
  return known && known.kind === 'etf' ? ['etf', 'stocks'] : ['stocks', 'etf'];
}

/** Nasdaq's public quote endpoint — used when Yahoo is throttled. */
async function nasdaqQuote(symbol) {
  const num = (s) => {
    if (s == null) return null;
    const v = parseFloat(String(s).replace(/[$,%+\s]/g, ''));
    return isFinite(v) ? v : null;
  };
  for (const cls of assetClassesFor(symbol)) {
    try {
      // A token per request: this loop can fire twice if the first class misses.
      await nasdaqLimiter.take();
      const j = await getJSON(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(nasdaqSymbol(symbol))}/info?assetclass=${cls}`,
        { timeout: 8000 },
      );
      const d = j?.data;
      const pd = d?.primaryData;
      if (!d || !pd) continue;
      const price = num(pd.lastSalePrice);
      if (!(price > 0)) continue;
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
      const path = `/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=1d&interval=1m&includePrePost=false`;
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
 * Work out how to price a symbol that may not be in the curated list.
 *
 * The curated universe is a starting point, not a whitelist: any listed US
 * equity or ETF and any Coinbase-listed coin should be tradable. `hint.kind`
 * comes from the client, which learned it from a search result.
 */
function resolveAsset(assetId, hint = {}) {
  const id = String(assetId || '').toUpperCase();
  const known = BY_ID[id];
  if (known) return known;
  const kind = hint.kind === 'crypto' ? 'crypto' : (hint.kind === 'etf' ? 'etf' : 'stock');
  return {
    id,
    symbol: id,
    name: hint.name || id,
    kind,
    // Yahoo quotes crypto as "SOL-USD"; equities use the bare ticker.
    yh: hint.yh || (kind === 'crypto' ? `${id}-USD` : id),
    // A coin sent with only a CoinGecko id has no Coinbase product; inventing
    // one would chart whatever Coinbase or Yahoo lists under that ticker.
    cb: hint.cb || (kind === 'crypto' && !hint.cg ? `${id}-USD` : null),
    discovered: true,
  };
}

/**
 * Crypto quote via Coinbase Exchange (24h stats + ticker). The browser normally
 * streams this over WebSocket; this REST path exists for the initial snapshot
 * and for browsers where the socket cannot connect.
 */
export function cryptoQuote(symbol, ttl = 4000) {
  return through(`c:${symbol}`, ttl, async () => {
    // Any Coinbase USD product, not just the curated ones.
    const meta = CB_BY_SYMBOL[symbol] || { cb: `${String(symbol).toUpperCase()}-USD` };
    await coinbaseLimiter.take();
    const ticker = await getJSON(`https://api.exchange.coinbase.com/products/${meta.cb}/ticker`, { timeout: 8000 });
    await coinbaseLimiter.take();
    const stats = await getJSON(`https://api.exchange.coinbase.com/products/${meta.cb}/stats`, { timeout: 8000 });
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
  return through('cb:stats', ttl, async () => {
    await coinbaseLimiter.take();
    return {
      stats: await getJSON('https://api.exchange.coinbase.com/products/stats', { timeout: 12000 }),
      source: 'coinbase', quality: 'live',
    };
  });
}

function quoteFromCoinbaseStats(symbol, row, envelope) {
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
    /*
     * Inherit the snapshot's own freshness. When `through()` serves a stale
     * snapshot because Coinbase is down, stamping these quotes 'live' would
     * paint an hour-old price with a pulsing green Live dot.
     */
    quality: (envelope && envelope.quality) || 'live',
    ageMs: envelope ? envelope.ageMs : 0,
    staleError: envelope ? envelope.error : undefined,
  };
}

export async function cryptoQuotes(symbols, ttl) {
  const out = {}; const errors = {};
  try {
    const snap = await cryptoSnapshotAll(ttl);
    const missing = [];
    for (const s of symbols) {
      const product = (CB_BY_SYMBOL[s] || {}).cb || `${String(s).toUpperCase()}-USD`;
      const row = snap.stats[product] && snap.stats[product].stats_24hour;
      const q = row ? quoteFromCoinbaseStats(s, row, snap) : null;
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
  // Its own prefix: the ids come from the query string, and a bare `cg:` key
  // let `ids=dir` or `ids=q:<coin>` overwrite the directory or a quote entry.
  const key = `cg:mkt:${ids.slice().sort().join(',')}`;
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

/*
 * Nasdaq stamps its chart points with New York wall-clock time written as if
 * it were UTC: "1:02 PM ET" arrives as 13:02Z. Read raw, every bar lands four
 * or five hours early and the next live tick opens a hole that size.
 */
const NY_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

/** New York's offset from UTC at an instant, in ms (-4h in summer, -5h in winter). */
function nyOffset(ms) {
  const p = {};
  for (const { type, value } of NY_CLOCK.formatToParts(new Date(ms))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - (ms % 1000));
}

/** The real instant of a New York wall-clock time encoded as UTC. */
function etWallToEpoch(wallMs) {
  // The offset at the wall time itself is a guess; the one at the guessed
  // instant is right on both sides of a daylight-saving change.
  return wallMs - nyOffset(wallMs - nyOffset(wallMs));
}

/**
 * Nasdaq's intraday endpoint returns one price sample per minute rather than
 * OHLC bars, so we aggregate samples into buckets. The open/high/low/close of
 * each bucket are derived from real prints; only volume is unavailable, and it
 * is reported as 0 rather than invented.
 *
 * At 1m the bucket is exactly as wide as the sample period, so every bucket
 * holds a single print and o=h=l=c — a chart of 900 flat dashes with no bodies
 * at all. For those buckets the open is chained to the previous bucket's close,
 * which is the correct reading of a continuous series sampled once per minute:
 * the body then shows the real move over that minute. High and low are the
 * extremes of the two known prices, so they understate the true range — the
 * response says `detail: 'close-only'` so the UI can label it rather than let
 * it pass as full OHLC.
 */
async function nasdaqIntradayCandles(symbol, tf) {
  const width = TF_MS[tf];
  if (!width) throw new Error(`nasdaq intraday does not cover ${tf}`);

  let json = null;
  for (const cls of assetClassesFor(symbol)) {
    try {
      await nasdaqLimiter.take();
      const j = await getJSON(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(nasdaqSymbol(symbol))}/chart?assetclass=${cls}`,
        { timeout: 12000 },
      );
      if (j?.data?.chart?.length) { json = j; break; }
    } catch { /* try the next asset class */ }
  }
  if (!json) throw new Error(`nasdaq has no intraday chart for ${symbol}`);

  const buckets = new Map();
  for (const point of json.data.chart) {
    const x = Number(point.x);
    const price = Number(point.y);
    if (!isFinite(x) || !isFinite(price)) continue;
    // Whole-hour shift, so bucket alignment is unchanged.
    const t = etWallToEpoch(x);
    const key = Math.floor(t / width) * width;
    const b = buckets.get(key);
    if (!b) buckets.set(key, { t: key, o: price, h: price, l: price, c: price, v: 0, n: 1 });
    else {
      if (price > b.h) b.h = price;
      if (price < b.l) b.l = price;
      b.c = price;
      b.n++;
    }
  }
  const bars = [...buckets.values()].sort((a, b) => a.t - b.t);
  if (!bars.length) throw new Error(`nasdaq intraday produced no bars for ${symbol}`);

  let singles = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.n === 1) {
      singles++;
      const prev = bars[i - 1];
      if (prev) {
        b.o = prev.c;
        b.h = Math.max(b.o, b.c);
        b.l = Math.min(b.o, b.c);
      }
    }
    delete b.n;
  }
  bars.closeOnly = singles > bars.length / 2;
  return bars;
}

/** Real daily OHLCV from Nasdaq's historical table. */
async function nasdaqDailyCandles(symbol, days = 400) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400e3);
  const iso = (d) => d.toISOString().slice(0, 10);

  let rows = null;
  for (const cls of assetClassesFor(symbol)) {
    try {
      await nasdaqLimiter.take();
      const j = await getJSON(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(nasdaqSymbol(symbol))}/historical`
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
    // Stamped at the 09:30 ET open, as Yahoo stamps its daily bars.
    bars.push({ t: etWallToEpoch(Date.UTC(y, m - 1, d, 9, 30)), o, h, l, c, v: NUM(r.volume) || 0 });
  }
  if (!bars.length) throw new Error(`nasdaq history unparseable for ${symbol}`);
  return bars.sort((a, b) => a.t - b.t);
}

async function nasdaqCandles(symbol, tf) {
  if (tf === '1D') return nasdaqDailyCandles(symbol, 400);
  if (tf === '1W') return toWeekly(await nasdaqDailyCandles(symbol, 1500));
  return nasdaqIntradayCandles(symbol, tf);
}

/*
 * Candles for long-tail coins. CoinGecko serves a price series, not OHLC, and
 * its granularity is fixed by the window you ask for: five-minute samples for
 * one day, hourly out to ninety, daily beyond that. So the finest honest bar
 * here is five minutes — anything shorter is refused by name rather than faked
 * by resampling a coarser series.
 */
const GECKO_TF = {
  '5m': { days: 1, width: 300e3 },
  '15m': { days: 1, width: 900e3 },
  '1h': { days: 90, width: 3600e3 },
  // The free tier refuses anything past 365 days, so a weekly chart is a year
  // of dailies rolled up rather than the three years the other sources give.
  '1D': { days: 365, width: 86400e3 },
  '1W': { days: 365, width: 86400e3 },
};

async function geckoCandles(cgId, tf) {
  const spec = GECKO_TF[tf];
  if (!spec) {
    throw new Error(
      `CoinGecko samples this coin every 5 minutes, so ${tf} candles do not exist for it. `
      + 'Try 5m or longer.',
    );
  }

  await geckoLimiter.take();
  const j = await getJSON(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cgId)}/market_chart`
    + `?vs_currency=usd&days=${spec.days}`,
    { timeout: 15000 },
  );
  const points = Array.isArray(j?.prices) ? j.prices : [];
  if (!points.length) throw new Error(`CoinGecko has no price history for ${cgId}`);

  const buckets = new Map();
  for (const [t, price] of points) {
    if (!isFinite(t) || !isFinite(price)) continue;
    const key = Math.floor(t / spec.width) * spec.width;
    const b = buckets.get(key);
    if (!b) buckets.set(key, { t: key, o: price, h: price, l: price, c: price, v: 0, n: 1 });
    else {
      if (price > b.h) b.h = price;
      if (price < b.l) b.l = price;
      b.c = price;
      b.n++;
    }
  }

  let bars = [...buckets.values()].sort((a, b) => a.t - b.t);
  // Same reasoning as the Nasdaq intraday path: a one-sample bucket has no body
  // of its own, so it opens where the previous bar closed.
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.n === 1 && bars[i - 1]) {
      b.o = bars[i - 1].c;
      b.h = Math.max(b.o, b.c);
      b.l = Math.min(b.o, b.c);
    }
    delete b.n;
  }
  if (tf === '1W') bars = toWeekly(bars);
  if (!bars.length) throw new Error(`CoinGecko history for ${cgId} produced no bars`);
  return bars;
}

const CANDLE_TTL = { '1m': 20000, '5m': 60000, '15m': 120000, '1h': 300000, '1D': 900000, '1W': 1800000 };

export function fetchCandles(assetId, tf, hint) {
  const asset = resolveAsset(assetId, hint);
  const spec = YH_TF[tf];
  if (!spec) return Promise.reject(new Error(`unsupported timeframe ${tf}`));

  /*
   * Every curated coin carries a CoinGecko id already — it is what the market
   * cap panel looks up — so the id alone must not decide the candle source, or
   * BTC would quietly drop from real Coinbase OHLCV to a close-only snapshot.
   * The gecko path is for coins with no Coinbase product at all.
   */
  const cgId = asset.cb ? null : (hint && hint.cg) || null;

  return through(`k:${asset.id}:${tf}:${cgId || ''}`, CANDLE_TTL[tf] ?? 60000, async () => {
    if (cgId) {
      return {
        bars: await geckoCandles(cgId, tf),
        source: 'coingecko', quality: 'delayed', tf, assetId,
        closeOnly: true, volume: false,
      };
    }

    if (asset.kind === 'crypto') {
      try {
        const gran = CB_TF[tf];
        await coinbaseLimiter.take();
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
      const path = `/v8/finance/chart/${encodeURIComponent(yahooSymbol(asset.yh))}?range=${spec.range}&interval=${spec.interval}`;
      return { bars: candlesFromYahoo(await yahooGet(path)), source: 'yahoo', quality: 'live', tf, assetId };
    } catch (yErr) {
      const bars = await nasdaqCandles(asset.symbol, tf);
      return {
        bars, source: 'nasdaq', quality: 'delayed', tf, assetId,
        // Nasdaq's free intraday feed carries prices but no per-bar volume.
        volume: tf === '1D' || tf === '1W',
        // One sample per minute: the bodies are real, the wicks are not.
        closeOnly: bars.closeOnly === true,
        note: `yahoo: ${yErr.message}`,
      };
    }
  });
}

/* ------------------------------------------- the long tail of crypto ----- */

/*
 * Coinbase lists a few hundred coins and streams every trade on them. Beyond
 * that there are thousands more with no free key-less real-time feed at all —
 * CoinGecko is the honest source for those: a snapshot per request, minutes old
 * rather than live, and rate limited hard enough that it cannot back a ticking
 * watchlist. So they are a second tier: discoverable, priceable, tradable, and
 * labelled `delayed` everywhere they appear so they are never mistaken for the
 * live ones.
 *
 * Eight pages by descending market cap is about the top 2,000 coins, which
 * covers anything with a real market while leaving out the tail of dead and
 * duplicate tickers that makes a symbol search useless.
 */
const GECKO_PAGES = 8;

export function geckoDirectory() {
  return through('cg:dir', 1800000, async () => {
    const coins = [];
    let pages = 0;
    for (let page = 1; page <= GECKO_PAGES; page++) {
      try {
        await geckoLimiter.take();
        const rows = await getJSON(
          'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc'
          + `&per_page=250&page=${page}&sparkline=false&price_change_percentage=24h`,
          { timeout: 15000 },
        );
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) {
          if (!r.id || !r.symbol) continue;
          coins.push({
            cg: r.id,
            symbol: String(r.symbol).toUpperCase(),
            name: r.name || r.id,
            price: r.current_price,
            changePct: r.price_change_percentage_24h,
            marketCap: r.market_cap,
            volume: r.total_volume,
            rank: r.market_cap_rank,
          });
        }
        pages++;
      } catch (e) {
        // A partial directory is far more useful than none: the first pages
        // hold the coins anyone is actually looking for.
        if (!coins.length) throw e;
        break;
      }
    }
    return { coins, pages, source: 'coingecko', quality: 'delayed' };
  });
}

/**
 * Delayed snapshot quotes for coins that only CoinGecko carries. One request
 * covers many ids, which matters: the free tier is a handful of calls a minute.
 */
export function geckoQuotes(ids) {
  const list = [...new Set(ids.filter(Boolean))].sort();
  if (!list.length) return Promise.resolve({ quotes: {}, source: 'coingecko', quality: 'delayed' });

  return through(`cg:q:${list.join(',')}`, 45000, async () => {
    await geckoLimiter.take();
    const j = await getJSON(
      'https://api.coingecko.com/api/v3/simple/price?ids=' + encodeURIComponent(list.join(','))
      + '&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true',
      { timeout: 15000 },
    );
    const quotes = {};
    for (const id of list) {
      const r = j[id];
      if (!r || !(Number.isFinite(r.usd) && r.usd > 0)) continue;
      quotes[id] = {
        price: r.usd,
        changePct: isFinite(r.usd_24h_change) ? r.usd_24h_change : null,
        marketCap: r.usd_market_cap ?? null,
        volume: r.usd_24h_vol ?? null,
        source: 'coingecko',
        quality: 'delayed',
      };
    }
    return { quotes, source: 'coingecko', quality: 'delayed' };
  }).then((g) => {
    /*
     * Same reasoning as quoteFromCoinbaseStats: when CoinGecko refuses the
     * refresh, `through()` marks the old envelope cached, but the quotes inside
     * it would still say 'delayed' — indefinitely, since nothing evicts them.
     */
    if (g.quality !== 'cached') return g;
    const quotes = {};
    for (const id in g.quotes) quotes[id] = { ...g.quotes[id], quality: 'cached', ageMs: g.ageMs, staleError: g.error };
    return { ...g, quotes };
  });
}

/** Every Coinbase USD product we could stream, for search and discovery. */
export function cryptoProducts() {
  return through('cb:products', 3600000, async () => {
    await coinbaseLimiter.take();
    const rows = await getJSON('https://api.exchange.coinbase.com/products', { timeout: 15000 });
    const products = rows
      .filter((r) => r.quote_currency === 'USD' && r.status === 'online' && !r.trading_disabled)
      .map((r) => ({ symbol: r.base_currency, name: r.base_name || r.base_currency, cb: r.id, kind: 'crypto' }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    return { products, source: 'coinbase', quality: 'live' };
  });
}

/* ------------------------------------------------------ stock directory */

const parseMoney = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,%\s]/g, ''));
  return isFinite(n) ? n : null;
};

/**
 * Every US-listed stock, with live price, day change, volume, market cap and
 * sector — around 7,000 names in a single request.
 *
 * This is what makes the universe the whole market rather than a curated list.
 * It backs symbol search (so lookups keep working when Yahoo is rate limited)
 * and every idea list.
 */
export function stockDirectory() {
  return through('nq:directory', 300000, async () => {
    await nasdaqLimiter.take();
    const j = await getJSON(
      'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true',
      { timeout: 45000 },
    );
    const raw = (j && j.data && j.data.rows) || [];
    const rows = [];
    for (const r of raw) {
      const symbol = yahooSymbol(String(r.symbol || '').trim().toUpperCase());
      const price = parseMoney(r.lastsale);
      if (!symbol || price == null || price <= 0) continue;
      rows.push({
        symbol,
        name: String(r.name || symbol).replace(/\s+Common Stock.*$/i, '').replace(/\s+$/, ''),
        price,
        changePct: parseMoney(r.pctchange),
        change: parseMoney(r.netchange),
        volume: parseMoney(r.volume) || 0,
        marketCap: parseMoney(r.marketCap) || 0,
        sector: r.sector || null,
        industry: r.industry || null,
        country: r.country || null,
      });
    }
    if (!rows.length) throw new Error('empty stock directory');
    return { rows, source: 'nasdaq', quality: 'live' };
  });
}

/* --------------------------------------------------------------- search */

/**
 * Symbol lookup across the whole tradable universe.
 *
 * Order matters: curated names first (richest metadata), then every listed US
 * stock from the directory, then every Coinbase coin, and finally Yahoo as a
 * bonus. Yahoo is no longer required — it rate limits aggressively, and search
 * that stops working is worse than search with one fewer source.
 */
export function searchSymbols(query) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve({ results: [], source: 'local' });

  return through(`s:${q.toLowerCase()}`, 120000, async () => {
    const needle = q.toLowerCase();
    const upper = q.toUpperCase();
    const out = [];
    const seen = new Set();
    const push = (r) => {
      if (!r.symbol || seen.has(r.symbol)) return false;
      seen.add(r.symbol);
      out.push(r);
      return true;
    };

    for (const a of Object.values(BY_ID)) {
      if (a.id.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle)) {
        push({
          symbol: a.id, name: a.name, kind: a.kind,
          exchange: a.kind === 'crypto' ? 'Coinbase' : 'US', tradable: true,
        });
      }
    }

    try {
      const dir = await stockDirectory();
      const exact = [], prefix = [], byName = [];
      for (const r of dir.rows) {
        if (r.symbol === upper) exact.push(r);
        else if (r.symbol.startsWith(upper)) prefix.push(r);
        else if (r.name.toLowerCase().includes(needle)) byName.push(r);
      }
      const busiest = (a, b) => (b.volume || 0) - (a.volume || 0);
      prefix.sort(busiest);
      byName.sort(busiest);
      for (const r of [...exact, ...prefix, ...byName]) {
        push({
          symbol: r.symbol,
          name: r.name,
          kind: 'stock',
          exchange: r.country && r.country !== 'United States' ? r.country : 'US',
          price: r.price,
          changePct: r.changePct,
          tradable: true,
        });
        if (out.length >= 24) break;
      }
    } catch { /* directory unavailable; the other sources still apply */ }

    if (out.length < 24) {
      try {
        const cp = await cryptoProducts();
        for (const c of cp.products) {
          if (c.symbol.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle)) {
            push({ symbol: c.symbol, name: c.name, kind: 'crypto', exchange: 'Coinbase', tradable: true });
          }
          if (out.length >= 24) break;
        }
      } catch { /* ignore */ }
    }

    /*
     * The long tail goes after Coinbase, never before it: if a coin can be
     * streamed live, that is the one the user wants. A gecko-only match carries
     * its `cg` id and a delayed flag so nothing downstream has to guess.
     */
    if (out.length < 24) {
      try {
        const dir = await geckoDirectory();
        const exact = [], prefix = [], byName = [];
        for (const c of dir.coins) {
          if (c.symbol === upper) exact.push(c);
          else if (c.symbol.startsWith(upper)) prefix.push(c);
          else if (c.name.toLowerCase().includes(needle)) byName.push(c);
        }
        const ranked = (a, b) => (a.rank || 1e9) - (b.rank || 1e9);
        exact.sort(ranked); prefix.sort(ranked); byName.sort(ranked);
        for (const c of [...exact, ...prefix, ...byName]) {
          push({
            symbol: c.symbol,
            name: c.name,
            kind: 'crypto',
            exchange: 'CoinGecko',
            price: c.price,
            changePct: c.changePct,
            marketCap: c.marketCap,
            tradable: true,
            cg: c.cg,
            delayed: true,
          });
          if (out.length >= 24) break;
        }
      } catch { /* the long tail is a bonus, not a dependency */ }
    }

    if (out.length < 6) {
      try {
        const j = await yahooGet(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`);
        for (const r of (j.quotes || [])) {
          if (!r.symbol || !['EQUITY', 'ETF', 'CRYPTOCURRENCY'].includes(r.quoteType)) continue;
          const isCrypto = r.quoteType === 'CRYPTOCURRENCY';
          const base = isCrypto ? String(r.symbol).replace(/-USD$/, '') : r.symbol;
          push({
            symbol: BY_ID[base] ? base : r.symbol,
            name: r.longname || r.shortname || r.symbol,
            kind: isCrypto ? 'crypto' : (r.quoteType === 'ETF' ? 'etf' : 'stock'),
            exchange: r.exchDisp || r.exchange || '',
            tradable: true,
            yh: r.symbol,
          });
        }
      } catch { /* Yahoo is a bonus here, not a dependency */ }
    }

    return { results: out.slice(0, 24), source: 'directory' };
  });
}

/* ---------------------------------------------------------------- ideas */

/**
 * Ready-made lists of things to look at, computed from live market data.
 *
 * Each list states the filter it applied, because "top gainer" means nothing
 * without knowing whether penny-stock noise was screened out.
 */
export function tradeIdeas() {
  return through('ideas', 120000, async () => {
    const lists = [];

    try {
      const dir = await stockDirectory();
      const rows = dir.rows;
      const liquid = rows.filter((r) => r.volume >= 200000 && r.price >= 1 && r.changePct != null);
      const take = (arr, n = 12) => arr.slice(0, n).map((r) => ({
        symbol: r.symbol, name: r.name, kind: 'stock', price: r.price,
        changePct: r.changePct, volume: r.volume, marketCap: r.marketCap, sector: r.sector,
      }));

      lists.push({
        id: 'gainers',
        title: 'Top gainers today',
        note: 'Biggest percentage risers, limited to names trading over $1 with real volume.',
        items: take([...liquid].sort((a, b) => b.changePct - a.changePct)),
      });
      lists.push({
        id: 'losers',
        title: 'Biggest fallers today',
        note: 'The other side of the same screen — sharp falls on liquid names.',
        items: take([...liquid].sort((a, b) => a.changePct - b.changePct)),
      });
      lists.push({
        id: 'active',
        title: 'Most actively traded',
        note: 'Highest share volume today. Heavy volume means tighter spreads and easier fills.',
        items: take([...rows].sort((a, b) => b.volume - a.volume)),
      });
      lists.push({
        id: 'penny',
        title: 'Penny stocks on the move',
        note: 'Under $5 with at least 500k shares traded. These swing hard and can gap — size small.',
        items: take([...rows]
          .filter((r) => r.price < 5 && r.volume >= 500000 && r.changePct != null)
          .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))),
      });
      lists.push({
        id: 'steady',
        title: 'Large and steady',
        note: 'The biggest companies listed, moving less than 2% today. The calm end of the market.',
        items: take([...rows]
          .filter((r) => r.marketCap > 5e10 && r.changePct != null && Math.abs(r.changePct) < 2)
          .sort((a, b) => b.marketCap - a.marketCap)),
      });
      lists.push({
        id: 'megacap',
        title: 'Biggest companies',
        note: 'Ranked purely by market capitalisation.',
        items: take([...rows].sort((a, b) => b.marketCap - a.marketCap)),
      });
      lists.push({
        id: 'smallcap',
        title: 'Small caps making moves',
        note: 'Market cap between $300M and $2B with a move of 5% or more.',
        items: take([...liquid]
          .filter((r) => r.marketCap >= 3e8 && r.marketCap <= 2e9 && Math.abs(r.changePct) >= 5)
          .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))),
      });
    } catch (e) {
      lists.push({ id: 'stocks-error', title: 'Stock ideas unavailable', note: e.message, items: [] });
    }

    try {
      const snap = await cryptoSnapshotAll(60000);
      const coins = [];
      for (const product in snap.stats) {
        if (!product.endsWith('-USD')) continue;
        const st = snap.stats[product].stats_24hour;
        if (!st) continue;
        const price = parseFloat(st.last), open = parseFloat(st.open);
        const volume = parseFloat(st.volume);
        if (!isFinite(price) || !isFinite(open) || open <= 0) continue;
        const symbol = product.replace(/-USD$/, '');
        coins.push({
          symbol,
          name: (BY_ID[symbol] || {}).name || symbol,
          kind: 'crypto',
          price,
          changePct: ((price - open) / open) * 100,
          volume: isFinite(volume) ? volume * price : 0,
        });
      }
      const active = coins.filter((c) => c.volume > 250000);
      lists.push({
        id: 'crypto-gainers',
        title: 'Crypto gainers (24h)',
        note: 'Coinbase-listed coins with at least $250k of 24h turnover.',
        items: [...active].sort((a, b) => b.changePct - a.changePct).slice(0, 12),
      });
      lists.push({
        id: 'crypto-losers',
        title: 'Crypto fallers (24h)',
        note: 'Same screen, the other direction.',
        items: [...active].sort((a, b) => a.changePct - b.changePct).slice(0, 12),
      });
    } catch (e) {
      lists.push({ id: 'crypto-error', title: 'Crypto ideas unavailable', note: e.message, items: [] });
    }

    return { lists, source: 'nasdaq + coinbase', quality: 'live', at: Date.now() };
  });
}

/* --------------------------------------------------------------- health */

export function providerHealth() {
  return {
    yahoo: Object.fromEntries(YAHOO_HOSTS.map((h) => [h.split('.')[0], yahooLimiters[h].state])),
    nasdaq: nasdaqLimiter.state,
    coingecko: geckoLimiter.state,
    coinbase: coinbaseLimiter.state,
    cacheEntries: cache.size,
    inflight: inflight.size,
  };
}
