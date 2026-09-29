// Legacy selection-set refs (no modelId): _ccSelSetAmbiguity finds entries
// whose expressId exists in more than one loaded model; _ccResolveSelSetRefs
// pins them to the user's chosen model (or expands to every model with '*').
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('  var _ccEidModelsCache = new WeakMap();');
const end = html.indexOf('  // Stamp the participating-element identities from a clash');
assert.ok(start > 0 && end > start, 'helper block not found');
const ctx = {};
vm.runInNewContext(html.slice(start, end) + '\nthis.amb=_ccSelSetAmbiguity; this.res=_ccResolveSelSetRefs;', ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));

const models = [
  { id: 'arch', elements: [{ expressId: 10 }, { expressId: 11 }, { expressId: 12 }] },
  { id: 'mep', elements: [{ expressId: 10 }, { expressId: 20 }] },
];

test('finds only legacy refs present in more than one model', () => {
  const refs = [{ expressId: 10 }, { expressId: 11 }, { expressId: 10, modelId: 'mep' }, { expressId: 99 }];
  assert.deepStrictEqual(plain(ctx.amb(refs, models)), {
    ambiguous: [{ expressId: 10, modelIds: ['arch', 'mep'] }], pinnable: 1, modelIds: ['arch', 'mep'],
  });
});

test('choosing a model pins ambiguous + single-model legacy refs, keeps unknown ones', () => {
  const refs = [{ expressId: 10 }, { expressId: 11 }, { expressId: 99 }, { expressId: 20, modelId: 'mep' }];
  assert.deepStrictEqual(plain(ctx.res(refs, models, 'mep')), [
    { expressId: 10, modelId: 'mep' }, { expressId: 11, modelId: 'arch' }, { expressId: 99 }, { expressId: 20, modelId: 'mep' },
  ]);
});

test("'*' expands an ambiguous ref to one explicit ref per matching model", () => {
  assert.deepStrictEqual(plain(ctx.res([{ expressId: 10, name: 'x' }], models, '*')), [
    { expressId: 10, name: 'x', modelId: 'arch' }, { expressId: 10, name: 'x', modelId: 'mep' },
  ]);
});

test('resolving never duplicates a ref the set already holds explicitly', () => {
  const refs = [{ expressId: 10, modelId: 'mep' }, { expressId: 10 }];
  assert.deepStrictEqual(plain(ctx.res(refs, models, 'mep')), [{ expressId: 10, modelId: 'mep' }]);
});

test('a set with no legacy refs reports nothing to resolve', () => {
  assert.strictEqual(ctx.amb([{ expressId: 10, modelId: 'arch' }], models).ambiguous.length, 0);
});

test('the navigator shows the chip + resolver wired to UPD_SELSET_REFS', () => {
  assert.match(html, /var amb = _ccSelSetAmbiguity\(ss\.refs, s\.models\);/);
  assert.match(html, /refs:_ccResolveSelSetRefs\(ss\.refs, s\.models, choice\)/);
  assert.match(html, /resolveTo\('\*'\)/);
});
