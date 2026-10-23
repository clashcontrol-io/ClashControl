//! True mesh-to-mesh minimum distance (point-to-triangle both directions +
//! edge-edge), BVH-accelerated. Operation-for-operation Rust port of
//! `_closestPtOnTri` / `_segSegDistSq` / `_triTriDistSq` / `_aabbAabbDistSq`
//! / `_bvhMinDistTraverse` / `_meshMinDist` (index.html, near the "True
//! mesh-to-mesh minimum distance" comment) — designed for bit-identical
//! output given the same f64 inputs: same arithmetic order, same BVH shape
//! (bvh::BvhNode, shared with the intersect path), same sub-test order and
//! tie-break rule ("first strictly smaller wins").
//!
//! Replaces the old vertex-to-vertex spatial hash (`spatial_hash.rs`,
//! removed) — see CLAUDE.md task notes for the bug it had: a point resting
//! mid-face on another mesh (no vertex nearby) reported Infinity/far instead
//! of its real (small) distance.

use crate::bvh::{BvhKind, BvhNode};
use crate::tri_tri::tri_tri_test;

#[inline(always)]
fn clamp01(x: f64) -> f64 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

/// Closest point on a triangle to a point P (Ericson, "Real-Time Collision
/// Detection" §5.1.5 — barycentric-region method). Returns (dist_sq, point).
#[allow(clippy::too_many_arguments)]
fn closest_pt_on_tri(px: f64, py: f64, pz: f64, tris: &[f32], o9: usize) -> (f64, [f64; 3]) {
    let ax = tris[o9] as f64;
    let ay = tris[o9 + 1] as f64;
    let az = tris[o9 + 2] as f64;
    let bx = tris[o9 + 3] as f64;
    let by = tris[o9 + 4] as f64;
    let bz = tris[o9 + 5] as f64;
    let cx = tris[o9 + 6] as f64;
    let cy = tris[o9 + 7] as f64;
    let cz = tris[o9 + 8] as f64;

    let abx = bx - ax;
    let aby = by - ay;
    let abz = bz - az;
    let acx = cx - ax;
    let acy = cy - ay;
    let acz = cz - az;
    let apx = px - ax;
    let apy = py - ay;
    let apz = pz - az;
    let d1 = abx * apx + aby * apy + abz * apz;
    let d2 = acx * apx + acy * apy + acz * apz;
    if d1 <= 0.0 && d2 <= 0.0 {
        return (apx * apx + apy * apy + apz * apz, [ax, ay, az]);
    }
    let bpx = px - bx;
    let bpy = py - by;
    let bpz = pz - bz;
    let d3 = abx * bpx + aby * bpy + abz * bpz;
    let d4 = acx * bpx + acy * bpy + acz * bpz;
    if d3 >= 0.0 && d4 <= d3 {
        return (bpx * bpx + bpy * bpy + bpz * bpz, [bx, by, bz]);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        let qx = ax + abx * v;
        let qy = ay + aby * v;
        let qz = az + abz * v;
        let rx = qx - px;
        let ry = qy - py;
        let rz = qz - pz;
        return (rx * rx + ry * ry + rz * rz, [qx, qy, qz]);
    }
    let cpx = px - cx;
    let cpy = py - cy;
    let cpz = pz - cz;
    let d5 = abx * cpx + aby * cpy + abz * cpz;
    let d6 = acx * cpx + acy * cpy + acz * cpz;
    if d6 >= 0.0 && d5 <= d6 {
        return (cpx * cpx + cpy * cpy + cpz * cpz, [cx, cy, cz]);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        let qx = ax + acx * w;
        let qy = ay + acy * w;
        let qz = az + acz * w;
        let rx = qx - px;
        let ry = qy - py;
        let rz = qz - pz;
        return (rx * rx + ry * ry + rz * rz, [qx, qy, qz]);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        let qx = bx + (cx - bx) * w2;
        let qy = by + (cy - by) * w2;
        let qz = bz + (cz - bz) * w2;
        let rx = qx - px;
        let ry = qy - py;
        let rz = qz - pz;
        return (rx * rx + ry * ry + rz * rz, [qx, qy, qz]);
    }
    let denom = 1.0 / (va + vb + vc);
    let v2 = vb * denom;
    let w3 = vc * denom;
    let qx = ax + abx * v2 + acx * w3;
    let qy = ay + aby * v2 + acy * w3;
    let qz = az + abz * v2 + acz * w3;
    let rx = qx - px;
    let ry = qy - py;
    let rz = qz - pz;
    (rx * rx + ry * ry + rz * rz, [qx, qy, qz])
}

/// Closest points between two 3D segments (Ericson RTCD §5.1.9,
/// ClosestPtSegmentSegment). Returns (dist_sq, point_on_seg1, point_on_seg2).
#[allow(clippy::too_many_arguments)]
fn seg_seg_dist_sq(
    p1: [f64; 3],
    q1: [f64; 3],
    p2: [f64; 3],
    q2: [f64; 3],
) -> (f64, [f64; 3], [f64; 3]) {
    let d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]];
    let d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
    let r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
    let a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
    let e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
    let f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
    const EPS: f64 = 1e-15;
    let (s, t);
    if a <= EPS && e <= EPS {
        s = 0.0;
        t = 0.0;
    } else if a <= EPS {
        t = clamp01(f / e);
        s = 0.0;
    } else {
        let c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
        if e <= EPS {
            t = 0.0;
            s = clamp01(-c / a);
        } else {
            let b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
            let denom = a * e - b * b;
            let mut s2 = if denom != 0.0 { clamp01((b * f - c * e) / denom) } else { 0.0 };
            let mut t2 = (b * s2 + f) / e;
            if t2 < 0.0 {
                t2 = 0.0;
                s2 = clamp01(-c / a);
            } else if t2 > 1.0 {
                t2 = 1.0;
                s2 = clamp01((b - c) / a);
            }
            s = s2;
            t = t2;
        }
    }
    let c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
    let c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
    let dx = c1[0] - c2[0];
    let dy = c1[1] - c2[1];
    let dz = c1[2] - c2[2];
    (dx * dx + dy * dy + dz * dz, c1, c2)
}

/// Minimum distance between two triangles: 6 vertex-to-opposite-triangle
/// checks + 9 edge-edge checks, "first strictly smaller wins" — same fixed
/// order as the JS reference's `_triTriDistSq`. Returns (dist_sq, pt_a, pt_b).
pub fn tri_tri_dist_sq(tris_a: &[f32], oa9: usize, tris_b: &[f32], ob9: usize) -> (f64, [f64; 3], [f64; 3]) {
    tri_tri_dist_sq_ex(tris_a, oa9, tris_b, ob9, false)
}

/// `tri_tri_dist_sq` with JS `_triTriDistSq`'s `skipEE`: when the caller has
/// proven (`ee_lower_sq`) that no edge-edge sub-test can come out below its
/// running best, those 9 are not evaluated. The result then only serves the
/// caller's strict `d < best` test, which it decides exactly like the full
/// minimum (every skipped value is >= best, so a vertex test below best is
/// also the full minimum's first achiever; otherwise neither updates).
pub fn tri_tri_dist_sq_ex(tris_a: &[f32], oa9: usize, tris_b: &[f32], ob9: usize, skip_ee: bool) -> (f64, [f64; 3], [f64; 3]) {
    // Intersecting triangles (e.g. an edge of one piercing the other's
    // face) have true distance 0 — the 15-subtest point/edge distance
    // below is only valid for NON-intersecting triangles and otherwise
    // reports a spurious positive gap. Reuse the exact same tri-tri test
    // the hard-clash narrow phase uses (tri_tri::tri_tri_test), so
    // "distance 0" and "hard clash" agree on what counts as intersecting
    // (coplanar overlap policy included — see tri_tri_test's own doc).
    // Mirrors JS `_triTriDistSq`'s early-out.
    if let Some((cx, cy, cz, _depth)) = tri_tri_test(tris_a, oa9, tris_b, ob9, 0.0) {
        return (0.0, [cx, cy, cz], [cx, cy, cz]);
    }
    let a0 = [tris_a[oa9] as f64, tris_a[oa9 + 1] as f64, tris_a[oa9 + 2] as f64];
    let a1 = [tris_a[oa9 + 3] as f64, tris_a[oa9 + 4] as f64, tris_a[oa9 + 5] as f64];
    let a2 = [tris_a[oa9 + 6] as f64, tris_a[oa9 + 7] as f64, tris_a[oa9 + 8] as f64];
    let b0 = [tris_b[ob9] as f64, tris_b[ob9 + 1] as f64, tris_b[ob9 + 2] as f64];
    let b1 = [tris_b[ob9 + 3] as f64, tris_b[ob9 + 4] as f64, tris_b[ob9 + 5] as f64];
    let b2 = [tris_b[ob9 + 6] as f64, tris_b[ob9 + 7] as f64, tris_b[ob9 + 8] as f64];

    let mut best = f64::INFINITY;
    let mut out_a = [0.0f64; 3];
    let mut out_b = [0.0f64; 3];

    macro_rules! try_vert_tri {
        ($v:expr, $tris_other:expr, $o_other:expr, $vert_is_a:expr) => {
            let (d, p) = closest_pt_on_tri($v[0], $v[1], $v[2], $tris_other, $o_other);
            if d < best {
                best = d;
                if $vert_is_a {
                    out_a = $v;
                    out_b = p;
                } else {
                    out_b = $v;
                    out_a = p;
                }
            }
        };
    }
    try_vert_tri!(a0, tris_b, ob9, true);
    try_vert_tri!(a1, tris_b, ob9, true);
    try_vert_tri!(a2, tris_b, ob9, true);
    try_vert_tri!(b0, tris_a, oa9, false);
    try_vert_tri!(b1, tris_a, oa9, false);
    try_vert_tri!(b2, tris_a, oa9, false);
    if skip_ee {
        return (best, out_a, out_b);
    }

    macro_rules! try_edge_edge {
        ($ea0:expr, $ea1:expr, $eb0:expr, $eb1:expr) => {
            let (d, pa, pb) = seg_seg_dist_sq($ea0, $ea1, $eb0, $eb1);
            if d < best {
                best = d;
                out_a = pa;
                out_b = pb;
            }
        };
    }
    try_edge_edge!(a0, a1, b0, b1);
    try_edge_edge!(a0, a1, b1, b2);
    try_edge_edge!(a0, a1, b2, b0);
    try_edge_edge!(a1, a2, b0, b1);
    try_edge_edge!(a1, a2, b1, b2);
    try_edge_edge!(a1, a2, b2, b0);
    try_edge_edge!(a2, a0, b0, b1);
    try_edge_edge!(a2, a0, b1, b2);
    try_edge_edge!(a2, a0, b2, b0);

    (best, out_a, out_b)
}

/// A triangle's AABB as f64 `[mnx,mny,mnz,mxx,mxy,mxz, M]` where M is the
/// largest |coordinate| (Infinity when any coordinate is NaN/Infinity).
/// Mirrors JS `_ccTriBoxInto` comparison for comparison.
#[inline(always)]
fn tri_box(tris: &[f32], o9: usize) -> [f64; 7] {
    let mut mnx = tris[o9] as f64;
    let mut mny = tris[o9 + 1] as f64;
    let mut mnz = tris[o9 + 2] as f64;
    let (mut mxx, mut mxy, mut mxz) = (mnx, mny, mnz);
    let mut v = 3;
    while v < 9 {
        let x = tris[o9 + v] as f64;
        let y = tris[o9 + v + 1] as f64;
        let z = tris[o9 + v + 2] as f64;
        if x < mnx { mnx = x; }
        if x > mxx { mxx = x; }
        if y < mny { mny = y; }
        if y > mxy { mxy = y; }
        if z < mnz { mnz = z; }
        if z > mxz { mxz = z; }
        v += 3;
    }
    let mut m = 0.0f64;
    for q in 0..9 {
        let a = (tris[o9 + q] as f64).abs();
        if a > m {
            m = a;
        } else if a.is_nan() {
            m = f64::INFINITY;
        }
    }
    [mnx, mny, mnz, mxx, mxy, mxz, m]
}

/// JS `Math.max(a, b, 0)` for the finite values `ee_lower_sq` passes.
#[inline(always)]
fn gap3(a: f64, b: f64) -> f64 {
    let g = if a > b { a } else { b };
    if g > 0.0 { g } else { 0.0 }
}

/// Lower bound (squared) on any edge-edge sub-test of a triangle pair, from
/// the two triangles' `tri_box`es — 0 when nothing useful can be proven.
/// Sound in floating point: `seg_seg_dist_sq` clamps both parameters to
/// [0,1] (or yields NaN, which never wins), so each closest point lies on its
/// edge up to ~8 ulp of the largest coordinate M; the per-axis gaps are shrunk
/// by a relative 1e-12 plus 1e-12*M (+1e-290 for underflow) and the sum by a
/// relative 1e-12, far above every rounding involved. Mirrors JS
/// `_ccEELowerSq` operation for operation.
#[inline(always)]
fn ee_lower_sq(a: &[f64; 7], b: &[f64; 7]) -> f64 {
    let m_abs = if a[6] > b[6] { a[6] } else { b[6] };
    if !(m_abs < 1e300) {
        return 0.0;
    }
    let m = 1e-12 * m_abs + 1e-290;
    let mut s = 0.0f64;
    for c in 0..3 {
        let mut g = gap3(a[c] - b[c + 3], b[c] - a[c + 3]);
        g = g - g * 1e-12 - m;
        if g > 0.0 {
            s += g * g;
        }
    }
    s *= 1.0 - 1e-12;
    if s > 1e-200 { s } else { 0.0 }
}

/// Squared lower-bound distance between two BVH node AABBs (0 when they
/// overlap). Mirrors `_aabbAabbDistSq`.
#[inline(always)]
fn aabb_aabb_dist_sq(na: &BvhNode, nb: &BvhNode) -> f64 {
    let dx = (na.mn[0] as f64 - nb.mx[0] as f64).max(nb.mn[0] as f64 - na.mx[0] as f64).max(0.0);
    let dy = (na.mn[1] as f64 - nb.mx[1] as f64).max(nb.mn[1] as f64 - na.mx[1] as f64).max(0.0);
    let dz = (na.mn[2] as f64 - nb.mx[2] as f64).max(nb.mn[2] as f64 - na.mx[2] as f64).max(0.0);
    dx * dx + dy * dy + dz * dz
}

/// Dual-tree BVH traversal for true minimum mesh distance, pruned by the
/// running best. Split policy mirrors `bvh::traverse_pair` / JS
/// `_bvhMinDistTraverse` exactly (split the bigger node; a leaf can never be
/// the one split).
pub fn traverse_min_dist(
    na: &BvhNode,
    tris_a: &[f32],
    nb: &BvhNode,
    tris_b: &[f32],
    best: &mut f64,
    out_a: &mut [f64; 3],
    out_b: &mut [f64; 3],
) {
    if aabb_aabb_dist_sq(na, nb) >= *best {
        return;
    }
    let a_leaf = matches!(na.kind, BvhKind::Leaf { .. });
    let b_leaf = matches!(nb.kind, BvhKind::Leaf { .. });

    if a_leaf && b_leaf {
        let idx_a = match &na.kind { BvhKind::Leaf { indices } => indices, _ => unreachable!() };
        let idx_b = match &nb.kind { BvhKind::Leaf { indices } => indices, _ => unreachable!() };
        // Mirrors the JS leaf loop: same pairs, order and strict update; the
        // edge-edge sub-tests are skipped only where `ee_lower_sq` proves
        // they cannot beat best, and nothing runs once best reaches 0.
        let mut boxes_b = [[0.0f64; 7]; 4];
        let mut heap_b: Vec<[f64; 7]> = Vec::new();
        let bx: &mut [[f64; 7]] = if idx_b.len() <= 4 {
            &mut boxes_b[..idx_b.len()]
        } else {
            heap_b.resize(idx_b.len(), [0.0f64; 7]);
            &mut heap_b[..]
        };
        for (k, &ib) in idx_b.iter().enumerate() {
            bx[k] = tri_box(tris_b, ib * 9);
        }
        for &ia in idx_a {
            let ba = tri_box(tris_a, ia * 9);
            for (k, &ib) in idx_b.iter().enumerate() {
                let skip = ee_lower_sq(&ba, &bx[k]) >= *best;
                let (d, pa, pb) = tri_tri_dist_sq_ex(tris_a, ia * 9, tris_b, ib * 9, skip);
                if d < *best {
                    *best = d;
                    *out_a = pa;
                    *out_b = pb;
                    if d == 0.0 {
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
        let (la, ra) = match &na.kind { BvhKind::Inner { left, right, .. } => (left, right), _ => unreachable!() };
        traverse_min_dist(la, tris_a, nb, tris_b, best, out_a, out_b);
        traverse_min_dist(ra, tris_a, nb, tris_b, best, out_a, out_b);
    } else {
        let (lb, rb) = match &nb.kind { BvhKind::Inner { left, right, .. } => (left, right), _ => unreachable!() };
        traverse_min_dist(na, tris_a, lb, tris_b, best, out_a, out_b);
        traverse_min_dist(na, tris_a, rb, tris_b, best, out_a, out_b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_device_above_slab_center() {
        // The verified bug: a 0.2x0.2 device face 0.1m above the middle of
        // a 10x10 slab face — no vertex of either triangle is near a vertex
        // of the other, but the true surface distance is exactly 0.1.
        let slab = [-5.0f32, -5.0, 0.0, 5.0, -5.0, 0.0, -5.0, 5.0, 0.0];
        let device = [-0.1f32, -0.1, 0.1, 0.1, -0.1, 0.1, -0.1, 0.1, 0.1];
        let bvh_a = BvhNode::build(&slab);
        let bvh_b = BvhNode::build(&device);
        let mut best = f64::INFINITY;
        let mut oa = [0.0; 3];
        let mut ob = [0.0; 3];
        traverse_min_dist(&bvh_a, &slab, &bvh_b, &device, &mut best, &mut oa, &mut ob);
        assert!((best.sqrt() - 0.1).abs() < 1e-6, "expected 0.1, got {}", best.sqrt());
    }

    #[test]
    fn test_edge_edge_crossing_bars() {
        // Two thin bars crossing like a plus sign but offset in Z — closest
        // points are both interior to an edge of each triangle, not at any
        // vertex, so only the edge-edge sub-test finds the true minimum.
        let bar_a = [-1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.001, 0.0];
        let bar_b = [0.0f32, -1.0, 0.05, 0.0, 1.0, 0.05, 0.001, 0.0, 0.05];
        let bvh_a = BvhNode::build(&bar_a);
        let bvh_b = BvhNode::build(&bar_b);
        let mut best = f64::INFINITY;
        let mut oa = [0.0; 3];
        let mut ob = [0.0; 3];
        traverse_min_dist(&bvh_a, &bar_a, &bvh_b, &bar_b, &mut best, &mut oa, &mut ob);
        assert!((best.sqrt() - 0.05).abs() < 1e-6, "expected ~0.05, got {}", best.sqrt());
    }

    #[test]
    fn test_touching_is_zero() {
        let a = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let b = [0.0f32, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0, 0.0];
        let bvh_a = BvhNode::build(&a);
        let bvh_b = BvhNode::build(&b);
        let mut best = f64::INFINITY;
        let mut oa = [0.0; 3];
        let mut ob = [0.0; 3];
        traverse_min_dist(&bvh_a, &a, &bvh_b, &b, &mut best, &mut oa, &mut ob);
        assert!(best.sqrt() < 1e-9, "touching triangles should be ~0, got {}", best.sqrt());
    }

    #[test]
    fn test_parallel_faces() {
        let a = [0.0f32, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0];
        let b = [0.0f32, 0.0, 0.3, 2.0, 0.0, 0.3, 0.0, 2.0, 0.3];
        let bvh_a = BvhNode::build(&a);
        let bvh_b = BvhNode::build(&b);
        let mut best = f64::INFINITY;
        let mut oa = [0.0; 3];
        let mut ob = [0.0; 3];
        traverse_min_dist(&bvh_a, &a, &bvh_b, &b, &mut best, &mut oa, &mut ob);
        assert!((best.sqrt() - 0.3).abs() < 1e-6, "expected 0.3, got {}", best.sqrt());
    }
}
