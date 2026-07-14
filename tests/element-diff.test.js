'use strict';
// Locks _lookupElProps and _diffElementProps (index.html) - the resolution +
// comparison logic behind the new Navigator "Compare selected (2)" view
// (Wave 4's element-vs-element diff). multiSel + PropBlock already existed
// (stacked A/B display in the clash panel, ClashProps) but nothing aligned
// two elements' properties side by side or flagged which actually differ.
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
  return new Function(src.slice(start, end) + '; return ' + name + ';')();
}

const _lookupElProps = extractFn('_lookupElProps');
const _diffElementProps = extractFn('_diffElementProps');

function model(id, elements) { return { id: id, elements: elements }; }
function el(expressId, props) { return { expressId: expressId, props: props }; }

test('_lookupElProps resolves by modelId when given', () => {
  const models = [model('m1', [el(1, { name: 'A' })]), model('m2', [el(1, { name: 'B (different model, same expressId)' })])];
  assert.equal(_lookupElProps(models, 'm2', 1).name, 'B (different model, same expressId)');
});

test('_lookupElProps falls back to searching every model when modelId is null (Navigator multiSel refs never populate it)', () => {
  const models = [model('m1', [el(5, { name: 'Found me' })])];
  assert.equal(_lookupElProps(models, null, 5).name, 'Found me');
});

test('_lookupElProps returns null when nothing matches, with or without modelId', () => {
  const models = [model('m1', [el(1, { name: 'X' })])];
  assert.equal(_lookupElProps(models, null, 999), null);
  assert.equal(_lookupElProps(models, 'no-such-model', 1), null);
});

test('_diffElementProps: identical elements produce zero differing rows', () => {
  const p = { ifcType: 'IfcWall', name: 'Wall 1', globalId: 'G1' };
  const rows = _diffElementProps(p, Object.assign({}, p));
  assert.ok(rows.every((r) => r.same));
});

test('_diffElementProps: a differing top-level field is flagged, matching fields are not', () => {
  const rows = _diffElementProps({ ifcType: 'IfcWall', name: 'Wall A' }, { ifcType: 'IfcWall', name: 'Wall B' });
  const typeRow = rows.find((r) => r.label === 'Type');
  const nameRow = rows.find((r) => r.label === 'Name');
  assert.equal(typeRow.same, true);
  assert.equal(nameRow.same, false);
  assert.equal(nameRow.a, 'Wall A');
  assert.equal(nameRow.b, 'Wall B');
});

test('_diffElementProps: a quantity only one side carries shows as a row with the other side null, not silently dropped', () => {
  const rows = _diffElementProps({ quantities: { Length: 5 } }, { quantities: {} });
  const row = rows.find((r) => r.label === 'Qty: Length');
  assert.ok(row);
  assert.equal(row.a, '5');
  assert.equal(row.b, null);
  assert.equal(row.same, false);
});

test('_diffElementProps: pset property values are compared per set+property, not just by name collision', () => {
  const pA = { psets: { Pset_WallCommon: { FireRating: '60' } } };
  const pB = { psets: { Pset_WallCommon: { FireRating: '90' }, Pset_Other: { FireRating: '60' } } };
  const rows = _diffElementProps(pA, pB);
  const wallCommon = rows.find((r) => r.label === 'Pset_WallCommon: FireRating');
  const other = rows.find((r) => r.label === 'Pset_Other: FireRating');
  assert.ok(wallCommon && !wallCommon.same, 'same pset, different value must be flagged as differing');
  assert.ok(other && !other.same, 'a pset only one side has must show the other side as missing (null), not equal');
  assert.equal(other.a, null);
});

test('_diffElementProps does not throw on null/undefined props (nothing selected yet)', () => {
  assert.doesNotThrow(() => _diffElementProps(null, null));
  assert.doesNotThrow(() => _diffElementProps({ name: 'A' }, null));
});

test('_diffElementProps treats empty string the same as missing (both read as "no value")', () => {
  const rows = _diffElementProps({ material: '' }, { material: null });
  const row = rows.find((r) => r.label === 'Material');
  assert.equal(row.same, true);
  assert.equal(row.a, null);
});
