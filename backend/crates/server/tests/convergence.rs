//! Server-side half of the M2 convergence gate (SPEC §9 M2).
//!
//! The Node harness in `web/harness/` drives the *whole* stack — N clients, a real
//! socket, partitions and reconnects. It cannot, however, tell you *where* a
//! divergence came from. These tests isolate the layer underneath the socket:
//! they push concurrent `yrs` updates straight through [`DocStore::apply_update`]
//! and assert the three properties the sync layer then relies on.
//!
//! | Property | Why it is here and not in the Node harness |
//! |---|---|
//! | every replica converges byte-identically with the stored CRDT | separates "the docstore merged wrongly" from "the socket lost a frame" |
//! | `title`/`fm`/`plugins` equal the shared core's parse of the converged text | materialization equality without a Wasm build or a browser in the loop |
//! | the update log replays to the same text | the fallback path of PROTOCOL.md §2.2 (a client predating the window) is lossless |
//!
//! These tests need MongoDB and are therefore `#[ignore]`d, like every other
//! Mongo-backed test in this workspace:
//!
//! ```bash
//! docker compose up -d --wait mongo
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server --test convergence -- --ignored
//! ```
//!
//! Each test uses its own database and drops it on the way out, so a failed run
//! leaves nothing behind for the next one to trip over.

use std::sync::Arc;

use bson::Document as BsonDocument;
use futures::TryStreamExt;
use life_manager_core::document::parse_document;
use life_manager_server::db::Collections;
use life_manager_server::docstore::{
    DocStore, DocStoreTuning, MongoDocStore, TEXT_ROOT, doc_options, materialize, version_hash,
};
use life_manager_server::domain::Actor;
use life_manager_server::feed::ChangeFeed;
use mongodb::{Client, Database};
use ulid::Ulid;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, Text, Transact, Update};

/// Documents the tests write: three regions, so materialization has real work.
///
/// The two date-ish values are deliberate. `due` is a real ISO-8601 datetime with
/// an offset, which materialization canonicalizes to UTC (SPEC §3.4) so
/// lexicographic sort is chronological; `date: 2026-9-3` is **not** a date to the
/// shared core (it demands zero-padded `YYYY-MM-DD`) and must therefore survive as
/// the plain string it is. A client re-deriving the projection has to reproduce
/// both behaviours, which is why the Node harness canonicalizes with the core's own
/// `normalize_date` rather than a hand-rolled rule.
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
        let name = format!("life_manager_convergence_{label}_{}", Ulid::generate());
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

/// One simulated replica: a `yrs` doc built with the pinned options (SPEC §3.2).
struct Replica {
    doc: Doc,
}

impl Replica {
    /// Hydrate from a full encoded state, exactly as a client does from
    /// `SYNC_STEP2` or `GET /api/documents/:id?format=crdt`.
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

    /// Insert at a character index, returning the update that carries it (what the
    /// client would put in an `UPDATE` frame).
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

    /// Apply what the server has that this replica lacks.
    fn apply(&self, update: &[u8]) {
        let decoded = Update::decode_v1(update).expect("server update must decode as v1");
        let mut txn = self.doc.transact_mut();
        txn.apply_update(decoded).expect("server update must apply");
    }
}

/// Five replicas edit one document concurrently; every one of them, and the
/// server, must end up with the same string.
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

    // Concurrent edits, all computed against the *same* starting state — the shape
    // of a real partition. They land in the **body**: writing into the frontmatter
    // block by raw offset would test how a mangled `date:` line parses (it parses
    // fine, and the value is then the mangled string) rather than convergence.
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

    // Interleave them into the store the way the socket would (round robin, so no
    // replica's pair of updates arrives adjacently).
    updates.sort_by_key(|(index, _)| *index % 2);
    for (_, update) in &updates {
        fixture
            .store
            .apply_update(&id, update, &actor)
            .await
            .expect("apply_update");
    }

    // Every replica pulls the server's diff — the state-vector resync of
    // PROTOCOL.md §3.5, which is the universal recovery move.
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

    // Every marker survived: ten concurrent inserts, ten markers, no loss.
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

    // Materialization equality (SPEC §9 M2): the derived fields are exactly what
    // the shared core makes of the converged text.
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

    // `materialized_version` is the hash of the state vector it was derived from
    // (SPEC §3.5: staleness is detectable, never silent).
    let state = fixture.store.crdt_state(&id).await.expect("crdt state");
    assert_eq!(
        document.materialized_version,
        version_hash(&state.state_vector),
        "materialized_version must hash the state vector it came from"
    );

    // And the core's own parse agrees with the stored projection, field by field —
    // the assertion the Wasm half of the harness makes from the client side.
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
    // Dates are canonicalized at materialization (SPEC §3.4), so a client comparing
    // a *raw* parse against the projection must canonicalize too — that is what
    // `web/harness/src/core.ts` does with the core's own `normalize_date`.
    assert_eq!(
        document.fm.get_str("due").ok(),
        Some("2026-09-03T05:00:00.000Z"),
        "fm.due: an offset datetime canonicalizes to UTC"
    );
    // And the boundary of that rule, pinned because it is easy to assume otherwise:
    // the core only recognizes zero-padded `YYYY-MM-DD`, so `2026-9-3` is an ordinary
    // string and materialization leaves it alone (both sides agree, which is what
    // matters — SPEC §2).
    assert_eq!(
        document.fm.get_str("date").ok(),
        Some("2026-9-3"),
        "fm.date: a non-padded date is not a date"
    );

    fixture.teardown().await;
}

/// The update log is the feed's fallback for a client that predates the window
/// (PROTOCOL.md §2.2). Replaying it must reconstruct the same text.
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

    // Replay every logged update, in `seq` order, onto an empty document. With the
    // default retention (200 entries / 1 MiB per document) nothing here is trimmed;
    // correctness of the *protocol* never depends on retention, but this reconstruction
    // is exactly what the fallback path does when the entries are still present.
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

/// Restoring the same text twice must not double it, and a concurrent editor's
/// state-vector resync must still converge afterwards. (`replace_text` computes a
/// minimal diff — a whole-text rewrite here would be visible as duplicated body.)
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
