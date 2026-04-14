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
 * REST API endpoints (port 19803):
 *   GET  /health | /status     — health check + browser connection state
 *   GET  /tools                — tool manifest (updated live from browser)
 *   GET  /openapi.json         — OpenAPI 3.0 spec for ChatGPT custom actions
 *   POST /call/{tool}          — execute a single tool
 *   GET  /llm-config           — read stored Ollama/OpenAI config
 *   POST /llm-config           — save Ollama/OpenAI config to disk
 *   POST /chat                 — agentic loop: LLM reasons over ClashControl tools
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

// ── LLM config persistence ─────────────────────────────────────────────────────
const LLM_CONFIG_DIR  = path.join(os.homedir(), '.clashcontrol');
const LLM_CONFIG_PATH = path.join(LLM_CONFIG_DIR, 'llm-config.json');

const LLM_DEFAULTS = {
  provider: 'ollama',
  model:    'llama3.2',
  baseUrl:  'http://localhost:11434',
  apiKey:   ''
};

function loadLlmConfig() {
  try { return Object.assign({}, LLM_DEFAULTS, JSON.parse(fs.readFileSync(LLM_CONFIG_PATH, 'utf8'))); }
  catch (_) { return Object.assign({}, LLM_DEFAULTS); }
}

function saveLlmConfig(cfg) {
  fs.mkdirSync(LLM_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(LLM_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// ── LLM HTTP call (OpenAI-compatible: works with Ollama, OpenAI, LM Studio, etc.) ──
function callLlmApi(cfg, messages, tools) {
  return new Promise((resolve, reject) => {
    const baseUrl = (cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const model   = cfg.model   || 'llama3.2';
    const apiKey  = cfg.apiKey  || 'ollama';

    let targetUrl;
    try { targetUrl = new URL('/v1/chat/completions', baseUrl); }
    catch (e) { return reject(new Error('Invalid LLM base URL: ' + baseUrl)); }

    const payload = { model, messages };
    if (tools && tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
    const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');

    const isHttps = targetUrl.protocol === 'https:';
    const lib     = isHttps ? require('https') : require('http');
    const opts    = {
      hostname: targetUrl.hostname,
      port:     targetUrl.port || (isHttps ? 443 : 80),
      path:     targetUrl.pathname + (targetUrl.search || ''),
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': bodyBuf.length,
        'Authorization':  'Bearer ' + apiKey
      }
    };

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error((j.error.message || JSON.stringify(j.error))));
          else resolve(j);
        } catch (e) {
          reject(new Error('LLM returned non-JSON: ' + data.slice(0, 300)));
        }
      });
    });
    req.setTimeout(120000, () => { req.destroy(new Error('LLM request timed out after 120s')); });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── Agentic loop: LLM drives ClashControl tools until it gives a final answer ──
async function runAgentLoop(userMessage, history, cfg) {
  if (!_browser || _browser.readyState !== 1) {
    throw new Error('ClashControl is not connected. Open ClashControl and enable the Smart Bridge addon.');
  }

  const tools = _manifest.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {}, required: [] } }
  }));

  const systemPrompt =
    'You are an AI assistant controlling ClashControl, a BIM/IFC clash detection application. ' +
    'You have tools to read model data, run clash detection, update clashes, control the 3D viewport, manage issues, and more. ' +
    'Call get_status first to understand what the user is working with. Be concise and actionable in your final answers.';

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: userMessage }
  ];

  let toolCallCount = 0;
  const MAX_ITERS = 10;

  for (let i = 0; i < MAX_ITERS; i++) {
    const resp = await callLlmApi(cfg, messages, tools);
    if (!resp.choices || !resp.choices[0]) throw new Error('LLM returned no choices');
    const choice = resp.choices[0];
    const msg    = choice.message;
    messages.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      // Final answer
      return {
        response:      msg.content || '',
        model:         resp.model  || cfg.model,
        toolCallCount,
        history:       messages.slice(1)   // drop system prompt from returned history
      };
    }

    // Execute each tool call via the browser WebSocket
    for (const tc of msg.tool_calls) {
      toolCallCount++;
      let result;
      try {
        const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        result = await callBrowser(tc.function.name, args);
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({
        role:         'tool',
        tool_call_id: tc.id,
        content:      typeof result === 'string' ? result : JSON.stringify(result)
      });
    }
  }

  return {
    response:      'Reached the maximum number of steps without a final answer.',
    model:         cfg.model,
    toolCallCount,
    history:       messages.slice(1)
  };
}

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

  const statusBody = () => ({
    ok: true, version: VERSION,
    browserConnected: !!(_browser && _browser.readyState === 1),
    toolCount: _manifest.length
  });

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/status')) {
    return json(200, statusBody());
  }

  if (req.method === 'GET' && pathname === '/tools') {
    return json(200, _manifest);
  }

  if (req.method === 'GET' && pathname === '/openapi.json') {
    return json(200, buildOpenApi());
  }

  // ── LLM config ────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/llm-config') {
    const cfg = loadLlmConfig();
    return json(200, { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, hasKey: !!cfg.apiKey });
  }

  if (req.method === 'POST' && pathname === '/llm-config') {
    const body = await readBody(req);
    let incoming = {};
    try { incoming = JSON.parse(body || '{}'); } catch (_) {}
    const current = loadLlmConfig();
    // apiKey is only updated when explicitly provided (non-empty, non-masked)
    const newApiKey = (incoming.apiKey && incoming.apiKey !== '***') ? incoming.apiKey : current.apiKey;
    saveLlmConfig({
      provider: incoming.provider || current.provider,
      model:    incoming.model    || current.model,
      baseUrl:  incoming.baseUrl  || current.baseUrl,
      apiKey:   newApiKey
    });
    return json(200, { ok: true });
  }

  // ── Agentic chat: LLM reasons over ClashControl tools ────────────────────────
  if (req.method === 'POST' && pathname === '/chat') {
    const body = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (_) {}
    const { message, history, llm } = payload;
    if (!message) return json(400, { error: 'message is required' });
    const cfg = Object.assign({}, loadLlmConfig(), llm || {});
    try {
      const result = await runAgentLoop(message, history, cfg);
      return json(200, result);
    } catch (e) {
      return json(503, { error: e.message });
    }
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
