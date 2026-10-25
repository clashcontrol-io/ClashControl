'use strict';
// Pure-Node part of the pressure-test harness (tests/pressure/*): the
// covering-array generator really covers what it claims, ddmin really
// shrinks, and property tests on the pure clash-pipeline cores that the
// browser invariants build on (identity, reconciliation, project codec,
// discipline matrix) plus generator determinism. The browser side runs via
// `node tests/pressure/run.mjs --tier fast|nightly|soak`.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const identity = require('../clash-identity-core');
const recon = require('../clash-reconciliation-core');
const codec = require('../project-codec');
const disc = require('../clash-discipline-core');
const { generateBuilding } = require('./fixtures/generate-building-ifc.js');

const P = (f) => import(path.join(__dirname, 'pressure', f));

// ── covering arrays ──
test('pressure dims: nightly arrays are pairwise-complete and 3 consecutive seeds cover every triple', async () => {
  const D = await P('dims.mjs');
  const allTriples = new Set(D.allTriples(D.DIMS, D.TRIPLE_DIMS));
  const seen = new Set();
  for (const seed of [11, 12, 13]) {
    const combos = D.combosFor('nightly', seed);
    const rows = combos.map((c) => D.DIMS.map((d) => d.values.findIndex((v) => JSON.stringify(v) === JSON.stringify(c.dims[d.name]))));
    assert.ok(rows.every((r) => r.every((i) => i >= 0)), 'every combo value is in the dimension table');
    const rep = D.coverageReport(D.DIMS, rows, { triples: D.TRIPLE_DIMS, shard: { of: 3, index: seed % 3 } });
    assert.deepEqual(rep.missingPairs, [], 'seed ' + seed + ' misses pairs');
    assert.deepEqual(rep.missingTriples, [], 'seed ' + seed + ' misses its triple shard');
    // collect every triple the rows actually hit
    const full = D.coverageReport(D.DIMS, rows, { triples: D.TRIPLE_DIMS });
    const missing = new Set(full.missingTriples);
    for (const t of allTriples) if (!missing.has(t)) seen.add(t);
    assert.ok(combos.length < 160, 'nightly array stays small (' + combos.length + ')');
  }
  assert.equal(seen.size, allTriples.size, 'three consecutive nightly seeds cover all ' + allTriples.size + ' {engine,run,cancel,failure} triples');
});

test('pressure dims: covering arrays are deterministic per seed and differ across seeds', async () => {
  const D = await P('dims.mjs');
  const a = D.combosFor('fast', 7), b = D.combosFor('fast', 7), c = D.combosFor('fast', 8);
  assert.equal(a.length, 24);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((x) => x.dims), c.map((x) => x.dims));
  assert.equal(new Set(a.map((x) => x.id)).size, 24);
  assert.equal(new Set(a.map((x) => x.seed)).size, 24, 'every combo gets its own seed');
  // fast-tier value subsets are honoured
  assert.ok(a.every((x) => x.dims['fixture.scale'] !== 'medium'));
  // greedy front-loading: 24 fast rows already cover most pairs
  const dims = D.dimsForTier('fast');
  const rows = a.map((x) => dims.map((d) => d.values.findIndex((v) => JSON.stringify(v) === JSON.stringify(x.dims[d.name]))));
  const rep = D.coverageReport(dims, rows);
  assert.ok((rep.total.pairs - rep.missingPairs.length) / rep.total.pairs > 0.85, 'fast tier covers > 85 % of pairs');
  // soak = random rows, still deterministic
  assert.deepEqual(D.combosFor('soak', 3, { count: 5 }), D.combosFor('soak', 3, { count: 5 }));
});

test('pressure dims: every fast-tier value (incl. every adapter-driven value) runs in at least one fast combo', async () => {
  const D = await P('dims.mjs');
  const adapterValues = D.DIMS.filter((d) => d.adapter).flatMap((d) => Object.keys(d.adapter).map((v) => d.name + '=' + v));
  assert.deepEqual(adapterValues.sort(), ['display.filter=bucket', 'load.path=sharded', 'roles.exclusion=leave-out', 'storage=autosave-gate', 'storage=evict', 'storage=low-bvh-cap']);
  for (let seed = 1; seed <= 30; seed++) {
    const combos = D.combosFor('fast', seed);
    for (const d of D.dimsForTier('fast')) for (const v of d.values) {
      assert.ok(combos.some((c) => JSON.stringify(c.dims[d.name]) === JSON.stringify(v)), 'fast tier seed ' + seed + ' never runs ' + d.name + '=' + v);
    }
  }
});

test('pressure dims: a tiny exhaustive check — covering array of 3 binary dims has every pair', async () => {
  const D = await P('dims.mjs');
  const dims = [{ name: 'a', values: [0, 1] }, { name: 'b', values: [0, 1, 2] }, { name: 'c', values: [0, 1] }];
  for (let s = 1; s < 30; s++) {
    const rows = D.coveringArray(dims, { seed: s });
    assert.deepEqual(D.coverageReport(dims, rows).missingPairs, []);
    assert.ok(rows.length >= 6 && rows.length <= 9, 'near-optimal size, got ' + rows.length);
    const rows3 = D.coveringArray(dims, { seed: s, triples: ['a', 'b', 'c'] });
    assert.equal(rows3.length >= 12, true);
    assert.deepEqual(D.coverageReport(dims, rows3, { triples: ['a', 'b', 'c'] }).missingTriples, []);
  }
});

test('pressure dims: rulesFor maps rule dims onto app rules', async () => {
  const D = await P('dims.mjs');
  const r = D.rulesFor(Object.assign(D.defaults(), { 'rules.self': 'all', 'rules.tolerance': 'beam-duct-200' }));
  assert.equal(r.selfClashModels, 'all');
  assert.equal(r.excludeSelf, false);
  assert.deepEqual(r.toleranceByTypePair, { 'IfcBeam:IfcDuctSegment': 200 });
  assert.deepEqual(D.nonDefaultDims(D.makeCombo({ 'rules.hard': false })), ['rules.hard']);
});

// ── rng ──
test('pressure rng: hashSeed is order-sensitive and stable', async () => {
  const R = await P('rng.mjs');
  assert.equal(R.hashSeed(1, 'a'), R.hashSeed(1, 'a'));
  assert.notEqual(R.hashSeed(1, 'a'), R.hashSeed('a', 1));
  assert.notEqual(R.hashSeed(1, 2), R.hashSeed(12));
  const r1 = R.mulberry32(42), r2 = R.mulberry32(42);
  for (let i = 0; i < 100; i++) assert.equal(r1(), r2());
  const sh = R.shuffle(R.mulberry32(1), [1, 2, 3, 4, 5]);
  assert.deepEqual(sh.slice().sort(), [1, 2, 3, 4, 5]);
});

// ── ddmin ──
test('pressure ddmin: shrinks to the minimal failing subset on synthetic predicates', async () => {
  const { ddmin } = await P('ddmin.mjs');
  const items = [...Array(20).keys()];
  // conjunction of two items
  let r = await ddmin(items, (s) => s.includes(3) && s.includes(17));
  assert.deepEqual(r.result, [3, 17]);
  // a single item
  r = await ddmin(items, (s) => s.includes(9));
  assert.deepEqual(r.result, [9]);
  // failure independent of the items
  r = await ddmin(items, () => true);
  assert.deepEqual(r.result, []);
  // three items, async predicate
  r = await ddmin(items, async (s) => s.includes(0) && s.includes(10) && s.includes(19));
  assert.deepEqual(r.result, [0, 10, 19]);
  // "any two of {4,5,6}" -> 1-minimal: exactly two of them, and no single item fails
  r = await ddmin(items, (s) => s.filter((x) => x >= 4 && x <= 6).length >= 2);
  assert.equal(r.result.length, 2);
  assert.ok(r.result.every((x) => x >= 4 && x <= 6));
  // memoised: never more tests than subsets of a 20-element list would need in the worst case
  assert.ok(r.calls < 120, 'calls ' + r.calls);
});

// ── property tests on the pure cores ──
function rngOf(seed) { let a = seed | 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const GUID = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
function gid(rnd) { let s = ''; for (let i = 0; i < 22; i++) s += GUID[Math.floor(rnd() * 64)]; return s; }

test('identity core: pair and identity key are symmetric in A/B and stable within a grid cell', () => {
  for (let s = 1; s <= 300; s++) {
    const rnd = rngOf(s);
    const c = { globalIdA: gid(rnd), globalIdB: gid(rnd), elemA: Math.floor(rnd() * 1e5), elemB: Math.floor(rnd() * 1e5),
      point: [(rnd() - 0.5) * 200, (rnd() - 0.5) * 50, (rnd() - 0.5) * 200] };
    if (rnd() < 0.3) { c.uniqueIdA = 'u' + gid(rnd); c.uniqueIdB = 'u' + gid(rnd); }
    if (rnd() < 0.2) { c.globalIdA = ''; }
    const sw = Object.assign({}, c, { globalIdA: c.globalIdB, globalIdB: c.globalIdA, elemA: c.elemB, elemB: c.elemA, uniqueIdA: c.uniqueIdB, uniqueIdB: c.uniqueIdA });
    assert.equal(identity.computeClashPair(c), identity.computeClashPair(sw));
    assert.equal(identity.computeClashIdentityKey(c), identity.computeClashIdentityKey(sw));
    // same 0.5 m cell -> same key
    const cell = c.point.map((v) => Math.round(v / 0.5) * 0.5);
    const inCell = Object.assign({}, c, { point: cell.map((v) => v + (rnd() - 0.5) * 0.49) });
    assert.equal(identity.computeClashIdentityKey(inCell), identity.computeClashIdentityKey(Object.assign({}, c, { point: cell })));
    // deterministic, no hidden state
    assert.equal(identity.computeClashIdentityKey(c), identity.computeClashIdentityKey(JSON.parse(JSON.stringify(c))));
  }
});

function reconOpts(extra) {
  return Object.assign({
    computeClashIdentityKey: identity.computeClashIdentityKey,
    computeClashPair: identity.computeClashPair,
    isDeniedClash: () => false,
    now: 1000,
  }, extra);
}

test('reconciliation core: status/assignee/id carry across re-runs within coverage; outside coverage nothing changes', () => {
  const STATUSES = ['open', 'in_progress', 'resolved', 'closed', 'accepted', 'auto_resolved'];
  for (let s = 1; s <= 150; s++) {
    const rnd = rngOf(1000 + s);
    const n = 1 + Math.floor(rnd() * 25);
    const models = ['mA', 'mB', 'mC'];
    const raw = [];
    for (let i = 0; i < n; i++) {
      const ma = models[Math.floor(rnd() * 3)], mb = models[Math.floor(rnd() * 3)];
      raw.push({ id: 'r' + i, type: rnd() < 0.5 ? 'hard' : 'soft', globalIdA: gid(rnd), globalIdB: gid(rnd), elemA: i, elemB: 1000 + i, modelAId: ma, modelBId: mb,
        point: [rnd() * 100, rnd() * 20, rnd() * 100], distance: -Math.round(rnd() * 300) });
    }
    const first = recon.mergeDetectionResults(raw, [], reconOpts());
    assert.equal(first.clashes.length, n);
    // user edits
    const prev = first.clashes.map((c) => Object.assign({}, c, { id: 'p' + c.number, status: STATUSES[Math.floor(rnd() * STATUSES.length)], assignee: rnd() < 0.5 ? 'user' + Math.floor(rnd() * 5) : '' }));
    // next run: same pairs, fresh ids, points moved < 0.3 m, shuffled, some dropped
    const outOfScope = 'mC';
    const coverage = (c) => c.modelAId !== outOfScope && c.modelBId !== outOfScope;
    const dropped = new Set();
    const next = [];
    raw.forEach((c, i) => {
      if (rnd() < 0.25) { dropped.add(c.globalIdA); return; }
      if (!coverage(c)) { dropped.add(c.globalIdA); return; } // not checked this run
      const j = () => (rnd() - 0.5) * 0.4;
      next.push(Object.assign({}, c, { id: 'n' + i, point: [c.point[0] + j(), c.point[1] + j(), c.point[2] + j()] }));
    });
    for (let i = next.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [next[i], next[k]] = [next[k], next[i]]; }
    const res = recon.mergeDetectionResults(next, prev, reconOpts({ coverage, now: 2000 }));
    const byGid = new Map(res.clashes.map((c) => [c.globalIdA, c]));
    for (const p of prev) {
      const r = byGid.get(p.globalIdA);
      if (!dropped.has(p.globalIdA)) {
        assert.ok(r, 'persisting clash present');
        assert.equal(r._delta, 'persisting');
        assert.equal(r.id, p.id, 'id carried');
        assert.equal(r.number, p.number, 'number carried');
        assert.equal(r.status, p.status === 'auto_resolved' ? 'open' : p.status, 'status carried');
        assert.equal(r.assignee, p.assignee, 'assignee carried');
      } else if (!coverage(p)) {
        assert.ok(r, 'out-of-coverage clash preserved');
        assert.equal(r._delta, 'not_checked');
        assert.equal(r.status, p.status);
        assert.equal(r.assignee, p.assignee);
      } else if (p.status === 'open' || p.status === 'in_progress') {
        assert.equal(r && r.status, 'auto_resolved');
      } else {
        assert.equal(r, undefined, 'a closed/resolved clash that went away is dropped');
      }
    }
    // numbers stay unique
    const nums = res.clashes.map((c) => c.number);
    assert.equal(new Set(nums).size, nums.length);
    // idempotent on an identical re-run
    const again = recon.mergeDetectionResults(next.map((c) => Object.assign({}, c, { id: 'x' + c.id })), res.clashes, reconOpts({ coverage, now: 3000 }));
    for (const c of res.clashes.filter((x) => x._delta === 'persisting' || x._delta === 'new')) {
      const r = again.clashes.find((x) => x.globalIdA === c.globalIdA);
      assert.equal(r.id, c.id); assert.equal(r.status, c.status); assert.equal(r.number, c.number);
    }
  }
});

test('reconciliation core: denied clashes never come back', () => {
  for (let s = 1; s <= 50; s++) {
    const rnd = rngOf(5000 + s);
    const raw = [];
    for (let i = 0; i < 12; i++) raw.push({ id: 'r' + i, globalIdA: gid(rnd), globalIdB: gid(rnd), elemA: i, elemB: i + 50, point: [i, 0, 0] });
    const denied = new Set(raw.filter(() => rnd() < 0.3).map((c) => identity.computeClashPair(c)));
    const res = recon.mergeDetectionResults(raw, [], reconOpts({ isDeniedClash: (c) => denied.has(identity.computeClashPair(c)) }));
    assert.equal(res.clashes.length, raw.length - denied.size);
    assert.ok(res.clashes.every((c) => !denied.has(identity.computeClashPair(c))));
  }
});

// Minimal reducer for exactly the actions restoreProject dispatches.
function restoreInto(data) {
  const st = { rules: {}, models: [], clashes: [], issues: [], floors: [], viewpoints: [], measurements: [], selectionSets: [], searchSets: [], assignmentRules: [], changelog: [], comments: [], runHistory: [], lastDeltaSummary: null };
  const actions = { ADD_MODEL: 'ADD_MODEL', UPD_RULES: 'UPD_RULES', SET_CLASHES: 'SET_CLASHES', LOAD_PROJECT_STATE: 'LOAD_PROJECT_STATE', ADD_ISSUE: 'ADD_ISSUE', ADD_VIEWPOINT: 'ADD_VIEWPOINT', ADD_MEASUREMENT: 'ADD_MEASUREMENT', ADD_SELSET: 'ADD_SELSET', ADD_SEARCHSET: 'ADD_SEARCHSET', ADD_ASSIGN_RULE: 'ADD_ASSIGN_RULE', MERGE_CHANGELOG: 'MERGE_CHANGELOG', MERGE_COMMENTS: 'MERGE_COMMENTS' };
  const d = (a) => {
    switch (a.t) {
      case 'ADD_MODEL': st.models.push(a.v); break;
      case 'UPD_RULES': st.rules = Object.assign({}, st.rules, a.u); break;
      case 'SET_CLASHES': st.clashes = a.v; st.floors = [...new Set(a.v.map((c) => c.storey).filter(Boolean))]; break;
      case 'LOAD_PROJECT_STATE': st.runHistory = a.data.runHistory; st.lastDeltaSummary = a.data.lastDeltaSummary; break;
      case 'ADD_ISSUE': if (!st.issues.some((i) => i.id === a.v.id)) st.issues.push(a.v); break;
      case 'ADD_VIEWPOINT': st.viewpoints.push(a.v); break;
      case 'ADD_MEASUREMENT': st.measurements.push(a.v); break;
      case 'ADD_SELSET': st.selectionSets.push(a.v); break;
      case 'ADD_SEARCHSET': st.searchSets.push(a.v); break;
      case 'ADD_ASSIGN_RULE': st.assignmentRules.push(a.v); break;
      case 'MERGE_CHANGELOG': st.changelog = st.changelog.concat(a.v); break;
      case 'MERGE_COMMENTS': st.comments = st.comments.concat(a.v); break;
      default: throw new Error('unexpected action ' + a.t);
    }
  };
  codec.validateProject(data);
  codec.restoreProject(data, d, actions);
  return st;
}

test('project codec: serialize∘restore is idempotent and keeps clashes/issues/statuses/rules', () => {
  for (let s = 1; s <= 120; s++) {
    const rnd = rngOf(9000 + s);
    const nm = 1 + Math.floor(rnd() * 3);
    const models = [];
    for (let i = 0; i < nm; i++) models.push({ id: 'm' + i, name: 'model-' + i + '.ifc', discipline: ['mep', 'structural', 'architectural'][i % 3], color: '#00000' + i, visible: rnd() < 0.8, tag: rnd() < 0.3 ? 'tag' : '', elements: [{}], meshes: [{}] });
    const clashes = [];
    const nc = Math.floor(rnd() * 20);
    for (let i = 0; i < nc; i++) clashes.push({ id: 'c' + i, number: i + 1, status: ['open', 'resolved', 'in_progress'][i % 3], assignee: rnd() < 0.5 ? 'x' : '', globalIdA: gid(rnd), globalIdB: gid(rnd), point: [rnd(), rnd(), rnd()], storey: rnd() < 0.5 ? 'L' + (i % 3) : undefined });
    const issues = clashes.filter(() => rnd() < 0.3).map((c, i) => ({ id: 'i' + i, clashId: c.id, title: 'issue ' + i, status: 'open' }));
    const rules = { hard: rnd() < 0.5, maxGap: [0, 50, 100][Math.floor(rnd() * 3)], minOverlapVolM3: rnd() < 0.2 ? 1e-5 : 0, toleranceByTypePair: rnd() < 0.5 ? { 'IfcBeam:IfcDuctSegment': 200 } : {} };
    const st = { rules, models, clashes, issues, floors: [], viewpoints: [{ id: 'v', snapshot: 'data:png', camera: { px: 1 } }], measurements: [{ id: 'me' }], selectionSets: [], searchSets: [{ id: 'ss' }], assignmentRules: [], changelog: [{ ts: 1 }], comments: [{ id: 'co' }], runHistory: [{ ts: 1, total: nc }], lastDeltaSummary: { newCount: nc } };
    const s1 = codec.serializeProject(restoreInto(JSON.parse(JSON.stringify(codec.serializeProject(st, '1.0', 'T')))), '1.0', 'T');
    const s2 = codec.serializeProject(restoreInto(JSON.parse(JSON.stringify(s1))), '1.0', 'T');
    assert.deepEqual(s2, s1, 'serialize∘restore is idempotent');
    assert.deepEqual(s1.clashes, JSON.parse(JSON.stringify(clashes)));
    assert.deepEqual(s1.issues, JSON.parse(JSON.stringify(issues)));
    assert.equal(s1.rules.minOverlapVolM3, 0, 'the legacy 1e-5 default migrates to 0');
    assert.deepEqual(Object.assign({}, s1.rules, { minOverlapVolM3: rules.minOverlapVolM3 }), JSON.parse(JSON.stringify(rules)));
    assert.equal(s1.viewpoints[0].snapshot, undefined, 'snapshots are not persisted');
    assert.deepEqual(s1.models.map((m) => m.id), models.map((m) => m.id));
  }
});

test('discipline core: matrix skip is symmetric, never skips duplicates/same-model, cross-discipline enabled by default', () => {
  const types = Object.keys(disc.typeMap).concat(['IfcWall', 'IfcSlab', 'IfcBuildingElementProxy', '']);
  const discs = ['mep', 'structural', 'architectural', 'civil', 'other'];
  for (let s = 1; s <= 400; s++) {
    const rnd = rngOf(20000 + s);
    const el = () => ({ props: { ifcType: types[Math.floor(rnd() * types.length)] } });
    const md = () => ({ discipline: discs[Math.floor(rnd() * discs.length)] });
    const eA = el(), eB = el(), mA = md(), mB = md();
    const rules = { excludeSameDiscipline: rnd() < 0.5, duplicates: rnd() < 0.2 };
    if (rnd() < 0.4) {
      rules.disciplineMatrix = {};
      for (let i = 0; i < 4; i++) { const a = discs[Math.floor(rnd() * 5)], b = discs[Math.floor(rnd() * 5)]; rules.disciplineMatrix[a < b ? a + ':' + b : b + ':' + a] = rnd() < 0.5; }
    }
    const same = rnd() < 0.2;
    const ab = disc.matrixSkipsSameDiscipline(eA, mA, eB, mB, same, rules);
    const ba = disc.matrixSkipsSameDiscipline(eB, mB, eA, mA, same, rules);
    assert.equal(ab, ba, 'symmetric');
    if (rules.duplicates || same) assert.equal(ab, false);
    const dA = disc.elementDiscipline(eA, mA.discipline), dB = disc.elementDiscipline(eB, mB.discipline);
    assert.equal(disc.disciplinePairEnabled(dA, dB, rules), disc.disciplinePairEnabled(dB, dA, rules));
    if (!rules.disciplineMatrix && dA !== dB) assert.equal(disc.disciplinePairEnabled(dA, dB, rules), true);
    if (!rules.disciplineMatrix && dA === dB) assert.equal(disc.disciplinePairEnabled(dA, dB, rules), rules.excludeSameDiscipline === false);
  }
});

// ── generator ──
function digestOf(g) {
  const h = crypto.createHash('sha256');
  for (const k of ['architecture', 'structure', 'mep']) h.update(g.files[k]);
  h.update(JSON.stringify(g.manifest));
  return h.digest('hex').slice(0, 16);
}
test('building generator: deterministic, default output pinned, cases/background reductions are opt-in', () => {
  assert.equal(digestOf(generateBuilding({})), digestOf(generateBuilding({})));
  // Pinned before the opt-in `cases`/`background` options were added: the
  // default output must stay byte-identical (accuracy reports compare across runs).
  assert.equal(digestOf(generateBuilding({})), '1814738c08a81949');
  assert.equal(digestOf(generateBuilding({ scale: '3x3x2', seed: 1337, georef: 'far' })), '94dfa1a36a24999c');
  assert.equal(digestOf(generateBuilding({ georef: 'none' })), 'b9538a810b3f5cdc');
  assert.notEqual(digestOf(generateBuilding({ seed: 1 })), digestOf(generateBuilding({ seed: 2 })));
  const all = generateBuilding({});
  const ids = all.manifest.cases.map((c) => c.id);
  assert.equal(digestOf(generateBuilding({ cases: ids })), digestOf(all), 'listing every case == default');
  const sub = generateBuilding({ cases: ['P04', 'P12'], background: false });
  assert.deepEqual(sub.manifest.cases.map((c) => c.id), ['P04', 'P12']);
  const pos = (g, id) => g.manifest.cases.find((c) => c.id === id).name;
  assert.equal(pos(sub, 'P12'), pos(all, 'P12'));
  assert.ok(sub.stats.products < 10 && sub.stats.products > 0);
  assert.ok(all.files.mep.includes(all.manifest.cases[0].a.globalId) || all.files.mep.includes(all.manifest.cases[0].b.globalId));
  // opt-in role strip: planted cases untouched, one member per suggestion group
  // (+ the duplicate's twin), the same with a `cases` reduction
  const r = generateBuilding({ roles: true });
  assert.deepEqual(r.manifest.cases.map((c) => c.a.globalId + c.b.globalId), all.manifest.cases.map((c) => c.a.globalId + c.b.globalId));
  assert.deepEqual(r.manifest.roleStrip.map((x) => x.group), ['duplicate', 'duplicate', 'proxy', 'provision', 'zone']);
  assert.ok(r.manifest.roleStrip.every((x) => Object.values(r.files).some((f) => f.includes(x.globalId))));
  const rs = generateBuilding({ roles: true, cases: ['P04'], background: false });
  assert.equal(rs.manifest.roleStrip.length, 5);
  assert.equal(all.manifest.roleStrip, undefined);
});
