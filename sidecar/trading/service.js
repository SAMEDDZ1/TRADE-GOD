/* sidecar/trading/service.js — the TRADING DESK: the one place a trade idea becomes (or does not become) a trade.

   THE PIPELINE every idea goes through, whoever it comes from (a crew member, the Commander, a TradingView alert):

     propose ──► agent gate ──► size ──► RISK ENGINE ──► Trading Council ──► approval ──► RISK ENGINE again ──► Executor
                 (coach.js)              (risk.js)       (bull + bear)       (Commander,   (prices moved?)       (paper.js)
                                                                              unless earned)

   A ticket records every step. Nothing skips a gate, and nothing after a gate can loosen it:
     • a benched bot cannot propose; a bot on probation trades half size and always needs approval;
     • the risk engine vetoes anything outside the policy, and is asked AGAIN at execution time because prices move;
     • while the kill switch is on, nothing new happens at all, and turning it on flattens the paper account;
     • every step is appended to the hash-chained journal.

   VERSION 0.1 EXECUTES ON THE PAPER ACCOUNT ONLY. There is no code path here that sends an order to a live
   broker; a ticket's `venue` is always 'paper'. Live execution gets added behind an explicit switch after the
   paper results justify it.

   Clock-free and network-free: every method that needs the time takes it from deps.now(), and prices arrive
   through tick(). State lives in plain JSON files under deps.dir and is written atomically after each change.

   Unit-tested in test/trading.service.test.js. */
'use strict';
const I = require('./instruments.js');
const R = require('./risk.js');
const Paper = require('./paper.js');
const Coach = require('./coach.js');
const SC = require('./scorecard.js');
const Brokers = require('./brokers.js');
const Journal = require('./journal.js');
const TV = require('./tradingview.js');

const AUTONOMY = ['approve-all', 'earned', 'auto'];
const TICKET_CAP = 500;
const APPROVAL_TTL_MS = 30 * 60 * 1000;       // an unanswered approval expires: the price it was sized on is stale
const DEFAULT_WATCHLIST = ['XAUUSD', 'XAGUSD', 'EURUSD', 'USDCAD', 'GBPUSD', 'USDJPY', 'US500', 'NAS100', 'BTCUSD', 'WTIUSD'];
// vetoes that mean "the agent proposed something against the rules" (they count as rule breaks on its scorecard),
// as opposed to vetoes caused by the state of the account or the day.
const AGENT_FAULT = ['no-stop', 'stop-wrong-side', 'tp-wrong-side', 'risk-per-trade', 'bad-size', 'lot-step', 'below-min-lot', 'bad-side', 'bad-entry', 'instrument-leverage'];

function defaults() {
  return { country: 'CA', region: '', autonomy: 'approve-all', requireCouncil: true, tvSecret: '', watchlist: DEFAULT_WATCHLIST.slice(), feed: 'sim', paperStartingBalance: 10000, phoneAlerts: true };
}

function createService(deps) {
  const { fs, path, dir } = deps;
  const now = deps.now || (() => Date.now());
  // the host passes its durable writer; standalone (tests, the preview) uses persist's atomic temp + fsync + rename
  const write = deps.writeFile || ((file, data) => require('../persist/write.js').writeAtomic({ fs, path, mode: 0o600 }, file, data));
  const F = name => path.join(dir, name);
  function readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(F(name), 'utf8')); }
    catch (e) { if (e && e.code !== 'ENOENT' && deps.log) deps.log('[trading] could not read ' + name + ': ' + e.message); return fallback; }
  }
  function save(name, value) { fs.mkdirSync(dir, { recursive: true }); write(F(name), JSON.stringify(value)); }

  // ---------------- state ----------------
  let settings = Object.assign(defaults(), readJson('settings.json', {}));
  if (AUTONOMY.indexOf(settings.autonomy) < 0) settings.autonomy = 'approve-all';
  settings.watchlist = (Array.isArray(settings.watchlist) ? settings.watchlist : []).map(I.normalize).filter(Boolean);
  if (!settings.watchlist.length) settings.watchlist = DEFAULT_WATCHLIST.slice();
  let policy = R.sanitizePolicy(readJson('policy.json', null));
  let halted = Object.assign({ on: false, reason: '', at: 0, by: '' }, readJson('halt.json', {}));
  let tickets = readJson('tickets.json', []); if (!Array.isArray(tickets)) tickets = [];
  let agents = readJson('agents.json', {}); if (!agents || typeof agents !== 'object') agents = {};
  // EVENT BLACKOUTS: windows around high-impact news (CPI, central banks, jobs) when no new position may open.
  // Anyone may ADD one (it only tightens); only the Commander may remove one.
  let blackouts = readJson('blackouts.json', []); if (!Array.isArray(blackouts)) blackouts = [];
  let blackoutSeq = blackouts.reduce((m, b) => Math.max(m, Number(String(b.id).slice(1)) || 0), 0);
  let seenAlerts = [];                                                  // recent TradingView dedupe keys (memory only)
  let ticketSeq = tickets.reduce((m, t) => Math.max(m, Number(String(t.id).slice(1)) || 0), 0);
  const paper = Paper.create({ state: readJson('paper.json', null), startingBalance: settings.paperStartingBalance });
  const journal = Journal.create({ fs, path, file: F('journal.jsonl') });
  const listeners = [];

  const persistPaper = () => save('paper.json', paper.snapshot());
  const persistTickets = () => { if (tickets.length > TICKET_CAP) tickets = tickets.slice(-TICKET_CAP); save('tickets.json', tickets); };
  const persistAgents = () => save('agents.json', agents);
  function emit(type, data) { for (const fn of listeners) { try { fn({ type, data, ts: now() }); } catch (_) { /* a listener must never break the desk */ } } }
  function log(type, data) { const e = journal.append(type, data, now()); emit(type, data); return e; }

  // ---------------- views ----------------
  function agentStatus(agentId) { return agents[agentId] && agents[agentId].status ? agents[agentId].status : Coach.freshStatus(0); }
  function riskContext() {
    const a = paper.account();
    // a pending order is a position waiting to happen: it counts toward the position limit, open risk and leverage NOW,
    // so a stack of resting orders can never add up to more risk than the policy allows once they fill.
    const resting = paper.orders().map(o => ({ symbol: o.symbol, side: o.side, lots: o.lots, entry: o.price, stop: o.stop, pending: true }));
    return { equity: a.equity, accountCcy: a.accountCcy, dayStartEquity: a.dayStartEquity, positions: paper.positions().concat(resting), rates: paper.rates(), halted: halted.on };
  }
  function tradesWithConfidence() {
    const conf = new Map(tickets.filter(t => t.confidence != null).map(t => [t.id, t.confidence]));
    return paper.trades().map(t => Object.assign({}, t, { confidence: conf.has(t.ticketId) ? conf.get(t.ticketId) : null }));
  }
  function scorecards() {
    const all = tradesWithConfidence(), base = paper.state.startingBalance;
    const ids = new Set(Object.keys(agents).concat(all.map(t => t.agentId || '(none)')));
    const out = {};
    for (const id of ids) {
      const mine = all.filter(t => (t.agentId || '(none)') === id), st = agentStatus(id);
      out[id] = { agentId: id, card: SC.compute(mine, { baseEquity: base }), status: st, effects: Coach.effects(st), recommendation: (agents[id] && agents[id].recommendation) || null };
    }
    return { overall: SC.compute(all, { baseEquity: base }), agents: out, bySymbol: SC.group(all, { by: 'symbol', baseEquity: base }), byStrategy: SC.group(all, { by: 'strategy', baseEquity: base }) };
  }
  function publicSettings() { return Object.assign({}, settings, { tvSecret: undefined, tvSecretSet: !!settings.tvSecret }); }
  function snapshot() {
    return {
      venue: 'paper', account: paper.account(), positions: paper.positions(), orders: paper.orders(),
      policy, halted, settings: publicSettings(),
      tickets: tickets.slice(-60).reverse(),
      pending: tickets.filter(t => t.status === 'awaiting-approval' || t.status === 'awaiting-council').reverse(),
      brokers: Brokers.catalog(settings.country, settings.region),
      blackouts: blackouts.filter(b => b.end > now()).sort((a, b) => a.start - b.start)
    };
  }

  // ---------------- coach bookkeeping ----------------
  function coachUpdate(agentId) {
    if (!agentId) return;
    const all = tradesWithConfidence().filter(t => t.agentId === agentId);
    const rec = agents[agentId] || (agents[agentId] = { status: Coach.freshStatus(now()), recommendation: null });
    const st = rec.status, base = paper.state.startingBalance;
    const cards = { all: SC.compute(all, { baseEquity: base }), recent: SC.compute(all.filter(t => t.closedAt >= st.since), { baseEquity: base }) };
    const d = Coach.evaluate(cards, st);
    if (d.next) {
      rec.status = Coach.apply(st, d, now(), all.length);
      rec.recommendation = null;
      log('coach.move', { agentId, from: st.level, to: d.next, reasons: d.reasons });
    } else if (d.promote && !(rec.recommendation && rec.recommendation.promote)) {
      rec.recommendation = { promote: true, reasons: d.reasons, at: now() };
      log('coach.recommend', { agentId, promote: true, reasons: d.reasons });
    }
    persistAgents();
  }
  function noteRuleBreak(agentId, codes) {
    const rec = agents[agentId] || (agents[agentId] = { status: Coach.freshStatus(now()), recommendation: null });
    rec.status.ruleBreaks = (Number(rec.status.ruleBreaks) || 0) + 1;
    log('coach.rule-break', { agentId, codes });
    coachUpdate(agentId);
  }

  function activeBlackout(symbol, at) {
    const inst = I.get(symbol);
    return blackouts.find(b => at >= b.start && at < b.end && (!b.assetClasses.length || (inst && b.assetClasses.indexOf(inst.assetClass) >= 0))
      && (!b.symbols.length || b.symbols.indexOf(I.normalize(symbol)) >= 0)) || null;
  }
  function addBlackout(req, by) {
    const r = req || {};
    const start = Number(new Date(r.start).getTime()), end = Number(new Date(r.end).getTime());
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, error: 'start and end must be dates' };
    if (!(end > start)) return { ok: false, error: 'the blackout must end after it starts' };
    if (end - start > 7 * 86400000) return { ok: false, error: 'a blackout is at most 7 days' };
    if (end < now()) return { ok: false, error: 'that window is already over' };
    const label = String(r.label || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
    if (!label) return { ok: false, error: 'name the event (e.g. "US CPI")' };
    const assetClasses = (Array.isArray(r.assetClasses) ? r.assetClasses : []).filter(c => I.CLASSES.indexOf(c) >= 0);
    const symbols = (Array.isArray(r.symbols) ? r.symbols : []).map(I.normalize).filter(Boolean);
    const b = { id: 'B' + (++blackoutSeq), label, start, end, assetClasses, symbols, by: String(by || 'commander').slice(0, 60), at: now() };
    blackouts.push(b);
    blackouts = blackouts.filter(x => x.end > now() - 86400000).slice(-200);
    save('blackouts.json', blackouts); log('blackout.added', b);
    return { ok: true, blackout: b };
  }
  function removeBlackout(id, by) {
    if (by !== 'commander') return { ok: false, error: 'only the Commander can lift a blackout' };
    const b = blackouts.find(x => x.id === id);
    if (!b) return { ok: false, error: 'no such blackout' };
    blackouts = blackouts.filter(x => x.id !== id); save('blackouts.json', blackouts); log('blackout.removed', { id, label: b.label });
    return { ok: true };
  }

  // ---------------- the pipeline ----------------
  function newTicket(req, fields) {
    const t = Object.assign({
      id: 'K' + (++ticketSeq), createdAt: now(), updatedAt: now(), status: 'proposed', venue: 'paper',
      source: req.source === 'human' || req.source === 'tradingview' ? req.source : 'agent',
      agentId: String(req.agentId || (req.source === 'human' ? 'commander' : '')).slice(0, 60),
      symbol: I.normalize(req.symbol) || String(req.symbol || '').slice(0, 30), side: req.side === 'sell' ? 'sell' : req.side === 'buy' ? 'buy' : '',
      orderType: req.orderType === 'limit' || req.orderType === 'stop' ? req.orderType : 'market',
      entry: null, stop: Number(req.stop) || null, takeProfit: req.takeProfit == null || req.takeProfit === '' ? null : Number(req.takeProfit),
      lots: null, thesis: String(req.thesis || '').slice(0, 2000), confidence: Number(req.confidence) >= 0 && Number(req.confidence) <= 1 && req.confidence != null && req.confidence !== '' ? Number(req.confidence) : null,
      strategy: String(req.strategy || '').slice(0, 80), timeframe: String(req.timeframe || '').slice(0, 12),
      council: [], risk: null, decision: null, execution: null, note: '', expiresAt: 0
    }, fields || {});
    tickets.push(t);
    return t;
  }
  function settle(t, status, note) { t.status = status; t.note = note || t.note; t.updatedAt = now(); persistTickets(); log('ticket.' + status, { id: t.id, symbol: t.symbol, side: t.side, agentId: t.agentId, note: t.note }); return t; }
  function marketEntry(symbol, side) { const p = paper.price(symbol); return p ? (side === 'buy' ? p.ask : p.bid) : null; }

  function councilComplete(t) { return t.council.some(c => c.role === 'bull') && t.council.some(c => c.role === 'bear'); }
  function needsApproval(t) {
    const eff = Coach.effects(agentStatus(t.agentId));
    if (t.source === 'human') return false;                       // the Commander placing their own paper trade has already decided
    if (settings.autonomy === 'approve-all' || eff.requireApproval) return true;
    if (settings.autonomy === 'earned') return !eff.autoApprove;
    return false;
  }
  function advance(t) {
    if (settings.requireCouncil && t.source === 'agent' && !councilComplete(t)) return settle(t, 'awaiting-council', 'Waiting for the Bull and Bear advocates.');
    if (needsApproval(t)) { t.expiresAt = now() + APPROVAL_TTL_MS; return settle(t, 'awaiting-approval', 'Waiting for the Commander.'); }
    return execute(t);
  }

  /* PROPOSE. req: { source, agentId, symbol, side, orderType, entry?, stop, takeProfit?, lots? | riskPct?, thesis, confidence, strategy, timeframe }
     Returns the ticket (always — a refused idea is a ticket too, with the reason). */
  function propose(req) {
    const r = req || {};
    const t = newTicket(r);
    log('ticket.proposed', { id: t.id, source: t.source, agentId: t.agentId, symbol: t.symbol, side: t.side, stop: t.stop, takeProfit: t.takeProfit, strategy: t.strategy });
    const instrument = I.get(t.symbol);
    if (!instrument) return settle(t, 'rejected', 'Unknown instrument: ' + t.symbol);
    if (!t.side) return settle(t, 'rejected', 'Side must be buy or sell.');
    const st = agentStatus(t.agentId), eff = Coach.effects(st);
    if (t.source === 'agent' && !eff.canPropose) return settle(t, 'rejected', 'This crew member is benched and cannot propose trades.');
    if (t.source === 'agent' && !t.agentId) return settle(t, 'rejected', 'A proposal must say which crew member it comes from.');
    if (halted.on) return settle(t, 'rejected', 'The kill switch is ON.');
    const bo = activeBlackout(t.symbol, now());
    if (bo) return settle(t, 'rejected', 'Event blackout: ' + bo.label + ' — no new positions on ' + t.symbol + ' until ' + new Date(bo.end).toISOString().slice(0, 16).replace('T', ' ') + ' UTC.');

    t.entry = t.orderType === 'market' ? marketEntry(t.symbol, t.side) : Number(r.entry);
    if (!(t.entry > 0)) return settle(t, 'failed', t.orderType === 'market' ? 'No price for ' + t.symbol + ' yet.' : 'A pending order needs an entry price.');

    // size: an explicit size is capped at what the agent's level allows; otherwise size by risk
    const a = paper.account();
    const mult = t.source === 'agent' ? eff.sizeMultiplier : 1;
    const wantPct = Number(r.riskPct) > 0 ? Math.min(Number(r.riskPct), policy.riskPerTradePct) : policy.riskPerTradePct;
    const sized = t.stop > 0 ? R.sizeForRisk({ symbol: t.symbol, equity: a.equity, riskPct: wantPct * mult, entry: t.entry, stop: t.stop, accountCcy: a.accountCcy, rates: paper.rates() }) : { lots: 0, error: 'no stop-loss — no trade' };
    if (Number(r.lots) > 0) t.lots = mult < 1 && sized.lots > 0 ? Math.min(Number(r.lots), sized.lots) : Number(r.lots);
    else {
      // risk sizing alone can ask for more than the leverage rules allow when the stop is tight: hold the smaller of the two
      const ctx = riskContext();
      const cap = R.maxLotsByLeverage({ symbol: t.symbol, equity: a.equity, entry: t.entry, accountCcy: a.accountCcy, rates: ctx.rates, positions: ctx.positions }, policy);
      t.lots = Math.min(sized.lots, cap);
      if (cap < sized.lots) t.sizingNote = 'Size cut from ' + sized.lots + ' to ' + cap + ' lots to stay inside the leverage limits.';
    }
    t.sizing = { riskPct: Number((wantPct * mult).toFixed(4)), multiplier: mult, level: st.level };
    if (!(t.lots > 0)) {
      t.risk = { ok: false, violations: [{ code: t.stop > 0 ? 'cannot-size' : 'no-stop', message: sized.error || (sized.lots > 0 ? 'No room left under the leverage limits for even the minimum size.' : 'Could not size this trade.') }], metrics: {}, checkedAt: now() };
      if (t.source === 'agent' && !(t.stop > 0)) noteRuleBreak(t.agentId, ['no-stop']);
      return settle(t, 'vetoed', t.risk.violations[0].message);
    }
    const chk = R.checkOrder({ symbol: t.symbol, side: t.side, lots: t.lots, entry: t.entry, stop: t.stop, takeProfit: t.takeProfit }, riskContext(), policy);
    t.risk = Object.assign({}, chk, { checkedAt: now() });
    if (!chk.ok) {
      const faults = chk.violations.map(v => v.code).filter(c => AGENT_FAULT.indexOf(c) >= 0);
      if (t.source === 'agent' && faults.length) noteRuleBreak(t.agentId, faults);
      return settle(t, 'vetoed', chk.violations.map(v => v.message).join(' '));
    }
    return advance(t);
  }

  // the Trading Council: one argument for (bull) or against (bear). A ticket waiting on the council moves on once it has both.
  function argue(ticketId, arg) {
    const t = tickets.find(x => x.id === ticketId);
    if (!t) return { ok: false, error: 'no such ticket' };
    const role = arg && (arg.role === 'bull' || arg.role === 'bear') ? arg.role : '';
    const text = String((arg && arg.text) || '').trim().slice(0, 4000);
    if (!role || !text) return { ok: false, error: 'an argument needs a role (bull or bear) and text' };
    if (['awaiting-council', 'awaiting-approval'].indexOf(t.status) < 0) return { ok: false, error: 'this ticket is ' + t.status + ' — the debate is closed' };
    t.council.push({ role, agentId: String((arg && arg.agentId) || role).slice(0, 60), text, ts: now() });
    t.updatedAt = now();
    log('ticket.argued', { id: t.id, role, agentId: (arg && arg.agentId) || role });
    if (t.status === 'awaiting-council' && councilComplete(t)) advance(t); else persistTickets();
    return { ok: true, ticket: t };
  }

  // the Commander's answer on a ticket waiting for approval.
  function decide(ticketId, decision) {
    const t = tickets.find(x => x.id === ticketId);
    if (!t) return { ok: false, error: 'no such ticket' };
    expire();
    if (t.status !== 'awaiting-approval') return { ok: false, error: 'this ticket is ' + t.status + ', not waiting for approval' };
    t.decision = { by: 'commander', approve: !!(decision && decision.approve), at: now(), note: String((decision && decision.note) || '').slice(0, 500) };
    if (!t.decision.approve) { settle(t, 'rejected', 'Rejected by the Commander.' + (t.decision.note ? ' ' + t.decision.note : '')); return { ok: true, ticket: t }; }
    execute(t);
    return { ok: true, ticket: t };
  }

  // EXECUTE: the risk engine is asked again with the prices of THIS moment, then the paper broker fills it.
  function execute(t) {
    if (halted.on) return settle(t, 'rejected', 'The kill switch is ON.');
    const bo = activeBlackout(t.symbol, now());
    if (bo) return settle(t, 'rejected', 'Event blackout started before it could fill: ' + bo.label + '.');
    if (t.orderType === 'market') {
      const px = marketEntry(t.symbol, t.side);
      if (!(px > 0)) return settle(t, 'failed', 'No price for ' + t.symbol + '.');
      t.entry = px;
    }
    const chk = R.checkOrder({ symbol: t.symbol, side: t.side, lots: t.lots, entry: t.entry, stop: t.stop, takeProfit: t.takeProfit }, riskContext(), policy);
    t.risk = Object.assign({}, chk, { checkedAt: now() });
    if (!chk.ok) return settle(t, 'vetoed', 'At execution: ' + chk.violations.map(v => v.message).join(' '));
    const order = { symbol: t.symbol, side: t.side, lots: t.lots, stop: t.stop, takeProfit: t.takeProfit, agentId: t.agentId, ticketId: t.id, strategy: t.strategy };
    const res = t.orderType === 'market' ? paper.placeMarket(order, now()) : paper.placePending(Object.assign({ type: t.orderType, price: t.entry }, order), now());
    if (!res.ok) return settle(t, 'failed', res.error);
    persistPaper();
    t.execution = { venue: 'paper', positionId: res.position ? res.position.id : '', orderId: res.order ? res.order.id : '', price: res.position ? res.position.entry : t.entry, at: now() };
    for (const e of res.events) log(e.type, e.position || e.order);
    return settle(t, 'executed', t.orderType === 'market' ? 'Filled on the paper account.' : 'Pending order placed on the paper account.');
  }

  function expire() {
    let changed = false;
    for (const t of tickets) if (t.status === 'awaiting-approval' && t.expiresAt && now() > t.expiresAt) { settle(t, 'expired', 'Nobody approved it in time; the price it was sized on is stale.'); changed = true; }
    return changed;
  }

  // ---------------- prices ----------------
  function handleEvents(events) {
    if (!events || !events.length) return;
    const closedFor = new Set();
    for (const e of events) {
      log(e.type, e.trade || e.position || e.order || null);
      // only a CREW MEMBER's trades move it on the Coach's ladder (the Commander and TradingView alerts are scored, not coached)
      if (e.type === 'position.closed' && e.trade && e.trade.agentId) {
        const src = tickets.find(x => x.id === e.trade.ticketId);
        if (src && src.source === 'agent') closedFor.add(e.trade.agentId);
      }
    }
    persistPaper();
    for (const id of closedFor) coachUpdate(id);
  }
  function tick(symbol, bid, ask, ts) {
    const events = paper.onPrice(symbol, bid, ask, ts == null ? now() : ts);
    handleEvents(events);
    return events;
  }
  function ticks(quotes) { let n = 0; for (const q of (quotes || [])) n += tick(q.symbol, q.bid, q.ask, q.ts).length; if (expire()) n++; return n; }

  // ---------------- the Commander's controls ----------------
  function halt(reason, by) {
    halted = { on: true, reason: String(reason || 'kill switch').slice(0, 200), at: now(), by: String(by || 'commander').slice(0, 40) };
    save('halt.json', halted);
    log('halt.on', { reason: halted.reason, by: halted.by });
    const res = paper.closeAll('kill-switch', now());
    handleEvents(res.events);
    for (const t of tickets) if (t.status === 'awaiting-approval' || t.status === 'awaiting-council') settle(t, 'rejected', 'The kill switch was turned on.');
    return { ok: res.ok, closed: res.events.filter(e => e.type === 'position.closed').length, cancelled: res.events.filter(e => e.type === 'order.cancelled').length, stuck: res.stuck };
  }
  function resume(by) {
    if (by !== 'commander') return { ok: false, error: 'only the Commander can resume trading' };
    halted = { on: false, reason: '', at: now(), by: 'commander' };
    save('halt.json', halted); log('halt.off', { by: 'commander' });
    return { ok: true };
  }
  function setPolicy(patch, opts) {
    const res = R.applyPolicyChange(policy, patch, { commander: !!(opts && opts.commander === true) });
    if (!res.ok) { log('policy.refused', { rejected: res.rejected }); return res; }
    if (res.changes.length) { policy = R.sanitizePolicy(res.policy); save('policy.json', policy); log('policy.changed', { changes: res.changes, by: opts && opts.commander ? 'commander' : 'crew' }); }
    return Object.assign({}, res, { policy });
  }
  function setSettings(patch) {
    const p = patch || {}, next = Object.assign({}, settings);
    if (p.country !== undefined) next.country = String(p.country || '').toUpperCase().slice(0, 2);
    if (p.region !== undefined) next.region = String(p.region || '').toUpperCase().slice(0, 3);
    if (p.autonomy !== undefined) { if (AUTONOMY.indexOf(p.autonomy) < 0) return { ok: false, error: 'autonomy must be one of ' + AUTONOMY.join(', ') }; next.autonomy = p.autonomy; }
    if (p.requireCouncil !== undefined) next.requireCouncil = !!p.requireCouncil;
    if (p.watchlist !== undefined) { const w = Array.from(new Set((Array.isArray(p.watchlist) ? p.watchlist : []).map(I.normalize).filter(Boolean))).slice(0, 40); if (!w.length) return { ok: false, error: 'the watchlist needs at least one known symbol' }; next.watchlist = w; }
    if (p.tvSecret !== undefined) { const s = String(p.tvSecret || ''); if (s && s.length < 12) return { ok: false, error: 'the TradingView secret needs at least 12 characters' }; next.tvSecret = s.slice(0, 128); }
    if (p.phoneAlerts !== undefined) next.phoneAlerts = !!p.phoneAlerts;
    if (p.feed !== undefined) { if (['sim', 'oanda'].indexOf(p.feed) < 0) return { ok: false, error: 'feed must be sim or oanda' }; next.feed = p.feed; }
    const changed = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(settings[k]));
    settings = next; save('settings.json', settings);
    if (changed.length) log('settings.changed', { fields: changed });     // field NAMES only — never the secret itself
    return { ok: true, settings: publicSettings() };
  }
  function closePosition(positionId, by) {
    const res = paper.closePosition(positionId, by === 'commander' ? 'manual' : String(by || 'manual'), now());
    if (res.ok) handleEvents(res.events);
    return res;
  }
  function cancelOrder(orderId) { const res = paper.cancelOrder(orderId, now()); if (res.ok) handleEvents(res.events); return res; }
  // moving a stop is allowed; WIDENING it past the per-trade risk limit is not.
  function modifyPosition(positionId, patch) {
    const pos = paper.positions().find(p => p.id === positionId);
    if (!pos) return { ok: false, error: 'no such position' };
    if (patch && patch.stop !== undefined) {
      const a = paper.account();
      const risk = R.riskOf({ symbol: pos.symbol, lots: pos.lots, entry: pos.entry, stop: Number(patch.stop) }, a.accountCcy, paper.rates());
      const worse = pos.side === 'buy' ? Number(patch.stop) < pos.stop : Number(patch.stop) > pos.stop;
      if (worse && (risk == null || risk > a.equity * policy.riskPerTradePct / 100 + 1e-6)) return { ok: false, error: 'That stop would risk more than ' + policy.riskPerTradePct + '% of equity on this trade.' };
    }
    const res = paper.modifyPosition(positionId, patch || {}, now());
    if (res.ok) handleEvents(res.events);
    return res;
  }
  function coachCommand(agentId, action, level) {
    const id = String(agentId || '').slice(0, 60);
    if (!id) return { ok: false, error: 'which crew member?' };
    if (['bench', 'reinstate', 'promote', 'unpromote', 'set'].indexOf(action) < 0) return { ok: false, error: 'unknown action' };
    const rec = agents[id] || (agents[id] = { status: Coach.freshStatus(now()), recommendation: null });
    const before = rec.status.level, count = paper.trades().filter(t => t.agentId === id).length;
    rec.status = Coach.commanderSet(rec.status, action, now(), count, level);
    if (action === 'promote' || action === 'unpromote') rec.recommendation = null;
    persistAgents(); log('coach.commander', { agentId: id, action, from: before, to: rec.status.level, promoted: rec.status.promoted });
    return { ok: true, status: rec.status, effects: Coach.effects(rec.status) };
  }
  // wipe the paper account back to its starting balance. The journal keeps the history; that is the point of a journal.
  function resetPaper(startingBalance) {
    const bal = Number(startingBalance) > 0 ? Math.min(Number(startingBalance), 100000000) : settings.paperStartingBalance;
    settings.paperStartingBalance = bal; save('settings.json', settings);
    const prices = paper.state.prices, nextId = paper.state.nextId;   // ids keep counting up, so an old journal line never points at a new position
    const freshState = Object.assign(Paper.fresh({ startingBalance: bal, accountCcy: paper.state.accountCcy }), { nextId });
    for (const k of Object.keys(paper.state)) delete paper.state[k];
    Object.assign(paper.state, freshState, { prices });
    paper.rollDay(now());
    persistPaper(); log('paper.reset', { startingBalance: bal });
    return { ok: true, account: paper.account() };
  }

  // ---------------- TradingView ----------------
  function tradingViewAlert(rawBody) {
    const parsed = TV.parse(rawBody, settings.tvSecret);
    if (!parsed.ok) { log('tradingview.refused', { status: parsed.status, error: parsed.error }); return parsed; }
    if (seenAlerts.indexOf(parsed.dedupeKey) >= 0) return { ok: true, duplicate: true };
    seenAlerts.push(parsed.dedupeKey); if (seenAlerts.length > 200) seenAlerts = seenAlerts.slice(-200);
    if (parsed.kind === 'close') {
      const mine = paper.positions().filter(p => p.symbol === parsed.close.symbol && p.agentId === 'tradingview' && (!parsed.close.strategy || p.strategy === parsed.close.strategy));
      const closed = [];
      for (const p of mine) { const r = closePosition(p.id, 'tradingview-exit'); if (r.ok) closed.push(p.id); }
      log('tradingview.close', { symbol: parsed.close.symbol, closed });
      return { ok: true, kind: 'close', closed };
    }
    const ticket = propose(parsed.proposal);
    return { ok: true, kind: 'entry', ticket };
  }

  return {
    // reads
    snapshot, scorecards, policy: () => policy, settings: publicSettings, halted: () => halted,
    tickets: () => tickets.slice(), ticket: id => tickets.find(t => t.id === id) || null,
    journal: opts => journal.read(opts), verifyJournal: () => journal.verify(),
    quote: s => paper.price(s), watchlist: () => settings.watchlist.slice(),
    // the pipeline
    propose, argue, decide, expire,
    // prices
    tick, ticks,
    // controls
    halt, resume, setPolicy, setSettings, closePosition, cancelOrder, modifyPosition, coachCommand, resetPaper,
    addBlackout, removeBlackout, activeBlackout,
    tradingViewAlert, tvTemplate: () => TV.template(settings.tvSecret ? '(your secret)' : 'YOUR-SECRET'),
    onEvent: fn => { listeners.push(fn); },
    _paper: paper
  };
}

module.exports = { createService, AUTONOMY, DEFAULT_WATCHLIST, APPROVAL_TTL_MS };
