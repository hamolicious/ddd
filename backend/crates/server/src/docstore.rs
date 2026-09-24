//! The yrs storage engine: "one document = one Y.Doc, apply, materialize"
//! (SPEC §9 M1, §3.2, §3.5).
//!
//! **FROZEN CONTRACT.** The [`DocStore`] trait is the only way any other module
//! touches CRDT state. Routes, seeding and (in M2) the WebSocket layer all go
//! through it. Nobody changes a method signature here without re-negotiating
//! with every other area; the implementation behind it is free to change.
//!
//! Pinned compatibility decisions (SPEC §3.2) — client Yjs ↔ server yrs:
//! - [`OFFSET_KIND`] = `OffsetKind::Utf16`; index-based ops corrupt multi-byte
//!   text otherwise.
//! - **Update encoding v1** everywhere: wire, stored blob, update log, REST.
//! - GC settings identical on both sides ([`SKIP_GC`]).
//! - The text lives in one root `Y.Text` named [`TEXT_ROOT`].
//!
//! Shape of the implementation (SPEC §3.5, §4.3):
//!
//! - A **room** per hot document holds the `Doc`, the cached text and the
//!   per-document write lock. Every mutating method funnels through
//!   [`MongoDocStoreInner::mutate`], so writes to one document are serialized
//!   (the per-document actor) without any caller-side locking.
//! - The synchronous path per applied update is: apply to the hot doc → append
//!   to `document_updates` (durability + the M2 broadcast) → mark the room dirty.
//! - [`MongoDocStoreInner::materialize_room`] is the *distinct* materialization
//!   step: it rewrites `crdt`, `state_vector`, `content`, `title`, `fm`,
//!   `plugins`, `materialized_version` and `fm_parse_error` **in one Mongo
//!   write**, under optimistic concurrency on `materialized_version`. In M1 the
//!   write path calls it synchronously; M2 only has to stop doing that and let
//!   the debounce worker ([`MATERIALIZE_DEBOUNCE`]) pick the room up.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use bson::spec::BinarySubtype;
use bson::{Binary, Bson, DateTime as BsonDateTime, Document as BsonDocument, doc};
use futures::TryStreamExt;
use life_manager_core::date::Date;
use life_manager_core::document::{ParsedDocument, normalize_input, parse_document};
use life_manager_core::limits;
use life_manager_core::value::{Map, Value, map_to_bson};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, Update};

use crate::db;
use crate::domain::{
    Actor, AuditEntry, Document, DocumentRow, DocumentSnapshot, DocumentUpdate, Id, is_valid_id,
    new_id,
};
use crate::telemetry::names;

/// Name of the single root `Y.Text` holding the whole document text.
pub const TEXT_ROOT: &str = "content";
/// Offset kind, pinned to match Yjs.
pub const OFFSET_KIND: OffsetKind = OffsetKind::Utf16;
/// GC setting, pinned to match the client (`false` = GC enabled).
pub const SKIP_GC: bool = false;

// ---------------------------------------------------------------------------
// Default engine tuning (SPEC §3.5, §4.3)
//
// These are the *defaults*. The live values come from `Config` through
// [`DocStoreTuning`], which `MongoDocStore::new` takes — so `MATERIALIZE_DEBOUNCE_MS`,
// `ROOM_IDLE_TIMEOUT_SECS`, `UPDATE_LOG_KEEP_*`, `CRDT_*_THRESHOLD_BYTES` and
// `TRASH_RETENTION_DAYS` actually do something. The constants stay as the
// documented defaults (and as what `DocStoreTuning::default()` yields, which is
// what the unit tests use).
// ---------------------------------------------------------------------------

/// Materialization debounce window (SPEC §3.5).
pub const MATERIALIZE_DEBOUNCE: Duration = Duration::from_millis(500);
/// Rooms are evicted this long after their last use (SPEC §4.3).
pub const ROOM_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
/// Per-document update-log retention, bytes (SPEC §3.5).
pub const UPDATE_LOG_KEEP_BYTES: u64 = 1024 * 1024;
/// Per-document update-log retention, entries (SPEC §3.5).
pub const UPDATE_LOG_KEEP_COUNT: u32 = 200;
/// Compact the `crdt` blob aggressively above this size (SPEC §3.5).
pub const CRDT_COMPACT_THRESHOLD_BYTES: u64 = 4 * 1024 * 1024;
/// Alert above this `crdt` size (SPEC §3.5).
pub const CRDT_ALERT_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024;
/// Snapshots always kept, newest first (SPEC §3.5).
pub const SNAPSHOT_KEEP_RECENT: usize = 20;
/// Beyond [`SNAPSHOT_KEEP_RECENT`], keep one snapshot per day for this many days.
pub const SNAPSHOT_KEEP_DAILY_DAYS: i64 = 30;
/// A document sits in Trash this long before it is purged (SPEC §3.5).
pub const TRASH_RETENTION_DAYS: i64 = 30;
/// "First edit after quiescence" threshold for the snapshot policy.
pub const SNAPSHOT_QUIESCENCE: Duration = Duration::from_secs(600);
/// Default page size when a [`ListQuery`] does not set one.
pub const DEFAULT_PAGE_LIMIT: u32 = 50;
/// Hard page-size ceiling (the route clamps too).
pub const MAX_PAGE_LIMIT: u32 = 500;

const DAY_MS: i64 = 86_400_000;
/// Trim the update log every N appends (plus the periodic worker).
const TRIM_EVERY: i64 = 32;

/// The yrs [`Options`] every document must be created with. Any `Doc` built
/// outside this function is a compatibility bug.
pub fn doc_options() -> Options {
    Options {
        offset_kind: OFFSET_KIND,
        skip_gc: SKIP_GC,
        ..Options::default()
    }
}

/// Create an empty document with the pinned options.
pub fn new_doc() -> Doc {
    Doc::with_options(doc_options())
}

// ---------------------------------------------------------------------------
// Types crossing the trait boundary
// ---------------------------------------------------------------------------

/// Operator-tunable engine knobs (SPEC §3.5, §4.3), read from [`crate::config::Config`].
///
/// A struct rather than eight constructor parameters: adding a knob then touches
/// one type and one `from_config`, not every call site and every test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocStoreTuning {
    /// Hard cap on document text (`MAX_DOCUMENT_BYTES`); the shared core's 1 MiB
    /// cap is the ceiling, this may only lower it.
    pub max_document_bytes: usize,
    /// Materialization debounce window (`MATERIALIZE_DEBOUNCE_MS`).
    pub materialize_debounce: Duration,
    /// Idle-room eviction delay (`ROOM_IDLE_TIMEOUT_SECS`).
    pub room_idle_timeout: Duration,
    /// Per-document update-log retention (`UPDATE_LOG_KEEP_BYTES` / `_COUNT`).
    pub update_log_keep_bytes: u64,
    pub update_log_keep_count: u32,
    /// `crdt` blob thresholds (`CRDT_COMPACT_THRESHOLD_BYTES` / `_ALERT_`).
    pub crdt_compact_threshold_bytes: u64,
    pub crdt_alert_threshold_bytes: u64,
    /// Days a tombstone sits in Trash before purge (`TRASH_RETENTION_DAYS`).
    pub trash_retention_days: i64,
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
        }
    }
}

impl DocStoreTuning {
    /// Take the validated values from `Config` (ops validates ranges and
    /// cross-field rules at boot; nothing is re-checked here).
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
        }
    }
}

/// Everything materialized from a document's text in one pass (SPEC §3.5).
/// Rewritten together, never inconsistent with each other.
#[derive(Debug, Clone)]
pub struct Materialized {
    pub content: String,
    pub title: String,
    pub fm: BsonDocument,
    pub plugins: BsonDocument,
    pub fm_parse_error: bool,
    /// State-vector hash of the CRDT state this was derived from.
    pub materialized_version: String,
}

/// Run the shared core over `text` and convert to storage shapes.
/// The single bridge between [`life_manager_core`] and Mongo.
pub fn materialize(text: &str, materialized_version: String) -> Materialized {
    let normalized = normalize_input(text);
    let parsed = parse_document(normalized.as_ref());
    materialize_parsed(&parsed, normalized.as_ref(), materialized_version)
}

/// Convert a parsed document to storage shapes (when the parse is already done).
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

/// Normalize every date-looking string to its canonical ISO-8601 form so
/// lexicographic sort in Mongo is chronological (SPEC §3.4 "Dates").
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

/// `materialized_version` for a state vector: a short, stable hash.
pub fn version_hash(state_vector: &[u8]) -> String {
    let digest = Sha256::digest(state_vector);
    hex::encode(&digest[..16])
}

/// What a write returns: enough for the response without re-reading Mongo.
#[derive(Debug, Clone)]
pub struct WriteOutcome {
    pub id: Id,
    /// The document text after the write.
    pub content: String,
    pub title: String,
    pub materialized_version: String,
    /// The Yjs update (encoding v1) this write produced — the M2 broadcast
    /// payload; empty when the write was a no-op.
    pub update: Vec<u8>,
    /// Per-document sequence number assigned to the update-log entry.
    pub seq: i64,
}

/// A CRDT-level read for `?format=crdt` and (M2) sync.
#[derive(Debug, Clone)]
pub struct CrdtState {
    pub id: Id,
    /// Full encoded state, update encoding v1.
    pub state: Vec<u8>,
    pub state_vector: Vec<u8>,
}

/// Live engine counters for `/metrics` (SPEC §8).
#[derive(Debug, Clone, Copy, Default)]
pub struct DocStoreStats {
    /// Hot documents currently held in memory.
    pub rooms: usize,
    /// Rooms with unflushed materialization.
    pub dirty_rooms: usize,
    /// Documents whose `crdt` blob is above the compaction threshold.
    pub oversized_docs: usize,
}

/// Options for listing/querying, assembled by the documents route from the DSL.
#[derive(Debug, Clone, Default)]
pub struct ListQuery {
    /// Compiled filter (already validated). `None` = no filter.
    pub filter: Option<BsonDocument>,
    /// Compiled sort. `None` = `updated_at` descending.
    pub sort: Option<BsonDocument>,
    /// Full-text search terms (server-side provider; the PWA searches locally).
    pub search: Option<String>,
    /// Opaque pagination cursor from a previous page.
    pub cursor: Option<String>,
    /// Page size; the route clamps it.
    pub limit: u32,
    /// Which tombstone state to return.
    pub trash: TrashFilter,
    /// `true` when the caller does not want `content` — the list views. The
    /// megabyte strings are then left out of the Mongo projection instead of being
    /// read and thrown away.
    pub metadata_only: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TrashFilter {
    /// Only live documents (`deleted_at` unset).
    #[default]
    Live,
    /// Only tombstoned documents (the Trash view).
    Trashed,
    /// Both.
    All,
}

/// One page of documents, as [`DocumentRow`]s — the projection, never the CRDT.
///
/// The type is the contract: `crdt` and `state_vector` are 2–10× the plaintext
/// and compacted only above 4 MiB (SPEC §3.5), so no query returning many rows
/// may read them, and a page therefore *cannot* carry them. `content` is
/// additionally empty under [`ListQuery::metadata_only`]. Anything that needs CRDT
/// bytes asks for one id at a time through
/// [`DocStore::get`]/[`DocStore::crdt_state`].
#[derive(Debug, Clone)]
pub struct Page {
    pub documents: Vec<DocumentRow>,
    /// Cursor for the next page; `None` when exhausted.
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
    /// A [`DocStore::splice`] closure declined to produce edits for the text it was shown.
    /// The caller's own message, because only the caller knows what it was trying to write.
    #[error("the splice is not representable: {0}")]
    SpliceRefused(String),
    #[error("database error: {0}")]
    Db(#[from] mongodb::error::Error),
    #[error("bson error: {0}")]
    Bson(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

// ---------------------------------------------------------------------------
// The trait
// ---------------------------------------------------------------------------

/// Computes splice edits from a document's current text.
///
/// Called exactly once, with the room lock held — see [`DocStore::splice`] for why the
/// contract is a closure rather than a precomputed edit list. `Err` carries a message for
/// [`DocStoreError::SpliceRefused`].
pub type SpliceFn<'a> =
    &'a (dyn Fn(&str) -> Result<Vec<life_manager_core::splice::TextEdit>, String> + Send + Sync);

/// CRDT-backed document storage.
///
/// Every mutating method is serialized per document by the implementation (the
/// per-document actor of SPEC §4.3), so callers need no locking. Materialization
/// is debounced internally; methods documented as "read-your-writes" force a
/// flush first.
#[async_trait]
pub trait DocStore: Send + Sync + 'static {
    /// Create a document from full text. `id` is client-mintable; `None` mints
    /// one. Errors [`DocStoreError::AlreadyExists`] on a live id (→ 409) and
    /// [`DocStoreError::Graveyarded`] on a purged id (→ 410).
    async fn create(
        &self,
        id: Option<Id>,
        text: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    /// Replace the whole text in one CRDT transaction (`PUT`, `PATCH`,
    /// machine-owned rewrites). Computes a minimal diff against the current text
    /// so unchanged regions keep their CRDT history.
    async fn replace_text(
        &self,
        id: &str,
        text: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    /// Compute the shared core's splice edits (frontmatter values, `%%%` section lines)
    /// **from the text as it is under the room lock**, then apply them in one transaction.
    ///
    /// # Why a closure and not an edit list
    ///
    /// A [`life_manager_core::splice::TextEdit`] is a byte-offset span, and a byte offset is
    /// only meaningful against the exact string it was computed from. The obvious API —
    /// `text()` to read, compute the spans, `apply_edits()` to write — is two separate
    /// acquisitions of the room lock with a window in between, and a concurrent CRDT write in
    /// that window silently shifts every offset. Nothing downstream can catch it:
    /// `edit_deltas` validates bounds, character boundaries and non-overlap, never that the
    /// span still holds the text it was derived from. The observed failure was a plugin's
    /// one-line `%%%` write landing over the tail of a human's prose, which is worse than
    /// anything SPEC §11.2 accepts (that risk is losing *one machine value*, not user text).
    ///
    /// So the caller hands over the computation instead of its result. `compute` is called
    /// **exactly once, with the lock held**, and its spans are applied to the very string it
    /// was given. It must be pure: the shared core's splice helpers are, and everything a
    /// plugin needs to decide (which keys change, where the fence is) is a function of that
    /// text.
    ///
    /// Returning `Ok(vec![])` is "nothing to write" and is a clean no-op — no CRDT history,
    /// no log entry, no timestamp churn. Returning `Err` is
    /// [`DocStoreError::SpliceRefused`] with the caller's own message.
    async fn splice(
        &self,
        id: &str,
        compute: SpliceFn<'_>,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    /// Apply an encoded Yjs update (encoding v1) — the M2 WebSocket path, and
    /// already used by restore.
    async fn apply_update(
        &self,
        id: &str,
        update: &[u8],
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    /// Current document text (read-your-writes: forces a flush).
    async fn text(&self, id: &str) -> Result<String, DocStoreError>;

    /// Materialized document (read-your-writes: forces a flush).
    async fn get(&self, id: &str) -> Result<Document, DocStoreError>;

    /// Materialized document without forcing a flush; may trail the newest CRDT
    /// state (`materialized_version` says so).
    async fn get_stale(&self, id: &str) -> Result<Document, DocStoreError>;

    /// Full encoded CRDT state + state vector (`?format=crdt`).
    async fn crdt_state(&self, id: &str) -> Result<CrdtState, DocStoreError>;

    /// Update containing everything `since` (a client state vector) is missing.
    async fn diff(&self, id: &str, since: &[u8]) -> Result<Vec<u8>, DocStoreError>;

    /// One page of documents matching `query`.
    async fn list(&self, query: &ListQuery) -> Result<Page, DocStoreError>;

    /// Number of documents matching `query` (ignores cursor/limit).
    async fn count(&self, query: &ListQuery) -> Result<u64, DocStoreError>;

    /// Tombstone → Trash. Idempotent; the id is *not* graveyarded yet.
    async fn tombstone(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;

    /// Restore a tombstoned document out of Trash.
    async fn untombstone(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;

    /// Purge a tombstoned document: delete the row, keep the id in the graveyard
    /// forever (SPEC §3.5).
    async fn purge(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;

    /// `true` when the id is in the graveyard.
    async fn is_graveyarded(&self, id: &str) -> Result<bool, DocStoreError>;

    /// Take a snapshot now, whatever the policy says.
    async fn snapshot(&self, id: &str, reason: &str, actor: &Actor) -> Result<Id, DocStoreError>;

    /// Snapshots for a document, newest first.
    async fn snapshots(&self, id: &str) -> Result<Vec<DocumentSnapshot>, DocStoreError>;

    /// Restore a snapshot: one CRDT transaction replacing the full text.
    async fn restore_snapshot(
        &self,
        id: &str,
        snapshot_id: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError>;

    /// Force materialization of one document.
    async fn flush(&self, id: &str) -> Result<(), DocStoreError>;

    /// Force materialization of every dirty document (shutdown path, SPEC §8).
    async fn flush_all(&self) -> Result<(), DocStoreError>;

    /// Evict idle rooms after flushing them; called on a timer.
    async fn evict_idle(&self) -> Result<usize, DocStoreError>;

    /// Engine counters for `/metrics`.
    fn stats(&self) -> DocStoreStats;
}

/// The Mongo-backed [`DocStore`] (SPEC §3.5). Owns the hot-document rooms, the
/// update log, snapshots and the graveyard.
#[derive(Clone)]
pub struct MongoDocStore {
    inner: std::sync::Arc<MongoDocStoreInner>,
}

/// Internal state of [`MongoDocStore`]; private on purpose — nothing outside
/// this file may reach into it.
struct MongoDocStoreInner {
    collections: db::Collections,
    tuning: DocStoreTuning,
    /// The workspace change feed (SPEC §4.1). Every write that changes the
    /// projection allocates a sequence number here and commits it after the Mongo
    /// write, which is what makes the feed's `safe_seq` meaningful
    /// (PROTOCOL.md §2.2).
    feed: Arc<crate::feed::ChangeFeed>,
    /// Hot-document registry. A `std::sync::Mutex` on purpose: it is only ever
    /// held for map operations (never across an `.await`), which lets the
    /// synchronous [`DocStore::stats`] read it.
    rooms: std::sync::Mutex<HashMap<Id, Arc<Room>>>,
    /// Documents whose `crdt` blob is above the compaction threshold — a set, so
    /// the gauge counts documents rather than flushes.
    oversized_docs: std::sync::Mutex<HashSet<Id>>,
}

/// One hot document: the per-document actor of SPEC §4.3.
struct Room {
    id: Id,
    state: Mutex<RoomState>,
    /// Epoch millis of the last use; drives idle eviction.
    last_touched_ms: AtomicI64,
    /// Mirror of `RoomState::dirty` so `stats()` needs no async lock.
    dirty: AtomicBool,
}

struct RoomState {
    doc: Doc,
    /// Cached current text — the materialization input.
    text: String,
    /// Materialization is pending.
    dirty: bool,
    /// Last update-log sequence number for this document.
    seq: i64,
    /// `materialized_version` currently stored in Mongo: the optimistic
    /// concurrency token of the materialization write.
    stored_version: String,
    /// Last materialized title, so a no-op write can answer without a read.
    stored_title: String,
    /// Actor of the most recent unflushed write.
    pending_actor: Option<String>,
    /// Timestamp of the most recent unflushed write.
    pending_updated_at: Option<BsonDateTime>,
    /// Epoch millis of the newest snapshot, when known.
    last_snapshot_ms: Option<i64>,
    /// Epoch millis of the previous write (snapshot quiescence policy).
    last_write_ms: i64,
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

    /// The tuning this store was built with.
    pub fn tuning(&self) -> DocStoreTuning {
        self.inner.tuning
    }

    /// Start the background workers (debounced materialization flush, idle room
    /// eviction, update-log trimming). Returns a handle that stops them on drop.
    pub fn spawn_workers(&self) -> DocStoreWorkers {
        let mut handles = Vec::new();

        // Debounced materialization: in M1 the write path flushes synchronously,
        // so this is the safety net for a flush that failed (and in M2 it
        // becomes the only flush path).
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

        // Idle room eviction (SPEC §4.3: evict 10 min after last use, post-flush).
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

        // Trash purge (SPEC §3.5: 30 days, then the id stays in the graveyard).
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

        DocStoreWorkers { handles }
    }
}

/// Handle to the docstore's background tasks; aborts them on drop.
pub struct DocStoreWorkers {
    handles: Vec<tokio::task::JoinHandle<()>>,
}

impl DocStoreWorkers {
    /// Flush everything and stop the workers (graceful shutdown).
    pub async fn shutdown(self) {
        for handle in self.handles {
            handle.abort();
        }
    }
}

// ---------------------------------------------------------------------------
// Engine internals
// ---------------------------------------------------------------------------

/// What kind of text mutation a write performs.
enum Mutation<'a> {
    /// Replace the whole text (`create`, `PUT`, restore).
    SetText(&'a str),
    /// Compute shared-core splice edits against the locked text, then apply them. There is
    /// deliberately **no** variant that takes precomputed edits: a byte-offset span computed
    /// outside this lock can no longer be trusted by the time it gets here (see
    /// [`DocStore::splice`]).
    Splice(SpliceFn<'a>),
    /// Apply an encoded Yjs update (encoding v1).
    Update(&'a [u8]),
}

/// The document-text cap actually enforced: the configured value, never above
/// the shared core's hard cap (SPEC §3.5 "document text ≤ 1 MB").
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

    /// Get the hot room for `id`, loading it from Mongo when cold.
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

    /// Rebuild a document's `Doc` from the stored blob plus every retained
    /// update-log entry. Applying a log entry twice is a CRDT no-op, so
    /// correctness never depends on log retention (SPEC §3.5).
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
        // The log may have carried the document past its last materialization.
        let dirty = text != stored.content;

        let newest_snapshot = self
            .collections
            .document_snapshots()
            .find(doc! { "document_id": id })
            .sort(doc! { "created_at": -1 })
            .limit(1)
            .await?
            .try_next()
            .await?
            .map(|snapshot| snapshot.created_at.timestamp_millis());

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
                last_snapshot_ms: newest_snapshot,
                last_write_ms: stored.updated_at.timestamp_millis(),
            }),
        })
    }

    /// The one write path: apply → log → materialize.
    async fn mutate(
        &self,
        id: &str,
        mutation: Mutation<'_>,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        let room = self.room(id).await?;
        let mut state = room.state.lock().await;

        // 1. Work out the resulting text first, so the size cap is enforced
        //    before any CRDT state is touched (SPEC §3.5 limits).
        //
        //    This is also where a splice's edits are computed — inside the lock, from the
        //    text step 3 will apply them to, so the offsets cannot be stale.
        let mut spliced: Vec<life_manager_core::splice::TextEdit> = Vec::new();
        let candidate: String = match mutation {
            Mutation::SetText(text) => normalize_input(text).into_owned(),
            Mutation::Splice(compute) => {
                spliced = compute(&state.text).map_err(DocStoreError::SpliceRefused)?;
                life_manager_core::splice::apply(&state.text, &spliced)
            }
            Mutation::Update(update) => {
                // Apply to a scratch replica to learn the resulting text without
                // risking a partial write on the hot doc.
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

        // 1a. A **genuine no-op**: no snapshot, no transaction, no log entry, no
        //     materialization, no timestamp churn. Idempotent client retries and idempotent
        //     plugin syncs land here (HOST-ABI.md §3.4: a daily sync that changes nothing must
        //     produce no CRDT history at all).
        //
        //     Decided from the candidate text, *before* the transaction, because it cannot be
        //     decided after one: `encode_diff_v1` over an empty transaction returns `[0, 0]`,
        //     not an empty slice, so the `update.is_empty()` test further down never fired and
        //     every no-op rewrite appended an update-log entry anyway.
        //
        //     `Update` is excluded and must be: a remote update whose text happens to match can
        //     still carry structure other replicas need, and dropping it would stall their
        //     convergence. Only the two text-rewriting mutations are decidable this way.
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

        // 2. Snapshot policy (SPEC §3.5) — decoupled from compaction, and taken
        //    *before* the edit lands, so "restore" means "the version I had
        //    before this edit".
        let now = now_ms();
        if candidate != state.text
            && let Some(reason) = snapshot_reason(&state, now)
        {
            let snapshot_id = self.write_snapshot(&room.id, &state, reason, actor).await?;
            tracing::debug!(document = %room.id, %snapshot_id, reason, "snapshot taken");
            state.last_snapshot_ms = Some(now);
        }

        // 3. Apply to the hot doc in one transaction.
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
                    // `spliced` was computed from `state.text` a few lines up, under this
                    // same lock — the offsets are the ones that string actually has.
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
            // A genuine no-op: no log entry, no materialization, no timestamp
            // churn. Idempotent client retries land here.
            return Ok(WriteOutcome {
                id: room.id.clone(),
                content: state.text.clone(),
                title: state.stored_title.clone(),
                materialized_version: state.stored_version.clone(),
                update: Vec::new(),
                seq: state.seq,
            });
        }

        state.text = text_after;

        // 4. Append to the update log: durability for the applied update and the
        //    M2 broadcast payload.
        let seq = state.seq + 1;
        self.append_update(&room.id, seq, &update, actor).await?;
        state.seq = seq;
        metrics::counter!(names::UPDATES_APPLIED).increment(1);

        state.dirty = true;
        room.dirty.store(true, Ordering::Relaxed);
        state.pending_actor = Some(actor.as_stored());
        state.pending_updated_at = Some(BsonDateTime::now());
        state.last_write_ms = now;

        // 5. Materialize. M1: synchronous. M2: drop this call and let the
        //    debounce worker coalesce (the room is already marked dirty).
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

    /// The **distinct materialization step**: `crdt`, `state_vector`, `content`,
    /// `title`, `fm`, `plugins`, `materialized_version` and `fm_parse_error`
    /// rewritten together in **one** Mongo write (SPEC §3.5).
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
            // `encode_state_as_update_v1` against an empty state vector *is* the
            // compacted form, so every flush already writes the compacted blob;
            // what is left to do is report the ones that stay large.
            let mut oversized = self.oversized_docs.lock().expect("oversized set poisoned");
            if crdt_len > self.tuning.crdt_compact_threshold_bytes {
                oversized.insert(room.id.clone());
            } else {
                oversized.remove(&room.id);
            }
        }

        let materialized = materialize(&state.text, version_hash(&state_vector));

        // The projection is changing, so the row needs a new feed sequence number
        // (CONTRACTS.md docstore M2 item 1). Allocated *before* the write and
        // committed only once it lands; the guard burns the number on any failure
        // path below, which is what keeps `safe_seq` honest (PROTOCOL.md §2.2).
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
            // Someone else moved the row out from under us. The applied update is
            // already durable in the log, so dropping the room makes the next
            // access rebuild from Mongo + log and converge — no data is lost.
            self.drop_room(&room.id);
            return Err(DocStoreError::Contended(room.id.clone()));
        }

        state.stored_title = materialized.title.clone();
        state.stored_version = materialized.materialized_version.clone();
        state.dirty = false;
        state.pending_actor = None;
        state.pending_updated_at = None;
        room.dirty.store(false, Ordering::Relaxed);

        // The row carries its new `feed_seq`: tell every connected client.
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

    /// Trim the per-document update log to [`UPDATE_LOG_KEEP_COUNT`] entries and
    /// [`UPDATE_LOG_KEEP_BYTES`] bytes. A normal collection, never capped.
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
            // `kept > 1` keeps the newest entry unconditionally: the per-document
            // sequence numbers are derived from it at load, and a single update
            // larger than the byte budget must not wipe the log.
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
        self.prune_snapshots(document_id).await?;
        Ok(snapshot_id)
    }

    /// Per-document retention: last [`SNAPSHOT_KEEP_RECENT`] + one per day for
    /// [`SNAPSHOT_KEEP_DAILY_DAYS`] days (SPEC §3.5).
    async fn prune_snapshots(&self, document_id: &str) -> Result<(), DocStoreError> {
        let mut cursor = self
            .collections
            .raw(db::DOCUMENT_SNAPSHOTS)
            .find(doc! { "document_id": document_id })
            .projection(doc! { "_id": 1, "created_at": 1 })
            .sort(doc! { "created_at": -1 })
            .await?;

        let mut rows = Vec::new();
        while let Some(row) = cursor.try_next().await? {
            let id = row.get_str("_id").unwrap_or_default().to_string();
            let at = row
                .get_datetime("created_at")
                .map(|at| at.timestamp_millis())
                .unwrap_or(0);
            rows.push((id, at));
        }

        let prune = snapshots_to_prune(&rows, now_ms());
        if !prune.is_empty() {
            self.collections
                .document_snapshots()
                .delete_many(doc! { "_id": { "$in": prune } })
                .await?;
        }
        Ok(())
    }

    /// Purge every document whose Trash retention has run out (SPEC §3.5).
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

    /// Delete the row and everything derived from it, then graveyard the id
    /// **forever** (SPEC §3.5).
    async fn purge_document(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError> {
        if !is_valid_id(id) {
            return Err(DocStoreError::InvalidId(id.to_string()));
        }

        // Refuse before the graveyard write: graveyarding an id that never
        // existed would block it forever for no reason. The projection keeps the
        // CRDT blob out of a read whose only job is "does this row exist" (and
        // gives the audit entry below something to record).
        let Some(row) = self
            .collections
            .raw(db::DOCUMENTS)
            .find_one(doc! { "_id": id })
            .projection(doc! { "title": 1, "deleted_at": 1, "deleted_by": 1 })
            .await?
        else {
            return Err(DocStoreError::NotFound(id.to_string()));
        };

        // A purge is the one feed row that is written on `deleted_ids` rather than
        // on `documents` — the `documents` row is about to stop existing. Purged
        // rows are how a long-offline client learns to drop its local replica
        // (PROTOCOL.md §2.1), so this number is not optional. `$set` rather than
        // `$setOnInsert`: the guard above already returned `NotFound` unless the
        // `documents` row exists, so this path runs at most once per id, and a
        // graveyard row backfilled without a `feed_seq` still gets one.
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
        // The row really is gone now, so clients can be told.
        feed_allocation.commit(crate::feed::FeedChangeKind::Purged);
        self.collections
            .document_updates()
            .delete_many(doc! { "document_id": id })
            .await?;
        self.collections
            .document_snapshots()
            .delete_many(doc! { "document_id": id })
            .await?;
        self.drop_room(id);
        self.oversized_docs
            .lock()
            .expect("oversized set poisoned")
            .remove(id);

        // The point of no return gets an audit row (SPEC §5.4): a `document.delete`
        // tombstone entry 30 days earlier does not record that the text, its whole
        // update log and every snapshot were actually destroyed. Best effort — the
        // deletion already happened, so a failed audit write is logged, never
        // returned.
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

/// Mongo filter for a [`ListQuery`], combining the compiled DSL filter with the
/// tombstone state and the optional text search.
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

/// Deserialize a projected `documents` row into a [`DocumentRow`].
///
/// Every field `DocumentRow` can do without is `#[serde(default)]`, so a
/// metadata-only projection (no `content`) deserializes as an empty string rather
/// than failing — and there is nothing to fake, because the type promises no CRDT
/// bytes in the first place.
fn row_from_projection(row: BsonDocument) -> Result<DocumentRow, DocStoreError> {
    bson::from_document(row).map_err(|err| DocStoreError::Bson(err.to_string()))
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

        // The graveyard is consulted by every create path: a long-offline client
        // can never resurrect a purged document (SPEC §3.5 → HTTP 410).
        if inner
            .collections
            .deleted_ids()
            .find_one(doc! { "_id": &id })
            .await?
            .is_some()
        {
            return Err(DocStoreError::Graveyarded(id));
        }

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
        // The row enters the change feed with the same write that creates it, so a
        // client that is already subscribed sees it without a materialization pass
        // (SPEC §4.1). The guard is committed only after the insert succeeds;
        // dropping it on an error burns the number, which is legal (PROTOCOL.md §2.2).
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
                last_snapshot_ms: None,
                last_write_ms: now_ms(),
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

    async fn replace_text(
        &self,
        id: &str,
        text: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        self.inner.mutate(id, Mutation::SetText(text), actor).await
    }

    async fn splice(
        &self,
        id: &str,
        compute: SpliceFn<'_>,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        self.inner
            .mutate(id, Mutation::Splice(compute), actor)
            .await
    }

    async fn apply_update(
        &self,
        id: &str,
        update: &[u8],
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        self.inner.mutate(id, Mutation::Update(update), actor).await
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

        // `_id` is appended as the tiebreaker so paging is deterministic.
        // INTEGRATION (M2): offset paging is replaced by keyset paging on the
        // sort key once the change feed exists.
        let mut sort = query
            .sort
            .clone()
            .unwrap_or_else(|| doc! { "updated_at": -1 });
        if !sort.contains_key("_id") {
            sort.insert("_id", 1);
        }

        // Projection, not a typed `find` over `Document`: the `crdt` and
        // `state_vector` blobs are 2-10x the plaintext and compacted only above
        // 4 MiB (SPEC §3.5), and `limit + 1` rows are buffered before the response
        // is built — a single `?limit=500` over large documents would be gigabytes
        // of resident memory on a single-replica server (SPEC §8), i.e. an
        // authenticated OOM. The page type is `DocumentRow`, which cannot carry
        // them, so this exclusion cannot be forgotten. `metadata_only` drops
        // `content` here too, rather than blanking it in the route after the bytes
        // have already been read.
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
        // Flush first: a tombstoned document is still readable in Trash, so its
        // materialized fields must not trail into the grave.
        if let Some(room) = self.inner.cached_room(id) {
            self.inner.flush_room(&room).await?;
        }
        // A tombstone is a projection change: the row needs a fresh `feed_seq` or
        // no client ever learns the document moved to Trash (CONTRACTS.md docstore
        // M2 item 1). Allocate before the write, commit only if it matched — an
        // idempotent re-delete matches nothing and burns the number.
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
            // Either already tombstoned (idempotent) or truly absent.
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
        // A restore is a projection change too, and `updated_by` is "the last
        // applier the server saw" (SPEC §3.5) — which on a restore is whoever
        // clicked restore, so the actor is recorded rather than discarded.
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
        let mut state = room.state.lock().await;
        let snapshot_id = self
            .inner
            .write_snapshot(&room.id, &state, reason, actor)
            .await?;
        state.last_snapshot_ms = Some(now_ms());
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

    async fn restore_snapshot(
        &self,
        id: &str,
        snapshot_id: &str,
        actor: &Actor,
    ) -> Result<WriteOutcome, DocStoreError> {
        let snapshot = self
            .inner
            .collections
            .document_snapshots()
            .find_one(doc! { "_id": snapshot_id, "document_id": id })
            .await?
            .ok_or_else(|| DocStoreError::SnapshotNotFound(snapshot_id.to_string()))?;

        // Keep the pre-restore state recoverable.
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
            // Flush before dropping the room (SPEC §4.3: evict post-flush). A
            // room that cannot be flushed stays resident rather than losing its
            // unmaterialized state.
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

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without Mongo)
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    BsonDateTime::now().timestamp_millis()
}

fn binary(bytes: Vec<u8>) -> Binary {
    Binary {
        subtype: BinarySubtype::Generic,
        bytes,
    }
}

/// Cheap title for snapshot rows: the shared core resolves the real one at
/// materialization, but a snapshot is only ever previewed.
fn title_of(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "---")
        .map(|line| {
            let line = line.trim_start_matches('#').trim();
            line.chars()
                .take(limits::TITLE_FALLBACK_MAX_CHARS)
                .collect::<String>()
        })
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| limits::UNTITLED.to_string())
}

/// One `Y.Text` splice, in **UTF-16 code units** (SPEC §3.2 `OffsetKind::Utf16`).
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

/// Minimal single-splice diff between two texts: common prefix and suffix are
/// left alone so their CRDT history (and any concurrent edits) survive.
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

/// Convert shared-core [`TextEdit`](life_manager_core::splice::TextEdit)s (UTF-8
/// byte spans against `text`) into UTF-16 splices, ordered so that applying them
/// in sequence keeps every remaining offset valid.
fn edit_deltas(
    text: &str,
    edits: &[life_manager_core::splice::TextEdit],
) -> Result<Vec<TextSplice>, DocStoreError> {
    let mut ordered: Vec<&life_manager_core::splice::TextEdit> = edits.iter().collect();
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

/// Snapshot policy (SPEC §3.5): first edit after quiescence, plus a daily cap.
fn snapshot_reason(state: &RoomState, now_ms: i64) -> Option<&'static str> {
    match state.last_snapshot_ms {
        None => Some("quiescence"),
        Some(last) => {
            if now_ms - state.last_write_ms >= SNAPSHOT_QUIESCENCE.as_millis() as i64 {
                Some("quiescence")
            } else if last.div_euclid(DAY_MS) != now_ms.div_euclid(DAY_MS) {
                Some("daily")
            } else {
                None
            }
        }
    }
}

/// Which snapshots fall outside retention. `snapshots` is `(id, created_at_ms)`
/// **newest first**.
fn snapshots_to_prune(snapshots: &[(String, i64)], now_ms: i64) -> Vec<String> {
    let cutoff_day = now_ms.div_euclid(DAY_MS) - SNAPSHOT_KEEP_DAILY_DAYS;
    let mut seen_days: HashSet<i64> = HashSet::new();
    let mut prune = Vec::new();
    for (index, (id, at)) in snapshots.iter().enumerate() {
        let day = at.div_euclid(DAY_MS);
        if index < SNAPSHOT_KEEP_RECENT {
            seen_days.insert(day);
            continue;
        }
        if day <= cutoff_day {
            prune.push(id.clone());
            continue;
        }
        if seen_days.insert(day) {
            continue;
        }
        prune.push(id.clone());
    }
    prune
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use life_manager_core::document::Span;
    use life_manager_core::splice::TextEdit;

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
        // "😀" is one code point, two UTF-16 units, four UTF-8 bytes.
        let delta = text_delta("😀ab", "😀xb").unwrap();
        assert_eq!(delta.index, 2, "prefix must be measured in UTF-16 units");
        assert_eq!(delta.remove, 1);
        assert_eq!(delta.insert, "x");
    }

    #[test]
    fn text_delta_never_splits_a_multibyte_char() {
        // The two emoji share leading UTF-8 bytes; the prefix must back off to a
        // character boundary.
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
        // Byte 1 is inside the 4-byte emoji.
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
    fn snapshot_retention_keeps_the_recent_window() {
        let now = 30 * DAY_MS;
        let rows: Vec<(String, i64)> = (0..SNAPSHOT_KEEP_RECENT)
            .map(|i| (format!("s{i}"), now - i as i64 * 1000))
            .collect();
        assert!(snapshots_to_prune(&rows, now).is_empty());
    }

    #[test]
    fn snapshot_retention_keeps_one_per_day_then_prunes() {
        let now = 100 * DAY_MS;
        let mut rows: Vec<(String, i64)> = Vec::new();
        // Fill the recent window with today's snapshots.
        for i in 0..SNAPSHOT_KEEP_RECENT {
            rows.push((format!("recent{i}"), now - i as i64 * 1000));
        }
        // Two snapshots on the same (recent) day beyond the window — an hour
        // apart, so both fall on day 98: keep the newest, prune the older.
        rows.push(("day1-new".into(), now - 2 * DAY_MS + 3_600_000));
        rows.push(("day1-old".into(), now - 2 * DAY_MS));
        // Older than the daily retention horizon: pruned outright.
        rows.push(("ancient".into(), now - 90 * DAY_MS));

        let prune = snapshots_to_prune(&rows, now);
        assert!(prune.contains(&"day1-old".to_string()));
        assert!(prune.contains(&"ancient".to_string()));
        assert!(!prune.contains(&"day1-new".to_string()));
        assert!(!prune.contains(&"recent0".to_string()));
    }

    #[test]
    fn title_of_falls_back_predictably() {
        assert_eq!(title_of("# Heading\n\nbody"), "Heading");
        assert_eq!(title_of("\n\nfirst line\n"), "first line");
        assert_eq!(title_of("   \n"), limits::UNTITLED);
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

/// Integration tests against a real MongoDB. Ignored by default; run with
/// `MONGO_URI=mongodb://localhost:27017 cargo test -p life-manager-server -- --ignored`.
///
/// These drive the full write path, so they also depend on the shared core's
/// parser being implemented (`materialize` calls `parse_document`).
#[cfg(test)]
mod mongo_tests {
    use super::*;

    async fn store() -> Option<MongoDocStore> {
        let uri = std::env::var("MONGO_URI").ok()?;
        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let name = format!("life_manager_docstore_test_{}", new_id());
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

    /// A listed row must never carry CRDT bytes, and `metadata_only` must not read
    /// `content` at all: a page of 500 full rows is megabytes of `crdt` plus
    /// megabytes of text buffered in one request.
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
        // `DocumentRow` has no `crdt`/`state_vector` fields at all — the page type
        // is what guarantees the blobs are not read, so there is nothing to assert
        // beyond the materialized fields arriving.
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

    /// The purge is the point of no return; it must leave a trail (SPEC §5.4).
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
