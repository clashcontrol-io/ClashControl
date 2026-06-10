'use strict';
// Structural regression lock for exportBCF (index.html). Extracts the function
// from the inline script and runs it against stub JSZip/DOM, then asserts the
// BCF 3.0 layout rules that differ from 2.1 (verified against the official
// buildingSMART BCF-XML release_3_0 schemas):
//   - bcf.version has no DetailedVersion and no xmlns
//   - viewpoints live INSIDE <Topic> as <Viewpoints><ViewPoint Guid>
//   - labels are wrapped <Labels><Label>
//   - Header uses <Files> wrapper + IsExternal
//   - GUIDs (topic folder names included) are lowercase
//   - cameras carry <AspectRatio>
//   - extensions.xml exists at the zip root
// And for 2.1: viewpoints stay at Markup level, repeated <Labels>, DocumentReference inside Topic.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function extractFunction(src, header) {
  // Comments with apostrophes defeat naive brace counting; use the known
  // tail of exportBCF (the download trigger) as the end marker instead.
  const start = src.indexOf(header);
  assert.ok(start !== -1, header + ' not found');
  const tail = 'URL.revokeObjectURL(a.href);';
  const tailPos = src.indexOf(tail, start);
  assert.ok(tailPos !== -1, 'exportBCF tail not found');
  const cbClose = src.indexOf('}', tailPos);          // closes the then() callback
  const fnClose = src.indexOf('}', cbClose + 1);      // closes exportBCF itself
  return src.slice(start, fnClose + 1);
}

function runExport(version) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fnSrc = extractFunction(html, 'function exportBCF(items, version, viewpoints, state)');

  const files = {}; // path -> content
  function makeZip(prefix) {
    return {
      file(name, content) { files[prefix + name] = content; },
      folder(name) { return makeZip(prefix + name + '/'); },
      generateAsync() { return { then() {} }; },
    };
  }
  const sandbox = {
    JSZip: function () { return makeZip(''); },
    guid: () => 'AB12CD34-EF56-0789-ABCD-EF0123456789', // uppercase on purpose
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _gcEvent: () => {},
    _ccChangelogUser: 'Tester',
    _ccRenderSheetToCanvas: () => null,
    window: { CC_VERSION: { v: 'test' }, _ccViewport: { getCamera: () => ({ aspect: 1.5 }) } },
    confirm: () => false,
  };
  const fn = new Function(...Object.keys(sandbox), fnSrc + '; return exportBCF;')(...Object.values(sandbox));

  const items = [{
    id: 'i1', title: 'Duct <hits> beam', type: 'hard', status: 'open',
    description: 'desc', assignee: 'a@b.c', createdAt: '2026-06-10T00:00:00Z',
    revitIdA: '111',
  }];
  const viewpoints = [{
    linkedId: 'i1', snapshot: 'data:image/png;base64,AAAA',
    camera: { px: 1, py: 2, pz: 3, dx: 0, dy: 1, dz: 0, ux: 0, uy: 0, uz: 1 },
  }];
  fn(items, version, viewpoints, {});
  return files;
}

test('BCF 3.0 export is structurally valid per the 3.0 schemas', () => {
  const files = runExport('3.0');
  const names = Object.keys(files);

  assert.ok(files['bcf.version'].includes('VersionId="3.0"'));
  assert.ok(!files['bcf.version'].includes('DetailedVersion'), '3.0 removed DetailedVersion');
  assert.ok(!files['bcf.version'].includes('xmlns'), 'schemas have no target namespace');
  assert.ok(files['extensions.xml'], 'extensions.xml is required at the 3.0 zip root');
  assert.ok(files['project.bcfp'].includes('<ProjectInfo>'));

  const markupName = names.find((n) => n.endsWith('markup.bcf'));
  const topicFolder = markupName.split('/')[0];
  assert.equal(topicFolder, topicFolder.toLowerCase(), '3.0 GUIDs must be lowercase');

  const m = files[markupName];
  assert.ok(!m.includes('xmlns'), 'markup must not carry a namespace');
  assert.ok(/<Files>[\s\S]*<File IsExternal="true">/.test(m), '3.0 Header needs Files wrapper + IsExternal');
  assert.ok(/<Labels>\s*<Label>cc:revitA=111<\/Label>/.test(m), '3.0 labels use Label children');
  // viewpoints must be inside Topic
  const topicEnd = m.indexOf('</Topic>');
  const vpPos = m.indexOf('<ViewPoint Guid=');
  assert.ok(vpPos !== -1 && vpPos < topicEnd, '3.0 ViewPoint must sit inside <Topic>');
  assert.ok(m.indexOf('<Viewpoints>') < vpPos, 'wrapped in <Viewpoints>');

  const bcfvName = names.find((n) => n.endsWith('.bcfv'));
  assert.ok(files[bcfvName].includes('<AspectRatio>'), '3.0 cameras require AspectRatio');
  assert.ok(!files[bcfvName].includes('xmlns'));
});

test('BCF 2.1 export keeps Markup-level viewpoints and repeated Labels', () => {
  const files = runExport('2.1');
  const names = Object.keys(files);
  assert.ok(files['bcf.version'].includes('VersionId="2.1"'));
  assert.ok(files['bcf.version'].includes('DetailedVersion'));
  assert.ok(files['project.bcfp'].includes('<ProjectExtension')); // 2.1 keeps its legacy xmlns

  const m = files[names.find((n) => n.endsWith('markup.bcf'))];
  assert.ok(/<Labels>cc:revitA=111<\/Labels>/.test(m), '2.1 labels are repeated flat elements');
  const topicEnd = m.indexOf('</Topic>');
  const vpPos = m.indexOf('<Viewpoints Guid=');
  assert.ok(vpPos > topicEnd, '2.1 Viewpoints are Markup-level, after Topic');
  const bcfv = files[names.find((n) => n.endsWith('.bcfv'))];
  assert.ok(!bcfv.includes('<AspectRatio>'), 'AspectRatio is 3.0-only');
});
