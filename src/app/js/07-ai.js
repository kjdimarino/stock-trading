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
    'short selling': 'Short selling bets on a price falling by selling borrowed shares first. Losses are theoretically unlimited because a price can keep rising — this app is deliberately long-only.',
  };

  function explainConcept(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return null;
    if (CONCEPTS[q]) return { term: q, text: CONCEPTS[q] };
    // Loose match so "what is rsi?" finds "rsi".
    for (const term in CONCEPTS) {
      if (q.includes(term) || term.includes(q)) return { term, text: CONCEPTS[term] };
    }
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    for (const term in CONCEPTS) {
      if (words.some((w) => term.includes(w))) return { term, text: CONCEPTS[term] };
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
  function concentration(positions, equity, invested) {
    if (!positions.length || equity <= 0) return { hhi: 0, top: null, topWeight: 0, effectiveN: 0 };
    /*
     * HHI is measured against invested capital: including cash makes a
     * one-stock book look perfectly diversified simply because it is mostly
     * uninvested. `topWeight` stays equity-relative, because there cash
     * genuinely does dilute single-name risk.
     */
    const base = invested > 0 ? invested : equity;
    let hhi = 0, topWeight = 0, top = null;
    for (const p of positions) {
      const w = p.value / base;
      hhi += w * w;
      const eqWeight = p.value / equity;
      if (eqWeight > topWeight) { topWeight = eqWeight; top = p.assetId; }
    }
    return { hhi, top, topWeight, effectiveN: hhi > 0 ? 1 / hhi : 0 };
  }

  function analyzePortfolio(val, dayPnl, stats) {
    const positions = val.positions;
    const equity = val.equity;
    const conc = concentration(positions, equity, val.invested);
    const cashWeight = equity > 0 ? val.cash / equity : 1;

    const bySector = {};
    const byKind = { stock: 0, etf: 0, crypto: 0 };
    for (const p of positions) {
      const a = PT.byId[p.assetId];
      const sector = a ? a.sector : 'Unknown';
      bySector[sector] = (bySector[sector] || 0) + p.value;
      byKind[p.kind] = (byKind[p.kind] || 0) + p.value;
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
   * US equities trade ~252 days a year, 6.5h a day.
   */
  const BARS_PER_YEAR = {
    '1m': 252 * 390, '5m': 252 * 78, '15m': 252 * 26,
    '1h': 252 * 7, '1D': 252, '1W': 52,
  };

  /** Build a companion briefing for one asset entirely from computed values. */
  function briefAsset(assetId, bars, quote, tf) {
    const asset = PT.byId[assetId];
    if (!asset) return null;
    // Crypto never closes, so its bars-per-year is the full calendar.
    const cryptoFactor = asset.kind === 'crypto' ? (365 * 24) / (252 * 6.5) : 1;
    const perYear = Math.round((BARS_PER_YEAR[tf] || 252) * cryptoFactor);
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
    const body = [];

    body.push(describeStance(assetId, sig, ind, quote));

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
      headline: describeStance(assetId, sig, ind, quote),
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
      body.push(`Heads up on concentration: ${c.top} alone is ${(c.topWeight * 100).toFixed(0)}% of your equity. A bad day in one name would move your whole book.`);
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

    if (pa.stats && pa.stats.winRate != null) {
      body.push(`Across ${pa.stats.sells} closed trade${pa.stats.sells === 1 ? '' : 's'} your win rate is ${pa.stats.winRate.toFixed(0)}%${pa.stats.profitFactor && isFinite(pa.stats.profitFactor) ? `, with a profit factor of ${pa.stats.profitFactor.toFixed(2)}` : ''}.`);
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
    takeProfitAtrMult: 4.0,
    hardStopPct: -10,
    hardTakePct: 22,
    cooldownMs: 10 * 60000,   // per-symbol pause after any trade
    maxTradesPerDay: 25,
    minBars: 60,
  };

  /**
   * One decision cycle. Pure with respect to its inputs: it is handed the
   * portfolio, live quotes and candle data, and returns the decisions it made.
   * Every decision — including holds — is logged with the numbers behind it.
   */
  function runTraderCycle(pf, ctx) {
    const now = ctx.now || Date.now();
    const decisions = [];
    const val = PT.engine.valuate(pf, ctx.prices);
    const equity = val.equity;

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

      if (ind && ind.atr14 != null && pos.avgCost > 0) {
        const stopDistance = (RULES.stopAtrMult * ind.atr14 / pos.avgCost) * 100;
        if (pnlPct <= -stopDistance) {
          reason = `Stop hit: down ${U.fmtPct(pnlPct)}, beyond ${RULES.stopAtrMult}× ATR (${stopDistance.toFixed(1)}%).`;
          factors.push({ k: 'ATR stop', v: `${stopDistance.toFixed(1)}%` });
        }
        const takeDistance = (RULES.takeProfitAtrMult * ind.atr14 / pos.avgCost) * 100;
        if (!reason && pnlPct >= takeDistance) {
          reason = `Target reached: up ${U.fmtPct(pnlPct)}, past ${RULES.takeProfitAtrMult}× ATR (${takeDistance.toFixed(1)}%).`;
          factors.push({ k: 'ATR target', v: `${takeDistance.toFixed(1)}%` });
        }
      }
      if (!reason && pnlPct <= RULES.hardStopPct) {
        reason = `Hard stop: position is down ${U.fmtPct(pnlPct)}.`;
      }
      if (!reason && pnlPct >= RULES.hardTakePct) {
        reason = `Hard target: position is up ${U.fmtPct(pnlPct)}.`;
      }
      if (!reason && sig && sig.score <= RULES.exitScore) {
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
    const investable = freshVal.equity * (1 - RULES.minCashReserve);
    const deployed = freshVal.invested;

    if (held.size >= RULES.maxPositions) {
      log('hold', null, `Holding at the ${RULES.maxPositions}-position limit; watching existing names for exits.`, []);
      return { decisions, valuation: freshVal };
    }
    if (deployed >= investable) {
      log('hold', null, `Cash reserve floor reached — keeping ${(RULES.minCashReserve * 100).toFixed(0)}% of equity uninvested.`, []);
      return { decisions, valuation: freshVal };
    }

    const ranked = [];
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
      ranked.push({ assetId, sig, ind, quote });
    }
    ranked.sort((a, b) => b.sig.score - a.sig.score);

    const best = ranked[0];
    if (!best) {
      log('hold', null, ctx.marketOpen
        ? 'No candidate cleared the evidence bar this cycle.'
        : 'US equities are closed; only crypto candidates were considered and none qualified.', []);
      return { decisions, valuation: freshVal };
    }

    if (best.sig.score < RULES.entryScore) {
      log('hold', best.assetId,
        `Best candidate ${best.assetId} scored ${best.sig.score.toFixed(2)} (${best.sig.stance}), below the ${RULES.entryScore} entry bar.`,
        best.sig.factors.slice(0, 3).map((f) => ({ k: f.key, v: f.detail })));
      return { decisions, valuation: freshVal };
    }

    if (budgetLeft <= 0) {
      log('hold', best.assetId, `Daily trade cap of ${RULES.maxTradesPerDay} reached; standing down until tomorrow.`, []);
      return { decisions, valuation: freshVal };
    }

    /*
     * Size by conviction and volatility: a stronger signal gets more, and a
     * more volatile asset gets less, capped by the per-position weight limit.
     */
    const conviction = U.clamp((best.sig.score - RULES.entryScore) / (1 - RULES.entryScore), 0, 1);
    const volPenalty = best.ind.atrPct != null ? U.clamp(2.5 / Math.max(0.5, best.ind.atrPct), 0.35, 1) : 0.7;
    const targetWeight = RULES.maxWeightPerPosition * (0.45 + 0.55 * conviction) * volPenalty;
    const headroom = Math.max(0, investable - deployed);
    let notional = Math.min(freshVal.equity * targetWeight, headroom, pf.cash * 0.95);
    notional = Math.floor(notional * 100) / 100;

    if (notional < RULES.minOrderValue) {
      log('hold', best.assetId,
        `${best.assetId} qualified (${best.sig.stance}) but the available size of ${U.fmtUSD(notional)} is below the ${U.fmtUSD(RULES.minOrderValue)} minimum.`, []);
      return { decisions, valuation: freshVal };
    }

    const factors = best.sig.factors.slice(0, 4).map((f) => ({
      k: f.key, v: f.detail, dir: f.value > 0 ? 1 : f.value < 0 ? -1 : 0,
    }));
    // Report the size actually traded, not the target: available cash and the
    // reserve floor routinely clamp it, and the log must match the order.
    const actualWeight = freshVal.equity > 0 ? (notional / freshVal.equity) * 100 : 0;
    const clamped = actualWeight < targetWeight * 100 - 0.05;
    const why = `${best.assetId} scored ${best.sig.score.toFixed(2)} (${best.sig.stance}, ${best.sig.confidence}% confidence). `
      + `Sizing ${actualWeight.toFixed(1)}% of equity`
      + (clamped ? ` (trimmed from a ${(targetWeight * 100).toFixed(1)}% target by available cash)` : '')
      + ` after a volatility adjustment for ${best.ind.atrPct != null ? best.ind.atrPct.toFixed(2) + '% ATR' : 'unknown volatility'}.`;

    try {
      const r = PT.engine.submitOrder(pf, {
        assetId: best.assetId, side: 'buy', type: 'market', notional, reason: why,
      }, ctx);
      log('buy', best.assetId, why, factors, {
        qty: r.fill.qty, price: r.fill.price, notional: r.fill.notional,
        signal: best.sig.score, stance: best.sig.stance, confidence: best.sig.confidence,
      });
      ctx.cooldowns[best.assetId] = now;
    } catch (e) {
      log('error', best.assetId, `Entry rejected: ${e.message}`, factors);
    }

    return { decisions, valuation: PT.engine.valuate(pf, ctx.prices) };
  }

  PT.trader = { RULES, runTraderCycle };
})(window.PT);
