// View cube + orbit feedback:
//  - pressing / dragging in the viewer shows no pivot dot (removed on request);
//  - the cube has no 90-degree arrow buttons around it;
//  - ONE click on a side of the cube turns the camera square to that side
//    (exact face-on view, never a 45-degree edge/corner view);
//  - looking straight at a face, its edge-on neighbours are reached through
//    the border band of the face you're looking at.
//
// Run:  CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 \
//       node tests/browser/viewcube-click.mjs
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
function fail(msg) { console.error('VIEWCUBE FAIL: ' + msg); allOk = false; }

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


async function loadOffice(page) {
  await page.evaluate(async () => {
    const files = await Promise.all(['/tests/fixtures/office-architecture.ifc', '/tests/fixtures/office-mep.ifc']
      .map((u) => fetch(u).then((r) => r.text()).then((t) => new File([t], u.split('/').pop()))));
    window.ClashControl.loadFiles(files);
  });
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && s.models.length === 2 && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false; }, null, { timeout: 120_000 });
}

// Camera direction (target -> camera), unit length.
const viewDir = (page) => page.evaluate(() => {
  const S = window._ccState3d, c = S.camera.position, t = S.orbit.target;
  const d = [c.x - t.x, c.y - t.y, c.z - t.z], l = Math.hypot(...d);
  return d.map((v) => v / l);
});
const NORMAL = { FRONT: [0, 0, 1], BACK: [0, 0, -1], RIGHT: [1, 0, 0], LEFT: [-1, 0, 0], TOP: [0, 1, 0], BOTTOM: [0, -1, 0] };
const faceOn = (d, face) => { const n = NORMAL[face]; return d[0] * n[0] + d[1] * n[1] + d[2] * n[2] > 1 - 1e-6; };

// Hover a grid over the cube canvas; return {label -> [points]} from its tooltip.
async function scanCube(page) {
  const box = await page.locator('.cc-viewcube-wrap canvas').boundingBox();
  const out = {};
  for (let gy = 0.06; gy < 0.95; gy += 0.04) for (let gx = 0.06; gx < 0.95; gx += 0.04) {
    const x = box.x + gx * box.width, y = box.y + gy * box.height;
    await page.mouse.move(x, y);
    const t = await page.locator('.cc-viewcube-wrap canvas').getAttribute('title');
    const m = t && t.match(/(FRONT|BACK|RIGHT|LEFT|TOP|BOTTOM)/);
    if (m) (out[m[1]] = out[m[1]] || []).push([x, y]);
  }
  await page.mouse.move(box.x - 40, box.y + box.height + 40);
  return out;
}
async function clickAndSettle(page, [x, y]) {
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(800); // flyToDir animates for 550 ms
}
async function setView(page, theta, phi) {
  await page.evaluate(([th, ph]) => { const o = window._ccState3d.orbit; o.sph.theta = th; o.sph.phi = ph; o.apply(); window._ccInvalidate(5); }, [theta, phi]);
  await page.waitForTimeout(200);
}

try {
  const page = await newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await loadOffice(page);
  await page.evaluate(() => window._ccDispatch({ t: 'INSPECTOR_OPEN', v: false }));

  // 1. No pivot dot on press, drag, or click.
  const canvas = page.locator('canvas[aria-label="Interactive 3D model viewer"]');
  const cb = await canvas.boundingBox();
  const fixedDots = () => page.evaluate(() => [...document.body.querySelectorAll('div')].filter((d) => {
    const cs = getComputedStyle(d); return cs.position === 'fixed' && cs.display !== 'none' && cs.borderRadius === '50%' && d.offsetWidth <= 16;
  }).length);
  const cx = cb.x + cb.width * 0.4, cy = cb.y + cb.height * 0.5;
  await page.mouse.move(cx, cy); await page.mouse.down();
  const onPress = await fixedDots();
  await page.mouse.move(cx + 60, cy + 10, { steps: 6 });
  const onDrag = await fixedDots();
  await page.mouse.up();
  if (onPress || onDrag) fail(`pivot dot visible (press ${onPress}, drag ${onDrag})`);
  else console.log('PIVOT OK — no dot on press or while rotating');

  // 2. No arrow buttons around the cube.
  const nBtn = await page.locator('.cc-viewcube-wrap button').count();
  if (nBtn) fail(`view cube still has ${nBtn} buttons around it`);
  else console.log('ARROWS OK — no buttons around the view cube');

  // 3. Oblique view: every visible side, one click -> exact square view.
  await setView(page, 0.7, 1.0);
  const seen = await scanCube(page);
  const obliqueFaces = Object.keys(seen);
  if (obliqueFaces.length < 3) fail(`oblique view: expected 3 clickable sides, got ${obliqueFaces}`);
  for (const face of obliqueFaces) {
    await setView(page, 0.7, 1.0);
    const pts = seen[face]; await clickAndSettle(page, pts[Math.floor(pts.length / 2)]);
    const d = await viewDir(page);
    if (!faceOn(d, face)) fail(`oblique click on ${face}: view ${d.map((v) => v.toFixed(4))} not square to ${face}`);
  }
  console.log(`CLICK OK — oblique view, one click on ${obliqueFaces.join('/')} gives an exact square view of that side`);

  // 4. Head-on (TOP): the border band reaches the four edge-on sides.
  const topPts = seen.TOP || [];
  await setView(page, 0.7, 1.0); await clickAndSettle(page, topPts[Math.floor(topPts.length / 2)]);
  if (!faceOn(await viewDir(page), 'TOP')) fail('could not reach TOP view');
  const fromTop = await scanCube(page);
  const sides = ['FRONT', 'BACK', 'LEFT', 'RIGHT'].filter((f) => fromTop[f]);
  if (sides.length !== 4) fail(`TOP view: border band reaches ${sides}, expected all 4 sides`);
  if (!fromTop.TOP) fail('TOP view: centre of the face no longer targets TOP');
  for (const face of sides) {
    await setView(page, 0.7, 1.0); await clickAndSettle(page, topPts[Math.floor(topPts.length / 2)]);
    await clickAndSettle(page, fromTop[face][0]);
    const d = await viewDir(page);
    if (!faceOn(d, face)) fail(`TOP view border click toward ${face}: view ${d.map((v) => v.toFixed(4))}`);
  }
  console.log('CLICK OK — from TOP, one click on the border band gives FRONT/BACK/LEFT/RIGHT square views');
  await page.close();
  if (errors.length) fail('page errors: ' + JSON.stringify(errors.slice(0, 5)));
} catch (e) { fail(String(e && e.stack || e)); }
await browser.close(); server.close();
console.log(allOk ? 'VIEWCUBE OK' : 'VIEWCUBE FAILED');
process.exit(allOk ? 0 : 1);
