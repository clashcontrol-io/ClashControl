'use strict';

// Coordination matrix v2 — one cell = one rule (rules.matrixRules).
// Locks: cell precedence (exact trade cell > top-level cell > default, the
// rule before the legacy boolean at each level), the old boolean matrix
// still resolving exactly as before, per-pair gap resolution together with
// the per-type-pair tolerance (the engine's real _pairGapMFor / broad-phase
// margin, extracted from index.html), the run signature, the local-engine
// gate failing closed, project-codec round trip, the Standards migration,
// templates and the severity hook.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../clash-discipline-core.js');
const classification = require('../clash-classification-core.js');
const codec = require('../project-codec.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const leSrc = fs.readFileSync(path.join(__dirname, '..', 'addons', 'local-engine.js'), 'utf8');
function between(text, a, b) {
  const i = text.indexOf(a);
  assert.ok(i !== -1, 'not found: ' + a);
  const j = text.indexOf(b, i);
  assert.ok(j !== -1, 'end not found: ' + b);
  return text.slice(i, j);
}

// The pre-v2 resolution, verbatim, as the reference for old projects.
function legacyEnabled(discA, discB, rules) {
  rules = rules || {};
  const top = (k) => String(k || '').split('.')[0];
  const sub = (k) => { const i = String(k || '').indexOf('.'); return i < 0 ? null : String(k).slice(i + 1); };
  const pairKey = discA < discB ? discA + ':' + discB : discB + ':' + discA;
  const dm = rules.disciplineMatrix;
  if (dm && dm[pairKey] !== undefined) return dm[pairKey] !== false;
  const tA = top(discA), tB = top(discB);
  if (tA !== discA || tB !== discB) {
    const tKey = tA < tB ? tA + ':' + tB : tB + ':' + tA;
    if (dm && dm[tKey] !== undefined) return dm[tKey] !== false;
  }
  if (tA !== tB) return true;
  if (rules.excludeSameDiscipline === false) return true;
  const sA = sub(discA), sB = sub(discB);
  if (!sA || !sB || sA === sB) return false;
  if ((sA === 'piping' || sB === 'piping') && core.subFamily[sA] === core.subFamily[sB]) return false;
  return true;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

test('old boolean matrix (no matrixRules) resolves exactly as before, cellRule agrees', () => {
  const keys = core.matrixKeys;
  const r = rng(7);
  for (let n = 0; n < 400; n++) {
    const rules = { excludeSameDiscipline: r() < 0.8 };
    if (r() < 0.7) {
      rules.disciplineMatrix = {};
      for (let i = 0; i < 5; i++) {
        const a = keys[Math.floor(r() * keys.length)], b = keys[Math.floor(r() * keys.length)];
        rules.disciplineMatrix[core.matrixCellKey(a, b)] = r() < 0.5;
      }
    }
    for (const a of keys) for (const b of keys) {
      const want = legacyEnabled(a, b, rules);
      assert.equal(core.disciplinePairEnabled(a, b, rules), want, a + ' x ' + b);
      assert.equal(core.cellRule(a, b, rules).mode !== 'off', want);
      assert.equal(core.pairGapMm(a, b, rules), null, 'a boolean cell never sets a gap');
    }
  }
});

test('cell precedence: exact trade cell > top-level cell > default; rule before legacy boolean per level', () => {
  const rules = {
    excludeSameDiscipline: true,
    matrixRules: {
      'mep:structural': { mode: 'clearance', gapMm: 100, severity: 'major', note: 'top' },
      'mep.ventilation:structural': { mode: 'hard', gapMm: null, severity: null, note: '' },
      'architectural:mep': { mode: 'off' }
    },
    disciplineMatrix: { 'mep:structural': false, 'mep.plumbing:structural': false, 'architectural:mep.fire': true }
  };
  // exact trade rule wins over the top-level rule
  let c = core.cellRule('structural', 'mep.ventilation', rules);
  assert.deepEqual([c.mode, c.level, c.key], ['hard', 'exact', 'mep.ventilation:structural']);
  assert.equal(core.pairGapMm('mep.ventilation', 'structural', rules), 0);
  // an exact legacy boolean beats the top-level rule (exact level first)
  c = core.cellRule('structural', 'mep.plumbing', rules);
  assert.deepEqual([c.mode, c.level], ['off', 'exact']);
  assert.equal(core.disciplinePairEnabled('structural', 'mep.plumbing', rules), false);
  // the top-level rule beats the top-level legacy boolean (rule first)
  c = core.cellRule('structural', 'mep.heating', rules);
  assert.deepEqual([c.mode, c.level, c.gapMm, c.severity], ['clearance', 'top', 100, 'major']);
  assert.equal(core.disciplinePairEnabled('structural', 'mep.heating', rules), true);
  assert.equal(core.pairGapMm('structural', 'mep', rules), 100);
  // off rule at the top level, exact legacy true re-enables the fire trade
  assert.equal(core.disciplinePairEnabled('architectural', 'mep.electrical', rules), false);
  assert.equal(core.disciplinePairEnabled('architectural', 'mep.fire', rules), true);
  // default when nothing is saved
  c = core.cellRule('civil', 'other', rules);
  assert.deepEqual([c.mode, c.level], ['on', 'default']);
  assert.deepEqual(core.cellRule('structural', 'structural', rules).mode, 'off');
  // an unknown mode is not a rule: the level below decides
  assert.equal(core.disciplinePairEnabled('civil', 'other', { matrixRules: { 'civil:other': { mode: 'maybe' } } }), true);
  assert.equal(core.disciplinePairEnabled('civil', 'other', { matrixRules: { 'civil:other': { mode: 'maybe' } }, disciplineMatrix: { 'civil:other': false } }), false);
  // severity only from cells that test the pair
  assert.equal(core.pairSeverity('structural', 'mep.heating', rules), 'major');
  assert.equal(core.pairSeverity('architectural', 'mep.electrical', { matrixRules: { 'architectural:mep': { mode: 'off', severity: 'critical' } } }), null);
});

test('pairGapMm / maxCellGapMm / matrixSetsGaps', () => {
  const R = (mr) => ({ matrixRules: mr });
  assert.equal(core.pairGapMm('a', 'b', R({ 'a:b': { mode: 'clearance', gapMm: 75 } })), 75);
  assert.equal(core.pairGapMm('a', 'b', R({ 'a:b': { mode: 'clearance', gapMm: null } })), null, 'no gap: the run max gap');
  assert.equal(core.pairGapMm('a', 'b', R({ 'a:b': { mode: 'hard' } })), 0);
  assert.equal(core.pairGapMm('a', 'b', R({ 'a:b': { mode: 'on', gapMm: 99 } })), null, 'gap only counts on a clearance cell');
  assert.equal(core.pairGapMm('a', 'b', R({ 'a:b': { mode: 'clearance', gapMm: -4 } })), null, 'negative gap ignored');
  assert.equal(core.maxCellGapMm(R({ 'a:b': { mode: 'clearance', gapMm: 75 }, 'c:d': { mode: 'clearance', gapMm: 120 }, 'e:f': { mode: 'on', gapMm: 900 } })), 120);
  assert.equal(core.maxCellGapMm({}), 0);
  assert.equal(core.matrixSetsGaps(R({ 'a:b': { mode: 'off' } })), false);
  assert.equal(core.matrixSetsGaps(R({ 'a:b': { mode: 'hard' } })), true);
  assert.equal(core.matrixSetsSeverity(R({ 'a:b': { mode: 'on', severity: 'minor' } })), true);
  assert.equal(core.matrixSetsSeverity(R({ 'a:b': { mode: 'on', severity: 'nope' } })), false);
});

// ── the engine's own gap resolution (index.html, _detectClashesCore) ──
const runGapSrc = between(src, '    var runGapM = maxGapM;', '    // The sweeps reject a pair when');
const pairGapSrc = between(src, '    function _pairGapMFor(eA, eB, mA, mB) {', '    // Type-pair impossibility memo');
function engine(rules) {
  return new Function('rules', '_ccDisciplineCore', 'var maxGapM = (rules.maxGap||0)/1000;\n' + runGapSrc + pairGapSrc +
    '\nreturn { runGapM: runGapM, gap: _pairGapMFor };')(rules, core);
}
const mStr = { id: 's', discipline: 'structural' }, mVen = { id: 'v', discipline: 'mep' }, mArc = { id: 'a', discipline: 'architectural' };
const elVent = { props: { ifcType: 'IfcDuctSegment' }, _ccCls: { d: 'mep', sub: 'ventilation' } };
const elWall = { props: { ifcType: 'IfcWall' } };
const elBeam = { props: { ifcType: 'IfcBeam' } };
const elDoor = { props: { ifcType: 'IfcDoor' } };

test('engine gap: type-pair tolerance > matrix cell > maxGap; hard cell = 0; margin covers the widest cell', () => {
  const rules = {
    maxGap: 50,
    toleranceByTypePair: { 'IfcBeam:IfcDuctSegment': 20 },
    matrixRules: { 'mep.ventilation:structural': { mode: 'clearance', gapMm: 100 }, 'architectural:structural': { mode: 'hard' } }
  };
  const e = engine(rules);
  assert.equal(e.runGapM, 0.1, 'broad-phase margin widened to the largest cell gap');
  assert.equal(e.gap(elVent, elWall, mVen, mStr), 0.1, 'clearance cell');
  assert.equal(e.gap(elWall, elVent, mStr, mVen), 0.1, 'order independent');
  assert.equal(e.gap(elVent, elBeam, mVen, mStr), 0.02, 'type-pair tolerance wins over the cell');
  assert.equal(e.gap(elDoor, elWall, mArc, mStr), 0, 'hard cell = gap 0');
  assert.equal(e.gap(elDoor, elVent, mArc, mVen), 0.05, 'no cell rule: maxGap');
  // every pair's gap is within the broad-phase gap
  for (const [a, b, ma, mb] of [[elVent, elWall, mVen, mStr], [elVent, elBeam, mVen, mStr], [elDoor, elWall, mArc, mStr]]) assert.ok(e.gap(a, b, ma, mb) <= e.runGapM);
  // the type-pair tolerance still sets the margin when it is the largest
  assert.equal(engine(Object.assign({}, rules, { toleranceByTypePair: { 'IfcBeam:IfcDuctSegment': 300 } })).runGapM, 0.3);
  // the same cell gap arithmetic in both places (exact equality, not approx)
  const odd = engine({ maxGap: 0, matrixRules: { 'mep.ventilation:structural': { mode: 'clearance', gapMm: 37.3 } } });
  assert.equal(odd.runGapM, odd.gap(elVent, elWall, mVen, mStr));
});

test('engine gap: without matrixRules the old behaviour holds exactly', () => {
  const e = engine({ maxGap: 50, toleranceByTypePair: { 'IfcBeam:IfcDuctSegment': 80 }, disciplineMatrix: { 'mep:structural': true } });
  assert.equal(e.runGapM, 0.08);
  assert.equal(e.gap(elVent, elWall, mVen, mStr), 0.05);
  assert.equal(e.gap(elVent, elBeam, mVen, mStr), 0.08);
  assert.equal(e.gap(elVent, elWall), 0.05, 'called without models (old call shape)');
});

// ── smart re-run signature ──
test('run signature includes matrixRules; absent and empty are the same run', () => {
  const stableJson = between(src, 'function _ccStableJSON(o) {', '  function _ccCanonOne(');
  const sigSrc = between(src, 'function _ccRunSignature(models, rules, protectedPairs) {', '  // ── Type-pair impossibility memo');
  const sig = new Function('window', '_ccOrigin', stableJson + sigSrc + '; return _ccRunSignature;')({}, [0, 0, 0]);
  const models = [{ id: 'm1', name: 'A', discipline: 'structural', elements: [] }];
  const base = { hard: true, maxGap: 50 };
  const s0 = sig(models, base, null);
  assert.ok(s0);
  assert.equal(sig(models, Object.assign({}, base, { matrixRules: {} }), null), s0, 'empty matrix = no matrix');
  assert.equal(sig(models, Object.assign({}, base, { matrixRules: undefined }), null), s0, 'undefined = absent');
  const s1 = sig(models, Object.assign({}, base, { matrixRules: { 'mep:structural': { mode: 'clearance', gapMm: 100 } } }), null);
  assert.notEqual(s1, s0);
  assert.notEqual(sig(models, Object.assign({}, base, { matrixRules: { 'mep:structural': { mode: 'clearance', gapMm: 101 } } }), null), s1, 'gap change');
  assert.notEqual(sig(models, Object.assign({}, base, { matrixRules: { 'mep:structural': { mode: 'clearance', gapMm: 100, severity: 'major' } } }), null), s1, 'severity change');
});

// ── local engine ──
const leBlock = between(leSrc, 'function _clashFromEngineResult(c, elA, elB, mA, mB, rules) {', '\n  function _detectOnLocalEngine(');
function leApi(win) {
  return new Function('window', leBlock + '\nreturn { can: _localEngineCanHandle, filter: _applyClientSideRuleFilters };')(win);
}

test('local-engine gate fails closed when a cell gap exceeds maxGap (or the core is missing)', () => {
  const api = leApi({ _ccClashDisciplineCore: core });
  assert.equal(api.can({ maxGap: 50 }).ok, true);
  assert.equal(api.can({ maxGap: 50, matrixRules: { 'mep:structural': { mode: 'clearance', gapMm: 100 } } }).ok, false);
  assert.equal(api.can({ maxGap: 50, matrixRules: { 'mep:structural': { mode: 'clearance', gapMm: 50 } } }).ok, true);
  assert.equal(api.can({ maxGap: 50, matrixRules: { 'mep:structural': { mode: 'hard' } } }).ok, true);
  assert.equal(leApi({}).can({ maxGap: 50, matrixRules: { 'mep:structural': { mode: 'hard' } } }).ok, false, 'no core: fail closed');
  assert.equal(leApi({}).can({ maxGap: 50, matrixRules: {} }).ok, true);
});

test('local-engine client filter tightens soft clashes to the cell gap (type-pair tolerance first)', () => {
  const api = leApi({ _ccClashDisciplineCore: core });
  const rules = { maxGap: 50, matrixRules: { 'mep.ventilation:structural': { mode: 'clearance', gapMm: 20 }, 'architectural:structural': { mode: 'hard' } },
    toleranceByTypePair: { 'IfcBeam:IfcDuctSegment': 40 } };
  const C = (id, a, b, ta, tb, dist) => ({ id, type: 'soft', distance: dist, trades: [a, b], elemAType: ta, elemBType: tb });
  const out = api.filter([
    C(1, 'mep.ventilation', 'structural', 'IfcDuctSegment', 'IfcWall', 10),
    C(2, 'mep.ventilation', 'structural', 'IfcDuctSegment', 'IfcWall', 30),
    C(3, 'mep.ventilation', 'structural', 'IfcDuctSegment', 'IfcBeam', 30),
    C(4, 'architectural', 'structural', 'IfcDoor', 'IfcWall', 5),
    C(5, 'civil', 'structural', 'IfcSlab', 'IfcWall', 45)
  ], rules).map((c) => c.id);
  assert.deepEqual(out, [1, 3, 5]);
});

// ── project codec ──
test('project codec: matrixRules round-trips; an old project without it sets no matrix', () => {
  const mr = { 'mep.ventilation:structural': { mode: 'clearance', gapMm: 100, severity: 'major', note: 'spec 4.2' } };
  const state = { rules: { hard: true, maxGap: 50, matrixRules: mr, disciplineMatrix: { 'civil:other': false } }, models: [], clashes: [], issues: [], floors: [] };
  const data = JSON.parse(JSON.stringify(codec.serializeProject(state, '1', 't')));
  const actions = [];
  codec.restoreProject(data, (a) => actions.push(a), { ADD_MODEL: 'ADD_MODEL', UPD_RULES: 'UPD_RULES', SET_CLASHES: 'SET_CLASHES', LOAD_PROJECT_STATE: 'L', ADD_ISSUE: 'I', ADD_VIEWPOINT: 'V', ADD_MEASUREMENT: 'M' });
  const upd = actions.find((a) => a.t === 'UPD_RULES');
  assert.deepEqual(upd.u.matrixRules, mr);
  assert.deepEqual(upd.u.disciplineMatrix, { 'civil:other': false });
  const old = { _cc: 'ClashControl', rules: { hard: true, maxGap: 50, disciplineMatrix: { 'mep:structural': false } }, models: [] };
  const acts2 = [];
  codec.restoreProject(old, (a) => acts2.push(a), { ADD_MODEL: 'ADD_MODEL', UPD_RULES: 'UPD_RULES' });
  assert.equal(Object.prototype.hasOwnProperty.call(acts2[0].u, 'matrixRules'), false);
  assert.equal(core.disciplinePairEnabled('structural', 'mep.ventilation', acts2[0].u), false, 'old boolean still honoured');
});

test('Standards discipline-pair rules migrate into matrix cells', () => {
  const mr = core.matrixRulesFromStandardPairRules([
    { discipline_a: 'structural', discipline_b: 'mechanical', clearance_mm: 50, hard_always_flagged: true },
    { discipline_a: 'mechanical', discipline_b: 'structural', clearance_mm: 80 }, // duplicate: first wins
    { discipline_a: 'architectural', discipline_b: 'electrical', clearance_mm: 0 },
    { discipline_a: 'civil', discipline_b: 'other', clearance_mm: '' },
    { discipline_a: 'nope', discipline_b: 'other', clearance_mm: 10 },
    null
  ]);
  assert.deepEqual(mr, {
    'mep:structural': { mode: 'clearance', gapMm: 50, severity: null, note: '' },
    'architectural:mep.electrical': { mode: 'hard', gapMm: null, severity: null, note: '' }
  });
  assert.deepEqual(core.matrixRulesFromStandardPairRules('junk'), {});
  // the app runs it once, only into a project that has models and no matrix
  assert.match(src, /if \(!s\.models\.length \|\| \(s\.rules && s\.rules\.matrixRules !== undefined\)\) return;\s*var mr = _ccMigrateStandardPairRulesOnce\(\);/);
  assert.match(src, /localStorage\.getItem\('cc_standard_pair_rules_migrated'\) === '1'/);
  // the Standards panel no longer edits discipline-pair rules
  assert.doesNotMatch(src, /_setStandardPairRules\(/);
  assert.match(src, /_cc_t\('standards\.disciplinePairRulesMoved'/);
});

test('matrix template: export / import round trip, junk rejected', () => {
  const rules = { matrixRules: { 'structural:mep': { mode: 'clearance', gapMm: 25, severity: 'critical', note: 'x', extra: 1 }, bad: { mode: 'on' } }, disciplineMatrix: { 'civil:other': false, 'a:b': 0 } }; // like the engine: anything but false is on
  const t = core.matrixTemplate(rules);
  assert.equal(t.kind, 'clashcontrol.matrix');
  assert.deepEqual(t.matrixRules, { 'mep:structural': { mode: 'clearance', gapMm: 25, severity: 'critical', note: 'x' } });
  assert.deepEqual(t.disciplineMatrix, { 'civil:other': false, 'a:b': true });
  const back = core.readMatrixTemplate(JSON.parse(JSON.stringify(t)));
  assert.deepEqual(back, { matrixRules: t.matrixRules, disciplineMatrix: t.disciplineMatrix });
  assert.equal(core.readMatrixTemplate({ rules: [] }), null);
  assert.equal(core.readMatrixTemplate(null), null);
});

// ── severity ──
test('classifyClashes: a cell severity becomes the severity, stamped as rule-derived', () => {
  const mk = (type, extra) => Object.assign({ id: type, type, elemAType: 'IfcDuctSegment', elemBType: 'IfcWall', disciplines: ['mep', 'structural'],
    trades: ['mep.ventilation', 'structural'], point: [0, 0, 0], distance: type === 'hard' ? -5 : 30, clearanceMm: type === 'soft' ? 30 : null }, extra || {});
  const sevRules = { matrixRules: { 'mep.ventilation:structural': { mode: 'clearance', gapMm: 100, severity: 'critical' } } };
  const ctx = { ruleSeverity: (c) => (c.type === 'hard' || c.type === 'soft') ? core.pairSeverity(c.trades[0], c.trades[1], sevRules) : null };
  const plain = [mk('soft')];
  classification.classifyClashes(plain);
  assert.notEqual(plain[0].aiSeverity, 'critical');
  const withRule = [mk('soft'), mk('hard'), mk('contact', { distance: 0 })];
  classification.classifyClashes(withRule, ctx);
  assert.equal(withRule[0].aiSeverity, 'critical');
  assert.equal(withRule[1].aiSeverity, 'critical');
  assert.equal(withRule[0]._sevSource, 'rule');
  assert.equal(withRule[2].aiSeverity, 'info', 'contacts keep their own severity');
  // index.html: the run's rules ride on the result, the wrapper passes the hook
  assert.match(src, /result\._ccSevRules = \{ matrixRules: rules\.matrixRules/);
  assert.match(src, /_ccClassificationCore\.classifyClashes\(clashes, _ccMatrixSeverityCtx\(clashes && clashes\._ccSevRules\)\)/);
});

test('UI: the matrix is the DisciplineMatrixEditor, its strings are translated', () => {
  assert.match(src, /<\$\{DisciplineMatrixEditor\} rules=\$\{rules\} d=\$\{d\} \/>/);
  assert.doesNotMatch(src, /_renderDisciplineMatrix/);
  const nl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'nl.json'), 'utf8')).strings;
  for (const k of ['matrix.mode.on', 'matrix.mode.off', 'matrix.mode.hard', 'matrix.mode.clearance', 'matrix.mode.default', 'matrix.severityAuto', 'matrix.exportTemplate', 'matrix.importTemplate', 'standards.disciplinePairRulesMoved']) {
    assert.match(src, new RegExp("_cc_t\\('" + k.replace(/\./g, '\\.') + "'"), k);
    assert.ok(nl[k], 'nl: ' + k);
  }
});
