'use strict';
// Locks runRVBChecks (addons/data-quality.js) - the RVB BIM Norm v1.1
// project/site/building/zone metadata checks (2.2.7.1-2.2.7.4, 2.2.7.7).
// Unlike runDataQualityChecks/runBIMModelChecks/runILSChecks, this engine
// takes the loaded MODELS directly (spatialHierarchy/storeyData are
// per-model, extracted once at load time - not per-element props), so a
// fixture here is a models array, not an elements array.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  assert.equal(typeof window._ccRunRVBChecks, 'function');
  return window;
}

function completeModel(id) {
  return {
    id, name: 'Model ' + id,
    spatialHierarchy: {
      project: { name: 'HQ Renovation', _hasName: true },
      sites: [{ name: 'Site 1', _hasName: true, georef: { refLat: 52.1, refLon: 5.1, refElev: 1.5 } }],
      buildings: [{ name: 'Building A', _hasName: true }],
      zones: [{ name: 'Fire Compartment 1', objectType: 'Fire', _hasName: true }],
    },
    storeyData: [{ name: '00 Begane grond', hasElevation: true }],
  };
}

test('a fully-complete model passes every RVB check', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const r = _ccRunRVBChecks([completeModel('m1')]);
  ['projectIncomplete', 'siteIncomplete', 'buildingIncomplete', 'zoneIncomplete', 'storeyNoElevation'].forEach((k) => {
    assert.equal(r[k].count, 0, k + ' should not fire on a complete model');
  });
});

test('IfcProject with a fallback name (_hasName false) is flagged', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const m = completeModel('m1');
  m.spatialHierarchy.project = { name: 'IfcProject', _hasName: false };
  const r = _ccRunRVBChecks([m]);
  assert.equal(r.projectIncomplete.count, 1);
  assert.equal(r.projectIncomplete.total, 1);
});

test('a model with NO IfcProject at all is still flagged (spatialHierarchy.project is null)', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const m = completeModel('m1');
  m.spatialHierarchy.project = null;
  const r = _ccRunRVBChecks([m]);
  assert.equal(r.projectIncomplete.count, 1);
});

test('a site missing georef but with a name reports only the georef fields as missing', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const m = completeModel('m1');
  m.spatialHierarchy.sites = [{ name: 'Site 1', _hasName: true, georef: null }];
  const r = _ccRunRVBChecks([m]);
  assert.equal(r.siteIncomplete.count, 1);
  assert.ok(r.siteIncomplete.ex[0].detail.indexOf('Name') === -1, 'Name is present, must not be listed as missing');
  assert.ok(r.siteIncomplete.ex[0].detail.indexOf('RefLatitude/RefLongitude') !== -1);
  assert.ok(r.siteIncomplete.ex[0].detail.indexOf('RefElevation') !== -1);
});

test('a model with zero sites contributes zero to both count and total (no false "missing site" flag)', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const m = completeModel('m1');
  m.spatialHierarchy.sites = [];
  const r = _ccRunRVBChecks([m]);
  assert.equal(r.siteIncomplete.count, 0);
  assert.equal(r.siteIncomplete.total, 0);
});

test('a model with zero zones (the common case) is not flagged - only zones that exist are checked', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const m = completeModel('m1');
  m.spatialHierarchy.zones = [];
  const r = _ccRunRVBChecks([m]);
  assert.equal(r.zoneIncomplete.count, 0);
  assert.equal(r.zoneIncomplete.total, 0);
});

test('a zone missing ObjectType (but named) is flagged with only ObjectType in the detail', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const m = completeModel('m1');
  m.spatialHierarchy.zones = [{ name: 'Zone 1', objectType: '', _hasName: true }];
  const r = _ccRunRVBChecks([m]);
  assert.equal(r.zoneIncomplete.count, 1);
  assert.equal(r.zoneIncomplete.ex[0].detail, 'ObjectType');
});

test('a storey with an explicit 0.0 elevation (hasElevation true) is not flagged', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const m = completeModel('m1');
  m.storeyData = [{ name: 'Ground', hasElevation: true }];
  const r = _ccRunRVBChecks([m]);
  assert.equal(r.storeyNoElevation.count, 0);
});

test('totals aggregate across multiple models independently per check', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const m1 = completeModel('m1');
  const m2 = completeModel('m2');
  m2.spatialHierarchy.buildings = [{ name: 'IfcBuilding', _hasName: false }, { name: 'Wing B', _hasName: true }];
  const r = _ccRunRVBChecks([m1, m2]);
  assert.equal(r.buildingIncomplete.total, 3, '1 building in m1 + 2 in m2');
  assert.equal(r.buildingIncomplete.count, 1, 'only the unnamed building in m2 fails');
});

test('missing models array (undefined) does not throw and returns zeroed-out checks', () => {
  const { _ccRunRVBChecks } = loadEngine();
  const r = _ccRunRVBChecks(undefined);
  assert.equal(r.projectIncomplete.count, 0);
  assert.equal(r.projectIncomplete.total, 0);
  assert.equal(r._total, 0);
});
