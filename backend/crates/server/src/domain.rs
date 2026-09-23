//! Persisted domain types — the Mongo document shapes of SPEC §3.5.
//!
//! **FROZEN CONTRACT.** Every builder area reads and writes these; nobody
//! changes a field name, a type, or a `serde` attribute without re-negotiating
//! with every other area. Add new *optional* fields only.
//!
//! Conventions:
//! - `_id` is a ULID string (client-mintable offline, SPEC §3.5).
//! - Timestamps are `bson::DateTime` (millisecond precision, UTC).
//! - `*_by` holds a user id (or a plugin id prefixed `plugin:`) and means "last
//!   applier the server saw", not authorship.

use bson::{Binary, DateTime as BsonDateTime, Document as BsonDocument};
use serde::{Deserialize, Serialize};

/// A ULID, stored as its 26-character canonical string.
pub type Id = String;

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
}

/// The materialized projection of a document — what `GET /api/documents` and
/// `GET /api/documents/:id` return, and what replicates to clients in M2
/// (SPEC §4.1). Never contains CRDT bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentView {
    pub id: Id,
    pub title: String,
    pub content: String,
    pub fm: BsonDocument,
    pub plugins: BsonDocument,
    pub fm_parse_error: bool,
    pub materialized_version: String,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
    pub updated_at: BsonDateTime,
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_at: Option<BsonDateTime>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deleted_by: Option<String>,
}

impl From<Document> for DocumentView {
    fn from(doc: Document) -> Self {
        Self {
            id: doc.id,
            title: doc.title,
            content: doc.content,
            fm: doc.fm,
            plugins: doc.plugins,
            fm_parse_error: doc.fm_parse_error,
            materialized_version: doc.materialized_version,
            created_at: doc.created_at,
            created_by: doc.created_by,
            updated_at: doc.updated_at,
            updated_by: doc.updated_by,
            deleted_at: doc.deleted_at,
            deleted_by: doc.deleted_by,
        }
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
    pub created_at: BsonDateTime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_login_at: Option<BsonDateTime>,
}

impl From<User> for UserView {
    fn from(user: User) -> Self {
        Self {
            id: user.id,
            email: user.email,
            name: user.name,
            is_admin: user.is_admin,
            is_active: user.is_active,
            created_at: user.created_at,
            last_login_at: user.last_login_at,
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
/// `life-manager reset-password` CLI path (SPEC §5.1). `_id` is the token hash.
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
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
    pub updated_at: BsonDateTime,
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
            created_at: a.created_at,
            created_by: a.created_by,
            updated_at: a.updated_at,
            updated_by: a.updated_by,
        }
    }
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
