/* node test/trading.feeds.test.js — the simulated feed is labelled, deterministic and sane; CSV import is strict. */
'use strict';
const A = require('./_assert.js');
const F = require('../sidecar/trading/feeds.js');
const I = require('../sidecar/trading/instruments.js');

const T = Date.UTC(2026, 10, 11, 15, 0, 0);
for (const inst of I.LIST) {
  const q = F.simQuote(inst.symbol, T);
  A.ok(q && q.simulated === true, inst.symbol + ': every simulated quote is stamped simulated');
  A.ok(q.bid > 0 && q.ask > q.bid, inst.symbol + ': ask above bid');
  const base = F.SIM_BASE[inst.symbol];
  A.ok(q.bid > base * 0.5 && q.bid < base * 2, inst.symbol + ': stays in a sane band around its anchor');
}
A.eq(F.simQuote('XAUUSD', T), F.simQuote('XAUUSD', T), 'the same moment always gives the same price (no repaint)');
A.ok(F.simQuote('XAUUSD', T).bid !== F.simQuote('XAUUSD', T + 3600000).bid, 'prices move over time');
A.eq(F.simQuote('NOPE', T), null, 'unknown symbol -> null');
{
  const c = F.simCandles('XAUUSD', 'H1', 100, T);
  A.eq(c.length, 100, '100 candles');
  A.ok(c.every((k, i) => i === 0 || k.t - c[i - 1].t === 3600000), 'evenly spaced hourly bars, oldest first');
  A.ok(c.every(k => k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c) && k.simulated), 'every bar is internally consistent and labelled');
  A.eq(c[c.length - 1].t, Math.floor(T / 3600000) * 3600000, 'the last bar is the one containing now');
  A.eq(JSON.stringify(F.simCandles('XAUUSD', 'H1', 100, T)), JSON.stringify(c), 'candles are deterministic');
  A.eq(F.simCandles('XAUUSD', 'H7', 10, T), [], 'unknown granularity -> nothing');
  A.eq(F.simCandles('XAUUSD', 'D', 99999, T).length, 5000, 'capped at 5,000 bars');
}
// ---- CSV import (TradingView "Export chart data") ----
{
  const csv = 'time,open,high,low,close,Volume\n1762873200,2650,2655,2648,2652,100\n1762876800,2652,2660,2651,2658,120\n1762876800,2652,2660,2651,2658,120\nbad,1,2,3,4\n1762880400,2658,2650,2662,2655,9\n';
  const r = F.parseCsvCandles(csv);
  A.eq(r.candles.length, 2, 'two good rows');
  A.eq(r.skipped, 3, 'a duplicate, a garbage row and an impossible bar (high < low) are skipped and counted');
  A.eq(r.candles[0], { t: 1762873200000, o: 2650, h: 2655, l: 2648, c: 2652, v: 100 }, 'unix seconds become milliseconds');
  A.eq(F.parseCsvCandles('date;open;high;low;close\n2026-11-10;1;2;0.5;1.5\n2026-11-09;1;2;0.5;1.2').candles.map(k => k.c), [1.2, 1.5], 'ISO dates, semicolons, and rows are sorted oldest first');
  A.ok(/need columns/.test(F.parseCsvCandles('a,b\n1,2').error), 'missing columns are named');
  A.ok(/no data rows/.test(F.parseCsvCandles('time,open,high,low,close').error), 'a header-only file is refused');
  A.eq(F.parseCsvCandles('﻿time,open,high,low,close\n1762873200000,1,2,0.5,1').candles[0].t, 1762873200000, 'a BOM and millisecond times are handled');
}
A.report('trading.feeds');
