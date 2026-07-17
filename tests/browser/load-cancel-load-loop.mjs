// Load-cancel-load loop probe — REWRITE_UI_PLAN.md / browser-first
// large-model plan review (2026-07-17) Phase 0 ask: "Add long-running
// browser tests for load-cancel-load, repeated federation, clash-run
// cancellation, model removal and five consecutive project opens. Memory
// must return to a stable plateau after explicit cleanup and GC-enabled
// test runs." This covers the load-cancel-load + model-removal half on a
// SINGLE persistent page across N cycles (not a fresh browser per cycle —
// the whole point is to catch a per-cycle leak accumulating within one
// session, which a fresh-process-per-sample harness like perf-local.mjs
// cannot see). Repeated federation and five-consecutive-project-opens are
// NOT covered here — flagged as follow-up work, not silently subsumed.
//
// Each cycle: (1) start a load via a worker stub that never responds
// (same forced-in-flight trick smoke.mjs's cancellation case already
// uses), (2) cancel it via window._ccAbortLoading(), (3) load the real
// fixture and wait for it to settle, (4) unload it via DEL_MODEL, (5)
// sample heap + whole-process RSS after a forced GC. Plateau check:
// compares the LAST cycle's post-GC heap/RSS against the SECOND cycle's
// (cycle 1 is a warm-up — one-time lazy-module/cache allocations that
// legitimately don't recur — comparing from cycle 1 would flag normal
// warm-up cost as a leak).
//
// Usage:
//   CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 \
//   node tests/browser/load-cancel-load-loop.mjs [cycles]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

function fail(msg) {
  console.error('LOAD-CANCEL-LOAD FAIL: ' + msg);
  process.exitCode = 1;
}

async function readRssBytes(pid) {
  if (!pid) return null;
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null; // non-Linux, or the process already exited — never fabricate a number
  }
}
async function getBrowserPid(browserHandle) {
  try {
    const cdp = await browserHandle.newBrowserCDPSession();
    const info = await cdp.send('SystemInfo.getProcessInfo');
    const entry = (info.processInfo || []).find((p) => p.type === 'browser') || info.processInfo?.[0];
    return entry ? entry.id : null;
  } catch {
    return null;
  }
}

const root = process.env.CC_REPO_ROOT || fileURLToPath(new URL('../..', import.meta.url));
const dependencyRoot = process.env.CC_DEPS_ROOT || root;
const cycles = Number(process.argv[2] || process.env.CC_LOOP_CYCLES || 5);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const executablePath = process.env.CC_CHROMIUM_EXECUTABLE;
if (!executablePath) throw new Error('CC_CHROMIUM_EXECUTABLE is required');
const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const browserPid = await getBrowserPid(browser);

async function local(route, file, contentType = 'text/javascript') {
  await route.fulfill({
    status: 200, body: await readFile(join(dependencyRoot, 'node_modules', file)),
    headers: { 'content-type': contentType, 'access-control-allow-origin': '*' },
  });
}
const context = await browser.newContext({ serviceWorkers: 'block' });
if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
  await context.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
    await local(route, 'three/' + suffix);
  });
  await context.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
    await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  });
  await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  await context.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await context.route('https://gc.zgo.at/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
}

const page = await context.newPage();
const errors = [];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

async function settle() {
  await page.waitForTimeout(150);
  await page.evaluate(() => { if (typeof gc === 'function') gc(); });
  await page.waitForTimeout(80);
}
async function sample(label) {
  await settle();
  const inPage = await page.evaluate((name) => ({
    label: name,
    heapBytes: performance.memory ? performance.memory.usedJSHeapSize : null,
    models: (window._ccLatestState && window._ccLatestState.models || []).length,
  }), label);
  inPage.rssBytes = await readRssBytes(browserPid);
  return inPage;
}

const cycleSamples = [];
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  // Save the real Worker constructor once, before any cycle overwrites it —
  // `window.Worker = class HangingWorker {...}` REPLACES the own property
  // outright (browser globals are plain writable/configurable own
  // properties, not prototype-chain fallbacks), so a bare `delete
  // window.Worker` afterward would leave it permanently unset, not restored.
  await page.evaluate(() => { window.__ccRealWorker = window.Worker; });

  for (let i = 0; i < cycles; i++) {
    // 1. Start a load that will never respond, forcing a genuine in-flight
    //    state to cancel — same technique as smoke.mjs's cancellation case.
    await page.evaluate(async (n) => {
      window.Worker = class HangingWorker {
        postMessage() {}
        terminate() {}
      };
      const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
      window.ClashControl.loadFiles([new File([buf], 'lcl-cancelled-' + n + '.ifc')]);
    }, i);
    await page.waitForFunction(() => window._ccModelLoading === true, null, { timeout: 5_000 })
      .catch(() => fail('cycle ' + i + ': load never entered the loading state'));

    // 2. Cancel it.
    await page.evaluate(() => window._ccAbortLoading());
    await page.waitForFunction(() => {
      const coordinator = window._ccRuntime && window._ccRuntime.services.get('loadCoordinator');
      return window._ccModelLoading === false && coordinator && coordinator.activeCount() === 0;
    }, null, { timeout: 5_000 }).catch(() => fail('cycle ' + i + ': cancel did not settle the load coordinator'));

    // 3. Load the real fixture and let it settle.
    await page.evaluate(async (n) => {
      window.Worker = window.__ccRealWorker; // restore the real Worker constructor
      const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
      window.ClashControl.loadFiles([new File([buf], 'lcl-loaded-' + n + '.ifc')]);
    }, i);
    await page.waitForFunction((n) => {
      const s = window._ccLatestState;
      const m = s && s.models.find((x) => x.name.indexOf('lcl-loaded-' + n) === 0);
      return m && (m.elements || []).length >= 2 && window._ccModelLoading === false;
    }, i, { timeout: 60_000 }).catch(() => fail('cycle ' + i + ': real load after cancel never settled'));

    // 4. Unload it (model removal — the other half of this probe's scope).
    await page.evaluate(() => {
      const m = window._ccLatestState.models[0];
      if (m) window._ccDispatch({ t: 'DEL_MODEL', id: m.id });
    });
    await page.waitForFunction(() => window._ccLatestState && window._ccLatestState.models.length === 0, null, { timeout: 10_000 })
      .catch(() => fail('cycle ' + i + ': model removal did not settle'));

    cycleSamples.push(await sample('cycle-' + i));
  }

  if (errors.length) fail('browser emitted uncaught page or console errors: ' + JSON.stringify(errors.slice(0, 10)));

  // Plateau check — compare the LAST cycle to the SECOND cycle (index 1),
  // skipping the first cycle's one-time warm-up allocations (lazy module
  // loads, first-ever cache fills). A generous 1.5x ratio tolerates the
  // real run-to-run noise this sandbox has shown on other harnesses
  // (MEMORY.md: "high run-to-run variance, likely shared-environment
  // resource contention") without masking genuine unbounded growth.
  console.log(JSON.stringify({ cycles, cycleSamples }, null, 2));
  if (cycleSamples.length >= 3) {
    const baseline = cycleSamples[1];
    const last = cycleSamples[cycleSamples.length - 1];
    if (baseline.heapBytes && last.heapBytes) {
      const ratio = last.heapBytes / baseline.heapBytes;
      console.log('Heap plateau check: cycle 1 = ' + baseline.heapBytes + 'B, cycle ' + (cycleSamples.length - 1) + ' = ' + last.heapBytes + 'B, ratio = ' + ratio.toFixed(2));
      if (ratio > 1.5) fail('JS heap grew ' + ratio.toFixed(2) + 'x from cycle 1 to the final cycle — does not look like a stable plateau');
    }
    if (baseline.rssBytes && last.rssBytes) {
      const ratio = last.rssBytes / baseline.rssBytes;
      console.log('RSS plateau check: cycle 1 = ' + baseline.rssBytes + 'B, cycle ' + (cycleSamples.length - 1) + ' = ' + last.rssBytes + 'B, ratio = ' + ratio.toFixed(2));
      if (ratio > 1.5) fail('process RSS grew ' + ratio.toFixed(2) + 'x from cycle 1 to the final cycle — does not look like a stable plateau');
    }
  }
  if (process.exitCode !== 1) console.log('LOAD-CANCEL-LOAD OK — ' + cycles + ' load-cancel-load-unload cycles, memory plateaued');
} finally {
  await context.close();
  await browser.close();
  server.close();
}
