'use strict';
// Smart (change-aware) re-runs by default + provision-for-void plumbing.
//
// The end-to-end guarantee ("a smart re-run after editing one element equals a
// full run") is proven in a real browser by tests/browser/office-clash-parity.mjs.
// This file locks the pieces that can be checked without one:
//   - _hashElement / _ccRunSignature sensitivity (what counts as "changed" /
//     what invalidates the baseline)
//   - the wiring of the memo (commit only on a completed run, no LRU eviction,
//     fullRerun escape hatch, default rules)
//   - the opening extraction (web-ifc records -> oriented boxes) against a mock api
//   - the office fixture really carries the openings the browser test relies on
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const core = require('../clash-classification-core');

function between(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a !== -1, 'not found: ' + startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(b !== -1, 'end not found: ' + endMarker);
  return src.slice(a, b);
}

// ── _hashElement / _ccRunSignature ────────────────────────────────────────
const stableJson = between('function _ccStableJSON(o) {', '  function _ccCanonOne(');
const hashSrc = between('function _hashElement(el) {', '  // Everything that must be identical');
const sigSrc = between('function _ccRunSignature(models, rules, protectedPairs) {', '  // ── Type-pair impossibility memo');
function load(win) {
  return new Function('window', stableJson + hashSrc + sigSrc + '; return {_hashElement:_hashElement,_ccRunSignature:_ccRunSignature};')(win);
}
const fns = load({ _ccClashClassificationCore: core, _ccWasmIntersect: function () {}, _ccWasmMinDist: function () {} });

function mesh(matrix, pos, idx) {
  const m = {
    geometry: { attributes: { position: { count: pos } }, index: idx ? { count: idx } : null },
    matrixWorld: { elements: matrix.slice() },
    updateWorldMatrix() {},
  };
  return m;
}
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function element(over) {
  return Object.assign({
    expressId: 42,
    box: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } },
    meshes: [mesh(IDENT, 24, 36)],
    props: { ifcType: 'IfcWall', name: 'W1', globalId: 'g', storey: 'L0', material: 'concrete', objectType: '', psets: { Pset_WallCommon: { LoadBearing: false } } },
  }, over || {});
}
function cloneEl(e, mut) {
  const c = JSON.parse(JSON.stringify({ expressId: e.expressId, box: e.box, props: e.props }));
  c.meshes = e.meshes.map((m) => mesh(m.matrixWorld.elements, m.geometry.attributes.position.count, m.geometry.index && m.geometry.index.count));
  if (mut) mut(c);
  return c;
}

test('_hashElement is stable for an untouched element and changes for every relevant edit', () => {
  const h = fns._hashElement;
  const base = element();
  assert.equal(h(base), h(cloneEl(base)), 'identical content -> identical hash');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.box.max.x += 0.001; })), 'bbox edit (1 mm)');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.meshes[0].matrixWorld.elements[13] += 0.01; })), 'mesh moved 10 mm with the same bbox');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.meshes[0].geometry.attributes.position.count = 25; })), 'vertex count');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.meshes.push(mesh(IDENT, 8, 12)); })), 'mesh added');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.props.name = 'W2'; })), 'renamed (name is on the clash)');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.props.ifcType = 'IfcSlab'; })), 'type changed');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.props.storey = 'L1'; })), 'storey changed');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.props.psets.Pset_WallCommon.LoadBearing = true; })), 'LoadBearing flips the severity role');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.props.openings = [1, 2, 3]; })), 'an opening appears');
  assert.notEqual(h(cloneEl(base, (c) => { c.props.openings = [1, 2, 3]; })), h(cloneEl(base, (c) => { c.props.openings = [1, 2, 4]; })), 'an opening moves');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.expressId = 43; })), 'identity');
});

test('_hashElement ignores changes that cannot alter a clash (unrelated pset data)', () => {
  const h = fns._hashElement;
  const base = element();
  assert.equal(h(base), h(cloneEl(base, (c) => { c.props.psets.Pset_WallCommon.FireRating = 'EI60'; })));
  assert.equal(h(base), h(cloneEl(base, (c) => { c.props.description = 'x'; })));
});

test('_hashElement quantises to 0.1 mm (float noise is not a change)', () => {
  const h = fns._hashElement;
  const base = element();
  assert.equal(h(base), h(cloneEl(base, (c) => { c.box.max.x += 0.00001; })));
});

const M1 = { id: 'm1', name: 'Arch', discipline: 'architectural', elements: [1, 2, 3], relatedPairs: { a: 1 } };
const M2 = { id: 'm2', name: 'MEP', discipline: 'mep', elements: [1, 2], relatedPairs: null };
const RULES = { hard: true, maxGap: 50, minGap: 0, excludeSelf: true, excludeTypes: [], toleranceByTypePair: {}, modelA: 'all', modelB: 'all' };

test('_ccRunSignature: identical run configuration -> identical signature; display/mode switches do not count', () => {
  const sig = fns._ccRunSignature;
  const base = sig([M1, M2], RULES, null);
  assert.ok(base.length > 10);
  assert.equal(sig([M2, M1], RULES, null), base, 'model order is irrelevant');
  assert.equal(sig([M1, M2], Object.assign({}, RULES, { fullRerun: true }), null), base, 'fullRerun only picks the mode');
  assert.equal(sig([M1, M2], Object.assign({}, RULES, { hideProvidedOpenings: false }), null), base, 'hideProvidedOpenings is display-only');
  assert.equal(sig([M1, M2], Object.assign({}, RULES, { changeAware: true }), null), base, 'the legacy changeAware key is a no-op');
});

test('_ccRunSignature: rules, tolerances, engine, model set and protected pairs each invalidate', () => {
  const sig = fns._ccRunSignature;
  const base = sig([M1, M2], RULES, null);
  for (const change of [{ maxGap: 80 }, { minGap: 5 }, { hard: false }, { excludeSelf: false }, { excludeTypes: ['IfcSpace'] },
    { toleranceByTypePair: { 'IfcBeam:IfcDuctSegment': 20 } }, { modelA: 'm1' }, { minOverlapVolM3: 0.01 }, { duplicates: true }]) {
    assert.notEqual(sig([M1, M2], Object.assign({}, RULES, change), null), base, JSON.stringify(change));
  }
  assert.notEqual(sig([M1], RULES, null), base, 'model removed');
  assert.notEqual(sig([M1, Object.assign({}, M2, { id: 'm3' })], RULES, null), base, 'model replaced');
  assert.notEqual(sig([M1, Object.assign({}, M2, { discipline: 'structural' })], RULES, null), base, 'discipline changed');
  assert.notEqual(sig([M1, Object.assign({}, M2, { elements: [1, 2, 3] })], RULES, null), base, 'element count changed');
  assert.notEqual(sig([M1, Object.assign({}, M2, { name: 'MEP v2' })], RULES, null), base, 'renamed model (it is in the clash description)');
  assert.notEqual(sig([M1, M2], RULES, { 'slab|slab': true }), base, 'detection-feedback protected pairs');
  const js = load({ _ccClashClassificationCore: core }); // no WASM narrow phase
  assert.notEqual(js._ccRunSignature([M1, M2], RULES, null), base, 'engine (WASM vs JS)');
});

test('_ccRunSignature returns "" (never matches -> full run) when it cannot be computed', () => {
  const broken = { hard: true, get boom() { throw new Error('x'); } };
  assert.equal(fns._ccRunSignature([M1], broken, null), '');
});

// ── wiring of the memo ─────────────────────────────────────────────────────

test('default rules: smart re-runs on (fullRerun false), provided openings hidden, legacy changeAware gone', () => {
  const initRules = src.match(/rules:\{ modelA:'all', modelB:'all', hard:true, maxGap:50[^\n]*\}/)[0];
  assert.match(initRules, /fullRerun:false/);
  assert.match(initRules, /hideProvidedOpenings:true/);
  assert.doesNotMatch(initRules, /changeAware/);
});

test('the old mutable LRU pair cache is gone; the memo is only committed by a completed run and never evicts', () => {
  assert.doesNotMatch(src, /_pairResultCache/);
  assert.doesNotMatch(src, /_prevElementHashes/);
  const fin = between('    // Commit the smart re-run baseline', '\n    // ── Update type-pair memo');
  assert.match(fin, /_runOK && !_memoOverflow && _sigNow/);
  assert.match(fin, /: null;/);
  // a failed chunk marks the run incomplete BEFORE the best-effort finalize
  const failIdx = src.indexOf('_runOK = false;');
  const finIdx = src.indexOf('try { _partial = _finalize(); }');
  assert.ok(failIdx !== -1 && finIdx > failIdx, '_runOK=false must precede the best-effort _finalize()');
  // overflow drops the memo instead of evicting entries
  assert.match(src, /_CC_RUNMEMO_MAX/);
  assert.match(src, /_memoOverflow = true/);
});

test('carry-over re-emits a fresh clone of the pristine snapshot; recorded snapshots are clones', () => {
  assert.match(src, /Object\.assign\(\{\}, _snap, \{ id:uid\(\), createdAt:new Date\(\)\.toISOString\(\) \}\)/);
  assert.match(src, /_nextSnaps\.set\(_pairKey\(pair\.mA, pair\.eA, pair\.mB, pair\.eB\), Object\.assign\(\{\}, clash\)\)/);
});

test('rules.fullRerun bypasses the baseline; a local-engine run invalidates it', () => {
  assert.match(src, /var _memo = \(!rules\.fullRerun && _sigNow && _ccRunMemo && _ccRunMemo\.sig === _sigNow\) \? _ccRunMemo : null;/);
  const local = between('if (useLocal) {', '} else {\n      work = _browserDetect');
  assert.match(local, /_ccRunMemo = null;/);
  assert.match(local, /_ccAnnotateClashes\(result, models\)/);
});

test('removing / replacing a model drops the baseline', () => {
  const fn = between('function _pairCacheClearForModel(modelId) {', 'window._ccPairCacheClearForModel');
  assert.match(fn, /_ccRunMemo = null/);
});

test('UI: full re-run + hide-provided toggles, list notice, row pills — all through _cc_t and design tokens', () => {
  for (const key of ['run.fullRerun', 'run.hideProvided', 'opening.passThrough', 'opening.show', 'opening.hide', 'opening.tooSmall', 'opening.provided']) {
    assert.ok(src.includes("_cc_t('" + key + "'"), key);
  }
  assert.match(src, /\$\{providedCount\} \$\{_cc_t\('opening\.passThrough','pass through provided openings'\)\}/);
  assert.match(src, /base = base\.filter\(function\(c\)\{ return c\.opening !== 'provided'; \}\)/);
  assert.match(src, /showProvided:false/);
  // pill colours come from tokens, not hex
  const pill = between("${it.opening==='partial'", "${it.status==='accepted_needs_check'");
  assert.doesNotMatch(pill, /#[0-9a-fA-F]{3,6}\b/);
});

// ── opening extraction (mock web-ifc) ──────────────────────────────────────

test('extractOpeningRecords + _ccOpeningsFlat turn IfcRelVoidsElement openings into oriented boxes per host', () => {
  const fnSrc = between('function extractOpeningRecords(api, modelID) {', '  function extractStoreys(api, modelID) {');
  const win = { _ccClashClassificationCore: core };
  const factory = new Function('IFC', 'window', fnSrc + '; return {extractOpeningRecords:extractOpeningRecords,_ccOpeningsFlat:_ccOpeningsFlat};');
  const { extractOpeningRecords, _ccOpeningsFlat } = factory({ IFCRELVOIDSELEMENT: 1401173127 }, win);

  // the fixture's "Opening: supply duct" as web-ifc reports it (see the probe in the PR notes):
  // local box x[-0.43,0.43] y[-0.23,0.23] z[0,0.4], flatTransformation maps it to world x 9.8..10.2
  const T = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 10, 2.7, -6.5, 1];
  const verts = new Float32Array([-0.43, -0.23, 0, 0, 0, 1, 0.43, 0.23, 0.4, 0, 0, 1, -0.43, 0.23, 0.2, 0, 0, 1]);
  let deleted = 0;
  const api = {
    GetLineIDsWithType: (_m, type) => { assert.equal(type, 1401173127); return { size: () => 2, get: (i) => [700, 701][i] }; },
    GetLine: (_m, id) => (id === 700 ? { RelatingBuildingElement: { value: 202 }, RelatedOpeningElement: { value: 217 } }
      : { RelatingBuildingElement: 202, RelatedOpeningElement: { value: 218 } }),
    GetFlatMesh: (_m, id) => ({ geometries: { size: () => 1, get: () => ({ geometryExpressID: id, flatTransformation: T }) }, delete: () => { deleted++; } }),
    GetGeometry: () => ({ GetVertexData: () => 0, GetVertexDataSize: () => 0, delete: () => { deleted++; } }),
    GetVertexArray: () => verts,
  };
  const recs = extractOpeningRecords(api, 1);
  assert.deepEqual(Object.keys(recs), ['202']);
  assert.equal(recs[202].length, 2, 'two openings for the same host');
  assert.deepEqual(recs[202][0].lmin, [-0.43, -0.23, 0].map(Math.fround));
  assert.ok(deleted >= 4, 'geometry and flat-mesh handles are released');
  const flat = _ccOpeningsFlat(recs[202]);
  assert.equal(flat.length, 30);
  // centre = T * local centre (0, 0, 0.2): local z maps to world x, so x = 10 + 0.2
  assert.ok(Math.abs(flat[0] - 10.2) < 1e-3 && Math.abs(flat[1] - 2.7) < 1e-3 && Math.abs(flat[2] + 6.5) < 1e-3, 'centre ' + flat.slice(0, 3));
  assert.deepEqual(flat.slice(12, 15), [0.43, 0.23, 0.2]);
  assert.equal(_ccOpeningsFlat([]), null);
  assert.equal(_ccOpeningsFlat(null), null);
});

test('extractOpeningRecords is defensive: a broken opening or a missing constant never throws', () => {
  const fnSrc = between('function extractOpeningRecords(api, modelID) {', '  function extractStoreys(api, modelID) {');
  const make = (IFC) => new Function('IFC', 'window', fnSrc + '; return extractOpeningRecords;')(IFC, {});
  assert.deepEqual(make({})({}, 1), {});
  const throwing = { GetLineIDsWithType: () => { throw new Error('boom'); } };
  assert.deepEqual(make({ IFCRELVOIDSELEMENT: 1 })(throwing, 1), {});
});

test('the IFC worker source carries the extraction helper and returns the records in its result message', () => {
  assert.match(src, /'var extractOpeningRecords=' \+ extractOpeningRecords\.toString\(\)/);
  assert.match(src, /_emit\(\{type:'result', packedEls:packedEls, geoTable:_geoTable, openingRecs:openingRecs,/);
  assert.match(src, /msg\.openingRecs && msg\.openingRecs\[eid\]/);
});

// ── the office fixture ─────────────────────────────────────────────────────

test('office fixture: level 0 carries three voided walls; the MEP file is byte-identical to before (separate GUID stream)', () => {
  const { generate } = require('./fixtures/generate-office-ifc.js');
  const a = generate();
  const opens = a.architecture.split('\n').filter((l) => /IFCOPENINGELEMENT/.test(l));
  const voids = a.architecture.split('\n').filter((l) => /IFCRELVOIDSELEMENT/.test(l));
  assert.equal(opens.length, 3);
  assert.equal(voids.length, 3);
  assert.ok(opens.every((l) => /\.OPENING\./.test(l)));
  // committed fixture files match the generator (no drift)
  const committedArch = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-architecture.ifc'), 'utf8');
  const committedMep = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-mep.ifc'), 'utf8');
  assert.equal(committedArch, a.architecture);
  assert.equal(committedMep, a.mep);
  // openings do not perturb the GUIDs of pre-existing elements
  const b = generate({ nlev: 3, seed: 1337 });
  assert.equal(b.mep, a.mep);
  const guidsOf = (t) => (t.match(/IFCWALL\('([^']+)'/g) || []);
  assert.equal(guidsOf(a.architecture).length, 15);
});
