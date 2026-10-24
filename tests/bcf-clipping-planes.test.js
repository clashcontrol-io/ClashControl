// BCF <ClippingPlanes> round trip (index.html _ccBcfClipFromPlanes /
// _ccBcfSectionFromClip, exportBCF, importBCF). BCF: Direction points into
// the CLIPPED half-space; three.js keeps n·p + c >= 0.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fnSrc(name) {
  const start = html.indexOf('  function ' + name + '(');
  assert.ok(start > 0, name + ' not found');
  return html.slice(start, html.indexOf('\n  }\n', start) + 4);
}
const toIfc = (v) => ({ x: v.x, y: -v.z, z: v.y }), toScene = (v) => ({ x: v.x, y: v.z, z: -v.y });
const api = new Function('_bcfSceneToIfc', '_bcfIfcToScene',
  fnSrc('_ccBcfClipFromPlanes') + fnSrc('_ccBcfSectionFromClip') + 'return { _ccBcfClipFromPlanes, _ccBcfSectionFromClip };')(toIfc, toScene);

// the section box tool's planes (index.html, section box effect): keep-inside planes about a Y rotation
function boxPlanes(b) {
  const c = Math.cos(b.rotation || 0), s = Math.sin(b.rotation || 0);
  const ctr = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2), h = [0, 1, 2].map((k) => (b.max[k] - b.min[k]) / 2);
  const ax = [[c, 0, -s], [0, 1, 0], [s, 0, c]], out = [];
  ax.forEach((a, k) => {
    for (const sg of [1, -1]) { // normal sg*a at ctr - sg*h*a
      const n = a.map((x) => sg * x), p = ctr.map((x, i) => x - sg * h[k] * a[i]);
      out.push([n[0], n[1], n[2], -(n[0] * p[0] + n[1] * p[1] + n[2] * p[2])]);
    }
  });
  return out;
}
const keeps = (pl, p) => pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] + pl[3] >= -1e-9;
function close(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= eps, msg + ': ' + a + ' vs ' + b); }

test('exported Direction points into the clipped side, Location lies on the plane', () => {
  const pl = [0.6, 0, 0.8, -2.5]; // keeps 0.6x + 0.8z >= 2.5
  const [bp] = api._ccBcfClipFromPlanes([pl]);
  const L = toScene(bp.L), D = toScene(bp.D);
  close(pl[0] * L.x + pl[1] * L.y + pl[2] * L.z + pl[3], 0, 1e-12, 'Location on the plane');
  assert.equal(keeps(pl, [L.x + D.x, L.y + D.y, L.z + D.z]), false, 'one step along Direction is clipped');
  assert.equal(keeps(pl, [L.x - D.x, L.y - D.y, L.z - D.z]), true, 'one step against it is kept');
});

test('a section box exported as 6 planes imports back as the same box (rotated too)', () => {
  for (const box of [{ enabled: true, min: [-1, 0, 2], max: [3, 2.5, 6], rotation: 0 }, { enabled: true, min: [10, -2, -5], max: [14, 1, 2], rotation: 0.3 }]) {
    const back = api._ccBcfSectionFromClip(api._ccBcfClipFromPlanes(boxPlanes(box)));
    assert.equal(back.section.kind, 'box');
    assert.equal(back.dropped, 0);
    // same clipping region: the rebuilt box's planes equal the original's (as a set)
    const a = boxPlanes(box), b = boxPlanes(back.section.box);
    for (const p of a) assert.ok(b.some((q) => q.every((v, i) => Math.abs(v - p[i]) < 1e-9)), 'plane ' + p + ' kept');
  }
});

test('one plane imports as a custom section clipping the same side; plane + box keep both; extra planes are reported', () => {
  const pl = [0, -1, 0, 3]; // keeps y <= 3
  const one = api._ccBcfSectionFromClip(api._ccBcfClipFromPlanes([pl]));
  assert.equal(one.section.kind, 'custom');
  // the app's custom plane: setFromNormalAndCoplanarPoint(-normal, point) keeps -normal·(p - point) >= 0
  const n = one.section.custom.normal, pt = one.section.custom.point;
  const appPl = [-n[0], -n[1], -n[2], n[0] * pt[0] + n[1] * pt[1] + n[2] * pt[2]];
  appPl.forEach((v, i) => close(v, pl[i], 1e-12, 'custom plane component ' + i));
  const box = { enabled: true, min: [0, 0, 0], max: [4, 3, 4], rotation: 0 };
  const both = api._ccBcfSectionFromClip(api._ccBcfClipFromPlanes(boxPlanes(box).concat([[1, 0, 0, -2]])));
  assert.equal(both.section.kind, 'custom');
  assert.ok(both.section.box && both.section.box.enabled, 'the box is kept alongside the plane');
  assert.equal(both.dropped, 0);
  const many = api._ccBcfSectionFromClip(api._ccBcfClipFromPlanes([[1, 0, 0, 0], [0, 0, 1, 0], [0.6, 0.8, 0, 1]]));
  assert.equal(many.dropped, 2);
  assert.equal(many.clip.length, 3, 'all planes stay on the viewpoint');
});

test('exportBCF writes <ClippingPlanes> after the camera; viewpoints without clip write none', () => {
  const i0 = html.indexOf('  function exportBCF(');
  const body = html.slice(i0, html.indexOf('URL.revokeObjectURL(a.href);', i0));
  const cam = body.indexOf("'  </OrthogonalCamera>\\n' : '  </PerspectiveCamera>\\n';\n        }\n        // <ClippingPlanes>");
  assert.ok(cam > 0, 'ClippingPlanes block follows the camera element');
  assert.match(body, /var _bcfClip = _ccBcfClipFromPlanes\(vp\.clip\);\s*\n\s*if \(_bcfClip\.length\)/);
  assert.match(html, /clip:_clip\.length \? _clip : null/);
  assert.match(html, /section: _vpWithCam\.section \|\| null, clip: _vpWithCam\.clip \|\| null/);
});
