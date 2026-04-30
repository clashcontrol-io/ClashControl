# Best-IFC-Viewer-In-The-World Plan

> Goal: make ClashControl the obvious free choice for architects who want to share IFC models with clients. Local-first, no login, no IFC upload, single-file Three.js r128.

## What's already on this branch (`claude/improve-ifc-viewer-ux-WhTsB`)

- **Top-level Share** — labeled accent button in the header (was a buried 16x16 icon). Status dot turns green when a folder is linked, amber while syncing. Unread-comment badge.
- **Pin-on-model comments** synced through the existing `.ccproject` folder-sync (no backend). Drop-pin mode, anchored to `{point, globalId}`, last-write-wins by `{id, ts}`. Sync drops to 15s while open comments exist.
- **Walk-mode FOV HUD** — Narrow/Normal/Wide preset chips (50/75/95°), 30–110 slider, live "FOV: 75° · Natural" toast on scroll, **Shift+Scroll = dolly-zoom** (camera dollies forward/back so subject screen-size stays constant). Persisted per-user in localStorage.
- **Cinematic rendering** — `ACESFilmicToneMapping`, `outputEncoding = sRGBEncoding`, `PCFSoftShadowMap` on the warm directional sun, Hemi-light sky/ground bounce, procedural sky-gradient background that flips on theme. Shadows + cast/receive gated to `renderStyle === 'rendered'` so cheaper modes stay fast. `_ccUpdateShadowFrustum` resizes the shadow camera to fit loaded models.
- **Presentation / kiosk mode (P)** — fullscreen + chrome hidden via `body[data-presenting="1"]`, auto-rotate when idle 30s, dimmed vignette, low-opacity controls bar with Prev/Next viewpoint and Exit. Esc/P toggle. Auto-exit if user leaves fullscreen.

## Next slices, in shipping order

### PR-A — TransformControls section gizmo
- Replace the custom plane drag at `index.html:6379-6418` with `examples/jsm/controls/TransformControls.js` (loadable from `unpkg.com/three@0.128.0/...`).
- Bind to an invisible `Object3D` per plane. `mode='translate'` default, right-click → `'rotate'`, double right-click → flip normal.
- Hook `dragging-changed` to `S.orbit.enabled` so orbit doesn't fight the gizmo.
- Section box gets six face handles (also TransformControls, axis-locked) and a right-click menu: Reset / Flip / Snap-to-element / Delete.
- Mini-list panel bottom-left listing each plane (axis chip + thumbnail).

### PR-B — SAOPass + OutlinePass (post-process)
- `EffectComposer` only used when `renderStyle === 'rendered'` (others render direct).
- `SAOPass` for ambient occlusion at corners and creases (the "looks pro" win).
- `OutlinePass` for selection — replaces the wireframe overlay with a clean architectural silhouette.
- `SMAAPass` for anti-alias, since we lose the canvas MSAA when using a composer.

### PR-C — Smart Views & shareable URL hash
- New reducer slice: `smartViews: [{id, name, thumbnail, viewpoint, section, visibility, renderStyle}]`.
- Default presets: "By Discipline", "By Storey", "Structure only", "MEP only", "Architecture only".
- Shareable URL: `#v=<base64 camera+target+section+vis+style>`. Viewer detects on boot, applies. **No backend.** Addresses the "share isn't visible enough" gap directly.
- Surface: Smart Views bar in the welcome popup + one click in the Share modal.

### PR-D — Walk polish
- Top-down minimap (160×160 corner) with avatar dot.
- Smooth eye-height lerp (no popping at thresholds).
- Optional head-bob toggle.
- Gamepad: `navigator.getGamepads()` polled in `_walkTick`; left stick strafe, right stick look.
- "No-clip" chip on the HUD (already wired internally as `_walkCollision`).

### PR-E — Presentation mode v2
- Slide system: ordered list of viewpoints per project, arrow keys advance.
- Auto-advance with configurable interval (spacebar starts).
- Drop-zone for an architect logo on the welcome modal → renders bottom-right at 24% opacity in present mode.
- Kiosk URL: `?present=1` boots straight in.

## Things explicitly NOT in scope

- No Three.js upgrade past r128 (r152+ broke the codebase's tone-mapping/material assumptions).
- No build step, bundler, TypeScript, or framework swap. Single-file invariant.
- No raytracing / WebGPU. SAO + ACES + decent lighting is 90% of perceived realism.
- No IFC bytes leaving the user's machine. Share is folder-sync (`.ccproject`) or URL hash only — never Neon for model data.
- No three-mesh-bvh, three-stdlib, drei, react-three-fiber. All r128-incompatible or violate the no-deps rule.

## State of the art — what we steal from each tool

| Tool | What we steal |
|---|---|
| **xeokit-bim-viewer** | TransformControls section gizmo, mini-list of planes, right-click reset/flip |
| **BIMcollab Zoom** | Smart View presets, first-launch tour |
| **Solibri Anywhere** (sunset Apr 2026) | Coloring by classification — a vacuum we should fill |
| **Trimble Connect** | Shareable view URL with comments anchored to viewpoints |
| **Autodesk APS Viewer** | TransformControls on the section box |
| **Enscape / Twinmotion** | ACES + soft shadows + sky bounce — already in this branch |
| **bldrs.ai** | Deep-linked viewpoint state in the URL hash |
| **Sketchfab** | Numbered annotation hotspots; post-processing presets stored as JSON |
