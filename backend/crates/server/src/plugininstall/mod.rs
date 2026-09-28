//! Installing, approving and removing plugins (SPEC §6.2).
//!
//! # Both paths land in the same place
//!
//! An admin upload and a directory drop are the same pipeline, and both land as
//! **pending**:
//!
//! ```text
//! .zip ──▶ manifest read first ──▶ validate (id, version, kernel, deps, peers)
//!      ──▶ extract into  <staging>/work/<id>/<version>   (hardened)
//!      ──▶ rename to     <staging>/pending/<id>/<version>
//!      ──▶ record { state: pending, capabilities: as requested }
//!                         │
//!            admin sees the capability list, clicks approve
//!                         ▼
//!      rename to <PLUGINS_DIR>/<id>/<version>   ← the moment it becomes servable
//!      record { state: enabled, capabilities: as approved } ──▶ host activates
//! ```
//!
//! **A pending package never sits in `PLUGINS_DIR`.** That is deliberate and it is what
//! makes "pending installs cannot be fetched before an admin approves them" structural
//! rather than a check somebody could forget: the static route serves the registry, the
//! registry is a scan of `PLUGINS_DIR`, and approval *is* the rename into it. Staging lives
//! next to the served root (`PLUGIN_STAGING_DIR`, default `<PLUGINS_DIR>.staging`) so the
//! rename is atomic and same-filesystem — a cross-device move is a copy, and a copy can be
//! interrupted half-way.
//!
//! **Activation is an explicit admin click, always.** Installing a plugin runs its
//! frontend code unsandboxed in every user's session (SPEC §6.1) — the capability list is
//! about the *server* half, and the approval screen says so in those words.
//!
//! # Zip handling is hostile-input handling
//!
//! The manifest is read and validated **before** anything is extracted, so a package that
//! is not for this server never touches the filesystem. Then: no absolute paths, no `..`,
//! no symlinks, no entries outside `frontend/**` plus the declared wasm, caps on
//! uncompressed size, entry count and per-entry size (a zip bomb is 42 KB), extract to a
//! staging directory on the *same filesystem*, and an atomic rename at the end. A partial
//! install rolls back the rename and leaves the previous version serving.
//!
//! # Serialized
//!
//! Installs go through a Mongo-held lock ([`queue`]) so two admins uploading at once
//! cannot interleave a rename with a rollback. Single-replica today (SPEC §8), but the
//! lock is also what makes the watcher and an upload safe against each other.
//!
//! # What state lives where
//!
//! | Where | What | Uninstall keeps it? |
//! |---|---|---|
//! | `<PLUGINS_DIR>/<id>/<version>/` | the served artifacts | no |
//! | `<staging>/pending/<id>/<version>/` | an unapproved package | no |
//! | `plugins` (Mongo) | the approval record | no |
//! | `plugin_kv` | the plugin's own key/value state | **yes**, unless purged |
//! | `plugin_config` | admin-entered configuration and secrets | **yes**, unless purged |
//! | `%%% <id>` sections in documents | machine data inside documents | **yes**, unless purged |
//!
//! Retention is the default because a lossless reinstall is worth more than a tidy
//! database: a plugin removed to try a replacement and put back finds its state where it
//! left it (SPEC §6.2).
//!
//! **A plugin can also leave without anyone calling `uninstall`** — an image that stops
//! shipping it, a directory an operator emptied. [`adopt_installed_directory`] reconciles
//! that at boot: the record is retired and the table above applies unchanged, so the data
//! survives and a reinstall is still lossless. See [`prune_absent_records`] for the two
//! cases that deliberately do *not* count as leaving.
//!
//! **Owner:** the `install-flow` builder (`backend/CONTRACTS.md`).

pub mod config;
pub mod queue;
pub mod watcher;
pub mod zipcheck;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use life_manager_plugin_abi as abi;
use mongodb::Collection;
use tracing::{info, warn};

use crate::db;
use crate::domain::{Actor, AuditEntry, Timestamp, new_id};
use crate::error::AppError;
use crate::plugins::{
    self, HOOK_NAMES, KERNEL_VERSION, PluginCapabilities, PluginManifest, PluginRecord, PluginState,
};
use crate::state::AppState;

/// Subdirectory of the staging root holding extractions in progress.
pub const WORK_SUBDIR: &str = "work";
/// Subdirectory of the staging root holding validated, unapproved packages.
pub const PENDING_SUBDIR: &str = "pending";
/// Pages of documents the `%%%` purge job walks at a time.
const PURGE_PAGE: u32 = 100;

/// Where a package came from. Recorded so an operator can tell an uploaded plugin from one
/// that appeared in a directory, and so the base distribution is not mistaken for either.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallSource {
    /// `POST /api/admin/plugins` (multipart).
    Upload { filename: String },
    /// Dropped into `PLUGIN_INBOX_DIR`.
    Directory { path: String },
    /// Shipped with the server image (`plugins/base/dist`), pre-approved at first boot.
    Base,
}

impl InstallSource {
    /// A one-line description for the lock holder, the log line and the audit entry.
    pub fn label(&self) -> String {
        match self {
            InstallSource::Upload { filename } => format!("upload {filename}"),
            InstallSource::Directory { path } => format!("drop {path}"),
            InstallSource::Base => "base distribution".to_string(),
        }
    }
}

/// One install request.
pub struct InstallRequest {
    pub source: InstallSource,
    /// The uploaded/dropped archive. Consumed: moved aside on success, deleted on
    /// rejection.
    pub archive: PathBuf,
    pub actor: Actor,
    /// Skip the pending state. **Only** legal for [`InstallSource::Base`] at first boot —
    /// the base distribution is the app itself, and an app that boots into an approval
    /// screen for its own editor is not usable (SPEC §6.5: the base set is installed like
    /// any other plugin, but it is what first run *is*).
    pub auto_approve: bool,
}

/// What an install produced.
#[derive(Debug, Clone, serde::Serialize)]
pub struct InstallOutcome {
    pub id: String,
    pub version: String,
    pub state: PluginState,
    /// What the manifest asked for — the list the approval screen shows.
    pub capabilities: PluginCapabilities,
    /// The version this one supersedes, if any.
    pub replaced: Option<String>,
    /// Non-fatal notes: an unsatisfied peer range, a missing optional asset.
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
    // There is deliberately no `AbiIncompatible` variant. The ABI *version value* cannot be
    // known at install time: it is what the module's `lm_abi_version` export *returns*, and
    // reading it needs a compiled instance. What install can answer statically is whether
    // the export exists at all, and that is [`check_backend_module`] — reported as a
    // `Manifest` error, because "this .wasm was not built with `lm::abi_version!()`" is a
    // packaging fault. The value is checked by `PluginHost::activate` before any of the
    // plugin's own code runs, and surfaces as `PluginHostError::AbiMismatch` on the record's
    // `last_error`. An unconstructible variant here only advertised a check that lives
    // somewhere else.
    #[error("unsatisfiable peer library: {0}")]
    PeerLibrary(String),
    #[error("{id} {version} is already installed")]
    AlreadyInstalled { id: String, version: String },
    #[error("another install is in progress")]
    Locked,
    #[error("install failed and was rolled back: {0}")]
    RolledBack(String),
    /// Additive M4 variant (announced in the install-flow report): no such plugin. The
    /// admin routes need a 404 and none of the variants above can express one.
    #[error("plugin `{id}` is not installed")]
    NotInstalled { id: String },
    /// Additive M4 variant: the plugin exists but is not in the state this action needs
    /// (approving an already-approved plugin, enabling a pending one). A 409.
    #[error("{0}")]
    Conflict(String),
    /// Additive M4 variant: a rejected configuration value or an illegal approval — a 400
    /// that must not be reported as "the manifest is not valid", because the manifest is
    /// fine and the admin's input is not.
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
            // A hostile or malformed package is a bad request, with the specific refusal in
            // the message: an operator who dropped the wrong file needs to know which rule
            // it broke, and none of these strings contains anything but the entry name and
            // the cap.
            InstallError::Package(err) => AppError::BadRequest(err.to_string()),
            InstallError::Manifest(message) => {
                AppError::BadRequest(format!("the manifest is not valid: {message}"))
            }
            InstallError::KernelIncompatible { .. } | InstallError::PeerLibrary(_) => {
                AppError::Unprocessable(error.to_string())
            }
            InstallError::AlreadyInstalled { .. } | InstallError::Conflict(_) => {
                AppError::Conflict(error.to_string())
            }
            InstallError::NotInstalled { .. } => AppError::NotFound("plugin"),
            InstallError::Config(message) => AppError::BadRequest(message),
            // The lock is a *transient* refusal, so it is a 429 with a `Retry-After` rather
            // than a 409: the client's correct behaviour is to try again, and 409 tells it
            // the opposite.
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

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/// Run the whole pipeline for one package. Serialized through [`queue::with_lock`].
pub async fn install(
    state: &AppState,
    request: InstallRequest,
) -> Result<InstallOutcome, InstallError> {
    let holder = format!("{} · {}", request.source.label(), request.actor.as_stored());
    let outcome = queue::queued(state, &holder, async || {
        install_locked(state, &request).await
    })
    .await;

    // The archive is *consumed* (see [`InstallRequest::archive`]), and who consumes it
    // depends on where it came from. An upload's archive is a temp file this server wrote
    // into `<staging>/uploads` and nothing will ever look at again, so a successful install
    // deletes it — otherwise every upload leaks a copy of the package next to the
    // installer's working directory. A dropped file belongs to the operator and is *moved
    // aside* by the watcher (`installed/` or `rejected/`, never deleted), and the base
    // distribution's files ship with the image.
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

/// The pipeline with the lock already held. Split out so [`install`] has exactly one
/// `?`-free line and every early return still releases the lock.
async fn install_locked(
    state: &AppState,
    request: &InstallRequest,
) -> Result<InstallOutcome, InstallError> {
    // 1. The manifest, before a byte is extracted.
    let manifest = zipcheck::read_manifest(&request.archive)?;
    let id = manifest.id.clone();
    let version = manifest.version.clone();

    // 2. Everything that can be known from the manifest alone.
    let warnings = validate_manifest(state, &manifest, None)?;

    // 3. Is this version already installed and approved? An *upgrade* (a different
    //    version) is allowed and keeps the plugin's KV; the same version again is not,
    //    because the artifacts it would replace are the ones currently being served.
    let existing = record(state, &id).await?;
    let replaced = existing
        .as_ref()
        .filter(|record| record.version != version)
        .map(|record| record.version.clone());
    if installed_dir(&state.config, &id, &version).is_dir() {
        return Err(InstallError::AlreadyInstalled { id, version });
    }

    // 4. Extract into a private working directory, then rename. The ULID suffix keeps two
    //    attempts at the same version from sharing a directory even if the lock were
    //    somehow held twice.
    let work = staging_dir(&state.config)
        .join(WORK_SUBDIR)
        .join(&id)
        .join(format!("{version}.{}", new_id()));
    let _ = fs::remove_dir_all(&work);

    let extracted = match zipcheck::extract(&request.archive, &work, &manifest) {
        Ok(extracted) => extracted,
        Err(err) => {
            // Nothing outside the working directory has been touched yet, so rollback is
            // one `remove_dir_all` and the previous version keeps serving.
            let _ = fs::remove_dir_all(&work);
            return Err(err.into());
        }
    };

    // The package's protocols and ports (PLUGIN-PROTOCOLS §3, §4): a claimed namespace, an
    // `id@version` that means something else here, or a `needs` key the protocol lacks.
    if let Err(message) = crate::protocols::check_install(state, &manifest, &extracted.dir).await {
        let _ = fs::remove_dir_all(&work);
        return Err(InstallError::Manifest(message));
    }

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
    // `work` is removed on every path: on success it has been renamed away and this is a
    // no-op, on failure it is the half-extracted package.
    let _ = fs::remove_dir_all(&work);
    if outcome.is_err() {
        rollback(state, &id, &version, existing.as_ref()).await;
    }
    outcome
}

/// Undo a failed install: the pending package goes, and the record goes back to exactly what
/// it was.
///
/// The second half matters more than it looks. The record is written *before* the
/// auto-approval step, so a failure there would otherwise leave a `pending` record whose
/// package has just been deleted — something no admin can approve and nothing will clean up.
/// Restoring the previous record verbatim also protects the case that costs real data: an
/// upgrade that fails must not leave the still-serving version's approval rewritten.
async fn rollback(state: &AppState, id: &str, version: &str, previous: Option<&PluginRecord>) {
    let _ = fs::remove_dir_all(pending_dir(&state.config, id, version));
    let restored = match previous {
        Some(previous) => save_record(state, previous).await,
        None => match record(state, id).await {
            // Only a record this install wrote: a `pending` one at the version that just
            // failed. Anything else belongs to somebody else's state.
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

/// Rename the extraction into `pending/` and write the record. The second half of
/// [`install_locked`], separated so its failures share one rollback.
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

    // The backend module's ABI export, checked statically now that it is on disk. The
    // *value* it returns needs a running instance, and the host re-checks it at activation
    // before running any of the plugin's own code (HOST-ABI.md §4).
    if let Some(wasm) = extracted.backend_wasm.as_ref() {
        check_backend_module(manifest, wasm)?;
    }

    let pending = pending_dir(&state.config, &id, &version);
    if let Some(parent) = pending.parent() {
        fs::create_dir_all(parent)?;
    }
    // A previous pending package for this exact version is replaced: an author fixing a
    // package and re-uploading it is the normal case, and two pendings for one version
    // would be a state the approval screen cannot render.
    let _ = fs::remove_dir_all(&pending);
    fs::rename(&extracted.dir, &pending).map_err(|err| {
        InstallError::RolledBack(format!(
            "could not move the package into {}: {err} — is PLUGIN_STAGING_DIR on the same filesystem as PLUGINS_DIR?",
            pending.display()
        ))
    })?;

    // One record per plugin, so an upgrade's pending window has the record describing the
    // *pending* version while the approved one keeps serving. Three fields are therefore
    // carried over rather than reset, because they describe the version on disk and not the
    // one waiting for a click:
    //
    // - `capabilities_approved` — the old version is still running under that grant, and
    //   zeroing it would make the host's authority vanish on the next restart.
    // - `approved_at` / `approved_by` — who approved what is *running* is not forgotten
    //   because somebody uploaded a candidate.
    // - `cron_state` — `last_run` is the plugin's own history (SPEC §6.3); resetting it
    //   would re-fire a job the upgrade has nothing to do with.
    //
    // A *first* install has no previous record, so it gets an empty grant: a pending record
    // must never claim a grant nobody made.
    //
    // **Known limitation, and the reason it is acceptable:** during that window the record
    // says `pending`, so a server restart before the click does not re-activate the old
    // backend half (its frontend half keeps being served — `Registry::apply_states` refuses
    // to demote on a version mismatch). Fixing it properly means a second record shape for
    // "the candidate", which the admin API is not written against; it is in the report.
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

    // The base distribution is the one auto-approval (SPEC §6.5), and it is checked here
    // rather than trusted from the request: an upload that set the flag would otherwise
    // install itself.
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
    // One wiring version for the whole install, auto-approval included (PLUGIN-PROTOCOLS
    // §6: every change is a version).
    crate::wiring::mirror_plugin_states(
        state,
        if replaced.is_some() {
            "upgrade"
        } else {
            "install"
        },
        &request.actor,
        &id,
        false,
    )
    .await;

    Ok(InstallOutcome {
        id,
        version,
        state: state_after,
        capabilities: manifest.capabilities.clone(),
        replaced,
        warnings,
    })
}

/// Approve a pending plugin with a capability set, and activate its backend half.
///
/// `capabilities` is what the **admin** approved, which may differ from what the manifest
/// requested. The rule (`backend/HOST-ABI.md`, "Capabilities an admin may widen"): the
/// approved set may narrow anything, and may *extend* only `http.hosts` — a plugin whose
/// destination is user-configured (a feed importer is exactly that) cannot know its host at
/// packaging time, and the alternative is asking every operator to repackage a zip.
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
    crate::wiring::mirror_plugin_states(state, "approve", actor, id, false).await;
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

    // The narrowing rule, before anything moves. An illegal approval is the admin's input
    // being wrong, not the package's.
    record
        .manifest
        .capabilities
        .approval_is_legal(&capabilities)
        .map_err(InstallError::Config)?;

    let pending = pending_dir(&state.config, id, version);
    let installed = installed_dir(&state.config, id, version);
    // The approval is **two** steps that cannot be one — a filesystem rename and a Mongo
    // write — so it has to be idempotent from either side of the gap. A process that died in
    // between used to be unrecoverable in the app: the record still said `pending`, so approve
    // ran again, found no pending directory, and refused; re-uploading the same version was
    // refused as already installed; and `reject` deleted the record while leaving the
    // artifacts in the served root. The only fix was deleting a directory by hand or bumping
    // the version. Recognising the completed half is all it takes.
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
            // The rename empties `<staging>/pending/<id>` but leaves the directory. An
            // empty directory there is not a pending package, and something does read it
            // as one: `retire_absent_records`'s second guard. Fails when a sibling version
            // is still pending, which is the case where it *should* stay.
            if let Some(parent) = pending.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
        // The rename already happened; only the record write is outstanding. Approving again
        // finishes the job, with whatever capabilities the admin is choosing *now*.
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
    // The upgrade path: only the approved version is served (`plugins::scan` keeps the
    // highest, and two versions in one page would give two copies of one plugin's API).
    prune_other_versions(&state.config, id, version);

    record.state = PluginState::Enabled;
    record.capabilities_approved = capabilities.clone();
    record.approved_at = Some(Timestamp::now());
    record.approved_by = actor.user_id().map(|id| id.to_string());
    record.disabled_reason = None;
    record.last_error = None;
    save_record(state, &record).await?;

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

/// Reject a pending plugin: delete its directory and its record.
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
        // The whole `pending/<id>` tree, so a rejected package leaves nothing behind for a
        // later version to be confused with.
        let _ = fs::remove_dir(staging_dir(&state.config).join(PENDING_SUBDIR).join(id));
        // And the served root, for the one case where a *pending* package can be found there:
        // an approval interrupted between its rename and its record write. Deleting the record
        // without these would leave an unapproved package's frontend files behind with nothing
        // left that knows they are unapproved.
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

/// Disable an approved plugin without uninstalling it (the admin's "off" switch, and what
/// the circuit breaker does automatically).
pub async fn disable(
    state: &AppState,
    id: &str,
    reason: &str,
    actor: &Actor,
) -> Result<(), InstallError> {
    disable_record(state, id, reason, actor).await?;
    // The circuit breaker disables as the system; an admin's switch is a person.
    let action = if matches!(actor, Actor::System) {
        "breaker"
    } else {
        "disable"
    };
    crate::wiring::mirror_plugin_states(state, action, actor, id, false).await;
    Ok(())
}

/// The record half of [`disable`]: the backend half stopped, the record moved to
/// `disabled`, the audit entry written, the registry refreshed — and **no wiring version**.
///
/// For a caller that is already writing one: a wiring Apply that unplugs a plugin
/// (`routes/wiring.rs`) has committed its version before it moves the records, and a
/// second version saying the same thing would only be noise in the history. Everything
/// else goes through [`disable`].
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

/// Re-enable a disabled plugin and clear its breaker.
pub async fn enable(state: &AppState, id: &str, actor: &Actor) -> Result<(), InstallError> {
    enable_record(state, id, actor).await?;
    crate::wiring::mirror_plugin_states(state, "enable", actor, id, false).await;
    Ok(())
}

/// The record half of [`enable`]: the record moved to `enabled`, its breaker cleared, its
/// backend half activated, the audit entry written — and **no wiring version**, for the
/// same reason as [`disable_record`].
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
    // The breaker is cleared as part of enabling, not separately: SPEC §6.3's "manual
    // re-enable" is one action from the operator's side, and an enable that left the
    // breaker open would look like it had done nothing.
    if record.manifest.has_backend() {
        let host = crate::pluginhost::PluginHost::get(state);
        host.reset_breaker(id);
    }
    let _ = activate(state, record).await;
    Ok(())
}

/// Uninstall (SPEC §6.2).
///
/// **KV and in-document `%%%` data are retained by default**, so a reinstall is lossless:
/// a plugin removed to try a replacement and then put back finds its state where it left
/// it. `purge` is the explicit checkbox — it deletes the KV namespace and queues a
/// background job stripping the plugin's `%%%` sections through CRDT transactions (one
/// `core::splice::remove_section` per document, never a whole-text rewrite).
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
        // **Uninstall is the one case that really is absent.** `PluginHost::invoke` checks the
        // breaker *before* the active map on purpose, so "switched off" (503) and "not here"
        // (404) stay distinguishable — which means an uninstalled plugin whose breaker had
        // opened kept answering `503 "<id> is disabled"` on every route for the life of the
        // process, and kept counting towards `lm_plugin_disabled`. `forget` is what makes the
        // distinction honest, and until now nothing in the tree called it.
        crate::pluginhost::PluginHost::get(state).forget(id);

        // Both trees: the served one and any pending package for the same id.
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
        // Uninstall also forgets the plugin's pins, cut and added wires and seats.
        crate::wiring::mirror_plugin_states(state, "uninstall", &actor, id, true).await;

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

            // The `%%%` strip is a background job on purpose: it is one CRDT transaction
            // per document over the whole workspace, and an admin clicking "uninstall and
            // purge" must not wait on it. It is resumable — a paged query on the same
            // predicate — so a restart mid-run simply finishes it next time it is asked.
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

/// The background job `purge` queues: strip one plugin's `%%%` section from every document
/// that has one. Resumable — it re-queries the same predicate, and each document is its own
/// CRDT transaction.
///
/// **It re-runs the first page rather than following a cursor**, and that is the important
/// design choice. A cursor would be over `updated_at` (the default sort), which every strip
/// *changes* — so editing the page you are holding shuffles the rows the cursor is measured
/// against and silently skips documents. Re-querying is immune to that: a stripped document
/// no longer matches `plugins.<id>` exists, so the predicate itself is the progress counter.
/// The loop stops when a whole page produces no strip, which is also what makes a document
/// that cannot be written a bounded failure rather than an infinite retry.
pub async fn purge_sections(state: &AppState, plugin_id: &str) -> Result<u64, InstallError> {
    // The materialized `plugins` map is the index: a document with a `%%%` section for this
    // plugin has the key, so the scan touches only the documents that need editing.
    let filter = bson::doc! { format!("plugins.{plugin_id}"): { "$exists": true } };
    let mut stripped = 0u64;

    loop {
        let query = crate::docstore::ListQuery {
            filter: Some(filter.clone()),
            sort: None,
            search: None,
            cursor: None,
            limit: PURGE_PAGE,
            // Trashed documents too: they are restorable for 30 days (SPEC §3.5), and a
            // restore that brought back a removed plugin's data would make the purge a lie.
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
                // Nothing to strip: the materialized `plugins` map said there was, and
                // reading the text (which forces a flush) has now corrected it, so this row
                // will not match the next query either.
                Ok(false) => {}
                // One unwritable document must not abandon the rest.
                Err(err) => warn!(
                    document = %row.id, plugin = %plugin_id, error = %err,
                    "could not strip a plugin section from a document"
                ),
            }
        }

        // A non-empty page that produced no strip is a stall, not a finish: every row
        // either failed to write or had its materialization corrected. Both are worth a
        // line, and neither is worth looping on.
        if progressed == 0 {
            warn!(
                plugin = %plugin_id, remaining = page.documents.len(),
                "the section purge made no progress on a page; re-run it to finish"
            );
            return Ok(stripped);
        }
    }
}

/// One document, one CRDT transaction (SPEC §6.2: "stripping the plugin's `%%%` sections
/// via CRDT transactions").
///
/// The removal spans are computed **inside** [`DocStore::splice`]'s closure, against the text
/// under the room lock. Reading the text first and applying spans derived from it afterwards
/// was the more dangerous half of the same race `splice_section` had: this job walks every
/// document with the section while people are typing in them (SPEC §5.4 is a shared
/// workspace), and the spans it removes are *whole sections*. A concurrent insertion above
/// the fence slid the range forward — bounds and character boundaries still checked out — and
/// the job deleted a block of the user's prose while leaving the `%%% … %%%` fence standing,
/// then reported success. During what the admin was told is a data cleanup.
async fn strip_one(
    state: &AppState,
    document_id: &str,
    plugin_id: &str,
) -> Result<bool, InstallError> {
    let removed = std::sync::atomic::AtomicBool::new(false);
    let compute = |text: &str| -> Result<Vec<life_manager_core::splice::TextEdit>, String> {
        let edits = life_manager_core::splice::remove_section(text, plugin_id).map_err(|err| {
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

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// Every plugin record, for the admin screen.
pub async fn records(state: &AppState) -> Result<Vec<PluginRecord>, InstallError> {
    let mut cursor = plugin_records(state).find(bson::doc! {}).await?;
    let mut out = Vec::new();
    // Rows are read one at a time and a broken one is skipped rather than failing the
    // list: a single unreadable record must not take the whole admin screen — and the
    // plugin it describes is not being served either way.
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

/// Undo any approval that got interrupted between its rename and its record write.
///
/// **The invariant being restored:** a *pending* package is never in `PLUGINS_DIR` — that is
/// the structural half of "an unapproved package's code never reaches a user's session"
/// ([`plugins::InstalledPlugin::state`]). [`approve`] breaks it for the instant between
/// `fs::rename` and `save_record`, and a process that dies in that instant leaves it broken:
/// the record says `pending`, the files sit in the served root, and every path out was closed
/// — approve could not find the pending directory, re-uploading the same version was refused
/// as already installed, and `reject` deleted the record while leaving the files.
///
/// Unwinding rather than completing, because only the *operator* can complete it: the
/// capability set they chose is the thing that was never written down, and approving with the
/// manifest's requested set would grant exactly what the approval screen exists to let them
/// decline. So the package goes back to pending and the admin clicks approve again.
///
/// Returns how many packages were moved. Every failure is logged and skipped: a boot that
/// refused to start over one directory would be a worse failure than the one it prevents.
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
        // If both exist, the rename never happened and the served copy is the stale one —
        // still not something a pending record may have in the served root.
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
                // Left where it is rather than deleted: it is a validated package an operator
                // uploaded, and `plugin_asset` refuses to serve it while the record says
                // pending. Loud, because it needs a human.
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

/// Reconcile the plugin records with the plugins on disk.
///
/// The bridge from M3, where the directory *was* the registry. On first boot every
/// directory becomes an approved record with its manifest's capabilities: an existing
/// deployment must not wake up with its whole base distribution pending, and the base
/// distribution has no backend halves to gate anyway.
///
/// It reconciles in **both** directions. A directory with no record is adopted (below); a
/// record with no directory is retired ([`retire_absent_records`]), which is what keeps a
/// plugin dropped from the image from lingering as an entry in admin and a 404ing module URL
/// in every client. Retiring keeps the plugin's data, exactly as an uninstall does.
///
/// **A *known* plugin is never re-approved by this pass.** The capability set a record
/// carries is the one an admin decided on — possibly narrower than the manifest's request,
/// which is the only thing the approval screen is for (SPEC §6.2) — and the state is their
/// on/off switch. Adoption therefore fills in what is missing and overwrites only what the
/// *directory* is authoritative about (the version, the manifest, the module hash). Writing
/// `manifest.capabilities` unconditionally is the bug this sentence exists to prevent: a
/// plugin absent for one boot and back the next would return with everything it asked for
/// and no approval screen in between.
///
/// **The consequence, stated:** anything an operator copies into `PLUGINS_DIR` by hand is
/// adopted as approved. That is inherent in the directory being the artifact store — the
/// static route serves what is there — and it is why `PLUGIN_INBOX_DIR` exists: a drop
/// *there* goes through the pipeline and lands pending. Copying into the served root is the
/// filesystem equivalent of editing the database.
pub async fn adopt_installed_directory(state: &AppState) -> Result<usize, InstallError> {
    if state.config.disable_plugins {
        return Ok(0);
    }
    let known: BTreeMap<String, PluginRecord> = records(state)
        .await?
        .into_iter()
        .map(|record| (record.id.clone(), record))
        .collect();
    // Before anything is scanned: put back any package an interrupted approval left in the
    // served root (see below).
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
            // Same version, same record, nothing to reconcile — *unless* the record is the
            // one an earlier boot switched off because this very directory was missing.
            // That one is back, and re-enabling it is the whole point of having kept it.
            if existing.version == manifest.version && !marked_absent(existing) {
                continue;
            }
            if existing.version != manifest.version {
                // The directory and the record disagree about the version. The directory
                // wins — it is what is being served — and the record is corrected rather
                // than the plugin being demoted (`Registry::apply_states` refuses to demote
                // on a version mismatch for the same reason).
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
        // A package that went away and came back. The previous pass turned the record off
        // rather than deleting it precisely so this is recoverable without a click; the
        // marker is what separates "we switched it off because the file vanished" from "an
        // admin switched it off", and only the first is ours to undo.
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
                // First sight of a directory: approved with exactly what it asks for. There
                // is no admin decision to reconstruct, and the alternative (empty) would
                // silently strip a working plugin of its capabilities on upgrade to M4.
                None => PluginState::Enabled,
                Some(_) if returning => PluginState::Enabled,
                Some(record) => record.state,
            },
            manifest: manifest.clone(),
            // **Never widened here.** The manifest's request is what an admin was asked
            // about; the record's set is what they answered.
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

/// `disabled_reason` on a record this pass switched off because its package went missing.
///
/// A marker, not prose, because [`adopt_installed_directory`] has to tell this apart from a
/// reason an *admin* wrote: one is ours to undo when the directory comes back, the other is
/// a decision that outlives the file. It is shown as-is in the admin screen, so it reads as
/// a sentence too.
pub const ABSENT_DISABLED_REASON: &str = "the package is no longer in PLUGINS_DIR";

/// Was this record switched off by [`retire_absent_records`], as opposed to by a person?
fn marked_absent(record: &PluginRecord) -> bool {
    record.state == PluginState::Disabled
        && record.disabled_reason.as_deref() == Some(ABSENT_DISABLED_REASON)
}

/// Is there an actual package under `<staging>/pending/<id>`, or just a directory?
///
/// The distinction is load-bearing and was not made. `approve` renames
/// `<staging>/pending/<id>/<version>` into the served root and leaves the **empty parent**
/// behind, so every plugin that was ever approved from an upload has a `pending/<id>`
/// directory for the rest of the deployment's life. Testing for the directory therefore
/// read "approved once, from an upload" as "waiting for a click", and
/// [`retire_absent_records`]'s second guard skipped exactly the plugins an operator is most
/// likely to remove by hand. `approve` cleans the parent up now; this stays version-agnostic
/// so the guard does not depend on it having succeeded.
fn has_pending_package(staging_pending: &Path, id: &str) -> bool {
    fs::read_dir(staging_pending.join(id)).is_ok_and(|mut entries| entries.next().is_some())
}

/// Switch off the plugins whose artifacts are gone.
///
/// A record left `enabled` without a package is a **ghost**: the admin screen lists it as
/// running, the host tries to activate a `backend.wasm` that is not there, and a client that
/// remembers the plugin list from its last boot keeps fetching a module URL that 404s. That
/// is exactly what happens when a plugin is dropped from the image: the new image simply does
/// not ship the directory any more, and nothing else tells the database.
///
/// **The record is disabled, not deleted, and that is the whole correction.** Deleting it
/// threw away the two things only the database holds — *what an admin approved* and *what an
/// admin decided*. An absence of one boot is not rare: an image that drops a plugin and a
/// rollback that restores it, an operator moving `<PLUGINS_DIR>/X` aside, a half-finished
/// volume sync. With a deleted record the directory's return was re-adoption from scratch —
/// `Enabled`, with the **manifest's full request** as the approved set, `disabled_reason`
/// cleared and `cron_state` reset — so a narrowing an admin chose on the approval screen and
/// a disable they made after the plugin misbehaved both evaporated silently, and a nightly
/// job re-fired. Disabling in place keeps every one of those and still kills the ghost:
/// `PluginState::is_active` is `Enabled` alone, so the backend half stays down, and the
/// registry is a scan of the directory, so the frontend half is already unreachable.
///
/// A returning directory is re-enabled by [`adopt_installed_directory`] **only** when the
/// reason still reads [`ABSENT_DISABLED_REASON`] — an admin's own disable is never undone.
///
/// **Three guards, because the opposite mistake is worse than a ghost.**
///
/// 1. Nothing is touched unless the scan found *some* plugin. An unreadable `PLUGINS_DIR`, an
///    unmounted volume or a `PLUGINS_DIR` pointing at the wrong path all look like "every
///    plugin disappeared at once", and turning off every plugin over a mount that comes back
///    a minute later is a self-inflicted outage.
/// 2. A record whose package sits in the **staging** tree is left alone. A pending upload has
///    no directory in the served root by design (that is what "pending" *is*), and touching
///    it would disturb the package an admin is about to approve.
/// 3. A record that is already `Disabled` is left exactly as it is — including its reason.
///    This pass runs on every boot, so anything it does unconditionally it does forever.
///
/// The one record still **deleted** is a `Pending` one with no package in either root: there
/// is no approval to keep (`capabilities_approved` is empty until approval) and no state a
/// person chose, so what is left is a row describing an archive that does not exist.
///
/// **Retention is the uninstall's, unchanged (SPEC §6.2):** `plugin_kv`, `plugin_config` and
/// every `%%% <id>` section in every document **stay**, whichever branch runs. Putting the
/// plugin back is lossless, and an operator who wants the data gone still has
/// `DELETE /api/admin/plugins/{id}?purge=true`.
async fn retire_absent_records(
    state: &AppState,
    known: &BTreeMap<String, PluginRecord>,
    registry: &Arc<plugins::Registry>,
) -> usize {
    if registry.plugins().is_empty() {
        // Guard 1. Said out loud when there is anything to be silent about, because "my
        // plugins vanished and so did their config" is the support question this prevents.
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
            continue; // Guard 2: an unapproved package, waiting for a click.
        }
        if record.state == PluginState::Disabled {
            continue; // Guard 3: already off, by us on an earlier boot or by a person.
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
                    // Says in the record what the doc comment says here: this is not a purge.
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

/// Re-scan `PLUGINS_DIR` and apply the approval records to it.
///
/// The wiring `backend/CONTRACTS.md` left open ("`Registry::apply_states` is not called
/// anywhere yet"): every install-flow action that can change what is served ends here, so
/// `/api/plugins` reports `disabled` for a plugin whose record says so instead of
/// `enabled`.
pub async fn refresh_registry(state: &AppState) -> Arc<plugins::Registry> {
    let records = match records(state).await {
        Ok(records) => records,
        // A registry that reflects the directory is better than none: Mongo being
        // unreachable must not take the app's plugins away (the same argument
        // `InstalledPlugin::state` documents).
        Err(err) => {
            warn!(error = %err, "could not read the plugin records; serving the directory as-is");
            Vec::new()
        }
    };
    let registry = plugins::reload_with_records(&state.config, &records);
    // Every scan that can change what is served also takes its protocols into the
    // registry, which keeps them after their owner is gone (PLUGIN-PROTOCOLS §3).
    crate::protocols::register_served(state).await;
    registry
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/// Activate a record's backend half, recording a failure on the record instead of failing
/// the admin's action.
///
/// SPEC §6.4's rule for the frontend loader, applied to the backend: a plugin whose module
/// will not load is marked `failed` and skipped, and **its frontend half keeps being
/// served** — half a plugin is usually better than none, and the admin screen says which
/// half is missing. A plugin with no backend half never reaches the host at all.
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

/// Stop a backend half before its artifacts go away. Never fatal: a plugin that was not
/// active is already in the state we want.
async fn deactivate(state: &AppState, record: &PluginRecord) {
    if !record.manifest.has_backend() {
        return;
    }
    let host = crate::pluginhost::PluginHost::get(state);
    if let Err(err) = host.deactivate(&record.id).await {
        warn!(plugin = %record.id, error = %err, "deactivating a plugin's backend half failed");
    }
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

/// `PLUGIN_STAGING_DIR`, default `<PLUGINS_DIR>.staging` — a **sibling** of the served
/// root, not a child: a child would be scanned by the registry and reported as an invalid
/// plugin id on every boot, and a `.`-prefixed child would be one `read_dir` change away
/// from being served.
pub fn staging_dir(config: &crate::config::Config) -> PathBuf {
    config.plugin_staging_dir.clone()
}

/// `<staging>/pending/<id>/<version>` — extracted, validated, unreachable.
pub fn pending_dir(config: &crate::config::Config, id: &str, version: &str) -> PathBuf {
    staging_dir(config)
        .join(PENDING_SUBDIR)
        .join(id)
        .join(version)
}

/// `<PLUGINS_DIR>/<id>/<version>`.
pub fn installed_dir(config: &crate::config::Config, id: &str, version: &str) -> PathBuf {
    config.plugins_dir.join(id).join(version)
}

/// Remove every version of `id` except `keep`. The upgrade path: `plugins::scan` serves the
/// highest version it finds, so leaving an old one behind would either keep serving it (if
/// it sorts higher) or accumulate forever.
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Validate a manifest against this server: id/version shape, kernel range, peer-library
/// ranges, backend declarations (hooks, cron expressions, routes, callees).
///
/// Returns the warnings that are *not* fatal, so an install can succeed with a note rather
/// than failing an operator for something cosmetic.
///
/// The order is HOST-ABI.md §7.1's, and the first six steps need nothing from the archive —
/// which is what lets the pipeline run them before extracting a byte. `wasm` is `Some` only
/// once the module is on disk (step 7).
pub fn validate_manifest(
    state: &AppState,
    manifest: &PluginManifest,
    wasm: Option<&Path>,
) -> Result<Vec<String>, InstallError> {
    let mut warnings = Vec::new();

    // 1. Shape.
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

    // 2. The kernel range. One `kernel` semver covers the `@kernel` surface and the host
    //    ABI (SPEC §6.4), and the server enforces it at install.
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

    // 5/6. Routes, capabilities, hooks, cron, events. (Before the peer libraries, because
    //      they are local to this manifest and their messages are the most actionable.)
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
            // Namespaced, because that is the only form `emit` produces (the host prefixes
            // the emitter's id). A bare name could never be delivered, so it is a manifest
            // error rather than a subscription that silently never fires.
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
        if !life_manager_core::limits::is_valid_key(key) {
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

    // 3/4. The peer libraries, over the installed set *including* this package —
    //      resolution has to see what the set will look like, not what it was. (Which
    //      plugins feed which is the wiring's business, resolved per boot, not an install
    //      gate: a consumer whose provider is missing installs and waits unwired.)
    //
    //      `loaded_manifests`, not `manifests`: the set that resolution is *about* is the set
    //      that will be in one page together, and a disabled or failed plugin is not loaded
    //      (`Registry::loaded_manifests`, and the loader's `plugin.state !== "enabled"`). Using
    //      every installed manifest here meant an install could be refused for a peer conflict
    //      with a plugin that will never load — and it disagreed with the boot-time check,
    //      which already used the loaded set.
    let mut manifests: Vec<PluginManifest> = plugins::registry(&state.config)
        .loaded_manifests()
        .into_iter()
        .filter(|installed| installed.id != manifest.id)
        .collect();
    manifests.push(manifest.clone());
    let resolution =
        plugins::resolve(&manifests).map_err(|err| InstallError::PeerLibrary(err.to_string()))?;
    warnings.extend(resolution.warnings.iter().cloned());

    // The peer libraries the *runtime bundle* provides. An import map cannot change after
    // load (SPEC §6.4), so a library nothing provides can never resolve in the browser —
    // fatal when the bundle is known. When it is not (an API-only deployment, or a server
    // whose `WEB_DIST_DIR` is unset) the check degrades to a warning rather than refusing
    // every plugin with a `peerLibraries` entry.
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
        // **The range, not just the name** (HOST-ABI.md §7.1 step 4: "ranges intersect with
        // what the runtime bundle provides"). Checking presence alone let a plugin declaring
        // `"@codemirror/view": "^7"` install and activate against a 6.x bundle and fail in the
        // browser, against an API that had changed under it — with nothing on the admin screen
        // to explain it, because from the server's point of view everything had matched.
        //
        // Fatal rather than a warning: an import map cannot change after load (SPEC §6.4), so
        // there is no later moment at which this could be satisfied. The operator's options are
        // a different plugin version or a different server, and both are decisions to make
        // before the code runs in every user's session.
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
    // 7. The module, once it is on disk.
    if let Some(path) = wasm {
        check_backend_module(manifest, path)?;
    }

    Ok(warnings)
}

/// HOST-ABI.md §7.1 step 7: the declared module exists, is within the size cap (checked by
/// [`zipcheck::extract`]) and **exports `lm_abi_version`**.
///
/// The export is checked statically — the file's export section, no engine, no plugin code
/// run. The value it returns needs an instance, and the host re-checks it at activation
/// before running any of the plugin's own code, so the two checks are not redundant: this
/// one catches "built without `abi_version!()`" at the moment an operator can still fix the
/// package, which is the difference between an install error and a mysterious `failed`
/// state after approval.
fn check_backend_module(manifest: &PluginManifest, wasm: &Path) -> Result<(), InstallError> {
    if manifest.backend.is_none() {
        return Ok(());
    }
    match zipcheck::wasm_exports(wasm, abi::names::ABI_VERSION) {
        Ok(true) => Ok(()),
        Ok(false) => Err(InstallError::Manifest(format!(
            "`{}` does not export `{}`; a backend half built with the SDK declares it with `lm::abi_version!()`",
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
