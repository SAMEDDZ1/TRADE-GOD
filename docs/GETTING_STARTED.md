# Getting started with TRADE GOD

Everything starts on a **paper account** (fake money, real rules). Nothing here can lose real money in v0.1.

## 1. Run it

You need **Node.js 22** (https://nodejs.org) and **Git**.

```bash
git clone https://github.com/SAMEDDZ1/TRADE-GOD.git
cd TRADE-GOD
npm ci --omit=optional --omit=dev
npm start
```

`--omit=optional` skips the offline speech engine (about 1 GB); drop it if you want voice that works without the
internet. `--omit=dev` skips the tools for building the installer and running the tests.

Open **http://127.0.0.1:8787** in Chrome or Edge. The TRADING DESK opens by itself once the station is up.

Just want to look at the trading screens first? `npm run preview:trading` runs only the desk (no setup, no packages)
at http://127.0.0.1:8788.

> The desktop installer (`.exe` / `.dmg`) is built with Tauri (`npx tauri build`, needs Rust). Building and signing it
> is a later step — run from source for now.

## 2. Give the crew a brain (AI provider)

The first screens walk you through it. Use your **own** key from any of:
Anthropic (Claude), OpenAI (ChatGPT, or sign in with your ChatGPT account), xAI (Grok — API key or SuperGrok sign-in),
Google (Gemini), Perplexity, DeepSeek, Mistral, Groq, OpenRouter (one key, many models), or **Ollama** (free, local).

Keys are kept in your operating system's keychain, never in the app's files.

## 3. Tell it where you trade from

TRADING DESK › **SETUP** › *Where you trade from*: **Canada** and your **province**. Brokers that don't serve you are
locked (e.g. Binance, Bybit, Pepperstone and IC Markets for Canada; OANDA for Alberta).

## 4. Hire your crew

Bottom bar › **CREW › RECRUIT** → pick trading roles: start with the **Head Coach**, **Metals Specialist**,
**Technical Analyst**, **News Scout**, **Bull Advocate**, **Bear Advocate** and **Risk Manager**. Each role suggests an AI
that suits it (e.g. Grok for the News Scout — it reads X). Their desks light up on the **FLOOR** tab.

Then just talk to them: *"Metals Specialist — find a gold setup for this week."* A trade idea becomes a ticket: the Bull
and Bear argue it, the risk engine checks it, and it waits for you in **APPROVALS**.

## 5. Real prices (optional): OANDA practice account

1. Open a free **practice** account at oanda.com (CIRO-regulated in Canada; not available in Alberta).
2. In OANDA's account area, generate a **personal access token** for the practice (fxTrade Practice) account and copy
   your account ID (looks like `101-001-1234567-001`).
3. TRADING DESK › SETUP › **OANDA practice account** → paste both → CONNECT.

You now get real forex, gold, silver and index prices and charts. Orders still go to the TRADE GOD paper account. The
token is held in memory only — you paste it again after a restart.

> The OANDA connector is written from OANDA's documentation and tested against recorded responses, but it has not yet
> been run against the live service. If anything looks wrong, disconnect and tell us.

## 6. Approve trades from your phone (Telegram)

1. Bottom bar › **BUILD › CONNECT › CHANNELS** → Telegram → follow the steps to create a bot with @BotFather and
   **pair it with your account** (the pairing code proves the bot is yours).
2. TRADING DESK › SETUP › tick **Phone alerts**.

You'll get a message when a trade needs you. Reply `/approve K12`, `/reject K12`, `/trades` or `/halt` (the kill
switch). Only the paired owner can use these — anyone else is refused.

## 7. TradingView alerts → TRADE GOD (optional)

Needs a paid TradingView plan (Essential or higher) and 2-factor sign-in on TradingView.

1. SETUP › **TradingView alerts** → set a webhook secret (12+ characters).
2. TradingView can only call a public HTTPS address, so expose your computer with a tunnel, e.g.
   `cloudflared tunnel --url http://127.0.0.1:8787` → it prints `https://<something>.trycloudflare.com`.
3. In the TradingView alert: Webhook URL = `https://<something>.trycloudflare.com/api/trading/tv-webhook`, Message =
   the template shown in SETUP with your secret in it.

Every alert must carry a stop (`stop` or `stopPct`) and only ever becomes a **proposal** you approve.

## 8. Backtest before you believe anything

TRADING DESK › **BACKTEST LAB**. For real results, export candles from TradingView (chart › ⋯ › *Export chart data*)
and load the CSV. Use **BREED VARIANTS** to search a strategy's settings — survivors are candidates for paper trading,
never proof. Results on SIMULATED prices only prove the plumbing works.

## Safety you can't switch off

- A stop-loss on every trade.
- Risk limits enforced by code (default 1% per trade, 3% per day). Raising one needs you to type `I ACCEPT MORE RISK`.
- The KILL SWITCH closes everything in one click (or `/halt` from your phone).
- Every action is written to a tamper-evident journal (JOURNAL › VERIFY THE CHAIN).

Not financial advice. Trading is risky; most traders lose money. Paper-trade for weeks before considering real money.
