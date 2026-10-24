'use strict';

// Incident regression locks for PR #676: a transient read failure must never
// become permission to overwrite the shared file, and remote-only records must
// be ingested before the next write. The tests execute the production function
// bodies from addons/shared-project.js with small dependency stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'addons', 'shared-project.js'), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, startMarker + ' not found');
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, endMarker + ' not found');
  return source.slice(start, end);
}

const syncSource = between(
  'var _SHARED_SLICES = [',
  '  // Returns true when remote-only records were dispatched'
);
const replaySource = between(
  'function _replayRemoteChanges(remote, d) {',
  '  function _startSharedSync(d) {'
);

function makeSync(overrides) {
  const deps = Object.assign({
    dir: {},
    state: { sharedProject: { enabled: true } },
    read: () => Promise.resolve(null),
    write: () => Promise.resolve(),
    replay: () => false,
  }, overrides);
  const factory = new Function('deps', `
    var _sharedDirHandle = deps.dir;
    var _sharedLastSynced = deps.lastSynced || null;
    var window = { _ccLatestState: deps.state };
    var A_UPD = 'UPD_SHARED_PROJECT';
    var A_MERGE = 'MERGE_CHANGELOG';
    var _readSharedFile = deps.read;
    var _writeSharedFile = deps.write;
    var _replayRemoteChanges = deps.replay;
    ${syncSource}
    var sync = function(d, opts) { return _syncSharedProject(d, opts); };
    sync.sig = _sharedSig;
    return sync;
  `);
  return factory(deps);
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('shared sync: a transient read failure never writes over the remote file', async () => {
  let writes = 0;
  const actions = [];
  const sync = makeSync({
    read: () => Promise.resolve({ __readError: true }),
    write: () => { writes++; return Promise.resolve(); },
  });
  sync((a) => actions.push(a));
  await flushPromises();

  assert.equal(writes, 0);
  assert.ok(actions.some((a) => a.t === 'UPD_SHARED_PROJECT' && a.u.syncing === false));
});

test('shared sync: ingesting remote-only records skips the same-cycle write', async () => {
  let writes = 0;
  let replays = 0;
  const sync = makeSync({
    read: () => Promise.resolve({ clashes: [{ id: 'remote-c1' }] }),
    replay: () => { replays++; return true; },
    write: () => { writes++; return Promise.resolve(); },
  });
  sync(() => {});
  await flushPromises();

  assert.equal(replays, 1);
  assert.equal(writes, 0, 'the old local arrays must not overwrite records just dispatched from remote');
});

test('shared sync: a genuinely absent file is the only read outcome that initializes it', async () => {
  let writes = 0;
  const sync = makeSync({
    read: () => Promise.resolve(null),
    write: () => { writes++; return Promise.resolve(); },
  });
  sync(() => {});
  await flushPromises();
  await flushPromises();

  assert.equal(writes, 1);
});

test('shared sync: remote-only clashes, issues, and viewpoints are additive', () => {
  const state = {
    clashes: [{ id: 'local-c1' }],
    issues: [{ id: 'local-i1' }],
    viewpoints: [{ id: 'local-v1' }],
    comments: [],
    changelog: [],
  };
  const factory = new Function('window', `
    ${replaySource}
    return _replayRemoteChanges;
  `);
  const replay = factory({ _ccLatestState: state });
  const actions = [];
  const ingested = replay({
    clashes: [{ id: 'remote-c1' }],
    issues: [{ id: 'remote-i1' }],
    viewpoints: [{ id: 'remote-v1' }],
    comments: [{ id: 'remote-comment' }],
    changelog: [],
  }, (a) => actions.push(a));

  assert.equal(ingested, true);
  assert.deepEqual(actions.find((a) => a.t === 'ADD_CLASHES').v.map((c) => c.id), ['remote-c1']);
  assert.equal(actions.find((a) => a.t === 'ADD_ISSUE').v.id, 'remote-i1');
  assert.equal(actions.find((a) => a.t === 'ADD_VIEWPOINT').v.id, 'remote-v1');
  assert.deepEqual(actions.find((a) => a.t === 'MERGE_COMMENTS').v, [{ id: 'remote-comment' }]);
});


// ── an idle tick costs nothing (docs/INTERNALS.md §21.53) ──────────────

function idleSetup(fileMeta) {
  const state = { sharedProject: { enabled: true, fileName: 'p.ccproject' }, rules: {}, clashes: [{ id: 'c1' }], issues: [],
    floors: [], viewpoints: [], measurements: [], changelog: [], comments: [], models: [{ id: 'm', name: 'A', visible: true }] };
  const counts = { reads: 0, writes: 0, getFile: 0, actions: [] };
  const dir = { getFileHandle: () => Promise.resolve({ getFile: () => { counts.getFile++; return Promise.resolve(fileMeta()); } }) };
  return { state, counts, dir };
}

test('shared sync: nothing changed on either side → no read, no write, no dispatch', async () => {
  const meta = { lastModified: 1000, size: 42 };
  const { state, counts, dir } = idleSetup(() => meta);
  const deps = { dir, state, read: () => { counts.reads++; return Promise.resolve({}); }, write: () => { counts.writes++; return Promise.resolve(); } };
  const probe = makeSync(deps);
  deps.lastSynced = { sig: probe.sig(state), lastModified: 1000, size: 42 };
  const sync = makeSync(deps);
  sync((a) => counts.actions.push(a));
  await flushPromises(); await flushPromises();
  assert.equal(counts.getFile, 1, 'only the file metadata is looked at');
  assert.deepEqual([counts.reads, counts.writes, counts.actions.length], [0, 0, 0]);
});

test('shared sync: the remote file changed (lastModified/size) → full read + merge as before', async () => {
  const { state, counts, dir } = idleSetup(() => ({ lastModified: 2000, size: 42 }));
  const deps = { dir, state, read: () => { counts.reads++; return Promise.resolve({ changelog: [] }); }, write: () => { counts.writes++; return Promise.resolve(); } };
  deps.lastSynced = { sig: makeSync(deps).sig(state), lastModified: 1000, size: 42 };
  makeSync(deps)((a) => counts.actions.push(a));
  await flushPromises(); await flushPromises();
  assert.equal(counts.reads, 1);
  assert.equal(counts.writes, 1);
  assert.ok(counts.actions.some((a) => a.u && a.u.syncing === true));
});

test('shared sync: a local slice changed identity → full sync, without even a metadata look', async () => {
  const { state, counts, dir } = idleSetup(() => ({ lastModified: 1000, size: 42 }));
  const deps = { dir, state, read: () => { counts.reads++; return Promise.resolve({ changelog: [] }); }, write: () => { counts.writes++; return Promise.resolve(); } };
  deps.lastSynced = { sig: makeSync(deps).sig(state), lastModified: 1000, size: 42 };
  deps.state = Object.assign({}, state, { clashes: [{ id: 'c1', status: 'resolved' }] });
  makeSync(deps)(() => {});
  await flushPromises(); await flushPromises();
  assert.equal(counts.getFile, 0);
  assert.equal(counts.reads, 1);
  assert.equal(counts.writes, 1);
});

test('shared sync: a model field the file carries changed → full sync; a non-written model field → none', async () => {
  const { state, counts, dir } = idleSetup(() => ({ lastModified: 1000, size: 42 }));
  const deps = { dir, state, read: () => { counts.reads++; return Promise.resolve({ changelog: [] }); }, write: () => { counts.writes++; return Promise.resolve(); } };
  deps.lastSynced = { sig: makeSync(deps).sig(state), lastModified: 1000, size: 42 };
  deps.state = Object.assign({}, state, { models: [Object.assign({}, state.models[0], { hiddenStoreys: ['L1'] })] });
  makeSync(deps)(() => {});
  await flushPromises(); await flushPromises();
  assert.deepEqual([counts.reads, counts.writes], [0, 0]);
  deps.state = Object.assign({}, state, { models: [Object.assign({}, state.models[0], { visible: false })] });
  makeSync(deps)(() => {});
  await flushPromises(); await flushPromises();
  assert.deepEqual([counts.reads, counts.writes], [1, 1]);
});

test('shared sync: Sync Now (force) always syncs', async () => {
  const { state, counts, dir } = idleSetup(() => ({ lastModified: 1000, size: 42 }));
  const deps = { dir, state, read: () => { counts.reads++; return Promise.resolve({ changelog: [] }); }, write: () => { counts.writes++; return Promise.resolve(); } };
  deps.lastSynced = { sig: makeSync(deps).sig(state), lastModified: 1000, size: 42 };
  makeSync(deps)(() => {}, { force: true });
  await flushPromises(); await flushPromises();
  assert.deepEqual([counts.reads, counts.writes], [1, 1]);
});

test('MERGE_COMMENTS with nothing new keeps the state object (an idle sync is not a change)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('case A.MERGE_COMMENTS: {');
  const body = html.slice(html.indexOf('{', start) + 1, html.indexOf('\n      }', start));
  const reduce = new Function('s', 'a', body);
  const c1 = { id: 'x', ts: 5 }, c2 = { id: 'y', ts: 6 };
  const s = { comments: [c1, c2] };
  assert.strictEqual(reduce(s, { v: [{ id: 'x', ts: 5 }] }), s, 'same or older remote copy: unchanged');
  const s2 = reduce(s, { v: [{ id: 'x', ts: 9 }] });
  assert.notStrictEqual(s2, s);
  assert.equal(s2.comments[0].ts, 9);
  assert.equal(reduce(s, { v: [{ id: 'z', ts: 1 }] }).comments.length, 3);
});
