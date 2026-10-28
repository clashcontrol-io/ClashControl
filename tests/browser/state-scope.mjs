// State scope (docs/INTERNALS.md §21.64), in the real app: every state key
// belongs to one lifecycle — project / view / session / ui — and lifecycle
// events only touch their own scope.
//
// Checks (the smoke fixture: two crossing walls, one clash):
//   - every state key is classified (window._ccStateScope.unclassified());
//   - the section survives a workspace switch, opening / closing panel tabs
//     and selecting a clash it does not hide; selecting a clash it DOES hide
//     lifts it;
//   - section + hidden categories survive a page refresh (saved with the
//     project), the restored plane really clips;
//   - a selected element, an isolation and the undo history do not survive a
//     project switch; the new project starts with no section and its own
//     (empty) view; switching back restores the first project's section;
//   - the old per-browser `cc_section` key is adopted once by the first
//     project opened, then removed.
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/state-scope.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

let failures = 0;
function fail(msg) { console.error('STATE-SCOPE FAIL: ' + msg); failures++; }
function ok(msg) { console.log('STATE-SCOPE OK — ' + msg); }
function check(cond, msg, detail) { if (cond) ok(msg); else fail(msg + (detail ? ' :: ' + detail : '')); }

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
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const pageErrors = [];

const booted = () => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccLatestState && window._ccState3d && window._ccState3d.scene;
const modelsIn = () => { const s = window._ccLatestState; return s && !s.switchingProject && s.models.length > 0 && s.models.every((m) => (m.elements || []).length >= 2); };
// what the viewer shows: state + the planes that really clip the model
const view = () => {
  const s = window._ccLatestState, S = window._ccState3d;
  let clipped = 0;
  if (S && S.mg) S.mg.traverse((o) => { if (o.isMesh && o.material) { const m = Array.isArray(o.material) ? o.material[0] : o.material; if (m.clippingPlanes && m.clippingPlanes.length) clipped++; } });
  return { axis: s.sectionAxis, pos: s.sectionPos, box: !!(s.sectionBox && s.sectionBox.enabled), hidden: Object.keys(s.hiddenClasses || {}), planes: (window._ccActivePlanes || []).length, clipped, project: s.activeProject };
};

try {
  const context = await browser.newContext({ viewport: { width: 1300, height: 850 }, locale: 'en-GB' });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(booted, null, { timeout: 60_000 });

  // ── legacy per-browser key: adopted once by the first project opened ──
  await page.evaluate(() => localStorage.setItem('cc_section', JSON.stringify({ axis: 'z', pos: 0.3, custom: null, flip: false, hatch: false, box: null })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(booted, null, { timeout: 60_000 });
  await page.waitForFunction(() => window._ccLatestState.sectionAxis === 'z', null, { timeout: 15_000 }).catch(() => {});
  const legacy = await page.evaluate(() => ({ axis: window._ccLatestState.sectionAxis, pos: window._ccLatestState.sectionPos, key: localStorage.getItem('cc_section') }));
  check(legacy.axis === 'z' && Math.abs(legacy.pos - 0.3) < 1e-9 && legacy.key === null, 'the old per-browser cc_section is adopted by the open project, then removed', JSON.stringify(legacy));
  await page.evaluate(() => window._ccDispatch({ t: 'SECTION', axis: null }));

  // ── project A: one model, one clash ──
  await page.evaluate(async () => { window.ClashControl.loadFiles([new File([await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer()], 'smoke-clash.ifc')]); });
  await page.waitForFunction(modelsIn, null, { timeout: 120_000 });
  const nClash = await page.evaluate(async () => { const r = await window.ClashControl.runDetection({ selfClashModels: 'all', excludeSelf: false }); return r ? r.length : 0; });
  await page.waitForFunction(() => window._ccLatestState.clashes.length > 0, null, { timeout: 10_000 }).catch(() => {});
  check(nClash > 0, 'fixture detects its clash', String(nClash));
  const projA = await page.evaluate(() => window._ccLatestState.activeProject);

  const unclassified = await page.evaluate(() => window._ccStateScope.unclassified());
  check(unclassified.length === 0, 'every state key belongs to a scope', unclassified.join(', '));

  // a plane that does NOT hide the clash point: keep side contains it
  const keepPos = await page.evaluate(async () => {
    const c = window._ccLatestState.clashes[0], T = window.THREE, p = new T.Vector3(...c.point);
    for (const pos of [0.15, 0.85, 0.3, 0.7]) {
      window._ccDispatch({ t: 'SECTION', axis: 'x', pos });
      await new Promise((r) => setTimeout(r, 150));
      const pl = window._ccState3d._sectionPlanes && window._ccState3d._sectionPlanes[0];
      if (pl && pl.distanceToPoint(p) > 0.01) return pos;
    }
    return null;
  });
  check(keepPos != null, 'found a section position that keeps the clash in sight', String(keepPos));
  await page.waitForTimeout(300);
  let v = await page.evaluate(view);
  check(v.axis === 'x' && v.planes === 1 && v.clipped > 0, 'section plane is on and clips the model', JSON.stringify(v));

  // ── workspace / tab / selection never reset the view ──
  await page.getByText('Review', { exact: true }).first().click();
  await page.waitForTimeout(500);
  for (const tab of ['models', 'clashes', 'issues', null]) {
    await page.evaluate((tab) => window._ccDispatch({ t: 'TAB', v: tab }), tab);
    await page.waitForTimeout(250);
  }
  v = await page.evaluate(view);
  check(v.axis === 'x' && v.pos === keepPos && v.planes === 1 && v.clipped > 0, 'section survives Present → Review and opening / closing panel tabs', JSON.stringify(v));
  await page.evaluate(() => window._ccDispatch({ t: 'ACTIVE', id: window._ccLatestState.clashes[0].id }));
  await page.waitForTimeout(300);
  v = await page.evaluate(view);
  check(v.axis === 'x' && v.planes === 1, 'selecting a clash the section does not hide keeps the section', JSON.stringify(v));
  await page.evaluate(() => window._ccDispatch({ t: 'ACTIVE', id: null }));
  // flip to the other side: now the plane hides the clash point
  await page.evaluate(() => window._ccDispatch({ t: 'SECTION_FLIP' }));
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => { const c = window._ccLatestState.clashes[0], pl = window._ccState3d._sectionPlanes[0]; return pl.distanceToPoint(new window.THREE.Vector3(...c.point)); });
  await page.evaluate(() => window._ccDispatch({ t: 'ACTIVE', id: window._ccLatestState.clashes[0].id }));
  await page.waitForTimeout(300);
  v = await page.evaluate(view);
  check(hidden < 0 && v.axis === null && v.planes === 0, 'selecting a clash the section hides lifts the section', JSON.stringify({ hidden, v }));
  await page.evaluate(() => window._ccDispatch({ t: 'ACTIVE', id: null }));
  await page.getByText('Present', { exact: true }).first().click();

  // ── refresh keeps the project's view ──
  await page.evaluate((pos) => {
    window._ccDispatch({ t: 'SECTION', axis: 'x', pos });
    window._ccDispatch({ t: 'TOGGLE_CLASS_VIS', key: 'byType:IfcDoor' });
  }, keepPos);
  await page.waitForTimeout(3500); // autosave debounce (+ the pagehide flush)
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(booted, null, { timeout: 60_000 });
  await page.waitForFunction(modelsIn, null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  v = await page.evaluate(view);
  check(v.axis === 'x' && v.pos === keepPos && v.planes === 1 && v.clipped > 0 && v.hidden.includes('byType:IfcDoor'),
    'section plane and hidden categories survive a refresh, and the plane clips the restored model', JSON.stringify(v));

  // ── select an element (a real click on a wall) and isolate it ──
  const pt = await page.evaluate(() => {
    const S = window._ccState3d, T = window.THREE, m = window._ccLatestState.models[0], r = S.renderer.domElement.getBoundingClientRect();
    window._ccDispatch({ t: 'SECTION', axis: null });
    const el = m.elements.find((e) => e.box && !e.box.isEmpty());
    const p = el.box.getCenter(new T.Vector3()).project(S.camera);
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  });
  await page.waitForTimeout(300);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(500);
  const sel = await page.evaluate(() => ({ el: window._ccSelectedExpressId, refs: (window._ccSelectedRefs || []).length }));
  check(sel.el != null && sel.refs === 1, 'clicking a wall selects it', JSON.stringify(sel));
  await page.evaluate(() => { window._ccIsolate(window._ccSelectedRefs.slice()); });
  await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: 'models' }));
  await page.waitForTimeout(200);
  check(await page.evaluate(() => !!window._ccIsIsolated), 'an isolation survives opening a panel tab');
  await page.evaluate((pos) => window._ccDispatch({ t: 'SECTION', axis: 'x', pos }), keepPos);
  await page.waitForTimeout(300);
  const undoA = await page.evaluate(() => window._ccUndoStack.length);

  // ── project B: nothing of A's selection / view / history ──
  const projB = await page.evaluate(() => window.ClashControl.projects.create('Scope B'));
  await page.waitForFunction((b) => { const s = window._ccLatestState; return s.activeProject === b && !s.switchingProject; }, projB, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const b = await page.evaluate(() => {
    const s = window._ccLatestState;
    return { view: null, sel: window._ccSelectedExpressId, refs: (window._ccSelectedRefs || []).length, isolated: !!window._ccIsIsolated,
      undo: window._ccUndoStack.length, undoLabels: window._ccUndoStack.map((e) => e.label).join(','), axis: s.sectionAxis, hidden: Object.keys(s.hiddenClasses || {}).length, models: s.models.length,
      clashes: s.clashes.length, activeId: s.activeId, selected: Object.keys(s.selected || {}).length, rulesMatrix: Object.keys((s.rules && s.rules.matrixRules) || {}).length };
  });
  check(b.sel == null && b.refs === 0, 'the selected element does not carry into another project', JSON.stringify(b));
  check(!b.isolated, 'an isolation does not carry into another project', JSON.stringify(b));
  check(undoA > 0 && b.undo === 0, 'undo history does not carry into another project', `A ${undoA} → B ${b.undo} (${b.undoLabels})`);
  check(b.axis === null && b.hidden === 0 && b.models === 0 && b.clashes === 0 && b.activeId == null && b.selected === 0,
    'the new project starts without A\'s section, hidden categories, models or clashes', JSON.stringify(b));

  // ── back to A: its own view comes back ──
  await page.evaluate((a) => window.ClashControl.projects.switchTo(a), projA);
  await page.waitForFunction(modelsIn, null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  v = await page.evaluate(view);
  check(v.project === projA && v.axis === 'x' && v.pos === keepPos && v.planes === 1 && v.clipped > 0 && v.hidden.includes('byType:IfcDoor'),
    'switching back restores the project\'s own section and hidden categories', JSON.stringify(v));

  check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.join(' | '));
  await context.close();
} catch (e) {
  fail('unexpected: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nSTATE SCOPE OK');
