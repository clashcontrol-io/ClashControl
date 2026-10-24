'use strict';
// Scene and review actions cost what they touch (docs/INTERNALS.md §21.54).
// The functions are sliced out of index.html and run against brute-force
// references with real three.js objects:
//   * the per-model mesh index returns exactly what `S.mg.traverse` + an
//     expressId test returns, in the same order, while children are added /
//     removed (ghost split-outs in place, anything else via a rebuild);
//   * a keyed _ccBatchApplyVisibility leaves every slot exactly as the full
//     apply does, touching only the named expressIds' slots;
//   * search narrowing (_ccSearchNarrows) is sound for every query pair it
//     accepts: an item passing the new query passes the old one;
//   * the clash-marker equality reads exactly id / point / cluster key /
//     effective severity;
// plus wiring locks for the effects / memos that must not key on s.models.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const THREE = require(join(__dirname, '..', 'node_modules', 'three', 'build', 'three.cjs'));

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
function between(a, b) {
  const i = html.indexOf(a);
  assert.ok(i !== -1, 'missing: ' + a);
  const j = html.indexOf(b, i + a.length);
  assert.ok(j !== -1, 'missing: ' + b);
  return html.slice(i, j);
}
function sliceFrom(needle, span) {
  const i = html.indexOf(needle);
  assert.ok(i !== -1, 'expected to find: ' + needle);
  return html.slice(i, i + span);
}
// deterministic PRNG
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── mesh index + batch visibility ────────────────────────────────────────
const sceneSrc = between('  function _ccForEachBatchInstance(root, fn) {', '  // Module-level material cache shared');
const scene = new Function('THREE', 'window',
  sceneSrc + '; return { _ccBatchHidden: _ccBatchHidden, apply: _ccBatchApplyVisibility, byEid: _ccMeshesByEid, build: _ccMeshIndexBuild, drop: _ccMeshIndexDrop, batches: _ccBatchesUnder, slots: _ccBatchSlots, typeMap: _ccEidTypeMap };');

function fakeBatch(ids, log) {
  const b = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  b.userData._isCCBatch = true;
  b.userData.batchExprIds = ids;
  const vis = ids.map(() => true);
  b.setVisibleAt = (i, v) => { vis[i] = v; if (log) log.n++; };
  b.getVisibleAt = (i) => vis[i];
  return b;
}
function plain(eid) {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  if (eid != null) m.userData.expressId = eid;
  return m;
}
function bruteByEid(mg, eid) {
  const out = [];
  mg.traverse((o) => { if (o.isMesh && o.userData.expressId != null && String(o.userData.expressId) === String(eid)) out.push(o); });
  return out;
}

test('per-model mesh index = S.mg traversal order under random scene edits (split-outs in place, the rest rebuilds)', () => {
  const r = rng(11);
  const api = scene(THREE, {});
  const mg = new THREE.Group(); mg.userData._ccModelRoot = true;
  const groups = [];
  for (let g = 0; g < 3; g++) {
    const grp = new THREE.Group(); grp.userData.modelId = 'm' + g;
    for (let i = 0; i < 30; i++) grp.add(plain(1 + Math.floor(r() * 25)));
    const sub = new THREE.Group(); for (let i = 0; i < 5; i++) sub.add(plain(1 + Math.floor(r() * 25))); grp.add(sub);
    grp.add(fakeBatch([3, 4, 5, null, 4]));
    mg.add(grp); groups.push(grp); api.build(grp);
  }
  const check = (tag) => {
    for (let eid = 0; eid <= 26; eid++) {
      const got = api.byEid(mg, eid), want = bruteByEid(mg, eid);
      assert.equal(got.length, want.length, tag + ' eid ' + eid);
      want.forEach((m, k) => assert.equal(got[k], m, tag + ' eid ' + eid + ' #' + k));
    }
    const wantB = []; mg.traverse((o) => { if (o.userData && o.userData._isCCBatch) wantB.push(o); });
    assert.deepEqual(api.batches(mg), wantB, tag + ' batches');
  };
  check('initial');
  const splitOuts = [];
  for (let step = 0; step < 400; step++) {
    const g = groups[Math.floor(r() * 3)], op = r();
    if (op < 0.35) { const so = plain(1 + Math.floor(r() * 25)); so.userData._splitOut = true; g.add(so); splitOuts.push(so); }
    else if (op < 0.6 && splitOuts.length) { const so = splitOuts.splice(Math.floor(r() * splitOuts.length), 1)[0]; if (so.parent) so.parent.remove(so); }
    else if (op < 0.7) { g.children.find((x) => x.isGroup).add(plain(1 + Math.floor(r() * 25))); } // nested add → rebuild
    else if (op < 0.8) { const c = g.children.find((x) => x.isMesh && !x.userData._isCCBatch); if (c) g.remove(c); }
    else if (op < 0.85) { g.add(plain(1 + Math.floor(r() * 25))); }                               // non-split root add → rebuild
    else if (op < 0.9) { const sub = g.children.find((x) => x.isGroup); if (sub && sub.children.length) sub.remove(sub.children[0]); }
    check('step ' + step);
  }
  // lookups after the scene settles cost no walk of the model
  let walks = 0;
  const orig = THREE.Object3D.prototype.traverse;
  THREE.Object3D.prototype.traverse = function () { walks++; return orig.apply(this, arguments); };
  try { for (let eid = 0; eid < 26; eid++) api.byEid(mg, eid); } finally { THREE.Object3D.prototype.traverse = orig; }
  assert.equal(walks, 0, 'clean index lookups never traverse');
  // a dropped index detaches its listeners
  api.drop(groups[0]);
  groups[0].add(plain(7));
  assert.ok(api.byEid(groups[0], 7).length >= 1, 'a dropped root is rebuilt on demand');
});

test('keyed _ccBatchApplyVisibility = full apply on the named slots, nothing else touched', () => {
  const r = rng(5);
  const api = scene(THREE, {});
  const mg = new THREE.Group(); mg.userData._ccModelRoot = true;
  const log = { n: 0 };
  const grp = new THREE.Group(); grp.userData.modelId = 'mA'; mg.add(grp);
  const ids = []; for (let i = 0; i < 500; i++) ids.push(r() < 0.05 ? null : 1 + Math.floor(r() * 120));
  const b = fakeBatch(ids, log); grp.add(b);
  const grp2 = new THREE.Group(); grp2.userData.modelId = 'mB'; mg.add(grp2);
  const ids2 = ids.map((x) => (x == null ? null : x + 3));
  const b2 = fakeBatch(ids2, log); grp2.add(b2);
  api.build(grp); api.build(grp2);
  const H = api._ccBatchHidden;
  for (let round = 0; round < 60; round++) {
    // random hide sources, applied fully as the reference
    H.class = {}; H.storey = {}; H.temp = {};
    for (let k = 0; k < 8; k++) { const e = 1 + Math.floor(r() * 125); H.class[(r() < 0.5 ? 'mA' : 'mB') + '_' + e] = true; }
    for (let k = 0; k < 8; k++) { const e = 1 + Math.floor(r() * 125); H.storey[(r() < 0.5 ? 'mA' : 'mB') + '_' + e] = true; }
    api.apply(mg);
    // change temp keys for a few ids; keyed apply over exactly those ids
    const eids = []; for (let k = 0; k < 4; k++) { const e = 1 + Math.floor(r() * 125); eids.push(r() < 0.5 ? e : String(e)); if (r() < 0.5) H.temp[e] = true; else H.temp[(r() < 0.5 ? 'mA' : 'mB') + '_' + e] = true; }
    const before = [ids.map((_, i) => b.getVisibleAt(i)), ids2.map((_, i) => b2.getVisibleAt(i))];
    log.n = 0;
    api.apply(mg, eids);
    const keyedWrites = log.n;
    const keyed = [ids.map((_, i) => b.getVisibleAt(i)), ids2.map((_, i) => b2.getVisibleAt(i))];
    api.apply(mg);
    const full = [ids.map((_, i) => b.getVisibleAt(i)), ids2.map((_, i) => b2.getVisibleAt(i))];
    assert.deepEqual(keyed, full, 'round ' + round + ': keyed apply = full apply');
    // only slots of the named ids were written
    const named = new Set(eids.map(String));
    const expectWrites = ids.filter((x) => x != null && named.has(String(x))).length + ids2.filter((x) => x != null && named.has(String(x))).length;
    assert.equal(keyedWrites, expectWrites, 'round ' + round + ': writes = named slots');
    before.forEach((arr, bi) => arr.forEach((v, i) => { const id = (bi ? ids2 : ids)[i]; if (id == null || !named.has(String(id))) assert.equal(keyed[bi][i], v); }));
  }
  // a ghost split-out slot stays hidden under every apply
  b.userData._ccGhostSplit = new Set([0]);
  H.class = {}; H.storey = {}; H.temp = {};
  api.apply(mg);
  assert.equal(b.getVisibleAt(0), ids[0] == null, 'split-out slot stays hidden (null slots are never written)');
});

test('render-style type lookup is per model (expressIds repeat across models)', () => {
  const api = scene(THREE, {});
  const mA = { elements: [{ expressId: 7, props: { ifcType: 'IfcWall' } }] };
  const mB = { elements: [{ expressId: 7, props: { ifcType: 'IfcWindow' } }] };
  assert.equal(api.typeMap(mA).get('7'), 'IfcWall');
  assert.equal(api.typeMap(mB).get('7'), 'IfcWindow');
  assert.equal(api.typeMap(mA), api.typeMap(mA), 'cached per elements array');
  const style = between("      // expressId → ifcType of the mesh's OWN model", '      // ── Materials per render style ──');
  assert.match(style, /_ccEidTypeMap\(m\)\.get\(String\(obj\.userData\.expressId\)\)/);
  assert.doesNotMatch(html, /_eidToType\[/, 'no global expressId → type map left');
});

// ── search narrowing ─────────────────────────────────────────────────────
const searchSrc = between('  var _CC_FILTER_FILLER = {', '  function deriveFloors(clashes) {');
const search = new Function(searchSrc + '; return { narrows: _ccSearchNarrows, matches: _ccFilterTextMatches };')();

test('search narrowing is sound: every accepted pair only removes items (fuzz)', () => {
  const r = rng(3);
  const alpha = ['wa', 'll', 'w', 's', 'beam', 'floor', 'floo', 'level', 'lev', '1', '12', '123', '#', '#1', ' ', 'a', 'on', 'pipes', 'pipe', 'x'];
  const word = () => { let w = ''; const n = 1 + Math.floor(r() * 3); for (let i = 0; i < n; i++) w += alpha[Math.floor(r() * alpha.length)]; return w; };
  const hays = []; for (let i = 0; i < 300; i++) { let h = ''; for (let k = 0; k < 4; k++) h += word() + ' '; hays.push({ hay: h.toLowerCase(), n: Math.floor(r() * 200) }); }
  let accepted = 0;
  for (let t = 0; t < 4000; t++) {
    const qa = r() < 0.15 ? '' : word() + (r() < 0.4 ? ' ' + word() : '');
    const qb = r() < 0.5 ? qa + alpha[Math.floor(r() * alpha.length)] : word();
    const fa = { search: qa, status: 'all' }, fb = { search: qb, status: 'all' };
    if (!search.narrows(fa, fb)) continue;
    accepted++;
    for (const h of hays) if (search.matches(qb, h.hay, h.n)) assert.ok(search.matches(qa, h.hay, h.n), JSON.stringify({ qa, qb, h }));
  }
  assert.ok(accepted > 500, 'the fuzz exercised the narrowing path (' + accepted + ')');
  // typing forward narrows; the tricky extensions do not
  assert.ok(search.narrows({ search: 'wa' }, { search: 'wal' }));
  assert.ok(search.narrows({ search: 'wall' }, { search: 'walls' }));
  assert.ok(search.narrows({ search: '' }, { search: 'beam' }));
  assert.ok(!search.narrows({ search: 'floo' }, { search: 'floor' }), "'floor' is normalised to 'level'");
  assert.ok(!search.narrows({ search: '12' }, { search: '123' }), 'a number can match the item number alone');
  assert.ok(!search.narrows({ search: 'wall' }, { search: 'wal' }), 'deleting widens');
  assert.ok(!search.narrows({ search: 'wa', status: 'all' }, { search: 'wal', status: 'open' }), 'another filter changed');
});

// ── clash markers ────────────────────────────────────────────────────────
test('clash markers are rebuilt only when id / point / cluster key / severity change', () => {
  const src = between('  function _ccMarkerClashesSame(a, b) {', '  function _clearElCaches(model) {');
  const win = { _ccClusterKeyFor: (c) => (c.modelAId + ':' + c.elemA) + '|' + (c.modelBId + ':' + c.elemB) };
  const same = new Function('window', '_ccDeterministicSeverity', src + '; return _ccMarkerClashesSame;')(win, (c) => (c.type === 'hard' ? 'major' : 'minor'));
  const c = { id: 'c1', point: [1, 2, 3], modelAId: 'a', elemA: 1, modelBId: 'b', elemB: 2, type: 'hard', status: 'open' };
  const list = [c, { ...c, id: 'c2' }];
  assert.ok(same(list, [{ ...c, status: 'resolved', assignee: 'x' }, list[1]]), 'a status / assignee edit keeps the markers');
  assert.ok(same(list, [{ ...c, point: [1, 2, 3] }, list[1]]), 'an equal point in a new array keeps them');
  assert.ok(!same(list, [{ ...c, point: [1, 2, 4] }, list[1]]), 'a moved point rebuilds');
  assert.ok(!same(list, [{ ...c, aiSeverity: 'critical' }, list[1]]), 'a severity (colour) change rebuilds');
  assert.ok(!same(list, [{ ...c, type: 'soft' }, list[1]]), 'a deterministic-severity change rebuilds');
  assert.ok(!same(list, [{ ...c, elemB: 9 }, list[1]]), 'a cluster change rebuilds');
  assert.ok(!same(list, [list[1], list[0]]), 'order matters');
  assert.ok(!same(list, list.slice(0, 1)));
});

// ── wiring ───────────────────────────────────────────────────────────────
test('selection / fly-to / temp hide use the mesh index, not a walk of every model', () => {
  const find = sliceFrom('      function _findMeshByRef(expressId, modelId) {', 900);
  assert.match(find, /_ccMeshesByEid\(S\.mg, expressId\)/);
  assert.doesNotMatch(find, /S\.mg\.traverse/);
  assert.match(find, /_ccProxyMeshFor\(expressId, modelId\)/, 'batched elements still resolve to their proxy');
  const fly = between('      _flyToElements = function(targets, fallbackPt) {', '      window._highlightById = _highlightById;');
  assert.doesNotMatch(fly, /S\.mg\.traverse/);
  assert.match(fly, /_ccMeshesByEid\(S\.mg, expressId\)/);
  const hide = between('      function _ccRestoreTempHide(snap) {', '      window._ccTempHide = function(targets) {');
  assert.doesNotMatch(hide, /S\.mg\.traverse/);
  assert.doesNotMatch(hide, /_ccBatchApplyVisibility\(S\.mg\);/, 'temp hide applies only the affected slots');
  const unhide = between('      function _ccTempUnhideCore() {', '      window._ccTempUnhide = function() {');
  assert.match(unhide, /_ccBatchApplyVisibility\(S\.mg, _ccTempKeyEids\(\[prevTemp\]\)\)/);
  const effect = between('            S.mg.add(grp); S.map[model.id] = grp;', '          // The committed model is in the scene now');
  assert.match(effect, /_ccMeshIndexBuild\(grp\)/);
});

test('ghostOthers applies the delta while ghosted; unghostAll touches the split slots only', () => {
  const ghost = between('      function ghostOthers(targets) {', '      function unghostAll(){');
  assert.match(ghost, /if \(_ghostState && _ghostedMeshes\.length && _ghostSceneSame\(_ghostState\.scene\)\) \{\s*_ghostDelta\(_ghostState\.keep, keep\);/);
  const unghost = between('      function unghostAll(){', '      // Occluder-reveal (Wave 2.2)');
  assert.doesNotMatch(unghost, /_ccBatchApplyVisibility\(/, 'no per-batch full visibility pass');
  const join = between('      function _ghostJoinBatch(g) {', '      function _ghostJoinInstanced(g) {');
  assert.match(join, /_ccBatchApplySlot\(g\.bMesh, bi, ids\[bi\], mid\)/);
  const split = between('      function _ghostSplitBatch(obj, k, meshModelId) {', '      function _ghostSplitInstanced(obj, k, meshModelId) {');
  assert.doesNotMatch(split, /for\(var bi=0; bi<bIds\.length/, 'kept slots come from the slot map, not a loop over every instance');
});

test('scene effects key on what they read, not on s.models identity', () => {
  assert.match(html, /\}, \[s\.prefs\.renderStyle, s\.prefs\.theme, visKey, s\.prefs\.lightSettings, !!s\.floorPlan\]\);/, 'lights / ground');
  assert.match(html, /\}, \[_rsStyle, _rsPlan, _rsThemeDep, _rsAmbDep, meshKey\]\);/, 'material swap');
  assert.match(html, /var _rsThemeDep = \(_rsStyle === 'standard' \|\| _rsPlan\) \? \(s\.prefs\.theme \|\| 'light'\) : null;/);
  assert.match(html, /\}, \[s\.sectionAxis, s\.sectionPos, s\.sectionCustom, s\.sectionFlip, s\.sectionHatch, visKey, s\.prefs&&s\.prefs\.renderStyle\]\);/);
  assert.match(html, /\}, \[s\.sectionBox, meshKey, s\.prefs&&s\.prefs\.renderStyle\]\);/);
  assert.match(html, /if \(!_planeOn && !S\._sectionPlaneWasOn\) \{ window\._ccCurrentSection = null; return; \}/);
  assert.doesNotMatch(html, /\}, \[s\.prefs\.renderStyle, s\.prefs\.theme, s\.models, s\.prefs\.lightSettings, !!s\.floorPlan\]\);/);
  // markers: one effect per kind
  assert.match(html, /\}, \[s\.clashes, s\.prefs\.showMarkers\]\);/);
  assert.match(html, /\}, \[s\.comments, s\.activeCommentId\]\);/);
  // plan frame: a small LRU, keyed by elements-array identity
  assert.match(html, /var _PLAN_FRAME_CACHE_MAX = 8;/);
});

test('triage / review / list memos key on the model fields they read', () => {
  const tri = between('  function _ccTriageModelsSig(s) {', '  // Legacy per-bucket "show" switches');
  assert.match(tri, /\[m\.id, m\.visible !== false, m\.name \|\| m\.id, m\.storeyData,/);
  assert.match(tri, /if \(sameModels && L\.clashes === s\.clashes && L\.rules === s\.rules\)/);
  const rev = between('  function _ccReviewModel(s) {', '  // ── Truthful empty/filtered states');
  assert.match(rev, /L\.tm === tm/);
  assert.doesNotMatch(rev, /L\.models === s\.models/);
  assert.match(html, /var visibleModelIds = useMemo\(function\(\)\{[\s\S]{0,300}\}, \[_visIdsKey\]\);/);
  const inc = between('  function _ccTriageIncremental(L, s) {', '  var _ccTriageRowCache = new WeakMap();');
  assert.match(inc, /var live = !!\(window\._ccLatestState && window\._ccLatestState\.clashes === next\);/);
});
