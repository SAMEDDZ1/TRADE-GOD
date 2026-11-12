/* node test/trading.breeder.test.js — the Strategy Breeder chooses on the past and judges on unseen data. */
'use strict';
const A = require('./_assert.js');
const Br = require('../sidecar/trading/breeder.js');
const B = require('../sidecar/trading/backtest.js');
const F = require('../sidecar/trading/feeds.js');

const candles = F.simCandles('XAUUSD', 'H1', 3000, Date.UTC(2026, 9, 1));
const r = Br.breed({ symbol: 'XAUUSD', candles, strategy: 'donchian-breakout', trials: 25, seed: 5 });
A.eq(r.ok, true, 'the breeder runs');
A.eq(r.tried, 25, 'it tried the asked number of variants');
A.eq(r.shortlist.length, 5, 'five go to the unseen-data test');
A.eq(r.shortlist[0].params, r.shortlist[0].params, 'params are reported');
A.ok(r.caveats[0].indexOf('25 variants were tried') === 0, 'the report leads with how many variants were tried (multiple testing)');
A.ok(/PAPER/.test(r.caveats[0]), 'and says a survivor is a candidate for paper trading, not a proven edge');
// the shortlist is the in-sample top 5 by score, in order
const scores = r.shortlist.map(x => Br.score(x.inSample));
A.eq(scores.slice().sort((a, b) => b - a), scores, 'the shortlist is ordered by in-sample score');
// survival is judged ONLY on the unseen period: re-run each shortlisted variant on the tail and compare
const cut = Math.floor(candles.length * 0.7);
for (const x of r.shortlist) {
  const warm = require('../sidecar/trading/strategies.js').warmup(require('../sidecar/trading/strategies.js').get('donchian-breakout'), x.params);
  const tail = B.run({ symbol: 'XAUUSD', candles: candles.slice(cut - warm), strategy: 'donchian-breakout', params: x.params });
  A.eq(JSON.stringify(x.outOfSample), JSON.stringify(tail.metrics), 'the unseen result is exactly a run on the unseen tail (' + JSON.stringify(x.params) + ')');
  const expectSurvive = tail.metrics.n >= 10 && tail.metrics.netPnl > 0 && (tail.metrics.profitFactor == null || tail.metrics.profitFactor >= 1.1)
    && !(x.inSample.profitFactor != null && tail.metrics.profitFactor != null && tail.metrics.profitFactor < x.inSample.profitFactor * 0.6);
  A.eq(x.survived, expectSurvive, 'the verdict follows the survival rules');
  A.eq(x.survived, x.reasons.length === 0, 'a failed variant says why');
}
A.eq(r.survivors, r.shortlist.filter(x => x.survived).length, 'the survivor count matches');
// the unseen data never influences the choice: changing ONLY the tail leaves the shortlist unchanged
{
  const altered = candles.slice(0, cut).concat(candles.slice(cut).map(k => ({ t: k.t, o: k.o * 1.3, h: k.h * 1.3, l: k.l * 1.3, c: k.c * 1.3 })));
  const r2 = Br.breed({ symbol: 'XAUUSD', candles: altered, strategy: 'donchian-breakout', trials: 25, seed: 5 });
  A.eq(r2.shortlist.map(x => JSON.stringify(x.params)), r.shortlist.map(x => JSON.stringify(x.params)), 'changing the unseen period does not change which variants were chosen');
}
// determinism, constraints, input checks
A.eq(JSON.stringify(Br.breed({ symbol: 'XAUUSD', candles, strategy: 'donchian-breakout', trials: 25, seed: 5 })), JSON.stringify(r), 'same inputs and seed -> the same report');
const ema = Br.breed({ symbol: 'XAUUSD', candles, strategy: 'ema-cross', trials: 30, seed: 2 });
A.ok(ema.ok && ema.shortlist.every(x => x.params.fast < x.params.slow), 'EMA variants always keep fast < slow');
A.eq(ema.defaults, { fast: 20, slow: 50, atrPeriod: 14, stopAtr: 2, targetR: 2, exitOnOpposite: 1 }, 'the defaults are the first variant');
A.ok(/not enough history/.test(Br.breed({ symbol: 'XAUUSD', candles: candles.slice(0, 300), strategy: 'ema-cross' }).error), 'too little history is refused');
A.eq(Br.breed({ symbol: 'XAUUSD', candles, strategy: 'nope' }).ok, false, 'unknown strategy');
A.eq(Br.score({ n: 0 }), -Infinity, 'no trades ranks last');
A.ok(Br.score({ n: 5, profitFactor: 4 }) < Br.score({ n: 40, profitFactor: 2 }), 'a small sample is shrunk toward breakeven, so 5 lucky trades do not beat 40 good ones');
A.report('trading.breeder');
