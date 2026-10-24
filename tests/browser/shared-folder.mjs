#!/usr/bin/env node
// Shared folder as a per-user change log (docs/INTERNALS.md §21.55), in the
// real app with two pages acting as two users on the same synthetic
// federation (tests/fixtures/generate-synthetic-ifc.js + real detection).
// The browser's origin-private file system (OPFS) stands in for the folder
// they both picked (OneDrive / Dropbox / NAS in real use).
//   * an old team.ccproject in the folder is migrated once into a snapshot
//     (decisions show up on both pages; the old file is left untouched)
//   * a status edit writes ONE small new file of that user; nothing rewritten
//   * an idle check reads no file contents, writes nothing, dispatches nothing
//   * sequential edits (B edits after seeing A's) merge without conflict
//   * concurrent edits of one field show a conflict on BOTH pages: badge in
//     the row, "Conflicts" view in the filters, count in the review overview,
//     detail with both values (who / when) and the last agreed value kept
//   * resolving on one page clears it on both
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/shared-folder.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
const FIX = {
  '/__a.ifc': generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3 }),
  '/__b.ifc': generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, offsetX: 0.2 }),
};

let failures = 0;
function ok(msg) { console.log('SHARED FOLDER OK — ' + msg); }
function fail(msg) { console.error('SHARED FOLDER FAIL: ' + msg); failures++; }
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

// One context = one origin's OPFS, shared by both pages (two users on one
// folder). Each page is its own user (per-page test user id).
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {}
  // file-system cost counters: contents read (File.text), writes (createWritable)
  window.__fs = { text: 0, textBytes: 0, writes: [], getFile: 0 };
  const text = Blob.prototype.text;
  Blob.prototype.text = function () { window.__fs.text++; window.__fs.textBytes += this.size; return text.apply(this, arguments); };
  if (window.FileSystemFileHandle) {
    const cw = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function () { window.__fs.writes.push(this.name); return cw.apply(this, arguments); };
    const gf = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function () { window.__fs.getFile++; return gf.apply(this, arguments); };
  }
});
if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);

async function openUser(uid, name) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(uid + ': ' + e.message));
  page.on('dialog', (dl) => dl.accept());
  await page.addInitScript(([u, n]) => { window.__ccSharedTestUser = u; try { localStorage.setItem('cc_username', n); } catch (e) {} }, [uid, name]);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccSharedLogCore, null, { timeout: 120_000 });
  await page.evaluate(() => { window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } }); });
  // the same name is in localStorage for both pages (one origin): set it per page
  await page.evaluate((n) => { window._ccDispatch({ t: 'UPD_SHARED_PROJECT', u: { userName: n } }); }, name);
  await page.evaluate(async () => {
    for (const [p, n] of [['/__a.ifc', 'arch.ifc'], ['/__b.ifc', 'struct.ifc']]) {
      const buf = await (await fetch(p)).arrayBuffer();
      window.ClashControl.loadFiles([new File([buf], n)]);
      await new Promise((resolve) => { const iv = setInterval(() => { const s = window._ccLatestState; if (s.models.some((m) => m.name === n.replace('.ifc', '') && (m.elements || []).length) && !window._ccModelLoading) { clearInterval(iv); resolve(); } }, 50); });
    }
  });
  await page.evaluate(() => window._ccRunDetection());
  await page.waitForFunction(() => { const s = window._ccLatestState; return !s.detecting && s.clashes.length > 0; }, null, { timeout: 120_000, polling: 200 });
  await page.evaluate(() => window._ccActivateAddon('shared-project'));
  await page.waitForFunction(() => window._ccSharedLog && typeof window._ccSharedResolve === 'function', null, { timeout: 30_000 });
  // checks are driven by hand; edits are batched for 200 ms
  await page.evaluate(() => { window._ccSharedLog.config.tickMs = 1e9; window._ccSharedLog.config.flushDelayMs = 200; });
  return page;
}
const tick = (p) => p.evaluate(() => window._ccSharedLog.tick());
const settle = (p) => p.waitForFunction(() => window._ccSharedLog.pending() === 0, null, { timeout: 10_000 });
const clashes = (p) => p.evaluate(() => window._ccLatestState.clashes.map((c) => ({ id: c.id, key: c._identityKey, status: c.status, conflict: c._sharedConflict || null })));
const byKey = (list, key) => list.find((c) => c.key === key);
const counters = (p) => p.evaluate(() => ({ text: window.__fs.text, getFile: window.__fs.getFile, writes: window.__fs.writes.length, dispatches: window._ccSharedLog.stats.dispatches }));
const setStatus = (p, key, status) => p.evaluate(([k, st]) => {
  const c = window._ccLatestState.clashes.find((x) => x._identityKey === k);
  window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: st } });
}, [key, status]);
// Everything in the shared folder: path → size
const folder = (p) => p.evaluate(async () => {
  const out = {};
  async function walk(dir, pre) {
    for await (const [n, h] of dir.entries()) {
      if (h.kind === 'directory') await walk(h, pre + n + '/');
      else out[pre + n] = (await h.getFile()).size;
    }
  }
  await walk(await navigator.storage.getDirectory(), '');
  return out;
});

try {
  const A = await openUser('ualice0000001', 'Alice');
  const all = await clashes(A);
  check(all.length >= 3, 'synthetic federation detected ' + all.length + ' clashes on page A');
  const K = all.slice(0, 3).map((c) => c.key);

  // ── an old single-file project in the folder (decisions on clash K[2]) ──
  const legacy = JSON.stringify({ _cc: 'ClashControl', _v: '7.0.0', savedAt: '2026-10-01T10:00:00.000Z',
    clashes: [{ id: 'old-1', _identityKey: K[2], status: 'accepted_needs_check', priority: 'high', assignee: 'Legacy Lee' }],
    issues: [{ id: 'iss-legacy-1', title: 'Legacy issue from the old file', status: 'open', priority: 'normal', createdAt: '2026-10-01' }],
    changelog: [], comments: [] }, null, 2);
  await A.evaluate(async (txt) => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('team.ccproject', { create: true });
    const w = await fh.createWritable(); await w.write(txt); await w.close();
  }, legacy);
  await A.evaluate(async () => { await window._ccSharedLog.link(await navigator.storage.getDirectory()); });
  const B = await openUser('ubob000000002', 'Bob');
  await B.evaluate(async () => { await window._ccSharedLog.link(await navigator.storage.getDirectory()); });

  let files = await folder(A);
  const snaps = Object.keys(files).filter((n) => /^team\.ccshared\/snapshot-\d{14}-legacy-[0-9a-f]{8}\.json$/.test(n));
  check(snaps.length === 1, 'the old project file was migrated into ONE snapshot in team.ccshared/', JSON.stringify(Object.keys(files)));
  check(files['team.ccproject'] === legacy.length, 'the old project file is left untouched');
  for (const [P, who] of [[A, 'A'], [B, 'B']]) {
    const c = byKey(await clashes(P), K[2]);
    const iss = await P.evaluate(() => window._ccLatestState.issues.find((i) => i.id === 'iss-legacy-1'));
    check(c.status === 'accepted_needs_check' && iss && iss.title === 'Legacy issue from the old file', 'migrated decisions + issue on page ' + who);
  }

  // ── a status edit writes one small new file ──
  let a0 = await counters(A);
  await setStatus(A, K[0], 'in_progress');
  await settle(A);
  let a1 = await counters(A);
  files = await folder(A);
  const aliceFiles = Object.keys(files).filter((n) => n.startsWith('team.ccshared/changes/ualice0000001/'));
  check(a1.writes - a0.writes === 1 && aliceFiles.length === 1, 'one status edit = one new file of that user', JSON.stringify({ writes: a1.writes - a0.writes, aliceFiles }));
  check(files[aliceFiles[0]] < 1024, 'the file is small (' + files[aliceFiles[0]] + ' bytes)');

  // ── B reads it: an ordinary update ──
  await tick(B);
  let b = byKey(await clashes(B), K[0]);
  check(b.status === 'in_progress' && !b.conflict, 'page B shows A\'s edit');

  // ── idle checks: no contents read, nothing written, nothing dispatched ──
  for (const [P, who] of [[A, 'A'], [B, 'B']]) {
    await tick(P);
    const c0 = await counters(P);
    await tick(P); await tick(P);
    const c1 = await counters(P);
    check(c1.text === c0.text && c1.getFile === c0.getFile && c1.writes === c0.writes && c1.dispatches === c0.dispatches, 'idle checks on page ' + who + ': names listed only — 0 files opened or read, 0 written, 0 dispatches',
      JSON.stringify({ read: c1.text - c0.text, opened: c1.getFile - c0.getFile, writes: c1.writes - c0.writes, dispatches: c1.dispatches - c0.dispatches }));
  }

  // ── sequential: B edits after seeing A's edit ──
  await setStatus(B, K[0], 'resolved');
  await settle(B);
  await tick(A);
  const aSeq = byKey(await clashes(A), K[0]);
  check(aSeq.status === 'resolved' && !aSeq.conflict, 'sequential edits merge without a conflict');

  // ── concurrent: both change K[1] before seeing each other ──
  await setStatus(A, K[1], 'in_progress');
  await settle(A); await tick(B);
  await setStatus(A, K[1], 'resolved');
  await setStatus(B, K[1], 'closed');
  await settle(A); await settle(B);
  await tick(A); await tick(B);
  for (const [P, who] of [[A, 'A'], [B, 'B']]) {
    const c = byKey(await clashes(P), K[1]);
    const vals = c.conflict ? c.conflict[0].heads.map((h) => h.value).sort().join(',') : '';
    check(!!c.conflict && vals === 'closed,resolved', 'page ' + who + ': conflict with both values', JSON.stringify(c.conflict));
    check(c.status === 'in_progress', 'page ' + who + ': keeps the last agreed value (' + c.status + ')');
    const sp = await P.evaluate(() => window._ccLatestState.sharedProject.conflicts);
    check(sp === 1, 'page ' + who + ': conflict count in the shared-project state = ' + sp);
  }

  // ── what each user sees ──
  for (const [P, who] of [[A, 'A'], [B, 'B']]) {
    const id = byKey(await clashes(P), K[1]).id;
    await P.evaluate(() => {
      const core = window._ccClashClassificationCore;
      window._ccDispatch({ t: 'TAB', v: 'clashes' });
      window._ccDispatch({ t: 'UPD_FILTERS', u: { showBuckets: (core && core.REVIEW_BUCKETS) || [] } });
    });
    await P.waitForSelector(`[data-item-id="${id}"] [data-cc-shared-conflict]`, { timeout: 10_000 }).then(() => ok('page ' + who + ': conflict badge in the row'), () => fail('page ' + who + ': no conflict badge in the row'));
    const chip = await P.$('[data-cc-suggested="shared-conflict"]');
    if (!chip) fail('page ' + who + ': no Conflicts view in the filters');
    else {
      await chip.click();
      await P.waitForTimeout(200);
      const rows = await P.$$eval('[data-item-id]', (els) => els.map((e) => e.getAttribute('data-item-id')));
      check(rows.length >= 1 && rows.every((r) => r === id), 'page ' + who + ': the Conflicts view lists only the conflicted clash', JSON.stringify(rows.slice(0, 5)));
      await chip.click();
    }
    await P.evaluate(() => window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'overview' } }));
    await P.waitForSelector('[data-cc-overview-conflicts="1"]', { timeout: 10_000 }).then(() => ok('page ' + who + ': "1 conflict to resolve" in the review overview header'), () => fail('page ' + who + ': no conflict count in the overview header'));
    await P.evaluate(() => window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'list' } }));
    await P.evaluate((cid) => window._ccDispatch({ t: 'ACTIVE', id: cid }), id);
    await P.waitForSelector(`[data-item-id="${id}"] [data-cc-shared-resolver]`, { timeout: 10_000 });
    const det = await P.$eval(`[data-item-id="${id}"] [data-cc-shared-resolver]`, (el) => ({ text: el.textContent, use: el.querySelectorAll('[data-cc-shared-use]').length, fresh: !!el.querySelector('[data-cc-shared-new="status"]') }));
    check(det.use === 2 && /Resolved/.test(det.text) && /Closed/.test(det.text) && /In progress/.test(det.text) && det.fresh,
      'page ' + who + ': detail shows both values with "Use this", the agreed value and "enter new value"', JSON.stringify(det));
    check(/you/.test(det.text) && (who === 'A' ? /Bob/ : /Alice/).test(det.text), 'page ' + who + ': each value says who made it');
    // accessibility of the badge + resolver, light and dark (WCAG 2.1 AA)
    if (who === 'A') {
      await P.addScriptTag({ path: join(root, 'node_modules/axe-core/axe.min.js') }).catch(() => {});
      for (const theme of ['light', 'dark']) {
        await P.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await P.waitForTimeout(400);
        const v = await P.evaluate(async (sel) => {
          if (!window.axe) return null;
          const r = await window.axe.run({ include: sel.map((x) => [x]) }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
          return r.violations.map((x) => x.id + ' ×' + x.nodes.length);
        }, [`[data-item-id="${id}"] [data-cc-shared-resolver]`, `[data-item-id="${id}"] [data-cc-shared-conflict]`]);
        if (v === null) ok('axe-core not installed — accessibility check skipped');
        else check(v.length === 0, 'axe (' + theme + '): 0 violations on the conflict badge + resolver', JSON.stringify(v));
      }
      await P.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    }
    if (process.env.CC_SHARED_SHOTS) {
      await P.$eval(`[data-item-id="${id}"]`, (el) => el.scrollIntoView({ block: 'center' }));
      await P.screenshot({ path: join(process.env.CC_SHARED_SHOTS, 'conflict-' + who + '.png') });
      await P.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await P.waitForTimeout(400);
      await P.screenshot({ path: join(process.env.CC_SHARED_SHOTS, 'conflict-' + who + '-dark.png') });
      await P.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    }
  }

  // ── resolve on A ("use this" on Bob's value) → cleared on both ──
  const headId = (await A.evaluate((k) => window._ccLatestState.clashes.find((x) => x._identityKey === k)._sharedConflict[0].heads.find((h) => h.value === 'closed').id, K[1]));
  await A.click(`[data-cc-shared-use="${headId}"]`);
  await settle(A);
  await tick(B);
  for (const [P, who] of [[A, 'A'], [B, 'B']]) {
    const c = byKey(await clashes(P), K[1]);
    check(!c.conflict && c.status === 'closed', 'page ' + who + ': resolved to Closed, conflict cleared');
    const badge = await P.$(`[data-item-id="${c.id}"] [data-cc-shared-conflict]`);
    check(!badge, 'page ' + who + ': badge gone');
    check(await P.evaluate(() => window._ccLatestState.sharedProject.conflicts) === 0, 'page ' + who + ': conflict count 0');
  }

  // every change file in the folder was written once (no rewrites)
  const writes = [...(await A.evaluate(() => window.__fs.writes)), ...(await B.evaluate(() => window.__fs.writes))].filter((n) => n.endsWith('.json') && !n.startsWith('project-') && !n.startsWith('snapshot-'));
  check(new Set(writes).size === writes.length, 'no change file was written twice (' + writes.length + ' files)');
  files = await folder(A);
  console.log('folder: ' + Object.keys(files).sort().map((n) => n + ' ' + files[n] + ' B').join(', '));

  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('SHARED FOLDER: all checks passed');
