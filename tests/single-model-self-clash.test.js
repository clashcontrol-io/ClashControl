'use strict';
// Locks the "excludeSelf single-model trap" fix in _sweepAndPrune (index.html):
// rules.excludeSelf defaults to true, and the one-click "Run detection" button
// runs with whatever rules currently are. For a project with only ONE combined
// IFC model (very common - Revit/Navisworks-style federated export), grpA and
// grpB both resolve to that single model, so "cross-model only" always yields
// zero pairs by construction - not a real "no clashes" result, just a trap on
// the single most prominent first-run action. The fix forces self-clashes
// allowed whenever the effective scope collapses to one model, without
// touching the stored rules.excludeSelf value itself (multi-model behavior is
// unchanged).
// Extracted the same way tests/ifc-units.test.js pulls a slice out of the
// inline script - pure logic, no DOM/THREE dependency (boxes are plain
// {min:{x,y,z},max:{x,y,z}} objects, exactly what el.box already is).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('  function _sweepAndPrune(grpA, grpB, rules, maxGapM) {');
assert.ok(start !== -1, '_sweepAndPrune not found');
const end = src.indexOf('\n  }', start) + '\n  }'.length;
const _sweepAndPrune = new Function(src.slice(start, end) + '; return _sweepAndPrune;')();
assert.equal(typeof _sweepAndPrune, 'function');

function box(x, y, z, size) {
  size = size || 0.1;
  return { min: { x: x - size, y: y - size, z: z - size }, max: { x: x + size, y: y + size, z: z + size } };
}
function el(id, b) { return { expressId: id, box: b, props: { ifcType: 'IfcWall' } }; }
function model(id, elements) { return { id: id, elements: elements }; }

test('single model, two overlapping elements, default excludeSelf:true: the trap is fixed (pairs are still found)', () => {
  var m = model('m1', [el(1, box(0, 0, 0)), el(2, box(0.05, 0, 0))]); // overlapping boxes
  var rules = { excludeSelf: true, maxGap: 0 };
  var pairs = _sweepAndPrune([m], [m], rules, 0.2);
  assert.equal(pairs.length, 1, 'a real physical overlap in a single combined model must not be silently dropped');
});

test('two models, default excludeSelf:true: same-model pairs are still correctly excluded (no regression)', () => {
  var mA = model('mA', [el(1, box(0, 0, 0)), el(2, box(0.05, 0, 0))]); // overlapping, same model
  var mB = model('mB', [el(3, box(10, 10, 10))]); // far away, other model
  var rules = { excludeSelf: true, maxGap: 0 };
  var pairs = _sweepAndPrune([mA, mB], [mA, mB], rules, 0.2);
  assert.equal(pairs.length, 0, 'with a real second model in scope, excludeSelf:true must still suppress the same-model pair');
});

test('two models, excludeSelf:false: same-model pairs are still correctly included (no regression)', () => {
  var mA = model('mA', [el(1, box(0, 0, 0)), el(2, box(0.05, 0, 0))]);
  var mB = model('mB', [el(3, box(10, 10, 10))]);
  var rules = { excludeSelf: false, maxGap: 0 };
  var pairs = _sweepAndPrune([mA, mB], [mA, mB], rules, 0.2);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].sameModel, true);
});

test('single model scoped explicitly via modelA===modelB (both sides the same one model): also fixed', () => {
  // Mirrors an NL command or preset that resolves both sides to one specific
  // model id even though other models might be loaded elsewhere in the app -
  // the fix keys off the ACTUAL grpA/grpB union for this run, not just
  // "only one model loaded globally".
  var m = model('only', [el(1, box(0, 0, 0)), el(2, box(0.05, 0, 0))]);
  var rules = { excludeSelf: true, modelA: 'only', modelB: 'only', maxGap: 0 };
  var pairs = _sweepAndPrune([m], [m], rules, 0.2);
  assert.equal(pairs.length, 1);
});

test('single model, duplicates:true still works as before (unaffected by the fix)', () => {
  var m = model('m1', [el(1, box(0, 0, 0)), el(2, box(0, 0, 0))]); // exact duplicate position
  var rules = { excludeSelf: true, duplicates: true, hard: false, maxGap: 0 };
  var pairs = _sweepAndPrune([m], [m], rules, 0.2);
  assert.equal(pairs.length, 1, 'duplicates mode already bypassed selfAllowed and must still find the pair');
});

test('single model, non-overlapping elements: still correctly finds zero pairs (the fix does not force false positives)', () => {
  var m = model('m1', [el(1, box(0, 0, 0)), el(2, box(100, 100, 100))]);
  var rules = { excludeSelf: true, maxGap: 0 };
  var pairs = _sweepAndPrune([m], [m], rules, 0.2);
  assert.equal(pairs.length, 0);
});

test('selfClashGroup/selfClashModels overrides are bypassed too when scope is a single model (they would also be vacuous)', () => {
  var m = model('m1', [el(1, box(0, 0, 0)), el(2, box(0.05, 0, 0))]);
  var rules = { selfClashModels: 'none', maxGap: 0 };
  var pairs = _sweepAndPrune([m], [m], rules, 0.2);
  assert.equal(pairs.length, 1, 'selfClashModels:"none" is just as vacuous as excludeSelf:true with only one model in scope');
});
