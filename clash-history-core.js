// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashHistoryCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Run history with breakdowns (trends per discipline pair / severity /
  // assignee / review bucket). Pure data: the MERGE_CLASHES reducer in
  // index.html calls entry() once per detection run with the merged clash
  // list, so the whole cost is one O(n) pass at merge time — nothing here
  // runs on an interaction. The Trends view, the printable clash report and
  // the history export read the stored entries through the read helpers
  // below; entries written before the breakdowns existed (no `v`) still load
  // and render: their run totals are drawn, their breakdown series are gaps.
  //
  // Entry shape (state.runHistory[i], persisted in the project file):
  //   { ts, total, open, newCount, persisting, autoResolved,
  //     issuesResolved?, issuesReopened?,           // linked issues this run
  //     v: 1,                                       // has breakdowns
  //     byPair:     { 'a × b': {total, open, new, resolved} },
  //     bySeverity: { critical|major|minor|info: {total, open, new, resolved} },
  //     byAssignee: { name|'': open },              // '' = unassigned
  //     byBucket:   { bucket: total } }
  // total   = every clash in the merged list (as the run-level total)
  // open    = status open or in progress
  // new     = first found by this run (_delta 'new')
  // resolved= no longer found by this run (_delta 'auto_resolved')

  var VERSION = 1;
  var SEVERITIES = ['critical', 'major', 'minor', 'info'];
  var CELL_FIELDS = ['total', 'open', 'new', 'resolved'];
  var PAIR_SEP = ' × ';

  /** @param {any} c */
  function isOpen(c) { return !!c && (c.status === 'open' || c.status === 'in_progress'); }

  // The discipline pair of a clash, keyed exactly like the clash list's
  // "Trades" facet (clash-triage-core.js facetValues().trade): the two matrix
  // keys (c.trades, else c.disciplines, else 'other'), sorted, one key when
  // both sides are the same.
  /** @param {any} c */
  function pairKey(c) {
    var a = String((c && c.trades && c.trades[0]) || (c && c.disciplines && c.disciplines[0]) || 'other');
    var b = String((c && c.trades && c.trades[1]) || (c && c.disciplines && c.disciplines[1]) || 'other');
    return a === b ? a : (a < b ? a + PAIR_SEP + b : b + PAIR_SEP + a);
  }

  function _cell() { return { total: 0, open: 0, new: 0, resolved: 0 }; }

  // One pass over the merged list. opts: { severity(c) -> string,
  // bucket(c) -> string } (the caller's effective severity and review
  // bucket; without them every clash counts as 'minor' / 'review').
  /**
   * @param {any[]} clashes
   * @param {{severity?: function(any): string, bucket?: function(any): string}=} opts
   */
  function breakdown(clashes, opts) {
    opts = opts || {};
    var sevOf = typeof opts.severity === 'function' ? opts.severity : null;
    var bucketOf = typeof opts.bucket === 'function' ? opts.bucket : null;
    /** @type {Object<string, any>} */ var byPair = {};
    /** @type {Object<string, any>} */ var bySeverity = {};
    /** @type {Object<string, number>} */ var byAssignee = {};
    /** @type {Object<string, number>} */ var byBucket = {};
    var list = clashes || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || c._idsValidation) continue;
      var open = isOpen(c), isNew = c._delta === 'new', gone = c._delta === 'auto_resolved';
      var pk = pairKey(c);
      var p = byPair[pk] || (byPair[pk] = _cell());
      var sv = String((sevOf ? sevOf(c) : c.aiSeverity) || 'minor');
      var s = bySeverity[sv] || (bySeverity[sv] = _cell());
      p.total++; s.total++;
      if (open) { p.open++; s.open++; var who = String(c.assignee || ''); byAssignee[who] = (byAssignee[who] || 0) + 1; }
      if (isNew) { p.new++; s.new++; }
      if (gone) { p.resolved++; s.resolved++; }
      var b = String((bucketOf ? bucketOf(c) : null) || 'review');
      byBucket[b] = (byBucket[b] || 0) + 1;
    }
    return { byPair: byPair, bySeverity: bySeverity, byAssignee: byAssignee, byBucket: byBucket };
  }

  // The history entry of one run: the run-level fields the reducer always
  // wrote (same values) plus the breakdowns.
  /**
   * @param {any[]} clashes merged list after the run
   * @param {any} delta the merge's deltaSummary
   * @param {{severity?: function(any): string, bucket?: function(any): string}=} opts
   */
  function entry(clashes, delta, opts) {
    delta = delta || {};
    var list = clashes || [];
    // (validation rows are not clashes; the merged list never holds them,
    // skipped anyway so every breakdown adds up to `total`)
    var total = 0, open = 0;
    for (var i = 0; i < list.length; i++) { var c = list[i]; if (!c || c._idsValidation) continue; total++; if (isOpen(c)) open++; }
    var bd = breakdown(list, opts);
    /** @type {any} */
    var e = { ts: delta.ts, total: total, open: open, newCount: delta.newCount, persisting: delta.persisting, autoResolved: delta.autoResolved };
    if (delta.issuesResolved) e.issuesResolved = delta.issuesResolved;
    if (delta.issuesReopened) e.issuesReopened = delta.issuesReopened;
    e.v = VERSION;
    e.byPair = bd.byPair; e.bySeverity = bd.bySeverity; e.byAssignee = bd.byAssignee; e.byBucket = bd.byBucket;
    return e;
  }

  /** @param {any} e */
  function hasBreakdown(e) { return !!(e && e.v >= 1 && e.byPair && typeof e.byPair === 'object'); }

  var DIMS = { pair: 'byPair', severity: 'bySeverity', assignee: 'byAssignee', bucket: 'byBucket' };

  // One value of a breakdown as a cell: assignee entries hold open counts,
  // bucket entries totals; a missing key in an entry WITH breakdowns is a
  // zero (nothing of that pair this run), in an entry without them null.
  /** @param {any} e @param {string} dim @param {string} key */
  function cellOf(e, dim, key) {
    if (!hasBreakdown(e)) return null;
    var map = e[DIMS[dim]] || {};
    var v = map[key];
    if (dim === 'assignee') return { total: null, open: +v || 0, new: null, resolved: null };
    if (dim === 'bucket') return { total: +v || 0, open: null, new: null, resolved: null };
    var out = _cell();
    if (v) CELL_FIELDS.forEach(function(f) { out[f] = +v[f] || 0; });
    return out;
  }

  // Every key a dimension has over the history, the latest run's largest
  // first (by total, by open for assignees), then by name. Severity keys in
  // severity order.
  /** @param {any[]} history @param {string} dim */
  function keysOf(history, dim) {
    var field = DIMS[dim];
    /** @type {Object<string, boolean>} */ var seen = {};
    (history || []).forEach(function(e) { if (hasBreakdown(e)) Object.keys(e[field] || {}).forEach(function(k) { seen[k] = true; }); });
    var keys = Object.keys(seen);
    if (dim === 'severity') {
      return SEVERITIES.filter(function(k) { return seen[k]; }).concat(keys.filter(function(k) { return SEVERITIES.indexOf(k) < 0; }).sort());
    }
    var last = null;
    for (var i = (history || []).length - 1; i >= 0; i--) if (hasBreakdown(history[i])) { last = history[i]; break; }
    function size(k) {
      var v = last ? (last[field] || {})[k] : null;
      if (v == null) return -1;
      return typeof v === 'number' ? v : (+v.total || 0);
    }
    return keys.sort(function(a, b) { return size(b) - size(a) || (a < b ? -1 : a > b ? 1 : 0); });
  }

  // Per-run cells of one key (null for runs without breakdowns).
  /** @param {any[]} history @param {string} dim @param {string} key */
  function series(history, dim, key) {
    return (history || []).map(function(e) { return cellOf(e, dim, key); });
  }

  // Run-level series (every entry has these, old ones included).
  /** @param {any[]} history */
  function runSeries(history) {
    return (history || []).map(function(e) {
      return { total: +e.total || 0, open: +e.open || 0, new: +e.newCount || 0, resolved: +e.autoResolved || 0 };
    });
  }

  // ── Export ──
  var CSV_HEADER = ['run', 'timestamp', 'dimension', 'key', 'total', 'open', 'new', 'resolved'];
  function _iso(ts) { var d = new Date(+ts); return isFinite(d.getTime()) ? d.toISOString() : ''; }
  function _n(v) { return v == null ? '' : v; }

  // Rows per run: one 'run' row (run totals), then one row per discipline
  // pair, severity, assignee (open) and review bucket (total). Runs without
  // breakdowns have only their 'run' row.
  /** @param {any[]} history */
  function csvRows(history) {
    /** @type {any[][]} */ var rows = [CSV_HEADER.slice()];
    (history || []).forEach(function(e, i) {
      var run = i + 1, ts = _iso(e && e.ts);
      rows.push([run, ts, 'run', '', _n(e.total), _n(e.open), _n(e.newCount), _n(e.autoResolved)]);
      if (!hasBreakdown(e)) return;
      ['pair', 'severity', 'assignee', 'bucket'].forEach(function(dim) {
        var map = e[DIMS[dim]] || {};
        var keys = dim === 'severity' ? keysOf([e], 'severity') : Object.keys(map).sort();
        keys.forEach(function(k) {
          /** @type {any} */ var c = cellOf(e, dim, k) || {};
          rows.push([run, ts, dim, k, _n(c.total), _n(c.open), _n(c.new), _n(c.resolved)]);
        });
      });
    });
    return rows;
  }
  // RFC 4180 quoting; a text cell starting with = + - @ (or tab / CR) gets a
  // leading apostrophe so a spreadsheet never runs it as a formula (assignee
  // names are user text). Numbers are written as numbers.
  /** @param {any} v */
  function csvCell(v) {
    if (typeof v === 'number') return String(v);
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** @param {any[]} history */
  function toCsv(history) {
    return csvRows(history).map(function(r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }
  /** @param {any[]} history @param {any=} meta */
  function toJson(history, meta) {
    return JSON.stringify({ format: 'clashcontrol-run-history', version: VERSION, meta: meta || null,
      runs: (history || []).map(function(e, i) { return Object.assign({ run: i + 1, timestamp: _iso(e && e.ts) }, e); }) }, null, 2);
  }

  // Report: the last `n` runs of every pair (latest first in the caller's
  // order) — rows {key, cells:[cell|null per run]}.
  /** @param {any[]} history @param {number=} n */
  function pairTable(history, n) {
    var h = (history || []).slice(-(n || 5));
    return { runs: h.map(function(e) { return e.ts; }), rows: keysOf(h, 'pair').map(function(k) { return { key: k, cells: series(h, 'pair', k) }; }) };
  }

  return Object.freeze({
    contractVersion: 1,
    VERSION: VERSION,
    SEVERITIES: SEVERITIES,
    CSV_HEADER: CSV_HEADER,
    PAIR_SEP: PAIR_SEP,
    isOpen: isOpen,
    pairKey: pairKey,
    breakdown: breakdown,
    entry: entry,
    hasBreakdown: hasBreakdown,
    cellOf: cellOf,
    keysOf: keysOf,
    series: series,
    runSeries: runSeries,
    csvRows: csvRows,
    csvCell: csvCell,
    toCsv: toCsv,
    toJson: toJson,
    pairTable: pairTable
  });
}));
