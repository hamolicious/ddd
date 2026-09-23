//! `AppState` — the single axum state type.
//!
//! **FROZEN CONTRACT.** Handlers, extractors and the docstore all take
//! `State<AppState>`. Adding a field is a cross-area change: propose it, don't
//! just do it. `AppState` is cheap to clone (everything inside is `Arc` or a
//! handle).

use std::sync::Arc;

use mongodb::{Client, Database};

use crate::auth::RateLimiter;
use crate::config::Config;
use crate::db::Collections;
use crate::docstore::{DocStore, DocStoreWorkers, MongoDocStore};

/// The docstore's background workers (debounced materialization flush, idle room
/// eviction, update-log trimming) belong to the concrete `MongoDocStore`, and
/// `AppState::new` is the only place that store is constructed — the state holds
/// it as `Arc<dyn DocStore>`. So the worker handles are parked here for the
/// lifetime of the process instead of being handed back to `main`: dropping them
/// would abort the flush loop. Shutdown flushes through the trait
/// (`DocStore::flush_all`), which is what durability actually depends on.
static DOCSTORE_WORKERS: std::sync::Mutex<Vec<DocStoreWorkers>> = std::sync::Mutex::new(Vec::new());

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    /// Mongo client (for ping / health / GridFS).
    pub mongo: Client,
    /// The application database.
    pub db: Database,
    /// Typed collection handles.
    pub collections: Collections,
    /// CRDT storage engine.
    pub docs: Arc<dyn DocStore>,
    /// Per-IP + per-account login backoff (SPEC §5.2).
    pub login_limiter: Arc<RateLimiter>,
    /// Boot-time facts for `/readyz`.
    pub readiness: Arc<Readiness>,
}

/// What `/readyz` reports (SPEC §8): Mongo reachable, migrations done, plugin
/// load (M4 — always `true` in M1).
pub struct Readiness {
    pub migrations_complete: std::sync::atomic::AtomicBool,
    pub schema_version: std::sync::atomic::AtomicI32,
    pub started_at: std::time::Instant,
}

impl Default for Readiness {
    fn default() -> Self {
        Self {
            migrations_complete: std::sync::atomic::AtomicBool::new(false),
            schema_version: std::sync::atomic::AtomicI32::new(0),
            started_at: std::time::Instant::now(),
        }
    }
}

impl AppState {
    /// Build the state: connect to Mongo, construct the docstore, wire the rate
    /// limiter. Does **not** run migrations (`main` does, so the boot order is
    /// visible in one place).
    pub async fn new(config: Config) -> anyhow::Result<AppState> {
        let (mongo, db) = crate::db::connect(&config).await?;

        let store = MongoDocStore::new(db.clone(), config.max_document_bytes);
        let workers = store.spawn_workers();
        if let Ok(mut parked) = DOCSTORE_WORKERS.lock() {
            parked.push(workers);
        }

        let login_limiter = Arc::new(RateLimiter::new(
            config.login_max_attempts,
            config.login_attempt_window,
        ));

        Ok(AppState {
            collections: Collections::new(db.clone()),
            config: Arc::new(config),
            mongo,
            db,
            docs: Arc::new(store),
            login_limiter,
            readiness: Arc::new(Readiness::default()),
        })
    }

    /// Convenience accessor used all over the handlers.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Record an audit entry, logging (never failing the request) on error
    /// (SPEC §5.4).
    pub async fn audit(&self, entry: crate::domain::AuditEntry) {
        // An audit write that fails must not fail the action it records — the
        // action already happened. It is logged at error level instead, where the
        // JSON log is the second copy of the trail (SPEC §5.4).
        if let Err(err) = self.collections.audit_log().insert_one(&entry).await {
            tracing::error!(
                error = %err,
                action = %entry.action,
                target_kind = %entry.target_kind,
                target_id = entry.target_id.as_deref().unwrap_or("-"),
                "audit write failed"
            );
        }
    }
}
