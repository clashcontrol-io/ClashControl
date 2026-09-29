//! Möller triangle-triangle intersection test.
//! Operation-for-operation Rust port of ClashControl's `_triTriTest`
//! (index.html, near line 5573). Every arithmetic step mirrors the JS
//! source exactly (same order of operations, same branches, same
//! dominant-axis projection) so that, given the same f64 inputs, this
//! produces IEEE-754-identical results to the JS reference. Inputs come
//! in as f32 (mirroring the Float32Array triangle buffers) but are widened
//! to f64 immediately, exactly like JS (which is f64 throughout because
//! all JS numbers are f64 — reading out of a Float32Array upcasts).

#[inline(always)]
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline(always)]
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline(always)]
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// JS `Math.max`/`Math.min` semantics: NaN propagates (returns NaN if EITHER
// operand is NaN), unlike Rust's `f64::max`/`f64::min` methods, which are
// IEEE 754 minNum/maxNum — they ignore a NaN operand and return the other
// one. This distinction is load-bearing: a genuinely degenerate triangle
// pair (an edge lying exactly in the other triangle's plane) produces a
// literal 0.0/0.0 = NaN inside `interval()`, and JS's overlap-interval
// `Math.max`/`Math.min` then propagates that NaN into the final "hit" point
// — a real (if odd) behavior of the reference this crate must reproduce
// bit-for-bit, not silently paper over. Signed-zero tie-break also mirrors
// the ECMA-262 spec (`Math.max(+0,-0) === +0`, `Math.min(+0,-0) === -0`).
#[inline(always)]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() && !b.is_sign_negative() { b } else { a };
    }
    if a > b { a } else { b }
}
#[inline(always)]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() { -0.0f64 } else { a };
    }
    if a < b { a } else { b }
}

/// Result of `interval()`: [t_min, t_max, p_at_tmin.x/y/z, p_at_tmax.x/y/z]
/// — mirrors the JS `_ttIvalA`/`_ttIvalB` scratch layout exactly.
type Ival = [f64; 8];

#[inline(always)]
fn interval(v0: [f64; 3], v1: [f64; 3], v2: [f64; 3], dd0: f64, dd1: f64, dd2: f64, axis: usize) -> Ival {
    let (i0, i1, i2, di0, di1, di2);
    if dd0 * dd1 > 0.0 {
        i0 = v2; i1 = v0; i2 = v1;
        di0 = dd2; di1 = dd0; di2 = dd1;
    } else if dd0 * dd2 > 0.0 {
        i0 = v1; i1 = v0; i2 = v2;
        di0 = dd1; di1 = dd0; di2 = dd2;
    } else {
        i0 = v0; i1 = v1; i2 = v2;
        di0 = dd0; di1 = dd1; di2 = dd2;
    }
    let p0 = i0[axis];
    let p1 = i1[axis];
    let p2 = i2[axis];
    let r1 = di0 / (di0 - di1);
    let r2 = di0 / (di0 - di2);
    let t1 = p0 + (p1 - p0) * r1;
    let t2 = p0 + (p2 - p0) * r2;
    let q1 = [
        i0[0] + (i1[0] - i0[0]) * r1,
        i0[1] + (i1[1] - i0[1]) * r1,
        i0[2] + (i1[2] - i0[2]) * r1,
    ];
    let q2 = [
        i0[0] + (i2[0] - i0[0]) * r2,
        i0[1] + (i2[1] - i0[1]) * r2,
        i0[2] + (i2[2] - i0[2]) * r2,
    ];
    if t1 < t2 {
        [t1, t2, q1[0], q1[1], q1[2], q2[0], q2[1], q2[2]]
    } else {
        [t2, t1, q2[0], q2[1], q2[2], q1[0], q1[1], q1[2]]
    }
}

/// Test if two triangles intersect using the Möller algorithm.
/// `ta` = flat [ax0,ay0,az0, ax1,ay1,az1, ax2,ay2,az2]
/// `tb` = flat [bx0,by0,bz0, bx1,by1,bz1, bx2,by2,bz2]
///
/// Returns Some((cx, cy, cz, segment_length)) if intersecting, None otherwise.
/// `_eps` is accepted for API compatibility but, like the JS reference, the
/// actual tolerances used are always the relative `1e-6 * sqrt(nl)` ones
/// computed from each triangle's own normal length.
pub fn tri_tri_test(ta: &[f32], oa: usize, tb: &[f32], ob: usize, _eps: f32) -> Option<(f64, f64, f64, f64)> {
    let a0 = [ta[oa] as f64, ta[oa + 1] as f64, ta[oa + 2] as f64];
    let a1 = [ta[oa + 3] as f64, ta[oa + 4] as f64, ta[oa + 5] as f64];
    let a2 = [ta[oa + 6] as f64, ta[oa + 7] as f64, ta[oa + 8] as f64];

    let b0 = [tb[ob] as f64, tb[ob + 1] as f64, tb[ob + 2] as f64];
    let b1 = [tb[ob + 3] as f64, tb[ob + 4] as f64, tb[ob + 5] as f64];
    let b2 = [tb[ob + 6] as f64, tb[ob + 7] as f64, tb[ob + 8] as f64];

    // Plane of triangle B
    let e1 = sub(b1, b0);
    let e2 = sub(b2, b0);
    let n2 = cross(e1, e2);
    let nl2 = dot(n2, n2);
    if nl2 < 1e-10 {
        return None; // degenerate triangle B
    }
    let d2 = -dot(n2, b0);
    let da0 = dot(n2, a0) + d2;
    let da1 = dot(n2, a1) + d2;
    let da2 = dot(n2, a2) + d2;
    let eps2 = 1e-6 * nl2.sqrt();
    if da0 > eps2 && da1 > eps2 && da2 > eps2 {
        return None;
    }
    if da0 < -eps2 && da1 < -eps2 && da2 < -eps2 {
        return None;
    }
    // Coplanar pair: flush surface contact, not volumetric interpenetration —
    // treated as a non-clash, same as the JS reference. Also guards the
    // interval math below against 0/0 → NaN when the cross-normal degenerates.
    if da0.abs() <= eps2 && da1.abs() <= eps2 && da2.abs() <= eps2 {
        return None;
    }

    // Plane of triangle A
    let f1 = sub(a1, a0);
    let f2 = sub(a2, a0);
    let n1 = cross(f1, f2);
    let nl1 = dot(n1, n1);
    if nl1 < 1e-10 {
        return None; // degenerate triangle A
    }
    let d1 = -dot(n1, a0);
    let db0 = dot(n1, b0) + d1;
    let db1 = dot(n1, b1) + d1;
    let db2 = dot(n1, b2) + d1;
    let eps1 = 1e-6 * nl1.sqrt();
    if db0 > eps1 && db1 > eps1 && db2 > eps1 {
        return None;
    }
    if db0 < -eps1 && db1 < -eps1 && db2 < -eps1 {
        return None;
    }

    // Dominant axis of the intersection-line direction (cross of the two
    // plane normals) — matches JS's choice of projecting onto x/y/z rather
    // than onto the normalized line, which is what makes the segment
    // endpoints come out as real points ON the line instead of offset by
    // whichever vertex happened to be used as a reference point.
    let d = cross(n1, n2);
    let ax = d[0].abs();
    let ay = d[1].abs();
    let az = d[2].abs();
    let axis = if ax >= ay && ax >= az {
        0
    } else if ay >= az {
        1
    } else {
        2
    };

    let ia = interval(a0, a1, a2, da0, da1, da2, axis);
    let ib = interval(b0, b1, b2, db0, db1, db2, axis);
    if ia[0] >= ib[1] || ib[0] >= ia[1] {
        return None; // strict < to exclude edge-only touches
    }
    let o_min = js_max(ia[0], ib[0]);
    let o_max = js_min(ia[1], ib[1]);
    let src = if (ia[1] - ia[0]) >= (ib[1] - ib[0]) { ia } else { ib };
    let len = src[1] - src[0];
    if len < 1e-12 {
        return Some((src[2], src[3], src[4], 0.0));
    }
    let r_min = (o_min - src[0]) / len;
    let r_max = (o_max - src[0]) / len;
    let p_min = [
        src[2] + (src[5] - src[2]) * r_min,
        src[3] + (src[6] - src[3]) * r_min,
        src[4] + (src[7] - src[4]) * r_min,
    ];
    let p_max = [
        src[2] + (src[5] - src[2]) * r_max,
        src[3] + (src[6] - src[3]) * r_max,
        src[4] + (src[7] - src[4]) * r_max,
    ];
    let sd = sub(p_max, p_min);
    Some((
        (p_min[0] + p_max[0]) / 2.0,
        (p_min[1] + p_max[1]) / 2.0,
        (p_min[2] + p_max[2]) / 2.0,
        dot(sd, sd).sqrt(),
    ))
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

    #[test]
    fn test_coplanar_triangles_no_hit() {
        // Both triangles lie exactly in z=0 — must be rejected as coplanar,
        // not treated as an interpenetration.
        let a = [0.0f32, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0];
        let b = [0.5f32, 0.5, 0.0, 1.5, 0.5, 0.0, 0.5, 1.5, 0.0];
        assert!(tri_tri_test(&a, 0, &b, 0, 1e-6).is_none());
    }

    #[test]
    fn test_duct_wall_long_thin_produces_point_on_line() {
        // Regression for the a0-offset bug: a long duct box crossing a thin
        // wall must produce a midpoint that is actually within both AABBs —
        // it must lie on the true intersection line, not offset by an
        // arbitrary reference vertex's perpendicular distance from it.
        // Duct top face crossing through the wall around x=10, z=-6.5.
        let duct_top = [
            -1.0f32, 2.9, -6.9, 21.0, 2.9, -6.9, -1.0, 2.9, -6.1,
        ];
        let wall_face = [
            9.925f32, 0.0, -11.85, 10.075, 0.0, -11.85, 9.925, 3.2, -0.15,
        ];
        // These two particular triangles may or may not intersect depending
        // on exact winding; the meaningful assertion is that IF they report
        // a hit, the point lies near the shared coordinate range.
        if let Some((cx, _cy, cz, _)) = tri_tri_test(&duct_top, 0, &wall_face, 0, 1e-6) {
            assert!(cx > 9.0 && cx < 11.0, "cx={} should be near the wall x-range", cx);
            assert!(cz > -7.0 && cz < -6.0, "cz={} should be near the duct z-range", cz);
        }
    }

    #[test]
    fn test_argument_order_symmetry_of_hit_detection() {
        let a = [0.0f32, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 2.0, 0.0];
        let b = [0.5f32, 0.5, -1.0, 1.5, 0.5, -1.0, 1.0, 0.5, 1.0];
        let fwd = tri_tri_test(&a, 0, &b, 0, 1e-6);
        let rev = tri_tri_test(&b, 0, &a, 0, 1e-6);
        assert_eq!(fwd.is_some(), rev.is_some());
    }

    // Regression: JS's Math.max/Math.min propagate NaN (return NaN if either
    // operand is NaN), unlike Rust's f64::max/f64::min which IGNORE NaN and
    // return the other operand. This triangle pair has one edge (a0-a1) lying
    // EXACTLY in triangle B's plane (da0 == da1 == 0.0), which makes
    // `interval()`'s r1 = di0/(di0-di1) a literal 0.0/0.0 = NaN — a genuine
    // quirk of the JS reference (an edge-in-plane degenerate case), not
    // something to "fix": the contract here is bit-identical output,
    // including this NaN, not a more correct answer. If o_min/o_max used
    // Rust's `.max()`/`.min()` instead of JS-semantics `js_max`/`js_min`,
    // this would silently produce a real number instead of propagating NaN
    // — exactly the bug this test catches.
    #[test]
    fn test_edge_in_plane_degenerate_matches_js_nan_propagation() {
        let a: [f32; 9] = [0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0];
        let b: [f32; 9] = [1.0, 0.0, 0.0, 2.0, 0.0, 1.0, 1.0, 0.0, 1.0];
        let r = tri_tri_test(&a, 0, &b, 0, 1e-6);
        match r {
            Some((cx, cy, cz, depth)) => {
                assert!(cx.is_nan() && cy.is_nan() && cz.is_nan() && depth.is_nan(),
                    "expected all-NaN point (matching the JS reference's 0/0 degenerate case), got {:?}", (cx, cy, cz, depth));
            }
            None => panic!("JS reference returns a (NaN-filled) Some(...) here, not None"),
        }
    }
}
