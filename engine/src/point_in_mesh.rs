//! Point-in-mesh test via 3-axis ray-parity voting, BVH-accelerated.
//! Operation-for-operation Rust port of ClashControl's `_rayTriHit` /
//! `_rayAABBHit` / `_bvhRayCount` / `_pointInMeshBVH` / `_PEN_RAY_DIRS`
//! (index.html, near `_estimatePenetrationDepthM`) — used there (JS side)
//! to approximate hard-clash penetration depth, and here for the
//! min-distance containment fix (a closed mesh fully inside another with
//! no triangle pair actually crossing — see `mesh_dist.rs`'s
//! `containment_fix` doc comment). Designed for bit-identical output given
//! the same f64 inputs, same as the rest of this crate.

use crate::bvh::{BvhKind, BvhNode};

/// Ray directions: near-axis but deliberately NOT exactly axis-aligned —
/// see the JS reference's `_PEN_RAY_DIRS` comment for why (a pure axis ray
/// is the single worst choice against watertight axis-aligned IFC geometry:
/// it's exactly the direction most likely to land on a shared edge between
/// two triangles, double-counting one true crossing as two and flipping odd
/// parity to even). Each entry is [dx, dy, dz, 1/dx, 1/dy, 1/dz].
fn ray_dirs() -> [[f64; 6]; 3] {
    let raw = [
        [1.0f64, 0.0131, 0.0177],
        [0.0149, 1.0, 0.0163],
        [0.0121, 0.0139, 1.0],
    ];
    let mut out = [[0.0f64; 6]; 3];
    for i in 0..3 {
        let d = raw[i];
        let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        let (dx, dy, dz) = (d[0] / len, d[1] / len, d[2] / len);
        out[i] = [dx, dy, dz, 1.0 / dx, 1.0 / dy, 1.0 / dz];
    }
    out
}

/// Möller–Trumbore ray-triangle intersection, same tolerances as the JS
/// reference's `_rayTriHit`. Returns `t` along the ray, or -1.0 for a miss.
#[allow(clippy::too_many_arguments)]
fn ray_tri_hit(ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, tris: &[f32], o9: usize) -> f64 {
    let v0x = tris[o9] as f64;
    let v0y = tris[o9 + 1] as f64;
    let v0z = tris[o9 + 2] as f64;
    let v1x = tris[o9 + 3] as f64;
    let v1y = tris[o9 + 4] as f64;
    let v1z = tris[o9 + 5] as f64;
    let v2x = tris[o9 + 6] as f64;
    let v2y = tris[o9 + 7] as f64;
    let v2z = tris[o9 + 8] as f64;
    let e1x = v1x - v0x;
    let e1y = v1y - v0y;
    let e1z = v1z - v0z;
    let e2x = v2x - v0x;
    let e2y = v2y - v0y;
    let e2z = v2z - v0z;
    let px = dy * e2z - dz * e2y;
    let py = dz * e2x - dx * e2z;
    let pz = dx * e2y - dy * e2x;
    let det = e1x * px + e1y * py + e1z * pz;
    if det > -1e-12 && det < 1e-12 {
        return -1.0;
    }
    let inv_det = 1.0 / det;
    let tx = ox - v0x;
    let ty = oy - v0y;
    let tz = oz - v0z;
    let u = (tx * px + ty * py + tz * pz) * inv_det;
    if u < -1e-9 || u > 1.0 + 1e-9 {
        return -1.0;
    }
    let qx = ty * e1z - tz * e1y;
    let qy = tz * e1x - tx * e1z;
    let qz = tx * e1y - ty * e1x;
    let v = (dx * qx + dy * qy + dz * qz) * inv_det;
    if v < -1e-9 || u + v > 1.0 + 1e-9 {
        return -1.0;
    }
    (e2x * qx + e2y * qy + e2z * qz) * inv_det
}

/// Slab-test ray/AABB hit, same shape as JS `_rayAABBHit`.
#[allow(clippy::too_many_arguments)]
fn ray_aabb_hit(ox: f64, oy: f64, oz: f64, idx: f64, idy: f64, idz: f64, node: &BvhNode) -> bool {
    let tx1 = (node.mn[0] as f64 - ox) * idx;
    let tx2 = (node.mx[0] as f64 - ox) * idx;
    let mut tmin = tx1.min(tx2);
    let mut tmax = tx1.max(tx2);
    let ty1 = (node.mn[1] as f64 - oy) * idy;
    let ty2 = (node.mx[1] as f64 - oy) * idy;
    tmin = tmin.max(ty1.min(ty2));
    tmax = tmax.min(ty1.max(ty2));
    let tz1 = (node.mn[2] as f64 - oz) * idz;
    let tz2 = (node.mx[2] as f64 - oz) * idz;
    tmin = tmin.max(tz1.min(tz2));
    tmax = tmax.min(tz1.max(tz2));
    tmax >= tmin.max(0.0)
}

/// Count ray/triangle hits (t > 1e-7) for one BVH, one ray. Mirrors JS
/// `_bvhRayCount`.
#[allow(clippy::too_many_arguments)]
fn bvh_ray_count(
    node: &BvhNode,
    tris: &[f32],
    ox: f64,
    oy: f64,
    oz: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    idx: f64,
    idy: f64,
    idz: f64,
) -> u32 {
    if !ray_aabb_hit(ox, oy, oz, idx, idy, idz, node) {
        return 0;
    }
    match &node.kind {
        BvhKind::Leaf { indices } => {
            let mut cnt = 0u32;
            for &i in indices {
                if ray_tri_hit(ox, oy, oz, dx, dy, dz, tris, i * 9) > 1e-7 {
                    cnt += 1;
                }
            }
            cnt
        }
        BvhKind::Inner { left, right, .. } => {
            bvh_ray_count(left, tris, ox, oy, oz, dx, dy, dz, idx, idy, idz)
                + bvh_ray_count(right, tris, ox, oy, oz, dx, dy, dz, idx, idy, idz)
        }
    }
}

/// True if point (px,py,pz) lies inside the closed mesh described by
/// `root`/`tris`: odd-parity ray count on at least 2 of 3 near-axis
/// directions. Mirrors JS `_pointInMeshBVH` exactly.
pub fn point_in_mesh_bvh(px: f64, py: f64, pz: f64, root: &BvhNode, tris: &[f32]) -> bool {
    let dirs = ray_dirs();
    let mut votes = 0;
    for d in dirs.iter() {
        let cnt = bvh_ray_count(root, tris, px, py, pz, d[0], d[1], d[2], d[3], d[4], d[5]);
        if cnt & 1 == 1 {
            votes += 1;
        }
    }
    votes >= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube_tris(x0: f32, x1: f32, y0: f32, y1: f32, z0: f32, z1: f32) -> Vec<f32> {
        let mut t = Vec::new();
        let mut quad = |p: &dyn Fn(f32, f32) -> [f32; 3]| {
            let a = p(0.0, 0.0);
            let b = p(1.0, 0.0);
            let c = p(1.0, 1.0);
            let d = p(0.0, 1.0);
            t.extend_from_slice(&a);
            t.extend_from_slice(&b);
            t.extend_from_slice(&c);
            t.extend_from_slice(&a);
            t.extend_from_slice(&c);
            t.extend_from_slice(&d);
        };
        let lerp = |a: f32, b: f32, u: f32| a + (b - a) * u;
        quad(&|u, v| [lerp(x0, x1, u), lerp(y0, y1, v), z0]);
        quad(&|u, v| [lerp(x0, x1, u), lerp(y0, y1, v), z1]);
        quad(&|u, v| [lerp(x0, x1, u), y0, lerp(z0, z1, v)]);
        quad(&|u, v| [lerp(x0, x1, u), y1, lerp(z0, z1, v)]);
        quad(&|u, v| [x0, lerp(y0, y1, u), lerp(z0, z1, v)]);
        quad(&|u, v| [x1, lerp(y0, y1, u), lerp(z0, z1, v)]);
        t
    }

    #[test]
    fn test_point_inside_cube() {
        let cube = cube_tris(-1.0, 1.0, -1.0, 1.0, -1.0, 1.0);
        let bvh = BvhNode::build(&cube);
        assert!(point_in_mesh_bvh(0.0, 0.0, 0.0, &bvh, &cube));
    }

    #[test]
    fn test_point_outside_cube() {
        let cube = cube_tris(-1.0, 1.0, -1.0, 1.0, -1.0, 1.0);
        let bvh = BvhNode::build(&cube);
        assert!(!point_in_mesh_bvh(5.0, 5.0, 5.0, &bvh, &cube));
    }
}
