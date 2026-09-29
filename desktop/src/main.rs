//! Life Manager on the Linux desktop: the server's PWA in a WebKitGTK window.
//!
//! Deliberately **not** a port of the Flutter shell (`app/`). No `window.shell` is
//! injected: a versioned bridge makes `inShell()` true in `web/app/src/boot/shell.ts`,
//! which switches the page to bearer auth and skips the service worker — i.e. no offline
//! boot. Loaded straight from the server, the page is an ordinary browser tab (cookie
//! session, service worker, IndexedDB), and its browser fallbacks for
//! `kernel.capabilities.filesystem` already cover everything:
//!
//! * `export` is a blob `<a download>` → [`on_download`] asks where to save it;
//! * `pick` is `<input type=file>` → WebKitGTK opens the native chooser by itself;
//! * `exportWorkspace` is a `target=_blank` link to `/api/admin/export` → [`on_new_window`]
//!   turns it into a download in the main webview, where the cookie authenticates it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde::Deserialize;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const CONFIG_HINT: &str = "Set the server with `--server <url>`, the LM_SERVER_URL \
environment variable, or `server_url = \"https://…\"` in ~/.config/life-manager/desktop.toml.";

#[derive(Deserialize)]
struct Config {
    server_url: Option<String>,
}

fn config_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("life-manager").join("desktop.toml"))
}

/// `--server` beats `LM_SERVER_URL` beats the config file.
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
        .or_else(|| std::env::var("LM_SERVER_URL").ok().filter(|v| !v.is_empty()))
        .or_else(|| {
            let text = std::fs::read_to_string(config_path()?).ok()?;
            toml::from_str::<Config>(&text).ok()?.server_url
        })
        .ok_or_else(|| format!("No server configured.\n\n{CONFIG_HINT}"))?;
    let url = Url::parse(&raw).map_err(|e| format!("`{raw}` is not a URL ({e}).\n\n{CONFIG_HINT}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("`{raw}` must be http:// or https://.\n\n{CONFIG_HINT}"));
    }
    Ok(url)
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.origin() == b.origin()
}

/// Everything off-origin goes to the system browser; the app window stays on the app.
fn open_externally(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("life-manager-desktop: could not open {url}: {e}");
        }
    }
}

fn show_error(text: String) {
    // Off the main thread: `Finished` arrives on the GTK loop, and nothing is waiting on this.
    std::thread::spawn(move || {
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("Life Manager")
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
        DownloadEvent::Finished { success: false, path, .. } => {
            // A cancelled dialog also lands here with no path; only a real attempt is news.
            if let Some(path) = path {
                show_error(format!("Could not save {}.", path.display()));
            }
            true
        }
        _ => true,
    }
}

/// WebKitGTK's DMA-BUF renderer dies on NVIDIA under Wayland ("Error 71 (Protocol error)
/// dispatching to Wayland display", then a blank or closed window). Falling back to the
/// shared-memory path costs some compositing speed and nothing else. Only on NVIDIA, and
/// only when the user has not set it either way.
fn work_around_webkit_nvidia() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VAR).is_none() && std::path::Path::new("/proc/driver/nvidia").exists() {
        // SAFETY: first thing in `main`, before Tauri or anything else has spawned a thread.
        unsafe { std::env::set_var(VAR, "1") };
    }
}

fn main() {
    work_around_webkit_nvidia();
    let server = match server_url() {
        Ok(url) => url,
        Err(message) => {
            eprintln!("life-manager-desktop: {message}");
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Life Manager")
                .set_description(message)
                .show();
            std::process::exit(2);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let nav_handle = handle.clone();
            let nav_origin = server.clone();
            let win_handle = handle.clone();
            let win_origin = server.clone();

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(server.clone()))
                .title("Life Manager")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 480.0)
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
        .expect("error while running Life Manager");
}
