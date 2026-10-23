#!/usr/bin/env node
// Progressive IFC load preview + parallel file loading (safety flags
// progressivePreview / parallelLoad). The preview is DISPLAY ONLY: it must
// show up before the model commits, never enter model state or the model
// group, never be pickable, be torn down at commit, and leave the committed
// model identical to a load without the flags. Cases:
//   1. single file: preview before commit, not in state / S.mg, not hit by a
//      raycast, gone after commit; deep digest == flag-off load
//   2. three files dropped together: parallel parses (> 1 at once), order
//      and every model identical to the sequential load
//   3. cancel mid-preview: preview gone, nothing committed, a reload works
//   4. worker crash mid-stream: preview dropped, main-thread fallback model
//      identical (fingerprint) to the worker model
//   5. replace (same file again): preview while the old model is shown,
//      camera untouched, replaced model identical
//   6. storey-scoped load: identical to the flag-off scoped load
//   7. render-on-demand: idle after the load (no frames while nothing changes)
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/progressive-load.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deepModelDigest, diffDigests } from './model-digest.mjs';

const require = createRequire(import.meta.url);
const { generateBuilding } = require('../fixtures/generate-building-ifc.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const offline = process.env.CC_BROWSER_OFFLINE_DEPS === '1';
const genDir = join(root, 'tests', 'fixtures', '_generated-progressive');
const FLAGS = '?ccSafety=progressivePreview,parallelLoad';
const OFF = '?ccSafety=-progressivePreview,-parallelLoad'; // the reference loader (one file after another, no preview)

let failed = false;
function fail(msg) { console.error('PROGRESSIVE-LOAD FAIL: ' + msg); failed = true; process.exitCode = 1; }
function ok(msg) { console.log('PROGRESSIVE-LOAD OK — ' + msg); }

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

async function openPage(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/forced (crash|fallback)/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  if (offline) {
    const local = async (route, file, ct) => route.fulfill({
      status: 200, body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' },
    });
    const c = page.context();
    await c.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await c.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await c.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await c.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await c.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', (r) => local(r, 'three/' + new URL(r.request().url()).pathname.split('/three@0.180.0/')[1]));
    await c.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', (r) => {
      const s = new URL(r.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
      return local(r, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    });
    await c.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await c.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await c.route('https://gc.zgo.at/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  // Count main-canvas frames (render-on-demand check). WebGLRenderer defines
  // render() per instance, so wrap the constructor.
  await page.addInitScript(() => {
    window.__frames = 0;
    let T;
    Object.defineProperty(window, 'THREE', { configurable: true, get() { return T; }, set(v) {
      T = v; const Orig = v.WebGLRenderer;
      v.WebGLRenderer = class extends Orig { constructor(...a) { super(...a); const r = this.render; this.render = function () { if (this.domElement && this.domElement.width > 400) window.__frames++; return r.apply(this, arguments); }; } };
    } });
  });
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  return page;
}

// Load `urls` (as files named by `names`) in one drop; while loading, record
// what the preview looked like before the first commit. Resolves once every
// model is committed, loading is over and lazy props are merged.
async function loadAndWatch(page, urls, names, opts = {}) {
  return page.evaluate(async ({ urls, names, opts }) => {
    const files = [];
    for (let i = 0; i < urls.length; i++) files.push(new File([await (await fetch(urls[i])).arrayBuffer()], names[i]));
    const before = window._ccLatestState.models.length;
    const pv0 = {}; window._ccLatestState.models.forEach((m) => { pv0[m.name] = m._propsVersion; });
    const S = window._ccState3d;
    const camKey = () => [S.camera.position.x, S.camera.position.y, S.camera.position.z].map((v) => v.toFixed(4)).join(',');
    const cam0 = camKey();
    const seen = { previewBeforeCommit: false, inMg: false, inState: false, picked: false, batches: 0, maxTris: 0 };
    const rc = new window.THREE.Raycaster();
    const probe = () => {
      const pi = window._ccLoadPreview.info();
      seen.batches = Math.max(seen.batches, pi.batches); seen.maxTris = Math.max(seen.maxTris, pi.tris);
      const committed = window._ccLatestState.models.length > before;
      if (pi.inScene && pi.tris > 0 && !committed) {
        seen.previewBeforeCommit = true;
        S.mg.traverse((o) => { if (o.userData && o.userData._ccLoadPreview) seen.inMg = true; });
        if (window._ccLatestState.models.some((m) => (m.meshes || []).some((x) => x.userData && x.userData._ccLoadPreview))) seen.inState = true;
        rc.setFromCamera(new window.THREE.Vector2(0, 0), S.camera);
        if (rc.intersectObjects(S.scene.children, true).some((h) => h.object.userData && h.object.userData._ccLoadPreview)) seen.picked = true;
      }
    };
    const iv = setInterval(probe, 2);
    if (opts.storeys) window.ClashControl.loadFiles(files, { storeys: opts.storeys });
    else window.ClashControl.loadFiles(files);
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const w = setInterval(() => {
        const s = window._ccLatestState;
        const ms = s.models.filter((m) => names.some((n) => m.name === n.replace(/\.ifc$/i, '')));
        if (ms.length === names.length && window._ccModelLoading === false && (opts.noLazyProps || ms.every((m) => m._propsVersion && m._propsVersion !== pv0[m.name]))) { clearInterval(w); resolve(); }
        if (Date.now() - t0 > 180000) { clearInterval(w); reject(new Error('timed out: ' + JSON.stringify(ms.map((m) => m.name)))); }
      }, 20);
    });
    clearInterval(iv);
    await new Promise((r) => setTimeout(r, 2500)); // past the preview teardown grace period
    const pi = window._ccLoadPreview.info();
    let leftInScene = false; S.scene.traverse((o) => { if (o.userData && o.userData._ccLoadPreview) leftInScene = true; });
    return Object.assign(seen, { order: window._ccLatestState.models.map((m) => m.name), after: pi, leftInScene,
      parallelPeak: window._ccLoadPreview.parallelPeak(), camMoved: camKey() !== cam0 });
  }, { urls, names, opts });
}

async function framesWhileIdle(page) {
  return page.evaluate(async () => { const f0 = window.__frames; await new Promise((r) => setTimeout(r, 1500)); return window.__frames - f0; });
}

try {
  await mkdir(genDir, { recursive: true });
  const g = generateBuilding({ scale: 'medium', seed: 4242, georef: 'local' });
  const urls = {};
  for (const k of Object.keys(g.files)) {
    await writeFile(join(genDir, g.fileNames[k]), g.files[k]);
    urls[k] = '/tests/fixtures/_generated-progressive/' + g.fileNames[k];
  }

  // ── 1. single file ──
  {
    const off = await openPage(OFF);
    await loadAndWatch(off, [urls.architecture], ['arch.ifc']);
    const dOff = await off.evaluate(deepModelDigest, 'arch');
    const idleOff = await framesWhileIdle(off);
    await off.close();
    const on = await openPage(FLAGS);
    const w = await loadAndWatch(on, [urls.architecture], ['arch.ifc']);
    const dOn = await on.evaluate(deepModelDigest, 'arch');
    const idleOn = await framesWhileIdle(on);
    await on.close();
    const diffs = diffDigests(dOff, dOn);
    if (!w.previewBeforeCommit || !(w.batches > 1)) fail('[single] no preview before the commit (' + JSON.stringify(w) + ')');
    else if (w.inMg || w.inState || w.picked) fail('[single] preview leaked: ' + JSON.stringify(w));
    else if (w.after.live || w.after.inScene || w.leftInScene) fail('[single] preview not torn down: ' + JSON.stringify(w.after));
    else if (diffs.length) fail('[single] model differs from the flag-off load:\n' + diffs.join('\n'));
    else if (idleOn > idleOff + 2) fail('[single] not idle after load: ' + idleOn + ' frames in 1.5 s (flag off: ' + idleOff + ')');
    else ok('[single] preview drawn before commit (' + w.batches + ' batches, ' + w.maxTris + ' tris), never in state/model group/picks, torn down; ' + dOn.arch.elements + ' elements identical; idle frames ' + idleOn + ' (off ' + idleOff + ')');
  }

  // ── 2. three files in parallel ──
  {
    const names = ['a-arch.ifc', 'b-struct.ifc', 'c-mep.ifc'];
    const list = [urls.architecture, urls.structure, urls.mep];
    const off = await openPage(OFF);
    const wOff = await loadAndWatch(off, list, names);
    const dOff = await off.evaluate(deepModelDigest);
    await off.close();
    const on = await openPage(FLAGS);
    const wOn = await loadAndWatch(on, list, names);
    const dOn = await on.evaluate(deepModelDigest);
    await on.close();
    const diffs = diffDigests(dOff, dOn);
    if (JSON.stringify(wOff.order) !== JSON.stringify(wOn.order)) fail('[multi] model order differs: ' + wOff.order + ' vs ' + wOn.order);
    else if (!(wOn.parallelPeak > 1)) fail('[multi] files did not parse in parallel (peak ' + wOn.parallelPeak + ')');
    else if (diffs.length) fail('[multi] models differ:\n' + diffs.join('\n'));
    else if (wOn.after.live || wOn.leftInScene) fail('[multi] preview not torn down');
    else ok('[multi] 3 files, ' + wOn.parallelPeak + ' parses at once, order ' + wOn.order.join(',') + ', all models identical');
  }

  // ── 3. cancel mid-preview ──
  {
    const on = await openPage(FLAGS);
    const r = await on.evaluate(async (url) => {
      const buf = await (await fetch(url)).arrayBuffer();
      window.ClashControl.loadFiles([new File([buf], 'cancel.ifc')]);
      await new Promise((res, rej) => { const t0 = Date.now(); const w = setInterval(() => { const pi = window._ccLoadPreview.info(); if (pi.tris > 0) { clearInterval(w); res(); } if (Date.now() - t0 > 60000) { clearInterval(w); rej(new Error('no preview')); } }, 2); });
      const committedAtCancel = window._ccLatestState.models.length;
      window._ccAbortLoading();
      const pi = window._ccLoadPreview.info();
      await new Promise((res) => setTimeout(res, 3000));
      return { committedAtCancel, after: pi, models: window._ccLatestState.models.length, loading: window._ccModelLoading, later: window._ccLoadPreview.info() };
    }, urls.architecture);
    if (r.committedAtCancel !== 0) fail('[cancel] model committed before the preview could be cancelled — fixture too small');
    else if (r.after.live || r.after.inScene || r.later.live) fail('[cancel] preview survived the cancel: ' + JSON.stringify(r));
    else if (r.models !== 0 || r.loading !== false) fail('[cancel] cancel left state behind: ' + JSON.stringify(r));
    else {
      const w = await loadAndWatch(on, [urls.architecture], ['after-cancel.ifc']);
      if (!w.previewBeforeCommit || w.after.live) fail('[cancel] reload after cancel misbehaved: ' + JSON.stringify(w));
      else ok('[cancel] preview removed immediately, nothing committed, reload with preview works');
    }
    await on.close();
  }

  // ── 4. worker crash mid-stream → main-thread fallback ──
  {
    const on = await openPage(FLAGS);
    const r = await on.evaluate(async (url) => {
      const Real = window.Worker;
      // A worker that dies after its first geometry batch.
      window.Worker = function (u) {
        const w = new Real(u); let crashed = false; const fake = { postMessage: (m, t) => w.postMessage(m, t), terminate: () => w.terminate(), onmessage: null, onerror: null };
        let geo = 0;
        w.onmessage = (e) => {
          if (crashed) return;
          if (fake.onmessage) fake.onmessage(e);
          if (e.data && e.data.type === 'geo' && window._ccLoadPreview.info().tris > 0) window.__sawPreview = true;
          if (e.data && e.data.type === 'geo' && ++geo === 3) { crashed = true; w.terminate(); setTimeout(() => fake.onerror && fake.onerror({ message: 'forced crash for progressive-load test' }), 0); }
        };
        return fake;
      };
      const buf = await (await fetch(url)).arrayBuffer();
      let sawPreview = false;
      const iv = setInterval(() => { if (window._ccLoadPreview.info().tris > 0) sawPreview = true; }, 2);
      window.ClashControl.loadFiles([new File([buf], 'crash.ifc')]);
      await new Promise((res, rej) => { const t0 = Date.now(); const w = setInterval(() => { const m = window._ccLatestState.models.find((x) => x.name === 'crash'); if (m && window._ccModelLoading === false) { clearInterval(w); res(); } if (Date.now() - t0 > 120000) { clearInterval(w); rej(new Error('fallback never committed')); } }, 20); });
      clearInterval(iv);
      window.Worker = Real;
      await new Promise((res) => setTimeout(res, 2500));
      const m = window._ccLatestState.models.find((x) => x.name === 'crash');
      return { sawPreview: sawPreview || !!window.__sawPreview, preview: window._ccLoadPreview.info(), fp: window._ccSafetyMigrations.modelFingerprint([Object.assign({}, m, { id: 'x' })]) };
    }, urls.architecture);
    // Reference: the same file through the main-thread fallback with the
    // flags off (worker constructor fails up front) — the crash must end in
    // exactly that model. (Worker vs fallback parity itself is the
    // differential harness's job.)
    const ref = await openPage(OFF);
    await ref.evaluate(() => { window.Worker = class { constructor() { throw new Error('forced fallback for progressive-load test'); } }; });
    await loadAndWatch(ref, [urls.architecture], ['crash.ifc'], { noLazyProps: true }); // the fallback reads psets inline
    const fpRef = await ref.evaluate(() => { const m = window._ccLatestState.models.find((x) => x.name === 'crash'); return window._ccSafetyMigrations.modelFingerprint([Object.assign({}, m, { id: 'x' })]); });
    await ref.close(); await on.close();
    if (!r.sawPreview) fail('[crash] the crash happened before any preview was shown');
    else if (r.preview.live || r.preview.inScene) fail('[crash] preview survived the worker crash');
    else if (JSON.stringify(r.fp) !== JSON.stringify(fpRef)) fail('[crash] crash-fallback model differs from a plain fallback load');
    else ok('[crash] worker died mid-stream: preview dropped, fallback model fingerprint-identical to a plain fallback load (' + r.fp.length + ' elements)');
  }

  // ── 5. replace (same file again) ──
  {
    const on = await openPage(FLAGS);
    await loadAndWatch(on, [urls.mep], ['rep.ifc']);
    const d1 = await on.evaluate(deepModelDigest, 'rep');
    const w = await loadAndWatch(on, [urls.mep], ['rep.ifc']);
    const d2 = await on.evaluate(deepModelDigest, 'rep');
    const n = await on.evaluate(() => window._ccLatestState.models.length);
    await on.close();
    const diffs = diffDigests(d1, d2);
    if (n !== 1) fail('[replace] expected one model after re-loading the same file, got ' + n);
    else if (!w.previewBeforeCommit || w.camMoved) fail('[replace] preview missing or camera moved while a model was shown: ' + JSON.stringify({ p: w.previewBeforeCommit, cam: w.camMoved }));
    else if (diffs.length) fail('[replace] replaced model differs:\n' + diffs.join('\n'));
    else ok('[replace] preview over the shown model without moving the camera; replaced model identical');
  }

  // ── 6. storey-scoped load ──
  {
    const storeys = ['Level 1'];
    const off = await openPage(OFF);
    await loadAndWatch(off, [urls.architecture], ['scoped.ifc'], { storeys });
    const dOff = await off.evaluate(deepModelDigest, 'scoped');
    await off.close();
    const on = await openPage(FLAGS);
    const w = await loadAndWatch(on, [urls.architecture], ['scoped.ifc'], { storeys });
    const dOn = await on.evaluate(deepModelDigest, 'scoped');
    const scope = await on.evaluate(() => window._ccLatestState.models[0].stats.loadedScope);
    await on.close();
    const diffs = diffDigests(dOff, dOn);
    if (JSON.stringify(scope) !== JSON.stringify(storeys)) fail('[scoped] not a scoped load: ' + JSON.stringify(scope));
    else if (diffs.length) fail('[scoped] scoped model differs:\n' + diffs.join('\n'));
    else if (w.after.live || w.leftInScene) fail('[scoped] preview not torn down');
    else ok('[scoped] storey-scoped load identical (' + dOn.scoped.elements + ' elements)');
  }

  if (errors.length) fail('page errors: ' + JSON.stringify(errors.slice(0, 8)));
  if (!failed) ok('all cases passed');
} catch (e) {
  fail(String(e && e.stack || e));
} finally {
  await browser.close();
  server.close();
  await rm(genDir, { recursive: true, force: true });
}
