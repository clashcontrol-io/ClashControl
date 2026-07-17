'use strict';
// REWRITE_UI_PLAN.md Phase 12 — wiring lock. Real end-to-end behavior
// (picker appears for a real 2-storey synthetic fixture dropped via the
// real window._ccLoadFiles entry point, a partial selection correctly
// threads through to window._ccNextLoadScope and the existing tested scope
// mechanism, "Load all" leaves the scope untouched) was verified in a real
// browser — this locks the structural wiring node:test can check.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const safety = readFileSync(join(__dirname, '..', 'safety-migrations.js'), 'utf8');

test('ccUiStoreyChooser flag exists and defaults off', () => {
  assert.match(safety, /ccUiStoreyChooser: Object\.freeze\({ fallback: 'legacy', defaultEnabled: false }\)/);
});

test('all three load triggers (file input, drag-drop, pending-files) route through maybeScopeThenProcess', () => {
  const start = html.indexOf('function ModelSidebar(props) {');
  const end = html.indexOf('\n  function ', start + 30);
  const body = html.slice(start, end);
  assert.match(body, /function maybeScopeThenProcess\(files\) \{/);
  // onFiles, the cc-pending-files listener, and onDrop all call the wrapper —
  // none call processFiles(files) directly anymore for user-facing triggers.
  const wrapperCalls = (body.match(/maybeScopeThenProcess\(/g) || []).length;
  assert.ok(wrapperCalls >= 4, 'expected the definition plus 3 call sites, got ' + wrapperCalls);
});

test('"Load all" (unchanged default) never sets window._ccNextLoadScope', () => {
  const start = html.indexOf('onConfirm=${function(chosen){');
  const end = html.indexOf('}} />', start);
  const body = html.slice(start, end);
  assert.match(body, /if \(chosen\) window\._ccNextLoadScope = \{ storeys: chosen \};/);
  // The null branch (allChecked) intentionally does nothing to the scope —
  // confirmed by there being exactly one assignment, gated on `chosen`.
  assert.equal((body.match(/window\._ccNextLoadScope\s*=/g) || []).length, 1);
});

test('StoreyScopeModal reuses the Phase 9 shared focus-trap primitive', () => {
  const start = html.indexOf('function StoreyScopeModal(props) {');
  const end = html.indexOf('\n  function ', start + 10);
  const body = html.slice(start, end);
  assert.match(body, /_ccUseFocusTrap\(cardRef, true\)/);
});

test('the pre-decode scan never fires for single-storey files (nothing meaningful to scope)', () => {
  const start = html.indexOf('function maybeScopeThenProcess(files) {');
  const end = html.indexOf('\n    function onFiles', start);
  const body = html.slice(start, end);
  assert.match(body, /if \(names\.length < 2\) \{ processFiles\(files\); return; \}/);
});
