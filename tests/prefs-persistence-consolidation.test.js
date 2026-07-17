'use strict';
// First slice of the reducer/state decomposition (MEMORY.md Active Work,
// 2026-07-17): the try/JSON.stringify/localStorage.setItem/catch pattern
// was duplicated byte-for-byte across ~8 reducer case branches (smartViews
// x2, defaultTolerances, the UPD_PREFS key loop, clash/issue group-by and
// sort-by). Consolidated onto the ALREADY-EXISTING `_ccPersistUI` helper
// (index.html) rather than introducing a new one — it already handled this
// exact shape plus a string-passthrough case, just wasn't used everywhere
// yet. Locks both halves: the helper's own behavior, and that the reducer
// case branches actually route through it now instead of the old inline
// duplicates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractPersistUI() {
  const start = src.indexOf("function _ccPersistUI(key,val){");
  assert.ok(start !== -1, '_ccPersistUI not found');
  const end = src.indexOf('\n', start);
  const keysStart = src.indexOf('var PERSISTED_PREF_KEYS = [', end);
  assert.ok(keysStart !== -1, 'PERSISTED_PREF_KEYS not found');
  const keysEnd = src.indexOf('\n', keysStart);
  const body = src.slice(start, end) + '\n' + src.slice(keysStart, keysEnd);
  const window = { localStorage: makeLocalStorageStub() };
  const fn = new Function('window', 'localStorage', body + '; return { _ccPersistUI, PERSISTED_PREF_KEYS };');
  return fn(window, window.localStorage);
}

function makeLocalStorageStub() {
  const store = {};
  return {
    _store: store,
    setItem(k, v) { store[k] = v; },
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  };
}

test('_ccPersistUI writes non-strings as JSON and strings verbatim, under a cc_ prefix', () => {
  const { _ccPersistUI } = extractPersistUI();
  // Re-extract with a fresh stub since the module-scope localStorage in the
  // helper above closes over the one built at extraction time.
  const start = src.indexOf('function _ccPersistUI(key,val){');
  const end = src.indexOf('\n', start);
  const stub = makeLocalStorageStub();
  const fn = new Function('localStorage', src.slice(start, end) + '; return _ccPersistUI;');
  const persistUI = fn(stub);
  persistUI('clashGroupBy', ['cluster']);
  assert.equal(stub._store.cc_clashGroupBy, '["cluster"]');
  persistUI('someRawString', 'already-a-string');
  assert.equal(stub._store.cc_someRawString, 'already-a-string');
  persistUI('flag', true);
  assert.equal(stub._store.cc_flag, 'true');
});

test('PERSISTED_PREF_KEYS is exactly the set the UPD_PREFS reducer case iterates', () => {
  const { PERSISTED_PREF_KEYS } = extractPersistUI();
  assert.deepEqual(PERSISTED_PREF_KEYS, [
    'autoFlyTo', 'autoHighlight', 'showGrid', 'showAxes', 'showMarkers',
    'hoverHighlight', 'outlineSelected', 'defaultPriority', 'defaultCategory',
    'defaultStatus', 'defaultMaxGap', 'resetFiltersOnRun', 'renderStyle',
    'unitScaleOverride', 'lightSettings', 'measureUnits', 'measurePrecision',
    'measureMagnifier', 'measureCalibration', 'homeView', 'zoomSens',
  ]);
});

test('the consolidated reducer cases route through _ccPersistUI, not a duplicated inline write', () => {
  const reducerStart = src.indexOf('function reducer(s,a) {');
  assert.ok(reducerStart !== -1, 'reducer not found');
  const reducerEnd = src.indexOf('\n  }', src.indexOf('case A.TRAINING_MODE', reducerStart) + 2000);
  const body = src.slice(reducerStart, reducerEnd);

  assert.match(body, /_ccPersistUI\('smartViews', sv\.slice\(-50\)\);/);
  assert.match(body, /_ccPersistUI\('smartViews', sv2\);/);
  assert.match(body, /_ccPersistUI\('defaultTolerances', a\.u\.defaultTolerances\);/);
  assert.match(body, /PERSISTED_PREF_KEYS\.forEach\(function\(k\)\{if\(a\.u\[k\]!==undefined\)\{_ccPersistUI\(k, a\.u\[k\]\);\}\}\);/);
  assert.match(body, /case A\.CLASH_GROUP_BY: _ccPersistUI\('clashGroupBy', a\.v\);/);
  assert.match(body, /case A\.CLASH_SORT_BY: _ccPersistUI\('clashSortBy', a\.v\);/);
  assert.match(body, /case A\.ISSUE_GROUP_BY: _ccPersistUI\('issueGroupBy', a\.v\);/);
  assert.match(body, /case A\.ISSUE_SORT_BY: _ccPersistUI\('issueSortBy', a\.v\);/);

  // No stray duplicated inline pattern should remain anywhere in the
  // reducer for the cases above — this is the whole point of the slice.
  assert.doesNotMatch(body, /localStorage\.setItem\('cc_smartViews'/);
  assert.doesNotMatch(body, /localStorage\.setItem\('cc_defaultTolerances'/);
  assert.doesNotMatch(body, /localStorage\.setItem\('cc_clashGroupBy'/);
  assert.doesNotMatch(body, /localStorage\.setItem\('cc_clashSortBy'/);
  assert.doesNotMatch(body, /localStorage\.setItem\('cc_issueGroupBy'/);
  assert.doesNotMatch(body, /localStorage\.setItem\('cc_issueSortBy'/);
});

test('cc_trainingMode deliberately keeps its raw \'1\'/\'0\' format, NOT folded into _ccPersistUI', () => {
  // Folding this into _ccPersistUI's JSON path would change true/false to
  // "true"/"false" in localStorage, silently breaking anyone who already
  // has a '1'/'0' value saved (read back via `v==='1'`, index.html's INIT).
  const reducerStart = src.indexOf('function reducer(s,a) {');
  const trainingCaseStart = src.indexOf('case A.TRAINING_MODE', reducerStart);
  const trainingCaseEnd = src.indexOf('\n', trainingCaseStart);
  const line = src.slice(trainingCaseStart, trainingCaseEnd);
  assert.match(line, /localStorage\.setItem\('cc_trainingMode',tm\?'1':'0'\)/);
  assert.doesNotMatch(line, /_ccPersistUI/);
});
