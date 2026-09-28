// ClashControl test helper — installs a fake `@neondatabase/serverless` in
// Node's module cache so api/project.js's lazy `require('@neondatabase/serverless')`
// picks it up instead of trying to open a real network connection.
//
// api/project.js resolves POSTGRES_URL via api/_lib.js's dbUrl(), so
// installMockNeon() also stubs process.env.POSTGRES_URL for the duration of
// the test (restored by the returned `restore()`).
//
// Usage:
//   const { installMockNeon } = require('./_neon-mock');
//   const mock = installMockNeon([
//     () => [{ id: 'p1', name: 'x', edit_key: null }],  // 1st sql`` call
//     () => [{ id: 'a', updated_at: new Date().toISOString() }], // 2nd call
//     () => [],                                          // 3rd call
//   ]);
//   const handler = require('../api/project.js'); // require AFTER installMockNeon
//   ...
//   mock.restore();
//
// Each reaction is `(strings, values) => rows` (or an already-resolved
// array), consumed in call order; a reaction may also throw/return a
// rejected promise to simulate a DB error. Running past the end of the
// list throws loudly (a test forgot to script a call, better than silently
// returning undefined and masking a bug in the query sequence).
'use strict';

const path = require('node:path');
const Module = require('node:module');

function resolveNeonPath() {
  return Module._resolveFilename('@neondatabase/serverless', {
    paths: Module._nodeModulePaths(path.join(process.cwd(), 'api')),
  });
}

function installMockNeon(reactions) {
  const neonPath = resolveNeonPath();
  const prevCacheEntry = require.cache[neonPath];
  const prevPostgresUrl = process.env.POSTGRES_URL;
  const calls = [];
  let cursor = 0;

  function sqlTag(strings, ...values) {
    calls.push({ text: strings.join('?'), values });
    if (cursor >= reactions.length) {
      throw new Error('_neon-mock: no scripted reaction for sql call #' + (cursor + 1) + ' (' + strings.join('?') + ')');
    }
    const reaction = reactions[cursor++];
    const result = typeof reaction === 'function' ? reaction(strings, values) : reaction;
    return Promise.resolve(result);
  }

  require.cache[neonPath] = {
    id: neonPath,
    filename: neonPath,
    loaded: true,
    exports: { neon: () => sqlTag },
  };
  process.env.POSTGRES_URL = 'postgres://mock/db';

  return {
    calls,
    restore() {
      if (prevCacheEntry) require.cache[neonPath] = prevCacheEntry;
      else delete require.cache[neonPath];
      if (prevPostgresUrl === undefined) delete process.env.POSTGRES_URL;
      else process.env.POSTGRES_URL = prevPostgresUrl;
      // api/project.js itself has no state to reset, but clear its cache
      // entry too so the next installMockNeon's require picks up a handler
      // that re-does its own lazy `require('@neondatabase/serverless')`.
      delete require.cache[require.resolve('../api/project.js')];
    },
  };
}

module.exports = { installMockNeon };
