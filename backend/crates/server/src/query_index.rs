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
    applied: tokio::sync::Mutex<i64>,
}

impl std::fmt::Debug for QueryIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueryIndex").finish_non_exhaustive()
    }
}

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

    pub fn read<R>(&self, read: impl FnOnce(&Engine) -> R) -> R {
        read(&self.engine.read().expect("query engine poisoned"))
    }

    pub async fn run(&self, plan: &Plan) -> Result<Page, QueryIndexError> {
        self.catch_up().await?;
        Ok(self.read(|engine| engine.run(plan).map(|answer| answer.page()))?)
    }

    pub async fn rows(
        &self,
        plan: &Plan,
        include_content: bool,
    ) -> Result<RowPage, QueryIndexError> {
        let page = self.run(plan).await?;
        let rows = self.fetch(&page.ids, include_content).await?;
        Ok(RowPage { rows, page })
    }

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
