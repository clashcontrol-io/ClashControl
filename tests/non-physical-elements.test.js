'use strict';
// Non-physical IFC elements (IfcVirtualElement / IfcAnnotation / IfcGrid) —
// docs/INTERNALS.md §21.49. Both IFC loaders (worker + main-thread fallback)
// must treat them identically: never tessellated/drawn, kept as stub elements
// (props, storey, no meshes), reported 'nonRenderable'; and no detection path
// may ever pair them. The real-browser equivalence (worker == fallback, no
// clashes) is tests/browser/ifc-worker-fallback-differential.mjs; this file
// locks the shared helpers on web-ifc itself and the sweep filters.
// Synthetic files only (tests/fixtures/generate-synthetic-ifc.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { generateSyntheticIfc, generateShardIfc } = require('./fixtures/generate-synthetic-ifc.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(name) {
  const start = html.indexOf('  function ' + name + '(');
  assert.ok(start !== -1, name + ' not found');
  const end = html.indexOf('\n  }', start) + '\n  }'.length;
  return html.slice(start, end);
}
function slice(a, b) {
  const s = html.indexOf(a); assert.ok(s >= 0, 'not found: ' + a);
  const e = html.indexOf(b, s + a.length); assert.ok(e > s, 'end not found: ' + b);
  return html.slice(s, e);
}

const WEBIFC = path.join(__dirname, '..', 'node_modules', 'web-ifc', 'web-ifc-api-node.js');
let apiP = null;
function api() {
  if (!apiP) apiP = (async () => { const W = require(WEBIFC); const a = new W.IfcAPI(); await a.Init(); if (a.SetLogLevel) a.SetLogLevel(6); return { a, W }; })();
  return apiP;
}
function helpers(W) {
  const IFC = { IFCVIRTUALELEMENT: W.IFCVIRTUALELEMENT, IFCANNOTATION: W.IFCANNOTATION, IFCGRID: W.IFCGRID };
  return new Function('IFC', ['_ccIfcStreamOrder', '_ccIfcNonPhysical', '_ccIfcNonPhysicalNoteIds', '_ccIfcStubIds'].map(extractFn).join('\n') +
    '\nreturn { _ccIfcStreamOrder, _ccIfcNonPhysical, _ccIfcNonPhysicalNoteIds, _ccIfcStubIds };')(IFC);
}
function open(a, text) { return a.OpenModel(new TextEncoder().encode(text), { USE_FAST_BOOLS: true }); }
function rec(a, m) {
  return (x) => {
    const g = [];
    for (let i = 0; i < x.geometries.size(); i++) { const p = x.geometries.get(i); g.push(p.geometryExpressID, ...Array.from(p.flatTransformation)); }
    return JSON.stringify([x.expressID, g]);
  };
}

test('the synthetic generator keeps every existing fixture byte-identical (nonPhysical is opt-in)', () => {
  const a = generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, withSpaces: true });
  assert.doesNotMatch(a, /IFCVIRTUALELEMENT|IFCANNOTATION|IFCGRID\(/);
  const b = generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, withSpaces: true, nonPhysical: true });
  assert.ok(b.startsWith(a.slice(0, a.indexOf('IFCRELCONTAINEDINSPATIALSTRUCTURE'))));
  assert.equal((b.match(/=IFCVIRTUALELEMENT\(/g) || []).length, 2);
  assert.equal((b.match(/=IFCANNOTATION\(/g) || []).length, 2);
  assert.equal((b.match(/=IFCGRID\(/g) || []).length, 2);
  assert.doesNotMatch(generateShardIfc({ storeys: 1, perStorey: 20 }), /IFCVIRTUALELEMENT|IFCANNOTATION|IFCGRID\(/);
  assert.equal((generateShardIfc({ storeys: 2, perStorey: 20, nonPhysical: 5 }).match(/=IFC(VIRTUALELEMENT|ANNOTATION|GRID)\(/g) || []).length, 10);
});

test('streamIds = StreamAllMeshes minus the non-physical elements, same order and geometry (they are never tessellated)', async () => {
  const { a, W } = await api();
  const H = helpers(W);
  for (const text of [generateSyntheticIfc({ storeyCount: 3, wallsPerStorey: 4, withSpaces: true, nonPhysical: { perStorey: 9 } }),
    generateShardIfc({ storeys: 2, perStorey: 80, seed: 5, nonPhysical: 12 })]) {
    const m = open(a, text);
    try {
      const np = H._ccIfcNonPhysical(a, m);
      assert.ok(np.ids.length > 0);
      for (const id of np.ids) assert.ok([W.IFCVIRTUALELEMENT, W.IFCANNOTATION, W.IFCGRID].includes(a.GetLineType(m, id)));
      assert.ok(Array.isArray(np.streamIds), 'the order probe places every type of these files');
      const all = [], some = [], r = rec(a, m);
      a.StreamAllMeshes(m, (x) => { if (!np.set[x.expressID]) all.push(r(x)); });
      a.StreamMeshes(m, np.streamIds, (x) => some.push(r(x)));
      assert.deepStrictEqual(some, all);
      for (const id of np.streamIds) assert.ok(!np.set[id]);
      assert.deepStrictEqual(H._ccIfcNonPhysicalNoteIds(np, {}, null), np.ids);
    } finally { a.CloseModel(m); }
  }
});

test('a file without non-physical elements keeps the plain StreamAllMeshes path (no probe)', async () => {
  const { a, W } = await api();
  const H = helpers(W);
  const m = open(a, generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 2 }));
  try { assert.deepStrictEqual(H._ccIfcNonPhysical(a, m), { ids: [], set: {}, streamIds: null }); }
  finally { a.CloseModel(m); }
});

test('stub order: rooms without geometry, then non-physical elements; a storey scope keeps only its own', async () => {
  const { W } = await api();
  const H = helpers(W);
  const np = { ids: [7, 8, 9], set: { 7: 1, 8: 1, 9: 1 } };
  const storeyMap = { 1: 'L0', 2: 'L1', 7: 'L1', 8: 'L0' };
  assert.deepStrictEqual(H._ccIfcStubIds([1, 2, 3], { 2: true }, np, storeyMap, null), [1, 3, 7, 8, 9]);
  assert.deepStrictEqual(H._ccIfcStubIds([1, 2, 3], { 2: true }, np, storeyMap, { L0: true }), [1, 8]);
  assert.deepStrictEqual(H._ccIfcNonPhysicalNoteIds(np, storeyMap, { L0: true }), [8]);
  assert.deepStrictEqual(H._ccIfcNonPhysicalNoteIds(np, storeyMap, null), [7, 8, 9]);
});

test('both loaders use the same helpers; the worker blob carries them', () => {
  const fallback = slice('function loadIFC(buffer, fallbackColor', 'api.CloseModel(modelID);');
  const worker = slice('function _ifcWorkerMain() {', "_emit({type:'result'");
  for (const src of [fallback, worker]) {
    assert.match(src, /_ccIfcNonPhysical\(api, modelID/);
    assert.match(src, /if \(!isSpace && _np\.set\[(eid|expressID)\]\) \{ _skippedPredecode\+\+; return; \}/);
    assert.match(src, /api\.StreamMeshes\(modelID, _np\.streamIds,/);
    assert.match(src, /_ccIfcNonPhysicalNoteIds\(_np, storeyMap, _scopeSet\)/);
    assert.match(src, /_ccIfcStubIds\(_spaceIds, _spaceGeoEids, _np, storeyMap, _scopeSet\)/);
    assert.doesNotMatch(src, /'nonRenderable'\); return; \}/, 'no in-callback note: notes come after the stream on both paths');
  }
  assert.doesNotMatch(fallback, /_reAddTypes/);
  const url = slice('function _getIFCWorkerUrl() {', '\n  }\n');
  for (const n of ['_ccIfcNonPhysical', '_ccIfcNonPhysicalNoteIds', '_ccIfcStubIds', '_ccIfcStreamOrder']) assert.match(url, new RegExp("'var " + n + "=' \\+ " + n + '\\.toString\\(\\)'));
  // IFC type codes reach 2^32: packed as Float64 (Int32 turned IfcSpace /
  // IfcVirtualElement / … negative on the worker path)
  assert.match(worker, /typeId: new Float64Array\(pkTypeId\)/);
  assert.match(slice('function _ccMergeIfcShards(', '\n  }\n'), /typeId: new Float64Array\(N\)/);
  // the decoder keeps geoCount-0 stubs (and gives them no openings)
  const dec = slice('function _ccDecodeIfcWorkerResult(', 'var _loopEnd');
  assert.match(dec, /if \(elMeshes\.length > 0 \|\| gc === 0\) \{/);
  assert.match(dec, /if \(gc > 0 && msg\.openingRecs/);
});

test('geo caches written before stubs on both paths (np !== 1) re-parse once when the source is stored', () => {
  const fn = new Function(extractFn('_ccGeoCacheLacksSpaces') + '\n' + extractFn('_ccIfcHasBytes') + '\nreturn _ccGeoCacheLacksSpaces;')();
  const buf = { buffer: new ArrayBuffer(4) };
  assert.equal(fn({ sp: 2, sem: 1, xp: 1 }, buf), true);
  assert.equal(fn({ sp: 2, sem: 1, xp: 1, np: 1 }, buf), false);
  assert.equal(fn({ sp: 2, sem: 1, xp: 1 }, {}), false, 'no source bytes: keep the old cache');
  assert.match(html, /sp:2, sem:1, xp:1, np:1, hasPsets:hasPsets/);
  // a stub's empty box (+/-Infinity) survives the v8 restore validation
  const match = new Function(extractFn('_ccRestoredGeoMatchesCache') + '\nreturn _ccRestoredGeoMatchesCache;')();
  const empty = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  assert.equal(match({ elData: [{ eid: 5, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] }] }, { elements: [{ expressId: 5, box: empty }] }), true);
  assert.equal(match({ elData: [{ eid: 5, box: [0, 0, 0, 1, 1, 1] }] }, { elements: [{ expressId: 5, box: empty }] }), false);
});

// ── Detection: no source may pair a non-physical element ──
const np = slice('  var _NON_PHYSICAL_TYPES = {', '\n  // Render-style materials');
const sweeps = slice('  function _ccSelfClashAllowed(', '  // ── Candidate-view abstraction');
const wasmSweep = slice('  function _makeCompactCandidates(', '  // ── GLB Worker geometry pre-extraction');
const box = (x) => ({ min: { x: x - 0.5, y: -0.5, z: -0.5 }, max: { x: x + 0.5, y: 0.5, z: 0.5 } });
const el = (id, t, x) => ({ expressId: id, box: box(x), props: { ifcType: t }, meshes: [{}] });
function models() {
  return [{ id: 'a', elements: [el(1, 'IfcWall', 0), el(2, 'IfcVirtualElement', 0.2), el(3, 'IfcAnnotation', 0.1), el(4, 'IfcGrid', -0.1)] },
    { id: 'b', elements: [el(11, 'IfcDuctSegment', 0.3), el(12, 'IfcGrid', 0.3), el(13, 'IfcSpace', 0)] }];
}

test('JS broad phase: non-physical elements never become candidates (geometry or not, any rules)', () => {
  const window = {};
  const f = new Function('window', np + '\n' + sweeps + '\nreturn _sweepAndPrune;')(window);
  for (const rules of [{}, { includeSpaces: true, duplicates: true, excludeSelf: false }]) {
    const ms = models();
    const pairs = f(ms, ms, rules, 0.1);
    assert.ok(pairs.length > 0);
    for (const p of pairs) for (const e of [p.eA, p.eB]) assert.ok(!['IfcVirtualElement', 'IfcAnnotation', 'IfcGrid'].includes(e.props.ifcType));
  }
});

test('WASM broad phase input: non-physical elements are never handed to the sweep', () => {
  let seen = null;
  const window = { _ccWasmSweepAndPrune: (min) => { seen = min.length / 3; return new Uint32Array(0); } };
  const f = new Function('window', np + '\n' + sweeps + '\n' + wasmSweep + '\nreturn _sweepAndPruneWasm;')(window);
  const ms = models();
  f(ms, ms, {}, 0.1);
  assert.equal(seen, 2, 'wall + duct only (room excluded by default, virtual/annotation/grids always)');
  f(ms, ms, { includeSpaces: true }, 0.1);
  assert.equal(seen, 3);
});

test('the local-engine payload and the snapshot context skip them too; spaces keep their own switch', () => {
  const le = fs.readFileSync(path.join(__dirname, '..', 'addons', 'local-engine.js'), 'utf8');
  assert.match(le, /var _NON_PHYSICAL = \{ IfcVirtualElement: 1, IfcAnnotation: 1, IfcGrid: 1 \};/);
  assert.match(le, /if \(el\.props && _NON_PHYSICAL\[el\.props\.ifcType\]\) return;/);
  assert.match(html, /t === 'IfcOpeningStandardCase' \|\| _ccIsNonPhysicalEl\(el\)\) return;/);
  const isNp = new Function(np + '\nreturn _ccIsNonPhysicalEl;')();
  assert.equal(isNp({ props: { ifcType: 'IfcSpace' } }), false);
  assert.equal(isNp({ props: { ifcType: 'IfcGrid' } }), true);
  assert.equal(isNp({ props: { ifcType: 'IfcWall' } }), false);
  assert.equal(isNp({}), false);
  assert.equal((html.match(/var _NON_PHYSICAL_TYPES = /g) || []).length, 1);
});
