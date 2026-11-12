<div align="center">

# 👑 TRADE GOD

**A local-first desktop trading company staffed by AI agents.**

Gold · Silver · Forex · Indices · Stocks · Crypto · Energy

</div>

TRADE GOD is a desktop app where a crew of AI agents runs a trading company for you: researchers read the
markets, desk traders propose trades, a Bull and a Bear argue every idea, a Risk Manager checks it against hard
limits, an Executor places it, and an **Agent Coach** puts underperforming bots on probation. You own the company
and approve what happens.

> ⚠️ **Trading is risky. Most traders lose money.** TRADE GOD is a tool, not a promise of profit. It starts every
> strategy and every bot on a **paper account** (fake money, real rules). Version 0.1 does **not** place orders with a
> real broker at all. Nothing here is financial advice.

## The one rule everything is built around

**AI may propose anything. Plain code decides what actually happens.**

Language models make confident mistakes, so no order reaches the account unless the risk engine
(`sidecar/trading/risk.js` — deterministic arithmetic, no AI) says yes:

| Rule | Default |
|---|---|
| Stop-loss on every trade | **always** (cannot be switched off by anyone) |
| Max risk per trade | 1% of equity |
| Max loss per day | 3% — then trading stops until tomorrow |
| Max open positions | 5 (resting orders count) |
| Max total open risk | 5% |
| Max leverage | 10:1, and never above the Canadian (CIRO) caps: ~30:1 major FX, 20:1 minor FX & gold, 10:1 indices |
| Kill switch | one click: closes every position, cancels every order, blocks new ones |

Any crew member may **tighten** a limit. Only you can **loosen** one, by typing `I ACCEPT MORE RISK`, and never past
the hard ceilings.

## How a trade happens

```
idea ─► Coach gate ─► sizing ─► RISK ENGINE ─► Trading Council ─► your approval ─► RISK ENGINE again ─► Executor
        (benched?     (1% risk,  (veto)         (Bull + Bear)      (phone or app)   (prices moved?)      (paper fill)
         probation?)   leverage)
```

Every step is written to a **hash-chained journal** — editing, deleting or reordering a past entry is detected.

## The crew (36 roles, 7 departments)

| Department | Roles |
|---|---|
| **Executive Floor** | Head Coach · Agent Coach · Chief Investment Officer · Chief Risk Officer · Chief of Staff |
| **Research** | Macro Economist · Technical Analyst · Fundamental Analyst · News Scout · Sentiment Analyst · On-Chain Analyst |
| **Trading Desks** | Metals Specialist ★ · Forex · Equities · Indices · Crypto · Energy · Options |
| **Strategy & Quant Lab** | Strategist · Quant Researcher · Strategy Breeder · Bull Advocate · Bear Advocate |
| **Risk & Compliance** | Risk Manager · Compliance Officer · Auditor |
| **Execution & Ops** | Executor · Portfolio Manager · Treasurer · Broker Liaison |
| **Support** | Journal Keeper · Performance Analyst · Trading Coach (coaches *you*) · Night Watch · Data Engineer · Systems Guard |

Each role suggests the AI platform that suits it — Claude, ChatGPT, **Grok** (live X/Twitter for news & sentiment),
Gemini, Perplexity, DeepSeek, or free local models through Ollama. All of these, plus OpenRouter, Mistral, Groq,
Kimi and more, are supported.

### The Agent Coach

Every bot has a scorecard (win rate, profit factor, drawdown, calibration, rule breaks). The Coach's ladder is
**rules, not moods** (`sidecar/trading/coach.js`):

`active → review → retrain (needs approval) → probation (half size) → practice (paper only) → benched`

A drawdown breach jumps straight to probation. Bots climb back one step at a time. A promotion (trading without
a tap) is only ever a *recommendation* — you decide. Only you can un-bench a bot.

## Markets & brokers

36 instruments out of the box: **XAU/USD, XAG/USD**, platinum, copper, 11 FX pairs, 6 indices, oil and gas,
BTC/ETH/SOL, and stocks/ETFs (GLD, SLV, SPY, QQQ, …).

| Broker | Status in v0.1 | Canada |
|---|---|---|
| TRADE GOD Paper Account | ✅ ready | ✅ |
| OANDA (practice) | 🧪 connector written, **untested against the live service** — prices & charts only | ✅ (not Alberta) |
| Interactive Brokers · Alpaca · tastytrade · Coinbase · Kraken | 🔜 planned | ✅ |
| Pepperstone · IC Markets · Binance · Bybit | 🔜 planned | 🔒 locked for Canada |

The app only offers a broker that is built **and** legal where you live. Rules change; this is not legal advice.

## TradingView

* **Alerts → TRADE GOD:** point a TradingView alert (Essential plan or higher, 2FA on) at
  `POST /api/trading/tv-webhook` through a tunnel (cloudflared / ngrok). Each alert needs your webhook secret, must
  carry a stop, and only ever becomes a **proposal** that goes through the same gates as any other idea.
* **Import chart data:** "Export chart data" CSV files from TradingView feed the backtester with real candles.

## Backtesting that doesn't lie

`sidecar/trading/backtest.js`: next-bar fills (no look-ahead), spread + slippage + commission **on by default**,
stop-before-target on ambiguous bars, gaps fill at the gap, sizing by the real risk engine, walk-forward
(in-sample vs out-of-sample with an overfitting verdict) and Monte Carlo drawdowns. Three honest strategy
templates ship: EMA crossover, RSI mean reversion, Donchian breakout.

## Prices

With no account connected, prices come from a built-in **simulator** and every screen says **SIMULATED**.
Connect an OANDA practice account for real forex/metals/index prices, or import TradingView CSVs.

## Run from source

```bash
npm ci --omit=optional --omit=dev
npm start          # http://127.0.0.1:8787
node test/trading.risk.test.js     # any single test
npm run test:fast  # the full gate
```

## Run free with a local model

No API key needed: install [Ollama](https://ollama.com), pull a model that can call tools (`ollama pull qwen3:8b`), and
choose **OLLAMA** on the first-run brain screen or under **SETTINGS → PROVIDERS**. Local models are smaller than the
cloud ones, so expect slower, rougher analysis — fine for practising the workflow on the paper account, but give the
Trading Council (Bull, Bear, Risk Manager) a strong cloud model before you trust its arguments.

## Status

See [docs/TRADE_GOD_SPEC.md](docs/TRADE_GOD_SPEC.md) for the full plan and what is done.

## Credits

TRADE GOD is built on the open-source [StarNet](https://github.com/androoAGI/starnet) agent harness by
Andrew Sims (MIT). See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
