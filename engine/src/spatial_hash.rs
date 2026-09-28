//! Spatial hash grid for fast vertex-to-vertex minimum distance queries.
//! Operation-for-operation Rust port of ClashControl's `_SpatialHash`
//! (index.html, near line 5907). f64 throughout, matching JS numbers;
//! inputs come in as f32 (Float32Array) and are widened immediately.

use std::collections::HashMap;

pub struct SpatialHash {
    inv: f64,
    map: HashMap<i32, Vec<usize>>,
}

impl SpatialHash {
    pub fn new(cell_size: f64) -> Self {
        SpatialHash {
            inv: 1.0 / cell_size,
            map: HashMap::new(),
        }
    }

    /// `(((ix*73856093) ^ (iy*19349663) ^ (iz*83492791)) | 0)` — JS `|0`
    /// truncates to a signed 32-bit int, which is exactly wrapping i32 math.
    #[inline(always)]
    fn hash_key(ix: i32, iy: i32, iz: i32) -> i32 {
        (ix.wrapping_mul(73856093)) ^ (iy.wrapping_mul(19349663)) ^ (iz.wrapping_mul(83492791))
    }

    /// Insert all vertices from a flat [x,y,z, x,y,z, ...] f32 array.
    /// Bucket order is insertion order (push), matching JS array push —
    /// this matters for tie-breaking in `min_dist_sq`.
    pub fn insert(&mut self, verts: &[f32]) {
        for i in (0..verts.len()).step_by(3) {
            if i + 2 >= verts.len() {
                break;
            }
            let x = verts[i] as f64;
            let y = verts[i + 1] as f64;
            let z = verts[i + 2] as f64;
            let ix = (x * self.inv).floor() as i32;
            let iy = (y * self.inv).floor() as i32;
            let iz = (z * self.inv).floor() as i32;
            let k = Self::hash_key(ix, iy, iz);
            self.map.entry(k).or_insert_with(Vec::new).push(i);
        }
    }

    /// Find the minimum squared distance from point (px, py, pz) to any
    /// inserted vertex, scanning the 3x3x3 neighborhood exactly like JS.
    /// Ties broken by "first found strictly smaller" — same as the JS
    /// `if (d2 < best)`, so bucket iteration order (dx,dy,dz then insertion
    /// order) must match, which `insert`'s push-order preserves.
    pub fn min_dist_sq(&self, px: f64, py: f64, pz: f64, verts: &[f32]) -> Option<(f64, f64, f64, f64)> {
        let cx = (px * self.inv).floor() as i32;
        let cy = (py * self.inv).floor() as i32;
        let cz = (pz * self.inv).floor() as i32;

        let mut best = f64::INFINITY;
        let mut bx = 0.0f64;
        let mut by = 0.0f64;
        let mut bz = 0.0f64;
        let mut found = false;

        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let k = Self::hash_key(cx + dx, cy + dy, cz + dz);
                    if let Some(bucket) = self.map.get(&k) {
                        for &idx in bucket {
                            let vx = verts[idx] as f64;
                            let vy = verts[idx + 1] as f64;
                            let vz = verts[idx + 2] as f64;
                            let ex = px - vx;
                            let ey = py - vy;
                            let ez = pz - vz;
                            let d2 = ex * ex + ey * ey + ez * ez;
                            if d2 < best {
                                best = d2;
                                bx = vx;
                                by = vy;
                                bz = vz;
                                found = true;
                            }
                        }
                    }
                }
            }
        }

        if found {
            Some((best, bx, by, bz))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_query() {
        let mut grid = SpatialHash::new(1.0);
        let verts = vec![0.0f32, 0.0, 0.0, 1.0, 1.0, 1.0, 5.0, 5.0, 5.0];
        grid.insert(&verts);

        let result = grid.min_dist_sq(0.1, 0.1, 0.1, &verts);
        assert!(result.is_some());
        let (d2, _, _, _) = result.unwrap();
        assert!(d2 < 0.1, "Should find nearby vertex, got dist_sq={}", d2);
    }

    #[test]
    fn test_no_nearby() {
        let mut grid = SpatialHash::new(0.5);
        let verts = vec![0.0f32, 0.0, 0.0];
        grid.insert(&verts);

        let result = grid.min_dist_sq(100.0, 100.0, 100.0, &verts);
        assert!(result.is_none(), "Should not find vertex in distant cells");
    }
}
