'use strict';
// Locks the IfcSpace completeness gap-fill in runILSChecks (addons/data-quality.js,
// spaceIncomplete bucket). The pre-existing check only looked at Name/LongName/
// NetFloorArea (NL-BIM Basis ILS v2 4.1). RVB BIM Norm v1.1 2.2.7.6a/6b additionally
// expect ObjectType, IsExternal (Pset_SpaceCommon), and GrossFloorArea/Height
// (Qto_SpaceBaseQuantities) - a space could pass every existing check while still
// missing all four.
const { test } = require('node:test');
const assert = require('node:assert');
const { countryWindow, loadAddon } = require('./_country-pack.js');

// The rules are data in regulations/nl.json (country pack), run by the
// generic standards engine in addons/data-quality.js.
function loadEngine() {
  const window = loadAddon('data-quality.js', countryWindow({ regions: ['nl'], active: 'nl' }));
  assert.equal(typeof window._ccRunStandard, 'function');
  return { runILS: (input) => window._ccRunStandard('ils', input) };
}

function space(id, overrides) {
  return Object.assign({
    expressId: id,
    props: Object.assign({
      globalId: 'G' + id, ifcType: 'IfcSpace', name: 'Room ' + id, longName: 'Office ' + id,
      objectType: 'Office', quantities: { NetFloorArea: 20, GrossFloorArea: 22, Height: 2.7 },
      psets: { Pset_SpaceCommon: { IsExternal: 'FALSE' } },
    }, overrides && overrides.props),
  }, overrides && overrides.top);
}

test('a fully-complete space (Name/LongName/ObjectType/IsExternal/all quantities) passes', () => {
  const { runILS } = loadEngine();
  const result = runILS([space(1)]);
  assert.equal(result.spaceIncomplete.count, 0);
});

test('missing ObjectType is now caught', () => {
  const { runILS } = loadEngine();
  const result = runILS([space(1, { props: { objectType: '' } })]);
  assert.equal(result.spaceIncomplete.count, 1);
  assert.ok(result.spaceIncomplete.ex[0].detail.indexOf('ObjectType') !== -1);
});

test('missing IsExternal (Pset_SpaceCommon) is now caught', () => {
  const { runILS } = loadEngine();
  const result = runILS([space(1, { props: { psets: {} } })]);
  assert.equal(result.spaceIncomplete.count, 1);
  assert.ok(result.spaceIncomplete.ex[0].detail.indexOf('IsExternal') !== -1);
});

test('IsExternal=FALSE counts as present (boolean false is not "missing")', () => {
  const { runILS } = loadEngine();
  const result = runILS([space(1, { props: { psets: { Pset_SpaceCommon: { IsExternal: 'FALSE' } } } })]);
  assert.ok(result.spaceIncomplete.ex.length === 0 || result.spaceIncomplete.ex[0].detail.indexOf('IsExternal') === -1);
});

test('missing GrossFloorArea and Height (Qto_SpaceBaseQuantities) are now caught together', () => {
  const { runILS } = loadEngine();
  const result = runILS([space(1, { props: { quantities: { NetFloorArea: 20 } } })]);
  assert.equal(result.spaceIncomplete.count, 1);
  assert.ok(result.spaceIncomplete.ex[0].detail.indexOf('GrossFloorArea') !== -1);
  assert.ok(result.spaceIncomplete.ex[0].detail.indexOf('Height') !== -1);
});

test('a zero-value quantity counts the same as missing (matches the existing NetFloorArea convention)', () => {
  const { runILS } = loadEngine();
  const result = runILS([space(1, { props: { quantities: { NetFloorArea: 20, GrossFloorArea: 0, Height: 0 } } })]);
  assert.ok(result.spaceIncomplete.ex[0].detail.indexOf('GrossFloorArea') !== -1);
  assert.ok(result.spaceIncomplete.ex[0].detail.indexOf('Height') !== -1);
});
