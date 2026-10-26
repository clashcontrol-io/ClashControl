'use strict';
// model-diff-core.js: model version comparison (docs/INTERNALS.md §21.62) —
// GlobalId matching, property vs geometry changes, moved vs reshaped,
// added / removed, determinism, the world-space geometry signature that a
// fresh load and a geometry-cache restore agree on, CSV export, and the
// "Clashes on changed elements" suggested view. Synthetic data only.
const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const D = require('../model-diff-core');
const T = require('../clash-triage-core');

const root = join(__dirname, '..');

// A box mesh part: 8 corners, 12 triangles; matrix = column-major 4x4 or null.
function box(x0, y0, z0, x1, y1, z1, matrix) {
  const pos = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const index = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  return { pos, index, matrix: matrix || null };
}
function translation(tx, ty, tz) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]; }
function rotZ(a, tx, ty, tz) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, tx || 0, ty || 0, tz || 0, 1]; }
// What a restore that bakes the world matrix into Float32 positions holds.
function baked(part) {
  const n = part.pos.length / 3, out = new Float32Array(n * 3), w = [0, 0, 0];
  for (let i = 0; i < n; i++) { D.worldVertex(part, i, w); out[i * 3] = w[0]; out[i * 3 + 1] = w[1]; out[i * 3 + 2] = w[2]; }
  return { pos: out, index: part.index.slice(), matrix: null };
}
function entry(gid, eid, props, parts) {
  return { gid, eid, props: Object.assign({ globalId: gid, ifcType: 'IfcWall', name: 'W ' + gid }, props || {}), geo: D.geometrySignature(parts), parts };
}
const rigid = (o, n) => D.rigidMotion(o.parts, n.parts);
const TS = { ts: '2026-01-01T00:00:00.000Z' };

test('GlobalId match: renumbered express ids are the same element; unmatched are added / removed', () => {
  const g = [box(0, 0, 0, 1, 1, 3)];
  const oldE = [entry('A', 1, {}, g), entry('B', 2, {}, [box(5, 0, 0, 6, 1, 3)])];
  const newE = [entry('A', 101, {}, [box(0, 0, 0, 1, 1, 3)]), entry('C', 103, {}, [box(9, 0, 0, 10, 1, 3)])];
  const d = D.diffModels(oldE, newE, Object.assign({ rigid }, TS));
  assert.deepStrictEqual(d.unchanged, [101]);
  assert.deepStrictEqual(d.added, [103]);
  assert.deepStrictEqual(d.removed, [2]);
  assert.deepStrictEqual(d.records.map((r) => [r.gid, r.kind]), [['C', 'added'], ['B', 'removed']]);
  assert.strictEqual(d.summary.modified, 0);
});

test('property change vs geometry change vs both', () => {
  const oldE = [entry('P', 1, { name: 'Wall 1' }, [box(0, 0, 0, 1, 1, 3)]), entry('G', 2, {}, [box(2, 0, 0, 3, 1, 3)]), entry('X', 3, { material: 'Concrete' }, [box(4, 0, 0, 5, 1, 3)])];
  const newE = [entry('P', 1, { name: 'Wall 1b' }, [box(0, 0, 0, 1, 1, 3)]), entry('G', 2, {}, [box(2, 0, 0, 3, 1, 4)]), entry('X', 3, { material: 'Steel' }, [box(4, 0, 0, 5, 1, 3, translation(0, 2, 0))])];
  const d = D.diffModels(oldE, newE, Object.assign({ rigid }, TS));
  const by = Object.fromEntries(d.records.map((r) => [r.gid, r]));
  assert.strictEqual(by.P.kind, 'properties');
  assert.deepStrictEqual(by.P.props, [{ k: 'name', o: 'Wall 1', n: 'Wall 1b' }]);
  assert.strictEqual(by.G.kind, 'reshaped');
  assert.deepStrictEqual(by.G.props, []);
  assert.strictEqual(by.X.kind, 'moved+properties');
  assert.deepStrictEqual(by.X.props, [{ k: 'material', o: 'Concrete', n: 'Steel' }]);
  assert.deepStrictEqual(d.summary.added + d.summary.removed, 0);
  assert.strictEqual(d.summary.geometry, 2);
  assert.strictEqual(d.summary.moved, 1);
  assert.strictEqual(d.summary.reshaped, 1);
  assert.strictEqual(d.summary.properties, 2);
  assert.strictEqual(d.summary.both, 1);
  assert.strictEqual(d.summary.modified, 3);
  assert.deepStrictEqual(d.modified.slice().sort(), [1, 2, 3]);
});

test('moved: translation and rotation are rigid; scaling, a shifted vertex or re-triangulation is reshaped', () => {
  const a = [box(0, 0, 0, 2, 0.3, 3)];
  assert.ok(D.rigidMotion(a, [box(0, 0, 0, 2, 0.3, 3, translation(1.25, -4, 0.5))]), 'translation');
  assert.ok(D.rigidMotion(a, [box(0, 0, 0, 2, 0.3, 3, rotZ(Math.PI / 7, 3, 1, 0))]), 'rotation + translation');
  assert.ok(!D.rigidMotion(a, [box(0, 0, 0, 2, 0.3, 3.5)]), 'taller');
  const shifted = box(0, 0, 0, 2, 0.3, 3); shifted.pos[18] += 0.01; // one vertex 10 mm
  assert.ok(!D.rigidMotion(a, [shifted]), 'one vertex moved');
  const retri = box(0, 0, 0, 2, 0.3, 3); retri.index[2] = 1; // a different triangle list
  assert.ok(!D.rigidMotion(a, [retri]), 'index change');
  assert.ok(!D.rigidMotion(a, [box(0, 0, 0, 2, 0.3, 3), box(5, 5, 5, 6, 6, 6)]), 'part added');
  // two parts moving together stay rigid; one part moving alone does not
  const two = [box(0, 0, 0, 1, 1, 1), box(2, 0, 0, 3, 1, 1)];
  assert.ok(D.rigidMotion(two, [box(0, 0, 0, 1, 1, 1, translation(0, 0, 5)), box(2, 0, 0, 3, 1, 1, translation(0, 0, 5))]));
  assert.ok(!D.rigidMotion(two, [box(0, 0, 0, 1, 1, 1), box(2, 0, 0, 3, 1, 1, translation(0, 0, 5))]));
  // far from the origin (Float32 world coordinates): a pure move is still a move
  const far = [box(100000, 400000, 0, 100002, 400000.3, 3)];
  assert.ok(D.rigidMotion(far, [box(100000, 400000, 0, 100002, 400000.3, 3, translation(0.75, 0, 0))]));
});

test('compareGeometry: rounding-only differences are the same geometry (instanced vs baked), not a move', () => {
  // the shape is drawn instanced (local frame + matrix) in one version and
  // baked in world coordinates in the other; a coordinate may round to the
  // other 0.1 mm step, so the signatures can differ — the element is unchanged
  const local = box(0.00004999, 0, 0, 1.00004999, 0.2, 3, translation(10.00000003, 0, 0));
  const world = box(10.00005002, 0, 0, 11.00005002, 0.2, 3);
  assert.strictEqual(D.compareGeometry([local], [world]), 'same');
  assert.strictEqual(D.compareGeometry([box(0, 0, 0, 1, 1, 1)], [box(0, 0, 0, 1, 1, 1, translation(0.3, 0, 0))]), 'moved');
  assert.strictEqual(D.compareGeometry([box(0, 0, 0, 1, 1, 1)], [box(0, 0, 0, 1, 1, 1.3)]), 'reshaped');
  assert.strictEqual(D.compareGeometry([box(0, 0, 0, 1, 1, 1)], [box(0, 0, 0, 1, 1, 1), box(2, 2, 2, 3, 3, 3)]), 'reshaped');
  // in a diff: 'same' counts as unchanged
  const o = { gid: 'A', eid: 1, props: {}, geo: 'x', parts: [local] }, n = { gid: 'A', eid: 1, props: {}, geo: 'y', parts: [world] };
  const d = D.diffModels([o], [n], Object.assign({ geometry: (a, b) => D.compareGeometry(a.parts, b.parts) }, TS));
  assert.deepStrictEqual(d.unchanged, [1]);
  assert.strictEqual(d.summary.modified, 0);
});

test('unchanged geometry: identical signature; geometry signature ignores properties', () => {
  const s1 = D.geometrySignature([box(0, 0, 0, 1, 1, 3)]);
  assert.strictEqual(s1, D.geometrySignature([box(0, 0, 0, 1, 1, 3)]));
  assert.notStrictEqual(s1, D.geometrySignature([box(0, 0, 0, 1, 1, 3.001)]));
  assert.notStrictEqual(s1, D.geometrySignature([box(0, 0, 0, 1, 1, 3, translation(0.001, 0, 0))]));
  assert.strictEqual(D.geometrySignature([]), '');
});

test('restore vs fresh load: local positions + world matrix and Float32 world positions (identity) give the same signature', () => {
  // the fresh load keeps a shape in its local frame with a placement; the
  // cache restore holds the same world geometry baked into Float32 positions
  for (const m of [translation(12.5, 3, -7.25), rotZ(0.3, 1, 2, 3), translation(155000.123, 463000.456, 12.7), rotZ(1.1, 98000.5, 432100.25, -3)]) {
    const fresh = [box(-0.5, -0.1, 0, 0.5, 0.1, 2.7, m), box(0, 0, 2.7, 0.2, 0.2, 3, m)];
    const restored = fresh.map(baked);
    assert.strictEqual(D.geometrySignature(restored), D.geometrySignature(fresh));
    // and the restored version compares as unchanged against the fresh one
    const d = D.diffModels([{ gid: 'A', eid: 1, props: { name: 'x' }, geo: D.geometrySignature(fresh) }],
      [{ gid: 'A', eid: 1, props: { name: 'x' }, geo: D.geometrySignature(restored) }], TS);
    assert.deepStrictEqual(d.unchanged, [1]);
  }
});

test('property sets: compared only when both versions carry them; quantities and ids are not property changes', () => {
  const p0 = { name: 'D', psets: { Pset_DoorCommon: { FireRating: 'EI30', IsExternal: false } }, quantities: { Width: 0.9 }, typeId: 7, hostId: 'H1' };
  const p1 = { name: 'D', psets: { Pset_DoorCommon: { FireRating: 'EI60', IsExternal: false } }, quantities: { Width: 1.0 }, typeId: 9, hostId: 'H2' };
  assert.deepStrictEqual(D.propertyChanges(p0, p1, true), [{ k: 'Pset_DoorCommon.FireRating', o: 'EI30', n: 'EI60' }]);
  assert.deepStrictEqual(D.propertyChanges(p0, p1, false), []);
  const g = [box(0, 0, 0, 1, 1, 2)];
  // the new version's psets have not landed yet: not compared, no false change
  const d0 = D.diffModels([entry('A', 1, p0, g)], [entry('A', 1, { name: 'D', psets: {} }, g)], TS);
  assert.strictEqual(d0.summary.psetsCompared, false);
  assert.deepStrictEqual(d0.unchanged, [1]);
  const d1 = D.diffModels([entry('A', 1, p0, g)], [entry('A', 1, p1, g)], TS);
  assert.strictEqual(d1.summary.psetsCompared, true);
  assert.deepStrictEqual(d1.propChanged, [1]);
  // a property that appears / disappears
  assert.deepStrictEqual(D.propertyChanges({ name: 'a' }, { name: 'a', objectType: 'T1' }), [{ k: 'objectType', o: '', n: 'T1' }]);
});

test('deterministic: input order and repeated runs give identical diffs', () => {
  const oldE = [], newE = [];
  for (let i = 0; i < 40; i++) {
    const gid = 'G' + String(i).padStart(3, '0');
    if (i % 9 !== 0) oldE.push(entry(gid, i, { name: 'E' + i }, [box(i, 0, 0, i + 0.5, 1, 3)]));
    if (i % 11 !== 0) newE.push(entry(gid, i + 1000, { name: i % 5 === 0 ? 'E' + i + 'x' : 'E' + i }, [box(i, 0, 0, i + 0.5, 1, i % 7 === 0 ? 4 : 3, i % 6 === 0 ? translation(0, 1, 0) : null)]));
  }
  const a = D.diffModels(oldE, newE, Object.assign({ rigid }, TS));
  const b = D.diffModels(oldE.slice().reverse(), newE.slice().reverse(), Object.assign({ rigid }, TS));
  assert.deepStrictEqual(JSON.stringify(b), JSON.stringify(a));
  assert.ok(a.summary.added > 0 && a.summary.removed > 0 && a.summary.moved > 0 && a.summary.reshaped > 0 && a.summary.properties > 0, JSON.stringify(a.summary));
  // counts add up
  const sm = a.summary;
  assert.strictEqual(sm.unchanged + sm.modified + sm.added, newE.length);
  assert.strictEqual(sm.unchanged + sm.modified + sm.removed, oldE.length);
  assert.strictEqual(sm.modified, sm.geometry + sm.properties - sm.both);
});

test('CSV: one row per changed property (old / new), one row for other changes, formula-safe cells', () => {
  const g = [box(0, 0, 0, 1, 1, 3)];
  const d = D.diffModels([entry('A', 1, { name: 'Wall, "big"', material: 'C' }, g), entry('R', 2, {}, g)],
    [entry('A', 1, { name: '=cmd', material: 'S' }, [box(0, 0, 0, 1, 1, 3, translation(1, 0, 0))]), entry('N', 3, {}, g)], Object.assign({ rigid }, TS));
  const rows = D.csvRows(d);
  assert.deepStrictEqual(rows[0], ['GlobalId', 'IFC type', 'Name', 'Change', 'Property', 'Old value', 'New value']);
  assert.deepStrictEqual(rows.slice(1).map((r) => [r[0], r[3], r[4]]), [['N', 'added', ''], ['R', 'removed', ''], ['A', 'moved+properties', 'material'], ['A', 'moved+properties', 'name']]);
  const csv = D.toCsv(d, { kind: (k) => k.toUpperCase() });
  assert.match(csv, /"Wall, ""big"""/);
  assert.match(csv, /'=cmd/);
  assert.match(csv, /MOVED\+PROPERTIES/);
  assert.ok(csv.endsWith('\r\n'));
});

test('filterIds and the "Clashes on changed elements" suggested view', () => {
  const g = [box(0, 0, 0, 1, 1, 3)];
  const d = D.diffModels([entry('A', 1, {}, g), entry('B', 2, { name: 'b' }, g)], [entry('A', 1, {}, g), entry('B', 2, { name: 'b2' }, g), entry('C', 3, {}, g)], TS);
  assert.deepStrictEqual([...D.filterIds(d, 'changed')].sort(), [2, 3]);
  assert.deepStrictEqual([...D.filterIds(d, 'added')], [3]);
  assert.strictEqual(D.filterIds(d, 'all'), null);
  const env = { m2: D.filterIds(d, 'changed') };
  const clashes = [
    { id: 'c1', type: 'hard', modelAId: 'm1', elemA: 2, modelBId: 'm2', elemB: 2 },  // B on m2: changed
    { id: 'c2', type: 'hard', modelAId: 'm2', elemA: 1, modelBId: 'm1', elemB: 3 },  // A unchanged; m1 has no diff
    { id: 'c3', type: 'hard', modelAId: 'm2', elemA: 3, modelBId: 'm1', elemB: 9 },  // C added
  ];
  const ctx = { changed: (c) => D.clashOnChanged(c, env) };
  const idx = T.indexItems(clashes, ctx);
  assert.deepStrictEqual(idx.map((r) => r.v.tag.includes('changed-element')), [true, false, true]);
  const sv = T.suggestedViews(idx).find((v) => v.id === 'changed-elements');
  assert.ok(sv, 'suggested');
  assert.strictEqual(sv.count, 2);
  assert.deepStrictEqual(T.applyFacets(idx, sv.facets).map((c) => c.id), ['c1', 'c3']);
  // without diffs: no tag, no view
  assert.ok(!T.suggestedViews(T.indexItems(clashes, {})).some((v) => v.id === 'changed-elements'));
});

test('wiring: script tag, service worker, typecheck list, ts-check, reload path and refine after the lazy psets', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /<script src="model-diff-core\.js" defer><\/script>/);
  assert.match(readFileSync(join(root, 'sw.js'), 'utf8'), /'model-diff-core\.js'/);
  assert.match(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.typecheck, /model-diff-core\.js/);
  assert.match(readFileSync(join(root, 'model-diff-core.js'), 'utf8'), /^\/\/ @ts-check/);
  // the reload compares while both versions are live, then refines once the psets landed
  const at = html.indexOf('var _vdSession = window._ccModelDiffCore ? _ccVersionDiffSession(existing.elements, result.elements) : null;');
  assert.ok(at > 0);
  const tail = html.slice(at, at + 6000);
  assert.match(tail, /job\.afterProps\(function\(\) \{\s*try \{ _vdRefined = _vdSession\.refine\(\);/);
  assert.match(tail, /idbUpdateFileMeta\(modelId, \{_versionDiff:_vdRefined\}\)/);
  // the model card shows the split counts; a parked model keeps its diff
  assert.match(html, /_ccDiffSummaryParts\(m\._versionDiff\.summary\)/);
  assert.match(html, /_versionDiff:_pkm\._versionDiff\|\|undefined/);
  // the triage model re-files rows when a diff changes
  assert.match(html, /changed: denv \? function\(c\) \{ return window\._ccModelDiffCore\.clashOnChanged\(c, denv\); \} : null/);
});
