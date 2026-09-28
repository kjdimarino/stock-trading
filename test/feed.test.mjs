/**
 * Feed-layer logic that is pure enough to test directly: folding live ticks
 * into candles, and grading a quote's freshness.
 */
import { loadPT, describe, it, eq, ok, near, report } from './harness.mjs';

const FILES = [
  'src/app/js/00-util.js', 'src/app/js/01-calendar.js',
  'src/app/js/02-universe.js', 'src/app/js/05-data.js',
];
const { PT } = loadPT(FILES);
const F = PT.feed;

/*
 * A fresh feed with the socket, the server, the timers and the clock all in
 * the test's hands, for the lifecycle paths a pure call cannot reach. The
 * default clock is Tue 2026-09-29 10:00 ET, inside a regular session.
 */
function rig(startAt = Date.UTC(2026, 8, 29, 14, 0)) {
  const { PT: P, sandbox } = loadPT(FILES);
  const clock = { now: startAt };
  const RealDate = Date;
  sandbox.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [clock.now])); }
    static now() { return clock.now; }
  };
  const every = [];
  sandbox.setInterval = (fn) => { every.push(fn); return every.length; };
  sandbox.clearInterval = () => {};
  sandbox.setTimeout = () => 0;              // reconnect backoff: never fires on its own
  const listeners = {};
  sandbox.document = { hidden: false, addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  sandbox.addEventListener = (ev, fn) => { listeners[ev] = fn; };
  const sockets = [];
  sandbox.WebSocket = class {
    constructor() { this.sent = []; this.closed = false; sockets.push(this); }
    send(m) { this.sent.push(JSON.parse(m)); }
    close() { this.closed = true; }
  };
  // Every request waits until the test answers it.
  const requests = [];
  sandbox.fetch = (url) => new Promise((resolve) => {
    const req = { url: decodeURIComponent(url), done: false };
    req.reply = (body) => { req.done = true; resolve({ ok: true, status: 200, json: async () => body }); };
    requests.push(req);
  });
  return {
    PT: P, F: P.feed, clock, sockets, requests, listeners,
    get ws() { return sockets[sockets.length - 1]; },
    cryptoPolls: () => requests.filter((r) => r.url.includes('crypto=')),
    /** Advance the clock one second and run the feed's timer. */
    second() { clock.now += 1000; for (const fn of every) fn(); },
    frame(ws, m) { ws.onmessage({ data: JSON.stringify(m) }); },
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

const HOUR = 3600e3;
/* A real Yahoo 60m equity series: bars are anchored on the 09:30 ET open, so
   they land at :30 past the hour and are never a multiple of 3600e3. */
const hourly = () => [
  { t: Date.UTC(2026, 7, 19, 13, 30), o: 100, h: 101, l: 99, c: 100, v: 10 },
  { t: Date.UTC(2026, 7, 19, 14, 30), o: 100, h: 102, l: 100, c: 101, v: 12 },
];

describe('folding ticks into candles', () => {
  it('updates the open bar when a tick lands inside it', () => {
    const bars = hourly();
    const changed = F.applyTickToBars(bars, '1h', 105, Date.UTC(2026, 7, 19, 15, 5));
    eq(changed, true);
    eq(bars.length, 2, 'no new bar for a tick inside the current one');
    near(bars[1].c, 105, 1e-9);
    near(bars[1].h, 105, 1e-9, 'high extended');
  });

  it('does not drop ticks on a session-anchored grid', () => {
    // The epoch-aligned bucket used to reject both of these outright.
    // The 14:30 bar spans 14:30-15:30, so both ticks belong to it.
    const bars = hourly();
    ok(F.applyTickToBars(bars, '1h', 103, Date.UTC(2026, 7, 19, 15, 5)), 'tick at :05 accepted');
    ok(F.applyTickToBars(bars, '1h', 104, Date.UTC(2026, 7, 19, 15, 25)), 'tick at :25 accepted');
    eq(bars.length, 2, 'both belong to the 14:30 bar');
    near(bars[1].c, 104, 1e-9);
    near(bars[1].h, 104, 1e-9);
  });

  it('rolls into a new bar on the series grid, not the epoch grid', () => {
    const bars = hourly();
    F.applyTickToBars(bars, '1h', 106, Date.UTC(2026, 7, 19, 16, 5));
    eq(bars.length, 3);
    eq(new Date(bars[2].t).toISOString(), '2026-08-19T15:30:00.000Z',
      'new bar continues the :30 grid');
    near(bars[2].o, 106, 1e-9);
  });

  it('keeps the grid aligned across a long gap', () => {
    const bars = hourly();
    F.applyTickToBars(bars, '1h', 110, Date.UTC(2026, 7, 19, 18, 45));
    eq(new Date(bars[2].t).toISOString(), '2026-08-19T18:30:00.000Z');
  });

  it('respects a Monday-anchored weekly grid', () => {
    const bars = [
      { t: Date.UTC(2026, 7, 10), o: 10, h: 12, l: 9, c: 11, v: 1 },   // Monday
      { t: Date.UTC(2026, 7, 17), o: 11, h: 13, l: 10, c: 12, v: 1 },  // Monday
    ];
    F.applyTickToBars(bars, '1W', 14, Date.UTC(2026, 7, 26));
    eq(bars.length, 3);
    eq(new Date(bars[2].t).getUTCDay(), 1, 'new weekly bar starts on a Monday');
  });

  it('ignores a print older than the last bar', () => {
    const bars = hourly();
    eq(F.applyTickToBars(bars, '1h', 99, Date.UTC(2026, 7, 19, 12, 0)), false);
    eq(bars.length, 2);
  });

  it('extends the low as well as the high', () => {
    const bars = hourly();
    F.applyTickToBars(bars, '1h', 95, Date.UTC(2026, 7, 19, 15, 5));
    near(bars[1].l, 95, 1e-9);
  });

  it('is a no-op with no data', () => {
    eq(F.applyTickToBars([], '1h', 100, Date.now()), false);
    eq(F.applyTickToBars(null, '1h', 100, Date.now()), false);
    eq(F.applyTickToBars(hourly(), '1h', NaN, Date.now()), false);
  });

  it('keeps intraday grids working too', () => {
    const bars = [{ t: Date.UTC(2026, 7, 19, 13, 30), o: 1, h: 1, l: 1, c: 1, v: 0 }];
    F.applyTickToBars(bars, '5m', 2, Date.UTC(2026, 7, 19, 13, 37));
    eq(bars.length, 2);
    eq(new Date(bars[1].t).toISOString(), '2026-08-19T13:35:00.000Z');
  });
});

describe('sub-minute candles built from the tick buffer', () => {
  /* Push prints for a throwaway symbol so each case starts from a clean buffer. */
  let n = 0;
  const feed = (prints) => {
    const id = `TICKTEST${n++}`;
    for (const [t, p] of prints) F.applyQuote(id, { price: p, t });
    return id;
  };
  const base = Math.floor(Date.now() / 1000) * 1000;

  it('chains each bar open to the previous close so bodies are real', () => {
    const id = feed([[base - 4000, 100], [base - 3000, 101], [base - 2000, 99]]);
    const bars = F.candlesFromTicks(id, '1s');
    const body = bars.find((b) => b.t === base - 3000);
    eq(body.o, 100, 'opens where the previous second closed');
    eq(body.c, 101);
    ok(body.o !== body.c, 'a moving price must not produce a flat dash');
  });

  it('high and low bound the whole bar, open included', () => {
    const id = feed([[base - 4000, 100], [base - 3000, 90]]);
    const b = F.candlesFromTicks(id, '1s').find((x) => x.t === base - 3000);
    eq(b.h, 100);
    eq(b.l, 90);
  });

  it('carries quiet buckets forward flat instead of dropping them', () => {
    const id = feed([[base - 10000, 50], [base - 4000, 51]]);
    const bars = F.candlesFromTicks(id, '1s');
    const ts = bars.map((b) => b.t);
    for (let i = 1; i < ts.length; i++) eq(ts[i] - ts[i - 1], 1000, 'uniform one-second grid');
    const quiet = bars.find((b) => b.t === base - 7000);
    ok(quiet, 'a second with no prints still has a bar');
    eq(quiet.o, 50); eq(quiet.c, 50); eq(quiet.h, 50); eq(quiet.l, 50);
  });

  it('runs the series up to the current bucket', () => {
    const id = feed([[base - 5000, 20]]);
    const bars = F.candlesFromTicks(id, '1s');
    ok(bars.length >= 5, `expected the gap to now to be filled, got ${bars.length}`);
    eq(bars[bars.length - 1].c, 20);
  });

  it('caps the window so a long-lived buffer cannot explode the bar count', () => {
    const id = feed([[base - 3600e3, 10], [base - 1000, 11]]);
    const bars = F.candlesFromTicks(id, '1s');
    ok(bars.length <= 240, `expected a bounded window, got ${bars.length}`);
    eq(bars[0].o, 10, 'the first visible bar still opens at a real price');
  });

  it('buckets at the requested width', () => {
    const id = feed([[base - 20000, 7], [base - 1000, 8]]);
    const bars = F.candlesFromTicks(id, '5s');
    for (let i = 1; i < bars.length; i++) eq(bars[i].t - bars[i - 1].t, 5000);
  });

  it('returns nothing at all when no print has ever arrived', () => {
    eq(F.candlesFromTicks('NEVER_SEEN', '1s').length, 0);
  });

  it('one print from an earlier bucket does not freeze the series', () => {
    /*
     * REST top-ups are stamped with the local clock and socket prints with
     * the exchange's. With the two a couple of seconds apart, the first socket
     * print lands before the last REST one. Appending it blindly used to stall
     * the bucket scan there, so every later print was ignored for minutes.
     */
    const later = Array.from({ length: 25 }, (_, k) => [base - 29000 + k * 1000, 225 - k]);
    const id = feed([[base - 60000, 100], [base - 30000, 101], [base - 32000, 99], ...later]);
    const one = F.candlesFromTicks(id, '1s');
    eq(one[one.length - 1].c, 201, 'the 1s chart follows the tape');
    eq(one.find((b) => b.t === base - 32000).c, 99, 'the late print sits where it belongs');
    const five = F.candlesFromTicks(id, '5s');
    eq(five[five.length - 1].c, 201, 'and so does the 5s chart');
  });

  it('a print stamped ahead of the local clock still reaches the newest bar', () => {
    const id = feed([[base - 3000, 50], [Date.now() + 3000, 55]]);
    const bars = F.candlesFromTicks(id, '1s');
    eq(bars[bars.length - 1].c, 55);
  });
});

describe('merging and ordering quotes', () => {
  it('an exchange stamp does not outlive the source that sent it', () => {
    // Per-product REST sets quoteTime; socket ticks do not. Carried forward,
    // that one stamp graded a live stream STALE 25s later, for the session.
    F.applyQuote('BTC', { price: 64000, source: 'coinbase', quality: 'live', quoteTime: Date.now() - 60000 });
    F.applyQuote('BTC', { price: 64010, source: 'coinbase-ws', quality: 'live', t: Date.now() - 200 });
    eq(F.quote('BTC').quoteTime, null);
    eq(F.grade(F.quote('BTC')), 'live');
  });

  it('drops a quote the exchange stamped before the one on screen', () => {
    const now = Date.now();
    F.applyQuote('ORDER1', { price: 108.66, quoteTime: now - 1000 });
    F.applyQuote('ORDER1', { price: 106.40, quoteTime: now - 6000 });
    eq(F.price('ORDER1'), 108.66);
    F.applyQuote('ORDER1', { price: 109, quoteTime: now });
    eq(F.price('ORDER1'), 109, 'a newer stamp still lands');
  });

  it('drops a quote the server observed before the one on screen', () => {
    // Nasdaq quotes carry no exchange stamp; the server's own is all there is.
    F.applyQuote('ORDER2', { price: 50, quoteTime: null, fetchedAt: 2000 });
    F.applyQuote('ORDER2', { price: 49, quoteTime: null, fetchedAt: 1000 });
    eq(F.price('ORDER2'), 50);
  });

  it('a slow watchlist sweep cannot roll back the focus lane', async () => {
    const r = rig();
    r.F.watch(['AAPL', 'MSFT']);
    r.F.start();
    r.F.setFocus('AAPL');
    const sweep = r.requests.find((q) => q.url.includes('AAPL,MSFT'));
    const focus = r.requests.find((q) => /stocks=AAPL&/.test(q.url));
    ok(sweep && focus, 'both lanes asked');
    const T = r.clock.now;
    const yq = (price, quoteTime) => ({ price, quoteTime, marketState: 'REGULAR', quality: 'live', source: 'yahoo' });
    focus.reply({ quotes: { AAPL: yq(108.66, T - 1000) } });
    await r.settle();
    // The sweep's AAPL came from a cache entry filled seconds earlier.
    sweep.reply({ quotes: { AAPL: yq(106.40, T - 6000), MSFT: yq(400, T - 900) } });
    await r.settle();
    eq(r.F.price('AAPL'), 108.66, 'the older price must not replace the newer one');
    eq(r.F.quote('AAPL').tickDir, 0);
    eq(r.F.price('MSFT'), 400, 'the rest of the sweep still lands');
  });
});

describe('crypto feed lifecycle', () => {
  const ticker = (r, price) => ({
    type: 'ticker', product_id: 'BTC-USD', price: String(price), time: new Date(r.clock.now).toISOString(),
  });

  it('a socket that goes silent without closing is replaced, and REST takes over', async () => {
    const r = rig();
    r.F.watch(['BTC']);
    r.F.start();
    r.cryptoPolls()[0].reply({ quotes: {} });
    await r.settle();
    const ws = r.ws;
    ws.onopen();
    ok(ws.sent[0].channels.includes('heartbeat'), 'heartbeats prove a quiet socket is alive');
    r.frame(ws, ticker(r, 64000));
    eq(r.F.price('BTC'), 64000);

    // Half-open TCP after a laptop wakes: still 'open', never another frame.
    for (let i = 0; i < 16; i++) r.second();
    ok(ws.closed, 'the dead socket is torn down');
    ok(r.F.status.ws !== 'open', `status still says ${r.F.status.ws}`);
    eq(r.F.status.cryptoLive, false, 'the top bar must not say Live feed');
    const poll = r.cryptoPolls().find((q) => !q.done);
    ok(poll, 'REST picks the coin up');
    poll.reply({ quotes: { BTC: { price: 61000, source: 'coinbase', quality: 'live' } } });
    await r.settle();
    eq(r.F.price('BTC'), 61000, 'and replaces the frozen socket price');
  });

  it('heartbeats keep a socket on a quiet market alive', () => {
    const r = rig();
    r.F.watch(['BTC']);
    r.F.start();
    const ws = r.ws;
    ws.onopen();
    for (let i = 0; i < 40; i++) {
      r.second();
      r.frame(ws, { type: 'heartbeat', product_id: 'BTC-USD', time: new Date(r.clock.now).toISOString() });
    }
    eq(ws.closed, false);
    eq(r.F.status.ws, 'open');
    eq(r.sockets.length, 1);
  });

  it('coming back to the tab replaces a socket that died in the background', () => {
    const r = rig();
    r.F.watch(['BTC']);
    r.F.start();
    r.ws.onopen();
    r.clock.now += 10 * 60e3;                // timers are throttled while hidden
    r.listeners.visibilitychange();
    eq(r.sockets.length, 2, 'a new socket is opened at once');
    ok(r.sockets[0].closed);
  });

  it('never stacks crypto polls while one is still out', async () => {
    const r = rig();
    r.F.watch(['BTC']);
    r.F.start();                             // the socket never opens
    for (let i = 0; i < 6; i++) r.second();
    eq(r.cryptoPolls().length, 1, 'one request at a time, however slow the server');
    r.cryptoPolls()[0].reply({ quotes: { BTC: { price: 1, source: 'coinbase', quality: 'live' } } });
    await r.settle();
    r.second();
    eq(r.cryptoPolls().length, 2, 'the next one goes once it has answered');
  });

  it('a coin watched while a poll is out is fetched once that poll answers', async () => {
    // A delayed coin gets nothing from the socket or the timer while the
    // socket is live, so the watch() that adds it is its only request.
    const r = rig();
    r.F.watch(['BTC']);
    r.F.start();
    r.cryptoPolls()[0].reply({ quotes: {} });
    await r.settle();
    const ws = r.ws;
    ws.onopen();
    r.frame(ws, ticker(r, 64000));
    for (const id of ['SLOWA', 'SLOWB']) {
      r.PT.registerAsset({ id, name: id, kind: 'crypto', cg: id.toLowerCase(), delayed: true });
    }
    r.F.watch(['SLOWA']);
    const slow = r.cryptoPolls()[1];
    ok(/gecko=SLOWA:slowa/.test(slow.url), slow.url);
    r.F.watch(['SLOWB']);                    // lands while SLOWA's request waits on the limiter
    eq(r.cryptoPolls().length, 2, 'still one request at a time');
    slow.reply({ quotes: { SLOWA: { price: 2, source: 'coingecko', quality: 'delayed' } } });
    await r.settle();
    const next = r.cryptoPolls()[2];
    ok(next && /SLOWB:slowb/.test(next.url), 'the coin added mid-flight is asked for next');
    next.reply({ quotes: { SLOWB: { price: 3, source: 'coingecko', quality: 'delayed' } } });
    await r.settle();
    eq(r.F.price('SLOWB'), 3);
    r.second();
    eq(r.cryptoPolls().length, 3, 'and the follow-up is not repeated');
  });

  it('unwatching the focused coin keeps feeding the quote being traded', async () => {
    const r = rig();
    r.F.watch(['BTC', 'ADA']);
    r.F.setFocus('ADA');
    r.F.start();
    r.cryptoPolls()[0].reply({ quotes: {} });
    await r.settle();
    const ws = r.ws;
    ws.onopen();
    r.F.unwatch('ADA');
    ok(!ws.sent.some((m) => m.type === 'unsubscribe' && m.product_ids.includes('ADA-USD')),
      'the socket must keep the focused coin');
    // And with the socket down, REST keeps it priced.
    ws.onclose();
    ok(/crypto=[^&]*ADA/.test(r.cryptoPolls().pop().url), 'the REST top-up covers it');
  });

  it('the socket follows focus onto an unwatched coin and off it again', () => {
    const r = rig();
    r.F.watch(['BTC']);
    r.F.start();
    const ws = r.ws;
    ws.onopen();
    r.F.setFocus('LINK');
    ok(ws.sent.some((m) => m.type === 'subscribe' && m.product_ids.includes('LINK-USD')), 'subscribed on focus');
    r.F.setFocus('BTC');
    ok(ws.sent.some((m) => m.type === 'unsubscribe' && m.product_ids.includes('LINK-USD')), 'released on leaving');
  });
});

describe('which tier a coin belongs to', () => {
  /*
   * Every curated coin carries a CoinGecko id, because that is what the market
   * cap panel looks up. Treating that id as the marker of the delayed tier
   * demotes BTC and every other major to snapshot pricing and stops the live
   * socket from ever subscribing to them — which is what "everything says
   * stale" looked like from the outside. The marker is the ABSENCE of a
   * Coinbase product, and this pins it.
   */
  it('a curated coin is live even though it has a CoinGecko id', () => {
    const btc = PT.byId.BTC;
    ok(btc, 'BTC must be in the seed universe');
    ok(btc.cg, 'and it does carry a CoinGecko id');
    ok(btc.cb, 'and a Coinbase product');
    eq(PT.isDelayedCoin('BTC'), false, 'so it must NOT be treated as delayed');
  });

  it('every seed coin with a Coinbase market counts as live', () => {
    for (const a of PT.assets) {
      if (a.kind !== 'crypto' || !a.cb) continue;
      eq(PT.isDelayedCoin(a.id), false, `${a.id} was demoted to the delayed tier`);
    }
  });

  it('a coin discovered with only a CoinGecko id is delayed', () => {
    PT.registerAsset({ id: 'TESTCOIN', name: 'Test Coin', kind: 'crypto', cg: 'test-coin', delayed: true });
    eq(PT.isDelayedCoin('TESTCOIN'), true);
    eq(PT.byId.TESTCOIN.cb, null, 'and it must never be handed to the Coinbase socket');
  });

  it('an unknown symbol is not a delayed coin', () => {
    eq(PT.isDelayedCoin('NOT_A_THING'), false);
  });
});

describe('freshness grading', () => {
  const q = (over) => Object.assign({ assetId: 'AAPL', price: 100, quality: 'live', t: Date.now() }, over);

  it('a fresh live quote grades live', () => eq(F.grade(q()), 'live'));
  it('an explicitly delayed source stays delayed', () => eq(F.grade(q({ quality: 'delayed' })), 'delayed'));
  it('a cached snapshot stays cached', () => eq(F.grade(q({ quality: 'cached' })), 'cached'));
  it('a record without a usable price grades as none', () => eq(F.grade(q({ price: NaN })), 'none'));
  it('a symbol never fetched grades as loading, not no-data', () => {
    // Before the first cycle completes, "no data" would overstate what we know.
    eq(F.grade(null, 'AAPL'), 'loading');
    eq(F.grade(undefined, 'BTC'), 'loading');
  });

  it('an old exchange stamp grades stale even when just polled', () => {
    // The failure this guards: polling a closed market every 12s keeps `t`
    // fresh, so a Friday close would otherwise show a pulsing green Live dot
    // all weekend.
    eq(F.grade(q({ t: Date.now(), quoteTime: Date.now() - 48 * 3600e3 })), 'stale');
  });

  it('a recent exchange stamp grades live', () => {
    eq(F.grade(q({ t: Date.now(), quoteTime: Date.now() - 5000 })), 'live');
  });

  it('crypto goes stale faster than equities', () => {
    const old = Date.now() - 40000;
    eq(F.grade({ assetId: 'BTC', price: 1, quality: 'live', t: old }), 'stale');
    eq(F.grade({ assetId: 'AAPL', price: 1, quality: 'live', t: old }), 'live');
  });
});

describe('Coinbase frame parsing', () => {
  it('ignores frames for products outside the universe', () => {
    eq(F.parseCoinbaseTicker({ type: 'ticker', product_id: 'NOPE-USD', price: '1' }), null);
  });
  it('maps a real frame onto a quote', () => {
    const p = F.parseCoinbaseTicker({
      type: 'ticker', product_id: 'BTC-USD', price: '64000', open_24h: '64000',
      best_bid: '63999', best_ask: '64001', volume_24h: '100', time: '2026-08-19T04:00:00Z',
    });
    eq(p.symbol, 'BTC');
    near(p.quote.price, 64000, 1e-9);
    near(p.quote.changePct, 0, 1e-9);
    eq(p.quote.source, 'coinbase-ws');
  });
});

await report('feed');
