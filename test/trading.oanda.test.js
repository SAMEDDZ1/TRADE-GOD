/* node test/trading.oanda.test.js — the OANDA connector against recorded-shape fixtures (never the real service). */
'use strict';
const A = require('./_assert.js');
const O = require('../sidecar/trading/oanda.js');

const TOKEN = 'tok-0123456789abcdef', ACCT = '101-001-1234567-001';
function fakeFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    for (const [re, reply] of routes) if (re.test(url)) {
      const r = typeof reply === 'function' ? reply(url, init) : reply;
      if (r instanceof Error) throw r;
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    }
    return { ok: false, status: 404, json: async () => ({ errorMessage: 'no route' }) };
  };
}
(async () => {
  // ---- construction is strict and safe ----
  A.throws(() => O.create({ fetch: () => {}, token: '', accountId: ACCT }), 'a token is required');
  A.throws(() => O.create({ fetch: () => {}, token: TOKEN, accountId: 'abc' }), 'a malformed account id is refused');
  A.throws(() => O.create({ fetch: () => {}, token: TOKEN, accountId: ACCT, env: 'live' }), 'LIVE is locked unless explicitly allowed');
  A.eq(O.create({ fetch: () => {}, token: TOKEN, accountId: ACCT }).host, 'https://api-fxpractice.oanda.com', 'the default host is the PRACTICE server');
  // ---- symbol mapping ----
  A.eq([O.toOanda('XAUUSD'), O.toOanda('gold'), O.toOanda('XAG/USD'), O.toOanda('US500'), O.toOanda('BTCUSD'), O.toOanda('AAPL')], ['XAU_USD', 'XAU_USD', 'XAG_USD', 'SPX500_USD', '', ''], 'gold, silver and indices map; crypto and stocks are not on OANDA');

  const calls = [];
  const c = O.create({ token: TOKEN, accountId: ACCT, fetch: fakeFetch([
    [/\/summary$/, { status: 200, body: { account: { id: ACCT, currency: 'CAD', balance: '100000.0000', NAV: '100250.5', unrealizedPL: '250.5', marginUsed: '1200', openTradeCount: 1 } } }],
    [/\/pricing\?/, { status: 200, body: { prices: [
      { instrument: 'XAU_USD', time: '1762873200.000000000', bids: [{ price: '2650.12' }], asks: [{ price: '2650.45' }], tradeable: true },
      { instrument: 'EUR_USD', time: '1762873200.000000000', bids: [{ price: '1.08001' }], asks: [{ price: '1.08009' }] },
      { instrument: 'XAG_USD', time: '1762873200.000000000', bids: [], asks: [] }] } }],
    [/\/candles\?/, { status: 200, body: { candles: [
      { time: '1762869600.000000000', volume: 812, complete: true, mid: { o: '2640.1', h: '2652.0', l: '2638.5', c: '2650.0' } },
      { time: '1762873200.000000000', volume: 90, complete: false, mid: { o: '2650.0', h: '2651.2', l: '2649.0', c: '2650.3' } }] } }],
    [/\/orders$/, (url, init) => ({ status: 201, body: { orderFillTransaction: { price: '2650.45', units: JSON.parse(init.body).order.units, time: '1762873201.5', tradeOpened: { tradeID: '6410' } } } })],
    [/\/openTrades$/, { status: 200, body: { trades: [{ id: '6410', instrument: 'XAU_USD', currentUnits: '-10', price: '2650.45', openTime: '1762873201.5', unrealizedPL: '-3.3', stopLossOrder: { price: '2660.000' } }] } }],
    [/\/trades\/6410\/close$/, { status: 200, body: { orderFillTransaction: { price: '2649.00', pl: '14.5', time: '1762873500' } } }]
  ], calls) });

  const s = await c.accountSummary();
  A.eq(s.account, { id: ACCT, currency: 'CAD', balance: 100000, equity: 100250.5, unrealized: 250.5, marginUsed: 1200, openTrades: 1, env: 'practice' }, 'the account summary is parsed into numbers');
  A.eq(calls[0].init.headers.Authorization, 'Bearer ' + TOKEN, 'the token travels in the Authorization header');
  A.ok(calls.every(x => x.url.indexOf(TOKEN) < 0), 'the token is never put in a URL');
  const p = await c.pricing(['XAUUSD', 'EURUSD', 'XAGUSD', 'BTCUSD']);
  A.eq(p.quotes, [{ symbol: 'XAUUSD', bid: 2650.12, ask: 2650.45, ts: 1762873200000, tradeable: true, simulated: false }, { symbol: 'EURUSD', bid: 1.08001, ask: 1.08009, ts: 1762873200000, tradeable: true, simulated: false }], 'real quotes are parsed and labelled NOT simulated; an empty book is skipped');
  A.ok(/instruments=XAU_USD%2CEUR_USD%2CXAG_USD$/.test(calls[1].url), 'only OANDA instruments are requested');
  const k = await c.candles('XAUUSD', 'H1', 2);
  A.eq(k.candles[0], { t: 1762869600000, o: 2640.1, h: 2652, l: 2638.5, c: 2650, v: 812, complete: true, simulated: false }, 'candles are parsed');
  A.eq((await c.candles('BTCUSD', 'H1', 2)).ok, false, 'a symbol OANDA does not carry is refused before any request');
  A.eq((await c.candles('XAUUSD', 'H7', 2)).ok, false, 'an unknown granularity is refused');
  // ---- orders ----
  A.ok(/no stop-loss/.test((await c.marketOrder({ symbol: 'XAUUSD', side: 'buy', lots: 0.1 })).error), 'no stop -> nothing is sent');
  const n = calls.length;
  const o = await c.marketOrder({ symbol: 'XAUUSD', side: 'sell', lots: 0.1, stop: 2660, takeProfit: 2630.123 });
  A.eq(o.fill, { tradeId: '6410', price: 2650.45, units: -10, ts: 1762873201500 }, 'the fill is parsed');
  const body = JSON.parse(calls[n].init.body).order;
  A.eq([body.type, body.instrument, body.units, body.timeInForce], ['MARKET', 'XAU_USD', '-10', 'FOK'], '0.1 lot of gold short = -10 units, fill-or-kill');
  A.eq(body.stopLossOnFill, { price: '2660.00', timeInForce: 'GTC' }, 'the STOP goes WITH the order, on OANDA\'s side');
  A.eq(body.takeProfitOnFill.price, '2630.12', 'prices are rounded to the instrument\'s tick');
  const t = await c.openTrades();
  A.eq([t.trades[0].side, t.trades[0].lots, t.trades[0].stop], ['sell', 0.1, 2660], 'open trades are mapped back to lots');
  A.eq((await c.closeTrade('6410')).close, { price: 2649, pnl: 14.5, ts: 1762873500000 }, 'closing a trade');
  A.eq((await c.closeTrade('../../x')).ok, false, 'a bad trade id never reaches a URL');
  // ---- errors are plain and never leak the token ----
  const bad = O.create({ token: TOKEN, accountId: ACCT, fetch: fakeFetch([[/summary/, { status: 401, body: { errorMessage: 'Insufficient authorization ' + TOKEN } }]], []) });
  const e = await bad.accountSummary();
  A.ok(!e.ok && /PRACTICE token/.test(e.error) && e.error.indexOf(TOKEN) < 0, '401 -> a plain message without the token');
  const down = O.create({ token: TOKEN, accountId: ACCT, fetch: fakeFetch([[/summary/, Object.assign(new Error('boom ' + TOKEN), { code: 'ECONNRESET' })]], []) });
  const d = await down.accountSummary();
  A.ok(!d.ok && /ECONNRESET/.test(d.error) && d.error.indexOf(TOKEN) < 0, 'a network failure -> a plain message without the token');
  A.report('trading.oanda');
})();
