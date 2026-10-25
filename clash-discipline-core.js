// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashDisciplineCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // ── What this module knows, and what it deliberately does NOT know ──────
  // Code here holds IFC-STANDARD knowledge only: entity classes, type-object
  // classes, PredefinedType enumerations and IfcDistributionSystem types.
  // Everything language- or country-specific is DATA registered at runtime:
  //   * name hints (file / system / type / element names) — an English
  //     built-in default (DEFAULT_HINTS below, JSON-shaped) plus a
  //     `disciplineHints` section any locale pack (locales/*.json) can carry.
  //     EVERY registered source applies, whatever the active UI language
  //     (a German model on a Dutch UI still matches the German hints).
  //   * classification-code tables (e.g. national element tables, Uniclass, OmniClass) — the
  //     `classifications` section of a country pack (regulations/*.json).
  //
  // Evidence order per element, with provenance (`src`) kept on the result:
  //   STATED   system      IfcSystem/IfcDistributionSystem membership
  //                        (IFC4 PredefinedType, a classification code in the
  //                        system name, then the system name's hints)
  //            classification  IfcClassificationReference codes via pack tables
  //            predefined-type element/type PredefinedType (IFC enums)
  //   INFERRED type-object  IfcRelDefinesByType type class (IFC2X3 MEP exports:
  //                        generic IfcFlowSegment + IfcDuctSegmentType …)
  //            entity       the element's own IFC class
  //            model        the model's majority discipline / sub-discipline
  //            name         element / type name hints
  //            default      nothing known
  // Top-level discipline of non-discriminating classes (walls, slabs, proxies)
  // stays with the model that authored them (team ownership) unless STATED
  // evidence says the element is MEP.

  // Shared IFC types (walls, slabs, roofs, spaces and proxies) are absent from
  // TYPE_MAP so they inherit the containing model's discipline.
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

  // ── MEP sub-disciplines ─────────────────────────────────────────────────
  // 'piping' = a pipe whose trade is not known yet (a pipe type, no system);
  // it is refined to heating / plumbing / fire by stated or model evidence.
  var SUBDISCIPLINES = Object.freeze(['ventilation', 'heating', 'plumbing', 'fire', 'electrical', 'piping']);
  var SUB_FAMILY = Object.freeze({ ventilation: 'air', heating: 'pipe', plumbing: 'pipe', fire: 'pipe', piping: 'pipe', electrical: 'elec' });
  var DISCIPLINES = Object.freeze(['architectural', 'structural', 'mep', 'civil', 'other']);
  var ROLES = Object.freeze(['provision', 'zone']);

  // Entity class -> sub-discipline (IFC-standard). Type-object classes are
  // the same names with a 'Type' suffix (plus a few IFC2X3 type-only classes).
  var ENTITY_SUB = {};
  (function() {
    var t = {
      ventilation: ['IfcDuctSegment','IfcDuctFitting','IfcDuctSilencer','IfcAirTerminal','IfcAirTerminalBox','IfcDamper','IfcFan','IfcFilter','IfcHumidifier','IfcAirToAirHeatRecovery','IfcEvaporativeCooler'],
      heating: ['IfcBoiler','IfcChiller','IfcCoolingTower','IfcSpaceHeater','IfcHeatExchanger','IfcCondenser','IfcCompressor','IfcEvaporator','IfcBurner','IfcTubeBundle','IfcCooledBeam','IfcElectricHeater'],
      plumbing: ['IfcSanitaryTerminal','IfcWasteTerminal','IfcStackTerminal','IfcInterceptor','IfcDistributionChamberElement','IfcGasTerminal'],
      fire: ['IfcFireSuppressionTerminal','IfcAlarm'],
      electrical: ['IfcCableCarrierSegment','IfcCableCarrierFitting','IfcCableSegment','IfcCableFitting','IfcJunctionBox','IfcLamp','IfcLightFixture','IfcOutlet','IfcElectricAppliance','IfcElectricDistributionBoard','IfcElectricFlowStorageDevice','IfcElectricGenerator','IfcElectricMotor','IfcMotorConnection','IfcTransformer','IfcSwitchingDevice','IfcProtectiveDevice','IfcProtectiveDeviceTrippingUnit','IfcCommunicationsAppliance','IfcAudioVisualAppliance','IfcSolarDevice','IfcElectricTimeControl','IfcController'],
      piping: ['IfcPipeSegment','IfcPipeFitting','IfcValve','IfcPump']
    };
    Object.keys(t).forEach(function(sub) { t[sub].forEach(function(c) { ENTITY_SUB[c] = sub; }); });
  })();
  Object.freeze(ENTITY_SUB);
  // Generic MEP type objects that say "MEP" but not which trade.
  var GENERIC_MEP_TYPES = { IfcDistributionElementType:1, IfcDistributionFlowElementType:1, IfcFlowSegmentType:1, IfcFlowFittingType:1, IfcFlowTerminalType:1, IfcFlowControllerType:1, IfcFlowMovingDeviceType:1, IfcFlowStorageDeviceType:1, IfcFlowTreatmentDeviceType:1, IfcEnergyConversionDeviceType:1, IfcTankType:1, IfcCoilType:1, IfcUnitaryEquipmentType:1, IfcSensorType:1, IfcActuatorType:1, IfcFlowMeterType:1 };

  // Canonical spelling for upper-case STEP names ('IFCDUCTSEGMENTTYPE').
  var CANON = {};
  function _canonAdd(n) { CANON[n.toUpperCase()] = n; }
  Object.keys(TYPE_MAP).forEach(_canonAdd);
  Object.keys(ENTITY_SUB).forEach(function(n) { _canonAdd(n); _canonAdd(n + 'Type'); });
  Object.keys(GENERIC_MEP_TYPES).forEach(_canonAdd);
  ['IfcBuildingElementProxy','IfcBuildingElementProxyType','IfcWall','IfcWallType','IfcSlab','IfcSlabType','IfcBeamType','IfcColumnType','IfcPileType','IfcFootingType','IfcMemberType','IfcPlateType','IfcCoveringType','IfcSpace','IfcSpaceType','IfcSpatialZone','IfcSpatialZoneType','IfcVirtualElement','IfcSystem','IfcDistributionSystem','IfcDistributionCircuit','IfcBuildingSystem','IfcZone','IfcGroup','IfcBuildingElementPartType','IfcDoorType','IfcWindowType','IfcDoorStyle','IfcWindowStyle','IfcStairType','IfcRailingType','IfcRoofType','IfcCurtainWallType','IfcFurnitureType','IfcOpeningElement'].forEach(_canonAdd);
  function canonicalIfcName(n) {
    if (!n) return '';
    var s = String(n);
    return CANON[s.toUpperCase()] || s;
  }

  // IFC4 IfcDistributionSystemEnum -> sub-discipline.
  var SYSTEM_PREDEF_SUB = {
    AIRCONDITIONING:'ventilation', EXHAUST:'ventilation', VENTILATION:'ventilation',
    CHILLEDWATER:'heating', CONDENSERWATER:'heating', HEATING:'heating', REFRIGERATION:'heating',
    DOMESTICCOLDWATER:'plumbing', DOMESTICHOTWATER:'plumbing', DRAINAGE:'plumbing', RAINWATER:'plumbing', SEWAGE:'plumbing',
    STORMWATER:'plumbing', WASTEWATER:'plumbing', WATERSUPPLY:'plumbing', VENT:'plumbing', DISPOSAL:'plumbing',
    GAS:'piping', FUEL:'piping', OIL:'piping', COMPRESSEDAIR:'piping', VACUUM:'piping', CHEMICAL:'piping', HAZARDOUS:'piping',
    FIREPROTECTION:'fire',
    AUDIOVISUAL:'electrical', COMMUNICATION:'electrical', CONTROL:'electrical', DATA:'electrical', EARTHING:'electrical',
    ELECTRICAL:'electrical', ELECTROACOUSTIC:'electrical', LIGHTING:'electrical', LIGHTNINGPROTECTION:'electrical',
    POWERGENERATION:'electrical', SECURITY:'electrical', SIGNAL:'electrical', TELEPHONE:'electrical', TV:'electrical'
  };
  var SYSTEM_CLASSES = { IfcSystem:1, IfcDistributionSystem:1, IfcDistributionCircuit:1 };
  var ZONE_GROUP_CLASSES = { IfcZone:1 };

  // Element / type PredefinedType (IFC enums) -> sub-discipline or role.
  // Keyed by "<class without Type suffix>.<VALUE>", or "*.<VALUE>" for any class.
  var PREDEF = {
    '*.PROVISIONFORVOID': { role: 'provision' }, '*.PROVISIONFORSPACE': { role: 'provision' },
    'IfcSensor.SMOKESENSOR': { sub: 'fire' }, 'IfcSensor.HEATSENSOR': { sub: 'fire' }, 'IfcSensor.FLAMESENSOR': { sub: 'fire' }, 'IfcSensor.FIRESENSOR': { sub: 'fire' },
    'IfcAlarm.MANUALPULLBOX': { sub: 'fire' }, 'IfcAlarm.BREAKGLASSBUTTON': { sub: 'fire' },
    'IfcValve.FAUCET': { sub: 'plumbing' }, 'IfcValve.DRAWOFFCOCK': { sub: 'plumbing' }, 'IfcValve.FLUSHING': { sub: 'plumbing' }, 'IfcValve.GASCOCK': { sub: 'piping' }, 'IfcValve.GASTAP': { sub: 'piping' },
    'IfcTank.EXPANSION': { sub: 'heating' }, 'IfcTank.FEEDANDEXPANSION': { sub: 'heating' }, 'IfcTank.BREAKPRESSURE': { sub: 'plumbing' },
    'IfcUnitaryEquipment.AIRHANDLER': { sub: 'ventilation' }, 'IfcUnitaryEquipment.AIRCONDITIONINGUNIT': { sub: 'ventilation' },
    'IfcUnitaryEquipment.DEHUMIDIFIER': { sub: 'ventilation' }, 'IfcUnitaryEquipment.ROOFTOPUNIT': { sub: 'ventilation' }, 'IfcUnitaryEquipment.SPLITSYSTEM': { sub: 'ventilation' },
    'IfcCoil.HYDRONICCOIL': { sub: 'heating' }, 'IfcCoil.WATERCOOLINGCOIL': { sub: 'heating' }, 'IfcCoil.WATERHEATINGCOIL': { sub: 'heating' },
    'IfcPipeSegment.GUTTER': { sub: 'plumbing' }, 'IfcPump.SUMPPUMP': { sub: 'plumbing' }, 'IfcPump.SUBMERSIBLEPUMP': { sub: 'plumbing' }, 'IfcPump.CIRCULATOR': { sub: 'heating' },
    'IfcFireSuppressionTerminal.SPRINKLER': { sub: 'fire' }
  };
  function _predefLookup(cls, value) {
    if (!value) return null;
    var v = String(value).replace(/^\./, '').replace(/\.$/, '').toUpperCase();
    if (!v || v === 'NOTDEFINED' || v === 'USERDEFINED') return null;
    var base = String(cls || '').replace(/Type$/, '').replace(/Style$/, '');
    return PREDEF[base + '.' + v] || PREDEF['*.' + v] || null;
  }
  // Classes whose meaning comes only from evidence (names / roles may apply).
  var PROXY_LIKE = { IfcBuildingElementProxy:1, IfcProxy:1, IfcSpatialZone:1, IfcVirtualElement:1, Element:1, IfcBuildingElementPart:1 };

  // ── Name hints (data) ───────────────────────────────────────────────────
  // English built-in default. Same shape as a locale pack's `disciplineHints`.
  // Tokens match as a whole-word PREFIX ("architecture" matches "arch";
  // "mark" does NOT match "ark"); a token containing a space or hyphen, or
  // written in a script without word spacing (CJK), matches as a substring.
  var DEFAULT_HINTS = {
    disciplines: {
      architectural: ['arch', 'archi', 'architect', 'ark'],
      mep: ['mep', 'hvac', 'plumbing', 'electrical', 'mechanical'],
      structural: ['str', 'struct'],
      civil: ['civi', 'infra', 'bridge']
    },
    subDisciplines: {
      ventilation: ['vent', 'ventilation', 'duct', 'ductwork', 'air', 'exhaust', 'extract', 'supply air', 'return air', 'ahu'],
      heating: ['heating', 'cooling', 'chilled', 'radiator', 'hydronic', 'hot water', 'lthw', 'chw', 'underfloor'],
      plumbing: ['plumbing', 'sanitary', 'drainage', 'drain', 'sewer', 'sewage', 'waste', 'water', 'domestic', 'rainwater', 'storm', 'soil'],
      fire: ['sprinkler', 'sprinklers', 'fire', 'hydrant', 'wet riser', 'dry riser'],
      electrical: ['elec', 'electrical', 'lighting', 'light', 'power', 'cable', 'tray', 'busbar', 'data', 'comms', 'socket', 'switch', 'luminaire']
    },
    roles: {
      provision: ['provision', 'provisions', 'reservation', 'sleeve', 'builderswork', 'void'],
      zone: ['compartment', 'fire zone', 'firezone', 'smoke zone', 'fire compartment']
    }
  };
  var _HINT_SECTIONS = { disciplines: DISCIPLINES, subDisciplines: ['ventilation', 'heating', 'plumbing', 'fire', 'electrical'], roles: ROLES };
  // Tie-break order when several sub-disciplines score equally.
  var SUB_ORDER = ['fire', 'ventilation', 'electrical', 'heating', 'plumbing'];

  // Structural check of a hints object (shared with scripts/validate-locale.js).
  // Returns a list of error strings ([] = valid).
  function validateHints(h) {
    var errs = [];
    if (!h || typeof h !== 'object' || Array.isArray(h)) return ['disciplineHints must be an object'];
    Object.keys(h).forEach(function(sec) {
      var allowed = _HINT_SECTIONS[sec];
      if (!allowed) { errs.push('disciplineHints.' + sec + ' is not a known section (disciplines, subDisciplines, roles)'); return; }
      var v = h[sec];
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push('disciplineHints.' + sec + ' must be an object'); return; }
      Object.keys(v).forEach(function(k) {
        if (allowed.indexOf(k) < 0) { errs.push('disciplineHints.' + sec + '.' + k + ' is not one of: ' + allowed.join(', ')); return; }
        var list = v[k];
        if (!Array.isArray(list)) { errs.push('disciplineHints.' + sec + '.' + k + ' must be an array of strings'); return; }
        if (list.length > 200) errs.push('disciplineHints.' + sec + '.' + k + ' has more than 200 tokens');
        list.forEach(function(tok, i) {
          if (typeof tok !== 'string' || !tok.trim() || tok.length > 40) errs.push('disciplineHints.' + sec + '.' + k + '[' + i + '] must be a non-empty string of at most 40 characters');
          else if (/[<>]|javascript:/i.test(tok)) errs.push('disciplineHints.' + sec + '.' + k + '[' + i + '] contains a disallowed character');
        });
      });
    });
    return errs;
  }

  var _hintSources = {};      // id -> normalized hints
  var _hintOrder = [];
  var _compiled = null;       // merged {section: {key: [token...]}}
  var _dataVersion = 0;
  function _normHints(h) {
    var out = {};
    Object.keys(_HINT_SECTIONS).forEach(function(sec) {
      out[sec] = {};
      var v = h && h[sec];
      if (!v || typeof v !== 'object') return;
      Object.keys(v).forEach(function(k) {
        if (_HINT_SECTIONS[sec].indexOf(k) < 0 || !Array.isArray(v[k])) return;
        out[sec][k] = v[k].filter(function(t) { return typeof t === 'string' && t.trim(); })
          .map(function(t) { return t.trim().toLowerCase(); });
      });
    });
    return out;
  }
  // Registers (or replaces) one source of name hints, e.g. 'locale:nl'.
  // Returns false when the hints object is malformed (nothing registered).
  function registerHints(sourceId, hints) {
    if (!sourceId || validateHints(hints).length) return false;
    if (!_hintSources[sourceId]) _hintOrder.push(String(sourceId));
    _hintSources[sourceId] = _normHints(hints);
    _compiled = null; _dataVersion++;
    return true;
  }
  function unregisterHints(sourceId) {
    if (!_hintSources[sourceId] || sourceId === 'builtin') return false;
    delete _hintSources[sourceId];
    _hintOrder = _hintOrder.filter(function(x) { return x !== sourceId; });
    _compiled = null; _dataVersion++;
    return true;
  }
  function hintSources() { return _hintOrder.slice(); }
  registerHints('builtin', DEFAULT_HINTS);
  _dataVersion = 0;

  function _compiledHints() {
    if (_compiled) return _compiled;
    var c = {};
    Object.keys(_HINT_SECTIONS).forEach(function(sec) {
      c[sec] = {};
      _HINT_SECTIONS[sec].forEach(function(k) {
        var seen = {}, list = [];
        _hintOrder.forEach(function(src) {
          ((_hintSources[src][sec] || {})[k] || []).forEach(function(t) { if (!seen[t]) { seen[t] = 1; list.push(t); } });
        });
        c[sec][k] = list;
      });
    });
    _compiled = c;
    return c;
  }

  var _CJK = /[぀-ヿ㐀-鿿가-힯]/;
  function _words(text) {
    var nm = String(text || '').toLowerCase();
    return { nm: nm, words: nm.split(/[^\p{L}\p{N}]+/u).filter(Boolean) };
  }
  function _tokenMatches(w, tok) {
    if (/[\s\-_./]/.test(tok) || _CJK.test(tok)) return w.nm.indexOf(tok) >= 0;
    for (var i = 0; i < w.words.length; i++) if (w.words[i].lastIndexOf(tok, 0) === 0) return true;
    return false;
  }
  function _anyToken(w, tokens) {
    for (var i = 0; i < tokens.length; i++) if (_tokenMatches(w, tokens[i])) return tokens[i];
    return null;
  }
  // Best key of a hint section for a text (by number of distinct matching
  // tokens; ties follow `order`). Returns {key, token} or null.
  function _bestHint(text, section, order) {
    if (!text) return null;
    var w = _words(text);
    if (!w.nm) return null;
    var c = _compiledHints()[section];
    var best = null, bestN = 0, bestTok = null;
    order.forEach(function(k) {
      var n = 0, first = null;
      (c[k] || []).forEach(function(t) { if (_tokenMatches(w, t)) { n++; if (!first) first = t; } });
      if (n > bestN) { best = k; bestN = n; bestTok = first; }
    });
    return best ? { key: best, token: bestTok } : null;
  }
  // File-name discipline hints keep the historical precedence
  // (architectural > mep > structural > civil): the first that matches wins.
  function _fileNameDiscipline(name) {
    if (!name) return null;
    var w = _words(name);
    if (!w.nm) return null;
    var c = _compiledHints().disciplines;
    var order = ['architectural', 'mep', 'structural', 'civil'];
    for (var i = 0; i < order.length; i++) {
      var tok = _anyToken(w, c[order[i]] || []);
      if (tok) return { key: order[i], token: tok };
    }
    return null;
  }
  function matchHint(text, section) {
    if (section === 'disciplines') return _fileNameDiscipline(text);
    if (section === 'subDisciplines') return _bestHint(text, 'subDisciplines', SUB_ORDER);
    if (section === 'roles') return _bestHint(text, 'roles', ['provision', 'zone']);
    return null;
  }

  // ── Classification tables (data, from country packs) ────────────────────
  // {id, name, aliases[], codePattern, source, map:{codePrefix: 'mep.ventilation'|'mep'|'role:provision'|...}}
  var _tables = [];
  function _normName(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
  function _parseTarget(v) {
    if (typeof v !== 'string') return null;
    if (v.indexOf('role:') === 0) { var r = v.slice(5); return ROLES.indexOf(r) >= 0 ? { role: r } : null; }
    var p = v.split('.');
    if (DISCIPLINES.indexOf(p[0]) < 0) return null;
    if (p.length === 1) return { d: p[0] };
    if (p[0] !== 'mep' || SUBDISCIPLINES.indexOf(p[1]) < 0 || p.length > 2) return null;
    return { d: 'mep', sub: p[1] };
  }
  // A pattern from data must stay cheap: bounded length, no nested quantifiers.
  function safePattern(src) {
    if (typeof src !== 'string' || !src || src.length > 200) return null;
    if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(src)) return null;
    try { return new RegExp(src); } catch (e) { return null; }
  }
  // Shared with scripts/validate-regulation.js.
  function validateClassificationTable(t) {
    var errs = [];
    if (!t || typeof t !== 'object' || Array.isArray(t)) return ['classification table must be an object'];
    if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.id)) errs.push('id must be a short lower-case slug');
    if (typeof t.name !== 'string' || !t.name.trim()) errs.push('name must be a non-empty string');
    if (typeof t.source !== 'string' || !t.source.trim()) errs.push('source is required — cite the published classification table');
    if (t.aliases != null && (!Array.isArray(t.aliases) || t.aliases.some(function(a) { return typeof a !== 'string' || !a.trim() || a.length > 60; }))) errs.push('aliases must be an array of non-empty strings');
    if (t.codePattern != null && !safePattern(t.codePattern)) errs.push('codePattern must be a valid, simple regular expression (max 200 chars, no nested quantifiers)');
    if (!t.map || typeof t.map !== 'object' || Array.isArray(t.map) || !Object.keys(t.map).length) errs.push('map must be a non-empty object of code prefix → target');
    else {
      var keys = Object.keys(t.map);
      if (keys.length > 2000) errs.push('map has more than 2000 entries');
      keys.forEach(function(k) {
        if (!k || k.length > 40) errs.push('map key "' + k + '" must be 1-40 characters');
        if (!_parseTarget(t.map[k])) errs.push('map["' + k + '"] must be "<discipline>", "mep.<sub-discipline>" or "role:<provision|zone>"');
      });
    }
    Object.keys(t).forEach(function(k) {
      if (['id', 'name', 'aliases', 'codePattern', 'source', 'map'].indexOf(k) < 0) errs.push('unknown classification table key: ' + k);
    });
    return errs;
  }
  function registerClassificationTable(t) {
    if (validateClassificationTable(t).length) return false;
    /** @type {any} */
    var entry = {
      id: t.id, name: t.name, source: t.source,
      aliases: [t.name].concat(t.aliases || []).map(_normName).filter(Boolean),
      re: t.codePattern ? safePattern(t.codePattern) : null,
      map: {}, prefixes: []
    };
    Object.keys(t.map).forEach(function(k) { entry.map[k] = _parseTarget(t.map[k]); });
    entry.prefixes = Object.keys(entry.map).sort(function(a, b) { return b.length - a.length; });
    _tables = _tables.filter(function(x) { return x.id !== t.id; });
    _tables.push(entry);
    _tables.sort(function(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    _dataVersion++;
    return true;
  }
  function classificationTables() { return _tables.map(function(t) { return { id: t.id, name: t.name, source: t.source }; }); }
  function _codeCandidates(code) {
    var s = String(code || '').trim();
    if (!s) return [];
    var out = [s];
    var re = /\(([^()]{1,40})\)/g, m;
    while ((m = re.exec(s))) { out.push(m[1].trim()); out.push(m[1].trim().split(/\s+/)[0]); }
    return out;
  }
  function _tableLookup(t, code) {
    for (var i = 0; i < t.prefixes.length; i++) if (code.lastIndexOf(t.prefixes[i], 0) === 0) return t.map[t.prefixes[i]];
    return null;
  }
  // ref: {sys, code}. Returns {table, code, target, by:'name'|'code-format'} or null.
  function lookupClassification(ref, opts) {
    if (!ref || !_tables.length) return null;
    var cands = _codeCandidates(ref.code);
    if (opts && opts.parenthesesOnly) cands = cands.slice(1);
    if (!cands.length) return null;
    var sys = _normName(ref.sys);
    var byName = sys ? _tables.filter(function(t) { return t.aliases.some(function(a) { return sys.indexOf(a) >= 0; }); }) : [];
    function tryTables(list, by) {
      for (var ti = 0; ti < list.length; ti++) {
        var t = list[ti];
        for (var ci = 0; ci < cands.length; ci++) {
          var c = cands[ci];
          if (!c) continue;
          if (t.re && !t.re.test(c)) continue;
          if (!t.re && by !== 'name') continue;
          var hit = _tableLookup(t, c);
          if (hit) return { table: t.name, code: c, target: hit, by: by };
        }
      }
      return null;
    }
    return tryTables(byName, 'name') || tryTables(_tables.filter(function(t) { return byName.indexOf(t) < 0 && t.re; }), 'code-format');
  }

  // ── Element classification ──────────────────────────────────────────────
  var _clsIntern = new Map();
  function _mk(o) {
    var k = [o.d, o.sub || '', o.src, o.ev || '', o.role || '', o.roleSrc || '', o.roleEv || '', o.dm ? 1 : 0].join('\u0001');
    var hit = _clsIntern.get(k);
    if (hit) return hit;
    var v = Object.freeze({ d: o.d, sub: o.sub || null, src: o.src, stated: STATED_SRC[o.src] === 1, ev: o.ev || '',
      role: o.role || null, roleSrc: o.roleSrc || null, roleEv: o.roleEv || '', dm: !!o.dm });
    if (_clsIntern.size < 200000) _clsIntern.set(k, v);
    return v;
  }
  var STATED_SRC = { system: 1, classification: 1, 'predefined-type': 1 };

  function _short(s, n) { s = String(s || ''); return s.length > (n || 60) ? s.slice(0, (n || 60) - 1) + '…' : s; }

  // Own evidence of one element (no model fallback).
  // Returns {d, dSrc, sub, src, ev, role, roleSrc, roleEv}.
  function _ownEvidence(el) {
    var p = (el && el.props) || {};
    var cls = p.ifcType || '';
    /** @type {any} */
    var r = { d: TYPE_MAP[cls] || null, dSrc: TYPE_MAP[cls] ? 'entity' : null, sub: null, src: null, ev: '', role: null, roleSrc: null, roleEv: '' };
    function setSub(sub, src, ev) { if (!r.sub || (r.sub === 'piping' && sub !== 'piping' && SUB_FAMILY[sub] === 'pipe')) { r.sub = sub; r.src = src; r.ev = ev; } }
    function setRole(role, src, ev) { if (!r.role) { r.role = role; r.roleSrc = src; r.roleEv = ev; } }
    var stMep = false;
    // STATED: system membership
    var groups = p.groups || [];
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      if (!g) continue;
      if (ZONE_GROUP_CLASSES[g.cls]) { setRole('zone', 'system', g.cls + ' "' + _short(g.name, 40) + '"'); continue; }
      if (!SYSTEM_CLASSES[g.cls]) continue;
      stMep = true;
      var evS = g.cls + ' "' + _short(g.name, 48) + '"';
      var ps = g.predef && SYSTEM_PREDEF_SUB[String(g.predef).replace(/\./g, '').toUpperCase()];
      if (ps) { setSub(ps, 'system', evS + ' ' + String(g.predef).replace(/\./g, '')); continue; }
      var lk = lookupClassification({ sys: '', code: g.name }, { parenthesesOnly: true }) || lookupClassification({ sys: '', code: g.objectType }, { parenthesesOnly: true });
      if (lk && lk.target.sub) { setSub(lk.target.sub, 'system', evS + ' → ' + lk.table + ' ' + lk.code); continue; }
      var hs = _bestHint([g.name, g.objectType].filter(Boolean).join(' '), 'subDisciplines', SUB_ORDER);
      if (hs) setSub(hs.key, 'system', evS + ' (“' + hs.token + '”)');
    }
    // STATED: classification references
    var crs = p.classification || [];
    for (var ci = 0; ci < crs.length; ci++) {
      var lk2 = lookupClassification(crs[ci]);
      if (!lk2) continue;
      var evC = lk2.table + ' ' + lk2.code + (lk2.by === 'code-format' && crs[ci].sys ? ' (code format; source says “' + _short(crs[ci].sys, 30) + '”)' : '');
      if (lk2.target.role) { setRole(lk2.target.role, 'classification', evC); continue; }
      if (lk2.target.d === 'mep') { stMep = true; if (lk2.target.sub) setSub(lk2.target.sub, 'classification', evC); else if (!r.src) { r.src = 'classification'; r.ev = evC; } }
    }
    // STATED: PredefinedType (element, then type)
    var tobj = p.typeObject || null;
    var pd = _predefLookup(cls, p.predefinedType) || (tobj && _predefLookup(tobj.cls, tobj.predef));
    if (pd) {
      var evP = (p.predefinedType && _predefLookup(cls, p.predefinedType) ? cls + '.' : (tobj ? tobj.cls + '.' : '')) +
        String((p.predefinedType && _predefLookup(cls, p.predefinedType)) ? p.predefinedType : tobj && tobj.predef).replace(/\./g, '');
      if (pd.role) setRole(pd.role, 'predefined-type', evP);
      if (pd.sub) setSub(pd.sub, 'predefined-type', evP);
    }
    if (stMep && !TYPE_MAP[cls]) { r.d = 'mep'; r.dSrc = r.src || 'system'; }
    else if (stMep && TYPE_MAP[cls] === 'mep') r.dSrc = 'entity';
    // INFERRED: type object class
    if (tobj && tobj.cls) {
      var tc = canonicalIfcName(tobj.cls), base = tc.replace(/Type$/, '').replace(/Style$/, '');
      var ts = ENTITY_SUB[base];
      if (ts) { setSub(ts, 'type-object', tc + (tobj.name ? ' "' + _short(tobj.name, 40) + '"' : '')); if (!r.d) { r.d = 'mep'; r.dSrc = 'type-object'; } }
      else if (GENERIC_MEP_TYPES[tc] && !r.d) { r.d = 'mep'; r.dSrc = 'type-object'; }
    }
    // INFERRED: entity class
    if (ENTITY_SUB[cls]) setSub(ENTITY_SUB[cls], 'entity', cls);
    if (cls === 'IfcSpatialZone') setRole('zone', 'entity', cls);
    // INFERRED: role name hints — only for classes whose meaning comes from
    // evidence (proxies, spatial zones …): a wall named "shaft" stays a wall.
    if (!r.role && (PROXY_LIKE[cls] || !cls)) {
      var hr = _bestHint([p.name, p.objectType, tobj && tobj.name].filter(Boolean).join(' '), 'roles', ['provision', 'zone']);
      if (hr) setRole(hr.key, 'name', '“' + hr.token + '”');
    }
    return r;
  }

  // ctx: {modelDisc, modelSub, modelRole, modelRoleSrc}
  function _finalize(el, own, ctx) {
    var p = (el && el.props) || {};
    var cls = p.ifcType || '';
    var d = own.d, sub = own.sub, src = own.src, ev = own.ev;
    var dSrc = own.dSrc;
    if (!d) { d = (ctx && ctx.modelDisc) || 'other'; dSrc = ctx && ctx.modelDisc ? 'model' : 'default'; }
    var role = own.role, roleSrc = own.roleSrc, roleEv = own.roleEv;
    var proxyLike = !!PROXY_LIKE[cls] || !cls;
    var nameText = [p.name, p.objectType, p.typeObject && p.typeObject.name].filter(Boolean).join(' ');
    if (!role && proxyLike && ctx && ctx.modelRole) { role = ctx.modelRole; roleSrc = 'model'; roleEv = ''; }
    // A provision / zone volume belongs to the model that drew it: a code
    // like "fire safety" on a compartment marker does not make it MEP.
    if (role && !TYPE_MAP[cls] && own.d && own.dSrc !== 'entity') {
      d = (ctx && ctx.modelDisc) || 'other'; dSrc = ctx && ctx.modelDisc ? 'model' : 'default'; sub = null; src = null; ev = '';
    }
    var _roleOwned = role && !TYPE_MAP[cls];
    if (d === 'mep') {
      if ((!sub || sub === 'piping') && ctx && ctx.modelSub && (!sub || SUB_FAMILY[ctx.modelSub] === 'pipe')) {
        sub = ctx.modelSub; src = 'model'; ev = '';
      }
      if (!sub || sub === 'piping') {
        var hs = _bestHint(nameText, 'subDisciplines', SUB_ORDER);
        if (hs && (!sub || SUB_FAMILY[hs.key] === 'pipe')) { sub = hs.key; src = 'name'; ev = '“' + hs.token + '”'; }
      }
    } else { sub = null; }
    if (!src || d !== 'mep') { src = dSrc || 'default'; ev = src === 'entity' ? cls : ev; }
    if (d === 'mep' && !sub && dSrc && src !== dSrc && !STATED_SRC[src]) src = dSrc;
    // dm: the top-level discipline came from the model, so it follows the
    // model's live discipline (a user re-labelling the model wins).
    return _mk({ d: d, sub: sub, src: src, ev: ev, role: role, roleSrc: roleSrc, roleEv: roleEv, dm: !own.d || !!_roleOwned });
  }

  function classifyElement(el, ctx) { return _finalize(el, _ownEvidence(el), ctx || {}); }

  // ── Model classification ────────────────────────────────────────────────
  function _isSpace(el) { return !!(el && el.props && el.props.ifcType === 'IfcSpace'); }

  // Classifies a whole model and (unless opts.stamp === false) stamps every
  // element with `el._ccCls`. Returns the model-level summary with provenance.
  function classifyModel(elements, name, opts) {
    elements = elements || [];
    var n = elements.length;
    var owns = new Array(n);
    var mep = 0, str = 0, arc = 0, civ = 0, stated = 0, statedMep = 0, counted = 0, tmep = 0;
    var subVotes = {}, subVotesPipe = {}, roleVotes = { provision: 0, zone: 0 }, roleCandidates = 0;
    for (var i = 0; i < n; i++) {
      var el = elements[i];
      var o = owns[i] = _ownEvidence(el);
      if (_isSpace(el)) continue;
      var cls = (el.props && el.props.ifcType) || '';
      if (o.role && o.roleSrc !== 'model') roleVotes[o.role]++;
      if (PROXY_LIKE[cls] || !cls || o.role) roleCandidates++;
      if (o.role) continue;
      counted++;
      var t = TYPE_MAP[cls];
      if (t === 'mep') mep++; else if (t === 'structural') str++; else if (t === 'architectural') arc++; else if (t === 'civil') civ++;
      if (STATED_SRC[o.src] || (o.d === 'mep' && o.dSrc !== 'entity' && o.dSrc !== 'type-object')) { stated++; if (o.d === 'mep') statedMep++; }
      if (o.d === 'mep' && o.dSrc === 'type-object') tmep++;
      if (o.sub) { subVotes[o.sub] = (subVotes[o.sub] || 0) + 1; if (SUB_FAMILY[o.sub] === 'pipe' && o.sub !== 'piping') subVotesPipe[o.sub] = (subVotesPipe[o.sub] || 0) + 1; }
    }
    // Model discipline: stated MEP majority > file-name hints > class ratio > default.
    var disc = null, dsrc = null, dev = '';
    var nonSpace = elements.filter(function(e) { return !_isSpace(e); }).length;
    if (counted >= 5 && statedMep >= counted * 0.5) { disc = 'mep'; dsrc = 'stated'; dev = statedMep + '/' + counted + ' elements in MEP systems / classified MEP'; }
    if (!disc) { var fh = _fileNameDiscipline(name); if (fh) { disc = fh.key; dsrc = 'file-name'; dev = '“' + fh.token + '”'; } }
    if (!disc) {
      var total = mep + str + arc + civ;
      var m = Math.max(mep, str, arc, civ);
      var lead = m === 0 ? null : (m === mep ? 'mep' : m === str ? 'structural' : m === civ ? 'civil' : 'architectural');
      if (lead) { disc = lead; dsrc = 'entity'; dev = m + '/' + total + ' typed elements'; }
    }
    if (!disc) {
      // A model with no discriminating classes at all: MEP type objects decide.
      if (tmep && tmep >= counted * 0.5) { disc = 'mep'; dsrc = 'type-object'; dev = tmep + ' MEP type objects'; }
    }
    if (!disc) { disc = 'architectural'; dsrc = 'default'; }
    // Model sub-discipline: dominant own sub (>= 80% of resolved MEP evidence).
    var subTotal = 0, subLead = null, subLeadN = 0;
    Object.keys(subVotes).forEach(function(k) { subTotal += subVotes[k]; if (subVotes[k] > subLeadN) { subLead = k; subLeadN = subVotes[k]; } });
    var modelSub = null, subSrc = null;
    if (disc === 'mep' && subTotal >= 3 && subLeadN >= subTotal * 0.8) { modelSub = subLead; subSrc = 'majority'; }
    // Pipe refinement: pipes without a system in a model whose resolved pipes are one trade.
    var pipeTotal = 0, pipeLead = null, pipeLeadN = 0;
    Object.keys(subVotesPipe).forEach(function(k) { pipeTotal += subVotesPipe[k]; if (subVotesPipe[k] > pipeLeadN) { pipeLead = k; pipeLeadN = subVotesPipe[k]; } });
    if (modelSub === 'piping' && pipeTotal >= 3 && pipeLeadN >= pipeTotal * 0.8) modelSub = pipeLead;
    else if (!modelSub && disc === 'mep' && pipeTotal >= 3 && pipeLeadN >= pipeTotal * 0.8 && subLead && SUB_FAMILY[subLead] === 'pipe') modelSub = pipeLead;
    if (!modelSub && disc === 'mep') {
      var fs = _bestHint(name, 'subDisciplines', SUB_ORDER);
      if (fs) { modelSub = fs.key; subSrc = 'file-name'; }
    }
    // Model role: most non-space elements are provisions / zones.
    var modelRole = null;
    ROLES.forEach(function(rl) { if (!modelRole && nonSpace >= 3 && roleVotes[rl] >= nonSpace * 0.6) modelRole = rl; });
    var ctx = { modelDisc: disc, modelSub: modelSub, modelRole: modelRole };
    /** @type {Object<string, number>} */
    var shares = { stated: 0, inferred: 0, model: 0, name: 0, default: 0 };
    var subs = {}, roles = {}, sigParts = [];
    for (var j = 0; j < n; j++) {
      var c = _finalize(elements[j], owns[j], ctx);
      if (!opts || opts.stamp !== false) elements[j]._ccCls = c;
      if (_isSpace(elements[j])) continue;
      var bucket = c.stated ? 'stated' : (c.src === 'type-object' || c.src === 'entity') ? 'inferred' : c.src === 'model' ? 'model' : c.src === 'name' ? 'name' : 'default';
      shares[bucket]++;
      var key = matrixKeyOf(c);
      subs[key] = (subs[key] || 0) + 1;
      if (c.role) roles[c.role] = (roles[c.role] || 0) + 1;
    }
    var tot = Math.max(1, nonSpace);
    Object.keys(shares).forEach(function(k) { shares[k] = Math.round(shares[k] / tot * 1000) / 1000; });
    Object.keys(subs).sort().forEach(function(k) { sigParts.push(k + '=' + subs[k]); });
    Object.keys(roles).sort().forEach(function(k) { sigParts.push('r:' + k + '=' + roles[k]); });
    return {
      discipline: disc, src: dsrc, ev: dev,
      sub: modelSub, subSrc: subSrc, role: modelRole,
      key: disc === 'mep' && modelSub ? 'mep.' + modelSub : disc,
      shares: shares, keys: subs, roles: roles,
      sig: sigParts.join(',') + '#' + disc + (modelSub ? '.' + modelSub : '') + (modelRole ? '!' + modelRole : '') + '#v' + _dataVersion
    };
  }

  function detectDiscipline(elements, name) {
    return classifyModel(elements, name, { stamp: false }).discipline;
  }

  // ── Clash matrix ────────────────────────────────────────────────────────
  function matrixKeyOf(c) { return c.d === 'mep' && c.sub ? 'mep.' + c.sub : c.d; }
  function elementDiscipline(el, modelDiscipline) {
    if (el && el._ccCls) return el._ccCls.dm && modelDiscipline ? modelDiscipline : el._ccCls.d;
    var t = (el && el.props && el.props.ifcType) || '';
    return TYPE_MAP[t] || modelDiscipline || 'other';
  }
  // Matrix key: 'mep.ventilation' etc. for classified MEP elements, otherwise
  // the top-level discipline (identical to the legacy key).
  function elementMatrixKey(el, modelDiscipline) {
    var c = el && el._ccCls;
    if (c) return c.dm && modelDiscipline && modelDiscipline !== c.d ? modelDiscipline : matrixKeyOf(c);
    return elementDiscipline(el, modelDiscipline);
  }
  function elementRole(el) { return (el && el._ccCls && el._ccCls.role) || null; }
  function topOf(k) { return String(k || '').split('.')[0]; }
  function subOf(k) { var i = String(k || '').indexOf('.'); return i < 0 ? null : String(k).slice(i + 1); }

  // Precedence: exact cell override (incl. 'mep.heating:mep.ventilation') >
  // top-level cell override ('mep:mep' applies to every MEP sub pair) >
  // default. Default: different top-level disciplines ON; same top-level OFF
  // when rules.excludeSameDiscipline (the default) — EXCEPT two resolved,
  // different MEP sub-disciplines (cross-trade: ventilation × heating ×
  // plumbing × fire × electrical), which are ON. An MEP element without a
  // sub-discipline counts as "same discipline" as every other MEP element
  // (the pre-sub-discipline behaviour), and an unresolved pipe ('piping') is
  // the same trade as heating / plumbing / fire pipes.
  function disciplinePairEnabled(discA, discB, rules) {
    rules = rules || {};
    var pairKey = discA < discB ? discA + ':' + discB : discB + ':' + discA;
    var dm = rules.disciplineMatrix;
    if (dm && dm[pairKey] !== undefined) return dm[pairKey] !== false;
    var tA = topOf(discA), tB = topOf(discB);
    if (tA !== discA || tB !== discB) {
      var tKey = tA < tB ? tA + ':' + tB : tB + ':' + tA;
      if (dm && dm[tKey] !== undefined) return dm[tKey] !== false;
    }
    if (tA !== tB) return true;
    if (rules.excludeSameDiscipline === false) return true;
    var sA = subOf(discA), sB = subOf(discB);
    if (!sA || !sB || sA === sB) return false;
    if ((sA === 'piping' || sB === 'piping') && SUB_FAMILY[sA] === SUB_FAMILY[sB]) return false;
    return true;
  }

  function matrixSkipsSameDiscipline(eA, mA, eB, mB, sameModel, rules) {
    if (rules.duplicates || sameModel) return false;
    var dA = elementMatrixKey(eA, mA && mA.discipline);
    var dB = elementMatrixKey(eB, mB && mB.discipline);
    return !disciplinePairEnabled(dA, dB, rules);
  }

  // Matrix keys a UI can list (top-level + MEP sub-disciplines).
  var MATRIX_KEYS = Object.freeze(['structural', 'architectural', 'civil', 'other', 'mep', 'mep.ventilation', 'mep.heating', 'mep.plumbing', 'mep.fire', 'mep.electrical', 'mep.piping']);


  // ── Federation role suggestions (pre-run "smart suggestions") ──────────
  // Groups of elements a coordinator usually wants out of — or labelled
  // inside — a clash run, for ANY model (any schema / authoring tool /
  // language). Evidence order, each with a confidence:
  //   high    stated: PredefinedType (.PROVISIONFORVOID.), a classification
  //           table role, IfcZone membership, IfcSpatialZone / IfcSpace class
  //   medium  pack name hints; model majority; geometric evidence that is
  //           specific (below); exact duplicates across models
  //   low     catch-all classes with no evidence at all (unclassified proxies)
  // Geometric heuristics only look at catch-all classes (proxies …) that are
  // NOT MEP by stated/type evidence — a proxy that is a real equipment item
  // (a manifold in a heating system, a socket in an electrical model) is
  // never suggested as a provision or zone:
  //   provision  >= 3 MEP elements of other models belonging to >= 2
  //              different trades/systems pass THROUGH its box (they extend
  //              beyond it), and it carries no material
  //   zone       a large volume (>= 20 m³) that fully contains >= 10 elements
  //              of other models, or a thin plate (<= 0.3 m, >= 8× thinner
  //              than its other sides, those >= 1.5 m) lying inside a
  //              wall/slab of another model (compartment boundary marker),
  //              no material
  //   duplicate  same IFC class and the same box (±2 mm) as an element of
  //              another model (high when the names match too)
  // Groups: space, zone, provision, duplicate, proxy.
  var ROLE_GROUPS = Object.freeze(['provision', 'zone', 'space', 'duplicate', 'proxy']);
  var DEFAULT_ROLE_CHOICES = Object.freeze({ provision: 'classify', zone: 'classify', space: 'exclude', duplicate: 'include', proxy: 'include' });
  var _ROLE_SRC_CONF = { 'predefined-type': 'high', classification: 'high', system: 'high', entity: 'high', name: 'medium', model: 'medium', geometry: 'medium' };
  function roleConfidence(src) { return _ROLE_SRC_CONF[src] || 'low'; }
  // Effective choice for a group: 'exclude' | 'include' | 'classify'.
  function roleChoice(group, rules) {
    var rc = rules && rules.roleChoices;
    var v = rc && rc[group];
    if (v === 'exclude' || v === 'include' || v === 'classify') return v;
    if (group === 'space') return rules && rules.includeSpaces ? 'include' : 'exclude';
    return DEFAULT_ROLE_CHOICES[group] || 'include';
  }
  function _bx(b) { return b && b.min && b.max && b.max.x >= b.min.x ? b : null; }
  function _isProxyLike(el) { var c = (el.props && el.props.ifcType) || ''; return !!PROXY_LIKE[c] || !c; }
  function _statedMep(el) {
    var c = el._ccCls;
    if (!c) return false;
    return c.d === 'mep' && (c.stated || c.src === 'type-object' || c.src === 'entity');
  }
  // models: [{id, discipline, elements:[{expressId, props, box:{min,max}, _ccCls}]}]
  // Returns {byEl: Map(el -> {group, role, conf, src, ev, modelId}), groups:{g:{n, high, medium, low, models:{id:n}}}, sig}
  function suggestRoles(models) {
    models = models || [];
    var byEl = new Map();
    var groups = {};
    ROLE_GROUPS.forEach(function(g) { groups[g] = { n: 0, high: 0, medium: 0, low: 0, models: {} }; });
    function put(el, m, group, role, conf, src, ev) {
      if (byEl.has(el)) return;
      byEl.set(el, { group: group, role: role || null, conf: conf, src: src, ev: ev || '', modelId: m.id });
      var g = groups[group]; g.n++; g[conf]++; g.models[m.id] = (g.models[m.id] || 0) + 1;
    }
    var cands = [], others = [];
    models.forEach(function(m) {
      (m.elements || []).forEach(function(el) {
        var p = el.props || {};
        if (p.ifcType === 'IfcSpace') { put(el, m, 'space', null, 'high', 'entity', 'IfcSpace'); return; }
        var c = el._ccCls;
        if (c && c.role) { put(el, m, c.role, c.role, roleConfidence(c.roleSrc), c.roleSrc, c.roleEv); return; }
        var b = _bx(el.box);
        if (!b) return;
        var item = { el: el, m: m, b: b, mep: elementDiscipline(el, m.discipline) === 'mep', key: el._ccCls ? matrixKeyOf(el._ccCls) : '', sys: (p.groups && p.groups[0] && p.groups[0].name) || '',
          wallSlab: /^(IfcWall|IfcSlab|IfcRoof|IfcCovering)/.test(p.ifcType || '') };
        others.push(item);
        if (_isProxyLike(el) && !_statedMep(el) && !p.material) cands.push(item);
      });
    });
    // Geometry: sweep on x between candidates and everything else.
    if (cands.length) {
      var all = cands.map(function(c) { return { it: c, cand: 1 }; }).concat(others.map(function(o) { return { it: o, cand: 0 }; }));
      all.sort(function(a, b) { return a.it.b.min.x - b.it.b.min.x; });
      var activeC = [], activeO = [];
      var stats = new Map();
      cands.forEach(function(c) { stats.set(c, { mep: 0, through: 0, keys: {}, nk: 0, contained: 0, inWall: false }); });
      var ovl = function(a, b) { return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y && a.min.z <= b.max.z && a.max.z >= b.min.z; };
      var inside = function(a, b, t) { return a.min.x >= b.min.x - t && a.max.x <= b.max.x + t && a.min.y >= b.min.y - t && a.max.y <= b.max.y + t && a.min.z >= b.min.z - t && a.max.z <= b.max.z + t; };
      var test = function(c, o) {
        if (c === o || c.m === o.m || !ovl(c.b, o.b)) return;
        var st = stats.get(c);
        var inC = inside(o.b, c.b, 0.001);
        if (o.mep) { st.mep++; if (!inC) st.through++; var k = o.sys || o.key || 'mep'; if (!st.keys[k]) { st.keys[k] = 1; st.nk++; } }
        if (inC) st.contained++;
        if (o.wallSlab && inside(c.b, o.b, 0.01)) st.inWall = true;
      };
      for (var i = 0; i < all.length; i++) {
        var a = all[i], x = a.it.b.min.x;
        activeC = activeC.filter(function(c) { return c.b.max.x >= x; });
        activeO = activeO.filter(function(o) { return o.b.max.x >= x; });
        if (a.cand) { for (var j = 0; j < activeO.length; j++) test(a.it, activeO[j]); activeC.push(a.it); }
        else { for (var k2 = 0; k2 < activeC.length; k2++) test(activeC[k2], a.it); activeO.push(a.it); }
        if (!a.cand) { /* a candidate is also an "other" for other candidates */ }
      }
      cands.forEach(function(c) {
        var st = stats.get(c), b = c.b;
        var ex = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].sort(function(p, q) { return p - q; });
        var vol = ex[0] * ex[1] * ex[2];
        // Provisions are passed THROUGH (a large compartment volume merely
        // contains its pipes); zones are tested first.
        if (vol >= 20 && st.contained >= 10) { put(c.el, c.m, 'zone', 'zone', 'medium', 'geometry', 'encloses ' + st.contained + ' elements'); return; }
        if (st.through >= 3 && st.nk >= 2) { put(c.el, c.m, 'provision', 'provision', 'medium', 'geometry', st.through + ' MEP elements of ' + st.nk + ' systems pass through'); return; }
        if (vol >= 20 && st.contained >= 10) { put(c.el, c.m, 'zone', 'zone', 'medium', 'geometry', 'encloses ' + st.contained + ' elements'); return; }
        if (ex[0] <= 0.3 && ex[1] >= 1.5 && ex[1] >= ex[0] * 8 && st.inWall) { put(c.el, c.m, 'zone', 'zone', 'medium', 'geometry', 'thin plate inside a wall/slab'); return; }
      });
    }
    // Duplicates across models (same class + same box ±2 mm).
    var seen = {};
    others.forEach(function(o) {
      if (byEl.has(o.el)) return;
      var b = o.b, q = function(v) { return Math.round(v * 500); };
      var key = (o.el.props.ifcType || '') + '|' + [q(b.min.x), q(b.min.y), q(b.min.z), q(b.max.x), q(b.max.y), q(b.max.z)].join(',');
      var prev = seen[key];
      if (prev && prev.m !== o.m) {
        var same = (prev.el.props.name || '') === (o.el.props.name || '') && !!o.el.props.name;
        put(o.el, o.m, 'duplicate', null, same ? 'high' : 'medium', 'geometry', 'same box as #' + prev.el.expressId + ' in another model');
      } else if (!prev) seen[key] = o;
    });
    // Catch-all classes with no evidence at all.
    others.forEach(function(o) {
      if (byEl.has(o.el) || !_isProxyLike(o.el) || _statedMep(o.el)) return;
      var p = o.el.props || {};
      if (p.typeObject || (p.classification && p.classification.length) || (p.groups && p.groups.length)) return;
      put(o.el, o.m, 'proxy', null, 'low', 'entity', p.ifcType || 'Element');
    });
    var h = 2166136261;
    models.forEach(function(m) {
      (m.elements || []).forEach(function(el) {
        var e = byEl.get(el);
        if (!e) return;
        var t = m.id + ':' + el.expressId + ':' + e.group;
        for (var ci = 0; ci < t.length; ci++) h = Math.imul(h ^ t.charCodeAt(ci), 16777619);
      });
    });
    return { byEl: byEl, groups: groups, sig: byEl.size + ':' + (h >>> 0).toString(36) };
  }

  function dataVersion() { return _dataVersion; }

  return Object.freeze({
    contractVersion: 2,
    typeMap: TYPE_MAP,
    entitySubMap: ENTITY_SUB,
    subdisciplines: SUBDISCIPLINES,
    subFamily: SUB_FAMILY,
    roles: ROLES,
    matrixKeys: MATRIX_KEYS,
    defaultHints: DEFAULT_HINTS,
    canonicalIfcName: canonicalIfcName,
    elementDiscipline: elementDiscipline,
    elementMatrixKey: elementMatrixKey,
    elementRole: elementRole,
    matrixKeyOf: matrixKeyOf,
    disciplinePairEnabled: disciplinePairEnabled,
    matrixSkipsSameDiscipline: matrixSkipsSameDiscipline,
    detectDiscipline: detectDiscipline,
    classifyElement: classifyElement,
    classifyModel: classifyModel,
    validateHints: validateHints,
    registerHints: registerHints,
    unregisterHints: unregisterHints,
    hintSources: hintSources,
    matchHint: matchHint,
    validateClassificationTable: validateClassificationTable,
    registerClassificationTable: registerClassificationTable,
    classificationTables: classificationTables,
    lookupClassification: lookupClassification,
    dataVersion: dataVersion,
    roleGroups: ROLE_GROUPS,
    defaultRoleChoices: DEFAULT_ROLE_CHOICES,
    roleConfidence: roleConfidence,
    roleChoice: roleChoice,
    suggestRoles: suggestRoles
  });
}));
