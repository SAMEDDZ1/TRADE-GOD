/* sidecar/trading/breeder.js — the STRATEGY BREEDER: search a strategy's settings without fooling yourself.

   Trying many parameter sets and keeping the best is the fastest way to build a strategy that only works on the past.
   So the breeder splits the history in two and never lets the second half influence a choice:

     1. TRAIN  — every variant is backtested on the first part of the history (in-sample).
     2. PICK   — the best few by in-sample result are shortlisted. This is the only place selection happens.
     3. JUDGE  — only the shortlist is run on the later, unseen part (out-of-sample). A variant SURVIVES only if it is
                 still profitable there, on enough trades, without its profit factor collapsing.

   The report always says how many variants were tried: the more you try, the more likely the best one is luck
   (the multiple-testing problem), so a survivor is a candidate for paper trading, never a proven edge.

   Variants: the strategy's defaults, then deterministic random draws inside each parameter's declared range
   (strategies.js resolveParams clamps them), with the strategy's own constraints respected (fast EMA < slow EMA).
   Same inputs + same seed -> the same report. Unit-tested in test/trading.breeder.test.js. */
'use strict';
const S = require('./strategies.js');
const B = require('./backtest.js');

function sample(strategy, rand) {
  const out = {};
  for (const [k, d] of Object.entries(strategy.params)) {
    if (k === 'exitOnOpposite') { out[k] = d.default; continue; }      // a switch, not a dial: keep the template's choice
    const steps = Math.max(1, Math.round((d.max - d.min) / d.step));
    out[k] = d.min + Math.floor(rand() * (steps + 1)) * d.step;
  }
  return S.resolveParams(strategy, out);
}
function valid(strategy, p) {
  if (strategy.id === 'ema-cross' && !(p.fast < p.slow)) return false;
  if (strategy.id === 'rsi-reversion' && !(p.oversold < p.overbought)) return false;
  return true;
}
const key = p => JSON.stringify(p);
function score(m) {
  // in-sample ranking: profit factor, but a handful of trades proves nothing — shrink small samples toward breakeven
  if (!m || !m.n) return -Infinity;
  const pf = m.profitFactor == null ? (m.netPnl > 0 ? 3 : 0) : m.profitFactor;
  // the shrink is SQUARED so a dozen lucky trades cannot outrank a real sample: 11 trades keep ~8% of their edge, 40+ keep all
  const w = Math.pow(Math.min(1, m.n / 40), 2);
  return 1 + (Math.min(pf, 10) - 1) * w;
}

/* breed({ symbol, candles, strategy, trials?, shortlist?, split?, seed?, rates?, riskPct?, startingEquity? }) */
function breed(opts) {
  const o = opts || {};
  const strategy = typeof o.strategy === 'string' ? S.get(o.strategy) : o.strategy;
  if (!strategy) return { ok: false, error: 'unknown strategy: ' + o.strategy };
  const candles = B.cleanCandles(o.candles);
  const split = Number(o.split) > 0.4 && Number(o.split) < 0.9 ? Number(o.split) : 0.7;
  const trials = Math.min(200, Math.max(5, Math.floor(Number(o.trials) || 40)));
  const shortlist = Math.min(10, Math.max(1, Math.floor(Number(o.shortlist) || 5)));
  const cut = Math.floor(candles.length * split);
  if (cut < 300 || candles.length - cut < 150) return { ok: false, error: 'not enough history to split: need at least ~450 bars (have ' + candles.length + ')' };
  const rand = B.rng(o.seed == null ? 99 : o.seed);
  const base = { symbol: o.symbol, rates: o.rates, riskPct: o.riskPct, startingEquity: o.startingEquity };

  // 1. the variants
  const seen = new Set(), variants = [];
  const first = S.resolveParams(strategy, {});
  if (valid(strategy, first)) { seen.add(key(first)); variants.push(first); }
  for (let tries = 0; variants.length < trials && tries < trials * 20; tries++) {
    const p = sample(strategy, rand);
    if (!valid(strategy, p) || seen.has(key(p))) continue;
    seen.add(key(p)); variants.push(p);
  }
  // 2. train every variant on the in-sample slice
  const train = candles.slice(0, cut);
  const trained = [];
  for (const params of variants) {
    const r = B.run(Object.assign({}, base, { candles: train, strategy, params }));
    if (r.ok) trained.push({ params, inSample: r.metrics, score: score(r.metrics) });
  }
  if (!trained.length) return { ok: false, error: 'no variant could be backtested on the in-sample period' };
  trained.sort((a, b) => b.score - a.score);
  // 3. judge only the shortlist on the unseen slice (with warm-up bars before the cut so indicators are ready)
  const results = [];
  for (const t of trained.slice(0, shortlist)) {
    const warm = S.warmup(strategy, t.params);
    const r = B.run(Object.assign({}, base, { candles: candles.slice(Math.max(0, cut - warm)), strategy, params: t.params }));
    const os = r.ok ? r.metrics : null;
    const reasons = [];
    if (!os) reasons.push('could not run on the unseen period: ' + r.error);
    else {
      if (os.n < 10) reasons.push('only ' + os.n + ' unseen trades');
      if (!(os.netPnl > 0)) reasons.push('lost money on unseen data');
      if (os.profitFactor != null && os.profitFactor < 1.1) reasons.push('unseen profit factor ' + os.profitFactor + ' (< 1.1)');
      if (t.inSample.profitFactor != null && os.profitFactor != null && os.profitFactor < t.inSample.profitFactor * 0.6) reasons.push('profit factor collapsed from ' + t.inSample.profitFactor + ' to ' + os.profitFactor);
    }
    results.push({ params: t.params, inSample: t.inSample, outOfSample: os, survived: reasons.length === 0, reasons });
  }
  const survivors = results.filter(x => x.survived);
  const caveats = [
    trials + ' variants were tried. The more variants you try, the more likely the best one is luck: treat any survivor as a candidate for PAPER trading, not a proven edge.',
    'Variants were chosen on the first ' + Math.round(split * 100) + '% of the history and judged only on the remaining ' + Math.round((1 - split) * 100) + '%, which never influenced the choice.'
  ];
  return { ok: true, strategy: strategy.id, symbol: o.symbol, bars: candles.length, split, tried: trained.length, shortlist: results, survivors: survivors.length,
    best: survivors[0] || null, defaults: first, caveats };
}

module.exports = { breed, score };
