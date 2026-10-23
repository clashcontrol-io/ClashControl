'use strict';
// addons/accessibility.js has no built-in numbers: thresholds come from the
// active country pack, from values the user entered (when no pack applies),
// or per call; a check without a threshold never runs. Space-role words come
// from the active pack's naming.spaceRoles (English generic defaults otherwise).
const { test } = require('node:test');
const assert = require('node:assert');
const { countryWindow, loadAddon, readPack } = require('./_country-pack.js');

function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function engine(opts) {
  const ls = storage();
  global.localStorage = ls;
  const w = loadAddon('accessibility.js', countryWindow(opts));
  return w;
}
const door = (id, width, extra) => ({ expressId: id, props: Object.assign({ ifcType: 'IfcDoor', name: 'D' + id, quantities: { Width: width } }, extra || {}) });

test('no country pack, nothing entered: no checks run, no thresholds invented', () => {
  const w = engine({ regions: [], active: null });
  const r = w._ccRunAccessibilityChecks([door(1, 0.7), door(2, 1.0)]);
  assert.deepStrictEqual(r.thresholds, {});
  assert.deepStrictEqual(r.groups, {});
  assert.equal(r.evaluated, 0);
  assert.deepStrictEqual(w._ccAccessibilityThresholdKeys, ['doorClearWidth', 'corridorWidth', 'turningDiameter', 'thresholdHeight', 'rampSlope']);
  assert.equal(w._ccAccessibilityDefaults, undefined);
});

test('nl pack active: the pack thresholds apply', () => {
  const w = engine({ regions: ['nl'], active: 'nl' });
  const r = w._ccRunAccessibilityChecks([door(1, 0.7), door(2, 1.0)]);
  assert.deepStrictEqual(r.thresholds, readPack('nl').engines.accessibility);
  assert.equal(r.groups.door_clear_width.fail, 1);
  assert.equal(Object.keys(r.groups).length, 5);
});

test('user-entered thresholds apply only when no pack carries them, and only the entered checks run', () => {
  const w = engine({ regions: [], active: null });
  assert.deepStrictEqual(w._ccSetAccessibilityCustomThresholds({ doorClearWidth: '0.9', rampSlope: '', corridorWidth: -1 }), { doorClearWidth: 0.9 });
  const r = w._ccRunAccessibilityChecks([door(1, 0.85), door(2, 1.0, { quantities: { Width: 1.0, ThresholdHeight: 0.05 } })]);
  assert.deepStrictEqual(Object.keys(r.groups), ['door_clear_width']);
  assert.equal(r.groups.door_clear_width.fail, 1);
  assert.ok(!r.items.some((it) => it.check === 'threshold_height'), 'no threshold entered -> threshold height not measured');
  // An active pack wins over stale custom values.
  const w2 = loadAddon('accessibility.js', countryWindow({ regions: ['nl'], active: 'nl' }));
  assert.equal(w2._ccRunAccessibilityChecks([door(1, 0.86)]).thresholds.doorClearWidth, 0.85);
  w._ccSetAccessibilityCustomThresholds({});
  assert.deepStrictEqual(w._ccGetAccessibilityCustomThresholds(), {});
});

test('per-call thresholds work without any pack', () => {
  const w = engine({ regions: [], active: null });
  const r = w._ccRunAccessibilityChecks([door(1, 0.8)], { thresholds: { doorClearWidth: 0.85 } });
  assert.equal(r.groups.door_clear_width.fail, 1);
});

test('space roles: English defaults without a pack, the pack words when active', () => {
  // A minimal THREE so corridor/turning (footprint-based) checks can measure.
  const THREE = {
    Box3: function () { this.min = null; },
    Vector3: function () { return { x: 0, y: 0, z: 0 }; },
  };
  THREE.Box3.prototype.setFromObject = function (m) { this.min = { x: 0, y: 0, z: 0, clone() { return this; } }; this.max = { x: m._w, y: 2.6, z: 9, clone() { return this; } }; return this; };
  THREE.Box3.prototype.isEmpty = function () { return false; };
  THREE.Box3.prototype.copy = function (b) { this.min = b.min; this.max = b.max; return this; };
  THREE.Box3.prototype.union = function () { return this; };
  THREE.Box3.prototype.getSize = function () { return { x: this.max.x, y: this.max.y, z: this.max.z }; };
  const mk = (id, name) => ({ expressId: id, props: { ifcType: 'IfcSpace', name }, meshes: [{ geometry: {}, _w: 1.0, updateWorldMatrix() {} }] });
  const els = [mk(1, 'Hallway 2'), mk(2, 'Gang 3'), mk(3, 'Vluchtweg')];
  const th = { thresholds: { corridorWidth: 1.2 } };
  const en = loadAddon('accessibility.js', countryWindow({ regions: [], active: null, window: { THREE } }));
  assert.deepStrictEqual(en._ccRunAccessibilityChecks(els, th).items.map((i) => i.name), ['Hallway 2']);
  const nl = loadAddon('accessibility.js', countryWindow({ regions: ['nl'], active: 'nl', window: { THREE } }));
  assert.deepStrictEqual(nl._ccRunAccessibilityChecks(els, th).items.map((i) => i.name), ['Gang 3', 'Vluchtweg']);
});
