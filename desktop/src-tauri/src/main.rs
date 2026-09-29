// ClashControl desktop shell: system WebView around the same index.html the
// website serves, plus (Phase 2) a native multi-core clash narrow phase
// exposed as Tauri commands (see engine_cmds.rs, addons/tauri-bridge.js and
// ../../docs/TAURI.md for the phased plan and the addon-boundary rules).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine_cmds;

fn main() {
    let engine = engine_cmds::EngineState::new().expect("native engine thread pool");
    tauri::Builder::default()
        .manage(engine)
        .invoke_handler(tauri::generate_handler![
            engine_cmds::register_meshes,
            engine_cmds::register_mesh,
            engine_cmds::unregister_mesh,
            engine_cmds::clear_meshes,
            engine_cmds::intersect_batch,
            engine_cmds::min_dist_batch,
            engine_cmds::engine_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ClashControl desktop");
}
