#!/usr/bin/env node
// ── ClashControl Smart Bridge — MCP Transport ─────────────────────
// Exposes ClashControl actions as MCP tools so Claude Desktop/Code
// can control the app directly. Part of the Smart Bridge — the LLM
// bridge that connects different AI assistants to ClashControl.
// Communicates with the browser via WebSocket on localhost:19802.
//
// Usage:
//   npx @clashcontrol/mcp-server          # or: node index.js
//
// Claude Desktop config (~/.claude/claude_desktop_config.json):
//   { "mcpServers": { "clashcontrol": { "command": "npx", "args": ["@clashcontrol/mcp-server"] } } }

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const WebSocket = require('ws');

const WS_PORT = 19802;
const REQUEST_TIMEOUT = 15000; // 15s for browser to respond

// ── WebSocket bridge to browser ───────────────────────────────────

let wss = null;
let browserSocket = null;
let pendingRequests = new Map(); // id → {resolve, reject, timer}
let requestId = 0;

function startWsBridge() {
  wss = new WebSocket.Server({ port: WS_PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    browserSocket = ws;
    process.stderr.write('[Smart Bridge MCP] Browser connected\n');
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const req = pendingRequests.get(msg.id);
          clearTimeout(req.timer);
          pendingRequests.delete(msg.id);
          req.resolve(msg.result);
        }
      } catch (e) {
        process.stderr.write('[Smart Bridge MCP] Bad message: ' + e.message + '\n');
      }
    });
    ws.on('close', () => {
      browserSocket = null;
      process.stderr.write('[Smart Bridge MCP] Browser disconnected\n');
    });
  });
  wss.on('error', (err) => {
    process.stderr.write('[Smart Bridge MCP] WebSocket error: ' + err.message + '\n');
  });
}

function sendToBrowser(action, params) {
  return new Promise((resolve, reject) => {
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('ClashControl is not connected. Open clashcontrol.io and enable the Smart Bridge addon in Navigator → Addons.'));
      return;
    }
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Request timed out — ClashControl did not respond within ' + (REQUEST_TIMEOUT / 1000) + 's'));
    }, REQUEST_TIMEOUT);
    pendingRequests.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ id, action, params: params || {} }));
  });
}

// ── MCP Server ────────────────────────────────────────────────────

const server = new McpServer({
  name: 'ClashControl',
  version: '0.1.0',
});

// Helper: wrap a browser action as an MCP tool
function browserTool(name, description, schema, paramMapper) {
  server.tool(name, description, schema, async (params) => {
    try {
      const mapped = paramMapper ? paramMapper(params) : params;
      const result = await sendToBrowser(name, mapped);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  });
}

// ── Tool definitions ──────────────────────────────────────────────

// State queries (read-only)
server.tool('get_status', 'Get the current state of ClashControl: loaded models, clash count, active project, detection rules.', {}, async () => {
  try {
    const result = await sendToBrowser('get_status', {});
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
  }
});

server.tool('get_clashes', 'Get the current clash list with details (type, storey, status, elements involved). Returns up to 50 clashes.', {
  status: z.enum(['open', 'resolved', 'all']).optional().describe('Filter by status'),
  limit: z.number().optional().describe('Max clashes to return (default 50)'),
}, async (params) => {
  try {
    const result = await sendToBrowser('get_clashes', params);
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
  }
});

server.tool('get_issues', 'Get the current issues list with details.', {
  limit: z.number().optional().describe('Max issues to return (default 50)'),
}, async (params) => {
  try {
    const result = await sendToBrowser('get_issues', params);
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
  }
});

// Detection
browserTool(
  'run_detection',
  'Run clash detection between two model groups. Pass model names, disciplines, or "all".',
  {
    modelA: z.string().describe('First side: model name, discipline, or "all". Use "+" to combine: "structural + architectural"'),
    modelB: z.string().describe('Second side: model name, discipline, or "all"'),
    maxGap: z.number().optional().describe('Gap tolerance in mm (default 10)'),
    hard: z.boolean().optional().describe('true for hard/intersection clashes, false for soft/clearance'),
    excludeSelf: z.boolean().optional().describe('Exclude self-clashes within same model'),
  }
);

browserTool(
  'set_detection_rules',
  'Update clash detection settings without running detection.',
  {
    maxGap: z.number().optional().describe('Gap tolerance in mm'),
    hard: z.boolean().optional().describe('Hard clash mode'),
    excludeSelf: z.boolean().optional().describe('Exclude self-clashes'),
    duplicates: z.boolean().optional().describe('Include duplicates'),
  }
);

// Clash management
browserTool(
  'update_clash',
  'Update a specific clash: change status, priority, assignee, or title.',
  {
    clashIndex: z.number().describe('Clash index (0-based) in the current list'),
    status: z.enum(['open', 'resolved']).optional(),
    priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
    assignee: z.string().optional(),
    title: z.string().optional(),
  }
);

browserTool(
  'batch_update_clashes',
  'Bulk update multiple clashes by filter.',
  {
    action: z.enum(['resolve', 'set_priority', 'set_status']).describe('Action to perform'),
    filter: z.enum(['duplicates', 'soft', 'hard', 'all']).describe('Which clashes to target'),
    value: z.string().optional().describe('New value for the action'),
  }
);

// View controls
browserTool(
  'set_view',
  'Set the 3D camera to a preset angle.',
  {
    view: z.enum(['top', 'front', 'back', 'left', 'right', 'isometric', 'reset']).describe('Camera preset'),
  }
);

browserTool(
  'set_render_style',
  'Change the 3D rendering style.',
  {
    style: z.enum(['wireframe', 'shaded', 'rendered', 'standard']).describe('Render style'),
  }
);

browserTool(
  'set_section',
  'Add or clear a section cut plane.',
  {
    axis: z.enum(['x', 'y', 'z', 'none']).describe('Cut axis, or "none" to clear'),
  }
);

browserTool(
  'color_by',
  'Color model elements by a property.',
  {
    by: z.enum(['type', 'storey', 'discipline', 'material', 'none']).describe('Color grouping'),
  }
);

browserTool(
  'set_theme',
  'Switch UI theme.',
  { theme: z.enum(['dark', 'light']) }
);

browserTool(
  'set_visibility',
  'Show or hide UI overlays.',
  {
    option: z.enum(['grid', 'axes', 'markers']).describe('What to toggle'),
    visible: z.boolean().describe('true to show, false to hide'),
  }
);

browserTool(
  'restore_visibility',
  'Restore all hidden/ghosted/isolated elements to full visibility.',
  {}
);

// Navigation
browserTool(
  'fly_to_clash',
  'Fly the camera to a specific clash by index.',
  { clashIndex: z.number().describe('Clash index (0-based)') }
);

browserTool(
  'navigate_tab',
  'Switch to a UI tab.',
  { tab: z.enum(['models', 'clashes', 'issues', 'navigator', 'ai']) }
);

// Filtering & sorting
browserTool(
  'filter_clashes',
  'Filter the clash list.',
  {
    status: z.enum(['open', 'resolved', 'all']).optional(),
    priority: z.enum(['critical', 'high', 'normal', 'low', 'all']).optional(),
  }
);

browserTool(
  'sort_clashes',
  'Sort the clash list.',
  {
    sortBy: z.enum(['priority', 'status', 'type', 'storey', 'date', 'distance']),
  }
);

browserTool(
  'group_clashes',
  'Group clashes by a category.',
  {
    groupBy: z.enum(['storey', 'discipline', 'status', 'type', 'none']),
  }
);

// Export
browserTool(
  'export_bcf',
  'Export clashes/issues as a BCF file (triggers download in browser).',
  {
    version: z.enum(['2.1', '3.0']).optional().describe('BCF version (default 2.1)'),
  }
);

// Projects
browserTool(
  'create_project',
  'Create a new project.',
  { name: z.string().describe('Project name') }
);

browserTool(
  'switch_project',
  'Switch to an existing project by name.',
  { name: z.string().describe('Project name or substring') }
);

// Measurement
browserTool(
  'measure',
  'Start or stop measurement mode.',
  {
    mode: z.enum(['length', 'angle', 'area', 'stop', 'clear']).describe('Measurement mode'),
  }
);

// Walk mode
browserTool(
  'walk_mode',
  'Enter or exit first-person walk mode.',
  { enabled: z.boolean().describe('true to enter, false to exit') }
);

// ── Start ─────────────────────────────────────────────────────────

async function main() {
  startWsBridge();
  process.stderr.write('[Smart Bridge MCP] WebSocket bridge on ws://127.0.0.1:' + WS_PORT + '\n');
  process.stderr.write('[Smart Bridge MCP] Waiting for Claude to connect via stdio...\n');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[Smart Bridge MCP] Connected to Claude\n');
}

main().catch((e) => {
  process.stderr.write('[Smart Bridge MCP] Fatal: ' + e.message + '\n');
  process.exit(1);
});
