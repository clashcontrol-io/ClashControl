// Declaring the app commands here makes Tauri generate one `allow-<command>`
// permission per entry and REQUIRE a capability to invoke them; the only
// grant is capabilities/default.json (a unit test in src/engine_cmds.rs keeps
// this list, the handler and the capability file in sync).
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "register_meshes",
            "register_mesh",
            "unregister_mesh",
            "clear_meshes",
            "intersect_batch",
            "min_dist_batch",
            "engine_info",
        ]),
    ))
    .expect("failed to run tauri-build");
}
