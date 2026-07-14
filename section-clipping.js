(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccSectionClipping = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function eligible(obj) {
    return !!(obj && obj.isMesh && obj.material && obj.userData &&
      (obj.userData.expressId != null || obj.isInstancedMesh || obj.userData._isCCBatch));
  }

  function materials(obj) {
    var out = [];
    function add(value) {
      (Array.isArray(value) ? value : [value]).forEach(function(material) {
        if (material && out.indexOf(material) === -1) out.push(material);
      });
    }
    add(obj.material);
    var styles = obj.userData && obj.userData._styleMats;
    if (styles) Object.keys(styles).forEach(function(key) { add(styles[key]); });
    return out;
  }

  function _assign(material, planes, mode, cached) {
    if (mode === 'clear') {
      if (material.clippingPlanes && material.clippingPlanes.length) {
        material.clippingPlanes = planes;
        material.needsUpdate = true;
      }
      return;
    }
    if (mode === 'box') {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
      return;
    }
    // Existing section-plane semantics: cached styles are only touched while
    // planes exist; the active material is updated when the array identity
    // changes. This exact behavior is the default-off legacy path.
    if (cached && !planes.length) return;
    if (material.clippingPlanes !== planes) {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    }
  }

  function applyLegacy(root, planes, mode) {
    var objects = 0, batches = 0, materialCount = 0;
    root.traverse(function(obj) {
      if (!eligible(obj)) return;
      objects++;
      if (obj.userData._isCCBatch) batches++;
      var active = Array.isArray(obj.material) ? obj.material : [obj.material];
      active.forEach(function(material) { if (material) { materialCount++; _assign(material, planes, mode, false); } });
      var styles = obj.userData._styleMats;
      if (styles) Object.keys(styles).forEach(function(key) {
        (Array.isArray(styles[key]) ? styles[key] : [styles[key]]).forEach(function(material) {
          if (material) { materialCount++; _assign(material, planes, mode, true); }
        });
      });
    });
    return { objects:objects, batches:batches, materials:materialCount };
  }

  function applyCandidate(modelRoot, planes) {
    var objects = 0, batches = 0, batchItems = 0, materialCount = 0;
    modelRoot.traverse(function(obj) {
      if (!eligible(obj)) return;
      objects++;
      if (obj.userData._isCCBatch) {
        batches++;
        batchItems += (obj.userData.batchExprIds || []).filter(function(id){ return id != null; }).length;
      }
      materials(obj).forEach(function(material) {
        materialCount++;
        if (material.clippingPlanes !== planes) {
          material.clippingPlanes = planes;
          material.needsUpdate = true;
        }
      });
    });
    return { objects:objects, batches:batches, batchItems:batchItems, materials:materialCount };
  }

  function verify(modelRoot, planes) {
    var missing = [], checked = 0, batches = 0;
    modelRoot.traverse(function(obj) {
      if (!eligible(obj)) return;
      if (obj.userData._isCCBatch) batches++;
      materials(obj).forEach(function(material, index) {
        checked++;
        if (material.clippingPlanes !== planes) {
          missing.push(String(obj.uuid || obj.userData.expressId || 'mesh') + ':' + index);
        }
      });
    });
    return { equal:missing.length === 0, checked:checked, batches:batches, missing:missing };
  }

  function applyGuarded(options) {
    options = options || {};
    var scene = options.scene;
    var modelRoot = options.modelRoot;
    var planes = options.planes || [];
    var mode = options.mode || 'section';
    if (!options.enabled || !modelRoot) return { path:'legacy', stats:applyLegacy(scene, planes, mode) };
    try {
      var stats = applyCandidate(modelRoot, planes);
      var comparison = verify(modelRoot, planes);
      if (!comparison.equal) {
        if (options.record) options.record({outcome:'mismatch', comparison:comparison});
        return { path:'fallback', stats:applyLegacy(scene, planes, mode), comparison:comparison };
      }
      if (options.record) options.record({outcome:'candidate', stats:stats});
      return { path:'candidate', stats:stats, comparison:comparison };
    } catch (error) {
      if (options.record) options.record({outcome:'fallback', error:String(error && error.message || error)});
      return { path:'fallback', stats:applyLegacy(scene, planes, mode), error:error };
    }
  }

  return Object.freeze({
    eligible: eligible,
    materials: materials,
    applyLegacy: applyLegacy,
    applyCandidate: applyCandidate,
    verify: verify,
    applyGuarded: applyGuarded
  });
}));
