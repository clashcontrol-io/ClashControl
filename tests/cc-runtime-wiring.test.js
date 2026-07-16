const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');

test('runtime boundary loads before migration helpers and the application', () => {
  const runtime = html.indexOf('<script src="cc-runtime.js" defer></script>');
  const safety = html.indexOf('<script src="safety-migrations.js" defer></script>');
  const app = html.indexOf('function startApp()');
  assert.ok(runtime >= 0 && runtime < safety && safety < app);
  assert.match(sw, /'cc-runtime\.js'/);
});

test('IFC completion uses the idempotent coordinator instead of parallel counters', () => {
  assert.doesNotMatch(html, /_lazyWorkersActive|_chainEndFired/);
  assert.match(html, /\.hold\('ifc-properties:'/);
  assert.match(html, /_loadBatch\.markChainDone\(\)/);
  assert.match(html, /_loadBatch\.fail\(\)/);
});

test('inactive integrations are on-demand and cached after first successful use', () => {
  assert.match(html, /'smart-bridge':\s*\{/);
  assert.match(html, /'openaec-bridge':\s*\{/);
  assert.match(html, /window\._ccEnsureAddon/);
  const precache = sw.slice(sw.indexOf('var PRECACHE'), sw.indexOf('self.addEventListener(\'install\''));
  assert.doesNotMatch(precache, /addons\/smart-bridge\.js/);
  assert.doesNotMatch(precache, /addons\/openaec-bridge\.js/);
  assert.match(sw, /sameOriginAddon/);
});
