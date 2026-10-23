// Clearance (min-distance) narrow phase: cost + identity across every path.
//
// A clearance-heavy generated federation (tests/fixtures/generate-building-ifc.js
// with the opt-in `dense` tessellation and `nearMiss` field, synthetic only) is loaded into the real
// app and a fresh full run (rules.fullRerun) with a clearance tolerance is
// repeated through each execution path:
//   main      — no worker pool: main-thread WASM Engine
//   pool-3    — worker pool, 3 workers (WASM Engine in each worker)
//   main-js   — no worker pool, no WASM (pure JS kernel)
//   pool-js   — worker pool, 2 workers, JS kernel
// Every path must return the identical clash list (every field except the
// per-run id/createdAt, in order). Prints, per path, the median wall time,
// the summed worker ms (hard / clearance / refinement) and the clearance
// counters of the run profile.
//
// CC_DUMP=<file> writes the reference rows (JSON lines) so two builds can be
// diffed field for field (CC_ROOT=<dir> serves another checkout's app).
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/clearance-cost.mjs
//      CC_GEN_SCALE (default 'ci'), CC_GEN_DENSE (default 0.1), CC_NEARMISS (near-miss
//      field size n x n, default 30), CC_KINDS
//      (default 'structure,mep'), CC_MAXGAP mm (default 100), CC_REPS (default 1),
//      CC_PATHS (comma list, default all), CC_TYPE_TOL (JSON rules.toleranceByTypePair, mm)
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL('../..', import.meta.url));
const root = process.env.CC_ROOT ? resolve(process.env.CC_ROOT) : here;
const { generateBuilding } = require(join(here, 'tests/fixtures/generate-building-ifc.js'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

let failures = 0;
function fail(msg) { console.error('CLEARANCE-COST FAIL: ' + msg); failures++; }
function ok(msg) { console.log('CLEARANCE-COST OK — ' + msg); }
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : NaN; };

const gen = generateBuilding({ scale: process.env.CC_GEN_SCALE || 'ci', seed: 4242, georef: 'local', dense: +(process.env.CC_GEN_DENSE || 0.1), nearMiss: +(process.env.CC_NEARMISS || 30) });
const KINDS = (process.env.CC_KINDS || 'structure,mep').split(',');
const MAXGAP = +(process.env.CC_MAXGAP || 100);
const REPS = Math.max(1, +(process.env.CC_REPS || 1));
const TYPE_TOL = process.env.CC_TYPE_TOL ? JSON.parse(process.env.CC_TYPE_TOL) : null; // rules.toleranceByTypePair (mm)
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
  }, KINDS.length, { timeout: 600_000, polling: 300 });
  const tris = await page.evaluate(() => window._ccLatestState.models.reduce((n, m) => n + m.elements.reduce((k, e) => k + (e.meshes || []).reduce((q, me) => q + ((me.geometry && me.geometry.index ? me.geometry.index.count : 0) / 3), 0), 0), 0));
  console.log(`generated dense federation (${KINDS.join('+')}): ${gen.stats.products} products, ~${Math.round(tris / 1000)}k triangles, clearance ${MAXGAP} mm`);

  const run = (label, cfg) => page.evaluate(async ({ label, cfg, maxGap, typeTol }) => {
    function canon(v) {
      if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
      if (Array.isArray(v)) return v.map(canon);
      const o = {};
      for (const k of Object.keys(v).sort()) { const c = canon(v[k]); if (c !== undefined) o[k] = c; }
      return o;
    }
    const P = window._ccNarrowPool;
    const base = { disabled: false, forceJs: false, maxWorkers: 0, minCandidates: 800, earlyMinElements: 3000 };
    Object.assign(P, base, cfg.pool || {});
    const savedI = window._ccWasmIntersect, savedM = window._ccWasmMinDist, savedE = window._ccWasmEngine;
    if (cfg.noWasm) { delete window._ccWasmIntersect; delete window._ccWasmMinDist; delete window._ccWasmEngine; }
    try {
      const t0 = performance.now();
      const res = await window.ClashControl.runDetection({ excludeSameDiscipline: false, selfClashModels: 'none', hard: true, minGap: 0, maxGap, fullRerun: true, toleranceByTypePair: typeTol || {} });
      const ms = performance.now() - t0;
      // model ids are random per load: name them by load order so two builds compare
      const mids = window._ccLatestState.models.map((m) => m.id);
      const rows = (res || []).map((c) => { const x = Object.assign({}, c); delete x.id; delete x.createdAt; let j = JSON.stringify(canon(x)); mids.forEach((id, i) => { j = j.split(JSON.stringify(id)).join('"M' + i + '"'); }); return j; });
      const pr = window._ccDetectProfile || {};
      return { label, ms, rows, pool: P.last ? JSON.parse(JSON.stringify(P.last)) : null,
        prof: { candidates: pr.candidates, soft_tests: pr.soft_tests, soft_tests_pooled: pr.soft_tests_pooled, soft_ms: pr.soft_clash_ms, hard_ms: pr.hard_clash_ms, soft_dismissed: pr.soft_dismissed, pairs_dismissed: pr.pairs_dismissed } };
    } finally {
      if (cfg.noWasm) { window._ccWasmIntersect = savedI; window._ccWasmMinDist = savedM; window._ccWasmEngine = savedE; }
      Object.assign(P, base);
    }
  }, { label, cfg, maxGap: MAXGAP, typeTol: TYPE_TOL });

  const ALL = [
    ['main', { pool: { disabled: true } }],
    ['pool-3', { pool: { maxWorkers: 3, minCandidates: 1, earlyMinElements: 1 } }],
    ['main-js', { pool: { disabled: true }, noWasm: true }],
    ['pool-js', { pool: { maxWorkers: 2, minCandidates: 1, forceJs: true } }],
  ];
  const want = process.env.CC_PATHS ? new Set(process.env.CC_PATHS.split(',')) : null;
  const paths = ALL.filter(([l]) => !want || want.has(l));
  const out = [];
  for (const [label, cfg] of paths) {
    const reps = [];
    for (let i = 0; i < REPS; i++) reps.push(await run(label, cfg));
    out.push(reps);
  }
  const ref = out[0][0];
  console.log(`${ref.prof.candidates} candidate pairs, ${ref.rows.length} clashes (${ref.rows.filter((r) => r.includes('"type":"soft"')).length} soft)`);
  for (const reps of out) {
    const r = reps[0];
    const ms = median(reps.map((x) => x.ms));
    const wm = reps.filter((x) => x.pool && x.pool.workerMs);
    const w = wm.length ? ` workers ${r.pool.workers}: hard ${median(wm.map((x) => x.pool.workerMs.hard))} / clearance ${median(wm.map((x) => x.pool.workerMs.soft))} / refine ${median(wm.map((x) => x.pool.workerMs.refine))} ms summed` : '';
    console.log(`  ${r.label.padEnd(8)} wall ${Math.round(ms)} ms (median of ${reps.length})${w}; clearance tests ${r.prof.soft_tests} (pooled ${r.prof.soft_tests_pooled}), main-thread clearance ${median(reps.map((x) => x.prof.soft_ms))} ms${r.prof.soft_dismissed != null ? ', dismissed exactly by box: ' + r.prof.pairs_dismissed + ' pairs (' + r.prof.soft_dismissed + ' clearance)' : ''}`);
    if (r.label.startsWith('pool') && !(r.pool && r.pool.used && !r.pool.fellBack && r.pool.pairsDone > 0)) fail(r.label + ': the worker pool did not do the narrow phase: ' + JSON.stringify(r.pool));
    for (const x of reps) {
      const same = x.rows.length === ref.rows.length && x.rows.every((y, i) => y === ref.rows[i]);
      if (!same) {
        const i = x.rows.findIndex((y, k) => y !== ref.rows[k]);
        fail(`${x.label} differs from ${ref.label} (${x.rows.length} vs ${ref.rows.length} rows), first at #${i}: ${String(x.rows[i]).slice(0, 400)} vs ${String(ref.rows[i]).slice(0, 400)}`);
        break;
      }
    }
    if (r !== ref) ok(`${r.label} == ${ref.label} (${ref.rows.length} clashes, field for field, in order, ${reps.length} run(s))`);
  }
  if (process.env.CC_DUMP) await writeFile(process.env.CC_DUMP, ref.rows.join('\n') + '\n');
  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail('harness error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nclearance-cost: all checks passed');
