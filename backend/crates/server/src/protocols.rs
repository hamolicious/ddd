//! The protocol registry (PLUGIN-PROTOCOLS §3).
//!
//! A protocol package ships inside the plugin that owns it
//! (`<plugin>/protocols/<name>/protocol.json` and `index.d.ts`). The server takes each one
//! into this registry, where it **stays even if that plugin is unplugged or replaced**, so
//! a replacement can speak it too and a client can still type-check wires after the owner
//! is gone.
//!
//! Three rules hold here:
//!
//! - **`id@version` means one thing.** Protocols are stored by `id@version` with a content
//!   hash. A second package bundling the same `id@version` must be byte-identical, or its
//!   install is refused. The owning plugin may overwrite its own protocol without a version
//!   bump, which is what a rebuilt base distribution and a plugin in development do.
//! - **The first install claims a namespace.** On this server, the first installed package
//!   to ship `acme/…` owns `acme/`, and `lm/` is reserved for the base distribution from day
//!   one. Signed publisher keys come later (`dev-docs/todo/PROTOCOL-SIGNING.md`).
//! - **A `needs` key the protocol lacks is refused at install**, when the protocol is known.
//!
//! Storage mirrors the rest of the plugin state: packages are read from the served
//! directory at every scan, copied into Mongo (`protocols`), and served from the union, so
//! a protocol whose owner was uninstalled is still known, and one whose owner is on disk is
//! still known when Mongo is down.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use bson::doc;
use futures::TryStreamExt;
use life_manager_core::wiring::{ProtocolKind, ProtocolPackage, Shape};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::manifest_schema::{is_protocol_id, parse_protocol_ref};
use crate::plugins::{self, PluginManifest};
use crate::state::AppState;

/// Collection `protocols`: one document per `id@version`.
pub const COLLECTION: &str = "protocols";
/// Collection `protocol_namespaces`: `_id` a publisher, `owner` the plugin that claimed it.
pub const NAMESPACES: &str = "protocol_namespaces";
/// The base distribution's publisher.
pub const RESERVED_PUBLISHER: &str = "lm";
/// Where a package keeps its protocol packages.
pub const PROTOCOLS_DIR: &str = "protocols";

/// One protocol package, read from a plugin directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisteredProtocol {
    pub package: ProtocolPackage,
    /// Hex SHA-256 over `protocol.json` then `index.d.ts`.
    pub hash: String,
    /// `index.d.ts`, served at `/protocols/<id>/<version>/index.d.ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<String>,
}

/// The Mongo form.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredProtocol {
    #[serde(rename = "_id")]
    key: String,
    package: ProtocolPackage,
    hash: String,
    #[serde(default)]
    types: Option<String>,
    registered_at: bson::DateTime,
}

fn hash_of(json: &[u8], types: Option<&[u8]>) -> String {
    let mut digest = Sha256::new();
    digest.update(json);
    digest.update([0u8]);
    if let Some(types) = types {
        digest.update(types);
    }
    hex::encode(digest.finalize())
}

/// Is every primitive in `shape` one of the vocabulary's names?
fn shape_is_valid(shape: &Shape) -> bool {
    match shape {
        Shape::Primitive(name) => matches!(
            name.as_str(),
            "string" | "number" | "boolean" | "func" | "promise" | "component" | "any"
        ),
        Shape::Literal { literal } => literal
            .iter()
            .all(|value| value.is_string() || value.is_number() || value.is_boolean()),
        Shape::Union { union } => union.iter().all(shape_is_valid),
        Shape::Array { array } => shape_is_valid(array),
        Shape::Record { record } => shape_is_valid(record),
        Shape::Object { object } => object.values().all(shape_is_valid),
        Shape::Optional { optional } => shape_is_valid(optional),
    }
}

/// Read and check every protocol package in one plugin's directory. Problems are returned
/// with the protocol's path, never fatal: a bad package is left out, not the plugin.
pub fn read_packages(
    plugin_dir: &Path,
    plugin_id: &str,
    base: bool,
) -> (Vec<RegisteredProtocol>, Vec<String>) {
    let mut found = Vec::new();
    let mut problems = Vec::new();
    let Ok(entries) = fs::read_dir(plugin_dir.join(PROTOCOLS_DIR)) else {
        return (found, problems);
    };
    let mut dirs: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    dirs.sort();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        let name = dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let where_ = format!("{plugin_id}/{PROTOCOLS_DIR}/{name}");
        let raw = match fs::read(dir.join("protocol.json")) {
            Ok(raw) => raw,
            Err(err) => {
                problems.push(format!("{where_}: protocol.json: {err}"));
                continue;
            }
        };
        let types = fs::read(dir.join("index.d.ts")).ok();
        match check_package(&raw, &name, plugin_id, base) {
            Ok(package) => found.push(RegisteredProtocol {
                hash: hash_of(&raw, types.as_deref()),
                types: types.map(|bytes| String::from_utf8_lossy(&bytes).to_string()),
                package,
            }),
            Err(message) => problems.push(format!("{where_}: {message}")),
        }
    }
    (found, problems)
}

/// Parse and check one `protocol.json` against where it was found.
pub fn check_package(
    raw: &[u8],
    dir_name: &str,
    plugin_id: &str,
    base: bool,
) -> Result<ProtocolPackage, String> {
    let package: ProtocolPackage =
        serde_json::from_slice(raw).map_err(|err| format!("protocol.json is invalid: {err}"))?;
    if !is_protocol_id(&package.id) {
        return Err(format!("`{}` is not a protocol id", package.id));
    }
    let (publisher, name) = package.id.split_once('/').unwrap_or_default();
    if name != dir_name {
        return Err(format!(
            "`{}` does not match its directory `{dir_name}`",
            package.id
        ));
    }
    if publisher == RESERVED_PUBLISHER && !base {
        return Err(format!(
            "`{}`: the `{RESERVED_PUBLISHER}/` namespace is reserved for the base distribution",
            package.id
        ));
    }
    if !plugins::is_valid_version(&package.version) {
        return Err(format!("`{}` is not a version", package.version));
    }
    if package.owner != plugin_id {
        return Err(format!(
            "`{}` says it is owned by `{}`, but ships in `{plugin_id}`",
            package.id, package.owner
        ));
    }
    if !shape_is_valid(&package.shape) {
        return Err(format!(
            "`{}` has a shape outside the s.* vocabulary",
            package.id
        ));
    }
    if let Some(key) = package.key.as_ref() {
        if package.kind != ProtocolKind::Slot {
            return Err(format!("`{}`: only a slot has a key", package.id));
        }
        let fields = package.shape.fields();
        for field in key.fields() {
            if !fields.is_some_and(|fields| fields.contains_key(field)) {
                return Err(format!("`{}`: key `{field}` is not a field", package.id));
            }
        }
    }
    if package.sticky && package.kind != ProtocolKind::Event {
        return Err(format!("`{}`: only an event is sticky", package.id));
    }
    Ok(package)
}

/// Every protocol the served plugins ship, checked against each other: one `id@version`
/// from two plugins must be byte-identical, and the second, different one is left out.
pub fn from_scan(
    served: &[(String, bool, std::path::PathBuf)],
) -> (
    BTreeMap<String, RegisteredProtocol>,
    Vec<plugins::PluginProblem>,
) {
    let mut registry: BTreeMap<String, RegisteredProtocol> = BTreeMap::new();
    let mut problems = Vec::new();
    for (plugin_id, base, dir) in served {
        let (found, read_problems) = read_packages(dir, plugin_id, *base);
        for message in read_problems {
            problems.push(plugins::PluginProblem {
                path: dir.display().to_string(),
                message,
            });
        }
        for protocol in found {
            let key = protocol.package.key();
            match registry.get(&key) {
                Some(existing) if existing.hash != protocol.hash => {
                    problems.push(plugins::PluginProblem {
                        path: dir.display().to_string(),
                        message: format!(
                            "`{key}` is also shipped by `{}` with different contents; this copy is ignored",
                            existing.package.owner
                        ),
                    });
                }
                Some(_) => {}
                None => {
                    registry.insert(key, protocol);
                }
            }
        }
    }
    (registry, problems)
}

// ---------------------------------------------------------------------------
// Mongo: the registry that outlives its owner, and namespace claims
// ---------------------------------------------------------------------------

async fn stored(state: &AppState) -> Result<Vec<StoredProtocol>, mongodb::error::Error> {
    let documents: Vec<bson::Document> = state
        .collections
        .raw(COLLECTION)
        .find(doc! {})
        .await?
        .try_collect()
        .await?;
    Ok(documents
        .into_iter()
        .filter_map(|document| bson::from_document(document).ok())
        .collect())
}

async fn namespace_owners(
    state: &AppState,
) -> Result<BTreeMap<String, String>, mongodb::error::Error> {
    let documents: Vec<bson::Document> = state
        .collections
        .raw(NAMESPACES)
        .find(doc! {})
        .await?
        .try_collect()
        .await?;
    Ok(documents
        .into_iter()
        .filter_map(|document| {
            Some((
                document.get_str("_id").ok()?.to_string(),
                document.get_str("owner").ok()?.to_string(),
            ))
        })
        .collect())
}

/// Every known protocol: the ones stored in Mongo, with the served directory's on top.
/// Mongo unreachable is the served directory alone.
pub async fn all(state: &AppState) -> BTreeMap<String, RegisteredProtocol> {
    let registry = plugins::registry(&state.config);
    let mut all: BTreeMap<String, RegisteredProtocol> = match stored(state).await {
        Ok(stored) => stored
            .into_iter()
            .map(|entry| {
                (
                    entry.key,
                    RegisteredProtocol {
                        package: entry.package,
                        hash: entry.hash,
                        types: entry.types,
                    },
                )
            })
            .collect(),
        Err(err) => {
            warn!(error = %err, "could not read the protocol registry; serving the scanned packages");
            BTreeMap::new()
        }
    };
    for (key, protocol) in registry.protocols() {
        all.insert(key.clone(), protocol.clone());
    }
    all
}

/// Copy the served directory's protocols into Mongo and claim their namespaces. Called
/// after every scan that can change what is served (boot, and every install-flow action).
/// A protocol that conflicts with a stored one from another owner is left out and logged.
pub async fn register_served(state: &AppState) {
    let registry = plugins::registry(&state.config);
    let owners = match namespace_owners(state).await {
        Ok(owners) => owners,
        Err(err) => {
            warn!(error = %err, "could not read the protocol namespaces; registry not updated");
            return;
        }
    };
    let existing: BTreeMap<String, StoredProtocol> = match stored(state).await {
        Ok(stored) => stored
            .into_iter()
            .map(|entry| (entry.key.clone(), entry))
            .collect(),
        Err(err) => {
            warn!(error = %err, "could not read the protocol registry; registry not updated");
            return;
        }
    };
    for (key, protocol) in registry.protocols() {
        if let Err(message) = admissible(&owners, &existing, protocol) {
            warn!(protocol = %key, %message, "protocol not registered");
            continue;
        }
        if let Err(err) = store(state, protocol).await {
            warn!(protocol = %key, error = %err, "could not store a protocol");
        }
    }
}

/// Whether a package may take `protocol` into the registry: its namespace is unclaimed or
/// its own, and an `id@version` already stored under another owner has the same bytes.
fn admissible(
    owners: &BTreeMap<String, String>,
    existing: &BTreeMap<String, StoredProtocol>,
    protocol: &RegisteredProtocol,
) -> Result<(), String> {
    let package = &protocol.package;
    let publisher = package
        .id
        .split_once('/')
        .map(|(p, _)| p)
        .unwrap_or_default();
    if let Some(owner) = owners.get(publisher)
        && owner != &package.owner
        && publisher != RESERVED_PUBLISHER
    {
        return Err(format!(
            "the `{publisher}/` namespace belongs to `{owner}` on this server"
        ));
    }
    if let Some(stored) = existing.get(&package.key())
        && stored.hash != protocol.hash
        && stored.package.owner != package.owner
    {
        return Err(format!(
            "`{}` is already registered by `{}` with different contents; publish a new version",
            package.key(),
            stored.package.owner
        ));
    }
    Ok(())
}

async fn store(
    state: &AppState,
    protocol: &RegisteredProtocol,
) -> Result<(), mongodb::error::Error> {
    let package = &protocol.package;
    let key = package.key();
    let document = bson::to_document(&StoredProtocol {
        key: key.clone(),
        package: package.clone(),
        hash: protocol.hash.clone(),
        types: protocol.types.clone(),
        registered_at: bson::DateTime::now(),
    })
    .map_err(|err| mongodb::error::Error::custom(err.to_string()))?;
    state
        .collections
        .raw(COLLECTION)
        .replace_one(doc! { "_id": &key }, document)
        .upsert(true)
        .await?;
    let publisher = package
        .id
        .split_once('/')
        .map(|(p, _)| p)
        .unwrap_or_default();
    // The first claim wins: `$setOnInsert` never moves an existing owner.
    state
        .collections
        .raw(NAMESPACES)
        .update_one(
            doc! { "_id": publisher },
            doc! { "$setOnInsert": { "owner": &package.owner, "claimed_at": bson::DateTime::now() } },
        )
        .upsert(true)
        .await?;
    Ok(())
}

/// The install-time checks for a package about to be installed: its own protocols (a
/// claimed namespace, a byte-different `id@version`) and its `consumes` (a `needs` key the
/// protocol lacks). `package_dir` is the extracted package.
pub async fn check_install(
    state: &AppState,
    manifest: &PluginManifest,
    package_dir: &Path,
) -> Result<(), String> {
    let base = plugins::BASE_PLUGIN_IDS.contains(&manifest.id.as_str());
    let (own, problems) = read_packages(package_dir, &manifest.id, base);
    if let Some(problem) = problems.first() {
        return Err(problem.clone());
    }
    let owners = namespace_owners(state)
        .await
        .map_err(|err| err.to_string())?;
    let existing: BTreeMap<String, StoredProtocol> = stored(state)
        .await
        .map_err(|err| err.to_string())?
        .into_iter()
        .map(|entry| (entry.key.clone(), entry))
        .collect();
    for protocol in &own {
        admissible(&owners, &existing, protocol)?;
    }

    // `needs`: checked against the newest known version the range admits.
    let mut known: Vec<ProtocolPackage> =
        all(state).await.into_values().map(|p| p.package).collect();
    known.extend(own.into_iter().map(|p| p.package));
    check_needs(manifest, &known)
}

/// Refuse a consumed port whose `needs` names a key its protocol does not have, when some
/// known version of that protocol is in range. An unknown protocol is not an error here:
/// its provider may simply be installed later, and the resolver reports it until then.
pub fn check_needs(manifest: &PluginManifest, known: &[ProtocolPackage]) -> Result<(), String> {
    for (port, consumed) in &manifest.consumes {
        let Some(needs) = consumed.needs.as_ref() else {
            continue;
        };
        let Some((id, range)) = parse_protocol_ref(&consumed.protocol) else {
            continue;
        };
        let newest = known
            .iter()
            .filter(|package| package.id == id)
            .filter(|package| plugins::satisfies(&package.version, range).unwrap_or(false))
            .max_by(|a, b| plugins::compare_versions(&a.version, &b.version));
        let Some(package) = newest else {
            continue;
        };
        let fields = package.shape.fields();
        let unknown: Vec<&str> = needs
            .iter()
            .filter(|need| !fields.is_some_and(|fields| fields.contains_key(*need)))
            .map(String::as_str)
            .collect();
        if !unknown.is_empty() {
            return Err(format!(
                "`consumes.{port}` needs `{}`, which {} does not have",
                unknown.join("`, `"),
                package.key()
            ));
        }
    }
    Ok(())
}

/// `index.d.ts` of one registered protocol, for `/protocols/<id>/<version>/index.d.ts`.
pub async fn types_of(state: &AppState, id: &str, version: &str) -> Option<String> {
    all(state)
        .await
        .remove(&format!("{id}@{version}"))
        .and_then(|protocol| protocol.types)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/base")
    }

    /// Every protocol package in the source tree, as the scan would read it.
    fn base_protocols() -> Vec<ProtocolPackage> {
        let mut all = Vec::new();
        for entry in fs::read_dir(base_root()).expect("plugins/base").flatten() {
            let id = entry.file_name().to_string_lossy().to_string();
            if id.starts_with('_') || id == "dist" {
                continue;
            }
            let (found, problems) = read_packages(&entry.path(), &id, true);
            assert!(problems.is_empty(), "{id}: {problems:?}");
            all.extend(found.into_iter().map(|protocol| protocol.package));
        }
        all
    }

    #[test]
    fn every_base_protocol_package_is_valid() {
        let all = base_protocols();
        assert_eq!(all.len(), 35, "8 services, 26 slots and 1 event");
        let kinds = |kind| all.iter().filter(|p| p.kind == kind).count();
        assert_eq!(kinds(ProtocolKind::Service), 8);
        assert_eq!(kinds(ProtocolKind::Slot), 26);
        assert_eq!(kinds(ProtocolKind::Event), 1);
    }

    #[test]
    fn every_base_port_names_a_known_protocol_and_real_keys() {
        let known = base_protocols();
        for entry in fs::read_dir(base_root()).expect("plugins/base").flatten() {
            let Ok(raw) = fs::read_to_string(entry.path().join("manifest.json")) else {
                continue;
            };
            let manifest: PluginManifest = serde_json::from_str(&raw).expect("manifest");
            check_needs(&manifest, &known).unwrap_or_else(|err| panic!("{}: {err}", manifest.id));
            let refs = manifest
                .provides
                .values()
                .map(|port| port.protocol.as_str())
                .chain(
                    manifest
                        .consumes
                        .values()
                        .map(|port| port.protocol.as_str()),
                );
            for reference in refs {
                let (id, _) = parse_protocol_ref(reference).expect("a protocol reference");
                assert!(
                    known.iter().any(|package| package.id == id),
                    "{}: {id} is not a base protocol",
                    manifest.id
                );
            }
            let provided: Vec<&String> = manifest.provides.keys().collect();
            for port in manifest.consumes.keys() {
                assert!(
                    !provided.contains(&port),
                    "{}: `{port}` is both provided and consumed",
                    manifest.id
                );
            }
        }
    }

    #[test]
    fn a_package_is_checked_against_where_it_was_found() {
        let raw =
            br#"{ "id": "lm/navbar.item", "version": "1.0.0", "kind": "slot", "owner": "header",
                        "key": "id", "shape": { "object": { "id": "string" } } }"#;
        assert!(check_package(raw, "navbar.item", "header", true).is_ok());
        // `lm/` is the base distribution's.
        assert!(
            check_package(raw, "navbar.item", "header", false)
                .unwrap_err()
                .contains("reserved")
        );
        // The directory is the name, and the owner is the plugin it ships in.
        assert!(check_package(raw, "navbar", "header", true).is_err());
        assert!(
            check_package(raw, "navbar.item", "acme", true)
                .unwrap_err()
                .contains("owned by")
        );
        // A key must be a field; a primitive must be in the vocabulary.
        let bad_key = br#"{ "id": "acme/x", "version": "1.0.0", "kind": "slot", "owner": "acme", "key": "nope", "shape": { "object": {} } }"#;
        assert!(
            check_package(bad_key, "x", "acme", false)
                .unwrap_err()
                .contains("key")
        );
        let bad_shape = br#"{ "id": "acme/x", "version": "1.0.0", "kind": "slot", "owner": "acme", "shape": "date" }"#;
        assert!(check_package(bad_shape, "x", "acme", false).is_err());
    }

    #[test]
    fn a_namespace_and_an_id_at_version_belong_to_their_first_owner() {
        let protocol = |owner: &str, hash: &str| RegisteredProtocol {
            package: serde_json::from_value(serde_json::json!({
                "id": "acme/outline.panel", "version": "1.0.0", "kind": "slot", "owner": owner,
                "shape": { "object": {} }
            }))
            .unwrap(),
            hash: hash.to_string(),
            types: None,
        };
        let owners = BTreeMap::from([("acme".to_string(), "acme-outline".to_string())]);
        let stored = |owner: &str, hash: &str| StoredProtocol {
            key: "acme/outline.panel@1.0.0".to_string(),
            package: protocol(owner, hash).package,
            hash: hash.to_string(),
            types: None,
            registered_at: bson::DateTime::now(),
        };
        let existing = BTreeMap::from([(
            "acme/outline.panel@1.0.0".to_string(),
            stored("acme-outline", "aaa"),
        )]);
        // The owner may overwrite its own protocol (a rebuild, development).
        assert!(admissible(&owners, &existing, &protocol("acme-outline", "bbb")).is_ok());
        // Another plugin may not use a claimed namespace.
        assert!(
            admissible(&owners, &existing, &protocol("impostor", "aaa"))
                .unwrap_err()
                .contains("namespace")
        );
        // Without a claim, the same id@version from another owner must be byte-identical.
        let unclaimed = BTreeMap::new();
        assert!(admissible(&unclaimed, &existing, &protocol("other", "aaa")).is_ok());
        assert!(
            admissible(&unclaimed, &existing, &protocol("other", "bbb"))
                .unwrap_err()
                .contains("different contents")
        );
    }

    #[test]
    fn needs_must_name_real_keys() {
        let router: ProtocolPackage = serde_json::from_value(serde_json::json!({
            "id": "lm/router", "version": "1.0.0", "kind": "service", "owner": "router",
            "shape": { "object": { "navigate": "func", "current": "func" } }
        }))
        .unwrap();
        let manifest = |needs: &[&str]| -> PluginManifest {
            serde_json::from_value(serde_json::json!({
                "id": "demo", "version": "1.0.0", "kernel": "^2.0",
                "consumes": { "router": { "protocol": "lm/router@^1.0", "needs": needs } }
            }))
            .unwrap()
        };
        assert!(check_needs(&manifest(&["navigate"]), std::slice::from_ref(&router)).is_ok());
        let refused = check_needs(&manifest(&["navigate", "teleport"]), &[router]).unwrap_err();
        assert!(refused.contains("teleport"), "{refused}");
        // An unknown protocol is not refused: its provider may come later.
        assert!(check_needs(&manifest(&["teleport"]), &[]).is_ok());
    }
}
