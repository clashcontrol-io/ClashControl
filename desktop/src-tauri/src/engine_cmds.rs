//! Native clash-engine Tauri commands (Phase 2).
//!
//! Thin wrappers over `clashcontrol_engine::native` — the SAME Engine/BVH code
//! the WASM build runs, so results are bit-identical to the browser. Payloads
//! travel as raw little-endian bytes (`InvokeBody::Raw` in, `ipc::Response`
//! out), never as JSON arrays of floats. Wire layouts: see
//! `clashcontrol_engine::native::wire` and `addons/tauri-bridge.js`.
//!
//! All logic lives in the `*_impl` functions (plain Rust, no webview) so the
//! unit tests below exercise exactly what the commands run.

use std::sync::{Arc, RwLock};

use clashcontrol_engine::native::{wire, Mode, NativeEngine};
use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};

/// Bumped when the wire layout changes; the JS bridge refuses a mismatch.
pub const API_VERSION: u32 = 1;

#[derive(Clone)]
pub struct EngineState(Arc<RwLock<NativeEngine>>);

impl EngineState {
    pub fn new() -> Result<EngineState, String> {
        Ok(EngineState(Arc::new(RwLock::new(NativeEngine::new(0)?))))
    }
}

fn poisoned<T>(_: T) -> String {
    "native engine lock poisoned".to_string()
}

pub fn register_meshes_impl(st: &EngineState, body: &[u8]) -> Result<u32, String> {
    let items = wire::parse_register(body)?;
    let n = items.len() as u32;
    st.0.write().map_err(poisoned)?.register_many(items);
    Ok(n)
}

/// Single mesh: `[u32 id][f32 data ...]`.
pub fn register_mesh_impl(st: &EngineState, body: &[u8]) -> Result<u32, String> {
    if body.len() < 4 || (body.len() - 4) % 4 != 0 {
        return Err("register_mesh payload must be u32 id + f32 data".into());
    }
    let id = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let tris: Vec<f32> = body[4..]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    st.0.write().map_err(poisoned)?.register(id, &tris);
    Ok(id)
}

pub fn unregister_mesh_impl(st: &EngineState, id: u32) -> Result<bool, String> {
    Ok(st.0.write().map_err(poisoned)?.unregister(id))
}

pub fn clear_meshes_impl(st: &EngineState) -> Result<(), String> {
    st.0.write().map_err(poisoned)?.clear();
    Ok(())
}

pub fn batch_impl(st: &EngineState, body: &[u8], mode: Mode) -> Result<Vec<u8>, String> {
    let pairs = wire::parse_pairs(body)?;
    let res = st.0.read().map_err(poisoned)?.detect_pairs(&pairs, mode);
    Ok(wire::encode_results(&res))
}

pub fn engine_info_impl(st: &EngineState) -> Result<Value, String> {
    let e = st.0.read().map_err(poisoned)?;
    Ok(json!({
        "api": API_VERSION,
        "engine": "clashcontrol-engine-native",
        "version": env!("CARGO_PKG_VERSION"),
        "threads": e.threads(),
        "meshes": e.len(),
        "floats": e.total_floats(),
    }))
}

fn raw_body<'a>(req: &'a Request<'_>) -> Result<&'a [u8], String> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b.as_slice()),
        InvokeBody::Json(_) => Err("expected a raw binary payload".into()),
    }
}

// ── Tauri commands (async: run off the main/UI thread) ──────────────

#[tauri::command]
pub async fn register_meshes(state: tauri::State<'_, EngineState>, request: Request<'_>) -> Result<u32, String> {
    register_meshes_impl(&state, raw_body(&request)?)
}

#[tauri::command]
pub async fn register_mesh(state: tauri::State<'_, EngineState>, request: Request<'_>) -> Result<u32, String> {
    register_mesh_impl(&state, raw_body(&request)?)
}

#[tauri::command]
pub async fn unregister_mesh(state: tauri::State<'_, EngineState>, id: u32) -> Result<bool, String> {
    unregister_mesh_impl(&state, id)
}

#[tauri::command]
pub async fn clear_meshes(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    clear_meshes_impl(&state)
}

#[tauri::command]
pub async fn intersect_batch(state: tauri::State<'_, EngineState>, request: Request<'_>) -> Result<Response, String> {
    batch_impl(&state, raw_body(&request)?, Mode::Hard).map(Response::new)
}

#[tauri::command]
pub async fn min_dist_batch(state: tauri::State<'_, EngineState>, request: Request<'_>) -> Result<Response, String> {
    batch_impl(&state, raw_body(&request)?, Mode::MinDist).map(Response::new)
}

#[tauri::command]
pub async fn engine_info(state: tauri::State<'_, EngineState>) -> Result<Value, String> {
    engine_info_impl(&state)
}

/// Every command name above; `build.rs` generates one `allow-<name>`
/// permission per entry and `capabilities/default.json` grants exactly these.
#[cfg(test)]
pub const COMMANDS: &[&str] = &[
    "register_meshes",
    "register_mesh",
    "unregister_mesh",
    "clear_meshes",
    "intersect_batch",
    "min_dist_batch",
    "engine_info",
];

#[cfg(test)]
mod tests {
    use super::*;
    use clashcontrol_engine::{mesh_intersect_raw, mesh_min_distance};

    fn tri_bytes(m: &[f32]) -> Vec<u8> {
        m.iter().flat_map(|f| f.to_le_bytes()).collect()
    }
    fn register_body(items: &[(u32, &[f32])]) -> Vec<u8> {
        let mut b = (items.len() as u32).to_le_bytes().to_vec();
        for (id, m) in items {
            b.extend_from_slice(&id.to_le_bytes());
            b.extend_from_slice(&(m.len() as u32).to_le_bytes());
        }
        for (_, m) in items {
            b.extend(tri_bytes(m));
        }
        b
    }
    fn pair_bytes(p: &[(u32, u32)]) -> Vec<u8> {
        p.iter().flat_map(|(a, b)| a.to_le_bytes().into_iter().chain(b.to_le_bytes())).collect()
    }

    const A: [f32; 9] = [0., 0., 0., 1., 0., 0., 0., 1., 0.];
    const B: [f32; 9] = [0.2, 0.2, -1., 0.8, 0.2, -1., 0.5, 0.2, 1.];
    const C: [f32; 9] = [10., 10., 10., 11., 10., 10., 10., 11., 10.];

    #[test]
    fn commands_match_free_functions_over_the_wire() {
        let st = EngineState::new().unwrap();
        assert_eq!(register_meshes_impl(&st, &register_body(&[(1, &A), (2, &B)])).unwrap(), 2);
        assert_eq!(register_mesh_impl(&st, &[&3u32.to_le_bytes()[..], &tri_bytes(&C)].concat()).unwrap(), 3);
        let info = engine_info_impl(&st).unwrap();
        assert_eq!(info["meshes"], 3);
        assert_eq!(info["floats"], 27);
        assert_eq!(info["api"], API_VERSION);
        assert!(info["threads"].as_u64().unwrap() >= 1);

        let pairs = [(1, 2), (1, 3), (2, 1), (1, 99)];
        let hard = wire::decode_results(&batch_impl(&st, &pair_bytes(&pairs), Mode::Hard).unwrap()).unwrap();
        let dist = wire::decode_results(&batch_impl(&st, &pair_bytes(&pairs), Mode::MinDist).unwrap()).unwrap();
        let get = |i| match i { 1 => &A, 2 => &B, _ => &C };
        for (i, &(a, b)) in pairs.iter().enumerate().take(3) {
            let (wh, wd) = (mesh_intersect_raw(get(a), get(b)), mesh_min_distance(get(a), get(b)));
            let (gh, gd) = (hard[i].as_ref().unwrap(), dist[i].as_ref().unwrap());
            assert_eq!(wh.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), gh.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
            assert_eq!(wd.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), gd.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
        }
        assert!(!hard[0].as_ref().unwrap().is_empty(), "A x B is a real hit");
        assert!(hard[1].as_ref().unwrap().is_empty(), "A x C is a miss");
        assert!(hard[3].is_none() && dist[3].is_none(), "unknown id is None, not a miss");
    }

    #[test]
    fn lifecycle_and_bad_payloads() {
        let st = EngineState::new().unwrap();
        register_meshes_impl(&st, &register_body(&[(1, &A)])).unwrap();
        assert!(unregister_mesh_impl(&st, 1).unwrap());
        assert!(!unregister_mesh_impl(&st, 1).unwrap());
        register_meshes_impl(&st, &register_body(&[(1, &A), (2, &B)])).unwrap();
        clear_meshes_impl(&st).unwrap();
        assert_eq!(engine_info_impl(&st).unwrap()["meshes"], 0);
        assert!(register_meshes_impl(&st, &[1, 0, 0]).is_err());
        assert!(register_mesh_impl(&st, &[1, 2]).is_err());
        assert!(batch_impl(&st, &[0; 7], Mode::Hard).is_err());
        assert!(wire::decode_results(&batch_impl(&st, &[], Mode::Hard).unwrap()).unwrap().is_empty());
    }

    /// The capability file must grant exactly the commands defined here, and
    /// build.rs must declare exactly the same list.
    #[test]
    fn capability_and_build_manifest_list_exactly_these_commands() {
        let cap: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let mut granted: Vec<String> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_string())
            .collect();
        granted.sort();
        let mut want: Vec<String> = COMMANDS.iter().map(|c| format!("allow-{}", c.replace('_', "-"))).collect();
        want.sort();
        assert_eq!(granted, want);
        let build = include_str!("../build.rs");
        for c in COMMANDS {
            assert!(build.contains(&format!("\"{c}\"")), "build.rs missing {c}");
        }
    }
}
