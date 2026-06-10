# Open Source Components

ClashControl uses the following open source libraries and components:

## Core Dependencies (CDN-loaded)

| Component | Version | License | Purpose |
|-----------|---------|---------|---------|
| [React](https://reactjs.org/) | 18.2.0 | MIT | UI rendering framework |
| [ReactDOM](https://reactjs.org/) | 18.2.0 | MIT | React DOM renderer |
| [Three.js](https://threejs.org/) | r180 | MIT | 3D WebGL rendering engine |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT / GPLv3 (used under MIT) | ZIP file creation for BCF export/import |
| [PDF.js](https://mozilla.github.io/pdf.js/) | 3.11.174 | Apache-2.0 | PDF rendering for in-app document viewing |

## Runtime Dependencies (ESM-loaded)

| Component | Version | License | Purpose |
|-----------|---------|---------|---------|
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | 0.0.77 | MPL-2.0 | IFC file parsing and geometry extraction |

## Inline / Bundled

| Component | Source | License | Purpose |
|-----------|--------|---------|---------|
| htm | [developit/htm](https://github.com/developit/htm) | Apache-2.0 | Tagged template to React.createElement (custom minimal implementation) |

## License compatibility

- **ClashControl** is released under the **SSPL** (Server Side Public License) v1.
- **JSZip** is dual-licensed MIT/GPLv3. This project uses it under the **MIT** license.
- **web-ifc** is licensed under **MPL-2.0** (file-level copyleft). ClashControl loads it unmodified from a CDN, which is compliant with MPL-2.0. If web-ifc source files are ever modified, those modifications must be released under MPL-2.0.
- **htm** is Apache-2.0. ClashControl includes a custom minimal reimplementation inspired by htm, not a direct copy.
- All other dependencies (React, ReactDOM, Three.js) are MIT-licensed — compatible with SSPL.

## Related Open Source Tools

| Tool | Link | Purpose |
|------|------|---------|
| Ifc2Ifc | [thomhoffer-arch/Ifc2Ifc](https://github.com/thomhoffer-arch/Ifc2Ifc) | Converts IFC files into the GLB + IFC + `.ifcmeta` bundle format that ClashControl uses for fast model loading |

## Notes

- **web-ifc** is developed by [ThatOpen](https://github.com/ThatOpen) (formerly IFC.js). It provides the WebAssembly-based IFC parser that reads Industry Foundation Classes files and streams geometry data for 3D rendering.
- **Three.js** handles all 3D rendering including mesh display, clipping planes, section boxes, orbit controls, raycasting, and the view cube.
- **React** powers the entire UI with functional components using hooks (useState, useEffect, useRef, useReducer, useMemo).
- **htm** is a lightweight alternative to JSX that works without a build step, enabling the single-file architecture.
- **Ifc2Ifc** is an external preprocessing tool that produces the GLB + IFC + `.ifcmeta` file bundles accepted by ClashControl. The GLB carries pre-baked geometry (for fast load), the IFC carries the full property data, and the `.ifcmeta` sidecar carries additional element metadata. Node names in the GLB must match IFC GlobalIds for the join to work correctly.
- All dependencies are loaded from CDNs (cdnjs, esm.sh, jsdelivr) — no build step or package manager required.
