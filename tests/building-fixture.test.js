'use strict';
// The federated accuracy fixture (tests/fixtures/generate-building-ifc.js)
// must be real, loadable IFC: web-ifc 0.0.77 (the version the app pins) parses
// all three models and produces geometry for EVERY product that has a
// representation (streamed mesh count per IFC type == generator's count), the
// repeated-geometry share stays <= 10 %, and every planted case's manifest
// category holds on the tessellation web-ifc actually produces (checked with
// the exact oracle on world triangles built the way the app builds them:
// Float32 local vertices x Float64 placement -> Float32 world).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateBuilding } = require('./fixtures/generate-building-ifc.js');
const O = require('./_oracle-exact.js');

const WEBIFC = path.join(__dirname, '..', 'node_modules', 'web-ifc', 'web-ifc-api-node.js');
// StreamAllMeshes skips IfcOpeningElement (subtracted from the host) and
// IfcSpace (the app re-adds spaces without meshes); both are streamed in a
// second pass with StreamAllMeshesWithTypes so their geometry is verified too.
const SECOND_PASS = ['IFCOPENINGELEMENT', 'IFCSPACE'];

let apiP = null;
function api() {
  if (!apiP) apiP = (async () => { const W = require(WEBIFC); const a = new W.IfcAPI(); await a.Init(); return a; })();
  return apiP;
}

// Parse one model: per product {type, guid, tris(Float32 world), geoHashes[]}
async function parseModel(text) {
  const a = await api();
  const id = a.OpenModel(new Uint8Array(Buffer.from(text)), { USE_FAST_BOOLS: true });
  const out = new Map();
  const W = require(WEBIFC);
  try {
    const onMesh = (pass) => (mesh) => {
      const eid = mesh.expressID;
      const type = a.GetNameFromTypeCode(a.GetLineType(id, eid));
      const tris = [], hashes = [];
      for (let g = 0; g < mesh.geometries.size(); g++) {
        const placed = mesh.geometries.get(g);
        const gd = a.GetGeometry(id, placed.geometryExpressID);
        const v = a.GetVertexArray(gd.GetVertexData(), gd.GetVertexDataSize());
        const ix = a.GetIndexArray(gd.GetIndexData(), gd.GetIndexDataSize());
        const h = crypto.createHash('sha1');
        const pos = new Float32Array(v.length / 2);
        for (let i = 0, j = 0; i < v.length; i += 6, j += 3) { pos[j] = v[i]; pos[j + 1] = v[i + 1]; pos[j + 2] = v[i + 2]; }
        h.update(Buffer.from(pos.buffer)); h.update(Buffer.from(new Uint32Array(ix).buffer));
        hashes.push(h.digest('hex'));
        const m = placed.flatTransformation;
        for (let t = 0; t < ix.length; t++) {
          const k = ix[t] * 3, x = pos[k], y = pos[k + 1], z = pos[k + 2];
          tris.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        if (typeof gd.delete === 'function') gd.delete();
      }
      const line = a.GetLine(id, eid);
      out.set(eid, { type: type.toUpperCase(), pass, guid: line && line.GlobalId ? line.GlobalId.value : '', tris: Float32Array.from(tris), hashes });
    };
    a.StreamAllMeshes(id, onMesh(1));
    a.StreamAllMeshesWithTypes(id, SECOND_PASS.map((n) => W[n]), onMesh(2));
  } finally { a.CloseModel(id); }
  return out;
}

async function checkVariant(t, georef) {
  const g = generateBuilding({ scale: 'ci', seed: 4242, georef });
  const byGuid = new Map();
  const typeTally = {};
  let streamed = 0, geoms = 0;
  const hashCount = new Map();
  for (const key of ['architecture', 'structure', 'mep']) {
    const parsed = await parseModel(g.files[key]);
    const counts = {};
    for (const p of parsed.values()) {
      counts[p.type] = (counts[p.type] || 0) + 1;
      assert.ok(p.tris.length >= 9 * 4, `${key}: ${p.type} ${p.guid} produced only ${p.tris.length / 9} triangles`);
      byGuid.set(p.guid, Object.assign({ model: key }, p));
      streamed++;
      for (const h of p.hashes) { hashCount.set(h, (hashCount.get(h) || 0) + 1); geoms++; }
    }
    for (const p of parsed.values()) assert.strictEqual(p.pass === 2, SECOND_PASS.includes(p.type), `${p.type} streamed in the wrong pass`);
    const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort());
    assert.deepStrictEqual(sortKeys(counts), sortKeys(g.stats.typeCounts[key]), `${key}: streamed mesh count per IFC type must equal the generator's product count`);
    typeTally[key] = counts;
  }
  let repeated = 0;
  for (const c of hashCount.values()) if (c > 1) repeated += c - 1;
  const share = repeated / geoms;
  console.log(`[${georef}] web-ifc streamed ${streamed} products / ${geoms} geometries; repeated geometry by content ${repeated} (${(share * 100).toFixed(2)} %); generator signature share ${(g.stats.repeatedGeometryShare * 100).toFixed(2)} %`);
  assert.ok(share <= 0.10, `repeated geometry share ${share} exceeds 10 %`);
  assert.ok(g.stats.repeatedGeometryShare <= 0.10);
  const bytes = Object.values(g.stats.bytes).reduce((s, v) => s + v, 0);
  assert.ok(bytes < 2 * 1024 * 1024, `CI-size federation must stay < 2 MB (got ${bytes})`);

  // planted cases vs exact oracle on web-ifc tessellation
  const rows = [];
  for (const c of g.manifest.cases) {
    const A = byGuid.get(c.a.globalId), B = byGuid.get(c.b.globalId);
    assert.ok(A && B, `${c.id}: planted elements not found in parsed models`);
    const o = O.classifyPair(A.tris, B.tris, { assumeClosed: true });
    const within = o.distance === 0 || O.cmpDistToRational(o, 1, 20) <= 0;
    let ok;
    if (c.category === 'clearance' || c.category === 'separate') {
      ok = (o.category === 'clearance' || o.category === 'separate') &&
        (c.toleranceRelation === 'at' ? true : c.toleranceRelation === 'below' ? within : c.toleranceRelation === 'above' ? !within : true);
    } else ok = o.category === c.category;
    rows.push({ id: c.id, name: c.name, manifest: c.category, oracle: o.category, distM: o.distance, intended: c.distanceM, ok });
  }
  for (const r of rows) console.log(`  ${r.id} ${r.ok ? 'ok  ' : 'DIFF'} ${r.manifest.padEnd(10)} oracle=${r.oracle.padEnd(10)} d=${r.distM}${r.intended != null ? ' (intended ' + r.intended + ')' : ''}  ${r.name}`);
  return { rows, typeTally };
}

test('building fixture (local georef): web-ifc geometry for every product, <=10 % repeated, manifest holds on the tessellation', async (t) => {
  const { rows } = await checkVariant(t, 'local');
  const bad = rows.filter((r) => !r.ok);
  assert.deepStrictEqual(bad, [], 'planted manifest categories must hold on web-ifc tessellation near the origin');
});

test('building fixture (far, ~100 km from origin): parses identically; Float32 drift of planted cases is reported', async (t) => {
  const { rows } = await checkVariant(t, 'far');
  // Near-origin cases are exact; 100 km out, Float32 world coordinates
  // (ulp 7.8 mm) can move a horizontal planted gap across the tolerance —
  // the app has no origin shift, so this is what it sees. Only the x-gap case
  // is horizontal-and-tolerance-sensitive by design; every other case holds.
  const bad = rows.filter((r) => !r.ok && !/x-gap/.test(r.name));
  assert.deepStrictEqual(bad, [], 'planted categories other than the Float32-sensitive x-gap must hold in the far variant');
});
