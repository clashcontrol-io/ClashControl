'use strict';
// Locks _saveCurrentProjectData (index.html) - the IndexedDB auto-persist
// path (survives a refresh/project-switch with no manual export), separate
// from the explicit "Export Project" saveProject/loadProject JSON
// round-trip. selectionSets predated this session and searchSets was added
// this session, but neither was ever included here - either would silently
// vanish on the next page load unless the user happened to export/import a
// project file. LOAD_PROJECT_STATE (the restore side) is a blind
// Object.assign merge, so the save side is the entire fix.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const header = 'function ' + name + '(';
  const start = src.indexOf('  ' + header);
  assert.ok(start !== -1, name + ' not found');
  const end = src.indexOf('\n  }', start) + '\n  }'.length;
  return src.slice(start, end);
}

// The autosave-gate memo lives in two module-level vars next to the
// function — extract them too so the bundle is self-contained.
function extractGateDecls() {
  const start = src.indexOf('  var _ccAutosaveMemo');
  assert.ok(start !== -1, '_ccAutosaveMemo declaration not found');
  const end = src.indexOf('];', start) + 2;
  return src.slice(start, end);
}

function makeRunner(windowStub) {
  const bundle = extractGateDecls() + '\n' + extractFn('_cloneSafe') + '\n' + extractFn('_saveCurrentProjectData');
  const calls = [];
  const idbSaveProjectData = (pid, data) => { calls.push({ pid, data }); return Promise.resolve(); };
  const save = new Function('idbSaveProjectData', 'window', bundle + '; return _saveCurrentProjectData;')(
    idbSaveProjectData, windowStub);
  return { save, calls };
}

function run(s) {
  const r = makeRunner(undefined);
  r.save(s);
  const last = r.calls[r.calls.length - 1] || { pid: null, data: null };
  return { pid: last.pid, data: last.data };
}

const GATE_ON_WINDOW = { _ccSafetyMigrations: { isEnabled: (f) => f === 'storageAutosaveGate' } };

function baseState(extra) {
  return Object.assign({
    activeProject: 'proj1', clashes: [], issues: [], rules: {}, floors: [],
    viewpoints: [], measurements: [], filters: {}, sheets: [], sheetPins: [],
    markups: [], models: [],
  }, extra);
}

test('selectionSets are included in the IndexedDB auto-persist payload', () => {
  const sets = [{ id: 'a', name: 'MEP risers', refs: [{ expressId: 1, modelId: 'm1' }], color: null, createdAt: '2026-01-01' }];
  const { data } = run(baseState({ selectionSets: sets }));
  assert.deepEqual(data.selectionSets, sets);
});

test('searchSets are included in the IndexedDB auto-persist payload', () => {
  const sets = [{ id: 'a', name: 'Fire doors', query: { ifcType: 'IfcDoor' }, color: null, createdAt: '2026-01-01' }];
  const { data } = run(baseState({ searchSets: sets }));
  assert.deepEqual(data.searchSets, sets);
});

test('missing selectionSets/searchSets on state default to empty arrays, not undefined (so LOAD_PROJECT_STATE never restores stale sets from a previous project)', () => {
  const { data } = run(baseState({}));
  assert.deepEqual(data.selectionSets, []);
  assert.deepEqual(data.searchSets, []);
});

test('pre-existing fields (clashes, rules, viewpoints snapshot stripping) are unaffected by this addition', () => {
  const { pid, data } = run(baseState({
    activeProject: 'proj2', clashes: [{ id: 'c1' }],
    viewpoints: [{ id: 'v1', linkedId: 'c1', snapshot: 'data:image/png;base64,AAAA' }],
  }));
  assert.equal(pid, 'proj2');
  assert.deepEqual(data.clashes, [{ id: 'c1' }]);
  assert.equal(data.viewpoints[0].snapshot, undefined, 'snapshots are still stripped before IDB persist');
});

// ── storageAutosaveGate (flagged, default-off) ─────────────────────

test('gate ON: a fully identity-unchanged state skips the second write', async () => {
  const r = makeRunner(GATE_ON_WINDOW);
  const s = baseState({});
  await r.save(s);
  const verdict = await r.save(s);
  assert.equal(r.calls.length, 1, 'second save with unchanged slices must not write');
  assert.equal(verdict, 'unchanged');
});

test('gate ON: any changed slice identity writes again', async () => {
  const r = makeRunner(GATE_ON_WINDOW);
  const s = baseState({});
  await r.save(s);
  await r.save(Object.assign({}, s, { clashes: [{ id: 'c-new' }] }));
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[1].data.clashes, [{ id: 'c-new' }]);
});

test('gate ON: a different project id never reuses the memo', async () => {
  const r = makeRunner(GATE_ON_WINDOW);
  const s = baseState({});
  await r.save(s);
  await r.save(Object.assign({}, s, { activeProject: 'proj-other' }));
  assert.equal(r.calls.length, 2);
});

test('gate ON: force bypasses the gate (the pagehide/switch flush path)', async () => {
  const r = makeRunner(GATE_ON_WINDOW);
  const s = baseState({});
  await r.save(s);
  await r.save(s, { force: true });
  assert.equal(r.calls.length, 2, 'forced flush always writes');
});

test('gate OFF (default) and no window: every save writes, as before', async () => {
  const r = makeRunner(undefined);
  const s = baseState({});
  await r.save(s);
  await r.save(s);
  assert.equal(r.calls.length, 2);
});
