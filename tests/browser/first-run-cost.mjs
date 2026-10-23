// First-run narrow phase: every execution path gives the SAME clash list.
//
// On a triangle-heavy generated federation (tests/fixtures/generate-building-ifc.js
// with the opt-in `dense` tessellation — architecture + structure + MEP,
// synthetic only), in the real app, a fresh full run (rules.fullRerun, so
// every per-element engine cache is rebuilt) through each of:
//   main      — no worker pool: main-thread WASM Engine, refinement on the
//               BVH exported by the Engine (Engine.bvh_flat)
//   main-js   — same, with the BVH export switched off (JS-built BVHs)
//   pool-1    — worker pool, 1 worker (every job on one worker, in order)
//   pool-3    — worker pool, 3 workers: element-affinity scheduling, two jobs
//               posted ahead per worker, refinement on exported BVHs, the
//               pool started before the broad phase (earlyMinElements)
//   pool-js   — worker pool, 2 workers, JS kernel (no WASM: JS BVH builds)
// must return an identical clash list — every field (points, depth,
// distance, extent, severity, titles, ...) except the per-run id/createdAt,
// in the same order — and the pool runs must really have used the pool.
// Also prints each path's wall time and the pool's summed worker ms.
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/first-run-cost.mjs
//      CC_GEN_SCALE (default 'ci'), CC_GEN_DENSE (metres between vertex rings, default 0.1)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateBuilding } = require(join(root, 'tests/fixtures/generate-building-ifc.js'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

let failures = 0;
function fail(msg) { console.error('FIRST-RUN FAIL: ' + msg); failures++; }
function ok(msg) { console.log('FIRST-RUN OK — ' + msg); }

const gen = generateBuilding({ scale: process.env.CC_GEN_SCALE || 'ci', seed: 4242, georef: 'local', dense: +(process.env.CC_GEN_DENSE || 0.1) });
const KINDS = ['architecture', 'structure', 'mep'];
const files = new Map();
for (const k of KINDS) files.set('/__gen/' + gen.fileNames[k], Buffer.from(gen.files[k]));

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (files.has(p)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(files.get(p)); }
    const file = normalize(join(root, p === '/' ? 'index.html' : p.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE, args: ['--js-flags=--max-old-space-size=8192'] });
const pageErrors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window._ccWasmIntersect === 'function' && !!window._ccWasmEngine, null, { timeout: 30_000 });
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (n) => new File([await (await fetch('/__gen/' + n)).arrayBuffer()], n)));
    window.ClashControl.loadFiles(fs);
  }, KINDS.map((k) => gen.fileNames[k]));
  await page.waitForFunction((n) => {
    const s = window._ccLatestState;
    return s && s.models.length === n && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false;
  }, KINDS.length, { timeout: 300_000, polling: 300 });
  const tris = await page.evaluate(() => window._ccLatestState.models.reduce((n, m) => n + m.elements.reduce((k, e) => k + (e.meshes || []).reduce((q, me) => q + ((me.geometry && me.geometry.index ? me.geometry.index.count : 0) / 3), 0), 0), 0));
  console.log(`generated dense federation: ${gen.stats.products} products, ~${Math.round(tris / 1000)}k triangles`);

  const run = (label, cfg) => page.evaluate(async ({ label, cfg }) => {
    function canon(v) {
      if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
      if (Array.isArray(v)) return v.map(canon);
      const o = {};
      for (const k of Object.keys(v).sort()) { const c = canon(v[k]); if (c !== undefined) o[k] = c; }
      return o;
    }
    const P = window._ccNarrowPool;
    Object.assign(P, { disabled: false, forceJs: false, maxWorkers: 0, minCandidates: 800, earlyMinElements: 3000 }, cfg.pool || {});
    const eng = window._ccWasmEngine, flat = eng.bvhFlat;
    if (cfg.noFlat) eng.bvhFlat = function() { return null; };
    try {
      const t0 = performance.now();
      const res = await window.ClashControl.runDetection({ excludeSameDiscipline: false, selfClashModels: 'none', hard: true, minGap: 0, maxGap: 50, fullRerun: true });
      const ms = performance.now() - t0;
      const mids = window._ccLatestState.models.map((m) => m.id);
      const rows = (res || []).map((c) => { const x = Object.assign({}, c); delete x.id; delete x.createdAt; return JSON.stringify(canon(x)); });
      return { label, ms, rows, mids, pool: P.last ? JSON.parse(JSON.stringify(P.last)) : null, prof: { candidates: window._ccDetectProfile.candidates } };
    } finally {
      eng.bvhFlat = flat;
      Object.assign(P, { disabled: false, forceJs: false, maxWorkers: 0, minCandidates: 800, earlyMinElements: 3000 });
    }
  }, { label, cfg });

  const paths = [
    ['main', { pool: { disabled: true } }],
    ['pool-3', { pool: { maxWorkers: 3, minCandidates: 1, earlyMinElements: 1 } }],
    ['main-js', { pool: { disabled: true }, noFlat: true }],
    ['pool-1', { pool: { maxWorkers: 1, minCandidates: 1, earlyMinElements: 0 } }],
    ['pool-js', { pool: { maxWorkers: 2, minCandidates: 1, forceJs: true } }],
  ];
  const out = [];
  for (const [label, cfg] of paths) out.push(await run(label, cfg));
  const ref = out[0];
  if (ref.rows.length < 50) fail('fixture too small: ' + ref.rows.length + ' clashes');
  console.log(`${ref.prof.candidates} candidate pairs, ${ref.rows.length} clashes`);
  for (const r of out) {
    const pl = r.pool;
    const wm = pl && pl.workerMs ? ` workers ${pl.workers}: hard ${pl.workerMs.hard} / soft ${pl.workerMs.soft} / refine ${pl.workerMs.refine} ms summed, copied ${pl.copiedMB} MB (unique ${pl.uniqueMB} MB)` : '';
    console.log(`  ${r.label.padEnd(8)} ${Math.round(r.ms)} ms${wm}`);
    if (r.label.startsWith('pool') && !(pl && pl.used && !pl.fellBack && pl.pairsDone > 0)) fail(r.label + ': the worker pool did not do the narrow phase: ' + JSON.stringify(pl));
    if (r.label.startsWith('main') && pl && pl.used) fail(r.label + ': expected no worker pool: ' + JSON.stringify(pl));
    if (r === ref) continue;
    const same = r.rows.length === ref.rows.length && r.rows.every((x, i) => x === ref.rows[i]);
    if (!same) {
      const i = r.rows.findIndex((x, k) => x !== ref.rows[k]);
      fail(`${r.label} differs from ${ref.label} (${r.rows.length} vs ${ref.rows.length} rows), first at #${i}: ${String(r.rows[i]).slice(0, 400)} vs ${String(ref.rows[i]).slice(0, 400)}`);
    } else ok(`${r.label} == ${ref.label} (${ref.rows.length} clashes, field for field, in order)`);
  }
  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail('harness error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nfirst-run-cost: all checks passed');
