'use strict';
// Locks computeQualityScore (addons/data-quality.js): the headline Quality Score
// used to only fold in runDataQualityChecks + accessibility, silently ignoring
// runBIMModelChecks and runILSChecks even though both are shown in the same Data
// Quality panel. Loaded the same way tests/ids-engine.test.js loads this file -
// it's a plain script assigning onto `window`, so a stub object stands in for it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  assert.equal(typeof window._ccComputeQualityScore, 'function');
  return window;
}

function wall(id, psets) {
  return { expressId: id, props: { globalId: 'G' + id, name: 'Wall' + id, ifcType: 'IfcWall', psets: psets || {} } };
}

test('BIM-basics failures now pull the headline score down', () => {
  const { _ccComputeQualityScore } = loadEngine();
  // 5 walls, none carrying FireRating/IsExternal/LoadBearing - runBIMModelChecks
  // must flag all of them, and that must show up in the composite score.
  const elements = [1, 2, 3, 4, 5].map((i) => wall(i, {}));
  const result = _ccComputeQualityScore(elements, [{ id: 'm1', elements }], { force: true });
  const bimCat = result.breakdown.categories.find((c) => c.label === 'BIM basics');
  assert.ok(bimCat, 'BIM basics must appear in the breakdown');
  assert.ok(bimCat.checks > 0, 'BIM basics must report at least one check');
  assert.equal(bimCat.countsTowardScore, true, 'BIM basics always counts toward the score');
  assert.ok(result.score < 100, 'missing FireRating/IsExternal/LoadBearing on every wall must lower the score');
});

test('ILS/NL-SfB is shown but excluded from the score when the project never adopted it', () => {
  const engine = loadEngine();
  // Deliberately imperfect elements (real projects always have some gaps) -
  // the point isn't that this fixture scores 100, it's that adding "everyone
  // is missing NL-SfB" on top of it must not change the score at all.
  const elements = [1, 2, 3].map((i) => wall(i, { Pset_WallCommon: { FireRating: '60' } }));
  const result = engine._ccComputeQualityScore(elements, [{ id: 'm1', elements }], { force: true });
  const ilsCat = result.breakdown.categories.find((c) => c.label === 'ILS / NL-SfB');
  assert.ok(ilsCat, 'ILS category must still be visible for transparency');
  assert.equal(ilsCat.countsTowardScore, false, 'unused ILS must not drag the score down');

  // Reference score computed from Data-quality + BIM-basics only, replaying
  // the exact same W={error:3,warn:2,info:1} weighted-failure-ratio formula
  // computeQualityScore uses internally - if excluding unadopted ILS is
  // working, the real score must equal this exactly.
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
  const dq = catDamageWeight(engine._ccRunDataQualityChecks(elements));
  const bim = catDamageWeight(engine._ccRunBIMModelChecks(elements));
  const expectedScore = Math.round(100 * (1 - (dq.d + bim.d) / (dq.w + bim.w)));
  assert.equal(result.score, expectedScore, 'unadopted ILS must contribute exactly zero damage/weight');
});

test('ILS/NL-SfB folds into the score once the project is actually using it', () => {
  const { _ccComputeQualityScore } = loadEngine();
  const full = { FireRating: '60', IsExternal: 'TRUE', LoadBearing: 'TRUE' };
  // Every wall carries a valid NL-SfB code -> the project has adopted the
  // standard, so its remaining ILS gaps (Description, ObjectType, ...) should
  // count toward the headline number like every other category does.
  const elements = [1, 2, 3, 4, 5].map((i) => wall(i, { Pset_WallCommon: Object.assign({ 'NL-SfB': '21' }, full) }));
  const result = _ccComputeQualityScore(elements, [{ id: 'm1', elements }], { force: true });
  const ilsCat = result.breakdown.categories.find((c) => c.label === 'ILS / NL-SfB');
  assert.ok(ilsCat);
  assert.equal(ilsCat.countsTowardScore, true, 'adopted NL-SfB must count toward the score');
});

test('get_data_quality (smart-bridge.js) calls the same scoring function, not a re-implementation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'smart-bridge.js'), 'utf8');
  assert.ok(src.includes('_ccComputeQualityScore'), 'the MCP tool must reconcile 1:1 with the in-app score');
});
