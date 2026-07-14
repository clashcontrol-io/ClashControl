'use strict';

// Incident regression lock for PR #650: reconnect scheduling must have exactly
// one live timer and must not schedule while a WebSocket attempt is in flight.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'addons', 'revit-bridge.js'), 'utf8');
const start = source.indexOf('function _scheduleReconnect() {');
const end = source.indexOf('  function _resetReconnectDelay() {', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const scheduleSource = source.slice(start, end);

function harness(opts) {
  opts = opts || {};
  const timers = new Map();
  let nextTimer = 1;
  const cleared = [];
  const connects = [];
  const actions = [];
  const deps = {
    disconnected: !!opts.disconnected,
    ws: opts.ws || null,
    dispatch: opts.dispatch === false ? null : (a) => actions.push(a),
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { cleared.push(id); timers.delete(id); },
    connect(port, dispatch) { connects.push({ port, dispatch }); },
  };
  const api = new Function('deps', `
    var _revitUserDisconnected = deps.disconnected;
    var _revitLastDispatch = deps.dispatch;
    var _revitReconnect = null;
    var _revitReconnectDelay = 0;
    var _revitWs = deps.ws;
    var _revitLastPort = 19780;
    var setTimeout = deps.setTimeout;
    var clearTimeout = deps.clearTimeout;
    var _revitDirectConnect = deps.connect;
    ${scheduleSource}
    return {
      schedule: _scheduleReconnect,
      state: function(){ return { timer:_revitReconnect, delay:_revitReconnectDelay }; }
    };
  `)(deps);
  return { api, timers, cleared, connects, actions };
}

test('a second reconnect schedule cancels the first timer instead of multiplying chains', () => {
  const h = harness();
  h.api.schedule();
  const first = h.api.state().timer;
  h.api.schedule();
  const second = h.api.state().timer;

  assert.notEqual(first, second);
  assert.ok(h.cleared.includes(first));
  assert.equal(h.timers.size, 1);
  assert.ok(h.timers.has(second));

  h.timers.get(second).fn();
  assert.equal(h.connects.length, 1);
  assert.equal(h.connects[0].port, 19780);
});

test('no reconnect timer is created while a socket is connecting or open', () => {
  const h = harness({ ws: { readyState: 0 } });
  h.api.schedule();
  assert.equal(h.timers.size, 0);
});

test('a user-disconnected bridge never starts an automatic reconnect chain', () => {
  const h = harness({ disconnected: true });
  h.api.schedule();
  assert.equal(h.timers.size, 0);
  assert.equal(h.actions.length, 0);
});

test('superseded WebSocket handlers are detached and stale callbacks are ignored', () => {
  assert.match(source, /_revitWs\.onopen\s*=\s*_revitWs\.onclose\s*=\s*_revitWs\.onerror\s*=\s*_revitWs\.onmessage\s*=\s*null/);
  assert.match(source, /ws\.onclose\s*=\s*function\(\)\s*\{[\s\S]*?if \(_revitWs !== ws\) return;/);
  assert.match(source, /ws\.onerror\s*=\s*function\(\)\s*\{[\s\S]*?if \(_revitWs !== ws\) return;/);
});
