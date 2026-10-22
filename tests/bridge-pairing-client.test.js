'use strict';

// Browser-side pairing helper (cc-runtime.js createBridgePairing) against a
// scripted fake fetch: single-flight pairing, token header, legacy servers,
// expiry, restart recovery, and a bounded retry.
const { test } = require('node:test');
const assert = require('node:assert');

const { createBridgePairing } = require('../cc-runtime.js');

const BASE = 'http://127.0.0.1:19803';

function res(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// A fake bridge. `handlers.pair` / `handlers.other` receive (url, init).
function fakeBridge(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init: init || {} });
    const isPair = /\/pair$/.test(url);
    return (isPair ? handlers.pair : handlers.other)(url, init || {}, calls);
  };
  return { fetch, calls };
}

const tokenOf = (init) => (init.headers || {})['X-CC-Pairing-Token'];

test('pairs once, then reuses the token for every request', async () => {
  let n = 0;
  const b = fakeBridge({
    pair: () => res(200, { token: 'tok' + (++n), expiresIn: 3600 }),
    other: () => res(200, {}),
  });
  const p = createBridgePairing({ fetch: b.fetch });
  await p.fetch(BASE, '/tools');
  await p.fetch(BASE, '/llm-config');
  assert.strictEqual(b.calls.filter((c) => /\/pair$/.test(c.url)).length, 1);
  assert.strictEqual(tokenOf(b.calls[1].init), 'tok1');
  assert.strictEqual(tokenOf(b.calls[2].init), 'tok1');
});

test('concurrent callers share a single /pair request', async () => {
  let n = 0;
  const b = fakeBridge({
    pair: () => res(200, { token: 'tok' + (++n), expiresIn: 3600 }),
    other: () => res(200, {}),
  });
  const p = createBridgePairing({ fetch: b.fetch });
  await Promise.all([p.fetch(BASE, '/a'), p.fetch(BASE, '/b'), p.wsUrl('ws://127.0.0.1:19803')]);
  assert.strictEqual(b.calls.filter((c) => /\/pair$/.test(c.url)).length, 1);
});

test('POST /pair is sent without credentials-bearing or custom headers', async () => {
  const b = fakeBridge({ pair: () => res(200, { token: 't', expiresIn: 60 }), other: () => res(200, {}) });
  await createBridgePairing({ fetch: b.fetch }).fetch(BASE, '/x');
  const pairCall = b.calls[0];
  assert.strictEqual(pairCall.init.method, 'POST');
  assert.strictEqual(pairCall.init.headers, undefined);
});

test('a server that predates pairing (404) gets no token and no custom header', async () => {
  const b = fakeBridge({ pair: () => res(404, {}), other: () => res(200, {}) });
  const p = createBridgePairing({ fetch: b.fetch });
  await p.fetch(BASE, '/status', { method: 'GET' });
  await p.fetch(BASE, '/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  for (const c of b.calls.filter((c) => !/\/pair$/.test(c.url))) {
    assert.strictEqual(tokenOf(c.init), undefined);
  }
  assert.strictEqual(b.calls.filter((c) => /\/pair$/.test(c.url)).length, 1, 'legacy result is cached, not re-probed per request');
  assert.strictEqual(await p.wsUrl('ws://localhost:19801'), 'ws://localhost:19801');
});

test('legacy cache is re-probed later (server may have been upgraded in place)', async () => {
  let t = 0;
  let legacy = true;
  const b = fakeBridge({
    pair: () => (legacy ? res(404, {}) : res(200, { token: 'new', expiresIn: 3600 })),
    other: () => res(200, {}),
  });
  const p = createBridgePairing({ fetch: b.fetch, now: () => t });
  await p.fetch(BASE, '/x');
  legacy = false; t += 31000;
  await p.fetch(BASE, '/x');
  assert.strictEqual(tokenOf(b.calls[b.calls.length - 1].init), 'new');
});

test('401 pairing_required (expired token / bridge restarted) re-pairs and retries exactly once', async () => {
  let pairN = 0, otherN = 0;
  const b = fakeBridge({
    pair: () => res(200, { token: 'tok' + (++pairN), expiresIn: 3600 }),
    other: (url, init) => (++otherN === 1 ? res(401, { code: 'pairing_required' }) : res(200, { ok: true })),
  });
  const p = createBridgePairing({ fetch: b.fetch });
  const r = await p.fetch(BASE, '/chat', { method: 'POST', body: '{}' });
  assert.strictEqual(r.status, 200);
  const sent = b.calls.filter((c) => !/\/pair$/.test(c.url));
  assert.strictEqual(tokenOf(sent[0].init), 'tok1');
  assert.strictEqual(tokenOf(sent[1].init), 'tok2');
  assert.strictEqual(sent[1].init.body, '{}');
});

test('a persistent 401 is returned to the caller, not retried forever', async () => {
  let pairN = 0;
  const b = fakeBridge({
    pair: () => res(200, { token: 'tok' + (++pairN), expiresIn: 3600 }),
    other: () => res(401, { code: 'pairing_required' }),
  });
  const r = await createBridgePairing({ fetch: b.fetch }).fetch(BASE, '/chat');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(b.calls.filter((c) => !/\/pair$/.test(c.url)).length, 2);
});

test('an expiring token is refreshed before use', async () => {
  let t = 0, n = 0;
  const b = fakeBridge({
    pair: () => res(200, { token: 'tok' + (++n), expiresIn: 3600 }),
    other: () => res(200, {}),
  });
  const p = createBridgePairing({ fetch: b.fetch, now: () => t });
  await p.fetch(BASE, '/x');
  t += 3600 * 1000 - 30000;             // inside the 60s skew window
  await p.fetch(BASE, '/x');
  const sent = b.calls.filter((c) => !/\/pair$/.test(c.url));
  assert.strictEqual(tokenOf(sent[0].init), 'tok1');
  assert.strictEqual(tokenOf(sent[1].init), 'tok2');
});

test('origin refused by the bridge (403): warns once, sends the request untokened', async () => {
  const warnings = [];
  const b = fakeBridge({ pair: () => res(403, { code: 'origin_not_allowed' }), other: () => res(403, {}) });
  const p = createBridgePairing({ fetch: b.fetch, warn: (m) => warnings.push(m) });
  const r1 = await p.fetch(BASE, '/x');
  await p.fetch(BASE, '/y');
  assert.strictEqual(r1.status, 403);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /allowed-origins/);
});

test('bridge not running: the request fails exactly as it would without pairing', async () => {
  const p = createBridgePairing({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => p.fetch(BASE, '/x'), /Failed to fetch/);
  // and a later attempt tries again (no poisoned single-flight / no stuck legacy flag)
  let up = false;
  const p2 = createBridgePairing({ fetch: async (u) => { if (!up) throw new TypeError('down'); return /\/pair$/.test(u) ? res(200, { token: 't', expiresIn: 60 }) : res(200, {}); } });
  await assert.rejects(() => p2.fetch(BASE, '/x'));
  up = true;
  assert.strictEqual((await p2.fetch(BASE, '/x')).status, 200);
});

test('old server whose /pair 404 has no CORS headers (browser sees a network error) still works untokened', async () => {
  // Real-world: pre-pairing engine answers unknown POST with a bare 404.
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, init: init || {} });
    if (/\/pair$/.test(url)) throw new TypeError('Failed to fetch');   // CORS-blocked 404
    return res(200, { ok: true });
  };
  const p = createBridgePairing({ fetch });
  const r = await p.fetch(BASE, '/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 200);
  const real = sent.filter((c) => !/\/pair$/.test(c.url));
  assert.strictEqual(real.length, 1);
  assert.strictEqual(tokenOf(real[0].init), undefined, 'no custom header: an old server would reject its preflight');
  assert.strictEqual(await p.wsUrl('ws://127.0.0.1:19801', BASE), 'ws://127.0.0.1:19801');
});

test('a bridge upgraded in place (was untokened, now answers 401) is re-paired automatically', async () => {
  let upgraded = false;
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, init: init || {} });
    if (/\/pair$/.test(url)) return upgraded ? res(200, { token: 'T', expiresIn: 3600 }) : res(404, {});
    return upgraded && !tokenOf(init || {}) ? res(401, { code: 'pairing_required' }) : res(200, {});
  };
  const p = createBridgePairing({ fetch });
  assert.strictEqual((await p.fetch(BASE, '/x')).status, 200);   // legacy, cached as such
  upgraded = true;
  assert.strictEqual((await p.fetch(BASE, '/x')).status, 200);   // 401 -> pair -> retry
});

test('wsUrl appends the token; websocket URLs pair against the http origin', async () => {
  const b = fakeBridge({ pair: () => res(200, { token: 'a b/c', expiresIn: 60 }), other: () => res(200, {}) });
  const p = createBridgePairing({ fetch: b.fetch });
  assert.strictEqual(await p.wsUrl('ws://127.0.0.1:19780'), 'ws://127.0.0.1:19780?cc_token=a%20b%2Fc');
  assert.strictEqual(await p.wsUrl('ws://127.0.0.1:19780/x?y=1'), 'ws://127.0.0.1:19780/x?y=1&cc_token=a%20b%2Fc');
  assert.strictEqual(b.calls[0].url, 'http://127.0.0.1:19780/pair');
});

test('wsUrl pairs against an explicit HTTP base when the socket is on another port', async () => {
  const b = fakeBridge({ pair: () => res(200, { token: 'T', expiresIn: 60 }), other: () => res(200, {}) });
  const p = createBridgePairing({ fetch: b.fetch });
  // Smart Bridge / local engine: HTTP API and WebSocket are different ports.
  assert.strictEqual(await p.wsUrl('ws://127.0.0.1:19802', 'http://127.0.0.1:19803'), 'ws://127.0.0.1:19802?cc_token=T');
  assert.strictEqual(b.calls[0].url, 'http://127.0.0.1:19803/pair');
  assert.strictEqual(b.calls.length, 1);
  // ...and the REST calls on that base reuse the same token without re-pairing.
  await p.fetch('http://127.0.0.1:19803', '/tools');
  assert.strictEqual(b.calls.filter((c) => /\/pair$/.test(c.url)).length, 1);
});

test('tokens are tracked per bridge, not shared across ports', async () => {
  let n = 0;
  const b = fakeBridge({ pair: () => res(200, { token: 'tok' + (++n), expiresIn: 3600 }), other: () => res(200, {}) });
  const p = createBridgePairing({ fetch: b.fetch });
  await p.fetch('http://127.0.0.1:19800', '/x');
  await p.fetch('http://127.0.0.1:19803', '/x');
  const sent = b.calls.filter((c) => !/\/pair$/.test(c.url));
  assert.notStrictEqual(tokenOf(sent[0].init), tokenOf(sent[1].init));
});

test('caller headers are preserved (plain object and Headers)', async () => {
  const b = fakeBridge({ pair: () => res(200, { token: 't', expiresIn: 60 }), other: () => res(200, {}) });
  const p = createBridgePairing({ fetch: b.fetch });
  await p.fetch(BASE, '/a', { headers: { 'Content-Type': 'application/json' } });
  await p.fetch(BASE, '/b', { headers: new Headers({ 'Content-Type': 'application/json' }) });
  for (const c of b.calls.filter((c) => !/\/pair$/.test(c.url))) {
    assert.strictEqual(c.init.headers['X-CC-Pairing-Token'], 't');
    assert.strictEqual((c.init.headers['Content-Type'] || c.init.headers['content-type']), 'application/json');
  }
});
