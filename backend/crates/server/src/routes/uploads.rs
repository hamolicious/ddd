//! `/api/uploads` — chunked, resumable uploads (SPEC §3.6).
//!
//! The one-request upload (`POST /api/attachments`) starts again from nothing when
//! the connection drops. This one sends a file in chunks, each its own request, so
//! an interrupted upload carries on from the last chunk the server kept — after a
//! reconnect, a reload, or a pause.
//!
//! | Method | Path | Behaviour |
//! |---|---|---|
//! | POST | `/api/uploads` | `{name, size, wrapper?}` → a session: `{id, size, offset, chunk_size}` |
//! | GET | `/api/uploads/:id` | the session, so a client can resume from `offset` |
//! | PATCH | `/api/uploads/:id?offset=n` | the next chunk, raw bytes; `offset` must be where the server is (else 409) |
//! | POST | `/api/uploads/:id/complete` | once `offset == size`: the attachment, answered as `POST /api/attachments` does |
//! | DELETE | `/api/uploads/:id` | cancel; the chunks go |
//!
//! **Where the bytes go.** Straight into the attachments GridFS bucket, as chunks
//! of the file the upload will become: a chunk of the request is cut into GridFS
//! chunks of [`GRIDFS_CHUNK_BYTES`], which is why every chunk but the last must be
//! a whole number of them ([`CHUNK_BYTES`] is). Completing writes the GridFS file
//! record, so the bytes are never copied. A chunk sent twice replaces its own
//! GridFS chunks; completing checks every one is there exactly once before the
//! file exists, and sends the client back to the first missing byte if not.
//!
//! The rules of `/api/attachments` hold: `MAX_ATTACHMENT_BYTES` (checked against
//! the declared size before a byte is sent, `0` is no cap), the MIME type sniffed
//! from the bytes, the SHA-256 computed by the server.
//!
//! A session is its user's only, and is swept with its chunks
//! [`SESSION_IDLE`] after it was last written to ([`sweep_expired`], from the
//! maintenance loop). A completed one stays until then too, so a client whose
//! `complete` answer was lost gets the same answer again.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bson::oid::ObjectId;
use bson::spec::BinarySubtype;
use bson::{Binary, Bson, DateTime as BsonDateTime, doc};
use futures::TryStreamExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::auth::AuthUser;
use crate::db::{GRIDFS_CHUNK_BYTES, GRIDFS_CHUNKS, GRIDFS_FILES};
use crate::domain::{AttachmentView, Id, UploadSession, is_valid_id, new_id};
use crate::error::{AppError, AppResult};
use crate::routes::attachments::{
    StoredBlob, created, record_upload, sanitize_filename, sniff_mime,
};
use crate::state::AppState;
use crate::telemetry::names;

/// The largest chunk a `PATCH` may carry: 16 GridFS chunks, just under 4 MiB.
pub const CHUNK_BYTES: u64 = 16 * GRIDFS_CHUNK_BYTES as u64;

/// How long a session lives after it was last written to.
pub const SESSION_IDLE: Duration = Duration::from_secs(24 * 60 * 60);

/// Bytes kept for MIME sniffing (the same window `/api/attachments` uses).
const SNIFF_BYTES: usize = 512;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", post(create))
        .route("/{id}", get(status).patch(append).delete(cancel))
        .route("/{id}/complete", post(complete))
        // A chunk is buffered whole (it is at most `CHUNK_BYTES`); anything larger
        // is refused before it is read.
        .layer(DefaultBodyLimit::max(CHUNK_BYTES as usize))
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateUpload {
    pub name: String,
    pub size: u64,
    /// Create a wrapper document on completion, as `?wrapper=true` does on
    /// `POST /api/attachments`.
    #[serde(default)]
    pub wrapper: bool,
}

#[derive(Debug, Serialize)]
pub struct UploadView {
    pub id: Id,
    pub name: String,
    pub size: u64,
    /// Bytes the server has; the next `PATCH` starts here.
    pub offset: u64,
    /// The largest chunk to send. Every chunk but the last must be exactly this.
    pub chunk_size: u64,
    /// Set once completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<Id>,
}

impl From<&UploadSession> for UploadView {
    fn from(session: &UploadSession) -> Self {
        Self {
            id: session.id.clone(),
            name: session.name.clone(),
            size: session.size,
            offset: session.offset,
            chunk_size: CHUNK_BYTES,
            attachment_id: session.attachment_id.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct AppendParams {
    pub offset: u64,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/uploads` — open a session.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateUpload>,
) -> AppResult<Response> {
    if body.size == 0 {
        return Err(AppError::bad_request("the uploaded file is empty"));
    }
    if let Some(limit) = state.config().attachment_limit()
        && body.size > limit
    {
        return Err(AppError::PayloadTooLarge {
            len: body.size,
            limit,
        });
    }
    let now = BsonDateTime::now();
    let session = UploadSession {
        id: new_id(),
        user_id: user.id().to_string(),
        name: sanitize_filename(Some(&body.name)),
        size: body.size,
        offset: 0,
        gridfs_id: Bson::ObjectId(ObjectId::new()),
        head: binary(Vec::new()),
        wrapper: body.wrapper,
        attachment_id: None,
        document_id: None,
        created_at: now,
        expires_at: expires_from(now),
    };
    state.collections.uploads().insert_one(&session).await?;

    Ok((StatusCode::CREATED, Json(UploadView::from(&session))).into_response())
}

/// `GET /api/uploads/:id` — where the upload is.
pub async fn status(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<UploadView>> {
    let session = load_session(&state, &user, &id).await?;
    Ok(Json(UploadView::from(&session)))
}

/// `PATCH /api/uploads/:id?offset=n` — the next chunk.
pub async fn append(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(params): Query<AppendParams>,
    body: Result<Bytes, BytesRejection>,
) -> AppResult<Json<UploadView>> {
    let body = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::PayloadTooLarge {
                len: CHUNK_BYTES + 1,
                limit: CHUNK_BYTES,
            }
        } else {
            AppError::bad_request(format!(
                "could not read the chunk: {}",
                rejection.body_text()
            ))
        }
    })?;

    let session = load_session(&state, &user, &id).await?;
    if session.attachment_id.is_some() {
        return Err(AppError::Conflict(format!(
            "upload {id} is already complete"
        )));
    }
    let offset = params.offset;
    if offset != session.offset {
        return Err(AppError::Conflict(format!(
            "upload {id} is at byte {}, not {offset}; continue from there",
            session.offset
        )));
    }
    let len = body.len() as u64;
    if len == 0 {
        return Err(AppError::bad_request("a chunk cannot be empty"));
    }
    let end = offset + len;
    if end > session.size {
        return Err(AppError::bad_request(format!(
            "the chunk runs past the declared size of {} bytes",
            session.size
        )));
    }
    // Every chunk but the last is whole GridFS chunks, so each one starts on a
    // GridFS chunk boundary and can be cut without reading its neighbours.
    if end < session.size && !len.is_multiple_of(u64::from(GRIDFS_CHUNK_BYTES)) {
        return Err(AppError::bad_request(format!(
            "every chunk but the last must be a multiple of {GRIDFS_CHUNK_BYTES} bytes"
        )));
    }

    write_chunks(&state, &session.gridfs_id, offset, &body).await?;

    let now = BsonDateTime::now();
    let mut set = doc! { "offset": end as i64, "expires_at": expires_from(now) };
    if offset == 0 {
        let take = body.len().min(SNIFF_BYTES);
        set.insert("head", binary(body[..take].to_vec()));
    }
    let moved = state
        .collections
        .uploads()
        .update_one(
            doc! { "_id": &id, "offset": offset as i64, "attachment_id": Bson::Null },
            doc! { "$set": set },
        )
        .await?;
    if moved.matched_count == 0 {
        // Another request for the same bytes got there first. What it wrote is what
        // this one wrote; the client asks where the upload is and carries on.
        return Err(AppError::Conflict(format!(
            "upload {id} moved while this chunk was stored; ask where it is and continue"
        )));
    }

    let mut view = UploadView::from(&session);
    view.offset = end;
    Ok(Json(view))
}

/// `POST /api/uploads/:id/complete` — make the attachment.
pub async fn complete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let session = load_session(&state, &user, &id).await?;

    // Asked again after an answer that never arrived: the same answer.
    if let Some(attachment_id) = &session.attachment_id {
        let attachment = state
            .collections
            .attachments()
            .find_one(doc! { "_id": attachment_id, "deleted_at": Bson::Null })
            .await?
            .ok_or(AppError::NotFound("attachment"))?;
        return Ok(created(
            AttachmentView::from(attachment),
            session.document_id.clone(),
        ));
    }

    if session.offset != session.size {
        return Err(AppError::Conflict(format!(
            "upload {id} has {} of {} bytes; send the rest first",
            session.offset, session.size
        )));
    }

    let sha256 = match verify_chunks(&state, &session).await? {
        Verified::Complete { sha256 } => sha256,
        Verified::MissingFrom(byte) => {
            // A chunk went missing (a lost race, an interrupted write): rewind to it,
            // and the client sends the rest again.
            state
                .collections
                .uploads()
                .update_one(
                    doc! { "_id": &id, "attachment_id": Bson::Null },
                    doc! { "$set": { "offset": byte as i64 } },
                )
                .await?;
            return Err(AppError::Conflict(format!(
                "upload {id} is missing bytes from {byte}; continue from there"
            )));
        }
    };

    // The GridFS file record makes the chunks a file. Its `_id` is the session's
    // `gridfs_id`, so a second `complete` racing this one fails here, not later.
    let files = state.collections.raw(GRIDFS_FILES);
    let inserted = files
        .insert_one(doc! {
            "_id": session.gridfs_id.clone(),
            "length": session.size as i64,
            "chunkSize": GRIDFS_CHUNK_BYTES as i32,
            "uploadDate": BsonDateTime::now(),
            "filename": &session.name,
        })
        .await;
    if let Err(err) = inserted {
        if is_duplicate_key(&err) {
            return Err(AppError::Conflict(format!(
                "upload {id} is being completed by another request; ask again"
            )));
        }
        return Err(err.into());
    }

    metrics::counter!(names::ATTACHMENT_BYTES).increment(session.size);
    let blob = StoredBlob {
        gridfs_id: session.gridfs_id.clone(),
        name: session.name.clone(),
        mime: sniff_mime(&session.head.bytes, Some(&session.name)),
        size: session.size,
        sha256,
    };
    let (view, document_id) = record_upload(&state, &user, blob, session.wrapper).await?;

    let mut set = doc! {
        "attachment_id": &view.id,
        "expires_at": expires_from(BsonDateTime::now()),
    };
    if let Some(document_id) = &document_id {
        set.insert("document_id", document_id);
    }
    state
        .collections
        .uploads()
        .update_one(doc! { "_id": &id }, doc! { "$set": set })
        .await?;

    Ok(created(view, document_id))
}

/// `DELETE /api/uploads/:id` — cancel. The chunks go; a completed upload's
/// attachment stays (deleting that is `DELETE /api/attachments/:id`).
pub async fn cancel(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let session = load_session(&state, &user, &id).await?;
    remove_session(&state, &session).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Remove sessions not written to for [`SESSION_IDLE`], and the chunks of any
/// that never completed. Called from the maintenance loop; a failure is logged,
/// and the next pass tries again.
pub async fn sweep_expired(state: &AppState) {
    let result: AppResult<()> = async {
        let mut expired = state
            .collections
            .uploads()
            .find(doc! { "expires_at": { "$lt": BsonDateTime::now() } })
            .await?;
        while let Some(session) = expired.try_next().await? {
            remove_session(state, &session).await?;
        }
        Ok(())
    }
    .await;
    if let Err(err) = result {
        tracing::warn!(error = %err, "failed to sweep expired uploads");
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn load_session(state: &AppState, user: &AuthUser, id: &str) -> AppResult<UploadSession> {
    if !is_valid_id(id) {
        return Err(AppError::bad_request(format!(
            "invalid upload id `{id}`: expected a ULID"
        )));
    }
    // Someone else's session is as absent as a missing one.
    state
        .collections
        .uploads()
        .find_one(doc! { "_id": id, "user_id": user.id() })
        .await?
        .ok_or(AppError::NotFound("upload"))
}

/// Drop a session, and its bytes unless an attachment now owns them.
async fn remove_session(state: &AppState, session: &UploadSession) -> AppResult<()> {
    if session.attachment_id.is_none() {
        let owned = state
            .collections
            .attachments()
            .find_one(doc! { "gridfs_id": session.gridfs_id.clone() })
            .await?
            .is_some();
        if !owned {
            // Not `discard_blob`: a session that never completed has chunks and,
            // usually, no file record, which the driver's delete reports as an error.
            state
                .collections
                .raw(GRIDFS_CHUNKS)
                .delete_many(doc! { "files_id": session.gridfs_id.clone() })
                .await?;
            state
                .collections
                .raw(GRIDFS_FILES)
                .delete_one(doc! { "_id": session.gridfs_id.clone() })
                .await?;
        }
    }
    state
        .collections
        .uploads()
        .delete_one(doc! { "_id": &session.id })
        .await?;
    Ok(())
}

/// Store `bytes` (starting at `offset`, a GridFS chunk boundary) as GridFS
/// chunks, replacing any earlier copy of the same ones.
async fn write_chunks(
    state: &AppState,
    gridfs_id: &Bson,
    offset: u64,
    bytes: &[u8],
) -> AppResult<()> {
    let chunk = GRIDFS_CHUNK_BYTES as usize;
    let first = (offset / u64::from(GRIDFS_CHUNK_BYTES)) as i32;
    let count = bytes.len().div_ceil(chunk) as i32;
    let chunks = state.collections.raw(GRIDFS_CHUNKS);

    chunks
        .delete_many(doc! {
            "files_id": gridfs_id.clone(),
            "n": { "$gte": first, "$lt": first + count },
        })
        .await?;
    let docs = bytes.chunks(chunk).enumerate().map(|(index, data)| {
        doc! {
            "_id": ObjectId::new(),
            "files_id": gridfs_id.clone(),
            "n": first + index as i32,
            "data": binary(data.to_vec()),
        }
    });
    chunks.insert_many(docs).await?;
    Ok(())
}

enum Verified {
    Complete {
        sha256: String,
    },
    /// The first byte not stored.
    MissingFrom(u64),
}

/// Walk the chunks in order: each `n` present once, each the right length. Hashes
/// the bytes on the way, and removes a duplicate a lost race left behind.
async fn verify_chunks(state: &AppState, session: &UploadSession) -> AppResult<Verified> {
    let chunk = u64::from(GRIDFS_CHUNK_BYTES);
    let expected = session.size.div_ceil(chunk);
    let chunks = state.collections.raw(GRIDFS_CHUNKS);
    let mut cursor = chunks
        .find(doc! { "files_id": session.gridfs_id.clone() })
        .sort(doc! { "n": 1, "_id": 1 })
        .await?;

    let mut hasher = Sha256::new();
    let mut next: u64 = 0;
    while let Some(row) = cursor.try_next().await? {
        let n = u64::try_from(row.get_i32("n").unwrap_or(-1)).unwrap_or(u64::MAX);
        if n + 1 == next {
            // The same chunk twice: identical bytes from the same file, so one goes.
            if let Ok(id) = row.get_object_id("_id") {
                chunks.delete_one(doc! { "_id": id }).await?;
            }
            continue;
        }
        if n != next || n >= expected {
            break;
        }
        let data = match row.get("data") {
            Some(Bson::Binary(binary)) => &binary.bytes,
            _ => break,
        };
        let want = if n + 1 == expected {
            session.size - n * chunk
        } else {
            chunk
        };
        if data.len() as u64 != want {
            break;
        }
        hasher.update(data);
        next += 1;
    }

    if next == expected {
        Ok(Verified::Complete {
            sha256: hex::encode(hasher.finalize()),
        })
    } else {
        Ok(Verified::MissingFrom(next * chunk))
    }
}

fn binary(bytes: Vec<u8>) -> Binary {
    Binary {
        subtype: BinarySubtype::Generic,
        bytes,
    }
}

fn expires_from(now: BsonDateTime) -> BsonDateTime {
    BsonDateTime::from_millis(now.timestamp_millis() + SESSION_IDLE.as_millis() as i64)
}

fn is_duplicate_key(err: &mongodb::error::Error) -> bool {
    matches!(
        *err.kind,
        mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(ref write))
            if write.code == 11000
    )
}
