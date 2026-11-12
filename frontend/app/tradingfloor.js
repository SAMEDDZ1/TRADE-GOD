/* frontend/app/tradingfloor.js — THE TRADING FLOOR: TRADE GOD's own pixel-art scene of the company at work.

   Every pixel here is drawn by this file — no image assets. The floor is a projection of LIVE desk state, never a
   decoration that claims things that are not true:
     • the ticker wall scrolls the real quotes the desk has (and says SIMULATED when they are simulated);
     • the P&L board shows the paper account's real equity and today's P&L;
     • the alarm light over the floor is RED while the kill switch is on;
     • a crew member who has traded wears their Agent Coach level as a badge (probation, practice, benched…);
     • the APPROVALS lamp on the Commander's desk glows while tickets wait for you.
   Roles with no bot behind them yet sit dimmed at their desks: the seat exists, nobody is hired into it.

   API: const f = TradingFloor.create(canvas); f.set({ state, scores, roster }); f.destroy()
        roster: SharedSpecialties.BUILTINS (id, name, dept, accent). */
'use strict';
(function (root) {
  const W = 640, H = 320;                       // the logical pixel grid; scaled up crisp
  const PAL = {
    floor: '#151a26', floor2: '#181e2b', wall: '#0b0e15', trim: '#2a3247', desk: '#5b4632', deskTop: '#76593e', deskEdge: '#3b2c1f',
    mon: '#1d2333', monEdge: '#2f3850', up: '#2ecc71', down: '#e74c3c', gold: '#f5be32', goldDim: '#a87f1d', text: '#d7deea',
    chair: '#2b2f3c', glass: 'rgba(120,170,255,0.08)', shadow: 'rgba(0,0,0,0.35)'
  };
  const SKIN = ['#f1c7a3', '#e0ac85', '#c68c63', '#9c6a46', '#6e4a30', '#f6d5bb'];
  const HAIR = ['#1b1512', '#3b2716', '#6b4423', '#b98a4a', '#d9d4c7', '#7a2e1d', '#121212'];
  // what each role carries — drawn as a few pixels next to or on the character
  const PROP = {
    headcoach: 'crown', agentcoach: 'whistle', cio: 'chart', cro: 'shield', chief: 'clipboard',
    macro: 'globe', analyst: 'glasses', fundamental: 'paper', researcher: 'headset', sentiment: 'phone', onchain: 'chain',
    metals: 'goldbar', forex: 'flag', equities: 'glasses', indices: 'chart', crypto: 'coin', energy: 'barrel', options: 'glasses',
    strategist: 'clipboard', quant: 'glasses', breeder: 'flask', bull: 'horns', bear: 'ears',
    riskmanager: 'shield', compliance: 'scales', auditor: 'magnifier', executor: 'headset', portfolio: 'chart', treasurer: 'coin',
    brokerlink: 'headset', journal: 'book', performance: 'chart', tradingcoach: 'whistle', nightwatch: 'cap', dataeng: 'laptop', sentinel: 'cap'
  };
  const LEVEL_COL = { review: '#f5be32', retrain: '#f5be32', probation: '#ff8c42', practice: '#ff5a4e', benched: '#7d8698' };
  const ZONES = [   // [department, col, row] on a 4x2 grid; the 8th cell is the Commander's desk + board
    ['Executive Floor', 0, 0], ['Research Department', 1, 0], ['Trading Desks', 2, 0], ['Strategy & Quant Lab', 3, 0],
    ['Risk & Compliance', 0, 1], ['Execution & Operations', 1, 1], ['Support Staff', 2, 1]
  ];
  const TOP = 34, ZW = 160, ZH = 143;

  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const k = v => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
    return '#' + ((1 << 24) | (k(r) << 16) | (k(g) << 8) | k(b)).toString(16).slice(1);
  }

  function create(canvas) {
    const px = document.createElement('canvas'); px.width = W; px.height = H;
    const g = px.getContext('2d'), out = canvas.getContext('2d');
    let data = { state: null, scores: null, roster: [] }, raf = 0, t0 = 0, seats = [], hover = null;
    const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x | 0, y | 0, w | 0, h | 0); };

    function person(x, y, look, frame, dim) {
      // 10 x 16 px trader seen from the front, sitting behind a desk (legs hidden). x,y = top-left of the head.
      const sk = look.skin, hr = look.hair, suit = dim ? '#3a3f4d' : look.suit, tie = dim ? '#555' : look.tie;
      const bob = (frame % 2) && !dim ? 1 : 0;
      y += bob;
      // hair / head
      R(x + 2, y, 6, 2, hr); R(x + 1, y + 1, 8, 2, hr);
      if (look.long) { R(x + 1, y + 3, 1, 4, hr); R(x + 8, y + 3, 1, 4, hr); }
      R(x + 2, y + 2, 6, 5, dim ? shade(sk, -0.4) : sk);
      R(x + 3, y + 4, 1, 1, '#1a1a1a'); R(x + 6, y + 4, 1, 1, '#1a1a1a');
      if (!dim && (frame % 23) === 0) { R(x + 3, y + 4, 1, 1, sk); R(x + 6, y + 4, 1, 1, sk); }   // blink
      R(x + 4, y + 6, 2, 1, shade(sk, -0.25));
      // body
      R(x + 1, y + 7, 8, 7, suit); R(x, y + 8, 1, 5, suit); R(x + 9, y + 8, 1, 5, suit);
      R(x + 4, y + 7, 2, 1, '#e8e8e8'); R(x + 4, y + 8, 2, 4, tie);
      // hands on the keyboard, typing
      R(x + (frame % 2 ? 1 : 2), y + 13, 2, 1, sk); R(x + (frame % 2 ? 7 : 6), y + 13, 2, 1, sk);
      prop(x, y, look.prop, frame, dim);
    }
    function prop(x, y, p, frame, dim) {
      const gold = dim ? PAL.goldDim : PAL.gold;
      switch (p) {
        case 'crown': R(x + 2, y - 3, 6, 2, gold); R(x + 2, y - 4, 1, 1, gold); R(x + 4, y - 5, 2, 2, gold); R(x + 7, y - 4, 1, 1, gold); R(x + 4, y - 2, 2, 1, '#e74c3c'); break;
        case 'whistle': R(x + 9, y + 8, 2, 2, '#c9ced8'); R(x + 5, y + 7, 4, 1, '#c9ced8'); break;
        case 'headset': R(x, y + 1, 1, 5, '#c9ced8'); R(x + 1, y, 8, 1, '#c9ced8'); R(x + 9, y + 1, 1, 5, '#c9ced8'); R(x + 1, y + 6, 3, 1, '#c9ced8'); break;
        case 'glasses': R(x + 2, y + 4, 2, 1, '#9fb3ff'); R(x + 6, y + 4, 2, 1, '#9fb3ff'); R(x + 4, y + 4, 2, 1, '#333'); break;
        case 'goldbar': R(x + 10, y + 10, 5, 3, gold); R(x + 11, y + 9, 3, 1, shade(PAL.gold, 0.3)); break;
        case 'coin': R(x + 10, y + 9, 4, 4, gold); R(x + 11, y + 10, 2, 2, PAL.goldDim); break;
        case 'horns': R(x, y - 2, 2, 2, '#e8dcc0'); R(x - 1, y - 3, 1, 1, '#e8dcc0'); R(x + 8, y - 2, 2, 2, '#e8dcc0'); R(x + 10, y - 3, 1, 1, '#e8dcc0'); break;
        case 'ears': R(x + 1, y - 2, 2, 2, '#6b4423'); R(x + 7, y - 2, 2, 2, '#6b4423'); break;
        case 'shield': R(x + 10, y + 8, 4, 5, '#c0392b'); R(x + 11, y + 9, 2, 3, '#ff8c80'); break;
        case 'clipboard': R(x + 10, y + 8, 4, 6, '#d2b48c'); R(x + 11, y + 7, 2, 1, '#888'); R(x + 11, y + 10, 2, 1, '#555'); break;
        case 'chart': R(x + 10, y + 8, 5, 5, '#e8e8e8'); R(x + 11, y + 11, 1, 1, PAL.up); R(x + 12, y + 10, 1, 1, PAL.up); R(x + 13, y + 9, 1, 1, PAL.up); break;
        case 'globe': R(x + 10, y + 8, 4, 4, '#3f86c6'); R(x + 11, y + 9, 2, 1, '#2ecc71'); break;
        case 'paper': R(x + 10, y + 9, 4, 5, '#f2f2f2'); R(x + 11, y + 10, 2, 1, '#999'); R(x + 11, y + 12, 2, 1, '#999'); break;
        case 'phone': R(x + 9, y + 3, 2, 4, '#222'); R(x + 9, y + 4, 2, 2, '#9fb3ff'); break;
        case 'chain': R(x + 10, y + 9, 2, 2, '#c9ced8'); R(x + 12, y + 10, 2, 2, '#c9ced8'); break;
        case 'flag': R(x + 10, y + 6, 1, 8, '#888'); R(x + 11, y + 6, 4, 3, '#e74c3c'); R(x + 12, y + 7, 2, 1, '#fff'); break;
        case 'barrel': R(x + 10, y + 8, 4, 6, '#2c3e50'); R(x + 10, y + 9, 4, 1, '#f39c12'); R(x + 10, y + 12, 4, 1, '#f39c12'); break;
        case 'flask': R(x + 11, y + 8, 2, 2, '#c9ced8'); R(x + 10, y + 10, 4, 4, '#27ae60'); break;
        case 'scales': R(x + 12, y + 7, 1, 7, '#c9ced8'); R(x + 10, y + 8, 5, 1, '#c9ced8'); R(x + 10, y + 9, 1, 1, gold); R(x + 14, y + 9, 1, 1, gold); break;
        case 'magnifier': R(x + 10, y + 8, 3, 3, '#9fb3ff'); R(x + 13, y + 11, 2, 2, '#6b4423'); break;
        case 'book': R(x + 10, y + 9, 5, 4, '#8e44ad'); R(x + 10, y + 9, 1, 4, '#5b2c6f'); break;
        case 'cap': R(x + 1, y - 1, 8, 2, '#2c3e50'); R(x + 7, y + 1, 3, 1, '#2c3e50'); break;
        case 'laptop': R(x + 10, y + 10, 5, 3, '#888'); R(x + 11, y + 11, 3, 1, '#9fb3ff'); break;
        default: break;
      }
    }
    function desk(x, y, frame, tone, dim) {
      // two monitors with live-ish charts, then the desk top
      for (let m = 0; m < 2; m++) {
        const mx = x + m * 13;
        R(mx, y, 12, 9, PAL.monEdge); R(mx + 1, y + 1, 10, 7, dim ? '#11141c' : PAL.mon);
        if (!dim) {
          const col = (m === 0) === (tone >= 0) ? PAL.up : PAL.down;
          for (let i = 0; i < 8; i++) {
            const h = 1 + ((hash(String(x * 7 + y + m * 13 + i + Math.floor(frame / 3))) >> 3) % 5);
            R(mx + 2 + i, y + 7 - h, 1, h, col);
          }
        }
        R(mx + 5, y + 9, 2, 2, PAL.monEdge);
      }
      R(x - 3, y + 11, 31, 3, PAL.deskTop); R(x - 3, y + 14, 31, 2, PAL.desk); R(x - 3, y + 16, 31, 1, PAL.deskEdge);
      R(x - 2, y + 17, 2, 6, PAL.deskEdge); R(x + 24, y + 17, 2, 6, PAL.deskEdge);
    }

    function lookFor(role) {
      const h = hash(role.id);
      return { skin: SKIN[h % SKIN.length], hair: HAIR[(h >> 4) % HAIR.length], long: ((h >> 9) & 3) === 0,
        suit: shade(role.accent || '#888888', -0.45), tie: role.accent || PAL.gold, prop: PROP[role.id] || '' };
    }

    function frameDraw(ts) {
      if (!t0) t0 = ts;
      const frame = Math.floor((ts - t0) / 350);
      const st = data.state, sc = data.scores, roster = data.roster || [];
      const agents = (sc && sc.agents) || {};
      // which roles have a bot behind them (an agent id that starts with the role id, or equals it)
      // a seat is lit when a crew member of that role has a record, a ticket or a position — an agent id is the role id or '<role>-<n>'
      const active = new Set(Object.keys(agents));
      if (st) { for (const t of (st.tickets || [])) if (t.source === 'agent') active.add(t.agentId); for (const p of (st.positions || [])) active.add(p.agentId); }
      // an agent belongs at a role's desk when the roster says it holds that role, or its id is '<role>' / '<role>-<n>'
      const crew = data.crew || [];
      const roleOf = a => { const m = crew.find(x => x.agentId === a); return m && m.role ? m.role : ''; };
      for (const m of crew) if (m.role) active.add(m.agentId);
      const mine = id => Array.from(active).filter(a => a && (roleOf(a) === id || a === id || a.indexOf(id + '-') === 0));
      const hired = id => mine(id).length > 0;
      const RANK = { benched: 5, practice: 4, probation: 3, retrain: 2, review: 1, active: 0 };
      const levelOf = id => mine(id).map(a => agents[a] ? agents[a].status.level : '').sort((x, y) => (RANK[y] || 0) - (RANK[x] || 0))[0] || '';
      const halted = !!(st && st.halted && st.halted.on);
      // ---- room ----
      R(0, 0, W, H, PAL.wall);
      for (let y = TOP; y < H; y += 8) for (let x = 0; x < W; x += 8) R(x, y, 8, 8, ((x + y) / 8) % 2 ? PAL.floor : PAL.floor2);
      // ticker wall
      R(0, 0, W, 14, '#05070b'); R(0, 14, W, 1, PAL.trim);
      // alarm light
      const blink = halted && frame % 2;
      R(W / 2 - 6, 16, 12, 5, blink ? '#ff3b30' : halted ? '#8a1c15' : '#1f5f3a');
      // zones
      seats = [];
      for (const [dept, c, r] of ZONES) {
        const zx = c * ZW, zy = TOP + r * ZH;
        R(zx + 3, zy + 3, ZW - 6, ZH - 6, PAL.glass); R(zx + 3, zy + 3, ZW - 6, 1, PAL.trim); R(zx + 3, zy + ZH - 4, ZW - 6, 1, PAL.trim);
        const roles = roster.filter(x => x.dept === dept);
        roles.forEach((role, i) => {
          const col = i % 4, row = Math.floor(i / 4);
          const dx = zx + 12 + col * 37, dy = zy + 20 + row * 60;
          const on = hired(role.id);
          const tone = (hash(role.id) % 3) - 1;
          // chair, person, desk (front to back: chair behind the person, desk in front)
          R(dx + 6, dy + 2, 14, 16, PAL.chair);
          person(dx + 8, dy + 4, lookFor(role), frame + i, !on);
          desk(dx, dy + 18, frame + i, tone, !on);
          const lvl = levelOf(role.id);
          if (lvl && LEVEL_COL[lvl]) { R(dx + 21, dy + 1, 5, 5, LEVEL_COL[lvl]); R(dx + 22, dy + 2, 3, 3, shade(LEVEL_COL[lvl], 0.4)); }
          seats.push({ role, x: dx - 3, y: dy, w: 31, h: 44, on, lvl, zx, zy });
        });
      }
      // the Commander's desk + the P&L board (8th cell)
      const cx = 3 * ZW, cy = TOP + ZH;
      R(cx + 3, cy + 3, ZW - 6, ZH - 6, 'rgba(245,190,50,0.06)'); R(cx + 3, cy + 3, ZW - 6, 1, PAL.goldDim);
      R(cx + 20, cy + 16, 120, 44, '#05070b'); R(cx + 20, cy + 16, 120, 1, PAL.goldDim); R(cx + 20, cy + 59, 120, 1, PAL.goldDim);
      const pend = st ? (st.pending || []).length : 0;
      desk(cx + 66, cy + 92, frame, 1, false);
      R(cx + 72, cy + 74, 14, 16, PAL.chair);
      person(cx + 74, cy + 76, { skin: SKIN[1], hair: HAIR[0], suit: '#1c1c22', tie: PAL.gold, prop: 'crown' }, frame, false);
      R(cx + 100, cy + 100, 5, 5, pend ? (frame % 2 ? PAL.gold : PAL.goldDim) : '#333');
      // ---- scale up, crisp ----
      const dpr = Math.max(1, root.devicePixelRatio || 1);
      const CW = canvas.clientWidth || 1280, CH = Math.round(CW * H / W);
      if (canvas.width !== Math.round(CW * dpr)) { canvas.width = Math.round(CW * dpr); canvas.height = Math.round(CH * dpr); canvas.style.height = CH + 'px'; }
      const s = canvas.width / W;
      out.imageSmoothingEnabled = false;
      out.setTransform(1, 0, 0, 1, 0, 0);
      out.drawImage(px, 0, 0, canvas.width, canvas.height);
      // ---- text overlays at full resolution ----
      out.setTransform(s, 0, 0, s, 0, 0);
      out.textBaseline = 'middle';
      // ticker
      out.font = "10px 'VT323','Courier New',monospace";
      const quotes = st ? Object.entries(st.quotes || {}) : [];
      const tape = quotes.map(([k, q]) => k + ' ' + q.bid).join('    ') + '    ';
      const tapeW = out.measureText(tape).width || 1;
      const off = ((ts - t0) / 40) % tapeW;
      out.save(); out.beginPath(); out.rect(0, 0, W, 14); out.clip();
      for (let x = -off; x < W; x += tapeW) {
        let pos = x;
        for (const [k, q] of quotes) {
          out.fillStyle = PAL.gold; out.fillText(k, pos, 7); pos += out.measureText(k + ' ').width;
          out.fillStyle = PAL.text; out.fillText(String(q.bid), pos, 7); pos += out.measureText(String(q.bid) + '    ').width;
        }
      }
      out.restore();
      if (st && st.feed && st.feed.simulated) { out.font = "8px 'VT323','Courier New',monospace"; out.fillStyle = PAL.gold; out.fillText('SIMULATED', W - 52, 25); }
      out.font = "8px 'VT323','Courier New',monospace"; out.fillStyle = halted ? '#ff8c80' : '#6fd29a';
      out.fillText(halted ? 'TRADING HALTED' : 'MARKETS OPEN', W / 2 + 10, 19);
      // zone labels + names
      for (const [dept, c, r] of ZONES) { out.font = "8px 'VT323','Courier New',monospace"; out.fillStyle = PAL.gold; out.fillText(dept.toUpperCase(), c * ZW + 8, TOP + r * ZH + 10); }
      out.font = "7px 'VT323','Courier New',monospace";
      for (const sAt of seats) {
        out.fillStyle = sAt.on ? PAL.text : '#5d6474';
        // two short lines that always fit the 31px desk: "Chief Investment Officer" -> "Chief" / "Investment"
        const words = sAt.role.name.split(' '), lines = ['', ''];
        for (const w of words) { const i = lines[0] && (lines[0] + ' ' + w).length > 11 ? 1 : 0; if (i === 1 && lines[1] && (lines[1] + ' ' + w).length > 11) break; lines[i] = (lines[i] ? lines[i] + ' ' : '') + w; }
        out.fillText(lines[0].slice(0, 12), sAt.x, sAt.y + 48);
        if (lines[1]) out.fillText(lines[1].slice(0, 12), sAt.x, sAt.y + 53);
        if (sAt.lvl && LEVEL_COL[sAt.lvl]) { out.fillStyle = LEVEL_COL[sAt.lvl]; out.font = "7px 'VT323','Courier New',monospace"; out.fillText(sAt.lvl.toUpperCase(), sAt.x, sAt.y + 58); out.font = "7px 'VT323','Courier New',monospace"; }
      }
      // board
      out.font = "8px 'VT323','Courier New',monospace"; out.fillStyle = PAL.gold; out.fillText('YOUR DESK — PAPER ACCOUNT', cx + 10, cy + 10);
      if (st) {
        const a = st.account;
        out.font = "13px 'VT323','Courier New',monospace"; out.fillStyle = PAL.text; out.fillText((a.accountCcy || '') + ' ' + Number(a.equity).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }), cx + 26, cy + 28);
        out.font = "10px 'VT323','Courier New',monospace"; out.fillStyle = a.dayPnl >= 0 ? PAL.up : PAL.down;
        out.fillText('TODAY ' + (a.dayPnl >= 0 ? '+' : '') + Number(a.dayPnl).toFixed(2), cx + 26, cy + 40);
        out.fillStyle = PAL.text; out.font = "8px 'VT323','Courier New',monospace";
        out.fillText(a.openPositions + ' open · ' + (sc && sc.overall ? sc.overall.n : 0) + ' closed trades', cx + 26, cy + 51);
        out.fillStyle = pend ? PAL.gold : '#6b7280'; out.fillText(pend ? pend + ' WAITING' : 'all clear', cx + 108, cy + 103);
      }
      out.font = "8px 'VT323','Courier New',monospace"; out.fillStyle = PAL.gold; out.fillText('THE COMMANDER', cx + 64, cy + 128);
      // hover card
      if (hover) {
        const sAt = seats.find(x => hover.x >= x.x && hover.x <= x.x + x.w && hover.y >= x.y && hover.y <= x.y + x.h);
        if (sAt) {
          const bx = Math.min(W - 150, sAt.x + 24), by = Math.max(18, sAt.y - 6);
          out.fillStyle = 'rgba(5,7,11,0.95)'; out.fillRect(bx, by, 146, 30); out.strokeStyle = PAL.gold; out.lineWidth = 0.5; out.strokeRect(bx, by, 146, 30);
          out.font = "8px 'VT323','Courier New',monospace"; out.fillStyle = PAL.gold; out.fillText(sAt.role.name, bx + 4, by + 7);
          out.font = "7px 'VT323','Courier New',monospace"; out.fillStyle = PAL.text; out.fillText(String(sAt.role.tagline || '').slice(0, 44), bx + 4, by + 15);
          out.fillStyle = '#9aa3b5'; out.fillText((sAt.on ? 'On the floor' : 'Seat open — recruit from CREW') + (sAt.role.aiHint ? ' · suits ' + sAt.role.aiHint : ''), bx + 4, by + 23);
        }
      }
      raf = root.requestAnimationFrame(frameDraw);
    }
    const onMove = e => { const r = canvas.getBoundingClientRect(); hover = { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }; };
    const onLeave = () => { hover = null; };
    canvas.addEventListener('mousemove', onMove); canvas.addEventListener('mouseleave', onLeave);
    raf = root.requestAnimationFrame(frameDraw);
    return {
      set(d) { data = Object.assign({}, data, d || {}); },
      destroy() { root.cancelAnimationFrame(raf); canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); }
    };
  }

  const api = { create, W, H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TradingFloor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
