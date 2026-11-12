/* sidecar/trading/journal.js — the tamper-evident trade journal.

   Every event that matters to money is appended here as one JSON line: a ticket proposed, vetoed, approved or
   executed; a fill; a close; a kill switch; a risk-policy change; a Coach action. Each line carries the SHA-256
   of the line before it, so the journal is a hash chain: change, delete or reorder one past line and verify()
   reports exactly where the chain breaks. The journal is append-only by construction — this module has no
   function that rewrites or removes an entry.

   This is evidence for the Auditor and the Commander, not a security boundary against someone who owns the
   machine: a person who can rewrite the whole file can also recompute the chain. What it does catch is the
   quiet edit of one inconvenient line, and accidental corruption.

   Line shape: { seq, ts, type, data, prev, hash }   hash = sha256(prev + '\n' + canonical({seq, ts, type, data}))

   Unit-tested in test/trading.journal.test.js. */
'use strict';
const crypto = require('node:crypto');

const GENESIS = '0'.repeat(64);
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function hashOf(prev, body) { return crypto.createHash('sha256').update(prev + '\n' + canonical(body)).digest('hex'); }

function create(deps) {
  const { fs, path, file } = deps;
  let seq = 0, prev = GENESIS, loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code !== 'ENOENT') throw e; return; }
    const lines = text.split('\n').filter(Boolean);
    if (!lines.length) return;
    try { const last = JSON.parse(lines[lines.length - 1]); seq = Number(last.seq) || lines.length; prev = String(last.hash || GENESIS); }
    catch (_) { seq = lines.length; }   // a torn last line: keep appending; verify() will report it
  }
  function append(type, data, ts) {
    load();
    const body = { seq: seq + 1, ts: Number(ts) || 0, type: String(type), data: data === undefined ? null : data };
    const link = prev, hash = hashOf(link, body);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(Object.assign({}, body, { prev: link, hash })) + '\n', { mode: 0o600 });
    seq = body.seq; prev = hash;
    return Object.assign({}, body, { prev: link, hash });
  }
  function read(opts) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code !== 'ENOENT') throw e; return []; }
    const out = [];
    for (const l of text.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch (_) { out.push({ corrupt: true, raw: l.slice(0, 200) }); } }
    const o = opts || {};
    const filtered = o.type ? out.filter(e => e.type === o.type || String(e.type || '').indexOf(o.type + '.') === 0) : out;
    return o.limit > 0 ? filtered.slice(-o.limit) : filtered;
  }
  // walk the whole chain. { ok, entries, brokenAt?: seq-or-line-number, reason? }
  function verify() {
    const all = read();
    let p = GENESIS;
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (e.corrupt) return { ok: false, entries: all.length, brokenAt: i + 1, reason: 'line ' + (i + 1) + ' is not valid JSON' };
      if (e.prev !== p) return { ok: false, entries: all.length, brokenAt: e.seq || i + 1, reason: 'entry ' + (e.seq || i + 1) + ' does not link to the entry before it' };
      if (e.seq !== i + 1) return { ok: false, entries: all.length, brokenAt: e.seq || i + 1, reason: 'entry ' + (i + 1) + ' is out of sequence (an entry was removed or reordered)' };
      const h = hashOf(p, { seq: e.seq, ts: e.ts, type: e.type, data: e.data });
      if (h !== e.hash) return { ok: false, entries: all.length, brokenAt: e.seq, reason: 'entry ' + e.seq + ' was changed after it was written' };
      p = e.hash;
    }
    return { ok: true, entries: all.length };
  }
  return { append, read, verify, file };
}

module.exports = { create, canonical, GENESIS };
