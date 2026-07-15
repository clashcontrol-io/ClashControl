'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../clash-identity-core');

function clash(overrides) {
  return Object.assign({
    uniqueIdA:'revit-a', uniqueIdB:'revit-b',
    globalIdA:'ifc-a', globalIdB:'ifc-b', elemA:1, elemB:2,
    point:[1, 2, 3]
  }, overrides);
}

test('identity core is an immutable two-function contract', () => {
  assert.equal(core.contractVersion, 1);
  assert.equal(Object.isFrozen(core), true);
  assert.equal(typeof core.computeClashPair, 'function');
  assert.equal(typeof core.computeClashIdentityKey, 'function');
});

test('UniqueId wins over GlobalId and expressId', () => {
  assert.equal(core.computeClashPair(clash()), 'u:revit-a|u:revit-b');
  assert.equal(core.computeClashPair(clash({
    uniqueIdA:'revit-z', uniqueIdB:'revit-a',
    globalIdA:'aaa', globalIdB:'zzz', elemA:1, elemB:2
  })), 'u:revit-a|u:revit-z');
});

test('GlobalId then expressId remain the exact fallbacks', () => {
  assert.equal(core.computeClashPair(clash({
    uniqueIdA:null, uniqueIdB:'', globalIdA:'z-guid', globalIdB:'a-guid'
  })), 'a-guid|z-guid');
  assert.equal(core.computeClashPair(clash({
    uniqueIdA:null, uniqueIdB:null, globalIdA:'', globalIdB:null, elemA:41, elemB:7
  })), 'eid:41|eid:7');
});

test('endpoint order never changes pair or location identity', () => {
  const a = clash({uniqueIdA:'z',uniqueIdB:'a',point:[1.1,2.2,3.3]});
  const b = clash({uniqueIdA:'a',uniqueIdB:'z',globalIdA:'ifc-b',globalIdB:'ifc-a',elemA:2,elemB:1,point:[1.1,2.2,3.3]});
  assert.equal(core.computeClashPair(a), core.computeClashPair(b));
  assert.equal(core.computeClashIdentityKey(a), core.computeClashIdentityKey(b));
});

test('location identity keeps the established 0.5 metre rounded bucket', () => {
  assert.equal(core.computeClashIdentityKey(clash({point:[0.24,0.25,0.26]})), 'u:revit-a|u:revit-b@0,1,1');
  assert.equal(core.computeClashIdentityKey(clash({point:[-0.25,-0.26,0]})), 'u:revit-a|u:revit-b@0,-1,0');
  assert.equal(core.computeClashIdentityKey(clash({point:null})), 'u:revit-a|u:revit-b@0,0,0');
});
