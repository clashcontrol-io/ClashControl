'use strict';
// User-authored property rules (addons/data-quality.js runPropertyRules,
// docs/INTERNALS.md §21.62): every operator, numeric compare of values
// stored as strings with units, missing property set, type filter,
// severity, stage, invalid rules, and the property-set-scoped lookup.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
  const window = { _ccCountryPackCore: require('../country-pack-core.js') };
  new Function('window', src)(window);
  assert.equal(typeof window._ccRunPropertyRules, 'function');
  return window;
}

function el(id, ifcType, psets, extra) {
  return Object.assign({ expressId: id, _modelId: 'm1', props: Object.assign({ globalId: 'G' + id, name: 'E' + id, ifcType, psets: psets || {} }, extra || {}) });
}

// A small synthetic set: walls with and without a fire rating, a width
// stored with units, a slab, a door without any property set.
const ELS = [
  el(1, 'IfcWall', { Pset_WallCommon: { FireRating: 'EI 60', IsExternal: 'true', Width: '120 mm' } }),
  el(2, 'IfcWall', { Pset_WallCommon: { FireRating: 'EI 30', IsExternal: 'false', Width: '2,5 m' } }),
  el(3, 'IfcWall', { Pset_WallCommon: { IsExternal: 'false', Width: '90mm' } }),
  el(4, 'IfcWallStandardCase', { Pset_WallCommon: { FireRating: 'ei 90', Width: 'thick' } }),
  el(5, 'IfcSlab', { Pset_SlabCommon: { LoadBearing: 'true' }, Other: { FireRating: 'REI 120' } }),
  el(6, 'IfcDoor', {}),
];
const ids = (res, key) => res[key].refs.map((r) => r.expressId);

test('exists / does not exist, with and without a property set', () => {
  const w = loadEngine();
  const res = w._ccRunPropertyRules(ELS, [
    { id: 'a', prop: 'Pset_WallCommon.FireRating', op: 'exists' },
    { id: 'b', prop: 'FireRating', op: 'exists' },
    { id: 'c', prop: 'Pset_WallCommon.FireRating', op: 'notExists' },
  ]);
  assert.deepStrictEqual(ids(res, 'a'), [3, 5, 6], 'scoped: slab rating is in another pset, door has no pset at all');
  assert.deepStrictEqual(ids(res, 'b'), [3, 6], 'no pset: any property set counts');
  assert.deepStrictEqual(ids(res, 'c'), [1, 2, 4]);
  assert.equal(res.a.total, 6);
  assert.equal(res._total, 6);
  assert.ok(res.a.refs.find((r) => r.expressId === 6).missing, 'a missing pset reads as missing');
});

test('equals / not equal / contains (contains ignores case)', () => {
  const w = loadEngine();
  const res = w._ccRunPropertyRules(ELS, [
    { id: 'eq', prop: 'Pset_WallCommon.FireRating', op: 'eq', value: 'EI 60' },
    { id: 'ne', prop: 'Pset_WallCommon.FireRating', op: 'neq', value: 'EI 60' },
    { id: 'ct', prop: 'Pset_WallCommon.FireRating', op: 'contains', value: 'ei' },
    { id: 'bool', prop: 'Pset_WallCommon.IsExternal', op: 'eq', value: 'false' },
  ]);
  assert.deepStrictEqual(ids(res, 'eq'), [2, 3, 4, 5, 6], 'missing fails an equality');
  assert.deepStrictEqual(ids(res, 'ne'), [1], 'not equal: only the equal value fails, missing passes');
  assert.deepStrictEqual(ids(res, 'ct'), [3, 5, 6]);
  assert.deepStrictEqual(ids(res, 'bool'), [1, 4, 5, 6]);
  assert.equal(res.ne.refs[0].detail, 'EI 60', 'the failing value is the detail');
});

test('≥ / ≤ compare the leading number of values with units (decimal comma too)', () => {
  const w = loadEngine();
  const res = w._ccRunPropertyRules(ELS, [
    { id: 'ge', appliesTo: ['IfcWall', 'IfcWallStandardCase'], prop: 'Pset_WallCommon.Width', op: 'gte', value: '100' },
    { id: 'le', appliesTo: 'IfcWall', prop: 'Pset_WallCommon.Width', op: 'lte', value: '2.5' },
  ]);
  // 120 mm ≥ 100 ✓, 2,5 m = 2.5 ✗, 90mm ✗, "thick" is not a number ✗
  assert.deepStrictEqual(ids(res, 'ge'), [2, 3, 4]);
  // 120 ✗, 2.5 ✓, 90 ✗
  assert.deepStrictEqual(ids(res, 'le'), [1, 3]);
  assert.equal(res.ge.total, 4);
  assert.equal(res.le.total, 3, 'type list as a string');
});

test('matches pattern goes through the country-pack safeRegex gate', () => {
  const w = loadEngine();
  const res = w._ccRunPropertyRules(ELS, [
    { id: 'm', appliesTo: ['IfcWall'], prop: 'Pset_WallCommon.FireRating', op: 'matches', value: '^EI \\d+$' },
    { id: 'bad', prop: 'Pset_WallCommon.FireRating', op: 'matches', value: '(a+)+' },
  ]);
  assert.deepStrictEqual(ids(res, 'm'), [3]);
  assert.equal(res.bad.invalid, 'pattern', 'nested quantifiers are refused, never run');
  assert.equal(res.bad.count, 0);
});

test('type filter is exact (no subtype expansion), case-insensitive', () => {
  const w = loadEngine();
  const res = w._ccRunPropertyRules(ELS, [{ id: 't', appliesTo: ['ifcwall'], prop: 'Pset_WallCommon.FireRating', op: 'exists' }]);
  assert.equal(res.t.total, 3);
  assert.deepStrictEqual(ids(res, 't'), [3]);
});

test('severity, stage, disabled and invalid rules', () => {
  const w = loadEngine();
  const res = w._ccRunPropertyRules(ELS, [
    { id: 'c', prop: 'FireRating', op: 'exists', severity: 'critical', stage: 'Design stage 2' },
    { id: 'n', prop: 'FireRating', op: 'exists', severity: 'minor' },
    { id: 'x', prop: 'FireRating', op: 'exists', enabled: false },
    { id: 'v', prop: 'FireRating', op: 'eq', value: '' },
    { id: 'num', prop: 'Width', op: 'gte', value: 'wide' },
    { id: 'p', prop: '', op: 'exists' },
  ]);
  assert.equal(res.c.sev, 'error');
  assert.equal(res.c.severity, 'critical');
  assert.equal(res.c.stage, 'Design stage 2');
  assert.match(res.c.label, /^Design stage 2: FireRating exists$/);
  assert.equal(res.n.sev, 'info');
  assert.equal(res.x, undefined, 'a disabled rule does not run');
  assert.equal(res.v.invalid, 'value');
  assert.equal(res.num.invalid, 'number');
  assert.equal(res.p.invalid, 'prop');
  assert.equal(w._ccPropertyRuleProblem({ prop: 'A.B', op: 'gte', value: '3 m' }), null);
});

test('quantity sets: BaseQuantities / Qto_* search the flattened quantities', () => {
  const w = loadEngine();
  const els = [el(1, 'IfcSlab', {}, { quantities: { GrossArea: 12.5 } }), el(2, 'IfcSlab', {}, { quantities: { GrossArea: 3 } }), el(3, 'IfcSlab', {})];
  const res = w._ccRunPropertyRules(els, [{ id: 'q', prop: 'BaseQuantities.GrossArea', op: 'gte', value: '10' }]);
  assert.deepStrictEqual(ids(res, 'q'), [2, 3]);
});

test('results flatten with an engine key like every other engine; display list is capped, refs are not', () => {
  const w = loadEngine();
  const many = [];
  for (let i = 0; i < 80; i++) many.push(el(i + 1, 'IfcWall', {}));
  const res = w._ccRunPropertyRules(many, [{ id: 'r1', prop: 'Pset_WallCommon.FireRating', op: 'exists', severity: 'major' }]);
  assert.equal(res.r1.count, 80);
  assert.equal(res.r1.refs.length, 80);
  assert.ok(res.r1.ex.length < 80);
  const flat = w._ccFlattenDQCounts({ rules: res });
  assert.deepStrictEqual(flat['rules:r1'], { count: 80, label: res.r1.label, sev: 'warn' });
});
