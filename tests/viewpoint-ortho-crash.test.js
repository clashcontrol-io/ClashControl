'use strict';
// Wiring-lock for the _captureViewpoint/_restoreViewpoint orthographic-camera
// crash fix (2026-07-21) — same "wiring-lock rather than functional
// extraction" style as tests/large-candidate-warning.test.js: _captureViewpoint
// depends on live THREE.js scene/camera/renderer/orbit state that isn't
// worth mocking just to exercise a guard clause.
//
// THREE.OrthographicCamera has no .fov. _captureViewpoint used to read
// S.camera.fov.toFixed(2) unconditionally — a TypeError (.toFixed on
// undefined) whenever a user saved a viewpoint while the app's
// orthographic-view toggle (_ccToggleOrtho, index.html) was active.
// _restoreViewpoint had the mirror bug: unconditionally writing
// S.camera.fov (a no-op-ish stray property, not a crash, but wrong) even
// when the live camera was orthographic.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function sliceFn(startMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, 'expected to find: ' + startMarker);
  const end = html.indexOf('\n      };', start) + '\n      };'.length;
  assert.ok(end > start, 'expected to find the function close for: ' + startMarker);
  return html.slice(start, end);
}

test('_captureViewpoint never reads .fov unconditionally — it is guarded by an isOrtho check', () => {
  const body = sliceFn('_captureViewpoint = function(name, linkedId) {');
  assert.doesNotMatch(body, /^\s*fov:\+S\.camera\.fov/m, 'a bare unconditional S.camera.fov read would throw on an OrthographicCamera');
  assert.match(body, /isOrthographicCamera/, 'must branch on isOrthographicCamera before reading .fov');
});

test('_captureViewpoint computes viewToWorldScale for the orthographic branch (BCF ViewToWorldScale field)', () => {
  const body = sliceFn('_captureViewpoint = function(name, linkedId) {');
  assert.match(body, /viewToWorldScale/);
  assert.match(body, /isOrtho:true/);
  assert.match(body, /isOrtho:false/);
});

test('_restoreViewpoint only writes S.camera.fov when the live camera is confirmed non-orthographic', () => {
  const body = sliceFn('_restoreViewpoint = function(vp) {');
  // The perspective-restore branch must be gated on !S.camera.isOrthographicCamera
  // (not just "camera type unspecified"), so it can never assign .fov onto
  // a live OrthographicCamera.
  assert.match(body, /!S\.camera\.isOrthographicCamera[\s\S]{0,80}c\.fov[\s\S]{0,40}S\.camera\.fov = c\.fov/);
});

test('_restoreViewpoint only restores orthographic scale when the live camera is confirmed orthographic', () => {
  const body = sliceFn('_restoreViewpoint = function(vp) {');
  assert.match(body, /c\.isOrtho && S\.camera\.isOrthographicCamera/);
  assert.match(body, /viewToWorldScale/);
});
