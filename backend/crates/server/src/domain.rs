use bson::{Binary, DateTime as BsonDateTime, Document as BsonDocument};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

pub type Id = String;

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

pub fn materialized_to_json(document: &BsonDocument) -> serde_json::Value {
    let mut object = serde_json::Map::with_capacity(document.len());
    for (key, value) in ddd_core::value::map_from_bson(document) {
        object.insert(key, value.to_json());
    }
    serde_json::Value::Object(object)
}

pub fn new_id() -> Id {
    ulid::Ulid::generate().to_string()
}

pub fn is_valid_id(id: &str) -> bool {
    ulid::Ulid::from_string(id).is_ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    User(Id),
    Plugin(String),
    System,
}

impl Actor {
    pub fn as_stored(&self) -> String {
        match self {
            Actor::User(id) => id.clone(),
            Actor::Plugin(id) => format!("plugin:{id}"),
            Actor::System => "system".to_string(),
        }
    }

    pub fn user_id(&self) -> Option<&str> {
        match self {
            Actor::User(id) => Some(id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    #[serde(rename = "_id")]
    pub id: Id,
    pub crdt: Binary,
    pub state_vector: Binary,
    pub content: String,
    pub title: String,
    pub fm: BsonDocument,
    pub plugins: BsonDocument,
    pub materialized_version: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentRow {
    #[serde(rename = "_id")]
    pub id: Id,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentUpdate {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    pub seq: i64,
    pub update: Binary,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentChange {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    pub seq: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_seq: Option<i64>,
    pub created_at: BsonDateTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<BsonDateTime>,
    pub created_by: Option<String>,
    pub hunks: Vec<StoredHunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverts: Option<RevertNote>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub offline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received_at: Option<BsonDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredHunk {
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
    pub changes: i64,
    pub hunks: Vec<StoredHunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverts: Option<RevertNote>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub offline: bool,
}

impl DocumentHistory {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentCheckpoint {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    pub seq: i64,
    pub text: String,
    pub created_at: BsonDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSnapshot {
    #[serde(rename = "_id")]
    pub id: Id,
    pub document_id: Id,
    pub crdt: Binary,
    pub content: String,
    pub title: String,
    pub created_at: BsonDateTime,
    pub created_by: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraveyardEntry {
    #[serde(rename = "_id")]
    pub id: Id,
    pub deleted_at: BsonDateTime,
    pub deleted_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub feed_seq: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    #[serde(rename = "_id")]
    pub id: Id,
    pub email: String,
    pub name: String,
    pub password_hash: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub created_at: BsonDateTime,
    pub updated_at: BsonDateTime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_login_at: Option<BsonDateTime>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub invited_by: Option<Id>,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    #[serde(rename = "_id")]
    pub id: String,
    pub user_id: Id,
    pub kind: SessionKind,
    pub created_at: BsonDateTime,
    pub last_seen_at: BsonDateTime,
    pub expires_at: BsonDateTime,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invite {
    #[serde(rename = "_id")]
    pub id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginAttempt {
    #[serde(rename = "_id")]
    pub id: Id,
    pub email: String,
    pub ip: Option<String>,
    pub succeeded: bool,
    pub created_at: BsonDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    #[serde(rename = "_id")]
    pub id: Id,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
    pub revision: u32,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadSession {
    #[serde(rename = "_id")]
    pub id: Id,
    pub user_id: Id,
    pub name: String,
    pub size: u64,
    pub offset: u64,
    pub gridfs_id: bson::Bson,
    pub head: Binary,
    #[serde(default)]
    pub wrapper: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub attachment_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub document_id: Option<Id>,
    pub created_at: BsonDateTime,
    pub expires_at: BsonDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    #[serde(rename = "_id")]
    pub id: Id,
    pub action: String,
    pub actor: Option<String>,
    pub target_kind: String,
    pub target_id: Option<String>,
    #[serde(default)]
    pub detail: BsonDocument,
    pub ip: Option<String>,
    pub created_at: BsonDateTime,
}

impl AuditEntry {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaMeta {
    #[serde(rename = "_id")]
    pub id: String,
    pub schema_version: i32,
    pub updated_at: BsonDateTime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub migration_lock: Option<MigrationLock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationLock {
    pub holder: String,
    pub acquired_at: BsonDateTime,
    pub expires_at: BsonDateTime,
}
