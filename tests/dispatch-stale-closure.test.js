'use strict';
// Locks the fix for App()'s dispatch wrapper (`d = useCallback(..., [])`)
// reading render-time `s` directly instead of through a ref. Because the
// useCallback has an empty dep array, `d` is created once at mount and never
// recreated — so any `s.issues` / `s.selected` / bare `s` read inside it was
// frozen at the FIRST render forever. In practice this meant BATCH_UPD_CLASH,
// BATCH_UPD_ISSUE and UPD_ISSUE's shared-sync push and changelog-entry logic
// (which need s.selected / s.issues) always saw the initial (usually empty)
// state, so those actions never actually enqueued a sync push or produced a
// changelog entry once the app had done any real work.
//
// This extracts the exact source block (ref setup + the `d` useCallback) out
// of index.html and actually RUNS it — real extract-and-simulate, not a
// substring match — with a minimal useRef/useCallback harness that mimics
// React's persistent-ref-across-renders semantics, so a regression back to
// reading bare `s` inside the callback fails this test rather than only
// showing up as a silent behavioral bug in the running app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const startMarker = 'var _clashesRef = useRef(s.clashes);';
const endMarker = "}, []);\n    window._ccDispatch = d;";
const start = src.indexOf(startMarker);
assert.ok(start !== -1, 'ref setup block not found in App()');
const end = src.indexOf(endMarker, start);
assert.ok(end !== -1, 'end of the d useCallback not found');
// Include the closing `}, []);` of the useCallback, drop the trailing
// `window._ccDispatch = d;` (not needed by the harness).
const block = src.slice(start, end + '}, []);'.length);

function makeHookEnv() {
  const refs = [];
  let idx = 0;
  function useRef(initial) {
    if (idx >= refs.length) refs.push({ current: initial });
    return refs[idx++];
  }
  let memoFn = null;
  function useCallback(fn /*, deps */) {
    // deps is always [] in the real code — memoize on first call only,
    // exactly like React does for an empty dep array.
    if (memoFn === null) memoFn = fn;
    return memoFn;
  }
  return {
    useRef,
    useCallback,
    resetRenderCycle() { idx = 0; },
  };
}

// Builds `d` for a given render's `s`, using the SAME hookEnv/refs across
// calls (simulating React re-rendering the same component instance).
function renderAndGetDispatch(hookEnv, s, collab) {
  hookEnv.resetRenderCycle();
  const factory = new Function(
    's', 'useRef', 'useCallback', '_rawD', 'A', '_buildChangelogEntry',
    '_sharedEnqueue', '_sharedProjectId', '_saveClashTrainRecord',
    block + '\nreturn d;'
  );
  return factory(
    s, hookEnv.useRef, hookEnv.useCallback, collab._rawD, collab.A,
    collab._buildChangelogEntry, collab._sharedEnqueue, collab._sharedProjectId,
    collab._saveClashTrainRecord
  );
}

test('dispatch wrapper reads s.selected/s.issues via refs updated every render, not the stale mount-time s', () => {
  const A = { BATCH_UPD_CLASH: 'BATCH_UPD_CLASH', UPD_ISSUE: 'UPD_ISSUE', APPEND_CHANGELOG: 'APPEND_CHANGELOG', MERGE_CHANGELOG: 'MERGE_CHANGELOG' };
  const rawDActions = [];
  const enqueued = [];
  const collab = {
    _rawD: (a) => rawDActions.push(a),
    A,
    _buildChangelogEntry: () => null, // not under test here
    _sharedEnqueue: (rec) => enqueued.push(rec),
    _sharedProjectId: () => 'PROJ-abc123',
    _saveClashTrainRecord: () => {},
  };
  const hookEnv = makeHookEnv();

  // Render 1 (mount): empty state, matching a fresh app with nothing loaded.
  const s1 = { clashes: [], issues: [], selected: {}, trainingMode: true };
  renderAndGetDispatch(hookEnv, s1, collab);

  // Render 2: real data has arrived — a clash exists and is selected.
  const clash = { id: 'c1', status: 'open' };
  const s2 = { clashes: [clash], issues: [], selected: { c1: true }, trainingMode: true };
  const d = renderAndGetDispatch(hookEnv, s2, collab);

  // Dispatch a BATCH_UPD_CLASH — this must see render 2's selection (c1
  // selected), not render 1's (nothing selected). Before the fix, `d` was
  // memoized at render 1 and its closure's `s` was permanently {selected:{}}.
  d({ t: A.BATCH_UPD_CLASH, u: { status: 'resolved' } });

  assert.equal(enqueued.length, 1, 'BATCH_UPD_CLASH must enqueue a shared-sync push for the currently-selected clash');
  assert.equal(enqueued[0].id, 'c1');
  assert.equal(enqueued[0].status, 'resolved');
});

test('dispatch wrapper picks up newly-added issues via a ref, not the mount-time s.issues', () => {
  const A = { UPD_ISSUE: 'UPD_ISSUE', APPEND_CHANGELOG: 'APPEND_CHANGELOG', MERGE_CHANGELOG: 'MERGE_CHANGELOG' };
  const enqueued = [];
  const collab = {
    _rawD: () => {},
    A,
    _buildChangelogEntry: () => null,
    _sharedEnqueue: (rec) => enqueued.push(rec),
    _sharedProjectId: () => 'PROJ-abc123',
    _saveClashTrainRecord: () => {},
  };
  const hookEnv = makeHookEnv();

  const s1 = { clashes: [], issues: [], selected: {}, trainingMode: true };
  renderAndGetDispatch(hookEnv, s1, collab);

  const issue = { id: 'i1', title: 'Leak' };
  const s2 = { clashes: [], issues: [issue], selected: {}, trainingMode: true };
  const d = renderAndGetDispatch(hookEnv, s2, collab);

  d({ t: A.UPD_ISSUE, id: 'i1', u: { status: 'closed' } });

  assert.equal(enqueued.length, 1, 'UPD_ISSUE must find the issue via the latest s.issues, not the mount-time (empty) one');
  assert.equal(enqueued[0].id, 'i1');
  assert.equal(enqueued[0].status, 'closed');
});
