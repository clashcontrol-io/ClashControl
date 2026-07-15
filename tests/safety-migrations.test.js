const test = require('node:test');
const assert = require('node:assert/strict');

const safety = require('../safety-migrations');

test.afterEach(() => safety._setFlagsForTest({}));

test('all risky migrations are closed and disabled by default', () => {
  assert.deepEqual(Object.keys(safety.manifest), [
    'concurrencyV2', 'geoCacheV8', 'batchedSectionsV2', 'rendererV2', 'disciplineCoreV2', 'assignmentCoreV2', 'identityCoreV2', 'reconciliationCoreV2', 'classificationCoreV2'
  ]);
  for (const [name, config] of Object.entries(safety.manifest)) {
    assert.equal(config.defaultEnabled, false);
    assert.equal(safety.isEnabled(name), false);
  }
  assert.equal(safety.isEnabled('unknownMigration'), false);
});

test('only known explicit query or storage flags can opt in', () => {
  const storage = { getItem: () => JSON.stringify({ geoCacheV8: true, typo: true }) };
  const flags = safety.readFlags({
    search: '?ccSafety=concurrencyV2,unknownMigration', storage
  });
  assert.deepEqual(flags, { concurrencyV2: true, geoCacheV8: true });
});

test('model fingerprints ignore ordering but lock identity, bounds, type and mesh count', () => {
  const element = (id, min, max, type = 'IfcWall') => ({
    expressId: id, box: { min, max }, meshes: [{}, {}], props: { ifcType: type }
  });
  const a = [{ id: 'm', elements: [
    element(2, { x: 2, y: 0, z: 0 }, { x: 3, y: 1, z: 1 }),
    element(1, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 })
  ] }];
  const b = [{ id: 'm', elements: [
    element(1, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }),
    element(2, { x: 2, y: 0, z: 0 }, { x: 3, y: 1, z: 1 })
  ] }];
  assert.deepEqual(safety.modelFingerprint(a), safety.modelFingerprint(b));
  b[0].elements[0].box.max.x = 1.01;
  assert.equal(safety.compareFingerprints(
    safety.modelFingerprint(a), safety.modelFingerprint(b)
  ).equal, false);
});

test('clash fingerprints compare pairs independent of endpoint and result order', () => {
  const a = [
    { modelAId: 'a', elemA: 1, modelBId: 'b', elemB: 2, type: 'hard', distance: -0.1, point: [1, 2, 3] },
    { modelAId: 'a', elemA: 3, modelBId: 'b', elemB: 4, type: 'soft', distance: 0.02, point: [4, 5, 6] }
  ];
  const b = [
    { modelAId: 'b', elemA: 4, modelBId: 'a', elemB: 3, type: 'soft', distance: 0.02, point: [4, 5, 6] },
    { modelAId: 'b', elemA: 2, modelBId: 'a', elemB: 1, type: 'hard', distance: -0.1, point: [1, 2, 3] }
  ];
  assert.equal(safety.compareFingerprints(
    safety.clashFingerprint(a), safety.clashFingerprint(b)
  ).equal, true);
});

test('guarded candidate is never called while its flag is off', async () => {
  let candidateCalls = 0;
  const result = await safety.guardedAsync(
    'geoCacheV8', async () => 'legacy', async () => { candidateCalls++; return 'candidate'; }
  );
  assert.equal(result, 'legacy');
  assert.equal(candidateCalls, 0);
});

test('candidate exception falls back to legacy', async () => {
  safety._setFlagsForTest({ geoCacheV8: true });
  const result = await safety.guardedAsync(
    'geoCacheV8', async () => 'legacy', async () => { throw new Error('broken cache'); }
  );
  assert.equal(result, 'legacy');
  assert.equal(safety.diagnostics().at(-1).outcome, 'fallback');
});

test('candidate mismatch returns the known legacy result', async () => {
  safety._setFlagsForTest({ concurrencyV2: true });
  const result = await safety.guardedAsync(
    'concurrencyV2', async () => [{ key: 'a', value: 1 }],
    async () => [{ key: 'a', value: 2 }], safety.compareFingerprints
  );
  assert.deepEqual(result, [{ key: 'a', value: 1 }]);
  assert.equal(safety.diagnostics().at(-1).outcome, 'mismatch');
});

test('candidate result is returned only when equivalence passes', async () => {
  safety._setFlagsForTest({ rendererV2: true });
  const result = await safety.guardedAsync(
    'rendererV2', async () => [{ key: 'a', value: 1 }],
    async () => [{ key: 'a', value: 1 }], safety.compareFingerprints
  );
  assert.deepEqual(result, [{ key: 'a', value: 1 }]);
  assert.equal(safety.diagnostics().at(-1).outcome, 'candidate');
});

test('run coordinator admits one writer and rejects overlapping starts', () => {
  const coordinator = safety.createRunCoordinator();
  const first = coordinator.begin('detection');
  assert.ok(first);
  assert.equal(coordinator.begin('detection'), null);
  assert.equal(coordinator.isCurrent(first), true);
  assert.equal(coordinator.finish({ id: first.id + 1 }), false);
  assert.equal(coordinator.isCurrent(first), true);
  assert.equal(coordinator.finish(first), true);
  assert.ok(coordinator.begin('detection'));
});

test('cancelling a coordinated run invalidates its token immediately', () => {
  const coordinator = safety.createRunCoordinator();
  const token = coordinator.begin('detection');
  assert.deepEqual(coordinator.cancel(), token);
  assert.equal(coordinator.isCurrent(token), false);
  assert.equal(coordinator.finish(token), false);
  assert.ok(coordinator.begin('replacement'));
});

test('v8 cache keys are isolated and the legacy key remains byte-for-byte unchanged', () => {
  assert.equal(safety.geoCacheKey('model-1', true), 'v8:model-1');
  assert.equal(safety.geoCacheKey('model-1', false), 'model-1');
});

function validCachePayload() {
  return {
    v: 8,
    meshData: [{
      eid: 7,
      bbox: [0, 0, 0, 1, 1, 1],
      mtx: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      col: [0.1, 0.2, 0.3, 1],
      qpos: new ArrayBuffer(6), qnrm: new ArrayBuffer(2), idx: new ArrayBuffer(2)
    }],
    elData: [{ eid: 7, box: [0, 0, 0, 1, 1, 1], props: {} }]
  };
}

test('v8 cache validator accepts a complete payload', () => {
  assert.deepEqual(safety.validateGeoCachePayload(validCachePayload()), { valid:true, reason:null });
});

test('v8 cache validator rejects old schemas, invalid bounds, buffers and orphan meshes', () => {
  const old = validCachePayload(); old.v = 7;
  assert.equal(safety.validateGeoCachePayload(old).valid, false);
  const badBounds = validCachePayload(); badBounds.elData[0].box[2] = Infinity;
  assert.equal(safety.validateGeoCachePayload(badBounds).valid, false);
  const badBuffer = validCachePayload(); badBuffer.meshData[0].qpos = null;
  assert.equal(safety.validateGeoCachePayload(badBuffer).valid, false);
  const orphan = validCachePayload(); orphan.meshData[0].eid = 99;
  assert.equal(safety.validateGeoCachePayload(orphan).valid, false);
});
