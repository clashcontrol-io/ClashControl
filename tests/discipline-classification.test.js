'use strict';
// Locks _DISC_TYPE_MAP / _ccElementDiscipline / _ccMatrixSkipsSameDiscipline /
// detectDiscipline (index.html): the foundation Wave 1's clash matrix and
// severity model are built on. Extracted the same way tests/ifc-units.test.js
// pulls a slice out of the inline script - this slice is self-contained pure
// logic (no DOM/THREE dependency).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('var _DISC_TYPE_MAP = {};');
assert.ok(start !== -1, '_DISC_TYPE_MAP not found');
const end = src.indexOf('window._ccDetectDiscipline = detectDiscipline;', start);
assert.ok(end !== -1, 'detectDiscipline not found');
const closeIdx = end + 'window._ccDetectDiscipline = detectDiscipline;'.length;
const _window = {};
new Function('window', src.slice(start, closeIdx))(_window);
const _ccElementDiscipline = _window._ccElementDiscipline;
const _ccMatrixSkipsSameDiscipline = _window._ccMatrixSkipsSameDiscipline;
const detectDiscipline = _window._ccDetectDiscipline;
assert.equal(typeof _ccElementDiscipline, 'function');
assert.equal(typeof _ccMatrixSkipsSameDiscipline, 'function');
assert.equal(typeof detectDiscipline, 'function');

function el(ifcType) { return { props: { ifcType: ifcType } }; }

test('discriminating IfcTypes classify by type regardless of model discipline', () => {
  assert.equal(_ccElementDiscipline(el('IfcDuctSegment'), 'architectural'), 'mep');
  assert.equal(_ccElementDiscipline(el('IfcBeam'), 'mep'), 'structural');
  assert.equal(_ccElementDiscipline(el('IfcDoor'), 'structural'), 'architectural');
  assert.equal(_ccElementDiscipline(el('IfcPavement'), 'architectural'), 'civil');
});

test('non-discriminating IfcTypes (walls, slabs, spaces) inherit the model discipline', () => {
  assert.equal(_ccElementDiscipline(el('IfcWall'), 'structural'), 'structural');
  assert.equal(_ccElementDiscipline(el('IfcSlab'), 'mep'), 'mep');
  assert.equal(_ccElementDiscipline(el('IfcSpace'), 'architectural'), 'architectural');
});

test('unknown type and no model discipline falls back to other', () => {
  assert.equal(_ccElementDiscipline(el('IfcBuildingElementProxy'), null), 'other');
  assert.equal(_ccElementDiscipline({ props: {} }, undefined), 'other');
});

test('a combined model (structure + MEP in one IFC) classifies elements correctly per-element, not by whole-file vote', () => {
  // detectDiscipline would give this whole model ONE label (majority vote across
  // discriminating types) - that's the exact gap Wave 1 needed per-element
  // classification to close. Confirm _ccElementDiscipline does NOT collapse to
  // the model-wide vote for discriminating elements even when the model itself
  // votes a different way.
  const elements = [el('IfcDuctSegment'), el('IfcDuctSegment'), el('IfcDuctSegment'), el('IfcDuctSegment'), el('IfcDuctSegment'),
                     el('IfcBeam')];
  const modelDiscipline = detectDiscipline(elements, 'combined-model'); // will be 'mep' (5 vs 1)
  assert.equal(modelDiscipline, 'mep');
  // The lone beam is still structural, not swept into the model's mep vote.
  assert.equal(_ccElementDiscipline(elements[5], modelDiscipline), 'structural');
  // A wall in that same model (non-discriminating) DOES inherit the model vote.
  assert.equal(_ccElementDiscipline(el('IfcWall'), modelDiscipline), 'mep');
});

test('detectDiscipline behavior is unchanged by the refactor (majority vote, name fallback, architectural default)', () => {
  const mepHeavy = [1, 2, 3, 4, 5].map(() => el('IfcDuctSegment'));
  assert.equal(detectDiscipline(mepHeavy, ''), 'mep');
  assert.equal(detectDiscipline([], 'HVAC installatie'), 'mep');
  assert.equal(detectDiscipline([], 'Constructie model'), 'structural');
  assert.equal(detectDiscipline([], 'Terrein infra'), 'civil');
  assert.equal(detectDiscipline([], ''), 'architectural');
});

// ── _ccMatrixSkipsSameDiscipline — the default clash matrix's core decision ──

function mdl(id, discipline) { return { id: id, discipline: discipline }; }

test('same-discipline pairs are skipped by default', () => {
  const rules = { excludeSameDiscipline: true };
  assert.equal(_ccMatrixSkipsSameDiscipline(el('IfcBeam'), mdl('a', 'structural'), el('IfcColumn'), mdl('b', 'structural'), rules), true);
});

test('cross-discipline pairs are never skipped', () => {
  const rules = { excludeSameDiscipline: true };
  assert.equal(_ccMatrixSkipsSameDiscipline(el('IfcDuctSegment'), mdl('a', 'mep'), el('IfcBeam'), mdl('b', 'structural'), rules), false);
});

test('excludeSameDiscipline===false (future matrix-UI toggle) re-enables same-discipline testing', () => {
  const rules = { excludeSameDiscipline: false };
  assert.equal(_ccMatrixSkipsSameDiscipline(el('IfcBeam'), mdl('a', 'structural'), el('IfcColumn'), mdl('b', 'structural'), rules), false);
});

test('excludeSameDiscipline is absent (pre-existing saved rules objects) defaults to skipping, same as true', () => {
  const rules = {}; // simulates a rules object saved before this field existed
  assert.equal(_ccMatrixSkipsSameDiscipline(el('IfcBeam'), mdl('a', 'structural'), el('IfcColumn'), mdl('b', 'structural'), rules), true);
});

test('REGRESSION: rules.duplicates exempts the matrix entirely, even for same-discipline pairs', () => {
  // Caught before commit: duplicate detection (two copy-pasted ducts) is
  // almost always a same-discipline pair, and runs independently of hard/soft
  // inside _processCandidate. Without this exemption the matrix would return
  // true here and _processCandidate would `return` before ever reaching the
  // rules.duplicates branch - silently breaking "Include duplicate hits" for
  // every same-discipline duplicate, which is the overwhelming majority of them.
  const rules = { excludeSameDiscipline: true, duplicates: true };
  assert.equal(_ccMatrixSkipsSameDiscipline(el('IfcDuctSegment'), mdl('a', 'mep'), el('IfcDuctSegment'), mdl('b', 'mep'), rules), false);
});

test('non-discriminating elements resolve through their model discipline before comparing', () => {
  const rules = { excludeSameDiscipline: true };
  // Two walls, one in a structural model, one in an architectural model -
  // different disciplines via the model fallback, so NOT skipped.
  assert.equal(_ccMatrixSkipsSameDiscipline(el('IfcWall'), mdl('a', 'structural'), el('IfcWall'), mdl('b', 'architectural'), rules), false);
  // Same two walls, both in structural models - skipped.
  assert.equal(_ccMatrixSkipsSameDiscipline(el('IfcWall'), mdl('a', 'structural'), el('IfcWall'), mdl('b', 'structural'), rules), true);
});
