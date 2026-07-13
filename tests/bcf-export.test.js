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

  // bcfGuid is set explicitly on both items - the sandbox's guid() stub
  // always returns the same fixed value, which would make two items
  // collide on the same zip folder and silently overwrite each other.
  const items = [{
    id: 'i1', bcfGuid: 'topic-1', title: 'Duct <hits> beam', type: 'hard', status: 'open',
    description: 'desc', assignee: 'a@b.c', createdAt: '2026-06-10T00:00:00Z',
    revitIdA: '111', globalIdA: 'GUID_DUCT_AAAA', globalIdB: 'GUID_BEAM_BBBB',
    globalIds: ['GUID_DUCT_AAAA', 'GUID_BEAM_BBBB'],
  }, {
    id: 'i2', bcfGuid: 'topic-2', title: 'No identity data', type: 'soft', status: 'open',
    description: 'desc', createdAt: '2026-06-10T00:00:00Z',
  }];
  const viewpoints = [{
    linkedId: 'i1', snapshot: 'data:image/png;base64,AAAA',
    camera: { px: 1, py: 2, pz: 3, dx: 0, dy: 1, dz: 0, ux: 0, uy: 0, uz: 1 },
  }, {
    linkedId: 'i2', snapshot: 'data:image/png;base64,AAAA',
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

test('viewpoints carry <Components><Selection> for the participating elements, deduplicated', () => {
  const files = runExport('3.0');
  const bcfvName = Object.keys(files).find((n) => n.startsWith('topic-1/') && n.endsWith('.bcfv'));
  const bcfv = files[bcfvName];
  assert.ok(bcfv.includes('<Components>'), 'Components block must be present when identity data exists');
  // Scoped to <Selection> specifically — <Coloring> (below) legitimately
  // repeats globalIdA/B in its own <Component> entries, so counting matches
  // across the whole file would no longer reflect Selection's own dedup.
  const selection = /<Selection>([\s\S]*?)<\/Selection>/.exec(bcfv)[1];
  const compMatches = selection.match(/<Component IfcGuid="[^"]*"\/>/g) || [];
  assert.deepEqual(compMatches.sort(), [
    '<Component IfcGuid="GUID_BEAM_BBBB"/>',
    '<Component IfcGuid="GUID_DUCT_AAAA"/>',
  ], 'globalIds and globalIdA/B overlap - each GUID must appear exactly once in Selection, not 4 times');
});

test('<Visibility DefaultVisibility="true"/> is present whenever <Components> is (required by the 2.1 schema)', () => {
  ['2.1', '3.0'].forEach((version) => {
    const files = runExport(version);
    const bcfvName = Object.keys(files).find((n) => n.startsWith('topic-1/') && n.endsWith('.bcfv'));
    const bcfv = files[bcfvName];
    assert.ok(bcfv.includes('<Visibility DefaultVisibility="true"/>'), version + ' must emit Visibility');
    const selEnd = bcfv.indexOf('</Selection>');
    const visPos = bcfv.indexOf('<Visibility');
    assert.ok(visPos > selEnd, version + ': Visibility must follow Selection (schema order)');
  });
});

test('no <Visibility>/<Coloring> when there is no <Components> block at all', () => {
  const files = runExport('3.0');
  const bcfvName = Object.keys(files).find((n) => n.startsWith('topic-2/') && n.endsWith('.bcfv'));
  const bcfv = files[bcfvName];
  assert.ok(!bcfv.includes('<Visibility'));
  assert.ok(!bcfv.includes('<Coloring'));
});

test('<Coloring> reuses the clash-focus A/B colors (#ef4444/#22d3ee) for a clash-pair item, 6 hex digits, no #', () => {
  ['2.1', '3.0'].forEach((version) => {
    const files = runExport(version);
    const bcfvName = Object.keys(files).find((n) => n.startsWith('topic-1/') && n.endsWith('.bcfv'));
    const bcfv = files[bcfvName];
    assert.ok(/<Color Color="EF4444">[\s\S]*GUID_DUCT_AAAA[\s\S]*<\/Color>/.test(bcfv), version + ': A-side color');
    assert.ok(/<Color Color="22D3EE">[\s\S]*GUID_BEAM_BBBB[\s\S]*<\/Color>/.test(bcfv), version + ': B-side color');
    const coloringPos = bcfv.indexOf('<Coloring>');
    const visPos = bcfv.indexOf('<Visibility');
    assert.ok(coloringPos > visPos, version + ': Coloring must follow Visibility (schema order)');
  });
});

test('BCF 3.0 <Color> wraps its <Component> in a nested <Components> element; 2.1 does not (verified against both release XSDs)', () => {
  const v3 = runExport('3.0');
  const bcfv3 = v3[Object.keys(v3).find((n) => n.startsWith('topic-1/') && n.endsWith('.bcfv'))];
  assert.ok(/<Color Color="EF4444">\s*<Components>\s*<Component IfcGuid="GUID_DUCT_AAAA"\/>\s*<\/Components>\s*<\/Color>/.test(bcfv3));

  const v21 = runExport('2.1');
  const bcfv21 = v21[Object.keys(v21).find((n) => n.startsWith('topic-1/') && n.endsWith('.bcfv'))];
  assert.ok(/<Color Color="EF4444">\s*<Component IfcGuid="GUID_DUCT_AAAA"\/>\s*<\/Color>/.test(bcfv21));
  assert.ok(!bcfv21.includes('<Components>\n          <Component'), '2.1 must not nest an inner <Components> inside <Color>');
});

test('no <Coloring> for a single-GUID item (DQ/accessibility issue) — nothing to contrast a color against', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fnSrc = extractFunction(html, 'function exportBCF(items, version, viewpoints, state)');
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
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _gcEvent: () => {}, _ccChangelogUser: 'Tester', _ccRenderSheetToCanvas: () => null,
    window: { CC_VERSION: { v: 'test' }, _ccViewport: { getCamera: () => ({ aspect: 1.5 }) } },
    confirm: () => false,
  };
  const fn = new Function(...Object.keys(sandbox), fnSrc + '; return exportBCF;')(...Object.values(sandbox));
  const items = [{
    id: 'i3', bcfGuid: 'topic-3', title: 'DQ finding', type: 'soft', status: 'open',
    description: 'desc', createdAt: '2026-06-10T00:00:00Z', globalIds: ['GUID_SOLO_ONLY'],
  }];
  const viewpoints = [{
    linkedId: 'i3', snapshot: 'data:image/png;base64,AAAA',
    camera: { px: 1, py: 2, pz: 3, dx: 0, dy: 1, dz: 0, ux: 0, uy: 0, uz: 1 },
  }];
  fn(items, '3.0', viewpoints, {});
  const bcfv = files[Object.keys(files).find((n) => n.startsWith('topic-3/') && n.endsWith('.bcfv'))];
  assert.ok(bcfv.includes('<Selection>'), 'Selection must still be present — there is one GUID to select');
  assert.ok(bcfv.includes('<Visibility DefaultVisibility="true"/>'), 'Visibility is unconditional whenever Components exists');
  assert.ok(!bcfv.includes('<Coloring'), 'no A/B pair to color, so Coloring must be omitted');
});

test('<Components> precedes the camera element (BCF schema element order)', () => {
  const files = runExport('3.0');
  const bcfvName = Object.keys(files).find((n) => n.startsWith('topic-1/') && n.endsWith('.bcfv'));
  const bcfv = files[bcfvName];
  const compPos = bcfv.indexOf('<Components>');
  const camPos = bcfv.indexOf('<PerspectiveCamera>');
  assert.ok(compPos !== -1 && camPos !== -1 && compPos < camPos);
});

test('no <Components> block at all when the item carries no identity data (avoids an empty, pointless element)', () => {
  const files = runExport('3.0');
  const bcfvName = Object.keys(files).find((n) => n.startsWith('topic-2/') && n.endsWith('.bcfv'));
  const bcfv = files[bcfvName];
  assert.ok(!bcfv.includes('<Components>'));
});

test('<Components><Selection> shape matches what ClashControl\'s own BCF importer parses back out', () => {
  // The importer (index.html, BCF import) does vdoc.querySelectorAll('Component')
  // and reads the IfcGuid attribute - confirm the exporter's tag/attribute name
  // matches exactly, both BCF versions, so CC can round-trip its own exports.
  ['2.1', '3.0'].forEach((version) => {
    const files = runExport(version);
    const bcfvName = Object.keys(files).find((n) => n.startsWith('topic-1/') && n.endsWith('.bcfv'));
    const bcfv = files[bcfvName];
    assert.ok(/<Selection>[\s\S]*<Component IfcGuid="GUID_DUCT_AAAA"\/>[\s\S]*<\/Selection>/.test(bcfv));
  });
});
