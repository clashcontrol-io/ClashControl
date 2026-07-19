'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../storage-core');

test('storage core is a frozen contract', () => {
  assert.equal(core.contractVersion, 1);
  assert.equal(Object.isFrozen(core), true);
  assert.equal(typeof core.estimateRecordBytes, 'function');
  assert.equal(typeof core.scanLocalStorage, 'function');
  assert.equal(typeof core.buildStorageReport, 'function');
  assert.equal(typeof core.classifyKey, 'function');
});

test('estimateRecordBytes: buffers dominate, strings approximate at-rest size', () => {
  const buf = new ArrayBuffer(10000);
  assert.equal(core.estimateRecordBytes(buf), 10000);
  assert.equal(core.estimateRecordBytes(new Float32Array(100)), 400);
  const s = 'x'.repeat(500);
  const est = core.estimateRecordBytes(s);
  assert.ok(est >= 500 && est <= 1100, 'string estimate near its length, got ' + est);
  const rec = { id: 'file-1', buffer: buf, name: 'model.ifc' };
  const recEst = core.estimateRecordBytes(rec);
  assert.ok(recEst >= 10000 && recEst < 10200, 'record dominated by buffer, got ' + recEst);
});

test('estimateRecordBytes survives cycles and deep nesting', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.ok(core.estimateRecordBytes(a) > 0);
  let deep = {};
  let cur = deep;
  for (let i = 0; i < 50; i++) { cur.next = {}; cur = cur.next; }
  assert.ok(core.estimateRecordBytes(deep) > 0);
});

test('classifyKey: specific families beat the cc_ prefs catch-all', () => {
  assert.equal(core.classifyKey('cc_clash_training_data').family, 'training');
  assert.equal(core.classifyKey('cc_chat_msgs_default').family, 'chat');
  assert.equal(core.classifyKey('cc_detection_feedback:MEP-abc').family, 'detection-feedback');
  assert.equal(core.classifyKey('cc_typePairMemo:m1|m2').family, 'type-pair-memo');
  assert.equal(core.classifyKey('cc_align_scan.las').family, 'align');
  assert.equal(core.classifyKey('cc_denied_clashes').family, 'clash-decisions');
  // Unlisted cc_* keys fall through to the prefs catch-all (they are what
  // _ccPersistUI/_ccLoadPref write), non-cc keys are unregistered.
  assert.equal(core.classifyKey('cc_showGrid').family, 'ui-prefs');
  assert.equal(core.classifyKey('someOtherApp_key'), null);
});

test('retention classes match the eviction contract', () => {
  // derived = freely GC-able; source = never auto-deleted; decay = prunable tail.
  assert.equal(core.classifyKey('cc_typePairMemo:x').retention, 'derived');
  assert.equal(core.classifyKey('cc_element_hashes').retention, 'derived');
  assert.equal(core.classifyKey('cc_projects').retention, 'source');
  assert.equal(core.classifyKey('cc_denied_clashes').retention, 'source');
  assert.equal(core.classifyKey('cc_clash_training_data').retention, 'decay');
  assert.equal(core.classifyKey('cc_chat_msgs_p1').retention, 'decay');
  const geo = core.IDB_REGISTRY.find(r => r.store === 'geoCache');
  const ifc = core.IDB_REGISTRY.find(r => r.store === 'ifcFiles');
  assert.equal(geo.retention, 'derived');
  assert.equal(ifc.retention, 'source');
});

test('scanLocalStorage aggregates by family and flags unregistered keys', () => {
  const scan = core.scanLocalStorage([
    { key: 'cc_clash_training_data', value: 'x'.repeat(1000) },
    { key: 'cc_nl_training_data', value: 'y'.repeat(500) },
    { key: 'cc_chat_msgs_default', value: 'z'.repeat(200) },
    { key: 'mystery_key', value: 'q'.repeat(50) }
  ]);
  assert.equal(scan.items.length, 4);
  assert.deepEqual(scan.unregistered, ['mystery_key']);
  const training = scan.families.find(f => f.family === 'training');
  assert.equal(training.count, 2);
  assert.ok(training.bytes > 1500);
  assert.ok(scan.totalBytes > 1750);
  // Sorted heaviest first.
  assert.equal(scan.items[0].key, 'cc_clash_training_data');
});

test('buildStorageReport groups IDB usage per project, geo cache via sourceId', () => {
  const report = core.buildStorageReport({
    estimate: { quota: 1000000, usage: 400000 },
    persisted: true,
    ifcFiles: [
      { id: 'f1', name: 'a.ifc', projectId: 'p1', savedAt: 100, bytes: 5000 },
      { id: 'f2', name: 'b.ifc', projectId: 'p1', savedAt: 200, bytes: 3000 },
      { id: 'f3', name: 'c.ifc', projectId: 'p2', savedAt: 300, bytes: 1000 }
    ],
    geoCache: [
      { id: 'f1', savedAt: 100, bytes: 800 },            // legacy key
      { id: 'v8:f3', sourceId: 'f3', savedAt: 300, bytes: 200 }
    ],
    projects: [{ id: 'p1', bytes: 600 }],
    localEntries: [{ key: 'cc_projects', value: 'x'.repeat(100) }]
  });
  assert.equal(report.quota, 1000000);
  assert.equal(report.persisted, true);
  assert.equal(report.perProject.length, 2);
  const p1 = report.perProject[0];
  assert.equal(p1.projectId, 'p1');
  assert.equal(p1.fileCount, 2);
  assert.equal(p1.ifcBytes, 8000);
  assert.equal(p1.geoBytes, 800);
  assert.equal(p1.sessionBytes, 600);
  assert.equal(p1.totalBytes, 9400);
  assert.equal(p1.lastSavedAt, 200);
  const p2 = report.perProject[1];
  assert.equal(p2.geoBytes, 200, 'v8: geo row attributed via sourceId');
  assert.equal(report.idb.totalBytes, 10600);
  assert.equal(report.localStorage.families[0].family, 'projects-index');
});

test('buildStorageReport tolerates empty/missing input', () => {
  const report = core.buildStorageReport({});
  assert.equal(report.quota, null);
  assert.equal(report.persisted, null);
  assert.deepEqual(report.perProject, []);
  assert.equal(report.idb.totalBytes, 0);
  assert.equal(report.localStorage.totalBytes, 0);
});

test('computeBudget: tighter of user pref and 80% of quota', () => {
  assert.equal(core.computeBudget(null, 1000), 800);
  assert.equal(core.computeBudget(500, 1000), 500);
  assert.equal(core.computeBudget(2000, 1000), 800);
  assert.equal(core.computeBudget(300, null), 300);
  assert.equal(core.computeBudget(null, null), null);
});

test('planEviction: under budget is a no-op', () => {
  const plan = core.planEviction({
    ifcFiles: [{ id: 'f1', projectId: 'p1', savedAt: 1, bytes: 100 }],
    geoCache: [{ id: 'f1', savedAt: 1, bytes: 50 }],
    projects: []
  }, 1000, { activeProject: 'p1' });
  assert.equal(plan.overBy, 0);
  assert.deepEqual(plan.auto, []);
  assert.deepEqual(plan.proposals, []);
  assert.equal(plan.totalBytes, 150);
});

test('planEviction: derived tier first — cold projects before active, oldest first', () => {
  const plan = core.planEviction({
    ifcFiles: [
      { id: 'fa', projectId: 'active', savedAt: 500, bytes: 100 },
      { id: 'fc1', projectId: 'cold', savedAt: 100, bytes: 100 },
      { id: 'fc2', projectId: 'cold', savedAt: 200, bytes: 100 }
    ],
    geoCache: [
      { id: 'fa', savedAt: 500, bytes: 300 },          // active project — evicted LAST
      { id: 'fc1', savedAt: 100, bytes: 300 },          // oldest cold — first
      { id: 'v8:fc2', sourceId: 'fc2', savedAt: 200, bytes: 300 }
    ],
    projects: []
  }, 900, { activeProject: 'active' });
  // total 1200, budget 900 → overBy 300: one geo group (300 B) suffices.
  assert.equal(plan.overBy, 300);
  assert.equal(plan.auto.length, 1);
  assert.equal(plan.auto[0].sourceId, 'fc1');
  assert.deepEqual(plan.proposals, []);
});

test('planEviction: legacy + v8 rows for one file evict as one group', () => {
  const plan = core.planEviction({
    ifcFiles: [{ id: 'f1', projectId: 'cold', savedAt: 100, bytes: 10 }],
    geoCache: [
      { id: 'f1', savedAt: 100, bytes: 200 },
      { id: 'v8:f1', sourceId: 'f1', savedAt: 150, bytes: 300 }
    ],
    projects: []
  }, 200, { activeProject: 'active' });
  assert.equal(plan.auto.length, 1);
  assert.equal(plan.auto[0].sourceId, 'f1');
  assert.equal(plan.auto[0].bytes, 500);
});

test('planEviction: ifcFiles are never auto — only proposals, never the active project', () => {
  const plan = core.planEviction({
    ifcFiles: [
      { id: 'fa', projectId: 'active', savedAt: 900, bytes: 4000 },
      { id: 'f1', projectId: 'old', savedAt: 100, bytes: 3000 },
      { id: 'f2', projectId: 'newer', savedAt: 500, bytes: 2000 }
    ],
    geoCache: [{ id: 'f1', savedAt: 100, bytes: 100 }],
    projects: []
  }, 1000, { activeProject: 'active' });
  // overBy 8100: geo (100) can't cover it → proposals for cold projects,
  // least-recently-saved first, active never listed.
  assert.equal(plan.auto.length, 1);
  assert.ok(plan.proposals.length >= 1);
  assert.equal(plan.proposals[0].projectId, 'old');
  assert.equal(plan.proposals[0].bytes, 3000);
  assert.ok(!plan.proposals.some(p => p.projectId === 'active'));
  assert.ok(!plan.auto.some(a => a.action !== 'delete-geocache'));
});

test('formatBytes renders human-readable sizes', () => {
  assert.equal(core.formatBytes(512), '512 B');
  assert.equal(core.formatBytes(2048), '2.0 KB');
  assert.equal(core.formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(core.formatBytes(null), '—');
});
