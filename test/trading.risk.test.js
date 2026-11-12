/* node test/trading.risk.test.js — the risk engine: every limit, by hand-computed numbers. */
'use strict';
const A = require('./_assert.js');
const R = require('../sidecar/trading/risk.js');

const codes = r => r.violations.map(v => v.code).sort();
const base = extra => Object.assign({ equity: 10000, accountCcy: 'USD', dayStartEquity: 10000, positions: [], rates: {}, halted: false }, extra || {});
const gold = extra => Object.assign({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, entry: 2650, stop: 2640, takeProfit: 2670 }, extra || {});

// ---- a clean trade: 0.1 lot gold, $10 stop = $100 = exactly 1% of $10,000 ----
{
  const r = R.checkOrder(gold(), base());
  A.eq(r.ok, true, 'a 1%-risk gold trade with a stop passes: ' + JSON.stringify(r.violations));
  A.eq(r.metrics.riskAmount, 100, 'risk is $100');
  A.eq(r.metrics.riskPct, 1, 'risk is 1% of equity');
  A.eq(r.metrics.notional, 26500, 'notional is $26,500');
  A.eq(r.metrics.leverageAfter, 2.65, 'leverage is 2.65:1');
  A.eq(r.metrics.rewardRisk, 2, 'reward:risk is 2');
  A.eq(r.metrics.marginAfter, 2650, 'margin at the 10:1 cap is $2,650');
}
// ---- the stop-loss law ----
A.eq(codes(R.checkOrder(gold({ stop: undefined }), base())), ['no-stop'], 'no stop -> no trade');
A.eq(codes(R.checkOrder(gold({ stop: 0 }), base())), ['no-stop'], 'a zero stop is no stop');
A.eq(codes(R.checkOrder(gold({ stop: 2660 }), base())), ['stop-wrong-side'], 'a buy with its stop above the entry is refused');
A.eq(codes(R.checkOrder(gold({ side: 'sell', stop: 2640, takeProfit: 2630 }), base())), ['stop-wrong-side'], 'a sell with its stop below the entry is refused');
A.eq(codes(R.checkOrder(gold({ takeProfit: 2600 }), base())), ['tp-wrong-side'], 'a buy with its target below the entry is refused');
A.eq(R.checkOrder(gold({ side: 'sell', stop: 2660, takeProfit: 2630 }), base()).ok, true, 'a correct short passes');
A.eq(R.checkOrder(gold({ takeProfit: undefined }), base()).ok, true, 'a take-profit is optional');

// ---- risk per trade ----
A.eq(codes(R.checkOrder(gold({ lots: 0.11 }), base())), ['risk-per-trade'], '0.11 lot = $110 = 1.1% -> over the 1% limit');
A.eq(R.checkOrder(gold({ lots: 0.05 }), base()).ok, true, 'half the size passes');

// ---- bad input ----
A.eq(codes(R.checkOrder({ symbol: 'NOPE', side: 'buy', lots: 1, entry: 1, stop: 0.5 }, base())), ['unknown-instrument'], 'unknown instrument');
A.ok(codes(R.checkOrder(gold({ lots: 0.105 }), base())).indexOf('lot-step') >= 0, 'a size off the lot step is refused');
A.ok(codes(R.checkOrder(gold({ lots: 0 }), base())).indexOf('bad-size') >= 0, 'zero size is refused');
A.ok(codes(R.checkOrder(gold({ side: 'hold' }), base())).indexOf('bad-side') >= 0, 'a side that is not buy/sell is refused');
A.eq(codes(R.checkOrder(gold(), base({ equity: 0 }))), ['no-equity'], 'no equity -> nothing is allowed');

// ---- the kill switch ----
A.ok(codes(R.checkOrder(gold(), base({ halted: true }))).indexOf('halted') >= 0, 'halted -> nothing new');

// ---- the daily loss limit (3% of the day's opening equity) ----
A.ok(codes(R.checkOrder(gold({ lots: 0.01 }), base({ equity: 9700 }))).indexOf('daily-loss') >= 0, 'down 3% on the day -> trading stops for today');
A.ok(codes(R.checkOrder(gold({ lots: 0.01 }), base({ equity: 9600 }))).indexOf('daily-loss') >= 0, 'down 4% on the day -> still stopped');
// down $250 of a $300 budget leaves $50: a $60-risk trade is refused, a $50-risk trade is allowed
A.eq(codes(R.checkOrder(gold({ lots: 0.06 }), base({ equity: 9750 }))), ['daily-loss-headroom'], 'a trade may not risk more than what is left of today\'s loss budget');
A.eq(R.checkOrder(gold({ lots: 0.05 }), base({ equity: 9750 })).ok, true, 'a trade that fits the remaining budget passes');
A.eq(R.checkOrder(gold(), base({ equity: 10500, dayStartEquity: 10000 })).ok, true, 'a winning day does not restrict anything');

// ---- position count ----
{
  const five = [1, 2, 3, 4, 5].map(() => ({ symbol: 'EURUSD', side: 'buy', lots: 0.01, entry: 1.08, stop: 1.079 }));
  A.ok(codes(R.checkOrder(gold({ lots: 0.01 }), base({ positions: five }))).indexOf('max-positions') >= 0, 'a 6th position is refused');
  A.eq(R.checkOrder(gold({ lots: 0.01 }), base({ positions: five.slice(0, 4) })).ok, true, 'a 5th position is allowed');
}
// ---- total open risk (5%): four positions at $110 each + a $100 trade = $540 > $500 ----
{
  const four = [1, 2, 3, 4].map(() => ({ symbol: 'EURUSD', side: 'buy', lots: 0.1, entry: 1.0800, stop: 1.0690 }));
  const r = R.checkOrder(gold(), base({ positions: four }));
  A.eq(codes(r), ['total-risk'], 'total open risk over 5% is refused: ' + JSON.stringify(r.violations));
  A.eq(r.metrics.openRiskPct, 5.4, 'open risk would be 5.4%');
  A.eq(R.checkOrder(gold({ lots: 0.06 }), base({ positions: four })).ok, true, '$440 + $60 = exactly 5% passes');
}
// an open position with no stop makes total risk unknowable -> refuse, do not guess
A.ok(codes(R.checkOrder(gold({ lots: 0.01 }), base({ positions: [{ symbol: 'EURUSD', side: 'buy', lots: 0.1, entry: 1.08 }] }))).indexOf('open-risk-unknown') >= 0, 'an unprotected open position blocks new trades');

// ---- same-symbol concentration: two $100 gold longs + a third = $300 > 2 x 1% ----
{
  const two = [1, 2].map(() => ({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, entry: 2650, stop: 2640 }));
  A.ok(codes(R.checkOrder(gold(), base({ positions: two }))).indexOf('symbol-concentration') >= 0, 'stacking a third full-risk trade on one symbol is refused');
  A.ok(codes(R.checkOrder(gold({ side: 'sell', stop: 2660, takeProfit: 2630 }), base({ positions: two }))).indexOf('symbol-concentration') < 0, 'the opposite direction is not concentration');
}
// ---- leverage ----
{
  const r = R.checkOrder(gold({ lots: 0.4, stop: 2649 }), base());   // $106,000 notional, only $40 risk
  A.ok(codes(r).indexOf('max-leverage') >= 0, '10.6:1 gross leverage is over the 10:1 policy limit');
  A.eq(r.metrics.leverageAfter, 10.6, 'leverage would be 10.6:1');
  A.ok(codes(r).indexOf('risk-per-trade') < 0, 'a tight stop does not excuse the leverage');
}
{ // Canada: crypto capped at 2:1 here. 0.4 BTC at 68,000 = $27,200 = 2.72:1
  const r = R.checkOrder({ symbol: 'BTCUSD', side: 'buy', lots: 0.4, entry: 68000, stop: 67900 }, base());
  A.ok(codes(r).indexOf('instrument-leverage') >= 0, 'crypto over its class cap is refused');
  A.ok(codes(r).indexOf('max-leverage') < 0, 'it is under the 10:1 gross limit — the class cap is what bites');
  A.eq(R.checkOrder({ symbol: 'BTCUSD', side: 'buy', lots: 0.25, entry: 68000, stop: 67900 }, base()).ok, true, '0.25 BTC = 1.7:1 passes');
}
A.eq(R.leverageCap(R.DEFAULT_POLICY, require('../sidecar/trading/instruments.js').get('EURUSD')), 10, 'policy 10:1 beats the 30:1 regulatory cap (the LOWER limit wins)');
A.eq(R.leverageCap(Object.assign({}, R.DEFAULT_POLICY, { maxLeverage: 30 }), require('../sidecar/trading/instruments.js').get('XAUUSD')), 20, 'at policy 30:1 the 20:1 gold cap wins');
A.eq(R.leverageCap(Object.assign({}, R.DEFAULT_POLICY, { maxLeverage: 30, jurisdiction: 'NONE' }), require('../sidecar/trading/instruments.js').get('XAUUSD')), 30, 'no regulatory table -> the policy limit');

// ---- currency: a yen-quoted trade cannot be sized without USD/JPY ----
A.ok(codes(R.checkOrder({ symbol: 'USDJPY', side: 'buy', lots: 0.1, entry: 150, stop: 149.5 }, base())).indexOf('no-fx-rate') >= 0, 'no exchange rate -> refuse, do not guess');
{
  const r = R.checkOrder({ symbol: 'USDJPY', side: 'buy', lots: 0.1, entry: 150, stop: 149.5 }, base({ rates: { USDJPY: 150 } }));
  A.eq(r.ok, true, 'with the rate it passes: ' + JSON.stringify(r.violations));
  A.eq(r.metrics.riskAmount, 33.33, '5,000 yen of risk = $33.33');
}
// ---- policy blocks ----
A.ok(codes(R.checkOrder(gold(), base(), Object.assign({}, R.DEFAULT_POLICY, { blockedSymbols: ['XAUUSD'] }))).indexOf('blocked-symbol') >= 0, 'a blocked symbol is refused');
A.ok(codes(R.checkOrder(gold(), base(), Object.assign({}, R.DEFAULT_POLICY, { allowedClasses: ['forex'] }))).indexOf('blocked-class') >= 0, 'a disabled desk is refused');

// ---- sizing ----
A.eq(R.sizeForRisk({ symbol: 'XAUUSD', equity: 10000, riskPct: 1, entry: 2650, stop: 2640 }), { lots: 0.1, riskAmount: 100 }, '$10 stop on gold at 1% of $10k -> 0.1 lot');
A.eq(R.sizeForRisk({ symbol: 'XAUUSD', equity: 10000, riskPct: 1, entry: 2650, stop: 2600 }), { lots: 0.02, riskAmount: 100 }, '$50 stop -> 0.02 lot');
A.eq(R.sizeForRisk({ symbol: 'XAUUSD', equity: 10000, riskPct: 1, entry: 2650, stop: 2643 }).lots, 0.14, 'sizes round DOWN (0.1428 -> 0.14)');
A.eq(R.sizeForRisk({ symbol: 'XAUUSD', equity: 10000, riskPct: 1, entry: 2650, stop: 1650 }).lots, 0, 'a stop too wide for the account sizes to zero — no trade');
A.eq(R.sizeForRisk({ symbol: 'XAGUSD', equity: 10000, riskPct: 1, entry: 31, stop: 30.8 }), { lots: 0.1, riskAmount: 100 }, 'silver: $0.20 stop x 5,000 oz -> 0.1 lot');
A.eq(R.sizeForRisk({ symbol: 'USDJPY', equity: 10000, riskPct: 1, entry: 150, stop: 149.5 }).lots, 0, 'no rate -> cannot size');
A.eq(R.sizeForRisk({ symbol: 'USDJPY', equity: 10000, riskPct: 1, entry: 150, stop: 149.5, rates: { USDJPY: 150 } }).lots, 0.3, 'with the rate: 0.3 lot');
// whatever sizeForRisk returns must pass the gate's own risk-per-trade rule
for (const stop of [2649, 2645.5, 2640, 2633.33, 2600, 2500]) {
  const s = R.sizeForRisk({ symbol: 'XAUUSD', equity: 10000, riskPct: 1, entry: 2650, stop });
  if (s.lots > 0) A.ok(codes(R.checkOrder(gold({ lots: s.lots, stop, takeProfit: undefined }), base())).indexOf('risk-per-trade') < 0, 'a sized trade never breaks the per-trade limit (stop ' + stop + ')');
}

// ---- the leverage ceiling on SIZE ----
{
  // gold at 2650, Canada caps gold at 20:1 but policy is 10:1 -> $100,000 of notional on $10,000 = 0.377 lot
  A.eq(R.maxLotsByLeverage({ symbol: 'XAUUSD', equity: 10000, entry: 2650 }), 0.37, 'gold: 10:1 on $10k at 2650 -> 0.37 lot');
  A.eq(R.maxLotsByLeverage({ symbol: 'BTCUSD', equity: 10000, entry: 68000 }), 0.2941, 'bitcoin: the 2:1 crypto cap -> 0.2941 BTC (lot step 0.0001)');
  const open = [{ symbol: 'EURUSD', side: 'buy', lots: 0.5, entry: 1.08, stop: 1.07 }];   // $54,000 gross
  A.eq(R.maxLotsByLeverage({ symbol: 'XAUUSD', equity: 10000, entry: 2650, positions: open }), 0.17, 'existing exposure uses up gross headroom: ($100k - $54k) / $265k');
  A.eq(R.maxLotsByLeverage({ symbol: 'XAUUSD', equity: 10000, entry: 2650, positions: [{ symbol: 'NOPE', lots: 1, entry: 1 }] }), 0, 'an open position that cannot be valued leaves no promised headroom');
  for (const lots of [0.37, 0.2941]) {
    const sym = lots === 0.37 ? 'XAUUSD' : 'BTCUSD', entry = lots === 0.37 ? 2650 : 68000;
    A.eq(R.checkOrder({ symbol: sym, side: 'buy', lots, entry, stop: entry * 0.99999 }, base()).violations.filter(v => /leverage|margin/.test(v.code)).length, 0, sym + ': the max size passes every leverage rule');
  }
}
// ---- changing the policy ----
{
  const t = R.applyPolicyChange(R.DEFAULT_POLICY, { riskPerTradePct: 0.5 });
  A.eq(t.ok && t.policy.riskPerTradePct, 0.5, 'anyone may TIGHTEN a limit');
  A.eq(t.changes[0].direction, 'tighten', 'and it is recorded as a tightening');
  const l = R.applyPolicyChange(R.DEFAULT_POLICY, { riskPerTradePct: 2 });
  A.eq(l.ok, false, 'LOOSENING without the Commander is refused');
  A.eq(l.policy.riskPerTradePct, 1, 'and nothing changed');
  A.eq(R.applyPolicyChange(R.DEFAULT_POLICY, { riskPerTradePct: 2 }, { commander: true }).policy.riskPerTradePct, 2, 'the Commander may loosen');
  A.eq(R.applyPolicyChange(R.DEFAULT_POLICY, { riskPerTradePct: 6 }, { commander: true }).ok, false, 'not even the Commander passes the absolute ceiling');
  A.eq(R.applyPolicyChange(R.DEFAULT_POLICY, { maxLeverage: 31 }, { commander: true }).ok, false, 'leverage ceiling holds');
  A.eq(R.applyPolicyChange(R.DEFAULT_POLICY, { requireStop: false }, { commander: true }).ok, false, 'the stop-loss law cannot be switched off by anyone');
  const mixed = R.applyPolicyChange(R.DEFAULT_POLICY, { riskPerTradePct: 0.5, maxLeverage: 20 });
  A.eq(mixed.ok, false, 'one refused field refuses the whole change');
  A.eq(mixed.policy.riskPerTradePct, 1, 'so the tightening in the same request did not sneak through either');
  A.eq(R.applyPolicyChange(R.DEFAULT_POLICY, { blockedSymbols: ['gold'] }).policy.blockedSymbols, ['XAUUSD'], 'blocking a symbol is a tightening');
  const blocked = Object.assign({}, R.DEFAULT_POLICY, { blockedSymbols: ['XAUUSD'] });
  A.eq(R.applyPolicyChange(blocked, { blockedSymbols: [] }).ok, false, 'unblocking needs the Commander');
  A.eq(R.applyPolicyChange(R.DEFAULT_POLICY, { allowedClasses: ['forex', 'metals'] }).policy.allowedClasses, ['metals', 'forex'], 'closing desks is a tightening');
  A.eq(R.applyPolicyChange(Object.assign({}, R.DEFAULT_POLICY, { allowedClasses: ['forex'] }), { allowedClasses: ['forex', 'crypto'] }).ok, false, 'opening a desk needs the Commander');
  A.eq(R.applyPolicyChange(R.DEFAULT_POLICY, { jurisdiction: 'NONE' }).ok, false, 'dropping the regulatory table needs the Commander');
}
// a stored policy is clamped back inside the bounds on load
{
  const p = R.sanitizePolicy({ riskPerTradePct: 50, maxLeverage: 500, maxOpenPositions: 3.9, requireStop: false, jurisdiction: 'XX', blockedSymbols: ['gold', 'nope'] });
  A.eq([p.riskPerTradePct, p.maxLeverage, p.maxOpenPositions, p.requireStop, p.jurisdiction], [5, 30, 3, true, 'CA'], 'a hand-edited policy file cannot exceed the ceilings or drop the stop law');
  A.eq(p.blockedSymbols, ['XAUUSD'], 'blocked symbols are normalized');
  A.eq(R.sanitizePolicy(null).riskPerTradePct, 1, 'no file -> defaults');
}
A.report('trading.risk');
