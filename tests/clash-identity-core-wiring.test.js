'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../clash-identity-core');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function loadAdapter(candidate, enabled) {
  const start = source.indexOf('  function _ccLegacyComputeClashPair(');
  const marker = source.indexOf('window._ccIdentityCoreStatus = Object.freeze', start);
  const end = source.indexOf('\n', marker);
  const diagnostics = [];
  const window = {
    _ccClashIdentityCore:candidate,
    _ccSafetyMigrations:{
      isEnabled:(name) => enabled && name === 'identityCoreV2',
      record:(entry) => diagnostics.push(entry),
    },
  };
  const api = new Function('window', source.slice(start, end) +
    ';return {computeClashPair,computeClashIdentityKey};')(window);
  return {window, diagnostics, api};
}

const sample = {uniqueIdA:'revit-b',uniqueIdB:'revit-a',globalIdA:'ifc-a',globalIdB:'ifc-b',elemA:9,elemB:2,point:[1,2,3]};

test('identity helper loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="clash-identity-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'clash-identity-core\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('flag-off never calls or validates candidate code', () => {
  let calls = 0;
  const broken = {contractVersion:1,computeClashPair:()=>{calls++;return 'bad';},computeClashIdentityKey:()=>{calls++;return 'bad';}};
  const loaded = loadAdapter(broken, false);
  assert.equal(loaded.window._ccIdentityCoreStatus.active, false);
  assert.equal(loaded.api.computeClashPair(sample), 'u:revit-a|u:revit-b');
  assert.equal(calls, 0);
  assert.deepEqual(loaded.diagnostics, []);
});

test('valid opt-in activates candidate after legacy-equivalence validation', () => {
  const loaded = loadAdapter(core, true);
  assert.equal(loaded.window._ccIdentityCoreStatus.active, true);
  assert.equal(loaded.window._ccIdentityCoreStatus.validation.equal, true);
  assert.equal(loaded.api.computeClashIdentityKey(sample), 'u:revit-a|u:revit-b@2,4,6');
  assert.equal(loaded.diagnostics.at(-1).outcome, 'candidate');
});

test('candidate mismatch falls back to the exact inline identity scheme', () => {
  const broken = Object.assign({}, core, {computeClashPair:()=> 'wrong'});
  const loaded = loadAdapter(broken, true);
  assert.equal(loaded.window._ccIdentityCoreStatus.active, false);
  assert.equal(loaded.api.computeClashPair(sample), 'u:revit-a|u:revit-b');
  assert.equal(loaded.diagnostics.at(-1).outcome, 'fallback');
});
