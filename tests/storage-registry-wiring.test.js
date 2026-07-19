'use strict';
// Pins every persistent store to the storage-core registry — the Loam-style
// discipline that keeps retention policy explicit. A new localStorage key or
// IndexedDB object store added anywhere in the app without a registry row
// (family + retention class) fails here, so "how does this data get pruned?"
// is answered at introduction time, not at quota-exceeded time.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const core = require('../storage-core');

const root = join(__dirname, '..');
const sources = [['index.html', readFileSync(join(root, 'index.html'), 'utf8')]];
for (const f of readdirSync(join(root, 'addons')).filter(f => f.endsWith('.js'))) {
  sources.push(['addons/' + f, readFileSync(join(root, 'addons', f), 'utf8')]);
}

// Literal cc_* keys used with any localStorage/pref accessor. Dynamic keys
// (prefix + variable) surface here as their literal prefix, which is exactly
// what the registry's prefix families match.
function literalKeys(src) {
  const keys = new Set();
  const re = /(?:localStorage\.(?:setItem|getItem|removeItem)\(\s*|_ccLsSet\(\s*|Item\(\s*)?['"](cc_[A-Za-z0-9_:.-]*)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

test('every literal cc_* localStorage key in the app matches a registry family', () => {
  const unregistered = [];
  for (const [file, src] of sources) {
    for (const key of literalKeys(src)) {
      // Bare prefixes of dynamic keys: complete them with a dummy suffix so
      // prefix families match ('cc_chat_msgs_' + pid, 'cc_align_' + name…).
      const probe = /[_:]$/.test(key) ? key + 'x' : key;
      if (!core.classifyKey(probe)) unregistered.push(file + ': ' + key);
    }
  }
  assert.deepEqual(unregistered, [],
    'unregistered localStorage keys found — add a family (with a retention class) to LS_REGISTRY in storage-core.js: ' +
    unregistered.join(', '));
});

test('every IndexedDB object store (core + addons) is pinned in IDB_REGISTRY', () => {
  const html = sources[0][1];
  // The core app declares its stores via IDB_* constants — resolve those.
  const resolve = (token) => {
    if (/^['"]/.test(token)) return token.slice(1, -1);
    const cm = html.match(new RegExp('var ' + token + " = '([^']+)'"));
    return cm ? cm[1] : token;
  };
  const storeNames = new Set();
  const re = /createObjectStore\(\s*([A-Za-z_$][\w$]*|['"][^'"]+['"])/g;
  for (const [, src] of sources) {
    let m;
    while ((m = re.exec(src)) !== null) storeNames.add(resolve(m[1]));
  }
  assert.ok(storeNames.size >= 3, 'expected at least the three ClashControlFiles stores, found: ' + [...storeNames].join(', '));
  const registered = new Set(core.IDB_REGISTRY.map(r => r.store));
  const missing = [...storeNames].filter(s => !registered.has(s));
  assert.deepEqual(missing, [],
    'IndexedDB stores missing from IDB_REGISTRY in storage-core.js: ' + missing.join(', '));
});

test('registry retention classes are the closed known set', () => {
  const known = new Set(['source', 'derived', 'decay', 'prefs']);
  for (const fam of core.LS_REGISTRY) {
    assert.ok(known.has(fam.retention), fam.family + ' has unknown retention ' + fam.retention);
  }
  for (const row of core.IDB_REGISTRY) {
    assert.ok(known.has(row.retention), row.store + ' has unknown retention ' + row.retention);
  }
});

test('the storage-core script is wired into index.html next to its sibling core modules', () => {
  const html = sources[0][1];
  assert.match(html, /<script src="storage-core\.js" defer><\/script>/);
});
