//! ClashControl WASM Clash Detection Engine
//!
//! BVH-accelerated mesh-mesh intersection and minimum distance queries.
//! Designed to be called from JavaScript via wasm-bindgen with Float32Array
//! triangle data (flat xyz, 9 floats per triangle).
//!
//! Two API levels:
//! 1. High-level: `mesh_intersect` / `mesh_min_distance` — build BVH internally
//! 2. Low-level: `Engine` struct — pre-build BVH, reuse across multiple queries
//!
//! ── Parity contract ──────────────────────────────────────────────────
//! `mesh_intersect_raw` / `batch_intersect_raw` / `mesh_min_distance` are
//! ports of the JS reference (`_triTriTest`/`_buildBVHNode`/`_bvhTraverseAll`
//! in index.html) designed for bit-identical output: same f64 arithmetic
//! order, same BVH shape, same point cap semantics. They return the RAW
//! point list (or, for min-distance, the raw closest pair) so index.html can
//! run the *same* JS post-processing function (`_pointInBothBoxes` filter +
//! averaging) over both the JS-collected and WASM-collected points — see
//! `_meshesIntersect` / `_postProcessIntersectPoints` in index.html.
//!
//! `mesh_intersect` / `batch_intersect` (no `_raw` suffix) are kept for
//! backward API compatibility with existing callers/tests: same underlying
//! (now-correct) tri-tri + BVH code, but pre-averaged into a centroid with
//! no AABB-margin filtering (the original, pre-fix contract of this crate).

use wasm_bindgen::prelude::*;

mod bvh;
mod tri_tri;
mod spatial_hash;
mod broadphase;

use bvh::BvhNode;
use spatial_hash::SpatialHash;

pub use broadphase::sweep_and_prune;

// Legacy (pre-fix) raw-point cap, preserved for `mesh_intersect`/`batch_intersect`
// backward compatibility: point-count semantics ("72 points"), not float count.
const LEGACY_MAX_PTS_FLOATS: usize = 72 * 3;
// JS reference cap for `_meshesIntersect`'s real collection pass: `pts.length
// >= 24` where each hit pushes 3 floats — i.e. an 8-point cap. This is a RAW
// FLOAT COUNT, matching JS exactly (see bvh::traverse_pair doc comment).
const JS_COLLECT_MAX_PTS_FLOATS: usize = 24;

fn centroid_f32(pts: &[f64]) -> (f32, f32, f32) {
    let n = (pts.len() / 3) as f64;
    let mut sx = 0.0f64;
    let mut sy = 0.0f64;
    let mut sz = 0.0f64;
    for i in (0..pts.len()).step_by(3) {
        sx += pts[i];
        sy += pts[i + 1];
        sz += pts[i + 2];
    }
    ((sx / n) as f32, (sy / n) as f32, (sz / n) as f32)
}

// ── High-level API (stateless, build BVH each call) ─────────────────

/// Test if two triangle meshes intersect (hard clash detection).
/// Legacy/back-compat entry point — pre-averaged centroid, no AABB filter.
/// Prefer `mesh_intersect_raw` for parity with the JS reference.
#[wasm_bindgen]
pub fn mesh_intersect(tris_a: &[f32], tris_b: &[f32], _epsilon: f32) -> Vec<f32> {
    if tris_a.len() < 9 || tris_b.len() < 9 {
        return Vec::new();
    }
    let bvh_a = BvhNode::build(tris_a);
    let bvh_b = BvhNode::build(tris_b);

    let mut pts: Vec<f64> = Vec::new();
    let mut max_depth: f64 = 0.0;

    bvh::traverse_pair(&bvh_a, tris_a, &bvh_b, tris_b, &mut pts, &mut max_depth, LEGACY_MAX_PTS_FLOATS, false);

    if pts.is_empty() {
        return Vec::new();
    }
    let (cx, cy, cz) = centroid_f32(&pts);
    vec![cx, cy, cz, max_depth as f32]
}

/// Test if two triangle meshes intersect, mirroring the JS reference's
/// `_bvhTraverseAll` collection pass EXACTLY (max 8 points, i.e. `pts.length
/// < 24` floats). Returns the RAW point list with `max_depth` appended as
/// the last element, or an empty Vec if there is no BVH-level hit at all.
/// index.html must run the same `_pointInBothBoxes` filter + averaging over
/// this that it runs over the JS-collected points (see
/// `_postProcessIntersectPoints` in index.html).
#[wasm_bindgen]
pub fn mesh_intersect_raw(tris_a: &[f32], tris_b: &[f32]) -> Vec<f64> {
    if tris_a.len() < 9 || tris_b.len() < 9 {
        return Vec::new();
    }
    let bvh_a = BvhNode::build(tris_a);
    let bvh_b = BvhNode::build(tris_b);

    let mut pts: Vec<f64> = Vec::new();
    let mut max_depth: f64 = 0.0;
    bvh::traverse_pair(&bvh_a, tris_a, &bvh_b, tris_b, &mut pts, &mut max_depth, JS_COLLECT_MAX_PTS_FLOATS, false);

    if pts.is_empty() {
        return Vec::new();
    }
    pts.push(max_depth);
    pts
}

/// Compute minimum vertex-to-vertex distance between two meshes.
/// Bit-identical port of `_meshMinDist`'s JS-fallback spatial-hash walk
/// (same cell size fallback, same ceil-based step, same f64 arithmetic,
/// same tie-breaking via "first strictly smaller wins").
///
/// `verts_a` and `verts_b` are flat Float32Arrays: [x0,y0,z0, x1,y1,z1, ...].
/// `max_dist` is the threshold (a JS number, so f64) — used ONLY to size the
/// grid cell (falls back to 0.05 when `max_dist` is 0, exactly like JS's
/// `thresholdM || 0.05`), exactly like the JS reference AS ACTUALLY CALLED:
/// index.html's one call site (`_processCandidate`) always passes an
/// `outPair` buffer, and `_meshMinDist`'s own threshold-cutoff early-return
/// (`if (minSq <= tSq && !outPair) return ...`) is therefore DEAD CODE in
/// production — with `outPair` truthy, `_meshMinDist` always returns the
/// real `Math.sqrt(minSq)`, however large, and leaves the threshold
/// comparison to the caller (`geoDist<=pairGapM`). Enforcing our own
/// threshold cutoff here would silently diverge from that real behavior.
///
/// Returns [distance, ax, ay, az, bx, by, bz] always — `distance` is
/// `Infinity` (and the pair all zeros, matching JS's zero-initialized
/// outPair) only when NO vertex was found near ANY sampled query point
/// (sparse/disjoint meshes relative to the grid cell size), or when either
/// input is empty (a single-element `[Infinity]`, matching JS's early
/// `if (!vA.length || !vB.length) return Infinity` with no outPair touch).
#[wasm_bindgen]
pub fn mesh_min_distance(verts_a: &[f32], verts_b: &[f32], max_dist: f64) -> Vec<f64> {
    if verts_a.len() < 3 || verts_b.len() < 3 {
        return vec![f64::INFINITY];
    }

    // JS `thresholdM || 0.05`: NaN is falsy in JS (unlike Rust's `!= 0.0`,
    // under which NaN != 0.0 is true), so a NaN threshold must also fall
    // back to 0.05 here to match.
    let cs = (if max_dist != 0.0 && !max_dist.is_nan() { max_dist } else { 0.05 }).max(0.02);

    // Insert the smaller mesh into the spatial hash, query the larger —
    // matches JS's `vA.length <= vB.length` selection exactly.
    let (grid_verts, query_verts) = if verts_a.len() <= verts_b.len() {
        (verts_a, verts_b)
    } else {
        (verts_b, verts_a)
    };

    let mut grid = SpatialHash::new(cs);
    grid.insert(grid_verts);

    let mut min_sq: f64 = f64::INFINITY;
    let mut best_q = [0.0f64; 3];
    let mut best_g = [0.0f64; 3];

    // `queryVerts.length > 30000 ? 3 * Math.ceil(queryVerts.length / 30000) : 3`
    let step: usize = if query_verts.len() > 30000 {
        3 * ((query_verts.len() + 29999) / 30000)
    } else {
        3
    };

    let mut i = 0usize;
    while i < query_verts.len() {
        if i + 2 >= query_verts.len() {
            break;
        }
        let px = query_verts[i] as f64;
        let py = query_verts[i + 1] as f64;
        let pz = query_verts[i + 2] as f64;
        if let Some((d2, gx, gy, gz)) = grid.min_dist_sq(px, py, pz, grid_verts) {
            if d2 < min_sq {
                min_sq = d2;
                best_q = [px, py, pz];
                best_g = [gx, gy, gz];
            }
        }
        i += step;
    }

    // Always 7 elements — `min_sq.sqrt()` is already Infinity when nothing
    // was found (best_q/best_g stay at their zero-initialized default, same
    // as JS's outPair). No threshold cutoff — see the doc comment above.
    vec![
        min_sq.sqrt(),
        best_q[0], best_q[1], best_q[2],
        best_g[0], best_g[1], best_g[2],
    ]
}

/// Batch intersection test: test one mesh against many.
/// Legacy/back-compat entry point (pre-averaged centroids, no AABB filter).
/// Prefer `batch_intersect_raw` for parity with the JS reference.
///
/// `tris_a` is the reference mesh. `all_tris` is a flat array of ALL triangle
/// data for multiple meshes. `offsets` is [start0, end0, start1, end1, ...]
/// indexing into all_tris (in floats, not triangles). Each pair (start, end)
/// defines one mesh.
///
/// Returns a flat array of results: [meshIdx, cx, cy, cz, depth, ...]
/// Only includes meshes that intersect.
#[wasm_bindgen]
pub fn batch_intersect(tris_a: &[f32], all_tris: &[f32], offsets: &[u32], _epsilon: f32) -> Vec<f32> {
    if tris_a.len() < 9 || offsets.len() < 2 {
        return Vec::new();
    }
    let bvh_a = BvhNode::build(tris_a);
    let mut results: Vec<f32> = Vec::new();

    let n_meshes = offsets.len() / 2;
    for m in 0..n_meshes {
        let start = offsets[m * 2] as usize;
        let end = offsets[m * 2 + 1] as usize;
        if end <= start || end > all_tris.len() || (end - start) < 9 {
            continue;
        }
        let tris_b = &all_tris[start..end];
        let bvh_b = BvhNode::build(tris_b);

        let mut pts: Vec<f64> = Vec::new();
        let mut max_depth: f64 = 0.0;
        bvh::traverse_pair(&bvh_a, tris_a, &bvh_b, tris_b, &mut pts, &mut max_depth, LEGACY_MAX_PTS_FLOATS, false);

        if !pts.is_empty() {
            let (cx, cy, cz) = centroid_f32(&pts);
            results.push(m as f32);
            results.push(cx);
            results.push(cy);
            results.push(cz);
            results.push(max_depth as f32);
        }
    }

    results
}

/// Batch intersection, raw-point variant for parity with `_runBatch`'s JS
/// path: same BVH traversal/cap as `mesh_intersect_raw`, but for every mesh
/// in `offsets` (even ones with zero hits, so the caller can populate a
/// pair-result cache with confirmed misses, not just hits).
///
/// Returns a flat f64 array of records, one per valid mesh (invalid offset
/// ranges are skipped, matching `mesh_intersect_raw`'s empty-input miss):
///   [meshIdx, maxDepth, nPtsFloats, x0,y0,z0, x1,y1,z1, ...]
/// repeated per mesh. `nPtsFloats` is 0 for a confirmed BVH-level miss.
#[wasm_bindgen]
pub fn batch_intersect_raw(tris_a: &[f32], all_tris: &[f32], offsets: &[u32]) -> Vec<f64> {
    if tris_a.len() < 9 || offsets.len() < 2 {
        return Vec::new();
    }
    let bvh_a = BvhNode::build(tris_a);
    let mut out: Vec<f64> = Vec::new();

    let n_meshes = offsets.len() / 2;
    for m in 0..n_meshes {
        let start = offsets[m * 2] as usize;
        let end = offsets[m * 2 + 1] as usize;
        if end <= start || end > all_tris.len() || (end - start) < 9 {
            continue;
        }
        let tris_b = &all_tris[start..end];
        let bvh_b = BvhNode::build(tris_b);

        let mut pts: Vec<f64> = Vec::new();
        let mut max_depth: f64 = 0.0;
        bvh::traverse_pair(&bvh_a, tris_a, &bvh_b, tris_b, &mut pts, &mut max_depth, JS_COLLECT_MAX_PTS_FLOATS, false);

        out.push(m as f64);
        out.push(max_depth);
        out.push(pts.len() as f64);
        out.extend_from_slice(&pts);
    }

    out
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_tri_a() -> Vec<f32> {
        // Triangle at origin in XY plane
        vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    }

    fn unit_tri_b_intersecting() -> Vec<f32> {
        // Triangle piercing through the XY-plane tri_a along Z
        vec![0.2, 0.2, -1.0, 0.8, 0.2, -1.0, 0.5, 0.2, 1.0]
    }

    fn unit_tri_b_separate() -> Vec<f32> {
        // Triangle far away
        vec![10.0, 10.0, 10.0, 11.0, 10.0, 10.0, 10.0, 11.0, 10.0]
    }

    #[test]
    fn test_intersecting_tris() {
        let result = mesh_intersect(&unit_tri_a(), &unit_tri_b_intersecting(), 1e-6);
        assert!(!result.is_empty(), "Should detect intersection");
        assert_eq!(result.len(), 4); // cx, cy, cz, depth
    }

    #[test]
    fn test_separate_tris() {
        let result = mesh_intersect(&unit_tri_a(), &unit_tri_b_separate(), 1e-6);
        assert!(result.is_empty(), "Should not detect intersection");
    }

    #[test]
    fn test_intersect_raw_matches_legacy_centroid_when_unfiltered() {
        let raw = mesh_intersect_raw(&unit_tri_a(), &unit_tri_b_intersecting());
        assert!(!raw.is_empty());
        let depth = *raw.last().unwrap();
        let pts = &raw[..raw.len() - 1];
        assert!(pts.len() % 3 == 0);
        assert!(depth > 0.0);
    }

    #[test]
    fn test_batch_intersect_raw_reports_every_valid_mesh() {
        let a = unit_tri_a();
        let hit = unit_tri_b_intersecting();
        let miss = unit_tri_b_separate();
        let mut all = Vec::new();
        all.extend_from_slice(&hit);
        all.extend_from_slice(&miss);
        let offsets: Vec<u32> = vec![0, 9, 9, 18];
        let raw = batch_intersect_raw(&a, &all, &offsets);
        // Two records: mesh 0 (hit, nPts>0) and mesh 1 (miss, nPts==0)
        assert_eq!(raw[0], 0.0);
        assert!(raw[2] > 0.0, "mesh 0 should have raw points");
        let rec0_len = 3 + (raw[2] as usize);
        assert_eq!(raw[rec0_len], 1.0);
        assert_eq!(raw[rec0_len + 2], 0.0, "mesh 1 should have zero raw points (confirmed miss)");
    }

    #[test]
    fn test_min_distance_close() {
        let verts_a = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let verts_b = vec![0.0, 0.0, 0.1, 1.0, 0.0, 0.1, 0.0, 1.0, 0.1];
        let result = mesh_min_distance(&verts_a, &verts_b, 1.0);
        assert!(result.len() == 7);
        assert!((result[0] - 0.1).abs() < 0.01, "Distance should be ~0.1, got {}", result[0]);
    }

    #[test]
    fn test_min_distance_far() {
        // JS `_meshMinDist`, as actually called (outPair always passed), has
        // NO threshold cutoff — a pair the grid genuinely can't find within
        // its 3x3x3 cell neighborhood still returns Infinity, but because
        // nothing was found, not because of an explicit distance check.
        let verts_a = vec![0.0, 0.0, 0.0];
        let verts_b = vec![100.0, 100.0, 100.0];
        let result = mesh_min_distance(&verts_a, &verts_b, 1.0);
        assert_eq!(result.len(), 7);
        assert!(result[0].is_infinite(), "Should be beyond the grid's search neighborhood");
    }

    #[test]
    fn test_min_distance_zero_threshold_falls_back_to_005_cell() {
        // JS: `thresholdM || 0.05` — max_dist=0 must not divide-by-zero the
        // cell size. With no threshold cutoff (see mesh_min_distance's doc
        // comment), a close pair is still found and its real distance
        // returned — the 0.05 fallback only affects the grid cell size, not
        // whether a result is reported.
        let verts_a = vec![0.0, 0.0, 0.0];
        let verts_b = vec![0.01, 0.0, 0.0];
        let result = mesh_min_distance(&verts_a, &verts_b, 0.0);
        assert_eq!(result.len(), 7);
        assert!((result[0] - 0.01).abs() < 1e-9, "expected ~0.01, got {}", result[0]);
    }

    #[test]
    fn test_empty_input() {
        assert!(mesh_intersect(&[], &[0.0; 9], 1e-6).is_empty());
        assert!(mesh_min_distance(&[], &[0.0; 3], 1.0)[0].is_infinite());
    }
}
