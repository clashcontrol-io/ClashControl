# ClashControl Desktop (Tauri) — Phase 0

Wraps the exact same `index.html` the website ships in a system WebView.
No fork: desktop capabilities arrive later via `addons/tauri-bridge.js`
(capability-detected, per TAURI.md). Phase 0 = shell + installers only.

Build locally (needs Rust + platform WebView deps, see Tauri v2 docs):

    cd desktop
    ./build-dist.sh            # assemble ../dist from the repo's static files
    npx @tauri-apps/cli@^2 icon ../icons/icon-512.png   # one-time icon gen
    npx @tauri-apps/cli@^2 build

CI: `.github/workflows/release-desktop.yml` builds Win/macOS/Linux
installers when `desktop/desktop-version.json` is bumped on main.
