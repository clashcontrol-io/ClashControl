// Clash triage, review overview and smart filtering on the generated
// federation (tests/fixtures/generate-building-ifc.js — architecture +
// structure + MEP, 22 planted cases), in the real app:
//   * review buckets: every planted real clash (crossing / contained /
//     clearance within the tolerance) stays in 'review'; contacts and the
//     provided opening land in their own buckets; the bucket counts add up to
//     the raw total; buckets never change the raw result
//   * the overview shows exactly the review set (groups + singles), opens
//     after an interactive run, and supports J/K + Enter + Escape
//   * snapshots: no snapshot work while detection runs, rendered at idle,
//     deterministic (same pixels twice), cached (memory + IndexedDB),
//     invalidated when an element's geometry changes on a re-run
//   * smart filters: live facet counts, suggested views, pills + reset,
//     saved views round-trip through the project codec
//   * BCF "shown (N)" vs "all (M)" topic counts, review-item labels, snapshots
//   * axe-core: 0 violations on the overview + filter UI in light, dark and a
//     phone-sized viewport
// Screenshots: $CC_TRIAGE_SHOTS (default <os.tmpdir()>/cc-triage-shots).
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/triage-overview.mjs
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateBuilding } = require(join(root, 'tests/fixtures/generate-building-ifc.js'));
const JSZip = require(join(root, 'node_modules/jszip'));
const SHOTS = process.env.CC_TRIAGE_SHOTS || join(tmpdir(), 'cc-triage-shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

let failures = 0;
function fail(msg) { console.error('TRIAGE FAIL: ' + msg); failures++; }
function ok(msg) { console.log('TRIAGE OK — ' + msg); }

const gen = generateBuilding({ scale: process.env.CC_GEN_SCALE || 'ci', seed: 4242, georef: 'local' });
const files = new Map();
for (const k of ['architecture', 'structure', 'mep']) files.set('/__gen/' + gen.fileNames[k], Buffer.from(gen.files[k]));

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
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const pageErrors = [];

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {} });
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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccClashSnapshots, null, { timeout: 60_000 });
  // no welcome / consent overlays in the way
  await page.evaluate(() => { try { localStorage.setItem('cc_consent_banner_seen', '1'); } catch (e) {} window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } }); });
  return page;
}
async function load(page) {
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (n) => new File([await (await fetch('/__gen/' + n)).arrayBuffer()], n)));
    window.ClashControl.loadFiles(fs);
  }, [gen.fileNames.architecture, gen.fileNames.structure, gen.fileNames.mep]);
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && s.models.length === 3 && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false; }, null, { timeout: 240_000, polling: 500 });
}
async function axe(page, label, include) {
  await page.addScriptTag({ path: join(root, 'node_modules/axe-core/axe.min.js') }).catch(() => {});
  const res = await page.evaluate(async (sel) => {
    const r = await window.axe.run({ include: sel.map((s) => [s]) }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => ({ id: v.id, n: v.nodes.length, impact: v.impact, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n')[1]) }));
  }, include);
  if (res.length) fail('axe (' + label + '): ' + JSON.stringify(res, null, 1));
  else ok('axe (' + label + '): 0 violations on ' + include.join(', '));
}

await mkdir(SHOTS, { recursive: true });
try {
  const page = await newPage();
  await load(page);
  ok('federation loaded (' + gen.manifest.cases.length + ' planted cases)');

  // ── interactive run; watch the snapshot service during detection ──
  await page.evaluate(() => {
    window.__snapDuringDetect = { samples: 0, renderedAtStart: window._ccClashSnapshots.stats().rendered, maxRenderedDuring: 0 };
    window.__snapTimer = setInterval(() => {
      const st = window._ccLatestState;
      if (st && st.detecting) { window.__snapDuringDetect.samples++; window.__snapDuringDetect.maxRenderedDuring = Math.max(window.__snapDuringDetect.maxRenderedDuring, window._ccClashSnapshots.stats().rendered); }
    }, 10);
    // something queued before the run must still wait for it
    window._ccRunDetectionInteractive();
  });
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && !s.detecting && s.runHistory.length > 0; }, null, { timeout: 240_000, polling: 200 });
  const during = await page.evaluate(() => { clearInterval(window.__snapTimer); return Object.assign({}, window.__snapDuringDetect, { whileDetecting: window._ccClashSnapshots.stats().renderedWhileDetecting }); });
  if (during.whileDetecting !== 0 || during.maxRenderedDuring > during.renderedAtStart) fail('snapshot work happened during detection: ' + JSON.stringify(during));
  else ok('no snapshot rendered while detection ran (' + during.samples + ' samples)');

  // ── buckets: Σ == raw; planted real clashes stay in review ──
  const sum = await page.evaluate(() => window.ClashControl.review.summary());
  const raw = await page.evaluate(() => window._ccLatestState.clashes.length);
  const bsum = Object.values(sum.buckets).reduce((a, b) => a + b, 0);
  if (bsum !== sum.total || sum.total !== raw) fail(`bucket sum ${bsum} / visible total ${sum.total} / raw ${raw}`);
  else ok(`Σ buckets == raw (${raw}): ` + JSON.stringify(sum.buckets) + ` -> ${sum.reviewItems} review items (${sum.reviewClashes} clashes)`);
  const planted = await page.evaluate((cases) => {
    const core = window._ccClashClassificationCore, st = window._ccLatestState;
    const ctxT = { twice: core.findTwice(st.clashes), roleChoice: (g, r) => window._ccClashDisciplineCore.roleChoice(g, r) };
    return cases.map((c) => {
      const hits = st.clashes.filter((x) => (x.globalIdA === c.a.globalId && x.globalIdB === c.b.globalId) || (x.globalIdA === c.b.globalId && x.globalIdB === c.a.globalId));
      return { id: c.id, name: c.name, category: c.category, rel: c.toleranceRelation || null, opening: c.opening || null,
        found: hits.map((h) => ({ type: h.type, bucket: core.reviewBucket(h, st.rules, ctxT), extent: h.extent || null, sev: h.aiSeverity })) };
    });
  }, gen.manifest.cases);
  let plantedBad = 0, inReview = 0;
  for (const p of planted) {
    const expectReview = p.category === 'crossing' || p.category === 'contained' || (p.category === 'clearance' && p.rel !== 'above' && !p.opening);
    const expect = expectReview ? 'review' : p.category === 'contact' ? 'contact' : p.opening === 'provided' ? 'provided' : null;
    const buckets = p.found.map((f) => f.bucket);
    if (expect && (!buckets.length || buckets.some((b) => b !== expect))) { plantedBad++; fail(`planted ${p.id} "${p.name}" expected ${expect}, got ${JSON.stringify(p.found)}`); }
    if (!expect && buckets.length) { plantedBad++; fail(`planted ${p.id} "${p.name}" should not be reported, got ${JSON.stringify(p.found)}`); }
    if (expect === 'review') inReview++;
  }
  if (!plantedBad) ok(`all ${inReview} planted real clashes stay in 'review'; contacts / provided opening in their own buckets; separate + above-tolerance unreported`);

  // ── overview opened by the interactive run, shows exactly the review set ──
  if (sum.reviewItems > 150) await page.click('[data-cc-overview-prompt] button');
  await page.waitForSelector('[data-cc-overview]', { timeout: 10_000 }).catch(() => fail('overview did not open after an interactive run'));
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-cc-card-key]')].map((b) => b.getAttribute('data-cc-card-key')));
  const expectKeys = sum.items.slice(0, cards.length).map((i) => i.key);
  if (cards.length !== Math.min(60, sum.reviewItems) || JSON.stringify(cards) !== JSON.stringify(expectKeys)) fail('overview cards != review items: ' + cards.length + ' vs ' + sum.reviewItems);
  else ok(`overview shows exactly the review items (${cards.length} cards = ${sum.reviewItems} review items, same order)`);
  const reviewIdsOk = await page.evaluate(() => {
    const st = window._ccLatestState, core = window._ccClashClassificationCore, sm = window.ClashControl.review.summary();
    const ctxT = { twice: core.findTwice(st.clashes), roleChoice: (g, r) => window._ccClashDisciplineCore.roleChoice(g, r) };
    const ids = new Set(sm.items.flatMap((i) => i.ids));
    const review = st.clashes.filter((c) => core.reviewBucket(c, st.rules, ctxT) === 'review');
    return { same: review.length === ids.size && review.every((c) => ids.has(c.id)), review: review.length, ids: ids.size };
  });
  if (!reviewIdsOk.same) fail('overview members != review bucket: ' + JSON.stringify(reviewIdsOk));
  else ok('overview members are exactly the review bucket (' + reviewIdsOk.ids + ' clashes)');

  // ── snapshots at idle ──
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelectorAll('[data-cc-overview] [data-cc-snapshot]').length >= Math.min(6, document.querySelectorAll('[data-cc-card-key]').length), null, { timeout: 120_000, polling: 250 })
    .catch(() => fail('snapshots did not appear on the overview cards'));
  const snapStats = await page.evaluate(() => window._ccClashSnapshots.stats());
  ok(`snapshots rendered at idle: ${snapStats.rendered} in ${Date.now() - t0} ms wall, median ${snapStats.medianMs && snapStats.medianMs.toFixed(1)} ms / max ${snapStats.maxMs && snapStats.maxMs.toFixed(1)} ms per card, ${snapStats.busyDeferrals} busy deferrals`);
  const det = await page.evaluate(() => {
    const it = window.ClashControl.review.summary().items[0];
    const c = window._ccLatestState.clashes.find((x) => x.id === it.ids[0]);
    const svc = window._ccClashSnapshots;
    const a = svc.renderNow(c), b = svc.renderNow(c), rec = svc.record(c);
    return { a: a.hash, b: b.hash, cached: rec && rec.hash, key: svc.key(c) };
  });
  if (det.a !== det.b || (det.cached && det.cached !== det.a)) fail('snapshot not deterministic: ' + JSON.stringify(det));
  else ok('snapshot deterministic (hash ' + det.a + ', cached copy identical)');
  // IndexedDB: drop the memory cache, ask again -> served from IDB, same picture
  const idb = await page.evaluate(async () => {
    const svc = window._ccClashSnapshots, it = window.ClashControl.review.summary().items[0];
    const c = window._ccLatestState.clashes.find((x) => x.id === it.ids[0]);
    const before = svc.record(c);
    await new Promise((r) => setTimeout(r, 300));
    svc.clearMemory();
    const h0 = svc.stats().idbHits;
    svc.request(c);
    for (let i = 0; i < 50 && !svc.record(c); i++) await new Promise((r) => setTimeout(r, 50));
    const after = svc.record(c);
    return { idbHits: svc.stats().idbHits - h0, same: !!(before && after && before.hash === after.hash) };
  });
  if (!idb.same || idb.idbHits < 1) fail('IndexedDB snapshot cache: ' + JSON.stringify(idb));
  else ok('snapshot cache survives a memory drop (served from IndexedDB, same picture)');

  await page.screenshot({ path: join(SHOTS, 'overview-light.png') });

  // ── keyboard: J/K move focus, Enter opens (flies + closes), Escape closes ──
  const kb = await page.evaluate(async () => {
    const first = document.querySelector('[data-cc-card-idx="0"]'); first.focus();
    const ev = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    ev('j'); await new Promise((r) => setTimeout(r, 50));
    const afterJ = document.activeElement.getAttribute('data-cc-card-idx');
    ev('k'); await new Promise((r) => setTimeout(r, 50));
    return { afterJ, afterK: document.activeElement.getAttribute('data-cc-card-idx') };
  });
  if (kb.afterJ !== '1' || kb.afterK !== '0') fail('J/K card navigation: ' + JSON.stringify(kb));
  else ok('J/K move between cards');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-cc-overview]') && window._ccLatestState.activeId, null, { timeout: 5000 }).catch(() => fail('Enter on a card did not open the clash'));
  const act = await page.evaluate(() => ({ active: window._ccLatestState.activeId, first: window.ClashControl.review.summary().items[0].ids[0] }));
  if (act.active !== act.first) fail('opened the wrong clash ' + JSON.stringify(act)); else ok('Enter flies to the clash and returns to the 3D view');
  await page.click('[data-cc-view="overview"]');
  await page.waitForSelector('[data-cc-overview]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-cc-overview]'), null, { timeout: 5000 }).catch(() => fail('Escape did not close the overview'));
  await page.click('[data-cc-view="overview"]');
  await page.waitForSelector('[data-cc-overview]');

  // ── smart filters ──
  await page.evaluate(() => { document.querySelectorAll('[data-cc-facets]').forEach((d) => { d.open = true; }); });
  const facet = await page.evaluate(async () => {
    const root = document.querySelector('[data-cc-overview]');
    const chips = [...root.querySelectorAll('[data-cc-facet="severity"] [data-cc-chip]')];
    const counts = chips.map((c) => ({ v: c.getAttribute('data-cc-chip'), n: +c.querySelector('span').textContent }));
    const sumC = counts.reduce((a, b) => a + b.n, 0);
    const pick = counts.find((c) => c.n > 0);
    root.querySelector('[data-cc-chip="' + pick.v + '"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const after = window.ClashControl.review.summary();
    const pills = root.querySelectorAll('[data-cc-pill]').length;
    return { counts, sumC, pick, reviewClashes: after.reviewClashes, pills, shownText: root.querySelector('[data-cc-shown-total]').textContent };
  });
  if (facet.sumC !== sum.reviewClashes) fail('severity chip counts do not add up to the review set: ' + JSON.stringify(facet));
  else if (facet.reviewClashes !== facet.pick.n || facet.pills !== 1) fail('chip count != filtered result: ' + JSON.stringify(facet));
  else ok(`facet chips: counts add up (${facet.sumC}), "${facet.pick.v}" shows exactly ${facet.pick.n}, one pill, "${facet.shownText}"`);
  const sv = await page.evaluate(async () => {
    const root = document.querySelector('[data-cc-overview]');
    const views = [...root.querySelectorAll('[data-cc-suggested]')].map((b) => ({ id: b.getAttribute('data-cc-suggested'), n: +b.querySelector('span').textContent }));
    return views;
  });
  if (sv.some((v) => !(v.n > 0))) fail('a suggested view with no results is offered: ' + JSON.stringify(sv));
  else ok('suggested views (all non-empty): ' + sv.map((v) => v.id + ' ' + v.n).join(', '));
  // save the current filter as a view, reset, apply it again, codec round trip
  await page.click('[data-cc-overview] [data-cc-save-view]');
  await page.fill('[data-cc-overview] [data-cc-save-view-name]', 'Triage test view');
  await page.keyboard.press('Enter');
  const rt = await page.evaluate(async () => {
    const st0 = window._ccLatestState, facets0 = JSON.stringify(st0.triage.facets);
    document.querySelector('[data-cc-overview] [data-cc-reset]').click();
    await new Promise((r) => setTimeout(r, 100));
    const cleared = JSON.stringify(window._ccLatestState.triage.facets);
    document.querySelector('[data-cc-overview] [data-cc-saved-view="Triage test view"]').click();
    await new Promise((r) => setTimeout(r, 100));
    const reapplied = JSON.stringify(window._ccLatestState.triage.facets);
    const data = JSON.parse(JSON.stringify(window._ccProjectCodec.serializeProject(window._ccLatestState, 'v', 't')));
    window._ccDispatch({ t: 'TRIAGE_STATE', v: {} });
    await new Promise((r) => setTimeout(r, 50));
    const wiped = window._ccLatestState.triage.savedViews.length;
    const tr = data.triage;
    window._ccDispatch({ t: 'TRIAGE_STATE', v: { facets: tr.facets, view: tr.view, savedViews: tr.savedViews, activeViewId: tr.activeViewId } });
    await new Promise((r) => setTimeout(r, 50));
    const back = window._ccLatestState.triage;
    return { facets0, cleared, reapplied, wiped, saved: back.savedViews.map((v) => v.name), facetsBack: JSON.stringify(back.facets) };
  });
  if (rt.cleared !== '{}' || rt.reapplied !== rt.facets0 || rt.wiped !== 0 || rt.saved[0] !== 'Triage test view' || rt.facetsBack !== rt.facets0) fail('saved view round trip: ' + JSON.stringify(rt));
  else ok('saved view: reset clears, re-apply restores, project codec round-trip keeps it (' + rt.facets0 + ')');
  // clear for the BCF counts
  await page.evaluate(() => { window._ccDispatch({ t: 'TRIAGE_UPD', u: { facets: {} } }); });

  // ── BCF shown / all ──
  async function bcfTopics(scope) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.evaluate((sc) => window.ClashControl.review.exportBCF(sc, '2.1'), scope)]);
    const buf = await readFile(await dl.path());
    const zip = await JSZip.loadAsync(buf);
    const markups = Object.keys(zip.files).filter((f) => f.endsWith('/markup.bcf'));
    const pngs = Object.keys(zip.files).filter((f) => f.endsWith('.png'));
    const sample = markups.length ? await zip.file(markups[0]).async('string') : '';
    return { topics: markups.length, pngs: pngs.length, sample };
  }
  const shownB = await bcfTopics('shown'), allB = await bcfTopics('all');
  const sumNow = await page.evaluate(() => window.ClashControl.review.summary());
  if (shownB.topics !== sumNow.reviewClashes || allB.topics !== raw) fail(`BCF topics shown ${shownB.topics} (want ${sumNow.reviewClashes}) / all ${allB.topics} (want ${raw})`);
  else ok(`BCF shown (${shownB.topics}) / all (${allB.topics}) topic counts match; shown export carries ${shownB.pngs} snapshot.png files`);
  if (!/<Labels>[^<]+<\/Labels>/.test(shownB.sample)) fail('shown BCF topic has no review-item label'); else ok('shown BCF topics are labelled with their review item title');

  // ── invalidation: change an element's geometry, re-run -> new picture ──
  const inv = await page.evaluate(async () => {
    const svc = window._ccClashSnapshots, st = window._ccLatestState;
    const it = window.ClashControl.review.summary().items[0];
    const c = st.clashes.find((x) => x.id === it.ids[0]);
    const key0 = svc.key(c), inv0 = svc.stats().invalidated;
    const m = st.models.find((mm) => mm.id === c.modelAId), el = m.elements.find((e) => e.expressId === c.elemA);
    el.meshes.forEach((me) => { me.position.x += 0.004; me.updateMatrix(); me.updateMatrixWorld(true); });
    el.box.translate({ x: 0.004, y: 0, z: 0 });
    const res = await window.ClashControl.runDetection({});
    await new Promise((r) => setTimeout(r, 300));
    const c2 = window._ccLatestState.clashes.find((x) => x.globalIdA === c.globalIdA && x.globalIdB === c.globalIdB) || c;
    const key1 = svc.key(c2);
    svc.request(c2, { front: true });
    for (let i = 0; i < 200 && !svc.record(c2); i++) await new Promise((r) => setTimeout(r, 50));
    return { key0, key1, rerun: (res || []).length, invalidated: svc.stats().invalidated - inv0, has: !!svc.record(c2) };
  });
  if (inv.key0 === inv.key1 || !inv.has || inv.invalidated < 1) fail('snapshot invalidation on geometry change: ' + JSON.stringify(inv));
  else ok('a geometry change on re-run gives the clash a new snapshot key; the old picture is dropped');

  // ── axe: light / dark (overview + clash panel filters) ──
  await page.evaluate(() => { window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'overview' } }); window._ccDispatch({ t: 'UPD_PREFS', u: { theme: 'light' } }); });
  await page.waitForSelector('[data-cc-overview]');
  await page.evaluate(() => { document.querySelectorAll('[data-cc-facets]').forEach((d) => { d.open = true; }); });
  await new Promise((r) => setTimeout(r, 400));
  await axe(page, 'light', ['[data-cc-overview]', '[data-cc-bucket-bar]', '[data-cc-triage-filters]']);
  await page.screenshot({ path: join(SHOTS, 'overview-light-filters.png') });
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { theme: 'dark' } }));
  await new Promise((r) => setTimeout(r, 500));
  await axe(page, 'dark', ['[data-cc-overview]', '[data-cc-bucket-bar]', '[data-cc-triage-filters]']);
  await page.screenshot({ path: join(SHOTS, 'overview-dark.png') });
  await page.evaluate(() => window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'list' } }));
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: join(SHOTS, 'list-dark.png') });
  await page.context().close();

  // ── mobile viewport ──
  const mob = await newPage({ width: 390, height: 844 });
  await load(mob);
  await mob.evaluate(() => window._ccRunDetectionInteractive());
  await mob.waitForFunction(() => { const s = window._ccLatestState; return s && !s.detecting && s.runHistory.length > 0; }, null, { timeout: 240_000, polling: 200 });
  await mob.evaluate(() => { window._ccDispatch({ t: 'TAB', v: 'clashes' }); window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'overview' } }); window._ccDispatch({ t: 'UPD_PREFS', u: { theme: 'light' } }); });
  await mob.waitForSelector('[data-cc-overview]', { timeout: 10_000 }).catch(() => fail('overview not shown on mobile'));
  await mob.waitForFunction(() => document.querySelectorAll('[data-cc-overview] [data-cc-snapshot]').length >= 1, null, { timeout: 60_000 }).catch(() => {});
  const overflow = await mob.evaluate(() => { const o = document.querySelector('[data-cc-overview]'); return o ? o.scrollWidth - o.clientWidth : -1; });
  if (overflow > 1) fail('overview scrolls sideways on a phone (' + overflow + ' px)'); else ok('no horizontal scroll in the overview on a 390 px phone');
  await axe(mob, 'mobile', ['[data-cc-overview]']);
  await mob.screenshot({ path: join(SHOTS, 'overview-mobile.png') });
  await mob.context().close();

  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
  console.log('screenshots: ' + SHOTS);
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`TRIAGE: ${failures} failure(s)`); process.exit(1); }
console.log('TRIAGE OVERVIEW OK');
