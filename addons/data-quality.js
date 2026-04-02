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
    IfcDistributionElement:['52','53','54','55','56','57','61','62','63','64']
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

  function runILSChecks(elements) {
    var acc = {
      noNLSfB: [], invalidNLSfB: [], mismatchNLSfB: [],
      noDescription: [], noMaterial: [], noStorey: [],
      missingILSProp: [], noObjectType: [], noName: []
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

    (elements||[]).forEach(function(el) {
      var p = el.props||{};
      if (!PHYSICAL[p.ifcType]) return;
      var psets = p.psets||{};
      var it = {name:p.name||('#'+el.expressId), gid:p.globalId, ifcType:p.ifcType, el:el};
      var issues = 0;

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
      _total: (elements||[]).length,
      _nlsfbDist: nlsfbDist,
      _compDist: ilsCompDist
    };
  }

  // ── Expose on window for DataQualityPanel in index.html ───────────

  window._ccRunDataQualityChecks = runDataQualityChecks;
  window._ccRunBIMModelChecks = runBIMModelChecks;
  window._ccRunILSChecks = runILSChecks;
  window._ccNLSFB_TABLE1 = NLSFB_TABLE1;

  // Register as addon (no panel — the tab UI lives in index.html)
  window._ccRegisterAddon({
    id: 'data-quality',
    name: 'Data Quality Engines',
    description: 'General, BIM model, and ILS/NL-SfB check engines for the Data Quality tab.',
    autoActivate: true,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'
  });

})();
