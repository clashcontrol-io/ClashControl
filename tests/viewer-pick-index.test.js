'use strict';
// viewer-pick-index.js: scene-level BVH over world boxes of meshes /
// InstancedMesh instances / BatchedMesh instances. Every query must equal the
// full-scene three.js raycast (+ filter) exactly: same hits, same fields,
// same order — including ties at equal distance (three's stable order).
const { test } = require('node:test');
const assert = require('node:assert');
const THREE = require('three');
const PI = require('../viewer-pick-index.js');
const VP = require('../viewer-pick-core.js');

// Deterministic PRNG.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function randMatrix(r, spread) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 6.3, r() * 6.3, r() * 6.3));
  const p = new THREE.Vector3((r() - 0.5) * spread, (r() - 0.5) * spread, (r() - 0.5) * spread);
  const sc = r() < 0.2 ? new THREE.Vector3(0.2 + r() * 3, 0.2 + r() * 3, 0.2 + r() * 3) : new THREE.Vector3(1, 1, 1);
  if (r() < 0.3) q.identity(); // axis-aligned elements are the common case
  return m.compose(p, q, sc);
}

function randGeo(r) {
  const k = r();
  if (k < 0.5) return new THREE.BoxGeometry(0.1 + r() * 4, 0.1 + r() * 3, 0.05 + r() * 0.5); // walls / slabs, indexed
  if (k < 0.7) return new THREE.BoxGeometry(0.2 + r() * 8, 0.1, 0.1).toNonIndexed(); // long thin members
  if (k < 0.85) return new THREE.CylinderGeometry(0.1 + r() * 0.3, 0.1 + r() * 0.3, 1 + r() * 4, 8);
  return new THREE.PlaneGeometry(1 + r() * 3, 1 + r() * 3); // single-sided faces
}

const ghostMat = new THREE.MeshBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.08 });
const isGhost = (m) => m === ghostMat;

// A small federation: models (groups) of plain meshes, instanced meshes and
// batched meshes, with exact duplicates (ties) sprinkled in.
function buildScene(seed, opts = {}) {
  const r = rng(seed);
  const root = new THREE.Group();
  const spread = opts.spread || 30;
  const nModels = opts.models || 3;
  const mats = [new THREE.MeshPhongMaterial({ side: THREE.DoubleSide }), new THREE.MeshPhongMaterial({ side: THREE.FrontSide })];
  for (let mi = 0; mi < nModels; mi++) {
    const grp = new THREE.Group();
    grp.userData.modelId = 'm' + mi;
    const nMesh = opts.meshes || 40;
    let prev = null;
    for (let i = 0; i < nMesh; i++) {
      let mesh;
      if (prev && r() < 0.1) {
        mesh = new THREE.Mesh(prev.geometry, prev.material); // exact duplicate → equal distances
        mesh.matrix.copy(prev.matrix);
      } else {
        mesh = new THREE.Mesh(randGeo(r), mats[r() < 0.8 ? 0 : 1]);
        mesh.matrix.copy(randMatrix(r, spread));
      }
      mesh.matrixAutoUpdate = false;
      mesh.userData.expressId = mi * 1000 + i;
      if (r() < 0.05) mesh.layers.set(3); // rooms-style layer
      grp.add(mesh);
      prev = mesh;
    }
    // InstancedMesh
    const ig = randGeo(r), n = 12 + Math.floor(r() * 20);
    const im = new THREE.InstancedMesh(ig, mats[0], n);
    for (let k = 0; k < n; k++) im.setMatrixAt(k, k > 0 && r() < 0.1 ? (() => { const t = new THREE.Matrix4(); im.getMatrixAt(k - 1, t); return t; })() : randMatrix(r, spread));
    im.userData.instanceExprIds = Array.from({ length: n }, (_, k) => mi * 1000 + 500 + k);
    grp.add(im);
    // BatchedMesh with a few geometries, some instances sharing geometry
    const bm = new THREE.BatchedMesh(60, 20000, 60000, mats[0]);
    bm.userData._isCCBatch = true;
    const gids = [];
    for (let g = 0; g < 4; g++) { const geo = randGeo(r); let gg = geo; if (!gg.index) { gg = gg.clone(); gg.setIndex(Array.from({ length: gg.attributes.position.count }, (_, q) => q)); } gids.push(bm.addGeometry(gg)); }
    const nb = 20 + Math.floor(r() * 25);
    let prevM = null;
    for (let k = 0; k < nb; k++) {
      const id = bm.addInstance(gids[Math.floor(r() * gids.length)]);
      const m = prevM && r() < 0.1 ? prevM : randMatrix(r, spread);
      bm.setMatrixAt(id, m);
      prevM = m;
    }
    grp.add(bm);
    root.add(grp);
  }
  root.updateMatrixWorld(true);
  return root;
}

function randRay(r, spread, ortho) {
  const rc = new THREE.Raycaster();
  const o = new THREE.Vector3((r() - 0.5) * spread * 1.6, (r() - 0.5) * spread * 1.6, (r() - 0.5) * spread * 1.6);
  const tgt = new THREE.Vector3((r() - 0.5) * spread * 0.8, (r() - 0.5) * spread * 0.8, (r() - 0.5) * spread * 0.8);
  let d = tgt.sub(o).normalize();
  if (ortho) { // axis-aligned direction (zero components) like a top / front view
    const ax = Math.floor(r() * 3), s = r() < 0.5 ? -1 : 1;
    d = new THREE.Vector3(ax === 0 ? s : 0, ax === 1 ? s : 0, ax === 2 ? s : 0);
  }
  rc.set(o, d);
  if (r() < 0.2) { rc.near = r() * 5; rc.far = rc.near + r() * spread; }
  return rc;
}

function key(h) {
  if (!h) return null;
  return {
    object: h.object.uuid, instanceId: h.instanceId, batchId: h.batchId, faceIndex: h.faceIndex,
    distance: h.distance, point: [h.point.x, h.point.y, h.point.z],
    face: h.face ? [h.face.a, h.face.b, h.face.c, h.face.materialIndex, h.face.normal.x, h.face.normal.y, h.face.normal.z] : null,
  };
}
const keys = (hs) => hs.map(key);

function visPreds(planes) {
  return {
    accept: (h) => VP.isHitVisible(h, { planes, isGhost }),
    skip: (o) => { for (let a = o; a; a = a.parent) if (a.visible === false) return true; return isGhost(o.material); },
  };
}

function compareAll(idx, root, r, nRays, spread, label, planes) {
  let ties = 0;
  for (let i = 0; i < nRays; i++) {
    const rc = randRay(r, spread, i % 5 === 0);
    if (i % 7 === 0) rc.layers.set(3);
    const brute = rc.intersectObjects(root.children, true);
    for (let j = 1; j < brute.length; j++) if (brute[j].distance === brute[j - 1].distance) ties++;
    const got = idx.intersect(rc, root);
    assert.deepStrictEqual(keys(got), keys(brute), `${label}: intersect ray ${i}`);
    const preds = [{}, visPreds(planes)];
    const want = idx.bruteFirst(rc, root, preds);
    const first = idx.first(rc, root, preds);
    assert.deepStrictEqual(first.map(key), want.map(key), `${label}: first ray ${i}`);
    // firstVisibleHit over the brute list is the reference the app used.
    assert.deepStrictEqual(key(first[1]), key(VP.firstVisibleHit(brute, { planes, isGhost })), `${label}: firstVisibleHit ray ${i}`);
  }
  return ties;
}

test('fuzz: intersect / first equal the full-scene raycast (incl. ties, layers, near/far, axis rays)', () => {
  const idx = PI.create(THREE);
  let ties = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const root = buildScene(seed);
    ties += compareAll(idx, root, rng(seed * 101), 400, 30, 'seed ' + seed, null);
  }
  assert.ok(ties > 0, 'fixtures produce equal-distance ties');
});

test('dense rays through the middle (most rays hit) + ties are resolved in three order', () => {
  const idx = PI.create(THREE);
  const root = buildScene(42, { spread: 10, meshes: 60 });
  const r = rng(7);
  let hits = 0;
  for (let i = 0; i < 1500; i++) {
    const rc = randRay(r, 10, i % 3 === 0);
    const brute = rc.intersectObjects(root.children, true);
    if (brute.length) hits++;
    assert.deepStrictEqual(keys(idx.intersect(rc, root)), keys(brute), 'ray ' + i);
    assert.deepStrictEqual(key(idx.first(rc, root, [{}])[0]), key(brute[0] || null), 'first ray ' + i);
  }
  assert.ok(hits > 1000, 'most rays hit: ' + hits);
});

test('visibility, ghosting, clipping, hidden groups, batch/instance hiding are read at query time', () => {
  const idx = PI.create(THREE);
  const root = buildScene(9, { spread: 12 });
  const r = rng(99);
  const planes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.5)]; // keep y <= 1.5
  compareAll(idx, root, r, 200, 12, 'plain', null);
  // hide a model, ghost a few meshes, hide batch instances, zero-scale instances
  root.children[0].visible = false;
  root.children[1].children.slice(0, 15).forEach((m) => { if (m.isMesh && !m.isInstancedMesh && !m.isBatchedMesh) m.material = ghostMat; });
  root.children[1].children.slice(15, 25).forEach((m) => { m.visible = false; });
  const bm = root.children[2].children.find((o) => o.isBatchedMesh);
  for (let i = 0; i < 10; i++) bm.setVisibleAt(i, false);
  const im = root.children[2].children.find((o) => o.isInstancedMesh);
  for (let i = 0; i < 5; i++) im.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
  im.instanceMatrix.needsUpdate = true;
  compareAll(idx, root, r, 300, 12, 'states', planes);
  const st = idx.stats();
  assert.ok(st.refits >= 1, 'instance matrix change refits');
});

test('sync: model add / remove / replace, ghost split-outs, moves, batch edits, instance restore', () => {
  const idx = PI.create(THREE);
  const root = buildScene(5, { spread: 15 });
  const r = rng(555);
  compareAll(idx, root, r, 100, 15, 'initial', null);
  const b0 = idx.stats().builds;
  compareAll(idx, root, r, 50, 15, 'no-op', null);
  assert.strictEqual(idx.stats().builds, b0, 'no rebuild when nothing changed');

  // remove a model, add another (park / restore, unload / load)
  const removed = root.children[1];
  root.remove(removed);
  root.add(buildScene(77, { spread: 15, models: 1 }).children[0]);
  root.updateMatrixWorld(true);
  compareAll(idx, root, r, 150, 15, 'add/remove', null);
  // re-add the removed one in the middle (replace keeps order elsewhere)
  root.children.splice(1, 0, removed); removed.parent = root; // order change without events
  root.updateMatrixWorld(true);
  compareAll(idx, root, r, 150, 15, 'reorder', null);

  // ghost split-out: a new mesh added to a model group
  const g = root.children[0];
  const extra = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), new THREE.MeshPhongMaterial());
  extra.matrix.makeTranslation(1, 1, 1); extra.matrixAutoUpdate = false;
  g.add(extra); root.updateMatrixWorld(true);
  compareAll(idx, root, r, 150, 15, 'split-out add', null);
  g.remove(extra);
  compareAll(idx, root, r, 100, 15, 'split-out remove', null);

  // move a whole model group
  g.position.set(3, -2, 1); root.updateMatrixWorld(true);
  compareAll(idx, root, r, 150, 15, 'group moved', null);

  // a non-baked mesh moves on its own
  const live = root.children[2].children[0];
  live.matrixAutoUpdate = true; idx.invalidate();
  compareAll(idx, root, r, 20, 15, 'live mesh', null);
  live.position.set(2, 2, 2); root.updateMatrixWorld(true);
  compareAll(idx, root, r, 150, 15, 'live mesh moved', null);

  // instanced: hide then restore an instance; count change
  const im = root.children[0].children.find((o) => o.isInstancedMesh);
  const keep = new THREE.Matrix4(); im.getMatrixAt(0, keep);
  im.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0)); im.instanceMatrix.needsUpdate = true;
  compareAll(idx, root, r, 100, 15, 'instance hidden', null);
  im.setMatrixAt(0, keep); im.instanceMatrix.needsUpdate = true;
  compareAll(idx, root, r, 100, 15, 'instance restored', null);
  im.count = Math.max(1, im.count - 3);
  compareAll(idx, root, r, 100, 15, 'instance count', null);

  // batched: move an instance, delete one, add one
  const bm = root.children[0].children.find((o) => o.isBatchedMesh);
  bm.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, 0));
  compareAll(idx, root, r, 100, 15, 'batch moved', null);
  bm.deleteInstance(2);
  compareAll(idx, root, r, 100, 15, 'batch deleted', null);
  const nid = bm.addInstance(0); bm.setMatrixAt(nid, new THREE.Matrix4().makeTranslation(1, 0, 0));
  compareAll(idx, root, r, 100, 15, 'batch added', null);
});

test('always-test objects (lines, points, custom raycast) keep three order', () => {
  const idx = PI.create(THREE);
  const root = buildScene(13, { spread: 8, models: 2 });
  const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-5, 0, 0), new THREE.Vector3(5, 0, 0)]);
  const line = new THREE.Line(lg, new THREE.LineBasicMaterial());
  root.children[0].add(line);
  const pts = new THREE.Points(lg, new THREE.PointsMaterial());
  root.children[1].children[3].add(pts); // child of a mesh
  const custom = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  custom.raycast = function(rc, out) { THREE.Mesh.prototype.raycast.call(this, rc, out); };
  root.children[1].add(custom);
  root.updateMatrixWorld(true);
  compareAll(idx, root, rng(3), 400, 8, 'always', null);
  assert.ok(idx.stats().always >= 3);
});

test('restricting to one object equals intersectObject(obj, false)', () => {
  const idx = PI.create(THREE);
  const root = buildScene(21, { spread: 10 });
  const r = rng(21);
  const objs = [];
  root.traverse((o) => { if (o.isMesh) objs.push(o); });
  for (let i = 0; i < 300; i++) {
    const rc = randRay(r, 10, false);
    const obj = objs[Math.floor(r() * objs.length)];
    assert.ok(idx.indexes(obj) || true);
    const got = idx.first(rc, root, [{ skip: (o) => o !== obj }])[0];
    assert.deepStrictEqual(key(got), key(rc.intersectObject(obj, false)[0] || null), 'ray ' + i);
  }
});

test('candidate count is a small fraction of the scene on a large grid', () => {
  const idx = PI.create(THREE);
  const root = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.9, 3, 0.9), mat = new THREE.MeshPhongMaterial();
  for (let m = 0; m < 4; m++) {
    const g = new THREE.Group();
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(i + m * 50, 0, j); mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
      g.add(mesh);
    }
    root.add(g);
  }
  root.updateMatrixWorld(true);
  const rc = new THREE.Raycaster(new THREE.Vector3(20.3, 50, 20.1), new THREE.Vector3(0, -1, 0));
  const h = idx.first(rc, root, [{}])[0];
  assert.deepStrictEqual(key(h), key(rc.intersectObjects(root.children, true)[0]));
  const st = idx.stats();
  assert.strictEqual(st.entries, 6400);
  assert.ok(st.lastQueryCandidates <= 4, 'candidates ' + st.lastQueryCandidates);
});

test('rayBox: zero direction components, inside origin, near/far', () => {
  const b = new Float32Array([0, 0, 0, 1, 1, 1]);
  assert.strictEqual(PI.rayBox(b, 0, 0.5, 0.5, -1, 0, 0, 1, Infinity, Infinity, 1, Infinity), 1);
  assert.strictEqual(PI.rayBox(b, 0, 2, 0.5, -1, 0, 0, 1, Infinity, Infinity, 1, Infinity), -1);
  assert.strictEqual(PI.rayBox(b, 0, 0.5, 0.5, 0.5, 0, 0, 1, Infinity, Infinity, 1, Infinity), 0);
  assert.strictEqual(PI.rayBox(b, 0, 0.5, 0.5, -1, 0, 0, 1, Infinity, Infinity, 1, 0.5), -1);
});
