// _ccGeoBounds (index.html) sets a loader geometry's boundingBox and
// boundingSphere straight from its Float32 positions. It must be
// bit-identical to three r180's computeBoundingBox / computeBoundingSphere
// (incl. -0, empty and single-vertex geometries), and leave anything else to three.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const THREE = require('three');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('  function _ccGeoBounds(geo) {');
const end = src.indexOf('\n  }\n', start) + 4;
assert.ok(start > 0 && end > start, '_ccGeoBounds not found');
const _ccGeoBounds = new Function('THREE', src.slice(start, end) + '; return _ccGeoBounds;')(THREE);

function geoOf(arr) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(arr), 3)); return g; }
function same(a, b, what) { assert.ok(Object.is(a, b), what + ': ' + a + ' vs ' + b); }
function check(arr, label) {
  const ref = geoOf(arr); ref.computeBoundingBox(); ref.computeBoundingSphere();
  const g = geoOf(arr);
  assert.equal(_ccGeoBounds(g), true, label);
  for (const k of ['x', 'y', 'z']) {
    same(g.boundingBox.min[k], ref.boundingBox.min[k], label + ' min.' + k);
    same(g.boundingBox.max[k], ref.boundingBox.max[k], label + ' max.' + k);
    same(g.boundingSphere.center[k], ref.boundingSphere.center[k], label + ' centre.' + k);
  }
  same(g.boundingSphere.radius, ref.boundingSphere.radius, label + ' radius');
}

test('bit-identical to three on random, signed-zero, empty and single-vertex geometries', () => {
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  for (let t = 0; t < 400; t++) {
    const n = 1 + Math.floor(rnd() * 60), scale = [1e-3, 1, 37.5, 1e5][t % 4], arr = [];
    for (let i = 0; i < n * 3; i++) arr.push((rnd() - 0.5) * scale + (t % 3 === 0 ? 120000 : 0));
    check(arr, 'random ' + t);
  }
  check([0, -0, 0, -0, 0, -0], 'signed zeros');
  check([-0, -0, -0], 'one vertex at -0');
  check([1.5, -2, 3], 'one vertex');
  check([], 'empty');
});

test('anything three must handle itself is left to three', () => {
  const inter = new THREE.BufferGeometry();
  inter.setAttribute('position', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Float32Array(12), 6), 3, 0));
  assert.equal(_ccGeoBounds(inter), false);
  const norm = new THREE.BufferGeometry(); norm.setAttribute('position', new THREE.Int16BufferAttribute(new Int16Array(6), 3, true));
  assert.equal(_ccGeoBounds(norm), false);
  const morph = geoOf([0, 0, 0, 1, 1, 1]); morph.morphAttributes.position = [new THREE.BufferAttribute(new Float32Array(6), 3)];
  assert.equal(_ccGeoBounds(morph), false);
  assert.equal(_ccGeoBounds(new THREE.BufferGeometry()), false);
});
