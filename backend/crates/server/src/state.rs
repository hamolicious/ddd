use std::sync::Arc;

use mongodb::{Client, Database};

use crate::auth::RateLimiter;
use crate::config::Config;
use crate::db::Collections;
use crate::docstore::{DocStore, DocStoreTuning, DocStoreWorkers, MongoDocStore};
use crate::feed::ChangeFeed;
use crate::query_index::QueryIndex;

static DOCSTORE_WORKERS: std::sync::Mutex<Vec<DocStoreWorkers>> = std::sync::Mutex::new(Vec::new());

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub mongo: Client,
    pub db: Database,
    pub collections: Collections,
    pub docs: Arc<dyn DocStore>,
    pub feed: Arc<ChangeFeed>,
    pub query: Arc<QueryIndex>,
    pub login_limiter: Arc<RateLimiter>,
    pub readiness: Arc<Readiness>,
}

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
    pub async fn new(config: Config) -> anyhow::Result<AppState> {
        let (mongo, db) = crate::db::connect(&config).await?;

        let collections = Collections::new(db.clone());

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

    pub async fn init_schema(&self) -> anyhow::Result<()> {
        crate::db::init_schema(&self.db).await?;
        let head = self.feed.initialize().await?;
        tracing::debug!(head_seq = head, "change feed re-seeded after migrations");
        Ok(())
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub async fn audit(&self, entry: crate::domain::AuditEntry) {
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
