// ClashControl — AI clash title generation via Gemma 4
// Batch-generates human-readable titles from clash metadata.
//
// Bounded LRU + TTL cache by clash signature: many clashes in a project
// share (typeA, typeB, clashType) and produce essentially the same title.
// Caching by signature collapses 1000-clash projects to ~30-50 LLM calls.
//
// Memory bounds (so warm serverless instances don't grow unbounded):
//   * TITLE_CACHE_MAX  — hard cap on entry count (oldest evicted)
//   * TITLE_CACHE_TTL_MS — soft TTL, expired-on-read entries are deleted
// Cold starts naturally wipe the cache.

var { cors, llmGuard, fetchWithRetry } = require('./_lib');

// Overridable without a deploy — if the upstream ever 404s the default id
// (check Vercel logs for 'title API error'), set GEMMA_MODEL in the env.
var GEMMA_MODEL = process.env.GEMMA_MODEL || 'gemma-4-31b-it';

// Matches the client's per-call batch size (index.html sends clashes in
// groups of 20) and the documented contract. Oversized payloads are rejected
// rather than silently truncated.
var MAX_CLASHES = 20;

var TITLE_CACHE_MAX    = 200;
var TITLE_CACHE_TTL_MS = 60 * 60 * 1000;
var _titleCache = new Map();

function _sigForClash(c) {
  return [
    c.elemAType || '',
    c.elemBType || '',
    c.type || '',
    c.storey ? '1' : '0'
  ].join('|');
}

function _cacheGet(sig) {
  var v = _titleCache.get(sig);
  if (!v) return null;
  if (Date.now() - v.ts > TITLE_CACHE_TTL_MS) {
    _titleCache.delete(sig);
    return null;
  }
  _titleCache.delete(sig);
  _titleCache.set(sig, v);
  return v.entry;
}

function _cacheSet(sig, entry) {
  if (_titleCache.size >= TITLE_CACHE_MAX) {
    var oldest = _titleCache.keys().next().value;
    if (oldest !== undefined) _titleCache.delete(oldest);
  }
  _titleCache.set(sig, { entry: entry, ts: Date.now() });
}

function _sweepExpired() {
  if (_titleCache.size < 32) return;
  var now = Date.now();
  var toDel = [];
  _titleCache.forEach(function(v, k) {
    if (now - v.ts > TITLE_CACHE_TTL_MS) toDel.push(k);
  });
  for (var i = 0; i < toDel.length; i++) _titleCache.delete(toDel[i]);
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (llmGuard(req, res, { perMin: 10, maxBytes: 65536 })) return;

  var key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured' });

  var body = req.body;
  if (!body || !Array.isArray(body.clashes) || body.clashes.length === 0) {
    return res.status(400).json({ error: 'Missing clashes array' });
  }
  if (body.clashes.length > MAX_CLASHES) {
    return res.status(413).json({ error: 'too many clashes', maxClashes: MAX_CLASHES });
  }

  _sweepExpired();

  var clashes = body.clashes.slice(0, MAX_CLASHES);

  var cachedTitles = [];
  var toGenerate = [];
  var sigByIndex = new Array(clashes.length);
  for (var i = 0; i < clashes.length; i++) {
    var c = clashes[i];
    var sig = _sigForClash(c);
    sigByIndex[i] = sig;
    var hit = _cacheGet(sig);
    if (hit) {
      cachedTitles.push({
        id: c.id,
        title: hit.title,
        severity: hit.severity,
        resolution: hit.resolution
      });
    } else {
      toGenerate.push(c);
    }
  }

  if (toGenerate.length === 0) {
    res.setHeader('X-CC-Title-Cache', 'hit:' + cachedTitles.length + '/' + clashes.length);
    return res.status(200).json({ titles: cachedTitles });
  }

  var prompt = [
    'Generate short, human-readable titles for these BIM clash detections.',
    'Each title should describe the specific conflict in plain language (max 80 chars).',
    'Also suggest a severity (critical/major/minor) and a one-line resolution hint.',
    '',
    'Return a JSON array with one object per clash:',
    '[{"id":"...","title":"...","severity":"...","resolution":"..."}]',
    '',
    'Clashes:',
    JSON.stringify(toGenerate.map(function(c) {
      return {
        id: c.id,
        elemAType: c.elemAType,
        elemAName: c.elemAName,
        elemBType: c.elemBType,
        elemBName: c.elemBName,
        modelA: c.modelA,
        modelB: c.modelB,
        type: c.type,
        distance: c.distance,
        storey: c.storey,
      };
    })),
  ].join('\n');

  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(GEMMA_MODEL) + ':generateContent?key=' + encodeURIComponent(key);
    var resp = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!resp.ok) {
      // Log the upstream body server-side: a 404 here means GEMMA_MODEL
      // names a model the API doesn't serve — fix via env, no deploy needed.
      var errBody = ''; try { errBody = (await resp.text()).slice(0, 300); } catch (_) {}
      console.error('Gemma title API error:', resp.status, GEMMA_MODEL, errBody);
      return res.status(502).json({ error: 'AI request failed' });
    }

    var data = await resp.json();
    var candidate = data.candidates && data.candidates[0];
    var parts = candidate && candidate.content && candidate.content.parts;
    if (!parts || !parts[0]) return res.status(502).json({ error: 'Empty AI response' });

    var text = parts[0].text || '';

    var generated;
    try {
      generated = JSON.parse(text);
      if (!Array.isArray(generated)) throw new Error('not array');
    } catch (e) {
      var match = text.match(/\[[\s\S]*\]/);
      if (!match) return res.status(502).json({ error: 'Could not parse AI response' });
      generated = JSON.parse(match[0]);
    }

    var byId = {};
    for (var gi = 0; gi < generated.length; gi++) {
      if (generated[gi] && generated[gi].id) byId[String(generated[gi].id)] = generated[gi];
    }
    for (var ti = 0; ti < toGenerate.length; ti++) {
      var tc = toGenerate[ti];
      var t = byId[String(tc.id)];
      if (!t) continue;
      _cacheSet(_sigForClash(tc), {
        title: t.title,
        severity: t.severity,
        resolution: t.resolution
      });
    }

    res.setHeader('X-CC-Title-Cache',
      (cachedTitles.length ? 'partial:' : 'miss:') +
      cachedTitles.length + '/' + clashes.length);
    res.setHeader('X-CC-Title-Cache-Size', String(_titleCache.size));
    // Provenance: client persists this alongside aiTitle/aiSeverity so each AI
    // decision carries a verifiable record of which model produced it. Cached
    // entries inherit the same provenance shape — the model was the one that
    // produced the title, even if we're serving from cache now.
    return res.status(200).json({
      titles: cachedTitles.concat(generated),
      _model: GEMMA_MODEL,
      _at: new Date().toISOString()
    });
  } catch (e) {
    console.error('Title generation error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
};
