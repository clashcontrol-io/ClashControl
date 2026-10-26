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

// ── Grouping v2: grid / room / zone / property keys (§21.61) ──
// The whole grouping path (nearby clusters, root-cause helpers, the v2 group environment,
// _groupKeyFor, groupAndSort and the 'element' order helpers) extracted
// from index.html, with _ccGridRef taken from the source too.
const gStart = src.indexOf('var _SPATIAL_CLUSTER_RADIUS_M = 1.5;');
const gEnd = src.indexOf("  // a group's items are sorted worst severity first", gStart);
const rStart = src.indexOf('  function _ccGridRef(lines, x, z) {');
const rEnd = src.indexOf('  // Rooms with geometry and grid lines over all models', rStart);
assert.ok(gEnd !== -1 && rStart !== -1 && rEnd !== -1, 'grouping v2 slices not found');
const v2 = new Function('window', '_cc_t', '_ccDeterministicSeverity', 'SORT_FNS',
  src.slice(rStart, rEnd) + '\n' +
  'function _ccIsSpaceEl(el) { return !!(el && el.props && el.props.ifcType === \'IfcSpace\'); }\n' +
  src.slice(gStart, gEnd) + `
  return { groupAndSort: groupAndSort, env: _ccGroupEnv, gridOf: _ccGroupGridOf, spaceOf: _ccGroupSpaceOf,
    zoneOf: _ccGroupZoneOf, propOf: _ccGroupPropOf, propValueOf: _ccPropValueOf, propertyNames: _ccClashPropertyNames, needsEnv: _ccGroupKeyNeedsEnv };`
)({}, (k, en, v) => en.replace(/\{(\w+)\}/g, (m, n) => v[n]), () => 'minor', {});

function box(x0, y0, z0, x1, y1, z1) { return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } }; }
// Grid A/B/C at scene x = 0, 10, 20 (U), 1/2 at scene z = 0, -10 (V).
function v2Models() {
  const gridLines = [
    { name: 'A', fam: 'U', pts: [0, 5, 0, -15] }, { name: 'B', fam: 'U', pts: [10, 5, 10, -15] }, { name: 'C', fam: 'U', pts: [20, 5, 20, -15] },
    { name: '1', fam: 'V', pts: [-5, 0, 25, 0] }, { name: '2', fam: 'V', pts: [-5, -10, 25, -10] },
  ];
  const arch = { id: 'arch', gridLines, elements: [
    { expressId: 1, props: { ifcType: 'IfcWall', name: 'W1', psets: { Pset_WallCommon: { FireRating: '60min', IsExternal: 'true' } } } },
    { expressId: 2, props: { ifcType: 'IfcWall', name: 'W2', psets: { Pset_WallCommon: { FireRating: '' } } } },
    { expressId: 3, props: { ifcType: 'IfcWall', name: 'W3', groups: [{ cls: 'IfcZone', name: 'Fire zone B' }] } },
    // a room around grid A-1 on level 0, one around B-1 (both 0..3 m high),
    // and a small room nested in the first
    { expressId: 50, props: { ifcType: 'IfcSpace', name: 'Room 0.01', storey: 'Level 0', groups: [{ cls: 'IfcZone', name: 'Fire zone A' }] }, box: box(-4, 0, -4, 4, 3, 4) },
    { expressId: 51, props: { ifcType: 'IfcSpace', name: 'Room 0.02', storey: 'Level 0' }, box: box(6, 0, -4, 14, 3, 4) },
    { expressId: 52, props: { ifcType: 'IfcSpace', name: 'Closet', storey: 'Level 0' }, box: box(1, 0, 1, 3, 3, 3) },
    // same name one storey up: labelled with the storey
    { expressId: 53, props: { ifcType: 'IfcSpace', name: 'Room 0.02', storey: 'Level 1' }, box: box(6, 3.5, -4, 14, 6, 4) },
  ] };
  const mep = { id: 'mep', elements: [
    { expressId: 100, props: { ifcType: 'IfcDuctSegment', name: 'D1', psets: { Pset_DuctSegmentCommon: { FireRating: '30min' }, 'My.Set': { 'Size.Nominal': '200' } } } },
    { expressId: 101, props: { ifcType: 'IfcPipeSegment', name: 'P1' } },
  ] };
  return [arch, mep];
}
function v2Clashes() {
  return [
    { id: 'k1', point: [0.4, 1, 0.3], modelAId: 'arch', elemA: 1, modelBId: 'mep', elemB: 100 },   // A-1, Room 0.01
    { id: 'k2', point: [2, 1, 2], modelAId: 'arch', elemA: 2, modelBId: 'mep', elemB: 100 },       // A-1, Closet (nested)
    { id: 'k3', point: [9.6, 1, 0.2], modelAId: 'arch', elemA: 3, modelBId: 'mep', elemB: 101 },  // B-1, Room 0.02 · Level 0
    { id: 'k4', point: [10, 4, -9.5], modelAId: 'mep', elemA: 101, modelBId: 'arch', elemB: 1 },   // B-2, no room
    { id: 'k5', point: [10, 4, 0], modelAId: 'mep', elemA: 101, modelBId: 'arch', elemB: 2 },      // B-1, Room 0.02 · Level 1
    { id: 'k6', point: null, modelAId: 'mep', elemA: 101, modelBId: 'mep', elemB: 101 },           // no point
  ];
}
function labelsOf(groups) { return groups.map((g) => g.label + '=' + g.items.map((c) => c.id).join(',')); }

test('grouping v2: grid key = nearest grid intersection, "No grid" last', () => {
  const groups = v2.groupAndSort(v2Clashes(), ['grid'], [], { models: v2Models() });
  assert.deepEqual(labelsOf(groups), ['Grid A-1=k1,k2', 'Grid B-1=k3,k5', 'Grid B-2=k4', 'No grid=k6']);
});

test('grouping v2: space key = the room containing the clash point (smallest nested room), "No room" last', () => {
  const groups = v2.groupAndSort(v2Clashes(), ['space'], [], { models: v2Models() });
  assert.deepEqual(labelsOf(groups), ['Closet=k2', 'Room 0.01=k1', 'Room 0.02 · Level 0=k3', 'Room 0.02 · Level 1=k5', 'No room=k4,k6']);
});

test('grouping v2: zone key = IfcZone of side A, else side B, else of the room', () => {
  const env = v2.env(v2Models());
  const c = v2Clashes();
  assert.equal(v2.zoneOf(env, c[0]), 'Fire zone A');          // via Room 0.01
  assert.equal(v2.zoneOf(env, c[2]), 'Fire zone B');          // side A's own zone
  assert.equal(v2.zoneOf(env, c[3]), '');                     // nothing
  const groups = v2.groupAndSort(c, ['zone'], [], { models: v2Models() });
  assert.deepEqual(labelsOf(groups), ['Fire zone A=k1', 'Fire zone B=k3', 'No zone=k2,k4,k5,k6']);
});

test('grouping v2: property key = value on side A, else side B, "(none)" when missing or empty', () => {
  const groups = v2.groupAndSort(v2Clashes(), ['property:Pset_WallCommon.FireRating'], [], { models: v2Models() });
  // k2: A is empty ('') and B has no Pset_WallCommon → (none); k4: B = W1 → 60min
  assert.deepEqual(labelsOf(groups), ['60min=k1,k4', '(none)=k2,k3,k5,k6']);
  const dotted = v2.groupAndSort(v2Clashes(), ['property:My.Set.Size.Nominal'], [], { models: v2Models() });
  assert.deepEqual(labelsOf(dotted), ['200=k1,k2', '(none)=k3,k4,k5,k6']);
  assert.equal(v2.propValueOf({ psets: { 'My.Set': { 'Size.Nominal': 200 } } }, 'My.Set.Size.Nominal'), '200');
  assert.equal(v2.propValueOf({ psets: {} }, 'Pset_X.Y'), null);
});

test('grouping v2: levels combine in order', () => {
  const groups = v2.groupAndSort(v2Clashes(), ['grid', 'space'], [], { models: v2Models() });
  assert.deepEqual(labelsOf(groups), ['Grid A-1 │ Closet=k2', 'Grid A-1 │ Room 0.01=k1', 'Grid B-1 │ Room 0.02 · Level 0=k3',
    'Grid B-1 │ Room 0.02 · Level 1=k5', 'Grid B-2 │ No room=k4', 'No grid │ No room=k6']);
});

test('grouping v2: deterministic — input order and repeated runs give the same groups', () => {
  const norm = (groups) => groups.map((g) => g.label + '=' + g.items.map((c) => c.id).sort().join(','));
  const a = norm(v2.groupAndSort(v2Clashes(), ['grid', 'zone'], [], { models: v2Models() }));
  const b = norm(v2.groupAndSort(v2Clashes().reverse(), ['grid', 'zone'], [], { models: v2Models() }));
  assert.deepEqual(b, a);
  const ms = v2Models(), cs = v2Clashes();
  assert.deepEqual(labelsOf(v2.groupAndSort(cs, ['space'], [], { models: ms })), labelsOf(v2.groupAndSort(cs, ['space'], [], { models: ms })));
});

test('grouping v2: the environment is reused while the models are unchanged and memoises per clash', () => {
  const ms = v2Models();
  const e1 = v2.env(ms), e2 = v2.env(ms.slice());
  assert.equal(e1, e2, 'same ids / elements / grid lines → same environment');
  const c = v2Clashes()[0];
  assert.equal(v2.gridOf(e1, c), 'A-1');
  c.point = [20, 0, -10];                       // the memo answers, not a recompute
  assert.equal(v2.gridOf(e1, c), 'A-1');
  const e3 = v2.env([ms[0], Object.assign({}, ms[1], { elements: ms[1].elements.slice() })]);
  assert.notEqual(e3, e1, 'a replaced element array → a new environment');
  // lazy psets landing (a new _propsVersion) keep the environment but drop the property memo
  const k3 = v2Clashes()[2];
  assert.equal(v2.propOf(e3, k3, 'Pset_WallCommon.FireRating'), null);
  ms[0].elements[2].props.psets = { Pset_WallCommon: { FireRating: '90min' } };
  const e4 = v2.env([Object.assign({}, ms[0], { _propsVersion: 2 }), { id: 'mep', elements: e3.src[1].elements }]);
  assert.equal(e4, e3);
  assert.equal(v2.propOf(e4, k3, 'Pset_WallCommon.FireRating'), '90min');
});

test('grouping v2: property names of the clashing elements, most common first', () => {
  const names = v2.propertyNames(v2Clashes(), v2Models());
  assert.equal(names[0], 'Pset_WallCommon.FireRating');
  assert.ok(names.includes('My.Set.Size.Nominal') && names.includes('Pset_DuctSegmentCommon.FireRating') && names.includes('Pset_WallCommon.IsExternal'));
  assert.equal(names.length, 4);
});

test('grouping v2: the nearby radius is an option of groupAndSort', () => {
  const pts = [{ id: 'a', point: [0, 0, 0] }, { id: 'b', point: [2, 0, 0] }];
  assert.equal(v2.groupAndSort(pts, ['nearby'], [], {}).length, 2, '2 m apart, default 1.5 m → 2 groups');
  assert.equal(v2.groupAndSort(pts, ['nearby'], [], { nearbyRadius: 2.5 }).length, 1, 'radius 2.5 m → 1 group');
  assert.ok(v2.needsEnv('grid') && v2.needsEnv('space') && v2.needsEnv('zone') && v2.needsEnv('property:A.B'));
  assert.ok(!v2.needsEnv('nearby') && !v2.needsEnv('property:') && !v2.needsEnv('storey'));
});
