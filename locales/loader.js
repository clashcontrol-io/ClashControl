// ── ClashControl Addon: Locale Pack Loader ──────────────────────────────────
// Language packs (locales/*.json) are pure data — no executable code, ever.
// This is the only file in locales/ that is JS; contributors add a .json
// file + a manifest.json entry, nothing else. See locales/_template.json
// and locales/README.md for the contribution format.
//
// The core registry (_cc_t / _ccRegisterLocalePack / _ccSetLocale) lives in
// index.html. This loader just knows how to fetch the manifest and turn a
// requested language id into a registered pack.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var MANIFEST_URL = 'locales/manifest.json';
  var _manifestPromise = null;

  function loadManifest() {
    if (_manifestPromise) return _manifestPromise;
    _manifestPromise = fetch(MANIFEST_URL).then(function (r) {
      if (!r.ok) throw new Error('locales manifest fetch failed: ' + r.status);
      return r.json();
    }).catch(function (e) {
      console.warn('[Locales] manifest unavailable', e);
      return [];
    });
    return _manifestPromise;
  }

  // For the Settings panel picker: [{lang, name, contributor}, ...]
  window._ccListLocalePacks = function () {
    return loadManifest();
  };

  // Fetches + registers a pack by language id. Resolves with the pack once
  // window._ccRegisterLocalePack has it; does NOT activate it (callers decide
  // when to call window._ccSetLocale — e.g. only after the user picks it).
  window._ccLoadLocalePack = function (lang) {
    return loadManifest().then(function (list) {
      var entry = (list || []).filter(function (p) { return p.lang === lang; })[0];
      if (!entry || !entry.file) throw new Error('Unknown locale: ' + lang);
      return fetch('locales/' + entry.file).then(function (r) {
        if (!r.ok) throw new Error('locale pack fetch failed: ' + r.status);
        return r.json();
      });
    }).then(function (pack) {
      if (!pack || typeof pack !== 'object' || !pack.lang || typeof pack.strings !== 'object') {
        throw new Error('Malformed locale pack: ' + lang);
      }
      if (typeof window._ccRegisterLocalePack === 'function') window._ccRegisterLocalePack(pack);
      return pack;
    });
  };

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'locales',
      alwaysOn: true,
      name: 'Language packs',
      description: 'Loads community-contributed UI translation packs (locales/*.json) on demand — pure data, never executable code.'
    });
  }
})();
