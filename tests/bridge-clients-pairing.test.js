'use strict';

// The browser addons must open their bridge WebSocket only AFTER pairing (token
// in the URL), fall back to a plain connect if pairing itself fails, and never
// open a stale / duplicate socket when connects overlap or the user disconnects
// mid-handshake. Runs the real function source from the addons against fakes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function slice(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, startMarker + ' not found');
  const b = src.indexOf(endMarker, a);
  assert.notEqual(b, -1, endMarker + ' not found');
  return src.slice(a, b);
}

// Pairing fake whose wsUrl resolution the test controls.
function fakePairing() {
  const calls = [];
  const pending = [];
  return {
    calls,
    bases: [],
    pairing: {
      wsUrl(url) {
        calls.push(url);
        return new Promise((resolve, reject) => { pending.push({ resolve, reject, url }); });
      },
    },
    finish(token) { pending.splice(0).forEach((p) => p.resolve(p.url + '?cc_token=' + token)); },
    fail() { pending.splice(0).forEach((p) => p.reject(new Error('bridge down'))); },
  };
}

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; FakeWS.instances.push(this); }
  close() { this.readyState = 3; }
  send() {}
}
FakeWS.instances = [];
const tick = () => new Promise((r) => setImmediate(r));

// ── Revit ────────────────────────────────────────────────────────────────────
const revitSrc = read('addons/revit-bridge.js');
const revitConnectSrc = slice(revitSrc, 'function _revitDirectConnect(port, d) {', '  function _revitDirectDisconnect(d) {');

function revitHarness(fp) {
  FakeWS.instances = [];
  const logs = [];
  const api = new Function('fp', 'FakeWS', 'logs', `
    var window = { _ccRuntime: null };
    var _i18n = function(k, en, v){ return v ? en.replace(/\{(\w+)\}/g, function(m, n){ return n in v ? v[n] : m; }) : en; };
    var WebSocket = FakeWS;
    var _revitPairing = fp ? fp.pairing : null;
    var _revitConnectAttempt = 0;
    var _revitWs = null, _revitLastPort = 19780, _revitLastDispatch = null;
    var _revitUserDisconnected = false, _revitReconnect = null, _revitConnectTimeout = null;
    var _revitHosts = ['127.0.0.1', '[::1]'], _revitHostIdx = 0;
    var _revitReconnectDelay = 0, CONNECT_TIMEOUT_MS = 15000, _pullOnConnect = false;
    var _elementHashCache = {}, _revitBuf = null;
    var _scheduleReconnect = function(){ logs.push('reconnect'); };
    var _resetReconnectDelay = function(){};
    var _revitLoadingEvent = function(){};
    var _handleRevitMessage = function(){};
    var _revitDirectExport = function(){};
    ${revitConnectSrc}
    return {
      connect: _revitDirectConnect,
      ws: function(){ return _revitWs; },
      userDisconnect: function(){ _revitUserDisconnected = true; }
    };
  `)(fp, FakeWS, logs);
  return { api, logs };
}

const noop = () => {};

test('revit: socket opens only after pairing resolves, with the token in the URL', async () => {
  const fp = fakePairing();
  const h = revitHarness(fp);
  h.api.connect(19780, noop);
  assert.strictEqual(FakeWS.instances.length, 0, 'no socket before pairing completes');
  assert.deepStrictEqual(fp.calls, ['ws://127.0.0.1:19780']);
  fp.finish('TOK');
  await tick();
  assert.strictEqual(FakeWS.instances.length, 1);
  assert.strictEqual(FakeWS.instances[0].url, 'ws://127.0.0.1:19780?cc_token=TOK');
  assert.strictEqual(h.api.ws(), FakeWS.instances[0]);
});

test('revit: the token is never written to the connection log', async () => {
  const fp = fakePairing();
  const lines = [];
  const h = revitHarness(fp);
  h.api.connect(19780, (a) => { if (a.text) lines.push(a.text); });
  fp.finish('SECRET-TOKEN');
  await tick();
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => !l.includes('SECRET-TOKEN')));
});

test('revit: if pairing fails the plain URL is still attempted (existing error/backoff handling)', async () => {
  const fp = fakePairing();
  const h = revitHarness(fp);
  h.api.connect(19780, noop);
  fp.fail();
  await tick();
  assert.strictEqual(FakeWS.instances.length, 1);
  assert.strictEqual(FakeWS.instances[0].url, 'ws://127.0.0.1:19780');
});

test('revit: no pairing helper available -> behaves exactly as before', async () => {
  const h = revitHarness(null);
  h.api.connect(19780, noop);
  await tick();
  assert.strictEqual(FakeWS.instances.length, 1);
  assert.strictEqual(FakeWS.instances[0].url, 'ws://127.0.0.1:19780');
});

test('revit: overlapping connects open exactly one socket (the latest)', async () => {
  // Two independent pairing promises, resolved out of order.
  const resolvers = [];
  const fp = { calls: [], pairing: { wsUrl(url) { return new Promise((res) => resolvers.push(() => res(url + '?cc_token=T' + resolvers.length))); } } };
  const h = revitHarness(fp);
  h.api.connect(19780, noop);   // first click
  h.api.connect(19780, noop);   // impatient second click
  resolvers[1]();               // latest pairing finishes first
  resolvers[0]();               // stale one finishes later
  await tick();
  assert.strictEqual(FakeWS.instances.length, 1, 'stale attempt must not open a second socket');
});

test('revit: user disconnecting during the handshake cancels the pending socket', async () => {
  const fp = fakePairing();
  const h = revitHarness(fp);
  h.api.connect(19780, noop);
  h.api.userDisconnect();
  fp.finish('TOK');
  await tick();
  assert.strictEqual(FakeWS.instances.length, 0);
});

// ── Smart Bridge ─────────────────────────────────────────────────────────────
const sbSrc = read('addons/smart-bridge.js');
const sbConnectSrc = slice(sbSrc, '  var _wsPairing = false;', '    _ws.onopen = function() {');

const sbPairingSrc = slice(sbSrc, '  var _pairing = (window._ccRuntime', '  window._ccSmartBridgeFetch = _sbFetch;');

function sbHarness(fp) {
  FakeWS.instances = [];
  const api = new Function('fp', 'FakeWS', `
    var WebSocket = FakeWS;
    var window = { _ccRuntime: { createBridgePairing: function(){ return {
      wsUrl: function(url, base){ fp.bases.push(base); return fp.pairing.wsUrl(url); },
      fetch: function(){ return Promise.resolve(); }
    }; } } };
    var _ws = null, _wsGen = 0;
    var _sbHosts = ['127.0.0.1'], _sbHostIdx = 0;
    function _wsUrl()   { return 'ws://'   + _sbHosts[_sbHostIdx] + ':19802'; }
    function _restUrl() { return 'http://' + _sbHosts[_sbHostIdx] + ':19803'; }
    ${sbPairingSrc}
    ${sbConnectSrc}
      // (handlers elided: only socket creation is under test)
    }
    return {
      connect: _connectWs,
      ws: function(){ return _ws; },
      disconnect: function(){ _wsGen++; }
    };
  `)(fp, FakeWS);
  return api;
}

test('smart-bridge: socket opens after pairing with the token in the URL', async () => {
  const fp = fakePairing();
  const api = sbHarness(fp);
  api.connect(noop);
  assert.strictEqual(FakeWS.instances.length, 0);
  fp.finish('T');
  await tick();
  assert.strictEqual(FakeWS.instances.length, 1);
  assert.strictEqual(FakeWS.instances[0].url, 'ws://127.0.0.1:19802?cc_token=T');
});

test('smart-bridge: pairs against the REST port, not the WebSocket port', async () => {
  const fp = fakePairing();
  const api = sbHarness(fp);
  api.connect(noop);
  fp.finish('T');
  await tick();
  assert.deepStrictEqual(fp.bases, ['http://127.0.0.1:19803']);
  assert.strictEqual(FakeWS.instances[0].url, 'ws://127.0.0.1:19802?cc_token=T');
});

test('smart-bridge: repeated connect calls while pairing do not open extra sockets', async () => {
  const fp = fakePairing();
  const api = sbHarness(fp);
  api.connect(noop); api.connect(noop); api.connect(noop);
  assert.strictEqual(fp.calls.length, 1, 'one handshake in flight, not three');
  fp.finish('T');
  await tick();
  assert.strictEqual(FakeWS.instances.length, 1);
});

test('smart-bridge: pairing failure falls back to the plain URL', async () => {
  const fp = fakePairing();
  const api = sbHarness(fp);
  api.connect(noop);
  fp.fail();
  await tick();
  assert.strictEqual(FakeWS.instances[0].url, 'ws://127.0.0.1:19802');
});

test('smart-bridge: a disconnect during pairing cancels the socket, and a later connect still works', async () => {
  const fp = fakePairing();
  const api = sbHarness(fp);
  api.connect(noop);
  api.disconnect();
  fp.finish('T');
  await tick();
  assert.strictEqual(FakeWS.instances.length, 0);
  api.connect(noop);            // the in-flight guard must have been released
  fp.finish('T2');
  await tick();
  assert.strictEqual(FakeWS.instances.length, 1);
});
