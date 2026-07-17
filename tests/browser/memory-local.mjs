// Reproducible local memory-retention probe for ClashControl.
// Measures the main JS heap, Three.js resources, and (REWRITE_UI_PLAN.md
// Phase 11) the actual browser process RSS after load, repeated section-cut
// rebuilds, section clear and model unload. The RSS number is what the
// original rewrite report's own limitations section explicitly said this
// harness was missing ("does not claim to measure Chromium's native/WASM/
// GPU process allocation") — this closes that gap for the one metric that's
// reliably readable from Node without a native addon: since this harness
// launches Chromium with --single-process --no-zygote (for sandboxed-runner
// compatibility), the ENTIRE browser — JS heap, WASM linear memory, GPU
// (SwiftShader software rendering), DOM — lives in exactly one OS process,
// so /proc/<pid>/status's VmRSS is a real total, not a partial one that
// misses a separate renderer/GPU subprocess. Linux-only (this sandbox);
// returns null gracefully elsewhere rather than fabricating a number.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
// Playwright's Browser class does not expose the underlying OS process (that
// is a Puppeteer-only API) — the real PID comes from Chromium's own CDP
// SystemInfo.getProcessInfo, which in --single-process mode reports exactly
// one {type:'browser', id:<pid>} entry. Verified against /proc/<pid>/status
// directly before relying on it here.
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
const MIME = {
  '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.json':'application/json', '.wasm':'application/wasm', '.png':'image/png',
  '.svg':'image/svg+xml', '.ifc':'application/octet-stream', '.css':'text/css',
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {'content-type':MIME[extname(file)] || 'application/octet-stream'});
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(8767, '127.0.0.1', resolve));

const executablePath = process.env.CC_CHROMIUM_EXECUTABLE;
if (!executablePath) throw new Error('CC_CHROMIUM_EXECUTABLE is required');
const browser = await chromium.launch({
  executablePath,
  args:['--no-sandbox','--disable-setuid-sandbox','--single-process','--no-zygote',
    '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--enable-precise-memory-info','--js-flags=--expose-gc'],
});
const browserPid = await getBrowserPid(browser);

async function local(route, file, contentType='text/javascript') {
  await route.fulfill({status:200, body:await readFile(join(dependencyRoot, 'node_modules', file)),
    headers:{'content-type':contentType,'access-control-allow-origin':'*'}});
}

const context = await browser.newContext({serviceWorkers:'block'});
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
await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({status:200,body:'',contentType:'text/css'}));
await context.route('https://fonts.gstatic.com/**', (r) => r.abort());
await context.route('https://gc.zgo.at/**', (r) => r.fulfill({status:200,body:'',contentType:'text/javascript'}));

const page = await context.newPage();
const errors = [];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

async function settle() {
  await page.waitForTimeout(180);
  await page.evaluate(() => { if (typeof gc === 'function') gc(); });
  await page.waitForTimeout(80);
}

async function sample(label) {
  await settle();
  const inPage = await page.evaluate((name) => {
    const renderer = window._ccState3d && window._ccState3d.renderer;
    const info = renderer && renderer.info;
    const state = window._ccLatestState || {};
    return {
      label:name,
      heapBytes:performance.memory ? performance.memory.usedJSHeapSize : null,
      heapTotalBytes:performance.memory ? performance.memory.totalJSHeapSize : null,
      geometries:info && info.memory ? info.memory.geometries : null,
      textures:info && info.memory ? info.memory.textures : null,
      programs:info && info.programs ? info.programs.length : null,
      drawCalls:info && info.render ? info.render.calls : null,
      triangles:info && info.render ? info.render.triangles : null,
      models:(state.models || []).length,
      elements:(state.models || []).reduce((n, m) => n + (m.elements || []).length, 0),
    };
  }, label);
  inPage.rssBytes = await readRssBytes(browserPid);
  return inPage;
}

const samples = [];
try {
  await page.goto('http://127.0.0.1:8767/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, {timeout:60_000});
  samples.push(await sample('boot'));

  await page.evaluate(async () => {
    const buffer = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buffer], 'memory-smoke.ifc')]);
  });
  await page.waitForFunction(() => window._ccLatestState && window._ccLatestState.models.length === 1 && window._ccModelLoading === false, null, {timeout:120_000});
  samples.push(await sample('loaded'));

  await page.evaluate(() => {
    window._ccProbeGeometryDisposals = 0;
    window._ccProbeDisposedGeometryIds = [];
    const proto = window.THREE && window.THREE.BufferGeometry && window.THREE.BufferGeometry.prototype;
    if (proto && !proto._ccProbeDispose) {
      proto._ccProbeDispose = proto.dispose;
      proto.dispose = function(...args) {
        window._ccProbeGeometryDisposals++;
        window._ccProbeDisposedGeometryIds.push(this.uuid);
        return proto._ccProbeDispose.apply(this, args);
      };
    }
  });
  const sectionTimeline = [];
  for (let i = 0; i < 12; i++) {
    const priorLineId = await page.evaluate(() => window._ccState3d._sectionCutLines && window._ccState3d._sectionCutLines.geometry.uuid);
    await page.evaluate(() => { window._ccProbeDisposedGeometryIds = []; });
    await page.evaluate((pos) => window._ccDispatch({t:'SECTION', axis:'y', pos}), 0.18 + i * 0.055);
    await page.waitForTimeout(380);
    sectionTimeline.push(await page.evaluate((input) => ({
      step:input.step,
      geometries:window._ccState3d.renderer.info.memory.geometries,
      geometryDisposals:window._ccProbeGeometryDisposals || 0,
      lineId:window._ccState3d._sectionCutLines && window._ccState3d._sectionCutLines.uuid,
      priorLineDisposed:input.priorLine ? window._ccProbeDisposedGeometryIds.includes(input.priorLine) : null,
    }), {step:i + 1, priorLine:priorLineId}));
  }
  samples.push(await sample('after-12-section-rebuilds'));

  await page.evaluate(() => window._ccDispatch({t:'SECTION', axis:null, pos:0.5}));
  await page.waitForTimeout(450);
  samples.push(await sample('section-cleared'));

  for (const renderStyle of ['xray', 'wireframe', 'rendered', 'standard', 'shaded']) {
    await page.evaluate((style) => window._ccDispatch({t:'UPD_PREFS', u:{renderStyle:style}}), renderStyle);
    await page.waitForTimeout(180);
  }
  samples.push(await sample('after-style-cycle'));

  await page.evaluate(() => {
    const m = window._ccLatestState.models[0];
    window._ccDispatch({t:'DEL_MODEL', id:m.id});
  });
  await page.waitForFunction(() => window._ccLatestState && window._ccLatestState.models.length === 0);
  samples.push(await sample('model-unloaded'));

  if (errors.length) throw new Error(errors.join(' | '));
  const result = {
    generatedAt:new Date().toISOString(),
    scope:'main JS heap, Three.js renderer counters (geometries/textures/programs/drawCalls/triangles), and rssBytes (whole-process RSS via /proc — this launch uses --single-process --no-zygote so JS heap + WASM linear memory + GPU/SwiftShader all live in the one measured process; Linux only, null elsewhere)',
    sectionTimeline,
    samples,
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[2]) await writeFile(process.argv[2], json);
  console.log(json);
} finally {
  await context.close();
  await browser.close();
  server.close();
}
