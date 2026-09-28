/* =========================================================================
   AI features.

   Two independent pieces:
     PT.companion — an analyst panel. By default it is a *computed* engine:
       every sentence it writes is derived from indicators calculated from real
       candles, and it says so. If the server has an ANTHROPIC_API_KEY it can
       optionally hand the same computed evidence to a language model for
       richer prose — and it labels that too.
     PT.trader — an autonomous, deterministic strategy trading its own paper
       portfolio on a visible schedule, logging its reasoning for every
       decision including the decisions not to trade.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const TA = PT.ta;

  /* ===================================================================
     Knowledge base — plain-language explanations of trading concepts.
     =================================================================== */
  const CONCEPTS = {
    'market order': 'A market order buys or sells immediately at whatever the current price is. You get certainty that it fills, but not certainty about the price — in a fast-moving market the fill can be worse than the quote you saw.',
    'limit order': 'A limit order sets the worst price you will accept: a buy limit only fills at or below your price, a sell limit only at or above it. You control the price but the order may never fill.',
    'stop loss': 'A stop loss is a pre-decided exit that caps how much you can lose on a position. Deciding it before you enter is the point — it removes the moment of panic from the decision.',
    'spread': 'The spread is the gap between the best bid (what buyers offer) and the best ask (what sellers want). You buy at the ask and sell at the bid, so the spread is a real cost you pay on every round trip.',
    'slippage': 'Slippage is the difference between the price you expected and the price you got. It grows with order size and with how fast the market is moving.',
    'liquidity': 'Liquidity is how easily you can trade size without moving the price. Liquid assets have tight spreads and deep books; illiquid ones gap around on small orders.',
    'volatility': 'Volatility measures how much a price swings around. High volatility means bigger moves in both directions — more opportunity and more risk, not just more upside.',
    'rsi': 'RSI (Relative Strength Index) compares the size of recent gains to recent losses on a 0–100 scale. Above 70 is conventionally "overbought" and below 30 "oversold" — but a strong trend can stay pinned at an extreme for a long time.',
    'macd': 'MACD subtracts a slow moving average from a fast one, then compares that line to its own average. When the fast line crosses above the slow one it signals strengthening momentum; the histogram shows how fast that is changing.',
    'moving average': 'A moving average smooths price into a trend line. Price above a rising average is the textbook definition of an uptrend; crossovers between a fast and slow average are common trend signals.',
    'bollinger bands': 'Bollinger Bands draw a moving average with bands two standard deviations above and below. Price tends to spend most of its time inside them, so touches of the edge flag unusual moves — and narrow bands often precede big ones.',
    'atr': 'ATR (Average True Range) is the average distance a price travels in a period, including gaps. It is the standard way to size a stop loss in units the asset actually moves.',
    'volume': 'Volume is how much traded in a period. A price move on heavy volume carries more conviction than the same move on thin volume.',
    'market cap': 'Market cap is share price times shares outstanding — the market\'s price for the whole company. It is the right way to compare company size; share price alone tells you nothing.',
    'p/e ratio': 'The P/E ratio divides share price by earnings per share: what you pay for each dollar of profit. High P/E means the market expects growth; low P/E can mean value or trouble.',
    'etf': 'An ETF is a fund that trades like a single stock while holding a basket underneath. SPY holds the S&P 500, so buying one share spreads you across 500 companies.',
    'dca': 'Dollar-cost averaging means buying a fixed dollar amount on a schedule instead of all at once. It removes the need to time the market and smooths your average entry price.',
    'diversification': 'Diversification spreads risk across positions that do not move together. Holding ten tech stocks is far less diversified than it looks, because they tend to fall together.',
    'fractional shares': 'Fractional shares let you buy a slice of one share, so a $500 stock is reachable with $25. It makes position sizing by dollars possible regardless of share price.',
    'bid and ask': 'The bid is the highest price a buyer will pay; the ask is the lowest a seller will take. Your market buy hits the ask, your market sell hits the bid.',
    'unrealized p&l': 'Unrealized P&L is profit or loss on positions you still hold — it moves with every tick and is not locked in. Realized P&L is what you actually booked by selling.',
    'realized p&l': 'Realized P&L is the profit or loss you locked in when you closed a position. It cannot change afterwards, unlike unrealized P&L.',
    'cost basis': 'Cost basis is the average price you paid for the shares you hold. Buying more at a different price shifts the average; selling does not.',
    'drawdown': 'Drawdown measures the drop from a portfolio\'s peak to its trough. Max drawdown is the worst such fall — it is the number that tells you whether you could actually have held on.',
    'win rate': 'Win rate is the share of closed trades that made money. On its own it is misleading: a 30% win rate is excellent if the winners are much larger than the losers.',
    'risk/reward': 'Risk/reward compares what you stand to lose to what you stand to gain. Risking $1 to make $3 means you can be wrong most of the time and still come out ahead.',
    'position sizing': 'Position sizing decides how much to put into a trade. It matters more than entry timing — sizing controls how much a single wrong call can cost you.',
    'market hours': 'US stock exchanges trade 9:30am–4:00pm Eastern on weekdays, minus holidays. Crypto never closes, which is why it keeps moving while stocks are shut.',
    'paper trading': 'Paper trading practises with simulated money against real prices. The mechanics and the math are real; the pressure of risking your own money is not, which is the one thing it cannot teach.',
    'short selling': 'Short selling bets on a price falling by selling borrowed shares first. Losses are theoretically unlimited because a price can keep rising. Your account can short, against margin collateral and with a forced buy-in if the position runs too far, and it can be switched off in Settings; the autonomous AI trader stays long-only.',
  };

  // Longest first, so "unrealized p&l" wins over "realized p&l".
  const TERMS = Object.keys(CONCEPTS).sort((a, b) => b.length - a.length);
  // A whole term, optionally plural ("limit orders"), never part of a word.
  const termPattern = (term) => {
    const escaped = term.replace(/[.*+?^$(){}|[\]\\/]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}(s|es)?([^a-z0-9]|$)`);
  };
  const TERM_RE = Object.fromEntries(TERMS.map((t) => [t, termPattern(t)]));

  function explainConcept(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return null;
    if (CONCEPTS[q]) return { term: q, text: CONCEPTS[q] };
    /*
     * Whole terms only, so "what is rsi?" finds "rsi" but "diversification"
     * does not, and "moving", "and" or "position" inside an ordinary question
     * cannot hand it to the glossary instead of the portfolio or the scan.
     */
    for (const term of TERMS) {
      if (TERM_RE[term].test(q)) return { term, text: CONCEPTS[term] };
    }
    // A single bare word may name a term by its start: "bollinger".
    if (/^[a-z0-9&/]{3,}$/.test(q)) {
      for (const term of TERMS) if (term.startsWith(q)) return { term, text: CONCEPTS[term] };
    }
    return null;
  }

  /* ===================================================================
     Portfolio analytics
     =================================================================== */

  /**
   * Concentration via the Herfindahl-Hirschman Index over position weights.
   * 1.0 means everything sits in a single position.
   */
  function concentration(positions, equity, gross) {
    if (!positions.length || equity <= 0) return { hhi: 0, top: null, topWeight: 0, effectiveN: 0 };
    /*
     * HHI is measured against gross exposure: including cash makes a
     * one-stock book look perfectly diversified simply because it is mostly
     * uninvested. `topWeight` stays equity-relative, because there cash
     * genuinely does dilute single-name risk. Both use each position's size
     * regardless of side: a short is as much a bet as a long of the same size.
     */
    const base = gross > 0 ? gross : equity;
    let hhi = 0, topWeight = 0, top = null;
    for (const p of positions) {
      const size = Math.abs(p.value);
      const w = size / base;
      hhi += w * w;
      const eqWeight = size / equity;
      if (eqWeight > topWeight) { topWeight = eqWeight; top = p.assetId; }
    }
    return { hhi, top, topWeight, effectiveN: hhi > 0 ? 1 / hhi : 0 };
  }

  function analyzePortfolio(val, dayPnl, stats) {
    const positions = val.positions;
    const equity = val.equity;
    const gross = (val.longValue ?? val.invested ?? 0) + (val.shortValue || 0);
    const conc = concentration(positions, equity, gross);
    /*
     * The share of equity with no market exposure. Raw cash will not do: short
     * proceeds are credited to it, so a big short would read as a book that is
     * more than all cash. For a long-only book this is exactly cash / equity.
     */
    const cashWeight = equity > 0 ? U.clamp(1 - gross / equity, 0, 1) : 1;

    const bySector = {};
    const byKind = { stock: 0, etf: 0, crypto: 0 };
    for (const p of positions) {
      const a = PT.byId[p.assetId];
      const sector = a ? a.sector : 'Unknown';
      const size = Math.abs(p.value);
      bySector[sector] = (bySector[sector] || 0) + size;
      byKind[p.kind] = (byKind[p.kind] || 0) + size;
    }

    const sorted = positions.slice().sort((a, b) => b.unrealizedPct - a.unrealizedPct);
    const winner = sorted[0] && sorted[0].unrealized > 0 ? sorted[0] : null;
    const loser = sorted[sorted.length - 1] && sorted[sorted.length - 1].unrealized < 0
      ? sorted[sorted.length - 1] : null;

    // Diversification: more independent positions scores better, capped at the
    // 8-position target. Never above the number of positions actually held.
    const effectiveN = Math.min(conc.effectiveN, positions.length);
    const diversification = positions.length
      ? U.clamp(Math.round((effectiveN / 8) * 100), 0, 100) : 0;

    let risk = 'balanced';
    if (!positions.length) risk = 'uninvested';
    else if (conc.topWeight > 0.5) risk = 'highly concentrated';
    else if (conc.topWeight > 0.3) risk = 'concentrated';
    else if (cashWeight > 0.7) risk = 'defensive';
    else if (byKind.crypto / Math.max(1, equity) > 0.6) risk = 'crypto-heavy';

    return {
      equity, cashWeight, concentration: conc, bySector, byKind,
      winner, loser, diversification, risk, effectiveN,
      positionCount: positions.length,
      dayPnl, stats,
    };
  }

  /* ===================================================================
     Natural-language generation from computed evidence
     =================================================================== */

  const pick = (arr, seed) => arr[Math.abs(seed | 0) % arr.length];

  function describeStance(symbol, sig, ind, quote) {
    const s = sig.stance;
    const seed = symbol.charCodeAt(0) + Math.floor(Date.now() / 600000);
    const openers = {
      'strong bullish': [`${symbol} is showing strong upside momentum`, `${symbol} looks decisively bid`, `The trend in ${symbol} is firmly higher`],
      bullish: [`${symbol} is leaning bullish`, `${symbol} has a constructive setup`, `${symbol} is tilted to the upside`],
      neutral: [`${symbol} is range-bound`, `${symbol} has no clear directional edge right now`, `${symbol} is drifting without conviction`],
      bearish: [`${symbol} is leaning bearish`, `${symbol} is under some pressure`, `${symbol} is tilted to the downside`],
      'strong bearish': [`${symbol} is under heavy pressure`, `${symbol} is decisively offered`, `The trend in ${symbol} is firmly lower`],
    };
    return `${pick(openers[s] || openers.neutral, seed)} (${sig.confidence}% confidence).`;
  }

  /**
   * Minimum bars before this panel will state a view. Below this the indicator
   * set is too sparse for the score to mean anything, and a confident-sounding
   * stance built on one weak factor would be worse than saying nothing.
   */
  const MIN_BRIEF_BARS = 30;

  /**
   * Bars per year for each timeframe, so annualised volatility means something.
   * US equities trade ~252 days a year, 6.5h (23,400s) a day. Crypto never
   * closes, so its bars-per-year is the full calendar at every timeframe.
   */
  const BARS_PER_YEAR = {
    equity: {
      '1s': 252 * 23400, '5s': 252 * 4680, '15s': 252 * 1560,
      '1m': 252 * 390, '5m': 252 * 78, '15m': 252 * 26,
      '1h': 252 * 7, '1D': 252, '1W': 52,
    },
    crypto: {
      '1s': 365 * 86400, '5s': 365 * 17280, '15s': 365 * 5760,
      '1m': 365 * 1440, '5m': 365 * 288, '15m': 365 * 96,
      '1h': 365 * 24, '1D': 365, '1W': 52,
    },
  };

  /** Build a companion briefing for one asset entirely from computed values. */
  function briefAsset(assetId, bars, quote, tf) {
    const asset = PT.byId[assetId];
    if (!asset) return null;
    const perYear = BARS_PER_YEAR[asset.kind === 'crypto' ? 'crypto' : 'equity'][tf] || 252;
    const ind = bars && bars.length >= MIN_BRIEF_BARS ? TA.analyze(bars, perYear) : null;
    const sig = ind ? TA.score(ind) : null;
    if (!ind || !sig) {
      const have = bars ? bars.length : 0;
      return {
        assetId,
        headline: `Not enough price history for ${assetId} yet.`,
        body: [`Waiting on more candles before drawing any conclusions — ${have} of the ${MIN_BRIEF_BARS} needed. `
          + 'The feed is connected; this panel fills in as bars accumulate.'],
        signal: null, indicators: null, computed: true,
      };
    }
    // Computed once and used as the headline only — repeating it as the first
    // bullet made every briefing open by saying the same thing twice.
    const headline = describeStance(assetId, sig, ind, quote);
    const body = [];

    if (quote && isFinite(quote.changePct)) {
      const dir = quote.changePct >= 0 ? 'up' : 'down';
      // Crypto change is a true rolling 24h; equities are measured from the
      // previous close, which over a weekend is a great deal more than 24h.
      const window = asset.kind === 'crypto' ? 'over the last 24h' : 'since the previous close';
      body.push(`It is ${dir} ${U.fmtPctAbs(quote.changePct)} ${window}, last trading at ${U.fmtUSD(quote.price)}.`);
    }

    if (ind.rsi14 != null) {
      const r = ind.rsi14;
      const note = r > 70 ? 'stretched to the upside — momentum is strong but the move is extended'
        : r < 30 ? 'stretched to the downside — sellers are in control but it is getting oversold'
          : r > 55 ? 'in healthy bullish territory' : r < 45 ? 'in mildly bearish territory' : 'right at the midpoint';
      body.push(`RSI(14) sits at ${r.toFixed(1)}, ${note}.`);
    }

    if (ind.sma20 != null && ind.sma50 != null) {
      const above20 = ind.last >= ind.sma20;
      const golden = ind.sma20 >= ind.sma50;
      body.push(`Price is ${above20 ? 'above' : 'below'} its 20-period average (${U.fmtUSD(ind.sma20)}) and the 20 sits ${golden ? 'above' : 'below'} the 50 (${U.fmtUSD(ind.sma50)}) — ${golden ? 'the classic uptrend alignment' : 'a downtrend alignment'}.`);
    }

    if (ind.macd) {
      const h = ind.macd.histogram;
      const prev = ind.macd.prevHistogram;
      const flipped = prev != null && Math.sign(h) !== Math.sign(prev);
      body.push(`MACD histogram is ${h >= 0 ? 'positive' : 'negative'} at ${h.toFixed(4)}${flipped ? ' and just flipped, which often marks a momentum turn' : ''}.`);
    }

    if (ind.atrPct != null) {
      const v = ind.atrPct;
      const label = v > 5 ? 'very volatile' : v > 2.5 ? 'volatile' : v > 1 ? 'moderately active' : 'quiet';
      body.push(`Average true range is ${v.toFixed(2)}% of price — ${label}. A stop tighter than that will get hit by noise alone.`);
    }

    if (ind.volumeRatio != null && ind.volumeRatio > 1.5) {
      body.push(`Volume is running ${ind.volumeRatio.toFixed(1)}x its recent average, which adds conviction to the current move.`);
    }

    if (ind.range) {
      body.push(`It is trading at ${(ind.range.position * 100).toFixed(0)}% of its recent range (${U.fmtUSD(ind.range.low)} – ${U.fmtUSD(ind.range.high)}).`);
    }

    return {
      assetId,
      headline,
      body,
      signal: sig,
      indicators: ind,
      tf: tf || null,
      computed: true,
    };
  }

  /** Portfolio briefing. */
  function briefPortfolio(pa, val) {
    const body = [];
    const eq = val.equity;

    if (!pa.positionCount) {
      body.push(`You are holding ${U.fmtUSD(val.cash)} in cash and no positions. Nothing is at risk, and nothing is working for you either.`);
      body.push('Pick something from the watchlist to see a full breakdown here once you have a position.');
      return { headline: 'Fully in cash', body, computed: true };
    }

    const rp = val.totalReturnPct;
    body.push(`Your book is worth ${U.fmtUSD(eq)} across ${pa.positionCount} position${pa.positionCount === 1 ? '' : 's'}, ${rp >= 0 ? 'up' : 'down'} ${U.fmtPctAbs(rp)} since you started.`);
    body.push(`Unrealized P&L is ${U.fmtSigned(val.unrealized)} (${U.fmtPct(val.unrealizedPct)}) and you have booked ${U.fmtSigned(val.realized)} in realized gains.`);

    if (pa.dayPnl) {
      body.push(`Today you are ${pa.dayPnl.change >= 0 ? 'up' : 'down'} ${U.fmtUSD(Math.abs(pa.dayPnl.change))} (${U.fmtPctAbs(pa.dayPnl.changePct)}).`);
    }

    const c = pa.concentration;
    if (c.topWeight > 0.4) {
      const topRow = val.positions.find((p) => p.assetId === c.top);
      const name = topRow && topRow.value < 0 ? `your ${c.top} short` : c.top;
      body.push(`Heads up on concentration: ${name} alone is ${(c.topWeight * 100).toFixed(0)}% of your equity. A bad day in one name would move your whole book.`);
    } else if (pa.positionCount >= 4 && c.topWeight < 0.3) {
      body.push(`Position sizing looks reasonable — your largest holding, ${c.top}, is ${(c.topWeight * 100).toFixed(0)}% of equity.`);
    }

    if (pa.cashWeight > 0.75) {
      body.push(`You are ${(pa.cashWeight * 100).toFixed(0)}% cash, so most of your account is sitting out of the market.`);
    } else if (pa.cashWeight < 0.05) {
      body.push(`You are almost fully invested (${(pa.cashWeight * 100).toFixed(0)}% cash), which leaves little room to act on a new idea.`);
    }

    if (pa.winner) {
      body.push(`Best position: ${pa.winner.assetId} at ${U.fmtPct(pa.winner.unrealizedPct)} (${U.fmtSigned(pa.winner.unrealized)}).`);
    }
    if (pa.loser) {
      body.push(`Worst position: ${pa.loser.assetId} at ${U.fmtPct(pa.loser.unrealizedPct)} (${U.fmtSigned(pa.loser.unrealized)}).`);
    }

    const cryptoW = eq > 0 ? (pa.byKind.crypto || 0) / eq : 0;
    if (cryptoW > 0.5) {
      body.push(`Crypto is ${(cryptoW * 100).toFixed(0)}% of your book. It trades around the clock, so this account keeps moving after the stock market closes.`);
    }

    if (val.shortValue > 0) {
      body.push(`You are short ${U.fmtUSD(val.shortValue)}, ${eq > 0 ? ((val.shortValue / eq) * 100).toFixed(0) : '—'}% of equity. A short loses as the price rises, and there is no ceiling on how far that can go.`);
    }

    // Closed, not sells: opening a short is a sell, and covering one is a buy.
    if (pa.stats && pa.stats.winRate != null) {
      body.push(`Across ${pa.stats.closed} closed trade${pa.stats.closed === 1 ? '' : 's'} your win rate is ${pa.stats.winRate.toFixed(0)}%${pa.stats.profitFactor && isFinite(pa.stats.profitFactor) ? `, with a profit factor of ${pa.stats.profitFactor.toFixed(2)}` : ''}.`);
    }

    return {
      headline: `${U.fmtUSD(eq)} · ${U.fmtPct(rp)} total return`,
      body, computed: true, risk: pa.risk, diversification: pa.diversification,
    };
  }

  /** Rank watchlist assets by computed signal strength. */
  function scanMovers(entries) {
    const scored = [];
    for (const e of entries) {
      if (!e.bars || e.bars.length < 30) continue;
      const ind = TA.analyze(e.bars);
      const sig = ind ? TA.score(ind) : null;
      if (!sig) continue;
      scored.push({ assetId: e.assetId, signal: sig, indicators: ind, quote: e.quote });
    }
    scored.sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score));
    return scored;
  }

  /* ===================================================================
     Optional LLM upgrade
     =================================================================== */

  async function llmAvailable() {
    try {
      const r = await fetch('/api/health');
      const j = await r.json();
      return !!(j.llm && j.llm.available);
    } catch { return false; }
  }

  /**
   * Hand the *computed* evidence to a model for prose. The model is explicitly
   * forbidden from inventing numbers — it may only restate what we measured.
   */
  async function llmCommentary(question, evidence) {
    const res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        max_tokens: 700,
        system: 'You are a concise trading assistant inside a PAPER trading app. '
          + 'You are given precomputed indicator values as JSON evidence. Use ONLY those numbers — '
          + 'never invent a price, statistic or news event. If the evidence does not answer the question, say so. '
          + 'Be direct and specific, 120 words or fewer, no disclaimers about being an AI. '
          + 'Never tell the user what to buy or sell; describe what the data shows.',
        messages: [{ role: 'user', content: `Evidence:\n${JSON.stringify(evidence, null, 1)}\n\nQuestion: ${question}` }],
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.message || j.error || `HTTP ${res.status}`);
    const text = (j.content || []).map((b) => b.text || '').join('').trim();
    if (!text) throw new Error('empty model response');
    return text;
  }

  PT.companion = {
    CONCEPTS, explainConcept, analyzePortfolio, briefAsset, briefPortfolio,
    scanMovers, concentration, llmAvailable, llmCommentary,
  };

  /* ===================================================================
     Autonomous AI trader
     =================================================================== */

  const RULES = {
    intervalMs: 60000,        // one decision cycle per minute
    candidatesPerCycle: 5,    // rotate, to stay polite to upstream data sources
    maxPositions: 8,
    maxWeightPerPosition: 0.15,
    minCashReserve: 0.10,     // never deploy the last 10% of equity
    minOrderValue: 25,
    entryScore: 0.22,         // conviction needed to open
    addScore: 0.34,           // conviction needed to add to a winner
    exitScore: -0.12,         // conviction at which to close
    stopAtrMult: 2.5,
    // A fixed-percentage stop in place of the ATR one, when set. Off: it exists
    // so tools/ablate.mjs can measure what sizing stops by ATR is worth.
    flatStopPct: null,
    hardStopPct: -10,
    cooldownMs: 10 * 60000,   // per-symbol pause after any trade
    maxTradesPerDay: 25,
    minBars: 60,

    /*
     * A trailing stop instead of a fixed profit target. The old rule sold every
     * winner at 4x ATR or +22%, which caps exactly the trades that pay for the
     * losers — and this is a low-win-rate trend system, so it lives on them. The
     * stop now ratchets up behind the highest close since entry and never falls.
     */
    /*
     * Off by default, and that is a measured choice rather than an oversight.
     * Backtested over 33 names and 306 days, these settings took the return
     * from about 20% to about 9% and deepened the drawdown. Most of that is
     * the breakeven floor: this system's winners are few and large, and many
     * dip back to entry on the way. The trail alone never fired at 5 ATR or
     * wider and cost about 4 points at 3. The rule is kept, and correct, for
     * anyone who would rather cap giveback than maximise return. See
     * tools/ablate.mjs.
     */
    useTrailingStop: false,
    trailAtrMult: 3.0,
    // The trail arms only once the trade has been this far ahead. Below it the
    // base stop rules, so a normal pullback on the way up is not cut short.
    trailActivateAtr: 1.0,
    // Once a trade has been this far ahead in ATR terms, the stop moves to
    // entry: a winner is not allowed to become a loser.
    breakevenAfterAtr: 1.5,

    // Exit when the entry condition fails, not only when a stop is hit.
    exitBelowTrend: true,

    // Only buy what is already trending. The score leans bullish in a downtrend
    // whenever momentum ticks up, and buying those was most of the bleed.
    requireTrend: true,

    /*
     * Size by risk, not by conviction alone: a position is sized so that being
     * stopped out costs about this share of equity. A volatile name therefore
     * gets fewer dollars automatically, without a hand-tuned penalty.
     */
    riskPerTrade: 0.008,

    // Deploy at a sensible pace instead of one name per cycle.
    maxEntriesPerCycle: 2,
    // Add to a position that is working, up to the per-position weight cap.
    allowPyramiding: true,
    /*
     * How far ahead, in ATRs, before a position earns more money. Three is
     * deliberately demanding. Looser settings made far more on the second half
     * of the backtest and lost money on the first; three was the only one that
     * improved both halves against no pyramiding at all, which is the bar a
     * setting has to clear here — a rule that only works in the sample that
     * chose it has told us nothing.
     */
    addMinGainAtr: 3.0,

    /*
     * Crypto moves as one block, so eight "different" coins is one bet. Cap what
     * any correlated group can own between them.
     */
    maxGroupWeight: 0.45,

    /*
     * Give a new position room to breathe before a wobble in the score closes
     * it. Counted in bars, not wall-clock: the live trader decides on 15m
     * candles and the backtest on daily ones, and "two days" would mean two
     * bars in one and nearly two hundred in the other. Stops still apply from
     * the first bar; this only gates the softer signal and trend exits.
     */
    minHoldBars: 2,
  };

  /** Is this name actually trending up, rather than merely bouncing? */
  function inUptrend(ind) {
    if (!ind) return false;
    if (ind.sma50 != null && ind.last != null && ind.last < ind.sma50) return false;
    if (ind.sma20 != null && ind.sma50 != null && ind.sma20 < ind.sma50) return false;
    return true;
  }

  /** Total weight of one correlated group (crypto moves as a single bet). */
  function groupWeight(val, isCrypto) {
    if (!(val.equity > 0)) return 0;
    let v = 0;
    for (const p of val.positions) {
      if (PT.isCrypto(p.assetId) === isCrypto) v += Math.abs(p.exposure || 0);
    }
    return v / val.equity;
  }

  /**
   * One decision cycle. Pure with respect to its inputs: it is handed the
   * portfolio, live quotes and candle data, and returns the decisions it made.
   * Every decision — including holds — is logged with the numbers behind it.
   */
  /**
   * Trade bookkeeping the engine has no business knowing about: the high-water
   * mark a trailing stop hangs off, and when each position was opened.
   *
   * It is rebuilt lazily rather than trusted, because `repair()` reconstructs
   * positions from the fill log and would leave this stale. A missing peak
   * starts at the current price, so a trailing stop can only ever fire on a
   * decline that happened after we started watching — never on old history.
   */
  function traderState(pf) {
    const st = pf.aiState || (pf.aiState = {});
    st.peaks = st.peaks || {};
    st.openedAt = st.openedAt || {};
    return st;
  }

  function runTraderCycle(pf, ctx) {
    const now = ctx.now || Date.now();
    const decisions = [];
    const val = PT.engine.valuate(pf, ctx.prices);
    const equity = val.equity;
    const st = traderState(pf);

    /* Ratchet the high-water marks before anything reads them. */
    for (const pos of val.positions) {
      const q = ctx.prices[pos.assetId];
      if (!q || !isFinite(q.price)) continue;
      st.peaks[pos.assetId] = Math.max(st.peaks[pos.assetId] || q.price, q.price);
      if (st.openedAt[pos.assetId] == null) st.openedAt[pos.assetId] = pos.openedAt || now;
    }
    // Forget names we no longer hold, so a re-entry starts clean.
    const stillHeld = new Set(val.positions.map((p) => p.assetId));
    for (const id in st.peaks) if (!stillHeld.has(id)) { delete st.peaks[id]; delete st.openedAt[id]; }

    // Bucket by the Eastern trading date, the same clock day P&L uses. A UTC
    // bucket would roll over at 19:00 ET and let crypto trade the cap twice.
    const todayKey = PT.calendar.etDateOf(now);
    const tradesToday = pf.fills.filter((f) => PT.calendar.etDateOf(f.t) === todayKey).length;
    // Mutable: it must fall as this cycle spends it, or a single cycle can
    // blow straight through the daily cap.
    let budgetLeft = RULES.maxTradesPerDay - tradesToday;

    const log = (action, assetId, why, factors, extra) => {
      const entry = {
        id: U.uid('dec'), t: now, action, assetId, why,
        factors: factors || [], ...extra,
      };
      decisions.push(entry);
      return entry;
    };

    /* ---------------------------------------------------- exits first */
    for (const pos of val.positions) {
      const assetId = pos.assetId;
      const series = ctx.candles[assetId];
      const quote = ctx.prices[assetId];
      if (!quote || !isFinite(quote.price)) continue;

      const isCrypto = PT.isCrypto(assetId);
      if (!isCrypto && !ctx.marketOpen) continue;

      const ind = series && series.length >= 20 ? TA.analyze(series) : null;
      const sig = ind ? TA.score(ind) : null;
      const pnlPct = pos.unrealizedPct;

      let reason = null;
      const factors = [];
      const price = quote.price;
      const atr = ind && isFinite(ind.atr14) ? ind.atr14 : null;
      const peak = Math.max(st.peaks[assetId] || price, price);
      /*
       * Bars opened since the entry, counted off the series itself, so the
       * hold gate scales with the timeframe the trader happens to be reading.
       * Measuring time against the last gap instead would take an overnight or
       * weekend gap for the bar width on the first bar of every session.
       */
      const openedAt = st.openedAt[assetId] ?? now;
      let barsHeld = 0;
      if (series) for (const b of series) if (b.t > openedAt) barsHeld++;
      const seasoned = barsHeld >= RULES.minHoldBars;

      if (atr != null && pos.avgCost > 0) {
        /*
         * The base stop sits a fixed number of ATRs below the entry and is
         * always in force. The trail can only ever *raise* it — never lower it.
         * That distinction matters: a trail measured from the peak while the
         * trade is still underwater is simply a tighter stop, and firing it
         * early is how a system stops out of the drawdowns that precede its
         * winners. It arms only once the trade is genuinely ahead.
         */
        const baseStop = RULES.flatStopPct > 0
          ? pos.avgCost * (1 - RULES.flatStopPct)
          : pos.avgCost - RULES.stopAtrMult * atr;
        let stopPrice = baseStop;
        /*
         * Armed by how far ahead the trade has *been*, not where it is now:
         * gated on the current price, the breakeven floor could only ever sit
         * below the market, and a gap under the arming level disarmed the trail.
         */
        const peakAheadAtr = atr > 0 ? (peak - pos.avgCost) / atr : 0;
        let trailing = false;

        if (RULES.useTrailingStop && peakAheadAtr >= RULES.trailActivateAtr) {
          const trail = peak - RULES.trailAtrMult * atr;
          if (trail > stopPrice) { stopPrice = trail; trailing = true; }
          if (peakAheadAtr >= RULES.breakevenAfterAtr && pos.avgCost > stopPrice) {
            stopPrice = pos.avgCost;      // a winner may not round-trip into a loss
            trailing = true;
          }
        }
        // Never above the market, or the position would close the instant it opened.
        stopPrice = Math.min(stopPrice, price);

        if (price <= stopPrice) {
          if (trailing) {
            const giveBack = peak > 0 ? ((peak - price) / peak) * 100 : 0;
            reason = `Trailing stop: locked in ${U.fmtPct(pnlPct)} after giving back ${giveBack.toFixed(1)}% from the high.`;
            factors.push({ k: 'peak', v: U.fmtUSD(peak) });
          } else if (RULES.flatStopPct > 0) {
            const stopPct = RULES.flatStopPct * 100;
            reason = `Stop hit: down ${U.fmtPct(pnlPct)}, beyond the flat ${stopPct.toFixed(1)}% stop.`;
            factors.push({ k: 'flat stop', v: `${stopPct.toFixed(1)}%` });
          } else {
            const stopPct = (RULES.stopAtrMult * atr / pos.avgCost) * 100;
            reason = `Stop hit: down ${U.fmtPct(pnlPct)}, beyond ${RULES.stopAtrMult}× ATR (${stopPct.toFixed(1)}%).`;
            factors.push({ k: 'ATR stop', v: `${stopPct.toFixed(1)}%` });
          }
          factors.push({ k: 'stop', v: U.fmtUSD(stopPrice) });
        }
      }

      if (!reason && pnlPct <= RULES.hardStopPct) {
        reason = `Hard stop: position is down ${U.fmtPct(pnlPct)}.`;
      }
      /*
       * The trend that justified the entry is gone. This is a different claim
       * from the blended score wobbling: price closing under its own 50-bar
       * average is the entry condition failing outright.
       */
      if (!reason && RULES.exitBelowTrend && ind && ind.sma50 != null && price < ind.sma50
          && seasoned) {
        reason = `Trend broke: price ${U.fmtUSD(price)} closed below its 50-bar average of ${U.fmtUSD(ind.sma50)}.`;
        factors.push({ k: 'SMA50', v: U.fmtUSD(ind.sma50) });
      }

      /*
       * A signal exit is the weakest of the three, so it waits: a position
       * closed on the first wobble pays the spread twice and never gets the
       * chance to work. Stops above are not gated — real risk is immediate.
       */
      if (!reason && sig && sig.score <= RULES.exitScore && seasoned) {
        reason = `Thesis broke down: signal turned ${sig.stance} (${sig.score.toFixed(2)}).`;
        factors.push({ k: 'signal', v: sig.score.toFixed(2) });
      }

      if (reason) {
        if (budgetLeft <= 0) {
          log('hold', assetId, `Would exit (${reason}) but the daily trade cap of ${RULES.maxTradesPerDay} is reached.`, factors);
          continue;
        }
        try {
          const r = PT.engine.submitOrder(pf, {
            assetId, side: 'sell', type: 'market', qty: pos.qty, reason,
          }, ctx);
          budgetLeft -= 1;
          log('sell', assetId, reason, factors, {
            qty: r.fill.qty, price: r.fill.price, realized: r.fill.realized,
            pnlPct, signal: sig ? sig.score : null, stance: sig ? sig.stance : null,
          });
          ctx.cooldowns[assetId] = now;
          delete st.peaks[assetId];
          delete st.openedAt[assetId];
        } catch (e) {
          log('error', assetId, `Exit rejected: ${e.message}`, factors);
        }
      }
    }

    /* -------------------------------------------------------- entries */
    // Re-value after the exit loop: positions closed above are gone, and using
    // the pre-exit set would report being at the position limit while flat.
    const freshVal = PT.engine.valuate(pf, ctx.prices);
    const held = new Set(freshVal.positions.map((p) => p.assetId));
    // Running totals for the rest of the cycle: both the add pass below and the
    // new-entry loop after it spend from the same budget and revalue as they go.
    let opened = 0;
    let workingVal = freshVal;
    const investable = freshVal.equity * (1 - RULES.minCashReserve);
    const deployed = freshVal.invested;

    /*
     * Adding to winners. A trend system makes its money on the few positions
     * that keep going, so a name that is working and still scores well gets
     * more — but only up to the same per-position cap, and only while it is in
     * profit, so this can never turn into averaging down.
     */
    if (RULES.allowPyramiding) {
      for (const pos of workingVal.positions) {
        if (budgetLeft <= 0) break;
        if (pos.qty <= 0) continue;
        if (!(pos.unrealizedPct > 0)) continue;
        const cd = ctx.cooldowns[pos.assetId];
        if (cd && now - cd < RULES.cooldownMs) continue;
        const isCrypto = PT.isCrypto(pos.assetId);
        if (!isCrypto && !ctx.marketOpen) continue;

        const series = ctx.candles[pos.assetId];
        if (!series || series.length < RULES.minBars) continue;
        const ind = TA.analyze(series);
        const sig = ind ? TA.score(ind) : null;
        if (!sig || sig.score < RULES.addScore) continue;
        if (RULES.requireTrend && !inUptrend(ind)) continue;
        /*
         * Add on demonstrated strength, not on a rounding error. The position
         * has to be ahead by a real move — measured in ATRs, so it means the
         * same thing on a quiet stock and a volatile coin.
         */
        const atrNow = isFinite(ind.atr14) ? ind.atr14 : null;
        if (atrNow != null && pos.avgCost > 0) {
          const aheadAtr = (ctx.prices[pos.assetId].price - pos.avgCost) / atrNow;
          if (aheadAtr < RULES.addMinGainAtr) continue;
        }

        const weight = (pos.weightPct || 0) / 100;
        const room = (RULES.maxWeightPerPosition - weight) * workingVal.equity;
        const groupRoom = Math.max(0, (RULES.maxGroupWeight - groupWeight(workingVal, isCrypto)) * workingVal.equity);
        const headroom = Math.max(0, workingVal.equity * (1 - RULES.minCashReserve) - workingVal.invested);
        let notional = Math.min(room, groupRoom, headroom, pf.cash * 0.95,
          workingVal.equity * RULES.maxWeightPerPosition * 0.5);
        notional = Math.floor(notional * 100) / 100;
        if (notional < RULES.minOrderValue) continue;

        const why = `Adding to ${pos.assetId}: up ${U.fmtPct(pos.unrealizedPct)} and still scoring `
          + `${sig.score.toFixed(2)} (${sig.stance}). Taking the position from `
          + `${(weight * 100).toFixed(1)}% to ${((weight * 100) + (notional / workingVal.equity) * 100).toFixed(1)}% of equity, `
          + `inside the ${(RULES.maxWeightPerPosition * 100).toFixed(0)}% cap.`;
        try {
          const r = PT.engine.submitOrder(pf, {
            assetId: pos.assetId, side: 'buy', type: 'market', notional, reason: why,
          }, ctx);
          budgetLeft -= 1;
          opened += 1;
          log('buy', pos.assetId, why, sig.factors.slice(0, 3).map((f) => ({ k: f.key, v: f.detail })), {
            qty: r.fill.qty, price: r.fill.price, notional: r.fill.notional,
            signal: sig.score, stance: sig.stance, confidence: sig.confidence, add: true,
          });
          ctx.cooldowns[pos.assetId] = now;
          workingVal = PT.engine.valuate(pf, ctx.prices);
        } catch (e) {
          log('error', pos.assetId, `Add rejected: ${e.message}`, []);
        }
      }
    }

    if (held.size >= RULES.maxPositions) {
      log('hold', null, `Holding at the ${RULES.maxPositions}-position limit; watching existing names for exits.`, []);
      return { decisions, valuation: freshVal };
    }
    if (deployed >= investable) {
      log('hold', null, `Cash reserve floor reached — keeping ${(RULES.minCashReserve * 100).toFixed(0)}% of equity uninvested.`, []);
      return { decisions, valuation: freshVal };
    }

    const ranked = [];
    let trendRejected = 0;
    for (const assetId of ctx.candidates) {
      if (held.has(assetId)) continue;
      const cd = ctx.cooldowns[assetId];
      if (cd && now - cd < RULES.cooldownMs) continue;
      const isCrypto = PT.isCrypto(assetId);
      if (!isCrypto && !ctx.marketOpen) continue;
      const series = ctx.candles[assetId];
      if (!series || series.length < RULES.minBars) continue;
      const quote = ctx.prices[assetId];
      if (!quote || !isFinite(quote.price)) continue;

      const ind = TA.analyze(series);
      const sig = ind ? TA.score(ind) : null;
      if (!sig) continue;

      /*
       * Trend gate. The blended score can read bullish on a name in a clear
       * downtrend whenever short-term momentum ticks up, and buying those was
       * where most of the losses came from. Price has to be above its 50-bar
       * average, with the 20 above the 50, before conviction is even consulted.
       */
      if (RULES.requireTrend && !inUptrend(ind)) { trendRejected++; continue; }

      ranked.push({ assetId, sig, ind, quote });
    }
    ranked.sort((a, b) => b.sig.score - a.sig.score);

    if (!ranked.length) {
      const why = ctx.marketOpen
        ? (trendRejected
          ? `No candidate cleared the evidence bar this cycle; ${trendRejected} were skipped for trading below their trend.`
          : 'No candidate cleared the evidence bar this cycle.')
        : 'US equities are closed; only crypto candidates were considered and none qualified.';
      log('hold', null, why, []);
      return { decisions, valuation: freshVal };
    }

    if (ranked[0].sig.score < RULES.entryScore) {
      const best = ranked[0];
      log('hold', best.assetId,
        `Best candidate ${best.assetId} scored ${best.sig.score.toFixed(2)} (${best.sig.stance}), below the ${RULES.entryScore} entry bar.`,
        best.sig.factors.slice(0, 3).map((f) => ({ k: f.key, v: f.detail })));
      return { decisions, valuation: freshVal };
    }

    /*
     * Size by risk. The stop distance is known before the trade — it is
     * `stopAtrMult` ATRs — so the position is sized so that being stopped out
     * costs `riskPerTrade` of equity. A volatile name therefore gets fewer
     * dollars than a calm one for the same conviction, without a separate
     * volatility fudge, and every open position carries roughly the same risk.
     */
    for (const cand of ranked) {
      if (opened >= RULES.maxEntriesPerCycle) break;
      if (cand.sig.score < RULES.entryScore) break;   // ranked, so the rest are worse
      if (budgetLeft <= 0) {
        log('hold', cand.assetId, `Daily trade cap of ${RULES.maxTradesPerDay} reached; standing down until tomorrow.`, []);
        break;
      }
      if (workingVal.positions.length >= RULES.maxPositions) break;

      const isCrypto = PT.isCrypto(cand.assetId);
      const gw = groupWeight(workingVal, isCrypto);
      if (gw >= RULES.maxGroupWeight) {
        log('hold', cand.assetId,
          `${cand.assetId} qualified but ${isCrypto ? 'crypto' : 'equities'} already account for `
          + `${(gw * 100).toFixed(0)}% of the book, at the ${(RULES.maxGroupWeight * 100).toFixed(0)}% group cap. `
          + 'They move together, so more of them is more of the same bet, not diversification.', []);
        continue;
      }

      const price = cand.quote.price;
      const atr = isFinite(cand.ind.atr14) ? cand.ind.atr14 : null;
      const stopDistance = RULES.flatStopPct > 0 ? price * RULES.flatStopPct
        : atr != null ? RULES.stopAtrMult * atr : price * 0.08;
      if (!(stopDistance > 0)) continue;

      const riskDollars = workingVal.equity * RULES.riskPerTrade;
      const byRisk = riskDollars * (price / stopDistance);

      // Conviction scales within the risk budget rather than replacing it.
      const conviction = U.clamp((cand.sig.score - RULES.entryScore) / (1 - RULES.entryScore), 0, 1);
      const sized = byRisk * (0.7 + 0.6 * conviction);

      const headroom = Math.max(0, workingVal.equity * (1 - RULES.minCashReserve) - workingVal.invested);
      const groupRoom = Math.max(0, (RULES.maxGroupWeight - gw) * workingVal.equity);
      let notional = Math.min(
        sized,
        workingVal.equity * RULES.maxWeightPerPosition,
        headroom,
        groupRoom,
        pf.cash * 0.95,
      );
      notional = Math.floor(notional * 100) / 100;

      if (notional < RULES.minOrderValue) {
        log('hold', cand.assetId,
          `${cand.assetId} qualified (${cand.sig.stance}) but the available size of ${U.fmtUSD(notional)} is below the ${U.fmtUSD(RULES.minOrderValue)} minimum.`, []);
        /*
         * Cash and headroom are shared, so if they are what ran short nothing
         * further down can fit either. The risk size and the group's room are
         * this name's own: a calmer name, or one from another group, may fit.
         */
        if (Math.floor(Math.min(headroom, pf.cash * 0.95) * 100) / 100 < RULES.minOrderValue) break;
        continue;
      }

      const factors = cand.sig.factors.slice(0, 4).map((f) => ({
        k: f.key, v: f.detail, dir: f.value > 0 ? 1 : f.value < 0 ? -1 : 0,
      }));
      const weightPct = workingVal.equity > 0 ? (notional / workingVal.equity) * 100 : 0;
      const stopPct = (stopDistance / price) * 100;
      const why = `${cand.assetId} scored ${cand.sig.score.toFixed(2)} (${cand.sig.stance}, ${cand.sig.confidence}% confidence) `
        + `and is trading above its 50-bar trend. Sizing ${weightPct.toFixed(1)}% of equity: `
        + `a ${stopPct.toFixed(1)}% stop on that position risks `
        + `${U.fmtUSD(notional * stopPct / 100)}, about ${(RULES.riskPerTrade * 100).toFixed(1)}% of the book.`;

      try {
        const r = PT.engine.submitOrder(pf, {
          assetId: cand.assetId, side: 'buy', type: 'market', notional, reason: why,
        }, ctx);
        budgetLeft -= 1;
        opened += 1;
        log('buy', cand.assetId, why, factors, {
          qty: r.fill.qty, price: r.fill.price, notional: r.fill.notional,
          signal: cand.sig.score, stance: cand.sig.stance, confidence: cand.sig.confidence,
        });
        ctx.cooldowns[cand.assetId] = now;
        st.peaks[cand.assetId] = r.fill.price;
        st.openedAt[cand.assetId] = now;
        workingVal = PT.engine.valuate(pf, ctx.prices);
      } catch (e) {
        log('error', cand.assetId, `Entry rejected: ${e.message}`, factors);
      }
    }

    if (!opened && !decisions.some((d) => d.action !== 'hold')) {
      log('hold', ranked[0].assetId,
        `${ranked[0].assetId} led the ranking at ${ranked[0].sig.score.toFixed(2)} but nothing could be sized this cycle.`, []);
    }

    return { decisions, valuation: PT.engine.valuate(pf, ctx.prices) };
  }

  PT.trader = { RULES, runTraderCycle };
})(window.PT);
