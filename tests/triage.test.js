'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeReq, makeRes } = require('./_helpers');
const handler = require('../api/triage.js');

test('upstream AI failure returns a generic 502 without the upstream status', async () => {
  const realFetch = global.fetch;
  const realErr = console.error;
  const logged = [];
  process.env.GEMINI_API_KEY = 'test-key-secret';
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const res = makeRes();
    await handler(makeReq({ body: { context: { n: Math.random() } } }), res);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { error: 'AI request failed' });
    assert.ok(!JSON.stringify(res.body).includes('403'));
    assert.ok(!logged.join('\n').includes('test-key-secret'), 'key must not be logged');
  } finally {
    global.fetch = realFetch; console.error = realErr; delete process.env.GEMINI_API_KEY;
  }
});
