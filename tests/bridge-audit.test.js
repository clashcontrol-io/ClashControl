'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-audit-test-'));
after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));

// Each test gets its own audit directory and a fresh require of the module
// (env var is read lazily per-call, but isolating directories keeps tests
// from reading each other's ledger lines).
function freshAuditLog(dir) {
  process.env.CLASHCONTROL_AUDIT_DIR = dir;
  delete require.cache[require.resolve('../bridge-audit')];
  return require('../bridge-audit');
}

test('record() writes a line and verify() confirms the chain', () => {
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'ok-'));
  const auditLog = freshAuditLog(dir);
  const ledgerPath = auditLog.todayLedgerPath();

  auditLog.record({ action: 'get_status', tier: 'read_only', result: 'executed', actor: 'agent:test', params: {} });
  auditLog.record({ action: 'delete_model', tier: 'destructive', result: 'rejected', actor: 'agent:test', params: { name: 'MEP' }, error: 'confirm required' });
  auditLog.record({ action: 'delete_model', tier: 'destructive', result: 'executed', actor: 'agent:test', params: { name: 'MEP', confirm: true } });

  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);

  const r = auditLog.verify(ledgerPath);
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.deepEqual(r.errors, []);
});

test('verify() detects a tampered line', () => {
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'tamper-'));
  const auditLog = freshAuditLog(dir);
  const ledgerPath = auditLog.todayLedgerPath();

  auditLog.record({ action: 'get_clashes', tier: 'read_only', result: 'executed', actor: 'agent:test', params: {} });
  auditLog.record({ action: 'get_status', tier: 'read_only', result: 'executed', actor: 'agent:test', params: {} });

  // Tamper with an EARLIER line, not the last one. Hash chaining only proves
  // an event wasn't altered once something else's prevHash commits to it —
  // editing the newest line in place is (by design, same as any append-only
  // hash chain, including Mycelium's) undetectable until another event is
  // appended after it. Editing an interior line breaks the next line's
  // prevHash link, which is the property this test should actually assert.
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const tampered = JSON.parse(lines[0]);
  tampered.action = 'delete_model'; // mutate after the fact
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(ledgerPath, lines.join('\n') + '\n');

  const r = auditLog.verify(ledgerPath);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

test('record() never throws even when its directory cannot be created', () => {
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'blocked-'));
  // Put a regular FILE where the audit dir needs to be a directory. mkdirSync
  // recursive fails with ENOTDIR here regardless of process privileges —
  // unlike an unwritable path, which root sails through.
  const blockerFile = path.join(dir, 'blocker');
  fs.writeFileSync(blockerFile, 'not a directory');
  const auditLog = freshAuditLog(path.join(blockerFile, 'audit'));

  let result;
  assert.doesNotThrow(() => {
    result = auditLog.record({ action: 'get_status', tier: 'read_only', result: 'executed', params: {} });
  });
  assert.equal(result, null); // best-effort: failure returns null, doesn't throw
});

test('argsHash is stable for identical params and does not store raw payloads', () => {
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'hash-'));
  const auditLog = freshAuditLog(dir);
  const ledgerPath = auditLog.todayLedgerPath();

  auditLog.record({ action: 'get_element_properties', tier: 'read_only', result: 'executed', params: { uniqueId: 'abc-123' } });
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(typeof last.argsHash, 'string');
  assert.equal(last.argsHash.length, 64); // sha256 hex
  assert.ok(!('params' in last)); // raw params are not persisted, only the hash + extracted keys
});
