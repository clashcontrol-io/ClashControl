'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../project-codec');

const actions = {
  ADD_MODEL:'ADD_MODEL', UPD_RULES:'UPD_RULES', SET_CLASHES:'SET_CLASHES',
  LOAD_PROJECT_STATE:'LOAD_PROJECT_STATE', ADD_ISSUE:'ADD_ISSUE',
  ADD_VIEWPOINT:'ADD_VIEWPOINT', ADD_MEASUREMENT:'ADD_MEASUREMENT',
  ADD_SELSET:'ADD_SELSET', ADD_SEARCHSET:'ADD_SEARCHSET',
  ADD_ASSIGN_RULE:'ADD_ASSIGN_RULE', MERGE_CHANGELOG:'MERGE_CHANGELOG'
};

function state(extra) {
  return Object.assign({
    rules:{hard:true},
    models:[{id:'m',name:'Model',discipline:'mep',color:'#123456',visible:false,tag:'coord',meshes:[{}],elements:[{}]}],
    clashes:[{id:'c'}],issues:[{id:'i'}],floors:[{id:'L1'}],
    viewpoints:[{id:'v',snapshot:'png',camera:{x:1}}]
  }, extra || {});
}

test('project codec is an immutable three-function contract', () => {
  assert.equal(codec.contractVersion, 1);
  assert.equal(Object.isFrozen(codec), true);
  assert.equal(typeof codec.serializeProject, 'function');
  assert.equal(typeof codec.validateProject, 'function');
  assert.equal(typeof codec.restoreProject, 'function');
});

test('serialization preserves the established marker, version, time and model stubs', () => {
  const out = codec.serializeProject(state(), '5.test', '2026-01-02T03:04:05.000Z');
  assert.equal(out._cc, 'ClashControl');
  assert.equal(out._v, '5.test');
  assert.equal(out.savedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(out.models, [{id:'m',name:'Model',discipline:'mep',color:'#123456',visible:false,tag:'coord'}]);
  assert.equal('meshes' in out.models[0], false);
  assert.equal('elements' in out.models[0], false);
});

test('viewpoint snapshots are explicitly stripped without mutating source views', () => {
  const s = state();
  const out = codec.serializeProject(s, 'v', 't');
  assert.equal(Object.prototype.hasOwnProperty.call(out.viewpoints[0], 'snapshot'), true);
  assert.equal(out.viewpoints[0].snapshot, undefined);
  assert.equal(s.viewpoints[0].snapshot, 'png');
  assert.deepEqual(out.viewpoints[0].camera, {x:1});
});

test('optional review collections default exactly as existing project exports', () => {
  const out = codec.serializeProject(state({
    lastDeltaSummary:undefined,runHistory:undefined,measurements:undefined,
    selectionSets:undefined,searchSets:undefined,assignmentRules:undefined,changelog:undefined
  }), 'v', 't');
  assert.equal(out.lastDeltaSummary, null);
  for (const key of ['runHistory','measurements','selectionSets','searchSets','assignmentRules','changelog']) {
    assert.deepEqual(out[key], [], key);
  }
});

test('validation accepts ClashControl and rejects the exact old marker error', () => {
  assert.equal(codec.validateProject({_cc:'ClashControl'}), undefined);
  assert.throws(() => codec.validateProject({_cc:'Other'}), {message:'Not a ClashControl project file.'});
  assert.throws(() => codec.validateProject({}), {message:'Not a ClashControl project file.'});
});

test('restore emits the exact action order and restores models only as geometry stubs', () => {
  const data = codec.serializeProject(state({
    lastDeltaSummary:{newCount:1},runHistory:[{ts:1}],measurements:[{id:'measure'}],
    selectionSets:[{id:'selection'}],searchSets:[{id:'search',query:{ifcType:'IfcWall'}}],
    assignmentRules:[{id:'assignment'}],changelog:[{id:'change'}]
  }), 'v', 't');
  const emitted = [];
  assert.equal(codec.restoreProject(data, (action)=>emitted.push(action), actions), undefined);
  assert.deepEqual(emitted.map((action)=>action.t), [
    'ADD_MODEL','UPD_RULES','SET_CLASHES','LOAD_PROJECT_STATE','ADD_ISSUE','ADD_VIEWPOINT',
    'ADD_MEASUREMENT','ADD_SELSET','ADD_SEARCHSET','ADD_ASSIGN_RULE','MERGE_CHANGELOG'
  ]);
  assert.deepEqual(emitted[0].v.meshes, []);
  assert.deepEqual(emitted[0].v.elements, []);
  assert.equal(emitted[0].v._stub, true);
  assert.deepEqual(emitted.find((action)=>action.t==='ADD_SEARCHSET').v.query, {ifcType:'IfcWall'});
});

test('minimal legacy exports still emit only model and rules actions', () => {
  const emitted = [];
  codec.restoreProject({_cc:'ClashControl',models:[],rules:{}}, (action)=>emitted.push(action), actions);
  assert.deepEqual(emitted, [{t:'UPD_RULES',u:{}}]);
});

test('dispatch failures stop restoration at the same action boundary', () => {
  const emitted = [];
  const data = {_cc:'ClashControl',models:[{id:'a'},{id:'b'}],rules:{}};
  assert.throws(() => codec.restoreProject(data, (action) => {
    emitted.push(action);
    if (emitted.length === 2) throw new Error('stop');
  }, actions), /stop/);
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map((action)=>action.v.id), ['a','b']);
});
