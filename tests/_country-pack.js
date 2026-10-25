// Test helper: a stub `window` carrying the country-pack registry surface the
// addons read (window._ccGetCountryPacks / _ccGetRegulationRegion /
// _ccGetRegulationPreset / _ccCountryPackCore), loaded from the real JSON pack
// files under regulations/. Addons are plain scripts assigning onto `window`,
// so they are evaluated against this stub exactly like the browser does.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readPack(region) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'regulations', region + '.json'), 'utf8'));
}

// regions: packs to register; active: the active regional code (or null).
function countryWindow(opts) {
  opts = opts || {};
  const packs = (opts.regions || []).map(readPack);
  const active = opts.active === undefined ? (packs[0] ? packs[0].region : null) : opts.active;
  const window = Object.assign({}, opts.window || {});
  let core = null;
  try { core = require('../country-pack-core.js'); } catch (e) { core = null; }
  if (core) window._ccCountryPackCore = core;
  window._ccGetCountryPacks = () => packs.slice();
  window._ccGetCountryPack = (region) => packs.find((p) => p.region === (region || active)) || null;
  window._ccGetRegulationRegion = () => active;
  window._ccGetRegulationPreset = (region, engine) => {
    const p = packs.find((x) => x.region === (region || active));
    return (p && p.engines && p.engines[engine]) || null;
  };
  return window;
}

function loadAddon(file, window) {
  const src = fs.readFileSync(path.join(ROOT, 'addons', file), 'utf8');
  new Function('window', 'console', src)(window, { log() {}, warn() {}, error() {} });
  return window;
}

module.exports = { readPack, countryWindow, loadAddon, ROOT };
