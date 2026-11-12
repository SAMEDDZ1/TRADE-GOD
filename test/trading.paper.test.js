/* node test/trading.paper.test.js — the paper broker: fills, spreads, stops, gaps, fees, currency, persistence. */
'use strict';
const A = require('./_assert.js');
const Paper = require('../sidecar/trading/paper.js');

const T0 = Date.UTC(2026, 10, 11, 15, 0, 0);
const mk = o => Paper.create(Object.assign({ startingBalance: 10000 }, o || {}));
const gold = (b, bid, ask, t) => b.onPrice('XAUUSD', bid, ask, t || T0);

// ---- you BUY at the ask, are marked at the bid, and the spread is a real cost ----
{
  const b = mk();
  A.eq(b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640 }, T0).ok, false, 'no price yet -> no fill');
  gold(b, 2650.00, 2650.30);
  const r = b.placeMarket({ symbol: 'gold', side: 'buy', lots: 0.1, stop: 2640, takeProfit: 2670, agentId: 'metals', ticketId: 'K1' }, T0);
  A.eq(r.ok, true, 'market buy fills');
  A.eq(r.position.entry, 2650.30, 'a buy fills at the ASK');
  A.eq(r.position.symbol, 'XAUUSD', 'the symbol is canonical');
  A.eq(b.account().equity, 9997, 'equity is immediately down the spread: (2650.00-2650.30) x 10 oz = -$3');
  gold(b, 2660.00, 2660.30);
  A.eq(b.account().unrealized, 97, 'marked at the BID: (2660.00-2650.30) x 10 = +$97');
  A.eq(b.positions()[0].mark, 2660, 'the position shows the price it could close at');
  const ev = gold(b, 2670.10, 2670.40);
  A.eq(ev.length, 1, 'the take-profit triggers');
  A.eq([ev[0].type, ev[0].trade.reason, ev[0].trade.exit], ['position.closed', 'take-profit', 2670], 'a take-profit fills AT its price, not better');
  A.eq(ev[0].trade.pnl, 197, '(2670-2650.30) x 10 = +$197');
  A.eq(ev[0].trade.rMultiple, 1.91, 'R = 19.70 / 10.30 = 1.91');
  A.eq([ev[0].trade.agentId, ev[0].trade.ticketId], ['metals', 'K1'], 'the trade keeps who proposed it');
  A.eq(b.account().balance, 10197, 'balance is realized P&L');
  A.eq(b.positions().length, 0, 'the position is gone');
}
// ---- a stop that is GAPPED THROUGH fills at the gapped price (slippage is real) ----
{
  const b = mk();
  gold(b, 2650.00, 2650.30);
  b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640 }, T0);
  const ev = gold(b, 2630.00, 2630.30);
  A.eq([ev[0].trade.reason, ev[0].trade.exit], ['stop', 2630], 'gapped stop exits at the bid, not at the stop price');
  A.eq(ev[0].trade.pnl, -203, '(2630-2650.30) x 10 = -$203 — worse than the planned -$103');
  A.eq(ev[0].trade.rMultiple, -1.97, 'and R shows the slippage: worse than -1');
}
{ // a stop touched exactly fills at the stop
  const b = mk();
  gold(b, 2650.00, 2650.30);
  b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640 }, T0);
  A.eq(gold(b, 2640.10, 2640.40).length, 0, 'a bid above the stop does nothing');
  A.eq(gold(b, 2640.00, 2640.30)[0].trade.exit, 2640, 'bid == stop fills at the stop');
}
// ---- shorts: sell at the bid, stop triggers on the ASK ----
{
  const b = mk();
  gold(b, 2650.00, 2650.30);
  const r = b.placeMarket({ symbol: 'XAUUSD', side: 'sell', lots: 0.1, stop: 2660, takeProfit: 2630 }, T0);
  A.eq(r.position.entry, 2650, 'a sell fills at the BID');
  A.eq(gold(b, 2659.60, 2659.90).length, 0, 'ask below the stop: nothing');
  const ev = gold(b, 2659.80, 2660.10);
  A.eq([ev[0].trade.reason, ev[0].trade.exit, ev[0].trade.pnl], ['stop', 2660.10, -101], 'the short stops out on the ask: (2650-2660.10) x 10 = -$101');
}
// ---- the stop-loss law lives in the broker too ----
{
  const b = mk();
  gold(b, 2650.00, 2650.30);
  A.eq(b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1 }, T0).ok, false, 'no stop -> refused');
  A.eq(b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2655 }, T0).ok, false, 'stop above a buy -> refused');
  A.eq(b.placeMarket({ symbol: 'XAUUSD', side: 'sell', lots: 0.1, stop: 2645 }, T0).ok, false, 'stop below a sell -> refused');
  A.eq(b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640, takeProfit: 2645 }, T0).ok, false, 'target on the wrong side -> refused');
  A.eq(b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.105, stop: 2640 }, T0).ok, false, 'size off the lot step -> refused');
  A.eq(b.placeMarket({ symbol: 'NOPE', side: 'buy', lots: 1, stop: 1 }, T0).ok, false, 'unknown instrument -> refused');
  A.eq(b.placePending({ symbol: 'XAUUSD', side: 'buy', type: 'limit', price: 2640, lots: 0.1 }, T0).ok, false, 'a pending order needs a stop too');
  A.eq(b.positions().length + b.orders().length, 0, 'nothing got through');
}
// ---- pending orders ----
{
  const b = mk();
  gold(b, 2650.00, 2650.30);
  const lim = b.placePending({ symbol: 'XAUUSD', side: 'buy', type: 'limit', price: 2640, lots: 0.1, stop: 2630, takeProfit: 2660 }, T0);
  A.eq(lim.ok, true, 'limit order rests');
  A.eq(gold(b, 2640.00, 2640.30).length, 0, 'ask above the limit: no fill');
  const ev = gold(b, 2639.70, 2640.00);
  A.eq([ev[0].type, ev[0].position.entry], ['order.filled', 2640], 'a limit fills at ITS price when the ask reaches it');
  A.eq(b.orders().length, 0, 'the order is consumed');
}
{
  const b = mk();
  gold(b, 2650.00, 2650.30);
  b.placePending({ symbol: 'XAUUSD', side: 'buy', type: 'stop', price: 2660, lots: 0.1, stop: 2650, takeProfit: 2690 }, T0);
  const ev = gold(b, 2660.70, 2661.00);
  A.eq([ev[0].type, ev[0].position.entry], ['order.filled', 2661], 'a stop ENTRY fills at the market it finds — slippage included');
}
{ // the market jumps past the target before the breakout order can fill: the order is void, not filled into a loss
  const b = mk();
  gold(b, 2650.00, 2650.30);
  b.placePending({ symbol: 'XAUUSD', side: 'buy', type: 'stop', price: 2660, lots: 0.1, stop: 2655, takeProfit: 2662 }, T0);
  const ev = gold(b, 2662.70, 2663.00);
  A.eq([ev.length, ev[0].type], [1, 'order.cancelled'], 'a gap past the target voids the order');
  A.eq(b.positions().length, 0, 'no position was opened');
}
{
  const b = mk();
  gold(b, 2650.00, 2650.30);
  const o = b.placePending({ symbol: 'XAUUSD', side: 'sell', type: 'limit', price: 2660, lots: 0.1, stop: 2670 }, T0);
  A.eq(b.cancelOrder(o.order.id, T0).ok, true, 'a resting order can be cancelled');
  A.eq(b.cancelOrder(o.order.id, T0).ok, false, 'but only once');
}
// ---- commissions: charged per lot, per side, and the trade reports the NET ----
{
  const b = mk({ commissionPerLot: { metals: 5 } });
  gold(b, 2650.00, 2650.00);
  b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640 }, T0);
  A.eq(b.account().balance, 9999.5, 'the entry commission ($5 x 0.1 lot) is charged at once');
  gold(b, 2660.00, 2660.00);
  const r = b.closePosition(b.positions()[0].id, 'manual', T0);
  A.eq([r.trade.fees, r.trade.pnl], [1, 99], '+$100 gross, $1 round-trip commission -> +$99 net');
  A.eq(b.account().balance, 10099, 'and the balance agrees with the trade');
}
// ---- currency: yen P&L is converted at the live rate; an unconvertible position is refused at the door ----
{
  const b = mk();
  b.onPrice('USDJPY', 150.00, 150.02, T0);
  b.placeMarket({ symbol: 'USDJPY', side: 'buy', lots: 0.1, stop: 149.50 }, T0);
  b.onPrice('USDJPY', 150.52, 150.54, T0);
  const r = b.closePosition(b.positions()[0].id, 'manual', T0);
  A.eq(r.trade.pnl, Math.round(5000 / 150.53 * 100) / 100, '5,000 yen converted at the mid rate of the moment');
  b.onPrice('EURGBP', 0.8500, 0.8502, T0);
  const no = b.placeMarket({ symbol: 'EURGBP', side: 'buy', lots: 0.1, stop: 0.8450 }, T0);
  A.ok(!no.ok && /exchange rate/.test(no.error), 'no GBP/USD price -> the position is refused, not carried at a guess');
  b.onPrice('GBPUSD', 1.2700, 1.2702, T0);
  A.eq(b.placeMarket({ symbol: 'EURGBP', side: 'buy', lots: 0.1, stop: 0.8450 }, T0).ok, true, 'once the rate exists it fills');
}
// ---- the kill switch's hands ----
{
  const b = mk();
  gold(b, 2650.00, 2650.30); b.onPrice('EURUSD', 1.0800, 1.0801, T0);
  b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640 }, T0);
  b.placeMarket({ symbol: 'EURUSD', side: 'sell', lots: 0.1, stop: 1.0850 }, T0);
  b.placePending({ symbol: 'XAUUSD', side: 'buy', type: 'limit', price: 2630, lots: 0.1, stop: 2620 }, T0);
  const r = b.closeAll('kill-switch', T0);
  A.eq([r.ok, b.positions().length, b.orders().length], [true, 0, 0], 'closeAll flattens everything');
  A.eq(r.events.filter(e => e.type === 'position.closed').length, 2, 'two positions closed');
  A.eq(r.events.filter(e => e.type === 'order.cancelled').length, 1, 'one order cancelled');
  A.ok(b.trades().every(t => t.reason === 'kill-switch'), 'every exit is marked kill-switch');
}
// ---- moving a stop: allowed, but it can never be removed ----
{
  const b = mk();
  gold(b, 2650.00, 2650.30);
  const p = b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640 }, T0).position;
  gold(b, 2665.00, 2665.30);
  A.eq(b.modifyPosition(p.id, { stop: 2655 }, T0).ok, true, 'a trailing stop above the entry on a winning long is fine');
  A.eq(b.modifyPosition(p.id, { stop: 0 }, T0).ok, false, 'the stop cannot be removed');
  A.eq(b.modifyPosition(p.id, { stop: 2666 }, T0).ok, false, 'nor placed above the current price');
  A.eq(b.modifyPosition(p.id, { takeProfit: null }, T0).ok, true, 'a take-profit may be removed');
  const ev = gold(b, 2654.90, 2655.20);
  A.eq([ev[0].trade.exit, ev[0].trade.pnl], [2654.9, 46], 'the trailed stop locks profit, filled at the bid that crossed it: (2654.90-2650.30) x 10 = +$46');
  A.eq(ev[0].trade.rMultiple, 0.45, 'R is still measured against the stop the trade was OPENED with: 4.60 / 10.30');
}
// ---- the trading day: the first action of a new day re-bases the day's opening equity ----
{
  const b = mk();
  gold(b, 2650.00, 2650.00, T0);
  A.eq(b.account().dayStartEquity, 10000, 'day one opens at the starting balance');
  b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640 }, T0);
  gold(b, 2645.00, 2645.00, T0 + 3600000);
  A.eq(b.account().dayPnl, -50, 'down $50 on the day');
  A.eq(b.account().dayKey, '2026-11-11', 'the day key is the UTC-5 calendar day');
  gold(b, 2645.00, 2645.00, T0 + 24 * 3600000);
  A.eq([b.account().dayKey, b.account().dayStartEquity, b.account().dayPnl], ['2026-11-12', 9950, 0], 'the next day starts from yesterday\'s closing equity');
}
// ---- state is plain JSON: snapshot, restore, carry on ----
{
  const b = mk();
  gold(b, 2650.00, 2650.30);
  b.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2640, takeProfit: 2670 }, T0);
  const b2 = Paper.create({ state: JSON.parse(JSON.stringify(b.snapshot())) });
  A.eq(b2.positions().length, 1, 'a restored account still holds its position');
  A.eq(b2.account().equity, b.account().equity, 'and the same equity');
  const ev = b2.onPrice('XAUUSD', 2639.00, 2639.30, T0 + 1000);
  A.eq(ev[0].trade.reason, 'stop', 'and its stop still works after the restore');
  const next = b2.placeMarket({ symbol: 'XAUUSD', side: 'buy', lots: 0.1, stop: 2630 }, T0 + 2000);
  A.ok(next.position.id !== ev[0].trade.positionId && next.position.id !== ev[0].trade.id, 'ids keep counting up after a restore (no collisions)');
  A.eq(Paper.create({ state: { version: 999 } }).account().balance, 10000, 'a state from an unknown version is not trusted: fresh account');
}
// ---- bad ticks are ignored, never applied ----
{
  const b = mk();
  A.eq(b.onPrice('XAUUSD', 0, 2650, T0).length + b.onPrice('XAUUSD', 2651, 2650, T0).length + b.onPrice('NOPE', 1, 2, T0).length, 0, 'zero, crossed and unknown ticks do nothing');
  A.eq(b.price('XAUUSD'), null, 'and leave no price behind');
}
A.report('trading.paper');
