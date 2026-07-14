'use strict';
// Locks the IfcFurnishingElement NL-SfB coverage gap-fill in runILSChecks
// (addons/data-quality.js) - RVB BIM Norm v1.1 2.2.7.11 "Meubilair" expects
// furnishing to carry a Name and an NL/SfB code (group 90, Vaste inrichting).
// IfcFurnishingElement was already in the PHYSICAL check set (so noNLSfB/
// missing-name checks already fired), but was absent from IFC_TO_NLSFB, so a
// furnishing element carrying the WRONG code (e.g. a wall's) was never
// caught by the mismatch check.
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

function furnishing(id, psets) {
  return { expressId: id, props: { globalId: 'G' + id, name: 'Desk ' + id, ifcType: 'IfcFurnishingElement', psets: psets || {} } };
}

test('furnishing with no NL/SfB code is flagged (already worked, still true post-fix)', () => {
  const { _ccRunILSChecks } = loadEngine();
  const result = _ccRunILSChecks([furnishing(1, {})]);
  assert.equal(result.noNLSfB.count, 1);
});

test('furnishing correctly coded 90 (Vaste inrichting) is not flagged as a mismatch', () => {
  const { _ccRunILSChecks } = loadEngine();
  const result = _ccRunILSChecks([furnishing(1, { Pset_FurnishingCommon: { 'NL-SfB': '90' } })]);
  assert.equal(result.mismatchNLSfB.count, 0);
});

test('furnishing wrongly carrying a wall NL/SfB code (21) is now caught as a mismatch', () => {
  const { _ccRunILSChecks } = loadEngine();
  const result = _ccRunILSChecks([furnishing(1, { Pset_FurnishingCommon: { 'NL-SfB': '21' } })]);
  assert.equal(result.mismatchNLSfB.count, 1, 'IFC_TO_NLSFB must now include IfcFurnishingElement:[\'90\']');
});
