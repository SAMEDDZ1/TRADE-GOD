/* node test/trading.http.test.js — the trading desk through the REAL sidecar: routes, auth gate, the typed
   confirmations, the TradingView webhook exemption, and a full paper trade end to end. */
'use strict';
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const fx = SidecarFixture.create({ prefix: 'tg-trading-http-' });
  await fx.start();
  const hold = setInterval(() => {}, 1000);
  try {
    // ---- the gate: no launch token, no trading desk ----
    const anon = await fetch(fx.baseUrl + '/api/trading/state', { headers: { Origin: fx.baseUrl } });
    A.eq(anon.status, 403, 'the trading desk is behind the station token');

    let st = await fx.json('GET', '/api/trading/state');
    A.eq(st.status, 200, 'GET /api/trading/state');
    A.eq([st.body.venue, st.body.feed.simulated, st.body.account.balance], ['paper', true, 10000], 'a fresh station: paper account, SIMULATED feed, $10,000');
    A.ok(st.body.quotes.XAUUSD && st.body.quotes.XAUUSD.simulated === true, 'gold is priced, and labelled simulated');
    A.ok(st.body.brokers.length === 11 && st.body.brokers.find(b => b.id === 'binance').state === 'locked', 'the broker list shows Binance locked for Canada');

    const inst = await fx.json('GET', '/api/trading/instruments');
    A.ok(inst.body.instruments.some(i => i.symbol === 'XAGUSD' && i.contractSize === 5000), 'instruments');
    const c = await fx.json('GET', '/api/trading/candles?symbol=gold&granularity=H1&count=50');
    A.eq([c.status, c.body.symbol, c.body.candles.length, c.body.simulated], [200, 'XAUUSD', 50, true], 'candles');
    A.eq((await fx.json('GET', '/api/trading/candles?symbol=nope')).status, 400, 'unknown symbol -> 400');

    // ---- a Commander ticket goes straight to a paper fill ----
    const g = st.body.quotes.XAUUSD;
    const p = await fx.json('POST', '/api/trading/propose', { symbol: 'XAUUSD', side: 'buy', stop: Number((g.bid - 15).toFixed(2)), takeProfit: Number((g.ask + 30).toFixed(2)) });
    A.eq([p.status, p.body.ticket.status], [200, 'executed'], 'the Commander\'s own ticket executes on paper: ' + (p.body.ticket && p.body.ticket.note));
    A.eq(p.body.ticket.source, 'human', 'a ticket from the app is the Commander\'s');
    const nostop = await fx.json('POST', '/api/trading/propose', { symbol: 'XAUUSD', side: 'buy' });
    A.eq(nostop.body.ticket.status, 'vetoed', 'no stop -> vetoed, even for the Commander');
    st = await fx.json('GET', '/api/trading/state');
    A.eq(st.body.positions.length, 1, 'one open paper position');

    // ---- an agent idea waits for the Council and the Commander ----
    const ag = await fx.json('POST', '/api/trading/propose', { source: 'agent', agentId: 'forex', symbol: 'EURUSD', side: 'sell', stop: Number((st.body.quotes.EURUSD.ask + 0.004).toFixed(5)), thesis: 'test' });
    A.eq(ag.body.ticket.status, 'awaiting-council', 'an agent idea waits for the Bull and Bear');
    await fx.json('POST', '/api/trading/argue', { ticketId: ag.body.ticket.id, role: 'bull', text: 'for' });
    const ar = await fx.json('POST', '/api/trading/argue', { ticketId: ag.body.ticket.id, role: 'bear', text: 'against' });
    A.eq(ar.body.ticket.status, 'awaiting-approval', 'then the Commander');
    const dec = await fx.json('POST', '/api/trading/decide', { ticketId: ag.body.ticket.id, approve: true });
    A.eq(dec.body.ticket.status, 'executed', 'approved -> executed');

    // ---- typed confirmations ----
    A.eq((await fx.json('POST', '/api/trading/policy', { patch: { riskPerTradePct: 2 } })).status, 409, 'loosening a limit without the typed confirmation is refused');
    A.eq((await fx.json('POST', '/api/trading/policy', { patch: { riskPerTradePct: 2 }, confirm: 'I ACCEPT MORE RISK' })).body.policy.riskPerTradePct, 2, 'with it, the Commander can loosen');
    A.eq((await fx.json('POST', '/api/trading/policy', { patch: { riskPerTradePct: 1 } })).body.policy.riskPerTradePct, 1, 'tightening needs no confirmation');
    A.eq((await fx.json('POST', '/api/trading/paper/reset', {})).status, 400, 'reset needs RESET typed');

    // ---- the kill switch ----
    const h = await fx.json('POST', '/api/trading/halt', { reason: 'drill' });
    A.eq([h.body.halted.on, h.body.result.closed], [true, 2], 'the kill switch flattens both positions');
    A.eq((await fx.json('POST', '/api/trading/resume', {})).status, 400, 'resuming needs RESUME typed');
    A.eq((await fx.json('POST', '/api/trading/resume', { confirm: 'RESUME' })).body.halted.on, false, 'resumed');

    // ---- scorecards, journal ----
    const sc = await fx.json('GET', '/api/trading/scorecards');
    A.ok(sc.body.overall.n >= 2, 'the closed trades are scored');
    const v = await fx.json('GET', '/api/trading/journal/verify');
    A.eq(v.body.chain.ok, true, 'the journal chain verifies');
    const j = await fx.json('GET', '/api/trading/journal?limit=5');
    A.eq(j.body.entries.length, 5, 'the journal reads newest first');

    // ---- backtest ----
    const bt = await fx.json('POST', '/api/trading/backtest', { symbol: 'XAUUSD', strategy: 'ema-cross', granularity: 'H1', count: 1500, walkForward: true, monteCarlo: true });
    A.eq(bt.status, 200, 'a backtest runs: ' + (bt.body.error || ''));
    A.ok(bt.body.simulated && /SIMULATED DATA/.test(bt.body.result.caveats[0]), 'a backtest on simulated candles says so first');
    A.ok(bt.body.walkForward && bt.body.walkForward.verdict, 'walk-forward verdict included');
    A.ok(bt.body.result.equityCurve.length <= 400, 'the curve is thinned for the response');
    const csv = 'time,open,high,low,close\n' + Array.from({ length: 300 }, (_, i) => (1762000000 + i * 3600) + ',' + (100 + Math.sin(i / 9) * 5).toFixed(2) + ',' + (101 + Math.sin(i / 9) * 5).toFixed(2) + ',' + (99 + Math.sin(i / 9) * 5).toFixed(2) + ',' + (100 + Math.sin((i + 1) / 9) * 5).toFixed(2)).join('\n');
    const btc = await fx.json('POST', '/api/trading/backtest', { symbol: 'XAGUSD', strategy: 'rsi-reversion', csv, params: { trend: 50 } });
    A.eq([btc.status, btc.body.simulated, btc.body.source], [200, false, 'csv'], 'a backtest on imported CSV candles is not labelled simulated: ' + (btc.body.error || ''));

    // ---- TradingView: off until a secret exists; then reachable WITHOUT the launch token, but only with the secret ----
    const off = await fetch(fx.baseUrl + '/api/trading/tv-webhook', { method: 'POST', body: '{"secret":"x"}' });
    A.eq(off.status, 503, 'with no secret set, the webhook is off');
    A.eq((await fx.json('POST', '/api/trading/settings', { patch: { tvSecret: 'my-trading-secret-1' } })).body.settings.tvSecretSet, true, 'the Commander sets a secret');
    const msg = { secret: 'my-trading-secret-1', symbol: 'OANDA:XAUUSD', action: 'buy', price: st.body.quotes.XAUUSD.ask, stopPct: 0.6, takeProfitPct: 1.2, strategy: 'tv test', time: 't1' };
    const tv = await fetch(fx.baseUrl + '/api/trading/tv-webhook', { method: 'POST', headers: { Host: 'abc123.trycloudflare.com', 'Content-Type': 'text/plain' }, body: JSON.stringify(msg) });
    const tvb = await tv.json();
    A.eq([tv.status, tvb.kind, tvb.status], [200, 'entry', 'awaiting-approval'], 'an alert through a tunnel (public Host, no token) becomes a ticket waiting for approval: ' + JSON.stringify(tvb).slice(0, 200));
    A.ok(JSON.stringify(tvb).indexOf('my-trading-secret-1') < 0 && !tvb.positions && !tvb.account, 'the webhook answer leaks no secret and no account state');
    const wrong = await fetch(fx.baseUrl + '/api/trading/tv-webhook', { method: 'POST', headers: { Host: 'abc123.trycloudflare.com' }, body: JSON.stringify(Object.assign({}, msg, { secret: 'not-the-right-secret', time: 't2' })) });
    A.eq(wrong.status, 401, 'a wrong secret is refused');
    const other = await fetch(fx.baseUrl + '/api/trading/state', { headers: { Host: 'abc123.trycloudflare.com' } });
    A.eq(other.status, 403, 'the tunnel exemption covers ONLY the webhook — every other route still refuses a public Host');
    const st2 = await fx.json('GET', '/api/trading/state');
    A.ok(st2.body.settings.tvSecret === undefined && JSON.stringify(st2.body).indexOf('my-trading-secret-1') < 0, 'the secret never comes back out of the state route');

    // ---- OANDA: live is locked; Alberta is locked ----
    A.eq((await fx.json('POST', '/api/trading/broker/oanda/connect', { token: 'x', accountId: '101-001-1234567-001', env: 'live' })).status, 403, 'connecting a LIVE account is refused');
    await fx.json('POST', '/api/trading/settings', { patch: { region: 'AB' } });
    const ab = await fx.json('POST', '/api/trading/broker/oanda/connect', { token: 'x', accountId: '101-001-1234567-001' });
    A.ok(ab.status === 403 && /Alberta/.test(ab.body.error), 'Alberta cannot connect OANDA');
    A.eq((await fx.json('POST', '/api/trading/settings', { patch: { autonomy: 'yolo' } })).status, 400, 'bad settings are refused');
  } finally { clearInterval(hold); await fx.stop(); }
  A.report('trading.http');
})().catch(e => { console.log('FAIL: trading.http threw — ' + (e && e.stack || e)); process.exit(1); });
