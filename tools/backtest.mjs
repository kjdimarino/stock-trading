/**
 * Walk-forward backtest of the autonomous trader over real daily candles.
 *
 * At each bar the trader sees only the bars up to and including that day, and
 * trades at that day's close through the real engine — same order validation,
 * same cash accounting, same spread. Nothing about the future is visible, and
 * no trade is booked at a price that did not exist.
 *
 * Usage:  node tools/backtest.mjs [--split=train|test|all] [--json]
 */
import fs from 'node:fs';
import { loadPT } from '../test/harness.mjs';

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));

const { PT } = loadPT([
  'src/app/js/00-util.js', 'src/app/js/01-calendar.js', 'src/app/js/02-universe.js',
  'src/app/js/03-engine.js', 'src/app/js/04-indicators.js', 'src/app/js/07-ai.js',
]);
const E = PT.engine;
const T = PT.trader;

const data = JSON.parse(fs.readFileSync('test/fixtures/backtest-daily.json', 'utf8'));

/* Register every fixture symbol so the engine will price and trade it. */
for (const [id, a] of Object.entries(data.assets)) {
  PT.registerAsset({ id, name: id, kind: a.kind });
}

/*
 * A shared calendar of trading days. Assets do not share a bar grid — crypto
 * trades weekends, equities do not — so the walk is driven by the union of
 * timestamps, and each asset contributes only the bars it actually has.
 */
function buildTimeline() {
  const days = new Set();
  for (const a of Object.values(data.assets)) for (const b of a.bars) days.add(b.t);
  return [...days].sort((x, y) => x - y);
}

function sliceUpTo(bars, t) {
  // Bars are sorted; find how many are at or before t.
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const DEFAULT_RULES = { ...T.RULES };

/**
 * Run with a set of rule overrides. Defaults are restored first, so a sweep
 * cannot leak one variant's settings into the next.
 */
export function backtest({ split = 'all', warmup = 80, cash = 100000, seed = null, rules = null } = {}) {
  Object.assign(T.RULES, DEFAULT_RULES, rules || {});
  const timeline = buildTimeline();
  const start = Math.floor(timeline.length * (split === 'test' ? 0.5 : 0));
  const end = split === 'train' ? Math.floor(timeline.length * 0.5) : timeline.length;

  const pf = E.newPortfolio('ai', 'AI Trader', cash);
  const cooldowns = Object.create(null);
  const ids = Object.keys(data.assets);
  const cursors = Object.fromEntries(ids.map((id) => [id, 0]));

  const equityCurve = [];
  let peak = cash, maxDD = 0;
  let cycles = 0;

  for (let d = Math.max(start, warmup); d < end; d++) {
    const t = timeline[d];
    const prices = {};
    const candles = {};

    for (const id of ids) {
      const bars = data.assets[id].bars;
      const n = sliceUpTo(bars, t);
      cursors[id] = n;
      if (n < 30) continue;
      // The trader sees history through today's close, and nothing after it.
      candles[id] = bars.slice(Math.max(0, n - 260), n);
      prices[id] = { price: bars[n - 1].c, changePct: 0, t };
    }
    if (!Object.keys(prices).length) continue;

    const ctx = {
      now: t,
      prices,
      candles,
      candidates: seed ? seed(ids, d) : ids,
      cooldowns,
      marketOpen: true,        // daily bars: every bar in the set is a session
      slippageEnabled: true,   // pay the spread, as the live app does
      allowQueue: false,
    };

    T.runTraderCycle(pf, ctx);
    E.processOpenOrders(pf, ctx);
    cycles++;

    const val = E.valuate(pf, prices);
    equityCurve.push({ t, equity: val.equity });
    if (val.equity > peak) peak = val.equity;
    const dd = peak > 0 ? (peak - val.equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const last = equityCurve[equityCurve.length - 1];
  const finalEquity = last ? last.equity : cash;

  /* Daily returns, for risk-adjusted numbers. */
  const rets = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const a = equityCurve[i - 1].equity, b = equityCurve[i].equity;
    if (a > 0) rets.push(b / a - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const downside = rets.filter((r) => r < 0);
  const dsd = Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / (downside.length || 1));
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(252) : 0;

  /* Trade statistics from the fill log: a closing fill carries its realized P&L. */
  const closers = pf.fills.filter((f) => f.side === 'sell' && isFinite(f.realized) && f.realized !== 0);
  const wins = closers.filter((f) => f.realized > 0);
  const grossWin = wins.reduce((s, f) => s + f.realized, 0);
  const grossLoss = closers.filter((f) => f.realized < 0).reduce((s, f) => s - f.realized, 0);

  /* How much of the time was money actually at work? */
  const invested = equityCurve.length
    ? equityCurve.filter((_, i) => i >= 0).length : 0;

  return {
    split,
    days: equityCurve.length,
    cycles,
    startEquity: cash,
    finalEquity,
    returnPct: (finalEquity / cash - 1) * 100,
    maxDrawdownPct: maxDD * 100,
    sharpe,
    sortino,
    trades: pf.fills.length,
    closedTrades: closers.length,
    winRatePct: closers.length ? (wins.length / closers.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: closers.length - wins.length ? grossLoss / (closers.length - wins.length) : 0,
    openPositions: Object.keys(pf.positions).filter((k) => pf.positions[k].qty !== 0).length,
    equityCurve,
    invested,
  };
}

/** Equal-weight buy-and-hold of the same universe, as the honest yardstick. */
export function buyAndHold({ split = 'all', warmup = 80, cash = 100000 } = {}) {
  const timeline = buildTimeline();
  const start = Math.max(Math.floor(timeline.length * (split === 'test' ? 0.5 : 0)), warmup);
  const end = split === 'train' ? Math.floor(timeline.length * 0.5) : timeline.length;
  const ids = Object.keys(data.assets);

  const per = cash / ids.length;
  const held = {};
  for (const id of ids) {
    const bars = data.assets[id].bars;
    const n = sliceUpTo(bars, timeline[start]);
    if (n < 1) continue;
    held[id] = per / bars[n - 1].c;
  }

  const curve = [];
  let peak = cash, maxDD = 0;
  for (let d = start; d < end; d++) {
    const t = timeline[d];
    let eq = 0;
    for (const id in held) {
      const bars = data.assets[id].bars;
      const n = sliceUpTo(bars, t);
      if (n < 1) { eq += per; continue; }
      eq += held[id] * bars[n - 1].c;
    }
    curve.push({ t, equity: eq });
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const final = curve.length ? curve[curve.length - 1].equity : cash;
  const rets = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1));
  return {
    label: 'buy & hold (equal weight)',
    returnPct: (final / cash - 1) * 100,
    maxDrawdownPct: maxDD * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    days: curve.length,
  };
}

const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

export { PT, DEFAULT_RULES };

export function report(r) {
  console.log(`  return          ${pct(r.returnPct).padStart(9)}   (${r.startEquity.toLocaleString()} -> ${Math.round(r.finalEquity).toLocaleString()})`);
  console.log(`  max drawdown    ${('-' + r.maxDrawdownPct.toFixed(2) + '%').padStart(9)}`);
  console.log(`  sharpe          ${r.sharpe.toFixed(2).padStart(9)}`);
  console.log(`  sortino         ${r.sortino.toFixed(2).padStart(9)}`);
  console.log(`  trades          ${String(r.trades).padStart(9)}   (${r.closedTrades} closed)`);
  console.log(`  win rate        ${(r.winRatePct.toFixed(1) + '%').padStart(9)}`);
  console.log(`  profit factor   ${(isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞').padStart(9)}`);
  console.log(`  avg win / loss  ${('$' + r.avgWin.toFixed(0)).padStart(9)} / $${r.avgLoss.toFixed(0)}`);
  console.log(`  days            ${String(r.days).padStart(9)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const split = args.split || 'all';
  console.log(`\n── autonomous trader · ${split} ──`);
  const r = backtest({ split });
  report(r);
  const bh = buyAndHold({ split });
  console.log(`\n── ${bh.label} · ${split} ──`);
  console.log(`  return          ${pct(bh.returnPct).padStart(9)}`);
  console.log(`  max drawdown    ${('-' + bh.maxDrawdownPct.toFixed(2) + '%').padStart(9)}`);
  console.log(`  sharpe          ${bh.sharpe.toFixed(2).padStart(9)}`);
  if (args.json) console.log('\n' + JSON.stringify({ strategy: r, benchmark: bh }, null, 2));
}
