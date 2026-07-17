#!/usr/bin/env node
// Real-browser lock for the storey-scan completeness fix's UI half. The pure
// scan logic (always covers the full file, returns truncated:true past the
// byte ceiling) is locked in tests/storey-scope-incremental-scan.test.js —
// this checks that StoreyScopeModal actually HONORS that flag: locks every
// checkbox, shows a warning, and forces the confirm button to the safe
// full-load path rather than letting a user scope down to a possibly-
// incomplete storey list. Runs as its own browser session (rather than
// folding into smoke.mjs) because it permanently monkey-patches
// window._ccExtractStoreyNamesFromIfcFileIncremental to simulate a
// truncated scan without needing an actual multi-hundred-MB fixture file —
// that patch would leak into and interfere with smoke.mjs's later,
// unrelated file-load steps if run in the same page.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

const ROOT = '/home/user/ClashControl';
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
// Optional deterministic dependency mirror for restricted/offline test
// environments (matches tests/browser/smoke.mjs's convention exactly). CI
// has real internet access and only npm-installs playwright itself, not the
// app's CDN-mirrored packages — routing unconditionally here 404s in CI
// with no node_modules/react to read from.
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

function fail(msg) { console.error('STOREY TRUNCATED CHECK FAIL: ' + msg); process.exitCode = 1; }

await page.goto(`http://127.0.0.1:${port}/?ccSafety=ccUiStoreyChooser`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });

// Monkey-patch the pre-scan to simulate a truncated result — the call site
// goes through window._ccExtractStoreyNamesFromIfcFileIncremental, so this
// intercepts the real code path without needing an actual huge fixture file.
await page.evaluate(() => {
  window._ccExtractStoreyNamesFromIfcFileIncremental = function() {
    return Promise.resolve({ names: ['Level 1', 'Level 2', 'Level 3'], truncated: true });
  };
});

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

const warningVisible = await page.getByText(/larger than the pre-scan can fully cover/).isVisible().catch(() => false);
if (!warningVisible) fail('truncated warning banner did not render');

const checkboxes = page.locator('input[type=checkbox]');
const count = await checkboxes.count();
let anyEnabled = false;
for (let i = 0; i < count; i++) {
  if (await checkboxes.nth(i).isEnabled()) anyEnabled = true;
}
if (anyEnabled) fail('at least one checkbox is still enabled while truncated — partial selection should be fully locked out');

const confirmLabel = await page.getByRole('button', { name: /Load all/ }).textContent().catch(() => null);
if (!confirmLabel) fail('confirm button does not read "Load all" while truncated');

// Confirming should still work (the safe, unscoped full-load path) and must
// NOT set window._ccNextLoadScope.
await page.getByRole('button', { name: /Load all/ }).click();
await page.waitForTimeout(300);
const scopeAfterConfirm = await page.evaluate(() => window._ccNextLoadScope);
if (scopeAfterConfirm) fail('confirming "Load all" while truncated incorrectly set a load scope: ' + JSON.stringify(scopeAfterConfirm));

console.log(process.exitCode ? 'STOREY TRUNCATED CHECK: see failures above' : 'STOREY TRUNCATED CHECK OK — truncated scan locks the picker to full-load-only, warns the user, and confirming still works safely');
await browser.close();
server.close();
