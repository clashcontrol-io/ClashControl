#!/usr/bin/env node
// Detection memory watchdog (docs/INTERNALS.md §21.57). A run that walks into
// the browser's memory wall must never take the tab down with it. Thresholds
// are forced through window._ccDetectMemory so every stage triggers on the
// synthetic CI federation:
//   relieve + pool-off  caches dropped and the worker pool stopped mid-run —
//                       the clash list is IDENTICAL to an unguarded run
//   stop (heap)         the run stops: nothing committed, the clash list
//                       (ids + statuses) unchanged, detecting cleared, the
//                       user told why (toast) and an ok:false 'memory' event
//   stop (clash count)  same, for browsers without performance.memory
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/detect-memory-guard.mjs
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
function ok(msg) { console.log('MEMORY GUARD OK — ' + msg); }
function fail(msg) { console.error('MEMORY GUARD FAIL: ' + msg); failures++; }
function check(cond, msg, detail) { if (cond) ok(msg); else fail(msg + (detail ? ' — ' + detail : '')); }

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local' });
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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccDetectMemory, null, { timeout: 120_000 });
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } }));
  const names = [...files.keys()];
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (k) => new File([await (await fetch(k)).arrayBuffer()], k.split('/').pop())));
    window.ClashControl.loadFiles(fs);
  }, names);
  await page.waitForFunction((n) => { const s = window._ccLatestState; return s && s.models.length === n && window._ccModelLoading === false; }, names.length, { timeout: 300_000 });
  check(await page.evaluate(() => typeof performance.memory === 'object' && performance.memory.jsHeapSizeLimit > 0), 'performance.memory is available here (the heap stages can be exercised)');

  const RULES = { hard: true, maxGap: 50, minGap: 0, excludeSameDiscipline: false, selfClashModels: 'none', fullRerun: true };
  const run = (cfg) => page.evaluate(async ({ cfg, rules }) => {
    const M = window._ccDetectMemory, saved = Object.assign({}, M);
    Object.assign(M, cfg);
    const P = window._ccNarrowPool; P.disabled = false; P.minCandidates = 0; P.minCandidatesHardOnly = 0;
    const events = [];
    const onDone = (e) => events.push(e.detail);
    window.addEventListener('cc-detection-complete', onDone);
    const toasts = [], origToast = window._ccToast;
    window._ccToast = function (m) { toasts.push(String(m)); if (origToast) return origToast.apply(this, arguments); };
    const res = await window.ClashControl.runDetection(rules);
    await new Promise((r) => setTimeout(r, 300));
    window.removeEventListener('cc-detection-complete', onDone);
    window._ccToast = origToast;
    for (const k of Object.keys(saved)) if (k !== 'last') M[k] = saved[k];
    const st = window._ccLatestState;
    return {
      outcome: res && res._ccOutcome, n: (res || []).length,
      sig: (res || []).map((c) => JSON.stringify(c, (k, v) => (k === 'id' || k === 'createdAt' ? undefined : v))),
      list: st.clashes.map((c) => c.id + ':' + c.status).sort(), detecting: !!st.detecting,
      last: M.last, pool: P.last, events, toasts,
    };
  }, { cfg, rules: RULES });

  // 1. unguarded reference (thresholds out of reach)
  const ref = await run({ relieveAt: 2, poolOffAt: 2, stopAt: 2, everyMs: 0 });
  check(ref.outcome === 'complete' && ref.n > 0, 'reference run completes (' + ref.n + ' clashes)', JSON.stringify({ o: ref.outcome, n: ref.n }));
  // mark one clash so "unchanged" covers user decisions too
  const marked = await page.evaluate(() => { const c = window._ccLatestState.clashes[0]; window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: 'resolved' } }); return c.id; });
  await page.waitForFunction((id) => window._ccLatestState.clashes.find((c) => c.id === id).status === 'resolved', marked);
  const before = await page.evaluate(() => window._ccLatestState.clashes.map((c) => c.id + ':' + c.status).sort());

  // 2. relieve + pool-off on every check: same result, pool stopped by the guard
  const relieved = await run({ relieveAt: 0, poolOffAt: 0, stopAt: 2, everyMs: 0 });
  check(relieved.outcome === 'complete' && relieved.sig.length === ref.sig.length && relieved.sig.every((c, i) => c === ref.sig[i]),
    'caches dropped + pool stopped mid-run: the clash list is identical to the unguarded run', JSON.stringify({ o: relieved.outcome, n: relieved.n, ref: ref.n }));
  check(relieved.last && relieved.last.actions.includes('relieve') && relieved.last.actions.includes('pool-off') && !relieved.last.stopped,
    'the guard relieved and turned the pool off (' + (relieved.last && relieved.last.actions.join(', ')) + ')');
  check(relieved.pool && relieved.pool.used && relieved.pool.reason === 'memory-pressure', 'the worker pool ran and was stopped for memory pressure', JSON.stringify(relieved.pool && { used: relieved.pool.used, reason: relieved.pool.reason }));

  // 3. heap stop: nothing committed, list unchanged, user told
  const stopped = await run({ relieveAt: 0, poolOffAt: 0, stopAt: 0, confirmMs: 0, everyMs: 0 });
  check(stopped.outcome === 'memory' && stopped.n === 0, 'the run stops with outcome "memory" and returns nothing', JSON.stringify({ o: stopped.outcome, n: stopped.n }));
  check(JSON.stringify(stopped.list) === JSON.stringify(before), 'the clash list (ids + statuses, incl. a resolved one) is unchanged — no partial commit, no auto-resolve');
  check(!stopped.detecting, 'detecting is cleared (the UI is not left spinning)');
  check(stopped.events.some((e) => e && e.ok === false && e.outcome === 'memory' && e.reason === 'heap' && e.total > 0), 'cc-detection-complete reports ok:false, outcome "memory"', JSON.stringify(stopped.events));
  check(stopped.toasts.some((t) => /out of memory|memory/i.test(t) && /unchanged/i.test(t)), 'the user is told why it stopped and that the list is unchanged', JSON.stringify(stopped.toasts));
  check(stopped.last && stopped.last.stopped && stopped.last.actions.includes('stop:heap'), 'last-run record says it stopped on the heap');

  // 4. clash-count stop (the signal where performance.memory is missing)
  const capped = await run({ relieveAt: 2, poolOffAt: 2, stopAt: 2, maxClashes: 3, everyMs: 0 });
  check(capped.outcome === 'memory' && capped.events.some((e) => e && e.outcome === 'memory' && e.reason === 'clashes'), 'more clashes than maxClashes stops the run the same way', JSON.stringify({ o: capped.outcome, ev: capped.events }));
  check(JSON.stringify(capped.list) === JSON.stringify(before), 'the clash list is still unchanged');

  // 5. after a stop, a normal run works and gives the reference result
  const again = await run({ everyMs: 500 });
  check(again.outcome === 'complete' && again.sig.length === ref.sig.length && again.sig.every((c, i) => c === ref.sig[i]), 'a normal run after the stops gives the reference result again');
  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('MEMORY GUARD: all checks passed');
