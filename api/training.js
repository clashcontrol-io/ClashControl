// ClashControl — Training data ingestion endpoint
// Replaces Google Forms beacons with proper Postgres storage

var { cors, rateLimit, clientIp, dbUrl: getDbUrl } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require consent — accept header (regular fetch) or body field (sendBeacon
  // can't set custom headers, so unload-time beacons embed consent in the body)
  var bodyConsentOK = req.body && req.body.consent === true;
  if (req.headers['x-cc-consent'] !== 'true' && !bodyConsentOK) {
    return res.status(403).json({ error: 'Consent required' });
  }

  if (rateLimit(clientIp(req), 10)) return res.status(429).json({ error: 'Too many requests' });

  var url = getDbUrl();
  if (!url) return res.status(503).json({ error: 'Database not configured' });

  var body = req.body;
  if (!body) return res.status(400).json({ error: 'Missing body' });

  try {
    var { neon } = require('@neondatabase/serverless');
    var sql = neon(url);

    // Batch payload: { consent, batch: [ { type, ... }, ... ] }
    if (Array.isArray(body.batch)) {
      var inserted = 0, skipped = 0;
      for (var i = 0; i < body.batch.length; i++) {
        var rec = body.batch[i];
        if (!rec || !rec.type) { skipped++; continue; }
        try {
          await insertOne(sql, rec);
          inserted++;
        } catch (e) {
          console.error('Batch row error:', e);
          skipped++;
        }
      }
      return res.status(200).json({ ok: true, inserted: inserted, skipped: skipped });
    }

    if (!body.type) return res.status(400).json({ error: 'Missing type' });
    await insertOne(sql, body);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Training data error:', e);
    res.status(500).json({ error: 'Database error' });
  }
};

async function insertOne(sql, body) {
  switch (body.type) {
    case 'nl_command': {
      await sql`INSERT INTO nl_training (input, matched, action, path, feedback_type, correction_input, correction_intent, confidence, app_version)
        VALUES (${body.input || ''}, ${!!body.matched}, ${body.action || null}, ${body.path || null}, ${body.feedbackType || null}, ${body.correctionInput || null}, ${body.correctionIntent || null}, ${body.confidence || null}, ${body.appVersion || null})`;
      return;
    }
    case 'clash_feedback': {
      await sql`INSERT INTO clash_training (clash_id, feature_vector, label, label_source, app_version)
        VALUES (${body.clashId || ''}, ${JSON.stringify(body.featureVector || {})}, ${body.label || ''}, ${body.labelSource || 'user'}, ${body.appVersion || null})`;
      return;
    }
    case 'detection_run': {
      await sql`INSERT INTO detection_runs (run_id, model_count, clash_count, hard_count, soft_count, duplicate_count, duration_ms, rules, app_version)
        VALUES (${body.runId || ''}, ${body.modelCount || 0}, ${body.clashCount || 0}, ${body.hardCount || 0}, ${body.softCount || 0}, ${body.duplicateCount || 0}, ${body.durationMs || 0}, ${JSON.stringify(body.rules || {})}, ${body.appVersion || null})`;
      return;
    }
    default:
      throw new Error('Unknown type: ' + body.type);
  }
}
