#!/usr/bin/env node
'use strict';
/**
 * ClashControl MCP Server — standalone, zero npm dependencies (Node 18+ required).
 *
 * ── One-time setup (auto-configures Claude Desktop and exits) ─────────────────
 *   node mcp-server.js --install
 *
 * ── Manual config location ────────────────────────────────────────────────────
 *   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   Windows: %APPDATA%\Claude\claude_desktop_config.json
 *   Linux:   ~/.config/claude-desktop/claude_desktop_config.json
 *
 *   Add inside the root { }:
 *   "mcpServers": {
 *     "clashcontrol": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/ClashControl/mcp-server.js"]
 *     }
 *   }
 *
 * ── Runtime requirement ───────────────────────────────────────────────────────
 * The SmartBridge binary must be running. Open ClashControl in your browser
 * and enable the Smart Bridge addon. The binary serves the REST API on port 19803.
 */

const PORT = process.env.CLASHCONTROL_PORT || '19803';
const BASE = `http://127.0.0.1:${PORT}`;

// ── One-time install mode ─────────────────────────────────────────────────────
// Detects two scenarios:
//  1. Explicit flag: node mcp-server.js --install
//  2. Run directly in a terminal (stdin is a TTY — Claude Desktop always pipes stdin)
if (process.argv.includes('--install') || process.stdin.isTTY) {
  (function install() {
    const os   = require('os');
    const fs   = require('fs');
    const path = require('path');

    let cfgPath;
    if (process.platform === 'win32') {
      cfgPath = path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'Claude', 'claude_desktop_config.json'
      );
    } else if (process.platform === 'darwin') {
      cfgPath = path.join(
        os.homedir(), 'Library', 'Application Support', 'Claude',
        'claude_desktop_config.json'
      );
    } else {
      cfgPath = path.join(
        os.homedir(), '.config', 'claude-desktop',
        'claude_desktop_config.json'
      );
    }

    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { /* new file */ }

    if (!cfg.mcpServers) cfg.mcpServers = {};
    cfg.mcpServers.clashcontrol = {
      command: process.execPath,  // absolute path to the node binary
      args: [__filename]          // absolute path to this script
    };

    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      console.log('\u2713 ClashControl MCP server configured!');
      console.log('  Config written to: ' + cfgPath);
      console.log('  Restart Claude Desktop to apply.');
    } catch (err) {
      console.error('\u2717 Could not write config: ' + err.message);
      console.error('  Add manually to ' + cfgPath + ':');
      console.error('  "mcpServers": { "clashcontrol": { "command": "node", "args": ["' + __filename.replace(/\\/g, '\\\\') + '"] } }');
    }
    process.exit(0);
  })();
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_status',
    description:
      'Returns a snapshot of the current ClashControl session: loaded models — each with discipline, ' +
      'element count, source ("revit-direct" for a live Revit link, else "ifc"), version, lastSync, ' +
      'and a coarse revision stamp — plus total clash and issue counts, active detection rules (gap ' +
      'tolerance, hard/soft mode), current UI tab, walk mode state, and theme. Use this first to ' +
      "understand what the user is working with, and use each model's revision/lastSync to check " +
      'whether CC is in sync with another live tool (e.g. PDRA on the same Revit model). ' +
      'Also returns connector:{state ("receiving"|"ready"|"disconnected"), ingesting, percent, ' +
      'elementCount, documentName}: when connector.ingesting is true the Revit model is still ' +
      'streaming in (modelCount shows the slot before data is complete), so DO NOT act on model or ' +
      'clash data until connector.state === "ready". Plus detecting/detectionProgress and lastDetectionError.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_clashes',
    description:
      'Retrieves detected clash pairs between elements. Each clash includes index, title, status, ' +
      'priority, storey, typeA/typeB, nameA/nameB, distance (mm), elevation (m), disciplines (the two ' +
      "sides' disciplines — use to tell arch×structural, e.g. an expected floor build-up, from a " +
      'same-discipline real problem), and AI severity/category. Stable element identity per side: ' +
      'uniqueIdA/uniqueIdB (Revit UniqueId — the most reliable cross-document join key; prefer this), ' +
      'globalIdA/globalIdB (IFC GlobalId), revitIdA/revitIdB (Revit ElementId, doc-local). Plus ' +
      'classificationA/classificationB ({system, code} NL-SfB/Uniclass — the join key to finance/ERP & ' +
      'specs) and modelAId/modelBId. Also gridBay — the nearest structural-grid bay (e.g. "A-3") for ' +
      'the clash point when grids are loaded via the Revit bridge, for "near grid A-3" queries. ' +
      'Filter by status and limit results.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'open', 'resolved', 'approved', 'expected', 'closed'],
          description: "Filter clashes by status. 'expected' = the suppressed/by-design bucket. Omit or 'all' for everything.",
        },
        category: {
          type: 'string',
          description: "Filter by AI category (e.g. 'false_positive', 'needs_review', 'penetration').",
        },
        limit: {
          type: 'number',
          description: 'Max clashes to return. Default 50.',
        },
        offset: {
          type: 'number',
          description: 'Start index for pagination — page the full set with offset+limit.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_clash_summary',
    description:
      'Aggregate profile of the WHOLE clash set without paging it: total/open and counts byStatus, ' +
      'byCategory (AI), byDiscipline (pair), byTypePair (top N), byStorey. Use this to find the few ' +
      'root causes behind a large clash count before drilling in with get_clashes(offset).',
    inputSchema: {
      type: 'object',
      properties: { topN: { type: 'number', description: 'Max entries per ranked list (type-pair, storey). Default 20.' } },
      required: [],
    },
  },
  {
    name: 'get_element_quality',
    description:
      'Per-element data-quality annotations keyed by uniqueId/globalId — a parallel triage signal, NOT ' +
      'a detection gate (flagged elements are still clashed, just down-rankable). Flags: untyped_proxy, ' +
      'no_classification, degenerate_bbox (no geometry/zero size), oversized_bbox (>200 m). Returns only ' +
      'flagged elements.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Limit to one model. Omit for all.' },
        limit: { type: 'number', description: 'Max annotations. Default 1000.' },
      },
      required: [],
    },
  },
  {
    name: 'get_levels',
    description:
      'Per-model level/storey elevations (raw `elevation` in model units + `elevationM` in metres when ' +
      'unitScale is known) so a consumer can compute floor build-up bands. get_clashes.elevation is in ' +
      'scene metres — reconcile on that.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_grids',
    description:
      'Structural grid axis names (e.g. "A", "B", "1", "2") brought into ClashControl via the Revit ' +
      'bridge. Pair with get_clashes.gridBay (each clash\'s nearest grid bay, e.g. "A-3") to locate or ' +
      'filter clashes by grid position. Empty for plain IFC loads (grids come from the live Revit link).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_issues',
    description:
      'Retrieves coordination issues (manually created or promoted from clashes). Each issue ' +
      'includes index, title, status, priority, assignee, description, and the IFC GlobalIds of the ' +
      'elements it involves (globalIds[]) plus Revit ElementIds when present (revitIdA/revitIdB) for ' +
      'cross-tool joins.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'open', 'in_progress', 'resolved', 'closed'],
          description: "Filter issues by status. Omit or 'all' for everything.",
        },
        limit: {
          type: 'number',
          description: 'Max issues to return. Default 50.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_element_by_guid',
    description:
      'Resolves loaded element(s) by Revit UniqueId, IFC GlobalId, or Revit ElementId — the inverse of ' +
      'the clash identity: turn a key from another tool (e.g. a Revit/PDRA element) into the matching ' +
      'ClashControl element with its model, expressId, uniqueId, ifcType, name, storey, material and ' +
      'classification. Prefer uniqueId (most reliable cross-document key). Accepts a single ' +
      'uniqueId/globalId/revitId or arrays uniqueIds[]/globalIds[]/revitIds[].',
    inputSchema: {
      type: 'object',
      properties: {
        uniqueId: { type: 'string', description: 'A single Revit UniqueId to resolve (most reliable).' },
        globalId: { type: 'string', description: 'A single IFC GlobalId to resolve.' },
        revitId: { type: 'string', description: 'A single Revit ElementId to resolve.' },
        uniqueIds: { type: 'array', items: { type: 'string' }, description: 'Multiple Revit UniqueIds.' },
        globalIds: { type: 'array', items: { type: 'string' }, description: 'Multiple IFC GlobalIds.' },
        revitIds: { type: 'array', items: { type: 'string' }, description: 'Multiple Revit ElementIds.' },
        limit: { type: 'number', description: 'Max elements to return. Default 50.' },
      },
      required: [],
    },
  },
  {
    name: 'resync',
    description:
      'Forces the live Revit link to re-pull the model so ClashControl matches the current Revit state. ' +
      'Use before a cross-tool join when get_status shows CC is behind the live model. Live-link only — ' +
      'a no-op for static IFC file loads. Re-check get_status afterwards for the updated revision.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_detection',
    description:
      'Starts clash detection between loaded models. Optionally set which models to compare, ' +
      'gap tolerance in mm, and whether to detect only hard clashes (physical intersections). ' +
      'modelA/modelB accept: "all", a model name, "disc:<discipline>" (e.g. disc:architectural, ' +
      'disc:structural, disc:mep — disciplines come from get_status), or "tag:<tag>". ' +
      'Use disc: on both sides to scope to cross-discipline pairs only (e.g. modelA "disc:architectural", ' +
      'modelB "disc:structural") and cut same-discipline noise at source. ' +
      'Rooms/spaces (IfcSpace) are excluded by default — set includeSpaces:true to clash against rooms ' +
      '(space-intrusion checks). ' +
      'Results appear in get_clashes after detection completes. Detection is async — if it fails ' +
      '(e.g. a very large federation), get_status.lastDetectionError reports the message + stack.',
    inputSchema: {
      type: 'object',
      properties: {
        modelA: { type: 'string', description: "First side: 'all', a model name, 'disc:<discipline>', or 'tag:<tag>'. Omit for all models." },
        modelB: { type: 'string', description: "Second side: 'all', a model name, 'disc:<discipline>', or 'tag:<tag>'. Omit for all models." },
        maxGap: { type: 'number', description: 'Gap tolerance in mm. Elements within this distance count as clashing. Default 10mm.' },
        hard: { type: 'boolean', description: 'True = detect only hard clashes (physical intersections).' },
        excludeSelf: { type: 'boolean', description: 'True = skip clashes within the same model.' },
        includeSpaces: { type: 'boolean', description: 'True = include rooms/spaces (IfcSpace) in detection for space-intrusion checks. Default false (rooms excluded).' },
      },
      required: [],
    },
  },
  {
    name: 'run_detection_ruleset',
    description:
      'Rule-based / cross-discipline detection (Solibri-style): runs several scoped rules — each a ' +
      'discipline/model pair with its own gap — and returns the UNION (deduped). Cuts clash volume ' +
      'at source vs a flat all-vs-all run; hosted/by-design pairs are excluded at detection time. ' +
      "With no rules[], preset 'cross_discipline' auto-builds every distinct discipline pair present " +
      '(arch×structural, arch×mep, structural×mep). Async — results via get_clashes.',
    inputSchema: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          description: 'Rules, each: { disciplineA, disciplineB } (or modelA/modelB names) plus optional maxGap (mm) and hard. Omit to use the cross_discipline preset.',
          items: { type: 'object' },
        },
        preset: { type: 'string', description: "Ruleset preset. 'cross_discipline' (default) = all distinct discipline pairs." },
        maxGap: { type: 'number', description: 'Default gap tolerance (mm) for rules that omit one.' },
        hard: { type: 'boolean', description: 'Default hard/soft for rules that omit it.' },
      },
      required: [],
    },
  },
  {
    name: 'cancel_detection',
    description:
      'Resets a stuck/wedged detection (clears the detecting flag) so a fresh run_detection can ' +
      'start — recovers from a hung run without a browser/SmartBridge restart.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ingest_detection_feedback',
    description:
      "Receiver for an orchestrator's (Loam's) outcome feedback. Feed back which detection " +
      'suppressions turned out to eat REAL clashes so CC stops auto-suppressing them. ' +
      "feedback.byPair[].key is an element-type pair (e.g. 'IfcSlab x IfcSlab'); realRate = " +
      'real/(real+false). On the next run, pairs with realRate >= 0.34 are no longer auto-suppressed ' +
      'by the type-pair memo. Stored per projectKey, survives refresh; round-trip is visible in ' +
      'get_status.detectionFeedback. byRule is stored for inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'Partition key (revit:<uid>). Omit to use the current session projectKey.' },
        feedback: {
          type: 'object',
          description: 'Object with byRule[] and byPair[] arrays of {key, real, false, realRate, recommendation}.',
        },
      },
      required: ['feedback'],
    },
  },
  {
    name: 'set_detection_rules',
    description:
      'Updates clash detection parameters without running detection. Configures gap tolerance, ' +
      'hard/soft mode, self-clash exclusion, and duplicate handling for subsequent detection runs.',
    inputSchema: {
      type: 'object',
      properties: {
        maxGap: { type: 'number', description: 'Gap tolerance in mm.' },
        hard: { type: 'boolean', description: 'True = hard clashes only.' },
        excludeSelf: { type: 'boolean', description: 'True = skip intra-model clashes.' },
        duplicates: { type: 'boolean', description: 'True = include duplicate/overlapping element clashes.' },
      },
      required: [],
    },
  },
  {
    name: 'update_clash',
    description:
      'Updates a single clash by its index (0-based, from get_clashes). Change status, priority, ' +
      "assignee, or title. Use status 'expected' (NOT 'resolved') for by-design / false-positive " +
      "clashes — it's a reversible suppressed bucket, excluded from the open count and re-openable by " +
      "setting status back to 'open'. 'resolved' is for real clashes that were actually fixed.",
    inputSchema: {
      type: 'object',
      properties: {
        clashIndex: { type: 'number', description: '0-based index of the clash from get_clashes results.' },
        status: { type: 'string', enum: ['open', 'resolved', 'approved', 'expected', 'closed'], description: "New status. 'expected' = suppressed/by-design (reversible); 'open' re-opens." },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'New priority level.' },
        assignee: { type: 'string', description: 'Person or team to assign this clash to.' },
        title: { type: 'string', description: 'Override the clash title.' },
      },
      required: ['clashIndex'],
    },
  },
  {
    name: 'batch_update_clashes',
    description:
      'Applies a batch action to multiple clashes matching a natural-language filter. ' +
      "Example: action='resolve', filter='all duct clashes on level 2'.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: "The action to apply: 'resolve', 'approve', 'set priority high', etc." },
        filter: { type: 'string', description: "Natural language filter: 'all MEP clashes', 'clashes on storey 3', etc." },
      },
      required: ['action', 'filter'],
    },
  },
  {
    name: 'filter_clashes',
    description: 'Applies status and/or priority filters to the clash list in the UI.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'open', 'resolved', 'approved'], description: 'Show only clashes with this status.' },
        priority: { type: 'string', enum: ['all', 'low', 'normal', 'high', 'critical'], description: 'Show only clashes with this priority.' },
      },
      required: [],
    },
  },
  {
    name: 'sort_clashes',
    description: "Sorts the clash list in the UI by a given field.",
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: { type: 'string', description: "Field to sort by: 'status', 'priority', 'storey', 'typeA', 'typeB', 'distance', 'severity'." },
      },
      required: ['sortBy'],
    },
  },
  {
    name: 'group_clashes',
    description: "Groups the clash list by a field or removes grouping with 'none'.",
    inputSchema: {
      type: 'object',
      properties: {
        groupBy: { type: 'string', description: "Field to group by: 'storey', 'typeA', 'typeB', 'aiSeverity', 'aiCategory', or 'none' to ungroup." },
      },
      required: ['groupBy'],
    },
  },
  {
    name: 'fly_to_clash',
    description:
      'Animates the 3D camera to focus on a specific clash by its index. Selects the clash ' +
      'in the UI panel and highlights the two conflicting elements.',
    inputSchema: {
      type: 'object',
      properties: {
        clashIndex: { type: 'number', description: '0-based index of the clash to navigate to (from get_clashes).' },
      },
      required: ['clashIndex'],
    },
  },
  {
    name: 'set_view',
    description:
      'Changes the 3D camera to a standard view. Use when the user asks to see the model from ' +
      'a specific angle or wants to reset the camera position.',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['top', 'front', 'back', 'left', 'right', 'isometric', 'reset'],
          description: 'The camera view to set.',
        },
      },
      required: ['view'],
    },
  },
  {
    name: 'set_render_style',
    description: 'Changes how the 3D model is rendered. Affects visual appearance without modifying model data.',
    inputSchema: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          enum: ['standard', 'shaded', 'rendered', 'wireframe'],
          description: 'Render style.',
        },
      },
      required: ['style'],
    },
  },
  {
    name: 'set_section',
    description:
      'Creates a section cutting plane along an axis to reveal interior geometry, or removes it. ' +
      'Optionally place the cut at an absolute world-space position along the chosen axis.',
    inputSchema: {
      type: 'object',
      properties: {
        axis: {
          type: 'string',
          enum: ['x', 'y', 'z', 'none'],
          description: "Cutting axis. 'none' removes the section plane.",
        },
        position: {
          type: 'number',
          description: 'Absolute world-space coordinate (metres) along the axis where the cut is placed. Omit to cut at the model centre.',
        },
      },
      required: ['axis'],
    },
  },
  {
    name: 'set_section_at',
    description:
      'Places a section plane at an absolute world-space position on the given axis. ' +
      'More precise than set_section when you know the exact coordinate.',
    inputSchema: {
      type: 'object',
      properties: {
        axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Cutting axis.' },
        position: { type: 'number', description: 'Absolute world-space coordinate in metres.' },
        cutHeight: { type: 'number', description: 'Optional height for horizontal cuts (alias for position on Y axis).' },
      },
      required: ['axis', 'position'],
    },
  },
  {
    name: 'color_by',
    description:
      "Colors all elements in the 3D view by a classification field. 'none' resets to original materials.",
    inputSchema: {
      type: 'object',
      properties: {
        by: { type: 'string', description: "Color scheme: 'discipline', 'type', 'storey', 'model', 'status', or 'none' to reset." },
      },
      required: ['by'],
    },
  },
  {
    name: 'set_theme',
    description: 'Switches the ClashControl interface between dark and light themes.',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['dark', 'light'], description: 'Theme to apply.' },
      },
      required: ['theme'],
    },
  },
  {
    name: 'set_visibility',
    description: 'Toggles visibility of UI overlays in the 3D view: the reference grid, coordinate axes, or clash markers.',
    inputSchema: {
      type: 'object',
      properties: {
        option: { type: 'string', enum: ['grid', 'axes', 'markers'], description: 'Which overlay to toggle.' },
        visible: { type: 'boolean', description: 'True to show, false to hide.' },
      },
      required: ['option', 'visible'],
    },
  },
  {
    name: 'restore_visibility',
    description: 'Unhides all ghosted/hidden IFC elements, restoring full model visibility.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'isolate_elements',
    description:
      'Ghosts or hides elements not matching a filter (ifcType, storey, discipline, material, expressIds). ' +
      "mode: 'ghost' (transparent), 'hide' (invisible), 'show_all' (restore).",
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['ghost', 'hide', 'show_all'], description: "Isolation mode. Default 'ghost'." },
        ifcType: { type: 'string', description: "IFC element type to keep visible, e.g. 'IfcDuctSegment'." },
        storey: { type: 'string', description: 'Storey name to keep visible.' },
        discipline: { type: 'string', description: 'Discipline to keep visible.' },
        material: { type: 'string', description: 'Material name to keep visible.' },
        expressIds: { type: 'array', items: { type: 'number' }, description: 'Specific element express IDs to keep visible.' },
      },
      required: [],
    },
  },
  {
    name: 'navigate_tab',
    description: "Switches the active panel tab in ClashControl's sidebar.",
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: "Tab name: 'clashes', 'issues', 'models', 'settings', 'addons'." },
      },
      required: ['tab'],
    },
  },
  {
    name: 'measure',
    description:
      "Controls the measurement tool in the 3D view. Start point-to-point or edge measurement, " +
      "stop the active measurement, or clear all measurement annotations.",
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['point', 'edge', 'stop', 'clear'],
          description: "'point' = point-to-point distance, 'edge' = edge measurement, 'stop' = deactivate, 'clear' = remove all.",
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'walk_mode',
    description: 'Enables or disables first-person walk mode for navigating through the building model at eye level.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'True to enter walk mode, false to exit.' },
      },
      required: ['enabled'],
    },
  },
  {
    name: 'get_model_bounds',
    description: 'Returns the bounding box of all loaded models: min, max, center, size (in metres).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_camera',
    description: 'Returns current camera position, look-at target point, and orbit distance.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pan_camera',
    description: 'Pans the 3D camera by a world-space offset (metres).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X offset in metres.' },
        y: { type: 'number', description: 'Y offset in metres.' },
        z: { type: 'number', description: 'Z offset in metres.' },
      },
      required: [],
    },
  },
  {
    name: 'set_camera',
    description: 'Flies the camera to a new position and look-at target.',
    inputSchema: {
      type: 'object',
      properties: {
        px: { type: 'number', description: 'Camera X position in metres.' },
        py: { type: 'number', description: 'Camera Y position in metres.' },
        pz: { type: 'number', description: 'Camera Z position in metres.' },
        tx: { type: 'number', description: 'Look-at target X in metres.' },
        ty: { type: 'number', description: 'Look-at target Y in metres.' },
        tz: { type: 'number', description: 'Look-at target Z in metres.' },
      },
      required: ['px', 'py', 'pz', 'tx', 'ty', 'tz'],
    },
  },
  {
    name: 'zoom_to_bounds',
    description: 'Fits the camera to show all model geometry.',
    inputSchema: {
      type: 'object',
      properties: {
        padding: { type: 'number', description: 'Extra padding factor (default 1.0).' },
      },
      required: [],
    },
  },
  {
    name: 'send_nl_command',
    description: 'Sends a natural-language command directly to the ClashControl NL engine for local processing.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: "Natural language command, e.g. 'show all MEP clashes on level 2'." },
      },
      required: ['command'],
    },
  },
  {
    name: 'list_storeys',
    description:
      'Returns all building storeys (floors) found in the loaded IFC models, with their names and ' +
      'elevations. Call before create_2d_sheet to discover available floor names and heights.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_2d_sheet',
    description:
      'Creates a persistent 2D floor plan sheet at a specified storey or elevation and switches ' +
      'the viewer to 2D sheet mode. The sheet is added to the project sheet list. ' +
      'Use list_storeys first to discover valid storey names. Returns the new sheet ID.',
    inputSchema: {
      type: 'object',
      properties: {
        floorName: { type: 'string', description: "Storey name, e.g. 'Ground Floor' or 'Level 2'. Fuzzy matched. Takes priority over height." },
        height: { type: 'number', description: 'Cut elevation in metres above project origin. Used when floorName is not provided.' },
        scale: { type: 'string', description: "Drawing scale as a ratio string, e.g. '1:100', '1:50'. Default '1:100'." },
        format: { type: 'string', enum: ['png', 'pdf', 'dxf'], description: 'If provided, automatically exports the sheet in this format after creating it.' },
      },
      required: [],
    },
  },
  {
    name: 'list_2d_sheets',
    description:
      'Returns all 2D floor plan sheets in the current project with their IDs, names, storey ' +
      'names, elevations, and annotation counts. Also returns the active sheet ID.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'export_sheet',
    description:
      'Exports a floor plan sheet as PNG, PDF, or DXF. If sheetId is omitted, exports the ' +
      'currently active sheet.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetId: { type: 'string', description: 'ID of the sheet to export (from list_2d_sheets). Omit to use the active sheet.' },
        format: { type: 'string', enum: ['png', 'pdf', 'dxf'], description: "Export format. Default 'png'." },
      },
      required: [],
    },
  },
  {
    name: 'delete_sheet',
    description: 'Permanently deletes a floor plan sheet and all its annotations. Use list_2d_sheets to get valid sheet IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetId: { type: 'string', description: 'ID of the sheet to delete (from list_2d_sheets).' },
      },
      required: ['sheetId'],
    },
  },
  {
    name: 'exit_floor_plan',
    description: 'Returns the viewer from 2D floor plan mode back to the standard 3D perspective view.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pan_2d_sheet',
    description: 'Moves the 2D floor plan canvas by a pixel offset. Positive x pans right, positive y pans down.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal pan in pixels. Positive = right.' },
        y: { type: 'number', description: 'Vertical pan in pixels. Positive = down.' },
      },
      required: [],
    },
  },
  {
    name: 'zoom_2d_sheet',
    description: 'Sets the zoom level of the 2D floor plan canvas. 1.0 = 100%, 2.0 = 200%, 0.5 = 50%. Valid range 0.05–50.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Zoom multiplier. 1.0 = natural size, 2.0 = double, 0.5 = half.' },
      },
      required: ['level'],
    },
  },
  {
    name: 'fit_2d_bounds',
    description: 'Auto-fits the 2D floor plan view to show all geometry. Resets pan and zoom so the full floor plan is centred.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_annotation',
    description:
      'Adds a markup annotation (text, pin, line, rect, arrow) to the active 2D floor plan sheet. ' +
      'Coordinates are in world-space metres. Requires an active sheet — call create_2d_sheet first.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['text', 'pin', 'line', 'rect', 'arrow'], description: "Annotation type. Default 'text'." },
        x: { type: 'number', description: 'World X coordinate of the annotation start point (metres).' },
        y: { type: 'number', description: 'World Z coordinate of the annotation start point (metres).' },
        x2: { type: 'number', description: 'World X of the end point (for line, rect, arrow).' },
        y2: { type: 'number', description: 'World Z of the end point (for line, rect, arrow).' },
        text: { type: 'string', description: 'Label text for text and pin annotations.' },
        color: { type: 'string', description: "Hex color, e.g. '#f59e0b'. Default amber." },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'measure_on_sheet',
    description:
      'Adds a dimension annotation between two world-space points on the active 2D sheet. ' +
      'Calculates and labels the distance in mm or m.',
    inputSchema: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: 'Four world-space coordinates [x1, z1, x2, z2] in metres defining the two endpoints.',
        },
        color: { type: 'string', description: 'Hex color for the dimension line. Default light blue.' },
      },
      required: ['points'],
    },
  },
  {
    name: 'promote_clash_to_issue',
    description:
      'Promote a detected clash (by 0-based clashIndex, or many via items[]) to a coordination issue, ' +
      'COPYING its element identity (uniqueIdA/B, globalIdA/B, revitIdA/B), storey, types, disciplines ' +
      'and classification — so the Issue is joinable back to the model / Loam (a plain create_issue ' +
      'would have globalIds:[]). Links the clash to the issue (linkedIssueId); does NOT resolve the clash.',
    inputSchema: {
      type: 'object',
      properties: {
        clashIndex: { type: 'number', description: '0-based index of the clash to promote (from get_clashes).' },
        items: { type: 'array', description: 'Promote many: array of { clashIndex, title?, description?, priority?, assignee? }.', items: { type: 'object' } },
        title: { type: 'string', description: 'Override issue title (defaults to the clash title).' },
        description: { type: 'string', description: 'Override description (defaults to the clash AI reason).' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Issue priority.' },
        assignee: { type: 'string', description: 'Person or team responsible.' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description:
      'Creates a coordination issue in ClashControl. For element linkage (so the issue can be joined ' +
      'back to the model/Loam), pass globalIds[]/revitIds[]/uniqueIds[] or per-side globalIdA/B, ' +
      'revitIdA/B, uniqueIdA/B, plus storey/classification. To promote a detected clash, prefer ' +
      'promote_clash_to_issue (copies the element identity automatically).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title.' },
        description: { type: 'string', description: 'Detailed issue description.' },
        status: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'], description: "Initial status. Default 'open'." },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: "Priority. Default 'normal'." },
        assignee: { type: 'string', description: 'Person or team responsible.' },
        category: { type: 'string', description: "Issue category, e.g. 'coordination', 'design', 'rfi'." },
        globalIds: { type: 'array', description: 'IFC GlobalIds of involved elements.', items: { type: 'string' } },
        revitIds: { type: 'array', description: 'Revit ElementIds of involved elements.', items: { type: 'number' } },
        uniqueIds: { type: 'array', description: 'Revit UniqueIds of involved elements (preferred join key).', items: { type: 'string' } },
        storey: { type: 'string', description: 'Storey/level the issue sits on.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_issue',
    description: 'Updates a coordination issue by its 0-based index (from get_issues).',
    inputSchema: {
      type: 'object',
      properties: {
        issueIndex: { type: 'number', description: '0-based index of the issue to update.' },
        status: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'], description: 'New status.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'New priority.' },
        assignee: { type: 'string', description: 'New assignee.' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
      },
      required: ['issueIndex'],
    },
  },
  {
    name: 'delete_issue',
    description: 'Deletes a coordination issue by its 0-based index (from get_issues).',
    inputSchema: {
      type: 'object',
      properties: {
        issueIndex: { type: 'number', description: '0-based index of the issue to delete.' },
      },
      required: ['issueIndex'],
    },
  },
  {
    name: 'export_bcf',
    description:
      'Exports all clashes or issues as a BCF (BIM Collaboration Format) ZIP file. ' +
      'BCF is the industry standard for sharing coordination issues between BIM tools.',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', enum: ['2.1', '3.0'], description: "BCF version. Default '2.1' for maximum compatibility." },
      },
      required: [],
    },
  },
  {
    name: 'create_project',
    description: 'Creates a new project in ClashControl to organise clashes and issues.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Project name, e.g. 'MEP Coordination Phase 2'." },
      },
      required: ['name'],
    },
  },
  {
    name: 'switch_project',
    description: 'Switches to an existing project by name (fuzzy match). Loads that project\'s clashes, issues, and detection rules.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Project name or partial match, e.g. 'MEP' matches 'MEP Coordination'." },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_model',
    description: 'Removes a loaded IFC model from the current session by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the model to remove (partial match supported).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'rename_model',
    description: 'Renames a loaded IFC model and optionally updates its discipline.',
    inputSchema: {
      type: 'object',
      properties: {
        oldName: { type: 'string', description: 'Current model name (partial match supported).' },
        newName: { type: 'string', description: 'New display name for the model.' },
        discipline: { type: 'string', description: "New discipline, e.g. 'Structural', 'MEP', 'Architectural'." },
      },
      required: ['oldName', 'newName'],
    },
  },
  {
    name: 'get_model_info',
    description: 'Returns element list and metadata for a specific loaded IFC model: element count, storeys, stats, visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name (partial match supported).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'toggle_model',
    description: 'Shows or hides a loaded IFC model by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name (partial match supported).' },
        visible: { type: 'boolean', description: 'True to show, false to hide.' },
      },
      required: ['name', 'visible'],
    },
  },
  {
    name: 'run_data_quality',
    description: 'Runs BIM/ILS data quality checks on all loaded models and returns structured results.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ── HTTP bridge helper ────────────────────────────────────────────────────────

async function callBridge(toolName, params) {
  try {
    const res = await fetch(`${BASE}/call/${toolName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        content: [{ type: 'text', text: `SmartBridge error [${res.status}]: ${body}` }],
        isError: true,
      };
    }

    const data = await res.json();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('fetch failed')) {
      return {
        content: [{
          type: 'text',
          text: 'ClashControl SmartBridge is not running. Open ClashControl in your browser and enable the Smart Bridge addon.',
        }],
        isError: true,
      };
    }
    if (msg.includes('AbortError') || msg.includes('timeout') || msg.includes('The operation was aborted')) {
      return {
        content: [{ type: 'text', text: 'Request timed out. The operation may be processing a large IFC model.' }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `Bridge error: ${msg}` }], isError: true };
  }
}

// ── MCP stdio transport ───────────────────────────────────────────────────────
// Protocol: the MCP stdio transport is NEWLINE-DELIMITED JSON — each JSON-RPC
// message is a single line terminated by "\n", with no embedded newlines. (This
// is NOT the LSP "Content-Length" framing — using that makes Claude Desktop fail
// the initialize handshake with "Could not attach to MCP server".)
// stdout is SACRED — only JSON-RPC messages go there. All logging uses stderr.

let _inputBuf = '';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

process.stdin.on('data', (chunk) => {
  _inputBuf += chunk.toString('utf8');
  let idx;
  while ((idx = _inputBuf.indexOf('\n')) !== -1) {
    const line = _inputBuf.slice(0, idx).trim();
    _inputBuf = _inputBuf.slice(idx + 1);
    if (!line) continue; // tolerate blank lines / \r\n

    let msg;
    try { msg = JSON.parse(line); }
    catch (e) { console.error('[mcp] JSON parse error:', e.message); continue; }

    handle(msg).catch((e) => console.error('[mcp] handle error:', e));
  }
});

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'clashcontrol-mcp', version: '1.0.0' },
        instructions:
          'Connects to ClashControl, a local IFC clash detection application. ' +
          'Use these tools when users ask about BIM clashes, IFC model analysis, element conflicts, ' +
          'spatial coordination, clash resolution, or 2D floor plan generation. ' +
          'The SmartBridge must be running (ClashControl open in browser, Smart Bridge addon enabled).',
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return; // no response needed

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = (params && params.arguments) || {};

    if (!toolName) {
      send({
        jsonrpc: '2.0', id,
        error: { code: -32602, message: 'Missing tool name' },
      });
      return;
    }

    const known = TOOLS.find((t) => t.name === toolName);
    if (!known) {
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        },
      });
      return;
    }

    const result = await callBridge(toolName, toolArgs);
    send({ jsonrpc: '2.0', id, result });
    return;
  }

  // Unknown method — return error only if it had an id (requests, not notifications)
  if (id !== undefined && id !== null) {
    send({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (err) => { console.error('[mcp] Fatal:', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('[mcp] Unhandled:', err); process.exit(1); });

console.error('[mcp] ClashControl MCP server ready (51 tools). Waiting for Claude Desktop…');
