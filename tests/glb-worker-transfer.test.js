'use strict';
// The GLB geometry pre-extraction worker builds a `transferList` of every
// result buffer. It used to call self.postMessage({results}) WITHOUT it (and
// the list was even declared in an inner callback scope), so every Float32Array
// was structured-cloned instead of moved. Run the real worker source against a
// tiny synthetic GLB and assert the transfer list is passed and correct.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function workerSource() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('var _glbGeoWorkerCode = function() {');
  assert.ok(start !== -1, 'could not locate _glbGeoWorkerCode');
  const end = html.indexOf('}.toString();', start);
  assert.ok(end !== -1, 'could not locate end of _glbGeoWorkerCode');
  return html.slice(html.indexOf('{', start) + 1, end);
}

function makeGLB() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(pos.buffer);
  const json = {
    asset: { version: '2.0' },
    nodes: [{ name: 'GID-1', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }]
  };
  let js = Buffer.from(JSON.stringify(json));
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const total = 12 + 8 + js.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20);
  const o = 20 + js.length;
  out.writeUInt32LE(bin.length, o); out.writeUInt32LE(0x004e4942, o + 4); bin.copy(out, o + 8);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

test('GLB geometry worker passes its transferList to postMessage', () => {
  const posted = [];
  const self = { postMessage: (msg, xfer) => posted.push({ msg, xfer }) };
  new Function('self', workerSource())(self);
  self.onmessage({ data: { models: [{ id: 'm1', buffer: makeGLB() }] } });
  assert.strictEqual(posted.length, 1);
  const { msg, xfer } = posted[0];
  const r = msg.results.m1['GID-1'];
  assert.ok(r, 'element result present');
  assert.strictEqual(r.tris.length, 9);
  assert.ok(Array.isArray(xfer), 'transfer list must be passed');
  assert.strictEqual(xfer.length, 2);
  assert.ok(xfer.includes(r.wv.buffer) && xfer.includes(r.tris.buffer), 'transfer list holds exactly the result buffers');
});
