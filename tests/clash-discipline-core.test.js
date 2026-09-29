'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../clash-discipline-core');

// Frozen reference oracle — this IS the inline implementation that used to
// live in index.html before disciplineCoreV2 graduated to the sole
// implementation (see MEMORY.md Architecture Decisions). Kept here,
// deliberately duplicated rather than shared, so this test still catches
// any accidental drift in the extracted module against known-correct
// behavior — the whole point of characterization tests survives even
// though there's no more "legacy" code path in production to diff against.
const REF_TYPE_MAP = {};
(function() {
  var MEP = {IfcFlowSegment:1,IfcFlowFitting:1,IfcFlowTerminal:1,IfcFlowController:1,IfcFlowMovingDevice:1,IfcFlowStorageDevice:1,IfcFlowTreatmentDevice:1,IfcEnergyConversionDevice:1,IfcDistributionElement:1,IfcDistributionFlowElement:1,IfcDistributionControlElement:1,IfcDistributionChamberElement:1,IfcPipeSegment:1,IfcPipeFitting:1,IfcDuctSegment:1,IfcDuctFitting:1,IfcDuctSilencer:1,IfcCableCarrierSegment:1,IfcCableCarrierFitting:1,IfcCableSegment:1,IfcCableFitting:1,IfcJunctionBox:1,IfcAirTerminal:1,IfcAirTerminalBox:1,IfcSanitaryTerminal:1,IfcWasteTerminal:1,IfcStackTerminal:1,IfcValve:1,IfcPump:1,IfcTank:1,IfcBoiler:1,IfcChiller:1,IfcCoil:1,IfcCompressor:1,IfcCondenser:1,IfcCooledBeam:1,IfcCoolingTower:1,IfcFan:1,IfcFilter:1,IfcHeatExchanger:1,IfcHumidifier:1,IfcSpaceHeater:1,IfcUnitaryEquipment:1,IfcElectricAppliance:1,IfcElectricDistributionBoard:1,IfcElectricFlowStorageDevice:1,IfcElectricGenerator:1,IfcElectricMotor:1,IfcLamp:1,IfcLightFixture:1,IfcOutlet:1,IfcSwitchingDevice:1,IfcProtectiveDevice:1,IfcMotorConnection:1,IfcTransformer:1,IfcSensor:1,IfcActuator:1,IfcController:1,IfcAlarm:1,IfcMedicalDevice:1,IfcAudioVisualAppliance:1,IfcCommunicationsAppliance:1};
  var STR = {IfcBeam:1,IfcColumn:1,IfcFooting:1,IfcPile:1,IfcMember:1,IfcReinforcingBar:1,IfcReinforcingMesh:1,IfcReinforcingElement:1,IfcTendon:1,IfcTendonAnchor:1,IfcStructuralMember:1,IfcStructuralCurveMember:1,IfcStructuralSurfaceMember:1};
  var ARC = {IfcDoor:1,IfcWindow:1,IfcStair:1,IfcStairFlight:1,IfcRamp:1,IfcRampFlight:1,IfcRailing:1,IfcCovering:1,IfcCurtainWall:1,IfcFurnishingElement:1,IfcFurniture:1,IfcSystemFurnitureElement:1};
  var CIV = {IfcCivilElement:1,IfcPavement:1,IfcCourse:1,IfcKerb:1,IfcEarthworksElement:1,IfcEarthworksCut:1,IfcEarthworksFill:1,IfcBridge:1,IfcRoad:1,IfcAlignment:1,IfcGeotechnicalElement:1,IfcGeotechnicalStratum:1};
  Object.keys(MEP).forEach(function(t){ REF_TYPE_MAP[t]='mep'; });
  Object.keys(STR).forEach(function(t){ REF_TYPE_MAP[t]='structural'; });
  Object.keys(ARC).forEach(function(t){ REF_TYPE_MAP[t]='architectural'; });
  Object.keys(CIV).forEach(function(t){ REF_TYPE_MAP[t]='civil'; });
})();

function refElementDiscipline(el, modelDiscipline) {
  var t = (el && el.props && el.props.ifcType) || '';
  return REF_TYPE_MAP[t] || modelDiscipline || 'other';
}
function refDisciplinePairEnabled(discA, discB, rules) {
  var pairKey = discA < discB ? discA + ':' + discB : discB + ':' + discA;
  var dm = rules.disciplineMatrix;
  if (dm && dm[pairKey] !== undefined) return dm[pairKey] !== false;
  if (discA !== discB) return true;
  return rules.excludeSameDiscipline === false;
}
function refMatrixSkipsSameDiscipline(eA, mA, eB, mB, sameModel, rules) {
  if (rules.duplicates || sameModel) return false;
  var dA = refElementDiscipline(eA, mA && mA.discipline);
  var dB = refElementDiscipline(eB, mB && mB.discipline);
  return !refDisciplinePairEnabled(dA, dB, rules);
}
// Name-hint tokens are checked BEFORE the element-class ratio, and as a
// whole-word *prefix* (not an anywhere substring) — see clash-discipline-
// core.js's detectDiscipline doc comment for why ("Architecture.ifc" being
// out-voted into 'structural' by a handful of IfcColumn/IfcBeam instances
// was the actual bug this reordering fixes).
var REF_NAME_HINTS = {
  architectural: ['arch','archi','architect','bouwkundig','ark'],
  mep: ['mep','hvac','w-inst','e-inst','installatie','sanitair','elektra','plumbing','electrical'],
  structural: ['str','struct','constr','constructie','beton'],
  civil: ['civi','terrein','infra','wegen','bridge','gww','maaiveld']
};
function refNameHintMatches(nm, words, tokens) {
  return tokens.some(function(tok) {
    if (tok.indexOf('-') >= 0) return nm.indexOf(tok) >= 0;
    return words.some(function(w) { return w.lastIndexOf(tok, 0) === 0; });
  });
}
function refDetectDiscipline(elements, name) {
  var nm = (name||'').toLowerCase();
  if (nm) {
    var words = nm.split(/[^a-z0-9]+/).filter(Boolean);
    if (refNameHintMatches(nm, words, REF_NAME_HINTS.architectural)) return 'architectural';
    if (refNameHintMatches(nm, words, REF_NAME_HINTS.mep))           return 'mep';
    if (refNameHintMatches(nm, words, REF_NAME_HINTS.structural))    return 'structural';
    if (refNameHintMatches(nm, words, REF_NAME_HINTS.civil))         return 'civil';
  }
  var mep=0, str=0, arc=0, civ=0;
  (elements||[]).forEach(function(el){
    var t=(el.props&&el.props.ifcType)||'';
    var d=REF_TYPE_MAP[t];
    if(d==='mep')mep++; else if(d==='structural')str++; else if(d==='architectural')arc++; else if(d==='civil')civ++;
  });
  var total = mep+str+arc+civ;
  function lead(){ var m=Math.max(mep,str,arc,civ); return m===0?null:(m===mep?'mep':m===str?'structural':m===civ?'civil':'architectural'); }
  if (total >= 5 && Math.max(mep,str,arc,civ) >= total*0.5) return lead();
  return lead() || 'architectural';
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

test('element classification matches the reference oracle for every discriminating type and fallback', () => {
  assert.deepEqual(Object.keys(core.typeMap).sort(), Object.keys(REF_TYPE_MAP).sort());
  for (const type of Object.keys(core.typeMap)) {
    assert.equal(core.elementDiscipline(el(type), 'other'), refElementDiscipline(el(type), 'other'), type);
  }
  for (const type of ['IfcWall', 'IfcSlab', 'IfcSpace', 'IfcBuildingElementProxy', '', null]) {
    const value = type == null ? { props: {} } : el(type);
    for (const fallback of ['mep', 'structural', 'architectural', 'civil', null]) {
      assert.equal(core.elementDiscipline(value, fallback), refElementDiscipline(value, fallback), `${type}/${fallback}`);
    }
  }
});

test('model detection matches the reference oracle for votes, localized names and default', () => {
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
      assert.equal(core.detectDiscipline(elements, name), refDetectDiscipline(elements, name), `${elements.length}/${name}`);
    }
  }
});

test('matrix policy matches the reference oracle across precedence combinations', () => {
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
            refMatrixSkipsSameDiscipline(a, mA, b, mB, sameModel, rules)
          );
        }
      }
    }
  }
});

// Task C fixture-name regression: "Architecture.ifc" (and this repo's real
// tests/fixtures/office-architecture.ifc) used to auto-classify as
// 'structural' because the element-class ratio ran before the file-name
// hint, and a handful of IfcColumn/IfcBeam instances out-voted the (weak,
// shared-type) architectural signal — which silently zeroed a "Walls vs
// MEP" preset. File-name hints now run first.
test('file-name hints win over a misleading element-class ratio (fixture names)', () => {
  // A handful of structural-typed elements (columns/beams) alongside mostly
  // shared types (walls) — exactly the "Architecture.ifc → structural"
  // mis-classification this fix targets.
  const structDominantElements = [el('IfcBeam'), el('IfcBeam'), el('IfcColumn'), el('IfcBeam'), el('IfcColumn')];
  const fixtures = [
    ['office-architecture.ifc', 'architectural'],
    ['office-architecture', 'architectural'],
    ['Architecture.ifc', 'architectural'],
    ['ARK_bouwkundig_model.ifc', 'architectural'],
    ['project-archi-v3.ifc', 'architectural'],
    ['office-mep.ifc', 'mep'],
    ['HVAC_installatie.ifc', 'mep'],
    ['w-inst-01.ifc', 'mep'],
    ['e-inst-riser.ifc', 'mep'],
    ['sanitair_plan.ifc', 'mep'],
    ['elektra_verdieping1.ifc', 'mep'],
    ['plumbing-basement.ifc', 'mep'],
    ['electrical-mainboard.ifc', 'mep'],
    ['struct-model.ifc', 'structural'],
    ['constructie_fundering.ifc', 'structural'],
    ['beton_kelder.ifc', 'structural'],
    ['constr-v2.ifc', 'structural'],
  ];
  for (const [name, expected] of fixtures) {
    assert.equal(core.detectDiscipline(structDominantElements, name), expected, name);
    assert.equal(core.detectDiscipline(structDominantElements, name), refDetectDiscipline(structDominantElements, name), name);
  }
});

test('file-name hints do not false-positive on unrelated words containing a short token', () => {
  // "mark" contains "ark" as a substring but is not a whole-word *prefix*
  // match for the "ark" (architectural) hint, so a clearly MEP-dominated
  // model named "mark-revision-2.ifc" still classifies as mep via the
  // element-class ratio, not architectural via a spurious "ark" hit.
  const mepDominant = [el('IfcDuctSegment'), el('IfcDuctSegment'), el('IfcDuctSegment'), el('IfcDuctSegment'), el('IfcDuctSegment')];
  assert.equal(core.detectDiscipline(mepDominant, 'mark-revision-2.ifc'), 'mep');
});

test('pair-cell policy matches the reference oracle and does not mutate rules', () => {
  const disciplines = ['mep', 'structural', 'architectural', 'civil', 'other'];
  const rules = { excludeSameDiscipline: true, disciplineMatrix: { 'architectural:mep': false, 'structural:structural': true } };
  const before = JSON.stringify(rules);
  for (const a of disciplines) for (const b of disciplines) {
    assert.equal(core.disciplinePairEnabled(a, b, rules), refDisciplinePairEnabled(a, b, rules));
  }
  assert.equal(JSON.stringify(rules), before);
});
