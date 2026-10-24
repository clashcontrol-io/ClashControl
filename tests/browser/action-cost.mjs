#!/usr/bin/env node
// "The action costs what it changes": a small state change in the clash
// review UI must re-render only what it changed, independent of how many
// clashes the run produced. Synthetic two-model federation result (tests/
// fixtures/synthetic-conflicts.js generateGroupedClashes: open hard crossings,
// one root-cause group per MEP run) loaded straight into the real app.
//
// Checked, with the clash list open (always grouped by root-cause element):
//   * page DOM size stays bounded and does not grow with the clash count
//     (two sizes)
//   * no-op UPD_PREFS renders zero clash rows / group headers
//   * one clash's status change renders <= 3 rows
//   * selecting another clash renders <= 3 rows
//   * a filter keystroke writes nothing to IndexedDB (project persistence is
//     for real changes only)
//   * windowed list keeps working: J/K, scroll-to-active into a far group,
//     collapsing a group
// Render counts are the primary signal (window.__ccRenderCount, only present
// with ?ccRenderCount=1); settle times (median of >= 5 repetitions, measured
// in the page up to the end of React's work + a forced layout) are a generous
// secondary check because headless SwiftShader timings are noisy.
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/action-cost.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateGroupedClashes } = require(join(root, 'tests/fixtures/synthetic-conflicts.js'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

const SIZES = [{ n: 2000, groups: 60 }, { n: 4000, groups: 120 }];
const REPS = 7;
const LIMITS = { domNodes: 3000, domGrowth: 1.15, noopMs: 40, statusRows: 3, statusMs: 60, selectRows: 3, selectMs: 50, keyMs: 50, saveTaskMs: 100 };

let failures = 0;
function fail(msg) { console.error('ACTION COST FAIL: ' + msg); failures++; }
function ok(msg) { console.log('ACTION COST OK — ' + msg); }
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(root, p === '/' ? 'index.html' : p.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const exe = process.env.CC_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(exe ? {
  executablePath: exe,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
} : {});
const pageErrors = [];

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {}
    // count IndexedDB writes per object store
    window.__idbWrites = {};
    window.__longTasks = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push({ t: e.startTime, ms: e.duration }); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
    const wrap = (name) => {
      const orig = IDBObjectStore.prototype[name];
      IDBObjectStore.prototype[name] = function () { window.__idbWrites[this.name] = (window.__idbWrites[this.name] || 0) + 1; return orig.apply(this, arguments); };
    };
    wrap('put'); wrap('add');
    // settle: run MessageChannel ticks until the main thread has been quiet
    // for several ticks in a row (React's scheduler and effects run as
    // MessageChannel tasks), then force style + layout so DOM cost counts.
    // ids of the clash rows fully inside the list's viewport (not overscan)
    window.__onScreenIds = function () {
      const sc = document.querySelector('.cc-issue-panel .cc-issue-scroll') || document.querySelector('.cc-issue-panel'); const b = sc.getBoundingClientRect();
      return [...sc.querySelectorAll('[data-item-id]')].filter((e) => { const r = e.getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom; }).map((e) => e.getAttribute('data-item-id'));
    };
    window.__settle = async function (t0) {
      const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
      let end = performance.now(), quiet = 0;
      while (quiet < 6) {
        const a = performance.now(); await tick(); const b = performance.now();
        if (b - a > 1.5) { quiet = 0; end = b; } else quiet++;
      }
      void document.body.offsetHeight;
      return Math.max(end, performance.now() - 0) - t0;
    };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
    const local = async (route, f, ct) => route.fulfill({ status: 200, body: await readFile(join(root, 'node_modules', f)), headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' } });
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await ctx.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => { const s = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1]; await local(route, 'three/' + s); });
    await ctx.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => { const s = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1]; await local(route, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); });
    await ctx.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await ctx.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await ctx.route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/?ccRenderCount=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 120_000 });
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } }));
  return page;
}

// Two models + the synthetic result, clash list open; returns DOM size.
async function loadResult(page, size) {
  const { items } = generateGroupedClashes(size.n, size.groups, { seed: 7 });
  await page.evaluate((its) => {
    window._ccDispatch({ t: 'ADD_MODEL', v: { id: 'model-0', name: 'Model 1', discipline: 'structural', visible: true, elements: [] } });
    window._ccDispatch({ t: 'ADD_MODEL', v: { id: 'model-1', name: 'Model 2', discipline: 'mep', visible: true, elements: [] } });
    window._ccDispatch({ t: 'TAB', v: 'clashes' });
    window._ccDispatch({ t: 'SET_CLASHES', v: its });
  }, items);
  await page.waitForFunction((n) => window._ccLatestState && window._ccLatestState.clashes.length === n && document.querySelector('.cc-issue-panel [data-item-id]'), size.n, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const sm = window.ClashControl.review.summary();
    return { dom: document.getElementsByTagName('*').length, reviewItems: sm.reviewItems, reviewClashes: sm.reviewClashes, groups: window._ccLatestState.clashGroupBy };
  });
}

// Runs fn (string action builder) REPS times, returns per-rep {ms, rows, headers}.
// CC_ACTION_PROFILE=1 prints the top self-time functions of each action
// (CPU profile over its repetitions) — for finding what an action costs.
async function profileTop(cdp, prof) {
  const nodes = prof.profile.nodes, self = new Map(), byId = new Map(nodes.map((n) => [n.id, n]));
  const dt = prof.profile.timeDeltas, samples = prof.profile.samples;
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]); const cf = n.callFrame;
    const k = (cf.functionName || '(anon)') + ' ' + (cf.url || '').split('/').pop() + ':' + (cf.lineNumber + 1);
    self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000);
  }
  return [...self.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => v.toFixed(1) + ' ms  ' + k).join('\n    ');
}
async function measure(page, label, build) {
  const out = [];
  const cdp = process.env.CC_ACTION_PROFILE === '1' ? await page.context().newCDPSession(page) : null;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  for (let i = 0; i < REPS; i++) {
    const r = await page.evaluate(async ([src, i]) => {
      const fn = new Function('i', src);
      const prep = fn(i); // { act: () => void }
      const rc = window.__ccRenderCount;
      if (rc) Object.keys(rc).forEach((k) => { rc[k] = 0; });
      const t0 = performance.now();
      prep();
      const ms = await window.__settle(t0);
      return { ms, rows: rc ? rc.rows : NaN, headers: rc ? rc.headers : NaN };
    }, [build, i]);
    out.push(r);
    await page.waitForTimeout(60);
  }
  if (cdp) { const prof = await cdp.send('Profiler.stop'); console.log('  profile ' + label + ':\n    ' + await profileTop(cdp, prof)); await cdp.detach(); }
  const res = { ms: median(out.map((o) => o.ms)), rows: Math.max(...out.map((o) => o.rows)), headers: Math.max(...out.map((o) => o.headers)) };
  console.log(`  ${label}: median ${res.ms.toFixed(1)} ms, max rows rendered ${res.rows}, max group headers rendered ${res.headers}`);
  return res;
}

try {
  const doms = [];
  let page = null;
  for (let si = 0; si < SIZES.length; si++) {
    const size = SIZES[si];
    const p = await newPage();
    const info = await loadResult(p, size);
    console.log(`size ${size.n} clashes / ${size.groups} runs: ${JSON.stringify(info)}`);
    if (info.reviewClashes !== size.n || info.reviewItems < 50) fail(`fixture not as intended (review clashes ${info.reviewClashes}, review items ${info.reviewItems})`);
    if (JSON.stringify(info.groups) !== '["element"]') fail('list is not grouped by root-cause element: ' + JSON.stringify(info.groups));
    doms.push(info.dom);
    if (info.dom > LIMITS.domNodes) fail(`page DOM has ${info.dom} nodes with ${size.n} clashes (limit ${LIMITS.domNodes})`);
    else ok(`page DOM ${info.dom} nodes with ${size.n} clashes`);
    if (si === 0) page = p; else await p.context().close();
  }
  if (doms[1] > doms[0] * LIMITS.domGrowth) fail(`DOM grows with clash count: ${doms[0]} -> ${doms[1]} nodes`);
  else ok(`DOM does not grow with clash count: ${doms[0]} -> ${doms[1]} nodes`);

  // let any pending autosave of the load finish first
  await page.waitForTimeout(3000);

  // ── no-op prefs update ──
  const noop = await measure(page, 'no-op UPD_PREFS', `return () => window._ccDispatch({ t: 'UPD_PREFS', u: {} });`);
  if (!(noop.rows === 0 && noop.headers === 0)) fail(`no-op UPD_PREFS rendered ${noop.rows} rows / ${noop.headers} headers (expected 0)`);
  else ok('no-op UPD_PREFS renders no clash rows or group headers');
  if (noop.ms > LIMITS.noopMs) fail(`no-op UPD_PREFS settles in ${noop.ms.toFixed(1)} ms (limit ${LIMITS.noopMs})`);

  // ── one clash's status (a row on screen, a different one each time) ──
  const status = await measure(page, 'UPD_CLASH status', `
    const ids = window.__onScreenIds();
    const id = ids[(i * 3 + 1) % ids.length];
    return () => window._ccDispatch({ t: 'UPD_CLASH', id, u: { status: i % 2 ? 'open' : 'in_progress' } });`);
  if (!(status.rows <= LIMITS.statusRows)) fail(`one status change rendered ${status.rows} rows (limit ${LIMITS.statusRows})`);
  else ok(`one status change renders ${status.rows} row(s), ${status.headers} group header(s)`);
  if (status.ms > LIMITS.statusMs) fail(`status change settles in ${status.ms.toFixed(1)} ms (limit ${LIMITS.statusMs})`);

  // ── the autosave of those edits: it happens, and costs what changed ──
  const saveWin = await page.evaluate(() => ({ t: performance.now(), writes: window.__idbWrites.projects || 0 }));
  await page.waitForTimeout(6000);
  const save = await page.evaluate((w) => ({ writes: (window.__idbWrites.projects || 0) - w.writes, maxTask: Math.max(0, ...window.__longTasks.filter((x) => x.t >= w.t).map((x) => x.ms)) }), saveWin);
  console.log(`  autosave after the status edits: ${save.writes} project write(s), longest main-thread task ${save.maxTask.toFixed(0)} ms`);
  if (save.writes < 1) fail('status edits were not saved to the project store');
  if (save.maxTask > LIMITS.saveTaskMs) fail(`autosave blocked the main thread for ${save.maxTask.toFixed(0)} ms (limit ${LIMITS.saveTaskMs})`);
  else ok('autosave of a status edit stays a short task');

  // ── select a clash ──
  const select = await measure(page, 'ACTIVE (select)', `
    const ids = window.__onScreenIds();
    const id = ids[(i * 2 + 2) % ids.length];
    return () => window._ccDispatch({ t: 'ACTIVE', id });`);
  if (!(select.rows <= LIMITS.selectRows)) fail(`selecting a clash rendered ${select.rows} rows (limit ${LIMITS.selectRows})`);
  else ok(`selecting a clash renders ${select.rows} row(s)`);
  if (select.ms > LIMITS.selectMs) fail(`select settles in ${select.ms.toFixed(1)} ms (limit ${LIMITS.selectMs})`);
  await page.evaluate(() => window._ccDispatch({ t: 'ACTIVE', id: null }));

  // ── filter keystrokes: cheap, and never project persistence ──
  await page.waitForTimeout(3000); // autosave of the status edits above
  const before = await page.evaluate(() => Object.assign({}, window.__idbWrites));
  const key = await measure(page, 'filter keystroke', `
    const inp = document.querySelector('.cc-issue-panel input[type="text"][placeholder^="Filter"]');
    const v = ['R', 'Ru', 'Run', 'Run ', 'Run 1', 'Run 12', 'Run 1'][i % 7];
    return () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, v); inp.dispatchEvent(new Event('input', { bubbles: true })); };`);
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => Object.assign({}, window.__idbWrites));
  const projWrites = (after.projects || 0) - (before.projects || 0);
  if (projWrites !== 0) fail(`filter typing wrote the project to IndexedDB ${projWrites} time(s)`);
  else ok('filter typing performs no project write');
  if (key.ms > LIMITS.keyMs) fail(`filter keystroke settles in ${key.ms.toFixed(1)} ms (limit ${LIMITS.keyMs})`);
  const shown = await page.evaluate(() => document.querySelectorAll('.cc-issue-panel [data-item-id]').length);
  if (!shown) fail('filter "Run 1" shows no rows');
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_FILTERS', u: { search: '' } }));
  await page.waitForTimeout(300);

  // ── windowed list still behaves: J/K, scroll-to-active, collapse ──
  const firstId = await page.evaluate(() => window.ClashControl.review.summary().items[0].ids[0]);
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  await page.keyboard.press('j');
  await page.waitForTimeout(200);
  const afterJ = await page.evaluate(() => window._ccLatestState.activeId);
  await page.keyboard.press('j');
  await page.waitForTimeout(200);
  await page.keyboard.press('k');
  await page.waitForTimeout(200);
  const afterK = await page.evaluate(() => window._ccLatestState.activeId);
  if (afterJ !== firstId || afterK !== firstId) fail(`J/K navigation: first row ${firstId}, after J ${afterJ}, after J,K ${afterK}`);
  else ok('J/K move through the windowed list');
  // a clash in the last group: becomes mounted and visible after selection
  const far = await page.evaluate(() => {
    const sm = window.ClashControl.review.summary();
    const last = sm.items[sm.items.length - 1];
    return last.ids[last.ids.length - 1];
  });
  await page.evaluate((id) => window._ccDispatch({ t: 'ACTIVE', id }), far);
  await page.waitForTimeout(800);
  const farVis = await page.evaluate((id) => {
    const el = document.querySelector('.cc-issue-panel [data-item-id="' + id + '"]');
    if (!el) return { mounted: false };
    const sc = el.closest('.cc-issue-scroll'); const r = el.getBoundingClientRect(), b = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    return { mounted: true, visible: r.bottom > b.top && r.top < b.bottom };
  }, far);
  if (!farVis.mounted || !farVis.visible) fail('scroll-to-active into the last group: ' + JSON.stringify(farVis));
  else ok('selecting a clash in the last group scrolls it into view');
  await page.evaluate(() => window._ccDispatch({ t: 'ACTIVE', id: null }));
  // collapse the first group from its header
  const coll = await page.evaluate(async () => {
    const sc = document.querySelector('.cc-issue-panel .cc-issue-scroll'); sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll'));
    let hdr = null;
    for (let t = 0; t < 30 && !hdr; t++) { await new Promise((r) => setTimeout(r, 100)); hdr = document.querySelector('.cc-issue-panel [data-element-group-key]'); }
    if (!hdr) return { error: 'no group header mounted at the top of the list' };
    const key = hdr.getAttribute('data-element-group-key');
    const sm = window.ClashControl.review.summary();
    const grp = sm.items.find((it) => it.key === key);
    // re-query the header's button per click: collapsing re-renders the header
    const btn = () => document.querySelector('.cc-issue-panel [data-element-group-key="' + key + '"] button[aria-expanded]');
    const shownNow = () => grp.ids.filter((id) => document.querySelector('.cc-issue-panel [data-item-id="' + id + '"]')).length;
    // wait for the outcome itself (a busy machine can take longer than a frame or two to render)
    const until = async (ok) => { for (let t = 0; t < 30 && !ok(); t++) await new Promise((r) => setTimeout(r, 100)); };
    btn().click();
    await until(() => shownNow() === 0);
    const stillShown = shownNow();
    btn().click();
    await until(() => shownNow() > 0);
    const back = shownNow();
    return { stillShown, back };
  });
  if (coll.stillShown !== 0 || coll.back === 0) fail('collapse/expand a group: ' + JSON.stringify(coll));
  else ok(`collapsing a group unmounts its rows, expanding brings ${coll.back} back`);

  // pinned group header: scrolled into a group, its header stays on top
  const pin = await page.evaluate(async () => {
    const sc = document.querySelector('.cc-issue-panel .cc-issue-scroll');
    const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))));
    sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); await wait();
    const atTop = document.querySelectorAll('.cc-issue-panel [data-pinned-header]').length;
    // scroll a bit past the first multi-row group's header
    const hdr = document.querySelector('.cc-issue-panel [data-element-group-key]');
    const label = hdr && hdr.getAttribute('data-element-group-key');
    sc.scrollTop = 140; sc.dispatchEvent(new Event('scroll')); await wait(); await wait();
    const p = document.querySelector('.cc-issue-panel [data-pinned-header]');
    const pr = p && p.firstElementChild.getBoundingClientRect(), br = sc.getBoundingClientRect();
    return { atTop, pinned: !!p, atViewportTop: !!pr && Math.abs(pr.top - br.top) <= 2, hasHeader: !!(p && p.querySelector('[data-element-group-key]')), label };
  });
  if (pin.atTop !== 0 || !pin.pinned || !pin.atViewportTop || !pin.hasHeader) fail('pinned group header: ' + JSON.stringify(pin));
  else ok('the current group header stays pinned at the top while scrolling (none at the very top)');

  // ── D (deny) → the next clash ON SCREEN, and the camera shows that one ──
  // (the reducer used to pick "next" from every non-denied clash and fly
  // there 100 ms after the list's own advance, hidden ones included)
  const deny = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sc = document.querySelector('.cc-issue-panel [data-item-id]').closest('[style*="overflow"]') || document.querySelector('.cc-issue-panel');
    sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); await wait(150);
    const rows = () => [...document.querySelectorAll('.cc-issue-panel [data-item-id]')].map((r) => r.dataset.itemId);
    const first = rows()[0], second = rows()[1];
    window._ccDispatch({ t: 'ACTIVE', id: first }); await wait(200);
    const marks = []; const orig = window._ccShowActiveClashMarker;
    window._ccShowActiveClashMarker = function(pt) { marks.push([pt[0], pt[1], pt[2]]); return orig && orig.apply(this, arguments); };
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    await wait(600);
    window._ccShowActiveClashMarker = orig;
    const st = window._ccLatestState, act = st.clashes.find((c) => c.id === st.activeId);
    return { first, second, active: st.activeId, firstStatus: (st.clashes.find((c) => c.id === first) || {}).status,
      activeShown: rows().indexOf(st.activeId) !== -1, lastMark: marks[marks.length - 1] || null, activePoint: act && act.point ? [act.point[0], act.point[1], act.point[2]] : null };
  });
  if (deny.firstStatus !== 'denied' || deny.active !== deny.second || !deny.activeShown || !deny.lastMark || JSON.stringify(deny.lastMark) !== JSON.stringify(deny.activePoint)) fail('deny → next: ' + JSON.stringify(deny));
  else ok('D denies and moves to the next row on screen; the camera marker is that clash');

  console.log('SUMMARY ' + JSON.stringify({ dom: doms, noop, status, save, select, key, projWrites }));
} catch (e) {
  fail('exception: ' + (e && e.stack || e));
} finally {
  if (pageErrors.length) fail('page errors: ' + JSON.stringify(pageErrors.slice(0, 5)));
  await browser.close();
  server.close();
}
if (failures) { console.error(`ACTION COST: ${failures} failure(s)`); process.exit(1); }
console.log('ACTION COST: all checks passed');
