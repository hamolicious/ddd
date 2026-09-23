//! `/api/attachments` — GridFS-backed binary files (SPEC §3.6, §5.1).
//!
//! Hard rules, not negotiable:
//! - Streamed to GridFS **without buffering** the whole file; over
//!   `MAX_ATTACHMENT_BYTES` → 413.
//! - MIME is **sniffed** from the bytes, never taken from the client.
//! - `nosniff` on every response; `Content-Disposition: attachment` except for
//!   [`INLINE_SAFE_TYPES`]. `image/svg+xml` is **never** served inline.
//! - Replace requires `If-Match: <revision>`; mismatch → 409 so the client can
//!   offer keep-server / overwrite / keep-both. Identical `sha256` auto-resolves.
//! - Deletion is explicit; orphans are only *flagged* (admin view), never
//!   auto-deleted.
//!
//! | Method | Path | Behaviour |
//! |---|---|---|
//! | POST | `/api/attachments` | streamed multipart upload; `?wrapper=true&path=…` also creates the wrapper document |
//! | GET | `/api/attachments/:id` | the bytes, safe-serving headers |
//! | GET | `/api/attachments/:id/meta` | metadata only |
//! | PUT | `/api/attachments/:id` | replace bytes, `If-Match: <revision>` (`*` forces) |
//! | DELETE | `/api/attachments/:id` | explicit deletion, audited |
//! | GET | `/api/attachments` | admin listing |
//! | GET/POST | `/api/attachments/orphans[/scan]` | admin orphan view; never deletes |

use std::collections::BTreeMap;

use axum::body::Body;
use axum::extract::multipart::MultipartError;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bson::{Bson, DateTime as BsonDateTime, doc};
use futures::TryStreamExt as _;
use futures::io::{AsyncReadExt as _, AsyncWriteExt as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::auth::{AdminUser, AuthUser};
use crate::domain::{Attachment, AttachmentView, AuditEntry, Id, is_valid_id, new_id};
use crate::error::{AppError, AppResult};
use crate::routes::documents::map_docstore;
use crate::state::AppState;
use crate::telemetry::names;

/// MIME types safe to serve with `Content-Disposition: inline`. Everything else
/// downloads. Note the deliberate absence of `image/svg+xml`.
pub const INLINE_SAFE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "video/mp4",
    "video/webm",
    "application/pdf",
    "text/plain",
];

/// Never inline, whatever an allowlist entry might imply — the stored-XSS vector
/// of SPEC §3.6.
pub const NEVER_INLINE_TYPES: &[&str] = &["image/svg+xml", "text/html", "application/xhtml+xml"];

/// `attachment://<ulid>` — how document text references a blob (SPEC §3.6).
pub const ATTACHMENT_SCHEME: &str = "attachment://";

/// Length of a canonical ULID.
const ULID_LEN: usize = 26;

/// Multipart field name for the bytes when the client sends no filename.
pub const FILE_FIELD: &str = "file";

/// Bytes kept for MIME sniffing.
const SNIFF_BYTES: usize = 512;

/// Read size when streaming a blob back out of GridFS.
const DOWNLOAD_CHUNK_BYTES: usize = 64 * 1024;

/// Total budget for non-file multipart parts, so a client cannot stream forever
/// in a field we do not store.
const OTHER_FIELDS_BUDGET: u64 = 64 * 1024;

/// Longest accepted stored filename.
const MAX_FILENAME_BYTES: usize = 200;

/// Longest accepted `fm.path` for a wrapper document.
const MAX_WRAPPER_PATH_BYTES: usize = 512;

/// Fallback name when the client sends none (or an unusable one).
const FALLBACK_FILENAME: &str = "upload.bin";

/// Page size for the admin listing.
pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 500;

/// Filename extension → MIME, consulted only when the byte sniffer finds nothing
/// (text formats have no magic number).
const EXTENSION_TYPES: &[(&str, &str)] = &[
    ("md", "text/markdown"),
    ("markdown", "text/markdown"),
    ("txt", "text/plain"),
    ("log", "text/plain"),
    ("csv", "text/csv"),
    ("tsv", "text/tab-separated-values"),
    ("json", "application/json"),
    ("yaml", "application/yaml"),
    ("yml", "application/yaml"),
    ("xml", "application/xml"),
    ("svg", "image/svg+xml"),
    ("html", "text/html"),
    ("htm", "text/html"),
    ("css", "text/css"),
    ("js", "text/javascript"),
    ("ics", "text/calendar"),
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(upload))
        .route("/{id}", get(download).put(replace).delete(delete))
        .route("/{id}/meta", get(meta))
        .route("/orphans", get(orphans))
        .route("/orphans/scan", post(scan_orphans))
        // Uploads are streamed and capped by `MAX_ATTACHMENT_BYTES` below, not by
        // the JSON body limit the `/api` router applies. This inner layer wins
        // because it runs closer to the handler.
        .layer(DefaultBodyLimit::disable())
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct ListParams {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    /// Include deleted rows (admin view).
    #[serde(default)]
    pub include_deleted: bool,
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub attachments: Vec<AttachmentView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Result of an upload or replace.
#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub attachment: AttachmentView,
    /// `attachment://<ulid>` — what goes into document text.
    pub reference: String,
    /// `true` when an identical `sha256` made the replace a no-op (SPEC §3.6).
    #[serde(default)]
    pub unchanged: bool,
    /// Present when the caller asked for a wrapper document (SPEC §3.6: a
    /// standalone upload creates a regular markdown document representing the
    /// file).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<Id>,
}

/// Upload query string. `wrapper=true` creates the wrapper document; `path` puts
/// it in a folder (`fm.path`).
#[derive(Debug, Default, Deserialize)]
pub struct UploadParams {
    #[serde(default)]
    pub wrapper: bool,
    #[serde(default)]
    pub path: Option<String>,
}

/// One flagged orphan (a blob no materialized document references).
#[derive(Debug, Serialize)]
pub struct OrphanView {
    pub attachment: AttachmentView,
    pub flagged_at: bson::DateTime,
}

/// The bytes after a successful stream into GridFS.
struct StoredBlob {
    gridfs_id: Bson,
    name: String,
    mime: String,
    size: u64,
    sha256: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/attachments` — streamed multipart upload.
pub async fn upload(
    State(state): State<AppState>,
    user: AuthUser,
    Query(params): Query<UploadParams>,
    multipart: Multipart,
) -> AppResult<Response> {
    let wrapper_path = match params.path.as_deref() {
        Some(raw) if raw.len() > MAX_WRAPPER_PATH_BYTES => {
            return Err(AppError::bad_request(format!(
                "path is limited to {MAX_WRAPPER_PATH_BYTES} bytes"
            )));
        }
        Some(raw) => normalize_folder_path(raw),
        None => None,
    };

    let limit = state.config().max_attachment_bytes;
    let blob = store_upload(&state, multipart, limit).await?;
    let actor = user.actor();
    let now = BsonDateTime::now();

    let attachment = Attachment {
        id: new_id(),
        name: blob.name,
        mime: blob.mime,
        size: blob.size,
        sha256: blob.sha256,
        revision: 1,
        gridfs_id: blob.gridfs_id.clone(),
        created_at: now,
        created_by: Some(actor.as_stored()),
        updated_at: now,
        updated_by: Some(actor.as_stored()),
        deleted_at: None,
        deleted_by: None,
    };

    if let Err(err) = state
        .collections
        .attachments()
        .insert_one(&attachment)
        .await
    {
        // Never leave bytes behind that no row points at.
        discard_blob(&state, blob.gridfs_id).await;
        return Err(err.into());
    }

    let view = AttachmentView::from(attachment);
    let reference = attachment_reference(&view.id);

    let document_id = if params.wrapper {
        let text = wrapper_document_text(&view, wrapper_path.as_deref());
        let outcome = state
            .docs
            .create(None, &text, &actor)
            .await
            .map_err(map_docstore)?;
        Some(outcome.id)
    } else {
        None
    };

    let location = format!("/api/attachments/{}", view.id);
    Ok((
        StatusCode::CREATED,
        [(header::LOCATION, location)],
        Json(UploadResponse {
            attachment: view,
            reference,
            unchanged: false,
            document_id,
        }),
    )
        .into_response())
}

/// `GET /api/attachments/:id` — streams the bytes with the safe-serving headers.
pub async fn download(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let attachment = load_attachment(&state, &id).await?;

    let stream = state
        .collections
        .gridfs()
        .open_download_stream(attachment.gridfs_id.clone())
        .await
        .map_err(map_gridfs_open)?;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, &attachment.mime)
        .header(header::CONTENT_LENGTH, attachment.size.to_string())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_DISPOSITION,
            content_disposition(&attachment.mime, &attachment.name),
        )
        .header(header::ETAG, format!("\"{}\"", attachment.sha256))
        .header(header::CACHE_CONTROL, "private, max-age=0, must-revalidate")
        // A blob is never a document: no scripts, no subresources, no framing.
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .body(Body::from_stream(gridfs_byte_stream(stream)))
        .map_err(|err| AppError::Internal(anyhow::anyhow!(err)))?;

    Ok(response)
}

/// `GET /api/attachments/:id/meta`
pub async fn meta(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<AttachmentView>> {
    let attachment = load_attachment(&state, &id).await?;
    Ok(Json(AttachmentView::from(attachment)))
}

/// `PUT /api/attachments/:id` — replace bytes; requires `If-Match: <revision>`.
///
/// `headers` is taken so `If-Match` can be read; the path and method are the
/// contract, the extractor list is this file's business.
pub async fn replace(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    multipart: Multipart,
) -> AppResult<Response> {
    let expected_revision = parse_if_match(&headers)?;
    let existing = load_attachment(&state, &id).await?;

    let limit = state.config().max_attachment_bytes;
    let blob = store_upload(&state, multipart, limit).await?;

    // Identical bytes auto-resolve, revision mismatch or not (SPEC §3.6).
    if blob.sha256 == existing.sha256 {
        discard_blob(&state, blob.gridfs_id).await;
        let view = AttachmentView::from(existing);
        let reference = attachment_reference(&view.id);
        return Ok(Json(UploadResponse {
            attachment: view,
            reference,
            unchanged: true,
            document_id: None,
        })
        .into_response());
    }

    if let Some(provided) = expected_revision
        && provided != existing.revision
    {
        discard_blob(&state, blob.gridfs_id).await;
        return Err(AppError::Conflict(format!(
            "attachment {id} is at revision {}, If-Match sent {provided}; \
             keep the server copy, retry with the current revision, or upload as a new attachment",
            existing.revision
        )));
    }

    let actor = user.actor();
    let now = BsonDateTime::now();
    let revision = existing.revision.saturating_add(1);

    let updated = state
        .collections
        .attachments()
        .find_one_and_update(
            doc! { "_id": &id, "revision": i64::from(existing.revision), "deleted_at": Bson::Null },
            doc! { "$set": {
                "gridfs_id": blob.gridfs_id.clone(),
                "mime": &blob.mime,
                "size": blob.size as i64,
                "sha256": &blob.sha256,
                "revision": i64::from(revision),
                "updated_at": now,
                "updated_by": actor.as_stored(),
            }},
        )
        .return_document(mongodb::options::ReturnDocument::After)
        .await?;

    let Some(updated) = updated else {
        // Somebody else replaced it between the read and the write.
        discard_blob(&state, blob.gridfs_id).await;
        return Err(AppError::Conflict(format!(
            "attachment {id} changed while the upload was streaming; retry"
        )));
    };

    // The old bytes are unreferenced now; failing to drop them is a leak, not a
    // request failure.
    discard_blob(&state, existing.gridfs_id).await;

    state
        .audit(
            AuditEntry::new(
                "attachment.replace",
                Some(&actor),
                "attachment",
                Some(id.clone()),
            )
            .with_detail(doc! {
                "revision": i64::from(revision),
                "size": blob.size as i64,
                "mime": &blob.mime,
                "sha256": &blob.sha256,
            })
            .with_ip(user.session.ip.clone()),
        )
        .await;

    let view = AttachmentView::from(updated);
    let reference = attachment_reference(&view.id);
    Ok(Json(UploadResponse {
        attachment: view,
        reference,
        unchanged: false,
        document_id: None,
    })
    .into_response())
}

/// `DELETE /api/attachments/:id` — explicit deletion; audited.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let attachment = load_attachment(&state, &id).await?;
    let actor = user.actor();

    // Conditional on the revision that was read, exactly like `replace`: a
    // `PUT` landing between the read and this write swaps in new bytes, and
    // deleting the row while discarding the *old* blob would leave the new one in
    // GridFS with nothing referencing it — invisible to `find_orphans`, which
    // only walks `attachments` rows and skips tombstoned ones.
    let deleted = state
        .collections
        .attachments()
        .find_one_and_update(
            doc! {
                "_id": &id,
                "deleted_at": Bson::Null,
                "revision": i64::from(attachment.revision),
            },
            doc! { "$set": {
                "deleted_at": BsonDateTime::now(),
                "deleted_by": actor.as_stored(),
            }},
        )
        .return_document(mongodb::options::ReturnDocument::After)
        .await?;

    let Some(deleted) = deleted else {
        return Err(AppError::Conflict(format!(
            "attachment {id} changed while it was being deleted; retry"
        )));
    };

    // Deletion is explicit, so the bytes really go (the row stays as the
    // tombstone that keeps attribution) — and the bytes that go are the ones the
    // write itself saw, not the ones read earlier.
    discard_blob(&state, deleted.gridfs_id).await;

    state
        .audit(
            AuditEntry::new(
                "attachment.delete",
                Some(&actor),
                "attachment",
                Some(id.clone()),
            )
            .with_detail(doc! {
                "name": &deleted.name,
                "size": deleted.size as i64,
                "revision": i64::from(deleted.revision),
            })
            .with_ip(user.session.ip.clone()),
        )
        .await;

    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `GET /api/attachments` — admin/orphan listing.
pub async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(params): Query<ListParams>,
) -> AppResult<Json<ListResponse>> {
    let limit = match params.limit {
        None => DEFAULT_LIMIT,
        Some(0) => return Err(AppError::bad_request("limit must be at least 1")),
        Some(value) => value.min(MAX_LIMIT),
    };

    let mut filter = doc! {};
    if !params.include_deleted {
        filter.insert("deleted_at", Bson::Null);
    }
    if let Some(cursor) = params
        .cursor
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        if !is_valid_id(cursor) {
            return Err(AppError::bad_request("invalid cursor"));
        }
        // Newest first, so the next page is everything below the cursor.
        filter.insert("_id", doc! { "$lt": cursor });
    }

    let mut cursor = state
        .collections
        .attachments()
        .find(filter)
        .sort(doc! { "_id": -1 })
        .limit(i64::from(limit))
        .await?;

    let mut attachments = Vec::new();
    while let Some(attachment) = cursor.try_next().await? {
        attachments.push(AttachmentView::from(attachment));
    }

    let next_cursor = if attachments.len() as u32 == limit {
        attachments.last().map(|a| a.id.clone())
    } else {
        None
    };

    Ok(Json(ListResponse {
        attachments,
        next_cursor,
    }))
}

/// `GET /api/attachments/orphans` — flagged orphans (admin).
pub async fn orphans(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<Vec<OrphanView>>> {
    Ok(Json(find_orphans(&state).await?))
}

/// `POST /api/attachments/orphans/scan` — run the orphan scan over materialized
/// text (covers plugin-held `%%%` references automatically). Never deletes.
pub async fn scan_orphans(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<Vec<OrphanView>>> {
    Ok(Json(find_orphans(&state).await?))
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested below)
// ---------------------------------------------------------------------------

/// Sniff the MIME type from the leading bytes, falling back to
/// `application/octet-stream`. The client's claim is only a hint for the
/// filename extension.
pub fn sniff_mime(head: &[u8], filename: Option<&str>) -> String {
    if let Some(kind) = infer::get(head) {
        return kind.mime_type().to_string();
    }
    if let Some(mime) = filename.and_then(extension).and_then(|ext| {
        EXTENSION_TYPES
            .iter()
            .find(|(candidate, _)| *candidate == ext)
            .map(|(_, mime)| *mime)
    }) {
        return mime.to_string();
    }
    if looks_like_text(head) {
        return "text/plain".to_string();
    }
    "application/octet-stream".to_string()
}

/// `true` when this MIME type may be served inline.
pub fn is_inline_safe(mime: &str) -> bool {
    !NEVER_INLINE_TYPES.contains(&mime) && INLINE_SAFE_TYPES.contains(&mime)
}

/// The wrapper-document text for a standalone upload (SPEC §3.6).
pub fn wrapper_document_text(attachment: &AttachmentView, path: Option<&str>) -> String {
    let mut out = String::from("---\ntitle: ");
    out.push_str(&yaml_scalar(&attachment.name));
    out.push('\n');
    if let Some(path) = path {
        out.push_str("path: ");
        out.push_str(&yaml_scalar(path));
        out.push('\n');
    }
    out.push_str("attachment: ");
    out.push_str(&attachment.id);
    out.push_str("\n---\n\n");
    if attachment.mime.starts_with("image/") {
        out.push('!');
    }
    out.push('[');
    out.push_str(&markdown_label(&attachment.name));
    out.push_str("](");
    out.push_str(ATTACHMENT_SCHEME);
    out.push_str(&attachment.id);
    out.push_str(")\n");
    out
}

/// `attachment://<ulid>`.
pub fn attachment_reference(id: &str) -> String {
    format!("{ATTACHMENT_SCHEME}{id}")
}

/// Every `attachment://<ulid>` id referenced by a document's materialized text.
/// `%%%` sections are part of `content`, so plugin-held references are covered
/// for free (SPEC §3.6).
pub fn attachment_refs(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    for (index, _) in text.match_indices(ATTACHMENT_SCHEME) {
        let rest = &text[index + ATTACHMENT_SCHEME.len()..];
        let len = rest
            .bytes()
            .take(ULID_LEN)
            .take_while(u8::is_ascii_alphanumeric)
            .count();
        if len == ULID_LEN {
            found.push(&rest[..len]);
        }
    }
    found
}

/// `Content-Disposition` for a blob: inline only for the allowlist, and never for
/// the types in [`NEVER_INLINE_TYPES`].
pub fn content_disposition(mime: &str, name: &str) -> String {
    let disposition = if is_inline_safe(mime) {
        "inline"
    } else {
        "attachment"
    };

    // A quoted ASCII fallback for old clients plus RFC 5987 for the real name.
    let ascii: String = name
        .chars()
        .map(|c| {
            if c == '"' || c == '\\' || c.is_control() || !c.is_ascii() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let ascii = if ascii.trim().is_empty() {
        FALLBACK_FILENAME.to_string()
    } else {
        ascii
    };

    format!(
        "{disposition}; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent_encode(name)
    )
}

/// Turn a client-supplied filename into something safe to store and echo back.
pub fn sanitize_filename(raw: Option<&str>) -> String {
    let Some(raw) = raw else {
        return FALLBACK_FILENAME.to_string();
    };
    // Basename only: no directories, no drive letters, no traversal.
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(raw)
        .trim()
        .trim_matches('.');
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if c == '"' || c == '\\' { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return FALLBACK_FILENAME.to_string();
    }
    truncate_bytes(cleaned, MAX_FILENAME_BYTES).to_string()
}

/// `fm.path` normalization (SPEC §6.5): `/` segments, `.`/`..`/empty stripped,
/// case preserved. `None` when nothing is left.
///
/// Control characters are dropped per segment: a newline or a CR in a folder name
/// is never legitimate, and the quoting in [`yaml_scalar`] should not be the only
/// thing standing between a query parameter and the frontmatter block.
pub fn normalize_folder_path(raw: &str) -> Option<String> {
    let segments: Vec<String> = raw
        .split('/')
        .map(|segment| {
            segment
                .chars()
                .filter(|c| !c.is_control())
                .collect::<String>()
                .trim()
                .to_string()
        })
        .filter(|segment| !segment.is_empty() && segment != "." && segment != "..")
        .collect();
    if segments.is_empty() {
        None
    } else {
        Some(segments.join("/"))
    }
}

/// Read the replace precondition: `Some(revision)` to check, `None` for `*`
/// (the client's explicit "overwrite" choice). Missing header → 428.
pub fn parse_if_match(headers: &HeaderMap) -> AppResult<Option<u32>> {
    let Some(value) = headers.get(header::IF_MATCH) else {
        return Err(AppError::PreconditionRequired);
    };
    let raw = value
        .to_str()
        .map_err(|_| AppError::bad_request("If-Match is not valid text"))?
        .trim();
    if raw == "*" {
        return Ok(None);
    }
    let raw = raw.strip_prefix("W/").unwrap_or(raw).trim();
    let raw = raw.trim_matches('"');
    raw.parse::<u32>().map(Some).map_err(|_| {
        AppError::bad_request(format!(
            "If-Match must be an attachment revision number or `*`, got `{raw}`"
        ))
    })
}

/// Lowercased extension of a filename, if any.
fn extension(name: &str) -> Option<String> {
    let (_, ext) = name.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 16 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Conservative "this is text" test: no NUL, no control bytes beyond tab/CR/LF.
fn looks_like_text(head: &[u8]) -> bool {
    !head.is_empty()
        && head
            .iter()
            .all(|byte| *byte >= 0x20 || matches!(byte, b'\t' | b'\n' | b'\r'))
}

/// Percent-encode everything but RFC 3986 unreserved characters.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Quote a frontmatter scalar when it cannot be written bare.
///
/// Delegated to the shared core rather than reimplemented here. The local version
/// double-quoted without escaping control characters, so a `path` (or a filename)
/// containing a newline was written out with that newline **literal**: a
/// `?path=x%0A---%0Atitle:%20Hijacked` upload closed the frontmatter block early
/// and injected its own keys into the wrapper document the server generates.
/// [`life_manager_core::value::Value::to_yaml_inline`] is the same serializer the
/// `%%%` line splices use, and it escapes `\n`, `\r`, `\t` and every other control
/// character.
fn yaml_scalar(value: &str) -> String {
    life_manager_core::value::Value::Str(value.to_string()).to_yaml_inline()
}

/// Escape the characters that would break a markdown link label.
fn markdown_label(value: &str) -> String {
    value
        .chars()
        .flat_map(|c| {
            if matches!(c, '[' | ']' | '(' | ')' | '\\') {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}

/// Truncate to at most `max` bytes without splitting a character.
fn truncate_bytes(input: &str, max: usize) -> &str {
    if input.len() <= max {
        return input;
    }
    let mut end = max;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    &input[..end]
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn check_attachment_id(id: &str) -> AppResult<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "invalid attachment id `{id}`: expected a ULID"
        )))
    }
}

async fn load_attachment(state: &AppState, id: &str) -> AppResult<Attachment> {
    check_attachment_id(id)?;
    state
        .collections
        .attachments()
        .find_one(doc! { "_id": id, "deleted_at": Bson::Null })
        .await?
        .ok_or(AppError::NotFound("attachment"))
}

/// Drop GridFS bytes nothing references any more. Best effort: a failure here is
/// a storage leak for the orphan view to surface, never a failed request.
async fn discard_blob(state: &AppState, gridfs_id: Bson) {
    if let Err(err) = state.collections.gridfs().delete(gridfs_id.clone()).await {
        tracing::warn!(?gridfs_id, error = %err, "failed to delete gridfs blob");
    }
}

/// A missing blob behind an existing row is a 404 to the caller, not a 500.
fn map_gridfs_open(err: mongodb::error::Error) -> AppError {
    if matches!(*err.kind, mongodb::error::ErrorKind::GridFs(_)) {
        tracing::warn!(error = %err, "attachment row has no gridfs blob");
        AppError::NotFound("attachment")
    } else {
        AppError::Db(err)
    }
}

fn multipart_error(err: MultipartError, limit: u64) -> AppError {
    if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return AppError::PayloadTooLarge { len: limit, limit };
    }
    AppError::bad_request(format!("invalid multipart body: {}", err.body_text()))
}

/// Stream the first file part of a multipart body straight into GridFS, hashing
/// and counting as the bytes go past. Nothing is buffered beyond the sniff
/// window (SPEC §3.5, §3.6).
async fn store_upload(
    state: &AppState,
    mut multipart: Multipart,
    limit: u64,
) -> AppResult<StoredBlob> {
    let bucket = state.collections.gridfs();
    let mut other_bytes: u64 = 0;

    loop {
        let Some(mut field) = multipart
            .next_field()
            .await
            .map_err(|err| multipart_error(err, limit))?
        else {
            return Err(AppError::bad_request(
                "multipart body has no file part (send the bytes as `file`)",
            ));
        };

        let is_file = field.file_name().is_some() || field.name() == Some(FILE_FIELD);
        if !is_file {
            // Drain, bounded, so a non-file part cannot stream forever.
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|err| multipart_error(err, limit))?
            {
                other_bytes += chunk.len() as u64;
                if other_bytes > OTHER_FIELDS_BUDGET {
                    return Err(AppError::bad_request(
                        "multipart body has too much non-file content",
                    ));
                }
            }
            continue;
        }

        let name = sanitize_filename(field.file_name());
        let mut upload = bucket.open_upload_stream(&name).await?;
        let gridfs_id = upload.id().clone();

        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        let mut head: Vec<u8> = Vec::with_capacity(SNIFF_BYTES);

        loop {
            let chunk = match field.chunk().await {
                Ok(chunk) => chunk,
                Err(err) => {
                    let _ = upload.abort().await;
                    return Err(multipart_error(err, limit));
                }
            };
            let Some(chunk) = chunk else { break };

            size += chunk.len() as u64;
            if size > limit {
                let _ = upload.abort().await;
                return Err(AppError::PayloadTooLarge { len: size, limit });
            }

            hasher.update(&chunk);
            if head.len() < SNIFF_BYTES {
                let take = (SNIFF_BYTES - head.len()).min(chunk.len());
                head.extend_from_slice(&chunk[..take]);
            }

            if let Err(err) = upload.write_all(&chunk).await {
                let _ = upload.abort().await;
                return Err(AppError::Internal(anyhow::anyhow!(
                    "gridfs write failed: {err}"
                )));
            }
        }

        if size == 0 {
            let _ = upload.abort().await;
            return Err(AppError::bad_request("the uploaded file is empty"));
        }

        upload
            .close()
            .await
            .map_err(|err| AppError::Internal(anyhow::anyhow!("gridfs close failed: {err}")))?;

        let mime = sniff_mime(&head, Some(&name));
        metrics::counter!(names::ATTACHMENT_BYTES).increment(size);

        return Ok(StoredBlob {
            gridfs_id,
            name,
            mime,
            size,
            sha256: hex::encode(hasher.finalize()),
        });
    }
}

/// Wrap a GridFS download stream (futures-io `AsyncRead`) as a byte stream axum
/// can use as a response body — no full-file buffering.
fn gridfs_byte_stream(
    stream: mongodb::gridfs::GridFsDownloadStream,
) -> impl futures::Stream<Item = Result<bytes::Bytes, std::io::Error>> {
    futures::stream::try_unfold(stream, |mut stream| async move {
        let mut buffer = vec![0u8; DOWNLOAD_CHUNK_BYTES];
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        buffer.truncate(read);
        Ok(Some((bytes::Bytes::from(buffer), stream)))
    })
}

/// Blobs no document references. Read-only: flagging is all SPEC §3.6 allows.
async fn find_orphans(state: &AppState) -> AppResult<Vec<OrphanView>> {
    let mut unreferenced: BTreeMap<Id, AttachmentView> = BTreeMap::new();
    let mut attachments = state
        .collections
        .attachments()
        .find(doc! { "deleted_at": Bson::Null })
        .await?;
    while let Some(attachment) = attachments.try_next().await? {
        unreferenced.insert(attachment.id.clone(), AttachmentView::from(attachment));
    }
    if unreferenced.is_empty() {
        return Ok(Vec::new());
    }

    // Tombstoned documents still count as referencing: restoring one must not
    // find its file already reported as garbage.
    let mut documents = state
        .collections
        .raw(crate::db::DOCUMENTS)
        .find(doc! {})
        .projection(doc! { "content": 1 })
        .await?;
    while let Some(row) = documents.try_next().await? {
        if let Ok(content) = row.get_str("content") {
            for reference in attachment_refs(content) {
                unreferenced.remove(reference);
            }
        }
        if unreferenced.is_empty() {
            break;
        }
    }

    let flagged_at = BsonDateTime::now();
    Ok(unreferenced
        .into_values()
        .map(|attachment| OrphanView {
            attachment,
            flagged_at,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(name: &str, mime: &str) -> AttachmentView {
        AttachmentView {
            id: "01J0000000000000000000000A".to_string(),
            name: name.to_string(),
            mime: mime.to_string(),
            size: 12,
            sha256: "ab".repeat(32),
            revision: 1,
            created_at: BsonDateTime::from_millis(0),
            created_by: None,
            updated_at: BsonDateTime::from_millis(0),
            updated_by: None,
        }
    }

    #[test]
    fn inline_allowlist_is_closed() {
        assert!(is_inline_safe("image/png"));
        assert!(is_inline_safe("application/pdf"));
        assert!(is_inline_safe("text/plain"));
        // Never inline, whatever happens to the allowlist.
        assert!(!is_inline_safe("image/svg+xml"));
        assert!(!is_inline_safe("text/html"));
        assert!(!is_inline_safe("application/xhtml+xml"));
        // Unknown types download.
        assert!(!is_inline_safe("application/octet-stream"));
        assert!(!is_inline_safe("text/markdown"));
        assert!(!is_inline_safe("IMAGE/PNG"));
    }

    #[test]
    fn svg_is_never_served_inline() {
        let disposition = content_disposition("image/svg+xml", "logo.svg");
        assert!(disposition.starts_with("attachment;"), "{disposition}");
        assert!(content_disposition("text/html", "x.html").starts_with("attachment;"));
        assert!(content_disposition("image/png", "x.png").starts_with("inline;"));
    }

    #[test]
    fn content_disposition_escapes_the_filename() {
        let disposition = content_disposition("application/zip", "a\"b\r\n; drop.zip");
        assert!(!disposition.contains('"') || disposition.matches('"').count() == 2);
        assert!(!disposition.contains('\r'));
        assert!(!disposition.contains('\n'));
        assert!(disposition.contains("filename*=UTF-8''"));

        let unicode = content_disposition("application/zip", "réçu.zip");
        assert!(unicode.contains("filename=\"r__u.zip\""), "{unicode}");
        assert!(
            unicode.contains("filename*=UTF-8''r%C3%A9%C3%A7u.zip"),
            "{unicode}"
        );
    }

    #[test]
    fn mime_is_sniffed_from_bytes_first() {
        let mut png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&[0u8; 16]);
        // The client's extension lie loses to the bytes.
        assert_eq!(sniff_mime(&png, Some("evil.html")), "image/png");
    }

    #[test]
    fn mime_falls_back_to_the_extension_then_octet_stream() {
        assert_eq!(sniff_mime(b"# hello", Some("note.md")), "text/markdown");
        assert_eq!(
            sniff_mime(b"<svg></svg>", Some("logo.svg")),
            "image/svg+xml"
        );
        assert_eq!(sniff_mime(b"<p>hi</p>", Some("page.html")), "text/html");
        assert_eq!(sniff_mime(b"plain words", Some("mystery")), "text/plain");
        assert_eq!(
            sniff_mime(&[0u8, 1, 2, 3, 200], Some("mystery")),
            "application/octet-stream"
        );
        assert_eq!(sniff_mime(&[], None), "application/octet-stream");
    }

    #[test]
    fn filenames_are_basenames_without_traversal() {
        assert_eq!(sanitize_filename(Some("../../etc/passwd")), "passwd");
        assert_eq!(sanitize_filename(Some("C:\\temp\\x.png")), "x.png");
        assert_eq!(sanitize_filename(Some("  spaced.txt  ")), "spaced.txt");
        assert_eq!(sanitize_filename(Some("..")), FALLBACK_FILENAME);
        assert_eq!(sanitize_filename(Some("")), FALLBACK_FILENAME);
        assert_eq!(sanitize_filename(None), FALLBACK_FILENAME);
        assert_eq!(sanitize_filename(Some("a\nb.txt")), "ab.txt");
        assert!(sanitize_filename(Some(&"x".repeat(500))).len() <= MAX_FILENAME_BYTES);
    }

    #[test]
    fn folder_paths_are_normalized() {
        assert_eq!(
            normalize_folder_path("home//lists/"),
            Some("home/lists".to_string())
        );
        assert_eq!(
            normalize_folder_path("../home/./lists"),
            Some("home/lists".to_string())
        );
        assert_eq!(normalize_folder_path("   "), None);
        assert_eq!(normalize_folder_path("/"), None);
        // A newline in a folder name is never legitimate.
        assert_eq!(
            normalize_folder_path("home\n---\ntitle: x"),
            Some("home---title: x".to_string())
        );
        assert_eq!(normalize_folder_path("\n\r\t"), None);
    }

    /// The `path` query parameter reaches the frontmatter of a server-generated
    /// document: it must not be able to close the block or add keys.
    #[test]
    fn wrapper_frontmatter_survives_a_hostile_path_and_filename() {
        use life_manager_core::document::parse_document;

        let path = "x\n---\ntitle: Hijacked\nevil: 1";
        let text = wrapper_document_text(&view("photo.png", "image/png"), Some(path));

        let parsed = parse_document(&text);
        assert!(
            !parsed.fm_parse_error,
            "the generated frontmatter must parse cleanly: {text}"
        );
        assert_eq!(
            parsed.fm.get("title").and_then(|v| v.as_str()),
            Some("photo.png"),
            "the injected title must not win: {text}"
        );
        assert!(
            !parsed.fm.contains_key("evil"),
            "an injected key reached `fm`: {text}"
        );
        assert!(
            parsed.fm.contains_key("attachment"),
            "the attachment key was lost: {text}"
        );
        // One `---` to open, one to close, and nothing in between broke out.
        assert_eq!(text.matches("\n---\n").count(), 1, "{text}");

        // Same for a filename carrying control characters (sanitized upstream,
        // but the serializer is what must be safe).
        let hostile = wrapper_document_text(&view("a\n---\nevil: 1", "text/plain"), None);
        let parsed = parse_document(&hostile);
        assert!(!parsed.fm.contains_key("evil"), "{hostile}");
        assert!(!parsed.fm_parse_error, "{hostile}");
    }

    #[test]
    fn wrapper_document_embeds_the_reference() {
        let text =
            wrapper_document_text(&view("holiday: photo.png", "image/png"), Some("trips/2026"));
        assert!(text.starts_with("---\n"), "{text}");
        assert!(text.contains("title: \"holiday: photo.png\""), "{text}");
        assert!(text.contains("path: trips/2026"), "{text}");
        assert!(
            text.contains("![holiday: photo.png](attachment://01J0000000000000000000000A)"),
            "{text}"
        );

        // Non-images embed as a link, not an image.
        let doc = wrapper_document_text(&view("report.pdf", "application/pdf"), None);
        assert!(doc.contains("\n[report.pdf](attachment://"), "{doc}");
        assert!(!doc.contains("path:"), "{doc}");
    }

    #[test]
    fn attachment_references_are_extracted_from_text() {
        let id = "01J0000000000000000000000A";
        let text = format!(
            "![x](attachment://{id})\n\n%%% gallery\ncover: attachment://{id}\n%%%\n\
             not a ref: attachment://short\n"
        );
        let refs = attachment_refs(&text);
        assert_eq!(refs, vec![id, id]);
        assert!(attachment_refs("nothing here").is_empty());
    }

    #[test]
    fn if_match_parsing() {
        let mut headers = HeaderMap::new();
        assert!(matches!(
            parse_if_match(&headers),
            Err(AppError::PreconditionRequired)
        ));

        headers.insert(header::IF_MATCH, "3".parse().unwrap());
        assert_eq!(parse_if_match(&headers).unwrap(), Some(3));

        headers.insert(header::IF_MATCH, "\"7\"".parse().unwrap());
        assert_eq!(parse_if_match(&headers).unwrap(), Some(7));

        headers.insert(header::IF_MATCH, "W/\"9\"".parse().unwrap());
        assert_eq!(parse_if_match(&headers).unwrap(), Some(9));

        headers.insert(header::IF_MATCH, "*".parse().unwrap());
        assert_eq!(parse_if_match(&headers).unwrap(), None);

        headers.insert(header::IF_MATCH, "banana".parse().unwrap());
        assert!(matches!(
            parse_if_match(&headers),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn reference_format() {
        assert_eq!(attachment_reference("ABC"), "attachment://ABC");
    }
}
