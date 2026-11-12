/* sidecar/trading/tradingview.js — TradingView alert webhooks -> TRADE GOD proposals.

   A TradingView alert can POST its message to a URL. This module turns that message into a trade PROPOSAL.
   It never places an order: the proposal enters the same pipeline as an agent's idea (Trading Council ->
   Risk Manager -> approval -> Executor), so a mis-typed or malicious alert is stopped by the same gates.

   SECURITY
     • every alert must carry the shared secret the Commander set in TRADE GOD. It is compared in constant time
       and never echoed back, logged or journalled.
     • the alert body is DATA. Nothing in it can change a setting, a limit or an account — only the fields below
       are read, and everything else is dropped.
     • an alert with no stop-loss is rejected (the stop-loss law), unless it gives `stopPct` (a percent distance).

   ACCEPTED MESSAGE — JSON (recommended; paste into the alert's Message box):
     { "secret": "YOUR-SECRET", "symbol": "{{ticker}}", "exchange": "{{exchange}}", "action": "{{strategy.order.action}}",
       "price": {{close}}, "stop": 2640.5, "takeProfit": 2675, "strategy": "gold breakout", "timeframe": "{{interval}}",
       "time": "{{timenow}}" }
     action: buy | sell | long | short | close | exit | flat
     stop / takeProfit: prices. Or stopPct / takeProfitPct: percent distances from price (e.g. 0.5 = 0.5%).
   ACCEPTED MESSAGE — plain text:
     BUY XAUUSD price=2650 stop=2640 tp=2670 secret=YOUR-SECRET strategy=breakout

   Unit-tested in test/trading.tradingview.test.js. */
'use strict';
const crypto = require('node:crypto');
const I = require('./instruments.js');

const MAX_BODY = 4096;

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function numOrNull(v) { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; }
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }

function parseText(text) {
  const out = {};
  const m = /^\s*(buy|sell|long|short|close|exit|flat)\b\s+([A-Za-z0-9:_\/.\-]+)/i.exec(text);
  if (m) { out.action = m[1]; out.symbol = m[2]; }
  const re = /([A-Za-z]+)\s*=\s*("([^"]*)"|[^\s]+)/g;
  let k;
  while ((k = re.exec(text))) {
    const key = k[1].toLowerCase(), val = k[3] !== undefined ? k[3] : k[2];
    if (key === 'tp' || key === 'takeprofit' || key === 'target') out.takeProfit = val;
    else if (key === 'sl' || key === 'stop' || key === 'stoploss') out.stop = val;
    else if (key === 'stoppct') out.stopPct = val;
    else if (key === 'tppct' || key === 'takeprofitpct') out.takeProfitPct = val;
    else if (['secret', 'price', 'strategy', 'timeframe', 'time', 'symbol', 'action', 'exchange', 'confidence'].indexOf(key) >= 0) out[key] = val;
  }
  return out;
}

/* parse(rawBody, expectedSecret) -> { ok:true, kind:'entry'|'close', proposal|close, dedupeKey } | { ok:false, status, error }
   status is the HTTP status the route should answer with (401 bad secret, 400 bad alert). */
function parse(rawBody, expectedSecret) {
  const raw = typeof rawBody === 'string' ? rawBody : (rawBody && typeof rawBody === 'object' ? JSON.stringify(rawBody) : '');
  if (!expectedSecret || String(expectedSecret).length < 12) return { ok: false, status: 503, error: 'TradingView alerts are not set up yet: set a webhook secret (12+ characters) in TRADE GOD first.' };
  if (!raw || raw.length > MAX_BODY) return { ok: false, status: 400, error: 'empty or oversized alert' };
  let msg = null;
  const trimmed = raw.trim();
  if (trimmed[0] === '{') { try { msg = JSON.parse(trimmed); } catch (_) { return { ok: false, status: 400, error: 'the alert message is not valid JSON' }; } }
  else msg = parseText(trimmed);
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, status: 400, error: 'unreadable alert' };

  if (typeof msg.secret !== 'string' || !safeEqual(msg.secret, expectedSecret)) return { ok: false, status: 401, error: 'wrong or missing secret' };

  const rawSymbol = clean(msg.symbol || msg.ticker, 40);
  const withExchange = msg.exchange && rawSymbol.indexOf(':') < 0 ? clean(msg.exchange, 20) + ':' + rawSymbol : rawSymbol;
  const symbol = I.normalize(withExchange) || I.normalize(rawSymbol);
  if (!symbol) return { ok: false, status: 400, error: 'unknown symbol: ' + (rawSymbol || '(none)') };

  const action = clean(msg.action || msg.side, 12).toLowerCase();
  const strategy = clean(msg.strategy, 60), timeframe = clean(msg.timeframe || msg.interval, 12), time = clean(msg.time, 40);
  const dedupeKey = crypto.createHash('sha256').update([symbol, action, strategy, timeframe, time, String(msg.price)].join('|')).digest('hex').slice(0, 24);

  if (action === 'close' || action === 'exit' || action === 'flat') {
    return { ok: true, kind: 'close', close: { symbol, strategy, source: 'tradingview' }, dedupeKey };
  }
  const side = action === 'buy' || action === 'long' ? 'buy' : action === 'sell' || action === 'short' ? 'sell' : '';
  if (!side) return { ok: false, status: 400, error: 'action must be buy, sell or close' };

  const price = numOrNull(msg.price);
  if (!(price > 0)) return { ok: false, status: 400, error: 'the alert needs a price (use {{close}})' };
  let stop = numOrNull(msg.stop != null ? msg.stop : msg.sl), tp = numOrNull(msg.takeProfit != null ? msg.takeProfit : msg.tp);
  const stopPct = numOrNull(msg.stopPct), tpPct = numOrNull(msg.takeProfitPct);
  if (stop == null && stopPct > 0 && stopPct < 50) stop = side === 'buy' ? price * (1 - stopPct / 100) : price * (1 + stopPct / 100);
  if (tp == null && tpPct > 0 && tpPct < 500) tp = side === 'buy' ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
  if (!(stop > 0)) return { ok: false, status: 400, error: 'no stop-loss in the alert — no trade. Add "stop" (a price) or "stopPct" (a percent distance).' };
  if (side === 'buy' ? !(stop < price) : !(stop > price)) return { ok: false, status: 400, error: 'the stop is on the wrong side of the price for a ' + side };
  if (tp != null && !(tp > 0 && (side === 'buy' ? tp > price : tp < price))) return { ok: false, status: 400, error: 'the take-profit is on the wrong side of the price for a ' + side };
  const instrument = I.get(symbol);
  const digits = Math.max(0, Math.round(-Math.log10(instrument.tick)));
  const fix = n => n == null ? null : Number(Number(n).toFixed(digits));
  const conf = numOrNull(msg.confidence);
  return {
    ok: true, kind: 'entry', dedupeKey,
    proposal: {
      symbol, side, entry: fix(price), stop: fix(stop), takeProfit: fix(tp), orderType: 'market',
      source: 'tradingview', agentId: 'tradingview', strategy: strategy || 'TradingView alert', timeframe,
      confidence: conf != null && conf >= 0 && conf <= 1 ? conf : null,
      thesis: 'TradingView alert' + (strategy ? ' "' + strategy + '"' : '') + (timeframe ? ' on the ' + timeframe + ' chart' : '') + '.'
    }
  };
}

// the message template shown in the app, ready to paste into TradingView's alert dialog.
function template(secret) {
  return '{"secret":"' + String(secret || 'YOUR-SECRET') + '","symbol":"{{ticker}}","exchange":"{{exchange}}","action":"{{strategy.order.action}}","price":{{close}},"stopPct":0.5,"takeProfitPct":1,"strategy":"my strategy","timeframe":"{{interval}}","time":"{{timenow}}"}';
}

module.exports = { MAX_BODY, parse, parseText, template, safeEqual };
