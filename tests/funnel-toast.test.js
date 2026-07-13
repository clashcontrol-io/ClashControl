'use strict';
// Locks _showFunnelToast (index.html) — Wave 1.7. A one-line "raw pairs →
// filtered by matrix → clashes found" summary shown after every browser-
// engine detection run, so the matrix/tolerance filtering is visible without
// opening the diagnostics profile panel (off by default for most users).
// Extracted the same way tests/ifc-units.test.js pulls a slice out of the
// inline script; window._ccDetectProfile/_ccToast are mocked since the real
// function only reads/calls them, never THREE.js or the DOM.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _showFunnelToast() {');
assert.ok(start !== -1, '_showFunnelToast not found');
const end = src.indexOf('\n  }', start) + '\n  }'.length;
const fnSrc = src.slice(start, end);

function run(profile) {
  const toasts = [];
  const _window = { _ccDetectProfile: profile, _ccToast: (msg) => toasts.push(msg) };
  new Function('window', fnSrc + '; window._ccT_run = _showFunnelToast;')(_window);
  _window._ccT_run();
  return toasts;
}

test('reports the full funnel when the matrix skipped pairs', () => {
  const toasts = run({ candidates: 4200, matrix_skipped: 380, clashes_found: 47 });
  assert.deepEqual(toasts, ['4200 pairs checked → 380 filtered by discipline matrix → 47 clashes found']);
});

test('omits the matrix clause entirely when nothing was skipped by it', () => {
  const toasts = run({ candidates: 100, matrix_skipped: 0, clashes_found: 12 });
  assert.deepEqual(toasts, ['100 pairs checked → 12 clashes found']);
});

test('pluralizes pair/pairs and clash/clashes correctly at the boundary (1 vs many)', () => {
  assert.deepEqual(run({ candidates: 1, matrix_skipped: 0, clashes_found: 1 }),
    ['1 pair checked → 1 clash found']);
  assert.deepEqual(run({ candidates: 2, matrix_skipped: 0, clashes_found: 0 }),
    ['2 pairs checked → 0 clashes found']);
});

test('does nothing when there is no profile yet (no detection has run)', () => {
  assert.deepEqual(run(null), []);
  assert.deepEqual(run(undefined), []);
});

test('does nothing when the profile is missing the candidates field (defensive, wrong shape)', () => {
  assert.deepEqual(run({ matrix_skipped: 5, clashes_found: 2 }), []);
});

test('never throws even if window._ccToast is missing', () => {
  const _window = { _ccDetectProfile: { candidates: 10, matrix_skipped: 0, clashes_found: 1 } };
  assert.doesNotThrow(() => {
    new Function('window', fnSrc + '; window._ccT_run = _showFunnelToast;')(_window);
    _window._ccT_run();
  });
});
