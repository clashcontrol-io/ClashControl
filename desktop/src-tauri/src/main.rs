// ClashControl desktop shell (Phase 0): plain WebView around the same
// index.html the website serves. Native commands (streamed file reads,
// disk geo-cache, in-process clash engine) arrive in Phase 1/2 — see
// ../../TAURI.md for the phased plan and the addon-boundary rules.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running ClashControl desktop");
}
