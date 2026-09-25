//! `GET /api/shell/manifest` — the bundle manifest the Flutter shell updates from
//! (SPEC §7: "the server publishes a bundle manifest with per-file SHA-256; the shell
//! verifies before swapping").
//!
//! This is the third leg of "keep clients in step" (SPEC §2). The browser gets the
//! bundle from [`statics`](super::statics) one request at a time and lets the service
//! worker decide what to keep; the shell has to download a *set* of files, verify every
//! one, and swap atomically — so it needs the set enumerated up front, with hashes, and
//! one identifier for the whole thing.
//!
//! **The contract is in `app/BRIDGE.md` §5 and it is frozen.** Read it before changing
//! anything here; the shell's updater and its auto-revert state machine are written
//! against these exact field names.
//!
//! ```json
//! {
//!   "bundle_version": "b1f3…",          // content hash of everything below
//!   "min_bridge_version": 1,            // the bundle refuses to run on an older shell
//!   "index_csp": "default-src 'self'; …",
//!   "files": [ { "path": "index.html", "sha256": "…", "size": 4711 }, … ]
//! }
//! ```
//!
//! Four decisions that are easy to get wrong, and why they are what they are.
//!
//! **`bundle_version` is derived, never stored.** It is the hash of the sorted
//! `(path, sha256)` list (see [`bundle_version`]), so it changes when — and only when —
//! the bytes the shell would download change. A plugin install, a plugin *removal* and a
//! redeploy of the PWA all move it; a server restart does not. Nothing has to remember
//! to bump a number, and two servers serving the same content compute the same id.
//!
//! **Plugin files are part of the bundle.** SPEC §7's shell boots offline, and an
//! offline boot that has the kernel but not `shell-ui` renders nothing. So the manifest
//! spans `WEB_DIST_DIR` *and* every served plugin's `frontend/**`, at exactly the paths
//! the loopback origin has to answer (`plugins/{id}/{version}/frontend/…`) — which are
//! the same paths the public routes use, so the shell fetches each file from its own URL
//! and needs no new download endpoint.
//!
//! **`index.html` and `importmap.json` are synthesized, not copied.** The browser's
//! `index.html` is rendered per response with a fresh CSP nonce and `no-store`
//! ([`statics::index_html`](super::statics)) — bytes that are deliberately different
//! every time cannot be hashed into a manifest. The shell therefore fetches those two
//! through [`bundle_file`] instead, which renders them once per bundle version: the
//! import map inlined with a *stable* nonce, and `index_csp` carrying the matching
//! policy for the shell's local server to send as a header. A baked nonce is safe here
//! and not in the browser, because these bytes are served by the device's own loopback
//! server to its own webview — there is no cache and no intermediary to replay them to.
//!
//! **Authenticated, like `GET /api/plugins`.** The manifest names every installed plugin
//! and version, which is the information that route is authenticated to protect. The
//! shell logs in natively before it ever updates (SPEC §5.2: bearer token), so it always
//! has one; the *files* stay public, because `import()` cannot send an `Authorization`
//! header (see `statics::PLUGIN_ASSET_ROOT`).
//!
//! # How the endpoint is built, and the three costs it avoids
//!
//! One pass, three stages, in [`build_bundle`]:
//!
//! 1. **walk** both roots collecting `(path, size, mtime)` — `stat` only, no reads;
//! 2. **fingerprint** that listing plus the served plugin set, and return the cached
//!    bundle when it is unchanged. A shell polls the manifest on every foreground, and
//!    re-hashing tens of megabytes each time is a second of CPU nobody asked for;
//! 3. **hash** every surviving file by streaming it (64 KiB at a time — [`hash_file`]),
//!    render the two synthesized files, sort, and derive [`bundle_version`].
//!
//! The fingerprint deliberately covers files the manifest then *excludes*
//! ([`is_excluded`]), so editing `shell-bundle.json` — which only ever changes
//! `min_bridge_version` — still invalidates the cache. It also covers each served
//! plugin's `(id, version, state)`, because disabling a plugin through the admin screen
//! changes what the bundle contains without touching a single file on disk.
//!
//! # What is deliberately not in the bundle
//!
//! Beyond [`EXCLUDED_FILES`] and [`SYNTHESIZED_FILES`], two rules in [`is_excluded`]:
//!
//! * **source maps.** They are 77 % of the built distribution (4.1 MB of 5.4 MB at the
//!   time of writing) and no page ever fetches one — only an attached devtools does,
//!   which on a phone is not the debugging story anyway. Shipping them would treble the
//!   OTA download and the on-device footprint (the shell keeps the previous bundle too,
//!   SPEC §7) to make a tool nobody runs there marginally nicer. Debug against the
//!   browser build, where the maps are served.
//! * **dot-directories.** `.vite/manifest.json` is build metadata, not a runtime asset.
//!
//! Both are announced in this area's report, because they are a judgement about what
//! "everything the shell must mirror" means rather than something `BRIDGE.md` settles.
//!
//! A third rule is not a judgement at all but a correctness guard:
//! [`is_shadowed_dist_path`] drops files under `WEB_DIST_DIR` whose *URL* belongs to a
//! dedicated route, so the bytes a shell would download are not the bytes that were
//! hashed. Publishing one would abort every update forever — see that function.

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

use super::statics::{ImportMap, render_index_body, runtime_imports};

/// The bridge version this server's bundle requires of a shell, when the bundle does not
/// say (SPEC §7: "the bundle declares a minimum bridge version").
///
/// The authority is the bundle, not the server: `MIN_BRIDGE_VERSION` moves when the
/// *web* code starts calling a bridge method an older shell does not have. So the build
/// writes it into [`SHELL_BUNDLE_META_FILE`] next to `index.html`, and this constant is
/// the floor used when that file is absent (a bundle built before M5).
pub const MIN_BRIDGE_VERSION: u32 = 1;

/// `shell-bundle.json`, written into `WEB_DIST_DIR` by the web build: `{ "minBridgeVersion": 1 }`.
pub const SHELL_BUNDLE_META_FILE: &str = "shell-bundle.json";

/// Paths the manifest lists but no static route can serve byte-stably; the shell fetches
/// them from `/api/shell/bundle/{path}` instead. See the module docs.
pub const SYNTHESIZED_FILES: &[&str] = &["index.html", "importmap.json"];

/// Files under `WEB_DIST_DIR` that never belong in a shell bundle.
///
/// `sw.js` is the interesting one: the shell's origin is a loopback HTTP server that
/// already *is* the offline cache, and a service worker that installed itself there
/// would fight the bundle updater for control of what the webview sees — two caches,
/// two update stories, one of them invisible to the revert path. The shell boots the
/// bundle it verified and nothing else.
pub const EXCLUDED_FILES: &[&str] = &["sw.js", "sw.js.map", SHELL_BUNDLE_META_FILE];

/// The one directory of a plugin package that is part of a bundle — the same directory
/// the public asset route serves, for the same reason (`statics::PLUGIN_ASSET_ROOT`:
/// `manifest.json` is what `GET /api/plugins` is authenticated to protect and
/// `backend.wasm` is server-side code).
const PLUGIN_ASSET_ROOT: &str = "frontend";

/// A built distribution has a few dozen files and a plugin a handful. Ten thousand is
/// "something is very wrong" — a directory that grew a log, or a symlink loop the
/// per-entry check somehow let through — and a *truncated* manifest is the one failure
/// mode worth refusing outright: the shell would verify every file it was told about,
/// swap, and boot a bundle missing a module.
const MAX_BUNDLE_FILES: usize = 10_000;

/// Depth backstop for the same reason. `runtime/shared/…` is the deepest real path.
const MAX_WALK_DEPTH: usize = 24;

/// `X-Content-Type-Options`, spelled once (as in `statics.rs`).
const NOSNIFF: HeaderName = HeaderName::from_static("x-content-type-options");

/// One file in the bundle. `path` is relative to the bundle root and is exactly the URL
/// path the shell's local server must answer (and the one it fetches from this server).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellFile {
    pub path: String,
    /// Lowercase hex SHA-256 of the bytes.
    pub sha256: String,
    pub size: u64,
}

/// `GET /api/shell/manifest`. **Frozen** (`app/BRIDGE.md` §5): field names and casing are
/// the shell updater's parse target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellManifest {
    /// Content hash of the whole set — the shell's "do I already have this?" key and the
    /// name of its on-disk bundle directory.
    pub bundle_version: String,
    /// The shell refuses to install a bundle whose `min_bridge_version` exceeds the
    /// bridge it implements, and shows the "update the app" screen instead.
    pub min_bridge_version: u32,
    /// The `Content-Security-Policy` the shell's local server must send with
    /// `index.html`; its nonce matches the inline import map in the served bytes.
    pub index_csp: String,
    /// Sorted by `path`, so the hash and the wire order are stable.
    pub files: Vec<ShellFile>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/manifest", get(manifest))
        .route("/bundle/{*path}", get(bundle_file))
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/// `GET /api/shell/manifest` — enumerate, hash and identify the current bundle.
///
/// `no-store`: the manifest is the shell's freshness check, so a cached one is an update
/// the device never learns about. (The *files* it names are content-addressed and may be
/// cached by anything; this document is the thing that must not be.)
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

/// `GET /api/shell/bundle/{path}` — the byte-stable rendering of a synthesized file.
///
/// Only the paths in [`SYNTHESIZED_FILES`] are served (anything else is a 404: every
/// other file already has a public URL, and a second copy of that route is a second
/// traversal check to get wrong). The bytes must hash to what [`manifest`] published for
/// the same bundle version, so the nonce and the import map are derived from the bundle
/// content, never from the request — and both handlers read them out of the *same*
/// [`Bundle`], so "the manifest said X and the download was Y" is not expressible.
///
/// `Content-Disposition: attachment` is not about the shell, which reads bytes with an
/// HTTP client and ignores it. It is about a browser: this route answers with the app's
/// own HTML and attaches no CSP (the loopback server attaches `index_csp` instead), so a
/// cookie-authenticated navigation here would render a scriptable same-origin document
/// outside the policy every real document gets. `statics.rs` refuses inline HTML from the
/// asset routes for exactly that reason; this is the same rule.
pub async fn bundle_file(
    State(state): State<AppState>,
    _user: AuthUser,
    AxumPath(path): AxumPath<String>,
) -> Response {
    // Checked against the allowlist *before* anything is built: an unknown path must not
    // be able to cost a caller a full walk of the distribution.
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

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/// Everything one bundle version is: the published manifest and the bytes of the files
/// that have no static URL.
///
/// One value rather than two computations, because the manifest's hash for `index.html`
/// and the bytes [`bundle_file`] hands over have to be the same rendering or the shell
/// aborts the download it just verified.
pub struct Bundle {
    pub manifest: ShellManifest,
    synthesized: BTreeMap<String, SynthesizedFile>,
}

struct SynthesizedFile {
    bytes: Vec<u8>,
    content_type: &'static str,
}

/// The current bundle, from the cache when the roots have not changed.
async fn build_bundle(state: &AppState) -> AppResult<Arc<Bundle>> {
    let Some(dist) = state.config.web_dist_dir.clone() else {
        // A 503 rather than an empty manifest: `files` is non-empty by contract and must
        // contain `index.html` (`app/bundle/manifest.dart`), so there is no honest empty
        // answer. The message reaches the operator through the log line `AppError` writes
        // for every 5xx.
        return Err(AppError::Unavailable(
            "this server serves no web bundle (WEB_DIST_DIR is not set), so there is \
             nothing for a shell to mirror"
                .to_string(),
        ));
    };

    let roots = bundle_roots(state, &dist);
    let key = cache_key(&dist, state);

    // Stage 1: stat everything. This is the per-request cost, and it is the cheap one.
    let mut entries = Vec::new();
    for root in &roots {
        walk(&root.dir, &root.prefix, &mut entries).await?;
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    // Stage 2: has anything moved? The fingerprint covers excluded files too — editing
    // `shell-bundle.json` changes only `min_bridge_version`, and a cache that could not
    // see that would publish a stale one.
    let fingerprint = fingerprint(&entries, &roots);
    if let Some(cached) = cached_bundle(&key, &fingerprint) {
        return Ok(cached);
    }

    // Stage 3: hash what survives the exclusions, by streaming.
    let mut files = Vec::with_capacity(entries.len());
    for entry in &entries {
        if is_excluded(&entry.path) {
            continue;
        }
        if entry.from_dist && is_shadowed_dist_path(&entry.path) {
            // Loud, because it is a build that put a file where the app can never fetch
            // it from: the operator sees a log line instead of a device that silently
            // refuses every update.
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

    // Sorted by path, so the hash input and the wire order are one canonical listing.
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

/// One directory to walk, and the bundle-path prefix its files get.
struct BundleRoot {
    dir: PathBuf,
    prefix: String,
    /// `(id, version, state)` for a plugin root — part of the fingerprint, so an admin
    /// disabling a plugin invalidates the cache without any file changing.
    marker: Option<String>,
}

/// `WEB_DIST_DIR`, then every *served* plugin's `frontend/` directory.
fn bundle_roots(state: &AppState, dist: &Path) -> Vec<BundleRoot> {
    let mut roots = vec![BundleRoot {
        dir: dist.to_path_buf(),
        prefix: String::new(),
        marker: None,
    }];

    // `DISABLE_PLUGINS=1` returns an empty registry (the server-side half of safe mode,
    // SPEC §6.1), so a shell updating against such a server gets a kernel-only bundle —
    // which is exactly what that server serves a browser.
    let registry = plugins::registry(&state.config);
    let Some(root) = registry.root() else {
        return roots;
    };
    for plugin in registry.plugins() {
        // The same gate as the asset route: a `pending` package is not served to a
        // browser and must not reach a device either (SPEC §6.1's trust model — the
        // frontend half runs unsandboxed).
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

/// One file found by the walk: where it is, and what it is called in the bundle.
struct WalkEntry {
    path: String,
    abs: PathBuf,
    size: u64,
    mtime: Option<SystemTime>,
    /// `true` for `WEB_DIST_DIR`, `false` for a plugin root. Only the former can collide
    /// with another route's URL space ([`is_shadowed_dist_path`]).
    from_dist: bool,
}

/// Collect every regular file under `root`, naming it `prefix + relative path`.
///
/// A missing root is not an error: a plugin whose `frontend/` directory does not exist is
/// a backend-only plugin (SPEC §6.2 makes both halves optional), and the shell simply has
/// nothing to mirror for it.
///
/// Symlinks are resolved and re-checked against the canonical root, which is what
/// `statics::resolve_within` does at serve time — so the manifest lists exactly the files
/// the shell can actually fetch. A symlinked *directory* is never descended into: the
/// walk would loop, and a loop here is a manifest that never finishes.
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
                // A non-UTF-8 name has no spelling on the wire, and the shell's
                // `isSafeBundlePath` would refuse it.
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

            // Follow a symlink, then insist it landed inside the root — the lexical half
            // of the check cannot see a link, which is the whole reason `statics.rs`
            // canonicalizes too (SPEC §6.2 rejects escaping symlinks at install time as
            // well; this is the serving-side half).
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
                // A symlink to a directory, a socket, a fifo: not bundle content.
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

/// SHA-256 of a file, streamed. Returns the digest and the number of bytes hashed.
///
/// The size comes from the bytes read, never from `metadata`: those two can disagree for
/// a file being rewritten, and the shell compares the size of what it downloaded against
/// this number before it even hashes (`verifyBytes` in `app/lib/bundle/manifest.dart`).
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

/// The bundle id: `sha256` over `"<path>\n<sha256>\n"` for every file, in `path` order.
///
/// Spelled out as its own function because the shell does not recompute it — it trusts
/// the field — so the *only* thing that keeps "same bytes ⇒ same version" true is that
/// this input is canonical. Sorted, newline-delimited, no lengths, no timestamps, no
/// server identity.
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

// ---------------------------------------------------------------------------
// Exclusions and path safety
// ---------------------------------------------------------------------------

/// `true` when a walked path must not appear in the manifest. See the module docs for
/// the two rules that are not a name in [`EXCLUDED_FILES`].
pub fn is_excluded(path: &str) -> bool {
    if EXCLUDED_FILES.contains(&path) || SYNTHESIZED_FILES.contains(&path) {
        return true;
    }
    // Source maps: 77 % of the bytes, fetched only by devtools. Matched by extension
    // rather than by name so `runtime/shared/dist-DwqjNsYs.js.map` is covered too.
    if path.ends_with(".map") {
        return true;
    }
    // Build metadata (`.vite/manifest.json`) and editor/OS droppings.
    path.split('/').any(|segment| segment.starts_with('.'))
}

/// `true` when a file under `WEB_DIST_DIR` has a URL some *other* route already answers,
/// so what the shell would download is not what was hashed here.
///
/// This is not a taste judgement like the source-map rule; it is the one exclusion whose
/// absence breaks the milestone. The updater fetches every non-synthesized path from
/// `{serverBaseUrl}/{path}` and aborts the **whole** bundle on a single mismatch
/// (`app/BRIDGE.md` §5) — so one shadowed file means every device fails every update,
/// forever, over bytes nothing needs.
///
/// Two names, both reachable by putting a file in `web/app/public/`:
///
/// * `kernel.d.ts` — `statics::kernel_dts` answers that URL from `KERNEL_DTS_PATH`, which
///   is a different file whenever it is configured at all. It is also a type declaration:
///   no webview ever loads one, so dropping it costs the bundle nothing.
/// * `plugins/{id}/{version}/…` — `statics::plugin_asset` answers those URLs out of
///   `PLUGINS_DIR`. Note the arity: that route needs an id, a version *and* a tail, so
///   `plugins/foo.js` is served from the distribution as normal and stays in the bundle.
///
/// Plugin roots are exempt because they cannot collide — every file they contribute is
/// under `plugins/{id}/{version}/frontend/`, which is precisely the route that serves it.
pub fn is_shadowed_dist_path(path: &str) -> bool {
    if path == "kernel.d.ts" {
        return true;
    }
    let mut segments = path.split('/');
    segments.next() == Some("plugins") && segments.count() >= 3
}

/// `true` when `path` is something the shell can write under its bundle directory and
/// answer as a URL.
///
/// The mirror of `isSafeBundlePath` in `app/lib/bundle/manifest.dart`: relative,
/// traversal-free, no empty segments, no backslashes, no NUL. Applied *here* as well as
/// there so a file the updater would reject never reaches a manifest in the first place
/// — a rejected entry aborts the whole bundle, so publishing one would break every
/// update rather than skip one file.
pub fn is_safe_bundle_path(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return false;
    }
    path.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

// ---------------------------------------------------------------------------
// The synthesized files
// ---------------------------------------------------------------------------

/// Render `index.html` and `importmap.json` for this bundle.
async fn synthesize(state: &AppState, dist: &Path) -> AppResult<BTreeMap<String, SynthesizedFile>> {
    let path = dist.join("index.html");
    let html = tokio::fs::read_to_string(&path).await.map_err(|err| {
        AppError::Unavailable(format!(
            "the web bundle has no readable index.html at {} ({err}) — run \
             `mise run web-build`",
            path.display()
        ))
    })?;

    // The same map `/importmap.json` serves, rendered the same way (pretty, `imports`
    // only), because the shell's webview loads the same modules the browser does.
    let imports = runtime_imports(state);
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

/// The nonce baked into the bundle's `index.html`, derived from the bytes it authorises.
///
/// **Stable, therefore predictable, therefore only ever for these bytes.** It is a hash
/// of the template and the import map — both public content — so anybody can compute it.
/// That is harmless for a document assembled from two static inputs with nothing
/// request-derived in it, served by the device's own loopback server to its own webview
/// (`app/BRIDGE.md` §5). It would *not* be harmless for the browser-facing document,
/// which is why `statics.rs` keeps 128 random bits per response and this function is not
/// exported.
///
/// Deriving it from the content rather than from `bundle_version` is also what keeps the
/// version computable at all: `index.html`'s own hash is an input to `bundle_version`, so
/// a nonce that depended on the version would be a cycle.
fn stable_nonce(html: &str, importmap: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"lm-shell-index-nonce\n");
    hasher.update(html.as_bytes());
    hasher.update(b"\n");
    hasher.update(importmap);
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

/// The nonce actually present in a rendered bundle, read back out of the bytes.
///
/// Read back rather than passed alongside, so `index_csp` and the document cannot
/// disagree: if the marker was missing and no script was inserted, there is no nonce to
/// publish either.
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

/// The policy the shell's loopback server sends with `index.html`.
///
/// SPEC §8's policy, as `statics.rs` renders it, with **one** difference, whose width
/// now depends on whether the operator has told the server its own address.
///
/// The difference is the loopback origin (`app/BRIDGE.md` §6). In the shell the page is
/// served from `http://127.0.0.1:41847` and *every* API call and the sync socket are
/// cross-origin; with `connect-src 'self'` the app logs in natively and then cannot reach
/// the server at all. So `connect-src` has to name the server — and for a long time it
/// could not, because the server does not know its own URL: it is TLS-unaware, a device
/// reaches it by whatever host, port and scheme its operator configured (a tunnel, a LAN
/// address, `10.0.2.2` on an emulator), and `APP_ORIGIN` lists the *clients* it accepts,
/// not the URL it is reached at. The fallback was scheme sources — `https: http: wss: ws:`,
/// no host restriction at all.
///
/// [`Config::public_url`] is the missing fact, and when it is set this narrows to it:
/// `connect-src 'self' https://notes.example.com wss://notes.example.com`. Both spellings
/// of the host, because a CSP source matches scheme-and-all and `/api/sync` is a `wss://`
/// URL ([`Config::public_ws_origin`]). Unset keeps the old behaviour exactly — this is a
/// tightening an operator opts into by answering the question, never a new way for a
/// working deployment to break after an upgrade.
///
/// Everything that actually contains the blast radius was never the loose part and is
/// unchanged either way: `script-src` is `'self'` plus one nonce, `object-src 'none'`,
/// `base-uri 'none'`, `frame-ancestors 'none'`.
///
/// `media-src 'self' blob:` is the same addition `statics.rs` makes and needs no widening
/// on either branch: an attachment is never played from its server URL. The client fetches
/// the bytes (that is `connect-src`) and renders them from an object URL, exactly as
/// `img-src`'s long-standing `blob:` exists for. See `statics::render_index`.
///
/// The markup itself is [`render_index_body`], shared with the browser page — only the
/// policy differs, and only in `connect-src`.
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
         media-src 'self' blob:; font-src 'self'; \
         connect-src {connect}; worker-src 'self' blob:; \
         object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
}

/// `shell-bundle.json` as the web build writes it.
#[derive(Debug, Deserialize)]
struct ShellBundleMeta {
    #[serde(rename = "minBridgeVersion")]
    min_bridge_version: u32,
}

/// `min_bridge_version` from the bundle, falling back to [`MIN_BRIDGE_VERSION`].
///
/// The bundle is the authority (`app/BRIDGE.md` §8): the number moves when the *web* code
/// starts requiring a bridge method instead of preferring one, which is a fact about the
/// built JavaScript, not about this binary. A missing file is a bundle built before M5 and
/// means "1"; a malformed one is logged and treated the same way, because refusing to
/// publish a manifest over it would take every shell offline for a typo in one field.
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

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

struct CacheEntry {
    fingerprint: String,
    bundle: Arc<Bundle>,
}

/// Keyed by the roots it was computed from, for the reason `plugins::REGISTRY` is: a
/// single cached bundle made the first `WEB_DIST_DIR` any caller asked about the answer
/// for every later one — invisible in a server process, which has one config, and fatal
/// in a test binary where every case points at its own fixture.
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

/// A hash of everything that could change the bundle without a re-hash noticing.
///
/// Every walked file's `(path, size, mtime)` — **including the ones the manifest
/// excludes**, so a `shell-bundle.json` edit invalidates the cache — plus each served
/// plugin's `(id, version, state)`, because an admin disabling a plugin changes the
/// bundle with no file touched.
///
/// Deliberately *not* the bundle version: this is a cheap "did anything move" key, and
/// the expensive content hash is what it is there to avoid recomputing.
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

        // Order-independent: the listing is canonicalised before it is hashed, so two
        // servers that walked their directories in a different order agree.
        assert_eq!(
            bundle_version(&[a.clone(), b.clone()]),
            bundle_version(&[b.clone(), a.clone()])
        );
        // Sizes are not in the input — a hash collision with a different length is not a
        // threat model, and leaving them out keeps the canonical form minimal.
        let resized = ShellFile {
            size: 999,
            ..a.clone()
        };
        assert_eq!(
            bundle_version(&[a.clone(), b.clone()]),
            bundle_version(&[resized, b.clone()])
        );
        // Content moves it.
        assert_ne!(
            bundle_version(&[a.clone(), b.clone()]),
            bundle_version(&[a.clone(), file("assets/app.js", "cc")])
        );
        // A *rename* moves it too: the path is part of what the shell has to mirror.
        assert_ne!(
            bundle_version(&[a.clone(), b.clone()]),
            bundle_version(&[a.clone(), file("assets/app2.js", "bb")])
        );
        // And so does a removal — the case a "hash of the files we added" would miss.
        assert_ne!(bundle_version(&[a.clone(), b]), bundle_version(&[a]));
        // Hex sha256.
        let version = bundle_version(&[file("x", "y")]);
        assert_eq!(version.len(), 64);
        assert!(version.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn an_empty_listing_still_hashes() {
        // Not a reachable state through `build_bundle` (a bundle with no `index.html` is
        // a 503), but a total function is one less panic to reason about.
        assert_eq!(bundle_version(&[]).len(), 64);
    }

    #[test]
    fn the_exclusions_are_the_documented_ones() {
        // The service worker: the loopback origin already *is* the offline cache, and a
        // second one would fight the updater for control of what the webview sees.
        assert!(is_excluded("sw.js"));
        assert!(is_excluded("sw.js.map"));
        // Rendered per bundle version instead, from `/api/shell/bundle/{path}`.
        assert!(is_excluded("index.html"));
        assert!(is_excluded("importmap.json"));
        // Read by this endpoint, not by the page.
        assert!(is_excluded("shell-bundle.json"));
        // Source maps anywhere in the tree — 77 % of the bytes, devtools only.
        assert!(is_excluded("assets/index-PoVlm7Xk.js.map"));
        assert!(is_excluded("runtime/shared/dist-DwqjNsYs.js.map"));
        assert!(is_excluded("plugins/shell-ui/1.0.0/frontend/index.mjs.map"));
        // Build metadata and droppings.
        assert!(is_excluded(".vite/manifest.json"));
        assert!(is_excluded("assets/.DS_Store"));

        // Everything the webview actually loads stays.
        for kept in [
            "assets/index-PoVlm7Xk.js",
            "assets/index-CMwrM_cN.css",
            "assets/life_manager_core_bg-S03RaG2A.wasm",
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
        // A file that merely *mentions* a map is not one.
        assert!(!is_excluded("runtime/sourcemap-helper.js"));
    }

    #[test]
    fn a_dist_file_another_route_claims_is_not_published() {
        // The failure this prevents is not "one file is missing": the updater aborts the
        // whole bundle on one mismatch, so a shadowed file breaks *every* update.
        assert!(is_shadowed_dist_path("kernel.d.ts"));
        assert!(is_shadowed_dist_path(
            "plugins/shell-ui/1.0.0/frontend/x.mjs"
        ));
        assert!(is_shadowed_dist_path("plugins/a/b/c"));

        // The plugin route needs id + version + tail; two segments fall through to the
        // distribution, so a `plugins/` file that is genuinely ours stays in the bundle.
        assert!(!is_shadowed_dist_path("plugins/foo.js"));
        assert!(!is_shadowed_dist_path("plugins/a/b"));
        assert!(!is_shadowed_dist_path("plugins"));
        // Nothing the build actually emits is affected.
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
        // The mirror of `isSafeBundlePath` in `app/lib/bundle/manifest.dart`: a path it
        // rejects aborts the *whole* bundle, so publishing one breaks every update.
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
        // Either input moving moves it — and both are inputs to `bundle_version` too, so
        // a changed nonce always comes with a changed version.
        assert_ne!(a, stable_nonce("<head>other</head>", map));
        assert_ne!(a, stable_nonce(&html, br#"{"imports":{"react":"/r.js"}}"#));
        // CSP `base64-value`: alphanumerics plus `-`/`_` from base64url.
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

        // `nonce_of` reads the nonce back out of the rendered bytes, so the published
        // policy cannot name one the document does not carry.
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
        // Degraded, not fatal — the one `render_index_body` makes for both pages. What must
        // not happen is a policy naming a nonce no script carries, which would block the
        // import map on a *working* template's next deploy and look like a server bug.
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
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        ] {
            assert!(csp.contains(directive), "policy lost `{directive}`:\n{csp}");
        }
        // The one deviation, pinned so removing it is a deliberate act: on the loopback
        // origin every API call and the sync socket are cross-origin (`BRIDGE.md` §6).
        assert!(csp.contains("connect-src 'self' https: http: wss: ws:"));

        // And the directive where an extra source is a hole rather than a loosening is
        // asserted whole, exactly as `statics.rs` does: no `'unsafe-eval'` (only the
        // narrow Wasm form), no `blob:`, no `data:`, no `'unsafe-inline'`.
        let script_src = csp
            .split("; ")
            .find(|directive| directive.starts_with("script-src "))
            .expect("script-src is present");
        assert_eq!(script_src, "script-src 'self' 'nonce-N' 'wasm-unsafe-eval'");
    }

    /// `PUBLIC_URL` is what lets the deviation above stop being scheme-wide.
    #[test]
    fn a_configured_public_url_narrows_connect_src_to_that_origin() {
        let csp = shell_csp("N", Some("https://notes.example.com"));
        let connect = csp
            .split("; ")
            .find(|directive| directive.starts_with("connect-src "))
            .expect("connect-src is present");

        // Both spellings of the one host, and nothing else: the REST origin and the
        // socket origin. A policy with only the `https://` form would let the app log in
        // and then refuse `/api/sync`, which is the failure this pairing exists to avoid.
        assert_eq!(
            connect,
            "connect-src 'self' https://notes.example.com wss://notes.example.com"
        );
        // The bare *scheme sources* are gone — that is the entire point of setting the
        // variable. (Matched as whole tokens: `https:` the scheme source and
        // `https://notes.example.com` the host source are different sources, and only the
        // first is the wide one.)
        for scheme in ["https:", "http:", "wss:", "ws:"] {
            assert!(
                !connect.split(' ').any(|source| source == scheme),
                "the bare `{scheme}` scheme source survived the narrowing:\n{connect}"
            );
        }
        // Plain http deployments narrow too, to their own scheme pair.
        assert!(
            shell_csp("N", Some("http://192.168.1.10:8080"))
                .contains("connect-src 'self' http://192.168.1.10:8080 ws://192.168.1.10:8080;")
        );
        // Nothing else in the policy moves with it.
        assert!(csp.contains("media-src 'self' blob:"));
        assert!(csp.contains("script-src 'self' 'nonce-N' 'wasm-unsafe-eval'"));
    }

    #[test]
    fn the_synthesized_set_is_the_declared_one() {
        // `bundle_file` allowlists against this constant before it builds anything, and
        // `synthesize` fills exactly it; a name in one and not the other is a 404 on a
        // file the manifest promised.
        assert_eq!(SYNTHESIZED_FILES, &["index.html", "importmap.json"]);
    }
}
