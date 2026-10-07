// Occlusion probe (measurement only, changes no app code).
//
// For each view it reports:
//   submitted — renderer.info.render.triangles of the app's own normal frame
//   modelSubmitted — triangles of model meshes that were visible for that frame
//   visibleTris — triangles of elements that write >= 1 pixel, found by
//                 rendering element ids into an offscreen target once and
//                 counting the ids present (same camera, same visibility,
//                 same size as the canvas)
//   ratio — visibleTris / modelSubmitted
//
// Run:
//   CC_CHROMIUM_EXECUTABLE=/path/to/chromium CC_BROWSER_OFFLINE_DEPS=1 \
//   [CC_PROBE_FILE=/abs/path/model.ifc | CC_PROBE_FILES=a.ifc,b.ifc] \
//   [CC_PROBE_W=1920 CC_PROBE_H=1080] node tests/browser/occlusion-probe.mjs [out.json]
//
// Default fixtures: tests/fixtures/office-architecture.ifc + office-mep.ifc.
// Only the measurement is pixel-exact; timings under SwiftShader (software GL)
// say nothing about a real GPU, the triangle ratios do not depend on the GPU.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = process.env.CC_REPO_ROOT || fileURLToPath(new URL('../..', import.meta.url));
const W = Number(process.env.CC_PROBE_W || 1280), H = Number(process.env.CC_PROBE_H || 720);
const files = process.env.CC_PROBE_FILES ? process.env.CC_PROBE_FILES.split(',')
  : process.env.CC_PROBE_FILE ? [process.env.CC_PROBE_FILE]
  : [join(root, 'tests/fixtures/office-architecture.ifc'), join(root, 'tests/fixtures/office-mep.ifc')];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const m = path.match(/^\/__probe__\/(\d+)$/);
    if (m) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(await readFile(files[+m[1]])); }
    const file = normalize(join(root, path === '/' ? 'index.html' : path.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8767, '127.0.0.1', r));

const executablePath = process.env.CC_CHROMIUM_EXECUTABLE;
if (!executablePath) throw new Error('CC_CHROMIUM_EXECUTABLE is required');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: W, height: H }, deviceScaleFactor: 1 });
if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
  const local = async (route, file, ct) => route.fulfill({ status: 200, body: await readFile(join(root, 'node_modules', file)), headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' } });
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
  await context.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', (r) => local(r, 'three/' + new URL(r.request().url()).pathname.split('/three@0.180.0/')[1]));
  await context.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', (r) => { const s = new URL(r.request().url()).pathname.split('/web-ifc@0.0.77/')[1]; return local(r, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); });
  await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  await context.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await context.route('https://gc.zgo.at/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
}
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://127.0.0.1:8767/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });

await page.evaluate(async (n) => {
  const fs = [];
  for (let i = 0; i < n; i++) fs.push(new File([await (await fetch('/__probe__/' + i)).arrayBuffer()], 'probe-' + i + '.ifc'));
  window.ClashControl.loadFiles(fs);
}, files.length);
await page.waitForFunction((n) => { const s = window._ccLatestState; return s && s.models.length === n && s.models.every((m) => (m.elements || []).length >= 2); }, files.length, { timeout: 600_000 });
await page.waitForFunction(() => window._ccModelLoading === false, null, { timeout: 600_000 });

// Everything below runs in the page. `view` positions the camera, forces a
// cull pass + normal frame, then renders the id pass and counts.
async function measure(view) {
  const S = window._ccState3d, THREE = window.THREE, renderer = S.renderer, scene = S.scene;
  const b = window._ccViewport.getBounds();
  const c = b.center, sz = b.size;
  const setView = (pos, tgt) => { S.camera.position.set(pos[0], pos[1], pos[2]); S.orbit.target.set(tgt[0], tgt[1], tgt[2]); S.orbit.sync(); S.orbit.apply(); };
  if (view.kind === 'opening') {
    // Same framing the app uses after load: let the app fit, then wait it out.
    window._ccViewport.fitAll(1.0);
    await new Promise((r) => setTimeout(r, 2500));
  } else {
    // Interior: eye height 1.6 m above the model's lowest point, looking along a compass direction.
    const eyeY = b.min[1] + 1.6, ang = view.angle;
    const px = c[0] + (view.offset || [0, 0])[0] * sz[0], pz = c[2] + (view.offset || [0, 0])[1] * sz[2];
    setView([px, eyeY, pz], [px + Math.cos(ang) * 3, eyeY, pz + Math.sin(ang) * 3]);
  }
  // Force a fresh cull pass and a normal frame through the app's own tick().
  S._forceCull = true; S._lastCullCamKey = '';
  window._ccViewport.pan(0, 0, 0);
  for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
  S.camera.updateMatrixWorld(true);

  // Normal frame, counted by Three itself (autoReset clears at each render()).
  renderer.render(scene, S.camera);
  const submitted = renderer.info.render.triangles, calls = renderer.info.render.calls;

  const visibleChain = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  // Build id table and per-element triangle counts, only for what the frame drew.
  const table = [];               // id -> {eid, tris}
  const jobs = [];                // {obj, base}
  let modelSubmitted = 0, modelObjects = 0;
  const kinds = { mesh: 0, instanced: 0, batched: 0 };
  S.mg.traverse((o) => {
    if (!o.isMesh || !visibleChain(o)) return;
    const g = o.geometry; if (!g || !g.attributes.position) return;
    const triOf = (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    if (o.isBatchedMesh) {
      const base = table.length, ids = o.userData.batchExprIds || [];
      kinds.batched++;
      for (let i = 0; i < o.instanceCount; i++) {
        let vis = true; try { vis = o.getVisibleAt(i); } catch (_) {}
        let t = 0; try { const gi = o.getGeometryIdAt(i); const r = o.getGeometryRangeAt(gi); t = (r.count !== undefined ? r.count : r.indexCount || 0) / 3; } catch (_) {}
        table.push({ eid: ids[i], tris: vis ? t : 0, batch: true });
        if (vis) modelSubmitted += t;
      }
      jobs.push({ obj: o, base }); modelObjects++;
    } else if (o.isInstancedMesh) {
      const base = table.length, ids = o.userData.instanceExprIds || [], t = triOf(g);
      kinds.instanced++;
      for (let i = 0; i < o.count; i++) { table.push({ eid: ids[i], tris: t }); modelSubmitted += t; }
      jobs.push({ obj: o, base }); modelObjects++;
    } else if (o.userData.expressId != null || o.userData._instanceRef == null) {
      const t = triOf(g); kinds.mesh++;
      jobs.push({ obj: o, base: table.length }); table.push({ eid: o.userData.expressId, tris: t }); modelSubmitted += t; modelObjects++;
    }
  });

  // ID pass. One shader for all three object kinds; the id is derived per
  // vertex (flat colour per instance) and written raw (no tone mapping).
  const vs = `
    #include <common>
    #include <batching_pars_vertex>
    uniform float uBase; varying vec3 vId;
    void main(){
      float id = uBase;
      #ifdef USE_INSTANCING
        id += float(gl_InstanceID);
      #endif
      #ifdef USE_BATCHING
        id += float(int(getIndirectIndex(gl_DrawID)));
      #endif
      id += 1.0;
      vId = vec3(mod(id,256.0), mod(floor(id/256.0),256.0), floor(id/65536.0)) / 255.0;
      vec3 transformed = position;
      #ifdef USE_BATCHING
        mat4 batchingMatrix = getBatchingMatrix( getIndirectIndex( gl_DrawID ) );
        transformed = (batchingMatrix * vec4(transformed,1.0)).xyz;
      #endif
      vec4 mv = vec4(transformed,1.0);
      #ifdef USE_INSTANCING
        mv = instanceMatrix * mv;
      #endif
      gl_Position = projectionMatrix * modelViewMatrix * mv;
    }`;
  const fs = 'varying vec3 vId; void main(){ gl_FragColor = vec4(vId,1.0); }';
  const swapped = [];
  for (const j of jobs) {
    const m = new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { uBase: { value: j.base } }, side: THREE.DoubleSide });
    swapped.push({ o: j.obj, mat: j.obj.material }); j.obj.material = m;
  }
  const hidden = [];
  scene.children.forEach((ch) => { if (ch !== S.mg && ch.visible) { ch.visible = false; hidden.push(ch); } });
  // Meshes the app did not draw (frustum/LOD culled, ghosted-out) stay hidden because we only swapped the drawn ones;
  // every other model object keeps .visible as-is, which is false for exactly the culled ones.
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, samples: 0 });
  const oldBg = scene.background, oldTarget = renderer.getRenderTarget(), oldFog = scene.fog, oldTM = renderer.toneMapping;
  scene.background = null; scene.fog = null; renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, S.camera);
  const buf = new Uint8Array(size.x * size.y * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size.x, size.y, buf);
  renderer.setRenderTarget(oldTarget); rt.dispose(); scene.background = oldBg; scene.fog = oldFog; renderer.toneMapping = oldTM;
  swapped.forEach((s) => { s.o.material.dispose(); s.o.material = s.mat; });
  hidden.forEach((ch) => { ch.visible = true; });

  const seen = new Set();
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] === 0) continue;
    const id = buf[i] + buf[i + 1] * 256 + buf[i + 2] * 65536 - 1;
    if (id >= 0 && id < table.length) seen.add(id);
  }
  let visibleTris = 0, visibleElems = 0;
  seen.forEach((id) => { visibleTris += table[id].tris; visibleElems++; });
  const drawnElems = table.filter((t) => t.tris > 0).length;
  window._ccViewport.pan(0, 0, 0);
  return { view: view.name, canvas: size.x + 'x' + size.y, submittedTriangles: submitted, drawCalls: calls, modelSubmittedTriangles: modelSubmitted, drawnElements: drawnElems, objectKinds: kinds, pixelsCovered: (() => { let n = 0; for (let i = 3; i < buf.length; i += 4) if (buf[i]) n++; return n; })(), visibleElements: visibleElems, visibleTriangles: visibleTris, triangleRatio: modelSubmitted ? +(visibleTris / modelSubmitted).toFixed(4) : null, elementRatio: drawnElems ? +(visibleElems / drawnElems).toFixed(4) : null };
}

const views = [
  { name: 'opening (fitAll)', kind: 'opening' },
  { name: 'interior, centre, looking +X', kind: 'interior', angle: 0 },
  { name: 'interior, centre, looking +Z', kind: 'interior', angle: Math.PI / 2 },
  { name: 'interior, centre, looking -X', kind: 'interior', angle: Math.PI },
  { name: 'interior, offset (-.25,-.25), looking +X', kind: 'interior', angle: 0, offset: [-0.25, -0.25] },
  { name: 'interior, offset (+.25,+.25), looking -Z', kind: 'interior', angle: -Math.PI / 2, offset: [0.25, 0.25] },
];
const info = await page.evaluate(() => {
  const gl = window._ccState3d.renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const s = window._ccLatestState;
  return { webgl: gl.constructor.name, gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '', userAgent: navigator.userAgent, models: s.models.map((m) => ({ name: m.name, elements: (m.elements || []).length })) };
});
const results = [];
for (const v of views) results.push(await page.evaluate(measure, v));
const out = { generatedAt: new Date().toISOString(), node: process.version, files: files.map((f) => basename(f)), canvas: W + 'x' + H, ...info, errors, results };
await browser.close(); server.close();
const json = JSON.stringify(out, null, 2) + '\n';
if (process.argv[2]) await writeFile(process.argv[2], json);
console.log(json);
