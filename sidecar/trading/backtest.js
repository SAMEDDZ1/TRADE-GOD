/* sidecar/trading/backtest.js — the backtester. Its job is to stop the company trading fantasies.

   Most backtests lie, and they lie in the same few ways. This one is built so the common lies are impossible
   or at least loud:

     LOOK-AHEAD        a signal is decided on the CLOSE of bar i and filled on the OPEN of bar i+1. Indicators
                       are computed with no access to later bars (indicators.js).
     FREE TRADING      every fill pays half the spread; stop exits also pay slippage; commission is per lot per
                       side. Costs default to ON with realistic values per asset class — a caller must opt OUT.
     PERFECT EXITS     if a bar's range touches both the stop and the target, the STOP is assumed first. If the
                       bar OPENS beyond the stop (a gap), the exit is the open, not the stop price.
     UNLIMITED SIZE    every trade is sized by the risk engine's own sizeForRisk() from the equity at that
                       moment, rounded DOWN to the lot step; if the minimum lot would risk too much, the trade
                       is SKIPPED and counted in `skipped`.
     ONE LUCKY PERIOD  walkForward() scores the rules on data they were not tuned on, and flags the result.
     ONE LUCKY ORDER   monteCarlo() reshuffles the trade sequence to show the drawdown you should really expect.

   What it does NOT model (say so in every report): the bid/ask path inside a bar, overnight financing/swap,
   partial fills, requotes, and market impact. Results are an estimate of the past, never a promise.

   Deterministic: same candles + same options -> byte-identical result. Unit-tested in test/trading.backtest.test.js. */
'use strict';
const I = require('./instruments.js');
const R = require('./risk.js');
const S = require('./strategies.js');
const SC = require('./scorecard.js');

// typical all-in half-costs per asset class, in PRICE units relative to price (fractions). Conservative round numbers:
// a caller with a real broker's numbers should pass them in.
const DEFAULT_COSTS = Object.freeze({
  metals:   Object.freeze({ spreadPct: 0.00015, slippagePct: 0.00005, commissionPerLot: 0 }),
  forex:    Object.freeze({ spreadPct: 0.00010, slippagePct: 0.00003, commissionPerLot: 0 }),
  indices:  Object.freeze({ spreadPct: 0.00015, slippagePct: 0.00005, commissionPerLot: 0 }),
  energy:   Object.freeze({ spreadPct: 0.00050, slippagePct: 0.00010, commissionPerLot: 0 }),
  crypto:   Object.freeze({ spreadPct: 0.00050, slippagePct: 0.00020, commissionPerLot: 0 }),
  equities: Object.freeze({ spreadPct: 0.00020, slippagePct: 0.00005, commissionPerLot: 0.005 })
});

function r2(n) { return Math.round(n * 100) / 100; }
function cleanCandles(raw) {
  const out = [];
  for (const c of (Array.isArray(raw) ? raw : [])) {
    const k = { t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) || 0 };
    if (![k.t, k.o, k.h, k.l, k.c].every(Number.isFinite) || !(k.l > 0) || k.h < k.l || k.o > k.h || k.o < k.l || k.c > k.h || k.c < k.l) continue;
    if (out.length && k.t <= out[out.length - 1].t) continue;       // must be strictly time-ordered
    out.push(k);
  }
  return out;
}

/* run({ symbol, candles, strategy, params?, startingEquity?, riskPct?, accountCcy?, rates?, costs?, noCosts? })
   -> { ok, error?, symbol, strategy, params, bars, trades[], skipped, metrics, equityCurve[{t, equity}], costs, caveats[] } */
function run(opts) {
  const o = opts || {};
  const instrument = I.get(o.symbol);
  if (!instrument) return { ok: false, error: 'unknown instrument: ' + o.symbol };
  const strategy = typeof o.strategy === 'string' ? S.get(o.strategy) : o.strategy;
  if (!strategy) return { ok: false, error: 'unknown strategy: ' + o.strategy };
  const candles = cleanCandles(o.candles);
  const p = S.resolveParams(strategy, o.params);
  if (strategy.id === 'ema-cross' && p.fast >= p.slow) return { ok: false, error: 'the fast EMA must be shorter than the slow EMA' };
  const warm = S.warmup(strategy, p);
  if (candles.length < warm + 20) return { ok: false, error: 'not enough data: ' + candles.length + ' usable bars, need at least ' + (warm + 20) };

  const accountCcy = o.accountCcy || 'USD';
  const startingEquity = Number(o.startingEquity) > 0 ? Number(o.startingEquity) : 10000;
  const riskPct = Number(o.riskPct) > 0 ? Math.min(Number(o.riskPct), R.CEILINGS.riskPerTradePct) : R.DEFAULT_POLICY.riskPerTradePct;
  const base = DEFAULT_COSTS[instrument.assetClass];
  const costs = o.noCosts ? { spreadPct: 0, slippagePct: 0, commissionPerLot: 0 } : Object.assign({}, base, o.costs || {});
  // a static FX rate map for quote->account conversion; USD-quoted instruments need none.
  const rates = o.rates || {};
  if (I.toAccount(1, instrument.quote, accountCcy, rates) == null) return { ok: false, error: 'need an exchange rate to convert ' + instrument.quote + ' to ' + accountCcy + ' (pass rates)' };
  const conv = x => I.toAccount(x, instrument.quote, accountCcy, rates);

  const series = strategy.prepare(candles, p);
  let equity = startingEquity, pos = null, skipped = 0, pendingEntry = null, pendingExit = false;
  const trades = [], curve = [];

  function closePos(price, reason, t) {
    const gross = conv(I.pnl(instrument, pos.side, pos.lots, pos.entry, price));
    const fee = costs.commissionPerLot * pos.lots * 2;
    const pnl = r2(gross - fee);
    equity = r2(equity + pnl);
    trades.push({
      id: 'B' + (trades.length + 1), symbol: instrument.symbol, side: pos.side, lots: pos.lots, entry: pos.entry, exit: price,
      stop: pos.stop, takeProfit: pos.takeProfit, openedAt: pos.openedAt, closedAt: t, reason, pnl, fees: r2(fee),
      rMultiple: Number(((price - pos.entry) * (pos.side === 'buy' ? 1 : -1) / pos.stopDistance).toFixed(2)), strategy: strategy.id
    });
    pos = null;
  }

  for (let i = warm; i < candles.length; i++) {
    const bar = candles[i];
    const half = bar.o * costs.spreadPct / 2, slip = bar.o * costs.slippagePct;
    // ---- 1. things decided on the previous close happen on THIS open ----
    if (pos && pendingExit) { closePos(pos.side === 'buy' ? bar.o - half : bar.o + half, 'signal', bar.t); }
    pendingExit = false;
    if (!pos && pendingEntry) {
      const side = pendingEntry.side, dist = pendingEntry.stopDistance;
      const entry = side === 'buy' ? bar.o + half + slip : bar.o - half - slip;
      const stop = side === 'buy' ? entry - dist : entry + dist;
      const takeProfit = side === 'buy' ? entry + dist * p.targetR : entry - dist * p.targetR;
      const sized = stop > 0 ? R.sizeForRisk({ symbol: instrument.symbol, equity, riskPct, entry, stop, accountCcy, rates }) : { lots: 0 };
      if (sized.lots > 0) pos = { side, lots: sized.lots, entry, stop, takeProfit, stopDistance: dist, openedAt: bar.t };
      else skipped++;
    }
    pendingEntry = null;
    // ---- 2. the bar plays out: stop first, then target (the pessimistic order) ----
    if (pos) {
      if (pos.side === 'buy') {
        const bidLow = bar.l - half, bidHigh = bar.h - half, bidOpen = bar.o - half;
        if (bidOpen <= pos.stop && pos.openedAt !== bar.t) closePos(bidOpen, 'stop-gap', bar.t);
        else if (bidLow <= pos.stop) closePos(pos.stop - slip, 'stop', bar.t);
        else if (bidHigh >= pos.takeProfit) closePos(pos.takeProfit, 'take-profit', bar.t);
      } else {
        const askHigh = bar.h + half, askLow = bar.l + half, askOpen = bar.o + half;
        if (askOpen >= pos.stop && pos.openedAt !== bar.t) closePos(askOpen, 'stop-gap', bar.t);
        else if (askHigh >= pos.stop) closePos(pos.stop + slip, 'stop', bar.t);
        else if (askLow <= pos.takeProfit) closePos(pos.takeProfit, 'take-profit', bar.t);
      }
    }
    // ---- 3. decide on this close, to act on the next open ----
    if (i < candles.length - 1) {
      const sig = strategy.signal(i, candles, series, p);
      if (sig && (sig.side === 'buy' || sig.side === 'sell') && sig.stopDistance > 0) {
        if (!pos) pendingEntry = sig;
        else if (sig.side !== pos.side && p.exitOnOpposite) { pendingExit = true; pendingEntry = sig; }
      }
    }
    // mark-to-market equity at the close
    const open = pos ? conv(I.pnl(instrument, pos.side, pos.lots, pos.entry, pos.side === 'buy' ? bar.c - half : bar.c + half)) : 0;
    curve.push({ t: bar.t, equity: r2(equity + open) });
  }
  if (pos) { const last = candles[candles.length - 1]; const half = last.c * costs.spreadPct / 2; closePos(pos.side === 'buy' ? last.c - half : last.c + half, 'end-of-data', last.t); curve[curve.length - 1].equity = equity; }

  const metrics = SC.compute(trades, { baseEquity: startingEquity });
  // drawdown on the mark-to-market curve (includes open-trade pain the closed-trade number hides)
  let peak = startingEquity, maxDdPct = 0;
  for (const pt of curve) { if (pt.equity > peak) peak = pt.equity; const d = (peak - pt.equity) / peak * 100; if (d > maxDdPct) maxDdPct = d; }
  metrics.endingEquity = equity;
  metrics.totalReturnPct = r2((equity - startingEquity) / startingEquity * 100);
  metrics.maxEquityDrawdownPct = r2(maxDdPct);
  const caveats = ['Past results do not predict future results.',
    'Not modelled: the price path inside each bar, overnight financing (swap), partial fills and requotes.'];
  if (metrics.n < 30) caveats.push('Only ' + metrics.n + ' trades — far too few to trust. Aim for 100+ before believing any number here.');
  if (o.noCosts) caveats.push('COSTS WERE SWITCHED OFF — this result is not achievable in a real account.');
  return { ok: true, symbol: instrument.symbol, strategy: strategy.id, params: p, bars: candles.length, firstBar: candles[0].t, lastBar: candles[candles.length - 1].t,
    startingEquity, riskPct, trades, skipped, metrics, equityCurve: curve, costs, caveats };
}

/* Walk-forward: run the SAME rules on an in-sample slice and on the unseen out-of-sample tail, and say plainly
   whether the edge survived. split = fraction of bars in-sample (default 0.7). */
function walkForward(opts) {
  const o = opts || {};
  const candles = cleanCandles(o.candles);
  const split = Number(o.split) > 0.2 && Number(o.split) < 0.9 ? Number(o.split) : 0.7;
  const cut = Math.floor(candles.length * split);
  const strategy = typeof o.strategy === 'string' ? S.get(o.strategy) : o.strategy;
  if (!strategy) return { ok: false, error: 'unknown strategy: ' + o.strategy };
  const warm = S.warmup(strategy, S.resolveParams(strategy, o.params));
  const inS = run(Object.assign({}, o, { candles: candles.slice(0, cut) }));
  // the out-of-sample run is given the warm-up bars before the cut so its indicators are ready on its first bar
  const outS = run(Object.assign({}, o, { candles: candles.slice(Math.max(0, cut - warm)) }));
  if (!inS.ok) return { ok: false, error: 'in-sample: ' + inS.error };
  if (!outS.ok) return { ok: false, error: 'out-of-sample: ' + outS.error };
  const flags = [];
  const a = inS.metrics, b = outS.metrics;
  if (b.n < 20) flags.push('Too few out-of-sample trades (' + b.n + ') to judge.');
  if (a.netPnl > 0 && b.netPnl <= 0) flags.push('OVERFIT WARNING: profitable in-sample but NOT out-of-sample.');
  if (a.profitFactor != null && b.profitFactor != null && a.profitFactor >= 1.3 && b.profitFactor < a.profitFactor * 0.6) flags.push('The profit factor fell from ' + a.profitFactor + ' in-sample to ' + b.profitFactor + ' out-of-sample.');
  if (a.netPnl <= 0) flags.push('Not profitable even in-sample — there is nothing here to validate.');
  const verdict = a.netPnl > 0 && b.netPnl > 0 && b.n >= 20 && !flags.some(f => /OVERFIT|fell from/.test(f)) ? 'survived' : (b.n < 20 ? 'inconclusive' : 'failed');
  return { ok: true, split, inSample: inS, outOfSample: outS, flags, verdict };
}

// a small deterministic PRNG (mulberry32) so a Monte Carlo run is reproducible from its seed.
function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
/* Monte Carlo over the ORDER of the trades: the same wins and losses, reshuffled `runs` times.
   Answers "how bad could the drawdown have been with the same edge and worse luck?" */
function monteCarlo(trades, opts) {
  const o = opts || {};
  const pnls = (Array.isArray(trades) ? trades : []).map(t => Number(t.pnl)).filter(Number.isFinite);
  const runs = Math.min(5000, Math.max(100, Math.floor(Number(o.runs) || 1000)));
  const start = Number(o.startingEquity) > 0 ? Number(o.startingEquity) : 10000;
  if (pnls.length < 5) return { ok: false, error: 'need at least 5 trades' };
  const rand = rng(o.seed == null ? 12345 : o.seed);
  const dds = [];
  const ruinPct = Number(o.ruinPct) > 0 ? Number(o.ruinPct) : 20;
  let ruined = 0;
  for (let k = 0; k < runs; k++) {
    const a = pnls.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    let eq = start, peak = start, dd = 0;
    for (const x of a) { eq += x; if (eq > peak) peak = eq; const d = (peak - eq) / peak * 100; if (d > dd) dd = d; }
    dds.push(dd); if (dd >= ruinPct) ruined++;
  }
  dds.sort((x, y) => x - y);
  const q = f => r2(dds[Math.min(dds.length - 1, Math.floor(dds.length * f))]);
  return { ok: true, runs, trades: pnls.length, medianDrawdownPct: q(0.5), p95DrawdownPct: q(0.95), worstDrawdownPct: r2(dds[dds.length - 1]), ruinPct, probabilityOfRuin: Number((ruined / runs).toFixed(4)) };
}

module.exports = { DEFAULT_COSTS, cleanCandles, run, walkForward, monteCarlo, rng };
