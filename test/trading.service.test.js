/* node test/trading.service.test.js — the whole pipeline: propose -> risk -> council -> approval -> paper fill -> coach. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), path = require('path'), os = require('os');
const { createService, APPROVAL_TTL_MS } = require('../sidecar/trading/service.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-svc-'));
let clock = Date.UTC(2026, 10, 11, 15, 0, 0);
const now = () => clock;
const mk = () => createService({ fs, path, dir, now });
function prices(svc, goldBid) { svc.tick('XAUUSD', goldBid, goldBid + 0.3); svc.tick('EURUSD', 1.08, 1.0801); svc.tick('USDJPY', 150, 150.02); }
const idea = extra => Object.assign({ source: 'agent', agentId: 'metals', symbol: 'XAUUSD', side: 'buy', stop: 2640, takeProfit: 2680, thesis: 'test', confidence: 0.6, strategy: 'test' }, extra || {});

try {
  let svc = mk();
  prices(svc, 2650);
  const snap0 = svc.snapshot();
  A.eq([snap0.venue, snap0.account.balance, snap0.settings.country, snap0.settings.autonomy, snap0.settings.requireCouncil], ['paper', 10000, 'CA', 'approve-all', true], 'safe defaults: paper venue, Canada, approve every trade, Council required');
  A.eq(snap0.policy.riskPerTradePct, 1, 'default 1% per trade');

  // ---- an agent idea: sized by risk, waits for the Council, then for the Commander ----
  let t = svc.propose(idea());
  A.eq(t.status, 'awaiting-council', 'an agent idea waits for the Bull and Bear');
  A.eq(t.entry, 2650.3, 'entry = the current ask');
  A.eq(t.lots, 0.09, 'sized by risk: $100 / ($10.30 x 100 oz) = 0.097 -> 0.09 (rounded DOWN)');
  A.eq(t.risk.ok, true, 'the risk engine passed it');
  A.eq(svc.argue(t.id, { role: 'bull', text: 'Breakout above resistance, dollar weakening.' }).ticket.status, 'awaiting-council', 'one side of the debate is not enough');
  A.eq(svc.argue(t.id, { role: 'judge', text: 'x' }).ok, false, 'only bull or bear may argue');
  A.eq(svc.argue(t.id, { role: 'bear', text: 'CPI tomorrow; crowded long.' }).ticket.status, 'awaiting-approval', 'both sides heard -> waits for the Commander');
  A.eq(svc.snapshot().positions.length, 0, 'nothing has traded yet');
  A.eq(svc.decide(t.id, { approve: true }).ticket.status, 'executed', 'the Commander approves -> it executes');
  let pos = svc.snapshot().positions;
  A.eq([pos.length, pos[0].symbol, pos[0].lots, pos[0].stop, pos[0].agentId], [1, 'XAUUSD', 0.09, 2640, 'metals'], 'a real paper position with its stop, credited to the Metals Specialist');
  A.eq(svc.decide(t.id, { approve: true }).ok, false, 'a ticket cannot be approved twice');
  A.eq(svc.argue(t.id, { role: 'bull', text: 'late' }).ok, false, 'the debate closes when the ticket is decided');

  // ---- the stop-loss law and the risk engine ----
  t = svc.propose(idea({ stop: undefined }));
  A.eq([t.status, t.risk.violations[0].code], ['vetoed', 'no-stop'], 'no stop -> vetoed');
  t = svc.propose(idea({ lots: 0.5 }));
  A.eq(t.status, 'vetoed', 'an oversized explicit size is vetoed by the risk engine');
  A.ok(/limit is 1%/.test(t.note), 'and says why: ' + t.note);
  t = svc.propose(idea({ symbol: 'NOPE' }));
  A.eq(t.status, 'rejected', 'unknown instrument');
  t = svc.propose(idea({ agentId: '' }));
  A.eq(t.status, 'rejected', 'an agent idea must say who it is from');
  const sb = svc.scorecards().agents.metals.status;
  A.eq(sb.level, 'retrain', 'two rule-breaking proposals (no stop, oversized) send the Metals Specialist to retrain');
  A.ok(/2 proposals broke the risk rules/.test(sb.history[sb.history.length - 1].reason), 'and its history says why');

  // ---- the Commander's own trade skips the Council and approval, never the risk engine ----
  t = svc.propose({ source: 'human', symbol: 'EURUSD', side: 'sell', stop: 1.0850, takeProfit: 1.0700 });
  A.eq([t.status, t.agentId], ['executed', 'commander'], 'a Commander ticket executes straight away');
  t = svc.propose({ source: 'human', symbol: 'EURUSD', side: 'sell', stop: 1.0850, lots: 5 });
  A.eq(t.status, 'vetoed', 'but the risk engine still vetoes it when it is too big');

  // ---- stop-out -> Coach bookkeeping ----
  const ev = svc.tick('XAUUSD', 2639, 2639.3);
  A.eq(ev.length, 1, 'the gold stop triggers');
  const card = svc.scorecards().agents.metals;
  A.eq([card.card.n, card.card.losses], [1, 1], 'the loss lands on the Metals Specialist\'s scorecard');
  A.eq(card.status.level, 'retrain', 'still in retrain after one loss (every trade needs approval)');

  // ---- the kill switch ----
  const h = svc.halt('drill');
  A.eq([h.ok, svc.snapshot().positions.length, svc.halted().on], [true, 0, true], 'the kill switch flattens the account');
  t = svc.propose({ source: 'human', symbol: 'EURUSD', side: 'buy', stop: 1.07 });
  A.eq([t.status, /kill switch/.test(t.note)], ['rejected', true], 'nothing new while halted, not even from the Commander');
  A.eq(svc.resume('crew').ok, false, 'only the Commander can resume');
  A.eq(svc.resume('commander').ok, true, 'the Commander resumes');

  // ---- the policy: tighten freely, loosen only as the Commander ----
  A.eq(svc.setPolicy({ riskPerTradePct: 0.5 }).ok, true, 'tightening is allowed');
  A.eq(svc.setPolicy({ riskPerTradePct: 2 }).ok, false, 'loosening without the Commander is refused');
  A.eq(svc.setPolicy({ riskPerTradePct: 1 }, { commander: true }).policy.riskPerTradePct, 1, 'the Commander can loosen back');
  A.eq(svc.setPolicy({ requireStop: false }, { commander: true }).ok, false, 'nobody can switch off the stop-loss law');

  // ---- approvals expire: a price from 30 minutes ago is stale ----
  svc.coachCommand('fx', 'set', 'active');
  t = svc.propose(idea({ agentId: 'fx', symbol: 'EURUSD', side: 'buy', stop: 1.0750, takeProfit: 1.0900 }));
  svc.argue(t.id, { role: 'bull', text: 'a' }); svc.argue(t.id, { role: 'bear', text: 'b' });
  A.eq(svc.ticket(t.id).status, 'awaiting-approval', 'waiting for approval');
  clock += APPROVAL_TTL_MS + 1000;
  A.eq(svc.decide(t.id, { approve: true }).ok, false, 'too late to approve');
  A.eq(svc.ticket(t.id).status, 'expired', 'the ticket expired');

  // ---- autonomy: a PROMOTED bot may execute without a tap only when the Commander chose 'earned' ----
  A.eq(svc.setSettings({ autonomy: 'yolo' }).ok, false, 'an unknown autonomy mode is refused');
  svc.setSettings({ autonomy: 'earned', requireCouncil: false });
  t = svc.propose(idea({ agentId: 'fx', symbol: 'EURUSD', side: 'buy', stop: 1.0750, takeProfit: 1.0900 }));
  A.eq(t.status, 'awaiting-approval', '"earned" mode: an un-promoted bot still needs a tap');
  svc.decide(t.id, { approve: false, note: 'not today' });
  A.eq(svc.ticket(t.id).status, 'rejected', 'the Commander can reject');
  svc.coachCommand('fx', 'promote');
  t = svc.propose(idea({ agentId: 'fx', symbol: 'EURUSD', side: 'buy', stop: 1.0750, takeProfit: 1.0900 }));
  A.eq(t.status, 'executed', 'a promoted bot executes in-limit trades on its own in "earned" mode');
  svc.coachCommand('fx', 'set', 'probation');
  t = svc.propose(idea({ agentId: 'fx', symbol: 'EURUSD', side: 'sell', stop: 1.0850, takeProfit: 1.0700 }));
  A.eq([t.status, t.sizing.multiplier], ['awaiting-approval', 0.5], 'a bot on probation is back to half size and approval');
  svc.decide(t.id, { approve: false });
  svc.coachCommand('fx', 'bench');
  A.eq(svc.propose(idea({ agentId: 'fx', symbol: 'EURUSD' })).status, 'rejected', 'a benched bot cannot propose');

  // ---- TradingView ----
  A.eq(svc.tradingViewAlert('{"secret":"x"}').status, 503, 'alerts are off until a secret is set');
  A.eq(svc.setSettings({ tvSecret: 'short' }).ok, false, 'a short secret is refused');
  svc.setSettings({ tvSecret: 'a-long-webhook-secret' });
  A.eq(svc.settings().tvSecret, undefined, 'the secret is never returned');
  A.eq(svc.settings().tvSecretSet, true, 'only whether it is set');
  const alert = JSON.stringify({ secret: 'a-long-webhook-secret', symbol: 'OANDA:XAUUSD', action: 'buy', price: 2650, stopPct: 0.5, takeProfitPct: 1, strategy: 'tv', time: '1' });
  const tv = svc.tradingViewAlert(alert);
  A.eq([tv.ok, tv.kind, tv.ticket.source, tv.ticket.agentId], [true, 'entry', 'tradingview', 'tradingview'], 'an alert becomes a ticket from TradingView');
  A.eq(tv.ticket.status, 'awaiting-approval', 'and waits for the Commander like any idea: ' + tv.ticket.note);
  A.eq(svc.tradingViewAlert(alert).duplicate, true, 'the same alert twice is ignored');
  A.eq(svc.tradingViewAlert(alert.replace('a-long-webhook-secret', 'wrong-but-long-enough')).status, 401, 'a wrong secret is refused');
  A.ok(svc.journal().every(e => JSON.stringify(e).indexOf('a-long-webhook-secret') < 0), 'the secret never reaches the journal');

  A.ok(tv.ticket.lots > 0 && tv.ticket.risk.ok, 'a tight-stop alert is sized down to fit the leverage rules instead of being vetoed');
  A.ok(/leverage limits/.test(tv.ticket.sizingNote || ''), 'and the ticket says its size was cut: ' + tv.ticket.sizingNote);

  // ---- event blackouts ----
  {
    const iso = ms => new Date(ms).toISOString();
    A.eq(svc.addBlackout({ label: 'US CPI', start: iso(clock + 3600000), end: iso(clock) }, 'macro-1').ok, false, 'a blackout must end after it starts');
    A.eq(svc.addBlackout({ label: '', start: iso(clock), end: iso(clock + 60000) }, 'macro-1').ok, false, 'a blackout needs a name');
    A.eq(svc.addBlackout({ label: 'x', start: iso(clock), end: iso(clock + 8 * 86400000) }, 'macro-1').ok, false, 'at most 7 days');
    const b = svc.addBlackout({ label: 'US CPI', start: iso(clock - 60000), end: iso(clock + 30 * 60000), assetClasses: ['metals', 'forex'] }, 'researcher-1');
    A.eq([b.ok, b.blackout.by], [true, 'researcher-1'], 'a crew member can add a blackout (it only tightens)');
    svc.setSettings({ autonomy: 'approve-all' });
    const blocked = svc.propose({ source: 'human', symbol: 'XAUUSD', side: 'buy', stop: 2600 });
    A.ok(blocked.status === 'rejected' && /Event blackout: US CPI/.test(blocked.note), 'gold is blocked during the CPI blackout: ' + blocked.note);
    const free = svc.propose({ source: 'human', symbol: 'BTCUSD', side: 'buy', stop: 1 });
    A.ok(!/blackout/.test(free.note), 'a class outside the blackout is not blocked by it');
    A.eq(svc.snapshot().blackouts.length, 1, 'the desk lists the active blackout');
    A.eq(svc.removeBlackout(b.blackout.id, 'researcher-1').ok, false, 'only the Commander can lift a blackout');
    A.eq(svc.removeBlackout(b.blackout.id, 'commander').ok, true, 'the Commander lifts it');
    A.eq(svc.snapshot().blackouts.length, 0, 'gone');
  }

  // ---- persistence: a restart keeps everything ----
  const before = svc.snapshot();
  svc = mk();
  const after = svc.snapshot();
  A.eq([after.account.balance, after.positions.length, after.tickets.length, after.settings.autonomy, after.halted.on], [before.account.balance, before.positions.length, before.tickets.length, 'approve-all', false], 'a restart restores the account, tickets and settings');
  A.eq(svc.scorecards().agents.fx.status.level, 'benched', 'and the Coach\'s decisions');
  A.eq(svc.verifyJournal().ok, true, 'the journal chain is intact across the restart');
  A.ok(svc.journal().length > 20, 'every step was journalled (' + svc.journal().length + ' entries)');

  // ---- paper reset ----
  const r = svc.resetPaper(25000);
  A.eq([r.account.balance, r.account.openPositions], [25000, 0], 'the paper account can be reset to a new balance');
  A.eq(svc.verifyJournal().ok, true, 'the journal keeps the history through a reset');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
A.report('trading.service');
