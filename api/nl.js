// ClashControl — Gemma 4 NL proxy with native function calling
// Receives { command, context } from client, returns { intent, ...params }

var { cors } = require('./_lib');

// Gemma 4 tool declarations — one per NL intent
const TOOLS = [
  {
    name: 'run_detection',
    description: 'Run clash detection between building model groups. Use when the user wants to check, find, detect, or run clashes between models or disciplines.',
    parameters: {
      type: 'object',
      properties: {
        modelA: { type: 'string', description: 'First model name substring, discipline name, or "all"' },
        modelB: { type: 'string', description: 'Second model name substring, discipline name, or "all"' },
        maxGap: { type: 'number', description: 'Maximum gap tolerance in mm. Convert from other units: 5cm=50, 2in=51, 1m=1000' },
        hard: { type: 'boolean', description: 'true for hard/intersection clashes, false for soft/clearance clashes' },
        duplicates: { type: 'boolean', description: 'Whether to include duplicate clash detection' },
        excludeSelf: { type: 'boolean', description: 'Exclude self-clashes within the same model' },
      },
      required: ['modelA', 'modelB'],
    },
  },
  {
    name: 'set_max_gap',
    description: 'Set the maximum gap/tolerance for clash detection in mm.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number', description: 'Gap tolerance in mm. Convert from other units.' },
      },
      required: ['value'],
    },
  },
  {
    name: 'set_duplicates',
    description: 'Enable or disable duplicate clash detection.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to include duplicates, false to exclude' },
      },
      required: ['enabled'],
    },
  },
  {
    name: 'filter_status',
    description: 'Filter the clash list by status (open, resolved, or all).',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'resolved', 'all'] },
      },
      required: ['status'],
    },
  },
  {
    name: 'reset_filters',
    description: 'Clear all active filters and show everything.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'group_by',
    description: 'Group clashes by a category (storey/floor/level, discipline, status, type, or none).',
    parameters: {
      type: 'object',
      properties: {
        groupBy: { type: 'string', enum: ['storey', 'discipline', 'status', 'type', 'none'] },
      },
      required: ['groupBy'],
    },
  },
  {
    name: 'export_bcf',
    description: 'Export clashes/issues as a BCF file.',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'string', enum: ['2.1', '3.0'], description: 'BCF version' },
      },
    },
  },
  {
    name: 'query',
    description: 'Query information about the current state — clash count, issue count, loaded models, current rules, or worst storey.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['clash_count', 'issue_count', 'model_list', 'current_rules', 'worst_storey'] },
      },
      required: ['metric'],
    },
  },
  {
    name: 'help',
    description: 'Show help information about available commands.',
    parameters: { type: 'object', properties: {} },
  },
  // --- New capabilities beyond regex ---
  {
    name: 'analyze_clashes',
    description: 'Analyze or summarize clashes — worst area, breakdown by discipline, patterns, statistics.',
    parameters: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'What to analyze: "worst_area", "by_discipline", "summary", "patterns"' },
      },
    },
  },
  {
    name: 'generate_report',
    description: 'Generate a text report or summary of current clashes/issues for sharing with team or project manager.',
    parameters: {
      type: 'object',
      properties: {
        audience: { type: 'string', description: 'Who the report is for: "manager", "team", "client"' },
      },
    },
  },
  {
    name: 'batch_update',
    description: 'Bulk update multiple clashes — resolve all duplicates, mark by type, set priority for a group.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['resolve', 'set_priority', 'set_status'] },
        filter: { type: 'string', description: 'Which clashes to target: "duplicates", "soft", "hard", "all"' },
        value: { type: 'string', description: 'New value for the action (e.g., priority level or status)' },
      },
      required: ['action', 'filter'],
    },
  },
];

function buildSystemPrompt(context) {
  return [
    'You are a command parser for ClashControl, a BIM clash detection app.',
    'Use the provided tools to handle the user\'s request.',
    'Convert all lengths to mm (5cm=50, 2in=51, 1m=1000).',
    'Use model name substrings from the loaded models list, or "all".',
    '',
    'Loaded models: ' + (context.models || 'none'),
    'Current rules: maxGap=' + (context.maxGap || 10) + 'mm, hard=' + (context.hard !== false) + ', modelA=' + (context.modelA || 'all') + ', modelB=' + (context.modelB || 'all'),
  ].join('\n');
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured' });

  var body = req.body;
  if (!body || !body.command) return res.status(400).json({ error: 'Missing command' });

  var systemPrompt = buildSystemPrompt(body.context || {});

  // Build Gemma 4 request with function calling
  var payload = {
    contents: [
      { role: 'user', parts: [{ text: body.command }] },
    ],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: [{
      functionDeclarations: TOOLS.map(function(t) {
        return { name: t.name, description: t.description, parameters: t.parameters };
      }),
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
    },
  };

  // If reply context is provided (conversation memory)
  if (body.replyContext) {
    payload.contents.unshift({
      role: 'model',
      parts: [{ text: body.replyContext }],
    });
  }

  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=' + key;
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      var errText = await resp.text();
      console.error('Gemma API error:', resp.status, errText);
      return res.status(502).json({
        error: 'AI request failed',
        upstreamStatus: resp.status,
        upstreamBody: errText.slice(0, 1000)
      });
    }

    var data = await resp.json();
    var candidate = data.candidates && data.candidates[0];
    if (!candidate) return res.status(502).json({ error: 'No response from AI' });

    // Extract function call from response (skip thinking parts)
    var parts = candidate.content && candidate.content.parts;
    if (!parts) return res.status(502).json({ error: 'Empty AI response' });

    // Gemma 4 emits internal "thought" parts before the real answer.
    // Filter them out so they don't leak into the chat UI.
    var answerParts = parts.filter(function(p) { return !p.thought; });

    for (var i = 0; i < answerParts.length; i++) {
      if (answerParts[i].functionCall) {
        var fc = answerParts[i].functionCall;
        return res.status(200).json({
          intent: fc.name,
          ...fc.args,
        });
      }
    }

    // No function call — model responded with text (e.g., unknown intent)
    var text = answerParts.map(function(p) { return p.text || ''; }).join('').trim();
    return res.status(200).json({ intent: 'unknown', text: text });

  } catch (e) {
    console.error('NL proxy error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
};
