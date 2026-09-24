//! The workspace change feed (SPEC §4.1, [`PROTOCOL.md`](../../../PROTOCOL.md) §2).
//!
//! One sequence-numbered stream of projection rows. Clients say "everything since
//! seq X" and get exactly that, then a live tail. This module owns the sequence
//! numbers, the in-process notification channel, and the two queries that read
//! rows out of Mongo.
//!
//! # The design, and the alternative that was rejected
//!
//! **Chosen: a `feed_seq` field on the rows themselves, plus a broadcast channel
//! of tiny notifications.**
//!
//! - `documents.feed_seq` — rewritten on every materialization, tombstone and
//!   restore. There is exactly **one row per document**, carrying its newest
//!   sequence number, so the feed is last-writer-wins per id by construction.
//! - `deleted_ids.feed_seq` — written once, at purge. The graveyard is permanent
//!   (SPEC §3.5) and a purged id can never be recreated, so this row can never be
//!   superseded and never needs trimming.
//! - "Everything since X" is therefore two indexed range scans (`feed_seq > X` on
//!   each collection) merged by `seq`. **Nothing truncates**, so `floor_seq` is
//!   always 0 and a resume is always exact, however long a client was offline.
//! - The broadcast channel carries only `{seq, id, kind}`. Rows are read from
//!   Mongo by the connection that needs them — the same code path catch-up uses.
//!
//! **Rejected: an append-only `document_feed` collection.** It would duplicate
//! the projection (up to 1 MiB of `content` per row, per change) or else store
//! only pointers and still need the same Mongo read; it needs trimming, and
//! trimming reintroduces a floor and a "resume impossible → bootstrap" path that
//! the chosen design does not need. Its one genuine advantage — a total order
//! that survives a restart with no `max()` scan — costs a collection that grows
//! forever. Not worth it at this scale.
//!
//! # Why the broadcast payload is not the row
//!
//! Fanning a full row (with `content`) to every connected client's queue is how a
//! 4 MiB paste turns into 40 MiB of resident memory on a single-replica server.
//! Notifications are ~64 bytes, so `broadcast::Receiver` lag is cheap and
//! recoverable: a lagged receiver simply re-reads from its watermark, which is
//! the same operation as catch-up.
//!
//! # `safe_seq`: why `max(committed)` is wrong
//!
//! A sequence number is allocated *before* its Mongo write and two writes can
//! commit out of order. If a client persisted `max(seq)` it had seen, it could
//! store 5 while 4 was still in flight — and then never ask for 4 again. So the
//! feed tracks **in-flight allocations** and publishes
//! `safe_seq = (lowest in-flight seq) - 1`, or `head` when nothing is in flight.
//! Clients persist that, never `max(seq)` (PROTOCOL.md §2.2).
//!
//! Allocations are released on commit *and* on drop, so a write that fails or
//! panics burns its number instead of stalling the watermark forever. Gaps in the
//! sequence are legal and expected.
//!
//! **Single replica.** The counter is an in-process `AtomicI64` seeded at boot
//! from `max(feed_seq)` across both collections — correct because SPEC §8 pins
//! `replicas: 1`. The v2 HA seam is named there: a Mongo `findOneAndUpdate`
//! counter (or change streams) replaces [`ChangeFeed::allocate`], and nothing
//! above this module changes.

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

/// First sequence number ever handed out. `0` means "the client has nothing".
pub const FEED_SEQ_START: i64 = 1;

/// Capacity of the notification broadcast channel. A receiver that falls further
/// behind than this gets `RecvError::Lagged` and re-reads from its watermark —
/// which is correct, just slower, so the bound can stay modest.
pub const NOTICE_CHANNEL_CAPACITY: usize = 1024;

/// Rows per catch-up page the server is willing to send in one `feed.batch`.
pub const FEED_BATCH_MAX_ROWS: u32 = 1000;
/// Default when the client does not ask (PROTOCOL.md §2.3).
pub const FEED_BATCH_DEFAULT_ROWS: u32 = 200;
/// Above this many pending rows the server answers `feed.reset`
/// (`bootstrap_required`) instead of streaming over the socket (PROTOCOL.md §2.3).
pub const FEED_CATCHUP_MAX_ROWS: u64 = 500;
/// Byte budget for one catch-up read ([`ChangeFeed::rows_since`]).
///
/// `limit` counts rows and a row carries the document text, so a count-only bound
/// lets a client ask for a gigabyte. The read stops here instead and reports a short
/// page, which the protocol already has a word for: `complete: false`. Sized to hold
/// a few `feed.batch` messages' worth, so the socket layer's own 512 KiB batch split
/// does the fine-grained work.
pub const FEED_PAGE_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Per-row allowance for everything in a row that is not `content` (title, `fm`,
/// `plugins`, timestamps, ids). Keeps a page of tiny rows from being counted as free.
const ROW_OVERHEAD_BYTES: usize = 1024;
/// Default page size for `GET /api/sync/bootstrap`.
pub const BOOTSTRAP_DEFAULT_LIMIT: u32 = 200;
/// Ceiling for `GET /api/sync/bootstrap?limit=`.
pub const BOOTSTRAP_MAX_LIMIT: u32 = 1000;

/// What happened to a document. Purely informational for the client — every kind
/// resolves to "here is the newest row for this id" — but it makes the metrics and
/// the logs readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedChangeKind {
    /// Created or edited (a materialization committed).
    Upsert,
    /// Moved to Trash.
    Tombstoned,
    /// Restored out of Trash.
    Restored,
    /// Purged: the row is gone and the id is in the graveyard forever.
    Purged,
}

/// The broadcast payload: enough to know *that* something changed and where it
/// sits in the sequence. Never the row itself (see the module docs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedNotice {
    pub seq: i64,
    pub id: Id,
    pub kind: FeedChangeKind,
}

/// One projection row on the wire, with its sequence number
/// (PROTOCOL.md §2.1). Shared by `feed.batch` and the bootstrap stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedRow {
    pub seq: i64,
    pub id: Id,
    pub title: String,
    /// Omitted when the subscription asked for metadata only, and for purge rows.
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
    /// In Trash (still readable and restorable) or purged.
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_by: Option<String>,
    /// `true` ⇒ permanently gone: the client drops its local row and any replica,
    /// offering recovery first if that replica held unsynced edits (SPEC §4.1).
    pub purged: bool,
}

impl FeedRow {
    /// Build a row from a stored projection row. Returns `None` when the row has
    /// no `feed_seq` — an un-backfilled pre-feed row, which the migration fixes
    /// and which must never be emitted with a made-up sequence number.
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

    /// A purge notice: the minimum a client needs to delete its local copy.
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

/// One page of feed rows, plus the watermark that goes with it.
#[derive(Debug, Clone)]
pub struct FeedPage {
    pub rows: Vec<FeedRow>,
    /// Watermark **after** this page: what the client persists.
    pub safe_seq: i64,
    pub head_seq: i64,
    /// `true` when this page exhausted the catch-up set.
    pub complete: bool,
}

/// One page of the bootstrap stream (`_id`-cursored, not seq-ordered).
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
    /// `since_seq` is beyond the server's head — the client is from the future
    /// (restored-from-backup server; SPEC §8 split-brain note).
    #[error("resume point {since} is ahead of head {head}")]
    SeqAhead { since: i64, head: i64 },
}

/// Guard for one allocated sequence number.
///
/// Hold it across the Mongo write, then `commit` it. Dropping it without
/// committing releases the number without publishing — so a failed write burns a
/// sequence number (legal) instead of freezing `safe_seq` (not legal).
#[derive(Debug)]
pub struct FeedAllocation {
    sequencer: Arc<FeedSequencer>,
    id: Id,
    seq: i64,
    committed: bool,
}

impl FeedAllocation {
    /// The number to write into the row's `feed_seq`.
    pub fn seq(&self) -> i64 {
        self.seq
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// The write committed: release the in-flight slot and notify subscribers.
    pub fn commit(mut self, kind: FeedChangeKind) {
        self.committed = true;
        let notice = FeedNotice {
            seq: self.seq,
            id: self.id.clone(),
            kind,
        };
        self.sequencer.release(self.seq);
        // A send error means nobody is listening; the row is still on disk and any
        // client will pick it up on its next catch-up. Never an error path.
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

/// Sequence-number allocation and the notification channel — the half of the feed
/// that needs no database. Separated so the watermark rules can be unit-tested
/// without a Mongo handle, and so the v2 HA swap (a Mongo counter) has exactly one
/// implementation to replace.
#[derive(Debug)]
pub struct FeedSequencer {
    /// Highest sequence number handed out.
    head: AtomicI64,
    /// Allocated but not yet committed, ascending. The lowest element is what
    /// bounds `safe_seq`.
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

    /// Seed the counter at boot, before the first write. Never lowers the head.
    pub fn set_head(&self, seq: i64) {
        self.head.fetch_max(seq, Ordering::SeqCst);
    }

    /// Highest sequence number handed out so far.
    pub fn head_seq(&self) -> i64 {
        self.head.load(Ordering::SeqCst)
    }

    /// The watermark clients persist: every sequence number ≤ it has committed or
    /// been burned.
    pub fn safe_seq(&self) -> i64 {
        let head = self.head_seq();
        let in_flight = self.in_flight.lock().expect("feed in-flight set poisoned");
        match in_flight.iter().next() {
            Some(lowest) => lowest - 1,
            None => head,
        }
    }

    /// Allocate the next sequence number for a write to `id`.
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

    /// Subscribe to the live tail. Lag is recoverable: re-read from the watermark.
    pub fn subscribe(&self) -> broadcast::Receiver<FeedNotice> {
        self.notices.subscribe()
    }

    /// Connections currently on the tail (for `/metrics`).
    pub fn subscriber_count(&self) -> usize {
        self.notices.receiver_count()
    }

    /// Release an in-flight allocation. Called by [`FeedAllocation`] only.
    fn release(&self, seq: i64) {
        self.in_flight
            .lock()
            .expect("feed in-flight set poisoned")
            .remove(&seq);
    }
}

/// The change feed. One per process, held by [`crate::state::AppState`]; the
/// docstore allocates through it, WebSocket connections read through it.
pub struct ChangeFeed {
    collections: Collections,
    sequencer: Arc<FeedSequencer>,
}

impl std::fmt::Debug for ChangeFeed {
    /// Hand-written because `db::Collections` is a Mongo handle, not data.
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

    /// Seed the counter from the database at boot: `max(feed_seq)` across
    /// `documents` and `deleted_ids`. Returns the head.
    ///
    /// Must run **before** the first write and before the first socket is served;
    /// `AppState::new` calls it.
    /// Implemented rather than stubbed because it sits on the **boot path**
    /// (`AppState::new`): a `todo!()` here would panic the server for every other
    /// area until the sync layer landed.
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

    /// Allocate the next sequence number for a write to `id`. Hold the guard
    /// across the Mongo write, then `commit` it.
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

    /// The allocator, for callers that need it without the database half.
    pub fn sequencer(&self) -> &Arc<FeedSequencer> {
        &self.sequencer
    }

    /// How many rows a client at `since_seq` is behind. Cheap count, used to
    /// decide catch-up versus `feed.reset { bootstrap_required }`.
    ///
    /// Deliberately **not** bounded by `safe_seq` (unlike [`Self::rows_since`]):
    /// this is a threshold input, and counting a row that is one millisecond from
    /// being deliverable cannot make the wrong decision — `FEED_CATCHUP_MAX_ROWS`
    /// is 500.
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

    /// One catch-up page: rows with `feed_seq > since_seq`, ascending, merged
    /// across `documents` and `deleted_ids`, at most `limit` of them.
    ///
    /// # Why the read is capped at `safe_seq`
    ///
    /// The range read is `since_seq < feed_seq <= safe_seq`, never
    /// `feed_seq > since_seq` alone. A sequence number is allocated *before* its
    /// Mongo write, so at any instant the numbers immediately below `head` may be
    /// half-written: reading past `safe_seq` can return 7 while 5 is still in
    /// flight. A tail cursor that advanced to 7 would never ask for 5 again, and
    /// that document would stay stale on that client for the life of the socket.
    ///
    /// Capping the read instead means every page is **gapless by construction**:
    /// everything in `(since_seq, page.safe_seq]` is in this page or an earlier
    /// one, so the cursor *is* the watermark and the two can never disagree. The
    /// cost is that a row waits for its own allocation to commit — microseconds to
    /// milliseconds — which the ~50 ms tail coalescing window swallows whole.
    /// (PROTOCOL.md §2.2 permits rows above `safe_seq` on the wire; it does not
    /// require them.)
    ///
    /// # Why the read is also capped in bytes
    ///
    /// `limit` counts rows, and a row carries the whole document text — up to
    /// `MAX_DOCUMENT_BYTES`. A client may ask for 1 000 of them
    /// ([`FEED_BATCH_MAX_ROWS`]), so a count-only bound admits a gigabyte-sized
    /// `Vec<DocumentRow>` per socket on a single-replica server. The read therefore
    /// stops at [`FEED_PAGE_MAX_BYTES`] of `content` and returns a short page, which
    /// is a case the caller already handles: a page that did not exhaust the range is
    /// `complete: false`, and the client asks for the rest from the watermark this
    /// one reports.
    ///
    /// # Why a short read forces the watermark down
    ///
    /// Each source is read ascending from `since_seq`, so a page is gapless only up
    /// to the point where **every** source it merges has been read. Whenever a source
    /// is cut short — by the row limit, or by the byte budget — the page's watermark
    /// is pinned to the lowest such cut-off, and rows above it are dropped rather
    /// than delivered with a watermark that would skip their neighbours. That is the
    /// whole correctness argument of this function: `safe_seq` is never a number
    /// above which the page could be missing something.
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
            // Caught up to the watermark. Never report a watermark *below* the
            // client's own resume point: that would walk it backwards.
            return Ok(FeedPage {
                rows: Vec::new(),
                safe_seq: safe.max(since_seq),
                head_seq: head,
                complete: true,
            });
        }

        let range = doc! { "$gt": since_seq, "$lte": safe };

        // The document source, read row by row so the byte budget can stop it.
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

        // A source that was cut short — by the row limit or the byte budget — may have
        // more behind it, so it bounds how far this page can claim to have delivered.
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

        // Rows above the cut are dropped, not delivered: sending them would be
        // harmless on its own (rows are idempotent) but the watermark that went with
        // them would skip whatever sits between the cut and them in the other source.
        if let Some(cut) = cut_seq {
            rows.retain(|row| row.seq <= cut);
        }

        // The row limit is the other cut, and it must not split a group of rows
        // sharing one sequence number (see `truncate_at_seq_boundary`).
        if truncate_at_seq_boundary(&mut rows, limit as usize) {
            let last = rows.last().map_or(since_seq, |row| row.seq);
            cut_seq = Some(cut_seq.map_or(last, |current| current.min(last)));
        }

        // Nothing was cut ⇒ the page exhausted `(since_seq, safe]`.
        let complete = cut_seq.is_none();
        let safe_seq = cut_seq.unwrap_or(safe);

        Ok(FeedPage {
            rows,
            safe_seq,
            head_seq: head,
            complete,
        })
    }

    /// One bootstrap page as a **live cursor** — `limit + 1` rows so the caller can
    /// tell whether a tail follows, and not one of them collected into a `Vec`.
    ///
    /// This is what `GET /api/sync/bootstrap` reads (PROTOCOL.md §4 calls the
    /// response streamed). A page of 1 000 rows near the 1 MiB text cap (SPEC §3.5)
    /// is a gigabyte if it is buffered, and the endpoint takes a client-chosen
    /// `limit` — so the honest implementation hands the row stream to the response
    /// body and never holds more than one row.
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

    /// One bootstrap page, collected: `_id`-ordered, cursored, independent of
    /// `feed_seq` (PROTOCOL.md §4).
    ///
    /// The route does **not** use this — it streams [`Self::bootstrap_cursor`]
    /// straight into the response body. It stays because the signature is frozen
    /// and because tests and scripts want a page as a value; nothing on a request
    /// path may call it with a large `limit`.
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

        // `limit + 1` is how the tail is detected without a second count query.
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
        // The cursor is the last `_id` *read*, not the last row emitted: a row with
        // no `feed_seq` (pre-feed, awaiting the backfill migration) is skipped but
        // must still advance the cursor, or the next page repeats this one forever.
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

    /// Total documents a bootstrap pass will emit, for the progress screen.
    pub async fn bootstrap_total(&self, trash: TrashFilter) -> Result<u64, FeedError> {
        Ok(self
            .collections
            .documents()
            .count_documents(Self::trash_filter(trash))
            .await?)
    }

    /// `documents` typed as the projection shape the feed and bootstrap read.
    /// `Collections` hands out `Collection<Document>` (CRDT blobs included), which
    /// no multi-row query may deserialize (SPEC §3.5: 2–10× the plaintext).
    fn document_rows(&self) -> mongodb::Collection<DocumentRow> {
        self.collections
            .database()
            .collection::<DocumentRow>(db::DOCUMENTS)
    }

    /// The Mongo filter for a trash selection. Shared by the queries above so the
    /// feed and the REST list can never disagree about what "live" means.
    pub fn trash_filter(trash: TrashFilter) -> BsonDocument {
        match trash {
            TrashFilter::Live => doc! { "deleted_at": { "$exists": false } },
            TrashFilter::Trashed => doc! { "deleted_at": { "$exists": true } },
            TrashFilter::All => doc! {},
        }
    }

    /// The collections this feed reads. Exposed for the queries above (and for
    /// tests that seed rows directly).
    pub fn collections(&self) -> &Collections {
        &self.collections
    }
}

/// Cut a merged, `seq`-ascending page down to `limit` rows **without splitting a
/// group of rows that share one sequence number**. Returns `true` when anything
/// was dropped.
///
/// Sequence numbers are supposed to be unique per row, and in a workspace this
/// server has always owned they are. They can still collide: a database restored
/// from a backup, or (before the boot order was fixed) a migration that backfilled
/// numbers the in-process allocator then handed out again. The watermark rule of a
/// truncated page is "everything at or below the last delivered row has been
/// delivered" — which is false if two rows share that number and only one of them
/// fits, because the cursor moves to `seq` and the next read asks for `> seq`. The
/// second row would then never be delivered to that client, on this or any future
/// connection. Keeping the whole group costs a slightly over-long page and makes
/// the guarantee hold unconditionally.
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

/// Highest `feed_seq` in one collection, or `FEED_SEQ_START - 1` when it holds no
/// numbered row yet. One indexed descending read, not an aggregation: the
/// `feed_seq` index makes it a single seek.
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

/// Read every row a cursor yields into `FeedRow`s, skipping rows with no
/// `feed_seq`. Helper for the query implementations above.
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

        // Out-of-order commit: 2 lands first. The watermark must stay below 1's
        // number, or a client would persist 2 and never ask for 1 again.
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
        // The number is gone (a gap — legal), and the watermark is free to move.
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

        // The ordinary case: unique numbers, cut exactly at the limit.
        let mut rows = vec![row(1), row(2), row(3), row(4)];
        assert!(truncate_at_seq_boundary(&mut rows, 2));
        assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);

        // Duplicated numbers straddling the boundary: the group stays whole, so the
        // watermark this page reports (2) really has delivered everything ≤ 2.
        let mut rows = vec![row(1), row(2), row(2), row(3)];
        assert!(truncate_at_seq_boundary(&mut rows, 2));
        assert_eq!(
            rows.iter().map(|r| r.seq).collect::<Vec<_>>(),
            vec![1, 2, 2]
        );

        // A page that fits is untouched, and a page that is one whole group makes
        // progress rather than looping forever.
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
