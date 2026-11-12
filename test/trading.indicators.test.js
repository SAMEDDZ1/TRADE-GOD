/* node test/trading.indicators.test.js — indicators against hand-computed values, and no look-ahead. */
'use strict';
const A = require('./_assert.js');
const T = require('../sidecar/trading/indicators.js');
const r = (a, d) => a.map(v => v == null ? null : Number(v.toFixed(d == null ? 4 : d)));

A.eq(T.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4], 'SMA(3)');
A.eq(T.sma([1, 2], 3), [null, null], 'SMA shorter than its period is undefined');
// EMA(3): seed = SMA of first 3 = 2; k = 0.5 -> 3, 4
A.eq(T.ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4], 'EMA(3) seeded with the SMA');
A.eq(r(T.ema([10, 11, 12, 11, 13], 2)), [null, 10.5, 11.5, 11.1667, 12.3889], 'EMA(2): k = 2/3');
// RSI: all gains -> 100; all losses -> 0
A.eq(T.rsi([1, 2, 3, 4, 5, 6], 3).slice(3), [100, 100, 100], 'only gains -> RSI 100');
A.eq(T.rsi([6, 5, 4, 3, 2, 1], 3).slice(3), [0, 0, 0], 'only losses -> RSI 0');
// RSI(2) on 10,11,10,12: changes +1,-1 -> avgGain .5 avgLoss .5 -> 50; then +2: gain (.5+2)/2=1.25 loss .25 -> 100-100/(1+5) = 83.3333
A.eq(r(T.rsi([10, 11, 10, 12], 2)), [null, null, 50, 83.3333], 'RSI(2) with Wilder smoothing');
// ATR
const cs = [{ h: 10, l: 8, c: 9 }, { h: 11, l: 9, c: 10 }, { h: 14, l: 10, c: 13 }, { h: 13, l: 12, c: 12 }];
A.eq(T.trueRange(cs), [2, 2, 4, 1], 'true range uses the previous close: max(h-l, |h-pc|, |l-pc|)');
A.eq(r(T.atr(cs, 2)), [null, 2, 3, 2], 'ATR(2): 2, then (2+4)/2, then (3+1)/2');
// Bollinger: constant series -> zero width
{
  const b = T.bollinger([5, 5, 5, 5], 2, 2);
  A.eq([b.middle[3], b.upper[3], b.lower[3]], [5, 5, 5], 'a flat series has zero-width bands');
  const b2 = T.bollinger([1, 3], 2, 2);   // mean 2, population stdev 1
  A.eq([b2.middle[1], b2.upper[1], b2.lower[1]], [2, 4, 0], 'bands are mean +/- 2 population standard deviations');
}
// Donchian channel excludes the current bar
A.eq(T.highestPrev([1, 5, 3, 9, 2], 2), [null, null, 5, 5, 9], 'highest of the PREVIOUS 2 bars');
A.eq(T.lowestPrev([4, 2, 6, 1, 8], 2), [null, null, 2, 2, 1], 'lowest of the PREVIOUS 2 bars');
// MACD shape
{
  const v = Array.from({ length: 60 }, (_, i) => 100 + i);
  const m = T.macd(v, 12, 26, 9);
  A.eq([m.macd[24], m.macd[25] != null, m.signal[32], m.signal[33] != null], [null, true, null, true], 'MACD and its signal start exactly after their warm-ups');
  A.ok(m.macd[59] > 0, 'a steadily rising series has a positive MACD');
}
// NO LOOK-AHEAD: the value at index i must not change when later data is appended
{
  const base = [3, 7, 5, 9, 4, 8, 6, 10, 2, 11, 5, 9, 7, 12, 6];
  const more = base.concat([100, -50, 30]);
  const bars = v => v.map(x => ({ h: x + 1, l: x - 1, c: x }));
  const same = (name, a, b) => A.eq(b.slice(0, a.length), a, name + ' has no look-ahead');
  same('sma', T.sma(base, 4), T.sma(more, 4));
  same('ema', T.ema(base, 4), T.ema(more, 4));
  same('rsi', T.rsi(base, 4), T.rsi(more, 4));
  same('atr', T.atr(bars(base), 4), T.atr(bars(more.map(Math.abs)), 4));
  same('stdev', T.stdev(base, 4), T.stdev(more, 4));
  same('highestPrev', T.highestPrev(base, 4), T.highestPrev(more, 4));
  same('macd', T.macd(base, 3, 6, 2).histogram, T.macd(more, 3, 6, 2).histogram);
}
// every indicator returns an array as long as its input
for (const [name, out] of [['sma', T.sma([1, 2, 3], 2)], ['ema', T.ema([1, 2, 3], 2)], ['rsi', T.rsi([1, 2, 3], 2)], ['atr', T.atr(cs, 2)]]) A.eq(out.length === (name === 'atr' ? 4 : 3), true, name + ' keeps the input length');
A.report('trading.indicators');
