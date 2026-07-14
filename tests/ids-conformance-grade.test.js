'use strict';
// Locks gradeIDSCase (tests/browser/ids-grade.js) — the pure comparison
// logic behind the buildingSMART IDS conformance CI job
// (tests/browser/ids-conformance.mjs). That script drives real .ifc/.ids
// pairs through a real headless-Chromium + web-ifc pipeline and can only be
// verified by actually running in CI (no CDN access in this sandbox, see
// MEMORY.md), so the one part of that job that COULD be dishonest — how a
// summary gets turned into a pass/fail/incomplete verdict — is pulled out
// here and tested directly, with no browser/network dependency.
const { test } = require('node:test');
const assert = require('node:assert');
const { gradeIDSCase } = require('./browser/ids-grade.js');

function summary(fail, bySpec) {
  return { total: 10, pass: 10 - fail, fail: fail, bySpec: bySpec || {} };
}

test('pass- case, CC found no failures, nothing unchecked -> conform', () => {
  const r = gradeIDSCase('pass', summary(0, { S: { pass: 2, fail: 0, unchecked: 0 } }));
  assert.equal(r.verdict, 'conform');
});

test('pass- case, CC reports a failure -> wrong (false fail)', () => {
  const r = gradeIDSCase('pass', summary(1, { S: { pass: 1, fail: 1, unchecked: 0 } }));
  assert.equal(r.verdict, 'wrong');
  assert.match(r.reason, /false fail/);
});

test('pass- case, correct verdict but a requirement was not checkable -> incomplete, not conform', () => {
  const r = gradeIDSCase('pass', summary(0, { S: { pass: 1, fail: 0, unchecked: 1, note: 'Requirement "x" not checkable in-browser' } }));
  assert.equal(r.verdict, 'incomplete');
});

test('fail- case, CC found a failure -> conform', () => {
  const r = gradeIDSCase('fail', summary(1, { S: { pass: 0, fail: 1, unchecked: 0 } }));
  assert.equal(r.verdict, 'conform');
});

test('fail- case, CC reports all pass -> wrong (false pass, the dangerous direction)', () => {
  const r = gradeIDSCase('fail', summary(0, { S: { pass: 2, fail: 0, unchecked: 0 } }));
  assert.equal(r.verdict, 'wrong');
  assert.match(r.reason, /false pass/);
});

test('fail- case, verdict mismatch but a requirement was not checkable -> incomplete, not wrong', () => {
  const r = gradeIDSCase('fail', summary(0, { S: { pass: 1, fail: 0, unchecked: 1, note: 'not checkable in-browser' } }));
  assert.equal(r.verdict, 'incomplete');
});

test('invalid- case is graded exactly like fail- (spec makes conformance impossible)', () => {
  const conform = gradeIDSCase('invalid', summary(1, { S: { pass: 0, fail: 1, unchecked: 0 } }));
  assert.equal(conform.verdict, 'conform');
  const wrong = gradeIDSCase('invalid', summary(0, { S: { pass: 1, fail: 0, unchecked: 0 } }));
  assert.equal(wrong.verdict, 'wrong');
});

test('unchecked signal also fires off the note text alone (unchecked count of 0 but a skip note)', () => {
  const r = gradeIDSCase('pass', summary(0, { S: { pass: 0, fail: 0, unchecked: 0, note: 'Specification skipped (unsupported applicability)' } }));
  assert.equal(r.verdict, 'incomplete');
});

test('multiple specs: any one of them being unchecked is enough to mark the case incomplete', () => {
  const r = gradeIDSCase('pass', summary(0, {
    Checkable: { pass: 1, fail: 0, unchecked: 0 },
    NotCheckable: { pass: 0, fail: 0, unchecked: 1, note: 'not checkable in-browser' },
  }));
  assert.equal(r.verdict, 'incomplete');
});

test('a case with no bySpec entries at all does not throw (defensive)', () => {
  assert.doesNotThrow(() => gradeIDSCase('pass', { total: 0, pass: 0, fail: 0 }));
});
