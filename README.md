# Paper Trader

A self-contained paper trading terminal. Virtual money, real live market data,
stocks and crypto, in an interface built to feel like a real trading platform.

![Trading view](test/screenshot-trade.png)

---

## How to run

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else — there are no
dependencies to install.

```bash
node paper-trader.mjs
```

Then open **http://127.0.0.1:7777**.

That's it. On first launch it asks you to pick a starting balance; after that
your portfolio, cash and full trade history persist in your browser between
sessions.

```bash
PORT=8080 node paper-trader.mjs     # if 7777 is taken
```

To stop it, press `Ctrl+C`.

### Why there's a server at all

The app is one file, but it is not a plain `.html` you can double-click. The
free, key-less sources of US equity data — Yahoo Finance and Nasdaq — send no
CORS headers, so a browser cannot call them directly. The Node process exists to
proxy those requests, and while it's there it also caches them, coalesces
duplicates and rate-limits them so a busy watchlist can't get your IP throttled.

Crypto needs none of that: the browser streams it straight from Coinbase's
public WebSocket.

No account data ever reaches the server process. Your portfolio lives entirely
in your browser's `localStorage`.

---

## What it does

### Accounts
Keep up to **12 accounts open at once** — a $2K one to feel the pinch and a $1M
one to swing at the fences, running side by side.

Each is a genuinely separate book: its own cash, positions, open orders, trade
history, equity curve and day P&L. Nothing is shared but the watchlist and your
chart drawings, which are about symbols rather than money. Resting and queued
orders on an account you are not looking at still fill, and the toast says which
account it happened on; margin is checked on every account, not just the visible
one.

- The topbar always names the account being traded and what it is worth — which
  book a trade lands in should never be ambiguous.
- Click it to switch, or open **Accounts** for the full board: value, P&L, return,
  free cash, positions and win rate per account, with rename, reset and close.
- **Reset** starts one account over at a balance of your choosing and leaves the
  others alone. **Reset Portfolio** in Settings still wipes everything.

Saves written before accounts existed load unchanged — the single book you had
simply becomes your first account, keeping its cash, positions and full history.

### Portfolio
- Pick a starting balance on first launch — $1K, $10K, $100K, $1M or your own number.
- Cash, positions, open orders, trade history and every equity curve persist between sessions.

### What you can trade
The curated list is a starting point, not a limit. **Every US-listed stock and
ETF is tradable** — around 7,000 names, penny stocks included — plus crypto in
two tiers. Search finds anything; selecting it makes it tradable, chartable and
watchable immediately, and it is remembered across sessions.

**Crypto comes in two tiers, and the app always tells you which one you are
looking at:**

| Tier | Coins | Prices | Charts |
|---|---|---|---|
| Live | ~400 on Coinbase | Real trade prints over a WebSocket, badged `LIVE` | Full OHLCV down to seconds |
| Delayed | ~2,000 more via CoinGecko | Snapshots refreshed about once a minute, badged `DELAYED` | 5m and slower, close-only |

The delayed tier exists because Coinbase is the only source that streams real
trades to a browser without an API key. Everything beyond it is a snapshot, and
CoinGecko's free tier is a handful of calls a minute — enough to price a coin you
are looking at, not enough to stream a watchlist. So those coins are priced and
tradable, never pretend to be live, and refuse sub-5-minute candles outright
rather than resampling a coarser series and calling it a minute bar.

The one gap: OTC / pink-sheet tickers are not in the listing directory, so a few
very small names won't resolve.

### Trading
- **Market and limit orders**, buy and sell, on stocks, ETFs and crypto.
- **Short selling.** Sell more than you own to bet on a fall. Shorts hold 150%
  of their value as collateral (Reg T, so about 2x leverage), the proceeds
  cannot be spent twice, and if equity drops below 30% of the short you get a
  margin call — below 25% it is bought back automatically, as a broker would.
  Turn it off in Settings if you'd rather stay long-only.
- **Fractional quantities** — size by dollars or by shares/coins. 8 decimals for crypto, 6 for equities.
- Limit orders rest on a book and fill when the live price crosses them, with
  price improvement. Resting orders reserve their cash or shares, so you cannot
  commit the same balance twice and have an order quietly vanish later.
- **Orders placed while the stock market is shut are queued, not rejected.** Buy
  AAPL at midnight and it fills at the opening print; a limit joins the book at
  the bell and fills normally from there. Queued orders hold their cash or shares
  like any resting order, show what they are waiting for in **Open orders**, and
  can be cancelled at any time. A dollar-sized queued order buys its dollars at
  the open rather than a stale share count, so an overnight gap cannot turn
  "$500 of AAPL" into a rejection.
- A simulated spread (2bp equities, 5bp crypto) is applied to market fills so an
  instant round trip costs you something, the way a real one does. You can turn
  it off in Settings.
- Positions show quantity, weighted-average cost, market value, and unrealized
  and realized P&L in both dollars and percent.
- Day P&L, total return, win rate, profit factor and max drawdown.
- Full timestamped trade history, plus anything that reached its price but
  could not fill, with the reason why.
- A permanent money bar above the blotter: how much is invested, how much cash
  is free to spend, what is reserved, and each position's share of the book.
- **Repair account** in Settings rebuilds cash and positions exactly from your
  trade history if anything ever looks wrong.

Shorting is modelled with real margin mechanics — collateral, a maintenance
level and a forced buy-in — because a short that can't lose more than it cost
would teach the wrong lesson. Borrow fees are the one thing not simulated.

### Market data
| What | Source | Notes |
|---|---|---|
| Crypto, live | Coinbase Exchange WebSocket | Real trade prints, straight to the browser |
| Crypto, snapshot + fallback | Coinbase REST (bulk) | All 517 products in one call |
| Crypto candles | Coinbase Exchange | Falls back to Yahoo |
| Stock quotes | Yahoo Finance v8 | Falls back to Nasdaq |
| Stock candles | Yahoo Finance v8 | Falls back to Nasdaq intraday + historical |
| Crypto, long tail | CoinGecko markets + simple price | ~2,000 more coins, delayed and labelled as such |
| Long-tail crypto candles | CoinGecko market_chart | Close-only; 5m and slower only |
| Symbol search | Nasdaq listing directory (~7,000 names) | Coinbase products, then CoinGecko, then Yahoo |
| Ideas / screens | Nasdaq screener + Coinbase 24h stats | — |

Every quote is labelled with where it came from and how fresh it is —
**LIVE**, **DELAYED**, **CACHED** or **STALE**. Nothing is ever invented: if a
price is unavailable, the app says so rather than showing a plausible number.
Market hours are enforced for equities (including real NYSE holiday rules and
early closes) while crypto trades 24/7.

**Update rate.** Crypto is a true stream — every trade print, several per
second. Equities are polled, because Yahoo bans an IP for minutes after a burst
(see the note at the bottom): the symbol you are looking at refreshes every 1.5
seconds while the market is open, the rest of the watchlist every 6, and far
more slowly once the market shuts, when nothing is moving anyway. The app never
interpolates between real quotes — a price on screen is a price that traded.

### Charts
Candlestick and line charts drawn on raw canvas — no charting library.
Timeframes from **1 second** to 1 week, volume bars, a snapping crosshair with
an OHLCV readout, and a live last-price line that updates as the tape moves.

No public feed serves sub-minute candles — Coinbase's smallest granularity is
60 seconds — so the 1s/5s/15s views are built here from the live print stream:
real trade prints for crypto, polled quotes for stocks. They fill in as prints
arrive, and the chart names the source ("live trades" or "polled quotes") rather
than pretending it fetched them. A second with no prints is carried forward flat
instead of being dropped, so the time axis stays uniform.

Where a source gives one price per bar rather than OHLC — Nasdaq's 1m intraday,
and every CoinGecko series — each bar opens where the previous one closed, so the
body shows the real move. Highs and lows from two known prices understate the
true range, so those charts say **close-only, no intraday high/low** instead of
passing themselves off as full OHLC.

**Draw on the chart.** The **Draw** button opens four tools: a trendline you drag
between two points, a horizontal level placed with a click and labelled with its
price, freehand, and an eraser that removes the shape under the pointer. Undo and
Clear sit beside them.

Drawings are stored in *time and price*, never in pixels. A trendline drawn on
the 5m chart still touches the same two highs on the 1h, after a resize, and
after fifty new bars have pushed everything left. They belong to the symbol, not
the timeframe, and persist across sessions. A level far from the current price
can sit off-screen — the price axis follows the candles, not your annotations.

### Ideas
A board of live screens across the whole market: top gainers and fallers, most
actively traded, penny stocks on the move, large and steady names, biggest
companies, small caps making moves, and crypto movers. Each list states the
filter it applied — "top gainer" means little if you can't see whether
penny-stock noise was screened out. Click any card to start trading it.

These are screens, not recommendations.

### AI companion
An analyst panel that answers questions about your book, any symbol, or a
trading concept.

**By default every answer is computed, not generated.** It calculates RSI(14),
MACD(12,26,9), Bollinger Bands, ATR(14), moving averages, volume ratio, realised
volatility and range position from real candles, turns them into a weighted
stance with a confidence score, and cites the actual numbers back to you. It is
labelled "Computed analytics" in the UI precisely so it is never mistaken for
something it isn't.

If you want prose on top of the arithmetic, start the server with an Anthropic
API key:

```bash
ANTHROPIC_API_KEY=sk-ant-... node paper-trader.mjs
```

The model is then given the *computed evidence* and told it may not invent a
number. The key stays on your machine; the browser never sees it. Answers that
came from the model are labelled as such.

The model route only answers the app itself — opened as `localhost`, by IP
address, or under the name in `HOST` — so another web page cannot spend your
key. If you start with `HOST=0.0.0.0` and open the app by machine name, or
through a tunnel or reverse proxy that passes the original `Host` header on
(for nginx, `proxy_set_header Host $host`), list those names in
`PT_ALLOWED_HOSTS`, comma separated:

```bash
PT_ALLOWED_HOSTS=mybox.local HOST=0.0.0.0 ANTHROPIC_API_KEY=sk-ant-... node paper-trader.mjs
```

### Autonomous AI trader
A second portfolio, same starting cash, traded automatically every five seconds
by a deterministic multi-factor strategy while you trade yours. It stays
long-only regardless of your own shorting setting — its rules were designed and
tested without shorts.

It logs **every** decision — including the decision to do nothing — with the
factors behind it, so you can see exactly why it acted. Repeated identical holds
collapse into one entry with a count, so the log moves quickly without burying
the actual trades.

#### How it trades

- **Only buys what is already trending.** Price must be above its 50-bar average
  with the 20 above the 50, before conviction is even consulted. The blended
  score reads bullish on a falling name whenever short-term momentum ticks up,
  and buying those was the single largest source of loss.
- **Sizes by risk, not by hunch.** Each position is sized so that being stopped
  out costs about 0.8% of the account. A volatile name gets fewer dollars than a
  calm one automatically, and every open position carries about the same risk.
  The rationale states the dollars at risk, so you can check it.
- **Caps correlated bets.** Crypto moves as one block, so eight coins is one bet,
  not eight. No correlated group may exceed 45% of the book.
- **Lets winners run.** There is no fixed profit target. The old rule sold
  everything at 4× ATR or +22%, which capped exactly the trades a low-win-rate
  trend system lives on.
- **Adds to what is working.** A position already ahead by 3× ATR and still
  scoring well gets more, up to the same per-position cap — and never while it
  is losing, so this can't become averaging down.
- **Exits on broken trends, not wobbles.** A stop is immediate. The softer exits
  — the score turning, or price closing below its 50-bar average — wait until
  the position has had a couple of bars to work, so a new position isn't closed
  on noise while paying the spread twice.

Guardrails: long only, max 8 positions, max 15% of equity per position, a 10%
cash floor, ATR stops, a 10-minute per-symbol cooldown and a 25-trade daily cap.

#### How that was checked

`tools/backtest.mjs` walks the strategy forward over real daily candles for 33
names across 306 days. At each bar it sees only the history up to that bar and
trades at that bar's close through the real engine, paying the same spread the
live app charges. Nothing can see the future.

| | before | after | buy & hold |
|---|---|---|---|
| return | +7.6% | **+20.4%** | +1.6% |
| max drawdown | -9.7% | **-8.1%** | -19.1% |
| Sharpe | 0.64 | **1.14** | 0.16 |
| profit factor | 1.19 | **1.89** | — |
| avg win : avg loss | 2.8 : 1 | **8.6 : 1** | — |

The win rate is 18%. That is expected and fine — it is a trend system, and the
payoff ratio is what pays for it.

Every setting was chosen on the first half of the history and then checked on
the second half, which never influenced it. That discipline mattered: a
parameter sweep found settings that turned the first half from -1.9% to +1.5%
and made the second half *worse*, so those settings were discarded rather than
shipped. `tools/ablate.mjs` turns each rule off in turn (and the ones that ship
switched off, on), and `test/strategy.test.mjs`
runs the whole backtest as a regression test on every build.

**This is a demonstration of a rules engine, not investment advice, and 306 days
of one basket is not proof that anything works.**

The **You vs AI** tab is a live scoreboard: overlaid equity curves, total
return, realized and unrealized P&L, trade count, win rate and max drawdown.

![Scoreboard](test/screenshot-compare.png)

![AI companion](test/screenshot-ai.png)

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus the symbol search |
| `1`–`9` | Timeframe: 1s, 5s, 15s, 1m, 5m, 15m, 1h, 1D, 1W |
| `b` / `s` | Buy / sell side |
| `t` `g` `a` `c` | Trade · Portfolio · AI · Compare (Ideas is on the rail) |
| `Esc` | Close a dialog |

---

## Development

The shipped `paper-trader.mjs` is generated. Edit the sources under `src/`.

```bash
npm run dev      # serve from src/, re-read on every reload
npm run build    # regenerate paper-trader.mjs
npm test         # all suites
```

```
src/
  http.mjs         zero-dependency HTTPS client (handles CONNECT proxies)
  universe.mjs     the tradable asset list — single source of truth
  providers.mjs    upstream data, caching, failover, rate limiting
  server.mjs       static serving + the data proxy
  app/
    index.html     shell (CSS and JS are inlined at build time)
    css/           design tokens, layout, components, views
    js/            calendar, engine, indicators, feed, charts, AI, UI, views
tools/
  build.mjs        bundles everything into paper-trader.mjs
  serve.sh         start/stop helper used by the tests
test/              unit, live-data and browser suites
```

### Tests

693 assertions across 15 suites:

| Suite | What it covers |
|---|---|
| `calendar` | NYSE holiday rules, early closes, session phases, DST boundaries |
| `engine` | Order validation, cost basis, long and short P&L, margin and forced buy-in, limit fills, reserved balances, account repair, persistence, randomised float-safety runs |
| `indicators` | RSI/MACD/Bollinger/ATR against an independent reference implementation |
| `chart` | Axis tick generation, decimal precision, sparkline geometry |
| `feed` | Folding live ticks into session-anchored candles, freshness grading |
| `ai` | Companion output, trader entries/exits/risk limits, a 400-cycle simulation |
| `strategy` | The whole backtest as a regression test, on both halves of the history |
| `calendar-regress` | Rounding and quantity/currency formatting at the extremes, early-close sessions |
| `server-regress` | Offline proxy checks with scripted upstreams: timestamps, routing, cooldowns, cache keys, the model route's origin rules |
| `app-regress` | The run loop and boot in simulated tabs: one writer at a time, leases, margin calls and buy-ins, orders at the bell |
| `live-feed` | Connects to the **real** Coinbase socket and parses genuine live frames |
| `providers` | Rate-limiter behaviour under concurrency, freshness labelling |
| `browser` | Full end-to-end in Chromium against live data — 130 checks |
| `ui-regress` | Hermetic Chromium checks of the order ticket, portfolio view and narrow layouts, with a scripted feed |
| `market-open` | The equity path with the session clock pinned open |

```bash
npm test                       # everything
PT_SKIP_BROWSER=1 npm test     # unit + live data only
PT_SHOTS=1 npm test            # also regenerate the screenshots in this README
```

The browser suite drives the real UI: onboarding, live quotes, chart rendering
on canvas, order placement and rejection, limit resting and cancelling,
persistence across reload, the companion, the AI trader, responsive layout and
reset. `market-open` exists because the suite usually runs outside trading
hours, which would otherwise leave the entire stock path untested.

---

## A note on rate limits

Yahoo Finance bans an IP for several minutes after a burst of requests, and
retrying during the penalty extends it. The app is built around that: it calls
Yahoo through a per-host token bucket (`query1` and `query2` are throttled
independently), backs off exponentially on a 429, caches aggressively, and polls
far less often when the market is closed. If Yahoo is unavailable it falls
through to Nasdaq and labels the data `DELAYED` rather than pretending.

You will see this working if you ever notice a **DELAYED** badge — it means the
number is real but came from the fallback.

---

## Disclaimer

**This is paper trading for practice only.** No real money is involved, no
orders reach a real market, and there is no brokerage account behind any of it.
Prices are real (live or delayed, as labelled), but everything you do here is a
simulation.

Nothing in this app is financial advice.
