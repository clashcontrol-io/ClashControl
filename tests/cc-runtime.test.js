const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../cc-runtime.js');

test('service registry is explicit, versioned, and rejects accidental replacement', () => {
  const registry = runtime.createRegistry();
  const service = Object.freeze({run() { return 42; }});
  assert.equal(registry.register('answer', service, {version:2}), service);
  assert.equal(registry.require('answer').run(), 42);
  assert.equal(registry.version('answer'), '2');
  assert.deepEqual(registry.list(), ['answer']);
  assert.throws(() => registry.register('answer', {}), /already registered/);
  registry.register('answer', {run() { return 7; }}, {replace:true, version:3});
  assert.equal(registry.require('answer').run(), 7);
});

test('script loader deduplicates concurrent feature requests', async () => {
  const appended = [];
  const document = {
    head:{appendChild(script) { appended.push(script); queueMicrotask(() => script.onload()); }},
    createElement() { return {dataset:{}}; }
  };
  const loader = runtime.createScriptLoader({bridge:{src:'addons/bridge.js'}}, {document});
  const [a, b] = await Promise.all([loader.load('bridge'), loader.load('bridge')]);
  assert.equal(a, b);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].dataset.ccFeature, 'bridge');
  assert.equal(loader.status('bridge'), 'loaded');
});

test('script loader exposes a retryable failed state', async () => {
  let fail = true;
  const document = {
    head:{appendChild(script) { queueMicrotask(() => fail ? script.onerror() : script.onload()); }},
    createElement() { return {dataset:{}}; }
  };
  const loader = runtime.createScriptLoader({optional:'optional.js'}, {document});
  await assert.rejects(loader.load('optional'), /Failed to load feature/);
  assert.equal(loader.status('optional'), 'failed');
  fail = false;
  await loader.load('optional');
  assert.equal(loader.status('optional'), 'loaded');
});

test('load coordinator waits for both the file chain and lazy properties', () => {
  let idle = 0;
  const coordinator = runtime.createLoadCoordinator({onIdle() { idle++; }});
  const batch = coordinator.begin({files:1});
  const release = batch.hold('ifc-properties');
  batch.markChainDone();
  assert.equal(batch.snapshot().state, 'active');
  assert.equal(batch.snapshot().pending, 1);
  assert.equal(idle, 0);
  assert.equal(release(), true);
  assert.equal(release(), false);
  assert.equal(batch.snapshot().state, 'complete');
  assert.equal(coordinator.activeCount(), 0);
  assert.equal(idle, 1);
});

test('load coordinator handles properties-before-geometry-chain and terminal paths', () => {
  const coordinator = runtime.createLoadCoordinator();
  const early = coordinator.begin();
  const release = early.hold('props');
  release();
  assert.equal(early.snapshot().state, 'active');
  early.markChainDone();
  assert.equal(early.snapshot().state, 'complete');

  const failed = coordinator.begin();
  const lateRelease = failed.hold('props');
  assert.equal(failed.fail(), true);
  assert.equal(failed.fail(), false);
  assert.equal(lateRelease(), false);
  assert.equal(failed.snapshot().state, 'failed');

  const cancelled = coordinator.begin();
  assert.equal(cancelled.cancel(), true);
  assert.equal(cancelled.snapshot().state, 'cancelled');
});
