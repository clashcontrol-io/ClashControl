'use strict';

// Silent failure was a repeated historical pattern. Keep the existing user/
// CI-visible diagnostics attached to the failure paths that matter most.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

test('IFC worker fallback is visible and fails the real browser smoke gate', () => {
  const app = read('index.html');
  const smoke = read('tests/browser/smoke.mjs');
  assert.match(app, /\[IFC Worker fallback\]/);
  assert.match(smoke, /workerFellBack = true/);
  assert.match(smoke, /fail\('IFC worker crashed and fell back/);
});

test('WASM failure explicitly announces the JavaScript fallback', () => {
  assert.match(read('addons/wasm-engine.js'), /WASM engine failed to load\. Using JavaScript fallback\./);
});

test('shared-project read/write failures remain visible and cannot look synced', () => {
  const shared = read('addons/shared-project.js');
  assert.match(shared, /return \{__readError: true\}/);
  assert.match(shared, /Shared folder access lost/);
  assert.match(shared, /throw e; \/\/ let the sync loop record the failure instead of stamping lastSync/);
});

test('Smart Bridge status exposes detection failure and staleness signals', () => {
  const bridge = read('addons/smart-bridge.js');
  assert.match(bridge, /lastDetectionError/);
  assert.match(bridge, /clashesStale/);
  assert.match(bridge, /matched no loaded model/);
});

