'use strict';
// clash-triage-core.js: storey normalisation, facets with live counts,
// suggested views (only when non-empty), search and saved views.
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../clash-triage-core');
const storage = require('../storage-core');

test('module contract', () => {
  assert.equal(t.contractVersion, 1);
  assert.ok(Object.isFrozen(t));
});

// ── storey normalisation ────────────────────────────────────────────────
test('level numbers from names: prefixes, level words, ordinals, ground/basement', () => {
  const cases = { 'Level 1': 1, 'L1': 1, '01 - Level 1': 1, '00 Fundering': 0, 'Begane grond': 0, 'Ground Floor': 0,
    '1e verdieping': 1, 'Verdieping 2': 2, '2nd floor': 2, 'B1': -1, 'Kelder': -1, 'Roof': null, 'Dak': null, '+3.000': null, '': null };
  for (const [name, n] of Object.entries(cases)) assert.equal(t.levelNumber(name), n, name);
});

test('same floor across models: by level number, else by elevation (mm models detected)', () => {
  const N = t.buildStoreyNormaliser([
    { modelId: 'arch', name: 'Level 1', elevation: 3.0 }, { modelId: 'arch', name: 'Roof', elevation: 9.1 }, { modelId: 'arch', name: 'Ground', elevation: 0 },
    { modelId: 'str', name: '01 Eerste', elevation: 2950 }, { modelId: 'str', name: 'Dak', elevation: 9000 }, { modelId: 'str', name: 'Fundering', elevation: -800 },
  ]);
  assert.equal(N.label('arch', 'Level 1'), 'L1');
  assert.equal(N.label('str', '01 Eerste'), 'L1');
  assert.equal(N.label('arch', 'Roof'), N.label('str', 'Dak'), 'roof storeys match by elevation');
  assert.equal(N.label('str', 'Fundering'), 'Fundering', 'unmatched storey keeps its name');
  assert.equal(N.label('x', ''), '');
  assert.equal(N.label('unknown-model', 'Level 4'), 'L4', 'names outside the model data still normalise');
  assert.deepEqual(N.labels.slice(0, 3), ['Fundering', 'L0', 'L1'], 'ordered by elevation');
});

// ── facets ───────────────────────────────────────────────────────────────
function items(n) {
  const out = [];
  const sev = ['critical', 'major', 'minor', 'info'], st = ['Level 0', 'Level 1', 'L2', ''];
  for (let i = 0; i < n; i++) {
    out.push({ id: 'c' + i, type: i % 5 === 0 ? 'soft' : 'hard', extent: ['through', 'partial', 'graze', 'unknown'][i % 4], aiSeverity: sev[i % 4],
      elemAStorey: st[i % 4], elemBStorey: st[(i + 1) % 4], modelAId: ['A', 'S'][i % 2], modelBId: 'M', elemAType: ['IfcWall', 'IfcSlab', 'IfcBeam'][i % 3],
      elemBType: 'IfcDuctSegment', status: i % 7 === 0 ? 'resolved' : 'open', assignee: i % 3 ? '' : 'Anna', trades: [['architectural', 'structural'][i % 2], 'mep.ventilation'],
      roleA: i % 2 ? 'structural' : 'architectural', roleB: 'mep-main', bboxB: { dx: 300, dy: i % 6 === 0 ? 3000 : 300, dz: 300 }, _delta: i % 11 === 0 ? 'new' : 'persisting' });
  }
  return out;
}
const ctx = { modelName: (id) => ({ A: 'Arch', S: 'Struct', M: 'MEP' })[id], bucket: (c) => (c.status === 'resolved' ? 'handled' : 'review') };

test('facet values are single-valued; counts of each facet add up to the items matching the other facets', () => {
  const idx = t.indexItems(items(240), ctx);
  for (const facets of [{}, { severity: ['critical'] }, { severity: ['critical', 'major'], extent: ['through'] }, { storey: ['Level 1'], modelPair: ['Arch ↔ MEP'] }]) {
    const counts = t.facetCounts(idx, facets, t.FACETS);
    for (const k of t.FACETS) {
      const others = Object.assign({}, facets); delete others[k];
      const expect = t.applyFacets(idx, others).length;
      const sum = Object.values(counts[k]).reduce((a, b) => a + b, 0);
      assert.equal(sum, expect, k + ' under ' + JSON.stringify(facets));
    }
    // and a chip's count is exactly what selecting it adds
    for (const [v, n] of Object.entries(counts.severity)) {
      const f2 = Object.assign({}, facets, { severity: [v] });
      assert.equal(t.applyFacets(idx, f2).length, n);
    }
  }
});

test('OR inside a facet, AND across facets', () => {
  const idx = t.indexItems(items(120), ctx);
  const a = t.applyFacets(idx, { severity: ['critical'] }).length, b = t.applyFacets(idx, { severity: ['major'] }).length;
  assert.equal(t.applyFacets(idx, { severity: ['critical', 'major'] }).length, a + b);
  const both = t.applyFacets(idx, { severity: ['critical'], status: ['resolved'] });
  assert.ok(both.every((c) => c.aiSeverity === 'critical' && c.status === 'resolved'));
});

test('suggested views are offered only when they select something', () => {
  const idx = t.indexItems(items(120), ctx);
  const views = t.suggestedViews(idx);
  assert.ok(views.length > 0);
  for (const v of views) {
    assert.ok(v.count > 0, v.id);
    assert.equal(t.applyFacets(idx, v.facets).length, v.count, v.id);
  }
  assert.ok(views.some((v) => v.id === 'structural-penetration'));
  assert.ok(views.some((v) => v.id === 'riser-through-slab') === false, 'no slab in the data, no riser view');
  const none = t.suggestedViews(t.indexItems([{ id: 'x', type: 'soft', aiSeverity: 'minor', status: 'open', assignee: 'Bo', elemAStorey: 'L1' }], ctx));
  assert.deepEqual(none, [], 'one storey and nothing tagged: no suggestions');
  const riser = { id: 'r', type: 'hard', extent: 'through', aiSeverity: 'major', elemAType: 'IfcPipeSegment', elemBType: 'IfcSlab', bboxA: { dx: 100, dy: 3500, dz: 100 }, status: 'open', assignee: 'x' };
  assert.deepEqual(t.suggestedViews(t.indexItems([riser], ctx)).map((v) => v.id), ['riser-through-slab']);
});

test('search: names, types, storeys, GlobalIds; all terms must match; quoted phrases', () => {
  const c = { title: 'Supply duct crosses Beam B-12', elemAName: 'Supply duct', elemBName: 'Beam B-12', elemAType: 'IfcDuctSegment', elemBType: 'IfcBeam',
    elemAStorey: 'Level 1', globalIdA: '2O2Fr$t4X7Zf8NOew3FLOH', modelAId: 'M', modelBId: 'S' };
  const txt = t.searchText(c, { storey: 'L1' }, ctx);
  assert.ok(t.matchesSearch(txt, 'duct beam'));
  assert.ok(t.matchesSearch(txt, '2o2fr$t4x7'));
  assert.ok(t.matchesSearch(txt, 'l1'));
  assert.ok(t.matchesSearch(txt, '"duct segment"'));
  assert.ok(!t.matchesSearch(txt, 'duct column'));
});

test('saved views normalise and round-trip losslessly', () => {
  const v = t.normaliseView({ name: '  Struct L1  ', facets: { severity: ['major', 'critical', 'major'], storey: [], bogus: ['x'] }, search: 'duct' });
  assert.deepEqual(v, { id: 'view-struct-l1', name: 'Struct L1', facets: { severity: ['critical', 'major'] }, search: 'duct' });
  assert.deepEqual(t.normaliseView(JSON.parse(JSON.stringify(v))), v);
  assert.equal(t.normaliseView({ name: '' }), null);
  assert.ok(t.sameFacets({ severity: ['major', 'critical'] }, { severity: ['critical', 'major'], extent: [] }));
});

// ── snapshot cache budget (storage-core) ─────────────────────────────────
test('snapshot GC: least recently used beyond the count/byte budget, superseded keys always', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ key: 'k' + i, bytes: 100, at: i });
  assert.deepEqual(storage.planSnapshotGC(rows, { maxCount: 7 }).sort(), ['k0', 'k1', 'k2']);
  assert.deepEqual(storage.planSnapshotGC(rows, { maxBytes: 450 }).sort(), ['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
  assert.deepEqual(storage.planSnapshotGC(rows, { drop: { k9: true } }), ['k9']);
  assert.ok(storage.IDB_REGISTRY.some((r) => r.store === 'snapshots' && r.retention === 'derived'));
});
