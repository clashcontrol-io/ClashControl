'use strict';
// A Confirm-promoted clash issue (_ccBuildConfirmIssue, index.html ~1790)
// carries globalIdA/globalIdB via _issueIdentityFromClash. exportBCF turns
// those into <Components><Selection><Component IfcGuid=...> inside the
// viewpoint (.bcfv) file so the topic actually has selectable elements when
// opened in BIMcollab/Solibri/Navisworks/ClashControl itself. This test
// locks that the confirm→export pipeline still produces those elements.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const header = 'function ' + name + '(';
  const start = html.indexOf('  ' + header);
  assert.ok(start !== -1, name + ' not found');
  const end = html.indexOf('\n  }', start) + '\n  }'.length;
  return html.slice(start, end);
}

function extractExportBCF() {
  const header = 'function exportBCF(';
  const start = html.indexOf(header);
  assert.ok(start !== -1, 'exportBCF not found');
  const tail = 'URL.revokeObjectURL(a.href);';
  const tailPos = html.indexOf(tail, start);
  const cbClose = html.indexOf('}', tailPos);
  const fnClose = html.indexOf('}', cbClose + 1);
  return html.slice(start, fnClose + 1);
}

const bundle = [
  extractFn('_issueIdentityFromClash'),
  extractFn('_ccBuildConfirmIssue'),
  extractFn('_lookupElBox'),
  extractFn('_ccBoxFinite'),
  extractFn('_ccSynthesizeViewpoint'),
  extractExportBCF(),
].join('\n');

function build() {
  const files = {};
  function makeZip(prefix) {
    return {
      file(name, content) { files[prefix + name] = content; },
      folder(name) { return makeZip(prefix + name + '/'); },
      generateAsync() { return { then() {} }; },
    };
  }
  const sandbox = {
    JSZip: function () { return makeZip(''); },
    guid: () => 'AB12CD34-EF56-0789-ABCD-EF0123456789',
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _gcEvent: () => {},
    _ccChangelogUser: 'Tester',
    _ccRenderSheetToCanvas: () => null,
    _ccGetBcfProjectGuid: () => 'PROJECT-GUID',
    _ccSummarizeModelScope: () => ({ complete: true, partialModels: [] }),
    _bcfSceneToIfc: (v) => ({ x: v.x, y: -v.z, z: v.y }),
    A: { UPD_ISSUE: 'UPD_ISSUE', UPD_VIEWPOINT: 'UPD_VIEWPOINT' },
    window: { CC_VERSION: { v: 'test' }, _ccViewport: { getCamera: () => ({ aspect: 1.5 }) }, _ccDispatch: null },
    confirm: () => false,
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    bundle + '; return { exportBCF, _ccBuildConfirmIssue };'
  )(...Object.values(sandbox));
  return { fn, files };
}

test('a confirmed clash exports <Components><Selection><Component IfcGuid=...> in its viewpoint', () => {
  const { fn, files } = build();
  const clash = {
    id: 'c1', title: 'Pipe vs beam', description: 'desc', priority: 'high', type: 'hard',
    globalIdA: '1AbCdEfGhIjKlMnOpQrStU', globalIdB: '2AbCdEfGhIjKlMnOpQrStU',
    modelAId: 'm1', modelBId: 'm1', elemA: 10, elemB: 20,
  };
  const issue = fn._ccBuildConfirmIssue(clash);
  assert.equal(issue.globalIdA, clash.globalIdA);
  assert.equal(issue.globalIdB, clash.globalIdB);

  const models = [{
    id: 'm1',
    elements: [
      { expressId: 10, box: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } },
      { expressId: 20, box: { min: { x: 2, y: 2, z: 2 }, max: { x: 3, y: 3, z: 3 } } },
    ],
  }];
  fn.exportBCF([issue], '2.1', [], { models: models });

  const bcfvPath = Object.keys(files).find((n) => n.endsWith('.bcfv'));
  assert.ok(bcfvPath, 'a .bcfv viewpoint file must be written for a confirmed clash with element identity');
  const bcfv = files[bcfvPath];
  assert.ok(bcfv.includes('<Components>'));
  assert.ok(bcfv.includes('<Selection>'));
  assert.ok(bcfv.includes('<Component IfcGuid="' + clash.globalIdA + '"/>'));
  assert.ok(bcfv.includes('<Component IfcGuid="' + clash.globalIdB + '"/>'));
});
