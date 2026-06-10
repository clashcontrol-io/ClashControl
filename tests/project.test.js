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
