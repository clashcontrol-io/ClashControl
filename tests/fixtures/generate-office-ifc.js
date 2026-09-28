'use strict';
// Small, realistic federated office fixture: Architecture (slabs/walls/
// columns/beams) + MEP (ducts/pipes) that clash against it — used by
// tests/browser/office-clash-parity.mjs as a WASM-vs-JS narrow-phase
// differential + a known-count regression lock.
//
// Deterministic: GUIDs come from a seeded PRNG (mulberry32, same generator
// tests/wasm-parity.test.js uses), not Math.random(), so re-running this
// generator with the same options always produces byte-identical IFC. NLEV
// (levels) is an option, mirroring the ad-hoc genfx-big.js pattern this was
// ported from — see the module's own doc comment on `generate` below.
//
// Usage as a CLI: `node tests/fixtures/generate-office-ifc.js [outDir]`
// writes office-architecture.ifc / office-mep.ifc (default outDir: this
// directory) using the default options (nlev=3, seed=1337).

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate an Architecture/MEP IFC pair.
 * @param {object} [opts]
 * @param {number} [opts.nlev=3] - number of building storeys (levels 0, 3.5, 7, ...)
 * @param {number} [opts.seed=1337] - PRNG seed for deterministic GUIDs
 * @returns {{ architecture: string, mep: string }}
 */
function generate(opts) {
  opts = opts || {};
  const nlev = opts.nlev || 3;
  const rnd = mulberry32(opts.seed || 1337);

  function mkIfc(name, build) {
    let id = 100;
    const L = [];
    const n = () => ++id;
    const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    const g = () => {
      let s = '';
      for (let i = 0; i < 22; i++) s += GUID_CHARS[Math.floor(rnd() * 64)];
      return s;
    };
    const P = (...a) => { const i = n(); L.push(`#${i}=IFCCARTESIANPOINT((${a.map((v) => v.toFixed(3)).join(',')}));`); return i; };
    const D = (...a) => { const i = n(); L.push(`#${i}=IFCDIRECTION((${a.map((v) => v.toFixed(3)).join(',')}));`); return i; };
    const A3 = (o, z, x) => { const i = n(); L.push(`#${i}=IFCAXIS2PLACEMENT3D(#${o},${z ? '#' + z : '$'},${x ? '#' + x : '$'});`); return i; };
    const ORIG = P(0, 0, 0);
    const ORIG2 = n(); L.push(`#${ORIG2}=IFCCARTESIANPOINT((0.,0.));`);
    const A2 = n(); L.push(`#${A2}=IFCAXIS2PLACEMENT2D(#${ORIG2},$);`);
    const W = A3(ORIG);
    const CTX = n(); L.push(`#${CTX}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#${W},$);`);
    const UNIT = n(), U = n();
    L.push(`#${U}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`, `#${UNIT}=IFCUNITASSIGNMENT((#${U}));`);
    const PROJ = n(); L.push(`#${PROJ}=IFCPROJECT('${g()}',$,'Demo Office',$,$,$,$,(#${CTX}),#${UNIT});`);
    const SITEP = n(); L.push(`#${SITEP}=IFCLOCALPLACEMENT($,#${W});`);
    const SITE = n(); L.push(`#${SITE}=IFCSITE('${g()}',$,'Site',$,$,#${SITEP},$,$,.ELEMENT.,(52,22,0,0),(4,53,0,0),0.,$,$);`);
    const BP = n(); L.push(`#${BP}=IFCLOCALPLACEMENT(#${SITEP},#${W});`);
    const B = n(); L.push(`#${B}=IFCBUILDING('${g()}',$,'Office Block',$,$,#${BP},$,$,.ELEMENT.,$,$,$);`);
    L.push(`#${n()}=IFCRELAGGREGATES('${g()}',$,$,$,#${PROJ},(#${SITE}));`, `#${n()}=IFCRELAGGREGATES('${g()}',$,$,$,#${SITE},(#${B}));`);
    const storeys = [];
    const levels = Array.from({ length: nlev }, (_, i) => i * 3.5);
    levels.forEach((z, k) => {
      const o = P(0, 0, z);
      const pl = n(); L.push(`#${pl}=IFCLOCALPLACEMENT(#${BP},#${A3(o)});`);
      const s = n(); L.push(`#${s}=IFCBUILDINGSTOREY('${g()}',$,'Level ${k}',$,$,#${pl},$,$,.ELEMENT.,${z.toFixed(1)});`);
      storeys.push({ id: s, pl, z, els: [] });
    });
    L.push(`#${n()}=IFCRELAGGREGATES('${g()}',$,$,$,#${B},(${storeys.map((s) => '#' + s.id).join(',')}));`);
    const EXT = D(0, 0, 1);
    // element: cls, name, storey, origin [x,y,z rel storey], axis (extrusion
    // world dir), ref (local x), profile {rect:[xd,yd]}|{circ:r}, depth, psets
    function el(cls, nm, st, o, axis, ref, prof, depth, props, predef) {
      const pt = P(...o);
      const ax = A3(pt, axis ? D(...axis) : null, ref ? D(...ref) : null);
      const pl = n(); L.push(`#${pl}=IFCLOCALPLACEMENT(#${st.pl},#${ax});`);
      const pr = n();
      if (prof.rect) L.push(`#${pr}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#${A2},${prof.rect[0]},${prof.rect[1]});`);
      else L.push(`#${pr}=IFCCIRCLEPROFILEDEF(.AREA.,$,#${A2},${prof.circ});`);
      const sp = A3(ORIG);
      const so = n(); L.push(`#${so}=IFCEXTRUDEDAREASOLID(#${pr},#${sp},#${EXT},${depth});`);
      const rep = n(); L.push(`#${rep}=IFCSHAPEREPRESENTATION(#${CTX},'Body','SweptSolid',(#${so}));`);
      const pds = n(); L.push(`#${pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}));`);
      const e = n();
      const extra = (cls === 'IFCWALL' || cls === 'IFCSLAB' || cls === 'IFCCOLUMN' || cls === 'IFCBEAM'
        || cls === 'IFCDUCTSEGMENT' || cls === 'IFCPIPESEGMENT' || cls === 'IFCFLOWTERMINAL') ? `,${predef || '$'}` : '';
      L.push(`#${e}=${cls}('${g()}',$,'${nm}',$,$,#${pl},#${pds},$${extra});`);
      st.els.push(e);
      if (props) {
        const ps = Object.entries(props).map(([k, v]) => {
          const i = n();
          const val = typeof v === 'boolean' ? `IFCBOOLEAN(.${v ? 'T' : 'F'}.)` : typeof v === 'number' ? `IFCREAL(${v})` : `IFCLABEL('${v}')`;
          L.push(`#${i}=IFCPROPERTYSINGLEVALUE('${k}',$,${val},$);`);
          return i;
        });
        const psetName = (cls === 'IFCDUCTSEGMENT' || cls === 'IFCPIPESEGMENT') ? 'Pset_Common_MEP' : 'Pset_' + cls.slice(3, 4) + cls.slice(4).toLowerCase() + 'Common';
        const pset = n(); L.push(`#${pset}=IFCPROPERTYSET('${g()}',$,'${psetName}',$,(${ps.map((i) => '#' + i).join(',')}));`);
        L.push(`#${n()}=IFCRELDEFINESBYPROPERTIES('${g()}',$,$,$,(#${e}),#${pset});`);
      }
    }
    build(storeys, el);
    storeys.forEach((s) => { if (s.els.length) L.push(`#${n()}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${g()}',$,$,$,(${s.els.map((e) => '#' + e).join(',')}),#${s.id});`); });
    return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');\nFILE_NAME('${name}','2026-09-28T00:00:00',('Test'),('Test'),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${L.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
  }

  const alongX = [[1, 0, 0], [0, 1, 0]];
  const alongY = [[0, 1, 0], [-1, 0, 0]];

  const architecture = mkIfc('Architecture.ifc', (st, el) => {
    st.forEach((s, k) => {
      el('IFCSLAB', `Floor slab L${k}`, s, [10, 6, -0.25], null, null, { rect: [20.4, 12.4] }, 0.25, { IsExternal: false, LoadBearing: true, FireRating: 'REI 90' }, '.FLOOR.');
      el('IFCWALL', `Facade South L${k}`, s, [10, 0, 0], null, null, { rect: [20, 0.3] }, 3.2, { IsExternal: true, LoadBearing: false, FireRating: 'EI 60' }, '.STANDARD.');
      el('IFCWALL', `Facade North L${k}`, s, [10, 12, 0], null, null, { rect: [20, 0.3] }, 3.2, { IsExternal: true, LoadBearing: false }, '.STANDARD.');
      el('IFCWALL', `Facade West L${k}`, s, [0, 6, 0], null, null, { rect: [0.3, 12] }, 3.2, { IsExternal: true }, '.STANDARD.');
      el('IFCWALL', `Facade East L${k}`, s, [20, 6, 0], null, null, { rect: [0.3, 12] }, 3.2, { IsExternal: true }, '.STANDARD.');
      el('IFCWALL', `Corridor wall L${k}`, s, [10, 6, 0], null, null, { rect: [0.15, 11.7] }, 3.2, { IsExternal: false, FireRating: 'EI 30' }, '.PARTITIONING.');
      for (const x of [5, 15]) for (const y of [3, 9]) el('IFCCOLUMN', `Column ${x}/${y} L${k}`, s, [x, y, 0], null, null, { rect: [0.4, 0.4] }, 3.25, { LoadBearing: true }, '.COLUMN.');
      el('IFCBEAM', `Beam grid 3 L${k}`, s, [0, 3, 2.95], ...alongX, { rect: [0.3, 0.5] }, 20, { LoadBearing: true }, '.BEAM.');
    });
  });

  const mep = mkIfc('MEP.ifc', (st, el) => {
    st.forEach((s, k) => {
      el('IFCDUCTSEGMENT', `Supply duct L${k}`, s, [-1, 6.5, 2.7], ...alongX, { rect: [0.8, 0.4] }, 22, { Size: '800x400', System: 'Supply air' }, '.RIGIDSEGMENT.');
      el('IFCDUCTSEGMENT', `Return duct L${k}`, s, [-1, 3.2, 2.7], ...alongX, { rect: [0.5, 0.3] }, 22, { Size: '500x300', System: 'Return air' }, '.RIGIDSEGMENT.');
      el('IFCPIPESEGMENT', `Sprinkler main L${k}`, s, [5, -1, 3.0], ...alongY, { circ: 0.05 }, 14, { Size: 'DN100', System: 'Sprinkler' }, '.RIGIDSEGMENT.');
      el('IFCPIPESEGMENT', `Cable tray-ish pipe L${k}`, s, [12, -1, 2.2], ...alongY, { circ: 0.03 }, 14, { Size: 'DN60', System: 'Drainage' }, '.RIGIDSEGMENT.');
      if (k === 0) el('IFCPIPESEGMENT', `Riser R1`, s, [14.8, 8.9, -0.5], null, null, { circ: 0.08 }, 11, { Size: 'DN150', System: 'Rainwater' }, '.RIGIDSEGMENT.');
      // A small sensor "device" box resting under its own storey's floor
      // slab (local z=-0.25..0) with exactly 0.1m of clearance below the
      // slab's underside, centered under the slab's face rather than near
      // any of its 4 corner vertices — the min-distance clearance/soft-clash
      // regression case (see index.html's _meshMinDist doc comment / the
      // task this fixture was added for): no vertex of the device is near
      // a vertex of the slab, so only a true point-to-triangle mesh
      // distance measures this correctly. Device spans local z
      // [-0.55,-0.35]; slab underside is at local z=-0.25 -> 0.1m gap.
      el('IFCFLOWTERMINAL', `Sensor device L${k}`, s, [10, 6, -0.55], null, null, { rect: [0.2, 0.2] }, 0.2, { System: 'BMS sensor' }, null);
    });
  });

  return { architecture, mep };
}

module.exports = { generate, mulberry32 };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const outDir = process.argv[2] || __dirname;
  const nlev = process.env.NLEV ? +process.env.NLEV : 3;
  const seed = process.env.SEED ? +process.env.SEED : 1337;
  const { architecture, mep } = generate({ nlev, seed });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'office-architecture.ifc'), architecture);
  fs.writeFileSync(path.join(outDir, 'office-mep.ifc'), mep);
  console.log('wrote office-architecture.ifc (' + architecture.length + ' bytes) and office-mep.ifc (' + mep.length + ' bytes) to ' + outDir);
}
