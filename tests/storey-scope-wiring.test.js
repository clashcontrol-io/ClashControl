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
  const start = html.indexOf('onConfirm=${function(chosen, autoComplete){');
  const end = html.indexOf('}} />', start);
  const body = html.slice(start, end);
  assert.match(body, /if \(chosen\) window\._ccNextLoadScope = \{ storeys: chosen \};/);
  // The null branch (allChecked) intentionally does nothing to the scope —
  // confirmed by there being exactly one assignment, gated on `chosen`.
  assert.equal((body.match(/window\._ccNextLoadScope\s*=/g) || []).length, 1);
});

test('background-auto-complete only registers when a real partial scope was chosen', () => {
  // "Load all" (chosen === null) must never register an auto-complete
  // intent — there is nothing to complete in the background for a full
  // load. Reuses the exact same tested _ccReloadModelFull the manual
  // partial-load badge button already calls (see the loadedScope check in
  // ModelSidebar's per-file load handler) — deliberately NOT a new
  // incremental/partial loading state (see MEMORY.md's chunk-merge
  // history for why that distinction matters).
  const start = html.indexOf('onConfirm=${function(chosen, autoComplete){');
  const end = html.indexOf('}} />', start);
  const body = html.slice(start, end);
  assert.match(body, /if \(chosen && autoComplete\) \{/);
  assert.match(body, /window\._ccAutoCompleteScopedLoads\.add\(storeyChooser\.ifcFileName\)/);
});

test('the per-file load handler auto-triggers _ccReloadModelFull only for registered scoped loads, after the IDB persist settles', () => {
  // Must wait for _persistDone (idbSaveFile) before calling
  // _ccReloadModelFull, which reads the file straight back out of
  // IndexedDB — firing synchronously is a real race (found via this
  // session's own browser test: silent "Original file not found" no-op).
  assert.match(html, /window\._ccAutoCompleteScopedLoads\.delete\(f\.name\);\s*\n\s*_persistDone\.then\(function\(\) \{\s*\n\s*if \(window\._ccReloadModelFull\) window\._ccReloadModelFull\(modelId\);\s*\n\s*\}\);/);
  // Still gated behind the loadedScope check — a full (non-scoped) load
  // must never look at the auto-complete registry at all.
  assert.match(html, /if \(!\(result\.stats && result\.stats\.loadedScope\)\) \{\s*\n\s*idbSaveGeoCache\(modelId, _geoSerialize\(result\)\);\s*\n\s*\} else if \(window\._ccAutoCompleteScopedLoads/);
});

test('_ccReloadModelFull skips the scope picker on its own reload (would otherwise re-open it forever)', () => {
  const start = html.indexOf('window._ccReloadModelFull = function(modelId) {');
  const end = html.indexOf('\n  };', start);
  const body = html.slice(start, end);
  assert.match(body, /window\._ccSkipScopeCheckOnce = true;/);
});

test('maybeScopeThenProcess honors _ccSkipScopeCheckOnce and consumes it exactly once', () => {
  const start = html.indexOf('function maybeScopeThenProcess(files) {');
  const end = html.indexOf('\n    function onFiles', start);
  const body = html.slice(start, end);
  assert.match(body, /if \(window\._ccSkipScopeCheckOnce\) \{\s*\n\s*window\._ccSkipScopeCheckOnce = false;\s*\n\s*processFiles\(files\);\s*\n\s*return;\s*\n\s*\}/);
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

test('the pre-decode scan reads the file incrementally, not via ifcFile.text()', () => {
  // Regression guard for the memory-spike finding: ifcFile.text() decodes
  // the WHOLE file into one JS string before the real load even starts —
  // on a 300MB IFC that's a real, avoidable spike on exactly the large-model
  // case this chooser exists for. Must go through the chunked
  // File.slice()+TextDecoder scanner instead.
  const start = html.indexOf('function maybeScopeThenProcess(files) {');
  const end = html.indexOf('\n    function onFiles', start);
  const body = html.slice(start, end);
  assert.match(body, /window\._ccExtractStoreyNamesFromIfcFileIncremental[\s\S]*?window\._ccExtractStoreyNamesFromIfcFileIncremental\(ifcFile\)/);
  // (the source's own comment mentions ifcFile.text() by name to explain
  // what NOT to do — assert against the actual call form, not the bare
  // substring, so that documentation doesn't trip its own regression guard)
  assert.doesNotMatch(body, /=\s*ifcFile\.text\(\)|ifcFile\.text\(\)\.then/);
});
