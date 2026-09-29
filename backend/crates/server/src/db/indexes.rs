//! **All indexes declared in one list**, created idempotently at boot
//! (SPEC §3.5). Nothing anywhere else may call `create_index`.

use std::time::Duration;

use anyhow::Context;
use bson::doc;
use mongodb::options::IndexOptions;
use mongodb::{Database, IndexModel};

/// One index, tagged with the collection it belongs to.
pub struct IndexSpec {
    pub collection: &'static str,
    pub model: IndexModel,
}

/// `expireAfterSeconds: 0` — the TTL monitor deletes the document once the date
/// in the indexed field has passed, which is exactly what our `*_expires_at`
/// fields mean.
const EXPIRE_AT_FIELD: Duration = Duration::ZERO;

/// Login attempts are the input to the backoff window (SPEC §5.2) and evidence
/// for a little while after it; a day covers both without growing forever.
const LOGIN_ATTEMPT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// The complete index list. Add here, never elsewhere.
///
/// Required coverage:
/// - `documents`: `title`, `updated_at`, `deleted_at`, `fm.date`, a
///   wildcard index over the `fm` subtree (the filter DSL queries arbitrary
///   `fm.*` paths), text index over `title` + `content` (server-side search
///   provider).
/// - `document_updates`: `{document_id: 1, seq: 1}` unique (log order + trim).
/// - `document_snapshots`: `{document_id: 1, created_at: -1}`.
/// - `document_changes`: `{document_id: 1, seq: -1}` unique (history, newest first).
/// - `document_checkpoints`: `{document_id: 1, seq: -1}` unique (nearest checkpoint).
/// - `document_history`: `{document_id: 1, from_seq: 1}` unique (squash is an upsert),
///   `{document_id: 1, to_seq: -1}` (newest first).
/// - `document_changes`: also `{created_at: 1}` (the squash job's sweep).
/// - `deleted_ids`: `_id` only (the graveyard is id-keyed and permanent).
/// - `users`: unique `email`.
/// - `sessions`: `user_id`, TTL on `absolute_expires_at`.
/// - `invites`: `created_by`, TTL-free (`expires_at` is checked in code so
///   expired invites stay listable/auditable).
/// - `password_resets`: TTL on `expires_at`.
/// - `login_attempts`: `{email: 1, created_at: -1}`, `{ip: 1, created_at: -1}`,
///   TTL on `created_at` (window + a margin).
/// - `attachments`: `sha256`, `deleted_at`, `updated_at`.
/// - `attachments.files` / `attachments.chunks` (GridFS): the driver's own two,
///   declared under the driver's names so creating them is a no-op wherever the
///   driver got there first; chunked uploads write chunks before any file exists.
/// - `uploads`: `user_id`, `expires_at` (the sweep).
/// - `audit_log`: `{created_at: -1}`, `{actor: 1, created_at: -1}`,
///   `{target_id: 1}`.
///
/// Every index is named explicitly: the names are what an operator sees in
/// `db.collection.getIndexes()` and what a future migration would drop.
pub fn all() -> Vec<IndexSpec> {
    vec![
        // ---- documents -------------------------------------------------
        index(
            super::DOCUMENTS,
            "documents_title",
            doc! { "title": 1 },
            None,
        ),
        index(
            super::DOCUMENTS,
            "documents_updated_at",
            doc! { "updated_at": -1 },
            None,
        ),
        // Deliberately **not** sparse. Every document list is partitioned by
        // tombstone state, and the common case is the live one — `{deleted_at:
        // null}`, which a sparse index cannot serve (it omits the documents that
        // lack the field, i.e. exactly the ones the predicate selects). Trash
        // (`{deleted_at: {$ne: null}}`) is the rarer query. The cost is index
        // entries for live documents; the benefit is that neither partition
        // collection-scans (SPEC §3.5).
        index(
            super::DOCUMENTS,
            "documents_deleted_at",
            doc! { "deleted_at": 1 },
            None,
        ),
        index(
            super::DOCUMENTS,
            "documents_fm_date",
            doc! { "fm.date": 1 },
            None,
        ),
        // The filter DSL compiles to queries over *arbitrary* `fm.*` paths
        // (SPEC §4.2), so the named frontmatter index above cannot be the whole
        // story: a wildcard index over the `fm` subtree is what keeps
        // `filter={"field":"fm.status",…}` off a collection scan (and serves
        // `fm.machine`). `fm.date` stays a dedicated index because it also serves
        // sorts, which a wildcard index cannot.
        index(
            super::DOCUMENTS,
            "documents_fm_wildcard",
            doc! { "fm.$**": 1 },
            None,
        ),
        // The workspace change feed (PROTOCOL.md §2.2). "Everything since X" is
        // `{feed_seq: {$gt: X}}` sorted by `feed_seq` on this collection merged
        // with the same scan on `deleted_ids`; without these two indexes every
        // reconnect is a collection scan, and there is one per client per deploy.
        //
        // Sparse here, because a document row written before the feed existed (or
        // by a migration that has not reached it yet) has no `feed_seq` at all and
        // is deliberately invisible to catch-up rather than wrongly seq-0.
        index(
            super::DOCUMENTS,
            "documents_feed_seq",
            doc! { "feed_seq": 1 },
            Some(IndexOptions::builder().sparse(true).build()),
        ),
        // The server-side search provider (SPEC §6.5: a fallback for scripts and
        // integrations; the PWA searches its local index).
        index(
            super::DOCUMENTS,
            "documents_text",
            doc! { "title": "text", "content": "text" },
            Some(
                IndexOptions::builder()
                    .weights(doc! { "title": 10, "content": 1 })
                    .default_language("english".to_string())
                    .build(),
            ),
        ),
        // ---- update log & snapshots ------------------------------------
        index(
            super::DOCUMENT_UPDATES,
            "document_updates_doc_seq",
            doc! { "document_id": 1, "seq": 1 },
            Some(IndexOptions::builder().unique(true).build()),
        ),
        index(
            super::DOCUMENT_SNAPSHOTS,
            "document_snapshots_doc_created",
            doc! { "document_id": 1, "created_at": -1 },
            None,
        ),
        index(
            super::DOCUMENT_CHANGES,
            "document_changes_doc_seq",
            doc! { "document_id": 1, "seq": -1 },
            Some(IndexOptions::builder().unique(true).build()),
        ),
        index(
            super::DOCUMENT_HISTORY,
            "document_history_doc_from",
            doc! { "document_id": 1, "from_seq": 1 },
            Some(IndexOptions::builder().unique(true).build()),
        ),
        index(
            super::DOCUMENT_HISTORY,
            "document_history_doc_to",
            doc! { "document_id": 1, "to_seq": -1 },
            None,
        ),
        index(
            super::DOCUMENT_CHANGES,
            "document_changes_created",
            doc! { "created_at": 1 },
            None,
        ),
        index(
            super::DOCUMENT_CHECKPOINTS,
            "document_checkpoints_doc_seq",
            doc! { "document_id": 1, "seq": -1 },
            Some(IndexOptions::builder().unique(true).build()),
        ),
        // `deleted_ids` is otherwise keyed by `_id` alone — the graveyard is a
        // permanent set membership test and Mongo indexes `_id` for us. `feed_seq`
        // is the second half of the change feed's merged range scan: purge rows
        // are how a client learns to drop a local replica (PROTOCOL.md §2.1).
        index(
            super::DELETED_IDS,
            "deleted_ids_feed_seq",
            doc! { "feed_seq": 1 },
            Some(IndexOptions::builder().sparse(true).build()),
        ),
        // ---- users & sessions ------------------------------------------
        index(
            super::USERS,
            "users_email_unique",
            doc! { "email": 1 },
            Some(IndexOptions::builder().unique(true).build()),
        ),
        index(
            super::SESSIONS,
            "sessions_user_id",
            doc! { "user_id": 1 },
            None,
        ),
        // Rolling sessions are refreshed in place; the absolute expiry is the
        // one date that never moves, so it is the safe TTL anchor (SPEC §5.2).
        index(
            super::SESSIONS,
            "sessions_absolute_expiry_ttl",
            doc! { "absolute_expires_at": 1 },
            Some(
                IndexOptions::builder()
                    .expire_after(EXPIRE_AT_FIELD)
                    .build(),
            ),
        ),
        index(
            super::INVITES,
            "invites_created_by",
            doc! { "created_by": 1 },
            None,
        ),
        index(
            super::PASSWORD_RESETS,
            "password_resets_expiry_ttl",
            doc! { "expires_at": 1 },
            Some(
                IndexOptions::builder()
                    .expire_after(EXPIRE_AT_FIELD)
                    .build(),
            ),
        ),
        // ---- login attempts --------------------------------------------
        index(
            super::LOGIN_ATTEMPTS,
            "login_attempts_email_created",
            doc! { "email": 1, "created_at": -1 },
            None,
        ),
        index(
            super::LOGIN_ATTEMPTS,
            "login_attempts_ip_created",
            doc! { "ip": 1, "created_at": -1 },
            None,
        ),
        index(
            super::LOGIN_ATTEMPTS,
            "login_attempts_ttl",
            doc! { "created_at": 1 },
            Some(
                IndexOptions::builder()
                    .expire_after(LOGIN_ATTEMPT_TTL)
                    .build(),
            ),
        ),
        // ---- attachments -----------------------------------------------
        index(
            super::ATTACHMENTS,
            "attachments_sha256",
            doc! { "sha256": 1 },
            None,
        ),
        index(
            super::ATTACHMENTS,
            "attachments_deleted_at",
            doc! { "deleted_at": 1 },
            Some(IndexOptions::builder().sparse(true).build()),
        ),
        index(
            super::ATTACHMENTS,
            "attachments_updated_at",
            doc! { "updated_at": -1 },
            None,
        ),
        // GridFS: exactly what the driver creates on a bucket's first upload (same
        // keys, same generated names, no options), because a chunked upload's
        // chunks may be the first thing ever written to the bucket.
        index(
            super::GRIDFS_FILES,
            "filename_1_uploadDate_1",
            doc! { "filename": 1, "uploadDate": 1 },
            None,
        ),
        index(
            super::GRIDFS_CHUNKS,
            "files_id_1_n_1",
            doc! { "files_id": 1, "n": 1 },
            None,
        ),
        // ---- uploads ----------------------------------------------------
        // Not a TTL index: an expired session's chunks must go with it, which the
        // maintenance sweep does (`routes/uploads.rs`).
        index(super::UPLOADS, "uploads_user", doc! { "user_id": 1 }, None),
        index(
            super::UPLOADS,
            "uploads_expires_at",
            doc! { "expires_at": 1 },
            None,
        ),
        // ---- audit log --------------------------------------------------
        index(
            super::AUDIT_LOG,
            "audit_log_created_at",
            doc! { "created_at": -1 },
            None,
        ),
        index(
            super::AUDIT_LOG,
            "audit_log_actor_created",
            doc! { "actor": 1, "created_at": -1 },
            None,
        ),
        index(
            super::AUDIT_LOG,
            "audit_log_target",
            doc! { "target_id": 1 },
            None,
        ),
        // ---- plugins (M4) -----------------------------------------------
        // The approval record is read by id (the default `_id` index) and listed by
        // state for the admin screen and for the boot-time activation pass.
        index(super::PLUGINS, "plugins_state", doc! { "state": 1 }, None),
        // `plugin_kv`'s `_id` is `<plugin_id>:<key>`, so a point read needs no index.
        // This one serves the two range operations that exist: counting a plugin's keys
        // against the per-plugin budget, and deleting the namespace on
        // `uninstall --purge`.
        index(
            super::PLUGIN_KV,
            "plugin_kv_plugin_key",
            doc! { "plugin_id": 1, "key": 1 },
            None,
        ),
        // `plugin_config`'s `_id` **is** the plugin id (one document per plugin — an
        // admin saves a form, not a field), so it needs no index of its own. Listed
        // here as a comment rather than omitted silently, because "no index" and
        // "forgot the index" look identical in this file.
    ]
}

fn index(
    collection: &'static str,
    name: &str,
    keys: bson::Document,
    options: Option<IndexOptions>,
) -> IndexSpec {
    let mut options = options.unwrap_or_default();
    options.name = Some(name.to_string());
    IndexSpec {
        collection,
        model: IndexModel::builder().keys(keys).options(options).build(),
    }
}

/// Create every declared index idempotently. Returns how many were declared.
///
/// `createIndexes` is a no-op when an identical index already exists. A *name*
/// that exists with different keys or options is a hard error and stays one:
/// silently serving queries against an index that is not the one declared here
/// is how "it was fast yesterday" incidents start. The fix is a migration that
/// drops the old index by name.
pub async fn ensure(db: &Database) -> anyhow::Result<usize> {
    let specs = all();

    for spec in &specs {
        db.collection::<bson::Document>(spec.collection)
            .create_index(spec.model.clone())
            .await
            .with_context(|| {
                format!(
                    "creating index {} on `{}`",
                    spec.model
                        .options
                        .as_ref()
                        .and_then(|options| options.name.clone())
                        .unwrap_or_else(|| "<unnamed>".to_string()),
                    spec.collection
                )
            })?;
    }

    Ok(specs.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_index_is_named() {
        for spec in all() {
            let name = spec
                .model
                .options
                .as_ref()
                .and_then(|options| options.name.as_deref());
            assert!(name.is_some(), "unnamed index on `{}`", spec.collection);
        }
    }

    #[test]
    fn index_names_are_unique_per_collection() {
        let mut seen = HashSet::new();
        for spec in all() {
            let name = spec
                .model
                .options
                .as_ref()
                .and_then(|options| options.name.clone())
                .expect("named");
            assert!(
                seen.insert((spec.collection, name.clone())),
                "duplicate index {name} on `{}`",
                spec.collection
            );
        }
    }

    #[test]
    fn documents_has_a_text_index() {
        let has_text = all().iter().any(|spec| {
            spec.collection == super::super::DOCUMENTS
                && spec
                    .model
                    .keys
                    .values()
                    .any(|value| value.as_str() == Some("text"))
        });
        assert!(
            has_text,
            "the server-side search provider needs a text index"
        );
    }
}
