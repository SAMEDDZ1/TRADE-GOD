/* node test/trading.brokers.test.js — the broker list and the jurisdiction gate. */
'use strict';
const A = require('./_assert.js');
const B = require('../sidecar/trading/brokers.js');

A.eq(B.LIST.map(b => b.id), ['paper', 'oanda', 'ibkr', 'alpaca', 'tastytrade', 'pepperstone', 'icmarkets', 'binance', 'bybit', 'coinbase', 'kraken'], 'the paper account plus the ten brokers');
A.eq(B.LIST.filter(b => !b.paper).length, 10, 'ten real brokers');
for (const b of B.LIST) {
  A.ok(['ready', 'untested-live', 'planned'].indexOf(b.status) >= 0, b.id + ' has an honest status: ' + b.status);
  A.ok(b.assetClasses.length > 0 && b.notes.length > 10, b.id + ' says what it trades');
  A.ok(['paper', 'rest', 'ccxt', 'ctrader'].indexOf(b.kind) >= 0, b.id + ' has a known connection kind');
}
// HONESTY: 'ready' may only be claimed by a connector that is fully built and tested — today that is the paper account alone
A.eq(B.LIST.filter(b => b.status === 'ready').map(b => b.id), ['paper'], 'only the paper account is marked ready');
A.eq(B.LIST.filter(b => b.status === 'untested-live').map(b => b.id), ['oanda'], 'OANDA is written but untested against the live service, and says so');

// ---- Canada ----
const ca = id => B.allowedFor(id, 'CA', 'ON');
for (const id of ['oanda', 'ibkr', 'coinbase', 'kraken', 'alpaca', 'tastytrade']) A.eq(ca(id).allowed, true, id + ' is not locked for an Ontario resident');
for (const id of ['pepperstone', 'icmarkets', 'binance', 'bybit']) {
  A.eq(ca(id).allowed, false, id + ' is LOCKED for Canada');
  A.ok(ca(id).reason.length > 20, id + ' says why in plain words');
}
A.eq(B.allowedFor('oanda', 'CA', 'AB').allowed, false, 'OANDA is locked for Alberta');
A.ok(/Alberta/.test(B.allowedFor('oanda', 'CA', 'AB').reason), 'and names Alberta as the reason');
A.eq(B.allowedFor('oanda', 'ca', 'ab').allowed, false, 'country and region are case-insensitive');
A.eq(B.allowedFor('oanda', 'CA', '').allowed, true, 'with no province given, the province rule cannot fire (the app asks for it before connecting)');
// ---- United States ----
for (const id of ['pepperstone', 'icmarkets', 'binance', 'bybit']) A.eq(B.allowedFor(id, 'US').allowed, false, id + ' is locked for the US');
// ---- no country yet: only the paper account, never a real broker by default ----
A.eq(B.allowedFor('paper', '', '').allowed, true, 'the paper account is always available');
A.eq(B.allowedFor('oanda', '', '').allowed, false, 'no real broker is offered before the app knows where the Commander lives');
A.eq(B.allowedFor('nope', 'CA').allowed, false, 'an unknown broker is never allowed');
A.eq(B.get('nope'), null, 'get() of an unknown broker is null');

// ---- the catalog the UI shows ----
{
  const cat = B.catalog('CA', 'ON'), by = id => cat.find(b => b.id === id);
  A.eq(cat.length, 11, 'every broker is listed, usable or not');
  A.eq([by('paper').state, by('paper').usable], ['ready', true], 'paper: ready');
  A.eq([by('oanda').state, by('oanda').usable], ['experimental', true], 'OANDA: experimental (built, untested live)');
  A.eq([by('ibkr').state, by('ibkr').usable], ['coming', false], 'IBKR: allowed but not built yet -> coming, not usable');
  A.eq([by('binance').state, by('binance').usable], ['locked', false], 'Binance: locked');
  A.ok(by('binance').blockedReason.length > 0, 'a locked broker carries its reason');
  A.eq(B.catalog('', '').filter(b => b.usable).map(b => b.id), ['paper'], 'with no country, only paper is usable');
  A.eq(B.catalog('CA', 'AB').find(b => b.id === 'oanda').state, 'locked', 'Alberta sees OANDA locked');
}
A.ok(B.PROVINCES.indexOf('ON') >= 0 && B.PROVINCES.indexOf('AB') >= 0 && B.PROVINCES.length === 13, 'all 13 provinces and territories');
A.report('trading.brokers');
