'use strict';
// Seeded generator of a FEDERATED building as three IFC4 SPF models —
// architecture, structure, MEP — for clash-ACCURACY testing, plus a
// ground-truth manifest of planted clash cases.
//
//   node tests/fixtures/generate-building-ifc.js [outDir] [--scale ci|medium|large|SxBXxBY] [--seed N] [--georef none|local|far]
//   (env: CC_GEN_SCALE, CC_GEN_SEED, CC_GEN_GEOREF)
// writes building-architecture.ifc, building-structure.ifc, building-mep.ifc
// and building-manifest.json to outDir (default: <os.tmpdir()>/cc-building-gen).
// Generated files are NOT committed — tests generate them at run time.
//
// Design notes
// * Deterministic: one mulberry32 stream per concern (GUIDs, layout), so the
//   same options always produce byte-identical files.
// * No repeated geometry by construction: every element's representation gets
//   a unique small dimensional offset (uniq(): an injective map of an element
//   counter onto 0.1 mm / 1 µm steps), so
//   web-ifc geometry dedup / app instancing cannot collapse it. The actual
//   share of repeated representation signatures is computed and reported
//   (stats.repeatedGeometryShare).
// * Background building (truth computed by the exact oracle on the app's own
//   triangles): walls (straight, angled, curved), slabs, coverings, doors and
//   windows in IfcOpeningElement voids (IfcRelVoidsElement +
//   IfcRelFillsElement), stairs, spaces; columns (rect/circle), beams
//   (I-shape/rect), sloped bracing, slabs, footings, piles; ducts, pipes
//   (incl. sloped drainage), cable trays, risers, fittings, terminals.
//   Representations: IfcExtrudedAreaSolid (rectangle / circle / I-shape /
//   arbitrary closed profiles), IfcTriangulatedFaceSet, IfcPolygonalFaceSet,
//   IfcFacetedBrep; rotated and nested local placements; psets + quantities.
// * Planted cases sit in a test strip east of the building, 4 m apart, each a
//   cross-model pair with discipline-identifying IFC types. Flush contacts use
//   dyadic coordinates so they stay exact in Float32 world coordinates.
// * georef: 'none' | 'local' (site at origin + IfcMapConversion) | 'far'
//   (site placed ~100 km from the origin + IfcMapConversion): the far variant
//   is the Float32 world-coordinate stress case.

const fs = require('fs');
const os = require('os');
const path = require('path');

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCALES = {
  ci: { storeys: 2, baysX: 3, baysY: 2 },
  medium: { storeys: 6, baysX: 6, baysY: 4 },
  large: { storeys: 20, baysX: 10, baysY: 8 },
  xlarge: { storeys: 24, baysX: 12, baysY: 10 },
};
function parseScale(s) {
  if (!s) return SCALES.ci;
  if (typeof s === 'object') return s;
  if (SCALES[s]) return SCALES[s];
  const m = /^(\d+)x(\d+)x(\d+)$/i.exec(String(s));
  if (m) return { storeys: +m[1], baysX: +m[2], baysY: +m[3] };
  throw new Error('unknown scale ' + s);
}

// Real-number formatting for SPF: micrometre resolution, always a decimal point.
function R(v) {
  if (!Number.isFinite(v)) throw new Error('non-finite coordinate');
  let s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, '');
  if (s === '-0.') s = '0.';
  return s;
}

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

class Model {
  constructor(name, file, gRnd, ctx) {
    this.name = name; this.file = file; this.gRnd = gRnd; this.ctx = ctx;
    this.id = 0; this.L = [];
    this.storeyEls = new Map(); // storey id -> [element ids]
    this.typeCounts = {};       // IFC class -> products with a representation
    this.products = [];         // {id, guid, cls, name}
    this.sigs = new Map();      // representation signature -> count
  }
  guid() {
    let s = GUID_CHARS[Math.floor(this.gRnd() * 4)];
    for (let i = 1; i < 22; i++) s += GUID_CHARS[Math.floor(this.gRnd() * 64)];
    if (this.ctx.guids.has(s)) return this.guid();
    this.ctx.guids.add(s);
    return s;
  }
  add(s) { const i = ++this.id; this.L.push(`#${i}=${s};`); return i; }
  pt(x, y, z) { return this.add(`IFCCARTESIANPOINT((${R(x)},${R(y)},${R(z)}))`); }
  pt2(x, y) { return this.add(`IFCCARTESIANPOINT((${R(x)},${R(y)}))`); }
  dir(x, y, z) { return this.add(`IFCDIRECTION((${R(x)},${R(y)},${R(z)}))`); }
  ax3(o, z, x) { return this.add(`IFCAXIS2PLACEMENT3D(#${this.pt(...o)},${z ? '#' + this.dir(...z) : '$'},${x ? '#' + this.dir(...x) : '$'})`); }
  lp(rel, ax) { return this.add(`IFCLOCALPLACEMENT(${rel ? '#' + rel : '$'},#${ax})`); }
  // ── profiles / solids ──
  prof2d() { return this.add(`IFCAXIS2PLACEMENT2D(#${this.pt2(0, 0)},$)`); }
  rect(xd, yd) { return this.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${this.prof2d()},${R(xd)},${R(yd)})`); }
  circ(r) { return this.add(`IFCCIRCLEPROFILEDEF(.AREA.,$,#${this.prof2d()},${R(r)})`); }
  ishape(w, d, tw, tf) { return this.add(`IFCISHAPEPROFILEDEF(.AREA.,$,#${this.prof2d()},${R(w)},${R(d)},${R(tw)},${R(tf)},$,$,$)`); }
  poly(pts) {
    const ids = pts.map(([x, y]) => this.pt2(x, y));
    const pl = this.add(`IFCPOLYLINE((${[...ids, ids[0]].map((i) => '#' + i).join(',')}))`);
    return this.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${pl})`);
  }
  extrude(prof, depth, pos) {
    const p = this.ax3(pos || [0, 0, 0]);
    return this.add(`IFCEXTRUDEDAREASOLID(#${prof},#${p},#${this.dir(0, 0, 1)},${R(depth)})`);
  }
  ptList(V) { return this.add(`IFCCARTESIANPOINTLIST3D((${V.map((v) => '(' + v.map(R).join(',') + ')').join(',')}))`); }
  triSet(V, T) { return this.add(`IFCTRIANGULATEDFACESET(#${this.ptList(V)},$,.T.,(${T.map((t) => '(' + t.map((i) => i + 1).join(',') + ')').join(',')}),$)`); }
  polySet(V, F) {
    const pl = this.ptList(V);
    const fs2 = F.map((f) => this.add(`IFCINDEXEDPOLYGONALFACE((${f.map((i) => i + 1).join(',')}))`));
    return this.add(`IFCPOLYGONALFACESET(#${pl},.T.,(${fs2.map((i) => '#' + i).join(',')}),$)`);
  }
  brep(V, F) {
    const P = V.map((v) => this.pt(...v));
    const faces = F.map((f) => {
      const loop = this.add(`IFCPOLYLOOP((${f.map((i) => '#' + P[i]).join(',')}))`);
      const b = this.add(`IFCFACEOUTERBOUND(#${loop},.T.)`);
      return this.add(`IFCFACE((#${b}))`);
    });
    const sh = this.add(`IFCCLOSEDSHELL((${faces.map((i) => '#' + i).join(',')}))`);
    return this.add(`IFCFACETEDBREP(#${sh})`);
  }
  shape(items, type) {
    const rep = this.add(`IFCSHAPEREPRESENTATION(#${this.ctxId},'Body','${type}',(${items.map((i) => '#' + i).join(',')}))`);
    return this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  }
}

// IFC4 attribute tails after Representation (Tag + class-specific)
const TAILS = {
  IFCWALL: (o) => `$,${o.pre || '.STANDARD.'}`, IFCSLAB: (o) => `$,${o.pre || '.FLOOR.'}`,
  IFCCOLUMN: () => '$,.COLUMN.', IFCBEAM: () => '$,.BEAM.', IFCMEMBER: (o) => `$,${o.pre || '.BRACE.'}`, IFCPLATE: () => '$,.SHEET.',
  IFCFOOTING: () => '$,.PAD_FOOTING.', IFCPILE: () => '$,.DRIVEN.,$', IFCCOVERING: (o) => `$,${o.pre || '.FLOORING.'}`,
  IFCDOOR: (o) => `$,${R(o.h)},${R(o.w)},.DOOR.,.SINGLE_SWING_LEFT.,$`,
  IFCWINDOW: (o) => `$,${R(o.h)},${R(o.w)},.WINDOW.,.SINGLE_PANEL.,$`,
  IFCSTAIR: () => '$,.STRAIGHT_RUN_STAIR.', IFCSTAIRFLIGHT: (o) => `$,${o.n},${o.n - 1},${R(o.rh)},${R(o.tl)},.STRAIGHT.`,
  IFCOPENINGELEMENT: () => '$,.OPENING.', IFCSPACE: (o) => `'${o.longName || 'Room'}',.ELEMENT.,.INTERNAL.,$`,
  IFCDUCTSEGMENT: () => '$,.RIGIDSEGMENT.', IFCPIPESEGMENT: () => '$,.RIGIDSEGMENT.', IFCCABLECARRIERSEGMENT: () => '$,.CABLETRAYSEGMENT.',
  IFCDUCTFITTING: (o) => `$,${o.pre || '.BEND.'}`, IFCPIPEFITTING: (o) => `$,${o.pre || '.BEND.'}`, IFCCABLECARRIERFITTING: () => '$,.BEND.',
  IFCAIRTERMINAL: () => '$,.DIFFUSER.', IFCFLOWTERMINAL: () => '$',
};
const PSET_NAME = {
  IFCWALL: 'Pset_WallCommon', IFCSLAB: 'Pset_SlabCommon', IFCCOLUMN: 'Pset_ColumnCommon', IFCBEAM: 'Pset_BeamCommon', IFCMEMBER: 'Pset_MemberCommon',
  IFCPLATE: 'Pset_PlateCommon', IFCFOOTING: 'Pset_FootingCommon', IFCPILE: 'Pset_PileCommon', IFCCOVERING: 'Pset_CoveringCommon', IFCDOOR: 'Pset_DoorCommon',
  IFCWINDOW: 'Pset_WindowCommon', IFCSTAIR: 'Pset_StairCommon', IFCSTAIRFLIGHT: 'Pset_StairFlightCommon', IFCSPACE: 'Pset_SpaceCommon',
  IFCDUCTSEGMENT: 'Pset_DuctSegmentTypeCommon', IFCPIPESEGMENT: 'Pset_PipeSegmentTypeCommon', IFCCABLECARRIERSEGMENT: 'Pset_CableCarrierSegmentTypeCommon',
  IFCDUCTFITTING: 'Pset_DuctFittingTypeCommon', IFCPIPEFITTING: 'Pset_PipeFittingTypeCommon', IFCCABLECARRIERFITTING: 'Pset_CableCarrierFittingTypeCommon',
  IFCAIRTERMINAL: 'Pset_AirTerminalTypeCommon', IFCFLOWTERMINAL: 'Pset_FlowTerminalCommon',
};

function generateBuilding(opts) {
  opts = opts || {};
  const scale = parseScale(opts.scale);
  const seed = opts.seed != null ? opts.seed : 4242;
  const georef = opts.georef || 'local';
  const planted = opts.planted !== false;
  const lay = mulberry32(seed);
  const ctx = { guids: new Set() };
  let uniqCounter = 0;
  // Unique offsets in metres. a alone is unique per element (0.1..99.7 mm in
  // 0.1 mm steps, plus 1 µm per block of 997 elements); b adds 0.1 mm per block.
  const uniq = () => {
    const u = uniqCounter++, blk = Math.floor(u / 997);
    return [((u * 7919) % 997 + 1) * 1e-4 + blk * 1e-6, (blk + 1) * 1e-4];
  };
  const jit = (lo, hi, step) => lo + Math.round((lay() * (hi - lo)) / step) * step;

  // ── grid & levels ──
  const bx = [], by = [];
  for (let i = 0; i < scale.baysX; i++) bx.push(jit(6.0, 7.8, 0.05));
  for (let j = 0; j < scale.baysY; j++) by.push(jit(5.4, 7.2, 0.05));
  const gx = [0]; bx.forEach((w) => gx.push(gx[gx.length - 1] + w));
  const gy = [0]; by.forEach((w) => gy.push(gy[gy.length - 1] + w));
  const W = gx[gx.length - 1], D = gy[gy.length - 1];
  const levels = [0];
  for (let k = 0; k < scale.storeys; k++) levels.push(levels[k] + jit(3.4, 3.9, 0.01));
  const SLAB_T = 0.25;
  const siteOffset = georef === 'far' ? [100000, 0, 0] : [0, 0, 0];

  const models = {};
  function mkModel(key, name, file, seedXor) {
    const m = new Model(name, file, mulberry32((seed ^ seedXor) >>> 0), ctx);
    const ORIG = m.ax3([0, 0, 0]);
    m.ctxId = m.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#${ORIG},$)`);
    const U = m.add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
    const UA = m.add(`IFCUNITASSIGNMENT((#${U}))`);
    m.project = m.add(`IFCPROJECT('${m.guid()}',$,'${name}',$,$,$,$,(#${m.ctxId}),#${UA})`);
    if (georef !== 'none') {
      const crs = m.add(`IFCPROJECTEDCRS('EPSG:28992','Amersfoort / RD New',$,$,$,$,#${U})`);
      m.add(`IFCMAPCONVERSION(#${m.ctxId},#${crs},155000.,463000.,0.,0.996194698,0.087155743,1.)`);
    }
    m.sitePl = m.lp(null, m.ax3(siteOffset));
    const site = m.add(`IFCSITE('${m.guid()}',$,'Site',$,$,#${m.sitePl},$,$,.ELEMENT.,(52,22,1,0),(4,53,2,0),0.,$,$)`);
    m.bldPl = m.lp(m.sitePl, m.ax3([0, 0, 0]));
    const bld = m.add(`IFCBUILDING('${m.guid()}',$,'Accuracy Tower',$,$,#${m.bldPl},$,$,.ELEMENT.,$,$,$)`);
    m.add(`IFCRELAGGREGATES('${m.guid()}',$,$,$,#${m.project},(#${site}))`);
    m.add(`IFCRELAGGREGATES('${m.guid()}',$,$,$,#${site},(#${bld}))`);
    m.storeys = levels.slice(0, scale.storeys).map((z, k) => {
      const pl = m.lp(m.bldPl, m.ax3([0, 0, z]));
      const s = m.add(`IFCBUILDINGSTOREY('${m.guid()}',$,'Level ${k}',$,$,#${pl},$,$,.ELEMENT.,${R(z)})`);
      m.storeyEls.set(s, []);
      return { id: s, pl, z, k, spaces: [] };
    });
    m.add(`IFCRELAGGREGATES('${m.guid()}',$,$,$,#${bld},(${m.storeys.map((s) => '#' + s.id).join(',')}))`);
    models[key] = m;
    return m;
  }
  const A = mkModel('architecture', 'Architecture', 'building-architecture.ifc', 0x1111);
  const S = mkModel('structure', 'Structure', 'building-structure.ifc', 0x2222);
  const M = mkModel('mep', 'MEP', 'building-mep.ifc', 0x3333);

  // Generic element: placement (relative to `rel` placement id), items, rep type.
  function element(m, cls, name, st, relPl, ax, items, repType, o) {
    o = o || {};
    const pl = m.lp(relPl, ax);
    const pds = items ? m.shape(items, repType) : null;
    const guid = m.guid();
    const nm = name.replace(/'/g, '');
    let attrs;
    if (cls === 'IFCSPACE') attrs = `'${guid}',$,'${nm}',$,$,#${pl},${pds ? '#' + pds : '$'},${TAILS[cls](o)}`;
    else attrs = `'${guid}',$,'${nm}',$,${o.objectType ? `'${o.objectType}'` : '$'},#${pl},${pds ? '#' + pds : '$'},${TAILS[cls](o)}`;
    const e = m.add(`${cls}(${attrs})`);
    if (cls !== 'IFCOPENINGELEMENT') {
      if (cls === 'IFCSPACE') st.spaces.push(e);
      else if (!o.noContain) m.storeyEls.get(st.id).push(e);
    }
    if (pds) {
      m.typeCounts[cls] = (m.typeCounts[cls] || 0) + 1;
      m.products.push({ id: e, guid, cls, name: nm, pl });
      const sig = cls + '|' + (o.sig || '');
      m.sigs.set(sig, (m.sigs.get(sig) || 0) + 1);
    }
    if (o.props && PSET_NAME[cls]) {
      const ps = Object.entries(o.props).map(([k, v]) => m.add(`IFCPROPERTYSINGLEVALUE('${k}',$,${typeof v === 'boolean' ? `IFCBOOLEAN(.${v ? 'T' : 'F'}.)` : typeof v === 'number' ? `IFCREAL(${R(v)})` : `IFCLABEL('${v}')`},$)`));
      const pset = m.add(`IFCPROPERTYSET('${m.guid()}',$,'${PSET_NAME[cls]}',$,(${ps.map((i) => '#' + i).join(',')}))`);
      m.add(`IFCRELDEFINESBYPROPERTIES('${m.guid()}',$,$,$,(#${e}),#${pset})`);
    }
    if (o.qto) {
      const q = Object.entries(o.qto).map(([k, v]) => {
        const kind = /Area/.test(k) ? 'IFCQUANTITYAREA' : /Volume/.test(k) ? 'IFCQUANTITYVOLUME' : 'IFCQUANTITYLENGTH';
        return m.add(`${kind}('${k}',$,$,${R(v)},$)`);
      });
      const eq = m.add(`IFCELEMENTQUANTITY('${m.guid()}',$,'BaseQuantities',$,$,(${q.map((i) => '#' + i).join(',')}))`);
      m.add(`IFCRELDEFINESBYPROPERTIES('${m.guid()}',$,$,$,(#${e}),#${eq})`);
    }
    return { id: e, guid, pl, cls, name: nm };
  }
  const X = [[1, 0, 0], [0, 1, 0]];   // extrude along +X; profile x->Y, y->Z
  const Y = [[0, 1, 0], [-1, 0, 0]];  // extrude along +Y; profile x->-X, y->Z
  const sigOf = (...v) => v.map((x) => (typeof x === 'number' ? R(x) : String(x))).join(',');
  // Box element from world-ish min/max (relative to a storey), extruded vertically.
  function vbox(m, cls, name, st, x0, x1, y0, y1, z0, z1, o) {
    return element(m, cls, name, st, st.pl, m.ax3([(x0 + x1) / 2, (y0 + y1) / 2, z0]), [m.extrude(m.rect(x1 - x0, y1 - y0), z1 - z0)], 'SweptSolid',
      Object.assign({ sig: sigOf('rect', x1 - x0, y1 - y0, z1 - z0) }, o));
  }
  // Horizontal rectangular run along X or Y: start point (x,y,zc), length, cross-section w (horizontal) x h (vertical)
  function hrun(m, cls, name, st, along, x, y, zc, len, w, h, o) {
    const [ax, ref] = along === 'x' ? X : Y;
    return element(m, cls, name, st, st.pl, m.ax3([x, y, zc], ax, ref), [m.extrude(m.rect(w, h), len)], 'SweptSolid',
      Object.assign({ sig: sigOf('rect', w, h, len) }, o));
  }
  function hcirc(m, cls, name, st, along, x, y, zc, len, r, o) {
    const [ax, ref] = along === 'x' ? X : Y;
    return element(m, cls, name, st, st.pl, m.ax3([x, y, zc], ax, ref), [m.extrude(m.circ(r), len)], 'SweptSolid',
      Object.assign({ sig: sigOf('circ', r, len) }, o));
  }
  function opening(m, host, st, relPl, ax, prof, depth, name, sig) {
    const op = element(m, 'IFCOPENINGELEMENT', name, st, relPl, ax, [m.extrude(prof, depth)], 'SweptSolid', { sig, noContain: true });
    m.add(`IFCRELVOIDSELEMENT('${m.guid()}',$,$,$,#${host.id},#${op.id})`);
    return op;
  }
  function fills(m, op, el) { m.add(`IFCRELFILLSELEMENT('${m.guid()}',$,$,$,#${op.id},#${el.id})`); }

  // ═════ Background building ═════
  const nX = scale.baysX, nY = scale.baysY;
  const corridorX = gx[Math.floor(nX / 2)];
  A.storeys.forEach((st, k) => {
    const h = levels[k + 1] - levels[k];
    const wallH = h - SLAB_T;
    // exterior walls per bay segment (200..240 mm), with windows
    const ext = [];
    for (let i = 0; i < nX; i++) for (const [y, side] of [[0, 'S'], [D, 'N']]) {
      const [u1, u2] = uniq();
      const t = 0.24 + u2;
      const len = bx[i] - 0.05 - u1;
      const w = hrun(A, 'IFCWALL', `Facade ${side} bay ${i} L${k}`, st, 'x', gx[i] + 0.025, y, wallH / 2, len, t, wallH,
        { props: { IsExternal: true, LoadBearing: false, FireRating: 'EI 60' }, qto: { Length: len, Height: wallH, Width: t, NetVolume: len * t * wallH } });
      ext.push({ w, x: gx[i] + 0.025, y, len, t, along: 'x' });
    }
    for (let j = 0; j < nY; j++) for (const [x, side] of [[0, 'W'], [W, 'E']]) {
      const [u1, u2] = uniq();
      const t = 0.24 + u2;
      const len = by[j] - 0.05 - u1;
      const w = hrun(A, 'IFCWALL', `Facade ${side} bay ${j} L${k}`, st, 'y', x, gy[j] + 0.025, wallH / 2, len, t, wallH,
        { props: { IsExternal: true, LoadBearing: false }, qto: { Length: len, Height: wallH, Width: t } });
      ext.push({ w, x, y: gy[j] + 0.025, len, t, along: 'y' });
    }
    // windows: one per exterior segment, opening placed relative to the wall's own placement (nested)
    ext.forEach((e, n) => {
      const [u1] = uniq();
      const ww = 1.2 + u1, wh = 1.4 + u1 / 2;
      // Wall-local frame (hrun): X = thickness, Y = up (origin at mid-height), Z = run.
      // Opening extrudes through the thickness: Z' = wall X, X' = wall Z (run), Y' = -wall Y.
      const op = opening(A, e.w, st, e.w.pl, A.ax3([-e.t / 2 - 0.3, 0.9 + wh / 2 - wallH / 2, e.len / 2], [1, 0, 0], [0, 0, 1]), A.rect(ww, wh), e.t + 0.6, `Window opening ${n} L${k}`, sigOf('wop', ww, wh, e.t));
      // window panel: polygonal face set box inside the opening, 10 mm smaller all round, 60 mm thick
      const hx = ww / 2 - 0.01, hz = wh / 2 - 0.01, t2 = 0.03;
      const V = [[-hx, -hz, -t2], [hx, -hz, -t2], [hx, hz, -t2], [-hx, hz, -t2], [-hx, -hz, t2], [hx, -hz, t2], [hx, hz, t2], [-hx, hz, t2]];
      const F = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      const win = element(A, 'IFCWINDOW', `Window ${n} L${k}`, st, op.pl, A.ax3([0, 0, 0.3 + e.t / 2]), [A.polySet(V, F)], 'Tessellation',
        { h: wh, w: ww, sig: sigOf('win', ww, wh), props: { IsExternal: true } });
      fills(A, op, win);
    });
    // interior partitions along Y at bay lines (skipping the facades), some angled
    for (let i = 1; i < nX; i++) for (let j = 0; j < nY; j++) {
      const [u1, u2] = uniq();
      const t = 0.1 + u2, len = by[j] - 0.4 - u1;
      const angled = (i + j + k) % 3 === 0;
      const x = gx[i] + 0.35, y = gy[j] + 0.2;
      let w;
      if (angled) {
        const a = (8 + ((i * 7 + j * 3 + k) % 9)) * Math.PI / 180;
        w = element(A, 'IFCWALL', `Partition ${i}/${j} angled L${k}`, st, st.pl, A.ax3([x, y, wallH / 2], [Math.sin(a), Math.cos(a), 0], [-Math.cos(a), Math.sin(a), 0]),
          [A.extrude(A.rect(t, wallH), len)], 'SweptSolid', { pre: '.PARTITIONING.', sig: sigOf('pw', t, wallH, len), props: { IsExternal: false, FireRating: 'EI 30' } });
      } else {
        w = hrun(A, 'IFCWALL', `Partition ${i}/${j} L${k}`, st, 'y', x, y, wallH / 2, len, t, wallH, { pre: '.PARTITIONING.', props: { IsExternal: false } });
      }
      // door in each partition (opening nested in the wall placement)
      const [d1] = uniq();
      const dw = 0.9 + d1, dh = 2.1 + d1 / 2;
      const op = opening(A, w, st, w.pl, A.ax3([-t / 2 - 0.2, dh / 2 - wallH / 2, len / 2], [1, 0, 0], [0, 0, 1]), A.rect(dw, dh), t + 0.4, `Door opening ${i}/${j} L${k}`, sigOf('dop', dw, dh, t));
      const door = element(A, 'IFCDOOR', `Door ${i}/${j} L${k}`, st, op.pl, A.ax3([0, 0, 0.2 + t / 2]),
        [A.extrude(A.rect(dw - 0.02, dh - 0.02), 0.04, [0, 0, -0.02])], 'SweptSolid', { h: dh, w: dw, sig: sigOf('door', dw, dh), props: { FireRating: 'EI 30' } });
      fills(A, op, door);
    }
    // curved wall: annular sector polyline profile, extruded vertically
    {
      const [u1, u2] = uniq();
      const cx = gx[1] * 0.5, cy = gy[1] * 0.5, r0 = 1.6 + u1, r1 = r0 + 0.15 + u2, n = 14, a0 = 0.2, a1 = 2.4;
      const pts = [];
      for (let s = 0; s <= n; s++) { const a = a0 + (a1 - a0) * s / n; pts.push([r1 * Math.cos(a), r1 * Math.sin(a)]); }
      for (let s = n; s >= 0; s--) { const a = a0 + (a1 - a0) * s / n; pts.push([r0 * Math.cos(a), r0 * Math.sin(a)]); }
      element(A, 'IFCWALL', `Curved lobby wall L${k}`, st, st.pl, A.ax3([cx, cy, 0]), [A.extrude(A.poly(pts), wallH)], 'SweptSolid',
        { sig: sigOf('curve', r0, r1), props: { IsExternal: false } });
    }
    // per bay: floor finish + ceiling coverings, a space
    for (let i = 0; i < nX; i++) for (let j = 0; j < nY; j++) {
      const [u1, u2] = uniq();
      const x0 = gx[i] + 0.3, x1 = gx[i + 1] - 0.3 - u1, y0 = gy[j] + 0.3, y1 = gy[j + 1] - 0.3 - u2;
      vbox(A, 'IFCCOVERING', `Floor finish ${i}/${j} L${k}`, st, x0, x1, y0, y1, 0, 0.04 + u2, { pre: '.FLOORING.', props: { Finish: 'screed' } });
      const [c1] = uniq();
      vbox(A, 'IFCCOVERING', `Ceiling ${i}/${j} L${k}`, st, x0 + 0.05, x1 - c1, y0 + 0.05, y1, wallH - 0.6, wallH - 0.585, { pre: '.CEILING.' });
      const [s1] = uniq();
      vbox(A, 'IFCSPACE', `${k}.${i}${j}`, st, x0 + 0.1, x1 - 0.1 - s1, y0 + 0.1, y1 - 0.1, 0.04, wallH - 0.6, { longName: `Office ${k}.${i}${j}`, props: { IsExternal: false } });
    }
    // stair: IfcStair container (no body) aggregating a sawtooth flight (arbitrary closed profile)
    {
      const [u1] = uniq();
      const n = 16, rh = h / n, tl = 0.27 + u1 / 10;
      const pts = [[0, 0]];
      for (let s = 0; s < n; s++) { pts.push([s * tl, (s + 1) * rh]); pts.push([(s + 1) * tl, (s + 1) * rh]); }
      pts.push([n * tl, (n - 1) * rh]); pts.push([tl, 0]);
      const stair = element(A, 'IFCSTAIR', `Stair L${k}`, st, st.pl, A.ax3([gx[nX] - 2.0, gy[0] + 0.6, 0]), null, null, {});
      const fl = element(A, 'IFCSTAIRFLIGHT', `Stair flight L${k}`, st, stair.pl, A.ax3([0, 0, 0], [0, 1, 0], [-1, 0, 0]),
        [A.extrude(A.poly(pts), 1.1)], 'SweptSolid', { n, rh, tl, noContain: true, sig: sigOf('stair', tl, rh) });
      A.add(`IFCRELAGGREGATES('${A.guid()}',$,$,$,#${stair.id},(#${fl.id}))`);
    }
  });

  S.storeys.forEach((st, k) => {
    const h = levels[k + 1] - levels[k];
    // slab at the top of the storey, per bay (arbitrary L-shaped profile in some bays)
    for (let i = 0; i < nX; i++) for (let j = 0; j < nY; j++) {
      const [u1, u2] = uniq();
      const x0 = gx[i], x1 = gx[i + 1] - u1, y0 = gy[j], y1 = gy[j + 1] - u2;
      if ((i + j) % 2 === 0) {
        vbox(S, 'IFCSLAB', `Slab ${i}/${j} L${k + 1}`, st, x0, x1, y0, y1, h - SLAB_T, h, { props: { LoadBearing: true }, qto: { GrossArea: (x1 - x0) * (y1 - y0), Depth: SLAB_T } });
      } else {
        const cw = 1.2 + u1;
        const pts = [[x0, y0], [x1, y0], [x1, y1 - cw], [x1 - cw, y1 - cw], [x1 - cw, y1], [x0, y1]];
        element(S, 'IFCSLAB', `Slab ${i}/${j} L${k + 1} (L-shape)`, st, st.pl, S.ax3([0, 0, h - SLAB_T]), [S.extrude(S.poly(pts), SLAB_T)], 'SweptSolid',
          { sig: sigOf('lslab', x1 - x0, y1 - y0, cw), props: { LoadBearing: true } });
      }
    }
    // columns at grid nodes: rect / circle alternating
    for (let i = 0; i <= nX; i++) for (let j = 0; j <= nY; j++) {
      const [u1, u2] = uniq();
      const H = h - SLAB_T - u2;
      const name = `Column ${i}/${j} L${k}`;
      if ((i + j) % 2 === 0) element(S, 'IFCCOLUMN', name, st, st.pl, S.ax3([gx[i], gy[j], 0]), [S.extrude(S.rect(0.4 + u1 / 10, 0.4), H)], 'SweptSolid', { sig: sigOf('col', 0.4 + u1 / 10, H), props: { LoadBearing: true } });
      else element(S, 'IFCCOLUMN', name, st, st.pl, S.ax3([gx[i], gy[j], 0]), [S.extrude(S.circ(0.22 + u1 / 10), H)], 'SweptSolid', { sig: sigOf('ccol', 0.22 + u1 / 10, H), props: { LoadBearing: true } });
    }
    // beams under the slab: I-shape along X, rect along Y
    for (let j = 0; j <= nY; j++) for (let i = 0; i < nX; i++) {
      const [u1, u2] = uniq();
      const d = 0.5 + u2, len = bx[i] - 0.4 - u1;
      element(S, 'IFCBEAM', `Beam X ${i}/${j} L${k}`, st, st.pl, S.ax3([gx[i] + 0.2, gy[j], h - SLAB_T - d / 2], ...X),
        [S.extrude(S.ishape(0.3, d, 0.012, 0.02), len)], 'SweptSolid', { sig: sigOf('ibeam', d, len), props: { LoadBearing: true }, qto: { Length: len } });
    }
    for (let i = 0; i <= nX; i++) for (let j = 0; j < nY; j++) {
      const [u1, u2] = uniq();
      const d = 0.45 + u2, len = by[j] - 0.4 - u1;
      hrun(S, 'IFCBEAM', `Beam Y ${i}/${j} L${k}`, st, 'y', gx[i], gy[j] + 0.2, h - SLAB_T - d / 2, len, 0.3, d, { props: { LoadBearing: true } });
    }
    // sloped bracing in the west facade bays (rotated placement, compound direction)
    for (let j = 0; j < nY; j++) {
      const [u1] = uniq();
      const dx = by[j] - 0.6, dz = h - SLAB_T - 0.6, len = Math.hypot(dx, dz) - u1;
      const a = Math.atan2(dz, dx);
      element(S, 'IFCMEMBER', `Brace W ${j} L${k}`, st, st.pl, S.ax3([0.5, gy[j] + 0.3, 0.3], [0, Math.cos(a), Math.sin(a)], [1, 0, 0]),
        [S.extrude(S.rect(0.15, 0.15 + u1 / 10), len)], 'SweptSolid', { sig: sigOf('brace', len), props: { LoadBearing: true } });
    }
    if (k === 0) {
      // pad footings + piles under ground columns
      for (let i = 0; i <= nX; i++) for (let j = 0; j <= nY; j++) {
        const [u1, u2] = uniq();
        vbox(S, 'IFCFOOTING', `Footing ${i}/${j}`, st, gx[i] - 0.8, gx[i] + 0.8 + u1, gy[j] - 0.8, gy[j] + 0.8, -0.8 - u2, -0.25, { props: { LoadBearing: true } });
        element(S, 'IFCPILE', `Pile ${i}/${j}`, st, st.pl, S.ax3([gx[i], gy[j], -12 - u1]), [S.extrude(S.circ(0.2), 11.2 - u2)], 'SweptSolid', { sig: sigOf('pile', u1, u2) });
      }
      // ground slab
      for (let i = 0; i < nX; i++) for (let j = 0; j < nY; j++) {
        const [u1] = uniq();
        vbox(S, 'IFCSLAB', `Ground slab ${i}/${j}`, st, gx[i], gx[i + 1] - u1, gy[j], gy[j + 1], -SLAB_T, 0, { pre: '.BASESLAB.' });
      }
    }
  });

  M.storeys.forEach((st, k) => {
    const h = levels[k + 1] - levels[k];
    const ductZ = h - SLAB_T - 0.75; // under the beams, partly crossing the deeper ones
    // main supply duct along Y at the corridor + cable tray beside it
    {
      const [u1, u2] = uniq();
      hrun(M, 'IFCDUCTSEGMENT', `Supply main L${k}`, st, 'y', corridorX + 1.0, 0.6, ductZ, D - 1.2 - u1, 0.8, 0.4 + u2, { props: { System: 'Supply air', Size: '800x400' } });
      const [t1] = uniq();
      const tw = 0.4, th = 0.1, wt = 0.002;
      const prof = M.poly([[-tw / 2, 0], [tw / 2, 0], [tw / 2, th], [tw / 2 - wt, th], [tw / 2 - wt, wt], [-tw / 2 + wt, wt], [-tw / 2 + wt, th], [-tw / 2, th]]);
      element(M, 'IFCCABLECARRIERSEGMENT', `Cable tray L${k}`, st, st.pl, M.ax3([corridorX - 0.9, 0.6, ductZ + 0.25], ...Y), [M.extrude(prof, D - 1.2 - t1)], 'SweptSolid',
        { sig: sigOf('tray', t1), props: { System: 'Power' } });
    }
    // branches along X per bay row + elbow fittings + terminals
    for (let j = 0; j < nY; j++) for (let i = 0; i < nX; i++) {
      if (gx[i] + 0.5 > corridorX + 0.6 && gx[i] < corridorX + 1.4) continue;
      const [u1, u2] = uniq();
      const y = (gy[j] + gy[j + 1]) / 2 + 0.7, len = bx[i] - 1.1 - u1;
      const br = hrun(M, 'IFCDUCTSEGMENT', `Branch ${i}/${j} L${k}`, st, 'x', gx[i] + 0.55, y, ductZ - 0.05, len, 0.4, 0.25 + u2, { props: { System: 'Supply air' } });
      // elbow: triangulated bent box at the branch end, nested in the branch placement
      const [f1] = uniq();
      const s = 0.2, e = 0.4 + f1;
      const V = [[-s, -0.125, 0], [s, -0.125, 0], [s, 0.125, 0], [-s, 0.125, 0], [-s, -0.125, e], [s, -0.125, e], [s + 0.1, 0.125, e], [-s + 0.1, 0.125, e]];
      const T = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
      element(M, 'IFCDUCTFITTING', `Elbow ${i}/${j} L${k}`, st, br.pl, M.ax3([0, 0, len]), [M.triSet(V, T)], 'Tessellation', { sig: sigOf('elbow', e), props: { System: 'Supply air' } });
      // diffuser: faceted brep frustum below the branch, nested placement
      const [a1] = uniq();
      const b = 0.3 + a1, tp = 0.15;
      const BV = [[-b, -b, 0], [b, -b, 0], [b, b, 0], [-b, b, 0], [-tp, -tp, 0.25], [tp, -tp, 0.25], [tp, tp, 0.25], [-tp, tp, 0.25]];
      const BF = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      element(M, 'IFCAIRTERMINAL', `Diffuser ${i}/${j} L${k}`, st, st.pl, M.ax3([gx[i] + 0.55 + len / 2, y, ductZ - 0.55]), [M.brep(BV, BF)], 'Brep', { sig: sigOf('diff', b), props: { System: 'Supply air' } });
    }
    // pipes along X at the south side: supply/return straight, drainage sloped 1 %
    for (const [n, name, r, z, slope] of [[0, 'Heating supply', 0.0425, ductZ + 0.35, 0], [1, 'Heating return', 0.0425, ductZ + 0.5, 0], [2, 'Drainage', 0.055, ductZ - 0.4, 0.01]]) {
      const [u1, u2] = uniq();
      const len = W - 1.2 - u1;
      const a = Math.atan(slope);
      const p = element(M, 'IFCPIPESEGMENT', `${name} L${k}`, st, st.pl, M.ax3([0.6, 1.2 + n * 0.35, z], [Math.cos(a), 0, -Math.sin(a)], [0, 1, 0]),
        [M.extrude(M.circ(r + u2 / 10), len)], 'SweptSolid', { sig: sigOf('pipe', r + u2 / 10, len), props: { System: name } });
      // tee fitting as a polygonal face set (octagonal prism block) mid-run, nested
      const [f1] = uniq();
      const q = r * 1.6 + f1 / 10, L2 = 0.18;
      const V = [], F = [[0, 1, 2, 3, 4, 5, 6, 7].reverse(), [8, 9, 10, 11, 12, 13, 14, 15]];
      for (const zz of [-L2, L2]) for (let s = 0; s < 8; s++) V.push([q * Math.cos(s * Math.PI / 4), q * Math.sin(s * Math.PI / 4), len / 2 + zz]);
      for (let s = 0; s < 8; s++) F.push([s, (s + 1) % 8, 8 + (s + 1) % 8, 8 + s]);
      element(M, 'IFCPIPEFITTING', `${name} tee L${k}`, st, p.pl, M.ax3([0, 0, 0]), [M.polySet(V, F)], 'Tessellation', { pre: '.JUNCTION.', sig: sigOf('tee', q), props: { System: name } });
    }
    // risers through the slab (vertical pipes) near the core + sanitary terminals
    for (let n = 0; n < 2; n++) {
      const [u1] = uniq();
      element(M, 'IFCPIPESEGMENT', `Riser ${n} L${k}`, st, st.pl, M.ax3([gx[nX] - 3.0 - n * 0.4, gy[nY] - 1.0, -0.1]), [M.extrude(M.circ(0.05 + u1 / 10), h)], 'SweptSolid',
        { sig: sigOf('riser', u1), props: { System: n ? 'Rainwater' : 'Domestic water' } });
    }
    for (let i = 0; i < nX; i++) {
      const [u1] = uniq();
      vbox(M, 'IFCFLOWTERMINAL', `Sanitary terminal ${i} L${k}`, st, gx[i] + 1.0, gx[i] + 1.5 + u1, gy[nY] - 0.75, gy[nY] - 0.35, 0.45, 0.85, { objectType: 'WashBasin' });
    }
  });

  // ═════ Planted cases (test strip east of the building) ═════
  const manifest = { generator: 'tests/fixtures/generate-building-ifc.js', seed, scale, georef, siteOffset, tolerance_m: 0.05, cases: [] };
  if (planted) {
    const st = { A: A.storeys[0], S: S.storeys[0], M: M.storeys[0] };
    const mdl = { A, S, M };
    const x00 = W + 12;
    let idx = 0;
    const ref = (key, el) => ({ model: mdl[key].file, globalId: el.guid, ifcType: el.cls, name: el.name });
    function plant(def) {
      const ox = x00 + 4 * idx++;
      const out = def(ox);
      manifest.cases.push(Object.assign({ id: 'P' + String(idx).padStart(2, '0') }, out, { a: ref(out.a[0], out.a[1]), b: ref(out.b[0], out.b[1]) }));
    }
    const vb = (key, cls, name, x0, x1, y0, y1, z0, z1, o) => [key, vbox(mdl[key], cls, name, st[key], x0, x1, y0, y1, z0, z1, o)];
    const hr = (key, cls, name, along, x, y, zc, len, w, hh, o) => [key, hrun(mdl[key], cls, name, st[key], along, x, y, zc, len, w, hh, o)];
    const tri = (key, cls, name, V, T, o) => [key, element(mdl[key], cls, name, st[key], st[key].pl, mdl[key].ax3([0, 0, 0]), [mdl[key].triSet(V, T)], 'Tessellation', Object.assign({ sig: sigOf('t', JSON.stringify(V)) }, o))];
    const BOXT = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
    const boxV = (x0, x1, y0, y1, z0, z1) => [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    // octagonal prism along an axis with a vertex exactly at the bottom (dyadic radius)
    const octPipe = (axis, x0, x1, cy, cz, r) => {
      const V = [], T = [];
      const ring = []; for (let s = 0; s < 8; s++) { const a = -Math.PI / 2 + s * Math.PI / 4; const c = [0, 2, 4, 6].includes(s) ? [0, 1, 0, -1][s / 2] : Math.cos(a), sn = [0, 2, 4, 6].includes(s) ? [-1, 0, 1, 0][s / 2] : Math.sin(a); ring.push([r * c, r * sn]); }
      for (const xx of [x0, x1]) for (const [u, v] of ring) V.push(axis === 'x' ? [xx, cy + u, cz + v] : [cy + u, xx, cz + v]);
      for (let s = 1; s < 7; s++) { T.push([0, s + 1, s]); T.push([8, 8 + s, 8 + s + 1]); }
      for (let s = 0; s < 8; s++) { const t2 = (s + 1) % 8; T.push([s, t2, 8 + t2]); T.push([s, 8 + t2, 8 + s]); }
      return { V, T };
    };
    plant((x) => ({ name: 'duct through wall without opening', category: 'crossing', mtdM: 0.6,
      a: hr('M', 'IFCDUCTSEGMENT', 'P duct through wall', 'x', x - 1, 1.0, 2.6, 3, 0.6, 0.4), b: vb('A', 'IFCWALL', 'P wall (no opening)', x + 0.4, x + 0.6, -0.5, 2.5, 0, 3.0) }));
    plant((x) => ({ name: 'beam through duct', category: 'crossing',
      a: [ 'S', element(S, 'IFCBEAM', 'P I-beam through duct', st.S, st.S.pl, S.ax3([x - 1, 1.0, 2.5], ...X), [S.extrude(S.ishape(0.2, 0.4, 0.01, 0.016), 3)], 'SweptSolid', { sig: 'p-ib' })],
      b: hr('M', 'IFCDUCTSEGMENT', 'P duct crossed by beam', 'y', x + 0.5, 0, 2.5, 2, 0.5, 0.3) }));
    plant((x) => ({ name: 'pipe through column', category: 'crossing',
      a: [ 'M', element(M, 'IFCPIPESEGMENT', 'P pipe through column', st.M, st.M.pl, M.ax3([x - 1, 1.0, 1.5], ...X), [M.extrude(M.circ(0.05), 2.5)], 'SweptSolid', { sig: 'p-pc' })],
      b: vb('S', 'IFCCOLUMN', 'P column pierced', x, x + 0.4, 0.8, 1.2, 0, 3) }));
    plant((x) => ({ name: 'wall on slab (flush face contact)', category: 'contact',
      a: vb('A', 'IFCWALL', 'P wall on slab', x, x + 2, 1, 1.25, 0, 3), b: vb('S', 'IFCSLAB', 'P slab under wall', x - 0.5, x + 2.5, 0, 2, -0.25, 0) }));
    plant((x) => { const o = octPipe('x', x - 0.5, x + 1.5, 1.0, 2.75 + 0.0625, 0.0625); return { name: 'pipe resting on beam (line contact)', category: 'contact',
      a: tri('M', 'IFCPIPESEGMENT', 'P pipe resting on beam', o.V, o.T), b: hr('S', 'IFCBEAM', 'P beam carrying pipe', 'y', x + 0.5, 0, 2.5, 2, 0.25, 0.5) }; });
    plant((x) => ({ name: 'edge touch (diamond member on covering)', category: 'contact',
      a: [ 'S', element(S, 'IFCMEMBER', 'P diamond member', st.S, st.S.pl, S.ax3([x, 1, 0.5], ...X), [S.extrude(S.poly([[0, -0.25], [0.25, 0], [0, 0.25], [-0.25, 0]]), 1.5)], 'SweptSolid', { sig: 'p-dia' })],
      b: vb('A', 'IFCCOVERING', 'P covering under edge', x - 0.5, x + 2, 0, 2, 0.125, 0.25) }));
    plant((x) => ({ name: 'vertex touch (terminal apex on slab)', category: 'contact',
      a: [ 'M', element(M, 'IFCFLOWTERMINAL', 'P pyramid terminal', st.M, st.M.pl, M.ax3([x + 1, 1, 0]), [M.brep([[0, 0, 0], [-0.25, -0.25, 0.5], [0.25, -0.25, 0.5], [0.25, 0.25, 0.5], [-0.25, 0.25, 0.5]], [[0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4], [1, 2, 3, 4]])], 'Brep', { sig: 'p-pyr' })],
      b: vb('S', 'IFCSLAB', 'P slab under apex', x, x + 2, 0, 2, -0.25, 0) }));
    for (const [gap, rel] of [[0.0499, 'below'], [0.05, 'at'], [0.0501, 'above']]) {
      plant((x) => ({ name: `clearance ${(gap * 1000).toFixed(1)} mm above beam`, category: 'clearance', distanceM: gap, toleranceRelation: rel,
        a: hr('M', 'IFCDUCTSEGMENT', `P duct ${(gap * 1000).toFixed(1)}mm over beam`, 'x', x - 0.5, 1, 2.75 + gap + 0.15, 2.5, 0.5, 0.3),
        b: hr('S', 'IFCBEAM', `P beam under duct ${(gap * 1000).toFixed(1)}mm`, 'y', x + 0.5, 0, 2.5, 2, 0.3, 0.5) }));
    }
    plant((x) => ({ name: 'pipe fully inside column', category: 'contained',
      a: [ 'M', element(M, 'IFCPIPESEGMENT', 'P pipe inside column', st.M, st.M.pl, M.ax3([x + 0.2, 1.0, 0.5]), [M.extrude(M.circ(0.05), 2)], 'SweptSolid', { sig: 'p-pin' })],
      b: vb('S', 'IFCCOLUMN', 'P column hosting pipe', x, x + 0.4, 0.8, 1.2, 0, 3) }));
    plant((x) => {
      const wall = vb('A', 'IFCWALL', 'P wall with provided opening', x + 0.4, x + 0.6, -0.5, 2.5, 0, 3.0);
      opening(A, wall[1], st.A, wall[1].pl, A.ax3([-0.5, 0, 2.6], [1, 0, 0], [0, 1, 0]), A.rect(0.86, 0.46), 1.0, 'P provided opening', 'p-op1');
      return { name: 'duct through provided opening (30 mm all round)', category: 'clearance', distanceM: 0.03, opening: 'provided',
        a: hr('M', 'IFCDUCTSEGMENT', 'P duct through opening', 'x', x - 1, 1.0, 2.6, 3, 0.8, 0.4), b: wall };
    });
    plant((x) => {
      const wall = vb('A', 'IFCWALL', 'P wall with undersized opening', x + 0.4, x + 0.6, -0.5, 2.5, 0, 3.0);
      opening(A, wall[1], st.A, wall[1].pl, A.ax3([-0.5, 0, 2.6], [1, 0, 0], [0, 1, 0]), A.rect(0.6, 0.3), 1.0, 'P undersized opening', 'p-op2');
      return { name: 'duct through undersized opening', category: 'crossing', opening: 'partial',
        a: hr('M', 'IFCDUCTSEGMENT', 'P duct through small opening', 'x', x - 1, 1.0, 2.6, 3, 0.8, 0.4), b: wall };
    });
    plant((x) => {
      const ax = [0.8, 0.35, 0.3], L = Math.hypot(...ax); const zx = ax.map((v) => v / L);
      const rx = [-zx[1], zx[0], 0]; const rl = Math.hypot(...rx);
      return { name: 'rotated/skewed member through duct', category: 'crossing',
        a: [ 'S', element(S, 'IFCMEMBER', 'P skewed strut', st.S, st.S.pl, S.ax3([x - 0.6, 0.6, 2.0], zx, rx.map((v) => v / rl)), [S.extrude(S.rect(0.12, 0.12), 2.2)], 'SweptSolid', { sig: 'p-skew' })],
        b: hr('M', 'IFCDUCTSEGMENT', 'P duct hit by strut', 'y', x + 0.5, 0, 2.5, 2.2, 0.6, 0.5) };
    });
    plant((x) => ({ name: 'thin 3 mm plate through floor covering', category: 'crossing',
      a: vb('S', 'IFCPLATE', 'P 3mm plate', x + 1, x + 1.003, 0.5, 0.9, -0.4, 0.6), b: vb('A', 'IFCCOVERING', 'P big covering', x - 1, x + 3, -1, 3, 0, 0.1) }));
    plant((x) => ({ name: 'hanger rod 6 mm through slab (AABB overlap < 1e-5 m3)', category: 'crossing',
      a: vb('M', 'IFCPIPESEGMENT', 'P hanger rod', x + 1, x + 1.006, 1, 1.006, -0.6, 0.4), b: vb('S', 'IFCSLAB', 'P slab pierced by rod', x - 1, x + 3, -1, 3, -0.25, 0) }));
    plant((x) => ({ name: 'tiny 20 mm sensor 10 mm into huge slab', category: 'crossing', mtdM: 0.01,
      a: vb('M', 'IFCFLOWTERMINAL', 'P tiny sensor', x + 1, x + 1.02, 1, 1.02, -0.26, -0.24 + 0.0), b: vb('S', 'IFCSLAB', 'P huge slab', x - 1.5, x + 3.5, -60, 60, -0.25, 0) }));
    plant((x) => ({ name: 'duct 300 mm above wall, side face flush with wall face (shared plane)', category: 'separate', distanceM: 0.3,
      a: hr('M', 'IFCDUCTSEGMENT', 'P duct above wall flush side', 'x', x, 1.25, 3.5, 2, 0.5, 0.4), b: vb('A', 'IFCWALL', 'P wall below duct', x, x + 2, 1.25, 1.5, 0, 3.0) }));
    plant((x) => {
      // rotated face contact: two tessellated blocks sharing an inclined face (identical vertex text)
      const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
      const P = (u, v, w) => [x + 1 + c * u - s * v, 1 + s * u + c * v, w];
      const a0 = boxV(-0.5, 0, -0.2, 0.2, 0, 1).map(([u, v, w]) => P(u, v, w));
      const b0 = boxV(0, 0.5, -0.2, 0.2, 0, 1).map(([u, v, w]) => P(u, v, w));
      return { name: 'face contact on a 30 deg rotated plane', category: 'contact',
        a: tri('S', 'IFCMEMBER', 'P rotated block', a0, BOXT), b: tri('A', 'IFCCOVERING', 'P rotated cladding block', b0, BOXT) };
    });
    plant((x) => ({ name: 'exact duplicate (architect copy of a structural column)', category: 'crossing',
      a: vb('S', 'IFCCOLUMN', 'P structural column', x, x + 0.4, 1, 1.4, 0, 3), b: vb('A', 'IFCCOVERING', 'P architect column copy', x, x + 0.4, 1, 1.4, 0, 3) }));
    plant((x) => ({ name: 'horizontal x-gap 50.1 mm (Float32-sensitive in the far variant)', category: 'clearance', distanceM: 0.0501, toleranceRelation: 'above',
      a: vb('M', 'IFCFLOWTERMINAL', 'P cabinet x-gap', x + 1.0501, x + 1.5, 0.5, 1.0, 0, 1.2), b: vb('A', 'IFCWALL', 'P wall x-gap', x + 0.8, x + 1, 0, 2, 0, 3) }));
    plant((x) => ({ name: 'parallel rectangular pipes 49.9 mm apart', category: 'clearance', distanceM: 0.0499, toleranceRelation: 'below',
      a: hr('M', 'IFCPIPESEGMENT', 'P pipe parallel A', 'x', x, 1, 1.5, 2, 0.1, 0.1), b: hr('S', 'IFCMEMBER', 'P member parallel', 'x', x, 1 + 0.1 + 0.0499, 1.5, 2, 0.1, 0.1) }));
  }

  // ── finalize: containment + spaces aggregation ──
  const files = {};
  for (const [key, m] of Object.entries(models)) {
    for (const st of m.storeys) {
      const els = m.storeyEls.get(st.id);
      if (els.length) m.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${m.guid()}',$,$,$,(${els.map((e) => '#' + e).join(',')}),#${st.id})`);
      if (st.spaces.length) m.add(`IFCRELAGGREGATES('${m.guid()}',$,$,$,#${st.id},(${st.spaces.map((e) => '#' + e).join(',')}))`);
    }
    files[key] = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');\nFILE_NAME('${m.file}','2026-10-22T00:00:00',('ClashControl accuracy generator'),('ClashControl'),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${m.L.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
  }
  // repeated-geometry share: products whose representation signature occurs more than once
  let products = 0, repeated = 0;
  const typeCounts = {};
  for (const [key, m] of Object.entries(models)) {
    typeCounts[key] = m.typeCounts;
    for (const c of m.sigs.values()) { products += c; if (c > 1) repeated += c - 1; }
  }
  const stats = {
    scale, seed, georef, products, repeatedGeometry: repeated, repeatedGeometryShare: products ? repeated / products : 0,
    bytes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])), typeCounts,
    footprint: { W, D, levels: levels.slice(0, scale.storeys + 1) },
  };
  manifest.stats = stats;
  return { files, manifest, stats, fileNames: { architecture: A.file, structure: S.file, mep: M.file } };
}

function writeBuilding(outDir, opts) {
  const g = generateBuilding(opts);
  fs.mkdirSync(outDir, { recursive: true });
  for (const k of Object.keys(g.files)) fs.writeFileSync(path.join(outDir, g.fileNames[k]), g.files[k]);
  fs.writeFileSync(path.join(outDir, 'building-manifest.json'), JSON.stringify(g.manifest, null, 2));
  return g;
}

module.exports = { generateBuilding, writeBuilding, parseScale, SCALES, mulberry32 };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const outDir = args[0] && !args[0].startsWith('--') ? args[0] : path.join(os.tmpdir(), 'cc-building-gen');
  const opts = {
    scale: flag('--scale') || process.env.CC_GEN_SCALE || 'ci',
    seed: +(flag('--seed') || process.env.CC_GEN_SEED || 4242),
    georef: flag('--georef') || process.env.CC_GEN_GEOREF || 'local',
  };
  const t0 = Date.now();
  const g = writeBuilding(outDir, opts);
  const s = g.stats;
  console.log(`wrote ${outDir} in ${Date.now() - t0} ms — scale ${JSON.stringify(s.scale)}, georef ${s.georef}`);
  for (const [k, v] of Object.entries(s.bytes)) console.log(`  ${g.fileNames[k].padEnd(28)} ${(v / 1024).toFixed(1)} KB  ${Object.values(s.typeCounts[k]).reduce((a, b) => a + b, 0)} products with geometry`);
  console.log(`  products ${s.products}, repeated geometry ${s.repeatedGeometry} (${(s.repeatedGeometryShare * 100).toFixed(2)} %), planted cases ${g.manifest.cases.length}`);
}
