'use strict';
// projectCodecV2 graduated from a flagged migration (boot-time equivalence
// check against inline legacy serialize/validate/restore functions,
// opt-out flag) to the sole implementation — see MEMORY.md Architecture
// Decisions. This locks the simplified wiring: index.html's
// _ccSerializeProject/_ccValidateProject/_ccRestoreProject are a direct,
// unconditional delegation to window._ccProjectCodec.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const A = {
  ADD_MODEL: 'ADD_MODEL', UPD_RULES: 'UPD_RULES', SET_CLASHES: 'SET_CLASHES',
  LOAD_PROJECT_STATE: 'LOAD_PROJECT_STATE', ADD_ISSUE: 'ADD_ISSUE', ADD_VIEWPOINT: 'ADD_VIEWPOINT',
  ADD_MEASUREMENT: 'ADD_MEASUREMENT', MERGE_CHANGELOG: 'MERGE_CHANGELOG'
};

function loadAdapter(candidate) {
  const start = source.indexOf('var _ccProjectCodec = window._ccProjectCodec;');
  const end = source.indexOf('\n\n', source.indexOf('function _ccRestoreProject(data, dispatch)', start));
  assert.ok(start >= 0 && end > start, 'project codec wiring block not found');
  const window = { _ccProjectCodec: candidate };
  const api = new Function('window', 'A', source.slice(start, end) +
    ';return {_ccSerializeProject,_ccValidateProject,_ccRestoreProject};')(window, A);
  return { window, api };
}

function sample() {
  return { rules: {}, models: [], clashes: [], issues: [], floors: [], viewpoints: [] };
}

test('project codec loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="project-codec.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'project-codec\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('no flag, gate, or opt-out remains for this migration', () => {
  assert.doesNotMatch(source, /isEnabled\('projectCodecV2'\)/);
  assert.doesNotMatch(source, /_ccProjectCodecStatus/);
  assert.doesNotMatch(source, /_ccProjectCodecActive/);
  assert.doesNotMatch(source, /_ccValidateProjectCodec/);
});

test('_ccSerializeProject/_ccValidateProject/_ccRestoreProject delegate directly and unconditionally to the module', () => {
  const restoreCalls = [];
  const { api } = loadAdapter({
    serializeProject: (s, v, t) => ({ _cc: 'from-module', _v: v }),
    validateProject: (data) => { restoreCalls.push('validated'); },
    restoreProject: (data, dispatch, actionTypes) => { dispatch({ t: actionTypes.UPD_RULES }); },
  });
  assert.equal(api._ccSerializeProject(sample(), 'v1', 't1')._cc, 'from-module');
  api._ccValidateProject({});
  assert.deepEqual(restoreCalls, ['validated']);
  const actions = [];
  api._ccRestoreProject({}, (action) => actions.push(action));
  assert.deepEqual(actions, [{ t: 'UPD_RULES' }]);
});

test('a missing module surfaces a real error rather than silently falling back to anything', () => {
  const { api } = loadAdapter(undefined);
  assert.throws(() => api._ccSerializeProject(sample(), 'v', 't'), TypeError);
});
