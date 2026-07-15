(function(root, factory) {
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

  return Object.freeze({
    contractVersion: 1,
    computeClashPair: computeClashPair,
    computeClashIdentityKey: computeClashIdentityKey
  });
}));
