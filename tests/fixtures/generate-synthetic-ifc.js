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
  lines.push(`#${siUnitId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  lines.push(`#${geomCtxId}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#${axisId},$);`);
  lines.push(`#${axisId}=IFCAXIS2PLACEMENT3D(#${originId},$,$);`);
  lines.push(`#${originId}=IFCCARTESIANPOINT((0.,0.,0.));`);

  const siteId = next();
  const sitePlacementId = next();
  lines.push(`#${siteId}=IFCSITE('0SynthSite0000000000${String(siteId).padStart(2, '0')}',$,'Site',$,$,#${sitePlacementId},$,$,.ELEMENT.,$,$,$,$,$);`);
  lines.push(`#${sitePlacementId}=IFCLOCALPLACEMENT($,#${axisId});`);

  const buildingId = next();
  const buildingPlacementId = next();
  lines.push(`#${buildingId}=IFCBUILDING('0SynthBldg0000000000${String(buildingId).padStart(2, '0')}',$,'Building',$,$,#${buildingPlacementId},$,$,.ELEMENT.,$,$,$);`);
  lines.push(`#${buildingPlacementId}=IFCLOCALPLACEMENT(#${sitePlacementId},#${axisId});`);

  lines.push(`#${next()}=IFCRELAGGREGATES('0SynthRelAg000000000${id}',$,$,$,#${projectId},(#${siteId}));`);
  lines.push(`#${next()}=IFCRELAGGREGATES('0SynthRelAg000000000${id}',$,$,$,#${siteId},(#${buildingId}));`);

  const profileId = next();
  lines.push(`#${profileId}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#${originId},4.,0.3);`);
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
    }
    lines.push(`#${next()}=IFCRELCONTAINEDINSPATIALSTRUCTURE('2SynthRelCont00000000${id}',$,$,$,(${wallIds.map((w) => '#' + w).join(',')}),#${storeyId});`);
  }

  lines.push('ENDSEC;');
  lines.push('END-ISO-10303-21;');
  return lines.join('\n') + '\n';
}

module.exports = { generateSyntheticIfc };
