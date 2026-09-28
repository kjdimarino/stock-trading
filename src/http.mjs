/**
 * Minimal zero-dependency HTTPS client.
 *
 * Why not global fetch()? Node's fetch ignores HTTPS_PROXY, and this app has to
 * work both on a normal laptop (direct egress) and behind a corporate/agent
 * proxy. Doing the CONNECT tunnel by hand keeps us dependency-free and works on
 * Node 18+ everywhere.
 */
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { URL } from 'node:url';
import zlib from 'node:zlib';

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function bypassProxy(hostname) {
  const h = hostname.toLowerCase();
  return NO_PROXY.some((rule) => {
    if (rule === '*') return true;
    if (rule.startsWith('.')) return h.endsWith(rule);
    if (rule.startsWith('*.')) return h.endsWith(rule.slice(1));
    return h === rule;
  });
}

/** Open a TLS socket to host:443, tunnelling through the proxy when configured. */
function connect(hostname, port, cb) {
  if (!PROXY || bypassProxy(hostname)) {
    return cb(null, null); // caller uses a direct request
  }
  const p = new URL(PROXY);
  const headers = { Host: `${hostname}:${port}` };
  if (p.username) {
    // URL keeps userinfo percent-encoded ('p%40ss'); the proxy wants 'p@ss'.
    const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } }; // malformed: as written
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${dec(p.username)}:${dec(p.password)}`).toString('base64');
  }
  const req = http.request({
    host: p.hostname,
    port: p.port || 80,
    method: 'CONNECT',
    path: `${hostname}:${port}`,
    headers,
  });
  req.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      return cb(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
    }
    cb(null, socket);
  });
  req.on('error', cb);
  req.end();
}

const DEFAULT_HEADERS = {
  // Yahoo's endpoints 404/401 for unknown agents; a browser UA is required.
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
};

function decompress(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch { /* fall through to raw */ }
  return buf;
}

/**
 * GET a URL and return { status, body, headers }. Never throws on HTTP status;
 * only on transport failure or timeout.
 */
export function httpsGet(urlStr, { timeout = 9000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const port = url.port || (url.protocol === 'http:' ? 80 : 443);

    const finish = (socket) => {
      const opts = {
        method: 'GET',
        host: url.hostname,
        port,
        path: url.pathname + url.search,
        headers: { ...DEFAULT_HEADERS, ...headers, Host: url.hostname },
        timeout,
      };
      if (socket) {
        opts.createConnection = () =>
          tls.connect({ socket, servername: url.hostname });
      }
      const mod = url.protocol === 'http:' && !socket ? http : https;
      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
          resolve({ status: res.statusCode, body: raw.toString('utf8'), headers: res.headers });
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeout}ms`)); });
      req.on('error', reject);
      req.end();
    };

    connect(url.hostname, port, (err, socket) => {
      if (err) return reject(err);
      finish(socket);
    });
  });
}

/** GET and JSON.parse. Throws on non-2xx or unparseable body. */
export async function getJSON(url, opts) {
  const res = await httpsGet(url, opts);
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    err.status = res.status;
    err.body = res.body.slice(0, 200);
    throw err;
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`Malformed JSON from ${new URL(url).hostname}`);
  }
}

/** POST JSON (used only for the optional LLM proxy). */
export function postJSON(urlStr, payload, { timeout = 60000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const port = url.port || 443;
    const data = Buffer.from(JSON.stringify(payload));
    const send = (socket) => {
      const opts = {
        method: 'POST',
        host: url.hostname,
        port,
        path: url.pathname + url.search,
        headers: {
          ...DEFAULT_HEADERS,
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          ...headers,
          Host: url.hostname,
        },
        timeout,
      };
      if (socket) opts.createConnection = () => tls.connect({ socket, servername: url.hostname });
      const req = https.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
          resolve({ status: res.statusCode, body: raw.toString('utf8') });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(data);
    };
    connect(url.hostname, port, (err, socket) => (err ? reject(err) : send(socket)));
  });
}
