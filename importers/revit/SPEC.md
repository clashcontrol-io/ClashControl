# ClashControl Exporter — Revit (Ifc2Ifc)

This is the reference implementation. The Revit addin **Ifc2Ifc** produces all four
files from a single export command.

## Output files

| File | Role |
|------|------|
| `<name>.ifc` | Standard IFC 2x3/4 — fallback, not needed if .ifcprops present |
| `<name>.glb` | Pre-tessellated geometry in GLB/glTF 2.0 (Z-up, Revit coordinates) |
| `<name>.ifcmeta` | Revit-specific data lost in IFC translation (JSON) |
| `<name>.ifcprops` | All element properties as JSON — replaces IFC STEP parsing |

All four files must share the same base name. ClashControl groups them by base name on drop.

---

## `.ifcmeta` schema

Keyed by IFC GlobalId (the same GUID embedded in the GLB node name).

```json
{
  "elements": {
    "0K7w7jYlXCpOJN0oo5MIAN": {
      "name": "Basic Wall:Generic - 200mm:123456",
      "ifcType": "IfcWall",
      "objectType": "Basic Wall",
      "storey": "Level 1",
      "material": "Concrete",
      "revitId": 123456,
      "quantities": {
        "Width": 0.2,
        "Height": 3.0,
        "Length": 5.0
      },
      "psets": {
        "Pset_WallCommon": {
          "IsExternal": true,
          "LoadBearing": false
        }
      },
      "phase": "New Construction",
      "workset": "Architecture",
      "designOption": null,
      "hostId": null,
      "layers": [
        { "function": "Structure", "material": "Concrete", "width": 200 },
        { "function": "Finish 1", "material": "Plaster", "width": 20 }
      ],
      "flipState": { "handFlipped": false, "facingFlipped": false },
      "constraints": {
        "baseConstraint": "Level 1",
        "baseOffset": 0.0,
        "topConstraint": "Unconnected",
        "topOffset": 3000.0
      },
      "hostRelationships": ["3Ax9mWqLz1B0OvE3pQdT7k", "1Bx8nVpKy2C1PwF4qReU8j"]
    }
  },
  "storeys": ["Level 1", "Level 2", "Roof"],
  "storeyData": [
    { "name": "Level 1", "elevation": 0.0 },
    { "name": "Level 2", "elevation": 3000.0 }
  ],
  "spatialHierarchy": {},
  "relatedPairs": {
    "0K7w7jYlXCpOJN0oo5MIAN:3Ax9mWqLz1B0OvE3pQdT7k": true,
    "0K7w7jYlXCpOJN0oo5MIAN:1Bx8nVpKy2C1PwF4qReU8j": true
  }
}
```

### Required fields per element
- `name` — display name
- `ifcType` — IFC entity type (`IfcWall`, `IfcBeam`, etc.)

### Optional Revit-specific fields
- `revitId` — Revit integer ElementId (integer). Displayed in ClashControl's properties panel with a copy button for cross-referencing back to Revit.
- `phase`, `workset`, `designOption`
- `hostId` — GlobalId of the host element (e.g. the wall this door is in). Must point to the wall, **not** to the intermediate `IfcOpeningElement`. ClashControl uses this to build parent-child tree hierarchy and extend clash suppression.
- `hostRelationships` — array of GlobalIds of all elements directly hosted in this element (reverse of `hostId`). Used by ClashControl to suppress host↔child clashes without needing the IFC STEP file.
- `layers` — array of `{ function, material, width }` objects (or plain strings)
- `flipState` — `{ handFlipped, facingFlipped }`
- `constraints` — level constraints as key/value

### Top-level fields
- `relatedPairs` — pre-computed element relationships as `"globalIdA:globalIdB": true`. Keys use GlobalIds (stable across re-exports), **not** STEP expressIds. ClashControl resolves these to expressIds at load time. Include:
  - wall↔opening pairs (from `IFCRELVOIDSELEMENT`)
  - opening↔door/window pairs (from `IFCRELFILLELEMENT`)
  - **transitive wall↔door pairs** (the practical pair ClashControl needs for clash suppression)
  - assembly parent↔child pairs (from `IFCRELAGGREGATES`)

### `IfcOpeningElement` handling
`IfcOpeningElement` entities are Boolean cutters — they define the void shape in a wall. They must **not** appear as GLB mesh nodes. The wall geometry in the GLB should already have the hole cut. `IfcOpeningElement` GlobalIds should still appear in `relatedPairs` (via the transitive wall↔door pair), but not as element entries in `.ifcmeta`.

---

## `.ifcprops` schema

Full property dump — replaces IFC STEP parsing (~25s → <1s).
Keyed by IFC GlobalId.

```json
{
  "elements": {
    "0K7w7jYlXCpOJN0oo5MIAN": {
      "expressId": 12345,
      "name": "Basic Wall:Generic - 200mm:123456",
      "category": "Walls",
      "type": "Basic Wall:Generic - 200mm",
      "level": "Level 1",
      "revitId": 123456,
      "materials": ["Concrete", "Plaster"],
      "parameters": {
        "Constraints": {
          "Base Constraint": "Level 1",
          "Base Offset": 0.0,
          "Top Constraint": "Unconnected",
          "Unconnected Height": 3000.0
        },
        "Dimensions": {
          "Length": 5000.0,
          "Area": 15.0,
          "Volume": 3.0
        },
        "Identity Data": {
          "Type Name": "Generic - 200mm",
          "Description": ""
        }
      }
    }
  }
}
```

### Field mapping to ClashControl element props
| `.ifcprops` field | ClashControl prop |
|---|---|
| `expressId` | `expressId` (used for GlobalId→expressId map; also enables stable relatedPairs resolution without IFC STEP) |
| `name` | `name` |
| `category` | `ifcType` |
| `type` | `objectType` |
| `level` | `storey` |
| `revitId` | `revitId` |
| `materials` (string or array) | `material` |
| `parameters` | `psets` |

---

## GLB conventions

- **Coordinate system**: glTF 2.0 mandates Y-up. Ifc2Ifc converts from Revit Z-up to Y-up on export. No rotation is applied by ClashControl on load.
- **Node naming**: Each mesh node name = IFC GlobalId of the element it represents. One node per IFC entity — no geometry merging between elements.
- **Materials**: GLB material colors are ignored — IFC colors from `StreamAllMeshes` are applied instead.
- **Format**: glTF 2.0 binary (`.glb`), geometry only (no animations, no cameras).
- **`IfcOpeningElement` suppression**: Opening elements (wall voids for doors/windows) must NOT appear as GLB mesh nodes. The wall geometry should already have the hole cut. If opening meshes are present, ClashControl will warn in the console.
- **Stair decomposition**: Component-based stairs (`IsByComponent = true`) must export each `StairsRun`, `StairsLanding`, and `StairsSupport` as its own GLB node with its own GlobalId. This is required for per-component clash detection (e.g. MEP crossing a specific stair run). Sketch-based stairs export as a single mesh.
- **Hosted elements**: Doors, windows, and other hosted family instances each get their own GLB node named with their GlobalId. They are never merged into the host wall's mesh.

---

## Load path priority

ClashControl selects the fastest available path:

```
.ifcprops present  →  GLB + .ifcprops [+ .ifcmeta overlay]   (fastest, ~2s)
.ifcmeta present   →  GLB + .ifcmeta                          (fast, ~2s)
.ifc only          →  GLB + IFC STEP parse                    (slow, ~25s)
plain .ifc         →  IFC geometry + metadata                  (slow, ~25s)
```

---

## Future: Ifc2Ifc v2 — Native Revit normals via `IExportContext / OnPolymesh`

> **Not implemented. Planned for a full rewrite of Ifc2Ifc.**

Switch `GeometryHarvester` from the current tessellation path to `IExportContext` / `CustomExporter`. Revit calls `OnPolymesh(PolymeshTopology)` per face and provides:

- `GetNormals()` — Revit's own rendering normals, same quality as the Revit viewport
- `DistributionOfNormals` — `AtEachPoint` (smooth, curved surfaces) or `OnePerFace` (flat, planar faces)

This gives the correct smooth/flat distinction per face without any post-processing:
- Flat wall/slab faces → one flat normal per face
- Curved pipes/ducts/columns → smooth per-vertex normals

**What changes on export:**
- Write the `NORMAL` accessor into the GLB (same axis swap as positions: `nx, nz, -ny`)
- No need for double-sided materials — winding is correct and normals are outward-facing

**What changes in ClashControl when this ships:**
- Drop `computeVertexNormals()` from `loadGLB` — normals are already correct
- Switch GLB materials from `THREE.DoubleSide` to `THREE.FrontSide` (currently kept DoubleSide until winding is confirmed correct across all element types)

The quality difference is negligible for flat building elements but visible for curved MEP geometry (pipe caps, duct elbows, round columns) where the current `computeVertexNormals()` incorrectly smooths across hard edges.
