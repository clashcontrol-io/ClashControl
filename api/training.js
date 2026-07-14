// ClashControl — Training data ingestion endpoint
// Replaces Google Forms beacons with bounded, validated Postgres storage.

var { cors, llmGuard, dbUrl: getDbUrl } = require('./_lib');

// These limits cover the client-side ring buffers (5,000 clash records,
// 2,000 NL records, plus detection summaries) while still putting a hard
// ceiling on anonymous ingestion work and stored field sizes.
var MAX_BATCH_RECORDS = 8000;
var MAX_BODY_BYTES = 2 * 1024 * 1024;

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require consent — accept header (regular fetch) or body field (sendBeacon
  // can't set custom headers, so unload-time beacons embed consent in the body).
  var bodyConsentOK = req.body && req.body.consent === true;
  if (req.headers['x-cc-consent'] !== 'true' && !bodyConsentOK) {
    return res.status(403).json({ error: 'Consent required' });
  }

  if (llmGuard(req, res, { perMin: 10, maxBytes: MAX_BODY_BYTES })) return;

  var body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Missing or invalid body' });
  }

  var records;
  var isBatch = Array.isArray(body.batch);
  if (isBatch) {
    if (body.batch.length > MAX_BATCH_RECORDS) {
      return res.status(413).json({ error: 'Batch too large', maxRecords: MAX_BATCH_RECORDS });
    }
    records = body.batch.map(normalizeRecord);
    if (!records.some(Boolean)) {
      return res.status(400).json({ error: 'Batch contains no valid records' });
    }
  } else {
    var record = normalizeRecord(body);
    if (!record) return res.status(400).json({ error: 'Invalid or unknown training record type' });
    records = [record];
  }

  var url = getDbUrl();
  if (!url) return res.status(503).json({ error: 'Database not configured' });

  try {
    var { neon } = require('@neondatabase/serverless');
    var sql = neon(url);
    var inserted = 0;
    var skipped = isBatch ? body.batch.length - records.filter(Boolean).length : 0;

    for (var i = 0; i < records.length; i++) {
      if (!records[i]) continue;
      try {
        await insertOne(sql, records[i]);
        inserted++;
      } catch (e) {
        console.error('Training row error:', e);
        skipped++;
      }
    }

    if (isBatch) return res.status(200).json({ ok: true, inserted: inserted, skipped: skipped });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Training data error:', e);
    return res.status(500).json({ error: 'Database error' });
  }
};

function text(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// The browser already replaces loaded model names before sending. Repeat the
// privacy boundary here for obvious paths/contact details so direct callers
// cannot bypass the client-side minimisation step.
function sanitizeCommand(value) {
  return text(value, 2000)
    .replace(/[A-Z]:\\[^\s"']+/gi, '[PATH]')
    .replace(/\/(?:Users|home)\/[^\s"']+/gi, '[PATH]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
}

function finiteNumber(value, min, max) {
  var n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, n));
}

function boundedJSON(value, depth) {
  depth = depth || 0;
  if (depth > 5 || value === undefined || typeof value === 'function') return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') return text(value, 256);
  if (Array.isArray(value)) return value.slice(0, 128).map(function(v) { return boundedJSON(v, depth + 1); });
  if (typeof value === 'object') {
    var out = {};
    Object.keys(value).slice(0, 128).forEach(function(k) {
      out[text(k, 100)] = boundedJSON(value[k], depth + 1);
    });
    return out;
  }
  return null;
}

function normalizeRecord(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  switch (body.type) {
    case 'nl_command':
      return {
        type: 'nl_command',
        input: sanitizeCommand(body.input),
        matched: !!body.matched,
        action: text(body.action, 100) || null,
        path: text(body.path, 100) || null,
        feedbackType: text(body.feedbackType, 50) || null,
        correctionInput: sanitizeCommand(body.correctionInput) || null,
        correctionIntent: text(body.correctionIntent, 100) || null,
        confidence: body.confidence == null ? null : finiteNumber(body.confidence, 0, 1),
        appVersion: text(body.appVersion, 40) || null,
      };
    case 'clash_feedback':
      return {
        type: 'clash_feedback',
        clashId: text(body.clashId, 200),
        featureVector: boundedJSON(body.featureVector || {}) || {},
        label: text(body.label, 100),
        labelSource: text(body.labelSource, 100) || 'user',
        appVersion: text(body.appVersion, 40) || null,
      };
    case 'detection_run':
      return {
        type: 'detection_run',
        runId: text(body.runId, 200),
        modelCount: finiteNumber(body.modelCount, 0, 1000000),
        clashCount: finiteNumber(body.clashCount, 0, 100000000),
        hardCount: finiteNumber(body.hardCount, 0, 100000000),
        softCount: finiteNumber(body.softCount, 0, 100000000),
        duplicateCount: finiteNumber(body.duplicateCount, 0, 100000000),
        durationMs: finiteNumber(body.durationMs, 0, 86400000),
        rules: boundedJSON(body.rules || {}) || {},
        appVersion: text(body.appVersion, 40) || null,
      };
    default:
      return null;
  }
}

async function insertOne(sql, body) {
  switch (body.type) {
    case 'nl_command':
      await sql`INSERT INTO nl_training (input, matched, action, path, feedback_type, correction_input, correction_intent, confidence, app_version)
        VALUES (${body.input}, ${body.matched}, ${body.action}, ${body.path}, ${body.feedbackType}, ${body.correctionInput}, ${body.correctionIntent}, ${body.confidence}, ${body.appVersion})`;
      return;
    case 'clash_feedback':
      await sql`INSERT INTO clash_training (clash_id, feature_vector, label, label_source, app_version)
        VALUES (${body.clashId}, ${JSON.stringify(body.featureVector)}, ${body.label}, ${body.labelSource}, ${body.appVersion})`;
      return;
    case 'detection_run':
      await sql`INSERT INTO detection_runs (run_id, model_count, clash_count, hard_count, soft_count, duplicate_count, duration_ms, rules, app_version)
        VALUES (${body.runId}, ${body.modelCount}, ${body.clashCount}, ${body.hardCount}, ${body.softCount}, ${body.duplicateCount}, ${body.durationMs}, ${JSON.stringify(body.rules)}, ${body.appVersion})`;
      return;
  }
}

// Pure helpers are exposed for regression tests; the Vercel handler remains
// the default export and its runtime contract is unchanged.
module.exports._normalizeRecord = normalizeRecord;
module.exports._limits = { maxBatchRecords: MAX_BATCH_RECORDS, maxBodyBytes: MAX_BODY_BYTES };
