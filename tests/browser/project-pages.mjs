#!/usr/bin/env node
// "Persistence costs what changed" (docs/INTERNALS.md §21.53), in the real
// app: the project autosave record is a header + fixed-size clash/issue
// pages, and
//   * one clash status edit puts ONE page (bounded size) + the header
//   * a model visibility toggle (persisted modelMeta) puts the header only
//   * a storey hide (not persisted) puts nothing
//   * a page reload restores exactly the clashes / issues / model meta
//   * an edit followed at once by a reload (pagehide flush) is not lost
//   * a project saved as ONE record (before pages) loads identical and is
//     rewritten as pages on its first save; still identical after a reload
//   * the storage report counts header + pages as one project; deleting the
//     project removes every page
// Synthetic clash set (tests/fixtures/synthetic-conflicts.js), no IFC.
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/project-pages.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateGroupedClashes } = require(join(root, 'tests/fixtures/synthetic-conflicts.js'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
const N = 3000;

let failures = 0;
function report(name, ok, detail) {
  if (ok) console.log('PROJECT PAGES OK — ' + name);
  else { console.error('PROJECT PAGES FAIL: ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

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
const url = `http://127.0.0.1:${server.address().port}/`;
const exe = process.env.CC_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {});
const pageErrors = [];

async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {}
    // every put on the 'projects' store: its key and its structured size
    window.__puts = [];
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v) {
      if (this.name === 'projects') window.__puts.push({ key: JSON.stringify(v.id), page: Array.isArray(v.id), items: v.items ? v.items.length : null, bytes: JSON.stringify(v).length, hasClashes: !!v.clashes });
      return put.apply(this, arguments);
    };
  });
  if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);
  return ctx;
}
async function open(ctx, page) {
  page = page || await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccStorageCore, null, { timeout: 120_000 });
  return page;
}
// The stored project, reassembled by the same storage-core function the app uses.
const stored = (page, pid) => page.evaluate(async (pid) => {
  const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
  const tx = db.transaction('projects', 'readonly'), st = tx.objectStore('projects');
  const get = (q) => new Promise((res) => { q.onsuccess = () => res(q.result); });
  const header = await get(st.get(pid));
  const pages = await get(st.getAll(IDBKeyRange.bound([pid], [pid, []])));
  db.close();
  const data = window._ccStorageCore.assembleProjectRecord(header || null, pages);
  return { paged: !!(header && header._ccPages), headerHasClashes: !!(header && header.clashes), pages: pages.length,
    pageBytes: pages.reduce((n, p) => n + (p.bytes || 0), 0), headerBytes: header ? header.bytes : 0, data };
}, pid);
const digest = (page) => page.evaluate(() => {
  const s = window._ccLatestState;
  return JSON.stringify({ clashes: s.clashes.map((c) => Object.assign({}, c, { _delta: null })), issues: s.issues });
});
// Polls the stored project until pred(rec, state) holds (30 s).
async function waitSaved(page, pred, pid) {
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(async ([src, pid]) => {
      const f = new Function('rec', 'st', src);
      const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
      if (!db.objectStoreNames.contains('projects')) { db.close(); return false; }
      const tx = db.transaction('projects', 'readonly'), st = tx.objectStore('projects');
      const get = (q) => new Promise((res) => { q.onsuccess = () => res(q.result); });
      const header = await get(st.get(pid)); const pages = await get(st.getAll(IDBKeyRange.bound([pid], [pid, []])));
      db.close();
      return !!f(window._ccStorageCore.assembleProjectRecord(header || null, pages), window._ccLatestState);
    }, [pred, pid || 'default']);
    if (ok) return;
    if (Date.now() - t0 > 30_000) throw new Error('not saved within 30 s: ' + pred);
    await page.waitForTimeout(300);
  }
}
// _delta is reset to null by every project load (new/persisting marks of the
// last run), whatever the storage layout — compare without it.
try {
  const { items } = generateGroupedClashes(N, 90, { seed: 11 });
  const ctx = await newContext();
  let page = await open(ctx);
  await page.evaluate((its) => {
    window._ccDispatch({ t: 'ADD_MODEL', v: { id: 'model-0', name: 'Model 1', discipline: 'structural', visible: true, elements: [] } });
    window._ccDispatch({ t: 'ADD_MODEL', v: { id: 'model-1', name: 'Model 2', discipline: 'mep', visible: true, elements: [] } });
    window._ccDispatch({ t: 'SET_CLASHES', v: its });
    for (let i = 0; i < 3; i++) window._ccDispatch({ t: 'ADD_ISSUE', v: { id: 'iss-' + i, title: 'Issue ' + i, status: 'open', priority: 'normal', createdAt: '2026-10-01' } });
  }, items);
  await waitSaved(page, `return rec && rec.clashes && rec.clashes.length === st.clashes.length && rec.issues.length === st.issues.length`);
  const s0 = await stored(page, 'default');
  report('the project is stored as a header + pages', s0.paged && !s0.headerHasClashes && s0.pages === Math.ceil(N / 128) + 1, JSON.stringify({ paged: s0.paged, pages: s0.pages }));

  // ── one status edit: one page + the header ──
  await page.waitForTimeout(3500);
  await page.evaluate(() => { window.__puts = []; const c = window._ccLatestState.clashes[1500]; window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: 'resolved' } }); });
  await waitSaved(page, `return rec && rec.clashes[1500].status === 'resolved'`);
  await page.waitForTimeout(500);
  const p1 = await page.evaluate(() => window.__puts);
  const pagePuts = p1.filter((p) => p.page), headerPuts = p1.filter((p) => !p.page);
  const total = s0.pageBytes + s0.headerBytes;
  report('a status edit puts one clash page and the header', pagePuts.length === 1 && headerPuts.length === 1 && pagePuts[0].key === JSON.stringify(['default', 'c', Math.floor(1500 / 128)]), JSON.stringify(p1));
  report('the page put is bounded (≤ 128 clashes, a small fraction of the project)', pagePuts.length === 1 && pagePuts[0].items <= 128 && pagePuts[0].bytes < total / 10 && !headerPuts[0].hasClashes,
    JSON.stringify({ page: pagePuts[0] && pagePuts[0].bytes, header: headerPuts[0] && headerPuts[0].bytes, total }));

  // ── model visibility (persisted modelMeta): header only ──
  await page.evaluate(() => { window.__puts = []; window._ccDispatch({ t: 'UPD_MODEL', id: 'model-1', u: { visible: false } }); });
  await waitSaved(page, `return rec && rec.modelMeta && rec.modelMeta[1] && rec.modelMeta[1].visible === false`);
  await page.waitForTimeout(500);
  const p2 = await page.evaluate(() => window.__puts);
  report('a model visibility toggle writes the header only', p2.length === 1 && !p2[0].page, JSON.stringify(p2));

  // ── storey hide (not persisted): nothing ──
  await page.evaluate(() => { window.__puts = []; window.__m0 = window._ccLatestState.models; window._ccDispatch({ t: 'TOGGLE_ALL_STOREYS', id: 'model-0', storeys: ['Level 1'], hide: true }); });
  await page.waitForTimeout(5000);
  const p3 = await page.evaluate(() => ({ puts: window.__puts, changed: window.__m0 !== window._ccLatestState.models }));
  report('a storey hide (new models array, same modelMeta) writes nothing', p3.changed && p3.puts.length === 0, JSON.stringify(p3));

  // ── reload: identical ──
  const before = await digest(page);
  const metaBefore = JSON.stringify((await stored(page, 'default')).data.modelMeta);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await open(ctx, page).catch(() => {});
  await page.waitForFunction((n) => window._ccLatestState && window._ccLatestState.clashes.length === n, N, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  const after = await digest(page);
  report('a reload restores exactly the same clashes and issues', after === before, before.length + ' vs ' + after.length);
  report('model meta round-trips', JSON.stringify((await stored(page, 'default')).data.modelMeta) === metaBefore);

  // ── edit then reload at once: the pagehide flush keeps it ──
  await page.waitForTimeout(3000);
  const flushId = await page.evaluate(() => { const c = window._ccLatestState.clashes[2900]; window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: 'in_progress', assignee: 'flush' } }); return c.id; });
  await page.waitForTimeout(150); // well inside the 2 s autosave debounce
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((n) => window._ccLatestState && window._ccLatestState.clashes.length === n, N, { timeout: 60_000 });
  const flushed = await page.evaluate((id) => { const c = window._ccLatestState.clashes.find((x) => x.id === id); return c && c.status + '/' + c.assignee; }, flushId);
  report('an edit right before a reload is saved by the pagehide flush', flushed === 'in_progress/flush', String(flushed));

  // ── storage report: one project, bytes = header + pages ──
  await page.waitForTimeout(3500);
  const rep = await page.evaluate(() => window.ClashControl.storage.report());
  const s5 = await stored(page, 'default');
  const row = rep && rep.perProject.find((p) => p.projectId === 'default');
  report('the storage report counts header + pages as one project', !!row && rep.perProject.filter((p) => p.projectId === 'default').length === 1 && row.sessionBytes === s5.headerBytes + s5.pageBytes,
    JSON.stringify({ row, header: s5.headerBytes, pages: s5.pageBytes }));
  const finalDigest = await digest(page);
  await page.close();

  // ── a project saved as one record before pages: loads identical, migrates ──
  const ctx2 = await newContext();
  const seedPage = await ctx2.newPage();
  await seedPage.goto(url + 'version.json');
  const legacyData = s5.data; // what this project's single record would have held
  await seedPage.evaluate(async (rec) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('ClashControlFiles', 4);
      r.onupgradeneeded = () => { const d = r.result; ['ifcFiles', 'projects', 'geoCache'].forEach((n) => { const st = d.createObjectStore(n, { keyPath: 'id' }); st.createIndex('cc_meta', n === 'ifcFiles' ? ['bytes', 'savedAt', 'projectId', 'name'] : n === 'geoCache' ? ['bytes', 'savedAt'] : ['bytes']); if (n === 'ifcFiles') st.createIndex('projectId', 'projectId'); }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(Object.assign({}, rec, { id: 'default' }));
    await new Promise((res) => { tx.oncomplete = res; });
    db.close();
  }, legacyData);
  await seedPage.close();
  const lp = await open(ctx2);
  await lp.waitForFunction((n) => window._ccLatestState && window._ccLatestState.clashes.length === n, N, { timeout: 60_000 });
  await lp.waitForTimeout(500);
  report('a single-record project loads identical', await digest(lp) === finalDigest);
  await lp.evaluate(() => { const c = window._ccLatestState.clashes[10]; window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { priority: 'high' } }); });
  await waitSaved(lp, `return rec && rec.clashes && rec.clashes[10].priority === 'high'`);
  const m = await stored(lp, 'default');
  report('its first save rewrites it as header + pages', m.paged && !m.headerHasClashes && m.pages === Math.ceil(N / 128) + 1, JSON.stringify({ paged: m.paged, pages: m.pages }));
  const migrated = await digest(lp);
  await lp.reload({ waitUntil: 'domcontentloaded' });
  await lp.waitForFunction((n) => window._ccLatestState && window._ccLatestState.clashes.length === n, N, { timeout: 60_000 });
  await lp.waitForTimeout(500);
  report('the migrated project reloads identical', await digest(lp) === migrated);

  // ── delete: header and every page gone ──
  const del = await lp.evaluate(async () => {
    await window._ccDeleteProjectStorage('default');
    const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
    const keys = await new Promise((res) => { const q = db.transaction('projects', 'readonly').objectStore('projects').getAllKeys(); q.onsuccess = () => res(q.result); });
    db.close();
    return keys.filter((k) => k === 'default' || (Array.isArray(k) && k[0] === 'default')).length;
  });
  report('deleting the project removes the header and every page', del === 0, String(del));
} catch (e) {
  report('exception', false, e && e.stack || String(e));
} finally {
  report('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
}
if (failures) { console.error(`PROJECT PAGES: ${failures} failure(s)`); process.exit(1); }
console.log('PROJECT PAGES: all checks passed');
