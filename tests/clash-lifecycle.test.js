'use strict';
// Clash identity → issue lifecycle (docs/INTERNALS.md §21.58): linked issues
// follow their clash across re-runs, and the denied memory is project state
// (saved with the project, imported once from the old per-browser store).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../clash-reconciliation-core.js');
const identity = require('../clash-identity-core.js');
const codec = require('../project-codec.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s !== -1, startMarker + ' not found');
  const e = src.indexOf(endMarker, s);
  assert.ok(e !== -1, endMarker + ' not found');
  return src.slice(s, e + endMarker.length);
}

function clash(id, a, b, point, extra) {
  return Object.assign({ id, uniqueIdA: a, uniqueIdB: b, point: point || [0, 0, 0], distance: -10, status: 'open', type: 'hard' }, extra || {});
}
function deps(extra) {
  return Object.assign({ computeClashIdentityKey: identity.computeClashIdentityKey, computeClashPair: identity.computeClashPair, isDeniedClash: () => false, now: 2000 }, extra || {});
}

// ── The pure rules (clash-reconciliation-core.js) ───────────────────

test('a run that no longer finds a linked clash resolves its open issue, with a comment and a marker', () => {
  const prev = [clash('c1', 'a', 'b', [0, 0, 0], { linkedIssueId: 'i1', status: 'in_progress', _identityKey: 'K1' })];
  const merged = R.mergeDetectionResults([], prev, deps()).clashes;
  assert.equal(merged[0]._delta, 'auto_resolved');
  const issues = [{ id: 'i1', status: 'in_progress', comments: [{ id: 'x', text: 'mine' }] }];
  const lc = R.applyIssueLifecycle(merged, issues, { now: 5, resolvedText: () => 'Resolved by re-check on D' });
  assert.equal(lc.resolved, 1);
  const it = lc.issues[0];
  assert.equal(it.status, 'resolved');
  assert.deepEqual(it.autoResolved, { ts: 5, prevStatus: 'in_progress', clashKey: merged[0]._identityKey });
  assert.equal(it.comments.length, 2);
  assert.equal(it.comments[1].text, 'Resolved by re-check on D');
  assert.equal(it.comments[1].system, 'recheck');
  assert.deepEqual(lc.issueChanges[0].prev, { status: 'in_progress', autoResolved: null, comments: issues[0].comments });
  assert.notEqual(lc.issues, issues, 'new array');
  assert.equal(issues[0].status, 'in_progress', 'input not mutated');
});

test('an issue a person resolved, closed or flagged is never touched by a run', () => {
  const merged = [clash('c1', 'a', 'b', null, { linkedIssueId: 'i1', _delta: 'auto_resolved', status: 'auto_resolved' }),
    clash('c2', 'a', 'c', null, { linkedIssueId: 'i2', _delta: 'auto_resolved', status: 'auto_resolved' }),
    clash('c3', 'a', 'd', null, { linkedIssueId: 'i3', _delta: 'auto_resolved', status: 'auto_resolved' }),
    clash('c4', 'a', 'e', null, { linkedIssueId: 'i4', _delta: 'persisting' })];
  const issues = [{ id: 'i1', status: 'resolved' }, { id: 'i2', status: 'closed' }, { id: 'i3', status: 'accepted_needs_check' },
    { id: 'i4', status: 'resolved' } /* resolved by a person: no marker, its clash persists — stays resolved */];
  const lc = R.applyIssueLifecycle(merged, issues, {});
  assert.equal(lc.resolved + lc.reopened, 0);
  assert.equal(lc.issues, issues, 'same array when nothing changed');
});

test('a confirmed clash with an issue is auto-resolved when gone and comes back confirmed; its issue reopens', () => {
  const prev = [clash('c1', 'a', 'b', [1, 1, 1], { status: 'confirmed', linkedIssueId: 'i1' })];
  const run1 = R.mergeDetectionResults([], prev, deps()).clashes;
  assert.equal(run1.length, 1, 'kept (used to be dropped from the list)');
  assert.equal(run1[0].status, 'auto_resolved');
  assert.equal(run1[0]._preAutoStatus, 'confirmed');
  const lc1 = R.applyIssueLifecycle(run1, [{ id: 'i1', status: 'open' }], { now: 10 });
  assert.equal(lc1.issues[0].status, 'resolved');
  // the clash is found again
  const run2 = R.mergeDetectionResults([clash('new1', 'a', 'b', [1, 1, 1])], run1, deps({ now: 3000 })).clashes;
  assert.equal(run2[0]._delta, 'persisting');
  assert.equal(run2[0].status, 'confirmed', 'confirmed again, not a fresh open clash');
  assert.equal(run2[0].linkedIssueId, 'i1');
  const lc2 = R.applyIssueLifecycle(run2, lc1.issues, { now: 20, reopenedText: () => 'again' });
  assert.equal(lc2.reopened, 1);
  assert.equal(lc2.issues[0].status, 'open', 'its status before the auto-resolve');
  assert.equal(lc2.issues[0].autoResolved, null);
  assert.equal(lc2.issues[0].comments.at(-1).text, 'again');
});

test('found again after the auto-resolved record left the list: matched by identity, re-linked and reopened', () => {
  const key = identity.computeClashIdentityKey(clash('x', 'a', 'b', [2, 0, 0]));
  const issues = [{ id: 'i1', status: 'resolved', autoResolved: { ts: 1, prevStatus: 'in_progress', clashKey: key } }];
  const merged = R.mergeDetectionResults([clash('n1', 'a', 'b', [2, 0, 0])], [clash('other', 'q', 'r')], deps()).clashes;
  const fresh = merged.find((c) => c.id === 'n1');
  assert.equal(fresh._delta, 'new');
  const lc = R.applyIssueLifecycle(merged, issues, {});
  assert.equal(lc.reopened, 1);
  assert.equal(lc.issues[0].status, 'in_progress');
  assert.equal(lc.clashes.find((c) => c.id === 'n1').linkedIssueId, 'i1');
  assert.deepEqual(lc.clashChanges, [{ id: 'n1', prev: { linkedIssueId: null }, next: { linkedIssueId: 'i1' } }]);
  // a person changed it after the run (no marker any more): never reopened
  const lc2 = R.applyIssueLifecycle(merged, [{ id: 'i1', status: 'resolved', autoResolved: null }], {});
  assert.equal(lc2.reopened, 0);
});

// ── The reducer (MERGE_CLASHES + its undo), extracted by text ────────

function reducerHarness() {
  const lifecycle = slice('  function _ccIssueLifecycle(clashes, issues, a) {', '    return lc;\n  }');
  // the run-history entry (clash-history-core.js absent here: run totals only)
  const historyEntry = slice('  function _ccRunHistoryEntry(clashes, delta, rules) {', '    return { ts: delta.ts, total: (clashes || []).length, open: open, newCount: delta.newCount, persisting: delta.persisting, autoResolved: delta.autoResolved };\n  }');
  const merge = slice('      case A.SET_CLASHES:', '        return Object.assign({},s,_st);');
  const restore = slice('      case A.CLASH_BATCH_RESTORE:', '          issues:_cbrIssues\n        });');
  const A = { SET_CLASHES: 'SET_CLASHES', MERGE_CLASHES: 'MERGE_CLASHES', CLASH_BATCH_RESTORE: 'CLASH_BATCH_RESTORE' };
  const undo = [];
  const win = { _ccClashReconciliationCore: R };
  const t = (k, en, v) => en.replace(/\{(\w+)\}/g, (m, x) => (v && x in v ? String(v[x]) : m));
  function mergeDetectionResults(next, prev, cov, denied) {
    return R.mergeDetectionResults(next, prev, deps({ now: undefined, isDeniedClash: R.makeDeniedMatcher(denied, identity.computeClashPair) }));
  }
  const make = new Function('A', 'window', '_cc_t', '_ccPushUndoable', 'mergeDetectionResults', '_ccApplyAssignmentRules', '_gcEvent', 'deriveFloors', 'INIT_FILTERS', '_ccChangelogUser',
    lifecycle + '\n' + historyEntry + '\nreturn function reducer(s, a) { switch (a.t) {\n' + merge + '\n' + restore + '\n default: return s; } };');
  const reducer = make(A, win, t, (e) => undo.push(e), mergeDetectionResults, (c) => c, () => {}, () => [], {}, 'Ann');
  let state;
  win._ccDispatch = (a) => { state = reducer(state, a); };
  return { A, undo, reducer, get state() { return state; }, set state(v) { state = v; } };
}

test('reducer: a run auto-resolves a linked clash → the issue is resolved, History entry, record for the toast; undo / redo', () => {
  const h = reducerHarness();
  const linked = clash('c1', 'a', 'b', [0, 0, 0], { status: 'confirmed', linkedIssueId: 'i1' });
  const other = clash('c2', 'p', 'q', [5, 5, 5]);
  h.state = { clashes: [linked, other], issues: [{ id: 'i1', status: 'open', comments: [] }, { id: 'i2', status: 'closed' }],
    prefs: {}, filters: {}, changelog: [], runHistory: [], clashGroupBy: ['element'], deniedPairs: {} };
  h.state = h.reducer(h.state, { t: 'MERGE_CLASHES', v: [clash('n2', 'p', 'q', [5, 5, 5])] });
  const iss = h.state.issues.find((i) => i.id === 'i1');
  assert.equal(iss.status, 'resolved');
  assert.match(iss.comments[0].text, /^Resolved by re-check on /);
  assert.equal(h.state.issues.find((i) => i.id === 'i2').status, 'closed');
  assert.equal(h.state.lastIssueLifecycle.resolved, 1);
  assert.equal(h.state.lastDeltaSummary.issuesResolved, 1);
  assert.deepEqual(h.state.changelog.map((e) => [e.targetId, e.field, e.value, e.prev, e.user]), [['i1', 'status', 'resolved', 'open', 'Ann']]);
  assert.equal(h.undo.length, 1, 'one undo step');
  h.undo[0].undo();
  const back = h.state.issues.find((i) => i.id === 'i1');
  assert.equal(back.status, 'open');
  assert.deepEqual(back.comments, []);
  assert.equal(back.autoResolved, null);
  h.undo[0].redo();
  assert.equal(h.state.issues.find((i) => i.id === 'i1').status, 'resolved');
  // a replayed merge (undo machinery) never pushes another entry
  h.reducer(h.state, { t: 'MERGE_CLASHES', v: [], _ccReplay: true });
  assert.equal(h.undo.length, 1);
});

test('reducer: the clash found again reopens the issue it auto-resolved; SET_CLASHES (project load) never touches issues', () => {
  const h = reducerHarness();
  h.state = { clashes: [clash('c1', 'a', 'b', [0, 0, 0], { status: 'in_progress', linkedIssueId: 'i1' })], issues: [{ id: 'i1', status: 'in_progress' }],
    prefs: {}, filters: {}, changelog: [], runHistory: [], clashGroupBy: ['element'], deniedPairs: {} };
  h.state = h.reducer(h.state, { t: 'MERGE_CLASHES', v: [] });
  assert.equal(h.state.issues[0].status, 'resolved');
  h.state = h.reducer(h.state, { t: 'MERGE_CLASHES', v: [clash('again', 'a', 'b', [0, 0, 0])] });
  assert.equal(h.state.issues[0].status, 'in_progress');
  assert.match(h.state.issues[0].comments.at(-1).text, /^Reopened: the clash was found again by re-check on /);
  assert.equal(h.state.lastIssueLifecycle.reopened, 1);
  const before = h.state.issues;
  h.state = h.reducer(h.state, { t: 'SET_CLASHES', v: [] });
  assert.equal(h.state.issues, before);
});

test('wiring: the toast and the shared records come from lastIssueLifecycle; a person\'s status edit ends the marker', () => {
  assert.match(src, /lifecycle\.toastResolved', '\{n\} issues resolved by this run'/);
  assert.match(src, /SSC\.noteAll\(\{t:'UPD_ISSUE', id:ch\.id, u:\{status:ch\.next\.status, comments:ch\.next\.comments\}\}/);
  assert.match(src, /if\(a\.u&&'status' in a\.u&&!\('autoResolved' in a\.u\)&&!a\._fromSync&&i\.autoResolved\) _iu\.autoResolved=null;/);
});

// ── Denied memory ───────────────────────────────────────────────────

test('denied memory follows deny / reason / reopen; the matcher drops the same pair within 150 mm only', () => {
  const D = { computeClashIdentityKey: identity.computeClashIdentityKey, computeClashPair: identity.computeClashPair };
  const c = clash('c1', 'a', 'b', [1, 0, 0]);
  const denied = Object.assign({}, c, { status: 'denied', deniedReason: '', deniedBy: 'Ann', deniedAt: 7 });
  const m1 = R.updateDeniedMemory({}, [c], [denied], D);
  const key = identity.computeClashIdentityKey(c);
  assert.deepEqual(m1[key], { pair: identity.computeClashPair(c), point: [1, 0, 0], ts: 7, reason: '', by: 'Ann' });
  assert.equal(R.updateDeniedMemory(m1, [denied], [denied], D), m1, 'no change → same object');
  const withReason = Object.assign({}, denied, { deniedReason: 'insulation only' });
  const m2 = R.updateDeniedMemory(m1, [denied], [withReason], D);
  assert.equal(m2[key].reason, 'insulation only');
  assert.equal(m2[key].ts, 7);
  const match = R.makeDeniedMatcher(m2, identity.computeClashPair);
  assert.equal(match(clash('n', 'a', 'b', [1.1, 0, 0])), true, '100 mm away');
  assert.equal(match(clash('n', 'a', 'b', [1.2, 0, 0])), false, '200 mm away');
  assert.equal(match(clash('n', 'a', 'z', [1, 0, 0])), false, 'other pair');
  const reopened = Object.assign({}, withReason, { status: 'open' });
  const m3 = R.updateDeniedMemory(m2, [withReason], [reopened], D);
  assert.deepEqual(m3, {});
  // a run drops what the memory denies
  const out = R.mergeDetectionResults([clash('n', 'a', 'b', [1.05, 0, 0]), clash('k', 'x', 'y')], [], deps({ isDeniedClash: match }));
  assert.deepEqual(out.clashes.map((x) => x.id), ['k']);
});

test('wiring: no localStorage writes of the denied memory; the app reducer keeps it in step', () => {
  assert.doesNotMatch(src, /_saveDeniedClash|_forgetDeniedClash|_isDeniedClash/);
  assert.doesNotMatch(src, /_ccLsSet\('cc_denied_clashes'/);
  const follow = slice('  function _ccFollowDeniedMemory(prev, next, a) {', '\n  }');
  const fn = new Function('window', '_CC_DENY_FOLLOW', 'computeClashIdentityKey', 'computeClashPair', follow + '\nreturn _ccFollowDeniedMemory;')(
    { _ccClashReconciliationCore: R }, { UPD_CLASH: 1, BATCH_UPD_CLASH: 1, CLASH_BATCH_RESTORE: 1 }, identity.computeClashIdentityKey, identity.computeClashPair);
  const c = clash('c1', 'a', 'b');
  const prev = { clashes: [c], deniedPairs: {} };
  const next = { clashes: [Object.assign({}, c, { status: 'denied' })], deniedPairs: {} };
  assert.equal(Object.keys(fn(prev, next, { t: 'UPD_CLASH' }).deniedPairs).length, 1);
  assert.equal(fn(prev, next, { t: 'MERGE_CLASHES' }), next, 'a run does not write the memory');
  // undo of the deny (CLASH_BATCH_RESTORE back to open) forgets it again
  const denied = fn(prev, next, { t: 'UPD_CLASH' });
  const undone = fn(denied, { clashes: [c], deniedPairs: denied.deniedPairs }, { t: 'CLASH_BATCH_RESTORE' });
  assert.deepEqual(undone.deniedPairs, {});
});

// ── Project codec ───────────────────────────────────────────────────

const ACT = { ADD_MODEL: 'AM', UPD_RULES: 'UR', SET_CLASHES: 'SC', DENIED_SET: 'DS' };

test('project codec: the denied memory round-trips and is restored before the clashes', () => {
  const mem = { K1: { pair: 'a|b', point: [1, 2, 3], ts: 5, reason: 'sleeve', by: 'Ann' } };
  const out = codec.serializeProject({ rules: {}, models: [], clashes: [clash('c', 'a', 'b')], issues: [], floors: [], deniedPairs: mem }, 'v', 't');
  assert.deepEqual(out.deniedPairs, mem);
  const data = JSON.parse(JSON.stringify(out));
  const acts = [];
  codec.restoreProject(data, (a) => acts.push(a), ACT, { legacyDenied: { 'x|y': { point: [0, 0, 0], ts: 1 } } });
  const ds = acts.findIndex((a) => a.t === 'DS'), sc = acts.findIndex((a) => a.t === 'SC');
  assert.ok(ds !== -1 && ds < sc, 'denied memory before the clashes');
  assert.deepEqual(acts[ds].v, mem, 'a file with its own memory never takes the old store');
  // an empty memory saved with the project stays empty
  const acts2 = [];
  codec.restoreProject(Object.assign({}, data, { deniedPairs: {} }), (a) => acts2.push(a), ACT, { legacyDenied: { 'x|y': { point: [0, 0, 0], ts: 1 } } });
  assert.deepEqual(acts2.find((a) => a.t === 'DS').v, {});
});

test('project codec: a file saved before deniedPairs imports the old per-browser store once', () => {
  const legacy = { 'a|b': { point: [1, 2, 3], ts: 9 }, bad: { ts: 1 } };
  assert.deepEqual(codec.importLegacyDenied(legacy), { 'legacy:a|b': { pair: 'a|b', point: [1, 2, 3], ts: 9, reason: '', by: '' } });
  assert.deepEqual(codec.importLegacyDenied(null), {});
  const acts = [];
  codec.restoreProject({ _cc: 'ClashControl', rules: {}, models: [], clashes: [] }, (a) => acts.push(a), ACT, { legacyDenied: legacy });
  const mem = acts.find((a) => a.t === 'DS').v;
  assert.deepEqual(Object.keys(mem), ['legacy:a|b']);
  // the imported entry drops the same pair, as the old store did
  const match = R.makeDeniedMatcher(mem, (c) => c.pair);
  assert.equal(match({ pair: 'a|b', point: [1, 2, 3.1] }), true);
  // saved again, the file carries its own memory: the old store is not applied a second time
  const resaved = codec.serializeProject({ rules: {}, models: [], clashes: [], issues: [], floors: [], deniedPairs: {} }, 'v', 't');
  const acts2 = [];
  codec.restoreProject(resaved, (a) => acts2.push(a), ACT, { legacyDenied: legacy });
  assert.deepEqual(acts2.find((a) => a.t === 'DS').v, {});
  // the IndexedDB project restore does the same for a project saved before
  assert.match(src, /if\(!data\.deniedPairs \|\| typeof data\.deniedPairs !== 'object'\) data\.deniedPairs = _ccProjectCodec\.importLegacyDenied\(_getDeniedClashStore\(\)\);/);
  assert.match(src, /_ccProjectCodec\.restoreProject\(data, dispatch, _ccProjectActionTypes\(\), \{legacyDenied:_getDeniedClashStore\(\)\}\)/);
});
