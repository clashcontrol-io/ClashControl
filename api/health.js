// ClashControl — Health check endpoint
// Returns AI and DB connection status.
//   `ai` / `model` describe the NL assistant backend (/api/nl) — now Groq.
//   `titleTriage` reports the Google AI Studio (Gemma) key used by
//   /api/title + /api/triage.
// ?test=1 → actually call Groq and surface the raw response for diagnostics.

var { cors, dbUrl } = require('./_lib');

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

  // Optional: actually call Groq and surface the raw response so we can
  // diagnose "doesn't work" errors. Hit /api/health?test=1 in a browser.
  if (groqKey && req.query && req.query.test) {
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
      var tdata = await tr.json();
      status.test = { model: groqModel, httpStatus: tr.status, ok: tr.ok, response: tdata };
    } catch (e) {
      status.test = { model: groqModel, error: String(e && e.message || e) };
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
