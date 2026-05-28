'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeReq, makeRes } = require('./_helpers');
const { cors, rateLimit } = require('../api/_lib');

test('cors echoes an allowed origin exactly', () => {
  const res = makeRes();
  const handled = cors(makeReq({ headers: { origin: 'https://www.clashcontrol.io' } }), res);
  assert.equal(handled, false);
  assert.equal(res.headers['access-control-allow-origin'], 'https://www.clashcontrol.io');
});

test('cors does NOT echo a look-alike origin (exact match only)', () => {
  const res = makeRes();
  cors(makeReq({ headers: { origin: 'http://localhost:3000.evil.com' } }), res);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('cors short-circuits OPTIONS preflight with 204', () => {
  const res = makeRes();
  const handled = cors(makeReq({ method: 'OPTIONS', headers: { origin: 'https://www.clashcontrol.io' } }), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
});

test('rateLimit allows up to the limit then trips', () => {
  const ip = 'rl-test-ip';
  let tripped = false;
  for (let i = 0; i < 5; i++) tripped = rateLimit(ip, 5) || tripped;
  assert.equal(tripped, false, 'first 5 requests within limit 5 should pass');
  assert.equal(rateLimit(ip, 5), true, '6th request should be rate-limited');
});
