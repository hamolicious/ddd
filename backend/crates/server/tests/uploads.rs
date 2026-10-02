mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use bson::doc;
use common::{ApiResponse, TestApp};
use ddd_server::db::{GRIDFS_CHUNK_BYTES, GRIDFS_CHUNKS, UPLOADS};
use ddd_server::routes::uploads;
use serde_json::json;
use sha2::{Digest as _, Sha256};

const GRIDFS: usize = GRIDFS_CHUNK_BYTES as usize;

fn png_bytes() -> Vec<u8> {
    let mut bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    bytes.extend((0..GRIDFS * 2 + 1000).map(|i| (i % 251) as u8));
    bytes
}

async fn patch(app: &TestApp, id: &str, offset: usize, bytes: &[u8]) -> ApiResponse {
    let request = Request::builder()
        .method("PATCH")
        .uri(format!("/api/uploads/{id}?offset={offset}"))
        .header(header::AUTHORIZATION, format!("Bearer {}", app.token))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(bytes.to_vec()))
        .expect("valid request");
    app.send(request).await
}

async fn open(app: &TestApp, name: &str, size: usize) -> String {
    let created = app
        .post_json("/api/uploads", json!({ "name": name, "size": size }))
        .await;
    created.expect_status(StatusCode::CREATED);
    let body = created.json();
    assert_eq!(body["offset"], 0);
    assert_eq!(body["size"], size);
    body["id"].as_str().expect("an id").to_string()
}

async fn chunk_count(app: &TestApp) -> u64 {
    app.state
        .collections
        .raw(GRIDFS_CHUNKS)
        .count_documents(doc! {})
        .await
        .expect("count")
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_file_sent_in_chunks_becomes_an_attachment() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let bytes = png_bytes();
    let id = open(&app, "../holiday.png", bytes.len()).await;

    let first = GRIDFS * 2;
    patch(&app, &id, 0, &bytes[..first])
        .await
        .expect_status(StatusCode::OK);

    let again = patch(&app, &id, 0, &bytes[..first]).await;
    again.expect_status(StatusCode::CONFLICT);
    let status = app.get(&format!("/api/uploads/{id}")).await;
    status.expect_status(StatusCode::OK);
    assert_eq!(status.json()["offset"], first);

    app.post_json(&format!("/api/uploads/{id}/complete"), json!({}))
        .await
        .expect_status(StatusCode::CONFLICT);

    patch(&app, &id, first, &bytes[first..])
        .await
        .expect_status(StatusCode::OK);

    let done = app
        .post_json(&format!("/api/uploads/{id}/complete"), json!({}))
        .await;
    done.expect_status(StatusCode::CREATED);
    let body = done.json();
    let attachment = &body["attachment"];
    assert_eq!(attachment["name"], "holiday.png", "the name is sanitized");
    assert_eq!(attachment["mime"], "image/png", "the type is sniffed");
    assert_eq!(attachment["size"], bytes.len());
    assert_eq!(attachment["sha256"], hex::encode(Sha256::digest(&bytes)));
    let attachment_id = attachment["id"].as_str().expect("id").to_string();
    assert_eq!(body["reference"], format!("attachment://{attachment_id}"));

    let download = app.get(&format!("/api/attachments/{attachment_id}")).await;
    download.expect_status(StatusCode::OK);
    assert_eq!(download.body.as_ref(), bytes.as_slice());

    let repeat = app
        .post_json(&format!("/api/uploads/{id}/complete"), json!({}))
        .await;
    repeat.expect_status(StatusCode::CREATED);
    assert_eq!(repeat.json()["attachment"]["id"], attachment_id.as_str());

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_lost_chunk_rewinds_the_upload_to_it() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let bytes = png_bytes();
    let id = open(&app, "lost.png", bytes.len()).await;
    patch(&app, &id, 0, &bytes[..GRIDFS * 2])
        .await
        .expect_status(StatusCode::OK);
    patch(&app, &id, GRIDFS * 2, &bytes[GRIDFS * 2..])
        .await
        .expect_status(StatusCode::OK);

    app.state
        .collections
        .raw(GRIDFS_CHUNKS)
        .delete_one(doc! { "n": 1 })
        .await
        .expect("delete a chunk");

    app.post_json(&format!("/api/uploads/{id}/complete"), json!({}))
        .await
        .expect_status(StatusCode::CONFLICT);
    let status = app.get(&format!("/api/uploads/{id}")).await;
    assert_eq!(status.json()["offset"], GRIDFS, "back to the missing chunk");

    patch(&app, &id, GRIDFS, &bytes[GRIDFS..])
        .await
        .expect_status(StatusCode::OK);
    let done = app
        .post_json(&format!("/api/uploads/{id}/complete"), json!({}))
        .await;
    done.expect_status(StatusCode::CREATED);
    assert_eq!(
        done.json()["attachment"]["sha256"],
        hex::encode(Sha256::digest(&bytes))
    );

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn chunks_must_fit_the_declared_size_and_the_grid() {
    let Some(app) = TestApp::start().await else {
        return;
    };

    let too_big = app
        .post_json(
            "/api/uploads",
            json!({ "name": "big.bin", "size": 2 * 1024 * 1024 }),
        )
        .await;
    too_big.expect_status(StatusCode::PAYLOAD_TOO_LARGE);
    app.post_json("/api/uploads", json!({ "name": "empty.bin", "size": 0 }))
        .await
        .expect_status(StatusCode::BAD_REQUEST);

    let bytes = png_bytes();
    let id = open(&app, "grid.png", bytes.len()).await;
    patch(&app, &id, 0, &bytes[..GRIDFS + 1])
        .await
        .expect_status(StatusCode::BAD_REQUEST);
    let mut longer = bytes.clone();
    longer.push(0);
    patch(&app, &id, 0, &longer)
        .await
        .expect_status(StatusCode::BAD_REQUEST);
    patch(&app, &id, 0, &[])
        .await
        .expect_status(StatusCode::BAD_REQUEST);
    patch(&app, &id, 0, &bytes)
        .await
        .expect_status(StatusCode::OK);

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn cancelled_and_abandoned_uploads_leave_no_chunks() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let bytes = png_bytes();

    let cancelled = open(&app, "cancel.png", bytes.len()).await;
    patch(&app, &cancelled, 0, &bytes[..GRIDFS])
        .await
        .expect_status(StatusCode::OK);
    assert_eq!(chunk_count(&app).await, 1);
    app.delete(&format!("/api/uploads/{cancelled}"))
        .await
        .expect_status(StatusCode::NO_CONTENT);
    assert_eq!(chunk_count(&app).await, 0);
    app.get(&format!("/api/uploads/{cancelled}"))
        .await
        .expect_status(StatusCode::NOT_FOUND);

    let abandoned = open(&app, "abandoned.png", bytes.len()).await;
    patch(&app, &abandoned, 0, &bytes[..GRIDFS * 2])
        .await
        .expect_status(StatusCode::OK);
    let kept = open(&app, "kept.png", bytes.len()).await;
    patch(&app, &kept, 0, &bytes)
        .await
        .expect_status(StatusCode::OK);
    app.post_json(&format!("/api/uploads/{kept}/complete"), json!({}))
        .await
        .expect_status(StatusCode::CREATED);
    assert_eq!(chunk_count(&app).await, 5);

    uploads::sweep_expired(&app.state).await;
    assert_eq!(chunk_count(&app).await, 5, "nothing has expired yet");

    app.state
        .collections
        .raw(UPLOADS)
        .update_many(
            doc! {},
            doc! { "$set": { "expires_at": bson::DateTime::from_millis(0) } },
        )
        .await
        .expect("expire");
    uploads::sweep_expired(&app.state).await;
    assert_eq!(
        chunk_count(&app).await,
        3,
        "only the attachment's chunks stay"
    );
    app.get(&format!("/api/uploads/{abandoned}"))
        .await
        .expect_status(StatusCode::NOT_FOUND);

    app.cleanup().await;
}
