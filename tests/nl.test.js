'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeReq, makeRes } = require('./_helpers');

// Validation is asserted to run BEFORE the env check, so these tests pass
// regardless of whether GROQ_API_KEY is set. The key is set here only to
// keep the assertion meaningful if the ordering ever regresses (a fail at
// the env guard would still surface as wrong status).
// (api/nl.js was migrated Gemini→Groq; legacy GEMINI_API_KEY no longer reaches
//  this handler — /api/triage + /api/title still consume Gemma separately.)
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key';
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
