/* =========================================================================
   Technical indicators.

   Everything here is real, standard math computed from real candles — this is
   what powers the AI companion's commentary and the autonomous trader. No
   estimate is ever produced without enough bars to support it; functions
   return null instead of a made-up number.
   ========================================================================= */
(function (PT) {
  'use strict';

  const closes = (bars) => bars.map((b) => b.c);

  /** Simple moving average of the last `period` values. */
  function sma(values, period) {
    if (!values || values.length < period) return null;
    let sum = 0;
    for (let i = values.length - period; i < values.length; i++) sum += values[i];
    return sum / period;
  }

  /** Full SMA series (null-padded until the window fills). */
  function smaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  /**
   * EMA series. Seeded with the SMA of the first `period` values, which is the
   * conventional warm-up and keeps results comparable with charting packages.
   */
  function emaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let seed = 0;
    for (let i = 0; i < period; i++) seed += values[i];
    let prev = seed / period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  const ema = (values, period) => {
    const s = emaSeries(values, period);
    return s.length ? s[s.length - 1] : null;
  };

  /**
   * Wilder's RSI — the original smoothing (not a plain EMA), which is what
   * every charting platform shows.
   */
  function rsi(values, period = 14) {
    if (!values || values.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period, avgLoss = loss / period;
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    }
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /** MACD line, signal line and histogram. */
  function macd(values, fast = 12, slow = 26, signal = 9) {
    if (!values || values.length < slow + signal) return null;
    const ef = emaSeries(values, fast);
    const es = emaSeries(values, slow);
    const line = [];
    for (let i = 0; i < values.length; i++) {
      line.push(ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
    }
    const defined = line.filter((v) => v != null);
    if (defined.length < signal) return null;
    const sig = emaSeries(defined, signal);
    const macdV = defined[defined.length - 1];
    const signalV = sig[sig.length - 1];
    if (signalV == null) return null;
    // Previous histogram lets callers detect a fresh crossover.
    const prevMacd = defined[defined.length - 2];
    const prevSignal = sig[sig.length - 2];
    return {
      macd: macdV,
      signal: signalV,
      histogram: macdV - signalV,
      prevHistogram: prevMacd != null && prevSignal != null ? prevMacd - prevSignal : null,
    };
  }

  /** Bollinger Bands with a population standard deviation. */
  function bollinger(values, period = 20, mult = 2) {
    if (!values || values.length < period) return null;
    const slice = values.slice(-period);
    const mid = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const upper = mid + mult * sd, lower = mid - mult * sd;
    const last = values[values.length - 1];
    return {
      upper, mid, lower, sd,
      bandwidth: mid > 0 ? ((upper - lower) / mid) * 100 : 0,
      // 0 = at the lower band, 1 = at the upper band.
      percentB: upper > lower ? (last - lower) / (upper - lower) : 0.5,
    };
  }

  /** Average True Range (Wilder smoothing) — the volatility unit for stops. */
  function atr(bars, period = 14) {
    if (!bars || bars.length < period + 1) return null;
    const tr = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], p = bars[i - 1];
      tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
    }
    if (tr.length < period) return null;
    let v = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) v = (v * (period - 1) + tr[i]) / period;
    return v;
  }

  /** Percent rate of change over `period` bars. */
  function roc(values, period) {
    if (!values || values.length < period + 1) return null;
    const prev = values[values.length - 1 - period];
    if (!prev) return null;
    return ((values[values.length - 1] - prev) / prev) * 100;
  }

  /**
   * Is the newest bar still being built at `now`? Providers return the
   * in-progress candle, and the live feed appends a v:0 bar at every rollover.
   * The bar width is the median recent gap, so an overnight or weekend break
   * before a session's first bar does not stretch it.
   */
  function lastBarForming(bars, now) {
    if (!isFinite(now)) return false;
    const gaps = [];
    for (let i = bars.length - 1; i > 0 && gaps.length < 9; i--) {
      const g = bars[i].t - bars[i - 1].t;
      if (g > 0) gaps.push(g);
    }
    if (!gaps.length) return false;
    gaps.sort((a, b) => a - b);
    return now < bars[bars.length - 1].t + gaps[gaps.length >> 1];
  }

  /**
   * Latest volume relative to its own average — a crude but useful conviction
   * proxy. Measured on the newest complete bar: a forming bar holds only part
   * of its volume and would read as a low-volume bar.
   */
  function volumeRatio(bars, period = 20, now = Date.now()) {
    if (bars && lastBarForming(bars, now)) bars = bars.slice(0, -1);
    if (!bars || bars.length < period + 1) return null;
    const recent = bars.slice(-period - 1, -1);
    const avg = recent.reduce((a, b) => a + (b.v || 0), 0) / recent.length;
    if (!avg) return null;
    return (bars[bars.length - 1].v || 0) / avg;
  }

  /** Annualised realised volatility from log returns, in percent. */
  function realizedVol(values, periodsPerYear = 252) {
    if (!values || values.length < 20) return null;
    const rets = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] > 0 && values[i] > 0) rets.push(Math.log(values[i] / values[i - 1]));
    }
    if (rets.length < 10) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(varr) * Math.sqrt(periodsPerYear) * 100;
  }

  /** Where price sits inside its own range: 0 = period low, 1 = period high. */
  function rangePosition(bars, lookback = 252) {
    if (!bars || !bars.length) return null;
    const slice = bars.slice(-lookback);
    let hi = -Infinity, lo = Infinity;
    for (const b of slice) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
    const last = slice[slice.length - 1].c;
    if (!(hi > lo)) return null;
    // Report the window actually measured — the caller may have had fewer bars
    // than the requested lookback, and the label must not overstate it.
    return { high: hi, low: lo, position: (last - lo) / (hi - lo), lookback: slice.length };
  }

  /**
   * Compute the whole indicator set for a candle series.
   * `periodsPerYear` should reflect the bar interval so volatility is sane.
   * `now` decides whether the newest bar is still forming (see volumeRatio).
   */
  function analyze(bars, periodsPerYear = 252, now = Date.now()) {
    if (!bars || bars.length < 2) return null;
    const c = closes(bars);
    const last = c[c.length - 1];

    const m = macd(c);
    const bb = bollinger(c);
    const a = atr(bars);
    const range = rangePosition(bars);

    return {
      bars: bars.length,
      last,
      sma20: sma(c, 20),
      sma50: sma(c, 50),
      sma200: sma(c, 200),
      ema12: ema(c, 12),
      ema26: ema(c, 26),
      rsi14: rsi(c, 14),
      macd: m,
      bollinger: bb,
      atr14: a,
      atrPct: a != null && last > 0 ? (a / last) * 100 : null,
      roc5: roc(c, 5),
      roc10: roc(c, 10),
      roc20: roc(c, 20),
      volumeRatio: volumeRatio(bars, 20, now),
      realizedVol: realizedVol(c, periodsPerYear),
      range,
    };
  }

  /* ------------------------------------------------------------- scoring */

  /**
   * Turn the indicator set into a stance and a confidence.
   *
   * The score is a weighted sum of independent signals, each contributing at
   * most its weight in either direction. Confidence is the share of signals
   * that could actually be evaluated (so a thin series reports low confidence
   * rather than a falsely strong opinion).
   */
  function score(ind) {
    if (!ind) return null;
    const factors = [];
    const add = (key, weight, value, detail) => {
      if (value == null || !isFinite(value)) return;
      factors.push({ key, weight, value: Math.max(-1, Math.min(1, value)), detail });
    };

    // Trend: price relative to its moving averages.
    if (ind.sma20 != null) add('px_vs_sma20', 1.2, (ind.last / ind.sma20 - 1) * 25, `Price ${ind.last >= ind.sma20 ? 'above' : 'below'} SMA20`);
    if (ind.sma50 != null) add('px_vs_sma50', 1.0, (ind.last / ind.sma50 - 1) * 15, `Price ${ind.last >= ind.sma50 ? 'above' : 'below'} SMA50`);
    if (ind.sma20 != null && ind.sma50 != null) {
      add('ma_cross', 1.3, (ind.sma20 / ind.sma50 - 1) * 30,
        ind.sma20 >= ind.sma50 ? 'SMA20 above SMA50 (uptrend)' : 'SMA20 below SMA50 (downtrend)');
    }

    // Momentum.
    if (ind.rsi14 != null) {
      // Map RSI 30..70 onto -1..1, and treat extremes as mean-reversion warnings.
      const centred = (ind.rsi14 - 50) / 20;
      add('rsi', 1.1, ind.rsi14 > 70 ? 0.35 : ind.rsi14 < 30 ? -0.35 : centred,
        `RSI ${ind.rsi14.toFixed(1)}${ind.rsi14 > 70 ? ' (overbought)' : ind.rsi14 < 30 ? ' (oversold)' : ''}`);
    }
    if (ind.macd) {
      add('macd', 1.2, ind.macd.histogram / (Math.abs(ind.macd.macd) || 1),
        `MACD histogram ${ind.macd.histogram >= 0 ? 'positive' : 'negative'}`);
    }
    if (ind.roc10 != null) add('roc10', 0.9, ind.roc10 / 8, `10-bar change ${ind.roc10.toFixed(2)}%`);
    if (ind.roc20 != null) add('roc20', 0.7, ind.roc20 / 15, `20-bar change ${ind.roc20.toFixed(2)}%`);

    // Location within the Bollinger channel.
    if (ind.bollinger) {
      add('bbands', 0.8, (ind.bollinger.percentB - 0.5) * 2,
        `${(ind.bollinger.percentB * 100).toFixed(0)}% of the Bollinger range`);
    }

    // Conviction: heavy volume amplifies whatever the trend is doing.
    if (ind.volumeRatio != null && ind.roc5 != null) {
      add('volume', 0.6, Math.sign(ind.roc5) * Math.min(1, (ind.volumeRatio - 1) * 0.8),
        `Volume ${ind.volumeRatio.toFixed(2)}x its average`);
    }

    // Position in the longer-term range.
    if (ind.range) add('range', 0.5, (ind.range.position - 0.5) * 1.6,
      `${(ind.range.position * 100).toFixed(0)}% of the ${ind.range.lookback}-bar range`);

    if (!factors.length) return null;

    const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
    const raw = factors.reduce((s, f) => s + f.weight * f.value, 0) / totalWeight;

    // Weight actually evaluated, out of the full possible weight set.
    const MAX_WEIGHT = 9.3;
    const coverage = Math.min(1, totalWeight / MAX_WEIGHT);
    const strength = Math.min(1, Math.abs(raw) * 1.6);
    const confidence = Math.round(coverage * (0.45 + 0.55 * strength) * 100);

    const stance = raw > 0.28 ? 'strong bullish'
      : raw > 0.09 ? 'bullish'
        : raw < -0.28 ? 'strong bearish'
          : raw < -0.09 ? 'bearish' : 'neutral';

    return {
      score: raw,
      stance,
      confidence,
      direction: raw > 0.09 ? 1 : raw < -0.09 ? -1 : 0,
      factors: factors.sort((a, b) => Math.abs(b.weight * b.value) - Math.abs(a.weight * a.value)),
    };
  }

  PT.ta = {
    sma, smaSeries, ema, emaSeries, rsi, macd, bollinger, atr, roc,
    volumeRatio, realizedVol, rangePosition, analyze, score, closes,
  };
})(window.PT);
