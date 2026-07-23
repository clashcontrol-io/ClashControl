// ── ClashControl Addon: Regulation Preset Loader ────────────────────────────
// Regional building-code presets (regulations/*.json) are pure data — no
// executable code, ever. This is the only file in regulations/ that is JS;
// contributors add a .json file + a manifest.json entry, nothing else. See
// regulations/_template.json and regulations/README.md for the contribution
// format, including the required `source` citation.
//
// The core registry (_ccRegisterRegulationPreset / _ccGetRegulationPreset /
// _ccSetRegulationRegion) lives in index.html. This loader just knows how to
// fetch the manifest and turn a requested region id into registered presets,
// one per check engine the pack declares thresholds for.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var MANIFEST_URL = 'regulations/manifest.json';
  var _manifestPromise = null;

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

  // For the Settings panel picker: [{region, name, contributor, verified}, ...]
  window._ccListRegulationPacks = function () {
    return loadManifest();
  };

  // Fetches + registers every engine's thresholds from a region's pack.
  // Does NOT activate the region (callers call window._ccSetRegulationRegion
  // once the user picks it, or once model geolocation suggests it).
  window._ccLoadRegulationPack = function (region) {
    return loadManifest().then(function (list) {
      var entry = (list || []).filter(function (p) { return p.region === region; })[0];
      if (!entry || !entry.file) throw new Error('Unknown region: ' + region);
      return fetch('regulations/' + entry.file).then(function (r) {
        if (!r.ok) throw new Error('regulation pack fetch failed: ' + r.status);
        return r.json();
      });
    }).then(function (pack) {
      if (!pack || typeof pack !== 'object' || !pack.region || typeof pack.engines !== 'object') {
        throw new Error('Malformed regulation pack: ' + region);
      }
      if (typeof window._ccRegisterRegulationPreset === 'function') {
        Object.keys(pack.engines).forEach(function (engine) {
          window._ccRegisterRegulationPreset({
            region: pack.region,
            engine: engine,
            name: pack.name,
            thresholds: pack.engines[engine]
          });
        });
      }
      return pack;
    });
  };

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'regulations',
      alwaysOn: true,
      name: 'Regional regulation presets',
      description: 'Loads community-contributed building-code threshold presets (regulations/*.json) on demand — pure data, never executable code.'
    });
  }
})();
