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
use crate::docstore::{DocStore, DocStoreTuning, DocStoreWorkers, MongoDocStore};
use crate::feed::ChangeFeed;
use crate::query_index::QueryIndex;

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
    /// The workspace change feed (SPEC §4.1): sequence allocation for writes, and
    /// the notification channel + queries the sync sockets read from.
    pub feed: Arc<ChangeFeed>,
    /// The query engine every list, search and plugin query runs on, kept current
    /// from the feed (`query_index.rs`).
    pub query: Arc<QueryIndex>,
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
    /// limiter. Does **not** run migrations — [`AppState::init_schema`] does, and
    /// every caller must call it before serving, so the boot order stays visible in
    /// one place.
    pub async fn new(config: Config) -> anyhow::Result<AppState> {
        let (mongo, db) = crate::db::connect(&config).await?;

        let collections = Collections::new(db.clone());

        // The feed is constructed before the docstore and handed to it: every write
        // that changes the projection allocates a sequence number through it
        // (SPEC §4.1). Its counter is seeded from the database here, before anything
        // can write — see `ChangeFeed::initialize` — and **seeded again** by
        // `init_schema` after the migrations, because `m002_backfill_feed_seq`
        // writes sequence numbers this first read cannot see.
        let feed = ChangeFeed::new(collections.clone());
        feed.initialize().await?;

        let store = MongoDocStore::new(
            db.clone(),
            DocStoreTuning::from_config(&config),
            Arc::clone(&feed),
        );
        let workers = store.spawn_workers();
        if let Ok(mut parked) = DOCSTORE_WORKERS.lock() {
            parked.push(workers);
        }

        let login_limiter = Arc::new(RateLimiter::new(
            config.login_max_attempts,
            config.login_attempt_window,
        ));

        Ok(AppState {
            collections: collections.clone(),
            config: Arc::new(config),
            mongo,
            db,
            docs: Arc::new(store),
            query: QueryIndex::new(Arc::clone(&feed), collections.clone()),
            feed,
            login_limiter,
            readiness: Arc::new(Readiness::default()),
        })
    }

    /// Run the migrations and index creation, then **re-seed the change feed's
    /// sequence counter**. The one correct boot step between
    /// [`AppState::new`] and serving a request.
    ///
    /// # Why the counter is seeded twice
    ///
    /// `MongoDocStore` needs the feed at construction time, so `new` seeds it from
    /// `max(feed_seq)` — but that read happens *before* the migrations, and
    /// `m002_backfill_feed_seq` (SPEC §4.1, PROTOCOL.md §2.2) is what gives every
    /// pre-feed M1 row its number. Upgrading an M1 workspace of 3 000 documents
    /// therefore left the allocator at `head = 0` while the backfill wrote
    /// `1..3000` onto the rows: the next live write would reuse number 1, two rows
    /// would share a sequence number, and `welcome.feed.safe_seq` would report a
    /// watermark thousands below what the rows carry — so catch-up (capped at
    /// `safe_seq`) could not see them at all. Re-reading the head here closes that,
    /// and `FeedSequencer::set_head` only ever *raises* it, so calling this twice,
    /// or after a write, is harmless.
    pub async fn init_schema(&self) -> anyhow::Result<()> {
        crate::db::init_schema(&self.db).await?;
        let head = self.feed.initialize().await?;
        tracing::debug!(head_seq = head, "change feed re-seeded after migrations");
        Ok(())
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
