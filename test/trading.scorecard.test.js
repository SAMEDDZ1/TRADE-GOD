/* node test/trading.scorecard.test.js — scorecards are arithmetic over the ledger, checked by hand. */
'use strict';
const A = require('./_assert.js');
const SC = require('../sidecar/trading/scorecard.js');

const tr = (pnl, extra) => Object.assign({ pnl, fees: 0, closedAt: 0 }, extra || {});
// ---- "no data" is nulls, never zeros dressed up as results ----
{
  const c = SC.compute([]);
  A.eq([c.n, c.winRate, c.profitFactor, c.expectancy, c.brier, c.sharpe, c.avgR], [0, null, null, null, null, null, null], 'an empty scorecard claims nothing');
  A.eq(SC.compute(null).n, 0, 'null trades -> empty');
  A.eq(SC.compute([{ pnl: 'x' }, null]).n, 0, 'unreadable trades are not counted');
}
// ---- the worked example: +100, -50, -50, -50, +200, 0 ----
{
  const c = SC.compute([100, -50, -50, -50, 200, 0].map((p, i) => tr(p, { closedAt: 1000 + i })), { baseEquity: 10000 });
  A.eq([c.n, c.wins, c.losses, c.breakeven], [6, 2, 3, 1], 'counts');
  A.eq(c.winRate, 0.4, 'win rate leaves break-even trades out: 2 / 5');
  A.eq([c.netPnl, c.grossProfit, c.grossLoss], [150, 300, -150], 'sums');
  A.eq(c.profitFactor, 2, 'profit factor = 300 / 150');
  A.eq(c.expectancy, 25, 'expectancy = 150 / 6');
  A.eq([c.avgWin, c.avgLoss], [150, -50], 'average win and loss');
  A.eq(c.maxDrawdown, 150, 'peak +100 to trough -50 = 150 drawdown');
  A.eq(c.maxDrawdownPct, 1.5, '= 1.5% of the $10,000 it was run on');
  A.eq([c.longestLosingStreak, c.currentLosingStreak, c.currentWinningStreak], [3, 0, 1], 'streaks (a break-even trade neither extends nor ends one)');
  A.eq(c.sharpe, 0.24, 'per-trade Sharpe: mean 25 / stdev 103.68');
  A.eq([c.firstClosedAt, c.lastClosedAt], [1000, 1005], 'first and last close times');
}
// ---- edges ----
A.eq(SC.compute([tr(10), tr(20)]).profitFactor, null, 'no losing trade yet -> profit factor is unknown, not infinite');
A.eq(SC.compute([tr(-10), tr(-20), tr(-5)]).currentLosingStreak, 3, 'a live losing streak is counted to the end');
A.eq(SC.compute([tr(-10), tr(-20), tr(-5)]).profitFactor, 0, 'all losses -> profit factor 0');
A.eq(SC.compute([tr(10)]).sharpe, null, 'one trade has no Sharpe');
A.eq(SC.compute([tr(10), tr(10)]).sharpe, null, 'zero variance has no Sharpe');
A.eq(SC.compute([tr(100), tr(-50)]).maxDrawdownPct, null, 'no base equity -> no drawdown percent');
A.eq(SC.compute([tr(10, { fees: 1.5 }), tr(-5, { fees: 1.5 })]).fees, 3, 'fees are summed');
A.eq(SC.compute([tr(10, { rMultiple: 2 }), tr(-5, { rMultiple: -1 }), tr(1, { rMultiple: null })]).avgR, 0.5, 'average R over the trades that recorded one');
// ---- calibration (Brier): did "80% confident" win about 80% of the time? ----
A.eq(SC.compute([tr(10, { confidence: 1 }), tr(-10, { confidence: 0 })]).brier, 0, 'perfectly calibrated = 0');
A.eq(SC.compute([tr(-10, { confidence: 1 }), tr(10, { confidence: 0 })]).brier, 1, 'confidently wrong every time = 1');
A.eq(SC.compute([tr(10, { confidence: 0.5 }), tr(-10, { confidence: 0.5 })]).brier, 0.25, 'always saying 50% = 0.25');
A.eq(SC.compute([tr(10, { confidence: 0.8 }), tr(-10, { confidence: 0.8 })]).brier, 0.34, '(0.04 + 0.64) / 2');
A.eq(SC.compute([tr(10), tr(-10, { confidence: 7 })]).brier, null, 'no usable confidence -> no calibration score');
// ---- grouping ----
{
  const g = SC.group([tr(10, { agentId: 'metals', symbol: 'XAUUSD' }), tr(-4, { agentId: 'metals', symbol: 'XAGUSD' }), tr(7, { agentId: 'forex', symbol: 'EURUSD' }), tr(1, {})]);
  A.eq(Object.keys(g).sort(), ['(none)', 'forex', 'metals'], 'one card per crew member');
  A.eq([g.metals.n, g.metals.netPnl, g.forex.netPnl], [2, 6, 7], 'each card holds only its own trades');
  A.eq(Object.keys(SC.group([tr(1, { symbol: 'XAUUSD' }), tr(2, { symbol: 'XAUUSD' })], { by: 'symbol' })), ['XAUUSD'], 'grouping by symbol');
}
A.report('trading.scorecard');
