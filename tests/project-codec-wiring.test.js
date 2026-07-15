'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codec = require('../project-codec');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const A = {
  ADD_MODEL:'ADD_MODEL',UPD_RULES:'UPD_RULES',SET_CLASHES:'SET_CLASHES',
  LOAD_PROJECT_STATE:'LOAD_PROJECT_STATE',ADD_ISSUE:'ADD_ISSUE',ADD_VIEWPOINT:'ADD_VIEWPOINT',
  ADD_MEASUREMENT:'ADD_MEASUREMENT',MERGE_CHANGELOG:'MERGE_CHANGELOG'
};

function loadAdapter(candidate, enabled) {
  const start = source.indexOf('  function _ccLegacySerializeProject(');
  const marker = source.indexOf('window._ccProjectCodecStatus = Object.freeze', start);
  const end = source.indexOf('\n', marker);
  const diagnostics = [];
  const window = {
    _ccProjectCodec:candidate,
    _ccSafetyMigrations:{
      isEnabled:(name) => enabled && name === 'projectCodecV2',
      record:(entry) => diagnostics.push(entry),
    },
  };
  const api = new Function('window','A', source.slice(start, end) +
    ';return {_ccSerializeProject,_ccValidateProject,_ccRestoreProject};')(window,A);
  return {window,diagnostics,api};
}

function sample() {
  return {rules:{},models:[],clashes:[],issues:[],floors:[],viewpoints:[]};
}

test('project codec loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="project-codec.js"></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'project-codec\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('flag-off never calls or validates candidate code', () => {
  let calls = 0;
  const broken = {
    contractVersion:1,
    serializeProject:()=>{calls++;return {};},
    validateProject:()=>{calls++;},
    restoreProject:()=>{calls++;}
  };
  const loaded = loadAdapter(broken, false);
  const out = loaded.api._ccSerializeProject(sample(), 'v', 't');
  assert.equal(loaded.window._ccProjectCodecStatus.active, false);
  assert.equal(out._cc, 'ClashControl');
  assert.equal(calls, 0);
  assert.deepEqual(loaded.diagnostics, []);
});

test('valid opt-in activates codec after serialization and restore comparison', () => {
  const loaded = loadAdapter(codec, true);
  assert.equal(loaded.window._ccProjectCodecStatus.active, true);
  assert.equal(loaded.window._ccProjectCodecStatus.validation.equal, true);
  const out = loaded.api._ccSerializeProject(sample(), 'v', 't');
  assert.equal(out._v, 'v');
  const actions = [];
  loaded.api._ccRestoreProject(out, (action)=>actions.push(action));
  assert.deepEqual(actions.map((action)=>action.t), ['UPD_RULES','SET_CLASHES','LOAD_PROJECT_STATE']);
  assert.equal(loaded.diagnostics.at(-1).outcome, 'candidate');
});

test('candidate mismatch falls back to exact inline project mapping', () => {
  const broken = Object.assign({}, codec, {serializeProject:()=>({_cc:'wrong'})});
  const loaded = loadAdapter(broken, true);
  assert.equal(loaded.window._ccProjectCodecStatus.active, false);
  assert.equal(loaded.api._ccSerializeProject(sample(), 'v', 't')._cc, 'ClashControl');
  assert.equal(loaded.diagnostics.at(-1).outcome, 'fallback');
});
