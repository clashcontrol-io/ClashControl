'use strict';

// Locks the Smart Bridge incident fixes without standing up a WebSocket server:
// stale run scope must be passed directly to detection, Loam feedback may only
// protect real pairs, and an agent can never mass-resolve clashes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'addons', 'smart-bridge.js'), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, startMarker + ' not found');
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, endMarker + ' not found');
  return source.slice(start, end);
}

const runDetectionSource = between(
  'handlers.run_detection = function(p) {',
  '  // Rule-based / cross-discipline detection'
);
const clashUpdateSource = between(
  'handlers.update_clash = function(p) {',
  '  handlers.set_view = function(p) {'
);
const feedbackSource = between(
  'handlers.ingest_detection_feedback = function(p) {',
  '  handlers.set_detection_rules = function(p) {'
);

function makeRunDetection(state, windowOverrides) {
  const actions = [];
  const fakeWindow = Object.assign({}, windowOverrides);
  const fn = new Function('state', 'actions', 'window', `
    var handlers = {};
    var _getState = function(){ return state; };
    var _dispatch = function(a){ actions.push(a); };
    ${runDetectionSource}
    return handlers.run_detection;
  `)(state, actions, fakeWindow);
  return { fn, actions, window: fakeWindow };
}

test('run_detection passes requested scope directly instead of reading stale dispatched state', () => {
  let resetCount = 0;
  let runArgs = null;
  const h = makeRunDetection({
    detecting: false,
    models: [
      { id: 'a', name: 'Architecture', discipline: 'architectural' },
      { id: 's', name: 'Structure', discipline: 'structural' },
    ],
  }, {
    _ccResetTypePairMemo() { resetCount++; },
    _ccRunDetection(updates) { runArgs = updates; return true; },
  });

  const result = h.fn({ modelA: 'Architecture', modelB: 'Structure', maxGap: 25, hard: true });
  assert.deepEqual(runArgs, { modelA: 'Architecture', modelB: 'Structure', maxGap: 25, hard: true });
  assert.deepEqual(h.actions, [{ t: 'UPD_RULES', u: runArgs }]);
  assert.equal(resetCount, 1);
  assert.match(result, /Detection started/);
});

test('run_detection rejects an unmatched scope before it can silently return zero clashes', () => {
  let runs = 0;
  const h = makeRunDetection({ detecting: false, models: [{ id: 'a', name: 'Architecture' }] }, {
    _ccRunDetection() { runs++; return true; },
  });
  const result = h.fn({ modelA: 'Does not exist' });
  assert.match(result, /matched no loaded model/);
  assert.equal(runs, 0);
  assert.equal(h.actions.length, 0);
});

function makeClashHandlers(state, windowOverrides) {
  const actions = [];
  const handlers = new Function('state', 'actions', 'window', `
    var handlers = {};
    var _getState = function(){ return state; };
    var _dispatch = function(a){ actions.push(a); };
    ${clashUpdateSource}
    return handlers;
  `)(state, actions, Object.assign({}, windowOverrides));
  return { handlers, actions };
}

test('agent update_clash remaps resolved to reversible expected', () => {
  const h = makeClashHandlers({ clashes: [{ id: 'c1', status: 'open' }] });
  const result = h.handlers.update_clash({ clashIndex: 0, status: 'resolved' });
  assert.deepEqual(h.actions, [{ t: 'UPD_CLASH', id: 'c1', u: { status: 'expected' } }]);
  assert.match(result, /routed to 'expected'/);
});

test('agent batch resolution is refused before the NL command path', () => {
  let nlCalls = 0;
  const h = makeClashHandlers({ clashes: [] }, { _ccProcessNLCommand() { nlCalls++; } });
  const result = h.handlers.batch_update_clashes({ action: 'resolve', filter: 'all open' });
  assert.match(result, /^Refused:/);
  assert.equal(nlCalls, 0);
  assert.equal(h.actions.length, 0);
});

function memoryStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] || null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

test('Loam feedback protects only evidenced-real type pairs and mutates no clash status', () => {
  const storage = memoryStorage();
  const actions = [];
  const fakeWindow = {};
  const handler = new Function('localStorage', 'window', 'actions', `
    var handlers = {};
    var _FEEDBACK_REALRATE_TH = 0.34;
    var _getState = function(){ return { activeProject:'p1' }; };
    var _projectKey = function(){ return 'p1'; };
    ${feedbackSource}
    return handlers.ingest_detection_feedback;
  `)(storage, fakeWindow, actions);
  const result = handler({ feedback: { byPair: [
    { key: 'IfcSlab × IfcWall', realRate: 0.8 },
    { key: 'IfcDoor × IfcWall', realRate: 0.1 },
  ] } });

  assert.deepEqual(result.protectedPairs, ['IfcSlab × IfcWall']);
  assert.equal(fakeWindow._ccDetectionFeedback.projectKey, 'p1');
  assert.equal(actions.length, 0, 'feedback stores evidence; it never resolves or updates clashes');
});

