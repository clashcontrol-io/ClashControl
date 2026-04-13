//! Spatial hash grid for fast vertex-to-vertex minimum distance queries.
//! Direct Rust port of ClashControl's _SpatialHash from index.html (lines 2666-2694).

use std::collections::HashMap;

pub struct SpatialHash {
    inv: f32,
    map: HashMap<i64, Vec<usize>>,
}

impl SpatialHash {
    pub fn new(cell_size: f32) -> Self {
        SpatialHash {
            inv: 1.0 / cell_size,
            map: HashMap::new(),
        }
    }

    #[inline(always)]
    fn hash_key(ix: i32, iy: i32, iz: i32) -> i64 {
        let h = (ix.wrapping_mul(73856093))
            ^ (iy.wrapping_mul(19349663))
            ^ (iz.wrapping_mul(83492791));
        h as i64
    }

    /// Insert all vertices from a flat [x,y,z, x,y,z, ...] array.
    pub fn insert(&mut self, verts: &[f32]) {
        for i in (0..verts.len()).step_by(3) {
            if i + 2 >= verts.len() {
                break;
            }
            let ix = (verts[i] * self.inv).floor() as i32;
            let iy = (verts[i + 1] * self.inv).floor() as i32;
            let iz = (verts[i + 2] * self.inv).floor() as i32;
            let k = Self::hash_key(ix, iy, iz);
            self.map.entry(k).or_insert_with(Vec::new).push(i);
        }
    }

    /// Find the minimum squared distance from point (px, py, pz) to any inserted vertex.
    /// Returns Some((dist_sq, nearest_x, nearest_y, nearest_z)) or None if no vertices nearby.
    pub fn min_dist_sq(&self, px: f32, py: f32, pz: f32, verts: &[f32]) -> Option<(f32, f32, f32, f32)> {
        let cx = (px * self.inv).floor() as i32;
        let cy = (py * self.inv).floor() as i32;
        let cz = (pz * self.inv).floor() as i32;

        let mut best = f32::INFINITY;
        let mut bx = 0.0f32;
        let mut by = 0.0f32;
        let mut bz = 0.0f32;

        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let k = Self::hash_key(cx + dx, cy + dy, cz + dz);
                    if let Some(bucket) = self.map.get(&k) {
                        for &idx in bucket {
                            let ex = px - verts[idx];
                            let ey = py - verts[idx + 1];
                            let ez = pz - verts[idx + 2];
                            let d2 = ex * ex + ey * ey + ez * ez;
                            if d2 < best {
                                best = d2;
                                bx = verts[idx];
                                by = verts[idx + 1];
                                bz = verts[idx + 2];
                            }
                        }
                    }
                }
            }
        }

        if best < f32::INFINITY {
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

        // Query far away — should still find the vertex (hash cells will miss but 3x3x3 search may reach)
        let result = grid.min_dist_sq(100.0, 100.0, 100.0, &verts);
        // With cell_size=0.5, point at (100,100,100) won't have hash neighbors near (0,0,0)
        assert!(result.is_none(), "Should not find vertex in distant cells");
    }
}
