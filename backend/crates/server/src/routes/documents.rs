//! `/api/documents` — the document REST surface (SPEC §5.1).
//!
//! REST serves scripts, integrations, plugins and initial loads; the PWA uses
//! the WebSocket (M2) for everything interactive.
//!
//! | Method | Path | Behaviour |
//! |---|---|---|
//! | GET | `/api/documents` | list/query: `filter` (DSL), `search`, `sort`, `cursor`, `limit`, `trash` |
//! | POST | `/api/documents` | create from full text; existing id → 409, graveyarded id → 410 |
//! | GET | `/api/documents/:id` | materialized JSON, forces a flush; `?format=crdt` returns CRDT state |
//! | PUT | `/api/documents/:id` | replace full text in one CRDT transaction |
//! | PATCH | `/api/documents/:id` | `{"content": …}` only — no `fm`/`plugins` patching |
//! | DELETE | `/api/documents/:id` | tombstone → Trash (30 d) → purge; id → graveyard forever |
//! | POST | `/api/documents/:id/restore` | out of Trash |
//! | GET | `/api/documents/:id/snapshots` | list snapshots |
//! | GET | `/api/documents/:id/snapshots/:snapshot_id` | one snapshot, with its text |
//! | GET, POST | `/api/documents/:id/changes…`, `/text?at=` | history, revert, text at a point (`changes.rs`) |
//! | POST | `/api/documents/:id/snapshots/:snapshot_id/restore` | restore a snapshot |
//!
//! The Trash view is `GET /api/documents?trash=trashed` — a tombstoned document
//! is still a document, so it needs no second listing endpoint.
//!
//! Client JSON never reaches Mongo: `filter` is parsed by the shared core's DSL
//! and compiled by [`life_manager_core::filter::mongo`], `sort` goes through a
//! whitelist ([`sort_field_allowed`]), and `search` is handed to the docstore as
//! opaque terms for its `$text` query.

use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use bson::doc;
use life_manager_core::filter::ast::{Filter, SortKey};
use life_manager_core::filter::mongo as filter_mongo;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::docstore::{DocStoreError, ListQuery, TrashFilter};
use crate::domain::{AuditEntry, DocumentView, Id, Timestamp, is_valid_id};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Default and maximum page size for list queries.
pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 500;

/// Single-segment field paths that may be sorted on. `content` is deliberately
/// absent (megabyte strings are not a sort key) and so is anything CRDT-shaped.
///
/// This list must stay a subset of the shared core's addressable roots
/// ([`life_manager_core::filter::ast::FieldPath`]), because every token also goes
/// through `SortKey::parse`: `deleted_at` and `materialized_version` were once
/// advertised here and always 400'd, since neither was a field of the projection
/// the DSL addresses (SPEC §4.1).
///
/// `deleted_at` is now genuinely one of them — the cross-crate change that note
/// asked for, made in `core::filter` (an addressable root, a `Row` field, a
/// `Column::Date` in the Mongo compiler). It is what Trash sorts by: the view is
/// "what did I delete, most recent first" (SPEC §6.5), and without a server-side
/// sort key that order could only be imposed on a page *after* it came back, so
/// the newest deletion was not reliably on the first page. `documents_deleted_at`
/// already indexed the column for the Trash *filter*, so the sort is free.
///
/// `materialized_version` is still absent and stays absent: it is a state-vector
/// hash, and ordering by it is ordering by noise.
pub const SORTABLE_FIELDS: &[&str] = &["id", "title", "created_at", "updated_at", "deleted_at"];

/// Roots whose sub-paths may be sorted on: materialized frontmatter and machine
/// sections (`fm.due`, `plugins.calendar.start`).
pub const SORTABLE_PREFIXES: &[&str] = &["fm", "plugins"];

/// Maximum number of sort keys accepted in one query.
pub const MAX_SORT_KEYS: usize = 3;

/// Maximum number of segments in a sortable field path.
pub const MAX_SORT_DEPTH: usize = 4;

/// Longest accepted `search` string.
pub const MAX_SEARCH_LEN: usize = 256;

/// The only snapshot `reason` the API may write; the policy-driven reasons
/// (`quiescence`, `daily`, `pre_restore`) belong to the docstore.
pub const API_SNAPSHOT_REASON: &str = "manual";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route(
            "/{id}",
            get(get_one).put(replace).patch(patch).delete(delete),
        )
        .route("/{id}/restore", post(restore))
        .route("/{id}/snapshots", get(list_snapshots).post(create_snapshot))
        .route("/{id}/snapshots/{snapshot_id}", get(get_snapshot))
        .route("/{id}/changes", get(super::changes::list_changes))
        .route("/{id}/text", get(super::changes::text_at))
        .route("/{id}/history/forget", post(super::changes::forget_history))
        .route("/{id}/changes/{from}/{to}", get(super::changes::get_change))
        .route("/{id}/changes/{from}/{to}/revert", post(super::changes::revert_change))
        .route(
            "/{id}/snapshots/{snapshot_id}/restore",
            post(restore_snapshot),
        )
}

// ---------------------------------------------------------------------------
// Query / body shapes
// ---------------------------------------------------------------------------

/// `GET /api/documents` query string.
#[derive(Debug, Default, Deserialize)]
pub struct ListParams {
    /// Filter DSL, JSON-encoded (SPEC §4.2). Invalid → 400.
    #[serde(default)]
    pub filter: Option<String>,
    /// Server-side full-text search terms.
    #[serde(default)]
    pub search: Option<String>,
    /// `field` / `-field` / `field:desc`, comma-separated.
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    /// `live` (default) | `trashed` | `all`.
    #[serde(default)]
    pub trash: Option<String>,
    /// When `true`, omit `content` from the rows (list views).
    #[serde(default)]
    pub metadata_only: bool,
}

impl ListParams {
    /// Validate and compile into a [`ListQuery`]: parse the DSL, compile it to
    /// Mongo, clamp the limit, resolve the sort keys.
    pub fn into_query(self) -> AppResult<ListQuery> {
        let filter = match self.filter.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => {
                let parsed = Filter::from_json_str(raw)
                    .map_err(|err| AppError::bad_request(format!("invalid filter: {err}")))?;
                let compiled = filter_mongo::compile(&parsed)
                    .map_err(|err| AppError::bad_request(format!("invalid filter: {err}")))?;
                Some(compiled)
            }
        };

        let sort = match self.sort.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => {
                let keys = parse_sort_spec(raw)?;
                let compiled = filter_mongo::compile_sort(&keys)
                    .map_err(|err| AppError::bad_request(format!("invalid sort: {err}")))?;
                Some(compiled)
            }
        };

        let search = match self.search.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(terms) if terms.len() > MAX_SEARCH_LEN => {
                return Err(AppError::bad_request(format!(
                    "search is limited to {MAX_SEARCH_LEN} characters"
                )));
            }
            Some(terms) => Some(terms.to_string()),
        };

        let cursor = match self.cursor.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(cursor) => Some(cursor.to_string()),
        };

        Ok(ListQuery {
            filter,
            sort,
            search,
            cursor,
            limit: clamp_limit(self.limit)?,
            trash: parse_trash(self.trash.as_deref())?,
            // Passed down so the docstore leaves `content` out of the Mongo
            // projection, rather than reading megabytes and blanking them here.
            metadata_only: self.metadata_only,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub documents: Vec<DocumentView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// `POST /api/documents`. `id` is client-mintable (offline creates).
#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    #[serde(default)]
    pub id: Option<Id>,
    /// The full document text: frontmatter + body + `%%%` sections.
    #[serde(default)]
    pub content: String,
    /// Instead of `content`: the device's own encoded Yjs state (update encoding v1,
    /// base64), for a note made offline. Needs `id`. Its later edits then merge into
    /// this state instead of duplicating the text (PROTOCOL.md §3.8).
    #[serde(default)]
    pub state: Option<String>,
}

/// `PUT /api/documents/:id`.
#[derive(Debug, Deserialize)]
pub struct ReplaceRequest {
    pub content: String,
}

/// `PATCH /api/documents/:id`. Body-text-level only — **no `fm`/`plugins`
/// patching** (SPEC §5.1); machines write via `%%%` splices.
#[derive(Debug, Deserialize)]
pub struct PatchRequest {
    pub content: String,
    /// Anything else the caller sent. Captured rather than ignored so that a
    /// `fm`/`plugins` patch attempt fails loudly instead of silently doing
    /// nothing (SPEC §3.3).
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

impl PatchRequest {
    /// Reject every field but `content`.
    pub fn validate(&self) -> AppResult<()> {
        if let Some(key) = self.rest.keys().next() {
            return Err(AppError::bad_request(format!(
                "unsupported patch field `{key}`: PATCH replaces `content` only — \
                 frontmatter and machine sections are written as text (SPEC §3.3)"
            )));
        }
        Ok(())
    }
}

/// `GET /api/documents/:id` query string.
#[derive(Debug, Default, Deserialize)]
pub struct GetParams {
    /// `crdt` returns the encoded CRDT state instead of materialized JSON.
    #[serde(default)]
    pub format: Option<String>,
    /// Skip the read-your-writes flush (cheap read of possibly stale metadata).
    #[serde(default)]
    pub stale_ok: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateSnapshotRequest {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SnapshotCreated {
    pub id: Id,
    pub document_id: Id,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested below)
// ---------------------------------------------------------------------------

/// `true` when `dotted` may be used as a sort key. The whitelist exists because
/// sorting reaches Mongo directly: `title`/`updated_at`/`created_at`/`id` and any
/// `fm.*` / `plugins.*` path, nothing else.
pub fn sort_field_allowed(dotted: &str) -> bool {
    let mut segments = dotted.split('.');
    let Some(root) = segments.next() else {
        return false;
    };
    if root.is_empty() {
        return false;
    }
    let rest: Vec<&str> = segments.collect();
    if rest.is_empty() {
        return SORTABLE_FIELDS.contains(&root);
    }
    SORTABLE_PREFIXES.contains(&root)
        && rest.len() < MAX_SORT_DEPTH
        && rest.iter().all(|segment| !segment.is_empty())
}

/// The field name inside one sort token: `title`, `-title`, `title:desc` all
/// yield `title`. Mirrors [`SortKey::parse`]'s accepted forms.
pub fn sort_field_name(token: &str) -> &str {
    let token = token.trim();
    let token = token.strip_prefix('-').unwrap_or(token);
    match token.split_once(':') {
        Some((field, _)) => field.trim(),
        None => token,
    }
}

/// Parse the comma-separated `sort` parameter, whitelisting every field before
/// the shared core turns it into sort keys.
pub fn parse_sort_spec(spec: &str) -> AppResult<Vec<SortKey>> {
    let tokens: Vec<&str> = spec
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect();

    // Validate everything before parsing anything, so a rejected query does no
    // work and the error names the first real problem.
    if tokens.len() > MAX_SORT_KEYS {
        return Err(AppError::bad_request(format!(
            "at most {MAX_SORT_KEYS} sort keys are accepted, got {}",
            tokens.len()
        )));
    }
    for token in &tokens {
        let field = sort_field_name(token);
        if !sort_field_allowed(field) {
            return Err(AppError::bad_request(format!(
                "`{field}` is not sortable; sortable fields are {} plus any `fm.*` / `plugins.*` path",
                SORTABLE_FIELDS.join(", ")
            )));
        }
    }

    tokens
        .iter()
        .map(|token| {
            SortKey::parse(token)
                .map_err(|err| AppError::bad_request(format!("invalid sort key `{token}`: {err}")))
        })
        .collect()
}

/// Clamp `limit` into `1..=MAX_LIMIT`; an explicit `0` is a client bug, not a
/// request for nothing.
pub fn clamp_limit(limit: Option<u32>) -> AppResult<u32> {
    match limit {
        None => Ok(DEFAULT_LIMIT),
        Some(0) => Err(AppError::bad_request("limit must be at least 1")),
        Some(value) => Ok(value.min(MAX_LIMIT)),
    }
}

/// `live` (default) | `trashed` | `all`.
pub fn parse_trash(raw: Option<&str>) -> AppResult<TrashFilter> {
    match raw.map(str::trim) {
        None | Some("") | Some("live") => Ok(TrashFilter::Live),
        Some("trashed") => Ok(TrashFilter::Trashed),
        Some("all") => Ok(TrashFilter::All),
        Some(other) => Err(AppError::bad_request(format!(
            "unknown trash filter `{other}`; expected live, trashed or all"
        ))),
    }
}

/// The API may only take `manual` snapshots.
pub fn snapshot_reason(raw: Option<&str>) -> AppResult<&'static str> {
    match raw.map(str::trim) {
        None | Some("") | Some(API_SNAPSHOT_REASON) => Ok(API_SNAPSHOT_REASON),
        Some(other) => Err(AppError::bad_request(format!(
            "unknown snapshot reason `{other}`; the API only takes `{API_SNAPSHOT_REASON}` snapshots"
        ))),
    }
}

/// Reject a document id the docstore would reject anyway, before touching Mongo.
pub(crate) fn check_id(id: &str) -> AppResult<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "invalid document id `{id}`: expected a ULID"
        )))
    }
}

/// Enforce the document text cap with a clear error (SPEC §3.5).
fn check_text_size(text: &str, limit: usize) -> AppResult<()> {
    if text.len() > limit {
        return Err(AppError::PayloadTooLarge {
            len: text.len() as u64,
            limit: limit as u64,
        });
    }
    Ok(())
}

/// Map storage failures onto the HTTP contract of SPEC §5.1. Infrastructure
/// failures stay wrapped so `error.rs` can keep them 500 and unlogged to clients.
pub(crate) fn map_docstore(err: DocStoreError) -> AppError {
    match err {
        DocStoreError::NotFound(_) => AppError::NotFound("document"),
        DocStoreError::AlreadyExists(id) => {
            AppError::Conflict(format!("document {id} already exists"))
        }
        DocStoreError::Graveyarded(id) => {
            AppError::Gone(format!("document {id} was permanently deleted"))
        }
        DocStoreError::TooLarge { len, limit } => AppError::PayloadTooLarge {
            len: len as u64,
            limit: limit as u64,
        },
        DocStoreError::InvalidId(id) => AppError::bad_request(format!("invalid document id: {id}")),
        DocStoreError::MalformedUpdate(reason) => {
            AppError::bad_request(format!("malformed CRDT update: {reason}"))
        }
        DocStoreError::Contended(_) => {
            AppError::Conflict("concurrent write lost the race; retry".to_string())
        }
        DocStoreError::SnapshotNotFound(_) => AppError::NotFound("snapshot"),
        DocStoreError::HistoryGap(..) => AppError::Conflict(
            "this document's history cannot be rebuilt at that point".to_string(),
        ),
        other => AppError::DocStore(other),
    }
}

/// Fetch the materialized document for a response. `stale_ok` skips the
/// read-your-writes flush.
async fn load_view(state: &AppState, id: &str, stale_ok: bool) -> AppResult<DocumentView> {
    let document = if stale_ok {
        state.docs.get_stale(id).await
    } else {
        state.docs.get(id).await
    }
    .map_err(map_docstore)?;
    Ok(DocumentView::from(document))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn list(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<ListParams>,
) -> AppResult<Json<ListResponse>> {
    let query = params.into_query()?;
    let page = state.docs.list(&query).await.map_err(map_docstore)?;

    // `metadata_only` is honoured by the Mongo projection inside
    // `DocStore::list` (`ListQuery::metadata_only`), so there is nothing to blank
    // here: a row arrives with `content` already absent. Blanking it in this loop
    // instead would mean reading every megabyte off the wire and throwing it away
    // — the list path is exactly where that is not affordable (SPEC §3.5).
    let documents = page.documents.into_iter().map(DocumentView::from).collect();

    Ok(Json(ListResponse {
        documents,
        next_cursor: page.next_cursor,
    }))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateRequest>,
) -> AppResult<Response> {
    if let Some(id) = body.id.as_deref() {
        check_id(id)?;
    }
    let outcome = match body.state.as_deref() {
        Some(encoded) => {
            let Some(id) = body.id.clone() else {
                return Err(AppError::BadRequest(
                    "`state` needs the `id` the device minted".to_string(),
                ));
            };
            if !body.content.is_empty() {
                return Err(AppError::BadRequest(
                    "send `content` or `state`, not both".to_string(),
                ));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| AppError::BadRequest("`state` is not base64".to_string()))?;
            state
                .docs
                .create_from_update(id, &bytes, &user.actor())
                .await
                .map_err(map_docstore)?
        }
        None => {
            check_text_size(&body.content, state.config().max_document_bytes)?;
            state
                .docs
                .create(body.id.clone(), &body.content, &user.actor())
                .await
                .map_err(map_docstore)?
        }
    };

    let view = load_view(&state, &outcome.id, false).await?;
    let location = format!("/api/documents/{}", view.id);
    Ok((
        StatusCode::CREATED,
        [(header::LOCATION, location)],
        Json(view),
    )
        .into_response())
}

pub async fn get_one(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
    Query(params): Query<GetParams>,
) -> AppResult<Response> {
    check_id(&id)?;

    match params.format.as_deref().map(str::trim) {
        None | Some("") | Some("json") => {
            let view = load_view(&state, &id, params.stale_ok).await?;
            Ok(Json(view).into_response())
        }
        Some("crdt") => {
            let state_bytes = state.docs.crdt_state(&id).await.map_err(map_docstore)?;
            let state_vector =
                base64::engine::general_purpose::STANDARD.encode(&state_bytes.state_vector);
            Ok((
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
                    (header::CACHE_CONTROL, "private, no-store".to_string()),
                ],
                // The state vector travels in a header so a client can ask for a
                // diff next time without decoding the whole state (M2 sync).
                [("x-state-vector", state_vector)],
                state_bytes.state,
            )
                .into_response())
        }
        Some(other) => Err(AppError::bad_request(format!(
            "unknown format `{other}`; expected json or crdt"
        ))),
    }
}

pub async fn replace(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<ReplaceRequest>,
) -> AppResult<Json<DocumentView>> {
    check_id(&id)?;
    check_text_size(&body.content, state.config().max_document_bytes)?;

    let outcome = state
        .docs
        .replace_text(&id, &body.content, &user.actor())
        .await
        .map_err(map_docstore)?;
    // A REST write is a CRDT write: every socket with this document open has to
    // receive the diff, or its `Y.Doc` diverges from the server's for the life of
    // the subscription (PROTOCOL.md §3.4).
    crate::routes::sync::publish_update(&state, &id, &outcome.update);

    Ok(Json(load_view(&state, &id, false).await?))
}

pub async fn patch(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<PatchRequest>,
) -> AppResult<Json<DocumentView>> {
    check_id(&id)?;
    body.validate()?;
    check_text_size(&body.content, state.config().max_document_bytes)?;

    // Content-only replace: the text *is* the document (SPEC §3.1), so `PATCH`
    // and `PUT` differ only in what the client is allowed to send.
    let outcome = state
        .docs
        .replace_text(&id, &body.content, &user.actor())
        .await
        .map_err(map_docstore)?;
    crate::routes::sync::publish_update(&state, &id, &outcome.update);

    Ok(Json(load_view(&state, &id, false).await?))
}

/// Tombstone (Trash). Audited (SPEC §5.4).
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    check_id(&id)?;

    // Read the title first so the audit entry says what was deleted; a stale
    // read is fine for a log line.
    let title = state.docs.get_stale(&id).await.map_err(map_docstore)?.title;

    state
        .docs
        .tombstone(&id, &user.actor())
        .await
        .map_err(map_docstore)?;

    state
        .audit(
            AuditEntry::new(
                "document.delete",
                Some(&user.actor()),
                "document",
                Some(id.clone()),
            )
            .with_detail(doc! { "title": title })
            .with_ip(user.session.ip.clone()),
        )
        .await;

    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Restore out of Trash. Audited.
pub async fn restore(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<DocumentView>> {
    check_id(&id)?;

    state
        .docs
        .untombstone(&id, &user.actor())
        .await
        .map_err(map_docstore)?;

    let view = load_view(&state, &id, false).await?;

    state
        .audit(
            AuditEntry::new(
                "document.restore",
                Some(&user.actor()),
                "document",
                Some(id.clone()),
            )
            .with_detail(doc! { "title": view.title.clone() })
            .with_ip(user.session.ip.clone()),
        )
        .await;

    Ok(Json(view))
}

/// A snapshot row on the wire. `created_at` is a [`Timestamp`] (RFC 3339), not a
/// `bson::DateTime`: the stored type serializes through `serde_json` as MongoDB
/// extended JSON (`{"$date": …}`), and no client should ever parse that
/// (PROTOCOL.md §2.1).
#[derive(Debug, Serialize, Deserialize)]
pub struct SnapshotView {
    pub id: Id,
    pub document_id: Id,
    pub title: String,
    pub reason: String,
    pub created_at: Timestamp,
    pub created_by: Option<String>,
    pub size: usize,
}

pub async fn list_snapshots(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<SnapshotView>>> {
    check_id(&id)?;

    let snapshots = state.docs.snapshots(&id).await.map_err(map_docstore)?;
    Ok(Json(
        snapshots
            .into_iter()
            .map(|snapshot| SnapshotView {
                id: snapshot.id,
                document_id: snapshot.document_id,
                title: snapshot.title,
                reason: snapshot.reason,
                created_at: snapshot.created_at.into(),
                created_by: snapshot.created_by,
                size: snapshot.content.len(),
            })
            .collect(),
    ))
}

/// A snapshot with the text it holds: what a read-only look at an earlier version needs.
#[derive(Debug, Serialize, Deserialize)]
pub struct SnapshotContentView {
    #[serde(flatten)]
    pub snapshot: SnapshotView,
    pub content: String,
}

pub async fn get_snapshot(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((id, snapshot_id)): Path<(String, String)>,
) -> AppResult<Json<SnapshotContentView>> {
    check_id(&id)?;
    if !is_valid_id(&snapshot_id) {
        return Err(AppError::bad_request(format!(
            "invalid snapshot id `{snapshot_id}`: expected a ULID"
        )));
    }
    let snapshot = state
        .docs
        .snapshot_by_id(&id, &snapshot_id)
        .await
        .map_err(map_docstore)?;
    Ok(Json(SnapshotContentView {
        snapshot: SnapshotView {
            id: snapshot.id,
            document_id: snapshot.document_id,
            title: snapshot.title,
            reason: snapshot.reason,
            created_at: snapshot.created_at.into(),
            created_by: snapshot.created_by,
            size: snapshot.content.len(),
        },
        content: snapshot.content,
    }))
}

pub async fn create_snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<CreateSnapshotRequest>,
) -> AppResult<Response> {
    check_id(&id)?;
    let reason = snapshot_reason(body.reason.as_deref())?;

    let snapshot_id = state
        .docs
        .snapshot(&id, reason, &user.actor())
        .await
        .map_err(map_docstore)?;

    Ok((
        StatusCode::CREATED,
        Json(SnapshotCreated {
            id: snapshot_id,
            document_id: id,
            reason: reason.to_string(),
        }),
    )
        .into_response())
}

/// Restore a snapshot: one CRDT transaction replacing the full text. Audited;
/// warns when other users are subscribed (M2).
pub async fn restore_snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, snapshot_id)): Path<(String, String)>,
) -> AppResult<Json<DocumentView>> {
    check_id(&id)?;
    if !is_valid_id(&snapshot_id) {
        return Err(AppError::bad_request(format!(
            "invalid snapshot id `{snapshot_id}`: expected a ULID"
        )));
    }

    // Who is watching, read *before* the write: a restore rewrites the whole text
    // under any open editor (SPEC §3.5 asks for the warning).
    let subscribers = crate::routes::sync::document_subscribers(&state, &id);

    let outcome = state
        .docs
        .restore_snapshot(&id, &snapshot_id, &user.actor())
        .await
        .map_err(map_docstore)?;
    // Without this, a restore is invisible to every open editor: the projection row
    // updates (so the doc list shows the restored text) while the editor keeps the
    // pre-restore text and merges the user's next keystroke into it.
    crate::routes::sync::publish_update(&state, &id, &outcome.update);
    if subscribers > 0 {
        tracing::warn!(
            document = %id,
            subscribers,
            "snapshot restored while the document had live subscribers"
        );
    }

    let view = load_view(&state, &id, false).await?;

    state
        .audit(
            AuditEntry::new(
                "snapshot.restore",
                Some(&user.actor()),
                "document",
                Some(id.clone()),
            )
            .with_detail(doc! { "snapshot_id": snapshot_id, "title": view.title.clone() })
            .with_ip(user.session.ip.clone()),
        )
        .await;

    Ok(Json(view))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sortable_single_segment_fields() {
        assert!(sort_field_allowed("title"));
        assert!(sort_field_allowed("updated_at"));
        assert!(sort_field_allowed("created_at"));
        assert!(sort_field_allowed("id"));
        // Trash orders by deletion time (SPEC §6.5).
        assert!(sort_field_allowed("deleted_at"));
        // Not sortable: huge text, unknown roots, empty.
        assert!(!sort_field_allowed("content"));
        assert!(!sort_field_allowed("crdt"));
        assert!(!sort_field_allowed("password_hash"));
        assert!(!sort_field_allowed("materialized_version"));
        assert!(!sort_field_allowed(""));
    }

    /// The whitelist and the core's field space have to agree, or a field that
    /// passes [`sort_field_allowed`] 400s one line later in `SortKey::parse` —
    /// which is exactly how `deleted_at` used to be advertised-and-refused.
    #[test]
    fn every_advertised_sort_field_survives_the_core() {
        for field in SORTABLE_FIELDS {
            let key = SortKey::parse(field).unwrap_or_else(|err| {
                panic!("`{field}` is advertised but the core refuses it: {err}")
            });
            filter_mongo::compile_sort(std::slice::from_ref(&key)).unwrap_or_else(|err| {
                panic!("`{field}` is advertised but does not compile to a Mongo sort: {err}")
            });
        }
        // And the other direction, for the two the core accepts but sorting must not:
        // `content` is megabytes of text and `deleted` is a derived boolean whose stored
        // column is a timestamp.
        for field in ["content", "deleted"] {
            let key = SortKey::parse(field).expect("the core addresses it");
            assert!(
                filter_mongo::compile_sort(std::slice::from_ref(&key)).is_err(),
                "`{field}` must not be a sort key"
            );
        }
    }

    #[test]
    fn sortable_fm_and_plugin_paths() {
        assert!(sort_field_allowed("fm.due"));
        assert!(sort_field_allowed("fm.meta.rank"));
        assert!(sort_field_allowed("plugins.calendar.start"));
        // Depth cap and empty segments.
        assert!(!sort_field_allowed("fm.a.b.c.d"));
        assert!(!sort_field_allowed("fm."));
        assert!(!sort_field_allowed("fm..due"));
        assert!(!sort_field_allowed(".fm.due"));
        // A nested path under a non-nestable root stays rejected.
        assert!(!sort_field_allowed("title.length"));
        assert!(!sort_field_allowed("content.0"));
    }

    #[test]
    fn sort_token_field_names() {
        assert_eq!(sort_field_name("title"), "title");
        assert_eq!(sort_field_name("-title"), "title");
        assert_eq!(sort_field_name("title:desc"), "title");
        assert_eq!(sort_field_name("-fm.due:asc"), "fm.due");
        assert_eq!(sort_field_name("  updated_at  "), "updated_at");
    }

    /// Rejection happens before any [`SortKey::parse`] call, so this covers the
    /// whitelist and the key cap without depending on the shared core landing.
    /// The accepting path is exercised by the router integration tests.
    #[test]
    fn sort_spec_rejects_unlisted_fields_and_too_many_keys() {
        for spec in [
            "content",
            "crdt",
            "-content:desc",
            "fm",
            "title,content",
            "title,updated_at,fm.due,fm.other",
        ] {
            let err = parse_sort_spec(spec).unwrap_err();
            assert!(matches!(err, AppError::BadRequest(_)), "{spec} -> {err:?}");
        }
    }

    #[test]
    fn limit_clamping() {
        assert_eq!(clamp_limit(None).unwrap(), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(10)).unwrap(), 10);
        assert_eq!(clamp_limit(Some(10_000)).unwrap(), MAX_LIMIT);
        assert!(clamp_limit(Some(0)).is_err());
    }

    #[test]
    fn trash_filter_parsing() {
        assert_eq!(parse_trash(None).unwrap(), TrashFilter::Live);
        assert_eq!(parse_trash(Some("")).unwrap(), TrashFilter::Live);
        assert_eq!(parse_trash(Some("live")).unwrap(), TrashFilter::Live);
        assert_eq!(parse_trash(Some("trashed")).unwrap(), TrashFilter::Trashed);
        assert_eq!(parse_trash(Some("all")).unwrap(), TrashFilter::All);
        assert!(parse_trash(Some("deleted")).is_err());
    }

    #[test]
    fn snapshot_reason_is_a_closed_vocabulary() {
        assert_eq!(snapshot_reason(None).unwrap(), "manual");
        assert_eq!(snapshot_reason(Some("manual")).unwrap(), "manual");
        assert!(snapshot_reason(Some("daily")).is_err());
        assert!(snapshot_reason(Some("pre_restore")).is_err());
    }

    #[test]
    fn patch_rejects_frontmatter_and_plugin_fields() {
        let ok: PatchRequest = serde_json::from_str(r##"{"content":"# hi"}"##).unwrap();
        ok.validate().unwrap();

        for body in [
            r##"{"content":"# hi","fm":{"title":"x"}}"##,
            r##"{"content":"# hi","plugins":{"calendar":{}}}"##,
            r##"{"content":"# hi","title":"x"}"##,
        ] {
            let patch: PatchRequest = serde_json::from_str(body).unwrap();
            let err = patch.validate().unwrap_err();
            assert!(matches!(err, AppError::BadRequest(_)), "{body} -> {err:?}");
        }
    }

    #[test]
    fn text_size_cap() {
        assert!(check_text_size("abc", 3).is_ok());
        let err = check_text_size("abcd", 3).unwrap_err();
        assert!(
            matches!(err, AppError::PayloadTooLarge { len: 4, limit: 3 }),
            "{err:?}"
        );
    }

    #[test]
    fn docstore_errors_map_to_the_spec_statuses() {
        use axum::http::StatusCode;

        let cases = [
            (DocStoreError::NotFound("x".into()), StatusCode::NOT_FOUND),
            (
                DocStoreError::AlreadyExists("x".into()),
                StatusCode::CONFLICT,
            ),
            (DocStoreError::Graveyarded("x".into()), StatusCode::GONE),
            (
                DocStoreError::TooLarge { len: 2, limit: 1 },
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            (
                DocStoreError::InvalidId("x".into()),
                StatusCode::BAD_REQUEST,
            ),
            (DocStoreError::Contended("x".into()), StatusCode::CONFLICT),
            (
                DocStoreError::SnapshotNotFound("x".into()),
                StatusCode::NOT_FOUND,
            ),
        ];

        for (err, expected) in cases {
            let mapped = map_docstore(err);
            // `AppError::status()` is owned by ops; assert on the variant we
            // chose so this test does not depend on their mapping landing.
            let got = match &mapped {
                AppError::NotFound(_) => StatusCode::NOT_FOUND,
                AppError::Conflict(_) => StatusCode::CONFLICT,
                AppError::Gone(_) => StatusCode::GONE,
                AppError::PayloadTooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
                AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
                other => panic!("unexpected mapping: {other:?}"),
            };
            assert_eq!(got, expected);
        }
    }

    #[test]
    fn invalid_ids_are_rejected_before_mongo() {
        assert!(check_id("not-a-ulid").is_err());
        assert!(check_id("").is_err());
        assert!(check_id(&crate::domain::new_id()).is_ok());
    }
}
