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
//! - **When**: the target has no `meta` `{_id: "schema"}` document (it has never
//!   been booted) and the legacy database has one (it holds a real workspace).
//!   Never when the two names are the same.
//! - **How**: one `$out` aggregation per collection, server side, so nothing is
//!   streamed through this process. `$out` replaces the target collection, so a
//!   copy interrupted half way is simply redone on the next boot.
//! - **Order**: `meta` last. Its schema document is the completion marker: until
//!   it lands, the next boot sees "never booted" and copies again.
//! - **Indexes**: `$out` does not carry them, and the migrations will not run
//!   again on a copied schema version, so the source's indexes are recreated
//!   (name, uniqueness, sparseness, partial filter and TTL included).
//! - **Check**: per-collection document counts must match, or boot fails rather
//!   than serving a partial copy.
//!
//! The legacy database is only ever read.

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

/// Copy `legacy` into `target` on the same server when — and only when — the
/// target has never been booted and the legacy database has. Returns `None`
/// when there was nothing to do.
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
    if has_schema_document(&destination).await? || !has_schema_document(&source).await? {
        return Ok(None);
    }

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

    let mut report = CopyReport::default();
    for name in names {
        let copied = copy_collection(&source, &destination, &name)
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
    Ok(Some(report))
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

/// `$out` one collection, recreate its indexes, verify the count.
async fn copy_collection(source: &Database, target: &Database, name: &str) -> anyhow::Result<u64> {
    let from = source.collection::<bson::Document>(name);
    let to = target.collection::<bson::Document>(name);

    let expected = from.count_documents(doc! {}).await?;

    // Server side, and replaces whatever a previous interrupted run left there.
    from.aggregate([doc! { "$out": { "db": target.name(), "coll": name } }])
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
