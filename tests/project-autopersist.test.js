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

// The autosave-gate memo, its slice list and the modelMeta helpers live
// next to the function — extract them too so the bundle is self-contained.
function extractGateDecls() {
  const start = src.indexOf('  var _ccAutosaveMemo');
  assert.ok(start !== -1, '_ccAutosaveMemo declaration not found');
  const end = src.indexOf('  function _saveCurrentProjectData(', start);
  return src.slice(start, end);
}

// The view keys saved with the project come from the state-scope registry.
function extractScope() {
  const start = src.indexOf('  var _CC_STATE_SCOPE = (function(){');
  const end = src.indexOf('  // Before the view was project state', start);
  assert.ok(start !== -1 && end > start, 'state-scope registry not found');
  return 'var INIT = {};\n' + src.slice(start, end);
}

function makeRunner(windowStub) {
  const bundle = extractScope() + '\n' + extractGateDecls() + '\n' + extractFn('_cloneSafe') + '\nvar _ccSaveCloneCache = new WeakMap();\n' + extractFn('_ccCloneListCached') + '\n' + extractFn('_saveCurrentProjectData');
  const calls = [];
  const idbSaveProjectData = (pid, data) => { calls.push({ pid, data }); return Promise.resolve(); };
  const save = new Function('idbSaveProjectData', 'window', bundle + '; return _saveCurrentProjectData;')(
    idbSaveProjectData, windowStub || {});
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

test('_trainFV (per-run training vector) is stripped from persisted clashes', () => {
  const { data } = run(baseState({
    clashes: [{ id: 'c1', type: 'hard', distance: -12,
      _trainFV: { type_pair: 'IfcWall|IfcPipe', pen_depth_mm: 12 } }],
  }));
  assert.equal(data.clashes[0]._trainFV, undefined, '_trainFV must not reach IndexedDB');
  assert.equal(data.clashes[0].distance, -12, 'real fields survive');
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

test('autosave clones each unchanged clash once and reuses it on the next save', () => {
  const r = makeRunner(undefined);
  const clashes = [{ id: 'a', status: 'open', point: [1, 2, 3] }, { id: 'b', status: 'open' }];
  r.save(baseState({ clashes }));
  const edited = [clashes[0], Object.assign({}, clashes[1], { status: 'resolved' })];
  r.save(baseState({ clashes: edited }));
  const [first, second] = r.calls.map((c) => c.data.clashes);
  assert.deepStrictEqual(second, [{ id: 'a', status: 'open', point: [1, 2, 3] }, { id: 'b', status: 'resolved' }]);
  assert.strictEqual(second[0], first[0], 'the unchanged clash reuses its clone');
  assert.notStrictEqual(second[1], first[1], 'the edited clash is cloned again');
  assert.notStrictEqual(second[0], clashes[0], 'a clone, never the state object itself');
});

// ── models persist only as modelMeta ───────────────────────────────

test('gate ON: a new models array with the same persisted metadata (storey hide, load progress) skips the write', async () => {
  const r = makeRunner(GATE_ON_WINDOW);
  const m = { id: 'm1', name: 'Arch', discipline: 'architectural', color: '#fff', visible: true, tag: '', elements: [] };
  const s = baseState({ models: [m] });
  await r.save(s);
  const verdict = await r.save(Object.assign({}, s, { models: [Object.assign({}, m, { hiddenStoreys: ['L1'], elements: [{}] })] }));
  assert.equal(verdict, 'unchanged');
  assert.equal(r.calls.length, 1);
});

test('gate ON: a model visibility toggle or rename (persisted modelMeta) writes', async () => {
  const r = makeRunner(GATE_ON_WINDOW);
  const m = { id: 'm1', name: 'Arch', discipline: 'architectural', color: '#fff', visible: true };
  const s = baseState({ models: [m] });
  await r.save(s);
  await r.save(Object.assign({}, s, { models: [Object.assign({}, m, { visible: false })] }));
  await r.save(Object.assign({}, s, { models: [Object.assign({}, m, { visible: false, name: 'Arch 2' })] }));
  assert.equal(r.calls.length, 3);
  assert.equal(r.calls[1].data.modelMeta[0].visible, false);
  assert.equal(r.calls[2].data.modelMeta[0].name, 'Arch 2');
});

test('gate ON: a failed write does not record the memo (the next save is not skipped)', async () => {
  const bundle = extractScope() + '\n' + extractGateDecls() + '\n' + extractFn('_cloneSafe') + '\nvar _ccSaveCloneCache = new WeakMap();\n' + extractFn('_ccCloneListCached') + '\n' + extractFn('_saveCurrentProjectData');
  let n = 0;
  const save = new Function('idbSaveProjectData', 'window', bundle + '; return _saveCurrentProjectData;')(
    () => { n++; return Promise.resolve(n === 1 ? 'failed' : undefined); }, GATE_ON_WINDOW);
  const s = baseState({});
  await save(s);
  await save(s);
  assert.equal(n, 2, 'after a failed write the same state is written again');
});

test('the autosave effect is keyed on the modelMeta signature, not on s.models identity', () => {
  const i = src.indexOf('function run(){ idle = 0; if(_hasProjectData(s)) _saveCurrentProjectData(s); }');
  assert.ok(i !== -1);
  const deps = src.slice(i, src.indexOf(']);', i) + 3);
  assert.match(deps, /_ccModelMetaSig\(s\.models\)/);
  assert.doesNotMatch(deps, /s\.rules, s\.models,/);
});

test('the project view (section, hidden categories) and smart views are saved with the project', () => {
  const box = { enabled: true, min: [0, 0, 0], max: [1, 1, 1] };
  const { data } = run(baseState({ sectionAxis: 'x', sectionPos: 0.4, sectionBox: box, sectionFlip: true, hiddenClasses: { 'byType:IfcDoor': true }, smartViews: [{ id: 'sv' }] }));
  assert.equal(data.sectionAxis, 'x');
  assert.equal(data.sectionPos, 0.4);
  assert.deepEqual(data.sectionBox, box);
  assert.equal(data.sectionFlip, true);
  assert.deepEqual(data.hiddenClasses, { 'byType:IfcDoor': true });
  assert.deepEqual(data.smartViews, [{ id: 'sv' }]);
});
