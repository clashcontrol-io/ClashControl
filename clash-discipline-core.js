(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashDisciplineCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Pure clash-discipline policy extracted from index.html. Shared IFC types
  // (walls, slabs, roofs, spaces and proxies) are deliberately absent so they
  // continue to inherit the containing model's detected discipline.
  var TYPE_MAP = {};
  var MEP = {IfcFlowSegment:1,IfcFlowFitting:1,IfcFlowTerminal:1,IfcFlowController:1,IfcFlowMovingDevice:1,IfcFlowStorageDevice:1,IfcFlowTreatmentDevice:1,IfcEnergyConversionDevice:1,IfcDistributionElement:1,IfcDistributionFlowElement:1,IfcDistributionControlElement:1,IfcDistributionChamberElement:1,IfcPipeSegment:1,IfcPipeFitting:1,IfcDuctSegment:1,IfcDuctFitting:1,IfcDuctSilencer:1,IfcCableCarrierSegment:1,IfcCableCarrierFitting:1,IfcCableSegment:1,IfcCableFitting:1,IfcJunctionBox:1,IfcAirTerminal:1,IfcAirTerminalBox:1,IfcSanitaryTerminal:1,IfcWasteTerminal:1,IfcStackTerminal:1,IfcValve:1,IfcPump:1,IfcTank:1,IfcBoiler:1,IfcChiller:1,IfcCoil:1,IfcCompressor:1,IfcCondenser:1,IfcCooledBeam:1,IfcCoolingTower:1,IfcFan:1,IfcFilter:1,IfcHeatExchanger:1,IfcHumidifier:1,IfcSpaceHeater:1,IfcUnitaryEquipment:1,IfcElectricAppliance:1,IfcElectricDistributionBoard:1,IfcElectricFlowStorageDevice:1,IfcElectricGenerator:1,IfcElectricMotor:1,IfcLamp:1,IfcLightFixture:1,IfcOutlet:1,IfcSwitchingDevice:1,IfcProtectiveDevice:1,IfcMotorConnection:1,IfcTransformer:1,IfcSensor:1,IfcActuator:1,IfcController:1,IfcAlarm:1,IfcMedicalDevice:1,IfcAudioVisualAppliance:1,IfcCommunicationsAppliance:1};
  var STR = {IfcBeam:1,IfcColumn:1,IfcFooting:1,IfcPile:1,IfcMember:1,IfcReinforcingBar:1,IfcReinforcingMesh:1,IfcReinforcingElement:1,IfcTendon:1,IfcTendonAnchor:1,IfcStructuralMember:1,IfcStructuralCurveMember:1,IfcStructuralSurfaceMember:1};
  var ARC = {IfcDoor:1,IfcWindow:1,IfcStair:1,IfcStairFlight:1,IfcRamp:1,IfcRampFlight:1,IfcRailing:1,IfcCovering:1,IfcCurtainWall:1,IfcFurnishingElement:1,IfcFurniture:1,IfcSystemFurnitureElement:1};
  var CIV = {IfcCivilElement:1,IfcPavement:1,IfcCourse:1,IfcKerb:1,IfcEarthworksElement:1,IfcEarthworksCut:1,IfcEarthworksFill:1,IfcBridge:1,IfcRoad:1,IfcAlignment:1,IfcGeotechnicalElement:1,IfcGeotechnicalStratum:1};
  Object.keys(MEP).forEach(function(t){ TYPE_MAP[t]='mep'; });
  Object.keys(STR).forEach(function(t){ TYPE_MAP[t]='structural'; });
  Object.keys(ARC).forEach(function(t){ TYPE_MAP[t]='architectural'; });
  Object.keys(CIV).forEach(function(t){ TYPE_MAP[t]='civil'; });
  Object.freeze(TYPE_MAP);

  function elementDiscipline(el, modelDiscipline) {
    var t = (el && el.props && el.props.ifcType) || '';
    return TYPE_MAP[t] || modelDiscipline || 'other';
  }

  function disciplinePairEnabled(discA, discB, rules) {
    var pairKey = discA < discB ? discA+':'+discB : discB+':'+discA;
    var dm = rules.disciplineMatrix;
    if (dm && dm[pairKey] !== undefined) return dm[pairKey] !== false;
    if (discA !== discB) return true;
    return rules.excludeSameDiscipline === false;
  }

  function matrixSkipsSameDiscipline(eA, mA, eB, mB, sameModel, rules) {
    if (rules.duplicates || sameModel) return false;
    var dA = elementDiscipline(eA, mA && mA.discipline);
    var dB = elementDiscipline(eB, mB && mB.discipline);
    return !disciplinePairEnabled(dA, dB, rules);
  }

  // File-name hint tokens, checked as a whole-*word prefix* (not an
  // anywhere-substring): "architecture" matches the "arch"/"archi"/
  // "architect" tokens because the word "architecture" *starts with* them,
  // but an unrelated word like "mark" does NOT match the "ark" token,
  // because "mark" doesn't start with "ark". Hyphenated tokens (w-inst,
  // e-inst) are matched against the raw (unsplit) name instead, since
  // splitting on '-' would tear them apart.
  var NAME_HINTS = {
    architectural: ['arch','archi','architect','bouwkundig','ark'],
    mep: ['mep','hvac','w-inst','e-inst','installatie','sanitair','elektra','plumbing','electrical'],
    structural: ['str','struct','constr','constructie','beton'],
    civil: ['civi','terrein','infra','wegen','bridge','gww','maaiveld']
  };

  function _nameHintMatches(nm, words, tokens) {
    return tokens.some(function(tok) {
      if (tok.indexOf('-') >= 0) return nm.indexOf(tok) >= 0;
      return words.some(function(w) { return w.lastIndexOf(tok, 0) === 0; }); // w.startsWith(tok)
    });
  }

  // File-name hints are checked BEFORE the element-class ratio (below):
  // a model named "Architecture.ifc" that happens to be dominated by shared
  // types (walls/slabs) with only a handful of typed elements should not
  // get out-voted into 'structural' by a handful of IfcColumn/IfcBeam
  // instances — the author's own naming is the stronger signal. The ratio
  // heuristic is the fallback for files with no recognizable naming
  // convention at all.
  function detectDiscipline(elements, name) {
    var nm = (name||'').toLowerCase();
    if (nm) {
      var words = nm.split(/[^a-z0-9]+/).filter(Boolean);
      if (_nameHintMatches(nm, words, NAME_HINTS.architectural)) return 'architectural';
      if (_nameHintMatches(nm, words, NAME_HINTS.mep))           return 'mep';
      if (_nameHintMatches(nm, words, NAME_HINTS.structural))    return 'structural';
      if (_nameHintMatches(nm, words, NAME_HINTS.civil))         return 'civil';
    }
    var mep=0, str=0, arc=0, civ=0;
    (elements||[]).forEach(function(el){
      var t=(el.props&&el.props.ifcType)||'';
      var d=TYPE_MAP[t];
      if(d==='mep')mep++; else if(d==='structural')str++; else if(d==='architectural')arc++; else if(d==='civil')civ++;
    });
    var total = mep+str+arc+civ;
    function lead(){ var m=Math.max(mep,str,arc,civ); return m===0?null:(m===mep?'mep':m===str?'structural':m===civ?'civil':'architectural'); }
    if (total >= 5 && Math.max(mep,str,arc,civ) >= total*0.5) return lead();
    return lead() || 'architectural';
  }

  return Object.freeze({
    contractVersion: 1,
    typeMap: TYPE_MAP,
    elementDiscipline: elementDiscipline,
    disciplinePairEnabled: disciplinePairEnabled,
    matrixSkipsSameDiscipline: matrixSkipsSameDiscipline,
    detectDiscipline: detectDiscipline
  });
}));
