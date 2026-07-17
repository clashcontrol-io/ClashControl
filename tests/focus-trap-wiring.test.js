'use strict';
// REWRITE_UI_PLAN.md Phase 9 — wiring lock for the shared focus-trap
// primitive (_ccUseFocusTrap) and its first verified integration
// (ShortcutsModal). Structural checks only, matching cc-runtime-wiring.test.js's
// style — the actual focus/Tab/Escape/restore behavior was verified in a
// real browser (open -> focus moves to first focusable -> Shift+Tab wraps
// -> Escape closes -> focus restores to the opener), which node:test can't
// exercise without a DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const safety = readFileSync(join(__dirname, '..', 'safety-migrations.js'), 'utf8');

test('_ccUseFocusTrap is defined once and exposed on window', () => {
  assert.match(html, /function _ccUseFocusTrap\(containerRef, active\) \{/);
  assert.match(html, /window\._ccUseFocusTrap = _ccUseFocusTrap;/);
});

test('the trap intercepts Tab in the capture phase only — every other key still reaches modal-owned handlers', () => {
  const start = html.indexOf('function _ccUseFocusTrap(containerRef, active) {');
  const end = html.indexOf('\n  window._ccUseFocusTrap', start);
  const body = html.slice(start, end);
  assert.match(body, /if \(e\.key !== 'Tab'\) return;/);
  assert.match(body, /addEventListener\('keydown', onKeyDown, true\)/);
});

test('the trap saves the opener and restores focus to it on cleanup/unmount', () => {
  const start = html.indexOf('function _ccUseFocusTrap(containerRef, active) {');
  const end = html.indexOf('\n  window._ccUseFocusTrap', start);
  const body = html.slice(start, end);
  assert.match(body, /openerRef\.current = document\.activeElement;/);
  assert.match(body, /opener\.focus\(\);/);
});

test('ccUiModalV2 flag exists and defaults off (same convention as every other UI flag)', () => {
  assert.match(safety, /ccUiModalV2: Object\.freeze\({ fallback: 'legacy', defaultEnabled: false }\)/);
});

test('ShortcutsModal calls the trap behind the ccUiModalV2 flag, without touching its existing Escape handler', () => {
  const start = html.indexOf('function ShortcutsModal(props) {');
  const end = html.indexOf('\n  function ', start + 10);
  const body = html.slice(start, end);
  assert.match(body, /isEnabled\('ccUiModalV2'\)/);
  assert.match(body, /_ccUseFocusTrap\(cardRef, modalV2On\)/);
  // The pre-existing Escape-to-close effect is untouched.
  assert.match(body, /if \(e\.key === 'Escape'\) onClose\(\);/);
  assert.match(body, /ref=\$\{cardRef\}/);
});
