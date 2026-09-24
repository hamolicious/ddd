//! Boot ordering of the change feed against a real database.
//!
//! One bug, pinned from both ends: the feed's sequence counter is seeded from
//! `max(feed_seq)`, and `m002_backfill_feed_seq` is what *writes* those numbers onto
//! the rows an M1 workspace left behind. Seeding before the migration therefore
//! seeds from a database where no row has a number yet — `head = 0` — and the
//! allocator then hands out 1, 2, 3… over the numbers the backfill just wrote. Two
//! rows share a sequence number (one of them never reaches a client that is more
//! than a page behind), and `welcome.feed.safe_seq` reports a watermark thousands
//! below what the rows carry, which hides every backfilled row from catch-up.
//!
//! `AppState::init_schema` is the fix — migrations, then re-seed — and this suite is
//! the M1→M2 upgrade it has to survive.
//!
//! `#[ignore]`d like every Mongo-backed suite; skips silently with no `MONGO_URI`.

mod common;

use bson::{DateTime as BsonDateTime, doc};
use life_manager_server::domain::{Actor, new_id};
use life_manager_server::state::AppState;

/// How many pre-feed documents the fake M1 workspace holds.
const PRE_FEED_ROWS: i64 = 25;

/// A `documents` row exactly as M1 wrote it: no `feed_seq` anywhere.
fn m1_row(index: i64) -> bson::Document {
    let text = format!("---\ntitle: Legacy {index}\n---\n\nbody {index}\n");
    doc! {
        "_id": new_id(),
        "crdt": bson::Binary { subtype: bson::spec::BinarySubtype::Generic, bytes: Vec::new() },
        "state_vector": bson::Binary { subtype: bson::spec::BinarySubtype::Generic, bytes: Vec::new() },
        "content": &text,
        "title": format!("Legacy {index}"),
        "fm": doc! { "title": format!("Legacy {index}") },
        "plugins": doc! {},
        "materialized_version": format!("{index:032x}"),
        "fm_parse_error": false,
        "created_at": BsonDateTime::now(),
        "updated_at": BsonDateTime::from_millis(1_700_000_000_000 + index),
    }
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn upgrading_an_m1_workspace_never_reuses_a_sequence_number() {
    let Some(uri) = common::mongo_uri() else {
        return;
    };
    let database = format!("lm_boot_test_{}", new_id());
    let config = common::test_config(uri.clone(), database.clone());
    let client = mongodb::Client::with_uri_str(&uri).await.expect("mongo");

    // An M1 workspace: rows, no `feed_seq`, no schema version.
    {
        let db = client.database(&database);
        let documents = db.collection::<bson::Document>("documents");
        let rows: Vec<bson::Document> = (1..=PRE_FEED_ROWS).map(m1_row).collect();
        documents.insert_many(rows).await.expect("seed M1 rows");
    }

    let state = AppState::new(config).await.expect("app state");

    // `AppState::new` seeds the counter before the migrations can run, so at this
    // point it has correctly found nothing.
    assert_eq!(
        state.feed.head_seq(),
        0,
        "no row carries a feed_seq yet, so the head starts at zero"
    );

    // The boot step every caller must run: migrations, then re-seed.
    state.init_schema().await.expect("schema");

    assert_eq!(
        state.feed.head_seq(),
        PRE_FEED_ROWS,
        "the backfill numbered {PRE_FEED_ROWS} rows, so the head must be {PRE_FEED_ROWS}"
    );
    assert_eq!(
        state.feed.safe_seq(),
        PRE_FEED_ROWS,
        "nothing is in flight, so the watermark is the head — a catch-up capped at \
         safe_seq can therefore see every backfilled row"
    );

    // The first live write after the upgrade must not collide with the backfill.
    let created = state
        .docs
        .create(
            None,
            "---\ntitle: After the upgrade\n---\n\nnew\n",
            &Actor::System,
        )
        .await
        .expect("create");
    let row = state
        .db
        .collection::<bson::Document>("documents")
        .find_one(doc! { "_id": &created.id })
        .await
        .expect("read")
        .expect("the new row exists");
    let seq = row
        .get_i64("feed_seq")
        .expect("the new row carries a feed_seq");
    assert!(
        seq > PRE_FEED_ROWS,
        "a live write must allocate above the backfill, got {seq} against {PRE_FEED_ROWS}"
    );

    // And every sequence number in the workspace is unique — the property the whole
    // feed rests on (PROTOCOL.md §2.2: one row per document, carrying its newest
    // number; "everything since X" is exact).
    let mut seen = std::collections::HashSet::new();
    let mut cursor = state
        .db
        .collection::<bson::Document>("documents")
        .find(doc! {})
        .projection(doc! { "feed_seq": 1 })
        .await
        .expect("scan");
    use futures::TryStreamExt;
    while let Some(row) = cursor.try_next().await.expect("read") {
        let seq = row.get_i64("feed_seq").expect("every row is numbered");
        assert!(seen.insert(seq), "feed_seq {seq} was handed out twice");
    }
    assert_eq!(seen.len() as i64, PRE_FEED_ROWS + 1);

    let _ = client.database(&database).drop().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn re_seeding_is_idempotent_and_never_lowers_the_head() {
    let Some(uri) = common::mongo_uri() else {
        return;
    };
    let database = format!("lm_boot_test_{}", new_id());
    let config = common::test_config(uri.clone(), database.clone());
    let client = mongodb::Client::with_uri_str(&uri).await.expect("mongo");

    let state = AppState::new(config).await.expect("app state");
    state.init_schema().await.expect("schema");

    state
        .docs
        .create(None, "---\ntitle: One\n---\n\nbody\n", &Actor::System)
        .await
        .expect("create");
    let head = state.feed.head_seq();
    assert!(head >= 1);

    // Running the boot step again (a restart against the same database, or a test
    // that calls it twice) must not rewind the counter.
    state.init_schema().await.expect("schema again");
    assert_eq!(state.feed.head_seq(), head);

    let _ = client.database(&database).drop().await;
}
