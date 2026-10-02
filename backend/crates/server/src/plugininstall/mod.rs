pub mod config;
pub mod queue;
pub mod watcher;
pub mod zipcheck;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ddd_plugin_abi as abi;
use mongodb::Collection;
use tracing::{info, warn};

use crate::db;
use crate::domain::{Actor, AuditEntry, Timestamp, new_id};
use crate::error::AppError;
use crate::plugins::{
    self, HOOK_NAMES, KERNEL_VERSION, PluginCapabilities, PluginManifest, PluginRecord, PluginState,
};
use crate::state::AppState;

pub const WORK_SUBDIR: &str = "work";
pub const PENDING_SUBDIR: &str = "pending";
const PURGE_PAGE: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallSource {
    Upload { filename: String },
    Directory { path: String },
    Base,
}

impl InstallSource {
    pub fn label(&self) -> String {
        match self {
            InstallSource::Upload { filename } => format!("upload {filename}"),
            InstallSource::Directory { path } => format!("drop {path}"),
            InstallSource::Base => "base distribution".to_string(),
        }
    }
}

pub struct InstallRequest {
    pub source: InstallSource,
    pub archive: PathBuf,
    pub actor: Actor,
    pub auto_approve: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InstallOutcome {
    pub id: String,
    pub version: String,
    pub state: PluginState,
    pub capabilities: PluginCapabilities,
    pub replaced: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error(transparent)]
    Package(#[from] zipcheck::ZipError),
    #[error("the manifest is not valid: {0}")]
    Manifest(String),
    #[error("plugin `{id}` needs kernel {required}, this server is {current}")]
    KernelIncompatible {
        id: String,
        required: String,
        current: String,
    },
    #[error("unsatisfiable peer library: {0}")]
    PeerLibrary(String),
    #[error("{0}")]
    Dependency(String),
    #[error("{id} {version} is already installed")]
    AlreadyInstalled { id: String, version: String },
    #[error("another install is in progress")]
    Locked,
    #[error("install failed and was rolled back: {0}")]
    RolledBack(String),
    #[error("plugin `{id}` is not installed")]
    NotInstalled { id: String },
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Config(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Db(#[from] mongodb::error::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<InstallError> for crate::error::AppError {
    fn from(error: InstallError) -> Self {
        match error {
            InstallError::Package(err) => AppError::BadRequest(err.to_string()),
            InstallError::Manifest(message) => {
                AppError::BadRequest(format!("the manifest is not valid: {message}"))
            }
            InstallError::KernelIncompatible { .. }
            | InstallError::PeerLibrary(_)
            | InstallError::Dependency(_) => AppError::Unprocessable(error.to_string()),
            InstallError::AlreadyInstalled { .. } | InstallError::Conflict(_) => {
                AppError::Conflict(error.to_string())
            }
            InstallError::NotInstalled { .. } => AppError::NotFound("plugin"),
            InstallError::Config(message) => AppError::BadRequest(message),
            InstallError::Locked => AppError::TooManyRequests {
                retry_after_secs: queue::LOCK_WAIT.as_secs().max(1),
            },
            InstallError::RolledBack(message) => AppError::Unavailable(format!(
                "the install was rolled back and nothing changed: {message}"
            )),
            InstallError::Io(err) => AppError::Internal(err.into()),
            InstallError::Db(err) => AppError::Db(err),
            InstallError::Internal(err) => AppError::Internal(err),
        }
    }
}

pub async fn install(
    state: &AppState,
    request: InstallRequest,
) -> Result<InstallOutcome, InstallError> {
    let holder = format!("{} · {}", request.source.label(), request.actor.as_stored());
    let outcome = queue::queued(state, &holder, async || {
        install_locked(state, &request).await
    })
    .await;

    if outcome.is_ok()
        && matches!(request.source, InstallSource::Upload { .. })
        && let Err(err) = fs::remove_file(&request.archive)
    {
        warn!(
            path = %request.archive.display(), error = %err,
            "could not remove an uploaded package after installing it"
        );
    }
    outcome
}

async fn install_locked(
    state: &AppState,
    request: &InstallRequest,
) -> Result<InstallOutcome, InstallError> {
    let manifest = zipcheck::read_manifest(&request.archive)?;
    let id = manifest.id.clone();
    let version = manifest.version.clone();

    let warnings = validate_manifest(state, &manifest, None)?;

    if request.source != InstallSource::Base {
        let registry = plugins::registry(&state.config);
        check_dependencies(&manifest, registry.plugins()).map_err(InstallError::Dependency)?;
    }

    let existing = record(state, &id).await?;
    let replaced = existing
        .as_ref()
        .filter(|record| record.version != version)
        .map(|record| record.version.clone());
    if installed_dir(&state.config, &id, &version).is_dir() {
        return Err(InstallError::AlreadyInstalled { id, version });
    }

    let work = staging_dir(&state.config)
        .join(WORK_SUBDIR)
        .join(&id)
        .join(format!("{version}.{}", new_id()));
    let _ = fs::remove_dir_all(&work);

    let extracted = match zipcheck::extract(&request.archive, &work, &manifest) {
        Ok(extracted) => extracted,
        Err(err) => {
            let _ = fs::remove_dir_all(&work);
            return Err(err.into());
        }
    };

    let outcome = stage_and_record(
        state,
        request,
        &manifest,
        extracted,
        existing.as_ref(),
        replaced,
        warnings,
    )
    .await;
    let _ = fs::remove_dir_all(&work);
    if outcome.is_err() {
        rollback(state, &id, &version, existing.as_ref()).await;
    }
    outcome
}

async fn rollback(state: &AppState, id: &str, version: &str, previous: Option<&PluginRecord>) {
    let _ = fs::remove_dir_all(pending_dir(&state.config, id, version));
    let restored = match previous {
        Some(previous) => save_record(state, previous).await,
        None => match record(state, id).await {
            Ok(Some(current))
                if current.state == PluginState::Pending && current.version == version =>
            {
                delete_record(state, id).await
            }
            Ok(_) => Ok(()),
            Err(err) => Err(err),
        },
    };
    if let Err(err) = restored {
        warn!(
            plugin = %id, version = %version, error = %err,
            "could not roll the plugin record back after a failed install"
        );
    }
    refresh_registry(state).await;
}

async fn stage_and_record(
    state: &AppState,
    request: &InstallRequest,
    manifest: &PluginManifest,
    extracted: zipcheck::ExtractedPackage,
    previous: Option<&PluginRecord>,
    replaced: Option<String>,
    warnings: Vec<String>,
) -> Result<InstallOutcome, InstallError> {
    let id = manifest.id.clone();
    let version = manifest.version.clone();

    if let Some(wasm) = extracted.backend_wasm.as_ref() {
        check_backend_module(manifest, wasm)?;
    }

    let pending = pending_dir(&state.config, &id, &version);
    if let Some(parent) = pending.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_dir_all(&pending);
    fs::rename(&extracted.dir, &pending).map_err(|err| {
        InstallError::RolledBack(format!(
            "could not move the package into {}: {err} — is PLUGIN_STAGING_DIR on the same filesystem as PLUGINS_DIR?",
            pending.display()
        ))
    })?;

    let record = PluginRecord {
        id: id.clone(),
        version: version.clone(),
        state: PluginState::Pending,
        manifest: manifest.clone(),
        capabilities_approved: previous
            .map(|previous| previous.capabilities_approved.clone())
            .unwrap_or_default(),
        source: request.source.clone(),
        installed_at: Timestamp::now(),
        installed_by: request.actor.user_id().map(|id| id.to_string()),
        approved_at: previous.and_then(|previous| previous.approved_at),
        approved_by: previous.and_then(|previous| previous.approved_by.clone()),
        disabled_reason: None,
        last_error: None,
        module_sha256: extracted.backend_sha256.clone(),
        cron_state: previous
            .map(|previous| previous.cron_state.clone())
            .unwrap_or_default(),
    };
    save_record(state, &record).await?;

    state
        .audit(
            AuditEntry::new(
                "plugin.install",
                Some(&request.actor),
                "plugin",
                Some(id.clone()),
            )
            .with_detail(bson::doc! {
                "version": &version,
                "source": request.source.label(),
                "entries": extracted.entries as i64,
                "bytes": extracted.uncompressed_bytes as i64,
                "backend": manifest.has_backend(),
                "replaced": replaced.clone(),
            }),
        )
        .await;
    info!(
        plugin = %id, version = %version, source = %request.source.label(),
        "plugin installed as pending"
    );

    let mut state_after = PluginState::Pending;
    if request.auto_approve {
        if request.source == InstallSource::Base {
            let approved = approve_locked(
                state,
                &id,
                &version,
                manifest.capabilities.clone(),
                &request.actor,
            )
            .await?;
            state_after = approved.state;
        } else {
            warn!(
                plugin = %id,
                "auto_approve is only legal for the base distribution; the package stays pending"
            );
        }
    } else {
        refresh_registry(state).await;
    }

    Ok(InstallOutcome {
        id,
        version,
        state: state_after,
        capabilities: manifest.capabilities.clone(),
        replaced,
        warnings,
    })
}

pub async fn approve(
    state: &AppState,
    id: &str,
    version: &str,
    capabilities: PluginCapabilities,
    actor: &Actor,
) -> Result<PluginRecord, InstallError> {
    let record = queue::queued(state, &format!("approve {id} {version}"), async || {
        approve_locked(state, id, version, capabilities, actor).await
    })
    .await?;
    Ok(record)
}

async fn approve_locked(
    state: &AppState,
    id: &str,
    version: &str,
    capabilities: PluginCapabilities,
    actor: &Actor,
) -> Result<PluginRecord, InstallError> {
    let mut record = require_record(state, id).await?;
    if record.version != version {
        return Err(InstallError::Conflict(format!(
            "`{id}` {} is installed, not {version}",
            record.version
        )));
    }
    if record.state != PluginState::Pending {
        return Err(InstallError::Conflict(format!(
            "`{id}` is already approved (state `{}`)",
            record.state.as_str()
        )));
    }

    record
        .manifest
        .capabilities
        .approval_is_legal(&capabilities)
        .map_err(InstallError::Config)?;

    let pending = pending_dir(&state.config, id, version);
    let installed = installed_dir(&state.config, id, version);
    match (pending.is_dir(), installed.is_dir()) {
        (true, _) => {
            if let Some(parent) = installed.parent() {
                fs::create_dir_all(parent)?;
            }
            let _ = fs::remove_dir_all(&installed);
            fs::rename(&pending, &installed).map_err(|err| {
                InstallError::RolledBack(format!(
                    "could not move the package into {}: {err}",
                    installed.display()
                ))
            })?;
            if let Some(parent) = pending.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
        (false, true) => {
            warn!(
                plugin = %id, version = %version,
                "the package is already in the plugins directory but its record still says \
                 pending — completing an interrupted approval"
            );
        }
        (false, false) => {
            return Err(InstallError::RolledBack(format!(
                "the pending package for `{id}` {version} is no longer in {}",
                pending.display()
            )));
        }
    }
    prune_other_versions(&state.config, id, version);

    record.state = PluginState::Enabled;
    record.capabilities_approved = capabilities.clone();
    record.approved_at = Some(Timestamp::now());
    record.approved_by = actor.user_id().map(|id| id.to_string());
    record.disabled_reason = None;
    record.last_error = None;
    save_record(state, &record).await?;
    disable_provides_partners(state, &record, actor).await?;

    state
        .audit(
            AuditEntry::new(
                "plugin.approve",
                Some(actor),
                "plugin",
                Some(id.to_string()),
            )
            .with_detail(bson::doc! {
                "version": version,
                "capabilities": bson::to_bson(&capabilities)
                    .unwrap_or(bson::Bson::Null),
                "requested": bson::to_bson(&record.manifest.capabilities)
                    .unwrap_or(bson::Bson::Null),
            }),
        )
        .await;
    info!(plugin = %id, version = %version, "plugin approved");

    refresh_registry(state).await;
    Ok(activate(state, record).await)
}

pub async fn reject(
    state: &AppState,
    id: &str,
    version: &str,
    actor: &Actor,
) -> Result<(), InstallError> {
    queue::queued(state, &format!("reject {id} {version}"), async || {
        let record = require_record(state, id).await?;
        if record.state != PluginState::Pending {
            return Err(InstallError::Conflict(format!(
                "`{id}` is not pending (state `{}`); uninstall it instead",
                record.state.as_str()
            )));
        }
        let _ = fs::remove_dir_all(pending_dir(&state.config, id, version));
        let _ = fs::remove_dir(staging_dir(&state.config).join(PENDING_SUBDIR).join(id));
        let installed = installed_dir(&state.config, id, version);
        if installed.is_dir() {
            warn!(
                plugin = %id, version = %version, path = %installed.display(),
                "removing a rejected package from the plugins directory — an approval had been \
                 interrupted after its rename"
            );
            let _ = fs::remove_dir_all(&installed);
            let _ = fs::remove_dir(state.config.plugins_dir.join(id));
        }
        delete_record(state, id).await?;
        refresh_registry(state).await;

        state
            .audit(
                AuditEntry::new("plugin.reject", Some(actor), "plugin", Some(id.to_string()))
                    .with_detail(bson::doc! { "version": version }),
            )
            .await;
        info!(plugin = %id, version = %version, "pending plugin rejected");
        Ok(())
    })
    .await
}

pub async fn disable(
    state: &AppState,
    id: &str,
    reason: &str,
    actor: &Actor,
) -> Result<(), InstallError> {
    disable_record(state, id, reason, actor).await
}

pub async fn disable_record(
    state: &AppState,
    id: &str,
    reason: &str,
    actor: &Actor,
) -> Result<(), InstallError> {
    let mut record = require_record(state, id).await?;
    if record.state == PluginState::Pending {
        return Err(InstallError::Conflict(format!(
            "`{id}` is pending approval; reject it instead of disabling it"
        )));
    }

    deactivate(state, &record).await;
    record.state = PluginState::Disabled;
    record.disabled_reason = Some(reason.to_string());
    save_record(state, &record).await?;

    state
        .audit(
            AuditEntry::new(
                "plugin.disable",
                Some(actor),
                "plugin",
                Some(id.to_string()),
            )
            .with_detail(bson::doc! { "reason": reason }),
        )
        .await;
    info!(plugin = %id, reason = %reason, "plugin disabled");
    refresh_registry(state).await;
    Ok(())
}

pub async fn enable(state: &AppState, id: &str, actor: &Actor) -> Result<(), InstallError> {
    enable_record(state, id, actor).await
}

pub async fn enable_record(state: &AppState, id: &str, actor: &Actor) -> Result<(), InstallError> {
    let mut record = require_record(state, id).await?;
    if record.state == PluginState::Pending {
        return Err(InstallError::Conflict(format!(
            "`{id}` is pending approval; approve it instead of enabling it"
        )));
    }

    record.state = PluginState::Enabled;
    record.disabled_reason = None;
    record.last_error = None;
    save_record(state, &record).await?;
    disable_provides_partners(state, &record, actor).await?;

    state
        .audit(AuditEntry::new(
            "plugin.enable",
            Some(actor),
            "plugin",
            Some(id.to_string()),
        ))
        .await;
    info!(plugin = %id, "plugin enabled");

    refresh_registry(state).await;
    if record.manifest.has_backend() {
        let host = crate::pluginhost::PluginHost::get(state);
        host.reset_breaker(id);
    }
    let _ = activate(state, record).await;
    Ok(())
}

pub async fn uninstall(
    state: &AppState,
    id: &str,
    purge: bool,
    actor: &Actor,
) -> Result<(), InstallError> {
    let actor = actor.clone();
    queue::queued(state, &format!("uninstall {id}"), async || {
        let record = record(state, id).await?;
        if record.is_none() && !state.config.plugins_dir.join(id).exists() {
            return Err(InstallError::NotInstalled { id: id.to_string() });
        }

        if let Some(record) = record.as_ref() {
            deactivate(state, record).await;
        }
        crate::pluginhost::PluginHost::get(state).forget(id);

        let _ = fs::remove_dir_all(state.config.plugins_dir.join(id));
        let _ = fs::remove_dir_all(staging_dir(&state.config).join(PENDING_SUBDIR).join(id));
        delete_record(state, id).await?;
        refresh_registry(state).await;

        state
            .audit(
                AuditEntry::new(
                    "plugin.uninstall",
                    Some(&actor),
                    "plugin",
                    Some(id.to_string()),
                )
                .with_detail(bson::doc! {
                    "version": record.as_ref().map(|record| record.version.clone()),
                    "purge": purge,
                }),
            )
            .await;
        info!(plugin = %id, purge, "plugin uninstalled");

        if purge {
            let kv = state
                .collections
                .raw(db::PLUGIN_KV)
                .delete_many(bson::doc! { "plugin_id": id })
                .await?;
            let config = config::purge(state, id).await?;
            state
                .audit(
                    AuditEntry::new(
                        "plugin.purge",
                        Some(&actor),
                        "plugin",
                        Some(id.to_string()),
                    )
                    .with_detail(bson::doc! {
                        "kv_keys": kv.deleted_count as i64,
                        "config_rows": config as i64,
                    }),
                )
                .await;

            let spawned = state.clone();
            let plugin_id = id.to_string();
            tokio::spawn(async move {
                match purge_sections(&spawned, &plugin_id).await {
                    Ok(count) => info!(
                        plugin = %plugin_id, documents = count,
                        "stripped a plugin's machine sections"
                    ),
                    Err(err) => warn!(
                        plugin = %plugin_id, error = %err,
                        "stripping a plugin's machine sections failed; re-run the purge to finish it"
                    ),
                }
            });
        }
        Ok(())
    })
    .await
}

pub async fn purge_sections(state: &AppState, plugin_id: &str) -> Result<u64, InstallError> {
    let filter = bson::doc! { format!("plugins.{plugin_id}"): { "$exists": true } };
    let mut stripped = 0u64;

    loop {
        let query = crate::docstore::ListQuery {
            filter: Some(filter.clone()),
            sort: None,
            search: None,
            cursor: None,
            limit: PURGE_PAGE,
            trash: crate::docstore::TrashFilter::All,
            metadata_only: true,
        };
        let page = state
            .docs
            .list(&query)
            .await
            .map_err(|err| InstallError::Internal(anyhow::anyhow!(err)))?;
        if page.documents.is_empty() {
            return Ok(stripped);
        }

        let mut progressed = 0u64;
        for row in &page.documents {
            match strip_one(state, &row.id, plugin_id).await {
                Ok(true) => {
                    stripped += 1;
                    progressed += 1;
                }
                Ok(false) => {}
                Err(err) => warn!(
                    document = %row.id, plugin = %plugin_id, error = %err,
                    "could not strip a plugin section from a document"
                ),
            }
        }

        if progressed == 0 {
            warn!(
                plugin = %plugin_id, remaining = page.documents.len(),
                "the section purge made no progress on a page; re-run it to finish"
            );
            return Ok(stripped);
        }
    }
}

async fn strip_one(
    state: &AppState,
    document_id: &str,
    plugin_id: &str,
) -> Result<bool, InstallError> {
    let removed = std::sync::atomic::AtomicBool::new(false);
    let compute = |text: &str| -> Result<Vec<ddd_core::splice::TextEdit>, String> {
        let edits = ddd_core::splice::remove_section(text, plugin_id).map_err(|err| {
            format!("the `%%% {plugin_id}` section cannot be removed cleanly: {err}")
        })?;
        removed.store(!edits.is_empty(), std::sync::atomic::Ordering::Relaxed);
        Ok(edits)
    };
    state
        .docs
        .splice(document_id, &compute, &Actor::System)
        .await
        .map_err(|err| InstallError::Internal(anyhow::anyhow!(err)))?;
    Ok(removed.load(std::sync::atomic::Ordering::Relaxed))
}

pub async fn records(state: &AppState) -> Result<Vec<PluginRecord>, InstallError> {
    let mut cursor = plugin_records(state).find(bson::doc! {}).await?;
    let mut out = Vec::new();
    while cursor.advance().await? {
        match cursor.deserialize_current() {
            Ok(record) => out.push(record),
            Err(err) => warn!(error = %err, "a plugin record is unreadable"),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub async fn record(state: &AppState, id: &str) -> Result<Option<PluginRecord>, InstallError> {
    Ok(plugin_records(state)
        .find_one(bson::doc! { "_id": id })
        .await?)
}

async fn require_record(state: &AppState, id: &str) -> Result<PluginRecord, InstallError> {
    record(state, id)
        .await?
        .ok_or_else(|| InstallError::NotInstalled { id: id.to_string() })
}

async fn save_record(state: &AppState, record: &PluginRecord) -> Result<(), InstallError> {
    plugin_records(state)
        .replace_one(bson::doc! { "_id": &record.id }, record)
        .upsert(true)
        .await?;
    Ok(())
}

async fn delete_record(state: &AppState, id: &str) -> Result<(), InstallError> {
    plugin_records(state)
        .delete_one(bson::doc! { "_id": id })
        .await?;
    Ok(())
}

fn plugin_records(state: &AppState) -> Collection<PluginRecord> {
    state.db.collection::<PluginRecord>(db::PLUGINS)
}

fn unwind_interrupted_approvals(
    state: &AppState,
    records: &BTreeMap<String, PluginRecord>,
) -> usize {
    let mut moved = 0usize;
    for record in records.values() {
        if record.state != PluginState::Pending {
            continue;
        }
        let installed = installed_dir(&state.config, &record.id, &record.version);
        if !installed.is_dir() {
            continue;
        }
        let pending = pending_dir(&state.config, &record.id, &record.version);
        if pending.is_dir() {
            warn!(
                plugin = %record.id, version = %record.version,
                "a pending package is in both the staging and the plugins directory; \
                 removing the served copy"
            );
            if let Err(err) = fs::remove_dir_all(&installed) {
                warn!(plugin = %record.id, error = %err, "could not remove it");
                continue;
            }
        } else {
            if let Some(parent) = pending.parent()
                && let Err(err) = fs::create_dir_all(parent)
            {
                warn!(
                    plugin = %record.id, error = %err,
                    "could not prepare the pending directory for an interrupted approval"
                );
                continue;
            }
            if let Err(err) = fs::rename(&installed, &pending) {
                warn!(
                    plugin = %record.id, version = %record.version, error = %err,
                    path = %installed.display(),
                    "could not move an interrupted approval back to the pending directory; \
                     it stays unserved, approve it again or remove the directory by hand"
                );
                continue;
            }
            warn!(
                plugin = %record.id, version = %record.version,
                "an approval was interrupted after its rename; the package is pending again \
                 and needs approving"
            );
        }
        let _ = fs::remove_dir(state.config.plugins_dir.join(&record.id));
        moved += 1;
    }
    moved
}

pub async fn adopt_installed_directory(state: &AppState) -> Result<usize, InstallError> {
    if state.config.disable_plugins {
        return Ok(0);
    }
    let known: BTreeMap<String, PluginRecord> = records(state)
        .await?
        .into_iter()
        .map(|record| (record.id.clone(), record))
        .collect();
    let unwound = unwind_interrupted_approvals(state, &known);
    let registry = plugins::reload(&state.config);
    if unwound > 0 {
        info!(
            packages = unwound,
            "moved interrupted approvals back to the pending directory"
        );
    }

    let mut adopted = 0usize;
    for installed in registry.plugins() {
        let manifest = &installed.manifest;
        if let Some(existing) = known.get(&manifest.id) {
            if existing.version == manifest.version && !marked_absent(existing) {
                continue;
            }
            if existing.version != manifest.version {
                warn!(
                    plugin = %manifest.id, on_disk = %manifest.version,
                    recorded = %existing.version,
                    "correcting a plugin record to the version on disk"
                );
            }
        }

        let module_sha256 = manifest.backend.as_ref().and_then(|backend| {
            let path =
                installed_dir(&state.config, &manifest.id, &manifest.version).join(&backend.module);
            zipcheck::sha256_file(&path).ok()
        });
        let previous = known.get(&manifest.id);
        let returning = previous.is_some_and(marked_absent);
        if returning {
            info!(
                plugin = %manifest.id, version = %manifest.version,
                "a plugin whose package had gone missing is back; re-enabling it with the \
                 capabilities it was already approved for"
            );
        }
        if previous.is_some_and(|record| {
            record.state.is_served() && record.capabilities_approved != manifest.capabilities
        }) {
            warn!(
                plugin = %manifest.id, version = %manifest.version,
                "the manifest on disk does not ask for what this plugin is approved for; \
                 the approved set stands and host calls outside it are refused \
                 (uninstall without --purge and reinstall to be asked again)"
            );
        }
        let record = PluginRecord {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            state: match previous {
                None => PluginState::Enabled,
                Some(_) if returning => PluginState::Enabled,
                Some(record) => record.state,
            },
            manifest: manifest.clone(),
            capabilities_approved: previous
                .map(|record| record.capabilities_approved.clone())
                .unwrap_or_else(|| manifest.capabilities.clone()),
            source: previous
                .map(|record| record.source.clone())
                .unwrap_or(InstallSource::Base),
            installed_at: previous
                .map(|record| record.installed_at)
                .unwrap_or_else(Timestamp::now),
            installed_by: previous.and_then(|record| record.installed_by.clone()),
            approved_at: previous
                .and_then(|record| record.approved_at)
                .or_else(|| Some(Timestamp::now())),
            approved_by: previous.and_then(|record| record.approved_by.clone()),
            disabled_reason: if returning {
                None
            } else {
                previous.and_then(|record| record.disabled_reason.clone())
            },
            last_error: None,
            module_sha256,
            cron_state: previous
                .map(|record| record.cron_state.clone())
                .unwrap_or_default(),
        };
        save_record(state, &record).await?;
        adopted += 1;
    }

    retire_absent_records(state, &known, &registry).await;

    refresh_registry(state).await;
    Ok(adopted)
}

pub const ABSENT_DISABLED_REASON: &str = "the package is no longer in PLUGINS_DIR";

fn marked_absent(record: &PluginRecord) -> bool {
    record.state == PluginState::Disabled
        && record.disabled_reason.as_deref() == Some(ABSENT_DISABLED_REASON)
}

fn has_pending_package(staging_pending: &Path, id: &str) -> bool {
    fs::read_dir(staging_pending.join(id)).is_ok_and(|mut entries| entries.next().is_some())
}

async fn retire_absent_records(
    state: &AppState,
    known: &BTreeMap<String, PluginRecord>,
    registry: &Arc<plugins::Registry>,
) -> usize {
    if registry.plugins().is_empty() {
        if !known.is_empty() {
            warn!(
                records = known.len(),
                dir = %state.config.plugins_dir.display(),
                "no plugins found on disk; keeping every plugin record untouched \
                 (an unreadable or unmounted PLUGINS_DIR is not an uninstall)"
            );
        }
        return 0;
    }

    let staging_pending = staging_dir(&state.config).join(PENDING_SUBDIR);
    let mut retired = 0usize;
    for record in known.values() {
        if state.config.plugins_dir.join(&record.id).exists() {
            continue;
        }
        if has_pending_package(&staging_pending, &record.id) {
            continue;
        }
        if record.state == PluginState::Disabled {
            continue;
        }

        deactivate(state, record).await;
        crate::pluginhost::PluginHost::get(state).forget(&record.id);

        let pending = record.state == PluginState::Pending;
        let outcome = if pending {
            delete_record(state, &record.id).await
        } else {
            let mut retired = record.clone();
            retired.state = PluginState::Disabled;
            retired.disabled_reason = Some(ABSENT_DISABLED_REASON.to_string());
            save_record(state, &retired).await
        };
        if let Err(err) = outcome {
            warn!(plugin = %record.id, error = %err, "could not retire an absent plugin");
            continue;
        }

        state
            .audit(
                AuditEntry::new(
                    "plugin.absent",
                    Some(&Actor::System),
                    "plugin",
                    Some(record.id.clone()),
                )
                .with_detail(bson::doc! {
                    "version": record.version.clone(),
                    "state": record.state.as_str(),
                    "outcome": if pending { "record deleted" } else { "disabled" },
                    "retained": "kv, config, %%% sections",
                }),
            )
            .await;
        crate::routes::plugin_api::note(
            &record.id,
            "warn",
            if pending {
                "the pending package is no longer on disk; the record was removed"
            } else {
                "the package is no longer on disk; the plugin was disabled, keeping its \
                 approved capabilities, its KV, its config and its in-document sections"
            },
        );
        warn!(
            plugin = %record.id, version = %record.version, was = %record.state.as_str(),
            "a plugin's package is gone from PLUGINS_DIR; \
             {} (KV, config and `%%%` sections kept — uninstall with ?purge=true to drop them)",
            if pending { "removing its pending record" } else { "disabling it" }
        );
        retired += 1;
    }
    retired
}

pub async fn refresh_registry(state: &AppState) -> Arc<plugins::Registry> {
    let records = match records(state).await {
        Ok(records) => records,
        Err(err) => {
            warn!(error = %err, "could not read the plugin records; serving the directory as-is");
            Vec::new()
        }
    };
    let registry = plugins::reload_with_records(&state.config, &records);
    let version = registry.plugins_version();
    if announce(&state.config.plugins_dir, &version) {
        let sockets = crate::routes::sync::publish_plugins_changed(state, &version);
        info!(%version, sockets, "plugin set changed");
    }
    registry
}

fn announce(dir: &Path, version: &str) -> bool {
    use std::sync::{Mutex, OnceLock};
    static LAST: OnceLock<Mutex<BTreeMap<std::path::PathBuf, String>>> = OnceLock::new();
    let mut last = LAST
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .expect("plugin version cell poisoned");
    match last.insert(dir.to_path_buf(), version.to_string()) {
        Some(previous) => previous != version,
        None => false,
    }
}

pub fn check_dependencies(
    manifest: &PluginManifest,
    installed: &[plugins::InstalledPlugin],
) -> Result<(), String> {
    let mut unmet = Vec::new();
    for (dependency, range) in &manifest.dependencies {
        if dependency == &manifest.id {
            unmet.push(format!("`{dependency}` is this plugin itself"));
            continue;
        }
        let versions: Vec<(String, String)> = installed
            .iter()
            .filter(|plugin| plugin.manifest.id != manifest.id)
            .flat_map(|plugin| {
                plugins::effective_ids(&plugin.manifest)
                    .into_iter()
                    .filter(|(id, _)| id == dependency)
                    .map(|(_, version)| (plugin.manifest.id.clone(), version))
                    .collect::<Vec<_>>()
            })
            .collect();
        if versions.is_empty() {
            unmet.push(format!("`{dependency}` {range} is not installed"));
            continue;
        }
        let fits = versions
            .iter()
            .any(|(_, version)| matches!(plugins::satisfies(version, range), Ok(true)));
        if !fits {
            let have: Vec<String> = versions
                .iter()
                .map(|(holder, version)| {
                    if holder == dependency {
                        version.clone()
                    } else {
                        format!("{version} (provided by `{holder}`)")
                    }
                })
                .collect();
            unmet.push(format!(
                "`{dependency}` {range} is needed, but {} is installed",
                have.join(" / ")
            ));
        }
    }
    if unmet.is_empty() {
        Ok(())
    } else {
        Err(format!("unmet dependencies: {}", unmet.join("; ")))
    }
}

async fn disable_provides_partners(
    state: &AppState,
    record: &PluginRecord,
    actor: &Actor,
) -> Result<(), InstallError> {
    let mine: Vec<String> = plugins::effective_ids(&record.manifest)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    for other in records(state).await? {
        if other.id == record.id
            || other.state == PluginState::Pending
            || (other.state == PluginState::Disabled
                && plugins::disabled_on_purpose(other.disabled_reason.as_deref()))
        {
            continue;
        }
        let clashes = plugins::effective_ids(&other.manifest)
            .iter()
            .any(|(id, _)| mine.contains(id));
        if clashes {
            info!(
                plugin = %other.id, by = %record.id,
                "disabling a plugin whose id the newly enabled one also answers to"
            );
            disable_record(
                state,
                &other.id,
                &plugins::replaced_reason(&record.id),
                actor,
            )
            .await?;
        }
    }
    Ok(())
}

async fn activate(state: &AppState, mut record: PluginRecord) -> PluginRecord {
    if !record.manifest.has_backend() || !record.state.is_active() {
        return record;
    }
    let host = crate::pluginhost::PluginHost::get(state);
    match host.activate(state, &record).await {
        Ok(_) => record,
        Err(err) => {
            warn!(plugin = %record.id, error = %err, "plugin backend not activated");
            record.state = PluginState::Failed;
            record.last_error = Some(err.to_string());
            if let Err(err) = save_record(state, &record).await {
                warn!(plugin = %record.id, error = %err, "could not record an activation failure");
            }
            refresh_registry(state).await;
            record
        }
    }
}

async fn deactivate(state: &AppState, record: &PluginRecord) {
    if !record.manifest.has_backend() {
        return;
    }
    let host = crate::pluginhost::PluginHost::get(state);
    if let Err(err) = host.deactivate(&record.id).await {
        warn!(plugin = %record.id, error = %err, "deactivating a plugin's backend half failed");
    }
}

pub fn staging_dir(config: &crate::config::Config) -> PathBuf {
    config.plugin_staging_dir.clone()
}

pub fn pending_dir(config: &crate::config::Config, id: &str, version: &str) -> PathBuf {
    staging_dir(config)
        .join(PENDING_SUBDIR)
        .join(id)
        .join(version)
}

pub fn installed_dir(config: &crate::config::Config, id: &str, version: &str) -> PathBuf {
    config.plugins_dir.join(id).join(version)
}

fn prune_other_versions(config: &crate::config::Config, id: &str, keep: &str) {
    let root = config.plugins_dir.join(id);
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == keep {
            continue;
        }
        if entry.path().is_dir() {
            match fs::remove_dir_all(entry.path()) {
                Ok(()) => {
                    info!(plugin = %id, version = %name, "removed a superseded plugin version")
                }
                Err(err) => warn!(
                    plugin = %id, version = %name, error = %err,
                    "could not remove a superseded plugin version"
                ),
            }
        }
    }
}

pub fn validate_manifest(
    state: &AppState,
    manifest: &PluginManifest,
    wasm: Option<&Path>,
) -> Result<Vec<String>, InstallError> {
    let mut warnings = Vec::new();

    if !plugins::is_valid_plugin_id(&manifest.id) {
        return Err(InstallError::Manifest(format!(
            "`{}` is not a valid plugin id (^[a-z0-9][a-z0-9-]{{0,63}}$)",
            manifest.id
        )));
    }
    if !plugins::is_valid_version(&manifest.version) {
        return Err(InstallError::Manifest(format!(
            "`{}` is not a version (x.y.z)",
            manifest.version
        )));
    }

    match plugins::satisfies(KERNEL_VERSION, &manifest.kernel) {
        Ok(true) => {}
        Ok(false) => {
            return Err(InstallError::KernelIncompatible {
                id: manifest.id.clone(),
                required: manifest.kernel.clone(),
                current: KERNEL_VERSION.to_string(),
            });
        }
        Err(err) => {
            return Err(InstallError::Manifest(format!(
                "`kernel` is not a supported range: {err}"
            )));
        }
    }

    let routes = plugins::route_specs(manifest).map_err(InstallError::Manifest)?;
    manifest
        .capabilities
        .validate(&routes)
        .map_err(InstallError::Manifest)?;

    if let Some(backend) = manifest.backend.as_ref() {
        if !plugins::safe_relative_path(&backend.module) {
            return Err(InstallError::Manifest(format!(
                "`backend.module` `{}` is not a safe relative path",
                backend.module
            )));
        }
        if backend.module == zipcheck::MANIFEST_ENTRY {
            return Err(InstallError::Manifest(
                "`backend.module` may not be manifest.json".to_string(),
            ));
        }
        for hook in &backend.hooks {
            if !HOOK_NAMES.contains(&hook.as_str()) {
                return Err(InstallError::Manifest(format!(
                    "`{hook}` is not a hook this server delivers ({HOOK_NAMES:?})"
                )));
            }
        }
        for expression in &backend.cron {
            crate::pluginhost::cron::CronSchedule::parse(expression)
                .map_err(|err| InstallError::Manifest(format!("cron `{expression}`: {err}")))?;
        }
        for event in &backend.events {
            let Some((emitter, name)) = event.split_once(':') else {
                return Err(InstallError::Manifest(format!(
                    "`backend.events` entry `{event}` is not namespaced (`<plugin>:<event>`)"
                )));
            };
            if !plugins::is_valid_plugin_id(emitter) || name.is_empty() {
                return Err(InstallError::Manifest(format!(
                    "`backend.events` entry `{event}` is not `<plugin-id>:<event>`"
                )));
            }
            if emitter == manifest.id {
                warnings.push(format!(
                    "`{event}` is this plugin's own event; the host never delivers an event back to its emitter"
                ));
            }
        }
    } else if !manifest.capabilities.public_routes.is_empty() {
        return Err(InstallError::Manifest(
            "`public-routes` needs a `backend` half to serve them".to_string(),
        ));
    }

    if manifest.frontend.is_none() && manifest.backend.is_none() {
        return Err(InstallError::Manifest(
            "the package has neither a frontend nor a backend half".to_string(),
        ));
    }
    if let Some(frontend) = manifest.frontend.as_ref() {
        for path in std::iter::once(&frontend.module).chain(frontend.style.iter()) {
            if !plugins::safe_relative_path(path) {
                return Err(InstallError::Manifest(format!(
                    "`{path}` is not a safe relative path"
                )));
            }
            if !path.starts_with(zipcheck::FRONTEND_PREFIX) {
                return Err(InstallError::Manifest(format!(
                    "`{path}` is not under `frontend/`; only that directory is served"
                )));
            }
        }
    }

    for (key, field) in &manifest.config {
        if !ddd_core::limits::is_valid_key(key) {
            return Err(InstallError::Manifest(format!(
                "`config` key `{key}` is not a valid key name"
            )));
        }
        if !matches!(
            field.kind.as_str(),
            "string" | "number" | "boolean" | "select"
        ) {
            return Err(InstallError::Manifest(format!(
                "`config.{key}.type` `{}` is not one of string/number/boolean/select",
                field.kind
            )));
        }
        if field.kind == "select" && field.options.is_empty() {
            return Err(InstallError::Manifest(format!(
                "`config.{key}` is a select with no options"
            )));
        }
        if field.secret && field.default.is_some() {
            return Err(InstallError::Manifest(format!(
                "`config.{key}` is a secret with a default; a credential does not belong in a manifest"
            )));
        }
    }

    let mut manifests: Vec<PluginManifest> = plugins::registry(&state.config)
        .loaded_manifests()
        .into_iter()
        .filter(|installed| installed.id != manifest.id)
        .collect();
    manifests.push(manifest.clone());
    let resolution =
        plugins::resolve(&manifests).map_err(|err| InstallError::PeerLibrary(err.to_string()))?;
    warnings.extend(resolution.warnings.iter().cloned());

    let provided = crate::routes::statics::runtime_imports(state);
    let provided_versions = crate::routes::statics::runtime_versions(state);
    for (library, range) in &manifest.peer_libraries {
        if !provided.contains_key(library) {
            if provided.is_empty() {
                warnings.push(format!(
                    "`{library}` cannot be checked: this server serves no runtime bundle, so the import map is empty"
                ));
            } else {
                return Err(InstallError::PeerLibrary(format!(
                    "`{library}` is not part of the blessed runtime layer this server serves"
                )));
            }
            continue;
        }
        let Some(version) = provided_versions.get(library) else {
            warnings.push(format!(
                "`{library}` {range} cannot be checked against a version: the runtime bundle \
                 records none for it"
            ));
            continue;
        };
        match plugins::satisfies(version, range) {
            Ok(true) => {}
            Ok(false) => {
                return Err(InstallError::PeerLibrary(format!(
                    "`{library}` {range} is not satisfied by the {version} this server's runtime \
                     layer provides"
                )));
            }
            Err(err) => {
                return Err(InstallError::PeerLibrary(format!(
                    "`peerLibraries.{library}` is not a supported range: {err}"
                )));
            }
        }
    }
    if let Some(path) = wasm {
        check_backend_module(manifest, path)?;
    }

    Ok(warnings)
}

fn check_backend_module(manifest: &PluginManifest, wasm: &Path) -> Result<(), InstallError> {
    if manifest.backend.is_none() {
        return Ok(());
    }
    match zipcheck::wasm_exports(wasm, abi::names::ABI_VERSION) {
        Ok(true) => Ok(()),
        Ok(false) => Err(InstallError::Manifest(format!(
            "`{}` does not export `{}`; a backend half built with the SDK declares it with `ddd::abi_version!()`",
            manifest
                .backend
                .as_ref()
                .map(|backend| backend.module.as_str())
                .unwrap_or_default(),
            abi::names::ABI_VERSION
        ))),
        Err(err) => Err(InstallError::Io(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed(manifest: serde_json::Value) -> plugins::InstalledPlugin {
        let manifest: PluginManifest = serde_json::from_value(manifest).expect("a manifest");
        plugins::InstalledPlugin {
            base_url: format!("/plugins/{}/{}/", manifest.id, manifest.version),
            base: false,
            state: PluginState::Enabled,
            manifest,
            assets_version: None,
            disabled_reason: None,
        }
    }

    fn needing(dependencies: serde_json::Value) -> PluginManifest {
        serde_json::from_value(serde_json::json!({
            "id": "needy", "version": "1.0.0", "kernel": "^3.0",
            "dependencies": dependencies,
            "optionalDependencies": { "absent": "*" },
        }))
        .expect("a manifest")
    }

    #[test]
    fn only_a_new_fingerprint_is_announced() {
        let dir = Path::new("/nonexistent/announce-test");
        assert!(
            !announce(dir, "a"),
            "the first fingerprint a process sees is not a change"
        );
        assert!(!announce(dir, "a"), "a refresh that changed nothing");
        assert!(announce(dir, "b"));
        assert!(!announce(dir, "b"));
    }

    #[test]
    fn install_needs_every_required_dependency_in_range() {
        let set = vec![
            installed(serde_json::json!({ "id": "folders", "version": "2.1.0", "kernel": "^3.0" })),
            installed(serde_json::json!({
                "id": "alt-editor", "version": "0.1.0", "kernel": "^3.0", "provides": "editor@3.2.0"
            })),
        ];
        assert!(check_dependencies(&needing(serde_json::json!({})), &set).is_ok());
        assert!(
            check_dependencies(&needing(serde_json::json!({ "folders": "^2.0" })), &set).is_ok()
        );
        assert!(
            check_dependencies(&needing(serde_json::json!({ "editor": "^3.1" })), &set).is_ok()
        );

        let missing =
            check_dependencies(&needing(serde_json::json!({ "graph": "*" })), &set).unwrap_err();
        assert!(missing.contains("`graph` * is not installed"), "{missing}");

        let old = check_dependencies(&needing(serde_json::json!({ "folders": "^1.0" })), &set)
            .unwrap_err();
        assert!(old.contains("2.1.0"), "{old}");

        let stand_in = check_dependencies(&needing(serde_json::json!({ "editor": "^4.0" })), &set)
            .unwrap_err();
        assert!(stand_in.contains("provided by `alt-editor`"), "{stand_in}");

        let own =
            check_dependencies(&needing(serde_json::json!({ "needy": "*" })), &set).unwrap_err();
        assert!(own.contains("itself"), "{own}");
    }
}
