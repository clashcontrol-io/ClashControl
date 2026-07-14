const test = require('node:test');
const assert = require('node:assert/strict');
const clipping = require('../section-clipping');

function graph(children) {
  return {
    traverse(fn) {
      for (const child of children) fn(child);
    }
  };
}

function mesh(id, options = {}) {
  return {
    uuid: `mesh-${id}`,
    isMesh: true,
    isInstancedMesh: !!options.instanced,
    material: options.material || {},
    userData: {
      expressId: options.noExpress ? null : id,
      _isCCBatch: !!options.batch,
      batchExprIds: options.batch ? [id, id + 1] : undefined,
      _styleMats: options.styles || undefined,
    }
  };
}

test('legacy section traversal preserves active and cached-style semantics', () => {
  const active = {}, shaded = {}, rendered = {};
  const model = mesh(1, { material: active, styles: { shaded, rendered: [rendered] } });
  const helper = mesh(2, { noExpress: true });
  const planes = [{}];
  clipping.applyLegacy(graph([model, helper]), planes, 'section');
  assert.equal(active.clippingPlanes, planes);
  assert.equal(shaded.clippingPlanes, planes);
  assert.equal(rendered.clippingPlanes, planes);
  assert.equal(helper.material.clippingPlanes, undefined);
});

test('candidate covers BatchedMesh active and cached style materials', () => {
  const active = {}, style = {};
  const batch = mesh(10, { batch: true, noExpress: true, material: active, styles: { rendered: style } });
  const planes = [{ id: 'cut' }];
  const stats = clipping.applyCandidate(graph([batch]), planes);
  assert.equal(stats.batches, 1);
  assert.equal(stats.batchItems, 2);
  assert.equal(active.clippingPlanes, planes);
  assert.equal(style.clippingPlanes, planes);
  assert.deepEqual(clipping.verify(graph([batch]), planes).missing, []);
});

test('candidate and legacy produce equivalent material plane assignments', () => {
  const planes = [{ id: 'cut' }];
  const legacyMats = [{}, {}, {}];
  const candidateMats = [{}, {}, {}];
  const legacyRoot = graph([mesh(1, { material: legacyMats[0], styles: { a:legacyMats[1], b:legacyMats[2] } })]);
  const candidateRoot = graph([mesh(1, { material: candidateMats[0], styles: { a:candidateMats[1], b:candidateMats[2] } })]);
  clipping.applyLegacy(legacyRoot, planes, 'section');
  clipping.applyCandidate(candidateRoot, planes);
  assert.deepEqual(legacyMats.map((m) => m.clippingPlanes === planes), [true, true, true]);
  assert.deepEqual(candidateMats.map((m) => m.clippingPlanes === planes), [true, true, true]);
});

test('guarded candidate falls back to legacy on traversal failure', () => {
  const material = {};
  const scene = graph([mesh(1, { material })]);
  const brokenRoot = { traverse() { throw new Error('batch traversal failed'); } };
  const events = [];
  const planes = [{}];
  const result = clipping.applyGuarded({
    enabled: true, scene, modelRoot: brokenRoot, planes,
    record(event) { events.push(event); }
  });
  assert.equal(result.path, 'fallback');
  assert.equal(material.clippingPlanes, planes);
  assert.equal(events[0].outcome, 'fallback');
});

test('flag-off guarded path never executes candidate traversal', () => {
  const material = {};
  const scene = graph([mesh(1, { material })]);
  const candidateRoot = { traverse() { throw new Error('must not run'); } };
  const planes = [{}];
  const result = clipping.applyGuarded({ enabled:false, scene, modelRoot:candidateRoot, planes });
  assert.equal(result.path, 'legacy');
  assert.equal(material.clippingPlanes, planes);
});
