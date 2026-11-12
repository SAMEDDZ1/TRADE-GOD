/* sidecar/trading/indicators.js — technical indicators, computed, never eyeballed.

   Every function takes plain arrays (oldest first) and returns an array of the SAME length, with null where the
   indicator is not defined yet (the warm-up period). No look-ahead: the value at index i uses only data at <= i,
   which is what makes them safe inside the backtester.

   Unit-tested in test/trading.indicators.test.js against hand-computed values. */
'use strict';

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0)) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// exponential moving average, seeded with the SMA of the first `period` values (the standard convention).
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0) || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period; out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

// Wilder's RSI.
function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0) || values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// true range and Wilder's ATR over candles [{h,l,c}].
function trueRange(candles) {
  return candles.map((c, i) => i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c)));
}
function atr(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (!(period > 0) || candles.length < period) return out;
  const tr = trueRange(candles);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period; out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) { prev = (prev * (period - 1) + tr[i]) / period; out[i] = prev; }
  return out;
}

function macd(values, fast, slow, signal) {
  const f = ema(values, fast || 12), s = ema(values, slow || 26);
  const line = values.map((_, i) => f[i] == null || s[i] == null ? null : f[i] - s[i]);
  const start = line.findIndex(v => v != null);
  const sig = new Array(values.length).fill(null);
  if (start >= 0) { const e = ema(line.slice(start), signal || 9); for (let i = 0; i < e.length; i++) sig[start + i] = e[i]; }
  return { macd: line, signal: sig, histogram: line.map((v, i) => v == null || sig[i] == null ? null : v - sig[i]) };
}

function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  const m = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += Math.pow(values[j] - m[i], 2);
    out[i] = Math.sqrt(s / period);
  }
  return out;
}
function bollinger(values, period, mult) {
  const p = period || 20, k = mult || 2, mid = sma(values, p), sd = stdev(values, p);
  return { middle: mid, upper: mid.map((m, i) => m == null ? null : m + k * sd[i]), lower: mid.map((m, i) => m == null ? null : m - k * sd[i]) };
}

// rolling highest high / lowest low over the PREVIOUS `period` bars, excluding the current one — the Donchian
// channel a breakout is measured against (including the current bar would make a breakout impossible by definition).
function highestPrev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) { let m = -Infinity; for (let j = i - period; j < i; j++) if (values[j] > m) m = values[j]; out[i] = m; }
  return out;
}
function lowestPrev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) { let m = Infinity; for (let j = i - period; j < i; j++) if (values[j] < m) m = values[j]; out[i] = m; }
  return out;
}

module.exports = { sma, ema, rsi, trueRange, atr, macd, stdev, bollinger, highestPrev, lowestPrev };
