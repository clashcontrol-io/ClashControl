'use strict';
// Locks the Data Quality panel's RVB wiring (index.html, DataQualityPanel):
// RVB_KEYS covers every runRVBChecks() bucket, runChecks() respects the
// selectedModel filter when building rvbModels (not just elements), and RVB is
// deliberately excluded from the top "N issues" badge (totalIssues+totalBim+
// totalIls) while still getting counted in the section's own local badge and
// wired into CSV export / createAllIssues, same as qc/bim/ils.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function html() {
  return fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
}

function rvbKeys() {
  const src = html();
  const marker = 'var RVB_KEYS = [';
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'RVB_KEYS declaration not found');
  const end = src.indexOf('];', start);
  return new Function('return ' + src.slice(start + 'var RVB_KEYS = '.length, end + 1))();
}

function engineRvbKeys() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  const result = window._ccRunRVBChecks([]);
  return Object.keys(result).filter((k) => k.charAt(0) !== '_');
}

test('RVB_KEYS covers every runRVBChecks() bucket exactly (no missing, no stale)', () => {
  const engine = engineRvbKeys();
  const panel = rvbKeys();
  assert.deepEqual(panel.slice().sort(), engine.slice().sort());
});

test('runChecks() builds rvbModels from the same selectedModel-filtered loop as elements', () => {
  const src = html();
  // There is a second, unrelated runChecks() in the Accessibility panel -
  // anchor inside DataQualityPanel specifically so indexOf finds the right one.
  const panelStart = src.indexOf('function DataQualityPanel(props) {');
  assert.ok(panelStart !== -1, 'DataQualityPanel not found');
  const start = src.indexOf('function runChecks() {', panelStart);
  assert.ok(start !== -1);
  const end = src.indexOf('\n    }', start);
  const fnSrc = src.slice(start, end);
  assert.ok(/var rvbModels = \[\]/.test(fnSrc), 'rvbModels must be a fresh array per run');
  assert.ok(/rvbModels\.push\(m\)/.test(fnSrc), 'rvbModels must be populated inside the same selectedModel-filtered forEach as elements');
  assert.ok(/setRvb\(runRVBChecks\(rvbModels\)\)/.test(fnSrc), 'setRvb must be called with the filtered models, not s.models directly');
});

test('the top issues badge total is NOT affected by rvb (totalRvb kept separate)', () => {
  const src = html();
  const start = src.indexOf('var hasModels = s.models && s.models.length > 0;');
  const end = src.indexOf('var SEV = {error:', start);
  const block = src.slice(start, end);
  assert.ok(/var totalRvb = 0;/.test(block));
  // The three vars folded into the top badge must stay exactly qc/bim/ils.
  const badgeMatch = src.match(/totalIssues\+totalBim\+totalIls===0/g);
  assert.ok(badgeMatch && badgeMatch.length > 0, 'the top badge condition must still be totalIssues+totalBim+totalIls only');
  assert.ok(!/totalIssues\+totalBim\+totalIls\+totalRvb/.test(src), 'totalRvb must not be folded into the top badge sum');
});

test('exportCSV and createAllIssues both wire in rvb/RVB_KEYS', () => {
  const src = html();
  assert.ok(/addRows\(rvb, RVB_KEYS\)/.test(src), 'exportCSV must call addRows(rvb, RVB_KEYS)');
  assert.ok(/addFromChecks\(rvb, RVB_KEYS\)/.test(src), 'createAllIssues must call addFromChecks(rvb, RVB_KEYS)');
});
