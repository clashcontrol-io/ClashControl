'use strict';
// clash-exceptions-core.js: intersection exceptions (straight penetrations,
// flush fittings) and the "A requires B" presence check (a structural
// penetration needs an opening or a provision). Pure post-classification on
// clash fields + element vertices — synthetic geometry only.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../clash-exceptions-core');

// 8 corners of a box, optionally rotated about the Y axis by `deg` around its centre
function box(min, max, deg) {
  const c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2), out = [];
  const a = (deg || 0) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const dx = x - c[0], dz = z - c[2];
    out.push(c[0] + cs * dx + sn * dz, y, c[2] - sn * dx + cs * dz);
  }
  return out;
}
// round pipe: 16-point rings at both ends of the segment p0 -> p1
function pipe(p0, p1, r) {
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], L = Math.hypot(...d), u = d.map((v) => v / L);
  const t = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const a = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]], al = Math.hypot(...a);
  const e1 = a.map((v) => v / al), e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  const out = [];
  for (const p of [p0, p1]) for (let s = 0; s < 16; s++) {
    const g = s * Math.PI / 8, cg = Math.cos(g) * r, sg = Math.sin(g) * r;
    out.push(p[0] + e1[0] * cg + e2[0] * sg, p[1] + e1[1] * cg + e2[1] * sg, p[2] + e1[2] * cg + e2[2] * sg);
  }
  return out;
}
function clash(extra) {
  return Object.assign({ id: 'c' + Math.random().toString(36).slice(2), type: 'hard', distance: -400, status: 'open',
    elemAType: 'IfcDuctSegment', elemBType: 'IfcWall', roleA: 'mep-main', roleB: 'structural',
    elemAName: 'Supply duct', elemBName: 'Core wall', modelAId: 'M', modelBId: 'S', elemA: 1, elemB: 2 }, extra || {});
}
// wall 200 mm thick (x 0..0.2), 4 m long (y), 3 m high (z)
const WALL = box([0, -2, 0], [0.2, 2, 3]);
// 600 x 400 duct along x from -1 to +1.2 (sticks out 1 m on each face)
const DUCT = box([-1, -0.3, 1.2], [1.2, 0.3, 1.6]);

test('defaults: every rule off; normalize fills the values, clamps the angle', () => {
  const n = X.normalize(undefined);
  assert.equal(n.penetration.on || n.fitting.on || n.requireProvision.on, false);
  assert.equal(X.anyOn({}), false);
  assert.equal(X.anyOn({ fitting: { on: true } }), true);
  assert.equal(X.normalize({ penetration: { on: true, angleDeg: 80 } }).penetration.angleDeg, 45);
  assert.equal(X.normalize({ penetration: { on: 'yes' } }).penetration.on, false, 'only true switches a rule on');
});

test('penetration: orthogonal duct through a wall, both sides, any argument order', () => {
  const r = X.passThroughOrthogonal(clash(), { ptsA: DUCT, ptsB: WALL });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.passer, 'A');
  assert.ok(r.angleDeg < 0.01);
  assert.deepEqual(r.protrusionMm, [1000, 1000]);
  const sw = clash({ elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', roleA: 'structural', roleB: 'mep-main' });
  const r2 = X.passThroughOrthogonal(sw, { ptsA: WALL, ptsB: DUCT });
  assert.equal(r2.ok, true);
  assert.equal(r2.passer, 'B');
  // a short rectangular duct (cross-section aspect 1.5) is still read exactly
  const stub = box([-0.4, -0.3, 1.2], [0.6, 0.3, 1.6]);
  assert.equal(X.passThroughOrthogonal(clash(), { ptsA: stub, ptsB: WALL, minProtrusionMm: 20 }).ok, true);
});

test('penetration: oblique vs orthogonal, angle tolerance (world-aligned or not)', () => {
  const SLAB = box([-2, -2, 1.0], [2, 2, 1.25]);
  const c = clash({ elemAType: 'IfcPipeSegment', elemBType: 'IfcSlab' });
  const vertical = pipe([0, 0, 0], [0, 0, 2.5], 0.05);
  assert.equal(X.passThroughOrthogonal(c, { ptsA: vertical, ptsB: SLAB }).ok, true, 'vertical riser through a slab');
  const tilt = (deg) => { const a = deg * Math.PI / 180; return pipe([0, 0, 0], [2.5 * Math.sin(a), 0, 2.5 * Math.cos(a)], 0.05); };
  const r30 = X.passThroughOrthogonal(c, { ptsA: tilt(30), ptsB: SLAB });
  assert.equal(r30.ok, false);
  assert.equal(r30.reason, 'oblique');
  assert.ok(Math.abs(r30.angleDeg - 30) < 0.5, 'angle read from the geometry: ' + r30.angleDeg);
  assert.equal(X.passThroughOrthogonal(c, { ptsA: tilt(3), ptsB: SLAB, angleDeg: 5 }).ok, true, '3 degrees is within 5');
  assert.equal(X.passThroughOrthogonal(c, { ptsA: tilt(7), ptsB: SLAB, angleDeg: 5 }).reason, 'oblique', '7 degrees is not');
  // a wall that is itself rotated 20 degrees about the vertical, duct along its normal
  const wallR = box([0, -2, 0], [0.2, 2, 3], 0);
  const rot = (pts, deg) => { const a = deg * Math.PI / 180, o = []; for (let i = 0; i < pts.length; i += 3) o.push(pts[i] * Math.cos(a) - pts[i + 1] * Math.sin(a), pts[i] * Math.sin(a) + pts[i + 1] * Math.cos(a), pts[i + 2]); return o; };
  assert.equal(X.passThroughOrthogonal(clash(), { ptsA: rot(DUCT, 20), ptsB: rot(wallR, 20) }).ok, true, 'rotated plan grid');
  assert.equal(X.passThroughOrthogonal(clash(), { ptsA: rot(DUCT, 20), ptsB: wallR }).reason, 'oblique', 'duct at 20 degrees to the wall normal');
});

test('penetration: protrusion beyond EACH face, threshold in mm', () => {
  const ends = (x0, x1) => box([x0, -0.3, 1.2], [x1, 0.3, 1.6]);
  // sticks out 10 mm on the near face, 1 m on the far face
  const r = X.passThroughOrthogonal(clash(), { ptsA: ends(-0.01, 1.2), ptsB: WALL, minProtrusionMm: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'protrusion');
  assert.deepEqual(r.protrusionMm, [10, 1000]);
  assert.equal(X.passThroughOrthogonal(clash(), { ptsA: ends(-0.01, 1.2), ptsB: WALL, minProtrusionMm: 5 }).ok, true);
  assert.equal(X.passThroughOrthogonal(clash(), { ptsA: ends(0.05, 1.2), ptsB: WALL, minProtrusionMm: 0 }).reason, 'protrusion', 'ends inside the wall');
});

test('penetration: roles, geometry and findings that are never excepted', () => {
  assert.equal(X.passThroughOrthogonal(clash({ elemAType: 'IfcBeam', roleA: 'structural' }), { ptsA: DUCT, ptsB: WALL }).reason, 'roles', 'a beam is no MEP run');
  assert.equal(X.passThroughOrthogonal(clash({ elemAType: 'IfcBuildingElementProxy', roleA: 'mep-main' }), { ptsA: DUCT, ptsB: WALL }).ok, true, 'MEP role counts as a run');
  assert.equal(X.passThroughOrthogonal(clash({ elemBType: 'IfcColumn' }), { ptsA: DUCT, ptsB: WALL }).reason, 'roles', 'a column is no planar host');
  assert.equal(X.passThroughOrthogonal(clash(), {}).reason, 'no-geometry', 'no vertices: nothing is excepted');
  assert.equal(X.passThroughOrthogonal(clash({ type: 'soft' }), { ptsA: DUCT, ptsB: WALL }).reason, 'not-hard');
  assert.equal(X.passThroughOrthogonal(clash({ opening: 'partial' }), { ptsA: DUCT, ptsB: WALL }).reason, 'opening-too-small');
  const cube = box([-1, -1, 0], [1, 1, 2]);
  assert.equal(X.passThroughOrthogonal(clash(), { ptsA: DUCT, ptsB: cube }).reason, 'host-not-planar');
});

test('fitting: flush in a ceiling within the tolerance, set into the host', () => {
  const CEIL = box([-2, -2, 2.8], [2, 2, 2.82]);
  const c = clash({ elemAType: 'IfcLightFixture', roleA: 'mep-terminal', elemBType: 'IfcCovering', roleB: 'finish' });
  const light = (z0, z1) => box([-0.3, -0.3, z0], [0.3, 0.3, z1]);
  const r = X.flushFitting(c, { ptsA: light(2.8, 2.95), ptsB: CEIL });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.face, 'lo');
  assert.equal(X.flushFitting(c, { ptsA: light(2.785, 2.95), ptsB: CEIL, flushMm: 20 }).ok, true, '15 mm proud of the ceiling, 20 mm tolerance');
  assert.equal(X.flushFitting(c, { ptsA: light(2.775, 2.95), ptsB: CEIL, flushMm: 20 }).reason, 'not-flush', '25 mm proud');
  assert.equal(X.flushFitting(c, { ptsA: light(2.6, 2.9), ptsB: CEIL }).reason, 'not-flush', 'a pendant hanging below');
  assert.equal(X.flushFitting(c, { ptsA: box([2.5, -0.3, 2.8], [3.1, 0.3, 2.95]), ptsB: CEIL }).reason, 'outside-host');
  const wallOutlet = clash({ elemAType: 'IfcOutlet', elemBType: 'IfcWallStandardCase' });
  assert.equal(X.flushFitting(wallOutlet, { ptsA: box([0, 0, 0.3], [0.05, 0.08, 0.38]), ptsB: WALL }).ok, true, 'outlet box flush in a wall face');
  assert.equal(X.flushFitting(clash({ elemAType: 'IfcPipeSegment', elemBType: 'IfcCovering' }), { ptsA: light(2.8, 2.95), ptsB: CEIL }).reason, 'roles');
});

test('presence: a structural penetration without an opening or provision is a finding', () => {
  const ext = () => 'through';
  const pts = (c, s) => (s === 'A' ? DUCT : WALL);
  const region = () => ({ min: [0, -0.3, 1.2], max: [0.2, 0.3, 1.6] });
  const c = clash({ id: 'p1' });
  const f = X.presenceFindings([c], { extent: ext, points: pts, region }, { on: true, withinMm: 50 });
  assert.equal(f.length, 1);
  assert.deepEqual({ type: f[0].type, host: f[0].host, passer: f[0].passer, hostType: f[0].hostType }, { type: 'missing-provision', host: 'B', passer: 'A', hostType: 'IfcWall' });
  assert.equal(X.presenceFindings([c], { extent: ext, points: pts, region }, { on: false }).length, 0, 'rule off');
  // an opening 30 mm beside the duct (flat 15-number box, world axes)
  const op = [0.1, 0.48, 1.4, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0.15, 0.2];
  const withOp = { extent: ext, points: pts, region, openings: (cc, side) => (side === 'B' ? op : null) };
  assert.equal(X.presenceFindings([c], withOp, { on: true, withinMm: 50 }).length, 0, 'opening 30 mm away, 50 mm allowed');
  assert.equal(X.presenceFindings([c], withOp, { on: true, withinMm: 20 }).length, 1, 'opening 30 mm away, 20 mm allowed');
  assert.equal(X.presenceFindings([c], { extent: ext, points: pts, region, provisions: () => [op] }, { on: true, withinMm: 50 }).length, 0, 'a provision volume counts too');
  assert.equal(X.presenceFindings([clash({ opening: 'partial' })], { extent: ext }, { on: true }).length, 0, 'an opening that is too small is present (its own finding)');
  assert.equal(X.presenceFindings([clash({ provision: 'inside' })], { extent: ext }, { on: true }).length, 0);
  assert.equal(X.presenceFindings([clash({ roleB: 'architectural' })], { extent: ext, points: pts, region }, { on: true }).length, 0, 'non-structural wall');
  assert.equal(X.presenceFindings([clash({ elemAType: 'IfcLightFixture', roleA: 'mep-terminal' })], { extent: ext, points: pts, region }, { on: true }).length, 0, 'a terminal is no run');
  assert.equal(X.presenceFindings([clash()], { extent: () => 'partial' }, { on: true }).length, 0, 'not through (no geometry to say otherwise)');
  assert.equal(X.presenceFindings([clash()], { extent: () => 'unknown', points: pts, region }, { on: true }).length, 1, 'through by geometry when the depth is unknown');
});

test('IFC-neutral: names and languages never change a verdict', () => {
  const ctx = { extent: () => 'through', points: (c, s) => (s === 'A' ? DUCT : WALL) };
  const ex = { penetration: { on: true }, requireProvision: { on: true } };
  const a = X.annotate([clash({ id: 'n1' })], ctx, ex).clashes[0];
  const b = X.annotate([clash({ id: 'n1', elemAName: 'Zuluftkanal', elemBName: 'Dragende wand' })], ctx, ex).clashes[0];
  assert.equal(a.exception, b.exception);
  assert.deepEqual(a.missingProvision, b.missingProvision);
  assert.equal(X.annotate([clash({ id: 'n2', elemAName: 'Duct', elemAType: 'IfcBuildingElementProxy', roleA: 'other' })], ctx, ex).clashes[0].exception, undefined, 'a name alone never makes an MEP run');
});

test('annotate: off returns the same objects; on copies, never mutates; stale annotations are removed', () => {
  const ctx = { extent: () => 'through', points: (c, s) => (s === 'A' ? DUCT : WALL) };
  const cs = [clash({ id: 'a1' }), clash({ id: 'a2', type: 'soft', distance: 30 })];
  const off = X.annotate(cs, ctx, {});
  assert.ok(off.clashes.every((c, i) => c === cs[i]));
  const on = X.annotate(cs, ctx, { penetration: { on: true }, requireProvision: { on: true } });
  assert.notEqual(on.clashes[0], cs[0]);
  assert.equal(cs[0].exception, undefined, 'input untouched');
  assert.equal(on.clashes[0].exception, 'penetration');
  assert.deepEqual(on.clashes[0].missingProvision, { host: 'B', withinMm: 50 });
  assert.equal(on.clashes[1], cs[1], 'a clearance clash is not touched');
  assert.deepEqual(on.counts, { penetration: 1, fitting: 0, missingProvision: 1 });
  const again = X.annotate(on.clashes, ctx, {});
  assert.equal(again.clashes[0].exception, undefined, 'a rule switched off removes its annotation');
  assert.equal(again.clashes[0].missingProvision, undefined);
  assert.equal(on.clashes[0].exception, 'penetration', 'the earlier copy is untouched');
});

test('boxesWithin: separating axes with a margin', () => {
  const A = X.boxFromAabb([0, 0, 0], [1, 1, 1]);
  assert.equal(X.boxesWithin(A, X.boxFromAabb([1.03, 0, 0], [2, 1, 1]), 0.05), true);
  assert.equal(X.boxesWithin(A, X.boxFromAabb([1.03, 0, 0], [2, 1, 1]), 0.02), false);
  const s = Math.SQRT1_2; // a 45 degree box whose corner points at A
  const R = X.boxFromObb([2.21, 0.5, 0.5, s, s, 0, -s, s, 0, 0, 0, 1, 0.5, 0.5, 0.5]);
  assert.equal(X.boxesWithin(A, R, 0.01), false, 'corner ~0.5 m away');
  assert.equal(X.boxesWithin(A, R, 0.6), true);
});
