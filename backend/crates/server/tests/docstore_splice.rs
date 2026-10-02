mod common;

use std::sync::{Arc, Mutex};

use ddd_core::splice::{self, SectionLineEdit};
use ddd_server::db;
use ddd_server::docstore::{DocStore as _, DocStoreError, DocStoreTuning, MongoDocStore};
use ddd_server::domain::{Actor, new_id};
use ddd_server::feed::ChangeFeed;

const PLUGIN: &str = "calendar";

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

fn set(key: &str, value: &str) -> Vec<SectionLineEdit> {
    vec![SectionLineEdit {
        key: key.to_string(),
        value: Some(ddd_core::Value::Str(value.to_string())),
    }]
}

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

    let writer = {
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
        for line in 0..40 {
            let body = format!("Body line {line} — words a person typed.\n");
            assert!(
                outcome.content.contains(&body),
                "round {round}: `{}` was damaged by a machine write:\n{}",
                body.trim_end(),
                outcome.content
            );
        }
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

    let nothing = |_: &str| -> Result<Vec<splice::TextEdit>, String> { Ok(Vec::new()) };
    let outcome = store
        .splice(&created.id, &nothing, &Actor::System)
        .await
        .expect("a no-op splice");
    assert!(outcome.update.is_empty(), "a no-op wrote CRDT history");
    assert_eq!(outcome.content, document());

    let _ = db.drop().await;
}

fn tail(text: &str) -> &str {
    let start = text.len().saturating_sub(200);
    let start = (0..=start)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    &text[start..]
}
