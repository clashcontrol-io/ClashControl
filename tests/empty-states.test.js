'use strict';
// REWRITE_UI_PLAN.md Phase 4 — lock the 9-state truthful empty-state decision
// tree (_ccConflictEmptyState) and the active-filters detector
// (_ccFiltersAreActive), both extracted from index.html the same way
// tests/severity-model.test.js locks _ccDeterministicSeverity.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _ccFiltersAreActive(f) {');
assert.ok(start !== -1, '_ccFiltersAreActive not found');
const end = src.indexOf('window._ccConflictEmptyState = _ccConflictEmptyState;', start);
assert.ok(end !== -1, '_ccConflictEmptyState closing point not found');
const endLineEnd = src.indexOf('\n', end) + 1;

// INIT_FILTERS is a free variable referenced by _ccFiltersAreActive — supply
// the exact same default shape from index.html rather than hand-copying it,
// so a future filter field addition there can't silently desync this test.
const initFiltersStart = src.indexOf('var INIT_FILTERS = {');
assert.ok(initFiltersStart !== -1, 'INIT_FILTERS not found');
const initFiltersEnd = src.indexOf('};', initFiltersStart) + 2;
const initFiltersSrc = src.slice(initFiltersStart, initFiltersEnd);

const sandbox = new Function(
  'window',
  initFiltersSrc + '\n' + src.slice(start, endLineEnd) + `
  return { filtersAreActive: _ccFiltersAreActive, emptyState: _ccConflictEmptyState, INIT_FILTERS: INIT_FILTERS };`
);
const lib = sandbox({});

test('_ccFiltersAreActive: default filters object is inactive', () => {
  assert.equal(lib.filtersAreActive(Object.assign({}, lib.INIT_FILTERS)), false);
  assert.equal(lib.filtersAreActive(null), false);
  assert.equal(lib.filtersAreActive(undefined), false);
});

test('_ccFiltersAreActive: any scalar field change is detected', () => {
  assert.equal(lib.filtersAreActive(Object.assign({}, lib.INIT_FILTERS, { status: 'open' })), true);
  assert.equal(lib.filtersAreActive(Object.assign({}, lib.INIT_FILTERS, { search: 'duct' })), true);
  assert.equal(lib.filtersAreActive(Object.assign({}, lib.INIT_FILTERS, { distMax: 50 })), true);
});

test('_ccFiltersAreActive: array/object fields (excludedTypes, modelPair) are detected', () => {
  assert.equal(lib.filtersAreActive(Object.assign({}, lib.INIT_FILTERS, { excludedTypes: ['IfcDoor'] })), true);
  assert.equal(lib.filtersAreActive(Object.assign({}, lib.INIT_FILTERS, { modelPair: { a: 'm0', b: 'm1' } })), true);
});

function baseCtx(overrides) {
  return Object.assign({
    hasModel: true, modelsLoading: false, detecting: false, failed: false,
    ranBefore: true, rawCount: 10, visOnlyCount: 10, filteredCount: 10,
    filtersActive: false, hiddenModelCount: 0, sameDisciplineSkipped: false,
  }, overrides);
}

test('no model loaded takes priority over every other state', () => {
  const st = lib.emptyState(baseCtx({ hasModel: false, rawCount: 0 }));
  assert.equal(st.key, 'no-model');
  assert.equal(st.action, null);
});

test('models still loading is reported distinctly from "no model"', () => {
  const st = lib.emptyState(baseCtx({ modelsLoading: true, rawCount: 0 }));
  assert.equal(st.key, 'loading');
});

test('detection currently running', () => {
  const st = lib.emptyState(baseCtx({ detecting: true, rawCount: 0 }));
  assert.equal(st.key, 'running');
  assert.equal(st.action, 'cancel');
});

test('never run (no runHistory, zero raw clashes) offers a Run action', () => {
  const st = lib.emptyState(baseCtx({ ranBefore: false, rawCount: 0, visOnlyCount: 0, filteredCount: 0 }));
  assert.equal(st.key, 'never-run');
  assert.equal(st.action, 'run');
});

test('completed with a genuine zero result is distinct from never-run', () => {
  const st = lib.emptyState(baseCtx({ ranBefore: true, rawCount: 0, visOnlyCount: 0, filteredCount: 0 }));
  assert.equal(st.key, 'completed-zero');
  assert.notEqual(st.action, 'run');
});

test('same-discipline pairs skipped is distinguished from a genuine clean result', () => {
  const st = lib.emptyState(baseCtx({ rawCount: 0, visOnlyCount: 0, filteredCount: 0, sameDisciplineSkipped: true }));
  assert.equal(st.key, 'same-discipline-skipped');
  assert.equal(st.action, 'check-same-discipline');
});

test('results exist but every model with them is hidden', () => {
  const st = lib.emptyState(baseCtx({ rawCount: 5, visOnlyCount: 0, filteredCount: 0, hiddenModelCount: 2 }));
  assert.equal(st.key, 'hidden-by-visibility');
  assert.equal(st.action, 'show-models');
});

test('results visible but text/dropdown filters hide everything', () => {
  const st = lib.emptyState(baseCtx({ rawCount: 20, visOnlyCount: 20, filteredCount: 0, filtersActive: true }));
  assert.equal(st.key, 'filtered-to-zero');
  assert.equal(st.action, 'clear-filters');
  assert.match(st.title, /0 of 20/);
});

test('visible results and zero filtered but filters NOT active falls back to completed-zero (never fabricates a false filtered-to-zero)', () => {
  const st = lib.emptyState(baseCtx({ rawCount: 20, visOnlyCount: 20, filteredCount: 0, filtersActive: false }));
  assert.equal(st.key, 'completed-zero');
});

test('priority order is stable: no-model beats loading beats running beats everything else', () => {
  const st = lib.emptyState(baseCtx({ hasModel: false, modelsLoading: true, detecting: true, rawCount: 0 }));
  assert.equal(st.key, 'no-model');
});
