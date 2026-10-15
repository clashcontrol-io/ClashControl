'use strict';

// Origin / Host allow-list and short-lived pairing tokens for the Smart Bridge.
//
// The bridge listens on loopback, but every page open in the user's browser can
// reach 127.0.0.1. Layers (see smart-bridge-server.js for where each applies):
//
//   1. Host   - must be a loopback name. Defeats DNS rebinding.
//   2. Origin - when present, must EXACTLY match the ClashControl web app (or an
//               origin the user opted into via CLASHCONTROL_ALLOWED_ORIGINS).
//               Anything else is refused with 403 before any work is done:
//               CORS only stops a page *reading* a response, not a "simple"
//               cross-site request from being executed.
//   3. Token  - the app obtains a random, short-lived token from POST /pair
//               (only answerable to an allowed origin, and only readable by it)
//               and presents it on everything else. Requests with no Origin are
//               not browser cross-origin traffic (browsers always send one on
//               cross-origin POSTs and WebSocket handshakes), so local tooling
//               such as the MCP stdio server and curl stays governed by the
//               loopback bind + Host check.

const crypto = require('crypto');

const APP_ORIGINS = ['https://www.clashcontrol.io', 'https://clashcontrol.io'];
const TOKEN_TTL_MS = 60 * 60 * 1000;   // 1 hour; the app re-pairs transparently on 401
const MAX_ACTIVE_TOKENS = 32;          // roughly: one per open tab
const PAIRING_HEADER = 'x-cc-pairing-token';

// App origins plus exact extra origins from CLASHCONTROL_ALLOWED_ORIGINS
// (comma separated) - for self-hosting or developing the web app, e.g.
// http://localhost:8000. No wildcards, on purpose.
function allowedOrigins(env) {
  env = env || process.env;
  const extra = String(env.CLASHCONTROL_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o && o !== '*');
  return APP_ORIGINS.concat(extra);
}

function isAllowedOrigin(origin, env) {
  if (!origin || typeof origin !== 'string') return false;
  return allowedOrigins(env).indexOf(origin) !== -1;
}

function isAllowedHost(host) {
  if (!host || typeof host !== 'string') return false;
  let h = host.trim().toLowerCase();
  if (h.charAt(0) === '[') {                 // [::1]:19803
    const end = h.indexOf(']');
    h = end === -1 ? h : h.slice(0, end + 1);
  } else if ((h.match(/:/g) || []).length === 1) {
    h = h.slice(0, h.indexOf(':'));          // host:port
  }
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

function digest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// In-memory token store. Tokens die with the process and after the TTL.
function createPairingStore(opts) {
  opts = opts || {};
  const ttl = opts.ttlMs || TOKEN_TTL_MS;
  const max = opts.maxTokens || MAX_ACTIVE_TOKENS;
  const now = opts.now || Date.now;
  const tokens = new Map();                  // sha256(token) -> expiry (ms)

  function purge() {
    const t = now();
    for (const [k, exp] of tokens) if (exp <= t) tokens.delete(k);
  }

  return {
    issue() {
      const token = crypto.randomBytes(32).toString('base64url');
      purge();
      while (tokens.size >= max) {           // evict the oldest (Map keeps insertion order)
        tokens.delete(tokens.keys().next().value);
      }
      tokens.set(digest(token), now() + ttl);
      return { token, expiresIn: Math.round(ttl / 1000) };
    },
    valid(token) {
      if (!token || typeof token !== 'string') return false;
      purge();
      return tokens.has(digest(token));
    },
    clear() { tokens.clear(); }
  };
}

function tokenFromHeaders(headers) {
  const v = headers && headers[PAIRING_HEADER];
  return Array.isArray(v) ? v[0] : v;
}

// WebSocket handshakes cannot set headers from the browser, so the token rides
// in the query string (?cc_token=...). Loopback only; never logged.
function tokenFromUrl(url) {
  try { return new URL(url || '/', 'http://localhost').searchParams.get('cc_token') || ''; }
  catch (_) { return ''; }
}

module.exports = {
  APP_ORIGINS, TOKEN_TTL_MS, MAX_ACTIVE_TOKENS, PAIRING_HEADER,
  allowedOrigins, isAllowedOrigin, isAllowedHost,
  createPairingStore, tokenFromHeaders, tokenFromUrl
};
