'use strict';
// REWRITE_UI_PLAN.md Phase 5 — wiring lock for OperationCenter. Mirrors the
// style of tests/cc-runtime-wiring.test.js: greps the served source for the
// structural guarantees a component test can't easily exercise without a
// browser (real DOM interaction is covered by the browser smoke instead).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const safety = readFileSync(join(__dirname, '..', 'safety-migrations.js'), 'utf8');

test('OperationCenter is flag-gated behind ccUiOperationCenter, default off', () => {
  assert.match(safety, /ccUiOperationCenter: Object\.freeze/);
  const fnStart = html.indexOf('function OperationCenter(props) {');
  assert.ok(fnStart !== -1);
  const fnBody = html.slice(fnStart, html.indexOf('\n  function ', fnStart + 10));
  assert.match(fnBody, /isEnabled\('ccUiOperationCenter'\)/);
  assert.match(fnBody, /if \(!on\) return null;/);
});

test('OperationCenter is mounted once in the app shell, next to PrivacyBanner', () => {
  const count = (html.match(/<\$\{OperationCenter\}/g) || []).length;
  assert.equal(count, 1, 'OperationCenter should mount exactly once');
  const privacyIdx = html.indexOf('<${PrivacyBanner} />');
  const opIdx = html.indexOf('<${OperationCenter}');
  assert.ok(privacyIdx !== -1 && opIdx !== -1 && opIdx > privacyIdx && opIdx - privacyIdx < 200);
});

test('cancel actions reuse the existing abort hooks, no new cancellation path', () => {
  const fnStart = html.indexOf('function OperationCenter(props) {');
  const fnEnd = html.indexOf('\n  function ', fnStart + 10);
  const fnBody = html.slice(fnStart, fnEnd);
  assert.match(fnBody, /_ccCancelDetection/);
  assert.match(fnBody, /_ccAbortLoading/);
  assert.match(fnBody, /_revitDirectCancelExport/);
});

test('load coordinator now emits cc-load-session events (Phase 5 depends on this)', () => {
  const idx = html.indexOf('createLoadCoordinator({');
  assert.ok(idx !== -1);
  const chunk = html.slice(idx, idx + 400);
  assert.doesNotMatch(chunk, /emitEvents\s*:\s*false/, 'emitEvents:false would silence cc-load-session and break OperationCenter live updates');
});

test('cc-runtime.js createLoadCoordinator still dispatches cc-load-session by default (unchanged contract)', () => {
  const runtime = readFileSync(join(__dirname, '..', 'cc-runtime.js'), 'utf8');
  assert.match(runtime, /cc-load-session/);
  assert.match(runtime, /options\.emitEvents !== false/);
});

test('OperationCenter shows at most one operation at a time (priority: detect > load > revit)', () => {
  const fnStart = html.indexOf('function OperationCenter(props) {');
  const fnEnd = html.indexOf('\n  function ', fnStart + 10);
  const fnBody = html.slice(fnStart, fnEnd);
  const kindLine = fnBody.match(/var kind = detecting \? 'detect' : loading \? 'load' : revitBusy \? 'revit' : null;/);
  assert.ok(kindLine, 'exactly one operation kind should be selected via priority ternary, not multiple simultaneously-rendered blocks');
});
