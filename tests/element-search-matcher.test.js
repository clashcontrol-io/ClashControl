'use strict';
// Locks _elMatchesSearch (index.html) - the shared Navigator/find element
// search matcher. Previously every call site (spatial view, tree/"Flat list"
// view, its keyboard-nav duplicate, and the Items Finder used by NL commands)
// duplicated its own 2-6 field inline check, none of which matched GlobalId,
// ObjectType, material, description, storey, or any property/quantity VALUE -
// pasting a GlobalId from a BCF issue into the Navigator search box, or
// searching for a property value like a fire rating, found nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _elMatchesSearch(el, q) {');
assert.ok(start !== -1, '_elMatchesSearch not found');
const end = src.indexOf('\n  }', start) + '\n  }'.length;
const _elMatchesSearch = new Function(src.slice(start, end) + '; return _elMatchesSearch;')();
assert.equal(typeof _elMatchesSearch, 'function');

function el(props) { return { expressId: props.expressId != null ? props.expressId : 1, props: props }; }

test('empty query matches everything (no filtering)', () => {
  assert.equal(_elMatchesSearch(el({ name: 'Wall 1' }), ''), true);
});

test('matches by name, case-insensitively', () => {
  assert.equal(_elMatchesSearch(el({ name: 'Exterior Wall' }), 'exterior'), true);
  assert.equal(_elMatchesSearch(el({ name: 'Exterior Wall' }), 'interior'), false);
});

test('matches by ifcType and expressId (the two other pre-existing fields)', () => {
  assert.equal(_elMatchesSearch(el({ ifcType: 'IfcDoor' }), 'door'), true);
  assert.equal(_elMatchesSearch(el({ expressId: 48291 }), '4829'), true);
});

test('matches by GlobalId (the headline gap - pasting a BCF GlobalId found nothing before)', () => {
  assert.equal(_elMatchesSearch(el({ globalId: '1A2B3C4D5E6F7G8H9I0J1K' }), '3c4d5e'), true);
});

test('matches by objectType, material, description, and storey', () => {
  assert.equal(_elMatchesSearch(el({ objectType: 'Basic Wall: Exterior' }), 'basic wall'), true);
  assert.equal(_elMatchesSearch(el({ material: 'Concrete C30/37' }), 'c30'), true);
  assert.equal(_elMatchesSearch(el({ description: 'Fire-rated partition' }), 'fire-rated'), true);
  assert.equal(_elMatchesSearch(el({ storey: '02 First floor' }), 'first floor'), true);
});

test('matches by a property VALUE inside psets, not just keys (e.g. find FireRating=60)', () => {
  var e = el({ name: 'Wall', psets: { Pset_WallCommon: { FireRating: '60', IsExternal: 'TRUE' } } });
  assert.equal(_elMatchesSearch(e, '60'), true);
  assert.equal(_elMatchesSearch(e, 'firerating'), false, 'the KEY is not searched, only values - matches the field-value search framing');
});

test('matches by a quantity VALUE', () => {
  var e = el({ name: 'Slab', quantities: { GrossArea: 24.5 } });
  assert.equal(_elMatchesSearch(e, '24.5'), true);
});

test('does not throw on an element with no props, empty props, or missing psets/quantities', () => {
  assert.doesNotThrow(() => _elMatchesSearch({ expressId: 1 }, 'x'));
  assert.doesNotThrow(() => _elMatchesSearch(el({}), 'x'));
  assert.equal(_elMatchesSearch(el({ name: 'Bare wall' }), 'bare'), true);
});

test('returns false when nothing matches across every field', () => {
  var e = el({ name: 'Wall', ifcType: 'IfcWall', globalId: 'ABC', objectType: 'Basic', material: 'Concrete', psets: { P: { K: 'V' } } });
  assert.equal(_elMatchesSearch(e, 'zzz-no-match-zzz'), false);
});
