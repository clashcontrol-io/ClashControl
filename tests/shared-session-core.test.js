'use strict';
// shared-session-core.js (docs/INTERNALS.md §21.56): the engine both sharing
// modes use to turn app actions into records and records into app state.
// Driven here with a tiny fake app (state + reducer subset + dispatch).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../shared-log-core.js');
const SC = require('../shared-session-core.js');

function app(user) {
  let st = { clashes: [{ id: 'c1-' + user, _identityKey: 'A|B@0,0,0', status: 'open', priority: 'normal' }], issues: [], comments: [], viewpoints: [] };
  const actions = [];
  function reduce(a) {
    const s = st;
    switch (a.t) {
      case 'UPD_CLASH':
        if (a.u.status === 'confirmed') {
          const c = s.clashes.find((x) => x.id === a.id);
          const iss = { id: 'iss_' + user + '_1', title: 'From clash', status: 'open', clashId: c.id, aiSignals: [1] };
          st = Object.assign({}, s, { clashes: s.clashes.map((x) => x.id === a.id ? Object.assign({}, x, { status: 'confirmed', linkedIssueId: iss.id }) : x), issues: s.issues.concat([iss]) });
        } else st = Object.assign({}, s, { clashes: s.clashes.map((x) => x.id === a.id ? Object.assign({}, x, a.u) : x) });
        break;
      case 'CLASH_BATCH_RESTORE': st = Object.assign({}, s, { clashes: s.clashes.map((x) => a.prev[x.id] ? Object.assign({}, x, a.prev[x.id]) : x) }); break;
      case 'ADD_ISSUE': st = Object.assign({}, s, { issues: s.issues.concat([a.v]) }); break;
      case 'UPD_ISSUE': st = Object.assign({}, s, { issues: s.issues.map((x) => x.id === a.id ? Object.assign({}, x, a.u) : x) }); break;
      case 'DEL_ISSUE': st = Object.assign({}, s, { issues: s.issues.filter((x) => x.id !== a.id) }); break;
      case 'ADD_VIEWPOINT': st = Object.assign({}, s, { viewpoints: s.viewpoints.concat([a.v]) }); break;
      case 'UPD_VIEWPOINT': st = Object.assign({}, s, { viewpoints: s.viewpoints.map((x) => x.id === a.id ? Object.assign({}, x, a.u) : x) }); break;
      case 'DEL_VIEWPOINT': st = Object.assign({}, s, { viewpoints: s.viewpoints.filter((x) => x.id !== a.id) }); break;
      default: break;
    }
  }
  const sess = SC.createSession({ src: 'cloud', userId: user, writer: user + 'w', projectKey: 'P', dispatch: (a) => { actions.push(a); reduce(a); }, getState: () => st });
  return {
    sess, actions, get st() { return st; },
    // a local action: the wrapper notes it with the state it was dispatched on, the reducer applies, the App effect observes
    act(a, ids) { const prev = st; reduce(a); sess.note(a, prev, ids || null); sess.observe(st); },
    exchange(other) { const mine = this.sess.takeBatch(); this.sess.done(mine); const r = other.sess.ingest(mine); other.sess.sync({ touched: r.touched, remote: r.added }); return mine; },
  };
}

test('a confirm publishes the clash status AND the issue the reducer created; a teammate gets both', () => {
  const a = app('ua'), b = app('ub');
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { status: 'confirmed' } });
  const recs = a.sess.outbox();
  assert.deepEqual(recs.map((r) => [r.target.kind, r.field]).sort(), [['clash', 'status'], ['issue', 'created']]);
  const created = recs.find((r) => r.field === 'created').value;
  assert.equal(created.title, 'From clash');
  assert.ok(!('aiSignals' in created), 'no training signals in shared records');
  b.sess.sync({});
  a.exchange(b);
  assert.equal(b.st.clashes[0].status, 'confirmed');
  assert.equal(b.st.issues.length, 1);
  assert.equal(b.st.issues[0].title, 'From clash');
  // the teammate's copy arrived as a sync action, not a confirm: no second issue
  assert.ok(b.actions.filter((x) => x.t !== 'MERGE_CHANGELOG').every((x) => x._fromSync) && !b.actions.some((x) => x.t === 'UPD_CLASH'));
});

test('viewpoints are shared (no picture); a clash-linked one is linked by clash identity; delete is shared', () => {
  const a = app('ua'), b = app('ub');
  b.sess.sync({});
  const vp = { id: 'vp1', name: 'Shaft', linkedId: 'c1-ua', snapshot: 'data:image/png;base64,AAAA', camera: { px: 1, py: 2, pz: 3 }, section: null, clip: null };
  a.act({ t: 'ADD_VIEWPOINT', v: vp });
  a.exchange(b);
  const got = b.st.viewpoints[0];
  assert.equal(got.name, 'Shaft');
  assert.equal(got.camera.pz, 3);
  assert.ok(!('snapshot' in got));
  assert.equal(got.linkedId, 'c1-ub', 'mapped to the teammate\'s own clash id');
  a.act({ t: 'UPD_VIEWPOINT', id: 'vp1', u: { name: 'Shaft 2' } });
  a.exchange(b);
  assert.equal(b.st.viewpoints[0].name, 'Shaft 2');
  a.act({ t: 'DEL_VIEWPOINT', id: 'vp1' });
  a.exchange(b);
  assert.equal(b.st.viewpoints.length, 0);
});

test('delete vs edit in the app: both keep the issue with a conflict marker; keep / delete resolves it everywhere', () => {
  for (const choice of [false, true]) {
    const a = app('ua'), b = app('ub');
    a.sess.sync({}); b.sess.sync({});
    a.act({ t: 'ADD_ISSUE', v: { id: 'iss_x', title: 'Leak', status: 'open' } });
    a.exchange(b);
    a.act({ t: 'DEL_ISSUE', id: 'iss_x' });
    b.act({ t: 'UPD_ISSUE', id: 'iss_x', u: { status: 'resolved' } });
    a.exchange(b); b.exchange(a);
    for (const p of [a, b]) {
      const it = p.st.issues.find((x) => x.id === 'iss_x');
      assert.ok(it, 'the issue stays (re-added on the deleter\'s page)');
      assert.equal(it.status, 'open', 'with the agreed value');
      assert.equal(it._sharedConflict.length, 1);
      assert.equal(it._sharedConflict[0].deleteConflict, true);
      assert.equal(it._sharedConflict[0].src, 'cloud');
      assert.equal(p.sess.conflictCount(), 1);
    }
    b.sess.resolve({ kind: 'issue', key: 'iss_x', field: 'deleted', value: choice });
    b.exchange(a);
    for (const p of [a, b]) {
      const it = p.st.issues.find((x) => x.id === 'iss_x');
      if (choice) assert.equal(it, undefined, 'deleted for everyone');
      else { assert.equal(it.status, 'resolved', 'kept with the edit'); assert.ok(!it._sharedConflict); }
      assert.equal(p.sess.conflictCount(), 0);
    }
  }
});

test('a record being written is never amended; a failed write is retried with the same records', () => {
  const a = app('ua');
  a.sess.sync({});
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { assignee: 'A' } });
  const batch = a.sess.takeBatch();
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { assignee: 'Ab' } });
  assert.equal(batch[0].value, 'A', 'in-flight record untouched');
  assert.equal(a.sess.pending(), 2);
  a.sess.release(batch);
  const again = a.sess.takeBatch();
  assert.deepEqual(again.map((r) => r.id), a.sess.outbox().map((r) => r.id));
  a.sess.done(again);
  assert.equal(a.sess.pending(), 0);
  assert.equal(L.fieldState(a.sess.log, L.groupKey('clash', 'A|B@0,0,0', 'assignee')).value, 'Ab');
});

test('registry: notes go to every active session, a resolution only to the session its marker came from', () => {
  const a = app('ua'), f = app('uf');
  SC.register(a.sess); SC.register(f.sess);
  try {
    SC.noteAll({ t: 'UPD_CLASH', id: 'c1-ua', u: { priority: 'high' } }, a.st, null);
    assert.equal(a.sess.pending(), 1);
    assert.equal(f.sess.pending(), 1, 'every active session records the edit');
    let hit = [];
    const orig = [a.sess.resolve, f.sess.resolve];
    a.sess.resolve = () => { hit.push('a'); return true; }; f.sess.resolve = () => { hit.push('f'); return true; };
    SC.resolve({ src: 'cloud', kind: 'clash', key: 'k', field: 'status', value: 'x' });
    assert.deepEqual(hit, ['a']);
    [a.sess.resolve, f.sess.resolve] = orig;
  } finally { SC.unregister(a.sess); SC.unregister(f.sess); }
  assert.equal(SC.sessions().length, 0);
});
