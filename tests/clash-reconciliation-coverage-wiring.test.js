'use strict';
// CLAUDE.md Item 2 wiring lock: index.html must actually pass a run's
// resolved model scope into clash-reconciliation-core's mergeDetectionResults
// as `options.coverage`, via the single source of truth for scope
// resolution (_ccResolveModelScope) -- not reimplement scope logic here.
//
// Three things are locked:
//  1. _ccCoverageModelIds resolves rules.modelA/modelB through the real
//     _ccResolveModelScope into a deduped model-id list.
//  2. index.html's mergeDetectionResults wrapper turns that id list into a
//     `coverage` predicate and passes it to the reconciliation core (and
//     omits it entirely for the legacy 2-arg call shape).
//  3. Every real detectClashesAsync call site that commits a result also
//     builds `coverageModelIds` via _ccCoverageModelIds before dispatching.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(startText, endText, fromIndex) {
  const start = source.indexOf(startText, fromIndex || 0);
  assert.notEqual(start, -1, `missing start marker: ${startText}`);
  const end = source.indexOf(endText, start);
  assert.notEqual(end, -1, `missing end marker: ${endText}`);
  return source.slice(start, end + endText.length);
}

// (1) _ccResolveModelScope + _ccCoverageModelIds, loaded as two small
// self-contained function declarations (not the surrounding detection
// engine) so this stays a targeted unit test, not a heavy VM load.
function loadCoverageHelpers() {
  const resolveScope = slice(
    'function _ccResolveModelScope(models, id) {',
    'window._ccResolveModelScope = _ccResolveModelScope;'
  );
  const coverageIds = slice(
    'function _ccCoverageModelIds(rules, models) {',
    '\n\n',
    source.indexOf('function _ccCoverageModelIds(rules, models) {')
  );
  const body = resolveScope + '\n' + coverageIds + '\nreturn {_ccResolveModelScope, _ccCoverageModelIds};';
  const window = {};
  return new Function('window', body)(window);
}

// Bug 1: _ccCoverageModelIds now excludes a model with no loaded geometry
// (elements/meshes both empty) from coverage, so give these fixture models
// a non-empty elements array -- they represent normally-loaded models, not
// the empty-geometry restore-stub case a dedicated test below covers.
function model(id, name) { return {id, name, elements: [{}]}; }

test('_ccCoverageModelIds resolves modelA/modelB through the real _ccResolveModelScope, keeping the two sides SEPARATE', () => {
  // R3 follow-up: this used to return one merged array, which let
  // mergeDetectionResults' wrapper treat a same-model A-A pair as
  // "in coverage" for an A-vs-B scoped run just because A appeared
  // somewhere in the union. Returning {a, b} separately lets the wrapper
  // check the ACTUAL pair shape a run could form.
  const { _ccCoverageModelIds } = loadCoverageHelpers();
  const models = [model('A', 'Arch'), model('B', 'Struct'), model('C', 'MEP'), model('D', 'Site')];

  const scoped = _ccCoverageModelIds({modelA: 'A', modelB: 'B'}, models);
  assert.deepEqual(scoped.a, ['A']);
  assert.deepEqual(scoped.b, ['B']);

  const all = _ccCoverageModelIds({modelA: 'all', modelB: 'all'}, models);
  assert.deepEqual(all.a.sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual(all.b.sort(), ['A', 'B', 'C', 'D']);

  // C and D are never mentioned by an A-B scoped rule set.
  assert.equal(scoped.a.includes('C'), false);
  assert.equal(scoped.b.includes('D'), false);
});

// Bug 1: a model restored from a project file (placeholder, no geometry
// loaded yet) must not count as "covered" -- otherwise a clash referencing
// it looks like it was genuinely re-checked and gets auto-resolved just
// because the model is nominally in scope, even though it was never
// geometrically examined this run.
test('_ccCoverageModelIds excludes a model with no loaded geometry (elements/meshes both empty)', () => {
  const { _ccCoverageModelIds } = loadCoverageHelpers();
  const loaded = {id: 'A', name: 'Arch', elements: [{}], meshes: [{}]};
  const stub = {id: 'B', name: 'Struct', elements: [], meshes: []};
  const models = [loaded, stub];

  const scoped = _ccCoverageModelIds({modelA: 'A', modelB: 'B'}, models);
  assert.deepEqual(scoped.a, ['A']);
  assert.deepEqual(scoped.b, [], 'a model with no elements/meshes must not be covered');
});

test('_ccCoverageModelIds never throws on missing rules/models', () => {
  const { _ccCoverageModelIds } = loadCoverageHelpers();
  assert.deepEqual(_ccCoverageModelIds(null, null), {a: [], b: []});
  assert.deepEqual(_ccCoverageModelIds({}, []), {a: [], b: []});
  assert.deepEqual(_ccCoverageModelIds(undefined, undefined), {a: [], b: []});
});

// (2) The reconciliation wrapper (same loading pattern as
// clash-reconciliation-core-wiring.test.js) turns a coverageModelIds array
// into a real `coverage` predicate function, or omits it for the legacy
// 2-arg call shape existing callers/tests still use.
function loadReconciliationWrapper(candidateCore) {
  const start = source.indexOf('var _ccIdentityCore = window._ccClashIdentityCore;');
  const end = source.indexOf('\n\n', source.indexOf('function mergeDetectionResults(newClashes, prevClashes, coverageModelIds)', start));
  assert.ok(start >= 0 && end > start, 'reconciliation wiring block not found');
  const window = { _ccClashIdentityCore: require('../clash-identity-core'), _ccClashReconciliationCore: candidateCore };
  return new Function('window', source.slice(start, end) + ';return {mergeDetectionResults};')(window);
}

function capture(candidateCore) {
  let capturedDeps;
  const { mergeDetectionResults } = loadReconciliationWrapper({
    mergeDetectionResults: (next, prev, deps) => { capturedDeps = deps; return {clashes: [], deltaSummary: {}}; },
  });
  return { mergeDetectionResults, deps: () => capturedDeps };
}

test('mergeDetectionResults wrapper builds a PRECISE options.coverage from the {a,b} shape', () => {
  const { mergeDetectionResults, deps } = capture();
  mergeDetectionResults([], [], {a: ['A'], b: ['B']});
  assert.equal(typeof deps().coverage, 'function');
  assert.equal(deps().coverage({modelAId: 'A', modelBId: 'B'}), true, 'A-B cross-model pair matches the A/B grouping');
  assert.equal(deps().coverage({modelAId: 'B', modelBId: 'A'}), true, 'direction must not matter');
  assert.equal(deps().coverage({modelAId: 'C', modelBId: 'D'}), false, 'a C-D clash must read as out of coverage for an A-B scoped run');
});

test('mergeDetectionResults wrapper: a same-model pair is covered ONLY if that model is on BOTH sides (R3 fix)', () => {
  // This is the exact bug the review caught: for a plain A-vs-B scoped run
  // (disjoint sides), a same-model A-A self-clash must NOT read as covered
  // just because A appears somewhere in the combined scope -- this run
  // never checked A's self-clashes.
  const { mergeDetectionResults, deps } = capture();
  mergeDetectionResults([], [], {a: ['A'], b: ['B']});
  assert.equal(deps().coverage({modelAId: 'A', modelBId: 'A'}), false, 'A-A self-clash is NOT covered by a disjoint A-vs-B run');
  assert.equal(deps().coverage({modelAId: 'B', modelBId: 'B'}), false, 'B-B self-clash is NOT covered by a disjoint A-vs-B run');
});

test('mergeDetectionResults wrapper: a same-model pair IS covered when that model is explicitly on both sides', () => {
  const { mergeDetectionResults, deps } = capture();
  // An explicit self-clash run (modelA=modelB=A), or an 'all'-vs-'all' run
  // where every model is on both sides.
  mergeDetectionResults([], [], {a: ['A'], b: ['A']});
  assert.equal(deps().coverage({modelAId: 'A', modelBId: 'A'}), true);
});

test('mergeDetectionResults wrapper: the legacy flat-array shape (multi-rule union) still works, with its known over-coverage caveat', () => {
  const { mergeDetectionResults, deps } = capture();
  mergeDetectionResults([], [], ['A', 'B', 'C']);
  assert.equal(deps().coverage({modelAId: 'A', modelBId: 'B'}), true);
  // Documented, deliberate over-approximation for this legacy shape only:
  // A-C reads as covered even though no single rule may have paired them.
  assert.equal(deps().coverage({modelAId: 'A', modelBId: 'C'}), true);
  assert.equal(deps().coverage({modelAId: 'A', modelBId: 'Z'}), false);
});

test('mergeDetectionResults wrapper omits coverage for the legacy 2-arg call shape', () => {
  const { mergeDetectionResults, deps } = capture();
  mergeDetectionResults([], []);
  assert.equal(deps().coverage, undefined);
});

// (3) The reducer actually threads a.coverageModelIds through, and every
// commit-guarded detectClashesAsync call site builds it via
// _ccCoverageModelIds before the result reaches the reducer.
test('the MERGE_CLASHES reducer case passes a.coverageModelIds into mergeDetectionResults', () => {
  assert.match(source, /mergeDetectionResults\(a\.v, a\.t===A\.MERGE_CLASHES\?s\.clashes:\[\], a\.coverageModelIds\)/);
});

test('_ccCommitDetectionResult promotes coverageModelIds from either detectionSettings or opts onto the dispatched action', () => {
  const body = source.slice(
    source.indexOf('function _ccCommitDetectionResult(result, dispatch, detectionSettings, opts) {'),
    source.indexOf('window._ccCommitDetectionResult = _ccCommitDetectionResult;')
  );
  assert.match(body, /var _coverage = \(detectionSettings && detectionSettings\.coverageModelIds\) \|\| \(opts && opts\.coverageModelIds\);/);
  assert.match(body, /if \(_coverage\) action\.coverageModelIds = _coverage;/);
});

// R3 follow-up: the original regex here required NO whitespace between
// `)` and `{` (`function(result)\{`), which silently excluded call sites
// written as `function(result) {` (with a space) -- window._ccRunDetection
// and _ccRunDetectionRuleset's per-rule loop, the two sites that were
// actually unwired for coverage at review time, both use that shape. The
// `>= 7` count also passed regardless of how many sites the regex actually
// found, so a shrinking match set (from a stricter-than-intended pattern,
// or a genuinely new unwired site) would never fail this test. Both fixed:
// whitespace-tolerant regex, exact count.
test('detectClashesAsync( occurs exactly 12 times in index.html (1 definition + 11 real call/dispatch sites)', () => {
  // A change to this count means either a new call site was added (go wire
  // it for coverage and update the number) or one was removed (update the
  // number down) -- never bump this number without checking which.
  const all = [...source.matchAll(/detectClashesAsync\(/g)];
  assert.equal(all.length, 12);
});

test('every detectClashesAsync(...).then(function(result)...) call site builds coverageModelIds via _ccCoverageModelIds first', () => {
  // Whitespace-tolerant: matches both `function(result){` and
  // `function(result) {`.
  const calls = [...source.matchAll(/detectClashesAsync\([^\n]+\)\.then\(function\(result\)\s*\{/g)];
  // This shape covers 10 of the 11 real call sites -- the 11th
  // (_runSelfPass, inside the NL multi-self-clash path) returns the promise
  // to its caller instead of chaining .then() itself; that caller's
  // aggregation point is coverage-wired and locked separately in
  // tests/detection-direct-dispatch-wiring.test.js.
  assert.equal(calls.length, 10);
  for (const match of calls) {
    // Look both a little before (opts/ds built ahead of the call) and after
    // (built inline in the .then callback, e.g. the Smart Bridge run path).
    // A call site may build it directly, or via the shared
    // _captureDetectionSettings helper (checked separately below) --
    // either counts as wired.
    const windowText = source.slice(Math.max(0, match.index - 400), match.index + 400);
    assert.ok(windowText.includes('_ccCoverageModelIds(') || windowText.includes('_captureDetectionSettings('),
      `no _ccCoverageModelIds(...)/_captureDetectionSettings(...) near byte ${match.index}`);
  }
});

test('_ccRunDetectionRuleset\'s per-rule loop (the "function(result) {" shape that used to be excluded) is wired for coverage', () => {
  const idx = source.indexOf("detectClashesAsync(s.models, merged).then(function(result) {");
  assert.notEqual(idx, -1, 'ruleset per-rule call site not found');
  const windowText = source.slice(Math.max(0, idx - 400), idx + 400);
  assert.ok(windowText.includes('_ccCoverageModelIds('), 'ruleset per-rule loop must fold its resolved scope into the coverage union');
});

test('window._ccRunDetection\'s call site (the other "function(result) {" shape) is wired for coverage', () => {
  const idx = source.indexOf("detectClashesAsync(s.models, runRules).then(function(result) {");
  assert.notEqual(idx, -1, 'window._ccRunDetection call site not found');
  const windowText = source.slice(Math.max(0, idx - 400), idx + 400);
  assert.ok(windowText.includes('_ccCoverageModelIds('), 'window._ccRunDetection must build coverageModelIds before committing');
});

test('the shared _captureDetectionSettings helper (used by runDetection + applyAndRun) builds coverageModelIds', () => {
  const body = slice('function _captureDetectionSettings(rules, models) {', 'function runDetection() {');
  assert.match(body, /coverageModelIds: _ccCoverageModelIds\(rules, models\)/);
});

test('the public ClashControl.runDetection() API builds coverageModelIds for its rulesOverride', () => {
  const body = slice('runDetection:     function(rulesOverride, opts){', 'benchEngine:');
  assert.match(body, /coverageModelIds: _ccCoverageModelIds\(r, st\.models\)/);
});
