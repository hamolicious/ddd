//! The wiring store (PLUGIN-PROTOCOLS §6, §9 step 2): versioned `wiring.json` in Mongo
//! beside the plugin records, cached on disk, broadcast on change.
//!
//! **Every change is a version.** Apply, rollback, install, upgrade, uninstall, approval
//! and a circuit-breaker trip each write version N+1 and send the same `wiring.applied`
//! frame on the sync socket, so a connected client has one thing to listen for and an
//! offline one catches up from `welcome.wiring_version` when it reconnects.
//!
//! **Unplug is disable.** `PluginState` stays the gate the server, the circuit breaker and
//! backend halves use. `unplugged` mirrors it: every install-flow action that moves a
//! record in or out of `disabled` rewrites `unplugged` from the records
//! ([`mirror_plugin_states`]), and an Apply that plugs or unplugs moves the records.
//!
//! **Mongo down is not wiring gone.** The last version this process saw is kept in memory
//! and on disk (`<PLUGIN_STAGING_DIR>/wiring.json`), so the plugin list is still served
//! with its wiring when Mongo is unreachable, the same way the directory scan keeps serving
//! the last approved plugin set.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use bson::doc;
use futures::TryStreamExt;
use life_manager_core::wiring::Wiring;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::domain::{Actor, AuditEntry};
use crate::plugins::PluginState;
use crate::state::AppState;

/// Collection `wiring`: one document per version, `_id` the version number.
pub const WIRING_COLLECTION: &str = "wiring";

/// The cache file's name inside `PLUGIN_STAGING_DIR`.
pub const CACHE_FILE: &str = "wiring.json";

/// The live wiring: a version and its overrides. Serialized flat, as `wiring.json` is
/// written (`{ "version": 13, "unplugged": [...], ... }`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveWiring {
    pub version: i64,
    #[serde(flatten)]
    pub wiring: Wiring,
}

/// One stored version, for history and rollback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WiringRecord {
    #[serde(rename = "_id")]
    pub version: i64,
    pub wiring: Wiring,
    /// `apply`, `rollback`, `install`, `upgrade`, `uninstall`, `approve`, `enable`,
    /// `disable`, `breaker`.
    pub action: String,
    /// `actor.as_stored()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// The plugin an install-flow action was about, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub at: bson::DateTime,
}

/// A version as the history list shows it: everything but the wiring itself.
#[derive(Debug, Clone, Serialize)]
pub struct WiringVersionInfo {
    pub version: i64,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// RFC 3339.
    pub at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum WiringError {
    /// The draft was based on a version that is no longer live.
    #[error("the wiring is at version {live}, not {base}; reload it and apply again")]
    Conflict { base: i64, live: i64 },
    #[error(transparent)]
    Db(#[from] mongodb::error::Error),
    #[error("wiring could not be stored: {0}")]
    Bson(String),
}

/// What a commit writes.
pub struct Commit<'a> {
    /// The version the change was prepared against. `None` for install-flow actions,
    /// which always apply on top of whatever is live.
    pub base: Option<i64>,
    pub wiring: Wiring,
    pub action: &'a str,
    pub actor: &'a Actor,
    pub subject: Option<&'a str>,
}

// ---------------------------------------------------------------------------
// The cache: memory first, then disk
// ---------------------------------------------------------------------------

/// Per staging directory, like the registry is per plugins directory: one server process
/// has one, and a test binary has one per fixture.
static CACHE: OnceLock<RwLock<BTreeMap<PathBuf, LiveWiring>>> = OnceLock::new();

fn cache() -> &'static RwLock<BTreeMap<PathBuf, LiveWiring>> {
    CACHE.get_or_init(|| RwLock::new(BTreeMap::new()))
}

fn cache_path(state: &AppState) -> PathBuf {
    state.config.plugin_staging_dir.join(CACHE_FILE)
}

fn remember(state: &AppState, live: &LiveWiring) {
    cache()
        .write()
        .expect("wiring cache poisoned")
        .insert(state.config.plugin_staging_dir.clone(), live.clone());
    let path = cache_path(state);
    let write = || -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, serde_json::to_vec_pretty(live).unwrap_or_default())?;
        std::fs::rename(&temp, &path)
    };
    if let Err(err) = write() {
        warn!(path = %path.display(), error = %err, "could not write the wiring cache");
    }
}

fn from_disk(state: &AppState) -> Option<LiveWiring> {
    let raw = std::fs::read(cache_path(state)).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// The live wiring without touching Mongo: memory, then the disk cache, then version 0.
///
/// What the plugin list and `welcome` read. [`load`] at boot and every [`commit`] keep the
/// memory copy current, so this is the live version in a running server.
pub fn current(state: &AppState) -> LiveWiring {
    if let Some(live) = cache()
        .read()
        .expect("wiring cache poisoned")
        .get(&state.config.plugin_staging_dir)
    {
        return live.clone();
    }
    from_disk(state).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

fn collection(state: &AppState) -> mongodb::Collection<bson::Document> {
    state.collections.raw(WIRING_COLLECTION)
}

async fn newest(state: &AppState) -> Result<Option<WiringRecord>, WiringError> {
    let found = collection(state)
        .find_one(doc! {})
        .sort(doc! { "_id": -1 })
        .await?;
    found
        .map(|document| {
            bson::from_document(document).map_err(|err| WiringError::Bson(err.to_string()))
        })
        .transpose()
}

/// Read the live wiring from Mongo and refresh the caches. On a fresh workspace (no
/// version yet) the answer is version 0, with `unplugged` mirrored from the plugin records.
///
/// Mongo unreachable falls back to the caches: the wiring is not lost because the database
/// is.
pub async fn load(state: &AppState) -> LiveWiring {
    match newest(state).await {
        Ok(Some(record)) => {
            let live = LiveWiring {
                version: record.version,
                wiring: record.wiring,
            };
            remember(state, &live);
            live
        }
        Ok(None) => {
            let live = LiveWiring {
                version: 0,
                wiring: Wiring {
                    unplugged: disabled_ids(state).await.unwrap_or_default(),
                    ..Wiring::default()
                }
                .normalized(),
            };
            remember(state, &live);
            live
        }
        Err(err) => {
            warn!(error = %err, "could not read the wiring; serving the cached version");
            current(state)
        }
    }
}

/// Every stored version, newest first, without their wirings.
pub async fn history(state: &AppState, limit: i64) -> Result<Vec<WiringVersionInfo>, WiringError> {
    let records: Vec<bson::Document> = collection(state)
        .find(doc! {})
        .sort(doc! { "_id": -1 })
        .limit(limit)
        .await?
        .try_collect()
        .await?;
    records
        .into_iter()
        .map(|document| {
            let record: WiringRecord =
                bson::from_document(document).map_err(|err| WiringError::Bson(err.to_string()))?;
            Ok(WiringVersionInfo {
                version: record.version,
                action: record.action,
                actor: record.actor,
                subject: record.subject,
                at: record.at.try_to_rfc3339_string().unwrap_or_default(),
            })
        })
        .collect()
}

/// One stored version, for rollback.
pub async fn version(state: &AppState, version: i64) -> Result<Option<WiringRecord>, WiringError> {
    let found = collection(state).find_one(doc! { "_id": version }).await?;
    found
        .map(|document| {
            bson::from_document(document).map_err(|err| WiringError::Bson(err.to_string()))
        })
        .transpose()
}

/// One writer at a time, in this process. Mongo's unique `_id` is what makes two
/// processes safe; this keeps one process from racing itself into a pointless conflict.
fn writer() -> &'static tokio::sync::Mutex<()> {
    static WRITER: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    WRITER.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Write version N+1, audit it, cache it and broadcast `wiring.applied`.
///
/// Refused with [`WiringError::Conflict`] when `base` is given and is not the live
/// version: a draft prepared against N is not applied on top of N+1 (§6c).
pub async fn commit(state: &AppState, commit: Commit<'_>) -> Result<LiveWiring, WiringError> {
    let action = commit.action;
    let applied = commit_quietly(state, commit).await?;
    publish(state, &applied, action);
    Ok(applied)
}

/// [`commit`] without the broadcast: the version is written, audited and cached, and the
/// caller sends the frame with [`publish`] once everything that goes with the version is
/// in place. The wiring apply route moves the plugin records first, because a client
/// answers the frame by fetching the plugin list, and a list that still shows a plugged
/// plugin as `disabled` makes it plan "start nothing".
pub async fn commit_quietly(
    state: &AppState,
    commit: Commit<'_>,
) -> Result<LiveWiring, WiringError> {
    let _guard = writer().lock().await;
    let live = match newest(state).await? {
        Some(record) => record.version,
        None => 0,
    };
    if let Some(base) = commit.base
        && base != live
    {
        return Err(WiringError::Conflict { base, live });
    }
    let next = live + 1;
    let wiring = commit.wiring.normalized();
    let record = WiringRecord {
        version: next,
        wiring: wiring.clone(),
        action: commit.action.to_string(),
        actor: Some(commit.actor.as_stored()),
        subject: commit.subject.map(str::to_string),
        at: bson::DateTime::now(),
    };
    let document = bson::to_document(&record).map_err(|err| WiringError::Bson(err.to_string()))?;
    match collection(state).insert_one(document).await {
        Ok(_) => {}
        // Another process took N+1 between our read and our write.
        Err(err) if is_duplicate_key(&err) => {
            return Err(WiringError::Conflict {
                base: commit.base.unwrap_or(live),
                live: next,
            });
        }
        Err(err) => return Err(err.into()),
    }

    let applied = LiveWiring {
        version: next,
        wiring,
    };
    remember(state, &applied);
    state
        .audit(
            AuditEntry::new(
                format!("wiring.{}", commit.action),
                Some(commit.actor),
                "wiring",
                Some(next.to_string()),
            )
            .with_detail(doc! {
                "version": next,
                "base": live,
                "subject": commit.subject,
            }),
        )
        .await;
    Ok(applied)
}

/// Send `wiring.applied` for a version written with [`commit_quietly`].
pub fn publish(state: &AppState, live: &LiveWiring, action: &str) {
    let sockets = crate::routes::sync::publish_wiring_applied(state, live.version, action);
    info!(version = live.version, action, sockets, "wiring applied");
}

fn is_duplicate_key(err: &mongodb::error::Error) -> bool {
    matches!(
        err.kind.as_ref(),
        mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(write))
            if write.code == 11000
    )
}

// ---------------------------------------------------------------------------
// Mirroring plugin state
// ---------------------------------------------------------------------------

async fn disabled_ids(state: &AppState) -> Result<Vec<String>, crate::plugininstall::InstallError> {
    let mut ids: Vec<String> = crate::plugininstall::records(state)
        .await?
        .into_iter()
        .filter(|record| record.state == PluginState::Disabled)
        .map(|record| record.id)
        .collect();
    ids.sort();
    Ok(ids)
}

/// Write a version after an install-flow action: `unplugged` rewritten from the plugin
/// records, and — when `uninstalled` — every entry naming the plugin dropped.
///
/// Never fails the action it follows: the records are the gate and they are already
/// written. A wiring that could not be stored is logged, and the next change writes a
/// version that is right again, because `unplugged` is always recomputed.
pub async fn mirror_plugin_states(
    state: &AppState,
    action: &str,
    actor: &Actor,
    subject: &str,
    uninstalled: bool,
) {
    let disabled = match disabled_ids(state).await {
        Ok(ids) => ids,
        Err(err) => {
            warn!(error = %err, action, plugin = subject, "could not read the plugin records; wiring not versioned");
            return;
        }
    };
    let mut wiring = load(state).await.wiring;
    if uninstalled {
        wiring.drop_plugin(subject);
    }
    wiring.unplugged = disabled;
    if let Err(err) = commit(
        state,
        Commit {
            base: None,
            wiring,
            action,
            actor,
            subject: Some(subject),
        },
    )
    .await
    {
        warn!(error = %err, action, plugin = subject, "could not write a wiring version");
    }
}

// ---------------------------------------------------------------------------
// Resolution: what the loader activates from (PLUGIN-PROTOCOLS §6)
// ---------------------------------------------------------------------------

/// The live wiring resolved for a page: normal boots and `?safe=1` boots.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedSet {
    pub normal: life_manager_core::wiring::Resolution,
    pub safe: life_manager_core::wiring::Resolution,
}

/// What the resolver needs from one served plugin.
pub fn descriptor(
    plugin: &crate::plugins::InstalledPlugin,
) -> life_manager_core::wiring::PluginDescriptor {
    use life_manager_core::wiring as core;
    let manifest = &plugin.manifest;
    core::PluginDescriptor {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        base: plugin.base,
        enabled: plugin.state == PluginState::Enabled,
        hot: manifest.hot,
        frontend: manifest.frontend.is_some(),
        provides: manifest
            .provides
            .iter()
            .map(|(name, port)| {
                (
                    name.clone(),
                    core::ProvidedPort {
                        protocol: port.protocol.clone(),
                        order: port.order,
                    },
                )
            })
            .collect(),
        consumes: manifest
            .consumes
            .iter()
            .map(|(name, port)| {
                (
                    name.clone(),
                    core::ConsumedPort {
                        protocol: port.protocol.clone(),
                        needs: port.needs.clone(),
                        optional: port.optional,
                        seats: port.seats,
                    },
                )
            })
            .collect(),
    }
}

/// Resolve the served plugin set against `live`, natively: the loader reads the result,
/// so boot never needs the Wasm core (§6).
pub fn resolve_served(
    registry: &crate::plugins::Registry,
    protocols: Vec<life_manager_core::wiring::ProtocolPackage>,
    live: &LiveWiring,
) -> ResolvedSet {
    use life_manager_core::wiring as core;
    let input = core::ResolveInput {
        plugins: registry.plugins().iter().map(descriptor).collect(),
        protocols,
        wiring: live.wiring.clone(),
        base_only: false,
    };
    let normal = core::resolve(&input);
    let safe = core::resolve(&core::ResolveInput {
        base_only: true,
        ..input
    });
    ResolvedSet { normal, safe }
}
