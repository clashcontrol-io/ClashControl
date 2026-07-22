'use strict';
// Wiring lock for the P6.3 memory-safe loading slice (V7_RELEASE_PLAN.md).
// Deliberately conservative: this does NOT reorder the IFC worker's own
// terminate-on-props timing or defer Three.js construction — both touch the
// IFC loader, which CLAUDE.md flags as "complex but working... don't touch
// without good reason", and this repo's own history (the loader-stall
// bisection session, and every chunk-merge/instancing regression) shows that
// class of change needs live-browser verification this environment can't
// provide. Instead: before a new load proceeds, if memory is already tight,
// run the auto-park pass one beat early. Flag-gated, default off.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const safety = readFileSync(join(__dirname, '..', 'safety-migrations.js'), 'utf8');

function sliceFrom(source, needle, span) {
  const i = source.indexOf(needle);
  assert.ok(i !== -1, 'expected to find: ' + needle);
  return source.slice(i, i + span);
}

test('memorySafeLoad is registered in the safety-migrations manifest, default off', () => {
  assert.match(safety, /memorySafeLoad: Object\.freeze\(\{ fallback: 'legacy', defaultEnabled: false \}\)/);
});

test('_ccLoadFiles runs the auto-park pass only when memorySafeLoad is enabled', () => {
  const body = sliceFrom(html, 'window._ccLoadFiles = function(files) {', 900);
  assert.match(body, /isEnabled\('memorySafeLoad'\)/);
  assert.match(body, /window\._ccAutoParkPass\(\)/);
});

test('_ccLoadFiles still stages pending files and opens the models panel unconditionally (flag only gates the NEW pressure-relief step)', () => {
  const body = sliceFrom(html, 'window._ccLoadFiles = function(files) {', 900);
  assert.match(body, /window\._ccPendingFiles = Array\.prototype\.slice\.call\(files\)/);
  assert.match(body, /window\.dispatchEvent\(new CustomEvent\('cc-pending-files'\)\)/);
});

test('the pressure-relief call is guarded so a missing _ccAutoParkPass or _ccSafetyMigrations never breaks loading', () => {
  const body = sliceFrom(html, 'window._ccLoadFiles = function(files) {', 900);
  assert.match(body, /window\._ccSafetyMigrations && window\._ccSafetyMigrations\.isEnabled/);
  assert.match(body, /typeof window\._ccAutoParkPass === 'function'/);
  assert.match(body, /try \{[\s\S]*?catch\(e\) \{\}/);
});

test('this slice does NOT touch the IFC worker termination or construction sequencing (scope discipline)', () => {
  // A loose smell-test: the loadIFCWorker function body should be unchanged
  // in structure — still terminates on 'props'/'props-error', not on
  // 'result'. If a future change moves worker.terminate() to fire on
  // 'result', that's the fuller (riskier) P6.3 ask and needs its own
  // explicit, live-browser-verified pass — not a silent expansion of this one.
  const idx = html.indexOf("function loadIFCWorker(buffer, fallbackColor, onProgress, onProps, scope) {");
  assert.ok(idx !== -1);
  const body = html.slice(idx, html.indexOf("if (msg.type === 'result') {", idx));
  assert.match(body, /if \(msg\.type === 'props'\) \{/);
  assert.match(body, /worker\.terminate\(\);/);
});
