/**
 * Paper Trader local server.
 *
 * Two jobs, and nothing more:
 *   1. Serve the (single-page, fully inlined) app.
 *   2. Proxy market data, because Yahoo Finance sends no CORS headers and a
 *      browser therefore cannot call it directly. Proxying also lets us cache,
 *      coalesce and rate-limit so one machine never trips upstream throttles.
 *
 * No account data ever reaches this process — portfolios live in the browser's
 * localStorage.
 */
import http from 'node:http';
import net from 'node:net';
import { STOCKS, ETFS, CRYPTO, ASSETS, BY_ID } from './universe.mjs';
import {
  stockQuotes, cryptoQuotes, fetchCandles, searchSymbols, cryptoMarkets, cryptoProducts,
  stockDirectory, tradeIdeas, providerHealth, geckoQuotes, geckoDirectory,
} from './providers.mjs';
import { postJSON } from './http.mjs';

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const sendJSON = (res, status, obj) => send(res, status, obj);

function sendHTML(res, html) {
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 120);

export function createServer(getHTML) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJSON(res, 400, { error: 'bad request' });
    }
    const p = url.pathname;
    const qs = url.searchParams;

    try {
      /* ------------------------------------------------------------ app */
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return sendHTML(res, getHTML());
      }

      /* ---------------------------------------------------------- static */
      if (req.method === 'GET' && p === '/favicon.ico') {
        // Inline SVG favicon so the app needs no external asset.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0e14"/><path d="M6 21l5-6 4 4 5-8 6 7" stroke="#16c784" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        return send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      }

      /* ------------------------------------------------------- universe */
      if (p === '/api/universe') {
        return sendJSON(res, 200, {
          assets: ASSETS, counts: { stocks: STOCKS.length, etfs: ETFS.length, crypto: CRYPTO.length },
        });
      }

      /* --------------------------------------------------------- quotes */
      if (p === '/api/quotes') {
        const stocks = splitList(qs.get('stocks'));
        const crypto = splitList(qs.get('crypto'));
        /*
         * Coins only CoinGecko carries. Sent as SYMBOL:coingecko-id pairs so the
         * reply can be keyed by the symbol the client trades under, without the
         * server having to hold a symbol table for 18,000 coins.
         */
        const geckoPairs = splitList(qs.get('gecko'))
          .map((pair) => pair.split(':'))
          .filter(([sym, cgId]) => sym && cgId);
        const ttl = Math.max(1000, Math.min(120000, Number(qs.get('ttl')) || 5000));

        const [s, c, g] = await Promise.all([
          stocks.length ? stockQuotes(stocks, ttl) : { quotes: {}, errors: {} },
          crypto.length ? cryptoQuotes(crypto, ttl) : { quotes: {}, errors: {} },
          geckoPairs.length
            ? geckoQuotes(geckoPairs.map(([, cgId]) => cgId)).catch((e) => ({ quotes: {}, error: e.message }))
            : { quotes: {} },
        ]);

        const geckoBySymbol = {};
        const geckoErrors = {};
        for (const [sym, cgId] of geckoPairs) {
          if ((g.quotes || {})[cgId]) geckoBySymbol[sym] = g.quotes[cgId];
          else geckoErrors[sym] = g.error || 'no CoinGecko price for this coin';
        }

        return sendJSON(res, 200, {
          quotes: { ...s.quotes, ...c.quotes, ...geckoBySymbol },
          errors: { ...s.errors, ...c.errors, ...geckoErrors },
          t: Date.now(),
        });
      }

      /* -------------------------------------------------------- candles */
      if (p === '/api/candles') {
        const asset = qs.get('asset');
        const tf = qs.get('tf') || '5m';
        if (!asset) return sendJSON(res, 400, { error: 'asset is required' });
        try {
          const hint = { kind: qs.get('kind'), yh: qs.get('yh'), cg: qs.get('cg') };
          return sendJSON(res, 200, await fetchCandles(asset, tf, hint));
        } catch (e) {
          return sendJSON(res, 502, { error: e.message, asset, tf });
        }
      }

      /* --------------------------------------------------------- search */
      if (p === '/api/search') {
        return sendJSON(res, 200, await searchSymbols(qs.get('q')));
      }

      /* ---------------------------------------------- crypto product list */
      if (p === '/api/crypto/products') {
        try {
          return sendJSON(res, 200, await cryptoProducts());
        } catch (e) {
          return sendJSON(res, 502, { error: e.message });
        }
      }

      /* -------------------------------------------------------- markets */
      if (p === '/api/markets') {
        // CoinGecko ids are letters, digits, '-', '_' and '.'; anything else is junk.
        const ids = splitList(qs.get('ids')).filter((id) => /^[\w.-]+$/.test(id));
        const list = ids.length ? ids : CRYPTO.map((c) => c.cg);
        try {
          return sendJSON(res, 200, await cryptoMarkets(list));
        } catch (e) {
          return sendJSON(res, 502, { error: e.message });
        }
      }

      /* ---------------------------------------------------------- ideas */
      if (p === '/api/ideas') {
        try {
          return sendJSON(res, 200, await tradeIdeas());
        } catch (e) {
          return sendJSON(res, 502, { error: e.message });
        }
      }

      /* ------------------------------------------------------ directory */
      if (p === '/api/directory') {
        try {
          const d = await stockDirectory();
          return sendJSON(res, 200, { count: d.rows.length, source: d.source });
        } catch (e) {
          return sendJSON(res, 502, { error: e.message });
        }
      }

      /* --------------------------------------------------------- health */
      if (p === '/api/health') {
        return sendJSON(res, 200, {
          ok: true,
          uptimeSec: Math.round(process.uptime()),
          llm: llmStatus(),
          providers: providerHealth(),
        });
      }

      /* ------------------------------------------------------------ llm */
      if (p === '/api/llm' && req.method === 'POST') {
        return handleLLM(req, res);
      }

      return sendJSON(res, 404, { error: 'not found', path: p });
    } catch (e) {
      console.error('[server]', p, e);
      return sendJSON(res, 500, { error: e.message });
    }
  });
}

/* -------------------------------------------------------------------- LLM */

/**
 * Optional: if the user exports ANTHROPIC_API_KEY, the AI companion upgrades
 * from computed analytics to real model commentary. The key stays on this
 * machine — the browser never sees it.
 */
function llmStatus() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  return { available: !!key, model: process.env.PT_LLM_MODEL || 'claude-sonnet-4-5-20250929' };
}

/*
 * The LLM route spends the user's key, so only the app itself may call it. Any
 * page can send a "simple" cross-origin POST (text/plain needs no preflight),
 * and a DNS-rebinding page reaches us under its own hostname. So the Host must
 * be one no attacker controls (loopback, an IP literal, or the configured
 * HOST), any Origin must be that same host, and the body must be declared
 * JSON — which a cross-origin page cannot send without a preflight this server
 * never grants.
 */
function fromTheApp(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { return false; }
  const name = host.hostname.replace(/^\[|\]$/g, '');
  if (name !== 'localhost' && name !== HOST && !net.isIP(name)) return false;
  if (req.headers.origin !== undefined) {
    try { if (new URL(req.headers.origin).host !== host.host) return false; } catch { return false; }
  }
  return /^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '');
}

function handleLLM(req, res) {
  if (!fromTheApp(req)) {
    req.resume();
    return sendJSON(res, 403, { error: 'forbidden', message: 'The LLM proxy only answers the app itself.' });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return sendJSON(res, 503, {
      error: 'no_api_key',
      message: 'Set ANTHROPIC_API_KEY before starting the server to enable LLM commentary.',
    });
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 200000) req.destroy();
  });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const upstream = await postJSON('https://api.anthropic.com/v1/messages', {
        model: parsed.model || llmStatus().model,
        max_tokens: Math.min(2000, parsed.max_tokens || 900),
        system: parsed.system,
        messages: parsed.messages || [],
      }, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      return send(res, upstream.status, upstream.body, { 'Content-Type': 'application/json' });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  });
}

/* ------------------------------------------------------------------ boot */

export function start(getHTML, { port = PORT, host = HOST } = {}) {
  const server = createServer(getHTML);
  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`\n  Port ${port} is already in use. Start on another port with:\n    PORT=8080 node paper-trader.mjs\n`);
        process.exit(1);
      }
      reject(e);
    });
    /*
     * Warm the symbol directory in the background. It is ~7,000 rows and takes
     * a couple of seconds cold; doing it now means the user's first search is
     * instant instead of appearing to find nothing.
     */
    stockDirectory().catch(() => { /* search falls back to other sources */ });

    /*
     * Same for the coin directory. It is eight rate-limited requests, so warming
     * it at start-up is the difference between a search that finds the long tail
     * and one that times out waiting for the budget.
     */
    geckoDirectory().catch(() => { /* Coinbase coins still search fine */ });

    server.listen(port, host, () => {
      const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
      console.log(`
  ┌──────────────────────────────────────────────┐
  │  Paper Trader                                │
  │  Practice trading with real market data      │
  └──────────────────────────────────────────────┘

  ▸ Open  ${url}

  Live crypto streams straight from Coinbase in your browser.
  Stock quotes are proxied through this process (Yahoo Finance
  blocks direct browser calls), with Nasdaq as a fallback.

  LLM commentary: ${llmStatus().available ? 'enabled' : 'off (computed analytics in use)'}
  Press Ctrl+C to stop.
`);
      resolve(server);
    });
  });
}
