// ClashControl — Shared project sync endpoint (docs/INTERNALS.md §21.56)
// No login required — uses shareable project keys.
//
// A shared project is an append-only CHANGE LOG (table shared_changes), the
// same records and the same conflict rule as the shared folder
// (shared-log-core.js): every team decision is a record {id, user, ts,
// target:{kind,key}, field, value, base, resolves?, prev?, resolution?,
// covers?}. The server never decides who wins — it stores records
// (idempotent by id), numbers them per project (`seq`, assigned under the
// project row lock so a reader's cursor never skips a record that commits
// later) and returns the ones after the cursor a client passes. Clients
// compute heads / conflicts with the same core, so concurrent edits are a
// conflict every user sees until a user resolves it.
//
// Wire format (v2):
//   GET  ?id=KEY&v=2&after=<cursor>[&limit=n] → {v, project, changes, names, cursor, more}
//   PUT  ?id=KEY  body {v:2, user, name, changes:[record]} → {v, accepted, known, invalid:[ids], rejected:[{id, reason}]}
//   POST (create), DELETE ?scope=project (editKey) — unchanged.
// Old clients (no v): GET returns the agreed values as the old `issues`
// shape (read-only view); PUT is refused — nothing is written and every id
// comes back in `conflicts` with error 'client_outdated', which the old
// client shows as "your edit was not applied" (a reload updates it).
// The old per-issue rows (shared_issues) are read once into records the
// first time a v2 client opens the project (lazy migration).

var { cors, llmGuard, dbUrl: getDbUrl } = require('./_lib');
var LOG = require('../shared-log-core.js');
var IDENT = require('../clash-identity-core.js');

var crypto = require('crypto');

var KEY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars

function randomToken(len) {
  // crypto.randomInt does uniform rejection sampling internally — modulo on
  // a raw random byte would bias low character-set indices (256 isn't a
  // multiple of KEY_CHARS.length).
  var out = '';
  for (var i = 0; i < len; i++) out += KEY_CHARS[crypto.randomInt(0, KEY_CHARS.length)];
  return out;
}

// editKey is stored hashed (SHA-256 hex), never in plaintext, so a DB leak
// doesn't hand out delete capability for every shared project. Rows created
// before this change still hold the raw 16-char token (from KEY_CHARS, which
// excludes several hex letters — g/j/k/m/n/q/r/s/t/u/v/w/x/y/z aren't valid
// hex digits — and is never 64 chars long), so `editKeyMatches` below
// distinguishes "looks like a sha256 hex digest" from "legacy raw token" and
// compares accordingly. New projects always get a hash; nothing re-hashes
// old rows in place (no code-only way to do that without DB access), but
// they keep working exactly as before under the legacy branch.
function hashEditKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

var SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function timingSafeStringEqual(a, b) {
  var bufA = Buffer.from(String(a), 'utf8');
  var bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function editKeyMatches(provided, stored) {
  if (!provided || !stored) return false;
  if (SHA256_HEX_RE.test(stored)) return timingSafeStringEqual(hashEditKey(provided), stored);
  return timingSafeStringEqual(provided, stored); // legacy plaintext row
}

// Single project-row loader shared by GET/PUT/DELETE, with a column-existence
// fallback ladder matching the same "legacy deployment keeps working" pattern
// as the edit_key insert above — expires_at and edit_key may each be present
// or absent independently depending on which migrations a deployment has run.
async function loadProjectRow(sql, projectId) {
  try {
    return await sql`/* cc:project-row */ SELECT id, name, created_at, last_activity, edit_key, expires_at FROM shared_projects WHERE id = ${projectId}`;
  } catch (e1) {
    try {
      return await sql`/* cc:project-row-2 */ SELECT id, name, created_at, last_activity, edit_key FROM shared_projects WHERE id = ${projectId}`;
    } catch (e2) {
      return await sql`/* cc:project-row-3 */ SELECT id, name, created_at, last_activity FROM shared_projects WHERE id = ${projectId}`;
    }
  }
}

function isExpired(row) {
  return !!(row && row.expires_at && new Date(row.expires_at).getTime() < Date.now());
}

// Generate a short project key: PREFIX-XXXXXX
function generateKey(name) {
  var prefix = (name || 'CC')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase();
  return prefix + '-' + randomToken(6);
}

// Field length caps — these are safety/abuse limits, not UX limits (the
// client already keeps well under them); a wrong or hostile client can't
// blow up a Postgres text column or the 256KB payload cap via one field.
var FIELD_CAPS = { id: 200, title: 500, description: 5000, assignee: 200, category: 100, source: 100, globalId: 100 };

// `type` is a short clash-type tag ('hard', 'soft', 'clearance', ...) —
// restricted to a conservative token charset rather than a closed enum so
// new client types don't need a server deploy.
var TYPE_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
var SHORT_FIELD_CAPS = { priority: 40, status: 40, dueDate: 64, createdAt: 64 };

function isValidPoint(p) {
  return Array.isArray(p) && p.length === 3 && p.every(function(n) { return typeof n === 'number' && Number.isFinite(n); });
}

function isValidStr(v, cap) {
  return typeof v === 'string' && v.length <= cap;
}

// Validate the minimal shared issue shape
function validateIssue(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (!isValidStr(issue.id, FIELD_CAPS.id)) return false;
  // Must have at least identity (globalIds or title) + status
  if (!issue.status || typeof issue.status !== 'string') return false;
  if (!issue.globalIdA && !issue.globalIdB && !(issue.title && String(issue.title).trim())) return false;
  if (issue.title != null && !isValidStr(String(issue.title), FIELD_CAPS.title)) return false;
  if (issue.description != null && !isValidStr(String(issue.description), FIELD_CAPS.description)) return false;
  if (issue.assignee != null && !isValidStr(String(issue.assignee), FIELD_CAPS.assignee)) return false;
  if (issue.globalIdA != null && !isValidStr(String(issue.globalIdA), FIELD_CAPS.globalId)) return false;
  if (issue.globalIdB != null && !isValidStr(String(issue.globalIdB), FIELD_CAPS.globalId)) return false;
  if (issue.category != null && !isValidStr(issue.category, FIELD_CAPS.category)) return false;
  if (issue.source != null && !isValidStr(issue.source, FIELD_CAPS.source)) return false;
  if (issue.type != null && !(typeof issue.type === 'string' && TYPE_RE.test(issue.type))) return false;
  if (issue.point != null && !isValidPoint(issue.point)) return false;
  for (var f in SHORT_FIELD_CAPS) {
    if (issue[f] != null && !isValidStr(issue[f], SHORT_FIELD_CAPS[f])) return false;
  }
  if (issue.status.length > SHORT_FIELD_CAPS.status) return false;
  if (issue.distance != null && !Number.isFinite(Number(issue.distance))) return false;
  // _updatedAt, when present, must be a value Date can parse — an invalid
  // one would otherwise blow up as an uncaught 500 in the PUT handler's
  // toISOString() call further down.
  if (issue._updatedAt != null && isNaN(new Date(issue._updatedAt).getTime())) return false;
  return true;
}

// Extract only the shared fields from an issue (strip local-only data)
function stripToShared(issue) {
  return {
    id: issue.id,
    globalIdA: issue.globalIdA || null,
    globalIdB: issue.globalIdB || null,
    point: issue.point || null,
    type: issue.type || null,
    distance: issue.distance != null ? issue.distance : null, // 0mm is a real distance, not "absent"
    status: issue.status || 'open',
    priority: issue.priority || 'normal',
    // `!= null` (not `||`) for every clearable free-text field: an explicit
    // '' (user cleared the assignee/description/etc.) must round-trip as ''
    // so a teammate's hydrate can tell "cleared" from "field never set" —
    // `||` would collapse both to null and the clear would silently never
    // sync (see client _sharedStrip / _sharedHydrate for the other half).
    assignee: issue.assignee != null ? issue.assignee : null,
    title: issue.title || '',
    description: issue.description != null ? issue.description : null,
    category: issue.category != null ? issue.category : null,
    dueDate: issue.dueDate != null ? issue.dueDate : null,
    source: issue.source != null ? issue.source : null,
    createdAt: issue.createdAt || null,
  };
}

// ── Change log ───────────────────────────────────────────────────────────
var LOG_V = 2;
var CHANGE_KINDS = { clash: 1, issue: 1, note: 1, viewpoint: 1 };
// Abuse caps, far above what a client sends (a status edit is ~200 bytes,
// an issue's `created` record a few KB).
var CHANGE_CAPS = { perPut: 500, key: 300, value: 16384, prev: 4096, resolves: 64, covers: 2000, pullDefault: 1000, pullMax: 2000, legacyView: 20000 };
var FIELD_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
var USER_ID_RE = /^[A-Za-z0-9_.-]{1,120}$/;

function jsonLen(v) { try { return JSON.stringify(v === undefined ? null : v).length; } catch (e) { return Infinity; } }

// One record from a client: the core's normalisation (malformed → null)
// plus the server's caps. Returns the record or null.
// A record the log can store, or why not (`reason`, sent back to the client
// so it can tell its user which change was not shared and why).
function checkChange(raw) {
  var r = LOG.normaliseChange(raw);
  if (!r) return { reason: 'malformed' };
  if (!CHANGE_KINDS[r.target.kind]) return { reason: 'kind' };
  if (r.target.key.length > CHANGE_CAPS.key) return { reason: 'key-too-long' };
  if (!FIELD_RE.test(r.field)) return { reason: 'field' };
  if (!USER_ID_RE.test(r.user)) return { reason: 'user' };
  r.ts = Math.round(r.ts);
  if (!Number.isSafeInteger(r.ts)) return { reason: 'ts' };
  if (r.base && r.base.length > 200) return { reason: 'base' };
  if (jsonLen(r.value) > CHANGE_CAPS.value) return { reason: 'value-too-large' };
  if (r.prev !== undefined && jsonLen(r.prev) > CHANGE_CAPS.prev) return { reason: 'prev-too-large' };
  if (r.resolves && (r.resolves.length > CHANGE_CAPS.resolves || r.resolves.some(function(x) { return x.length > 200; }))) return { reason: 'resolves' };
  if (r.covers && r.covers.length > CHANGE_CAPS.covers) return { reason: 'covers' };
  return { r: r };
}
function validateChange(raw) { return checkChange(raw).r || null; }

function changeToRow(r, ord, userName) {
  var meta = {};
  if (r.prev !== undefined) meta.prev = r.prev;
  if (r.resolution) meta.resolution = true;
  if (r.covers) meta.covers = r.covers;
  return { ord: ord, id: r.id, user_id: r.user, user_name: userName || null, ts: r.ts, target_kind: r.target.kind, target_key: r.target.key,
    field: r.field, value: r.value === undefined ? null : r.value, base: r.base || null, resolves: r.resolves || null, meta: meta };
}

// The driver returns jsonb columns parsed (a jsonb string is a JS string).
function rowToChange(row) {
  var meta = (row.meta && typeof row.meta === 'object') ? row.meta : {};
  var r = { id: row.id, user: row.user_id, ts: Number(row.ts), target: { kind: row.target_kind, key: row.target_key }, field: row.field,
    value: row.value === undefined ? null : row.value, base: row.base || null };
  var rs = row.resolves;
  if (Array.isArray(rs) && rs.length) r.resolves = rs;
  if (Object.prototype.hasOwnProperty.call(meta, 'prev')) r.prev = meta.prev;
  if (meta.resolution) r.resolution = true;
  if (Array.isArray(meta.covers)) r.covers = meta.covers;
  return r;
}

// "Run api/schema.sql" errors (table / column missing on a deployment that
// has not run the migration yet) → a clear 503 instead of a generic 500.
function isMissingSchema(e) {
  return !!(e && (e.code === '42P01' || e.code === '42703' || /(relation|column) .* does not exist/i.test(String(e.message || ''))));
}

// The change log's tables, created by the server itself the first time a
// request finds them missing — the same statements as api/schema.sql
// (tests/project-changelog.test.js keeps them identical), all "if not
// exists", so running them again or concurrently is harmless. Once per
// function instance; when the database role may not create tables, the
// request still answers the 503 that says to run api/schema.sql.
var _schemaEnsured = null;
function ensureChangeLogSchema(sql) {
  if (!_schemaEnsured) {
    _schemaEnsured = (async function() {
      await sql`/* cc:schema-seq */ ALTER TABLE shared_projects ADD COLUMN IF NOT EXISTS change_seq BIGINT NOT NULL DEFAULT 0`;
      await sql`/* cc:schema-migrated */ ALTER TABLE shared_projects ADD COLUMN IF NOT EXISTS log_migrated BOOLEAN NOT NULL DEFAULT false`;
      await sql`/* cc:schema-changes */ CREATE TABLE IF NOT EXISTS shared_changes (
  project_id  TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  user_name   TEXT,
  ts          BIGINT NOT NULL,
  target_kind TEXT NOT NULL,
  target_key  TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       JSONB,
  base        TEXT,
  resolves    JSONB,
  meta        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
)`;
      await sql`/* cc:schema-seq-idx */ CREATE INDEX IF NOT EXISTS shared_changes_seq_idx ON shared_changes (project_id, seq)`;
    })().catch(function(e) { _schemaEnsured = null; throw e; });
  }
  return _schemaEnsured;
}

// Appends records (already validated, deduped). Sequence numbers come from
// the project row, bumped in the SAME statement: the row lock orders
// concurrent appends, so seqs are committed in increasing order and a pull
// "after N" can never miss a record. Existing ids are skipped (idempotent).
async function appendChanges(sql, projectId, recs, nameOf) {
  var inserted = [];
  for (var i = 0; i < recs.length; i += CHANGE_CAPS.perPut) {
    var rows = recs.slice(i, i + CHANGE_CAPS.perPut).map(function(r, k) { return changeToRow(r, k, nameOf(r)); });
    var out = await sql`/* cc:append */
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
          AS r(ord int, id text, user_id text, user_name text, ts bigint, target_kind text, target_key text, field text, value jsonb, base text, resolves jsonb, meta jsonb)
      ),
      fresh AS (
        SELECT i.* FROM incoming i
        WHERE NOT EXISTS (SELECT 1 FROM shared_changes c WHERE c.project_id = ${projectId} AND c.id = i.id)
      ),
      bump AS (
        UPDATE shared_projects SET change_seq = change_seq + (SELECT count(*) FROM fresh), last_activity = now()
        WHERE id = ${projectId}
        RETURNING change_seq
      )
      INSERT INTO shared_changes (project_id, seq, id, user_id, user_name, ts, target_kind, target_key, field, value, base, resolves, meta)
      SELECT ${projectId}, (SELECT change_seq FROM bump) - (SELECT count(*) FROM fresh) + row_number() OVER (ORDER BY f.ord),
             f.id, f.user_id, f.user_name, f.ts, f.target_kind, f.target_key, f.field, f.value, f.base, f.resolves, f.meta
      FROM fresh f
      ON CONFLICT (project_id, id) DO NOTHING
      RETURNING id, seq`;
    inserted = inserted.concat(out || []);
  }
  return inserted;
}

// First v2 access of a project: its old per-issue rows become records once.
// Deterministic record ids, so two requests migrating at once insert the
// same records (the second insert skips them).
async function ensureLog(sql, projectId) {
  var st = await sql`/* cc:log-state */ SELECT log_migrated FROM shared_projects WHERE id = ${projectId}`;
  if (st.length && st[0].log_migrated) return;
  var rows = await sql`/* cc:legacy-rows */ SELECT id, data, updated_by, updated_at FROM shared_issues WHERE project_id = ${projectId}`;
  var m = LOG.migrateLegacyRows(rows, { projectId: projectId, identityKey: IDENT.computeClashIdentityKey });
  if (m.changes.length) await appendChanges(sql, projectId, m.changes, function(r) { return m.names[r.user] || null; });
  await sql`/* cc:log-migrated */ UPDATE shared_projects SET log_migrated = true WHERE id = ${projectId}`;
}

async function pullChanges(sql, projectId, after, limit) {
  var rows = await sql`/* cc:pull */ SELECT seq, id, user_id, user_name, ts, target_kind, target_key, field, value, base, resolves, meta
    FROM shared_changes WHERE project_id = ${projectId} AND seq > ${after} ORDER BY seq LIMIT ${limit + 1}`;
  var more = rows.length > limit;
  if (more) rows = rows.slice(0, limit);
  var names = {};
  rows.forEach(function(row) { if (row.user_name) names[row.user_id] = row.user_name; });
  return { changes: rows.map(rowToChange), names: names, cursor: rows.length ? String(rows[rows.length - 1].seq) : String(after), more: more };
}

function parseCursor(v) {
  var n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

// Read-only view for old clients: the agreed value of every shared field in
// the old one-record-per-issue shape (clashes keyed by their GlobalId pair,
// which the old client matches on).
function legacyView(changes) {
  var log = LOG.createLog();
  LOG.addChanges(log, changes);
  var out = [];
  LOG.targets(log).forEach(function(t) {
    var ts = LOG.targetState(log, t[0], t[1]), f = ts.fields, latest = 0;
    Object.keys(f).forEach(function(k) { f[k].heads.forEach(function(h) { if (h.ts > latest) latest = h.ts; }); });
    function v(name) { var x = f[name]; return x && x.known ? x.value : undefined; }
    var rec;
    if (t[0] === 'issue') {
      if (v('deleted') === true || !v('created')) return;
      rec = Object.assign({}, v('created'), { id: t[1] });
      LOG.DECISION_FIELDS.forEach(function(k) { if (v(k) !== undefined) rec[k] = v(k); });
    } else if (t[0] === 'clash') {
      var at = t[1].lastIndexOf('@'), pair = (at > 0 ? t[1].slice(0, at) : '').split('|');
      if (pair.length !== 2 || pair.some(function(g) { return !g || /^(u|eid):/.test(g); })) return;
      rec = { id: t[1], globalIdA: pair[0], globalIdB: pair[1] };
      LOG.DECISION_FIELDS.forEach(function(k) { if (v(k) !== undefined) rec[k] = v(k); });
    } else return;
    if (!rec.status) rec.status = 'open';
    var d = stripToShared(rec);
    d._updatedAt = new Date(latest || 0).toISOString();
    out.push(d);
  });
  return out;
}

async function handler(req, res) {
  if (cors(req, res, 'GET, POST, PUT, DELETE')) return;

  // Rate limit + payload cap — this is the only unauthenticated DB-write
  // endpoint, so unbounded PUT bodies could bloat Postgres. 256 KB fits a
  // ~1000-issue batch (shared records are ~250 bytes each).
  if (llmGuard(req, res, { perMin: 30, maxBytes: 262144 })) return;

  var url = getDbUrl();
  if (!url) return res.status(503).json({ error: 'Database not configured' });

  var { neon } = require('@neondatabase/serverless');
  var sql = neon(url);

  try {
    return await serve(sql, req, res);
  } catch (e) {
    if (isMissingSchema(e)) {
      // a deployment whose database predates the change log: set it up once
      // and answer this request again
      try { await ensureChangeLogSchema(sql); } catch (e2) {
        console.error('Shared change log setup failed:', e2);
        return res.status(503).json({ error: 'Shared change log not set up on this deployment (run api/schema.sql)' });
      }
      try { return await serve(sql, req, res); } catch (e3) { e = e3; }
      if (isMissingSchema(e)) return res.status(503).json({ error: 'Shared change log not set up on this deployment (run api/schema.sql)' });
    }
    console.error('Project sync error:', e);
    return res.status(500).json({ error: 'Database error' });
  }
}

async function serve(sql, req, res) {
  var projectId = req.query.id || null;
  {
    switch (req.method) {

      // POST — Create a new shared project
      case 'POST': {
        var body = req.body || {};
        var name = (typeof body.name === 'string' && body.name ? body.name : 'Untitled Project').slice(0, 100);
        var postUser = isValidStr(body.user, FIELD_CAPS.assignee) && body.user ? body.user : 'anonymous';

        // Ensure uniqueness — re-check after every regeneration (the old
        // single retry could still 500 on a second collision).
        var key, taken, tries = 0;
        do {
          key = generateKey(name);
          taken = await sql`/* cc:key-taken */ SELECT id FROM shared_projects WHERE id = ${key}`;
        } while (taken.length > 0 && ++tries < 5);
        if (taken.length > 0) return res.status(503).json({ error: 'Could not allocate a project key, retry' });

        // editKey: held by the creator only, required for DELETE on this
        // project. PUT stays open to anyone with the project key — that IS
        // the collaboration model (teammates join with just the key). Only
        // the hash is stored (see hashEditKey above); the raw value is
        // returned once here and never persisted. Legacy deployments
        // without the edit_key column keep working.
        var editKey = randomToken(16);
        var editKeyHash = hashEditKey(editKey);

        // Optional expiry: body.expiresInDays, a positive integer capped at
        // a year. Off by default (existing behavior — projects never
        // expire) so this is purely additive. Legacy deployments without
        // the expires_at column keep working (caught below like edit_key).
        var expiresAt = null;
        var expiresInDays = Number(body.expiresInDays);
        if (Number.isFinite(expiresInDays) && expiresInDays > 0) {
          expiresAt = new Date(Date.now() + Math.min(expiresInDays, 365) * 86400000);
        }

        try {
          if (expiresAt) {
            await sql`/* cc:project-insert */ INSERT INTO shared_projects (id, name, edit_key, expires_at) VALUES (${key}, ${name}, ${editKeyHash}, ${expiresAt})`;
          } else {
            await sql`/* cc:project-insert */ INSERT INTO shared_projects (id, name, edit_key) VALUES (${key}, ${name}, ${editKeyHash})`;
          }
        } catch (colErr) {
          // Only fall back (drop editKey/expiry and insert the bare row) for
          // the specific "column doesn't exist" case (a legacy deployment
          // that hasn't run the edit_key/expires_at migration) — Postgres
          // undefined_column is SQLSTATE 42703. Any other error (duplicate
          // key, connection drop, constraint violation, ...) must surface
          // as a real failure instead of silently creating an editKey-less
          // project that masks the actual problem.
          var isMissingColumn = colErr && (colErr.code === '42703' || /column .* does not exist/i.test(String(colErr.message || '')));
          if (!isMissingColumn) throw colErr;
          await sql`/* cc:project-insert-bare */ INSERT INTO shared_projects (id, name) VALUES (${key}, ${name})`;
          editKey = null;
          expiresAt = null;
        }

        // If initial issues are provided, insert them (batched)
        if (body.issues && Array.isArray(body.issues)) {
          var initRows = body.issues.filter(validateIssue).map(function(issue) {
            var shared = stripToShared(issue);
            return { id: shared.id, data: shared };
          });
          if (initRows.length) {
            await sql`/* cc:issues-insert */ INSERT INTO shared_issues (id, project_id, data, updated_by)
              SELECT r.id, ${key}, r.data, ${postUser}
              FROM jsonb_to_recordset(${JSON.stringify(initRows)}::jsonb) AS r(id text, data jsonb)
              ON CONFLICT (project_id, id) DO NOTHING`;
          }
        }

        return res.status(201).json({ id: key, name: name, editKey: editKey, v: LOG_V });
      }

      // GET — v2: the records after the client's cursor; old clients: the
      // agreed values in the old issues shape.
      case 'GET': {
        if (!projectId) return res.status(400).json({ error: 'Missing project id' });

        var project = await loadProjectRow(sql, projectId);
        if (project.length === 0 || isExpired(project[0])) return res.status(404).json({ error: 'Project not found' });

        // edit_key (hash or legacy plaintext) must never leave the server.
        var publicProject = {id: project[0].id, name: project[0].name, created_at: project[0].created_at, last_activity: project[0].last_activity};
        if (project[0].expires_at) publicProject.expires_at = project[0].expires_at;

        await ensureLog(sql, projectId);

        if (Number(req.query.v) >= LOG_V) {
          var limit = Math.min(Math.max(parseCursor(req.query.limit) || CHANGE_CAPS.pullDefault, 1), CHANGE_CAPS.pullMax);
          var page = await pullChanges(sql, projectId, parseCursor(req.query.after), limit);
          return res.status(200).json({ v: LOG_V, project: publicProject, changes: page.changes, names: page.names, cursor: page.cursor, more: page.more });
        }

        var all = await pullChanges(sql, projectId, 0, CHANGE_CAPS.legacyView);
        await sql`/* cc:activity */ UPDATE shared_projects SET last_activity = now() WHERE id = ${projectId}`;
        return res.status(200).json({ project: publicProject, issues: legacyView(all.changes) });
      }

      // PUT — v2: append change records. Never rejects an edit for being
      // concurrent with another: that is a conflict for the clients to show.
      case 'PUT': {
        if (!projectId) return res.status(400).json({ error: 'Missing project id' });

        var project = await loadProjectRow(sql, projectId);
        if (project.length === 0 || isExpired(project[0])) return res.status(404).json({ error: 'Project not found' });

        var body = req.body || {};
        if (Number(body.v) !== LOG_V) {
          // An old client (one record per issue, compare-and-swap). Its write
          // is refused as a whole — nothing is stored — and reported in the
          // shape it already shows ("not applied"); reloading updates it.
          var oldIds = Array.isArray(body.issues) ? body.issues.map(function(it) { return it && typeof it.id === 'string' ? it.id : null; }).filter(Boolean).slice(0, 1000) : [];
          return res.status(200).json({ synced: 0, conflicts: oldIds, updatedAt: {}, v: LOG_V, error: 'client_outdated',
            message: 'This shared project now keeps a change log. Reload ClashControl to keep sharing; this edit was not saved.' });
        }
        if (!Array.isArray(body.changes)) return res.status(400).json({ error: 'Missing changes' });
        if (body.changes.length > CHANGE_CAPS.perPut) return res.status(413).json({ error: 'Too many changes in one request', max: CHANGE_CAPS.perPut });
        var userName = isValidStr(body.name, 120) ? body.name.trim() : '';

        var valid = [], invalid = [], rejected = [], seen = {};
        body.changes.forEach(function(raw) {
          var ck = checkChange(raw), r = ck.r;
          if (!r) {
            if (raw && typeof raw.id === 'string' && raw.id.length <= 200) { invalid.push(raw.id); rejected.push({ id: raw.id, reason: ck.reason }); }
            return;
          }
          if (seen[r.id]) return;
          seen[r.id] = true;
          valid.push(r);
        });

        await ensureLog(sql, projectId);
        var inserted = valid.length ? await appendChanges(sql, projectId, valid, function() { return userName || null; }) : [];
        return res.status(200).json({ v: LOG_V, accepted: inserted.length, known: valid.length - inserted.length, invalid: invalid, rejected: rejected });
      }

      // DELETE — Remove a single issue, or (scope=project) the whole shared
      // project and every synced issue in it. Destructive either way, so
      // unlike PUT it requires the creator's editKey on projects that have
      // one (legacy projects and legacy deployments without the column stay
      // open). editKey is accepted via the X-CC-Edit-Key header (preferred —
      // query strings end up in logs/proxies/browser history) or the
      // `editKey` query param, kept only for back-compat with older clients.
      case 'DELETE': {
        if (!projectId) return res.status(400).json({ error: 'Missing project id' });
        var issueId = req.query.issue;
        var wholeProject = req.query.scope === 'project';
        if (!issueId && !wholeProject) return res.status(400).json({ error: 'Missing issue id (or scope=project to delete the whole project)' });

        var pRow = await loadProjectRow(sql, projectId);
        if (pRow.length === 0 || isExpired(pRow[0])) return res.status(404).json({ error: 'Project not found' });
        var storedEditKey = pRow[0].edit_key || null;
        if (storedEditKey) {
          var provided = req.headers['x-cc-edit-key'] || req.body && req.body.editKey || req.query.editKey || '';
          if (!editKeyMatches(provided, storedEditKey)) return res.status(403).json({ error: 'editKey required to delete' });
        }

        if (wholeProject) {
          await sql`/* cc:delete-issues */ DELETE FROM shared_issues WHERE project_id = ${projectId}`;
          try { await sql`/* cc:delete-changes */ DELETE FROM shared_changes WHERE project_id = ${projectId}`; }
          catch (e) { if (!isMissingSchema(e)) throw e; }
          await sql`/* cc:delete-project */ DELETE FROM shared_projects WHERE id = ${projectId}`;
          return res.status(200).json({ ok: true, deletedProject: true });
        }

        // Old clients only: v2 clients share a delete as a change record
        // (everyone sees it in the history; an edit made at the same time is
        // a conflict, resolved by keeping or deleting).
        await sql`/* cc:delete-issue */ DELETE FROM shared_issues WHERE project_id = ${projectId} AND id = ${issueId}`;
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  }
}

module.exports = handler;

// Exposed for direct unit testing (this file has no DOM/browser dependency,
// unlike the addons/*.js IIFEs, so plain CommonJS exports work here).
module.exports.hashEditKey = hashEditKey;
module.exports.editKeyMatches = editKeyMatches;
module.exports.isExpired = isExpired;
module.exports.generateKey = generateKey;
module.exports.validateIssue = validateIssue;
module.exports.stripToShared = stripToShared;
module.exports.validateChange = validateChange;
module.exports.checkChange = checkChange;
module.exports.legacyView = legacyView;
module.exports.LOG_V = LOG_V;
module.exports.CHANGE_CAPS = CHANGE_CAPS;
