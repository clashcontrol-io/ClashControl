// Shared CC_BROWSER_OFFLINE_DEPS=1 routing for the browser harnesses: serves
// the app's pinned CDN dependencies (React, ReactDOM, JSZip, pdf.js + worker,
// Three.js r180, web-ifc 0.0.77) from the local node_modules mirror and stubs
// fonts/analytics, for sandboxes that cannot reach the CDNs. Same routes the
// older harnesses (smoke.mjs, office-clash-parity.mjs, ...) inline.
//
//   import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';
//   if (offlineDepsEnabled()) await routeOfflineDeps(context, repoRoot);
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function offlineDepsEnabled() { return process.env.CC_BROWSER_OFFLINE_DEPS === '1'; }

// `target` is a Playwright BrowserContext (or Page — both have .route()).
export async function routeOfflineDeps(target, root) {
  const cache = new Map();
  async function local(route, file, contentType) {
    let body = cache.get(file);
    if (!body) { body = await readFile(join(root, 'node_modules', file)); cache.set(file, body); }
    await route.fulfill({ status: 200, body, headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' } });
  }
  const CDNJS = 'https://cdnjs.cloudflare.com/ajax/libs/';
  await target.route(CDNJS + 'react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await target.route(CDNJS + 'react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await target.route(CDNJS + 'jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await target.route(CDNJS + 'pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await target.route(CDNJS + 'pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
  await target.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
    await local(route, 'three/' + suffix);
  });
  await target.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
    await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  });
  await target.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  await target.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await target.route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
}
