//! RENAME-HOP: remove in the cleanup release.
//!
//! The boot-time copy of the pre-rename database (`db::rename_hop`), against a
//! real server. Uses throwaway database names on both sides — never the real
//! legacy or target database — and drops them at the end.
//!
//! `#[ignore]`d like every Mongo-backed suite; skips silently with no `MONGO_URI`:
//!
//! ```text
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p ddd-server --test rename_hop -- --ignored
//! ```

mod common;

use std::time::Duration;

use bson::doc;
use ddd_server::db::rename_hop::{copy_at_boot, copy_legacy_database};
use ddd_server::domain::new_id;
use futures::TryStreamExt;
use mongodb::IndexModel;
use mongodb::options::IndexOptions;

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn the_legacy_database_is_copied_once_with_its_indexes() {
    let Some(uri) = common::mongo_uri() else {
        return;
    };
    let client = mongodb::Client::with_uri_str(&uri).await.expect("mongo");
    let suffix = new_id();
    let legacy_name = format!("ddd_renamehop_test_legacy_{suffix}");
    let target_name = format!("ddd_renamehop_test_target_{suffix}");
    let legacy = client.database(&legacy_name);
    let target = client.database(&target_name);

    // Not booted on either side: nothing to copy.
    assert_eq!(
        copy_legacy_database(&client, &legacy_name, &target_name)
            .await
            .expect("no-op"),
        None
    );

    // A legacy workspace: documents, GridFS, a TTL, a unique+partial and a sparse
    // index, and the schema marker.
    let documents = legacy.collection::<bson::Document>("documents");
    documents
        .insert_many((0..50).map(|i| doc! { "_id": format!("d{i}"), "title": format!("t{i}") }))
        .await
        .expect("seed documents");
    documents
        .create_indexes([
            IndexModel::builder()
                .keys(doc! { "title": 1 })
                .options(
                    IndexOptions::builder()
                        .name("title_unique".to_string())
                        .unique(true)
                        .partial_filter_expression(doc! { "title": { "$exists": true } })
                        .build(),
                )
                .build(),
            IndexModel::builder()
                .keys(doc! { "fm.date": 1 })
                .options(IndexOptions::builder().sparse(true).build())
                .build(),
        ])
        .await
        .expect("legacy indexes");
    let sessions = legacy.collection::<bson::Document>("sessions");
    sessions
        .insert_one(doc! { "_id": "s1", "expires_at": bson::DateTime::now() })
        .await
        .expect("seed session");
    sessions
        .create_index(
            IndexModel::builder()
                .keys(doc! { "expires_at": 1 })
                .options(IndexOptions::builder().expire_after(Duration::ZERO).build())
                .build(),
        )
        .await
        .expect("ttl index");
    legacy
        .collection::<bson::Document>("attachments.files")
        .insert_one(doc! { "_id": "f1", "length": 3_i64 })
        .await
        .expect("seed gridfs files");
    legacy
        .collection::<bson::Document>("attachments.chunks")
        .insert_many([
            doc! { "files_id": "f1", "n": 0, "data": bson::Binary { subtype: bson::spec::BinarySubtype::Generic, bytes: vec![1, 2, 3] } },
        ])
        .await
        .expect("seed gridfs chunks");
    legacy
        .create_collection("empty_collection")
        .await
        .expect("an empty collection");
    legacy
        .collection::<bson::Document>("meta")
        .insert_one(doc! { "_id": "schema", "schema_version": 3 })
        .await
        .expect("schema marker");

    // A previous copy was interrupted: it marked the target and left junk in it.
    target
        .collection::<bson::Document>("meta")
        .insert_one(doc! { "_id": "schema", "schema_version": 0, "rename_hop_copy": { "state": "copying" } })
        .await
        .expect("copying marker");
    target
        .collection::<bson::Document>("documents")
        .insert_one(doc! { "_id": "stale" })
        .await
        .expect("stale row");

    let report = copy_legacy_database(&client, &legacy_name, &target_name)
        .await
        .expect("copy")
        .expect("a copy happened");
    assert_eq!(
        report.collections.last().map(|(name, _)| name.as_str()),
        Some("meta"),
        "meta is the completion marker and goes last"
    );
    assert_eq!(report.documents(), 50 + 1 + 1 + 1 + 1);
    for name in [
        "attachments.chunks",
        "attachments.files",
        "documents",
        "empty_collection",
        "sessions",
    ] {
        assert!(
            report.collections.iter().any(|(copied, _)| copied == name),
            "{name} copied"
        );
    }

    // Data replaced, not merged.
    let target_documents = target.collection::<bson::Document>("documents");
    assert_eq!(target_documents.count_documents(doc! {}).await.unwrap(), 50);
    assert!(
        target_documents
            .find_one(doc! { "_id": "stale" })
            .await
            .unwrap()
            .is_none()
    );
    let meta = target
        .collection::<bson::Document>("meta")
        .find_one(doc! { "_id": "schema" })
        .await
        .unwrap()
        .expect("the schema document is copied");
    assert_eq!(meta.get_i32("schema_version").ok(), Some(3));
    assert_eq!(
        meta.get_document("rename_hop_copy")
            .and_then(|marker| marker.get_str("state")),
        Ok("done"),
        "the copy is marked complete by the same write that carries the schema"
    );
    assert!(meta.get("migration_lock").is_none());

    // Indexes carried with their options.
    let indexes: Vec<IndexModel> = target_documents
        .list_indexes()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    let unique = indexes
        .iter()
        .find(|model| {
            model.options.as_ref().and_then(|o| o.name.as_deref()) == Some("title_unique")
        })
        .expect("the unique index is recreated");
    let options = unique.options.as_ref().unwrap();
    assert_eq!(options.unique, Some(true));
    assert!(options.partial_filter_expression.is_some());
    assert!(indexes.iter().any(|model| {
        model.keys == doc! { "fm.date": 1 }
            && model.options.as_ref().and_then(|o| o.sparse) == Some(true)
    }));
    let ttl: Vec<IndexModel> = target
        .collection::<bson::Document>("sessions")
        .list_indexes()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    assert!(ttl.iter().any(|model| {
        model.keys == doc! { "expires_at": 1 }
            && model.options.as_ref().and_then(|o| o.expire_after) == Some(Duration::ZERO)
    }));

    // The legacy side is untouched.
    assert_eq!(documents.count_documents(doc! {}).await.unwrap(), 50);

    // Once marked done, never again: a row written after the copy survives.
    target_documents
        .insert_one(doc! { "_id": "after" })
        .await
        .unwrap();
    assert_eq!(
        copy_legacy_database(&client, &legacy_name, &target_name)
            .await
            .unwrap(),
        None
    );
    assert_eq!(target_documents.count_documents(doc! {}).await.unwrap(), 51);

    // Same name on both sides: nothing to do.
    assert_eq!(
        copy_legacy_database(&client, &legacy_name, &legacy_name)
            .await
            .unwrap(),
        None
    );

    // The boot hook leaves a non-default database alone.
    let other = format!("ddd_renamehop_test_other_{suffix}");
    assert_eq!(copy_at_boot(&client, &other).await.unwrap(), None);

    legacy.drop().await.expect("drop legacy");
    target.drop().await.expect("drop target");
    client.database(&other).drop().await.ok();
}

/// A legacy workspace with a user, a document and the schema marker.
async fn seed_legacy(legacy: &mongodb::Database) {
    legacy
        .collection::<bson::Document>("users")
        .insert_one(doc! { "_id": "u1", "email": "a@example.com" })
        .await
        .expect("seed user");
    legacy
        .collection::<bson::Document>("documents")
        .insert_many((0..3).map(|i| doc! { "_id": format!("d{i}") }))
        .await
        .expect("seed documents");
    legacy
        .collection::<bson::Document>("meta")
        .insert_one(
            doc! { "_id": "schema", "schema_version": 3, "updated_at": bson::DateTime::now() },
        )
        .await
        .expect("schema marker");
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_target_booted_empty_is_copied_into() {
    let Some(uri) = common::mongo_uri() else {
        return;
    };
    let client = mongodb::Client::with_uri_str(&uri).await.expect("mongo");
    let suffix = new_id();
    let legacy_name = format!("ddd_renamehop_test_legacy_{suffix}");
    let target_name = format!("ddd_renamehop_test_target_{suffix}");
    let legacy = client.database(&legacy_name);
    let target = client.database(&target_name);
    seed_legacy(&legacy).await;

    // The new server booted on the target first: migrations and indexes ran, so
    // it has `meta` and empty collections, but nobody signed up.
    ddd_server::db::init_schema(&target)
        .await
        .expect("boot empty");
    assert!(
        target
            .collection::<bson::Document>("meta")
            .find_one(doc! { "_id": "schema" })
            .await
            .unwrap()
            .is_some()
    );

    let report = copy_legacy_database(&client, &legacy_name, &target_name)
        .await
        .expect("copy")
        .expect("an empty-but-migrated target is copied into");
    assert_eq!(
        report.collections.last().map(|(name, _)| name.as_str()),
        Some("meta")
    );
    assert_eq!(
        target
            .collection::<bson::Document>("documents")
            .count_documents(doc! {})
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        target
            .collection::<bson::Document>("users")
            .count_documents(doc! {})
            .await
            .unwrap(),
        1
    );
    // The boot after the copy runs the migrations and index pass on it cleanly.
    ddd_server::db::init_schema(&target)
        .await
        .expect("boot after copy");
    assert_eq!(
        copy_legacy_database(&client, &legacy_name, &target_name)
            .await
            .unwrap(),
        None,
        "copied once"
    );

    legacy.drop().await.expect("drop legacy");
    target.drop().await.expect("drop target");
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_target_with_users_is_never_touched() {
    let Some(uri) = common::mongo_uri() else {
        return;
    };
    let client = mongodb::Client::with_uri_str(&uri).await.expect("mongo");
    let suffix = new_id();
    let legacy_name = format!("ddd_renamehop_test_legacy_{suffix}");
    let target_name = format!("ddd_renamehop_test_target_{suffix}");
    let legacy = client.database(&legacy_name);
    let target = client.database(&target_name);
    seed_legacy(&legacy).await;

    // Somebody signed up on the target — with or without a schema document.
    let users = target.collection::<bson::Document>("users");
    users
        .insert_one(doc! { "_id": "mine", "email": "b@example.com" })
        .await
        .expect("target user");
    assert_eq!(
        copy_legacy_database(&client, &legacy_name, &target_name)
            .await
            .unwrap(),
        None
    );
    ddd_server::db::init_schema(&target).await.expect("boot");
    assert_eq!(
        copy_legacy_database(&client, &legacy_name, &target_name)
            .await
            .unwrap(),
        None
    );
    let only: Vec<bson::Document> = users
        .find(doc! {})
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    assert_eq!(only.len(), 1);
    assert_eq!(only[0].get_str("_id"), Ok("mine"));
    assert_eq!(
        target
            .collection::<bson::Document>("documents")
            .count_documents(doc! {})
            .await
            .unwrap(),
        0
    );
    assert!(
        target
            .collection::<bson::Document>("meta")
            .find_one(doc! { "_id": "schema" })
            .await
            .unwrap()
            .and_then(|meta| meta.get_document("rename_hop_copy").ok().cloned())
            .is_none(),
        "no copy marker"
    );

    legacy.drop().await.expect("drop legacy");
    target.drop().await.expect("drop target");
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn two_boots_at_once_copy_once() {
    let Some(uri) = common::mongo_uri() else {
        return;
    };
    let client = mongodb::Client::with_uri_str(&uri).await.expect("mongo");
    let suffix = new_id();
    let legacy_name = format!("ddd_renamehop_test_legacy_{suffix}");
    let target_name = format!("ddd_renamehop_test_target_{suffix}");
    let legacy = client.database(&legacy_name);
    seed_legacy(&legacy).await;

    let (a, b) = tokio::join!(
        copy_legacy_database(&client, &legacy_name, &target_name),
        copy_legacy_database(&client, &legacy_name, &target_name),
    );
    let copies = [a.expect("first"), b.expect("second")]
        .into_iter()
        .filter(Option::is_some)
        .count();
    assert_eq!(copies, 1, "the advisory lock lets exactly one copy run");

    legacy.drop().await.expect("drop legacy");
    client
        .database(&target_name)
        .drop()
        .await
        .expect("drop target");
}
