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
    };
  `)();
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
