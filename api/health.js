// ClashControl — Health check endpoint
// Returns AI and DB connection status.
//   `ai` / `model` describe the NL assistant backend (/api/nl) — now Groq.
//   `titleTriage` reports the Google AI Studio (Gemma) key used by
//   /api/title + /api/triage.
// ?test=1 → actually call Groq and surface the raw response for diagnostics.

var { cors, dbUrl, rateLimit, clientIp } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res, 'GET')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var groqKey = process.env.GROQ_API_KEY || null;
  var geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || null;
  var groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  // `ai` reflects the NL assistant backend (/api/nl), which is Groq-only.
  var status = {
    ai: !!groqKey,
    db: false,
    model: groqKey ? ('groq:' + groqModel) : null,
    // /api/title + /api/triage still run on Google AI Studio (Gemma).
    titleTriage: { configured: !!geminiKey, model: geminiKey ? (process.env.GEMMA_MODEL || 'gemma-4-31b-it') : null },
  };

  // Optional: actually call Groq and report whether it succeeded so we can
  // diagnose "doesn't work" errors. Hit /api/health?test=1 in a browser.
  // Unauthenticated and costs a real upstream call, so it's rate-limited
  // like the other LLM-backed endpoints, and never echoes the raw upstream
  // body back to the caller (it may carry account/quota details we don't
  // want exposed to anyone who can reach this public endpoint).
  if (groqKey && req.query && req.query.test) {
    if (rateLimit(clientIp(req), 5)) {
      res.setHeader('Retry-After', '60');
      status.test = { model: groqModel, error: 'rate_limited' };
    } else {
      var t0 = Date.now();
      try {
        var tr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
          body: JSON.stringify({
            model: groqModel,
            messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
            max_tokens: 8,
            temperature: 0,
          }),
        });
        status.test = { model: groqModel, httpStatus: tr.status, ok: tr.ok, latencyMs: Date.now() - t0 };
      } catch (e) {
        status.test = { model: groqModel, ok: false, error: 'request_failed' };
      }
    }
  }

  // Check DB (Vercel Postgres / Neon)
  var url = dbUrl();
  if (url) {
    try {
      var { neon } = require('@neondatabase/serverless');
      var sql = neon(url);
      await sql`SELECT 1`;
      status.db = true;
    } catch (e) {
      status.db = false;
    }
  }

  res.status(200).json(status);
};
