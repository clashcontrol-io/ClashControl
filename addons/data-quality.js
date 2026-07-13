// ── ClashControl Addon: Data Quality Check Engines ──────────────
// Contains all data quality, BIM model, and ILS/NL-SfB check logic.
// The UI panel (DataQualityPanel) remains in index.html and calls
// these engines via window._ccRunDataQualityChecks, etc.

(function() {
  'use strict';

  // ── General Data Quality Checks ──────────────────────────────────

  function runDataQualityChecks(elements) {
    var GENERIC_RE = /^(basic\s+)?(wall|floor|ceiling|roof|column|beam|slab|door|window|generic model|furniture|curtain wall|curtain panel|railing|stair|ramp|mass|component|panel|mullion|structural framing|structural column)(\s+[\d\-]+)?$/i;
    var OPENING = {IfcDoor:1, IfcWindow:1};
    var guidSeen = {};
    var acc = {proxy:[],genericName:[],noMaterial:[],noStorey:[],guidCollision:[],zeroLayers:[],unhostedOpenings:[],
      noGlobalId:[],emptyGeometry:[],duplicateName:[],noDescription:[],noProperties:[]};
    var hasHostData = (elements||[]).some(function(el){return el.props&&el.props.hostId;});
    var hasLayerData = (elements||[]).some(function(el){return el.props&&Array.isArray(el.props.layers)&&el.props.layers.length>0;});
    var nameCounts = {};
    (elements||[]).forEach(function(el) {
      var p = el.props||{};
      var n = (p.name||'').trim();
      if (n) { nameCounts[n] = (nameCounts[n]||0)+1; }
    });
    (elements||[]).forEach(function(el) {
      var p = el.props||{};
      var it = {name:p.name||('#'+el.expressId), gid:p.globalId, ifcType:p.ifcType, el:el};
      if (p.globalId) { if (guidSeen[p.globalId]) acc.guidCollision.push(it); else guidSeen[p.globalId]=true; }
      if (p.ifcType==='IfcBuildingElementProxy') acc.proxy.push(it);
      if (GENERIC_RE.test((p.name||'').trim())) acc.genericName.push(it);
      if (!p.material||!p.material.trim()) acc.noMaterial.push(it);
      if (!p.storey||!p.storey.trim()) acc.noStorey.push(it);
      if (hasLayerData&&Array.isArray(p.layers)&&p.layers.some(function(l){return typeof l==='object'&&l!==null&&(l.width===0||l.width==='0');})) acc.zeroLayers.push(it);
      if (hasHostData&&OPENING[p.ifcType]&&!p.hostId) acc.unhostedOpenings.push(it);
      if (!p.globalId || !p.globalId.trim()) acc.noGlobalId.push(it);
      if (el.meshes && el.meshes.length === 0) acc.emptyGeometry.push(it);
      var nm = (p.name||'').trim();
      if (nm && nameCounts[nm] > 5) acc.duplicateName.push(it);
      if (!p.description || !p.description.trim()) acc.noDescription.push(it);
      var hasPsets = p.psets && Object.keys(p.psets).some(function(g){var grp=p.psets[g];return grp&&typeof grp==='object'&&Object.keys(grp).length>0;});
      if (!hasPsets && !p.quantities) acc.noProperties.push(it);
    });
    var dupNameSeen = {};
    acc.duplicateName = acc.duplicateName.filter(function(it){
      if (dupNameSeen[it.name]) return false;
      dupNameSeen[it.name] = true;
      return true;
    });
    return {
      guidCollision:{label:'GlobalId collisions',                   sev:'error',count:acc.guidCollision.length,ex:acc.guidCollision.slice(0,6)},
      noGlobalId:  {label:'Missing GlobalId',                       sev:'error',count:acc.noGlobalId.length,  ex:acc.noGlobalId.slice(0,6)},
      proxy:       {label:'IfcBuildingElementProxy (unclassified)', sev:'warn', count:acc.proxy.length,       ex:acc.proxy.slice(0,6)},
      genericName: {label:'Generic element names',                  sev:'warn', count:acc.genericName.length, ex:acc.genericName.slice(0,6)},
      duplicateName:{label:'Non-unique element names (>5 same)',    sev:'warn', count:acc.duplicateName.length,ex:acc.duplicateName.slice(0,6)},
      noMaterial:  {label:'No material assigned',                   sev:'warn', count:acc.noMaterial.length,  ex:acc.noMaterial.slice(0,6)},
      noStorey:    {label:'No level/storey',                        sev:'warn', count:acc.noStorey.length,    ex:acc.noStorey.slice(0,6)},
      emptyGeometry:{label:'No geometry (invisible elements)',      sev:'warn', count:acc.emptyGeometry.length,ex:acc.emptyGeometry.slice(0,6)},
      zeroLayers:  {label:'Zero-thickness layers',                  sev:'warn', count:acc.zeroLayers.length,  ex:acc.zeroLayers.slice(0,6)},
      unhostedOpenings:{label:'Unhosted doors/windows',             sev:'warn', count:acc.unhostedOpenings.length,ex:acc.unhostedOpenings.slice(0,6)},
      noProperties:{label:'No property sets or quantities',         sev:'info', count:acc.noProperties.length,ex:acc.noProperties.slice(0,6)},
      noDescription:{label:'No description',                        sev:'info', count:acc.noDescription.length,ex:acc.noDescription.slice(0,6)},
      _total: (elements||[]).length
    };
  }

  // ── Enhanced BIM Model Checks ──────────────────────────────────────

  var BIM_PSET_MAP = {
    IfcWall:['Pset_WallCommon'], IfcWallStandardCase:['Pset_WallCommon'],
    IfcSlab:['Pset_SlabCommon'], IfcRoof:['Pset_RoofCommon'],
    IfcColumn:['Pset_ColumnCommon'], IfcBeam:['Pset_BeamCommon'],
    IfcDoor:['Pset_DoorCommon'], IfcWindow:['Pset_WindowCommon'],
    IfcCovering:['Pset_CoveringCommon'], IfcCurtainWall:['Pset_CurtainWallCommon'],
    IfcPlate:['Pset_PlateCommon'], IfcMember:['Pset_MemberCommon'],
    IfcRailing:['Pset_RailingCommon'], IfcStair:['Pset_StairCommon'],
    IfcRamp:['Pset_RampCommon'], IfcSpace:['Pset_SpaceCommon']
  };

  function runBIMModelChecks(elements) {
    var acc = {
      noFireRating:[], noIsExternal:[], noLoadBearing:[], noAssemblyCode:[],
      noClassification:[], thicknessMismatch:[], missingCommonPset:[],
      duplicateGlobalId:[], noObjectType:[], noTypeAssignment:[],
      invalidName:[], missingArea:[], missingVolume:[]
    };
    var dist = {
      isExternal:{}, loadBearing:{}, fireRating:{}, classification:{}, objectType:{}, material:{}, storey:{}
    };
    function addDist(key, val, el) {
      var v = (val==null||val==='')?'(not set)':String(val).trim();
      if (!dist[key][v]) dist[key][v] = [];
      dist[key][v].push({expressId:el.expressId, modelId:el._modelId, name:(el.props||{}).name||'#'+el.expressId, ifcType:(el.props||{}).ifcType||''});
    }
    var EXTERNAL_TYPES = {IfcWall:1,IfcWallStandardCase:1,IfcSlab:1,IfcRoof:1,IfcDoor:1,IfcWindow:1,IfcCurtainWall:1,IfcPlate:1};
    var LOADBEARING_TYPES = {IfcWall:1,IfcWallStandardCase:1,IfcSlab:1,IfcColumn:1,IfcBeam:1,IfcMember:1};
    var FIRE_TYPES = {IfcWall:1,IfcWallStandardCase:1,IfcSlab:1,IfcDoor:1,IfcColumn:1,IfcBeam:1,IfcCovering:1};
    var QUANTITY_TYPES = {IfcWall:1,IfcWallStandardCase:1,IfcSlab:1,IfcRoof:1,IfcColumn:1,IfcBeam:1,IfcPlate:1,IfcCovering:1,IfcSpace:1};
    var THICKNESS_RE = /(\d+)\s*(mm|cm|m)\b/i;

    (elements||[]).forEach(function(el) {
      var p = el.props||{};
      var it = {name:p.name||('#'+el.expressId), gid:p.globalId, ifcType:p.ifcType, el:el};
      var psets = p.psets||{};
      var quant = p.quantities||{};

      var commonPsetNames = BIM_PSET_MAP[p.ifcType]||[];
      var commonPset = null;
      commonPsetNames.forEach(function(cn) {
        Object.keys(psets).forEach(function(k) {
          if (k.toLowerCase() === cn.toLowerCase()) commonPset = psets[k];
        });
      });

      if (commonPsetNames.length > 0 && !commonPset) {
        acc.missingCommonPset.push(Object.assign({}, it, {detail: commonPsetNames[0]}));
      }

      // FireRating
      var fireVal = null;
      if (commonPset) {
        Object.keys(commonPset).forEach(function(k) {
          if (k.toLowerCase()==='firerating' && commonPset[k] && String(commonPset[k]).trim()) fireVal = String(commonPset[k]).trim();
        });
      }
      if (!fireVal) {
        Object.keys(psets).forEach(function(ps) {
          Object.keys(psets[ps]||{}).forEach(function(k) {
            if (k.toLowerCase()==='firerating' && psets[ps][k] && String(psets[ps][k]).trim()) fireVal = String(psets[ps][k]).trim();
          });
        });
      }
      if (FIRE_TYPES[p.ifcType] && !fireVal) acc.noFireRating.push(it);
      addDist('fireRating', fireVal, el);

      // IsExternal
      var extVal = null;
      if (commonPset) {
        Object.keys(commonPset).forEach(function(k) {
          if (k.toLowerCase()==='isexternal') extVal = commonPset[k];
        });
      }
      if (extVal === null) {
        Object.keys(psets).forEach(function(ps) {
          Object.keys(psets[ps]||{}).forEach(function(k) {
            if (k.toLowerCase()==='isexternal') extVal = psets[ps][k];
          });
        });
      }
      if (EXTERNAL_TYPES[p.ifcType] && extVal === null) acc.noIsExternal.push(it);
      addDist('isExternal', extVal, el);

      // LoadBearing
      var lbVal = null;
      if (commonPset) {
        Object.keys(commonPset).forEach(function(k) {
          if (k.toLowerCase()==='loadbearing') lbVal = commonPset[k];
        });
      }
      if (lbVal === null) {
        Object.keys(psets).forEach(function(ps) {
          Object.keys(psets[ps]||{}).forEach(function(k) {
            if (k.toLowerCase()==='loadbearing') lbVal = psets[ps][k];
          });
        });
      }
      if (LOADBEARING_TYPES[p.ifcType] && lbVal === null) acc.noLoadBearing.push(it);
      addDist('loadBearing', lbVal, el);

      // Classification / assembly code
      var classVal = null;
      Object.keys(psets).forEach(function(ps) {
        var grp = psets[ps]||{};
        Object.keys(grp).forEach(function(k) {
          var kl = k.toLowerCase();
          if (kl==='assemblycode'||kl==='assembly code'||kl==='assembly_code'||
              kl==='classificationcode'||kl==='classification code'||kl==='classification'||
              kl==='omniclass'||kl==='omniclassnumber'||kl==='uniclass'||kl==='uniformat'||kl==='masterformat') {
            if (grp[k] && String(grp[k]).trim()) classVal = String(grp[k]).trim();
          }
        });
      });
      if (p.objectType && /^\d{2}\s?\d{2}\s?\d{2}/.test(p.objectType) && !classVal) classVal = p.objectType;
      if (!classVal) acc.noClassification.push(it);
      addDist('classification', classVal, el);

      // ObjectType
      if (!p.objectType || !p.objectType.trim()) acc.noObjectType.push(it);
      addDist('objectType', p.objectType, el);

      // Material + storey
      addDist('material', p.material, el);
      addDist('storey', p.storey, el);

      // Thickness vs name
      var nameMatch = THICKNESS_RE.exec(p.name||'');
      if (nameMatch && quant) {
        var nameThickMM = parseFloat(nameMatch[1]);
        if (nameMatch[2].toLowerCase()==='cm') nameThickMM *= 10;
        if (nameMatch[2].toLowerCase()==='m') nameThickMM *= 1000;
        var actualThick = null;
        Object.keys(quant).forEach(function(qk) {
          var ql = qk.toLowerCase();
          if (ql==='width'||ql==='thickness'||ql==='depth') {
            var v = parseFloat(quant[qk]);
            if (!isNaN(v)) {
              if (v < 10) v *= 1000;
              actualThick = v;
            }
          }
        });
        if (actualThick !== null && Math.abs(actualThick - nameThickMM) > nameThickMM * 0.15) {
          acc.thicknessMismatch.push(Object.assign({}, it, {detail: 'Name says ' + nameThickMM + 'mm, actual ' + Math.round(actualThick) + 'mm'}));
        }
      }

      // Invalid names
      if (p.name && /^[\d\-_\s]+$/.test(p.name.trim())) acc.invalidName.push(it);

      // Missing area
      if (QUANTITY_TYPES[p.ifcType]) {
        var hasArea = false;
        Object.keys(quant).forEach(function(qk) {
          if (qk.toLowerCase().indexOf('area') >= 0 && parseFloat(quant[qk]) > 0) hasArea = true;
        });
        if (!hasArea) acc.missingArea.push(it);
      }

      // Missing volume
      if (QUANTITY_TYPES[p.ifcType] && p.ifcType !== 'IfcSpace') {
        var hasVol = false;
        Object.keys(quant).forEach(function(qk) {
          if (qk.toLowerCase().indexOf('volume') >= 0 && parseFloat(quant[qk]) > 0) hasVol = true;
        });
        if (!hasVol) acc.missingVolume.push(it);
      }
    });

    return {
      noFireRating:     {label:'Missing FireRating',                  sev:'warn', cat:'properties', count:acc.noFireRating.length,      ex:acc.noFireRating.slice(0,8)},
      noIsExternal:     {label:'Missing IsExternal parameter',        sev:'warn', cat:'properties', count:acc.noIsExternal.length,      ex:acc.noIsExternal.slice(0,8)},
      noLoadBearing:    {label:'Missing LoadBearing parameter',       sev:'warn', cat:'properties', count:acc.noLoadBearing.length,     ex:acc.noLoadBearing.slice(0,8)},
      noClassification: {label:'No classification / assembly code',   sev:'warn', cat:'classification', count:acc.noClassification.length, ex:acc.noClassification.slice(0,8)},
      noObjectType:     {label:'No ObjectType defined',               sev:'info', cat:'classification', count:acc.noObjectType.length,     ex:acc.noObjectType.slice(0,8)},
      missingCommonPset:{label:'Missing common property set',         sev:'warn', cat:'properties', count:acc.missingCommonPset.length, ex:acc.missingCommonPset.slice(0,8)},
      thicknessMismatch:{label:'Thickness \u2260 name (>15% off)',    sev:'error',cat:'geometry',  count:acc.thicknessMismatch.length, ex:acc.thicknessMismatch.slice(0,8)},
      invalidName:      {label:'Numeric/placeholder element names',   sev:'warn', cat:'naming',    count:acc.invalidName.length,       ex:acc.invalidName.slice(0,8)},
      missingArea:      {label:'Missing area quantity',               sev:'info', cat:'quantities', count:acc.missingArea.length,       ex:acc.missingArea.slice(0,8)},
      missingVolume:    {label:'Missing volume quantity',             sev:'info', cat:'quantities', count:acc.missingVolume.length,     ex:acc.missingVolume.slice(0,8)},
      _total: (elements||[]).length,
      _dist: dist
    };
  }

  // ── NL/SfB Table 1 — Building element codes ──────────────────────

  var NLSFB_TABLE1 = {
    '11':'Grondwerk','13':'Vloeren op grond','16':'Funderingen',
    '21':'Buitenwanden','22':'Binnenwanden','23':'Vloeren','24':'Trappen en hellingen',
    '27':'Daken','28':'Hoofddraagconstructie',
    '31':'Buitenramen','32':'Buitendeuren','33':'Binnenramen','34':'Binnendeuren',
    '37':'Dakramen/lichtkoepels',
    '41':'Wandafwerkingen buiten','42':'Wandafwerkingen binnen',
    '43':'Vloerafwerkingen','44':'Trapafwerkingen','45':'Plafondafwerkingen','47':'Dakafwerkingen',
    '52':'Afvoer/riolering','53':'Watervoorziening','54':'Gasvoorziening',
    '55':'Koeling','56':'Verwarming','57':'Ventilatie',
    '61':'Elektrische voorziening','62':'Krachtstroom','63':'Verlichting',
    '64':'Communicatie','66':'Transport (liften)','68':'Beveiliging',
    '73':'Terreinverharding','74':'Terreinafscheiding','90':'Vaste inrichting'
  };

  var IFC_TO_NLSFB = {
    IfcWall:['21','22'], IfcWallStandardCase:['21','22'],
    IfcSlab:['13','23','43'], IfcRoof:['27'],
    IfcColumn:['28'], IfcBeam:['28'], IfcMember:['28'],
    IfcWindow:['31','33','37'], IfcDoor:['32','34'],
    IfcStair:['24'], IfcStairFlight:['24'], IfcRamp:['24'], IfcRampFlight:['24'],
    IfcCurtainWall:['21'], IfcPlate:['28'],
    IfcCovering:['41','42','43','44','45','47'],
    IfcRailing:['34','28'],
    IfcSpace:['--'], IfcBuildingElementProxy:['--'],
    IfcPipeSegment:['52','53','54'], IfcPipeFitting:['52','53','54'],
    IfcDuctSegment:['57'], IfcDuctFitting:['57'],
    IfcFlowTerminal:['53','55','56','57','63'],
    IfcSanitaryTerminal:['53'], IfcLightFixture:['63'],
    IfcSwitchingDevice:['61','62'], IfcOutlet:['62'],
    IfcDistributionElement:['52','53','54','55','56','57','61','62','63','64'],
    // RVB BIM Norm v1.1 2.2.7.11 "Meubilair" - fixed furnishing falls under
    // NL/SfB group 90 (Vaste inrichting).
    IfcFurnishingElement:['90']
  };

  var ILS_REQUIRED = {
    IfcWall:          ['IsExternal','LoadBearing','FireRating','AcousticRating','ThermalTransmittance'],
    IfcWallStandardCase:['IsExternal','LoadBearing','FireRating','AcousticRating','ThermalTransmittance'],
    IfcSlab:          ['IsExternal','LoadBearing','FireRating','AcousticRating'],
    IfcRoof:          ['IsExternal','ThermalTransmittance'],
    IfcDoor:          ['IsExternal','FireRating','AcousticRating'],
    IfcWindow:        ['IsExternal','ThermalTransmittance'],
    IfcColumn:        ['LoadBearing','FireRating'],
    IfcBeam:          ['LoadBearing','FireRating'],
    IfcMember:        ['LoadBearing'],
    IfcCurtainWall:   ['IsExternal','ThermalTransmittance'],
    IfcStair:         ['FireRating'],
    IfcRamp:          ['FireRating'],
    IfcCovering:      ['FireRating']
  };

  function _extractNLSfB(psets, objectType) {
    var code = null;
    Object.keys(psets).forEach(function(ps) {
      var grp = psets[ps]||{};
      var psLower = ps.toLowerCase();
      Object.keys(grp).forEach(function(k) {
        var kl = k.toLowerCase();
        if (kl==='nl-sfb'||kl==='nl/sfb'||kl==='nlsfb'||kl==='nl_sfb'||kl==='sfbcode'||kl==='sfb-code'||kl==='sfb code'||
            kl==='classificationcode'||kl==='classification code'||kl==='classification'||
            (psLower.indexOf('sfb')>=0 && (kl==='code'||kl==='value'||kl==='elementcode'))) {
          var v = grp[k];
          if (v && String(v).trim()) code = String(v).trim();
        }
      });
    });
    if (!code && objectType) {
      var m = /\((\d{2})\)/.exec(objectType) || /^(\d{2})[\.\-\s]/.exec(objectType);
      if (m) code = m[1];
    }
    return code;
  }

  function _isValidNLSfBFormat(code) {
    if (!code) return false;
    var c = code.replace(/[()]/g,'').trim();
    return /^\d{2}(\.\d{1,2})*$/.test(c);
  }

  function _nlsfbMainGroup(code) {
    if (!code) return null;
    var c = code.replace(/[()]/g,'').trim();
    var m = /^(\d{2})/.exec(c);
    return m ? m[1] : null;
  }

  function _findPropValue(psets, propName) {
    var val = null;
    var pl = propName.toLowerCase();
    Object.keys(psets).forEach(function(ps) {
      var grp = psets[ps]||{};
      Object.keys(grp).forEach(function(k) {
        if (k.toLowerCase() === pl && grp[k] != null && String(grp[k]).trim()) val = String(grp[k]).trim();
      });
    });
    return val;
  }

  // ── ILS / NL-SfB Check Engine ──────────────────────────────────────
  //
  // Rule set derived from the public NL-BIM Basis ILS v2 standard
  // (bimloket.nl / buildingSMART Benelux). The individual checks are
  // re-implementations against the standard's requirements — no code
  // is copied from any specific validator implementation.

  // Storey naming: "-01 Kelder", "00 Begane grond", "01 Eerste…" etc.
  // Two digits with optional leading minus, then whitespace, then label.
  var STOREY_NAME_RE = /^-?\d{2}(\s.+)?$/;
  // Door naming: D-001, D001, D_12, etc. Dutch convention.
  var DOOR_NAME_RE = /^D[\s\-_]?\d{2,4}/i;
  // Fire rating values accepted by the standard (minutes) plus the
  // common EN 13501-2 REI/EI prefixed variants.
  var VALID_FIRE_RATING_RE = /^(REI|EI|R|E)?\s*-?\s*(30|60|90|120|180|240)$/i;
  // Approved structural materials for load-bearing walls — Dutch + EN
  // equivalents. Matches anywhere in the material string so composite
  // names like "Beton C30/37" still pass.
  var APPROVED_STRUCT_MAT_RE = /\b(beton|concrete|kalkzandsteen|limestone|cellular|metselwerk|masonry|brick|staal|steel|reinforced)\b/i;
  // Renovation status vocabulary — Dutch ILS values + common English.
  var VALID_RENOVATION_RE = /^(bestaand|nieuw|te\s+slopen|existing|new|demolish(ed)?|to\s+(be\s+)?demolish(ed)?|retained)$/i;
  var MEP_FLOW_TYPES = {IfcFlowSegment:1, IfcPipeSegment:1, IfcDuctSegment:1, IfcCableSegment:1, IfcCableCarrierSegment:1};

  function runILSChecks(elements) {
    var acc = {
      noNLSfB: [], invalidNLSfB: [], mismatchNLSfB: [],
      noDescription: [], noMaterial: [], noStorey: [],
      missingILSProp: [], noObjectType: [], noName: [],
      // New ILS v2 rules
      storeyNaming: [], doorNaming: [], spaceIncomplete: [],
      fireRatingInvalid: [], extWallNoUValue: [],
      loadBearingInvalidMaterial: [], mepNoRenovationStatus: []
    };
    var nlsfbDist = {};
    function addNLSfBDist(code, el) {
      var mainGroup = _nlsfbMainGroup(code);
      var label = mainGroup ? (mainGroup + ' ' + (NLSFB_TABLE1[mainGroup]||'Onbekend')) : '(geen code)';
      if (!nlsfbDist[label]) nlsfbDist[label] = [];
      nlsfbDist[label].push({expressId:el.expressId, modelId:el._modelId, name:(el.props||{}).name||'#'+el.expressId, ifcType:(el.props||{}).ifcType||'', code:code||''});
    }
    var ilsCompDist = {'Compliant':[], 'Minor issues':[], 'Major issues':[]};

    var PHYSICAL = {IfcWall:1,IfcWallStandardCase:1,IfcSlab:1,IfcRoof:1,IfcColumn:1,IfcBeam:1,
      IfcMember:1,IfcWindow:1,IfcDoor:1,IfcStair:1,IfcStairFlight:1,IfcRamp:1,IfcRampFlight:1,
      IfcCurtainWall:1,IfcPlate:1,IfcCovering:1,IfcRailing:1,IfcBuildingElementProxy:1,
      IfcPipeSegment:1,IfcPipeFitting:1,IfcDuctSegment:1,IfcDuctFitting:1,
      IfcFlowTerminal:1,IfcSanitaryTerminal:1,IfcLightFixture:1,
      IfcSwitchingDevice:1,IfcOutlet:1,IfcDistributionElement:1,IfcFurnishingElement:1,
      IfcFooting:1,IfcPile:1};

    // ── Pre-pass: storey + space checks (not in PHYSICAL set) ──────
    (elements||[]).forEach(function(el) {
      var p = el.props||{};
      var it = {name:p.name||('#'+el.expressId), gid:p.globalId, ifcType:p.ifcType, el:el};
      if (p.ifcType === 'IfcBuildingStorey') {
        var sname = (p.name||'').trim();
        if (!sname || !STOREY_NAME_RE.test(sname)) {
          acc.storeyNaming.push(Object.assign({}, it, {detail: sname || '(empty)'}));
        }
      } else if (p.ifcType === 'IfcSpace') {
        var spaceMissing = [];
        if (!p.name || !p.name.trim()) spaceMissing.push('Name');
        if (!p.longName || !p.longName.trim()) spaceMissing.push('LongName');
        if (!p.objectType || !p.objectType.trim()) spaceMissing.push('ObjectType');
        var spacePsets = p.psets||{};
        if (_findPropValue(spacePsets, 'IsExternal') === null) spaceMissing.push('IsExternal');
        var q = p.quantities||{};
        var hasNetArea = false, hasGrossArea = false, hasHeight = false;
        Object.keys(q).forEach(function(qk){
          if (/netfloorarea|net\s*floor\s*area|netarea/i.test(qk) && parseFloat(q[qk]) > 0) hasNetArea = true;
          if (/grossfloorarea|gross\s*floor\s*area/i.test(qk) && parseFloat(q[qk]) > 0) hasGrossArea = true;
          if (/^(height|finishceilingheight|finish\s*ceiling\s*height)$/i.test(qk.trim()) && parseFloat(q[qk]) > 0) hasHeight = true;
        });
        if (!hasNetArea) spaceMissing.push('NetFloorArea');
        // RVB BIM Norm v1.1 2.2.7.6b (Qto_SpaceBaseQuantities) - GrossFloorArea/Height,
        // alongside NL-BIM Basis ILS v2 4.1's NetFloorArea above.
        if (!hasGrossArea) spaceMissing.push('GrossFloorArea');
        if (!hasHeight) spaceMissing.push('Height');
        if (spaceMissing.length) {
          acc.spaceIncomplete.push(Object.assign({}, it, {detail: spaceMissing.join(', ')}));
        }
      }
    });

    (elements||[]).forEach(function(el) {
      var p = el.props||{};
      if (!PHYSICAL[p.ifcType]) return;
      var psets = p.psets||{};
      var it = {name:p.name||('#'+el.expressId), gid:p.globalId, ifcType:p.ifcType, el:el};
      var issues = 0;

      // Door naming pattern (ILS 3.5)
      if (p.ifcType === 'IfcDoor') {
        var dname = (p.name||'').trim();
        if (!dname || !DOOR_NAME_RE.test(dname)) {
          acc.doorNaming.push(Object.assign({}, it, {detail: dname || '(empty)'}));
          issues += 1;
        }
      }

      // Wall-specific strict checks (ILS 4.5, 4.6, 4.7.2)
      if (p.ifcType === 'IfcWall' || p.ifcType === 'IfcWallStandardCase') {
        var fireVal = _findPropValue(psets, 'FireRating');
        var loadVal = _findPropValue(psets, 'LoadBearing');
        var extVal = _findPropValue(psets, 'IsExternal');
        var isLoadBearing = loadVal && /^(true|1|yes)$/i.test(String(loadVal));
        var isExternal = extVal && /^(true|1|yes)$/i.test(String(extVal));
        // 4.5 — FireRating value must match standard enum on internal load-bearing walls
        if (fireVal && !VALID_FIRE_RATING_RE.test(String(fireVal).trim())) {
          acc.fireRatingInvalid.push(Object.assign({}, it, {detail: 'Value: "' + fireVal + '" (expected 30/60/90/120)'}));
          issues += 1;
        }
        // 4.6 — External walls need a U-value
        if (isExternal && !_findPropValue(psets, 'ThermalTransmittance')) {
          acc.extWallNoUValue.push(it);
          issues += 1;
        }
        // 4.7.2 — Load-bearing walls must use an approved structural material
        if (isLoadBearing && p.material && !APPROVED_STRUCT_MAT_RE.test(p.material)) {
          acc.loadBearingInvalidMaterial.push(Object.assign({}, it, {detail: p.material}));
          issues += 1;
        }
      }

      // MEP renovation status (ILS 4.8)
      if (MEP_FLOW_TYPES[p.ifcType]) {
        var renov = _findPropValue(psets, 'RenovationStatus') || _findPropValue(psets, 'Status');
        if (!renov || !VALID_RENOVATION_RE.test(String(renov).trim())) {
          acc.mepNoRenovationStatus.push(Object.assign({}, it, {detail: renov || '(missing)'}));
          issues += 1;
        }
      }

      // NL/SfB classification
      var nlsfb = _extractNLSfB(psets, p.objectType);
      if (!nlsfb) {
        acc.noNLSfB.push(it);
        issues += 2;
      } else if (!_isValidNLSfBFormat(nlsfb)) {
        acc.invalidNLSfB.push(Object.assign({}, it, {detail: 'Code: "' + nlsfb + '"'}));
        issues += 1;
      } else {
        var mainGroup = _nlsfbMainGroup(nlsfb);
        var allowed = IFC_TO_NLSFB[p.ifcType];
        if (allowed && allowed[0] !== '--' && mainGroup && allowed.indexOf(mainGroup) < 0) {
          acc.mismatchNLSfB.push(Object.assign({}, it, {detail: nlsfb + ' \u2194 ' + p.ifcType + ' (verwacht: ' + allowed.join('/') + ')'}));
          issues += 1;
        }
      }
      addNLSfBDist(nlsfb, el);

      // Required ILS properties
      var reqProps = ILS_REQUIRED[p.ifcType] || [];
      var missingProps = [];
      reqProps.forEach(function(prop) {
        if (!_findPropValue(psets, prop)) missingProps.push(prop);
      });
      if (missingProps.length > 0) {
        acc.missingILSProp.push(Object.assign({}, it, {detail: missingProps.join(', ')}));
        issues += missingProps.length;
      }

      if (!p.description || !p.description.trim() || p.description.trim() === p.name) {
        acc.noDescription.push(it);
        issues += 1;
      }
      if (!p.material || !p.material.trim()) {
        acc.noMaterial.push(it);
        issues += 1;
      }
      if (!p.storey || !p.storey.trim()) {
        acc.noStorey.push(it);
        issues += 1;
      }
      if (!p.objectType || !p.objectType.trim()) {
        acc.noObjectType.push(it);
        issues += 1;
      }
      if (!p.name || !p.name.trim()) {
        acc.noName.push(it);
        issues += 1;
      }

      var elInfo = {expressId:el.expressId, modelId:el._modelId, name:p.name||'#'+el.expressId, ifcType:p.ifcType||''};
      if (issues === 0) ilsCompDist['Compliant'].push(elInfo);
      else if (issues <= 2) ilsCompDist['Minor issues'].push(elInfo);
      else ilsCompDist['Major issues'].push(elInfo);
    });

    return {
      noNLSfB:        {label:'Geen NL/SfB classificatie',           sev:'error',cat:'nlsfb', count:acc.noNLSfB.length,        ex:acc.noNLSfB.slice(0,8)},
      invalidNLSfB:   {label:'Ongeldig NL/SfB formaat',             sev:'error',cat:'nlsfb', count:acc.invalidNLSfB.length,    ex:acc.invalidNLSfB.slice(0,8)},
      mismatchNLSfB:  {label:'NL/SfB komt niet overeen met IFC type',sev:'warn', cat:'nlsfb', count:acc.mismatchNLSfB.length,  ex:acc.mismatchNLSfB.slice(0,8)},
      missingILSProp: {label:'Ontbrekende ILS-verplichte eigenschappen',sev:'warn',cat:'properties',count:acc.missingILSProp.length,ex:acc.missingILSProp.slice(0,8)},
      noDescription:  {label:'Geen of lege omschrijving',            sev:'info', cat:'naming', count:acc.noDescription.length,   ex:acc.noDescription.slice(0,8)},
      noMaterial:     {label:'Geen materiaal toegewezen',            sev:'warn', cat:'properties',count:acc.noMaterial.length,   ex:acc.noMaterial.slice(0,8)},
      noStorey:       {label:'Geen bouwlaag toegewezen',             sev:'warn', cat:'location', count:acc.noStorey.length,      ex:acc.noStorey.slice(0,8)},
      noObjectType:   {label:'Geen ObjectType gedefinieerd',         sev:'info', cat:'classification',count:acc.noObjectType.length,ex:acc.noObjectType.slice(0,8)},
      noName:         {label:'Geen elementnaam',                     sev:'warn', cat:'naming', count:acc.noName.length,          ex:acc.noName.slice(0,8)},
      // NL-BIM Basis ILS v2 additions
      storeyNaming:   {label:'Bouwlaag naamgeving (ILS 3.3)',        sev:'info', cat:'naming', count:acc.storeyNaming.length,    ex:acc.storeyNaming.slice(0,8)},
      doorNaming:     {label:'Deurnaamgeving D-### (ILS 3.5)',       sev:'info', cat:'naming', count:acc.doorNaming.length,      ex:acc.doorNaming.slice(0,8)},
      spaceIncomplete:{label:'IfcSpace onvolledig: naam, classificatie of hoeveelheden (ILS 4.1 / RVB 2.2.7.6)',sev:'warn',cat:'properties',count:acc.spaceIncomplete.length,ex:acc.spaceIncomplete.slice(0,8)},
      fireRatingInvalid:{label:'FireRating ongeldige waarde (ILS 4.5)',sev:'warn',cat:'properties',count:acc.fireRatingInvalid.length,ex:acc.fireRatingInvalid.slice(0,8)},
      extWallNoUValue:{label:'Buitenwand zonder ThermalTransmittance (ILS 4.6)',sev:'warn',cat:'properties',count:acc.extWallNoUValue.length,ex:acc.extWallNoUValue.slice(0,8)},
      loadBearingInvalidMaterial:{label:'Dragende wand: niet-constructief materiaal (ILS 4.7.2)',sev:'warn',cat:'properties',count:acc.loadBearingInvalidMaterial.length,ex:acc.loadBearingInvalidMaterial.slice(0,8)},
      mepNoRenovationStatus:{label:'MEP segment zonder RenovationStatus (ILS 4.8)',sev:'info',cat:'properties',count:acc.mepNoRenovationStatus.length,ex:acc.mepNoRenovationStatus.slice(0,8)},
      _total: (elements||[]).length,
      _nlsfbDist: nlsfbDist,
      _compDist: ilsCompDist
    };
  }

  // ── RVB BIM Norm v1.1 — Project/Site/Building/Zone metadata ──────────
  //
  // Rule set derived from the public RVB BIM Norm v1.1 standard
  // (Rijksvastgoedbedrijf / buildingSMART Benelux), covering the
  // project-level metadata specs (2.2.7.1-2.2.7.4, 2.2.7.7) that
  // runILSChecks above can't reach because they live above the
  // per-element level: IfcProject/IfcSite/IfcBuilding/IfcZone, plus
  // IfcBuildingStorey.Elevation (extractStoreys' storeyData, not part of
  // the per-element props runILSChecks reads). The individual checks are
  // re-implementations against the standard's requirements — no code is
  // copied from any specific validator implementation. The RVB
  // element-level gap-fills (furnishing NL-SfB, space quantities) live in
  // runILSChecks itself, alongside the ILS checks they extend.
  //
  // Takes the loaded models directly (spatialHierarchy/storeyData are
  // per-model, not per-element) rather than a flat elements array.
  function runRVBChecks(models) {
    var acc = {
      projectIncomplete: [], siteIncomplete: [], buildingIncomplete: [],
      zoneIncomplete: [], storeyNoElevation: []
    };
    var totals = {projectIncomplete:0, siteIncomplete:0, buildingIncomplete:0, zoneIncomplete:0, storeyNoElevation:0};

    (models||[]).forEach(function(m) {
      var sh = m.spatialHierarchy || {};
      var mName = m.name || m.id || 'model';

      // 2.2.7.1 — Project informatie
      totals.projectIncomplete++;
      if (!sh.project || !sh.project._hasName) {
        acc.projectIncomplete.push({name:mName, ifcType:'IfcProject', detail:'Name'});
      }

      // 2.2.7.2 — Terrein informatie (Name + georeferentie)
      (sh.sites||[]).forEach(function(site) {
        totals.siteIncomplete++;
        var missing = [];
        if (!site._hasName) missing.push('Name');
        var g = site.georef;
        if (!g || g.refLat == null || g.refLon == null) missing.push('RefLatitude/RefLongitude');
        if (!g || g.refElev == null) missing.push('RefElevation');
        if (missing.length) acc.siteIncomplete.push({name:mName+' — '+site.name, ifcType:'IfcSite', detail:missing.join(', ')});
      });

      // 2.2.7.3 — Gebouw informatie
      (sh.buildings||[]).forEach(function(bld) {
        totals.buildingIncomplete++;
        if (!bld._hasName) acc.buildingIncomplete.push({name:mName+' — '+bld.name, ifcType:'IfcBuilding', detail:'Name'});
      });

      // 2.2.7.7 — Zone informatie. IfcZone is an optional IFC grouping —
      // most models legitimately have none, so an empty set is not itself
      // flagged, only zones that DO exist and are incomplete.
      (sh.zones||[]).forEach(function(zone) {
        totals.zoneIncomplete++;
        var zMissing = [];
        if (!zone._hasName) zMissing.push('Name');
        if (!zone.objectType) zMissing.push('ObjectType');
        if (zMissing.length) acc.zoneIncomplete.push({name:mName+' — '+zone.name, ifcType:'IfcZone', detail:zMissing.join(', ')});
      });

      // 2.2.7.4 — Bouwlaag: Elevation. Name-format is already checked by
      // runILSChecks' storeyNaming (ILS 3.3); this is the RVB addition,
      // read from storeyData since Elevation isn't in per-element props.
      (m.storeyData||[]).forEach(function(sd) {
        totals.storeyNoElevation++;
        if (!sd.hasElevation) acc.storeyNoElevation.push({name:mName+' — '+sd.name, ifcType:'IfcBuildingStorey', detail:'Elevation'});
      });
    });

    return {
      projectIncomplete:{label:'IfcProject zonder naam (RVB 2.2.7.1)',sev:'warn',cat:'metadata',count:acc.projectIncomplete.length,total:totals.projectIncomplete,ex:acc.projectIncomplete.slice(0,8)},
      siteIncomplete:{label:'IfcSite: naam of georeferentie ontbreekt (RVB 2.2.7.2)',sev:'info',cat:'metadata',count:acc.siteIncomplete.length,total:totals.siteIncomplete,ex:acc.siteIncomplete.slice(0,8)},
      buildingIncomplete:{label:'IfcBuilding zonder naam (RVB 2.2.7.3)',sev:'warn',cat:'metadata',count:acc.buildingIncomplete.length,total:totals.buildingIncomplete,ex:acc.buildingIncomplete.slice(0,8)},
      zoneIncomplete:{label:'IfcZone: naam of ObjectType ontbreekt (RVB 2.2.7.7)',sev:'info',cat:'metadata',count:acc.zoneIncomplete.length,total:totals.zoneIncomplete,ex:acc.zoneIncomplete.slice(0,8)},
      storeyNoElevation:{label:'Bouwlaag zonder Elevation (RVB 2.2.7.4)',sev:'info',cat:'metadata',count:acc.storeyNoElevation.length,total:totals.storeyNoElevation,ex:acc.storeyNoElevation.slice(0,8)},
      _total: (models||[]).length
    };
  }

  // ── IDS (Information Delivery Specification) Export ─────────────
  // Generates a buildingSMART IDS 1.0 XML file from ClashControl's
  // data quality and BIM model checks. IDS-compatible checks are
  // exported as <specification> elements; cross-element checks
  // (duplicates, collisions) are ClashControl-specific and skipped.

  var IDS_NS = 'http://standards.buildingsmart.org/IDS';
  var XS_NS = 'http://www.w3.org/2001/XMLSchema';

  function _idsEsc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function exportIDS(options) {
    var title = (options && options.title) || 'ClashControl Data Quality Rules';
    var specs = [];

    // GlobalId required
    specs.push({name:'GlobalId required',desc:'Every element must have a valid GlobalId',
      applicability:{entity:'IFCBUILDINGELEMENT'},
      requirement:{facet:'attribute',name:'GlobalId',cardinality:'required'}});

    // Material required
    specs.push({name:'Material assigned',desc:'Every element should have a material assignment',
      applicability:{entity:'IFCBUILDINGELEMENT'},
      requirement:{facet:'material',cardinality:'required'}});

    // Storey containment
    specs.push({name:'Storey assignment',desc:'Elements must be contained in an IfcBuildingStorey',
      applicability:{entity:'IFCBUILDINGELEMENT'},
      requirement:{facet:'partOf',entity:'IFCBUILDINGSTOREY',cardinality:'required'}});

    // Description required
    specs.push({name:'Description',desc:'Elements should have a Description attribute',
      applicability:{entity:'IFCBUILDINGELEMENT'},
      requirement:{facet:'attribute',name:'Description',cardinality:'required'}});

    // No IfcBuildingElementProxy
    specs.push({name:'No unclassified proxies',desc:'IfcBuildingElementProxy should not be used',
      applicability:{entity:'IFCBUILDINGELEMENTPROXY'},
      requirement:{facet:'entity',prohibited:true,desc:'Reclassify proxy elements to their correct IFC type'}});

    // Common Pset checks per type
    Object.keys(BIM_PSET_MAP).forEach(function(ifcType) {
      var psets = BIM_PSET_MAP[ifcType];
      psets.forEach(function(psetName) {
        specs.push({name:psetName+' on '+ifcType, desc:ifcType+' elements must have '+psetName,
          applicability:{entity:ifcType.toUpperCase()},
          requirement:{facet:'property',pset:psetName,cardinality:'required'}});
      });
    });

    // FireRating on structural elements
    specs.push({name:'FireRating on walls',desc:'Walls should have a FireRating property',
      applicability:{entity:'IFCWALL'},
      requirement:{facet:'property',pset:'Pset_WallCommon',prop:'FireRating',cardinality:'required'}});

    // IsExternal on envelope elements
    specs.push({name:'IsExternal on walls',desc:'Walls should declare IsExternal',
      applicability:{entity:'IFCWALL'},
      requirement:{facet:'property',pset:'Pset_WallCommon',prop:'IsExternal',cardinality:'required'}});

    // Build XML
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<ids xmlns="'+IDS_NS+'" xmlns:xs="'+XS_NS+'">\n';
    xml += '  <info>\n';
    xml += '    <title>'+_idsEsc(title)+'</title>\n';
    xml += '    <description>Exported from ClashControl data quality checks</description>\n';
    xml += '    <date>'+new Date().toISOString().slice(0,10)+'</date>\n';
    xml += '  </info>\n';
    xml += '  <specifications>\n';

    specs.forEach(function(sp) {
      xml += '    <specification name="'+_idsEsc(sp.name)+'" ifcVersion="IFC2X3 IFC4">\n';
      xml += '      <applicability minOccurs="0" maxOccurs="unbounded">\n';
      xml += '        <entity><name><simpleValue>'+_idsEsc(sp.applicability.entity)+'</simpleValue></name></entity>\n';
      xml += '      </applicability>\n';
      xml += '      <requirements>\n';
      var r = sp.requirement;
      if (r.facet === 'attribute') {
        xml += '        <attribute cardinality="'+r.cardinality+'"><name><simpleValue>'+_idsEsc(r.name)+'</simpleValue></name></attribute>\n';
      } else if (r.facet === 'material') {
        xml += '        <material cardinality="'+r.cardinality+'"/>\n';
      } else if (r.facet === 'partOf') {
        xml += '        <partOf relation="IFCRELCONTAINEDINSPATIALSTRUCTURE" cardinality="'+r.cardinality+'"><entity><name><simpleValue>'+_idsEsc(r.entity)+'</simpleValue></name></entity></partOf>\n';
      } else if (r.facet === 'property') {
        xml += '        <property cardinality="'+r.cardinality+'">';
        xml += '<propertySet><simpleValue>'+_idsEsc(r.pset)+'</simpleValue></propertySet>';
        if (r.prop) xml += '<baseName><simpleValue>'+_idsEsc(r.prop)+'</simpleValue></baseName>';
        xml += '</property>\n';
      } else if (r.facet === 'entity' && r.prohibited) {
        xml += '        <!-- ClashControl: '+_idsEsc(r.desc)+' -->\n';
      }
      xml += '      </requirements>\n';
      xml += '    </specification>\n';
    });

    xml += '  </specifications>\n';
    xml += '</ids>\n';
    return xml;
  }

  // ── IDS 1.0 Parse + Execution Engine ─────────────────────────────
  // Full buildingSMART IDS 1.0 support: parses .ids XML into facet
  // structures and EXECUTES the specifications against the loaded
  // elements (props extracted by the core loader). Re-implemented from
  // the published IDS 1.0 standard; behaviour is modelled on IfcTester
  // (the reference implementation) but no code is ported from it.
  //
  // Honesty rule: anything the in-browser data model cannot evaluate
  // (PredefinedType, partOf relations other than storey containment,
  // XSD-only regex constructs, dataType checks) is reported as
  // "not checkable" — never silently passed or failed.

  // Minimal strict XML parser (no DOMParser dependency, so the engine
  // also runs under Node for tests). Namespace prefixes are stripped;
  // IDS matching is done on local names.
  function _xmlParse(text) {
    var src = String(text || '').replace(/^﻿/, '');
    var pos = 0, len = src.length;
    function fail(msg) { throw new Error(msg + ' (offset ' + pos + ')'); }
    function decode(s) {
      return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function(m, e) {
        if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
        if (e === 'quot') return '"'; if (e === 'apos') return "'";
        var cp = (e.charAt(1) === 'x' || e.charAt(1) === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isNaN(cp) ? m : String.fromCodePoint(cp);
      });
    }
    function local(name) { var i = name.indexOf(':'); return i >= 0 ? name.slice(i + 1) : name; }
    function skipMisc() {
      for (;;) {
        while (pos < len && /\s/.test(src.charAt(pos))) pos++;
        if (src.startsWith('<?', pos)) { pos = src.indexOf('?>', pos); if (pos < 0) fail('unterminated PI'); pos += 2; continue; }
        if (src.startsWith('<!--', pos)) { pos = src.indexOf('-->', pos); if (pos < 0) fail('unterminated comment'); pos += 3; continue; }
        if (src.startsWith('<!', pos)) { pos = src.indexOf('>', pos); if (pos < 0) fail('unterminated declaration'); pos += 1; continue; }
        return;
      }
    }
    function parseElement() {
      if (src.charAt(pos) !== '<') fail('expected element');
      pos++;
      var nm = /^[^\s/>]+/.exec(src.slice(pos, pos + 256));
      if (!nm) fail('bad tag name');
      var node = { tag: local(nm[0]), attrs: {}, children: [], text: '' };
      pos += nm[0].length;
      for (;;) {
        while (pos < len && /\s/.test(src.charAt(pos))) pos++;
        if (pos >= len) fail('unterminated tag');
        if (src.charAt(pos) === '/') { if (src.charAt(pos + 1) !== '>') fail('bad self-close'); pos += 2; return node; }
        if (src.charAt(pos) === '>') { pos++; break; }
        var am = /^([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(src.slice(pos));
        if (!am) fail('bad attribute');
        node.attrs[local(am[1])] = decode(am[2] != null ? am[2] : am[3]);
        pos += am[0].length;
      }
      for (;;) {
        if (pos >= len) fail('unterminated element <' + node.tag + '>');
        if (src.startsWith('<!--', pos)) { var ec = src.indexOf('-->', pos); if (ec < 0) fail('unterminated comment'); pos = ec + 3; continue; }
        if (src.startsWith('<![CDATA[', pos)) { var ed = src.indexOf(']]>', pos); if (ed < 0) fail('unterminated CDATA'); node.text += src.slice(pos + 9, ed); pos = ed + 3; continue; }
        if (src.startsWith('</', pos)) { var ee = src.indexOf('>', pos); if (ee < 0) fail('unterminated close tag'); pos = ee + 1; return node; }
        if (src.charAt(pos) === '<') { node.children.push(parseElement()); continue; }
        var nx = src.indexOf('<', pos);
        if (nx < 0) fail('text after content');
        node.text += decode(src.slice(pos, nx));
        pos = nx;
      }
    }
    skipMisc();
    if (pos >= len) fail('empty document');
    return parseElement();
  }

  function _kid(node, tag) {
    if (!node) return null;
    for (var i = 0; i < node.children.length; i++) if (node.children[i].tag === tag) return node.children[i];
    return null;
  }
  function _kids(node, tag) {
    var out = [];
    if (node) for (var i = 0; i < node.children.length; i++) if (node.children[i].tag === tag) out.push(node.children[i]);
    return out;
  }
  function _textOf(node) { return node ? String(node.text || '').trim() : ''; }

  // idsValue = <simpleValue> or <xs:restriction> → normalised value spec
  function _parseValueSpec(node) {
    if (!node) return null;
    var sv = _kid(node, 'simpleValue');
    if (sv) return { simple: _textOf(sv) };
    var r = _kid(node, 'restriction');
    if (!r) return null;
    var R = { base: r.attrs.base || '' };
    r.children.forEach(function(c) {
      var v = c.attrs.value;
      switch (c.tag) {
        case 'enumeration': (R.enumeration = R.enumeration || []).push(v); break;
        case 'pattern': R.pattern = v; break;
        case 'minInclusive': case 'maxInclusive': case 'minExclusive': case 'maxExclusive':
          R[c.tag] = parseFloat(v); break;
        case 'length': case 'minLength': case 'maxLength':
          R[c.tag] = parseInt(v, 10); break;
        case 'annotation': break;
        default: (R.unsupported = R.unsupported || []).push(c.tag);
      }
    });
    return { restriction: R };
  }

  // XSD regex → JS RegExp. XSD patterns are implicitly anchored. The
  // XSD-only constructs we cannot translate (\i \c name escapes, class
  // subtraction) yield null = "not checkable" instead of a wrong verdict.
  function _xsdPatternToRegExp(pat, ci) {
    if (/\\[icIC]/.test(pat) || /-\[/.test(pat)) return null;
    try { return new RegExp('^(?:' + pat + ')$', ci ? 'i' : ''); } catch (e) { return null; }
  }

  function _normVal(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  // Single-value equality: exact string, then numeric with relative
  // tolerance, then boolean spelling variants (.T./1/yes etc.).
  function _valEq(expected, actual) {
    var a = _normVal(actual), e = String(expected);
    if (a === e) return true;
    var NUM_RE = /^[+\-]?(\d+\.?\d*|\.\d+)([eE][+\-]?\d+)?$/;
    if (NUM_RE.test(a.trim()) && NUM_RE.test(e.trim())) {
      var an = parseFloat(a), en = parseFloat(e);
      return Math.abs(an - en) <= 1e-6 * Math.max(1, Math.abs(en));
    }
    if (/^(true|false)$/i.test(e)) {
      var ab = /^(true|\.t\.|1|yes)$/i.test(a.trim()) ? 'true' :
               /^(false|\.f\.|0|no)$/i.test(a.trim()) ? 'false' : null;
      if (ab) return ab === e.trim().toLowerCase();
    }
    return false;
  }

  // Match an actual value against a value spec.
  // Returns true | false | null (null = restriction not checkable).
  function _matchValue(vs, actual) {
    if (actual == null || String(actual).trim() === '') return false;
    if (!vs) return true; // presence-only
    if ('simple' in vs) return _valEq(vs.simple, actual);
    var R = vs.restriction || {};
    if (R.unsupported && R.unsupported.length) return null;
    var a = _normVal(actual);
    if (R.enumeration) {
      for (var i = 0; i < R.enumeration.length; i++) if (_valEq(R.enumeration[i], actual)) return true;
      return false;
    }
    var ok = true;
    if (R.pattern != null) {
      var re = _xsdPatternToRegExp(R.pattern, false);
      if (!re) return null;
      ok = ok && re.test(a);
    }
    if (R.minInclusive != null || R.maxInclusive != null || R.minExclusive != null || R.maxExclusive != null) {
      var n = parseFloat(a);
      if (isNaN(n)) return false;
      if (R.minInclusive != null) ok = ok && n >= R.minInclusive;
      if (R.maxInclusive != null) ok = ok && n <= R.maxInclusive;
      if (R.minExclusive != null) ok = ok && n > R.minExclusive;
      if (R.maxExclusive != null) ok = ok && n < R.maxExclusive;
    }
    if (R.length != null) ok = ok && a.length === R.length;
    if (R.minLength != null) ok = ok && a.length >= R.minLength;
    if (R.maxLength != null) ok = ok && a.length <= R.maxLength;
    return ok;
  }

  // Entity names in IDS are uppercase; compare case-insensitively but
  // EXACTLY (no substring, no subtype expansion — per the standard,
  // IFCWALL does not match IFCWALLSTANDARDCASE).
  function _matchEntity(vs, typeUpper) {
    if (!vs) return true;
    if ('simple' in vs) return String(vs.simple).toUpperCase() === typeUpper;
    var R = vs.restriction || {};
    if (R.unsupported && R.unsupported.length) return null;
    if (R.enumeration) {
      for (var i = 0; i < R.enumeration.length; i++) if (String(R.enumeration[i]).toUpperCase() === typeUpper) return true;
      return false;
    }
    if (R.pattern != null) {
      var re = _xsdPatternToRegExp(R.pattern, true);
      return re ? re.test(typeUpper) : null;
    }
    return null;
  }

  function _parseFacet(node) {
    var f = { type: node.tag, cardinality: node.attrs.cardinality || 'required', instructions: node.attrs.instructions || '' };
    switch (node.tag) {
      case 'entity':
        f.name = _parseValueSpec(_kid(node, 'name'));
        f.predefinedType = _parseValueSpec(_kid(node, 'predefinedType'));
        break;
      case 'attribute':
        f.name = _parseValueSpec(_kid(node, 'name'));
        f.value = _parseValueSpec(_kid(node, 'value'));
        break;
      case 'property':
        f.propertySet = _parseValueSpec(_kid(node, 'propertySet'));
        f.baseName = _parseValueSpec(_kid(node, 'baseName'));
        f.value = _parseValueSpec(_kid(node, 'value'));
        f.dataType = node.attrs.dataType || '';
        break;
      case 'classification':
        f.system = _parseValueSpec(_kid(node, 'system'));
        f.value = _parseValueSpec(_kid(node, 'value'));
        break;
      case 'material':
        f.value = _parseValueSpec(_kid(node, 'value'));
        break;
      case 'partOf':
        f.relation = node.attrs.relation || '';
        var ent = _kid(node, 'entity');
        f.entity = ent ? _parseValueSpec(_kid(ent, 'name')) : null;
        break;
      default:
        f.type = 'unsupported';
        f.tag = node.tag;
    }
    return f;
  }

  function _vsDesc(vs) {
    if (!vs) return '(any)';
    if ('simple' in vs) return vs.simple;
    var R = vs.restriction || {};
    if (R.enumeration) return R.enumeration.join('|');
    if (R.pattern != null) return '~' + R.pattern;
    var parts = [];
    if (R.minInclusive != null) parts.push('≥ ' + R.minInclusive);
    if (R.maxInclusive != null) parts.push('≤ ' + R.maxInclusive);
    if (R.minExclusive != null) parts.push('> ' + R.minExclusive);
    if (R.maxExclusive != null) parts.push('< ' + R.maxExclusive);
    if (R.length != null) parts.push('length ' + R.length);
    if (R.minLength != null) parts.push('length ≥ ' + R.minLength);
    if (R.maxLength != null) parts.push('length ≤ ' + R.maxLength);
    return parts.join(', ') || '(restricted)';
  }

  function _facetDesc(f) {
    switch (f.type) {
      case 'entity': return 'entity ' + _vsDesc(f.name) + (f.predefinedType ? '.' + _vsDesc(f.predefinedType) : '');
      case 'attribute': return 'attribute ' + _vsDesc(f.name) + (f.value ? ' = ' + _vsDesc(f.value) : '');
      case 'property': return 'property ' + _vsDesc(f.propertySet) + '.' + _vsDesc(f.baseName) + (f.value ? ' = ' + _vsDesc(f.value) : '');
      case 'classification': return 'classification' + (f.system ? ' [' + _vsDesc(f.system) + ']' : '') + (f.value ? ' = ' + _vsDesc(f.value) : '');
      case 'material': return 'material' + (f.value ? ' = ' + _vsDesc(f.value) : '');
      case 'partOf': return 'partOf ' + (f.relation || 'container') + (f.entity ? ' ' + _vsDesc(f.entity) : '');
    }
    return f.tag || f.type;
  }

  // Parse a .ids file into the executable structure.
  function parseIDSSpec(xmlString) {
    var root;
    try { root = _xmlParse(xmlString); }
    catch (e) { return { error: 'Invalid IDS XML: ' + e.message }; }
    if (!root || root.tag !== 'ids') return { error: 'Not an IDS document (root element is <' + (root && root.tag) + '>)' };
    var info = _kid(root, 'info');
    var out = {
      title: _textOf(_kid(info, 'title')) || 'Imported IDS',
      description: _textOf(_kid(info, 'description')),
      date: _textOf(_kid(info, 'date')),
      specs: []
    };
    var specsEl = _kid(root, 'specifications');
    _kids(specsEl, 'specification').forEach(function(spEl, i) {
      var app = _kid(spEl, 'applicability');
      var req = _kid(spEl, 'requirements');
      var spec = {
        name: spEl.attrs.name || ('Specification ' + (i + 1)),
        identifier: spEl.attrs.identifier || '',
        description: spEl.attrs.description || '',
        instructions: spEl.attrs.instructions || '',
        ifcVersion: spEl.attrs.ifcVersion || '',
        cardinality: 'required',
        applicability: [],
        requirements: []
      };
      if (app) {
        // IDS 1.0 spec cardinality lives on applicability@minOccurs/maxOccurs:
        // maxOccurs=0 → prohibited, minOccurs=0 → optional, else required.
        if (String(app.attrs.maxOccurs) === '0') spec.cardinality = 'prohibited';
        else if (app.attrs.minOccurs == null || String(app.attrs.minOccurs) === '0') spec.cardinality = 'optional';
        app.children.forEach(function(c) { spec.applicability.push(_parseFacet(c)); });
      }
      if (req) req.children.forEach(function(c) { spec.requirements.push(_parseFacet(c)); });
      out.specs.push(spec);
    });
    return out;
  }

  // IFC attributes reachable from the loader's extracted props. Anything
  // outside this map (Tag, PredefinedType, …) is "not checkable".
  var IDS_ATTR_MAP = {
    NAME: 'name', DESCRIPTION: 'description', GLOBALID: 'globalId',
    OBJECTTYPE: 'objectType', LONGNAME: 'longName'
  };

  var CLASS_PSET_RE = /classification|sfb|omniclass|uniclass|uniformat|masterformat/;

  function _classificationCandidates(p) {
    var out = [];
    var psets = p.psets || {};
    Object.keys(psets).forEach(function(ps) {
      var grp = psets[ps] || {};
      var psIsClass = CLASS_PSET_RE.test(ps.toLowerCase());
      Object.keys(grp).forEach(function(k) {
        var kl = k.toLowerCase().replace(/[\s_\/\-]/g, '');
        var keyIsClass = kl === 'assemblycode' || kl === 'classificationcode' || kl === 'classification' ||
          kl === 'omniclass' || kl === 'omniclassnumber' || kl === 'uniclass' || kl === 'uniformat' ||
          kl === 'masterformat' || kl === 'nlsfb' || kl === 'sfbcode';
        var keyInClassPset = psIsClass && (kl === 'code' || kl === 'reference' || kl === 'value' || kl === 'elementcode' || kl === 'itemreference');
        var v = grp[k];
        if ((keyIsClass || keyInClassPset) && v != null && String(v).trim()) {
          out.push({ system: ps, key: k, code: String(v).trim() });
        }
      });
    });
    return out;
  }

  // Evaluate one facet against an element's props.
  // Returns {present, matches} with matches ∈ true|false, or null when
  // the facet cannot be evaluated from the in-browser data model.
  function _facetEval(f, p) {
    switch (f.type) {
      case 'entity': {
        var t = String(p.ifcType || '').toUpperCase();
        if (!t) return { present: false, matches: false };
        if (f.predefinedType) return null; // PredefinedType is not extracted by the loader
        var em = _matchEntity(f.name, t);
        return em === null ? null : { present: true, matches: em };
      }
      case 'attribute': {
        if (!f.name || !('simple' in f.name)) return null; // restriction-named attributes unsupported
        var key = IDS_ATTR_MAP[String(f.name.simple).toUpperCase()];
        if (!key) return null;
        var v = p[key];
        if (v == null || String(v).trim() === '') return { present: false, matches: false };
        var am = f.value ? _matchValue(f.value, v) : true;
        return am === null ? null : { present: true, matches: am };
      }
      case 'property': {
        var hits = [], unchecked = false;
        var psets = p.psets || {};
        Object.keys(psets).forEach(function(ps) {
          var pm = _matchValue(f.propertySet, ps);
          if (pm === null) { unchecked = true; return; }
          if (!pm) return;
          var grp = psets[ps] || {};
          Object.keys(grp).forEach(function(k) {
            var bm = _matchValue(f.baseName, k);
            if (bm === null) { unchecked = true; return; }
            if (bm && grp[k] != null && String(grp[k]).trim() !== '') hits.push(grp[k]);
          });
        });
        // The loader flattens quantity sets (names lost), so Qto_*/
        // BaseQuantities requests search quantity names directly.
        if (f.propertySet && 'simple' in f.propertySet && /^(qto_|basequantities$)/i.test(f.propertySet.simple) && p.quantities) {
          Object.keys(p.quantities).forEach(function(qk) {
            var qm = _matchValue(f.baseName, qk);
            if (qm === null) { unchecked = true; return; }
            if (qm && p.quantities[qk] != null && String(p.quantities[qk]).trim() !== '') hits.push(p.quantities[qk]);
          });
        }
        if (!hits.length) return unchecked ? null : { present: false, matches: false };
        if (!f.value) return { present: true, matches: true };
        var any = false, anyNull = false;
        hits.forEach(function(v) {
          var m = _matchValue(f.value, v);
          if (m === null) anyNull = true; else if (m) any = true;
        });
        if (any) return { present: true, matches: true };
        return anyNull ? null : { present: true, matches: false };
      }
      case 'classification': {
        var cands = _classificationCandidates(p);
        if (!cands.length) return { present: false, matches: false };
        if (!f.system && !f.value) return { present: true, matches: true };
        var hit = false, sysUnknown = false;
        for (var ci = 0; ci < cands.length; ci++) {
          var c = cands[ci];
          var vOk = f.value ? _matchValue(f.value, c.code) : true;
          if (vOk !== true) continue;
          if (!f.system) { hit = true; break; }
          // We only know the pset/key the code came from, not the declared
          // classification system — try both, else report unverifiable.
          var sOk = _matchValue(f.system, c.system);
          var sOk2 = sOk === true ? true : _matchValue(f.system, c.key);
          if (sOk === true || sOk2 === true) { hit = true; break; }
          sysUnknown = true;
        }
        if (hit) return { present: true, matches: true };
        return sysUnknown ? null : { present: true, matches: false };
      }
      case 'material': {
        var mat = String(p.material || '').trim();
        if (!mat) return { present: false, matches: false };
        if (!f.value) return { present: true, matches: true };
        var segs = mat.split(/[;,|]+/).map(function(s) { return s.trim(); }).filter(Boolean);
        segs.push(mat);
        var mAny = false, mNull = false;
        segs.forEach(function(sv) {
          var m = _matchValue(f.value, sv);
          if (m === null) mNull = true; else if (m) mAny = true;
        });
        if (mAny) return { present: true, matches: true };
        return mNull ? null : { present: true, matches: false };
      }
      case 'partOf': {
        var rel = String(f.relation || '').toUpperCase();
        if (rel && rel !== 'IFCRELCONTAINEDINSPATIALSTRUCTURE') return null; // only containment is extracted
        if (f.entity) {
          var pe = _matchEntity(f.entity, 'IFCBUILDINGSTOREY');
          if (pe !== true) return null; // container types other than storey unsupported
        }
        var st = String(p.storey || '').trim();
        return { present: !!st, matches: !!st };
      }
    }
    return null;
  }

  // Applicability semantics: the facet must be present AND match.
  function _facetHolds(f, p) {
    var r = _facetEval(f, p);
    if (r === null) return null;
    return r.present && r.matches === true;
  }

  // Requirement semantics: honour the facet cardinality.
  function _facetRequired(f, p) {
    var r = _facetEval(f, p);
    if (r === null) return null;
    var hit = r.present && r.matches === true;
    if (f.cardinality === 'prohibited') return !hit;
    if (f.cardinality === 'optional') return !r.present || r.matches === true;
    return hit;
  }

  function _reqDesc(f) {
    var pre = f.cardinality === 'prohibited' ? 'Must not have ' : f.cardinality === 'optional' ? 'If present: ' : 'Required: ';
    return pre + _facetDesc(f);
  }

  // Execute parsed IDS specifications against the loaded models.
  // Output shape matches the core's IDS results pipeline
  // (results rows + summary.bySpec) so the existing panel renders it.
  function runIDSSpecs(specs, models) {
    var results = [];
    var summary = { total: 0, pass: 0, fail: 0, bySpec: {} };
    (specs || []).forEach(function(spec) {
      var bs = { pass: 0, fail: 0, applicable: 0, unchecked: 0, notes: [] };
      summary.bySpec[spec.name] = bs;
      var appNull = false;
      function note(msg) { if (bs.notes.indexOf(msg) < 0) bs.notes.push(msg); }
      function row(desc, el, p, model) {
        results.push({
          specName: spec.name, ruleDesc: desc, severity: 'error', status: 'fail',
          elementId: el.expressId, globalId: p.globalId || '', ifcType: p.ifcType || '',
          elementName: p.name || ('#' + el.expressId), modelId: model.id, storey: p.storey || ''
        });
      }
      (models || []).forEach(function(model) {
        if (model.visible === false) return;
        (model.elements || []).forEach(function(el) {
          var p = el.props || {};
          var applies = true;
          for (var i = 0; i < spec.applicability.length; i++) {
            var h = _facetHolds(spec.applicability[i], p);
            if (h === null) {
              appNull = true;
              note('Applicability "' + _facetDesc(spec.applicability[i]) + '" not checkable in-browser');
              applies = false; break;
            }
            if (!h) { applies = false; break; }
          }
          if (!applies) return;
          bs.applicable++;
          if (spec.cardinality === 'prohibited') {
            summary.total++; summary.fail++; bs.fail++;
            row('Prohibited: no elements may match this applicability', el, p, model);
            return;
          }
          var elFailed = false, elUnchecked = false;
          spec.requirements.forEach(function(f) {
            if (f.type === 'property' && f.dataType) note('dataType "' + f.dataType + '" not checked (value-only comparison)');
            var res = _facetRequired(f, p);
            if (res === null) { elUnchecked = true; note('Requirement "' + _facetDesc(f) + '" not checkable in-browser'); return; }
            summary.total++;
            if (res) { summary.pass++; }
            else { summary.fail++; elFailed = true; row(_reqDesc(f), el, p, model); }
          });
          if (elUnchecked) bs.unchecked++;
          if (elFailed) bs.fail++; else bs.pass++;
        });
      });
      if (spec.cardinality === 'required' && bs.applicable === 0) {
        if (appNull) note('Specification skipped (unsupported applicability)');
        else {
          note('No applicable elements found — this specification requires at least one');
          summary.total++; summary.fail++; bs.fail++;
        }
      }
      bs.note = bs.notes.join(' · ');
    });
    return { results: results, summary: summary };
  }

  // ── IDS Import (summary) ─────────────────────────────────────────
  // Parses an IDS XML file and returns a human-readable summary of the
  // specifications (used to preview what a file contains). Built on the
  // same parser as the execution engine.

  function importIDS(xmlString) {
    var parsed = parseIDSSpec(xmlString);
    if (parsed.error) return { error: parsed.error };
    var rules = parsed.specs.map(function(sp) {
      var entity = '*';
      sp.applicability.forEach(function(f) { if (f.type === 'entity' && f.name) entity = _vsDesc(f.name); });
      return { name: sp.name, entity: entity, requirements: sp.requirements.map(_facetDesc) };
    });
    return { title: parsed.title, ruleCount: rules.length, rules: rules };
  }

  // ── Expose on window for DataQualityPanel in index.html ───────────
  // Not registered as an addon — the check engines are always available
  // and the UI lives in the Data Quality tab (see DataQualityPanel in index.html).

  window._ccRunDataQualityChecks = runDataQualityChecks;
  window._ccRunBIMModelChecks = runBIMModelChecks;
  window._ccRunILSChecks = runILSChecks;
  window._ccRunRVBChecks = runRVBChecks;
  window._ccNLSFB_TABLE1 = NLSFB_TABLE1;
  window._ccExportIDS = exportIDS;
  window._ccImportIDS = importIDS;
  window._ccParseIDS = parseIDSSpec;
  window._ccRunIDS = runIDSSpecs;

  // ── ClashControl Quality Score (0–100) ───────────────────────────
  // Single-number summary across the existing data-quality + accessibility
  // checks. Same product framing as paid tools like Nokah — but computed
  // from rules you can read in this file (open + auditable).
  //
  // Score = 100 * (1 - weighted_failure_ratio).
  // Per-check severity weights: error=3, warn=2, info=1.
  // Each check contributes (fail_count / total_relevant_elements) * weight
  // to "damage"; damage is normalised against the sum of all weights.
  //
  // Cached by a signature of model ids+element counts so the score doesn't
  // recompute on every panel render.
  var _scoreCache = {};
  function _sigForState(elements, models) {
    return (models||[]).map(function(m){ return m.id+':'+((m.elements||[]).length); }).join('|') + '|n=' + (elements||[]).length;
  }
  function computeQualityScore(elements, models, opts) {
    opts = opts || {};
    var sig = _sigForState(elements, models);
    if (!opts.force && _scoreCache[sig]) return _scoreCache[sig];

    var W = { error: 3, warn: 2, info: 1 };
    var totalWeight = 0, damage = 0;
    var breakdown = { categories: [] };

    // Shared by any check engine returning the {checkKey:{count,sev}} map
    // shape (runDataQualityChecks / runBIMModelChecks / runILSChecks all do).
    // fold=false still adds the category to the breakdown for visibility but
    // keeps it out of the single headline number - see the ILS call below.
    function _foldCheckMap(label, checksResult, fold) {
      if (!checksResult) return;
      var total = checksResult._total || (elements||[]).length || 1;
      var catDamage = 0, catWeight = 0, catChecks = 0;
      Object.keys(checksResult).forEach(function(k){
        if (k.charAt(0) === '_') return;
        var c = checksResult[k]; if (!c || typeof c.count !== 'number') return;
        catChecks++;
        var w = W[c.sev] || 1;
        var fail = Math.min(1, c.count / total);
        catDamage += fail * w;
        catWeight += w;
      });
      if (fold) { damage += catDamage; totalWeight += catWeight; }
      breakdown.categories.push({
        label: label,
        score: catWeight ? Math.round(100 * (1 - catDamage / catWeight)) : 100,
        checks: catChecks,
        countsTowardScore: !!fold
      });
    }

    // ── Data quality checks ──
    try { _foldCheckMap('Data quality', runDataQualityChecks(elements), true); } catch(e) {}

    // ── BIM basics (FireRating, IsExternal, LoadBearing, classification,
    //    common psets, thickness) - generic, applies to any IFC model
    //    regardless of region, so always folds into the headline score. ──
    try { _foldCheckMap('BIM basics', runBIMModelChecks(elements), true); } catch(e) {}

    // ── ILS / NL-SfB (Dutch NL-BIM Basis ILS v2) - region/methodology
    //    specific. noNLSfB alone fires on every element with no NL-SfB
    //    classification at all (no type gating, unlike the BIM-basics
    //    checks above), so on a project that never adopted NL-SfB this
    //    category would always score near-zero for reasons that have
    //    nothing to do with actual data quality. Always shown as its own
    //    breakdown category (so Dutch users see the full picture), but
    //    only folded into the single headline number once the project is
    //    actually using NL-SfB (at least 20% of elements carry a code) -
    //    otherwise the check isn't applicable and shouldn't tank the score. ──
    try {
      var ils = runILSChecks(elements);
      var ilsTotal = ils._total || (elements||[]).length || 1;
      var noNLSfBCount = (ils.noNLSfB && ils.noNLSfB.count) || 0;
      var nlsfbAdopted = (ilsTotal - noNLSfBCount) / ilsTotal >= 0.2;
      _foldCheckMap('ILS / NL-SfB', ils, nlsfbAdopted);
    } catch(e) {}

    // ── Accessibility checks (if engine loaded) ──
    try {
      if (typeof window._ccRunAccessibilityChecks === 'function') {
        var acc = window._ccRunAccessibilityChecks(elements);
        if (acc && acc.groups) {
          var accDamage = 0, accWeight = 0, accChecks = 0;
          Object.keys(acc.groups).forEach(function(k){
            var g = acc.groups[k];
            if (!g || !g.total) return;
            accChecks++;
            var w = (g.sev === 'hard' || g.sev === 'major') ? 3 : (g.sev === 'minor' ? 2 : 1);
            var fail = Math.min(1, (g.fail || 0) / g.total);
            accDamage += fail * w;
            accWeight += w;
          });
          if (accWeight) {
            damage += accDamage; totalWeight += accWeight;
            breakdown.categories.push({
              label: 'Accessibility',
              score: Math.round(100 * (1 - accDamage / accWeight)),
              checks: accChecks
            });
          }
        }
      }
    } catch(e) {}

    var score = totalWeight ? Math.round(100 * (1 - damage / totalWeight)) : null;
    var grade = score == null ? null : (score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F');
    var entry = { score: score, grade: grade, breakdown: breakdown, at: Date.now() };
    _scoreCache[sig] = entry;
    return entry;
  }
  window._ccComputeQualityScore = computeQualityScore;


  // Visible in the Addons panel as a built-in capability (the engines are
  // globals; the Data Quality panel itself lives in index.html).
  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'data-quality',
      alwaysOn: true,
      name: 'Data quality checks',
      description: 'BIM-basics, ILS and NL-SfB classification check engines behind the Data Quality panel — naming, classification, property completeness, plus a buildingSMART IDS 1.0 engine (parse, execute against the loaded models, import/export).'
    });
  }
})();
