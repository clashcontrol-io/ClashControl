// ClashControl — AI cluster triage via Gemma 4
// One request = one clash-cluster context (output of _ccBuildClusterContext).
// Returns structured triage JSON the cluster card renders inline.
//
// Bounded LRU + TTL cache by cluster signature (element types + storey +
// counts + cross-model) so a project's repeated cluster patterns collapse
// to a handful of LLM calls. Cold starts wipe the cache.

var { cors, llmGuard } = require('./_lib');

var TRIAGE_CACHE_MAX    = 100;
var TRIAGE_CACHE_TTL_MS = 60 * 60 * 1000;
var _triageCache = new Map();

function _sigForContext(ctx) {
  var A = ctx.element_A || {}, B = ctx.element_B || {};
  var c = ctx.counts || {};
  return [
    A.ifcType || '', B.ifcType || '',
    A.objectType || '', B.objectType || '',
    ctx.storey || '',
    ctx.cross_model ? '1' : '0',
    (ctx.disciplines || []).slice().sort().join('+'),
    (c.hard||0) + '/' + (c.soft||0) + '/' + (c.duplicate||0)
  ].join('|');
}

function _cacheGet(sig) {
  var v = _triageCache.get(sig);
  if (!v) return null;
  if (Date.now() - v.ts > TRIAGE_CACHE_TTL_MS) { _triageCache.delete(sig); return null; }
  _triageCache.delete(sig); _triageCache.set(sig, v);
  return v.entry;
}

function _cacheSet(sig, entry) {
  if (_triageCache.size >= TRIAGE_CACHE_MAX) {
    var oldest = _triageCache.keys().next().value;
    if (oldest !== undefined) _triageCache.delete(oldest);
  }
  _triageCache.set(sig, { entry: entry, ts: Date.now() });
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (llmGuard(req, res, { perMin: 12, maxBytes: 32768 })) return;

  var key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured' });

  var body = req.body;
  if (!body || !body.context || typeof body.context !== 'object') {
    return res.status(400).json({ error: 'Missing context object' });
  }
  var ctx = body.context;

  var sig = _sigForContext(ctx);
  var cached = _cacheGet(sig);
  if (cached) {
    res.setHeader('X-CC-Triage-Cache', 'hit');
    return res.status(200).json({ triage: cached, cached: true });
  }

  var prompt = [
    'You are a senior BIM coordinator reviewing clash-detection output.',
    'Treat the input as ground truth. Do not invent dimensions, materials, or codes.',
    'Reply ONLY with the JSON object specified — no prose, no markdown fences.',
    '',
    'CLASH GROUP:',
    JSON.stringify(ctx, null, 2),
    '',
    'Return JSON of the form:',
    '{',
    '  "title": "<= 80 chars, names the conflict",',
    '  "severity": "critical | high | medium | low",',
    '  "explanation": "2-4 sentences, plain language, grounded only in the data above",',
    '  "discipline_conflict": "e.g. MEP vs structural, MEP vs MEP",',
    '  "false_positive_likelihood": "low | medium | high",',
    '  "resolution_options": [',
    '    { "option": "concrete change", "tradeoff": "what it costs", "cost_impact": "low | medium | high" }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- 2-3 resolution options, ordered most-recommended first.',
    '- Stay advisory. Never prescribe a structural change as definitive.',
    '- If the data is insufficient to judge severity, choose "medium" and say so in explanation.'
  ].join('\n');

  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=' + encodeURIComponent(key);
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!resp.ok) {
      console.error('Gemma triage API error:', resp.status);
      return res.status(502).json({ error: 'AI request failed', status: resp.status });
    }

    var data = await resp.json();
    var candidate = data.candidates && data.candidates[0];
    var parts = candidate && candidate.content && candidate.content.parts;
    if (!parts || !parts[0]) return res.status(502).json({ error: 'Empty AI response' });
    var text = parts[0].text || '';

    var triage;
    try {
      triage = JSON.parse(text);
    } catch (e) {
      var match = text.match(/\{[\s\S]*\}/);
      if (!match) return res.status(502).json({ error: 'Could not parse AI response' });
      triage = JSON.parse(match[0]);
    }

    _cacheSet(sig, triage);
    res.setHeader('X-CC-Triage-Cache', 'miss');
    return res.status(200).json({ triage: triage, cached: false });
  } catch (e) {
    console.error('Triage error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
};
