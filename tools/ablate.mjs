/**
 * Ablation: turn each structural change off in turn and see what it was worth.
 * Reported on both halves, because a change that only helps the half it was
 * designed against is not a change worth keeping.
 */
import { backtest, DEFAULT_RULES } from './backtest.mjs';

const VARIANTS = [
  ['full strategy', {}],
  ['no trend filter', { requireTrend: false }],
  ['no trailing stop (fixed ATR stop)', { useTrailingStop: false }],
  ['no breakeven floor', { breakevenAfterAtr: 1e9 }],
  ['one entry per cycle', { maxEntriesPerCycle: 1 }],
  ['no group cap', { maxGroupWeight: 1 }],
  ['flat 8% stop (no ATR)', { stopAtrMult: 0, useTrailingStop: false }],
];

const row = (label, r) => `${label.padEnd(34)} ret ${r.returnPct.toFixed(2).padStart(7)}%  `
  + `dd ${r.maxDrawdownPct.toFixed(2).padStart(5)}%  sharpe ${r.sharpe.toFixed(2).padStart(5)}  `
  + `pf ${(isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'inf').padStart(5)}  `
  + `wins ${r.winRatePct.toFixed(0).padStart(3)}%  trades ${String(r.trades).padStart(4)}`;

for (const split of ['train', 'test', 'all']) {
  console.log(`\n──────── ${split} ────────`);
  for (const [label, rules] of VARIANTS) {
    console.log(row(label, backtest({ split, rules: { ...DEFAULT_RULES, ...rules } })));
  }
}
