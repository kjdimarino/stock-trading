/**
 * The autonomous trader, measured rather than asserted.
 *
 * Walk-forward over real daily candles for 33 names: at every bar the strategy
 * sees only the history up to that bar and trades at that bar's close through
 * the real engine, paying the same spread the live app charges. Nothing here
 * can see the future.
 *
 * The thresholds are floors, set well below what the strategy currently does,
 * so ordinary variation does not fail the build — but a change that guts the
 * risk rules will. Both halves are checked separately: a strategy that only
 * works on the half it was designed against has proved nothing.
 */
import fs from 'node:fs';
import { describe, it, ok, report } from './harness.mjs';

const FIXTURE = 'test/fixtures/backtest-daily.json';
const haveFixture = fs.existsSync(FIXTURE);

let backtest, buyAndHold;
if (haveFixture) ({ backtest, buyAndHold } = await import('../tools/backtest.mjs'));

describe('autonomous trader, walked forward over real history', () => {
  if (!haveFixture) {
    it('skipped: no backtest fixture in this checkout', () => ok(true));
  } else {
    const all = backtest({ split: 'all' });
    const train = backtest({ split: 'train' });
    const test = backtest({ split: 'test' });
    const bh = buyAndHold({ split: 'all' });

    it('actually trades', () => {
      ok(all.trades > 40, `only ${all.trades} trades in ${all.days} days`);
      ok(all.closedTrades > 15, `only ${all.closedTrades} round trips`);
    });

    it('beats holding the same universe', () => {
      ok(all.returnPct > bh.returnPct,
        `strategy ${all.returnPct.toFixed(2)}% vs buy & hold ${bh.returnPct.toFixed(2)}%`);
    });

    it('takes less drawdown than holding', () => {
      ok(all.maxDrawdownPct < bh.maxDrawdownPct,
        `strategy -${all.maxDrawdownPct.toFixed(2)}% vs buy & hold -${bh.maxDrawdownPct.toFixed(2)}%`);
    });

    it('keeps the drawdown inside a limit a practice account can watch', () => {
      ok(all.maxDrawdownPct < 20, `max drawdown was ${all.maxDrawdownPct.toFixed(2)}%`);
    });

    it('is profitable on both halves, not just the one it was tuned on', () => {
      ok(train.returnPct > 0, `first half returned ${train.returnPct.toFixed(2)}%`);
      ok(test.returnPct > 0, `second half returned ${test.returnPct.toFixed(2)}%`);
    });

    it('earns more on its winners than it loses on its losers', () => {
      // A low win rate is expected and fine for a trend system; the payoff
      // ratio is what has to hold.
      ok(all.avgWin > all.avgLoss * 2,
        `avg win $${all.avgWin.toFixed(0)} vs avg loss $${all.avgLoss.toFixed(0)}`);
      ok(all.profitFactor > 1.2, `profit factor ${all.profitFactor.toFixed(2)}`);
    });

    it('is positive on a risk-adjusted basis on both halves', () => {
      ok(train.sharpe > 0, `first-half sharpe ${train.sharpe.toFixed(2)}`);
      ok(test.sharpe > 0, `second-half sharpe ${test.sharpe.toFixed(2)}`);
    });

    it('never blows up the account', () => {
      ok(all.finalEquity > 0 && isFinite(all.finalEquity), `final equity ${all.finalEquity}`);
      for (const p of all.equityCurve) ok(isFinite(p.equity) && p.equity > 0, `equity went to ${p.equity}`);
    });
  }
});

await report('strategy');
