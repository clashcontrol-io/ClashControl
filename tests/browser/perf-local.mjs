// Reproducible local performance probe for ClashControl.
//
// It deliberately uses the same real application, web-ifc worker/WASM path,
// fixture, dependency mirror and Chromium launch shape as smoke.mjs. Each
// sample gets a fresh browser context so IndexedDB, service workers and caches
// cannot turn later samples into cache-restore measurements.
//
// Run:
//   CC_CHROMIUM_EXECUTABLE=/path/to/chromium \
//   CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/perf-local.mjs [output.json]
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = process.env.CC_REPO_ROOT || fileURLToPath(new URL('../..', import.meta.url));
const dependencyRoot = process.env.CC_DEPS_ROOT || root;
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
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((resolve) => server.listen(8766, '127.0.0.1', resolve));

const executablePath = process.env.CC_CHROMIUM_EXECUTABLE;
if (!executablePath) throw new Error('CC_CHROMIUM_EXECUTABLE is required');
const launchOptions = {
  executablePath,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info',
  ],
};

async function mirrorDependencies(context) {
  if (process.env.CC_BROWSER_OFFLINE_DEPS !== '1') return;
  async function local(route, file, contentType) {
    await route.fulfill({
      status: 200,
      body: await readFile(join(dependencyRoot, 'node_modules', file)),
      headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' },
    });
  }
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

const samples = [];
const runs = Number(process.env.CC_PERF_RUNS || 7);
try {
  for (let run = 0; run < runs; run++) {
    // The Lambda-compatible Chromium used in restricted local environments
    // runs single-process and exits when its only context closes. Launching a
    // fresh browser per sample also gives stronger cache/process isolation.
    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await mirrorDependencies(context);
    const page = await context.newPage();
    const errors = [];
    let workerFallback = false;
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('console: ' + m.text());
      if (m.text().includes('[IFC Worker fallback]')) workerFallback = true;
    });

    const wallStart = performance.now();
    await page.goto('http://127.0.0.1:8766/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
    const bootMs = performance.now() - wallStart;

    const loadStart = performance.now();
    await page.evaluate(async () => {
      const buffer = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
      window.ClashControl.loadFiles([new File([buffer], 'perf-smoke.ifc')]);
    });
    await page.waitForFunction(() => {
      const s = window._ccLatestState;
      return s && s.models.length === 1 && (s.models[0].elements || []).length >= 2;
    }, null, { timeout: 120_000 });
    const geometryReadyMs = performance.now() - loadStart;
    await page.waitForFunction(() => window._ccModelLoading === false, null, { timeout: 120_000 });
    const completeMs = performance.now() - loadStart;

    const detectStart = performance.now();
    const detected = await page.evaluate(async () => {
      const result = await window.ClashControl.runDetection({ selfClashModels: 'all', excludeSelf: false });
      return result ? result.length : 0;
    });
    await page.waitForFunction(() => window._ccLatestState && window._ccLatestState.clashes.length > 0, null, { timeout: 10_000 });
    const detectionMs = performance.now() - detectStart;

    const metrics = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource');
      const model = window._ccLatestState.models[0];
      return {
        fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || null,
        resourceCount: resources.length,
        encodedBytes: resources.reduce((sum, r) => sum + (r.encodedBodySize || 0), 0),
        decodedBytes: resources.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0),
        heapBytes: performance.memory?.usedJSHeapSize || null,
        domNodes: document.getElementsByTagName('*').length,
        elements: (model.elements || []).length,
        elementsWithPsets: (model.elements || []).filter((e) => e.props && e.props.psets && Object.keys(e.props.psets).length).length,
        storeys: (model.storeys || []).length,
        clashes: window._ccLatestState.clashes.length,
      };
    });

    if (workerFallback || errors.length || detected < 1) {
      throw new Error(`invalid sample ${run + 1}: fallback=${workerFallback} detected=${detected} errors=${errors.join(' | ')}`);
    }
    samples.push({ run: run + 1, bootMs, geometryReadyMs, completeMs, detectionMs, totalMs: performance.now() - wallStart, ...metrics });
    await context.close();
    await browser.close();
  }
} finally {
  server.close();
}

const numericKeys = ['bootMs', 'geometryReadyMs', 'completeMs', 'detectionMs', 'totalMs', 'fcpMs', 'resourceCount', 'encodedBytes', 'decodedBytes', 'heapBytes', 'domNodes'];
function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const medians = Object.fromEntries(numericKeys.map((key) => [key, median(samples.map((s) => s[key]))]));
const result = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  runs,
  isolation: 'fresh Chromium process and context; service worker blocked; offline dependency mirror',
  medians,
  samples,
};
const json = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2]) await writeFile(process.argv[2], json);
console.log(json);
