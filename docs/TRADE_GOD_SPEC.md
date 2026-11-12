# TRADE GOD — Specification & Status

Owner: SAMEDDZ1 · Jurisdiction: Canada (CIRO) · Use: personal · Started: 2026-11-11

This is the living plan. Each item says what it is, where it lives in the code, and whether it is **done**,
**partial** or **planned**. "Done" means built *and* covered by automated tests that pass.

---

## 1. Principles (non-negotiable)

1. **AI proposes, code decides.** No order reaches an account unless the deterministic risk engine
   (`sidecar/trading/risk.js`) allows it. Agents have no tool that can place an order, change a limit, halt, resume or
   connect a broker (`test/trading.tools.test.js` locks this).
2. **Paper first.** v0.1 executes on the paper account only. There is no live-order code path.
3. **The stop-loss law.** Every position and pending order has a stop. Nobody can switch this off — not an agent, not
   the Commander, not a hand-edited policy file.
4. **Tighten freely, loosen deliberately.** Anyone may tighten a limit; loosening needs the Commander's typed
   confirmation (`I ACCEPT MORE RISK`) and never passes the absolute ceilings.
5. **Never assert what cannot be proven.** Simulated prices are labelled SIMULATED everywhere. Backtests on simulated
   data say so first. Untested connectors say "untested". Scorecards with no data show "—", never zeros.
6. **Everything is journalled** in a hash-chained, append-only journal.

## 2. Defaults

| Setting | Default |
|---|---|
| Venue | Paper account, USD 10,000 |
| Autonomy | Approve every trade (`approve-all`); options: `earned`, `auto` |
| Trading Council | Required for every crew idea (Bull + Bear) |
| Risk per trade / daily loss / open positions / total risk / leverage | 1% / 3% / 5 / 5% / 10:1 |
| Regulatory leverage table | CA: ~30:1 major FX, 20:1 minor FX & gold, 10:1 indices; house caps for metals 10:1, commodities 10:1, equities 3:1, crypto 2:1 |
| Approval expiry | 30 minutes |
| Price feed | Built-in simulator (labelled) until OANDA practice is connected |

## 3. Status by area

### Foundation — done
- StarNet harness (MIT) imported without its art, website or QA evidence (5.2 GB → ~85 MB). Credit kept in
  README, LICENSE, NOTICE.
- Rebrand: app name, identifiers (`com.tradegod.app`), icon, installer art, wordmark, headers (`X-TradeGod-*`).
- Updater points at `SAMEDDZ1/TRADE-GOD` releases. **TODO before the first release:** generate our own Tauri updater
  signing key and replace `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` (it is still StarNet's, so no
  update can install until it is replaced — fail-safe).

### Crew — done
36 roles in 7 departments (`shared/specialties.js`, source in `dev/crew/roster.py`), each with job, standing orders,
starter tasks, gear, skills, suggested AI platform and a pixel seal. Tests: `class-loadouts`, `specialties`.

### Trading engine — done (`sidecar/trading/`)
| Module | What |
|---|---|
| `instruments.js` | 36 instruments, aliases (OANDA / TradingView / exchange spellings), contract sizes, P&L & FX conversion |
| `risk.js` | the gate: stop law, per-trade/daily/total risk, positions, leverage, CA caps, concentration; sizing by risk and by leverage |
| `paper.js` | paper broker: ask/bid fills, gapped stops, limit/stop entries, commissions, FX, kill switch, persistence |
| `service.js` | the pipeline: Coach gate → sizing → risk → Council → approval → risk again → paper fill; journal; TradingView |
| `coach.js` | Agent Coach ladder: active → review → retrain → probation → practice → benched; promotions are recommendations |
| `scorecard.js` | win rate, profit factor, expectancy, drawdown, streaks, R, Brier calibration, Sharpe |
| `journal.js` | SHA-256 hash-chained append-only journal with `verify()` |
| `brokers.js` | 10 brokers + paper, honest status, jurisdiction locks (CA, CA-AB, US) |
| `indicators.js` | SMA, EMA, RSI, ATR, MACD, Bollinger, Donchian — no look-ahead |
| `strategies.js` | EMA crossover, RSI mean reversion, Donchian breakout (parameterised, clamped) |
| `backtest.js` | next-bar fills, costs on, stop-first, gaps, risk sizing, walk-forward verdict, Monte Carlo |
| `breeder.js` | Strategy Breeder: settings searched in-sample, the shortlist judged only on unseen data, multiple-testing caveat |
| `feeds.js` | deterministic labelled simulator; TradingView CSV import |
| `oanda.js` | OANDA v20 practice connector — **untested against the live service** |
| `tradingview.js` | webhook alerts → proposals (secret, stop law, dedupe) |
| `routes.js` | `/api/trading/*` + the price driver |

### Crew tools — done
`trading.market`, `trading.desk`, `trading.propose`, `trading.argue`, `trading.backtest`
(`sidecar/tools/builtin/trading.js`), granted to every agent; the proposer is always the run's own agent.

### Event blackouts — done
No new positions on the affected desks during a high-impact event (CPI, central banks, jobs, OPEC). The Commander
(SETUP) or the News Scout (`trading.blackout`) adds them; only the Commander lifts one. Live calendar feeds are planned —
the News Scout reads the calendar from the web today.

### Phone — done
Owner-only chat commands `/trades`, `/approve <ticket>`, `/reject <ticket>`, `/halt` on every paired channel (Telegram,
Discord, Slack, Matrix, Signal), behind the existing owner gate. Pings to the paired Telegram owner when a ticket needs
approval, when the kill switch fires, and when the Coach puts a bot on probation/practice/bench (SETUP › phone alerts).

### Screens — done (v1)
TRADING DESK window (`frontend/app/windows/trading.js`): FLOOR (pixel-art trading floor), DESK (chart, watchlist,
ticket, positions, orders), APPROVALS, CREW (scorecards + Coach controls), BACKTEST LAB, JOURNAL, SETUP. Opens on
launch. `npm run preview:trading` runs it without the rest of the app.

### Partial / planned
| Item | Status | Notes |
|---|---|---|
| Station world art | **partial** | The trading floor is new art. The original StarNet station view (Build Mode, rooms, props) still runs on StarNet's engine and its procedural sprites; its image assets were removed. Replacing that engine's art set is a project of its own. |
| Live OANDA orders | planned | Behind an explicit switch, after paper results justify it. |
| IBKR, Alpaca, tastytrade, Coinbase, Kraken connectors | planned | Adapter shape = `oanda.js`; crypto via ccxt. |
| Pine Script → strategy | planned | |
| Agent-name mapping on CREW scores | planned | Scores are keyed by agent id. |
| Rust execution core | planned | Only needed for latency-sensitive strategies. |

## 4. Test gate

- `npm run test:trading` — every trading suite.
- `npm run test:fast` — the whole engine. Some inherited StarNet tests referenced the removed website / QA / art
  folders. Those were retired from the list; see `docs/engine/RETIRED_TESTS.md`.
- `test/trading.http.test.js` (in `test/http.list`) boots the real sidecar; it needs `npm ci`.

## 5. Running it

```bash
npm ci            # once
npm start         # http://127.0.0.1:8787  — the TRADING DESK opens by itself
npm run preview:trading   # just the desk, no packages needed
```

Not financial advice. Trading is risky; most traders lose money.
