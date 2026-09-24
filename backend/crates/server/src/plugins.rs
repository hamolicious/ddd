//! The installed-plugin registry and the import map (SPEC §6.2, §6.4).
//!
//! **What this is in M3 and what it becomes in M4.** The server's job in the plugin
//! system is "keep clients in step" (SPEC §2): it holds the installed set, resolves the
//! shared-library versions once, and serves both to every client. M3 implements exactly
//! that for the *frontend* halves, reading the installed set from a directory on disk.
//! M4 adds the Extism host, the zip installer and the approval flow — and they write the
//! same directory, so nothing here changes shape when they land.
//!
//! **The directory is the source of truth**, deliberately:
//!
//! ```text
//! <PLUGINS_DIR>/<id>/<version>/manifest.json
//! <PLUGINS_DIR>/<id>/<version>/frontend/index.mjs
//! ```
//!
//! That layout is what makes `/plugins/<id>/<version>/…` immutable and cacheable forever
//! (SPEC §8): the version is in the path, so a new version is a new URL and no cache
//! ever has to be invalidated. It is also why the registry can be a cheap directory scan
//! rather than a Mongo collection — in M3 there is nothing mutable about it, and in M4
//! the `plugins` collection becomes the *approval* record while the directory stays the
//! artifact store.
//!
//! **Only one version per plugin is ever served**: the highest. Two versions of one
//! plugin in one page would give two copies of its API to different dependents.
//!
//! Errors here are *reported*, never fatal: a malformed manifest disables one plugin and
//! logs why. A boot that refused to start because somebody dropped a bad zip into the
//! plugins directory would be a worse failure than the one it prevents.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::Config;

/// The base distribution (SPEC §6.5) — what `?safe=1` boots.
pub const BASE_PLUGIN_IDS: &[&str] = &[
    "admin",
    "commands",
    "doc-list",
    "document-surface",
    "editor",
    "folders",
    "markdown",
    "properties",
    "router",
    "search",
    "settings",
    "shell-ui",
    "themes",
    "viewer",
];

/// `^[a-z0-9][a-z0-9-]{0,63}$`, checked without a regex dependency.
pub fn is_valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    id.len() <= 64 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `1.2.3` with an optional `-prerelease` / `+build` tail.
pub fn is_valid_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// Order two versions by their numeric triple; anything unparseable sorts lowest.
fn compare_versions(a: &str, b: &str) -> Ordering {
    let triple = |v: &str| -> [u64; 3] {
        let core = v.split(['-', '+']).next().unwrap_or_default();
        let mut out = [0u64; 3];
        for (index, part) in core.split('.').take(3).enumerate() {
            out[index] = part.parse().unwrap_or(0);
        }
        out
    };
    triple(a).cmp(&triple(b))
}

/// The frontend half of a manifest (SPEC §6.2). Unknown fields are kept out of the
/// way rather than rejected: M4 adds `capabilities` enforcement and `config`, and an
/// M3 server must not refuse a manifest written for a newer one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginFrontend {
    pub module: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub version: String,
    pub kernel: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dependencies: BTreeMap<String, String>,
    #[serde(
        default,
        rename = "peerLibraries",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub peer_libraries: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontend: Option<PluginFrontend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// Everything else in the file, passed through untouched (`capabilities`,
    /// `config`, `backend`, `x-*`). The admin UI shows it; M4 enforces it.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// One entry of `GET /api/plugins`.
///
/// **camelCase on the wire**, unlike every other response this server produces. This
/// type is not a REST resource of its own: it is `InstalledPlugin` from
/// `web/kernel-api/src/manifest.ts`, i.e. a *kernel API type* that plugins and the
/// loader consume directly, and the manifest it wraps is already camelCase
/// (`peerLibraries`) because plugin authors write it by hand. One spelling on both
/// sides beats a conversion layer that can drift — the first version of this endpoint
/// shipped `base_url`, the loader read `baseUrl`, and every plugin failed to load with
/// `Cannot read properties of undefined`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    /// Version-scoped, trailing slash: the loader resolves module paths against it.
    pub base_url: String,
    /// M3 serves only `enabled`; `pending` arrives with the M4 approval flow.
    pub state: &'static str,
    pub base: bool,
}

/// A plugin directory the registry refused, with the reason a human needs.
#[derive(Debug, Clone, Serialize)]
pub struct PluginProblem {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct Registry {
    plugins: Vec<InstalledPlugin>,
    problems: Vec<PluginProblem>,
    /// The directory that was scanned. `None` on the default (empty) registry, which is
    /// what `DISABLE_PLUGINS=1` returns — and what makes every asset route 404.
    root: Option<PathBuf>,
}

impl Registry {
    pub fn plugins(&self) -> &[InstalledPlugin] {
        &self.plugins
    }

    pub fn problems(&self) -> &[PluginProblem] {
        &self.problems
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    pub fn get(&self, id: &str, version: &str) -> Option<&InstalledPlugin> {
        self.plugins
            .iter()
            .find(|plugin| plugin.manifest.id == id && plugin.manifest.version == version)
    }

    /// Every `peerLibraries` range any installed plugin declares, per library.
    ///
    /// M3 does not *resolve* these — one version of each library ships in the runtime
    /// bundle, so there is nothing to choose. What it does do is make a mismatch
    /// visible: `unsatisfied_peers` compares the declared ranges against the bundle
    /// and the import-map route logs what it found, which is the difference between
    /// "this plugin needs CodeMirror 7" and a blank screen.
    pub fn peer_ranges(&self) -> BTreeMap<&str, Vec<(&str, &str)>> {
        let mut out: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
        for plugin in &self.plugins {
            for (library, range) in &plugin.manifest.peer_libraries {
                out.entry(library.as_str())
                    .or_default()
                    .push((plugin.manifest.id.as_str(), range.as_str()));
            }
        }
        out
    }

    /// Libraries some plugin declares that the served import map does not provide.
    pub fn unsatisfied_peers(&self, provided: &BTreeMap<String, String>) -> Vec<String> {
        self.peer_ranges()
            .into_iter()
            .filter(|(library, _)| !provided.contains_key(*library))
            .map(|(library, users)| {
                let who: Vec<&str> = users.iter().map(|(id, _)| *id).collect();
                format!("{library} (declared by {})", who.join(", "))
            })
            .collect()
    }
}

/// Scan `dir` for installed plugins. Never fails: unreadable or malformed entries
/// become [`PluginProblem`]s.
pub fn scan(dir: &Path) -> Registry {
    let mut registry = Registry {
        root: Some(dir.to_path_buf()),
        ..Registry::default()
    };

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            // Not an error: a deployment with no plugins installed is a valid state,
            // and so is one where the directory has not been built yet.
            registry.problems.push(PluginProblem {
                path: dir.display().to_string(),
                message: format!("cannot read the plugins directory: {err}"),
            });
            return registry;
        }
    };

    // id → (version, manifest, dir)
    let mut best: BTreeMap<String, (String, PluginManifest)> = BTreeMap::new();

    for entry in entries.flatten() {
        let id_dir = entry.path();
        if !id_dir.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_valid_plugin_id(&id) {
            registry.problems.push(PluginProblem {
                path: id_dir.display().to_string(),
                message: format!("`{id}` is not a valid plugin id"),
            });
            continue;
        }

        let versions = match fs::read_dir(&id_dir) {
            Ok(versions) => versions,
            Err(err) => {
                registry.problems.push(PluginProblem {
                    path: id_dir.display().to_string(),
                    message: format!("cannot read: {err}"),
                });
                continue;
            }
        };

        for version_entry in versions.flatten() {
            let version_dir = version_entry.path();
            if !version_dir.is_dir() {
                continue;
            }
            let version = version_entry.file_name().to_string_lossy().to_string();
            if !is_valid_version(&version) {
                registry.problems.push(PluginProblem {
                    path: version_dir.display().to_string(),
                    message: format!("`{version}` is not a semver version"),
                });
                continue;
            }

            match read_manifest(&version_dir, &id, &version) {
                Ok(manifest) => {
                    let replace = best.get(&id).is_none_or(|(current, _)| {
                        compare_versions(&version, current) == Ordering::Greater
                    });
                    if replace {
                        best.insert(id.clone(), (version, manifest));
                    }
                }
                Err(message) => registry.problems.push(PluginProblem {
                    path: version_dir.display().to_string(),
                    message,
                }),
            }
        }
    }

    for (id, (version, manifest)) in best {
        registry.plugins.push(InstalledPlugin {
            base_url: format!("/plugins/{id}/{version}/"),
            base: BASE_PLUGIN_IDS.contains(&id.as_str()),
            state: "enabled",
            manifest,
        });
    }
    registry
        .plugins
        .sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    registry
}

fn read_manifest(dir: &Path, id: &str, version: &str) -> Result<PluginManifest, String> {
    let path = dir.join("manifest.json");
    let raw = fs::read_to_string(&path).map_err(|err| format!("manifest.json: {err}"))?;
    let manifest: PluginManifest =
        serde_json::from_str(&raw).map_err(|err| format!("manifest.json is invalid: {err}"))?;

    // The path is the truth: a manifest claiming another id or version would be served
    // under this URL and loaded under that name, and the loader would then check the
    // wrong dependency.
    if manifest.id != id {
        return Err(format!(
            "manifest id `{}` does not match the directory `{id}`",
            manifest.id
        ));
    }
    if manifest.version != version {
        return Err(format!(
            "manifest version `{}` does not match the directory `{version}`",
            manifest.version
        ));
    }
    let Some(frontend) = manifest.frontend.as_ref() else {
        // Backend-only plugins are legitimate (SPEC §6.3) but M3 serves nothing for
        // them; reporting it as a problem would be noise once M4 exists.
        return Err("no frontend half (backend-only plugins arrive in M4)".to_string());
    };
    if !safe_relative_path(&frontend.module) {
        return Err(format!(
            "frontend.module `{}` is not a safe relative path",
            frontend.module
        ));
    }
    if !dir.join(&frontend.module).is_file() {
        return Err(format!("frontend.module `{}` is missing", frontend.module));
    }
    // Browser assets live under `frontend/`, which is the package layout SPEC §6.2 fixes
    // (its zip rules reject "entries outside `frontend/**` + declared wasm"). It is
    // checked here as well as enforced by the serving route, so a package that spells it
    // differently is reported at scan time with this message instead of loading in the
    // client and 404-ing on its own module.
    if !is_frontend_asset(&frontend.module) {
        return Err(format!(
            "frontend.module `{}` is not under `frontend/`; only that directory is served",
            frontend.module
        ));
    }
    if let Some(style) = frontend.style.as_ref() {
        if !safe_relative_path(style) {
            return Err(format!(
                "frontend.style `{style}` is not a safe relative path"
            ));
        }
        if !is_frontend_asset(style) {
            return Err(format!(
                "frontend.style `{style}` is not under `frontend/`; only that directory is served"
            ));
        }
    }
    Ok(manifest)
}

/// `true` when a manifest-declared path is inside the served `frontend/` directory.
fn is_frontend_asset(path: &str) -> bool {
    let mut segments = path.split('/').filter(|segment| !segment.is_empty());
    segments.next() == Some("frontend") && segments.next().is_some()
}

/// A manifest-declared path must stay inside the package: no absolute paths, no
/// `..`, no backslashes (a Windows-authored zip), no drive letters.
pub fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && !path
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
}

// ---------------------------------------------------------------------------
// Process-wide cache
// ---------------------------------------------------------------------------

/// The registry is read on first use and cached, **keyed by the directory it scanned**.
///
/// A process-wide map rather than a field on `AppState`: `state.rs` is a frozen contract
/// (`backend/CONTRACTS.md`) and the sync layer already established this pattern for
/// process-wide registries. `reload` exists because M4's installer has to invalidate it,
/// and because it makes the scan testable.
///
/// The key matters. A single cached registry made the *first* `PLUGINS_DIR` any caller
/// asked about the answer for every later one — invisible in a server process, which has
/// one config, and fatal in a test binary, where every case points at its own fixture
/// directory and would have been served the first case's plugins.
static REGISTRY: OnceLock<RwLock<BTreeMap<PathBuf, Arc<Registry>>>> = OnceLock::new();

fn cell() -> &'static RwLock<BTreeMap<PathBuf, Arc<Registry>>> {
    REGISTRY.get_or_init(|| RwLock::new(BTreeMap::new()))
}

/// The cached registry, scanning `config.plugins_dir` on first call.
///
/// `DISABLE_PLUGINS=1` returns an empty registry without touching the disk — the
/// server-side half of safe mode (SPEC §6.1).
pub fn registry(config: &Config) -> Arc<Registry> {
    if config.disable_plugins {
        return Arc::new(Registry::default());
    }
    {
        let guard = cell().read().expect("plugin registry lock poisoned");
        if let Some(cached) = guard.get(&config.plugins_dir) {
            return Arc::clone(cached);
        }
    }
    reload(config)
}

/// Re-scan the plugins directory and replace the cache. Called at boot (so the log
/// line appears before the first request) and by M4's installer.
pub fn reload(config: &Config) -> Arc<Registry> {
    let scanned = Arc::new(scan(&config.plugins_dir));
    for problem in scanned.problems() {
        warn!(path = %problem.path, message = %problem.message, "plugin not loaded");
    }
    info!(
        plugins = scanned.plugins().len(),
        problems = scanned.problems().len(),
        dir = %config.plugins_dir.display(),
        "plugin registry loaded"
    );
    let mut guard = cell().write().expect("plugin registry lock poisoned");
    guard.insert(config.plugins_dir.clone(), Arc::clone(&scanned));
    scanned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_ids_and_versions_are_validated() {
        assert!(is_valid_plugin_id("shell-ui"));
        assert!(is_valid_plugin_id("a1"));
        assert!(!is_valid_plugin_id(""));
        assert!(!is_valid_plugin_id("-leading"));
        assert!(!is_valid_plugin_id("Upper"));
        assert!(!is_valid_plugin_id("has_underscore"));
        assert!(!is_valid_plugin_id("../escape"));

        assert!(is_valid_version("1.0.0"));
        assert!(is_valid_version("10.2.30-beta.1"));
        assert!(!is_valid_version("1.0"));
        assert!(!is_valid_version("v1.0.0"));
        assert!(!is_valid_version(".."));
    }

    #[test]
    fn manifest_paths_may_not_escape_the_package() {
        assert!(safe_relative_path("frontend/index.mjs"));
        assert!(!safe_relative_path("/etc/passwd"));
        assert!(!safe_relative_path("../../secrets"));
        assert!(!safe_relative_path("frontend/../../x"));
        assert!(!safe_relative_path("frontend\\index.mjs"));
        assert!(!safe_relative_path("c:/x"));
        assert!(!safe_relative_path(""));
    }

    #[test]
    fn versions_order_numerically_not_lexically() {
        assert_eq!(compare_versions("1.10.0", "1.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("2.0.0", "10.0.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Ordering::Equal);
    }

    #[test]
    fn a_missing_directory_is_a_problem_not_a_panic() {
        let registry = scan(Path::new("/nonexistent/life-manager/plugins"));
        assert!(registry.plugins().is_empty());
        assert_eq!(registry.problems().len(), 1);
    }

    #[test]
    fn the_base_distribution_is_the_fourteen_plugins_of_spec_6_5() {
        assert_eq!(BASE_PLUGIN_IDS.len(), 14);
        assert!(BASE_PLUGIN_IDS.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
