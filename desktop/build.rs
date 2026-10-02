fn main() {
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
        ]),
    ))
    .expect("failed to run tauri-build");
}
