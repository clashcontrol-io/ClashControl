'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeReq, makeRes } = require('./_helpers');
const handler = require('../api/training.js');

function consentReq(body, extra) {
  return makeReq(Object.assign({ body, headers: { 'x-cc-consent': 'true' } }, extra));
}

test('training ingestion requires a consent signal', async () => {
  const res = makeRes();
  await handler(makeReq({ body: { type: 'nl_command', input: 'show clashes' } }), res);
  assert.equal(res.statusCode, 403);
});

test('training ingestion rejects oversized bodies and batches before DB access', async () => {
  const bodyRes = makeRes();
  await handler(consentReq({ type: 'nl_command', input: 'x'.repeat(handler._limits.maxBodyBytes + 1) }), bodyRes);
  assert.equal(bodyRes.statusCode, 413);

  const batchRes = makeRes();
  const batch = Array.from({ length: handler._limits.maxBatchRecords + 1 }, () => ({ type: 'detection_run' }));
  await handler(consentReq({ batch }), batchRes);
  assert.equal(batchRes.statusCode, 413);
  assert.equal(batchRes.body.maxRecords, handler._limits.maxBatchRecords);
});

test('unknown and wholly invalid record types return 400', async () => {
  const single = makeRes();
  await handler(consentReq({ type: 'mystery' }), single);
  assert.equal(single.statusCode, 400);

  const batch = makeRes();
  await handler(consentReq({ batch: [{ type: 'mystery' }, null] }), batch);
  assert.equal(batch.statusCode, 400);
});

test('normal records preserve the endpoint contract and reach the no-DB guard', async () => {
  const res = makeRes();
  await handler(consentReq({ type: 'detection_run', runId: 'run-1', clashCount: 4 }), res);
  assert.equal(res.statusCode, 503);
});

test('normalization clamps fields and strips obvious contact/path data', () => {
  const nl = handler._normalizeRecord({
    type: 'nl_command',
    input: 'open C:\\Users\\Sam\\secret.ifc for sam@example.com',
    confidence: 7,
    action: 'x'.repeat(200),
  });
  assert.equal(nl.input.includes('secret.ifc'), false);
  assert.equal(nl.input.includes('sam@example.com'), false);
  assert.equal(nl.confidence, 1);
  assert.equal(nl.action.length, 100);

  const run = handler._normalizeRecord({ type: 'detection_run', clashCount: -5, durationMs: Infinity });
  assert.equal(run.clashCount, 0);
  assert.equal(run.durationMs, 0);
});
