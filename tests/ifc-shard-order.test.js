'use strict';
// Sharded single-file IFC load (flag shardedLoad): each worker streams a
// subset of element ids with StreamMeshes and the main thread merges them by
// their position in the order the single-worker StreamAllMeshes pass yields.
// That only works if _ccIfcStreamOrder (index.html) reproduces StreamAllMeshes'
// order EXACTLY. These tests lock the web-ifc 0.0.77 behaviour it relies on
// and the function itself, on synthetic files only:
//   * StreamMeshes(_ccIfcStreamOrder(...).ids) yields exactly what
//     StreamAllMeshes yields — same elements, same order, same geometry ids,
//     colours and transforms;
//   * the block-cyclic shard split, merged back by global position, is the
//     same sequence for 2..4 shards;
//   * the type order is a fixed function of the type (independent of file
//     order, of which types are present and of the schema), which is what
//     makes a probe model a valid stand-in for the real file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { generateShardIfc, generateSyntheticIfc } = require('./fixtures/generate-synthetic-ifc.js');
const { generateBuilding } = require('./fixtures/generate-building-ifc.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(name) {
  const start = html.indexOf('  function ' + name + '(');
  assert.ok(start !== -1, name + ' not found');
  const end = html.indexOf('\n  }', start) + '\n  }'.length;
  return html.slice(start, end);
}
const { _ccIfcStreamOrder, _ccIfcShardBlock } = new Function(
  extractFn('_ccIfcStreamOrder') + '\n' + extractFn('_ccIfcShardBlock') + '\nreturn { _ccIfcStreamOrder, _ccIfcShardBlock };')();

const WEBIFC = path.join(__dirname, '..', 'node_modules', 'web-ifc', 'web-ifc-api-node.js');
let apiP = null;
function api() {
  if (!apiP) apiP = (async () => { const W = require(WEBIFC); const a = new W.IfcAPI(); await a.Init(); if (a.SetLogLevel) a.SetLogLevel(6); return a; })();
  return apiP;
}
function rec(a, m) {
  return (x) => {
    const g = [];
    for (let i = 0; i < x.geometries.size(); i++) {
      const p = x.geometries.get(i), c = p.color;
      g.push(p.geometryExpressID, c.x, c.y, c.z, c.w, ...Array.from(p.flatTransformation));
    }
    return [x.expressID, a.GetLineType(m, x.expressID), g];
  };
}
function streamAll(a, m) { const out = [], r = rec(a, m); a.StreamAllMeshes(m, (x) => out.push(r(x))); return out; }
function streamIds(a, m, ids) { const out = [], r = rec(a, m); a.StreamMeshes(m, ids, (x) => out.push(r(x))); return out; }
function open(a, text) { return a.OpenModel(typeof text === 'string' ? new TextEncoder().encode(text) : text, { USE_FAST_BOOLS: true }); }

// Every shard streams its block-cyclic slice in global order; merging the
// yielded elements by their global position must give the reference order.
function shardedMerge(a, m, ids, n) {
  const B = _ccIfcShardBlock(ids.length, n);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const all = [];
  for (let k = 0; k < n; k++) {
    const mine = ids.filter((_, i) => Math.floor(i / B) % n === k);
    for (const r of streamIds(a, m, mine)) all.push([pos.get(r[0]), r]);
  }
  all.sort((x, y) => x[0] - y[0]);
  return all.map((x) => x[1]);
}

function fixtures() {
  const b = generateBuilding({ scale: 'ci' });
  return [
    ['shard fixture (interleaved types, shared shapes, styles)', generateShardIfc({ storeys: 3, perStorey: 150, seed: 11 })],
    ['synthetic walls + spaces', generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 6, withSpaces: true })],
    ...Object.keys(b.files).map((k) => ['building ' + k, b.files[k]]),
  ];
}

test('StreamMeshes over _ccIfcStreamOrder ids == StreamAllMeshes (elements, order, geometry ids, colours, transforms)', async () => {
  const a = await api();
  for (const [name, text] of fixtures()) {
    const m = open(a, text);
    const ref = streamAll(a, m);
    const ord = _ccIfcStreamOrder(a, m);
    assert.ok(ord.ok, name + ': order not derivable: ' + ord.why);
    assert.ok(ref.length > 10, name + ': fixture streamed too little');
    assert.deepStrictEqual(streamIds(a, m, ord.ids), ref, name + ': StreamMeshes(order) differs from StreamAllMeshes');
    for (const n of [2, 3, 4]) assert.deepStrictEqual(shardedMerge(a, m, ord.ids, n), ref, name + ': ' + n + '-shard merge differs');
    a.CloseModel(m);
  }
});

test('the shard fixture exercises what the merge must preserve', async () => {
  const a = await api();
  const m = open(a, generateShardIfc({ storeys: 3, perStorey: 150, seed: 11 }));
  const ref = streamAll(a, m);
  const types = new Set(ref.map((r) => r[1]));
  assert.ok(types.size >= 25, 'many element types: ' + types.size);
  const ids = ref.map((r) => r[0]);
  assert.notDeepStrictEqual(ids, ids.slice().sort((x, y) => x - y), 'stream order must differ from file order');
  const geoUse = {};
  ref.forEach((r) => { for (let i = 0; i < r[2].length; i += 21) geoUse[r[2][i]] = (geoUse[r[2][i]] || 0) + 1; });
  assert.ok(Object.values(geoUse).some((c) => c >= 8), 'shared geometry (instancing)');
  assert.ok(ref.some((r) => r[2][4] < 0.05), 'a ~transparent style');
  a.CloseModel(m);
});

test('type order is fixed: independent of file order, type subset and schema', async () => {
  const a = await api();
  const orders = {};
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3']) {
    const seedModel = open(a, generateSyntheticIfc({ storeyCount: 1, wallsPerStorey: 1 }).replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('" + schema + "'))"));
    const ord = _ccIfcStreamOrder(a, seedModel);
    a.CloseModel(seedModel);
    assert.ok(ord.types.length > 80, schema + ': probe streamed ' + ord.types.length + ' types');
    orders[schema] = ord.types;
    // The probe skips exactly what StreamAllMeshes skips.
    const yielded = new Set(ord.types.map((t) => a.GetNameFromTypeCode(t).toUpperCase()));
    for (const skip of ['IFCOPENINGELEMENT', 'IFCSPACE']) assert.ok(!yielded.has(skip), schema + ' streams ' + skip);
    // Same types written in reverse / a subset: same relative order.
    const names = ord.types.map((t) => a.GetNameFromTypeCode(t).toUpperCase());
    for (const variant of [names.slice().reverse(), names.filter((_, i) => i % 3 === 1)]) {
      const lines = variant.map((n, i) => `#${100 + i}=${n}('${String(i).padStart(22, '0')}',$,$,$,$,#7,#14,$,$);`);
      const probeLike = extractProbeHeader(schema) + lines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;';
      const pm = open(a, probeLike);
      const got = []; a.StreamAllMeshes(pm, (x) => got.push(a.GetLineType(pm, x.expressID)));
      a.CloseModel(pm);
      const set = new Set(got);
      assert.deepStrictEqual(got, ord.types.filter((t) => set.has(t)), schema + ': type order depends on the file');
    }
  }
  const rel = (x, y) => { const sy = new Set(y), sx = new Set(x); return [x.filter((t) => sy.has(t)), y.filter((t) => sx.has(t))]; };
  for (const [p, q] of [['IFC2X3', 'IFC4'], ['IFC4', 'IFC4X3'], ['IFC2X3', 'IFC4X3']]) {
    const [x, y] = rel(orders[p], orders[q]);
    assert.deepStrictEqual(x, y, p + ' vs ' + q + ': relative type order differs');
  }
});

// The probe model's header + shared shape (same text _ccIfcStreamOrder writes).
function extractProbeHeader(schema) {
  return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('t'),'2;1');", "FILE_NAME('t.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('" + schema + "'));", 'ENDSEC;', 'DATA;',
    "#1=IFCPROJECT('0000000000000000000001',$,$,$,$,$,$,(#4),#2);", '#2=IFCUNITASSIGNMENT((#3));', '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    "#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#5,$);", '#5=IFCAXIS2PLACEMENT3D(#6,$,$);', '#6=IFCCARTESIANPOINT((0.,0.,0.));',
    '#7=IFCLOCALPLACEMENT($,#5);', '#8=IFCAXIS2PLACEMENT2D(#9,$);', '#9=IFCCARTESIANPOINT((0.,0.));', '#10=IFCRECTANGLEPROFILEDEF(.AREA.,$,#8,1.,1.);',
    '#11=IFCDIRECTION((0.,0.,1.));', '#12=IFCEXTRUDEDAREASOLID(#10,#5,#11,1.);', "#13=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#12));",
    '#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));', ''].join('\n');
}

test('a type the probe cannot place makes the order unknown (caller loads in one worker)', async () => {
  const a = await api();
  const m = open(a, generateShardIfc({ storeys: 1, perStorey: 20 }));
  // Simulate a web-ifc whose probe misses a type present in the file.
  const fake = Object.create(a);
  const wallType = a.GetTypeCodeFromName('IFCWALL');
  fake.StreamAllMeshes = (pm, cb) => a.StreamAllMeshes(pm, (x) => { if (a.GetLineType(pm, x.expressID) !== wallType) cb(x); });
  const ord = _ccIfcStreamOrder(fake, m);
  assert.strictEqual(ord.ok, false);
  assert.match(ord.why, /IfcWall/i);
  a.CloseModel(m);
});

test('shard blocks: at least 32 elements, ~16 blocks per shard', () => {
  assert.strictEqual(_ccIfcShardBlock(100, 2), 32);
  assert.strictEqual(_ccIfcShardBlock(32000, 2), 1000);
  assert.strictEqual(_ccIfcShardBlock(32001, 2), 1001);
});
