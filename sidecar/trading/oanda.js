/* sidecar/trading/oanda.js — the OANDA v20 REST connector (PRACTICE accounts only in this version).

   STATUS: UNTESTED AGAINST THE LIVE SERVICE. This connector is written from OANDA's published v20 REST
   documentation and its unit tests run against recorded-shape fixtures (test/trading.oanda.test.js); it has
   never been run against api-fxpractice.oanda.com from this codebase. Treat the first real connection as a
   test, on a PRACTICE account, and report anything that does not match.

   SAFETY CHOICES BAKED IN
     • env is 'practice' unless the caller passes BOTH env:'live' AND allowLive:true. Nothing in TRADE GOD v0.1
       passes allowLive — live trading is locked until paper results justify unlocking it.
     • marketOrder() refuses to send an order without a stop-loss, and sends the stop WITH the order
       (stopLossOnFill), so the stop lives on OANDA's side from the first millisecond: if this app crashes or the
       internet drops, the position is still protected.
     • the token is only ever sent to the two OANDA hosts below, in the Authorization header. It is never logged,
       never put in a URL, and never included in an error message.

   Units: OANDA sizes orders in UNITS of the instrument (1 unit of XAU_USD = 1 oz, 1 unit of EUR_USD = 1 EUR).
   TRADE GOD sizes in LOTS, so units = lots x contractSize (instruments.js). */
'use strict';
const I = require('./instruments.js');

const HOSTS = Object.freeze({ practice: 'https://api-fxpractice.oanda.com', live: 'https://api-fxtrade.oanda.com' });

// canonical symbol -> OANDA instrument name. Only instruments OANDA offers are listed; anything else is "not on OANDA".
const OANDA_NAME = Object.freeze({
  XAUUSD: 'XAU_USD', XAGUSD: 'XAG_USD', XPTUSD: 'XPT_USD', XCUUSD: 'XCU_USD',
  EURUSD: 'EUR_USD', GBPUSD: 'GBP_USD', USDJPY: 'USD_JPY', USDCHF: 'USD_CHF', AUDUSD: 'AUD_USD', USDCAD: 'USD_CAD', NZDUSD: 'NZD_USD',
  EURGBP: 'EUR_GBP', EURJPY: 'EUR_JPY', GBPJPY: 'GBP_JPY', CADJPY: 'CAD_JPY',
  US500: 'SPX500_USD', NAS100: 'NAS100_USD', US30: 'US30_USD', GER40: 'DE30_EUR', UK100: 'UK100_GBP', JP225: 'JP225_USD',
  WTIUSD: 'WTICO_USD', BRENTUSD: 'BCO_USD', NATGASUSD: 'NATGAS_USD'
});
const FROM_OANDA = Object.freeze(Object.keys(OANDA_NAME).reduce((m, k) => { m[OANDA_NAME[k]] = k; return m; }, {}));
const GRANULARITIES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D', 'W'];

function toOanda(symbol) { const s = I.normalize(symbol); return (s && OANDA_NAME[s]) || ''; }
function digits(instrument) { return Math.max(0, Math.round(-Math.log10(instrument.tick))); }
function ts(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1000) : Date.parse(v); }   // UNIX seconds (our header) or RFC3339

function create(opts) {
  const o = opts || {};
  const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) throw new Error('oanda: no fetch available');
  const token = String(o.token || ''), accountId = String(o.accountId || '');
  if (!token || !accountId) throw new Error('oanda: a token and an account id are required');
  if (!/^[0-9]{3}-[0-9]{3}-[0-9]+-[0-9]{3}$/.test(accountId)) throw new Error('oanda: the account id should look like 101-001-1234567-001');
  const env = o.env === 'live' && o.allowLive === true ? 'live' : 'practice';
  if (o.env === 'live' && env !== 'live') throw new Error('oanda: live trading is locked in this version — use a practice account');
  const host = HOSTS[env];

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchFn(host + path, {
        method, headers: Object.assign({ Authorization: 'Bearer ' + token, 'Accept-Datetime-Format': 'UNIX' }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) { return { ok: false, status: 0, error: 'could not reach OANDA (' + String((e && e.code) || (e && e.name) || 'network error') + ')' }; }
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    if (!res.ok) {
      const msg = (json && (json.errorMessage || json.message)) || ('HTTP ' + res.status);
      return { ok: false, status: res.status, error: res.status === 401 ? 'OANDA rejected the token (401). Check it is a PRACTICE token for this account.' : 'OANDA: ' + String(msg).slice(0, 200) };
    }
    return { ok: true, status: res.status, json: json || {} };
  }
  const acct = '/v3/accounts/' + encodeURIComponent(accountId);

  async function accountSummary() {
    const r = await call('GET', acct + '/summary');
    if (!r.ok) return r;
    const a = r.json.account || {};
    return { ok: true, account: { id: a.id, currency: a.currency, balance: Number(a.balance), equity: Number(a.NAV), unrealized: Number(a.unrealizedPL), marginUsed: Number(a.marginUsed), openTrades: Number(a.openTradeCount) || 0, env } };
  }
  async function pricing(symbols) {
    const names = (symbols || []).map(toOanda).filter(Boolean);
    if (!names.length) return { ok: true, quotes: [] };
    const r = await call('GET', acct + '/pricing?instruments=' + encodeURIComponent(names.join(',')));
    if (!r.ok) return r;
    const quotes = [];
    for (const p of (r.json.prices || [])) {
      const symbol = FROM_OANDA[p.instrument];
      const bid = Number(p.bids && p.bids[0] && p.bids[0].price), ask = Number(p.asks && p.asks[0] && p.asks[0].price);
      if (symbol && bid > 0 && ask > 0) quotes.push({ symbol, bid, ask, ts: ts(p.time), tradeable: p.tradeable !== false, simulated: false });
    }
    return { ok: true, quotes };
  }
  async function candles(symbol, granularity, count) {
    const name = toOanda(symbol);
    if (!name) return { ok: false, status: 400, error: 'not available on OANDA: ' + symbol };
    if (GRANULARITIES.indexOf(granularity) < 0) return { ok: false, status: 400, error: 'unknown granularity: ' + granularity };
    const n = Math.min(5000, Math.max(1, Math.floor(Number(count) || 500)));
    const r = await call('GET', '/v3/instruments/' + name + '/candles?price=M&granularity=' + granularity + '&count=' + n);
    if (!r.ok) return r;
    const out = [];
    for (const c of (r.json.candles || [])) {
      if (!c.mid) continue;
      out.push({ t: ts(c.time), o: Number(c.mid.o), h: Number(c.mid.h), l: Number(c.mid.l), c: Number(c.mid.c), v: Number(c.volume) || 0, complete: c.complete !== false, simulated: false });
    }
    return { ok: true, candles: out };
  }
  /* order: { symbol, side, lots, stop, takeProfit? }. Fill-or-kill market order with the stop attached on OANDA's side. */
  async function marketOrder(order) {
    const instrument = I.get(order && order.symbol), name = toOanda(order && order.symbol);
    if (!instrument || !name) return { ok: false, status: 400, error: 'not available on OANDA: ' + String(order && order.symbol) };
    if (!(Number(order.stop) > 0)) return { ok: false, status: 400, error: 'no stop-loss — no trade' };
    const lots = Number(order.lots);
    if (!(lots > 0)) return { ok: false, status: 400, error: 'size must be greater than zero' };
    const units = Math.round(lots * instrument.contractSize * 1000) / 1000;
    const d = digits(instrument);
    const body = { order: {
      type: 'MARKET', instrument: name, units: String(order.side === 'sell' ? -units : units), timeInForce: 'FOK', positionFill: 'DEFAULT',
      stopLossOnFill: { price: Number(order.stop).toFixed(d), timeInForce: 'GTC' }
    } };
    if (order.takeProfit != null) body.order.takeProfitOnFill = { price: Number(order.takeProfit).toFixed(d), timeInForce: 'GTC' };
    const r = await call('POST', acct + '/orders', body);
    if (!r.ok) return r;
    const fill = r.json.orderFillTransaction, cancel = r.json.orderCancelTransaction;
    if (!fill) return { ok: false, status: 409, error: 'OANDA did not fill the order' + (cancel && cancel.reason ? ' (' + cancel.reason + ')' : '') };
    return { ok: true, fill: { tradeId: (fill.tradeOpened && fill.tradeOpened.tradeID) || '', price: Number(fill.price), units: Number(fill.units), ts: ts(fill.time) } };
  }
  async function openTrades() {
    const r = await call('GET', acct + '/openTrades');
    if (!r.ok) return r;
    const trades = [];
    for (const t of (r.json.trades || [])) {
      const symbol = FROM_OANDA[t.instrument], instrument = symbol && I.get(symbol);
      if (!instrument) continue;
      const units = Number(t.currentUnits);
      trades.push({ id: String(t.id), symbol, side: units < 0 ? 'sell' : 'buy', lots: Math.abs(units) / instrument.contractSize, entry: Number(t.price),
        stop: t.stopLossOrder ? Number(t.stopLossOrder.price) : null, takeProfit: t.takeProfitOrder ? Number(t.takeProfitOrder.price) : null,
        unrealized: Number(t.unrealizedPL), openedAt: ts(t.openTime) });
    }
    return { ok: true, trades };
  }
  async function closeTrade(tradeId) {
    if (!/^[0-9]+$/.test(String(tradeId))) return { ok: false, status: 400, error: 'bad trade id' };
    const r = await call('PUT', acct + '/trades/' + tradeId + '/close', { units: 'ALL' });
    if (!r.ok) return r;
    const fill = r.json.orderFillTransaction || {};
    return { ok: true, close: { price: Number(fill.price), pnl: Number(fill.pl), ts: ts(fill.time) } };
  }
  return { env, host, accountSummary, pricing, candles, marketOrder, openTrades, closeTrade };
}

module.exports = { HOSTS, OANDA_NAME, GRANULARITIES, toOanda, create };
