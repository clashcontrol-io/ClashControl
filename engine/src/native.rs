//! Native (desktop) batch narrow phase — `native` cargo feature only.
//!
//! A multi-core wrapper around the SAME `Engine` internals the WASM build
//! uses (registered meshes with a BVH built once; every query funnels
//! through `intersect_raw_prebuilt` / `min_distance_prebuilt`). There is NO
//! second algorithm here: `detect_pairs` only fans the existing single-pair
//! queries out over a rayon pool and returns the results in INPUT order, so
//! the output is identical (f64 bits) to calling the free functions
//! sequentially — enforced by the tests at the bottom of this file.
//!
//! The `wire` submodule is the binary codec the Tauri commands use (raw
//! little-endian bytes, never JSON arrays of floats).

use rayon::prelude::*;

use crate::{Engine, RegisteredMesh};

/// Which per-pair query `detect_pairs` runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// `mesh_intersect_raw` semantics: `[]` = miss, else raw points with
    /// `max_depth` appended.
    Hard,
    /// `mesh_min_distance` semantics: `[dist, ax,ay,az, bx,by,bz]`, or
    /// `[Infinity]` when either mesh is empty.
    MinDist,
}

/// Per-pair result: `None` when either id is not registered (a caller bug
/// must never look like "no clash"), else exactly what the single-pair
/// function returns.
pub type PairResult = Option<Vec<f64>>;

pub struct NativeEngine {
    inner: Engine,
    pool: rayon::ThreadPool,
    threads: usize,
}

impl NativeEngine {
    /// `threads == 0` picks `available_parallelism() - 1` (min 1): one core is
    /// left for the WebView/UI so the app stays responsive during a run.
    pub fn new(threads: usize) -> Result<NativeEngine, String> {
        let n = if threads > 0 {
            threads
        } else {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(2)
                .saturating_sub(1)
                .max(1)
        };
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .thread_name(|i| format!("cc-native-{i}"))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(NativeEngine { inner: Engine::new(), pool, threads: n })
    }

    pub fn threads(&self) -> usize {
        self.threads
    }

    pub fn len(&self) -> usize {
        self.inner.meshes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.meshes.is_empty()
    }

    pub fn total_floats(&self) -> u64 {
        self.inner.meshes.values().map(|m| m.tris.len() as u64).sum()
    }

    pub fn has(&self, id: u32) -> bool {
        self.inner.has(id)
    }

    /// Register (or replace) one mesh.
    pub fn register(&mut self, id: u32, tris: &[f32]) {
        self.inner.register(id, tris);
    }

    /// Register many meshes, building their BVHs in parallel (BVH build is a
    /// pure function of the triangle data, so this equals sequential
    /// registration). Later duplicates of an id win, like sequential inserts.
    pub fn register_many(&mut self, items: Vec<(u32, Vec<f32>)>) {
        let built: Vec<(u32, RegisteredMesh)> = self.pool.install(|| {
            items
                .into_par_iter()
                .map(|(id, tris)| (id, RegisteredMesh::build(tris)))
                .collect()
        });
        for (id, m) in built {
            self.inner.meshes.insert(id, m);
        }
    }

    pub fn unregister(&mut self, id: u32) -> bool {
        self.inner.unregister(id)
    }

    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Run every `(id_a, id_b)` pair in parallel; result `i` belongs to
    /// `pairs[i]`.
    pub fn detect_pairs(&self, pairs: &[(u32, u32)], mode: Mode) -> Vec<PairResult> {
        let eng = &self.inner;
        self.pool.install(|| {
            pairs
                .par_iter()
                .map(|&(a, b)| match mode {
                    Mode::Hard => eng.intersect(a, b),
                    Mode::MinDist => eng.min_distance(a, b),
                })
                .collect()
        })
    }
}

/// Binary wire format shared with `addons/tauri-bridge.js`. Everything is
/// little-endian. Layouts are chosen so every typed-array view on the JS side
/// starts at an offset that is a multiple of its element size.
pub mod wire {
    /// Hard cap on floats one `register` payload may declare (~2 GiB of f32):
    /// rejects corrupt/hostile headers before allocating.
    pub const MAX_REGISTER_FLOATS: u64 = 1 << 29;

    /// `register_meshes` body:
    /// `[u32 count][count x (u32 id, u32 nFloats)][f32 data ...]`
    /// (data = the meshes' triangles concatenated in header order, 9 floats
    /// per triangle).
    pub fn parse_register(body: &[u8]) -> Result<Vec<(u32, Vec<f32>)>, String> {
        let rd = |o: usize| -> Result<u32, String> {
            o.checked_add(4)
                .and_then(|e| body.get(o..e))
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .ok_or_else(|| "register payload truncated".to_string())
        };
        let count = rd(0)? as usize;
        let head = count
            .checked_mul(8)
            .and_then(|h| h.checked_add(4))
            .filter(|h| *h <= body.len())
            .ok_or_else(|| "register header exceeds payload".to_string())?;
        let mut metas = Vec::with_capacity(count);
        let mut total: u64 = 0;
        for i in 0..count {
            let id = rd(4 + i * 8)?;
            let n = rd(8 + i * 8)? as u64;
            total += n;
            if total > MAX_REGISTER_FLOATS {
                return Err("register payload too large".into());
            }
            metas.push((id, n as usize));
        }
        if (body.len() - head) as u64 != total * 4 {
            return Err(format!(
                "register data is {} bytes, header declares {}",
                body.len() - head,
                total * 4
            ));
        }
        let mut off = head;
        let mut out = Vec::with_capacity(count);
        for (id, n) in metas {
            let tris: Vec<f32> = body[off..off + n * 4]
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            off += n * 4;
            out.push((id, tris));
        }
        Ok(out)
    }

    /// Pair-list body: `[u32 a, u32 b] x n`.
    pub fn parse_pairs(body: &[u8]) -> Result<Vec<(u32, u32)>, String> {
        if body.len() % 8 != 0 {
            return Err("pair payload length is not a multiple of 8".into());
        }
        Ok(body
            .chunks_exact(8)
            .map(|c| {
                (
                    u32::from_le_bytes([c[0], c[1], c[2], c[3]]),
                    u32::from_le_bytes([c[4], c[5], c[6], c[7]]),
                )
            })
            .collect())
    }

    /// Result body, all f64: `[n][k_0, v_0..][k_1, v_1..]...` where `k_i` is
    /// the record length (`-1` = an id was not registered) and `n` is the pair
    /// count. Integers are exact in f64; `Infinity` survives.
    pub fn encode_results(results: &[super::PairResult]) -> Vec<u8> {
        let floats: usize = results.iter().map(|r| 1 + r.as_ref().map_or(0, |v| v.len())).sum();
        let mut out = Vec::with_capacity((1 + floats) * 8);
        out.extend_from_slice(&(results.len() as f64).to_le_bytes());
        for r in results {
            match r {
                None => out.extend_from_slice(&(-1.0f64).to_le_bytes()),
                Some(v) => {
                    out.extend_from_slice(&(v.len() as f64).to_le_bytes());
                    for x in v {
                        out.extend_from_slice(&x.to_le_bytes());
                    }
                }
            }
        }
        out
    }

    /// Inverse of `encode_results` (used by tests; the JS bridge has its own
    /// decoder).
    pub fn decode_results(body: &[u8]) -> Result<Vec<super::PairResult>, String> {
        let mut it = body
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]));
        let n = it.next().ok_or("empty result")? as usize;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let k = it.next().ok_or("truncated result")?;
            if k < 0.0 {
                out.push(None);
            } else {
                let v: Vec<f64> = it.by_ref().take(k as usize).collect();
                if v.len() != k as usize {
                    return Err("truncated record".into());
                }
                out.push(Some(v));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{mesh_intersect_raw, mesh_min_distance};

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 40) as f32) / ((1u64 << 24) as f32)
        }
    }

    fn soup(rng: &mut Lcg, n: usize, off: f32, spread: f32, size: f32) -> Vec<f32> {
        let mut t = Vec::with_capacity(n * 9);
        for _ in 0..n {
            let (cx, cy, cz) = (
                off + rng.next() * spread,
                off + rng.next() * spread,
                off + rng.next() * spread,
            );
            for _ in 0..3 {
                t.push(cx + (rng.next() - 0.5) * size);
                t.push(cy + (rng.next() - 0.5) * size);
                t.push(cz + (rng.next() - 0.5) * size);
            }
        }
        t
    }

    fn same_bits(a: &[f64], b: &[f64], what: &str) {
        assert_eq!(a.len(), b.len(), "{what}: length");
        for (x, y) in a.iter().zip(b) {
            assert_eq!(x.to_bits(), y.to_bits(), "{what}");
        }
    }

    fn check_against_free_fns(meshes: &[Vec<f32>], threads: usize) -> usize {
        let mut eng = NativeEngine::new(threads).unwrap();
        eng.register_many(
            meshes
                .iter()
                .enumerate()
                .map(|(i, m)| (i as u32, m.clone()))
                .collect(),
        );
        let n = meshes.len() as u32;
        let mut pairs: Vec<(u32, u32)> = Vec::new();
        for a in 0..n {
            for b in 0..n {
                pairs.push((a, b));
            }
        }
        let hard = eng.detect_pairs(&pairs, Mode::Hard);
        let dist = eng.detect_pairs(&pairs, Mode::MinDist);
        assert_eq!(hard.len(), pairs.len());
        let mut hits = 0;
        for (i, &(a, b)) in pairs.iter().enumerate() {
            let (ta, tb) = (&meshes[a as usize], &meshes[b as usize]);
            let want = mesh_intersect_raw(ta, tb);
            if !want.is_empty() {
                hits += 1;
            }
            same_bits(&want, hard[i].as_ref().unwrap(), &format!("hard {a}x{b}"));
            same_bits(
                &mesh_min_distance(ta, tb),
                dist[i].as_ref().unwrap(),
                &format!("mindist {a}x{b}"),
            );
        }
        hits
    }

    #[test]
    fn parallel_equals_sequential_randomized() {
        let mut rng = Lcg(0xBEEF);
        let meshes: Vec<Vec<f32>> = (0..14)
            .map(|i| soup(&mut rng, 3 + (i * 11) % 47, (i % 5) as f32 * 0.6, 3.0, 0.8))
            .collect();
        for threads in [1usize, 4] {
            let hits = check_against_free_fns(&meshes, threads);
            assert!(hits > 20, "fixture must produce real hits, got {hits}");
        }
    }

    #[test]
    fn parallel_equals_sequential_dense_meshes() {
        // Hundreds of heavily overlapping triangles in a tiny volume: hits the
        // 8-point collect cap and deep BVH paths on almost every pair.
        let mut rng = Lcg(0xD3E5);
        let meshes: Vec<Vec<f32>> = (0..6)
            .map(|i| soup(&mut rng, 300 + i * 40, 0.0, 1.0, 1.2))
            .collect();
        let hits = check_against_free_fns(&meshes, 3);
        assert!(hits >= 30, "dense fixture should hit nearly everywhere, got {hits}");
    }

    #[test]
    fn results_are_in_input_order_and_unknown_ids_are_none() {
        let mut rng = Lcg(3);
        let a = soup(&mut rng, 20, 0.0, 1.0, 1.0);
        let b = soup(&mut rng, 20, 0.0, 1.0, 1.0);
        let c = soup(&mut rng, 20, 50.0, 1.0, 1.0);
        let mut eng = NativeEngine::new(2).unwrap();
        eng.register_many(vec![(10, a.clone()), (20, b.clone()), (30, c.clone())]);
        // a scrambled, repeated list so a mis-ordered collect would show
        let base = [(10, 20), (10, 30), (99, 10), (20, 10), (30, 30), (10, 99), (20, 30)];
        let pairs: Vec<(u32, u32)> = (0..500).map(|i| base[(i * 7) % base.len()]).collect();
        let out = eng.detect_pairs(&pairs, Mode::Hard);
        for (i, &(x, y)) in pairs.iter().enumerate() {
            if x == 99 || y == 99 {
                assert!(out[i].is_none(), "unknown id must be None");
            } else {
                let get = |id| match id {
                    10 => &a,
                    20 => &b,
                    _ => &c,
                };
                same_bits(
                    &mesh_intersect_raw(get(x), get(y)),
                    out[i].as_ref().unwrap(),
                    "ordered",
                );
            }
        }
        assert!(eng.detect_pairs(&[], Mode::Hard).is_empty());
    }

    #[test]
    fn registry_lifecycle_and_empty_meshes() {
        let mut eng = NativeEngine::new(1).unwrap();
        assert!(eng.is_empty());
        eng.register(1, &[]);
        eng.register_many(vec![
            (2, vec![0.0; 6]),
            (3, vec![0., 0., 0., 1., 0., 0., 0., 1., 0.]),
        ]);
        assert_eq!(eng.len(), 3);
        assert_eq!(eng.total_floats(), 15);
        let r = eng.detect_pairs(&[(1, 3), (2, 3)], Mode::MinDist);
        assert!(r[0].as_ref().unwrap()[0].is_infinite() && r[1].as_ref().unwrap()[0].is_infinite());
        assert!(eng.detect_pairs(&[(1, 3)], Mode::Hard)[0].as_ref().unwrap().is_empty());
        assert!(eng.unregister(3) && !eng.unregister(3));
        assert!(eng.detect_pairs(&[(1, 3)], Mode::Hard)[0].is_none());
        eng.clear();
        assert!(eng.is_empty());
    }

    /// Manual benchmark (not part of the normal run):
    /// `cargo test --release --features native bench_parallel -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_parallel_speedup() {
        use std::time::Instant;
        let mut rng = Lcg(0xACE);
        let meshes: Vec<Vec<f32>> = (0..48).map(|i| soup(&mut rng, 400 + (i % 5) * 60, 0.0, 6.0, 1.0)).collect();
        let mut pairs = Vec::new();
        for a in 0..meshes.len() as u32 {
            for b in (a + 1)..meshes.len() as u32 {
                pairs.push((a, b));
            }
        }
        let t = Instant::now();
        let seq_h: Vec<Vec<f64>> = pairs.iter().map(|&(a, b)| mesh_intersect_raw(&meshes[a as usize], &meshes[b as usize])).collect();
        let seq_ms = t.elapsed().as_secs_f64() * 1e3;
        println!("pairs={} sequential free fns (BVH rebuilt per pair): {:.0} ms", pairs.len(), seq_ms);
        for threads in [1usize, 2, 0] {
            let mut eng = NativeEngine::new(threads).unwrap();
            let t = Instant::now();
            eng.register_many(meshes.iter().enumerate().map(|(i, m)| (i as u32, m.clone())).collect());
            let reg = t.elapsed().as_secs_f64() * 1e3;
            let t = Instant::now();
            let h = eng.detect_pairs(&pairs, Mode::Hard);
            let hard_ms = t.elapsed().as_secs_f64() * 1e3;
            let t = Instant::now();
            let _d = eng.detect_pairs(&pairs, Mode::MinDist);
            let md_ms = t.elapsed().as_secs_f64() * 1e3;
            for (i, r) in h.iter().enumerate() {
                same_bits(&seq_h[i], r.as_ref().unwrap(), "bench parity");
            }
            println!("threads={} register {:.0} ms | hard {:.0} ms | mindist {:.0} ms", eng.threads(), reg, hard_ms, md_ms);
        }
    }

    #[test]
    fn wire_round_trip() {
        let m1: Vec<f32> = vec![0., 0., 0., 1., 0., 0., 0., 1., 0.];
        let m2: Vec<f32> = vec![
            0.25, 0.25, -1., 0.75, 0.25, -1., 0.5, 0.25, 1., 5., 5., 5., 6., 5., 5., 5., 6., 5.,
        ];
        let mut body = Vec::new();
        body.extend_from_slice(&2u32.to_le_bytes());
        for (id, m) in [(7u32, &m1), (9u32, &m2)] {
            body.extend_from_slice(&id.to_le_bytes());
            body.extend_from_slice(&(m.len() as u32).to_le_bytes());
        }
        for m in [&m1, &m2] {
            for f in m.iter() {
                body.extend_from_slice(&f.to_le_bytes());
            }
        }
        let parsed = wire::parse_register(&body).unwrap();
        assert_eq!(parsed, vec![(7, m1.clone()), (9, m2.clone())]);
        // corrupt / truncated / hostile payloads are errors, never panics
        assert!(wire::parse_register(&body[..body.len() - 1]).is_err());
        assert!(wire::parse_register(&[]).is_err());
        assert!(wire::parse_register(&u32::MAX.to_le_bytes()).is_err());
        let mut huge = 1u32.to_le_bytes().to_vec();
        huge.extend_from_slice(&1u32.to_le_bytes());
        huge.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(wire::parse_register(&huge).is_err());
        assert!(wire::parse_pairs(&[1, 2, 3]).is_err());

        let pairs = wire::parse_pairs(&[7, 0, 0, 0, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]).unwrap();
        assert_eq!(pairs, vec![(7, 9), (1, 1)]);
        let mut eng = NativeEngine::new(2).unwrap();
        eng.register_many(parsed);
        for mode in [Mode::Hard, Mode::MinDist] {
            let res = eng.detect_pairs(&[(7, 9), (7, 1)], mode);
            let dec = wire::decode_results(&wire::encode_results(&res)).unwrap();
            assert_eq!(dec.len(), 2);
            same_bits(res[0].as_ref().unwrap(), dec[0].as_ref().unwrap(), "wire");
            assert!(dec[1].is_none());
        }
        let inf = wire::decode_results(&wire::encode_results(&[Some(vec![f64::INFINITY])])).unwrap();
        assert!(inf[0].as_ref().unwrap()[0].is_infinite());
    }
}
