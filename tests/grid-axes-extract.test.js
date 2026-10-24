// extractGridAxes (index.html): IfcGrid axes read as data through the shared
// ifcGeomReader, in IFC world coordinates (file units), with real web-ifc.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fnSrc(name) {
  const s = html.indexOf('  function ' + name + '(');
  assert.ok(s > 0, name + ' not found');
  return html.slice(s, html.indexOf('\n  }\n', s) + 4);
}
const IFC = { IFCGRID: 3009204131 };
const extract = new Function('IFC', fnSrc('safeStr') + fnSrc('ifcGeomReader') + fnSrc('extractGridAxes') + 'return extractGridAxes;')(IFC);

// grid placed at (10, 20, 3), rotated 30 degrees about Z; three axis kinds.
// #7 is a point NOT on any axis: axis "1"'s trim parameter 7 must not read it.
const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
const IFC_TEXT = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((10.,20.,3.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((${c},${s},0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#7=IFCCARTESIANPOINT((99.,99.));
#10=IFCCARTESIANPOINT((0.,-5.));
#11=IFCCARTESIANPOINT((0.,5.));
#12=IFCPOLYLINE((#10,#11));
#13=IFCGRIDAXIS('A',#12,.T.);
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCDIRECTION((1.,0.));
#22=IFCVECTOR(#21,2.);
#23=IFCLINE(#20,#22);
#24=IFCTRIMMEDCURVE(#23,(IFCPARAMETERVALUE(-2.5)),(IFCPARAMETERVALUE(7.)),.T.,.PARAMETER.);
#25=IFCGRIDAXIS('1',#24,.T.);
#30=IFCCARTESIANPOINT((6.,-5.));
#31=IFCCARTESIANPOINT((6.,5.));
#32=IFCTRIMMEDCURVE(#23,(#30),(#31),.T.,.CARTESIAN.);
#33=IFCGRIDAXIS('B',#32,.T.);
#40=IFCGRID('0GridTest0000000000000',$,'Main grid',$,$,#5,$,(#13,#33),(#25),$,$);
ENDSEC;
END-ISO-10303-21;`;

const world = (x, y) => [10 + c * x - s * y, 20 + s * x + c * y, 3];

test('grid axes: polyline, parameter-trimmed and point-trimmed lines, in IFC world coordinates', async () => {
  const W = require(path.join(__dirname, '..', 'node_modules', 'web-ifc', 'web-ifc-api-node.js'));
  const api = new W.IfcAPI(); await api.Init();
  const id = api.OpenModel(new TextEncoder().encode(IFC_TEXT));
  const grids = extract(api, id);
  api.CloseModel(id);
  assert.equal(grids.length, 1);
  assert.equal(grids[0].name, 'Main grid');
  const byTag = Object.fromEntries(grids[0].axes.map((a) => [a.tag, a]));
  assert.deepEqual(Object.keys(byTag).sort(), ['1', 'A', 'B']);
  assert.equal(byTag.A.fam, 'U'); assert.equal(byTag.B.fam, 'U'); assert.equal(byTag['1'].fam, 'V');
  const want = { A: [world(0, -5), world(0, 5)], B: [world(6, -5), world(6, 5)], 1: [world(-5, 0), world(14, 0)] };
  for (const [tag, pts] of Object.entries(want)) {
    const got = byTag[tag].pts;
    assert.equal(got.length, 6, tag + ': two points');
    pts.flat().forEach((v, i) => assert.ok(Math.abs(v - got[i]) < 1e-9, tag + ' coordinate ' + i + ': ' + got[i] + ' vs ' + v));
  }
});

test('a model without grids gives null', async () => {
  const W = require(path.join(__dirname, '..', 'node_modules', 'web-ifc', 'web-ifc-api-node.js'));
  const api = new W.IfcAPI(); await api.Init();
  const id = api.OpenModel(new TextEncoder().encode(IFC_TEXT.replace(/#40=IFCGRID[^\n]*\n/, '')));
  assert.equal(extract(api, id), null);
  api.CloseModel(id);
});
