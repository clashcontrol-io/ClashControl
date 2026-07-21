'use strict';
// Locks the Phase 2 memory fix (2026-07-21): _sweepAndPruneWasm used to
// expand the Wasm-returned flat index array into a fully-materialized
// {eA,mA,eB,mB,sameModel} object per candidate pair (_CANDIDATE_EST_BYTES=96
// each, ~96MB at 1M candidates — see large-candidate-warning.test.js). It
// now returns a compact view (_makeCompactCandidates) that builds each pair
// object lazily, on read, from `items` (one entry per element) + the flat
// array (3 ints/pair) — so at most O(chunk size) pair objects are ever
// alive at once instead of O(candidate count). _candidateAt is the single
// point every consumer goes through so it doesn't matter whether
// `candidates` is a plain Array (the _sweepAndPrune JS-fallback oracle,
// left untouched) or the new compact view.
//
// Extracted the same way tests/single-model-self-clash.test.js pulls
// _sweepAndPrune out of the inline script — pure logic, no DOM/THREE
// dependency.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, signature + ' not found');
  const end = src.indexOf('\n  }', start) + '\n  }'.length;
  return src.slice(start, end);
}

const candidateAtSrc = extractFunction('  function _candidateAt(candidates, i) {');
const makeCompactSrc = extractFunction('  function _makeCompactCandidates(items, flat) {');

const api = new Function(`
  ${candidateAtSrc}
  ${makeCompactSrc}
  return {_candidateAt: _candidateAt, _makeCompactCandidates: _makeCompactCandidates};
`)();

test('_candidateAt on a plain array is a zero-cost passthrough (JS-fallback oracle path unchanged)', () => {
  const arr = [{eA: 'a1'}, {eA: 'a2'}, {eA: 'a3'}];
  assert.equal(api._candidateAt(arr, 0), arr[0]);
  assert.equal(api._candidateAt(arr, 1), arr[1]);
  assert.equal(api._candidateAt(arr, 2), arr[2]);
});

test('_makeCompactCandidates: .length matches flat.length / 3', () => {
  const items = [{el: 'e0', m: 'm0'}, {el: 'e1', m: 'm1'}, {el: 'e2', m: 'm2'}, {el: 'e3', m: 'm3'}];
  const flat = [0, 1, 1, 2, 3, 0]; // 2 candidate pairs
  const view = api._makeCompactCandidates(items, flat);
  assert.equal(view.length, 2);
});

test('_makeCompactCandidates: .at(i) resolves the same eA/mA/eB/mB/sameModel shape the old eager expansion produced', () => {
  const items = [
    {el: {id: 'elA'}, m: {id: 'modelX'}},
    {el: {id: 'elB'}, m: {id: 'modelY'}},
    {el: {id: 'elC'}, m: {id: 'modelX'}},
  ];
  // pair 0: items[0] vs items[1], cross-model (sameModel flag 0)
  // pair 1: items[2] vs items[0], same model (sameModel flag 1)
  const flat = [0, 1, 0, 2, 0, 1];
  const view = api._makeCompactCandidates(items, flat);

  const p0 = view.at(0);
  assert.equal(p0.eA, items[0].el);
  assert.equal(p0.mA, items[0].m);
  assert.equal(p0.eB, items[1].el);
  assert.equal(p0.mB, items[1].m);
  assert.equal(p0.sameModel, false);

  const p1 = view.at(1);
  assert.equal(p1.eA, items[2].el);
  assert.equal(p1.mA, items[2].m);
  assert.equal(p1.eB, items[0].el);
  assert.equal(p1.mB, items[0].m);
  assert.equal(p1.sameModel, true);
});

test('_candidateAt dispatches to .at() for the compact view, giving consumers an identical access pattern regardless of representation', () => {
  const items = [{el: {id: 'x'}, m: {id: 'mx'}}, {el: {id: 'y'}, m: {id: 'my'}}];
  const flat = [0, 1, 1];
  const view = api._makeCompactCandidates(items, flat);
  const viaCandidateAt = api._candidateAt(view, 0);
  const viaDirectAt = view.at(0);
  assert.deepEqual(viaCandidateAt, viaDirectAt);
});

test('_makeCompactCandidates: .at(i) constructs a fresh object per call rather than caching/aliasing (no stale-reference risk across chunks)', () => {
  const items = [{el: {id: 'x'}, m: {id: 'mx'}}, {el: {id: 'y'}, m: {id: 'my'}}];
  const flat = [0, 1, 0];
  const view = api._makeCompactCandidates(items, flat);
  const a = view.at(0);
  const b = view.at(0);
  assert.notEqual(a, b, 'each .at() call must return an independent object');
  assert.deepEqual(a, b, 'but with equal contents');
});

test('_makeCompactCandidates: empty flat array yields a zero-length view, not a crash', () => {
  const view = api._makeCompactCandidates([], []);
  assert.equal(view.length, 0);
});
