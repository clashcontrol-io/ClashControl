// Model version comparison v2 (docs/INTERNALS.md §21.62), in the real app.
//
// A generated structure + MEP federation (tests/fixtures/generate-building-ifc.js,
// scale ci, seed 4242, synthetic only) is loaded and checked once; then the
// MEP file is reloaded under the same name with seed-controlled edits:
//   one element MOVED (new placement relative to its own), one RESHAPED (its
//   extrusion depth ×1.5), one PROPERTY changed (a pset value), one REMOVED
//   and one ADDED (a new duct with its own representation).
// Checks:
//   - the stored diff: exactly 1 added / 1 removed / 1 moved / 1 reshaped /
//     1 property change, on the right GlobalIds, once the lazy psets landed;
//   - the model card says "1 added · 1 removed · 2 moved or reshaped · 1 property change";
//   - Navigator "Added and changed" lists exactly the 4 new-version elements, "Added" the 1;
//   - after a re-run, the suggested view "Clashes on changed elements" lists
//     the clashes on changed elements and filters to them;
//   - CSV rows (GlobalId, change, property old → new) and the printable report;
//   - "Show changes" paints added elements --color-success and changed ones the
//     DESIGN.md info blue (no amber);
//   - a re-load of the SAME text is all unchanged (no false changes).
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/model-compare.mjs
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
function fail(msg) { console.error('MODEL-COMPARE FAIL: ' + msg); failures++; }
function ok(msg) { console.log('MODEL-COMPARE OK — ' + msg); }
function check(cond, msg, detail) { if (cond) ok(msg); else fail(msg + (detail ? ' :: ' + detail : '')); }

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local' });
const files = new Map();
for (const k of ['structure', 'mep']) files.set('/__gen/' + k, Buffer.from(gen.files[k]));

// ── IFC text edits (every existing #id keeps its number; new entities are
// appended before the DATA section's ENDSEC) ──
const PRODUCT_RE = /^(#(\d+)=IFC[A-Z]+\('([^']*)',[^,]*,'[^']*',[^,]*,[^,]*,)(#\d+)(,(#\d+|\$),.*)$/;
const refRe = (id) => new RegExp('#' + id + '(?!\\d)');
function maxId(lines) { let m = 0; for (const l of lines) { const n = /^#(\d+)=/.exec(l); if (n) m = Math.max(m, +n[1]); } return m; }
function endsecAt(lines) { const d = lines.findIndex((l) => l.trim() === 'DATA;'); return lines.findIndex((l, i) => i > d && l.trim() === 'ENDSEC;'); }
function lineOf(lines, id) { const re = new RegExp('^#' + id + '='); return lines.findIndex((l) => re.test(l)); }
function product(lines, id) { const i = lineOf(lines, id); const m = i >= 0 && lines[i].match(PRODUCT_RE); return m ? { i, m, gid: m[3], pl: m[4], pds: (m[5].match(/^,(#\d+|\$)/) || [])[1] } : null; }
// moved: a new placement relative to its own (as tests/browser/auto-rerun.mjs)
function moveEl(lines, id, d) {
  const p = product(lines, id), mx = maxId(lines);
  lines[p.i] = p.m[1] + '#' + (mx + 3) + p.m[5];
  lines.splice(endsecAt(lines), 0, `#${mx + 1}=IFCCARTESIANPOINT((${d.toFixed(4)},${d.toFixed(4)},${d.toFixed(4)}));`, `#${mx + 2}=IFCAXIS2PLACEMENT3D(#${mx + 1},$,$);`, `#${mx + 3}=IFCLOCALPLACEMENT(${p.pl},#${mx + 2});`);
}
// the single unshared IFCEXTRUDEDAREASOLID of a product, or null
function extrusionOf(lines, id) {
  const p = product(lines, id); if (!p || !p.pds || p.pds === '$') return null;
  const pds = lines[lineOf(lines, p.pds.slice(1))].match(/IFCPRODUCTDEFINITIONSHAPE\(\$,\$,\((#\d+)\)\)/); if (!pds) return null;
  const rep = lines[lineOf(lines, pds[1].slice(1))].match(/IFCSHAPEREPRESENTATION\([^,]+,'Body','SweptSolid',\((#\d+)\)\)/); if (!rep) return null;
  const item = rep[1].slice(1), li = lineOf(lines, item);
  if (!/=IFCEXTRUDEDAREASOLID\(/.test(lines[li])) return null;
  const users = lines.filter((l) => refRe(item).test(l)).length; // its own line + the representation
  if (users !== 2) return null;
  // representation / shape not shared either
  if (lines.filter((l) => refRe(pds[1].slice(1)).test(l)).length !== 2 || lines.filter((l) => refRe(p.pds.slice(1)).test(l)).length !== 2) return null;
  return li;
}
function reshapeEl(lines, id) {
  const li = extrusionOf(lines, id);
  lines[li] = lines[li].replace(/,([0-9.eE+-]+)\);$/, (m, d) => ',' + (parseFloat(d) * 1.5).toFixed(6) + ');');
}
// the first single value of the product's own property set: [lineIndex, psetName, propName]
function psetValueOf(lines, id) {
  const rel = lines.find((l) => /=IFCRELDEFINESBYPROPERTIES\(/.test(l) && l.includes(',(#' + id + '),'));
  if (!rel) return null;
  const ps = rel.match(/,\(#\d+\),#(\d+)\);$/); if (!ps) return null;
  const psl = lines[lineOf(lines, ps[1])], m = psl.match(/=IFCPROPERTYSET\('[^']*',\$,'([^']+)',\$,\((#\d+)/);
  if (!m) return null;
  const vi = lineOf(lines, m[2].slice(1)), v = lines[vi].match(/=IFCPROPERTYSINGLEVALUE\('([^']+)',\$,(IFCLABEL\('[^']*'\)|IFCREAL\([^)]*\)|IFCBOOLEAN\(\.[TF]\.\))/);
  return v ? [vi, m[1], v[1]] : null;
}
function changeProp(lines, id) {
  const [vi] = psetValueOf(lines, id);
  lines[vi] = lines[vi]
    .replace(/IFCLABEL\('([^']*)'\)/, (m, s) => `IFCLABEL('${s} rev 2')`)
    .replace(/IFCREAL\(([^)]*)\)/, (m, s) => `IFCREAL(${(parseFloat(s) + 1).toFixed(6)})`)
    .replace(/IFCBOOLEAN\(\.([TF])\.\)/, (m, s) => `IFCBOOLEAN(.${s === 'T' ? 'F' : 'T'}.)`);
}
// removed: only list references (containment, property / group relations)
function removable(lines, id) {
  const re = refRe(id);
  return lines.every((l, i) => {
    if (!re.test(l)) return true;
    if (i === lineOf(lines, id)) return true;
    return new RegExp('[(,]#' + id + '[,)]').test(l) && /IFCRELDEFINESBYPROPERTIES|IFCRELCONTAINEDINSPATIALSTRUCTURE|IFCRELASSIGNSTOGROUP|IFCRELAGGREGATES|IFCRELNESTS/.test(l)
      && !(/IFCRELAGGREGATES|IFCRELNESTS/.test(l) && new RegExp("\\$,#" + id + ',').test(l));
  });
}
function removeEl(lines, id) {
  const re = refRe(id);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!re.test(l)) continue;
    if (i === lineOf(lines, id) || l.includes(',(#' + id + '),') || l.includes(',(#' + id + '));')) { lines.splice(i, 1); continue; }
    lines[i] = l.replace(new RegExp(',#' + id + '(?=[,)])'), '').replace(new RegExp('\\(#' + id + ','), '(');
  }
}
// added: a new duct (own placement + own extrusion) next to a source product
const ADDED_GID = 'ccModelCompareAdded001';
function addEl(lines, srcId) {
  const p = product(lines, srcId), mx = maxId(lines);
  const rep = lines.find((l) => /=IFCSHAPEREPRESENTATION\(/.test(l)), ctx = rep.match(/IFCSHAPEREPRESENTATION\((#\d+),/)[1];
  const n = (k) => mx + k;
  const add = [
    `#${n(1)}=IFCCARTESIANPOINT((0.15,0.4,0.1));`, `#${n(2)}=IFCAXIS2PLACEMENT3D(#${n(1)},$,$);`, `#${n(3)}=IFCLOCALPLACEMENT(${p.pl},#${n(2)});`,
    `#${n(4)}=IFCCARTESIANPOINT((0.,0.));`, `#${n(5)}=IFCAXIS2PLACEMENT2D(#${n(4)},$);`, `#${n(6)}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#${n(5)},0.3,0.2);`,
    `#${n(7)}=IFCCARTESIANPOINT((0.,0.,0.));`, `#${n(8)}=IFCAXIS2PLACEMENT3D(#${n(7)},$,$);`, `#${n(9)}=IFCDIRECTION((0.,0.,1.));`,
    `#${n(10)}=IFCEXTRUDEDAREASOLID(#${n(6)},#${n(8)},#${n(9)},1.25);`, `#${n(11)}=IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(#${n(10)}));`,
    `#${n(12)}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${n(11)}));`,
    `#${n(13)}=IFCDUCTSEGMENT('${ADDED_GID}',$,'Added duct',$,$,#${n(3)},#${n(12)},$,.RIGIDSEGMENT.);`,
  ];
  const ci = lines.findIndex((l) => /=IFCRELCONTAINEDINSPATIALSTRUCTURE\(/.test(l) && new RegExp('[(,]#' + srcId + '[,)]').test(l));
  lines[ci] = lines[ci].replace(new RegExp('([(,])#' + srcId + '(?=[,)])'), '$1#' + srcId + ',#' + n(13));
  lines.splice(endsecAt(lines), 0, ...add);
}

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

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB' });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccLatestState && window._ccModelDiffCore, null, { timeout: 60_000 });
  await page.evaluate(() => {
    window.__mc = {
      async load(list) {
        const fs = await Promise.all(list.map(async ([p, name]) => new File([await (await fetch(p)).arrayBuffer()], name)));
        window.ClashControl.loadFiles(fs);
      },
      mep() { return window._ccLatestState.models.find((m) => /mep/i.test(m.name)); },
    };
    window._ccDispatch({ t: 'UPD_PREFS', u: { autoRerun: 'off' } });
    window._ccDispatch({ t: 'UPD_RULES', u: { excludeSameDiscipline: false, selfClashModels: 'none', hard: true, minGap: 0, maxGap: 50 } });
  });
  const settle = async () => {
    await page.waitForFunction(() => !window._ccModelLoading && !window._ccLatestState.detecting, null, { timeout: 180_000, polling: 200 });
    await page.waitForTimeout(1500);
  };
  // the reloaded version's comparison, refined once its property sets landed
  const waitVersion = (v) => page.waitForFunction((v) => { const m = window.__mc.mep(); return m._version === v && m._versionDiff && m._versionDiff.summary.psetsCompared === true; }, v, { timeout: 120_000, polling: 200 })
    .catch(async (e) => { console.log('state:', await page.evaluate(() => { const m = window.__mc.mep(); return JSON.stringify({ v: m._version, sm: m._versionDiff && m._versionDiff.summary, loading: window._ccModelLoading, ps: m.elements.filter((x) => x.props && x.props.psets && Object.keys(x.props.psets).length).length }); })); throw e; });
  await page.evaluate(() => window.__mc.load([['/__gen/structure', 'building-structure.ifc'], ['/__gen/mep', 'building-mep.ifc']]));
  await page.waitForFunction(() => { const s = window._ccLatestState; return s.models.length === 2 && s.models.every((m) => (m.elements || []).length > 0) && !window._ccModelLoading; }, null, { timeout: 180_000, polling: 300 });
  await settle();
  // property sets of the first version have landed (the comparison needs both sides)
  await page.waitForFunction(() => window.__mc.mep().elements.some((e) => e.props && e.props.psets && Object.keys(e.props.psets).length), null, { timeout: 60_000 });

  // ── a reload of the SAME text: nothing changed ──
  await page.evaluate(() => window.__mc.load([['/__gen/mep', 'building-mep.ifc']]));
  await waitVersion(2);
  await settle();
  const same = await page.evaluate(() => { const sm = window.__mc.mep()._versionDiff.summary; return { sm, n: window.__mc.mep().elements.length }; });
  check(same.sm.modified === 0 && same.sm.added === 0 && same.sm.removed === 0 && same.sm.unchanged > 0, 'reloading identical text: every element unchanged (' + same.sm.unchanged + ')', JSON.stringify(same.sm));

  // ── first run, choose the elements to edit ──
  const first = await page.evaluate(async () => {
    const res = await window.ClashControl.runDetection({ fullRerun: true });
    await new Promise((r) => setTimeout(r, 300));
    const mep = window.__mc.mep(), counts = new Map();
    for (const c of res) for (const [mid, id] of [[c.modelAId, c.elemA], [c.modelBId, c.elemB]]) if (mid === mep.id) counts.set(id, (counts.get(id) || 0) + 1);
    return { rows: res.length, clashing: [...counts.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map((x) => x[0]), all: mep.elements.map((e) => e.expressId).sort((a, b) => a - b) };
  });
  check(first.rows >= 10, `first run: ${first.rows} clashes`);
  const text0 = Buffer.from(gen.files.mep).toString('latin1');
  const L0 = text0.split('\n');
  const used = new Set();
  const pick = (list, pred) => { const id = list.find((x) => !used.has(x) && pred(x)); if (id == null) throw new Error('no candidate'); used.add(id); return id; };
  const ids = {};
  ids.moved = pick(first.clashing, (x) => !!product(L0, x));
  ids.reshaped = pick(first.clashing, (x) => extrusionOf(L0, x) != null);
  ids.prop = pick(first.all, (x) => psetValueOf(L0, x) != null && !!product(L0, x));
  ids.removed = pick(first.all.slice().reverse(), (x) => !!product(L0, x) && removable(L0, x));
  ids.source = pick(first.clashing, (x) => !!product(L0, x));
  const gids = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, product(L0, id).gid]));
  const pv = psetValueOf(L0, ids.prop);
  console.log('edits:', JSON.stringify(ids), 'property', pv[1] + '.' + pv[2]);
  const L1 = L0.slice();
  moveEl(L1, ids.moved, 0.5);
  reshapeEl(L1, ids.reshaped);
  changeProp(L1, ids.prop);
  addEl(L1, ids.source);
  removeEl(L1, ids.removed);
  files.set('/__gen/mep-v3', Buffer.from(L1.join('\n'), 'latin1'));

  // ── reload with the edits ──
  await page.evaluate(() => window.__mc.load([['/__gen/mep-v3', 'building-mep.ifc']]));
  await waitVersion(3);
  await settle();
  const diff = await page.evaluate(() => { const m = window.__mc.mep(); return { id: m.id, d: m._versionDiff }; });
  const sm = diff.d.summary;
  check(sm.added === 1 && sm.removed === 1 && sm.moved === 1 && sm.reshaped === 1 && sm.properties === 1 && sm.both === 0 && sm.geometry === 2 && sm.modified === 3,
    'counts: 1 added / 1 removed / 1 moved / 1 reshaped / 1 property change', JSON.stringify(sm));
  const byKind = Object.fromEntries(diff.d.records.map((r) => [r.kind, r]));
  check(byKind.added && byKind.added.gid === ADDED_GID, 'added: the new duct', JSON.stringify(byKind.added));
  check(byKind.removed && byKind.removed.gid === gids.removed, 'removed: the deleted element', JSON.stringify(byKind.removed && byKind.removed.gid));
  check(byKind.moved && byKind.moved.gid === gids.moved, 'moved: the re-placed element', JSON.stringify(byKind.moved && byKind.moved.gid));
  check(byKind.reshaped && byKind.reshaped.gid === gids.reshaped, 'reshaped: the longer extrusion', JSON.stringify(byKind.reshaped && byKind.reshaped.gid));
  const pr = byKind.properties;
  check(pr && pr.gid === gids.prop && pr.props.length === 1 && pr.props[0].k === pv[1] + '.' + pv[2] && pr.props[0].o !== pr.props[0].n,
    'property change: ' + (pr && pr.props.map((p) => p.k + ': ' + p.o + ' → ' + p.n).join(', ')), JSON.stringify(pr));
  // persisted with the file (a restore shows the same comparison)
  const stored = await page.evaluate(async (id) => {
    const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
    const rec = await new Promise((res) => { const q = db.transaction('ifcFiles', 'readonly').objectStore('ifcFiles').get(id); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
    db.close();
    return rec && rec.meta && rec.meta._versionDiff ? rec.meta._versionDiff.summary : null;
  }, diff.id).catch(() => null);
  check(stored && stored.properties === 1 && stored.psetsCompared === true && stored.added === 1, 'the refined comparison is stored with the model file', JSON.stringify(stored));

  // ── model card ──
  await page.evaluate(() => { window._ccDispatch({ t: 'SET_WORKSPACE', v: 'coordinate' }); window._ccDispatch({ t: 'TAB', v: 'models' }); });
  await page.waitForTimeout(400);
  await page.evaluate((id) => {
    const cards = [...document.querySelectorAll('[data-cc-model-card]')];
    const c = cards.find((x) => x.textContent.includes('building-mep')) || cards.find((x) => x.querySelector('[data-cc-card-toggle]') && /mep/i.test(x.textContent));
    const t = c && c.querySelector('[data-cc-card-toggle]'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
  }, diff.id);
  const cardText = await page.waitForSelector(`[data-cc-model-diff="${diff.id}"] [data-cc-model-diff-summary]`, { timeout: 10_000 }).then((h) => h.textContent()).catch(() => null);
  check(cardText === '1 added · 1 removed · 2 moved or reshaped · 1 property change', 'model card: "' + cardText + '"');

  // ── 3D colours ──
  const colours = await page.evaluate((addedGid) => {
    const btn = [...document.querySelectorAll('[data-cc-model-diff] button')].find((b) => /show changes/i.test(b.textContent));
    btn.click();
    const m = window.__mc.mep(), d = m._versionDiff;
    const el = (id) => m.elements.find((e) => e.expressId === id);
    const added = el(d.added[0]), changed = el(d.moved[0]);
    const cs = getComputedStyle(document.documentElement), col = new window.THREE.Color();
    const tok = (n) => { col.setStyle(cs.getPropertyValue(n).trim()); return col.getHexString(); };
    const out = { added: added.meshes[0].material.color.getHexString(), changed: changed.meshes[0].material.color.getHexString(), success: tok('--color-success'), info: tok('--color-info') };
    [...document.querySelectorAll('[data-cc-model-diff] button')].find((b) => /hide changes/i.test(b.textContent)).click();
    return out;
  }, ADDED_GID);
  // changed = the DESIGN.md --color-info blue (the live --color-info token is the accent green)
  check(colours.added === colours.success && colours.changed === '3b82f6' && colours.changed !== colours.added, '"Show changes": added = --color-success, changed = info blue', JSON.stringify(colours));
  const amber = (hex) => { const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16); return r > 180 && g > 100 && b < 90 && r > g; };
  check(!amber(colours.added) && !amber(colours.changed), 'no amber in the 3D diff colours');

  // ── Navigator filter ──
  await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: 'navigator' }));
  await page.waitForSelector('[data-cc-nav-changed]', { timeout: 10_000 });
  const navRows = async (mode) => {
    await page.click(`[data-cc-nav-changed-mode="${mode}"]`);
    await page.waitForTimeout(500);
    return page.evaluate(() => [...document.querySelectorAll('[data-tree-key^="e_"]')].map((x) => x.getAttribute('data-tree-key')).sort());
  };
  const wantChanged = [diff.d.added[0], ...diff.d.modified].map((e) => 'e_' + diff.id + '_' + e).sort();
  const rowsChanged = await navRows('changed');
  check(JSON.stringify(rowsChanged) === JSON.stringify(wantChanged), `Navigator "Added and changed": ${rowsChanged.length} rows`, JSON.stringify({ rowsChanged, wantChanged }));
  const rowsAdded = await navRows('added');
  check(JSON.stringify(rowsAdded) === JSON.stringify(['e_' + diff.id + '_' + diff.d.added[0]]), 'Navigator "Added": the new element only', JSON.stringify(rowsAdded));
  const rowText = await page.evaluate(() => (document.querySelector('[data-tree-key^="e_"]') || {}).textContent || '');
  check(/Added/.test(rowText), 'the row says what changed: "' + rowText.trim() + '"');
  await navRows('all');

  // ── suggested view after a re-run ──
  const sv = await page.evaluate(async () => {
    await window.ClashControl.runDetection({});
    await new Promise((r) => setTimeout(r, 500));
    const s = window._ccLatestState, m = window.__mc.mep(), core = window._ccModelDiffCore;
    const env = {}; env[m.id] = core.filterIds(m._versionDiff, 'changed');
    const on = s.clashes.filter((c) => core.clashOnChanged(c, env)).map((c) => c.id).sort();
    window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'list' } }); window._ccDispatch({ t: 'TAB', v: 'clashes' });
    return { on, total: s.clashes.length };
  });
  const chip = await page.waitForSelector('[data-cc-suggested="changed-elements"]', { timeout: 10_000 }).catch(() => null);
  const chipCount = chip ? await chip.evaluate((b) => +((b.textContent.match(/(\d+)\s*$/) || [])[1])) : null;
  check(!!chip && sv.on.length > 0 && chipCount > 0 && chipCount <= sv.on.length, `suggested view "Clashes on changed elements": ${chipCount} (of ${sv.on.length} on changed elements, ${sv.total} clashes)`);
  if (chip) {
    await chip.click();
    await page.waitForTimeout(400);
    const facets = await page.evaluate(() => (window._ccLatestState.triage || {}).facets || null);
    check(facets && JSON.stringify(facets.tag) === JSON.stringify(['changed-element']), 'the view filters by the changed-element tag', JSON.stringify(facets));
  }

  // ── CSV + report ──
  const out = await page.evaluate((id) => ({ csv: window._ccModelDiffCsv(id), html: window._ccModelDiffReportHtml(id) }), diff.id);
  const rows = out.csv.trim().split('\r\n').map((r) => r.split(','));
  check(rows[0].join(',') === 'GlobalId,IFC Type,Name,Change,Property,Old value,New value', 'CSV header', rows[0].join(','));
  const rowOf = (gid) => rows.filter((r) => r[0] === gid);
  check(rows.length === 6, 'CSV: one row per changed element / property (5)', String(rows.length - 1));
  check(rowOf(ADDED_GID)[0] && rowOf(ADDED_GID)[0][3] === 'Added', 'CSV: added row');
  check(rowOf(gids.removed)[0] && rowOf(gids.removed)[0][3] === 'Removed', 'CSV: removed row');
  check(rowOf(gids.moved)[0] && rowOf(gids.moved)[0][3] === 'Moved', 'CSV: moved row');
  check(rowOf(gids.reshaped)[0] && rowOf(gids.reshaped)[0][3] === 'Reshaped', 'CSV: reshaped row');
  const prow = rowOf(gids.prop)[0];
  check(prow && prow[3] === 'Properties changed' && prow[4] === pv[1] + '.' + pv[2] && prow[5] === pr.props[0].o && prow[6] === pr.props[0].n, 'CSV: property row with old → new', JSON.stringify(prow));
  const reportRows = (out.html.match(/<tr data-gid=/g) || []).length;
  check(reportRows === 5 && out.html.includes('1 added · 1 removed · 2 moved or reshaped · 1 property change') && !/<svg/i.test(out.html), `printable report: ${reportRows} element rows, the summary line, no drawn markers`);

  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail('harness error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nmodel-compare: all checks passed');
