'use strict';
// Locks _resolveSearchSet (index.html) - the query-matching engine behind
// Wave 4's "search sets": a saved QUERY (ifcType/storey/material/property)
// that re-resolves against the live model every time it's read, instead of
// freezing into a static ref list the way Selection Sets do. Query shape
// mirrors the IDS engine's applicability/requirement facets (ifcType regex
// + pset-scoped property) rather than inventing a new one.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _resolveSearchSet(query, models) {');
assert.ok(start !== -1, '_resolveSearchSet not found');
const end = src.indexOf('\n  }', start) + '\n  }'.length;
const _resolveSearchSet = new Function(src.slice(start, end) + '; return _resolveSearchSet;')();
assert.equal(typeof _resolveSearchSet, 'function');

function el(expressId, props) { return { expressId: expressId, props: props }; }
function model(id, elements, visible) { return { id: id, visible: visible !== false, elements: elements }; }

test('empty query matches every element (vacuous AND) - the UI, not the resolver, requires at least one field', () => {
  var models = [model('m1', [el(1, { ifcType: 'IfcWall' }), el(2, { ifcType: 'IfcDoor' })])];
  assert.equal(_resolveSearchSet({}, models).length, 2);
  assert.equal(_resolveSearchSet(null, models).length, 2);
});

test('ifcType filters case-insensitively and is a regex, not just exact-equal', () => {
  var models = [model('m1', [el(1, { ifcType: 'IfcDoor' }), el(2, { ifcType: 'IfcWall' }), el(3, { ifcType: 'IfcDoorStyle' })])];
  var refs = _resolveSearchSet({ ifcType: 'ifcdoor' }, models);
  assert.deepEqual(refs.map(function(r){return r.expressId;}).sort(), [1, 3]);
});

test('an invalid ifcType regex is caught and treated as no type filter, not a crash', () => {
  var models = [model('m1', [el(1, { ifcType: 'IfcWall' })])];
  assert.doesNotThrow(() => _resolveSearchSet({ ifcType: '(unterminated' }, models));
});

test('storey filters by substring, case-insensitively', () => {
  var models = [model('m1', [el(1, { storey: '02 First Floor' }), el(2, { storey: '03 Second Floor' })])];
  var refs = _resolveSearchSet({ storey: 'first' }, models);
  assert.deepEqual(refs.map(function(r){return r.expressId;}), [1]);
});

test('material filters by substring, case-insensitively', () => {
  var models = [model('m1', [el(1, { material: 'Concrete C30/37' }), el(2, { material: 'Timber' })])];
  var refs = _resolveSearchSet({ material: 'concrete' }, models);
  assert.deepEqual(refs.map(function(r){return r.expressId;}), [1]);
});

test('propertySet + propertyName requires the pset AND the exact key to exist', () => {
  var models = [model('m1', [
    el(1, { psets: { Pset_WallCommon: { FireRating: '60' } } }),
    el(2, { psets: { Pset_WallCommon: { IsExternal: 'TRUE' } } }), // same pset, different key -> no match
    el(3, { psets: { Pset_DoorCommon: { FireRating: '30' } } }),   // same key, different pset -> no match
  ])];
  var refs = _resolveSearchSet({ propertySet: 'Pset_WallCommon', propertyName: 'FireRating' }, models);
  assert.deepEqual(refs.map(function(r){return r.expressId;}), [1]);
});

test('propertySet alone (no propertyName) is ignored - both are required together, matching everything', () => {
  var models = [model('m1', [el(1, { ifcType: 'IfcWall', psets: {} }), el(2, { ifcType: 'IfcDoor', psets: {} })])];
  var refs = _resolveSearchSet({ propertySet: 'Pset_WallCommon' }, models);
  assert.equal(refs.length, 2, 'no propertyName means the property clause is skipped entirely, not treated as "any value"');
});

test('propertyValue further narrows by substring once propertySet+propertyName both match', () => {
  var models = [model('m1', [
    el(1, { psets: { Pset_WallCommon: { FireRating: '60' } } }),
    el(2, { psets: { Pset_WallCommon: { FireRating: '30' } } }),
  ])];
  var refs = _resolveSearchSet({ propertySet: 'Pset_WallCommon', propertyName: 'FireRating', propertyValue: '60' }, models);
  assert.deepEqual(refs.map(function(r){return r.expressId;}), [1]);
});

test('multiple criteria AND together', () => {
  var models = [model('m1', [
    el(1, { ifcType: 'IfcDoor', storey: 'Level 1' }),
    el(2, { ifcType: 'IfcDoor', storey: 'Level 2' }),
    el(3, { ifcType: 'IfcWall', storey: 'Level 1' }),
  ])];
  var refs = _resolveSearchSet({ ifcType: 'IfcDoor', storey: 'Level 1' }, models);
  assert.deepEqual(refs.map(function(r){return r.expressId;}), [1]);
});

test('skips hidden (visible:false) models entirely', () => {
  var models = [
    model('m1', [el(1, { ifcType: 'IfcWall' })], true),
    model('m2', [el(2, { ifcType: 'IfcWall' })], false),
  ];
  var refs = _resolveSearchSet({ ifcType: 'IfcWall' }, models);
  assert.deepEqual(refs.map(function(r){return r.modelId;}), ['m1']);
});

test('resolves across multiple models, tagging each ref with its modelId', () => {
  var models = [
    model('m1', [el(1, { ifcType: 'IfcDoor' })]),
    model('m2', [el(1, { ifcType: 'IfcDoor' })]), // same expressId, different model - must not collide
  ];
  var refs = _resolveSearchSet({ ifcType: 'IfcDoor' }, models);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map(function(r){return r.modelId;}).sort(), ['m1', 'm2']);
});

test('does not throw on elements with no props, missing psets, or a model with no elements array', () => {
  var models = [model('m1', [{ expressId: 1 }, el(2, {})]), { id: 'm2', visible: true }];
  assert.doesNotThrow(() => _resolveSearchSet({ ifcType: 'IfcWall' }, models));
  assert.doesNotThrow(() => _resolveSearchSet({ propertySet: 'X', propertyName: 'Y' }, models));
});

test('does not throw on a null/undefined models array', () => {
  assert.doesNotThrow(() => _resolveSearchSet({ ifcType: 'IfcWall' }, null));
  assert.doesNotThrow(() => _resolveSearchSet({ ifcType: 'IfcWall' }, undefined));
});
