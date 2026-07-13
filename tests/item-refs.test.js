'use strict';
// Locks _itemRefs (index.html): the role tags ('A'/'B'/'single'/'grouped') it
// stamps on each ref are the contract _highlightRefs' distinct clash-pair
// coloring (_PAIR_ROLE_COLOR) depends on - a silent change here would make
// the "A vs B" viewport colors wrong or disappear without any visible error.
// Extracted the same way tests/ifc-units.test.js pulls a slice out of the
// inline script - _itemRefs is a small, self-contained, THREE.js-free function.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _itemRefs(item) {');
assert.ok(start !== -1, '_itemRefs not found');
const end = src.indexOf('\n  }', start);
assert.ok(end !== -1, '_itemRefs closing brace not found');
const closeIdx = end + '\n  }'.length;
const _itemRefs = new Function(src.slice(start, closeIdx) + '; return _itemRefs;')();
assert.equal(typeof _itemRefs, 'function');

test('a clash pair (elemA + elemB) tags both sides with distinct roles A/B', () => {
  const refs = _itemRefs({elemA: 101, modelAId: 'm1', elemB: 202, modelBId: 'm2'});
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {modelId: 'm1', expressId: 101, role: 'A'});
  assert.deepEqual(refs[1], {modelId: 'm2', expressId: 202, role: 'B'});
});

test('a single-element item (issue, DQ result) tags role single', () => {
  const refs = _itemRefs({elementId: 55, modelId: 'm1'});
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], {modelId: 'm1', expressId: 55, role: 'single'});
});

test('elementId falls back to modelAId when modelId is absent', () => {
  const refs = _itemRefs({elementId: 55, modelAId: 'mA'});
  assert.equal(refs[0].modelId, 'mA');
});

test('grouped elements (clustered duplicates) tag role grouped, no modelId', () => {
  const refs = _itemRefs({_groupedElems: [1, 2, 3]});
  assert.equal(refs.length, 3);
  refs.forEach((r) => assert.equal(r.role, 'grouped'));
  assert.deepEqual(refs.map((r) => r.expressId), [1, 2, 3]);
});

test('a full clash item combines A/B (issues never carry elementId/_groupedElems alongside elemA/B in practice, but the function must not silently drop either)', () => {
  const refs = _itemRefs({elemA: 1, elemB: 2});
  assert.deepEqual(refs.map((r) => r.role), ['A', 'B']);
});

test('missing fields produce no refs', () => {
  assert.deepEqual(_itemRefs({}), []);
});

test('REGRESSION: _highlightRefs actually consults ref.role for clash-pair coloring, and A/B map to distinct colors', () => {
  // Structural check (mirrors mesh-intersect-parity.test.js's drift guard):
  // _itemRefs tagging roles is useless if _highlightRefs stops reading them.
  const pairColorIdx = src.indexOf('var _PAIR_ROLE_COLOR = {');
  assert.ok(pairColorIdx !== -1, '_PAIR_ROLE_COLOR constant not found');
  const pairColorLine = src.slice(pairColorIdx, src.indexOf('\n', pairColorIdx));
  const match = pairColorLine.match(/A:\s*(0x[0-9a-fA-F]+),\s*B:\s*(0x[0-9a-fA-F]+)/);
  assert.ok(match, '_PAIR_ROLE_COLOR must define both A and B as hex colors');
  assert.notEqual(match[1], match[2], 'A and B must be visually distinct colors');
  const highlightRefsSite = src.slice(pairColorIdx, pairColorIdx + 1200);
  assert.ok(highlightRefsSite.includes('_highlightRefs = function'), '_PAIR_ROLE_COLOR must be declared right before _highlightRefs');
  assert.ok(highlightRefsSite.includes('_PAIR_ROLE_COLOR[ref.role]'), '_highlightRefs must consult ref.role via _PAIR_ROLE_COLOR');
});
