/**
 * Parameter sweep for the autonomous trader.
 *
 * Every candidate is chosen on the first half of the history and then checked
 * on the second half, which it never influenced. A setting that only looks good
 * on the half that picked it has told us nothing.
 */
import { backtest, DEFAULT_RULES } from './backtest.mjs';

const GRID = {
  useTrailingStop: [false, true],
  trailAtrMult: [2.0, 2.5, 3.0, 3.5, 4.5],
  stopAtrMult: [1.5, 2.0, 2.5, 3.0],
  riskPerTrade: [0.004, 0.006, 0.008, 0.012, 0.02],
  entryScore: [0.12, 0.18, 0.22, 0.28, 0.34],
  maxGroupWeight: [0.3, 0.45, 0.6, 1.0],
  breakevenAfterAtr: [1.0, 1.5, 2.5, 99],
  minHoldBars: [0, 1, 2, 3, 5],
  maxPositions: [5, 8, 12],
  maxWeightPerPosition: [0.1, 0.15, 0.22],
};
// Only read while the trailing stop is on; sweeping them with it off scores
// every value the same.
const TRAIL_ONLY = new Set(['trailAtrMult', 'breakevenAfterAtr']);

const base = { ...DEFAULT_RULES };
for (const k in GRID) if (!(k in base)) throw new Error(`unknown rule "${k}"`);
const fmt = (r) => `ret ${r.returnPct.toFixed(2).padStart(7)}%  dd ${r.maxDrawdownPct.toFixed(2).padStart(5)}%  `
  + `sharpe ${r.sharpe.toFixed(2).padStart(5)}  pf ${(isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'inf').padStart(5)}  trades ${String(r.trades).padStart(4)}`;

/*
 * Rank by return per unit of drawdown rather than raw return: a strategy that
 * makes 12% by risking a 30% hole is not better than one that makes 10% calmly,
 * and this is a practice account people watch daily.
 */
const objective = (r) => {
  if (r.closedTrades < 8) return -99;            // too few trades to mean anything
  return r.returnPct / Math.max(3, r.maxDrawdownPct);
};

// One knob at a time, keeping whatever won, so each move is attributable.
let current = { ...base };
for (const [key, values] of Object.entries(GRID)) {
  if (TRAIL_ONLY.has(key) && !current.useTrailingStop) {
    console.log(`\n${key}: skipped, the trailing stop is off`);
    continue;
  }
  const rows = [];
  // The incumbent is always scored, and only a strict improvement replaces
  // it: a tie means the knob made no difference, not that it should move.
  const tried = values.includes(current[key]) ? values : [current[key], ...values];
  for (const v of tried) {
    const rules = { ...current, [key]: v };
    const r = backtest({ split: 'train', rules });
    rows.push({ v, sc: objective(r), r });
  }
  let best = rows.find((row) => row.v === current[key]);
  for (const row of rows) if (row.sc > best.sc) best = row;
  console.log(`\n${key}:`);
  for (const row of rows) {
    console.log(`  ${String(row.v).padStart(10)}  ${fmt(row.r)}  score ${row.sc.toFixed(3)}${row.v === best.v ? '  <=' : ''}`);
  }
  current[key] = best.v;
}

console.log('\n\nchosen on train:');
for (const k in current) if (current[k] !== base[k]) console.log(`  ${k}: ${base[k]} -> ${current[k]}`);

for (const split of ['train', 'test', 'all']) {
  const b = backtest({ split, rules: base });
  const c = backtest({ split, rules: current });
  console.log(`\n${split}`);
  console.log(`  before  ${fmt(b)}`);
  console.log(`  after   ${fmt(c)}`);
}
console.log('\n' + JSON.stringify(current, null, 2));
