// BCF <ClippingPlanes> export + import, end to end in the browser.
// Run:  CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/bcf-clipping.mjs
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
function fail(msg) { console.error('BCF CLIPPING FAIL: ' + msg); allOk = false; }

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


// BCF <ClippingPlanes> end to end: a rotated section box plus a section plane
// captured into a viewpoint, exported (BCF 3.0), imported back as a new topic,
// and that viewpoint applied must clip the model with the same planes.
for (const VER of ['3.0', '2.1']) try {
  const page = await newPage();
  page.on('dialog', (dlg) => dlg.accept());
  await loadOffice(page);
  const setup = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const d = window._ccDispatch, A = { SECTION_BOX: 'SECTION_BOX', SECTION_CUSTOM: 'SECTION_CUSTOM', ADD_ISSUE: 'ADD_ISSUE', ADD_VIEWPOINT: 'ADD_VIEWPOINT' };
    const b = window._ccElemsBBox ? window._ccElemsBBox() : null;
    const mn = b ? [b.min.x, b.min.y, b.min.z] : [-5, 0, -5], mx = b ? [b.max.x, b.max.y, b.max.z] : [5, 3, 5];
    const shrink = (k, f) => mn[k] + (mx[k] - mn[k]) * f;
    d({ t: A.SECTION_BOX, v: { enabled: true, min: [shrink(0, 0.1), shrink(1, 0.05), shrink(2, 0.15)], max: [shrink(0, 0.85), shrink(1, 0.8), shrink(2, 0.9)], rotation: 0.25 } });
    await wait(300);
    const issue = { id: 'iss-clip-1', title: 'Clip round trip', status: 'open', priority: 'normal', createdAt: new Date().toISOString() };
    d({ t: A.ADD_ISSUE, v: issue });
    await wait(500);
    // selecting anything (ACTIVE) clears a section plane: (re)apply it until
    // the plane and the box are both live, then capture at once
    const custom = { normal: [0.6, 0, 0.8], point: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2] };
    for (let t = 0; t < 10 && (window._ccActivePlanes || []).length !== 7; t++) { d({ t: A.SECTION_CUSTOM, v: custom, pos: 0.5 }); await wait(400); }
    const planes = (window._ccActivePlanes || []).map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]);
    const vp = window._ccCaptureViewpoint('clip view', issue.id);
    d({ t: A.ADD_VIEWPOINT, v: vp });
    await wait(200);
    return { vpId: vp.id, planes, vpClip: vp.clip, kind: vp.section && vp.section.kind, hasBox: !!(vp.section && vp.section.box) };
  });
  if (setup.planes.length !== 7) fail('expected 6 box planes + 1 section plane active, got ' + setup.planes.length);
  if (!setup.vpClip || setup.vpClip.length !== setup.planes.length) fail('viewpoint did not capture the clipping planes: ' + JSON.stringify(setup.vpClip));
  if (setup.kind !== 'custom' || !setup.hasBox) fail('viewpoint section should keep the plane AND the box: ' + JSON.stringify(setup));
  const dl = page.waitForEvent('download');
  await page.evaluate(([ver, vpId]) => { const s = window._ccLatestState; window._ccExportBCF(s.issues.filter((i) => i.id === 'iss-clip-1'), ver, s.viewpoints.filter((v) => v.id === vpId)); }, [VER, setup.vpId]); // exactly the captured view (adding an issue may add its own)
  const download = await dl;
  const bytes = await readFile(await download.path());
  const zip = await (require('jszip')).loadAsync(bytes);
  const bcfv = Object.keys(zip.files).filter((n) => n.endsWith('.bcfv'));
  const xml = bcfv.length ? await zip.file(bcfv[0]).async('string') : '';
  const nPlanes = (xml.match(/<ClippingPlane>/g) || []).length;
  if (nPlanes !== 7) fail(VER + ': exported viewpoint carries ' + nPlanes + ' <ClippingPlane> (want 7)');
  if (!(xml.indexOf('</PerspectiveCamera>') !== -1 && xml.indexOf('<ClippingPlanes>') > xml.indexOf('</PerspectiveCamera>'))) fail('<ClippingPlanes> must follow the camera element');
  const after = await page.evaluate(async ([b64, want]) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const d = window._ccDispatch;
    d({ t: 'SECTION_BOX', v: null }); d({ t: 'SECTION_CUSTOM', v: null });
    await wait(300);
    const before = new Set(window._ccLatestState.viewpoints.map((v) => v.id));
    window._ccImportBCF({ base64: b64 });
    for (let t = 0; t < 50 && window._ccLatestState.viewpoints.every((v) => before.has(v.id)); t++) await wait(100);
    const vp = window._ccLatestState.viewpoints.find((v) => !before.has(v.id));
    if (!vp) return { error: 'no viewpoint imported' };
    window._ccApplyViewpoint(vp);
    for (let t = 0; t < 50 && (window._ccActivePlanes || []).length !== want; t++) await wait(100);
    await wait(300);
    return { planes: (window._ccActivePlanes || []).map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]), section: vp.section };
  }, [bytes.toString('base64'), setup.planes.length]);
  if (after.error) fail(after.error);
  else {
    const near = (p, q) => p.every((v, i) => Math.abs(v - q[i]) < 1e-4);
    const missing = setup.planes.filter((p) => !after.planes.some((q) => near(p, q)));
    if (after.planes.length !== setup.planes.length || missing.length) fail('imported viewpoint clips differently: ' + JSON.stringify({ want: setup.planes, got: after.planes }));
    else console.log('BCF CLIPPING OK (' + VER + ') — section box + plane exported as 7 <ClippingPlane>, imported back and applied with the same planes');
  }
  await page.close();
} catch (e) {
  fail('exception: ' + (e && e.stack || e));
}
if (errors.length) fail('page errors: ' + JSON.stringify(errors.slice(0, 5)));
await browser.close(); server.close();
process.exit(allOk ? 0 : 1);
