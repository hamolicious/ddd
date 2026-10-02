//! The admin duplicate views over the router: files with the same name and bytes
//! (`/api/attachments/duplicates`) and live documents with the same title and text
//! (`/api/documents/duplicates`), each copy with its reference count.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::TestApp;
use serde_json::json;

async fn upload(app: &TestApp, name: &str, bytes: &[u8]) -> String {
    let created = app
        .post_json("/api/uploads", json!({ "name": name, "size": bytes.len() }))
        .await;
    created.expect_status(StatusCode::CREATED);
    let id = created.json()["id"].as_str().expect("an id").to_string();
    let request = Request::builder()
        .method("PATCH")
        .uri(format!("/api/uploads/{id}?offset=0"))
        .header(header::AUTHORIZATION, format!("Bearer {}", app.token))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(bytes.to_vec()))
        .expect("valid request");
    app.send(request).await.expect_status(StatusCode::OK);
    let done = app
        .post_json(&format!("/api/uploads/{id}/complete"), json!({}))
        .await;
    done.expect_status(StatusCode::CREATED);
    done.json()["attachment"]["id"]
        .as_str()
        .expect("attachment id")
        .to_string()
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn same_name_and_bytes_are_one_group_with_reference_counts() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let first = upload(&app, "notes.txt", b"the same bytes").await;
    let second = upload(&app, "notes.txt", b"the same bytes").await;
    upload(&app, "notes.txt", b"other bytes").await;
    upload(&app, "renamed.txt", b"the same bytes").await;
    app.create_document(&format!("# Uses it\n\n![](attachment://{second})\n"))
        .await;

    let response = app.get("/api/attachments/duplicates").await;
    response.expect_status(StatusCode::OK);
    let groups = response.json();
    let groups = groups.as_array().expect("a list");
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0]["name"], "notes.txt");
    let files = groups[0]["files"].as_array().expect("files");
    let ids: Vec<&str> = files
        .iter()
        .map(|file| file["attachment"]["id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, [first.as_str(), second.as_str()], "oldest first");
    assert_eq!(files[0]["references"], 0);
    assert_eq!(files[1]["references"], 1);

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn same_title_and_text_are_duplicate_documents_outside_the_trash() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let text = "# Plan\n\nThe same steps.\n";
    let first = app.create_document(text).await;
    let second = app.create_document(text).await;
    let trashed = app.create_document(text).await;
    app.create_document("# Plan\n\nOther steps.\n").await;
    app.create_document(&format!(
        "# Index\n\n[plan](doc://{second}) [again](doc://{second})\n"
    ))
    .await;
    app.delete(&format!("/api/documents/{trashed}")).await;

    let response = app.get("/api/documents/duplicates").await;
    response.expect_status(StatusCode::OK);
    let groups = response.json();
    let groups = groups.as_array().expect("a list");
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0]["title"], "Plan");
    let documents = groups[0]["documents"].as_array().expect("documents");
    let ids: Vec<&str> = documents
        .iter()
        .map(|document| document["id"].as_str().expect("id"))
        .collect();
    assert_eq!(
        ids,
        [first.as_str(), second.as_str()],
        "the trashed copy is not listed"
    );
    assert_eq!(documents[0]["references"], 0);
    assert_eq!(documents[1]["references"], 1, "a document counts once");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn the_duplicate_views_are_for_admins_only() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    for uri in ["/api/attachments/duplicates", "/api/documents/duplicates"] {
        let response = app.anonymous("GET", uri, None).await;
        assert!(
            response.status == StatusCode::UNAUTHORIZED || response.status == StatusCode::FORBIDDEN,
            "{uri}: {}",
            response.status
        );
    }
    app.cleanup().await;
}
