/* node test/trading.coach.test.js — the Agent Coach's ladder is rules, not moods. */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/trading/coach.js');

const card = o => Object.assign({ n: 0, netPnl: 0, profitFactor: null, maxDrawdownPct: 0, currentLosingStreak: 0, brier: null }, o || {});
const at = (level, extra) => Object.assign(C.freshStatus(1000), { level }, extra || {});
const ev = (recent, status, all) => C.evaluate({ all: card(all || recent), recent: card(recent) }, status);

// ---- what each level is allowed to do ----
A.eq(C.LEVELS, ['active', 'review', 'retrain', 'probation', 'practice', 'benched'], 'the ladder, worst last');
A.eq(C.effects(at('active')), { canPropose: true, sizeMultiplier: 1, requireApproval: false, paperOnly: false, autoApprove: false }, 'active: normal');
A.eq(C.effects(at('retrain')).requireApproval, true, 'retrain: every trade needs approval');
A.eq([C.effects(at('probation')).sizeMultiplier, C.effects(at('probation')).requireApproval], [0.5, true], 'probation: HALF size and approval');
A.eq(C.effects(at('practice')).paperOnly, true, 'practice: paper only');
A.eq(C.effects(at('benched')).canPropose, false, 'benched: cannot propose');
A.eq(C.effects(at('active', { promoted: true })).autoApprove, true, 'a promoted bot has earned autonomy');
A.eq(C.effects(at('probation', { promoted: true })).autoApprove, false, 'but only while it is active');

// ---- down the ladder ----
A.eq(ev({ n: 3, currentLosingStreak: 3, netPnl: -90 }, at('active')).next, 'review', '3 losses in a row -> review');
A.eq(ev({ n: 2, currentLosingStreak: 2, netPnl: -60 }, at('active')).next, null, '2 losses in a row is not a slump yet');
A.eq(ev({ n: 4, currentLosingStreak: 3 }, at('review')).next, 'retrain', 'slumps again under review -> retrain');
A.eq(ev({ n: 4, currentLosingStreak: 3 }, at('retrain')).next, 'probation', 'slumps again after retraining -> probation');
A.eq(ev({ n: 12, profitFactor: 0.6, netPnl: -200 }, at('retrain')).next, 'probation', 'poor profit factor over a real sample -> probation');
A.eq(ev({ n: 9, profitFactor: 0.1, netPnl: -200 }, at('retrain')).next, null, 'but 9 trades is too small a sample to judge a profit factor');
A.eq(ev({ n: 5, maxDrawdownPct: 3.2 }, at('probation')).next, 'practice', 'a further 3% drawdown on probation -> paper practice');
A.eq(ev({ n: 12, profitFactor: 0.7 }, at('probation')).next, 'practice', 'still losing on probation -> paper practice');
A.eq(ev({ n: 4, currentLosingStreak: 4 }, at('probation')).next, 'practice', '4 straight losses on probation -> paper practice');
A.eq(ev({ n: 10, profitFactor: 0.9, netPnl: -20 }, at('practice')).next, 'benched', 'cannot make money on paper -> benched');
A.eq(ev({ n: 9, profitFactor: 0.2, netPnl: -200 }, at('practice')).next, null, 'practice is judged on at least 10 paper trades');
// the safety jump: a drawdown breach skips the ceremony
for (const lvl of ['active', 'review', 'retrain']) A.eq(ev({ n: 6, maxDrawdownPct: 5 }, at(lvl)).next, 'probation', 'a 5% drawdown jumps straight to probation from ' + lvl);
A.eq(ev({ n: 6, maxDrawdownPct: 4.9 }, at('active')).next, null, 'under the drawdown limit: no jump');
// rule breaks are a coaching matter of their own
A.eq(C.evaluate({ all: card(), recent: card() }, at('active', { ruleBreaks: 2 })).next, 'retrain', 'two proposals that broke the risk rules -> retrain');
A.eq(C.evaluate({ all: card(), recent: card() }, at('active', { ruleBreaks: 1 })).next, null, 'one is a warning');

// ---- back up the ladder, one step at a time ----
A.eq(ev({ n: 5, netPnl: 40 }, at('review')).next, 'active', '5 net-positive trades clear a review');
A.eq(ev({ n: 4, netPnl: 400 }, at('review')).next, null, '4 trades is not enough to clear it');
A.eq(ev({ n: 5, netPnl: 40 }, at('retrain')).next, 'active', 'retraining is cleared the same way');
A.eq(ev({ n: 10, profitFactor: 1.3, netPnl: 90 }, at('probation')).next, 'active', 'a real sample at a good profit factor ends probation');
A.eq(ev({ n: 10, profitFactor: 1.1, netPnl: 9 }, at('probation')).next, null, 'a marginal one does not');
A.eq(ev({ n: 10, profitFactor: 1.4, netPnl: 120 }, at('practice')).next, 'probation', 'good paper results re-earn LIVE trading — at half size first');

// ---- benched bots only move when the Commander says so ----
A.eq(ev({ n: 50, profitFactor: 5, netPnl: 9999 }, at('benched')).next, null, 'nothing the Coach computes can un-bench a bot');

// ---- promotion is only ever a recommendation ----
{
  const great = { n: 25, profitFactor: 1.8, maxDrawdownPct: 2.1, netPnl: 900, brier: 0.2 };
  const d = ev(great, at('active'));
  A.eq([d.promote, d.next], [true, null], 'a strong record earns a promotion RECOMMENDATION (the level does not change by itself)');
  A.eq(ev(Object.assign({}, great, { n: 19 }), at('active')).promote, false, 'not before 20 trades');
  A.eq(ev(Object.assign({}, great, { maxDrawdownPct: 3.5 }), at('active')).promote, false, 'not with a deep drawdown');
  A.eq(ev(Object.assign({}, great, { brier: 0.4 }), at('active')).promote, false, 'not when it is confidently wrong');
  A.eq(C.evaluate({ all: card(great), recent: card(great) }, at('active', { ruleBreaks: 1 })).promote, false, 'not with a rule break on the record');
  A.eq(ev(great, at('active', { promoted: true })).promote, false, 'already promoted: nothing to recommend');
  const applied = C.apply(at('active'), d, 2000, 25);
  A.eq([applied.level, applied.promoted], ['active', false], 'apply() never promotes — that takes the Commander');
}
// ---- applying a move ----
{
  const s0 = at('active', { promoted: true, ruleBreaks: 1 });
  const d = ev({ n: 3, currentLosingStreak: 3 }, s0);
  const s1 = C.apply(s0, d, 5000, 12);
  A.eq([s1.level, s1.since, s1.ruleBreaks, s1.tradesAtLevelStart, s1.promoted], ['review', 5000, 0, 12, false], 'a demotion resets the window and removes the promotion');
  A.eq(s1.history[s1.history.length - 1], { ts: 5000, from: 'active', to: 'review', by: 'coach', reason: '3 losses in a row' }, 'and is written into the bot\'s history with the reason');
  A.eq(C.apply(s1, { next: null }, 6000, 13).level, 'review', 'no decision -> no change');
  A.eq(C.apply(s1, { next: 'nonsense' }, 6000, 13).level, 'review', 'an unknown level is ignored');
  A.eq(C.apply(at('practice'), { next: 'benched', reasons: ['x'] }, 7000, 30).benchedBy, 'coach', 'a Coach benching is marked as the Coach\'s');
}
// ---- the Commander's own moves ----
{
  const b = C.commanderSet(at('active', { promoted: true }), 'bench', 9000, 40);
  A.eq([b.level, b.benchedBy, b.promoted], ['benched', 'commander', false], 'the Commander can bench anyone');
  const r = C.commanderSet(b, 'reinstate', 9500, 40);
  A.eq([r.level, r.benchedBy], ['practice', ''], 'a reinstated bot starts in paper practice, not straight back to live');
  A.eq(C.commanderSet(at('active'), 'reinstate', 1, 0).level, 'active', 'reinstate only applies to a benched bot');
  A.eq(C.commanderSet(at('active'), 'promote', 1, 0).promoted, true, 'the Commander accepts a promotion');
  A.eq(C.commanderSet(at('probation'), 'promote', 1, 0).promoted, false, 'but not for a bot that is not active');
  A.eq(C.commanderSet(at('active', { promoted: true }), 'unpromote', 1, 0).promoted, false, 'and can take it back');
  A.eq(C.commanderSet(at('active'), 'set', 1, 0, 'probation').level, 'probation', 'or set any level directly');
  A.eq(C.commanderSet(at('active'), 'set', 1, 0, 'godmode').level, 'active', 'an unknown level is ignored');
}
A.report('trading.coach');
