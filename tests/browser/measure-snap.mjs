// Measure-tool snapping in the real viewer, on the BatchedMesh path.
//
// Fixture: tests/fixtures/generate-synthetic-ifc.js (one storey of plain
// 4 x 0.3 x 3 m walls), loaded with window._ccForceBatch so every wall is a
// batch instance. Asserts, through real mousemove events on the canvas:
//   - hovering 5 px inside a wall's corner snaps to that corner (vertex),
//   - hovering 9 px off the middle of its top edge snaps onto the edge,
//   - with a horizontal section plane active, nothing snaps to the part of
//     the wall the section cuts away.
// (Before viewer-pick-core.js: batched hits always read "Surface" at the raw
// hit point, and hover snapped to section-clipped geometry.)
//
// Run:  CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 \
//       node tests/browser/measure-snap.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { generateSyntheticIfc } = require('../fixtures/generate-synthetic-ifc.js');

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};

let allOk = true;
function fail(msg) { console.error('MEASURE SNAP FAIL: ' + msg); allOk = false; }

const virtualFiles = new Map([['/__synthetic/walls.ifc', generateSyntheticIfc({ storeyCount: 1, wallsPerStorey: 3 })]]);
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (virtualFiles.has(urlPath)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(virtualFiles.get(urlPath));
    }
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const localChromium = process.env.CC_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(localChromium ? {
  executablePath: localChromium,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
} : {});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
  const ctx = page.context();
  async function local(route, file, contentType) {
    await route.fulfill({
      status: 200,
      body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' },
    });
  }
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await ctx.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', (r) => local(r, 'three/' + new URL(r.request().url()).pathname.split('/three@0.180.0/')[1]));
  await ctx.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', (r) => { const s = new URL(r.request().url()).pathname.split('/web-ifc@0.0.77/')[1]; return local(r, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await ctx.route('https://gc.zgo.at/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg && window._ccViewerPick, null, { timeout: 60_000 });

  await page.evaluate(async () => {
    window._ccForceBatch = true;
    const buf = await (await fetch('/__synthetic/walls.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'walls.ifc')]);
  });
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && s.models.length === 1 && (s.models[0].elements || []).length >= 3 && window._ccModelLoading === false; }, null, { timeout: 120_000 });
  await page.waitForTimeout(800);

  const batched = await page.evaluate(() => { let n = 0; window._ccState3d.mg.traverse((o) => { if (o.isBatchedMesh) n++; }); return n; });
  if (!batched) fail('fixture did not take the BatchedMesh path');

  // Camera square in front of the middle wall's long face; measure mode on.
  const geo = await page.evaluate(async () => {
    const S = window._ccState3d;
    const els = window._ccLatestState.models[0].elements.filter((e) => e.box && !e.box.isEmpty());
    els.sort((a, b) => a.box.min.x - b.box.min.x);
    const b = els[1].box;
    const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
    S.camera.position.set(cx, cy, b.max.z + 7);
    S.orbit.target.set(cx, cy, b.max.z);
    S.orbit.sync(); S.orbit.apply();
    S.camera.updateMatrixWorld(true);
    window._ccDispatch({ t: 'MEASURE_MODE', v: 'distance' });
    await new Promise((r) => setTimeout(r, 300));
    S.camera.updateMatrixWorld(true);
    const rect = S.renderer.domElement.getBoundingClientRect();
    const scr = (x, y, z) => { const v = new window.THREE.Vector3(x, y, z).project(S.camera); return [rect.left + (v.x * 0.5 + 0.5) * rect.width, rect.top + (-v.y * 0.5 + 0.5) * rect.height]; };
    return {
      min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z],
      topLeft: scr(b.min.x, b.max.y, b.max.z), bottomLeft: scr(b.min.x, b.min.y, b.max.z),
      topMid: scr(cx, b.max.y, b.max.z), mid: scr(cx, cy, b.max.z),
    };
  });

  async function hover(x, y) {
    return page.evaluate(async ([x, y]) => {
      const el = window._ccState3d.renderer.domElement;
      window._ccHoverSnap = null;
      await new Promise((r) => setTimeout(r, 80)); // hover handler is throttled to 50 ms
      el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      const s = window._ccHoverSnap;
      return s ? { type: s.type, p: [s.point.x, s.point.y, s.point.z], batched: !!(s.srcObj && s.srcObj.isBatchedMesh) } : null;
    }, [x, y]);
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // 1) Vertex: 5 px inside the top-left corner of the front face.
  const v = await hover(geo.topLeft[0] + 5, geo.topLeft[1] + 5);
  const corner = [geo.min[0], geo.max[1], geo.max[2]];
  if (!v) fail('no snap near the corner');
  else {
    if (!v.batched) fail('corner hover did not hit the batched wall');
    if (v.type !== 'vertex') fail('expected vertex snap near the corner, got ' + v.type);
    if (dist(v.p, corner) > 1e-3) fail('vertex snap at ' + v.p + ', expected ' + corner);
  }

  // 2) Edge: 9 px below the middle of the top edge.
  const e = await hover(geo.topMid[0] + 0.5, geo.topMid[1] + 9);
  if (!e) fail('no snap near the top edge');
  else {
    if (e.type !== 'edge') fail('expected edge snap near the top edge, got ' + e.type);
    if (Math.abs(e.p[1] - geo.max[1]) > 1e-3 || Math.abs(e.p[2] - geo.max[2]) > 1e-3) fail('edge snap off the top edge: ' + e.p);
  }

  // 3) Section plane: nothing snaps to geometry the section cuts away.
  await page.evaluate(async () => {
    window._ccDispatch({ t: 'SECTION', axis: 'y', pos: 0.5 });
    await new Promise((r) => setTimeout(r, 500));
  });
  const planes = await page.evaluate(() => (window._ccActivePlanes || []).map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]));
  if (!planes.length) fail('section plane not active');
  const visible = (p) => planes.every((pl) => pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] + pl[3] >= -0.011);
  const topClipped = !visible(corner);
  const cutCorner = topClipped ? geo.topLeft : geo.bottomLeft;
  const dy = topClipped ? 5 : -5;
  const checks = [
    ['cut corner', await hover(cutCorner[0] + 5, cutCorner[1] + dy)],
    ['cut face', await hover(geo.mid[0] + 20, (cutCorner[1] + geo.mid[1]) / 2)],
    ['cut edge', await hover(geo.topMid[0], cutCorner[1] + dy)],
  ];
  for (const [name, s] of checks) {
    if (s && !visible(s.p)) fail(name + ': snapped to section-clipped geometry at ' + s.p + ' (' + s.type + ')');
  }
  // ...while the kept part still snaps normally.
  const keep = await hover(geo.mid[0] + 20, geo.mid[1] + (topClipped ? 30 : -30));
  if (!keep) fail('no snap on the visible part of the cut wall');
  else if (!visible(keep.p)) fail('visible-part snap landed in the clipped region: ' + keep.p);

  if (errors.length) fail('page errors: ' + errors.join(' | '));
  console.log(allOk
    ? 'MEASURE SNAP OK — batched vertex ' + JSON.stringify(v && v.type) + ', edge ' + JSON.stringify(e && e.type) + ', section-clipped geometry never snapped'
    : 'MEASURE SNAP FAILED');
} catch (err) {
  fail(err && err.stack || String(err));
} finally {
  await browser.close();
  server.close();
}
process.exit(allOk ? 0 : 1);
