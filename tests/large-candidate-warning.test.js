'use strict';
// Locks the large-model plan's Phase 4 "bounded candidate memory" honest-
// reporting slice (2026-07-17): a non-blocking window._ccToast warning when
// _sweepAndPrune's fully-materialized JS candidate array crosses 1,000,000
// pairs. Deliberately NOT a confirm()/blocking dialog — detection can fire
// from non-interactive triggers (AI/NL commands, auto-run), where a
// blocking dialog nobody is watching for would hang the run. Wiring-lock
// style (same pattern as tests/storey-scope-wiring.test.js) rather than a
// functional extraction: the check lives deep inside the large detection
// function alongside real _sweepAndPrune/rules dependencies that aren't
// worth mocking just to exercise five lines of a threshold check.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function sliceAround(needle, span) {
  const start = html.indexOf(needle);
  assert.ok(start !== -1, 'expected to find: ' + needle);
  return html.slice(start, start + span);
}

test('candidate count is checked against a 1,000,000 threshold right after the sweep', () => {
  const body = sliceAround('_prof._nCandidates = candidates.length;', 1400);
  assert.match(body, /if \(candidates\.length > 1000000 && window\._ccToast\) \{/);
});

test('the warning is non-blocking (toast, not confirm/alert) and gated on window._ccToast existing', () => {
  const body = sliceAround('_prof._nCandidates = candidates.length;', 1400);
  const warnBlock = body.slice(body.indexOf('if (candidates.length > 1000000'));
  assert.match(warnBlock, /window\._ccToast\(/);
  assert.doesNotMatch(warnBlock, /confirm\(|alert\(/);
});

test('the estimate uses the representation-aware _candidateSetBytes helper, not a flat count × 96 (V7 P0.6/P1.3)', () => {
  const body = sliceAround('_prof._nCandidates = candidates.length;', 1400);
  // The toast must size the candidate set through _candidateSetBytes so the
  // compact Wasm view (~12 B/pair + one-time item table) isn't reported at the
  // eager array's ~96 B/pair (an ~8× overstatement on large runs).
  assert.match(body, /_candidateSetBytes\(candidates\) \/ \(1024\*1024\)/);
  assert.doesNotMatch(body, /candidates\.length \* _CANDIDATE_EST_BYTES/);
});

test('_candidateSetBytes distinguishes the eager JS array from the compact Wasm view', () => {
  const idx = html.indexOf('function _candidateSetBytes(candidates)');
  assert.ok(idx !== -1, 'expected a _candidateSetBytes helper');
  const fn = html.slice(idx, html.indexOf('}', html.indexOf('return', idx)) + 1);
  // Array branch charges the eager per-candidate cost; the compact branch
  // charges the flat-array (12 B) + item-table cost instead.
  assert.match(fn, /Array\.isArray\(candidates\)/);
  assert.match(fn, /_CANDIDATE_EST_BYTES/);
  assert.match(fn, /_CANDIDATE_COMPACT_BYTES/);
});

test('_CANDIDATE_EST_BYTES is defined once and documented as an approximation, not a measured value', () => {
  const idx = html.indexOf('var _CANDIDATE_EST_BYTES');
  assert.ok(idx !== -1);
  const declLine = html.slice(idx, html.indexOf(';', idx) + 1);
  assert.match(declLine, /var _CANDIDATE_EST_BYTES = \d+;/);
  // Only one definition — a second, drifted copy would be a real bug class
  // (two constants silently disagreeing on the same estimate).
  const count = (html.match(/var _CANDIDATE_EST_BYTES = \d+;/g) || []).length;
  assert.equal(count, 1);
});

test('the warning fires after sweep_end / bvh_build_end marks, never blocking the profiling timeline', () => {
  const start = html.indexOf("_mark('sweep_end');");
  const warnIdx = html.indexOf('if (candidates.length > 1000000');
  const afterBvhMark = html.indexOf("_mark('bvh_build_end');");
  assert.ok(start !== -1 && warnIdx !== -1 && afterBvhMark !== -1);
  assert.ok(warnIdx > start && warnIdx > afterBvhMark, 'the warning must come after both marks, not interleaved with timing');
});
