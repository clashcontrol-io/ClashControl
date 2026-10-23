'use strict';
// Locks the Data Quality panel's wiring for national data standards
// (index.html, DataQualityPanel) against the generic standards engine
// (addons/data-quality.js) and the country-pack data (regulations/nl.json).
// The panel holds no standard's check ids any more: every reported check of
// a pack's standard must render, export to CSV and feed "Create all issues";
// model-scope standards run on the same selectedModel-filtered models as the
// element checks; standards with badge:false (a single client's norm) stay
// out of the top issues badge.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { readPack, countryWindow, loadAddon } = require('./_country-pack.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const panelStart = html.indexOf('function DataQualityPanel(props) {');
const panelEnd = html.indexOf('function IDSValidationPanel(props) {', panelStart);
const panel = html.slice(panelStart, panelEnd);

function fnSrc(name) {
  const start = panel.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' not found in DataQualityPanel');
  return panel.slice(start, panel.indexOf('\n    }', start));
}

test('the panel derives each standard\'s keys from the pack (report:false checks excluded)', () => {
  const src = fnSrc('stdKeys');
  assert.ok(/c\.report !== false/.test(src));
  assert.ok(!/ILS_KEYS|RVB_KEYS/.test(panel), 'no hard-coded standard key lists in the panel');
});

test('every reported check of the nl standards is a bucket the engine returns, and vice versa', () => {
  const window = loadAddon('data-quality.js', countryWindow({ regions: ['nl'], active: 'nl' }));
  const nl = readPack('nl');
  nl.dataQuality.standards.forEach((std) => {
    const reported = std.checks.filter((c) => c.report !== false).map((c) => c.id).sort();
    const res = window._ccRunStandard('nl:' + std.id, []);
    const engineKeys = Object.keys(res).filter((k) => k.charAt(0) !== '_').sort();
    assert.deepStrictEqual(engineKeys, reported, std.id);
  });
  const ilsIds = nl.dataQuality.standards.find((s) => s.id === 'ils').checks.map((c) => c.id);
  ['storeyNaming', 'doorNaming', 'spaceIncomplete', 'fireRatingInvalid', 'extWallNoUValue', 'loadBearingInvalidMaterial', 'mepNoRenovationStatus']
    .forEach((k) => assert.ok(ilsIds.includes(k), k + ' (NL-BIM Basis ILS v2 addition) must stay in the pack'));
});

test('runChecks() runs model-scope standards on the selectedModel-filtered models', () => {
  const src = fnSrc('runChecks');
  assert.ok(/var scopeModels = \[\]/.test(src));
  assert.ok(/scopeModels\.push\(m\)/.test(src));
  assert.ok(/var newStds = runStandardChecks\(elements, scopeModels\)/.test(src));
  assert.ok(/setStds\(newStds\)/.test(src));
  const runner = html.slice(html.indexOf('function runStandardChecks(elements, models) {'));
  assert.ok(/entry\.std\.scope === 'models' \? models : elements/.test(runner.slice(0, 600)));
});

test('top issues badge: only standards that apply (or were asked for) and have badge !== false', () => {
  assert.ok(/if \(stdCounts\(x\) && x\.entry\.std\.badge !== false\) totalStd \+= stdTotal\(x\);/.test(panel));
  assert.ok(/totalIssues\+totalBim\+totalStd===0/.test(panel));
  assert.ok(/function stdCounts\(x\) \{ return stdApp\(x\)\.applicable \|\| !!stdAnyway\[x\.entry\.key\]; \}/.test(panel));
});

test('exportCSV and createAllIssues include every counted standard', () => {
  assert.ok(/\(stds\|\|\[\]\)\.forEach\(function\(x\)\{ if \(stdCounts\(x\)\) addRows\(x\.res, stdKeys\(x\)\); \}\);/.test(fnSrc('exportCSV')));
  assert.ok(/\(stds\|\|\[\]\)\.forEach\(function\(x\)\{ if \(stdCounts\(x\)\) addFromChecks\(x\.res, stdKeys\(x\)\); \}\);/.test(fnSrc('createAllIssues')));
});

test('standards that do not apply are offered behind "check anyway", not counted', () => {
  assert.ok(/var stdOther = \(stds\|\|\[\]\)\.filter\(function\(x\)\{ return !stdCounts\(x\); \}\);/.test(panel));
  assert.ok(/_cc_t\('dq\.checkAnyway','Check against \{name\} anyway'/.test(panel));
});
