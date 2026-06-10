// Browser smoke test: boot the real app in headless Chromium, load a real
// IFC through the real web-ifc WASM pipeline, run real clash detection,
// and assert the two crossing walls in the fixture produce a clash.
//
// Run:  node tests/browser/smoke.mjs        (requires `playwright` installed
//       and `npx playwright install chromium` done — see ci.yml)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(8765, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

function fail(msg) {
  console.error('SMOKE FAIL: ' + msg);
  if (errors.length) console.error('Page errors:\n  ' + errors.slice(0, 20).join('\n  '));
  process.exit(1);
}

try {
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });

  // App mounted (CDN deps + main script executed)
  await page.waitForFunction(
    () => window.ClashControl && typeof window._ccDispatch === 'function',
    null, { timeout: 60_000 }
  ).catch(() => fail('app did not mount within 60s'));

  // Load the fixture through the real file pipeline (web-ifc WASM from CDN)
  await page.evaluate(async () => {
    const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    const file = new File([buf], 'smoke-clash.ifc');
    window.ClashControl.loadFiles([file]);
  });
  await page.waitForFunction(() => {
    const s = window._ccLatestState;
    return s && s.models.length === 1 && (s.models[0].elements || []).length >= 2;
  }, null, { timeout: 120_000 }).catch(() => fail('model did not load/process within 120s (web-ifc WASM path)'));

  const detected = await page.evaluate(async () => {
    // Default rules exclude within-model pairs (excludeSelf:true) — the
    // fixture is one model with two crossing walls, so opt self-clash in.
    const result = await window.ClashControl.runDetection({ selfClashModels: 'all', excludeSelf: false });
    return result ? result.length : 0;
  });
  if (detected < 1) fail('two crossing walls produced 0 clashes');

  // The MERGE_CLASHES dispatch lands on the next React render — wait for it.
  await page.waitForFunction(
    () => window._ccLatestState && window._ccLatestState.clashes.length > 0,
    null, { timeout: 10_000 }
  ).catch(() => fail('detection found ' + detected + ' clash(es) but they never reached app state'));

  const sample = await page.evaluate(() => {
    const c = window._ccLatestState.clashes[0];
    return c ? c.type + ' ' + (c.title || c.aiTitle || '') : '';
  });
  console.log('SMOKE OK — model loaded, detection found ' + detected + ' clash(es), state updated; first: ' + sample);
} finally {
  await browser.close();
  server.close();
}
