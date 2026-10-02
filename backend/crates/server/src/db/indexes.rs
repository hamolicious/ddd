use std::time::Duration;

use anyhow::Context;
use bson::doc;
use mongodb::options::IndexOptions;
use mongodb::{Database, IndexModel};

pub struct IndexSpec {
    pub collection: &'static str,
    pub model: IndexModel,
}

const EXPIRE_AT_FIELD: Duration = Duration::ZERO;

const LOGIN_ATTEMPT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub fn all() -> Vec<IndexSpec> {
    vec![
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
        index(
            super::DOCUMENTS,
            "documents_fm_wildcard",
            doc! { "fm.$**": 1 },
            None,
        ),
        index(
            super::DOCUMENTS,
            "documents_feed_seq",
            doc! { "feed_seq": 1 },
            Some(IndexOptions::builder().sparse(true).build()),
        ),
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
        index(
            super::DELETED_IDS,
            "deleted_ids_feed_seq",
            doc! { "feed_seq": 1 },
            Some(IndexOptions::builder().sparse(true).build()),
        ),
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
        index(super::UPLOADS, "uploads_user", doc! { "user_id": 1 }, None),
        index(
            super::UPLOADS,
            "uploads_expires_at",
            doc! { "expires_at": 1 },
            None,
        ),
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
        index(super::PLUGINS, "plugins_state", doc! { "state": 1 }, None),
        index(
            super::PLUGIN_KV,
            "plugin_kv_plugin_key",
            doc! { "plugin_id": 1, "key": 1 },
            None,
        ),
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
