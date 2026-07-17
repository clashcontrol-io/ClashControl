#!/usr/bin/env node
// Real-browser lock for the "load selected storeys now, then complete in
// background" option added to StoreyScopeModal alongside the browser-first
// large-model plan's Phase 2 (session 2026-07-17). Deliberately reuses the
// EXISTING, already-tested one-shot scoped-load + _ccReloadModelFull path
// (the same mechanism behind the manual "partial load" badge button) rather
// than a new incremental/partial loading state — see MEMORY.md's chunk-merge
// history for why. This test's whole point is confirming that reuse actually
// fires end-to-end: partial model appears first, then a real second load
// (worker or fallback, whichever the browser picks) replaces it with the
// full model with no user interaction after the initial confirm.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

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

function fail(msg) { console.error('STOREY AUTO-COMPLETE FAIL: ' + msg); process.exitCode = 1; }

await page.goto(`http://127.0.0.1:${port}/?ccSafety=ccUiStoreyChooser`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });

const buf = await readFile(join(ROOT, 'tests/fixtures/multi-storey-smoke.ifc'));
const fileHandle = await page.evaluateHandle((bytes) => {
  const arr = new Uint8Array(bytes);
  return new File([arr], 'multi-storey-smoke.ifc');
}, Array.from(buf));
const dt = await page.evaluateHandle((file) => {
  const dt = new DataTransfer();
  dt.items.add(file);
  return dt;
}, fileHandle);
await page.evaluate((dt) => {
  const input = document.querySelector('input[type=file][accept*=".ifc"]');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, dt);

await page.waitForSelector('#cc-storey-scope-title', { timeout: 10_000 }).catch(() => fail('storey scope modal never appeared'));

// Deselect exactly one storey (by exact label text, "Level 0" from the
// synthetic generator) so the selection is a real partial subset — NOT the
// "Load all" checkbox, which lives in its own label above the storey list
// and would clear every box at once (`next[n] = !allChecked` for all n) if
// matched by a looser selector.
const level0Label = page.locator('label', { hasText: 'Level 0' }).filter({ hasNotText: 'Load all' });
if (!(await level0Label.isVisible().catch(() => false))) fail('could not find the "Level 0" storey checkbox label');
await level0Label.locator('input[type=checkbox]').uncheck();

// The auto-complete checkbox should now be visible (only shown for a real
// partial selection, never for "Load all"). Locate the actual <input> via
// its wrapping label (same robust pattern as the storey checkbox above)
// rather than clicking the <span> text node.
const autoLabel = page.locator('label', { hasText: 'Load the rest automatically in the background' });
if (!(await autoLabel.isVisible().catch(() => false))) fail('auto-complete checkbox did not appear for a partial selection');
await autoLabel.locator('input[type=checkbox]').check();
const autoCheckedState = await autoLabel.locator('input[type=checkbox]').isChecked();
if (!autoCheckedState) fail('auto-complete checkbox did not register as checked');

const confirmBtn = page.getByRole('button', { name: /Load \d+ selected/ });
const confirmLabel = await confirmBtn.textContent().catch(() => null);
if (!confirmLabel) fail('confirm button does not read "Load N selected"');
await confirmBtn.click();

// 1. Partial model appears first.
await page.waitForFunction(() => {
  const s = window._ccLatestState;
  const m = s && s.models.find((x) => x.name.indexOf('multi-storey-smoke') === 0);
  return m && (m.elements || []).length > 0;
}, null, { timeout: 60_000 }).catch(() => fail('scoped (partial) model never appeared'));

const partialSnapshot = await page.evaluate(() => {
  const m = window._ccLatestState.models.find((x) => x.name.indexOf('multi-storey-smoke') === 0);
  return { elementCount: (m.elements || []).length, loadedScope: (m.stats || {}).loadedScope || null, scopedOutCount: (m.stats || {}).scopedOutCount || 0 };
});
if (!partialSnapshot.loadedScope) fail('first-settled model does not report loadedScope — expected a genuinely partial load');
if (partialSnapshot.scopedOutCount === 0) fail('scopedOutCount is 0 — the deselected storey did not actually skip any elements');
console.log('Partial load: ' + partialSnapshot.elementCount + ' elements, scope=' + JSON.stringify(partialSnapshot.loadedScope) + ', skipped=' + partialSnapshot.scopedOutCount);

// 2. Background full reload should auto-fire and REPLACE_MODEL with the
// complete model — no further user interaction. Poll for loadedScope to
// clear and the element count to grow to the full 9 (3 storeys x 3 walls).
await page.waitForFunction((partialCount) => {
  const s = window._ccLatestState;
  const m = s && s.models.find((x) => x.name.indexOf('multi-storey-smoke') === 0);
  return m && !((m.stats || {}).loadedScope) && (m.elements || []).length > partialCount;
}, partialSnapshot.elementCount, { timeout: 60_000 }).catch(() => fail('background auto-complete never replaced the partial model with the full one'));

const fullSnapshot = await page.evaluate(() => {
  const m = window._ccLatestState.models.find((x) => x.name.indexOf('multi-storey-smoke') === 0);
  return { elementCount: (m.elements || []).length, loadedScope: (m.stats || {}).loadedScope || null };
});
if (fullSnapshot.elementCount !== 9) fail('expected the full model to have 9 elements (3 storeys x 3 walls), got ' + fullSnapshot.elementCount);
if (fullSnapshot.loadedScope) fail('full model still reports a loadedScope: ' + JSON.stringify(fullSnapshot.loadedScope));
console.log('Full load auto-completed: ' + fullSnapshot.elementCount + ' elements, loadedScope=' + fullSnapshot.loadedScope);

// The registry entry must have been consumed exactly once — no lingering
// auto-complete intent that could mistakenly fire on a later, unrelated load
// of a same-named file.
const registryState = await page.evaluate(() => window._ccAutoCompleteScopedLoads ? Array.from(window._ccAutoCompleteScopedLoads) : null);
if (registryState && registryState.includes('multi-storey-smoke.ifc')) fail('auto-complete registry still holds the file after it fired — not consumed');

if (errors.length) fail('browser emitted uncaught page or console errors: ' + JSON.stringify(errors.slice(0, 10)));

console.log(process.exitCode ? 'STOREY AUTO-COMPLETE CHECK: see failures above' : 'STOREY AUTO-COMPLETE CHECK OK — partial load appears first, background reload auto-completes it, registry consumed exactly once');
await browser.close();
server.close();
