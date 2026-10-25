'use strict';
// addons/training-data.js keeps the parsed clash training store in memory
// (write-through; docs/INTERNALS.md §21.53): the count read on every clash /
// issue edit and each verdict save no longer JSON.parse the whole store,
// localStorage holds byte-for-byte what it held before, and a change made
// outside the addon (another tab, the core clearing / pruning the key) is
// picked up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'addons', 'training-data.js'), 'utf8');
const KEY = 'cc_clash_training_data';

function load(seed) {
  const data = new Map(Object.entries(seed || {}));
  const ls = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
  const listeners = {};
  let parses = 0, bigParses = 0;
  const J = {
    parse: (s) => { parses++; if (typeof s === 'string' && s.length > 1000) bigParses++; return JSON.parse(s); },
    stringify: JSON.stringify,
  };
  const win = {
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent: (e) => { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  };
  const ctx = { window: win, localStorage: ls, JSON: J, Event: function (t) { this.type = t; }, Object, Date, Array, String, Math };
  vm.runInNewContext(SRC, ctx);
  return { w: win, data, fire: (t, e) => (listeners[t] || []).forEach((f) => f(Object.assign({ type: t }, e))), get bigParses() { return bigParses; } };
}

function seedStore(n) {
  const st = {};
  for (let i = 0; i < n; i++) st['s' + i] = { fv: { type_pair: 'IfcWall|IfcPipeSegment', pen_depth_mm: i }, label: 1, label_source: i % 2 ? 'verdict' : 'issue_created', synthetic: false, ts: 1000 + i };
  return JSON.stringify(st);
}

// The old implementation, for content equality.
function oldSave(raw, id, fv, label, src, now) {
  const store = JSON.parse(raw || '{}');
  store[id] = { fv, label, label_source: src, synthetic: false, ts: now };
  return JSON.stringify(store);
}

test('the count is parsed once, then served from memory across edits', () => {
  const h = load({ [KEY]: seedStore(200) });
  assert.equal(h.w._ccGetClashTrainCount(), 100);
  for (let i = 0; i < 20; i++) h.w._ccGetClashTrainCount();
  assert.equal(h.bigParses, 1);
});

test('a verdict save does not re-parse the store, and writes exactly what the old code wrote', () => {
  const raw = seedStore(300);
  const h = load({ [KEY]: raw });
  h.w._ccGetClashTrainCount();
  const realNow = Date.now; Date.now = () => 424242;
  try {
    h.w._ccSaveClashTrainRecord('new', { type_pair: 'a|b', clearance_mm: undefined, overlap_vol_m3: NaN }, 1, 'verdict', false);
  } finally { Date.now = realNow; }
  assert.equal(h.bigParses, 1, 'save parsed the whole store again');
  assert.equal(h.data.get(KEY), oldSave(raw, 'new', { type_pair: 'a|b', clearance_mm: undefined, overlap_vol_m3: NaN }, 1, 'verdict', 424242));
  assert.equal(h.w._ccGetClashTrainCount(), 151);
  // the memory copy equals a fresh parse of what is stored
  assert.deepEqual(JSON.parse(JSON.stringify(h.w._ccGetClashTrainStore())), JSON.parse(h.data.get(KEY)));
  assert.deepEqual(h.w._ccGetClashTrainStore().new, JSON.parse(h.data.get(KEY)).new);
});

test('another tab writing the key, the core clearing it, or a failed write drop the memory copy', () => {
  const h = load({ [KEY]: seedStore(10) });
  assert.equal(h.w._ccGetClashTrainCount(), 5);
  h.data.set(KEY, seedStore(4));
  h.fire('storage', { key: KEY });
  assert.equal(h.w._ccGetClashTrainCount(), 2);
  h.data.delete(KEY);
  h.fire('cc-ls-removed', { detail: { keys: [KEY, 'cc_trainingFeedback'] } });
  assert.equal(h.w._ccGetClashTrainCount(), 0);
  h.fire('cc-ls-removed', { detail: { keys: ['cc_other'] } });
  h.w._ccLsSet = () => false; // quota: not stored
  h.w._ccSaveClashTrainRecord('x', {}, 1, 'verdict', false);
  assert.equal(h.data.has(KEY), false);
  assert.equal(h.w._ccGetClashTrainCount(), 0, 'memory ran ahead of localStorage after a failed write');
});

test('clearing through the addon empties memory and storage', () => {
  const h = load({ [KEY]: seedStore(10) });
  h.w._ccGetClashTrainCount();
  h.w._ccClearClashTrainStore();
  assert.equal(h.w._ccGetClashTrainCount(), 0);
  assert.equal(h.data.has(KEY), false);
});

test('the core announces its own removals of the training keys', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const clear = html.slice(html.indexOf('case A.CLEAR_TRAINING_DATA:'), html.indexOf('case A.CLEAR_TRAINING_DATA:') + 400);
  assert.match(clear, /_ccLsRemoved\(\['cc_clash_training_data','cc_trainingFeedback'\]\)/);
  const lsSet = html.slice(html.indexOf('function _ccLsSet(key, val)'), html.indexOf('window._ccLsSet = _ccLsSet;'));
  assert.match(lsSet, /_ccLsRemoved\(plan\.keys\)/);
  assert.match(html, /new CustomEvent\('cc-ls-removed', \{detail:\{keys:keys\.slice\(\)\}\}\)/);
});
