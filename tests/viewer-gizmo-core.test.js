'use strict';
// viewer-gizmo-core.js: screen-constant handle sizing (perspective + ortho),
// the cached token reader, state colours and the section-outline math
// (model box ∩ plane) shared by the section plane / box gizmos in index.html.
const { test } = require('node:test');
const assert = require('node:assert');
const THREE = require('three');
const G = require('../viewer-gizmo-core.js');

const VP_H = 800;

// On-screen height in px of a segment of world length L centred at p.
function screenPx(cam, p, L) {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const a = p.clone().addScaledVector(up, -L / 2).project(cam);
  const b = p.clone().addScaledVector(up, L / 2).project(cam);
  return Math.abs(b.y - a.y) / 2 * VP_H;
}

test('pxScale keeps a 12 px handle at 12 px across distances and screen positions (perspective)', () => {
  const cam = new THREE.PerspectiveCamera(55, 1.6, 0.01, 1e5);
  for (const dist of [0.5, 5, 50, 500, 5000]) {
    cam.position.set(0, 0, dist); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    for (const p of [new THREE.Vector3(0, 0, 0), new THREE.Vector3(dist * 0.3, -dist * 0.2, 0)]) {
      const L = G.pxScale(cam, p, VP_H, 12);
      assert.ok(Math.abs(screenPx(cam, p, L) - 12) < 0.05, `dist ${dist}: ${screenPx(cam, p, L)} px`);
    }
  }
});

test('pxScale is exact for orthographic cameras at any zoom', () => {
  const cam = new THREE.OrthographicCamera(-20, 20, 12, -12, -1e4, 1e4);
  cam.position.set(10, 30, 10); cam.lookAt(0, 0, 0);
  for (const zoom of [0.1, 1, 7.5]) {
    cam.zoom = zoom; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const p = new THREE.Vector3(3, 1, -2), L = G.pxScale(cam, p, VP_H, 12);
    assert.ok(Math.abs(screenPx(cam, p, L) - 12) < 1e-6, `zoom ${zoom}`);
  }
});

test('token reader caches until invalidated; create().color reads through it', () => {
  let theme = 'light', calls = 0;
  const vals = { light: { '--accent': ' #4d9e75 ' }, dark: { '--accent': '#1a6b4a' } };
  const read = G.makeTokenReader((n) => { calls++; return vals[theme][n]; });
  assert.strictEqual(read('--accent'), '#4d9e75');
  theme = 'dark';
  assert.strictEqual(read('--accent'), '#4d9e75', 'cached');
  assert.strictEqual(calls, 1);
  read.invalidate();
  assert.strictEqual(read('--accent'), '#1a6b4a');
  assert.strictEqual(read('--missing'), '', 'missing token reads empty (paint keeps the current colour)');
});

test('setState paints idle / hover / active from tokens and repaints on theme change', () => {
  let theme = 'light';
  const tok = {
    light: { '--bg-secondary': '#ffffff', '--text-muted': '#6b7280', '--accent': '#4d9e75', '--accent-bg': '#ecf7f2' },
    dark: { '--bg-secondary': '#1f1f1f', '--text-muted': '#a0a0a0', '--accent': '#1a6b4a', '--accent-bg': '#0d2b1e' },
  };
  const read = G.makeTokenReader((n) => tok[theme][n]);
  const gz = G.create({ THREE, read });
  const scene = new THREE.Scene(), tab = G.buildTab(THREE, 12);
  scene.add(tab); gz.track(tab);
  const stroke = tab.children[0];
  assert.strictEqual('#' + tab.material.color.getHexString(), '#ffffff');
  assert.strictEqual('#' + stroke.material.color.getHexString(), '#6b7280');
  gz.setState(tab, 'hover');
  assert.strictEqual('#' + stroke.material.color.getHexString(), '#4d9e75');
  gz.setState(tab, 'active');
  assert.strictEqual('#' + tab.material.color.getHexString(), '#4d9e75');
  gz.setState(tab, 'idle');
  theme = 'dark'; gz.refreshTheme();
  assert.strictEqual('#' + tab.material.color.getHexString(), '#1f1f1f');
});

test('update() rescales tracked handles to their pixel size, billboards tabs, drops detached ones', () => {
  const gz = G.create({ THREE, read: G.makeTokenReader(() => '#888888') });
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1e5);
  const tab = G.buildTab(THREE, 12); tab.position.set(2, 1, 0); scene.add(tab); gz.track(tab);
  const arc = G.buildArc(THREE, 28); scene.add(arc); gz.track(arc);
  for (const d of [3, 30, 300]) {
    cam.position.set(0, 0, d); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    gz.update(cam, VP_H);
    assert.ok(Math.abs(screenPx(cam, tab.position, 12 * tab.scale.x) - 12) < 0.05);
    assert.ok(tab.quaternion.angleTo(cam.quaternion) < 1e-9, 'tab faces the camera');
  }
  scene.remove(arc); gz.update(cam, VP_H);
  assert.strictEqual(gz.size(), 1);
});

test('planeOutline: axis plane = the box face section (+4..15 % per side), centred on it', () => {
  const axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const corners = G.boxCorners(axes, { x: 0, y: 0, z: 0 }, { x: 40, y: 12, z: 20 });
  const n = [0, 1, 0], b = G.planeBasis(n, [1, 0, 0]);
  const o = G.planeOutline(corners, n, [20, 6, 10], b, 1.3);
  assert.deepStrictEqual(o.extent.map((v) => +v.toFixed(9)), [40, 20]);
  assert.ok(o.halfW >= 20 * 1.04 - 1e-9 && o.halfW <= 20 * 1.3 + 1e-9);
  assert.ok(Math.abs(o.halfW / o.halfH - 2) < 1e-9, 'keeps the section aspect');
  assert.deepStrictEqual(o.center.map((v) => +v.toFixed(9)), [20, 6, 10]);
});

test('planeOutline: a tilted plane picked off-centre is centred on the box section, not the picked point', () => {
  const axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const corners = G.boxCorners(axes, { x: 0, y: 0, z: 0 }, { x: 30, y: 10, z: 10 });
  const n = [Math.SQRT1_2, 0, Math.SQRT1_2], pick = [4, 9, 4];
  const b = G.planeBasis(n, [1, 0, 0]);
  const o = G.planeOutline(corners, n, pick, b, 1.3);
  const c = o.center;
  assert.ok(Math.abs((c[0] - pick[0]) * n[0] + (c[2] - pick[2]) * n[2]) < 1e-9, 'centre lies on the plane');
  assert.ok(Math.abs(c[1] - 5) < 1e-9, 'vertically centred on the box');
  // every box ∩ plane point is inside the rectangle
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) {
    const j = i | bit; if (j === i) continue;
    const di = (corners[i][0] - pick[0]) * n[0] + (corners[i][2] - pick[2]) * n[2];
    const dj = (corners[j][0] - pick[0]) * n[0] + (corners[j][2] - pick[2]) * n[2];
    if (!(di * dj < 0)) continue;
    const t = di / (di - dj), q = corners[i].map((v, k) => v + (corners[j][k] - v) * t);
    const r = q.map((v, k) => v - c[k]);
    const u = r[0] * b.u[0] + r[1] * b.u[1] + r[2] * b.u[2], v = r[0] * b.v[0] + r[1] * b.v[1] + r[2] * b.v[2];
    assert.ok(Math.abs(u) <= o.halfW + 1e-9 && Math.abs(v) <= o.halfH + 1e-9);
  }
  assert.ok(2 * o.halfW <= 1.3 * o.extent[0] + 1e-9 && 2 * o.halfH <= 1.3 * o.extent[1] + 1e-9);
});

test('planeBasis is right-handed and horizontal-first', () => {
  for (const n of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.6, 0.0, -0.8], [0.3, 0.5, 0.81]]) {
    const b = G.planeBasis(n, [1, 0, 0]);
    const cx = [b.u[1] * b.v[2] - b.u[2] * b.v[1], b.u[2] * b.v[0] - b.u[0] * b.v[2], b.u[0] * b.v[1] - b.u[1] * b.v[0]];
    cx.forEach((v, k) => assert.ok(Math.abs(v - b.n[k]) < 1e-9));
    if (Math.abs(b.n[1]) < 0.99) assert.ok(Math.abs(b.u[1]) < 1e-12, 'u horizontal');
  }
});
