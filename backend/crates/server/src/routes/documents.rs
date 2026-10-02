use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use bson::doc;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use ddd_core::filter::ast::{Filter, SortKey};
use ddd_core::query::{Hit, Plan, Sort, Trash};
use serde::{Deserialize, Serialize};

use crate::auth::{AdminUser, AuthUser};
use crate::docstore::{DocStoreError, TrashFilter};
use crate::domain::{AuditEntry, DocumentView, Id, Timestamp, is_valid_id};
use crate::error::{AppError, AppResult};
use crate::query_index::QueryIndexError;
use crate::state::AppState;

pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 500;

pub const SORTABLE_FIELDS: &[&str] = &["id", "title", "created_at", "updated_at", "deleted_at"];

pub const SORTABLE_PREFIXES: &[&str] = &["fm", "plugins"];

pub const MAX_SORT_KEYS: usize = 3;

pub const MAX_SORT_DEPTH: usize = 4;

pub const MAX_SEARCH_LEN: usize = 256;

pub const API_SNAPSHOT_REASON: &str = "manual";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/duplicates", get(duplicates))
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
        .route(
            "/{id}/changes/{from}/{to}/revert",
            post(super::changes::revert_change),
        )
        .route(
            "/{id}/snapshots/{snapshot_id}/restore",
            post(restore_snapshot),
        )
}

#[derive(Debug, Default, Deserialize)]
pub struct ListParams {
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub trash: Option<String>,
    #[serde(default)]
    pub metadata_only: bool,
}

impl ListParams {
    pub fn into_plan(self) -> AppResult<(Plan, bool)> {
        let filter = match self.filter.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(
                Filter::from_json_str(raw)
                    .map_err(|err| AppError::bad_request(format!("invalid filter: {err}")))?,
            ),
        };

        let sort = match self.sort.as_deref().map(str::trim) {
            None | Some("") => Vec::new(),
            Some(raw) => parse_sort_spec(raw)?.into_iter().map(Sort::Field).collect(),
        };

        let text = match self.search.as_deref().map(str::trim) {
            None | Some("") => String::new(),
            Some(terms) if terms.len() > MAX_SEARCH_LEN => {
                return Err(AppError::bad_request(format!(
                    "search is limited to {MAX_SEARCH_LEN} characters"
                )));
            }
            Some(terms) => terms.to_string(),
        };

        let cursor = match self.cursor.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(cursor) => Some(cursor.to_string()),
        };

        let plan = Plan {
            text,
            filter,
            sort,
            trash: match parse_trash(self.trash.as_deref())? {
                TrashFilter::Live => Trash::Live,
                TrashFilter::Trashed => Trash::Trashed,
                TrashFilter::All => Trash::All,
            },
            limit: Some(clamp_limit(self.limit)?),
            cursor,
            snippets: false,
            offset: None,
        };
        plan.validate()
            .map_err(|err| AppError::bad_request(err.to_string()))?;
        Ok((plan, self.metadata_only))
    }
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub documents: Vec<DocumentView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub total: usize,
}

#[derive(Debug, Default, Deserialize)]
pub struct QueryParams {
    #[serde(default)]
    pub metadata_only: bool,
}

#[derive(Debug, Serialize)]
pub struct QueryResponse {
    pub documents: Vec<DocumentView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub total: usize,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub hits: HashMap<String, Hit>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    #[serde(default)]
    pub id: Option<Id>,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReplaceRequest {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct PatchRequest {
    pub content: String,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

impl PatchRequest {
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

#[derive(Debug, Default, Deserialize)]
pub struct GetParams {
    #[serde(default)]
    pub format: Option<String>,
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

pub fn sort_field_name(token: &str) -> &str {
    let token = token.trim();
    let token = token.strip_prefix('-').unwrap_or(token);
    match token.split_once(':') {
        Some((field, _)) => field.trim(),
        None => token,
    }
}

pub fn parse_sort_spec(spec: &str) -> AppResult<Vec<SortKey>> {
    let tokens: Vec<&str> = spec
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect();

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

pub fn clamp_limit(limit: Option<u32>) -> AppResult<u32> {
    match limit {
        None => Ok(DEFAULT_LIMIT),
        Some(0) => Err(AppError::bad_request("limit must be at least 1")),
        Some(value) => Ok(value.min(MAX_LIMIT)),
    }
}

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

pub fn snapshot_reason(raw: Option<&str>) -> AppResult<&'static str> {
    match raw.map(str::trim) {
        None | Some("") | Some(API_SNAPSHOT_REASON) => Ok(API_SNAPSHOT_REASON),
        Some(other) => Err(AppError::bad_request(format!(
            "unknown snapshot reason `{other}`; the API only takes `{API_SNAPSHOT_REASON}` snapshots"
        ))),
    }
}

pub(crate) fn check_id(id: &str) -> AppResult<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "invalid document id `{id}`: expected a ULID"
        )))
    }
}

fn check_text_size(text: &str, limit: usize) -> AppResult<()> {
    if text.len() > limit {
        return Err(AppError::PayloadTooLarge {
            len: text.len() as u64,
            limit: limit as u64,
        });
    }
    Ok(())
}

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

async fn load_view(state: &AppState, id: &str, stale_ok: bool) -> AppResult<DocumentView> {
    let document = if stale_ok {
        state.docs.get_stale(id).await
    } else {
        state.docs.get(id).await
    }
    .map_err(map_docstore)?;
    Ok(DocumentView::from(document))
}

pub async fn list(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<ListParams>,
) -> AppResult<Json<ListResponse>> {
    let (plan, metadata_only) = params.into_plan()?;
    let found = state
        .query
        .rows(&plan, !metadata_only)
        .await
        .map_err(map_query)?;
    Ok(Json(ListResponse {
        documents: found.rows.into_iter().map(DocumentView::from).collect(),
        next_cursor: found.page.next_cursor,
        total: found.page.total,
    }))
}

pub async fn query(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<QueryParams>,
    Json(plan): Json<serde_json::Value>,
) -> AppResult<Json<QueryResponse>> {
    let mut plan = Plan::from_json(&plan).map_err(|err| AppError::bad_request(err.to_string()))?;
    plan.limit = Some(plan.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT));
    let found = state
        .query
        .rows(&plan, !params.metadata_only)
        .await
        .map_err(map_query)?;
    Ok(Json(QueryResponse {
        documents: found.rows.into_iter().map(DocumentView::from).collect(),
        next_cursor: found.page.next_cursor,
        total: found.page.total,
        hits: found.page.hits,
    }))
}

pub(crate) fn map_query(err: QueryIndexError) -> AppError {
    match err {
        QueryIndexError::Query(err) => AppError::bad_request(err.to_string()),
        QueryIndexError::Db(err) => AppError::Db(err),
        QueryIndexError::Feed(err) => AppError::Internal(err.into()),
    }
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

    let outcome = state
        .docs
        .replace_text(&id, &body.content, &user.actor())
        .await
        .map_err(map_docstore)?;
    crate::routes::sync::publish_update(&state, &id, &outcome.update);

    Ok(Json(load_view(&state, &id, false).await?))
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    check_id(&id)?;

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

    let subscribers = crate::routes::sync::document_subscribers(&state, &id);

    let outcome = state
        .docs
        .restore_snapshot(&id, &snapshot_id, &user.actor())
        .await
        .map_err(map_docstore)?;
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

#[derive(Debug, Serialize)]
pub struct DuplicateDocumentGroup {
    pub title: String,
    pub size: u64,
    pub documents: Vec<DuplicateDocument>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DuplicateDocument {
    pub id: Id,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub references: u32,
    pub referenced_by: Vec<NoteRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NoteRef {
    pub id: Id,
    pub title: String,
    pub trashed: bool,
}

pub const MAX_REFERENCED_BY: usize = 10;

#[derive(Debug, Clone)]
pub struct DocumentCopy {
    pub id: Id,
    pub title: String,
    pub content: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

pub async fn duplicates(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<Vec<DuplicateDocumentGroup>>> {
    let mut live = Vec::new();
    let mut texts: Vec<(NoteRef, String)> = Vec::new();
    let mut rows = state
        .collections
        .raw(crate::db::DOCUMENTS)
        .find(doc! {})
        .projection(
            doc! { "title": 1, "content": 1, "created_at": 1, "updated_at": 1, "deleted_at": 1 },
        )
        .await?;
    while let Some(row) = futures::TryStreamExt::try_next(&mut rows).await? {
        let (Ok(id), Ok(content)) = (row.get_str("_id"), row.get_str("content")) else {
            continue;
        };
        let trashed = matches!(row.get("deleted_at"), Some(value) if *value != bson::Bson::Null);
        let title = row.get_str("title").unwrap_or_default().to_string();
        if !trashed {
            live.push(DocumentCopy {
                id: id.to_string(),
                title: title.clone(),
                content: content.to_string(),
                created_at: row
                    .get_datetime("created_at")
                    .map(|at| (*at).into())
                    .unwrap_or_else(|_| Timestamp::from_millis(0)),
                updated_at: row
                    .get_datetime("updated_at")
                    .map(|at| (*at).into())
                    .unwrap_or_else(|_| Timestamp::from_millis(0)),
            });
        }
        texts.push((
            NoteRef {
                id: id.to_string(),
                title,
                trashed,
            },
            content.to_string(),
        ));
    }

    let groups = group_duplicate_documents(live);
    if groups.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let candidates: BTreeSet<&str> = groups
        .iter()
        .flatten()
        .map(|copy| copy.id.as_str())
        .collect();
    let mut references: BTreeMap<&str, Vec<&NoteRef>> = BTreeMap::new();
    for (from, text) in &texts {
        let linked: BTreeSet<&str> = doc_refs(text)
            .into_iter()
            .filter(|id| *id != from.id)
            .collect();
        for id in linked {
            if let Some(candidate) = candidates.get(id) {
                references.entry(candidate).or_default().push(from);
            }
        }
    }

    Ok(Json(
        groups
            .iter()
            .map(|copies| DuplicateDocumentGroup {
                title: copies[0].title.clone(),
                size: copies[0].content.len() as u64,
                documents: copies
                    .iter()
                    .map(|copy| {
                        let using = references
                            .get(copy.id.as_str())
                            .map(Vec::as_slice)
                            .unwrap_or_default();
                        DuplicateDocument {
                            id: copy.id.clone(),
                            created_at: copy.created_at,
                            updated_at: copy.updated_at,
                            references: using.len() as u32,
                            referenced_by: using
                                .iter()
                                .take(MAX_REFERENCED_BY)
                                .map(|note| (*note).clone())
                                .collect(),
                        }
                    })
                    .collect(),
            })
            .collect(),
    ))
}

pub fn group_duplicate_documents(copies: Vec<DocumentCopy>) -> Vec<Vec<DocumentCopy>> {
    let mut groups: BTreeMap<(String, String), Vec<DocumentCopy>> = BTreeMap::new();
    for copy in copies {
        groups
            .entry((copy.title.clone(), copy.content.clone()))
            .or_default()
            .push(copy);
    }
    groups
        .into_values()
        .filter(|copies| copies.len() > 1)
        .map(|mut copies| {
            copies.sort_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.id.cmp(&b.id))
            });
            copies
        })
        .collect()
}

pub fn doc_refs(text: &str) -> Vec<&str> {
    const SCHEME: &str = "doc://";
    let mut found = Vec::new();
    for (index, _) in text.match_indices(SCHEME) {
        let rest = &text[index + SCHEME.len()..];
        let len = rest
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
            .count();
        if len > 0 {
            found.push(&rest[..len]);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy(id: &str, title: &str, content: &str, created: i64) -> DocumentCopy {
        DocumentCopy {
            id: id.to_string(),
            title: title.to_string(),
            content: content.to_string(),
            created_at: Timestamp::from_millis(created),
            updated_at: Timestamp::from_millis(created),
        }
    }

    #[test]
    fn duplicate_documents_need_the_same_title_and_text() {
        let groups = group_duplicate_documents(vec![
            copy("b", "Plan", "# Plan\nsteps", 2),
            copy("a", "Plan", "# Plan\nsteps", 1),
            copy("c", "Plan", "# Plan\nother steps", 3),
            copy("d", "Other", "# Plan\nsteps", 4),
            copy("e", "Alone", "x", 5),
        ]);
        assert_eq!(groups.len(), 1);
        let ids: Vec<&str> = groups[0].iter().map(|copy| copy.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"], "oldest first");
    }

    #[test]
    fn doc_refs_finds_every_link() {
        assert_eq!(
            doc_refs("see [a](doc://01ABC) and doc://x_y-z. not doc:// alone"),
            ["01ABC", "x_y-z"]
        );
    }

    #[test]
    fn sortable_single_segment_fields() {
        assert!(sort_field_allowed("title"));
        assert!(sort_field_allowed("updated_at"));
        assert!(sort_field_allowed("created_at"));
        assert!(sort_field_allowed("id"));
        assert!(sort_field_allowed("deleted_at"));
        assert!(!sort_field_allowed("content"));
        assert!(!sort_field_allowed("crdt"));
        assert!(!sort_field_allowed("password_hash"));
        assert!(!sort_field_allowed("materialized_version"));
        assert!(!sort_field_allowed(""));
    }

    #[test]
    fn every_advertised_sort_field_survives_the_core() {
        for field in SORTABLE_FIELDS {
            SortKey::parse(field).unwrap_or_else(|err| {
                panic!("`{field}` is advertised but the core refuses it: {err}")
            });
        }
    }

    #[test]
    fn sortable_fm_and_plugin_paths() {
        assert!(sort_field_allowed("fm.due"));
        assert!(sort_field_allowed("fm.meta.rank"));
        assert!(sort_field_allowed("plugins.calendar.start"));
        assert!(!sort_field_allowed("fm.a.b.c.d"));
        assert!(!sort_field_allowed("fm."));
        assert!(!sort_field_allowed("fm..due"));
        assert!(!sort_field_allowed(".fm.due"));
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
