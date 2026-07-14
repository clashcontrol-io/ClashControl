'use strict';
// Locks _ccDataQualityReport (index.html) - the print-ready Data Quality report,
// same new-window/window.print() pattern as _ccClashReport. Extracts the real
// function and runs it against stub check engines + a fake window.open/document,
// following the same sandboxing style as tests/bcf-export.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function extractFunction(src) {
  const header = 'function _ccDataQualityReport(s) {';
  const start = src.indexOf(header);
  assert.ok(start !== -1, header + ' not found');
  const tail = 'window._ccDataQualityReport = _ccDataQualityReport;';
  const tailPos = src.indexOf(tail, start);
  assert.ok(tailPos !== -1, 'trailing window._ccDataQualityReport assignment not found');
  const fnClose = src.lastIndexOf('}', tailPos);
  return src.slice(start, fnClose + 1);
}

// windowOverrides replaces individual `window.*` fields (e.g. {open: () => null}
// to simulate a popup blocker, or {_ccRunAccessibilityChecks: undefined} to
// simulate the addon not being loaded) - applied last so it always wins.
function run(s, windowOverrides) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fnSrc = extractFunction(html);

  const written = { html: null };
  const fakeWindow = Object.assign({
    CC_VERSION: { v: 'test' },
    _ccToast: () => {},
    _ccComputeQualityScore: () => ({
      score: 78, grade: 'B',
      breakdown: { categories: [
        { label: 'Data quality', score: 80, checks: 12, countsTowardScore: true },
        { label: 'RVB BIM Norm', score: 60, checks: 5, countsTowardScore: false },
      ] },
    }),
    _ccRunAccessibilityChecks: () => ({ groups: { doorWidth: { label: 'Door clear width', total: 4, fail: 1 } } }),
    open: () => ({ document: { write: (h) => { written.html = h; }, close: () => {} } }),
  }, windowOverrides);

  const sandbox = {
    esc: (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _gcEvent: () => {},
    _ccChangelogUser: 'Tester',
    window: fakeWindow,
    runDataQualityChecks: () => ({ noMaterial: { label: 'No material assigned', sev: 'warn', count: 2 }, _total: 5 }),
    runBIMModelChecks: () => ({ noFireRating: { label: 'Missing FireRating', sev: 'warn', count: 1 }, _total: 5, _dist: {} }),
    runILSChecks: () => ({ noNLSfB: { label: 'Geen NL/SfB classificatie', sev: 'error', count: 0 }, _total: 5 }),
    runRVBChecks: () => ({ projectIncomplete: { label: 'IfcProject zonder naam (RVB 2.2.7.1)', sev: 'warn', count: 1, total: 1 }, _total: 1 }),
  };

  const fn = new Function(...Object.keys(sandbox), fnSrc + '; return _ccDataQualityReport;')(...Object.values(sandbox));
  fn(s);
  return written.html;
}

function model(id, elCount) {
  return { id, name: 'Model ' + id, discipline: 'STR', elements: Array.from({ length: elCount }, (_, i) => ({ expressId: i, props: {} })) };
}

test('does nothing (no popup) when there are no elements to report', () => {
  let opened = false;
  const html = run({ models: [] }, { open: () => { opened = true; return null; } });
  assert.equal(html, null);
  assert.equal(opened, false);
});

test('shows a "popup blocked" toast and does not throw when window.open returns null', () => {
  const toasts = [];
  assert.doesNotThrow(() => {
    run({ models: [model('m1', 3)] }, { open: () => null, _ccToast: (m) => toasts.push(m) });
  });
  assert.ok(toasts.some((m) => /popup/i.test(m)));
});

test('includes the project name, model table, and a Print / Save as PDF trigger', () => {
  const html = run({ models: [model('m1', 3)], activeProject: 'Tower B Renovation' });
  assert.ok(html.includes('Tower B Renovation'));
  assert.ok(html.includes('Model m1'));
  assert.ok(html.includes('window.print()'));
  assert.ok(html.includes('Data quality report'));
});

test('includes the Quality Score and marks non-scoring categories as such', () => {
  const html = run({ models: [model('m1', 3)] });
  assert.ok(/Quality Score \(B\)/.test(html));
  assert.ok(html.includes('78'));
  assert.ok(/RVB BIM Norm<\/span>/.test(html) === false); // label is followed by the "(shown, not scored)" suffix, not bare
  assert.ok(html.includes('(shown, not scored)'));
});

test('renders every check-engine section: General/BIM, ILS, RVB, and Accessibility when available', () => {
  const html = run({ models: [model('m1', 3)] });
  assert.ok(html.includes('General &amp; BIM basics'));
  assert.ok(html.includes('No material assigned'));
  assert.ok(html.includes('Missing FireRating'));
  assert.ok(html.includes('ILS / NL-SfB'));
  assert.ok(html.includes('RVB BIM Norm v1.1'));
  assert.ok(html.includes('IfcProject zonder naam'));
  assert.ok(html.includes('Accessibility (NL Bbl/NEN)'));
  assert.ok(html.includes('Door clear width'));
});

test('omits the Accessibility section entirely when that engine is not loaded', () => {
  const html = run({ models: [model('m1', 3)] }, { _ccRunAccessibilityChecks: undefined });
  assert.ok(!html.includes('Accessibility (NL Bbl/NEN)'));
});

test('a zero-count check renders a checkmark, not "0"', () => {
  const html = run({ models: [model('m1', 3)] });
  assert.ok(/Geen NL\/SfB classificatie<\/td><td[^>]*>✓/.test(html));
});

test('escapes a project name containing HTML-special characters', () => {
  const html = run({ models: [model('m1', 3)], activeProject: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
