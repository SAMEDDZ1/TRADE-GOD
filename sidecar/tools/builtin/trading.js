/* sidecar/tools/builtin/trading.js — the crew's hands on the TRADING DESK.

     trading.market    prices, candles and indicator readings for any instrument (read)
     trading.desk      the account, open positions, waiting tickets, the risk limits, and YOUR Coach level (read)
     trading.propose   submit a trade PROPOSAL (write — but it can only ever create a ticket)
     trading.argue     argue FOR (bull) or AGAINST (bear) a ticket on the Trading Council (write — text only)
     trading.backtest  test a built-in strategy's rules on history (read)

   WHAT AN AGENT CAN AND CANNOT DO WITH THESE
     • it can never place an order. trading.propose hands an idea to the desk (sidecar/trading/service.js), where the
       Coach gate, the risk engine, the Trading Council and — by default — the Commander's approval all stand between
       it and the paper account. A refused idea comes back with the desk's own reason.
     • it cannot speak for anyone else. The proposer and the arguer are THIS run's agent, taken from the run itself,
       never from the arguments — an agent cannot file an idea or an argument in another crew member's name.
     • it cannot touch a limit, the kill switch, a setting, a broker or the money. There is no tool for those.

   Granted on the always-present `computer` object (capId 'trading') because trading IS this app: every crew member
   can read the market and propose, the way every employee of a trading firm can pitch a trade. Proposals have no
   effect outside the desk, so they need no per-call approval card — the approval that matters is the ticket's. */
'use strict';
const I = require('../../trading/instruments.js');
const T = require('../../trading/indicators.js');
const Strategies = require('../../trading/strategies.js');
const Backtest = require('../../trading/backtest.js');

const GRAN = ['M5', 'M15', 'H1', 'H4', 'D'];
function r(n, d) { return n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)); }
function digitsOf(inst) { return Math.max(0, Math.round(-Math.log10(inst.tick))); }

function makeTradingTools(deps) {
  const d = deps || {};
  const desk = d.desk;                     // { service, candles(symbol, granularity, count) -> {candles, simulated, error?}, pump() }
  const agentId = String(d.agentId || '').slice(0, 60);
  const unavailable = { content: 'The trading desk is not available in this run.', summary: 'no desk' };

  const market = {
    name: 'trading.market', capability: 'trading', impact: 'none', scope: 'read', requiresConsent: false, timeoutMs: 20000,
    description: 'Read the market: live bid/ask for instruments, and optionally recent candles with indicator readings '
      + '(SMA20/50/200, EMA20, RSI14, ATR14, 20-bar high/low) for ONE symbol. Symbols: XAUUSD (gold), XAGUSD (silver), '
      + 'EURUSD, USDCAD, US500, NAS100, BTCUSD, WTIUSD and more (call with no symbols for the watchlist). Prices may be '
      + 'SIMULATED — the result says so; never present simulated prices as the real market.',
    schema: { type: 'object', properties: {
      symbols: { type: 'array', items: { type: 'string' }, description: 'instruments to quote (default: the watchlist)' },
      symbol: { type: 'string', description: 'one instrument to analyse with candles + indicators' },
      granularity: { type: 'string', enum: GRAN, description: 'candle size (default H1)' },
      bars: { type: 'integer', minimum: 20, maximum: 300, description: 'how many recent candles to return (default 60)' } } },
    run: async (args) => {
      if (!desk) return unavailable;
      const a = args || {};
      await desk.pump();
      const want = (Array.isArray(a.symbols) && a.symbols.length ? a.symbols : desk.service.watchlist()).map(I.normalize).filter(Boolean).slice(0, 30);
      const feed = desk.feedInfo();
      const quotes = {};
      for (const s of want) { const q = desk.service.quote(s); if (q) quotes[s] = { bid: q.bid, ask: q.ask }; }
      const out = { feed: feed.simulated ? 'SIMULATED prices — not real market data' : feed.label, quotes };
      const sym = I.normalize(a.symbol);
      if (a.symbol && !sym) out.error = 'unknown symbol: ' + a.symbol;
      if (sym) {
        const inst = I.get(sym), g = GRAN.indexOf(a.granularity) >= 0 ? a.granularity : 'H1';
        const bars = Math.min(300, Math.max(20, Math.floor(Number(a.bars) || 60)));
        const c = await desk.candles(sym, g, 260);
        if (c.error) out.error = c.error;
        else {
          const cs = c.candles, closes = cs.map(k => k.c), last = cs.length - 1, dg = digitsOf(inst);
          const at = arr => r(arr[last], dg + 1);
          out.analysis = {
            symbol: sym, name: inst.name, granularity: g, simulated: c.simulated, contractSize: inst.contractSize, quoteCurrency: inst.quote,
            last: closes[last], sma20: at(T.sma(closes, 20)), sma50: at(T.sma(closes, 50)), sma200: at(T.sma(closes, 200)), ema20: at(T.ema(closes, 20)),
            rsi14: r(T.rsi(closes, 14)[last], 1), atr14: at(T.atr(cs, 14)),
            high20: r(Math.max.apply(null, cs.slice(-20).map(k => k.h)), dg), low20: r(Math.min.apply(null, cs.slice(-20).map(k => k.l)), dg),
            candles: cs.slice(-bars).map(k => [new Date(k.t).toISOString().slice(0, 16), k.o, k.h, k.l, k.c])
          };
        }
      }
      return { content: JSON.stringify(out), summary: 'read ' + Object.keys(quotes).length + ' quote(s)' + (sym ? ' + ' + sym + ' candles' : '') };
    }
  };

  const deskTool = {
    name: 'trading.desk', capability: 'trading', impact: 'none', scope: 'read', requiresConsent: false, timeoutMs: 10000,
    description: 'Read the trading desk: the paper account (equity, today\'s P&L), open positions, pending orders, tickets '
      + 'waiting for the Trading Council or the Commander, the risk limits, and YOUR own scorecard and Agent Coach level '
      + '(probation = half size and approval; practice = paper only; benched = you cannot propose).',
    schema: { type: 'object', properties: {} },
    run: async () => {
      if (!desk) return unavailable;
      const s = desk.service.snapshot(), sc = desk.service.scorecards(), me = sc.agents[agentId];
      const out = {
        venue: 'paper', account: s.account, halted: s.halted.on ? s.halted : false, policy: s.policy,
        positions: s.positions.map(p => ({ id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, entry: p.entry, stop: p.stop, takeProfit: p.takeProfit, mark: p.mark, unrealized: p.unrealized, by: p.agentId })),
        orders: s.orders.map(o => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, price: o.price, stop: o.stop, lots: o.lots })),
        waiting: s.pending.map(t => ({ ticketId: t.id, status: t.status, symbol: t.symbol, side: t.side, entry: t.entry, stop: t.stop, takeProfit: t.takeProfit, lots: t.lots, by: t.agentId, thesis: t.thesis,
          council: t.council.map(c => ({ role: c.role, by: c.agentId })) })),
        you: { agentId, level: me ? me.status.level : 'active', promoted: !!(me && me.status.promoted), effects: me ? me.effects : null, scorecard: me ? me.card : null },
        autonomy: s.settings.autonomy, councilRequired: s.settings.requireCouncil
      };
      return { content: JSON.stringify(out), summary: 'read the desk' };
    }
  };

  const propose = {
    name: 'trading.propose', capability: 'trading', impact: 'none', scope: 'write', requiresConsent: false, timeoutMs: 15000,
    description: 'PROPOSE a trade. This never places an order: the ticket goes through the risk engine, the Trading Council '
      + '(Bull + Bear) and normally the Commander\'s approval before the Executor fills it on the paper account. A stop-loss '
      + 'is REQUIRED. Size is worked out by the desk from your stop and riskPct (capped at the policy limit) — do not '
      + 'pick lots. Give an honest thesis and a calibrated confidence (0..1): your scorecard grades it.',
    schema: { type: 'object', required: ['symbol', 'side', 'stop', 'thesis'], properties: {
      symbol: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] },
      stop: { type: 'number', description: 'stop-loss PRICE (required)' }, takeProfit: { type: 'number', description: 'take-profit PRICE' },
      orderType: { type: 'string', enum: ['market', 'limit', 'stop'], description: 'default market' },
      entry: { type: 'number', description: 'entry price for limit/stop orders' },
      riskPct: { type: 'number', description: '% of equity to risk (default and maximum: the policy limit)' },
      thesis: { type: 'string', description: 'why: the setup, the catalyst, what would prove it wrong' },
      confidence: { type: 'number', minimum: 0, maximum: 1 }, strategy: { type: 'string' }, timeframe: { type: 'string' } } },
    run: async (args) => {
      if (!desk) return unavailable;
      if (!agentId) return { content: 'REFUSED: this run has no crew identity, so it cannot file a proposal.', summary: 'refused' };
      const a = args || {};
      if (!String(a.thesis || '').trim()) return { content: 'REFUSED: a proposal needs a thesis — the setup, the catalyst and what would prove it wrong.', summary: 'refused' };
      if (!desk.service.quote(a.symbol)) await desk.pump();
      // agentId and source come from THIS run, never from the arguments
      const t = desk.service.propose({ source: 'agent', agentId, symbol: a.symbol, side: a.side, stop: a.stop, takeProfit: a.takeProfit, orderType: a.orderType, entry: a.entry,
        riskPct: a.riskPct, thesis: a.thesis, confidence: a.confidence, strategy: a.strategy, timeframe: a.timeframe });
      const out = { ticketId: t.id, status: t.status, note: t.note, symbol: t.symbol, side: t.side, entry: t.entry, stop: t.stop, takeProfit: t.takeProfit, lots: t.lots,
        risk: t.risk ? { ok: t.risk.ok, violations: t.risk.violations, riskPct: t.risk.metrics && t.risk.metrics.riskPct, rewardRisk: t.risk.metrics && t.risk.metrics.rewardRisk } : null };
      const next = t.status === 'awaiting-council' ? ' Next: the Bull and Bear advocates argue it (trading.argue).' : t.status === 'awaiting-approval' ? ' Next: it waits for the Commander\'s approval — tell them it is in APPROVALS.' : t.status === 'executed' ? ' It was filled on the PAPER account.' : '';
      return { content: JSON.stringify(out) + next, summary: 'ticket ' + t.id + ' ' + t.status };
    }
  };

  const argue = {
    name: 'trading.argue', capability: 'trading', impact: 'none', scope: 'write', requiresConsent: false, timeoutMs: 10000,
    description: 'Argue on the Trading Council: role "bull" makes the strongest HONEST case FOR a waiting ticket, role "bear" '
      + 'the strongest honest case AGAINST it (risks, upcoming events, crowded positioning, correlation with open trades). '
      + 'A ticket moves on once both sides have spoken. Find waiting tickets with trading.desk.',
    schema: { type: 'object', required: ['ticketId', 'role', 'text'], properties: {
      ticketId: { type: 'string' }, role: { type: 'string', enum: ['bull', 'bear'] }, text: { type: 'string', description: 'your argument, with evidence' } } },
    run: async (args) => {
      if (!desk) return unavailable;
      const a = args || {};
      const res = desk.service.argue(String(a.ticketId || ''), { role: a.role, text: a.text, agentId: agentId || a.role });
      if (!res.ok) return { content: 'REFUSED: ' + res.error, summary: 'refused' };
      return { content: 'Argument recorded on ' + res.ticket.id + '. The ticket is now ' + res.ticket.status + '.', summary: res.ticket.id + ' ' + res.ticket.status };
    }
  };

  const backtest = {
    name: 'trading.backtest', capability: 'trading', impact: 'none', scope: 'read', requiresConsent: false, timeoutMs: 60000, deferred: true,
    description: 'Backtest a built-in strategy (ema-cross, rsi-reversion, donchian-breakout) on an instrument, with real costs, '
      + 'next-bar fills and an optional walk-forward overfitting check. Results on SIMULATED candles prove nothing about a '
      + 'real market — say so when you report them.',
    schema: { type: 'object', required: ['symbol', 'strategy'], properties: {
      symbol: { type: 'string' }, strategy: { type: 'string', enum: Strategies.LIST.map(s => s.id) }, params: { type: 'object' },
      granularity: { type: 'string', enum: GRAN }, bars: { type: 'integer', minimum: 300, maximum: 5000 }, walkForward: { type: 'boolean' } } },
    run: async (args) => {
      if (!desk) return unavailable;
      const a = args || {};
      const sym = I.normalize(a.symbol);
      if (!sym) return { content: 'unknown symbol: ' + a.symbol, summary: 'refused' };
      const c = await desk.candles(sym, GRAN.indexOf(a.granularity) >= 0 ? a.granularity : 'H1', Math.min(5000, Math.max(300, Number(a.bars) || 2000)));
      if (c.error) return { content: c.error, summary: 'no data' };
      const opts = { symbol: sym, candles: c.candles, strategy: a.strategy, params: a.params || {}, rates: desk.service._paper.rates() };
      const res = Backtest.run(opts);
      if (!res.ok) return { content: 'Backtest refused: ' + res.error, summary: 'refused' };
      const out = { symbol: sym, strategy: res.strategy, params: res.params, bars: res.bars, simulatedData: c.simulated, metrics: res.metrics, skipped: res.skipped, caveats: (c.simulated ? ['SIMULATED DATA — proves nothing about a real market.'] : []).concat(res.caveats) };
      if (a.walkForward) { const w = Backtest.walkForward(opts); out.walkForward = w.ok ? { verdict: w.verdict, flags: w.flags, inSample: w.inSample.metrics, outOfSample: w.outOfSample.metrics } : { error: w.error }; }
      return { content: JSON.stringify(out), summary: res.strategy + ' on ' + sym + ': ' + res.metrics.n + ' trades' };
    }
  };

  const tools = [market, deskTool, propose, argue, backtest];
  return { tools, register(reg) { for (const t of tools) reg.register(t); return reg; } };
}

module.exports = { makeTradingTools };
