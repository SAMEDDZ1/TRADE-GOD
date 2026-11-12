/* node test/trading.journal.test.js — the hash-chained journal notices a quiet edit. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), path = require('path'), os = require('os');
const J = require('../sidecar/trading/journal.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-journal-'));
const file = path.join(dir, 'nested', 'journal.jsonl');
try {
  const j = J.create({ fs, path, file });
  A.eq(j.verify(), { ok: true, entries: 0 }, 'an empty journal verifies');
  A.eq(j.read(), [], 'and reads as empty');
  const a = j.append('ticket.proposed', { id: 'K1', symbol: 'XAUUSD' }, 1000);
  const b = j.append('position.opened', { id: 'P1', entry: 2650.3 }, 2000);
  const c = j.append('position.closed', { id: 'T1', pnl: 197 }, 3000);
  A.eq([a.seq, b.seq, c.seq], [1, 2, 3], 'entries are numbered');
  A.eq(a.prev, J.GENESIS, 'the first entry links to the genesis hash');
  A.eq([b.prev, c.prev], [a.hash, b.hash], 'each entry links to the one before');
  A.ok(/^[0-9a-f]{64}$/.test(c.hash), 'hashes are SHA-256');
  A.eq(j.verify(), { ok: true, entries: 3 }, 'an untouched journal verifies');
  A.eq(j.read({ limit: 2 }).map(e => e.seq), [2, 3], 'limit returns the latest');
  A.eq(j.read({ type: 'position' }).map(e => e.type), ['position.opened', 'position.closed'], 'filtering by a type prefix');
  A.eq(j.read({ type: 'ticket.proposed' }).length, 1, 'filtering by an exact type');

  // a second handle (a restart) continues the SAME chain
  const j2 = J.create({ fs, path, file });
  const d = j2.append('halt.on', { reason: 'drill' }, 4000);
  A.eq([d.seq, d.prev], [4, c.hash], 'after a restart the chain continues from the last entry');
  A.eq(j2.verify(), { ok: true, entries: 4 }, 'and still verifies');

  const original = fs.readFileSync(file, 'utf8');
  const lines = original.trim().split('\n');
  // 1. quietly improve a losing trade
  const edited = lines.slice(); edited[2] = edited[2].replace('"pnl":197', '"pnl":997');
  fs.writeFileSync(file, edited.join('\n') + '\n');
  let v = j2.verify();
  A.eq([v.ok, v.brokenAt], [false, 3], 'editing one entry is caught, at that entry');
  A.ok(/changed after it was written/.test(v.reason), 'and says what happened: ' + v.reason);
  // 2. delete an inconvenient line
  fs.writeFileSync(file, [lines[0], lines[2], lines[3]].join('\n') + '\n');
  v = j2.verify();
  A.eq([v.ok, v.brokenAt], [false, 3], 'removing an entry breaks the chain where it was');
  // 3. reorder
  fs.writeFileSync(file, [lines[1], lines[0], lines[2], lines[3]].join('\n') + '\n');
  A.eq(j2.verify().ok, false, 'reordering is caught');
  // 4. a torn / garbage line
  fs.writeFileSync(file, lines[0] + '\n{not json\n');
  v = j2.verify();
  A.eq([v.ok, v.brokenAt], [false, 2], 'a corrupt line is reported, not skipped');
  // restored -> verifies again
  fs.writeFileSync(file, original);
  A.eq(j2.verify(), { ok: true, entries: 4 }, 'the original file verifies again');

  // canonical form: key order does not change the hash
  A.eq(J.canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), J.canonical({ a: [2, { c: 2, d: 1 }], b: 1 }), 'canonical JSON is key-order independent');
  // the module exposes NO way to rewrite or remove an entry
  A.eq(Object.keys(j).sort(), ['append', 'file', 'read', 'verify'], 'append-only by construction');
  if (process.platform !== 'win32') A.eq(fs.statSync(file).mode & 0o077, 0, 'the journal file is private to the user (0600)');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
A.report('trading.journal');
