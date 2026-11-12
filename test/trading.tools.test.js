/* node test/trading.tools.test.js — the crew's trading tools: they read, they propose, they argue — and nothing more. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), path = require('path'), os = require('os');
const { makeTradingRoutes } = require('../sidecar/trading/routes.js');
const { makeTradingTools } = require('../sidecar/tools/builtin/trading.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tools-'));
const desk = makeTradingRoutes({ fs, path, dir, readBody: async () => '', respondJson: () => {}, noDriver: true, log: () => {} });
function toolsFor(agentId) { const reg = new Map(); makeTradingTools({ desk, agentId }).register({ register: t => reg.set(t.name, t) }); return reg; }
const J = r => JSON.parse(r.content.split('}. Next:')[0].replace(/\}[^}]*$/, '}'));

(async () => {
  try {
    const metals = toolsFor('metals-1'), bull = toolsFor('bull-1'), bear = toolsFor('bear-1');
    A.eq(Array.from(metals.keys()), ['trading.market', 'trading.desk', 'trading.propose', 'trading.argue', 'trading.backtest', 'trading.blackout'], 'six tools');
    for (const t of metals.values()) {
      A.eq([t.capability, t.impact, t.requiresConsent], ['trading', 'none', false], t.name + ': the trading capability, no outside effect, no per-call card');
      A.ok(t.description.length > 60 && t.schema && t.schema.type === 'object', t.name + ' is described with a schema');
    }
    // every tool is granted on the always-present computer object
    const grants = CAP_REGISTRY.computer.filter(g => g.capId === 'trading').map(g => g.tool);
    A.eq(grants, ['trading.market', 'trading.desk', 'trading.propose', 'trading.argue', 'trading.backtest', 'trading.blackout'], 'all six are granted on the computer object');
    // and NO tool reaches a limit, a setting, the kill switch or a broker
    const all = Object.values(CAP_REGISTRY).flat().map(g => g.tool).filter(t => /^trading\./.test(t));
    A.ok(all.every(t => /^trading\.(market|desk|propose|argue|backtest|blackout)$/.test(t)), 'no trading tool can halt, resume, loosen policy, change settings, or connect a broker: ' + all.join(','));

    // ---- read ----
    const m = JSON.parse((await metals.get('trading.market').run({ symbol: 'gold', granularity: 'H1', bars: 30 })).content);
    A.ok(/SIMULATED/.test(m.feed), 'the market read says the prices are simulated');
    A.ok(m.quotes.XAUUSD && m.quotes.XAUUSD.ask > m.quotes.XAUUSD.bid, 'gold is quoted');
    A.eq([m.analysis.symbol, m.analysis.contractSize, m.analysis.candles.length, m.analysis.simulated], ['XAUUSD', 100, 30, true], 'candles + facts for one symbol');
    A.ok(m.analysis.rsi14 >= 0 && m.analysis.rsi14 <= 100 && m.analysis.atr14 > 0 && m.analysis.sma200 > 0, 'indicator readings are computed');
    A.ok(/unknown symbol/.test((await metals.get('trading.market').run({ symbol: 'NOPE' })).content), 'unknown symbol is said plainly');

    // ---- propose: it is THIS agent's ticket, whatever the arguments say ----
    const q = m.quotes.XAUUSD;
    let r = await metals.get('trading.propose').run({ symbol: 'XAUUSD', side: 'buy', stop: Number((q.bid - 20).toFixed(2)), takeProfit: Number((q.ask + 40).toFixed(2)), thesis: 'Higher low on H1, dollar softening.', confidence: 0.6, agentId: 'riskmanager', source: 'human' });
    const t1 = J(r);
    A.eq(t1.status, 'awaiting-council', 'the proposal waits for the Council: ' + r.content.slice(0, 200));
    A.ok(/trading\.argue/.test(r.content), 'and the tool says what happens next');
    const ticket = desk.service.ticket(t1.ticketId);
    A.eq([ticket.agentId, ticket.source], ['metals-1', 'agent'], 'the ticket is the CALLING agent\'s — an agentId or source in the arguments is ignored');
    A.ok(/no stop-loss/.test((await metals.get('trading.propose').run({ symbol: 'XAUUSD', side: 'buy', thesis: 'x' })).content), 'no stop -> vetoed with the reason');
    A.ok(/needs a thesis/.test((await metals.get('trading.propose').run({ symbol: 'XAUUSD', side: 'buy', stop: 1 })).content), 'no thesis -> refused');
    A.ok(/no crew identity/.test((await toolsFor('').get('trading.propose').run({ symbol: 'XAUUSD', side: 'buy', stop: 1, thesis: 'x' })).content), 'a run with no agent cannot propose');

    // ---- the Council ----
    r = await bull.get('trading.argue').run({ ticketId: t1.ticketId, role: 'bull', text: 'Momentum and a clean higher low.' });
    A.ok(/awaiting-council/.test(r.content), 'one side heard');
    r = await bear.get('trading.argue').run({ ticketId: t1.ticketId, role: 'bear', text: 'CPI tomorrow.' });
    A.ok(/awaiting-approval/.test(r.content), 'both sides heard -> waits for the Commander');
    A.eq(desk.service.ticket(t1.ticketId).council.map(c => c.agentId), ['bull-1', 'bear-1'], 'each argument is credited to the agent that made it');
    A.ok(/REFUSED/.test((await bull.get('trading.argue').run({ ticketId: 'K999', role: 'bull', text: 'x' })).content), 'arguing a missing ticket is refused');
    A.ok(/REFUSED/.test((await bull.get('trading.argue').run({ ticketId: t1.ticketId, role: 'judge', text: 'x' })).content), 'only bull or bear');

    // ---- no tool can approve its own idea ----
    A.eq(desk.service.ticket(t1.ticketId).status, 'awaiting-approval', 'the ticket still waits for a human');
    A.eq(desk.service.snapshot().positions.length, 0, 'and nothing has traded');

    // ---- desk read shows the agent its own level ----
    const d = JSON.parse((await metals.get('trading.desk').run({})).content);
    A.eq([d.venue, d.you.agentId, d.you.level, d.waiting.length], ['paper', 'metals-1', 'active', 1], 'the desk read shows the paper venue, this agent, its level and the waiting ticket');
    desk.service.coachCommand('metals-1', 'bench');
    A.ok(/benched/.test(JSON.parse((await metals.get('trading.propose').run({ symbol: 'XAUUSD', side: 'buy', stop: Number((q.bid - 20).toFixed(2)), thesis: 'again' })).content.replace(/\}[^}]*$/, '}')).note), 'a benched agent\'s proposal is rejected by the desk');

    // ---- blackout: an agent can add one (tightening), never lift one ----
    const bl = await metals.get('trading.blackout').run({ label: 'FOMC', start: new Date(Date.now() - 1000).toISOString(), end: new Date(Date.now() + 3600000).toISOString(), assetClasses: ['metals'] });
    A.ok(/Blackout B\d+ set: FOMC/.test(bl.content), 'an agent adds a blackout');
    A.eq(desk.service.snapshot().blackouts[0].by, 'metals-1', 'credited to the calling agent');
    A.ok(/REFUSED/.test((await metals.get('trading.blackout').run({ label: 'x', start: 'nope', end: 'nope' })).content), 'bad dates are refused');

    // ---- backtest ----
    const b = JSON.parse((await metals.get('trading.backtest').run({ symbol: 'XAUUSD', strategy: 'ema-cross', bars: 1200, walkForward: true })).content);
    A.eq(b.simulatedData, true, 'backtest says its data is simulated');
    A.ok(/SIMULATED DATA/.test(b.caveats[0]), 'and puts that first in its caveats');
    A.ok(b.walkForward && b.walkForward.verdict, 'walk-forward included');
  } finally { desk.stopDriver(); fs.rmSync(dir, { recursive: true, force: true }); }
  A.report('trading.tools');
})().catch(e => { console.log('FAIL: trading.tools threw — ' + (e && e.stack || e)); process.exit(1); });
