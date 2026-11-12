/* sidecar/trading/risk.js — the TRADE GOD risk engine. PLAIN CODE, NOT AI.

   The product law this file exists for: an AI may PROPOSE anything, but no order reaches a broker (paper or
   live) unless checkOrder() says ok. Language models make confident mistakes; arithmetic does not. So every
   limit here is a deterministic rule over numbers, with no model call, no clock of its own and no network.

   What it enforces (defaults in DEFAULT_POLICY, changeable only through applyPolicyChange):
     • a stop-loss on every trade, on the correct side of the entry         (cannot be switched off — HARD LAW)
     • risk per trade            <= riskPerTradePct of equity      (default 1%)
     • the day's loss            <  maxDailyLossPct of the day's opening equity (default 3%) — then no new trades today
     • a new trade may not risk more than what is LEFT of today's loss budget
     • open positions            <= maxOpenPositions                (default 5)
     • total open risk           <= maxTotalRiskPct                 (default 5%)
     • gross leverage            <= maxLeverage                     (default 10:1)
     • margin under the jurisdiction's leverage caps                (Canada / CIRO by default) — the LOWER limit wins
     • combined risk on one symbol <= 2 x riskPerTradePct
     • the kill switch: while halted, nothing new is allowed at all

   Loosening a limit needs the Commander (applyPolicyChange({commander:true})) and can never pass the absolute
   CEILINGS below. Tightening is always allowed. No agent holds a path to commander:true — the HTTP route sets it
   only for a request the human made from the settings screen.

   Unit-tested in test/trading.risk.test.js. */
'use strict';
const I = require('./instruments.js');

const DEFAULT_POLICY = Object.freeze({
  riskPerTradePct: 1,      // max % of equity one trade may lose at its stop
  maxDailyLossPct: 3,      // once the day is down this much, no new trades until tomorrow
  maxOpenPositions: 5,
  maxTotalRiskPct: 5,      // sum of every open position's risk-to-stop, as % of equity
  maxLeverage: 10,         // gross notional / equity
  requireStop: true,       // HARD LAW — applyPolicyChange refuses to turn this off
  jurisdiction: 'CA',      // which regulatory leverage table applies
  blockedSymbols: Object.freeze([]),
  allowedClasses: Object.freeze(I.CLASSES.slice())
});

// absolute ceilings: not even the Commander can configure past these from inside the app.
const CEILINGS = Object.freeze({ riskPerTradePct: 5, maxDailyLossPct: 10, maxOpenPositions: 20, maxTotalRiskPct: 15, maxLeverage: 30 });
const FLOORS = Object.freeze({ riskPerTradePct: 0.05, maxDailyLossPct: 0.25, maxOpenPositions: 1, maxTotalRiskPct: 0.25, maxLeverage: 1 });

/* Regulatory leverage caps by jurisdiction and instrument leverage class.
   CA (CIRO): about 30:1 on major FX, 20:1 on minor FX and gold, 10:1 or lower on index CFDs — the published
   retail CFD picture as of late 2026. The remaining classes (other metals, commodities, equities, crypto) are
   CONSERVATIVE HOUSE DEFAULTS, not regulatory quotes; a broker's own margin table may be stricter and the broker
   always has the last word. 'NONE' applies no regulatory table (policy.maxLeverage still applies). */
const LEVERAGE_CAPS = Object.freeze({
  CA: Object.freeze({ 'fx-major': 30, 'fx-minor': 20, gold: 20, metals: 10, index: 10, commodity: 10, equity: 3, crypto: 2 }),
  NONE: Object.freeze({})
});

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
function leverageCap(policy, instrument) {
  const table = LEVERAGE_CAPS[policy.jurisdiction] || LEVERAGE_CAPS.NONE;
  const reg = table[instrument.levClass];
  return reg > 0 ? Math.min(reg, policy.maxLeverage) : policy.maxLeverage;
}

// risk-to-stop of one position/order in ACCOUNT currency; null when it cannot be computed (no stop / no FX rate).
function riskOf(pos, accountCcy, rates) {
  const instrument = I.get(pos.symbol);
  if (!instrument) return null;
  const entry = num(pos.entry), stop = num(pos.stop), lots = Math.abs(num(pos.lots));
  if (!(entry > 0) || !(stop > 0) || !(lots > 0)) return null;
  const quoteRisk = Math.abs(entry - stop) * lots * instrument.contractSize;
  return I.toAccount(quoteRisk, instrument.quote, accountCcy, rates);
}
function notionalOf(pos, accountCcy, rates) {
  const instrument = I.get(pos.symbol);
  if (!instrument) return null;
  const price = num(pos.mark) > 0 ? num(pos.mark) : num(pos.entry);
  return I.toAccount(I.notional(instrument, num(pos.lots), price), instrument.quote, accountCcy, rates);
}

/* The largest position (in lots, rounded DOWN to the lot step) whose loss at the stop stays inside riskPct of equity.
   Returns { lots, riskAmount } — lots is 0 when even the minimum lot would risk too much (the honest answer is "no trade"). */
function sizeForRisk(o) {
  const instrument = I.get(o.symbol);
  if (!instrument) return { lots: 0, riskAmount: 0, error: 'unknown instrument' };
  const equity = num(o.equity), riskPct = num(o.riskPct), entry = num(o.entry), stop = num(o.stop);
  if (!(equity > 0) || !(riskPct > 0) || !(entry > 0) || !(stop > 0) || entry === stop) return { lots: 0, riskAmount: 0, error: 'need equity, riskPct, entry and a different stop' };
  const perLotQuote = Math.abs(entry - stop) * instrument.contractSize;
  const perLot = I.toAccount(perLotQuote, instrument.quote, o.accountCcy || 'USD', o.rates);
  if (!(perLot > 0)) return { lots: 0, riskAmount: 0, error: 'no FX rate to convert ' + instrument.quote + ' risk to ' + (o.accountCcy || 'USD') };
  const budget = equity * riskPct / 100;
  const lots = I.roundLots(instrument, budget / perLot);
  if (lots < instrument.minLot) return { lots: 0, riskAmount: 0, error: 'the minimum lot (' + instrument.minLot + ') would risk more than ' + riskPct + '% — stop is too wide for this account' };
  return { lots, riskAmount: Number((lots * perLot).toFixed(2)) };
}

/* The largest size (lots, rounded DOWN) that stays inside every LEVERAGE rule at once — the instrument's cap, gross
   leverage, and margin — given what is already open. sizeForRisk() answers "how much can I risk"; this answers "how much
   can I hold". A position must satisfy both, so the desk takes the smaller of the two. Returns 0 when nothing fits. */
function maxLotsByLeverage(o, policyIn) {
  const policy = policyIn || DEFAULT_POLICY;
  const instrument = I.get(o.symbol);
  const equity = num(o.equity), entry = num(o.entry);
  if (!instrument || !(equity > 0) || !(entry > 0)) return 0;
  const accountCcy = o.accountCcy || 'USD';
  const perLot = I.toAccount(instrument.contractSize * entry, instrument.quote, accountCcy, o.rates);
  if (!(perLot > 0)) return 0;
  let gross = 0, margin = 0;
  for (const p of (Array.isArray(o.positions) ? o.positions : [])) {
    const pi = I.get(p.symbol), n = notionalOf(p, accountCcy, o.rates);
    if (!pi || n == null) return 0;                       // cannot value what is open -> cannot promise any headroom
    gross += n; margin += n / leverageCap(policy, pi);
  }
  const cap = leverageCap(policy, instrument);
  const byInstrument = equity * cap / perLot;
  const byGross = (equity * policy.maxLeverage - gross) / perLot;
  const byMargin = (equity - margin) * cap / perLot;
  // a hair under each limit, so float rounding can never land exactly on the wrong side of the gate
  const lots = Math.min(byInstrument, byGross, byMargin) * (1 - 1e-9);
  return lots > 0 ? I.roundLots(instrument, lots) : 0;
}

/* THE GATE. order: { symbol, side:'buy'|'sell', lots, entry, stop, takeProfit? }
   ctx: { equity, accountCcy, dayStartEquity, positions:[{symbol, side, lots, entry, stop, mark?}], rates, halted }
   Returns { ok, violations:[{code, message}], metrics }. ok is true ONLY when violations is empty. */
function checkOrder(order, ctx, policyIn) {
  const policy = policyIn || DEFAULT_POLICY;
  const v = [];
  const add = (code, message) => v.push({ code, message });
  const c = ctx || {};
  const accountCcy = c.accountCcy || 'USD';
  const equity = num(c.equity);
  const metrics = { riskAmount: null, riskPct: null, notional: null, leverageAfter: null, openRiskPct: null, marginAfter: null, rewardRisk: null, dayLossPct: null };

  if (c.halted) add('halted', 'The kill switch is ON — no new trades until the Commander resumes trading.');
  if (!(equity > 0)) { add('no-equity', 'The account has no positive equity.'); return { ok: false, violations: v, metrics }; }

  const instrument = I.get(order && order.symbol);
  if (!instrument) { add('unknown-instrument', 'Unknown instrument: ' + String(order && order.symbol)); return { ok: false, violations: v, metrics }; }
  if (policy.blockedSymbols.indexOf(instrument.symbol) >= 0) add('blocked-symbol', instrument.symbol + ' is on the blocked list.');
  if (policy.allowedClasses.indexOf(instrument.assetClass) < 0) add('blocked-class', 'The ' + instrument.assetClass + ' desk is not enabled in the risk policy.');

  const side = order.side === 'sell' ? 'sell' : order.side === 'buy' ? 'buy' : '';
  if (!side) add('bad-side', 'Side must be buy or sell.');
  const lots = num(order.lots), entry = num(order.entry), stop = num(order.stop), tp = order.takeProfit == null || order.takeProfit === '' ? null : num(order.takeProfit);
  if (!(lots > 0)) add('bad-size', 'Position size must be greater than zero.');
  else {
    if (lots < instrument.minLot - 1e-12) add('below-min-lot', 'Size ' + lots + ' is below the minimum lot ' + instrument.minLot + '.');
    if (Math.abs(I.roundLots(instrument, lots) - lots) > 1e-9) add('lot-step', 'Size must be a multiple of ' + instrument.lotStep + ' lots.');
  }
  if (!(entry > 0)) add('bad-entry', 'Entry price must be greater than zero.');

  // ---- the stop-loss law ----
  if (!(stop > 0)) add('no-stop', 'No stop-loss — no trade.');
  else if (side && entry > 0) {
    if (side === 'buy' && !(stop < entry)) add('stop-wrong-side', 'A buy needs its stop BELOW the entry.');
    if (side === 'sell' && !(stop > entry)) add('stop-wrong-side', 'A sell needs its stop ABOVE the entry.');
  }
  if (tp != null) {
    if (!(tp > 0)) add('bad-take-profit', 'Take-profit must be a positive price.');
    else if (side === 'buy' && !(tp > entry)) add('tp-wrong-side', 'A buy needs its take-profit ABOVE the entry.');
    else if (side === 'sell' && !(tp < entry)) add('tp-wrong-side', 'A sell needs its take-profit BELOW the entry.');
    else if (stop > 0 && entry > 0 && entry !== stop) metrics.rewardRisk = Number((Math.abs(tp - entry) / Math.abs(entry - stop)).toFixed(2));
  }

  // ---- today's loss ----
  const dayStart = num(c.dayStartEquity) > 0 ? num(c.dayStartEquity) : equity;
  const dayLoss = Math.max(0, dayStart - equity);
  const dayLossPct = dayLoss / dayStart * 100;
  metrics.dayLossPct = Number(dayLossPct.toFixed(3));
  const dayBudget = dayStart * policy.maxDailyLossPct / 100;
  if (dayLossPct >= policy.maxDailyLossPct - 1e-9) add('daily-loss', 'Daily loss limit hit (' + dayLossPct.toFixed(2) + '% of ' + policy.maxDailyLossPct + '%) — trading is stopped for today.');

  // ---- this trade's risk ----
  const positions = Array.isArray(c.positions) ? c.positions : [];
  if (lots > 0 && entry > 0 && stop > 0 && entry !== stop) {
    const risk = riskOf({ symbol: instrument.symbol, lots, entry, stop }, accountCcy, c.rates);
    if (risk == null) add('no-fx-rate', 'Cannot convert ' + instrument.quote + ' risk to ' + accountCcy + ' — no exchange rate, so the trade cannot be sized safely.');
    else {
      metrics.riskAmount = Number(risk.toFixed(2));
      metrics.riskPct = Number((risk / equity * 100).toFixed(3));
      if (risk > equity * policy.riskPerTradePct / 100 + 1e-6) {
        add('risk-per-trade', 'This trade risks ' + metrics.riskPct + '% of equity (' + accountCcy + ' ' + metrics.riskAmount + '); the limit is ' + policy.riskPerTradePct + '%.');
      }
      if (!(dayLossPct >= policy.maxDailyLossPct - 1e-9) && dayLoss + risk > dayBudget + 1e-6) {
        add('daily-loss-headroom', 'Only ' + accountCcy + ' ' + Math.max(0, dayBudget - dayLoss).toFixed(2) + ' of today\'s loss budget is left; this trade risks ' + metrics.riskAmount + '.');
      }
      // total open risk + same-symbol concentration
      let openRisk = 0, symbolRisk = risk, unknownOpenRisk = false;
      for (const p of positions) {
        const r = riskOf(p, accountCcy, c.rates);
        if (r == null) { unknownOpenRisk = true; continue; }
        openRisk += r;
        if (I.normalize(p.symbol) === instrument.symbol && p.side === side) symbolRisk += r;
      }
      if (unknownOpenRisk) add('open-risk-unknown', 'An open position has no stop or no exchange rate, so total open risk cannot be computed. Fix that first.');
      metrics.openRiskPct = Number(((openRisk + risk) / equity * 100).toFixed(3));
      if (openRisk + risk > equity * policy.maxTotalRiskPct / 100 + 1e-6) {
        add('total-risk', 'Total open risk would be ' + metrics.openRiskPct + '% of equity; the limit is ' + policy.maxTotalRiskPct + '%.');
      }
      if (symbolRisk > equity * policy.riskPerTradePct * 2 / 100 + 1e-6) {
        add('symbol-concentration', 'Combined ' + side + ' risk on ' + instrument.symbol + ' would be ' + (symbolRisk / equity * 100).toFixed(2) + '% — more than twice the per-trade limit.');
      }
    }
  }

  // ---- position count ----
  if (positions.length + 1 > policy.maxOpenPositions) add('max-positions', 'Already ' + positions.length + ' open positions; the limit is ' + policy.maxOpenPositions + '.');

  // ---- leverage and margin ----
  if (lots > 0 && entry > 0) {
    const mine = notionalOf({ symbol: instrument.symbol, lots, entry }, accountCcy, c.rates);
    if (mine != null) {
      metrics.notional = Number(mine.toFixed(2));
      let gross = mine, margin = mine / leverageCap(policy, instrument), unknown = false;
      for (const p of positions) {
        const pi = I.get(p.symbol), n = notionalOf(p, accountCcy, c.rates);
        if (!pi || n == null) { unknown = true; continue; }
        gross += n; margin += n / leverageCap(policy, pi);
      }
      metrics.leverageAfter = Number((gross / equity).toFixed(2));
      metrics.marginAfter = Number(margin.toFixed(2));
      if (unknown) add('exposure-unknown', 'An open position cannot be valued, so leverage cannot be checked.');
      if (gross / equity > policy.maxLeverage + 1e-9) add('max-leverage', 'Gross leverage would be ' + metrics.leverageAfter + ':1; the limit is ' + policy.maxLeverage + ':1.');
      if (mine / equity > leverageCap(policy, instrument) + 1e-9) {
        add('instrument-leverage', instrument.symbol + ' is capped at ' + leverageCap(policy, instrument) + ':1 (' + policy.jurisdiction + ' rules or policy, whichever is lower); this position alone is ' + (mine / equity).toFixed(2) + ':1.');
      }
      if (margin > equity + 1e-6) add('margin', 'Required margin (' + accountCcy + ' ' + metrics.marginAfter + ') would exceed equity.');
    }
  }
  return { ok: v.length === 0, violations: v, metrics };
}

/* Change the policy. Tightening is always allowed. Loosening needs opts.commander === true and never passes CEILINGS.
   Returns { ok, policy, changes:[{field, from, to, direction}], rejected:[{field, reason}] } — policy is the NEW policy
   when ok, else the unchanged current one. All-or-nothing: one rejected field rejects the whole change. */
function applyPolicyChange(current, patch, opts) {
  const cur = Object.assign({}, DEFAULT_POLICY, current || {});
  const next = Object.assign({}, cur);
  const commander = !!(opts && opts.commander === true);
  const changes = [], rejected = [];
  const p = patch || {};
  for (const field of ['riskPerTradePct', 'maxDailyLossPct', 'maxOpenPositions', 'maxTotalRiskPct', 'maxLeverage']) {
    if (p[field] === undefined) continue;
    let to = num(p[field]);
    if (!Number.isFinite(to)) { rejected.push({ field, reason: 'not a number' }); continue; }
    if (field === 'maxOpenPositions') to = Math.floor(to);
    if (to < FLOORS[field]) { rejected.push({ field, reason: 'below the minimum ' + FLOORS[field] }); continue; }
    if (to > CEILINGS[field]) { rejected.push({ field, reason: 'above the absolute ceiling ' + CEILINGS[field] }); continue; }
    if (to === cur[field]) continue;
    const direction = to < cur[field] ? 'tighten' : 'loosen';
    if (direction === 'loosen' && !commander) { rejected.push({ field, reason: 'loosening a limit needs the Commander' }); continue; }
    next[field] = to; changes.push({ field, from: cur[field], to, direction });
  }
  if (p.requireStop !== undefined && p.requireStop !== true) rejected.push({ field: 'requireStop', reason: 'the stop-loss law cannot be switched off' });
  if (p.jurisdiction !== undefined && p.jurisdiction !== cur.jurisdiction) {
    if (!LEVERAGE_CAPS[p.jurisdiction]) rejected.push({ field: 'jurisdiction', reason: 'unknown jurisdiction' });
    else if (!commander) rejected.push({ field: 'jurisdiction', reason: 'changing jurisdiction needs the Commander' });
    else { next.jurisdiction = p.jurisdiction; changes.push({ field: 'jurisdiction', from: cur.jurisdiction, to: p.jurisdiction, direction: 'loosen' }); }
  }
  if (p.blockedSymbols !== undefined) {
    const list = (Array.isArray(p.blockedSymbols) ? p.blockedSymbols : []).map(I.normalize).filter(Boolean);
    const uniq = Array.from(new Set(list)).sort();
    const removed = cur.blockedSymbols.filter(s => uniq.indexOf(s) < 0);
    if (removed.length && !commander) rejected.push({ field: 'blockedSymbols', reason: 'unblocking a symbol needs the Commander' });
    else if (JSON.stringify(uniq) !== JSON.stringify(cur.blockedSymbols.slice().sort())) { next.blockedSymbols = uniq; changes.push({ field: 'blockedSymbols', from: cur.blockedSymbols, to: uniq, direction: removed.length ? 'loosen' : 'tighten' }); }
  }
  if (p.allowedClasses !== undefined) {
    const list = (Array.isArray(p.allowedClasses) ? p.allowedClasses : []).filter(c => I.CLASSES.indexOf(c) >= 0);
    const uniq = I.CLASSES.filter(c => list.indexOf(c) >= 0);
    const added = uniq.filter(c => cur.allowedClasses.indexOf(c) < 0);
    if (added.length && !commander) rejected.push({ field: 'allowedClasses', reason: 'enabling a desk needs the Commander' });
    else if (JSON.stringify(uniq) !== JSON.stringify(I.CLASSES.filter(c => cur.allowedClasses.indexOf(c) >= 0))) { next.allowedClasses = uniq; changes.push({ field: 'allowedClasses', from: cur.allowedClasses, to: uniq, direction: added.length ? 'loosen' : 'tighten' }); }
  }
  if (rejected.length) return { ok: false, policy: cur, changes: [], rejected };
  return { ok: true, policy: next, changes, rejected: [] };
}

// a stored policy may be hand-edited or from an older version: clamp it back inside the floors/ceilings on load.
function sanitizePolicy(raw) {
  const out = Object.assign({}, DEFAULT_POLICY);
  const r = raw && typeof raw === 'object' ? raw : {};
  for (const f of Object.keys(CEILINGS)) {
    const n = num(r[f]);
    if (Number.isFinite(n)) out[f] = Math.min(CEILINGS[f], Math.max(FLOORS[f], f === 'maxOpenPositions' ? Math.floor(n) : n));
  }
  out.requireStop = true;
  if (LEVERAGE_CAPS[r.jurisdiction]) out.jurisdiction = r.jurisdiction;
  if (Array.isArray(r.blockedSymbols)) out.blockedSymbols = Array.from(new Set(r.blockedSymbols.map(I.normalize).filter(Boolean))).sort();
  if (Array.isArray(r.allowedClasses)) out.allowedClasses = I.CLASSES.filter(c => r.allowedClasses.indexOf(c) >= 0);
  return out;
}

module.exports = { DEFAULT_POLICY, CEILINGS, FLOORS, LEVERAGE_CAPS, leverageCap, riskOf, notionalOf, sizeForRisk, maxLotsByLeverage, checkOrder, applyPolicyChange, sanitizePolicy };
