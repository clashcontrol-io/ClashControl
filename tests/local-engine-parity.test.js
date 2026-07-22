'use strict';

// ── Golden parity: local-engine rule layer vs. browser semantics (V7 P0.6) ──
//
// The V7_RELEASE_PLAN P0 gate is that the local ("exact") engine and the browser
// engine return the SAME result set for the same rules. The geometry engines are
// identical (same Möller tri-tri + BVH); the divergence lived entirely in the
// RULE-APPLICATION layer — which pairs survive filtering after detection. This
// suite locks that layer.
//
// It composes the local path exactly as addons/local-engine.js does:
//   1. drop a clash when the SHARED core policy skips its discipline pair
//      (window._ccMatrixSkipsSameDiscipline === clash-discipline-core's
//      matrixSkipsSameDiscipline — the SAME function the browser engine calls),
//   2. then _applyClientSideRuleFilters (excludeSelf / excludeTypes /
//      excludeTypePairs / minGap / tighten-only toleranceByTypePair),
// and asserts the survivors match an INDEPENDENT reference implementation of the
// browser's documented predicates, across a matrix of rulesets. Any drift in the
// local filter (e.g. the excludeTypePairs array-vs-map bug this plan fixed) fails
// here. NOTE: this is the unit layer — an end-to-end browser-vs-local run over
// real geometry (Playwright + the Python engine) is the remaining P0.6 follow-up.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const discipline = require('../clash-discipline-core.js');

// Reuse the addon's real _applyClientSideRuleFilters (extract-and-eval, same
// pattern as local-engine-units.test.js) so we test the shipping code, not a copy.
const source = fs.readFileSync(path.join(__dirname, '..', 'addons', 'local-engine.js'), 'utf8');
function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'start marker not found');
  assert.notEqual(end, -1, 'end marker not found');
  return source.slice(start, end);
}
const applyFilters = new Function(`
  ${extract('function _clashFromEngineResult(c, elA, elB, mA, mB, rules) {', '\n  function _detectOnLocalEngine(')}
  return _applyClientSideRuleFilters;
`)();

// ── Fixtures: two models, a spread of element types across disciplines ──────
const modelStr = { id: 'm-str', name: 'Structure', discipline: 'structural' };
const modelMep = { id: 'm-mep', name: 'MEP', discipline: 'mep' };
function el(expressId, ifcType) { return { expressId, props: { ifcType } }; }

// A synthetic "what the engine returned" corpus: element A/B, their models,
// engine clash type + signed mm distance.
const CORPUS = [
  { a: el(1, 'IfcWall'),        ma: modelStr, b: el(2, 'IfcPipeSegment'), mb: modelMep, type: 'hard', dist: -8 },
  { a: el(3, 'IfcBeam'),        ma: modelStr, b: el(4, 'IfcDuctSegment'), mb: modelMep, type: 'hard', dist: -3 },
  { a: el(5, 'IfcColumn'),      ma: modelStr, b: el(6, 'IfcBeam'),        mb: modelStr, type: 'hard', dist: -5 }, // same discipline (STR/STR)
  { a: el(7, 'IfcWall'),        ma: modelStr, b: el(8, 'IfcWall'),        mb: modelStr, type: 'hard', dist: -2 }, // same model (self)
  { a: el(9, 'IfcSlab'),        ma: modelStr, b: el(10, 'IfcSpace'),      mb: modelStr, type: 'hard', dist: -4 },
  { a: el(11, 'IfcDuctSegment'),ma: modelMep, b: el(12, 'IfcWall'),       mb: modelStr, type: 'soft', dist: 7 },
  { a: el(13, 'IfcPipeSegment'),ma: modelMep, b: el(14, 'IfcColumn'),     mb: modelStr, type: 'soft', dist: 30 },
  { a: el(15, 'IfcPipeSegment'),ma: modelMep, b: el(16, 'IfcDuctSegment'),mb: modelMep, type: 'hard', dist: -6 }, // same discipline (MEP/MEP)
];

function pairId(row) { return row.a.expressId + '_' + row.b.expressId; }
function typeKey(tA, tB) { return tA < tB ? tA + ':' + tB : tB + ':' + tA; }

// The local pipeline, exactly as addons/local-engine.js runs it.
function localSurvivors(rules) {
  const kept = [];
  CORPUS.forEach((row) => {
    const sameModel = row.ma.id === row.mb.id;
    // Step 1: discipline drop via the SHARED core function (the browser calls
    // the identical matrixSkipsSameDiscipline).
    if (discipline.matrixSkipsSameDiscipline(row.a, row.ma, row.b, row.mb, sameModel, rules)) return;
    // Step 2: build the clash-object subset _applyClientSideRuleFilters reads.
    kept.push({
      _pid: pairId(row),
      elemAType: row.a.props.ifcType,
      elemBType: row.b.props.ifcType,
      selfClash: sameModel,
      type: row.type,
      distance: row.dist,
    });
  });
  return applyFilters(kept, rules).map((c) => c._pid).sort();
}

// Independent reference: the browser engine's documented predicates, expressed
// from first principles (NOT reusing the addon's filter), so a drift in the
// local filter shows up as a mismatch.
function referenceSurvivors(rules) {
  const excludeSelf = !!rules.excludeSelf;
  const exTypes = {};
  (rules.excludeTypes || []).forEach((t) => { exTypes[t] = true; });
  const exPairs = {};
  const etp = rules.excludeTypePairs;
  if (Array.isArray(etp)) etp.forEach((p) => { exPairs[p] = true; });
  else if (etp && typeof etp === 'object') Object.keys(etp).forEach((k) => { if (etp[k]) exPairs[k] = true; });
  const minGap = rules.minGap || 0;
  const maxGap = rules.maxGap || 0;
  const tbp = rules.toleranceByTypePair || null;

  const out = [];
  CORPUS.forEach((row) => {
    const sameModel = row.ma.id === row.mb.id;
    const tA = row.a.props.ifcType, tB = row.b.props.ifcType;
    // Discipline policy (same predicate the core encodes, written out here).
    if (!rules.duplicates && !sameModel) {
      const dA = discipline.elementDiscipline(row.a, row.ma.discipline);
      const dB = discipline.elementDiscipline(row.b, row.mb.discipline);
      const key = dA < dB ? dA + ':' + dB : dB + ':' + dA;
      const dm = rules.disciplineMatrix;
      let enabled;
      if (dm && dm[key] !== undefined) enabled = dm[key] !== false;
      else if (dA !== dB) enabled = true;
      else enabled = rules.excludeSameDiscipline === false;
      if (!enabled) return;
    }
    if (excludeSelf && sameModel) return;
    if (exTypes[tA] || exTypes[tB]) return;
    const pk = typeKey(tA, tB);
    if (exPairs[pk]) return;
    if (row.type === 'soft') {
      if (minGap > 0 && Math.abs(row.dist) < minGap) return;
      if (tbp && tbp[pk] !== undefined) {
        const tol = tbp[pk];
        if (tol < maxGap && Math.abs(row.dist) > tol) return; // tighten-only, matches the local filter
      }
    }
    out.push(pairId(row));
  });
  return out.sort();
}

const RULE_MATRIX = [
  { name: 'INIT defaults (excludeSelf + excludeSameDiscipline + semantic)', rules: { hard: true, maxGap: 50, minGap: 0, duplicates: false, excludeSelf: true, excludeTypes: [], excludeTypePairs: [], toleranceByTypePair: {}, useSemanticFilter: true, excludeSameDiscipline: true } },
  { name: 'keep self-clashes (excludeSelf off)', rules: { hard: true, maxGap: 50, excludeSelf: false, excludeSameDiscipline: true } },
  { name: 'allow same-discipline pairs', rules: { hard: true, maxGap: 50, excludeSelf: true, excludeSameDiscipline: false } },
  { name: 'excludeTypes drops IfcSpace', rules: { hard: true, maxGap: 50, excludeSelf: true, excludeSameDiscipline: true, excludeTypes: ['IfcSpace'] } },
  { name: 'excludeTypePairs ARRAY (real INIT shape)', rules: { hard: true, maxGap: 50, excludeSelf: true, excludeSameDiscipline: true, excludeTypePairs: ['IfcDuctSegment:IfcWall'] } },
  { name: 'excludeTypePairs legacy OBJECT shape', rules: { hard: true, maxGap: 50, excludeSelf: true, excludeSameDiscipline: true, excludeTypePairs: { 'IfcDuctSegment:IfcWall': true } } },
  { name: 'disciplineMatrix override disables STR:MEP', rules: { hard: true, maxGap: 50, excludeSelf: true, excludeSameDiscipline: true, disciplineMatrix: { 'mep:structural': false } } },
  { name: 'disciplineMatrix override re-enables STR:STR', rules: { hard: true, maxGap: 50, excludeSelf: true, excludeSameDiscipline: true, disciplineMatrix: { 'structural:structural': true } } },
  { name: 'soft minGap floor', rules: { hard: false, maxGap: 50, minGap: 10, excludeSelf: true, excludeSameDiscipline: true } },
  { name: 'toleranceByTypePair tighten below maxGap', rules: { hard: false, maxGap: 50, excludeSelf: true, excludeSameDiscipline: true, toleranceByTypePair: { 'IfcColumn:IfcPipeSegment': 10 } } },
  { name: 'duplicates on (no discipline skip, self kept)', rules: { hard: true, maxGap: 50, duplicates: true, excludeSelf: false } },
];

RULE_MATRIX.forEach(({ name, rules }) => {
  test('parity: local rule pipeline matches the browser reference — ' + name, () => {
    assert.deepEqual(localSurvivors(rules), referenceSurvivors(rules),
      'local-engine rule layer diverged from the browser semantics for: ' + name);
  });
});

// Anchor a couple of survivor sets to concrete expectations so a bug that
// happens to shift BOTH implementations identically still gets caught.
test('parity anchor: defaults drop the same-model self pair and keep the cross-discipline hits', () => {
  const s = localSurvivors({ hard: true, maxGap: 50, excludeSelf: true, excludeSameDiscipline: true });
  assert.ok(!s.includes('7_8'), 'self pair (same model) must be dropped by excludeSelf');
  assert.ok(!s.includes('5_6'), 'STR/STR same-discipline pair must be dropped');
  assert.ok(!s.includes('15_16'), 'MEP/MEP same-discipline pair must be dropped');
  assert.ok(s.includes('1_2'), 'STR wall vs MEP pipe (cross-discipline) must survive');
});

test('parity anchor: the excludeTypePairs ARRAY shape actually filters (regression for the array-vs-map bug)', () => {
  const withArray = localSurvivors({ hard: true, maxGap: 50, excludeSelf: true, excludeSameDiscipline: true, excludeTypePairs: ['IfcDuctSegment:IfcWall'] });
  assert.ok(!withArray.includes('11_12'), 'DuctSegment×Wall soft pair must be dropped by the array-shaped excludeTypePairs');
});
