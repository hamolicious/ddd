use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::SystemTime;

use axum::Router;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, HeaderName, HeaderValue,
};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncReadExt as _;
use tracing::warn;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::plugins;
use crate::state::AppState;

use super::statics::{ImportMap, page_imports, render_index_body};

pub const MIN_BRIDGE_VERSION: u32 = 1;

pub const SHELL_BUNDLE_META_FILE: &str = "shell-bundle.json";

pub const SYNTHESIZED_FILES: &[&str] = &["index.html", "importmap.json"];

pub const EXCLUDED_FILES: &[&str] = &["sw.js", "sw.js.map", SHELL_BUNDLE_META_FILE];

const PLUGIN_ASSET_ROOT: &str = "frontend";

const MAX_BUNDLE_FILES: usize = 10_000;

const MAX_WALK_DEPTH: usize = 24;

const NOSNIFF: HeaderName = HeaderName::from_static("x-content-type-options");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellManifest {
    pub bundle_version: String,
    pub min_bridge_version: u32,
    pub index_csp: String,
    pub files: Vec<ShellFile>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/manifest", get(manifest))
        .route("/bundle/{*path}", get(bundle_file))
}

pub async fn manifest(State(state): State<AppState>, _user: AuthUser) -> AppResult<Response> {
    let bundle = build_bundle(&state).await?;
    Ok((
        StatusCode::OK,
        [
            (CONTENT_TYPE, HeaderValue::from_static("application/json")),
            (NOSNIFF, HeaderValue::from_static("nosniff")),
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        axum::Json(bundle.manifest.clone()),
    )
        .into_response())
}

pub async fn bundle_file(
    State(state): State<AppState>,
    _user: AuthUser,
    AxumPath(path): AxumPath<String>,
) -> Response {
    if !SYNTHESIZED_FILES.contains(&path.as_str()) {
        return AppError::NotFound("bundle file").into_response();
    }
    let bundle = match build_bundle(&state).await {
        Ok(bundle) => bundle,
        Err(err) => return err.into_response(),
    };
    let Some(file) = bundle.synthesized.get(&path) else {
        return AppError::NotFound("bundle file").into_response();
    };
    (
        StatusCode::OK,
        [
            (CONTENT_TYPE, HeaderValue::from_static(file.content_type)),
            (NOSNIFF, HeaderValue::from_static("nosniff")),
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (CONTENT_DISPOSITION, HeaderValue::from_static("attachment")),
        ],
        file.bytes.clone(),
    )
        .into_response()
}

pub struct Bundle {
    pub manifest: ShellManifest,
    synthesized: BTreeMap<String, SynthesizedFile>,
}

struct SynthesizedFile {
    bytes: Vec<u8>,
    content_type: &'static str,
}

async fn build_bundle(state: &AppState) -> AppResult<Arc<Bundle>> {
    let Some(dist) = state.config.web_dist_dir.clone() else {
        return Err(AppError::Unavailable(
            "this server serves no web bundle (WEB_DIST_DIR is not set), so there is \
             nothing for a shell to mirror"
                .to_string(),
        ));
    };

    let roots = bundle_roots(state, &dist);
    let key = cache_key(&dist, state);

    let mut entries = Vec::new();
    for root in &roots {
        walk(&root.dir, &root.prefix, &mut entries).await?;
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    let fingerprint = fingerprint(&entries, &roots);
    if let Some(cached) = cached_bundle(&key, &fingerprint) {
        return Ok(cached);
    }

    let mut files = Vec::with_capacity(entries.len());
    for entry in &entries {
        if is_excluded(&entry.path) {
            continue;
        }
        if entry.from_dist && is_shadowed_dist_path(&entry.path) {
            warn!(
                path = %entry.path,
                "shell bundle: a file in WEB_DIST_DIR has a URL another route answers; \
                 leaving it out rather than publishing a hash the download cannot match"
            );
            continue;
        }
        let (sha256, size) = hash_file(&entry.abs).await.map_err(|err| {
            AppError::Unavailable(format!(
                "cannot hash {} for the shell bundle: {err}",
                entry.path
            ))
        })?;
        files.push(ShellFile {
            path: entry.path.clone(),
            sha256,
            size,
        });
    }

    let synthesized = synthesize(state, &dist).await?;
    for (path, file) in &synthesized {
        files.push(ShellFile {
            path: path.clone(),
            sha256: hex::encode(Sha256::digest(&file.bytes)),
            size: file.bytes.len() as u64,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);

    let index_csp = shell_csp(&nonce_of(&synthesized), state.config.public_url.as_deref());
    let bundle = Arc::new(Bundle {
        manifest: ShellManifest {
            bundle_version: bundle_version(&files),
            min_bridge_version: min_bridge_version(&dist).await,
            index_csp,
            files,
        },
        synthesized,
    });

    tracing::debug!(
        bundle_version = %bundle.manifest.bundle_version,
        files = bundle.manifest.files.len(),
        bytes = bundle.manifest.files.iter().map(|file| file.size).sum::<u64>(),
        "shell bundle manifest computed"
    );
    store_bundle(key, fingerprint, Arc::clone(&bundle));
    Ok(bundle)
}

struct BundleRoot {
    dir: PathBuf,
    prefix: String,
    marker: Option<String>,
}

fn bundle_roots(state: &AppState, dist: &Path) -> Vec<BundleRoot> {
    let mut roots = vec![BundleRoot {
        dir: dist.to_path_buf(),
        prefix: String::new(),
        marker: None,
    }];

    let registry = plugins::registry(&state.config);
    let Some(root) = registry.root() else {
        return roots;
    };
    for plugin in registry.plugins() {
        if !plugin.state.is_served() {
            continue;
        }
        let id = &plugin.manifest.id;
        let version = &plugin.manifest.version;
        if !plugins::is_valid_plugin_id(id) || !plugins::is_valid_version(version) {
            continue;
        }
        roots.push(BundleRoot {
            dir: root.join(id).join(version).join(PLUGIN_ASSET_ROOT),
            prefix: format!("plugins/{id}/{version}/{PLUGIN_ASSET_ROOT}/"),
            marker: Some(format!("{id}@{version}:{}", plugin.state.as_str())),
        });
    }
    roots
}

struct WalkEntry {
    path: String,
    abs: PathBuf,
    size: u64,
    mtime: Option<SystemTime>,
    from_dist: bool,
}

async fn walk(root: &Path, prefix: &str, out: &mut Vec<WalkEntry>) -> AppResult<()> {
    let Ok(canonical_root) = tokio::fs::canonicalize(root).await else {
        return Ok(());
    };
    let mut stack = vec![(canonical_root.clone(), String::new(), 0usize)];

    while let Some((dir, relative, depth)) = stack.pop() {
        if depth > MAX_WALK_DEPTH {
            warn!(dir = %dir.display(), "shell bundle: refusing to walk deeper");
            continue;
        }
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(read_dir) => read_dir,
            Err(err) => {
                warn!(dir = %dir.display(), error = %err, "shell bundle: unreadable directory");
                continue;
            }
        };
        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|err| AppError::Unavailable(format!("reading {}: {err}", dir.display())))?
        {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                warn!(dir = %dir.display(), "shell bundle: skipping a non-UTF-8 file name");
                continue;
            };
            let child = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let file_type = match entry.file_type().await {
                Ok(file_type) => file_type,
                Err(err) => {
                    warn!(path = %child, error = %err, "shell bundle: cannot stat");
                    continue;
                }
            };

            if file_type.is_dir() {
                stack.push((entry.path(), child, depth + 1));
                continue;
            }

            let absolute = if file_type.is_symlink() {
                match tokio::fs::canonicalize(entry.path()).await {
                    Ok(target) if target.starts_with(&canonical_root) => target,
                    Ok(target) => {
                        warn!(path = %child, target = %target.display(),
                              "shell bundle: skipping a symlink out of the root");
                        continue;
                    }
                    Err(err) => {
                        warn!(path = %child, error = %err, "shell bundle: broken symlink");
                        continue;
                    }
                }
            } else {
                entry.path()
            };

            let metadata = match tokio::fs::metadata(&absolute).await {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => continue,
                Err(err) => {
                    warn!(path = %child, error = %err, "shell bundle: cannot stat");
                    continue;
                }
            };

            let path = format!("{prefix}{child}");
            if !is_safe_bundle_path(&path) {
                warn!(path = %path, "shell bundle: skipping an unrepresentable path");
                continue;
            }
            if out.len() >= MAX_BUNDLE_FILES {
                return Err(AppError::Unavailable(format!(
                    "the shell bundle would exceed {MAX_BUNDLE_FILES} files; refusing to \
                     publish a truncated manifest"
                )));
            }
            out.push(WalkEntry {
                path,
                abs: absolute,
                size: metadata.len(),
                mtime: metadata.modified().ok(),
                from_dist: prefix.is_empty(),
            });
        }
    }
    Ok(())
}

async fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((hex::encode(hasher.finalize()), size))
}

pub fn bundle_version(files: &[ShellFile]) -> String {
    let mut ordered: Vec<&ShellFile> = files.iter().collect();
    ordered.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hasher = Sha256::new();
    for file in ordered {
        hasher.update(file.path.as_bytes());
        hasher.update(b"\n");
        hasher.update(file.sha256.as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}

pub fn is_excluded(path: &str) -> bool {
    if EXCLUDED_FILES.contains(&path) || SYNTHESIZED_FILES.contains(&path) {
        return true;
    }
    if path.ends_with(".map") {
        return true;
    }
    path.split('/').any(|segment| segment.starts_with('.'))
}

pub fn is_shadowed_dist_path(path: &str) -> bool {
    if path == "kernel.d.ts" {
        return true;
    }
    let mut segments = path.split('/');
    segments.next() == Some("plugins") && segments.count() >= 3
}

pub fn is_safe_bundle_path(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return false;
    }
    path.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

async fn synthesize(state: &AppState, dist: &Path) -> AppResult<BTreeMap<String, SynthesizedFile>> {
    let path = dist.join("index.html");
    let html = tokio::fs::read_to_string(&path).await.map_err(|err| {
        AppError::Unavailable(format!(
            "the web bundle has no readable index.html at {} ({err}) — run \
             `mise run web-build`",
            path.display()
        ))
    })?;

    let imports = page_imports(state, true);
    let importmap = serde_json::to_vec_pretty(&ImportMap {
        imports: imports.clone(),
    })
    .unwrap_or_else(|_| b"{}".to_vec());

    let nonce = stable_nonce(&html, &importmap);
    let index = render_index_body(&html, &imports, &nonce);

    Ok(BTreeMap::from([
        (
            "index.html".to_string(),
            SynthesizedFile {
                bytes: index.into_bytes(),
                content_type: "text/html; charset=utf-8",
            },
        ),
        (
            "importmap.json".to_string(),
            SynthesizedFile {
                bytes: importmap,
                content_type: "application/json",
            },
        ),
    ]))
}

fn stable_nonce(html: &str, importmap: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ddd-shell-index-nonce\n");
    hasher.update(html.as_bytes());
    hasher.update(b"\n");
    hasher.update(importmap);
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

fn nonce_of(synthesized: &BTreeMap<String, SynthesizedFile>) -> String {
    let Some(file) = synthesized.get("index.html") else {
        return String::new();
    };
    let Ok(html) = std::str::from_utf8(&file.bytes) else {
        return String::new();
    };
    html.split_once("<script type=\"importmap\" nonce=\"")
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(nonce, _)| nonce.to_string())
        .unwrap_or_default()
}

fn shell_csp(nonce: &str, public_url: Option<&str>) -> String {
    let connect = match public_url.and_then(|origin| {
        crate::config::ws_origin(origin).map(|ws| format!("'self' {origin} {ws}"))
    }) {
        Some(narrowed) => narrowed,
        None => "'self' https: http: wss: ws:".to_string(),
    };
    format!(
        "default-src 'self'; script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval'; \
         style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
         media-src 'self' blob:; frame-src 'self' blob:; font-src 'self'; \
         connect-src {connect}; worker-src 'self' blob:; \
         object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
}

#[derive(Debug, Deserialize)]
struct ShellBundleMeta {
    #[serde(rename = "minBridgeVersion")]
    min_bridge_version: u32,
}

async fn min_bridge_version(dist: &Path) -> u32 {
    let path = dist.join(SHELL_BUNDLE_META_FILE);
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return MIN_BRIDGE_VERSION;
    };
    match serde_json::from_str::<ShellBundleMeta>(&raw) {
        Ok(meta) if meta.min_bridge_version >= 1 => meta.min_bridge_version,
        Ok(meta) => {
            warn!(
                path = %path.display(), value = meta.min_bridge_version,
                "shell-bundle.json declares an impossible minBridgeVersion; using the floor"
            );
            MIN_BRIDGE_VERSION
        }
        Err(err) => {
            warn!(path = %path.display(), error = %err, "shell-bundle.json is invalid");
            MIN_BRIDGE_VERSION
        }
    }
}

struct CacheEntry {
    fingerprint: String,
    bundle: Arc<Bundle>,
}

static BUNDLES: OnceLock<RwLock<BTreeMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static RwLock<BTreeMap<String, CacheEntry>> {
    BUNDLES.get_or_init(|| RwLock::new(BTreeMap::new()))
}

fn cache_key(dist: &Path, state: &AppState) -> String {
    format!(
        "{}|{}|{}",
        dist.display(),
        state.config.plugins_dir.display(),
        state.config.disable_plugins
    )
}

fn cached_bundle(key: &str, fingerprint: &str) -> Option<Arc<Bundle>> {
    let guard = cache().read().expect("shell bundle cache lock poisoned");
    let entry = guard.get(key)?;
    (entry.fingerprint == fingerprint).then(|| Arc::clone(&entry.bundle))
}

fn store_bundle(key: String, fingerprint: String, bundle: Arc<Bundle>) {
    let mut guard = cache().write().expect("shell bundle cache lock poisoned");
    guard.insert(
        key,
        CacheEntry {
            fingerprint,
            bundle,
        },
    );
}

fn fingerprint(entries: &[WalkEntry], roots: &[BundleRoot]) -> String {
    let mut hasher = Sha256::new();
    for root in roots {
        if let Some(marker) = &root.marker {
            hasher.update(b"plugin\0");
            hasher.update(marker.as_bytes());
            hasher.update(b"\n");
        }
    }
    for entry in entries {
        let mtime = entry
            .mtime
            .and_then(|mtime| mtime.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        hasher.update(entry.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(entry.size.to_le_bytes());
        hasher.update(mtime.to_le_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::statics::IMPORT_MAP_MARKER;

    fn file(path: &str, sha: &str) -> ShellFile {
        ShellFile {
            path: path.to_string(),
            sha256: sha.to_string(),
            size: 1,
        }
    }

    #[test]
    fn the_version_is_the_content_and_nothing_else() {
        let a = file("index.html", "aa");
        let b = file("assets/app.js", "bb");

        assert_eq!(
            bundle_version(&[a.clone(), b.clone()]),
            bundle_version(&[b.clone(), a.clone()])
        );
        let resized = ShellFile {
            size: 999,
            ..a.clone()
        };
        assert_eq!(
            bundle_version(&[a.clone(), b.clone()]),
            bundle_version(&[resized, b.clone()])
        );
        assert_ne!(
            bundle_version(&[a.clone(), b.clone()]),
            bundle_version(&[a.clone(), file("assets/app.js", "cc")])
        );
        assert_ne!(
            bundle_version(&[a.clone(), b.clone()]),
            bundle_version(&[a.clone(), file("assets/app2.js", "bb")])
        );
        assert_ne!(bundle_version(&[a.clone(), b]), bundle_version(&[a]));
        let version = bundle_version(&[file("x", "y")]);
        assert_eq!(version.len(), 64);
        assert!(version.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn an_empty_listing_still_hashes() {
        assert_eq!(bundle_version(&[]).len(), 64);
    }

    #[test]
    fn the_exclusions_are_the_documented_ones() {
        assert!(is_excluded("sw.js"));
        assert!(is_excluded("sw.js.map"));
        assert!(is_excluded("index.html"));
        assert!(is_excluded("importmap.json"));
        assert!(is_excluded("shell-bundle.json"));
        assert!(is_excluded("assets/index-PoVlm7Xk.js.map"));
        assert!(is_excluded("runtime/shared/dist-DwqjNsYs.js.map"));
        assert!(is_excluded("plugins/shell-ui/1.0.0/frontend/index.mjs.map"));
        assert!(is_excluded(".vite/manifest.json"));
        assert!(is_excluded("assets/.DS_Store"));

        for kept in [
            "assets/index-PoVlm7Xk.js",
            "assets/index-CMwrM_cN.css",
            "assets/ddd_core_bg-S03RaG2A.wasm",
            "assets/search-worker-CuM4H6I-.js",
            "runtime/kernel-BdFAWC4t.js",
            "runtime/shared/yjs-CLkt2p0d.js",
            "runtime-manifest.json",
            "manifest.webmanifest",
            "icon.svg",
            "plugins/shell-ui/1.0.0/frontend/index.mjs",
            "plugins/shell-ui/1.0.0/frontend/style.css",
        ] {
            assert!(!is_excluded(kept), "{kept} must be in the bundle");
        }
        assert!(!is_excluded("runtime/sourcemap-helper.js"));
    }

    #[test]
    fn a_dist_file_another_route_claims_is_not_published() {
        assert!(is_shadowed_dist_path("kernel.d.ts"));
        assert!(is_shadowed_dist_path(
            "plugins/shell-ui/1.0.0/frontend/x.mjs"
        ));
        assert!(is_shadowed_dist_path("plugins/a/b/c"));

        assert!(!is_shadowed_dist_path("plugins/foo.js"));
        assert!(!is_shadowed_dist_path("plugins/a/b"));
        assert!(!is_shadowed_dist_path("plugins"));
        for kept in [
            "assets/index-PoVlm7Xk.js",
            "runtime/kernel-BdFAWC4t.js",
            "runtime-manifest.json",
            "index.html",
            "kernel.d.ts.map",
            "assets/kernel.d.ts",
        ] {
            assert!(!is_shadowed_dist_path(kept), "{kept} must stay");
        }
    }

    #[test]
    fn unrepresentable_paths_never_reach_a_manifest() {
        assert!(is_safe_bundle_path("index.html"));
        assert!(is_safe_bundle_path(
            "plugins/shell-ui/1.0.0/frontend/index.mjs"
        ));
        assert!(!is_safe_bundle_path(""));
        assert!(!is_safe_bundle_path("/etc/passwd"));
        assert!(!is_safe_bundle_path("../secret"));
        assert!(!is_safe_bundle_path("a/../b"));
        assert!(!is_safe_bundle_path("a/./b"));
        assert!(!is_safe_bundle_path("a//b"));
        assert!(!is_safe_bundle_path("a\\b"));
        assert!(!is_safe_bundle_path("a\0b"));
    }

    #[test]
    fn the_nonce_is_a_function_of_the_bytes_it_authorises() {
        let html = format!("<head>{IMPORT_MAP_MARKER}</head>");
        let map = br#"{"imports":{}}"#;

        let a = stable_nonce(&html, map);
        assert_eq!(a, stable_nonce(&html, map), "same inputs, same nonce");
        assert_ne!(a, stable_nonce("<head>other</head>", map));
        assert_ne!(a, stable_nonce(&html, br#"{"imports":{"react":"/r.js"}}"#));
        assert!(a.len() >= 20, "too short to be a nonce: {a}");
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "not a legal CSP nonce: {a}"
        );
    }

    #[test]
    fn the_document_and_the_policy_carry_one_nonce() {
        let imports = BTreeMap::from([("react".to_string(), "/runtime/react-abc.js".to_string())]);
        let map = serde_json::to_vec_pretty(&ImportMap {
            imports: imports.clone(),
        })
        .expect("the import map serializes");
        let html = format!("<head>{IMPORT_MAP_MARKER}</head>");
        let nonce = stable_nonce(&html, &map);
        let body = render_index_body(&html, &imports, &nonce);

        assert!(!body.contains(IMPORT_MAP_MARKER), "the marker survived");
        assert!(body.contains(&format!("nonce=\"{nonce}\"")));
        assert!(body.contains("\"react\":\"/runtime/react-abc.js\""));

        let synthesized = BTreeMap::from([(
            "index.html".to_string(),
            SynthesizedFile {
                bytes: body.into_bytes(),
                content_type: "text/html; charset=utf-8",
            },
        )]);
        assert_eq!(nonce_of(&synthesized), nonce);
        assert!(shell_csp(&nonce_of(&synthesized), None).contains(&format!("'nonce-{nonce}'")));
    }

    #[test]
    fn a_template_without_the_marker_publishes_no_nonce_rather_than_a_dangling_one() {
        let synthesized = BTreeMap::from([(
            "index.html".to_string(),
            SynthesizedFile {
                bytes: render_index_body("<head></head>", &BTreeMap::new(), "N").into_bytes(),
                content_type: "text/html; charset=utf-8",
            },
        )]);
        assert_eq!(nonce_of(&synthesized), "");
    }

    #[test]
    fn the_shell_policy_is_the_browser_policy_plus_the_cross_origin_api() {
        let csp = shell_csp("N", None);
        for directive in [
            "default-src 'self'",
            "script-src 'self' 'nonce-N' 'wasm-unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "frame-src 'self' blob:",
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        ] {
            assert!(csp.contains(directive), "policy lost `{directive}`:\n{csp}");
        }
        assert!(csp.contains("connect-src 'self' https: http: wss: ws:"));

        let script_src = csp
            .split("; ")
            .find(|directive| directive.starts_with("script-src "))
            .expect("script-src is present");
        assert_eq!(script_src, "script-src 'self' 'nonce-N' 'wasm-unsafe-eval'");
    }

    #[test]
    fn a_configured_public_url_narrows_connect_src_to_that_origin() {
        let csp = shell_csp("N", Some("https://notes.example.com"));
        let connect = csp
            .split("; ")
            .find(|directive| directive.starts_with("connect-src "))
            .expect("connect-src is present");

        assert_eq!(
            connect,
            "connect-src 'self' https://notes.example.com wss://notes.example.com"
        );
        for scheme in ["https:", "http:", "wss:", "ws:"] {
            assert!(
                !connect.split(' ').any(|source| source == scheme),
                "the bare `{scheme}` scheme source survived the narrowing:\n{connect}"
            );
        }
        assert!(
            shell_csp("N", Some("http://192.168.1.10:8080"))
                .contains("connect-src 'self' http://192.168.1.10:8080 ws://192.168.1.10:8080;")
        );
        assert!(csp.contains("media-src 'self' blob:"));
        assert!(csp.contains("script-src 'self' 'nonce-N' 'wasm-unsafe-eval'"));
    }

    #[test]
    fn the_synthesized_set_is_the_declared_one() {
        assert_eq!(SYNTHESIZED_FILES, &["index.html", "importmap.json"]);
    }
}
