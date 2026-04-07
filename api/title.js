// ClashControl — AI clash title generation via Gemma 4
// Batch-generates human-readable titles from clash metadata

var { cors } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured' });

  var body = req.body;
  if (!body || !Array.isArray(body.clashes) || body.clashes.length === 0) {
    return res.status(400).json({ error: 'Missing clashes array' });
  }

  // Cap at 20 clashes per batch
  var clashes = body.clashes.slice(0, 20);

  var prompt = [
    'Generate short, human-readable titles for these BIM clash detections.',
    'Each title should describe the specific conflict in plain language (max 80 chars).',
    'Also suggest a severity (critical/major/minor) and a one-line resolution hint.',
    '',
    'Return a JSON array with one object per clash:',
    '[{"id":"...","title":"...","severity":"...","resolution":"..."}]',
    '',
    'Clashes:',
    JSON.stringify(clashes.map(function(c) {
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
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=' + key;
    var resp = await fetch(url, {
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
      console.error('Gemma title API error:', resp.status);
      return res.status(502).json({ error: 'AI request failed' });
    }

    var data = await resp.json();
    var candidate = data.candidates && data.candidates[0];
    var parts = candidate && candidate.content && candidate.content.parts;
    if (!parts || !parts[0]) return res.status(502).json({ error: 'Empty AI response' });

    var text = parts[0].text || '';

    // Parse JSON array from response
    try {
      var titles = JSON.parse(text);
      if (!Array.isArray(titles)) throw new Error('not array');
      return res.status(200).json({ titles: titles });
    } catch (e) {
      // Try to extract JSON from markdown fences
      var match = text.match(/\[[\s\S]*\]/);
      if (match) {
        return res.status(200).json({ titles: JSON.parse(match[0]) });
      }
      return res.status(502).json({ error: 'Could not parse AI response' });
    }
  } catch (e) {
    console.error('Title generation error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
};
