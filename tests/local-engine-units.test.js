'use strict';

// Regression lock for the local-engine mm/metres double-scaling bug: the
// Engine (clashcontrol_engine/engine.py, verified 2026-07-21) returns
// `distance` already in millimetres — a prior version of
// addons/local-engine.js re-multiplied that by 1000, turning a real 10mm
// penetration into 10,000mm. Also locks the capability gate and the
// client-side rule-filter recovery added alongside the fix — see the
// wire-contract comment block in addons/local-engine.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'addons', 'local-engine.js'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'start marker not found: ' + startMarker);
  assert.notEqual(end, -1, 'end marker not found: ' + endMarker);
  return source.slice(start, end);
}

// _clashFromEngineResult, _localEngineCanHandle and _applyClientSideRuleFilters
// are contiguous in the file — extract them as one block and expose all three.
const block = extract(
  'function _clashFromEngineResult(c, elA, elB, mA, mB, rules) {',
  '\n  function _detectOnLocalEngine('
);

function loadApi() {
  return new Function(`
    ${block}
    return {
      clashFromEngineResult: _clashFromEngineResult,
      localEngineCanHandle: _localEngineCanHandle,
      applyClientSideRuleFilters: _applyClientSideRuleFilters,
      normalizeModelScope: _normalizeModelScope,
    };
  `)();
}

// A stand-in for index.html's _ccResolveModelScope, so scope-normalization is
// tested against the real selector semantics without a browser. Mirrors the
// subset the tests exercise: 'all', exact id/name, and case-insensitive
// substring on name.
function makeResolver(models) {
  return function resolve(_models, id) {
    if (id === 'all') return _models;
    if (Array.isArray(id)) {
      const seen = {}, out = [];
      id.forEach((sub) => resolve(_models, sub).forEach((m) => { if (!seen[m.id]) { seen[m.id] = true; out.push(m); } }));
      return out;
    }
    const exact = _models.filter((m) => m.id === id || m.name === id);
    if (exact.length) return exact;
    if (typeof id === 'string' && id) {
      const needle = id.toLowerCase();
      return _models.filter((m) => (m.name || '').toLowerCase().indexOf(needle) >= 0);
    }
    return [];
  };
}

function makeElement(expressId, ifcType, extra) {
  return Object.assign({expressId: expressId, props: Object.assign({ifcType: ifcType}, extra)}, {});
}

const modelA = {id: 'mA', name: 'Model A', discipline: 'structural'};
const modelB = {id: 'mB', name: 'Model B', discipline: 'mep'};

test('local-engine: hard-clash penetration distance is read as mm, not re-scaled', () => {
  const api = loadApi();
  const elA = makeElement(1, 'IfcWall');
  const elB = makeElement(2, 'IfcPipeSegment');
  // Engine wire format: -10 means a real 10mm penetration (already mm).
  const c = {type: 'hard', distance: -10, point: [0, 1, 0], volume: null};
  const clash = api.clashFromEngineResult(c, elA, elB, modelA, modelB, {mode: 'hard'});
  assert.equal(clash.distance, -10, 'a 10mm penetration must be reported as -10mm, not -10000mm');
});

test('local-engine: soft-clash clearance distance is read as mm, not re-scaled', () => {
  const api = loadApi();
  const elA = makeElement(1, 'IfcWall');
  const elB = makeElement(2, 'IfcDuctSegment');
  const c = {type: 'soft', distance: 25, point: [0, 1, 0], volume: 0};
  const clash = api.clashFromEngineResult(c, elA, elB, modelA, modelB, {mode: 'soft'});
  assert.equal(clash.distance, 25, 'a 25mm clearance must be reported as 25mm, not 25,000mm');
  assert.equal(clash.clearanceMm, 25);
});

test('local-engine: surface-touching hard clash (distance 0) reports as -1 (touching), not 0/-0', () => {
  const api = loadApi();
  const elA = makeElement(1, 'IfcWall');
  const elB = makeElement(2, 'IfcSlab');
  const c = {type: 'hard', distance: 0, point: [0, 1, 0]};
  const clash = api.clashFromEngineResult(c, elA, elB, modelA, modelB, {mode: 'hard'});
  assert.equal(clash.distance, -1);
});

test('local-engine capability gate: rejects duplicates (unsupported engine-side)', () => {
  const api = loadApi();
  const cap = api.localEngineCanHandle({duplicates: true});
  assert.equal(cap.ok, false);
});

test('local-engine capability gate: rejects a deliberately-configured minOverlapVolM3', () => {
  const api = loadApi();
  const cap = api.localEngineCanHandle({minOverlapVolM3: 0.01});
  assert.equal(cap.ok, false);
});

test('local-engine capability gate: allows the shipped default minOverlapVolM3 epsilon', () => {
  const api = loadApi();
  const cap = api.localEngineCanHandle({minOverlapVolM3: 1e-5});
  assert.equal(cap.ok, true);
});

test('local-engine capability gate: allows a plain hard/soft ruleset with no unsupported fields', () => {
  const api = loadApi();
  const cap = api.localEngineCanHandle({hard: true, maxGap: 50});
  assert.equal(cap.ok, true);
});

test('local-engine client-side filters: excludeSelf drops self-clashes the engine still returned', () => {
  // CORRECTED 2026-09-07 (post-review): a prior version of this file
  // removed this check on the theory that the engine's broad phase
  // (sweep.py) already drops same-model pairs. That was verified FALSE by
  // running the real sweep_and_prune against the shipped default scope
  // (modelA/modelB both 'all', so engine.py sends elements_a is elements_b
  // -- sweep.py's same_set branch only drops an element against itself,
  // never a same-MODEL pair). This client-side check is the ONLY place
  // "cross-model only" is ever enforced on the local engine path.
  const api = loadApi();
  const selfClash = {selfClash: true, elemAType: 'IfcWall', elemBType: 'IfcWall', type: 'hard', distance: -5};
  const otherClash = {selfClash: false, elemAType: 'IfcWall', elemBType: 'IfcPipeSegment', type: 'hard', distance: -5};
  const out = api.applyClientSideRuleFilters([selfClash, otherClash], {excludeSelf: true});
  assert.deepEqual(out, [otherClash]);
});

test('local-engine client-side filters: excludeTypes drops clashes touching an excluded type', () => {
  const api = loadApi();
  const clashes = [
    {elemAType: 'IfcWall', elemBType: 'IfcSpace', type: 'hard', distance: -5},
    {elemAType: 'IfcWall', elemBType: 'IfcPipeSegment', type: 'hard', distance: -5},
  ];
  const out = api.applyClientSideRuleFilters(clashes, {excludeTypes: ['IfcSpace']});
  assert.equal(out.length, 1);
  assert.equal(out[0].elemBType, 'IfcPipeSegment');
});

test('local-engine client-side filters: excludeTypePairs drops the matching pair regardless of side order', () => {
  const api = loadApi();
  const clashes = [
    {elemAType: 'IfcDuctSegment', elemBType: 'IfcWall', type: 'hard', distance: -5},
    {elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'hard', distance: -5},
    {elemAType: 'IfcBeam', elemBType: 'IfcWall', type: 'hard', distance: -5},
  ];
  const out = api.applyClientSideRuleFilters(clashes, {excludeTypePairs: {'IfcDuctSegment:IfcWall': true}});
  assert.equal(out.length, 1);
  assert.equal(out[0].elemAType, 'IfcBeam');
});

test('local-engine client-side filters: minGap drops soft clashes closer than the floor, leaves hard clashes alone', () => {
  const api = loadApi();
  const clashes = [
    {elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'soft', distance: 5},
    {elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'soft', distance: 20},
    {elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'hard', distance: -5},
  ];
  const out = api.applyClientSideRuleFilters(clashes, {minGap: 10});
  assert.equal(out.length, 2);
  assert.ok(out.some((c) => c.type === 'hard'));
  assert.ok(out.some((c) => c.type === 'soft' && c.distance === 20));
});

test('local-engine client-side filters: toleranceByTypePair tightens below the global maxGap', () => {
  const api = loadApi();
  const clashes = [
    {elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'soft', distance: 30},
    {elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'soft', distance: 5},
  ];
  const out = api.applyClientSideRuleFilters(clashes, {
    maxGap: 50,
    toleranceByTypePair: {'IfcDuctSegment:IfcWall': 10},
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].distance, 5);
});

test('local-engine client-side filters: a wider per-pair tolerance than maxGap is left as-is (can\'t recover missing distances)', () => {
  const api = loadApi();
  const clashes = [
    {elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'soft', distance: 30},
  ];
  const out = api.applyClientSideRuleFilters(clashes, {
    maxGap: 50,
    toleranceByTypePair: {'IfcDuctSegment:IfcWall': 100},
  });
  assert.equal(out.length, 1, 'must not drop a clash just because the per-pair tolerance is wider than maxGap');
});

// ── Contract-realistic excludeTypePairs (V7_RELEASE_PLAN P0.5) ─────────────
// INIT.rules ships excludeTypePairs as an ARRAY of "typeA:typeB" key strings
// (index.html:1274) and the browser engine consumes it as an array
// (index.html _exPairSet). A prior filter indexed the array as a map
// (arr[key]) — always undefined — so it silently never fired.
test('local-engine client-side filters: excludeTypePairs as an ARRAY (the real INIT shape) drops the matching pair', () => {
  const api = loadApi();
  const clashes = [
    {elemAType: 'IfcDuctSegment', elemBType: 'IfcWall', type: 'hard', distance: -5},
    {elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'hard', distance: -5},
    {elemAType: 'IfcBeam', elemBType: 'IfcWall', type: 'hard', distance: -5},
  ];
  const out = api.applyClientSideRuleFilters(clashes, {excludeTypePairs: ['IfcDuctSegment:IfcWall']});
  assert.equal(out.length, 1, 'array-shaped excludeTypePairs must actually filter');
  assert.equal(out[0].elemAType, 'IfcBeam');
});

test('local-engine client-side filters: an empty excludeTypePairs array drops nothing', () => {
  const api = loadApi();
  const clashes = [{elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', type: 'hard', distance: -5}];
  const out = api.applyClientSideRuleFilters(clashes, {excludeTypePairs: []});
  assert.equal(out.length, 1);
});

// ── Capability gate: fail-closed cases (V7_RELEASE_PLAN P0.3/P0.4) ─────────
test('local-engine capability gate: rejects change-aware detection (engine has no per-run hash baseline)', () => {
  const api = loadApi();
  assert.equal(api.localEngineCanHandle({changeAware: true}).ok, false);
});

test('local-engine capability gate: rejects semantic filtering when self-clashes are kept and a model carries relationship data', () => {
  const api = loadApi();
  const models = [{id: 'mA', relatedPairs: {}}, {id: 'mB', relatedPairs: {123: [456]}}];
  // excludeSelf falsy → same-model pairs are kept → the semantic skip can change
  // the result → must fall back to the browser engine.
  assert.equal(api.localEngineCanHandle({useSemanticFilter: true, excludeSelf: false}, models).ok, false);
});

test('local-engine capability gate: allows semantic filtering on a DEFAULT run (excludeSelf on drops the same-model pairs it would affect)', () => {
  const api = loadApi();
  const models = [{id: 'mA', relatedPairs: {}}, {id: 'mB', relatedPairs: {123: [456]}}];
  // The shipped default: excludeSelf:true + useSemanticFilter:true. Same-model
  // pairs are dropped anyway, so the semantic filter is a no-op → local is safe.
  assert.equal(api.localEngineCanHandle({useSemanticFilter: true, excludeSelf: true}, models).ok, true);
});

test('local-engine capability gate: allows semantic filtering when no model carries relationship data (no-op)', () => {
  const api = loadApi();
  const models = [{id: 'mA', relatedPairs: {}}, {id: 'mB'}];
  assert.equal(api.localEngineCanHandle({useSemanticFilter: true}, models).ok, true);
});

test('local-engine capability gate: rejects a per-pair tolerance wider than the global maxGap', () => {
  const api = loadApi();
  const cap = api.localEngineCanHandle({maxGap: 50, toleranceByTypePair: {'IfcDuctSegment:IfcWall': 100}});
  assert.equal(cap.ok, false);
});

test('local-engine capability gate: allows a per-pair tolerance narrower than the global maxGap (recoverable)', () => {
  const api = loadApi();
  const cap = api.localEngineCanHandle({maxGap: 50, toleranceByTypePair: {'IfcDuctSegment:IfcWall': 10}});
  assert.equal(cap.ok, true);
});

// ── Self-clash policy divergence (CLAUDE.md Item 5) ─────────────────────────
// The engine understands exactly one global excludeSelf boolean. The browser's
// _sweepAndPrune/_sweepAndPruneWasm resolve a genuinely per-model policy that
// can diverge from that single boolean two ways -- both must fail closed
// rather than silently return a different result set on the local engine.
test('local-engine capability gate: an effective single-model scope routes to the browser engine (self-clashes are always included there)', () => {
  const api = loadApi();
  const models = [{id: 'only'}];
  // 'all' vs 'all' with a single loaded model: the browser's own
  // _sweepAndPrune ALWAYS allows self-clashes here regardless of
  // rules.excludeSelf (otherwise "cross-model only" on one federated file
  // would report 0 by construction) -- the engine has no such override.
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: true}, models).ok, false);
  // True regardless of the nominal excludeSelf value -- it's the SCOPE that
  // makes this inexpressible, not which boolean was requested.
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: false}, models).ok, false);
});

test('local-engine capability gate: selfClashModels naming a specific subset routes to the browser engine', () => {
  const api = loadApi();
  const models = [{id: 'mA'}, {id: 'mB'}];
  // index.html sets excludeSelf:false whenever selfClashModels is a non-empty
  // array (see the UI wiring near A.UPD_RULES) -- sent raw, the engine would
  // include EVERY model's self-clashes, not just the named one(s).
  const cap = api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: false, selfClashModels: ['mA']}, models);
  assert.equal(cap.ok, false);
  const capSingleId = api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: false, selfClashModels: 'mA'}, models);
  assert.equal(capSingleId.ok, false);
});

test('local-engine capability gate: selfClashModels "all"/"none" ARE expressible as one boolean and are let through', () => {
  const api = loadApi();
  const models = [{id: 'mA'}, {id: 'mB'}];
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: false, selfClashModels: 'all'}, models).ok, true);
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: true, selfClashModels: 'none'}, models).ok, true);
});

test('local-engine capability gate: a plain cross-model run (2+ models, no selfClashModels) is still allowed -- the fix must not be over-conservative', () => {
  const api = loadApi();
  const models = [{id: 'mA'}, {id: 'mB'}];
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: true}, models).ok, true);
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: false}, models).ok, true);
});

test('local-engine capability gate: selfClashGroup "a"/"b" with 2+ models routes to the browser engine', () => {
  // rules.selfClashGroup ('a'/'b', resolved per-model at index.html
  // _sweepAndPrune's `scg === 'a' && inA[cur.m.id]`) is reachable via the NL
  // converse flow and is equally per-model / inexpressible as one boolean.
  const api = loadApi();
  const models = [{id: 'mA'}, {id: 'mB'}];
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', selfClashGroup: 'a'}, models).ok, false);
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', selfClashGroup: 'b'}, models).ok, false);
});

test('local-engine capability gate: selfClashGroup "both" is expressible as one boolean and is let through', () => {
  const api = loadApi();
  const models = [{id: 'mA'}, {id: 'mB'}];
  assert.equal(api.localEngineCanHandle({modelA: 'all', modelB: 'all', excludeSelf: false, selfClashGroup: 'both'}, models).ok, true);
});

// ── Model-scope normalization (V7_RELEASE_PLAN P0.1) ───────────────────────
// The engine matches modelA/modelB by exact id (or 'all'); the browser resolves
// arrays/disc:/tag:/names/substrings. Normalize to 'all' | single-id, or fail
// closed for a multi-model subset the engine can't express.
test('local-engine scope: "all" normalizes to all with no resolver needed', () => {
  const api = loadApi();
  const models = [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}];
  assert.deepEqual(api.normalizeModelScope(models, 'all', null), {ok: true, value: 'all'});
  assert.deepEqual(api.normalizeModelScope(models, undefined, null), {ok: true, value: 'all'});
});

test('local-engine scope: a name selecting exactly one model normalizes to that model id', () => {
  const api = loadApi();
  const models = [{id: 'uuid-a', name: '[Link] Constructie.rvt'}, {id: 'uuid-b', name: 'Architectuur.ifc'}];
  const out = api.normalizeModelScope(models, 'Constructie', makeResolver(models));
  assert.deepEqual(out, {ok: true, value: 'uuid-a'});
});

test('local-engine scope: a selector matching every model normalizes to "all"', () => {
  const api = loadApi();
  const models = [{id: 'a', name: 'M1'}, {id: 'b', name: 'M2'}];
  const out = api.normalizeModelScope(models, ['M1', 'M2'], makeResolver(models));
  assert.deepEqual(out, {ok: true, value: 'all'});
});

test('local-engine scope: a multi-model subset the engine can\'t express fails closed', () => {
  const api = loadApi();
  const models = [{id: 'a', name: 'M1'}, {id: 'b', name: 'M2'}, {id: 'c', name: 'M3'}];
  const out = api.normalizeModelScope(models, ['M1', 'M2'], makeResolver(models));
  assert.equal(out.ok, false);
});

test('local-engine scope: a non-"all" selector with no resolver available fails closed', () => {
  const api = loadApi();
  const models = [{id: 'a', name: 'M1'}];
  assert.equal(api.normalizeModelScope(models, 'M1', null).ok, false);
});

// ── Wire-contract comment honesty (CLAUDE.md Item 5) ────────────────────────
test('the wire-contract comment no longer claims the Engine has no /status capability field', () => {
  assert.doesNotMatch(source, /has no \/status/i);
  assert.match(source, /PROTOCOL_VERSION/);
  assert.match(source, /CAPABILITIES/);
});

test('local-engine capability gate: a multi-model-subset scope routes to the browser engine', () => {
  const api = loadApi();
  // No window._ccResolveModelScope in node → a non-'all' scope can't be verified
  // and must fail closed (the runtime always has the resolver; this locks the
  // conservative fallback).
  const cap = api.localEngineCanHandle({modelA: 'disc:mep', modelB: 'all'}, [{id: 'a'}, {id: 'b'}]);
  assert.equal(cap.ok, false);
});

// ── _detectOnLocalEngine reads stats.incomplete (CLAUDE.md Items 1/3, R4) ──
// The engine advertises stats.completed/failed/incomplete/sampleError
// (Item 3), but nothing on this side ever read it -- a run where every
// candidate pair failed narrow-phase came back as
// {clashes:[], stats:{incomplete:true}}, indistinguishable from a genuine
// "checked everything, found nothing" result. detectClashesAsync would tag
// that 'complete' and mergeDetectionResults would auto-resolve every prior
// open clash in scope: the exact failure-becomes-empty-success class Item 1
// exists to prevent, still fully live on the local-engine path.
function loadDetectOnLocalEngine() {
  // Starts at _applyClientSideRuleFilters, not _detectOnLocalEngine itself
  // -- the latter calls the former directly (`return
  // _applyClientSideRuleFilters(mapped, rules);`), and without it every
  // invocation throws a ReferenceError, caught by _detectOnLocalEngine's
  // own .catch(), which ALSO returns null -- silently making every test
  // below pass for the wrong reason. The two functions are contiguous in
  // the file (same as loadApi() above relies on).
  const start = source.indexOf('function _applyClientSideRuleFilters(clashes, rules) {');
  const end = source.indexOf('\n\n  window._checkLocalEngine', start);
  assert.notEqual(start, -1, '_applyClientSideRuleFilters not found');
  assert.notEqual(end, -1, '_detectOnLocalEngine end not found');
  const block = source.slice(start, end);
  const factory = new Function('window', 'fetch', 'WebSocket', 'Event', 'CustomEvent', 'console',
    '_serializeForLocalEngine', '_localEngineUrl', '_localEngineWsUrl', '_engineFetch', '_pairing', `
    ${block}
    return _detectOnLocalEngine;
  `);
  // The addon routes requests through `_engineFetch` (pairing-token aware) and
  // `_pairing`. Here pairing is absent -- the "engine predates pairing" path --
  // so `_engineFetch` is just the test's fake fetch, keeping every assertion
  // below about the clash logic, not the transport.
  return function(win, fetchFake, WS, Ev, CEv, cons, ser, url, wsUrl) {
    return factory(win, fetchFake, WS, Ev, CEv, cons, ser, url, wsUrl,
      function(path, init) { return fetchFake(url + path, init); }, null);
  };
}

function fakeFetch(jsonBody) {
  return function() { return Promise.resolve({ json: () => Promise.resolve(jsonBody) }); };
}

function noopWindow() {
  const events = [];
  return { win: { dispatchEvent(e) { events.push(e); } }, events };
}

test('_detectOnLocalEngine returns null (triggering the browser-engine fallback) when stats.incomplete is true', async () => {
  const factory = loadDetectOnLocalEngine();
  const { win } = noopWindow();
  const detectOnLocalEngine = factory(
    win,
    fakeFetch({ clashes: [], stats: { elementCount: 4, candidatePairs: 3, clashCount: 0, duration_ms: 5, threads: 1, completed: 0, failed: 3, incomplete: true, sampleError: 'ValueError: synthetic' } }),
    function FakeWebSocket() { this.close = () => {}; },
    function FakeEvent(type) { this.type = type; },
    function FakeCustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    console,
    () => ({ elements: [], rules: {} }),
    'http://fake', 'ws://fake'
  );
  const result = await detectOnLocalEngine([{ id: 'm', elements: [] }], {}, null);
  assert.equal(result, null, 'an incomplete engine run must fall back to the browser engine, not return its partial clashes as a success');
});

test('_detectOnLocalEngine still returns the clash array normally when the run genuinely completed', async () => {
  const factory = loadDetectOnLocalEngine();
  const { win } = noopWindow();
  const detectOnLocalEngine = factory(
    win,
    fakeFetch({ clashes: [], stats: { elementCount: 4, candidatePairs: 3, clashCount: 0, duration_ms: 5, threads: 1, completed: 3, failed: 0, incomplete: false } }),
    function FakeWebSocket() { this.close = () => {}; },
    function FakeEvent(type) { this.type = type; },
    function FakeCustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    console,
    () => ({ elements: [], rules: {} }),
    'http://fake', 'ws://fake'
  );
  const result = await detectOnLocalEngine([{ id: 'm', elements: [] }], {}, null);
  assert.deepEqual(result, [], 'a genuinely complete zero-clash run must still return normally, not fall back needlessly');
});

test('_detectOnLocalEngine treats a missing stats.incomplete (older/absent field) as complete -- back-compat with pre-Item-3 engine builds', async () => {
  const factory = loadDetectOnLocalEngine();
  const { win } = noopWindow();
  const detectOnLocalEngine = factory(
    win,
    fakeFetch({ clashes: [], stats: { elementCount: 0, candidatePairs: 0, clashCount: 0, duration_ms: 1, threads: 1 } }),
    function FakeWebSocket() { this.close = () => {}; },
    function FakeEvent(type) { this.type = type; },
    function FakeCustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    console,
    () => ({ elements: [], rules: {} }),
    'http://fake', 'ws://fake'
  );
  const result = await detectOnLocalEngine([{ id: 'm', elements: [] }], {}, null);
  assert.deepEqual(result, []);
});
