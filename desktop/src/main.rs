#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod folder;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const CONFIG_HINT: &str = "Set the server with `--server <url>`, the DDD_SERVER_URL \
environment variable, or `server_url = \"https://…\"` in ~/.config/ddd/desktop.toml.";

fn server_url() -> Result<Url, String> {
    let mut args = std::env::args().skip(1);
    let mut from_args = None;
    while let Some(arg) = args.next() {
        if arg == "--server" {
            from_args = args.next();
        } else if let Some(v) = arg.strip_prefix("--server=") {
            from_args = Some(v.to_owned());
        }
    }
    let raw = from_args
        .or_else(|| {
            std::env::var("DDD_SERVER_URL")
                .ok()
                .filter(|v| !v.is_empty())
        })
        .or_else(|| config::read()?.server_url)
        .ok_or_else(|| format!("No server configured.\n\n{CONFIG_HINT}"))?;
    let url =
        Url::parse(&raw).map_err(|e| format!("`{raw}` is not a URL ({e}).\n\n{CONFIG_HINT}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!(
            "`{raw}` must be http:// or https://.\n\n{CONFIG_HINT}"
        ));
    }
    Ok(url)
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.origin() == b.origin()
}

fn open_externally(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto")
        && let Err(e) = app.opener().open_url(url.as_str(), None::<&str>)
    {
        eprintln!("ddd-desktop: could not open {url}: {e}");
    }
}

fn show_error(text: String) {
    std::thread::spawn(move || {
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("ddd")
            .set_description(text)
            .show();
    });
}

fn on_download(event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { destination, .. } => {
            let mut dialog = rfd::FileDialog::new().set_title("Save as");
            if let Some(name) = destination.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy());
            }
            if let Some(dir) = destination.parent() {
                dialog = dialog.set_directory(dir);
            }
            match dialog.save_file() {
                Some(path) => {
                    *destination = path;
                    true
                }
                None => false,
            }
        }
        DownloadEvent::Finished {
            success: false,
            path,
            ..
        } => {
            if let Some(path) = path {
                show_error(format!("Could not save {}.", path.display()));
            }
            true
        }
        _ => true,
    }
}

fn work_around_webkit_nvidia() {
    const EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";
    const FORCE_DMABUF: &str = "WEBKIT_FORCE_DMABUF_RENDERER";
    const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    let nvidia = std::path::Path::new("/proc/driver/nvidia").exists();
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty());
    let unset = [EXPLICIT_SYNC, FORCE_DMABUF, DISABLE_DMABUF]
        .iter()
        .all(|var| std::env::var_os(var).is_none());
    if !nvidia || !unset {
        return;
    }
    unsafe {
        std::env::set_var(FORCE_DMABUF, "1");
        if wayland {
            std::env::set_var(EXPLICIT_SYNC, "1");
        }
    }
}

fn main() {
    work_around_webkit_nvidia();
    let server = match server_url() {
        Ok(url) => url,
        Err(message) => {
            eprintln!("ddd-desktop: {message}");
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("ddd")
                .set_description(message)
                .show();
            std::process::exit(2);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(folder::Folder::load())
        .invoke_handler(tauri::generate_handler![
            folder::folder_current,
            folder::folder_choose,
            folder::folder_forget,
            folder::folder_list,
            folder::folder_read,
            folder::folder_write,
            folder::folder_move,
            folder::folder_remove,
        ])
        .setup(move |app| {
            let origin = server.origin().ascii_serialization();
            let mut capability = CapabilityBuilder::new("server-folder")
                .remote(format!("{origin}/*"))
                .local(false)
                .window("main");
            for command in [
                "current", "choose", "forget", "list", "read", "write", "move", "remove",
            ] {
                capability = capability.permission(format!("allow-folder-{command}"));
            }
            app.add_capability(capability)?;
            app.state::<folder::Folder>().watch(app.handle());

            let handle = app.handle().clone();
            let nav_handle = handle.clone();
            let nav_origin = server.clone();
            let win_handle = handle.clone();
            let win_origin = server.clone();

            let mut window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(server.clone()));
            if cfg!(debug_assertions) {
                window =
                    window.data_directory(app.path().app_local_data_dir()?.join("dev-webview"));
            }

            window
                .title("ddd")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 480.0)
                .initialization_script(folder::bridge_script(&origin))
                .on_navigation(move |url| {
                    if same_origin(url, &nav_origin)
                        || matches!(url.scheme(), "blob" | "data" | "about")
                    {
                        return true;
                    }
                    open_externally(&nav_handle, url);
                    false
                })
                .on_new_window(move |url, _features| {
                    if same_origin(&url, &win_origin) && url.path().starts_with("/api/") {
                        if let Some(main) = win_handle.get_webview_window("main") {
                            let _ = main.navigate(url);
                        }
                    } else {
                        open_externally(&win_handle, &url);
                    }
                    NewWindowResponse::Deny
                })
                .on_download(|_webview, event| on_download(event))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ddd");
}
