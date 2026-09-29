'use strict';
// "Smarter clashes" — the pure logic in clash-classification-core.js:
//   1. element roles + deterministic severity (penetration depth x role,
//      soft gap vs required clearance)
//   2. provision-for-void: oriented opening boxes, triangle clipping and the
//      provided / partial classification
// Runs with plain node (no node_modules, no browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../clash-classification-core');

// ── element roles ────────────────────────────────────────────────────────

test('role table: structural / MEP run / terminal / architectural / finish / other', () => {
  const r = (t, o) => core.elementRole(t, o);
  for (const t of ['IfcBeam', 'IfcColumn', 'IfcFooting', 'IfcPile', 'IfcMember']) assert.equal(r(t), 'structural', t);
  for (const t of ['IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment', 'IfcFlowSegment']) assert.equal(r(t), 'mep-main', t);
  for (const t of ['IfcFlowTerminal', 'IfcDuctFitting', 'IfcPipeFitting', 'IfcLightFixture', 'IfcFlowController', 'IfcSensor']) assert.equal(r(t), 'mep-terminal', t);
  for (const t of ['IfcDoor', 'IfcWindow', 'IfcStair', 'IfcRailing', 'IfcRoof', 'IfcCurtainWall']) assert.equal(r(t), 'architectural', t);
  for (const t of ['IfcCovering', 'IfcFurnishingElement', 'IfcFurniture', 'IfcSystemFurnitureElement']) assert.equal(r(t), 'finish', t);
  assert.equal(r('IfcBuildingElementProxy'), 'other');
  assert.equal(r('IfcSomethingNew'), 'other');
  assert.equal(r('DuctSegment'), 'mep-main', 'a missing Ifc prefix is tolerated');
});

test('walls are structural only when LoadBearing=true; slabs are structural unless LoadBearing=false', () => {
  assert.equal(core.elementRole('IfcWall', { loadBearing: true }), 'structural');
  assert.equal(core.elementRole('IfcWallStandardCase', { loadBearing: true }), 'structural');
  assert.equal(core.elementRole('IfcWall', { loadBearing: false }), 'architectural');
  assert.equal(core.elementRole('IfcWall', { loadBearing: null }), 'architectural');
  assert.equal(core.elementRole('IfcWall'), 'architectural');
  assert.equal(core.elementRole('IfcSlab', { loadBearing: null }), 'structural');
  assert.equal(core.elementRole('IfcSlab', { loadBearing: true }), 'structural');
  assert.equal(core.elementRole('IfcSlab', { loadBearing: false }), 'architectural');
});

test('unknown IFC types fall back to the element discipline (legacy / bridge clashes)', () => {
  assert.equal(core.elementRole('', { discipline: 'structural' }), 'structural');
  assert.equal(core.elementRole(undefined, { discipline: 'mep' }), 'mep-main');
  assert.equal(core.elementRole('IfcBuildingElementProxy', { discipline: 'civil' }), 'infrastructure');
  assert.equal(core.elementRole('IfcBuildingElementProxy', { discipline: 'architectural' }), 'architectural');
  // a KNOWN type is never overridden by the discipline
  assert.equal(core.elementRole('IfcCovering', { discipline: 'structural' }), 'finish');
});

test('criticality ordering: structural > MEP run = infrastructure > terminal = architectural = other > finish', () => {
  const c = core.roleCriticality;
  assert.deepEqual([c('structural'), c('mep-main'), c('infrastructure'), c('architectural'), c('mep-terminal'), c('other'), c('finish')], [3, 2, 2, 1, 1, 1, 0]);
  assert.equal(c('not-a-role'), 1);
});

test('loadBearingOf reads LoadBearing from any pset, any case, any boolean spelling', () => {
  const lb = (v) => core.loadBearingOf({ psets: { Pset_WallCommon: { LoadBearing: v } } });
  assert.equal(lb(true), true);
  assert.equal(lb('TRUE'), true);
  assert.equal(lb('.T.'), true);
  assert.equal(lb(1), true);
  assert.equal(lb(false), false);
  assert.equal(lb('false'), false);
  assert.equal(lb(0), false);
  assert.equal(lb('maybe'), null);
  assert.equal(core.loadBearingOf({ psets: { Custom: { loadbearing: true } } }), true);
  assert.equal(core.loadBearingOf({ psets: { Pset_WallCommon: { FireRating: 'EI30' } } }), null);
  assert.equal(core.loadBearingOf({}), null);
  assert.equal(core.loadBearingOf(null), null);
});

// ── deterministic severity ───────────────────────────────────────────────

function hard(roleA, roleB, depthMm, extra) {
  return Object.assign({ type: 'hard', roleA, roleB, distance: -depthMm }, extra || {});
}
const sev = (c) => core.deterministicSeverity(c);

test('hard clash, structural involved: >=20mm critical, 10-19mm major, <10mm minor', () => {
  assert.equal(sev(hard('structural', 'mep-main', 20)), 'critical');
  assert.equal(sev(hard('structural', 'mep-main', 19)), 'major');
  assert.equal(sev(hard('structural', 'mep-main', 10)), 'major');
  assert.equal(sev(hard('structural', 'mep-main', 9)), 'minor');
  assert.equal(sev(hard('structural', 'structural', 300)), 'critical');
});

test('hard clash between a MEP run and non-structural: >=50mm critical, >=10mm major', () => {
  assert.equal(sev(hard('mep-main', 'architectural', 50)), 'critical');
  assert.equal(sev(hard('mep-main', 'architectural', 49)), 'major');
  assert.equal(sev(hard('mep-main', 'architectural', 10)), 'major');
  assert.equal(sev(hard('mep-main', 'architectural', 4)), 'minor');
});

test('hard clash between terminals / fittings / architectural only needs >=100mm for critical', () => {
  assert.equal(sev(hard('mep-terminal', 'architectural', 99)), 'major');
  assert.equal(sev(hard('mep-terminal', 'architectural', 100)), 'critical');
  assert.equal(sev(hard('mep-terminal', 'mep-terminal', 60)), 'major');
});

test('finishes (covering, furniture) are never critical; shallow finish clashes are info', () => {
  assert.equal(sev(hard('finish', 'finish', 500)), 'major');
  assert.equal(sev(hard('finish', 'finish', 49)), 'minor');
  assert.equal(sev(hard('finish', 'finish', 5)), 'info');
  assert.equal(sev(hard('finish', 'finish', 5000)), 'major');
  // ...but a finish against a structural element is judged by the structural rule
  assert.equal(sev(hard('finish', 'structural', 30)), 'critical');
});

test('pair criticality is the MAX of the two roles (the low side never dilutes the high side)', () => {
  assert.equal(sev(hard('finish', 'mep-main', 60)), sev(hard('mep-main', 'mep-main', 60)));
  assert.equal(sev(hard('architectural', 'structural', 25)), sev(hard('structural', 'structural', 25)));
});

test('a large overlap volume bumps minor/major up one tier for MEP runs and structure only', () => {
  assert.equal(sev(hard('mep-main', 'architectural', 5, { overlapVolM3: 0.2 })), 'major');
  assert.equal(sev(hard('mep-main', 'architectural', 20, { overlapVolM3: 0.2 })), 'critical');
  assert.equal(sev(hard('mep-main', 'architectural', 5, { overlapVolM3: 0.01 })), 'minor');
  assert.equal(sev(hard('mep-terminal', 'architectural', 5, { overlapVolM3: 0.2 })), 'minor');
});

test('soft clash: gap vs required clearance (<=30% near miss -> major), finishes drop one tier', () => {
  const soft = (gap, req, roleA, roleB) => ({ type: 'soft', clearanceMm: gap, requiredClearanceMm: req, roleA: roleA || 'mep-main', roleB: roleB || 'structural' });
  assert.equal(sev(soft(15, 50)), 'major');
  assert.equal(sev(soft(16, 50)), 'minor');
  assert.equal(sev(soft(0, 50)), 'major'); // touching
  assert.equal(sev(soft(30, 100)), 'major');
  assert.equal(sev(soft(31, 100)), 'minor');
  assert.equal(sev(soft(60, 200)), 'major', 'the SAME gap is worse against a tight requirement than a generous one');
  assert.equal(sev(soft(60, 100)), 'minor');
  assert.equal(sev(soft(10, 50, 'finish', 'finish')), 'minor');
  assert.equal(sev(soft(40, 50, 'finish', 'finish')), 'info');
  // no requiredClearanceMm on the clash: defaults to the 50mm engine default
  assert.equal(sev({ type: 'soft', clearanceMm: 15 }), 'major');
  assert.equal(sev({ type: 'soft', clearanceMm: 16 }), 'minor');
  // no gap data at all: no signal to escalate on
  assert.equal(sev({ type: 'soft' }), 'minor');
});

test('duplicate is info, visibility is major, null is info; vocabulary is aiSeverity\'s', () => {
  assert.equal(sev({ type: 'duplicate' }), 'info');
  assert.equal(sev({ type: 'visibility' }), 'major');
  assert.equal(sev(null), 'info');
  const valid = ['critical', 'major', 'minor', 'info'];
  for (const c of [hard('structural', 'mep-main', 0), hard('finish', 'finish', 1), { type: 'soft' }, {}, { type: 'hard' }]) assert.ok(valid.includes(sev(c)));
});

test('legacy clashes without roleA/roleB derive roles from element types and disciplines', () => {
  const legacy = { type: 'hard', elemAType: 'IfcDuctSegment', elemBType: 'IfcBeam', disciplines: ['mep', 'structural'], distance: -20 };
  assert.equal(sev(legacy), 'critical');
  const finishOnly = { type: 'hard', elemAType: 'IfcCovering', elemBType: 'IfcFurnishingElement', distance: -200 };
  assert.equal(sev(finishOnly), 'major');
});

test('classifyClashes uses the same model and stamps the verdict as rule-derived', () => {
  const c = { id: 'c', type: 'hard', elemAType: 'IfcDuctSegment', elemBType: 'IfcColumn', disciplines: ['mep', 'structural'], distance: -25, point: [0, 0, 0] };
  const finish = { id: 'f', type: 'hard', elemAType: 'IfcCovering', elemBType: 'IfcCovering', disciplines: ['architectural', 'architectural'], distance: -25, point: [10, 0, 0] };
  core.classifyClashes([c, finish]);
  assert.equal(c.aiSeverity, core.deterministicSeverity(c));
  assert.equal(c.aiSeverity, 'critical');
  assert.equal(c._sevSource, 'rule');
  assert.equal(finish.aiSeverity, 'minor');
  assert.match(c.aiReason, /25mm deep/);
});

test('an AI-authored severity is never overwritten by classifyClashes', () => {
  const c = { id: 'c', type: 'hard', aiSeverity: 'info', aiCategory: 'manual', distance: -300, roleA: 'structural', roleB: 'structural' };
  core.classifyClashes([c]);
  assert.equal(c.aiSeverity, 'info');
  assert.equal(c._sevSource, undefined);
});

// ── opening boxes ────────────────────────────────────────────────────────

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// axis-aligned opening centred at (cx,cy,cz) with half extents (hx,hy,hz)
function box(cx, cy, cz, hx, hy, hz) { return core.obbFromLocalBox([cx - hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz + hz], IDENT); }

test('obbFromLocalBox: identity transform gives centre, unit axes and half extents', () => {
  const o = box(1, 2, 3, 0.5, 0.25, 0.1);
  assert.deepEqual(o, [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0.25, 0.1]);
  assert.equal(o.length, core.OPENING_STRIDE);
});

test('obbFromLocalBox applies translation, rotation and rounds to 0.1mm', () => {
  // rotate 90deg about Y (scene up), translate by (10, 0, -6): local x axis -> world -z
  const m = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 10, 0, -6, 1];
  const o = core.obbFromLocalBox([-0.4, -0.1, -0.2], [0.4, 0.1, 0.2], m);
  assert.deepEqual(o.slice(0, 3), [10, 0, -6]);
  assert.deepEqual(o.slice(3, 6), [0, 0, -1]); // local x axis in world
  assert.deepEqual(o.slice(12), [0.4, 0.1, 0.2]);
  const skew = core.obbFromLocalBox([0, 0, 0], [1, 1, 1], IDENT.map((v, i) => (i === 12 ? 0.123456789 : v)));
  assert.equal(skew[0], 0.6235, 'rounded to 4 decimals');
});

test('obbFromLocalBox honours a uniformly scaled matrix (unit conversion baked into the transform)', () => {
  const m = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
  const o = core.obbFromLocalBox([-1, -1, -1], [1, 1, 1], m);
  assert.deepEqual(o.slice(3, 12), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(o.slice(12), [2, 2, 2]);
});

test('obbContains: inside, on the boundary, tolerance, and a rotated box', () => {
  const o = box(0, 0, 0, 1, 1, 1);
  assert.equal(core.obbContains(o, 0.5, 0.5, 0.5, 0), true);
  assert.equal(core.obbContains(o, 1, 1, 1, 0), true);
  assert.equal(core.obbContains(o, 1.01, 0, 0, 0), false);
  assert.equal(core.obbContains(o, 1.01, 0, 0, 0.02), true);
  const rot = core.obbFromLocalBox([-1, -0.1, -0.1], [1, 0.1, 0.1], [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // long axis -> world y
  assert.equal(core.obbContains(rot, 0, 0.9, 0, 0), true);
  assert.equal(core.obbContains(rot, 0.9, 0, 0, 0), false);
});

// ── clipping ─────────────────────────────────────────────────────────────

// axis-aligned box as 12 triangles
function boxTris(x0, y0, z0, x1, y1, z1) {
  const v = { a: [x0, y0, z0], b: [x1, y0, z0], c: [x1, y1, z0], d: [x0, y1, z0], e: [x0, y0, z1], f: [x1, y0, z1], g: [x1, y1, z1], h: [x0, y1, z1] };
  const faces = [['a', 'b', 'c'], ['a', 'c', 'd'], ['e', 'g', 'f'], ['e', 'h', 'g'], ['a', 'b', 'f'], ['a', 'f', 'e'], ['d', 'c', 'g'], ['d', 'g', 'h'], ['a', 'd', 'h'], ['a', 'h', 'e'], ['b', 'c', 'g'], ['b', 'g', 'f']];
  const out = [];
  faces.forEach((f) => f.forEach((k) => out.push(...v[k])));
  return new Float32Array(out);
}
function extent(pts) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], pts[i + a]); mx[a] = Math.max(mx[a], pts[i + a]); }
  return { mn, mx };
}

test('clipTrianglesToBox: a long duct through a wall slab clips to its cross-section at the wall faces', () => {
  // duct 0.8 x 0.4 along x from -5..15, wall slab x in [9.9,10.1]
  const duct = boxTris(-5, 6.1, 2.5, 15, 6.9, 2.9);
  const pts = core.clipTrianglesToBox(duct, [9.9, 0, 0], [10.1, 12, 3.2]);
  const e = extent(pts);
  assert.ok(Math.abs(e.mn[0] - 9.9) < 1e-5 && Math.abs(e.mx[0] - 10.1) < 1e-5);
  assert.ok(Math.abs(e.mn[1] - 6.1) < 1e-5 && Math.abs(e.mx[1] - 6.9) < 1e-5);
  assert.ok(Math.abs(e.mn[2] - 2.5) < 1e-5 && Math.abs(e.mx[2] - 2.9) < 1e-5);
});

test('clipTrianglesToBox: no overlap -> empty; too many triangles -> null (unknown)', () => {
  assert.deepEqual(core.clipTrianglesToBox(boxTris(0, 0, 0, 1, 1, 1), [5, 5, 5], [6, 6, 6]), []);
  assert.equal(core.clipTrianglesToBox(boxTris(0, 0, 0, 1, 1, 1), [0, 0, 0], [1, 1, 1], 5), null);
});

test('clipTrianglesToBox: a triangle fully inside is returned unchanged', () => {
  const tri = new Float32Array([1, 1, 1, 2, 1, 1, 1, 2, 1]);
  const pts = core.clipTrianglesToBox(tri, [0, 0, 0], [5, 5, 5]);
  assert.deepEqual(Array.from(pts), Array.from(tri));
});

// ── provided / partial classification ───────────────────────────────────

// wall slab x in [9.925,10.075], y 0.15..11.85, z 0..3.2; opening x 9.8..10.2
const WALL = { min: [9.925, 0.15, 0], max: [10.075, 11.85, 3.2] };
function regionOf(ductTris) { return core.clipTrianglesToBox(ductTris, WALL.min, WALL.max); }
const opening = box(10, 6.5, 2.7, 0.2, 0.43, 0.23); // 0.86 x 0.46 around a 0.8 x 0.4 duct

test('a duct that fits through the opening is "provided" (hard and soft)', () => {
  const duct = boxTris(-1, 6.1, 2.5, 21, 6.9, 2.9);
  const pts = regionOf(duct);
  assert.equal(core.classifyOpening(opening, pts, 0.02, 'hard'), 'provided');
  assert.equal(core.classifyOpening(opening, pts, 0.02, 'soft'), 'provided');
});

test('a duct slightly larger than the opening is still "provided" within the 20mm tolerance, not beyond', () => {
  const nearlyFits = regionOf(boxTris(-1, 6.08, 2.48, 21, 6.92, 2.92)); // 10mm proud all round
  assert.equal(core.classifyOpening(opening, nearlyFits, 0.02, 'hard'), 'provided');
  const proud = regionOf(boxTris(-1, 6.0, 2.4, 21, 7.0, 3.0)); // 70mm proud
  assert.equal(core.classifyOpening(opening, proud, 0.02, 'hard'), 'partial');
});

test('an undersized opening (duct bigger on every side) is "partial" for hard clashes and unrelated for soft', () => {
  const small = box(10, 6.5, 2.7, 0.2, 0.3, 0.15); // 0.6 x 0.3 vs duct 0.8 x 0.4
  const pts = regionOf(boxTris(-1, 6.1, 2.5, 21, 6.9, 2.9));
  assert.equal(core.classifyOpening(small, pts, 0.02, 'hard'), 'partial');
  assert.equal(core.classifyOpening(small, pts, 0.02, 'soft'), null);
});

test('an element far from every opening is unrelated (null)', () => {
  const pts = regionOf(boxTris(-1, 2.0, 0.5, 21, 2.4, 0.9));
  assert.equal(core.classifyOpening(opening, pts, 0.02, 'hard'), null);
});

test('a duct half in the opening and half in solid wall is partial', () => {
  const pts = regionOf(boxTris(-1, 6.7, 2.5, 21, 7.5, 2.9)); // y 6.7..7.5 straddles the opening edge (6.93)
  assert.equal(core.classifyOpening(opening, pts, 0.02, 'hard'), 'partial');
});

test('several openings: provided when ANY one contains the whole region; flat and nested formats agree', () => {
  const other = box(10, 2, 2.7, 0.2, 0.43, 0.23);
  const flat = other.concat(opening);
  const pts = regionOf(boxTris(-1, 6.1, 2.5, 21, 6.9, 2.9));
  assert.equal(core.classifyOpening(flat, pts, 0.02, 'hard'), 'provided');
  assert.equal(core.classifyOpening([other, opening], pts, 0.02, 'hard'), 'provided');
  assert.equal(core.classifyOpening([other], pts, 0.02, 'hard'), null);
});

test('degenerate inputs never throw', () => {
  assert.equal(core.classifyOpening(null, [0, 0, 0], 0.02, 'hard'), null);
  assert.equal(core.classifyOpening(opening, [], 0.02, 'hard'), null);
  assert.equal(core.classifyOpening([], [0, 0, 0], 0.02, 'hard'), null);
  assert.equal(core.classifyOpening([[1, 2, 3]], [0, 0, 0], 0.02, 'hard'), null);
  assert.equal(core.classifyOpening(opening, [10, 6.5, 2.7], undefined, 'hard'), 'provided');
});

test('rotated (diagonal) wall + opening: the oriented box keeps a snug fit "provided"', () => {
  // opening rotated 45deg about scene-up (y), 0.4 x 0.4 in plan, 1 high
  const c = Math.SQRT1_2;
  const rot = [c, 0, -c, 0, 0, 1, 0, 0, c, 0, c, 0, 5, 1, 5, 1];
  const o = core.obbFromLocalBox([-0.2, -0.5, -0.5], [0.2, 0.5, 0.5], rot);
  // a thin pipe along the wall thickness direction through the opening centre
  const inside = [5, 1, 5, 5.05, 1.1, 5.05, 4.95, 0.9, 4.95];
  assert.equal(core.classifyOpening(o, inside, 0.01, 'hard'), 'provided');
  // an axis-aligned AABB of the SAME opening would accept this point; the OBB must not
  const cornerOfAabb = [5 + 0.4, 1, 5 - 0.4]; // 0.4 in x and z: inside the opening's AABB (+-0.495), outside the OBB
  assert.equal(core.obbContains(o, cornerOfAabb[0], cornerOfAabb[1], cornerOfAabb[2], 0), false);
});

test('openingVisibility: a merged group is hidden only when every member is provided', () => {
  assert.ok(core.openingVisibility(undefined) > core.openingVisibility('partial'));
  assert.ok(core.openingVisibility('partial') > core.openingVisibility('provided'));
});
