#!/usr/bin/env node
// UI that follows state through events, not polling timers:
// - every selection change, deselect included, is announced at once as
//   'cc-selected-el-changed', which the Details drawer listens to (it used a
//   300 ms poll to notice deselection);
// - the install banner follows the deferred install prompt through
//   'cc-install-available', announced by addons/pwa.js when it stores the
//   prompt and when it is used / the app is installed (was a 2 s poll);
// - the update banner appears on 'cc-update-available' (addons/pwa.js now
//   announces it; nothing did before, so the banner never showed — the
//   announcement itself is locked by tests/pwa-events.test.js);
// - the view cube follows the right panel through 'cc-panel-resize', also
//   when the panel unmounts (was a 400 ms poll).
// Also asserts no setInterval callback runs for these in an idle page.
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/event-driven-ui.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const IFC = generateSyntheticIfc({ storeyCount: 1, wallsPerStorey: 3 });
let failed = false;
function fail(msg) { console.error('EVENT UI FAIL: ' + msg); failed = true; }
function ok(msg) { console.log('EVENT UI OK — ' + msg); }

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__walls.ifc') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(IFC); }
    const file = normalize(join(root, p === '/' ? 'index.html' : p.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CC_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {}
    // count interval callbacks by period, to see that no poll runs
    window.__ivRuns = {};
    const si = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) {
      const key = String(ms);
      return si.call(window, function () { window.__ivRuns[key] = (window.__ivRuns[key] || 0) + 1; return typeof fn === 'function' ? fn.apply(this, arguments) : undefined; }, ms, ...rest);
    };
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  await page.evaluate(async () => {
    const buf = await (await fetch('/__walls.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'walls.ifc')]);
    for (let t = 0; t < 600; t++) {
      const s = window._ccLatestState;
      if (s && s.models.length && s.models[0].elements.length && !window._ccModelLoading) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('model did not load');
  });

  // ── selection → drawer, through the event ──
  const sel = await page.evaluate(async () => {
    const S = window._ccState3d, out = {};
    const changed = []; window.addEventListener('cc-selected-el-changed', () => changed.push(!!window._ccSelectedEl));
    const click = async (eye, target) => {
      S.orbit.target.set(target[0], target[1], target[2]);
      S.camera.position.set(eye[0], eye[1], eye[2]);
      S.camera.lookAt(S.orbit.target); S.camera.updateMatrixWorld(true); S.orbit.sync();
      S._forceCull = true; window._ccDispatch({ t: 'UPD_PREFS', u: {} });
      await new Promise((r) => setTimeout(r, 400));
      const c = S.renderer.domElement, r = c.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      c.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
      c.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0, bubbles: true }));
      await new Promise((r) => setTimeout(r, 150)); // well under the old 300 ms poll
    };
    // wall 0 sits at the origin, 3 m high
    await click([0, 1.5, 8], [0, 1.5, 0]);
    out.selected = !!window._ccSelectedEl;
    out.name = window._ccSelectedEl && window._ccSelectedEl.props && window._ccSelectedEl.props.name;
    await click([0, 50, 8], [0, 60, 0]); // empty sky
    out.deselected = !window._ccSelectedEl;
    out.events = changed;
    return out;
  });
  // the drawer listens to this event (setDrawerEl(window._ccSelectedEl))
  if (!sel.selected || !sel.deselected || JSON.stringify(sel.events) !== '[true,false]') fail('selection changes are not announced at once (select, then deselect): ' + JSON.stringify(sel));
  else ok('select and deselect are each announced at once (cc-selected-el-changed), the drawer follows without a poll');

  // ── install prompt + update banner, through the events ──
  const pwa = await page.evaluate(async () => {
    const out = {};
    const wait = async (ok) => { for (let t = 0; t < 20 && !ok(); t++) await new Promise((r) => setTimeout(r, 25)); return ok(); };
    if (typeof window._ccPwaInstallPrompt !== 'function') return { skip: 'pwa addon not loaded' };
    const ev = new Event('beforeinstallprompt', { cancelable: true });
    let choice; ev.prompt = () => {}; ev.userChoice = new Promise((r) => { choice = r; });
    const before = document.body.innerText;
    window.dispatchEvent(ev);
    out.stored = window._ccPwaInstallPrompt() === ev;
    out.bannerShown = await wait(() => document.body.innerText.length > before.length && /install/i.test(document.body.innerText));
    window._ccPwaPromptInstall(); choice({ outcome: 'dismissed' });
    out.cleared = await wait(() => !window._ccPwaInstallPrompt());
    const upd = () => !!document.querySelector('.cc-bottom-banner[aria-label="App update"]');
    out.updateBefore = upd();
    window._ccUpdateAvailable = true; window.dispatchEvent(new CustomEvent('cc-update-available'));
    out.updateShown = await wait(upd);
    return out;
  });
  if (pwa.skip) console.log('EVENT UI NOTE — ' + pwa.skip);
  else {
    if (!pwa.stored || !pwa.bannerShown) fail('install prompt did not reach the banner by event: ' + JSON.stringify(pwa));
    else ok('a deferred install prompt shows the install banner at once (cc-install-available)');
    if (!pwa.cleared) fail('using the install prompt did not clear it: ' + JSON.stringify(pwa));
    if (pwa.updateBefore || !pwa.updateShown) fail('update banner did not follow cc-update-available: ' + JSON.stringify(pwa));
    else ok('cc-update-available shows the update banner');
  }

  // ── idle: none of the removed polls run ──
  const idle = await page.evaluate(async () => {
    window.__ivRuns = {};
    await new Promise((r) => setTimeout(r, 2500));
    return window.__ivRuns;
  });
  const polls = ['300', '400', '2000'].filter((k) => idle[k]);
  if (polls.length) fail('interval callbacks with the removed poll periods still run: ' + JSON.stringify(idle));
  else ok('no 300 / 400 / 2000 ms polls run while idle (' + JSON.stringify(idle) + ')');

  if (errors.length) fail('page errors: ' + errors.slice(0, 3).join(' | '));
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? 'EVENT UI: FAIL' : 'EVENT UI: PASS');
process.exit(failed ? 1 : 0);
