// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashIdentityCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function computeClashPair(clash) {
    function elemId(uniqueId, globalId, expressId) {
      return uniqueId ? ('u:' + uniqueId) :
        (globalId && globalId !== '' ? globalId : ('eid:' + expressId));
    }
    var idA = elemId(clash.uniqueIdA, clash.globalIdA, clash.elemA);
    var idB = elemId(clash.uniqueIdB, clash.globalIdB, clash.elemB);
    return idA < idB ? idA + '|' + idB : idB + '|' + idA;
  }

  function computeClashIdentityKey(clash) {
    var pair = computeClashPair(clash);
    var point = clash.point || [0, 0, 0];
    var gx = Math.round(point[0] / 0.5);
    var gy = Math.round(point[1] / 0.5);
    var gz = Math.round(point[2] / 0.5);
    return pair + '@' + gx + ',' + gy + ',' + gz;
  }

  // The identity a clash had before UniqueIds were preferred (GlobalIds +
  // point) — what old shared records carry. Only a clash with a GlobalId
  // pair has one; null when it equals the current key.
  function computeGlobalIdKey(clash) {
    if (!clash || !clash.globalIdA || !clash.globalIdB) return null;
    var k = computeClashIdentityKey({ globalIdA: clash.globalIdA, globalIdB: clash.globalIdB, point: clash.point });
    return k === computeClashIdentityKey(clash) ? null : k;
  }

  return Object.freeze({
    contractVersion: 1,
    computeClashPair: computeClashPair,
    computeClashIdentityKey: computeClashIdentityKey,
    computeGlobalIdKey: computeGlobalIdKey
  });
}));
