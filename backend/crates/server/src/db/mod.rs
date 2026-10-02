pub mod indexes;
pub mod migrations;

use std::time::Duration;

use anyhow::Context;
use bson::doc;
use mongodb::options::ClientOptions;
use mongodb::{Client, Collection, Database};

use crate::config::Config;
use crate::domain::{
    Attachment, AuditEntry, Document, DocumentChange, DocumentCheckpoint, DocumentHistory,
    DocumentSnapshot, DocumentUpdate, GraveyardEntry, Invite, LoginAttempt, PasswordReset,
    SchemaMeta, Session, UploadSession, User,
};

pub const DOCUMENTS: &str = "documents";
pub const DOCUMENT_UPDATES: &str = "document_updates";
pub const DOCUMENT_SNAPSHOTS: &str = "document_snapshots";
pub const DOCUMENT_CHANGES: &str = "document_changes";
pub const DOCUMENT_CHECKPOINTS: &str = "document_checkpoints";
pub const DOCUMENT_HISTORY: &str = "document_history";
pub const DELETED_IDS: &str = "deleted_ids";
pub const USERS: &str = "users";
pub const SESSIONS: &str = "sessions";
pub const INVITES: &str = "invites";
pub const PASSWORD_RESETS: &str = "password_resets";
pub const LOGIN_ATTEMPTS: &str = "login_attempts";
pub const ATTACHMENTS: &str = "attachments";
pub const UPLOADS: &str = "uploads";
pub const AUDIT_LOG: &str = "audit_log";
pub const META: &str = "meta";
pub const PLUGINS: &str = "plugins";
pub const PLUGIN_KV: &str = "plugin_kv";
pub const PLUGIN_CONFIG: &str = "plugin_config";

pub const GRIDFS_BUCKET: &str = "attachments";
pub const GRIDFS_FILES: &str = "attachments.files";
pub const GRIDFS_CHUNKS: &str = "attachments.chunks";
pub const GRIDFS_CHUNK_BYTES: u32 = 255 * 1024;

pub const META_SCHEMA_ID: &str = "schema";

const SERVER_SELECTION_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_POOL_SIZE: u32 = 32;
const MIN_POOL_SIZE: u32 = 1;

pub async fn connect(config: &Config) -> anyhow::Result<(Client, Database)> {
    let mut options = ClientOptions::parse(&config.mongo_uri)
        .await
        .context("MONGO_URI is not a valid MongoDB connection string")?;

    options.app_name = Some(format!("ddd/{}", crate::VERSION));
    options.server_selection_timeout = Some(SERVER_SELECTION_TIMEOUT);
    options.connect_timeout = Some(CONNECT_TIMEOUT);
    options.max_pool_size = Some(MAX_POOL_SIZE);
    options.min_pool_size = Some(MIN_POOL_SIZE);
    options.retry_writes = Some(true);

    let client = Client::with_options(options).context("building the MongoDB client")?;

    ping(&client)
        .await
        .context("MongoDB is not reachable (check MONGO_URI and that mongo is running)")?;

    let db = client.database(&config.mongo_database);
    tracing::info!(database = %config.mongo_database, "connected to MongoDB");
    Ok((client, db))
}

pub async fn ping(client: &Client) -> anyhow::Result<()> {
    client
        .database("admin")
        .run_command(doc! { "ping": 1 })
        .await
        .context("ping failed")?;
    Ok(())
}

pub async fn init_schema(db: &Database) -> anyhow::Result<()> {
    let report = migrations::run(db).await?;
    if report.applied.is_empty() {
        tracing::info!(schema_version = report.to_version, "schema up to date");
    } else {
        tracing::info!(
            from_version = report.from_version,
            to_version = report.to_version,
            applied = ?report.applied,
            "migrations applied"
        );
    }

    let count = indexes::ensure(db).await?;
    tracing::info!(indexes = count, "indexes ensured");
    Ok(())
}

#[derive(Clone)]
pub struct Collections {
    db: Database,
}

impl Collections {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    pub fn database(&self) -> &Database {
        &self.db
    }

    pub fn documents(&self) -> Collection<Document> {
        self.db.collection(DOCUMENTS)
    }

    pub fn document_updates(&self) -> Collection<DocumentUpdate> {
        self.db.collection(DOCUMENT_UPDATES)
    }

    pub fn document_snapshots(&self) -> Collection<DocumentSnapshot> {
        self.db.collection(DOCUMENT_SNAPSHOTS)
    }

    pub fn document_changes(&self) -> Collection<DocumentChange> {
        self.db.collection(DOCUMENT_CHANGES)
    }

    pub fn document_checkpoints(&self) -> Collection<DocumentCheckpoint> {
        self.db.collection(DOCUMENT_CHECKPOINTS)
    }

    pub fn document_history(&self) -> Collection<DocumentHistory> {
        self.db.collection(DOCUMENT_HISTORY)
    }

    pub fn deleted_ids(&self) -> Collection<GraveyardEntry> {
        self.db.collection(DELETED_IDS)
    }

    pub fn users(&self) -> Collection<User> {
        self.db.collection(USERS)
    }

    pub fn sessions(&self) -> Collection<Session> {
        self.db.collection(SESSIONS)
    }

    pub fn invites(&self) -> Collection<Invite> {
        self.db.collection(INVITES)
    }

    pub fn password_resets(&self) -> Collection<PasswordReset> {
        self.db.collection(PASSWORD_RESETS)
    }

    pub fn login_attempts(&self) -> Collection<LoginAttempt> {
        self.db.collection(LOGIN_ATTEMPTS)
    }

    pub fn attachments(&self) -> Collection<Attachment> {
        self.db.collection(ATTACHMENTS)
    }

    pub fn uploads(&self) -> Collection<UploadSession> {
        self.db.collection(UPLOADS)
    }

    pub fn audit_log(&self) -> Collection<AuditEntry> {
        self.db.collection(AUDIT_LOG)
    }

    pub fn meta(&self) -> Collection<SchemaMeta> {
        self.db.collection(META)
    }

    pub fn gridfs(&self) -> mongodb::gridfs::GridFsBucket {
        self.db.gridfs_bucket(
            mongodb::options::GridFsBucketOptions::builder()
                .bucket_name(GRIDFS_BUCKET.to_string())
                .chunk_size_bytes(GRIDFS_CHUNK_BYTES)
                .build(),
        )
    }

    pub fn raw(&self, name: &str) -> Collection<bson::Document> {
        self.db.collection(name)
    }
}
