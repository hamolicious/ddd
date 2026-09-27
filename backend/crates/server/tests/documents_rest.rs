//! `/api/documents` — the write and read rules of SPEC §5.1 over the router:
//! create/409/410, `PATCH` being body-text-level **only**, the Trash partitions,
//! the document-size cap, snapshots, and the wire format.
//!
//! These are the rules a client depends on and that the M1 suite could only
//! assert on pure helpers: `PatchRequest::validate` was unit-tested, but nothing
//! proved the handler calls it, or that a rejected patch is a 400 with the
//! standard envelope rather than a 422 from axum's extractor.

mod common;

use axum::http::{StatusCode, header};
use common::{TEST_PASSWORD, TestApp, assert_no_extended_json, assert_rfc3339};
use life_manager_server::domain::{Actor, new_id};
use serde_json::json;

const ALPHA: &str =
    "---\ntitle: Alpha\nstatus: open\npriority: 1\ntags: [work]\n---\n\nalpha body\n";

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/// The id is client-mintable (offline creates); a second create of a live id is a
/// 409 and of a purged id a 410 (SPEC §5.1, §3.5).
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn create_is_idempotent_by_id_and_honours_the_graveyard() {
    let Some(app) = TestApp::start().await else {
        return;
    };

    let id = new_id();
    let created = app
        .post_json("/api/documents", json!({ "id": id, "content": ALPHA }))
        .await;
    created.expect_status(StatusCode::CREATED);
    assert_eq!(
        created
            .headers
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok()),
        Some(format!("/api/documents/{id}").as_str()),
        "a create must say where the document now lives"
    );
    assert_eq!(created.json()["id"], json!(id));

    let again = app
        .post_json(
            "/api/documents",
            json!({ "id": id, "content": "different" }),
        )
        .await;
    again.expect_status(StatusCode::CONFLICT);
    assert_eq!(again.error_code(), "conflict");

    let bad = app
        .post_json(
            "/api/documents",
            json!({ "id": "not-a-ulid", "content": "x" }),
        )
        .await;
    bad.expect_status(StatusCode::BAD_REQUEST);

    // Purge is not a REST verb (it is the Trash retention worker's job), so the
    // graveyard is reached through the store — the point under test is that the
    // *create route* consults it.
    app.state
        .docs
        .tombstone(&id, &Actor::System)
        .await
        .expect("tombstone");
    app.state
        .docs
        .purge(&id, &Actor::System)
        .await
        .expect("purge");

    let resurrected = app
        .post_json("/api/documents", json!({ "id": id, "content": ALPHA }))
        .await;
    resurrected.expect_status(StatusCode::GONE);
    assert_eq!(resurrected.error_code(), "gone");

    app.cleanup().await;
}

/// The configured `MAX_DOCUMENT_BYTES` is the limit that is actually enforced —
/// the harness sets 64 KiB, well under the shared core's 1 MiB ceiling, so a
/// handler that used the constant instead of the config would accept this.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn the_configured_document_cap_is_enforced() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let limit = app.state.config().max_document_bytes;
    assert_eq!(
        limit,
        64 * 1024,
        "the harness config sets a non-default cap"
    );

    let oversized = "x".repeat(limit + 1);
    let response = app
        .post_json("/api/documents", json!({ "content": oversized }))
        .await;
    response.expect_status(StatusCode::PAYLOAD_TOO_LARGE);
    let detail = response.json()["error"]["detail"].clone();
    assert_eq!(detail["limit"], json!(limit));

    // One byte under is fine.
    let ok = app
        .post_json("/api/documents", json!({ "content": "x".repeat(limit) }))
        .await;
    ok.expect_status(StatusCode::CREATED);

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

/// `PATCH` is body-text-level only. `fm` and `plugins` are *materialized* — they
/// are written by editing the text, never as fields (SPEC §3.3, §5.1) — and an
/// attempt must fail loudly rather than silently do nothing.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn patch_replaces_content_and_refuses_everything_else() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document(ALPHA).await;
    let before = app.get(&format!("/api/documents/{id}")).await.json();

    // The legitimate path: new text, and `fm`/`title` follow from it.
    let patched = app
        .patch_json(
            &format!("/api/documents/{id}"),
            json!({ "content": "---\ntitle: Renamed\nstatus: done\n---\n\nnew body\n" }),
        )
        .await;
    patched.expect_status(StatusCode::OK);
    let view = patched.json();
    assert_eq!(view["title"], json!("Renamed"));
    assert_eq!(view["fm"]["status"], json!("done"));
    assert!(view["content"].as_str().unwrap().contains("new body"));
    assert_ne!(
        view["materialized_version"], before["materialized_version"],
        "a text change must re-materialize"
    );
    assert_eq!(view["id"], before["id"], "PATCH never re-ids a document");

    // Every other field is refused — including the ones that look harmless.
    for body in [
        json!({ "content": "x", "fm": { "title": "sneaky" } }),
        json!({ "content": "x", "plugins": { "calendar": { "uid": "1" } } }),
        json!({ "content": "x", "title": "sneaky" }),
        json!({ "content": "x", "deleted_at": null }),
        json!({ "content": "x", "materialized_version": "forged" }),
    ] {
        let response = app
            .patch_json(&format!("/api/documents/{id}"), body.clone())
            .await;
        response.expect_status(StatusCode::BAD_REQUEST);
        assert_eq!(response.error_code(), "bad_request", "{body}");
    }

    // The refusals changed nothing.
    let after = app.get(&format!("/api/documents/{id}")).await.json();
    assert_eq!(after["content"], view["content"]);
    assert_eq!(after["title"], json!("Renamed"));

    // Addressing rules are the same on every document route.
    app.patch_json("/api/documents/not-a-ulid", json!({ "content": "x" }))
        .await
        .expect_status(StatusCode::BAD_REQUEST);
    app.patch_json(
        &format!("/api/documents/{}", new_id()),
        json!({ "content": "x" }),
    )
    .await
    .expect_status(StatusCode::NOT_FOUND);

    app.cleanup().await;
}

/// `PUT` is the same text-level replace with a body the client is allowed to send
/// wholesale, and it must agree with `PATCH` on the resulting document.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn put_replaces_the_full_text() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document(ALPHA).await;

    let replaced = app
        .put_json(
            &format!("/api/documents/{id}"),
            json!({ "content": "# Plain\n\nno frontmatter now\n" }),
        )
        .await;
    replaced.expect_status(StatusCode::OK);
    let view = replaced.json();
    assert_eq!(
        view["title"],
        json!("Plain"),
        "title falls back to the heading"
    );
    assert_eq!(
        view["fm"],
        json!({}),
        "removing the frontmatter empties the materialized map"
    );

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/// `trash=live|trashed|all` partition the workspace, and the Trash view is just a
/// listing — a tombstoned document is still a document (SPEC §3.5).
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn trash_filters_partition_the_workspace() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let live_a = app
        .create_document("---\ntitle: Live A\ntags: [keep]\n---\n\na\n")
        .await;
    let live_b = app.create_document("---\ntitle: Live B\n---\n\nb\n").await;
    let doomed = app
        .create_document("---\ntitle: Doomed\ntags: [keep]\n---\n\nc\n")
        .await;

    app.delete(&format!("/api/documents/{doomed}"))
        .await
        .expect_status(StatusCode::NO_CONTENT);

    let live = app.list("sort=title&limit=100").await;
    assert_eq!(live.ids(), vec![live_a.clone(), live_b.clone()]);
    let live_explicit = app.list("trash=live&sort=title&limit=100").await;
    assert_eq!(
        live_explicit.ids(),
        live.ids(),
        "no `trash` parameter means `live`"
    );

    let trashed = app.list("trash=trashed&limit=100").await;
    assert_eq!(trashed.ids(), vec![doomed.clone()]);
    let row = &trashed.documents[0];
    assert!(row.deleted, "the Trash view must say a row is deleted");
    let raw = trashed.raw.clone();
    assert_no_extended_json(&raw, "GET /api/documents?trash=trashed");
    let json: serde_json::Value = serde_json::from_str(&raw).expect("the Trash listing is JSON");
    assert_rfc3339(&json["documents"][0]["deleted_at"], "deleted_at");
    assert_eq!(
        json["documents"][0]["deleted_by"],
        json!(app.user_id),
        "*_by is the last applier the server saw"
    );

    let all = app.list("trash=all&sort=title&limit=100").await;
    assert_eq!(all.documents.len(), 3);

    // Filters compose with the partition rather than replacing it.
    let filter = common::urlencode(r#"{"contains":{"field":"fm.tags","value":{"str":"keep"}}}"#);
    assert_eq!(
        app.list(&format!("filter={filter}&trash=live&limit=100"))
            .await
            .ids(),
        vec![live_a.clone()]
    );
    assert_eq!(
        app.list(&format!("filter={filter}&trash=trashed&limit=100"))
            .await
            .ids(),
        vec![doomed.clone()]
    );
    assert_eq!(
        app.list(&format!("filter={filter}&trash=all&limit=100"))
            .await
            .documents
            .len(),
        2
    );

    // A tombstoned document still reads, and deleting it again is idempotent.
    let fetched = app.get(&format!("/api/documents/{doomed}")).await;
    fetched.expect_status(StatusCode::OK);
    assert_eq!(fetched.json()["deleted"], json!(true));
    app.delete(&format!("/api/documents/{doomed}"))
        .await
        .expect_status(StatusCode::NO_CONTENT);

    // Restore puts it back in the live partition with no tombstone left over.
    let restored = app
        .post_json(&format!("/api/documents/{doomed}/restore"), json!({}))
        .await;
    restored.expect_status(StatusCode::OK);
    assert_eq!(restored.json()["deleted"], json!(false));
    assert!(
        restored.json().get("deleted_at").is_none() || restored.json()["deleted_at"].is_null(),
        "a restored document carries no deleted_at"
    );
    assert_eq!(app.list("trash=live&limit=100").await.documents.len(), 3);
    assert_eq!(app.list("trash=trashed&limit=100").await.documents.len(), 0);

    // Both destructive actions are audited (SPEC §5.4).
    for action in ["document.delete", "document.restore"] {
        let entry = app
            .state
            .collections
            .audit_log()
            .find_one(bson::doc! { "action": action, "target_id": &doomed })
            .await
            .expect("audit query")
            .unwrap_or_else(|| panic!("{action} was not audited"));
        assert_eq!(entry.target_kind, "document");
        assert_eq!(entry.actor.as_deref(), Some(app.user_id.as_str()));
    }

    // Addressing rules again.
    app.delete("/api/documents/not-a-ulid")
        .await
        .expect_status(StatusCode::BAD_REQUEST);
    app.delete(&format!("/api/documents/{}", new_id()))
        .await
        .expect_status(StatusCode::NOT_FOUND);

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/// Every timestamp on every response is an RFC 3339 string and `fm`/`plugins` are
/// plain JSON — MongoDB extended JSON never reaches a client (PROTOCOL.md §2.1).
/// This is the M1 carry-over: views used to serialize `bson::DateTime`, which
/// `serde_json` renders as `{"$date": …}`.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn responses_never_carry_extended_json() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app
        .create_document(
            "---\n\
             title: Wire\n\
             priority: 3\n\
             ratio: 1.5\n\
             flag: true\n\
             note: null\n\
             tags: [a, b]\n\
             nested: {}\n\
             due: 2026-07-01\n\
             ---\n\
             \n\
             body\n\
             \n\
             %%% calendar\n\
             uid: wire-1\n\
             %%%\n",
        )
        .await;

    let one = app.get(&format!("/api/documents/{id}")).await;
    one.expect_status(StatusCode::OK);
    assert_no_extended_json(one.text(), "GET /api/documents/:id");
    let view = one.json();
    assert_rfc3339(&view["created_at"], "created_at");
    assert_rfc3339(&view["updated_at"], "updated_at");

    // `fm` carries the shared core's value model as native JSON types, so a client
    // needs no decoding convention at all.
    assert_eq!(view["fm"]["priority"], json!(3));
    assert_eq!(view["fm"]["ratio"], json!(1.5));
    assert_eq!(view["fm"]["flag"], json!(true));
    assert!(view["fm"]["note"].is_null());
    assert_eq!(view["fm"]["tags"], json!(["a", "b"]));
    assert_eq!(view["fm"]["due"], json!("2026-07-01"));
    assert_eq!(view["plugins"]["calendar"]["uid"], json!("wire-1"));
    assert_eq!(view["deleted"], json!(false));

    // The list projection, the create response and the snapshot listing are the
    // other three shapes a client reads.
    let listed = app.list("limit=10").await;
    assert_no_extended_json(&listed.raw, "GET /api/documents");

    let created = app
        .post_json("/api/documents", json!({ "content": "# Fresh\n" }))
        .await;
    assert_no_extended_json(created.text(), "POST /api/documents");
    assert_rfc3339(&created.json()["created_at"], "created_at");

    let snapshot = app
        .post_json(&format!("/api/documents/{id}/snapshots"), json!({}))
        .await;
    snapshot.expect_status(StatusCode::CREATED);
    let snapshots = app.get(&format!("/api/documents/{id}/snapshots")).await;
    snapshots.expect_status(StatusCode::OK);
    assert_no_extended_json(snapshots.text(), "GET /api/documents/:id/snapshots");
    let rows = snapshots.json();
    let first = &rows[0];
    assert_rfc3339(&first["created_at"], "snapshot created_at");
    assert_eq!(first["document_id"], json!(id));

    // `/api/auth/me` and the admin listings are other areas' files, but they read
    // the same `domain` views, so a regression there would show up as extended
    // JSON here too.
    let me = app.get("/api/auth/me").await;
    me.expect_status(StatusCode::OK);
    assert_no_extended_json(me.text(), "GET /api/auth/me");
    let users = app.get("/api/admin/users").await;
    users.expect_status(StatusCode::OK);
    assert_no_extended_json(users.text(), "GET /api/admin/users");

    // The session, invite, audit and orphan shapes: every one of these carried a
    // raw `bson::DateTime` (and the audit listing a whole raw BSON `detail`) until
    // M2. They are in this scan so they cannot regress.
    let login = app
        .anonymous(
            "POST",
            "/api/auth/login",
            Some(json!({
                "email": "first@example.com",
                "password": TEST_PASSWORD,
                "bearer": true,
            })),
        )
        .await;
    login.expect_status(StatusCode::OK);
    assert_no_extended_json(login.text(), "POST /api/auth/login");
    assert_rfc3339(&login.json()["expires_at"], "session expires_at");

    let invite = app
        .post_json("/api/admin/invites", json!({ "email": "next@example.com" }))
        .await;
    assert_no_extended_json(invite.text(), "POST /api/admin/invites");
    let invites = app.get("/api/admin/invites").await;
    invites.expect_status(StatusCode::OK);
    assert_no_extended_json(invites.text(), "GET /api/admin/invites");
    assert_rfc3339(&invites.json()[0]["expires_at"], "invite expires_at");

    let reset = app
        .post_json(
            &format!("/api/admin/users/{}/reset", app.user_id),
            json!({}),
        )
        .await;
    assert_no_extended_json(reset.text(), "POST /api/admin/users/:id/reset");

    // The snapshot above and the tombstone below both wrote audit rows with a
    // non-empty `detail`, which is where the `$`-prefixed keys used to come from.
    app.delete(&format!("/api/documents/{id}")).await;
    let audit = app.get("/api/admin/audit").await;
    audit.expect_status(StatusCode::OK);
    assert_no_extended_json(audit.text(), "GET /api/admin/audit");
    let entries = audit.json();
    let first = entries["entries"]
        .as_array()
        .and_then(|rows| rows.first())
        .expect("the delete above wrote an audit row");
    assert_rfc3339(&first["created_at"], "audit created_at");
    assert!(
        first["detail"].is_object(),
        "audit detail is plain JSON, got {:?}",
        first["detail"]
    );

    let orphans = app.get("/api/attachments/orphans").await;
    orphans.expect_status(StatusCode::OK);
    assert_no_extended_json(orphans.text(), "GET /api/attachments/orphans");

    app.cleanup().await;
}

/// `?format=crdt` is not JSON at all: raw update-encoding-v1 bytes plus the state
/// vector in a header (SPEC §3.2, §5.1).
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn crdt_format_returns_bytes_and_a_state_vector() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document(ALPHA).await;

    let response = app.get(&format!("/api/documents/{id}?format=crdt")).await;
    response.expect_status(StatusCode::OK);
    assert_eq!(
        response
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/octet-stream")
    );
    assert!(
        response.headers.contains_key("x-state-vector"),
        "the state vector travels in a header so a client can ask for a diff"
    );
    assert!(!response.body.is_empty());

    app.get(&format!("/api/documents/{id}?format=yaml"))
        .await
        .expect_status(StatusCode::BAD_REQUEST);

    app.cleanup().await;
}

/// Every document route needs a session; an anonymous request is a 401 and
/// nothing else (SPEC §5.3 — a 401 means "re-authenticate", never "purge").
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn document_routes_require_a_session() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let id = app.create_document(ALPHA).await;

    for uri in [
        "/api/documents".to_string(),
        format!("/api/documents/{id}"),
        format!("/api/documents/{id}/snapshots"),
    ] {
        let response = app.anonymous("GET", &uri, None).await;
        response.expect_status(StatusCode::UNAUTHORIZED);
        assert_eq!(response.error_code(), "unauthorized");
    }
    app.anonymous("POST", "/api/documents", Some(json!({ "content": "x" })))
        .await
        .expect_status(StatusCode::UNAUTHORIZED);
    app.anonymous("DELETE", &format!("/api/documents/{id}"), None)
        .await
        .expect_status(StatusCode::UNAUTHORIZED);
    // A bad token is the same answer as no token.
    app.request_as("GET", "/api/documents", Some("not-a-real-token"), None)
        .await
        .expect_status(StatusCode::UNAUTHORIZED);

    app.cleanup().await;
}

/// A note made offline arrives as the device's own CRDT state, so the device's later
/// edits merge into it instead of repeating the text (PROTOCOL.md §3.8).
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_note_made_offline_is_created_from_the_device_state() {
    use base64::Engine as _;
    use yrs::{ReadTxn, StateVector, Text, Transact};

    let Some(app) = TestApp::start().await else {
        return;
    };
    let device = yrs::Doc::with_client_id(4242);
    let text = device.get_or_insert_text("content");
    text.insert(&mut device.transact_mut(), 0, "# Offline\n\nwritten on the train\n");
    let seed = device.transact().encode_state_as_update_v1(&StateVector::default());
    let encoded = base64::engine::general_purpose::STANDARD.encode(&seed);

    let id = new_id();
    let created = app
        .post_json("/api/documents", json!({ "id": id, "state": encoded }))
        .await;
    created.expect_status(StatusCode::CREATED);
    assert_eq!(created.json()["title"], json!("Offline"));

    // A later offline edit on the device merges: the text is there once.
    let before = device.transact().state_vector();
    text.insert(&mut device.transact_mut(), 32, "and on the platform\n");
    let edit = device.transact().encode_state_as_update_v1(&before);
    app.state.docs.apply_update(&id, &edit, &Actor::System).await.expect("edit");
    // …and the create itself arriving twice (a lost response) changes nothing.
    app.post_json("/api/documents", json!({ "id": id, "state": encoded }))
        .await
        .expect_status(StatusCode::CONFLICT);
    app.state.docs.apply_update(&id, &seed, &Actor::System).await.expect("replay");
    assert_eq!(
        app.state.docs.text(&id).await.expect("text"),
        "# Offline\n\nwritten on the train\nand on the platform\n",
    );

    // Refused: no id, both fields, bytes that are not a document.
    app.post_json("/api/documents", json!({ "state": encoded }))
        .await
        .expect_status(StatusCode::BAD_REQUEST);
    app.post_json("/api/documents", json!({ "id": new_id(), "state": encoded, "content": "x" }))
        .await
        .expect_status(StatusCode::BAD_REQUEST);
    let junk = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
    let refused = app.post_json("/api/documents", json!({ "id": new_id(), "state": junk })).await;
    assert!(refused.status.is_client_error(), "{}", refused.text());

    app.cleanup().await;
}
