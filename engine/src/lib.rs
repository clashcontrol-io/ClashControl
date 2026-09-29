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
//! `mesh_intersect_raw` / `batch_intersect_raw` are ports of the JS
//! reference (`_triTriTest`/`_buildBVHNode`/`_bvhTraverseAll` in
//! index.html); `mesh_min_distance` is a port of `_meshMinDist`'s JS
//! fallback (`_closestPtOnTri`/`_segSegDistSq`/`_triTriDistSq`/
//! `_bvhMinDistTraverse`, see `mesh_dist.rs`) — all designed for
//! bit-identical output: same f64 arithmetic order, same BVH shape, same
//! point cap / sub-test-order semantics. Intersect returns the RAW point
//! list (or, for min-distance, the raw closest pair) so index.html can run
//! the *same* JS post-processing function (`_pointInBothBoxes` filter +
//! averaging) over both the JS-collected and WASM-collected points — see
//! `_meshesIntersect` / `_postProcessIntersectPoints` in index.html.
//!
//! `mesh_intersect` / `batch_intersect` (no `_raw` suffix) are kept for
//! backward API compatibility with existing callers/tests: same underlying
//! (now-correct) tri-tri + BVH code, but pre-averaged into a centroid with
//! no AABB-margin filtering (the original, pre-fix contract of this crate).

use std::collections::HashMap;
use wasm_bindgen::prelude::*;

mod bvh;
mod tri_tri;
mod mesh_dist;
mod point_in_mesh;
mod broadphase;

use bvh::BvhNode;

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
    intersect_raw_prebuilt(&bvh_a, tris_a, &bvh_b, tris_b)
}

/// Shared body of `mesh_intersect_raw` / `Engine::intersect`: the traversal
/// over two ALREADY-BUILT BVHs. Both entry points funnel through this one
/// function so the stateless and the cached-BVH paths cannot diverge.
fn intersect_raw_prebuilt(bvh_a: &BvhNode, tris_a: &[f32], bvh_b: &BvhNode, tris_b: &[f32]) -> Vec<f64> {
    let mut pts: Vec<f64> = Vec::new();
    let mut max_depth: f64 = 0.0;
    bvh::traverse_pair(bvh_a, tris_a, bvh_b, tris_b, &mut pts, &mut max_depth, JS_COLLECT_MAX_PTS_FLOATS, false);

    if pts.is_empty() {
        return Vec::new();
    }
    pts.push(max_depth);
    pts
}

/// Compute the true minimum mesh-to-mesh distance between two triangle
/// meshes: point-to-triangle (both directions) + edge-edge, BVH-
/// accelerated. Bit-identical port of `_meshMinDist`'s JS fallback (see
/// `mesh_dist.rs` and index.html's `_bvhMinDistTraverse`/`_triTriDistSq`
/// doc comments) — same BVH shape as `mesh_intersect_raw` (bvh::BvhNode),
/// same sub-test order, same "first strictly smaller wins" tie-break.
///
/// Replaces the old vertex-to-vertex spatial-hash walk (`spatial_hash.rs`,
/// removed), which measured only how close two meshes' VERTICES were — a
/// point resting mid-face on the other mesh (no nearby vertex) reported
/// Infinity/far instead of its real (small) distance. See CLAUDE.md task
/// notes for the verified repro (a small device 0.1m above a 10x10m slab
/// center).
///
/// `tris_a` and `tris_b` are flat Float32Arrays, 9 floats per triangle
/// (matching `mesh_intersect_raw`'s wire shape) — NOT raw vertices.
///
/// Returns [distance, ax, ay, az, bx, by, bz] always — `distance` is
/// `Infinity` (single-element `[Infinity]`, no pair) only when either input
/// is empty; with two non-empty meshes a finite distance and closest-point
/// pair is always found (unlike the old grid walk, there is no "search
/// neighborhood" that can come up empty).
#[wasm_bindgen]
pub fn mesh_min_distance(tris_a: &[f32], tris_b: &[f32]) -> Vec<f64> {
    if tris_a.len() < 9 || tris_b.len() < 9 {
        return vec![f64::INFINITY];
    }
    let bvh_a = BvhNode::build(tris_a);
    let bvh_b = BvhNode::build(tris_b);
    min_distance_prebuilt(&bvh_a, tris_a, &bvh_b, tris_b)
}

/// Shared body of `mesh_min_distance` / `Engine::min_distance` over two
/// ALREADY-BUILT BVHs (see `intersect_raw_prebuilt`).
fn min_distance_prebuilt(bvh_a: &BvhNode, tris_a: &[f32], bvh_b: &BvhNode, tris_b: &[f32]) -> Vec<f64> {
    let mut best = f64::INFINITY;
    let mut out_a = [0.0f64; 3];
    let mut out_b = [0.0f64; 3];
    mesh_dist::traverse_min_dist(bvh_a, tris_a, bvh_b, tris_b, &mut best, &mut out_a, &mut out_b);
    mesh_dist::containment_fix(bvh_a, tris_a, bvh_b, tris_b, &mut best, &mut out_a, &mut out_b);
    vec![
        best.sqrt(),
        out_a[0], out_a[1], out_a[2],
        out_b[0], out_b[1], out_b[2],
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

// ── Stateful API: registered meshes with cached BVHs ─────────────────

struct RegisteredMesh {
    tris: Vec<f32>,
    /// `None` when the mesh has fewer than 9 floats (no triangle) — the free
    /// functions treat that as an empty input (no hit / Infinity distance),
    /// so registered-empty meshes behave identically.
    bvh: Option<BvhNode>,
}

/// Registry of meshes whose triangle data and BVH are built ONCE and reused
/// across many pair queries. Every query goes through exactly the same
/// internals as the stateless `mesh_intersect_raw` / `mesh_min_distance`
/// (`intersect_raw_prebuilt` / `min_distance_prebuilt`), and `BvhNode::build`
/// is a pure function of the triangle data, so results are bit-identical to
/// the free functions (and therefore to the JS reference).
#[wasm_bindgen]
pub struct Engine {
    meshes: HashMap<u32, RegisteredMesh>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { meshes: HashMap::new() }
    }

    /// Register (or replace) mesh `id`: copies `tris` (9 floats/triangle) and
    /// builds its BVH with the same code the free functions use.
    pub fn register(&mut self, id: u32, tris: &[f32]) {
        let bvh = if tris.len() < 9 { None } else { Some(BvhNode::build(tris)) };
        self.meshes.insert(id, RegisteredMesh { tris: tris.to_vec(), bvh });
    }

    /// Drop mesh `id`. Returns whether it was registered.
    pub fn unregister(&mut self, id: u32) -> bool {
        self.meshes.remove(&id).is_some()
    }

    /// Drop every registered mesh.
    pub fn clear(&mut self) {
        self.meshes.clear();
    }

    pub fn has(&self, id: u32) -> bool {
        self.meshes.contains_key(&id)
    }

    /// Number of registered meshes.
    pub fn len(&self) -> u32 {
        self.meshes.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.meshes.is_empty()
    }

    /// Total registered triangle floats (for the JS side's memory budget).
    pub fn total_floats(&self) -> f64 {
        self.meshes.values().map(|m| m.tris.len() as f64).sum()
    }

    /// Same return value as `mesh_intersect_raw(tris(id_a), tris(id_b))`:
    /// the raw point list with `max_depth` appended, or an empty Vec on a
    /// miss / empty mesh. `None` (JS `undefined`) when either id is not
    /// registered, so a caller bug can never masquerade as "no clash".
    pub fn intersect(&self, id_a: u32, id_b: u32) -> Option<Vec<f64>> {
        let a = self.meshes.get(&id_a)?;
        let b = self.meshes.get(&id_b)?;
        match (&a.bvh, &b.bvh) {
            (Some(ba), Some(bb)) => Some(intersect_raw_prebuilt(ba, &a.tris, bb, &b.tris)),
            _ => Some(Vec::new()),
        }
    }

    /// Same return value as `mesh_min_distance(tris(id_a), tris(id_b))`
    /// (`[distance, ax,ay,az, bx,by,bz]`, or `[Infinity]` for an empty
    /// mesh). `None` when either id is not registered.
    pub fn min_distance(&self, id_a: u32, id_b: u32) -> Option<Vec<f64>> {
        let a = self.meshes.get(&id_a)?;
        let b = self.meshes.get(&id_b)?;
        match (&a.bvh, &b.bvh) {
            (Some(ba), Some(bb)) => Some(min_distance_prebuilt(ba, &a.tris, bb, &b.tris)),
            _ => Some(vec![f64::INFINITY]),
        }
    }
}

impl Default for Engine {
    fn default() -> Self {
        Engine::new()
    }
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
        let tri_a = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let tri_b = vec![0.0, 0.0, 0.1, 1.0, 0.0, 0.1, 0.0, 1.0, 0.1];
        let result = mesh_min_distance(&tri_a, &tri_b);
        assert!(result.len() == 7);
        assert!((result[0] - 0.1).abs() < 1e-6, "Distance should be 0.1, got {}", result[0]);
    }

    #[test]
    fn test_min_distance_device_above_slab() {
        // The verified bug this whole module fixes: vertex-to-vertex
        // distance would report this as far/Infinity since no vertex of
        // either triangle is near a vertex of the other.
        let slab = vec![-5.0, -5.0, 0.0, 5.0, -5.0, 0.0, -5.0, 5.0, 0.0];
        let device = vec![-0.1, -0.1, 0.1, 0.1, -0.1, 0.1, -0.1, 0.1, 0.1];
        let result = mesh_min_distance(&slab, &device);
        assert_eq!(result.len(), 7);
        assert!((result[0] - 0.1).abs() < 1e-6, "expected 0.1, got {}", result[0]);
    }

    // ── Engine (cached-BVH) parity with the free functions ──────────

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 40) as f32) / ((1u64 << 24) as f32)
        }
    }

    /// Triangle soup of `n` small triangles scattered in a `spread` cube at
    /// offset `off` (enough overlap between meshes to give hits AND misses).
    fn soup(rng: &mut Lcg, n: usize, off: f32, spread: f32) -> Vec<f32> {
        let mut t = Vec::with_capacity(n * 9);
        for _ in 0..n {
            let cx = off + rng.next() * spread;
            let cy = off + rng.next() * spread;
            let cz = off + rng.next() * spread;
            for _ in 0..3 {
                t.push(cx + (rng.next() - 0.5) * 0.8);
                t.push(cy + (rng.next() - 0.5) * 0.8);
                t.push(cz + (rng.next() - 0.5) * 0.8);
            }
        }
        t
    }

    #[test]
    fn engine_matches_free_functions_bit_for_bit() {
        let mut rng = Lcg(0xC1A5);
        let mut eng = Engine::new();
        let mut meshes: Vec<Vec<f32>> = Vec::new();
        for i in 0..12u32 {
            let n = 3 + (i as usize * 7) % 40;
            let m = soup(&mut rng, n, (i % 4) as f32 * 0.7, 3.0);
            eng.register(i, &m);
            meshes.push(m);
        }
        let mut hits = 0;
        for a in 0..12u32 {
            for b in 0..12u32 {
                let (ta, tb) = (&meshes[a as usize], &meshes[b as usize]);
                let want_i = mesh_intersect_raw(ta, tb);
                let got_i = eng.intersect(a, b).expect("registered");
                assert_eq!(want_i.len(), got_i.len());
                for (x, y) in want_i.iter().zip(got_i.iter()) {
                    assert_eq!(x.to_bits(), y.to_bits(), "intersect {a}x{b}");
                }
                if !want_i.is_empty() { hits += 1; }
                let want_d = mesh_min_distance(ta, tb);
                let got_d = eng.min_distance(a, b).expect("registered");
                assert_eq!(want_d.len(), got_d.len());
                for (x, y) in want_d.iter().zip(got_d.iter()) {
                    assert_eq!(x.to_bits(), y.to_bits(), "min_distance {a}x{b}");
                }
            }
        }
        assert!(hits > 10, "fixture must produce real hits, got {hits}");
    }

    #[test]
    fn engine_repeated_queries_are_stable_and_lifecycle_works() {
        let mut eng = Engine::new();
        assert!(eng.is_empty());
        eng.register(1, &unit_tri_a());
        eng.register(2, &unit_tri_b_intersecting());
        eng.register(3, &unit_tri_b_separate());
        assert_eq!(eng.len(), 3);
        let first = eng.intersect(1, 2).unwrap();
        assert!(!first.is_empty());
        for _ in 0..5 {
            assert_eq!(eng.intersect(1, 2).unwrap(), first, "repeat query must not drift");
        }
        assert!(eng.intersect(1, 3).unwrap().is_empty());
        // unregister -> unknown id is None (never a silent "no clash")
        assert!(eng.unregister(2));
        assert!(!eng.unregister(2));
        assert!(!eng.has(2));
        assert!(eng.intersect(1, 2).is_none());
        assert!(eng.min_distance(2, 1).is_none());
        // re-register under the same id with DIFFERENT data replaces it
        eng.register(2, &unit_tri_b_separate());
        assert!(eng.intersect(1, 2).unwrap().is_empty());
        eng.register(2, &unit_tri_b_intersecting());
        assert_eq!(eng.intersect(1, 2).unwrap(), first);
        assert_eq!(eng.total_floats(), 27.0);
        eng.clear();
        assert!(eng.is_empty());
        assert!(eng.intersect(1, 3).is_none());
    }

    #[test]
    fn engine_empty_mesh_matches_free_function_semantics() {
        let mut eng = Engine::new();
        eng.register(1, &[]);
        eng.register(2, &unit_tri_a());
        eng.register(3, &[0.0; 6]); // < 9 floats: still "empty"
        assert!(eng.intersect(1, 2).unwrap().is_empty());
        assert!(eng.intersect(2, 3).unwrap().is_empty());
        assert!(eng.min_distance(1, 2).unwrap()[0].is_infinite());
        assert_eq!(eng.min_distance(1, 2).unwrap().len(), mesh_min_distance(&[], &unit_tri_a()).len());
        assert!(eng.min_distance(2, 3).unwrap()[0].is_infinite());
    }

    #[test]
    fn engine_self_pair_matches_free_function() {
        let mut rng = Lcg(7);
        let m = soup(&mut rng, 30, 0.0, 2.0);
        let mut eng = Engine::new();
        eng.register(9, &m);
        assert_eq!(eng.intersect(9, 9).unwrap(), mesh_intersect_raw(&m, &m));
        assert_eq!(eng.min_distance(9, 9).unwrap(), mesh_min_distance(&m, &m));
    }

    #[test]
    fn test_empty_input() {
        assert!(mesh_intersect(&[], &[0.0; 9], 1e-6).is_empty());
        assert!(mesh_min_distance(&[], &[0.0; 9])[0].is_infinite());
        assert!(mesh_min_distance(&[0.0; 9], &[0.0; 3])[0].is_infinite());
    }
}
