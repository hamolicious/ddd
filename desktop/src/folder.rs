//! The notes folder: one directory the user chose, exposed to the page as the `folder`
//! bridge capability (`app/BRIDGE.md` §4.5) and watched for changes.
//!
//! Every path from the page is relative and goes through [`resolve`], which refuses
//! anything absolute or climbing out, and refuses a result that a symlink would carry
//! outside the root. Writes land in `.ddd/tmp/` first and are renamed into place,
//! so another program never sees half a file. Changes on disk reach the page as the
//! `ddd-folder-changed` window event, debounced.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::config;

/// The bridge's error envelope: `{ code, message }` with one of the frozen codes.
#[derive(Debug, Serialize)]
pub struct BridgeError {
    code: &'static str,
    message: String,
}

impl BridgeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for BridgeError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::PermissionDenied => "denied",
            _ => "failed",
        };
        Self::new(code, error.to_string())
    }
}

type Result<T> = std::result::Result<T, BridgeError>;

const STATE_DIR: &str = ".ddd";
const TMP_DIR: &str = ".ddd/tmp";
const DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct Folder {
    root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl Folder {
    /// The folder from the config file, if it still exists.
    pub fn load() -> Self {
        let root = config::read()
            .and_then(|c| c.folder)
            .map(PathBuf::from)
            .filter(|p| p.is_dir());
        // RENAME-HOP: the old build kept its state in `<folder>/.life-manager`.
        if let Some(root) = &root {
            crate::rename_hop::migrate_state_dir(root, STATE_DIR);
        }
        Self {
            root: Mutex::new(root),
            watcher: Mutex::new(None),
        }
    }

    fn root(&self) -> Result<PathBuf> {
        self.root
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| BridgeError::new("unsupported", "no folder is chosen"))
    }

    /// (Re)start the watcher on the current root, or stop it when there is none.
    pub fn watch(&self, app: &AppHandle) {
        let mut slot = self.watcher.lock().unwrap();
        *slot = None;
        let Some(root) = self.root.lock().unwrap().clone() else {
            return;
        };
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("ddd-desktop: cannot watch {}: {e}", root.display());
                return;
            }
        };
        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            eprintln!("ddd-desktop: cannot watch {}: {e}", root.display());
            return;
        }
        *slot = Some(watcher);
        let app = app.clone();
        // Ends when the watcher is dropped (the sender goes with it).
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut paths = BTreeSet::new();
                let mut collect = |event: notify::Result<notify::Event>| {
                    for path in event.map(|e| e.paths).unwrap_or_default() {
                        if let Some(rel) = relative(&root, &path)
                            && !rel.starts_with(STATE_DIR)
                            // RENAME-HOP: the old state dir, until it is moved.
                            && !rel.starts_with(crate::rename_hop::OLD_STATE_DIR)
                        {
                            paths.insert(rel);
                        }
                    }
                };
                collect(first);
                while let Ok(next) = rx.recv_timeout(DEBOUNCE) {
                    collect(next);
                }
                if paths.is_empty() {
                    continue;
                }
                let detail = serde_json::json!({ "paths": paths });
                let script = format!(
                    "window.dispatchEvent(new CustomEvent(\"ddd-folder-changed\", {{ detail: {detail} }}));"
                );
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.eval(script);
                }
            }
        });
    }
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let text = rel.to_str()?.replace('\\', "/");
    (!text.is_empty()).then_some(text)
}

/// A page-supplied relative path, made absolute under `root`.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    if rel.is_empty() || rel.contains('\0') || rel.contains('\\') {
        return Err(BridgeError::new(
            "invalid",
            format!("not a relative path: {rel}"),
        ));
    }
    let mut out = root.to_path_buf();
    let mut any = false;
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => {
                out.push(part);
                any = true;
            }
            Component::CurDir => {}
            _ => return Err(BridgeError::new("invalid", "path climbs out of the folder")),
        }
    }
    if !any {
        return Err(BridgeError::new("invalid", "empty path"));
    }
    // A symlink inside the folder must not lead outside it. Check the deepest part that exists.
    let canonical_root = root.canonicalize()?;
    let mut probe = out.as_path();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    if probe.exists() && !probe.canonicalize()?.starts_with(&canonical_root) {
        return Err(BridgeError::new(
            "invalid",
            "path leaves the folder through a link",
        ));
    }
    Ok(out)
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[derive(Serialize)]
pub struct Label {
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    path: String,
    kind: &'static str,
    size: u64,
    mtime_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    data: String,
    mtime_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    mtime_ms: f64,
}

#[tauri::command]
pub async fn folder_current(folder: State<'_, Folder>) -> Result<Option<Label>> {
    Ok(folder.root.lock().unwrap().as_ref().map(|p| Label {
        label: p.display().to_string(),
    }))
}

#[tauri::command]
pub async fn folder_choose(app: AppHandle, folder: State<'_, Folder>) -> Result<Label> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Choose a folder for your notes")
        .pick_folder()
        .await
        .ok_or_else(|| BridgeError::new("cancelled", "no folder was chosen"))?;
    let path = picked.path().to_path_buf();
    // RENAME-HOP: a folder the old build used keeps its state in `.life-manager`.
    crate::rename_hop::migrate_state_dir(&path, STATE_DIR);
    config::set_folder(Some(&path)).map_err(|e| BridgeError::new("failed", e))?;
    *folder.root.lock().unwrap() = Some(path.clone());
    folder.watch(&app);
    Ok(Label {
        label: path.display().to_string(),
    })
}

#[tauri::command]
pub async fn folder_forget(app: AppHandle, folder: State<'_, Folder>) -> Result<()> {
    config::set_folder(None).map_err(|e| BridgeError::new("failed", e))?;
    *folder.root.lock().unwrap() = None;
    folder.watch(&app);
    Ok(())
}

#[tauri::command]
pub async fn folder_list(folder: State<'_, Folder>) -> Result<Vec<Entry>> {
    let root = folder.root()?;
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for item in std::fs::read_dir(&dir)? {
            let item = item?;
            let path = item.path();
            // Not followed: a link could lead anywhere, and loops forever.
            let meta = std::fs::symlink_metadata(&path)?;
            let Some(rel) = relative(&root, &path) else {
                continue;
            };
            if rel == TMP_DIR || rel.starts_with(&format!("{TMP_DIR}/")) {
                continue;
            }
            if meta.is_dir() {
                out.push(Entry {
                    path: rel,
                    kind: "dir",
                    size: 0,
                    mtime_ms: mtime_ms(&meta),
                });
                stack.push(path);
            } else if meta.is_file() {
                out.push(Entry {
                    path: rel,
                    kind: "file",
                    size: meta.len(),
                    mtime_ms: mtime_ms(&meta),
                });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn folder_read(folder: State<'_, Folder>, path: String) -> Result<Read> {
    let full = resolve(&folder.root()?, &path)?;
    let bytes = std::fs::read(&full)?;
    let meta = std::fs::metadata(&full)?;
    Ok(Read {
        data: B64.encode(bytes),
        mtime_ms: mtime_ms(&meta),
    })
}

#[tauri::command]
pub async fn folder_write(
    folder: State<'_, Folder>,
    path: String,
    data: String,
) -> Result<Written> {
    let root = folder.root()?;
    let full = resolve(&root, &path)?;
    let bytes = B64
        .decode(data)
        .map_err(|e| BridgeError::new("invalid", format!("data is not base64: {e}")))?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp_dir = root.join(TMP_DIR);
    std::fs::create_dir_all(&tmp_dir)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = tmp_dir.join(format!("{}-{nonce}", std::process::id()));
    {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    if let Err(e) = std::fs::rename(&tmp, &full) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(Written {
        mtime_ms: mtime_ms(&std::fs::metadata(&full)?),
    })
}

#[tauri::command]
pub async fn folder_move(folder: State<'_, Folder>, from: String, to: String) -> Result<()> {
    let root = folder.root()?;
    let (from, to) = (resolve(&root, &from)?, resolve(&root, &to)?);
    if to.exists() {
        return Err(BridgeError::new(
            "failed",
            format!("{} already exists", to.display()),
        ));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(from, to)?;
    Ok(())
}

#[tauri::command]
pub async fn folder_remove(folder: State<'_, Folder>, path: String) -> Result<()> {
    let full = resolve(&folder.root()?, &path)?;
    let result = match std::fs::symlink_metadata(&full) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir(&full),
        Ok(_) => std::fs::remove_file(&full),
        Err(e) => Err(e),
    };
    match result {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => Ok(other?),
    }
}

/// `window.shell` for the desktop page: a cookie-session bridge carrying `folder` only
/// (`app/BRIDGE.md` §3), plus the RENAME-HOP `server.move` (§4.6). Injected into frames on
/// the server's origin and nowhere else.
pub fn bridge_script(origin: &str) -> String {
    let origin = serde_json::to_string(origin).expect("a string serializes");
    format!(
        r#"(function () {{
  if (location.origin !== {origin} || window.shell) return;
  function invoke(cmd, args) {{
    var ipc = window.__TAURI_INTERNALS__;
    if (!ipc) return Promise.reject(Object.assign(new Error("the desktop bridge is not ready"), {{ code: "failed" }}));
    return ipc.invoke(cmd, args || {{}}).catch(function (e) {{
      var error = new Error((e && e.message) || String(e));
      error.code = (e && e.code) || "failed";
      throw error;
    }});
  }}
  var folder = Object.freeze({{
    current: function () {{ return invoke("folder_current"); }},
    choose: function () {{ return invoke("folder_choose"); }},
    forget: function () {{ return invoke("folder_forget"); }},
    list: function () {{ return invoke("folder_list"); }},
    read: function (p) {{ return invoke("folder_read", {{ path: p.path }}); }},
    write: function (p) {{ return invoke("folder_write", {{ path: p.path, data: p.data }}); }},
    move: function (p) {{ return invoke("folder_move", {{ from: p.from, to: p.to }}); }},
    remove: function (p) {{ return invoke("folder_remove", {{ path: p.path }}); }}
  }});
  // RENAME-HOP: `server.move` switches the app to the renamed server's origin and restarts.
  var server = Object.freeze({{
    move: function (p) {{ return invoke("server_move", {{ url: p.url }}); }}
  }});
  Object.defineProperty(window, "shell", {{
    value: Object.freeze({{
      version: 1,
      bridgeVersion: 1,
      platform: "linux",
      session: "cookie",
      capabilities: Object.freeze(["folder"]),
      methods: Object.freeze(["folder.choose", "folder.current", "folder.forget", "folder.list", "folder.move", "folder.read", "folder.remove", "folder.write", "server.move"]),
      folder: folder,
      server: server
    }}),
    writable: false,
    configurable: false
  }});
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ddd-folder-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Home")).unwrap();
        dir
    }

    #[test]
    fn resolves_relative_paths_inside_the_root() {
        let root = root();
        assert_eq!(
            resolve(&root, "Home/Home.md").unwrap(),
            root.join("Home/Home.md")
        );
        assert_eq!(
            resolve(&root, "New/Deep/File.md").unwrap(),
            root.join("New/Deep/File.md")
        );
    }

    #[test]
    fn refuses_paths_that_climb_out() {
        let root = root();
        for bad in ["../x", "Home/../../x", "/etc/passwd", "", "a\\b", "."] {
            let error = resolve(&root, bad).unwrap_err();
            assert_eq!(error.code, "invalid", "{bad}");
        }
    }

    #[test]
    fn refuses_a_link_that_leads_outside() {
        let root = root();
        let link = root.join("escape");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink("/tmp", &link).unwrap();
        assert_eq!(resolve(&root, "escape/x").unwrap_err().code, "invalid");
    }
}
