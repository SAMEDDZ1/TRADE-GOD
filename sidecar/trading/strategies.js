/* sidecar/trading/strategies.js — strategies as RULES A COMPUTER CAN FOLLOW.

   A strategy here is data + two pure functions, so the exact same rules run in the backtester and on the paper
   account, and so the Strategy Breeder can mutate the parameters without touching code:

     { id, name, style, description, params: { name: { default, min, max, step, label } },
       prepare(candles, p)  -> series      indicators computed once, with no look-ahead
       signal(i, candles, series, p) -> null | { side, stopDistance }
           decided on the CLOSE of bar i; the engine enters on the OPEN of bar i+1 and places the stop
           `stopDistance` away from the real fill. The take-profit is p.targetR x that distance. }

   Three classic, well-understood templates ship built in. None of them is a money machine: they exist so the
   platform, the Quant and the Coach have real, honest rules to test and run. Whether any of them makes money
   on a given market and timeframe is exactly what the backtester is for.

   Unit-tested in test/trading.backtest.test.js. */
'use strict';
const T = require('./indicators.js');

function P(def, min, max, step, label) { return Object.freeze({ default: def, min, max, step, label }); }
const closes = candles => candles.map(c => c.c);

const LIST = [
  Object.freeze({
    id: 'ema-cross', name: 'EMA Crossover', style: 'trend-following',
    description: 'Buy when the fast EMA crosses above the slow EMA, sell when it crosses below. Stop a multiple of ATR away. Built for trending markets; loses small and often in ranges.',
    params: Object.freeze({ fast: P(20, 5, 100, 1, 'Fast EMA'), slow: P(50, 10, 300, 1, 'Slow EMA'), atrPeriod: P(14, 5, 50, 1, 'ATR period'), stopAtr: P(2, 0.5, 6, 0.25, 'Stop (x ATR)'), targetR: P(2, 0.5, 10, 0.25, 'Target (x risk)'), exitOnOpposite: P(1, 0, 1, 1, 'Exit on opposite signal') }),
    prepare(candles, p) { const c = closes(candles); return { fast: T.ema(c, p.fast), slow: T.ema(c, p.slow), atr: T.atr(candles, p.atrPeriod) }; },
    signal(i, candles, s, p) {
      if (i < 1 || s.fast[i] == null || s.slow[i] == null || s.fast[i - 1] == null || s.slow[i - 1] == null || !(s.atr[i] > 0)) return null;
      const was = s.fast[i - 1] - s.slow[i - 1], now = s.fast[i] - s.slow[i];
      if (was <= 0 && now > 0) return { side: 'buy', stopDistance: s.atr[i] * p.stopAtr };
      if (was >= 0 && now < 0) return { side: 'sell', stopDistance: s.atr[i] * p.stopAtr };
      return null;
    }
  }),
  Object.freeze({
    id: 'rsi-reversion', name: 'RSI Mean Reversion', style: 'mean-reversion',
    description: 'In an uptrend (price above its long moving average) buy when RSI climbs back out of oversold; in a downtrend sell when RSI falls back out of overbought. Built for pullbacks inside a trend.',
    params: Object.freeze({ rsiPeriod: P(14, 2, 50, 1, 'RSI period'), oversold: P(30, 5, 45, 1, 'Oversold'), overbought: P(70, 55, 95, 1, 'Overbought'), trend: P(200, 20, 400, 5, 'Trend SMA'), atrPeriod: P(14, 5, 50, 1, 'ATR period'), stopAtr: P(1.5, 0.5, 6, 0.25, 'Stop (x ATR)'), targetR: P(1.5, 0.5, 10, 0.25, 'Target (x risk)'), exitOnOpposite: P(0, 0, 1, 1, 'Exit on opposite signal') }),
    prepare(candles, p) { const c = closes(candles); return { rsi: T.rsi(c, p.rsiPeriod), trend: T.sma(c, p.trend), atr: T.atr(candles, p.atrPeriod) }; },
    signal(i, candles, s, p) {
      if (i < 1 || s.rsi[i] == null || s.rsi[i - 1] == null || s.trend[i] == null || !(s.atr[i] > 0)) return null;
      const c = candles[i].c;
      if (c > s.trend[i] && s.rsi[i - 1] < p.oversold && s.rsi[i] >= p.oversold) return { side: 'buy', stopDistance: s.atr[i] * p.stopAtr };
      if (c < s.trend[i] && s.rsi[i - 1] > p.overbought && s.rsi[i] <= p.overbought) return { side: 'sell', stopDistance: s.atr[i] * p.stopAtr };
      return null;
    }
  }),
  Object.freeze({
    id: 'donchian-breakout', name: 'Donchian Breakout', style: 'breakout',
    description: 'Buy when price closes above the highest high of the last N bars, sell when it closes below the lowest low. The classic breakout rule; many small false starts, occasional large runs.',
    params: Object.freeze({ lookback: P(20, 5, 200, 1, 'Lookback bars'), atrPeriod: P(14, 5, 50, 1, 'ATR period'), stopAtr: P(2, 0.5, 6, 0.25, 'Stop (x ATR)'), targetR: P(3, 0.5, 10, 0.25, 'Target (x risk)'), exitOnOpposite: P(1, 0, 1, 1, 'Exit on opposite signal') }),
    prepare(candles, p) { return { hi: T.highestPrev(candles.map(c => c.h), p.lookback), lo: T.lowestPrev(candles.map(c => c.l), p.lookback), atr: T.atr(candles, p.atrPeriod) }; },
    signal(i, candles, s, p) {
      if (s.hi[i] == null || s.lo[i] == null || !(s.atr[i] > 0)) return null;
      // a breakout is the bar that CROSSES the channel, not every bar that stays beyond it
      const prevInside = i < 1 || s.hi[i - 1] == null || (candles[i - 1].c <= s.hi[i - 1] && candles[i - 1].c >= s.lo[i - 1]);
      if (candles[i].c > s.hi[i] && prevInside) return { side: 'buy', stopDistance: s.atr[i] * p.stopAtr };
      if (candles[i].c < s.lo[i] && prevInside) return { side: 'sell', stopDistance: s.atr[i] * p.stopAtr };
      return null;
    }
  })
];
const BY_ID = new Map(LIST.map(s => [s.id, s]));
function get(id) { return BY_ID.get(String(id || '')) || null; }

// fill in defaults and clamp every parameter to its declared range (a bred or hand-typed value can never go out of bounds).
function resolveParams(strategy, raw) {
  const out = {};
  const r = raw || {};
  for (const k of Object.keys(strategy.params)) {
    const d = strategy.params[k];
    let v = Number(r[k]);
    if (!Number.isFinite(v)) v = d.default;
    v = Math.min(d.max, Math.max(d.min, v));
    out[k] = d.step >= 1 ? Math.round(v) : Number(v.toFixed(4));
  }
  return out;
}
// the longest look-back any indicator needs: the engine never trades before this many bars exist.
function warmup(strategy, p) {
  let w = 2;
  for (const k of ['slow', 'trend', 'lookback', 'atrPeriod', 'rsiPeriod', 'fast']) if (p[k] > w) w = p[k];
  return w + 1;
}
function describe() {
  return LIST.map(s => ({ id: s.id, name: s.name, style: s.style, description: s.description, params: s.params }));
}

module.exports = { LIST, get, resolveParams, warmup, describe };
