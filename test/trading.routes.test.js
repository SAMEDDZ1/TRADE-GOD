/* node test/trading.routes.test.js — the /api/trading/* handlers, driven directly with fake req/res (no npm deps),
   plus source-level locks on how index.js mounts them. test/trading.http.test.js drives the same routes through
   the real booted sidecar (needs `npm ci`). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), path = require('path'), os = require('os');
const { makeTradingRoutes } = require('../sidecar/trading/routes.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-routes-'));
let clock = Date.UTC(2026, 10, 11, 15, 0, 0);
function respondJson(res, code, obj) { res.statusCode = code; res.body = obj; }
const readBody = async (req, max) => { const s = req.rawBody == null ? '' : req.rawBody; if (s.length > max) throw Object.assign(new Error('body too large'), { tooLarge: true }); return s; };
const fetchCalls = [];
const fakeFetch = async (url, init) => {
  fetchCalls.push({ url, init });
  if (/summary$/.test(url)) return { ok: true, status: 200, json: async () => ({ account: { id: '101-001-1234567-001', currency: 'CAD', balance: '5000', NAV: '5000', unrealizedPL: '0', marginUsed: '0', openTradeCount: 0 } }) };
  if (/pricing/.test(url)) return { ok: true, status: 200, json: async () => ({ prices: [{ instrument: 'XAU_USD', time: String(clock / 1000), bids: [{ price: '2701.00' }], asks: [{ price: '2701.40' }] }] }) };
  return { ok: false, status: 500, json: async () => ({}) };
};
const desk = makeTradingRoutes({ fs, path, dir, readBody, respondJson, now: () => clock, noDriver: true, fetch: fakeFetch, log: () => {} });
const route = (m, url) => desk.routes.find(r => r.m === m && (r.exact === url.split('?')[0] || r.qsplit === url.split('?')[0]));
async function call(m, url, body) {
  const r = route(m, url);
  if (!r) return { statusCode: 404, body: null };
  const req = { method: m, url, rawBody: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body) }, res = {};
  await r.h(req, res);
  return res;
}

(async () => {
  try {
    // ---- the route table ----
    const names = desk.routes.map(r => r.m + ' ' + (r.exact || r.qsplit));
    for (const n of ['GET /api/trading/state', 'GET /api/trading/candles', 'POST /api/trading/propose', 'POST /api/trading/argue', 'POST /api/trading/decide', 'POST /api/trading/halt',
      'POST /api/trading/resume', 'POST /api/trading/policy', 'POST /api/trading/settings', 'POST /api/trading/backtest', 'POST /api/trading/tv-webhook', 'POST /api/trading/coach',
      'GET /api/trading/scorecards', 'GET /api/trading/journal', 'GET /api/trading/journal/verify', 'POST /api/trading/broker/oanda/connect']) A.ok(names.indexOf(n) >= 0, 'route exists: ' + n);
    A.ok(desk.routes.every(r => /^\/api\/trading\//.test(r.exact || r.qsplit)), 'every route lives under /api/trading/');

    let st = await call('GET', '/api/trading/state');
    A.eq([st.statusCode, st.body.venue, st.body.feed.simulated, st.body.feed.kind], [200, 'paper', true, 'sim'], 'state: paper, simulated feed');
    A.ok(/SIMULATED/.test(st.body.feed.label), 'the feed says SIMULATED in words');
    A.ok(st.body.quotes.XAUUSD && st.body.quotes.USDJPY, 'the watchlist is priced (and the FX pairs needed for conversion)');

    const c = await call('GET', '/api/trading/candles?symbol=silver&granularity=M15&count=20');
    A.eq([c.statusCode, c.body.symbol, c.body.candles.length], [200, 'XAGUSD', 20], 'candles');
    A.eq((await call('GET', '/api/trading/candles?symbol=XAUUSD&granularity=Y2')).statusCode, 400, 'bad granularity');

    // ---- body hygiene ----
    A.eq((await call('POST', '/api/trading/propose', '{not json')).statusCode, 400, 'broken JSON -> 400');
    A.eq((await call('POST', '/api/trading/propose', '[1]')).statusCode, 400, 'a non-object body -> 400');
    A.eq((await call('POST', '/api/trading/propose', 'x'.repeat(70000))).statusCode, 413, 'an oversized body -> 413');

    // ---- pipeline over HTTP ----
    const g = st.body.quotes.XAUUSD;
    let p = await call('POST', '/api/trading/propose', { symbol: 'XAUUSD', side: 'buy', stop: Number((g.bid - 12).toFixed(2)), takeProfit: Number((g.ask + 24).toFixed(2)) });
    A.eq([p.statusCode, p.body.ticket.status, p.body.ticket.source], [200, 'executed', 'human'], 'a Commander ticket fills on paper');
    p = await call('POST', '/api/trading/propose', { source: 'agent', symbol: 'XAUUSD', side: 'buy', stop: 1 });
    A.eq(p.body.ticket.source, 'human', 'claiming to be an agent without naming one does not work — it is the Commander\'s ticket');
    const ag = await call('POST', '/api/trading/propose', { source: 'agent', agentId: 'metals', symbol: 'XAGUSD', side: 'buy', stop: Number((st.body.quotes.XAGUSD.bid * 0.99).toFixed(3)) });
    A.eq(ag.body.ticket.status, 'awaiting-council', 'an agent ticket waits for the Council');
    A.eq((await call('POST', '/api/trading/decide', { ticketId: ag.body.ticket.id, approve: true })).statusCode, 409, 'it cannot be approved before the Council has spoken');
    await call('POST', '/api/trading/argue', { ticketId: ag.body.ticket.id, role: 'bull', text: 'for' });
    await call('POST', '/api/trading/argue', { ticketId: ag.body.ticket.id, role: 'bear', text: 'against' });
    A.eq((await call('POST', '/api/trading/decide', { ticketId: ag.body.ticket.id, approve: 'yes' })).body.ticket.status, 'rejected', 'only a literal true approves');

    // ---- confirmations ----
    const loosen = await call('POST', '/api/trading/policy', { patch: { maxLeverage: 20 } });
    A.eq([loosen.statusCode, loosen.body.needsConfirm], [409, true], 'loosening without the typed phrase is refused and says a confirmation is needed');
    A.eq((await call('POST', '/api/trading/policy', { patch: { maxLeverage: 20 }, confirm: 'i accept more risk' })).statusCode, 409, 'the phrase is exact');
    A.eq((await call('POST', '/api/trading/policy', { patch: { maxLeverage: 20 }, confirm: 'I ACCEPT MORE RISK' })).body.policy.maxLeverage, 20, 'the exact phrase works');
    A.eq((await call('POST', '/api/trading/policy', { patch: { maxLeverage: 10 } })).body.policy.maxLeverage, 10, 'tightening back needs nothing');
    A.eq((await call('POST', '/api/trading/paper/reset', { confirm: 'reset' })).statusCode, 400, 'RESET is exact');
    A.eq((await call('POST', '/api/trading/halt', {})).body.halted.on, true, 'the kill switch needs no confirmation — stopping is always one click');
    A.eq((await call('POST', '/api/trading/resume', { confirm: 'resume' })).statusCode, 400, 'RESUME is exact');
    A.eq((await call('POST', '/api/trading/resume', { confirm: 'RESUME' })).body.halted.on, false, 'resume');
    const reset = await call('POST', '/api/trading/paper/reset', { confirm: 'RESET', startingBalance: 50000 });
    A.eq(reset.body.account.balance, 50000, 'reset to a new balance');

    // ---- backtest ----
    const bt = await call('POST', '/api/trading/backtest', { symbol: 'XAUUSD', strategy: 'donchian-breakout', granularity: 'H1', count: 800, monteCarlo: true });
    A.eq(bt.statusCode, 200, 'backtest: ' + (bt.body && bt.body.error));
    A.ok(bt.body.simulated && /SIMULATED DATA/.test(bt.body.result.caveats[0]), 'simulated data is called out first');
    A.eq((await call('POST', '/api/trading/backtest', { symbol: 'XAUUSD', strategy: 'nope' })).statusCode, 400, 'unknown strategy');
    A.eq((await call('POST', '/api/trading/backtest', { symbol: 'XAUUSD', strategy: 'ema-cross', csv: 'a,b\n1,2' })).statusCode, 400, 'a bad CSV is refused with the reason');

    // ---- the Strategy Breeder ----
    const br = await call('POST', '/api/trading/breed', { symbol: 'XAUUSD', strategy: 'ema-cross', granularity: 'H1', count: 2500, trials: 12 });
    A.eq([br.statusCode, br.body.breed.tried, br.body.simulated], [200, 12, true], 'the breeder runs over HTTP');
    A.ok(/SIMULATED DATA/.test(br.body.breed.caveats[0]), 'and says first that it searched invented prices');
    const shortCsv = 'time,open,high,low,close\n' + Array.from({ length: 200 }, (_, i) => (1762000000 + i * 3600) + ',100,101,99,100.5').join('\n');
    const tooShort = await call('POST', '/api/trading/breed', { symbol: 'XAUUSD', strategy: 'ema-cross', csv: shortCsv });
    A.ok(tooShort.statusCode === 400 && /not enough history/.test(tooShort.body.error), 'too little history is refused with the reason');

    // ---- TradingView ----
    A.eq((await call('POST', '/api/trading/tv-webhook', '{"secret":"x"}')).statusCode, 503, 'off until configured');
    await call('POST', '/api/trading/settings', { patch: { tvSecret: 'tv-secret-0123456789' } });
    const tv = await call('POST', '/api/trading/tv-webhook', JSON.stringify({ secret: 'tv-secret-0123456789', symbol: 'XAUUSD', action: 'sell', price: 2700, stopPct: 0.5, time: 'a' }));
    A.eq([tv.statusCode, tv.body.kind, tv.body.status], [200, 'entry', 'awaiting-approval'], 'an alert becomes a ticket awaiting approval');
    A.eq(Object.keys(tv.body).sort(), ['kind', 'note', 'ok', 'status', 'ticketId'], 'the webhook answers with the ticket outcome and nothing else');
    A.eq((await call('POST', '/api/trading/tv-webhook', JSON.stringify({ secret: 'tv-secret-0123456789', symbol: 'XAUUSD', action: 'sell', price: 2700, stopPct: 0.5, time: 'a' }))).body.duplicate, true, 'a repeated alert is ignored');
    A.eq((await call('POST', '/api/trading/tv-webhook', JSON.stringify({ secret: 'nope-nope-nope-nope', symbol: 'XAUUSD', action: 'sell', price: 2700, stopPct: 0.5 }))).statusCode, 401, 'wrong secret');
    const tmpl = await call('GET', '/api/trading/tv-template');
    A.ok(tmpl.body.template.indexOf('tv-secret-0123456789') < 0, 'the template never prints the real secret');

    // ---- OANDA (fake fetch: never the real service) ----
    A.eq((await call('POST', '/api/trading/broker/oanda/connect', { token: 't', accountId: '101-001-1234567-001', env: 'live' })).statusCode, 403, 'LIVE refused');
    const bad = await call('POST', '/api/trading/broker/oanda/connect', { token: 't', accountId: 'nope' });
    A.eq(bad.statusCode, 400, 'a malformed account id is refused');
    const ok = await call('POST', '/api/trading/broker/oanda/connect', { token: 'secret-token-xyz', accountId: '101-001-1234567-001' });
    A.eq([ok.statusCode, ok.body.oanda.env, ok.body.feed.kind, ok.body.feed.simulated], [200, 'practice', 'oanda', false], 'a practice account connects and becomes the price feed');
    A.ok(/paper account/.test(ok.body.note), 'and says plainly that orders still go to the paper account');
    st = await call('GET', '/api/trading/state');
    A.eq([st.body.quotes.XAUUSD.bid, st.body.quotes.XAUUSD.simulated], [2701, false], 'real prices flow in, labelled real');
    A.ok(JSON.stringify(st.body).indexOf('secret-token-xyz') < 0, 'the OANDA token never appears in the state');
    A.ok(!fs.readdirSync(dir).some(f => fs.readFileSync(path.join(dir, f), 'utf8').indexOf('secret-token-xyz') >= 0), 'and is never written to disk');
    const dis = await call('POST', '/api/trading/broker/oanda/disconnect', {});
    A.eq(dis.body.feed.kind, 'sim', 'disconnect returns to the simulated feed');
    await call('POST', '/api/trading/settings', { patch: { region: 'AB' } });
    A.eq((await call('POST', '/api/trading/broker/oanda/connect', { token: 't', accountId: '101-001-1234567-001' })).statusCode, 403, 'Alberta: locked');

    // ---- how index.js mounts it (source locks) ----
    const idx = require('./helpers/source.js').readSidecarSource();
    A.ok(/\.\.\.tradingDesk\.routes,/.test(idx), 'index.js mounts the trading routes in ROUTES (behind the token gate)');
    A.ok(/dir: path\.join\(WORKSPACES, 'trading'\)/.test(idx), 'trading state lives under the workspace');
    A.ok(/writeFile: \(file, data\) => writeFileDurable\(/.test(idx), 'and is written through the durable writer');
    A.ok(/const tvHook = req\.method === 'POST' && String\(req\.url \|\| ''\)\.split\('\?'\)\[0\] === TRADING_TV_HOOK;/.test(idx), 'the public-Host exemption is ONLY the exact webhook path, POST only');
    A.ok(/if \(tvHook\) return tradingTvHookRoute\.h\(req, res\);/.test(idx), 'and is dispatched straight to the webhook handler');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  A.report('trading.routes');
})().catch(e => { console.log('FAIL: trading.routes threw — ' + (e && e.stack || e)); process.exit(1); });
