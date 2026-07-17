'use strict';
// identityCoreV2 graduated from a flagged migration (boot-time equivalence
// check against an inline legacy implementation, opt-out flag) to the sole
// implementation — see MEMORY.md Architecture Decisions. This locks the
// simplified wiring: index.html's computeClashPair/computeClashIdentityKey
// are a direct, unconditional delegation to window._ccClashIdentityCore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function loadAdapter(candidate) {
  const start = source.indexOf('var _ccIdentityCore = window._ccClashIdentityCore;');
  const end = source.indexOf('\n\n', source.indexOf('function computeClashIdentityKey(clash)', start));
  assert.ok(start >= 0 && end > start, 'identity wiring block not found');
  const window = { _ccClashIdentityCore: candidate };
  const api = new Function('window', source.slice(start, end) +
    ';return {computeClashPair,computeClashIdentityKey};')(window);
  return { window, api };
}

const sample = { uniqueIdA: 'revit-b', uniqueIdB: 'revit-a', globalIdA: 'ifc-a', globalIdB: 'ifc-b', elemA: 9, elemB: 2, point: [1, 2, 3] };

test('identity helper loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="clash-identity-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'clash-identity-core\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('no flag, gate, or opt-out remains for this migration', () => {
  assert.doesNotMatch(source, /isEnabled\('identityCoreV2'\)/);
  assert.doesNotMatch(source, /_ccIdentityCoreStatus/);
  assert.doesNotMatch(source, /_ccIdentityCoreActive/);
  assert.doesNotMatch(source, /_ccValidateIdentityCore/);
});

test('computeClashPair and computeClashIdentityKey delegate directly and unconditionally to the module', () => {
  const { api } = loadAdapter({
    computeClashPair: (c) => 'pair:' + c.elemA,
    computeClashIdentityKey: (c) => 'key:' + c.elemA,
  });
  assert.equal(api.computeClashPair(sample), 'pair:9');
  assert.equal(api.computeClashIdentityKey(sample), 'key:9');
});

test('a missing module surfaces a real error rather than silently falling back to anything', () => {
  const { api } = loadAdapter(undefined);
  assert.throws(() => api.computeClashPair(sample), TypeError);
});
