use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use bson::spec::BinarySubtype;
use bson::{Binary, Bson, DateTime as BsonDateTime, Document as BsonDocument, doc};
use ddd_core::date::Date;
use ddd_core::document::{ParsedDocument, normalize_input, parse_document};
use ddd_core::limits;
use ddd_core::value::{Map, Value, map_to_bson};
use futures::TryStreamExt;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, Update};

use crate::db;
use crate::domain::{
    Actor, AuditEntry, Document, DocumentChange, DocumentCheckpoint, DocumentHistory, DocumentRow,
    DocumentSnapshot, DocumentUpdate, Id, StoredHunk, is_valid_id, new_id,
};
use crate::telemetry::names;

pub const TEXT_ROOT: &str = "content";
pub const OFFSET_KIND: OffsetKind = OffsetKind::Utf16;
pub const SKIP_GC: bool = false;

pub const MATERIALIZE_DEBOUNCE: Duration = Duration::from_millis(500);
pub const ROOM_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
pub const UPDATE_LOG_KEEP_BYTES: u64 = 1024 * 1024;
pub const UPDATE_LOG_KEEP_COUNT: u32 = 200;
pub const CHECKPOINT_EVERY_CHANGES: u32 = 1000;
const COALESCE_GAP_MS: i64 = 2_000;
const COALESCE_SPAN_MS: i64 = 10_000;
pub const RAW_CHANGE_DAYS: i64 = 30;
pub const CRDT_COMPACT_THRESHOLD_BYTES: u64 = 4 * 1024 * 1024;
pub const CRDT_ALERT_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024;
pub const TRASH_RETENTION_DAYS: i64 = 30;
pub const DEFAULT_PAGE_LIMIT: u32 = 50;
pub const MAX_PAGE_LIMIT: u32 = 500;

const DAY_MS: i64 = 86_400_000;
const TRIM_EVERY: i64 = 32;

pub fn doc_options() -> Options {
    Options {
        offset_kind: OFFSET_KIND,
        skip_gc: SKIP_GC,
        ..Options::default()
    }
}

pub fn new_doc() -> Doc {
    Doc::with_options(doc_options())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocStoreTuning {
    pub max_document_bytes: usize,
    pub materialize_debounce: Duration,
    pub room_idle_timeout: Duration,
    pub update_log_keep_bytes: u64,
    pub update_log_keep_count: u32,
    pub crdt_compact_threshold_bytes: u64,
    pub crdt_alert_threshold_bytes: u64,
    pub trash_retention_days: i64,
    pub checkpoint_every_changes: u32,
    pub raw_change_days: i64,
    pub history_squash_interval: Duration,
}

impl Default for DocStoreTuning {
    fn default() -> Self {
        Self {
            max_document_bytes: limits::MAX_DOCUMENT_BYTES,
            materialize_debounce: MATERIALIZE_DEBOUNCE,
            room_idle_timeout: ROOM_IDLE_TIMEOUT,
            update_log_keep_bytes: UPDATE_LOG_KEEP_BYTES,
            update_log_keep_count: UPDATE_LOG_KEEP_COUNT,
            crdt_compact_threshold_bytes: CRDT_COMPACT_THRESHOLD_BYTES,
            crdt_alert_threshold_bytes: CRDT_ALERT_THRESHOLD_BYTES,
            trash_retention_days: TRASH_RETENTION_DAYS,
            checkpoint_every_changes: CHECKPOINT_EVERY_CHANGES,
            raw_change_days: RAW_CHANGE_DAYS,
            history_squash_interval: Duration::from_secs(3600),
        }
    }
}

impl DocStoreTuning {
    pub fn from_config(config: &crate::config::Config) -> Self {
        Self {
            max_document_bytes: config.max_document_bytes,
            materialize_debounce: config.materialize_debounce,
            room_idle_timeout: config.room_idle_timeout,
            update_log_keep_bytes: config.update_log_keep_bytes,
            update_log_keep_count: config.update_log_keep_count,
            crdt_compact_threshold_bytes: config.crdt_compact_threshold_bytes,
            crdt_alert_threshold_bytes: config.crdt_alert_threshold_bytes,
            trash_retention_days: i64::from(config.trash_retention_days),
            checkpoint_every_changes: config.checkpoint_every_changes.max(1),
            raw_change_days: i64::from(config.raw_change_days),
            history_squash_interval: config.history_squash_interval,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Materialized {
    pub content: String,
    pub title: String,
    pub fm: BsonDocument,
    pub plugins: BsonDocument,
    pub fm_parse_error: bool,
    pub materialized_version: String,
}

pub fn materialize(text: &str, materialized_version: String) -> Materialized {
    let normalized = normalize_input(text);
    let parsed = parse_document(normalized.as_ref());
    materialize_parsed(&parsed, normalized.as_ref(), materialized_version)
}

pub fn materialize_parsed(
    parsed: &ParsedDocument,
    text: &str,
    materialized_version: String,
) -> Materialized {
    Materialized {
        content: text.to_string(),
        title: parsed.title.clone(),
        fm: map_to_bson(&canonicalize_dates(&parsed.fm)),
        plugins: map_to_bson(&canonicalize_dates(&parsed.plugins)),
        fm_parse_error: parsed.fm_parse_error,
        materialized_version,
    }
}

fn canonicalize_dates(map: &Map) -> Map {
    map.iter()
        .map(|(key, value)| (key.clone(), canonicalize_date_value(value)))
        .collect()
}

fn canonicalize_date_value(value: &Value) -> Value {
    match value {
        Value::Str(raw) if Date::looks_like_date(raw) => Value::Str(Date::normalize_str(raw)),
        Value::List(items) => Value::List(items.iter().map(canonicalize_date_value).collect()),
        Value::Map(inner) => Value::Map(canonicalize_dates(inner)),
        other => other.clone(),
    }
}

pub fn version_hash(state_vector: &[u8]) -> String {
    let digest = Sha256::digest(state_vector);
    hex::encode(&digest[..16])
}

#[derive(Debug, Clone)]
pub struct WriteOutcome {
    pub id: Id,
    pub content: String,
    pub title: String,
    pub materialized_version: String,
    pub update: Vec<u8>,
    pub seq: i64,
}

#[derive(Debug, Clone)]
pub struct CrdtState {
    pub id: Id,
    pub state: Vec<u8>,
    pub state_vector: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct DocStoreStats {
    pub rooms: usize,
    pub dirty_rooms: usize,
    pub oversized_docs: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ListQuery {
    pub filter: Option<BsonDocument>,
    pub sort: Option<BsonDocument>,
    pub search: Option<String>,
    pub cursor: Option<String>,
    pub limit: u32,
    pub trash: TrashFilter,
    pub metadata_only: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TrashFilter {
    #[default]
    Live,
    Trashed,
    All,
}

#[derive(Debug, Clone)]
pub struct Page {
    pub documents: Vec<DocumentRow>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Error)]
pub enum DocStoreError {
    #[error("document {0} not found")]
    NotFound(Id),
    #[error("document {0} already exists")]
    AlreadyExists(Id),
    #[error("document {0} was permanently deleted")]
    Graveyarded(Id),
    #[error("document text is {len} bytes, limit is {limit}")]
    TooLarge { len: usize, limit: usize },
    #[error("invalid document id: {0}")]
    InvalidId(String),
    #[error("malformed CRDT update: {0}")]
    MalformedUpdate(String),
    #[error("write lost the optimistic-concurrency race for {0}; retry")]
    Contended(Id),
    #[error("snapshot {0} not found")]
    SnapshotNotFound(Id),
    #[error("the history of {0} cannot be rebuilt at seq {1}")]
    HistoryGap(Id, i64),
    #[error("the splice is not representable: {0}")]
    SpliceRefused(String),
    #[error("database error: {0}")]
    Db(#[from] mongodb::error::Error),
    #[error("bson error: {0}")]
    Bson(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditTiming {
    Live,
    Offline { made_at_ms: Option<i64> },
}

pub type SpliceFn<'a> =
    &'a (dyn Fn(&str) -> Result<Vec<ddd_core::splice::TextEdit>, String> + Send + Sync);

#[async_trait]
pub trait DocStore: Send + Sync + 'static {
    async fn create(
        &self,
        id: Option<Id>,
        text: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    async fn create_from_update(
        &self,
        id: Id,
        update: &[u8],
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    async fn replace_text(
        &self,
        id: &str,
        text: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    async fn splice(
        &self,
        id: &str,
        compute: SpliceFn<'_>,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    async fn apply_update(
        &self,
        id: &str,
        update: &[u8],
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        self.apply_update_as(id, update, actor, EditTiming::Live)
            .await
    }

    async fn apply_update_as(
        &self,
        id: &str,
        update: &[u8],
        actor: &Actor,
        timing: EditTiming,
    ) -> Result<WriteOutcome, DocStoreError>;

    async fn text(&self, id: &str) -> Result<String, DocStoreError>;

    async fn get(&self, id: &str) -> Result<Document, DocStoreError>;

    async fn get_stale(&self, id: &str) -> Result<Document, DocStoreError>;

    async fn crdt_state(&self, id: &str) -> Result<CrdtState, DocStoreError>;

    async fn diff(&self, id: &str, since: &[u8]) -> Result<Vec<u8>, DocStoreError>;

    async fn list(&self, query: &ListQuery) -> Result<Page, DocStoreError>;

    async fn count(&self, query: &ListQuery) -> Result<u64, DocStoreError>;

    async fn tombstone(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;

    async fn untombstone(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;

    async fn purge(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;

    async fn is_graveyarded(&self, id: &str) -> Result<bool, DocStoreError>;

    async fn snapshot(&self, id: &str, reason: &str, actor: &Actor) -> Result<Id, DocStoreError>;

    async fn snapshots(&self, id: &str) -> Result<Vec<DocumentSnapshot>, DocStoreError>;

    async fn changes(
        &self,
        id: &str,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<DocumentChange>, DocStoreError>;

    async fn changes_since(
        &self,
        id: &str,
        from: i64,
    ) -> Result<Vec<crate::changes::Change>, DocStoreError>;

    async fn squashed(
        &self,
        id: &str,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<DocumentHistory>, DocStoreError>;

    async fn squash_history_now(&self) -> Result<usize, DocStoreError>;

    async fn forget_history(&self, id: &str) -> Result<(), DocStoreError>;

    async fn text_at(&self, id: &str, seq: i64) -> Result<String, DocStoreError>;

    async fn note_revert(
        &self,
        id: &str,
        seq: i64,
        from: i64,
        to: i64,
    ) -> Result<(), DocStoreError>;

    async fn snapshot_by_id(
        &self,
        id: &str,
        snapshot_id: &str,
    ) -> Result<DocumentSnapshot, DocStoreError>;

    async fn restore_snapshot(
        &self,
        id: &str,
        snapshot_id: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    async fn flush(&self, id: &str) -> Result<(), DocStoreError>;

    async fn flush_all(&self) -> Result<(), DocStoreError>;

    async fn evict_idle(&self) -> Result<usize, DocStoreError>;

    fn stats(&self) -> DocStoreStats;
}

#[derive(Clone)]
pub struct MongoDocStore {
    inner: std::sync::Arc<MongoDocStoreInner>,
}

struct MongoDocStoreInner {
    collections: db::Collections,
    tuning: DocStoreTuning,
    feed: Arc<crate::feed::ChangeFeed>,
    rooms: std::sync::Mutex<HashMap<Id, Arc<Room>>>,
    oversized_docs: std::sync::Mutex<HashSet<Id>>,
}

struct Room {
    id: Id,
    state: Mutex<RoomState>,
    last_touched_ms: AtomicI64,
    dirty: AtomicBool,
}

struct RoomState {
    doc: Doc,
    text: String,
    dirty: bool,
    seq: i64,
    stored_version: String,
    stored_title: String,
    pending_actor: Option<String>,
    pending_updated_at: Option<BsonDateTime>,
    changes_since_checkpoint: u32,
    last_change_ms: i64,
    open_record: Option<OpenRecord>,
}

struct OpenRecord {
    first_seq: i64,
    seq: i64,
    started_ms: i64,
    last_ms: i64,
    by: String,
    before: String,
}

impl Room {
    fn touch(&self) {
        self.last_touched_ms.store(now_ms(), Ordering::Relaxed);
    }
}

impl MongoDocStore {
    pub fn new(
        db: mongodb::Database,
        tuning: DocStoreTuning,
        feed: Arc<crate::feed::ChangeFeed>,
    ) -> Self {
        Self {
            inner: std::sync::Arc::new(MongoDocStoreInner {
                collections: db::Collections::new(db),
                tuning,
                feed,
                rooms: std::sync::Mutex::new(HashMap::new()),
                oversized_docs: std::sync::Mutex::new(HashSet::new()),
            }),
        }
    }

    pub fn tuning(&self) -> DocStoreTuning {
        self.inner.tuning
    }

    pub fn spawn_workers(&self) -> DocStoreWorkers {
        let mut handles = Vec::new();

        let store = self.clone();
        handles.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(store.inner.tuning.materialize_debounce);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if let Err(err) = store.flush_all().await {
                    tracing::warn!(error = %err, "debounced materialization flush failed");
                }
            }
        }));

        let store = self.clone();
        handles.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(60));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                match store.evict_idle().await {
                    Ok(0) => {}
                    Ok(n) => tracing::debug!(evicted = n, "evicted idle rooms"),
                    Err(err) => tracing::warn!(error = %err, "room eviction failed"),
                }
            }
        }));

        let store = self.clone();
        handles.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(3600));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                match store.inner.purge_expired_trash().await {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(purged = n, "purged expired trash"),
                    Err(err) => tracing::warn!(error = %err, "trash purge failed"),
                }
            }
        }));

        let store = self.clone();
        handles.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(store.inner.tuning.history_squash_interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                match store.inner.squash_history().await {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(groups = n, "squashed old change history"),
                    Err(err) => tracing::warn!(error = %err, "history squash failed"),
                }
            }
        }));

        DocStoreWorkers { handles }
    }
}

pub struct DocStoreWorkers {
    handles: Vec<tokio::task::JoinHandle<()>>,
}

impl DocStoreWorkers {
    pub async fn shutdown(self) {
        for handle in self.handles {
            handle.abort();
        }
    }
}

enum Mutation<'a> {
    SetText(&'a str),
    Splice(SpliceFn<'a>),
    Update(&'a [u8]),
}

fn effective_limit(max_document_bytes: usize) -> usize {
    max_document_bytes.min(limits::MAX_DOCUMENT_BYTES)
}

impl MongoDocStoreInner {
    fn check_size(&self, text: &str) -> Result<(), DocStoreError> {
        let limit = effective_limit(self.tuning.max_document_bytes);
        if text.len() > limit {
            return Err(DocStoreError::TooLarge {
                len: text.len(),
                limit,
            });
        }
        Ok(())
    }

    fn cached_room(&self, id: &str) -> Option<Arc<Room>> {
        let rooms = self.rooms.lock().expect("room registry poisoned");
        rooms.get(id).cloned()
    }

    fn insert_room(&self, room: Room) -> Arc<Room> {
        let mut rooms = self.rooms.lock().expect("room registry poisoned");
        match rooms.entry(room.id.clone()) {
            std::collections::hash_map::Entry::Occupied(existing) => existing.get().clone(),
            std::collections::hash_map::Entry::Vacant(slot) => {
                let room = Arc::new(room);
                slot.insert(room.clone());
                room
            }
        }
    }

    fn drop_room(&self, id: &str) {
        let mut rooms = self.rooms.lock().expect("room registry poisoned");
        rooms.remove(id);
    }

    fn all_rooms(&self) -> Vec<Arc<Room>> {
        let rooms = self.rooms.lock().expect("room registry poisoned");
        rooms.values().cloned().collect()
    }

    async fn room(&self, id: &str) -> Result<Arc<Room>, DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        if let Some(room) = self.cached_room(id) {
            room.touch();
            return Ok(room);
        }
        let loaded = self.load_room(id).await?;
        let room = self.insert_room(loaded);
        room.touch();
        Ok(room)
    }

    async fn load_room(&self, id: &str) -> Result<Room, DocStoreError> {
        let stored = self
            .collections
            .documents()
            .find_one(doc! { "_id": id })
            .await?
            .ok_or_else(|| DocStoreError::NotFound(id.to_string()))?;

        let doc = new_doc();
        {
            let text_ref = doc.get_or_insert_text(TEXT_ROOT);
            let _ = &text_ref;
        }
        if !stored.crdt.bytes.is_empty() {
            let update = Update::decode_v1(&stored.crdt.bytes)
                .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
            let mut txn = doc.transact_mut();
            txn.apply_update(update)
                .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
        }

        let mut seq = 0_i64;
        let mut cursor = self
            .collections
            .document_updates()
            .find(doc! { "document_id": id })
            .sort(doc! { "seq": 1 })
            .await?;
        while let Some(entry) = cursor.try_next().await? {
            seq = seq.max(entry.seq);
            if entry.update.bytes.is_empty() {
                continue;
            }
            let update = Update::decode_v1(&entry.update.bytes)
                .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
            let mut txn = doc.transact_mut();
            txn.apply_update(update)
                .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
        }

        let text = {
            let text_ref = doc.get_or_insert_text(TEXT_ROOT);
            let txn = doc.transact();
            text_ref.get_string(&txn)
        };
        let dirty = text != stored.content;

        let checkpoint_seq = self
            .collections
            .document_checkpoints()
            .find(doc! { "document_id": id })
            .sort(doc! { "seq": -1 })
            .limit(1)
            .await?
            .try_next()
            .await?
            .map_or(0, |checkpoint| checkpoint.seq);
        let changes_since_checkpoint = self
            .collections
            .document_changes()
            .count_documents(doc! { "document_id": id, "seq": { "$gt": checkpoint_seq } })
            .await? as u32;
        let last_change_ms = self
            .collections
            .document_changes()
            .find(doc! { "document_id": id })
            .sort(doc! { "seq": -1 })
            .limit(1)
            .await?
            .try_next()
            .await?
            .map_or(0, |change| change.created_at.timestamp_millis());

        Ok(Room {
            id: id.to_string(),
            dirty: AtomicBool::new(dirty),
            last_touched_ms: AtomicI64::new(now_ms()),
            state: Mutex::new(RoomState {
                doc,
                text,
                dirty,
                seq,
                stored_version: stored.materialized_version,
                stored_title: stored.title,
                pending_actor: None,
                pending_updated_at: None,
                changes_since_checkpoint,
                last_change_ms,
                open_record: None,
            }),
        })
    }

    async fn mutate(
        &self,
        id: &str,
        mutation: Mutation<'_>,
        actor: &Actor,
        timing: EditTiming,
    ) -> Result<WriteOutcome, DocStoreError> {
        let room = self.room(id).await?;
        let mut state = room.state.lock().await;

        let mut spliced: Vec<ddd_core::splice::TextEdit> = Vec::new();
        let candidate: String = match mutation {
            Mutation::SetText(text) => normalize_input(text).into_owned(),
            Mutation::Splice(compute) => {
                spliced = compute(&state.text).map_err(DocStoreError::SpliceRefused)?;
                ddd_core::splice::apply(&state.text, &spliced)
            }
            Mutation::Update(update) => {
                let scratch = new_doc();
                let scratch_text = scratch.get_or_insert_text(TEXT_ROOT);
                {
                    let current = {
                        let txn = state.doc.transact();
                        txn.encode_state_as_update_v1(&StateVector::default())
                    };
                    let mut txn = scratch.transact_mut();
                    let base = Update::decode_v1(&current)
                        .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
                    txn.apply_update(base)
                        .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
                    let incoming = Update::decode_v1(update)
                        .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
                    txn.apply_update(incoming)
                        .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
                }
                let txn = scratch.transact();
                scratch_text.get_string(&txn)
            }
        };
        self.check_size(&candidate)?;

        if !matches!(mutation, Mutation::Update(_)) && candidate == state.text {
            return Ok(WriteOutcome {
                id: room.id.clone(),
                content: state.text.clone(),
                title: state.stored_title.clone(),
                materialized_version: state.stored_version.clone(),
                update: Vec::new(),
                seq: state.seq,
            });
        }

        let text_ref = state.doc.get_or_insert_text(TEXT_ROOT);
        let before = {
            let txn = state.doc.transact();
            txn.state_vector()
        };
        {
            let mut txn = state.doc.transact_mut();
            match mutation {
                Mutation::SetText(_) => {
                    if let Some(delta) = text_delta(&state.text, &candidate) {
                        delta.apply(&mut txn, &text_ref);
                    }
                }
                Mutation::Splice(_) => {
                    for delta in edit_deltas(&state.text, &spliced)? {
                        delta.apply(&mut txn, &text_ref);
                    }
                }
                Mutation::Update(update) => {
                    let update = Update::decode_v1(update)
                        .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
                    txn.apply_update(update)
                        .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
                }
            }
        }

        let (update, text_after) = {
            let txn = state.doc.transact();
            (txn.encode_diff_v1(&before), text_ref.get_string(&txn))
        };

        if update.is_empty() && text_after == state.text {
            return Ok(WriteOutcome {
                id: room.id.clone(),
                content: state.text.clone(),
                title: state.stored_title.clone(),
                materialized_version: state.stored_version.clone(),
                update: Vec::new(),
                seq: state.seq,
            });
        }

        let hunks = match mutation {
            Mutation::Splice(_) => crate::changes::hunks_from_edits(&state.text, &spliced),
            _ => crate::changes::hunks_between(&state.text, &text_after),
        };
        let foldable = matches!(mutation, Mutation::Update(_))
            && timing == EditTiming::Live
            && !hunks.is_empty();
        let text_before = foldable.then(|| state.text.clone());

        state.text = text_after;

        let seq = state.seq + 1;
        self.append_update(&room.id, seq, &update, actor).await?;
        if !hunks.is_empty() {
            let now = now_ms();
            let (made_at, offline) = match timing {
                EditTiming::Live => (now, false),
                EditTiming::Offline { made_at_ms } => (
                    made_at_ms
                        .unwrap_or(now)
                        .clamp(state.last_change_ms.min(now), now),
                    true,
                ),
            };
            let made_at = made_at.max(state.last_change_ms);
            state.last_change_ms = made_at;
            let by = actor.as_stored();

            let fold = foldable
                && state.open_record.as_ref().is_some_and(|open| {
                    open.by == by
                        && made_at - open.last_ms <= COALESCE_GAP_MS
                        && made_at - open.started_ms <= COALESCE_SPAN_MS
                });
            let folded = if fold {
                let open = state.open_record.as_ref().expect("checked above");
                let merged = crate::changes::hunks_between(&open.before, &state.text);
                let (first_seq, previous) = (open.first_seq, open.seq);
                self.extend_change(&room.id, previous, first_seq, seq, merged, made_at)
                    .await?
            } else {
                false
            };
            if folded {
                let open = state.open_record.as_mut().expect("checked above");
                open.seq = seq;
                open.last_ms = made_at;
            } else {
                self.append_change(&room.id, seq, hunks, actor, made_at, offline)
                    .await?;
                state.changes_since_checkpoint += 1;
                state.open_record = text_before.map(|before| OpenRecord {
                    first_seq: seq,
                    seq,
                    started_ms: made_at,
                    last_ms: made_at,
                    by,
                    before,
                });
                if state.changes_since_checkpoint >= self.tuning.checkpoint_every_changes {
                    self.write_checkpoint(&room.id, seq, &state.text).await?;
                    state.changes_since_checkpoint = 0;
                    state.open_record = None;
                }
            }
        } else if !matches!(mutation, Mutation::Update(_)) {
            state.open_record = None;
        }
        state.seq = seq;
        metrics::counter!(names::UPDATES_APPLIED).increment(1);

        state.dirty = true;
        room.dirty.store(true, Ordering::Relaxed);
        state.pending_actor = Some(actor.as_stored());
        state.pending_updated_at = Some(BsonDateTime::now());

        let materialized = self.materialize_room(&room, &mut state).await?;

        if seq % TRIM_EVERY == 0 {
            self.trim_update_log(&room.id).await?;
        }

        room.touch();
        Ok(WriteOutcome {
            id: room.id.clone(),
            content: materialized.content,
            title: materialized.title,
            materialized_version: materialized.materialized_version,
            update,
            seq,
        })
    }

    async fn materialize_room(
        &self,
        room: &Arc<Room>,
        state: &mut RoomState,
    ) -> Result<Materialized, DocStoreError> {
        let started = std::time::Instant::now();

        let (crdt, state_vector) = {
            let txn = state.doc.transact();
            (
                txn.encode_state_as_update_v1(&StateVector::default()),
                txn.state_vector().encode_v1(),
            )
        };

        let crdt_len = crdt.len() as u64;
        if crdt_len > self.tuning.crdt_alert_threshold_bytes {
            tracing::warn!(document = %room.id, bytes = crdt_len, "crdt blob above alert threshold");
        }
        {
            let mut oversized = self.oversized_docs.lock().expect("oversized set poisoned");
            if crdt_len > self.tuning.crdt_compact_threshold_bytes {
                oversized.insert(room.id.clone());
            } else {
                oversized.remove(&room.id);
            }
        }

        let materialized = materialize(&state.text, version_hash(&state_vector));

        let feed_allocation = self.feed.allocate(room.id.clone());

        let updated_at = state.pending_updated_at.unwrap_or_else(BsonDateTime::now);
        let mut set = doc! {
            "feed_seq": feed_allocation.seq(),
            "crdt": Bson::Binary(binary(crdt)),
            "state_vector": Bson::Binary(binary(state_vector)),
            "content": &materialized.content,
            "title": &materialized.title,
            "fm": &materialized.fm,
            "plugins": &materialized.plugins,
            "materialized_version": &materialized.materialized_version,
            "fm_parse_error": materialized.fm_parse_error,
            "updated_at": updated_at,
        };
        if let Some(actor) = &state.pending_actor {
            set.insert("updated_by", actor.clone());
        }

        let result = self
            .collections
            .documents()
            .update_one(
                doc! { "_id": &room.id, "materialized_version": &state.stored_version },
                doc! { "$set": set },
            )
            .await;

        let result = match result {
            Ok(result) => result,
            Err(err) => {
                metrics::counter!(names::MATERIALIZE_FAILURES).increment(1);
                return Err(err.into());
            }
        };

        if result.matched_count == 0 {
            metrics::counter!(names::MATERIALIZE_FAILURES).increment(1);
            self.drop_room(&room.id);
            return Err(DocStoreError::Contended(room.id.clone()));
        }

        state.stored_title = materialized.title.clone();
        state.stored_version = materialized.materialized_version.clone();
        state.dirty = false;
        state.pending_actor = None;
        state.pending_updated_at = None;
        room.dirty.store(false, Ordering::Relaxed);

        feed_allocation.commit(crate::feed::FeedChangeKind::Upsert);

        metrics::histogram!(names::MATERIALIZE_LATENCY).record(started.elapsed().as_secs_f64());
        Ok(materialized)
    }

    async fn append_update(
        &self,
        document_id: &str,
        seq: i64,
        update: &[u8],
        actor: &Actor,
    ) -> Result<(), DocStoreError> {
        let entry = DocumentUpdate {
            id: new_id(),
            document_id: document_id.to_string(),
            seq,
            update: binary(update.to_vec()),
            created_at: BsonDateTime::now(),
            created_by: Some(actor.as_stored()),
        };
        self.collections
            .document_updates()
            .insert_one(entry)
            .await?;
        Ok(())
    }

    async fn squashed_around(
        &self,
        id: &str,
        seq: i64,
    ) -> Result<Option<DocumentHistory>, DocStoreError> {
        Ok(self
            .collections
            .document_history()
            .find_one(
                doc! { "document_id": id, "from_seq": { "$lte": seq }, "to_seq": { "$gt": seq } },
            )
            .await?)
    }

    async fn history_units(
        &self,
        id: &str,
        after: i64,
        upto: i64,
    ) -> Result<Vec<crate::changes::Change>, DocStoreError> {
        let mut squashed = Vec::new();
        let mut cursor = self
            .collections
            .document_history()
            .find(doc! { "document_id": id, "from_seq": { "$gt": after }, "to_seq": { "$lte": upto } })
            .sort(doc! { "from_seq": 1 })
            .await?;
        while let Some(group) = cursor.try_next().await? {
            squashed.push(group);
        }
        let covered = |seq: i64| {
            squashed
                .iter()
                .any(|group| group.from_seq <= seq && seq <= group.to_seq)
        };

        let mut units: Vec<crate::changes::Change> =
            squashed.iter().map(DocumentHistory::to_change).collect();
        let mut cursor = self
            .collections
            .document_changes()
            .find(doc! { "document_id": id, "seq": { "$gt": after, "$lte": upto } })
            .sort(doc! { "seq": 1 })
            .await?;
        while let Some(change) = cursor.try_next().await? {
            if covered(change.seq) {
                continue;
            }
            let unit = change.to_change();
            if unit.first_seq <= after {
                return Err(DocStoreError::HistoryGap(id.to_string(), after));
            }
            units.push(unit);
        }
        units.sort_by_key(|unit| unit.seq);
        Ok(units)
    }

    async fn text_at(&self, id: &str, seq: i64) -> Result<String, DocStoreError> {
        let gap = || DocStoreError::HistoryGap(id.to_string(), seq);
        let inside_folded = self
            .collections
            .document_changes()
            .find_one(
                doc! { "document_id": id, "first_seq": { "$lte": seq }, "seq": { "$gt": seq } },
            )
            .await?
            .is_some();
        if inside_folded || self.squashed_around(id, seq).await?.is_some() {
            return Err(gap());
        }
        let mut checkpoints = self
            .collections
            .document_checkpoints()
            .find(doc! { "document_id": id, "seq": { "$lte": seq } })
            .sort(doc! { "seq": -1 })
            .await?;
        while let Some(checkpoint) = checkpoints.try_next().await? {
            if self.squashed_around(id, checkpoint.seq).await?.is_some() {
                continue;
            }
            let units = self.history_units(id, checkpoint.seq, seq).await?;
            return crate::changes::replay(&checkpoint.text, &units).map_err(|_| gap());
        }
        Err(gap())
    }

    async fn squash_history(&self) -> Result<usize, DocStoreError> {
        let cutoff = now_ms() - self.tuning.raw_change_days * DAY_MS;
        let ids: Vec<String> = self
            .collections
            .raw(db::DOCUMENT_CHANGES)
            .distinct(
                "document_id",
                doc! { "created_at": { "$lt": BsonDateTime::from_millis(cutoff) } },
            )
            .await?
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
        let mut written = 0;
        for id in ids {
            written += self.squash_document(&id, cutoff).await?;
        }
        Ok(written)
    }

    async fn squash_document(&self, id: &str, cutoff_ms: i64) -> Result<usize, DocStoreError> {
        let mut records: Vec<DocumentChange> = Vec::new();
        let mut cursor = self
            .collections
            .document_changes()
            .find(doc! { "document_id": id, "created_at": { "$lt": BsonDateTime::from_millis(cutoff_ms) } })
            .sort(doc! { "seq": 1 })
            .await?;
        while let Some(change) = cursor.try_next().await? {
            records.push(change);
        }
        let Some(last) = records.last() else {
            return Ok(0);
        };
        let next = self
            .collections
            .document_changes()
            .find_one(doc! { "document_id": id, "seq": { "$gt": last.seq } })
            .sort(doc! { "seq": 1 })
            .await?;

        let newest_first: Vec<crate::changes::Change> = records
            .iter()
            .rev()
            .map(DocumentChange::to_change)
            .collect();
        let mut groups = crate::changes::group(&newest_first, crate::changes::GROUP_GAP_MS);
        groups.reverse();
        if let (Some(open), Some(next)) = (groups.last(), next.as_ref()) {
            let continues = open.by == next.created_by
                && next.created_at.timestamp_millis() - open.ended_ms
                    <= crate::changes::GROUP_GAP_MS;
            if continues {
                groups.pop();
            }
        }
        let Some(first) = groups.first() else {
            return Ok(0);
        };

        let gap = |seq: i64| DocStoreError::HistoryGap(id.to_string(), seq);
        let mut text = self.text_at(id, first.from_seq - 1).await?;
        let by_seq: std::collections::HashMap<i64, &DocumentChange> =
            records.iter().map(|record| (record.seq, record)).collect();
        let mut written = 0;
        for group in &groups {
            let members: Vec<&DocumentChange> = (group.from_seq..=group.to_seq)
                .filter_map(|seq| by_seq.get(&seq).copied())
                .collect();
            let before = text.clone();
            for member in &members {
                text = crate::changes::apply_forward(&text, &member.to_change())
                    .map_err(|_| gap(member.seq))?;
            }
            let reverts = match members.as_slice() {
                [only] => only.reverts.clone(),
                _ => None,
            };
            let offline = members.iter().any(|member| member.offline);
            let hunks = crate::changes::hunks_between(&before, &text)
                .into_iter()
                .map(|hunk| StoredHunk {
                    pos: hunk.pos as i64,
                    removed: hunk.removed,
                    inserted: hunk.inserted,
                })
                .collect::<Vec<_>>();
            let record = DocumentHistory {
                id: new_id(),
                document_id: id.to_string(),
                from_seq: group.from_seq,
                to_seq: group.to_seq,
                started_at: BsonDateTime::from_millis(group.started_ms),
                ended_at: BsonDateTime::from_millis(group.ended_ms),
                created_by: group.by.clone(),
                changes: group.changes as i64,
                hunks,
                reverts,
                offline,
            };
            let fields =
                bson::to_document(&record).map_err(|err| DocStoreError::Bson(err.to_string()))?;
            let mut fields = fields;
            fields.remove("_id");
            self.collections
                .raw(db::DOCUMENT_HISTORY)
                .update_one(
                    doc! { "document_id": id, "from_seq": group.from_seq },
                    doc! { "$set": fields, "$setOnInsert": { "_id": new_id() } },
                )
                .upsert(true)
                .await?;
            let interior =
                doc! { "document_id": id, "seq": { "$gte": group.from_seq, "$lt": group.to_seq } };
            if self
                .collections
                .document_checkpoints()
                .count_documents(interior.clone())
                .await?
                > 0
            {
                let exists = self
                    .collections
                    .document_checkpoints()
                    .find_one(doc! { "document_id": id, "seq": group.to_seq })
                    .await?
                    .is_some();
                if !exists {
                    self.write_checkpoint(id, group.to_seq, &text).await?;
                }
                self.collections
                    .document_checkpoints()
                    .delete_many(interior)
                    .await?;
            }
            self.collections
                .document_changes()
                .delete_many(doc! { "document_id": id, "seq": { "$gte": group.from_seq, "$lte": group.to_seq } })
                .await?;
            written += 1;
        }
        Ok(written)
    }

    async fn append_change(
        &self,
        document_id: &str,
        seq: i64,
        hunks: Vec<crate::changes::Hunk>,
        actor: &Actor,
        made_at_ms: i64,
        offline: bool,
    ) -> Result<(), DocStoreError> {
        let entry = DocumentChange {
            id: new_id(),
            document_id: document_id.to_string(),
            seq,
            first_seq: None,
            created_at: BsonDateTime::from_millis(made_at_ms),
            ended_at: None,
            offline,
            received_at: offline.then(BsonDateTime::now),
            created_by: Some(actor.as_stored()),
            hunks: hunks
                .into_iter()
                .map(|hunk| StoredHunk {
                    pos: hunk.pos as i64,
                    removed: hunk.removed,
                    inserted: hunk.inserted,
                })
                .collect(),
            reverts: None,
        };
        self.collections
            .document_changes()
            .insert_one(entry)
            .await?;
        Ok(())
    }

    async fn extend_change(
        &self,
        document_id: &str,
        previous: i64,
        first_seq: i64,
        seq: i64,
        hunks: Vec<crate::changes::Hunk>,
        made_at_ms: i64,
    ) -> Result<bool, DocStoreError> {
        let hunks: Vec<bson::Bson> = hunks
            .into_iter()
            .map(|hunk| {
                bson::Bson::Document(doc! { "pos": hunk.pos as i64, "removed": hunk.removed, "inserted": hunk.inserted })
            })
            .collect();
        let result = self
            .collections
            .document_changes()
            .update_one(
                doc! { "document_id": document_id, "seq": previous },
                doc! { "$set": {
                    "seq": seq,
                    "first_seq": first_seq,
                    "ended_at": BsonDateTime::from_millis(made_at_ms),
                    "hunks": hunks,
                } },
            )
            .await?;
        Ok(result.matched_count == 1)
    }

    async fn write_checkpoint(
        &self,
        document_id: &str,
        seq: i64,
        text: &str,
    ) -> Result<(), DocStoreError> {
        let checkpoint = DocumentCheckpoint {
            id: new_id(),
            document_id: document_id.to_string(),
            seq,
            text: text.to_string(),
            created_at: BsonDateTime::now(),
        };
        self.collections
            .document_checkpoints()
            .insert_one(checkpoint)
            .await?;
        Ok(())
    }

    async fn trim_update_log(&self, document_id: &str) -> Result<(), DocStoreError> {
        let pipeline = vec![
            doc! { "$match": { "document_id": document_id } },
            doc! { "$sort": { "seq": -1 } },
            doc! { "$project": { "seq": 1, "size": { "$bsonSize": "$$ROOT" } } },
        ];
        let mut cursor = self
            .collections
            .raw(db::DOCUMENT_UPDATES)
            .aggregate(pipeline)
            .await?;

        let mut kept = 0_u32;
        let mut bytes = 0_u64;
        let mut cutoff: Option<i64> = None;
        while let Some(entry) = cursor.try_next().await? {
            let seq = entry.get_i64("seq").unwrap_or(0);
            let size = entry
                .get_i32("size")
                .map(i64::from)
                .or_else(|_| entry.get_i64("size"))
                .unwrap_or(0)
                .max(0) as u64;
            kept += 1;
            bytes += size;
            if kept > 1
                && (kept > self.tuning.update_log_keep_count
                    || bytes > self.tuning.update_log_keep_bytes)
            {
                cutoff = Some(seq);
                break;
            }
        }

        if let Some(cutoff) = cutoff {
            self.collections
                .document_updates()
                .delete_many(doc! { "document_id": document_id, "seq": { "$lte": cutoff } })
                .await?;
        }
        Ok(())
    }

    async fn write_snapshot(
        &self,
        document_id: &str,
        state: &RoomState,
        reason: &str,
        actor: &Actor,
    ) -> Result<Id, DocStoreError> {
        let crdt = {
            let txn = state.doc.transact();
            txn.encode_state_as_update_v1(&StateVector::default())
        };
        let title = title_of(&state.text);
        let snapshot = DocumentSnapshot {
            id: new_id(),
            document_id: document_id.to_string(),
            crdt: binary(crdt),
            content: state.text.clone(),
            title,
            created_at: BsonDateTime::now(),
            created_by: Some(actor.as_stored()),
            reason: reason.to_string(),
        };
        let snapshot_id = snapshot.id.clone();
        self.collections
            .document_snapshots()
            .insert_one(snapshot)
            .await?;
        Ok(snapshot_id)
    }

    async fn purge_expired_trash(&self) -> Result<usize, DocStoreError> {
        let cutoff =
            BsonDateTime::from_millis(now_ms() - self.tuning.trash_retention_days * DAY_MS);
        let mut cursor = self
            .collections
            .raw(db::DOCUMENTS)
            .find(doc! { "deleted_at": { "$ne": Bson::Null, "$lt": cutoff } })
            .projection(doc! { "_id": 1, "deleted_by": 1 })
            .await?;

        let mut expired = Vec::new();
        while let Some(row) = cursor.try_next().await? {
            let id = row.get_str("_id").unwrap_or_default().to_string();
            let by = row.get_str("deleted_by").ok().map(str::to_string);
            if !id.is_empty() {
                expired.push((id, by));
            }
        }

        let mut purged = 0;
        for (id, by) in expired {
            let actor = match by {
                Some(stored) if is_valid_id(&stored) => Actor::User(stored),
                _ => Actor::System,
            };
            match self.purge_document(&id, &actor).await {
                Ok(()) => purged += 1,
                Err(err) => tracing::warn!(document = %id, error = %err, "purge failed"),
            }
        }
        Ok(purged)
    }

    async fn purge_document(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }

        let Some(row) = self
            .collections
            .raw(db::DOCUMENTS)
            .find_one(doc! { "_id": id })
            .projection(doc! { "title": 1, "deleted_at": 1, "deleted_by": 1 })
            .await?
        else {
            return Err(DocStoreError::NotFound(id.to_string()));
        };

        let feed_allocation = self.feed.allocate(id.to_string());
        self.collections
            .deleted_ids()
            .update_one(
                doc! { "_id": id },
                doc! {
                    "$setOnInsert": {
                        "deleted_at": BsonDateTime::now(),
                        "deleted_by": actor.as_stored(),
                    },
                    "$set": { "feed_seq": feed_allocation.seq() },
                },
            )
            .upsert(true)
            .await?;

        self.collections
            .documents()
            .delete_one(doc! { "_id": id })
            .await?;
        feed_allocation.commit(crate::feed::FeedChangeKind::Purged);
        self.collections
            .document_updates()
            .delete_many(doc! { "document_id": id })
            .await?;
        self.collections
            .document_snapshots()
            .delete_many(doc! { "document_id": id })
            .await?;
        self.collections
            .document_changes()
            .delete_many(doc! { "document_id": id })
            .await?;
        self.collections
            .document_checkpoints()
            .delete_many(doc! { "document_id": id })
            .await?;
        self.collections
            .document_history()
            .delete_many(doc! { "document_id": id })
            .await?;
        self.drop_room(id);
        self.oversized_docs
            .lock()
            .expect("oversized set poisoned")
            .remove(id);

        let entry = AuditEntry::new(
            "document.purge",
            Some(actor),
            crate::auth::audit::TARGET_DOCUMENT,
            Some(id.to_string()),
        )
        .with_detail(doc! {
            "title": row.get_str("title").unwrap_or_default(),
            "deleted_at": row.get("deleted_at").cloned().unwrap_or(Bson::Null),
            "deleted_by": row.get("deleted_by").cloned().unwrap_or(Bson::Null),
        });
        if let Err(err) = self.collections.audit_log().insert_one(&entry).await {
            tracing::error!(document = %id, error = %err, "audit write failed for document.purge");
        }

        Ok(())
    }

    async fn flush_room(&self, room: &Arc<Room>) -> Result<(), DocStoreError> {
        let mut state = room.state.lock().await;
        if !state.dirty {
            return Ok(());
        }
        self.materialize_room(room, &mut state).await?;
        Ok(())
    }
}

fn list_filter(query: &ListQuery) -> BsonDocument {
    let mut clauses = Vec::new();
    if let Some(filter) = &query.filter
        && !filter.is_empty()
    {
        clauses.push(filter.clone());
    }
    match query.trash {
        TrashFilter::Live => clauses.push(doc! { "deleted_at": Bson::Null }),
        TrashFilter::Trashed => clauses.push(doc! { "deleted_at": { "$ne": Bson::Null } }),
        TrashFilter::All => {}
    }
    if let Some(search) = &query.search {
        let search = search.trim();
        if !search.is_empty() {
            clauses.push(doc! { "$text": { "$search": search } });
        }
    }

    match clauses.len() {
        0 => BsonDocument::new(),
        1 => clauses.remove(0),
        _ => doc! { "$and": clauses },
    }
}

fn row_from_projection(row: BsonDocument) -> Result<DocumentRow, DocStoreError> {
    bson::from_document(row).map_err(|err| DocStoreError::Bson(err.to_string()))
}

impl MongoDocStore {
    async fn insert_new(
        &self,
        id: Id,
        doc: Doc,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        let inner = &self.inner;
        if inner
            .collections
            .deleted_ids()
            .find_one(doc! { "_id": &id })
            .await?
            .is_some()
        {
            return Err(DocStoreError::Graveyarded(id));
        }

        let text_ref = doc.get_or_insert_text(TEXT_ROOT);
        let (update, state_vector, stored_text) = {
            let txn = doc.transact();
            (
                txn.encode_state_as_update_v1(&StateVector::default()),
                txn.state_vector().encode_v1(),
                text_ref.get_string(&txn),
            )
        };

        let materialized = materialize(&stored_text, version_hash(&state_vector));
        let now = BsonDateTime::now();
        let feed_allocation = inner.feed.allocate(id.clone());
        let stored = Document {
            id: id.clone(),
            crdt: binary(update.clone()),
            state_vector: binary(state_vector),
            content: materialized.content.clone(),
            title: materialized.title.clone(),
            fm: materialized.fm.clone(),
            plugins: materialized.plugins.clone(),
            materialized_version: materialized.materialized_version.clone(),
            fm_parse_error: materialized.fm_parse_error,
            created_at: now,
            created_by: Some(actor.as_stored()),
            updated_at: now,
            updated_by: Some(actor.as_stored()),
            deleted_at: None,
            deleted_by: None,
            feed_seq: Some(feed_allocation.seq()),
        };

        if let Err(err) = inner.collections.documents().insert_one(stored).await {
            if is_duplicate_key(&err) {
                return Err(DocStoreError::AlreadyExists(id));
            }
            return Err(err.into());
        }

        feed_allocation.commit(crate::feed::FeedChangeKind::Upsert);

        inner.append_update(&id, 1, &update, actor).await?;
        inner.write_checkpoint(&id, 1, &stored_text).await?;
        metrics::counter!(names::UPDATES_APPLIED).increment(1);

        inner.insert_room(Room {
            id: id.clone(),
            dirty: AtomicBool::new(false),
            last_touched_ms: AtomicI64::new(now_ms()),
            state: Mutex::new(RoomState {
                doc,
                text: stored_text,
                dirty: false,
                seq: 1,
                stored_version: materialized.materialized_version.clone(),
                stored_title: materialized.title.clone(),
                pending_actor: None,
                pending_updated_at: None,
                changes_since_checkpoint: 0,
                last_change_ms: now_ms(),
                open_record: None,
            }),
        });

        Ok(WriteOutcome {
            id,
            content: materialized.content,
            title: materialized.title,
            materialized_version: materialized.materialized_version,
            update,
            seq: 1,
        })
    }
}

#[async_trait]
impl DocStore for MongoDocStore {
    async fn create(
        &self,
        id: Option<Id>,
        text: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        let inner = &self.inner;
        let id = match id {
            Some(id) => {
                if !is_valid_id(&id) {
                    return Err(DocStoreError::InvalidId(id));
                }
                id
            }
            None => new_id(),
        };

        let text = normalize_input(text).into_owned();
        inner.check_size(&text)?;

        let doc = new_doc();
        let text_ref = doc.get_or_insert_text(TEXT_ROOT);
        {
            let mut txn = doc.transact_mut();
            if !text.is_empty() {
                text_ref.insert(&mut txn, 0, &text);
            }
        }
        self.insert_new(id, doc, actor).await
    }

    async fn create_from_update(
        &self,
        id: Id,
        update: &[u8],
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        if !is_valid_id(&id) {
            return Err(DocStoreError::InvalidId(id));
        }
        let doc = new_doc();
        {
            let decoded = Update::decode_v1(update)
                .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
            let mut txn = doc.transact_mut();
            txn.apply_update(decoded)
                .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
        }
        let text = {
            let text_ref = doc.get_or_insert_text(TEXT_ROOT);
            let txn = doc.transact();
            if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
                return Err(DocStoreError::MalformedUpdate(
                    "the state depends on edits it does not include".to_string(),
                ));
            }
            text_ref.get_string(&txn)
        };
        if normalize_input(&text) != text {
            return Err(DocStoreError::MalformedUpdate(
                "the text has a byte-order mark or carriage returns".to_string(),
            ));
        }
        self.inner.check_size(&text)?;
        self.insert_new(id, doc, actor).await
    }

    async fn replace_text(
        &self,
        id: &str,
        text: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        self.inner
            .mutate(id, Mutation::SetText(text), actor, EditTiming::Live)
            .await
    }

    async fn splice(
        &self,
        id: &str,
        compute: SpliceFn<'_>,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        self.inner
            .mutate(id, Mutation::Splice(compute), actor, EditTiming::Live)
            .await
    }

    async fn apply_update_as(
        &self,
        id: &str,
        update: &[u8],
        actor: &Actor,
        timing: EditTiming,
    ) -> Result<WriteOutcome, DocStoreError> {
        self.inner
            .mutate(id, Mutation::Update(update), actor, timing)
            .await
    }

    async fn text(&self, id: &str) -> Result<String, DocStoreError> {
        let room = self.inner.room(id).await?;
        self.inner.flush_room(&room).await?;
        let state = room.state.lock().await;
        Ok(state.text.clone())
    }

    async fn get(&self, id: &str) -> Result<Document, DocStoreError> {
        self.flush(id).await?;
        self.get_stale(id).await
    }

    async fn get_stale(&self, id: &str) -> Result<Document, DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        self.inner
            .collections
            .documents()
            .find_one(doc! { "_id": id })
            .await?
            .ok_or_else(|| DocStoreError::NotFound(id.to_string()))
    }

    async fn crdt_state(&self, id: &str) -> Result<CrdtState, DocStoreError> {
        let room = self.inner.room(id).await?;
        let state = room.state.lock().await;
        let txn = state.doc.transact();
        Ok(CrdtState {
            id: room.id.clone(),
            state: txn.encode_state_as_update_v1(&StateVector::default()),
            state_vector: txn.state_vector().encode_v1(),
        })
    }

    async fn diff(&self, id: &str, since: &[u8]) -> Result<Vec<u8>, DocStoreError> {
        let room = self.inner.room(id).await?;
        let since = StateVector::decode_v1(since)
            .map_err(|err| DocStoreError::MalformedUpdate(err.to_string()))?;
        let state = room.state.lock().await;
        let txn = state.doc.transact();
        Ok(txn.encode_diff_v1(&since))
    }

    async fn list(&self, query: &ListQuery) -> Result<Page, DocStoreError> {
        let inner = &self.inner;
        let filter = list_filter(query);
        let limit = match query.limit {
            0 => DEFAULT_PAGE_LIMIT,
            n => n.min(MAX_PAGE_LIMIT),
        };
        let offset = match &query.cursor {
            Some(cursor) => decode_cursor(cursor)?,
            None => 0,
        };

        let mut sort = query
            .sort
            .clone()
            .unwrap_or_else(|| doc! { "updated_at": -1 });
        if !sort.contains_key("_id") {
            sort.insert("_id", 1);
        }

        let mut projection = doc! { "crdt": 0, "state_vector": 0 };
        if query.metadata_only {
            projection.insert("content", 0);
        }

        let mut cursor = inner
            .collections
            .raw(db::DOCUMENTS)
            .find(filter)
            .projection(projection)
            .sort(sort)
            .skip(offset as u64)
            .limit(i64::from(limit) + 1)
            .await?;

        let mut documents = Vec::new();
        while let Some(row) = cursor.try_next().await? {
            documents.push(row_from_projection(row)?);
        }

        let next_cursor = if documents.len() > limit as usize {
            documents.truncate(limit as usize);
            Some(encode_cursor(offset + limit as usize))
        } else {
            None
        };

        Ok(Page {
            documents,
            next_cursor,
        })
    }

    async fn count(&self, query: &ListQuery) -> Result<u64, DocStoreError> {
        let filter = list_filter(query);
        Ok(self
            .inner
            .collections
            .documents()
            .count_documents(filter)
            .await?)
    }

    async fn tombstone(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        if let Some(room) = self.inner.cached_room(id) {
            self.inner.flush_room(&room).await?;
        }
        let feed_allocation = self.inner.feed.allocate(id.to_string());
        let result = self
            .inner
            .collections
            .documents()
            .update_one(
                doc! { "_id": id, "deleted_at": Bson::Null },
                doc! { "$set": {
                    "deleted_at": BsonDateTime::now(),
                    "deleted_by": actor.as_stored(),
                    "feed_seq": feed_allocation.seq(),
                } },
            )
            .await?;
        if result.matched_count == 0 {
            let exists = self
                .inner
                .collections
                .documents()
                .find_one(doc! { "_id": id })
                .await?
                .is_some();
            if !exists {
                return Err(DocStoreError::NotFound(id.to_string()));
            }
            return Ok(());
        }
        feed_allocation.commit(crate::feed::FeedChangeKind::Tombstoned);
        Ok(())
    }

    async fn untombstone(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        let feed_allocation = self.inner.feed.allocate(id.to_string());
        let result = self
            .inner
            .collections
            .documents()
            .update_one(
                doc! { "_id": id },
                doc! {
                    "$unset": { "deleted_at": "", "deleted_by": "" },
                    "$set": {
                        "feed_seq": feed_allocation.seq(),
                        "updated_by": actor.as_stored(),
                    },
                },
            )
            .await?;
        if result.matched_count == 0 {
            return Err(DocStoreError::NotFound(id.to_string()));
        }
        feed_allocation.commit(crate::feed::FeedChangeKind::Restored);
        Ok(())
    }

    async fn purge(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError> {
        self.inner.purge_document(id, actor).await
    }

    async fn is_graveyarded(&self, id: &str) -> Result<bool, DocStoreError> {
        Ok(self
            .inner
            .collections
            .deleted_ids()
            .find_one(doc! { "_id": id })
            .await?
            .is_some())
    }

    async fn snapshot(&self, id: &str, reason: &str, actor: &Actor) -> Result<Id, DocStoreError> {
        let room = self.inner.room(id).await?;
        let state = room.state.lock().await;
        let snapshot_id = self
            .inner
            .write_snapshot(&room.id, &state, reason, actor)
            .await?;
        Ok(snapshot_id)
    }

    async fn snapshots(&self, id: &str) -> Result<Vec<DocumentSnapshot>, DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        let mut cursor = self
            .inner
            .collections
            .document_snapshots()
            .find(doc! { "document_id": id })
            .sort(doc! { "created_at": -1 })
            .await?;
        let mut snapshots = Vec::new();
        while let Some(snapshot) = cursor.try_next().await? {
            snapshots.push(snapshot);
        }
        Ok(snapshots)
    }

    async fn changes(
        &self,
        id: &str,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<DocumentChange>, DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        let mut filter = doc! { "document_id": id };
        if let Some(before) = before {
            filter.insert("seq", doc! { "$lt": before });
        }
        let mut cursor = self
            .inner
            .collections
            .document_changes()
            .find(filter)
            .sort(doc! { "seq": -1 })
            .limit(limit.max(1))
            .await?;
        let mut changes = Vec::new();
        while let Some(change) = cursor.try_next().await? {
            changes.push(change);
        }
        Ok(changes)
    }

    async fn changes_since(
        &self,
        id: &str,
        from: i64,
    ) -> Result<Vec<crate::changes::Change>, DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        self.inner.history_units(id, from - 1, i64::MAX).await
    }

    async fn squashed(
        &self,
        id: &str,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<DocumentHistory>, DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        let mut filter = doc! { "document_id": id };
        if let Some(before) = before {
            filter.insert("to_seq", doc! { "$lt": before });
        }
        let mut cursor = self
            .inner
            .collections
            .document_history()
            .find(filter)
            .sort(doc! { "to_seq": -1 })
            .limit(limit.max(1))
            .await?;
        let mut groups = Vec::new();
        while let Some(group) = cursor.try_next().await? {
            groups.push(group);
        }
        Ok(groups)
    }

    async fn squash_history_now(&self) -> Result<usize, DocStoreError> {
        self.inner.squash_history().await
    }

    async fn forget_history(&self, id: &str) -> Result<(), DocStoreError> {
        let room = self.inner.room(id).await?;
        let mut state = room.state.lock().await;
        let collections = &self.inner.collections;
        collections
            .document_changes()
            .delete_many(doc! { "document_id": id })
            .await?;
        collections
            .document_history()
            .delete_many(doc! { "document_id": id })
            .await?;
        collections
            .document_checkpoints()
            .delete_many(doc! { "document_id": id })
            .await?;
        collections
            .document_snapshots()
            .delete_many(doc! { "document_id": id })
            .await?;
        self.inner
            .write_checkpoint(id, state.seq, &state.text)
            .await?;
        state.changes_since_checkpoint = 0;
        state.open_record = None;
        Ok(())
    }

    async fn text_at(&self, id: &str, seq: i64) -> Result<String, DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }
        self.inner.text_at(id, seq).await
    }

    async fn note_revert(
        &self,
        id: &str,
        seq: i64,
        from: i64,
        to: i64,
    ) -> Result<(), DocStoreError> {
        self.inner
            .collections
            .document_changes()
            .update_one(
                doc! { "document_id": id, "seq": seq },
                doc! { "$set": { "reverts": { "from_seq": from, "to_seq": to } } },
            )
            .await?;
        Ok(())
    }

    async fn snapshot_by_id(
        &self,
        id: &str,
        snapshot_id: &str,
    ) -> Result<DocumentSnapshot, DocStoreError> {
        self.inner
            .collections
            .document_snapshots()
            .find_one(doc! { "_id": snapshot_id, "document_id": id })
            .await?
            .ok_or_else(|| DocStoreError::SnapshotNotFound(snapshot_id.to_string()))
    }

    async fn restore_snapshot(
        &self,
        id: &str,
        snapshot_id: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        let snapshot = self.snapshot_by_id(id, snapshot_id).await?;

        self.snapshot(id, "pre_restore", actor).await?;
        self.replace_text(id, &snapshot.content, actor).await
    }

    async fn flush(&self, id: &str) -> Result<(), DocStoreError> {
        let room = self.inner.room(id).await?;
        self.inner.flush_room(&room).await
    }

    async fn flush_all(&self) -> Result<(), DocStoreError> {
        let mut first_error = None;
        for room in self.inner.all_rooms() {
            if !room.dirty.load(Ordering::Relaxed) {
                continue;
            }
            if let Err(err) = self.inner.flush_room(&room).await {
                tracing::warn!(document = %room.id, error = %err, "materialization flush failed");
                first_error = first_error.or(Some(err));
            }
        }
        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    async fn evict_idle(&self) -> Result<usize, DocStoreError> {
        let cutoff = now_ms() - self.inner.tuning.room_idle_timeout.as_millis() as i64;
        let mut evicted = 0;
        for room in self.inner.all_rooms() {
            if room.last_touched_ms.load(Ordering::Relaxed) > cutoff {
                continue;
            }
            match self.inner.flush_room(&room).await {
                Ok(()) => {
                    self.inner.drop_room(&room.id);
                    evicted += 1;
                }
                Err(err) => {
                    tracing::warn!(document = %room.id, error = %err, "not evicting: flush failed");
                }
            }
        }
        Ok(evicted)
    }

    fn stats(&self) -> DocStoreStats {
        let rooms = self.inner.all_rooms();
        DocStoreStats {
            rooms: rooms.len(),
            dirty_rooms: rooms
                .iter()
                .filter(|room| room.dirty.load(Ordering::Relaxed))
                .count(),
            oversized_docs: self
                .inner
                .oversized_docs
                .lock()
                .expect("oversized set poisoned")
                .len(),
        }
    }
}

fn now_ms() -> i64 {
    BsonDateTime::now().timestamp_millis()
}

fn binary(bytes: Vec<u8>) -> Binary {
    Binary {
        subtype: BinarySubtype::Generic,
        bytes,
    }
}

fn title_of(text: &str) -> String {
    let normalized = normalize_input(text);
    parse_document(normalized.as_ref()).title
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TextSplice {
    index: u32,
    remove: u32,
    insert: String,
}

impl TextSplice {
    fn apply(&self, txn: &mut yrs::TransactionMut<'_>, text: &yrs::TextRef) {
        if self.remove > 0 {
            text.remove_range(txn, self.index, self.remove);
        }
        if !self.insert.is_empty() {
            text.insert(txn, self.index, &self.insert);
        }
    }
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

fn text_delta(old: &str, new: &str) -> Option<TextSplice> {
    if old == new {
        return None;
    }
    let prefix = common_prefix_len(old, new);
    let suffix = common_suffix_len(&old[prefix..], &new[prefix..]);
    let old_mid = &old[prefix..old.len() - suffix];
    let new_mid = &new[prefix..new.len() - suffix];
    Some(TextSplice {
        index: utf16_len(&old[..prefix]),
        remove: utf16_len(old_mid),
        insert: new_mid.to_string(),
    })
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    let max = a.len().min(b.len());
    let mut i = 0;
    while i < max && a.as_bytes()[i] == b.as_bytes()[i] {
        i += 1;
    }
    while i > 0 && !a.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn common_suffix_len(a: &str, b: &str) -> usize {
    let max = a.len().min(b.len());
    let mut i = 0;
    while i < max && a.as_bytes()[a.len() - 1 - i] == b.as_bytes()[b.len() - 1 - i] {
        i += 1;
    }
    while i > 0 && !a.is_char_boundary(a.len() - i) {
        i -= 1;
    }
    i
}

fn edit_deltas(
    text: &str,
    edits: &[ddd_core::splice::TextEdit],
) -> Result<Vec<TextSplice>, DocStoreError> {
    let mut ordered: Vec<&ddd_core::splice::TextEdit> = edits.iter().collect();
    ordered.sort_by_key(|edit| std::cmp::Reverse(edit.range.start));

    let mut splices = Vec::with_capacity(ordered.len());
    let mut lowest_applied = usize::MAX;
    for edit in ordered {
        let (start, end) = (edit.range.start, edit.range.end);
        if end < start || end > text.len() {
            return Err(DocStoreError::Other(anyhow::anyhow!(
                "splice range {start}..{end} is outside the document ({} bytes)",
                text.len()
            )));
        }
        if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
            return Err(DocStoreError::Other(anyhow::anyhow!(
                "splice range {start}..{end} is not on a character boundary"
            )));
        }
        if end > lowest_applied {
            return Err(DocStoreError::Other(anyhow::anyhow!(
                "overlapping splice ranges"
            )));
        }
        lowest_applied = start;
        splices.push(TextSplice {
            index: utf16_len(&text[..start]),
            remove: utf16_len(&text[start..end]),
            insert: edit.text.clone(),
        });
    }
    Ok(splices)
}

fn encode_cursor(offset: usize) -> String {
    B64.encode(format!("o:{offset}"))
}

fn decode_cursor(cursor: &str) -> Result<usize, DocStoreError> {
    let invalid = || DocStoreError::Other(anyhow::anyhow!("invalid pagination cursor"));
    let decoded = B64.decode(cursor).map_err(|_| invalid())?;
    let decoded = String::from_utf8(decoded).map_err(|_| invalid())?;
    decoded
        .strip_prefix("o:")
        .and_then(|offset| offset.parse::<usize>().ok())
        .ok_or_else(invalid)
}

fn is_duplicate_key(err: &mongodb::error::Error) -> bool {
    use mongodb::error::{ErrorKind, WriteFailure};
    match err.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write_error)) => write_error.code == 11000,
        ErrorKind::InsertMany(insert) => insert
            .write_errors
            .as_ref()
            .is_some_and(|errors| errors.iter().any(|error| error.code == 11000)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ddd_core::document::Span;
    use ddd_core::splice::TextEdit;

    fn edit(start: usize, end: usize, text: &str) -> TextEdit {
        TextEdit {
            range: Span::new(start, end),
            text: text.to_string(),
        }
    }

    #[test]
    fn pinned_doc_options() {
        let options = doc_options();
        assert_eq!(options.offset_kind, OffsetKind::Utf16);
        assert!(!options.skip_gc);
        assert_eq!(new_doc().offset_kind(), OffsetKind::Utf16);
    }

    #[test]
    fn version_hash_is_stable_hex() {
        let a = version_hash(&[1, 2, 3]);
        let b = version_hash(&[1, 2, 3]);
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, version_hash(&[1, 2, 4]));
    }

    #[test]
    fn text_delta_noop() {
        assert!(text_delta("same", "same").is_none());
    }

    #[test]
    fn text_delta_insert_in_middle() {
        let delta = text_delta("hello world", "hello brave world").unwrap();
        assert_eq!(
            delta,
            TextSplice {
                index: 6,
                remove: 0,
                insert: "brave ".to_string()
            }
        );
    }

    #[test]
    fn text_delta_deletion() {
        let delta = text_delta("abcdef", "abef").unwrap();
        assert_eq!(
            delta,
            TextSplice {
                index: 2,
                remove: 2,
                insert: String::new()
            }
        );
    }

    #[test]
    fn text_delta_counts_utf16_units() {
        let delta = text_delta("😀ab", "😀xb").unwrap();
        assert_eq!(delta.index, 2, "prefix must be measured in UTF-16 units");
        assert_eq!(delta.remove, 1);
        assert_eq!(delta.insert, "x");
    }

    #[test]
    fn text_delta_never_splits_a_multibyte_char() {
        let delta = text_delta("😀", "😁").unwrap();
        assert_eq!(delta.index, 0);
        assert_eq!(delta.remove, 2);
        assert_eq!(delta.insert, "😁");
    }

    #[test]
    fn splices_round_trip_through_yrs() {
        let doc = new_doc();
        let text = doc.get_or_insert_text(TEXT_ROOT);
        let original = "# héllo 😀\n\nbody";
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, original);
        }
        let target = "# héllo 😀\n\nbody text";
        let delta = text_delta(original, target).unwrap();
        {
            let mut txn = doc.transact_mut();
            delta.apply(&mut txn, &text);
        }
        let txn = doc.transact();
        assert_eq!(text.get_string(&txn), target);
    }

    #[test]
    fn edit_deltas_apply_highest_offset_first() {
        let text = "one two three";
        let edits = vec![edit(0, 3, "1"), edit(8, 13, "3")];
        let splices = edit_deltas(text, &edits).unwrap();
        assert_eq!(splices[0].index, 8);
        assert_eq!(splices[1].index, 0);

        let doc = new_doc();
        let text_ref = doc.get_or_insert_text(TEXT_ROOT);
        {
            let mut txn = doc.transact_mut();
            text_ref.insert(&mut txn, 0, text);
            for splice in &splices {
                splice.apply(&mut txn, &text_ref);
            }
        }
        let txn = doc.transact();
        assert_eq!(text_ref.get_string(&txn), "1 two 3");
    }

    #[test]
    fn edit_deltas_reject_out_of_range() {
        assert!(edit_deltas("short", &[edit(0, 99, "x")]).is_err());
    }

    #[test]
    fn edit_deltas_reject_overlap() {
        assert!(edit_deltas("abcdef", &[edit(0, 4, "x"), edit(2, 6, "y")]).is_err());
    }

    #[test]
    fn edit_deltas_reject_mid_character_offsets() {
        assert!(edit_deltas("😀", &[edit(1, 4, "x")]).is_err());
    }

    #[test]
    fn cursor_round_trips() {
        let cursor = encode_cursor(120);
        assert_eq!(decode_cursor(&cursor).unwrap(), 120);
        assert!(decode_cursor("not-a-cursor").is_err());
    }

    #[test]
    fn size_guard_uses_the_smaller_of_the_two_limits() {
        assert_eq!(effective_limit(64), 64, "a lower configured limit wins");
        assert_eq!(
            effective_limit(limits::MAX_DOCUMENT_BYTES * 4),
            limits::MAX_DOCUMENT_BYTES,
            "the shared core's hard cap can never be raised by config"
        );
    }

    #[test]
    fn title_of_falls_back_predictably() {
        assert_eq!(title_of("# Heading\n\nbody"), "Heading");
        assert_eq!(title_of("\n\nfirst line\n"), "first line");
        assert_eq!(title_of("   \n"), limits::UNTITLED);
        assert_eq!(
            title_of("---\ntitle: Shopping\n---\n# Groceries\n"),
            "Shopping"
        );
    }

    #[test]
    fn live_documents_are_the_default_view() {
        assert_eq!(
            list_filter(&query(TrashFilter::Live)),
            doc! { "deleted_at": Bson::Null },
            "a missing or null tombstone means live"
        );
    }

    fn query(trash: TrashFilter) -> ListQuery {
        ListQuery {
            trash,
            ..ListQuery::default()
        }
    }

    #[test]
    fn trash_and_all_select_the_other_two_partitions() {
        assert_eq!(
            list_filter(&query(TrashFilter::Trashed)),
            doc! { "deleted_at": { "$ne": Bson::Null } }
        );
        assert!(list_filter(&query(TrashFilter::All)).is_empty());
    }

    #[test]
    fn a_compiled_dsl_filter_is_anded_with_the_tombstone_clause() {
        let filter = list_filter(&ListQuery {
            filter: Some(doc! { "fm.path": "home" }),
            search: Some("  groceries ".to_string()),
            ..query(TrashFilter::Live)
        });
        let clauses = filter.get_array("$and").expect("$and");
        assert_eq!(clauses.len(), 3);
        assert!(clauses.contains(&Bson::Document(doc! { "fm.path": "home" })));
        assert!(clauses.contains(&Bson::Document(doc! { "deleted_at": Bson::Null })));
        assert!(
            clauses.contains(&Bson::Document(
                doc! { "$text": { "$search": "groceries" } }
            )),
            "search terms are trimmed, never passed through raw"
        );
    }

    #[test]
    fn an_empty_search_adds_no_clause() {
        let filter = list_filter(&ListQuery {
            search: Some("   ".to_string()),
            ..query(TrashFilter::All)
        });
        assert!(filter.is_empty());
    }
}

#[cfg(test)]
mod mongo_tests {
    use super::*;

    async fn store() -> Option<MongoDocStore> {
        let uri = std::env::var("MONGO_URI").ok()?;
        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let name = format!("ddd_docstore_test_{}", new_id());
        let db = client.database(&name);
        crate::db::indexes::ensure(&db).await.ok()?;
        let feed = crate::feed::ChangeFeed::new(crate::db::Collections::new(db.clone()));
        Some(MongoDocStore::new(db, DocStoreTuning::default(), feed))
    }

    async fn teardown(store: &MongoDocStore) {
        let _ = store.inner.collections.database().clone().drop().await;
    }

    #[tokio::test]
    #[ignore = "requires MONGO_URI"]
    async fn create_get_replace_roundtrip() {
        let Some(store) = store().await else { return };
        let actor = Actor::System;

        let created = store
            .create(None, "---\ntitle: Hello\n---\n\nbody\n", &actor)
            .await
            .expect("create");
        let fetched = store.get(&created.id).await.expect("get");
        assert_eq!(fetched.content, created.content);
        assert!(!created.update.is_empty());
        assert_eq!(created.seq, 1);

        let replaced = store
            .replace_text(&created.id, "---\ntitle: Hello\n---\n\nbody two\n", &actor)
            .await
            .expect("replace");
        assert_eq!(replaced.seq, 2);
        assert_eq!(
            store.text(&created.id).await.unwrap(),
            "---\ntitle: Hello\n---\n\nbody two\n"
        );

        teardown(&store).await;
    }

    #[tokio::test]
    #[ignore = "requires MONGO_URI"]
    async fn duplicate_id_conflicts_and_graveyard_is_gone() {
        let Some(store) = store().await else { return };
        let actor = Actor::System;

        let id = new_id();
        store.create(Some(id.clone()), "one", &actor).await.unwrap();
        assert!(matches!(
            store.create(Some(id.clone()), "two", &actor).await,
            Err(DocStoreError::AlreadyExists(_))
        ));

        store.tombstone(&id, &actor).await.unwrap();
        store.purge(&id, &actor).await.unwrap();
        assert!(store.is_graveyarded(&id).await.unwrap());
        assert!(matches!(
            store.create(Some(id.clone()), "three", &actor).await,
            Err(DocStoreError::Graveyarded(_))
        ));

        teardown(&store).await;
    }

    #[tokio::test]
    #[ignore = "requires MONGO_URI"]
    async fn oversized_text_is_rejected() {
        let Some(store) = store().await else { return };
        let text = "x".repeat(limits::MAX_DOCUMENT_BYTES + 1);
        assert!(matches!(
            store.create(None, &text, &Actor::System).await,
            Err(DocStoreError::TooLarge { .. })
        ));
        teardown(&store).await;
    }

    #[tokio::test]
    #[ignore = "requires MONGO_URI"]
    async fn trash_filters_partition_the_workspace() {
        let Some(store) = store().await else { return };
        let actor = Actor::System;
        let live = store.create(None, "live", &actor).await.unwrap();
        let trashed = store.create(None, "trashed", &actor).await.unwrap();
        store.tombstone(&trashed.id, &actor).await.unwrap();

        let count = |trash| ListQuery {
            trash,
            ..ListQuery::default()
        };
        assert_eq!(store.count(&count(TrashFilter::Live)).await.unwrap(), 1);
        assert_eq!(store.count(&count(TrashFilter::Trashed)).await.unwrap(), 1);
        assert_eq!(store.count(&count(TrashFilter::All)).await.unwrap(), 2);

        store.untombstone(&trashed.id, &actor).await.unwrap();
        assert_eq!(store.count(&count(TrashFilter::Live)).await.unwrap(), 2);
        let _ = live;

        teardown(&store).await;
    }

    #[tokio::test]
    #[ignore = "requires MONGO_URI"]
    async fn list_rows_carry_no_crdt_bytes() {
        let Some(store) = store().await else { return };
        let actor = Actor::System;
        let created = store
            .create(None, "---\ntitle: Listed\n---\n\nbody\n", &actor)
            .await
            .unwrap();

        let full = store
            .list(&ListQuery {
                limit: 10,
                ..ListQuery::default()
            })
            .await
            .unwrap();
        let row = full
            .documents
            .iter()
            .find(|d| d.id == created.id)
            .expect("the created document is listed");
        assert_eq!(row.title, "Listed", "materialized fields still arrive");
        assert!(row.content.contains("body"));

        let metadata = store
            .list(&ListQuery {
                limit: 10,
                metadata_only: true,
                ..ListQuery::default()
            })
            .await
            .unwrap();
        let row = metadata
            .documents
            .iter()
            .find(|d| d.id == created.id)
            .expect("the created document is listed");
        assert!(row.content.is_empty(), "content was read despite the flag");
        assert_eq!(row.title, "Listed");

        teardown(&store).await;
    }

    #[tokio::test]
    #[ignore = "requires MONGO_URI"]
    async fn purging_writes_an_audit_entry() {
        let Some(store) = store().await else { return };
        let actor = Actor::System;
        let created = store
            .create(None, "---\ntitle: Doomed\n---\n\nbye\n", &actor)
            .await
            .unwrap();
        store.tombstone(&created.id, &actor).await.unwrap();
        store.purge(&created.id, &actor).await.unwrap();

        let entry = store
            .inner
            .collections
            .audit_log()
            .find_one(doc! { "action": "document.purge", "target_id": &created.id })
            .await
            .unwrap()
            .expect("the purge is audited");
        assert_eq!(entry.target_kind, "document");
        assert_eq!(entry.detail.get_str("title").unwrap(), "Doomed");

        teardown(&store).await;
    }

    #[tokio::test]
    #[ignore = "requires MONGO_URI"]
    async fn snapshot_and_restore() {
        let Some(store) = store().await else { return };
        let actor = Actor::System;
        let created = store.create(None, "first", &actor).await.unwrap();
        let snapshot = store.snapshot(&created.id, "manual", &actor).await.unwrap();
        store
            .replace_text(&created.id, "second", &actor)
            .await
            .unwrap();
        store
            .restore_snapshot(&created.id, &snapshot, &actor)
            .await
            .unwrap();
        assert_eq!(store.text(&created.id).await.unwrap(), "first");
        teardown(&store).await;
    }

    #[tokio::test]
    #[ignore = "requires MONGO_URI"]
    async fn crdt_state_survives_a_room_eviction() {
        let Some(store) = store().await else { return };
        let actor = Actor::System;
        let created = store.create(None, "hello", &actor).await.unwrap();
        store.inner.drop_room(&created.id);
        assert_eq!(store.text(&created.id).await.unwrap(), "hello");

        let state = store.crdt_state(&created.id).await.unwrap();
        assert!(!state.state.is_empty());
        let empty = StateVector::default().encode_v1();
        assert!(!store.diff(&created.id, &empty).await.unwrap().is_empty());

        teardown(&store).await;
    }
}
