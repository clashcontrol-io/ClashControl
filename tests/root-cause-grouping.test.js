'use strict';
// "By element" (root-cause) clash-list grouping — groups clashes by
// whichever of the two participating elements touches the most other
// elements overall (typically the MEP run crossing several walls/beams),
// so "one row = one thing to fix" instead of one header per specific
// element PAIR (that's the separate 'cluster' grouping). Pure,
// dependency-free functions in index.html (see the "Root-cause" comment
// block right before _groupKeyFor) — extracted + sandboxed the same way
// tests/windowed-conflict-list.test.js locks _ccBuildConflictRows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _ccElemKeyFor(modelId, expressId, globalId) {');
assert.ok(start !== -1, '_ccElemKeyFor (root-cause grouping) not found');
const end = src.indexOf('window._ccElementGroupSummary = _ccElementGroupSummary;', start);
assert.ok(end !== -1, '_ccElementGroupSummary export not found');
const endLineEnd = src.indexOf('\n', end) + 1;
const sandbox = new Function(
  'window',
  src.slice(start, endLineEnd) + `
  return {
    elemKeyFor: _ccElemKeyFor,
    isLikelyMepType: _ccIsLikelyMepType,
    buildElementDegreeMap: _ccBuildElementDegreeMap,
    rootCauseSideFor: _ccRootCauseSideFor,
    rootCauseKeyFor: _ccRootCauseKeyFor,
    pluralizeWord: _ccPluralizeWord,
    elementGroupSummary: _ccElementGroupSummary,
  };`
);
// Stub the two window._cc* hooks _ccElementGroupSummary reads (guarded with
// typeof checks in production, so a missing stub just falls back silently —
// stubbed here with the real _niceTypeLabel regex, see index.html's
// _niceTypeLabel, so the human-words assertions below match production).
const windowStub = {
  _ccNiceTypeLabel: function(t) { return t ? String(t).replace(/^Ifc/i, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Element' : 'Element'; },
};
const lib = sandbox(windowStub);

// A duct crossing 3 walls + 1 column: 4 clashes, the duct is degree-4, every
// wall/column is degree-1 — the duct should win every tie and become the
// single root-cause group.
function ductScenario() {
  return [
    { id: 'c1', modelAId: 'mep', elemA: 1, elemAType: 'IfcDuctSegment', elemAName: 'Supply duct L0', elemAStorey: 'Level 0',
      modelBId: 'arch', elemB: 10, elemBType: 'IfcWall', elemBName: 'Wall A', elemBStorey: 'Level 0', status: 'open' },
    { id: 'c2', modelAId: 'mep', elemA: 1, elemAType: 'IfcDuctSegment', elemAName: 'Supply duct L0', elemAStorey: 'Level 0',
      modelBId: 'arch', elemB: 11, elemBType: 'IfcWall', elemBName: 'Wall B', elemBStorey: 'Level 0', status: 'open' },
    { id: 'c3', modelAId: 'mep', elemA: 1, elemAType: 'IfcDuctSegment', elemAName: 'Supply duct L0', elemAStorey: 'Level 0',
      modelBId: 'arch', elemB: 12, elemBType: 'IfcWall', elemBName: 'Wall C', elemBStorey: 'Level 0', status: 'open' },
    { id: 'c4', modelAId: 'mep', elemA: 1, elemAType: 'IfcDuctSegment', elemAName: 'Supply duct L0', elemAStorey: 'Level 0',
      modelBId: 'arch', elemB: 20, elemBType: 'IfcColumn', elemBName: 'Column 1', elemBStorey: 'Level 0', status: 'resolved' },
  ];
}

test('_ccElemKeyFor prefers globalId, falls back to model+expressId', () => {
  assert.equal(lib.elemKeyFor('m1', 5, 'GUID123'), 'g:GUID123');
  assert.equal(lib.elemKeyFor('m1', 5, ''), 'mm1:5');
  assert.equal(lib.elemKeyFor('m1', 5, null), 'mm1:5');
});

test('_ccIsLikelyMepType flags duct/pipe/cable/conduit types, not walls/columns', () => {
  assert.equal(lib.isLikelyMepType('IfcDuctSegment'), 1);
  assert.equal(lib.isLikelyMepType('IfcPipeFitting'), 1);
  assert.equal(lib.isLikelyMepType('IfcCableCarrierSegment'), 1);
  assert.equal(lib.isLikelyMepType('IfcWall'), 0);
  assert.equal(lib.isLikelyMepType('IfcColumn'), 0);
  assert.equal(lib.isLikelyMepType(''), 0);
});

test('_ccBuildElementDegreeMap counts how many clashes each element side participates in', () => {
  const deg = lib.buildElementDegreeMap(ductScenario());
  assert.equal(deg[lib.elemKeyFor('mep', 1, '')], 4); // duct: appears in all 4 clashes
});

test('_ccRootCauseSideFor picks the higher-degree side — the duct, not any one wall', () => {
  const clashes = ductScenario();
  clashes.forEach((c) => {
    const degMap = lib.buildElementDegreeMap(clashes);
    assert.equal(lib.rootCauseSideFor(c, degMap), 'A', 'elemA (the duct) should win every one of these clashes');
  });
});

test('_ccRootCauseSideFor ties (equal degree) break toward the MEP-ish type', () => {
  const clashes = [{ id: 'c1', modelAId: 'm1', elemA: 1, elemAType: 'IfcWall', modelBId: 'm2', elemB: 2, elemBType: 'IfcDuctSegment' }];
  const degMap = lib.buildElementDegreeMap(clashes);
  assert.equal(lib.rootCauseSideFor(clashes[0], degMap), 'B', 'the duct (B) should win the tie over the wall (A)');
});

test('_ccRootCauseKeyFor groups every clash under the same root-cause element key', () => {
  const clashes = ductScenario();
  const degMap = lib.buildElementDegreeMap(clashes);
  const keys = clashes.map((c) => lib.rootCauseKeyFor(c, degMap));
  assert.deepEqual(new Set(keys), new Set([keys[0]]), 'all 4 clashes should collapse to one root-cause group');
});

test('_ccPluralizeWord handles the common cases used for subtitle counts', () => {
  assert.equal(lib.pluralizeWord('wall'), 'walls');
  assert.equal(lib.pluralizeWord('column'), 'columns');
  assert.equal(lib.pluralizeWord('duct segment'), 'duct segments');
  assert.equal(lib.pluralizeWord('storey'), 'storeys'); // dictionary word "stories" is close enough; simple rule keeps it consistent
});

test('_ccElementGroupSummary builds a human title, "crosses N type" subtitle, storey, and worst severity', () => {
  const summary = lib.elementGroupSummary(ductScenario());
  assert.equal(summary.title, 'Supply duct L0 (Duct Segment)');
  assert.match(summary.subtitle, /crosses/);
  assert.match(summary.subtitle, /3 walls/);
  assert.match(summary.subtitle, /1 column/);
  assert.equal(summary.storey, 'Level 0');
});

test('_ccElementGroupSummary returns null for an empty group', () => {
  assert.equal(lib.elementGroupSummary([]), null);
  assert.equal(lib.elementGroupSummary(null), null);
});
