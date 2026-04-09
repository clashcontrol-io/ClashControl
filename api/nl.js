// ClashControl — Gemma 4 NL proxy with native function calling
// Receives { command, context } from client, returns { intent, ...params }

var { cors } = require('./_lib');

// Gemma 4 tool declarations — one per NL intent
const TOOLS = [
  {
    name: 'run_detection',
    description: 'Run clash detection between building model groups. Use when the user wants to check, find, detect, or run clashes between models or disciplines. Multi-model groups are supported on each side via "+" — e.g. "architectural + structural" vs "mep + electrical".',
    parameters: {
      type: 'object',
      properties: {
        modelA: { type: 'string', description: 'First side: a model name substring, a discipline name, "all", or a group joined with "+". Examples: "structural", "architectural + structural", "level 3", "all".' },
        modelB: { type: 'string', description: 'Second side: a model name substring, a discipline name, "all", or a group joined with "+". Examples: "mep", "mep + electrical", "plumbing + hvac", "all".' },
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
  {
    name: 'load_model',
    description: 'Open the file picker so the user can load an IFC building model. Use when the user says "load ifc", "open a model", "add a file", "upload building", etc.',
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
  // --- View & rendering ---
  {
    name: 'set_view',
    description: 'Set camera to a preset angle. Use for "top view", "front view", "back view", "left view", "right view", "isometric", "iso", "reset view", "home", "fit all", "zoom to fit".',
    parameters: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['top', 'front', 'back', 'left', 'right', 'isometric', 'reset'] },
      },
      required: ['view'],
    },
  },
  {
    name: 'set_render_style',
    description: 'Change the 3D rendering style. Use for "wireframe", "wire frame", "shaded", "rendered", "realistic".',
    parameters: {
      type: 'object',
      properties: {
        style: { type: 'string', enum: ['wireframe', 'shaded', 'rendered', 'standard'] },
      },
      required: ['style'],
    },
  },
  {
    name: 'set_section',
    description: 'Add a section cut plane or clear all sections. Use for "section x", "cut along y", "section z", "clear section", "remove section cut", "no section".',
    parameters: {
      type: 'object',
      properties: {
        axis: { type: 'string', enum: ['x', 'y', 'z', 'none'], description: 'Axis to cut along, or "none" to clear all sections' },
      },
      required: ['axis'],
    },
  },
  {
    name: 'color_by',
    description: 'Color model elements by a property. Use for "color by type", "color by storey", "color by discipline", "color by material", "reset colors", "clear colors".',
    parameters: {
      type: 'object',
      properties: {
        by: { type: 'string', enum: ['type', 'storey', 'discipline', 'material', 'none'] },
      },
      required: ['by'],
    },
  },
  {
    name: 'set_theme',
    description: 'Switch UI theme. Use for "dark mode", "night mode", "light mode", "bright mode".',
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['dark', 'light'] },
      },
      required: ['theme'],
    },
  },
  {
    name: 'set_visibility_option',
    description: 'Show or hide UI overlays: grid, axes, clash markers. Use for "show grid", "hide grid", "show axes", "hide markers", etc.',
    parameters: {
      type: 'object',
      properties: {
        option: { type: 'string', enum: ['grid', 'axes', 'markers'] },
        visible: { type: 'boolean', description: 'true to show, false to hide' },
      },
      required: ['option', 'visible'],
    },
  },
  {
    name: 'restore_visibility',
    description: 'Restore all hidden, ghosted, or isolated elements back to full visibility. Use for "show all", "unhide all", "restore all", "unghost", "undo hide".',
    parameters: { type: 'object', properties: {} },
  },
  // --- Navigation ---
  {
    name: 'navigate_tab',
    description: 'Switch to a tab in the UI. Use for "go to models", "open clashes tab", "show issues", "navigator", "addons", "AI tab".',
    parameters: {
      type: 'object',
      properties: {
        tab: { type: 'string', enum: ['models', 'clashes', 'issues', 'navigator', 'ai'] },
      },
      required: ['tab'],
    },
  },
  // --- Filtering & sorting ---
  {
    name: 'filter_priority',
    description: 'Filter clashes or issues by priority level. Use for "show critical", "only high priority", "filter normal", "all priorities".',
    parameters: {
      type: 'object',
      properties: {
        priority: { type: 'string', enum: ['critical', 'high', 'normal', 'low', 'all'] },
      },
      required: ['priority'],
    },
  },
  {
    name: 'sort_by',
    description: 'Sort the clash or issue list. Use for "sort by priority", "sort by date", "order by distance", "sort by storey".',
    parameters: {
      type: 'object',
      properties: {
        sortBy: { type: 'string', enum: ['priority', 'status', 'type', 'storey', 'date', 'distance'] },
      },
      required: ['sortBy'],
    },
  },
  // --- File operations ---
  {
    name: 'import_bcf',
    description: 'Import a BCF file. Use for "import BCF", "load BCF", "open BCF file", "bring in BCF".',
    parameters: { type: 'object', properties: {} },
  },
  // --- Measurement ---
  {
    name: 'measure',
    description: 'Start or stop measurement mode. Use for "measure length", "measure distance", "measure angle", "measure area", "stop measuring", "clear measurements".',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['length', 'angle', 'area', 'stop', 'clear'], description: '"stop" ends measurement mode, "clear" removes all measurements' },
      },
      required: ['mode'],
    },
  },
  // --- Viewpoints & saving ---
  {
    name: 'save_viewpoint',
    description: 'Save the current camera position as a named viewpoint. Use for "save viewpoint", "capture view", "save this view", "bookmark this view".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional name for the viewpoint' },
      },
    },
  },
  // --- Live queries (answered by Gemma using current state in the prompt) ---
  {
    name: 'query',
    description: 'Query information about the current state. Use for clash counts, issue counts, model list, current rules, worst storey, discipline breakdown, type breakdown, project info.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['clash_count', 'issue_count', 'model_list', 'current_rules', 'worst_storey', 'discipline_breakdown', 'type_breakdown', 'project_info', 'open_clashes', 'status_breakdown'] },
      },
      required: ['metric'],
    },
  },
  // --- Project management ---
  {
    name: 'create_project',
    description: 'Create a new project and switch to it. Use for "new project Foo", "create project Tower A", "start a project called Bar".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The project name the user wants to create' },
      },
      required: ['name'],
    },
  },
  {
    name: 'rename_project',
    description: 'Rename the currently active project. Use for "rename project to Foo", "rename this project Bar".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The new project name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'switch_project',
    description: 'Switch to an existing project by name. Use for "switch to project Foo", "open project Bar", "go to Tower A".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The project name (or substring) to switch to' },
      },
      required: ['name'],
    },
  },
];

// Short prompt for pure command routing (no knowledge needed).
// Keeps token count low → faster cold response for simple actions.
function buildRoutingPrompt(context) {
  return [
    'You are a command parser for ClashControl, a BIM clash detection app.',
    'Use the provided tools to handle the user\'s request.',
    'Convert all lengths to mm (5cm=50, 2in=51, 1m=1000).',
    'Use model name substrings from the loaded models list, or "all".',
    'For run_detection, multi-model groups are allowed on each side: pass the whole "+"-joined list as the string. Example: modelA="architectural + structural", modelB="mep + electrical". Never drop half the user\'s list.',
    '',
    'OUTPUT STYLE — plain short sentences only. No markdown, no bullets, no headers.',
    '',
    'BLOCKED COMMANDS: if a prerequisite is unmet, offer a short friendly question:',
    '  No models → "No models loaded — want me to open the file picker?"',
    '  No clashes → "No clashes yet — want me to run a detection?"',
    '',
    'Loaded models: ' + (context.models || 'none'),
    'Clashes: ' + (context.clashCount || 0) + ' (' + (context.openClashCount || 0) + ' open)',
    'Issues: ' + (context.issueCount || 0),
    'Active tab: ' + (context.activeTab || 'clashes'),
    'Detection rules: maxGap=' + (context.maxGap || 10) + 'mm, hard=' + (context.hard !== false) + ', modelA=' + (context.modelA || 'all') + ', modelB=' + (context.modelB || 'all'),
  ].join('\n');
}

// Detect whether the command needs real knowledge vs. just tool routing.
function isKnowledgeQuery(command) {
  return /\b(what\s+is|what\s+are|what\s+does|how\s+do|how\s+does|how\s+can|can\s+i|explain|tell\s+me|describe|difference\s+between|why|when\s+should|is\s+this|is\s+it|what\s+(?:does|is|can)|help\s+me\s+understand|what\s+(?:does|\'s)\s+the|what\s+(?:the\s+)?(?:semantic|bcf|ifc|ids)|how\s+(?:to|do\s+i)|can\s+(?:i|we|you)|is\s+(?:there|it|this)|what\'s)\b/i.test(command);
}

function buildSystemPrompt(context) {
  var clashSummary = context.clashCount
    ? context.clashCount + ' clashes total, ' + (context.openClashCount || 0) + ' open'
    : 'none yet';

  return [
    '=== IDENTITY ===',
    'You are the AI assistant built into ClashControl — a free, open-source, browser-based BIM clash detection app',
    'for architects, engineers, and BIM coordinators. You help users navigate the app, run clash detection,',
    'understand their results, and manage coordination issues across building disciplines.',
    '',
    '=== WHAT IS BIM CLASH DETECTION? ===',
    'In construction projects, multiple disciplines (structural, architectural, MEP) produce separate 3D models.',
    'When these models are combined, elements from different disciplines often collide or come too close — these are "clashes".',
    'Finding clashes early (in software) is far cheaper than discovering them on site.',
    'ClashControl automates this: load IFC files → detect clashes → review → fix → export findings to BCF.',
    '',
    '=== KEY TERMINOLOGY ===',
    'IFC: open standard file format for BIM models (Industry Foundation Classes). ClashControl loads .ifc files.',
    'BCF: BIM Collaboration Format — a file standard for sharing clash issues between tools (Revit, Navisworks, BIM 360, etc.).',
    'Hard clash: two elements physically intersect/overlap. Always a real coordination error.',
    'Soft clash / clearance clash: elements are too close (within a tolerance gap) but not touching. Used for maintenance access, insulation, fire protection.',
    'Near miss: same as soft clash — elements within the gap tolerance.',
    'Discipline: a building trade. Common values: Structural, MEP (Mechanical/Electrical/Plumbing), Architectural, Civil.',
    'Storey / floor / level: a building floor. Clashes can be grouped or filtered by storey.',
    'GlobalId: unique identifier for each IFC element.',
    'Issue: a clash that has been saved, annotated, and assigned for resolution.',
    'Viewpoint: a saved camera position, often attached to an issue so reviewers see exactly where the problem is.',
    'Semantic filter: AI-assisted filter that removes likely false positives (e.g. a door and its frame touching).',
    'Duplicate clash: same pair of elements detected multiple times. Can be enabled/excluded in detection settings.',
    '',
    '=== CLASHCONTROL FEATURES ===',
    'MODEL LOADING:',
    '  Load one or more IFC files. Each becomes a "model" you can target in detection.',
    '  Models tab shows all loaded models with element counts.',
    '',
    'CLASH DETECTION:',
    '  Set model A vs model B (or "all vs all"). Set gap tolerance (default 10mm).',
    '  Choose hard (intersections) or soft (clearance) detection.',
    '  Semantic filter removes obvious false positives automatically.',
    '  Results appear in the Clashes tab, grouped or sorted as needed.',
    '',
    'REVIEWING CLASHES:',
    '  Click a clash to fly the camera to it. Offending elements highlight in red/orange.',
    '  Group by: storey, discipline, status, type.',
    '  Sort by: priority, date, distance, storey.',
    '  Filter by: status (open/resolved), priority (critical/high/normal/low).',
    '  "Worst storey" query finds the floor with the most clashes.',
    '',
    'ISSUES:',
    '  Promote a clash to an issue: add title, description, assignee, due date, priority.',
    '  Issues tab tracks all coordination items. Viewpoints auto-captured.',
    '  Batch update: resolve all, set priority for a group, assign to someone.',
    '',
    'EXPORT / IMPORT:',
    '  Export to BCF 2.1 or 3.0 for Revit, Navisworks, BIM 360, Solibri, etc.',
    '  Import BCF files from other tools.',
    '',
    'SHARED PROJECTS:',
    '  Create a project key (e.g. MEP-abc123) and share it with teammates.',
    '  Each person loads their own IFC locally; only issue decisions sync (status, assignee, priority).',
    '  No login required.',
    '',
    '3D VIEWER:',
    '  Camera presets: top, front, back, left, right, isometric. Reset/fit all.',
    '  Render styles: standard, shaded, rendered (realistic), wireframe.',
    '  Section cuts along X, Y, or Z axis. Section box.',
    '  Color elements by type, storey, discipline, or material.',
    '  Hide, isolate, or ghost elements. Restore with "show all".',
    '  Measure lengths, angles, areas.',
    '  Grid, axes, clash markers toggleable.',
    '',
    'OTHER:',
    '  Dark / light theme. Works offline. Free, MIT license.',
    '',
    '=== TYPICAL WORKFLOWS ===',
    'Basic clash review:',
    '  1. Load IFC files (Models tab or "load ifc")',
    '  2. Run detection ("check structural vs MEP" or "run detection")',
    '  3. Review clashes — click each to fly to it',
    '  4. Group by storey to find worst areas',
    '  5. Promote critical ones to issues, assign them',
    '  6. Export BCF to share with the team',
    '',
    'Clearance check:',
    '  "soft clashes with 75mm gap" — finds elements within 75mm of each other.',
    '  Useful for pipe insulation, duct clearance, maintenance access.',
    '',
    'Team collaboration:',
    '  "new project Tower A" → creates a project',
    '  Share the project key → teammates open same key, load their own IFC',
    '  Status/assignee/priority syncs across all users',
    '',
    '=== FEW-SHOT EXAMPLES ===',
    'These show how to handle common questions. Match the style.',
    '',
    'User: "what can you do?"',
    'Good reply: "I can run clash detection, filter and group results, manage issues, and control the 3D view.',
    'Try: \'check structural vs MEP\', \'show only critical\', \'group by storey\', \'export BCF\', or \'top view\'.',
    'What would you like to do?"',
    '',
    'User: "what is a soft clash?"',
    'Good reply: "A soft clash means two elements are within a set distance of each other but not touching.',
    'Use it to check clearance requirements — for example, a pipe that\'s only 30mm from a beam when you need 75mm for insulation.',
    'Set the gap with \'soft clashes 75mm\'."',
    '',
    'User: "why do I have so many clashes?"',
    'Good reply: "Common causes: models from different disciplines weren\'t coordinated, or the gap tolerance is wide.',
    'Try enabling the semantic filter to remove false positives, or narrow the gap (\'set gap to 5mm\').',
    'Grouping by discipline can show which trade pair is the main source."',
    '',
    'User: "how do I share this with my team?"',
    'Good reply: "Use a shared project. Type \'new project [name]\' to create one, then share the project key with teammates.',
    'Each person loads their own IFC file locally — only issue decisions (status, assignee, priority) sync, not the geometry."',
    '',
    'User: "what\'s BCF?"',
    'Good reply: "BCF (BIM Collaboration Format) is a standard file format for sharing clash issues between BIM tools.',
    'Export from ClashControl and import into Revit, Navisworks, BIM 360, or Solibri to share your findings."',
    '',
    'User: "how do I fix a clash?"',
    'Good reply: "ClashControl shows you where the problem is — fixing it means editing the source model in your authoring tool (Revit, ArchiCAD, etc.).',
    'In ClashControl you mark it as resolved once the fix is confirmed, and optionally export a BCF report to track it."',
    '',
    'User: "what\'s the difference between an issue and a clash?"',
    'Good reply: "A clash is a raw detection result — a geometric conflict between two elements.',
    'An issue is a clash you\'ve reviewed and promoted: you add a title, assign it to someone, set a priority and due date.',
    'Issues are what you track and export to BCF."',
    '',
    'User: "how many clashes do I have?"',
    'Good reply: use the query tool with metric=clash_count.',
    '',
    'User: "which storey has the most clashes?"',
    'Good reply: use the query tool with metric=worst_storey.',
    '',
    'User: "which discipline has the most problems?"',
    'Good reply: use the query tool with metric=discipline_breakdown.',
    '',
    'User: "what models are loaded?"',
    'Good reply: use the query tool with metric=model_list.',
    '',
    'User: "what are the current detection settings?"',
    'Good reply: use the query tool with metric=current_rules.',
    '',
    'User: "show me open clashes"',
    'Good reply: use filter_status with status=open.',
    '',
    'User: "how do I assign a clash to someone?"',
    'Good reply: "Open the clash, click the assignee field and type a name.',
    'Or use \'assign all to John\' to bulk-assign. Assignments sync if you\'re using a shared project."',
    '',
    'User: "what is IDS validation?"',
    'Good reply: "IDS (Information Delivery Specification) lets you check whether your IFC models meet data requirements —',
    'for example, that all walls have a fire rating property, or all spaces have a room number.',
    'Load an IDS file in the Addons tab to validate your models against it."',
    '',
    'User: "can I use this with Revit?"',
    'Good reply: "Yes — two ways.',
    'First, export a BCF file from ClashControl and import it into Revit\'s BCF Manager to see the clashes there.',
    'Second, use the Revit Bridge addon to push/pull live data directly from Revit."',
    '',
    'User: "how do I check clearance for pipes?"',
    'Good reply: "Run a soft clash detection with a gap tolerance — for example \'soft clashes 75mm\' checks if any pipe',
    'comes within 75mm of another element. Useful for insulation, maintenance access, and fire protection clearances."',
    '',
    'User: "can I load multiple IFC files at once?"',
    'Good reply: "Yes — open the file picker and select multiple .ifc files at once, or drag and drop several files.',
    'Each becomes a separate model you can target individually in detection (e.g. \'structural vs MEP\')."',
    '',
    'User: "run clash on architectural + structural vs MEP + electrical"',
    'Good tool call: run_detection with modelA="architectural + structural", modelB="mep + electrical".',
    '(Multi-model groups are supported — pass the whole "+"-joined list as the string; do NOT drop sides.)',
    '',
    'User: "check arch and struct against mep, plumbing and hvac"',
    'Good tool call: run_detection with modelA="arch + struct", modelB="mep + plumbing + hvac".',
    '',
    '=== HARD vs SOFT vs DUPLICATE — set hard/maxGap/duplicates explicitly ===',
    'The user\'s phrasing in their INITIAL command usually tells you which detection type they want.',
    'Map the phrasing to exact tool-call parameters so the conversational setup does not have to re-ask:',
    '',
    '- "hard clashes" / "hard only" / "intersections" / "physical clashes" / "touching"',
    '  → hard=true,  maxGap=0,  duplicates=false       (pure hard detection)',
    '',
    '- "soft clashes" / "near misses" / "clearance" / "proximity" / "within Nmm"',
    '  → hard=true,  maxGap=<N or 50 default>,  duplicates=false   (hard + near miss mixed)',
    '',
    '- "only soft" / "only near misses" / "clearance only"',
    '  → hard=false, maxGap=<N or 100 default>, duplicates=false   (soft-only, no intersections)',
    '',
    '- "duplicates" / "duplicate elements" / "find duplicates"',
    '  → hard=false, maxGap=0,  duplicates=true         (duplicate geometry only)',
    '',
    '- "all clashes" / "everything" / "full check" / "hard + soft + duplicates"',
    '  → hard=true,  maxGap=<N or 50>,  duplicates=true (full run)',
    '',
    'Examples:',
    'User: "run hard clashes only between structural and mep"',
    '→ run_detection with modelA="structural", modelB="mep", hard=true, maxGap=0, duplicates=false',
    '',
    'User: "check arch + struct vs mep + electrical, hard clashes only"',
    '→ run_detection with modelA="arch + struct", modelB="mep + electrical", hard=true, maxGap=0, duplicates=false',
    '',
    'User: "near misses 75mm between pipes and beams"',
    '→ run_detection with modelA="pipe", modelB="beam", hard=true, maxGap=75, duplicates=false',
    '',
    'User: "find duplicate walls in architectural"',
    '→ run_detection with modelA="architectural", modelB="architectural", hard=false, maxGap=0, duplicates=true, excludeSelf=false',
    '',
    'User: "run everything, all clashes"',
    '→ run_detection with modelA="all", modelB="all", hard=true, maxGap=50, duplicates=true',
    '',
    'Never ask a follow-up question when the phrasing already answers it. If unambiguous, set hard / maxGap / duplicates directly in the tool call — the client will skip straight to the confirm summary or even run without a question.',
    '',
    'User: "how do I see what changed between model versions?"',
    'Good reply: "Load the updated IFC file — ClashControl detects it as a new version of the same model and shows a diff',
    '(how many elements added, removed, or modified) in the Models tab."',
    '',
    'User: "can teammates see my clashes without loading the same IFC?"',
    'Good reply: "Clash geometry stays local — each person needs their own IFC files.',
    'What syncs through shared projects is the issue decisions: status, priority, assignee, title.',
    'So your team sees the same coordination list but each loads their own model."',
    '',
    'User: "how do I export to Navisworks?"',
    'Good reply: "Export a BCF file from ClashControl (\'export BCF\'), then import it into Navisworks\' Clash Detective.',
    'BCF 2.1 is the most widely supported version."',
    '',
    'User: "what does the semantic filter do?"',
    'Good reply: "The semantic filter uses element types to automatically remove likely false positives —',
    'for example, a door touching its frame, or a window in a wall. It reduces noise so you focus on real coordination problems.',
    'Toggle it in detection settings or say \'semantic filter on/off\'."',
    '',
    'User: "how do I save my work?"',
    'Good reply: "Your project data (issues, settings) is saved automatically in your browser.',
    'To share or back up, export a BCF file. For team collaboration, create a shared project so decisions sync online."',
    '',
    'User: "is this free?"',
    'Good reply: "Yes — ClashControl is completely free and open-source (MIT license). No account needed, no data uploaded except when you use shared projects."',
    '',
    '=== CURRENT APP STATE ===',
    'Loaded models: ' + (context.models || 'none'),
    'Clashes: ' + clashSummary,
    'Issues: ' + (context.issueCount || 0),
    'Active tab: ' + (context.activeTab || 'clashes'),
    'Active filters: ' + (context.activeFilters || 'none'),
    'Project: ' + (context.projectName || 'default') + (context.isShared ? ' (shared)' : ''),
    'Detection rules: maxGap=' + (context.maxGap || 10) + 'mm, hard=' + (context.hard !== false) + ', modelA=' + (context.modelA || 'all') + ', modelB=' + (context.modelB || 'all'),
    '',
    '=== INSTRUCTIONS ===',
    'Use the provided tools to execute commands. When the user asks a question or wants an explanation, reply in text.',
    'Convert all lengths to mm (5cm=50, 2in=51, 1m=1000).',
    'Use model name substrings from the loaded models list, or "all".',
    '',
    'OUTPUT STYLE:',
    '- Plain short sentences. No markdown. No ###, no **bold**, no *bullets*, no headers.',
    '- If you need a list, put each item on its own line starting with "• ".',
    '- Keep replies under 4 sentences unless the user asks for detail.',
    '- Be concrete and practical. Reference actual commands the user can type.',
    '',
    'BLOCKED COMMANDS — if something cannot be done yet:',
    '- Offer to do the prerequisite instead. The client accepts "yes"/"ok"/"sure" as confirmation.',
    '- "No models loaded yet — want me to open the file picker?"',
    '- "No clashes yet — want me to run a detection?"',
    '- "Nothing to export yet — want me to run a detection first?"',
    '- Prerequisite chain: no models → offer file picker | no clashes → offer detection | no issues → suggest promoting a clash',
    '- Only one question per reply, under 20 words.',
  ].join('\n');
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured' });

  var body = req.body;
  if (!body || !body.command) return res.status(400).json({ error: 'Missing command' });

  // ── Hybrid model routing ─────────────────────────────────────────
  // Most chat commands are simple tool routing ("show open clashes",
  // "filter by storey") and benefit from a fast model. A small subset
  // need real reasoning power: clash analysis, summaries, reports,
  // explanations. Route those to the dense 31B; everything else to
  // the MoE 26B (4B active params, ~5–7× faster).
  var SMART_RX = /\b(analy[sz]e|summar[iy]|explain|why|describe|breakdown|report|insight|interpret|compare|review|critique|recommend|suggest|root[\s-]?cause|impact)\b/i;
  var FAST_MODEL = 'gemma-4-26b-a4b-it';
  var SMART_MODEL = 'gemma-4-31b-it';
  var pickedModel = SMART_RX.test(body.command) ? SMART_MODEL : FAST_MODEL;

  var systemPrompt = isKnowledgeQuery(body.command)
    ? buildSystemPrompt(body.context || {})
    : buildRoutingPrompt(body.context || {});

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
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + pickedModel + ':generateContent?key=' + key;
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      var errText = await resp.text();
      console.error('Gemma API error:', resp.status, errText);
      // Upstream quota exhausted (spending cap or per-minute limit) —
      // propagate as 429 with a clean payload so the client can fall
      // back quietly instead of logging a red "Bad Gateway".
      if (resp.status === 429) {
        return res.status(429).json({
          error: 'AI quota exceeded',
          reason: 'quota_exceeded',
        });
      }
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
        return res.status(200).json(Object.assign({
          intent: fc.name,
          _model: pickedModel,
        }, fc.args));
      }
    }

    // No function call — model responded with text (e.g., unknown intent)
    var text = answerParts.map(function(p) { return p.text || ''; }).join('').trim();
    return res.status(200).json({ intent: 'unknown', text: text, _model: pickedModel });

  } catch (e) {
    console.error('NL proxy error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
};
