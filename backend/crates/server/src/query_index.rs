//! The workspace's query engine on the server (`core::query::Engine`), kept current
//! from the change feed.
//!
//! **The same engine the browser runs**, so a query answers identically online and
//! offline: filter, full-text ranking, folder relations and sort all happen here,
//! in memory, never in Mongo. Mongo stays the store; this is an index over it. One
//! workspace per server (SPEC §8: `replicas: 1`) keeps that index bounded.
//!
//! # Staying current: catch up to `safe_seq` before answering
//!
//! The engine remembers the feed watermark it has applied. Every query first reads
//! `rows_since(applied)` — the same gapless read a syncing client does
//! (`feed.rs`) — and applies it, so a write that returned before the query started
//! is always in the answer (read-your-writes), with no background task to lag
//! behind. When nothing changed the read returns before touching Mongo. At boot,
//! [`QueryIndex::warm`] does the first, full catch-up so the first request does
//! not pay for it.
//!
//! # Answers are ids; rows come from Mongo
//!
//! The engine pages ids; [`QueryIndex::rows`] then reads those rows from Mongo in
//! one `$in`, in the engine's order, so every caller still gets the stored row
//! (`created_by`, `materialized_version`, …) and `metadata_only` still keeps the
//! text off the wire.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use bson::doc;
use ddd_core::query::{Doc, Engine, Page, Plan, QueryError};
use futures::TryStreamExt;
use thiserror::Error;

use crate::db::{self, Collections};
use crate::domain::DocumentRow;
use crate::feed::{ChangeFeed, FEED_BATCH_MAX_ROWS, FeedError, FeedRow};

#[derive(Debug, Error)]
pub enum QueryIndexError {
    /// The plan itself is wrong: a 400 / `InvalidArgument`.
    #[error(transparent)]
    Query(#[from] QueryError),
    #[error(transparent)]
    Feed(#[from] FeedError),
    #[error("database error: {0}")]
    Db(#[from] mongodb::error::Error),
}

pub struct QueryIndex {
    feed: Arc<ChangeFeed>,
    collections: Collections,
    engine: RwLock<Engine>,
    /// The feed watermark the engine reflects. Held across a catch-up, so two
    /// queries never apply the same page twice.
    applied: tokio::sync::Mutex<i64>,
}

impl std::fmt::Debug for QueryIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueryIndex").finish_non_exhaustive()
    }
}

/// A page of stored rows, in the engine's order.
#[derive(Debug)]
pub struct RowPage {
    pub rows: Vec<DocumentRow>,
    pub page: Page,
}

impl QueryIndex {
    pub fn new(feed: Arc<ChangeFeed>, collections: Collections) -> Arc<QueryIndex> {
        Arc::new(QueryIndex {
            feed,
            collections,
            engine: RwLock::new(Engine::new()),
            applied: tokio::sync::Mutex::new(0),
        })
    }

    /// The first, full catch-up, logged. Errors are logged and left for the first
    /// query to retry.
    pub async fn warm(&self) {
        let started = std::time::Instant::now();
        match self.catch_up().await {
            Ok(()) => {
                let documents = self.read(Engine::len);
                tracing::info!(
                    documents,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "query index loaded"
                );
            }
            Err(err) => {
                tracing::warn!(error = %err, "query index failed to load; the first query retries")
            }
        }
    }

    /// Apply every feed row up to the current `safe_seq`.
    pub async fn catch_up(&self) -> Result<(), FeedError> {
        let mut applied = self.applied.lock().await;
        loop {
            let page = self
                .feed
                .rows_since(*applied, FEED_BATCH_MAX_ROWS, true)
                .await?;
            if !page.rows.is_empty() {
                let mut engine = self.engine.write().expect("query engine poisoned");
                for row in page.rows {
                    apply(&mut engine, row);
                }
            }
            *applied = page.safe_seq;
            if page.complete {
                return Ok(());
            }
        }
    }

    /// Read the engine as it stands, without catching up.
    pub fn read<R>(&self, read: impl FnOnce(&Engine) -> R) -> R {
        read(&self.engine.read().expect("query engine poisoned"))
    }

    /// Answer a plan with ids, current to the feed.
    pub async fn run(&self, plan: &Plan) -> Result<Page, QueryIndexError> {
        self.catch_up().await?;
        Ok(self.read(|engine| engine.run(plan).map(|answer| answer.page()))?)
    }

    /// Answer a plan with the stored rows.
    pub async fn rows(
        &self,
        plan: &Plan,
        include_content: bool,
    ) -> Result<RowPage, QueryIndexError> {
        let page = self.run(plan).await?;
        let rows = self.fetch(&page.ids, include_content).await?;
        Ok(RowPage { rows, page })
    }

    /// The stored rows for `ids`, in that order. A row purged since the engine
    /// answered is left out.
    async fn fetch(
        &self,
        ids: &[String],
        include_content: bool,
    ) -> Result<Vec<DocumentRow>, mongodb::error::Error> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut found: HashMap<String, DocumentRow> = self
            .collections
            .database()
            .collection::<DocumentRow>(db::DOCUMENTS)
            .find(doc! { "_id": { "$in": ids } })
            .projection(DocumentRow::projection(include_content))
            .await?
            .try_collect::<Vec<_>>()
            .await?
            .into_iter()
            .map(|row| (row.id.clone(), row))
            .collect();
        Ok(ids.iter().filter_map(|id| found.remove(id)).collect())
    }
}

/// One feed row into the engine: a purge takes the document out, anything else
/// replaces it.
fn apply(engine: &mut Engine, row: FeedRow) {
    if row.purged {
        engine.remove(&row.id);
        return;
    }
    match serde_json::to_value(&row)
        .ok()
        .as_ref()
        .and_then(Doc::from_json)
    {
        Some(doc) => engine.upsert(doc),
        None => tracing::warn!(id = %row.id, "a feed row the query index could not read"),
    }
}
