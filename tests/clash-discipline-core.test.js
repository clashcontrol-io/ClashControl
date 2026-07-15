'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../clash-discipline-core');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function loadLegacy() {
  const start = source.indexOf('var _DISC_TYPE_MAP = {};');
  const end = source.indexOf('function ModelSidebar(props)', start);
  assert.ok(start >= 0 && end > start, 'legacy discipline adapter not found');
  const window = {};
  new Function('window', source.slice(start, end))(window);
  return {
    elementDiscipline: window._ccElementDiscipline,
    disciplinePairEnabled: window._ccDisciplinePairEnabled,
    matrixSkipsSameDiscipline: window._ccMatrixSkipsSameDiscipline,
    detectDiscipline: window._ccDetectDiscipline,
    status: window._ccDisciplineCoreStatus,
  };
}

function el(type) { return { props: { ifcType: type } }; }
function mdl(id, discipline) { return { id, discipline }; }

test('module exposes one immutable, side-effect-free contract', () => {
  assert.equal(core.contractVersion, 1);
  assert.equal(Object.isFrozen(core), true);
  assert.equal(Object.isFrozen(core.typeMap), true);
  assert.equal(typeof core.elementDiscipline, 'function');
  assert.equal(typeof core.disciplinePairEnabled, 'function');
  assert.equal(typeof core.matrixSkipsSameDiscipline, 'function');
  assert.equal(typeof core.detectDiscipline, 'function');
});

test('candidate element classification matches every legacy discriminating type and fallback', () => {
  const legacy = loadLegacy();
  assert.equal(legacy.status.active, false);
  for (const type of Object.keys(core.typeMap)) {
    assert.equal(core.elementDiscipline(el(type), 'other'), legacy.elementDiscipline(el(type), 'other'), type);
  }
  for (const type of ['IfcWall', 'IfcSlab', 'IfcSpace', 'IfcBuildingElementProxy', '', null]) {
    const value = type == null ? { props: {} } : el(type);
    for (const fallback of ['mep', 'structural', 'architectural', 'civil', null]) {
      assert.equal(core.elementDiscipline(value, fallback), legacy.elementDiscipline(value, fallback), `${type}/${fallback}`);
    }
  }
});

test('candidate model detection matches legacy votes, localized names and default', () => {
  const legacy = loadLegacy();
  const elementSets = [
    [],
    [el('IfcDuctSegment')],
    Array.from({ length: 5 }, () => el('IfcDuctSegment')),
    [el('IfcBeam'), el('IfcBeam'), el('IfcDoor'), el('IfcPavement'), el('IfcWall')],
    [el('IfcBeam'), el('IfcBeam'), el('IfcBeam'), el('IfcDuctSegment'), el('IfcDuctSegment')],
  ];
  const names = ['', 'HVAC installatie', 'Constructie model', 'Bouwkundig model', 'Terrein infra', 'unknown.ifc'];
  for (const elements of elementSets) {
    for (const name of names) {
      assert.equal(core.detectDiscipline(elements, name), legacy.detectDiscipline(elements, name), `${elements.length}/${name}`);
    }
  }
});

test('candidate matrix policy matches legacy across precedence combinations', () => {
  const legacy = loadLegacy();
  const elements = [el('IfcDuctSegment'), el('IfcBeam'), el('IfcDoor'), el('IfcWall')];
  const models = [mdl('a', 'mep'), mdl('b', 'structural'), mdl('c', 'architectural')];
  const rulesList = [
    {},
    { excludeSameDiscipline: true },
    { excludeSameDiscipline: false },
    { duplicates: true, excludeSameDiscipline: true },
    { disciplineMatrix: { 'architectural:mep': false, 'structural:structural': true } },
  ];
  for (const rules of rulesList) {
    for (const a of elements) for (const b of elements) {
      for (const mA of models) for (const mB of models) {
        for (const sameModel of [false, true]) {
          assert.equal(
            core.matrixSkipsSameDiscipline(a, mA, b, mB, sameModel, rules),
            legacy.matrixSkipsSameDiscipline(a, mA, b, mB, sameModel, rules)
          );
        }
      }
    }
  }
});

test('candidate pair-cell policy matches legacy and does not mutate rules', () => {
  const legacy = loadLegacy();
  const disciplines = ['mep', 'structural', 'architectural', 'civil', 'other'];
  const rules = { excludeSameDiscipline: true, disciplineMatrix: { 'architectural:mep': false, 'structural:structural': true } };
  const before = JSON.stringify(rules);
  for (const a of disciplines) for (const b of disciplines) {
    assert.equal(core.disciplinePairEnabled(a, b, rules), legacy.disciplinePairEnabled(a, b, rules));
  }
  assert.equal(JSON.stringify(rules), before);
});
