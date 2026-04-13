#!/usr/bin/env node
'use strict';
/**
 * ClashControl Smart Bridge Server
 *
 * Modes:
 *   Normal  — WebSocket server (port 19802) + REST API (port 19803).
 *             Auto-configures Claude Desktop on first run.
 *   --mcp   — MCP stdio server (51 tools). Claude Desktop spawns this.
 *   --install — Writes Claude Desktop config and exits.
 *
 * Both files are bundled into the same binary by pkg.
 * Requires: ws (npm)
 */

// ── --mcp / --install: delegate to mcp-server.js ─────────────────────────────
if (process.argv.includes('--mcp') || process.argv.includes('--install') || process.stdin.isTTY) {
  require('./mcp-server.js');
  // mcp-server.js installs stdin listeners and takes over — nothing more to do here.
  // (In pkg the file is included as a bundled module.)
  return;
}

const http = require('http');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const VERSION  = require('./bridge-version.json').version;
const WS_PORT  = parseInt(process.env.CLASHCONTROL_WS_PORT || '19802', 10);
const REST_PORT = parseInt(process.env.CLASHCONTROL_PORT   || '19803', 10);

// ── Auto-configure Claude Desktop ─────────────────────────────────────────────
function _cfgPath() {
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'claude-desktop', 'claude_desktop_config.json');
}

function ensureMcpConfig() {
  const cfgPath = _cfgPath();
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
    const want = JSON.stringify({ command: process.execPath, args: ['--mcp'] });
    const have = cfg.mcpServers && cfg.mcpServers.clashcontrol;
    if (have && JSON.stringify({ command: have.command, args: have.args }) === want) return;
    if (!cfg.mcpServers) cfg.mcpServers = {};
    cfg.mcpServers.clashcontrol = { command: process.execPath, args: ['--mcp'] };
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('[SmartBridge] Claude Desktop configured — restart Claude to apply.');
  } catch (e) {
    console.warn('[SmartBridge] Could not write Claude Desktop config:', e.message);
  }
}

function writeMcpConfig() {
  const cfgPath = _cfgPath();
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
    if (!cfg.mcpServers) cfg.mcpServers = {};
    cfg.mcpServers.clashcontrol = { command: process.execPath, args: ['--mcp'] };
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    return { success: true, path: cfgPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── WebSocket server ───────────────────────────────────────────────────────────
let _browser     = null;   // current browser WebSocket
let _manifest    = [];     // tool manifest sent by browser on connect
let _pending     = Object.create(null); // id → { resolve, reject, timer }
let _seq         = 0;

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('listening', () => {
  console.log('[SmartBridge] v' + VERSION);
  console.log('[SmartBridge] WebSocket  ws://127.0.0.1:'  + WS_PORT);
  console.log('[SmartBridge] REST API   http://127.0.0.1:' + REST_PORT);
  ensureMcpConfig();
});

wss.on('connection', (ws) => {
  if (_browser) { try { _browser.close(1001, 'New connection'); } catch (_) {} }
  _browser = ws;
  console.log('[SmartBridge] Browser connected');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'tool_manifest') {
      _manifest = msg.tools || [];
      console.log('[SmartBridge] Tool manifest: ' + _manifest.length + ' tools');
      return;
    }

    if (msg.type === 'install_mcp_config') {
      const r = writeMcpConfig();
      try { ws.send(JSON.stringify({ type: 'mcp_config_installed', ...r })); } catch (_) {}
      return;
    }

    // Tool-call response from browser: { id, result }
    if (msg.id != null) {
      const p = _pending[msg.id];
      if (p) {
        clearTimeout(p.timer);
        delete _pending[msg.id];
        p.resolve(msg.result);
      }
      return;
    }
  });

  ws.on('close', () => {
    console.log('[SmartBridge] Browser disconnected');
    if (_browser === ws) _browser = null;
    for (const id of Object.keys(_pending)) {
      const p = _pending[id];
      clearTimeout(p.timer);
      delete _pending[id];
      p.reject(new Error('Browser disconnected'));
    }
  });

  ws.on('error', (e) => console.error('[SmartBridge] WS error:', e.message));
});

wss.on('error', (e) => console.error('[SmartBridge] WS server error:', e.message));

// ── Forward a call to the browser and await its response ──────────────────────
function callBrowser(action, params) {
  return new Promise((resolve, reject) => {
    if (!_browser || _browser.readyState !== 1) {
      return reject(new Error(
        'ClashControl is not connected. Open ClashControl in your browser and enable the Smart Bridge addon.'
      ));
    }
    const id = ++_seq;
    const timer = setTimeout(() => {
      delete _pending[id];
      reject(new Error('ClashControl did not respond within 30 seconds.'));
    }, 30000);
    _pending[id] = { resolve, reject, timer };
    try {
      _browser.send(JSON.stringify({ id, action, params: params || {} }));
    } catch (e) {
      clearTimeout(timer);
      delete _pending[id];
      reject(e);
    }
  });
}

// ── HTTP / REST server ────────────────────────────────────────────────────────
function buildOpenApi() {
  const paths = {};
  for (const t of _manifest) {
    paths['/call/' + t.name] = {
      post: {
        operationId: t.name,
        summary: t.description || t.name,
        requestBody: { required: false, content: { 'application/json': { schema: t.inputSchema || { type: 'object' } } } },
        responses: { 200: { description: 'Tool result' } }
      }
    };
  }
  return {
    openapi: '3.0.0',
    info: { title: 'ClashControl Smart Bridge', version: VERSION },
    servers: [{ url: 'http://localhost:' + REST_PORT }],
    paths
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
  });
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname } = new URL(req.url || '/', 'http://localhost');
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (req.method === 'GET' && pathname === '/health') {
    return json(200, {
      ok: true, version: VERSION,
      browserConnected: !!(  _browser && _browser.readyState === 1),
      toolCount: _manifest.length
    });
  }

  if (req.method === 'GET' && pathname === '/tools') {
    return json(200, _manifest);
  }

  if (req.method === 'GET' && pathname === '/openapi.json') {
    return json(200, buildOpenApi());
  }

  if (req.method === 'POST' && pathname.startsWith('/call/')) {
    const action = decodeURIComponent(pathname.slice(6));
    const body = await readBody(req);
    let params = {};
    try { params = JSON.parse(body || '{}'); } catch (_) {}
    try {
      const result = await callBrowser(action, params);
      return json(200, result);
    } catch (e) {
      return json(503, { error: e.message });
    }
  }

  json(404, { error: 'Not found', path: pathname });
});

httpServer.listen(REST_PORT, '127.0.0.1');
httpServer.on('error', (e) => console.error('[SmartBridge] HTTP error:', e.message));

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() { wss.close(); httpServer.close(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
process.on('uncaughtException', (e) => { console.error('[SmartBridge] Fatal:', e); process.exit(1); });
