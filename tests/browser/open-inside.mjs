#!/usr/bin/env node
// An element inside a shape that is NOT closed (docs/INTERNALS.md §9 "Inside
// an open shape"): an open shell has no defined inside, so the pair is never
// a hard clash — it is an 'open-inside' finding filed in its own review
// bucket ("inside an open shape — check"), reported identically by every
// narrow-phase path (JS, stateless WASM, cached WASM Engine, worker pool on
// JS and on WASM).
//
// Fixture: tests/fixtures/generate-building-ifc.js at ci scale with the
// opt-in planted case (openShell: a fitting inside a housing whose top is
// missing). The CI-scale federation gives the pool enough candidates to run.
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/open-inside.mjs
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
function ok(msg) { console.log('OPEN INSIDE OK — ' + msg); }
function fail(msg) { console.error('OPEN INSIDE FAIL: ' + msg); failures++; }
function check(cond, msg, detail) { if (cond) ok(msg); else fail(msg + (detail ? ' — ' + detail : '')); }

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local', openShell: true });
const files = new Map();
for (const k of Object.keys(gen.files)) files.set('/__gen/' + k + '.ifc', Buffer.from(gen.files[k]));
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
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => { try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {} });
if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  await page.goto(`http://127.0.0.1:${port}/?ccSafety=detectWorkerPool`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 120_000 });
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } }));
  const names = [...files.keys()];
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (k) => new File([await (await fetch(k)).arrayBuffer()], k.split('/').pop())));
    window.ClashControl.loadFiles(fs);
  }, names);
  await page.waitForFunction((n) => { const s = window._ccLatestState; return s && s.models.length === n && window._ccModelLoading === false; }, names.length, { timeout: 300_000 });
  await page.waitForFunction(() => typeof window._ccWasmIntersect === 'function' && window._ccWasmEngine, null, { timeout: 60_000 })
    .catch(() => fail('WASM narrow phase / cached engine never became ready'));

  // one run per narrow-phase path (same switches as office-clash-parity.mjs)
  const runs = await page.evaluate(async () => {
    const orig = { _ccWasmIntersect: window._ccWasmIntersect, _ccWasmMinDist: window._ccWasmMinDist, _ccWasmBatchIntersect: window._ccWasmBatchIntersect, _ccWasmEngine: window._ccWasmEngine };
    function setMode(mode) {
      for (const k of Object.keys(orig)) { if (orig[k]) window[k] = orig[k]; else delete window[k]; }
      const P = window._ccNarrowPool;
      P.disabled = !mode.startsWith('pool'); P.minCandidates = 0; P.minCandidatesHardOnly = 0; P.forceJs = false; P.maxWorkers = 0;
      if (mode === 'js' || mode === 'pool-js') { for (const k of Object.keys(orig)) delete window[k]; P.forceJs = mode === 'pool-js'; }
      else if (mode === 'wasm') delete window._ccWasmEngine;
    }
    const out = {};
    for (const mode of ['js', 'wasm', 'engine', 'pool-js', 'pool']) {
      setMode(mode);
      const res = await window.ClashControl.runDetection({ hard: true, maxGap: 50, minGap: 0, excludeSameDiscipline: false, selfClashModels: 'none', fullRerun: true });
      out[mode] = { clashes: (res || []).map((c) => JSON.stringify(c, (k, v) => (k === 'id' || k === 'createdAt' ? undefined : v))), pool: window._ccNarrowPool.last };
    }
    setMode('engine');
    return out;
  });
  const ref = runs.js.clashes;
  for (const mode of ['wasm', 'engine', 'pool-js', 'pool']) {
    const same = runs[mode].clashes.length === ref.length && runs[mode].clashes.every((c, i) => c === ref[i]);
    check(same, 'path "' + mode + '" reports exactly what the JS path does (' + ref.length + ' clashes)' + (mode.startsWith('pool') ? ' — pool used: ' + !!(runs[mode].pool && runs[mode].pool.used) : ''));
  }
  check(runs.pool.pool && runs.pool.pool.used && runs['pool-js'].pool && runs['pool-js'].pool.used, 'the worker pool really ran the pairs', JSON.stringify({ pool: runs.pool.pool, poolJs: runs['pool-js'].pool }));

  const found = ref.map((s) => JSON.parse(s)).filter((c) => /open housing/.test(c.elemAName + ' ' + c.elemBName));
  const c = found[0] || {};
  const inner = c.insideOpen === 'A' ? c.elemAName : c.insideOpen === 'B' ? c.elemBName : null;
  check(found.length === 1 && c.type === 'open-inside' && /fitting in open housing/.test(inner || ''),
    'the fitting inside the open-topped housing: one open-inside finding, the fitting named as the inner element', JSON.stringify(found.map((x) => ({ type: x.type, insideOpen: x.insideOpen, a: x.elemAName, b: x.elemBName }))));
  check(/ — check/.test(c.title || '') && c.distance === 0, 'title says to check it: "' + c.title + '"');

  // filed in its own bucket, not in the review list, counted in the bucket bar
  const ui = await page.evaluate(async () => {
    window._ccDispatch({ t: 'TAB', v: 'clashes' });
    await new Promise((r) => setTimeout(r, 600));
    const core = window._ccClashClassificationCore, st = window._ccLatestState;
    const oc = st.clashes.find((x) => x.type === 'open-inside');
    const review = window.ClashControl.review.summary().items.some((i) => i.ids.indexOf(oc && oc.id) !== -1);
    const bar = document.body.textContent;
    return { bucket: oc && core.reviewBucket(oc, st.rules), review, barText: /inside an open shape/.test(bar), sev: oc && (oc.aiSeverity || core.deterministicSeverity(oc)) };
  });
  check(ui.bucket === 'openshape' && !ui.review && ui.barText, 'filed in the "inside an open shape — check" bucket (bucket bar), not in the review list', JSON.stringify(ui));
  check(!found.some((x) => x.type === 'hard'), 'never a hard clash');
  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('OPEN INSIDE: all checks passed');
