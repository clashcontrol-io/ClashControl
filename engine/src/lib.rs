//! ClashControl WASM Clash Detection Engine
//!
//! BVH-accelerated mesh-mesh intersection and minimum distance queries.
//! Designed to be called from JavaScript via wasm-bindgen with Float32Array
//! triangle data (flat xyz, 9 floats per triangle).
//!
//! Two API levels:
//! 1. High-level: `mesh_intersect` / `mesh_min_distance` — build BVH internally
//! 2. Low-level: `Engine` struct — pre-build BVH, reuse across multiple queries

use wasm_bindgen::prelude::*;

mod bvh;
mod tri_tri;
mod spatial_hash;

use bvh::BvhNode;
use spatial_hash::SpatialHash;

// ── High-level API (stateless, build BVH each call) ─────────────────

/// Test if two triangle meshes intersect (hard clash detection).
///
/// `tris_a` and `tris_b` are flat Float32Arrays: [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...].
/// Length must be divisible by 9 (3 vertices × 3 coords per triangle).
///
/// Returns a Float32Array of [cx, cy, cz, depth] if intersecting, or empty if not.
/// cx/cy/cz = centroid of intersection points, depth = max penetration.
#[wasm_bindgen]
pub fn mesh_intersect(tris_a: &[f32], tris_b: &[f32], epsilon: f32) -> Vec<f32> {
    if tris_a.len() < 9 || tris_b.len() < 9 {
        return Vec::new();
    }
    let bvh_a = BvhNode::build(tris_a);
    let bvh_b = BvhNode::build(tris_b);

    let mut pts: Vec<f32> = Vec::new();
    let mut max_depth: f32 = 0.0;
    let eps = if epsilon > 0.0 { epsilon } else { 1e-6 };

    bvh::traverse_pair(&bvh_a, tris_a, &bvh_b, tris_b, eps, &mut pts, &mut max_depth, 72);

    if pts.is_empty() {
        return Vec::new();
    }

    // Compute centroid of intersection points
    let n = (pts.len() / 3) as f32;
    let mut sx: f32 = 0.0;
    let mut sy: f32 = 0.0;
    let mut sz: f32 = 0.0;
    for i in (0..pts.len()).step_by(3) {
        sx += pts[i];
        sy += pts[i + 1];
        sz += pts[i + 2];
    }
    vec![sx / n, sy / n, sz / n, max_depth]
}

/// Compute minimum vertex-to-vertex distance between two meshes.
///
/// `verts_a` and `verts_b` are flat Float32Arrays: [x0,y0,z0, x1,y1,z1, ...].
/// Length must be divisible by 3.
/// `max_dist` is the threshold — returns f32::INFINITY if meshes are farther apart.
///
/// Returns a Float32Array of [distance, ax, ay, az, bx, by, bz] with the closest pair,
/// or [Infinity] if beyond threshold.
#[wasm_bindgen]
pub fn mesh_min_distance(verts_a: &[f32], verts_b: &[f32], max_dist: f32) -> Vec<f32> {
    if verts_a.len() < 3 || verts_b.len() < 3 {
        return vec![f32::INFINITY];
    }

    let cell_size = max_dist.max(0.02);

    // Insert the smaller mesh into the spatial hash, query the larger
    let (grid_verts, query_verts) = if verts_a.len() <= verts_b.len() {
        (verts_a, verts_b)
    } else {
        (verts_b, verts_a)
    };

    let mut grid = SpatialHash::new(cell_size);
    grid.insert(grid_verts);

    let threshold_sq = max_dist * max_dist;
    let mut min_sq: f32 = f32::INFINITY;
    let mut best_q = [0.0f32; 3];
    let mut best_g = [0.0f32; 3];

    // Adaptive step for large meshes (same as JS: cap at ~10k queries)
    let step = if query_verts.len() > 30000 {
        3 * ((query_verts.len() / 30000) + 1)
    } else {
        3
    };

    for i in (0..query_verts.len()).step_by(step) {
        if i + 2 >= query_verts.len() {
            break;
        }
        let px = query_verts[i];
        let py = query_verts[i + 1];
        let pz = query_verts[i + 2];
        if let Some((d2, gx, gy, gz)) = grid.min_dist_sq(px, py, pz, grid_verts) {
            if d2 < min_sq {
                min_sq = d2;
                best_q = [px, py, pz];
                best_g = [gx, gy, gz];
            }
        }
    }

    if min_sq > threshold_sq {
        return vec![f32::INFINITY];
    }

    vec![
        min_sq.sqrt(),
        best_q[0], best_q[1], best_q[2],
        best_g[0], best_g[1], best_g[2],
    ]
}

/// Batch intersection test: test one mesh against many.
/// `tris_a` is the reference mesh. `all_tris` is a flat array of ALL triangle data
/// for multiple meshes. `offsets` is [start0, end0, start1, end1, ...] indexing into all_tris
/// (in floats, not triangles). Each pair (start, end) defines one mesh.
///
/// Returns a flat array of results: [meshIdx, cx, cy, cz, depth, meshIdx, cx, cy, cz, depth, ...]
/// Only includes meshes that intersect.
#[wasm_bindgen]
pub fn batch_intersect(tris_a: &[f32], all_tris: &[f32], offsets: &[u32], epsilon: f32) -> Vec<f32> {
    if tris_a.len() < 9 || offsets.len() < 2 {
        return Vec::new();
    }
    let bvh_a = BvhNode::build(tris_a);
    let eps = if epsilon > 0.0 { epsilon } else { 1e-6 };
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

        let mut pts: Vec<f32> = Vec::new();
        let mut max_depth: f32 = 0.0;
        bvh::traverse_pair(&bvh_a, tris_a, &bvh_b, tris_b, eps, &mut pts, &mut max_depth, 72);

        if !pts.is_empty() {
            let n = (pts.len() / 3) as f32;
            let mut sx: f32 = 0.0;
            let mut sy: f32 = 0.0;
            let mut sz: f32 = 0.0;
            for i in (0..pts.len()).step_by(3) {
                sx += pts[i];
                sy += pts[i + 1];
                sz += pts[i + 2];
            }
            results.push(m as f32);
            results.push(sx / n);
            results.push(sy / n);
            results.push(sz / n);
            results.push(max_depth);
        }
    }

    results
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
    fn test_min_distance_close() {
        let verts_a = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let verts_b = vec![0.0, 0.0, 0.1, 1.0, 0.0, 0.1, 0.0, 1.0, 0.1];
        let result = mesh_min_distance(&verts_a, &verts_b, 1.0);
        assert!(result.len() == 7);
        assert!((result[0] - 0.1).abs() < 0.01, "Distance should be ~0.1, got {}", result[0]);
    }

    #[test]
    fn test_min_distance_far() {
        let verts_a = vec![0.0, 0.0, 0.0];
        let verts_b = vec![100.0, 100.0, 100.0];
        let result = mesh_min_distance(&verts_a, &verts_b, 1.0);
        assert_eq!(result.len(), 1);
        assert!(result[0].is_infinite(), "Should be beyond threshold");
    }

    #[test]
    fn test_empty_input() {
        assert!(mesh_intersect(&[], &[0.0; 9], 1e-6).is_empty());
        assert!(mesh_min_distance(&[], &[0.0; 3], 1.0)[0].is_infinite());
    }
}
