mod common;

use axum::http::StatusCode;
use common::TestApp;
use ddd_server::domain::Actor;
use serde_json::json;

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn changes_are_recorded_grouped_shown_and_reverted() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document("# Notes\n\nfirst line\n").await;

    app.put_json(
        &format!("/api/documents/{id}"),
        json!({ "content": "# Notes\n\nfirst line\nsecond line\n" }),
    )
    .await
    .expect_status(StatusCode::OK);
    app.put_json(
        &format!("/api/documents/{id}"),
        json!({ "content": "# Notes\n\nfirst line, edited\nsecond line\n" }),
    )
    .await
    .expect_status(StatusCode::OK);

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

    let (from, to) = (
        groups[1]["from_seq"].as_i64().unwrap(),
        groups[1]["to_seq"].as_i64().unwrap(),
    );
    let detail = app
        .get(&format!("/api/documents/{id}/changes/{from}/{to}"))
        .await;
    detail.expect_status(StatusCode::OK);
    let hunks = detail.json()["hunks"].clone();
    assert_eq!(hunks[0]["removed"], json!("first line\n"));
    assert_eq!(
        hunks[0]["inserted"],
        json!("first line, edited\nsecond line\n")
    );

    let reverted = app
        .post_json(
            &format!("/api/documents/{id}/changes/{from}/{to}/revert"),
            json!({}),
        )
        .await;
    reverted.expect_status(StatusCode::OK);
    assert_eq!(
        reverted.json()["content"],
        json!("# Notes\n\nfirst line\n\nby a plugin\n")
    );

    let after = app
        .get(&format!("/api/documents/{id}/changes"))
        .await
        .json();
    assert_eq!(
        after["groups"][0]["reverts"],
        json!({ "from_seq": from, "to_seq": to })
    );

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_revert_is_refused_when_a_later_change_touched_the_same_text() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document("a\nb\nc\n").await;
    app.put_json(
        &format!("/api/documents/{id}"),
        json!({ "content": "a\nB\nc\n" }),
    )
    .await
    .expect_status(StatusCode::OK);
    app.state
        .docs
        .replace_text(&id, "a\nBB\nc\n", &Actor::Plugin("helper".into()))
        .await
        .expect("plugin write");

    let groups = app
        .get(&format!("/api/documents/{id}/changes"))
        .await
        .json()["groups"]
        .clone();
    let (from, to) = (
        groups[1]["from_seq"].as_i64().unwrap(),
        groups[1]["to_seq"].as_i64().unwrap(),
    );
    let refused = app
        .post_json(
            &format!("/api/documents/{id}/changes/{from}/{to}/revert"),
            json!({}),
        )
        .await;
    refused.expect_status(StatusCode::CONFLICT);
    assert!(
        refused
            .text()
            .contains("plugin helper changed the same text later"),
        "{}",
        refused.text()
    );
    assert_eq!(
        app.get(&format!("/api/documents/{id}")).await.json()["content"],
        json!("a\nBB\nc\n")
    );

    app.cleanup().await;
}

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

    let snapshots = app
        .get(&format!("/api/documents/{id}/snapshots"))
        .await
        .json();
    assert_eq!(snapshots, json!([]), "edits take no automatic snapshots");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn old_history_squashes_and_can_be_forgotten() {
    use futures::TryStreamExt;
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document("one\n").await;
    let put = |content: &'static str| {
        let uri = format!("/api/documents/{id}");
        let app = &app;
        async move {
            app.put_json(&uri, json!({ "content": content }))
                .await
                .expect_status(StatusCode::OK);
        }
    };
    put("one\ntwo\n").await;
    put("one\ntwo\nthree\n").await;
    put("ONE\ntwo\nthree\n").await;
    app.state
        .docs
        .replace_text(
            &id,
            "ONE\ntwo\nthree\nfrom a plugin\n",
            &Actor::Plugin("helper".into()),
        )
        .await
        .expect("plugin write");
    put("ONE\ntwo\nthree\nfrom a plugin\nfour\n").await;
    put("ONE\n2\nthree\nfrom a plugin\nfour\n").await;

    let before = app
        .get(&format!("/api/documents/{id}/changes"))
        .await
        .json();
    let edges: Vec<(i64, i64)> = before["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|group| {
            (
                group["from_seq"].as_i64().unwrap(),
                group["to_seq"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(edges, vec![(6, 7), (5, 5), (2, 4)]);

    app.state
        .collections
        .document_changes()
        .update_many(
            bson::doc! { "document_id": &id },
            bson::doc! { "$set": { "created_at": bson::DateTime::from_millis(bson::DateTime::now().timestamp_millis() - 40 * 86_400_000) } },
        )
        .await
        .expect("age changes");
    let written = app.state.docs.squash_history_now().await.expect("squash");
    assert_eq!(written, 3);
    let raw_left = app
        .state
        .collections
        .document_changes()
        .count_documents(bson::doc! { "document_id": &id })
        .await
        .unwrap();
    assert_eq!(raw_left, 0, "squashed raw changes are deleted");
    assert_eq!(
        app.state
            .docs
            .squash_history_now()
            .await
            .expect("squash again"),
        0
    );

    let after = app
        .get(&format!("/api/documents/{id}/changes"))
        .await
        .json();
    let groups = after["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 3);
    assert!(groups.iter().all(|group| group["squashed"] == json!(true)));
    assert_eq!(groups[2]["changes"], json!(3));

    assert_eq!(
        text_at(&app, &id, 1).await.json()["content"],
        json!("one\n")
    );
    assert_eq!(
        text_at(&app, &id, 4).await.json()["content"],
        json!("ONE\ntwo\nthree\n")
    );
    assert_eq!(
        text_at(&app, &id, 7).await.json()["content"],
        json!("ONE\n2\nthree\nfrom a plugin\nfour\n")
    );
    text_at(&app, &id, 3)
        .await
        .expect_status(StatusCode::CONFLICT);
    let mut cursor = app
        .state
        .collections
        .document_checkpoints()
        .find(bson::doc! { "document_id": &id })
        .await
        .unwrap();
    let mut seqs = Vec::new();
    while let Some(checkpoint) = cursor.try_next().await.unwrap() {
        seqs.push(checkpoint.seq);
    }
    for seq in &seqs {
        assert!(
            ![2, 3, 6].contains(seq),
            "checkpoint {seq} is inside a squashed group ({seqs:?})"
        );
    }

    let diff = app
        .get(&format!("/api/documents/{id}/changes/2/4"))
        .await
        .json();
    assert_eq!(diff["changes"], json!(3));
    app.post_json(
        &format!("/api/documents/{id}/changes/5/5/revert"),
        json!({}),
    )
    .await
    .expect_status(StatusCode::OK);
    assert_eq!(
        app.get(&format!("/api/documents/{id}")).await.json()["content"],
        json!("ONE\n2\nthree\nfour\n")
    );

    app.post_json(&format!("/api/documents/{id}/history/forget"), json!({}))
        .await
        .expect_status(StatusCode::NO_CONTENT);
    let forgotten = app
        .get(&format!("/api/documents/{id}/changes"))
        .await
        .json();
    assert_eq!(forgotten["groups"], json!([]));
    assert_eq!(
        app.get(&format!("/api/documents/{id}/snapshots"))
            .await
            .json(),
        json!([])
    );
    put("ONE\n2\nthree\nfour\nfive\n").await;
    let fresh = app
        .get(&format!("/api/documents/{id}/changes"))
        .await
        .json();
    let (from, to) = (
        fresh["groups"][0]["from_seq"].as_i64().unwrap(),
        fresh["groups"][0]["to_seq"].as_i64().unwrap(),
    );
    let diff = app
        .get(&format!("/api/documents/{id}/changes/{from}/{to}"))
        .await;
    diff.expect_status(StatusCode::OK);
    assert_eq!(diff.json()["hunks"][0]["inserted"], json!("five\n"));

    app.cleanup().await;
}

async fn text_at(app: &TestApp, id: &str, seq: i64) -> common::ApiResponse {
    app.get(&format!("/api/documents/{id}/text?at={seq}")).await
}
