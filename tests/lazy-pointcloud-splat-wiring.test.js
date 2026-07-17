'use strict';
// REWRITE_UI_PLAN.md Phase 10 — wiring lock for extending true first-use
// addon loading to pointcloud/splat, from their REAL triggers (a dropped
// file matching their extensions), not just the Integrations panel.
// Real end-to-end behavior (script not fetched at boot, fetched exactly
// once on first matching file, the actual point cloud parses successfully)
// was verified in a real browser — this locks the structural wiring
// node:test can check without a DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

test('pointcloud and splat are registered as lazy placeholders', () => {
  const metaStart = html.indexOf('var _ccLazyAddonMeta = {');
  const metaEnd = html.indexOf('};', metaStart) + 2;
  const meta = html.slice(metaStart, metaEnd);
  assert.match(meta, /'pointcloud':\s*\{/);
  assert.match(meta, /'splat':\s*\{/);
});

test('sw.js does not precache pointcloud.js or splat.js (they must stay fetchable only on demand)', () => {
  const sw = readFileSync(join(__dirname, '..', 'sw.js'), 'utf8');
  const precache = sw.slice(sw.indexOf('var PRECACHE'), sw.indexOf("self.addEventListener('install'"));
  assert.doesNotMatch(precache, /addons\/pointcloud\.js/);
  assert.doesNotMatch(precache, /addons\/splat\.js/);
});

test('ModelSidebar file-drop routing ensures the addon before calling into it, for both splat and point-cloud extensions', () => {
  const start = html.indexOf('function processFiles(files) {');
  const end = html.indexOf('\n      if (!files.length) return;', start);
  const body = html.slice(start, end);
  assert.match(body, /_ccEnsureAddon\('splat'\)/);
  assert.match(body, /_ccEnsureAddon\('pointcloud'\)/);
  // Every entry point calls ensure BEFORE checking for the loader function —
  // not the old synchronous "if (window._ccLoadX)" pattern that silently
  // no-ops when the addon hasn't loaded yet.
  assert.doesNotMatch(body, /if \(window\._ccLoadSplat\) \{/);
  assert.doesNotMatch(body, /if \(window\._ccLoadPointCloud\) \{/);
});

test('GlobalDropZone (canvas-level drop) also ensures pointcloud before use', () => {
  const start = html.indexOf('function onDrop(e){');
  const end = html.indexOf('\n      document.addEventListener(\'dragenter\'', start);
  assert.ok(start !== -1 && end !== -1);
  const body = html.slice(start, end);
  assert.match(body, /_ccEnsureAddon\('pointcloud'\)/);
});

test('the public window.ClashControl.loadSplat/loadPointCloud API ensures the addon first, for external automation', () => {
  const start = html.indexOf("loadSplat:");
  const line = html.slice(start, html.indexOf('\n', start + 200));
  assert.match(html.slice(start, start + 400), /_ccEnsureAddon \? window\._ccEnsureAddon\('splat'\)/);
  const pcStart = html.indexOf('loadPointCloud:');
  assert.match(html.slice(pcStart, pcStart + 400), /_ccEnsureAddon \? window\._ccEnsureAddon\('pointcloud'\)/);
});
