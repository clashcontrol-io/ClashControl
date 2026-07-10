'use strict';
/**
 * ClashControl Smart Bridge — tool-call audit ledger
 *
 * Append-only, hash-chained JSONL log of every tool call the bridge forwards
 * to the browser (or blocks via bridge-governance.js). One file per UTC day
 * under ~/.clashcontrol/audit/, mirroring the ~/.clashcontrol/llm-config.json
 * directory convention already used by smart-bridge-server.js.
 *
 * The event shape and hash-chaining algorithm are ported from Mycelium's
 * public provenance reference implementation (Mycelium/lib/provenance.mjs —
 * same canonical key order, same SHA-256(prevEvent) chaining), so a ledger
 * written here verifies with the same algorithm the spine project documents,
 * and the two are structurally comparable even though this file is CommonJS
 * (bundled into a pkg binary) and the Mycelium original is ESM.
 *
 * Best-effort: a failure to write never blocks or throws back into the tool
 * call path (same rule PDRA's AuditLog.cs documents) — logging is a
 * diagnostic aid, not a gate.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Computed lazily (not cached at module load) so tests can point HOME at a
// scratch directory before the first call instead of writing into the real
// user's home directory.
function auditDir() {
  return process.env.CLASHCONTROL_AUDIT_DIR || path.join(os.homedir(), '.clashcontrol', 'audit');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Stable key order so prevHash is reproducible regardless of insertion order.
function canonical(event) {
  const order = [
    'id', 'prevHash', 'ts', 'source', 'action', 'actor', 'tier', 'result',
    'targetKeys', 'durationMs', 'argsHash', 'resultHash', 'error',
  ];
  const o = {};
  for (const k of order) if (k in event) o[k] = event[k];
  return JSON.stringify(o);
}

function todayLedgerPath(now) {
  const d = now || new Date();
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(auditDir(), iso + '.jsonl');
}

function lastHash(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return null;
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return null;
  return sha256(canonical(JSON.parse(lines[lines.length - 1])));
}

// Pulls a handful of likely element/clash identifiers out of tool params so
// the ledger is searchable without storing full geometry/property payloads.
function extractTargetKeys(params) {
  if (!params || typeof params !== 'object') return [];
  const keys = [];
  for (const k of ['uniqueId', 'globalId', 'revitId', 'clashIndex', 'issueIndex', 'sheetId', 'name']) {
    if (params[k] != null) keys.push(String(params[k]));
  }
  for (const k of ['uniqueIds', 'globalIds', 'revitIds']) {
    if (Array.isArray(params[k])) keys.push(...params[k].slice(0, 20).map(String));
  }
  return keys;
}

/**
 * Append one tool-call event. Never throws — returns null on any failure so
 * callers can fire-and-forget.
 *
 *   record({ action, tier, result, actor, durationMs, params, resultData, error })
 */
function record(entry) {
  try {
    fs.mkdirSync(auditDir(), { recursive: true });
    const ledgerPath = todayLedgerPath();
    const argsJson = JSON.stringify(entry.params || {});
    const event = {
      id: crypto.randomUUID(),
      prevHash: lastHash(ledgerPath),
      ts: new Date().toISOString(),
      source: 'clashcontrol-bridge',
      action: entry.action,
      actor: entry.actor || 'agent:mcp-bridge',
      tier: entry.tier,
      result: entry.result, // 'executed' | 'rejected' | 'failed'
      targetKeys: extractTargetKeys(entry.params),
      durationMs: entry.durationMs,
      argsHash: sha256(argsJson),
      resultHash: entry.resultData !== undefined ? sha256(JSON.stringify(entry.resultData)) : undefined,
      error: entry.error,
    };
    fs.appendFileSync(ledgerPath, JSON.stringify(event) + '\n');
    return event;
  } catch (_) {
    return null; // best-effort — never let audit logging break a tool call
  }
}

// Walks a ledger file and confirms every event's prevHash matches the
// canonical hash of the event before it. Used by tests and by an operator
// wanting to confirm the log hasn't been edited after the fact.
function verify(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { ok: true, count: 0, errors: [] };
  const errors = [];
  let prev = null;
  let count = 0;
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line) continue;
    count++;
    const e = JSON.parse(line);
    if (e.prevHash !== prev) errors.push({ index: count - 1, id: e.id, expected: prev, actual: e.prevHash });
    prev = sha256(canonical(e));
  }
  return { ok: errors.length === 0, count, errors };
}

module.exports = { record, verify, todayLedgerPath, canonical, sha256, auditDir };
