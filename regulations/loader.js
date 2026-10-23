// ── ClashControl Addon: Country Pack Loader ─────────────────────────────────
// Country packs (regulations/*.json) are pure data — no executable code, ever.
// This is the only file in regulations/ that is JS; contributors add a .json
// file + a manifest.json entry, nothing else. See regulations/_template.json
// and regulations/README.md for the format, including the required `source`
// citations.
//
// The core registry (_ccRegisterCountryPack / _ccResolveCountry /
// _ccGetRegulationPreset / _ccSetRegulationRegion) lives in index.html; the
// section validation in country-pack-core.js. This loader fetches the manifest
// and then EVERY pack it lists (they are small) and registers them as data:
// the region that applies is decided by the loaded models (IfcPostalAddress,
// projected CRS, site location) or the user's pick in Settings, so the
// resolver needs every pack's geo section up front. Classification tables are
// registered from every pack too — a model's codes say which table they come
// from, not the user's settings. Registering never activates a region.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var MANIFEST_URL = 'regulations/manifest.json';
  var _manifestPromise = null;
  var _packPromises = {};

  function loadManifest() {
    if (_manifestPromise) return _manifestPromise;
    _manifestPromise = fetch(MANIFEST_URL).then(function (r) {
      if (!r.ok) throw new Error('regulations manifest fetch failed: ' + r.status);
      return r.json();
    }).catch(function (e) {
      console.warn('[Regulations] manifest unavailable', e);
      return [];
    });
    return _manifestPromise;
  }

  // For the Settings panel picker: [{region, name, contributor, verified, thresholds}, ...]
  window._ccListRegulationPacks = function () {
    return loadManifest();
  };

  function registerPackTables(pack) {
    var core = window._ccClashDisciplineCore;
    if (!core || typeof core.registerClassificationTable !== 'function' || !pack || !Array.isArray(pack.classifications)) return 0;
    var n = 0;
    pack.classifications.forEach(function (t) { if (core.registerClassificationTable(t)) n++; });
    return n;
  }

  function fetchPack(entry) {
    if (_packPromises[entry.region]) return _packPromises[entry.region];
    _packPromises[entry.region] = fetch('regulations/' + entry.file).then(function (r) {
      if (!r.ok) throw new Error('country pack fetch failed: ' + r.status);
      return r.json();
    }).then(function (pack) {
      if (!pack || typeof pack !== 'object' || pack.region !== entry.region || typeof pack.engines !== 'object') {
        throw new Error('Malformed country pack: ' + entry.region);
      }
      var tables = registerPackTables(pack);
      if (typeof window._ccRegisterCountryPack === 'function') window._ccRegisterCountryPack(pack);
      return { pack: pack, tables: tables };
    });
    _packPromises[entry.region].catch(function (e) {
      console.warn('[Regulations] pack not loaded: ' + entry.region, e);
      delete _packPromises[entry.region];
    });
    return _packPromises[entry.region];
  }

  loadManifest().then(function (list) {
    return Promise.all((list || []).filter(function (p) { return p && p.file && p.region; }).map(function (entry) {
      return fetchPack(entry).then(function (r) { return r.tables; }, function () { return 0; });
    }));
  }).then(function (counts) {
    var n = (counts || []).reduce(function (a, b) { return a + b; }, 0);
    if (n && typeof window._ccReclassifyModels === 'function') window._ccReclassifyModels('classification-tables');
    return n;
  });

  // Fetches + registers one region's pack (already done at startup for every
  // manifest entry; this returns the same promise). Does NOT activate it.
  window._ccLoadRegulationPack = function (region) {
    return loadManifest().then(function (list) {
      var entry = (list || []).filter(function (p) { return p.region === region; })[0];
      if (!entry || !entry.file) throw new Error('Unknown region: ' + region);
      return fetchPack(entry);
    }).then(function (r) { return r.pack; });
  };

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'regulations',
      alwaysOn: true,
      name: 'Country packs',
      description: 'Loads community-contributed country packs (regulations/*.json): building-code thresholds, national data standards, CRS and 3D-tiles presets — pure data, never executable code.'
    });
  }
})();
