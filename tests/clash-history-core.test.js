'use strict';
// clash-history-core.js: the run-history entry with breakdowns per
// discipline pair / severity / assignee / review bucket (one pass at merge
// time), the read helpers the Trends view and the clash report use, and the
// CSV / JSON history export. Synthetic clashes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const H = require('../clash-history-core');
const T = require('../clash-triage-core');

const root = join(__dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function clash(i, o) {
  return Object.assign({ id: 'c' + i, status: 'open', type: 'hard', trades: ['structural', 'mep.ventilation'], _delta: 'persisting' }, o || {});
}
function sample() {
  return [
    clash(1, { _delta: 'new', aiSeverity: 'critical', assignee: 'Ann' }),
    clash(2, { trades: ['mep.ventilation', 'structural'], aiSeverity: 'major' }),            // same pair, other order
    clash(3, { trades: ['architectural', 'architectural'], status: 'in_progress', assignee: 'Bob', aiSeverity: 'minor' }),
    clash(4, { trades: null, disciplines: ['architectural', 'structural'], status: 'resolved', aiSeverity: 'info' }),
    clash(5, { trades: null, status: 'auto_resolved', _delta: 'auto_resolved', aiSeverity: 'major' }),   // no discipline → other
    clash(6, { _delta: 'new', aiSeverity: 'critical', assignee: '=cmd()' }),
    clash(7, { status: 'denied', _delta: 'not_checked', aiSeverity: 'minor' }),
    clash(8, { _idsValidation: true })                                                     // never counted
  ];
}

test('pairKey is the clash list Trades facet key (sorted, one key for same-discipline pairs)', () => {
  const ctx = { trade: (c, side) => { const i = side === 'A' ? 0 : 1; return (c.trades && c.trades[i]) || (c.disciplines && c.disciplines[i]) || 'other'; } };
  for (const c of sample()) assert.equal(H.pairKey(c), T.facetValues(c, ctx).trade, c.id);
  assert.equal(H.pairKey(clash(1)), 'mep.ventilation × structural');
  assert.equal(H.pairKey(clash(2, { trades: ['architectural', 'architectural'] })), 'architectural');
  assert.equal(H.pairKey({}), 'other');
});

test('breakdown: one pass, every dimension adds up to the run', () => {
  const list = sample();
  let sevCalls = 0, bucketCalls = 0;
  const bd = H.breakdown(list, {
    severity: (c) => { sevCalls++; return c.aiSeverity || 'minor'; },
    bucket: (c) => { bucketCalls++; return c.status === 'open' ? 'review' : 'handled'; }
  });
  const n = list.filter((c) => !c._idsValidation).length;
  assert.equal(sevCalls, n, 'severity asked once per clash');
  assert.equal(bucketCalls, n, 'bucket asked once per clash');
  const sum = (m, f) => Object.values(m).reduce((a, v) => a + (typeof v === 'number' ? v : v[f]), 0);
  const open = list.filter((c) => !c._idsValidation && (c.status === 'open' || c.status === 'in_progress')).length;
  assert.equal(sum(bd.byPair, 'total'), n);
  assert.equal(sum(bd.bySeverity, 'total'), n);
  assert.equal(sum(bd.byBucket), n);
  assert.equal(sum(bd.byPair, 'open'), open);
  assert.equal(sum(bd.byAssignee), open);
  assert.deepEqual(bd.byPair['mep.ventilation × structural'], { total: 4, open: 3, new: 2, resolved: 0 });
  assert.deepEqual(bd.byPair.architectural, { total: 1, open: 1, new: 0, resolved: 0 });
  assert.deepEqual(bd.byPair['architectural × structural'], { total: 1, open: 0, new: 0, resolved: 0 });
  assert.deepEqual(bd.byPair.other, { total: 1, open: 0, new: 0, resolved: 1 });
  assert.deepEqual(bd.bySeverity.critical, { total: 2, open: 2, new: 2, resolved: 0 });
  assert.deepEqual(bd.byAssignee, { Ann: 1, '': 1, Bob: 1, '=cmd()': 1 });
  assert.deepEqual(bd.byBucket, { review: 3, handled: 4 });
});

test('entry: the run-level fields the reducer always wrote, plus v + breakdowns', () => {
  const list = sample();
  const e = H.entry(list, { ts: 1700000000000, newCount: 2, persisting: 3, autoResolved: 1, issuesResolved: 2 }, { severity: (c) => c.aiSeverity });
  assert.deepEqual(Object.keys(e), ['ts', 'total', 'open', 'newCount', 'persisting', 'autoResolved', 'issuesResolved', 'v', 'byPair', 'bySeverity', 'byAssignee', 'byBucket']);
  assert.equal(e.total, list.length - 1, 'total = the merged list (validation rows are not clashes)');
  assert.equal(e.open, 4);
  assert.equal(e.v, H.VERSION);
  assert.equal('issuesReopened' in e, false, 'zero issue counts are left out');
  assert.equal(H.hasBreakdown(e), true);
  assert.equal(JSON.parse(JSON.stringify(e)).byPair.other.resolved, 1, 'plain JSON (persisted in the project)');
});

test('old entries without breakdowns still read: run series drawn, breakdown cells are gaps', () => {
  const old = { ts: 1, total: 10, open: 8, newCount: 10, persisting: 0, autoResolved: 0 };
  const cur = H.entry(sample(), { ts: 2, newCount: 2, persisting: 3, autoResolved: 1 }, {});
  const hist = [old, cur];
  assert.equal(H.hasBreakdown(old), false);
  assert.deepEqual(H.runSeries(hist), [{ total: 10, open: 8, new: 10, resolved: 0 }, { total: 7, open: 4, new: 2, resolved: 1 }]);
  const keys = H.keysOf(hist, 'pair');
  assert.equal(keys[0], 'mep.ventilation × structural', 'largest latest total first');
  const s = H.series(hist, 'pair', keys[0]);
  assert.equal(s[0], null);
  assert.equal(s[1].total, 4);
  assert.deepEqual(H.series(hist, 'pair', 'nope')[1], { total: 0, open: 0, new: 0, resolved: 0 }, 'absent key in a run with breakdowns = zero');
  assert.deepEqual(H.keysOf(hist, 'severity'), ['critical', 'major', 'minor', 'info']);
  assert.deepEqual(H.cellOf(cur, 'assignee', 'Ann'), { total: null, open: 1, new: null, resolved: null });
  assert.deepEqual(H.keysOf([old], 'pair'), []);
  const t = H.pairTable(hist, 5);
  assert.deepEqual(t.runs, [1, 2]);
  assert.equal(t.rows.length, 4);
});

test('CSV export: header, one run row per run, then per pair / severity / assignee / bucket rows', () => {
  const old = { ts: 1700000000000, total: 10, open: 8, newCount: 10, persisting: 0, autoResolved: 0 };
  const cur = H.entry(sample(), { ts: 1700000100000, newCount: 2, persisting: 3, autoResolved: 1 }, { severity: (c) => c.aiSeverity || 'minor' });
  const rows = H.csvRows([old, cur]);
  assert.deepEqual(rows[0], ['run', 'timestamp', 'dimension', 'key', 'total', 'open', 'new', 'resolved']);
  assert.deepEqual(rows[1], [1, '2023-11-14T22:13:20.000Z', 'run', '', 10, 8, 10, 0]);
  assert.deepEqual(rows[2], [2, '2023-11-14T22:15:00.000Z', 'run', '', 7, 4, 2, 1]);
  const pairRows = rows.filter((r) => r[0] === 2 && r[2] === 'pair');
  assert.deepEqual(pairRows.map((r) => r[3]), Object.keys(cur.byPair).sort());
  assert.deepEqual(pairRows.find((r) => r[3] === 'mep.ventilation × structural'), [2, '2023-11-14T22:15:00.000Z', 'pair', 'mep.ventilation × structural', 4, 3, 2, 0]);
  assert.deepEqual(rows.filter((r) => r[2] === 'severity').map((r) => r[3]), ['critical', 'major', 'minor', 'info']);
  assert.deepEqual(rows.find((r) => r[2] === 'assignee' && r[3] === 'Bob'), [2, '2023-11-14T22:15:00.000Z', 'assignee', 'Bob', '', 1, '', '']);
  assert.equal(rows.filter((r) => r[0] === 1).length, 1, 'an old run has its run row only');
  const csv = H.toCsv([old, cur]);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, rows.length);
  assert.equal(lines[0], 'run,timestamp,dimension,key,total,open,new,resolved');
  assert.ok(lines.includes("2,2023-11-14T22:15:00.000Z,assignee,'=cmd(),,1,,"), 'a formula-like name is written as text');
  assert.equal(H.csvCell('a,"b"'), '"a,""b"""');
  assert.equal(H.csvCell(3), '3');
});

test('JSON export: one object per run with run number + ISO time', () => {
  const cur = H.entry(sample(), { ts: 1700000100000, newCount: 2 }, {});
  const j = JSON.parse(H.toJson([{ ts: 1, total: 1, open: 1 }, cur], { project: 'P' }));
  assert.equal(j.format, 'clashcontrol-run-history');
  assert.equal(j.version, 1);
  assert.deepEqual(j.meta, { project: 'P' });
  assert.equal(j.runs.length, 2);
  assert.equal(j.runs[1].run, 2);
  assert.equal(j.runs[1].timestamp, '2023-11-14T22:15:00.000Z');
  assert.deepEqual(j.runs[1].byPair, cur.byPair);
});

test('wiring: MERGE_CLASHES writes the entry through _ccRunHistoryEntry; core loaded, cached, type-checked', () => {
  const merge = html.slice(html.indexOf('case A.MERGE_CLASHES:'), html.indexOf('case A.ADD_CLASHES:'));
  assert.match(merge, /_st\.runHistory=\(s\.runHistory\|\|\[\]\)\.concat\(\[_ccRunHistoryEntry\(_mr\.clashes,_mr\.deltaSummary,s\.rules\)\]\)\.slice\(-100\)/);
  assert.match(html, /<script src="clash-history-core\.js" defer><\/script>/);
  assert.match(readFileSync(join(root, 'sw.js'), 'utf8'), /'clash-history-core\.js'/);
  assert.match(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.typecheck, /clash-history-core\.js/);
  assert.match(readFileSync(join(root, 'clash-history-core.js'), 'utf8'), /^\/\/ @ts-check/);
});

test('_ccRunHistoryEntry: severity = AI verdict else deterministic, bucket from the run rules + triage ctx; no core = totals only', () => {
  const start = html.indexOf('function _ccRunHistoryEntry(');
  const end = html.indexOf('\n  }\n', start) + 4;
  const src = html.slice(start, end);
  const calls = [];
  const make = (core) => new Function('window', '_ccTriageCtx', '_ccDeterministicSeverity', '_ccReviewBucket', src + '\nreturn _ccRunHistoryEntry;')(
    { _ccClashHistoryCore: core },
    (cl) => { calls.push(['ctx', cl.length]); return { twice: {} }; },
    () => 'minor',
    (c, rules, ctx) => (rules && rules.tag) + ':' + (ctx && ctx.twice ? 'ctx' : 'none'));
  const list = sample().filter((c) => !c._idsValidation).map((c) => Object.assign({}, c, { aiSeverity: c.id === 'c1' ? 'critical' : undefined }));
  const e = make(H)(list, { ts: 5, newCount: 2 }, { tag: 'r' });
  assert.deepEqual(calls, [['ctx', list.length]], 'one findTwice ctx for the run');
  assert.deepEqual(Object.keys(e.byBucket), ['r:ctx']);
  assert.deepEqual(Object.keys(e.bySeverity).sort(), ['critical', 'minor']);
  const legacy = make(undefined)(list, { ts: 5, newCount: 2, persisting: 1, autoResolved: 0 }, {});
  assert.deepEqual(legacy, { ts: 5, total: list.length, open: 4, newCount: 2, persisting: 1, autoResolved: 0 });
});
