//! ddd on the Linux desktop: the server's PWA in a WebKitGTK window.
//!
//! Deliberately **not** a port of the Flutter shell (`app/`). Loaded straight from the
//! server, the page is an ordinary browser tab (cookie session, service worker,
//! IndexedDB). The `window.shell` injected here says `session: "cookie"`, so the page
//! keeps all of that, and carries one native capability: `folder`, the notes folder
//! (`folder.rs`, `app/BRIDGE.md` §4.5). The browser fallbacks for
//! `kernel.capabilities.filesystem` cover the rest:
//!
//! * `export` is a blob `<a download>` → [`on_download`] asks where to save it;
//! * `pick` is `<input type=file>` → WebKitGTK opens the native chooser by itself;
//! * `exportWorkspace` is a `target=_blank` link to `/api/admin/export` → [`on_new_window`]
//!   turns it into a download in the main webview, where the cookie authenticates it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod folder;
mod rename_hop;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const CONFIG_HINT: &str = "Set the server with `--server <url>`, the DDD_SERVER_URL \
environment variable, or `server_url = \"https://…\"` in ~/.config/ddd/desktop.toml.";

/// The server from `--server` or `DDD_SERVER_URL`, which both beat the config file.
fn server_override() -> Option<String> {
    let mut args = std::env::args().skip(1);
    let mut from_args = None;
    while let Some(arg) = args.next() {
        if arg == "--server" {
            from_args = args.next();
        } else if let Some(v) = arg.strip_prefix("--server=") {
            from_args = Some(v.to_owned());
        }
    }
    from_args
        .or_else(|| {
            std::env::var("DDD_SERVER_URL")
                .ok()
                .filter(|v| !v.is_empty())
        })
        .or_else(legacy_server_env)
}

/// RENAME-HOP: the pre-rename `LM_SERVER_URL`, after `DDD_SERVER_URL`.
fn legacy_server_env() -> Option<String> {
    let value = std::env::var("LM_SERVER_URL")
        .ok()
        .filter(|v| !v.is_empty())?;
    eprintln!(
        "ddd-desktop: LM_SERVER_URL is deprecated and goes in the next release; \
         set DDD_SERVER_URL instead."
    );
    Some(value)
}

/// `--server` beats `DDD_SERVER_URL` (then the deprecated `LM_SERVER_URL`) beats the
/// config file.
fn server_url() -> Result<Url, String> {
    let raw = server_override()
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

/// RENAME-HOP: `window.shell.server.move({ url })`. The page, on the old domain and done
/// syncing, hands over the renamed server's origin: it becomes `server_url` in the config
/// and the app restarts on it. Only when the configured server agrees: its own
/// `/api/auth/bootstrap` must name `url` as `public_url` and list the configured origin in
/// `rename_hop_from` ([`rename_hop::verify_move`]); a page cannot point the app elsewhere.
#[tauri::command]
async fn server_move(app: AppHandle, url: String) -> Result<(), folder::BridgeError> {
    let current = server_url().map_err(|e| folder::BridgeError::new("invalid", e))?;
    let origin =
        tauri::async_runtime::spawn_blocking(move || rename_hop::verify_move(&current, &url))
            .await
            .map_err(|e| folder::BridgeError::new("failed", e.to_string()))?
            .map_err(|e| folder::BridgeError::new("invalid", e))?;
    config::set_server_url(&origin).map_err(|e| folder::BridgeError::new("failed", e))?;
    if let Some(over) = server_override() {
        eprintln!(
            "ddd-desktop: server_url = {origin} is written to the config, but --server or \
             DDD_SERVER_URL (or LM_SERVER_URL) ({over}) overrides it, so the app restarts on {over}."
        );
    } else {
        eprintln!("ddd-desktop: server moved to {origin}; restarting.");
    }
    app.restart();
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.origin() == b.origin()
}

/// Everything off-origin goes to the system browser; the app window stays on the app.
fn open_externally(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto")
        && let Err(e) = app.opener().open_url(url.as_str(), None::<&str>)
    {
        eprintln!("ddd-desktop: could not open {url}: {e}");
    }
}

fn show_error(text: String) {
    // Off the main thread: `Finished` arrives on the GTK loop, and nothing is waiting on this.
    std::thread::spawn(move || {
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("ddd")
            .set_description(text)
            .show();
    });
}

/// `Requested`: ask where to save; cancelling cancels the download. Blocking is correct
/// here — WebKit waits on the destination synchronously, and the dialog is modal anyway.
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
            // A cancelled dialog also lands here with no path; only a real attempt is news.
            if let Some(path) = path {
                show_error(format!("Could not save {}.", path.display()));
            }
            true
        }
        _ => true,
    }
}

/// WebKitGTK on the NVIDIA driver, kept on the GPU. Two things stand in the way:
///
/// * Under Wayland the driver's explicit sync trips over WebKit's DMA-BUFs and the
///   compositor drops the connection ("Error 71 (Protocol error) dispatching to Wayland
///   display", then a blank or closed window). `__NV_DISABLE_EXPLICIT_SYNC=1` for this
///   process is the whole fix: the page is still rendered by the web process on the GPU
///   and passed on as DMA-BUFs, and nothing is lost. Under X11 nothing is needed: the
///   DMA-BUF import fails harmlessly ("Failed to create GBM buffer") and the frames go
///   through shared memory, still rendered on the GPU.
/// * Debian's WebKitGTK (so Ubuntu's, and the one the AppImage bundles) carries
///   `disable-nvidia-dmabuf.patch`, which on an NVIDIA GL vendor string refuses hardware
///   acceleration outright: no compositor, every frame on the CPU. The patch's own
///   override is `WEBKIT_FORCE_DMABUF_RENDERER=1`; an unpatched build ignores it.
///
/// The old workaround here, `WEBKIT_DISABLE_DMABUF_RENDERER=1`, was far worse than it
/// looked: since WebKitGTK 2.44 it means the same CPU rendering as the Debian patch, on
/// every NVIDIA machine, which is why the shell felt slow. Only on NVIDIA, and only when
/// the user has not spoken: any of the three variables set leaves all of them alone.
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
    // SAFETY: first thing in `main`, before Tauri or anything else has spawned a thread.
    unsafe {
        std::env::set_var(FORCE_DMABUF, "1");
        if wayland {
            std::env::set_var(EXPLICIT_SYNC, "1");
        }
    }
}

fn main() {
    work_around_webkit_nvidia();
    // RENAME-HOP: move the old build's config and webview data to the new names before
    // anything reads the config or Tauri resolves a path.
    rename_hop::migrate_all(&rename_hop::Bases::from_env());
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
            server_move, // RENAME-HOP
        ])
        .setup(move |app| {
            // The server's pages may call the folder commands, and nothing else may: the
            // origin is only known now, so the capability is built here, not in JSON.
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
            // RENAME-HOP: `window.shell.server.move`.
            capability = capability.permission("allow-server-move");
            app.add_capability(capability)?;
            app.state::<folder::Folder>().watch(app.handle());

            let handle = app.handle().clone();
            let nav_handle = handle.clone();
            let nav_origin = server.clone();
            let win_handle = handle.clone();
            let win_origin = server.clone();

            let mut window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(server.clone()));
            // A debug build (`mise run desktop-run`) links the system WebKitGTK, while the
            // AppImage bundles its own, usually older, one. Sharing one data directory let
            // the newer WebKit rewrite IndexedDB in a metadata format the older cannot read,
            // and the installed app then died at boot with "Unable to establish IDB database
            // file". WebKit upgrades these files but never downgrades them, so a dev build
            // keeps its own webview data (cookies, IndexedDB, service worker) apart.
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
                    // `blob:`/`data:`/`about:` are the page's own (downloads, iframes).
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
                        // The workspace export link (`target=_blank`). Navigating the main
                        // webview to an `attachment` response starts a download without
                        // leaving the page, and it carries the session cookie. Only `/api/`:
                        // any other same-origin page would replace the running app.
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
