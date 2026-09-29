'use strict';
// addons/tauri-bridge.js against a MOCKED __TAURI_INTERNALS__.invoke.
// The mock speaks the real wire format (engine/src/native.rs `wire`) and is
// backed by the committed WASM Engine, i.e. the very same Rust BVH/Möller code
// the desktop commands run. Proves: inert in the browser; the self-check gate
// (a wrong native answer => nothing is published); results identical to the
// JS reference through the worker-pool-shaped pool; fallback on invoke error;
// unknown ids never masquerade as "no clash".
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const pkgDir = path.join(REPO, 'addons', 'wasm-engine-pkg');
const ADDON = fs.readFileSync(path.join(REPO, 'addons', 'tauri-bridge.js'), 'utf8');

async function loadWasm() {
  const mod = await import(path.join(pkgDir, 'clashcontrol_engine.js'));
  await mod.default(fs.readFileSync(path.join(pkgDir, 'clashcontrol_engine_bg.wasm')));
  return mod;
}

// Same JS-reference extraction as tests/wasm-parity.test.js.
function loadJsReference() {
  const full = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const startIdx = full.indexOf('var _ttIvalA = new Float64Array(8)');
  const endMarkerIdx = full.indexOf('window._ccJsMeshIntersectRef = {');
  const endIdx = full.indexOf('\n  };\n\n  // ── Approximate penetration depth', endMarkerIdx);
  assert.ok(startIdx !== -1 && endMarkerIdx !== -1 && endIdx !== -1, 'JS reference extraction is stale');
  const body = full.slice(startIdx, endIdx + '\n  };'.length);
  const window = { _ccSafetyMigrations: null };
  return new Function('window', '_DETECT_CHUNK_SIZE', '_getWorldTris', '_getBVH', '_bvhLRU',
    body + '; return {ref:window._ccJsMeshIntersectRef,post:_postProcessIntersectPoints,margin:_MI_MARGIN};'
  )(window, 80, () => [], () => null, new Map());
}

function box(x0, x1, y0, y1, z0, z1) {
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const f = [0,1,2, 0,2,3, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 2,3,7, 2,7,6, 1,2,6, 1,6,5, 0,3,7, 0,7,4];
  const t = [];
  f.forEach((i) => t.push(v[i][0], v[i][1], v[i][2]));
  return new Float32Array(t);
}
function el(tris, b) {
  return { tris, box: { min: { x: b[0], y: b[2], z: b[4] }, max: { x: b[1], y: b[3], z: b[5] } } };
}

// Mock of the Tauri command surface on top of the WASM Engine.
function makeMock(wasm, opts) {
  opts = opts || {};
  const eng = new wasm.Engine();
  const calls = [];
  const enc = (results) => {
    const out = [results.length];
    results.forEach((r) => { if (r === undefined) out.push(-1); else { out.push(r.length); for (const x of r) out.push(x); } });
    return new Float64Array(out).buffer;
  };
  const pairsOf = (body) => { const u = new Uint32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)); const p = []; for (let i = 0; i < u.length; i += 2) p.push([u[i], u[i + 1]]); return p; };
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (opts.failCmd === cmd && (opts.failAfter === undefined || calls.filter((c) => c === cmd).length > opts.failAfter)) throw new Error('mock IPC failure in ' + cmd);
    switch (cmd) {
      case 'engine_info': return { api: opts.api || 1, threads: 4, meshes: 0, floats: 0 };
      case 'register_meshes': {
        assert.ok(args instanceof Uint8Array, 'register_meshes must send raw bytes, not JSON');
        const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
        const n = dv.getUint32(0, true);
        let off = 4 + 8 * n;
        for (let i = 0; i < n; i++) {
          const id = dv.getUint32(4 + 8 * i, true), len = dv.getUint32(8 + 8 * i, true);
          eng.register(id, new Float32Array(args.buffer.slice(args.byteOffset + off, args.byteOffset + off + len * 4)));
          off += len * 4;
        }
        assert.strictEqual(off, args.byteLength);
        return n;
      }
      case 'unregister_mesh': return eng.unregister(args.id);
      case 'clear_meshes': eng.clear(); return null;
      case 'intersect_batch': {
        assert.ok(args instanceof Uint8Array);
        const r = pairsOf(args).map(([a, b]) => eng.intersect(a, b));
        return opts.tamper === 'intersect' ? enc(r.map((x) => (x && x.length ? x.map((v, i) => (i === x.length - 1 ? v + 1e-9 : v)) : x))) : enc(r);
      }
      case 'min_dist_batch': {
        const r = pairsOf(args).map(([a, b]) => eng.min_distance(a, b));
        return opts.tamper === 'mindist' ? enc(r.map((x) => (x && x[0] !== Infinity ? x.map((v, i) => (i === 0 ? v * (1 + 1e-12) : v)) : x))) : enc(r);
      }
      default: throw new Error('command not allowed: ' + cmd);
    }
  };
  return { invoke, calls, eng };
}

// Run the addon in a fake window; resolves once it has settled (published or failed).
async function boot(invokeImpl, jsRef, extra) {
  const events = [];
  const win = Object.assign({
    __TAURI_INTERNALS__: invokeImpl ? { invoke: invokeImpl } : undefined,
    _ccJsMeshIntersectRef: jsRef,
    _ccDispatch: (a) => events.push(a),
  }, extra || {});
  const registered = [];
  win._ccRegisterAddon = (d) => registered.push(d);
  new Function('window', ADDON)(win);
  for (let i = 0; i < (invokeImpl ? 400 : 4); i++) {
    if (win._ccNativeNarrow || events.some((e) => e.u && e.u.failed)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { win, events, registered };
}

const ctxFor = (js) => ({ getWorldTris: (e) => e.tris, postProcess: js.post, margin: js.margin });

test('inert in a plain browser: nothing published, nothing registered, no invoke', async () => {
  const js = loadJsReference();
  const { win, registered, events } = await boot(null, js.ref);
  assert.strictEqual(win._ccNativeNarrow, undefined);
  assert.strictEqual(registered.length, 0);
  assert.strictEqual(events.length, 0);
});

test('tauri present but ancient/incompatible API version: not published', async () => {
  const wasm = await loadWasm(), js = loadJsReference();
  const m = makeMock(wasm, { api: 99 });
  const { win, events } = await boot(m.invoke, js.ref);
  assert.strictEqual(win._ccNativeNarrow, undefined);
  assert.ok(events.some((e) => e.u && e.u.failed));
});

test('self-check passes against the JS reference: published, then results equal the JS pipeline', async () => {
  const wasm = await loadWasm(), js = loadJsReference();
  const m = makeMock(wasm);
  const { win, registered, events } = await boot(m.invoke, js.ref);
  assert.ok(win._ccNativeNarrow && typeof win._ccNativeNarrow.createPool === 'function', 'published after a clean self-check');
  assert.strictEqual(registered.length, 1);
  assert.strictEqual(registered[0].id, 'tauri-bridge');
  assert.ok(events.some((e) => e.u && e.u.active === true));
  assert.strictEqual(m.eng.len(), 0, 'self-check meshes are cleaned out of the registry');

  const bx = [
    [box(-1, 21, 2.5, 2.9, -6.9, -6.1), [-1, 21, 2.5, 2.9, -6.9, -6.1]],
    [box(9.925, 10.075, 0, 3.2, -11.85, -0.15), [9.925, 10.075, 0, 3.2, -11.85, -0.15]],
    [box(50, 51, 50, 51, 50, 51), [50, 51, 50, 51, 50, 51]],
    [box(-1, 21, 2.4, 2.6, -0.1, 0.1), [-1, 21, 2.4, 2.6, -0.1, 0.1]],
    [box(9, 11, -1, 5, -1, 1), [9, 11, -1, 5, -1, 1]],
  ].map(([t, b]) => el(t, b));

  const pool = win._ccNativeNarrow.createPool(ctxFor(js));
  assert.ok(pool && !pool.dead && pool.ready);
  await pool.readyP;
  const cidx = [], eA = [], eB = [], fl = [];
  let c = 0;
  for (let i = 0; i < bx.length; i++) for (let j = 0; j < bx.length; j++) {
    cidx.push(c++); eA.push(bx[i]); eB.push(bx[j]); fl.push(3); // hard + soft
  }
  const w = pool.addWindow([{ cidx: cidx.slice(0, 12), eA: eA.slice(0, 12), eB: eB.slice(0, 12), fl: fl.slice(0, 12) },
    { cidx: cidx.slice(12), eA: eA.slice(12), eB: eB.slice(12), fl: fl.slice(12) }]);
  await w.promise;
  assert.strictEqual(w.done, true);
  assert.strictEqual(pool.results.size, cidx.length);
  let hits = 0, softs = 0;
  cidx.forEach((ci, k) => {
    const rec = pool.results.get(ci);
    assert.ok(rec instanceof Float64Array && rec.length === 12);
    const jr = js.ref.intersectRaw(eA[k].tris, eB[k].tris);
    const want = jr ? js.post(jr.pts, jr.depth, eA[k].box, eB[k].box, js.margin) : false;
    assert.strictEqual(rec[0] & 1, 1, 'hard done');
    assert.strictEqual(!!(rec[0] & 2), !!want, 'hard hit flag');
    if (want) { hits++; assert.deepStrictEqual([rec[1], rec[2], rec[3], rec[4]], [want[0], want[1], want[2], want[3]]); }
    else {
      softs++;
      assert.strictEqual(rec[0] & 4, 4, 'soft done when not a hard hit');
      const md = js.ref.minDist(eA[k].tris, eB[k].tris);
      assert.strictEqual(rec[5], md[0]);
      if (md[0] !== Infinity) assert.deepStrictEqual(Array.from(rec.subarray(6, 12)), md.slice(1, 7));
    }
  });
  assert.ok(hits > 0 && softs > 0, 'fixture covers hits and misses (hits=' + hits + ' softs=' + softs + ')');

  // A second window re-uses the registry: no floats are sent again.
  const before = pool.stats.copiedFloats;
  await pool.addWindow([{ cidx: [900], eA: [bx[0]], eB: [bx[1]], fl: [1] }]).promise;
  assert.strictEqual(pool.stats.copiedFloats, before, 'repeat elements are sent as ids, not floats');
  assert.ok(pool.results.has(900));
  pool.terminate('finished');
  assert.strictEqual(pool.dead, true);
  assert.strictEqual(pool.failed, false);
});

test('self-check gate: a wrong native hard result => NOT published', async () => {
  const wasm = await loadWasm(), js = loadJsReference();
  const { win, events } = await boot(makeMock(wasm, { tamper: 'intersect' }).invoke, js.ref);
  assert.strictEqual(win._ccNativeNarrow, undefined);
  assert.ok(events.some((e) => e.u && e.u.failed === true));
  assert.ok(!events.some((e) => e.u && e.u.active === true));
});

test('self-check gate: a 1-ulp-class wrong min-distance => NOT published', async () => {
  const wasm = await loadWasm(), js = loadJsReference();
  const { win } = await boot(makeMock(wasm, { tamper: 'mindist' }).invoke, js.ref);
  assert.strictEqual(win._ccNativeNarrow, undefined);
});

test('no JS reference available: cannot verify => NOT published', async () => {
  const wasm = await loadWasm();
  const m = makeMock(wasm);
  const events = [];
  const win = { __TAURI_INTERNALS__: { invoke: m.invoke }, _ccDispatch: (a) => events.push(a) };
  // shorten the 15s wait for the reference
  const realSetTimeout = global.setTimeout;
  const realNow = Date.now;
  let skew = 0; Date.now = () => realNow() + skew;
  new Function('window', ADDON)(win);
  await new Promise((r) => realSetTimeout(r, 50));
  skew = 20000;
  for (let i = 0; i < 100 && !events.some((e) => e.u && e.u.failed); i++) await new Promise((r) => realSetTimeout(r, 25));
  Date.now = realNow;
  assert.strictEqual(win._ccNativeNarrow, undefined);
  assert.ok(events.some((e) => e.u && e.u.failed));
});

test('invoke error after publish: pool drops (core falls back), window still resolves, native unpublished', async () => {
  const wasm = await loadWasm(), js = loadJsReference();
  // self-check uses 1 intersect_batch call; the 2nd (first real window) fails
  const m = makeMock(wasm, { failCmd: 'intersect_batch', failAfter: 1 });
  const { win } = await boot(m.invoke, js.ref);
  assert.ok(win._ccNativeNarrow, 'published (self-check passed)');
  const pool = win._ccNativeNarrow.createPool(ctxFor(js));
  const e1 = el(box(0, 1, 0, 1, 0, 1), [0, 1, 0, 1, 0, 1]), e2 = el(box(0.5, 2, 0.5, 2, 0.5, 2), [0.5, 2, 0.5, 2, 0.5, 2]);
  const w = pool.addWindow([{ cidx: [0], eA: [e1], eB: [e2], fl: [1] }]);
  await w.promise;
  assert.strictEqual(w.done, true, 'core must never hang on a failed window');
  assert.strictEqual(pool.dead, true);
  assert.strictEqual(pool.failed, true);
  assert.strictEqual(pool.results.size, 0, 'no partial/bogus results are handed to the core');
  assert.strictEqual(win._ccNativeNarrow, undefined, 'native path unpublished for the rest of the session');
  // later windows on the dead pool are no-ops that still resolve
  const w2 = pool.addWindow([{ cidx: [1], eA: [e1], eB: [e2], fl: [1] }]);
  await w2.promise;
  assert.strictEqual(w2.done, true);
});

test('malformed native response (wrong count) drops the pool instead of trusting it', async () => {
  const wasm = await loadWasm(), js = loadJsReference();
  let bad = false;
  const m = makeMock(wasm);
  const inv = async (cmd, args, o) => (bad && cmd === 'intersect_batch' ? new Float64Array([5]).buffer : m.invoke(cmd, args, o));
  const { win } = await boot(inv, js.ref);
  assert.ok(win._ccNativeNarrow);
  bad = true;
  const pool = win._ccNativeNarrow.createPool(ctxFor(js));
  const e1 = el(box(0, 1, 0, 1, 0, 1), [0, 1, 0, 1, 0, 1]);
  await pool.addWindow([{ cidx: [0], eA: [e1], eB: [e1], fl: [1] }]).promise;
  assert.strictEqual(pool.failed, true);
  assert.strictEqual(pool.results.size, 0);
});

test('an id the native side does not know is left to the main thread, never recorded as "no clash"', async () => {
  const wasm = await loadWasm(), js = loadJsReference();
  const m = makeMock(wasm);
  const { win } = await boot(m.invoke, js.ref);
  const pool = win._ccNativeNarrow.createPool(ctxFor(js));
  const e1 = el(box(0, 1, 0, 1, 0, 1), [0, 1, 0, 1, 0, 1]), e2 = el(box(0.5, 2, 0.5, 2, 0.5, 2), [0.5, 2, 0.5, 2, 0.5, 2]);
  await pool.addWindow([{ cidx: [0], eA: [e1], eB: [e2], fl: [1] }]).promise;
  assert.ok(pool.results.has(0));
  m.eng.clear(); // native registry lost behind the bridge's back (e.g. app restart of the engine)
  await pool.addWindow([{ cidx: [1], eA: [e1], eB: [e2], fl: [3] }]).promise;
  assert.ok(!pool.results.has(1), 'unknown id => no record');
  assert.strictEqual(pool.dead, false, 'not a protocol failure');
});
