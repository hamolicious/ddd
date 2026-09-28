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
    "attachments",
    "changes",
    "commands",
    "context-menu",
    "doc-list",
    "document-surface",
    "editor",
    "fm-autocomplete",
    "folders",
    "graph",
    "header",
    "indexer",
    "markdown",
    "native-preview",
    "notices",
    "router",
    "settings",
    "shell-ui",
    "slash-commands",
    "sync-status",
    "syntax-highlight",
    "themes",
    "viewer",
    "welcome",
];

/// The `@kernel` contract version this server implements — what a manifest's `kernel`
/// range is checked against at install (SPEC §6.4: "one `kernel` semver covers both the
/// `@kernel` surface and the Wasm host ABI. … Server enforces at install").
///
/// Generated, like `KERNEL_API_VERSION` in `web/kernel-api/src/index.ts`, from the one
/// `x-kernel-version` line in `schema/manifest.schema.json`, so the server and the client
/// can no longer disagree about which plugins are installable.
pub const KERNEL_VERSION: &str = crate::manifest_types::KERNEL_VERSION;

/// The manifest's types are generated from `schema/manifest.schema.json`
/// (`web/scripts/gen-manifest.mjs`); their methods stay here.
pub use crate::manifest_types::{
    ConfigField, ConsumedPort, HttpCapability, PluginBackend, PluginCapabilities, PluginFrontend,
    PluginManifest, ProvidedPort,
};

/// Hook names a manifest's `backend.hooks` may contain (SPEC §6.3).
pub const HOOK_NAMES: &[&str] = &["document.created", "document.changed", "document.deleted"];

/// Methods a `backend.routes` declaration may use.
pub const ROUTE_METHODS: &[&str] = &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

/// The `documents` capability's legal values (SPEC §6.2). A typo'd `"writes"` is refused
/// at install rather than silently reading as "no write access requested".
pub const DOCUMENT_RIGHTS: &[&str] = &["read", "write"];

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
///
/// **Every character is checked, not just the numeric core.** A version string is used
/// verbatim as a filesystem path component — `<PLUGINS_DIR>/<id>/<version>/…`, the staging
/// work directory, `pending_dir`, and the `/plugins/:id/:version/*` URL — so anything this
/// function accepts must be a single, harmless path segment. Validating only the part before
/// the first `-`/`+` (as an earlier version of this did) accepted
/// `1.0.0-../../../../srv/web/evil`, and `fs::create_dir_all` + `canonicalize` in
/// [`crate::plugininstall::zipcheck::extract`] then happily resolved it *out* of the staging
/// tree: every allowlisted entry of the package (including arbitrary `frontend/**` files)
/// landed in a directory of the attacker's choosing, as the server process, reachable
/// without an admin click through the inbox watcher. The zip checks cannot catch that —
/// they validate entry names *inside* the archive, not the root they are handed.
pub fn is_valid_version(version: &str) -> bool {
    // Bound the whole string: it becomes a directory name.
    if version.is_empty() || version.len() > 128 {
        return false;
    }

    // Split the semver tails off in order: build metadata after the *first* `+`,
    // pre-release after the first `-` of what remains.
    let (without_build, build) = match version.split_once('+') {
        Some((head, build)) => (head, Some(build)),
        None => (version, None),
    };
    let (core, pre) = match without_build.split_once('-') {
        Some((head, pre)) => (head, Some(pre)),
        None => (without_build, None),
    };

    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    if !core_ok {
        return false;
    }

    // Dot-separated identifiers of ASCII alphanumerics and hyphens, each non-empty
    // (semver 2.0.0 §9/§10). This is what keeps `/`, `\`, `.` runs, NUL and every other
    // path-significant byte out of the tail.
    let identifiers_ok = |tail: &str| {
        !tail.is_empty()
            && tail.split('.').all(|identifier| {
                !identifier.is_empty()
                    && identifier
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
    };

    pre.is_none_or(identifiers_ok) && build.is_none_or(identifiers_ok)
}

/// Order two versions by their numeric triple; anything unparseable sorts lowest.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
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

impl PluginManifest {
    /// `true` when the package declares a backend half the host should load.
    pub fn has_backend(&self) -> bool {
        self.backend.is_some()
    }

    /// The declared cron expressions, or an empty slice.
    pub fn cron(&self) -> &[String] {
        self.backend
            .as_ref()
            .map(|backend| backend.cron.as_slice())
            .unwrap_or_default()
    }

    /// Config keys declared `secret: true`.
    pub fn secret_keys(&self) -> Vec<&str> {
        self.config
            .iter()
            .filter(|(_, field)| field.secret)
            .map(|(key, _)| key.as_str())
            .collect()
    }
}

impl PluginCapabilities {
    pub fn is_empty(&self) -> bool {
        self.documents.is_empty()
            && self.http.is_none()
            && !self.notifications
            && self.public_routes.is_empty()
    }

    pub fn can_read_documents(&self) -> bool {
        self.documents.iter().any(|c| c == "read")
    }

    pub fn can_write_documents(&self) -> bool {
        self.documents.iter().any(|c| c == "write")
    }

    /// Approved hosts, lowercased. Empty ⇒ `http_request` is an erroring stub.
    pub fn http_hosts(&self) -> Vec<String> {
        self.http
            .as_ref()
            .map(|http| {
                http.hosts
                    .iter()
                    .map(|host| host.trim().to_ascii_lowercase())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The form the host hands a plugin ([`life_manager_plugin_abi::Capabilities`]).
    pub fn to_abi(&self) -> life_manager_plugin_abi::Capabilities {
        life_manager_plugin_abi::Capabilities {
            documents: self.documents.clone(),
            http_hosts: self.http_hosts(),
            public_routes: self.public_routes.clone(),
            notifications: self.notifications,
        }
    }

    /// Is `granted` a legal approval of `self` (the request)?
    ///
    /// The rule, and the one exception: an approval may **narrow** anything, and may
    /// **extend `http.hosts`**. A plugin whose destination is admin-configured cannot know
    /// its host when it is packaged — a feed importer ships `hosts: []` and the
    /// operator who enters a feed URL is the one who knows the host — and the alternative
    /// is asking that operator to repackage a zip. Widening anything else (a `documents`
    /// right, a public route the package never declared) is refused: those are the
    /// package's own claims about itself.
    pub fn approval_is_legal(&self, granted: &PluginCapabilities) -> Result<(), String> {
        for right in &granted.documents {
            if !self.documents.iter().any(|requested| requested == right) {
                return Err(format!(
                    "the package did not request `documents: [\"{right}\"]`; an approval may not add it"
                ));
            }
        }
        if granted.notifications && !self.notifications {
            return Err(
                "the package did not request `notifications`; an approval may not add it"
                    .to_string(),
            );
        }
        for route in &granted.public_routes {
            if !self
                .public_routes
                .iter()
                .any(|requested| requested == route)
            {
                return Err(format!(
                    "the package did not declare `{route}` as a public route; an approval may not add it"
                ));
            }
        }
        // The one widening. `hosts` may grow, but only for a package that asked for the
        // `http` capability at all — granting HTTP to a plugin whose manifest never
        // mentioned it is adding a capability, not widening one.
        if let Some(http) = granted.http.as_ref() {
            if self.http.is_none() {
                return Err(
                    "the package did not request the `http` capability; an approval may not add it"
                        .to_string(),
                );
            }
            for host in &http.hosts {
                validate_host(host)?;
            }
        }
        Ok(())
    }

    /// Every capability well-formedness rule of `HOST-ABI.md` §7.1 step 5, checked against
    /// the manifest's own `backend.routes`.
    pub fn validate(&self, declared_routes: &[RouteSpec]) -> Result<(), String> {
        for right in &self.documents {
            if !DOCUMENT_RIGHTS.contains(&right.as_str()) {
                return Err(format!(
                    "`capabilities.documents` may only contain {DOCUMENT_RIGHTS:?}, not `{right}`"
                ));
            }
        }
        if let Some(http) = self.http.as_ref() {
            for host in &http.hosts {
                validate_host(host)?;
            }
        }
        for route in &self.public_routes {
            if !declared_routes.iter().any(|spec| spec.path == *route) {
                return Err(format!(
                    "`public-routes` lists `{route}`, which is not in `backend.routes`"
                ));
            }
        }
        Ok(())
    }
}

/// A `http.hosts` entry must be a bare host name: no scheme, no path, no port, no wildcard
/// (HOST-ABI.md §3.11 matches hosts exactly, so a wildcard would silently match nothing and
/// a `https://` prefix would never match at all).
fn validate_host(host: &str) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("`http.hosts` contains an empty entry".to_string());
    }
    if host.contains("://") || host.contains('/') {
        return Err(format!(
            "`http.hosts` entry `{host}` must be a bare host name, with no scheme and no path"
        ));
    }
    if host.contains('*') {
        return Err(format!(
            "`http.hosts` entry `{host}` uses a wildcard; hosts are matched exactly"
        ));
    }
    if host.contains(':') {
        return Err(format!(
            "`http.hosts` entry `{host}` must not carry a port; the host alone is the grant"
        ));
    }
    if host
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
    {
        return Err(format!("`http.hosts` entry `{host}` is not a host name"));
    }
    Ok(())
}

/// One declared inbound route, parsed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteSpec {
    /// Upper-case method.
    pub method: String,
    /// Leading slash, no trailing slash, no `..`, no wildcards: a plugin's route table is
    /// exact, so two plugins' routes can never overlap and a path cannot be smuggled.
    pub path: String,
    /// Reachable without a session (`capabilities.public-routes`).
    pub public: bool,
}

impl RouteSpec {
    /// Parse `"POST /webhook"`.
    pub fn parse(declaration: &str, public_routes: &[String]) -> Result<RouteSpec, String> {
        let mut parts = declaration.split_whitespace();
        let (Some(method), Some(path)) = (parts.next(), parts.next()) else {
            return Err(format!(
                "`{declaration}` is not a route declaration; the form is `METHOD /path`"
            ));
        };
        if parts.next().is_some() {
            return Err(format!("`{declaration}` has more than a method and a path"));
        }
        let method = method.to_ascii_uppercase();
        if !ROUTE_METHODS.contains(&method.as_str()) {
            return Err(format!(
                "`{method}` is not a method a plugin route may declare ({ROUTE_METHODS:?})"
            ));
        }
        // Exact paths only: no wildcards, no parameters. Two plugins' route tables can then
        // never overlap, and a path cannot be smuggled past the dispatcher's prefix strip.
        if !path.starts_with('/') {
            return Err(format!("route path `{path}` must start with `/`"));
        }
        if path.len() > 1 && path.ends_with('/') {
            return Err(format!("route path `{path}` must not end with `/`"));
        }
        if path.contains("//") {
            return Err(format!("route path `{path}` has an empty segment"));
        }
        if path
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
        {
            return Err(format!("route path `{path}` contains a relative segment"));
        }
        if path.chars().any(|c| {
            matches!(c, '*' | '{' | '}' | '?' | '#' | ':' | '\\') || c.is_whitespace() || c == '\0'
        }) {
            return Err(format!(
                "route path `{path}` may only contain literal path characters"
            ));
        }
        if !path.is_ascii() {
            return Err(format!("route path `{path}` must be ASCII"));
        }
        Ok(RouteSpec {
            public: public_routes.iter().any(|public| public == path),
            method,
            path: path.to_string(),
        })
    }
}

/// Parse every `backend.routes` declaration of a manifest, marking the public ones **as the
/// package requested them**.
///
/// This is the *request*, which is what the install-time validation
/// ([`PluginCapabilities::validate`]) and the pending approval screen need. Anything that
/// decides whether a live route may be served without a session must use
/// [`route_specs_granted`] instead: the admin is allowed to decline a public route, and
/// declining it has to mean something.
pub fn route_specs(manifest: &PluginManifest) -> Result<Vec<RouteSpec>, String> {
    route_specs_with_public(manifest, &manifest.capabilities.public_routes)
}

/// [`route_specs`], with `public` taken from what an admin **granted** rather than from what
/// the package asked for.
///
/// The approval screen presents each requested public route as its own checkbox with the
/// warning that "anyone who can reach this server can call them, with no session", and
/// [`PluginCapabilities::approval_is_legal`] accepts a narrowed set. Deriving the live
/// `public` flag from the manifest instead of the grant silently discarded that decision:
/// an admin who unchecked `/webhook` and approved still got an unauthenticated webhook —
/// the free outbound-request amplifier the dispatcher's own docs warn about.
pub fn route_specs_granted(
    manifest: &PluginManifest,
    granted: &PluginCapabilities,
) -> Result<Vec<RouteSpec>, String> {
    route_specs_with_public(manifest, &granted.public_routes)
}

fn route_specs_with_public(
    manifest: &PluginManifest,
    public_routes: &[String],
) -> Result<Vec<RouteSpec>, String> {
    let Some(backend) = manifest.backend.as_ref() else {
        return Ok(Vec::new());
    };
    let mut specs = Vec::with_capacity(backend.routes.len());
    for declaration in &backend.routes {
        let spec = RouteSpec::parse(declaration, public_routes)?;
        if specs
            .iter()
            .any(|other: &RouteSpec| other.method == spec.method && other.path == spec.path)
        {
            return Err(format!(
                "`backend.routes` declares `{} {}` twice",
                spec.method, spec.path
            ));
        }
        specs.push(spec);
    }
    Ok(specs)
}

// ---------------------------------------------------------------------------
// The approval record (Mongo `plugins`)
// ---------------------------------------------------------------------------

/// Where a plugin is in its life cycle (SPEC §6.2).
///
/// `pending` is the state that matters: **both** install paths land there, and only an
/// explicit admin click moves a plugin out of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginState {
    /// Installed on disk, not served, not loaded. Awaiting approval.
    Pending,
    /// Approved by an admin: its frontend half is served and its backend half is active.
    ///
    /// The wire spelling is **`enabled`**, not `approved`, because that is the word
    /// `web/kernel-api/src/manifest.ts` froze in M3 and the loader compares against
    /// (`plugin.state !== "enabled"` ⇒ skip). Approval is the *transition*; enabled is the
    /// state.
    Enabled,
    /// Approved but switched off — by an admin, or by the circuit breaker.
    Disabled,
    /// Approved but its backend half could not be activated. The frontend half is still
    /// served: half a plugin is usually better than none, and the admin screen says which
    /// half is missing.
    Failed,
}

impl PluginState {
    /// `true` when the frontend half should be served to clients.
    ///
    /// **A pending plugin is not served** — that is what keeps an unapproved package's
    /// code out of every user's session (SPEC §6.1's trust model: the frontend half runs
    /// unsandboxed).
    pub fn is_served(self) -> bool {
        matches!(
            self,
            PluginState::Enabled | PluginState::Disabled | PluginState::Failed
        )
    }

    /// `true` when the backend half should be running.
    pub fn is_active(self) -> bool {
        matches!(self, PluginState::Enabled)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PluginState::Pending => "pending",
            PluginState::Enabled => "enabled",
            PluginState::Disabled => "disabled",
            PluginState::Failed => "failed",
        }
    }
}

/// The `plugins` collection: the **approval record**, while the directory stays the
/// artifact store (the M3 note in `backend/CONTRACTS.md` promised exactly this split).
///
/// Deliberately **not** in `domain.rs`, unlike every other Mongo shape. `domain.rs` is a
/// frozen file every area compiles against, and this record is coupled to the manifest
/// types in *this* module — putting it there would mean a frozen file that imports the
/// plugin subsystem, and a merge conflict for every builder. Announced as a deviation in
/// `backend/CONTRACTS.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRecord {
    /// `_id` is `<id>` — one record per plugin, not per version: two versions of one
    /// plugin are never served at once (see the registry's "one version per plugin"),
    /// so the record tracks the installed one.
    #[serde(rename = "_id")]
    pub id: String,
    pub version: String,
    pub state: PluginState,
    /// The manifest as installed, so the admin screen and the host do not re-read disk.
    pub manifest: PluginManifest,
    /// What the admin approved. Empty until approval.
    #[serde(default)]
    pub capabilities_approved: PluginCapabilities,
    pub source: crate::plugininstall::InstallSource,
    pub installed_at: crate::domain::Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<crate::domain::Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_by: Option<String>,
    /// Why it is off: `"admin"`, or the breaker's reason. Persisted so a restart does not
    /// silently re-enable a plugin nobody has looked at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
    /// The last activation or call failure, for the admin screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Hex SHA-256 of `backend.wasm` as installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_sha256: Option<String>,
    /// One entry per `backend.cron` expression (SPEC §6.3: `last_run` persisted).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cron_state: Vec<crate::pluginhost::cron::CronState>,
}

/// One `plugin_kv` row. `_id` is `<plugin_id>:<key>`, which makes the namespace
/// structural: there is no query a plugin could ask that reaches another's keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginKvEntry {
    #[serde(rename = "_id")]
    pub id: String,
    pub plugin_id: String,
    pub key: String,
    pub value: bson::Bson,
    pub updated_at: crate::domain::Timestamp,
}

/// One `plugin_config` row (one per plugin, all keys together — an admin saves a form, not
/// a field).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfigEntry {
    #[serde(rename = "_id")]
    pub plugin_id: String,
    /// Key → plain value, or the sealed form for secrets
    /// ([`crate::plugininstall::config::StoredValue`]).
    pub values: bson::Document,
    pub updated_at: crate::domain::Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

// ---------------------------------------------------------------------------
// Resolution (SPEC §6.1, §6.4) — shared by the installer and the import map
// ---------------------------------------------------------------------------

/// The one version of each peer library a set of plugins gets, for the import map.
#[derive(Debug, Clone, Default)]
pub struct Resolution {
    /// Library → the single version every plugin will get.
    pub peer_versions: BTreeMap<String, String>,
    /// Non-fatal notes for the admin screen.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResolveError {
    #[error(
        "`{library}` is required as {ranges} by different plugins, with no version satisfying all of them"
    )]
    PeerConflict { library: String, ranges: String },
}

/// Resolve the peer libraries over a set of manifests. (Activation order is the wiring
/// resolver's, `life_manager_core::wiring`, over `provides`/`consumes`.)
///
/// **One resolution, two consumers** (the promise M3 left open): the installer runs it to
/// decide whether a package may be installed at all, and `/importmap.json` runs it to pick
/// the one version of each blessed library every plugin gets. Import maps cannot change
/// after load (SPEC §6.4), which is why the choice has to be made here, once, over the
/// whole installed set, rather than per plugin at load time.
pub fn resolve(manifests: &[PluginManifest]) -> Result<Resolution, ResolveError> {
    // --- peer libraries ---------------------------------------------------
    // One version of each library for every plugin, chosen here, because an import map
    // cannot change after load (SPEC §6.4). The choice is the highest floor any declared
    // range implies; if that version does not satisfy every range, no single version does
    // within this range subset, and the install is refused rather than resolved to
    // something half the plugins were not written against.
    let mut peer_ranges: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
    for manifest in manifests {
        for (library, range) in &manifest.peer_libraries {
            peer_ranges
                .entry(library.as_str())
                .or_default()
                .push((manifest.id.as_str(), range.as_str()));
        }
    }

    let mut peer_versions = BTreeMap::new();
    let mut warnings = Vec::new();
    for (library, declarations) in peer_ranges {
        let mut floor = [0u64; 3];
        for (_, range) in &declarations {
            let candidate = range_floor(range)?;
            if candidate > floor {
                floor = candidate;
            }
        }
        let chosen = format!("{}.{}.{}", floor[0], floor[1], floor[2]);
        let unsatisfied: Vec<String> = declarations
            .iter()
            .filter_map(|(plugin, range)| match satisfies(&chosen, range) {
                Ok(true) => None,
                Ok(false) | Err(_) => Some(format!("{plugin} wants {range}")),
            })
            .collect();
        if !unsatisfied.is_empty() {
            return Err(ResolveError::PeerConflict {
                library: library.to_string(),
                ranges: unsatisfied.join(", "),
            });
        }
        if declarations.len() > 1 {
            let distinct: std::collections::BTreeSet<&str> =
                declarations.iter().map(|(_, range)| *range).collect();
            if distinct.len() > 1 {
                warnings.push(format!(
                    "`{library}` is declared as {} by different plugins; all of them get {chosen}",
                    distinct.into_iter().collect::<Vec<_>>().join(" / ")
                ));
            }
        }
        peer_versions.insert(library.to_string(), chosen);
    }

    Ok(Resolution {
        peer_versions,
        warnings,
    })
}

/// The lowest version a range admits, as a numeric triple. `*` is `0.0.0`.
fn range_floor(range: &str) -> Result<[u64; 3], ResolveError> {
    let range = range.trim();
    if range == "*" {
        return Ok([0, 0, 0]);
    }
    let bare = range
        .strip_prefix('^')
        .or_else(|| range.strip_prefix('~'))
        .or_else(|| range.strip_prefix('='))
        .unwrap_or(range);
    parse_partial(bare).ok_or_else(|| ResolveError::PeerConflict {
        library: range.to_string(),
        ranges: format!("`{range}` is not a supported version range"),
    })
}

/// `1`, `1.2` or `1.2.3` → `[1, 0, 0]` / `[1, 2, 0]` / `[1, 2, 3]`. Any prerelease or build
/// tail is dropped: ordering prereleases is not in the supported subset, and pretending to
/// would be worse than saying so.
fn parse_partial(input: &str) -> Option<[u64; 3]> {
    let core = input.split(['-', '+']).next().unwrap_or_default();
    if core.is_empty() {
        return None;
    }
    let mut out = [0u64; 3];
    for (seen, part) in core.split('.').enumerate() {
        if seen == 3 || part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        out[seen] = part.parse().ok()?;
    }
    Some(out)
}

/// Does `version` satisfy `range`?
///
/// The supported subset is `^x.y`, `^x.y.z`, `~x.y.z`, `x.y.z` and `*` — what every
/// manifest in this repository uses. Anything else is a manifest error rather than a
/// silently permissive match: "this range is not supported" is a fixable message, and a
/// wrong `true` here loads a plugin against an API that has moved.
pub fn satisfies(version: &str, range: &str) -> Result<bool, ResolveError> {
    let unsupported = || ResolveError::PeerConflict {
        library: range.to_string(),
        ranges: format!(
            "`{range}` is not a supported version range (use `*`, `x.y.z`, `^x.y[.z]` or `~x.y[.z]`)"
        ),
    };

    let Some(actual) = parse_partial(version) else {
        return Err(ResolveError::PeerConflict {
            library: version.to_string(),
            ranges: format!("`{version}` is not a version"),
        });
    };

    let range = range.trim();
    if range == "*" {
        return Ok(true);
    }

    let (operator, bare) = match range.as_bytes().first() {
        Some(b'^') => ('^', &range[1..]),
        Some(b'~') => ('~', &range[1..]),
        Some(b'=') => ('=', &range[1..]),
        _ => ('=', range),
    };
    let floor = parse_partial(bare).ok_or_else(unsupported)?;
    // How many components the author wrote — `~1.2` and `~1.2.0` are not the same range.
    let written = bare
        .split(['-', '+'])
        .next()
        .unwrap_or_default()
        .split('.')
        .count();

    if actual < floor {
        return Ok(false);
    }
    Ok(match operator {
        // Caret: the left-most non-zero component is pinned (so `^0.2.1` does not admit
        // 0.3.0). This is npm/cargo semantics, and it is the one place where being
        // approximately right would load a plugin against an API that has moved.
        '^' => {
            if floor[0] > 0 {
                actual[0] == floor[0]
            } else if floor[1] > 0 || written >= 2 {
                actual[0] == 0 && actual[1] == floor[1]
            } else {
                actual[0] == 0
            }
        }
        // Tilde: patch-level changes when a minor is written, minor-level when it is not.
        '~' => {
            if written >= 2 {
                actual[0] == floor[0] && actual[1] == floor[1]
            } else {
                actual[0] == floor[0]
            }
        }
        // Exact, to the precision written: `1.0` means "any 1.0.x".
        _ => match written {
            1 => actual[0] == floor[0],
            2 => actual[0] == floor[0] && actual[1] == floor[1],
            _ => actual == floor,
        },
    })
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
    /// M4: `enabled` unless a record says otherwise.
    ///
    /// **A pending package is never in `PLUGINS_DIR`** — that is the structural half of
    /// "pending installs cannot be fetched before an admin approves them". The installer
    /// extracts into `PLUGIN_STAGING_DIR/pending/<id>/<version>/`, which no route can
    /// reach, and *approval* is the rename into the served root. So the directory alone is
    /// enough to answer "may this be served", and Mongo is only consulted to demote an
    /// entry to `disabled`/`failed` ([`Registry::apply_states`]) — a server that cannot
    /// reach Mongo therefore serves the last approved set rather than nothing.
    pub state: PluginState,
    pub base: bool,
    /// Short content fingerprint of the frontend assets (module + style). The loader
    /// appends it as `?v=` so the version-scoped-immutable cache story survives a
    /// rebuild that does not bump the version — the M4 integration's "stale immutable
    /// module" trap. Same bytes ⇒ same URL ⇒ still cached forever; new bytes ⇒ new URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_version: Option<String>,
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
    /// The protocol packages the served plugins ship, by `id@version` (PLUGIN-PROTOCOLS §3).
    protocols: BTreeMap<String, crate::protocols::RegisteredProtocol>,
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

    /// The protocol packages the served plugins ship, by `id@version`.
    pub fn protocols(&self) -> &BTreeMap<String, crate::protocols::RegisteredProtocol> {
        &self.protocols
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

    /// Demote entries the approval records say are `disabled` or `failed`, so
    /// `/api/plugins` tells the loader the truth and the admin screen can explain a plugin
    /// that is installed but not running.
    ///
    /// Additive by construction: a record that is missing leaves the scanned entry alone.
    /// A plugin in the served directory with no record is an *adopted* M3 install
    /// ([`crate::plugininstall::adopt_installed_directory`]), not an error.
    pub fn apply_states(&mut self, records: &[PluginRecord]) {
        for plugin in &mut self.plugins {
            let Some(record) = records
                .iter()
                .find(|record| record.id == plugin.manifest.id)
            else {
                // An adopted M3 install: served, and nobody has said otherwise.
                continue;
            };
            if record.version != plugin.manifest.version {
                // The record describes a different version than the one on disk — a
                // half-finished upgrade, or a directory an operator edited by hand. Leaving
                // the scanned entry alone is the conservative answer: the served artifact is
                // real, and demoting it on the strength of a record about another version
                // would take a working app offline.
                warn!(
                    plugin = %plugin.manifest.id,
                    on_disk = %plugin.manifest.version,
                    recorded = %record.version,
                    "the plugin record names a different version than the served directory"
                );
                continue;
            }
            plugin.state = record.state;
        }
    }

    /// Every manifest in the registry, for [`resolve`].
    pub fn manifests(&self) -> Vec<PluginManifest> {
        self.plugins
            .iter()
            .map(|plugin| plugin.manifest.clone())
            .collect()
    }

    /// The manifests of the plugins that will actually be *loaded* — `enabled` only.
    ///
    /// The distinction matters for the import map: a `disabled` or `failed` plugin's
    /// frontend half is still served (half a plugin beats none, and the admin screen needs
    /// to explain it), but the loader skips it (`plugin.state !== "enabled"`), so its
    /// `peerLibraries` ranges must not get a vote in a version every *loaded* plugin has to
    /// live with.
    pub fn loaded_manifests(&self) -> Vec<PluginManifest> {
        self.plugins
            .iter()
            .filter(|plugin| plugin.state.is_active())
            .map(|plugin| plugin.manifest.clone())
            .collect()
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

    let served: Vec<(String, bool, PathBuf)> = best
        .iter()
        .map(|(id, (version, _))| {
            (
                id.clone(),
                BASE_PLUGIN_IDS.contains(&id.as_str()),
                dir.join(id).join(version),
            )
        })
        .collect();
    let (protocols, protocol_problems) = crate::protocols::from_scan(&served);
    registry.protocols = protocols;
    registry.problems.extend(protocol_problems);

    for (id, (version, manifest)) in best {
        let assets_version = frontend_assets_version(&dir.join(&id).join(&version), &manifest);
        registry.plugins.push(InstalledPlugin {
            base_url: format!("/plugins/{id}/{version}/"),
            base: BASE_PLUGIN_IDS.contains(&id.as_str()),
            state: PluginState::Enabled,
            manifest,
            assets_version,
        });
    }
    registry
        .plugins
        .sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    registry
}

/// 12-hex fingerprint of the frontend's served bytes (module, then style), or `None`
/// when there is no frontend or a file is unreadable — an unreadable file will fail at
/// load time with its own error; a missing `?v=` must not hide that behind a cache hit.
fn frontend_assets_version(package_dir: &Path, manifest: &PluginManifest) -> Option<String> {
    use sha2::{Digest, Sha256};
    let frontend = manifest.frontend.as_ref()?;
    let mut combined = Sha256::new();
    for relative in std::iter::once(&frontend.module).chain(frontend.style.as_ref()) {
        let file_hash =
            crate::plugininstall::zipcheck::sha256_file(&package_dir.join(relative)).ok()?;
        combined.update(file_hash.as_bytes());
    }
    Some(hex::encode(combined.finalize())[..12].to_string())
}

fn read_manifest(dir: &Path, id: &str, version: &str) -> Result<PluginManifest, String> {
    let path = dir.join("manifest.json");
    let raw = fs::read_to_string(&path).map_err(|err| format!("manifest.json: {err}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|err| format!("manifest.json is invalid: {err}"))?;
    let problems = crate::manifest_schema::validate_manifest(&value);
    if !problems.is_empty() {
        return Err(format!(
            "manifest.json is invalid: {}",
            crate::manifest_schema::describe(&problems)
        ));
    }
    let manifest: PluginManifest =
        serde_json::from_value(value).map_err(|err| format!("manifest.json is invalid: {err}"))?;

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
// The import map (M4: peer-library resolution over the whole installed set)
// ---------------------------------------------------------------------------

/// What `/importmap.json` should serve, and what is wrong with it.
///
/// M3 served the runtime bundle's map and *checked* that every declared `peerLibraries`
/// entry was present. This is the resolution SPEC §6.4 asks for — "the server resolves all
/// installed plugins' ranges to single versions at install" — made visible at serve time
/// as well, now that third-party plugins can be installed and each of them brings its own
/// ranges:
///
/// - `imports` is what goes on the wire. It is the runtime bundle's map **unchanged**:
///   plugin modules are loaded by URL, never by bare specifier, so no installed plugin ever
///   adds an entry. Saying so explicitly is the point — "the import map includes the
///   installed plugins" is a tempting and wrong reading of §6.4.
/// - `chosen` is the one version of each library the installed set resolves to. The install
///   flow refuses a package whose ranges cannot meet the others' (`resolve`), so this is
///   informational — but it is what an operator needs when a plugin author asks "which
///   CodeMirror am I getting".
/// - `missing` is a library some loaded plugin declares that the bundle does not provide.
///   An import map cannot change after load, so such a plugin will fail on its first bare
///   import; the install flow refuses one when the bundle is known, and this is the
///   backstop for a plugin adopted from disk or a bundle that changed underneath.
#[derive(Debug, Clone, Default)]
pub struct PeerResolution {
    pub imports: BTreeMap<String, String>,
    pub chosen: BTreeMap<String, String>,
    pub missing: Vec<String>,
    pub warnings: Vec<String>,
}

/// Resolve the peer libraries of everything that will load, against what the runtime bundle
/// provides.
///
/// Never fails: a conflict is a warning here, because the enforcement point is *install*
/// (where an operator can still act) and a boot that refused to serve an import map would
/// take the whole app down over one plugin.
pub fn resolve_import_map(
    registry: &Registry,
    provided: &BTreeMap<String, String>,
    provided_versions: &BTreeMap<String, String>,
) -> PeerResolution {
    let manifests = registry.loaded_manifests();
    let (chosen, mut warnings) = match resolve(&manifests) {
        Ok(resolution) => (resolution.peer_versions, resolution.warnings),
        Err(err) => (BTreeMap::new(), vec![err.to_string()]),
    };

    let mut missing = Vec::new();
    for (library, users) in registry.peer_ranges() {
        if !provided.contains_key(library) {
            let who: Vec<&str> = users.iter().map(|(id, _)| *id).collect();
            missing.push(format!("{library} (declared by {})", who.join(", ")));
            continue;
        }
        // The range check the install flow makes, repeated here for the plugins that never went
        // through it — adopted from disk, or installed against a bundle that has since been
        // rebuilt with a new major. A warning rather than a refusal: the enforcement point is
        // install, where an operator can still act, and refusing to serve an import map would
        // take the whole app down over one plugin.
        let Some(version) = provided_versions.get(library) else {
            continue;
        };
        for (plugin, range) in users {
            if matches!(satisfies(version, range), Ok(false)) {
                warnings.push(format!(
                    "`{plugin}` declares `{library}` {range}, but the runtime layer provides \
                     {version}; it will fail on its first bare import"
                ));
            }
        }
    }
    if !missing.is_empty() && provided.is_empty() {
        warnings.push(
            "this server serves no runtime bundle, so no peer library can be satisfied".to_string(),
        );
    }

    PeerResolution {
        imports: provided.clone(),
        chosen,
        missing,
        warnings,
    }
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
    reload_with_records(config, &[])
}

/// [`reload`], with the approval records applied to the scan (M4).
///
/// The wiring the M4 scaffold left open: `reload` alone reports `enabled` for a directory
/// whose record says `disabled`, because a directory scan cannot know. Every
/// `plugininstall` action that changes what is served calls this
/// ([`crate::plugininstall::refresh_registry`]), so `/api/plugins` and the static asset
/// route agree with the `plugins` collection.
///
/// **An empty `records` slice is not "everything is disabled"** — it is "no records were
/// read", which is also what a Mongo outage looks like. [`Registry::apply_states`] is
/// additive for exactly that reason: an entry with no record keeps the state the scan gave
/// it, so a server that cannot reach Mongo serves the last approved set rather than
/// nothing.
pub fn reload_with_records(config: &Config, records: &[PluginRecord]) -> Arc<Registry> {
    if config.disable_plugins {
        // Safe mode: nothing is scanned, so nothing can be served or demoted.
        let empty = Arc::new(Registry::default());
        let mut guard = cell().write().expect("plugin registry lock poisoned");
        guard.insert(config.plugins_dir.clone(), Arc::clone(&empty));
        return empty;
    }

    let mut scanned = scan(&config.plugins_dir);
    scanned.apply_states(records);
    let scanned = Arc::new(scanned);
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
        assert!(is_valid_version("1.0.0+build.5"));
        assert!(is_valid_version("1.0.0-rc-1+exp.sha.5114f85"));
        assert!(!is_valid_version("1.0"));
        assert!(!is_valid_version("v1.0.0"));
        assert!(!is_valid_version(".."));
    }

    /// The version is a filesystem path component (`<PLUGINS_DIR>/<id>/<version>/…`, the
    /// staging work dir, `pending_dir`), so a tail that validates must still be one
    /// harmless segment. Checking only the numeric core let a manifest walk out of the
    /// staging tree and write the package's files anywhere the server process could.
    #[test]
    fn version_tails_cannot_escape_a_path_component() {
        assert!(!is_valid_version("1.0.0-../../../../srv/web/evil"));
        assert!(!is_valid_version("1.0.0+../evil"));
        assert!(!is_valid_version("1.0.0-.."));
        assert!(!is_valid_version("1.0.0-a/b"));
        assert!(!is_valid_version("1.0.0-a\\b"));
        assert!(!is_valid_version("1.0.0-"));
        assert!(!is_valid_version("1.0.0+"));
        assert!(!is_valid_version("1.0.0-beta."));
        assert!(!is_valid_version("1.0.0-be..ta"));
        assert!(!is_valid_version("1.0.0-beta\0"));
        assert!(!is_valid_version(&format!("1.0.0-{}", "a".repeat(200))));

        // And nothing that escapes survives being joined onto a root.
        for bad in ["1.0.0-../../etc", "1.0.0+../..", "../1.0.0"] {
            assert!(!is_valid_version(bad), "{bad} must be refused");
        }
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

    /// One entry as the scan would have produced it.
    fn installed(id: &str, peers: &[(&str, &str)], state: PluginState) -> InstalledPlugin {
        let peer_libraries: serde_json::Map<String, serde_json::Value> = peers
            .iter()
            .map(|(library, range)| ((*library).to_string(), serde_json::json!(range)))
            .collect();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "id": id,
            "version": "1.0.0",
            "kernel": "^2.0",
            "peerLibraries": peer_libraries,
            "frontend": { "module": "frontend/index.mjs" },
        }))
        .expect("a valid manifest");
        InstalledPlugin {
            base_url: format!("/plugins/{id}/1.0.0/"),
            base: false,
            state,
            manifest,
            assets_version: None,
        }
    }

    /// The M4 import-map contract (SPEC §6.4): one version per library over everything that
    /// will *load*, the map itself untouched by the installed set, and a library the bundle
    /// does not provide reported rather than silently resolved.
    #[test]
    fn the_import_map_resolves_one_version_per_library_over_the_loaded_set() {
        let mut registry = Registry::default();
        registry.plugins.push(installed(
            "editor",
            &[("@codemirror/view", "^6.2")],
            PluginState::Enabled,
        ));
        registry.plugins.push(installed(
            "outline",
            &[("@codemirror/view", "^6.4")],
            PluginState::Enabled,
        ));
        registry.plugins.push(installed(
            "legacy",
            &[("@lezer/highlight", "^1.0")],
            PluginState::Disabled,
        ));

        let provided = BTreeMap::from([(
            "@codemirror/view".to_string(),
            "/assets/codemirror-view-abc123.js".to_string(),
        )]);
        let versions = BTreeMap::from([("@codemirror/view".to_string(), "6.26.3".to_string())]);
        let resolution = resolve_import_map(&registry, &provided, &versions);

        assert_eq!(
            resolution.imports, provided,
            "no installed plugin ever adds an import-map entry — plugin modules load by URL"
        );
        assert_eq!(
            resolution
                .chosen
                .get("@codemirror/view")
                .map(String::as_str),
            Some("6.4.0"),
            "the highest floor any loaded plugin requires is the one version they all get"
        );
        // The disabled plugin is still *served* (half a plugin beats none), so its
        // unsatisfiable library is reported…
        assert!(
            resolution
                .missing
                .iter()
                .any(|entry| entry.starts_with("@lezer/highlight")),
            "{:?}",
            resolution.missing
        );
        // …but it gets no vote in a version the plugins that actually load have to live
        // with, because the loader skips anything that is not `enabled`.
        assert!(!resolution.chosen.contains_key("@lezer/highlight"));

        // And a genuine conflict is a warning here, never a refusal: the enforcement point
        // is install, where an operator can still act.
        let mut conflicting = Registry::default();
        conflicting.plugins.push(installed(
            "a",
            &[("@codemirror/view", "^6.0")],
            PluginState::Enabled,
        ));
        conflicting.plugins.push(installed(
            "b",
            &[("@codemirror/view", "^7.0")],
            PluginState::Enabled,
        ));
        let resolution = resolve_import_map(&conflicting, &provided, &versions);
        assert!(resolution.chosen.is_empty());
        // The conflict, plus the per-plugin note that `b`'s `^7.0` cannot be met by the 6.26.3
        // the bundle ships — the check HOST-ABI.md §7.1 step 4 asks for, made against a version
        // rather than against the mere presence of the specifier.
        assert_eq!(resolution.warnings.len(), 2, "{:?}", resolution.warnings);
        assert!(
            resolution.warnings.iter().any(|warning| warning
                .contains("`b` declares `@codemirror/view` ^7.0")
                && warning.contains("6.26.3")),
            "{:?}",
            resolution.warnings
        );
    }

    /// A range the bundle satisfies produces no note; one it does not, does. The install flow
    /// refuses the second outright — this is the boot-time backstop for a plugin adopted from
    /// disk or a bundle rebuilt underneath an installed set.
    #[test]
    fn peer_ranges_are_checked_against_the_version_the_bundle_provides() {
        let provided = BTreeMap::from([(
            "@codemirror/view".to_string(),
            "/assets/codemirror-view-abc123.js".to_string(),
        )]);
        let versions = BTreeMap::from([("@codemirror/view".to_string(), "6.26.3".to_string())]);

        let mut ok = Registry::default();
        ok.plugins.push(installed(
            "editor",
            &[("@codemirror/view", "^6.2")],
            PluginState::Enabled,
        ));
        assert!(
            resolve_import_map(&ok, &provided, &versions)
                .warnings
                .is_empty()
        );

        let mut stale = Registry::default();
        stale.plugins.push(installed(
            "editor",
            &[("@codemirror/view", "^7")],
            PluginState::Enabled,
        ));
        let warnings = resolve_import_map(&stale, &provided, &versions).warnings;
        assert_eq!(warnings.len(), 1, "{warnings:?}");

        // No recorded version ⇒ no claim either way. A bundle built before the manifest
        // carried versions must not start refusing plugins.
        assert!(
            resolve_import_map(&stale, &provided, &BTreeMap::new())
                .warnings
                .is_empty()
        );
    }

    #[test]
    fn a_missing_directory_is_a_problem_not_a_panic() {
        let registry = scan(Path::new("/nonexistent/life-manager/plugins"));
        assert!(registry.plugins().is_empty());
        assert_eq!(registry.problems().len(), 1);
    }

    #[test]
    fn the_base_distribution_is_the_twenty_five_plugins_of_spec_6_5() {
        assert_eq!(BASE_PLUGIN_IDS.len(), 25);
        assert!(BASE_PLUGIN_IDS.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
