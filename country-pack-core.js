// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccCountryPackCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // ── Country packs: the contract between the IFC-neutral core and the data
  // any country can attach ───────────────────────────────────────────────
  // A country pack (regulations/<region>.json) is pure JSON. Everything that
  // used to be hard-coded for one country — building-code thresholds, national
  // data standards (rule data + labels), CRS definitions, 3D-tiles presets,
  // name words for space roles / visibility targets / Revit disciplines,
  // classification-key names — lives in its sections. This module owns:
  //   * validateSections(pack)   structural checks shared by the app and
  //                              scripts/validate-regulation.js (CI + the
  //                              issue-upload flow), so they never disagree;
  //   * safeRegex(src, flags)    the ONLY way a pattern from a pack becomes a
  //                              RegExp: length-capped, no nested quantifiers,
  //                              no backreferences, no lookbehind;
  //   * resolveCountry(...)      which pack applies to the loaded models;
  //   * crs helpers              pack CRS registry + a generic UTM builder.
  // It holds no country knowledge itself.

  var MAX_PATTERN = 200;
  var REGION_RE = /^[a-z]{2}(-[a-z0-9]+)*$/;

  // A pattern from data must stay cheap and predictable.
  /** @param {any} src @param {string} [flags] */
  function patternProblem(src, flags) {
    if (typeof src !== 'string' || !src) return 'must be a non-empty string';
    if (src.length > MAX_PATTERN) return 'is longer than ' + MAX_PATTERN + ' characters';
    if (flags != null && !/^[iu]{0,2}$/.test(flags)) return 'flags may only be "i" and/or "u"';
    if (/\\[1-9]|\\k</.test(src)) return 'must not use backreferences';
    if (/\(\?<[=!]/.test(src)) return 'must not use lookbehind';
    if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(src)) return 'must not nest quantifiers';
    try { new RegExp(src, flags || ''); } catch (e) { return 'is not a valid regular expression'; }
    return null;
  }
  var _reCache = {};
  /** @param {any} src @param {string} [flags] @returns {RegExp|null} */
  function safeRegex(src, flags) {
    var key = (flags || '') + '\u0000' + src;
    if (Object.prototype.hasOwnProperty.call(_reCache, key)) return _reCache[key];
    var re = patternProblem(src, flags) ? null : new RegExp(src, flags || '');
    _reCache[key] = re;
    return re;
  }
  // Escaped alternation of literal words (word lists from packs never carry regex syntax).
  /** @param {string[]} words */
  function wordsPattern(words) {
    return (words || []).filter(function(w) { return typeof w === 'string' && w; })
      .map(function(w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
  }

  // ── Validation ────────────────────────────────────────────────────────
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v, max) { return typeof v === 'string' && !!v.trim() && v.length <= (max || 200); }
  function strList(v, max, maxItems) {
    return Array.isArray(v) && v.length <= (maxItems || 200) && v.every(function(x) { return isStr(x, max || 60) && !/[<>]|javascript:/i.test(x); });
  }
  function textOk(v, max) { return isStr(v, max || 400) && !/<[a-zA-Z/]|javascript:/i.test(v); }
  // Hosts a pack URL may point at: kept in sync with the app's CSP connect-src
  // (tests/country-pack-core.test.js checks it), https only.
  var URL_HOSTS = ['api.pdok.nl', 'tile.googleapis.com', 'api.cesium.com', 'assets.cesium.com'];
  /** @param {any} u */
  function urlProblem(u) {
    if (typeof u !== 'string' || u.length > 400) return 'must be a URL string';
    var m = /^https:\/\/([a-z0-9.-]+)(\/[^\s"'<>]*)?$/i.exec(u);
    if (!m) return 'must be an https:// URL';
    if (URL_HOSTS.indexOf(m[1].toLowerCase()) < 0) return 'host ' + m[1] + ' is not on the allow-list (' + URL_HOSTS.join(', ') + ')';
    return null;
  }

  var ACCESSIBILITY_KEYS = ['doorClearWidth', 'corridorWidth', 'turningDiameter', 'thresholdHeight', 'rampSlope'];
  var VISIBILITY_TERM_GROUPS = ['exit', 'desk', 'nurse', 'patientRoom', 'reception', 'entrance', 'camera', 'smoke'];
  var REVIT_DISCIPLINES = ['mep', 'structural', 'architectural'];
  var SPACE_ROLES = ['corridor', 'sanitary'];
  // Rule kinds the data-quality standards engine (addons/data-quality.js)
  // implements, with the check-specific keys each accepts.
  var DQ_KINDS = {
    classificationMissing: [], classificationFormat: ['detail'], classificationExpected: ['detail'],
    requiredProps: ['props'],
    attribute: ['attr', 'notEqualAttr'],
    entityName: ['ifcTypes', 'pattern', 'flags', 'emptyDetail'],
    elementName: ['ifcTypes', 'pattern', 'flags', 'emptyDetail'],
    spaceCompleteness: ['ifcTypes', 'attrs', 'props', 'quantities'],
    propertyPattern: ['ifcTypes', 'prop', 'pattern', 'flags', 'detail'],
    requiredWhen: ['ifcTypes', 'when', 'require'],
    materialPattern: ['ifcTypes', 'when', 'pattern', 'flags'],
    propertyValue: ['ifcTypes', 'props', 'pattern', 'flags', 'missingDetail'],
    spatialEntity: ['entity', 'require']
  };
  var MODEL_KINDS = { spatialEntity: 1 };
  var SPATIAL_ENTITIES = { project: ['name'], site: ['name', 'georefLatLon', 'georefElevation'], building: ['name'], zone: ['name', 'objectType'], storey: ['elevation'] };
  var CHECK_COMMON = ['id', 'kind', 'label', 'sev', 'cat', 'weight', 'report'];
  var IFC_TYPE_RE = /^Ifc[A-Za-z0-9]{2,60}$/;

  function patErr(errs, where, src, flags) {
    var p = patternProblem(src, flags);
    if (p) errs.push(where + ' ' + p);
  }

  /** @param {any} g @param {string[]} errs */
  function validateGeo(g, errs) {
    if (!isObj(g)) { errs.push('geo must be an object'); return; }
    Object.keys(g).forEach(function(k) {
      if (['countryNames', 'bounds', 'crs', 'defaultCrs', 'tiles3d'].indexOf(k) < 0) errs.push('geo.' + k + ' is not a known key');
    });
    if (g.countryNames != null && !strList(g.countryNames, 60, 40)) errs.push('geo.countryNames must be an array of short names (as written in IfcPostalAddress.Country)');
    if (g.bounds != null) {
      if (!Array.isArray(g.bounds) || !g.bounds.length || g.bounds.length > 20) errs.push('geo.bounds must be an array of [latMin, lonMin, latMax, lonMax] boxes');
      else g.bounds.forEach(function(b, i) {
        var ok = Array.isArray(b) && b.length === 4 && b.every(function(n) { return typeof n === 'number' && isFinite(n); }) &&
          b[0] >= -90 && b[2] <= 90 && b[1] >= -180 && b[3] <= 180 && b[0] < b[2] && b[1] < b[3];
        if (!ok) errs.push('geo.bounds[' + i + '] must be [latMin, lonMin, latMax, lonMax] with min < max');
      });
    }
    if (g.crs != null) {
      if (!isObj(g.crs) || Object.keys(g.crs).length > 40) errs.push('geo.crs must be an object keyed by EPSG code');
      else Object.keys(g.crs).forEach(function(code) {
        var c = g.crs[code], w = 'geo.crs["' + code + '"]';
        if (!/^\d{4,6}$/.test(code)) errs.push(w + ': key must be a numeric EPSG code');
        if (!isObj(c)) { errs.push(w + ' must be an object'); return; }
        if (!textOk(c.label, 100)) errs.push(w + '.label must be a short text');
        if (typeof c.def !== 'string' || c.def.length > 600 || !/^\+proj=[a-z]+( \+[a-z_0-9]+(=[A-Za-z0-9_.,@+-]+)?)*$/.test(c.def)) errs.push(w + '.def must be a proj4 definition (+proj=… +key=value …)');
        if (c.aliases != null && !strList(c.aliases, 60, 20)) errs.push(w + '.aliases must be an array of short names');
        Object.keys(c).forEach(function(k) { if (['label', 'def', 'aliases'].indexOf(k) < 0) errs.push(w + '.' + k + ' is not a known key'); });
      });
    }
    if (g.defaultCrs != null && !(isObj(g.crs) && Object.prototype.hasOwnProperty.call(g.crs, g.defaultCrs))) errs.push('geo.defaultCrs must name one of geo.crs');
    if (g.tiles3d != null) {
      if (!Array.isArray(g.tiles3d) || g.tiles3d.length > 10) errs.push('geo.tiles3d must be an array of tileset presets');
      else g.tiles3d.forEach(function(t, i) {
        var w = 'geo.tiles3d[' + i + ']';
        if (!isObj(t)) { errs.push(w + ' must be an object'); return; }
        if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.id)) errs.push(w + '.id must be a short lower-case slug');
        if (!textOk(t.label, 80)) errs.push(w + '.label must be a short text');
        if (t.title != null && !textOk(t.title, 300)) errs.push(w + '.title must be a text');
        var up = urlProblem(t.url); if (up) errs.push(w + '.url ' + up);
        if (!textOk(t.attribution, 160)) errs.push(w + '.attribution is required (data licence / credit line)');
        if (t.heightOffsetM != null && !(typeof t.heightOffsetM === 'number' && Math.abs(t.heightOffsetM) <= 200)) errs.push(w + '.heightOffsetM must be a number of metres (|h| ≤ 200)');
        Object.keys(t).forEach(function(k) { if (['id', 'label', 'title', 'url', 'attribution', 'heightOffsetM'].indexOf(k) < 0) errs.push(w + '.' + k + ' is not a known key'); });
      });
    }
  }

  /** @param {any} p @param {string} w @param {string[]} errs */
  function validateVisibilityPreset(p, w, errs) {
    if (!isObj(p)) { errs.push(w + ' must be an object'); return; }
    function side(s, name, need) {
      if (s == null) { if (need) errs.push(w + '.' + name + ' is required'); return; }
      if (!isObj(s)) { errs.push(w + '.' + name + ' must be an object'); return; }
      ['types', 'excludeTypes', 'includeTypes'].forEach(function(k) {
        if (s[k] != null && !(Array.isArray(s[k]) && s[k].every(function(t) { return typeof t === 'string' && IFC_TYPE_RE.test(t); }))) errs.push(w + '.' + name + '.' + k + ' must be an array of IFC class names');
      });
      if (s.namePattern != null) patErr(errs, w + '.' + name + '.namePattern', s.namePattern, 'i');
      if (s.sampling != null) {
        var sm = s.sampling;
        if (!isObj(sm) || ['grid', 'centroid'].indexOf(sm.mode) < 0 ||
          (sm.eyeHeight != null && !(typeof sm.eyeHeight === 'number' && sm.eyeHeight > 0 && sm.eyeHeight < 10)) ||
          (sm.stride != null && !(typeof sm.stride === 'number' && sm.stride > 0.1 && sm.stride < 50))) errs.push(w + '.' + name + '.sampling must be {mode: grid|centroid, eyeHeight (m), stride (m)}');
      }
    }
    if (!textOk(p.label, 100)) errs.push(w + '.label must be a short text');
    side(p.viewer, 'viewer', true); side(p.target, 'target', true); side(p.obstructer, 'obstructer', false);
    if (!(typeof p.maxRange === 'number' && p.maxRange > 0 && p.maxRange <= 500)) errs.push(w + '.maxRange must be metres (0-500)');
    if (['obstruction', 'coverage'].indexOf(p.mode) < 0) errs.push(w + '.mode must be "obstruction" or "coverage"');
    Object.keys(p).forEach(function(k) { if (['label', 'viewer', 'target', 'obstructer', 'maxRange', 'mode', 'sampleId'].indexOf(k) < 0) errs.push(w + '.' + k + ' is not a known key'); });
  }

  /** @param {any} e @param {string[]} errs */
  function validateEngines(e, errs) {
    if (!isObj(e)) { errs.push('engines must be an object keyed by check-engine id'); return; }
    Object.keys(e).forEach(function(engine) {
      var v = e[engine];
      if (!isObj(v)) { errs.push('engines.' + engine + ' must be an object'); return; }
      if (engine === 'visibility') {
        Object.keys(v).forEach(function(k) { if (k !== 'presets') errs.push('engines.visibility.' + k + ' is not a known key (presets)'); });
        if (!isObj(v.presets) || Object.keys(v.presets).length > 40) errs.push('engines.visibility.presets must be an object of named presets');
        else Object.keys(v.presets).forEach(function(k) {
          if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,60}$/.test(k)) errs.push('engines.visibility.presets key "' + k + '" must be a short slug');
          validateVisibilityPreset(v.presets[k], 'engines.visibility.presets.' + k, errs);
        });
        return;
      }
      Object.keys(v).forEach(function(k) {
        if (typeof v[k] !== 'number' || !isFinite(v[k])) errs.push('engines.' + engine + '.' + k + ' must be a finite number');
        if (engine === 'accessibility' && ACCESSIBILITY_KEYS.indexOf(k) < 0) errs.push('engines.accessibility.' + k + ' is not a recognized threshold key for \'accessibility\' (expected one of: ' + ACCESSIBILITY_KEYS.join(', ') + ')');
      });
    });
  }

  /** @param {any} c @param {string} w @param {string[]} errs */
  function validateStdClassification(c, w, errs) {
    if (!isObj(c)) { errs.push(w + ' must be an object'); return; }
    if (!textOk(c.name, 60)) errs.push(w + '.name must be a short text');
    if (!strList(c.keys, 40, 40) || !c.keys.length) errs.push(w + '.keys must list the property names that hold the code');
    if (c.psetContains != null && !isStr(c.psetContains, 40)) errs.push(w + '.psetContains must be a short text');
    if (c.psetKeys != null && !strList(c.psetKeys, 40, 20)) errs.push(w + '.psetKeys must be an array of property names');
    (c.objectTypePatterns || []).forEach(function(p, i) { patErr(errs, w + '.objectTypePatterns[' + i + ']', p); });
    if (c.objectTypePatterns != null && (!Array.isArray(c.objectTypePatterns) || c.objectTypePatterns.length > 5)) errs.push(w + '.objectTypePatterns must be an array of at most 5 patterns');
    patErr(errs, w + '.formatPattern', c.formatPattern);
    patErr(errs, w + '.groupPattern', c.groupPattern);
    if (!isObj(c.groups) || Object.keys(c.groups).length > 500 || Object.keys(c.groups).some(function(k) { return !textOk(c.groups[k], 80) || k.length > 20; })) errs.push(w + '.groups must map group codes to short labels');
    if (c.expected != null) {
      if (!isObj(c.expected)) errs.push(w + '.expected must map IFC classes to allowed group codes');
      else Object.keys(c.expected).forEach(function(t) {
        if (!IFC_TYPE_RE.test(t) || !strList(c.expected[t], 20, 40)) errs.push(w + '.expected.' + t + ' must be an array of group codes ("--" = any)');
      });
    }
    ['unknownGroupLabel', 'noCodeLabel', 'distLabel'].forEach(function(k) { if (c[k] != null && !textOk(c[k], 60)) errs.push(w + '.' + k + ' must be a short text'); });
    Object.keys(c).forEach(function(k) {
      if (['name', 'keys', 'psetContains', 'psetKeys', 'objectTypePatterns', 'formatPattern', 'groupPattern', 'groups', 'expected', 'unknownGroupLabel', 'noCodeLabel', 'distLabel'].indexOf(k) < 0) errs.push(w + '.' + k + ' is not a known key');
    });
  }

  /** @param {any} ch @param {string} w @param {string} scope @param {string[]} errs */
  function validateCheck(ch, w, scope, errs) {
    if (!isObj(ch)) { errs.push(w + ' must be an object'); return; }
    if (typeof ch.id !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(ch.id)) errs.push(w + '.id must be an identifier');
    var kind = ch.kind, extra = DQ_KINDS[kind];
    if (!extra) { errs.push(w + '.kind must be one of: ' + Object.keys(DQ_KINDS).join(', ')); return; }
    if ((scope === 'models') !== !!MODEL_KINDS[kind]) errs.push(w + '.kind ' + kind + ' does not fit a standard with scope "' + scope + '"');
    var reported = ch.report !== false;
    if (ch.report != null && typeof ch.report !== 'boolean') errs.push(w + '.report must be true or false');
    if (reported || ch.label != null) { if (!textOk(ch.label, 160)) errs.push(w + '.label must be a short text'); }
    if (reported && ['error', 'warn', 'info'].indexOf(ch.sev) < 0) errs.push(w + '.sev must be error, warn or info');
    if (reported && !(typeof ch.cat === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(ch.cat))) errs.push(w + '.cat must be a short category id');
    if (ch.weight != null && !(typeof ch.weight === 'number' && ch.weight >= 0 && ch.weight <= 10)) errs.push(w + '.weight must be a number 0-10');
    if (ch.ifcTypes != null && !(Array.isArray(ch.ifcTypes) && ch.ifcTypes.length && ch.ifcTypes.every(function(t) { return typeof t === 'string' && IFC_TYPE_RE.test(t); }))) errs.push(w + '.ifcTypes must be an array of IFC class names');
    if (ch.pattern != null) patErr(errs, w + '.pattern', ch.pattern, ch.flags);
    if (['entityName', 'elementName', 'propertyPattern', 'materialPattern', 'propertyValue'].indexOf(kind) >= 0 && ch.pattern == null) errs.push(w + '.pattern is required');
    ['detail', 'emptyDetail', 'missingDetail'].forEach(function(k) { if (ch[k] != null && !textOk(ch[k], 160)) errs.push(w + '.' + k + ' must be a short text template'); });
    if (kind === 'requiredProps' && (!isObj(ch.props) || Object.keys(ch.props).some(function(t) { return !IFC_TYPE_RE.test(t) || !strList(ch.props[t], 60, 30); }))) errs.push(w + '.props must map IFC classes to property names');
    if (kind === 'attribute' && ['name', 'description', 'material', 'storey', 'objectType', 'longName'].indexOf(ch.attr) < 0) errs.push(w + '.attr must be one of name, description, material, storey, objectType, longName');
    if (kind === 'propertyPattern' && !isStr(ch.prop, 60)) errs.push(w + '.prop is required');
    if ((kind === 'requiredWhen' || kind === 'materialPattern') && !isStr(ch.when, 60)) errs.push(w + '.when must name a boolean property (e.g. IsExternal)');
    if (kind === 'requiredWhen' && !isStr(ch.require, 60)) errs.push(w + '.require must name a property');
    if (kind === 'propertyValue' && (!strList(ch.props, 60, 10) || !ch.props.length)) errs.push(w + '.props must list the property names to read (first found wins)');
    if (kind === 'spaceCompleteness') {
      if (!Array.isArray(ch.attrs) || ch.attrs.some(function(a) { return ['name', 'longName', 'objectType', 'description'].indexOf(a) < 0; })) errs.push(w + '.attrs must list attributes (name, longName, objectType, description)');
      if (ch.props != null && !strList(ch.props, 60, 20)) errs.push(w + '.props must be an array of property names');
      if (!Array.isArray(ch.quantities) || ch.quantities.some(function(q) { return !isObj(q) || !isStr(q.label, 60) || patternProblem(q.pattern, 'i'); })) errs.push(w + '.quantities must be [{label, pattern}] with simple patterns');
    }
    if (kind === 'spatialEntity') {
      var allowed = SPATIAL_ENTITIES[ch.entity];
      if (!allowed) errs.push(w + '.entity must be one of: ' + Object.keys(SPATIAL_ENTITIES).join(', '));
      else if (!Array.isArray(ch.require) || !ch.require.length || ch.require.some(function(r) { return allowed.indexOf(r) < 0; })) errs.push(w + '.require must list some of: ' + allowed.join(', '));
    }
    Object.keys(ch).forEach(function(k) {
      if (CHECK_COMMON.indexOf(k) < 0 && extra.indexOf(k) < 0) errs.push(w + '.' + k + ' is not a known key for kind ' + kind);
    });
  }

  /** @param {any} dq @param {string[]} errs */
  function validateDataQuality(dq, errs) {
    if (!isObj(dq)) { errs.push('dataQuality must be an object'); return; }
    Object.keys(dq).forEach(function(k) { if (['standards', 'idsSpecs'].indexOf(k) < 0) errs.push('dataQuality.' + k + ' is not a known key'); });
    if (dq.standards != null) {
      if (!Array.isArray(dq.standards) || dq.standards.length > 10) errs.push('dataQuality.standards must be an array');
      else {
        var ids = {};
        dq.standards.forEach(function(s, i) {
          var w = 'dataQuality.standards[' + i + ']';
          if (!isObj(s)) { errs.push(w + ' must be an object'); return; }
          if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(s.id)) errs.push(w + '.id must be a short lower-case id');
          else if (ids[s.id]) errs.push(w + '.id duplicates ' + s.id); else ids[s.id] = 1;
          if (!textOk(s.label, 60)) errs.push(w + '.label must be a short text');
          if (s.title != null && !textOk(s.title, 120)) errs.push(w + '.title must be a short text');
          if (!textOk(s.source, 600)) errs.push(w + '.source is required — cite the published standard these rules come from');
          if (s.note != null && !textOk(s.note, 400)) errs.push(w + '.note must be a text');
          if (['elements', 'models'].indexOf(s.scope) < 0) errs.push(w + '.scope must be "elements" or "models"');
          if (['adoption', 'always', 'never'].indexOf(s.headline) < 0) errs.push(w + '.headline must be "adoption", "always" or "never"');
          if (s.headline === 'adoption' && !(typeof s.adoptionMin === 'number' && s.adoptionMin > 0 && s.adoptionMin <= 1)) errs.push(w + '.adoptionMin must be a fraction (0-1] for headline "adoption"');
          if (s.headline === 'adoption' && !s.classification) errs.push(w + ': headline "adoption" needs a classification block');
          if (s.badge != null && typeof s.badge !== 'boolean') errs.push(w + '.badge must be true or false');
          if (s.elementTypes != null && !(Array.isArray(s.elementTypes) && s.elementTypes.every(function(t) { return typeof t === 'string' && IFC_TYPE_RE.test(t); }))) errs.push(w + '.elementTypes must be an array of IFC class names');
          if (s.scope === 'elements' && !Array.isArray(s.elementTypes)) errs.push(w + '.elementTypes is required for an element standard');
          if (s.classification != null) validateStdClassification(s.classification, w + '.classification', errs);
          if (s.compliance != null && !(isObj(s.compliance) && typeof s.compliance.minorMax === 'number' && (s.compliance.label == null || textOk(s.compliance.label, 60)))) errs.push(w + '.compliance must be {minorMax, label}');
          if (!Array.isArray(s.checks) || !s.checks.length || s.checks.length > 60) errs.push(w + '.checks must be a non-empty array');
          else {
            var cids = {};
            s.checks.forEach(function(ch, j) {
              validateCheck(ch, w + '.checks[' + j + ']', s.scope, errs);
              if (ch && cids[ch.id]) errs.push(w + '.checks[' + j + '].id duplicates ' + ch.id);
              if (ch) cids[ch.id] = 1;
              if (ch && /^classification/.test(ch.kind) && !s.classification) errs.push(w + '.checks[' + j + '] needs the standard\'s classification block');
            });
          }
          Object.keys(s).forEach(function(k) {
            if (['id', 'label', 'title', 'source', 'note', 'scope', 'headline', 'adoptionMin', 'badge', 'elementTypes', 'classification', 'compliance', 'checks'].indexOf(k) < 0) errs.push(w + '.' + k + ' is not a known key');
          });
        });
      }
    }
    if (dq.idsSpecs != null) {
      if (!Array.isArray(dq.idsSpecs) || dq.idsSpecs.length > 20) errs.push('dataQuality.idsSpecs must be an array');
      else dq.idsSpecs.forEach(function(sp, i) {
        var w = 'dataQuality.idsSpecs[' + i + ']';
        if (!isObj(sp) || !textOk(sp.name, 100) || !textOk(sp.description, 400) || !Array.isArray(sp.rules) || !sp.rules.length) { errs.push(w + ' must be {name, description, rules[]}'); return; }
        // optional id: the locale-pack key country.<region>.ids.<id>.* that translates the set
        if (sp.id != null && (typeof sp.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(sp.id))) errs.push(w + '.id must be a short lowercase id (a-z, 0-9, -)');
        sp.rules.forEach(function(r, j) {
          var rw = w + '.rules[' + j + ']';
          if (!isObj(r) || !textOk(r.desc, 200) || !isObj(r.applicability) || !isObj(r.requirement)) { errs.push(rw + ' must be {desc, applicability, requirement, severity}'); return; }
          if (r.applicability.ifcType != null) patErr(errs, rw + '.applicability.ifcType', r.applicability.ifcType);
          var pr = r.requirement.property;
          if (pr != null && (!isObj(pr) || typeof pr.pset !== 'string' || !isStr(pr.name, 60))) errs.push(rw + '.requirement.property must be {pset, name, pattern}');
          if (pr && pr.pattern != null) patErr(errs, rw + '.requirement.property.pattern', pr.pattern);
          if (r.requirement.psetExists != null && !isStr(r.requirement.psetExists, 80)) errs.push(rw + '.requirement.psetExists must be a property-set name');
          if (['error', 'warning', 'info'].indexOf(r.severity) < 0) errs.push(rw + '.severity must be error, warning or info');
        });
      });
    }
  }

  /** @param {any} n @param {string[]} errs */
  function validateNaming(n, errs) {
    if (!isObj(n)) { errs.push('naming must be an object'); return; }
    Object.keys(n).forEach(function(k) {
      if (['spaceRoles', 'visibilityTerms', 'revitDisciplineHints', 'classificationKeys', 'codeKeys'].indexOf(k) < 0) errs.push('naming.' + k + ' is not a known key');
    });
    if (n.spaceRoles != null) {
      if (!isObj(n.spaceRoles)) errs.push('naming.spaceRoles must be an object');
      else Object.keys(n.spaceRoles).forEach(function(k) {
        if (SPACE_ROLES.indexOf(k) < 0) errs.push('naming.spaceRoles.' + k + ' is not one of: ' + SPACE_ROLES.join(', '));
        else patErr(errs, 'naming.spaceRoles.' + k, n.spaceRoles[k], 'i');
      });
    }
    if (n.visibilityTerms != null) {
      if (!isObj(n.visibilityTerms)) errs.push('naming.visibilityTerms must be an object');
      else Object.keys(n.visibilityTerms).forEach(function(k) {
        if (VISIBILITY_TERM_GROUPS.indexOf(k) < 0) errs.push('naming.visibilityTerms.' + k + ' is not one of: ' + VISIBILITY_TERM_GROUPS.join(', '));
        else if (!strList(n.visibilityTerms[k], 40, 40)) errs.push('naming.visibilityTerms.' + k + ' must be an array of words');
      });
    }
    if (n.revitDisciplineHints != null) {
      if (!isObj(n.revitDisciplineHints)) errs.push('naming.revitDisciplineHints must be an object');
      else Object.keys(n.revitDisciplineHints).forEach(function(k) {
        if (REVIT_DISCIPLINES.indexOf(k) < 0) errs.push('naming.revitDisciplineHints.' + k + ' is not one of: ' + REVIT_DISCIPLINES.join(', '));
        else if (!strList(n.revitDisciplineHints[k], 40, 60)) errs.push('naming.revitDisciplineHints.' + k + ' must be an array of name fragments');
      });
    }
    if (n.classificationKeys != null) {
      if (!Array.isArray(n.classificationKeys) || n.classificationKeys.length > 10) errs.push('naming.classificationKeys must be an array');
      else n.classificationKeys.forEach(function(c, i) {
        var w = 'naming.classificationKeys[' + i + ']';
        if (!isObj(c) || !textOk(c.system, 40) || !strList(c.keys, 40, 20) || !c.keys.length) { errs.push(w + ' must be {system, keys[], objectTypePatterns[]}'); return; }
        if (c.objectTypePatterns != null) {
          if (!Array.isArray(c.objectTypePatterns) || c.objectTypePatterns.length > 5) errs.push(w + '.objectTypePatterns must be an array of at most 5 patterns');
          else c.objectTypePatterns.forEach(function(p, j) { patErr(errs, w + '.objectTypePatterns[' + j + ']', p); });
        }
        Object.keys(c).forEach(function(k) { if (['system', 'keys', 'objectTypePatterns'].indexOf(k) < 0) errs.push(w + '.' + k + ' is not a known key'); });
      });
    }
    if (n.codeKeys != null && !strList(n.codeKeys, 40, 20)) errs.push('naming.codeKeys must be an array of property names');
  }

  /** @param {any} f @param {string[]} errs */
  function validateFormat(f, errs) {
    if (!isObj(f)) { errs.push('format must be an object'); return; }
    Object.keys(f).forEach(function(k) { if (['decimal', 'group', 'dateLocale'].indexOf(k) < 0) errs.push('format.' + k + ' is not a known key'); });
    if (f.decimal != null && ['.', ','].indexOf(f.decimal) < 0) errs.push('format.decimal must be "." or ","');
    if (f.group != null && ['.', ',', ' ', ' ', ' ', "'", ''].indexOf(f.group) < 0) errs.push('format.group must be one of . , space, \' or empty');
    if (f.dateLocale != null && !(typeof f.dateLocale === 'string' && /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(f.dateLocale))) errs.push('format.dateLocale must be a BCP-47 tag');
  }

  var SECTION_VALIDATORS = { geo: validateGeo, engines: validateEngines, dataQuality: validateDataQuality, naming: validateNaming, format: validateFormat };
  var SECTION_KEYS = Object.keys(SECTION_VALIDATORS);
  // Structural checks of the optional country sections (top-level keys and
  // classification tables are validated by scripts/validate-regulation.js).
  /** @param {any} pack @returns {string[]} */
  function validateSections(pack) {
    var errs = [];
    if (!isObj(pack)) return ['pack must be an object'];
    SECTION_KEYS.forEach(function(k) { if (pack[k] != null) SECTION_VALIDATORS[k](pack[k], errs); });
    return errs;
  }
  // Does the pack carry anything a user would pick it for (Settings picker)?
  /** @param {any} pack */
  function packHasContent(pack) {
    if (!isObj(pack)) return false;
    var e = pack.engines;
    return !!((isObj(e) && Object.keys(e).length) || pack.dataQuality || pack.geo || pack.naming);
  }

  // ── Country resolution ─────────────────────────────────────────────────
  /** @param {any} s */
  function normName(s) {
    return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  /** @param {any[]} packs @param {any} country */
  function packForCountryName(packs, country) {
    var n = normName(country);
    if (!n) return null;
    for (var i = 0; i < packs.length; i++) {
      var p = packs[i], names = [p.region, p.name].concat((p.geo && p.geo.countryNames) || []);
      for (var j = 0; j < names.length; j++) if (normName(names[j]) === n) return p;
    }
    return null;
  }
  // "EPSG:28992", "urn:ogc:def:crs:EPSG::28992", "28992" → "28992".
  /** @param {any} s */
  function epsgCode(s) {
    var m = /(?:^|[^0-9])(\d{4,6})(?:[^0-9]|$)/.exec(String(s == null ? '' : s));
    return m ? m[1] : null;
  }
  /** @param {any[]} packs @param {any} crsName */
  function packForCrs(packs, crsName) {
    if (!crsName) return null;
    var code = epsgCode(crsName), low = String(crsName).toLowerCase();
    var i, p, crs;
    if (code) for (i = 0; i < packs.length; i++) {
      crs = packs[i].geo && packs[i].geo.crs;
      if (crs && Object.prototype.hasOwnProperty.call(crs, code)) return { pack: packs[i], epsg: code };
    }
    for (i = 0; i < packs.length; i++) {
      p = packs[i]; crs = (p.geo && p.geo.crs) || {};
      var keys = Object.keys(crs);
      for (var k = 0; k < keys.length; k++) {
        var al = crs[keys[k]].aliases || [];
        for (var a = 0; a < al.length; a++) if (low.indexOf(String(al[a]).toLowerCase()) >= 0) return { pack: p, epsg: keys[k] };
      }
    }
    return null;
  }
  // Smallest containing box wins (a border region inside two coarse boxes
  // goes to the tighter one); a tie between countries is no answer.
  /** @param {any[]} packs @param {number} lat @param {number} lon */
  function packForLatLon(packs, lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return null;
    var best = null, bestArea = Infinity, tie = false;
    packs.forEach(function(p) {
      ((p.geo && p.geo.bounds) || []).forEach(function(b) {
        if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) return;
        var area = (b[2] - b[0]) * (b[3] - b[1]);
        if (area < bestArea - 1e-12) { best = p; bestArea = area; tie = false; }
        else if (Math.abs(area - bestArea) <= 1e-12 && best !== p) tie = true;
      });
    });
    return tie ? null : best;
  }
  /** @param {any} m */
  function modelHierarchy(m) { return (m && m.spatialHierarchy) || {}; }
  // Which country pack applies to the loaded models.
  //   override: {mode:'user', region} | {mode:'none'} | {mode:'auto'} (default)
  // Precedence: user override > IfcPostalAddress.Country (IfcSite, then
  // IfcBuilding) > IfcProjectedCRS EPSG code / name in a pack's geo.crs >
  // IfcSite RefLatitude/RefLongitude inside a pack's geo.bounds.
  // Returns {region, reason, detail}; region null = IFC-neutral.
  /** @param {any[]} packs @param {any[]} models @param {any} [override] */
  function resolveCountry(packs, models, override) {
    packs = (packs || []).filter(function(p) { return isObj(p) && typeof p.region === 'string'; });
    models = models || [];
    var o = override || { mode: 'auto' };
    if (o.mode === 'user' && o.region) return { region: o.region, reason: 'user', detail: '' };
    if (o.mode === 'none') return { region: null, reason: 'user-none', detail: '' };
    var i, h, p, hit;
    for (i = 0; i < models.length; i++) {
      h = modelHierarchy(models[i]);
      var addrs = [];
      (h.sites || []).forEach(function(s) { if (s && s.address && s.address.country) addrs.push(s.address.country); });
      (h.buildings || []).forEach(function(b) { if (b && b.address && b.address.country) addrs.push(b.address.country); });
      for (var a = 0; a < addrs.length; a++) {
        p = packForCountryName(packs, addrs[a]);
        if (p) return { region: p.region, reason: 'address', detail: String(addrs[a]) };
      }
    }
    for (i = 0; i < models.length; i++) {
      h = modelHierarchy(models[i]);
      hit = h.mapConversion && packForCrs(packs, h.mapConversion.epsg);
      if (hit) return { region: hit.pack.region, reason: 'crs', detail: 'EPSG:' + hit.epsg };
    }
    for (i = 0; i < models.length; i++) {
      h = modelHierarchy(models[i]);
      var sites = h.sites || [];
      for (var s = 0; s < sites.length; s++) {
        var g = sites[s] && sites[s].georef;
        p = g && packForLatLon(packs, g.refLat, g.refLon);
        if (p) return { region: p.region, reason: 'site', detail: (+g.refLat).toFixed(3) + ', ' + (+g.refLon).toFixed(3) };
      }
    }
    return { region: null, reason: 'none', detail: '' };
  }

  // ── CRS ────────────────────────────────────────────────────────────────
  // Generic, country-neutral systems the core always knows.
  var BUILTIN_CRS = {
    '3857': { label: 'Web Mercator', def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs' },
    '4326': { label: 'WGS84 — already lat/lon', def: '+proj=longlat +datum=WGS84 +no_defs' }
  };
  // UTM zones by EPSG code: 326zz WGS84 north, 327zz WGS84 south, 258zz ETRS89 north (28-38).
  /** @param {any} code */
  function utmCrs(code) {
    var c = String(code == null ? '' : code), m;
    if ((m = /^32([67])(\d\d)$/.exec(c))) {
      var z = +m[2]; if (z < 1 || z > 60) return null;
      var south = m[1] === '7';
      return { label: 'WGS 84 / UTM ' + z + (south ? 'S' : 'N'), def: '+proj=utm +zone=' + z + (south ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs' };
    }
    if ((m = /^258(\d\d)$/.exec(c))) {
      var ze = +m[1]; if (ze < 28 || ze > 38) return null;
      return { label: 'ETRS89 / UTM ' + ze + 'N', def: '+proj=utm +zone=' + ze + ' +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' };
    }
    return null;
  }
  // EPSG -> {label, def, aliases, region} from the built-ins plus every pack's geo.crs.
  /** @param {any[]} packs */
  function crsRegistry(packs) {
    /** @type {Object<string, any>} */
    var out = {};
    Object.keys(BUILTIN_CRS).forEach(function(k) { out[k] = { label: BUILTIN_CRS[k].label, def: BUILTIN_CRS[k].def, aliases: [], region: null }; });
    (packs || []).forEach(function(p) {
      var crs = p && p.geo && p.geo.crs;
      if (!isObj(crs) || validateSections({ geo: { crs: crs } }).length) return;
      Object.keys(crs).forEach(function(k) {
        if (!out[k] || out[k].region == null) out[k] = { label: crs[k].label, def: crs[k].def, aliases: (crs[k].aliases || []).slice(), region: p.region };
      });
    });
    return out;
  }
  // Is an IfcSite RefLatitude/RefLongitude the building's location, or a
  // value the authoring tool wrote by default? Authoring tools commonly
  // export 0/0 or their own default city when the user never set a
  // location. Judged against the country the FILE itself names (postal
  // address, projected CRS, or a Settings pick): a site outside that
  // country's geo.bounds is not the building. A country resolved from the
  // site location itself says nothing (it is inside by construction).
  // Returns {ok:true} | {ok:false, reason:'missing'|'null-island'|'outside-country', region?}.
  /** @param {any[]} packs @param {number} lat @param {number} lon @param {any} [resolution] */
  function siteLocationCheck(packs, lat, lon, resolution) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, reason: 'missing' };
    if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) return { ok: false, reason: 'null-island' };
    var r = resolution || null;
    if (r && r.region && (r.reason === 'address' || r.reason === 'crs' || r.reason === 'user')) {
      /** @type {any} */
      var pack = (packs || []).filter(function(p) { return isObj(p) && p.region === r.region; })[0] || null;
      var bounds = (pack && pack.geo && pack.geo.bounds) || [];
      if (bounds.length) {
        var inside = bounds.some(function(b) { return lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]; });
        if (!inside) return { ok: false, reason: 'outside-country', region: r.region };
      }
    }
    return { ok: true };
  }
  // IFC TargetCRS name -> registry key (pack code/alias, else a generic UTM code).
  /** @param {any[]} packs @param {any} name */
  function resolveCrs(packs, name) {
    if (!name) return null;
    var reg = crsRegistry(packs), code = epsgCode(name);
    if (code && reg[code]) return code;
    var hit = packForCrs(packs, name);
    if (hit) return hit.epsg;
    if (code && utmCrs(code)) return code;
    return null;
  }
  /** @param {any[]} packs @param {any} code */
  function crsEntry(packs, code) {
    var reg = crsRegistry(packs);
    return reg[String(code)] || utmCrs(code);
  }

  return {
    MAX_PATTERN: MAX_PATTERN,
    REGION_RE: REGION_RE,
    URL_HOSTS: URL_HOSTS,
    ACCESSIBILITY_KEYS: ACCESSIBILITY_KEYS,
    VISIBILITY_TERM_GROUPS: VISIBILITY_TERM_GROUPS,
    DQ_KINDS: DQ_KINDS,
    SECTION_KEYS: SECTION_KEYS,
    patternProblem: patternProblem,
    safeRegex: safeRegex,
    wordsPattern: wordsPattern,
    urlProblem: urlProblem,
    validateSections: validateSections,
    packHasContent: packHasContent,
    normName: normName,
    epsgCode: epsgCode,
    resolveCountry: resolveCountry,
    siteLocationCheck: siteLocationCheck,
    utmCrs: utmCrs,
    crsRegistry: crsRegistry,
    resolveCrs: resolveCrs,
    crsEntry: crsEntry
  };
}));
