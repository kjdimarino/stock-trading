/**
 * Feed-layer logic that is pure enough to test directly: folding live ticks
 * into candles, and grading a quote's freshness.
 */
import { loadPT, describe, it, eq, ok, near, report } from './harness.mjs';

const { PT } = loadPT([
  'src/app/js/00-util.js', 'src/app/js/01-calendar.js',
  'src/app/js/02-universe.js', 'src/app/js/05-data.js',
]);
const F = PT.feed;

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
