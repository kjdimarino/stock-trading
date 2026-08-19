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

report('chart');
