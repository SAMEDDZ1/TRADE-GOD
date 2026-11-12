/* node test/trading.instruments.test.js — the instrument catalog and its money math. */
'use strict';
const A = require('./_assert.js');
const I = require('../sidecar/trading/instruments.js');

// every spelling a broker, TradingView or a person might use resolves to ONE canonical symbol
for (const [raw, want] of [['XAUUSD', 'XAUUSD'], ['xau_usd', 'XAUUSD'], ['XAU/USD', 'XAUUSD'], ['OANDA:XAUUSD', 'XAUUSD'], ['gold', 'XAUUSD'], ['OANDA:XAU_USD', 'XAUUSD'],
  ['silver', 'XAGUSD'], ['XAG_USD', 'XAGUSD'], [' eur-usd ', 'EURUSD'], ['FX:EURUSD', 'EURUSD'], ['EUR/USD', 'EURUSD'],
  ['BINANCE:BTCUSDT', 'BTCUSD'], ['btc/usdt', 'BTCUSD'], ['SPX500_USD', 'US500'], ['NASDAQ:AAPL', 'AAPL'], ['USOIL', 'WTIUSD'],
  ['', ''], ['NOPE', ''], [null, ''], ['OANDA:NOPE', '']]) {
  A.eq(I.normalize(raw), want, 'normalize(' + JSON.stringify(raw) + ')');
}
A.eq(I.get('nope'), null, 'get() of an unknown symbol is null');

// THE CONTRACT SIZES THAT MONEY DEPENDS ON
A.eq(I.get('XAUUSD').contractSize, 100, 'one gold lot is 100 oz');
A.eq(I.get('XAGUSD').contractSize, 5000, 'one silver lot is 5,000 oz');
A.eq(I.get('EURUSD').contractSize, 100000, 'one FX lot is 100,000 units');
A.eq(I.get('BTCUSD').contractSize, 1, 'one crypto lot is one coin');
A.eq(I.get('AAPL').contractSize, 1, 'one equity lot is one share');
A.eq(I.get('USDJPY').quote, 'JPY', 'USD/JPY is quoted in yen');
A.eq(I.get('USDCAD').quote, 'CAD', 'USD/CAD is quoted in Canadian dollars');

// catalog hygiene
const seen = new Set();
for (const i of I.LIST) {
  A.ok(!seen.has(i.symbol), 'symbol is unique: ' + i.symbol); seen.add(i.symbol);
  A.ok(I.CLASSES.indexOf(i.assetClass) >= 0, i.symbol + ' has a real asset class');
  A.ok(i.contractSize > 0 && i.tick > 0 && i.minLot > 0 && i.lotStep > 0, i.symbol + ' has positive sizes');
  A.ok(/^[A-Z]{3}$/.test(i.quote), i.symbol + ' has a 3-letter quote currency');
  A.ok(['24x5', '24x7', 'exchange'].indexOf(i.hours) >= 0, i.symbol + ' has known trading hours');
  A.eq(I.normalize(i.symbol), i.symbol, i.symbol + ' normalizes to itself');
  for (const a of i.aliases) A.eq(I.normalize(a), i.symbol, 'alias ' + a + ' -> ' + i.symbol);
  A.throws(() => { i.contractSize = 1; 'use strict'; if (i.contractSize !== 1) throw new Error('frozen'); }, i.symbol + ' is frozen');
}
for (const c of I.CLASSES) A.ok(I.list({ assetClass: c }).length >= 3, 'the ' + c + ' desk has instruments to trade');
A.ok(I.list({ assetClass: 'metals' }).some(i => i.symbol === 'XAUUSD') && I.list({ assetClass: 'metals' }).some(i => i.symbol === 'XAGUSD'), 'gold and silver are on the metals desk');

// P&L
const gold = I.get('XAUUSD'), silver = I.get('XAGUSD'), eur = I.get('EURUSD');
A.eq(I.pnl(gold, 'buy', 1, 2650, 2660), 1000, 'gold: 1 lot long, +$10 = +$1,000');
A.eq(I.pnl(gold, 'sell', 1, 2650, 2660), -1000, 'gold: 1 lot short, +$10 = -$1,000');
A.eq(I.pnl(silver, 'buy', 0.1, 31, 31.5), 250, 'silver: 0.1 lot long, +$0.50 = +$250');
A.eq(Number(I.pnl(eur, 'sell', 0.5, 1.0800, 1.0750).toFixed(6)), 250, 'EUR/USD: 0.5 lot short, -50 pips = +$250');
A.eq(I.notional(gold, 0.1, 2650), 26500, 'gold notional: 0.1 lot at 2650 = $26,500');
A.eq(I.notional(gold, -0.1, 2650), 26500, 'notional is unsigned');

// lots round DOWN to the step — never up
A.eq(I.roundLots(gold, 0.129), 0.12, 'gold 0.129 -> 0.12');
A.eq(I.roundLots(gold, 0.1), 0.1, 'gold 0.1 stays 0.1 (no float drift)');
A.eq(I.roundLots(gold, 0.3), 0.3, 'gold 0.3 stays 0.3 (no float drift)');
A.eq(I.roundLots(I.get('AAPL'), 3.9), 3, 'shares 3.9 -> 3');
A.eq(I.roundLots(I.get('BTCUSD'), 0.00015), 0.0001, 'BTC 0.00015 -> 0.0001');
A.eq(I.roundLots(gold, 0.004), 0, 'below one step -> 0');

// currency conversion
A.eq(I.toAccount(100, 'USD', 'USD', {}), 100, 'same currency needs no rate');
A.eq(I.toAccount(15000, 'JPY', 'USD', { USDJPY: 150 }), 100, 'JPY -> USD through USD/JPY');
A.eq(Number(I.toAccount(100, 'EUR', 'USD', { EURUSD: 1.08 }).toFixed(6)), 108, 'EUR -> USD through EUR/USD');
A.eq(Number(I.toAccount(100, 'GBP', 'CAD', { GBPUSD: 1.25, USDCAD: 1.4 }).toFixed(6)), 175, 'GBP -> CAD crossing through USD');
A.eq(I.toAccount(100, 'JPY', 'USD', {}), null, 'no rate -> null (never a guess)');
A.eq(I.toAccount(100, 'GBP', 'CAD', { GBPUSD: 1.25 }), null, 'half a cross -> null');

A.report('trading.instruments');
