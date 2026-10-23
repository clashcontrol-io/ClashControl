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
  return new Function('window', '_ccOrigin', stableJson + hashSrc + sigSrc + '; return {_hashElement:_hashElement,_ccRunSignature:_ccRunSignature};')(win, win._origin || [0, 0, 0]);
}
const fns = load({ _ccClashClassificationCore: core, _ccWasmIntersect: function () {}, _ccWasmMinDist: function () {} });

// Position attribute stand-in: `count` synthetic vertices (k, 2k, 3k) * 0.01
// unless explicit coordinates are given.
function posAttr(count, coords) {
  const c = coords || null;
  return { count, getX: (i) => c ? c[i * 3] : i * 0.01, getY: (i) => c ? c[i * 3 + 1] : i * 0.02, getZ: (i) => c ? c[i * 3 + 2] : i * 0.03 };
}
function mesh(matrix, pos, idx, coords) {
  const m = {
    geometry: { attributes: { position: posAttr(pos, coords) }, index: idx ? { count: idx } : null },
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
  e.meshes.forEach((m, i) => { c.meshes[i].geometry.attributes.position = m.geometry.attributes.position; });
  if (mut) mut(c);
  return c;
}

test('_hashElement is stable for an untouched element and changes for every relevant edit', () => {
  const h = fns._hashElement;
  const base = element();
  assert.equal(h(base), h(cloneEl(base)), 'identical content -> identical hash');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.box.max.x += 0.001; })), 'bbox edit (1 mm)');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.meshes[0].matrixWorld.elements[13] += 0.01; })), 'mesh moved 10 mm with the same bbox');
  assert.notEqual(h(base), h(cloneEl(base, (c) => { c.meshes[0].geometry.attributes.position = posAttr(25); })), 'vertex count');
  // same counts, same matrix, same box — only a vertex moved (e.g. a sloped top reshaped inside the bounds)
  assert.notEqual(h(base), h(cloneEl(base, (c) => {
    const p = c.meshes[0].geometry.attributes.position, gx = p.getX;
    c.meshes[0].geometry.attributes.position = Object.assign({}, p, { getX: (i) => (i === 0 ? gx(i) + 0.05 : gx(i)) });
  })), 'vertex data edited with identical counts/matrix/box');
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

// A three.js-like position attribute: version bumped by needsUpdate, getX/Y/Z
// read the backing array (counted, to prove the sample is cached).
function threeAttr(coords) {
  const a = { array: Float32Array.from(coords), count: coords.length / 3, version: 0, reads: 0 };
  a.getX = (i) => { a.reads++; return a.array[i * 3]; };
  a.getY = (i) => { a.reads++; return a.array[i * 3 + 1]; };
  a.getZ = (i) => { a.reads++; return a.array[i * 3 + 2]; };
  Object.defineProperty(a, 'needsUpdate', { set(v) { if (v) a.version++; } });
  return a;
}
function threeElement(attr, matrix) {
  return {
    expressId: 7,
    box: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    meshes: [{ geometry: { attributes: { position: attr }, index: null }, matrixWorld: { elements: (matrix || IDENT).slice() }, updateWorldMatrix() {} }],
    props: { ifcType: 'IfcBeam', name: 'B1', globalId: 'gb', storey: 'L0' },
  };
}

test('_hashElement caches the vertex sample per position attribute (and the props hash per props object) and stays exactly as strict', () => {
  const h = fns._hashElement;
  const coords = [];
  for (let i = 0; i < 300; i++) coords.push(i * 0.01, (i % 7) * 0.1, (i % 3) * 0.2);
  const attr = threeAttr(coords);
  const el = threeElement(attr);
  const h0 = h(el);
  const readsAfterFirst = attr.reads;
  assert.ok(readsAfterFirst > 0);
  assert.equal(h(el), h0, 'unchanged -> same hash');
  assert.equal(attr.reads, readsAfterFirst, 'second hash reads no vertices (cached per attribute + version)');
  // the cached value equals a fresh computation over an identical attribute
  assert.equal(h(threeElement(threeAttr(coords))), h0, 'cache never changes the hash value');
  // in-place geometry edit that bumps the attribute version (three.js needsUpdate) is detected
  attr.array[0] += 0.05; attr.needsUpdate = true;
  const h1 = h(el);
  assert.notEqual(h1, h0, 'in-place vertex edit + needsUpdate');
  assert.ok(attr.reads > readsAfterFirst, 're-sampled after the version bump');
  attr.array[0] -= 0.05; attr.needsUpdate = true;
  assert.equal(h(el), h0, 'edit undone -> original hash again');
  // a new backing array on the same attribute (setArray-style swap) is detected even without a version bump
  const swapped = Float32Array.from(coords); swapped[3 * 299] += 0.1;
  attr.array = swapped;
  assert.notEqual(h(el), h0, 'backing array replaced');
  attr.array = Float32Array.from(coords); attr.needsUpdate = true;
  assert.equal(h(el), h0);
  // new geometry (different attribute object with different data)
  const c2 = coords.slice(); c2[1] += 0.02;
  assert.notEqual(h(threeElement(threeAttr(c2))), h0, 'new geometry');
  // matrix / box / props are still hashed every time
  const moved = IDENT.slice(); moved[12] += 0.01;
  assert.notEqual(h(threeElement(attr, moved)), h0, 'matrix moved 10 mm, same attribute');
  const elBox = threeElement(attr); elBox.box.max.y += 0.001;
  assert.notEqual(h(elBox), h0, 'box');
  const elProps = threeElement(attr); elProps.props.name = 'B2';
  assert.notEqual(h(elProps), h0, 'props');
  // props edited IN PLACE on the same object (cached props hash must not hide it)
  const elP = threeElement(attr);
  const hp0 = h(elP);
  elP.props.name = 'B9';
  assert.notEqual(h(elP), hp0, 'in-place rename');
  elP.props.name = 'B1';
  assert.equal(h(elP), hp0);
  const wall = threeElement(attr); wall.props.ifcType = 'IfcWall'; wall.props.psets = { Pset_WallCommon: { LoadBearing: false } };
  const hw0 = h(wall);
  wall.props.psets.Pset_WallCommon.LoadBearing = true;
  assert.notEqual(h(wall), hw0, 'in-place LoadBearing flip');
  wall.props.psets.Pset_WallCommon.LoadBearing = false;
  assert.equal(h(wall), hw0);
  wall.props.storey = 'L2';
  assert.notEqual(h(wall), hw0, 'in-place storey');
  // the attribute is shared by two meshes (instanced geometry): both are hashed, one sample computation
  const before = attr.reads;
  const two = threeElement(attr); two.meshes.push(two.meshes[0]);
  assert.notEqual(h(two), h0, 'two meshes');
  assert.equal(attr.reads, before, 'shared attribute sampled once');
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
  assert.equal(sig([M1, M2], Object.assign({}, RULES, { hideContacts: false }), null), base, 'hideContacts is display-only');
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
  // object spread (= Object.assign({}, …): same keys/order/values, fast-mode object — see _recordSnap)
  assert.match(src, /clashes\.push\(\{ \.\.\._snap, id:uid\(\), createdAt:new Date\(\)\.toISOString\(\) \}\)/);
  assert.match(src, /_nextSnaps\.set\(_pairKey\(pair\.mA, pair\.eA, pair\.mB, pair\.eB\), \{ \.\.\.clash \}\)/);
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
  for (const key of ['run.fullRerun', 'run.hideProvided', 'opening.passThrough', 'bucket.showAll', 'bucket.reviewOnly', 'opening.tooSmall', 'opening.provided']) {
    assert.ok(src.includes("_cc_t('" + key + "'"), key);
  }
  // provided-opening clashes are their own review bucket, counted in the bucket bar
  assert.match(src, /provided: n \+ ' ' \+ _cc_t\('opening\.passThrough', 'pass through provided openings'\)/);
  assert.match(src, /var _tmR = isClashTab \? _ccTriageModel\(s\) : null;/);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'clash-classification-core.js'), 'utf8'), /if \(c\.opening === 'provided'\) return 'provided';/);
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
  assert.match(src, /_emit\(\{type:'result', packedEls:packedEls, geoTable:\(_stream \? \{\} : _geoTable\), streamed:_stream \? _bSent : 0,\n\s+openingRecs:openingRecs,/);
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

test('_ccRunSignature: a different engine-frame origin invalidates the smart re-run baseline', () => {
  const a = load({ _ccClashClassificationCore: core, _origin: [0, 0, 0] })._ccRunSignature([M1, M2], RULES, null);
  const b = load({ _ccClashClassificationCore: core, _origin: [100032, 0, 64] })._ccRunSignature([M1, M2], RULES, null);
  assert.notEqual(a, b);
});
