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
  // the batch leaves the outbox only after the file is written; a failure releases it
  assert.ok(source.indexOf('sess.done(recs);') > source.indexOf('await _writeNew(mine, name'), 'done only after the write');
  assert.match(source, /sess\.release\(recs\);/);
  assert.match(source, /write failed, will retry/);
  assert.match(source, /Shared folder access lost/);
  const core = fs.readFileSync(path.join(__dirname, '..', 'shared-session-core.js'), 'utf8');
  assert.match(core, /ls\.setItem\(obKey, JSON\.stringify\(\{ pk: env\.projectKey/);
});

test('the core dispatch wrapper feeds local (non-sync) edits to every shared session (folder and cloud)', () => {
  const i = html.indexOf('_SSC.noteAll(a, _stateRef.current, _slIds);');
  assert.ok(i > 0);
  const block = html.slice(html.lastIndexOf("if (!a._fromSync && a.t !== A.APPEND_CHANGELOG", i), i);
  assert.ok(block.length > 0 && block.length < 6000, 'inside the !_fromSync branch');
  // the old cloud path (whole-issue push, CAS rejection, "not applied" toasts) is gone
  assert.ok(!/_sharedEnqueue|syncConflictOne|syncConflictMany|_sharedLastSeen|_sharedHydrate/.test(html));
  // remote changes are applied with _fromSync, so they are never re-recorded
  const core = fs.readFileSync(path.join(__dirname, '..', 'shared-session-core.js'), 'utf8');
  const sends = core.match(/dd?\(\{ t: '(UPD_ISSUE|ADD_ISSUE|DEL_ISSUE|ADD_COMMENT|UPD_COMMENT|DEL_COMMENT|ADD_VIEWPOINT|UPD_VIEWPOINT|DEL_VIEWPOINT|CLASH_BATCH_RESTORE)'.*?\}\);/g) || [];
  assert.ok(sends.length >= 10, 'found ' + sends.length);
  sends.forEach((m) => assert.match(m, /_fromSync: true/, m));
  // both transports use the same engine
  assert.match(source, /SC\.createSession\(\{\s*src: 'folder'/);
  assert.match(html, /SC\.createSession\(\{\s*src: 'cloud'/);
});

test('shared-log-core.js and shared-session-core.js are loaded, precached and type-checked like the other core modules', () => {
  for (const f of ['shared-log-core', 'shared-session-core']) {
    assert.match(html, new RegExp('<script src="' + f + '\\.js" defer><\\/script>'));
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), new RegExp("'" + f + "\\.js'"));
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'), new RegExp(f + '\\.js'));
  }
  assert.ok(html.indexOf('src="shared-log-core.js"') < html.indexOf('src="shared-session-core.js"'), 'log core first');
  // the cloud function bundles the cores it requires
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.match(v.functions['api/project.js'].includeFiles, /shared-log-core\.js/);
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
