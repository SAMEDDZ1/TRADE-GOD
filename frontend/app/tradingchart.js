/* frontend/app/tradingchart.js — TRADE GOD's candlestick chart, drawn on a plain <canvas>.

   No library: the desktop app ships offline and every byte it loads is our own. Draws candles, a price axis, a time
   axis, the live bid line, and the lines a trader needs on the chart: each open position's ENTRY, STOP and TARGET.
   A crosshair follows the mouse and reports the bar under it. Pure drawing — it never fetches; the trading window
   hands it candles and levels.

   API:  const ch = TradingChart.create(canvas)
         ch.set({ candles:[{t,o,h,l,c}], levels:[{price, label, kind:'entry'|'stop'|'target'|'bid'}], digits, simulated })
         ch.resize(); ch.destroy() */
'use strict';
(function (root) {
  const COL = {
    bg: '#0d1018', grid: 'rgba(255,255,255,0.06)', axis: '#7d8698', up: '#2ecc71', down: '#e74c3c',
    entry: '#f5be32', stop: '#ff5a4e', target: '#36d399', bid: '#9fb3ff', cross: 'rgba(255,255,255,0.35)', text: '#c9d1e0'
  };
  function create(canvas) {
    const ctx = canvas.getContext('2d');
    let data = { candles: [], levels: [], digits: 2, simulated: false };
    let mouse = null;
    const PAD_R = 70, PAD_B = 22, PAD_T = 8;

    function fmt(p) { return Number(p).toFixed(data.digits); }
    function draw() {
      const dpr = Math.max(1, root.devicePixelRatio || 1);
      const W = canvas.clientWidth || 600, H = canvas.clientHeight || 300;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
      const cs = data.candles || [];
      if (!cs.length) { ctx.fillStyle = COL.axis; ctx.font = "16px 'VT323','Courier New',monospace"; ctx.fillText('No price data yet', 12, 20); return; }
      const plotW = W - PAD_R, plotH = H - PAD_B - PAD_T;
      const slot = Math.max(3, Math.min(14, plotW / cs.length));
      const n = Math.min(cs.length, Math.floor(plotW / slot));
      const view = cs.slice(cs.length - n);
      let lo = Infinity, hi = -Infinity;
      for (const k of view) { if (k.l < lo) lo = k.l; if (k.h > hi) hi = k.h; }
      for (const L of (data.levels || [])) if (L.price > 0 && L.kind !== 'bid') { if (L.price < lo) lo = L.price; if (L.price > hi) hi = L.price; }
      const span = (hi - lo) || hi * 0.01 || 1; lo -= span * 0.06; hi += span * 0.06;
      const y = p => PAD_T + (hi - p) / (hi - lo) * plotH;
      const x = i => (i + 0.5) * slot;
      // grid + price axis
      ctx.font = "15px 'VT323','Courier New',monospace"; ctx.textBaseline = 'middle';
      for (let g = 0; g <= 5; g++) {
        const p = lo + (hi - lo) * g / 5, yy = Math.round(y(p)) + 0.5;
        ctx.strokeStyle = COL.grid; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
        ctx.fillStyle = COL.axis; ctx.fillText(fmt(p), plotW + 6, yy);
      }
      // time axis
      ctx.textBaseline = 'alphabetic';
      const every = Math.max(1, Math.round(n / 6));
      for (let i = 0; i < n; i += every) {
        const d = new Date(view[i].t);
        const lab = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        ctx.fillStyle = COL.axis; ctx.fillText(lab, Math.max(0, x(i) - 30), H - 6);
      }
      // candles
      const bw = Math.max(1, slot * 0.66);
      for (let i = 0; i < n; i++) {
        const k = view[i], up = k.c >= k.o;
        ctx.strokeStyle = ctx.fillStyle = up ? COL.up : COL.down;
        const cx = Math.round(x(i)) + 0.5;
        ctx.beginPath(); ctx.moveTo(cx, y(k.h)); ctx.lineTo(cx, y(k.l)); ctx.stroke();
        const top = y(Math.max(k.o, k.c)), bot = y(Math.min(k.o, k.c));
        ctx.fillRect(Math.round(x(i) - bw / 2), top, Math.round(bw), Math.max(1, bot - top));
      }
      // levels
      for (const L of (data.levels || [])) {
        if (!(L.price > 0) || L.price < lo || L.price > hi) continue;
        const yy = Math.round(y(L.price)) + 0.5, c = COL[L.kind] || COL.text;
        ctx.strokeStyle = c; ctx.setLineDash(L.kind === 'bid' ? [] : [6, 4]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = c; ctx.fillRect(plotW, yy - 8, PAD_R, 16);
        ctx.fillStyle = '#0d1018'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(L.price), plotW + 4, yy);
        if (L.label) { ctx.fillStyle = c; ctx.textBaseline = 'bottom'; ctx.fillText(L.label, 6, yy - 2); }
      }
      // crosshair
      if (mouse && mouse.x < plotW) {
        const i = Math.min(n - 1, Math.max(0, Math.floor(mouse.x / slot))), k = view[i];
        ctx.strokeStyle = COL.cross; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x(i), PAD_T); ctx.lineTo(x(i), PAD_T + plotH); ctx.moveTo(0, mouse.y); ctx.lineTo(plotW, mouse.y); ctx.stroke(); ctx.setLineDash([]);
        const p = hi - (mouse.y - PAD_T) / plotH * (hi - lo);
        ctx.fillStyle = COL.cross; ctx.fillRect(plotW, mouse.y - 8, PAD_R, 16);
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(p), plotW + 4, mouse.y);
        ctx.fillStyle = COL.text; ctx.textBaseline = 'top';
        ctx.fillText('O ' + fmt(k.o) + '  H ' + fmt(k.h) + '  L ' + fmt(k.l) + '  C ' + fmt(k.c), 6, PAD_T + 2);
      }
      if (data.simulated) {
        ctx.font = "15px 'VT323','Courier New',monospace"; ctx.fillStyle = 'rgba(245,190,50,0.85)'; ctx.textBaseline = 'top';
        ctx.fillText('SIMULATED PRICES', plotW - 130, PAD_T + 2);
      }
    }
    const onMove = e => { const r = canvas.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; draw(); };
    const onLeave = () => { mouse = null; draw(); };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    return {
      set(d) { data = Object.assign({ candles: [], levels: [], digits: 2, simulated: false }, d || {}); draw(); },
      resize: draw,
      destroy() { canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); }
    };
  }

  // a tiny line chart for equity curves: [{t, equity}]
  function line(canvas, points, opts) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.max(1, root.devicePixelRatio || 1);
    const W = canvas.clientWidth || 500, H = canvas.clientHeight || 160;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
    const pts = (points || []).filter(p => Number.isFinite(p.equity));
    if (pts.length < 2) return;
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { if (p.equity < lo) lo = p.equity; if (p.equity > hi) hi = p.equity; }
    const base = opts && opts.base;
    if (base > 0) { lo = Math.min(lo, base); hi = Math.max(hi, base); }
    const span = (hi - lo) || 1;
    const X = i => 8 + i / (pts.length - 1) * (W - 70), Y = v => 8 + (hi - v) / span * (H - 24);
    if (base > 0) { ctx.strokeStyle = COL.grid; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(8, Y(base)); ctx.lineTo(W - 62, Y(base)); ctx.stroke(); ctx.setLineDash([]); }
    ctx.strokeStyle = pts[pts.length - 1].equity >= (base || pts[0].equity) ? COL.up : COL.down; ctx.lineWidth = 1.5;
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.equity)) : ctx.moveTo(X(i), Y(p.equity))); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = COL.axis; ctx.font = "15px 'VT323','Courier New',monospace"; ctx.textBaseline = 'middle';
    ctx.fillText(hi.toFixed(0), W - 58, 10); ctx.fillText(lo.toFixed(0), W - 58, H - 16);
  }

  const api = { create, line };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TradingChart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
