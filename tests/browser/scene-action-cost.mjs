#!/usr/bin/env node
// "An action costs only what the action itself should cost" — scene and
// review actions on a loaded, detected federation (docs/INTERNALS.md §21.54).
//
// Fixture: tests/fixtures/generate-building-ifc.js (ci scale, three models).
// The MEP model loads plain (one Mesh per element); structure + architecture
// load with window._ccForceBatch (BatchedMesh + off-scene proxies), so every
// path sees both kinds. expressIds repeat across the models.
//
// Checked (counts are the primary signal, results are compared with a
// brute-force / from-scratch reference in the same page):
//   * mesh lookup (S._findMeshByRef) = first match of a full S.mg walk (+ the
//     proxy fallback), plain and ghosted (split-outs), with no S.mg walk;
//   * ghostOthers while ghosted (delta) = unghostAll + full ghost: same
//     materials, visibility, batch slots, split-out order and PIXELS; no S.mg
//     walk; batch slot writes bounded by the kept elements;
//   * temp hide / unhide: only the named elements' batch slots are written;
//     a ghost split-out slot stays hidden under a temp hide;
//   * rename / colour / storey hide / theme / visibility toggle walk no model
//     for materials or clipping (render-style / section effects), and the
//     triage / review models rebuild only when a field they read changed;
//     the review set equals a from-scratch rebuild after every edit;
//   * clash markers are not rebuilt by a status edit or a comment change, and
//     are rebuilt by a severity (colour) change;
//   * a search typed forward gives the same review set as the final query
//     typed at once (narrowing), and a non-narrowing extension too;
//   * section plane on + a model hidden and shown again: the plan frame is the
//     cached one (no wall-vertex scan), the plane visual is refitted in place;
//   * render styles classify glass by the mesh's OWN model's element type;
//   * a parked + restored model has visible === true; the last frame of a
//     camera move culls (frustum / LOD) like a forced cull pass.
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/scene-action-cost.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateBuilding } = require(join(root, 'tests/fixtures/generate-building-ifc.js'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

let failures = 0;
function fail(msg) { console.error('SCENE COST FAIL: ' + msg); failures++; }
function ok(msg) { console.log('SCENE COST OK — ' + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local' });
const files = new Map();
for (const k of Object.keys(gen.files)) files.set('/__gen/' + k + '.ifc', Buffer.from(gen.files[k]));
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (files.has(p)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(files.get(p)); }
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
const browser = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {}
});
if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (d) => d.accept());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(`http://127.0.0.1:${port}/?ccRenderCount=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 120_000 });
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } }));
  const load = async (names, batch, n) => {
    await page.evaluate(async ([names, batch]) => {
      window._ccForceBatch = batch;
      const fs = await Promise.all(names.map(async (k) => new File([await (await fetch(k)).arrayBuffer()], k.split('/').pop())));
      window.ClashControl.loadFiles(fs);
    }, [names, batch]);
    await page.waitForFunction((n) => { const s = window._ccLatestState; return s && s.models.length === n && window._ccModelLoading === false && s.models.every((m) => m._propsVersion); }, n, { timeout: 600_000 });
  };
  const names = [...files.keys()];
  const mep = names.filter((k) => /mep/.test(k)), others = names.filter((k) => !/mep/.test(k));
  await load(mep, false, 1);
  await load(others, true, 3);
  await page.evaluate(() => { window._ccForceBatch = false; });
  await sleep(1500);
  const det = await page.evaluate(async () => {
    await window.ClashControl.runDetection({ excludeSameDiscipline: false, selfClashModels: 'none', hard: true, minGap: 0, maxGap: 50, fullRerun: true });
    await new Promise((r) => setTimeout(r, 500));
    window._ccDispatch({ t: 'TAB', v: 'clashes' });
    let batches = 0, plain = 0; window._ccState3d.mg.traverse((o) => { if (o.userData && o.userData._isCCBatch) batches++; else if (o.isMesh && o.userData.expressId != null) plain++; });
    return { clashes: window._ccLatestState.clashes.length, batches, plain, models: window._ccLatestState.models.map((m) => m.elements.length) };
  });
  console.log('fixture: ' + JSON.stringify(det));
  if (!det.batches || !det.plain || det.clashes < 10) throw new Error('fixture lacks batches / plain meshes / clashes: ' + JSON.stringify(det));
  await sleep(1500);

  // ── in-page instrumentation ──
  await page.evaluate(() => {
    const S = window._ccState3d;
    window.__c = { mg: 0, mgStacks: [], writes: 0 };
    let p = S.mg; while (p && !Object.prototype.hasOwnProperty.call(p, 'traverse')) p = Object.getPrototypeOf(p);
    const tr = p.traverse;
    p.traverse = function () {
      if (this === S.mg) {
        const st = new Error().stack || '';
        if (!/updateCulling/.test(st)) { window.__c.mg++; if (window.__c.mgStacks.length < 3) window.__c.mgStacks.push(st.split('\n').slice(2, 5).join(' < ')); }
      }
      return tr.apply(this, arguments);
    };
    window.__batches = [];
    tr.call(S.mg, (o) => { if (o.userData && o.userData._isCCBatch) window.__batches.push(o); });
    window.__batches.forEach((b) => { const f = b.setVisibleAt; b.setVisibleAt = function () { window.__c.writes++; return f.apply(this, arguments); }; });
    window.__reset = () => { window.__c.mg = 0; window.__c.mgStacks = []; window.__c.writes = 0; const k = window._ccListPerfCounters; window.__k0 = Object.assign({}, k); };
    window.__k = () => { const k = window._ccListPerfCounters, o = {}; Object.keys(k).forEach((x) => { o[x] = k[x] - (window.__k0[x] || 0); }); return o; };
    const h = (str) => { let a = 0x811c9dc5; for (let i = 0; i < str.length; i++) { a ^= str.charCodeAt(i); a = Math.imul(a, 16777619) >>> 0; } return a.toString(16); };
    window.__hash = h;
    // full scene state: per mesh (walk order) eid / visible / material (index
    // of first appearance) / ghost; batch slot bits; split-outs by creation
    // order with their parent index; pixels of a fresh render
    window.__digest = () => {
      const mats = new Map(), rows = [], splits = [], slots = [];
      tr.call(S.mg, (o) => {
        if (!o.isMesh) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!mats.has(m)) mats.set(m, mats.size);
        if (o.userData._splitOut) { splits.push({ id: o.id, k: o.parent.userData.modelId + ':' + o.userData.expressId + '@' + o.parent.children.indexOf(o) }); return; }
        rows.push([o.userData.expressId, o.visible ? 1 : 0, mats.get(m), m && m._isCCGhost ? 1 : 0].join(','));
        if (o.userData._isCCBatch) { const ids = o.userData.batchExprIds || []; let v = ''; for (let i = 0; i < ids.length; i++) v += o.getVisibleAt(i) ? '1' : '0'; slots.push(v); }
      });
      splits.sort((a, b) => a.id - b.id);
      S.renderer.render(S.scene, S.camera);
      const px = h(S.renderer.domElement.toDataURL('image/png'));
      return { rows: h(rows.join('|')), slots: h(slots.join('|')), splits: splits.map((x) => x.k).join(' '), px };
    };
    window.__refs = (c) => [{ expressId: c.elemA, modelId: c.modelAId }, { expressId: c.elemB, modelId: c.modelBId }];
  });

  // ── 1. mesh lookup = full walk (+ proxy fallback), plain and ghosted ──
  const lookup = await page.evaluate(() => {
    const S = window._ccState3d, st = window._ccLatestState;
    const brute = (eid, mid) => {
      let f = null;
      S.mg.traverse((o) => { if (f || !o.isMesh || o.userData.expressId !== eid) return; if (mid && (!o.parent || o.parent.userData.modelId !== mid)) return; f = o; });
      if (!f) for (const m of st.models) { if (mid && m.id !== mid) continue; const el = m.elements.find((e) => e.expressId === eid); if (el) { f = (el.meshes && el.meshes[0]) || null; break; } if (mid) break; }
      return f;
    };
    let n = 0, bad = 0;
    const sample = [];
    st.models.forEach((m) => { for (let i = 0; i < m.elements.length; i += 7) sample.push([m.elements[i].expressId, i % 2 ? m.id : null]); });
    const run = () => sample.forEach(([eid, mid]) => { n++; if (S._findMeshByRef(eid, mid) !== brute(eid, mid)) bad++; });
    run();
    const c = st.clashes.find((x) => x.modelAId !== x.modelBId) || st.clashes[0];
    window._ghostOthers(window.__refs(c));
    run();
    window.__reset();
    sample.forEach(([eid, mid]) => S._findMeshByRef(eid, mid));
    const walks = window.__c.mg;
    window._unghostAll();
    return { n, bad, walks };
  });
  check(lookup.bad === 0, `mesh lookup = full walk for ${lookup.n} refs (plain + ghosted split-outs), ${lookup.bad} mismatches`);
  check(lookup.walks === 0, `mesh lookups walk no model (${lookup.walks} S.mg walks)`);

  // ── 2. ghost delta = unghost + full ghost (state + pixels) ──
  const ghost = await page.evaluate(() => {
    const st = window._ccLatestState;
    const cs = st.clashes.slice().sort((a, b) => String(a.elemA).localeCompare(String(b.elemA)));
    const seq = [];
    for (let i = 0; i < cs.length && seq.length < 10; i += Math.max(1, Math.floor(cs.length / 10))) seq.push(window.__refs(cs[i]));
    // a hub kept across two selections, a bare-expressId ref, and a reselect
    if (cs.length > 1) seq.splice(2, 0, [window.__refs(cs[0])[0], window.__refs(cs[1])[1]]);
    seq.push([cs[0].elemA]);
    seq.push(seq[seq.length - 1]);
    const out = [];
    window._unghostAll();
    window._ghostOthers(seq[0]);
    for (let i = 1; i < seq.length; i++) {
      window.__reset();
      const t0 = performance.now();
      window._ghostOthers(seq[i]);
      const ms = performance.now() - t0;
      const walks = window.__c.mg, writes = window.__c.writes;
      const kept = seq[i].length * 4;
      const d1 = window.__digest();
      window._unghostAll();
      window._ghostOthers(seq[i]);
      const d2 = window.__digest();
      out.push({ i, same: JSON.stringify(d1) === JSON.stringify(d2), d1, d2, walks, writes, kept, ms });
    }
    window.__reset();
    const t1 = performance.now(); window._unghostAll(); const unMs = performance.now() - t1;
    return { out, unghost: { walks: window.__c.mg, writes: window.__c.writes, ms: unMs } };
  });
  const gBad = ghost.out.filter((x) => !x.same);
  check(!gBad.length, `ghost delta = unghost + full ghost in ${ghost.out.length} selections (materials, visibility, slots, split-out order, pixels)` + (gBad.length ? ' ' + JSON.stringify(gBad[0]) : ''));
  check(ghost.out.every((x) => x.walks === 0), 'ghost delta walks no model: ' + ghost.out.map((x) => x.walks).join(','));
  check(ghost.out.every((x) => x.writes <= 2 * x.kept), 'ghost delta writes only kept slots: ' + ghost.out.map((x) => x.writes).join(','));
  check(ghost.unghost.walks === 0 && ghost.unghost.writes <= 16, `unghostAll touches only the split slots (${ghost.unghost.writes} slot writes, ${ghost.unghost.walks} walks)`);
  console.log('  ghost delta ms: ' + ghost.out.map((x) => x.ms.toFixed(1)).join(' ') + ' | unghost ' + ghost.unghost.ms.toFixed(1));

  // ── 3. temp hide / unhide ──
  const hide = await page.evaluate(() => {
    const st = window._ccLatestState, S = window._ccState3d;
    const bm = window.__batches[0], mid = bm.parent.userData.modelId, ids = bm.userData.batchExprIds;
    const bEid = ids.find((x) => x != null);
    const plainMesh = (() => { let f = null; S.mg.traverse((o) => { if (!f && o.isMesh && o.userData.expressId != null && o.userData.expressId !== bEid && !o.userData._isCCBatch && o.visible) f = o; }); return f; })();
    const targets = [{ expressId: bEid, modelId: mid }, { expressId: plainMesh.userData.expressId, modelId: plainMesh.parent.userData.modelId }];
    const slotsOf = (b, eid) => { const out = []; (b.userData.batchExprIds || []).forEach((x, i) => { if (String(x) === String(eid)) out.push(i); }); return out; };
    window.__reset();
    window._ccTempHide(targets);
    const r = { walks: window.__c.mg, writes: window.__c.writes, expectWrites: window.__batches.reduce((n, b) => n + slotsOf(b, bEid).length + slotsOf(b, plainMesh.userData.expressId).length, 0),
      dbg: [bEid, plainMesh.userData.expressId, window.__batches.map((b) => [slotsOf(b, bEid), slotsOf(b, plainMesh.userData.expressId), b.parent.userData.modelId])] };
    r.hiddenOk = slotsOf(bm, bEid).every((i) => !bm.getVisibleAt(i)) && plainMesh.visible === false;
    let others = 0; window.__batches.forEach((b) => (b.userData.batchExprIds || []).forEach((x, i) => { if (x == null) return; const named = (b === bm && String(x) === String(bEid)); if (!named && !b.getVisibleAt(i)) others++; }));
    r.othersHidden = others;
    window.__reset();
    window._ccTempUnhide();
    r.unWalks = window.__c.mg; r.unWrites = window.__c.writes;
    r.allBack = window.__batches.every((b) => (b.userData.batchExprIds || []).every((x, i) => x == null || b.getVisibleAt(i))) && plainMesh.visible === true;
    // temp hide while ghosted: the kept element's split slot stays hidden
    window._ghostOthers([{ expressId: bEid, modelId: mid }]);
    window._ccTempHide([{ expressId: plainMesh.userData.expressId, modelId: plainMesh.parent.userData.modelId }]);
    r.splitStaysHidden = slotsOf(bm, bEid).every((i) => !bm.getVisibleAt(i));
    window._ccTempUnhide(); window._unghostAll();
    return r;
  });
  check(hide.walks === 0 && hide.writes === hide.expectWrites, `temp hide writes only the named slots (${hide.writes}/${hide.expectWrites}, ${hide.walks} walks) ` + JSON.stringify(hide.dbg));
  check(hide.hiddenOk && hide.othersHidden === 0, 'temp hide hides exactly the targets');
  check(hide.unWalks === 0 && hide.unWrites === hide.expectWrites && hide.allBack, `temp unhide writes only the hidden slots (${hide.unWrites}) and restores everything`);
  check(hide.splitStaysHidden, 'a ghost split-out slot stays hidden under a temp hide');

  // ── 4. model edits: no material / clipping walk, triage + review only when read ──
  const act = async (label, fn, settle) => {
    await page.evaluate(() => window.__reset());
    const t0 = await page.evaluate(fn);
    await sleep(settle || 600);
    const r = await page.evaluate(() => ({ walks: window.__c.mg, stacks: window.__c.mgStacks, k: window.__k(), summary: window.__hash(JSON.stringify(window.ClashControl.review.summary())) }));
    return r;
  };
  const sum0 = await page.evaluate(() => window.__hash(JSON.stringify(window.ClashControl.review.summary())));
  const m0 = await page.evaluate(() => window._ccLatestState.models[2].id);
  const name0 = await page.evaluate(() => window._ccLatestState.models[2].name);
  const colour = await act('colour', `window._ccDispatch({ t: 'UPD_MODEL', id: ${JSON.stringify(m0)}, u: { color: '#123456' } })`);
  check(colour.walks === 0 && colour.k.triageFull === 0 && colour.k.reviewBuild === 0 && colour.summary === sum0, 'colour change: no walk, no triage / review rebuild ' + JSON.stringify(colour.k) + (colour.stacks.length ? ' ' + colour.stacks[0] : ''));
  const st1 = await page.evaluate(() => { const m = window._ccLatestState.models[2]; return (m.storeyData[1] || m.storeyData[0]).name; });
  const storey = await act('storey', `window._ccDispatch({ t: 'TOGGLE_ALL_STOREYS', id: ${JSON.stringify(m0)}, storeys: [${JSON.stringify(st1)}], hide: true })`);
  check(storey.walks === 0 && storey.k.triageFull === 0 && storey.k.reviewBuild === 0, 'storey hide: no S.mg walk, no triage / review rebuild ' + JSON.stringify(storey.k) + (storey.stacks.length ? ' ' + storey.stacks[0] : ''));
  await act('storeyBack', `window._ccDispatch({ t: 'TOGGLE_ALL_STOREYS', id: ${JSON.stringify(m0)}, storeys: [], hide: false })`);
  const theme = await act('theme', `window._ccDispatch({ t: 'UPD_PREFS', u: { theme: 'dark' } })`);
  check(theme.walks === 0 && theme.k.triageFull === 0, 'theme toggle (Shaded): no material walk, no triage rebuild ' + JSON.stringify(theme.k) + (theme.stacks.length ? ' ' + theme.stacks[0] : ''));
  await act('themeBack', `window._ccDispatch({ t: 'UPD_PREFS', u: { theme: 'light' } })`);
  const rename = await act('rename', `window._ccDispatch({ t: 'UPD_MODEL', id: ${JSON.stringify(m0)}, u: { name: 'Renamed model' } })`);
  // the model pair is keyed by ids: a rename re-files, regroups and re-sums nothing
  check(rename.walks === 0 && rename.k.triageFull === 0 && rename.k.triageVis === 0 && rename.k.triageRows === 0 && rename.k.reviewBuild === 0
    && rename.k.groupAndSort === 0 && rename.k.groupDelta === 0 && rename.k.buildConflictRows === 0 && rename.k.computeRowOffsets === 0,
    'rename: no walk, no triage / review / list rebuild, no row offsets ' + JSON.stringify(rename.k));
  const renameBack = await act('renameBack', `window._ccDispatch({ t: 'UPD_MODEL', id: ${JSON.stringify(m0)}, u: { name: ${JSON.stringify(name0)} } })`);
  check(renameBack.summary === sum0, 'rename + rename back: review set as before');
  const visOff = await act('visOff', `window._ccDispatch({ t: 'UPD_MODEL', id: ${JSON.stringify(m0)}, u: { visible: false } })`);
  // ONE grouping: the review set groups (incremental while under a third of
  // the items change, else the cheaper full regroup) and the list, showing
  // exactly the review set, takes those groups instead of grouping again
  check(visOff.walks === 0 && visOff.k.triageFull === 0 && visOff.k.triageRows === 0 && visOff.k.triageVis === 1 && visOff.k.groupAndSort + visOff.k.groupDelta === 1 && visOff.k.groupShared === 1,
    'visibility toggle: no material / clipping walk; buckets + facet rows reused, grouped once (the list reuses the review groups) ' + JSON.stringify(visOff.k) + (visOff.stacks.length ? ' ' + visOff.stacks[0] : ''));
  const visOn = await act('visOn', `window._ccDispatch({ t: 'UPD_MODEL', id: ${JSON.stringify(m0)}, u: { visible: true } })`);
  check(visOn.summary === sum0, 'visibility off + on: review set as before');
  // incremental (in place) triage after status edits = a from-scratch rebuild
  const inc = await page.evaluate(async () => {
    const st = window._ccLatestState, ids = st.clashes.slice(0, 6).map((c) => c.id);
    for (const id of ids) { window._ccDispatch({ t: 'UPD_CLASH', id, u: { status: 'in_progress' } }); await new Promise((r) => setTimeout(r, 60)); }
    const a = JSON.stringify(window.ClashControl.review.summary());
    window._ccDispatch({ t: 'UPD_RULES', u: {} });          // new rules object: full rebuild
    await new Promise((r) => setTimeout(r, 300));
    const b = JSON.stringify(window.ClashControl.review.summary());
    for (const id of ids) window._ccDispatch({ t: 'UPD_CLASH', id, u: { status: 'open' } });
    return { same: a === b };
  });
  check(inc.same, 'incremental (in place) triage after status edits = full rebuild');

  // ── 4b. hide / show / rename sequences = the from-scratch reference ──
  // After every step: the review set + bucket counts + facet counts equal a
  // rebuild with no reused model, the clash list's groups equal a full
  // regroup of its items (same order, members, and group objects reused only
  // when unchanged), and the row offsets equal the row-by-row sum.
  const seqRes = await page.evaluate(async () => {
    window._ccDispatch({ t: 'TAB', v: 'clashes' });
    window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'list' } });
    await new Promise((r) => setTimeout(r, 400));
    const ids = window._ccLatestState.models.map((m) => m.id), names0 = window._ccLatestState.models.map((m) => m.name);
    let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const bad = [], sig = (gs) => (gs || []).map((g) => g.label + '=' + g.items.map((c) => c.id).join(',')).join('|');
    let steps = 0;
    for (let step = 0; step < 14; step++) {
      const i = Math.floor(rnd() * ids.length), st0 = window._ccLatestState, m = st0.models[i];
      if (rnd() < 0.7) window._ccDispatch({ t: 'UPD_MODEL', id: m.id, u: { visible: !(m.visible !== false) } });
      else window._ccDispatch({ t: 'UPD_MODEL', id: m.id, u: { name: 'Model ' + step } });
      await new Promise((r) => setTimeout(r, 250));
      const st = window._ccLatestState;
      const got = JSON.stringify(window.ClashControl.review.summary()), facets = JSON.stringify(window.__ccReference.facets(st));
      const ref = window.__ccReference.review(st), refFacets = JSON.stringify(ref.facets); delete ref.facets;
      if (got !== JSON.stringify(ref)) bad.push(step + ': review set');
      if (facets !== refFacets) bad.push(step + ': facet counts');
      const lg = window.__ccListGroups;
      if (lg && sig(lg.groups) !== sig(window.__ccReference.groups(lg.items))) bad.push(step + ': list groups');
      const lr = window.__ccListRows;
      if (lr && lr.groups === lg.groups) {
        const refRows = window._ccBuildConflictRows(lr.items, lr.groups, lr.collapsed, lr.limits, () => false);
        if (refRows.map((x) => x.key).join('|') !== lr.rows.map((x) => x.key).join('|')) bad.push(step + ': rows');
        const refOff = window._ccComputeRowOffsets(lr.rows, lr.heights).offsets;
        if (refOff.join(',') !== lr.off.offsets.join(',')) bad.push(step + ': offsets');
      }
      steps++;
    }
    ids.forEach((id, k) => window._ccDispatch({ t: 'UPD_MODEL', id, u: { visible: true, name: names0[k] } }));
    await new Promise((r) => setTimeout(r, 400));
    return { steps, bad: bad.slice(0, 8), rowsSeen: !!window.__ccListRows };
  });
  check(seqRes.steps === 14 && !seqRes.bad.length, 'random hide / show / rename sequence: review set, facet counts, list groups, rows and offsets = from-scratch reference ' + JSON.stringify(seqRes));
  const back = await page.evaluate(() => window.__hash(JSON.stringify(window.ClashControl.review.summary())));
  check(back === sum0, 'all models shown, names restored: review set as at the start');

  // saved view by model pair survives a rename; an old name-valued one is migrated
  const sv = await page.evaluate(async () => {
    const st = window._ccLatestState, tc = window._ccClashTriageCore;
    const c = st.clashes.find((x) => x.modelAId && x.modelBId && x.modelAId !== x.modelBId) || st.clashes[0];
    const key = tc.modelPairKey(c), nm = (id) => (window._ccLatestState.models.find((m) => m.id === id) || {}).name;
    const label = tc.modelPairLabel(key, nm);
    window._ccDispatch({ t: 'TRIAGE_UPD', u: { facets: {}, savedViews: [{ id: 'old', name: 'Old pair', facets: { modelPair: [label] }, search: '' }] } });
    await new Promise((r) => setTimeout(r, 200));
    const migrated = JSON.stringify(window._ccLatestState.triage.savedViews[0].facets.modelPair) === JSON.stringify([key]);
    window._ccDispatch({ t: 'TRIAGE_UPD', u: { facets: { modelPair: [key] }, activeViewId: 'old' } });
    await new Promise((r) => setTimeout(r, 300));
    const n0 = window.ClashControl.review.summary().reviewClashes;
    const chip0 = (document.querySelector('[data-cc-pill="modelPair"]') || {}).textContent || '';
    window._ccDispatch({ t: 'UPD_MODEL', id: c.modelAId, u: { name: 'Zz renamed' } });
    await new Promise((r) => setTimeout(r, 300));
    const n1 = window.ClashControl.review.summary().reviewClashes;
    const chip1 = (document.querySelector('[data-cc-pill="modelPair"]') || {}).textContent || '';
    window._ccDispatch({ t: 'UPD_MODEL', id: c.modelAId, u: { name: nm(c.modelAId) === 'Zz renamed' ? st.models.find((m) => m.id === c.modelAId).name : nm(c.modelAId) } });
    window._ccDispatch({ t: 'TRIAGE_UPD', u: { facets: {}, savedViews: [], activeViewId: null } });
    await new Promise((r) => setTimeout(r, 300));
    return { migrated, n0, n1, chip0: chip0.trim(), chip1: chip1.trim(), label };
  });
  check(sv.migrated, 'an old name-valued saved view is migrated to model ids ' + JSON.stringify(sv));
  check(sv.n0 > 0 && sv.n0 === sv.n1, 'a model-pair filter keeps selecting the same clashes after a rename ' + JSON.stringify(sv));
  check(!sv.chip0 || (sv.chip0.indexOf(sv.label) !== -1 && sv.chip1.indexOf('Zz renamed') !== -1), 'the model-pair pill shows the current names ' + JSON.stringify(sv));

  // ── 5. markers ──
  const mk = await page.evaluate(async () => {
    window._ccDispatch({ t: 'UPD_PREFS', u: { showMarkers: true } });
    await new Promise((r) => setTimeout(r, 400));
    const k = window._ccListPerfCounters, st = window._ccLatestState;
    const c = st.clashes.find((x) => !x.aiSeverity && x.type === 'hard') || st.clashes[0];
    const a0 = k.clashMarkers;
    window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: 'resolved' } });
    await new Promise((r) => setTimeout(r, 300));
    const afterStatus = k.clashMarkers - a0;
    window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: 'open' } });
    await new Promise((r) => setTimeout(r, 300));
    const sev = (window._ccClashClassificationCore.deterministicSeverity(c) === 'critical') ? 'info' : 'critical';
    const a1 = k.clashMarkers;
    window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { aiSeverity: sev } });
    await new Promise((r) => setTimeout(r, 300));
    const afterSev = k.clashMarkers - a1;
    window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { aiSeverity: null } });
    window._ccDispatch({ t: 'UPD_PREFS', u: { showMarkers: false } });
    return { afterStatus, afterSev };
  });
  check(mk.afterStatus === 0, `markers on: a status edit rebuilds no clash marker (${mk.afterStatus})`);
  check(mk.afterSev === 1, `markers on: a severity edit rebuilds them once (${mk.afterSev})`);

  // ── 6. search: typed forward = typed at once ──
  const search = await page.evaluate(async () => {
    const S = (q) => { window._ccDispatch({ t: 'UPD_FILTERS', u: { search: q } }); return new Promise((r) => setTimeout(() => r(JSON.stringify(window.ClashControl.review.summary().items.map((i) => i.ids))), 250)); };
    const res = {};
    for (const seq of [['b', 'be', 'bea', 'beam'], ['w', 'wa', 'wal', 'wall', 'walls'], ['floo', 'floor'], ['1', '12'], ['col', 'col s']]) {
      let last = null;
      for (const q of seq) last = await S(q);
      await S('');
      const direct = await S(seq[seq.length - 1]);
      await S('');
      res[seq.join('>')] = last === direct;
    }
    return res;
  });
  check(Object.values(search).every(Boolean), 'search typed forward = typed at once ' + JSON.stringify(search));

  // ── 7. section plane + visibility toggle ──
  const sec = await page.evaluate(async (mid) => {
    const S = window._ccState3d;
    window._ccDispatch({ t: 'SECTION', axis: 'y', pos: 0.5 });
    await new Promise((r) => setTimeout(r, 800));
    const f0 = window._ccPlanFrame(), v0 = S._sectionPlaneVis;
    window._ccDispatch({ t: 'UPD_MODEL', id: mid, u: { visible: false } });
    await new Promise((r) => setTimeout(r, 800));
    const f1 = window._ccPlanFrame();
    window.__reset();
    window._ccDispatch({ t: 'UPD_MODEL', id: mid, u: { visible: true } });
    await new Promise((r) => setTimeout(r, 800));
    const f2 = window._ccPlanFrame(), v2 = S._sectionPlaneVis;
    window._ccDispatch({ t: 'SECTION', axis: null });
    await new Promise((r) => setTimeout(r, 400));
    return { cached: f2 === f0, changed: f1 !== f0, sameVis: v0 === v2 && !!v2, gone: !S._sectionPlaneVis };
  }, m0);
  check(sec.cached && sec.sameVis && sec.gone, 'section on, model hidden and shown: cached plan frame, plane refitted in place ' + JSON.stringify(sec));

  // ── 8. render style: glass by the mesh's own model ──
  const style = await page.evaluate(async () => {
    const S = window._ccState3d, st = window._ccLatestState;
    window._ccDispatch({ t: 'UPD_PREFS', u: { renderStyle: 'standard' } });
    await new Promise((r) => setTimeout(r, 800));
    const typeOf = (mid, eid) => { const m = st.models.find((x) => x.id === mid); const el = m && m.elements.find((e) => e.expressId === eid); return (el && el.props && el.props.ifcType) || ''; };
    let collisions = 0, wrong = 0, checked = 0;
    S.mg.traverse((o) => {
      if (!o.isMesh || o.userData.expressId == null || o.userData._isCCBatch || o.userData._ccSpace) return;
      const mid = o.parent.userData.modelId, eid = o.userData.expressId, own = typeOf(mid, eid);
      if (!/^Ifc(Member|CurtainWall|Beam|Column|Pile|Footing|Wall|Slab|Roof|Stair|Ramp|Covering|Railing|Rail)/i.test(own)) return;
      checked++;
      const other = st.models.some((m) => m.id !== mid && /^IfcWindow/i.test(typeOf(m.id, eid)));
      if (other) collisions++;
      if (o.material !== S._sharedStandardMat) wrong++;
    });
    window._ccDispatch({ t: 'UPD_PREFS', u: { renderStyle: 'shaded' } });
    await new Promise((r) => setTimeout(r, 600));
    return { checked, collisions, wrong };
  });
  check(style.wrong === 0, `Hidden Line: every hard-frame element is opaque by its own model's type (${style.checked} meshes, ${style.collisions} share an expressId with another model's window)`);

  // ── 9. restore visible + last-frame cull ──
  const cull = await page.evaluate(async () => {
    const S = window._ccState3d, b = window._ccElemsBBox();
    S.camera.position.set(b.min.x - 1, b.min.y + 1.5, b.min.z - 1);
    S.orbit.target.set(b.min.x + 2, b.min.y + 1, b.min.z + 2);
    S.camera.lookAt(S.orbit.target); if (S.orbit.sync) S.orbit.sync();
    window._ccInvalidate(3);
    await new Promise((r) => setTimeout(r, 1000));
    const snap = () => { const v = []; S.mg.traverse((o) => { if (o.isMesh && o.userData.expressId != null && !o.userData._isCCBatch) v.push(o.visible ? 1 : 0); }); return v.join(''); };
    const a = snap();
    S._lastCullCamKey = ''; S._forceCull = true; window._ccInvalidate(2);
    await new Promise((r) => setTimeout(r, 1000));
    return { same: a === snap(), culled: (snap().match(/0/g) || []).length };
  });
  check(cull.same, `the last frame of a 3-frame camera move culls like a forced cull pass (${cull.culled} meshes culled)`);
  const park = await page.evaluate(async (mid) => {
    window._ccDispatch({ t: 'UPD_MODEL', id: mid, u: { visible: false } });
    await new Promise((r) => setTimeout(r, 300));
    const p = await window.ClashControl.parkModel(mid);
    await new Promise((r) => setTimeout(r, 500));
    const r = await window.ClashControl.restoreModel(mid);
    await new Promise((r) => setTimeout(r, 800));
    const m = window._ccLatestState.models.find((x) => x.id === mid);
    return { p, r, visible: m && m.visible };
  }, m0);
  check(park.r && typeof park.visible === 'boolean', 'a restored model carries a boolean visible flag ' + JSON.stringify(park));
} catch (e) {
  fail('exception: ' + (e && e.stack || e));
} finally {
  if (pageErrors.length) fail('page errors: ' + JSON.stringify(pageErrors.slice(0, 5)));
  await browser.close(); server.close();
}
if (failures) { console.error(failures + ' scene action-cost check(s) failed'); process.exit(1); }
console.log('SCENE COST — all checks passed');
