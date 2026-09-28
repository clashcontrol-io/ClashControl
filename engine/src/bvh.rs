//! BVH (Bounding Volume Hierarchy) for triangle meshes.
//! Operation-for-operation Rust port of ClashControl's `_buildBVHNode` /
//! `_bvhTraverseAll` (index.html, near lines 5729 and 5827).
//!
//! Faithfulness details that matter for bit-identical parity with JS:
//! - Leaf size <= 4 (LEAF_SIZE), matching `hi-lo <= 4`.
//! - The per-node sort is a STABLE sort on centroid-sum, matching V8's
//!   Array.prototype.sort (spec-guaranteed stable since ES2019). A ties
//!   between equal centroid sums must preserve prior (parent-level) order,
//!   or traversal — and therefore which points get collected first under
//!   the point-count cap — silently diverges from JS.
//! - `traverse_pair`'s `max_pts` is a RAW FLOAT COUNT (mirrors JS's
//!   `pts.length >= maxPts`, where each hit pushes 3 floats), not a point
//!   count. The JS call sites pass 3 (probe) and 24 (collect) — i.e. an
//!   8-point cap for the real collection pass, not 24 points.
//! - Split priority: leaf-vs-leaf pairs are fully tested; otherwise a leaf
//!   node is never the one split (it can't be), and between two inner
//!   nodes the one with the larger `cnt` is split, exactly mirroring
//!   `(nA.cnt||1) >= (nB.cnt||1)`.

use crate::tri_tri;

const LEAF_SIZE: usize = 4;

pub struct BvhNode {
    pub mn: [f32; 3],
    pub mx: [f32; 3],
    pub kind: BvhKind,
}

pub enum BvhKind {
    Leaf {
        indices: Vec<usize>, // triangle indices
    },
    Inner {
        left: Box<BvhNode>,
        right: Box<BvhNode>,
        count: usize,
    },
}

impl BvhNode {
    /// Build a BVH from flat triangle data (9 floats per triangle).
    pub fn build(tris: &[f32]) -> BvhNode {
        let n = tris.len() / 9;
        let mut indices: Vec<usize> = (0..n).collect();
        Self::build_recursive(tris, &mut indices, 0, n)
    }

    fn build_recursive(tris: &[f32], indices: &mut [usize], lo: usize, hi: usize) -> BvhNode {
        // Compute AABB
        let mut mn = [f32::INFINITY; 3];
        let mut mx = [f32::NEG_INFINITY; 3];
        for &idx in &indices[lo..hi] {
            let o = idx * 9;
            for v in 0..3 {
                for c in 0..3 {
                    let val = tris[o + v * 3 + c];
                    if val < mn[c] { mn[c] = val; }
                    if val > mx[c] { mx[c] = val; }
                }
            }
        }

        let count = hi - lo;
        if count <= LEAF_SIZE {
            return BvhNode {
                mn,
                mx,
                kind: BvhKind::Leaf {
                    indices: indices[lo..hi].to_vec(),
                },
            };
        }

        // Split on longest axis via median
        let dx = mx[0] - mn[0];
        let dy = mx[1] - mn[1];
        let dz = mx[2] - mn[2];
        let axis = if dx >= dy && dx >= dz {
            0
        } else if dy >= dz {
            1
        } else {
            2
        };

        // Sort the sub-range by triangle centroid-sum on the split axis.
        // STABLE sort — must match V8's stable Array.prototype.sort so
        // that ties (equal centroid sum) preserve incoming order exactly
        // as the JS reference's `indices.subarray(lo, hi).sort(...)` does.
        let sub = &mut indices[lo..hi];
        sub.sort_by(|&a, &b| {
            let ca = tris[a * 9 + axis] + tris[a * 9 + 3 + axis] + tris[a * 9 + 6 + axis];
            let cb = tris[b * 9 + axis] + tris[b * 9 + 3 + axis] + tris[b * 9 + 6 + axis];
            ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal)
        });

        let mid = (lo + hi) / 2;
        let left = Self::build_recursive(tris, indices, lo, mid);
        let right = Self::build_recursive(tris, indices, mid, hi);

        BvhNode {
            mn,
            mx,
            kind: BvhKind::Inner {
                left: Box::new(left),
                right: Box::new(right),
                count,
            },
        }
    }
}

/// Test if two AABBs overlap.
#[inline(always)]
fn aabb_overlap(a: &BvhNode, b: &BvhNode) -> bool {
    !(a.mn[0] > b.mx[0] || a.mx[0] < b.mn[0]
        || a.mn[1] > b.mx[1] || a.mx[1] < b.mn[1]
        || a.mn[2] > b.mx[2] || a.mx[2] < b.mn[2])
}

/// Dual-tree BVH traversal. Finds intersection points between two triangle meshes.
/// Results are pushed into `pts` as [x, y, z, x, y, z, ...] (f64, matching the
/// JS reference's world-space doubles).
/// `max_depth` tracks the maximum SAT-overlap length (`_triTriTest`'s 4th
/// return value), not true penetration depth — same semantics as JS.
/// `max_pts` is a RAW FLOAT COUNT cap on `pts.len()`, exactly like JS's
/// `pts.length >= maxPts` (NOT a point count — divide by 3 for that).
pub fn traverse_pair(
    na: &BvhNode,
    tris_a: &[f32],
    nb: &BvhNode,
    tris_b: &[f32],
    pts: &mut Vec<f64>,
    max_depth: &mut f64,
    max_pts: usize,
    early_exit: bool,
) {
    if pts.len() >= max_pts {
        return;
    }
    if !aabb_overlap(na, nb) {
        return;
    }

    let a_leaf = matches!(na.kind, BvhKind::Leaf { .. });
    let b_leaf = matches!(nb.kind, BvhKind::Leaf { .. });

    if a_leaf && b_leaf {
        let idx_a = match &na.kind { BvhKind::Leaf { indices } => indices, _ => unreachable!() };
        let idx_b = match &nb.kind { BvhKind::Leaf { indices } => indices, _ => unreachable!() };
        for &ia in idx_a {
            if pts.len() >= max_pts {
                return;
            }
            for &ib in idx_b {
                if pts.len() >= max_pts {
                    return;
                }
                if let Some((cx, cy, cz, depth)) =
                    tri_tri::tri_tri_test(tris_a, ia * 9, tris_b, ib * 9, 1e-6)
                {
                    pts.push(cx);
                    pts.push(cy);
                    pts.push(cz);
                    if depth > *max_depth {
                        *max_depth = depth;
                    }
                    if early_exit {
                        return;
                    }
                }
            }
        }
        return;
    }

    let count_a = match &na.kind { BvhKind::Inner { count, .. } => *count, _ => 1 };
    let count_b = match &nb.kind { BvhKind::Inner { count, .. } => *count, _ => 1 };

    if b_leaf || (!a_leaf && count_a >= count_b) {
        // Split the larger node (A) — B is a leaf and can't be split, or A
        // is at least as big as B.
        let (la, ra) = match &na.kind { BvhKind::Inner { left, right, .. } => (left, right), _ => unreachable!() };
        traverse_pair(la, tris_a, nb, tris_b, pts, max_depth, max_pts, early_exit);
        if early_exit && !pts.is_empty() {
            return;
        }
        traverse_pair(ra, tris_a, nb, tris_b, pts, max_depth, max_pts, early_exit);
    } else {
        let (lb, rb) = match &nb.kind { BvhKind::Inner { left, right, .. } => (left, right), _ => unreachable!() };
        traverse_pair(na, tris_a, lb, tris_b, pts, max_depth, max_pts, early_exit);
        if early_exit && !pts.is_empty() {
            return;
        }
        traverse_pair(na, tris_a, rb, tris_b, pts, max_depth, max_pts, early_exit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_single_tri() {
        let tris = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let bvh = BvhNode::build(&tris);
        assert!(bvh.mn[0] <= 0.0 && bvh.mx[0] >= 1.0);
    }

    #[test]
    fn test_build_many_tris() {
        // 10 triangles spread along X
        let mut tris = Vec::new();
        for i in 0..10 {
            let x = i as f32;
            tris.extend_from_slice(&[x, 0.0, 0.0, x + 1.0, 0.0, 0.0, x + 0.5, 1.0, 0.0]);
        }
        let bvh = BvhNode::build(&tris);
        assert!(bvh.mn[0] <= 0.0);
        assert!(bvh.mx[0] >= 10.0);
        match &bvh.kind {
            BvhKind::Inner { count, .. } => assert_eq!(*count, 10),
            _ => panic!("Expected inner node for 10 triangles"),
        }
    }

    #[test]
    fn test_traverse_max_pts_is_float_count_not_point_count() {
        // 20 triangles all mutually intersecting in a small overlapping bundle;
        // with max_pts=24 (float count) the collector must cap at 8 points (24
        // floats), not 24 points — this is the JS semantics being mirrored.
        let mut a_tris = Vec::new();
        let mut b_tris = Vec::new();
        for i in 0..20 {
            let x = i as f32 * 0.001;
            a_tris.extend_from_slice(&[x, 0.0, -1.0, x + 0.5, 0.0, -1.0, x, 0.5, 1.0]);
            b_tris.extend_from_slice(&[x, 0.0, -1.0, x + 0.5, 0.0, 1.0, x, 0.5, -1.0]);
        }
        let bvh_a = BvhNode::build(&a_tris);
        let bvh_b = BvhNode::build(&b_tris);
        let mut pts = Vec::new();
        let mut depth = 0.0;
        traverse_pair(&bvh_a, &a_tris, &bvh_b, &b_tris, &mut pts, &mut depth, 24, false);
        assert!(pts.len() <= 24, "pts (floats) must be capped at max_pts=24, got {}", pts.len());
    }
}
