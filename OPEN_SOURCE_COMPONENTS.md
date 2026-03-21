# Open Source Components

ClashControl uses the following open source libraries and components:

## Core Dependencies (CDN-loaded)

| Component | Version | License | Purpose |
|-----------|---------|---------|---------|
| [React](https://reactjs.org/) | 18.2.0 | MIT | UI rendering framework |
| [ReactDOM](https://reactjs.org/) | 18.2.0 | MIT | React DOM renderer |
| [Three.js](https://threejs.org/) | r128 | MIT | 3D WebGL rendering engine |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT / GPLv3 | ZIP file creation for BCF export/import |

## Runtime Dependencies (ESM-loaded)

| Component | Version | License | Purpose |
|-----------|---------|---------|---------|
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | 0.0.57 | MPL-2.0 | IFC file parsing and geometry extraction |

## Inline / Bundled

| Component | Source | License | Purpose |
|-----------|--------|---------|---------|
| htm | [developit/htm](https://github.com/developit/htm) | Apache-2.0 | Tagged template to React.createElement (custom minimal implementation) |

## Development Tools

| Tool | Purpose |
|------|---------|
| Git pre-commit hooks | Auto version bumping on commit |

## Notes

- **web-ifc** is developed by [ThatOpen](https://github.com/ThatOpen) (formerly IFC.js). It provides the WebAssembly-based IFC parser that reads Industry Foundation Classes files and streams geometry data for 3D rendering.
- **Three.js** handles all 3D rendering including mesh display, clipping planes, section boxes, orbit controls, raycasting, and the view cube.
- **React** powers the entire UI with functional components using hooks (useState, useEffect, useRef, useReducer, useMemo).
- **htm** is a lightweight alternative to JSX that works without a build step, enabling the single-file architecture.
- All dependencies are loaded from CDNs (cdnjs, esm.sh, jsdelivr) - no build step or package manager required.
