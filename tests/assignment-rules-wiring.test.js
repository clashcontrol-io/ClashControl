'use strict';
// Locks the Wave 3 "assignment rules" reducer + MERGE_CLASHES wiring + UI +
// project round-trip (index.html). Companion to
// assignment-rules-resolver.test.js, which locks the pure matching logic.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractCaseReturn(caseLabel) {
  const marker = "case '" + caseLabel + "': return ";
  const start = src.indexOf(marker);
  assert.ok(start !== -1, marker + ' not found');
  const exprStart = start + marker.length;
  const end = src.indexOf(';\n', exprStart);
  assert.ok(end !== -1, caseLabel + ' case not terminated on its own line');
  return new Function('s', 'a', 'return ' + src.slice(exprStart, end) + ';');
}

function extractAddAssignRule() {
  const marker = "case 'ADD_ASSIGN_RULE': {";
  const start = src.indexOf(marker);
  assert.ok(start !== -1, marker + ' not found');
  const braceOpen = start + marker.length - 1;
  const end = src.indexOf('\n      }', braceOpen);
  assert.ok(end !== -1, 'ADD_ASSIGN_RULE case not terminated');
  const body = src.slice(braceOpen, end + '\n      }'.length);
  return new Function('s', 'a', 'uid', body);
}

function arule(id, discipline1, discipline2, assignee) { return { id: id, discipline1: discipline1, discipline2: discipline2, storey: 'any', assignee: assignee || '', priority: '' }; }

test('ADD_ASSIGN_RULE appends a new rule, defaulting discipline1/2/storey to "any" and assignee/priority to ""', () => {
  const fn = extractAddAssignRule();
  const uid = () => 'generated-id';
  const next = fn({ assignmentRules: [] }, { v: {} }, uid);
  assert.equal(next.assignmentRules.length, 1);
  const r = next.assignmentRules[0];
  assert.equal(r.id, 'generated-id');
  assert.equal(r.discipline1, 'any');
  assert.equal(r.discipline2, 'any');
  assert.equal(r.storey, 'any');
  assert.equal(r.assignee, '');
  assert.equal(r.priority, '');
  assert.ok(r.createdAt);
});

test('ADD_ASSIGN_RULE preserves explicit field values and does not touch other rules', () => {
  const fn = extractAddAssignRule();
  const existing = arule('a', 'mep', 'structural');
  const next = fn({ assignmentRules: [existing] }, { v: { id: 'b', discipline1: 'civil', discipline2: 'other', storey: 'Level 2', assignee: 'x@y.com', priority: 'high' } }, () => 'unused');
  assert.equal(next.assignmentRules.length, 2);
  assert.deepEqual(next.assignmentRules[0], existing);
  const r = next.assignmentRules[1];
  assert.equal(r.id, 'b');
  assert.equal(r.discipline1, 'civil');
  assert.equal(r.storey, 'Level 2');
  assert.equal(r.assignee, 'x@y.com');
});

test('DEL_ASSIGN_RULE removes only the matching rule', () => {
  const fn = extractCaseReturn('DEL_ASSIGN_RULE');
  const s = { assignmentRules: [arule('a', 'mep', 'structural'), arule('b', 'civil', 'other')] };
  const next = fn(s, { id: 'a' });
  assert.deepEqual(next.assignmentRules.map((x) => x.id), ['b']);
});

test('UPD_ASSIGN_RULE partial-merges onto the matching rule only, same convention as UPD_RULES', () => {
  const fn = extractCaseReturn('UPD_ASSIGN_RULE');
  const s = { assignmentRules: [arule('a', 'mep', 'structural'), arule('b', 'civil', 'other')] };
  const next = fn(s, { id: 'a', u: { assignee: 'alice@x.com' } });
  const a = next.assignmentRules.find((x) => x.id === 'a');
  assert.equal(a.assignee, 'alice@x.com');
  assert.equal(a.discipline1, 'mep', 'unrelated fields on the same rule must survive the partial merge');
  const b = next.assignmentRules.find((x) => x.id === 'b');
  assert.deepEqual(b, arule('b', 'civil', 'other'), 'the other rule must be untouched');
});

test('an unknown id is a no-op for DEL/UPD_ASSIGN_RULE', () => {
  const s = { assignmentRules: [arule('a', 'mep', 'structural')] };
  assert.deepEqual(extractCaseReturn('DEL_ASSIGN_RULE')(s, { id: 'missing' }).assignmentRules, s.assignmentRules);
  assert.deepEqual(extractCaseReturn('UPD_ASSIGN_RULE')(s, { id: 'missing', u: { assignee: 'x' } }).assignmentRules, s.assignmentRules);
});

test('INIT state seeds assignmentRules as an empty array', () => {
  assert.ok(/assignmentRules:\[\]/.test(src), 'INIT must declare assignmentRules:[]');
});

test('MERGE_CLASHES applies assignment rules to the merged result before it lands in state', () => {
  const start = src.indexOf('case A.MERGE_CLASHES: var _mr=mergeDetectionResults');
  assert.ok(start !== -1);
  const lineEnd = src.indexOf('\n', start);
  const line = src.slice(start, lineEnd);
  assert.ok(/_mr\.clashes=_ccApplyAssignmentRules\(_mr\.clashes, s\.assignmentRules\);/.test(line), 'must stamp _mr.clashes with assignment rules right after the merge, before anything else reads it');
  const applyPos = line.indexOf('_ccApplyAssignmentRules');
  const stPos = line.indexOf('var _st=');
  assert.ok(applyPos < stPos, 'assignment rules must be applied BEFORE _st.clashes is captured, or the stamp would be lost');
});

test('the Assignment Rules panel section exists in StandardsPanel, using DISC (not STANDARD_DISCIPLINES)', () => {
  const panelStart = src.indexOf('<div style=${{fontSize:\'0.75rem\',fontWeight:700,color:\'var(--text-muted)\',textTransform:\'uppercase\',letterSpacing:\'.06em\',marginBottom:\'.4rem\'}}>${_cc_t(\'standards.assignmentRules\',\'Assignment rules\')}</div>');
  assert.ok(panelStart !== -1, 'Assignment rules panel section not found');
  const panelEnd = src.indexOf('+ Add assignment rule', panelStart);
  assert.ok(panelEnd !== -1 && panelEnd > panelStart);
  const panelSrc = src.slice(panelStart - 400, panelEnd + 50);

  assert.ok(/DISC\.map\(function\(dd\)/.test(panelSrc), 'must populate discipline dropdowns from DISC (structural/mep/architectural/civil/other)');
  assert.ok(!/STANDARD_DISCIPLINES/.test(panelSrc), 'must NOT reuse STANDARD_DISCIPLINES - it has mechanical/electrical, which a clash.disciplines[] entry never carries (only DISC ids do)');
  assert.ok(/d\(\{t:'ADD_ASSIGN_RULE'/.test(panelSrc));
  assert.ok(/d\(\{t:'UPD_ASSIGN_RULE'/.test(panelSrc));
  assert.ok(/d\(\{t:'DEL_ASSIGN_RULE'/.test(panelSrc));
});

test('saveProject, loadProject, and _saveCurrentProjectData (IndexedDB auto-persist) all carry assignmentRules', () => {
  // saveProject/loadProject now delegate to project-codec.js (projectCodecV2
  // graduated to the sole implementation — see MEMORY.md Architecture
  // Decisions); the serialize/restore assertions check the module directly.
  const codecSrc = fs.readFileSync(path.join(__dirname, '..', 'project-codec.js'), 'utf8');
  assert.ok(/assignmentRules: state\.assignmentRules \|\| \[\]/.test(codecSrc), 'project-codec.js must serialize assignmentRules');
  assert.ok(/data\.assignmentRules\.forEach\(function\(rule\) \{ dispatch\(\{t:actions\.ADD_ASSIGN_RULE, v:rule\}\); \}\)/.test(codecSrc), 'project-codec.js must restore each saved assignment rule');
  assert.ok(/_ccRestoreProject\(data, d\)/.test(src), 'loadProject must route parsed data through the guarded restore adapter');
  assert.ok(/assignmentRules:s\.assignmentRules\|\|\[\]/.test(src), '_saveCurrentProjectData must include assignmentRules too, not just the explicit-export path');
});
