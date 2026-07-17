'use strict';
// reconciliationCoreV2 graduated from a flagged migration (boot-time
// equivalence check against an inline legacy implementation, opt-out flag)
// to the sole implementation — see MEMORY.md Architecture Decisions. This
// locks the simplified wiring: index.html's mergeDetectionResults is a
// direct, unconditional delegation to window._ccClashReconciliationCore
// (with computeClashIdentityKey/computeClashPair/isDeniedClash injected as
// deps, same as before).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function loadAdapter(candidate) {
  // mergeDetectionResults' deps (computeClashIdentityKey/computeClashPair/
  // isDeniedClash) live in the identity + denied-clash sections just above
  // the reconciliation block — pull the whole span, same as production
  // script-scope order. window._ccClashAssignmentCore is never called here,
  // so it staying undefined in between is harmless.
  const start = source.indexOf('var _ccIdentityCore = window._ccClashIdentityCore;');
  const end = source.indexOf('\n\n', source.indexOf('function mergeDetectionResults(newClashes, prevClashes)', start));
  assert.ok(start >= 0 && end > start, 'reconciliation wiring block not found');
  const window = { _ccClashIdentityCore: require('../clash-identity-core'), _ccClashReconciliationCore: candidate };
  const api = new Function('window', source.slice(start, end) + ';return {mergeDetectionResults};')(window);
  return { window, api };
}

function sample(id, a, b, extra) {
  return Object.assign({ id, uniqueIdA: a, uniqueIdB: b, point: [1, 2, 3], distance: -10, status: 'open' }, extra || {});
}

test('reconciliation helper loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="clash-reconciliation-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'clash-reconciliation-core\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('no flag, gate, or opt-out remains for this migration', () => {
  assert.doesNotMatch(source, /isEnabled\('reconciliationCoreV2'\)/);
  assert.doesNotMatch(source, /_ccReconciliationCoreStatus/);
  assert.doesNotMatch(source, /_ccReconciliationCoreActive/);
  assert.doesNotMatch(source, /_ccValidateReconciliationCore/);
});

test('mergeDetectionResults delegates directly and unconditionally to the module, with real identity deps', () => {
  const { api } = loadAdapter({
    mergeDetectionResults: (next, prev, deps) => ({
      clashes: next.map((c) => Object.assign({}, c, { _identityKey: deps.computeClashIdentityKey(c) })),
      deltaSummary: { newCount: next.length, persisting: 0, autoResolved: 0, ts: deps.now || 0 },
    }),
  });
  const out = api.mergeDetectionResults([sample('new', 'a', 'b')], []);
  assert.equal(out.clashes.length, 1);
  assert.equal(typeof out.clashes[0]._identityKey, 'string');
  assert.ok(out.clashes[0]._identityKey.length > 0);
});

test('a missing module surfaces a real error rather than silently falling back to anything', () => {
  const { api } = loadAdapter(undefined);
  assert.throws(() => api.mergeDetectionResults([sample('new', 'a', 'b')], []), TypeError);
});
