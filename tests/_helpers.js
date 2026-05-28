// Minimal fake req/res for exercising the Vercel-style serverless handlers
// in api/*.js without a running server. No dependencies — just enough surface
// for the validation/guard paths the tests cover.
'use strict';

function makeReq(opts) {
  opts = opts || {};
  return {
    method: opts.method || 'POST',
    headers: opts.headers || {},
    // Unique IP per request so the in-memory rate limiter doesn't bleed
    // across tests.
    socket: { remoteAddress: opts.ip || ('ip-' + Math.random().toString(36).slice(2)) },
    body: opts.body,
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: undefined,
    headers: {},
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end() { this.ended = true; return this; },
  };
}

module.exports = { makeReq, makeRes };
