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
  if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
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

module.exports = { cors, rateLimit, clientIp };
