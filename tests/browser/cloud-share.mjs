#!/usr/bin/env node
// Cloud share (project key) on the change log (docs/INTERNALS.md §21.56), in
// the real app with two browser contexts acting as two users on two machines
// (separate storage) on the same synthetic federation. `/api/project` is
// served by the REAL api/project.js handler running here in node against an
// in-memory SQL stand-in (tests/_sql-memory.js) — no network, no database.
//   * a status edit is pushed as one small record; the teammate's pull
//     fetches only the new record(s); an idle pull returns nothing and
//     dispatches nothing
//   * concurrent edits of one field: a conflict on BOTH pages (badge, resolver,
//     count), the last agreed value kept, NO "not applied" toast anywhere
//   * resolving on one page clears it on both
//   * a sequential edit (after seeing the other) is an ordinary update
//   * a reload pulls only what is new (records + cursor cached in IndexedDB)
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/cloud-share.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const { createMemoryDb, installMemoryNeon, call } = require('../_sql-memory.js');
const db = createMemoryDb();
installMemoryNeon(db);
const handler = require('../../api/project.js');

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
const FIX = {
  '/__a.ifc': generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3 }),
  '/__b.ifc': generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, offsetX: 0.2 }),
};

let failures = 0;
function ok(msg) { console.log('CLOUD SHARE OK — ' + msg); }
function fail(msg) { console.error('CLOUD SHARE FAIL: ' + msg); failures++; }
function check(cond, msg, detail) { if (cond) ok(msg); else fail(msg + (detail ? ' — ' + detail : '')); }

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (FIX[p]) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(FIX[p]); }
    const file = normalize(join(root, p === '/' ? 'index.html' : p.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const exe = process.env.CC_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {});
const pageErrors = [];
const log = []; // every /api/project request: {who, method, v, after, nChanges}

// /api/project → the real handler (in this process). Everything the pages
// send and get is recorded.
async function routeApi(ctx, who) {
  await ctx.route('**/api/project**', async (route) => {
    const r = route.request(), u = new URL(r.url());
    const query = Object.fromEntries(u.searchParams.entries());
    let body;
    try { body = r.postDataJSON(); } catch { body = undefined; }
    const out = await call(handler, { method: r.method(), query, body, headers: { 'x-cc-edit-key': r.headers()['x-cc-edit-key'] } });
    log.push({ who, method: r.method(), v: query.v || (body && body.v) || null, after: query.after, sent: body && body.changes ? body.changes.length : 0,
      got: out.body && out.body.changes ? out.body.changes.length : 0, error: out.body && out.body.error, bytes: r.postData() ? r.postData().length : 0 });
    await route.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify(out.body) });
  });
}

async function openUser(uid, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([u, n]) => {
    try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); localStorage.setItem('cc_username', n); } catch (e) {}
    window.__ccSharedTestUser = u;
    window.__toasts = [];
  }, [uid, name]);
  if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);
  await routeApi(ctx, uid);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(uid + ': ' + e.message));
  page.on('dialog', (dl) => dl.accept());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccSharedSessionCore && window._ccCloudShare, null, { timeout: 120_000 });
  // record every toast (the old client showed "Your edit was not applied")
  await page.evaluate(() => {
    const orig = window._ccToast;
    window._ccToast = function(m) { window.__toasts.push(String(m)); return orig && orig.apply(this, arguments); };
    window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } });
    // pulls are driven by hand; pushes go out 100 ms after an edit
    window._ccCloudShare.config({ pullMs: 1e9, pushDelay: 100 });
  });
  await page.evaluate(async () => {
    for (const [p, n] of [['/__a.ifc', 'arch.ifc'], ['/__b.ifc', 'struct.ifc']]) {
      const buf = await (await fetch(p)).arrayBuffer();
      window.ClashControl.loadFiles([new File([buf], n)]);
      await new Promise((resolve) => { const iv = setInterval(() => { const s = window._ccLatestState; if (s.models.some((m) => m.name === n.replace('.ifc', '') && (m.elements || []).length) && !window._ccModelLoading) { clearInterval(iv); resolve(); } }, 50); });
    }
  });
  await page.evaluate(() => window._ccRunDetection());
  await page.waitForFunction(() => { const s = window._ccLatestState; return !s.detecting && s.clashes.length > 0; }, null, { timeout: 120_000, polling: 200 });
  return page;
}
const settle = (p) => p.waitForFunction(() => window._ccCloudShare.status().pending === 0, null, { timeout: 10_000 }).then(() => p.evaluate(() => window._ccCloudShare.push()));
const pull = (p) => p.evaluate(() => window._ccCloudShare.pull().then(() => true));
const clashes = (p) => p.evaluate(() => window._ccLatestState.clashes.map((c) => ({ id: c.id, key: c._identityKey, status: c.status, conflict: c._sharedConflict || null })));
const byKey = (list, key) => list.find((c) => c.key === key);
const setStatus = (p, key, status) => p.evaluate(([k, st]) => {
  const c = window._ccLatestState.clashes.find((x) => x._identityKey === k);
  window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: st } });
}, [key, status]);
const dispatches = (p) => p.evaluate(() => window._ccCloudShare.session().stats.dispatches);
const lastGet = (who) => log.filter((x) => x.who === who && x.method === 'GET').slice(-1)[0];

try {
  const A = await openUser('ualice0000001', 'Alice');
  const B = await openUser('ubob000000002', 'Bob');
  const all = await clashes(A);
  check(all.length >= 2, 'synthetic federation detected ' + all.length + ' clashes');
  const K = all.slice(0, 2).map((c) => c.key);

  // ── A creates the project, B joins with the key ──
  const pid = await A.evaluate(() => window._ccSharedCreate('Team').then((d) => d.id));
  await B.evaluate((k) => window._ccSharedJoin(k), pid);
  await pull(A); await pull(B);
  check(!!pid && await B.evaluate(() => window._ccCloudShare.status().pid) === pid, 'A created ' + pid + ', B joined it');

  // ── a status edit: one small record pushed; B's pull fetches just it ──
  await setStatus(A, K[0], 'in_progress');
  await settle(A);
  const put = log.filter((x) => x.who === 'ualice0000001' && x.method === 'PUT').slice(-1)[0];
  check(put && put.v === 2 && put.sent === 1 && put.bytes < 1024, 'one edit = one PUT with ONE record (' + (put && put.bytes) + ' bytes)', JSON.stringify(put));
  await pull(B);
  check(lastGet('ubob000000002').got === 1, 'B\'s pull returned only the new record', JSON.stringify(lastGet('ubob000000002')));
  let b = byKey(await clashes(B), K[0]);
  check(b.status === 'in_progress' && !b.conflict, 'page B shows A\'s edit');

  // ── idle pulls: nothing returned, nothing dispatched ──
  for (const [P, who, uid] of [[A, 'A', 'ualice0000001'], [B, 'B', 'ubob000000002']]) {
    await pull(P);
    const d0 = await dispatches(P);
    await pull(P); await pull(P);
    const d1 = await dispatches(P);
    check(lastGet(uid).got === 0 && d1 === d0, 'idle pulls on page ' + who + ': 0 records returned, 0 dispatches', JSON.stringify({ got: lastGet(uid).got, dispatches: d1 - d0 }));
  }

  // ── sequential: B edits after seeing A's edit → ordinary update ──
  await setStatus(B, K[0], 'resolved');
  await settle(B); await pull(A);
  const aSeq = byKey(await clashes(A), K[0]);
  check(aSeq.status === 'resolved' && !aSeq.conflict, 'sequential edits merge without a conflict');

  // ── concurrent: both change K[1] on the same version ──
  await setStatus(A, K[1], 'in_progress');
  await settle(A); await pull(B);
  await setStatus(A, K[1], 'resolved');
  await setStatus(B, K[1], 'closed');
  await settle(A); await settle(B);
  const puts = log.filter((x) => x.method === 'PUT').slice(-2);
  check(puts.every((x) => !x.error), 'both writes were accepted (no rejection)');
  await pull(A); await pull(B);
  for (const [P, who] of [[A, 'A'], [B, 'B']]) {
    const c = byKey(await clashes(P), K[1]);
    const vals = c.conflict ? c.conflict[0].heads.map((h) => h.value).sort().join(',') : '';
    check(!!c.conflict && vals === 'closed,resolved' && c.conflict[0].src === 'cloud', 'page ' + who + ': conflict with both values', JSON.stringify(c.conflict));
    check(c.status === 'in_progress', 'page ' + who + ': keeps the last agreed value (' + c.status + ')');
    check(await P.evaluate(() => window._ccCloudShare.status().conflicts) === 1, 'page ' + who + ': 1 conflict counted');
    const id = c.id;
    await P.evaluate(() => {
      const core = window._ccClashClassificationCore;
      window._ccDispatch({ t: 'TAB', v: 'clashes' });
      window._ccDispatch({ t: 'UPD_FILTERS', u: { showBuckets: (core && core.REVIEW_BUCKETS) || [] } });
    });
    await P.waitForSelector(`[data-item-id="${id}"] [data-cc-shared-conflict]`, { timeout: 10_000 }).then(() => ok('page ' + who + ': conflict badge in the row'), () => fail('page ' + who + ': no conflict badge'));
    await P.evaluate((cid) => window._ccDispatch({ t: 'ACTIVE', id: cid }), id);
    await P.waitForSelector(`[data-item-id="${id}"] [data-cc-shared-resolver]`, { timeout: 10_000 });
    const det = await P.$eval(`[data-item-id="${id}"] [data-cc-shared-resolver]`, (el) => ({ text: el.textContent, use: el.querySelectorAll('[data-cc-shared-use]').length }));
    check(det.use === 2 && (who === 'A' ? /Bob/ : /Alice/).test(det.text), 'page ' + who + ': resolver lists both values with who made them', JSON.stringify(det));
  }

  // ── the Quick Share panel shows the count ──
  await A.evaluate(() => window._ccDispatch({ t: 'SHARE', v: true }));
  const pill = await A.waitForSelector('[data-cc-cloud-conflict-count]', { timeout: 5_000 }).catch(() => null);
  check(!!pill, 'Share panel: "1 conflict to resolve"');
  await A.evaluate(() => window._ccDispatch({ t: 'SHARE', v: false }));

  // ── resolve on A ("use this" on Bob's value) → cleared on both ──
  const headId = await A.evaluate((k) => window._ccLatestState.clashes.find((x) => x._identityKey === k)._sharedConflict[0].heads.find((h) => h.value === 'closed').id, K[1]);
  await A.click(`[data-cc-shared-use="${headId}"]`);
  await settle(A); await pull(B);
  for (const [P, who] of [[A, 'A'], [B, 'B']]) {
    const c = byKey(await clashes(P), K[1]);
    check(!c.conflict && c.status === 'closed', 'page ' + who + ': resolved to Closed, conflict cleared');
    check(await P.evaluate(() => window._ccCloudShare.status().conflicts) === 0, 'page ' + who + ': conflict count 0');
  }

  // ── a reload pulls only what is new (records + cursor cached in IndexedDB) ──
  await setStatus(A, K[0], 'closed');
  await settle(A);
  const B2 = await B.context().newPage();
  B2.on('pageerror', (e) => pageErrors.push('B2: ' + e.message));
  const before = log.length;
  await B2.goto(url, { waitUntil: 'domcontentloaded' });
  await B2.waitForFunction(() => window._ccCloudShare && window._ccCloudShare.status().pid && window._ccCloudShare.status().lastSync, null, { timeout: 60_000 });
  const gets = log.slice(before).filter((x) => x.who === 'ubob000000002' && x.method === 'GET');
  check(gets.length >= 1 && Number(gets[0].after) > 0 && gets.reduce((n, x) => n + x.got, 0) === 1,
    'after a reload, page B pulled from its cached cursor: only the 1 new record', JSON.stringify(gets));
  await B2.close();

  // ── one sharing mode at a time (shared-session-core claimLink) ──
  // With a project key linked, a shared folder cannot be linked (each mode
  // keeps its own log; both at once would overwrite each other's values and
  // markers) — and the other way round, with the reason shown.
  await A.evaluate(() => window._ccActivateAddon('shared-project'));
  await A.waitForFunction(() => window._ccSharedLog, null, { timeout: 30_000 });
  const refused = await A.evaluate(async () => {
    window.__toasts.length = 0;
    const r = await window._ccSharedLog.link(await navigator.storage.getDirectory());
    return { r, sess: !!window._ccSharedLog.session(), holder: window._ccSharedSessionCore.linkHolder(), toasts: window.__toasts.slice() };
  });
  check(refused.r === false && !refused.sess && refused.holder.src === 'cloud' && refused.toasts.some((m) => m.includes(pid)),
    'project key linked: linking a folder is refused with the key named', JSON.stringify(refused));
  await A.evaluate(() => window._ccDispatch({ t: 'SHARE', v: true }));
  const shareNote = await A.waitForSelector('[data-cc-share-mode-note="cloud"]', { timeout: 5_000 }).catch(() => null);
  const linkDisabled = await A.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Link a shared folder/.test(b.textContent) && b.disabled));
  check(!!shareNote && linkDisabled, 'Share panel: "Link a shared folder" disabled with the reason');
  await A.evaluate(() => window._ccDispatch({ t: 'SHARE', v: false }));
  // leave the key → the folder links; now the key is refused before any request
  const nReq = () => log.filter((x) => x.who === 'ualice0000001').length;
  await A.evaluate(() => { localStorage.removeItem('cc_sharedProjectId'); localStorage.removeItem('cc_sharedProjectName'); window._ccSharedStop(true); });
  const linked = await A.evaluate(async () => {
    const r = await window._ccSharedLog.link(await navigator.storage.getDirectory());
    return { r, sess: !!window._ccSharedLog.session(), holder: window._ccSharedSessionCore.linkHolder(), sessions: window._ccSharedSessionCore.sessions().map((s) => s.src) };
  });
  check(linked.r === true && linked.sess && linked.holder.src === 'folder' && linked.sessions.join() === 'folder', 'after leaving the key the folder links (one session)', JSON.stringify(linked));
  const r0 = nReq();
  const join = await A.evaluate((k) => window._ccSharedJoin(k).then(() => 'joined', (e) => e.code), pid);
  check(join === 'other_mode' && nReq() === r0, 'folder linked: joining a key is refused before any request');
  // a key saved by an older version while the folder is linked does not sync
  await A.evaluate((k) => { localStorage.setItem('cc_sharedProjectId', k); window._ccDispatch({ t: 'UPD_PREFS', u: { _sharedRefresh: Date.now() } }); }, pid);
  await A.evaluate(() => window._ccDispatch({ t: 'SHARE', v: true }));
  const paused = await A.waitForSelector('[data-cc-share-mode-note="cloud-paused"]', { timeout: 5_000 }).catch(() => null);
  check(!!paused && !(await A.evaluate(() => window._ccCloudShare.session())) && nReq() === r0, 'saved key while the folder is linked: not syncing, the panel says why');
  await A.evaluate(() => window._ccDispatch({ t: 'SHARE', v: false }));
  // unlink the folder → the saved key starts syncing again
  await A.evaluate(() => window._disconnectShared(window._ccDispatch));
  await A.waitForFunction(() => !window._ccSharedLog.session(), null, { timeout: 10_000 });
  await A.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { _sharedRefresh: Date.now() } }));
  await A.waitForFunction((k) => window._ccCloudShare.status().pid === k && window._ccSharedSessionCore.linkHolder().src === 'cloud', pid, { timeout: 10_000 })
    .then(() => ok('folder unlinked: the saved key syncs again'), () => fail('folder unlinked: the saved key did not resume'));

  // ── never the old rejection path ──
  for (const [P, who] of [[A, 'A'], [B, 'B']]) {
    const t = await P.evaluate(() => window.__toasts);
    check(!t.some((m) => /not applied|niet doorgevoerd/i.test(m)), 'page ' + who + ': no "your edit was not applied" toast', JSON.stringify(t));
  }
  check(!log.some((x) => x.method === 'PUT' && x.v !== 2), 'every PUT used the v2 change-log shape');
  const recs = db.changes.get(pid) || [];
  check(recs.length === new Set(recs.map((r) => r.id)).size, 'the server stored each record once (' + recs.length + ' records)');
  console.log('requests: ' + log.length + ' (' + log.filter((x) => x.method === 'PUT').length + ' PUT, ' + log.filter((x) => x.method === 'GET').length + ' GET)');

  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('CLOUD SHARE: all checks passed');
