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
  lines.push(`#${siteId}=IFCSITE('0SynthSite0000000000${String(siteId).padStart(2, '0')}',$,'Site',$,$,#${sitePlacementId},$,$,.ELEMENT.,${refLat},${refLon},${refElev},$,$);`);
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
  lines.push(`#${buildingId}=IFCBUILDING('0SynthBldg0000000000${String(buildingId).padStart(2, '0')}',$,'Building',$,$,#${buildingPlacementId},$,$,.ELEMENT.,$,$,$);`);
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
      lines.push(`#${wallOriginId}=IFCCARTESIANPOINT((${(w * 5).toFixed(1)},0.,0.));`);
      lines.push(`#${wallAxisId}=IFCAXIS2PLACEMENT3D(#${wallOriginId},$,$);`);
      lines.push(`#${wallPlacementId}=IFCLOCALPLACEMENT(#${storeyPlacementId},#${wallAxisId});`);
      lines.push(`#${shapeId}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${repId}));`);
      lines.push(`#${repId}=IFCSHAPEREPRESENTATION(#${geomCtxId},'Body','SweptSolid',(#${extrudeId}));`);
      lines.push(`#${extrudeId}=IFCEXTRUDEDAREASOLID(#${profileId},#${wallAxisId},#${extrudeDirId},${storeyHeight}.);`);
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
  }

  lines.push('ENDSEC;');
  lines.push('END-ISO-10303-21;');
  return lines.join('\n') + '\n';
}

module.exports = { generateSyntheticIfc };
