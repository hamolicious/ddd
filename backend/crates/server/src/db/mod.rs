//! Mongo connection, collection handles, boot-time schema work.
//!
//! Collection names live here as constants — no string literals anywhere else.

pub mod indexes;
pub mod migrations;

use std::time::Duration;

use anyhow::Context;
use bson::doc;
use mongodb::options::ClientOptions;
use mongodb::{Client, Collection, Database};

use crate::config::Config;
use crate::domain::{
    Attachment, AuditEntry, Document, DocumentChange, DocumentCheckpoint, DocumentSnapshot,
    DocumentUpdate, GraveyardEntry, Invite,
    LoginAttempt, PasswordReset, SchemaMeta, Session, User,
};

pub const DOCUMENTS: &str = "documents";
pub const DOCUMENT_UPDATES: &str = "document_updates";
pub const DOCUMENT_SNAPSHOTS: &str = "document_snapshots";
pub const DOCUMENT_CHANGES: &str = "document_changes";
pub const DOCUMENT_CHECKPOINTS: &str = "document_checkpoints";
pub const DELETED_IDS: &str = "deleted_ids";
pub const USERS: &str = "users";
pub const SESSIONS: &str = "sessions";
pub const INVITES: &str = "invites";
pub const PASSWORD_RESETS: &str = "password_resets";
pub const LOGIN_ATTEMPTS: &str = "login_attempts";
pub const ATTACHMENTS: &str = "attachments";
pub const AUDIT_LOG: &str = "audit_log";
pub const META: &str = "meta";
/// Reserved for M4 (plugin host); indexes are not created before then.
pub const PLUGINS: &str = "plugins";
pub const PLUGIN_KV: &str = "plugin_kv";
pub const PLUGIN_CONFIG: &str = "plugin_config";

/// GridFS bucket holding attachment bytes (SPEC §3.6).
pub const GRIDFS_BUCKET: &str = "attachments";

/// `_id` of the single `meta` document holding the schema version.
pub const META_SCHEMA_ID: &str = "schema";

/// How long to wait for a usable server before giving up at boot. Short enough
/// that a misconfigured `MONGO_URI` fails the deploy quickly, long enough for a
/// compose stack whose mongo is still electing itself.
const SERVER_SELECTION_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Single replica, one process: a modest pool is plenty and keeps Mongo's
/// connection accounting readable.
const MAX_POOL_SIZE: u32 = 32;
const MIN_POOL_SIZE: u32 = 1;

/// Connect to Mongo and verify the connection with a ping.
///
/// `mongodb::Client` connects lazily, so the ping is the difference between
/// "started" and "actually able to serve" — we do it here so a bad URI is a boot
/// failure rather than a stream of 500s.
pub async fn connect(config: &Config) -> anyhow::Result<(Client, Database)> {
    let mut options = ClientOptions::parse(&config.mongo_uri)
        .await
        .context("MONGO_URI is not a valid MongoDB connection string")?;

    options.app_name = Some(format!("life-manager/{}", crate::VERSION));
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

/// `admin.ping` — the cheapest round trip that proves the server answers.
/// Shared by boot and `/readyz`.
pub async fn ping(client: &Client) -> anyhow::Result<()> {
    client
        .database("admin")
        .run_command(doc! { "ping": 1 })
        .await
        .context("ping failed")?;
    Ok(())
}

/// Run migrations then ensure indexes. Called once at boot, before serving.
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

/// Typed collection handles. Cheap to construct (clones the `Database` handle).
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

    pub fn audit_log(&self) -> Collection<AuditEntry> {
        self.db.collection(AUDIT_LOG)
    }

    pub fn meta(&self) -> Collection<SchemaMeta> {
        self.db.collection(META)
    }

    /// GridFS bucket for attachment bytes.
    pub fn gridfs(&self) -> mongodb::gridfs::GridFsBucket {
        self.db.gridfs_bucket(
            mongodb::options::GridFsBucketOptions::builder()
                .bucket_name(GRIDFS_BUCKET.to_string())
                .build(),
        )
    }

    /// Untyped handle, for ad-hoc aggregations.
    pub fn raw(&self, name: &str) -> Collection<bson::Document> {
        self.db.collection(name)
    }
}
