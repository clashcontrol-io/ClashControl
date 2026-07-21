'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeReq, makeRes } = require('./_helpers');

const handler = require('../api/project.js');

// No POSTGRES_URL in the test env, so anything that passes the guards hits the
// 503 "Database not configured" branch — every assertion below short-circuits
// before any DB work.

test('rejects an oversized body with 413 (payload cap regression lock)', async () => {
  // /api/project is the only unauthenticated DB-write endpoint; it must cap
  // payload size like the LLM endpoints do, not just rate-limit.
  const big = { issues: [{ id: 'x', status: 'open', description: 'y'.repeat(300000) }] };
  const res = makeRes();
  await handler(makeReq({ method: 'PUT', body: big }), res);
  assert.equal(res.statusCode, 413);
});

test('a normal-sized body passes the guard (reaches the no-DB 503)', async () => {
  const res = makeRes();
  await handler(makeReq({ method: 'PUT', body: { issues: [{ id: 'a', status: 'open' }] } }), res);
  assert.equal(res.statusCode, 503);
});

// editKey is now stored hashed (SHA-256), never in plaintext, so a DB leak
// doesn't hand out delete capability for every shared project. Regression
// lock for both the hashing itself and backward compatibility with rows
// that still hold a raw, pre-hashing plaintext token.
test('editKey: a fresh key hashes to a 64-char lowercase hex digest', () => {
  const hash = handler.hashEditKey('abcd1234efgh5678');
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('editKey: hashing is deterministic (same input -> same hash)', () => {
  assert.equal(handler.hashEditKey('same-key-value'), handler.hashEditKey('same-key-value'));
});

test('editKey: matches the correct key against its own hash', () => {
  const key = 'my-secret-edit-key';
  const stored = handler.hashEditKey(key);
  assert.equal(handler.editKeyMatches(key, stored), true);
});

test('editKey: rejects the wrong key against a hash', () => {
  const stored = handler.hashEditKey('correct-key');
  assert.equal(handler.editKeyMatches('wrong-key', stored), false);
});

test('editKey: legacy plaintext rows (not a 64-char hex string) still compare directly', () => {
  // A pre-hashing row would hold a raw 16-char KEY_CHARS token, e.g. this
  // shape — never 64 hex chars, so editKeyMatches must NOT hash-compare it.
  const legacyStoredPlaintext = 'ab3xy9qz2mnpqrst';
  assert.equal(handler.editKeyMatches('ab3xy9qz2mnpqrst', legacyStoredPlaintext), true);
  assert.equal(handler.editKeyMatches('wrong', legacyStoredPlaintext), false);
});

test('editKey: empty/missing provided or stored values never match', () => {
  assert.equal(handler.editKeyMatches('', handler.hashEditKey('x')), false);
  assert.equal(handler.editKeyMatches('x', ''), false);
  assert.equal(handler.editKeyMatches(null, null), false);
});

test('project expiry: isExpired is false with no expires_at', () => {
  assert.equal(handler.isExpired({ id: 'p1' }), false);
});

test('project expiry: isExpired is true once expires_at is in the past', () => {
  assert.equal(handler.isExpired({ expires_at: new Date(Date.now() - 1000).toISOString() }), true);
});

test('project expiry: isExpired is false while expires_at is in the future', () => {
  assert.equal(handler.isExpired({ expires_at: new Date(Date.now() + 86400000).toISOString() }), false);
});

test('project expiry: isExpired is false for a null/undefined row', () => {
  assert.equal(handler.isExpired(null), false);
  assert.equal(handler.isExpired(undefined), false);
});

test('generateKey: produces a PREFIX-XXXXXX shape from the project name', () => {
  const key = handler.generateKey('My MEP Project!!');
  assert.match(key, /^[A-Z0-9]{1,4}-[a-z0-9]{6}$/);
});

test('generateKey: falls back to CC prefix for an empty/missing name', () => {
  assert.match(handler.generateKey(''), /^CC-[a-z0-9]{6}$/);
  assert.match(handler.generateKey(undefined), /^CC-[a-z0-9]{6}$/);
});
