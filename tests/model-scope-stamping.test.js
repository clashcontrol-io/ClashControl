'use strict';
// Locks the large-model plan's "stamp every clash run and exported result
// with its scope/completeness" ask (2026-07-21). Storey-scoped loading was
// already atomic and well-tested (tests/storey-scope-*.test.js), but nothing
// downstream recorded which models a given clash run/export actually
// covered when a storey scope narrowed the load -- a run against a
// partially-loaded federation could silently read as "the whole building
// has no clashes". model.stats.loadedScope/scopedOutCount are already
// stamped per-model at load time; _ccSummarizeModelScope just summarizes
// them for a specific run/export's model set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('  function _ccSummarizeModelScope(models) {');
assert.ok(start !== -1, '_ccSummarizeModelScope not found');
const end = src.indexOf('\n  }', start) + '\n  }'.length;
const _ccSummarizeModelScope = new Function(src.slice(start, end) + '; return _ccSummarizeModelScope;')();
assert.equal(typeof _ccSummarizeModelScope, 'function');

test('a fully-loaded model set (no loadedScope on any model) reports complete:true', () => {
  const models = [
    {id: 'm1', name: 'Architecture', stats: {loadedScope: null}},
    {id: 'm2', name: 'Structure', stats: {}},
  ];
  assert.deepEqual(_ccSummarizeModelScope(models), {complete: true});
});

test('a model with a storey scope reports complete:false and names the loaded storeys', () => {
  const models = [
    {id: 'm1', name: 'MEP Federation', stats: {loadedScope: ['Level 1', 'Level 2'], scopedOutCount: 4200}},
  ];
  const result = _ccSummarizeModelScope(models);
  assert.equal(result.complete, false);
  assert.equal(result.partialModels.length, 1);
  assert.equal(result.partialModels[0].id, 'm1');
  assert.equal(result.partialModels[0].name, 'MEP Federation');
  assert.deepEqual(result.partialModels[0].loadedStoreys, ['Level 1', 'Level 2']);
  assert.equal(result.partialModels[0].scopedOutCount, 4200);
});

test('a mix of scoped and unscoped models only lists the scoped one', () => {
  const models = [
    {id: 'm1', name: 'Full model', stats: {loadedScope: null}},
    {id: 'm2', name: 'Scoped model', stats: {loadedScope: ['Level 3'], scopedOutCount: 10}},
  ];
  const result = _ccSummarizeModelScope(models);
  assert.equal(result.complete, false);
  assert.equal(result.partialModels.length, 1);
  assert.equal(result.partialModels[0].id, 'm2');
});

test('handles an empty or missing models array without throwing', () => {
  assert.deepEqual(_ccSummarizeModelScope([]), {complete: true});
  assert.deepEqual(_ccSummarizeModelScope(undefined), {complete: true});
});

test('handles a model with no stats object at all without throwing', () => {
  const models = [{id: 'm1', name: 'No stats'}];
  assert.deepEqual(_ccSummarizeModelScope(models), {complete: true});
});

test('scopedOutCount defaults to 0 when absent on a partial model', () => {
  const models = [{id: 'm1', name: 'Partial, no count', stats: {loadedScope: ['L1']}}];
  const result = _ccSummarizeModelScope(models);
  assert.equal(result.partialModels[0].scopedOutCount, 0);
});
