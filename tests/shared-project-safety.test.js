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
  'function _syncSharedProject(d) {',
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
    var window = { _ccLatestState: deps.state };
    var A_UPD = 'UPD_SHARED_PROJECT';
    var A_MERGE = 'MERGE_CHANGELOG';
    var _readSharedFile = deps.read;
    var _writeSharedFile = deps.write;
    var _replayRemoteChanges = deps.replay;
    ${syncSource}
    return _syncSharedProject;
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

