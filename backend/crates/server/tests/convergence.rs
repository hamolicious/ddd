use std::sync::Arc;

use bson::Document as BsonDocument;
use ddd_core::document::parse_document;
use ddd_server::db::Collections;
use ddd_server::docstore::{
    DocStore, DocStoreTuning, MongoDocStore, TEXT_ROOT, doc_options, materialize, version_hash,
};
use ddd_server::domain::Actor;
use ddd_server::feed::ChangeFeed;
use futures::TryStreamExt;
use mongodb::{Client, Database};
use ulid::Ulid;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, Text, Transact, Update};

fn seed_text(name: &str) -> String {
    format!(
        "---\ntitle: {name}\npath: harness/convergence\ndate: 2026-9-3\n\
         due: 2026-09-03T07:00+02:00\nstatus: open\n---\n\n\
         # {name}\n\nbody line one\nbody line two\n\n- [ ] a task\n\n\
         %%% calendar\nsource-uid: {name}@harness\nrevision: 1\n%%%\n"
    )
}

struct Fixture {
    store: MongoDocStore,
    collections: Collections,
    database: Database,
}

impl Fixture {
    async fn new(label: &str) -> Option<Self> {
        let uri = std::env::var("MONGO_URI").ok()?;
        let client = Client::with_uri_str(&uri).await.ok()?;
        let name = format!("ddd_convergence_{label}_{}", Ulid::generate());
        let database = client.database(&name);
        let collections = Collections::new(database.clone());
        let feed = ChangeFeed::new(collections.clone());
        feed.initialize()
            .await
            .expect("the change feed must initialize against an empty database");
        let store = MongoDocStore::new(
            database.clone(),
            DocStoreTuning::default(),
            Arc::clone(&feed),
        );
        Some(Self {
            store,
            collections,
            database,
        })
    }

    async fn teardown(self) {
        let _ = self.database.drop().await;
    }
}

struct Replica {
    doc: Doc,
}

impl Replica {
    fn from_state(state: &[u8]) -> Self {
        let doc = Doc::with_options(doc_options());
        let text = doc.get_or_insert_text(TEXT_ROOT);
        let update = Update::decode_v1(state).expect("stored CRDT state must decode as v1");
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).expect("stored state must apply");
        }
        let _ = text;
        Self { doc }
    }

    fn text(&self) -> String {
        let text = self.doc.get_or_insert_text(TEXT_ROOT);
        let txn = self.doc.transact();
        text.get_string(&txn)
    }

    fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    fn insert(&self, index: u32, value: &str) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        let text = self.doc.get_or_insert_text(TEXT_ROOT);
        {
            let mut txn = self.doc.transact_mut();
            let len = text.len(&txn);
            text.insert(&mut txn, index.min(len), value);
        }
        self.doc.transact().encode_state_as_update_v1(&before)
    }

    fn apply(&self, update: &[u8]) {
        let decoded = Update::decode_v1(update).expect("server update must decode as v1");
        let mut txn = self.doc.transact_mut();
        txn.apply_update(decoded).expect("server update must apply");
    }
}

#[tokio::test]
#[ignore = "needs MongoDB: MONGO_URI=… cargo test -- --ignored"]
async fn replicas_converge_and_materialization_matches_the_core() {
    let Some(fixture) = Fixture::new("converge").await else {
        eprintln!("skipped: set MONGO_URI to run the convergence tests");
        return;
    };
    let actor = Actor::System;
    let id = Ulid::generate().to_string();
    let text = seed_text("Convergence");
    fixture
        .store
        .create(Some(id.clone()), &text, &actor)
        .await
        .expect("create");

    let base = fixture.store.crdt_state(&id).await.expect("crdt state");
    let replicas: Vec<Replica> = (0..5).map(|_| Replica::from_state(&base.state)).collect();

    let body_at = text
        .find("body line one")
        .expect("the seed document has a body") as u32;
    let mut updates: Vec<(usize, Vec<u8>)> = Vec::new();
    for (index, replica) in replicas.iter().enumerate() {
        let marker = format!(" {{{{c{index}#1}}}}");
        let at = body_at + (index as u32 * 3);
        updates.push((index, replica.insert(at, &marker)));
        updates.push((index, replica.insert(at, &format!(" {{{{c{index}#2}}}}"))));
    }

    updates.sort_by_key(|(index, _)| *index % 2);
    for (_, update) in &updates {
        fixture
            .store
            .apply_update(&id, update, &actor)
            .await
            .expect("apply_update");
    }

    for replica in &replicas {
        let diff = fixture
            .store
            .diff(&id, &replica.state_vector())
            .await
            .expect("diff");
        replica.apply(&diff);
    }

    let server_text = fixture.store.text(&id).await.expect("text");
    for (index, replica) in replicas.iter().enumerate() {
        assert_eq!(
            replica.text(),
            server_text,
            "replica {index} diverged from the server"
        );
    }

    for index in 0..5 {
        for op in 1..=2 {
            let marker = format!("{{{{c{index}#{op}}}}}");
            assert_eq!(
                server_text.matches(&marker).count(),
                1,
                "marker {marker} was lost or duplicated"
            );
        }
    }

    let document = fixture.store.get(&id).await.expect("get");
    assert_eq!(
        document.content, server_text,
        "materialized content trails the CRDT"
    );
    let expected = materialize(&server_text, document.materialized_version.clone());
    assert_eq!(document.title, expected.title, "title");
    assert_eq!(document.fm, expected.fm, "fm");
    assert_eq!(document.plugins, expected.plugins, "plugins");
    assert_eq!(
        document.fm_parse_error, expected.fm_parse_error,
        "fm_parse_error"
    );

    let state = fixture.store.crdt_state(&id).await.expect("crdt state");
    assert_eq!(
        document.materialized_version,
        version_hash(&state.state_vector),
        "materialized_version must hash the state vector it came from"
    );

    let parsed = parse_document(&server_text);
    assert_eq!(document.title, parsed.title);
    assert!(
        !document.fm.is_empty(),
        "frontmatter should have materialized"
    );
    assert_eq!(
        document.fm.get_str("path").ok(),
        Some("harness/convergence"),
        "fm.path"
    );
    assert_eq!(
        document.fm.get_str("due").ok(),
        Some("2026-09-03T05:00:00.000Z"),
        "fm.due: an offset datetime canonicalizes to UTC"
    );
    assert_eq!(
        document.fm.get_str("date").ok(),
        Some("2026-9-3"),
        "fm.date: a non-padded date is not a date"
    );

    fixture.teardown().await;
}

#[tokio::test]
#[ignore = "needs MongoDB: MONGO_URI=… cargo test -- --ignored"]
async fn the_update_log_replays_to_the_same_text() {
    let Some(fixture) = Fixture::new("replay").await else {
        eprintln!("skipped: set MONGO_URI to run the convergence tests");
        return;
    };
    let actor = Actor::System;
    let id = Ulid::generate().to_string();
    fixture
        .store
        .create(Some(id.clone()), &seed_text("Replay"), &actor)
        .await
        .expect("create");

    let base = fixture.store.crdt_state(&id).await.expect("crdt state");
    let replica = Replica::from_state(&base.state);
    for op in 0..20u32 {
        let update = replica.insert(60 + op, &format!(" {{{{r#{op}}}}}"));
        fixture
            .store
            .apply_update(&id, &update, &actor)
            .await
            .expect("apply_update");
    }

    let server_text = fixture.store.text(&id).await.expect("text");

    let mut cursor = fixture
        .collections
        .document_updates()
        .find(bson::doc! { "document_id": &id })
        .sort(bson::doc! { "seq": 1 })
        .await
        .expect("find updates");

    let doc = Doc::with_options(doc_options());
    let text = doc.get_or_insert_text(TEXT_ROOT);
    let mut applied = 0usize;
    while let Some(entry) = cursor.try_next().await.expect("read updates") {
        let update = Update::decode_v1(&entry.update.bytes).expect("logged update decodes as v1");
        let mut txn = doc.transact_mut();
        txn.apply_update(update).expect("logged update applies");
        applied += 1;
    }
    assert!(
        applied >= 21,
        "expected the create plus 20 updates, saw {applied}"
    );
    let replayed = {
        let txn = doc.transact();
        text.get_string(&txn)
    };
    assert_eq!(replayed, server_text, "update-log replay diverged");

    fixture.teardown().await;
}

#[tokio::test]
#[ignore = "needs MongoDB: MONGO_URI=… cargo test -- --ignored"]
async fn replace_text_is_a_minimal_diff() {
    let Some(fixture) = Fixture::new("replace").await else {
        eprintln!("skipped: set MONGO_URI to run the convergence tests");
        return;
    };
    let actor = Actor::System;
    let id = Ulid::generate().to_string();
    let text = seed_text("Minimal");
    fixture
        .store
        .create(Some(id.clone()), &text, &actor)
        .await
        .expect("create");

    let before = fixture.store.crdt_state(&id).await.expect("crdt state");
    let replica = Replica::from_state(&before.state);

    let rewritten = text.replace("status: open", "status: done");
    fixture
        .store
        .replace_text(&id, &rewritten, &actor)
        .await
        .expect("replace_text");

    let diff = fixture
        .store
        .diff(&id, &replica.state_vector())
        .await
        .expect("diff");
    replica.apply(&diff);

    let server_text = fixture.store.text(&id).await.expect("text");
    assert_eq!(
        server_text, rewritten,
        "replace_text changed more than the value span"
    );
    assert_eq!(
        replica.text(),
        server_text,
        "replica diverged after a replace"
    );

    let document = fixture.store.get(&id).await.expect("get");
    let expected: BsonDocument =
        materialize(&server_text, document.materialized_version.clone()).fm;
    assert_eq!(document.fm, expected, "fm after replace_text");
    assert_eq!(document.fm.get_str("status").ok(), Some("done"));

    fixture.teardown().await;
}
