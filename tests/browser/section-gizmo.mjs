// Section plane / section box gizmos on synthetic fixtures (two scales):
//  * exactly ONE plane gizmo; its origin is the outline centre and lies ON
//    the clipping plane (not beside or above the cut);
//  * the outline is the model at the cut: every triangle/plane intersection
//    point lies inside it, and it is at most 1.3x the cut's in-plane extent —
//    for the three axis planes and for a rotated plane picked off-centre;
//  * handles are screen-constant: same pixel size (±1 px) across three zoom
//    levels and both fixture scales;
//  * the section box has 6 face tabs (10–16 px) + 1 corner arc (24–32 px
//    radius) and nothing else (no corner spheres, stalk or fill panels);
//  * no hard-coded colour hex in the gizmo / section / measure-overlay code.
// Light + dark screenshots go to CC_SHOT_DIR (default: os tmpdir).
//
// Run:  CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 \
//       node tests/browser/section-gizmo.mjs
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { generateBuilding } = require('../fixtures/generate-building-ifc.js');

const root = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = process.env.CC_SHOT_DIR || join(tmpdir(), 'cc-section-gizmo');
await mkdir(SHOTS, { recursive: true });
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};

let allOk = true;
function fail(msg) { console.error('SECTION GIZMO FAIL: ' + msg); allOk = false; }

// ── Static check: no hard-coded colours in the gizmo / section / measure code ──
{
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const core = readFileSync(join(root, 'viewer-gizmo-core.js'), 'utf8');
  const slice = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) { fail(`marker missing: ${a} / ${b}`); return ''; } return html.slice(i, j); };
  const regions = {
    'viewer-gizmo-core.js': core,
    '_sectionVisFit': slice('function _sectionVisFit(', 'return vis;'),
    'section plane effect': slice('if(s.sectionAxis) window._ccCurrentSection', '// ── Per-material clipping ──'),
    'section box gizmo': slice('// Box gizmo, built once per enable', 'S._sboxLayout(sb);'),
    'section box handlers': slice('function _sboxHudHide', 'var downPos = {x:0,y:0};'),
    'section plane handlers': slice('// ── Right-click drag to move section plane ──', '// ── Viewpoint capture/restore ──'),
    'floor-plan cut': slice('// Model-sized translucent cut sheet', 'S._cutPlaneHelper = cutGroup;'),
    'gizmo tick': slice('// Screen-constant gizmo handles', '// Lower resolution while moving'),
    'section cut lines': slice('function _buildSectionCutLines(', 'function _getSectionHatchWorker'),
  };
  for (const [name, src] of Object.entries(regions)) {
    const hex = src.match(/0x[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(/g);
    if (hex) fail(`${name}: hard-coded colour(s) ${[...new Set(hex)].join(', ')}`);
  }
  if (/0xb8533a/i.test(html)) fail('measure overlay still uses a hard-coded hex');
  if (/TransformControls/.test(html.slice(html.indexOf('function startApp')))) fail('TransformControls section gizmo still present');
  if (allOk) console.log('GIZMO OK — no hard-coded colours in ' + Object.keys(regions).length + ' gizmo/section regions');
}

const virtualFiles = new Map();
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (virtualFiles.has(urlPath)) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(virtualFiles.get(urlPath)); }
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// Two scales of the same seeded synthetic building (no planted clash strip):
// one bay / one storey, and the CI 3x2-bay two-storey block.
virtualFiles.set('/__fx/small.ifc', generateBuilding({ scale: '1x1x1', planted: false }).files.architecture);
virtualFiles.set('/__fx/building.ifc', generateBuilding({ scale: 'ci', planted: false }).files.architecture);

const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const errors = [];

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
    const local = async (route, file, contentType) => route.fulfill({
      status: 200, body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' },
    });
    const ctx = page.context();
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await ctx.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', (r) => local(r, 'three/' + new URL(r.request().url()).pathname.split('/three@0.180.0/')[1]));
    await ctx.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', (r) => {
      const suffix = new URL(r.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
      return local(r, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    });
    await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await ctx.route('https://gc.zgo.at/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.gz, null, { timeout: 60_000 });
  return page;
}

async function load(page, url) {
  await page.evaluate(async (url) => {
    const txt = await fetch(url).then((r) => r.text());
    window.ClashControl.loadFiles([new File([txt], 'fixture.ifc')]);
  }, url);
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && s.models.length === 1 && (s.models[0].elements || []).length > 0 && window._ccModelLoading === false; }, null, { timeout: 120_000 });
  await page.evaluate(() => document.querySelectorAll('[role=dialog] button[aria-label*="lose" i]').forEach((b) => b.click()));
}

// In-page helpers (installed once per page).
async function installHelpers(page) {
  await page.evaluate(() => {
    const T = window.THREE, S = window._ccState3d;
    const frames = (n) => new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const settle = async () => { window._ccInvalidate(4); await frames(4); };
    const vpH = () => S.renderer.domElement.clientHeight;
    // pixel length of a world segment of length L at p, perpendicular to the view
    const pxLen = (p, L) => {
      const up = new T.Vector3(0, 1, 0).applyQuaternion(S.camera.quaternion);
      const a = p.clone().addScaledVector(up, -L / 2).project(S.camera), b = p.clone().addScaledVector(up, L / 2).project(S.camera);
      return Math.hypot((b.x - a.x) / 2 * S.renderer.domElement.clientWidth, (b.y - a.y) / 2 * vpH());
    };
    // on-screen size of a camera-facing tab: its projected local square
    const tabPx = (tab) => {
      tab.updateWorldMatrix(true, false);
      const s = tab.userData.ccGizmo.sizePx / 2, w = S.renderer.domElement.clientWidth, h = vpH();
      const a = new T.Vector3(-s, -s, 0).applyMatrix4(tab.matrixWorld).project(S.camera);
      const b = new T.Vector3(s, s, 0).applyMatrix4(tab.matrixWorld).project(S.camera);
      return Math.max(Math.abs(b.x - a.x) / 2 * w, Math.abs(b.y - a.y) / 2 * h);
    };
    const zoomTo = async (k) => {
      const b = window._ccElemsBBox(), c = b.getCenter(new T.Vector3());
      S.orbit.target.copy(c); S.orbit.sph.theta = 0.7; S.orbit.sph.phi = 1.0;
      S.orbit.sph.r = b.getSize(new T.Vector3()).length() * k; S.orbit.apply();
      await settle();
    };
    // Every triangle ∩ plane point of the model, in the outline's local frame.
    const cutPoints = (plane, vis) => {
      const inv = new T.Matrix4().copy(vis.matrixWorld).invert(), out = [];
      const va = new T.Vector3(), vb = new T.Vector3(), vc = new T.Vector3();
      const edge = (a, b) => {
        const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
        if (da * db < 0) out.push(a.clone().lerp(b, da / (da - db)).applyMatrix4(inv));
      };
      window._ccLatestState.models.forEach((m) => m.elements.forEach((el) => (el.meshes || []).forEach((me) => {
        const g = me.geometry, p = g.attributes.position, ix = g.index, n = ix ? ix.count : p.count;
        me.updateWorldMatrix(true, false);
        for (let i = 0; i + 2 < n; i += 3) {
          va.fromBufferAttribute(p, ix ? ix.getX(i) : i).applyMatrix4(me.matrixWorld);
          vb.fromBufferAttribute(p, ix ? ix.getX(i + 1) : i + 1).applyMatrix4(me.matrixWorld);
          vc.fromBufferAttribute(p, ix ? ix.getX(i + 2) : i + 2).applyMatrix4(me.matrixWorld);
          edge(va, vb); edge(vb, vc); edge(vc, va);
        }
      })));
      return out;
    };
    // Dispatch and wait until the section effects have consumed it (React
    // commits passive effects after a paint, which can take a while).
    const dispatch = async (...actions) => {
      const p0 = S._sectionPlanes, g0 = S._sboxGeom, h0 = S._sboxHelper, t0 = performance.now();
      actions.forEach((a) => window._ccDispatch(a));
      while (S._sectionPlanes === p0 && S._sboxGeom === g0 && S._sboxHelper === h0 && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 10));
      await settle();
    };
    window.__gz = { frames, settle, pxLen, tabPx, zoomTo, cutPoints, dispatch };
  });
}

// Checks one plane state already dispatched: returns a summary or problems.
async function checkPlane(page, label) {
  return page.evaluate(async (label) => {
    const T = window.THREE, S = window._ccState3d, H = window.__gz;
    await H.settle();
    const probs = [];
    const gizmos = S.scene.children.filter((o) => o.userData && o.userData._sectionPlane);
    let tc = 0; S.scene.traverse((o) => { if (/TransformControls/.test(o.type || '') || (o.userData && o.userData._isSectionTC)) tc++; });
    if (gizmos.length !== 1 || tc) probs.push(`${gizmos.length} plane gizmos, ${tc} TransformControls objects`);
    const vis = S._sectionPlaneVis, plane = window._ccActivePlanes[0];
    vis.updateWorldMatrix(true, true);
    const sheet = vis.children[0], arrow = vis.children[1];
    const so = sheet.getWorldPosition(new T.Vector3()), go = arrow.getWorldPosition(new T.Vector3());
    if (so.distanceTo(go) > 0.5) probs.push(`gizmo ${go.toArray()} is ${so.distanceTo(go).toFixed(3)} m from the outline centre`);
    if (Math.abs(plane.distanceToPoint(go)) > 1e-4) probs.push(`gizmo is ${plane.distanceToPoint(go).toFixed(4)} m off the clipping plane`);
    const n = new T.Vector3(0, 0, 1).applyQuaternion(vis.quaternion);
    if (Math.abs(Math.abs(n.dot(plane.normal)) - 1) > 1e-6) probs.push('outline not parallel to the clipping plane');
    const hw = sheet.geometry.parameters.width / 2, hh = sheet.geometry.parameters.height / 2;
    const pts = H.cutPoints(plane, vis);
    if (!pts.length) probs.push('no geometry at the cut');
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], outside = 0;
    pts.forEach((p) => {
      lo = [Math.min(lo[0], p.x), Math.min(lo[1], p.y)]; hi = [Math.max(hi[0], p.x), Math.max(hi[1], p.y)];
      if (Math.abs(p.x) > hw + 1e-4 || Math.abs(p.y) > hh + 1e-4) outside++;
    });
    if (outside) probs.push(`${outside}/${pts.length} cut points outside the outline`);
    const ext = [hi[0] - lo[0], hi[1] - lo[1]];
    const ratio = [2 * hw / ext[0], 2 * hh / ext[1]];
    if (ratio.some((r) => !(r <= 1.3 + 1e-6))) probs.push(`outline ${(2 * hw).toFixed(2)} x ${(2 * hh).toFixed(2)} is ${ratio.map((r) => r.toFixed(3)).join(' / ')} x the cut ${ext.map((e) => e.toFixed(2)).join(' x ')}`);
    return { label, probs, ratio, pts: pts.length, outline: [2 * hw, 2 * hh] };
  }, label);
}

const handlePx = {}; // fixture -> [arrow px, tab px, arc px] per zoom
try {
  for (const fx of ['small', 'building']) {
    const page = await newPage();
    await load(page, `/__fx/${fx}.ifc`);
    await installHelpers(page);

    // Axis planes at three positions each.
    for (const axis of ['x', 'y', 'z']) {
      for (const pos of [0.3, 0.55, 0.8]) {
        await page.evaluate(([axis, pos]) => window.__gz.dispatch({ t: 'SECTION', axis, pos }), [axis, pos]);
        const r = await checkPlane(page, `${fx} ${axis}@${pos}`);
        r.probs.forEach((p) => fail(`${r.label}: ${p}`));
        if (!r.probs.length && pos === 0.55) console.log(`GIZMO OK — ${r.label}: one gizmo at the cut, ${r.pts} cut points inside, outline/cut ${r.ratio.map((x) => x.toFixed(3)).join(' / ')}`);
      }
    }
    // A rotated plane picked off-centre (a third of the way in, 30 deg from x).
    await page.evaluate(() => {
      const b = window._ccElemsBBox(), a = Math.PI / 6;
      const p = [b.min.x + (b.max.x - b.min.x) * 0.33, b.min.y + (b.max.y - b.min.y) * 0.7, b.min.z + (b.max.z - b.min.z) * 0.3];
      return window.__gz.dispatch({ t: 'SECTION_CUSTOM', v: { normal: [Math.cos(a), 0, Math.sin(a)], point: p }, pos: 0.5 });
    });
    {
      const r = await checkPlane(page, `${fx} picked plane`);
      r.probs.forEach((p) => fail(`${r.label}: ${p}`));
      if (!r.probs.length) console.log(`GIZMO OK — ${r.label}: centred on the cut, ${r.pts} cut points inside, outline/cut ${r.ratio.map((x) => x.toFixed(3)).join(' / ')}`);
    }
    // Live drag keeps plane, outline and gizmo together (imperative path).
    await page.evaluate(() => window.__gz.dispatch({ t: 'SECTION', axis: 'x', pos: 0.5 }));
    const sizes = [];
    for (const k of [0.6, 1.5, 4]) {
      await page.evaluate((k) => window.__gz.zoomTo(k), k);
      sizes.push(await page.evaluate(() => {
        const S = window._ccState3d, g = S._sectionPlaneVis.children[1];
        return window.__gz.pxLen(g.getWorldPosition(new window.THREE.Vector3()), g.userData.ccGizmo.spanPx * g.scale.x);
      }));
    }
    // Section box: whole model.
    await page.evaluate(() => window.__gz.dispatch({ t: 'SECTION_BOX', v: window._ccModelSectionBoxSpec() }));
    const boxSizes = [];
    for (const k of [0.6, 1.5, 4]) {
      await page.evaluate((k) => window.__gz.zoomTo(k), k);
      boxSizes.push(await page.evaluate(() => {
        const S = window._ccState3d, T = window.THREE;
        const parts = { spheres: 0, panels: 0 };
        S.scene.children.forEach((o) => { if (o.geometry && o.geometry.type === 'SphereGeometry' && o.userData._sboxHandle) parts.spheres++; if (o.userData && o.userData._sboxPart && o.isMesh) parts.panels++; });
        const tabs = (S._sboxFaceHandles || []).map((t) => window.__gz.tabPx(t));
        const arc = S._sboxRotRing;
        const arcPx = arc ? window.__gz.pxLen(arc.getWorldPosition(new T.Vector3()), arc.userData.ccGizmo.radiusPx * arc.scale.x) : 0;
        return { tabs, arcPx, parts, arcs: S.scene.children.filter((o) => o.userData && o.userData._sboxRotation).length };
      }));
    }
    for (const b of boxSizes) {
      if (b.tabs.length !== 6 || b.arcs !== 1) fail(`${fx}: box has ${b.tabs.length} tabs and ${b.arcs} arcs`);
      if (b.parts.spheres || b.parts.panels) fail(`${fx}: box still has ${b.parts.spheres} corner spheres / ${b.parts.panels} fill panels`);
      b.tabs.forEach((px) => { if (px < 10 || px > 16) fail(`${fx}: tab ${px.toFixed(2)} px (want 10–16)`); });
      if (b.arcPx < 24 || b.arcPx > 32) fail(`${fx}: arc radius ${b.arcPx.toFixed(2)} px (want 24–32)`);
    }
    handlePx[fx] = sizes.map((a, i) => [a, boxSizes[i].tabs[0], boxSizes[i].arcPx]);
    // Box + plane together clip with both; turning the box off hands
    // clipping straight back to the plane (model materials and the click
    // filter), without waiting for the plane to change.
    const clip = await page.evaluate(async () => {
      const S = window._ccState3d;
      const count = (want) => { let n = 0, bad = 0; S.mg.traverse((o) => {
        if (!o.isMesh || !o.material || (o.userData.expressId == null && !o.isInstancedMesh && !o.userData._isCCBatch)) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { n++; if ((m.clippingPlanes || []).length !== want) bad++; });
      }); return { n, bad, active: (window._ccActivePlanes || []).length }; };
      await window.__gz.dispatch({ t: 'SECTION', axis: 'x', pos: 0.5 });
      const both = count(7);
      await window.__gz.dispatch({ t: 'SECTION_BOX', v: { enabled: false } });
      const plane = count(1);
      await window.__gz.dispatch({ t: 'SECTION_BOX', v: window._ccModelSectionBoxSpec() });
      return { both, plane };
    });
    if (!clip.both.n || clip.both.bad || clip.both.active !== 7) fail(`${fx}: box + plane: ${clip.both.bad}/${clip.both.n} materials (and ${clip.both.active} active planes) not clipped by both`);
    else if (clip.plane.bad || clip.plane.active !== 1) fail(`${fx}: box off with a plane active left ${clip.plane.bad}/${clip.plane.n} materials (and ${clip.plane.active} active planes) not clipped by the plane alone`);
    else console.log(`GIZMO OK — ${fx}: box + plane clip together; box off hands clipping back to the plane`);

    // Real pointer interaction: hover paints --accent, drag moves a box face /
    // the plane, release returns to idle; rotating keeps the gizmo on the plane.
    if (fx === 'small') {
      await page.evaluate(() => window.__gz.zoomTo(1.5));
      const screenOf = (expr) => page.evaluate((expr) => {
        const S = window._ccState3d, o = eval(expr), r = S.renderer.domElement.getBoundingClientRect();
        const p = o.getWorldPosition(new window.THREE.Vector3()).project(S.camera);
        return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
      }, expr);
      const colorOf = (expr) => page.evaluate((expr) => { const o = eval(expr); return '#' + o.material.color.getHexString(); }, expr);
      const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase());
      const TAB = 'window._ccState3d._sboxFaceHandles[2]'; // +Y (top) tab
      const t = await screenOf(TAB);
      await page.mouse.move(t.x, t.y); await page.waitForTimeout(50);
      if (await colorOf(TAB + '.children[0]') !== accent) fail('hovered box tab stroke is not --accent');
      const maxY0 = await page.evaluate(() => window._ccLatestState.sectionBox.max[1]);
      await page.mouse.down(); await page.mouse.move(t.x, t.y + 40, { steps: 4 });
      if (await colorOf(TAB) !== accent) fail('dragged box tab is not solid --accent');
      await page.mouse.up();
      const maxY1 = await page.evaluate(() => window._ccLatestState.sectionBox.max[1]);
      if (!(maxY1 < maxY0 - 0.05)) fail(`dragging the top tab down did not lower the box top (${maxY0} -> ${maxY1})`);
      else console.log(`GIZMO OK — box tab hover/active = --accent, drag lowered the top ${(maxY0 - maxY1).toFixed(2)} m`);
      await page.evaluate(() => window.__gz.dispatch({ t: 'SECTION_BOX', v: { enabled: false } }, { t: 'SECTION', axis: 'x', pos: 0.5 }));
      const ARROW = 'window._ccState3d._sectionPlaneVis._secDragHandles[0]';
      const a = await page.evaluate(() => {
        const S = window._ccState3d, g = S._sectionPlaneVis, T = window.THREE, r = S.renderer.domElement.getBoundingClientRect();
        const p = new T.Vector3(0, 0, 30).applyMatrix4(g.children[1].matrixWorld).project(S.camera); // along the shaft
        return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
      });
      await page.mouse.move(a.x, a.y); await page.waitForTimeout(50);
      if (await colorOf(ARROW + '.children[0]') !== accent) fail('hovered plane arrow is not --accent');
      const pos0 = await page.evaluate(() => window._ccLatestState.sectionPos);
      await page.mouse.down(); await page.mouse.move(a.x + 60, a.y, { steps: 5 });
      const mid = await page.evaluate(() => { const S = window._ccState3d, pl = window._ccActivePlanes[0]; return Math.abs(pl.distanceToPoint(S._sectionPlaneVis.position)); });
      await page.mouse.up(); await page.waitForTimeout(300);
      const pos1 = await page.evaluate(() => window._ccLatestState.sectionPos);
      if (mid > 1e-4) fail(`during the drag the gizmo left the plane by ${mid}`);
      if (Math.abs(pos1 - pos0) < 0.01) fail(`dragging the plane arrow did not move the cut (${pos0} -> ${pos1})`);
      else console.log(`GIZMO OK — plane arrow drag moved the cut ${pos0.toFixed(2)} -> ${pos1.toFixed(2)}, gizmo stayed on the plane`);
      await page.evaluate(() => window.__gz.settle());
      const before = await page.evaluate(() => window._ccState3d._sectionPlaneVis.position.toArray());
      // grab the ring on its rim: try a few points around it
      let grabbed = false;
      for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const px = await page.evaluate(([ang]) => {
          const S = window._ccState3d, g = S._sectionPlaneVis._secRotRing, T = window.THREE, r = S.renderer.domElement.getBoundingClientRect();
          const p = new T.Vector3(Math.cos(ang) * 11, Math.sin(ang) * 11, 0).applyMatrix4(g.matrixWorld).project(S.camera);
          return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
        }, [ang]);
        await page.mouse.move(px.x, px.y); await page.waitForTimeout(30);
        if (await page.evaluate(() => window._ccState3d.renderer.domElement.style.cursor) === 'crosshair') {
          await page.mouse.down(); await page.mouse.move(px.x + 80, px.y, { steps: 5 }); await page.mouse.up(); grabbed = true; break;
        }
      }
      await page.waitForTimeout(300);
      const rot = await page.evaluate(() => {
        const s = window._ccLatestState, S = window._ccState3d, pl = window._ccActivePlanes[0];
        return { custom: !!s.sectionCustom, onPlane: Math.abs(pl.distanceToPoint(S._sectionPlaneVis.position)), pos: S._sectionPlaneVis.position.toArray() };
      });
      const moved = Math.hypot(...rot.pos.map((v, i) => v - before[i]));
      if (!grabbed) fail('could not grab the rotate ring');
      else if (!rot.custom || rot.onPlane > 1e-4 || moved > 0.5) fail(`rotating: custom=${rot.custom}, gizmo ${rot.onPlane} off the plane, moved ${moved.toFixed(3)} m`);
      else console.log(`GIZMO OK — ring rotation keeps the gizmo on the plane (moved ${moved.toFixed(3)} m)`);
    }

    // Screenshots: plane + box, light and dark.
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window._ccDispatch({ t: 'UPD_PREFS', u: { theme } }), theme);
      await page.evaluate(() => window.__gz.dispatch({ t: 'SECTION_BOX', v: { enabled: false } }, { t: 'SECTION', axis: 'x', pos: 0.45 }));
      await page.evaluate(() => window.__gz.zoomTo(1.3));
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, `${fx}-plane-${theme}.png`) });
      await page.evaluate(() => window.__gz.dispatch({ t: 'SECTION_BOX', v: window._ccModelSectionBoxSpec() }));
      await page.evaluate(() => window.__gz.zoomTo(1.3));
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, `${fx}-box-${theme}.png`) });
      // the theme change repainted the gizmo from the tokens
      const ok = await page.evaluate(() => {
        const S = window._ccState3d, tab = S._sboxFaceHandles[0];
        const want = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase();
        return '#' + tab.material.color.getHexString() === want ? null : `${'#' + tab.material.color.getHexString()} != ${want}`;
      });
      if (ok) fail(`${fx} ${theme}: tab colour not repainted from --accent: ${ok}`);
    }
    await page.close();
  }
  // Screen-constant: every handle within ±1 px of itself across zooms and fixtures.
  for (let h = 0; h < 3; h++) {
    const all = Object.values(handlePx).flatMap((rows) => rows.map((r) => r[h]));
    const spread = Math.max(...all) - Math.min(...all);
    const name = ['plane arrow', 'box tab', 'box arc'][h];
    if (!(spread <= 1)) fail(`${name}: ${all.map((v) => v.toFixed(2)).join(', ')} px across zooms/fixtures (spread ${spread.toFixed(2)})`);
    else console.log(`GIZMO OK — ${name} ${all[0].toFixed(1)} px (spread ${spread.toFixed(2)} px over 3 zooms x 2 fixture scales)`);
  }
  if (errors.length) fail('page errors: ' + JSON.stringify(errors.slice(0, 5)));
} catch (e) { fail(String(e && e.stack || e)); }
await browser.close(); server.close();
console.log('screenshots: ' + SHOTS);
console.log(allOk ? 'SECTION GIZMO OK' : 'SECTION GIZMO FAILED');
process.exit(allOk ? 0 : 1);
