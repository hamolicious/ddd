fn main() {
    // The app's own commands get ACL permissions (`allow-folder-list`, …) so a capability
    // can grant them to the *remote* server origin at runtime: Tauri refuses a remote
    // page every custom command that no capability names.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "folder_current",
            "folder_choose",
            "folder_forget",
            "folder_list",
            "folder_read",
            "folder_write",
            "folder_move",
            "folder_remove",
            "server_move", // RENAME-HOP
        ]),
    ))
    .expect("failed to run tauri-build");
}
