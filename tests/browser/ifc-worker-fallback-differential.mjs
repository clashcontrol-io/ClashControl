#!/usr/bin/env node
// REWRITE_UI_PLAN.md Phase 7 — differential fixture the plan calls a
// PREREQUISITE for ever splitting the IFC worker into a real static file
// ("compare complete model fingerprints before removing the serialized
// worker"). This does NOT do that split — it builds and runs the
// comparison harness the split would need, on the worker as it exists
// today (assembled via .toString() at runtime — see _getIFCWorkerUrl).
//
// Loads the SAME fixture IFC twice in the SAME page: once through the real
// Worker path, once forced through the main-thread fallback (same trick
// smoke.mjs uses — stub out window.Worker so the constructor throws), then
// compares window._ccSafetyMigrations.modelFingerprint() output between the
// two resulting models. That fingerprint (box bounds + mesh count + IFC
// type per element, order-independent) already exists precisely for this
// kind of before/after equivalence check — see safety-migrations.js.
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path node tests/browser/ifc-worker-fallback-differential.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const offline = process.env.CC_BROWSER_OFFLINE_DEPS === '1';

function fail(msg) {
  console.error('DIFFERENTIAL FAIL: ' + msg);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    const body = await readFile(join(root, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1))));
    const ct = (p === '/' || p.endsWith('.html')) ? 'text/html'
      : p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    res.writeHead(200, { 'content-type': ct });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const errors = [];

async function loadAndFingerprint(forceFallback) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (offline) {
    const local = async (route, file, ct) => route.fulfill({
      status: 200, body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' },
    });
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  const result = await page.evaluate(async (forceFallbackInner) => {
    if (forceFallbackInner) {
      window.Worker = class BrokenWorker { constructor() { throw new Error('forced fallback for differential test'); } };
    }
    const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'differential.ifc')]);
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const s = window._ccLatestState;
        const m = s && s.models.find((x) => x.name.indexOf('differential') === 0);
        if (m && (m.elements || []).length > 0) { clearInterval(iv); resolve(); }
        if (Date.now() - t0 > 60000) { clearInterval(iv); reject(new Error('timed out waiting for model')); }
      }, 100);
    });
    const model = window._ccLatestState.models.find((x) => x.name.indexOf('differential') === 0);
    // modelFingerprint()'s key is `${model.id}:${expressId}` — model.id is a
    // session-random uid() assigned at load time (not derived from file
    // content), so it will always legitimately differ between two separate
    // loadFiles() calls even for byte-identical output. Fix it to a constant
    // so the comparison is actually about parse correctness, not session
    // randomness that was never a signal to begin with.
    const fixedIdModel = Object.assign({}, model, { id: 'fixed' });
    return {
      fingerprint: window._ccSafetyMigrations.modelFingerprint([fixedIdModel]),
      elementCount: (model.elements || []).length,
      meshCount: (model.meshes || []).length,
    };
  }, forceFallback);
  await page.close();
  return result;
}

try {
  const workerResult = await loadAndFingerprint(false);
  console.log('Worker path: ' + workerResult.elementCount + ' elements, ' + workerResult.meshCount + ' meshes');
  const fallbackResult = await loadAndFingerprint(true);
  console.log('Fallback path: ' + fallbackResult.elementCount + ' elements, ' + fallbackResult.meshCount + ' meshes');

  const comparison = JSON.stringify(workerResult.fingerprint) === JSON.stringify(fallbackResult.fingerprint);
  if (!comparison) {
    console.error('Worker fingerprint:', JSON.stringify(workerResult.fingerprint, null, 1));
    console.error('Fallback fingerprint:', JSON.stringify(fallbackResult.fingerprint, null, 1));
    fail('worker and main-thread-fallback IFC parses produced different model fingerprints');
  }
  if (workerResult.elementCount === 0) fail('worker path parsed zero elements — fixture or harness is broken, not a real pass');
  if (errors.length) fail('browser emitted uncaught page or console errors: ' + JSON.stringify(errors.slice(0, 10)));

  console.log('DIFFERENTIAL OK — worker and main-thread-fallback IFC parses are fingerprint-identical (' + workerResult.elementCount + ' elements)');
} finally {
  await browser.close();
  server.close();
}
