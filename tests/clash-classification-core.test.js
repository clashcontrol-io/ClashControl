'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../clash-classification-core');

function clash(id, extra) {
  return Object.assign({
    id, type:'hard', elemAType:'IfcDuctSegment', elemBType:'IfcBeam',
    disciplines:['MEP','Structural'], point:[0,0,0], elemAStorey:'L1'
  }, extra || {});
}

test('classification core is an immutable one-function contract', () => {
  assert.equal(core.contractVersion, 1);
  assert.equal(Object.isFrozen(core), true);
  assert.equal(typeof core.classifyClashes, 'function');
});

test('classification mutates the supplied records and returns undefined', () => {
  const input = [clash('c')];
  const record = input[0];
  assert.equal(core.classifyClashes(input), undefined);
  assert.equal(input[0], record);
  assert.equal(record.aiSeverity, 'critical');
});

test('opening/space and extreme size-ratio pairs remain false positives', () => {
  const items = [
    clash('opening',{elemAType:'IfcOpeningElement'}),
    clash('space',{elemBType:'PrefixIfcSpaceSuffix'}),
    clash('ratio',{_trainFV:{size_ratio:50.6}}),
  ];
  core.classifyClashes(items);
  for (const item of items) {
    assert.equal(item.aiSeverity, 'info');
    assert.equal(item.aiCategory, 'false_positive');
  }
  assert.match(items[2].aiReason, /51:1/);
});

test('duplicates and soft-clearance boundary preserve their categories', () => {
  const duplicate = clash('duplicate',{type:'duplicate'});
  const near = clash('near',{type:'soft',clearanceMm:24});
  const boundary = clash('boundary',{type:'soft',clearanceMm:25});
  core.classifyClashes([duplicate,near,boundary]);
  assert.deepEqual([duplicate.aiSeverity,duplicate.aiCategory], ['info','duplicate']);
  assert.deepEqual([near.aiSeverity,near.aiCategory], ['major','clearance']);
  assert.deepEqual([boundary.aiSeverity,boundary.aiCategory], ['minor','clearance']);
  assert.match(near.aiReason, /cross-discipline/);
});

test('structural, cross-discipline and same-discipline hard paths stay distinct', () => {
  const structural = clash('structural');
  const cross = clash('cross',{disciplines:['MEP','Civil']});
  const same = clash('same',{disciplines:['MEP','MEP']});
  core.classifyClashes([structural,cross,same]);
  assert.deepEqual([structural.aiSeverity,structural.aiCategory], ['critical','penetration']);
  assert.deepEqual([cross.aiSeverity,cross.aiCategory], ['major','penetration']);
  assert.deepEqual([same.aiSeverity,same.aiCategory], ['minor','penetration']);
});

test('insulation downgrades critical and preclassified records remain untouched', () => {
  const insulation = clash('insulation',{_trainFV:{mat_cat_b:'insulation'}});
  const prior = clash('prior',{aiSeverity:'info',aiCategory:'manual',aiReason:'human decision'});
  core.classifyClashes([insulation,prior]);
  assert.deepEqual([insulation.aiSeverity,insulation.aiCategory], ['major','needs_review']);
  assert.match(insulation.aiReason, /insulation involved/);
  assert.deepEqual([prior.aiSeverity,prior.aiCategory,prior.aiReason], ['info','manual','human decision']);
});

test('clustering requires ordered type pair, storey and distance at most 500mm', () => {
  const items = [
    clash('a',{point:[0,0,0]}),
    clash('b',{point:[0.5,0,0]}),
    clash('too-far',{point:[0.5001,0,0]}),
    clash('other-storey',{point:[0.1,0,0],elemAStorey:'L2'}),
    clash('reversed',{point:[0.1,0,0],elemAType:'IfcBeam',elemBType:'IfcDuctSegment'}),
  ];
  core.classifyClashes(items);
  assert.equal(items[0]._clusterGroup, 1);
  assert.equal(items[1]._clusterGroup, 1);
  assert.equal(items[0]._clusterSize, 2);
  assert.equal(items[2]._clusterGroup, undefined);
  assert.equal(items[3]._clusterGroup, undefined);
  assert.equal(items[4]._clusterGroup, undefined);
});

test('legacy clustering is anchor-based rather than transitively chained', () => {
  const items = [
    clash('a',{point:[0,0,0]}),
    clash('b',{point:[0.4,0,0]}),
    clash('c',{point:[0.8,0,0]}),
  ];
  core.classifyClashes(items);
  assert.equal(items[0]._clusterGroup, 1);
  assert.equal(items[1]._clusterGroup, 1);
  assert.equal(items[2]._clusterGroup, undefined);
});

test('spatial-hash clustering still groups across 500mm cell boundaries', () => {
  // 0.49 and 0.51 land in different Math.floor(x/0.5) cells but are 20mm
  // apart — the 27-neighbour scan must still cluster them.
  const items = [
    clash('left',{point:[0.49,0,0]}),
    clash('right',{point:[0.51,0,0]}),
  ];
  core.classifyClashes(items);
  assert.equal(items[0]._clusterGroup, 1);
  assert.equal(items[1]._clusterGroup, 1);
  assert.equal(items[0]._clusterSize, 2);
});

test('spatial-hash clustering never groups same-cell points beyond 500mm', () => {
  // Same 0.5m cell (both floor to 0,0,0) but Euclidean distance ≈ 636mm —
  // the distance check, not the bucket, must decide.
  const items = [
    clash('origin',{point:[0.01,0.01,0]}),
    clash('corner',{point:[0.46,0.46,0]}),
  ];
  core.classifyClashes(items);
  assert.equal(items[0]._clusterGroup, undefined);
  assert.equal(items[1]._clusterGroup, undefined);
});

test('structural detection is case-insensitive — lowercase IFC disciplines still go critical', () => {
  // Regression: the IFC discipline classifier yields lowercase 'structural',
  // but the check used to compare against capital 'Structural', so structural
  // penetrations from IFC models were silently downgraded to 'major'.
  const lower = clash('lower', { disciplines: ['mep', 'structural'] });
  const upper = clash('upper', { disciplines: ['MEP', 'Structural'] });
  core.classifyClashes([lower, upper]);
  assert.deepEqual([lower.aiSeverity, lower.aiCategory], ['critical', 'penetration']);
  assert.deepEqual([upper.aiSeverity, upper.aiCategory], ['critical', 'penetration']);
  assert.match(lower.aiReason, /penetrating primary structure/);
});
