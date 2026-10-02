mod common;

use bson::{DateTime as BsonDateTime, doc};
use ddd_server::domain::{Actor, new_id};
use ddd_server::state::AppState;

const PRE_FEED_ROWS: i64 = 25;

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
    let database = format!("ddd_boot_test_{}", new_id());
    let config = common::test_config(uri.clone(), database.clone());
    let client = mongodb::Client::with_uri_str(&uri).await.expect("mongo");

    {
        let db = client.database(&database);
        let documents = db.collection::<bson::Document>("documents");
        let rows: Vec<bson::Document> = (1..=PRE_FEED_ROWS).map(m1_row).collect();
        documents.insert_many(rows).await.expect("seed M1 rows");
    }

    let state = AppState::new(config).await.expect("app state");

    assert_eq!(
        state.feed.head_seq(),
        0,
        "no row carries a feed_seq yet, so the head starts at zero"
    );

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
    let database = format!("ddd_boot_test_{}", new_id());
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

    state.init_schema().await.expect("schema again");
    assert_eq!(state.feed.head_seq(), head);

    let _ = client.database(&database).drop().await;
}
