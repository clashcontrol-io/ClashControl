'use strict';

// Smart Bridge access control: Host + Origin allow-list, Private Network Access
// preflight, and the short-lived pairing token. Pure-logic tests always run;
// the integration block boots the real smart-bridge-server.js and is skipped
// when the optional `ws` dependency isn't installed (it is only bundled into
// the release binary, not a repo dependency).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sec = require('../bridge-security');

const APP = 'https://www.clashcontrol.io';
const EVIL = 'https://evil.example.com';

// ── allow-list ───────────────────────────────────────────────────────────────

describe('origin allow-list', () => {
  const cases = [
    [APP, true],
    ['https://clashcontrol.io', true],
    // Dev origins are opt-in (CLASHCONTROL_ALLOWED_ORIGINS), never default.
    ['http://localhost:8000', false],
    ['http://localhost', false],
    ['http://127.0.0.1:5500', false],
    ['http://[::1]:8000', false],
    ['http://www.clashcontrol.io', false],
    ['https://clashcontrol.io.evil.com', false],
    ['https://xclashcontrol.io', false],
    ['https://www.clashcontrol.io.evil.com', false],
    ['null', false],
    ['', false],
    [undefined, false],
  ];
  for (const [origin, want] of cases) {
    test(JSON.stringify(origin) + ' -> ' + want, () => {
      assert.strictEqual(sec.isAllowedOrigin(origin, {}), want);
    });
  }

  test('extra origins come from CLASHCONTROL_ALLOWED_ORIGINS, exact match, no wildcard', () => {
    const env = { CLASHCONTROL_ALLOWED_ORIGINS: 'http://localhost:8000, https://self.example/ ,*' };
    assert.ok(sec.isAllowedOrigin('http://localhost:8000', env));
    assert.ok(sec.isAllowedOrigin('https://self.example', env));
    assert.ok(!sec.isAllowedOrigin('*', env));
    assert.ok(!sec.isAllowedOrigin('http://localhost:9999', env));
  });
});

describe('host allow-list (DNS rebinding)', () => {
  const cases = [
    ['127.0.0.1', true], ['127.0.0.1:19803', true], ['localhost:19803', true],
    ['LOCALHOST', true], ['[::1]:19803', true], ['[::1]', true],
    ['attacker.example', false], ['attacker.example:19803', false],
    ['127.0.0.1.evil.com', false], ['', false], [undefined, false],
  ];
  for (const [host, want] of cases) {
    test(JSON.stringify(host) + ' -> ' + want, () => assert.strictEqual(sec.isAllowedHost(host), want));
  }
});

// ── pairing store ────────────────────────────────────────────────────────────

describe('pairing store', () => {
  test('issues unique, working tokens', () => {
    const st = sec.createPairingStore();
    const a = st.issue(), b = st.issue();
    assert.notStrictEqual(a.token, b.token);
    assert.ok(a.token.length >= 32);
    assert.ok(st.valid(a.token) && st.valid(b.token));
    assert.strictEqual(a.expiresIn, 3600);
  });

  test('tokens expire', () => {
    let t = 1000;
    const st = sec.createPairingStore({ ttlMs: 60000, now: () => t });
    const { token } = st.issue();
    t += 59000; assert.ok(st.valid(token));
    t += 2000;  assert.ok(!st.valid(token));
  });

  test('active tokens are capped, oldest evicted', () => {
    const st = sec.createPairingStore({ maxTokens: 3 });
    const tokens = Array.from({ length: 5 }, () => st.issue().token);
    assert.ok(!st.valid(tokens[0]));
    assert.ok(st.valid(tokens[4]));
  });

  test('rejects junk', () => {
    const st = sec.createPairingStore();
    for (const bad of [undefined, null, '', 123, {}, 'nope']) assert.ok(!st.valid(bad));
  });

  test('token extraction', () => {
    assert.strictEqual(sec.tokenFromUrl('/?cc_token=abc'), 'abc');
    assert.strictEqual(sec.tokenFromUrl('/'), '');
    assert.strictEqual(sec.tokenFromHeaders({ 'x-cc-pairing-token': 'abc' }), 'abc');
  });
});

// ── integration: the real server ─────────────────────────────────────────────

let WebSocket = null;
try { WebSocket = require('ws'); } catch (_) { /* optional */ }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function request(port, method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('smart-bridge-server (integration)', { skip: !WebSocket && 'optional dependency `ws` not installed' }, () => {
  let child, REST, WS, home;

  before(async () => {
    REST = await freePort();
    WS = await freePort();
    // Throwaway HOME: the server writes an MCP config and audit log there.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-sec-'));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'smart-bridge-server.js')], {
      env: Object.assign({}, process.env, {
        HOME: home, USERPROFILE: home, APPDATA: home,
        CLASHCONTROL_PORT: String(REST), CLASHCONTROL_WS_PORT: String(WS),
        CLASHCONTROL_ALLOWED_ORIGINS: '',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge did not start')), 10000);
      child.stdout.on('data', (d) => { if (String(d).includes('REST API')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error('bridge exited early: ' + c)));
    });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => {
    if (child) child.kill();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  const pair = async () => JSON.parse((await request(REST, 'POST', '/pair', { Origin: APP })).body).token;

  test('hostile origin is refused on every route and nothing runs', async () => {
    for (const [m, p] of [['GET', '/status'], ['GET', '/tools'], ['GET', '/llm-config'], ['POST', '/call/get_clashes'],
                           ['POST', '/chat'], ['POST', '/llm-config'], ['POST', '/pair'], ['OPTIONS', '/chat']]) {
      const r = await request(REST, m, p, { Origin: EVIL });
      assert.strictEqual(r.status, 403, m + ' ' + p);
      assert.strictEqual(r.headers['access-control-allow-origin'], undefined, m + ' ' + p);
      assert.strictEqual(JSON.parse(r.body).code, 'origin_not_allowed');
    }
  });

  test('"null" origin (sandboxed iframe) is refused', async () => {
    assert.strictEqual((await request(REST, 'GET', '/status', { Origin: 'null' })).status, 403);
  });

  test('a localhost origin is no longer implicitly trusted', async () => {
    assert.strictEqual((await request(REST, 'GET', '/status', { Origin: 'http://localhost:8000' })).status, 403);
  });

  test('simple cross-site POST (text/plain, no preflight) cannot reach /llm-config', async () => {
    const r = await request(REST, 'POST', '/llm-config', { Origin: EVIL, 'Content-Type': 'text/plain' },
      JSON.stringify({ baseUrl: 'http://evil.example', apiKey: 'x' }));
    assert.strictEqual(r.status, 403);
    // And the saved config under the throwaway HOME was never created.
    assert.ok(!fs.existsSync(path.join(home, '.clashcontrol', 'llm-config.json')));
  });

  test('DNS-rebinding Host is refused', async () => {
    const r = await request(REST, 'GET', '/status', { Host: 'attacker.example:' + REST });
    assert.strictEqual(r.status, 421);
  });

  test('preflight from the app answers Private Network Access and allows the token header', async () => {
    const r = await request(REST, 'OPTIONS', '/chat', {
      Origin: APP, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true',
    });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers['access-control-allow-origin'], APP);
    assert.strictEqual(r.headers['access-control-allow-private-network'], 'true');
    assert.match(r.headers['access-control-allow-headers'], /X-CC-Pairing-Token/i);
  });

  test('/status is readable by the app without a token', async () => {
    const r = await request(REST, 'GET', '/status', { Origin: APP });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['access-control-allow-origin'], APP);
  });

  test('browser requests without / with a wrong token get a CORS-readable 401', async () => {
    for (const hdrs of [{ Origin: APP }, { Origin: APP, 'X-CC-Pairing-Token': 'nope' }]) {
      for (const [m, p] of [['GET', '/tools'], ['GET', '/llm-config'], ['POST', '/chat'], ['POST', '/call/get_clashes']]) {
        const r = await request(REST, m, p, hdrs, m === 'POST' ? '{}' : undefined);
        assert.strictEqual(r.status, 401, m + ' ' + p);
        assert.strictEqual(r.headers['access-control-allow-origin'], APP);
        assert.strictEqual(JSON.parse(r.body).code, 'pairing_required');
      }
    }
  });

  test('POST /pair issues a token that unlocks the API for that origin', async () => {
    const token = await pair();
    const r = await request(REST, 'GET', '/tools', { Origin: APP, 'X-CC-Pairing-Token': token });
    assert.strictEqual(r.status, 200);
  });

  test('origin-less local tooling (MCP server, curl) still works without a token', async () => {
    assert.strictEqual((await request(REST, 'GET', '/tools')).status, 200);
    assert.strictEqual((await request(REST, 'GET', '/openapi.json')).status, 200);
  });

  test('POST /pair without an Origin is not a pairing path', async () => {
    assert.strictEqual((await request(REST, 'POST', '/pair')).status, 404);
  });

  // WebSocket ------------------------------------------------------------
  const wsOutcome = (url, opts) => new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });

  test('WS: hostile origin, missing origin, no token and bad token are all refused', async () => {
    const token = await pair();
    assert.strictEqual(await wsOutcome(`ws://127.0.0.1:${WS}/?cc_token=${token}`, { origin: EVIL }), 403);
    assert.strictEqual(await wsOutcome(`ws://127.0.0.1:${WS}/?cc_token=${token}`, { origin: 'null' }), 403);
    assert.strictEqual(await wsOutcome(`ws://127.0.0.1:${WS}/?cc_token=${token}`), 403);            // no Origin
    assert.strictEqual(await wsOutcome(`ws://127.0.0.1:${WS}/`, { origin: APP }), 401);              // no token
    assert.strictEqual(await wsOutcome(`ws://127.0.0.1:${WS}/?cc_token=nope`, { origin: APP }), 401);
  });

  test('WS: app origin with a paired token connects', async () => {
    const token = await pair();
    assert.strictEqual(await wsOutcome(`ws://127.0.0.1:${WS}/?cc_token=${token}`, { origin: APP }), 'open');
  });
});
