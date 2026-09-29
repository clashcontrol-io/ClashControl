// locales/loader.js startup behaviour: a saved language pack is actually
// loaded (it used to wait for the Settings panel), a first visit auto-
// detects from navigator.languages WITHOUT persisting it, and an explicit
// English choice ('' saved) is never overridden.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'locales', 'loader.js'), 'utf8');
const MANIFEST = [{ lang: 'ja', file: 'ja.json' }, { lang: 'pt-BR', file: 'pt-BR.json' }];

function run({ saved, languages }) {
  const store = new Map();
  if (saved !== undefined) store.set('cc_locale', saved);
  const calls = [];
  const window = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) },
    navigator: { languages, language: languages[0] },
    _ccRegisterLocalePack: (p) => calls.push(['register', p.lang]),
    _ccSetLocale: (lang, opts) => calls.push(['set', lang, opts]),
  };
  const fetch = (url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(url.endsWith('manifest.json')
      ? MANIFEST
      : { lang: path.basename(url, '.json'), strings: { k: 'v' } }),
  });
  vm.runInNewContext(SRC, { window, fetch, console });
  // JSON round-trip: objects built inside the vm context have a foreign
  // Object.prototype, which deepStrictEqual treats as different.
  return new Promise((r) => setTimeout(() => r(JSON.parse(JSON.stringify(calls))), 20));
}

test('first visit: browser language matched by primary subtag, not persisted', async () => {
  const calls = await run({ languages: ['ja-JP', 'en-US'] });
  assert.deepStrictEqual(calls, [['register', 'ja'], ['set', 'ja', { persist: false }]]);
});

test('first visit: pack region variant matched from bare tag', async () => {
  const calls = await run({ languages: ['pt'] });
  assert.deepStrictEqual(calls.at(-1), ['set', 'pt-BR', { persist: false }]);
});

test('first visit: English ranked first wins over a later pack language', async () => {
  assert.deepStrictEqual(await run({ languages: ['en-GB', 'ja'] }), []);
});

test('first visit: no matching pack stays English', async () => {
  assert.deepStrictEqual(await run({ languages: ['de-DE', 'fr'] }), []);
});

test('saved language is loaded at startup and stays persisted', async () => {
  const calls = await run({ saved: 'ja', languages: ['en-US'] });
  assert.deepStrictEqual(calls, [['register', 'ja'], ['set', 'ja', { persist: true }]]);
});

test('explicit English choice is never overridden by the browser language', async () => {
  assert.deepStrictEqual(await run({ saved: '', languages: ['ja-JP'] }), []);
});

test('saved language whose pack was removed from the manifest is ignored', async () => {
  assert.deepStrictEqual(await run({ saved: 'xx', languages: ['ja'] }), []);
});
