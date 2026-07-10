'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fetchWithRetry } = require('../api/_lib');

function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => {
    global.fetch = original;
  });
}

test('fetchWithRetry returns immediately on success, no retry', async () => {
  let calls = 0;
  await withMockedFetch(
    async () => { calls++; return { status: 200, ok: true }; },
    async () => {
      const res = await fetchWithRetry('https://example.test', {}, 3);
      assert.equal(res.status, 200);
    }
  );
  assert.equal(calls, 1);
});

test('fetchWithRetry does not retry a non-transient status (400)', async () => {
  let calls = 0;
  await withMockedFetch(
    async () => { calls++; return { status: 400, ok: false }; },
    async () => {
      const res = await fetchWithRetry('https://example.test', {}, 3);
      assert.equal(res.status, 400);
    }
  );
  assert.equal(calls, 1, 'a 4xx caller-error status must not be retried');
});

test('fetchWithRetry retries a transient status (503) and returns the last response when exhausted', async () => {
  let calls = 0;
  await withMockedFetch(
    async () => { calls++; return { status: 503, ok: false }; },
    async () => {
      const res = await fetchWithRetry('https://example.test', {}, 2);
      assert.equal(res.status, 503);
    }
  );
  assert.equal(calls, 2, 'should have retried once before giving up');
});

test('fetchWithRetry retries a network exception and succeeds on the next attempt', async () => {
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return { status: 200, ok: true };
    },
    async () => {
      const res = await fetchWithRetry('https://example.test', {}, 2);
      assert.equal(res.status, 200);
    }
  );
  assert.equal(calls, 2);
});
