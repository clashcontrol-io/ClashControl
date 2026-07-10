// ClashControl — Shared serverless utilities
// CORS handling and rate limiting used by all /api/* endpoints.
// The leading underscore prevents Vercel from routing this as an endpoint.

const ALLOWED_ORIGINS = [
  'https://www.clashcontrol.io',
  'http://localhost:3000',
  'http://localhost:5500',
];

function cors(req, res, methods) {
  var origin = req.headers.origin || '';
  // Exact-match required: substring/prefix matching lets attackers craft origins
  // like http://localhost:3000.evil.com that pass startsWith() checks.
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', (methods || 'POST') + ', OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CC-Consent');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// In-memory rate limiter — resets per cold start, good enough for abuse prevention
var rateMap = {};
function rateLimit(ip, limit) {
  var now = Date.now();
  var bucket = rateMap[ip];
  if (!bucket || now - bucket.start > 60000) {
    rateMap[ip] = { start: now, count: 1 };
    return false;
  }
  bucket.count++;
  return bucket.count > limit;
}

function clientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

// Resolve a Postgres connection string from any of the env var names that
// Vercel Postgres / Neon / generic setups inject. Vercel Postgres auto-injects
// POSTGRES_URL (and several variants) when you link a database to the project.
function dbUrl() {
  return process.env.POSTGRES_URL
    || process.env.POSTGRES_URL_NON_POOLING
    || process.env.DATABASE_URL
    || null;
}

// LLM endpoint guard — combines per-IP rate limiting and request-size caps.
// Cost protection for /api/nl (Groq) and /api/title + /api/triage (Gemma).
// Returns true if the request was rejected (and the error response written).
//
//   perMin   — max requests per IP per minute (default 20)
//   maxBytes — max body payload size after JSON parsing (default 16 KB)
//
// Vercel's in-memory `rateMap` resets per cold start, so this is best-effort
// abuse prevention, not strict accounting. Sustained quota drain is still
// gated by each provider's own per-key quota and the offline-regex fallback
// in the client when /api/nl is down.
function llmGuard(req, res, opts) {
  opts = opts || {};
  var perMin = opts.perMin || 20;
  var maxBytes = opts.maxBytes || 16384;
  var ip = clientIp(req);
  if (rateLimit(ip, perMin)) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'Too many requests', retryAfter: 60 });
    return true;
  }
  if (req.body) {
    var bodyStr;
    try { bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body); }
    catch (_) { bodyStr = ''; }
    if (bodyStr.length > maxBytes) {
      res.status(413).json({ error: 'Payload too large', maxBytes: maxBytes });
      return true;
    }
  }
  return false;
}

// Retry transient upstream failures (network errors, 502/503/504) with
// exponential backoff before handing control back to the caller. Adapted
// from mealplannerapp's api/_lib/ai-call.js withRetry (cross-repo learning
// plan, T11) — that repo's fallback-chain-plus-retry discipline was the
// most battle-tested LLM plumbing across the account; ClashControl's /api/nl
// and /api/triage had neither.
//
// Non-transient statuses (4xx, plain 500) are returned immediately so
// callers keep their existing status-specific handling unchanged — /api/nl's
// 429-quota and 400-tool_use_failed branches, in particular, must see the
// first response as-is.
async function fetchWithRetry(url, options, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  var lastError;
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      var res = await fetch(url, options);
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) return res;
      if (attempt === maxAttempts - 1) return res; // exhausted — let the caller handle the final response
      lastError = new Error('Upstream ' + res.status);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts - 1) throw err;
    }
    var delay = 500 * Math.pow(2, attempt); // 500ms, 1s
    console.warn('[fetchWithRetry] transient failure (attempt ' + (attempt + 1) + '), retrying in ' + delay + 'ms:', lastError && lastError.message);
    await new Promise(function (r) { setTimeout(r, delay); });
  }
  throw lastError;
}

module.exports = { cors, rateLimit, clientIp, dbUrl, llmGuard, fetchWithRetry };
