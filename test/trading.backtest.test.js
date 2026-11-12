/* node test/trading.backtest.test.js — the backtester cannot cheat: no look-ahead, real costs, pessimistic exits. */
'use strict';
const A = require('./_assert.js');
const BT = require('../sidecar/trading/backtest.js');
const S = require('../sidecar/trading/strategies.js');
const F = require('../sidecar/trading/feeds.js');

const H = 3600000, T0 = Date.UTC(2026, 0, 5);
// a hand-made test strategy: buy on the close of bar `at`, fixed stop distance, fixed target multiple
function fixed(at, side, dist, targetR) {
  return { id: 'test-fixed', name: 'test', style: 'test', description: '', params: { targetR: { default: targetR || 2, min: 0.1, max: 10, step: 0.1 }, exitOnOpposite: { default: 0, min: 0, max: 1, step: 1 } },
    prepare: () => ({}), signal: i => i === at ? { side: side || 'buy', stopDistance: dist } : null };
}
const bar = (i, o, h, l, c) => ({ t: T0 + i * H, o, h, l, c });
function flatThen(rows) { const out = []; for (let i = 0; i < 30; i++) out.push(bar(i, 2650, 2651, 2649, 2650)); rows.forEach((r, k) => out.push(bar(30 + k, r[0], r[1], r[2], r[3]))); for (let i = 0; i < 25; i++) out.push(bar(30 + rows.length + i, 2700, 2701, 2699, 2700)); return out; }
const NOCOST = { noCosts: true };

// ---- entries happen on the NEXT open (no look-ahead) ----
{
  // signal on the close of bar 30; bar 31 opens at 2655 — that is the fill, not bar 30's close of 2650
  const c = flatThen([[2650, 2651, 2649, 2650], [2655, 2656, 2654, 2655], [2655, 2700, 2655, 2690]]);
  const r = BT.run(Object.assign({ symbol: 'XAUUSD', candles: c, strategy: fixed(30, 'buy', 10, 2) }, NOCOST));
  A.eq(r.ok, true, 'runs: ' + r.error);
  A.eq(r.trades.length, 1, 'one trade');
  A.eq([r.trades[0].entry, r.trades[0].openedAt], [2655, T0 + 31 * H], 'filled on the OPEN of the bar AFTER the signal');
  A.eq([r.trades[0].reason, r.trades[0].exit], ['take-profit', 2675], 'target = entry + 2 x 10');
  A.eq(r.trades[0].lots, 0.1, 'sized by the risk engine: 1% of $10k / ($10 x 100 oz) = 0.1 lot');
  A.eq(r.trades[0].pnl, 200, '+$20 x 10 oz = +$200');
  A.eq(r.metrics.endingEquity, 10200, 'equity follows');
}
// ---- when one bar touches BOTH the stop and the target, the stop is assumed first ----
{
  const c = flatThen([[2650, 2651, 2649, 2650], [2650, 2675, 2635, 2660]]);
  const r = BT.run(Object.assign({ symbol: 'XAUUSD', candles: c, strategy: fixed(30, 'buy', 10, 2) }, NOCOST));
  A.eq([r.trades[0].reason, r.trades[0].exit, r.trades[0].pnl], ['stop', 2640, -100], 'ambiguous bar -> the pessimistic outcome');
}
// ---- a gap through the stop exits at the open, not at the stop ----
{
  const c = flatThen([[2650, 2651, 2649, 2650], [2650, 2652, 2648, 2650], [2630, 2632, 2625, 2628]]);
  const r = BT.run(Object.assign({ symbol: 'XAUUSD', candles: c, strategy: fixed(30, 'buy', 10, 3) }, NOCOST));
  A.eq([r.trades[0].reason, r.trades[0].exit, r.trades[0].pnl], ['stop-gap', 2630, -200], 'gapped: -$200, twice the planned risk');
  A.eq(r.trades[0].rMultiple, -2, 'and R says so');
}
// ---- shorts mirror ----
{
  const c = flatThen([[2650, 2651, 2649, 2650], [2650, 2651, 2620, 2625]]);
  const r = BT.run(Object.assign({ symbol: 'XAUUSD', candles: c, strategy: fixed(30, 'sell', 10, 2) }, NOCOST));
  A.eq([r.trades[0].side, r.trades[0].reason, r.trades[0].exit, r.trades[0].pnl], ['sell', 'take-profit', 2630, 200], 'a short hits its target below');
}
// ---- costs are ON by default, and they cost money ----
{
  const c = flatThen([[2650, 2651, 2649, 2650], [2655, 2656, 2654, 2655], [2655, 2700, 2655, 2690]]);
  const free = BT.run(Object.assign({ symbol: 'XAUUSD', candles: c, strategy: fixed(30, 'buy', 10, 2) }, NOCOST));
  const real = BT.run({ symbol: 'XAUUSD', candles: c, strategy: fixed(30, 'buy', 10, 2) });
  A.ok(real.trades[0].entry > 2655, 'with costs the buy pays half the spread plus slippage: ' + real.trades[0].entry);
  A.eq(real.trades[0].pnl, free.trades[0].pnl, 'a target is a limit order: it is measured from the real fill, so its P&L matches');
  const lossBars = flatThen([[2650, 2651, 2649, 2650], [2650, 2652, 2630, 2640]]);
  const lf = BT.run(Object.assign({ symbol: 'XAUUSD', candles: lossBars, strategy: fixed(30, 'buy', 10, 2) }, NOCOST));
  const lr = BT.run({ symbol: 'XAUUSD', candles: lossBars, strategy: fixed(30, 'buy', 10, 2) });
  A.ok(lr.trades[0].pnl < lf.trades[0].pnl, 'but a stop exit pays slippage: ' + lr.trades[0].pnl + ' < ' + lf.trades[0].pnl);
  A.ok(real.caveats.every(x => !/SWITCHED OFF/.test(x)), 'a run with costs has no costs-off warning');
  A.ok(free.caveats.some(x => /COSTS WERE SWITCHED OFF/.test(x)), 'a run without costs says loudly that it is not achievable');
  A.ok(free.caveats.some(x => /too few to trust/.test(x)), 'one trade is flagged as far too few to trust');
}
// ---- a trade the account cannot afford is SKIPPED, not shrunk below the minimum ----
{
  const c = flatThen([[2650, 2651, 2649, 2650], [2650, 2651, 2649, 2650]]);
  const r = BT.run(Object.assign({ symbol: 'XAUUSD', candles: c, strategy: fixed(30, 'buy', 2000, 2), startingEquity: 1000 }, NOCOST));
  A.eq([r.trades.length, r.skipped], [0, 1], 'a stop too wide for the account -> skipped and counted');
}
// ---- input hygiene ----
A.eq(BT.run({ symbol: 'NOPE', candles: [], strategy: 'ema-cross' }).ok, false, 'unknown symbol');
A.eq(BT.run({ symbol: 'XAUUSD', candles: [], strategy: 'nope' }).ok, false, 'unknown strategy');
A.ok(/not enough data/.test(BT.run({ symbol: 'XAUUSD', candles: flatThen([]).slice(0, 40), strategy: 'ema-cross' }).error), 'too little data is refused, not run');
A.ok(/fast EMA/.test(BT.run({ symbol: 'XAUUSD', candles: flatThen([]), strategy: 'ema-cross', params: { fast: 60, slow: 50 } }).error), 'nonsense parameters are refused');
A.ok(/exchange rate/.test(BT.run({ symbol: 'USDJPY', candles: F.simCandles('USDJPY', 'H1', 300, T0 + 400 * H), strategy: 'ema-cross' }).error), 'a yen-quoted backtest needs USD/JPY');
A.eq(BT.cleanCandles([bar(0, 1, 2, 0.5, 1.5), bar(0, 1, 2, 0.5, 1.5), bar(1, 1, 0.5, 2, 1), bar(2, 5, 6, 4, 9), { t: 'x' }, bar(3, 1, 2, 0.5, 1)]).length, 2, 'duplicate, inverted, impossible and garbage bars are dropped');
// ---- determinism and the three built-in strategies ----
{
  const c = F.simCandles('XAUUSD', 'H1', 2500, Date.UTC(2026, 9, 1));
  for (const s of S.LIST) {
    const a = BT.run({ symbol: 'XAUUSD', candles: c, strategy: s.id }), b = BT.run({ symbol: 'XAUUSD', candles: c, strategy: s.id });
    A.eq(a.ok, true, s.id + ' runs on 2,500 bars');
    A.eq(JSON.stringify(a), JSON.stringify(b), s.id + ' is deterministic');
    A.ok(a.trades.length > 0, s.id + ' trades');
    A.ok(a.trades.every(t => t.openedAt > c[0].t + (S.warmup(s, S.resolveParams(s)) - 1) * H), s.id + ' never trades during the warm-up');
    A.ok(a.trades.every(t => t.lots > 0 && t.stop > 0), s.id + ': every trade has a size and a stop');
    // the sum of trade P&L is the change in equity (no money appears or vanishes)
    A.eq(Math.round(a.trades.reduce((x, t) => x + t.pnl, 0) * 100) / 100, Math.round((a.metrics.endingEquity - a.startingEquity) * 100) / 100, s.id + ': trades add up to the equity change');
    A.ok(a.metrics.maxEquityDrawdownPct >= 0, s.id + ' reports its mark-to-market drawdown');
  }
}
// ---- NO LOOK-AHEAD, end to end: appending future bars never changes past trades ----
{
  const c = F.simCandles('XAUUSD', 'H1', 2000, Date.UTC(2026, 9, 1));
  for (const s of S.LIST) {
    const short = BT.run({ symbol: 'XAUUSD', candles: c.slice(0, 1500), strategy: s.id });
    const long = BT.run({ symbol: 'XAUUSD', candles: c, strategy: s.id });
    const done = short.trades.filter(t => t.reason !== 'end-of-data');
    A.eq(JSON.stringify(long.trades.slice(0, done.length)), JSON.stringify(done), s.id + ': future data does not change a single past trade');
  }
}
// ---- walk-forward ----
{
  const c = F.simCandles('XAUUSD', 'H1', 3000, Date.UTC(2026, 9, 1));
  const w = BT.walkForward({ symbol: 'XAUUSD', candles: c, strategy: 'donchian-breakout' });
  A.eq(w.ok, true, 'walk-forward runs');
  A.ok(['survived', 'failed', 'inconclusive'].indexOf(w.verdict) >= 0, 'it gives a verdict: ' + w.verdict);
  A.ok(w.inSample.lastBar < w.outOfSample.trades.concat([{ openedAt: Infinity }])[0].openedAt, 'out-of-sample trades are all after the in-sample period');
  A.eq(w.split, 0.7, 'default split 70/30');
}
// ---- Monte Carlo ----
{
  const trades = [100, -50, 80, -50, -50, 120, -50, 90, -50, 60].map(pnl => ({ pnl }));
  const m = BT.monteCarlo(trades, { startingEquity: 10000, runs: 500, seed: 3 });
  A.eq(m.ok, true, 'Monte Carlo runs');
  A.ok(m.medianDrawdownPct <= m.p95DrawdownPct && m.p95DrawdownPct <= m.worstDrawdownPct, 'median <= 95th percentile <= worst');
  A.eq(JSON.stringify(BT.monteCarlo(trades, { runs: 500, seed: 3 })), JSON.stringify(BT.monteCarlo(trades, { runs: 500, seed: 3 })), 'reproducible from its seed');
  A.eq(m.worstDrawdownPct, 2.5, 'the worst ordering puts all five $50 losses first: $250 of $10,000 = 2.5%');
  A.eq(BT.monteCarlo([{ pnl: 1 }], {}).ok, false, 'needs at least 5 trades');
}
A.report('trading.backtest');
