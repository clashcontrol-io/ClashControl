// ClashControl test helper — an in-memory stand-in for the Neon `sql` tag
// that runs api/project.js's REAL handler logic without a database or a
// network. Every query in api/project.js starts with a `/* cc:<name> */`
// tag; this module implements each tagged statement against plain tables
// (shared_projects, shared_issues, shared_changes) with the semantics the
// Postgres statement has (per-project seq from change_seq, ON CONFLICT DO
// NOTHING, ordering, LIMIT). An untagged or unknown statement throws, so a
// new query in the handler cannot silently bypass the tests.
//
//   const mem = createMemoryDb();
//   const restore = installMemoryNeon(mem);   // before require('../api/project.js')
//   ...
//   restore();
'use strict';

const path = require('node:path');
const Module = require('node:module');

function createMemoryDb(opts) {
  opts = opts || {};
  const db = {
    projects: new Map(), // id -> row
    issues: new Map(),   // project_id -> Map(id -> row)
    changes: new Map(),  // project_id -> [row] (seq order)
    calls: [],
    // simulate a deployment that has not run the change-log migration
    noChangeLog: !!opts.noChangeLog,
    // ...and whose role may not create tables (the server's own setup fails)
    noDdl: !!opts.noDdl,
  };
  function missing(what) { const e = new Error('relation "' + what + '" does not exist'); e.code = '42P01'; return e; }
  function changesOf(pid) { let a = db.changes.get(pid); if (!a) { a = []; db.changes.set(pid, a); } return a; }

  function sql(strings, ...values) {
    const text = strings.join('?');
    const m = /\/\*\s*cc:([a-z0-9-]+)\s*\*\//.exec(text);
    if (!m) throw new Error('_sql-memory: untagged statement: ' + text.slice(0, 80));
    const tag = m[1];
    db.calls.push(tag);
    return Promise.resolve().then(() => run(tag, values));
  }
  function run(tag, v) {
    switch (tag) {
      case 'schema-seq': case 'schema-migrated': case 'schema-changes': case 'schema-seq-idx': {
        if (db.noDdl) { const e = new Error('permission denied for schema public'); e.code = '42501'; throw e; }
        if (tag === 'schema-seq-idx') db.noChangeLog = false;
        return [];
      }
      case 'project-row': case 'project-row-2': case 'project-row-3': {
        const p = db.projects.get(v[0]);
        return p ? [Object.assign({}, p)] : [];
      }
      case 'key-taken': return db.projects.has(v[0]) ? [{ id: v[0] }] : [];
      case 'project-insert': case 'project-insert-bare': {
        if (db.projects.has(v[0])) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
        db.projects.set(v[0], { id: v[0], name: v[1], edit_key: v[2] || null, expires_at: v[3] || null, created_at: new Date().toISOString(),
          last_activity: new Date().toISOString(), change_seq: 0, log_migrated: false });
        return [];
      }
      case 'issues-insert': {
        // values: project id, user, rows json
        const rows = JSON.parse(v[2]);
        let t = db.issues.get(v[0]); if (!t) { t = new Map(); db.issues.set(v[0], t); }
        rows.forEach((r) => { if (!t.has(r.id)) t.set(r.id, { id: r.id, data: r.data, updated_by: v[1], updated_at: new Date().toISOString() }); });
        return [];
      }
      case 'activity': {
        const p = db.projects.get(v[0]); if (p) p.last_activity = new Date().toISOString();
        return [];
      }
      case 'log-state': {
        if (db.noChangeLog) { const e = new Error('column "log_migrated" does not exist'); e.code = '42703'; throw e; }
        const p = db.projects.get(v[0]);
        return p ? [{ log_migrated: !!p.log_migrated }] : [];
      }
      case 'legacy-rows': {
        const t = db.issues.get(v[0]);
        return t ? [...t.values()].map((r) => Object.assign({}, r)) : [];
      }
      case 'log-migrated': {
        const p = db.projects.get(v[0]); if (p) p.log_migrated = true;
        return [];
      }
      case 'append': {
        if (db.noChangeLog) throw missing('shared_changes');
        // values: rows json, pid (NOT EXISTS), pid (bump), pid (insert)
        const rows = JSON.parse(v[0]), pid = v[1];
        const p = db.projects.get(pid);
        const list = changesOf(pid), have = new Set(list.map((r) => r.id));
        const fresh = [];
        const seen = new Set();
        rows.sort((a, b) => a.ord - b.ord).forEach((r) => { if (!have.has(r.id) && !seen.has(r.id)) { seen.add(r.id); fresh.push(r); } });
        if (!p) { if (fresh.length) { const e = new Error('null value in column "seq"'); e.code = '23502'; throw e; } return []; }
        const start = p.change_seq;
        p.change_seq += fresh.length;
        p.last_activity = new Date().toISOString();
        return fresh.map((r, k) => {
          // stored as Postgres returns it: bigint columns come back as strings
          const row = { project_id: pid, seq: String(start + k + 1), id: r.id, user_id: r.user_id, user_name: r.user_name, ts: String(r.ts),
            target_kind: r.target_kind, target_key: r.target_key, field: r.field, value: r.value === undefined ? null : r.value,
            base: r.base, resolves: r.resolves, meta: r.meta || {} };
          list.push(row);
          return { id: row.id, seq: row.seq };
        });
      }
      case 'pull': {
        if (db.noChangeLog) throw missing('shared_changes');
        const [pid, after, limit] = v;
        return changesOf(pid).filter((r) => Number(r.seq) > Number(after)).sort((a, b) => Number(a.seq) - Number(b.seq)).slice(0, limit)
          .map((r) => JSON.parse(JSON.stringify(r)));
      }
      case 'delete-issue': { const t = db.issues.get(v[0]); if (t) t.delete(v[1]); return []; }
      case 'delete-issues': db.issues.delete(v[0]); return [];
      case 'delete-changes': db.changes.delete(v[0]); return [];
      case 'delete-project': db.projects.delete(v[0]); return [];
      default: throw new Error('_sql-memory: no implementation for cc:' + tag);
    }
  }
  db.sql = sql;
  return db;
}

const FAKE_NEON_ID = path.join(__dirname, '__mock_neondatabase_serverless__.js');
let _origResolve = null;
function neonPath() {
  try {
    return Module._resolveFilename('@neondatabase/serverless', { paths: Module._nodeModulePaths(path.join(__dirname, '..', 'api')) });
  } catch (e) {
    if (!_origResolve) {
      _origResolve = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === '@neondatabase/serverless') return FAKE_NEON_ID;
        return _origResolve.call(this, request, ...rest);
      };
    }
    return FAKE_NEON_ID;
  }
}

// Routes api/project.js's `neon(url)` to the memory db. Returns restore().
function installMemoryNeon(db) {
  const p = neonPath();
  const prev = require.cache[p];
  const prevUrl = process.env.POSTGRES_URL;
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { neon: () => db.sql } };
  process.env.POSTGRES_URL = 'postgres://memory/db';
  return function restore() {
    if (prev) require.cache[p] = prev; else delete require.cache[p];
    if (prevUrl === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = prevUrl;
    delete require.cache[require.resolve('../api/project.js')];
  };
}

// Calls the handler like Vercel does (req.query / req.body parsed) and
// resolves {status, body}.
async function call(handler, o) {
  const res = {
    statusCode: null, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end() { return this; },
  };
  const req = { method: o.method || 'GET', headers: o.headers || {}, query: o.query || {}, body: o.body,
    socket: { remoteAddress: o.ip || ('mem-' + Math.random().toString(36).slice(2)) } };
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}

module.exports = { createMemoryDb, installMemoryNeon, call };
