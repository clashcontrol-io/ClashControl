'use strict';
// Locks computeQualityScore's handling of runRVBChecks (addons/data-quality.js).
// RVB is a single Dutch central-government client's own BIM norm - narrower than
// the already-region-gated NL-SfB category - so it must always be visible in the
// breakdown for transparency but never drag the headline score down, regardless
// of adoption. This also exercises _foldEntityCheckMap, which (unlike
// _foldCheckMap) must read each bucket's own `total` field rather than a single
// shared checksResult._total, since runRVBChecks mixes project/site/building/
// zone/storey counts that are not the same population.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  return window;
}

function wall(id) {
  return { expressId: id, props: { globalId: 'G' + id, name: 'Wall' + id, ifcType: 'IfcWall', psets: { Pset_WallCommon: { FireRating: '60', IsExternal: 'TRUE', LoadBearing: 'TRUE' } } } };
}

function incompleteModel(id, elements) {
  return {
    id, elements,
    spatialHierarchy: { project: { name: 'IfcProject', _hasName: false }, sites: [], buildings: [], zones: [] },
    storeyData: [],
  };
}

test('RVB always appears in the breakdown, even when every RVB check fails', () => {
  const { _ccComputeQualityScore } = loadEngine();
  const elements = [1, 2, 3].map(wall);
  const result = _ccComputeQualityScore(elements, [incompleteModel('m1', elements)], { force: true });
  const rvbCat = result.breakdown.categories.find((c) => c.label === 'RVB BIM Norm');
  assert.ok(rvbCat, 'RVB BIM Norm must appear in the breakdown');
  assert.ok(rvbCat.checks > 0);
});

test('RVB never counts toward the headline score, regardless of how badly it fails', () => {
  const { _ccComputeQualityScore } = loadEngine();
  const elements = [1, 2, 3].map(wall);
  const result = _ccComputeQualityScore(elements, [incompleteModel('m1', elements)], { force: true });
  const rvbCat = result.breakdown.categories.find((c) => c.label === 'RVB BIM Norm');
  assert.equal(rvbCat.countsTowardScore, false);

  // Reference score computed WITHOUT RVB at all - if RVB is correctly excluded,
  // the real score (with a maximally-failing RVB category) must equal this.
  const W = { error: 3, warn: 2, info: 1 };
  function catDamageWeight(checks) {
    var total = checks._total || elements.length || 1, d = 0, w = 0;
    Object.keys(checks).forEach((k) => {
      if (k.charAt(0) === '_') return;
      var c = checks[k]; if (!c || typeof c.count !== 'number') return;
      var weight = W[c.sev] || 1;
      d += Math.min(1, c.count / total) * weight;
      w += weight;
    });
    return { d: d, w: w };
  }
  const engine = loadEngine();
  const dq = catDamageWeight(engine._ccRunDataQualityChecks(elements));
  const bim = catDamageWeight(engine._ccRunBIMModelChecks(elements));
  const expectedScore = Math.round(100 * (1 - (dq.d + bim.d) / (dq.w + bim.w)));
  assert.equal(result.score, expectedScore, 'a maximally-failing RVB category must contribute exactly zero damage/weight');
});

test('per-bucket totals are respected: a project-name failure does not get diluted by thousands of elements', () => {
  const { _ccComputeQualityScore } = loadEngine();
  // 500 perfectly-compliant walls, but the one IfcProject has no name.
  // With a shared _total (the old _foldCheckMap behaviour) this would read as
  // ~0.2% damage; with per-bucket totals it must read as 100% (1 of 1 projects).
  const elements = Array.from({ length: 500 }, (_, i) => wall(i));
  const result = _ccComputeQualityScore(elements, [incompleteModel('m1', elements)], { force: true });
  const rvbCat = result.breakdown.categories.find((c) => c.label === 'RVB BIM Norm');
  assert.ok(rvbCat.score < 90, 'a fully-missing project name must visibly tank the RVB category score, not round away to ~100');
});
