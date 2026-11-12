/* node test/trading.phone.test.js — the trading desk from the phone: /trades /approve /reject /halt through the REAL
   channel hub, owner-only, against a REAL desk. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), path = require('path'), os = require('os');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { createService } = require('../sidecar/trading/service.js');
const { readSidecarSource } = require('./helpers/source');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-phone-'));
let clock = Date.UTC(2026, 10, 11, 15, 0, 0);
const desk = createService({ fs, path, dir, now: () => clock });
desk.tick('XAUUSD', 2650, 2650.3); desk.tick('EURUSD', 1.08, 1.0801);

function fakeStore() {
  const hist = new Map(), recs = new Map();
  return { loadHistory(a) { return (hist.get(a) || []).slice(); }, appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    clearHistory(a) { const n = (hist.get(a) || []).length; hist.delete(a); return n; }, getChatRecord(c) { return recs.get(String(c)); },
    saveChatRecord(c, patch) { const m = Object.assign({}, recs.get(String(c)), patch); recs.set(String(c), m); return m; } };
}
function build(trading) {
  const sends = [], runs = [];
  let ids = 0;
  const hub = makeChannelHub({
    channel: 'telegram', store: fakeStore(),
    runOnce: async (o) => { runs.push(o); o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); },
    send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'agent' }), classify: () => false, newId: () => 'r' + (++ids),
    isOwner: (m) => String(m.userId) === 'boss', ownerTrusted: (m) => String(m.userId) === 'boss' && m.chatType === 'dm',
    trading
  });
  return { hub, sends, runs };
}
let n = 0;
const msg = (userId, text, chatType) => ({ channel: 'telegram', chatId: chatType === 'group' ? '-100' : 'c-' + userId, chatType: chatType || 'dm', userId, text, messageId: 'm' + (++n), ts: 1 });

(async () => {
  try {
    const t = build(() => desk);
    // a crew idea waiting for the Commander
    const k = desk.propose({ source: 'agent', agentId: 'metals-1', symbol: 'XAUUSD', side: 'buy', stop: 2640, takeProfit: 2680, thesis: 'breakout over 2650 with the dollar soft' });
    desk.argue(k.id, { role: 'bull', text: 'for' }); desk.argue(k.id, { role: 'bear', text: 'against' });
    A.eq(desk.ticket(k.id).status, 'awaiting-approval', 'a ticket waits for the Commander');

    // ---- strangers get nothing ----
    for (const text of ['/trades', '/approve ' + k.id, '/reject ' + k.id, '/halt']) await t.hub.onInbound(msg('stranger', text, 'group'));
    A.eq(t.sends.length, 4, 'every stranger command got one reply');
    A.ok(t.sends.every(s => /owner-only/.test(s)), 'each one is the owner-only refusal');
    A.ok(t.sends.every(s => s.indexOf(k.id) < 0 && s.indexOf('XAUUSD') < 0), 'no account or ticket detail leaks to a stranger');
    A.eq([desk.ticket(k.id).status, desk.halted().on], ['awaiting-approval', false], 'nothing changed: the ticket still waits, no kill switch');
    A.eq(t.runs.length, 0, 'no command spent a model run');

    // ---- the owner ----
    t.sends.length = 0;
    await t.hub.onInbound(msg('boss', '/trades'));
    A.ok(/PAPER ACCOUNT USD 10,?000\.00|PAPER ACCOUNT USD 9/.test(t.sends[0]), '/trades shows the paper account: ' + t.sends[0].split('\n')[0]);
    A.ok(t.sends[0].indexOf(k.id + ' BUY XAUUSD') >= 0 && t.sends[0].indexOf('/approve ' + k.id) >= 0, '/trades lists the waiting ticket with its approve command');
    A.ok(/why: breakout/.test(t.sends[0]), 'and the reason');
    await t.hub.onInbound(msg('boss', '/approve'));
    A.ok(/Which ticket\?/.test(t.sends[1]), '/approve with no ticket asks which');
    await t.hub.onInbound(msg('boss', '/approve k999'));
    A.ok(/K999: no such ticket/.test(t.sends[2]), 'an unknown ticket is said plainly');
    await t.hub.onInbound(msg('boss', '/approve ' + k.id.toLowerCase()));
    A.ok(/approved and filled on the PAPER account/.test(t.sends[3]), 'the owner approves from the phone: ' + t.sends[3]);
    A.eq([desk.ticket(k.id).status, desk.ticket(k.id).decision.by, desk.snapshot().positions.length], ['executed', 'commander', 1], 'the ticket executed on paper, decided by the Commander');
    await t.hub.onInbound(msg('boss', '/approve ' + k.id));
    A.ok(/not waiting for approval/.test(t.sends[4]), 'a ticket cannot be approved twice');

    const k2 = desk.propose({ source: 'agent', agentId: 'forex-1', symbol: 'EURUSD', side: 'sell', stop: 1.085, thesis: 'x' });
    desk.argue(k2.id, { role: 'bull', text: 'a' }); desk.argue(k2.id, { role: 'bear', text: 'b' });
    await t.hub.onInbound(msg('boss', '/reject ' + k2.id));
    A.ok(/rejected/.test(t.sends[5]), '/reject');
    A.eq(desk.ticket(k2.id).status, 'rejected', 'the ticket is rejected');

    await t.hub.onInbound(msg('boss', '/halt'));
    A.ok(/KILL SWITCH ON\. Closed 1 paper position/.test(t.sends[6]), '/halt flattens the account: ' + t.sends[6]);
    A.eq([desk.halted().on, desk.snapshot().positions.length], [true, 0], 'the kill switch is on and the account is flat');
    A.ok(desk.journal({ type: 'halt' }).some(e => e.type === 'halt.on' && /telegram/.test(e.data.reason)), 'the journal says the kill switch came from Telegram');

    // ---- a hub with no desk says so ----
    const none = build(null);
    await none.hub.onInbound(msg('boss', '/trades'));
    A.ok(/not available/.test(none.sends[0]), 'no desk -> a plain answer');

    // ---- the phone ping is wired through the outbound contract, owner-only ----
    const src = readSidecarSource();
    A.ok(/channelOutbound\.send\(\{ channel: 'telegram', chatId: ownerChat \}/.test(src), 'phone pings go through the ONE outbound contract');
    A.ok(/channelSecrets\.telegram\.ownerId/.test(src), 'and only to the paired owner');
    A.ok(/e\.type === 'ticket\.awaiting-approval'/.test(src) && /e\.type === 'halt\.on'/.test(src), 'for tickets that need the Commander and for the kill switch');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  A.report('trading.phone');
})().catch(e => { console.log('FAIL: trading.phone threw — ' + (e && e.stack || e)); process.exit(1); });
