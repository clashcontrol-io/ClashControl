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
      // like the app's reducer: an issue's viewpoints go with it
      case 'DEL_ISSUE': st = Object.assign({}, s, { issues: s.issues.filter((x) => x.id !== a.id), viewpoints: s.viewpoints.filter((v) => v.linkedId !== a.id) }); break;
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

test('an issue\'s viewpoints follow the issue: back on Keep, gone on Delete, never re-added as orphans', () => {
  for (const choice of [false, true]) {
    const a = app('ua'), b = app('ub');
    a.sess.sync({}); b.sess.sync({});
    a.act({ t: 'ADD_ISSUE', v: { id: 'iss_v', title: 'Leak', status: 'open' } });
    a.act({ t: 'ADD_VIEWPOINT', v: { id: 'vp_1', name: 'Leak view', camera: { p: [1, 2, 3] }, linkedId: 'iss_v' } });
    a.exchange(b);
    assert.ok(b.st.viewpoints.some((v) => v.id === 'vp_1' && v.linkedId === 'iss_v'));
    a.act({ t: 'DEL_ISSUE', id: 'iss_v' });                       // the reducer drops vp_1 too
    b.act({ t: 'UPD_ISSUE', id: 'iss_v', u: { status: 'resolved' } });
    a.exchange(b); b.exchange(a);
    for (const p of [a, b]) assert.ok(p.st.viewpoints.some((v) => v.id === 'vp_1'), 'while the delete is in conflict the issue and its viewpoint stay');
    b.sess.resolve({ kind: 'issue', key: 'iss_v', field: 'deleted', value: choice });
    b.exchange(a);
    for (const p of [a, b]) {
      p.sess.sync({ full: true });                                  // a later full pass changes nothing
      const has = p.st.viewpoints.some((v) => v.id === 'vp_1');
      if (choice) assert.equal(has, false, 'Delete: the viewpoint is gone with its issue');
      else assert.equal(has, true, 'Keep: the viewpoint is back with its issue');
    }
  }
  // a plain delete (no conflict): the deleter's next full pass does not bring the viewpoint back
  const a = app('ua'), b = app('ub');
  a.sess.sync({}); b.sess.sync({});
  a.act({ t: 'ADD_ISSUE', v: { id: 'iss_w', title: 'Gap', status: 'open' } });
  a.act({ t: 'ADD_VIEWPOINT', v: { id: 'vp_2', name: 'Gap view', camera: { p: [0, 0, 1] }, linkedId: 'iss_w' } });
  a.exchange(b);
  a.act({ t: 'DEL_ISSUE', id: 'iss_w' });
  a.exchange(b);
  for (const p of [a, b]) { p.sess.sync({ full: true }); assert.equal(p.st.viewpoints.some((v) => v.id === 'vp_2'), false); }
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

test('one sharing mode at a time: the mode holding the link refuses the other until it releases', () => {
  assert.equal(SC.linkHolder(), null);
  assert.equal(SC.claimLink('cloud', 'MEP-abc123'), null, 'the first mode gets the link');
  try {
    assert.equal(SC.claimLink('cloud', 'MEP-def456'), null, 'the same mode may switch keys');
    assert.deepEqual(SC.linkHolder(), { src: 'cloud', label: 'MEP-def456' });
    assert.deepEqual(SC.claimLink('folder', 'Team share'), { src: 'cloud', label: 'MEP-def456' }, 'the folder is refused and told who holds the link');
    SC.releaseLink('folder');
    assert.equal(SC.linkHolder().src, 'cloud', 'a refused mode cannot release the other mode\'s link');
    const h = SC.linkHolder(); h.src = 'folder';
    assert.equal(SC.linkHolder().src, 'cloud', 'the holder is returned as a copy');
  } finally { SC.releaseLink('cloud'); }
  assert.equal(SC.linkHolder(), null);
  assert.equal(SC.claimLink('folder', 'Team share'), null, 'after leaving the key the folder can link');
  assert.equal(SC.claimLink('cloud', 'MEP-abc123').src, 'folder');
  SC.releaseLink('folder');
  assert.equal(SC.linkHolder(), null);
});

test('a record the store refused leaves the outbox, stays in the local log, is listed with its reason until dismissed', () => {
  const a = app('ua');
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { status: 'in_progress' } });
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { assignee: 'Ann' } });
  const batch = a.sess.takeBatch();
  assert.equal(batch.length, 2);
  a.sess.done(batch);
  assert.equal(a.sess.reject([{ id: batch[1].id, reason: 'value-too-large' }, { id: 'nope', reason: 'malformed' }]), 2);
  assert.equal(a.sess.reject([{ id: batch[1].id, reason: 'value-too-large' }]), 0, 'a refusal already known is not new');
  assert.equal(a.sess.pending(), 0, 'never retried');
  const list = a.sess.rejected();
  assert.deepEqual(list.find((x) => x.id === batch[1].id), { id: batch[1].id, kind: 'clash', key: 'A|B@0,0,0', field: 'assignee', reason: 'value-too-large', ts: batch[1].ts });
  assert.equal(L.fieldState(a.sess.log, L.groupKey('clash', 'A|B@0,0,0', 'assignee')).value, 'Ann', 'this user keeps the edit');
  // refused while still in the outbox (a later push, the first never confirmed): taken out
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { priority: 'high' } });
  const b2 = a.sess.takeBatch();
  a.sess.reject([{ id: b2[0].id, reason: 'prev-too-large' }]);
  assert.equal(a.sess.pending(), 0);
  a.sess.dismissRejected();
  assert.deepEqual(a.sess.rejected(), []);
});

test('a clash with Revit UniqueIds gets decisions recorded under its GlobalId identity (old rows); its own key wins', () => {
  const I = require('../clash-identity-core.js');
  const c = { id: 'c1', globalIdA: 'GA', globalIdB: 'GB', uniqueIdA: 'ua-1', uniqueIdB: 'ub-2', point: [0.1, 0.2, 0.3], status: 'open', priority: 'normal' };
  const key = I.computeClashIdentityKey(c), legacy = I.computeGlobalIdKey(c);
  assert.ok(key.startsWith('u:') && legacy && legacy !== key);
  assert.equal(I.computeGlobalIdKey({ globalIdA: 'GA', globalIdB: 'GB', point: [0, 0, 0] }), null, 'no alias when the keys agree');
  let st = { clashes: [c], issues: [], comments: [], viewpoints: [] };
  const sess = SC.createSession({ src: 'cloud', userId: 'ua', writer: 'uaw', projectKey: 'P', getState: () => st,
    identityKey: I.computeClashIdentityKey, aliasKey: I.computeGlobalIdKey,
    dispatch: (a) => { if (a.t === 'CLASH_BATCH_RESTORE') st = Object.assign({}, st, { clashes: st.clashes.map((x) => a.prev[x.id] ? Object.assign({}, x, a.prev[x.id]) : x) }); } });
  // the migration's records (api/project.js) carry the GlobalId key
  const mig = L.migrateLegacyRows([{ id: 'r1', data: { id: 'r1', source: 'auto', globalIdA: 'GA', globalIdB: 'GB', point: [0.1, 0.2, 0.3], status: 'resolved', priority: 'high' }, updated_by: 'Ann', updated_at: '2026-10-01' }],
    { projectId: 'P', identityKey: I.computeClashIdentityKey });
  const r = sess.ingest(mig.changes);
  sess.sync({ touched: r.touched });
  assert.equal(st.clashes[0].status, 'resolved');
  assert.equal(st.clashes[0].priority, 'high');
  // a newer edit (from any machine) is recorded under the clash's own key and wins
  const e = L.makeChange(sess.log, { id: 'ub.1', user: 'ub', ts: 5, kind: 'clash', key, field: 'status', value: 'closed' });
  const r2 = sess.ingest([e]);
  sess.sync({ touched: r2.touched });
  assert.equal(st.clashes[0].status, 'closed');
  assert.equal(st.clashes[0].priority, 'high', 'the alias still fills what the own key does not know');
  // a full pass keeps it that way (no flip-flop between the two keys)
  sess.sync({ full: true });
  assert.equal(st.clashes[0].status, 'closed');
});

// Deny with a reason (docs/INTERNALS.md §21.58): the reason is a clash field
// of its own (`deniedReason`); who / when come from the status record.
test('a deny reason is shared with the status; the teammate gets who / when from the record; reopen clears it', () => {
  const a = app('ua'), b = app('ub');
  b.sess.sync({});
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { status: 'denied', deniedReason: 'insulation only' } });
  assert.deepEqual(a.sess.outbox().map((r) => [r.target.kind, r.target.key, r.field, r.value]).sort(),
    [['clash', 'A|B@0,0,0', 'deniedReason', 'insulation only'], ['clash', 'A|B@0,0,0', 'status', 'denied']]);
  const mine = a.sess.takeBatch(); a.sess.done(mine);
  const r = b.sess.ingest(mine, { ua: 'Ann' });
  b.sess.sync({ touched: r.touched, remote: r.added });
  const got = b.st.clashes[0];
  assert.equal(got.status, 'denied');
  assert.equal(got.deniedReason, 'insulation only');
  assert.equal(got.deniedBy, 'Ann');
  assert.equal(got.deniedAt, mine.find((x) => x.field === 'status').ts);
  // reopening (status only) also clears the reason for everyone
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { status: 'open' } });
  assert.ok(a.sess.outbox().some((x) => x.field === 'deniedReason' && x.value === ''));
  a.exchange(b);
  assert.equal(b.st.clashes[0].status, 'open');
  assert.equal(b.st.clashes[0].deniedReason, '');
});

test('two people giving a denied clash different reasons is a conflict both see; both denying is not', () => {
  const a = app('ua'), b = app('ub');
  a.sess.sync({}); b.sess.sync({});
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { status: 'denied' } });
  a.exchange(b);
  assert.equal(b.st.clashes[0].status, 'denied');
  a.act({ t: 'UPD_CLASH', id: 'c1-ua', u: { deniedReason: 'sleeve provided' } });
  b.act({ t: 'UPD_CLASH', id: 'c1-ub', u: { deniedReason: 'outside scope' } });
  a.exchange(b); b.exchange(a);
  for (const p of [a, b]) {
    const m = p.st.clashes[0]._sharedConflict;
    assert.ok(m && m.length === 1, 'one conflict marker');
    assert.equal(m[0].field, 'deniedReason');
    assert.deepEqual(m[0].heads.map((h) => h.value).sort(), ['outside scope', 'sleeve provided']);
    assert.equal(p.sess.conflictCount(), 1);
  }
  // both denying (status) at once is never a conflict: the same value
  const c = app('uc'), e = app('ue');
  c.sess.sync({}); e.sess.sync({});
  c.act({ t: 'UPD_CLASH', id: 'c1-uc', u: { status: 'denied' } });
  e.act({ t: 'UPD_CLASH', id: 'c1-ue', u: { status: 'denied' } });
  c.exchange(e); e.exchange(c);
  assert.equal(c.sess.conflictCount() + e.sess.conflictCount(), 0);
});

test('undo of a run\'s issue changes (CLASH_BATCH_RESTORE issuePrev) is shared as issue edits', () => {
  const a = app('ua');
  a.sess.sync({});
  const prev = { clashes: a.st.clashes, issues: [{ id: 'iss_r', title: 'Duct', status: 'resolved', comments: [{ id: 'rc1', text: 'Resolved by re-check' }] }] };
  a.sess.note({ t: 'CLASH_BATCH_RESTORE', prev: {}, keepIssueIds: null, issuePrev: { iss_r: { status: 'open', comments: [] } } }, prev, null);
  assert.deepEqual(a.sess.outbox().map((r) => [r.target.key, r.field, r.value]), [['iss_r', 'status', 'open'], ['iss_r', 'comment:rc1', null]]);
});
