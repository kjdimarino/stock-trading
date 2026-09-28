/**
 * Server and provider regressions, run fully offline.
 *
 * `https.request` is replaced by a scripted upstream so every provider path —
 * fallbacks, throttling, cache namespaces, the LLM proxy — can be driven into
 * the failure it has to survive, deterministically and without the network.
 */
import https from 'node:https';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, eq, ok, report } from './harness.mjs';

// The scripted upstream stands in for the network, so no proxy may sit between.
for (const k of ['HTTPS_PROXY', 'https_proxy']) delete process.env[k];

/* ------------------------------------------------------- scripted upstream */

const calls = [];
let upstream = () => ({ status: 404, body: { error: 'unscripted' } });

https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.destroy = (err) => { if (err) req.emit('error', err); };
  req.end = (data) => {
    const call = {
      method: opts.method, host: opts.host, path: opts.path,
      headers: opts.headers, body: data == null ? null : String(data),
    };
    calls.push(call);
    const r = upstream(call) || { status: 404, body: {} };
    setTimeout(() => {
      const res = new PassThrough();
      res.statusCode = r.status;
      res.headers = {};
      cb(res);
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    }, r.delay ?? 2);
  };
  return req;
};

/* Tests share module state and the clock, so they run one after another. */
let chain = Promise.resolve();
const serial = (fn) => () => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

/* Date.now only ever moves forward here: rewinding would leave the rate
   limiters' reservations in the future and stall every later request. */
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

/* A fresh copy of providers.mjs: its own cache and its own rate limiters. */
let fresh = 0;
const freshProviders = () => import(`../src/providers.mjs?regress=${++fresh}`);

const yahooChart = (price = 100) => ({
  chart: { result: [{
    meta: { regularMarketPrice: price, chartPreviousClose: price - 1, marketState: 'REGULAR', regularMarketTime: Math.floor(Date.now() / 1000) },
    timestamp: [Math.floor(Date.now() / 1000) - 86400, Math.floor(Date.now() / 1000)],
    indicators: { quote: [{ open: [1, 2], high: [2, 3], low: [0.5, 1], close: [1.5, 2.5], volume: [10, 20] }] },
  }] },
});
const nasdaqInfo = (price) => ({
  data: { exchange: 'NYSE', primaryData: { lastSalePrice: `$${price}`, netChange: '+1.00', percentageChange: '+0.20%', isRealTime: false } },
});

/* ----------------------------------------------- nasdaq intraday stamps (1) */

describe('nasdaq fallback candles are stamped at the real instant', () => {
  const script = (call) => {
    if (call.host.endsWith('finance.yahoo.com')) return { status: 404, body: {} };
    const m = /^\/api\/quote\/([^/]+)\/(chart|historical)\?assetclass=stocks/.exec(call.path);
    if (call.host !== 'api.nasdaq.com' || !m) return null;
    // Nasdaq writes New York wall-clock time as if it were UTC: "1:02 PM ET" → 13:02Z.
    const wall = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi);
    if (m[2] === 'chart' && m[1] === 'NQSUMMER') {
      return { status: 200, body: { data: { chart: [
        { x: wall(2026, 8, 28, 13, 0), y: 100, z: { dateTime: '1:00 PM ET' } },
        { x: wall(2026, 8, 28, 13, 1), y: 101, z: { dateTime: '1:01 PM ET' } },
        { x: wall(2026, 8, 28, 13, 2), y: 102, z: { dateTime: '1:02 PM ET' } },
      ] } } };
    }
    if (m[2] === 'chart' && m[1] === 'NQWINTER') {
      return { status: 200, body: { data: { chart: [
        { x: wall(2026, 0, 15, 13, 2), y: 50, z: { dateTime: '1:02 PM ET' } },
        { x: wall(2026, 0, 15, 13, 3), y: 51, z: { dateTime: '1:03 PM ET' } },
      ] } } };
    }
    if (m[2] === 'historical' && m[1] === 'NQDAILY') {
      return { status: 200, body: { data: { tradesTable: { rows: [
        { date: '09/25/2026', open: '$10.00', high: '$11.00', low: '$9.00', close: '$10.50', volume: '1,000' },
        { date: '01/15/2026', open: '$8.00', high: '$8.50', low: '$7.50', close: '$8.25', volume: '2,000' },
      ] } } } };
    }
    return null;
  };

  it('an EDT print lands four hours after its wall-clock stamp', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const r = await P.fetchCandles('NQSUMMER', '5m', { kind: 'stock' });
    eq(r.source, 'nasdaq');
    // 1:00–1:02 PM EDT is 17:00–17:02Z: one 5m bucket at 17:00Z.
    eq(r.bars.map((b) => new Date(b.t).toISOString()), ['2026-09-28T17:00:00.000Z']);
    eq(r.bars[0].c, 102);
  }));

  it('an EST print lands five hours after its wall-clock stamp', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const r = await P.fetchCandles('NQWINTER', '1m', { kind: 'stock' });
    eq(r.bars.map((b) => new Date(b.t).toISOString()),
      ['2026-01-15T18:02:00.000Z', '2026-01-15T18:03:00.000Z']);
  }));

  it('daily bars sit at the 09:30 ET open, like Yahoo\'s', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const r = await P.fetchCandles('NQDAILY', '1D', { kind: 'stock' });
    eq(r.source, 'nasdaq');
    eq(r.bars.map((b) => new Date(b.t).toISOString()),
      ['2026-01-15T14:30:00.000Z', '2026-09-25T13:30:00.000Z']);
  }));
});

/* --------------------------------------------- long-tail coin candles (2) */

describe('coins only CoinGecko carries chart from CoinGecko', () => {
  const script = (call) => {
    if (call.host === 'api.coingecko.com' && call.path.startsWith('/api/v3/coins/hyperliquid/market_chart')) {
      const now = Date.now();
      const prices = [];
      for (let i = 0; i < 60; i++) prices.push([now - (60 - i) * 300e3, 40 + i * 0.01]);
      return { status: 200, body: { prices } };
    }
    if (call.host === 'api.exchange.coinbase.com' && call.path.startsWith('/products/BTC-USD/candles')) {
      const t = Math.floor(Date.now() / 1000);
      return { status: 200, body: [[t, 1, 3, 2, 2.5, 10], [t - 3600, 1, 3, 1.5, 2, 10]] };
    }
    if (call.host === 'api.exchange.coinbase.com') return { status: 404, body: { message: 'NotFound' } };
    // Yahoo happens to list a ticker by that name — possibly a different coin.
    if (call.host.endsWith('finance.yahoo.com')) return { status: 200, body: yahooChart(1) };
    return null;
  };
  const hype = { kind: 'crypto', yh: 'HYPE-USD', cg: 'hyperliquid' };

  it('the client\'s delayed-coin hint reaches CoinGecko, labelled close-only and delayed', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const before = calls.length;
    const r = await P.fetchCandles('HYPE', '5m', hype);
    const hosts = calls.slice(before).map((c) => c.host);
    eq(r.source, 'coingecko');
    eq(r.quality, 'delayed');
    eq(r.closeOnly, true);
    eq(hosts, ['api.coingecko.com'], 'upstreams asked');
    ok(r.bars.length > 10, `${r.bars.length} bars`);
  }));

  it('1m is refused for them rather than served from another coin', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const before = calls.length;
    let err = null;
    try { await P.fetchCandles('HYPE', '1m', hype); } catch (e) { err = e; }
    ok(err && /CoinGecko/.test(err.message), `expected a CoinGecko refusal, got ${err ? err.message : 'bars'}`);
    eq(calls.length - before, 0, 'no upstream call for a timeframe that does not exist');
  }));

  it('a curated coin keeps Coinbase OHLCV despite its CoinGecko id', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const r = await P.fetchCandles('BTC', '1h', { kind: 'crypto', yh: 'BTC-USD', cg: 'bitcoin' });
    eq(r.source, 'coinbase');
    ok(!r.closeOnly);
  }));
});

/* ------------------------------------------------------ class shares (4) */

describe('class shares are priced under every spelling', () => {
  const script = (call) => {
    if (call.host.endsWith('finance.yahoo.com')) {
      // Yahoo spells class shares BRK-B; the slash form is a 404.
      if (call.path.startsWith('/v8/finance/chart/HEI-A?')) return { status: 200, body: yahooChart(200) };
      return { status: 404, body: { chart: { error: { code: 'Not Found' } } } };
    }
    if (call.host === 'api.nasdaq.com') {
      if (call.path.startsWith('/api/screener/stocks')) {
        return { status: 200, body: { data: { rows: [
          { symbol: 'BRK/B', name: 'Berkshire Hathaway Inc. Class B', lastsale: '$500.00', pctchange: '0.1%', netchange: '0.5', volume: '3000000', marketCap: '1100000000000' },
          { symbol: 'BF/B', name: 'Brown Forman Inc Class B Common Stock', lastsale: '$30.00', pctchange: '1%', netchange: '0.3', volume: '1500000', marketCap: '14000000000' },
          { symbol: 'BAC^B', name: 'Bank of America Preferred', lastsale: '$25.00', pctchange: '0%', netchange: '0', volume: '1000', marketCap: '0' },
          { symbol: 'AAPL', name: 'Apple Inc. Common Stock', lastsale: '$230.00', pctchange: '1%', netchange: '2', volume: '50000000', marketCap: '3500000000000' },
        ] } } };
      }
      // Nasdaq's quote API spells them BRK.B; BRK/B is a 404 and BRK-B does not exist.
      const m = /^\/api\/quote\/([^/]+)\/(info|historical)\?/.exec(call.path);
      if (m && decodeURIComponent(m[1]).includes('.')) {
        if (m[2] === 'info') return { status: 200, body: nasdaqInfo(m[1] === 'BRK.A' ? 750000 : 500) };
        return { status: 200, body: { data: { tradesTable: { rows: [
          { date: '09/25/2026', open: '$30.00', high: '$31.00', low: '$29.00', close: '$30.50', volume: '1,000' },
        ] } } } };
      }
      if (m && m[1].includes('%2F')) return { status: 404, body: {} };
      return { status: 200, body: { data: null, status: { rCode: 400, bCodeMessage: [{ errorMessage: 'Symbol not exists.' }] } } };
    }
    if (call.host === 'api.exchange.coinbase.com') return { status: 200, body: [] };
    if (call.host === 'api.coingecko.com') return { status: 200, body: [] };
    return null;
  };

  it('the directory lists them under the Yahoo spelling the curated list uses', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const d = await P.stockDirectory();
    eq(d.rows.map((r) => r.symbol), ['BRK-B', 'BF-B', 'BAC^B', 'AAPL']);
    const s = await P.searchSymbols('berkshire');
    eq(s.results.map((r) => r.symbol), ['BRK-B'], 'Berkshire listed once');
  }));

  it('the Nasdaq fallback prices them, keyed by the id asked for', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const r = await P.stockQuotes(['BRK-B', 'BRK/A']);
    eq(Object.keys(r.errors), [], JSON.stringify(r.errors));
    eq(r.quotes['BRK-B'] && r.quotes['BRK-B'].source, 'nasdaq');
    eq(r.quotes['BRK-B'].symbol, 'BRK-B');
    eq(r.quotes['BRK/A'] && r.quotes['BRK/A'].price, 750000);
    const k = await P.fetchCandles('BF/B', '1D', { kind: 'stock', yh: 'BF/B' });
    eq(k.source, 'nasdaq');
    eq(k.bars.length, 1);
  }));

  it('an id saved in the slash form still reaches Yahoo', serial(async () => {
    upstream = script;
    const P = await freshProviders();
    const q = await P.stockQuote('HEI/A');
    eq(q.source, 'yahoo');
    eq(q.price, 200);
    const k = await P.fetchCandles('HEI/A', '1D', { kind: 'stock', yh: 'HEI/A' });
    eq(k.source, 'yahoo');
  }));
});

/* ------------------------------------------------- yahoo backoff burst (5) */

describe('one throttled burst is one strike', () => {
  it('ten concurrent 429s back off 20s, not five minutes', serial(async () => {
    upstream = (call) => {
      if (call.host.endsWith('finance.yahoo.com')) return { status: 429, body: 'Too Many Requests', delay: 40 };
      if (call.host === 'api.nasdaq.com') return { status: 500, body: {} };
      return null;
    };
    const P = await freshProviders();
    const syms = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'V', 'WMT'];
    const r = await P.stockQuotes(syms);
    eq(Object.keys(r.quotes).length, 0);
    const h = P.providerHealth().yahoo;
    for (const host of ['query1', 'query2']) {
      ok(h[host].strikes <= 1, `${host} took ${h[host].strikes} strikes from one burst`);
      const left = h[host].cooldownUntil - Date.now();
      ok(left <= 20000, `${host} cooling for ${Math.round(left / 1000)}s after one burst`);
    }
  }));
});

/* ---------------------------------------------------------- the server */

const { createServer } = await import('../src/server.mjs');
const shared = await import('../src/providers.mjs'); // the instance server.mjs uses
const server = createServer(() => '<html></html>');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

function request(method, path, { headers = {}, body, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/* --------------------------------------------- cache key namespaces (7) */

describe('user input cannot overwrite another provider\'s cache entry', () => {
  const script = (call) => {
    if (call.host !== 'api.coingecko.com') return null;
    if (call.path.startsWith('/api/v3/simple/price')) {
      const ids = decodeURIComponent(/ids=([^&]*)/.exec(call.path)[1]).split(',');
      return { status: 200, body: Object.fromEntries(ids.map((id) => [id, { usd: 3.5, usd_24h_change: 1 }])) };
    }
    if (call.path.startsWith('/api/v3/coins/markets')) {
      if (/[?&]ids=/.test(call.path)) return { status: 200, body: [] }; // unknown ids: 200 []
      if (/[?&]page=1&/.test(call.path)) {
        return { status: 200, body: [{ id: 'poison-coin', symbol: 'poi', name: 'Poison Coin', current_price: 3.5, market_cap_rank: 900 }] };
      }
      return { status: 200, body: [] };
    }
    return null;
  };

  it('/api/markets?ids=q:<coin> leaves that coin\'s quotes working', serial(async () => {
    upstream = script;
    const m = await request('GET', '/api/markets?ids=q:poison-coin');
    ok(m.status === 200 || m.status === 400, `markets answered ${m.status}`);
    const r = await request('GET', '/api/quotes?gecko=POI:poison-coin');
    eq(r.status, 200, r.text);
    eq(r.json.quotes.POI && r.json.quotes.POI.price, 3.5);
  }));

  it('/api/markets?ids=dir leaves the coin directory intact', serial(async () => {
    upstream = script;
    await request('GET', '/api/markets?ids=dir');
    const dir = await shared.geckoDirectory();
    ok(Array.isArray(dir.coins), `directory became ${JSON.stringify(Object.keys(dir))}`);
    eq(dir.coins.map((c) => c.cg), ['poison-coin']);
  }));
});

/* ----------------------------------------- stale CoinGecko quotes (6) */

describe('a CoinGecko quote served from cache says so', () => {
  it('is labelled cached, with its age, once the refresh fails', serial(async () => {
    let refuse = false;
    upstream = (call) => {
      if (call.host !== 'api.coingecko.com' || !call.path.startsWith('/api/v3/simple/price')) return null;
      if (refuse) return { status: 429, body: { error: 'throttled' } };
      return { status: 200, body: { 'stale-coin': { usd: 40.1, usd_24h_change: 2 } } };
    };
    const first = await request('GET', '/api/quotes?gecko=STALE:stale-coin');
    eq(first.json.quotes.STALE.quality, 'delayed');

    refuse = true;
    skew += 3 * 3600e3;
    const r = await request('GET', '/api/quotes?gecko=STALE:stale-coin');
    eq(r.status, 200);
    const q = r.json.quotes.STALE;
    eq(q.price, 40.1);
    eq(q.quality, 'cached');
    ok(q.ageMs >= 3 * 3600e3, `ageMs ${q.ageMs}`);
    ok(/429/.test(q.staleError || ''), `staleError ${q.staleError}`);
  }));
});

/* ------------------------------------------------ the LLM proxy (3) */

describe('/api/llm only answers the app itself', () => {
  const payload = JSON.stringify({
    model: 'claude-opus-4-1', max_tokens: 5000, system: 'attacker',
    messages: [{ role: 'user', content: 'hi' }],
  });
  const anthropic = () => calls.filter((c) => c.host === 'api.anthropic.com').length;
  const self = `127.0.0.1:${PORT}`;
  const post = (headers) => request('POST', '/api/llm', { headers, body: payload });

  const cases = [
    ['a cross-site text/plain POST', { Host: self, Origin: 'https://evil.example', 'Content-Type': 'text/plain;charset=UTF-8' }],
    ['a form POST with no Origin', { Host: self, 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['another localhost port', { Host: self, Origin: 'http://localhost:8744', 'Content-Type': 'application/json' }],
    ['a DNS-rebinding page', { Host: `evil.example:${PORT}`, Origin: `http://evil.example:${PORT}`, 'Content-Type': 'application/json' }],
    ['a machine name nobody listed', { Host: `mybox.local:${PORT}`, Origin: `http://mybox.local:${PORT}`, 'Content-Type': 'application/json' }],
    ['an opaque origin', { Host: self, Origin: 'null', 'Content-Type': 'application/json' }],
  ];
  for (const [label, headers] of cases) {
    it(`refuses ${label}`, serial(async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-TEST';
      upstream = (call) => (call.host === 'api.anthropic.com' ? { status: 200, body: { content: [] } } : null);
      const before = anthropic();
      const r = await post(headers);
      eq(r.status, 403, r.text);
      eq(anthropic() - before, 0, 'upstream calls billed to the key');
    }));
  }

  const allowed = [
    ['the app\'s own fetch', { Host: self, Origin: `http://${self}`, 'Content-Type': 'application/json' }],
    ['the app opened as localhost', { Host: `localhost:${PORT}`, Origin: `http://localhost:${PORT}`, 'Content-Type': 'application/json' }],
    ['a local script with no Origin', { Host: self, 'Content-Type': 'application/json; charset=utf-8' }],
  ];
  for (const [label, headers] of allowed) {
    it(`serves ${label}`, serial(async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-TEST';
      upstream = (call) => (call.host === 'api.anthropic.com' ? { status: 200, body: { content: [] } } : null);
      const before = anthropic();
      const r = await post(headers);
      eq(r.status, 200, r.text);
      eq(anthropic() - before, 1);
    }));
  }

  /*
   * Bound to 0.0.0.0 and opened by machine name, a reverse proxy or a tunnel,
   * the app is same-origin under a name HOST cannot hold (HOST is also the
   * listen address). PT_ALLOWED_HOSTS admits exactly the names listed.
   */
  it('serves a machine name listed in PT_ALLOWED_HOSTS, and no other', serial(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-TEST';
    upstream = (call) => (call.host === 'api.anthropic.com' ? { status: 200, body: { content: [] } } : null);
    // Entries copied from an address bar, with a port or a scheme, count too.
    process.env.PT_ALLOWED_HOSTS = 'MyBox.local, tunnel.example.com, other.local:7777 , http://proxied.example';
    let named;
    try {
      const S = await import('../src/server.mjs?allowed-hosts'); // reads the list at load
      named = S.createServer(() => '<html></html>');
      await new Promise((r) => named.listen(0, '127.0.0.1', r));
    } finally {
      delete process.env.PT_ALLOWED_HOSTS;
    }
    const port = named.address().port;
    const as = (name, origin = `http://${name}:${port}`) => request('POST', '/api/llm', {
      port, body: payload, headers: { Host: `${name}:${port}`, Origin: origin, 'Content-Type': 'application/json' },
    });
    try {
      const before = anthropic();
      eq((await as('mybox.local')).status, 200, 'listed name, matched without regard to case');
      eq((await as('tunnel.example.com')).status, 200, 'second listed name');
      eq((await as('other.local')).status, 200, 'an entry written with a port');
      eq((await as('proxied.example')).status, 200, 'an entry written with a scheme');
      eq(anthropic() - before, 4);
      eq((await as('evil.example')).status, 403, 'an unlisted name is still a rebinding page');
      eq((await as('mybox.local', 'https://evil.example')).status, 403, 'the Origin must still match');
      eq(anthropic() - before, 4, 'refusals never reach the key');
    } finally {
      named.close();
    }
  }));
});

/* ------------------------------------------ proxy credentials (8) */

describe('proxy credentials', () => {
  it('percent-encoded userinfo is decoded before it is sent', serial(async () => {
    const seen = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => {
      seen.push(req.headers['proxy-authorization'] || null);
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    process.env.HTTPS_PROXY = `http://alice:p%40ss%3Aword@127.0.0.1:${proxy.address().port}`;
    process.env.NO_PROXY = ''; process.env.no_proxy = '';
    try {
      const H = await import('../src/http.mjs?proxied'); // reads the proxy at load
      await H.httpsGet('https://query1.finance.yahoo.com/v8/finance/chart/AAPL').catch(() => {});
    } finally {
      delete process.env.HTTPS_PROXY;
      proxy.close();
    }
    eq(seen.length, 1, 'the CONNECT reached the proxy');
    const creds = Buffer.from(String(seen[0]).replace(/^Basic /, ''), 'base64').toString();
    eq(creds, 'alice:p@ss:word');
  }));
});

await chain;
server.close();
await report('server-regress');
