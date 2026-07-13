'use strict';
// Locks the Data Quality panel's ILS_KEYS list (index.html, DataQualityPanel) against
// runILSChecks' actual return shape (addons/data-quality.js). runILSChecks computes 16
// check buckets - 9 original + 7 "NL-BIM Basis ILS v2 additions" (storeyNaming,
// doorNaming, spaceIncomplete, fireRatingInvalid, extWallNoUValue,
// loadBearingInvalidMaterial, mepNoRenovationStatus). The v2 additions were being
// computed every run but never appeared in the panel's row list, CSV export, or
// "Create all issues" action - findings silently invisible to users. This test fails
// if a future engine bucket is added without also adding it to the panel's key list.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function engineKeys() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  assert.equal(typeof window._ccRunILSChecks, 'function');
  // A minimal element set that trips every bucket at least once isn't needed -
  // the function always returns the full key set regardless of input.
  const result = window._ccRunILSChecks([]);
  return Object.keys(result).filter((k) => k.charAt(0) !== '_');
}

function panelKeys() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const marker = 'var ILS_KEYS = [';
  const start = html.indexOf(marker);
  assert.ok(start !== -1, 'ILS_KEYS declaration not found in DataQualityPanel');
  const end = html.indexOf('];', start);
  assert.ok(end !== -1, 'ILS_KEYS declaration not terminated');
  const arrSrc = html.slice(start + 'var ILS_KEYS = '.length, end + 1);
  return new Function('return ' + arrSrc)();
}

test('every runILSChecks() bucket is included in the panel\'s ILS_KEYS render/export/action list', () => {
  const engine = engineKeys();
  const panel = panelKeys();
  const missing = engine.filter((k) => panel.indexOf(k) === -1);
  assert.deepEqual(missing, [], 'engine buckets missing from ILS_KEYS: ' + missing.join(', '));
});

test('ILS_KEYS has no stale entries pointing at buckets the engine no longer returns', () => {
  const engine = engineKeys();
  const panel = panelKeys();
  const stale = panel.filter((k) => engine.indexOf(k) === -1);
  assert.deepEqual(stale, [], 'ILS_KEYS entries with no matching engine bucket: ' + stale.join(', '));
});

test('the NL-BIM Basis ILS v2 additions specifically are present (the bug this test locks)', () => {
  const panel = panelKeys();
  ['storeyNaming', 'doorNaming', 'spaceIncomplete', 'fireRatingInvalid', 'extWallNoUValue', 'loadBearingInvalidMaterial', 'mepNoRenovationStatus']
    .forEach((k) => assert.ok(panel.indexOf(k) !== -1, k + ' must be in ILS_KEYS'));
});

test('createAllIssues() includes the ils checks (previously only qc + bim were wired)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function createAllIssues() {');
  assert.ok(start !== -1);
  const end = html.indexOf('\n    }', start);
  const fnSrc = html.slice(start, end);
  assert.ok(/addFromChecks\(ils,\s*ILS_KEYS\)/.test(fnSrc), 'createAllIssues must call addFromChecks(ils, ILS_KEYS)');
});
