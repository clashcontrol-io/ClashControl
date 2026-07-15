'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../clash-reconciliation-core');
const identity = require('../clash-identity-core');

function clash(id, a, b, point, extra) {
  return Object.assign({
    id, uniqueIdA:a, uniqueIdB:b, point:point || [0,0,0],
    distance:-10, status:'open'
  }, extra || {});
}
function deps(extra) {
  return Object.assign({
    computeClashIdentityKey:identity.computeClashIdentityKey,
    computeClashPair:identity.computeClashPair,
    isDeniedClash:()=>false,
    now:1700000000000,
  }, extra || {});
}

test('reconciliation core is immutable and keeps the established cap', () => {
  assert.equal(core.contractVersion, 1);
  assert.equal(core.autoResolveCap, 200);
  assert.equal(Object.isFrozen(core), true);
  assert.equal(typeof core.mergeDetectionResults, 'function');
});

test('first run filters denied clashes and numbers the survivors', () => {
  const denied = clash('denied','a','b',[0,0,0]);
  const kept = clash('kept','c','d',[1,0,0]);
  const out = core.mergeDetectionResults([denied,kept], [], deps({isDeniedClash:(c)=>c===denied}));
  assert.equal(out.clashes.length, 1);
  assert.equal(out.clashes[0].id, 'kept');
  assert.equal(out.clashes[0]._delta, 'new');
  assert.equal(out.clashes[0].number, 1);
  assert.equal(out.clashes[0]._firstSeen, 1700000000000);
  assert.deepEqual(out.deltaSummary, {newCount:1,persisting:0,autoResolved:0,ts:1700000000000});
});

test('persisting clash preserves every human and AI review field', () => {
  const prev = clash('stable','a','b',[1,2,3],{
    number:9,_firstSeen:100,_runCount:4,status:'in_progress',assignee:'jane',priority:'high',
    aiSignals:{x:1},aiFeedback:'yes',aiReasons:['r'],aiResolution:'move',aiNote:'note',
    aiSeverity:'major',aiCategory:'coordination',aiReason:'reason',_clusterGroup:'C-01',
    _clusterSize:3,clashTypeConfirmed:true,linkedIssueId:'issue-1'
  });
  const out = core.mergeDetectionResults([clash('temporary','a','b',[1,2,3],{distance:-20})], [prev], deps()).clashes[0];
  assert.equal(out.id, 'stable');
  assert.equal(out.number, 9);
  assert.equal(out._delta, 'persisting');
  assert.equal(out._firstSeen, 100);
  assert.equal(out._runCount, 5);
  assert.equal(out._prevDepth, -10);
  assert.deepEqual(out._prevPoint, [1,2,3]);
  for (const key of ['status','assignee','priority','aiSignals','aiFeedback','aiReasons','aiResolution','aiNote','aiSeverity','aiCategory','aiReason','_clusterGroup','_clusterSize','clashTypeConfirmed','linkedIssueId']) {
    assert.deepEqual(out[key], prev[key], key + ' must survive');
  }
});

test('an auto-resolved clash reopens when the same identity returns', () => {
  const prev = clash('stable','a','b',[0,0,0],{status:'auto_resolved'});
  const out = core.mergeDetectionResults([clash('fresh','a','b',[0,0,0])], [prev], deps()).clashes[0];
  assert.equal(out.status, 'open');
  assert.equal(out._delta, 'persisting');
});

test('adjacent 0.5m buckets reconcile only within 300mm', () => {
  const prev = clash('stable','a','b',[0.24,0,0],{number:4});
  const near = core.mergeDetectionResults([clash('near','a','b',[0.26,0,0])], [prev], deps());
  assert.equal(near.clashes[0].id, 'stable');
  assert.equal(near.clashes[0]._delta, 'persisting');

  const far = core.mergeDetectionResults([clash('far','a','b',[0.74,0,0])], [prev], deps());
  assert.equal(far.clashes.find((c)=>c.id==='far')._delta, 'new');
  assert.equal(far.clashes.find((c)=>c.id==='stable')._delta, 'auto_resolved');
});

test('cached identity keys are ignored and recomputed after an identity migration', () => {
  const prev = clash('stable','a','b',[0,0,0],{_identityKey:'obsolete-scheme'});
  const out = core.mergeDetectionResults([clash('fresh','a','b',[0,0,0])], [prev], deps());
  assert.equal(out.clashes.length, 1);
  assert.equal(out.clashes[0].id, 'stable');
  assert.equal(out.clashes[0]._delta, 'persisting');
});

test('auto-resolve records cap at 200 while the summary counts all overflow', () => {
  const prev = Array.from({length:205}, (_, i) => clash('p'+i,'a'+i,'b'+i,[i,0,0],{number:i+1}));
  const out = core.mergeDetectionResults([], prev, deps());
  assert.equal(out.clashes.length, 200);
  assert.equal(out.deltaSummary.autoResolved, 205);
  assert.equal(out.deltaSummary.autoResolvedTruncated, 5);
});

test('stable numbers are reused and new clashes fill the lowest gaps', () => {
  const prev = [
    clash('one','a','b',[0,0,0],{number:1}),
    clash('three','c','d',[1,0,0],{number:3}),
  ];
  const next = [
    clash('new-one','a','b',[0,0,0]),
    clash('new-three','c','d',[1,0,0]),
    clash('brand-new','e','f',[2,0,0]),
  ];
  const out = core.mergeDetectionResults(next, prev, deps()).clashes;
  assert.equal(out.find((c)=>c.id==='one').number, 1);
  assert.equal(out.find((c)=>c.id==='three').number, 3);
  assert.equal(out.find((c)=>c.id==='brand-new').number, 2);
});
