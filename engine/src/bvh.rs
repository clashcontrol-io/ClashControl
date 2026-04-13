//! BVH (Bounding Volume Hierarchy) for triangle meshes.
//! Direct Rust port of ClashControl's _buildBVHNode / _bvhTraverseAll.
//! Uses AABB nodes with median-split on the longest axis.

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

        // Sort the sub-range by triangle centroid on split axis
        let sub = &mut indices[lo..hi];
        sub.sort_unstable_by(|&a, &b| {
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
    a.mn[0] <= b.mx[0] && a.mx[0] >= b.mn[0]
        && a.mn[1] <= b.mx[1] && a.mx[1] >= b.mn[1]
        && a.mn[2] <= b.mx[2] && a.mx[2] >= b.mn[2]
}

/// Dual-tree BVH traversal. Finds intersection points between two triangle meshes.
/// Results are pushed into `pts` as [x, y, z, x, y, z, ...].
/// `max_depth` tracks the maximum penetration depth.
/// `max_pts` limits the number of contact points collected (in coordinate count, i.e. pts.len()/3).
pub fn traverse_pair(
    na: &BvhNode,
    tris_a: &[f32],
    nb: &BvhNode,
    tris_b: &[f32],
    eps: f32,
    pts: &mut Vec<f32>,
    max_depth: &mut f32,
    max_pts: usize,
) {
    if pts.len() / 3 >= max_pts {
        return;
    }
    if !aabb_overlap(na, nb) {
        return;
    }

    match (&na.kind, &nb.kind) {
        (BvhKind::Leaf { indices: idx_a }, BvhKind::Leaf { indices: idx_b }) => {
            // Both leaves: test all triangle pairs
            for &ia in idx_a {
                if pts.len() / 3 >= max_pts {
                    return;
                }
                for &ib in idx_b {
                    if pts.len() / 3 >= max_pts {
                        return;
                    }
                    if let Some((cx, cy, cz, depth)) =
                        tri_tri::tri_tri_test(tris_a, ia * 9, tris_b, ib * 9, eps)
                    {
                        pts.push(cx);
                        pts.push(cy);
                        pts.push(cz);
                        if depth > *max_depth {
                            *max_depth = depth;
                        }
                    }
                }
            }
        }
        (BvhKind::Inner { left: la, right: ra, count: ca }, _)
            if matches!(nb.kind, BvhKind::Leaf { .. }) || {
                if let BvhKind::Inner { count: cb, .. } = &nb.kind {
                    *ca >= *cb
                } else {
                    true
                }
            } =>
        {
            // Split the larger node (A)
            traverse_pair(la, tris_a, nb, tris_b, eps, pts, max_depth, max_pts);
            traverse_pair(ra, tris_a, nb, tris_b, eps, pts, max_depth, max_pts);
        }
        (_, BvhKind::Inner { left: lb, right: rb, .. }) => {
            // Split node B
            traverse_pair(na, tris_a, lb, tris_b, eps, pts, max_depth, max_pts);
            traverse_pair(na, tris_a, rb, tris_b, eps, pts, max_depth, max_pts);
        }
        _ => {} // shouldn't happen
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
}
