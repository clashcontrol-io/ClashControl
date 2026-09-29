// Section planes follow the building's plan grid. A building rotated in plan
// (office fixtures with the IfcBuilding placement turned 23 deg about IFC Z)
// must be cut parallel to its walls, with the outline hugging the footprint
// and the whole-model section box rotated to match — while an axis-aligned
// model keeps exactly the old world-axis planes.
//
// Run:  CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 \
//       node tests/browser/section-plane-alignment.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};

let allOk = true;
function fail(msg) { console.error('SECTION ALIGN FAIL: ' + msg); allOk = false; }

// In-memory files (generated fixtures) served next to the real repo files.
const virtualFiles = new Map();
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

// No --single-process/--no-zygote here (unlike smoke.mjs, which only ever
// opens one page): this test opens several pages sequentially from one
// browser instance (like wasm-sweep-differential.mjs), and single-process
// mode was observed to crash the whole browser on the second page.
const localChromium = process.env.CC_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({ executablePath: localChromium });
const errors = [];

async function newPage(query = '') {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
    async function local(route, file, contentType) {
      await route.fulfill({
        status: 200,
        body: await readFile(join(root, 'node_modules', file)),
        headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' },
      });
    }
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await page.context().route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
      await local(route, 'three/' + suffix);
    });
    await page.context().route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
      await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    });
    await page.context().route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await page.context().route('https://fonts.gstatic.com/**', (route) => route.abort());
    await page.context().route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  return page;
}


// Load the office fixtures, optionally with the IfcBuilding placement rotated
// `deg` about IFC Z (a building rotated in plan, e.g. true-north placement).
async function loadOffice(page, deg) {
  await page.evaluate(async (deg) => {
    const rot = (txt) => {
      const bp = txt.match(/IFCBUILDING\('[^']*',\$,'[^']*',\$,\$,#(\d+)/)[1];
      const re = new RegExp('#' + bp + '=IFCLOCALPLACEMENT\\((#\\d+),#\\d+\\);');
      let n = Math.max(...[...txt.matchAll(/#(\d+)=/g)].map((m) => +m[1]));
      const a = deg * Math.PI / 180, P = ++n, Z = ++n, X = ++n, AX = ++n;
      const extra = `#${P}=IFCCARTESIANPOINT((0.,0.,0.));\n#${Z}=IFCDIRECTION((0.,0.,1.));\n#${X}=IFCDIRECTION((${Math.cos(a).toFixed(9)},${Math.sin(a).toFixed(9)},0.));\n#${AX}=IFCAXIS2PLACEMENT3D(#${P},#${Z},#${X});\n`;
      txt = txt.replace(re, (m, parent) => `#${bp}=IFCLOCALPLACEMENT(${parent},#${AX});`);
      return txt.replace(/ENDSEC;\s*END-ISO-10303-21;\s*$/, extra + 'ENDSEC;\nEND-ISO-10303-21;\n');
    };
    const [a, m] = await Promise.all(['/tests/fixtures/office-architecture.ifc', '/tests/fixtures/office-mep.ifc'].map((u) => fetch(u).then((r) => r.text())));
    window.ClashControl.loadFiles([new File([deg ? rot(a) : a], 'office-architecture.ifc'), new File([deg ? rot(m) : m], 'office-mep.ifc')]);
  }, deg);
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && s.models.length === 2 && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false; }, null, { timeout: 120_000 });
}

// For each axis section: frame angle, plane normal/constant, and the share of
// horizontal wall-edge length running parallel/perpendicular to the plane.
async function measure(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const axis of ['x', 'z', 'y']) {
      window._ccDispatch({ t: 'SECTION', axis, pos: 0.5 });
      await new Promise((r) => setTimeout(r, 400));
      const fr = window._ccPlanFrame(), pl = window._ccActivePlanes[0];
      const n = [pl.normal.x, pl.normal.y, pl.normal.z];
      let tot = 0, aligned = 0;
      window._ccLatestState.models.forEach((m) => m.elements.forEach((el) => {
        if (!/Wall/.test((el.props && el.props.ifcType) || '')) return;
        el.meshes.forEach((me) => {
          const p = me.geometry.attributes.position, ix = me.geometry.index, e = me.matrixWorld.elements;
          me.updateWorldMatrix(true, false);
          const v = (i) => { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); return [e[0]*x+e[4]*y+e[8]*z+e[12], e[1]*x+e[5]*y+e[9]*z+e[13], e[2]*x+e[6]*y+e[10]*z+e[14]]; };
          const cnt = ix ? ix.count : p.count;
          for (let i = 0; i + 2 < cnt; i += 3) {
            const t = [0, 1, 2].map((k) => v(ix ? ix.getX(i + k) : i + k));
            for (let k = 0; k < 3; k++) {
              const A = t[k], B = t[(k + 1) % 3], dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
              const h = Math.hypot(dx, dz); if (h < 0.3 || Math.abs(dy) > 0.02 * h) continue;
              const c = Math.abs((dx * n[0] + dz * n[2]) / h);
              tot += h; if (c > 0.9999 || c < 0.0141) aligned += h;
            }
          }
        });
      }));
      const box = window._ccElemsBBox();
      out[axis] = { angle: fr.angle * 180 / Math.PI, n, constant: pl.constant, wallAligned: aligned / tot,
        ext: [fr.max.x - fr.min.x, fr.max.y - fr.min.y, fr.max.z - fr.min.z],
        worldCut: box.min[axis] + 0.5 * (box.max[axis] - box.min[axis]) };
    }
    window._ccDispatch({ t: 'SECTION', axis: null });
    out.box = window._ccModelSectionBoxSpec();
    return out;
  });
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
try {
  const p0 = await newPage(); await loadOffice(p0, 0); const r0 = await measure(p0); await p0.close();
  const p23 = await newPage(); await loadOffice(p23, 23); const r23 = await measure(p23); await p23.close();

  // Unrotated model: exactly the old world-axis behaviour.
  for (const ax of ['x', 'z', 'y']) {
    if (r0[ax].angle !== 0) fail(`axis-aligned model got plan angle ${r0[ax].angle}`);
    const want = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[ax];
    if (!r0[ax].n.every((c, i) => near(c, want[i], 1e-12))) fail(`0 deg ${ax}: normal ${r0[ax].n} != ${want}`);
    if (!near(r0[ax].constant, r0[ax].worldCut, 1e-9)) fail(`0 deg ${ax}: plane constant ${r0[ax].constant} != world cut ${r0[ax].worldCut}`);
  }
  if (r0.box && r0.box.rotation) fail('0 deg: whole-model section box must not be rotated');
  console.log('ALIGN OK — axis-aligned model: world-axis planes unchanged, box unrotated');

  // Rotated model: planes follow the building grid.
  if (!near(r23.x.angle, 23, 0.05)) fail(`rotated model: plan angle ${r23.x.angle}, expected 23`);
  for (const ax of ['x', 'z']) {
    if (!near(r23[ax].wallAligned, r0[ax].wallAligned, 1e-3)) fail(`23 deg ${ax}: wall alignment ${r23[ax].wallAligned} vs unrotated ${r0[ax].wallAligned}`);
  }
  if (!r23.x.ext.every((e, i) => near(e, r0.x.ext[i], 0.01))) fail(`23 deg: frame extents ${r23.x.ext} vs unrotated ${r0.x.ext} (outline must hug the footprint)`);
  if (!r23.box || !near(r23.box.rotation * 180 / Math.PI, 23, 0.05)) fail(`23 deg: whole-model section box rotation ${r23.box && r23.box.rotation}`);
  console.log(`ALIGN OK — rotated model: angle ${r23.x.angle.toFixed(3)} deg, walls aligned ${r23.x.wallAligned.toFixed(4)} (= unrotated ${r0.x.wallAligned.toFixed(4)}), extents ${r23.x.ext.map((e) => e.toFixed(2)).join('x')}, section box rotated`);

  if (errors.length) fail('page errors: ' + JSON.stringify(errors.slice(0, 5)));
} catch (e) { fail(String(e && e.stack || e)); }
await browser.close(); server.close();
console.log(allOk ? 'SECTION ALIGN OK' : 'SECTION ALIGN FAILED');
process.exit(allOk ? 0 : 1);
