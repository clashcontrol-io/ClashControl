#!/usr/bin/env node
// Sharded single-file IFC load (safety flag shardedLoad): ONE file parsed by
// several web-ifc workers, merged back on the main thread. The merged model
// must be IDENTICAL to the single-worker load. Synthetic fixtures only.
//   1. identity: sharded (2 and 3 workers) == one worker, deep digest
//      (element order, triangle/index/normal bytes, matrices, colours,
//      instancing keys, props after the lazy merge, volume/area, scene meshes
//      after instancing, not-drawn report, dedup counters); and the main-
//      thread fallback is fingerprint-identical — on the shard fixture
//      (interleaved types, shared shapes, styles, rooms, no-representation
//      elements, an assembly, openings) and on generated building / IFC2X3
//      semantic / space-boundary files
//   2. a failing shard: the load falls back to one worker, same model
//   3. cancel mid-load: every shard worker is terminated, nothing commits,
//      a reload afterwards still works (and is identical)
//   4. timing report (not an assertion): first-load wall time, one worker vs
//      sharded, on the largest synthetic fixture
//
// The size threshold is lowered through the _ccIfcShard knob so small
// fixtures shard. Usage:
//   CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/shard-load.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deepModelDigest, diffDigests } from './model-digest.mjs';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const { generateShardIfc, generateSemanticIfc } = require('../fixtures/generate-synthetic-ifc.js');
const { generateBuilding } = require('../fixtures/generate-building-ifc.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const genDir = join(root, 'tests', 'fixtures', '_generated-shard');
const ON = '?ccSafety=shardedLoad';
const OFF = '?ccSafety=-shardedLoad';

let failed = false;
function fail(msg) { console.error('SHARD-LOAD FAIL: ' + msg); failed = true; process.exitCode = 1; }
function ok(msg) { console.log('SHARD-LOAD OK — ' + msg); }

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    const ct = (p === '/' || p.endsWith('.html')) ? 'text/html' : p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    res.writeHead(200, { 'content-type': ct });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const errors = [];

// opts.shards: knob maxShards (min size 0); opts.failShard: index of the
// shard worker whose start message is broken (worker reports an error).
async function openPage(query, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/forced fallback/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  if (offlineDepsEnabled()) await routeOfflineDeps(page.context(), root);
  // Track every worker (shard accounting, termination on cancel).
  await page.addInitScript((failShard) => {
    const W = window.Worker;
    window.__workers = [];
    window.Worker = class extends W {
      constructor(...a) { super(...a); this.__terminated = false; window.__workers.push(this); }
      terminate() { this.__terminated = true; return super.terminate(); }
      postMessage(msg, xfer) {
        if (failShard != null && msg && msg.shard && msg.shard.k === failShard) {
          msg = Object.assign({}, msg, { file: null, buffer: null }); // the worker answers 'error'
        }
        return super.postMessage(msg, xfer);
      }
    };
  }, opts.failShard == null ? null : opts.failShard);
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  if (opts.shards) await page.evaluate((n) => { window._ccIfcShard.minBytes = 0; window._ccIfcShard.maxShards = n; }, opts.shards);
  if (opts.fallback) await page.evaluate(() => { window.Worker = class { constructor() { throw new Error('forced fallback'); } }; });
  return page;
}

async function loadOne(page, url, name, noLazyProps) {
  return page.evaluate(async ({ url, name, noLazyProps }) => {
    const file = new File([await (await fetch(url)).arrayBuffer()], name);
    let batches = 0;
    const iv = setInterval(() => { const pi = window._ccLoadPreview.info(); if (pi.batches > batches) batches = pi.batches; }, 5);
    const t0 = performance.now();
    window.ClashControl.loadFiles([file]);
    const base = name.replace(/\.ifc$/i, '');
    let committedAt = 0;
    await new Promise((resolve, reject) => {
      const w = setInterval(() => {
        const m = window._ccLatestState.models.find((x) => x.name === base);
        if (m && !committedAt) committedAt = performance.now();
        if (m && window._ccModelLoading === false && (m._propsVersion || noLazyProps)) { clearInterval(w); resolve(); }
        if (performance.now() - t0 > 300000) { clearInterval(w); reject(new Error('timed out loading ' + name)); }
      }, 20);
    });
    clearInterval(iv);
    const m = window._ccLatestState.models.find((x) => x.name === base);
    return { firstLoadMs: Math.round(committedAt - t0), batches, shards: (m.stats && m.stats.shards) || null, elements: m.elements.length,
      notDrawn: m.stats.notDrawn || null, spaces: m.elements.filter((e) => e.props.ifcType === 'IfcSpace' && e.meshes.length).length,
      fingerprint: window._ccSafetyMigrations.modelFingerprint([Object.assign({}, m, { id: 'fixed' })]),
      wasmMB: (() => { let w = 0; const wm = (m.stats.mem && m.stats.mem.worker) || {}; for (const k in wm) if (wm[k] && wm[k].wasm > w) w = wm[k].wasm; return w || null; })(),
      workers: window.__workers ? window.__workers.length : 0, preview: window._ccLoadPreview.info() };
  }, { url, name, noLazyProps: !!noLazyProps });
}

async function digestOf(query, url, name, opts) {
  const page = await openPage(query, opts);
  const meta = await loadOne(page, url, name, opts && opts.fallback); // the main-thread fallback reads psets inline
  const digest = await page.evaluate(deepModelDigest, name.replace(/\.ifc$/i, ''));
  await page.close();
  return { meta, digest };
}

try {
  await mkdir(genDir, { recursive: true });
  const fx = [];
  const put = async (file, text) => { await writeFile(join(genDir, file), text); return '/tests/fixtures/_generated-shard/' + file; };
  fx.push({ name: 'shard fixture', url: await put('shard-fixture.ifc', generateShardIfc({ storeys: 4, perStorey: 300, seed: 3 })), main: true });
  const b = generateBuilding({ scale: 'ci' });
  for (const k of Object.keys(b.files)) fx.push({ name: 'building ' + k, url: await put('building-' + k + '.ifc', b.files[k]) });
  fx.push({ name: 'semantics (IFC2X3 MEP)', url: await put('semantic-vent.ifc', generateSemanticIfc({ kind: 'vent' })) });
  fx.push({ name: 'space boundaries (offset frame)', url: await put('semantic-arch.ifc', generateSemanticIfc({ kind: 'arch', boundaryOffset: [-13374.845, -13743.122, 0] })) });

  // ── 1. identity ──  (SHARD_TIMING_ONLY=1 skips 1-3)
  const only = process.env.SHARD_TIMING_ONLY === '1';
  for (const f of only ? [] : fx) {
    const ref = await digestOf(OFF, f.url, 'shardcase.ifc', {});
    const runs = [['2 shards', await digestOf(ON, f.url, 'shardcase.ifc', { shards: 2 })]];
    if (f.main) runs.push(['3 shards', await digestOf(ON, f.url, 'shardcase.ifc', { shards: 3 })]);
    const fb = await digestOf(OFF, f.url, 'shardcase.ifc', { fallback: true });
    let good = true;
    if (ref.meta.shards) { fail('[' + f.name + '] reference load was sharded'); good = false; }
    for (const [label, r] of runs) {
      const want = +label[0];
      if (!r.meta.shards || r.meta.shards.n !== want) { fail('[' + f.name + '] ' + label + ': sharded path did not run: ' + JSON.stringify(r.meta.shards)); good = false; continue; }
      const d = diffDigests(ref.digest, r.digest);
      if (d.length) { fail('[' + f.name + '] ' + label + ' differs from one worker:\n  ' + d.join('\n  ')); good = false; }
      if (JSON.stringify(r.meta.notDrawn) !== JSON.stringify(ref.meta.notDrawn)) { fail('[' + f.name + '] ' + label + ' not-drawn report differs: ' + JSON.stringify(r.meta.notDrawn) + ' vs ' + JSON.stringify(ref.meta.notDrawn)); good = false; }
      if (!(r.meta.batches > 0)) { fail('[' + f.name + '] ' + label + ': no progressive preview batches'); good = false; }
      if (r.meta.preview.live || r.meta.preview.inScene) { fail('[' + f.name + '] ' + label + ': preview not torn down'); good = false; }
      if (JSON.stringify(r.meta.fingerprint) !== JSON.stringify(fb.meta.fingerprint)) { fail('[' + f.name + '] ' + label + ' not fingerprint-identical to the main-thread fallback'); good = false; }
    }
    if (JSON.stringify(ref.meta.fingerprint) !== JSON.stringify(fb.meta.fingerprint)) { fail('[' + f.name + '] one worker vs fallback fingerprint differs'); good = false; }
    if (f.main) {
      const nd = ref.meta.notDrawn || {};
      if (!(ref.meta.spaces >= 4) || !(nd.byReason && nd.byReason.noRepresentation && nd.byReason.transparent)) { fail('[' + f.name + '] fixture lost coverage: spaces ' + ref.meta.spaces + ', notDrawn ' + JSON.stringify(nd.byReason)); good = false; }
    }
    if (good) ok('[' + f.name + '] ' + runs.map((r) => r[0]).join(' / ') + ' == one worker (deep digest, ' + ref.meta.elements + ' elements' +
      (ref.meta.notDrawn ? ', not drawn ' + JSON.stringify(ref.meta.notDrawn.byReason) : '') + (ref.meta.spaces ? ', ' + ref.meta.spaces + ' rooms' : '') + ') and fingerprint == fallback');
  }

  // ── 2. a failing shard → one worker, same model ──
  if (!only) {
    const main = fx[0];
    const ref = await digestOf(OFF, main.url, 'shardcase.ifc', {});
    const r = await digestOf(ON, main.url, 'shardcase.ifc', { shards: 2, failShard: 1 });
    const d = diffDigests(ref.digest, r.digest);
    if (r.meta.shards) fail('[failing shard] model claims to be sharded');
    else if (d.length) fail('[failing shard] fallback model differs:\n  ' + d.join('\n  '));
    else if (!(r.meta.workers >= 3)) fail('[failing shard] expected 2 shard workers + 1 retry worker, saw ' + r.meta.workers);
    else ok('[failing shard] fell back to one worker, model identical (' + r.meta.workers + ' workers started)');
  }

  // ── 3. cancel mid-load stops every shard ──
  if (!only) {
    const big = await put('shard-cancel.ifc', generateShardIfc({ storeys: 10, perStorey: 1500, seed: 5 }));
    const page = await openPage(ON, { shards: 2 });
    const res = await page.evaluate(async (url) => {
      const file = new File([await (await fetch(url)).arrayBuffer()], 'cancelme.ifc');
      window.ClashControl.loadFiles([file]);
      const t0 = performance.now();
      // wait until both shards are running and streaming
      await new Promise((resolve, reject) => {
        const w = setInterval(() => {
          if (window.__workers.length >= 2 && window._ccLoadPreview.info().batches > 0) { clearInterval(w); resolve(); }
          if (performance.now() - t0 > 120000) { clearInterval(w); reject(new Error('shards never streamed')); }
        }, 10);
      });
      const started = window.__workers.length;
      window._ccAbortLoading();
      await new Promise((r) => setTimeout(r, 1500));
      const coordinator = window._ccRuntime && window._ccRuntime.services.get('loadCoordinator');
      return { started, alive: window.__workers.filter((w) => !w.__terminated).length, committed: window._ccLatestState.models.length,
        loading: window._ccModelLoading, active: coordinator ? coordinator.activeCount() : -1, preview: window._ccLoadPreview.info() };
    }, big);
    if (res.started < 2) fail('[cancel] expected >= 2 shard workers, saw ' + res.started);
    else if (res.alive) fail('[cancel] ' + res.alive + ' worker(s) still alive after cancel');
    else if (res.committed || res.loading || res.active || res.preview.live) fail('[cancel] state after cancel: ' + JSON.stringify(res));
    else ok('[cancel] all ' + res.started + ' shard workers terminated, nothing committed, preview gone');
    // A reload in the same page works and matches a clean one-worker load.
    const again = await loadOne(page, fx[0].url, 'after-cancel.ifc');
    const d1 = await page.evaluate(deepModelDigest, 'after-cancel');
    await page.close();
    const ref = await digestOf(OFF, fx[0].url, 'after-cancel.ifc', {});
    const d = diffDigests(ref.digest, d1);
    if (!again.shards || d.length) fail('[cancel] reload after cancel ' + (again.shards ? 'differs:\n  ' + d.join('\n  ') : 'was not sharded'));
    else ok('[cancel] sharded reload after the cancel is identical to a clean load');
  }

  // ── 4. timing report (not an assertion) ──
  // Two sizes: the gate's threshold (_ccIfcShard.minBytes) sits between
  // "sharding costs more than it saves" and "clearly faster".
  const hc = await (async () => { const p = await browser.newPage(); const h = await p.evaluate(() => navigator.hardwareConcurrency); await p.close(); return h; })();
  for (const [storeys, perStorey] of [[5, 2500], [20, 2500]]) {
    const big = await put('shard-timing.ifc', generateShardIfc({ storeys, perStorey, seed: 9 }));
    const size = (await readFile(join(genDir, 'shard-timing.ifc'))).length;
    const rows = [];
    for (const [label, q, o] of [['one worker', OFF, {}], ['2 shards', ON, { shards: 2 }], ['3 shards', ON, { shards: 3 }]]) {
      const page = await openPage(q, o);
      const r = await loadOne(page, big, 'timing.ifc');
      await page.close();
      rows.push(label.padEnd(11) + ' first load ' + String(r.firstLoadMs).padStart(6) + ' ms' + (r.shards ? '  (merge ' + r.shards.mergeMs + ' ms; per shard open/streamed ' +
        r.shards.perShard.map((p) => p.open + '/' + p.streamed + ' ms').join(', ') + '; web-ifc heap per shard ' +
        r.shards.perShard.map((p) => p.wasmMB + ' MB').join(', ') + ')' : '  (web-ifc heap ' + r.wasmMB + ' MB)'));
    }
    console.log('SHARD-LOAD TIMING — synthetic shard fixture, ' + (size / 1048576).toFixed(1) + ' MB, ' + storeys * perStorey + ' placed elements; navigator.hardwareConcurrency=' + hc);
    rows.forEach((r) => console.log('  ' + r));
  }

  if (errors.length) fail('page errors: ' + JSON.stringify(errors.slice(0, 8)));
} finally {
  await browser.close();
  server.close();
  await rm(genDir, { recursive: true, force: true });
}
if (!failed) console.log('SHARD-LOAD OK — all cases');
