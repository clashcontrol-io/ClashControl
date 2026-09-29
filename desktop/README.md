# ClashControl Desktop (Tauri) — Phase 0

Wraps the exact same `index.html` the website ships in a system WebView.
No fork: desktop capabilities arrive via `addons/tauri-bridge.js`
(capability-detected, per docs/TAURI.md); the browser never even fetches it.

## Native clash engine (Phase 2)

The shell exposes the Rust clash narrow phase (the same `engine/` crate the
WASM build uses, built with its `native` feature: cached BVHs + rayon over
`cores - 1` threads) as Tauri commands in `src-tauri/src/engine_cmds.rs`:
`register_meshes`, `register_mesh`, `unregister_mesh`, `clear_meshes`,
`intersect_batch`, `min_dist_batch`, `engine_info`. Payloads are raw
little-endian bytes (layouts in `engine/src/native.rs`, module `wire`).
Nothing else is callable: `build.rs` declares the commands and
`src-tauri/capabilities/default.json` grants exactly those (`csp` is
unchanged, `null`).

At startup `addons/tauri-bridge.js` diffs the commands against the JS
reference (same self-check idea as `addons/wasm-engine.js`) and only then
publishes `window._ccNativeNarrow`, which the core's narrow-phase pool layer
uses instead of Web Workers. On any error the run falls back to WASM/JS, and
the Python local-engine install prompts are hidden in the desktop app.

Test it:

    cd engine && cargo test && cargo test --features native
    node desktop/build-dist.cjs
    npx @tauri-apps/cli@^2 icon icons/icon-512.png -o desktop/src-tauri/icons
    cd desktop/src-tauri && cargo test   # command fns, wire codec, capability sync
    node --test tests/tauri-bridge.test.js   # from the repo root

Status and honest limits: see `docs/TAURI.md` (Phase 2). Not done yet:
end-to-end multicore benchmark on a large federation, Windows/macOS runs,
a CI job for the desktop cargo tests.

Build locally (needs Rust + platform WebView deps, see Tauri v2 docs):

    cd desktop
    ./build-dist.sh            # assemble ../dist from the repo's static files
    npx @tauri-apps/cli@^2 icon ../icons/icon-512.png   # one-time icon gen
    npx @tauri-apps/cli@^2 build

CI: `.github/workflows/release-desktop.yml` builds Win/macOS/Linux
installers when `desktop/desktop-version.json` is bumped on main.
