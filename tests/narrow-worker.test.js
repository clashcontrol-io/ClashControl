'use strict';
// The narrow-phase Web Worker (detectWorkerPool) is assembled at runtime from
// the REAL kernel functions in index.html via Function.prototype.toString
// (_ccBuildNarrowWorkerSource). This suite extracts that generator with the
// same source-slicing technique as tests/wasm-parity.test.js, executes the
// generated worker script in a vm sandbox with a fake `self`, and asserts that
// every per-pair record it produces is EXACTLY (===) what the main-thread
// kernel (_meshesIntersect / _meshMinDist JS fallback) returns — in both the
// JS-only worker and the WASM + cached Engine worker. A helper the kernel gains
// but the worker list forgets shows up here as a ReferenceError, not in
// production.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..');
const pkgDir = path.join(REPO, 'addons', 'wasm-engine-pkg');

function loadMainKernel() {
  const full = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const startIdx = full.indexOf('var _ttIvalA = new Float64Array(8)');
  const endMarker = 'window._ccJsMeshIntersectRef = {';
  const endMarkerIdx = full.indexOf(endMarker);
  const fnEndMarker = '\n  };\n\n  // ── Approximate penetration depth';
  const endIdx = full.indexOf(fnEndMarker, endMarkerIdx);
  assert.ok(startIdx !== -1 && endMarkerIdx !== -1 && endIdx !== -1, 'kernel region markers are stale');
  const body = full.slice(startIdx, endIdx + '\n  };'.length);
  const window = { _ccSafetyMigrations: null };
  const getWorldTris = (el) => el._triCache;
  const getBVH = (el) => {
    if (el._bvhCache === undefined) el._bvhCache = fns._buildBVHForTris(el._triCache);
    return el._bvhCache;
  };
  const fns = new Function(
    'window', '_DETECT_CHUNK_SIZE', '_getWorldTris', '_getBVH', '_bvhLRU',
    body + '; return {_buildBVHForTris,_meshesIntersect,_meshMinDist,_ccBuildNarrowWorkerSource};'
  )(window, 80, getWorldTris, getBVH, new Map());
  return fns;
}

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(x0, x1, y0, y1, z0, z1, sub = 1) {
  const t = [];
  const L = (a, b, u) => a + (b - a) * u;
  const quad = (P) => {
    for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++) {
      const f = (u, v) => P(u / sub, v / sub);
      t.push(...f(i, j), ...f(i + 1, j), ...f(i + 1, j + 1), ...f(i, j), ...f(i + 1, j + 1), ...f(i, j + 1));
    }
  };
  quad((u, v) => [L(x0, x1, u), L(y0, y1, v), z0]);
  quad((u, v) => [L(x0, x1, u), L(y0, y1, v), z1]);
  quad((u, v) => [L(x0, x1, u), y0, L(z0, z1, v)]);
  quad((u, v) => [L(x0, x1, u), y1, L(z0, z1, v)]);
  quad((u, v) => [x0, L(y0, y1, u), L(z0, z1, v)]);
  quad((u, v) => [x1, L(y0, y1, u), L(z0, z1, v)]);
  return new Float32Array(t);
}
function cyl(x0, x1, cy, cz, r, seg, rings) {
  const t = [];
  for (let k = 0; k < rings; k++) {
    const xa = x0 + (x1 - x0) * (k / rings), xb = x0 + (x1 - x0) * ((k + 1) / rings);
    for (let s = 0; s < seg; s++) {
      const a = (2 * Math.PI * s) / seg, b = (2 * Math.PI * (s + 1)) / seg;
      const p = (x, ang) => [x, cy + r * Math.cos(ang), cz + r * Math.sin(ang)];
      t.push(...p(xa, a), ...p(xb, a), ...p(xb, b), ...p(xa, a), ...p(xb, b), ...p(xa, b));
    }
  }
  return new Float32Array(t);
}

function boxOf(tris) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let c = 0; c < 3; c++) {
    mn[c] = Math.min(mn[c], tris[i + c]); mx[c] = Math.max(mx[c], tris[i + c]);
  }
  if (!tris.length) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return { min: { x: mn[0], y: mn[1], z: mn[2] }, max: { x: mx[0], y: mx[1], z: mx[2] } };
}

function fixtureMeshes() {
  const rnd = mulberry32(4242);
  const rndF = (lo, hi) => lo + (hi - lo) * rnd();
  const meshes = [
    box(-1, 21, 2.5, 2.9, -6.9, -6.1, 3),        // 0 duct
    box(9.925, 10.075, 0, 3.2, -11.85, -0.15, 3), // 1 wall (crosses 0)
    cyl(-1, 21, 6.5, 2.7, 0.3, 24, 8),           // 2 pipe
    cyl(-1, 21, 6.6, 2.8, 0.3, 24, 8),           // 3 pipe (crosses 2)
    box(-5, 5, -5, 5, -5, 5, 2),                 // 4 big
    box(-1, 1, -1, 1, -1, 1, 2),                 // 5 fully contained in 4 (containment fix path)
    box(0, 1, 0, 1, 0, 1),                       // 6
    box(40, 41, 40, 41, 40, 41),                 // 7 far away (soft + no hit)
    box(1.05, 2, 0, 1, 0, 1),                    // 8 close to 6 (soft gap 0.05)
    new Float32Array(0),                         // 9 empty
    new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),        // 10 single tri
    new Float32Array([0.5, 0.5, 0, 1.5, 0.5, 0, 0.5, 1.5, 0]), // 11 coplanar with 10
  ];
  for (let i = 0; i < 30; i++) {
    const t = [];
    const n = 3 + (i % 9);
    const ox = rndF(-2, 2), oy = rndF(-2, 2), oz = rndF(-2, 2);
    for (let k = 0; k < n * 9; k++) t.push((k % 3 === 0 ? ox : k % 3 === 1 ? oy : oz) + rndF(-1.2, 1.2));
    meshes.push(new Float32Array(t));
  }
  return meshes;
}

// Runs the generated worker script in a real worker_thread (same realm rules
// and structured-clone/transfer behaviour as a browser Worker), with a tiny
// prelude that provides the `self` global the script expects.
function makeWorkerHost(source) {
  const out = [];
  const prelude = [
    "const { parentPort } = require('node:worker_threads');",
    'var self = { postMessage: function(m, x) { parentPort.postMessage(m, x); }, onmessage: null };',
    "parentPort.on('message', function(d) { if (self.onmessage) self.onmessage({ data: d }); });"
  ].join('\n');
  const worker = new Worker(prelude + '\n' + source, { eval: true });
  worker.unref(); // a failing assertion must not leave the test process hanging
  worker.on('message', (m) => out.push(m));
  worker.on('error', (e) => out.push({ t: 'crash', msg: String(e && e.message) }));
  return { out, send: (d) => worker.postMessage(d), close: () => worker.terminate() };
}

async function waitFor(pred, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function runMode(useWasm) {
  const k = loadMainKernel();
  const src = k._ccBuildNarrowWorkerSource();
  const host = makeWorkerHost(src);
  if (useWasm) {
    host.send({
      t: 'init',
      wasmJs: pathToFileURL(path.join(pkgDir, 'clashcontrol_engine.js')).href,
      wasmBin: fs.readFileSync(path.join(pkgDir, 'clashcontrol_engine_bg.wasm')),
      useEngine: true
    });
  } else {
    host.send({ t: 'init' });
  }
  await waitFor(() => host.out.some((m) => m.t === 'ready'));
  const ready = host.out.find((m) => m.t === 'ready');
  if (useWasm) {
    assert.strictEqual(ready.wasm, true, 'worker WASM self-check must pass: ' + ready.err);
    assert.strictEqual(ready.engine, true, 'worker cached Engine must be trusted');
  } else {
    assert.strictEqual(ready.wasm, false);
  }

  const meshes = fixtureMeshes();
  const els = meshes.map((tris, i) => ({ id: i + 1, tris, box: boxOf(tris), _triCache: tris }));
  els.forEach((e) => { e.boxArr = new Float64Array([e.box.min.x, e.box.min.y, e.box.min.z, e.box.max.x, e.box.max.y, e.box.max.z]); });
  // all ordered pairs (both argument orders matter for the kernel), flags: hard + soft
  const pairIdx = [];
  for (let a = 0; a < els.length; a++) for (let b = 0; b < els.length; b++) if (a !== b) pairIdx.push([a, b]);

  let jobId = 0;
  const results = [];
  // job 1 adds every element; job 2 reuses the cached ones with different flags; job 3 drops + re-adds a few
  const runJob = async (pairs, flagsFn, add, drop) => {
    const id = ++jobId;
    const arr = new Int32Array(pairs.length * 3);
    pairs.forEach(([a, b], i) => { arr[i * 3] = els[a].id; arr[i * 3 + 1] = els[b].id; arr[i * 3 + 2] = flagsFn(a, b); });
    host.send({ t: 'job', id, drop: drop || [], add: (add || []).map((e) => ({ id: e.id, tris: e.tris.slice(), box: e.boxArr })), pairs: arr });
    await waitFor(() => host.out.some((m) => (m.t === 'result' || m.t === 'error') && m.id === id));
    const m = host.out.find((mm) => (mm.t === 'result' || mm.t === 'error') && mm.id === id);
    assert.strictEqual(m.t, 'result', 'job failed: ' + m.msg);
    assert.strictEqual(m.res.length, pairs.length * 12);
    results.push(m.res);
    return m.res;
  };

  let hardHits = 0, softFinite = 0, contained = 0;
  const verify = (pairs, res, flagsFn) => {
    pairs.forEach(([a, b], i) => {
      const fl = flagsFn(a, b), o = i * 12;
      const eA = els[a], eB = els[b];
      let hard = false;
      if (fl & 1) {
        hard = k._meshesIntersect(eA, eB);
        assert.strictEqual((res[o] & 1) !== 0, true, `pair ${a},${b}: hard must be done`);
        assert.strictEqual((res[o] & 2) !== 0, !!hard, `pair ${a},${b}: hard hit mismatch`);
        if (hard) {
          hardHits++;
          for (let c = 0; c < 4; c++) assert.strictEqual(res[o + 1 + c], hard[c], `pair ${a},${b}: hard[${c}]`);
        }
      } else assert.strictEqual(res[o] & 3, 0);
      if ((fl & 2) && !hard) {
        const out = [0, 0, 0, 0, 0, 0];
        const d = k._meshMinDist(eA, eB, 0.1, out);
        assert.strictEqual((res[o] & 4) !== 0, true, `pair ${a},${b}: soft must be done`);
        assert.strictEqual(res[o + 5], d, `pair ${a},${b}: distance`);
        if (d !== Infinity) {
          softFinite++;
          if (d === 0) contained++;
          for (let c = 0; c < 6; c++) assert.strictEqual(res[o + 6 + c], out[c], `pair ${a},${b}: closest pair[${c}]`);
        }
      } else {
        assert.strictEqual((res[o] & 4), 0, `pair ${a},${b}: soft must NOT be computed when hard hit / not requested`);
      }
    });
  };

  const both = () => 3;
  const r1 = await runJob(pairIdx, both, els);
  verify(pairIdx, r1, both);
  const hardOnly = (a, b) => ((a + b) % 3 === 0 ? 2 : 1); // soft-only for a third, hard-only for the rest
  const r2 = await runJob(pairIdx, hardOnly, []); // no add: relies on the per-worker element cache
  verify(pairIdx, r2, hardOnly);
  // drop two elements and re-add them: the cache must forget them exactly
  const r3 = await runJob(pairIdx.slice(0, 200), both, [els[0], els[4]], [els[0].id, els[4].id]);
  verify(pairIdx.slice(0, 200), r3, both);
  // a job that references an element the worker does not hold must fail loudly (main falls back)
  const badId = ++jobId;
  host.send({ t: 'job', id: badId, drop: [els[1].id], add: [], pairs: new Int32Array([els[1].id, els[2].id, 1]) });
  await waitFor(() => host.out.some((m) => m.id === badId));
  assert.strictEqual(host.out.find((m) => m.id === badId).t, 'error');

  host.close();
  assert.ok(hardHits > 40, `fixture must produce real hard hits (${hardHits})`);
  assert.ok(softFinite > 100, `fixture must produce real distances (${softFinite})`);
  assert.ok(contained > 0, 'fixture must exercise distance-0 pairs');
  return { pairs: pairIdx.length, hardHits, softFinite };
}

test('narrow worker (JS reference kernel) === main-thread kernel, exact, incl. element cache + drop', async () => {
  const r = await runMode(false);
  assert.ok(r.pairs > 1000);
});

test('narrow worker (WASM + cached Engine) === main-thread kernel, exact', async () => {
  const r = await runMode(true);
  assert.ok(r.pairs > 1000);
});

test('generated worker source is self-contained (no reference to main-thread-only state)', () => {
  const k = loadMainKernel();
  const src = k._ccBuildNarrowWorkerSource();
  for (const forbidden of ['window.', '_getWorldTris', '_getBVH(', 'document.', 'THREE']) {
    assert.ok(!src.includes(forbidden), 'worker source must not reference ' + forbidden);
  }
  assert.ok(src.includes('function _triTriTest') && src.includes('function _bvhMinDistTraverse'));
});
