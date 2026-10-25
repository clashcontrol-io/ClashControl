#!/usr/bin/env node
// Linked issues follow their clash across re-runs (docs/INTERNALS.md §21.58),
// in the real app on a synthetic two-model federation:
//   * a confirmed clash (its issue created by Confirm) whose element is moved
//     away is auto-resolved by the next run, and its issue is resolved with a
//     "Resolved by re-check on <date>" comment and the toast
//     "1 issue resolved by this run"
//   * undo puts the issue back (status + comments), redo resolves it again
//   * an issue a person closed is never touched
//   * moving the element back: the next run finds the clash again, it is
//     confirmed again and its issue reopens with a note
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/clash-lifecycle.mjs
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
function ok(msg) { console.log('LIFECYCLE OK — ' + msg); }
function fail(msg) { console.error('LIFECYCLE FAIL: ' + msg); failures++; }
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

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); localStorage.setItem('cc_username', 'Alice'); } catch (e) {}
    window.__toasts = [];
  });
  if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (dl) => dl.accept());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // same readiness as cloud-share.mjs; loading the second model asks a question (accepted above)
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccSharedSessionCore && window._ccCloudShare, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const orig = window._ccToast;
    window._ccToast = function(m) { window.__toasts.push(String(m)); return orig && orig.apply(this, arguments); };
    window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } });
  });
  await page.evaluate(async () => {
    for (const [p, n] of [['/__a.ifc', 'arch.ifc'], ['/__b.ifc', 'struct.ifc']]) {
      const buf = await (await fetch(p)).arrayBuffer();
      window.ClashControl.loadFiles([new File([buf], n)]);
      await new Promise((resolve) => { const iv = setInterval(() => { const s = window._ccLatestState; if (s.models.some((m) => m.name === n.replace('.ifc', '') && (m.elements || []).length) && !window._ccModelLoading) { clearInterval(iv); resolve(); } }, 50); });
    }
  });
  const run = () => page.evaluate(() => { const s = window._ccLatestState; const t0 = s.lastDeltaSummary ? s.lastDeltaSummary.ts : 0; window._ccRunDetection(); return t0; })
    .then((t0) => page.waitForFunction((t) => { const s = window._ccLatestState; return !s.detecting && s.lastDeltaSummary && s.lastDeltaSummary.ts > t; }, t0, { timeout: 120_000, polling: 100 }));
  await run();
  const n0 = await page.evaluate(() => window._ccLatestState.clashes.length);
  check(n0 >= 2, 'synthetic federation detected ' + n0 + ' clashes');

  // Confirm one clash (→ its issue), and close the issue of another by hand.
  const pick = await page.evaluate(() => {
    const s = window._ccLatestState;
    const c = s.clashes[0];
    const other = s.clashes.find((x) => x.elemB !== c.elemB && x.elemA !== c.elemA && x.modelBId === c.modelBId);
    window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: 'confirmed' } });
    return { id: c.id, key: c._identityKey, elemB: c.elemB, modelB: c.modelBId, other: other ? other.id : null };
  });
  await page.waitForFunction((id) => window._ccLatestState.clashes.find((c) => c.id === id).linkedIssueId, pick.id);
  const issueId = await page.evaluate((id) => window._ccLatestState.clashes.find((c) => c.id === id).linkedIssueId, pick.id);
  check(!!issueId, 'Confirm created the issue ' + issueId);
  let closedId = null;
  if (pick.other) {
    await page.evaluate((id) => window._ccDispatch({ t: 'UPD_CLASH', id, u: { status: 'confirmed' } }), pick.other);
    closedId = await page.waitForFunction((id) => window._ccLatestState.clashes.find((c) => c.id === id).linkedIssueId, pick.other).then((h) => h.jsonValue());
    await page.evaluate((iid) => window._ccDispatch({ t: 'UPD_ISSUE', id: iid, u: { status: 'closed' } }), closedId);
  }

  // Move the confirmed clash's B element far away (and the other one's too:
  // a closed issue must stay closed when its clash goes).
  const move = (dx) => page.evaluate(([p, d]) => {
    const st = window._ccLatestState;
    const m = st.models.find((x) => x.id === p.modelB);
    const ids = [p.elemB];
    if (p.other) ids.push(st.clashes.find((c) => c.id === p.other).elemB);
    for (const eid of ids) {
      const el = m.elements.find((e) => e.expressId === eid);
      el.meshes.forEach((mesh) => { mesh.position.x += d; mesh.updateMatrix(); mesh.updateMatrixWorld(true); });
      el.box.min.x += d; el.box.max.x += d;
    }
  }, [pick, dx]);
  await move(50);
  await page.evaluate(() => { window.__toasts.length = 0; });
  await run();
  const after = await page.evaluate(([cid, iid, xid]) => {
    const s = window._ccLatestState;
    return { clash: (s.clashes.find((c) => c.id === cid) || {}).status, issue: s.issues.find((i) => i.id === iid), closed: xid ? s.issues.find((i) => i.id === xid).status : null,
      sum: s.lastDeltaSummary, toasts: window.__toasts.slice(), undo: window._ccUndoInfo() };
  }, [pick.id, issueId, closedId]);
  check(after.clash === 'auto_resolved', 'the run auto-resolved the confirmed clash (kept in the list)', after.clash);
  check(after.issue.status === 'resolved' && /^Resolved by re-check on /.test(after.issue.comments.at(-1).text), 'its issue is resolved with "Resolved by re-check on <date>"', JSON.stringify(after.issue.comments));
  check(after.sum.issuesResolved === 1, 'run summary: issuesResolved 1');
  await page.waitForFunction(() => window.__toasts.some((m) => m === '1 issue resolved by this run'), null, { timeout: 5_000 })
    .then(() => ok('toast "1 issue resolved by this run"'), async () => fail('no toast: ' + JSON.stringify(await page.evaluate(() => window.__toasts))));
  if (closedId) check(after.closed === 'closed', 'an issue a person closed stays closed');

  // Undo → the issue is back as it was; redo resolves it again.
  await page.evaluate(() => window._ccUndo());
  const undone = await page.waitForFunction((iid) => { const i = window._ccLatestState.issues.find((x) => x.id === iid); return i.status === 'open' && i; }, issueId, { timeout: 5_000 }).then((h) => h.jsonValue(), () => null);
  check(!!undone && !(undone.comments || []).length && !undone.autoResolved, 'undo restores the issue (open, no re-check comment)', JSON.stringify(undone));
  await page.evaluate(() => window._ccRedo());
  const redone = await page.waitForFunction((iid) => window._ccLatestState.issues.find((x) => x.id === iid).status === 'resolved', issueId, { timeout: 5_000 }).then(() => true, () => false);
  check(redone, 'redo resolves it again');

  // The element comes back: the clash is found again → confirmed, issue reopened.
  await move(-50);
  await run();
  const back = await page.evaluate(([key, iid]) => {
    const s = window._ccLatestState;
    const c = s.clashes.find((x) => x._identityKey === key);
    return { status: c && c.status, link: c && c.linkedIssueId, issue: s.issues.find((i) => i.id === iid), sum: s.lastDeltaSummary };
  }, [pick.key, issueId]);
  check(back.status === 'confirmed' && back.link === issueId, 'the clash found again is confirmed and still linked', JSON.stringify({ status: back.status, link: back.link }));
  check(back.issue.status === 'open' && /^Reopened: the clash was found again by re-check on /.test(back.issue.comments.at(-1).text) && back.sum.issuesReopened === 1,
    'its issue is reopened with a note', JSON.stringify(back.issue.comments));

  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('LIFECYCLE: all checks passed');
