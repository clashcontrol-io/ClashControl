'use strict';
// Regression lock for BCF orthographic-camera export (2026-07-21). BCF-XML's
// OrthogonalCamera (visinfo.xsd, buildingSMART BCF-XML release_3_0) is a
// CHOICE alternative to PerspectiveCamera: same CameraViewPoint/
// CameraDirection/CameraUpVector/AspectRatio, but <ViewToWorldScale> (the
// view's visible vertical size in meters) instead of <FieldOfView>.
// exportBCF used to emit <PerspectiveCamera> unconditionally, even when the
// captured viewpoint came from the app's orthographic-view toggle
// (_ccToggleOrtho) — losing the fact the view was orthographic at all, and
// (separately, see the _captureViewpoint fix in the same commit) a THREE.js
// OrthographicCamera has no .fov, so capturing a viewpoint while the ortho
// toggle was active used to throw before reaching export at all.
//
// Same extraction pattern as tests/bcf-export.test.js (self-contained here
// rather than reusing its runExport(), which hardcodes its own perspective-
// only viewpoints array).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function extractFunction(src, header) {
  const start = src.indexOf(header);
  assert.ok(start !== -1, header + ' not found');
  const tail = 'URL.revokeObjectURL(a.href);';
  const tailPos = src.indexOf(tail, start);
  assert.ok(tailPos !== -1, 'exportBCF tail not found');
  const cbClose = src.indexOf('}', tailPos);
  const fnClose = src.indexOf('}', cbClose + 1);
  return src.slice(start, fnClose + 1);
}

function runExport(camera) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fnSrc = extractFunction(html, 'function _lookupElBox(models, modelId, expressId)');

  const files = {};
  function makeZip(prefix) {
    return {
      file(name, content) { files[prefix + name] = content; },
      folder(name) { return makeZip(prefix + name + '/'); },
      generateAsync() { return { then() {} }; },
    };
  }
  const sandbox = {
    JSZip: function () { return makeZip(''); },
    guid: () => 'AB12CD34-EF56-0789-ABCD-EF0123456789',
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _gcEvent: () => {},
    _ccChangelogUser: 'Tester',
    _ccRenderSheetToCanvas: () => null,
    window: { CC_VERSION: { v: 'test' }, _ccViewport: { getCamera: () => ({ aspect: 1.5 }) } },
    confirm: () => false,
  };
  const fn = new Function(...Object.keys(sandbox), fnSrc + '; return exportBCF;')(...Object.values(sandbox));

  const items = [{
    id: 'i1', bcfGuid: 'topic-1', title: 'Ortho view issue', type: 'hard', status: 'open',
    description: 'desc', createdAt: '2026-06-10T00:00:00Z',
  }];
  const viewpoints = [{ linkedId: 'i1', snapshot: 'data:image/png;base64,AAAA', camera: camera }];
  fn(items, '3.0', viewpoints, { models: [] });

  const bcfvName = Object.keys(files).find((n) => n.endsWith('.bcfv'));
  return files[bcfvName];
}

test('an orthographic-view viewpoint exports <OrthogonalCamera> with <ViewToWorldScale>, not <PerspectiveCamera>/<FieldOfView>', () => {
  const bcfv = runExport({
    px: 1, py: 2, pz: 3, dx: 0, dy: -1, dz: 0, ux: 0, uy: 0, uz: 1,
    isOrtho: true, viewToWorldScale: 12.3456,
  });
  assert.ok(bcfv.includes('<OrthogonalCamera>'), 'expected <OrthogonalCamera>');
  assert.ok(bcfv.includes('</OrthogonalCamera>'), 'expected matching close tag');
  assert.ok(!bcfv.includes('<PerspectiveCamera>'), 'must not also emit PerspectiveCamera');
  assert.ok(bcfv.includes('<ViewToWorldScale>12.345600</ViewToWorldScale>'));
  assert.ok(!bcfv.includes('<FieldOfView>'), 'orthographic camera must not carry FieldOfView');
});

test('a perspective viewpoint (isOrtho: false) still exports <PerspectiveCamera>/<FieldOfView> as before', () => {
  const bcfv = runExport({
    px: 1, py: 2, pz: 3, dx: 0, dy: -1, dz: 0, ux: 0, uy: 0, uz: 1,
    isOrtho: false, fov: 62.5,
  });
  assert.ok(bcfv.includes('<PerspectiveCamera>'));
  assert.ok(bcfv.includes('<FieldOfView>62.5</FieldOfView>'));
  assert.ok(!bcfv.includes('<OrthogonalCamera>'));
  assert.ok(!bcfv.includes('<ViewToWorldScale>'));
});

test('a legacy viewpoint with neither isOrtho nor fov falls back to PerspectiveCamera at the app default fov', () => {
  const bcfv = runExport({ px: 1, py: 2, pz: 3, dx: 0, dy: -1, dz: 0, ux: 0, uy: 0, uz: 1 });
  assert.ok(bcfv.includes('<PerspectiveCamera>'));
  assert.ok(bcfv.includes('<FieldOfView>55</FieldOfView>'), 'legacy viewpoints predate fov capture — 55 is the documented app default');
});

test('both camera element types still carry the required 3.0 AspectRatio', () => {
  const orthoBcfv = runExport({ px: 0, py: 0, pz: 0, dx: 0, dy: -1, dz: 0, ux: 0, uy: 0, uz: 1, isOrtho: true, viewToWorldScale: 5 });
  const perspBcfv = runExport({ px: 0, py: 0, pz: 0, dx: 0, dy: -1, dz: 0, ux: 0, uy: 0, uz: 1, isOrtho: false, fov: 55 });
  assert.ok(orthoBcfv.includes('<AspectRatio>'));
  assert.ok(perspBcfv.includes('<AspectRatio>'));
});
