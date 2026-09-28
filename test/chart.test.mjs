import { loadPT, describe, it, eq, near, ok, report } from './harness.mjs';

// The chart module touches DOM APIs only inside class constructors, so the
// pure geometry helpers can be exercised directly.
const { PT, sandbox } = loadPT(['src/app/js/00-util.js', 'src/app/js/06-chart.js'], { localStorage: false });
const C = PT.chart;

describe('nice-number axis ticks', () => {
  it('produces round steps over a simple range', () => {
    const t = C.ticks(0, 100, 5);
    ok(t.length >= 4, `${t.length} ticks`);
    // 1-2-5-10 family: 20 is the nice step here, not 25.
    near(t[1] - t[0], 20, 1e-9);
  });
  it('covers the requested range', () => {
    const t = C.ticks(13.7, 88.2, 6);
    ok(t[0] >= 13.7 && t[t.length - 1] <= 88.2 + (t[1] - t[0]));
  });
  it('handles a sub-penny range without collapsing', () => {
    // A realistic PEPE window, and a narrow one that used to yield one gridline.
    for (const [lo, hi] of [[0.00000253, 0.00000262], [0.0000025, 0.0000031]]) {
      const t = C.ticks(lo, hi, 4);
      ok(t.length >= 3, `${t.length} ticks for range ${lo}..${hi}`);
      ok(t.every((v) => v > 0 && isFinite(v)));
    }
  });
  it('never returns an unbounded tick list', () => {
    ok(C.ticks(0, 1e12, 4).length < 200);
    ok(C.ticks(1e-12, 2e-12, 4).length < 200);
  });
  it('degrades gracefully when hi equals lo', () => eq(C.ticks(5, 5, 4).length, 1));
  it('steps are uniform', () => {
    const t = C.ticks(100, 200, 5);
    const step = t[1] - t[0];
    for (let i = 2; i < t.length; i++) near(t[i] - t[i - 1], step, 1e-9);
  });
});

describe('axis decimals', () => {
  it('whole-dollar steps show no decimals', () => eq(C.axisDecimals(1), 0));
  it('thousand-dollar steps show no decimals', () => eq(C.axisDecimals(1000), 0));
  it('half-unit steps show one decimal', () => eq(C.axisDecimals(0.5), 1));
  it('cent steps show two decimals', () => eq(C.axisDecimals(0.01), 2));
  it('sub-penny steps keep enough precision', () => ok(C.axisDecimals(0.0000001) >= 7));
  it('never returns a negative or absurd precision', () => {
    for (const s of [0, -1, NaN, 1e9, 1e-12]) {
      const d = C.axisDecimals(s);
      ok(d >= 0 && d <= 8, `axisDecimals(${s}) = ${d}`);
    }
  });
});

/* ------------------------------------------------------ rendered charts -- */

// Just enough DOM for the real PriceChart/EquityChart to paint. Each 2D
// context records its fillText calls, so a test can read what was drawn.
const recordingCtx = () => new Proxy({ texts: [] }, {
  get(t, k) {
    if (k === 'fillText') return (s) => t.texts.push(String(s));
    if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
    if (k in t) return t[k];
    return () => ({ addColorStop() {} });
  },
  set(t, k, v) { t[k] = v; return true; },
});
let rafSeq = 0;
const rafQueue = new Map();
Object.assign(sandbox, {
  document: {
    documentElement: {},
    createElement: () => {
      const ctx = recordingCtx();
      return { getContext: () => ctx, remove() {}, style: {} };
    },
  },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: (f) => { rafQueue.set(++rafSeq, f); return rafSeq; },
  cancelAnimationFrame: (id) => rafQueue.delete(id),
  devicePixelRatio: 1,
});
const flush = () => { const q = [...rafQueue.values()]; rafQueue.clear(); q.forEach((f) => f()); };
const box = (width, height) => ({
  appendChild() {}, addEventListener() {}, removeEventListener() {},
  style: {}, classList: { toggle() {} },
  getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
});

/*
 * Pin the "browser" time zone, whatever zone the suite runs in. Dates are the
 * interesting case west of UTC, where a bar stamped 00:00 UTC is still the
 * previous evening locally.
 */
let localZone = 'America/New_York';
const RealIntl = Intl;
sandbox.Intl = Object.create(RealIntl, {
  DateTimeFormat: {
    value: function (loc, opts) { return new RealIntl.DateTimeFormat(loc, { timeZone: localZone, ...opts }); },
  },
});

function priceChart(bars, tf, w = 800, h = 400) {
  const chart = new C.PriceChart(box(w, h));
  chart.setData(bars, tf);
  flush();
  return chart;
}
/** Crosshair pill texts, [price, time], with bar `i` hovered. */
function pills(chart, i) {
  chart.hover = i;
  chart.octx.texts.length = 0;
  chart._drawOverlay();
  return chart.octx.texts.slice();
}
const NUMERIC = /^\$?[\d,]+(\.\d+)?$/;
const parseLabel = (s) => Number(s.replace(/[$,]/g, ''));
/** Price-axis labels: the run of numbers painted before the time axis. */
function priceAxis(chart) {
  const out = [];
  for (const s of chart.bctx.texts) { if (!NUMERIC.test(s)) break; out.push(parseLabel(s)); }
  return out;
}
const fmtAxis = (v, dp) => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const DAY = 86400e3;

describe('axis labels sit on their gridlines', () => {
  const uniform = (labels, what) => {
    ok(labels.length >= 3, `${what}: ${labels.length} labels`);
    for (let i = 2; i < labels.length; i++) {
      near(labels[i] - labels[i - 1], labels[1] - labels[0], 1e-9, `${what}: labels ${labels.join(' | ')}`);
    }
  };
  it('every tick reads back as its own value', () => {
    // Ranges whose first nice step leaves too few gridlines, so ticks() densifies.
    for (const [lo, hi, n] of [[101, 113, 3], [0.1003, 0.1133, 3], [0.3, 1.4, 6], [179.2888, 189.6012, 6], [99999.1, 100009.9, 5]]) {
      const t = C.ticks(lo, hi, n);
      const dp = C.axisDecimals(t[1] - t[0]);
      for (const v of t) near(parseLabel(fmtAxis(v, dp)), v, (t[1] - t[0]) * 1e-6, `ticks(${lo}, ${hi}, ${n}) at ${v} reads ${fmtAxis(v, dp)}`);
    }
  });
  it('steps stay in the 1-2-5 family, whatever the range', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < 2000; k++) {
      const lo = Math.pow(10, rnd() * 12 - 7);
      const hi = lo * (1 + rnd() * 0.5);
      const t = C.ticks(lo, hi, 3 + Math.floor(rnd() * 6));
      const step = t[1] - t[0];
      const m = step / Math.pow(10, Math.floor(Math.log10(step)));
      ok([1, 2, 5, 10].some((f) => Math.abs(m - f) < 1e-6), `step ${step} for ${lo}..${hi}`);
    }
  });
  it('the price axis on a ~$180 chart is evenly labelled', () => {
    // Bars spanning 180.00-188.89 give six gridlines at this size.
    const t0 = Date.UTC(2026, 7, 10);
    const bars = [180, 182.4, 184.1, 185.6, 186.9, 188.2].map((c, i) => ({ t: t0 + i * DAY, o: c, h: c + 0.4, l: c - 0.4, c, v: 1000 }));
    bars[0].l = 180; bars[5].h = 188.89;
    uniform(priceAxis(priceChart(bars, '1D')), 'price axis');
  });
  it('the equity axis of a barely-moved account is evenly labelled', () => {
    const chart = new C.EquityChart(box(600, 260));
    chart.ctx.texts.length = 0;
    chart.setSeries([{ name: 'You', color: '#fff', points: [{ t: 0, e: 100000 }, { t: 1, e: 100004 }, { t: 2, e: 100009 }] }]);
    uniform(chart.ctx.texts.filter((s) => NUMERIC.test(s)).map(parseLabel), 'equity axis');
  });
});

describe('sub-penny price pills', () => {
  const t0 = Date.UTC(2026, 8, 28, 12);
  const closes = [0.00000253, 0.00000258, 0.00000262, 0.00000255, 0.00000249, 0.00000254];
  const bars = closes.map((c, i) => ({ t: t0 + i * 300e3, o: c, h: c * 1.002, l: c * 0.998, c, v: 1e9 }));
  it('the last-price pill keeps every significant digit', () => {
    eq(priceChart(bars, '5m').bctx.texts.at(-1), '0.00000254');
  });
  it('the crosshair pill tells neighbouring candles apart', () => {
    const chart = priceChart(bars, '5m');
    eq(pills(chart, 4)[0], '0.00000249');
    eq(pills(chart, 1)[0], '0.00000258');
  });
  it('a drawn level is labelled with its real price', () => {
    const chart = priceChart(bars, '5m');
    chart.setDrawings([{ kind: 'level', pts: [{ t: bars[2].t, price: 0.0000026 }] }]);
    ok(chart.octx.texts.includes('0.00000260'), chart.octx.texts.join(' | '));
  });
  it('ordinary prices keep their usual precision', () => {
    const plain = bars.map((b, i) => ({ ...b, o: 184 + i, h: 185 + i, l: 183 + i, c: 184.25 + i }));
    eq(priceChart(plain, '5m').bctx.texts.at(-1), '189.25');
  });
});

describe('time labels', () => {
  // Nasdaq-fallback and Coinbase daily bars are stamped 00:00 UTC.
  const days = [13, 14, 17, 18, 19].map((d) => Date.UTC(2026, 7, d));
  const daily = (stamps) => stamps.map((t, i) => ({ t, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 }));
  const timeAxis = (chart) => chart.bctx.texts.filter((s) => /^[A-Z][a-z]{2} \d/.test(s));
  it('daily bars are labelled with their session date west of UTC', () => {
    localZone = 'America/New_York';
    const chart = priceChart(daily(days), '1D');
    eq(timeAxis(chart).slice().reverse(), ['Aug 13', 'Aug 14', 'Aug 17', 'Aug 18', 'Aug 19']);
    eq(pills(chart, 4)[1], 'Aug 19');
  });
  it('US-session daily stamps keep their date far east of UTC', () => {
    // Yahoo stamps a US daily bar at the 13:30 UTC open — already tomorrow in Auckland.
    localZone = 'Pacific/Auckland';
    try {
      const chart = priceChart(daily(days.map((t) => t + 13.5 * 3600e3)), '1D');
      eq(pills(chart, 1)[1], 'Aug 14');
    } finally { localZone = 'America/New_York'; }
  });
  it('5m pills tell the same time on different days apart', () => {
    // Mon and Tue 2026-09-21/22 at 10:35 New York time.
    const mon = Date.UTC(2026, 8, 21, 14, 35), tue = Date.UTC(2026, 8, 22, 14, 35);
    const chart = priceChart(daily([mon, mon + 300e3, tue, tue + 300e3]), '5m');
    const a = pills(chart, 0)[1], b = pills(chart, 2)[1];
    ok(a !== b, `both read "${a}"`);
    ok(a.startsWith('Sep 21') && b.startsWith('Sep 22'), `${a} / ${b}`);
  });
  it('weekly bars name their week, not a day of the month', () => {
    // toWeekly buckets are Mondays at 00:00 UTC.
    const weeks = [Date.UTC(2025, 8, 1), Date.UTC(2026, 7, 3), Date.UTC(2026, 7, 10)];
    const chart = priceChart(daily(weeks), '1W');
    eq(pills(chart, 0)[1], 'Sep 1, 2025');
    eq(pills(chart, 1)[1], 'Aug 3, 2026');
    eq(pills(chart, 2)[1], 'Aug 10, 2026');
  });
});

describe('sparkline path', () => {
  it('emits a path across the full width', () => {
    const d = C.sparklinePath([1, 2, 3, 4], 52, 22);
    ok(d.startsWith('M0.0,'), d);
    ok(d.includes('L52.0,'), d);
  });
  it('is empty for too few points', () => {
    eq(C.sparklinePath([1], 52, 22), '');
    eq(C.sparklinePath(null, 52, 22), '');
  });
  it('handles a flat series without dividing by zero', () => {
    const d = C.sparklinePath([5, 5, 5], 52, 22);
    ok(d.length > 0 && !/NaN/.test(d), d);
  });
  it('maps the maximum to the top of the box', () => {
    const d = C.sparklinePath([0, 10], 52, 22);
    ok(/L52\.0,0\.0/.test(d), d);
  });
});

await report('chart');
