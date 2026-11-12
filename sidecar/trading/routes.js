/* sidecar/trading/routes.js — the TRADE GOD HTTP route group: /api/trading/*

   All of these sit behind the station's central /api auth gate like every other route (index.js ROUTES), so
   nothing here is reachable without the station token. On top of that:
     • loosening the risk policy, resetting the paper account and resuming after a kill switch each need an
       explicit typed confirmation in the request body — a slip of the mouse cannot do them, and an agent would
       have to forge a human confirmation to try;
     • the TradingView webhook additionally needs the Commander's own webhook secret;
     • a broker token is held in memory for this run only and is never written to disk, logged or returned.

   This file also owns the PRICE DRIVER: a timer that feeds quotes into the desk every couple of seconds — from the
   OANDA practice connector when one is connected and selected, otherwise from the built-in SIMULATED feed. Every
   response that carries prices says which (`feed.simulated`), and the UI shows it.

   Routes
     GET  /api/trading/state            account, positions, orders, tickets, policy, settings, brokers, quotes, feed
     GET  /api/trading/instruments      the instrument catalog
     GET  /api/trading/candles          ?symbol=&granularity=&count=
     GET  /api/trading/scorecards       overall + per crew member (with Coach status) + by symbol + by strategy
     GET  /api/trading/journal          ?limit=&type=      GET /api/trading/journal/verify
     GET  /api/trading/strategies       the built-in strategy templates and their parameters
     POST /api/trading/propose          a trade idea (from the Commander's ticket, or a crew member)
     POST /api/trading/argue            a Bull / Bear argument on a ticket
     POST /api/trading/decide           approve / reject a ticket
     POST /api/trading/halt             THE KILL SWITCH        POST /api/trading/resume  {confirm:'RESUME'}
     POST /api/trading/policy           change risk limits (loosening needs confirm:'I ACCEPT MORE RISK')
     POST /api/trading/settings         country, autonomy, council, watchlist, TradingView secret, feed
     POST /api/trading/position/close | /position/modify | /order/cancel
     POST /api/trading/coach            bench / reinstate / promote a crew member
     POST /api/trading/paper/reset      {confirm:'RESET', startingBalance?}
     POST /api/trading/backtest         run a strategy over candles (feed or pasted CSV), optional walk-forward + Monte Carlo
     POST /api/trading/breed            the Strategy Breeder: search settings in-sample, judge the shortlist out-of-sample
     POST /api/trading/tv-webhook       a TradingView alert (needs the webhook secret)
     POST /api/trading/broker/oanda/connect | /broker/oanda/disconnect      GET /api/trading/broker/status */
'use strict';
const I = require('./instruments.js');
const Feeds = require('./feeds.js');
const Backtest = require('./backtest.js');
const Strategies = require('./strategies.js');
const Breeder = require('./breeder.js');
const Oanda = require('./oanda.js');
const Brokers = require('./brokers.js');
const { createService } = require('./service.js');

const TICK_MS = 2000;

function makeTradingRoutes(deps) {
  const { fs, path, dir, readBody, respondJson } = deps;
  // the clock is injected (the host passes the real one; tests pass a fake) — no ambient time in desk logic
  if (typeof deps.now !== 'function') throw new Error('makeTradingRoutes: deps.now (the clock) is required');
  const now = deps.now;
  const log = deps.log || (() => {});
  const svc = createService({ fs, path, dir, now, writeFile: deps.writeFile, log });
  let oanda = null, oandaInfo = null, feedError = '', timer = null, busy = false, lastTickAt = 0;
  const priceSource = new Map();   // symbol -> 'sim' | 'oanda': every quote carries where it came from

  function feedInfo() {
    const real = svc.settings().feed === 'oanda' && !!oanda;
    return { kind: real ? 'oanda' : 'sim', simulated: !real, env: real ? oanda.env : '', error: feedError, lastTickAt,
      label: real ? 'OANDA practice prices' : 'SIMULATED prices — not real market data' };
  }
  function symbolsToPrice() {
    const s = new Set(svc.watchlist());
    const snap = svc.snapshot();
    for (const p of snap.positions) s.add(p.symbol);
    for (const o of snap.orders) s.add(o.symbol);
    // the FX pairs needed to convert every quote currency in play back to the account currency
    const ccy = snap.account.accountCcy;
    for (const sym of Array.from(s)) {
      const inst = I.get(sym);
      if (!inst || inst.quote === ccy) continue;
      for (const pair of [inst.quote + ccy, ccy + inst.quote]) if (I.get(pair)) s.add(pair);
    }
    return Array.from(s);
  }
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      const symbols = symbolsToPrice();
      if (svc.settings().feed === 'oanda' && oanda) {
        const r = await oanda.pricing(symbols);
        if (r.ok) { feedError = ''; for (const q of r.quotes) priceSource.set(q.symbol, 'oanda'); svc.ticks(r.quotes); }
        else feedError = r.error;                       // keep the last real prices; never fall back to simulated ones silently
        // what OANDA does not carry (crypto, single stocks) keeps its simulated price — labelled as such — so paper
        // stops on those symbols still trigger instead of freezing on a stale quote
        const t = now();
        const rest = symbols.filter(sym => !Oanda.toOanda(sym)).map(sym => Feeds.simQuote(sym, t)).filter(Boolean);
        for (const q of rest) priceSource.set(q.symbol, 'sim');
        svc.ticks(rest);
      } else {
        const t = now();
        const qs = symbols.map(s => Feeds.simQuote(s, t)).filter(Boolean);
        for (const q of qs) priceSource.set(q.symbol, 'sim');
        svc.ticks(qs);
        feedError = '';
      }
      lastTickAt = now();
    } catch (e) { feedError = String((e && e.message) || e).slice(0, 200); }
    finally { busy = false; }
  }
  function ensureDriver() {
    if (timer || deps.noDriver) return;
    timer = setInterval(() => { pump(); }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  function stopDriver() { if (timer) { clearInterval(timer); timer = null; } }
  // an account with something at stake keeps being priced from boot, whether or not anyone has the window open
  try { const s = svc.snapshot(); if (s.positions.length || s.orders.length) ensureDriver(); } catch (e) { log('[trading] boot check failed: ' + e.message); }

  function crewList() { try { return typeof deps.crew === 'function' ? (deps.crew() || []).slice(0, 200) : []; } catch (e) { log('[trading] crew read failed: ' + e.message); return []; } }
  const ok = (res, body) => respondJson(res, 200, Object.assign({ ok: true }, body));
  const bad = (res, code, error, extra) => respondJson(res, code, Object.assign({ ok: false, error }, extra || {}));
  async function body(req, max) {
    const raw = await readBody(req, max || (1 << 16));
    if (!raw) return {};
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('body must be a JSON object');
    return v;
  }
  function query(req) { try { return new URL(req.url, 'http://127.0.0.1').searchParams; } catch (_) { return new URLSearchParams(); } }
  // wrap a handler: parse errors -> 400, anything else -> 500 with a plain message (never a stack, never a secret)
  const guard = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e && e.tooLarge) { if (!res.headersSent) bad(res, 413, 'request body too large'); return; }
      const parse = e instanceof SyntaxError || /JSON/.test(String(e && e.message));
      log('[trading] ' + req.method + ' ' + String(req.url).split('?')[0] + ' failed: ' + String((e && e.message) || e));
      bad(res, parse ? 400 : 500, parse ? 'bad request body' : 'the trading desk hit an error handling this request');
    }
  };

  async function candlesFor(symbol, granularity, count) {
    if (svc.settings().feed === 'oanda' && oanda) {
      const r = await oanda.candles(symbol, granularity, count);
      if (r.ok) return { candles: r.candles, simulated: false, source: 'oanda' };
      return { candles: [], simulated: false, source: 'oanda', error: r.error };
    }
    return { candles: Feeds.simCandles(symbol, granularity, count, now()), simulated: true, source: 'sim' };
  }

  const routes = [
    { m: 'GET', exact: '/api/trading/state', h: guard(async (req, res) => {
      ensureDriver();
      if (!lastTickAt) await pump();
      const quotes = {};
      for (const s of symbolsToPrice()) { const q = svc.quote(s); if (q) quotes[s] = Object.assign(q, { source: priceSource.get(s) || 'sim', simulated: priceSource.get(s) !== 'oanda' }); }
      ok(res, Object.assign(svc.snapshot(), { quotes, feed: feedInfo(), now: now(), version: 1 }));
    }) },
    { m: 'GET', exact: '/api/trading/instruments', h: guard(async (req, res) => ok(res, { classes: I.CLASSES, instruments: I.LIST })) },
    { m: 'GET', qsplit: '/api/trading/candles', h: guard(async (req, res) => {
      const q = query(req), symbol = I.normalize(q.get('symbol')), g = q.get('granularity') || 'H1';
      if (!symbol) return bad(res, 400, 'unknown symbol');
      if (!Feeds.GRANULARITY[g]) return bad(res, 400, 'unknown granularity');
      const r = await candlesFor(symbol, g, Math.min(2000, Math.max(10, Number(q.get('count')) || 300)));
      if (r.error) return bad(res, 502, r.error);
      ok(res, { symbol, granularity: g, candles: r.candles, simulated: r.simulated, source: r.source });
    }) },
    { m: 'GET', exact: '/api/trading/scorecards', h: guard(async (req, res) => ok(res, Object.assign(svc.scorecards(), { crew: crewList() }))) },
    { m: 'GET', qsplit: '/api/trading/journal', h: guard(async (req, res) => {
      const q = query(req);
      ok(res, { entries: svc.journal({ limit: Math.min(1000, Math.max(1, Number(q.get('limit')) || 200)), type: q.get('type') || '' }).reverse() });
    }) },
    { m: 'GET', exact: '/api/trading/journal/verify', h: guard(async (req, res) => ok(res, { chain: svc.verifyJournal() })) },
    { m: 'GET', exact: '/api/trading/strategies', h: guard(async (req, res) => ok(res, { strategies: Strategies.describe(), costs: Backtest.DEFAULT_COSTS })) },

    { m: 'POST', exact: '/api/trading/propose', h: guard(async (req, res) => {
      const b = await body(req);
      ensureDriver();
      if (!svc.quote(b.symbol)) await pump();
      // a ticket typed into the app is the Commander's own; a crew member's idea says who it is from
      const source = b.source === 'agent' && b.agentId ? 'agent' : 'human';
      const ticket = svc.propose(Object.assign({}, b, { source }));
      ok(res, { ticket });
    }) },
    { m: 'POST', exact: '/api/trading/argue', h: guard(async (req, res) => {
      const b = await body(req); const r = svc.argue(String(b.ticketId || ''), b);
      r.ok ? ok(res, { ticket: r.ticket }) : bad(res, 400, r.error);
    }) },
    { m: 'POST', exact: '/api/trading/decide', h: guard(async (req, res) => {
      const b = await body(req); const r = svc.decide(String(b.ticketId || ''), { approve: b.approve === true, note: b.note });
      r.ok ? ok(res, { ticket: r.ticket }) : bad(res, 409, r.error);
    }) },
    { m: 'POST', exact: '/api/trading/halt', h: guard(async (req, res) => { const b = await body(req); ok(res, { result: svc.halt(b.reason || 'kill switch', 'commander'), halted: svc.halted() }); }) },
    { m: 'POST', exact: '/api/trading/resume', h: guard(async (req, res) => {
      const b = await body(req);
      if (b.confirm !== 'RESUME') return bad(res, 400, 'type RESUME to confirm');
      ok(res, Object.assign(svc.resume('commander'), { halted: svc.halted() }));
    }) },
    { m: 'POST', exact: '/api/trading/policy', h: guard(async (req, res) => {
      const b = await body(req);
      const r = svc.setPolicy(b.patch || {}, { commander: b.confirm === 'I ACCEPT MORE RISK' });
      r.ok ? ok(res, { policy: r.policy, changes: r.changes }) : bad(res, 409, 'the change was refused', { rejected: r.rejected, needsConfirm: r.rejected.some(x => /Commander/.test(x.reason)) });
    }) },
    { m: 'POST', exact: '/api/trading/settings', h: guard(async (req, res) => {
      const b = await body(req); const r = svc.setSettings(b.patch || {});
      r.ok ? ok(res, { settings: r.settings, brokers: Brokers.catalog(r.settings.country, r.settings.region) }) : bad(res, 400, r.error);
    }) },
    { m: 'POST', exact: '/api/trading/position/close', h: guard(async (req, res) => { const b = await body(req); const r = svc.closePosition(String(b.id || ''), 'commander'); r.ok ? ok(res, { trade: r.trade }) : bad(res, 409, r.error); }) },
    { m: 'POST', exact: '/api/trading/position/modify', h: guard(async (req, res) => {
      const b = await body(req), patch = {};
      if (b.stop !== undefined) patch.stop = b.stop;
      if (b.takeProfit !== undefined) patch.takeProfit = b.takeProfit;
      const r = svc.modifyPosition(String(b.id || ''), patch); r.ok ? ok(res, { position: r.position }) : bad(res, 409, r.error);
    }) },
    { m: 'POST', exact: '/api/trading/order/cancel', h: guard(async (req, res) => { const b = await body(req); const r = svc.cancelOrder(String(b.id || '')); r.ok ? ok(res, {}) : bad(res, 409, r.error); }) },
    { m: 'POST', exact: '/api/trading/blackout', h: guard(async (req, res) => { const b = await body(req); const r = svc.addBlackout(b, 'commander'); r.ok ? ok(res, r) : bad(res, 400, r.error); }) },
    { m: 'POST', exact: '/api/trading/blackout/remove', h: guard(async (req, res) => { const b = await body(req); const r = svc.removeBlackout(String(b.id || ''), 'commander'); r.ok ? ok(res, {}) : bad(res, 409, r.error); }) },
    { m: 'POST', exact: '/api/trading/coach', h: guard(async (req, res) => { const b = await body(req); const r = svc.coachCommand(b.agentId, b.action, b.level); r.ok ? ok(res, r) : bad(res, 400, r.error); }) },
    { m: 'POST', exact: '/api/trading/paper/reset', h: guard(async (req, res) => {
      const b = await body(req);
      if (b.confirm !== 'RESET') return bad(res, 400, 'type RESET to confirm');
      ok(res, svc.resetPaper(b.startingBalance));
    }) },
    { m: 'POST', exact: '/api/trading/backtest', h: guard(async (req, res) => {
      const b = await body(req, 8 << 20);
      const symbol = I.normalize(b.symbol);
      if (!symbol) return bad(res, 400, 'unknown symbol');
      let candles, simulated, source;
      if (typeof b.csv === 'string' && b.csv.trim()) {
        const parsed = Feeds.parseCsvCandles(b.csv);
        if (parsed.error) return bad(res, 400, parsed.error);
        candles = parsed.candles; simulated = false; source = 'csv';
      } else {
        const g = Feeds.GRANULARITY[b.granularity] ? b.granularity : 'H1';
        const r = await candlesFor(symbol, g, Math.min(5000, Math.max(200, Number(b.count) || 2000)));
        if (r.error) return bad(res, 502, r.error);
        candles = r.candles; simulated = r.simulated; source = r.source;
      }
      const opts = { symbol, candles, strategy: String(b.strategy || ''), params: b.params || {}, startingEquity: b.startingEquity, riskPct: b.riskPct, rates: svc._paper.rates(), noCosts: b.noCosts === true };
      const result = Backtest.run(opts);
      if (!result.ok) return bad(res, 400, result.error);
      if (simulated) result.caveats.unshift('SIMULATED DATA: these candles are invented by the built-in simulator. This run proves the plumbing works — it says NOTHING about a real market. Import real candles (TradingView CSV) or connect a broker for a meaningful test.');
      const out = { result: Object.assign({}, result, { equityCurve: thin(result.equityCurve, 400) }), simulated, source };
      if (b.walkForward) { const w = Backtest.walkForward(opts); out.walkForward = w.ok ? { split: w.split, verdict: w.verdict, flags: w.flags, inSample: w.inSample.metrics, outOfSample: w.outOfSample.metrics } : { error: w.error }; }
      if (b.monteCarlo) out.monteCarlo = Backtest.monteCarlo(result.trades, { startingEquity: result.startingEquity, seed: 7 });
      ok(res, out);
    }) },
    { m: 'POST', exact: '/api/trading/breed', h: guard(async (req, res) => {
      const b = await body(req, 8 << 20);
      const symbol = I.normalize(b.symbol);
      if (!symbol) return bad(res, 400, 'unknown symbol');
      let candles, simulated, source;
      if (typeof b.csv === 'string' && b.csv.trim()) {
        const parsed = Feeds.parseCsvCandles(b.csv);
        if (parsed.error) return bad(res, 400, parsed.error);
        candles = parsed.candles; simulated = false; source = 'csv';
      } else {
        const g = Feeds.GRANULARITY[b.granularity] ? b.granularity : 'H1';
        const r = await candlesFor(symbol, g, Math.min(5000, Math.max(500, Number(b.count) || 3000)));
        if (r.error) return bad(res, 502, r.error);
        candles = r.candles; simulated = r.simulated; source = r.source;
      }
      const out = Breeder.breed({ symbol, candles, strategy: String(b.strategy || ''), trials: b.trials, seed: b.seed, rates: svc._paper.rates(), riskPct: b.riskPct, startingEquity: b.startingEquity });
      if (!out.ok) return bad(res, 400, out.error);
      if (simulated) out.caveats.unshift('SIMULATED DATA: the breeder searched invented prices. A survivor here proves only that the search works.');
      ok(res, { breed: out, simulated, source });
    }) },
    { m: 'POST', exact: '/api/trading/tv-webhook', h: guard(async (req, res) => {
      const raw = await readBody(req, 8192);
      const r = svc.tradingViewAlert(raw);
      if (!r.ok) return bad(res, r.status || 400, r.error);
      ensureDriver();
      ok(res, r.duplicate ? { duplicate: true } : r.kind === 'close' ? { kind: 'close', closed: r.closed.length } : { kind: 'entry', ticketId: r.ticket.id, status: r.ticket.status, note: r.ticket.note });
    }) },
    { m: 'GET', exact: '/api/trading/tv-template', h: guard(async (req, res) => ok(res, { template: svc.tvTemplate(), secretSet: svc.settings().tvSecretSet })) },

    { m: 'GET', exact: '/api/trading/broker/status', h: guard(async (req, res) => ok(res, { feed: feedInfo(), oanda: oandaInfo, brokers: Brokers.catalog(svc.settings().country, svc.settings().region) })) },
    { m: 'POST', exact: '/api/trading/broker/oanda/connect', h: guard(async (req, res) => {
      const b = await body(req);
      const s = svc.settings();
      const allowed = Brokers.allowedFor('oanda', s.country, s.region);
      if (!allowed.allowed) return bad(res, 403, allowed.reason);
      if (b.env === 'live') return bad(res, 403, 'Live trading is locked in this version. Connect a PRACTICE account.');
      let client;
      try { client = Oanda.create({ fetch: deps.fetch, token: String(b.token || '').trim(), accountId: String(b.accountId || '').trim(), env: 'practice' }); }
      catch (e) { return bad(res, 400, String(e.message).replace(/^oanda: /, '')); }
      const sum = await client.accountSummary();
      if (!sum.ok) return bad(res, 502, sum.error);
      oanda = client; oandaInfo = { connected: true, env: 'practice', accountId: sum.account.id, currency: sum.account.currency, balance: sum.account.balance, connectedAt: now() };
      svc.setSettings({ feed: 'oanda' });
      feedError = ''; ensureDriver(); await pump();
      ok(res, { oanda: oandaInfo, feed: feedInfo(), note: 'Connected for PRICES and CHARTS. Orders still go to the TRADE GOD paper account.' });
    }) },
    { m: 'POST', exact: '/api/trading/broker/oanda/disconnect', h: guard(async (req, res) => {
      oanda = null; oandaInfo = null; svc.setSettings({ feed: 'sim' }); feedError = '';
      ok(res, { feed: feedInfo() });
    }) }
  ];

  // the crew's tools (sidecar/tools/builtin/trading.js) read candles through the same source the window does
  return { routes, service: svc, pump: async () => { ensureDriver(); await pump(); }, stopDriver, feedInfo, candles: candlesFor };
}

// keep at most `max` points of a curve (first, last and an even stride between) so a long backtest stays a small response
function thin(curve, max) {
  if (!Array.isArray(curve) || curve.length <= max) return curve;
  const out = [], step = (curve.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(curve[Math.round(i * step)]);
  return out;
}

module.exports = { makeTradingRoutes, TICK_MS };
