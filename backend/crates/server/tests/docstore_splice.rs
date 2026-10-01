//! `DocStore::splice` — the primitive machine writes go through, and the race it was built to
//! close (SPEC §3.3, §11.2).
//!
//! # The bug this suite exists for
//!
//! A [`ddd_core::splice::TextEdit`] is a **byte-offset span**, and a byte offset means
//! nothing except against the exact string it was computed from. The obvious API — read the text,
//! compute the spans, apply them — is two separate acquisitions of the per-document lock, and a
//! concurrent CRDT write in the window between them shifts every offset. Nothing downstream can
//! catch it: `edit_deltas` checks bounds, character boundaries and non-overlap, never whether a
//! span still holds the line it was derived from.
//!
//! Both callers had it. `host_fns::splice_section` wrote a plugin's one-line `%%%` value over the
//! tail of a human's prose; the uninstall purge, which removes *whole sections* and walks every
//! document in a workspace people are typing in, deleted a block of body text and left the
//! `%%% … %%%` fence standing — then reported success. That is well past what SPEC §11.2 accepts,
//! which is losing one *machine* value, never user text.
//!
//! So `splice` takes the computation, not its result, and runs it once with the lock held. These
//! tests assert the property that makes that worth doing: **the document is always exactly
//! `apply(what the closure was shown, what it returned)`**, no matter what else is writing. An
//! implementation that reads outside the lock fails the concurrent case within a few iterations.
//!
//! Skips silently without `MONGO_URI`, like every other Mongo-backed suite:
//!
//! ```text
//! docker compose up -d --wait mongo
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p ddd-server --test docstore_splice -- --ignored
//! ```
//!
//! **Owner:** the `docstore` area, with the `wasm-host` builder (the caller that needed it).

mod common;

use std::sync::{Arc, Mutex};

use ddd_core::splice::{self, SectionLineEdit};
use ddd_server::db;
use ddd_server::docstore::{DocStore as _, DocStoreError, DocStoreTuning, MongoDocStore};
use ddd_server::domain::{Actor, new_id};
use ddd_server::feed::ChangeFeed;

const PLUGIN: &str = "calendar";

/// A document with a body and this plugin's machine section, i.e. the shape at risk: text a human
/// owns *above* the offsets a machine writes.
fn document() -> String {
    let mut text = String::from("---\ntitle: Standup\n---\n\n");
    for line in 0..40 {
        text.push_str(&format!("Body line {line} — words a person typed.\n"));
    }
    text.push_str("\n%%% calendar\nstatus: confirmed\nsource-uid: abc123\n%%%\n");
    text
}

async fn store() -> Option<(MongoDocStore, mongodb::Database, mongodb::Client)> {
    let uri = common::mongo_uri()?;
    let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
    let db = client.database(&format!("ddd_splice_test_{}", new_id()));
    db::indexes::ensure(&db).await.ok()?;
    let feed = ChangeFeed::new(db::Collections::new(db.clone()));
    let store = MongoDocStore::new(db.clone(), DocStoreTuning::default(), feed);
    Some((store, db, client))
}

/// One `%%%` line edit, as `splice_section` builds it.
fn set(key: &str, value: &str) -> Vec<SectionLineEdit> {
    vec![SectionLineEdit {
        key: key.to_string(),
        value: Some(ddd_core::Value::Str(value.to_string())),
    }]
}

/// What a closure was shown and what it returned — the pair the assertion needs.
#[derive(Default)]
struct Seen {
    text: Option<String>,
    edits: Vec<splice::TextEdit>,
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_splice_writes_exactly_what_its_closure_computed() {
    let Some((store, db, _client)) = store().await else {
        return;
    };
    let created = store
        .create(None, &document(), &Actor::System)
        .await
        .expect("create");

    let seen = Arc::new(Mutex::new(Seen::default()));
    let compute = {
        let seen = Arc::clone(&seen);
        move |text: &str| -> Result<Vec<splice::TextEdit>, String> {
            let edits = splice::splice_section(text, PLUGIN, &set("status", "cancelled"))
                .map_err(|err| err.to_string())?;
            let mut slot = seen.lock().expect("the seen lock");
            slot.text = Some(text.to_string());
            slot.edits = edits.clone();
            Ok(edits)
        }
    };

    let outcome = store
        .splice(&created.id, &compute, &Actor::System)
        .await
        .expect("splice");

    let (shown, edits) = {
        let slot = seen.lock().expect("the seen lock");
        (
            slot.text.clone().expect("the closure ran"),
            slot.edits.clone(),
        )
    };
    assert_eq!(
        outcome.content,
        splice::apply(&shown, &edits),
        "the write did not equal the closure's own computation"
    );
    assert!(outcome.content.contains("status: cancelled"));
    assert!(
        outcome
            .content
            .contains("Body line 39 — words a person typed."),
        "a body line was damaged: {}",
        outcome.content
    );

    let _ = db.drop().await;
}

/// The race, run for real: writes that insert text **above** the machine section while a splice is
/// in flight, over and over. Every iteration asserts the same invariant.
///
/// Inserting above the fence is what makes it bite — it shifts every byte offset in the section —
/// and the body lines are checked afterwards because "the plugin's value landed somewhere else" and
/// "a person's sentence was overwritten" are the same bug seen from two ends.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_concurrent_edit_cannot_shift_a_splice_onto_someone_elses_text() {
    let Some((store, db, _client)) = store().await else {
        return;
    };
    let store = Arc::new(store);
    let created = store
        .create(None, &document(), &Actor::System)
        .await
        .expect("create");

    // A writer inserting a line at the top of the body, continuously.
    let writer = {
        let store = Arc::clone(&store);
        let id = created.id.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let handle = tokio::spawn(async move {
            let mut n = 0u32;
            while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                let text = store.text(&id).await.expect("read");
                // A whole-text write, the way `PUT /api/documents/:id` does it: insert one line
                // right after the frontmatter, so everything below it moves.
                let marker = "---\n\n";
                let at = text.find(marker).map(|i| i + marker.len()).unwrap_or(0);
                let mut next = String::with_capacity(text.len() + 40);
                next.push_str(&text[..at]);
                next.push_str(&format!("Inserted line {n} by a person.\n"));
                next.push_str(&text[at..]);
                let _ = store.replace_text(&id, &next, &Actor::System).await;
                n += 1;
                tokio::task::yield_now().await;
            }
        });
        (handle, stop)
    };

    for round in 0..40u32 {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let value = format!("round-{round}");
        let compute = {
            let seen = Arc::clone(&seen);
            let value = value.clone();
            move |text: &str| -> Result<Vec<splice::TextEdit>, String> {
                let edits = splice::splice_section(text, PLUGIN, &set("status", &value))
                    .map_err(|err| err.to_string())?;
                let mut slot = seen.lock().expect("the seen lock");
                slot.text = Some(text.to_string());
                slot.edits = edits.clone();
                Ok(edits)
            }
        };

        let outcome = match store.splice(&created.id, &compute, &Actor::System).await {
            Ok(outcome) => outcome,
            // A lost optimistic-concurrency race is a legitimate answer under contention; a
            // corrupted document is not.
            Err(DocStoreError::Contended(_)) => continue,
            Err(err) => panic!("round {round}: {err}"),
        };

        let slot = seen.lock().expect("the seen lock");
        let shown = slot.text.as_deref().expect("the closure ran");
        assert_eq!(
            outcome.content,
            splice::apply(shown, &slot.edits),
            "round {round}: the write did not equal the closure's own computation — the offsets \
             were computed against a text other than the one they were applied to"
        );
        assert!(
            outcome.content.contains(&format!("status: {value}")),
            "round {round}: the section value did not land: {}",
            tail(&outcome.content)
        );
        // Nothing above the fence may be touched. This is the assertion that fails when a splice
        // slides: the line it lands on is a body line, and it stops being intact.
        for line in 0..40 {
            let body = format!("Body line {line} — words a person typed.\n");
            assert!(
                outcome.content.contains(&body),
                "round {round}: `{}` was damaged by a machine write:\n{}",
                body.trim_end(),
                outcome.content
            );
        }
        // And the fence itself is still a fence.
        assert_eq!(
            outcome.content.matches("%%%").count(),
            2,
            "round {round}: the section markers were mangled:\n{}",
            tail(&outcome.content)
        );
    }

    let (handle, stop) = writer;
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = handle.await;
    let _ = db.drop().await;
}

/// The uninstall purge's primitive: whole-section removal, under the same contention.
///
/// The more dangerous half of the same race, because the span removed is a whole block: a slide
/// deleted a run of body text and left the fence behind, during what an admin was told is a data
/// cleanup.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_concurrent_edit_cannot_make_a_section_purge_delete_body_text() {
    let Some((store, db, _client)) = store().await else {
        return;
    };
    let store = Arc::new(store);

    for round in 0..25u32 {
        let created = store
            .create(None, &document(), &Actor::System)
            .await
            .expect("create");

        // Insertions above the fence, continuously, so the removal is certain to meet one
        // whichever side of the lock it reads on. A single racing write is not enough: it can
        // land before the read and prove nothing.
        let racer = {
            let store = Arc::clone(&store);
            let id = created.id.clone();
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let flag = Arc::clone(&stop);
            let handle = tokio::spawn(async move {
                let mut n = 0u32;
                while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                    let text = store.text(&id).await.expect("read");
                    let marker = "---\n\n";
                    let at = text.find(marker).map(|i| i + marker.len()).unwrap_or(0);
                    let mut next = String::with_capacity(text.len() + 64);
                    next.push_str(&text[..at]);
                    next.push_str(&format!("Paragraph {n} somebody was writing.\n"));
                    next.push_str(&text[at..]);
                    let _ = store.replace_text(&id, &next, &Actor::System).await;
                    n += 1;
                    tokio::task::yield_now().await;
                }
            });
            (handle, stop)
        };
        // Let the writer land at least one insertion, so the removal is genuinely racing an
        // in-progress edit rather than reading a document nobody has touched yet.
        for _ in 0..20 {
            if store
                .text(&created.id)
                .await
                .is_ok_and(|text| text.contains("somebody was writing"))
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        let seen = Arc::new(Mutex::new(Seen::default()));
        let compute = {
            let seen = Arc::clone(&seen);
            move |text: &str| -> Result<Vec<splice::TextEdit>, String> {
                let edits = splice::remove_section(text, PLUGIN).map_err(|err| err.to_string())?;
                let mut slot = seen.lock().expect("the seen lock");
                slot.text = Some(text.to_string());
                slot.edits = edits.clone();
                Ok(edits)
            }
        };
        let result = store.splice(&created.id, &compute, &Actor::System).await;
        let (handle, stop) = racer;
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = handle.await;
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(DocStoreError::Contended(_)) => continue,
            Err(err) => panic!("round {round}: {err}"),
        };

        let slot = seen.lock().expect("the seen lock");
        let shown = slot.text.as_deref().expect("the closure ran");
        // Non-vacuity: the closure was shown a text somebody had been editing, so the spans it
        // produced were computed against the live document and not a snapshot taken before those
        // edits landed. This is the property, stated directly — a purge that reads outside the
        // lock computes its spans against a text that no longer exists.
        assert!(
            shown.contains("somebody was writing"),
            "round {round}: the closure never saw the concurrent edits, so this round proved \
             nothing"
        );
        assert_eq!(
            outcome.content,
            splice::apply(shown, &slot.edits),
            "round {round}: the removal did not equal the closure's own computation"
        );
        assert!(
            !outcome.content.contains("%%%"),
            "round {round}: the fence survived the purge, which means the span that was removed \
             was not the section:\n{}",
            tail(&outcome.content)
        );
        for line in 0..40 {
            let body = format!("Body line {line} — words a person typed.\n");
            assert!(
                outcome.content.contains(&body),
                "round {round}: the purge deleted `{}`:\n{}",
                body.trim_end(),
                outcome.content
            );
        }
    }

    let _ = db.drop().await;
}

/// A closure that declines produces [`DocStoreError::SpliceRefused`] with its own message, and no
/// write at all.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_refused_computation_writes_nothing() {
    let Some((store, db, _client)) = store().await else {
        return;
    };
    let created = store
        .create(None, &document(), &Actor::System)
        .await
        .expect("create");

    let refuse = |_: &str| -> Result<Vec<splice::TextEdit>, String> {
        Err("the section edit is not representable".to_string())
    };
    match store.splice(&created.id, &refuse, &Actor::System).await {
        Err(DocStoreError::SpliceRefused(message)) => {
            assert!(message.contains("not representable"), "{message}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }

    // An empty edit list is a clean no-op rather than a refusal: an idempotent sync that finds
    // nothing to change must produce no CRDT history at all (HOST-ABI.md §3.4).
    let nothing = |_: &str| -> Result<Vec<splice::TextEdit>, String> { Ok(Vec::new()) };
    let outcome = store
        .splice(&created.id, &nothing, &Actor::System)
        .await
        .expect("a no-op splice");
    assert!(outcome.update.is_empty(), "a no-op wrote CRDT history");
    assert_eq!(outcome.content, document());

    let _ = db.drop().await;
}

/// The last 200 bytes, for an assertion message about a fence.
fn tail(text: &str) -> &str {
    let start = text.len().saturating_sub(200);
    let start = (0..=start)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    &text[start..]
}
