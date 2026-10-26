'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../project-codec');

const actions = {
  ADD_MODEL:'ADD_MODEL', UPD_RULES:'UPD_RULES', SET_CLASHES:'SET_CLASHES',
  LOAD_PROJECT_STATE:'LOAD_PROJECT_STATE', ADD_ISSUE:'ADD_ISSUE',
  ADD_VIEWPOINT:'ADD_VIEWPOINT', ADD_MEASUREMENT:'ADD_MEASUREMENT',
  ADD_SELSET:'ADD_SELSET', ADD_SEARCHSET:'ADD_SEARCHSET',
  ADD_ASSIGN_RULE:'ADD_ASSIGN_RULE', MERGE_CHANGELOG:'MERGE_CHANGELOG',
  MERGE_COMMENTS:'MERGE_COMMENTS'
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
  // per-project rule maps a file lacks start empty (never the previously open project's)
  assert.deepEqual(emitted, [{t:'UPD_RULES',u:{disciplineMatrix:{},matrixRules:{},toleranceByTypePair:{},roleChoices:{}}}]);
});

// Bug 9: comments were never included in the serialized project file, so
// reopening a saved project silently dropped every comment thread.
test('serialization includes comments, and restore round-trips them via MERGE_COMMENTS', () => {
  const out = codec.serializeProject(state({comments:[{id:'c1',text:'hello',ts:1}]}), 'v', 't');
  assert.deepEqual(out.comments, [{id:'c1',text:'hello',ts:1}]);

  const emitted = [];
  codec.restoreProject(out, (action)=>emitted.push(action), actions);
  const mergeComments = emitted.find((action)=>action.t==='MERGE_COMMENTS');
  assert.ok(mergeComments, 'expected a MERGE_COMMENTS dispatch on restore');
  assert.deepEqual(mergeComments.v, [{id:'c1',text:'hello',ts:1}]);
});

test('restore never dispatches MERGE_COMMENTS when there are no comments', () => {
  const out = codec.serializeProject(state(), 'v', 't');
  const emitted = [];
  codec.restoreProject(out, (action)=>emitted.push(action), actions);
  assert.equal(emitted.some((action)=>action.t==='MERGE_COMMENTS'), false);
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

test('serializeProject keeps parked models as model stubs (found by the pressure-test harness)', () => {
  const data = codec.serializeProject(state({parkedModels:[{id:'p',name:'Parked',discipline:'architectural',color:'#abcdef',tag:''}]}), '1', 't');
  assert.deepEqual(data.models.map((m)=>m.id), ['m','p']);
  assert.equal(data.models[1].name, 'Parked');
});

test('a project without matrix / tolerance maps does not inherit the open project\'s', () => {
  let rules = { maxGap: 50, matrixRules: { 'mep:structural': { mode: 'clearance', gapMm: 100 } }, toleranceByTypePair: { 'IfcWall|IfcPipeSegment': 20 } };
  const dispatch = (a) => { if (a.t === 'UPD_RULES') rules = Object.assign({}, rules, a.u); };
  codec.restoreProject({ _cc: 'ClashControl', models: [], rules: { maxGap: 25 } }, dispatch, actions);
  assert.equal(rules.maxGap, 25);
  assert.deepEqual(rules.matrixRules, {});
  assert.deepEqual(rules.toleranceByTypePair, {});
  // a file that has them keeps its own
  codec.restoreProject({ _cc: 'ClashControl', models: [], rules: { matrixRules: { 'a:b': { mode: 'off' } } } }, dispatch, actions);
  assert.deepEqual(rules.matrixRules, { 'a:b': { mode: 'off' } });
});

// Run history with breakdowns (clash-history-core.js): old entries (run
// totals only) and new ones (v + byPair / bySeverity / byAssignee / byBucket)
// round-trip through the project file unchanged, side by side.
test('runHistory entries with and without breakdowns round-trip unchanged', () => {
  const H = require('../clash-history-core');
  const old = {ts:1,total:3,open:3,newCount:3,persisting:0,autoResolved:0};
  const cur = H.entry([{id:'a',status:'open',trades:['structural','mep.ventilation'],_delta:'new',assignee:'Ann'}],
    {ts:2,newCount:1,persisting:0,autoResolved:3,issuesResolved:1}, {severity:()=>'major',bucket:()=>'review'});
  const out = JSON.parse(JSON.stringify(codec.serializeProject(state({runHistory:[old,cur]}), 'v', 't')));
  assert.deepEqual(out.runHistory, [old, cur]);
  const emitted = [];
  codec.restoreProject(out, (action)=>emitted.push(action), actions);
  const lp = emitted.find((action)=>action.t==='LOAD_PROJECT_STATE');
  assert.deepEqual(lp.data.runHistory, [old, cur]);
  assert.equal(H.hasBreakdown(lp.data.runHistory[0]), false);
  assert.equal(H.hasBreakdown(lp.data.runHistory[1]), true);
  assert.deepEqual(H.series(lp.data.runHistory, 'pair', 'mep.ventilation × structural'), [null, {total:1,open:1,new:1,resolved:0}]);
  assert.deepEqual(H.runSeries(lp.data.runHistory).map((r)=>r.total), [3, 1]);
});

test('property rules round-trip through the project file; an older file restores none', () => {
  const rules = [
    {id:'pr1', appliesTo:['IfcWall'], prop:'Pset_WallCommon.FireRating', op:'exists', value:'', severity:'critical', stage:'Stage 2', enabled:true},
    {id:'pr2', appliesTo:[], prop:'Pset_SlabCommon.Width', op:'gte', value:'200 mm', severity:'minor', stage:'', enabled:false},
  ];
  const out = JSON.parse(JSON.stringify(codec.serializeProject(state({propertyRules:rules}), 'v', 't')));
  assert.deepEqual(out.propertyRules, rules);
  const acts = Object.assign({}, actions, {SET_PROPERTY_RULES:'SET_PROPERTY_RULES'});
  const seen = [];
  codec.restoreProject(out, (a)=>seen.push(a), acts);
  const set = seen.filter((a)=>a.t==='SET_PROPERTY_RULES');
  assert.equal(set.length, 1);
  assert.deepEqual(set[0].v, rules);
  const old = codec.serializeProject(state(), 'v', 't');
  delete old.propertyRules;
  const seen2 = [];
  codec.restoreProject(JSON.parse(JSON.stringify(old)), (a)=>seen2.push(a), acts);
  assert.deepEqual(seen2.find((a)=>a.t==='SET_PROPERTY_RULES').v, []);
  assert.deepEqual(codec.serializeProject(state(), 'v', 't').propertyRules, []);
});
