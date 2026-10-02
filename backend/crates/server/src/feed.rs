use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use bson::{Document as BsonDocument, doc};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::broadcast;

use crate::db::{self, Collections};
use crate::docstore::TrashFilter;
use crate::domain::{DocumentRow, GraveyardEntry, Id, Timestamp, materialized_to_json};

pub const FEED_SEQ_START: i64 = 1;

pub const NOTICE_CHANNEL_CAPACITY: usize = 1024;

pub const FEED_BATCH_MAX_ROWS: u32 = 1000;
pub const FEED_BATCH_DEFAULT_ROWS: u32 = 200;
pub const FEED_CATCHUP_MAX_ROWS: u64 = 500;
pub const FEED_PAGE_MAX_BYTES: usize = 2 * 1024 * 1024;
const ROW_OVERHEAD_BYTES: usize = 1024;
pub const BOOTSTRAP_DEFAULT_LIMIT: u32 = 200;
pub const BOOTSTRAP_MAX_LIMIT: u32 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedChangeKind {
    Upsert,
    Tombstoned,
    Restored,
    Purged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedNotice {
    pub seq: i64,
    pub id: Id,
    pub kind: FeedChangeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedRow {
    pub seq: i64,
    pub id: Id,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub content: Option<String>,
    pub fm: serde_json::Value,
    pub plugins: serde_json::Value,
    pub fm_parse_error: bool,
    pub materialized_version: String,
    pub created_at: Timestamp,
    pub created_by: Option<String>,
    pub updated_at: Timestamp,
    pub updated_by: Option<String>,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_by: Option<String>,
    pub purged: bool,
}

impl FeedRow {
    pub fn from_row(row: DocumentRow, include_content: bool) -> Option<Self> {
        let seq = row.feed_seq?;
        Some(Self {
            seq,
            id: row.id,
            title: row.title,
            content: include_content.then_some(row.content),
            fm: materialized_to_json(&row.fm),
            plugins: materialized_to_json(&row.plugins),
            fm_parse_error: row.fm_parse_error,
            materialized_version: row.materialized_version,
            created_at: row.created_at.into(),
            created_by: row.created_by,
            updated_at: row.updated_at.into(),
            updated_by: row.updated_by,
            deleted: row.deleted_at.is_some(),
            deleted_at: row.deleted_at.map(Timestamp::from),
            deleted_by: row.deleted_by,
            purged: false,
        })
    }

    pub fn purged(seq: i64, id: Id, deleted_at: Timestamp, deleted_by: Option<String>) -> Self {
        Self {
            seq,
            id,
            title: String::new(),
            content: None,
            fm: serde_json::Value::Object(serde_json::Map::new()),
            plugins: serde_json::Value::Object(serde_json::Map::new()),
            fm_parse_error: false,
            materialized_version: String::new(),
            created_at: deleted_at,
            created_by: None,
            updated_at: deleted_at,
            updated_by: deleted_by.clone(),
            deleted: true,
            deleted_at: Some(deleted_at),
            deleted_by,
            purged: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FeedPage {
    pub rows: Vec<FeedRow>,
    pub safe_seq: i64,
    pub head_seq: i64,
    pub complete: bool,
}

#[derive(Debug, Clone)]
pub struct BootstrapPage {
    pub rows: Vec<FeedRow>,
    pub next_cursor: Option<String>,
    pub complete: bool,
}

#[derive(Debug, Error)]
pub enum FeedError {
    #[error("database error: {0}")]
    Db(#[from] mongodb::error::Error),
    #[error("bson error: {0}")]
    Bson(String),
    #[error("resume point {since} is ahead of head {head}")]
    SeqAhead { since: i64, head: i64 },
}

#[derive(Debug)]
pub struct FeedAllocation {
    sequencer: Arc<FeedSequencer>,
    id: Id,
    seq: i64,
    committed: bool,
}

impl FeedAllocation {
    pub fn seq(&self) -> i64 {
        self.seq
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn commit(mut self, kind: FeedChangeKind) {
        self.committed = true;
        let notice = FeedNotice {
            seq: self.seq,
            id: self.id.clone(),
            kind,
        };
        self.sequencer.release(self.seq);
        let _ = self.sequencer.notices.send(notice);
    }
}

impl Drop for FeedAllocation {
    fn drop(&mut self) {
        if !self.committed {
            self.sequencer.release(self.seq);
        }
    }
}

#[derive(Debug)]
pub struct FeedSequencer {
    head: AtomicI64,
    in_flight: std::sync::Mutex<BTreeSet<i64>>,
    notices: broadcast::Sender<FeedNotice>,
}

impl FeedSequencer {
    pub fn new() -> Arc<Self> {
        let (notices, _) = broadcast::channel(NOTICE_CHANNEL_CAPACITY);
        Arc::new(Self {
            head: AtomicI64::new(FEED_SEQ_START - 1),
            in_flight: std::sync::Mutex::new(BTreeSet::new()),
            notices,
        })
    }

    pub fn set_head(&self, seq: i64) {
        self.head.fetch_max(seq, Ordering::SeqCst);
    }

    pub fn head_seq(&self) -> i64 {
        self.head.load(Ordering::SeqCst)
    }

    pub fn safe_seq(&self) -> i64 {
        let head = self.head_seq();
        let in_flight = self.in_flight.lock().expect("feed in-flight set poisoned");
        match in_flight.iter().next() {
            Some(lowest) => lowest - 1,
            None => head,
        }
    }

    pub fn allocate(self: &Arc<Self>, id: Id) -> FeedAllocation {
        let seq = self.head.fetch_add(1, Ordering::SeqCst) + 1;
        self.in_flight
            .lock()
            .expect("feed in-flight set poisoned")
            .insert(seq);
        FeedAllocation {
            sequencer: Arc::clone(self),
            id,
            seq,
            committed: false,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<FeedNotice> {
        self.notices.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.notices.receiver_count()
    }

    fn release(&self, seq: i64) {
        self.in_flight
            .lock()
            .expect("feed in-flight set poisoned")
            .remove(&seq);
    }
}

pub struct ChangeFeed {
    collections: Collections,
    sequencer: Arc<FeedSequencer>,
}

impl std::fmt::Debug for ChangeFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChangeFeed")
            .field("head_seq", &self.head_seq())
            .field("safe_seq", &self.safe_seq())
            .field("subscribers", &self.subscriber_count())
            .finish_non_exhaustive()
    }
}

impl ChangeFeed {
    pub fn new(collections: Collections) -> Arc<Self> {
        Arc::new(Self {
            collections,
            sequencer: FeedSequencer::new(),
        })
    }

    pub async fn initialize(&self) -> Result<i64, FeedError> {
        let documents = max_feed_seq(&self.collections, db::DOCUMENTS).await?;
        let graveyard = max_feed_seq(&self.collections, db::DELETED_IDS).await?;
        let head = documents.max(graveyard);
        self.sequencer.set_head(head);
        tracing::info!(
            head_seq = head,
            documents_max = documents,
            graveyard_max = graveyard,
            "change feed initialized"
        );
        Ok(head)
    }

    pub fn allocate(&self, id: Id) -> FeedAllocation {
        self.sequencer.allocate(id)
    }

    pub fn head_seq(&self) -> i64 {
        self.sequencer.head_seq()
    }

    pub fn safe_seq(&self) -> i64 {
        self.sequencer.safe_seq()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<FeedNotice> {
        self.sequencer.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.sequencer.subscriber_count()
    }

    pub fn sequencer(&self) -> &Arc<FeedSequencer> {
        &self.sequencer
    }

    pub async fn count_since(&self, since_seq: i64) -> Result<u64, FeedError> {
        let filter = doc! { "feed_seq": { "$gt": since_seq } };
        let documents = self
            .collections
            .documents()
            .count_documents(filter.clone())
            .await?;
        let graveyard = self
            .collections
            .deleted_ids()
            .count_documents(filter)
            .await?;
        Ok(documents + graveyard)
    }

    pub async fn rows_since(
        &self,
        since_seq: i64,
        limit: u32,
        include_content: bool,
    ) -> Result<FeedPage, FeedError> {
        let head = self.head_seq();
        if since_seq > head {
            return Err(FeedError::SeqAhead {
                since: since_seq,
                head,
            });
        }
        let safe = self.safe_seq();
        let limit = limit.clamp(1, FEED_BATCH_MAX_ROWS);

        if since_seq >= safe {
            return Ok(FeedPage {
                rows: Vec::new(),
                safe_seq: safe.max(since_seq),
                head_seq: head,
                complete: true,
            });
        }

        let range = doc! { "$gt": since_seq, "$lte": safe };

        let mut documents: Vec<DocumentRow> = Vec::new();
        let mut bytes = 0usize;
        let mut byte_capped = false;
        let mut cursor = self
            .document_rows()
            .find(doc! { "feed_seq": range.clone() })
            .projection(DocumentRow::projection(include_content))
            .sort(doc! { "feed_seq": 1 })
            .limit(i64::from(limit))
            .await?;
        while let Some(row) = cursor.try_next().await? {
            bytes += row.content.len() + ROW_OVERHEAD_BYTES;
            documents.push(row);
            if documents.len() as u32 >= limit {
                break;
            }
            if bytes >= FEED_PAGE_MAX_BYTES {
                byte_capped = true;
                break;
            }
        }

        let graveyard: Vec<GraveyardEntry> = self
            .collections
            .deleted_ids()
            .find(doc! { "feed_seq": range })
            .sort(doc! { "feed_seq": 1 })
            .limit(i64::from(limit))
            .await?
            .try_collect()
            .await?;

        let mut cut_seq: Option<i64> = None;
        let mut note_cut = |seq: Option<i64>| {
            if let Some(seq) = seq {
                cut_seq = Some(cut_seq.map_or(seq, |current: i64| current.min(seq)));
            }
        };
        if byte_capped || documents.len() as u32 == limit {
            note_cut(documents.last().and_then(|row| row.feed_seq));
        }
        if graveyard.len() as u32 == limit {
            note_cut(graveyard.last().and_then(|entry| entry.feed_seq));
        }

        let mut rows: Vec<FeedRow> = documents
            .into_iter()
            .filter_map(|row| FeedRow::from_row(row, include_content))
            .collect();
        rows.extend(graveyard.into_iter().filter_map(|entry| {
            let seq = entry.feed_seq?;
            Some(FeedRow::purged(
                seq,
                entry.id,
                entry.deleted_at.into(),
                entry.deleted_by,
            ))
        }));
        rows.sort_by_key(|row| row.seq);

        if let Some(cut) = cut_seq {
            rows.retain(|row| row.seq <= cut);
        }

        if truncate_at_seq_boundary(&mut rows, limit as usize) {
            let last = rows.last().map_or(since_seq, |row| row.seq);
            cut_seq = Some(cut_seq.map_or(last, |current| current.min(last)));
        }

        let complete = cut_seq.is_none();
        let safe_seq = cut_seq.unwrap_or(safe);

        Ok(FeedPage {
            rows,
            safe_seq,
            head_seq: head,
            complete,
        })
    }

    pub async fn bootstrap_cursor(
        &self,
        cursor: Option<&str>,
        limit: u32,
        trash: TrashFilter,
        include_content: bool,
    ) -> Result<mongodb::Cursor<DocumentRow>, FeedError> {
        let limit = limit.clamp(1, BOOTSTRAP_MAX_LIMIT);
        let mut filter = Self::trash_filter(trash);
        if let Some(cursor) = cursor {
            filter.insert("_id", doc! { "$gt": cursor });
        }
        Ok(self
            .document_rows()
            .find(filter)
            .projection(DocumentRow::projection(include_content))
            .sort(doc! { "_id": 1 })
            .limit(i64::from(limit) + 1)
            .await?)
    }

    pub async fn bootstrap_page(
        &self,
        cursor: Option<&str>,
        limit: u32,
        trash: TrashFilter,
        include_content: bool,
    ) -> Result<BootstrapPage, FeedError> {
        let limit = limit.clamp(1, BOOTSTRAP_MAX_LIMIT);
        let mut filter = Self::trash_filter(trash);
        if let Some(cursor) = cursor {
            filter.insert("_id", doc! { "$gt": cursor });
        }

        let mut raw: Vec<DocumentRow> = self
            .document_rows()
            .find(filter)
            .projection(DocumentRow::projection(include_content))
            .sort(doc! { "_id": 1 })
            .limit(i64::from(limit) + 1)
            .await?
            .try_collect()
            .await?;

        let complete = raw.len() as u32 <= limit;
        if !complete {
            raw.pop();
        }
        let next_cursor = if complete {
            None
        } else {
            raw.last().map(|row| row.id.clone())
        };

        let rows = raw
            .into_iter()
            .filter_map(|row| FeedRow::from_row(row, include_content))
            .collect();

        Ok(BootstrapPage {
            rows,
            next_cursor,
            complete,
        })
    }

    pub async fn bootstrap_total(&self, trash: TrashFilter) -> Result<u64, FeedError> {
        Ok(self
            .collections
            .documents()
            .count_documents(Self::trash_filter(trash))
            .await?)
    }

    fn document_rows(&self) -> mongodb::Collection<DocumentRow> {
        self.collections
            .database()
            .collection::<DocumentRow>(db::DOCUMENTS)
    }

    pub fn trash_filter(trash: TrashFilter) -> BsonDocument {
        match trash {
            TrashFilter::Live => doc! { "deleted_at": { "$exists": false } },
            TrashFilter::Trashed => doc! { "deleted_at": { "$exists": true } },
            TrashFilter::All => doc! {},
        }
    }

    pub fn collections(&self) -> &Collections {
        &self.collections
    }
}

fn truncate_at_seq_boundary(rows: &mut Vec<FeedRow>, limit: usize) -> bool {
    let limit = limit.max(1);
    if rows.len() <= limit {
        return false;
    }
    let boundary = rows[limit - 1].seq;
    let mut end = limit;
    while end < rows.len() && rows[end].seq == boundary {
        end += 1;
    }
    rows.truncate(end);
    true
}

async fn max_feed_seq(collections: &Collections, name: &str) -> Result<i64, FeedError> {
    let row = collections
        .raw(name)
        .find_one(doc! { "feed_seq": { "$exists": true } })
        .sort(doc! { "feed_seq": -1 })
        .projection(doc! { "feed_seq": 1 })
        .await?;
    Ok(row
        .as_ref()
        .and_then(|row| row.get("feed_seq"))
        .and_then(bson::Bson::as_i64)
        .unwrap_or(FEED_SEQ_START - 1))
}

pub async fn collect_rows(
    cursor: mongodb::Cursor<DocumentRow>,
    include_content: bool,
) -> Result<Vec<FeedRow>, FeedError> {
    let rows: Vec<DocumentRow> = cursor.try_collect().await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| FeedRow::from_row(row, include_content))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed() -> Arc<FeedSequencer> {
        FeedSequencer::new()
    }

    #[test]
    fn allocation_is_monotonic() {
        let feed = feed();
        let first = feed.allocate("a".into());
        let second = feed.allocate("b".into());
        assert_eq!(first.seq(), FEED_SEQ_START);
        assert_eq!(second.seq(), FEED_SEQ_START + 1);
        assert_eq!(feed.head_seq(), FEED_SEQ_START + 1);
    }

    #[test]
    fn safe_seq_never_passes_an_in_flight_write() {
        let feed = feed();
        let first = feed.allocate("a".into());
        let second = feed.allocate("b".into());

        second.commit(FeedChangeKind::Upsert);
        assert_eq!(feed.safe_seq(), FEED_SEQ_START - 1);

        first.commit(FeedChangeKind::Upsert);
        assert_eq!(feed.safe_seq(), FEED_SEQ_START + 1);
    }

    #[test]
    fn a_dropped_allocation_burns_its_sequence_number() {
        let feed = feed();
        {
            let _lost = feed.allocate("a".into());
            assert_eq!(feed.safe_seq(), FEED_SEQ_START - 1);
        }
        assert_eq!(feed.safe_seq(), FEED_SEQ_START);
        assert_eq!(feed.head_seq(), FEED_SEQ_START);
    }

    #[tokio::test]
    async fn commit_notifies_subscribers() {
        let feed = feed();
        let mut receiver = feed.subscribe();
        feed.allocate("doc".into())
            .commit(FeedChangeKind::Tombstoned);
        let notice = receiver.recv().await.expect("notice");
        assert_eq!(notice.id, "doc");
        assert_eq!(notice.kind, FeedChangeKind::Tombstoned);
        assert_eq!(notice.seq, FEED_SEQ_START);
    }

    #[test]
    fn a_truncated_page_never_splits_one_sequence_number() {
        let row =
            |seq: i64| FeedRow::purged(seq, format!("id{seq}"), Timestamp::from_millis(0), None);

        let mut rows = vec![row(1), row(2), row(3), row(4)];
        assert!(truncate_at_seq_boundary(&mut rows, 2));
        assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);

        let mut rows = vec![row(1), row(2), row(2), row(3)];
        assert!(truncate_at_seq_boundary(&mut rows, 2));
        assert_eq!(
            rows.iter().map(|r| r.seq).collect::<Vec<_>>(),
            vec![1, 2, 2]
        );

        let mut rows = vec![row(9)];
        assert!(!truncate_at_seq_boundary(&mut rows, 5));
        let mut rows = vec![row(9), row(9), row(9)];
        assert!(truncate_at_seq_boundary(&mut rows, 1));
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn purge_rows_carry_no_content() {
        let row = FeedRow::purged(7, "id".into(), Timestamp::from_millis(0), None);
        assert!(row.purged && row.deleted);
        assert!(row.content.is_none());
    }
}
