//! Möller triangle-triangle intersection test.
//! Direct Rust port of ClashControl's _triTriTest from index.html (lines 2497-2566).
//! Returns the intersection segment midpoint and length if the triangles intersect.

/// Test if two triangles intersect using the Möller algorithm.
/// `ta` = flat [ax0,ay0,az0, ax1,ay1,az1, ax2,ay2,az2]
/// `tb` = flat [bx0,by0,bz0, bx1,by1,bz1, bx2,by2,bz2]
///
/// Returns Some((cx, cy, cz, segment_length)) if intersecting, None otherwise.
pub fn tri_tri_test(ta: &[f32], oa: usize, tb: &[f32], ob: usize, _eps: f32) -> Option<(f32, f32, f32, f32)> {
    let (a0x, a0y, a0z) = (ta[oa] as f64, ta[oa + 1] as f64, ta[oa + 2] as f64);
    let (a1x, a1y, a1z) = (ta[oa + 3] as f64, ta[oa + 4] as f64, ta[oa + 5] as f64);
    let (a2x, a2y, a2z) = (ta[oa + 6] as f64, ta[oa + 7] as f64, ta[oa + 8] as f64);

    let (b0x, b0y, b0z) = (tb[ob] as f64, tb[ob + 1] as f64, tb[ob + 2] as f64);
    let (b1x, b1y, b1z) = (tb[ob + 3] as f64, tb[ob + 4] as f64, tb[ob + 5] as f64);
    let (b2x, b2y, b2z) = (tb[ob + 6] as f64, tb[ob + 7] as f64, tb[ob + 8] as f64);

    // Plane of triangle B
    let e1x = b1x - b0x;
    let e1y = b1y - b0y;
    let e1z = b1z - b0z;
    let e2x = b2x - b0x;
    let e2y = b2y - b0y;
    let e2z = b2z - b0z;
    let n2x = e1y * e2z - e1z * e2y;
    let n2y = e1z * e2x - e1x * e2z;
    let n2z = e1x * e2y - e1y * e2x;
    let nl2 = n2x * n2x + n2y * n2y + n2z * n2z;
    if nl2 < 1e-10 {
        return None; // degenerate triangle B
    }
    let d2 = -(n2x * b0x + n2y * b0y + n2z * b0z);
    let da0 = n2x * a0x + n2y * a0y + n2z * a0z + d2;
    let da1 = n2x * a1x + n2y * a1y + n2z * a1z + d2;
    let da2 = n2x * a2x + n2y * a2y + n2z * a2z + d2;
    let eps2 = 1e-6 * nl2.sqrt();
    if da0 > eps2 && da1 > eps2 && da2 > eps2 {
        return None;
    }
    if da0 < -eps2 && da1 < -eps2 && da2 < -eps2 {
        return None;
    }

    // Plane of triangle A
    let f1x = a1x - a0x;
    let f1y = a1y - a0y;
    let f1z = a1z - a0z;
    let f2x = a2x - a0x;
    let f2y = a2y - a0y;
    let f2z = a2z - a0z;
    let n1x = f1y * f2z - f1z * f2y;
    let n1y = f1z * f2x - f1x * f2z;
    let n1z = f1x * f2y - f1y * f2x;
    let nl1 = n1x * n1x + n1y * n1y + n1z * n1z;
    if nl1 < 1e-10 {
        return None; // degenerate triangle A
    }
    let d1 = -(n1x * a0x + n1y * a0y + n1z * a0z);
    let db0 = n1x * b0x + n1y * b0y + n1z * b0z + d1;
    let db1 = n1x * b1x + n1y * b1y + n1z * b1z + d1;
    let db2 = n1x * b2x + n1y * b2y + n1z * b2z + d1;
    let eps1 = 1e-6 * nl1.sqrt();
    if db0 > eps1 && db1 > eps1 && db2 > eps1 {
        return None;
    }
    if db0 < -eps1 && db1 < -eps1 && db2 < -eps1 {
        return None;
    }

    // Intersection line direction
    let lx = n1y * n2z - n1z * n2y;
    let ly = n1z * n2x - n1x * n2z;
    let lz = n1x * n2y - n1y * n2x;
    let ll = lx * lx + ly * ly + lz * lz;
    if ll < 1e-12 {
        return None; // coplanar
    }

    // Project vertices onto intersection line
    fn proj(lx: f64, ly: f64, lz: f64, vx: f64, vy: f64, vz: f64) -> f64 {
        lx * vx + ly * vy + lz * vz
    }

    let pa0 = proj(lx, ly, lz, a0x, a0y, a0z);
    let pa1 = proj(lx, ly, lz, a1x, a1y, a1z);
    let pa2 = proj(lx, ly, lz, a2x, a2y, a2z);
    let pb0 = proj(lx, ly, lz, b0x, b0y, b0z);
    let pb1 = proj(lx, ly, lz, b1x, b1y, b1z);
    let pb2 = proj(lx, ly, lz, b2x, b2y, b2z);

    // Compute intervals on intersection line for each triangle
    fn interval(d0: f64, d1: f64, d2: f64, p0: f64, p1: f64, p2: f64) -> Option<(f64, f64)> {
        // Find the two intersection points of the triangle with the other's plane
        let mut t = [0.0f64; 2];
        let mut k = 0;
        if d0 * d1 < 0.0 {
            let r = d0 / (d0 - d1);
            t[k] = p0 + (p1 - p0) * r;
            k += 1;
        }
        if d0 * d2 < 0.0 {
            let r = d0 / (d0 - d2);
            t[k] = p0 + (p2 - p0) * r;
            k += 1;
        }
        if d1 * d2 < 0.0 && k < 2 {
            let r = d1 / (d1 - d2);
            t[k] = p1 + (p2 - p1) * r;
            k += 1;
        }
        if k < 2 {
            return None;
        }
        if t[0] < t[1] {
            Some((t[0], t[1]))
        } else {
            Some((t[1], t[0]))
        }
    }

    let ival_a = interval(da0, da1, da2, pa0, pa1, pa2)?;
    let ival_b = interval(db0, db1, db2, pb0, pb1, pb2)?;

    // Check overlap of intervals
    let o_min = ival_a.0.max(ival_b.0);
    let o_max = ival_a.1.min(ival_b.1);
    if o_min >= o_max {
        return None;
    }

    // Compute intersection segment midpoint in world space
    let inv_ll = 1.0 / ll.sqrt();
    let dx = lx * inv_ll;
    let dy = ly * inv_ll;
    let dz = lz * inv_ll;
    // Reference point on the intersection line (use a0)
    let ref_t = proj(lx, ly, lz, a0x, a0y, a0z);
    let r_min = (o_min - ref_t) * inv_ll;
    let r_max = (o_max - ref_t) * inv_ll;
    let mid_r = (r_min + r_max) * 0.5;
    let cx = (a0x + dx * mid_r) as f32;
    let cy = (a0y + dy * mid_r) as f32;
    let cz = (a0z + dz * mid_r) as f32;
    let seg_len = ((o_max - o_min) * inv_ll) as f32;

    Some((cx, cy, cz, seg_len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crossing_triangles() {
        // Large XY plane triangle
        let a = [0.0f32, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 2.0, 0.0];
        // Large triangle piercing through the XY plane along Z
        let b = [0.5f32, 0.5, -1.0, 1.5, 0.5, -1.0, 1.0, 0.5, 1.0];
        let result = tri_tri_test(&a, 0, &b, 0, 1e-6);
        assert!(result.is_some(), "Crossing triangles should intersect");
    }

    #[test]
    fn test_parallel_triangles() {
        let a = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let b = [0.0f32, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0];
        let result = tri_tri_test(&a, 0, &b, 0, 1e-6);
        assert!(result.is_none(), "Parallel triangles should not intersect");
    }

    #[test]
    fn test_degenerate_triangle() {
        let a = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let b = [0.0f32, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]; // point
        let result = tri_tri_test(&a, 0, &b, 0, 1e-6);
        assert!(result.is_none(), "Degenerate triangle should not intersect");
    }
}
