//! Persisted domain types — the Mongo document shapes of SPEC §3.5.
//!
//! **FROZEN CONTRACT.** Every builder area reads and writes these; nobody
//! changes a field name, a type, or a `serde` attribute without re-negotiating
//! with every other area. Add new *optional* fields only.
//!
//! Conventions:
//! - `_id` is a ULID string (client-mintable offline, SPEC §3.5).
//! - Stored timestamps are `bson::DateTime` (millisecond precision, UTC); every
//!   *view* uses [`Timestamp`], which serializes as an RFC 3339 string. Extended
//!   JSON never reaches a client (PROTOCOL.md §2.1).
//! - `*_by` holds a user id (or a plugin id prefixed `plugin:`) and means "last
//!   applier the server saw", not authorship.

use bson::{Binary, DateTime as BsonDateTime, Document as BsonDocument};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

/// A ULID, stored as its 26-character canonical string.
pub type Id = String;

// ---------------------------------------------------------------------------
// Wire-format primitives
// ---------------------------------------------------------------------------

/// A timestamp **on the wire**: serialized as an RFC 3339 / ISO-8601 UTC string
/// with millisecond precision, deserialized from the same.
///
/// Stored rows use `bson::DateTime`; every *view* uses this. The distinction is
/// not cosmetic: `bson::DateTime` serializes through `serde_json` as MongoDB
/// extended JSON (`{"$date": …}`), which no client should ever have to parse and
/// which the sync protocol forbids outright (PROTOCOL.md §2.1). Converting at the
/// view boundary makes that impossible to get wrong by accident.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Timestamp(BsonDateTime);

impl Timestamp {
    pub fn now() -> Self {
        Self(BsonDateTime::now())
    }

    pub fn from_millis(millis: i64) -> Self {
        Self(BsonDateTime::from_millis(millis))
    }

    pub fn timestamp_millis(self) -> i64 {
        self.0.timestamp_millis()
    }

    pub fn to_bson(self) -> BsonDateTime {
        self.0
    }

    /// The wire form. Falls back to the epoch for a value outside RFC 3339's
    /// range (a corrupt row must not fail a whole response).
    pub fn to_rfc3339(self) -> String {
        self.0
            .try_to_rfc3339_string()
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
    }
}

impl From<BsonDateTime> for Timestamp {
    fn from(value: BsonDateTime) -> Self {
        Self(value)
    }
}

impl From<Timestamp> for BsonDateTime {
    fn from(value: Timestamp) -> Self {
        value.0
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_rfc3339())
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        BsonDateTime::parse_rfc3339_str(&raw)
            .map(Self)
            .map_err(|error| D::Error::custom(format!("invalid RFC 3339 timestamp: {error}")))
    }
}

/// Convert a materialized `fm`/`plugins` sub-document to plain JSON.
///
/// These only ever hold the shared-core value model (SPEC §3.4) — the write path
/// builds them with `core::value::map_to_bson` — but routing them through the
/// core's own bridge means a stray `DateTime` or `Binary` that somehow reached a
/// row degrades to a string instead of leaking extended JSON to clients.
pub fn materialized_to_json(document: &BsonDocument) -> serde_json::Value {
    let mut object = serde_json::Map::with_capacity(document.len());
    for (key, value) in ddd_core::value::map_from_bson(document) {
        object.insert(key, value.to_json());
    }
    serde_json::Value::Object(object)
}

/// Mint a new ULID string.
pub fn new_id() -> Id {
    ulid::Ulid::generate().to_string()
}

/// `true` iff `id` is a syntactically valid ULID (clients mint their own).
pub fn is_valid_id(id: &str) -> bool {
    ulid::Ulid::from_string(id).is_ok()
}

/// Who performed a write. Serialized as a string: `"<user-ulid>"`,
/// `"plugin:<plugin-id>"`, `"system"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    User(Id),
    Plugin(String),
    System,
}

impl Actor {
    /// The stored `*_by` string.
    pub fn as_stored(&self) -> String {
        match self {
            Actor::User(id) => id.clone(),
            Actor::Plugin(id) => format!("plugin:{id}"),
            Actor::System => "system".to_string(),
        }
    }

    /// The user id, when this actor is a user.
    pub fn user_id(&self) -> Option<&str> {
        match self {
            Actor::User(id) => Some(id),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/// Collection `documents`. The CRDT state is authoritative; every other field is
/// derived and may trail it (see `materialized_version`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    #[serde(rename = "_id")]
    pub id: Id,
    /// Encoded Yjs state (update encoding v1, compacted).
    pub crdt: Binary,
    /// State-vector cache, derivable from `crdt`, written in the same write.
    pub state_vector: Binary,
    /// Materialized full text (all three regions).
    pub content: String,
    /// Materialized title (indexed).
    pub title: String,
    /// Materialized frontmatter.
    pub fm: BsonDocument,
    /// Materialized `%%%` sections: plugin id → keys.
    pub plugins: BsonDocument,
    /// State-vector hash of the CRDT state the materialized fields came from.
    pub materialized_version: String,
    /// Any frontmatter line was dropped at parse.
    pub fm_parse_error: bool,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
    pub updated_at: BsonDateTime,
    pub updated_by: Option<String>,
    /// Tombstone (Trash). `Some` ⇒ the document is in Trash.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_at: Option<BsonDateTime>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_by: Option<String>,
    /// Workspace-global change-feed sequence number (SPEC §4.1, PROTOCOL.md §2.2).
    /// Rewritten on every materialization, tombstone and restore. `None` only on
    /// rows written before the feed existed (migration backfills them).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub feed_seq: Option<i64>,
}

/// A document row **without the CRDT blobs** — the shape every list, feed and
/// bootstrap query reads out of Mongo.
///
/// It exists because `Document` is a promise the list path cannot keep: `crdt`
/// and `state_vector` are 2–10× the plaintext and compacted only above 4 MiB
/// (SPEC §3.5), so no query that returns many rows may read them. Those queries
/// project them away, which used to mean handing back `Document` values with
/// empty placeholder blobs — a type that lied. This one does not: if you hold a
/// `DocumentRow`, there are no CRDT bytes to be had, and `DocStore::get`/
/// `crdt_state` is where you go for them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentRow {
    #[serde(rename = "_id")]
    pub id: Id,
    /// Materialized full text. Empty when the query asked for metadata only.
    #[serde(default)]
    pub content: String,
    pub title: String,
    #[serde(default)]
    pub fm: BsonDocument,
    #[serde(default)]
    pub plugins: BsonDocument,
    pub materialized_version: String,
    #[serde(default)]
    pub fm_parse_error: bool,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
    pub updated_at: BsonDateTime,
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_at: Option<BsonDateTime>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub feed_seq: Option<i64>,
}

impl DocumentRow {
    /// The Mongo projection that yields exactly these fields. One definition, so
    /// a new field cannot be added to the struct and forgotten in three queries.
    pub fn projection(include_content: bool) -> BsonDocument {
        let mut projection = bson::doc! {
            "title": 1, "fm": 1, "plugins": 1, "materialized_version": 1,
            "fm_parse_error": 1, "created_at": 1, "created_by": 1,
            "updated_at": 1, "updated_by": 1, "deleted_at": 1, "deleted_by": 1,
            "feed_seq": 1,
        };
        if include_content {
            projection.insert("content", 1);
        }
        projection
    }

    pub fn deleted(&self) -> bool {
        self.deleted_at.is_some()
    }
}

impl From<Document> for DocumentRow {
    fn from(doc: Document) -> Self {
        Self {
            id: doc.id,
            content: doc.content,
            title: doc.title,
            fm: doc.fm,
            plugins: doc.plugins,
            materialized_version: doc.materialized_version,
            fm_parse_error: doc.fm_parse_error,
            created_at: doc.created_at,
            created_by: doc.created_by,
            updated_at: doc.updated_at,
            updated_by: doc.updated_by,
            deleted_at: doc.deleted_at,
            deleted_by: doc.deleted_by,
            feed_seq: doc.feed_seq,
        }
    }
}

/// The materialized projection of a document **as it goes out on the wire** —
/// what `GET /api/documents` and `GET /api/documents/:id` return, and the same
/// field set the change feed replicates (SPEC §4.1, PROTOCOL.md §2.1).
///
/// Timestamps are RFC 3339 strings and `fm`/`plugins` are plain JSON: no
/// extended JSON reaches a client, ever.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentView {
    pub id: Id,
    pub title: String,
    pub content: String,
    pub fm: serde_json::Value,
    pub plugins: serde_json::Value,
    pub fm_parse_error: bool,
    pub materialized_version: String,
    pub created_at: Timestamp,
    pub created_by: Option<String>,
    pub updated_at: Timestamp,
    pub updated_by: Option<String>,
    /// `true` ⇒ in Trash (SPEC §3.5). Explicit so clients need no null-checking
    /// convention to answer the question they actually ask.
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_by: Option<String>,
}

impl From<DocumentRow> for DocumentView {
    fn from(row: DocumentRow) -> Self {
        Self {
            id: row.id,
            title: row.title,
            content: row.content,
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
        }
    }
}

impl From<Document> for DocumentView {
    fn from(doc: Document) -> Self {
        DocumentRow::from(doc).into()
    }
}

/// Collection `document_updates` — incremental Yjs updates, trimmed per document
/// (never a capped collection; correctness never depends on retention).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentUpdate {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    /// Monotonic per-document sequence number.
    pub seq: i64,
    /// Yjs update, encoding v1.
    pub update: Binary,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
}

/// Collection `document_changes` — what each text-changing write did to the text, as
/// hunks against the text before it (`changes.rs`). Kept `CHANGE_RETENTION_DAYS`; the
/// history the Changes view reads and a revert rewinds through.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentChange {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    /// The update-log `seq` of the last write this change covers.
    pub seq: i64,
    /// The first, when live typing was folded into one record (`dev-docs/resolved/HISTORY.md`);
    /// absent for a single write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_seq: Option<i64>,
    /// When the first write was made.
    pub created_at: BsonDateTime,
    /// When the last folded-in write was made; absent for a single write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<BsonDateTime>,
    pub created_by: Option<String>,
    /// Against the text before `first_seq`.
    pub hunks: Vec<StoredHunk>,
    /// Set on the change a revert wrote: the group it undid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverts: Option<RevertNote>,
    /// Made while the author was offline, and carried over on reconnect.
    /// `created_at` is then when it was made (the client's claim, kept in order);
    /// `received_at` is when the server got it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub offline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received_at: Option<BsonDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredHunk {
    /// Byte offset into the text before the change.
    pub pos: i64,
    pub removed: String,
    pub inserted: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevertNote {
    pub from_seq: i64,
    pub to_seq: i64,
}

impl DocumentChange {
    /// The pure form `changes.rs` works on.
    pub fn to_change(&self) -> crate::changes::Change {
        crate::changes::Change {
            first_seq: self.first_seq.unwrap_or(self.seq),
            seq: self.seq,
            at_ms: self.ended_at.unwrap_or(self.created_at).timestamp_millis(),
            by: self.created_by.clone(),
            hunks: self
                .hunks
                .iter()
                .map(|hunk| crate::changes::Hunk {
                    pos: hunk.pos.max(0) as usize,
                    removed: hunk.removed.clone(),
                    inserted: hunk.inserted.clone(),
                })
                .collect(),
        }
    }
}

/// Collection `document_history` — the **squashed tier**: one group of changes (one
/// author, no long pause) older than `RAW_CHANGE_DAYS`, as its net hunks against the text
/// before `from_seq`. The raw changes it replaces are deleted (`dev-docs/resolved/HISTORY.md`). Kept
/// forever.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentHistory {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    pub from_seq: i64,
    pub to_seq: i64,
    pub started_at: BsonDateTime,
    pub ended_at: BsonDateTime,
    pub created_by: Option<String>,
    /// Writes the group was made of.
    pub changes: i64,
    pub hunks: Vec<StoredHunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverts: Option<RevertNote>,
    /// Some of the writes were made offline.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub offline: bool,
}

impl DocumentHistory {
    /// As one change ending at `to_seq`: what replay, diffs and revert work on.
    pub fn to_change(&self) -> crate::changes::Change {
        crate::changes::Change {
            first_seq: self.from_seq,
            seq: self.to_seq,
            at_ms: self.ended_at.timestamp_millis(),
            by: self.created_by.clone(),
            hunks: self
                .hunks
                .iter()
                .map(|hunk| crate::changes::Hunk {
                    pos: hunk.pos.max(0) as usize,
                    removed: hunk.removed.clone(),
                    inserted: hunk.inserted.clone(),
                })
                .collect(),
        }
    }
}

/// Collection `document_checkpoints` — the full text at a `seq`, written every
/// `CHECKPOINT_EVERY_CHANGES` changes and when a document is created. Any point in time
/// is rebuilt from the nearest one (`dev-docs/resolved/HISTORY.md`). Kept forever.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentCheckpoint {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    /// The text after every update up to and including this one.
    pub seq: i64,
    pub text: String,
    pub created_at: BsonDateTime,
}

/// Collection `document_snapshots` — per-document retention (last 20 + one per
/// day for 30 days).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSnapshot {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    /// Full encoded CRDT state at snapshot time.
    pub crdt: Binary,
    /// Materialized text at snapshot time (so restore previews need no yrs).
    pub content: String,
    pub title: String,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
    /// Why it was taken: `quiescence` | `daily` | `manual` | `pre_restore`.
    pub reason: String,
}

/// Collection `deleted_ids` — the permanent graveyard. Consulted by every
/// sync/create path so a long-offline client can never resurrect a document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraveyardEntry {
    #[serde(rename = "_id")]
    pub id: Id,
    pub deleted_at: BsonDateTime,
    pub deleted_by: Option<String>,
    /// Change-feed sequence number of the purge. Written once, never rewritten —
    /// which is what lets the feed serve "everything since X" for *any* X without
    /// an append-only feed collection (PROTOCOL.md §2.2). `None` on graveyard rows
    /// written before the feed existed.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub feed_seq: Option<i64>,
}

// ---------------------------------------------------------------------------
// users, sessions, invites
// ---------------------------------------------------------------------------

/// Collection `users`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    #[serde(rename = "_id")]
    pub id: Id,
    /// Lowercased, trimmed. Unique index.
    pub email: String,
    /// Display name; defaults to the email local part.
    pub name: String,
    /// argon2id PHC string (SPEC §5.2).
    pub password_hash: String,
    pub is_admin: bool,
    /// `false` after an admin deletes the user; attribution ids stay rendered as
    /// "deleted user" (SPEC §5.1).
    pub is_active: bool,
    pub created_at: BsonDateTime,
    pub updated_at: BsonDateTime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_login_at: Option<BsonDateTime>,
    /// Invite this user registered with, when not the first user.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub invited_by: Option<Id>,
}

/// The user shape returned by `GET /api/auth/me` and the admin user list — never
/// carries the password hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserView {
    pub id: Id,
    pub email: String,
    pub name: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub created_at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_login_at: Option<Timestamp>,
}

impl From<User> for UserView {
    fn from(user: User) -> Self {
        Self {
            id: user.id,
            email: user.email,
            name: user.name,
            is_admin: user.is_admin,
            is_active: user.is_active,
            created_at: user.created_at.into(),
            last_login_at: user.last_login_at.map(Timestamp::from),
        }
    }
}

/// Collection `sessions`. Rolling: 30-day idle, 180-day absolute (SPEC §5.2).
/// `_id` is the SHA-256 hex of the session token — the raw token is never stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    #[serde(rename = "_id")]
    pub id: String,
    pub user_id: Id,
    /// `cookie` (browser) or `bearer` (shell).
    pub kind: SessionKind,
    pub created_at: BsonDateTime,
    pub last_seen_at: BsonDateTime,
    /// Idle expiry; refreshed on use.
    pub expires_at: BsonDateTime,
    /// Absolute expiry; never extended.
    pub absolute_expires_at: BsonDateTime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ip: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Cookie,
    Bearer,
}

/// Collection `invites` — 7-day expiry, single-use, non-admin only (SPEC §5.1).
/// `_id` is the SHA-256 hex of the invite token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invite {
    #[serde(rename = "_id")]
    pub id: String,
    /// Optional pre-filled email; when set, registration must match it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub email: Option<String>,
    pub created_at: BsonDateTime,
    pub created_by: Id,
    pub expires_at: BsonDateTime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub used_at: Option<BsonDateTime>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub used_by: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub revoked_at: Option<BsonDateTime>,
}

/// Collection `password_resets` — one-time admin-issued reset links and the
/// `ddd reset-password` CLI path (SPEC §5.1). `_id` is the token hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordReset {
    #[serde(rename = "_id")]
    pub id: String,
    pub user_id: Id,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
    pub expires_at: BsonDateTime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub used_at: Option<BsonDateTime>,
}

/// Collection `login_attempts` — per-IP and per-account backoff input (SPEC §5.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginAttempt {
    #[serde(rename = "_id")]
    pub id: Id,
    /// Lowercased email as submitted (may not exist as a user).
    pub email: String,
    pub ip: Option<String>,
    pub succeeded: bool,
    pub created_at: BsonDateTime,
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

/// Collection `attachments` (SPEC §3.6). Bytes live in GridFS bucket
/// [`crate::db::GRIDFS_BUCKET`], keyed by `gridfs_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    #[serde(rename = "_id")]
    pub id: Id,
    pub name: String,
    /// Sniffed MIME type, not the client's claim.
    pub mime: String,
    pub size: u64,
    /// Lowercase hex SHA-256 of the bytes.
    pub sha256: String,
    /// Bumped on every replace; the `If-Match` value.
    pub revision: u32,
    /// GridFS file id for the current revision.
    pub gridfs_id: bson::Bson,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
    pub updated_at: BsonDateTime,
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_at: Option<BsonDateTime>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_by: Option<String>,
}

/// Attachment metadata as returned by the API (`GET /api/attachments/:id/meta`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentView {
    pub id: Id,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
    pub revision: u32,
    pub created_at: Timestamp,
    pub created_by: Option<String>,
    pub updated_at: Timestamp,
    pub updated_by: Option<String>,
}

impl From<Attachment> for AttachmentView {
    fn from(a: Attachment) -> Self {
        Self {
            id: a.id,
            name: a.name,
            mime: a.mime,
            size: a.size,
            sha256: a.sha256,
            revision: a.revision,
            created_at: a.created_at.into(),
            created_by: a.created_by,
            updated_at: a.updated_at.into(),
            updated_by: a.updated_by,
        }
    }
}

/// Collection `uploads` — a chunked upload on its way in (SPEC §3.6,
/// `routes/uploads.rs`). The bytes received so far are already GridFS chunks of
/// `gridfs_id`; the GridFS file record and the [`Attachment`] row are written when
/// it completes. The row outlives completion (with `attachment_id` set) so a client
/// that lost the answer can ask again, and is swept `expires_at` after its last use.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadSession {
    #[serde(rename = "_id")]
    pub id: Id,
    /// Only this user may add to, finish, or cancel it.
    pub user_id: Id,
    /// Sanitized filename.
    pub name: String,
    /// Declared total size; the upload is complete when `offset` reaches it.
    pub size: u64,
    /// Bytes received and stored so far.
    pub offset: u64,
    /// The GridFS file id the chunks belong to.
    pub gridfs_id: bson::Bson,
    /// The first bytes, kept for MIME sniffing at completion.
    pub head: Binary,
    /// Create a wrapper document on completion. Clients file it themselves.
    #[serde(default)]
    pub wrapper: bool,
    /// Set once completed.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub attachment_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub document_id: Option<Id>,
    pub created_at: BsonDateTime,
    pub expires_at: BsonDateTime,
}

// ---------------------------------------------------------------------------
// audit log, meta
// ---------------------------------------------------------------------------

/// Collection `audit_log` — destructive and administrative actions (SPEC §5.4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    #[serde(rename = "_id")]
    pub id: Id,
    /// Dotted action name, e.g. `document.delete`, `user.demote`,
    /// `invite.revoke`, `attachment.delete`, `snapshot.restore`.
    pub action: String,
    /// `actor.as_stored()`; `None` for unauthenticated paths.
    pub actor: Option<String>,
    /// Type of the thing acted on: `document` | `user` | `invite` |
    /// `attachment` | `session` | `plugin`.
    pub target_kind: String,
    pub target_id: Option<String>,
    /// Free-form, action-specific detail. Never contains secrets.
    #[serde(default)]
    pub detail: BsonDocument,
    pub ip: Option<String>,
    pub created_at: BsonDateTime,
}

impl AuditEntry {
    /// Build an entry with `id`/`created_at` filled in.
    pub fn new(
        action: impl Into<String>,
        actor: Option<&Actor>,
        target_kind: impl Into<String>,
        target_id: Option<String>,
    ) -> Self {
        Self {
            id: new_id(),
            action: action.into(),
            actor: actor.map(Actor::as_stored),
            target_kind: target_kind.into(),
            target_id,
            detail: BsonDocument::new(),
            ip: None,
            created_at: BsonDateTime::now(),
        }
    }

    pub fn with_detail(mut self, detail: BsonDocument) -> Self {
        self.detail = detail;
        self
    }

    pub fn with_ip(mut self, ip: Option<String>) -> Self {
        self.ip = ip;
        self
    }
}

/// Collection `meta`, single document `_id: "schema"` (SPEC §3.5 migrations).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaMeta {
    #[serde(rename = "_id")]
    pub id: String,
    pub schema_version: i32,
    pub updated_at: BsonDateTime,
    /// Set while a migration holds the advisory lock.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub migration_lock: Option<MigrationLock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationLock {
    pub holder: String,
    pub acquired_at: BsonDateTime,
    pub expires_at: BsonDateTime,
}
