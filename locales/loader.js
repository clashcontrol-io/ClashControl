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

  // Best pack for the browser's language preferences, or null. Walks
  // navigator.languages in the user's order; each tag matches a pack
  // exactly (case-insensitive) or by primary subtag ('ja-JP' -> 'ja',
  // 'pt' -> 'pt-BR'). English (no pack — it's the built-in fallback)
  // ranked above every pack language wins, i.e. returns null.
  function matchBrowserLanguage(packLangs, browserLangs) {
    var lower = packLangs.map(function (l) { return String(l).toLowerCase(); });
    for (var i = 0; i < browserLangs.length; i++) {
      var tag = String(browserLangs[i] || '').toLowerCase();
      if (!tag) continue;
      var primary = tag.split('-')[0];
      if (primary === 'en') return null;
      var exact = lower.indexOf(tag);
      if (exact >= 0) return packLangs[exact];
      for (var j = 0; j < lower.length; j++) {
        if (lower[j].split('-')[0] === primary) return packLangs[j];
      }
    }
    return null;
  }

  // Startup: the core restores a saved `cc_locale` id but nothing loaded the
  // pack itself until the Settings panel was opened, so a returning user who
  // had picked a language saw English. Load it here. With no saved choice
  // at all, auto-detect from navigator.languages and activate WITHOUT
  // persisting (the user never chose it). '' saved = user explicitly picked
  // English — never override that.
  function restoreOrDetect() {
    var saved = null;
    try { saved = window.localStorage.getItem('cc_locale'); } catch (e) {}
    if (saved === '') return;
    loadManifest().then(function (list) {
      var langs = (list || []).map(function (p) { return p.lang; }).filter(Boolean);
      var pick = null;
      if (saved) pick = langs.indexOf(saved) >= 0 ? saved : null;
      else {
        var nav = window.navigator || {};
        pick = matchBrowserLanguage(langs, (nav.languages && nav.languages.length) ? nav.languages : [nav.language]);
      }
      if (!pick) return;
      return window._ccLoadLocalePack(pick).then(function () {
        if (typeof window._ccSetLocale === 'function') window._ccSetLocale(pick, { persist: !!saved });
      });
    }).catch(function (e) { console.warn('[Locales] startup locale not applied', e); });
  }
  restoreOrDetect();

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'locales',
      alwaysOn: true,
      name: 'Language packs',
      description: 'Loads community-contributed UI translation packs (locales/*.json) on demand — pure data, never executable code.'
    });
  }
})();
