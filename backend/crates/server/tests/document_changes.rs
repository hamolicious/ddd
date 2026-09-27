//! `/api/documents/:id/changes` — change history over the router: every text-changing
//! write is recorded, grouped by author, shown as a diff, and revertable unless a later
//! change touched the same text.

mod common;

use axum::http::StatusCode;
use common::TestApp;
use life_manager_server::domain::Actor;
use serde_json::json;

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn changes_are_recorded_grouped_shown_and_reverted() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document("# Notes\n\nfirst line\n").await;

    // Two writes by the signed-in user: one group.
    app.put_json(&format!("/api/documents/{id}"), json!({ "content": "# Notes\n\nfirst line\nsecond line\n" }))
        .await
        .expect_status(StatusCode::OK);
    app.put_json(
        &format!("/api/documents/{id}"),
        json!({ "content": "# Notes\n\nfirst line, edited\nsecond line\n" }),
    )
    .await
    .expect_status(StatusCode::OK);

    // A later write by someone else, somewhere else: its own group.
    app.state
        .docs
        .replace_text(
            &id,
            "# Notes\n\nfirst line, edited\nsecond line\n\nby a plugin\n",
            &Actor::Plugin("helper".into()),
        )
        .await
        .expect("plugin write");

    let page = app.get(&format!("/api/documents/{id}/changes")).await;
    page.expect_status(StatusCode::OK);
    let body = page.json();
    let groups = body["groups"].as_array().expect("groups");
    assert_eq!(groups.len(), 2, "{body}");
    assert_eq!(groups[0]["by_label"], json!("plugin helper"));
    assert_eq!(groups[1]["changes"], json!(2));
    assert_eq!(groups[1]["by"], json!(app.user_id));

    let (from, to) = (groups[1]["from_seq"].as_i64().unwrap(), groups[1]["to_seq"].as_i64().unwrap());
    let detail = app.get(&format!("/api/documents/{id}/changes/{from}/{to}")).await;
    detail.expect_status(StatusCode::OK);
    let hunks = detail.json()["hunks"].clone();
    assert_eq!(hunks[0]["removed"], json!("first line\n"));
    assert_eq!(hunks[0]["inserted"], json!("first line, edited\nsecond line\n"));

    // Reverting the user's group keeps the plugin's later line.
    let reverted = app.post_json(&format!("/api/documents/{id}/changes/{from}/{to}/revert"), json!({})).await;
    reverted.expect_status(StatusCode::OK);
    assert_eq!(reverted.json()["content"], json!("# Notes\n\nfirst line\n\nby a plugin\n"));

    // The revert is itself a change, marked as one, and can be reverted in turn.
    let after = app.get(&format!("/api/documents/{id}/changes")).await.json();
    assert_eq!(after["groups"][0]["reverts"], json!({ "from_seq": from, "to_seq": to }));

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_revert_is_refused_when_a_later_change_touched_the_same_text() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document("a\nb\nc\n").await;
    app.put_json(&format!("/api/documents/{id}"), json!({ "content": "a\nB\nc\n" }))
        .await
        .expect_status(StatusCode::OK);
    app.state
        .docs
        .replace_text(&id, "a\nBB\nc\n", &Actor::Plugin("helper".into()))
        .await
        .expect("plugin write");

    let groups = app.get(&format!("/api/documents/{id}/changes")).await.json()["groups"].clone();
    let (from, to) = (groups[1]["from_seq"].as_i64().unwrap(), groups[1]["to_seq"].as_i64().unwrap());
    let refused = app.post_json(&format!("/api/documents/{id}/changes/{from}/{to}/revert"), json!({})).await;
    refused.expect_status(StatusCode::CONFLICT);
    assert!(refused.text().contains("plugin helper changed the same text later"), "{}", refused.text());
    assert_eq!(app.get(&format!("/api/documents/{id}")).await.json()["content"], json!("a\nBB\nc\n"));

    app.cleanup().await;
}

/// A checkpoint every `CHECKPOINT_EVERY_CHANGES` changes (3 in the test config), plus
/// one at creation; every point in time rebuilds exactly; no automatic snapshots.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn checkpoints_rebuild_every_point_in_time() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let mut texts = vec!["# Log\n".to_string()];
    let id = app.create_document(&texts[0]).await;
    for n in 1..=7 {
        let next = format!("{}entry {n}\n", texts.last().unwrap());
        app.put_json(&format!("/api/documents/{id}"), json!({ "content": next }))
            .await
            .expect_status(StatusCode::OK);
        texts.push(next);
    }

    // Creation is update 1; the seven edits are updates 2..=8.
    let checkpoints: Vec<i64> = {
        use futures::TryStreamExt;
        let mut cursor = app
            .state
            .collections
            .document_checkpoints()
            .find(bson::doc! { "document_id": &id })
            .sort(bson::doc! { "seq": 1 })
            .await
            .expect("checkpoints");
        let mut seqs = Vec::new();
        while let Some(checkpoint) = cursor.try_next().await.expect("checkpoint") {
            seqs.push(checkpoint.seq);
        }
        seqs
    };
    assert_eq!(checkpoints, vec![1, 4, 7]);

    for (index, text) in texts.iter().enumerate() {
        let seq = index as i64 + 1;
        let at = app.get(&format!("/api/documents/{id}/text?at={seq}")).await;
        at.expect_status(StatusCode::OK);
        assert_eq!(at.json()["content"], json!(text), "text at seq {seq}");
    }

    let snapshots = app.get(&format!("/api/documents/{id}/snapshots")).await.json();
    assert_eq!(snapshots, json!([]), "edits take no automatic snapshots");

    app.cleanup().await;
}
