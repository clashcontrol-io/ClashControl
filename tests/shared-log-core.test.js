'use strict';
// shared-log-core.js (docs/INTERNALS.md §21.55): the shared-folder change log.
// Conflicts are decided by the change graph (base / resolves), never by time.
const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../shared-log-core.js');

// A client: its own log, its own id counter, edits built on what it has read.
function client(user) {
  const log = L.createLog();
  let n = 0;
  return {
    user, log,
    edit(kind, key, field, value, ts, prev) {
      const r = L.makeChange(log, { id: user + '-' + (++n), user, ts, kind, key, field, value, prev });
      L.addChanges(log, [r]);
      return r;
    },
    resolve(kind, key, field, value, ts) {
      const r = L.makeResolution(log, { id: user + '-' + (++n), user, ts, kind, key, field, value });
      L.addChanges(log, [r]);
      return r;
    },
    read(recs) { return L.addChanges(log, recs); },
    st(kind, key, field) { return L.fieldState(log, L.groupKey(kind, key, field)); },
  };
}
const K = ['clash', 'A|B@1,2,3'];

test('sequential edits never conflict, however close in time', () => {
  const a = client('alice'), b = client('bob');
  const r1 = a.edit(...K, 'status', 'in_progress', 1000, 'open');
  b.read([r1]);
  const r2 = b.edit(...K, 'status', 'resolved', 1001); // 1 ms later, after seeing r1
  assert.strictEqual(r2.base, r1.id);
  a.read([r2]);
  for (const c of [a, b]) {
    const s = c.st(...K, 'status');
    assert.strictEqual(s.conflicted, false);
    assert.strictEqual(s.value, 'resolved');
  }
  assert.strictEqual(L.digest(a.log), L.digest(b.log));
});

test('concurrent edits on the same base conflict for BOTH sides, whatever the time gap', () => {
  for (const gap of [1, 60_000, 30 * 24 * 3600_000]) {
    const a = client('alice'), b = client('bob');
    const r0 = a.edit(...K, 'status', 'in_progress', 1000, 'open');
    b.read([r0]);
    const ra = a.edit(...K, 'status', 'resolved', 2000);
    const rb = b.edit(...K, 'status', 'denied', 2000 + gap);
    assert.strictEqual(ra.base, r0.id); assert.strictEqual(rb.base, r0.id);
    a.read([rb]); b.read([ra]);
    for (const c of [a, b]) {
      const s = c.st(...K, 'status');
      assert.strictEqual(s.conflicted, true, 'gap ' + gap);
      assert.strictEqual(s.value, 'in_progress', 'keeps the last agreed value');
      assert.deepStrictEqual(s.heads.map((h) => h.value).sort(), ['denied', 'resolved']);
      assert.strictEqual(s.agreed.id, r0.id);
    }
    assert.strictEqual(L.digest(a.log), L.digest(b.log));
  }
});

test('first edits with no shared history conflict too; the agreed value is what the authors saw', () => {
  const a = client('alice'), b = client('bob');
  const ra = a.edit(...K, 'assignee', 'Ann', 10, '');
  const rb = b.edit(...K, 'assignee', 'Ben', 5_000_000, '');
  a.read([rb]); b.read([ra]);
  const s = a.st(...K, 'assignee');
  assert.ok(s.conflicted);
  assert.strictEqual(s.value, '');
  assert.strictEqual(s.known, true);
});

test('the same value chosen concurrently is not a conflict; the next edit folds both heads in', () => {
  const a = client('alice'), b = client('bob');
  const ra = a.edit(...K, 'status', 'resolved', 1, 'open');
  const rb = b.edit(...K, 'status', 'resolved', 2, 'open');
  a.read([rb]); b.read([ra]);
  assert.strictEqual(a.st(...K, 'status').conflicted, false);
  const r3 = a.edit(...K, 'status', 'closed', 3);
  b.read([r3]);
  const s = b.st(...K, 'status');
  assert.strictEqual(s.conflicted, false);
  assert.strictEqual(s.value, 'closed');
  assert.strictEqual(s.heads.length, 1);
});

test('a resolution clears the conflict for everyone; history keeps every change', () => {
  const a = client('alice'), b = client('bob'), c = client('carol');
  const r0 = a.edit(...K, 'status', 'in_progress', 1, 'open');
  b.read([r0]); c.read([r0]);
  const ra = a.edit(...K, 'status', 'resolved', 2);
  const rb = b.edit(...K, 'status', 'denied', 3);
  for (const x of [a, b, c]) x.read([ra, rb]);
  assert.ok(c.st(...K, 'status').conflicted);
  const res = c.resolve(...K, 'status', 'denied', 4);
  assert.deepStrictEqual(res.resolves.sort(), [ra.id, rb.id].sort());
  assert.strictEqual(res.base, r0.id);
  a.read([res]); b.read([res]);
  for (const x of [a, b, c]) {
    const s = x.st(...K, 'status');
    assert.strictEqual(s.conflicted, false);
    assert.strictEqual(s.value, 'denied');
    assert.strictEqual(x.log.size, 4, 'nothing dropped from the history');
  }
  // a NEW value can be entered as the resolution as well
  const a2 = client('a2'), b2 = client('b2');
  const x1 = a2.edit(...K, 'priority', 'high', 1, 'normal'), x2 = b2.edit(...K, 'priority', 'low', 1, 'normal');
  a2.read([x2]);
  a2.resolve(...K, 'priority', 'critical', 2);
  assert.strictEqual(a2.st(...K, 'priority').value, 'critical');
  assert.strictEqual(a2.st(...K, 'priority').conflicted, false);
  assert.ok(x1 && x2);
});

test('two concurrent different resolutions are a new conflict by the same rule', () => {
  const a = client('alice'), b = client('bob');
  const r0 = a.edit(...K, 'status', 'in_progress', 1, 'open');
  b.read([r0]);
  const ra = a.edit(...K, 'status', 'resolved', 2), rb = b.edit(...K, 'status', 'denied', 3);
  a.read([rb]); b.read([ra]);
  const sa = a.resolve(...K, 'status', 'resolved', 4), sb = b.resolve(...K, 'status', 'closed', 5);
  a.read([sb]); b.read([sa]);
  for (const x of [a, b]) {
    const s = x.st(...K, 'status');
    assert.strictEqual(s.conflicted, true);
    assert.deepStrictEqual(s.heads.map((h) => h.id).sort(), [sa.id, sb.id].sort());
    assert.strictEqual(s.value, 'in_progress', 'falls back to the version both resolutions started from');
  }
  // the same resolution twice is agreement, not a conflict
  const c = client('c'), d = client('d');
  const q0 = c.edit(...K, 'status', 'a', 1, 'open'); d.read([q0]);
  const qc = c.edit(...K, 'status', 'b', 2), qd = d.edit(...K, 'status', 'c', 2);
  c.read([qd]); d.read([qc]);
  const zc = c.resolve(...K, 'status', 'b', 3), zd = d.resolve(...K, 'status', 'b', 3);
  c.read([zd]); d.read([zc]);
  assert.strictEqual(c.st(...K, 'status').conflicted, false);
});

test('an ordinary edit of a conflicted field joins the conflict (only a resolution clears it)', () => {
  const a = client('alice'), b = client('bob');
  const r0 = a.edit(...K, 'status', 'open', 1, 'open');
  b.read([r0]);
  const ra = a.edit(...K, 'status', 'resolved', 2), rb = b.edit(...K, 'status', 'denied', 3);
  a.read([rb]); b.read([ra]);
  const r3 = a.edit(...K, 'status', 'closed', 4);
  assert.strictEqual(r3.base, r0.id);
  const s = a.st(...K, 'status');
  assert.ok(s.conflicted);
  assert.strictEqual(s.heads.length, 3);
});

test('changes arriving in any order (base not read yet) give the same state', () => {
  const a = client('alice'), b = client('bob');
  const r1 = a.edit(...K, 'status', 'x', 1, 'open'); b.read([r1]);
  const r2 = b.edit(...K, 'status', 'y', 2); a.read([r2]);
  const r3 = a.edit(...K, 'status', 'z', 3);
  const late = L.createLog();
  L.addChanges(late, [r3]);
  L.addChanges(late, [r2]);
  L.addChanges(late, [r1]);
  assert.strictEqual(L.digest(late), L.digest(a.log));
  assert.strictEqual(L.fieldState(late, L.groupKey(...K, 'status')).value, 'z');
});

test('malformed records are dropped, never thrown on; ids are idempotent', () => {
  const log = L.createLog();
  const r = L.addChanges(log, [null, {}, { id: 'x' }, { id: 'ok', user: 'u', ts: 1, target: { kind: 'clash', key: 'k' }, field: 'status', value: 'a', base: null },
    { id: 'ok', user: 'u', ts: 9, target: { kind: 'clash', key: 'k' }, field: 'status', value: 'b', base: null }]);
  assert.deepStrictEqual(r.added, ['ok']);
  assert.strictEqual(L.fieldState(log, L.groupKey('clash', 'k', 'status')).value, 'a');
});

// ── Snapshots ────────────────────────────────────────────────────────

function scenario(seed) {
  // deterministic pseudo-random multi-client history with conflicts + resolutions
  let x = seed >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  const users = ['ann', 'ben', 'cas'].map(client);
  const all = [];
  const keys = ['k1', 'k2', 'k3'];
  const fields = ['status', 'assignee'];
  for (let t = 1; t <= 120; t++) {
    const u = users[Math.floor(rnd() * users.length)];
    const op = rnd();
    if (op < 0.35) {
      // read a random subset of what others wrote
      u.read(all.filter(() => rnd() < 0.6));
    } else {
      const k = keys[Math.floor(rnd() * keys.length)], f = fields[Math.floor(rnd() * fields.length)];
      const st = u.st('clash', k, f);
      const r = st && st.conflicted && rnd() < 0.5
        ? u.resolve('clash', k, f, 'v' + Math.floor(rnd() * 4), t)
        : u.edit('clash', k, f, 'v' + Math.floor(rnd() * 4), t, 'open');
      all.push(r);
    }
  }
  return { users, all };
}

test('snapshot + later changes = the same state as all changes (incl. conflicts)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { all } = scenario(seed);
    const full = L.createLog(); L.addChanges(full, all);
    const cut = Math.floor(all.length / 2);
    const early = L.createLog(); L.addChanges(early, all.slice(0, cut));
    const snap = JSON.parse(JSON.stringify(L.buildSnapshot(early, { by: 'ann', ts: 5, files: ['f1'], snapshots: [] })));
    const parsed = L.parseSnapshot(snap);
    const fresh = L.createLog();
    L.addChanges(fresh, parsed.changes);
    L.addChanges(fresh, all.slice(cut));
    assert.strictEqual(L.digest(fresh), L.digest(full), 'seed ' + seed);
    assert.strictEqual(snap.conflicts.length, L.conflictCount(early));
  }
});

// A folder simulation: change files and snapshots written by clients with
// arbitrary sync lag, covered files deleted by the snapshot author after the
// grace period. Every client's view is the folder as some earlier moment saw
// it (cloud sync delivers files late and in any order). A client that has not
// read a snapshot yet must never lose a change or a conflict: once it sees
// the current folder, its log equals the log of every change ever written.
test('deleting covered files never loses a change or a conflict for a client that has not seen the snapshot', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let x = seed * 7919 >>> 0;
    const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
    const folder = new Map();           // name -> {kind, body, at}
    const history = [];                 // folder versions over time (for lagging views)
    const snapshotOf = (m) => new Map(m);
    const clients = ['ann', 'ben', 'cas', 'dan'].map((u) => ({ ...client(u), applied: new Set(), seq: 0, snaps: [] }));
    const written = [];
    let now = 0;
    function sync(c, view) {
      // newest snapshots first; a snapshot marks the files it covers as applied
      const names = [...view.keys()];
      names.filter((n) => n.startsWith('snapshot-') && !c.applied.has(n)).sort().reverse().forEach((n) => {
        const s = L.parseSnapshot(view.get(n).body);
        c.read(s.changes);
        c.applied.add(n);
        s.files.forEach((f) => c.applied.add(f));
        s.snapshots.forEach((f) => c.applied.add(f));
      });
      names.filter((n) => n.startsWith('changes/') && !c.applied.has(n)).forEach((n) => {
        c.read(L.parseChangeFile(view.get(n).body).changes);
        c.applied.add(n);
      });
    }
    for (let step = 0; step < 220; step++) {
      now += 1 + Math.floor(rnd() * 5);
      history.push(snapshotOf(folder));
      const c = clients[Math.floor(rnd() * clients.length)];
      const op = rnd();
      // the client's view lags behind the real folder by up to 30 steps
      const lag = Math.floor(rnd() * Math.min(30, history.length));
      const view = history[history.length - 1 - lag];
      if (op < 0.4) sync(c, view);
      else if (op < 0.8) {
        const k = 'k' + Math.floor(rnd() * 3);
        const st = c.st('clash', k, 'status');
        const r = st && st.conflicted && rnd() < 0.4 ? c.resolve('clash', k, 'status', 'v' + Math.floor(rnd() * 3), now)
          : c.edit('clash', k, 'status', 'v' + Math.floor(rnd() * 3), now, 'open');
        const name = 'changes/' + c.user + '/' + L.changeFileName(c.user + 'w', ++c.seq);
        folder.set(name, { body: JSON.parse(JSON.stringify(L.changeFile({ user: c.user, writer: c.user + 'w', seq: c.seq, ts: now }, [r]))) });
        c.applied.add(name);
        written.push(r);
      } else if (op < 0.9) {
        // snapshot of what this client has applied (covers only files it read)
        const files = [...c.applied].filter((n) => n.startsWith('changes/') && folder.has(n));
        const snaps = [...c.applied].filter((n) => n.startsWith('snapshot-') && folder.has(n));
        const name = L.snapshotName(c.user, now);
        folder.set(name, { body: JSON.parse(JSON.stringify(L.buildSnapshot(c.log, { by: c.user, ts: now, files, snapshots: snaps }))) });
        c.applied.add(name);
        c.snaps.push({ name, by: c.user, ts: now, files, snapshots: snaps });
      } else {
        // cleanup after the grace period, by the snapshot's author only
        const plan = L.planCleanup({ me: c.user, now, graceMs: 20, snapshots: c.snaps,
          presentFiles: [...folder.keys()].filter((n) => n.startsWith('changes/')), presentSnapshots: [...folder.keys()].filter((n) => n.startsWith('snapshot-')) });
        plan.files.concat(plan.snapshots).forEach((n) => folder.delete(n));
      }
    }
    // every client, catching up on the current folder, has every change and
    // the same state (conflicts included) as the full history
    const full = L.createLog(); L.addChanges(full, written);
    for (const c of clients) {
      sync(c, folder);
      for (const r of written) assert.ok(c.log.changes[r.id], 'seed ' + seed + ': ' + c.user + ' lost ' + r.id);
      assert.strictEqual(L.digest(c.log), L.digest(full), 'seed ' + seed + ' ' + c.user);
    }
    // and a brand-new client reading only the folder gets it too
    const nc = { ...client('new'), applied: new Set() };
    sync(nc, folder);
    assert.strictEqual(L.digest(nc.log), L.digest(full), 'seed ' + seed + ' newcomer');
  }
});

test('planCleanup: only the author, only after the grace period, only covered items', () => {
  const snaps = [{ name: 'snapshot-00000000000100-ann.json', by: 'ann', ts: 100, files: ['changes/ann/a-000001.json', 'changes/ben/b-000001.json', 'gone'], snapshots: ['snapshot-00000000000050-ben.json'] }];
  const present = { presentFiles: ['changes/ann/a-000001.json', 'changes/ben/b-000001.json', 'changes/ben/b-000002.json'], presentSnapshots: ['snapshot-00000000000100-ann.json', 'snapshot-00000000000050-ben.json'] };
  assert.deepStrictEqual(L.planCleanup({ me: 'ben', now: 10_000, graceMs: 10, snapshots: snaps, ...present }), { files: [], snapshots: [] });
  assert.deepStrictEqual(L.planCleanup({ me: 'ann', now: 105, graceMs: 10, snapshots: snaps, ...present }), { files: [], snapshots: [] });
  assert.deepStrictEqual(L.planCleanup({ me: 'ann', now: 110, graceMs: 10, snapshots: snaps, ...present }),
    { files: ['changes/ann/a-000001.json', 'changes/ben/b-000001.json'], snapshots: ['snapshot-00000000000050-ben.json'] });
  // a snapshot that is itself gone covers nothing any more
  assert.deepStrictEqual(L.planCleanup({ me: 'ann', now: 110, graceMs: 10, snapshots: snaps, presentFiles: present.presentFiles, presentSnapshots: [] }), { files: [], snapshots: [] });
});

// ── Migration ────────────────────────────────────────────────────────

test('migration from a .ccproject: decisions become an initial snapshot, deterministically', () => {
  const data = {
    _cc: 'ClashControl', savedAt: '2026-10-01T10:00:00.000Z',
    clashes: [
      { id: 'c1', _identityKey: 'A|B@0,0,0', status: 'resolved', priority: 'high', assignee: 'Ann' },
      { id: 'c2', globalIdA: 'X', globalIdB: 'Y', status: 'open', priority: 'normal', assignee: '' },
      { id: 'c3', globalIdA: 'P', globalIdB: 'Q', status: 'denied' },
    ],
    issues: [{ id: 'i1', title: 'Fix duct', status: 'open', _local: 1, aiSignals: [1], comments: [{ id: 'cm1', author: 'Ann', text: 'hi', ts: 5 }] }],
    comments: [{ id: 'n1', author: 'Ben', text: 'pin', ts: 7, resolved: false, replies: [{ id: 'r1', author: 'Ann', text: 'ok', ts: 8 }] }],
  };
  const text = JSON.stringify(data);
  const ident = (c) => [c.globalIdA, c.globalIdB].sort().join('|') + '@0,0,0';
  const m1 = L.migrateProject(data, text, { identityKey: ident });
  const m2 = L.migrateProject(JSON.parse(text), text, { identityKey: ident });
  assert.deepStrictEqual(m1, m2, 'two clients migrating the same file write the same snapshot');
  assert.match(m1.name, /^snapshot-\d{14}-legacy-[0-9a-f]{8}\.json$/);
  const parsed = L.parseSnapshot(JSON.parse(JSON.stringify(m1.snapshot)));
  const log = L.createLog(); L.addChanges(log, parsed.changes);
  const st = (k, f) => L.fieldState(log, L.groupKey('clash', k, f));
  assert.strictEqual(st('A|B@0,0,0', 'status').value, 'resolved');
  assert.strictEqual(st('A|B@0,0,0', 'priority').value, 'high');
  assert.strictEqual(st('A|B@0,0,0', 'assignee').value, 'Ann');
  assert.strictEqual(st('P|Q@0,0,0', 'status').value, 'denied');
  assert.strictEqual(st('X|Y@0,0,0', 'status'), null, 'default values are not decisions');
  const created = L.fieldState(log, L.groupKey('issue', 'i1', 'created')).value;
  assert.strictEqual(created.title, 'Fix duct');
  assert.ok(!('_local' in created) && !('aiSignals' in created) && !('comments' in created));
  assert.strictEqual(L.fieldState(log, L.groupKey('issue', 'i1', 'comment:cm1')).value.text, 'hi');
  assert.strictEqual(L.fieldState(log, L.groupKey('note', 'n1', 'reply:r1')).value.text, 'ok');
  assert.strictEqual(L.fieldState(log, L.groupKey('note', 'n1', 'created')).value.text, 'pin');
  // a later edit on a migrated decision is an ordinary update
  const r = L.makeChange(log, { id: 'x1', user: 'ann', ts: 9e12, kind: 'clash', key: 'A|B@0,0,0', field: 'status', value: 'closed' });
  assert.ok(r.base && r.base.startsWith('m-'));
  assert.strictEqual(L.migrateProject({ notCC: 1 }, '{}', {}), null);
});

test('file names and ids', () => {
  assert.strictEqual(L.changeFileName('w1abc', 7), 'w1abc-000007.json');
  assert.deepStrictEqual(L.parseSnapshotName(L.snapshotName('u1abc', 1729000000000)), { ts: 1729000000000, by: 'u1abc' });
  assert.ok(L.safeId('u1abcdef') && !L.safeId('../x') && !L.safeId('A'));
  assert.strictEqual(L.parseChangeFile({ _cc: 'nope' }), null);
});
