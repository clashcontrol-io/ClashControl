'use strict';

// Shared folder (addons/shared-project.js, docs/INTERNALS.md §21.55): the
// folder is a per-user append-only change log. Wiring checks on the addon
// source + the idle-sync guard that MERGE_COMMENTS still needs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'addons', 'shared-project.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('linking a folder iterates the directory with for-await (dirHandle.values() is not a promise)', () => {
  assert.ok(!/\.values\(\)\.then/.test(source), 'the old .values().then never completed in Chrome');
  assert.ok(!/\.entries\(\)\.then/.test(source));
  assert.match(source, /for await \(var pair of dir\.entries\(\)\)/);
});

test('nothing is ever rewritten: every write creates a new, uniquely named file', () => {
  // the only writer
  const writes = source.match(/createWritable\(/g) || [];
  assert.strictEqual(writes.length, 1, 'one write helper');
  assert.match(source, /async function _writeNew\(dir, name, obj\)/);
  // its callers: the change file (writer + seq), the snapshot (user + ts),
  // the project id file (random), the migration snapshot (content hash)
  const calls = source.match(/_writeNew\(/g) || [];
  assert.strictEqual(calls.length, 5, 'definition + 4 callers: ' + calls.length);
  assert.match(source, /C\.changeFileName\(_writer, seq\)/);
  assert.match(source, /C\.snapshotName\(_userId, ts\)/);
  assert.match(source, /'project-' \+ _rand\(12\) \+ '\.json'/);
  assert.ok(!/\.ccproject', \{create:true\}/.test(source), 'the old project file is never written');
});

test('a failed write keeps the changes pending (and in localStorage) instead of looking synced', () => {
  assert.match(source, /_outbox = _outbox\.slice\(recs\.length\);/);
  assert.match(source, /write failed, will retry/);
  assert.match(source, /Shared folder access lost/);
  assert.match(source, /localStorage\.setItem\(key, JSON\.stringify\(\{pk:_projKey/);
});

test('the core dispatch wrapper feeds local (non-sync) edits to the change log', () => {
  const i = html.indexOf("if (typeof window._ccSharedLogNote === 'function') {");
  assert.ok(i > 0);
  const block = html.slice(html.lastIndexOf("if (!a._fromSync && a.t !== A.APPEND_CHANGELOG", i), i);
  assert.ok(block.length > 0 && block.length < 6000, 'inside the !_fromSync branch');
  assert.match(html.slice(i, i + 600), /window\._ccSharedLogNote\(a, _stateRef\.current, _slIds\)/);
  // remote changes are applied with _fromSync, so they are never re-recorded
  (source.match(/_d\(\{t:'(UPD_ISSUE|ADD_ISSUE|DEL_ISSUE|ADD_COMMENT|UPD_COMMENT|DEL_COMMENT|CLASH_BATCH_RESTORE)'.*?\}\);/g) || [])
    .forEach((m) => assert.match(m, /_fromSync:true/, m));
});

test('shared-log-core.js is loaded, precached and type-checked like the other core modules', () => {
  assert.match(html, /<script src="shared-log-core\.js" defer><\/script>/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), /'shared-log-core\.js'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'), /shared-log-core\.js/);
});

test('MERGE_COMMENTS with nothing new keeps the state object (an idle sync is not a change)', () => {
  const start = html.indexOf('case A.MERGE_COMMENTS: {');
  const body = html.slice(html.indexOf('{', start) + 1, html.indexOf('\n      }', start));
  const reduce = new Function('s', 'a', body);
  const c1 = { id: 'x', ts: 5 }, c2 = { id: 'y', ts: 6 };
  const s = { comments: [c1, c2] };
  assert.strictEqual(reduce(s, { v: [{ id: 'x', ts: 5 }] }), s, 'same or older remote copy: unchanged');
  const s2 = reduce(s, { v: [{ id: 'x', ts: 9 }] });
  assert.notStrictEqual(s2, s);
  assert.equal(s2.comments[0].ts, 9);
  assert.equal(reduce(s, { v: [{ id: 'z', ts: 1 }] }).comments.length, 3);
});
