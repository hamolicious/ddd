//! The operator-tunable docstore knobs actually reach the engine.
//!
//! The M1 carry-over: `MATERIALIZE_DEBOUNCE_MS`, `ROOM_IDLE_TIMEOUT_SECS`,
//! `UPDATE_LOG_KEEP_BYTES`/`_COUNT`, `CRDT_*_THRESHOLD_BYTES` and
//! `TRASH_RETENTION_DAYS` were validated in `Config` at boot — and then never
//! handed to `MongoDocStore`, which read the module constants instead. Setting one
//! changed nothing, silently, which is the worst possible failure mode for a
//! tuning knob: an operator raising `UPDATE_LOG_KEEP_BYTES` after a resync
//! incident would have seen no effect and no error.
//!
//! `DocStoreTuning` is now the constructor parameter (CONTRACTS.md, area docstore,
//! M2 item 4). These tests assert the mapping field by field — a swapped pair in
//! `from_config` type-checks perfectly — and then that the store *consults* the
//! tuning rather than the constants.

mod common;

use std::time::Duration;

use life_manager_core::limits;
use life_manager_server::db;
use life_manager_server::docstore::{
    self, DocStore as _, DocStoreError, DocStoreTuning, MongoDocStore,
};
use life_manager_server::domain::{Actor, new_id};
use life_manager_server::feed::ChangeFeed;

/// Every knob, mapped from a config whose values differ from **every** default, so
/// a field left reading its constant or crossed with its neighbour fails here.
#[test]
fn every_config_knob_maps_onto_the_tuning() {
    let config = common::test_config(
        "mongodb://127.0.0.1:27017".to_string(),
        "unused".to_string(),
    );
    let tuning = DocStoreTuning::from_config(&config);

    assert_eq!(tuning.max_document_bytes, config.max_document_bytes);
    assert_eq!(tuning.materialize_debounce, config.materialize_debounce);
    assert_eq!(tuning.room_idle_timeout, config.room_idle_timeout);
    assert_eq!(tuning.update_log_keep_bytes, config.update_log_keep_bytes);
    assert_eq!(tuning.update_log_keep_count, config.update_log_keep_count);
    assert_eq!(
        tuning.crdt_compact_threshold_bytes,
        config.crdt_compact_threshold_bytes
    );
    assert_eq!(
        tuning.crdt_alert_threshold_bytes,
        config.crdt_alert_threshold_bytes
    );
    assert_eq!(
        tuning.trash_retention_days,
        i64::from(config.trash_retention_days)
    );

    // And none of them is the default, so the assertions above cannot be passing
    // by coincidence.
    let defaults = DocStoreTuning::default();
    assert_ne!(tuning.max_document_bytes, defaults.max_document_bytes);
    assert_ne!(tuning.materialize_debounce, defaults.materialize_debounce);
    assert_ne!(tuning.room_idle_timeout, defaults.room_idle_timeout);
    assert_ne!(tuning.update_log_keep_bytes, defaults.update_log_keep_bytes);
    assert_ne!(tuning.update_log_keep_count, defaults.update_log_keep_count);
    assert_ne!(
        tuning.crdt_compact_threshold_bytes,
        defaults.crdt_compact_threshold_bytes
    );
    assert_ne!(
        tuning.crdt_alert_threshold_bytes,
        defaults.crdt_alert_threshold_bytes
    );
    assert_ne!(tuning.trash_retention_days, defaults.trash_retention_days);
}

/// The defaults are the documented spec values, so omitting every variable keeps
/// the behaviour SPEC §3.5 and §4.3 describe.
#[test]
fn the_defaults_are_the_spec_values() {
    let defaults = DocStoreTuning::default();
    assert_eq!(defaults.max_document_bytes, limits::MAX_DOCUMENT_BYTES);
    assert_eq!(defaults.materialize_debounce, Duration::from_millis(500));
    assert_eq!(defaults.room_idle_timeout, Duration::from_secs(600));
    assert_eq!(defaults.update_log_keep_bytes, 1024 * 1024);
    assert_eq!(defaults.update_log_keep_count, 200);
    assert_eq!(defaults.crdt_compact_threshold_bytes, 4 * 1024 * 1024);
    assert_eq!(defaults.crdt_alert_threshold_bytes, 8 * 1024 * 1024);
    assert_eq!(defaults.trash_retention_days, 30);
    // The module constants stay the documented defaults.
    assert_eq!(
        defaults.materialize_debounce,
        docstore::MATERIALIZE_DEBOUNCE
    );
    assert_eq!(defaults.room_idle_timeout, docstore::ROOM_IDLE_TIMEOUT);
    assert_eq!(
        defaults.update_log_keep_bytes,
        docstore::UPDATE_LOG_KEEP_BYTES
    );
    assert_eq!(
        defaults.update_log_keep_count,
        docstore::UPDATE_LOG_KEEP_COUNT
    );
    assert_eq!(
        defaults.crdt_compact_threshold_bytes,
        docstore::CRDT_COMPACT_THRESHOLD_BYTES
    );
    assert_eq!(
        defaults.crdt_alert_threshold_bytes,
        docstore::CRDT_ALERT_THRESHOLD_BYTES
    );
    assert_eq!(
        defaults.trash_retention_days,
        docstore::TRASH_RETENTION_DAYS
    );
}

/// A store built from a non-default tuning must *use* it.
///
/// `max_document_bytes` is the observable one: a store tuned to 2 KiB has to
/// refuse a 3 KiB document, which the shared core's 1 MiB constant would wave
/// through. `tuning()` echoing the struct back is the cheap half of the same
/// check.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_store_enforces_its_own_tuning() {
    let Some(uri) = common::mongo_uri() else {
        return;
    };
    let Ok(client) = mongodb::Client::with_uri_str(&uri).await else {
        return;
    };
    let database = format!("lm_tuning_test_{}", new_id());
    let db = client.database(&database);
    db::indexes::ensure(&db).await.expect("indexes");

    let tuning = DocStoreTuning {
        max_document_bytes: 2048,
        materialize_debounce: Duration::from_millis(25),
        room_idle_timeout: Duration::from_secs(1),
        update_log_keep_bytes: 512,
        update_log_keep_count: 3,
        crdt_compact_threshold_bytes: 16 * 1024,
        crdt_alert_threshold_bytes: 32 * 1024,
        trash_retention_days: 1,
        checkpoint_every_changes: 2,
    };
    let feed = ChangeFeed::new(db::Collections::new(db.clone()));
    let store = MongoDocStore::new(db.clone(), tuning, feed);
    assert_eq!(store.tuning(), tuning, "the store keeps its tuning");

    let over = "x".repeat(tuning.max_document_bytes + 1);
    match store.create(None, &over, &Actor::System).await {
        Err(DocStoreError::TooLarge { len, limit }) => {
            assert_eq!(len, over.len());
            assert_eq!(
                limit, tuning.max_document_bytes,
                "the configured cap is the one reported to the client"
            );
        }
        other => panic!("a tuned cap was not enforced: {other:?}"),
    }

    // Under the cap the same store writes happily, so the limit is a limit and not
    // a broken write path.
    let created = store
        .create(None, &"y".repeat(tuning.max_document_bytes), &Actor::System)
        .await
        .expect("a document at the cap is accepted");
    assert_eq!(store.text(&created.id).await.unwrap().len(), 2048);

    // The room-idle timeout is the other knob with a directly observable effect:
    // one second, so eviction happens inside a test rather than in ten minutes.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let evicted = store.evict_idle().await.expect("eviction");
    assert!(
        evicted >= 1,
        "a room idle past the tuned timeout is evicted"
    );
    assert_eq!(store.stats().rooms, 0);
    // Evicting is not losing: the text comes back from Mongo plus the update log.
    assert_eq!(store.text(&created.id).await.unwrap().len(), 2048);

    let _ = db.drop().await;
}

/// The update log is trimmed to the *tuned* retention, and correctness never
/// depends on it (SPEC §3.5): the document still reads back after the log has been
/// cut down to a handful of entries.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn the_update_log_is_trimmed_to_the_tuned_retention() {
    let Some(uri) = common::mongo_uri() else {
        return;
    };
    let Ok(client) = mongodb::Client::with_uri_str(&uri).await else {
        return;
    };
    let database = format!("lm_tuning_test_{}", new_id());
    let db = client.database(&database);
    db::indexes::ensure(&db).await.expect("indexes");

    let tuning = DocStoreTuning {
        update_log_keep_count: 2,
        update_log_keep_bytes: 256,
        ..DocStoreTuning::default()
    };
    let feed = ChangeFeed::new(db::Collections::new(db.clone()));
    let store = MongoDocStore::new(db.clone(), tuning, feed);

    let created = store
        .create(None, "line 0\n", &Actor::System)
        .await
        .expect("create");
    // Trimming runs every 32 appends (plus the periodic worker): `create` takes
    // seq 1, so 31 replaces land exactly on the boundary.
    for n in 1..=31 {
        store
            .replace_text(&created.id, &format!("line {n}\n"), &Actor::System)
            .await
            .expect("replace");
    }

    let kept = db
        .collection::<bson::Document>(db::DOCUMENT_UPDATES)
        .count_documents(bson::doc! { "document_id": &created.id })
        .await
        .expect("count");
    assert!(
        kept <= u64::from(tuning.update_log_keep_count),
        "the log kept {kept} entries for a retention of {}",
        tuning.update_log_keep_count
    );
    assert!(kept >= 1, "the newest entry is never trimmed away");

    // The document is intact: a trimmed log falls back to the stored `crdt` blob.
    assert_eq!(store.text(&created.id).await.unwrap(), "line 31\n");

    let _ = db.drop().await;
}
