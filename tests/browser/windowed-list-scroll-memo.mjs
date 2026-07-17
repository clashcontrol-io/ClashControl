#!/usr/bin/env node
// Real-browser behavioral lock for the windowed conflict list's memoization
// during scroll, GROUPED case. tests/windowed-conflict-list.test.js already
// locks the pure math (buildConflictRows/computeRowOffsets/etc.) and a
// source-pattern check that _ccComputeRowOffsets sits inside a useMemo — but
// neither can catch an UNMEMOIZED upstream dependency invalidating that
// useMemo on every render, which is exactly what happened: groupAndSort()
// was called directly in VirtualList's render body, returning a fresh
// array/object every call, so grouped/sorted lists silently regrouped and
// reflowed on every scroll-driven re-render despite the useMemo around the
// offsets table technically existing. This test drives 100 real scroll
// updates against a real mounted VirtualList (ccUiWindowedConflicts on,
// grouped by storey) and asserts the actual call counts stay flat —
// checking behavior, not source shape.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { generateConflicts } from '../fixtures/synthetic-conflicts.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(normalize(ROOT))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    const ct = (p === '/' || p.endsWith('.html')) ? 'text/html' : p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    res.writeHead(200, { 'content-type': ct }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CC_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// Optional deterministic dependency mirror for restricted/offline test
// environments (matches tests/browser/smoke.mjs's convention exactly). CI
// has real internet access and only npm-installs playwright itself, not the
// app's CDN-mirrored packages — routing unconditionally here 404s in CI
// with no node_modules/react to read from. Gate it the same way smoke.mjs
// does: only intercept when explicitly asked to run offline.
if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
  async function local(route, file, contentType) {
    await route.fulfill({ status: 200, body: await readFile(join(ROOT, 'node_modules', file)), headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' } });
  }
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
  await page.context().route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
    await local(route, 'three/' + suffix);
  });
  await page.context().route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
    await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  });
  await page.context().route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  await page.context().route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.context().route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
}

function fail(msg) { console.error('WINDOWED SCROLL MEMO CHECK FAIL: ' + msg); process.exitCode = 1; }

await page.goto(`http://127.0.0.1:${port}/?ccSafety=ccUiWindowedConflicts`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });

// Two fake models so the synthetic clashes' modelAId/modelBId pass the
// visibleModelIds filter (real detection results always reference a real
// loaded model; a synthetic fixture needs the same shape to not be
// silently filtered out of the list).
await page.evaluate(() => {
  window._ccDispatch({ t: 'ADD_MODEL', v: { id: 'model-0', name: 'Model 1', visible: true, elements: [] } });
  window._ccDispatch({ t: 'ADD_MODEL', v: { id: 'model-1', name: 'Model 2', visible: true, elements: [] } });
  window._ccDispatch({ t: 'TAB', v: 'clashes' });
});
const { items } = generateConflicts(2000, { seed: 11 });
await page.evaluate((its) => { window._ccDispatch({ t: 'SET_CLASHES', v: its }); }, items);
await page.waitForFunction(() => window._ccLatestState && window._ccLatestState.clashes && window._ccLatestState.clashes.length > 0, null, { timeout: 10_000 });
await page.evaluate(() => { window._ccDispatch({ t: 'CLASH_GROUP_BY', v: ['storey'] }); });
await page.waitForTimeout(200);

const mounted = await page.locator('[data-row-key]').count();
if (mounted === 0) fail('windowed grouped list did not mount any rows — test setup is broken, not the thing under test');

// Settle pass: sweep the full scrollable range ONCE so every row's real
// height gets measured and cached (heightCacheRef). This first pass
// legitimately bumps winForceTick/computeRowOffsets repeatedly as
// previously-unmeasured rows come into view for the first time — that's
// the intended "measure as you go" behavior from Task 14, not a bug, and
// isn't what this test is checking.
const settle = await page.evaluate(async () => {
  const el = document.querySelector('[data-row-key]').closest('div[style*="overflow"]') ||
    document.querySelector('[data-row-key]').parentElement.parentElement;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  function frame() { return new Promise((r) => requestAnimationFrame(r)); }
  for (let i = 0; i <= 20; i++) {
    el.scrollTop = Math.round((i / 20) * max);
    el.dispatchEvent(new Event('scroll'));
    await frame();
    await frame();
  }
  return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, max };
});
if (settle.scrollHeight <= settle.clientHeight) fail('scroll container is not actually scrollable (scrollHeight <= clientHeight) — test setup did not produce enough rows to exercise real scrolling');
await page.waitForTimeout(100);

// Now the real check: reset counters, then re-visit the SAME already-
// measured range 100 times. Every row involved already has a cached real
// height, so nothing about items/groupBy/sortBy/models/collapsed/
// groupLimits/heightCache should change — groupAndSort, buildConflictRows,
// AND computeRowOffsets should all stay flat this time.
await page.evaluate(() => { window._ccListPerfCounters = { groupAndSort: 0, buildConflictRows: 0, computeRowOffsets: 0 }; });
await page.evaluate(async (max) => {
  const el = document.querySelector('[data-row-key]').closest('div[style*="overflow"]') ||
    document.querySelector('[data-row-key]').parentElement.parentElement;
  function frame() { return new Promise((r) => requestAnimationFrame(r)); }
  for (let i = 0; i < 100; i++) {
    el.scrollTop = Math.round(((i % 20) / 20) * max);
    el.dispatchEvent(new Event('scroll'));
    await frame();
    await frame();
  }
}, settle.max);

const counters = await page.evaluate(() => window._ccListPerfCounters);
console.log('perf counters after 100 re-scrolls over an already-measured range:', JSON.stringify(counters));
// Zero is the correct answer for a re-visit of already-measured rows. A
// small allowance (<=2) covers any incidental re-render this harness
// itself triggers (e.g. a resize observer firing once) without masking the
// real regression this test exists to catch, which is O(scroll-update-count)
// growth — the exact shape of the bug this test was written to lock.
if (counters.groupAndSort > 2) fail('groupAndSort ran ' + counters.groupAndSort + ' times across 100 scroll updates — the grouped list is still regrouping/sorting on every scroll-driven re-render');
if (counters.buildConflictRows > 2) fail('_ccBuildConflictRows ran ' + counters.buildConflictRows + ' times across 100 scroll updates — row-building is not actually memoized');
if (counters.computeRowOffsets > 2) fail('_ccComputeRowOffsets ran ' + counters.computeRowOffsets + ' times across 100 scroll updates over an already-measured range — offset recomputation regressed');

if (errors.length) { console.error('FAIL: console/page errors:', JSON.stringify(errors.slice(0, 10))); process.exitCode = 1; }
await browser.close();
server.close();
if (!process.exitCode) console.log('WINDOWED SCROLL MEMO CHECK OK — groupAndSort/buildConflictRows/computeRowOffsets all stayed flat across 100 scroll updates on a grouped list');
