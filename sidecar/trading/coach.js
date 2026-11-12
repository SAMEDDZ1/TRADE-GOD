/* sidecar/trading/coach.js — the AGENT COACH's ladder, as plain rules.

   The Agent Coach character explains, reviews and writes playbook rules (that part is an AI). But WHETHER a bot
   is on probation, trading half size, sent back to paper or benched is decided here, by arithmetic over its
   scorecard — so a persuasive bot cannot talk its way out of a slump, and a moody model cannot bench a good one.

   THE LADDER (worst last). Each level changes what the bot is allowed to do — see EFFECTS:
     active     normal trading
     review     flagged: the Coach walks through its losing trades with it          (3 losses in a row)
     retrain    every trade needs the Commander's approval                           (slumps again, or breaks rules)
     probation  HALF size + approval on every trade                                  (drawdown / poor profit factor)
     practice   PAPER ONLY until it re-earns live trading                            (keeps losing on probation)
     benched    cannot propose trades at all                                         (fails practice)

   Rules of the ladder
     • DOWN is automatic (it only ever tightens). UP past 'active' — a PROMOTION — is only ever a recommendation:
       it loosens, so the Commander decides.
     • One step at a time, except a drawdown breach, which jumps straight to probation (safety beats ceremony).
     • A bot climbs back one step at a time by trading well at its current level.
     • A bot the COMMANDER benched stays benched until the Commander reinstates it. The Coach cannot undo that.
     • Nothing here can touch the risk policy. The Coach coaches the players, not the referee.

   evaluate() is pure: (scorecards, status, config) -> decision. Unit-tested in test/trading.coach.test.js. */
'use strict';

const LEVELS = ['active', 'review', 'retrain', 'probation', 'practice', 'benched'];

const EFFECTS = Object.freeze({
  active:    Object.freeze({ canPropose: true,  sizeMultiplier: 1,   requireApproval: false, paperOnly: false }),
  review:    Object.freeze({ canPropose: true,  sizeMultiplier: 1,   requireApproval: false, paperOnly: false }),
  retrain:   Object.freeze({ canPropose: true,  sizeMultiplier: 1,   requireApproval: true,  paperOnly: false }),
  probation: Object.freeze({ canPropose: true,  sizeMultiplier: 0.5, requireApproval: true,  paperOnly: false }),
  practice:  Object.freeze({ canPropose: true,  sizeMultiplier: 1,   requireApproval: false, paperOnly: true }),
  benched:   Object.freeze({ canPropose: false, sizeMultiplier: 0,   requireApproval: true,  paperOnly: true })
});

const DEFAULT_CONFIG = Object.freeze({
  reviewStreak: 3,          // losses in a row -> review
  probationDdPct: 5,        // drawdown (% of base equity) since the level began -> probation
  practiceDdPct: 3,         // further drawdown while on probation (already at half size) -> practice
  minSample: 10,            // trades needed before a profit-factor judgment counts
  recoverSample: 5,         // profitable trades-window needed to climb out of review / retrain
  promote: Object.freeze({ minTrades: 20, profitFactor: 1.5, maxDrawdownPct: 3, maxBrier: 0.25 })
});

function freshStatus(ts) {
  return { level: 'active', since: Number(ts) || 0, promoted: false, benchedBy: '', ruleBreaks: 0, tradesAtLevelStart: 0, history: [] };
}
function effects(status) {
  const base = EFFECTS[(status && status.level) || 'active'] || EFFECTS.active;
  // a PROMOTED bot has earned autonomy: its in-limit trades may execute without a tap when the desk's autonomy mode allows it.
  return Object.assign({}, base, { autoApprove: !!(status && status.promoted && status.level === 'active') });
}

/* cards: { all: scorecard over every trade, recent: scorecard over trades closed since status.since }.
   Returns { next: <level> | null, promote: boolean, demotePromotion: boolean, reasons: [string] }. */
function evaluate(cards, statusIn, configIn) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, configIn || {}, { promote: Object.assign({}, DEFAULT_CONFIG.promote, (configIn && configIn.promote) || {}) });
  const status = statusIn || freshStatus(0);
  const all = (cards && cards.all) || {}, recent = (cards && cards.recent) || {};
  const out = { next: null, promote: false, demotePromotion: false, reasons: [] };
  const level = status.level;
  if (level === 'benched') return out;                                   // only the Commander moves a benched bot

  const streak = Number(recent.currentLosingStreak) || 0;
  const dd = recent.maxDrawdownPct == null ? null : Number(recent.maxDrawdownPct);
  const n = Number(recent.n) || 0;
  const pf = recent.profitFactor == null ? null : Number(recent.profitFactor);
  const net = Number(recent.netPnl) || 0;
  const breaks = Number(status.ruleBreaks) || 0;
  const down = (to, why) => { out.next = to; out.reasons.push(why); if (status.promoted) out.demotePromotion = true; return out; };
  const up = (to, why) => { out.next = to; out.reasons.push(why); return out; };

  // ---- the safety jump: a drawdown breach goes straight to probation from any lighter level ----
  if ((level === 'active' || level === 'review' || level === 'retrain') && dd != null && dd >= cfg.probationDdPct) {
    return down('probation', 'drawdown of ' + dd + '% since ' + level + ' began (limit ' + cfg.probationDdPct + '%)');
  }
  if (level === 'active') {
    if (streak >= cfg.reviewStreak) return down('review', streak + ' losses in a row');
    if (breaks >= 2) return down('retrain', breaks + ' proposals broke the risk rules');
    const p = cfg.promote;
    if (!status.promoted && (Number(all.n) || 0) >= p.minTrades && all.profitFactor != null && all.profitFactor >= p.profitFactor
        && all.maxDrawdownPct != null && all.maxDrawdownPct <= p.maxDrawdownPct && breaks === 0
        && (all.brier == null || all.brier <= p.maxBrier)) {
      out.promote = true;
      out.reasons.push(all.n + ' trades, profit factor ' + all.profitFactor + ', max drawdown ' + all.maxDrawdownPct + '%, no rule breaks');
    }
    return out;
  }
  if (level === 'review') {
    if (streak >= cfg.reviewStreak) return down('retrain', 'another ' + streak + ' losses in a row while under review');
    if (breaks >= 2) return down('retrain', breaks + ' proposals broke the risk rules');
    if (n >= cfg.recoverSample && net > 0) return up('active', n + ' trades since the review, net positive');
    return out;
  }
  if (level === 'retrain') {
    if (streak >= cfg.reviewStreak) return down('probation', streak + ' losses in a row after retraining');
    if (n >= cfg.minSample && pf != null && pf < 0.7) return down('probation', 'profit factor ' + pf + ' over ' + n + ' trades after retraining');
    if (n >= cfg.recoverSample && net > 0) return up('active', n + ' trades since retraining, net positive');
    return out;
  }
  if (level === 'probation') {
    if (dd != null && dd >= cfg.practiceDdPct) return down('practice', 'a further ' + dd + '% drawdown while on probation (limit ' + cfg.practiceDdPct + '%)');
    if (streak >= cfg.reviewStreak + 1) return down('practice', streak + ' losses in a row on probation');
    if (n >= cfg.minSample && pf != null && pf < 0.8) return down('practice', 'profit factor ' + pf + ' over ' + n + ' trades on probation');
    if (n >= cfg.minSample && pf != null && pf >= 1.2 && net > 0) return up('active', n + ' probation trades at profit factor ' + pf);
    return out;
  }
  if (level === 'practice') {
    if (n >= cfg.minSample && (net <= 0 || (pf != null && pf < 1))) return down('benched', n + ' paper trades without a profit (profit factor ' + (pf == null ? 'n/a' : pf) + ')');
    if (n >= cfg.minSample && pf != null && pf >= 1.3 && net > 0) return up('probation', n + ' paper trades at profit factor ' + pf + ' — live trading re-earned at half size');
    return out;
  }
  return out;
}

// apply an evaluate() decision. Promotions are NOT applied here (they need the Commander — see commanderSet).
function apply(statusIn, decision, ts, tradeCount) {
  const status = Object.assign(freshStatus(ts), statusIn || {});
  status.history = (status.history || []).slice(-49);
  if (!decision || !decision.next || decision.next === status.level) return status;
  if (LEVELS.indexOf(decision.next) < 0) return status;
  status.history.push({ ts: Number(ts) || 0, from: status.level, to: decision.next, by: 'coach', reason: (decision.reasons || []).join('; ') });
  status.level = decision.next; status.since = Number(ts) || 0; status.ruleBreaks = 0;
  status.tradesAtLevelStart = Number(tradeCount) || 0;
  if (decision.demotePromotion) status.promoted = false;
  if (decision.next === 'benched') status.benchedBy = 'coach';
  return status;
}

/* The Commander's own moves: bench a bot, reinstate one, or accept / revoke a promotion.
   action: 'bench' | 'reinstate' | 'promote' | 'unpromote' | 'set' (with level). */
function commanderSet(statusIn, action, ts, tradeCount, level) {
  const status = Object.assign(freshStatus(ts), statusIn || {});
  status.history = (status.history || []).slice(-49);
  const move = (to, reason) => {
    status.history.push({ ts: Number(ts) || 0, from: status.level, to, by: 'commander', reason });
    status.level = to; status.since = Number(ts) || 0; status.ruleBreaks = 0; status.tradesAtLevelStart = Number(tradeCount) || 0;
  };
  if (action === 'bench') { move('benched', 'benched by the Commander'); status.benchedBy = 'commander'; status.promoted = false; }
  else if (action === 'reinstate') { if (status.level === 'benched') { move('practice', 'reinstated by the Commander — starts in paper practice'); status.benchedBy = ''; } }
  else if (action === 'promote') { if (status.level === 'active') { status.promoted = true; status.history.push({ ts: Number(ts) || 0, from: 'active', to: 'active', by: 'commander', reason: 'promoted: earned autonomy' }); } }
  else if (action === 'unpromote') { status.promoted = false; }
  else if (action === 'set' && LEVELS.indexOf(level) >= 0) { move(level, 'set by the Commander'); status.benchedBy = level === 'benched' ? 'commander' : ''; if (level !== 'active') status.promoted = false; }
  return status;
}

module.exports = { LEVELS, EFFECTS, DEFAULT_CONFIG, freshStatus, effects, evaluate, apply, commanderSet };
