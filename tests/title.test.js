'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeReq, makeRes } = require('./_helpers');

// A key must be present so validation runs past the "AI not configured" guard.
// No network is hit: every assertion below short-circuits before the fetch.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
const handler = require('../api/title.js');

test('rejects an empty clashes array with 400', async () => {
  const res = makeRes();
  await handler(makeReq({ body: { clashes: [] } }), res);
  assert.equal(res.statusCode, 400);
});

test('rejects more than the cap with 413 instead of silently truncating', async () => {
  // Regression lock: the cap is 20 and oversized payloads are rejected, not
  // sliced down to 20 (which used to drop clashes 21+ without telling anyone).
  const clashes = Array.from({ length: 21 }, (_, i) => ({ id: String(i) }));
  const res = makeRes();
  await handler(makeReq({ body: { clashes } }), res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.maxClashes, 20);
});

test('rejects a non-POST method with 405', async () => {
  const res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
});
