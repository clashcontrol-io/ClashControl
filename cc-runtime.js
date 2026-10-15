// @ts-check
(function(/** @type {any} */ root, factory) {
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

  // Pairing client for the localhost bridges (local engine, Revit Connector,
  // Smart Bridge). Each bridge only serves the ClashControl origin and hands
  // out a short-lived token from POST /pair; this wraps that handshake.
  //
  //   ensure(base)      -> Promise<token|null>  (null = server predates pairing)
  //   fetch(base, path, init) -> fetch with the token; re-pairs once on a 401
  //   wsUrl(url, pairBase?) -> Promise<url + ?cc_token=...> (browsers can't set WS headers)
  //
  // Old servers answer /pair with 404/405: we then send NO token and NO custom
  // header, so a not-yet-updated binary keeps working exactly as before.
  function createBridgePairing(options) {
    options = options || {};
    var doFetch = options.fetch || function() { return root.fetch.apply(root, arguments); };
    var now = options.now || Date.now;
    var warn = options.warn || function(msg) { try { console.warn(msg); } catch (_) {} };
    var SKEW_MS = 60000;           // re-pair a minute before the server would expire it
    var cache = Object.create(null);     // base -> {token, exp} | {legacy:true, at}
    var inflight = Object.create(null);  // base -> Promise (single-flight)
    var LEGACY_RECHECK_MS = 30000;
    var warned = false;

    function baseOf(url) {
      var m = /^(?:https?|wss?):\/\/[^/?#]+/i.exec(String(url));
      return m ? m[0].replace(/^ws/i, 'http') : String(url);
    }

    function ensure(base) {
      base = baseOf(base);
      var c = cache[base];
      if (c) {
        if (c.legacy && now() - c.at < LEGACY_RECHECK_MS) return Promise.resolve(null);
        if (c.token && c.refreshAt > now()) return Promise.resolve(c.token);
      }
      if (inflight[base]) return inflight[base];
      var pairInit = {method: 'POST', cache: 'no-store'};
      // A wedged bridge must not hang callers (and their reconnect loops) forever.
      try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) pairInit.signal = AbortSignal.timeout(5000); } catch (_) {}
      var p = Promise.resolve(doFetch(base + '/pair', pairInit))
        .then(function(r) {
          if (r.status === 404 || r.status === 405 || r.status === 501) {
            cache[base] = {legacy: true, at: now()};
            return null;
          }
          if (r.status === 403) {
            if (!warned) {
              warned = true;
              warn('[ClashControl] The local bridge at ' + base + ' refused this page\'s origin. ' +
                   'Only https://www.clashcontrol.io is allowed by default; for self-hosting or ' +
                   'development add the origin to the bridge\'s allowed-origins setting.');
            }
            return null;
          }
          if (!r.ok) throw new Error('pairing failed: HTTP ' + r.status);
          return r.json().then(function(j) {
            if (!j || !j.token) throw new Error('pairing failed: no token');
            var ttlMs = (Number(j.expiresIn) || 3600) * 1000;
            // Refresh shortly before expiry; never by more than a tenth of the lifetime.
            cache[base] = {token: j.token, refreshAt: now() + ttlMs - Math.min(SKEW_MS, ttlMs / 10)};
            return j.token;
          });
        });
      inflight[base] = p;
      var clear = function() { if (inflight[base] === p) delete inflight[base]; };
      p.then(clear, clear);
      return p;
    }

    function withToken(init, token) {
      init = Object.assign({}, init || {});
      if (!token) return init;
      var h = init.headers;
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        var copy = {};
        h.forEach(function(v, k) { copy[k] = v; });
        h = copy;
      }
      init.headers = Object.assign({}, h || {}, {'X-CC-Pairing-Token': token});
      return init;
    }

    // Pairing must never make things worse than no pairing. A server that
    // predates it may answer the unknown POST /pair with a bare 404 that carries
    // no CORS headers - which a browser surfaces as a network error, not a 404.
    // So when pairing fails, fall back to the original, untokened request: it
    // behaves exactly as before (and fails the same way if the bridge is down).
    function safeEnsure(base) {
      return ensure(base).catch(function() { return null; });
    }

    function pairedFetch(base, path, init) {
      base = baseOf(base);
      return safeEnsure(base).then(function(token) {
        return doFetch(base + path, withToken(init, token)).then(function(r) {
          if (r.status !== 401) return r;
          // Token expired, the bridge restarted, or it was upgraded in place and
          // now wants one: pair again and retry once.
          delete cache[base];
          return safeEnsure(base).then(function(t2) {
            return t2 ? doFetch(base + path, withToken(init, t2)) : r;
          });
        });
      });
    }

    // `pairBase` is the HTTP origin that serves /pair. It defaults to the WS URL's
    // own host:port (the Revit Connector serves both there), but the local engine
    // and Smart Bridge run their WebSocket on a different port from their HTTP API.
    function wsUrl(url, pairBase) {
      return safeEnsure(pairBase || url).then(function(token) {
        if (!token) return url;
        return url + (String(url).indexOf('?') === -1 ? '?' : '&') + 'cc_token=' + encodeURIComponent(token);
      });
    }

    return Object.freeze({
      ensure: ensure,
      fetch: pairedFetch,
      wsUrl: wsUrl,
      reset: function(base) { if (base) delete cache[baseOf(base)]; else cache = Object.create(null); }
    });
  }

  var services = createRegistry();
  return Object.freeze({
    contractVersion:1,
    services:services,
    createRegistry:createRegistry,
    createScriptLoader:createScriptLoader,
    createLoadCoordinator:createLoadCoordinator,
    createBridgePairing:createBridgePairing
  });
}));
