/* sidecar/trading/scorecard.js — the numbers the Agent Coach, the Performance Analyst and the Commander judge by.

   compute(trades, opts) turns a list of CLOSED trades (oldest first) into one scorecard. Pure arithmetic over the
   ledger: nothing here is estimated, modelled or asked of an AI. A scorecard with n = 0 is all nulls, never zeros
   dressed up as results — "no data" and "broke even" are different facts.

   Fields
     n, wins, losses, breakeven
     winRate            wins / (wins + losses), 0..1   (breakeven trades are left out of the ratio)
     netPnl, grossProfit, grossLoss, fees
     profitFactor       grossProfit / |grossLoss|; null when there are no losing trades yet
     expectancy         mean net P&L per trade
     avgWin, avgLoss    (avgLoss is negative)
     avgR               mean R-multiple (P&L in units of the risk taken at entry), where recorded
     maxDrawdown        largest peak-to-trough fall of the cumulative P&L curve, in account currency (>= 0)
     maxDrawdownPct     the same as % of opts.baseEquity (the capital the trades were run on), null without it
     currentLosingStreak, longestLosingStreak, currentWinningStreak
     brier              calibration: mean (stated confidence - outcome)^2 over trades that carried a confidence
                        (0 = perfect, 0.25 = coin-flip guessing at 50%, higher = confidently wrong); null without data
     sharpe             per-trade Sharpe (mean / stdev of trade P&L, NOT annualised); null under 2 trades

   Unit-tested in test/trading.scorecard.test.js. */
'use strict';

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }

function empty() {
  return { n: 0, wins: 0, losses: 0, breakeven: 0, winRate: null, netPnl: 0, grossProfit: 0, grossLoss: 0, fees: 0,
    profitFactor: null, expectancy: null, avgWin: null, avgLoss: null, avgR: null, maxDrawdown: 0, maxDrawdownPct: null,
    currentLosingStreak: 0, longestLosingStreak: 0, currentWinningStreak: 0, brier: null, sharpe: null,
    firstClosedAt: null, lastClosedAt: null };
}

function compute(trades, opts) {
  const list = (Array.isArray(trades) ? trades : []).filter(t => t && Number.isFinite(Number(t.pnl)));
  const c = empty();
  if (!list.length) return c;
  const o = opts || {};
  let cum = 0, peak = 0, maxDd = 0, loseRun = 0, winRun = 0, rSum = 0, rN = 0, bSum = 0, bN = 0;
  const pnls = [];
  for (const t of list) {
    const pnl = Number(t.pnl);
    pnls.push(pnl); c.n++; c.netPnl += pnl; c.fees += Number(t.fees) || 0;
    if (pnl > 0) { c.wins++; c.grossProfit += pnl; winRun++; loseRun = 0; }
    else if (pnl < 0) { c.losses++; c.grossLoss += pnl; loseRun++; winRun = 0; if (loseRun > c.longestLosingStreak) c.longestLosingStreak = loseRun; }
    else { c.breakeven++; }
    cum += pnl; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum;
    if (Number.isFinite(Number(t.rMultiple)) && t.rMultiple !== null) { rSum += Number(t.rMultiple); rN++; }
    const conf = Number(t.confidence);
    if (t.confidence != null && Number.isFinite(conf) && conf >= 0 && conf <= 1 && pnl !== 0) { bSum += Math.pow(conf - (pnl > 0 ? 1 : 0), 2); bN++; }
  }
  c.currentLosingStreak = loseRun; c.currentWinningStreak = winRun;
  const decided = c.wins + c.losses;
  c.winRate = decided ? r4(c.wins / decided) : null;
  c.profitFactor = c.grossLoss < 0 ? r2(c.grossProfit / Math.abs(c.grossLoss)) : null;
  c.expectancy = r2(c.netPnl / c.n);
  c.avgWin = c.wins ? r2(c.grossProfit / c.wins) : null;
  c.avgLoss = c.losses ? r2(c.grossLoss / c.losses) : null;
  c.avgR = rN ? r2(rSum / rN) : null;
  c.maxDrawdown = r2(maxDd);
  c.maxDrawdownPct = Number(o.baseEquity) > 0 ? r2(maxDd / Number(o.baseEquity) * 100) : null;
  c.brier = bN ? r4(bSum / bN) : null;
  if (c.n >= 2) {
    const mean = c.netPnl / c.n;
    const variance = pnls.reduce((a, p) => a + Math.pow(p - mean, 2), 0) / (c.n - 1);
    c.sharpe = variance > 0 ? r2(mean / Math.sqrt(variance)) : null;
  }
  c.netPnl = r2(c.netPnl); c.grossProfit = r2(c.grossProfit); c.grossLoss = r2(c.grossLoss); c.fees = r2(c.fees);
  c.firstClosedAt = list[0].closedAt || null; c.lastClosedAt = list[list.length - 1].closedAt || null;
  return c;
}

// one scorecard per key (agentId by default; pass by:'symbol' | 'strategy' for the other breakdowns).
function group(trades, opts) {
  const by = (opts && opts.by) || 'agentId';
  const buckets = new Map();
  for (const t of (Array.isArray(trades) ? trades : [])) {
    const k = String((t && t[by]) || '(none)');
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  }
  const out = {};
  for (const [k, list] of buckets) out[k] = compute(list, opts);
  return out;
}

module.exports = { compute, group, empty };
