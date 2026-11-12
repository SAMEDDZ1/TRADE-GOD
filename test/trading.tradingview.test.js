/* node test/trading.tradingview.test.js — TradingView alerts become proposals, never orders, and only with the secret. */
'use strict';
const A = require('./_assert.js');
const TV = require('../sidecar/trading/tradingview.js');

const SECRET = 'correct-horse-battery';
const j = o => JSON.stringify(Object.assign({ secret: SECRET, symbol: 'XAUUSD', exchange: 'OANDA', action: 'buy', price: 2650, stop: 2640, takeProfit: 2670, strategy: 'gold breakout', timeframe: '60', time: '2026-11-11T15:00:00Z' }, o || {}));

// ---- the recommended JSON message ----
{
  const r = TV.parse(j(), SECRET);
  A.eq(r.ok, true, 'a complete alert parses');
  A.eq(r.kind, 'entry', 'a buy is an entry');
  A.eq(r.proposal, { symbol: 'XAUUSD', side: 'buy', entry: 2650, stop: 2640, takeProfit: 2670, orderType: 'market', source: 'tradingview', agentId: 'tradingview',
    strategy: 'gold breakout', timeframe: '60', confidence: null, thesis: 'TradingView alert "gold breakout" on the 60 chart.' }, 'it becomes a PROPOSAL with exactly these fields');
  A.ok(JSON.stringify(r).indexOf(SECRET) < 0, 'the secret is never echoed back');
  A.ok(/^[0-9a-f]{24}$/.test(r.dedupeKey), 'it carries a dedupe key');
  A.eq(TV.parse(j(), SECRET).dedupeKey, r.dedupeKey, 'the same alert twice has the same key');
  A.ok(TV.parse(j({ time: '2026-11-11T16:00:00Z' }), SECRET).dedupeKey !== r.dedupeKey, 'a later alert has a different key');
}
// ---- the secret ----
A.eq(TV.parse(j({ secret: 'wrong-secret-12345' }), SECRET).status, 401, 'a wrong secret is refused');
A.eq(TV.parse(j({ secret: undefined }), SECRET).status, 401, 'a missing secret is refused');
A.eq(TV.parse(j({ secret: 12345 }), SECRET).status, 401, 'a non-string secret is refused');
A.eq(TV.parse(j(), '').status, 503, 'with no secret configured, alerts are switched off entirely');
A.eq(TV.parse(j({ secret: 'short' }), 'short').status, 503, 'a secret under 12 characters does not count as configured');
A.eq(TV.safeEqual('abc', 'abc') && !TV.safeEqual('abc', 'abd') && !TV.safeEqual('abc', 'abcd'), true, 'constant-time comparison is correct');

// ---- the stop-loss law reaches alerts too ----
A.ok(/no stop-loss/.test(TV.parse(j({ stop: undefined }), SECRET).error), 'an alert with no stop is refused');
A.eq(TV.parse(j({ stop: 2660 }), SECRET).status, 400, 'a stop on the wrong side is refused');
A.eq(TV.parse(j({ takeProfit: 2600 }), SECRET).status, 400, 'a target on the wrong side is refused');
{
  const r = TV.parse(j({ stop: undefined, takeProfit: undefined, stopPct: 0.5, takeProfitPct: 1 }), SECRET);
  A.eq([r.proposal.stop, r.proposal.takeProfit], [2636.75, 2676.5], 'percent distances are turned into prices: 2650 -0.5% / +1%');
  const s = TV.parse(j({ action: 'sell', stop: undefined, takeProfit: undefined, stopPct: 0.5, takeProfitPct: 1 }), SECRET);
  A.eq([s.proposal.side, s.proposal.stop, s.proposal.takeProfit], ['sell', 2663.25, 2623.5], 'and mirrored for a short');
}
// ---- symbols and actions ----
A.eq(TV.parse(j({ symbol: 'EURUSD', exchange: 'FX', price: 1.08, stop: 1.075, takeProfit: 1.09 }), SECRET).proposal.symbol, 'EURUSD', 'an exchange-prefixed FX symbol resolves');
A.eq(TV.parse(j({ symbol: 'BINANCE:BTCUSDT', exchange: undefined, price: 68000, stop: 67000, takeProfit: 70000 }), SECRET).proposal.symbol, 'BTCUSD', 'a prefixed crypto symbol resolves');
A.eq(TV.parse(j({ symbol: 'ZZZZZ' }), SECRET).status, 400, 'an unknown symbol is refused');
A.eq(TV.parse(j({ action: 'long' }), SECRET).proposal.side, 'buy', 'long = buy');
A.eq(TV.parse(j({ action: 'short', stop: 2660, takeProfit: 2630 }), SECRET).proposal.side, 'sell', 'short = sell');
A.eq(TV.parse(j({ action: 'hodl' }), SECRET).status, 400, 'an unknown action is refused');
A.eq(TV.parse(j({ price: undefined }), SECRET).status, 400, 'an entry needs a price');
A.eq(TV.parse(j({ confidence: 0.7 }), SECRET).proposal.confidence, 0.7, 'a 0..1 confidence is kept');
A.eq(TV.parse(j({ confidence: 70 }), SECRET).proposal.confidence, null, 'an out-of-range confidence is dropped');
for (const a of ['close', 'exit', 'flat']) {
  const r = TV.parse(j({ action: a, stop: undefined, price: undefined }), SECRET);
  A.eq([r.ok, r.kind, r.close.symbol], [true, 'close', 'XAUUSD'], a + ' is a close request (no stop or price needed)');
}
// ---- the alert is DATA: nothing in it can reach a setting ----
{
  const r = TV.parse(j({ policy: { riskPerTradePct: 5 }, lots: 50, riskPct: 5, halted: false, agentId: 'riskmanager', source: 'human', orderType: 'limit' }), SECRET);
  A.eq(Object.keys(r.proposal).sort(), ['agentId', 'confidence', 'entry', 'orderType', 'side', 'source', 'stop', 'strategy', 'symbol', 'takeProfit', 'thesis', 'timeframe'], 'only the known fields survive');
  A.eq([r.proposal.agentId, r.proposal.source, r.proposal.orderType], ['tradingview', 'tradingview', 'market'], 'an alert cannot claim to be a crew member, the Commander, or pick its own size');
  const dirty = TV.parse(j({ strategy: 'x\u0000\u001b[31m' + 'y'.repeat(200) }), SECRET).proposal.strategy;
  A.ok(dirty.length <= 60 && !/[\u0000-\u001f]/.test(dirty), 'free text is length-capped and stripped of control characters');
}
// ---- plain-text messages ----
{
  const r = TV.parse('BUY OANDA:XAUUSD price=2650 stop=2640 tp=2670 secret=' + SECRET + ' strategy="gold breakout" timeframe=15', SECRET);
  A.eq([r.ok, r.proposal.symbol, r.proposal.side, r.proposal.stop, r.proposal.takeProfit, r.proposal.strategy], [true, 'XAUUSD', 'buy', 2640, 2670, 'gold breakout'], 'the plain-text form works');
  A.eq(TV.parse('SELL EURUSD price=1.08 sl=1.085 secret=' + SECRET, SECRET).proposal.stop, 1.085, 'sl= is accepted for the stop');
  A.eq(TV.parse('CLOSE XAUUSD secret=' + SECRET, SECRET).kind, 'close', 'a plain-text close');
  A.eq(TV.parse('BUY XAUUSD price=2650 stop=2640', SECRET).status, 401, 'plain text without the secret is refused');
}
// ---- garbage ----
A.eq(TV.parse('', SECRET).status, 400, 'an empty body is refused');
A.eq(TV.parse('{"secret":', SECRET).status, 400, 'broken JSON is refused');
A.eq(TV.parse('x'.repeat(TV.MAX_BODY + 1), SECRET).status, 400, 'an oversized body is refused');
A.eq(TV.parse('[1,2,3]', SECRET).status, 401, 'a non-object body carries no secret');
// ---- the template the app shows ----
{
  const t = TV.template('YOUR-SECRET');
  A.ok(t.indexOf('{{ticker}}') > 0 && t.indexOf('{{strategy.order.action}}') > 0 && t.indexOf('{{close}}') > 0, 'the template uses TradingView placeholders');
  A.ok(/"stopPct":/.test(t), 'and it ships WITH a stop, so a pasted template obeys the stop-loss law');
  const filled = t.replace('{{ticker}}', 'XAUUSD').replace('{{exchange}}', 'OANDA').replace('{{strategy.order.action}}', 'buy').replace('{{close}}', '2650').replace('{{interval}}', '60').replace('{{timenow}}', '2026-11-11T15:00:00Z').replace('YOUR-SECRET', SECRET);
  A.eq(TV.parse(filled, SECRET).ok, true, 'a filled-in template is a valid alert');
}
A.report('trading.tradingview');
