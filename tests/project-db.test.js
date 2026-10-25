'use strict';
// Regression tests for api/project.js's DB-touching paths (PUT dedupe/
// validation, POST fallback-insert scoping, DELETE scope=project) using a
// scripted fake `@neondatabase/serverless`, plus the field-level validation
// helpers exported for direct unit testing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeReq, makeRes } = require('./_helpers');
const { installMockNeon } = require('./_neon-mock');

const plainHandler = require('../api/project.js'); // no DB env — used for the pure-function tests below

// ── validateIssue / stripToShared: field-level validation (B.5) ──────────

test('validateIssue rejects an unparsable _updatedAt instead of letting PUT 500 on toISOString()', () => {
  assert.equal(plainHandler.validateIssue({ id: 'a', status: 'open', title: 'x', _updatedAt: 'not-a-date' }), false);
  assert.equal(plainHandler.validateIssue({ id: 'a', status: 'open', title: 'x', _updatedAt: new Date().toISOString() }), true);
});

test('validateIssue rejects a non-finite distance', () => {
  assert.equal(plainHandler.validateIssue({ id: 'a', status: 'open', title: 'x', distance: NaN }), false);
  assert.equal(plainHandler.validateIssue({ id: 'a', status: 'open', title: 'x', distance: Infinity }), false);
  assert.equal(plainHandler.validateIssue({ id: 'a', status: 'open', title: 'x', distance: 0 }), true);
});

test('validateIssue rejects an overlong title/description/assignee/id', () => {
  assert.equal(plainHandler.validateIssue({ id: 'a', status: 'open', title: 'y'.repeat(501) }), false);
  assert.equal(plainHandler.validateIssue({ id: 'a', status: 'open', title: 'x', description: 'y'.repeat(5001) }), false);
  assert.equal(plainHandler.validateIssue({ id: 'a', status: 'open', title: 'x', assignee: 'y'.repeat(201) }), false);
  assert.equal(plainHandler.validateIssue({ id: 'y'.repeat(201), status: 'open', title: 'x' }), false);
});

test('stripToShared preserves distance:0 (not the same as "no distance")', () => {
  assert.equal(plainHandler.stripToShared({ id: 'a', status: 'open', distance: 0 }).distance, 0);
});

test('stripToShared preserves an explicit "" (cleared field) instead of collapsing it to null', () => {
  const shared = plainHandler.stripToShared({ id: 'a', status: 'open', assignee: '', description: '', category: '' });
  assert.equal(shared.assignee, '');
  assert.equal(shared.description, '');
  assert.equal(shared.category, '');
});

test('stripToShared still defaults a genuinely-absent field to null', () => {
  const shared = plainHandler.stripToShared({ id: 'a', status: 'open' });
  assert.equal(shared.assignee, null);
  assert.equal(shared.description, null);
});

// ── PUT: the old per-issue shape is refused (the change log is v2) ────────
// The compare-and-swap on updated_at (and its dedupe / updatedAt / conflicts
// replies) is gone: a v2 PUT appends change records and never rejects a
// concurrent edit (tests/project-changelog.test.js). An old client's PUT is
// refused as a whole, without touching the database beyond the project row.

test('an old-shape PUT writes nothing and reports every id as not applied (client_outdated)', async () => {
  const mock = installMockNeon([
    () => [{ id: 'PRJ-1', name: 'Test', edit_key: null, expires_at: null }], // loadProjectRow — and nothing else
  ]);
  const handler = require('../api/project.js');
  const res = makeRes();
  await handler(makeReq({
    method: 'PUT',
    query: { id: 'PRJ-1' },
    body: { issues: [
      { id: 'c1', status: 'open', title: 'first' },
      { id: 'c2', status: 'open', title: 'second' },
    ] },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.synced, 0);
  assert.equal(res.body.error, 'client_outdated');
  assert.deepEqual(res.body.conflicts, ['c1', 'c2']);
  assert.equal(mock.calls.length, 1, 'no write statement ran');
  mock.restore();
});

// ── POST: fallback-insert must only trigger on a missing-column error ────

test('POST create: a missing-column error falls back to a bare insert (legacy-schema deployment)', async () => {
  const mock = installMockNeon([
    () => [], // key-uniqueness check
    () => { const e = new Error('column "edit_key" of relation "shared_projects" does not exist'); e.code = '42703'; throw e; }, // insert w/ edit_key fails
    () => [], // bare fallback insert succeeds
  ]);
  const handler = require('../api/project.js');
  const res = makeRes();
  await handler(makeReq({ method: 'POST', body: { name: 'Legacy Project' } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.editKey, null); // fallback path never has an editKey
  mock.restore();
});

test('POST create: a non-column error (e.g. connection drop) is NOT swallowed by the fallback path', async () => {
  const mock = installMockNeon([
    () => [], // key-uniqueness check
    () => { throw new Error('connection terminated unexpectedly'); }, // insert fails for an unrelated reason
  ]);
  const handler = require('../api/project.js');
  const res = makeRes();
  await handler(makeReq({ method: 'POST', body: { name: 'X' } }), res);
  // Must surface as the generic 500 error handler, not a silent 201 with a
  // bare (editKey-less) project masking a real DB failure.
  assert.equal(res.statusCode, 500);
  mock.restore();
});

// ── DELETE: scope=project (creator-only, editKey-gated whole-project delete) ─

test('DELETE scope=project removes every issue and the project row when the editKey matches', async () => {
  const editKey = 'abcd1234efgh5678';
  const hash = plainHandler.hashEditKey(editKey);
  let deleteCalls = [];
  const mock = installMockNeon([
    () => [{ id: 'PRJ-1', name: 'Test', edit_key: hash, expires_at: null }], // loadProjectRow
    (strings) => { deleteCalls.push(strings.join('?')); return []; }, // DELETE shared_issues
    (strings) => { deleteCalls.push(strings.join('?')); return []; }, // DELETE shared_changes
    (strings) => { deleteCalls.push(strings.join('?')); return []; }, // DELETE shared_projects
  ]);
  const handler = require('../api/project.js');
  const res = makeRes();
  await handler(makeReq({
    method: 'DELETE',
    query: { id: 'PRJ-1', scope: 'project' },
    headers: { 'x-cc-edit-key': editKey },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedProject, true);
  assert.equal(deleteCalls.length, 3);
  assert.match(deleteCalls[1], /DELETE FROM shared_changes/);
  mock.restore();
});

test('DELETE scope=project is refused (403) with a wrong editKey and nothing is deleted', async () => {
  const hash = plainHandler.hashEditKey('correct-key');
  const mock = installMockNeon([
    () => [{ id: 'PRJ-1', name: 'Test', edit_key: hash, expires_at: null }],
  ]);
  const handler = require('../api/project.js');
  const res = makeRes();
  await handler(makeReq({
    method: 'DELETE',
    query: { id: 'PRJ-1', scope: 'project' },
    headers: { 'x-cc-edit-key': 'wrong-key' },
  }), res);
  assert.equal(res.statusCode, 403);
  mock.restore();
});

test('DELETE with neither issue nor scope=project is a 400, not an accidental whole-project wipe', async () => {
  const mock = installMockNeon([]);
  const handler = require('../api/project.js');
  const res = makeRes();
  await handler(makeReq({ method: 'DELETE', query: { id: 'PRJ-1' } }), res);
  assert.equal(res.statusCode, 400);
  mock.restore();
});

// ── Rate limiter pruning (B.5) ────────────────────────────────────────────

test('rate limiter map is pruned of stale buckets instead of growing forever', () => {
  const lib = require('../api/_lib');
  const realNow = Date.now;
  try {
    // Start from the real clock (not a fixed epoch) — _pruneRateMap's
    // "haven't pruned in >= 60s" gate compares against whatever real
    // wall-clock time an earlier test in this process last pruned at, so a
    // fixed-in-the-past fakeNow would look older than that and the gate
    // would never re-open.
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    for (let i = 0; i < 25; i++) lib.rateLimit('prune-test-ip-' + i, 100);
    const before = lib._rateMapSizeForTest();
    assert.ok(before >= 25);
    fakeNow += 5 * 60000; // well past the 60s staleness window and the prune interval
    lib.rateLimit('prune-test-trigger', 100); // any call runs the opportunistic prune
    const after = lib._rateMapSizeForTest();
    assert.ok(after < before, 'stale buckets should have been pruned (before=' + before + ' after=' + after + ')');
  } finally {
    Date.now = realNow;
  }
});
