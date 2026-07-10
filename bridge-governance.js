'use strict';
/**
 * ClashControl Smart Bridge — tool governance
 *
 * Every one of the 51 tools in mcp-server.js / addons/smart-bridge.js reaches
 * a live project through smart-bridge-server.js's callBrowser(). Until now
 * that path had no policy layer: an LLM (or any local process that can reach
 * the REST/MCP surface) could call delete_model, delete_issue, delete_sheet,
 * batch_update_clashes, or import_bcf and it would execute immediately, with
 * no audit trail and no chance to reconsider.
 *
 * This mirrors PDRA's autonomy-gate model (Services/Ai/Audit/AutonomyGate.cs):
 * classify each tool's blast radius, let read-only and easily-reversible
 * calls through untouched (Auto), and require an explicit `confirm: true` on
 * the first call to anything destructive (Confirm) — a steered error names
 * the tool and tells the caller exactly how to proceed, instead of silently
 * executing or silently refusing.
 *
 * Kill switch: set CLASHCONTROL_AUTONOMY_GATE=off to disable enforcement
 * entirely (still logs). Session cap: CLASHCONTROL_AUTONOMY=auto|confirm|
 * read_only overrides the per-tool tier — 'auto' waves everything through,
 * 'read_only' blocks every mutating call regardless of tier, 'confirm'
 * (default) applies the per-tool classification below.
 */

// Tools that only read state — never mutate the project, the model, or the
// view. Always Auto regardless of session cap (still logged).
const READ_ONLY = new Set([
  'get_status', 'get_clashes', 'get_clash_summary', 'get_element_quality',
  'get_data_quality', 'get_levels', 'get_grids', 'get_issues',
  'get_element_by_guid', 'get_element_properties', 'list_storeys',
  'list_2d_sheets', 'get_model_bounds', 'get_camera', 'get_model_info',
  'run_data_quality', 'takeoff',
]);

// Tools that mutate something, but the something is either pure view/UI
// state (camera, section plane, colors, panels — trivially reset) or a
// project-data change that is itself reversible / additive / recovery-only
// (a wrong 'expected' flag flips back to 'open'; a stuck detection flag
// clears; a created sheet or issue can be deleted the normal way). Auto,
// logged, no confirmation required.
const REVERSIBLE = new Set([
  'send_nl_command', 'fly_to_clash', 'set_view', 'set_render_style',
  'set_section', 'set_section_at', 'color_by', 'set_theme', 'set_visibility',
  'restore_visibility', 'isolate_elements', 'navigate_tab', 'measure',
  'set_measure_units', 'walk_mode', 'pan_camera', 'set_camera',
  'zoom_to_bounds', 'filter_clashes', 'sort_clashes', 'group_clashes',
  'create_2d_sheet', 'pan_2d_sheet', 'zoom_2d_sheet', 'fit_2d_bounds',
  'add_annotation', 'measure_on_sheet', 'exit_floor_plan', 'export_sheet',
  'export_bcf', 'resync', 'cancel_detection', 'set_detection_rules',
  'run_detection', 'run_detection_ruleset', 'update_clash', 'create_issue',
  'update_issue', 'promote_clash_to_issue', 'ingest_detection_feedback',
  'create_project', 'switch_project', 'rename_model', 'toggle_model',
]);

// Everything else is DESTRUCTIVE by default (fail safe for tools added after
// this list, including future ones): bulk mutation with no built-in preview
// (batch_update_clashes), permanent deletion (delete_issue, delete_model,
// delete_sheet), or a bulk external write that can clobber existing project
// data (import_bcf). Requires confirm: true.
const DESTRUCTIVE = new Set([
  'batch_update_clashes', 'delete_issue', 'delete_model', 'delete_sheet',
  'import_bcf',
]);

function classifyTool(name) {
  if (READ_ONLY.has(name)) return 'read_only';
  if (REVERSIBLE.has(name)) return 'reversible';
  if (DESTRUCTIVE.has(name)) return 'destructive';
  // Unknown tool (added to the manifest after this file, or a live-catalog
  // addition not yet classified here): treat as destructive. An
  // unnecessary confirmation prompt is a much smaller cost than silently
  // running an unreviewed mutating tool.
  return 'destructive';
}

function autonomyMode() {
  const v = (process.env.CLASHCONTROL_AUTONOMY || 'confirm').toLowerCase();
  return (v === 'auto' || v === 'read_only') ? v : 'confirm';
}

function gateEnabled() {
  return (process.env.CLASHCONTROL_AUTONOMY_GATE || 'on').toLowerCase() !== 'off';
}

/**
 * Decide whether a tool call may proceed.
 * Returns { allowed: true, tier } or { allowed: false, tier, error } where
 * `error` follows the same { reason, next_step, context } shape PDRA's
 * ToolSteering.Error uses, so a calling LLM can self-correct.
 */
function checkAutonomy(toolName, params) {
  const tier = classifyTool(toolName);

  if (!gateEnabled()) return { allowed: true, tier };

  const mode = autonomyMode();
  if (mode === 'auto') return { allowed: true, tier };

  if (tier === 'read_only') return { allowed: true, tier };

  if (mode === 'read_only') {
    return {
      allowed: false,
      tier,
      error: {
        reason: `The bridge is in read_only mode; '${toolName}' mutates project state.`,
        next_step: 'Ask the user to switch CLASHCONTROL_AUTONOMY away from read_only, or perform this action manually in the app.',
        context: { tool: toolName, tier },
      },
    };
  }

  if (tier === 'reversible') return { allowed: true, tier };

  // tier === 'destructive'
  if (params && params.confirm === true) return { allowed: true, tier };

  return {
    allowed: false,
    tier,
    error: {
      reason: `'${toolName}' is a destructive action (${destructiveReason(toolName)}) and requires explicit confirmation.`,
      next_step: `Resend the same call with "confirm": true in the arguments once you've verified this is what the user wants.`,
      context: { tool: toolName, tier, params: params || {} },
    },
  };
}

function destructiveReason(toolName) {
  switch (toolName) {
    case 'batch_update_clashes': return 'applies to every clash matching a natural-language filter with no preview';
    case 'delete_issue':
    case 'delete_model':
    case 'delete_sheet': return 'permanently deletes data with no undo';
    case 'import_bcf': return 'bulk-imports external data that can overwrite existing issues';
    default: return 'not yet classified — treated as destructive by default';
  }
}

module.exports = { classifyTool, checkAutonomy, autonomyMode, gateEnabled, READ_ONLY, REVERSIBLE, DESTRUCTIVE };
