// ── ClashControl Addon: Data Quality Check Engines ──────────────
// Contains the general data quality and BIM-basics checks, the generic
// engine for national data standards declared by country packs
// (regulations/*.json, dataQuality.standards) and the IDS 1.0 engine.
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
      noGlobalId:[],emptyGeometry:[],duplicateName:[],noDescription:[],noProperties:[],
      roomNoBoundaries:[],boundaryMissingElement:[]};
    // Space boundaries (IfcRelSpaceBoundary) — read through the core's
    // guarded adjacency getter, per model. Only models that carry boundaries
    // at all are checked: a file without them is not an error here.
    var _adjByModel = {}, _spaceGid = {};
    function _adjOf(modelId) {
      if (modelId == null || typeof window._ccSpaceAdjacency !== 'function') return null;
      if (_adjByModel[modelId] === undefined) {
        var a = null;
        try { a = window._ccSpaceAdjacency(modelId); } catch (e) { a = null; }
        _adjByModel[modelId] = (a && a.boundaryCount > 0) ? a : null;
      }
      return _adjByModel[modelId];
    }
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
      if (p.ifcType === 'IfcSpace') {
        _spaceGid[el._modelId + ':' + el.expressId] = p.globalId || '';
        var adj = _adjOf(el._modelId);
        if (adj && !(adj.perSpace && adj.perSpace[el.expressId])) acc.roomNoBoundaries.push(it);
      }
    });
    Object.keys(_adjByModel).forEach(function(mid) {
      var adj = _adjByModel[mid];
      if (!adj || !adj.missingElements) return;
      adj.missingElements.forEach(function(mx) {
        // Reported on the room (its GlobalId drives 3D highlight / +issue).
        acc.boundaryMissingElement.push({name:'#' + mx.element + ' (room #' + mx.space + ')', gid:_spaceGid[mid + ':' + mx.space] || '', ifcType:'IfcRelSpaceBoundary', el:null, detail:'→ #' + mx.element});
      });
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
      roomNoBoundaries:{label:'Rooms without space boundaries',     sev:'warn', count:acc.roomNoBoundaries.length,ex:acc.roomNoBoundaries.slice(0,6)},
      boundaryMissingElement:{label:'Space boundary → element not in model', sev:'warn', count:acc.boundaryMissingElement.length,ex:acc.boundaryMissingElement.slice(0,6)},
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

  // ── National data standards (from country packs) ──────────────────
  //
  // The core ships no country's standard. A country pack's
  // `dataQuality.standards` (regulations/*.json, validated by
  // country-pack-core.js) declares a standard as DATA: an element or model
  // scope, an optional classification block (where the code lives, its
  // format, group table and the groups each IFC class may use) and a list of
  // checks, each one of the generic rule kinds below with its label, severity
  // and parameters. Patterns are strings compiled through the core's
  // safeRegex gate — a pack can only ever be bad data, never code.

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
  function _re(src, flags) {
    var core = window._ccCountryPackCore;
    return (core && src) ? core.safeRegex(src, flags || '') : null;
  }
  function _tpl(t, vars) {
    return String(t).replace(/\{(\w+)\}/g, function(m, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; });
  }
  function _truthy(v) { return !!v && /^(true|1|yes)$/i.test(String(v)); }

  // Classification code of an element per the standard's classification
  // block: the last matching property wins; ObjectType patterns are the
  // fallback ("(21) Buitenwand", "21.12 ...").
  function _classCode(cls, psets, objectType) {
    var code = null;
    var keys = cls.keys || [], pc = cls.psetContains ? String(cls.psetContains).toLowerCase() : null, pk = cls.psetKeys || [];
    Object.keys(psets).forEach(function(ps) {
      var grp = psets[ps]||{};
      var psLower = ps.toLowerCase();
      Object.keys(grp).forEach(function(k) {
        var kl = k.toLowerCase();
        if (keys.indexOf(kl) >= 0 || (pc && psLower.indexOf(pc) >= 0 && pk.indexOf(kl) >= 0)) {
          var v = grp[k];
          if (v && String(v).trim()) code = String(v).trim();
        }
      });
    });
    if (!code && objectType) {
      var pats = cls.objectTypePatterns || [];
      for (var i = 0; i < pats.length && !code; i++) {
        var re = _re(pats[i]);
        var m = re && re.exec(objectType);
        if (m) code = m[1] != null ? m[1] : m[0];
      }
    }
    return code;
  }
  function _classStrip(code) { return String(code).replace(/[()]/g, '').trim(); }
  function _classGroup(cls, code) {
    if (!code) return null;
    var re = _re(cls.groupPattern);
    var m = re && re.exec(_classStrip(code));
    return m ? (m[1] != null ? m[1] : m[0]) : null;
  }

  var _ATTR_LABEL = {name:'Name', longName:'LongName', objectType:'ObjectType', description:'Description'};
  function _blank(v) { return !v || !String(v).trim(); }

  // Rule kinds evaluated on every element of their ifcTypes (no compliance
  // tally), before the per-element pass.
  var PREPASS_KINDS = {entityName:1, spaceCompleteness:1};

  function _runElementStandard(std, elements) {
    var cls = std.classification || null;
    var checks = std.checks || [];
    var acc = {};
    checks.forEach(function(ch) { acc[ch.id] = []; });
    var typeSet = {};
    (std.elementTypes || []).forEach(function(t) { typeSet[t] = 1; });
    var classDist = {};
    function addDist(code, el) {
      var g = _classGroup(cls, code);
      var label = g ? (g + ' ' + ((cls.groups || {})[g] || cls.unknownGroupLabel || '?')) : (cls.noCodeLabel || '(no code)');
      if (!classDist[label]) classDist[label] = [];
      classDist[label].push({expressId:el.expressId, modelId:el._modelId, name:(el.props||{}).name||'#'+el.expressId, ifcType:(el.props||{}).ifcType||'', code:code||''});
    }
    var minorMax = std.compliance && typeof std.compliance.minorMax === 'number' ? std.compliance.minorMax : 2;
    var compDist = {'Compliant':[], 'Minor issues':[], 'Major issues':[]};
    function inTypes(ch, t) { return !ch.ifcTypes || ch.ifcTypes.indexOf(t) >= 0; }
    function w(ch) { return typeof ch.weight === 'number' ? ch.weight : 1; }
    function withDetail(it, d) { return Object.assign({}, it, {detail: d}); }

    // Pre-pass: storey / space style checks on any element of their class.
    (elements||[]).forEach(function(el) {
      var p = el.props||{};
      var it = {name:p.name||('#'+el.expressId), gid:p.globalId, ifcType:p.ifcType, el:el};
      checks.forEach(function(ch) {
        if (!PREPASS_KINDS[ch.kind] || !inTypes(ch, p.ifcType)) return;
        if (ch.kind === 'entityName') {
          var sname = (p.name||'').trim();
          var re = _re(ch.pattern, ch.flags);
          if (!sname || (re && !re.test(sname))) acc[ch.id].push(withDetail(it, sname || ch.emptyDetail || ''));
        } else if (ch.kind === 'spaceCompleteness') {
          var missing = [];
          (ch.attrs || []).forEach(function(a) { if (_blank(p[a])) missing.push(_ATTR_LABEL[a] || a); });
          var ps = p.psets||{};
          (ch.props || []).forEach(function(pr) { if (_findPropValue(ps, pr) === null) missing.push(pr); });
          var q = p.quantities||{};
          (ch.quantities || []).forEach(function(qd) {
            var re2 = _re(qd.pattern, 'i'), has = false;
            Object.keys(q).forEach(function(qk) { if (re2 && re2.test(qk.trim()) && parseFloat(q[qk]) > 0) has = true; });
            if (!has) missing.push(qd.label);
          });
          if (missing.length) acc[ch.id].push(withDetail(it, missing.join(', ')));
        }
      });
    });

    // Per-element pass over the standard's element classes.
    (elements||[]).forEach(function(el) {
      var p = el.props||{};
      if (!typeSet[p.ifcType]) return;
      var psets = p.psets||{};
      var it = {name:p.name||('#'+el.expressId), gid:p.globalId, ifcType:p.ifcType, el:el};
      var issues = 0;
      var code = cls ? _classCode(cls, psets, p.objectType) : null;
      var codeState = !cls ? null : !code ? 'missing' : !((_re(cls.formatPattern) || {test:function(){return false;}}).test(_classStrip(code))) ? 'invalid' : 'ok';
      checks.forEach(function(ch) {
        if (PREPASS_KINDS[ch.kind] || !inTypes(ch, p.ifcType)) return;
        var bucket = acc[ch.id], v, re;
        switch (ch.kind) {
          case 'elementName':
            var nm = (p.name||'').trim(); re = _re(ch.pattern, ch.flags);
            if (!nm || (re && !re.test(nm))) { bucket.push(withDetail(it, nm || ch.emptyDetail || '')); issues += w(ch); }
            break;
          case 'propertyPattern':
            v = _findPropValue(psets, ch.prop); re = _re(ch.pattern, ch.flags);
            if (v && re && !re.test(String(v).trim())) { bucket.push(ch.detail ? withDetail(it, _tpl(ch.detail, {value:v})) : it); issues += w(ch); }
            break;
          case 'requiredWhen':
            if (_truthy(_findPropValue(psets, ch.when)) && !_findPropValue(psets, ch.require)) { bucket.push(it); issues += w(ch); }
            break;
          case 'materialPattern':
            re = _re(ch.pattern, ch.flags);
            if (_truthy(_findPropValue(psets, ch.when)) && p.material && re && !re.test(p.material)) { bucket.push(withDetail(it, p.material)); issues += w(ch); }
            break;
          case 'propertyValue':
            v = null;
            for (var i = 0; i < (ch.props||[]).length && !v; i++) v = _findPropValue(psets, ch.props[i]);
            re = _re(ch.pattern, ch.flags);
            if (!v || (re && !re.test(String(v).trim()))) { bucket.push(withDetail(it, v || ch.missingDetail || '')); issues += w(ch); }
            break;
          case 'classificationMissing':
            if (codeState === 'missing') { bucket.push(it); issues += w(ch); }
            break;
          case 'classificationFormat':
            if (codeState === 'invalid') { bucket.push(ch.detail ? withDetail(it, _tpl(ch.detail, {code:code})) : it); issues += w(ch); }
            break;
          case 'classificationExpected':
            if (codeState === 'ok') {
              var g = _classGroup(cls, code), allowed = (cls.expected || {})[p.ifcType];
              if (allowed && allowed[0] !== '--' && g && allowed.indexOf(g) < 0) {
                bucket.push(ch.detail ? withDetail(it, _tpl(ch.detail, {code:code, ifcType:p.ifcType, expected:allowed.join('/')})) : it);
                issues += w(ch);
              }
            }
            break;
          case 'requiredProps':
            var missingProps = [];
            ((ch.props||{})[p.ifcType] || []).forEach(function(prop) { if (!_findPropValue(psets, prop)) missingProps.push(prop); });
            if (missingProps.length) { bucket.push(withDetail(it, missingProps.join(', '))); issues += missingProps.length * w(ch); }
            break;
          case 'attribute':
            v = p[ch.attr];
            if (_blank(v) || (ch.notEqualAttr && String(v).trim() === p[ch.notEqualAttr])) { bucket.push(it); issues += w(ch); }
            break;
        }
      });
      if (cls) addDist(code, el);
      var elInfo = {expressId:el.expressId, modelId:el._modelId, name:p.name||'#'+el.expressId, ifcType:p.ifcType||''};
      if (issues === 0) compDist['Compliant'].push(elInfo);
      else if (issues <= minorMax) compDist['Minor issues'].push(elInfo);
      else compDist['Major issues'].push(elInfo);
    });

    var out = {};
    checks.forEach(function(ch) {
      if (ch.report === false) return;
      out[ch.id] = {label:ch.label, sev:ch.sev, cat:ch.cat, count:acc[ch.id].length, ex:acc[ch.id].slice(0,8)};
    });
    out._total = (elements||[]).length;
    if (cls) out._classDist = classDist;
    if (std.compliance) out._compDist = compDist;
    return out;
  }

  var _REQ_LABEL = {name:'Name', georefLatLon:'RefLatitude/RefLongitude', georefElevation:'RefElevation', objectType:'ObjectType', elevation:'Elevation'};
  var _ENTITY_IFC = {project:'IfcProject', site:'IfcSite', building:'IfcBuilding', zone:'IfcZone', storey:'IfcBuildingStorey'};
  function _entityMissing(ent, x, req) {
    var g = x && x.georef;
    switch (req) {
      case 'name': return ent === 'storey' ? !(x && x.name) : !(x && x._hasName);
      case 'georefLatLon': return !g || g.refLat == null || g.refLon == null;
      case 'georefElevation': return !g || g.refElev == null;
      case 'objectType': return !(x && x.objectType);
      case 'elevation': return !(x && x.hasElevation);
    }
    return false;
  }
  // Model-level standards: project / site / building / zone / storey metadata.
  function _runModelStandard(std, models) {
    var out = {};
    (std.checks || []).forEach(function(ch) {
      if (ch.kind !== 'spatialEntity') return;
      var fails = [], total = 0;
      (models||[]).forEach(function(m) {
        var sh = m.spatialHierarchy || {};
        var mName = m.name || m.id || 'model';
        var list = ch.entity === 'project' ? [sh.project || null]
          : ch.entity === 'site' ? (sh.sites||[]) : ch.entity === 'building' ? (sh.buildings||[])
          : ch.entity === 'zone' ? (sh.zones||[]) : (m.storeyData||[]);
        list.forEach(function(x) {
          total++;
          var missing = (ch.require||[]).filter(function(r) { return _entityMissing(ch.entity, x, r); }).map(function(r) { return _REQ_LABEL[r] || r; });
          if (!missing.length) return;
          fails.push({name: ch.entity === 'project' ? mName : mName + ' — ' + ((x && x.name) || ''), ifcType:_ENTITY_IFC[ch.entity], detail:missing.join(', ')});
        });
      });
      if (ch.report === false) return;
      out[ch.id] = {label:ch.label, sev:ch.sev, cat:ch.cat, count:fails.length, total:total, ex:fails.slice(0,8)};
    });
    out._total = (models||[]).length;
    return out;
  }

  // Every standard of every registered country pack:
  // [{key:'<region>:<id>', region, packName, std}].
  function dataQualityStandards() {
    var packs = (typeof window._ccGetCountryPacks === 'function' && window._ccGetCountryPacks()) || [];
    var out = [];
    packs.forEach(function(pk) {
      ((pk && pk.dataQuality && pk.dataQuality.standards) || []).forEach(function(std) {
        out.push({key: pk.region + ':' + std.id, region: pk.region, packName: pk.name, std: std});
      });
    });
    return out;
  }
  function _findStandard(ref) {
    if (ref && ref.std) return ref;
    var all = dataQualityStandards();
    for (var i = 0; i < all.length; i++) if (all[i].key === ref) return all[i];
    var active = (typeof window._ccGetRegulationRegion === 'function' && window._ccGetRegulationRegion()) || null;
    var byId = all.filter(function(e) { return e.std.id === ref; });
    return byId.filter(function(e) { return e.region === active; })[0] || byId[0] || null;
  }
  // Labels go through the locale (key country.<region>.<standard>.<check>),
  // falling back to the pack's own text.
  function _localize(entry, res) {
    if (typeof window._cc_t !== 'function') return res;
    Object.keys(res).forEach(function(k) {
      if (k.charAt(0) === '_' || !res[k] || !res[k].label) return;
      res[k].label = window._cc_t('country.' + entry.region + '.' + entry.std.id + '.' + k, res[k].label);
    });
    return res;
  }
  // Runs one standard ('ils', '<region>:ils' or a dataQualityStandards()
  // entry) on elements (scope 'elements') or models (scope 'models'); null
  // when no registered pack carries it.
  function runStandard(ref, input) {
    var entry = _findStandard(ref);
    if (!entry) return null;
    var res = entry.std.scope === 'models' ? _runModelStandard(entry.std, input) : _runElementStandard(entry.std, input);
    return _localize(entry, res);
  }
  // Share of elements that carry the standard's classification (the
  // classificationMissing check counts the ones without).
  function standardAdopted(entry, res, elements) {
    var std = entry && entry.std;
    if (!std || std.headline !== 'adoption' || !res) return false;
    var missCheck = (std.checks || []).filter(function(c) { return c.kind === 'classificationMissing'; })[0];
    var total = res._total || (elements || []).length || 1;
    var missing = (missCheck && res[missCheck.id] && res[missCheck.id].count) || 0;
    return (total - missing) / total >= (std.adoptionMin || 0.2);
  }
  // A standard applies when its pack is the active regional code (chosen, or
  // resolved from the models' address / CRS / site location), or when the
  // project demonstrably uses its classification. Otherwise its findings are
  // informational only (a project elsewhere would fail every check).
  function standardApplicability(ref, res) {
    var entry = _findStandard(ref);
    if (!entry) return {applicable:false, reason:'none'};
    var active = (typeof window._ccGetRegulationRegion === 'function' && window._ccGetRegulationRegion()) || null;
    if (active && active === entry.region) return {applicable:true, reason:'region'};
    if (standardAdopted(entry, res, null)) return {applicable:true, reason:'adopted'};
    return {applicable:false, reason:'none'};
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
          if (elFailed) bs.fail++; else if (!elUnchecked) bs.pass++;
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
  window._ccDataQualityStandards = dataQualityStandards;
  window._ccRunStandard = runStandard;
  window._ccStandardApplicability = standardApplicability;
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
    var region = (typeof window._ccGetRegulationRegion === 'function' && window._ccGetRegulationRegion()) || '';
    var packs = (typeof window._ccGetCountryPacks === 'function' && window._ccGetCountryPacks()) || [];
    return (models||[]).map(function(m){ return m.id+':'+((m.elements||[]).length); }).join('|') + '|n=' + (elements||[]).length +
      '|r=' + region + '|p=' + packs.map(function(p){ return p.region; }).join(',');
  }
  function computeQualityScore(elements, models, opts) {
    opts = opts || {};
    var sig = _sigForState(elements, models);
    if (!opts.force && _scoreCache[sig]) return _scoreCache[sig];

    var W = { error: 3, warn: 2, info: 1 };
    var totalWeight = 0, damage = 0;
    var breakdown = { categories: [] };

    // Shared by any check engine returning the {checkKey:{count,sev}} map
    // shape (runDataQualityChecks / runBIMModelChecks / element standards).
    // fold=false still adds the category to the breakdown for visibility but
    // keeps it out of the single headline number - see the standards below.
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

    // Like _foldCheckMap, but for check maps whose buckets each carry their
    // OWN denominator (checksResult[k].total) instead of sharing one
    // checksResult._total - a model-scope standard mixes project/site/
    // building/zone/storey counts, which aren't the same population, so a
    // single shared total would misstate every bucket's failure ratio.
    function _foldEntityCheckMap(label, checksResult, fold) {
      if (!checksResult) return;
      var catDamage = 0, catWeight = 0, catChecks = 0;
      Object.keys(checksResult).forEach(function(k){
        if (k.charAt(0) === '_') return;
        var c = checksResult[k]; if (!c || typeof c.count !== 'number') return;
        var total = (typeof c.total === 'number' && c.total > 0) ? c.total : 1;
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

    // ── National data standards (country packs) - each applicable standard
    //    is its own breakdown category. Whether it also folds into the
    //    headline number is the standard's own `headline` rule: 'adoption'
    //    = only once the project actually uses its classification (share of
    //    elements carrying a code >= adoptionMin; a project that never
    //    adopted it would otherwise score near zero for reasons that have
    //    nothing to do with data quality), 'never' = shown for visibility
    //    only (a single client's norm), 'always'. ──
    dataQualityStandards().forEach(function(entry) {
      try {
        var isModels = entry.std.scope === 'models';
        var res = runStandard(entry, isModels ? models : elements);
        if (!res || !standardApplicability(entry, res).applicable) return;
        var fold = entry.std.headline === 'always' || (entry.std.headline === 'adoption' && standardAdopted(entry, res, elements));
        if (isModels) _foldEntityCheckMap(entry.std.label, res, fold);
        else _foldCheckMap(entry.std.label, res, fold);
      } catch(e) {}
    });

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

  // ── DQ re-run reconciliation ──────────────────────────────────────
  // Clash detection has full GUID-identity reconciliation (new/persisting/
  // auto-resolved, computeClashIdentityKey/mergeDetectionResults in
  // index.html); Data Quality re-runs just overwrote the previous result
  // with no trend at all. A true per-element identity diff (like clashes
  // get) would need every check bucket to also return its full, uncapped
  // GlobalId list - today `ex` is deliberately capped (6-8 items) for
  // display, so it can't answer "is this SPECIFIC element still failing".
  // This reconciles at the check level instead: did THIS check's count go
  // up, down, or stay the same since the last run - same "was N, now M"
  // framing the clash trend sparkline already uses, without requiring an
  // engine-shape change. Prefixed by engine name since bucket keys may
  // collide across engines (a standard's check id can repeat a general one).
  function flattenDQCounts(results) {
    var flat = {};
    Object.keys(results || {}).forEach(function(engineName) {
      var r = results[engineName];
      if (!r) return;
      Object.keys(r).forEach(function(k) {
        if (k.charAt(0) === '_') return;
        var c = r[k];
        if (!c || typeof c.count !== 'number') return;
        flat[engineName + ':' + k] = { count: c.count, label: c.label, sev: c.sev };
      });
    });
    return flat;
  }
  window._ccFlattenDQCounts = flattenDQCounts;

  function diffDQCounts(current, previous) {
    var worse = [], better = [], unchangedCount = 0;
    Object.keys(current || {}).forEach(function(key) {
      var cur = current[key];
      var prevCount = (previous && previous[key]) ? previous[key].count : 0;
      if (cur.count > prevCount) worse.push({ key: key, label: cur.label, sev: cur.sev, from: prevCount, to: cur.count });
      else if (cur.count < prevCount) better.push({ key: key, label: cur.label, sev: cur.sev, from: prevCount, to: cur.count });
      else unchangedCount++;
    });
    worse.sort(function(a, b) { return (b.to - b.from) - (a.to - a.from); });
    better.sort(function(a, b) { return (a.to - a.from) - (b.to - b.from); });
    return { worse: worse, better: better, unchangedCount: unchangedCount };
  }
  window._ccDiffDQCounts = diffDQCounts;

  // Visible in the Addons panel as a built-in capability (the engines are
  // globals; the Data Quality panel itself lives in index.html).
  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'data-quality',
      alwaysOn: true,
      name: 'Data quality checks',
      description: 'General and BIM-basics check engines behind the Data Quality panel, national data standards from country packs (rules as data), plus a buildingSMART IDS 1.0 engine (parse, execute against the loaded models, import/export).'
    });
  }
})();
