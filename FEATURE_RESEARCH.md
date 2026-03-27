# ClashControl — Feature Research & Implementation Guide

> Research date: 2026-03-27 | Based on analysis of 60+ GitHub repos and open-source BIM projects

---

## IMPLEMENT — High-Value Features That Fit ClashControl

### 1. IDS Validation (Information Delivery Specification)

**What**: Let users load an `.ids` file (buildingSMART XML standard) and validate their IFC models against it before running clash detection. Check that required properties, classifications, materials, and values are present.

**Why**:
- No other web-based clash tool does this — major differentiator
- Prevents false positives from incomplete/bad models (garbage in, garbage out)
- IDS became an official buildingSMART standard in June 2024, adoption is accelerating
- Fits single-file architecture — IDS is just XML, parseable with native DOMParser
- Natural companion to the existing Standards tab
- Reference implementation exists: OpenAEC-Foundation/OpenAEC-BIM-validator (browser-based IDS checking)

**Key references**:
- https://github.com/buildingSMART/IDS (285 stars, the spec itself)
- https://github.com/OpenAEC-Foundation/OpenAEC-BIM-validator (browser-based, similar architecture)

---

### 2. Model Version Diffing (Visual Change Tracking)

**What**: When a user reloads an updated IFC file (same filename, new version), automatically detect and visually highlight what changed — added elements (green), removed elements (red), modified elements (yellow). Show a summary: "42 added, 12 removed, 8 modified."

**Why**:
- ClashControl already has model versioning — this is a natural extension
- Massively speeds up iterative clash resolution: designers fix clashes, re-export, user instantly sees what changed instead of re-reviewing everything
- Can be done by comparing element GlobalIds and property hashes between versions
- No new dependencies needed
- Inspired by bimrocket's BIM Delta tool and IfcOpenShell's ifcdiff

**Key references**:
- https://github.com/bimrocket/bimrocket (82 stars, has BIM Delta tool)
- https://github.com/brunopostle/ifcmerge (83 stars, IFC merge/diff)

---

### 3. BCF-API Integration (Connected Workflows)

**What**: Add ability to push/pull issues to external BCF servers (BIMcollab, Trimble Connect, OpenProject BIM) via the buildingSMART BCF-API standard, in addition to the existing file-based BCF export.

**Why**:
- Turns ClashControl from a standalone tool into a connected one
- Teams already using BCF platforms can integrate ClashControl into their workflow
- Just HTTP fetch calls — no new dependencies, fits single-file architecture
- BCF-API is a well-documented REST standard
- OpenAEC Foundation has a BCF platform as reference

**Key references**:
- https://github.com/buildingSMART/BCF-API (228 stars, the REST spec)
- https://github.com/OpenAEC-Foundation/openaec-bcf-platform

---

### 4. bSDD Property Enrichment

**What**: Add a "Lookup" or "Classify" button in the element inspector that queries the buildingSMART Data Dictionary API to enrich elements with standardized classifications and property definitions.

**Why**:
- Low effort — single API call per element
- Helps users understand what properties should exist on elements
- Improves clash rule accuracy when elements have proper classifications
- Fits single-file architecture perfectly

**Key references**:
- https://github.com/buildingSMART/bSDD (173 stars)
- API docs: https://app.swaggerhub.com/apis/buildingSMART/Datatool/v3

---

### 5. Rule-Based Model Checking

**What**: Let users define rules beyond geometric clashes — e.g., "all fire doors must have FireRating property", "corridor width >= 1200mm", "structural elements must have material assigned". Check model compliance and report violations as issues.

**Why**:
- Natural extension of the existing Standards tab
- Complements clash detection with data quality checks
- Users already think in terms of rules (the discipline-pair and type-pair tolerances prove this)
- Can reuse existing issue management UI for reporting violations
- Differentiates from pure geometry clash tools like Navisworks

**Key references**:
- https://github.com/opensourceBIM/IfcValidator
- https://github.com/buildingSMART/IDS (IDS is essentially a rule format)

---

### 6. Enhanced 2D Markup & Annotation Export

**What**: Improve existing markup tools with inspiration from OpenAEC's open-2d-studio. Add markup persistence across sessions, markup templates, and export markups as standalone SVG/PDF.

**Why**:
- Markup tools already exist but are session-only
- BIM coordinators need to share annotated clash screenshots in meetings
- Low effort — extend existing canvas-based markup system
- PDF export would complement existing BCF and DXF exports

**Key references**:
- https://github.com/OpenAEC-Foundation/open-2d-studio (12 stars, TypeScript 2D CAD)
- https://github.com/OpenAEC-Foundation/open-pdf-studio (39 stars, JS PDF editor)

---

## CONSIDER — High Value but Requires Architecture Changes

### 7. ThatOpen Fragments Migration

**What**: Replace the current IFC geometry caching with ThatOpen's Fragments binary format. Convert IFC to Fragments once, store, then load 10x faster on subsequent opens. GPU instancing for identical geometries.

**Why it is valuable**:
- 10x faster model loading (proven benchmark)
- Better memory management for large models
- GPU instancing reduces draw calls dramatically
- Worker-based architecture keeps UI responsive
- Already noted as a TODO in the ClashControl codebase

**Why it is hard**:
- Requires ESM bundling — breaks single-file architecture
- Requires Three.js version upgrade (r128 to r160+)
- Fragments API assumes module-based imports
- Would be the biggest architectural change in the project's history

**Recommendation**: Start with a proof-of-concept in a branch. If single-file constraint is ever relaxed, this becomes the #1 priority.

**Key references**:
- https://github.com/ThatOpen/engine_fragment
- https://github.com/ThatOpen/engine_components
- https://docs.thatopen.com/Tutorials/Components/Core/FragmentsManager

---

### 8. Point Cloud Overlay (Scan-to-BIM Clashes)

**What**: Load LAS/LAZ point cloud files alongside IFC models. Overlay laser scans on BIM models to detect as-built vs. as-designed discrepancies.

**Why it is valuable**:
- Scan-to-BIM is a growing market (renovation, retrofit, facility management)
- three-loader (Potree for Three.js) integrates with existing Three.js setup
- Visually powerful — point cloud + BIM model side by side
- Could detect clashes between point cloud and IFC geometry

**Why it is hard**:
- Point clouds are large (hundreds of MB to GB)
- Needs LOD streaming to be practical
- three-loader adds ~100KB+ dependency
- Clash detection between point cloud and mesh is computationally different from mesh-mesh

**Recommendation**: Start with visualization only (overlay point cloud on model), add clash detection later.

**Key references**:
- https://github.com/potree/potree (5,387 stars)
- https://github.com/pnext/three-loader (272 stars, Potree for Three.js)
- https://github.com/OpenAEC-Foundation/open-pointcloud-studio

---

### 9. Real-Time Multi-User Collaboration

**What**: Multiple users view the same model simultaneously. Shared cursors, shared viewpoints, real-time issue creation/updates via WebRTC or WebSocket.

**Why it is valuable**:
- BIM coordination meetings involve multiple people reviewing clashes together
- Currently everyone must be on one screen or export BCF and email around
- WebRTC is peer-to-peer — no server infrastructure needed
- Would be a unique feature among open-source BIM tools

**Why it is hard**:
- Needs signaling server (even for WebRTC)
- State synchronization is complex (who moves the camera? conflict resolution?)
- Model data is large — can't easily share full geometry over WebRTC
- Significant UX design work (presence indicators, permissions, etc.)

**Recommendation**: Start with "shared viewpoint" — one user shares a link, others see the same camera position and issues. Full real-time collaboration is a separate project.

**Key references**:
- https://github.com/bldrs-ai/Share (167 stars, browser-based BIM collaboration)

---

## DO NOT IMPLEMENT — Poor Fit or Low ROI

### Switching to xeokit Rendering Engine
- **Why not**: Would require rewriting the entire 3D viewer from scratch. xeokit is AGPL-licensed (copyleft), which may conflict with ClashControl's licensing. The existing Three.js setup works well and has a much larger ecosystem. Effort-to-benefit ratio is terrible.
- https://github.com/xeokit/xeokit-sdk (888 stars, AGPL)

### Switching to ifc-lite as Parser
- **Why not**: Very new project (January 2026), API is still changing rapidly. WebGPU browser support is still not universal. Would introduce Rust/WASM build complexity. Worth watching but too early to adopt. ClashControl's web-ifc integration is mature and working.
- https://github.com/louistrue/ifc-lite (143 stars, very new)

### Full BIM Server / CDE Backend
- **Why not**: ClashControl is a client-side tool by design. Adding a server component (like BIMserver or BIMROCKET) fundamentally changes the product. The BCF-API integration (item 3 above) gives server connectivity without running a server.
- https://github.com/opensourceBIM/BIMserver (1,703 stars but Java backend)

### IFC Authoring / Model Editing
- **Why not**: ClashControl detects problems, it doesn't create models. Adding IFC authoring (like Bonsai/BlenderBIM or ThatOpen's engine_clay) would massively expand scope without clear user value. Users create models in Revit/ArchiCAD/FreeCAD and bring them to ClashControl for checking.
- https://github.com/ThatOpen/engine_clay

### Full Quantity Takeoff / Cost Estimation
- **Why not**: Moves away from core clash detection focus. Dedicated QTO tools (Bonsai BIM, commercial estimating software) do this much better. However, showing basic quantities for clashing elements (area, volume, count) is a reasonable small addition.

### Carbon/LCA Calculation
- **Why not**: Requires maintaining a carbon factor database that needs constant updating by region/material. Regulatory requirements vary by country. Better served by dedicated tools. However, linking to external carbon databases (like OpenAEC's warmteverliesberekening approach) could be a lightweight integration later.

### IFC5 Support
- **Why not now**: The standard is still in active development and not finalized. No production IFC5 files exist yet. web-ifc doesn't support it. Revisit when the standard stabilizes (likely 2027+).
- https://github.com/buildingSMART/IFC5-development (178 stars, still in development)

### Multi-Agent AI Orchestration
- **Why not**: ClashControl's existing NL chat and AI integration already work well for single-user workflows. OpenAEC's Open-Agents pattern is designed for development automation, not end-user BIM tools. The complexity overhead doesn't match the single-file architecture.

---

## Implementation Priority Roadmap

**Phase 1 — Quick Wins (no architecture changes)**
1. Model version diffing
2. IDS validation
3. bSDD property lookup
4. BCF-API push/pull

**Phase 2 — Medium Effort**
5. Rule-based model checking
6. Enhanced markup persistence & export
7. Point cloud visualization (overlay only)

**Phase 3 — Architecture Evolution**
8. ThatOpen Fragments migration (if single-file constraint is relaxed)
9. Shared viewpoint links
10. Three.js version upgrade

---

## Key GitHub Organizations to Watch

| Organization | Focus | Why |
|---|---|---|
| [ThatOpen](https://github.com/ThatOpen) | Web-IFC engine, Fragments | Core IFC technology ClashControl depends on |
| [buildingSMART](https://github.com/buildingSMART) | IFC, BCF, IDS, bSDD, IFC5 | Standards that define ClashControl's interoperability |
| [OpenAEC-Foundation](https://github.com/OpenAEC-Foundation) | Full AEC ecosystem, BIM validation, BCF platform | Reference implementations, AI skill patterns |
| [xeokit](https://github.com/xeokit) | WebGL/WebGPU BIM viewer SDK | Performance techniques, WebGPU approaches |
| [opensourceBIM](https://github.com/opensourceBIM) | BIMserver, BIMsurfer, validators | Server-side BIM ecosystem |
| [potree](https://github.com/potree) | Point cloud rendering | Point cloud overlay technology |
| [bldrs-ai](https://github.com/bldrs-ai) | Browser-based BIM collaboration | Real-time collaboration patterns |
