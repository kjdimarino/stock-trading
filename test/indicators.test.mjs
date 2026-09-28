import { loadPT, describe, it, eq, near, ok, report } from './harness.mjs';

const { PT } = loadPT(['src/app/js/00-util.js', 'src/app/js/04-indicators.js']);
const TA = PT.ta;

/* Wilder's own worked example from "New Concepts in Technical Trading Systems". */
const WILDER = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
  46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
  43.42, 42.66, 43.13,
];

describe('moving averages', () => {
  it('SMA of a known window', () => near(TA.sma([1, 2, 3, 4, 5], 5), 3, 1e-12));
  it('SMA uses only the last `period` values', () => near(TA.sma([99, 1, 2, 3, 4, 5], 5), 3, 1e-12));
  it('SMA is null when the series is too short', () => eq(TA.sma([1, 2], 5), null));
  it('SMA series pads with nulls then tracks', () => {
    const s = TA.smaSeries([1, 2, 3, 4], 2);
    eq(s[0], null); near(s[1], 1.5, 1e-12); near(s[3], 3.5, 1e-12);
  });
  it('EMA seeds from the SMA of the first window', () => {
    // period 3, first three values average to 2, then 4*0.5 + 2*0.5 = 3
    near(TA.ema([1, 2, 3, 4], 3), 3, 1e-12);
  });
  it('EMA of a constant series equals that constant', () => {
    near(TA.ema(new Array(50).fill(7), 12), 7, 1e-9);
  });
  it('EMA is null when the series is too short', () => eq(TA.ema([1, 2], 10), null));
});

describe('RSI (Wilder smoothing)', () => {
  // Values cross-checked against an independent reference implementation of
  // Wilder's smoothing computed over this exact price series.
  it('matches the reference value at the first full window', () => {
    near(TA.rsi(WILDER.slice(0, 15), 14), 70.4641, 0.001);
  });
  it('matches the reference value one bar later', () => {
    near(TA.rsi(WILDER.slice(0, 16), 14), 66.2496, 0.001);
  });
  it('matches the reference value deeper into the series', () => {
    near(TA.rsi(WILDER.slice(0, 20), 14), 57.9150, 0.001);
  });
  it('matches the published end-of-series value', () => {
    near(TA.rsi(WILDER, 14), 37.79, 0.02);
  });
  it('is 100 when every bar rises', () => {
    near(TA.rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14), 100, 1e-9);
  });
  it('is 0 when every bar falls', () => {
    near(TA.rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14), 0, 1e-9);
  });
  it('is 50 for a flat series', () => {
    near(TA.rsi(new Array(30).fill(50), 14), 50, 1e-9);
  });
  it('is null without enough bars', () => eq(TA.rsi([1, 2, 3], 14), null));
});

describe('MACD', () => {
  const rising = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5);
  it('is positive in a steady uptrend', () => {
    const m = TA.macd(rising);
    ok(m.macd > 0, 'macd line positive');
    // A perfectly linear ramp converges: signal catches the line, histogram -> 0.
    near(m.histogram, 0, 0.02);
  });
  it('histogram is positive when the trend accelerates', () => {
    const accel = Array.from({ length: 120 }, (_, i) => 100 * Math.pow(1.004, i));
    ok(TA.macd(accel).histogram > 0, 'accelerating trend lifts the histogram');
  });
  it('is negative in a steady downtrend', () => {
    const m = TA.macd(rising.slice().reverse());
    ok(m.macd < 0, 'macd line negative');
  });
  it('is ~0 for a flat series', () => {
    const m = TA.macd(new Array(120).fill(42));
    near(m.macd, 0, 1e-9); near(m.histogram, 0, 1e-9);
  });
  it('exposes the previous histogram for crossover detection', () => {
    ok(TA.macd(rising).prevHistogram != null);
  });
  it('is null without enough bars', () => eq(TA.macd([1, 2, 3]), null));
});

describe('Bollinger Bands', () => {
  it('collapses to the mean for a flat series', () => {
    const b = TA.bollinger(new Array(20).fill(10), 20, 2);
    near(b.mid, 10, 1e-12); near(b.upper, 10, 1e-12); near(b.lower, 10, 1e-12);
  });
  it('computes a known population standard deviation', () => {
    // 1..20 has mean 10.5 and population sd sqrt(33.25) ≈ 5.7663
    const b = TA.bollinger(Array.from({ length: 20 }, (_, i) => i + 1), 20, 2);
    near(b.mid, 10.5, 1e-12);
    near(b.sd, Math.sqrt(33.25), 1e-9);
  });
  it('reports %B of 1 at the upper band', () => {
    const vals = Array.from({ length: 20 }, (_, i) => (i === 19 ? 100 : 10));
    const b = TA.bollinger(vals, 20, 2);
    ok(b.percentB > 0.9, `percentB was ${b.percentB}`);
  });
  it('is null without enough bars', () => eq(TA.bollinger([1, 2], 20), null));
});

describe('ATR', () => {
  it('equals the constant range of uniform candles', () => {
    const bars = Array.from({ length: 30 }, () => ({ o: 10, h: 11, l: 9, c: 10, v: 1 }));
    near(TA.atr(bars, 14), 2, 1e-9);
  });
  it('accounts for gaps through the previous close', () => {
    const bars = [{ o: 10, h: 10, l: 10, c: 10, v: 1 }];
    for (let i = 0; i < 20; i++) bars.push({ o: 20, h: 20, l: 20, c: 20, v: 1 });
    ok(TA.atr(bars, 14) >= 0, 'no NaN from a gap');
  });
  it('is null without enough bars', () => eq(TA.atr([{ o: 1, h: 1, l: 1, c: 1 }], 14), null));
});

describe('rate of change and volume', () => {
  it('ROC computes a percentage move', () => near(TA.roc([100, 110], 1), 10, 1e-12));
  it('ROC handles declines', () => near(TA.roc([100, 90], 1), -10, 1e-12));
  it('volume ratio compares latest to average', () => {
    const bars = Array.from({ length: 25 }, () => ({ o: 1, h: 1, l: 1, c: 1, v: 100 }));
    bars.push({ o: 1, h: 1, l: 1, c: 1, v: 300 });
    near(TA.volumeRatio(bars, 20), 3, 1e-9);
  });
  it('range position is 1 at the high and 0 at the low', () => {
    const bars = [{ o: 1, h: 10, l: 1, c: 10, v: 1 }, { o: 1, h: 10, l: 1, c: 10, v: 1 }];
    near(TA.rangePosition(bars).position, 1, 1e-9);
  });
});

describe('volume ratio skips a bar that is still forming', () => {
  // 15m bars at a steady 1000; the feed has just rolled over to a v:0 bar.
  const W = 900e3, t0 = Date.UTC(2026, 8, 28, 13, 30);
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: t0 + i * W, o: 1, h: 1, l: 1, c: 1, v: 1000 }));
  const rolled = [...flat, { t: t0 + 30 * W, o: 1, h: 1, l: 1, c: 1, v: 0 }];
  const born = t0 + 30 * W + 1000;
  it('measures the last complete bar while the newest is forming', () => {
    near(TA.volumeRatio(rolled, 20, born), 1, 1e-9);
    near(TA.volumeRatio(rolled, 20, t0 + 31 * W - 1), 1, 1e-9);
  });
  it('measures the newest bar once its interval has closed', () => {
    near(TA.volumeRatio(rolled, 20, t0 + 31 * W), 0, 1e-9);
  });
  it('a session break does not stretch the bar width', () => {
    // The overnight gap before a session's first bar is not its width.
    const open = [...flat, { t: t0 + 30 * W + 17 * 3600e3, o: 1, h: 1, l: 1, c: 1, v: 250 }];
    near(TA.volumeRatio(open, 20, open[30].t + W + 1), 0.25, 1e-9);
  });
  it('defaults to the real clock', () => {
    const now = Date.now();
    const live = rolled.map((b, i) => ({ ...b, t: now - 1000 - (30 - i) * W }));
    near(TA.volumeRatio(live, 20), 1, 1e-9);
  });
  it('does not turn a young bar into a vote against the trend', () => {
    const up = Array.from({ length: 80 }, (_, i) => {
      const c = 100 * Math.pow(1.0005, i);
      return { t: t0 + i * W, o: c, h: c * 1.001, l: c * 0.999, c, v: 1000 };
    });
    up.push({ t: t0 + 80 * W, o: up[79].c, h: up[79].c, l: up[79].c, c: up[79].c, v: 0 });
    const ind = TA.analyze(up, 252 * 26, t0 + 80 * W + 1000);
    near(ind.volumeRatio, 1, 1e-9);
    const vol = TA.score(ind).factors.find((f) => f.key === 'volume');
    ok(vol && vol.value >= 0, `volume factor ${vol && vol.value} (${vol && vol.detail})`);
  });
});

describe('realised volatility', () => {
  it('is 0 for a flat series', () => near(TA.realizedVol(new Array(40).fill(10)), 0, 1e-9));
  it('is positive and finite for a noisy series', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const v = [100];
    for (let i = 0; i < 200; i++) v.push(v[i] * (1 + (rnd() - 0.5) * 0.02));
    const vol = TA.realizedVol(v);
    ok(vol > 0 && isFinite(vol), `vol was ${vol}`);
  });
});

describe('signal scoring', () => {
  const mkBars = (fn, n = 260) => Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return { t: i * 60000, o: c, h: c * 1.005, l: c * 0.995, c, v: 1000 };
  });

  it('reads a sustained uptrend as bullish', () => {
    const s = TA.score(TA.analyze(mkBars((i) => 100 * (1 + i * 0.004))));
    ok(s.direction > 0, `stance was ${s.stance}`);
    ok(s.stance.includes('bullish'), s.stance);
  });
  it('reads a sustained downtrend as bearish', () => {
    const s = TA.score(TA.analyze(mkBars((i) => 200 * (1 - i * 0.002))));
    ok(s.direction < 0, `stance was ${s.stance}`);
    ok(s.stance.includes('bearish'), s.stance);
  });
  it('reads a flat tape as neutral', () => {
    const s = TA.score(TA.analyze(mkBars(() => 100)));
    eq(s.stance, 'neutral');
  });
  it('confidence stays within 0-100', () => {
    for (const f of [(i) => 100 + i, (i) => 500 - i, () => 50, (i) => 100 + Math.sin(i / 5) * 10]) {
      const s = TA.score(TA.analyze(mkBars(f)));
      ok(s.confidence >= 0 && s.confidence <= 100, `confidence ${s.confidence}`);
    }
  });
  it('reports lower confidence on a thin series than a rich one', () => {
    const thin = TA.score(TA.analyze(mkBars((i) => 100 + i, 30)));
    const rich = TA.score(TA.analyze(mkBars((i) => 100 + i, 260)));
    ok(thin.confidence < rich.confidence, `${thin.confidence} !< ${rich.confidence}`);
  });
  it('ranks factors by contribution and explains each one', () => {
    const s = TA.score(TA.analyze(mkBars((i) => 100 * (1 + i * 0.004))));
    ok(s.factors.length >= 5, 'several factors evaluated');
    ok(s.factors.every((f) => typeof f.detail === 'string' && f.detail.length > 0), 'every factor is explained');
  });
  it('returns null rather than guessing with no data', () => {
    eq(TA.analyze([]), null);
    eq(TA.score(null), null);
  });
  it('never emits NaN in the analysis bundle', () => {
    const ind = TA.analyze(mkBars((i) => 100 + Math.sin(i / 7) * 12));
    const walk = (o) => {
      for (const k in o) {
        const v = o[k];
        if (typeof v === 'number') ok(!Number.isNaN(v), `${k} was NaN`);
        else if (v && typeof v === 'object') walk(v);
      }
    };
    walk(ind);
  });
});

await report('indicators');
