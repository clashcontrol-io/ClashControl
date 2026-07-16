'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../clash-reconciliation-core');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function loadAdapter(candidate, enabled) {
  const start = source.indexOf('  function _ccLegacyComputeClashPair(');
  const marker = source.indexOf('window._ccReconciliationCoreStatus = Object.freeze', start);
  const end = source.indexOf('\n', marker);
  const diagnostics = [];
  const window = {
    _ccClashReconciliationCore:candidate,
    _ccSafetyMigrations:{
      isEnabled:(name) => enabled && name === 'reconciliationCoreV2',
      record:(entry) => diagnostics.push(entry),
    },
  };
  const api = new Function('window', source.slice(start, end) +
    ';return {mergeDetectionResults};')(window);
  return {window, diagnostics, api};
}

function sample(id, a, b, extra) {
  return Object.assign({id,uniqueIdA:a,uniqueIdB:b,point:[1,2,3],distance:-10,status:'open'}, extra || {});
}

test('reconciliation helper loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="clash-reconciliation-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'clash-reconciliation-core\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('flag-off never calls or validates candidate code', () => {
  let calls = 0;
  const broken = {contractVersion:1,autoResolveCap:200,mergeDetectionResults:()=>{calls++;return {clashes:[]};}};
  const loaded = loadAdapter(broken, false);
  const out = loaded.api.mergeDetectionResults([sample('new','a','b')], []);
  assert.equal(loaded.window._ccReconciliationCoreStatus.active, false);
  assert.equal(out.clashes.length, 1);
  assert.equal(calls, 0);
  assert.deepEqual(loaded.diagnostics, []);
});

test('valid opt-in activates candidate after full legacy comparison', () => {
  const loaded = loadAdapter(core, true);
  assert.equal(loaded.window._ccReconciliationCoreStatus.active, true);
  assert.equal(loaded.window._ccReconciliationCoreStatus.validation.equal, true);
  const prev = [sample('stable','a','b',{assignee:'jane'})];
  const out = loaded.api.mergeDetectionResults([sample('fresh','a','b')], prev);
  assert.equal(out.clashes[0].id, 'stable');
  assert.equal(out.clashes[0].assignee, 'jane');
  assert.equal(loaded.diagnostics.at(-1).outcome, 'candidate');
});

test('candidate mismatch falls back to exact inline reconciliation', () => {
  const broken = Object.assign({}, core, {mergeDetectionResults:()=>({clashes:[],deltaSummary:{}})});
  const loaded = loadAdapter(broken, true);
  assert.equal(loaded.window._ccReconciliationCoreStatus.active, false);
  assert.equal(loaded.api.mergeDetectionResults([sample('new','a','b')], []).clashes.length, 1);
  assert.equal(loaded.diagnostics.at(-1).outcome, 'fallback');
});
