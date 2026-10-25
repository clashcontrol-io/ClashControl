'use strict';
// api/project.js v2 (docs/INTERNALS.md §21.56): a shared project is an
// append-only change log. Runs the REAL handler against an in-memory SQL
// stand-in (tests/_sql-memory.js) and two clients computing state with the
// same core as the app (shared-log-core.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../shared-log-core.js');
const { createMemoryDb, installMemoryNeon, call } = require('./_sql-memory');

function setup(opts) {
  const db = createMemoryDb(opts);
  const restore = installMemoryNeon(db);
  const handler = require('../api/project.js');
  return { db, handler, restore };
}
async function createProject(h, name) {
  const r = await call(h, { method: 'POST', body: { name: name || 'Test' } });
  assert.equal(r.status, 201);
  return r.body;
}
// A client: its own log; edits build on what it has pulled (like the app).
function client(h, pid, user, name) {
  const log = L.createLog();
  let n = 0, cursor = '0';
  return {
    log, user,
    edit(kind, key, field, value, prev) { const r = L.makeChange(log, { id: user + '.' + (++n), user, ts: 1000 + n, kind, key, field, value, prev }); L.addChanges(log, [r]); return r; },
    resolve(kind, key, field, value) { const r = L.makeResolution(log, { id: user + '.' + (++n), user, ts: 1000 + n, kind, key, field, value }); L.addChanges(log, [r]); return r; },
    async push(recs) { return call(h, { method: 'PUT', query: { id: pid }, body: { v: 2, user, name, changes: recs } }); },
    async pull() {
      const r = await call(h, { method: 'GET', query: { id: pid, v: '2', after: cursor } });
      assert.equal(r.status, 200);
      L.addChanges(log, r.body.changes);
      L.addNames(log, r.body.names);
      cursor = r.body.cursor;
      return r.body;
    },
    st(kind, key, field) { return L.fieldState(log, L.groupKey(kind, key, field)); },
  };
}
const K = ['clash', 'G1|G2@0,0,0'];

test('PUT appends idempotently by record id; a pull after the cursor returns only newer records', async () => {
  const { handler, db, restore } = setup();
  try {
    const p = await createProject(handler);
    const a = client(handler, p.id, 'ualice', 'Alice');
    const r1 = a.edit(...K, 'status', 'in_progress', 'open');
    let res = await a.push([r1]);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.accepted, res.body.known, res.body.invalid], [1, 0, []]);
    res = await a.push([r1, r1]); // retried write (lost response) + duplicate in one batch
    assert.deepEqual([res.body.accepted, res.body.known], [0, 1]);
    assert.equal(db.changes.get(p.id).length, 1, 'stored once');

    const b = client(handler, p.id, 'ubob', 'Bob');
    let page = await b.pull();
    assert.deepEqual(page.changes.map((c) => c.id), [r1.id]);
    assert.equal(page.names.ualice, 'Alice');
    assert.equal(b.st(...K, 'status').value, 'in_progress');
    const cur = page.cursor;
    page = await b.pull();
    assert.equal(page.changes.length, 0, 'nothing new → nothing returned');
    assert.equal(page.cursor, cur);
    const r2 = a.edit(...K, 'priority', 'high', 'normal');
    await a.push([r2]);
    page = await b.pull();
    assert.deepEqual(page.changes.map((c) => c.id), [r2.id], 'only the record after the cursor');
    // records round-trip field for field (prev / resolves / covers kept)
    assert.deepEqual(page.changes[0], JSON.parse(JSON.stringify(L.normaliseChange(r2))));
  } finally { restore(); }
});

test('pull pages: limit + more, and every record arrives exactly once in seq order', async () => {
  const { handler, restore } = setup();
  try {
    const p = await createProject(handler);
    const a = client(handler, p.id, 'ualice', 'Alice');
    const recs = [];
    for (let i = 0; i < 7; i++) recs.push(a.edit('clash', 'k' + i, 'status', 'resolved', 'open'));
    await a.push(recs.slice(0, 4)); await a.push(recs.slice(4));
    let after = '0', got = [], more = true, pages = 0;
    while (more) {
      const r = await call(handler, { method: 'GET', query: { id: p.id, v: '2', after, limit: '3' } });
      got = got.concat(r.body.changes.map((c) => c.id)); after = r.body.cursor; more = r.body.more; pages++;
    }
    assert.deepEqual(got, recs.map((r) => r.id));
    assert.equal(pages, 3);
  } finally { restore(); }
});

test('two users editing the same field on the same version: a conflict BOTH see on GET; a resolution clears it for both', async () => {
  const { handler, restore } = setup();
  try {
    const p = await createProject(handler);
    const a = client(handler, p.id, 'ualice', 'Alice'), b = client(handler, p.id, 'ubob', 'Bob');
    const r0 = a.edit(...K, 'status', 'in_progress', 'open');
    await a.push([r0]); await b.pull();
    // both edit, neither has seen the other's edit — far apart or not
    const ra = a.edit(...K, 'status', 'resolved');
    const rb = b.edit(...K, 'status', 'closed');
    const pa = await a.push([ra]), pb = await b.push([rb]);
    assert.equal(pa.body.accepted, 1); assert.equal(pb.body.accepted, 1, 'the second writer is NOT rejected');
    assert.ok(!('conflicts' in pb.body), 'no per-issue rejection any more');
    await a.pull(); await b.pull();
    for (const c of [a, b]) {
      const s = c.st(...K, 'status');
      assert.equal(s.conflicted, true, c.user);
      assert.equal(s.value, 'in_progress', 'keeps the last agreed value');
      assert.deepEqual(s.heads.map((h) => h.value).sort(), ['closed', 'resolved']);
    }
    // a newcomer reading the whole log sees the same conflict
    const c = client(handler, p.id, 'ucarol', 'Carol');
    await c.pull();
    assert.equal(c.st(...K, 'status').conflicted, true);
    // Bob resolves (picks Alice's value): cleared everywhere
    const res = b.resolve(...K, 'status', 'resolved');
    await b.push([res]);
    for (const x of [a, b, c]) {
      await x.pull();
      const s = x.st(...K, 'status');
      assert.equal(s.conflicted, false, x.user);
      assert.equal(s.value, 'resolved');
      assert.equal(x.log.size, 4, 'history keeps every record');
    }
    assert.equal(L.digest(a.log), L.digest(b.log));
    assert.equal(L.digest(a.log), L.digest(c.log));
    // concurrent different resolutions are a new conflict
    const r5 = a.edit(...K, 'priority', 'high', 'normal'), r6 = b.edit(...K, 'priority', 'low', 'normal');
    await a.push([r5]); await b.push([r6]); await a.pull(); await b.pull();
    const s1 = a.resolve(...K, 'priority', 'high'), s2 = b.resolve(...K, 'priority', 'critical');
    await a.push([s1]); await b.push([s2]); await a.pull(); await b.pull();
    assert.equal(a.st(...K, 'priority').conflicted, true);
    assert.equal(L.digest(a.log), L.digest(b.log));
  } finally { restore(); }
});

test('delete vs edit through the server: conflict for both, keep restores with the edit', async () => {
  const { handler, restore } = setup();
  try {
    const p = await createProject(handler);
    const a = client(handler, p.id, 'ualice', 'Alice'), b = client(handler, p.id, 'ubob', 'Bob');
    const c0 = a.edit('issue', 'iss_1', 'created', { title: 'Duct', status: 'open' }, null);
    await a.push([c0]); await b.pull();
    const del = a.edit('issue', 'iss_1', 'deleted', true, null);
    const ed = b.edit('issue', 'iss_1', 'status', 'in_progress', 'open');
    await a.push([del]); await b.push([ed]); await a.pull(); await b.pull();
    for (const c of [a, b]) {
      const ts = L.targetState(c.log, 'issue', 'iss_1');
      assert.equal(ts.fields.deleted.deleteConflict, true, c.user);
      assert.equal(ts.fields.deleted.value, false, 'the issue stays while open');
      assert.equal(ts.fields.status.value, 'open', 'with the value the deleter saw');
    }
    await a.push([a.resolve('issue', 'iss_1', 'deleted', false)]);
    await b.pull();
    const ts = L.targetState(b.log, 'issue', 'iss_1');
    assert.equal(ts.conflicts.length, 0);
    assert.equal(ts.fields.status.value, 'in_progress');
  } finally { restore(); }
});

test('validation caps: malformed / oversized records are reported invalid and not stored; too many per request is 413', async () => {
  const { handler, db, restore } = setup();
  try {
    const p = await createProject(handler);
    const ok = { id: 'u1.1', user: 'u1', ts: 1, target: { kind: 'clash', key: 'k' }, field: 'status', value: 'x', base: null };
    const bad = [
      Object.assign({}, ok, { id: 'u1.2', target: { kind: 'model', key: 'k' } }),           // unknown target kind
      Object.assign({}, ok, { id: 'u1.3', field: 'status; drop' }),                          // field charset
      Object.assign({}, ok, { id: 'u1.4', value: 'v'.repeat(20000) }),                      // value cap
      Object.assign({}, ok, { id: 'u1.5', target: { kind: 'clash', key: 'k'.repeat(301) } }), // key cap
      Object.assign({}, ok, { id: 'u1.6', user: '../x' }),                                   // user id charset
      Object.assign({}, ok, { id: 'u1.7', resolves: new Array(65).fill('x') }),             // resolves cap
      Object.assign({}, ok, { id: 'u1.8', ts: 'soon' }),                                    // ts
    ];
    const r = await call(handler, { method: 'PUT', query: { id: p.id }, body: { v: 2, user: 'u1', name: 'U', changes: [ok].concat(bad) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, 1);
    assert.deepEqual(r.body.invalid.sort(), bad.map((b) => b.id).sort());
    // each refusal says why, so the sender can tell its user
    const why = Object.fromEntries(r.body.rejected.map((x) => [x.id, x.reason]));
    assert.deepEqual(why, { 'u1.2': 'kind', 'u1.3': 'field', 'u1.4': 'value-too-large', 'u1.5': 'key-too-long', 'u1.6': 'user', 'u1.7': 'resolves', 'u1.8': 'malformed' });
    assert.equal(db.changes.get(p.id).length, 1);
    const many = new Array(501).fill(0).map((_, i) => Object.assign({}, ok, { id: 'm' + i }));
    const r2 = await call(handler, { method: 'PUT', query: { id: p.id }, body: { v: 2, user: 'u1', changes: many } });
    assert.equal(r2.status, 413);
    const r3 = await call(handler, { method: 'PUT', query: { id: p.id }, body: { v: 2, user: 'u1' } });
    assert.equal(r3.status, 400);
    const r4 = await call(handler, { method: 'PUT', query: { id: 'NOPE-123456' }, body: { v: 2, changes: [ok] } });
    assert.equal(r4.status, 404);
  } finally { restore(); }
});

test('old clients: PUT in the old shape is refused clearly (nothing stored); GET without v gets a read-only issues view', async () => {
  const { handler, db, restore } = setup();
  try {
    const p = await createProject(handler);
    const a = client(handler, p.id, 'ualice', 'Alice');
    await a.push([a.edit('clash', 'GA|GB@1,2,3', 'status', 'resolved', 'open'), a.edit('issue', 'iss_9', 'created', { title: 'Leak', status: 'open' }, null)]);
    const before = db.changes.get(p.id).length;
    const old = await call(handler, { method: 'PUT', query: { id: p.id }, body: { issues: [{ id: 'c1', status: 'closed', title: 'x', _updatedAt: new Date().toISOString() }], user: 'Old' } });
    assert.equal(old.status, 200);
    assert.equal(old.body.error, 'client_outdated');
    assert.deepEqual(old.body.conflicts, ['c1'], 'the old client shows its "not applied" message for these ids');
    assert.equal(old.body.synced, 0);
    assert.equal(db.changes.get(p.id).length, before, 'nothing written');
    const g = await call(handler, { method: 'GET', query: { id: p.id } });
    assert.equal(g.status, 200);
    const clash = g.body.issues.find((i) => i.globalIdA === 'GA');
    assert.equal(clash.status, 'resolved');
    assert.equal(clash.globalIdB, 'GB');
    assert.equal(g.body.issues.find((i) => i.id === 'iss_9').title, 'Leak');
    assert.ok(!('edit_key' in g.body.project));
  } finally { restore(); }
});

test('lazy migration: a project\'s old shared_issues rows become records once, deterministically', async () => {
  const { handler, db, restore } = setup();
  try {
    // an old client created the project with initial issues (old POST shape)
    const r = await call(handler, { method: 'POST', body: { name: 'Old', user: 'Ann', issues: [
      { id: 'c-123', status: 'resolved', priority: 'high', assignee: 'Ann', globalIdA: 'GA', globalIdB: 'GB', point: [0.1, 0.2, 0.3], title: 'Wall x duct' },
      { id: 'c-124', status: 'open', priority: 'normal', globalIdA: 'GC', globalIdB: 'GD', point: [1, 1, 1], title: 'nothing decided' },
      { id: 'iss_77', status: 'open', title: 'Fire damper missing', source: 'manual', description: 'L2' },
    ] } });
    const pid = r.body.id;
    assert.equal(db.issues.get(pid).size, 3);
    const a = client(handler, pid, 'ualice', 'Alice');
    await a.pull();
    const key = require('../clash-identity-core.js').computeClashIdentityKey({ globalIdA: 'GA', globalIdB: 'GB', point: [0.1, 0.2, 0.3] });
    assert.equal(a.st('clash', key, 'status').value, 'resolved');
    assert.equal(a.st('clash', key, 'priority').value, 'high');
    assert.equal(a.st('clash', key, 'assignee').value, 'Ann');
    const ck = require('../clash-identity-core.js').computeClashIdentityKey({ globalIdA: 'GC', globalIdB: 'GD', point: [1, 1, 1] });
    assert.equal(a.st('clash', ck, 'status'), null, 'default values are not decisions');
    assert.equal(a.st('issue', 'iss_77', 'created').value.title, 'Fire damper missing');
    assert.equal(Object.values(a.log.names)[0], 'Ann');
    const n = db.changes.get(pid).length;
    assert.equal(db.projects.get(pid).log_migrated, true);
    // once: a second access does not migrate again; the old rows stay readable
    await call(handler, { method: 'GET', query: { id: pid, v: '2' } });
    assert.equal(db.changes.get(pid).length, n);
    assert.equal(db.issues.get(pid).size, 3);
    // deterministic ids: a concurrent second migration inserts nothing new
    db.projects.get(pid).log_migrated = false;
    await call(handler, { method: 'GET', query: { id: pid, v: '2' } });
    assert.equal(db.changes.get(pid).length, n);
    // a later edit on a migrated decision is an ordinary update
    const e = a.edit('clash', key, 'status', 'closed');
    assert.ok(e.base && e.base.startsWith('mig-'));
  } finally { restore(); }
});

test('editKey still gates DELETE; deleting the project removes its change log', async () => {
  const { handler, db, restore } = setup();
  try {
    const p = await createProject(handler);
    const a = client(handler, p.id, 'ualice', 'Alice');
    await a.push([a.edit(...K, 'status', 'resolved', 'open')]);
    let r = await call(handler, { method: 'DELETE', query: { id: p.id, scope: 'project' }, headers: { 'x-cc-edit-key': 'wrong' } });
    assert.equal(r.status, 403);
    assert.equal(db.changes.get(p.id).length, 1);
    r = await call(handler, { method: 'DELETE', query: { id: p.id, scope: 'project' }, headers: { 'x-cc-edit-key': p.editKey } });
    assert.equal(r.status, 200);
    assert.ok(!db.changes.has(p.id) && !db.projects.has(p.id));
    // PUT stays open to anyone with the key (the collaboration model) — no edit key needed
    const p2 = await createProject(handler);
    const b = client(handler, p2.id, 'ubob', 'Bob');
    assert.equal((await b.push([b.edit(...K, 'status', 'closed', 'open')])).body.accepted, 1);
  } finally { restore(); }
});

test('a deployment that has not run the schema migration sets the change log up itself', async () => {
  const { handler, restore, db } = setup({ noChangeLog: true });
  try {
    const p = await createProject(handler);
    const r = await call(handler, { method: 'GET', query: { id: p.id, v: '2' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(db.calls.filter((t) => t.startsWith('schema-')), ['schema-seq', 'schema-migrated', 'schema-changes', 'schema-seq-idx']);
    const again = await call(handler, { method: 'GET', query: { id: p.id, v: '2' } });
    assert.equal(again.status, 200);
    assert.equal(db.calls.filter((t) => t.startsWith('schema-')).length, 4, 'set up once, not per request');
  } finally { restore(); }
});

test('when the database role may not create tables, the answer is a 503 that says what to do', async () => {
  const { handler, restore } = setup({ noChangeLog: true, noDdl: true });
  try {
    const p = await createProject(handler);
    const r = await call(handler, { method: 'GET', query: { id: p.id, v: '2' } });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /schema\.sql/);
  } finally { restore(); }
});

test('the server\'s own change-log setup runs exactly the statements of api/schema.sql', () => {
  const fs = require('node:fs');
  const norm = (t) => t.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
  const schema = norm(fs.readFileSync(require.resolve('../api/schema.sql'), 'utf8'));
  const src = fs.readFileSync(require.resolve('../api/project.js'), 'utf8');
  const stmts = (src.match(/sql`\/\* cc:schema-[a-z-]+ \*\/([^`]*)`/g) || []).map((s) => norm(s.replace(/^sql`\/\* cc:schema-[a-z-]+ \*\//, '').replace(/`$/, '')));
  assert.equal(stmts.length, 4);
  stmts.forEach((st) => assert.ok(schema.includes(st), 'not in api/schema.sql: ' + st.slice(0, 80)));
});

test('every statement in api/project.js is tagged (so the in-memory db covers all of them)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../api/project.js'), 'utf8');
  const stmts = src.match(/sql`[^`]*/g) || [];
  assert.ok(stmts.length > 10);
  stmts.forEach((s) => assert.match(s, /^sql`\/\* cc:[a-z0-9-]+ \*\//, s.slice(0, 60)));
});
