// ClashControl — Shared project & issues sync endpoint
// No login required — uses shareable project keys

var { cors, rateLimit, clientIp } = require('./_lib');

// Generate a short project key: PREFIX-XXXXXX
function generateKey(name) {
  var prefix = (name || 'CC')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase();
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars
  var suffix = '';
  for (var i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return prefix + '-' + suffix;
}

// Validate the minimal shared issue shape
function validateIssue(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (!issue.id || typeof issue.id !== 'string') return false;
  // Must have at least identity (globalIds or title) + status
  if (!issue.status) return false;
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

  if (rateLimit(clientIp(req), 30)) return res.status(429).json({ error: 'Too many requests' });

  var dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return res.status(503).json({ error: 'Database not configured' });

  var { neon } = require('@neondatabase/serverless');
  var sql = neon(dbUrl);

  var projectId = req.query.id || null;

  try {
    switch (req.method) {

      // POST — Create a new shared project
      case 'POST': {
        var body = req.body || {};
        var name = (body.name || 'Untitled Project').slice(0, 100);
        var key = generateKey(name);

        // Ensure uniqueness (collision is astronomically unlikely but be safe)
        var existing = await sql`SELECT id FROM shared_projects WHERE id = ${key}`;
        if (existing.length > 0) key = generateKey(name); // retry once

        await sql`INSERT INTO shared_projects (id, name) VALUES (${key}, ${name})`;

        // If initial issues are provided, insert them
        if (body.issues && Array.isArray(body.issues)) {
          for (var issue of body.issues) {
            if (!validateIssue(issue)) continue;
            var shared = stripToShared(issue);
            await sql`INSERT INTO shared_issues (id, project_id, data, updated_by)
              VALUES (${shared.id}, ${key}, ${JSON.stringify(shared)}, ${body.user || 'anonymous'})`;
          }
        }

        return res.status(201).json({ id: key, name: name });
      }

      // GET — Pull all issues for a project
      case 'GET': {
        if (!projectId) return res.status(400).json({ error: 'Missing project id' });

        var project = await sql`SELECT id, name, created_at, last_activity FROM shared_projects WHERE id = ${projectId}`;
        if (project.length === 0) return res.status(404).json({ error: 'Project not found' });

        var issues = await sql`SELECT id, data, updated_by, updated_at FROM shared_issues WHERE project_id = ${projectId} ORDER BY updated_at DESC`;

        // Update last_activity
        await sql`UPDATE shared_projects SET last_activity = now() WHERE id = ${projectId}`;

        return res.status(200).json({
          project: project[0],
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

        var project = await sql`SELECT id FROM shared_projects WHERE id = ${projectId}`;
        if (project.length === 0) return res.status(404).json({ error: 'Project not found' });

        var body = req.body || {};
        var issues = body.issues || [];
        var user = body.user || 'anonymous';
        var synced = 0;
        var conflicts = [];

        for (var issue of issues) {
          if (!validateIssue(issue)) continue;
          var shared = stripToShared(issue);

          // Check if server has a newer version
          var existing = await sql`SELECT updated_at FROM shared_issues WHERE project_id = ${projectId} AND id = ${shared.id}`;

          if (existing.length > 0 && issue._updatedAt) {
            var serverTime = new Date(existing[0].updated_at).getTime();
            var clientTime = new Date(issue._updatedAt).getTime();
            if (serverTime > clientTime) {
              // Server wins — return conflict for client to merge
              conflicts.push(shared.id);
              continue;
            }
          }

          // Upsert
          await sql`INSERT INTO shared_issues (id, project_id, data, updated_by)
            VALUES (${shared.id}, ${projectId}, ${JSON.stringify(shared)}, ${user})
            ON CONFLICT (project_id, id)
            DO UPDATE SET data = ${JSON.stringify(shared)}, updated_by = ${user}, updated_at = now()`;
          synced++;
        }

        await sql`UPDATE shared_projects SET last_activity = now() WHERE id = ${projectId}`;

        return res.status(200).json({ synced: synced, conflicts: conflicts });
      }

      // DELETE — Remove a single issue
      case 'DELETE': {
        if (!projectId) return res.status(400).json({ error: 'Missing project id' });
        var issueId = req.query.issue;
        if (!issueId) return res.status(400).json({ error: 'Missing issue id' });

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
