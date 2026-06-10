#!/usr/bin/env node
// Assemble the static frontend for the Tauri bundle. Pure Node — the
// beforeBuildCommand shell differs per platform (cmd on Windows broke the
// bash -c quoting), and __dirname makes this independent of tauri's cwd.
// Phase 0 keeps CDN dependencies online-loaded; vendoring is Phase 1.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const f of ['index.html', 'manifest.json', 'version.json']) {
  fs.copyFileSync(path.join(root, f), path.join(dist, f));
}
// The PWA service worker must not run inside Tauri (assets are local; its
// CDN cache-first logic would fight the WebView) — sw.js deliberately omitted.
for (const dir of ['addons', 'icons']) {
  fs.cpSync(path.join(root, dir), path.join(dist, dir), { recursive: true });
}
console.log('dist assembled at', dist);
