#!/usr/bin/env node
// Locale pack coverage: which UI string keys a pack translates, which it
// misses, and the share it covers. The key set is every
// `_cc_t('key', 'English')` in index.html plus every addon `_i18n('key',
// 'English')`, plus the keys the UI builds at run time (DYNAMIC below).
//
//   node scripts/locale-coverage.js            → table per pack
//   node scripts/locale-coverage.js --missing nl → missing keys + English text (JSON)
//   node scripts/locale-coverage.js --write    → refresh `coverage` in locales/manifest.json
//
// locales/loader.js only AUTO-activates a pack (browser-language detection)
// when its manifest `coverage` is >= AUTO_MIN, so a partial pack never gives
// a mixed-language UI by default; it can still be picked in Settings.
// tests/locale-coverage.test.js keeps the manifest numbers honest.
'use strict';
const fs = require('fs');
const path = require('path');

const AUTO_MIN = 0.95;

// Keys composed at run time ('disc.' + id, …) or looked up through a local
// alias of _cc_t (pure helpers that also run in node tests), with their English text.
const DYNAMIC = {
  'disc.structural': 'Structural', 'disc.mep': 'MEP', 'disc.architectural': 'Architectural', 'disc.civil': 'Civil', 'disc.other': 'Other',
  'disc.sub.ventilation': 'Ventilation', 'disc.sub.heating': 'Heating & cooling', 'disc.sub.plumbing': 'Plumbing & drainage',
  'disc.sub.fire': 'Fire protection', 'disc.sub.electrical': 'Electrical', 'disc.sub.piping': 'Piping (trade unknown)',
  'roles.group.provision': 'opening reservation', 'roles.group.provision.n': 'opening reservations',
  'roles.group.zone': 'zone or compartment', 'roles.group.zone.n': 'zones and compartments',
  'roles.group.space': 'room', 'roles.group.space.n': 'rooms',
  'roles.group.duplicate': 'element modelled twice', 'roles.group.duplicate.n': 'elements modelled twice',
  'roles.group.proxy': 'unclassified element', 'roles.group.proxy.n': 'unclassified elements',
  'settings.tab.general': 'General', 'settings.tab.measurement': 'Measurement', 'settings.tab.walk': 'Walk mode',
  'settings.tab.privacy': 'Privacy & Data', 'settings.tab.shared': 'Shared Project', 'settings.tab.ai': 'AI',
  'settings.tab.issues': 'Issues', 'settings.tab.advanced': 'Advanced',
  'ids.severity.error': 'Error', 'ids.severity.warning': 'Warning', 'ids.severity.info': 'Info',
  'nl.reply.viewName.top': 'Top', 'nl.reply.viewName.front': 'Front', 'nl.reply.viewName.back': 'Back',
  'viewCube.front': 'Front', 'viewCube.back': 'Back', 'viewCube.right': 'Right', 'viewCube.left': 'Left', 'viewCube.top': 'Top', 'viewCube.bottom': 'Bottom',
  'rootCause.crosses': 'crosses {list}', 'rootCause.storeys': '{n} storeys',
  'nl.reply.viewName.left': 'Left', 'nl.reply.viewName.right': 'Right', 'nl.reply.viewName.isometric': 'Isometric',
};

const CALL_RE = /(?:_cc_t|_i18n)\(\s*'([^']+)'\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

function sourceFiles(root) {
  const addons = fs.readdirSync(path.join(root, 'addons')).filter((f) => f.endsWith('.js')).sort().map((f) => path.join('addons', f));
  return ['index.html'].concat(addons);
}

// Map key -> English fallback text.
function collectKeys(root) {
  const keys = new Map();
  for (const f of sourceFiles(root)) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(CALL_RE)) if (!keys.has(m[1])) keys.set(m[1], m[2] !== undefined ? m[2] : m[3]);
  }
  for (const k of Object.keys(DYNAMIC)) if (!keys.has(k)) keys.set(k, DYNAMIC[k]);
  return keys;
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'locales', 'manifest.json'), 'utf8'));
}

function packCoverage(root, entry, keys) {
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'locales', entry.file), 'utf8'));
  const strings = pack.strings || {};
  const missing = [];
  let have = 0;
  for (const k of keys.keys()) {
    if (typeof strings[k] === 'string' && strings[k].trim()) have++;
    else missing.push(k);
  }
  return { lang: entry.lang, total: keys.size, translated: have, coverage: keys.size ? have / keys.size : 1, missing };
}

function report(root) {
  const keys = collectKeys(root);
  return readManifest(root).map((e) => packCoverage(root, e, keys));
}

module.exports = { AUTO_MIN, DYNAMIC, collectKeys, packCoverage, report, readManifest };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const args = process.argv.slice(2);
  const keys = collectKeys(root);
  if (args[0] === '--missing') {
    const entry = readManifest(root).find((e) => e.lang === args[1]);
    if (!entry) { console.error('unknown pack ' + args[1]); process.exit(2); }
    const r = packCoverage(root, entry, keys);
    const out = {};
    r.missing.forEach((k) => { out[k] = keys.get(k); });
    process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  } else if (args[0] === '--write') {
    const man = readManifest(root);
    man.forEach((e) => { e.coverage = Math.floor(packCoverage(root, e, keys).coverage * 1000) / 1000; });
    fs.writeFileSync(path.join(root, 'locales', 'manifest.json'), JSON.stringify(man, null, 2) + '\n');
    man.forEach((e) => console.log(e.lang + ' ' + (e.coverage * 100).toFixed(1) + '%'));
  } else {
    report(root).forEach((r) => console.log(r.lang.padEnd(6) + (r.coverage * 100).toFixed(1).padStart(6) + '%  ' + r.translated + ' / ' + r.total + (r.coverage >= AUTO_MIN ? '' : '  (below ' + AUTO_MIN * 100 + '%: offered in Settings, never auto-activated)')));
  }
}
