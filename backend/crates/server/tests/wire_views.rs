//! The wire shape of every view, with no database in the picture.
//!
//! The M1 carry-over these pin: views serialized `bson::DateTime`, which
//! `serde_json` renders as MongoDB extended JSON (`{"$date": {"$numberLong":
//! "…"}}`). Clients — the PWA, the Flutter shell, scripts, the convergence
//! harness — would each have had to special-case it, and PROTOCOL.md §2.1 forbids
//! it outright. `domain::Timestamp` is the fix; these tests are what keeps a
//! future field from quietly reintroducing the old shape.
//!
//! They need no `MONGO_URI`, so they run in a clean checkout.

use bson::spec::BinarySubtype;
use bson::{Binary, DateTime as BsonDateTime, doc};
use ddd_server::domain::{
    Attachment, AttachmentView, Document, DocumentRow, DocumentView, Timestamp, User, UserView,
    materialized_to_json, new_id,
};
use ddd_server::routes::documents::SnapshotView;
use serde_json::{Value as Json, json};

/// Millis chosen so the RFC 3339 rendering is unambiguous.
const AT_MILLIS: i64 = 1_774_000_000_123;
const AT_RFC3339: &str = "2026-03-20T09:46:40.123Z";

fn binary(bytes: Vec<u8>) -> Binary {
    Binary {
        subtype: BinarySubtype::Generic,
        bytes,
    }
}

fn stored_document() -> Document {
    Document {
        id: new_id(),
        crdt: binary(vec![1, 2, 3]),
        state_vector: binary(vec![4, 5]),
        content: "---\ntitle: Wire\n---\n\nbody\n".to_string(),
        title: "Wire".to_string(),
        fm: doc! {
            "title": "Wire",
            "priority": 3_i64,
            "ratio": 1.5_f64,
            "flag": true,
            "note": bson::Bson::Null,
            "tags": ["a", "b"],
            "nested": { "deep": "value" },
            "due": "2026-07-01",
        },
        plugins: doc! { "calendar": { "uid": "wire-1", "start": "2026-05-01" } },
        materialized_version: "abc123".to_string(),
        fm_parse_error: false,
        created_at: BsonDateTime::from_millis(AT_MILLIS),
        created_by: Some("system".to_string()),
        updated_at: BsonDateTime::from_millis(AT_MILLIS),
        updated_by: Some("system".to_string()),
        deleted_at: None,
        deleted_by: None,
        feed_seq: Some(7),
    }
}

/// Recursively assert no extended-JSON marker survives anywhere in a response.
fn assert_plain(value: &Json, path: &str) {
    match value {
        Json::Object(map) => {
            for key in map.keys() {
                assert!(
                    !key.starts_with('$'),
                    "extended JSON key `{key}` at {path}: {value}"
                );
            }
            for (key, child) in map {
                assert_plain(child, &format!("{path}.{key}"));
            }
        }
        Json::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                assert_plain(child, &format!("{path}[{index}]"));
            }
        }
        _ => {}
    }
}

#[test]
fn timestamps_serialize_as_rfc3339_strings() {
    let timestamp = Timestamp::from_millis(AT_MILLIS);
    assert_eq!(
        serde_json::to_value(timestamp).unwrap(),
        json!(AT_RFC3339),
        "a Timestamp is a string on the wire, not a {{$date}} object"
    );
    // And it round-trips, which is what lets a client (or the harness) deserialize
    // a view it was handed.
    let back: Timestamp = serde_json::from_value(json!(AT_RFC3339)).unwrap();
    assert_eq!(back.timestamp_millis(), AT_MILLIS);
    assert_eq!(back, timestamp);
}

#[test]
fn document_view_is_plain_json_throughout() {
    let stored = stored_document();
    let view = DocumentView::from(stored.clone());
    let json = serde_json::to_value(&view).unwrap();
    assert_plain(&json, "DocumentView");

    assert_eq!(json["created_at"], json!(AT_RFC3339));
    assert_eq!(json["updated_at"], json!(AT_RFC3339));
    assert_eq!(json["id"], json!(stored.id));
    assert_eq!(json["deleted"], json!(false));

    // `fm`/`plugins` carry the shared core's value model as native JSON types.
    assert_eq!(json["fm"]["priority"], json!(3));
    assert_eq!(json["fm"]["ratio"], json!(1.5));
    assert_eq!(json["fm"]["flag"], json!(true));
    assert!(json["fm"]["note"].is_null());
    assert_eq!(json["fm"]["tags"], json!(["a", "b"]));
    assert_eq!(json["fm"]["nested"]["deep"], json!("value"));
    assert_eq!(json["plugins"]["calendar"]["uid"], json!("wire-1"));

    // No CRDT bytes on the wire: the view has no such fields (that is the type's
    // job), and a base64 blob would double the size of every list response.
    assert!(json.get("crdt").is_none());
    assert!(json.get("state_vector").is_none());

    // A tombstoned row reports both the flag and the RFC 3339 instant.
    let mut trashed = stored_document();
    trashed.deleted_at = Some(BsonDateTime::from_millis(AT_MILLIS));
    trashed.deleted_by = Some("system".to_string());
    let json = serde_json::to_value(DocumentView::from(trashed)).unwrap();
    assert_plain(&json, "DocumentView(trashed)");
    assert_eq!(json["deleted"], json!(true));
    assert_eq!(json["deleted_at"], json!(AT_RFC3339));
}

/// A live row and a `DocumentRow` from the list path must produce the *same* view,
/// or `GET /api/documents/:id` and `GET /api/documents` would disagree about the
/// same document.
#[test]
fn document_row_and_document_agree_on_the_view() {
    let stored = stored_document();
    let from_document = serde_json::to_value(DocumentView::from(stored.clone())).unwrap();
    let from_row = serde_json::to_value(DocumentView::from(DocumentRow::from(stored))).unwrap();
    assert_eq!(from_document, from_row);
}

/// The view is also what the tests (and the convergence harness) deserialize, so
/// the round trip has to hold.
#[test]
fn document_view_round_trips() {
    let view = DocumentView::from(stored_document());
    let json = serde_json::to_value(&view).unwrap();
    let back: DocumentView = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(serde_json::to_value(back).unwrap(), json);
}

#[test]
fn attachment_view_is_plain_json() {
    let attachment = Attachment {
        id: new_id(),
        name: "photo.png".to_string(),
        mime: "image/png".to_string(),
        size: 1234,
        sha256: "deadbeef".to_string(),
        revision: 2,
        gridfs_id: bson::Bson::ObjectId(bson::oid::ObjectId::new()),
        created_at: BsonDateTime::from_millis(AT_MILLIS),
        created_by: Some("system".to_string()),
        updated_at: BsonDateTime::from_millis(AT_MILLIS),
        updated_by: Some("system".to_string()),
        deleted_at: Some(BsonDateTime::from_millis(AT_MILLIS)),
        deleted_by: Some("system".to_string()),
    };
    let json = serde_json::to_value(AttachmentView::from(attachment)).unwrap();
    assert_plain(&json, "AttachmentView");
    assert_eq!(json["created_at"], json!(AT_RFC3339));
    assert_eq!(json["updated_at"], json!(AT_RFC3339));
    assert_eq!(json["revision"], json!(2));
    // The GridFS handle is storage detail and the tombstone is not a client's
    // business: neither is on the wire.
    assert!(json.get("gridfs_id").is_none());
    assert!(json.get("deleted_at").is_none());
}

#[test]
fn user_view_is_plain_json_and_hides_the_password_hash() {
    let user = User {
        id: new_id(),
        email: "someone@example.com".to_string(),
        name: "Someone".to_string(),
        password_hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA".to_string(),
        is_admin: true,
        is_active: true,
        created_at: BsonDateTime::from_millis(AT_MILLIS),
        updated_at: BsonDateTime::from_millis(AT_MILLIS),
        last_login_at: Some(BsonDateTime::from_millis(AT_MILLIS)),
        invited_by: None,
    };
    let json = serde_json::to_value(UserView::from(user)).unwrap();
    assert_plain(&json, "UserView");
    assert_eq!(json["created_at"], json!(AT_RFC3339));
    assert_eq!(json["last_login_at"], json!(AT_RFC3339));
    assert!(json.get("password_hash").is_none());
}

#[test]
fn snapshot_view_is_plain_json() {
    let view = SnapshotView {
        id: new_id(),
        document_id: new_id(),
        title: "Wire".to_string(),
        reason: "manual".to_string(),
        created_at: Timestamp::from_millis(AT_MILLIS),
        created_by: Some("system".to_string()),
        size: 42,
    };
    let json = serde_json::to_value(&view).unwrap();
    assert_plain(&json, "SnapshotView");
    assert_eq!(json["created_at"], json!(AT_RFC3339));
}

/// `materialized_to_json` is the bridge every view uses for `fm`/`plugins`. A
/// stray BSON type that somehow reached a stored row must degrade to something
/// printable rather than leak extended JSON.
#[test]
fn materialized_bridge_degrades_unexpected_bson() {
    let json = materialized_to_json(&doc! {
        "when": BsonDateTime::from_millis(AT_MILLIS),
        "blob": binary(vec![1, 2, 3]),
        "oid": bson::Bson::ObjectId(bson::oid::ObjectId::new()),
        "ok": "plain",
    });
    assert_plain(&json, "materialized_to_json");
    assert_eq!(json["ok"], json!("plain"));
}
