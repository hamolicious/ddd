use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::Config;

pub const BASE_PLUGIN_IDS: &[&str] = &[
    "admin",
    "attachments",
    "auto-fm",
    "calendar",
    "changes",
    "commands",
    "context-menu",
    "db-health",
    "doc-events",
    "doc-list",
    "document-surface",
    "editor",
    "emoji",
    "fm-autocomplete",
    "folder-style",
    "folders",
    "graph",
    "icons",
    "indexer",
    "kanban",
    "local-folder",
    "markdown",
    "native-preview",
    "notices",
    "router",
    "search",
    "settings",
    "shell-ui",
    "slash-commands",
    "sync-status",
    "syntax-highlight",
    "table",
    "themes",
    "timeline",
    "toolbar",
    "viewer",
    "welcome",
    "wikilinks",
];

pub const KERNEL_VERSION: &str = crate::manifest_types::KERNEL_VERSION;

pub use crate::manifest_types::{
    BackendExport, ConfigField, HttpCapability, PluginBackend, PluginCapabilities, PluginFrontend,
    PluginManifest,
};

pub use crate::load::{
    LoadPlan, SkipReason, Skipped, effective_ids, fingerprint, module_url, plugin_imports,
    resolve_load,
};

pub const HOOK_NAMES: &[&str] = &["document.created", "document.changed", "document.deleted"];

pub const ROUTE_METHODS: &[&str] = &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

pub const DOCUMENT_RIGHTS: &[&str] = &["read", "write"];

pub fn is_valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    id.len() <= 64 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn is_valid_version(version: &str) -> bool {
    if version.is_empty() || version.len() > 128 {
        return false;
    }

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
    pub fn has_backend(&self) -> bool {
        self.backend.is_some()
    }

    pub fn cron(&self) -> &[String] {
        self.backend
            .as_ref()
            .map(|backend| backend.cron.as_slice())
            .unwrap_or_default()
    }

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

    pub fn to_abi(&self) -> ddd_plugin_abi::Capabilities {
        ddd_plugin_abi::Capabilities {
            documents: self.documents.clone(),
            http_hosts: self.http_hosts(),
            public_routes: self.public_routes.clone(),
            notifications: self.notifications,
        }
    }

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteSpec {
    pub method: String,
    pub path: String,
    pub public: bool,
}

impl RouteSpec {
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

pub fn route_specs(manifest: &PluginManifest) -> Result<Vec<RouteSpec>, String> {
    route_specs_with_public(manifest, &manifest.capabilities.public_routes)
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginState {
    Pending,
    Enabled,
    Disabled,
    Failed,
}

impl PluginState {
    pub fn is_served(self) -> bool {
        matches!(
            self,
            PluginState::Enabled | PluginState::Disabled | PluginState::Failed
        )
    }

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRecord {
    #[serde(rename = "_id")]
    pub id: String,
    pub version: String,
    pub state: PluginState,
    pub manifest: PluginManifest,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cron_state: Vec<crate::pluginhost::cron::CronState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginKvEntry {
    #[serde(rename = "_id")]
    pub id: String,
    pub plugin_id: String,
    pub key: String,
    pub value: bson::Bson,
    pub updated_at: crate::domain::Timestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfigEntry {
    #[serde(rename = "_id")]
    pub plugin_id: String,
    pub values: bson::Document,
    pub updated_at: crate::domain::Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Resolution {
    pub peer_versions: BTreeMap<String, String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResolveError {
    #[error(
        "`{library}` is required as {ranges} by different plugins, with no version satisfying all of them"
    )]
    PeerConflict { library: String, ranges: String },
}

pub fn resolve(manifests: &[PluginManifest]) -> Result<Resolution, ResolveError> {
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
        '^' => {
            if floor[0] > 0 {
                actual[0] == floor[0]
            } else if floor[1] > 0 || written >= 2 {
                actual[0] == 0 && actual[1] == floor[1]
            } else {
                actual[0] == 0
            }
        }
        '~' => {
            if written >= 2 {
                actual[0] == floor[0] && actual[1] == floor[1]
            } else {
                actual[0] == floor[0]
            }
        }
        _ => match written {
            1 => actual[0] == floor[0],
            2 => actual[0] == floor[0] && actual[1] == floor[1],
            _ => actual == floor,
        },
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub base_url: String,
    pub state: PluginState,
    pub base: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
}

pub fn replaced_reason(by: &str) -> String {
    format!("{REPLACED_BY_PREFIX}`{by}`")
}

pub const REPLACED_BY_PREFIX: &str = "replaced by ";

pub fn disabled_on_purpose(reason: Option<&str>) -> bool {
    match reason {
        None => true,
        Some(reason) => {
            reason == crate::routes::plugin_api::ADMIN_DISABLE_REASON
                || reason == crate::plugininstall::ABSENT_DISABLED_REASON
                || reason.starts_with(REPLACED_BY_PREFIX)
        }
    }
}

impl InstalledPlugin {
    pub fn wants_load(&self) -> bool {
        match self.state {
            PluginState::Enabled | PluginState::Failed => true,
            PluginState::Disabled => !disabled_on_purpose(self.disabled_reason.as_deref()),
            PluginState::Pending => false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginProblem {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct Registry {
    plugins: Vec<InstalledPlugin>,
    problems: Vec<PluginProblem>,
    root: Option<PathBuf>,
}

impl Registry {
    pub fn plugins(&self) -> &[InstalledPlugin] {
        &self.plugins
    }

    pub fn problems(&self) -> &[PluginProblem] {
        &self.problems
    }

    pub fn load_plan(&self) -> LoadPlan {
        resolve_load(&self.plugins)
    }

    pub fn plugin_imports(&self) -> BTreeMap<String, String> {
        plugin_imports(&self.plugins, &self.load_plan())
    }

    pub fn plugins_version(&self) -> String {
        fingerprint(&self.plugins, &self.load_plan())
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    pub fn get(&self, id: &str, version: &str) -> Option<&InstalledPlugin> {
        self.plugins
            .iter()
            .find(|plugin| plugin.manifest.id == id && plugin.manifest.version == version)
    }

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

    pub fn apply_states(&mut self, records: &[PluginRecord]) {
        for plugin in &mut self.plugins {
            let Some(record) = records
                .iter()
                .find(|record| record.id == plugin.manifest.id)
            else {
                continue;
            };
            if record.version != plugin.manifest.version {
                warn!(
                    plugin = %plugin.manifest.id,
                    on_disk = %plugin.manifest.version,
                    recorded = %record.version,
                    "the plugin record names a different version than the served directory"
                );
                continue;
            }
            plugin.state = record.state;
            plugin.disabled_reason = match record.state {
                PluginState::Disabled => record.disabled_reason.clone(),
                _ => None,
            };
        }
    }

    pub fn manifests(&self) -> Vec<PluginManifest> {
        self.plugins
            .iter()
            .map(|plugin| plugin.manifest.clone())
            .collect()
    }

    pub fn loaded_manifests(&self) -> Vec<PluginManifest> {
        self.plugins
            .iter()
            .filter(|plugin| plugin.state.is_active())
            .map(|plugin| plugin.manifest.clone())
            .collect()
    }

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

pub fn scan(dir: &Path) -> Registry {
    let mut registry = Registry {
        root: Some(dir.to_path_buf()),
        ..Registry::default()
    };

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            registry.problems.push(PluginProblem {
                path: dir.display().to_string(),
                message: format!("cannot read the plugins directory: {err}"),
            });
            return registry;
        }
    };

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
        let assets_version = frontend_assets_version(&dir.join(&id).join(&version), &manifest);
        registry.plugins.push(InstalledPlugin {
            base_url: format!("/plugins/{id}/{version}/"),
            base: BASE_PLUGIN_IDS.contains(&id.as_str()),
            state: PluginState::Enabled,
            manifest,
            assets_version,
            disabled_reason: None,
        });
    }
    registry
        .plugins
        .sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    registry
}

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

fn is_frontend_asset(path: &str) -> bool {
    let mut segments = path.split('/').filter(|segment| !segment.is_empty());
    segments.next() == Some("frontend") && segments.next().is_some()
}

pub fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && !path
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
}

#[derive(Debug, Clone, Default)]
pub struct PeerResolution {
    pub imports: BTreeMap<String, String>,
    pub chosen: BTreeMap<String, String>,
    pub missing: Vec<String>,
    pub warnings: Vec<String>,
}

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

static REGISTRY: OnceLock<RwLock<BTreeMap<PathBuf, Arc<Registry>>>> = OnceLock::new();

fn cell() -> &'static RwLock<BTreeMap<PathBuf, Arc<Registry>>> {
    REGISTRY.get_or_init(|| RwLock::new(BTreeMap::new()))
}

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

pub fn reload(config: &Config) -> Arc<Registry> {
    reload_with_records(config, &[])
}

pub fn reload_with_records(config: &Config, records: &[PluginRecord]) -> Arc<Registry> {
    if config.disable_plugins {
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

    fn installed(id: &str, peers: &[(&str, &str)], state: PluginState) -> InstalledPlugin {
        let peer_libraries: serde_json::Map<String, serde_json::Value> = peers
            .iter()
            .map(|(library, range)| ((*library).to_string(), serde_json::json!(range)))
            .collect();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "id": id,
            "version": "1.0.0",
            "kernel": "^3.0",
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
            disabled_reason: None,
        }
    }

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
        assert!(
            resolution
                .missing
                .iter()
                .any(|entry| entry.starts_with("@lezer/highlight")),
            "{:?}",
            resolution.missing
        );
        assert!(!resolution.chosen.contains_key("@lezer/highlight"));

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
        assert_eq!(resolution.warnings.len(), 2, "{:?}", resolution.warnings);
        assert!(
            resolution.warnings.iter().any(|warning| warning
                .contains("`b` declares `@codemirror/view` ^7.0")
                && warning.contains("6.26.3")),
            "{:?}",
            resolution.warnings
        );
    }

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

        assert!(
            resolve_import_map(&stale, &provided, &BTreeMap::new())
                .warnings
                .is_empty()
        );
    }

    #[test]
    fn a_missing_directory_is_a_problem_not_a_panic() {
        let registry = scan(Path::new("/nonexistent/ddd/plugins"));
        assert!(registry.plugins().is_empty());
        assert_eq!(registry.problems().len(), 1);
    }

    #[test]
    fn the_base_distribution_is_the_thirty_seven_plugins_of_spec_6_5() {
        assert_eq!(BASE_PLUGIN_IDS.len(), 38);
        assert!(BASE_PLUGIN_IDS.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
