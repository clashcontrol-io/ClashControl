'use strict';
// Detection discoverability (task: after models load, the app should not
// silently sit in Present with no hint that clash detection exists).
// Locks the pure decision function the same way tests/empty-states.test.js
// locks _ccConflictEmptyState, plus structural wiring checks node:test can
// verify without a DOM/browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ── Pure decision function ──
const start = src.indexOf('function _ccShouldShowDetectionBanner(ctx) {');
assert.ok(start !== -1, '_ccShouldShowDetectionBanner not found');
const end = src.indexOf('window._ccShouldShowDetectionBanner = _ccShouldShowDetectionBanner;', start);
assert.ok(end !== -1, '_ccShouldShowDetectionBanner closing point not found');
const endLineEnd = src.indexOf('\n', end) + 1;
const sandbox = new Function('window', `
  ${src.slice(start, endLineEnd)}
  return { shouldShow: _ccShouldShowDetectionBanner };
`);
const lib = sandbox({});

function baseCtx(overrides) {
  return Object.assign({
    hasModels: true, modelsLoading: false, detecting: false,
    rawCount: 0, ranBefore: false, dismissedForSignature: false,
  }, overrides);
}

test('no models loaded: never show', () => {
  assert.equal(lib.shouldShow(baseCtx({ hasModels: false })), false);
});

test('models still loading: never show yet', () => {
  assert.equal(lib.shouldShow(baseCtx({ modelsLoading: true })), false);
});

test('detection currently running: do not show', () => {
  assert.equal(lib.shouldShow(baseCtx({ detecting: true })), false);
});

test('clashes already exist: do not show', () => {
  assert.equal(lib.shouldShow(baseCtx({ rawCount: 5 })), false);
});

test('a detection run already happened (even zero result): do not nag again', () => {
  assert.equal(lib.shouldShow(baseCtx({ ranBefore: true })), false);
});

test('already dismissed/actioned for this exact model set: do not show', () => {
  assert.equal(lib.shouldShow(baseCtx({ dismissedForSignature: true })), false);
});

test('models loaded, nothing run yet, not dismissed: show the banner', () => {
  assert.equal(lib.shouldShow(baseCtx()), true);
});

test('missing ctx entirely defaults to not showing (hasModels falsy)', () => {
  assert.equal(lib.shouldShow(), false);
  assert.equal(lib.shouldShow(null), false);
});

// ── Wiring: banner component mounted at App level ──
test('DetectionDiscoverabilityBanner is mounted in the App render tree', () => {
  assert.match(src, /<\$\{DetectionDiscoverabilityBanner\} s=\$\{s\} \/>/);
});

test('banner run button dispatches the same SHOW_RUN_MODAL action as the toolbar ▷ button', () => {
  const compStart = src.indexOf('function DetectionDiscoverabilityBanner(props) {');
  assert.ok(compStart !== -1, 'DetectionDiscoverabilityBanner component not found');
  const compEnd = src.indexOf('\n  function PrivacyBanner(props) {', compStart);
  assert.ok(compEnd !== -1, 'DetectionDiscoverabilityBanner end not found');
  const body = src.slice(compStart, compEnd);
  assert.match(body, /A\.SHOW_RUN_MODAL,\s*v:true/);
  assert.match(body, /data-detection-banner/);
});

test('signature helper is shared (not hand-copied) between banner and any future caller', () => {
  assert.match(src, /window\._ccDetectionBannerSignature = _ccDetectionBannerSignature;/);
});

// ── Wiring: empty clash-list state now defaults to the truthful/actionable tree ──
test('ccUiEmptyStates is promoted to defaultEnabled:true (Run button in empty clash list by default)', () => {
  const safety = fs.readFileSync(path.join(__dirname, '..', 'safety-migrations.js'), 'utf8');
  assert.match(safety, /ccUiEmptyStates: Object\.freeze\(\{ fallback: 'legacy', defaultEnabled: true \}\)/);
});

// ── Wiring: toolbar Run button gets a visible text label at wide widths ──
test('toolbar runDetect button passes a textLabel and the CSS shows it only from 1100px', () => {
  assert.match(src, /k:'runDetect'[\s\S]{0,400}?textLabel:_cc_t\('toolbar\.runShort','Run'\)/);
  assert.match(src, /\.cc-btn-text-label\{display:none\}/);
  assert.match(src, /@media\(min-width:1100px\)\{\s*\.cc-btn-text-label\{display:inline\}\s*\}/);
});

test('btn() renders the textLabel span with the cc-btn-text-label class', () => {
  const fnStart = src.indexOf('function btn(opts){');
  assert.ok(fnStart !== -1, 'btn() not found');
  const fnEnd = src.indexOf('\n    function div(){', fnStart);
  const body = src.slice(fnStart, fnEnd);
  assert.match(body, /class="cc-btn-text-label"/);
});
