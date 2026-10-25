'use strict';
// Renaming or hiding a model costs what it changes (docs/INTERNALS.md §21.54,
// "Rename and hide / show a model").
//
//   * the incremental root-cause grouping (_ccElementGroupsDelta) gives
//     exactly groupAndSort(items, ['element']) + _ccStabilizeGroups (same
//     groups, order, members AND the same group objects) over randomized
//     sequences of models hidden / shown, narrowed subsets and edited clashes;
//   * per-group row segments + offsets equal the row-by-row reference after
//     random height measurements;
//   * the model-pair facet is keyed by model ids: a rename re-files nothing,
//     the label follows the current names, saved views keep matching, and
//     old name-valued saved views migrate to ids (reducer wrapper).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tcore = require('../clash-triage-core.js');
const ccore = require('../clash-classification-core.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function slice(from, to) {
  const a = src.indexOf(from);
  assert.ok(a !== -1, 'not found: ' + from);
  const b = src.indexOf(to, a);
  assert.ok(b !== -1, 'not found: ' + to);
  return src.slice(a, src.indexOf('\n', b) + 1);
}
const code = slice('function _ccElemKeyFor(modelId, expressId, globalId) {', 'window._ccComputeVisibleRowWindow = _ccComputeVisibleRowWindow;')
  + slice('  function _ccStabilizeGroups(prev, next) {', '  window._ccStabilizeGroups = _ccStabilizeGroups;')
  + slice('  function _ccPatchElementGroups(prevItems, prevGroups, items) {', '  // The models array as far as the clash list reads it');
const lib = new Function('window', '_ccDeterministicSeverity', code + `
  return { groupAndSort, stabilize: _ccStabilizeGroups, patch: _ccPatchElementGroups, state: _ccElementGroupState,
    delta: _ccElementGroupsDelta, adopt: _ccElementGroupsAdopt, buildRows: _ccBuildConflictRows,
    offsets: _ccComputeRowOffsets, heightChanged: _ccRowHeightChanged, GROUP_PAGE_SIZE };`)({}, (c) => ccore.deterministicSeverity(c));

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SEV = ['critical', 'major', 'minor', 'info', undefined];
const TYPES = ['IfcWall', 'IfcBeam', 'IfcDuctSegment', 'IfcPipeSegment', 'IfcSlab', 'IfcColumn'];
// A federation: 3 models, shared elements (degrees > 1, root causes that
// flip when a partner disappears), equal severities and depths (the id
// decides), some elements known by GlobalId only.
function federation(r, n) {
  const models = ['mA', 'mB', 'mC'];
  const els = models.map(() => 6 + Math.floor(r() * 30));
  const out = [];
  for (let i = 0; i < n; i++) {
    // mC (the services model of a small trade) is in few clashes, so hiding
    // it changes a small part of the list (more than half: full regroup)
    const pick = () => { const x = r(); return x < 0.46 ? 0 : x < 0.92 ? 1 : 2; };
    const a = pick(), b = pick();
    const ea = Math.floor(r() * els[a]), eb = Math.floor(r() * els[b]);
    out.push({ id: 'c' + i, type: r() < 0.8 ? 'hard' : 'soft', modelAId: models[a], modelBId: models[b], elemA: ea, elemB: eb + (a === b ? 1000 : 0),
      globalIdA: r() < 0.2 ? 'G' + a + '-' + ea : '', elemAType: TYPES[Math.floor(r() * TYPES.length)], elemBType: TYPES[Math.floor(r() * TYPES.length)],
      aiSeverity: SEV[Math.floor(r() * SEV.length)], distance: -Math.floor(r() * 4) * 10, extent: ['through', 'partial', 'graze'][Math.floor(r() * 3)] });
  }
  return out;
}
const sig = (groups) => (groups || []).map((g) => g.label + '=' + g.items.map((c) => c.id).join(',')).join('|');

test('incremental root-cause grouping == full regroup (+ stabilize) over random hide / show / narrow / edit sequences', () => {
  let deltas = 0, fulls = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    let all = federation(r, 40 + Math.floor(r() * 260));
    const vis = { mA: true, mB: true, mC: true };
    let items = all.slice(), st = null, groups = null;
    const degOut = {};
    groups = lib.stabilize(null, lib.groupAndSort(items, ['element'], [], { degOut }));
    st = lib.state(items, groups, degOut.deg);
    for (let step = 0; step < 30; step++) {
      const op = r();
      if (op < 0.45) { const m = ['mA', 'mB', 'mC'][Math.floor(r() * 3)]; vis[m] = !vis[m]; }
      else if (op < 0.7) {
        // edited copies (new objects): status only, or severity / depth too
        const k = 1 + Math.floor(r() * 5);
        all = all.slice();
        for (let j = 0; j < k; j++) { const i = Math.floor(r() * all.length); all[i] = Object.assign({}, all[i], r() < 0.5 ? { status: 'in_progress' } : { aiSeverity: SEV[Math.floor(r() * SEV.length)], distance: -Math.floor(r() * 4) * 10 }); }
      }
      const narrow = r() < 0.2 ? 1 + Math.floor(r() * 4) : 0;
      const next = all.filter((c, i) => vis[c.modelAId] && vis[c.modelBId] && (!narrow || i % (narrow + 1)));
      const ref = lib.stabilize(groups, lib.groupAndSort(next, ['element'], [], {}));
      let got = lib.patch(items, groups, next), nst = null;
      if (got) nst = lib.adopt(st, next, got);
      else { nst = lib.delta(st, next); if (nst) { got = nst.groups; deltas++; } }
      if (!got) {
        fulls++;
        const d2 = {};
        got = lib.stabilize(groups, lib.groupAndSort(next, ['element'], [], { degOut: d2 }));
        nst = lib.state(next, got, d2.deg);
      }
      assert.equal(sig(got), sig(ref), `seed ${seed} step ${step}: groups / order / members`);
      assert.equal(got.length, ref.length);
      got.forEach((g, i) => assert.ok(g === ref[i] || (g.label === ref[i].label && !groups.includes(g) && !groups.includes(ref[i])), `seed ${seed} step ${step}: group ${g.label} object identity as the stabilized full regroup`));
      assert.equal(got === groups, ref === groups, 'unchanged grouping returns the previous array');
      items = next; groups = got; st = nst;
    }
  }
  assert.ok(deltas > 200, 'the incremental path ran (' + deltas + ' deltas, ' + fulls + ' full regroups)');
});

test('a hidden model leaves the other groups as the same objects; only groups touching it are rebuilt', () => {
  const r = rng(7);
  const all = federation(r, 400);
  const degOut = {};
  const groups = lib.stabilize(null, lib.groupAndSort(all, ['element'], [], { degOut }));
  const st = lib.state(all, groups, degOut.deg);
  const next = all.filter((c) => c.modelAId !== 'mC' && c.modelBId !== 'mC');
  const nst = lib.delta(st, next);
  assert.ok(nst, 'incremental');
  const touched = new Set(all.filter((c) => !next.includes(c)).flatMap((c) => ['m' + c.modelAId + ':' + c.elemA, 'm' + c.modelBId + ':' + c.elemB]));
  for (const g of nst.groups) {
    if (groups.includes(g)) continue;
    // a rebuilt group holds an element whose degree changed, or a clash whose root moved
    assert.ok(g.items.some((c) => touched.has('m' + c.modelAId + ':' + c.elemA) || touched.has('m' + c.modelBId + ':' + c.elemB)) || !groups.some((p) => p.label === g.label), 'rebuilt only when touched: ' + g.label);
  }
  assert.ok(nst.groups.filter((g) => groups.includes(g)).length > 0, 'untouched groups kept');
});

test('row segments + offsets equal the row-by-row reference under random collapse / limits / height measurements', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const r = rng(100 + seed);
    let all = federation(r, 300);
    const cache = { segs: new WeakMap(), keySeg: new Map(), last: null };
    const heights = {};
    let groups = null, items = all;
    const vis = { mA: true, mB: true, mC: true };
    for (let step = 0; step < 25; step++) {
      const op = r();
      if (op < 0.4) { const m = ['mA', 'mB', 'mC'][Math.floor(r() * 3)]; vis[m] = !vis[m]; }
      items = all.filter((c) => vis[c.modelAId] && vis[c.modelBId]);
      groups = lib.stabilize(groups, lib.groupAndSort(items, ['element'], [], {}));
      const collapsed = {}, limits = {};
      groups.forEach((g, i) => { if (r() < 0.1) collapsed[g.label] = true; if (r() < 0.1) limits[g.label] = 1 + Math.floor(r() * 3); });
      if (r() < 0.5) Object.keys(collapsed).forEach((k) => delete collapsed[k]);
      const rows = lib.buildRows(items, groups, collapsed, limits, () => false, cache);
      const refRows = lib.buildRows(items, groups, collapsed, limits, () => false);
      assert.deepEqual(rows.map((x) => [x.type, x.key, x.item && x.item.id, x.group && x.group.label, x.limit]), refRows.map((x) => [x.type, x.key, x.item && x.item.id, x.group && x.group.label, x.limit]));
      // measure a few rows (whole pixels, like offsetHeight)
      for (let k = 0; k < 6; k++) { const row = rows[Math.floor(r() * rows.length)]; if (!row) continue; heights[row.key] = 20 + Math.floor(r() * 90); lib.heightChanged(cache, row.key); }
      const got = lib.offsets(rows, heights, cache), ref = lib.offsets(rows, heights);
      assert.deepEqual(got.offsets, ref.offsets, `seed ${seed} step ${step}`);
      assert.equal(got.totalHeight, ref.totalHeight);
      // nothing changed: the same rows array
      assert.equal(lib.buildRows(items, groups, collapsed, limits, () => false, cache), rows);
    }
  }
});

test('model pair facet: keyed by model ids, labelled by the current names; a rename re-files nothing', () => {
  const c = { id: 'x', modelAId: 'S', modelBId: 'A', type: 'hard' };
  const v = tcore.facetValues(c, {});
  assert.equal(v.modelPair, tcore.modelPairKey(c));
  assert.ok(tcore.isModelPairKey(v.modelPair));
  assert.equal(tcore.modelPairKey({ modelAId: 'A', modelBId: 'S' }), v.modelPair, 'order-independent');
  let names = { A: 'Arch', S: 'Struct' };
  assert.equal(tcore.modelPairLabel(v.modelPair, (id) => names[id]), 'Arch ↔ Struct');
  names = { A: 'Zeta', S: 'Struct' };
  assert.equal(tcore.modelPairLabel(v.modelPair, (id) => names[id]), 'Struct ↔ Zeta', 'label follows a rename, names sorted');
  assert.equal(tcore.modelPairLabel(tcore.modelPairKey({ modelAId: 'A' }), (id) => names[id]), 'Zeta', 'a pair within one model');
  // the label equals the old name-keyed value for every pair
  const old = (cc, mn) => { const p = (a, b) => { a = String(a || '?'); b = String(b || '?'); return a === b ? a : (a < b ? a + ' ↔ ' + b : b + ' ↔ ' + a); }; return p(mn(cc.modelAId), mn(cc.modelBId || cc.modelAId)); };
  const nm = { A: 'Arch', S: 'Struct', M: 'MEP' }, mn = (id) => nm[id] || id || '?';
  for (const a of ['A', 'S', 'M', undefined]) for (const b of ['A', 'S', 'M', undefined]) {
    const cc = { modelAId: a, modelBId: b };
    assert.equal(tcore.modelPairLabel(tcore.modelPairKey(cc), (id) => nm[id]), old(cc, mn), JSON.stringify(cc));
  }
  // ties in count sort by the label, not the id key
  const kAS = tcore.modelPairKey({ modelAId: 'A', modelBId: 'S' }), kMS = tcore.modelPairKey({ modelAId: 'M', modelBId: 'S' });
  const lab = (k) => tcore.modelPairLabel(k, (id) => ({ A: 'Zz', S: 'Struct', M: 'Aa' })[id]);
  assert.deepEqual(tcore.orderedValues('modelPair', { [kAS]: 2, [kMS]: 2 }, [], lab), [kMS, kAS]);
});

test('saved views / filters by model pair keep matching after a rename; old name-valued values migrate to ids', () => {
  const models = [{ id: 'A', name: 'Arch' }, { id: 'S', name: 'Struct' }, { id: 'M', name: 'MEP' }];
  const clashes = [];
  for (let i = 0; i < 60; i++) clashes.push({ id: 'c' + i, type: 'hard', modelAId: ['A', 'S', 'M'][i % 3], modelBId: ['M', 'M', 'S'][i % 3], aiSeverity: 'major', status: 'open' });
  const idx = tcore.indexItems(clashes, {});
  const nameOf = (id) => (models.find((m) => m.id === id) || {}).name;
  // the old facet value (the label) selected the clashes whose names gave it
  const oldSel = (label) => clashes.filter((c) => tcore.modelPairLabel(tcore.modelPairKey(c), nameOf) === label).map((c) => c.id);
  const mig = tcore.migrateModelPairValues(['Arch ↔ MEP'], models);
  assert.deepEqual(mig, [tcore.modelPairKey({ modelAId: 'A', modelBId: 'M' })]);
  assert.deepEqual(tcore.applyFacets(idx, { modelPair: mig }).map((c) => c.id), oldSel('Arch ↔ MEP'), 'migrated filter selects what the old one did');
  // renamed: the id-keyed filter still selects the same clashes
  models[0].name = 'Architecture (rev B)';
  assert.deepEqual(tcore.applyFacets(idx, { modelPair: mig }).map((c) => c.id), oldSel('Architecture (rev B) ↔ MEP'));
  // already keys: same array back; unresolvable legacy value kept as is
  assert.equal(tcore.migrateModelPairValues(mig, models), mig);
  const keep = ['Nope ↔ Gone'];
  assert.equal(tcore.migrateModelPairValues(keep, models), keep);
  assert.equal(tcore.migrateModelPairValues(keep, []), keep, 'no models yet: wait');
  // two models with the same name: the old label matched both pairs — so do the ids
  const twin = [{ id: 'A', name: 'X' }, { id: 'B', name: 'X' }, { id: 'M', name: 'MEP' }];
  assert.deepEqual(tcore.migrateModelPairValues(['MEP ↔ X'], twin), [tcore.modelPairKey({ modelAId: 'A', modelBId: 'M' }), tcore.modelPairKey({ modelAId: 'B', modelBId: 'M' })].sort());
  // normaliseView keeps the keys (round trip through a project file)
  const v = tcore.normaliseView({ name: 'Arch MEP', facets: { modelPair: mig } });
  assert.deepEqual(v.facets.modelPair, mig);
});

test('reducer wrapper migrates name-valued model pairs in the facets and saved views once the models are there', () => {
  const fn = slice('  function _ccMigrateTriageModelPairs(s) {', '    return Object.assign({}, s, { triage: Object.assign({}, tr, u) });\n  }');
  const migrate = new Function('window', fn + '\n  }\n  return _ccMigrateTriageModelPairs;')({ _ccClashTriageCore: tcore });
  const legacy = { facets: { modelPair: ['Arch ↔ MEP'], severity: ['major'] }, savedViews: [{ id: 'v1', name: 'AM', facets: { modelPair: ['Arch ↔ MEP'] }, search: '' }, { id: 'v2', name: 'Sev', facets: { severity: ['critical'] }, search: '' }], activeViewId: 'v1' };
  const noModels = { models: [], triage: legacy };
  assert.equal(migrate(noModels), noModels, 'no models: unchanged (same object)');
  const s = { models: [{ id: 'A', name: 'Arch' }, { id: 'M', name: 'MEP' }], triage: legacy };
  const out = migrate(s);
  const key = tcore.modelPairKey({ modelAId: 'A', modelBId: 'M' });
  assert.deepEqual(out.triage.facets, { modelPair: [key], severity: ['major'] });
  assert.deepEqual(out.triage.savedViews[0].facets.modelPair, [key]);
  assert.equal(out.triage.savedViews[1], legacy.savedViews[1], 'untouched view kept');
  assert.equal(out.triage.activeViewId, 'v1');
  assert.equal(migrate(out), out, 'migrated: a no-op (same object)');
  assert.match(src, /function _ccAppReducer\(s, a\) \{ return _ccMigrateTriageModelPairs\(reducer\(s, a\)\); \}/);
  assert.match(src, /useReducer\(_ccAppReducer, INIT\)/);
});

test('wiring: the list and the review set group incrementally, the triage model ignores names, visibility is outside the pass cache', () => {
  const vl = slice('  function VirtualList(props) {', '    if(items.length===0) {');
  assert.match(vl, /_ccElementGroupsDelta\(pin\.eg, items\)/);
  assert.match(vl, /groupAndSort\(items, groupBy, sortBy, \{models: models, degOut: degOut\}\)/);
  assert.match(vl, /_ccBuildConflictRows\(items, groups, collapsed, groupLimits, isClusterGroup, rowSegRef\.current\)/);
  const rev = slice('  function _ccReviewModel(s) {', '  // ── Truthful empty/filtered states');
  assert.match(rev, /_ccElementGroupsDelta\(L\.eg, clashes\)/);
  assert.match(rev, /var pre = preAll\.filter\(function\(c\) \{ return _ccListItemVisible\(c, true, tm\.visibleModels\); \}\);/);
  const pass = slice('  function _ccListItemPasses(it, f, isClashTab, visibleModelIds, triage, rules, names) {', '  function _ccListItemPasses1(');
  assert.match(pass, /if \(!_ccListItemVisible\(it, isClashTab, visibleModelIds\)\) return false;/);
  assert.doesNotMatch(pass.slice(pass.indexOf('function _ccListItemPassesRest')), /visibleModelIds/);
  // ClashBcfScopeMenu is memoised on what it shows
  assert.match(src, /ClashBcfScopeMenu = React\.memo\(ClashBcfScopeMenu, function\(a, b\)\{/);
});
