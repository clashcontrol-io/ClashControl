'use strict';
// Locks the containment breadcrumb + hosted-elements computation in
// renderDetails (index.html, AIChatPanel's Details tab). The data
// (spatialHierarchy from extractSpatialHierarchy, hostId from the IFC
// loader) already existed - only the bare storey string was ever shown, with
// no way to see the full Project/Site/Building/Storey chain or what an
// element is hosting (e.g. a wall's doors/windows).
// Extracts the exact computation block (a self-contained `var breadcrumb =
// []; ... hostedEls.push(...)` slice with no DOM/THREE dependency) and wraps
// it as a function of its four inputs, the same extraction spirit as
// tests/ifc-units.test.js pulling a slice out of the inline script.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('      var breadcrumb = [];');
assert.ok(start !== -1, 'breadcrumb computation not found');
const tail = 'hostedEls.push(_mdl.elements[_hi]);';
const tailPos = src.indexOf(tail, start);
assert.ok(tailPos !== -1, 'hostedEls.push(...) not found');
const blockEnd = src.indexOf('\n      }', tailPos) + '\n      }'.length; // closes the inner if, then the outer if
const end = src.indexOf('\n      }', blockEnd) + '\n      }'.length;
const block = src.slice(start, end);

function compute(_latestEl, _mdl, ep, storey) {
  var fn = new Function('_latestEl', '_mdl', 'ep', 'storey', block + '; return {breadcrumb:breadcrumb, hostedEls:hostedEls};');
  return fn(_latestEl, _mdl, ep, storey);
}

function elWithHost(expressId, hostGid, name, ifcType) {
  return { expressId: expressId, props: { hostId: hostGid, name: name, ifcType: ifcType } };
}

test('empty breadcrumb and hostedEls when there is no resolved element/model', () => {
  var r = compute(null, null, null, null);
  assert.deepEqual(r.breadcrumb, []);
  assert.deepEqual(r.hostedEls, []);
});

test('breadcrumb includes project, a single site, a single building, and storey in that order', () => {
  var mdl = { spatialHierarchy: { project: { name: 'HQ Renovation' }, sites: [{ name: 'Main Site' }], buildings: [{ name: 'Tower A' }] }, elements: [] };
  var r = compute({}, mdl, { globalId: 'G1' }, '02 First floor');
  assert.deepEqual(r.breadcrumb, ['HQ Renovation', 'Main Site', 'Tower A', '02 First floor']);
});

test('ambiguous site/building (0 or 2+) is omitted rather than guessed', () => {
  var mdl = { spatialHierarchy: { project: { name: 'P' }, sites: [{ name: 'A' }, { name: 'B' }], buildings: [] }, elements: [] };
  var r = compute({}, mdl, { globalId: 'G1' }, 'Level 1');
  assert.deepEqual(r.breadcrumb, ['P', 'Level 1'], 'multiple sites and zero buildings must both be skipped, not silently pick one');
});

test('no storey still yields a breadcrumb from project/site/building alone', () => {
  var mdl = { spatialHierarchy: { project: { name: 'P' }, sites: [{ name: 'S' }], buildings: [{ name: 'B' }] }, elements: [] };
  var r = compute({}, mdl, { globalId: 'G1' }, null);
  assert.deepEqual(r.breadcrumb, ['P', 'S', 'B']);
});

test('hosted elements are found by hostId matching the selected element\'s GlobalId', () => {
  var mdl = {
    spatialHierarchy: {},
    elements: [
      elWithHost(10, 'WALL-GUID', 'Door 1', 'IfcDoor'),
      elWithHost(11, 'WALL-GUID', 'Window 1', 'IfcWindow'),
      elWithHost(12, 'OTHER-GUID', 'Door 2', 'IfcDoor'),
    ],
  };
  var r = compute({}, mdl, { globalId: 'WALL-GUID' }, null);
  assert.equal(r.hostedEls.length, 2);
  assert.deepEqual(r.hostedEls.map(function(e){return e.expressId;}), [10, 11]);
});

test('the legacy host_global_id field name is also matched (older loader output)', () => {
  var mdl = { spatialHierarchy: {}, elements: [{ expressId: 20, props: { host_global_id: 'WALL-GUID', name: 'Legacy Door' } }] };
  var r = compute({}, mdl, { globalId: 'WALL-GUID' }, null);
  assert.equal(r.hostedEls.length, 1);
});

test('no hosted elements when nothing references this GlobalId as a host', () => {
  var mdl = { spatialHierarchy: {}, elements: [elWithHost(10, 'SOME-OTHER-WALL', 'Door 1', 'IfcDoor')] };
  var r = compute({}, mdl, { globalId: 'WALL-GUID' }, null);
  assert.deepEqual(r.hostedEls, []);
});

test('does not throw when ep has no globalId (nothing to match hosts against)', () => {
  var mdl = { spatialHierarchy: {}, elements: [elWithHost(10, undefined, 'Door 1', 'IfcDoor')] };
  assert.doesNotThrow(() => compute({}, mdl, {}, null));
  var r = compute({}, mdl, {}, null);
  assert.deepEqual(r.hostedEls, []);
});
