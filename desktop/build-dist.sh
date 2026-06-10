#!/usr/bin/env bash
# Assemble the static frontend for the Tauri bundle from the repo root.
# Phase 0 keeps CDN dependencies online-loaded; vendoring is Phase 1.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir dist
cp index.html manifest.json version.json dist/
cp -r addons icons dist/
# The PWA service worker must not run inside Tauri (assets are local;
# its CDN cache-first logic would fight the WebView). pwa.js already
# no-ops when registration fails; ship without sw.js.
echo "dist assembled: $(du -sh dist | cut -f1)"
