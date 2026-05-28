'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeReq, makeRes } = require('./_helpers');

// Key present so validation runs past the "AI not configured" guard.
// All assertions short-circuit before any upstream model call.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
const handler = require('../api/nl.js');

test('rejects a missing command with 400', async () => {
  const res = makeRes();
  await handler(makeReq({ body: {} }), res);
  assert.equal(res.statusCode, 400);
});

test('rejects a non-string command with 400', async () => {
  const res = makeRes();
  await handler(makeReq({ body: { command: 123 } }), res);
  assert.equal(res.statusCode, 400);
});

test('rejects an oversized command with 413', async () => {
  const res = makeRes();
  await handler(makeReq({ body: { command: 'x'.repeat(1001) } }), res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.maxChars, 1000);
});
