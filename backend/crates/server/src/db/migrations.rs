//! Ordered, idempotent migrations run at boot under an advisory lock
//! (SPEC §3.5). The server refuses to start if the DB is newer than the binary.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use bson::{DateTime as BsonDateTime, doc};
use mongodb::Database;
use thiserror::Error;

use crate::domain::{MigrationLock, SchemaMeta};

/// Schema version this binary understands. Bump when adding a migration.
pub const SCHEMA_VERSION: i32 = 2;

/// How long a migration may hold the advisory lock before another process may
/// steal it (a crashed migrator must not wedge the deployment forever).
pub const LOCK_TTL_SECS: i64 = 300;

/// How long a booting process waits for someone else's migration to finish
/// before giving up. Deliberately shorter than a Kubernetes liveness budget:
/// failing fast and restarting is better than a half-started server.
const LOCK_WAIT_ATTEMPTS: u32 = 20;
const LOCK_WAIT_INTERVAL: Duration = Duration::from_secs(3);

type MigrationFuture<'a> = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

/// One migration step. `run` must be idempotent.
pub struct Migration {
    pub version: i32,
    pub name: &'static str,
    pub run: fn(&Database) -> MigrationFuture<'_>,
}

#[derive(Debug, Error)]
pub enum MigrationError {
    #[error("database schema version {found} is newer than this binary ({supported})")]
    DatabaseTooNew { found: i32, supported: i32 },
    #[error("could not acquire the migration lock (held by {holder})")]
    LockHeld { holder: String },
    #[error("migration {version} ({name}) failed: {source}")]
    Failed {
        version: i32,
        name: &'static str,
        #[source]
        source: anyhow::Error,
    },
}

/// What `run` did, for the boot log and `/readyz`.
#[derive(Debug, Clone, Default)]
pub struct MigrationReport {
    pub from_version: i32,
    pub to_version: i32,
    pub applied: Vec<&'static str>,
}

/// The ordered migration list. **Append only** — never edit or reorder an
/// existing entry.
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            name: "initial_collections",
            run: |db| Box::pin(m001_initial_collections(db)),
        },
        Migration {
            version: 2,
            name: "backfill_feed_seq",
            run: |db| Box::pin(m002_backfill_feed_seq(db)),
        },
    ]
}

/// Read the stored schema version (0 when the DB is empty).
pub async fn current_version(db: &Database) -> anyhow::Result<i32> {
    let meta = db
        .collection::<SchemaMeta>(super::META)
        .find_one(doc! { "_id": super::META_SCHEMA_ID })
        .await
        .context("reading meta.schema_version")?;
    Ok(meta.map_or(0, |meta| meta.schema_version))
}

/// Apply every pending migration in order, under the advisory lock.
pub async fn run(db: &Database) -> anyhow::Result<MigrationReport> {
    ensure_meta_document(db).await?;

    let from_version = current_version(db).await?;
    refuse_if_newer(from_version)?;

    if from_version >= SCHEMA_VERSION {
        return Ok(MigrationReport {
            from_version,
            to_version: from_version,
            applied: Vec::new(),
        });
    }

    // The closure reports back through a shared cell: `with_advisory_lock`'s
    // signature is a frozen contract that only carries `Result<()>`.
    let applied: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let applied_out = Arc::clone(&applied);

    with_advisory_lock(db, &holder_id(), move |db| {
        let applied = Arc::clone(&applied);
        Box::pin(async move {
            // Re-read inside the lock: another process may have migrated while
            // we were waiting for it.
            let mut version = current_version(db).await?;
            refuse_if_newer(version)?;

            for migration in migrations() {
                if migration.version <= version {
                    continue;
                }
                tracing::info!(
                    version = migration.version,
                    name = migration.name,
                    "applying migration"
                );
                (migration.run)(db)
                    .await
                    .map_err(|source| MigrationError::Failed {
                        version: migration.version,
                        name: migration.name,
                        source,
                    })?;
                set_version(db, migration.version).await?;
                version = migration.version;
                applied
                    .lock()
                    .expect("migration report lock")
                    .push(migration.name);
            }
            Ok(())
        })
    })
    .await?;

    let to_version = current_version(db).await?;
    let applied = applied_out.lock().expect("migration report lock").clone();

    Ok(MigrationReport {
        from_version,
        to_version,
        applied,
    })
}

/// Acquire the advisory lock, run `body`, release it even on error.
pub async fn with_advisory_lock<F>(db: &Database, holder: &str, body: F) -> anyhow::Result<()>
where
    F: for<'a> FnOnce(&'a Database) -> MigrationFuture<'a> + Send,
{
    acquire_lock(db, holder).await?;

    let result = body(db).await;

    // Release unconditionally: a held lock outlives the process that took it,
    // and the TTL is a backstop, not the plan.
    if let Err(err) = release_lock(db, holder).await {
        tracing::error!(error = %err, "releasing the migration lock failed; it will expire via its TTL");
    }

    result
}

fn refuse_if_newer(found: i32) -> anyhow::Result<()> {
    if found > SCHEMA_VERSION {
        return Err(MigrationError::DatabaseTooNew {
            found,
            supported: SCHEMA_VERSION,
        }
        .into());
    }
    Ok(())
}

/// Identifies the lock holder in logs and in the stored lock. Not a security
/// boundary — just enough to tell two processes apart.
fn holder_id() -> String {
    let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown-host".to_string());
    format!("{host}:{}", std::process::id())
}

/// Create `meta.schema` if it is missing, without touching an existing version.
async fn ensure_meta_document(db: &Database) -> anyhow::Result<()> {
    db.collection::<bson::Document>(super::META)
        .update_one(
            doc! { "_id": super::META_SCHEMA_ID },
            doc! { "$setOnInsert": {
                "schema_version": 0i32,
                "updated_at": BsonDateTime::now(),
            }},
        )
        .upsert(true)
        .await
        .context("creating the meta.schema document")?;
    Ok(())
}

async fn set_version(db: &Database, version: i32) -> anyhow::Result<()> {
    db.collection::<bson::Document>(super::META)
        .update_one(
            doc! { "_id": super::META_SCHEMA_ID },
            doc! { "$set": { "schema_version": version, "updated_at": BsonDateTime::now() } },
        )
        .await
        .context("writing meta.schema_version")?;
    Ok(())
}

async fn acquire_lock(db: &Database, holder: &str) -> anyhow::Result<()> {
    let meta = db.collection::<bson::Document>(super::META);

    for attempt in 1..=LOCK_WAIT_ATTEMPTS {
        let now = BsonDateTime::now();
        let expires_at = BsonDateTime::from_millis(now.timestamp_millis() + LOCK_TTL_SECS * 1_000);

        let result = meta
            .update_one(
                doc! {
                    "_id": super::META_SCHEMA_ID,
                    // Free, never taken, or abandoned past its TTL.
                    "$or": [
                        { "migration_lock": { "$exists": false } },
                        { "migration_lock": bson::Bson::Null },
                        { "migration_lock.expires_at": { "$lte": now } },
                    ],
                },
                doc! { "$set": { "migration_lock": bson::to_bson(&MigrationLock {
                    holder: holder.to_string(),
                    acquired_at: now,
                    expires_at,
                })? }},
            )
            .await
            .context("acquiring the migration lock")?;

        if result.modified_count == 1 {
            tracing::debug!(holder, attempt, "migration lock acquired");
            return Ok(());
        }

        let current = current_holder(db).await.unwrap_or_default();
        if attempt == LOCK_WAIT_ATTEMPTS {
            return Err(MigrationError::LockHeld {
                holder: current.unwrap_or_else(|| "unknown".to_string()),
            }
            .into());
        }
        tracing::info!(
            attempt,
            held_by = current.as_deref().unwrap_or("unknown"),
            "waiting for the migration lock"
        );
        tokio::time::sleep(LOCK_WAIT_INTERVAL).await;
    }

    unreachable!("the loop returns on its last attempt")
}

async fn current_holder(db: &Database) -> anyhow::Result<Option<String>> {
    let meta = db
        .collection::<SchemaMeta>(super::META)
        .find_one(doc! { "_id": super::META_SCHEMA_ID })
        .await?;
    Ok(meta
        .and_then(|meta| meta.migration_lock)
        .map(|lock| lock.holder))
}

async fn release_lock(db: &Database, holder: &str) -> anyhow::Result<()> {
    db.collection::<bson::Document>(super::META)
        .update_one(
            doc! { "_id": super::META_SCHEMA_ID, "migration_lock.holder": holder },
            doc! { "$unset": { "migration_lock": "" } },
        )
        .await
        .context("releasing the migration lock")?;
    Ok(())
}

/// v1: create the collections and their validators. Indexes are handled
/// separately by [`super::indexes`], which runs after migrations.
///
/// No JSON-schema validators are installed: the shapes in `domain.rs` are the
/// contract, they change with the binary, and a stale server-side validator
/// would reject writes from a *newer* binary mid-deploy. Creating the
/// collections up front still buys something real — `/readyz`, the admin export
/// and the orphan scan all read collections that may never have been written.
async fn m001_initial_collections(db: &Database) -> anyhow::Result<()> {
    // The M4 plugin collections are deliberately absent: they arrive with the
    // plugin host (SPEC §9 M4).
    const COLLECTIONS: &[&str] = &[
        super::DOCUMENTS,
        super::DOCUMENT_UPDATES,
        super::DOCUMENT_SNAPSHOTS,
        super::DELETED_IDS,
        super::USERS,
        super::SESSIONS,
        super::INVITES,
        super::PASSWORD_RESETS,
        super::LOGIN_ATTEMPTS,
        super::ATTACHMENTS,
        super::AUDIT_LOG,
        super::META,
    ];

    let existing = db
        .list_collection_names()
        .await
        .context("listing collections")?;

    for name in COLLECTIONS {
        if existing.iter().any(|existing| existing == name) {
            continue;
        }
        match db.create_collection(*name).await {
            Ok(()) => tracing::debug!(collection = name, "collection created"),
            // Another process created it between the list and the create.
            Err(err) if is_namespace_exists(&err) => {}
            Err(err) => {
                return Err(
                    anyhow::Error::new(err).context(format!("creating the `{name}` collection"))
                );
            }
        }
    }

    Ok(())
}

/// Give every pre-feed row a `feed_seq` (SPEC §4.1, PROTOCOL.md §2.2).
///
/// M1 stored documents with no sequence number at all, and `FeedRow::from_row`
/// returns `None` for such a row — so an un-backfilled M1 workspace is not
/// *wrong* on the feed, it is **invisible**: a client would bootstrap fine and
/// then never see a single change. The numbers are handed out in the order the
/// rows were last touched (`updated_at`, then `deleted_at` for graveyard rows),
/// so the backfilled feed reads like the history it stands in for.
///
/// Idempotent by construction: only rows *missing* `feed_seq` are considered, and
/// the counter starts above whatever the highest existing number is, so a
/// half-finished run resumes without ever reusing a number.
async fn m002_backfill_feed_seq(db: &Database) -> anyhow::Result<()> {
    use futures::TryStreamExt;

    // Start above the high-water mark of both collections: a crashed earlier run
    // may already have numbered part of the workspace.
    let mut next = highest_feed_seq(db, super::DOCUMENTS)
        .await?
        .max(highest_feed_seq(db, super::DELETED_IDS).await?)
        + 1;

    for (collection, order_by) in [
        (super::DOCUMENTS, "updated_at"),
        (super::DELETED_IDS, "deleted_at"),
    ] {
        let handle = db.collection::<bson::Document>(collection);
        let mut cursor = handle
            .find(doc! { "feed_seq": { "$exists": false } })
            .projection(doc! { "_id": 1 })
            .sort(doc! { order_by: 1, "_id": 1 })
            .await
            .with_context(|| format!("scanning `{collection}` for rows without a feed_seq"))?;

        let mut ids = Vec::new();
        while let Some(row) = cursor
            .try_next()
            .await
            .with_context(|| format!("reading `{collection}`"))?
        {
            if let Ok(id) = row.get_str("_id") {
                ids.push(id.to_string());
            }
        }

        let count = ids.len();
        for id in ids {
            // `$exists: false` in the filter as well as the scan: concurrent
            // writers cannot appear under the advisory lock, but a resumed run
            // must not renumber what a previous attempt already numbered.
            handle
                .update_one(
                    doc! { "_id": &id, "feed_seq": { "$exists": false } },
                    doc! { "$set": { "feed_seq": next } },
                )
                .await
                .with_context(|| format!("backfilling feed_seq on `{collection}` row {id}"))?;
            next += 1;
        }
        if count > 0 {
            tracing::info!(collection, rows = count, "backfilled feed_seq");
        }
    }

    Ok(())
}

/// The largest `feed_seq` in one collection, or 0 when there is none.
async fn highest_feed_seq(db: &Database, collection: &str) -> anyhow::Result<i64> {
    let row = db
        .collection::<bson::Document>(collection)
        .find_one(doc! { "feed_seq": { "$exists": true } })
        .sort(doc! { "feed_seq": -1 })
        .projection(doc! { "feed_seq": 1 })
        .await
        .with_context(|| format!("reading the highest feed_seq in `{collection}`"))?;
    Ok(row
        .and_then(|row| row.get_i64("feed_seq").ok())
        .unwrap_or(0))
}

/// Mongo error code 48 — `NamespaceExists`.
fn is_namespace_exists(err: &mongodb::error::Error) -> bool {
    matches!(
        *err.kind,
        mongodb::error::ErrorKind::Command(ref command) if command.code == 48
    )
}
