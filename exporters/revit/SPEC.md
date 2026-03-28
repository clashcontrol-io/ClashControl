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
      "hostRelationships": []
    }
  },
  "storeys": ["Level 1", "Level 2", "Roof"],
  "storeyData": [
    { "name": "Level 1", "elevation": 0.0 },
    { "name": "Level 2", "elevation": 3000.0 }
  ],
  "spatialHierarchy": {},
  "relatedPairs": {}
}
```

### Required fields per element
- `name` — display name
- `ifcType` — IFC entity type (`IfcWall`, `IfcBeam`, etc.)

### Optional Revit-specific fields
- `phase`, `workset`, `designOption`, `hostId`
- `layers` — array of `{ function, material, width }` objects (or plain strings)
- `flipState` — `{ handFlipped, facingFlipped }`
- `constraints` — level constraints as key/value
- `hostRelationships` — array of hosted element GlobalIds

---

## `.ifcprops` schema

Full property dump — replaces IFC STEP parsing (~25s → <1s).
Keyed by IFC GlobalId.

```json
{
  "elements": {
    "0K7w7jYlXCpOJN0oo5MIAN": {
      "name": "Basic Wall:Generic - 200mm:123456",
      "category": "Walls",
      "type": "Basic Wall:Generic - 200mm",
      "level": "Level 1",
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
| `name` | `name` |
| `category` | `ifcType` |
| `type` | `objectType` |
| `level` | `storey` |
| `materials` (string or array) | `material` |
| `parameters` | `psets` |

---

## GLB conventions

- **Coordinate system**: glTF 2.0 mandates Y-up. Ifc2Ifc converts from Revit Z-up to Y-up on export. No rotation is applied by ClashControl on load.
- **Node naming**: Each mesh node name = IFC GlobalId of the element it represents.
- **Materials**: GLB material colors are ignored — IFC colors from `StreamAllMeshes` are applied instead.
- **Format**: glTF 2.0 binary (`.glb`), geometry only (no animations, no cameras).

---

## Load path priority

ClashControl selects the fastest available path:

```
.ifcprops present  →  GLB + .ifcprops [+ .ifcmeta overlay]   (fastest, ~2s)
.ifcmeta present   →  GLB + .ifcmeta                          (fast, ~2s)
.ifc only          →  GLB + IFC STEP parse                    (slow, ~25s)
plain .ifc         →  IFC geometry + metadata                  (slow, ~25s)
```
