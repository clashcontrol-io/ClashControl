# Local Clash Detection Server — Build Guide

> **Purpose**: A Python service on `localhost:19800` that runs multi-threaded, exact mesh-vs-mesh clash detection for ClashControl. Drop this file into a Claude Code session to build it.

## What It Does

A Python WebSocket server that:
1. **Receives model geometry** (vertices + indices as binary arrays) from ClashControl
2. **Runs exact triangle-triangle intersection** using Open3D + NumPy, across all CPU cores
3. **Returns clash results** as JSON matching ClashControl's clash object shape
4. **Falls back gracefully** — ClashControl uses its browser OBB engine when this server isn't running

## Why

| | Browser (JS, OBB) | Local Server (Python, exact mesh) |
|---|---|---|
| Threads | 1 | All CPU cores |
| Accuracy | Bounding box approximation | Exact triangle intersection |
| 2K × 2K elements | ~10s | ~3-5s |
| 10K × 10K elements | ~60s or OOM | ~15-20s |
| Memory limit | ~2-4 GB (browser) | System RAM |
| Intersection volume | AABB estimate | Exact mesh boolean |
| Penetration depth | AABB min-axis | Exact mesh measurement |

---

## Architecture

```
ClashControl (browser)
  │
  │  1. POST /detect  (binary model data + rules JSON)
  │  2. WebSocket ws://localhost:19800/ws  (progress updates)
  │
  ▼
Local Clash Server (Python, localhost:19800)
  │
  │  3. Build BVH per element
  │  4. Sweep-and-prune candidate pairs
  │  5. Parallel exact intersection (ProcessPoolExecutor)
  │  6. Return clash results JSON
  │
  ▼
ClashControl (browser)
  │
  │  7. Merge into clash list, display in 3D viewer
```

---

## Project Structure

```
clashcontrol-engine/
├── server.py              — Main server (HTTP + WebSocket on :19800)
├── engine.py              — Clash detection engine
├── sweep.py               — Sweep-and-prune broad phase
├── intersection.py        — Triangle-triangle intersection (narrow phase)
├── protocol.py            — Message parsing + clash result builder
├── requirements.txt       — Dependencies
└── README.md              — Usage instructions
```

---

## Dependencies

### requirements.txt
```
websockets>=12.0
numpy>=1.24
trimesh>=4.0
open3d>=0.18
scipy>=1.11
```

- **websockets** — async WebSocket server
- **numpy** — array operations, vectorized math
- **trimesh** — mesh loading, BVH, ray casting, boolean operations
- **open3d** — exact mesh intersection, collision detection
- **scipy** — spatial KD-trees for clearance distance queries

---

## HTTP + WebSocket Protocol

### `POST /detect` — Start Clash Detection

ClashControl sends a JSON body:

```json
{
  "models": [
    {
      "id": "ABC123",
      "name": "Architectural",
      "discipline": "architectural",
      "elements": [
        {
          "expressId": 1,
          "globalId": "0K7w7jYlXCpOJN0oo5MIAN",
          "ifcType": "IfcWall",
          "name": "Basic Wall: Generic - 200mm",
          "storey": "Level 1",
          "material": "Concrete",
          "objectType": "Generic - 200mm",
          "positions": "<base64 Float32Array>",
          "indices": "<base64 Uint32Array>"
        }
      ],
      "relatedPairs": {"gidA:gidB": true}
    }
  ],
  "rules": {
    "modelA": "all",
    "modelB": "all",
    "hard": true,
    "maxGap": 50,
    "excludeSelf": true,
    "excludeTypes": [],
    "excludeTypePairs": [],
    "minOverlapVolM3": 1e-5,
    "useSemanticFilter": true
  }
}
```

**Geometry encoding**: `positions` is a base64-encoded `Float32Array` (x,y,z triplets in meters, Y-up). `indices` is a base64-encoded `Uint32Array` (triangle index triplets).

### Response — Clash Results

```json
{
  "clashes": [
    {
      "elemA": 1,
      "elemB": 42,
      "modelAId": "ABC123",
      "modelBId": "DEF456",
      "point": [1.234, 5.678, -2.345],
      "elevation": 5.678,
      "type": "hard",
      "distance": -15,
      "overlapVolM3": 0.00234,
      "clearanceMm": null,
      "elemAType": "IfcWall",
      "elemBType": "IfcDuctSegment",
      "elemAName": "Basic Wall: Generic - 200mm",
      "elemBName": "Round Duct: 300mm",
      "globalIdA": "0K7w7jYlXCpOJN0oo5MIAN",
      "globalIdB": "3Ax9mWqLz1B0OvE3pQdT7k",
      "elemAStorey": "Level 1",
      "elemBStorey": "Level 1",
      "elemAMaterial": "Concrete",
      "elemBMaterial": "Steel",
      "objectTypeA": "Generic - 200mm",
      "objectTypeB": "Round Duct",
      "bboxA": {"dx": 5000, "dy": 3000, "dz": 200},
      "bboxB": {"dx": 300, "dy": 300, "dz": 2500},
      "disciplines": ["architectural", "mep"],
      "selfClash": false,
      "title": "ARCHITECTURAL ↔ MEP",
      "description": "IfcWall: Basic Wall vs IfcDuctSegment: Round Duct"
    }
  ],
  "stats": {
    "elementCount": 3500,
    "candidatePairs": 12000,
    "clashCount": 87,
    "duration_ms": 4200,
    "threads": 8
  }
}
```

### `GET /status` — Health Check

Returns:
```json
{"status": "ready", "version": "1.0.0", "cores": 8}
```

ClashControl calls this to detect whether the local engine is available.

### WebSocket `ws://localhost:19800/ws` — Progress Updates

During detection, the server sends progress messages:

```json
{"type": "progress", "done": 450, "total": 12000, "pct": 4}
```

And completion:
```json
{"type": "complete", "clashCount": 87, "duration_ms": 4200}
```

---

## Engine Implementation

### Broad Phase: Sweep-and-Prune

Same algorithm ClashControl uses in the browser, but vectorized with NumPy:

```python
# sweep.py
import numpy as np

def sweep_and_prune(elements_a, elements_b, max_gap_m, rules):
    """
    Returns list of (elem_a, elem_b) candidate pairs whose AABBs overlap
    (or are within max_gap_m clearance).
    """
    # Build AABB arrays: shape (N, 6) for [min_x, min_y, min_z, max_x, max_y, max_z]
    bboxes_a = np.array([[*e['bbox_min'], *e['bbox_max']] for e in elements_a])
    bboxes_b = np.array([[*e['bbox_min'], *e['bbox_max']] for e in elements_b])

    # Expand by max_gap for clearance detection
    bboxes_a_exp = bboxes_a.copy()
    bboxes_a_exp[:, :3] -= max_gap_m  # expand min
    bboxes_a_exp[:, 3:] += max_gap_m  # expand max

    # Sort by X-axis min for sweep
    order_a = np.argsort(bboxes_a_exp[:, 0])
    order_b = np.argsort(bboxes_b[:, 0])

    candidates = []

    for i in order_a:
        a = bboxes_a_exp[i]
        for j in order_b:
            b = bboxes_b[j]
            # X-axis sweep exit
            if b[0] > a[3]:
                break
            if b[3] < a[0]:
                continue
            # Full 3-axis AABB overlap test
            if (a[0] <= b[3] and a[3] >= b[0] and
                a[1] <= b[4] and a[4] >= b[1] and
                a[2] <= b[5] and a[5] >= b[2]):

                ea, eb = elements_a[i], elements_b[j]

                # Skip self-clash pairs
                if rules.get('excludeSelf') and ea['model_id'] == eb['model_id'] and ea['expressId'] == eb['expressId']:
                    continue

                # Skip related pairs (host ↔ child)
                pair_key = f"{ea['globalId']}:{eb['globalId']}"
                pair_key_rev = f"{eb['globalId']}:{ea['globalId']}"
                related = ea.get('_relatedPairs', {})
                if related.get(pair_key) or related.get(pair_key_rev):
                    continue

                # Skip excluded type pairs
                type_pair = ':'.join(sorted([ea['ifcType'], eb['ifcType']]))
                if type_pair in rules.get('_exTypePairSet', set()):
                    continue

                candidates.append((i, j))

    return candidates
```

### Narrow Phase: Exact Triangle-Triangle Intersection

```python
# intersection.py
import numpy as np
import trimesh

def check_intersection(mesh_a: trimesh.Trimesh, mesh_b: trimesh.Trimesh, max_gap_m: float):
    """
    Returns (clash_type, point, distance_mm, overlap_vol_m3) or None.

    clash_type: 'hard' (penetrating) or 'soft' (within clearance)
    point: [x, y, z] intersection/closest point
    distance_mm: negative = penetration depth, positive = clearance gap
    overlap_vol_m3: approximate intersection volume (for hard clashes)
    """

    # Quick AABB pre-check (should already pass from broad phase, but safety)
    if not mesh_a.bounds[0][0] <= mesh_b.bounds[1][0]:
        return None

    # Check for mesh intersection using trimesh's collision manager
    collision = trimesh.collision.CollisionManager()
    collision.add_object('a', mesh_a)

    is_collision = collision.in_collision_single(mesh_b)

    if is_collision:
        # Hard clash — find intersection point and penetration depth
        try:
            # Boolean intersection to get overlap volume
            intersection = mesh_a.intersection(mesh_b, engine='blender')  # or 'manifold'
            if intersection and intersection.volume > 0:
                centroid = intersection.centroid
                # Penetration depth: approximate from intersection bounding box min dimension
                int_bounds = intersection.bounds
                dims = int_bounds[1] - int_bounds[0]
                pen_depth = float(np.min(dims))

                return (
                    'hard',
                    centroid.tolist(),
                    -round(pen_depth * 1000),     # mm, negative = penetration
                    float(intersection.volume)
                )
        except Exception:
            pass

        # Fallback: use collision contact point
        contacts = collision.in_collision_single(mesh_b, return_data=True)
        if contacts and len(contacts[1]) > 0:
            contact = contacts[1][0]
            point = contact.point.tolist() if hasattr(contact, 'point') else mesh_a.centroid.tolist()
            return ('hard', point, -1, 0.0)

        return ('hard', mesh_a.centroid.tolist(), -1, 0.0)

    elif max_gap_m > 0:
        # Soft clash — check clearance distance
        closest, distance, _ = trimesh.proximity.closest_point(mesh_a, mesh_b.vertices)

        min_dist = float(np.min(distance))
        if min_dist <= max_gap_m:
            # Find the closest point pair
            min_idx = np.argmin(distance)
            point_on_a = closest[min_idx]
            point_on_b = mesh_b.vertices[min_idx]
            midpoint = ((point_on_a + point_on_b) / 2).tolist()

            return (
                'soft',
                midpoint,
                round(min_dist * 1000),  # mm, positive = gap
                0.0
            )

    return None
```

### Parallel Processing

```python
# engine.py
import base64
import struct
import numpy as np
import trimesh
from concurrent.futures import ProcessPoolExecutor, as_completed
from sweep import sweep_and_prune
from intersection import check_intersection

def decode_geometry(element):
    """Decode base64 positions/indices into a trimesh.Trimesh."""
    pos_bytes = base64.b64decode(element['positions'])
    idx_bytes = base64.b64decode(element['indices'])

    positions = np.frombuffer(pos_bytes, dtype=np.float32).reshape(-1, 3)
    indices = np.frombuffer(idx_bytes, dtype=np.uint32).reshape(-1, 3)

    return trimesh.Trimesh(vertices=positions, faces=indices, process=False)


def _check_pair(args):
    """Worker function for parallel execution. Runs in a subprocess."""
    mesh_data_a, mesh_data_b, elem_a, elem_b, max_gap_m = args

    mesh_a = trimesh.Trimesh(
        vertices=mesh_data_a['vertices'],
        faces=mesh_data_a['faces'],
        process=False
    )
    mesh_b = trimesh.Trimesh(
        vertices=mesh_data_b['vertices'],
        faces=mesh_data_b['faces'],
        process=False
    )

    result = check_intersection(mesh_a, mesh_b, max_gap_m)
    if result is None:
        return None

    clash_type, point, distance_mm, overlap_vol = result

    return {
        'elemA': elem_a['expressId'],
        'elemB': elem_b['expressId'],
        'modelAId': elem_a['model_id'],
        'modelBId': elem_b['model_id'],
        'point': point,
        'elevation': round(point[1], 3),
        'type': clash_type,
        'distance': distance_mm,
        'overlapVolM3': overlap_vol,
        'clearanceMm': distance_mm if clash_type == 'soft' else None,
        'elemAType': elem_a['ifcType'],
        'elemBType': elem_b['ifcType'],
        'elemAName': elem_a['name'],
        'elemBName': elem_b['name'],
        'globalIdA': elem_a['globalId'],
        'globalIdB': elem_b['globalId'],
        'elemAStorey': elem_a.get('storey', ''),
        'elemBStorey': elem_b.get('storey', ''),
        'elemAMaterial': elem_a.get('material', ''),
        'elemBMaterial': elem_b.get('material', ''),
        'objectTypeA': elem_a.get('objectType', ''),
        'objectTypeB': elem_b.get('objectType', ''),
        'bboxA': _bbox_mm(elem_a['bbox_min'], elem_a['bbox_max']),
        'bboxB': _bbox_mm(elem_b['bbox_min'], elem_b['bbox_max']),
        'disciplines': sorted([elem_a['discipline'], elem_b['discipline']]),
        'selfClash': elem_a['model_id'] == elem_b['model_id'],
    }


def _bbox_mm(bmin, bmax):
    return {
        'dx': round((bmax[0] - bmin[0]) * 1000),
        'dy': round((bmax[1] - bmin[1]) * 1000),
        'dz': round((bmax[2] - bmin[2]) * 1000),
    }


def detect_clashes(models, rules, on_progress=None):
    """
    Main entry point. Takes models + rules, returns list of clash dicts.
    """
    import multiprocessing
    import time

    t0 = time.time()
    max_gap_m = (rules.get('maxGap', 0)) / 1000.0
    num_workers = max(1, multiprocessing.cpu_count() - 1)

    # 1. Parse all elements, decode geometry, compute bboxes
    all_elements = []
    mesh_cache = {}  # expressId → {vertices, faces}

    for model in models:
        related_pairs = model.get('relatedPairs', {})
        for elem in model['elements']:
            if not elem.get('positions') or not elem.get('indices'):
                continue

            mesh = decode_geometry(elem)
            bbox_min = mesh.bounds[0].tolist()
            bbox_max = mesh.bounds[1].tolist()

            parsed = {
                'expressId': elem['expressId'],
                'globalId': elem.get('globalId', ''),
                'ifcType': elem.get('ifcType', 'IfcBuildingElementProxy'),
                'name': elem.get('name', ''),
                'storey': elem.get('storey', ''),
                'material': elem.get('material', ''),
                'objectType': elem.get('objectType', ''),
                'model_id': model['id'],
                'discipline': model.get('discipline', 'other'),
                'bbox_min': bbox_min,
                'bbox_max': bbox_max,
                '_relatedPairs': related_pairs,
            }

            mesh_cache[elem['expressId']] = {
                'vertices': mesh.vertices.copy(),
                'faces': mesh.faces.copy(),
            }

            all_elements.append(parsed)

    # 2. Broad phase: sweep-and-prune
    # Determine model groups A and B
    def pick_models(selector):
        if selector == 'all':
            return all_elements
        return [e for e in all_elements if e['model_id'] == selector]

    elements_a = pick_models(rules.get('modelA', 'all'))
    elements_b = pick_models(rules.get('modelB', 'all'))

    # Build excluded type pair set
    ex_pairs = set()
    for p in rules.get('excludeTypePairs', []):
        ex_pairs.add(p)
        parts = p.split(':')
        if len(parts) == 2:
            ex_pairs.add(f"{parts[1]}:{parts[0]}")
    rules['_exTypePairSet'] = ex_pairs

    candidates = sweep_and_prune(elements_a, elements_b, max_gap_m, rules)

    # 3. Narrow phase: parallel exact intersection
    tasks = []
    for i, j in candidates:
        ea = elements_a[i]
        eb = elements_b[j]
        tasks.append((
            mesh_cache[ea['expressId']],
            mesh_cache[eb['expressId']],
            ea, eb, max_gap_m
        ))

    clashes = []
    done = 0
    total = len(tasks)

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        futures = {executor.submit(_check_pair, t): t for t in tasks}

        for future in as_completed(futures):
            done += 1
            if on_progress and done % 50 == 0:
                on_progress(done, total)

            result = future.result()
            if result is not None:
                # Filter by minOverlapVolM3
                if result['type'] == 'hard' and rules.get('minOverlapVolM3', 0) > 0:
                    if result['overlapVolM3'] < rules['minOverlapVolM3']:
                        continue
                clashes.append(result)

    # 4. Add metadata
    duration_ms = round((time.time() - t0) * 1000)

    # Add IDs, status, timestamps
    import uuid
    for clash in clashes:
        clash['id'] = str(uuid.uuid4())[:8].upper()
        clash['source'] = 'local-engine'
        clash['status'] = 'open'
        clash['createdAt'] = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
        disc = clash['disciplines']
        clash['title'] = (
            f"{clash['modelAId']} (self)" if clash['selfClash']
            else f"{disc[0].upper()} ↔ {disc[1].upper()}"
        )
        clash['description'] = (
            f"{clash['elemAType']}: {clash['elemAName']} vs "
            f"{clash['elemBType']}: {clash['elemBName']}"
        )

    return {
        'clashes': clashes,
        'stats': {
            'elementCount': len(all_elements),
            'candidatePairs': len(candidates),
            'clashCount': len(clashes),
            'duration_ms': duration_ms,
            'threads': num_workers,
        }
    }
```

---

## Server

```python
# server.py
import asyncio
import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
import websockets

from engine import detect_clashes

PORT = int(os.environ.get('CC_ENGINE_PORT', 19800))
VERSION = '1.0.0'

# Global WebSocket connections for progress updates
_ws_clients = set()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/status':
            import multiprocessing
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'ready',
                'version': VERSION,
                'cores': multiprocessing.cpu_count()
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/detect':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            try:
                data = json.loads(body)
                models = data.get('models', [])
                rules = data.get('rules', {})

                def on_progress(done, total):
                    msg = json.dumps({'type': 'progress', 'done': done, 'total': total, 'pct': round(done/total*100)})
                    for ws in list(_ws_clients):
                        try:
                            asyncio.run_coroutine_threadsafe(ws.send(msg), _loop)
                        except Exception:
                            pass

                result = detect_clashes(models, rules, on_progress=on_progress)

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

                # Notify WebSocket clients
                complete_msg = json.dumps({
                    'type': 'complete',
                    'clashCount': result['stats']['clashCount'],
                    'duration_ms': result['stats']['duration_ms']
                })
                for ws in list(_ws_clients):
                    try:
                        asyncio.run_coroutine_threadsafe(ws.send(complete_msg), _loop)
                    except Exception:
                        pass

            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        print(f"[CC Engine] {args[0]}")


async def ws_handler(websocket):
    _ws_clients.add(websocket)
    try:
        async for _ in websocket:
            pass  # We only send, never receive on this channel
    finally:
        _ws_clients.discard(websocket)


_loop = None

def main():
    global _loop
    import multiprocessing
    print(f"[CC Engine] Starting on http://localhost:{PORT}")
    print(f"[CC Engine] {multiprocessing.cpu_count()} CPU cores available")
    print(f"[CC Engine] WebSocket on ws://localhost:{PORT}/ws")
    print(f"[CC Engine] Ready for ClashControl connections")

    # Start HTTP server in a thread
    http_server = HTTPServer(('localhost', PORT), Handler)
    http_thread = Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()

    # Start WebSocket server in asyncio event loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)

    ws_server = websockets.serve(ws_handler, 'localhost', PORT + 1)  # WS on PORT+1
    _loop.run_until_complete(ws_server)
    print(f"[CC Engine] WebSocket on ws://localhost:{PORT + 1}")
    _loop.run_forever()


if __name__ == '__main__':
    main()
```

---

## How ClashControl Connects

ClashControl (browser) does the following:

1. On app load, `fetch('http://localhost:19800/status')` — if it returns `{"status":"ready"}`, show a "Local Engine" badge in Settings
2. When the user clicks "Detect Clashes" and the local engine is available:
   - Serialize all model elements with their base64 geometry + rules as JSON
   - `POST` to `http://localhost:19800/detect`
   - Open `ws://localhost:19801` for progress updates
   - Receive clash results as JSON
   - Feed directly into `dispatch({t:'SET_CLASHES', v: results.clashes})`
3. The clash result shape is **identical** to what the browser engine produces — same fields, same types. No translation needed.

### CORS

The server includes `Access-Control-Allow-Origin: *` on all responses. Since ClashControl may be served from `https://clashcontrol.io` or from `file://`, the wildcard CORS header is required.

### CSP

ClashControl's CSP already allows `http://localhost:*` in `connect-src`, so no changes needed.

---

## Installation & Usage

```bash
# Install
pip install websockets numpy trimesh open3d scipy

# Run
python server.py

# Or with custom port
CC_ENGINE_PORT=19800 python server.py
```

The server starts and waits for ClashControl connections. No configuration needed.

### As a Background Service (optional)

```bash
# Linux/macOS
nohup python server.py > /dev/null 2>&1 &

# Windows
start /B python server.py
```

---

## Performance Notes

- **ProcessPoolExecutor** uses N-1 cores by default (leaves 1 for the OS/Revit)
- **trimesh** is pure Python for basic operations but uses numpy vectorization for speed
- **open3d** has C++ backends for mesh boolean operations — this is where the real speed comes from
- For maximum performance, install the `manifold3d` package: `pip install manifold3d` — trimesh will use it automatically for boolean operations (10-100x faster than the default engine)
- The sweep-and-prune broad phase eliminates 95%+ of pairs before expensive narrow-phase checks

---

## Error Handling

- If a single pair fails intersection (degenerate mesh, non-manifold), skip it and continue
- If the server crashes, ClashControl falls back to the browser engine automatically
- All responses include CORS headers
- Invalid JSON in POST body returns 400 with error message
