// ClashControl — Shared project & issues sync endpoint
// No login required — uses shareable project keys

var { cors, llmGuard, dbUrl: getDbUrl } = require('./_lib');

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
    return await sql`SELECT id, name, created_at, last_activity, edit_key, expires_at FROM shared_projects WHERE id = ${projectId}`;
  } catch (e1) {
    try {
      return await sql`SELECT id, name, created_at, last_activity, edit_key FROM shared_projects WHERE id = ${projectId}`;
    } catch (e2) {
      return await sql`SELECT id, name, created_at, last_activity FROM shared_projects WHERE id = ${projectId}`;
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

// Validate the minimal shared issue shape
function validateIssue(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (!issue.id || typeof issue.id !== 'string') return false;
  // Must have at least identity (globalIds or title) + status
  if (!issue.status) return false;
  if (!issue.globalIdA && !issue.globalIdB && !(issue.title && String(issue.title).trim())) return false;
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
    distance: issue.distance || null,
    status: issue.status || 'open',
    priority: issue.priority || 'normal',
    assignee: issue.assignee || null,
    title: issue.title || '',
    description: issue.description || null,
    category: issue.category || null,
    dueDate: issue.dueDate || null,
    source: issue.source || null,
    createdAt: issue.createdAt || null,
  };
}

module.exports = async function handler(req, res) {
  if (cors(req, res, 'GET, POST, PUT, DELETE')) return;

  // Rate limit + payload cap — this is the only unauthenticated DB-write
  // endpoint, so unbounded PUT bodies could bloat Postgres. 256 KB fits a
  // ~1000-issue batch (shared records are ~250 bytes each).
  if (llmGuard(req, res, { perMin: 30, maxBytes: 262144 })) return;

  var url = getDbUrl();
  if (!url) return res.status(503).json({ error: 'Database not configured' });

  var { neon } = require('@neondatabase/serverless');
  var sql = neon(url);

  var projectId = req.query.id || null;

  try {
    switch (req.method) {

      // POST — Create a new shared project
      case 'POST': {
        var body = req.body || {};
        var name = (body.name || 'Untitled Project').slice(0, 100);

        // Ensure uniqueness — re-check after every regeneration (the old
        // single retry could still 500 on a second collision).
        var key, taken, tries = 0;
        do {
          key = generateKey(name);
          taken = await sql`SELECT id FROM shared_projects WHERE id = ${key}`;
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
            await sql`INSERT INTO shared_projects (id, name, edit_key, expires_at) VALUES (${key}, ${name}, ${editKeyHash}, ${expiresAt})`;
          } else {
            await sql`INSERT INTO shared_projects (id, name, edit_key) VALUES (${key}, ${name}, ${editKeyHash})`;
          }
        } catch (colErr) {
          await sql`INSERT INTO shared_projects (id, name) VALUES (${key}, ${name})`;
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
            await sql`INSERT INTO shared_issues (id, project_id, data, updated_by)
              SELECT r.id, ${key}, r.data, ${body.user || 'anonymous'}
              FROM jsonb_to_recordset(${JSON.stringify(initRows)}::jsonb) AS r(id text, data jsonb)
              ON CONFLICT (project_id, id) DO NOTHING`;
          }
        }

        return res.status(201).json({ id: key, name: name, editKey: editKey });
      }

      // GET — Pull all issues for a project
      case 'GET': {
        if (!projectId) return res.status(400).json({ error: 'Missing project id' });

        var project = await loadProjectRow(sql, projectId);
        if (project.length === 0 || isExpired(project[0])) return res.status(404).json({ error: 'Project not found' });

        var issues = await sql`SELECT id, data, updated_by, updated_at FROM shared_issues WHERE project_id = ${projectId} ORDER BY updated_at DESC`;

        // Update last_activity
        await sql`UPDATE shared_projects SET last_activity = now() WHERE id = ${projectId}`;

        // edit_key (hash or legacy plaintext) must never leave the server.
        var publicProject = {id: project[0].id, name: project[0].name, created_at: project[0].created_at, last_activity: project[0].last_activity};
        if (project[0].expires_at) publicProject.expires_at = project[0].expires_at;

        return res.status(200).json({
          project: publicProject,
          issues: issues.map(function(row) {
            var d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            d._updatedBy = row.updated_by;
            d._updatedAt = row.updated_at;
            return d;
          }),
        });
      }

      // PUT — Push issue changes (sync)
      case 'PUT': {
        if (!projectId) return res.status(400).json({ error: 'Missing project id' });

        var project = await loadProjectRow(sql, projectId);
        if (project.length === 0 || isExpired(project[0])) return res.status(404).json({ error: 'Project not found' });

        var body = req.body || {};
        var issues = (body.issues || []).filter(validateIssue);
        var user = body.user || 'anonymous';
        var conflicts = [];

        // Atomic compare-and-swap in a SINGLE statement — no read-then-write
        // window. The previous version did SELECT updated_at, then compared in
        // JS, then upserted unconditionally: two writers could both read the
        // same baseline, both pass the JS check, and both overwrite (a lost
        // update). Here the timestamp guard lives inside the ON CONFLICT DO
        // UPDATE, so Postgres decides per-row under the row lock it already
        // takes for the upsert. A row is written iff it's new OR the DB's
        // current updated_at has not advanced past what this client last saw
        // (`_updatedAt`); otherwise it's skipped and reported as a conflict for
        // the client to merge. `expected` is null for an issue the client has
        // never synced — a new id inserts (no conflict), and an already-present
        // id with a null expectation is treated as a conflict (updated_at <=
        // null is UNKNOWN → not updated).
        var rows = issues.map(function(issue) {
          var shared = stripToShared(issue);
          return {
            id: shared.id,
            data: shared,
            expected: (issue._updatedAt != null ? new Date(issue._updatedAt).toISOString() : null),
          };
        });
        var ids = rows.map(function(r) { return r.id; });

        var written = [];
        if (rows.length) {
          written = await sql`
            WITH incoming AS (
              SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
                AS r(id text, data jsonb, expected timestamptz)
            )
            INSERT INTO shared_issues (id, project_id, data, updated_by)
            SELECT i.id, ${projectId}, i.data, ${user} FROM incoming i
            ON CONFLICT (project_id, id)
            DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()
            WHERE shared_issues.updated_at <= (
              SELECT i2.expected FROM incoming i2 WHERE i2.id = shared_issues.id
            )
            RETURNING id`;
        }

        var writtenIds = {};
        written.forEach(function(row) { writtenIds[row.id] = true; });
        // Anything attempted but not written back existed with a newer (or
        // unknown-to-this-client) server version — a conflict to merge.
        conflicts = ids.filter(function(id) { return !writtenIds[id]; });

        await sql`UPDATE shared_projects SET last_activity = now() WHERE id = ${projectId}`;

        return res.status(200).json({ synced: written.length, conflicts: conflicts });
      }

      // DELETE — Remove a single issue. Destructive, so unlike PUT it
      // requires the creator's editKey on projects that have one (legacy
      // projects and legacy deployments without the column stay open).
      case 'DELETE': {
        if (!projectId) return res.status(400).json({ error: 'Missing project id' });
        var issueId = req.query.issue;
        if (!issueId) return res.status(400).json({ error: 'Missing issue id' });

        var pRow = await loadProjectRow(sql, projectId);
        if (pRow.length === 0 || isExpired(pRow[0])) return res.status(404).json({ error: 'Project not found' });
        var storedEditKey = pRow[0].edit_key || null;
        if (storedEditKey) {
          var provided = req.headers['x-cc-edit-key'] || req.query.editKey || '';
          if (!editKeyMatches(provided, storedEditKey)) return res.status(403).json({ error: 'editKey required to delete' });
        }

        await sql`DELETE FROM shared_issues WHERE project_id = ${projectId} AND id = ${issueId}`;
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (e) {
    console.error('Project sync error:', e);
    return res.status(500).json({ error: 'Database error' });
  }
};

// Exposed for direct unit testing (this file has no DOM/browser dependency,
// unlike the addons/*.js IIFEs, so plain CommonJS exports work here).
module.exports.hashEditKey = hashEditKey;
module.exports.editKeyMatches = editKeyMatches;
module.exports.isExpired = isExpired;
module.exports.generateKey = generateKey;
module.exports.validateIssue = validateIssue;
module.exports.stripToShared = stripToShared;
