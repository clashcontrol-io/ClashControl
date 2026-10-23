'use strict';
// Generates a valid, loadable IFC4-SPF file with a configurable number of
// storeys and walls per storey. Used to build both a small multi-storey
// fixture (storey-chooser real-browser verification) and a large synthetic
// fixture (large-model perf/memory measurement) from one shared generator,
// rather than hand-writing two divergent one-off files.
//
// Structure mirrors tests/fixtures/smoke-clash.ifc (the existing hand-written
// fixture) — same entity shapes, just looped over N storeys/M walls instead
// of a fixed two walls.

function generateSyntheticIfc(opts) {
  opts = opts || {};
  const storeyCount = opts.storeyCount || 3;
  const wallsPerStorey = opts.wallsPerStorey || 4;
  const storeyHeight = opts.storeyHeight != null ? opts.storeyHeight : 3;
  // Additive opt-in extensions (all default off — omitting them reproduces
  // the exact prior output byte-for-byte). Added to build the worker/
  // fallback differential harness's fixture matrix beyond the single
  // two-wall smoke case: unit conversion, quantities, property sets
  // (including one deliberately null-valued "degenerate" property — a
  // spec-valid record with no value, not invalid SPF syntax that could
  // make the two parse paths crash differently instead of diverge
  // measurably), and IFC4 georeferencing.
  const lengthUnitPrefix = opts.lengthUnit === 'MILLIMETRE' ? '.MILLI.' : '$';
  const withQuantities = !!opts.withQuantities;
  const withPsets = !!opts.withPsets;
  const geo = opts.geo || null; // {lat:[d,m,s], lon:[d,m,s], elev}
  const mapConversion = opts.mapConversion || null; // {eastings, northings, epsg}
  // postalAddress: {site: 'Country', building: 'Country'} — IfcPostalAddress
  // (Country only) on IfcSite.SiteAddress / IfcBuilding.BuildingAddress.
  const postalAddress = opts.postalAddress || null;
  // withSpaces: one IfcSpace (room) per storey, an extruded rectangle that
  // encloses every wall of that storey (decomposed from the storey via
  // IfcRelAggregates, like real authoring tools write it). Its height is
  // storeyHeight - 0.1 so it never touches the next storey's walls.
  const withSpaces = !!opts.withSpaces;
  // offsetX: shifts every wall (and room) along X inside the storey frame —
  // a building drawn far from its storey origin.
  const offsetX = +opts.offsetX || 0;
  // spaceFrame: 'parent' writes each room the way some exporters do: its
  // footprint in the STOREY's coordinates while the room also gets its own
  // placement near that footprint, so applying both doubles the offset.
  // The room is meant to sit exactly where the default writing puts it.
  const spaceFrame = opts.spaceFrame === 'parent' ? 'parent' : 'own';

  let id = 0;
  const next = () => ++id;
  const lines = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('ClashControl synthetic fixture: ${storeyCount} storeys x ${wallsPerStorey} walls'),'2;1');`,
    `FILE_NAME('synthetic.ifc','2026-01-01T00:00:00',('ClashControl'),('ClashControl'),'','','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
  ];

  const projectId = next();
  const unitAssignId = next();
  const siUnitId = next();
  const geomCtxId = next();
  const axisId = next();
  const originId = next();
  lines.push(`#${projectId}=IFCPROJECT('0SynthProject00000000${String(projectId).padStart(2, '0')}',$,'Synthetic Project',$,$,$,$,(#${geomCtxId}),#${unitAssignId});`);
  lines.push(`#${unitAssignId}=IFCUNITASSIGNMENT((#${siUnitId}));`);
  lines.push(`#${siUnitId}=IFCSIUNIT(*,.LENGTHUNIT.,${lengthUnitPrefix},.METRE.);`);
  lines.push(`#${geomCtxId}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#${axisId},$);`);
  lines.push(`#${axisId}=IFCAXIS2PLACEMENT3D(#${originId},$,$);`);
  lines.push(`#${originId}=IFCCARTESIANPOINT((0.,0.,0.));`);

  const siteId = next();
  const sitePlacementId = next();
  // RefLatitude/RefLongitude/RefElevation (IfcSite attrs 10-12) are $ (null)
  // unless opts.geo supplies compound [deg,min,sec] arrays — matches the
  // format extractSpatialHierarchy's _compoundToDeg reads (index.html).
  const refLat = geo && geo.lat ? `(${geo.lat.join(',')})` : '$';
  const refLon = geo && geo.lon ? `(${geo.lon.join(',')})` : '$';
  // STEP REAL literals require a decimal point (e.g. "3." or "10.5") — never
  // append one blindly, or a non-integer value like 10.5 becomes "10.5.",
  // which is invalid EXPRESS/STEP syntax.
  const refElev = geo && geo.elev != null
    ? (String(geo.elev).indexOf('.') === -1 ? `${geo.elev}.` : `${geo.elev}`)
    : '$';
  const addrLine = (country) => {
    const aid = next();
    lines.push(`#${aid}=IFCPOSTALADDRESS($,$,$,$,('Synthetic street 1'),$,'Synthetic town',$,'0000',${country == null ? '$' : `'${country}'`});`);
    return `#${aid}`;
  };
  const siteAddr = postalAddress && postalAddress.site != null ? addrLine(postalAddress.site) : '$';
  const bldAddr = postalAddress && postalAddress.building != null ? addrLine(postalAddress.building) : '$';
  lines.push(`#${siteId}=IFCSITE('0SynthSite0000000000${String(siteId).padStart(2, '0')}',$,'Site',$,$,#${sitePlacementId},$,$,.ELEMENT.,${refLat},${refLon},${refElev},$,${siteAddr});`);
  lines.push(`#${sitePlacementId}=IFCLOCALPLACEMENT($,#${axisId});`);
  if (mapConversion) {
    // IFC4 IfcMapConversion ties the project's local engineering coords
    // (SourceCRS = the model's own geometric representation context) to an
    // IfcProjectedCRS (TargetCRS) — read by extractSpatialHierarchy via
    // GetLineIDsWithType(IFCMAPCONVERSION), independent of the compound
    // RefLatitude/RefLongitude path above.
    const crsId = next();
    const mcId = next();
    lines.push(`#${crsId}=IFCPROJECTEDCRS('${mapConversion.epsg || 'RD_New'}',$,$,$,$,$,$);`);
    lines.push(`#${mcId}=IFCMAPCONVERSION(#${geomCtxId},#${crsId},${(mapConversion.eastings || 0)}.,${(mapConversion.northings || 0)}.,0.,0.999,0.001,1.);`);
  }

  const buildingId = next();
  const buildingPlacementId = next();
  lines.push(`#${buildingId}=IFCBUILDING('0SynthBldg0000000000${String(buildingId).padStart(2, '0')}',$,'Building',$,$,#${buildingPlacementId},$,$,.ELEMENT.,$,$,${bldAddr});`);
  lines.push(`#${buildingPlacementId}=IFCLOCALPLACEMENT(#${sitePlacementId},#${axisId});`);

  lines.push(`#${next()}=IFCRELAGGREGATES('0SynthRelAg000000000${id}',$,$,$,#${projectId},(#${siteId}));`);
  lines.push(`#${next()}=IFCRELAGGREGATES('0SynthRelAg000000000${id}',$,$,$,#${siteId},(#${buildingId}));`);

  const profileId = next();
  const profilePlacementId = next();
  const profileOriginId = next();
  // IfcRectangleProfileDef's Position must be an IfcAxis2Placement2D — NOT
  // a bare IfcCartesianPoint (found by profiling: passing a 3D point here
  // made web-ifc's GetAxis2DPlacement() log "unexpected 2D placement type 6"
  // and fall back to a slow recovery path on every single element, which
  // had been silently inflating every large-model timing measurement taken
  // against fixtures from this generator).
  lines.push(`#${profileId}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profilePlacementId},4.,0.3);`);
  lines.push(`#${profilePlacementId}=IFCAXIS2PLACEMENT2D(#${profileOriginId},$);`);
  lines.push(`#${profileOriginId}=IFCCARTESIANPOINT((0.,0.));`);
  const extrudeDirId = next();
  lines.push(`#${extrudeDirId}=IFCDIRECTION((0.,0.,1.));`);

  for (let s = 0; s < storeyCount; s++) {
    const elevation = s * storeyHeight;
    const storeyId = next();
    const storeyPlacementId = next();
    const storeyGuid = ('0SynthStorey' + storeyId).padEnd(22, '0').slice(0, 22);
    lines.push(`#${storeyId}=IFCBUILDINGSTOREY('${storeyGuid}',$,'Level ${s}',$,$,#${storeyPlacementId},$,$,.ELEMENT.,${elevation}.);`);
    lines.push(`#${storeyPlacementId}=IFCLOCALPLACEMENT(#${buildingPlacementId},#${axisId});`);
    lines.push(`#${next()}=IFCRELAGGREGATES('0SynthRelAg000000000${id}',$,$,$,#${buildingId},(#${storeyId}));`);

    const wallIds = [];
    for (let w = 0; w < wallsPerStorey; w++) {
      const wallId = next();
      const wallPlacementId = next();
      const wallAxisId = next();
      const wallOriginId = next();
      const shapeId = next();
      const repId = next();
      const extrudeId = next();
      const wallGuid = ('1SynthWall' + wallId).padEnd(22, '0').slice(0, 22);
      // Offset each wall along X so they don't all perfectly coincide.
      lines.push(`#${wallOriginId}=IFCCARTESIANPOINT((${(offsetX + w * 5).toFixed(1)},0.,0.));`);
      lines.push(`#${wallAxisId}=IFCAXIS2PLACEMENT3D(#${wallOriginId},$,$);`);
      lines.push(`#${wallPlacementId}=IFCLOCALPLACEMENT(#${storeyPlacementId},#${wallAxisId});`);
      lines.push(`#${shapeId}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${repId}));`);
      lines.push(`#${repId}=IFCSHAPEREPRESENTATION(#${geomCtxId},'Body','SweptSolid',(#${extrudeId}));`);
      // (the extrusion reuses the placement axis, so walls land at 2·w·5 —
      // kept for existing fixtures; with offsetX the solid sits at the
      // placement itself so the walls stay where offsetX puts them)
      lines.push(`#${extrudeId}=IFCEXTRUDEDAREASOLID(#${profileId},#${offsetX ? axisId : wallAxisId},#${extrudeDirId},${storeyHeight}.);`);
      lines.push(`#${wallId}=IFCWALL('${wallGuid}',$,'Wall S${s}W${w}',$,$,#${wallPlacementId},#${shapeId},$,$);`);
      wallIds.push(wallId);
      if (withQuantities) {
        const qLenId = next(), qAreaId = next(), qtoId = next(), relId = next();
        lines.push(`#${qLenId}=IFCQUANTITYLENGTH('Length',$,$,${storeyHeight}.,$);`);
        lines.push(`#${qAreaId}=IFCQUANTITYAREA('GrossArea',$,$,1.2,$);`);
        lines.push(`#${qtoId}=IFCELEMENTQUANTITY('3SynthQto000000000${qtoId}',$,'BaseQuantities',$,$,(#${qLenId},#${qAreaId}));`);
        lines.push(`#${relId}=IFCRELDEFINESBYPROPERTIES('4SynthRelQ00000000${relId}',$,$,$,(#${wallId}),#${qtoId});`);
      }
      if (withPsets) {
        // One real value + one deliberately null-valued ("degenerate")
        // property in the same set — a spec-valid record with no value,
        // exercising extractProperties'/safeStr's null-handling identically
        // on both the worker and main-thread-fallback parse paths.
        const propFireId = next(), propNullId = next(), psetId = next(), relPsetId = next();
        lines.push(`#${propFireId}=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('60min'),$);`);
        lines.push(`#${propNullId}=IFCPROPERTYSINGLEVALUE('DegenerateProp',$,$,$);`);
        lines.push(`#${psetId}=IFCPROPERTYSET('5SynthPset000000000${psetId}',$,'Pset_WallCommon',$,(#${propFireId},#${propNullId}));`);
        lines.push(`#${relPsetId}=IFCRELDEFINESBYPROPERTIES('6SynthRelP00000000${relPsetId}',$,$,$,(#${wallId}),#${psetId});`);
      }
    }
    lines.push(`#${next()}=IFCRELCONTAINEDINSPATIALSTRUCTURE('2SynthRelCont00000000${id}',$,$,$,(${wallIds.map((w) => '#' + w).join(',')}),#${storeyId});`);
    if (withSpaces) {
      const spaceId = next(), spPlacementId = next(), spAxisId = next(), spOriginId = next();
      const spProfileId = next(), spProfilePlacementId = next(), spShapeId = next(), spRepId = next(), spExtrudeId = next();
      const spaceGuid = ('7SynthSpace' + spaceId).padEnd(22, '0').slice(0, 22);
      const cx = ((wallsPerStorey - 1) * 5) / 2;
      const len = wallsPerStorey * 5;
      // own frame: placement at the room centre, footprint centred on it.
      // parent frame: placement at the room's min corner, footprint centre
      // written in storey coordinates.
      const spPl = spaceFrame === 'parent' ? [offsetX + cx - len / 2, -3] : [offsetX + cx, 0];
      lines.push(`#${spOriginId}=IFCCARTESIANPOINT((${spPl[0].toFixed(1)},${spPl[1].toFixed(1)},0.));`);
      lines.push(`#${spAxisId}=IFCAXIS2PLACEMENT3D(#${spOriginId},$,$);`);
      lines.push(`#${spPlacementId}=IFCLOCALPLACEMENT(#${storeyPlacementId},#${spAxisId});`);
      lines.push(`#${spProfileId}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#${spProfilePlacementId},${len.toFixed(1)},6.);`);
      if (spaceFrame === 'parent') {
        const spFootId = next();
        lines.push(`#${spFootId}=IFCCARTESIANPOINT((${(offsetX + cx).toFixed(1)},0.));`);
        lines.push(`#${spProfilePlacementId}=IFCAXIS2PLACEMENT2D(#${spFootId},$);`);
      } else {
        lines.push(`#${spProfilePlacementId}=IFCAXIS2PLACEMENT2D(#${profileOriginId},$);`);
      }
      lines.push(`#${spExtrudeId}=IFCEXTRUDEDAREASOLID(#${spProfileId},#${axisId},#${extrudeDirId},${(storeyHeight - 0.1).toFixed(1)});`);
      lines.push(`#${spRepId}=IFCSHAPEREPRESENTATION(#${geomCtxId},'Body','SweptSolid',(#${spExtrudeId}));`);
      lines.push(`#${spShapeId}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${spRepId}));`);
      lines.push(`#${spaceId}=IFCSPACE('${spaceGuid}',$,'Room ${s}.01','Synthetic room',$,#${spPlacementId},#${spShapeId},'Room ${s}.01',.ELEMENT.,.SPACE.,$);`);
      lines.push(`#${next()}=IFCRELAGGREGATES('0SynthRelAg000000000${id}',$,$,$,#${storeyId},(#${spaceId}));`);
    }
  }

  lines.push('ENDSEC;');
  lines.push('END-ISO-10303-21;');
  return lines.join('\n') + '\n';
}

// ── Semantic federation fixtures (opt-in, separate entry point) ──────────
// generateSemanticIfc(opts) writes ONE model of a small federation built to
// exercise discipline / sub-discipline / role detection and space
// boundaries. It never changes generateSyntheticIfc's output.
//   opts.kind: 'struct' | 'vent' | 'plumb' | 'elec' | 'firecomp' | 'arch'
//   opts.names: false -> every Name/ObjectType/system name is $ (evidence
//     must come from stated data: systems' PredefinedType is not available in
//     IFC2X3, so unnamed MEP models rely on type objects + classification)
//   opts.nameLang: 'en' (default) | 'nl' | 'de' — language of element/system
//     names, to prove name hints come from whichever pack carries them
//   opts.boundaryOffset: [dx,dy,dz] metres added to every space-boundary
//     plane origin (the systematic offset some exporters write)
//   opts.boundaryNoise: true -> boundaries are scattered (no consistent
//     offset), so placement must be refused
//   opts.geoProvision (struct): + an UNNAMED, untyped proxy (NOTDEFINED, no
//     material) that the vent duct, the drain pipe and the cable tray all
//     pass through — a provision recognisable only from geometry
//   opts.geoZoneMarker (firecomp): + an unnamed thin plate inside arch wall S —
//     a compartment-boundary marker recognisable only from geometry
//   opts.equipmentProxy (vent): + a proxy that is real equipment (a fan unit
//     in the supply-air system, crossed by the duct) — must never be
//     suggested as a provision / zone
// MEP kinds are IFC2X3 with generic IfcFlowSegment products typed via
// IfcRelDefinesByType (IfcDuctSegmentType / IfcPipeSegmentType /
// IfcCableCarrierSegmentType), IfcSystem membership (IfcRelAssignsToGroup +
// IfcRelServicesBuildings) and NL-SfB IfcClassificationReference codes.
// Layout (metres, Z up): a slab at z 3.0–3.3 over x 0–20, y 0–10 with a
// provision box (x,y 4–6, z 2.9–3.4); vent: a riser through the provision
// and a duct along x at y 7.5–8.0, z 2.0–2.4; plumb: a drain pipe crossing
// that duct at x 10 plus a stray duct crossing it at x 8 (same trade); elec:
// a cable tray crossing it at x 12; firecomp: a fire-compartment volume over
// x 14–18 crossing it; arch: two rooms (x 32–38, y 0–5) with walls, a floor
// slab and second-level space boundaries.
const SEM_NAMES = {
  en: { riser: 'Supply air riser', duct: 'Supply air duct', drain: 'Waste water pipe', strayDuct: 'Extract air duct', tray: 'Cable tray',
    sysVent: 'Supply air', sysDrain: 'Sewage', sysElec: 'Power', provision: 'Provision for shaft', zone: 'Fire compartment 60 min',
    slab: 'Floor slab', room: 'Office', wall: 'Wall' },
  nl: { riser: 'Luchtkanaal stijg', duct: 'Luchtkanaal toevoer', drain: 'Afvoerleiding', strayDuct: 'Afzuigkanaal', tray: 'Kabelgoot',
    sysVent: 'Toevoer lucht', sysDrain: 'Riolering', sysElec: 'Kabelgoten', provision: 'Sparing schacht', zone: 'Brandcompartiment 60 min',
    slab: 'Vloer', room: 'Kantoor', wall: 'Wand' },
  de: { riser: 'Zuluftsteigleitung', duct: 'Zuluftkanal', drain: 'Abwasserleitung', strayDuct: 'Abluftkanal', tray: 'Kabeltrasse',
    sysVent: 'Zuluft', sysDrain: 'Schmutzwasser', sysElec: 'Kabeltrasse', provision: 'Aussparung Schacht', zone: 'Brandabschnitt 60 min',
    slab: 'Decke', room: 'Buero', wall: 'Wand' },
};

function generateSemanticIfc(opts) {
  opts = opts || {};
  const kind = opts.kind || 'vent';
  const mep = ['vent', 'plumb', 'elec'].includes(kind);
  const schema = mep ? 'IFC2X3' : 'IFC4';
  const N = SEM_NAMES[opts.nameLang || 'en'];
  const named = opts.names !== false;
  const q = (s) => (named && s ? `'${s}'` : '$');
  const f = (v) => { const t = (Math.round(v * 1e6) / 1e6).toString(); return t.indexOf('.') >= 0 || t.indexOf('e') >= 0 ? t : t + '.'; };
  let id = 0;
  const L = [];
  const add = (s) => { const i = ++id; L.push(`#${i}=${s};`); return i; };
  let g = 0;
  const guid = () => ('3Sem' + kind + String(++g)).padEnd(22, 'x').slice(0, 22);
  const pt = (x, y, z) => add(`IFCCARTESIANPOINT((${f(x)},${f(y)},${f(z)}))`);
  const pt2 = (x, y) => add(`IFCCARTESIANPOINT((${f(x)},${f(y)}))`);
  const dir = (x, y, z) => add(`IFCDIRECTION((${f(x)},${f(y)},${f(z)}))`);
  const ax = (o, z, x) => add(`IFCAXIS2PLACEMENT3D(#${pt(...o)},${z ? '#' + dir(...z) : '$'},${x ? '#' + dir(...x) : '$'})`);

  const units = add(`IFCUNITASSIGNMENT((#${add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')}))`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#${ax([0, 0, 0])},$)`);
  const project = add(`IFCPROJECT('${guid()}',$,'Semantic ${kind}',$,$,$,$,(#${ctx}),#${units})`);
  const sitePl = add(`IFCLOCALPLACEMENT($,#${ax([0, 0, 0])})`);
  const site = add(`IFCSITE('${guid()}',$,'Site',$,$,#${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = add(`IFCLOCALPLACEMENT(#${sitePl},#${ax([0, 0, 0])})`);
  const bld = add(`IFCBUILDING('${guid()}',$,'Building',$,$,#${bldPl},$,$,.ELEMENT.,$,$,$)`);
  const stPl = add(`IFCLOCALPLACEMENT(#${bldPl},#${ax([0, 0, 0])})`);
  const storey = add(`IFCBUILDINGSTOREY('${guid()}',$,'Level 0',$,$,#${stPl},$,$,.ELEMENT.,0.)`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${project},(#${site}))`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${site},(#${bld}))`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${bld},(#${storey}))`);
  const zUp = dir(0, 0, 1);
  // Axis-aligned box as an extruded rectangle, placed in the storey.
  function boxShape(min, max) {
    const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${add(`IFCAXIS2PLACEMENT2D(#${pt2(0, 0)},$)`)},${f(max[0] - min[0])},${f(max[1] - min[1])})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${prof},#${ax([0, 0, 0])},#${zUp},${f(max[2] - min[2])})`);
    const rep = add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(#${solid}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const pl = add(`IFCLOCALPLACEMENT(#${stPl},#${ax([cx, cy, min[2]])})`);
    return { pl, shape };
  }
  const contained = [];
  function product(entity, name, min, max, tail) {
    const b = boxShape(min, max);
    const i = add(`${entity}('${guid()}',$,${q(name)},$,${q(name)},#${b.pl},#${b.shape}${tail})`);
    contained.push(i);
    return i;
  }
  const typeOf = {};
  function typed(typeEntity, typeName, predef, objs) {
    const key = typeEntity + typeName;
    if (!typeOf[key]) typeOf[key] = add(`${typeEntity}('${guid()}',$,${q(typeName)},$,$,$,$,$,$,.${predef}.)`);
    add(`IFCRELDEFINESBYTYPE('${guid()}',$,$,$,(${objs.map((o) => '#' + o).join(',')}),#${typeOf[key]})`);
  }
  let nlsfb = null;
  function classify(code, objs) {
    if (!nlsfb) nlsfb = schema === 'IFC2X3' ? add(`IFCCLASSIFICATION('BIM Loket','4',$,'NL-SfB')`) : add(`IFCCLASSIFICATION('BIM Loket','4',$,'NL-SfB',$,$,$)`);
    const ref = schema === 'IFC2X3' ? add(`IFCCLASSIFICATIONREFERENCE($,'${code}',$,#${nlsfb})`) : add(`IFCCLASSIFICATIONREFERENCE($,'${code}',$,#${nlsfb},$,$)`);
    add(`IFCRELASSOCIATESCLASSIFICATION('${guid()}',$,$,$,(${objs.map((o) => '#' + o).join(',')}),#${ref})`);
  }
  function system(name, objs) {
    const sys = add(`IFCSYSTEM('${guid()}',$,${q(name)},$,$)`);
    add(`IFCRELASSIGNSTOGROUP('${guid()}',$,$,$,(${objs.map((o) => '#' + o).join(',')}),$,#${sys})`);
    add(`IFCRELSERVICESBUILDINGS('${guid()}',$,$,$,#${sys},(#${bld}))`);
  }
  const seg = (name, min, max) => product('IFCFLOWSEGMENT', name, min, max, ',$');

  if (kind === 'struct') {
    product('IFCSLAB', N.slab, [0, 0, 3.0], [20, 10, 3.3], ',$,.FLOOR.');
    product('IFCBUILDINGELEMENTPROXY', N.provision, [4, 4, 2.9], [6, 6, 3.4], ',$,.PROVISIONFORVOID.');
    if (opts.geoProvision) {
      const b = boxShape([9, 6.5, 1.9], [13, 8.5, 2.5]);
      contained.push(add(`IFCBUILDINGELEMENTPROXY('${guid()}',$,$,$,$,#${b.pl},#${b.shape},$,.NOTDEFINED.)`));
    }
  } else if (kind === 'vent') {
    const riser = seg(N.riser, [4.5, 4.5, 0.5], [5.5, 5.5, 6.0]);
    const duct = seg(N.duct, [1, 7.5, 2.0], [19, 8.0, 2.4]);
    typed('IFCDUCTSEGMENTTYPE', 'Rectangular duct', 'RIGIDSEGMENT', [riser, duct]);
    const ventSys = [riser, duct];
    if (opts.equipmentProxy) ventSys.push(product('IFCBUILDINGELEMENTPROXY', 'Fan unit FU-01', [15, 7.3, 1.8], [16, 8.2, 2.6], ',$,$'));
    system(N.sysVent, ventSys);
    classify('57.51', [riser, duct]);
  } else if (kind === 'plumb') {
    const drain = seg(N.drain, [9.95, 6.0, 2.15], [10.05, 9.0, 2.25]);
    const stray = seg(N.strayDuct, [7.9, 6.0, 2.1], [8.1, 9.0, 2.3]);
    typed('IFCPIPESEGMENTTYPE', 'PVC pipe', 'RIGIDSEGMENT', [drain]);
    typed('IFCDUCTSEGMENTTYPE', 'Round duct', 'RIGIDSEGMENT', [stray]);
    system(N.sysDrain, [drain]);
    classify('52.20', [drain]);
  } else if (kind === 'elec') {
    const tray = seg(N.tray, [12.0, 6.0, 2.1], [12.3, 9.0, 2.2]);
    typed('IFCCABLECARRIERSEGMENTTYPE', 'Cable tray 300', 'CABLETRAYSEGMENT', [tray]);
    system(N.sysElec, [tray]);
    classify('61.30', [tray]);
  } else if (kind === 'firecomp') {
    product('IFCBUILDINGELEMENTPROXY', N.zone, [14, 0, 0], [18, 10, 3.0], ',$,.NOTDEFINED.');
    product('IFCBUILDINGELEMENTPROXY', N.zone, [0, 0, 0], [14, 10, 3.0], ',$,.NOTDEFINED.');
    if (opts.geoZoneMarker) {
      // Inside the arch model's wall S (x 32–38, y 0–0.25, z 0–3).
      const b = boxShape([33, 0.0625, 0.25], [36, 0.125, 2.75]);
      contained.push(add(`IFCBUILDINGELEMENTPROXY('${guid()}',$,$,$,$,#${b.pl},#${b.shape},$,.NOTDEFINED.)`));
    }
  } else if (kind === 'arch') {
    // Dyadic coordinates: exact in Float32, so the worker's Float32
    // transform transfer and the fallback's f64 path agree to the bit.
    const wallsSpec = [['S', [32, 0, 0], [38, 0.25, 3]], ['N', [32, 4.75, 0], [38, 5, 3]], ['W', [32, 0.25, 0], [32.25, 4.75, 3]],
      ['E', [37.75, 0.25, 0], [38, 4.75, 3]], ['M', [34.875, 0.25, 0], [35.125, 4.75, 3]]];
    const walls = {};
    wallsSpec.forEach(([k, a, b]) => { walls[k] = product('IFCWALL', N.wall + ' ' + k, a, b, ',$,.STANDARD.'); });
    const floor = product('IFCSLAB', N.slab, [32, 0, -0.25], [38, 5, 0], ',$,.FLOOR.');

    const off = opts.boundaryOffset || [0, 0, 0];
    const rooms = [{ n: '1', min: [32.25, 0.25, 0], max: [34.875, 4.75, 2.75], west: 'W', east: 'M' },
      { n: '2', min: [35.125, 0.25, 0], max: [37.75, 4.75, 2.75], west: 'M', east: 'E' }];
    const spaceIds = [];
    rooms.forEach((r, ri) => {
      const sx = r.max[0] - r.min[0], sy = r.max[1] - r.min[1], sz = r.max[2] - r.min[2];
      const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${add(`IFCAXIS2PLACEMENT2D(#${pt2(sx / 2, sy / 2)},$)`)},${f(sx)},${f(sy)})`);
      const solid = add(`IFCEXTRUDEDAREASOLID(#${prof},#${ax([0, 0, 0])},#${zUp},${f(sz)})`);
      const rep = add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(#${solid}))`);
      const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
      // Space placement origin = the room's min corner (boundaries are in this frame).
      const pl = add(`IFCLOCALPLACEMENT(#${stPl},#${ax(r.min)})`);
      const sp = add(`IFCSPACE('${guid()}',$,${q(N.room + ' ' + r.n)},$,$,#${pl},#${shape},${q(N.room + ' ' + r.n)},.ELEMENT.,.INTERNAL.,$)`);
      spaceIds.push(sp);
      // Faces in the space frame: [origin, zAxis, xAxis, w, h, elementId]
      const faces = [
        [[0, 0, 0], [0, 0, -1], [1, 0, 0], sx, sy, floor],
        [[0, 0, sz], [0, 0, 1], [1, 0, 0], sx, sy, null],
        [[0, 0, 0], [0, 1, 0], [1, 0, 0], sx, sz, walls.S],
        [[0, sy, 0], [0, -1, 0], [1, 0, 0], sx, sz, walls.N],
        [[0, 0, 0], [1, 0, 0], [0, 1, 0], sy, sz, walls[r.west]],
        [[sx, 0, 0], [-1, 0, 0], [0, 1, 0], sy, sz, walls[r.east]],
      ];
      faces.forEach(([o, z, x, w, h, el], fi) => {
        // y-axis of the plane frame = z × x (right-handed); every face here
        // has z ⟂ x, so the 2D rectangle (0..w, 0..h) spans x and z×x.
        const zx = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
        let origin = o.slice();
        // If z × x points opposite to the face's extent, shift the origin so
        // the rectangle still covers the face.
        if (zx[0] + zx[1] + zx[2] < 0) origin = [o[0] - zx[0] * h, o[1] - zx[1] * h, o[2] - zx[2] * h];
        const noise = opts.boundaryNoise ? [(ri * 7 + fi * 13) % 11, (ri * 5 + fi * 3) % 9, 0] : [0, 0, 0];
        const pos = ax([origin[0] + off[0] + noise[0], origin[1] + off[1] + noise[1], origin[2] + off[2] + noise[2]], z, x);
        const plane = add(`IFCPLANE(#${pos})`);
        const p0 = pt2(0, 0);
        const poly = add(`IFCPOLYLINE((#${p0},#${pt2(w, 0)},#${pt2(w, h)},#${pt2(0, h)},#${p0}))`);
        const cbp = add(`IFCCURVEBOUNDEDPLANE(#${plane},#${poly},())`);
        const csg = add(`IFCCONNECTIONSURFACEGEOMETRY(#${cbp},$)`);
        add(`IFCRELSPACEBOUNDARY('${guid()}',$,'2ndLevel',$,#${sp},${el ? '#' + el : '$'},#${csg},${el ? '.PHYSICAL.' : '.VIRTUAL.'},.INTERNAL.)`);
      });
    });
    add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${storey},(${spaceIds.map((i) => '#' + i).join(',')}))`);
  }
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${contained.map((i) => '#' + i).join(',')}),#${storey})`);
  return ['ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION(('ClashControl semantic fixture: ${kind}'),'2;1');`,
    `FILE_NAME('${kind}.ifc','2026-01-01T00:00:00',('ClashControl'),('ClashControl'),'','','');`,
    `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;', 'DATA;'].concat(L, ['ENDSEC;', 'END-ISO-10303-21;']).join('\n') + '\n';
}

module.exports = { generateSyntheticIfc, generateSemanticIfc };
