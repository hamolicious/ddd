//! RENAME-HOP: remove in the cleanup release.
//!
//! One-off copy of the pre-rename database into the configured one, run at boot
//! before the migrations (dev-docs/resolved/OPERATIONS.md, "Rename hop").
//!
//! The project was renamed and its default database with it. A deployment that
//! moves to the new database name starts against an empty database while all
//! of its data still sits in the old one on the same server. This copies it
//! over, once:
//!
//! - **Which database**: at boot, only the default one (`ddd`, the new name of the
//!   old default `life_manager`). A deployment on a custom `MONGO_DATABASE`, and
//!   every throwaway test or e2e database, is never filled with someone's old
//!   workspace just because it happens to share a server with one.
//! - **When**: the legacy database has a `meta` `{_id: "schema"}` document (it
//!   holds a real workspace) and the target has **no users and no documents**.
//!   A target that was booted empty (the migrations already wrote its `meta`)
//!   still qualifies; one that anybody has signed up to or written to never
//!   does. Never when the two names are the same. When the copy is skipped
//!   although the legacy database holds users or documents, a loud warning says
//!   why and how to recover.
//! - **Who**: under the migration advisory lock on the target, re-checked once
//!   taken, so two replicas booting together cannot both copy.
//! - **How**: one `$out` aggregation per collection, server side, so nothing is
//!   streamed through this process. Each target collection is dropped first
//!   (it is empty, or a leftover of an interrupted copy), so `$out` lands in a
//!   clean collection with the source's indexes and nothing else.
//! - **Resuming**: before the first collection the target's schema document is
//!   marked `rename_hop_copy.state = "copying"`; a boot that finds that marker
//!   redoes the copy from scratch even though the target now has rows.
//! - **Order**: `meta` last, with `rename_hop_copy.state = "done"` written into
//!   its schema document by the same `$out`, so the copy completes atomically
//!   with the schema version it carries. A target marked `done` is never copied
//!   into again.
//! - **Indexes**: `$out` does not carry them, and the migrations will not run
//!   again on a copied schema version, so the source's indexes are recreated
//!   (name, uniqueness, sparseness, partial filter and TTL included).
//! - **Check**: per-collection document counts must match, or boot fails rather
//!   than serving a partial copy.
//!
//! The legacy database is only ever read.

use std::sync::{Arc, Mutex};

use anyhow::{Context, bail};
use bson::doc;
use futures::TryStreamExt;
use mongodb::results::CollectionType;
use mongodb::{Client, Database, IndexModel};

// RENAME-HOP: remove in the cleanup release.
/// The pre-rename database name.
pub const LEGACY_DATABASE: &str = "life_manager";

/// The boot hook: copy [`LEGACY_DATABASE`] into `target` when `target` is the
/// default database (see the module docs for why only that one).
pub async fn copy_at_boot(client: &Client, target: &str) -> anyhow::Result<Option<CopyReport>> {
    if target != crate::config::DEFAULT_DATABASE {
        return Ok(None);
    }
    copy_legacy_database(client, LEGACY_DATABASE, target).await
}

/// What a copy did, for the boot log and the tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CopyReport {
    /// `(collection, documents copied)`, in copy order (`meta` last).
    pub collections: Vec<(String, u64)>,
}

impl CopyReport {
    pub fn documents(&self) -> u64 {
        self.collections.iter().map(|(_, count)| count).sum()
    }
}

/// The field of the target's `meta` schema document that tracks the copy.
pub const COPY_MARKER: &str = "rename_hop_copy";
const COPYING: &str = "copying";
const DONE: &str = "done";

/// What to do with a target, given what it and the legacy database hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    /// Copy: the target is empty, or a previous copy was interrupted.
    Copy,
    /// A previous boot finished the copy.
    AlreadyCopied,
    /// The target is a workspace in use; never overwrite it.
    TargetInUse,
}

fn decide(marker: Option<&str>, target_has_data: bool) -> Decision {
    match marker {
        Some(COPYING) => Decision::Copy,
        Some(DONE) => Decision::AlreadyCopied,
        _ if !target_has_data => Decision::Copy,
        _ => Decision::TargetInUse,
    }
}

/// Read the target's state and decide; logs the skip reasons.
async fn evaluate(source: &Database, destination: &Database) -> anyhow::Result<Decision> {
    let decision = decide(
        copy_marker(destination).await?.as_deref(),
        has_data(destination).await?,
    );
    match decision {
        Decision::Copy => {}
        Decision::AlreadyCopied => tracing::debug!(
            target = destination.name(),
            "RENAME-HOP: the pre-rename database was already copied"
        ),
        Decision::TargetInUse if has_data(source).await? => tracing::warn!(
            legacy = source.name(),
            target = destination.name(),
            "RENAME-HOP: NOT copying the pre-rename database. `{target}` already has users or \
             documents, and the copy never overwrites a workspace in use — but `{legacy}` holds \
             a workspace too, and this server does not serve it. If `{target}` is the one to \
             keep, ignore this and drop `{legacy}` once you are sure. If `{legacy}` is the real \
             workspace: stop every server, back up `{target}` (mongodump --db {target}), drop \
             it, and start one server — the copy then runs at boot.",
            legacy = source.name(),
            target = destination.name(),
        ),
        Decision::TargetInUse => {}
    }
    Ok(decision)
}

/// Copy `legacy` into `target` on the same server when — and only when — the
/// legacy database has been booted and the target holds no users and no
/// documents (or a previous copy into it was interrupted). Returns `None` when
/// there was nothing to do.
pub async fn copy_legacy_database(
    client: &Client,
    legacy: &str,
    target: &str,
) -> anyhow::Result<Option<CopyReport>> {
    if legacy == target {
        return Ok(None);
    }
    let source = client.database(legacy);
    let destination = client.database(target);
    if !has_schema_document(&source).await? {
        return Ok(None);
    }
    // Cheap check first: a deployment past the hop never takes the lock here.
    if evaluate(&source, &destination).await? != Decision::Copy {
        return Ok(None);
    }

    // The advisory lock lives on the target's schema document, so it must exist.
    // On a fresh target that is what the migrations would create anyway.
    super::migrations::ensure_meta_document(&destination).await?;

    let report: Arc<Mutex<Option<CopyReport>>> = Arc::new(Mutex::new(None));
    let report_out = Arc::clone(&report);
    super::migrations::with_advisory_lock(&destination, &super::migrations::holder_id(), {
        let source = source.clone();
        move |destination| {
            Box::pin(async move {
                // Re-check under the lock: another replica may have copied while
                // this one waited.
                if evaluate(&source, destination).await? != Decision::Copy {
                    return Ok(());
                }
                let copied = copy_all(&source, destination).await?;
                *report.lock().expect("rename hop report") = Some(copied);
                Ok(())
            })
        }
    })
    .await?;
    let report = report_out.lock().expect("rename hop report").take();
    Ok(report)
}

/// The copy itself, under the lock.
async fn copy_all(source: &Database, destination: &Database) -> anyhow::Result<CopyReport> {
    let (legacy, target) = (source.name(), destination.name());
    let mut names: Vec<String> = source
        .list_collections()
        .await
        .with_context(|| format!("listing the collections of `{legacy}`"))?
        .try_collect::<Vec<_>>()
        .await
        .with_context(|| format!("listing the collections of `{legacy}`"))?
        .into_iter()
        // Views are definitions, not data, and `system.*` belongs to the server.
        .filter(|spec| matches!(spec.collection_type, CollectionType::Collection))
        .map(|spec| spec.name)
        .filter(|name| !name.starts_with("system."))
        .collect();
    names.sort();
    // The completion marker goes last.
    names.retain(|name| name != super::META);
    names.push(super::META.to_string());

    tracing::warn!(
        legacy,
        target,
        collections = names.len(),
        "RENAME-HOP: copying the pre-rename database (the legacy database is left untouched)"
    );

    // From here until `meta` lands, a restart redoes the copy.
    destination
        .collection::<bson::Document>(super::META)
        .update_one(
            doc! { "_id": super::META_SCHEMA_ID },
            doc! { "$set": { COPY_MARKER: {
                "state": COPYING,
                "from": legacy,
                "at": bson::DateTime::now(),
            } } },
        )
        .await
        .with_context(|| format!("marking `{target}` as being copied into"))?;

    let mut report = CopyReport::default();
    for name in names {
        let copied = copy_collection(source, destination, &name)
            .await
            .with_context(|| format!("copying `{legacy}.{name}` to `{target}.{name}`"))?;
        tracing::info!(collection = %name, documents = copied, "RENAME-HOP: collection copied");
        report.collections.push((name, copied));
    }

    tracing::warn!(
        legacy,
        target,
        collections = report.collections.len(),
        documents = report.documents(),
        "RENAME-HOP: pre-rename database copied"
    );
    Ok(report)
}

/// `true` when `db` has the `meta` schema document — i.e. a server has booted
/// against it.
async fn has_schema_document(db: &Database) -> anyhow::Result<bool> {
    let found = db
        .collection::<bson::Document>(super::META)
        .find_one(doc! { "_id": super::META_SCHEMA_ID })
        .await
        .with_context(|| format!("reading `{}.meta`", db.name()))?;
    Ok(found.is_some())
}

/// `rename_hop_copy.state` of `db`'s schema document, if any.
async fn copy_marker(db: &Database) -> anyhow::Result<Option<String>> {
    let found = db
        .collection::<bson::Document>(super::META)
        .find_one(doc! { "_id": super::META_SCHEMA_ID })
        .await
        .with_context(|| format!("reading `{}.meta`", db.name()))?;
    Ok(found
        .as_ref()
        .and_then(|meta| meta.get_document(COPY_MARKER).ok())
        .and_then(|marker| marker.get_str("state").ok())
        .map(str::to_string))
}

/// `true` when `db` has at least one user or one document — a workspace in use.
async fn has_data(db: &Database) -> anyhow::Result<bool> {
    for name in [super::USERS, super::DOCUMENTS] {
        let found = db
            .collection::<bson::Document>(name)
            .find_one(doc! {})
            .projection(doc! { "_id": 1 })
            .await
            .with_context(|| format!("reading `{}.{name}`", db.name()))?;
        if found.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `$out` one collection, recreate its indexes, verify the count.
async fn copy_collection(source: &Database, target: &Database, name: &str) -> anyhow::Result<u64> {
    let from = source.collection::<bson::Document>(name);
    let to = target.collection::<bson::Document>(name);

    let expected = from.count_documents(doc! {}).await?;

    let mut pipeline = Vec::new();
    if name == super::META {
        // The completion marker rides in with the schema version, atomically; the
        // source's advisory lock (if a crashed server left one) stays behind.
        pipeline.push(doc! { "$set": {
            "migration_lock": "$$REMOVE",
            COPY_MARKER: { "$cond": {
                "if": { "$eq": ["$_id", super::META_SCHEMA_ID] },
                "then": { "$literal": {
                    "state": DONE,
                    "from": source.name(),
                    "at": bson::DateTime::now(),
                } },
                "else": "$$REMOVE",
            } },
        } });
    } else {
        // Empty, or a leftover of an interrupted copy: start clean, so no index the
        // target already had can clash with the source's. Never `meta`: the
        // advisory lock this copy runs under lives there.
        to.drop().await?;
    }
    pipeline.push(doc! { "$out": { "db": target.name(), "coll": name } });

    // Server side, and replaces whatever a previous interrupted run left there.
    from.aggregate(pipeline)
        .await?
        .try_collect::<Vec<_>>()
        .await?;

    let indexes: Vec<IndexModel> = from
        .list_indexes()
        .await?
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .filter(|model| {
            model
                .options
                .as_ref()
                .and_then(|options| options.name.as_deref())
                != Some("_id_")
        })
        .collect();
    if !indexes.is_empty() {
        to.create_indexes(indexes).await?;
    }

    let copied = to.count_documents(doc! {}).await?;
    if copied != expected {
        bail!(
            "document count mismatch: {expected} in the source, {copied} copied — is a \
             server still writing to the legacy database? Stop it and restart this one \
             (the copy is redone from scratch)"
        );
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_empty_or_half_copied_target_is_copied_into() {
        // Never booted, or booted empty (the migrations wrote `meta`, nothing else).
        assert_eq!(decide(None, false), Decision::Copy);
        // An interrupted copy left rows behind: redo it.
        assert_eq!(decide(Some(COPYING), true), Decision::Copy);
        assert_eq!(decide(Some(DONE), true), Decision::AlreadyCopied);
        assert_eq!(decide(Some(DONE), false), Decision::AlreadyCopied);
        // Somebody signed up or wrote: never touched.
        assert_eq!(decide(None, true), Decision::TargetInUse);
    }
}
