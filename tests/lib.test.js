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

// --- clientIp: only the first (platform-set) x-forwarded-for entry counts ---
const { clientIp } = require('../api/_lib');

test('clientIp uses only the first x-forwarded-for entry, trimmed', () => {
  const req = makeReq({ headers: { 'x-forwarded-for': ' 1.2.3.4 , 9.9.9.9, 8.8.8.8' } });
  assert.equal(clientIp(req), '1.2.3.4');
});

test('clientIp: rotating trailing xff entries cannot evade rateLimit', () => {
  let limited = false;
  for (let i = 0; i < 6; i++) {
    const req = makeReq({ headers: { 'x-forwarded-for': '7.7.7.7, spoof-' + i } });
    limited = rateLimit(clientIp(req), 5) || limited;
  }
  assert.equal(limited, true);
});

test('clientIp falls back to x-real-ip, then socket address', () => {
  assert.equal(clientIp(makeReq({ headers: { 'x-real-ip': '5.5.5.5' } })), '5.5.5.5');
  assert.equal(clientIp(makeReq({ headers: {}, ip: '6.6.6.6' })), '6.6.6.6');
  assert.equal(clientIp(makeReq({ headers: { 'x-forwarded-for': '' }, ip: '6.6.6.6' })), '6.6.6.6');
});
