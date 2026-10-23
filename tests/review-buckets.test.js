'use strict';
// Severity + extent + review buckets (clash-classification-core.js): the
// deterministic triage that decides which clashes a coordinator reviews and
// which are filed behind the bucket bar's counts. Nothing may disappear:
// every clash lands in exactly one bucket, so the counts add up to the raw total.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../clash-classification-core');

const bb = (dx, dy, dz) => ({ dx, dy, dz });
function hard(depth, a, b, extra) {
  return Object.assign({ id: 'h' + Math.random().toString(36).slice(2), type: 'hard', distance: -depth,
    bboxA: a, bboxB: b, elemAType: 'IfcDuctSegment', elemBType: 'IfcWall', roleA: 'mep-main', roleB: 'architectural',
    modelAId: 'M', modelBId: 'A', elemA: 1, elemB: 2, status: 'open' }, extra || {});
}

// ── extent ───────────────────────────────────────────────────────────────
test('extent table: through / through-thin / partial / graze / unknown, hard clashes only', () => {
  const duct = bb(3000, 600, 400), wall = bb(200, 3000, 3000);
  assert.equal(core.clashExtent(hard(600, duct, wall)), 'through', 'duct through a wall (planted P01, MTD 0.6 m)');
  assert.equal(core.clashExtent(hard(250, bb(100, 100, 2000), bb(400, 400, 3000))), 'through', 'pipe fully inside a column');
  assert.equal(core.clashExtent(hard(600, bb(6, 6, 1000), bb(4000, 4000, 250))), 'through-thin', '6 mm hanger rod through a slab');
  assert.equal(core.clashExtent(hard(500, bb(3, 400, 1000), bb(4000, 4000, 100))), 'through-thin', '3 mm plate through a covering');
  assert.equal(core.clashExtent(hard(10, bb(20, 20, 20), bb(5000, 120000, 250))), 'partial', '20 mm sensor 10 mm into a slab is no graze');
  assert.equal(core.clashExtent(hard(60, bb(400, 400, 3000), bb(300, 600, 6000))), 'partial', 'beam end 60 mm into a column');
  assert.equal(core.clashExtent(hard(15, bb(400, 400, 3000), bb(300, 600, 6000))), 'graze', 'beam end 15 mm into a column');
  assert.equal(core.clashExtent(hard(24, bb(300, 500, 2000), bb(300, 300, 6000))), 'graze', '< min(25 mm, 10 % of 300 mm)');
  assert.equal(core.clashExtent(hard(30, bb(300, 500, 2000), bb(300, 300, 6000))), 'partial', 'at the 25 mm cap it is no graze');
  assert.equal(core.clashExtent(hard(600, null, wall)), 'unknown', 'no box sizes');
  assert.equal(core.clashExtent(hard(600, duct, wall, { source: 'local_engine' })), 'unknown', 'local engine depth is an AABB bound');
  assert.equal(core.clashExtent({ type: 'hard', bboxA: duct, bboxB: wall }), 'unknown', 'no depth');
  for (const type of ['soft', 'contact', 'duplicate', 'visibility']) assert.equal(core.clashExtent({ type, distance: -50, bboxA: duct, bboxB: wall }), null);
});

test('extent is symmetric in A/B (both engines may call either side A)', () => {
  const cases = [[600, bb(3000, 600, 400), bb(200, 3000, 3000)], [15, bb(400, 400, 3000), bb(300, 600, 6000)], [10, bb(20, 20, 20), bb(5000, 120000, 250)]];
  for (const [d, a, b] of cases) assert.equal(core.clashExtent(hard(d, a, b)), core.clashExtent(hard(d, b, a)));
});

// ── severity ─────────────────────────────────────────────────────────────
test('severity: pair class x extent; graze caps at minor, finish -1, opening partial >= major', () => {
  const sev = core.deterministicSeverity;
  const pipe = bb(100, 100, 3000), beam = bb(300, 500, 6000), wall = bb(200, 3000, 3000);
  // MEP run through a beam: critical; only partly into it: major
  assert.equal(sev(hard(400, pipe, beam, { roleA: 'mep-main', roleB: 'structural' })), 'critical');
  assert.equal(sev(hard(60, pipe, beam, { roleA: 'mep-main', roleB: 'structural' })), 'major');
  // a hanger rod (through-thin) through structure is major, not critical
  assert.equal(sev(hard(600, bb(6, 6, 1000), bb(4000, 4000, 250), { roleA: 'mep-main', roleB: 'structural' })), 'major');
  // the same duct through an architectural wall needs builder's work: major
  assert.equal(sev(hard(600, bb(3000, 600, 400), wall, { roleA: 'mep-main', roleB: 'architectural' })), 'major');
  // a column 300 mm into an architectural wall is embedment, not compromised structure
  assert.equal(sev(hard(300, bb(400, 3000, 400), wall, { elemAType: 'IfcColumn', roleA: 'structural', roleB: 'architectural' })), 'major');
  assert.equal(sev(hard(60, bb(400, 3000, 400), wall, { elemAType: 'IfcColumn', roleA: 'structural', roleB: 'architectural' })), 'minor');
  // two MEP runs of different trades: critical through; same trade, same model: minor
  const trades = { roleA: 'mep-main', roleB: 'mep-main', trades: ['mep.ventilation', 'mep.plumbing'], modelBId: 'M' };
  assert.equal(sev(hard(400, pipe, bb(3000, 600, 400), trades)), 'critical');
  assert.equal(sev(hard(400, pipe, bb(3000, 600, 400), Object.assign({}, trades, { trades: ['mep.heating', 'mep.piping'] }))), 'minor', 'piping is the same trade as heating, same model');
  // structural pair, 15 mm deep: a graze -> minor
  assert.equal(sev(hard(15, bb(400, 400, 3000), bb(300, 600, 6000), { roleA: 'structural', roleB: 'structural' })), 'minor');
  // unknown extent (no box sizes / local engine) never reaches critical
  assert.equal(sev(hard(400, null, null, { roleA: 'mep-main', roleB: 'structural' })), 'major');
  assert.equal(sev(hard(400, pipe, beam, { roleA: 'mep-main', roleB: 'structural', source: 'local_engine' })), 'major');
  // finish side: one tier down
  assert.equal(sev(hard(60, bb(400, 400, 3000), bb(3000, 3000, 100), { roleA: 'mep-main', roleB: 'finish' })), 'minor');
  assert.equal(sev(hard(600, bb(400, 400, 3000), bb(3000, 3000, 100), { roleA: 'mep-main', roleB: 'finish' })), 'minor');
  // opening too small: at least major, even when shallow
  assert.equal(sev(hard(4, null, null, { roleA: 'mep-terminal', roleB: 'architectural', opening: 'partial' })), 'major');
});

test('severity class: only MEP x structure and MEP x MEP across trades can be critical', () => {
  const C = core.severityClass;
  assert.equal(C({ roleA: 'mep-main', roleB: 'structural' }), 'struct-mep');
  assert.equal(C({ roleA: 'mep-main', roleB: 'mep-main', trades: ['mep.ventilation', 'mep.electrical'] }), 'mep-mep');
  assert.equal(C({ roleA: 'mep-main', roleB: 'mep-main', trades: ['mep', 'mep'], modelAId: 'M', modelBId: 'N' }), 'other', 'unknown trades');
  assert.equal(C({ roleA: 'mep-main', roleB: 'architectural' }), 'arch-mep');
  assert.equal(C({ roleA: 'structural', roleB: 'architectural' }), 'struct-arch');
  assert.equal(C({ roleA: 'structural', roleB: 'structural', modelAId: 'S', modelBId: 'S' }), 'same');
  assert.equal(C({ roleA: 'mep-terminal', roleB: 'structural' }), 'other');
  const roles = { 'arch-mep': ['mep-main', 'architectural'], 'struct-arch': ['structural', 'architectural'], other: ['mep-terminal', 'structural'], same: ['architectural', 'architectural'] };
  for (const cls of Object.keys(roles)) {
    const c = hard(2000, bb(100, 100, 3000), bb(300, 500, 6000), { roleA: roles[cls][0], roleB: roles[cls][1], modelBId: cls === 'same' ? 'M' : 'A' });
    assert.equal(C(c), cls);
    assert.notEqual(core.deterministicSeverity(c), 'critical', cls + ' never reaches critical');
  }
});

test('the size-ratio rule is gone: a pipe through a slab is judged by depth x role', () => {
  const c = hard(600, bb(100, 100, 3000), bb(10000, 300, 20000), { elemAType: 'IfcPipeSegment', elemBType: 'IfcSlab', roleA: 'mep-main', roleB: 'structural', _trainFV: { size_ratio: 10000 } });
  core.classifyClashes([c]);
  assert.equal(c.aiCategory, 'penetration');
  assert.equal(c.aiSeverity, 'critical');
  assert.equal(c.extent, 'through');
});

// ── buckets ──────────────────────────────────────────────────────────────
test('every bucket is reachable, first match wins', () => {
  const R = core.reviewBucket, rules = {};
  assert.equal(R(hard(600, bb(3000, 600, 400), bb(200, 3000, 3000)), rules), 'review');
  assert.equal(R(hard(600, null, null, { status: 'resolved' }), rules), 'handled');
  assert.equal(R(hard(600, null, null, { status: 'denied', type: 'contact' }), rules), 'handled', 'a decision wins over every category');
  assert.equal(R({ type: 'contact', status: 'open' }, rules), 'contact');
  assert.equal(R(hard(600, null, null, { opening: 'provided' }), rules), 'provided');
  assert.equal(R(hard(600, null, null, { provision: 'inside' }), rules), 'provision');
  assert.equal(R(hard(600, null, null, { provision: 'inside' }), { roleChoices: { provision: 'include' } }), 'review', 'provision set to include');
  assert.equal(R(hard(600, null, null, { provision: 'obstructs' }), rules), 'review', 'blocking a provision is a real conflict');
  assert.equal(R(hard(600, null, null, { roleGroup: 'zone' }), rules), 'zone');
  assert.equal(R(hard(600, null, null, { roleGroup: 'duplicate' }), rules), 'review', 'duplicate group defaults to include');
  assert.equal(R(hard(600, null, null, { id: 't1' }), rules, { twice: { t1: true } }), 'twice');
  assert.equal(R(hard(600, null, null, { elemAType: 'IfcReinforcingBar', elemBType: 'IfcSlab' }), rules), 'embedded');
  assert.equal(R(hard(600, null, null, { elemAType: 'IfcWindow', elemBType: 'IfcWallStandardCase' }), rules), 'embedded');
  assert.equal(R(hard(600, null, null, { elemAType: 'IfcWindow', elemBType: 'IfcDuctSegment' }), rules), 'review', 'a window against a duct is not a fill');
  assert.equal(R(hard(600, null, null, { elemAType: 'IfcCovering', elemBType: 'IfcCovering', roleA: 'finish', roleB: 'finish' }), rules), 'finish');
  assert.equal(R(hard(600, null, null, { elemAType: 'IfcFurniture', elemBType: 'IfcColumn', roleA: 'finish', roleB: 'structural' }), rules), 'finish', 'movable furniture');
  assert.equal(R(hard(600, null, null, { elemAType: 'IfcCovering', elemBType: 'IfcColumn', roleA: 'finish', roleB: 'structural' }), rules), 'review', 'a covering against a column stays (planted P20)');
  assert.equal(R(hard(15, bb(400, 400, 3000), bb(300, 600, 6000)), rules), 'graze');
  assert.equal(R({ type: 'soft', clearanceMm: 49.9, status: 'open' }, rules), 'review', 'clearance near the limit is reviewed');
  const archStruct = { type: 'soft', status: 'open', elemAType: 'IfcWall', elemBType: 'IfcSlab', roleA: 'architectural', roleB: 'structural' };
  assert.equal(R(Object.assign({ clearanceMm: 30 }, archStruct), rules), 'adjacent', 'wall next to a slab by design');
  assert.equal(R(Object.assign({ clearanceMm: 10 }, archStruct), rules), 'review', 'a near miss (<= 30 % of the required clearance) stays in review');
  assert.equal(R(Object.assign({ clearanceMm: 30 }, archStruct, { roleB: 'mep-main', elemBType: 'IfcDuctSegment' }), rules), 'review', 'MEP clearance is reviewed');
  assert.equal(R(Object.assign({}, archStruct), rules), 'review', 'no gap data: reviewed');
  assert.equal(R({ type: 'duplicate', status: 'open', elemAType: 'IfcCovering', elemBType: 'IfcCovering' }, rules), 'review', 'a duplicate element is a finding');
});

function randomClashes(n, seed) {
  let s = seed;
  const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: 'r' + i, type: pick(['hard', 'hard', 'soft', 'contact', 'duplicate']), distance: -Math.round(rnd() * 400),
      status: pick(['open', 'open', 'open', 'resolved', 'denied', 'in_progress']), opening: pick([null, null, 'provided', 'partial']),
      provision: pick([null, null, 'inside']), roleGroup: pick([null, null, 'zone', 'proxy']),
      elemAType: pick(['IfcDuctSegment', 'IfcCovering', 'IfcReinforcingBar', 'IfcWindow', 'IfcFurniture']),
      elemBType: pick(['IfcWall', 'IfcSlab', 'IfcCovering', 'IfcColumn']),
      bboxA: rnd() < 0.8 ? bb(rnd() * 3000, rnd() * 3000, rnd() * 3000) : null, bboxB: bb(rnd() * 3000, rnd() * 3000, rnd() * 3000),
      modelAId: pick(['A', 'S', 'M']), modelBId: pick(['A', 'S', 'M']), elemA: Math.floor(rnd() * 40), elemB: Math.floor(rnd() * 40), overlapVolM3: rnd() });
  }
  return out;
}

test('bucket counts always add up to the raw total (any rules)', () => {
  for (const seed of [1, 7, 42, 4242]) {
    const cs = randomClashes(800, seed);
    const ctx = { twice: core.findTwice(cs) };
    for (const rules of [{}, { hideContacts: false }, { roleChoices: { provision: 'include', zone: 'include' } }, { hideBuckets: ['contact'] }]) {
      const counts = core.bucketCounts(cs, rules, ctx);
      assert.deepEqual(Object.keys(counts), core.REVIEW_BUCKETS);
      assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), cs.length);
    }
  }
});

test('hidden buckets: default everything but review; legacy switches and rules.hideBuckets', () => {
  assert.deepEqual(core.hiddenBuckets({}), core.REVIEW_BUCKETS.filter((b) => b !== 'review'));
  assert.ok(!core.hiddenBuckets({ hideContacts: false }).includes('contact'));
  assert.ok(!core.hiddenBuckets({ hideProvidedOpenings: false }).includes('provided'));
  assert.deepEqual(core.hiddenBuckets({ hideBuckets: ['graze', 'review', 'nope'] }), ['graze'], 'review can never be hidden');
});

// ── twice ────────────────────────────────────────────────────────────────
test('twice: one conflict against two copies of an element is reviewed once, deterministically', () => {
  const col = bb(400, 3000, 400);
  const copy = { id: 'copy', type: 'hard', distance: -400, bboxA: col, bboxB: bb(400, 3000, 401), overlapVolM3: 0.48,
    modelAId: 'S', elemA: 10, globalIdA: 'COL', modelBId: 'A', elemB: 20, globalIdB: 'COPY', elemAType: 'IfcColumn', elemBType: 'IfcCovering' };
  const p1 = { id: 'p1', type: 'hard', distance: -100, bboxA: bb(100, 100, 3000), bboxB: col, modelAId: 'M', elemA: 5, globalIdA: 'PIPE', modelBId: 'S', elemB: 10, globalIdB: 'COL' };
  const p2 = { id: 'p2', type: 'hard', distance: -100, bboxA: bb(100, 100, 3000), bboxB: col, modelAId: 'M', elemA: 5, globalIdA: 'PIPE', modelBId: 'A', elemB: 20, globalIdB: 'COPY' };
  const other = { id: 'o', type: 'hard', distance: -100, bboxA: bb(100, 100, 3000), bboxB: bb(200, 3000, 3000), modelAId: 'M', elemA: 6, globalIdA: 'P2', modelBId: 'A', elemB: 30, globalIdB: 'WALL' };
  const t = core.findTwice([copy, p1, p2, other]);
  assert.deepEqual(Object.keys(t), ['p2'], 'the clash on the copy with the larger key is the repeat');
  assert.deepEqual(core.findTwice([other, p2, p1, copy]), t, 'order independent');
  assert.equal(core.reviewBucket(copy, {}, { twice: t }), 'review', 'the copy-vs-copy clash itself is the finding');
  // not copies: sizes differ
  const notCopy = Object.assign({}, copy, { bboxB: bb(400, 2000, 400) });
  assert.deepEqual(core.findTwice([notCopy, p1, p2]), {});
});
