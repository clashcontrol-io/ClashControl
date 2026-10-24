// Geometry cache gs:1 (index.html _geoSerialize / _geoDeserialize): every
// distinct BufferGeometry object is stored ONCE (geoData) and its meshes
// reference it by index, the way the IFC loaders share one geometry per IFC
// geometry id across its placements. Round trip through a structured clone
// (what IndexedDB does):
//   - the restored model shares geometries exactly like the source model
//     (same partition of meshes by geometry object), one geometry per
//     stored geometry, bounds/normal shrink once per geometry
//   - every mesh's position / normal / index bytes, matrix (bit for bit,
//     from the stored position/quaternion/scale), colour and bounds are
//     identical to the source; the instancing key is the stored geometry
//     + material (the loaders' key); an old per-mesh (pre-gs) cache of the
//     same model restores to the same bytes
//   - old caches (no gs marker, buffers on every mesh) still restore
//     exactly as before: one geometry per mesh, same bytes
//   - the new record is smaller; the v8 validator accepts gs:1 and xp:1
//     payloads and rejects dangling geometry references
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const THREE = require('three');
const safety = require('../safety-migrations.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('  function _dequantizePositions(');
const end = src.indexOf('\n  function idbDeleteProjectData(');
assert.ok(start > 0 && end > start, 'geo cache functions not found');

function load(v8On) {
  const mats = new Map();
  const env = {
    THREE,
    window: {},
    _ccGeoCacheV8Enabled: () => v8On,
    _ccGetSharedPhongMat(r, g, b, a) {
      const k = [r, g, b, a].join(',');
      if (!mats.has(k)) { const m = new THREE.MeshPhongMaterial({ color: new THREE.Color(r, g, b), opacity: a, transparent: a < 1 }); mats.set(k, m); }
      return mats.get(k);
    },
    _ccBakeMesh(mesh) { mesh.updateMatrix(); mesh.updateMatrixWorld(true); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; },
    _ccMarkSpaceElements() { return 0; },
  };
  const names = Object.keys(env);
  const fn = new Function(...names, src.slice(start, end) +
    '\n;return { _geoSerialize: _geoSerialize, _geoDeserialize: _geoDeserialize, _ccQuantizeNormalAttr: _ccQuantizeNormalAttr, _ccGeoBounds: _ccGeoBounds, _ccRestoredGeoMatchesCache: _ccRestoredGeoMatchesCache, _ccGeoCacheLacksSpaces: _ccGeoCacheLacksSpaces };');
  return Object.assign(fn(...names.map((n) => env[n])), { getMat: env._ccGetSharedPhongMat });
}

// A synthetic loader result: geometries built like the IFC loaders build them
// (Float32 positions, normals shrunk to Int8, bounds from the array), several
// reused by many placements across elements, some used once, one > 65535
// vertices (Uint32 index), one element with two meshes of the same geometry.
function makeResult(api, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  function geometry(nVerts, scale, far) {
    const pos = new Float32Array(nVerts * 3), nrm = new Float32Array(nVerts * 3);
    for (let i = 0; i < nVerts * 3; i++) pos[i] = (rnd() - 0.5) * scale + (far ? 155000.123 : 0);
    for (let i = 0; i < nVerts; i++) { const x = rnd() - 0.5, y = rnd() - 0.5, z = rnd() - 0.5, l = Math.hypot(x, y, z) || 1; nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l; }
    const nTri = Math.max(1, Math.floor(nVerts * 1.5));
    const idx = new Uint32Array(nTri * 3);
    for (let i = 0; i < idx.length; i++) idx[i] = Math.floor(rnd() * nVerts);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    api._ccQuantizeNormalAttr(g);
    api._ccGeoBounds(g);
    return g;
  }
  const shared = [geometry(24, 0.6), geometry(36, 2.8, true), geometry(8, 1.2), geometry(70000, 3)];
  let gidNext = 9000;
  const gidOf = new Map(shared.map((g) => [g, gidNext++]));
  const elements = [], meshes = [];
  for (let e = 0; e < 120; e++) {
    const eid = 100 + e, el = { expressId: eid, meshes: [], box: new THREE.Box3(), props: { name: 'el ' + e, psets: e % 7 ? {} : { P: { a: 1 } } } };
    const nMesh = e % 11 === 0 ? 2 : 1;
    for (let k = 0; k < nMesh; k++) {
      let g;
      if (e === 5) g = shared[3]; // big one, reused below too
      else if (e % 11 === 0) g = shared[0]; // two meshes of the same element share one geometry
      else if (rnd() < 0.55) g = shared[Math.floor(rnd() * 3)];
      else { g = geometry(6 + Math.floor(rnd() * 40), 1 + rnd() * 5, rnd() < 0.3); gidOf.set(g, gidNext++); }
      const c = [[0.8, 0.2, 0.2, 1], [0.1, 0.5, 0.9, 1], [0.3, 0.3, 0.3, 0.4]][Math.floor(rnd() * 3)];
      const mesh = new THREE.Mesh(g, api.getMat(...c));
      // placed like the loaders place a mesh: applyMatrix4 of a flat transform
      const t = new THREE.Matrix4().makeRotationZ(rnd() * Math.PI).setPosition(rnd() * 50, rnd() * 50, rnd() * 9);
      mesh.applyMatrix4(t);
      mesh.userData.expressId = eid;
      // most meshes carry the IFC geometry id; a few (GLB / Revit style) do not
      if (e % 13 !== 1) mesh.userData._geoExpId = gidOf.get(g);
      api.__bake(mesh);
      el.box.expandByObject(mesh);
      el.meshes.push(mesh); meshes.push(mesh);
    }
    if (e === 77) { const m2 = new THREE.Mesh(shared[3], api.getMat(0.8, 0.2, 0.2, 1)); m2.applyMatrix4(new THREE.Matrix4().makeTranslation(3, 4, 5)); m2.userData.expressId = eid; m2.userData._geoExpId = gidOf.get(shared[3]); api.__bake(m2); el.box.expandByObject(m2); el.meshes.push(m2); meshes.push(m2); } // big geometry, second placement
    elements.push(el);
  }
  elements.push({ expressId: 9999, meshes: [], box: new THREE.Box3(), props: { name: 'stub' } }); // stub element (no geometry)
  return { elements, meshes, storeys: [], storeyData: [], stats: { source: 'synthetic' } };
}

// The pre-gs payload of the same model: buffers on every mesh (what the cache
// held before) — built from the gs payload by copying each mesh's geometry.
function legacyPayload(gs) {
  const out = Object.assign({}, gs);
  delete out.gs; delete out.geoData;
  out.meshData = gs.meshData.map((md) => {
    const g = gs.geoData[md.g], r = Object.assign({}, md);
    delete r.g;
    r.pos = g.pos.slice(0); if (g.n8) r.n8 = g.n8.slice(0); if (g.nrm) r.nrm = g.nrm.slice(0);
    r.idx = g.idx.slice(0); r.idx16 = g.idx16;
    return r;
  });
  return out;
}

const clone = (x) => v8.deserialize(v8.serialize(x)); // IndexedDB's structured clone
const bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

function meshRows(result) {
  const rows = [];
  const geoId = new Map();
  for (const el of result.elements) {
    for (const m of el.meshes) {
      const g = m.geometry;
      if (!geoId.has(g)) geoId.set(g, geoId.size);
      rows.push({
        eid: el.expressId, geo: geoId.get(g),
        pos: bytesOf(g.attributes.position.array).toString('base64'),
        nrm: bytesOf(g.attributes.normal.array).toString('base64') + ':' + g.attributes.normal.array.constructor.name + ':' + g.attributes.normal.normalized,
        idx: Array.from(g.index.array).join(','),
        mtx: Array.from(m.matrix.elements).join(','),
        col: [m.material.color.r, m.material.color.g, m.material.color.b, m.material.opacity].join(','),
        bounds: [g.boundingBox.min.toArray(), g.boundingBox.max.toArray(), g.boundingSphere.center.toArray(), g.boundingSphere.radius].join('|'),
      });
    }
  }
  return { rows, distinct: geoId.size };
}
const keyOf = (r) => { const o = Object.assign({}, r); delete o.geo; delete o.k; return JSON.stringify(o); };
// Matrices: a gs:1 restore composes the stored position / quaternion /
// scale once, so its matrix equals the source's bit for bit. An old cache
// re-applies the stored matrix (decompose + recompose again), which is only
// equal to ~1e-16 relative for rotations — compared with closeMtx.
const noMtx = (r) => { const o = JSON.parse(keyOf(r)); delete o.mtx; return JSON.stringify(o); };
function closeMtx(a, b, what) { const x = a.split(',').map(Number), y = b.split(',').map(Number); x.forEach((v, i) => assert.ok(Math.abs(v - y[i]) <= 1e-12 * Math.max(1, Math.abs(v)), what + ' matrix ' + i + ': ' + v + ' vs ' + y[i])); }

for (const v8On of [false, true]) {
  test('gs:1 round trip shares geometry like the source and keeps every byte (geoCacheV8 ' + (v8On ? 'on' : 'off') + ')', () => {
    const api = load(v8On);
    api.__bake = (m) => { m.updateMatrix(); m.updateMatrixWorld(true); m.matrixAutoUpdate = false; };
    const result = makeResult(api, 77);
    const payload = api._geoSerialize(result, true);
    assert.equal(payload.gs, 1);
    assert.equal(payload.xp, 1);
    assert.equal(payload.v, v8On ? 8 : 7);
    const srcRows = meshRows(result);
    // one stored geometry per distinct geometry object; no mesh record carries buffers
    assert.equal(payload.geoData.length, srcRows.distinct);
    for (const md of payload.meshData) for (const k of ['pos', 'n8', 'nrm', 'idx', 'qpos', 'qnrm']) assert.equal(md[k], undefined, 'mesh record carries ' + k);
    const uniqueMeshes = new Set(); result.elements.forEach((el) => el.meshes.forEach((m) => uniqueMeshes.add(m)));
    assert.equal(payload.meshData.length, uniqueMeshes.size);
    assert.ok(payload.meshData.length - payload.geoData.length >= 0.3 * payload.meshData.length, 'fixture reuses at least 30 % of geometries');
    assert.deepEqual(safety.validateGeoCachePayload(Object.assign({}, payload, { v: 8 })), { valid: true, reason: null });

    const stored = clone(payload);
    const restored = api._geoDeserialize(stored);
    const got = meshRows(restored);
    // same sharing: the restored model has exactly the source's distinct geometries
    assert.equal(got.distinct, payload.geoData.length);
    // the restored elements hold one mesh per stored mesh; compare per element
    // (the source's mesh shared by two elements is restored as two meshes)
    const srcByEl = new Map(), gotByEl = new Map();
    for (const r of srcRows.rows) { if (!srcByEl.has(r.eid)) srcByEl.set(r.eid, []); srcByEl.get(r.eid).push(r); }
    for (const r of got.rows) { if (!gotByEl.has(r.eid)) gotByEl.set(r.eid, []); gotByEl.get(r.eid).push(r); }
    for (const [eid, rows] of srcByEl) {
      const gr = gotByEl.get(eid) || [];
      assert.deepEqual(gr.map(keyOf), rows.map(keyOf), 'element ' + eid);
    }
    // geometry partition: meshes that share a geometry in the source share one after restore
    const srcPart = new Map(), gotPart = new Map();
    const part = (rows, map) => { const n = new Map(); rows.forEach((r) => { const i = n.get(r.eid) || 0; n.set(r.eid, i + 1); map.set(r.eid + '#' + i, r.geo); }); };
    part(srcRows.rows, srcPart); part(got.rows, gotPart);
    const pairs = (map) => { const keys = [...map.keys()].sort(), out = []; for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (map.get(keys[i]) === map.get(keys[j])) out.push(keys[i] + '=' + keys[j]); return out; };
    assert.deepEqual(pairs(gotPart), pairs(srcPart));
    // instancing keys as before; semantic check passes; stub element kept
    // instancing key = stored geometry + shared material, like the loaders' key
    for (const el of restored.elements) for (const m of el.meshes) assert.match(m.userData._instKey, /^g:\d+:/);
    const gidMeshes = payload.meshData.filter((md) => md.gid != null).length;
    assert.ok(gidMeshes > 0 && gidMeshes < payload.meshData.length);
    assert.ok(restored.elements.some((e) => e.expressId === 9999 && e.meshes.length === 0));
    assert.equal(api._ccRestoredGeoMatchesCache(stored, restored), true);
    assert.equal(api._ccGeoCacheLacksSpaces(stored, { buffer: new ArrayBuffer(1) }), false, 'a gs:1 cache is current (no re-parse)');

    // the old per-mesh format of the same model restores to the same bytes,
    // one geometry per mesh (exactly as before), and is larger
    const legacy = clone(legacyPayload(payload));
    const oldRestored = api._geoDeserialize(legacy);
    const old = meshRows(oldRestored);
    assert.equal(old.distinct, legacy.meshData.length);
    assert.deepEqual(old.rows.map(noMtx), got.rows.map(noMtx));
    old.rows.forEach((r, i) => closeMtx(r.mtx, got.rows[i].mtx, 'old-format mesh ' + i));
    assert.equal(api._ccRestoredGeoMatchesCache(legacy, oldRestored), true);
    assert.equal(api._ccGeoCacheLacksSpaces(legacy, { buffer: new ArrayBuffer(1) }), false, 'an xp:1 cache without gs still restores (no re-parse)');
    assert.deepEqual(safety.validateGeoCachePayload(Object.assign({}, legacy, { v: 8 })), { valid: true, reason: null });
    const newBytes = v8.serialize(payload).length, oldBytes = v8.serialize(legacyPayload(payload)).length;
    assert.ok(newBytes < oldBytes * 0.75, 'gs:1 record ' + newBytes + ' B vs per-mesh ' + oldBytes + ' B');
  });
}

test('the restored model re-serialises to the same gs:1 payload (stable across park/restore cycles)', () => {
  const api = load(false);
  api.__bake = (m) => { m.updateMatrix(); m.updateMatrixWorld(true); m.matrixAutoUpdate = false; };
  const p1 = api._geoSerialize(makeResult(api, 5), true);
  const p2 = api._geoSerialize(api._geoDeserialize(clone(p1)), true);
  assert.equal(p2.geoData.length, p1.geoData.length);
  assert.equal(v8.serialize(p2.meshData.map((m) => [m.eid, m.gid, m.g, m.col, m.bbox])).toString('hex'),
    v8.serialize(p1.meshData.map((m) => [m.eid, m.gid, m.g, m.col, m.bbox])).toString('hex'));
  assert.equal(JSON.stringify(p2.meshData.map((m) => [m.mtx, m.pqs])), JSON.stringify(p1.meshData.map((m) => [m.mtx, m.pqs])));
  const geoBytes = (p, md) => { const g = p.geoData[md.g]; return [g.pos, g.n8, g.idx].map((b) => Buffer.from(b).toString('base64')).join('/'); };
  p1.meshData.forEach((md, i) => assert.equal(geoBytes(p2, p2.meshData[i]), geoBytes(p1, md)));
});

test('v8 validator: gs:1 references must resolve; legacy quantised and exact payloads stay valid', () => {
  const api = load(true);
  api.__bake = (m) => { m.updateMatrix(); m.updateMatrixWorld(true); m.matrixAutoUpdate = false; };
  const p = api._geoSerialize(makeResult(api, 9), true);
  const dangling = clone(p); dangling.meshData[3].g = dangling.geoData.length;
  assert.equal(safety.validateGeoCachePayload(dangling).valid, false);
  const noGeo = clone(p); delete noGeo.geoData;
  assert.equal(safety.validateGeoCachePayload(noGeo).valid, false);
  const badGeo = clone(p); badGeo.geoData[0].pos = null;
  assert.equal(safety.validateGeoCachePayload(badGeo).valid, false);
  const missing = clone(p); missing.meshData[0].g = 1e9;
  assert.throws(() => api._geoDeserialize(missing), /missing geometry/);
});

// A restore holds what a fresh load holds, without copies (INTERNALS §6
// "Heap after a restore"): every attribute is the plain BufferAttribute class
// the loaders use (the Int8 normals used to be an Int8BufferAttribute, which
// copied each normal array once more), and the position / normal arrays are
// views of the stored buffers rather than copies of them.
test('restore builds loader-class attributes over the stored buffers (no copies)', () => {
  const api = load(true);
  api.__bake = (m) => { m.updateMatrix(); m.updateMatrixWorld(true); m.matrixAutoUpdate = false; };
  const result = makeResult(api, 31);
  const srcKinds = new Set();
  for (const el of result.elements) for (const m of el.meshes) for (const a of ['position', 'normal']) srcKinds.add(a + ':' + m.geometry.attributes[a].constructor.name);
  const stored = clone(api._geoSerialize(result, true));
  const restored = api._geoDeserialize(stored);
  const byBuffer = new Map();
  stored.geoData.forEach((g, i) => { byBuffer.set(g.pos, i); byBuffer.set(g.n8, i); });
  const gotKinds = new Set();
  let geos = 0;
  const seen = new Set();
  for (const el of restored.elements) for (const m of el.meshes) {
    const g = m.geometry;
    for (const a of ['position', 'normal']) gotKinds.add(a + ':' + g.attributes[a].constructor.name);
    if (seen.has(g)) continue; seen.add(g); geos++;
    const n = g.attributes.normal, p = g.attributes.position;
    assert.equal(n.constructor, THREE.BufferAttribute);
    assert.ok(n.array instanceof Int8Array && n.normalized && n.itemSize === 3);
    assert.ok(byBuffer.has(n.array.buffer), 'normal array is a view of the stored n8 buffer');
    assert.ok(byBuffer.has(p.array.buffer), 'position array is a view of the stored pos buffer');
    assert.equal(byBuffer.get(n.array.buffer), byBuffer.get(p.array.buffer));
  }
  assert.equal(geos, stored.geoData.length);
  assert.deepEqual([...gotKinds].sort(), [...srcKinds].sort());
});
