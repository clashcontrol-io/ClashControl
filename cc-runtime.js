(function(root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccRuntime = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  function createRegistry() {
    var values = Object.create(null);
    var versions = Object.create(null);
    return Object.freeze({
      register: function(name, value, options) {
        name = String(name || '');
        if (!name) throw new Error('Service name is required');
        if (Object.prototype.hasOwnProperty.call(values, name) && !(options && options.replace)) {
          throw new Error('Service already registered: ' + name);
        }
        values[name] = value;
        versions[name] = options && options.version != null ? String(options.version) : '1';
        return value;
      },
      get: function(name) { return values[String(name)] || null; },
      require: function(name) {
        var value = values[String(name)];
        if (!value) throw new Error('Required service unavailable: ' + name);
        return value;
      },
      has: function(name) { return Object.prototype.hasOwnProperty.call(values, String(name)); },
      version: function(name) { return versions[String(name)] || null; },
      list: function() { return Object.keys(values).sort(); }
    });
  }

  function createScriptLoader(manifest, options) {
    manifest = manifest || {};
    options = options || {};
    var doc = options.document || root.document || null;
    var states = Object.create(null);
    var promises = Object.create(null);

    function definition(id) {
      var entry = manifest[id];
      if (!entry) throw new Error('Unknown feature: ' + id);
      return typeof entry === 'string' ? {src:entry} : entry;
    }

    function load(id) {
      id = String(id || '');
      if (states[id] === 'loaded') return Promise.resolve(definition(id));
      if (promises[id]) return promises[id];
      var def;
      try { def = definition(id); }
      catch (error) { return Promise.reject(error); }
      if (!doc || !doc.createElement || !doc.head) {
        return Promise.reject(new Error('Script loading requires a document'));
      }
      states[id] = 'loading';
      promises[id] = new Promise(function(resolve, reject) {
        var script = doc.createElement('script');
        script.src = def.src;
        script.async = true;
        script.dataset.ccFeature = id;
        script.onload = function() {
          states[id] = 'loaded';
          delete promises[id];
          resolve(def);
        };
        script.onerror = function() {
          states[id] = 'failed';
          delete promises[id];
          reject(new Error('Failed to load feature: ' + id));
        };
        doc.head.appendChild(script);
      });
      return promises[id];
    }

    return Object.freeze({
      load: load,
      status: function(id) { return states[String(id)] || 'idle'; },
      has: function(id) { return Object.prototype.hasOwnProperty.call(manifest, String(id)); },
      list: function() { return Object.keys(manifest).sort(); }
    });
  }

  function createLoadCoordinator(options) {
    options = options || {};
    var sequence = 0;
    var active = Object.create(null);
    var last = null;

    function emit(batch, event) {
      if (options.emitEvents === false && !options.onChange) return;
      var detail = batch.snapshot();
      detail.event = event;
      if (options.onChange) {
        try { options.onChange(detail); } catch (_) {}
      }
      if (options.emitEvents !== false) {
        try { root.dispatchEvent(new CustomEvent('cc-load-session', {detail:detail})); } catch (_) {}
      }
    }

    function maybeIdle() {
      if (Object.keys(active).length !== 0 || !options.onIdle) return;
      try { options.onIdle(last); } catch (_) {}
    }

    function begin(meta) {
      var id = ++sequence;
      var state = 'active';
      var chainDone = false;
      var holdSequence = 0;
      var holds = Object.create(null);
      var startedAt = Date.now();
      var endedAt = null;

      function snapshot() {
        return {
          id:id,
          state:state,
          meta:meta || null,
          chainDone:chainDone,
          pending:Object.keys(holds).length,
          holds:Object.keys(holds).map(function(key) { return holds[key]; }),
          startedAt:startedAt,
          endedAt:endedAt
        };
      }

      function terminal(next) {
        if (state !== 'active') return false;
        state = next;
        endedAt = Date.now();
        holds = Object.create(null);
        delete active[id];
        last = snapshot();
        emit(batch, next);
        if (options.onBatchComplete) {
          try { options.onBatchComplete(last); } catch (_) {}
        }
        maybeIdle();
        return true;
      }

      function tryComplete() {
        if (state === 'active' && chainDone && Object.keys(holds).length === 0) terminal('complete');
      }

      var batch = Object.freeze({
        id:id,
        hold:function(label) {
          if (state !== 'active') return function() { return false; };
          var token = String(++holdSequence);
          holds[token] = String(label || 'pending');
          emit(batch, 'hold');
          var released = false;
          return function() {
            if (released || state !== 'active') return false;
            released = true;
            delete holds[token];
            emit(batch, 'release');
            tryComplete();
            return true;
          };
        },
        markChainDone:function() {
          if (state !== 'active' || chainDone) return false;
          chainDone = true;
          emit(batch, 'chain-done');
          tryComplete();
          return true;
        },
        fail:function() { return terminal('failed'); },
        cancel:function() { return terminal('cancelled'); },
        snapshot:snapshot
      });
      active[id] = batch;
      emit(batch, 'begin');
      return batch;
    }

    return Object.freeze({
      begin:begin,
      activeCount:function() { return Object.keys(active).length; },
      snapshot:function() {
        return Object.keys(active).map(function(id) { return active[id].snapshot(); });
      },
      last:function() { return last; }
    });
  }

  var services = createRegistry();
  return Object.freeze({
    contractVersion:1,
    services:services,
    createRegistry:createRegistry,
    createScriptLoader:createScriptLoader,
    createLoadCoordinator:createLoadCoordinator
  });
}));
