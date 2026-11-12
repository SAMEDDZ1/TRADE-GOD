/* sidecar/trading/feeds.js — where prices come from.

   TWO KINDS OF PRICE, and the app must never blur them:
     • a REAL feed (a broker's or data vendor's prices) — e.g. the OANDA connector, or candles the Commander
       imported from TradingView as CSV;
     • the SIMULATED feed in this file — invented prices that move like a market, so the paper account, the
       charts and the crew can be exercised with NO account, NO key and NO network.

   Everything the simulated feed produces is stamped `simulated: true`, and the UI shows a SIMULATED badge on
   every screen that displays it. A backtest on simulated candles is a plumbing test, not evidence about any
   real market, and the backtester's report says so.

   The simulator is a pure function of (symbol, time): overlapping slow and fast waves plus per-bar hash noise.
   No state, no Math.random, no clock — the same timestamp always gives the same price, so a chart never
   "repaints", tests are exact, and two windows always agree.

   Unit-tested in test/trading.feeds.test.js. */
'use strict';
const I = require('./instruments.js');

// anchor levels for the simulation only. They are NOT quotes and are not meant to match any real market.
const SIM_BASE = Object.freeze({
  XAUUSD: 2650, XAGUSD: 31, XPTUSD: 980, XCUUSD: 4.3,
  EURUSD: 1.08, GBPUSD: 1.27, USDJPY: 150, USDCHF: 0.88, AUDUSD: 0.66, USDCAD: 1.37, NZDUSD: 0.60,
  EURGBP: 0.85, EURJPY: 162, GBPJPY: 190.5, CADJPY: 109.5,
  US500: 5800, NAS100: 20300, US30: 42500, GER40: 19200, UK100: 8250, JP225: 38500,
  WTIUSD: 71, BRENTUSD: 75, NATGASUSD: 2.8,
  BTCUSD: 68000, ETHUSD: 2600, SOLUSD: 165,
  GLD: 245, SLV: 28.5, SPY: 580, QQQ: 495, AAPL: 228, MSFT: 420, NVDA: 138, TSLA: 250
});
// how lively each asset class is (scales the wave amplitudes) and its typical spread as a fraction of price.
const SIM_CLASS = Object.freeze({
  metals: { vol: 1.0, spread: 0.00012 }, forex: { vol: 0.45, spread: 0.00008 }, indices: { vol: 0.9, spread: 0.00012 },
  energy: { vol: 1.6, spread: 0.0004 }, crypto: { vol: 2.6, spread: 0.0004 }, equities: { vol: 1.3, spread: 0.0002 }
});

function hash32(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function unit(n) { n = Math.imul(n ^ (n >>> 15), 2246822519) >>> 0; n = Math.imul(n ^ (n >>> 13), 3266489917) >>> 0; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }

const DAY = 86400000;
// the mid price of `symbol` at time `ts` (ms). null for an unknown symbol.
function simMid(symbolRaw, ts) {
  const instrument = I.get(symbolRaw);
  if (!instrument) return null;
  const base = SIM_BASE[instrument.symbol];
  if (!(base > 0)) return null;
  const seed = hash32(instrument.symbol), v = SIM_CLASS[instrument.assetClass].vol;
  const t = Number(ts) / DAY;
  const ph = k => unit(seed + k) * Math.PI * 2;
  // weeks-long drift, multi-day swings, intraday waves, minute chop
  const x = 0.060 * Math.sin(t / 23 + ph(1)) + 0.030 * Math.sin(t / 6.1 + ph(2)) + 0.012 * Math.sin(t / 1.37 + ph(3))
          + 0.006 * Math.sin(t * 3.9 + ph(4)) + 0.0025 * Math.sin(t * 17.3 + ph(5)) + 0.0010 * Math.sin(t * 97 + ph(6));
  const minute = Math.floor(Number(ts) / 60000);
  const noise = (unit(seed ^ minute) - 0.5) * 0.0006 + (unit(seed ^ Math.floor(Number(ts) / 5000) ^ 0x9e3779b9) - 0.5) * 0.0002;
  return base * Math.exp(v * (x + noise));
}
function roundTo(instrument, price) { const d = Math.max(0, Math.round(-Math.log10(instrument.tick))); return Number(price.toFixed(d)); }

function simQuote(symbolRaw, ts) {
  const instrument = I.get(symbolRaw);
  const mid = simMid(symbolRaw, ts);
  if (!instrument || mid == null) return null;
  const half = Math.max(instrument.tick / 2, mid * SIM_CLASS[instrument.assetClass].spread / 2);
  const bid = roundTo(instrument, mid - half), ask = Math.max(roundTo(instrument, mid + half), bid + instrument.tick);
  return { symbol: instrument.symbol, bid, ask: roundTo(instrument, ask), ts: Number(ts), simulated: true };
}

const GRANULARITY = Object.freeze({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D: 86400, W: 604800 });
/* `count` candles of `granularity` ending at (and including the bar containing) endTs. Oldest first.
   Each candle samples the simulated path inside its bar, so highs/lows are consistent with the tick feed. */
function simCandles(symbolRaw, granularity, count, endTs) {
  const instrument = I.get(symbolRaw);
  const sec = GRANULARITY[granularity];
  if (!instrument || !sec || simMid(symbolRaw, endTs) == null) return [];
  const ms = sec * 1000, n = Math.min(5000, Math.max(1, Math.floor(count)));
  const lastStart = Math.floor(Number(endTs) / ms) * ms;
  const out = [];
  const samples = Math.min(24, Math.max(6, Math.round(sec / 60)));
  for (let k = n - 1; k >= 0; k--) {
    const t0 = lastStart - k * ms;
    let o = 0, h = -Infinity, l = Infinity, c = 0;
    for (let s = 0; s <= samples; s++) {
      const ts = Math.min(t0 + ms * s / samples, t0 + ms - 1);
      if (ts > Number(endTs) && k === 0 && s > 0) break;         // the live bar stops at "now"
      const px = simMid(symbolRaw, ts);
      if (s === 0) o = px;
      if (px > h) h = px; if (px < l) l = px; c = px;
    }
    out.push({ t: t0, o: roundTo(instrument, o), h: roundTo(instrument, h), l: roundTo(instrument, l), c: roundTo(instrument, c), v: 0, simulated: true });
  }
  return out;
}

/* CSV candles -> [{t,o,h,l,c,v}]. Reads TradingView's "Export chart data" files (time,open,high,low,close[,Volume])
   and anything shaped like them. `time` may be unix seconds, unix milliseconds or an ISO date. Bad rows are
   skipped and counted, never guessed at. Returns { candles, skipped, error? }. */
function parseCsvCandles(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { candles: [], skipped: 0, error: 'the file has no data rows' };
  const head = lines[0].split(/[,;\t]/).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const col = names => head.findIndex(h => names.indexOf(h) >= 0);
  const ti = col(['time', 'date', 'datetime', 'timestamp']), oi = col(['open', 'o']), hi = col(['high', 'h']), li = col(['low', 'l']), ci = col(['close', 'c']), vi = col(['volume', 'vol', 'v']);
  if (ti < 0 || oi < 0 || hi < 0 || li < 0 || ci < 0) return { candles: [], skipped: 0, error: 'need columns: time, open, high, low, close' };
  const sep = lines[0].indexOf('\t') >= 0 ? '\t' : lines[0].indexOf(';') >= 0 && lines[0].indexOf(',') < 0 ? ';' : ',';
  const candles = []; let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(sep).map(x => x.trim().replace(/^"|"$/g, ''));
    let t = Number(f[ti]);
    if (Number.isFinite(t)) t = t < 1e11 ? t * 1000 : t; else t = Date.parse(f[ti]);
    const k = { t, o: Number(f[oi]), h: Number(f[hi]), l: Number(f[li]), c: Number(f[ci]), v: vi >= 0 ? Number(f[vi]) || 0 : 0 };
    if (![k.t, k.o, k.h, k.l, k.c].every(Number.isFinite) || !(k.l > 0) || k.h < k.l) { skipped++; continue; }
    candles.push(k);
  }
  candles.sort((a, b) => a.t - b.t);
  const dedup = candles.filter((k, i) => i === 0 || k.t !== candles[i - 1].t);
  return { candles: dedup, skipped: skipped + (candles.length - dedup.length) };
}

module.exports = { SIM_BASE, GRANULARITY, simMid, simQuote, simCandles, parseCsvCandles };
