/* frontend/app/windows/trading.js — the TRADING DESK window: TRADE GOD's main screen.

   Tabs:  DESK (chart, watchlist, order ticket, positions, orders, recent tickets)
          APPROVALS (tickets waiting for the Trading Council or the Commander)
          CREW (every bot's scorecard, its Coach level and the Commander's controls)
          LAB (backtests: built-in strategies over the feed or an imported TradingView CSV)
          JOURNAL (the hash-chained record, with a VERIFY button)
          SETUP (country & province, autonomy, risk limits, brokers, OANDA practice, TradingView alerts, paper reset)

   A thin client over /api/trading/* (sidecar/trading/routes.js). It never decides anything about money: every
   number shown comes from the desk, and every action is a request the desk can refuse — and when it refuses, the
   window shows the desk's own reason. Prices refresh every 2 seconds while the window is open; the SIMULATED badge
   is shown whenever the feed is not a real one. */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const esc = StationUI.h.esc;
  const api = (url, init) => (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(url, init) : fetch(url, init);
  async function get(url) { const r = await api(url); return r.json(); }
  async function post(url, body) {
    const r = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = null; try { j = await r.json(); } catch (_) { j = { ok: false, error: 'HTTP ' + r.status }; }
    return j;
  }

  const S = {
    tab: 'floor', symbol: 'XAUUSD', tf: 'H1', state: null, candles: null, candleKey: '', strategies: null,
    scores: null, journal: null, chain: null, lab: null, labBusy: false, msg: '', msgKind: '', side: 'buy', tvTemplate: '',
    body: null, chart: null, floor: null, timer: null, inflight: false
  };
  const TABS = [['floor', 'FLOOR'], ['desk', 'DESK'], ['approvals', 'APPROVALS'], ['crew', 'CREW'], ['lab', 'BACKTEST LAB'], ['journal', 'JOURNAL'], ['setup', 'SETUP']];
  const TFS = ['M5', 'M15', 'H1', 'H4', 'D'];
  const LEVEL_TONE = { active: 'ok', review: 'warn', retrain: 'warn', probation: 'bad', practice: 'bad', benched: 'off' };

  const money = (n, ccy) => (n == null || !Number.isFinite(Number(n))) ? '—' : (Number(n) < 0 ? '-' : '') + (ccy ? ccy + ' ' : '') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = n => (n == null || !Number.isFinite(Number(n))) ? '—' : (Number(n) >= 0 ? '+' : '') + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = n => n == null ? '—' : (Number(n) * 100).toFixed(1) + '%';
  const tone = n => Number(n) > 0 ? 'tg-up' : Number(n) < 0 ? 'tg-dn' : '';
  const time = t => { if (!t) return ''; const d = new Date(t); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); };
  function inst(sym) { return (S.instruments || []).find(i => i.symbol === sym) || null; }
  function digits(sym) { const i = inst(sym); return i ? Math.max(0, Math.round(-Math.log10(i.tick))) : 2; }
  const px = (sym, v) => v == null ? '—' : Number(v).toFixed(digits(sym));
  function say(text, kind) { S.msg = text || ''; S.msgKind = kind || ''; renderMsg(); }

  // ------------------------------------------------------------------ data
  async function refresh() {
    if (S.inflight) return; S.inflight = true;
    try {
      const st = await get('/api/trading/state');
      if (st && st.ok) S.state = st;
      if (!S.instruments) { const i = await get('/api/trading/instruments'); S.instruments = i.instruments || []; }
      const key = S.symbol + '|' + S.tf;
      if (S.tab === 'desk' && (key !== S.candleKey || !S.candles || Date.now() - (S.candlesAt || 0) > 15000)) {
        const c = await get('/api/trading/candles?symbol=' + encodeURIComponent(S.symbol) + '&granularity=' + S.tf + '&count=200');
        if (c && c.ok) { S.candles = c; S.candleKey = key; S.candlesAt = Date.now(); }
      }
    } catch (e) { say('Could not reach the trading desk: ' + (e && e.message || e), 'bad'); }
    finally { S.inflight = false; }
    if (S.body && document.contains(S.body)) renderLive();
  }
  function ensureTimer() {
    if (S.timer) return;
    S.timer = setInterval(() => {
      if (!S.body || !document.contains(S.body)) { stopDesk(); return; }
      refresh();
    }, 2000);
  }

  // ------------------------------------------------------------------ shell
  /* the desk's own dialog (never the OS's confirm/prompt over the terminal): resolves true / the typed text, or
     null when cancelled. Enter confirms, Escape cancels; one at a time. */
  function ask(message, opts) {
    opts = opts || {};
    const host = S.body; if (!host) return Promise.resolve(null);
    const old = host.querySelector('.tg-ask'); if (old) old.remove();
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'tg-ask';
      box.innerHTML = '<div class="tg-ask-card' + (opts.danger ? ' danger' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="tg-ask-msg">' + esc(message) + '</div>' +
        (opts.input ? '<input class="tg-ask-in" type="text" autocomplete="off" spellcheck="false" placeholder="' + esc(opts.placeholder || '') + '">' : '') +
        '<div class="tg-ask-row"><button class="tg-btn" data-ask="no">CANCEL</button><button class="tg-btn ' + (opts.danger ? 'tg-ask-danger' : 'tg-go') + '" data-ask="yes">' + esc(opts.okLabel || 'OK') + '</button></div></div>';
      const input = box.querySelector('.tg-ask-in');
      const done = v => { box.remove(); resolve(v); };
      box.addEventListener('click', e => {
        const b = e.target.closest('[data-ask]');
        if (b) done(b.dataset.ask === 'yes' ? (input ? input.value : true) : null);
        else if (e.target === box) done(null);
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter') { e.preventDefault(); done(input ? input.value : true); }
      });
      host.appendChild(box);
      (input || box.querySelector('[data-ask="yes"]')).focus();
    });
  }

  function stopDesk() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (S.chart) { S.chart.destroy(); S.chart = null; }
    if (S.floor) { S.floor.destroy(); S.floor = null; }
  }
  function build(body) {
    S.body = body;
    body.classList.add('tg-root');
    const H = StationUI.h || {};
    if (H.scopeOf) H.scopeOf(body).own('trading-poll', () => { if (S.body === body) { stopDesk(); S.body = null; } });   // the render contract: close stops the price poll at once
    body.innerHTML = '<div class="tg">'
      + '<div class="tg-top" data-slot="top"></div>'
      + '<div class="tg-tabs">' + TABS.map(([k, l]) => '<button class="tg-tab' + (S.tab === k ? ' on' : '') + '" data-tab="' + k + '">' + l + '<span class="tg-badge" data-badge="' + k + '"></span></button>').join('') + '</div>'
      + '<div class="tg-msg" data-slot="msg"></div>'
      + '<div class="tg-pane" data-slot="pane"></div></div>';
    if (!body._tgWired) { body._tgWired = true; body.addEventListener('click', onClick); body.addEventListener('change', onChange); body.addEventListener('submit', e => e.preventDefault()); }
    renderPane();
    refresh().then(() => { renderPane(); });
    ensureTimer();
  }
  function slot(name) { return S.body ? S.body.querySelector('[data-slot="' + name + '"]') : null; }
  function renderMsg() { const m = slot('msg'); if (!m) return; m.className = 'tg-msg' + (S.msg ? ' show ' + S.msgKind : ''); m.textContent = S.msg; }

  function renderTop() {
    const el = slot('top'); if (!el) return;
    const st = S.state;
    if (!st) { el.innerHTML = '<span class="dim">Connecting to the trading desk…</span>'; return; }
    const a = st.account, f = st.feed;
    const halted = st.halted && st.halted.on;
    el.innerHTML = '<div class="tg-feed ' + (f.simulated ? 'sim' : 'real') + '" title="' + esc(f.label + (f.error ? ' — ' + f.error : '')) + '">' + (f.simulated ? 'SIMULATED PRICES' : 'LIVE · ' + esc(f.kind.toUpperCase()) + ' ' + esc(f.env || '')) + '</div>'
      + '<div class="tg-venue">PAPER ACCOUNT</div>'
      + ((st.blackouts || []).some(b => b.start <= st.now && b.end > st.now) ? '<div class="tg-feed sim" title="No new positions on the affected desks">BLACKOUT: ' + esc(st.blackouts.filter(b => b.start <= st.now && b.end > st.now).map(b => b.label).join(', ')) + '</div>' : '')
      + '<div class="tg-kpi"><small>EQUITY</small><b>' + money(a.equity, a.accountCcy) + '</b></div>'
      + '<div class="tg-kpi"><small>BALANCE</small><b>' + money(a.balance) + '</b></div>'
      + '<div class="tg-kpi"><small>TODAY</small><b class="' + tone(a.dayPnl) + '">' + signed(a.dayPnl) + '</b></div>'
      + '<div class="tg-kpi"><small>OPEN</small><b>' + a.openPositions + ' / ' + st.policy.maxOpenPositions + '</b></div>'
      + (halted
        ? '<div class="tg-halted">TRADING HALTED — ' + esc(st.halted.reason || '') + ' <button class="tg-btn" data-act="resume">RESUME…</button></div>'
        : '<button class="tg-kill" data-act="halt" title="Close every position, cancel every order and block new trades">KILL SWITCH</button>');
    const pend = (st.pending || []).length;
    const b = S.body.querySelector('[data-badge="approvals"]'); if (b) b.textContent = pend ? String(pend) : '';
  }

  function renderPane() {
    if (!S.body) return;
    S.body.querySelectorAll('.tg-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === S.tab));
    const pane = slot('pane'); if (!pane) return;
    if (S.chart && S.tab !== 'desk') { S.chart.destroy(); S.chart = null; }
    if (S.floor && S.tab !== 'floor') { S.floor.destroy(); S.floor = null; }
    renderTop(); renderMsg();
    if (!S.state) { pane.innerHTML = ''; return; }
    if (S.tab === 'floor') paneFloor(pane);
    else if (S.tab === 'desk') paneDesk(pane);
    else if (S.tab === 'approvals') paneApprovals(pane);
    else if (S.tab === 'crew') paneCrew(pane);
    else if (S.tab === 'lab') paneLab(pane);
    else if (S.tab === 'journal') paneJournal(pane);
    else paneSetup(pane);
  }
  // the 2-second refresh only touches the live parts, so a half-typed form is never wiped
  function renderLive() {
    renderTop();
    if (S.tab === 'desk') { liveDesk(); }
    else if (S.tab === 'floor') { liveFloor(); }
    else if (S.tab === 'approvals') { const pane = slot('pane'); if (pane && !pane.contains(document.activeElement)) paneApprovals(pane); }
  }

  // ------------------------------------------------------------------ FLOOR
  function paneFloor(pane) {
    pane.innerHTML = '<canvas class="tg-floor" data-slot="floor"></canvas>'
      + '<p class="dim">Your company at work. Lit desks have a crew member in that role (recruit them from CREW › RECRUIT and pick the trading class); dim desks are open seats. '
      + 'Badges show the Agent Coach level (amber = review/retrain, orange = probation, red = practice). The light over the floor turns red while the kill switch is on. Hover a desk to see the role.</p>';
    if (S.floor) S.floor.destroy();
    S.floor = (typeof TradingFloor !== 'undefined') ? TradingFloor.create(pane.querySelector('[data-slot="floor"]')) : null;
    liveFloor(true);
  }
  async function liveFloor(fetchScores) {
    if (!S.floor) return;
    if (fetchScores || !S.scores || Date.now() - (S.scoresAt || 0) > 10000) { try { S.scores = await get('/api/trading/scorecards'); S.scoresAt = Date.now(); } catch (_) {} }
    const roster = (typeof SharedSpecialties !== 'undefined' && SharedSpecialties.BUILTINS) ? SharedSpecialties.BUILTINS : [];
    if (S.floor) S.floor.set({ state: S.state, scores: S.scores, roster, crew: (S.scores && S.scores.crew) || [] });
  }

  // ------------------------------------------------------------------ DESK
  function paneDesk(pane) {
    const st = S.state;
    pane.innerHTML = '<div class="tg-desk">'
      + '<div class="tg-watch" data-slot="watch"></div>'
      + '<div class="tg-center">'
      +   '<div class="tg-charthd"><b data-slot="chartsym"></b> <span class="dim" data-slot="chartname"></span><span class="tg-tfs">' + TFS.map(t => '<button class="tg-tf' + (t === S.tf ? ' on' : '') + '" data-tf="' + t + '">' + t + '</button>').join('') + '</span></div>'
      +   '<canvas class="tg-chart" data-slot="chart"></canvas>'
      +   '<div class="tg-sec">OPEN POSITIONS</div><div data-slot="positions"></div>'
      +   '<div class="tg-sec">PENDING ORDERS</div><div data-slot="orders"></div>'
      + '</div>'
      + '<div class="tg-side">'
      +   '<div class="tg-sec">NEW TICKET</div>' + ticketForm()
      +   '<div class="tg-sec">RECENT TICKETS</div><div data-slot="recent"></div>'
      + '</div></div>';
    const cv = pane.querySelector('[data-slot="chart"]');
    if (S.chart) S.chart.destroy();
    S.chart = (typeof TradingChart !== 'undefined') ? TradingChart.create(cv) : null;
    liveDesk();
  }
  function ticketForm() {
    const pol = S.state.policy;
    return '<form class="tg-ticket" data-slot="ticket">'
      + '<div class="tg-sides"><button type="button" class="tg-side-b' + (S.side === 'buy' ? ' on' : '') + '" data-side="buy">BUY</button><button type="button" class="tg-side-s' + (S.side === 'sell' ? ' on' : '') + '" data-side="sell">SELL</button></div>'
      + '<label>Instrument <b data-slot="tsym">' + esc(S.symbol) + '</b> <span class="dim" data-slot="tquote"></span></label>'
      + '<label>Order <select name="orderType"><option value="market">Market (now)</option><option value="limit">Limit (better price)</option><option value="stop">Stop (breakout)</option></select></label>'
      + '<label data-slot="entryrow" hidden>Entry price <input name="entry" type="number" step="any"></label>'
      + '<label>Stop-loss <em>required</em> <input name="stop" type="number" step="any" required placeholder="price"></label>'
      + '<label>Take-profit <input name="takeProfit" type="number" step="any" placeholder="price (optional)"></label>'
      + '<label>Risk <input name="riskPct" type="number" step="0.05" min="0.05" max="' + pol.riskPerTradePct + '" value="' + pol.riskPerTradePct + '"> % of equity <span class="dim">(max ' + pol.riskPerTradePct + '%)</span></label>'
      + '<label>Why <input name="thesis" type="text" maxlength="300" placeholder="your reason (goes in the journal)"></label>'
      + '<button type="button" class="tg-btn tg-go" data-act="place">PLACE ON PAPER</button>'
      + '<p class="dim tg-fine">The desk sizes the trade from your stop and risk %, then the risk engine checks every limit. No stop, no trade.</p>'
      + '</form>';
  }
  function liveDesk() {
    const st = S.state; if (!st || !S.body) return;
    const w = slot('watch');
    if (w) {
      const wl = st.settings.watchlist;
      w.innerHTML = '<div class="tg-sec">WATCHLIST</div>' + wl.map(sym => {
        const q = st.quotes[sym];
        return '<button class="tg-wrow' + (sym === S.symbol ? ' on' : '') + '" data-sym="' + esc(sym) + '"><b>' + esc(sym) + '</b>'
          + '<span>' + (q ? px(sym, q.bid) : '—') + '</span><span class="dim">' + (q ? px(sym, q.ask) : '') + '</span></button>';
      }).join('');
    }
    const q = st.quotes[S.symbol], i = inst(S.symbol);
    const set = (name, html) => { const e = slot(name); if (e) e.innerHTML = html; };
    set('chartsym', esc(S.symbol)); set('chartname', i ? esc(i.name) : '');
    set('tsym', esc(S.symbol)); set('tquote', q ? 'bid ' + px(S.symbol, q.bid) + ' · ask ' + px(S.symbol, q.ask) : '');
    if (S.chart && S.candles && S.candles.symbol === S.symbol) {
      const levels = [];
      for (const p of st.positions.filter(p => p.symbol === S.symbol)) {
        levels.push({ price: p.entry, kind: 'entry', label: (p.side === 'buy' ? 'LONG ' : 'SHORT ') + p.lots + ' @' + px(S.symbol, p.entry) });
        levels.push({ price: p.stop, kind: 'stop', label: 'STOP' });
        if (p.takeProfit) levels.push({ price: p.takeProfit, kind: 'target', label: 'TARGET' });
      }
      for (const o of st.orders.filter(o => o.symbol === S.symbol)) levels.push({ price: o.price, kind: 'entry', label: o.type.toUpperCase() + ' ' + o.side.toUpperCase() });
      if (q) levels.push({ price: q.bid, kind: 'bid' });
      // the live bar follows the quote between candle refreshes
      const cs = S.candles.candles.slice();
      if (q && cs.length) { const last = Object.assign({}, cs[cs.length - 1]); last.c = q.bid; last.h = Math.max(last.h, q.bid); last.l = Math.min(last.l, q.bid); cs[cs.length - 1] = last; }
      S.chart.set({ candles: cs, levels, digits: digits(S.symbol), simulated: S.candles.simulated });
    }
    set('positions', st.positions.length ? '<table class="tg-tbl"><tr><th>SYMBOL</th><th>SIDE</th><th>LOTS</th><th>ENTRY</th><th>MARK</th><th>STOP</th><th>TARGET</th><th>P&amp;L</th><th>BY</th><th></th></tr>'
      + st.positions.map(p => '<tr><td>' + esc(p.symbol) + '</td><td class="' + (p.side === 'buy' ? 'tg-up' : 'tg-dn') + '">' + p.side.toUpperCase() + '</td><td>' + p.lots + '</td><td>' + px(p.symbol, p.entry) + '</td><td>' + px(p.symbol, p.mark)
        + '</td><td>' + px(p.symbol, p.stop) + '</td><td>' + (p.takeProfit ? px(p.symbol, p.takeProfit) : '—') + '</td><td class="' + tone(p.unrealized) + '">' + signed(p.unrealized) + '</td><td class="dim">' + esc(p.agentId || '') + '</td>'
        + '<td><button class="tg-mini" data-act="movestop" data-id="' + esc(p.id) + '">MOVE STOP</button> <button class="tg-mini" data-act="close" data-id="' + esc(p.id) + '">CLOSE</button></td></tr>').join('') + '</table>'
      : '<p class="dim">No open positions.</p>');
    set('orders', st.orders.length ? '<table class="tg-tbl"><tr><th>SYMBOL</th><th>TYPE</th><th>SIDE</th><th>LOTS</th><th>PRICE</th><th>STOP</th><th></th></tr>'
      + st.orders.map(o => '<tr><td>' + esc(o.symbol) + '</td><td>' + o.type + '</td><td>' + o.side + '</td><td>' + o.lots + '</td><td>' + px(o.symbol, o.price) + '</td><td>' + px(o.symbol, o.stop) + '</td><td><button class="tg-mini" data-act="cancel" data-id="' + esc(o.id) + '">CANCEL</button></td></tr>').join('') + '</table>'
      : '<p class="dim">No pending orders.</p>');
    set('recent', (st.tickets || []).slice(0, 8).map(ticketLine).join('') || '<p class="dim">No tickets yet.</p>');
  }
  const STATUS_TONE = { executed: 'ok', vetoed: 'bad', rejected: 'bad', failed: 'bad', expired: 'off', 'awaiting-approval': 'warn', 'awaiting-council': 'warn', proposed: 'warn' };
  function ticketLine(t) {
    return '<div class="tg-tline"><span class="tg-pill ' + (STATUS_TONE[t.status] || '') + '">' + esc(t.status.replace('awaiting-', 'waiting: ')) + '</span> <b>' + esc(t.side.toUpperCase() + ' ' + t.symbol) + '</b>'
      + (t.lots ? ' ' + t.lots + ' lots' : '') + ' <span class="dim">' + esc(t.agentId || t.source) + ' · ' + time(t.createdAt) + '</span>'
      + (t.note ? '<div class="tg-note">' + esc(t.note) + '</div>' : '') + '</div>';
  }

  // ------------------------------------------------------------------ APPROVALS
  function paneApprovals(pane) {
    const list = (S.state.pending || []);
    pane.innerHTML = '<p class="dim">Every crew idea passes the risk engine, then the Bull and Bear argue it, then it waits here for you. Approving re-checks the risk rules at the price of that moment. Unanswered tickets expire after 30 minutes.</p>'
      + (list.length ? list.map(t => {
        const r = t.risk && t.risk.metrics || {};
        return '<div class="tg-card"><div class="tg-cardhd">' + ticketLine(t) + '</div>'
          + '<div class="tg-grid"><span>Entry <b>' + px(t.symbol, t.entry) + '</b></span><span>Stop <b>' + px(t.symbol, t.stop) + '</b></span><span>Target <b>' + (t.takeProfit ? px(t.symbol, t.takeProfit) : '—') + '</b></span>'
          + '<span>Size <b>' + t.lots + ' lots</b></span><span>Risk <b>' + money(r.riskAmount) + ' (' + (r.riskPct == null ? '—' : r.riskPct + '%') + ')</b></span><span>Reward:risk <b>' + (r.rewardRisk == null ? '—' : r.rewardRisk) + '</b></span>'
          + '<span>Leverage after <b>' + (r.leverageAfter == null ? '—' : r.leverageAfter + ':1') + '</b></span><span>Confidence <b>' + (t.confidence == null ? '—' : Math.round(t.confidence * 100) + '%') + '</b></span><span>Strategy <b>' + esc(t.strategy || '—') + '</b></span></div>'
          + (t.thesis ? '<div class="tg-thesis"><b>THESIS</b> ' + esc(t.thesis) + '</div>' : '')
          + (t.sizingNote ? '<div class="tg-note">' + esc(t.sizingNote) + '</div>' : '')
          + (t.council || []).map(c => '<div class="tg-arg ' + c.role + '"><b>' + (c.role === 'bull' ? '▲ BULL' : '▼ BEAR') + '</b> ' + esc(c.text) + '</div>').join('')
          + (t.status === 'awaiting-approval'
            ? '<div class="tg-acts"><button class="tg-btn tg-go" data-act="approve" data-id="' + esc(t.id) + '">APPROVE</button><button class="tg-btn" data-act="reject" data-id="' + esc(t.id) + '">REJECT</button><span class="dim">expires ' + time(t.expiresAt) + '</span></div>'
            : '<div class="dim">Waiting for the ' + (t.council.some(c => c.role === 'bull') ? 'Bear' : t.council.some(c => c.role === 'bear') ? 'Bull' : 'Bull and Bear') + ' advocate.</div>')
          + '</div>';
      }).join('') : '<p class="tg-empty">Nothing waiting for you.</p>')
      + '<div class="tg-sec">RECENT DECISIONS</div>' + (S.state.tickets || []).filter(t => ['executed', 'vetoed', 'rejected', 'expired', 'failed'].indexOf(t.status) >= 0).slice(0, 12).map(ticketLine).join('');
  }

  // ------------------------------------------------------------------ CREW
  async function paneCrew(pane) {
    pane.innerHTML = '<p class="dim">Loading scorecards…</p>';
    const sc = await get('/api/trading/scorecards'); S.scores = sc;
    if (S.tab !== 'crew') return;
    const cat = (typeof SharedSpecialties !== 'undefined' && SharedSpecialties.BUILTINS) ? SharedSpecialties.BUILTINS : [];
    const crew = sc.crew || [];
    const nameOf = id => { const m = crew.find(x => x.agentId === id); if (m) { const role = cat.find(x => x.id === m.role); return m.name + (role ? ' — ' + role.name : ''); }
      const c = cat.find(x => x.id === id || id.indexOf(x.id + '-') === 0); return c ? c.name : id; };
    const card = c => '<span>Trades <b>' + c.n + '</b></span><span>Win rate <b>' + pct(c.winRate) + '</b></span><span>Profit factor <b>' + (c.profitFactor == null ? '—' : c.profitFactor) + '</b></span>'
      + '<span>Net <b class="' + tone(c.netPnl) + '">' + signed(c.netPnl) + '</b></span><span>Max drawdown <b>' + (c.maxDrawdownPct == null ? money(c.maxDrawdown) : c.maxDrawdownPct + '%') + '</b></span>'
      + '<span>Avg R <b>' + (c.avgR == null ? '—' : c.avgR) + '</b></span><span>Calibration <b>' + (c.brier == null ? '—' : c.brier) + '</b></span><span>Losing streak <b>' + c.currentLosingStreak + '</b></span>';
    const agents = Object.values(sc.agents || {}).filter(a => a.agentId !== '(none)').sort((a, b) => b.card.n - a.card.n);
    pane.innerHTML = '<div class="tg-card"><div class="tg-cardhd"><b>THE WHOLE COMPANY</b></div><div class="tg-grid">' + card(sc.overall) + '</div></div>'
      + '<p class="dim">The Agent Coach moves bots down the ladder automatically — <b>review → retrain (needs approval) → probation (half size) → practice (paper only) → benched</b> — and back up one step at a time. Promotions and un-benching are yours to decide.</p>'
      + (agents.length ? agents.map(a => {
        const st = a.status, lvl = st.level, last = (st.history || []).slice(-1)[0];
        return '<div class="tg-card"><div class="tg-cardhd"><b>' + esc(nameOf(a.agentId)) + '</b> <span class="dim">' + esc(a.agentId) + '</span> <span class="tg-pill ' + (LEVEL_TONE[lvl] || '') + '">' + esc(lvl.toUpperCase()) + (st.promoted ? ' · PROMOTED' : '') + '</span>'
          + (a.effects.sizeMultiplier < 1 && a.effects.canPropose ? ' <span class="tg-pill bad">HALF SIZE</span>' : '') + (a.effects.paperOnly && lvl !== 'benched' ? ' <span class="tg-pill bad">PAPER ONLY</span>' : '') + '</div>'
          + '<div class="tg-grid">' + card(a.card) + '</div>'
          + (last ? '<div class="tg-note">Last move: ' + esc(last.from + ' → ' + last.to) + ' (' + esc(last.by) + ') — ' + esc(last.reason) + '</div>' : '')
          + (a.recommendation && a.recommendation.promote ? '<div class="tg-reco">The Coach recommends a PROMOTION: ' + esc(a.recommendation.reasons.join('; ')) + ' <button class="tg-btn tg-go" data-act="coach" data-agent="' + esc(a.agentId) + '" data-do="promote">ACCEPT PROMOTION</button></div>' : '')
          + '<div class="tg-acts">'
          + (lvl === 'benched' ? '<button class="tg-btn" data-act="coach" data-agent="' + esc(a.agentId) + '" data-do="reinstate">REINSTATE (starts on paper)</button>' : '<button class="tg-btn" data-act="coach" data-agent="' + esc(a.agentId) + '" data-do="bench">BENCH</button>')
          + (st.promoted ? '<button class="tg-btn" data-act="coach" data-agent="' + esc(a.agentId) + '" data-do="unpromote">REMOVE PROMOTION</button>' : '')
          + '</div></div>';
      }).join('') : '<p class="tg-empty">No crew member has traded yet. Recruit desk traders from CREW › RECRUIT and give them a market to watch.</p>')
      + '<div class="tg-sec">BY INSTRUMENT</div><table class="tg-tbl"><tr><th>SYMBOL</th><th>TRADES</th><th>WIN RATE</th><th>PROFIT FACTOR</th><th>NET</th></tr>'
      + Object.entries(sc.bySymbol || {}).map(([k, c]) => '<tr><td>' + esc(k) + '</td><td>' + c.n + '</td><td>' + pct(c.winRate) + '</td><td>' + (c.profitFactor == null ? '—' : c.profitFactor) + '</td><td class="' + tone(c.netPnl) + '">' + signed(c.netPnl) + '</td></tr>').join('') + '</table>';
  }

  // ------------------------------------------------------------------ LAB
  async function paneLab(pane) {
    if (!S.strategies) { const s = await get('/api/trading/strategies'); S.strategies = s.strategies || []; }
    if (S.tab !== 'lab') return;
    const strat = S.labStrategy || (S.strategies[0] && S.strategies[0].id);
    const def = S.strategies.find(s => s.id === strat) || S.strategies[0];
    const syms = (S.instruments || []).map(i => i.symbol);
    pane.innerHTML = '<div class="tg-lab"><form class="tg-ticket" data-slot="labform">'
      + '<label>Strategy <select name="strategy">' + S.strategies.map(s => '<option value="' + s.id + '"' + (s.id === def.id ? ' selected' : '') + '>' + esc(s.name) + ' (' + esc(s.style) + ')</option>').join('') + '</select></label>'
      + '<p class="dim">' + esc(def.description) + '</p>'
      + '<label>Instrument <select name="symbol">' + syms.map(s => '<option' + (s === (S.labSymbol || S.symbol) ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></label>'
      + '<label>Timeframe <select name="granularity">' + TFS.map(t => '<option' + (t === 'H1' ? ' selected' : '') + '>' + t + '</option>').join('') + '</select> bars <input name="count" type="number" value="2000" min="200" max="5000"></label>'
      + Object.entries(def.params).map(([k, p]) => '<label>' + esc(p.label) + ' <input name="p_' + k + '" type="number" step="' + p.step + '" min="' + p.min + '" max="' + p.max + '" value="' + p.default + '"></label>').join('')
      + '<label>Risk per trade <input name="riskPct" type="number" step="0.1" value="1" min="0.1" max="5"> %  · Start <input name="startingEquity" type="number" value="10000"></label>'
      + '<label class="tg-chk"><input type="checkbox" name="walkForward" checked> Walk-forward (70% in-sample / 30% unseen)</label>'
      + '<label class="tg-chk"><input type="checkbox" name="monteCarlo" checked> Monte Carlo drawdowns</label>'
      + '<label>Real candles (optional) — paste a TradingView "Export chart data" CSV or pick the file <input type="file" name="csvfile" accept=".csv,text/csv"><textarea name="csv" rows="3" placeholder="time,open,high,low,close"></textarea></label>'
      + '<button type="button" class="tg-btn tg-go" data-act="backtest"' + (S.labBusy ? ' disabled' : '') + '>' + (S.labBusy ? 'RUNNING…' : 'RUN BACKTEST') + '</button>'
      + '<button type="button" class="tg-btn" data-act="breed"' + (S.labBusy ? ' disabled' : '') + ' title="Try many settings on older data, judge the best few on newer data they never saw">BREED VARIANTS</button>'
      + '<p class="dim tg-fine">BREED tries ~40 settings of this strategy on the first 70% of the history and judges the best five only on the last 30%.</p>'
      + '</form><div class="tg-labres" data-slot="labres"></div></div>';
    renderLabResult();
  }
  function renderBreed(el, B) {
    const b = B.breed, fmt = p => Object.entries(p).filter(([k]) => k !== 'exitOnOpposite').map(([k, v]) => k + ' ' + v).join(' · ');
    el.innerHTML = b.caveats.map(c => '<div class="tg-caveat' + (/SIMULATED|luck/.test(c) ? ' loud' : '') + '">' + esc(c) + '</div>').join('')
      + '<div class="tg-card"><div class="tg-cardhd"><b>STRATEGY BREEDER</b> ' + esc(b.strategy) + ' on ' + esc(b.symbol) + ' — ' + b.tried + ' variants tried, '
      + '<span class="tg-pill ' + (b.survivors ? 'ok' : 'bad') + '">' + b.survivors + ' SURVIVED</span></div>'
      + '<table class="tg-tbl"><tr><th>SETTINGS</th><th>TRAIN PF</th><th>TRAIN TRADES</th><th>UNSEEN PF</th><th>UNSEEN NET</th><th>UNSEEN TRADES</th><th>VERDICT</th></tr>'
      + b.shortlist.map(x => { const os = x.outOfSample || {}; return '<tr><td>' + esc(fmt(x.params)) + '</td><td>' + (x.inSample.profitFactor == null ? '—' : x.inSample.profitFactor) + '</td><td>' + x.inSample.n + '</td><td>' + (os.profitFactor == null ? '—' : os.profitFactor)
        + '</td><td class="' + tone(os.netPnl) + '">' + signed(os.netPnl) + '</td><td>' + (os.n == null ? '—' : os.n) + '</td><td>' + (x.survived ? '<span class="tg-pill ok">SURVIVED</span>' : '<span class="tg-pill bad">FAILED</span> <span class="dim">' + esc(x.reasons.join('; ')) + '</span>') + '</td></tr>'; }).join('')
      + '</table><p class="dim">Defaults were: ' + esc(fmt(b.defaults)) + '. Put a survivor\'s settings into the form and RUN BACKTEST to see its full history, then paper-trade it before trusting it.</p></div>';
  }
  function renderLabResult() {
    const el = slot('labres'); if (!el) return;
    if (S.breedRes) { if (!S.breedRes.ok) { el.innerHTML = '<p class="tg-bad">' + esc(S.breedRes.error) + '</p>'; return; } renderBreed(el, S.breedRes); return; }
    const L = S.lab;
    if (!L) { el.innerHTML = '<p class="dim">Costs (spread, slippage, commission) are ON. Entries fill on the next bar\'s open. When a bar touches both the stop and the target, the stop is assumed. That is how this backtester avoids flattering you.</p>'; return; }
    if (!L.ok) { el.innerHTML = '<p class="tg-bad">' + esc(L.error) + '</p>'; return; }
    const r = L.result, m = r.metrics;
    el.innerHTML = r.caveats.map(c => '<div class="tg-caveat' + (/SIMULATED|SWITCHED OFF/.test(c) ? ' loud' : '') + '">' + esc(c) + '</div>').join('')
      + '<div class="tg-grid"><span>Return <b class="' + tone(m.totalReturnPct) + '">' + signed(m.totalReturnPct) + '%</b></span><span>Trades <b>' + m.n + '</b></span><span>Win rate <b>' + pct(m.winRate) + '</b></span>'
      + '<span>Profit factor <b>' + (m.profitFactor == null ? '—' : m.profitFactor) + '</b></span><span>Max drawdown <b>' + m.maxEquityDrawdownPct + '%</b></span><span>Expectancy <b>' + signed(m.expectancy) + '</b></span>'
      + '<span>Avg R <b>' + (m.avgR == null ? '—' : m.avgR) + '</b></span><span>Sharpe/trade <b>' + (m.sharpe == null ? '—' : m.sharpe) + '</b></span><span>Skipped <b>' + r.skipped + '</b></span></div>'
      + '<canvas class="tg-eq" data-slot="eq"></canvas>'
      + (L.walkForward ? (L.walkForward.error ? '<p class="tg-bad">Walk-forward: ' + esc(L.walkForward.error) + '</p>' : '<div class="tg-card"><div class="tg-cardhd"><b>WALK-FORWARD</b> <span class="tg-pill ' + (L.walkForward.verdict === 'survived' ? 'ok' : L.walkForward.verdict === 'failed' ? 'bad' : 'warn') + '">' + esc(L.walkForward.verdict.toUpperCase()) + '</span></div>'
        + '<div class="tg-grid"><span>In-sample net <b class="' + tone(L.walkForward.inSample.netPnl) + '">' + signed(L.walkForward.inSample.netPnl) + '</b> (PF ' + (L.walkForward.inSample.profitFactor == null ? '—' : L.walkForward.inSample.profitFactor) + ', ' + L.walkForward.inSample.n + ' trades)</span>'
        + '<span>Unseen net <b class="' + tone(L.walkForward.outOfSample.netPnl) + '">' + signed(L.walkForward.outOfSample.netPnl) + '</b> (PF ' + (L.walkForward.outOfSample.profitFactor == null ? '—' : L.walkForward.outOfSample.profitFactor) + ', ' + L.walkForward.outOfSample.n + ' trades)</span></div>'
        + L.walkForward.flags.map(f => '<div class="tg-caveat loud">' + esc(f) + '</div>').join('') + '</div>') : '')
      + (L.monteCarlo && L.monteCarlo.ok ? '<div class="tg-card"><div class="tg-cardhd"><b>MONTE CARLO</b> <span class="dim">' + L.monteCarlo.runs + ' reshuffles of the same trades</span></div><div class="tg-grid"><span>Median drawdown <b>' + L.monteCarlo.medianDrawdownPct + '%</b></span><span>95% worst <b>' + L.monteCarlo.p95DrawdownPct + '%</b></span><span>Worst seen <b>' + L.monteCarlo.worstDrawdownPct + '%</b></span><span>Chance of a ' + L.monteCarlo.ruinPct + '% drawdown <b>' + (L.monteCarlo.probabilityOfRuin * 100).toFixed(1) + '%</b></span></div></div>' : '')
      + '<div class="tg-sec">LAST 30 TRADES</div><table class="tg-tbl"><tr><th>OPENED</th><th>SIDE</th><th>LOTS</th><th>ENTRY</th><th>EXIT</th><th>WHY</th><th>R</th><th>P&amp;L</th></tr>'
      + r.trades.slice(-30).reverse().map(t => '<tr><td>' + time(t.openedAt) + '</td><td>' + t.side + '</td><td>' + t.lots + '</td><td>' + px(r.symbol, t.entry) + '</td><td>' + px(r.symbol, t.exit) + '</td><td>' + esc(t.reason) + '</td><td>' + t.rMultiple + '</td><td class="' + tone(t.pnl) + '">' + signed(t.pnl) + '</td></tr>').join('') + '</table>';
    const cv = slot('eq'); if (cv && typeof TradingChart !== 'undefined') TradingChart.line(cv, r.equityCurve, { base: r.startingEquity });
  }

  // ------------------------------------------------------------------ JOURNAL
  async function paneJournal(pane) {
    pane.innerHTML = '<p class="dim">Loading…</p>';
    const j = await get('/api/trading/journal?limit=300'); S.journal = j.entries || [];
    if (S.tab !== 'journal') return;
    const ch = S.chain;
    pane.innerHTML = '<div class="tg-acts"><button class="tg-btn" data-act="verify">VERIFY THE CHAIN</button>'
      + (ch ? (ch.ok ? '<span class="tg-pill ok">INTACT — ' + ch.entries + ' entries, none changed, removed or reordered</span>' : '<span class="tg-pill bad">BROKEN at entry ' + esc(String(ch.brokenAt)) + ': ' + esc(ch.reason) + '</span>') : '') + '</div>'
      + '<p class="dim">Every proposal, veto, approval, fill, close, kill switch, policy change and Coach move — each line sealed to the one before it.</p>'
      + '<table class="tg-tbl"><tr><th>#</th><th>TIME</th><th>EVENT</th><th>DETAIL</th></tr>' + S.journal.map(e => '<tr><td>' + e.seq + '</td><td>' + time(e.ts) + '</td><td>' + esc(e.type) + '</td><td class="tg-json">' + esc(JSON.stringify(e.data || {}).slice(0, 220)) + '</td></tr>').join('') + '</table>';
  }

  // ------------------------------------------------------------------ SETUP
  async function paneSetup(pane) {
    const st = S.state, s = st.settings, p = st.policy;
    if (!S.tvTemplate) { const t = await get('/api/trading/tv-template'); S.tvTemplate = t.template || ''; }
    if (S.tab !== 'setup') return;
    const PROV = ['', 'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
    pane.innerHTML = '<div class="tg-setup">'
      + '<div class="tg-card"><div class="tg-cardhd"><b>WHERE YOU TRADE FROM</b></div>'
      + '<label>Country <select data-set="country">' + [['CA', 'Canada'], ['US', 'United States'], ['GB', 'United Kingdom'], ['AU', 'Australia'], ['DE', 'Germany'], ['FR', 'France'], ['AE', 'United Arab Emirates'], ['MA', 'Morocco'], ['DZ', 'Algeria']].map(([c, n]) => '<option value="' + c + '"' + (s.country === c ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>'
      + (s.country === 'CA' ? '<label>Province <select data-set="region">' + PROV.map(r => '<option value="' + r + '"' + (s.region === r ? ' selected' : '') + '>' + (r || '— choose —') + '</option>').join('') + '</select></label>' : '')
      + '<p class="dim">Brokers that do not serve where you live are locked. This is not legal advice — the Compliance Officer can check current rules for you.</p></div>'

      + '<div class="tg-card"><div class="tg-cardhd"><b>AUTONOMY</b></div>'
      + [['approve-all', 'Approve every trade', 'Nothing executes until you tap APPROVE. Recommended to start.'], ['earned', 'Earned autonomy', 'Bots you PROMOTED may execute in-limit trades without a tap. Everyone else still asks.'], ['auto', 'Automatic', 'Any bot not on probation may execute in-limit trades. Risk limits still apply to every trade.']]
        .map(([v, n, d]) => '<label class="tg-chk"><input type="radio" name="autonomy" data-set="autonomy" value="' + v + '"' + (s.autonomy === v ? ' checked' : '') + '> <b>' + n + '</b> — <span class="dim">' + d + '</span></label>').join('')
      + '<label class="tg-chk"><input type="checkbox" data-set="requireCouncil"' + (s.requireCouncil ? ' checked' : '') + '> Every crew idea must be argued by the Bull and the Bear first</label>'
      + '<label class="tg-chk"><input type="checkbox" data-set="phoneAlerts"' + (s.phoneAlerts !== false ? ' checked' : '') + '> Phone alerts on Telegram (your paired bot): trades waiting for you, the kill switch, bots put on probation. Reply <b>/approve K12</b>, <b>/reject K12</b>, <b>/trades</b> or <b>/halt</b>.</label></div>'

      + '<div class="tg-card"><div class="tg-cardhd"><b>RISK LIMITS</b> <span class="dim">plain code, not AI</span></div>'
      + [['riskPerTradePct', 'Max risk per trade (% of equity)', 0.05], ['maxDailyLossPct', 'Max loss per day (%) — then trading stops until tomorrow', 0.25], ['maxOpenPositions', 'Max open positions (pending orders count)', 1], ['maxTotalRiskPct', 'Max total open risk (%)', 0.25], ['maxLeverage', 'Max leverage (x:1) — the lower of this and the ' + p.jurisdiction + ' caps applies', 1]]
        .map(([k, l, step]) => '<label>' + l + ' <input type="number" step="' + step + '" data-pol="' + k + '" value="' + p[k] + '"></label>').join('')
      + '<p class="dim">A stop-loss is required on every trade and that cannot be switched off. Lowering a limit is always allowed; raising one asks you to type <b>I ACCEPT MORE RISK</b>.</p>'
      + '<button class="tg-btn" data-act="savepolicy">SAVE LIMITS</button></div>'

      + '<div class="tg-card"><div class="tg-cardhd"><b>EVENT BLACKOUTS</b> <span class="dim">no new positions during high-impact news</span></div>'
      + ((st.blackouts || []).length ? '<table class="tg-tbl"><tr><th>EVENT</th><th>FROM</th><th>TO</th><th>AFFECTS</th><th>BY</th><th></th></tr>' + st.blackouts.map(b => '<tr><td>' + esc(b.label) + '</td><td>' + time(b.start) + '</td><td>' + time(b.end) + '</td><td>'
        + esc(b.symbols.concat(b.assetClasses).join(', ') || 'everything') + '</td><td class="dim">' + esc(b.by) + '</td><td><button class="tg-mini" data-act="lift" data-id="' + esc(b.id) + '">LIFT</button></td></tr>').join('') + '</table>' : '<p class="dim">None scheduled. The News Scout can add them from the economic calendar.</p>')
      + '<form data-slot="blackout"><label>Event <input name="label" placeholder="US CPI"></label><label>From <input name="start" type="datetime-local"></label><label>To <input name="end" type="datetime-local"></label>'
      + '<label>Only these desks (none = all) <select name="assetClasses" multiple size="3">' + ['metals', 'forex', 'indices', 'equities', 'crypto', 'energy'].map(c => '<option>' + c + '</option>').join('') + '</select></label>'
      + '<button type="button" class="tg-btn" data-act="addblackout">ADD BLACKOUT</button></form></div>'

      + '<div class="tg-card"><div class="tg-cardhd"><b>WATCHLIST</b></div><label>Symbols (comma separated) <input data-set="watchlist" value="' + esc(s.watchlist.join(', ')) + '"></label></div>'

      + '<div class="tg-card tg-wide"><div class="tg-cardhd"><b>BROKERS</b></div><table class="tg-tbl"><tr><th>BROKER</th><th>MARKETS</th><th>STATUS</th><th></th></tr>'
      + st.brokers.map(b => '<tr><td><b>' + esc(b.name) + '</b><div class="dim">' + esc(b.notes) + '</div></td><td>' + esc(b.assetClasses.join(', ')) + (b.metals ? '<div class="dim">metals: ' + esc(b.metals) + '</div>' : '') + '</td>'
        + '<td><span class="tg-pill ' + ({ ready: 'ok', experimental: 'warn', coming: 'off', locked: 'bad' }[b.state]) + '">' + b.state.toUpperCase() + '</span>' + (b.blockedReason ? '<div class="dim">' + esc(b.blockedReason) + '</div>' : '') + '</td><td></td></tr>').join('') + '</table>'
      + '<div class="tg-sub"><b>OANDA practice account</b> — real prices and charts for forex, gold, silver and indices. Orders still go to the TRADE GOD paper account in this version. '
      + (st.feed.kind === 'oanda' ? '<span class="tg-pill ok">CONNECTED</span> <button class="tg-btn" data-act="oandaoff">DISCONNECT</button>'
        : '<form data-slot="oanda"><label>Practice API token <input type="password" name="token" autocomplete="off"></label><label>Account ID <input name="accountId" placeholder="101-001-1234567-001"></label><button type="button" class="tg-btn" data-act="oanda">CONNECT PRACTICE ACCOUNT</button></form><p class="dim">The token stays in memory for this session only: it is never saved to disk or shown again.</p>')
      + '</div></div>'

      + '<div class="tg-card"><div class="tg-cardhd"><b>TRADINGVIEW ALERTS</b> ' + (s.tvSecretSet ? '<span class="tg-pill ok">SECRET SET</span>' : '<span class="tg-pill off">OFF</span>') + '</div>'
      + '<ol class="tg-steps"><li>Set a webhook secret here (12+ characters).</li><li>Expose TRADE GOD to TradingView with a tunnel (cloudflared or ngrok) pointing at this computer\'s port, and use <code>https://&lt;your-tunnel&gt;/api/trading/tv-webhook</code> as the alert\'s Webhook URL. TradingView needs a paid plan (Essential or higher) and 2-factor sign-in for webhooks.</li><li>Paste the message below into the alert, with your secret. Every alert must carry a stop, and it only ever becomes a <b>proposal</b> you approve.</li></ol>'
      + '<label>Webhook secret <input type="password" data-slot="tvsecret" autocomplete="off" placeholder="' + (s.tvSecretSet ? '(set — type a new one to replace it)' : 'at least 12 characters') + '"></label><button class="tg-btn" data-act="tvsecret">SAVE SECRET</button>'
      + '<label>Alert message <textarea readonly rows="4">' + esc(S.tvTemplate) + '</textarea></label></div>'

      + '<div class="tg-card"><div class="tg-cardhd"><b>PAPER ACCOUNT</b></div><p class="dim">Start over with a fresh balance. The journal keeps the history.</p><label>Starting balance <input type="number" data-slot="resetbal" value="' + st.account.startingBalance + '"></label><button class="tg-btn" data-act="reset">RESET PAPER ACCOUNT…</button></div>'
      + '</div>';
  }

  // ------------------------------------------------------------------ actions
  function formVals(form) { const o = {}; new FormData(form).forEach((v, k) => { o[k] = v; }); return o; }
  const num = v => v === '' || v == null ? undefined : Number(v);
  async function onClick(e) {
    const t = e.target.closest('[data-tab],[data-tf],[data-sym],[data-side],[data-act]'); if (!t || !S.body.contains(t)) return;
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.msg = ''; renderPane(); refresh(); return; }
    if (t.dataset.tf) { S.tf = t.dataset.tf; S.candles = null; S.body.querySelectorAll('.tg-tf').forEach(b => b.classList.toggle('on', b.dataset.tf === S.tf)); refresh(); return; }
    if (t.dataset.sym) { S.symbol = t.dataset.sym; S.candles = null; liveDesk(); refresh(); return; }
    if (t.dataset.side) { S.side = t.dataset.side; S.body.querySelectorAll('[data-side]').forEach(b => b.classList.toggle('on', b.dataset.side === S.side)); return; }
    const act = t.dataset.act, id = t.dataset.id;
    let r = null;
    try {
      if (act === 'halt') {
        if (!(await ask('KILL SWITCH: close every position, cancel every order and block new trades?', { danger: true, okLabel: 'KILL SWITCH' }))) return;
        r = await post('/api/trading/halt', { reason: 'kill switch pressed' });
        if (r.ok) say('Kill switch ON — ' + r.result.closed + ' position(s) closed, ' + r.result.cancelled + ' order(s) cancelled.' + (r.result.stuck.length ? ' COULD NOT CLOSE: ' + r.result.stuck.map(s => s.symbol).join(', ') : ''), r.result.stuck.length ? 'bad' : 'ok');
      } else if (act === 'resume') {
        const typed = await ask('Type RESUME to allow trading again.', { input: true, placeholder: 'RESUME', okLabel: 'RESUME' }); if (typed == null) return;
        r = await post('/api/trading/resume', { confirm: typed.trim() }); say(r.ok ? 'Trading resumed.' : r.error, r.ok ? 'ok' : 'bad');
      } else if (act === 'place') {
        const v = formVals(slot('ticket'));
        r = await post('/api/trading/propose', { symbol: S.symbol, side: S.side, orderType: v.orderType, entry: num(v.entry), stop: num(v.stop), takeProfit: num(v.takeProfit), riskPct: num(v.riskPct), thesis: v.thesis });
        if (r.ok) { const k = r.ticket; say(k.status === 'executed' ? 'Done: ' + k.side.toUpperCase() + ' ' + k.lots + ' lots ' + k.symbol + ' at ' + px(k.symbol, k.execution && k.execution.price) + ' (paper).' : 'Not placed — ' + k.note, k.status === 'executed' ? 'ok' : 'bad'); }
        else say(r.error, 'bad');
      } else if (act === 'close') {
        r = await post('/api/trading/position/close', { id }); say(r.ok ? 'Closed: ' + signed(r.trade.pnl) : r.error, r.ok ? 'ok' : 'bad');
      } else if (act === 'movestop') {
        const v = await ask('New stop-loss price (it can be moved, never removed):', { input: true, okLabel: 'MOVE STOP' }); if (v == null || v === '') return;
        r = await post('/api/trading/position/modify', { id, stop: Number(v) }); say(r.ok ? 'Stop moved.' : r.error, r.ok ? 'ok' : 'bad');
      } else if (act === 'cancel') {
        r = await post('/api/trading/order/cancel', { id }); say(r.ok ? 'Order cancelled.' : r.error, r.ok ? 'ok' : 'bad');
      } else if (act === 'approve' || act === 'reject') {
        r = await post('/api/trading/decide', { ticketId: id, approve: act === 'approve' });
        if (r.ok) say(r.ticket.status === 'executed' ? 'Approved and filled on paper.' : 'Ticket ' + r.ticket.status + ' — ' + r.ticket.note, r.ticket.status === 'executed' ? 'ok' : (act === 'reject' ? 'ok' : 'bad')); else say(r.error, 'bad');
      } else if (act === 'coach') {
        r = await post('/api/trading/coach', { agentId: t.dataset.agent, action: t.dataset.do });
        say(r.ok ? 'Done.' : r.error, r.ok ? 'ok' : 'bad'); if (r.ok) paneCrew(slot('pane'));
        return;
      } else if (act === 'backtest') {
        const form = slot('labform'), v = formVals(form), params = {};
        Object.keys(v).filter(k => k.indexOf('p_') === 0).forEach(k => { params[k.slice(2)] = Number(v[k]); });
        let csv = v.csv || '';
        const f = form.querySelector('input[name="csvfile"]').files[0];
        if (f) csv = await f.text();
        S.labBusy = true; S.labStrategy = v.strategy; S.labSymbol = v.symbol; S.breedRes = null; paneLab(slot('pane'));
        S.lab = await post('/api/trading/backtest', { symbol: v.symbol, strategy: v.strategy, granularity: v.granularity, count: Number(v.count), params, riskPct: Number(v.riskPct), startingEquity: Number(v.startingEquity), walkForward: !!v.walkForward, monteCarlo: !!v.monteCarlo, csv });
        S.labBusy = false; paneLab(slot('pane'));
        return;
      } else if (act === 'breed') {
        const form = slot('labform'), v = formVals(form);
        let csv = v.csv || '';
        const f = form.querySelector('input[name="csvfile"]').files[0];
        if (f) csv = await f.text();
        S.labBusy = true; S.labStrategy = v.strategy; S.labSymbol = v.symbol; paneLab(slot('pane'));
        S.breedRes = await post('/api/trading/breed', { symbol: v.symbol, strategy: v.strategy, granularity: v.granularity, count: Math.max(Number(v.count), 3000), csv, riskPct: Number(v.riskPct), startingEquity: Number(v.startingEquity) });
        S.labBusy = false; paneLab(slot('pane'));
        return;
      } else if (act === 'verify') {
        r = await get('/api/trading/journal/verify'); S.chain = r.chain; paneJournal(slot('pane')); return;
      } else if (act === 'savepolicy') {
        const patch = {}; S.body.querySelectorAll('[data-pol]').forEach(i => { patch[i.dataset.pol] = Number(i.value); });
        r = await post('/api/trading/policy', { patch });
        if (!r.ok && r.needsConfirm) {
          const typed = await ask('You are RAISING a risk limit. Type I ACCEPT MORE RISK to confirm.', { input: true, danger: true, placeholder: 'I ACCEPT MORE RISK', okLabel: 'RAISE LIMIT' });
          if (typed == null) { say('Limits unchanged.', ''); return; }
          r = await post('/api/trading/policy', { patch, confirm: typed.trim() });
        }
        say(r.ok ? 'Risk limits saved.' : (r.error + ': ' + (r.rejected || []).map(x => x.field + ' — ' + x.reason).join('; ')), r.ok ? 'ok' : 'bad');
      } else if (act === 'addblackout') {
        const f = slot('blackout'), v = formVals(f);
        const classes = Array.from(f.querySelector('select[name="assetClasses"]').selectedOptions).map(o => o.value);
        r = await post('/api/trading/blackout', { label: v.label, start: v.start ? new Date(v.start).toISOString() : '', end: v.end ? new Date(v.end).toISOString() : '', assetClasses: classes });
        say(r.ok ? 'Blackout added: ' + r.blackout.label + '.' : r.error, r.ok ? 'ok' : 'bad');
      } else if (act === 'lift') {
        if (!(await ask('Lift this blackout? New positions will be allowed during the event.', { okLabel: 'LIFT' }))) return;
        r = await post('/api/trading/blackout/remove', { id }); say(r.ok ? 'Blackout lifted.' : r.error, r.ok ? 'ok' : 'bad');
      } else if (act === 'oanda') {
        const v = formVals(slot('oanda'));
        say('Connecting to OANDA practice…', '');
        r = await post('/api/trading/broker/oanda/connect', { token: v.token, accountId: v.accountId });
        say(r.ok ? 'Connected: ' + r.oanda.accountId + ' (' + r.oanda.currency + '). ' + r.note : r.error, r.ok ? 'ok' : 'bad');
      } else if (act === 'oandaoff') {
        r = await post('/api/trading/broker/oanda/disconnect', {}); say('Disconnected. Back to simulated prices.', 'ok');
      } else if (act === 'tvsecret') {
        const v = slot('tvsecret').value;
        r = await post('/api/trading/settings', { patch: { tvSecret: v } }); say(r.ok ? 'Webhook secret saved.' : r.error, r.ok ? 'ok' : 'bad');
      } else if (act === 'reset') {
        const typed = await ask('Type RESET to wipe the paper account back to a fresh balance.', { input: true, danger: true, placeholder: 'RESET', okLabel: 'RESET' }); if (typed == null) return;
        r = await post('/api/trading/paper/reset', { confirm: typed.trim(), startingBalance: Number(slot('resetbal').value) });
        say(r.ok ? 'Paper account reset.' : r.error, r.ok ? 'ok' : 'bad');
      }
    } catch (err) { say(String(err && err.message || err), 'bad'); }
    await refresh();
    if (['savepolicy', 'oanda', 'oandaoff', 'tvsecret', 'reset', 'addblackout', 'lift'].indexOf(act) >= 0 && S.tab === 'setup') paneSetup(slot('pane'));
    if (S.tab === 'approvals') paneApprovals(slot('pane'));
  }
  async function onChange(e) {
    const t = e.target;
    if (t.name === 'orderType') { const row = slot('entryrow'); if (row) row.hidden = t.value === 'market'; return; }
    if (t.name === 'strategy' && t.closest('[data-slot="labform"]')) { S.labStrategy = t.value; paneLab(slot('pane')); return; }
    const key = t.dataset && t.dataset.set; if (!key) return;
    let val = t.type === 'checkbox' ? t.checked : t.value;
    if (key === 'watchlist') val = String(val).split(/[\s,]+/).filter(Boolean);
    const r = await post('/api/trading/settings', { patch: { [key]: val } });
    say(r.ok ? 'Saved.' : r.error, r.ok ? 'ok' : 'bad');
    await refresh(); if (S.tab === 'setup') paneSetup(slot('pane'));
  }

  StationUI.registerWindow('trading', 'TRADING DESK', build, { className: 'trading-win' });

  /* TRADE GOD opens on its trading floor: once the station screen is up (the bottom bar is visible) and no window is
     open yet, raise the TRADING DESK — once per launch. Turn it off with localStorage 'tradegod.openDeskOnLaunch' = '0'. */
  (function openOnLaunch() {
    let pref = '1';
    try { pref = localStorage.getItem('tradegod.openDeskOnLaunch') || '1'; } catch (_) {}
    if (pref === '0') return;
    // a short launch-time wait (no window exists yet, so there is no window scope to own it); it ends itself
    const started = Date.now();
    (function look() {
      if (Date.now() - started > 120000) return;
      const bar = document.getElementById('bottombar');
      if (!bar || !bar.offsetParent) { setTimeout(look, 700); return; }
      if (document.querySelector('.term.trading-win')) return;
      try { StationUI.h.openTerm('trading'); } catch (e) { console.warn('[trading] could not open the desk on launch:', e && e.message); }
    })();
  })();
})();
